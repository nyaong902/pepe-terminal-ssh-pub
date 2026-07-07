// src/components/TabApp.tsx
// Wave-Terminal 스타일 탭별 프로세스 분리 — 이 컴포넌트는 워크스페이스 탭 "하나"의
// Layout 트리를 통째로 소유하는, 별도 WebContentsView 프로세스에서 로드되는 진입점이다.
// (electron/main.ts 가 '#tab-app?tabId=X' 해시로 이 번들을 로드한다 — src/main.tsx 참고)
//
// App.tsx(host) 는 탭 바/워크스페이스 목록/전역 메뉴만 갖고, 이 탭의 실제 분할·미니탭·xterm
// 은 전부 이 프로세스 안에서 로컬 상태로 처리한다 — 그래서 인트라-탭 조작(분할/드래그/탭전환)은
// IPC 가 전혀 필요 없다(같은 프로세스). 크로스-탭 세션 이동만 release/adopt IPC 를 탄다(추후 작업).
//
// v1 범위: 로컬 쉘 분할/닫기/미니탭 전환/닫기/재정렬/패널 이동만 지원. SSH 세션 피커, quick-connect,
// 색상/이름변경, 다른 창으로 분리 등은 아직 이식 안 됨(후속 작업) — 그런 조작을 시도하면 아무 동작 없음.
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Layout } from './Layout';
import {
  LayoutNode, PanelSession, createInitialLayout, splitNode, splitNodeWithSessions, removeLeafNode,
  countLeaves, switchPanelSession, removeSessionFromPanel, reorderPanelSession,
  appendSessionsToPanel, collectAllSessions, findFirstLeafId,
} from '../utils/layoutUtils';
import {
  disposeTermFully, registerTermSession, markSuppressAutoConnect, clearSuppressAutoConnect,
  promptPasswordAndConnect, applyScrollbackToTerm, applyThemeToTerm, applyFontToTerm, refitAllTerms, focusTerm,
  setCurrentTabId, waitForTermMount, setPendingRestoreStyle, setPendingRestoreBuffer,
} from './TerminalPanel';
import { removeLeafFromTree, replaceLeaf, insertNear } from '../App';

const DEFAULT_SHELL = { name: 'Windows PowerShell', path: 'powershell.exe' };

type AskPwdItem = { termId: string; sessionId: string; hostHint?: string; userHint?: string; needUsername?: boolean; resolve: (result: any) => void; input: string; userInput: string };

type SplitSessionPickerState = {
  dir: 'row' | 'column';
  sessions: { sessionId: string; sessionName: string; host: string; termId: string; folderId?: string; icon?: string }[];
  folders: { id: string; name: string; parentId?: string }[];
  targetNodeId: string;
};

export default function TabApp({ tabId }: { tabId: string }) {
  // 자식 TerminalPanel 이 마운트되며 ensureSSHSetup/ensurePtySetup 을 호출하기 전에(useEffect 는
  // 자식이 먼저 실행되므로 여기서 하면 늦음) 동기적으로 먼저 설정 — 안 그러면 termRegisterTerm 이
  // 'host' 로 잘못 등록돼서 이 탭의 SSH/PTY 이벤트가 전부 호스트로 새버린다.
  setCurrentTabId(tabId);
  const [layout, setLayout] = useState<LayoutNode>(() => createInitialLayout(tabId));
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  // 패널 단위 프로세스 격리 (task #15) — 개발용 옵트인. 기본은 빈 Set(기존 동작 유지).
  // devtools 콘솔에서 window.__pepeIsolatePanel('<nodeId>') 로 켠다(leaf 의 data-leaf-id 참고).
  const [isolatedPanelNodeIds, setIsolatedPanelNodeIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    (window as any).__pepeIsolatePanel = (nodeId: string) => setIsolatedPanelNodeIds(prev => new Set(prev).add(nodeId));
    (window as any).__pepeUnisolatePanel = (nodeId: string) => setIsolatedPanelNodeIds(prev => { const n = new Set(prev); n.delete(nodeId); return n; });
    return () => { delete (window as any).__pepeIsolatePanel; delete (window as any).__pepeUnisolatePanel; };
  }, []);

  // 마운트 시점에 이미 존재하는(초기 기본 세션 포함) termId 를 전부 relay 라우팅 테이블에 등록.
  // 이후 handleAddSession 등에서 새로 생기는 termId 는 생성 시점에 바로 등록한다.
  useEffect(() => {
    for (const s of collectAllSessions(layout)) {
      if (s.termId) { try { (window as any).api?.termRegisterTerm?.(s.termId, tabId); } catch {} }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateLayout = useCallback((fn: (l: LayoutNode) => LayoutNode) => {
    setLayout(prev => fn(prev));
  }, []);

  // 탭 간 세션 이동(release/adopt) — host 가 다른 탭(격리 여부 무관)으로 세션을 옮길 때,
  // 이 탭이 "원본"이면 release(레이아웃에서만 제거, 백엔드/xterm 은 그대로 살려둠),
  // "대상"이면 adopt(레이아웃에 삽입 + 버퍼/스타일 복원 + termId 소유권 등록).
  useEffect(() => {
    const offRelease = (window as any).api?.onReleaseSession?.((payload: { termId: string }) => {
      const { termId } = payload;
      setLayout(l => {
        const findNodeId = (node: LayoutNode): string | null => {
          if (node.type === 'leaf') return node.panel.sessions.some(s => s.termId === termId) ? node.id : null;
          for (const c of node.children) { const r = findNodeId(c); if (r) return r; }
          return null;
        };
        const nodeId = findNodeId(l);
        if (!nodeId) return l;
        const updated = removeSessionFromPanel(l, nodeId, termId);
        return cleanEmptyLeaf(updated, nodeId);
      });
    });
    const offAdopt = (window as any).api?.onAdoptSession?.((payload: { session: PanelSession; buffer?: string; style?: any }) => {
      const { session, buffer, style } = payload;
      if (style) setPendingRestoreStyle(session.termId, style);
      if (buffer) setPendingRestoreBuffer(session.termId, buffer);
      try { (window as any).api?.termRegisterTerm?.(session.termId, tabId); } catch {}
      setLayout(l => {
        const targetLeafId = findFirstLeafId(l);
        if (!targetLeafId) return l;
        return appendSessionsToPanel(l, targetLeafId, [session], true);
      });
    });
    return () => { offRelease?.(); offAdopt?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const releaseTermResources = useCallback((termId: string) => {
    if (!termId) return;
    try { (window as any).api?.disconnectSSH?.(termId); } catch {}
    try { (window as any).api?.feReleaseSftp?.(termId); } catch {}
    setTimeout(() => { try { disposeTermFully(termId); } catch {} }, 200);
  }, []);

  const cleanEmptyLeaf = (l: LayoutNode, nodeId: string): LayoutNode => {
    if (countLeaves(l) <= 1) return l;
    const isEmpty = (node: LayoutNode): boolean =>
      node.type === 'leaf' ? (node.id === nodeId && node.panel.sessions.length === 0) : node.children.some(isEmpty);
    return isEmpty(l) ? removeLeafNode(l, nodeId) : l;
  };

  const handleSplit = useCallback((nodeId: string, dir: 'row' | 'column') => {
    updateLayout(l => splitNode(l, nodeId, dir));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  }, [updateLayout]);

  const handleClose = useCallback((targetNodeId: string) => {
    setLayout(prev => {
      const collectLeafSessions = (node: LayoutNode): PanelSession[] => {
        if (node.type === 'leaf') return node.id === targetNodeId ? [...node.panel.sessions] : [];
        return node.children.flatMap(collectLeafSessions);
      };
      if (countLeaves(prev) === 1) {
        if (prev.type === 'leaf') prev.panel.sessions.forEach(s => { if (s.termId) releaseTermResources(s.termId); });
        return prev;
      }
      const sessionsToClose = collectLeafSessions(prev);
      for (const s of sessionsToClose) if (s.termId) releaseTermResources(s.termId);
      return removeLeafNode(prev, targetNodeId);
    });
  }, [releaseTermResources]);

  const handleSwitchSession = useCallback((nodeId: string, idx: number) => {
    updateLayout(l => switchPanelSession(l, nodeId, idx));
  }, [updateLayout]);

  const handleCloseSession = useCallback((nodeId: string, termId: string) => {
    if (termId) releaseTermResources(termId);
    updateLayout(l => cleanEmptyLeaf(removeSessionFromPanel(l, nodeId, termId), nodeId));
  }, [releaseTermResources, updateLayout]);

  const handleReorderSession = useCallback((nodeId: string, fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    updateLayout(l => reorderPanelSession(l, nodeId, fromIdx, toIdx));
  }, [updateLayout]);

  const handleAddSession = useCallback((nodeId: string, shellName?: string, shellPath?: string) => {
    const termId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sess: PanelSession = {
      termId, sessionId: '', sessionName: shellName || DEFAULT_SHELL.name, shellPath: shellPath || DEFAULT_SHELL.path,
    };
    updateLayout(l => appendSessionsToPanel(l, nodeId, [sess], true));
    setSelectedPanelId(nodeId);
    try { (window as any).api?.termRegisterTerm?.(termId, tabId); } catch {}
  }, [updateLayout, tabId]);

  const movePanel = useCallback((fromPanelId: string, toPanelId: string | null, position: 'before' | 'after' | 'inside' = 'after') => {
    updateLayout(l => {
      const rr = removeLeafFromTree(l, fromPanelId);
      if (!rr.removed) return l;
      if (!toPanelId || position === 'inside') return replaceLeaf(rr.root, toPanelId ?? fromPanelId, rr.removed);
      return insertNear(rr.root, toPanelId, rr.removed, position);
    });
  }, [updateLayout]);

  // ── 비밀번호 입력 프롬프트 (App.tsx 의 ssh-password-prompt 리스너 이식) ──
  // promptPasswordAndConnect(TerminalPanel.tsx) 가 이 프로세스 자신의 window 에 커스텀 이벤트를
  // 쏘는데, App.tsx(호스트, 다른 프로세스)의 리스너는 이 프로세스 안에서는 안 잡힌다 — 여기서도
  // 직접 리스닝해야 비밀번호 입력 UI 가 뜬다(안 뜨면 연결이 영원히 대기 상태로 멈춤).
  const [askPwdPrompts, setAskPwdPrompts] = useState<AskPwdItem[]>([]);
  const [askPwdShowPass, setAskPwdShowPass] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const onAsk = (e: any) => {
      const d = e?.detail || {};
      if (typeof d.resolve !== 'function') return;
      setAskPwdPrompts(prev => {
        const filtered = prev.filter(x => x.termId !== d.termId);
        return [...filtered, { termId: d.termId, sessionId: d.sessionId, hostHint: d.hostHint, userHint: d.userHint, needUsername: !!d.needUsername, resolve: d.resolve, input: '', userInput: d.userHint || '' }];
      });
    };
    window.addEventListener('ssh-password-prompt', onAsk as any);
    return () => window.removeEventListener('ssh-password-prompt', onAsk as any);
  }, []);

  const closeAskPwd = useCallback((termId: string, password: string | null) => {
    setAskPwdPrompts(prev => {
      const target = prev.find(x => x.termId === termId);
      if (target) {
        const result = password === null ? null : (target.needUsername ? { username: target.userInput, password } : password);
        try { target.resolve(result); } catch {}
      }
      return prev.filter(x => x.termId !== termId);
    });
  }, []);
  const updateAskPwdInput = useCallback((termId: string, value: string) => {
    setAskPwdPrompts(prev => prev.map(p => p.termId === termId ? { ...p, input: value } : p));
  }, []);
  const updateAskPwdUserInput = useCallback((termId: string, value: string) => {
    setAskPwdPrompts(prev => prev.map(p => p.termId === termId ? { ...p, userInput: value } : p));
  }, []);

  // ── SSH 세션 피커 + 접속 (App.tsx 의 openSplitSessionPickerWithPrompt/handleSplitSessionSelect 이식) ──
  const [splitSessionPicker, setSplitSessionPicker] = useState<SplitSessionPickerState | null>(null);
  const [splitPickerCollapsed, setSplitPickerCollapsed] = useState<Set<string>>(new Set());

  const handleSplitWithPicker = useCallback(async (nodeId: string, dir: 'row' | 'column') => {
    try {
      const data: any = await (window as any).api?.listSessions?.();
      const sessions: any[] = data?.sessions ?? data ?? [];
      const folders: any[] = data?.folders ?? [];
      if (sessions.length === 0) { handleSplit(nodeId, dir); return; }
      setSplitPickerCollapsed(new Set());
      setSplitSessionPicker({
        dir,
        sessions: sessions.map(s => ({ sessionId: s.id, sessionName: s.name, host: s.host || '', termId: '', folderId: s.folderId, icon: s.icon })),
        folders: folders.map((f: any) => ({ id: f.id, name: f.name, parentId: f.parentId })),
        targetNodeId: nodeId,
      });
    } catch {
      handleSplit(nodeId, dir);
    }
  }, [handleSplit]);

  const handleSplitSessionSelect = useCallback(async (target: { sessionId: string; sessionName: string; host: string }) => {
    if (!splitSessionPicker) return;
    const { dir, targetNodeId } = splitSessionPicker;
    const newTermId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newSess: PanelSession = { termId: newTermId, sessionId: target.sessionId, sessionName: target.sessionName };
    let fullSess: any = null;
    try {
      const data: any = await (window as any).api?.listSessions?.();
      const all: any[] = data?.sessions ?? data ?? [];
      fullSess = all.find((s: any) => s.id === target.sessionId);
    } catch {}
    updateLayout(l => splitNodeWithSessions(l, targetNodeId, dir, [newSess], false));
    try { (window as any).api?.termRegisterTerm?.(newTermId, tabId); } catch {}
    markSuppressAutoConnect(newTermId);
    registerTermSession(newTermId, target.sessionId, target.sessionName, target.host);
    setTimeout(async () => {
      if (fullSess?.scrollback) applyScrollbackToTerm(newTermId, fullSess.scrollback);
      setTimeout(() => {
        if (fullSess?.theme) applyThemeToTerm(newTermId, fullSess.theme);
        if (fullSess?.fontFamily || fullSess?.fontSize) applyFontToTerm(newTermId, fullSess?.fontFamily, fullSess?.fontSize);
      }, 200);
      try {
        await waitForTermMount(newTermId);
        const r = await (window as any).api.connectSSH(newTermId, target.sessionId);
        if (r === 'need-password') promptPasswordAndConnect(newTermId, target.sessionId);
      } catch {}
      clearSuppressAutoConnect(newTermId);
      setTimeout(() => { refitAllTerms(); focusTerm(newTermId); }, 100);
    }, 100);
    setSplitSessionPicker(null);
  }, [splitSessionPicker, updateLayout, tabId]);

  return (
    <div style={{ width: '100%', height: '100%', background: 'transparent', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
      <Layout
        root={layout}
        isolatedPanelNodeIds={isolatedPanelNodeIds}
        ownerTabId={tabId}
        selectedPanelId={selectedPanelId}
        onSplit={handleSplit}
        onSplitWithPicker={handleSplitWithPicker}
        onClose={handleClose}
        onSelectPanel={id => setSelectedPanelId(id)}
        onMovePanel={movePanel}
        onSwitchSession={handleSwitchSession}
        onCloseSession={handleCloseSession}
        onReorderSession={handleReorderSession}
        onAddSession={handleAddSession}
      />
      {splitSessionPicker && (() => {
        const { folders, sessions } = splitSessionPicker;
        const toggleFolder = (fid: string) => {
          setSplitPickerCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(fid)) next.delete(fid); else next.add(fid);
            return next;
          });
        };
        const renderTree = (parentId: string | undefined, depth: number): ReactNode[] => {
          const rows: ReactNode[] = [];
          const subFolders = folders.filter(f => (f.parentId ?? undefined) === (parentId ?? undefined));
          for (const f of subFolders) {
            const isCollapsed = splitPickerCollapsed.has(f.id);
            rows.push(
              <div
                key={`f-${f.id}`}
                className="folder-picker-item folder-row"
                style={{ paddingLeft: 8 + depth * 16, cursor: 'pointer' }}
                onClick={() => toggleFolder(f.id)}
              >
                <span style={{ width: 14, display: 'inline-block', fontSize: 10, color: '#888' }}>{isCollapsed ? '▶' : '▼'}</span>
                📁 {f.name}
              </div>
            );
            if (!isCollapsed) rows.push(...renderTree(f.id, depth + 1));
          }
          const sessionsInFolder = sessions.filter(s => (s.folderId ?? undefined) === (parentId ?? undefined));
          for (const s of sessionsInFolder) {
            rows.push(
              <div
                key={`s-${s.sessionId}`}
                className="folder-picker-item picker-session-row"
                style={{ paddingLeft: 8 + depth * 16, position: 'relative' }}
                onClick={() => handleSplitSessionSelect(s)}
                title={s.host}
              >
                <span style={{ width: 14, display: 'inline-block' }} />
                {s.icon || '📡'} {s.sessionName}
                <span className="picker-session-host-tooltip">{s.host}</span>
              </div>
            );
          }
          return rows;
        };
        return (
          <div className="folder-picker-backdrop" onClick={() => setSplitSessionPicker(null)}>
            <div className="folder-picker" onClick={e => e.stopPropagation()}>
              <div className="folder-picker-title">{splitSessionPicker.dir === 'row' ? '가로 분할 — 세션 선택' : '세로 분할 — 세션 선택'}</div>
              <div className="folder-picker-list">{renderTree(undefined, 0)}</div>
              <div className="folder-picker-actions">
                <button onClick={() => setSplitSessionPicker(null)}>취소</button>
              </div>
            </div>
          </div>
        );
      })()}
      {askPwdPrompts.length > 0 && (() => {
        // 이 탭 안에서 살아있는 termId 만 유지 (닫힌 미니탭의 유령 모달 정리)
        const liveTermIds = new Set(collectAllSessions(layout).map(s => s.termId));
        const validPrompts = askPwdPrompts.filter(p => liveTermIds.has(p.termId));
        if (validPrompts.length !== askPwdPrompts.length) {
          setTimeout(() => setAskPwdPrompts(prev => prev.filter(p => liveTermIds.has(p.termId))), 0);
        }
        const item = validPrompts[0];
        if (!item) return null;
        const targetEl = document.querySelector(`.layout-leaf[data-active-term="${item.termId}"]`) as HTMLElement | null;
        if (!targetEl) return null;
        return createPortal(
          <div className="ask-pwd-stack">
            <div key={item.termId} className="ask-pwd-card">
              <div className="ask-pwd-header" style={{ userSelect: 'none' }}>
                <span className="ask-pwd-icon">🔐</span>
                <span className="ask-pwd-title">{item.needUsername ? '자격 증명 입력' : '비밀번호 입력'}</span>
                <button className="ask-pwd-close" title="취소" onClick={() => closeAskPwd(item.termId, null)}>✕</button>
              </div>
              <div className="ask-pwd-desc">
                {item.hostHint ? `${item.hostHint} 에 연결` : '자격 증명이 필요합니다'}
              </div>
              {item.needUsername && (
                <input
                  type="text"
                  className="save-pwd-input ask-pwd-input"
                  autoFocus
                  value={item.userInput}
                  onChange={e => updateAskPwdUserInput(item.termId, e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const card = e.currentTarget.closest('.ask-pwd-card');
                      const next = card?.querySelector<HTMLInputElement>('.ask-pwd-pass-wrap input');
                      next?.focus();
                    } else if (e.key === 'Escape') { e.preventDefault(); closeAskPwd(item.termId, null); }
                  }}
                  placeholder="username"
                  style={{ letterSpacing: 'normal' }}
                />
              )}
              <div className="ask-pwd-pass-wrap">
                <input
                  type={askPwdShowPass[item.termId] ? 'text' : 'password'}
                  className="save-pwd-input ask-pwd-input"
                  autoFocus={!item.needUsername}
                  value={item.input}
                  onChange={e => updateAskPwdInput(item.termId, e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); closeAskPwd(item.termId, item.input); }
                    else if (e.key === 'Escape') { e.preventDefault(); closeAskPwd(item.termId, null); }
                  }}
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  className="ask-pwd-eye-btn"
                  tabIndex={-1}
                  onClick={() => setAskPwdShowPass(m => ({ ...m, [item.termId]: !m[item.termId] }))}
                  title={askPwdShowPass[item.termId] ? '숨기기' : '보기'}
                >
                  {askPwdShowPass[item.termId] ? '🙈' : '👁'}
                </button>
              </div>
              <div className="ask-pwd-actions">
                <button onClick={() => closeAskPwd(item.termId, null)}>취소</button>
                <button className="primary" onClick={() => closeAskPwd(item.termId, item.input)}>연결</button>
              </div>
              {validPrompts.length > 1 && (
                <div className="ask-pwd-hint">그 외 {validPrompts.length - 1}건 대기 중</div>
              )}
            </div>
          </div>,
          targetEl,
        );
      })()}
    </div>
  );
}
