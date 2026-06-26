import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Peer = { id: string; name: string; host: string; port: number; lastSeen: number; online?: boolean };
type Msg = { id: string; peerId: string; direction: 'in' | 'out'; kind: 'text' | 'file'; text?: string; fileName?: string; filePath?: string; size?: number; ts: number };
type Prefs = { enabled?: boolean; displayName?: string; retainEnabled?: boolean; retainDays?: number; downloadDir?: string; hidePresence?: boolean; popupNotify?: boolean; popupStyle?: 'toast' | 'center'; popupHoldSec?: number };
type State = { self?: { id: string; name: string; port: number; hidden?: boolean }; peers: Peer[]; messages: Msg[]; prefs: Prefs };
type RemoteEntry = { name: string; isDir: boolean; size?: number; mtime?: number };
type ConnectedSession = { panelId: string; sessionId?: string; sessionName?: string; host?: string; port?: number };

const emptyState: State = { peers: [], messages: [], prefs: {} };

function fmtTime(ts: number) {
  try { return new Date(ts).toLocaleString(); } catch { return ''; }
}

function buildJumpChain(sess: any): { host: string; user?: string; port?: number; password?: string }[] {
  const arr = Array.isArray(sess?.jumps) ? sess.jumps : [];
  const out: { host: string; user?: string; port?: number; password?: string }[] = [];
  for (const j of arr) {
    const host = (j && typeof j.host === 'string') ? j.host.trim() : '';
    if (!host) break;
    out.push({ host, user: j.user || 'root', port: Number(j.port) || 22, password: j.password || undefined });
  }
  return out;
}

function joinRemotePath(base: string, name: string) {
  const root = (base || '/').replace(/\/+$/, '') || '/';
  return root === '/' ? `/${name}` : `${root}/${name}`;
}

function sessionFolderPath(folders: any[], fid?: string): string {
  if (!fid) return '';
  const f = folders.find((x: any) => x.id === fid);
  if (!f) return '';
  const parent = sessionFolderPath(folders, f.parentId);
  return parent ? `${parent}/${f.name}` : f.name;
}

function parentRemotePath(cur: string) {
  const p = (cur || '/').replace(/\/+$/, '') || '/';
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

function canRevealFile(msg: Msg) {
  const p = msg.filePath || '';
  return msg.direction === 'in' || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

function scanLabel(payload: any, t: (k: string, o?: any) => string) {
  const ranges = Array.isArray(payload?.prefixes) ? payload.prefixes.map((v: string) => `${v}.x.x`) : [];
  const directCount = Array.isArray(payload?.directHosts) ? payload.directHosts.length : 0;
  if (directCount > 0) ranges.push(t('scanLabelOverlay', { count: directCount }));
  return ranges.length ? ranges.join(', ') : t('scanLabelFallback');
}

export const MessengerWorkspace: React.FC<{
  connectedSessions?: ConnectedSession[];
  visible?: boolean;
  initialState?: { selectedPeerId?: string; text?: string; settingsExpanded?: boolean } | null;
  onStateChange?: (state: { selectedPeerId: string; text: string; settingsExpanded: boolean }) => void;
}> = ({ connectedSessions = [], visible = true, initialState, onStateChange }) => {
  const { t } = useTranslation('messenger');
  const [state, setState] = useState<State>(emptyState);
  const [selectedPeerId, setSelectedPeerId] = useState(() => {
    if (initialState?.selectedPeerId) return initialState.selectedPeerId;
    try { return localStorage.getItem('messenger:lastSelectedPeerId') || ''; } catch { return ''; }
  });
  const [text, setText] = useState(initialState?.text || '');
  const [saving, setSaving] = useState(false);
  const [scanText, setScanText] = useState('');
  const [settingsExpanded, setSettingsExpanded] = useState(initialState?.settingsExpanded ?? false);
  // 부모에게 상태 보고 — 분리 시 직렬화.
  useEffect(() => {
    if (!onStateChange) return;
    try { onStateChange({ selectedPeerId, text, settingsExpanded }); } catch {}
  }, [selectedPeerId, text, settingsExpanded, onStateChange]);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const msgListRef = useRef<HTMLElement | null>(null);
  const scrollMsgsToBottom = (delay = 0) => {
    const run = () => { const el = msgListRef.current; if (el) el.scrollTop = el.scrollHeight; };
    if (delay > 0) setTimeout(run, delay);
    else requestAnimationFrame(run);
  };
  const [readMarks, setReadMarks] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('messenger:readMarks') || '{}') || {}; } catch { return {}; }
  });
  const [menu, setMenu] = useState<{ x: number; y: number; peerId: string } | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteSessions, setRemoteSessions] = useState<any[]>([]);
  const [remoteFolders, setRemoteFolders] = useState<any[]>([]);
  const [remoteSessionId, setRemoteSessionId] = useState('');
  const [remoteConnId, setRemoteConnId] = useState('');
  const [remoteConnecting, setRemoteConnecting] = useState(false);
  // SFTP connections this picker opened itself (vs. reused live terminal conns),
  // so we only disconnect what we created.
  const remoteTempConns = useRef<Set<string>>(new Set());
  const [remotePath, setRemotePath] = useState('/');
  const [remoteFiles, setRemoteFiles] = useState<RemoteEntry[]>([]);
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(new Set());
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState('');
  const [narrowLayout, setNarrowLayout] = useState(false);
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = workspaceRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect?.width || 0;
      setNarrowLayout(width < 560);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    (async () => {
      const res = await (window as any).api?.messengerGetState?.().catch(() => null);
      if (!disposed && res?.peers) {
        setState(res);
        setSelectedPeerId((cur) => cur || res.peers?.[0]?.id || '');
      }
    })();
    const off = (window as any).api?.onMessengerEvent?.((p: any) => {
      if (p?.state) {
        setState(p.state);
        setSelectedPeerId((cur) => cur || p.state.peers?.[0]?.id || '');
      }
      if (p?.type === 'scan-progress') {
        setScanText(t('scanProgress', { label: scanLabel(p, t), sent: p.sent, total: p.total }));
      } else if (p?.type === 'scan-complete') {
        setScanText(t('scanComplete', { label: scanLabel(p, t), count: p.sent }));
        setTimeout(() => setScanText(''), 5000);
      }
    });
    return () => {
      disposed = true;
      if (off) off();
    };
  }, []);

  useEffect(() => {
    try {
      if (selectedPeerId) localStorage.setItem('messenger:lastSelectedPeerId', selectedPeerId);
      else localStorage.removeItem('messenger:lastSelectedPeerId');
    } catch {}
  }, [selectedPeerId]);

  useEffect(() => {
    if (!state.peers.length) return;
    const stillExists = selectedPeerId && state.peers.some(p => p.id === selectedPeerId);
    if (stillExists) return;
    const fallback = state.peers.find(p => p.id === selectedPeerId)?.id || state.peers[0]?.id || '';
    if (fallback && fallback !== selectedPeerId) setSelectedPeerId(fallback);
  }, [state.peers, selectedPeerId]);

  const selectedPeer = state.peers.find(p => p.id === selectedPeerId);
  const messages = useMemo(() => state.messages.filter(m => m.peerId === selectedPeerId).sort((a, b) => a.ts - b.ts), [state.messages, selectedPeerId]);
  // 새 메시지/대화 전환 시 항상 맨 아래로.
  useEffect(() => {
    scrollMsgsToBottom();
    scrollMsgsToBottom(60);
  }, [messages.length, selectedPeerId]);
  // 패널이 숨김→표시로 전환될 때(unpinned) — 숨김 동안 scrollHeight 가 0 이라 위로 올라가 있으므로 맨 아래로.
  useEffect(() => {
    if (!visible) return;
    scrollMsgsToBottom();
    scrollMsgsToBottom(60);
    scrollMsgsToBottom(160);
  }, [visible]);
  const storedName = state.prefs.displayName ?? '';
  const fallbackName = state.self?.name || '';

  const markRead = (peerId: string, upToTs: number) => {
    if (!peerId) return;
    setReadMarks(cur => {
      if ((cur[peerId] || 0) >= upToTs) return cur;
      const next = { ...cur, [peerId]: upToTs };
      try { localStorage.setItem('messenger:readMarks', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // Viewing a peer's conversation marks all of its incoming messages as read,
  // including any that arrive while it stays selected.
  useEffect(() => {
    if (!selectedPeerId) return;
    let latest = 0;
    for (const m of state.messages) {
      if (m.peerId === selectedPeerId && m.direction === 'in' && m.ts > latest) latest = m.ts;
    }
    if (latest > 0) markRead(selectedPeerId, latest);
  }, [selectedPeerId, state.messages]);

  // Seed the name input from prefs when it changes, but only if the user is not
  // actively focusing/editing it. Uncontrolled input(=DOM이 입력을 소유)이라
  // React 가 입력 중 re-render 하지 않아 한글 IME 조합이 깨지지 않는다.
  useEffect(() => {
    if (nameInputRef.current && document.activeElement !== nameInputRef.current) {
      nameInputRef.current.value = storedName;
    }
  }, [storedName]);

  const retainEnabled = !!state.prefs.retainEnabled;
  const retainDays = Number(state.prefs.retainDays) || 30;
  const hidePresence = !!state.prefs.hidePresence;
  const popupNotify = state.prefs.popupNotify !== false;
  const popupStyle: 'toast' | 'center' = ((state.prefs.popupStyle as string) === 'center' || (state.prefs.popupStyle as string) === 'edge') ? 'center' : 'toast';
  const popupHoldSec = Number.isFinite(Number(state.prefs.popupHoldSec)) ? Math.max(0, Number(state.prefs.popupHoldSec)) : 5;
  const selectedOnline = !!selectedPeer?.online;
  const canSend = !!selectedPeerId && selectedOnline && !hidePresence;

  const updatePrefs = async (patch: Prefs) => {
    setSaving(true);
    try {
      const next = { ...(state.prefs || {}), ...patch };
      const res = await (window as any).api?.messengerUpdatePrefs?.(next);
      if (res?.state) setState(res.state);
    } finally {
      setSaving(false);
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body || !canSend) return;
    setText('');
    const res = await (window as any).api?.messengerSendMessage?.(selectedPeerId, body);
    if (!res?.success) setText(body);
  };

  const sendFiles = async () => {
    if (!canSend) return;
    await (window as any).api?.messengerSendFiles?.(selectedPeerId);
  };

  // sessionId 기준 연결 상태 맵 + 이미 살아있는 터미널 연결의 termId(재사용용)
  const connectedSessionMap = useMemo(() => {
    const m = new Map<string, ConnectedSession>();
    for (const c of connectedSessions) {
      if (c.sessionId) m.set(c.sessionId, c);
    }
    return m;
  }, [connectedSessions]);

  // picker 열릴 때 전체 세션/폴더 로드
  useEffect(() => {
    if (!remoteOpen) return;
    (async () => {
      const data = await (window as any).api?.listSessions?.().catch(() => null);
      setRemoteSessions(Array.isArray(data?.sessions) ? data.sessions : []);
      setRemoteFolders(Array.isArray(data?.folders) ? data.folders : []);
    })();
  }, [remoteOpen]);

  const loadRemoteDir = async (connId: string, dir: string) => {
    if (!connId) return;
    setRemoteLoading(true);
    setRemoteError('');
    try {
      const res = await (window as any).api?.feListDir?.('remote', dir, connId);
      const files = Array.isArray(res?.files) ? res.files : [];
      setRemoteFiles(files.sort((a: RemoteEntry, b: RemoteEntry) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)));
      setRemotePath(dir);
      setRemoteSelected(new Set());
    } catch (err: any) {
      setRemoteFiles([]);
      setRemoteError(String(err?.message || err));
    } finally {
      setRemoteLoading(false);
    }
  };

  const disconnectTempConns = () => {
    for (const cid of remoteTempConns.current) {
      try { (window as any).api?.feSftpDisconnect?.(cid); } catch {}
    }
    remoteTempConns.current.clear();
  };

  const closeRemotePicker = () => {
    disconnectTempConns();
    setRemoteOpen(false);
    setRemoteSessionId('');
    setRemoteConnId('');
    setRemoteConnecting(false);
    setRemoteFiles([]);
    setRemoteSelected(new Set());
    setRemoteError('');
  };

  // 세션 선택 → 자동으로 연결 보장 후 홈 디렉터리 로드.
  // 이미 터미널로 연결된 세션이면 그 connId 를 재사용(추가 연결 없음), 아니면 백그라운드 SFTP 연결.
  const selectRemoteSession = async (sessionId: string) => {
    setRemoteSessionId(sessionId);
    setRemoteConnId('');
    setRemoteFiles([]);
    setRemoteSelected(new Set());
    setRemoteError('');
    if (!sessionId) return;
    const sess = remoteSessions.find(s => s.id === sessionId);
    if (!sess) { setRemoteError(t('sessionNotFound')); return; }

    setRemoteConnecting(true);
    try {
      // 1) 이미 살아있는 터미널 연결 재사용
      const live = connectedSessionMap.get(sessionId);
      if (live?.panelId) {
        setRemoteConnId(live.panelId);
        const home = await (window as any).api?.feHomeDir?.('remote', live.panelId).catch(() => '/');
        await loadRemoteDir(live.panelId, home || '/');
        return;
      }
      // 2) 백그라운드 SFTP 연결
      const auth = sess.auth;
      const hasCredential = auth?.type === 'key' || (auth?.type === 'password' && auth?.password);
      if (!sess.username || !hasCredential) {
        setRemoteError(t('noCredentials'));
        return;
      }
      const connId = `msg-sftp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const jumps = buildJumpChain(sess);
      const res = await (window as any).api?.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, auth, undefined, jumps.length ? jumps : undefined);
      if (!res?.success) {
        setRemoteError(t('connectFail', { error: res?.error || 'unknown' }));
        return;
      }
      remoteTempConns.current.add(connId);
      setRemoteConnId(connId);
      const home = await (window as any).api?.feHomeDir?.('remote', connId).catch(() => '/');
      await loadRemoteDir(connId, home || '/');
    } catch (err: any) {
      setRemoteError(String(err?.message || err));
    } finally {
      setRemoteConnecting(false);
    }
  };

  const sendRemoteFiles = async () => {
    if (!canSend || !remoteConnId || remoteSelected.size === 0) return;
    setRemoteLoading(true);
    setRemoteError('');
    try {
      const res = await (window as any).api?.messengerSendRemoteFiles?.(selectedPeerId, remoteConnId, [...remoteSelected]);
      if (!res?.success) {
        setRemoteError(t('sendFail', { error: res?.error || 'unknown' }));
        return;
      }
      closeRemotePicker();
    } finally {
      setRemoteLoading(false);
    }
  };

  const deleteConversation = async (peerId: string) => {
    await (window as any).api?.messengerDeleteConversation?.(peerId);
    setMenu(null);
  };

  const deletePeer = async (peerId: string) => {
    const peer = state.peers.find(p => p.id === peerId);
    if (!confirm(t('deletePeerConfirm', { name: peer?.name || t('selectedUserFallback') }))) return;
    const res = await (window as any).api?.messengerDeletePeer?.(peerId);
    if (res?.success) {
      setMenu(null);
      setSelectedPeerId(cur => cur === peerId ? '' : cur);
      setState(prev => ({
        ...prev,
        peers: prev.peers.filter(p => p.id !== peerId),
        messages: prev.messages.filter(m => m.peerId !== peerId),
      }));
    }
  };

  const clearAll = async () => {
    if (!confirm(t('clearAllConfirm'))) return;
    await (window as any).api?.messengerClearAll?.();
  };
  const scanAssignedRanges = async () => {
    setScanText(t('scanStart'));
    const res = await (window as any).api?.messengerScanRange?.();
    if (!res?.success) setScanText(res?.error === 'presence hidden' ? t('scanHiddenError') : t('scanFail', { error: res?.error || 'unknown' }));
  };

  return (
    <div className={`messenger-ws ${narrowLayout ? 'narrow' : ''}`} ref={workspaceRef} onClick={() => setMenu(null)}>
      <aside className="messenger-side">
        <div className="messenger-brand">
          <div>
            <div className="messenger-title">PePe Messenger</div>
            <div className="messenger-sub">{t('sub')}</div>
          </div>
          <span className={`messenger-dot ${hidePresence ? 'hidden' : ''}`} title={hidePresence ? t('dotHidden') : t('dotActive')} />
        </div>

        <div className="messenger-settings">
          <label>
            <span>{t('myName')}</span>
            <input
              ref={nameInputRef}
              data-messenger-name="1"
              defaultValue={storedName}
              placeholder={fallbackName || t('displayNamePlaceholder')}
              onBlur={() => {
                const val = nameInputRef.current?.value ?? '';
                if (val !== storedName) updatePrefs({ displayName: val });
              }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          </label>
          <button
            type="button"
            className="messenger-expand"
            onClick={() => setSettingsExpanded(v => !v)}
            aria-expanded={settingsExpanded}
          >
            {settingsExpanded ? t('settingsCollapse') : t('settingsExpand')}
          </button>
          {settingsExpanded && (
            <div className="messenger-settings-more">
              <label className="messenger-check">
                <input type="checkbox" checked={retainEnabled} onChange={e => updatePrefs({ retainEnabled: e.target.checked })} />
                <span>{t('autoDelete')}</span>
              </label>
              <label className="messenger-check">
                <input type="checkbox" checked={hidePresence} onChange={e => updatePrefs({ hidePresence: e.target.checked })} />
                <span>{t('hidePresence')}</span>
              </label>
              <label className="messenger-check">
                <input type="checkbox" checked={popupNotify} onChange={e => updatePrefs({ popupNotify: e.target.checked })} />
                <span>{t('popupNotify')}</span>
              </label>
              <label>
                <span>{t('popupStyle')}</span>
                <select value={popupStyle} onChange={e => updatePrefs({ popupStyle: e.target.value === 'center' ? 'center' : 'toast' })}>
                  <option value="toast">{t('styleToast')}</option>
                  <option value="center">{t('styleCenter')}</option>
                </select>
              </label>
              <label>
                <span>{t('popupHold')}</span>
                <input type="number" min={0} max={3600} value={popupHoldSec} onChange={e => updatePrefs({ popupHoldSec: Math.max(0, Number(e.target.value) || 0) })} />
              </label>
              <label>
                <span>{t('retainDays')}</span>
                <input type="number" min={1} max={3650} disabled={!retainEnabled} value={retainDays} onChange={e => updatePrefs({ retainDays: Number(e.target.value) || 30 })} />
              </label>
              <button className="messenger-danger" onClick={clearAll}>{t('clearAll')}</button>
              <div className="messenger-scan compact">
                <button onClick={scanAssignedRanges} disabled={hidePresence}>{t('scanButton')}</button>
                <small>{scanText || (hidePresence ? t('scanHintHidden') : t('scanHintNormal'))}</small>
              </div>
            </div>
          )}
          {saving && <div className="messenger-saving">{t('saving')}</div>}
        </div>

        <div className="messenger-peers">
          {state.peers.length === 0 && <div className="messenger-empty">{t('noPeers')}</div>}
          {state.peers.map(peer => {
            const readTs = readMarks[peer.id] || 0;
            const unread = state.messages.filter(m => m.peerId === peer.id && m.direction === 'in' && m.ts > readTs).length;
            return (
              <button
                key={peer.id}
                className={`messenger-peer ${peer.id === selectedPeerId ? 'active' : ''} ${peer.online ? 'online' : 'offline'} ${unread > 0 ? 'has-unread' : ''}`}
                onClick={() => setSelectedPeerId(peer.id)}
                onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, peerId: peer.id }); }}
              >
                <span className="messenger-avatar">{peer.name.slice(0, 1).toUpperCase()}</span>
                <span className="messenger-peer-main">
                  <b>{peer.name}</b>
                  <small>{peer.online ? `${peer.host}:${peer.port}` : t('offlineLastSeen', { time: fmtTime(peer.lastSeen) })}</small>
                </span>
                {unread > 0 && <span className="messenger-count">{unread}</span>}
              </button>
            );
          })}
        </div>
      </aside>

      <main className="messenger-chat">
        <header className="messenger-chat-head">
          {selectedPeer ? (
            <>
              <div>
                <h2>{selectedPeer.name}</h2>
                <p>{selectedOnline ? `${selectedPeer.host}:${selectedPeer.port}` : t('offline')} · {t('lastSeen', { time: fmtTime(selectedPeer.lastSeen) })}</p>
              </div>
              <button onClick={() => deleteConversation(selectedPeer.id)}>{t('deleteConversation')}</button>
            </>
          ) : (
            <div>
              <h2>{t('selectPeer')}</h2>
              <p>{t('selectPeerHint')}</p>
            </div>
          )}
        </header>

        <section className="messenger-messages" ref={msgListRef}>
          {messages.length === 0 && <div className="messenger-empty large">{t('noMessages')}</div>}
          {messages.map(m => (
            <div key={m.id} className={`messenger-bubble ${m.direction}`}>
              {m.kind === 'file' ? (
                <div>
                  <b>{t('fileLabel')}</b> {m.fileName} <small>{m.size ? `${(m.size / 1024).toFixed(1)}KB` : ''}</small>
                  {m.filePath && (
                    <>
                      <div className="messenger-file-path">{m.filePath}</div>
                      {canRevealFile(m) && <button className="messenger-file-action" onClick={() => (window as any).api?.shellShowItem?.(m.filePath)}>{t('revealFile')}</button>}
                    </>
                  )}
                </div>
              ) : (
                <div>{m.text}</div>
              )}
              <time>{fmtTime(m.ts)}</time>
            </div>
          ))}
        </section>

        <footer className="messenger-compose">
          <div className="messenger-compose-toolbar">
            <button className="messenger-chip-btn" disabled={!canSend} onClick={sendFiles} title={t('localFile')} aria-label={t('localFile')}>
              <span className="messenger-chip-btn-icon">📎</span>
              <span className="messenger-chip-btn-text">{t('localFile')}</span>
            </button>
            <button className="messenger-chip-btn" disabled={!canSend} onClick={() => setRemoteOpen(true)} title={t('remoteFile')} aria-label={t('remoteFile')}>
              <span className="messenger-chip-btn-icon">🌐</span>
              <span className="messenger-chip-btn-text">{t('remoteFile')}</span>
            </button>
          </div>
          <div className="messenger-compose-editor">
            <textarea
              value={text}
              disabled={!canSend}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={selectedPeer ? (hidePresence ? t('composeHidden') : (selectedOnline ? t('composePlaceholder') : t('composeOffline'))) : t('selectPeer')}
            />
            <button className="messenger-send-btn" disabled={!canSend || !text.trim()} onClick={send}>{t('send')} (Enter)</button>
          </div>
          <div className="messenger-compose-hint">
            {selectedPeer
              ? '📎 로컬 파일 · 🌐 원격 파일 버튼으로 파일을 전송할 수 있습니다.'
              : t('selectPeer')}
          </div>
        </footer>
      </main>

      {menu && (
        <div className="messenger-context" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
          <button className="danger" onClick={() => deletePeer(menu.peerId)}>{t('deletePeerMenu')}</button>
        </div>
      )}

      {remoteOpen && (
        <div className="messenger-modal-backdrop" onClick={closeRemotePicker}>
          <div className="messenger-remote-modal" onClick={e => e.stopPropagation()}>
            <header>
              <div>
                <h3>🌐 {t('remoteTitle')}</h3>
                <p>{t('remoteSubtitle', { name: selectedPeer?.name || t('userFallback') })}</p>
              </div>
              <button onClick={closeRemotePicker}>{t('close')}</button>
            </header>

            <div className="messenger-remote-connect">
              <label className="messenger-remote-label">{t('remoteSourceLabel')}</label>
              {(() => {
                const connected = remoteSessions.filter(s => connectedSessionMap.has(s.id));
                const disconnected = remoteSessions.filter(s => !connectedSessionMap.has(s.id));
                const sortFn = (a: any, b: any) => {
                  const fa = sessionFolderPath(remoteFolders, a.folderId);
                  const fb = sessionFolderPath(remoteFolders, b.folderId);
                  return fa.localeCompare(fb) || String(a.name || '').localeCompare(String(b.name || ''));
                };
                const renderOption = (s: any) => {
                  const fp = sessionFolderPath(remoteFolders, s.folderId);
                  const mark = connectedSessionMap.has(s.id) ? '🟢' : '⚪';
                  return <option key={s.id} value={s.id}>{mark} {s.name || s.host}{fp ? ` [${fp}]` : ''} ({s.host})</option>;
                };
                return (
                  <select value={remoteSessionId} onChange={e => void selectRemoteSession(e.target.value)}>
                    <option value="">{t('remoteSelectSession')}</option>
                    {connected.length > 0 && <optgroup label={t('remoteConnected')}>{[...connected].sort(sortFn).map(renderOption)}</optgroup>}
                    {disconnected.length > 0 && <optgroup label={t('remoteDisconnected')}>{[...disconnected].sort(sortFn).map(renderOption)}</optgroup>}
                    {remoteSessions.length === 0 && <option value="" disabled>{t('remoteNoSessions')}</option>}
                  </select>
                );
              })()}
              {remoteConnecting && <div className="messenger-remote-connecting">{t('connecting')}</div>}
            </div>

            <div className="messenger-remote-path">
              <button disabled={!remoteConnId || remotePath === '/'} onClick={() => loadRemoteDir(remoteConnId, parentRemotePath(remotePath))} title={t('parentFolder')}>▲</button>
              <input value={remotePath} disabled={!remoteConnId} onChange={e => setRemotePath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && remoteConnId) void loadRemoteDir(remoteConnId, remotePath); }} />
              <button disabled={!remoteConnId} onClick={() => loadRemoteDir(remoteConnId, remotePath)} title={t('reloadDir')}>⟳</button>
            </div>

            {remoteError && <div className="messenger-remote-error">{remoteError}</div>}
            <div className="messenger-remote-list">
              {!remoteConnId && <div className="messenger-empty">{remoteConnecting ? t('connecting') : t('selectSession')}</div>}
              {remoteConnId && remoteFiles.length === 0 && <div className="messenger-empty">{remoteLoading ? t('loading') : t('emptyOrError')}</div>}
              {remoteConnId && remoteFiles.map(file => {
                const full = joinRemotePath(remotePath, file.name);
                const checked = remoteSelected.has(full);
                return (
                  <button
                    key={full}
                    className={`messenger-remote-row ${file.isDir ? 'dir' : 'file'} ${checked ? 'selected' : ''}`}
                    onDoubleClick={() => file.isDir && loadRemoteDir(remoteConnId, full)}
                    onClick={() => {
                      if (file.isDir) return;
                      setRemoteSelected(prev => {
                        const next = new Set(prev);
                        if (next.has(full)) next.delete(full);
                        else next.add(full);
                        return next;
                      });
                    }}
                  >
                    <span>{file.isDir ? '📁' : '📄'}</span>
                    <b>{file.name}</b>
                    <small>{file.isDir ? t('folder') : `${(((file.size || 0) / 1024)).toFixed(1)}KB`}</small>
                  </button>
                );
              })}
            </div>

            <footer>
              <span>{t('remoteFooter', { count: remoteSelected.size })}</span>
              <button className="primary" onClick={sendRemoteFiles} disabled={!canSend || remoteLoading || remoteConnecting || remoteSelected.size === 0}>{t('remoteSendCount', { count: remoteSelected.size })}</button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
};
