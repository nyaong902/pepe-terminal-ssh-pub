import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { notifyConfirm } from './Notify';

type Peer = { id: string; name: string; host: string; port: number; lastSeen: number; online?: boolean };
type WorklogSharePayload = {
  sourceDate: string;
  sourceTodo: {
    id: string;
    text: string;
    done: boolean;
    memo?: string;
    createdAt: number;
    doneAt?: number;
  };
  sourcePeerId?: string;
  sourcePeerName?: string;
  sourceMessageId?: string;
};
type Msg = {
  id: string;
  peerId: string;
  direction: 'in' | 'out';
  kind: 'text' | 'file' | 'sticker' | 'worklog-share';
  text?: string;
  fileName?: string;
  filePath?: string;
  size?: number;
  ts: number;
  read?: boolean;
  recalled?: boolean;
  worklogShare?: WorklogSharePayload;
  shareStatus?: 'pending' | 'accepted' | 'rejected';
  shareHandledAt?: number;
};
type EmoticonAsset = { name: string; path: string; size: number; updatedAt: number; ext: string };
type EmoticonPack = { id: string; name: string; rootDir: string; cover: EmoticonAsset; items: EmoticonAsset[] };
type Prefs = { enabled?: boolean; displayName?: string; retainEnabled?: boolean; retainDays?: number; downloadDir?: string; hidePresence?: boolean; popupNotify?: boolean; popupStyle?: 'toast' | 'center'; popupHoldSec?: number };
type State = { self?: { id: string; name: string; port: number; hidden?: boolean }; peers: Peer[]; messages: Msg[]; prefs: Prefs; emoticonPacks?: EmoticonPack[]; downloadsDir?: string };
type RemoteEntry = { name: string; isDir: boolean; size?: number; mtime?: number };
type ConnectedSession = { panelId: string; sessionId?: string; sessionName?: string; host?: string; port?: number };
type PendingAttachment = { name: string; path: string; size: number; mime: string; previewUrl?: string };

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

// filePath 가 앱이 자동 저장해둔 고정 폴더(downloadsDir) 안이면 아직 사용자가 "저장"을 안 한 것 —
// 밖이면 다른 이름으로 저장을 이미 완료한 것이라 "위치 열기" 버튼을 "폴더 열기"로 바꿔 보여준다
// (크롬 다운로드바가 저장 전엔 "저장", 저장 후엔 "폴더 열기"로 바뀌는 것과 같은 패턴).
function isSavedElsewhere(msg: Msg, downloadsDir?: string): boolean {
  if (!msg.filePath || !downloadsDir) return false;
  const dir = downloadsDir.replace(/[\\/]+$/, '');
  return path_dirname(msg.filePath) !== dir;
}
function path_dirname(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx < 0 ? '' : p.slice(0, idx);
}

const SIDE_COLLAPSED_PREF = 'messengerSideCollapsed';
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);
function isImageFile(name?: string) {
  const ext = (name || '').split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXT.has(ext);
}
function fileUrl(p?: string) {
  if (!p) return '';
  // Electron renderer 에서 file:// 로컬 이미지가 종종 깨져서, 앱 전용 프로토콜로 읽는다.
  return `pepeapp://app/__local-file?path=${encodeURIComponent(p)}`;
}

// 메시지가 이모티콘만으로 구성됐으면 개수를 반환(0이면 일반 텍스트) — 카톡/디스코드처럼
// 개수가 적을수록(1~3개) 더 크게 렌더링하기 위함.
const EMOJI_ONLY_RE = new RegExp('^(\\p{Extended_Pictographic}\\uFE0F?(\\u200D\\p{Extended_Pictographic}\\uFE0F?)*|\\s)+$', 'u');
function emojiOnlyCount(text?: string): number {
  const trimmed = (text || '').trim();
  if (!trimmed || !EMOJI_ONLY_RE.test(trimmed)) return 0;
  try {
    const seg = new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(trimmed)).length;
  } catch {
    return Array.from(trimmed).length;
  }
}

type EmojiCategory = { key: string; icon: string; label: string; emojis: string[] };
const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    key: 'pepe', icon: '🐸', label: 'PePe',
    emojis: ['🐸', '💻', '🖥️', '⌨️', '🔌', '📡', '🔧', '🐧', '🔒', '🔓', '🚀', '🐛', '⚙️', '🛰️', '💾'],
  },
  {
    key: 'smileys', icon: '😀', label: '표정',
    emojis: [
      '😀', '😁', '😂', '🤣', '😅', '😊', '😉', '😍', '🥰', '😘',
      '🤔', '🙄', '😴', '😭', '😢', '😡', '😱', '🥳', '😎', '🤗',
      '🤩', '😏', '😬', '🙃', '😐', '😅', '🥲', '😤', '🤯', '🥶',
    ],
  },
  {
    key: 'gesture', icon: '👍', label: '사람',
    emojis: [
      '👍', '👎', '👏', '🙏', '💪', '🤝', '👋', '✌️', '🤞', '👌',
      '👉', '👈', '👆', '👇', '✋', '🤙', '👊', '🫡', '🙌', '🤦',
    ],
  },
  {
    key: 'animal', icon: '🐶', label: '동물',
    emojis: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
      '🦁', '🐮', '🐷', '🐔', '🐧', '🐦', '🐢', '🐍', '🦄', '🐳',
    ],
  },
  {
    key: 'food', icon: '🍕', label: '음식',
    emojis: [
      '🍕', '🍔', '🍟', '🌭', '🍿', '🍩', '🎂', '☕', '🍺', '🍻',
      '🍎', '🍌', '🍇', '🍓', '🍉', '🥐', '🍜', '🍣', '🍦', '🍫',
    ],
  },
  {
    key: 'symbol', icon: '❤️', label: '기호',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💯', '✨',
      '🔥', '⭐', '⚡', '✅', '❌', '❓', '❗', '💤', '🎉', '🎊',
    ],
  },
];

function scanLabel(payload: any, t: (k: string, o?: any) => string) {
  const ranges = Array.isArray(payload?.prefixes) ? payload.prefixes.map((v: string) => `${v}.x.x`) : [];
  const directCount = Array.isArray(payload?.directHosts) ? payload.directHosts.length : 0;
  if (directCount > 0) ranges.push(t('scanLabelOverlay', { count: directCount }));
  return ranges.length ? ranges.join(', ') : t('scanLabelFallback');
}

export const MessengerWorkspace: React.FC<{
  connectedSessions?: ConnectedSession[];
  visible?: boolean;
  initialState?: { selectedPeerId?: string; text?: string; settingsExpanded?: boolean; pendingAttachments?: PendingAttachment[] } | null;
  onStateChange?: (state: { selectedPeerId: string; text: string; settingsExpanded: boolean; pendingAttachments: PendingAttachment[] }) => void;
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
  const [saveFileError, setSaveFileError] = useState<{ id: string; text: string } | null>(null);
  const [settingsExpanded, setSettingsExpanded] = useState(initialState?.settingsExpanded ?? false);
  // AI Chat 탭으로 갔다가 돌아오면 MessengerWorkspace 가 언마운트/재마운트되므로(탭 전환이 조건부
  // 렌더) 첨부 목록도 selectedPeerId/text 처럼 부모에 보고했다가 복원해야 유지됨.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>(initialState?.pendingAttachments || []);
  // 부모에게 상태 보고 — 탭 전환/분리 시 직렬화.
  useEffect(() => {
    if (!onStateChange) return;
    try { onStateChange({ selectedPeerId, text, settingsExpanded, pendingAttachments }); } catch {}
  }, [selectedPeerId, text, settingsExpanded, pendingAttachments, onStateChange]);
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
  const [shareActionBusyId, setShareActionBusyId] = useState('');
  const [shareActionError, setShareActionError] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; peerId: string } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiCategory, setEmojiCategory] = useState<string>('pepe');
  const [selectedEmoticonPackId, setSelectedEmoticonPackId] = useState('');
  const [emoticonReloading, setEmoticonReloading] = useState(false);
  // 이모티콘에 마우스를 올리면 확대 미리보기 — 작은 그리드 썸네일만으로는 그림을 알아보기 어려워서.
  const [emoticonPreview, setEmoticonPreview] = useState<{ path: string; name: string } | null>(null);
  const [recentEmojis, setRecentEmojis] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('messenger:recentEmojis') || '[]') || []; } catch { return []; }
  });
  // 이모티콘 팝업 위치 — CSS 만으로는 패널 경계 안에 정확히 못 가둬서, 버튼/패널 실제 크기를
  // 측정해 패널(.messenger-ws) 기준 절대좌표(px)를 직접 계산.
  const emojiBtnRef = useRef<HTMLButtonElement | null>(null);
  const [emojiPopupPos, setEmojiPopupPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const composeTextareaRef = useRef<HTMLTextAreaElement | null>(null);
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
  // 사용자 목록을 아바타만 남기고 접는다. 좁은 창에서 자동으로 그렇게 되는 레이아웃(container
  // query)을 손으로도 켤 수 있게 한 것 — 넓은 창에서 대화 영역을 넓게 쓰려는 용도다.
  //
  // 3단인 이유: 'auto' 는 창 폭에 맡기는 기존 동작이고(좁으면 접힘), 좁은 창에서도 이름을 보려면
  // 폭을 무시하고 펼치는 상태가 따로 필요하다. 버튼은 "지금 보이는 모습" 의 반대로 넘긴다.
  const [sideMode, setSideMode] = useState<'auto' | 'collapsed' | 'expanded'>('auto');
  const sideModeLoaded = useRef(false);
  useEffect(() => {
    (window as any).api?.getUIPrefs?.().then((prefs: any) => {
      const v = prefs?.[SIDE_COLLAPSED_PREF];
      if (v === 'collapsed' || v === 'expanded' || v === 'auto') setSideMode(v);
      else if (typeof v === 'boolean') setSideMode(v ? 'collapsed' : 'auto');   // 이전 형식
      sideModeLoaded.current = true;
    }).catch(() => { sideModeLoaded.current = true; });
  }, []);
  useEffect(() => {
    if (!sideModeLoaded.current) return;   // 불러오기 전 초기값으로 덮어쓰지 않게
    try { (window as any).api?.setUIPrefs?.({ [SIDE_COLLAPSED_PREF]: sideMode }); } catch {}
  }, [sideMode]);
  // 지금 실제로 접혀 보이는지 — 좁은 창(560px 미만)에서는 auto 도 접힌 모습이 된다(App.css 의
  // container query 와 같은 기준). 아이콘 방향과 아바타 tooltip 이 이 값을 따른다.
  const sideCollapsed = sideMode === 'collapsed' || (sideMode === 'auto' && narrowLayout);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  // .messenger-chat 도 position:relative 라 실제로는 이게 이모티콘 팝업의 containing block
  // (더 가까운 positioned 조상이 우선) — .messenger-ws 기준으로 좌표를 재면 세션 목록 폭만큼 어긋남.
  const chatMainRef = useRef<HTMLElement | null>(null);

  const wasNarrowRef = useRef(false);
  useEffect(() => {
    const el = workspaceRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect?.width || 0;
      const narrow = width < 560;
      setNarrowLayout(narrow);
      // 좁아지는 순간에는 손으로 펼쳐둔 것도 접는다 — 좁은 폭에서 목록을 펼치면 대화가 남지
      // 않는다. 'auto' 로 돌리는 것이라 다시 넓히면 저절로 펼쳐지고, 좁은 채로 버튼을 누르면
      // 그때는 펼쳐진 채로 남는다(다시 좁아질 때만 접힌다).
      if (narrow && !wasNarrowRef.current) setSideMode(m => (m === 'expanded' ? 'auto' : m));
      wasNarrowRef.current = narrow;
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
        // main 프로세스가 3초 keepalive 마다 실제 등록된 피어만 담은 state 를 다시 보내는데,
        // 그대로 덮어쓰면 렌더러 로컬에서만 존재하는 테스트용 더미 사용자(addDummyPeer)가
        // 매번 사라진다 — 기존 더미는 유지한 채 실제 피어 목록만 갱신한다.
        setState(prev => {
          const dummies = prev.peers.filter(pr => pr.id.startsWith('dummy-peer-'));
          return { ...p.state, peers: [...p.state.peers, ...dummies] };
        });
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

  // 상대에게 "읽음" 확인 전송 — 그래야 상대 쪽에서 이 메시지를 더 이상 회수(recall) 못 하게 됨.
  const ackedReadRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedPeerId) return;
    for (const m of state.messages) {
      if (m.peerId === selectedPeerId && m.direction === 'in' && !ackedReadRef.current.has(m.id)) {
        ackedReadRef.current.add(m.id);
        (window as any).api?.messengerMarkRead?.(selectedPeerId, m.id);
      }
    }
  }, [selectedPeerId, state.messages]);
  useEffect(() => {
    setShareActionError('');
    setShareActionBusyId('');
  }, [selectedPeerId]);

  const recallMessage = async (peerId: string, messageId: string) => {
    await (window as any).api?.messengerRecallMessage?.(peerId, messageId);
  };
  const saveFileAs = async (m: Msg) => {
    if (!m.filePath) return;
    const res = await (window as any).api?.messengerSaveFileAs?.({ filePath: m.filePath, fileName: m.fileName, peerId: m.peerId, messageId: m.id });
    if (res && !res.success && !res.canceled) {
      setSaveFileError({ id: m.id, text: String(res.error || '') });
      setTimeout(() => setSaveFileError(cur => (cur?.id === m.id ? null : cur)), 4000);
    }
  };
  const respondWorklogShare = async (message: Msg, decision: 'accepted' | 'rejected') => {
    setShareActionBusyId(message.id);
    setShareActionError('');
    try {
      const res = await (window as any).api?.messengerRespondWorklogShare?.(message.peerId, message.id, decision);
      if (!res?.success) {
        setShareActionError(t('worklogShareFail', { error: String(res?.error || 'unknown') }));
      }
    } catch (err: any) {
      setShareActionError(t('worklogShareFail', { error: String(err?.message || err) }));
    } finally {
      setShareActionBusyId('');
    }
  };

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
  const emoticonPacks = state.emoticonPacks || [];
  const selectedEmoticonPack = emoticonPacks.find(p => p.id === selectedEmoticonPackId) || emoticonPacks[0] || null;
  const hasEmoticonPacks = emoticonPacks.length > 0;

  useEffect(() => {
    if (!hasEmoticonPacks) {
      if (selectedEmoticonPackId) setSelectedEmoticonPackId('');
      return;
    }
    if (!selectedEmoticonPackId || !emoticonPacks.some(p => p.id === selectedEmoticonPackId)) {
      setSelectedEmoticonPackId(emoticonPacks[0]?.id || '');
    }
  }, [hasEmoticonPacks, emoticonPacks, selectedEmoticonPackId, emojiCategory]);

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
    if ((!body && pendingAttachments.length === 0) || !canSend) return;
    const attachments = pendingAttachments;
    setText('');
    setPendingAttachments([]);
    if (attachments.length > 0) {
      const files = attachments.map(a => ({ path: a.path, name: a.name }));
      const res = await (window as any).api?.messengerSendFilePaths?.(selectedPeerId, files);
      if (!res?.success) setPendingAttachments(attachments);
    }
    if (body) {
      const res = await (window as any).api?.messengerSendMessage?.(selectedPeerId, body);
      if (!res?.success) setText(body);
    }
  };
  const sendSticker = async (filePath: string) => {
    if (!canSend || !filePath) return;
    setEmojiOpen(false);
    try {
      await (window as any).api?.messengerSendStickerPaths?.(selectedPeerId, [filePath]);
    } catch {}
  };

  const refreshEmoticonPacks = async () => {
    if (emoticonReloading) return;
    setEmoticonReloading(true);
    try {
      const res = await (window as any).api?.messengerGetState?.().catch(() => null);
      if (res) {
        setState(res);
        setSelectedPeerId((cur) => (cur && Array.isArray(res.peers) && res.peers.some((p: Peer) => p.id === cur)) ? cur : (res.peers?.[0]?.id || ''));
      }
    } finally {
      setEmoticonReloading(false);
    }
  };

  // 이모티콘 팝업 위치/폭 재계산 — 버튼/패널(.messenger-chat, 실제 containing block) 실측 기준.
  const recomputeEmojiPopupPos = () => {
    const btnRect = emojiBtnRef.current?.getBoundingClientRect();
    const panelRect = chatMainRef.current?.getBoundingClientRect();
    if (!btnRect || !panelRect) return;
    const MARGIN = 8;
    // 패널이 300px 보다 좁으면 팝업 자체 폭도 줄여서 항상 안에 들어가게 함
    // (CSS max-width/cqw 계산만으로는 정확히 안 맞아 JS 로 직접 폭까지 계산).
    const width = Math.max(160, Math.min(300, panelRect.width - MARGIN * 2));
    // 버튼 오른쪽 끝에 맞춰 왼쪽으로 펼치되, 패널 좌우 경계 안으로 클램프.
    let left = btnRect.right - panelRect.left - width;
    left = Math.max(MARGIN, Math.min(left, panelRect.width - width - MARGIN));
    const bottom = panelRect.bottom - btnRect.top + 6;
    setEmojiPopupPos({ left, bottom, width });
  };
  // 팝업이 열려있는 동안 창/패널 크기가 실시간으로 바뀌면 위치도 같이 재계산.
  useEffect(() => {
    if (!emojiOpen) return;
    window.addEventListener('resize', recomputeEmojiPopupPos);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(recomputeEmojiPopupPos) : null;
    if (ro && chatMainRef.current) ro.observe(chatMainRef.current);
    return () => {
      window.removeEventListener('resize', recomputeEmojiPopupPos);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emojiOpen]);

  // 이모티콘을 커서 위치에 삽입 (없으면 끝에 추가).
  const insertEmoji = (emoji: string) => {
    const el = composeTextareaRef.current;
    if (!el) { setText(prev => prev + emoji); return; }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
    setRecentEmojis(prev => {
      const nextRecent = [emoji, ...prev.filter(e => e !== emoji)].slice(0, 24);
      try { localStorage.setItem('messenger:recentEmojis', JSON.stringify(nextRecent)); } catch {}
      return nextRecent;
    });
  };

  // 로컬 파일 선택 — 바로 전송하지 않고 첨부 목록에 추가 (드래그/붙여넣기와 동일한 흐름).
  const pickFiles = async () => {
    if (!canSend) return;
    const res = await (window as any).api?.messengerPickFiles?.();
    if (!res?.success || !Array.isArray(res.files)) return;
    for (const f of res.files) {
      const img = isImageFile(f.name);
      setPendingAttachments(prev => [...prev, {
        name: f.name,
        path: f.path,
        size: f.size,
        mime: img ? 'image/*' : '',
        previewUrl: img ? fileUrl(f.path) : undefined,
      }]);
    }
  };

  // Explorer 등 외부에서 드래그된 File 의 실제 절대경로를 webUtils.getPathForFile 로 얻어
  // 임시 디렉토리로 복사(chatCopyExternalFile) 후 첨부 목록에 추가.
  const attachExternalFile = async (file: File) => {
    try {
      const fsPath: string | null = (window as any).api?.getPathForFile?.(file) || null;
      if (!fsPath) return;
      const res = await (window as any).api?.chatCopyExternalFile?.(fsPath, file.name);
      if (!res?.success || !res.path) return;
      let previewUrl: string | undefined;
      if (res.mime?.startsWith('image/') && file.size < 2 * 1024 * 1024) {
        try {
          previewUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result || ''));
            r.onerror = () => reject(r.error);
            r.readAsDataURL(file);
          });
        } catch {}
      }
      setPendingAttachments(prev => [...prev, { name: res.displayName || file.name, path: res.path, size: res.size, mime: res.mime || '', previewUrl }]);
    } catch {}
  };

  // 클립보드에서 붙여넣은 이미지/파일(스크린샷 등) — dataUrl 로 저장 후 첨부 목록에 추가.
  const attachPastedBlob = async (blob: Blob, suggestedName?: string) => {
    try {
      const name = suggestedName || `paste-${Date.now()}.png`;
      const mime = blob.type || '';
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(r.error || new Error('FileReader 실패'));
        r.readAsDataURL(blob);
      });
      const res = await (window as any).api?.chatSavePastedBlob?.(dataUrl, name, mime);
      if (!res?.success) return;
      const previewUrl = mime.startsWith('image/') ? dataUrl : undefined;
      setPendingAttachments(prev => [...prev, { name: res.displayName || name, path: res.path, size: res.size, mime, previewUrl }]);
    } catch {}
  };

  const onComposePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const blobs: { blob: Blob; name?: string }[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) blobs.push({ blob: f, name: f.name });
      }
    }
    if (blobs.length === 0) return; // 텍스트만 — 기본 붙여넣기 동작 유지
    e.preventDefault();
    e.stopPropagation(); // MessengerWorkspace 가 ClaudeChat 사이드바 안에 중첩돼 있어 상위로 전파되면 중복 첨부됨
    for (const b of blobs) void attachPastedBlob(b.blob, b.name);
  };

  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (!canSend) return;
    dragCounter.current++;
    setDragOver(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    if (!canSend) return;
    for (const f of Array.from(e.dataTransfer.files)) void attachExternalFile(f);
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
    const ok = await notifyConfirm(t('deleteTitle'), t('deletePeerConfirm', { name: peer?.name || t('selectedUserFallback') }));
    if (!ok) return;
    // 테스트용 더미 사용자는 실제 등록된 피어가 아니라 렌더러 로컬 상태에만 있으므로,
    // main 프로세스 IPC 를 거치지 않고 바로 로컬에서 제거한다.
    const isDummy = peerId.startsWith('dummy-peer-');
    const res = isDummy ? { success: true } : await (window as any).api?.messengerDeletePeer?.(peerId);
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

  // 테스트용 온라인 더미 사용자 추가 — LAN 자동 탐색으로 상대가 안 잡힌 개발/테스트 환경에서
  // UI(피어 목록, 채팅창 등)를 바로 확인할 수 있게 설정 패널에 버튼으로 노출. 실제로 등록되는
  // 피어가 아니라 렌더러 로컬 상태에만 추가되고, 메시지 전송은 peer-not-found 로 조용히 무시된다.
  const addDummyPeer = () => {
    const id = `dummy-peer-${Date.now()}`;
    const dummy: Peer = { id, name: `테스트 사용자 ${state.peers.filter(p => p.id.startsWith('dummy-peer-')).length + 1}`, host: '127.0.0.1', port: 0, lastSeen: Date.now(), online: true };
    setState(prev => ({ ...prev, peers: [...prev.peers, dummy] }));
  };

  const clearAll = async () => {
    const ok = await notifyConfirm(t('deleteTitle'), t('clearAllConfirm'));
    if (!ok) return;
    await (window as any).api?.messengerClearAll?.();
  };
  const scanAssignedRanges = async () => {
    setScanText(t('scanStart'));
    const res = await (window as any).api?.messengerScanRange?.();
    if (!res?.success) setScanText(res?.error === 'presence hidden' ? t('scanHiddenError') : t('scanFail', { error: res?.error || 'unknown' }));
  };

  return (
    <div className={`messenger-ws ${narrowLayout ? 'narrow' : ''}`} ref={workspaceRef} onClick={() => { setMenu(null); setEmojiOpen(false); }}>
      <aside className={`messenger-side ${sideMode === 'collapsed' ? 'collapsed' : ''} ${sideMode === 'expanded' ? 'expanded' : ''}`}>
        {/* 접기/펼치기 — 접으면 brand·설정이 숨으므로 이 버튼만 항상 보이는 자리에 둔다. */}
        <div className="messenger-side-toggle-row">
          <button
            type="button"
            className="messenger-side-toggle"
            onClick={() => setSideMode(sideCollapsed ? 'expanded' : 'collapsed')}
            aria-expanded={!sideCollapsed}
            title={sideCollapsed ? t('sideExpand') : t('sideCollapse')}
            aria-label={sideCollapsed ? t('sideExpand') : t('sideCollapse')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <rect x="2.2" y="3.2" width="4" height="9.6" rx="1.6" fill="currentColor" opacity="0.6" />
              <path
                d={sideCollapsed ? 'M9 5.6 L11.6 8 L9 10.4' : 'M11.6 5.6 L9 8 L11.6 10.4'}
                fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
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
              <button onClick={addDummyPeer} title="LAN 에서 상대가 안 잡힐 때 UI 테스트용 온라인 사용자를 추가합니다(우클릭 → 삭제로 제거 가능)">
                + 테스트용 더미 사용자 추가
              </button>
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
                onContextMenu={e => {
                  e.preventDefault();
                  // .messenger-context 가 이제 패널 기준 position:absolute 라 뷰포트 좌표가 아니라
                  // 패널(workspaceRef) 기준 상대 좌표로 변환해서 저장.
                  const rect = workspaceRef.current?.getBoundingClientRect();
                  setMenu({ x: e.clientX - (rect?.left || 0), y: e.clientY - (rect?.top || 0), peerId: peer.id });
                }}
              >
                <span className="messenger-avatar" title={sideCollapsed ? peer.name : undefined}>{peer.name.slice(0, 1).toUpperCase()}</span>
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

      <main
        ref={chatMainRef}
        className={`messenger-chat ${dragOver ? 'drag-over' : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dragOver && canSend && (
          <div className="messenger-drop-overlay">📎 {t('dropToAttach', { defaultValue: '여기에 놓아서 첨부' })}</div>
        )}
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
        {shareActionError && <div className="messenger-worklog-share-error">{shareActionError}</div>}

        <section className="messenger-messages" ref={msgListRef}>
          {messages.length === 0 && <div className="messenger-empty large">{t('noMessages')}</div>}
          {messages.map(m => {
            const emojiCount = m.kind === 'text' ? emojiOnlyCount(m.text) : 0;
            const emojiSizeClass = emojiCount === 1 ? 'emoji-x1' : emojiCount === 2 ? 'emoji-x2' : emojiCount === 3 ? 'emoji-x3' : '';
            const recallable = m.direction === 'out' && !m.recalled && !m.read;
            const shareSourceName = m.worklogShare?.sourcePeerName || (m.direction === 'out' ? state.self?.name : selectedPeer?.name) || '';
            const shareSourceDate = m.worklogShare?.sourceDate || '';
            const shareTodo = m.worklogShare?.sourceTodo;
            const shareStatusLabel = m.shareStatus === 'accepted'
              ? t('worklogShareAccepted')
              : m.shareStatus === 'rejected'
                ? t('worklogShareRejected')
                : '';
            return (
            <div key={m.id} className={`messenger-bubble ${m.direction} ${emojiSizeClass}${m.kind === 'sticker' ? ' sticker-message' : ''}`}>
              {m.recalled ? (
                <div className="messenger-recalled">{m.direction === 'out' ? t('messageRecalledSelf', { defaultValue: '메시지를 삭제했습니다.' }) : t('messageRecalledPeer', { defaultValue: '상대방이 메시지를 회수했습니다.' })}</div>
              ) : m.kind === 'worklog-share' ? (
                <div className="messenger-worklog-share-card">
                  <div className="messenger-worklog-share-head">
                    <div className="messenger-worklog-share-title">{m.direction === 'in' ? t('worklogShareIncoming') : t('worklogShareOutgoing')}</div>
                    <div className="messenger-worklog-share-meta">{[shareSourceName, shareSourceDate].filter(Boolean).join(' · ')}</div>
                  </div>
                  <div className="messenger-worklog-share-body">
                    <div className="messenger-worklog-share-text">{shareTodo?.text || m.text || ''}</div>
                    {shareTodo?.memo?.trim() && <div className="messenger-worklog-share-memo">{shareTodo.memo}</div>}
                    {m.direction === 'in' && m.shareStatus === 'pending' ? (
                      <div className="messenger-worklog-share-actions">
                        <button
                          className="messenger-worklog-share-accept"
                          disabled={shareActionBusyId === m.id}
                          onClick={() => void respondWorklogShare(m, 'accepted')}
                        >{t('worklogShareAccept')}</button>
                        <button
                          className="messenger-worklog-share-reject"
                          disabled={shareActionBusyId === m.id}
                          onClick={() => void respondWorklogShare(m, 'rejected')}
                        >{t('worklogShareReject')}</button>
                      </div>
                    ) : shareStatusLabel ? (
                      <div className={`messenger-worklog-share-status ${m.shareStatus}`}>{shareStatusLabel}</div>
                    ) : null}
                  </div>
                </div>
              ) : m.kind === 'file' || m.kind === 'sticker' ? (
                <div className={`messenger-file-card ${m.kind === 'sticker' ? 'sticker messenger-sticker-only' : ''}`}>
                  {isImageFile(m.fileName) && m.filePath ? (
                    <img
                      className={m.kind === 'sticker' ? 'messenger-sticker-preview' : 'messenger-image-preview'}
                      src={fileUrl(m.filePath)}
                      alt={m.fileName}
                      onClick={() => m.kind === 'file' ? (window as any).api?.shellShowItem?.(m.filePath) : undefined}
                    />
                  ) : null}
                  {m.kind === 'file' && (
                    <>
                      <div>
                        <b>{t('fileLabel')}</b> {m.fileName} <small>{m.size ? `${(m.size / 1024).toFixed(1)}KB` : ''}</small>
                      </div>
                      {m.filePath && (
                        <>
                          {isSavedElsewhere(m, state.downloadsDir) && <div className="messenger-file-path">{m.filePath}</div>}
                          <div className="messenger-file-card-actions">
                            {isSavedElsewhere(m, state.downloadsDir) ? (
                              canRevealFile(m) && <button className="messenger-file-action" onClick={() => (window as any).api?.shellShowItem?.(m.filePath)}>{t('openFolder')}</button>
                            ) : (
                              <button className="messenger-file-action" onClick={() => saveFileAs(m)}>{t('saveFileAs')}</button>
                            )}
                          </div>
                          {saveFileError?.id === m.id && <div className="messenger-file-save-error">{saveFileError.text}</div>}
                        </>
                      )}
                    </>
                  )}
                  {m.kind === 'sticker' && (
                    <div className="messenger-sticker-meta">{m.fileName}</div>
                  )}
                </div>
              ) : (
                <div>{m.text}</div>
              )}
              <div className="messenger-bubble-footer">
                <time>{fmtTime(m.ts)}</time>
                {recallable && (
                  <button
                    className="messenger-recall-btn"
                    title={t('recallMessage', { defaultValue: '보내기 취소' })}
                    onClick={() => recallMessage(m.peerId, m.id)}
                  >✕</button>
                )}
              </div>
            </div>
            );
          })}
        </section>

        <footer className="messenger-compose">
          {pendingAttachments.length > 0 && (
            <div className="messenger-attachments">
              <div className="messenger-attachments-header">
                <span>📎 첨부 {pendingAttachments.length}개</span>
                <button className="messenger-attachments-clear" onClick={() => {
                  for (const a of pendingAttachments) { try { (window as any).api?.chatRemovePendingAttachment?.(a.path); } catch {} }
                  setPendingAttachments([]);
                }}>전체 제거</button>
              </div>
              <div className="messenger-attachments-list">
                {pendingAttachments.map((a, i) => (
                  <div key={`${a.path}-${i}`} className="messenger-attachment-chip">
                    {a.previewUrl ? (
                      <img src={a.previewUrl} alt={a.name} />
                    ) : (
                      <span className="messenger-attachment-chip-icon">📄</span>
                    )}
                    <span className="messenger-attachment-chip-name" title={a.path}>{a.name}</span>
                    <span className="messenger-attachment-chip-size">{(a.size / 1024).toFixed(1)}KB</span>
                    <button className="messenger-attachment-chip-remove" onClick={() => {
                      try { (window as any).api?.chatRemovePendingAttachment?.(a.path); } catch {}
                      setPendingAttachments(prev => prev.filter((_, x) => x !== i));
                    }}>×</button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="messenger-compose-toolbar" onMouseDown={e => e.preventDefault()}>
            <button className="messenger-chip-btn" disabled={!canSend} onClick={pickFiles} title={t('localFile')} aria-label={t('localFile')}>
              <span className="messenger-chip-btn-icon">📎</span>
              <span className="messenger-chip-btn-text">{t('localFile')}</span>
            </button>
            <button className="messenger-chip-btn" disabled={!canSend} onClick={() => setRemoteOpen(true)} title={t('remoteFile')} aria-label={t('remoteFile')}>
              <span className="messenger-chip-btn-icon">🌐</span>
              <span className="messenger-chip-btn-text">{t('remoteFile')}</span>
            </button>
            <div className="messenger-emoji-wrap">
              <button
                ref={emojiBtnRef}
                className="messenger-chip-btn"
                disabled={!canSend}
                onClick={e => {
                  e.stopPropagation();
                  setEmojiOpen(v => {
                    const next = !v;
                    if (next) recomputeEmojiPopupPos();
                    return next;
                  });
                }}
                title="이모티콘"
                aria-label="이모티콘"
              >
                <span className="messenger-chip-btn-icon">🐸</span>
                <span className="messenger-chip-btn-text">이모티콘</span>
              </button>
              {emojiOpen && (() => {
                const activeCat = emojiCategory === 'recent'
                  ? { key: 'recent', icon: '🕒', label: '최근', emojis: recentEmojis }
                  : EMOJI_CATEGORIES.find(c => c.key === emojiCategory) || EMOJI_CATEGORIES[0];
                const isPackMode = emojiCategory === 'packs';
                const popupWidth = emojiPopupPos?.width || 300;
                return (
                  <div
                    className="messenger-emoji-popup"
                    style={emojiPopupPos ? { left: emojiPopupPos.left, bottom: emojiPopupPos.bottom, width: emojiPopupPos.width } : undefined}
                    onClick={e => e.stopPropagation()}
                  >
                    <div className="messenger-emoji-tabs">
                      <button
                        className={`messenger-emoji-tab ${emojiCategory === 'recent' ? 'active' : ''}`}
                        title="최근 사용"
                        onClick={() => setEmojiCategory('recent')}
                      >🕒</button>
                      {EMOJI_CATEGORIES.map(c => (
                        <button
                          key={c.key}
                          className={`messenger-emoji-tab ${emojiCategory === c.key ? 'active' : ''}`}
                          title={c.label}
                          onClick={() => setEmojiCategory(c.key)}
                        >{c.icon}</button>
                      ))}
                      <button
                        className={`messenger-emoji-tab ${isPackMode ? 'active' : ''}`}
                        title="설치형 GIF"
                        onClick={() => {
                          setEmojiCategory('packs');
                          void refreshEmoticonPacks();
                        }}
                      >🎞️</button>
                    </div>
                    {isPackMode ? (
                      <>
                        {/* 설치된 팩이 2개 이상일 때만 선택 바를 보여준다 — 1개뿐이면 자동 선택되므로
                            이름표 카드 하나만 덩그러니 보이는 게 오히려 UI 잡음이라 숨긴다. */}
                        {emoticonPacks.length > 1 && (
                          <div className="messenger-emoticon-pack-bar">
                            <div className="messenger-emoticon-pack-strip">
                              {emoticonPacks.map(pack => (
                                <button
                                  key={pack.id}
                                  className={`messenger-emoticon-pack-card ${selectedEmoticonPack?.id === pack.id ? 'active' : ''}`}
                                  onClick={() => setSelectedEmoticonPackId(pack.id)}
                                  title={pack.name}
                                >
                                  <span className="messenger-emoticon-pack-name">{pack.name}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {selectedEmoticonPack ? (
                          <>
                            <div className="messenger-emoticon-pack-heading">
                              <span>{selectedEmoticonPack.name}</span>
                              <small>총 {selectedEmoticonPack.items.length + 1}개</small>
                            </div>
                            <div
                              className="messenger-emoji-grid messenger-emoticon-items-grid"
                              style={{ gridTemplateColumns: `repeat(${Math.max(3, Math.floor(popupWidth / 68))}, minmax(0, 1fr))` }}
                            >
                              {selectedEmoticonPack.items.length === 0 ? (
                                <div className="messenger-emoji-empty">이 팩에는 대표이미지 외의 아이콘이 없습니다.</div>
                              ) : (
                                selectedEmoticonPack.items.map((item, i) => (
                                  <button
                                    key={`${selectedEmoticonPack.id}-${item.name}-${i}`}
                                    className="messenger-emoji-item messenger-emoticon-item"
                                    onClick={() => void sendSticker(item.path)}
                                    onMouseEnter={() => setEmoticonPreview({ path: item.path, name: item.name })}
                                    onMouseLeave={() => setEmoticonPreview(null)}
                                  >
                                    <img src={fileUrl(item.path)} alt={item.name} />
                                  </button>
                                ))
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="messenger-emoji-empty">설치된 GIF 팩이 없습니다. 새로고침해서 다시 읽어보세요.</div>
                        )}
                      </>
                    ) : (
                      <div
                        className="messenger-emoji-grid"
                        style={{ gridTemplateColumns: `repeat(${Math.max(4, Math.floor(popupWidth / 34))}, minmax(0, 1fr))` }}
                      >
                        {activeCat.emojis.length === 0 ? (
                          <div className="messenger-emoji-empty">아직 사용한 이모티콘이 없습니다.</div>
                        ) : (
                          activeCat.emojis.map((em, i) => (
                            <button key={`${em}-${i}`} className="messenger-emoji-item" onClick={() => insertEmoji(em)}>{em}</button>
                          ))
                        )}
                      </div>
                    )}
                    {emoticonPreview && (
                      <div className="messenger-emoticon-preview">
                        <img src={fileUrl(emoticonPreview.path)} alt={emoticonPreview.name} />
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
          <div className="messenger-compose-editor">
            <textarea
              ref={composeTextareaRef}
              value={text}
              disabled={!canSend}
              onChange={e => setText(e.target.value)}
              onPaste={onComposePaste}
              onFocus={() => setEmojiOpen(false)}
              onMouseDown={e => {
                // 플레이스홀더만 보이는 빈 입력창에서 드래그하면 플레이스홀더 텍스트가 선택 영역처럼 보이는
                // 크로미움 버그성 동작이 있어, 비어있을 때는 드래그 선택을 막고 커서 포커스만 남긴다.
                if (!text) {
                  e.preventDefault();
                  composeTextareaRef.current?.focus();
                }
              }}
              onDragStart={e => { if (!text) e.preventDefault(); }}
              style={!text ? { userSelect: 'none', WebkitUserSelect: 'none' } as React.CSSProperties : undefined}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={selectedPeer ? (hidePresence ? t('composeHidden') : (selectedOnline ? `${t('composePlaceholder')} · 📎🌐😀 드래그·Ctrl+V 로 첨부 가능` : t('composeOffline'))) : t('selectPeer')}
            />
            <button className="messenger-send-btn" disabled={!canSend || (!text.trim() && pendingAttachments.length === 0)} onClick={send}>{t('send')} (Enter)</button>
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
