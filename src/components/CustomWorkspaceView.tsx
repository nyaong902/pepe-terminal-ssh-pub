import React, { useEffect, useMemo, useState } from 'react';
import { BrowserPane } from './BrowserPane';
import { CompareWorkspace } from './CompareWorkspace';
import { LogAnalyzer } from './LogAnalyzer';
import { VpnWorkspace } from './VpnWorkspace';
import { MicroSipWorkspace } from './MicroSipWorkspace';
import { FileExplorer } from './FileExplorer';
import { Layout } from './Layout';
import { registerTermSession, resetTermConnectState, termStore, promptPasswordAndConnect } from './TerminalPanel';
import {
  CUSTOM_WORKSPACE_KIND_ORDER,
  CUSTOM_WORKSPACE_LAYOUTS,
  gridStyleForLayout,
  type CustomWorkspaceKind,
  type CustomWorkspaceTemplate,
} from '../utils/customWorkspaces';
import {
  appendSessionsToPanel,
  countLeaves,
  createInitialLayout,
  collectAllSessions,
  removeLeafNode,
  removeSessionFromPanel,
  reorderPanelSession,
  splitNode,
  switchPanelSession,
  type LayoutNode,
  type PanelSession,
} from '../utils/layoutUtils';

type SlotState = Record<string, any>;

type SessionChoice = {
  id: string;
  sessionId: string;
  name: string;
  host?: string;
  port?: number;
  username?: string;
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
  // 사이드바 세션 목록(SessionList.tsx)과 동일한 폴더 구분을 위해 — "부모/자식" 형태 경로.
  folderPath?: string;
};

const KIND_META: Record<CustomWorkspaceKind, { label: string; icon: string }> = {
  terminal: { label: '터미널 워크스페이스', icon: '⌨️' },
  browser: { label: '브라우저 워크스페이스', icon: '🌐' },
  compare: { label: '파일 비교 워크스페이스', icon: '🔍' },
  fileTransfer: { label: '파일전송 워크스페이스', icon: '📁' },
  logAnalyzer: { label: '로그분석 워크스페이스', icon: '📊' },
  microSip: { label: 'micro SIP 워크스페이스', icon: '📞' },
  vpn: { label: 'VPN 워크스페이스', icon: '🔒' },
};

function cleanEmptyLeaf(layout: LayoutNode, nodeId: string): LayoutNode {
  if (countLeaves(layout) <= 1) return layout;
  const isEmpty = (node: LayoutNode): boolean => {
    if (node.type === 'leaf') return node.id === nodeId && node.panel.sessions.length === 0;
    return node.children.some(isEmpty);
  };
  return isEmpty(layout) ? removeLeafNode(layout, nodeId) : layout;
}

function trimSingleSessionLayout(layout: LayoutNode): LayoutNode {
  if (layout.type === 'leaf') {
    const sessions = layout.panel.sessions.length > 1 ? [layout.panel.sessions[0]] : layout.panel.sessions;
    return {
      ...layout,
      panel: {
        ...layout.panel,
        sessions,
        activeIdx: sessions.length > 0 ? 0 : 0,
      },
    };
  }
  return {
    ...layout,
    children: layout.children.map(trimSingleSessionLayout),
  };
}

function TerminalSlot({
  workspaceId,
  slotId,
  state,
  onStateChange,
  onCloseTerm,
  onConnectDrop,
  availableShells,
  sessions,
  singleSessionMode,
}: {
  workspaceId: string;
  slotId: string;
  state: any;
  onStateChange: (next: any) => void;
  onCloseTerm?: (termId: string) => void;
  onConnectDrop?: (nodeId: string, sessionId: string) => void;
  availableShells?: { name: string; path: string; icon?: string }[];
  sessions: any[];
  singleSessionMode?: boolean;
}) {
  const debugIdRef = React.useRef(`cw-term-${workspaceId}:${slotId}`);
  const emitDebugLog = (...parts: any[]) => {
    const line = parts.map(p => {
      if (typeof p === 'string') return p;
      try { return JSON.stringify(p); } catch { return String(p); }
    }).join(' ');
    try { (window as any).api?.debugLog?.(line); } catch {}
    try { console.log(line); } catch {}
  };
  const [layout, setLayout] = useState<LayoutNode>(() => state?.layout || createInitialLayout(`${workspaceId}-${slotId}`));
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(state?.selectedPanelId || null);
  const [activeSlotId, setActiveSlotId] = useState<string | null>(state?.activeSlotId || null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerNodeId, setPickerNodeId] = useState<string | null>(null);
  const [sessionQuery, setSessionQuery] = useState('');
  const [sessionChoices, setSessionChoices] = useState<SessionChoice[]>(sessions);
  const [sessionLoading, setSessionLoading] = useState(false);
  const stateRef = React.useRef<SlotState>(state || {});
  const lastEmittedRef = React.useRef<string>('');
  const openSessionPickerNonceRef = React.useRef<any>(null);
  const sessionSearchInputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    stateRef.current = state || {};
  }, [state, singleSessionMode]);

  // 세션 선택 모달이 열리면 검색 입력창에 바로 포커스 — 타이핑으로 바로 검색 가능하도록.
  useEffect(() => {
    if (!pickerOpen) return;
    const raf = window.requestAnimationFrame(() => sessionSearchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [pickerOpen]);

  useEffect(() => {
    try {
      const summary = collectAllSessions(layout).map(s => ({
        termId: s.termId,
        sessionId: s.sessionId,
        sessionName: s.sessionName,
        shellPath: s.shellPath,
      }));
      emitDebugLog('[cw-debug][terminal-slot]', debugIdRef.current, {
        singleSessionMode,
        selectedPanelId,
        activeSlotId,
        sessionCount: summary.length,
        sessions: summary,
      });
    } catch {}
  }, [layout, selectedPanelId, activeSlotId, singleSessionMode]);

  useEffect(() => {
    const next = { ...stateRef.current, layout, selectedPanelId, activeSlotId };
    const nextSig = JSON.stringify(next);
    if (nextSig === lastEmittedRef.current) return;
    lastEmittedRef.current = nextSig;
    onStateChange(next);
  }, [layout, selectedPanelId, activeSlotId, onStateChange]);

  const updateLayout = (fn: (l: LayoutNode) => LayoutNode) => setLayout(prev => {
    const next = fn(prev);
    return singleSessionMode ? trimSingleSessionLayout(next) : next;
  });

  const findFirstLeafId = (node: LayoutNode): string | null => {
    if (node.type === 'leaf') return node.id;
    for (const child of node.children) {
      const found = findFirstLeafId(child);
      if (found) return found;
    }
    return null;
  };

  const handleAddSession = (nodeId: string, shellName?: string, shellPath?: string) => {
    if (shellName || shellPath) {
      const termId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sess: PanelSession = { termId, sessionId: '', sessionName: shellName || 'Local Shell', shellPath: shellPath || 'powershell.exe' };
      updateLayout(layout => {
        function replace(node: LayoutNode): LayoutNode {
          if (node.type === 'leaf' && node.id === nodeId) {
            return { ...node, panel: { ...node.panel, sessions: [sess], activeIdx: 0 } };
          }
          if (node.type !== 'leaf') return { ...node, children: node.children.map(replace) };
          return node;
        }
        return replace(layout);
      });
      setSelectedPanelId(nodeId);
      setActiveSlotId(slotId);
      return;
    }
    setPickerNodeId(nodeId);
    setPickerOpen(true);
    setSessionQuery('');
    setSessionChoices(sessions);
    setSelectedPanelId(nodeId);
    setActiveSlotId(slotId);
  };

  useEffect(() => {
    const nonce = state?.__openSessionPickerNonce;
    if (nonce == null || nonce === openSessionPickerNonceRef.current) return;
    openSessionPickerNonceRef.current = nonce;
    const targetNodeId = selectedPanelId || findFirstLeafId(layout);
    if (targetNodeId) handleAddSession(targetNodeId);
  }, [state?.__openSessionPickerNonce, layout, selectedPanelId]);

  const handlePickSession = async (nodeId: string, session: SessionChoice) => {
    const displayName = session.name || session.id;
    const nextTermId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const oldSession = (() => {
      let found: PanelSession | null = null;
      const walk = (node: LayoutNode): void => {
        if (found) return;
        if (node.type === 'leaf' && node.id === nodeId) {
          found = (node.panel.sessions[node.panel.activeIdx] || null) as PanelSession | null;
          return;
        }
        if (node.type !== 'leaf') node.children.forEach(walk);
      };
      walk(layout);
      return found;
    })() as any;
    if (oldSession && oldSession.termId && oldSession.termId !== nextTermId) {
      try { onCloseTerm?.(oldSession.termId); } catch {}
    }
    emitDebugLog('[cw-debug][terminal-slot] pick-session', {
      workspaceId,
      slotId,
      nodeId,
      singleSessionMode,
      oldSession: oldSession ? { termId: oldSession.termId, sessionId: oldSession.sessionId, sessionName: oldSession.sessionName } : null,
      picked: { id: session.id, name: session.name, host: session.host, username: session.username },
      nextTermId,
    });
    updateLayout(cur => {
      function replace(node: LayoutNode): LayoutNode {
        if (node.type === 'leaf' && node.id === nodeId) {
          return {
            ...node,
            panel: {
              ...node.panel,
              sessions: singleSessionMode
                ? [{ termId: nextTermId, sessionId: session.id, sessionName: displayName }]
                : [{ termId: nextTermId, sessionId: session.id, sessionName: displayName }, ...node.panel.sessions.filter(s => s.termId !== oldSession?.termId)],
              activeIdx: 0,
            },
          };
        }
        if (node.type !== 'leaf') return { ...node, children: node.children.map(replace) };
        return node;
      }
      return replace(cur);
    });
    setSelectedPanelId(nodeId);
    setPickerOpen(false);
    setPickerNodeId(null);
    try {
      emitDebugLog('[cw-debug][terminal-slot] connect-ssh', { termId: nextTermId, sessionId: session.id, displayName, singleSessionMode });
      const result = await (window as any).api?.connectSSH?.(nextTermId, session.id);
      if (result === 'need-password' || result === 'need-credentials') {
        promptPasswordAndConnect(nextTermId, session.id);
      }
    } catch {}
  };

  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    (async () => {
      try {
        setSessionLoading(true);
        const data = await (window as any).api?.listSessions?.();
        const all = data?.sessions ?? data ?? [];
        const folders: any[] = Array.isArray(data?.folders) ? data.folders : [];
        if (cancelled) return;
        // 사이드바 세션 목록(SessionList.tsx)과 동일한 "부모/자식" 폴더 경로 계산.
        const folderById = new Map<string, any>(folders.map((f: any) => [f.id, f]));
        const pathCache = new Map<string, string>();
        const folderPath = (fid?: string): string => {
          if (!fid) return '';
          if (pathCache.has(fid)) return pathCache.get(fid)!;
          const f = folderById.get(fid);
          if (!f) return '';
          const parent = f.parentId ? folderPath(f.parentId) : '';
          const next = parent ? `${parent}/${f.name}` : f.name;
          pathCache.set(fid, next);
          return next;
        };
        setSessionChoices((all || []).map((s: any) => ({
          id: String(s.id),
          sessionId: String(s.id),
          name: String(s.name || s.id || 'Session'),
          host: s.host || '',
          port: s.port,
          username: s.username,
          theme: s.theme,
          fontFamily: s.fontFamily,
          fontSize: s.fontSize,
          scrollback: s.scrollback,
          folderPath: folderPath(s.folderId),
        })));
      } catch {
        if (!cancelled) setSessionChoices([]);
      } finally {
        if (!cancelled) setSessionLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pickerOpen]);

  const filteredSessionChoices = sessionChoices.filter(s => {
    const q = sessionQuery.trim().toLowerCase();
    if (!q) return true;
    return [s.name, s.host || '', s.username || '', s.id, s.folderPath || ''].some(v => String(v).toLowerCase().includes(q));
  });

  // 사이드바 세션 목록과 동일하게 폴더별로 묶어서 표시 — 폴더 없는 세션은 상단에 헤더 없이 먼저,
  // 폴더가 있는 세션은 경로별로 묶어 그 경로를 헤더로 보여준다 (경로는 가나다순 정렬).
  const groupedSessionChoices = useMemo(() => {
    const noFolder: SessionChoice[] = [];
    const byFolder = new Map<string, SessionChoice[]>();
    for (const s of filteredSessionChoices) {
      const fp = s.folderPath || '';
      if (!fp) { noFolder.push(s); continue; }
      if (!byFolder.has(fp)) byFolder.set(fp, []);
      byFolder.get(fp)!.push(s);
    }
    const folderGroups = [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return { noFolder, folderGroups };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionChoices, sessionQuery]);

  const handleSwitchSession = (nodeId: string, idx: number) => {
    if (singleSessionMode) return;
    updateLayout(layout => switchPanelSession(layout, nodeId, idx));
    setSelectedPanelId(nodeId);
  };

  const handleCloseSession = (nodeId: string, termId: string) => {
    try { onCloseTerm?.(termId); } catch {}
    updateLayout(layout => cleanEmptyLeaf(removeSessionFromPanel(layout, nodeId, termId), nodeId));
  };

  const handleRenameSession = (nodeId: string, termId: string, name: string) => {
    updateLayout(layout => {
      function walk(node: LayoutNode): LayoutNode {
        if (node.type === 'leaf' && node.id === nodeId) {
          return { ...node, panel: { ...node.panel, sessions: node.panel.sessions.map(s => s.termId === termId ? { ...s, sessionName: name } : s) } };
        }
        if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
        return node;
      }
      return walk(layout);
    });
  };

  const handleReorderSession = (nodeId: string, fromIdx: number, toIdx: number) => {
    if (singleSessionMode || fromIdx === toIdx) return;
    updateLayout(layout => reorderPanelSession(layout, nodeId, fromIdx, toIdx));
  };

  const handleSplit = (nodeId: string, dir: 'row' | 'column') => {
    updateLayout(layout => splitNode(layout, nodeId, dir));
  };

  const handleClose = (nodeId: string) => {
    const sessionsToClose = (() => {
      let found: PanelSession[] = [];
      const walk = (node: LayoutNode): void => {
        if (found.length) return;
        if (node.type === 'leaf' && node.id === nodeId) {
          found = collectAllSessions(node);
          return;
        }
        if (node.type !== 'leaf') node.children.forEach(walk);
      };
      walk(layout);
      return found;
    })();
    sessionsToClose.forEach(sess => {
      if (sess.termId) {
        try { onCloseTerm?.(sess.termId); } catch {}
      }
    });
    updateLayout(layout => cleanEmptyLeaf(removeLeafNode(layout, nodeId), nodeId));
  };

  const handleSelectPanel = (nodeId: string) => setSelectedPanelId(nodeId);

  const handleConnectDrop = (nodeId: string, sessionId: string) => {
    if (onConnectDrop && !singleSessionMode) {
      onConnectDrop(nodeId, sessionId);
      return;
    }
    const replaceLeafSessions = (root: LayoutNode, targetNodeId: string, sessions: PanelSession[]): LayoutNode => {
      function walk(node: LayoutNode): LayoutNode {
        if (node.type === 'leaf' && node.id === targetNodeId) {
          return { ...node, panel: { ...node.panel, sessions, activeIdx: 0 } };
        }
        if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
        return node;
      }
      return walk(root);
    };
    const connectWhenReady = (termId: string) => {
      let tries = 0;
      const tick = () => {
        if (termStore.has(termId)) {
          (async () => {
            try {
              const result = await (window as any).api?.connectSSH?.(termId, sessionId);
              if (result === 'need-password' || result === 'need-credentials') {
                promptPasswordAndConnect(termId, sessionId);
              }
            } catch {}
          })();
          return;
        }
        if (tries++ >= 40) {
          (async () => {
            try {
              const result = await (window as any).api?.connectSSH?.(termId, sessionId);
              if (result === 'need-password' || result === 'need-credentials') {
                promptPasswordAndConnect(termId, sessionId);
              }
            } catch {}
          })();
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    };
    (async () => {
      try {
        const data = await (window as any).api?.listSessions?.();
        const allSessions = data?.sessions ?? data ?? [];
        const session = allSessions.find((s: any) => String(s.id) === String(sessionId));
        if (!session) return;
        const displayName = session.name || sessionId;
        const findTargetSession = (root: LayoutNode, targetNodeId: string): PanelSession | null => {
          let found: PanelSession | null = null;
          const walk = (node: LayoutNode): void => {
            if (found) return;
            if (node.type === 'leaf' && node.id === targetNodeId) {
              found = (node.panel.sessions[node.panel.activeIdx] || null) as PanelSession | null;
              return;
            }
            if (node.type !== 'leaf') node.children.forEach(walk);
          };
          walk(root);
          return found;
        };
        const targetSession = findTargetSession(layout, nodeId);
        emitDebugLog('[cw-debug][terminal-slot] connect-drop', {
          workspaceId,
          slotId,
          nodeId,
          sessionId,
          singleSessionMode,
          targetSession: targetSession ? { termId: targetSession.termId, sessionId: targetSession.sessionId, sessionName: targetSession.sessionName } : null,
        });
        if (targetSession && (singleSessionMode || !targetSession.sessionId)) {
          const termId = targetSession.termId;
          resetTermConnectState(termId);
          updateLayout(cur => {
            function replace(node: LayoutNode): LayoutNode {
              if (node.type === 'leaf' && node.id === nodeId) {
                return {
                  ...node,
                  panel: {
                    ...node.panel,
                    sessions: [{ termId, sessionId, sessionName: displayName }],
                    activeIdx: 0,
                  },
                };
              }
              if (node.type !== 'leaf') return { ...node, children: node.children.map(replace) };
              return node;
            }
            return replace(cur);
          });
          registerTermSession(termId, sessionId, displayName, session.host ?? '');
          setSelectedPanelId(nodeId);
          setActiveSlotId(slotId);
          connectWhenReady(termId);
          return;
        }
        const newTermId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        updateLayout(cur => singleSessionMode
          ? replaceLeafSessions(cur, nodeId, [{ termId: newTermId, sessionId, sessionName: displayName }])
          : appendSessionsToPanel(cur, nodeId, [{ termId: newTermId, sessionId, sessionName: displayName }], true));
        registerTermSession(newTermId, sessionId, displayName, session.host ?? '');
        setSelectedPanelId(nodeId);
        setActiveSlotId(slotId);
        connectWhenReady(newTermId);
      } catch {}
    })();
  };

  return (
    <>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', height: '100%', overflow: 'hidden' }}>
        <Layout
          root={layout}
          selectedPanelId={selectedPanelId}
          onSplit={handleSplit}
          onClose={handleClose}
          onSelectPanel={handleSelectPanel}
          onSwitchSession={handleSwitchSession}
          onCloseSession={handleCloseSession}
          onRenameSession={handleRenameSession}
          onReorderSession={handleReorderSession}
          onAddSession={handleAddSession}
          onConnectDrop={handleConnectDrop}
          availableShells={availableShells}
          workspaceList={[]}
          currentWorkspaceId={workspaceId}
          singleSessionMode={singleSessionMode}
        />
      </div>
      {pickerOpen && pickerNodeId && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(3, 12, 14, 0.64)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}>
          <div style={{ width: 'min(680px, 92vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', border: '1px solid #3c6672', borderRadius: 14, background: '#081419', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ padding: '12px 14px', borderBottom: '1px solid #24454f', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ color: '#def', fontWeight: 700 }}>세션 선택</div>
              <button className="btn-add" onClick={() => { setPickerOpen(false); setPickerNodeId(null); }} style={{ padding: '5px 10px' }}>닫기</button>
            </div>
            <div style={{ padding: 12, borderBottom: '1px solid #24454f' }}>
              <input
                ref={sessionSearchInputRef}
                value={sessionQuery}
                onChange={e => setSessionQuery(e.target.value)}
                placeholder="세션 검색"
                style={{ width: '100%', border: '1px solid #2e505b', borderRadius: 8, background: '#061015', color: '#e8f7ff', padding: '10px 12px', outline: 'none' }}
              />
            </div>
            <div style={{ minHeight: 0, overflow: 'auto', padding: 10, display: 'grid', gap: 8 }}>
              {sessionLoading ? (
                <div style={{ color: '#8aa', padding: '12px 10px' }}>세션 목록을 불러오는 중...</div>
              ) : filteredSessionChoices.length === 0 ? (
                <div style={{ color: '#8aa', padding: '12px 10px' }}>선택할 세션이 없습니다.</div>
              ) : (
                <>
                  {groupedSessionChoices.noFolder.map(sess => (
                    <SessionChoiceButton key={sess.id} sess={sess} onPick={() => handlePickSession(pickerNodeId, sess)} />
                  ))}
                  {groupedSessionChoices.folderGroups.map(([folderPath, items]) => (
                    <div key={folderPath} style={{ display: 'grid', gap: 8 }}>
                      <div style={{ color: '#7fa9bb', fontSize: 11, fontWeight: 700, padding: '6px 2px 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span>📁</span><span>{folderPath}</span>
                      </div>
                      {items.map(sess => (
                        <SessionChoiceButton key={sess.id} sess={sess} onPick={() => handlePickSession(pickerNodeId, sess)} />
                      ))}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const SessionChoiceButton: React.FC<{ sess: SessionChoice; onPick: () => void }> = ({ sess, onPick }) => (
  <button
    onClick={onPick}
    style={{
      textAlign: 'left',
      border: '1px solid #2f5560',
      borderRadius: 8,
      background: '#0b1c22',
      color: '#e8f6ff',
      padding: '10px 12px',
      cursor: 'pointer',
      minHeight: 56,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: '#4dd7c8', display: 'inline-block' }} />
      <span>{sess.name}</span>
    </div>
    <div style={{ marginTop: 4, color: '#89a', fontSize: 12, paddingLeft: 16 }}>{[sess.host, sess.username].filter(Boolean).join(' @ ') || sess.id}</div>
  </button>
);

const SlotMenu: React.FC<{
  slotId: string;
  onPick: (kind: CustomWorkspaceKind) => void;
  onClose: () => void;
}> = ({ slotId, onPick, onClose }) => {
  return (
    <div style={{ position: 'absolute', right: 10, top: 44, zIndex: 150, minWidth: 240, border: '1px solid #35606d', borderRadius: 10, background: '#081419', boxShadow: '0 16px 34px rgba(0,0,0,0.45)', overflow: 'hidden' }}>
      {CUSTOM_WORKSPACE_KIND_ORDER.map(kind => (
        <button
          key={`${slotId}-${kind}`}
          onClick={() => onPick(kind)}
          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 0, background: 'transparent', color: '#e7f3ff', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.05)' }}
        >
          {KIND_META[kind].icon} {KIND_META[kind].label}
        </button>
      ))}
      <button onClick={onClose} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 0, background: '#102029', color: '#a8c9d8', cursor: 'pointer' }}>
        닫기
      </button>
    </div>
  );
};

export const CustomWorkspaceView: React.FC<{
  template: CustomWorkspaceTemplate;
  state: SlotState;
  onStateChange: (next: SlotState) => void;
  onTemplateChange: (next: CustomWorkspaceTemplate) => void;
  sessions: PanelSession[];
  connectedBrowserSessions: { panelId: string; sessionId?: string; sessionName?: string; host?: string; port?: number; browserUrl?: string }[];
  availableShells?: { name: string; path: string; icon?: string }[];
  onCloseTerm?: (termId: string) => void;
  onConnectDrop?: (nodeId: string, sessionId: string) => void;
}> = ({ template, state, onStateChange, onTemplateChange, sessions, connectedBrowserSessions, availableShells, onCloseTerm, onConnectDrop }) => {
  const [menuSlotId, setMenuSlotId] = useState<string | null>(null);
  const [slotState, setSlotState] = useState<SlotState>(() => state || {});
  const [localTemplate, setLocalTemplate] = useState<CustomWorkspaceTemplate>(template);
  const [activeSlotId, setActiveSlotId] = useState<string | null>(template.slots[0]?.id || null);
  const emitDebugLog = (...parts: any[]) => {
    const line = parts.map(p => {
      if (typeof p === 'string') return p;
      try { return JSON.stringify(p); } catch { return String(p); }
    }).join(' ');
    try { (window as any).api?.debugLog?.(line); } catch {}
    try { console.log(line); } catch {}
  };

  useEffect(() => { setLocalTemplate(template); }, [template]);
  useEffect(() => { if (template.slots.some(slot => slot.id === activeSlotId)) return; setActiveSlotId(template.slots[0]?.id || null); }, [template, activeSlotId]);
  // state(prop) ↔ slotState 는 양방향 바인딩이다: 로컬에서 바뀌면 onStateChange 로 부모에 올리고,
  // 부모가 그 값을 그대로 다시 state prop 으로 내려준다. emittedStateRef 없이 [state] 의존 effect가
  // 그 "메아리"를 곧이곧대로 다시 setSlotState 하면, 다른 슬롯(예: 브라우저 폴링)의 동시 업데이트와
  // 타이밍이 겹칠 때 방금 로컬에서 바꾼 값(예: microSip 탭 전환)이 오래된 echo 에 덮여써져
  // 탭이 계속 원래 값으로 되돌아갔다 다시 바뀌었다 하는 무한 진동이 발생했다.
  // App.tsx 의 onStateChange 는 우리가 보낸 객체를 그대로(clone 없이) 저장했다가 다시 내려주므로,
  // 참조 비교로 "내가 방금 보낸 echo" 인지 "진짜 외부 변경(예: 다른 커스텀 워크스페이스 탭으로 전환)"
  // 인지 구분할 수 있다.
  const emittedStateRef = React.useRef<SlotState | null>(null);
  useEffect(() => {
    if (state === emittedStateRef.current) return;
    setSlotState(state || {});
  }, [state]);
  useEffect(() => {
    const next = { ...(state || {}), ...slotState };
    emittedStateRef.current = next;
    onStateChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotState]);

  useEffect(() => {
    try {
      emitDebugLog('[cw-debug][workspace]', {
        id: template.id,
        name: template.name,
        layout: template.layout,
        slots: template.slots.map(slot => ({ id: slot.id, kind: slot.kind })),
        activeSlotId,
      });
    } catch {}
  }, [template.id, template.name, template.layout, template.slots, activeSlotId]);

  const updateSlotState = (slotId: string, next: any) => {
    setSlotState(prev => ({ ...prev, [slotId]: next }));
  };

  const updateSlotKind = (slotId: string, kind: CustomWorkspaceKind) => {
    const nextTemplate = {
      ...localTemplate,
      slots: localTemplate.slots.map(slot => slot.id === slotId ? { ...slot, kind } : slot),
      updatedAt: Date.now(),
    };
    setLocalTemplate(nextTemplate);
    setSlotState(prev => {
      if (!(slotId in prev)) return prev;
      const next = { ...prev };
      delete next[slotId];
      return next;
    });
    onTemplateChange(nextTemplate);
  };

  const layoutSpec = CUSTOM_WORKSPACE_LAYOUTS[localTemplate.layout];
  const allTerminalSessions = sessions;
  const compareSessions = sessions.filter(s => s.sessionId);
  const browserTargets = connectedBrowserSessions;

  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#07151a', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid #24454f', background: '#0d2229' }}>
        <div style={{ color: '#dff', fontWeight: 700 }}>{localTemplate.name}</div>
        <div style={{ color: '#89a', fontSize: 12 }}>{layoutSpec.cols} x {layoutSpec.rows}</div>
      </div>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, padding: 10 }}>
        <div style={{ display: 'grid', gap: 10, height: '100%', ...gridStyleForLayout(localTemplate.layout) }}>
          {localTemplate.slots.map(slot => {
            const kind = slot.kind;
            const slotRuntime = slotState[slot.id];
            return (
              <div
                key={slot.id}
                style={{
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                  minWidth: 0,
                  height: '100%',
                  boxSizing: 'border-box',
                  border: `1px solid ${activeSlotId === slot.id ? '#68c7ff' : '#355461'}`,
                  borderRadius: 10,
                  overflow: 'hidden',
                  background: '#08161b',
                  boxShadow: activeSlotId === slot.id ? '0 0 0 2px rgba(104,199,255,0.28) inset' : 'none',
                }}
                onMouseDownCapture={() => setActiveSlotId(slot.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px', borderBottom: '1px solid #20404b', background: activeSlotId === slot.id ? '#13313d' : '#10242b' }}>
                  <div style={{ color: '#def', fontSize: 13, fontWeight: 600 }}>
                    {kind ? `${KIND_META[kind].icon} ${KIND_META[kind].label}` : `슬롯 ${slot.id.replace('slot-', '')}`}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {kind === 'terminal' && (
                      <button
                        className="btn-add"
                        style={{ padding: '5px 10px', fontSize: 12 }}
                        onClick={e => {
                          e.stopPropagation();
                          updateSlotState(slot.id, { ...(slotRuntime || {}), __openSessionPickerNonce: Date.now() });
                        }}
                      >
                        세션 선택
                      </button>
                    )}
                    <button className="btn-add" style={{ padding: '5px 10px', fontSize: 12 }} onClick={e => { e.stopPropagation(); setMenuSlotId(slot.id); }}>
                      {kind ? '변경' : '추가'}
                    </button>
                  </div>
                </div>
                <div style={{ position: 'relative', minHeight: 0, minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
                  {/* 커스텀 워크스페이스 슬롯별 렌더 크기/종류 확인용 */}
                  {!kind && (
                    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7f9', fontSize: 13 }}>
                      추가 버튼으로 워크스페이스를 선택하세요.
                    </div>
                  )}
  {kind === 'terminal' && (
                    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', height: '100%', overflow: 'hidden' }}>
                      <TerminalSlot
                        workspaceId={template.id}
                        slotId={slot.id}
                        state={slotRuntime}
                        onStateChange={next => updateSlotState(slot.id, next)}
                        onCloseTerm={onCloseTerm}
                        onConnectDrop={onConnectDrop}
                        availableShells={availableShells}
                        sessions={sessions as any}
                        singleSessionMode
                      />
                    </div>
                  )}
                  {kind === 'browser' && (
                    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', height: '100%', overflow: 'hidden' }}>
                      <BrowserPane
                        initialUrl="https://www.google.com"
                        connectedSessions={browserTargets as any}
                        initialState={slotRuntime}
                        onStateChange={next => updateSlotState(slot.id, next)}
                        embedded
                      />
                    </div>
                  )}
                  {kind === 'compare' && (
                    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', height: '100%', overflow: 'hidden' }}>
                      <CompareWorkspace
                        sessions={compareSessions}
                        initialState={slotRuntime}
                        onStateChange={next => updateSlotState(slot.id, next)}
                      />
                    </div>
                  )}
                  {kind === 'logAnalyzer' && (
                    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', height: '100%', overflow: 'hidden' }}>
                      <LogAnalyzer
                        sessions={compareSessions}
                        initialState={slotRuntime}
                        onStateChange={next => updateSlotState(slot.id, next)}
                      />
                    </div>
                  )}
                  {kind === 'fileTransfer' && (
                    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', height: '100%', overflow: 'hidden' }}>
                      <FileExplorer
                        sessions={allTerminalSessions}
                        initialTermId={slotRuntime?.initialTermId || null}
                        initialRemotePath={slotRuntime?.initialRemotePath || null}
                        tabId={`${template.id}:${slot.id}`}
                        initialState={slotRuntime}
                        onStateChange={next => updateSlotState(slot.id, next)}
                      />
                    </div>
                  )}
                  {kind === 'microSip' && (
                    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', height: '100%', overflow: 'hidden' }}>
                      <MicroSipWorkspace
                        initialView={(slotRuntime?.microsipView || 'phones') as any}
                        onViewChange={(view) => updateSlotState(slot.id, { ...(slotRuntime || {}), microsipView: view })}
                        embedded
                      />
                    </div>
                  )}
                  {kind === 'vpn' && (
                    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', height: '100%', overflow: 'hidden' }}>
                      <VpnWorkspace />
                    </div>
                  )}
                </div>
                {menuSlotId === slot.id && (
                  <SlotMenu
                    slotId={slot.id}
                    onPick={(kind) => {
                      updateSlotKind(slot.id, kind);
                      setMenuSlotId(null);
                    }}
                    onClose={() => setMenuSlotId(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ padding: '8px 12px', borderTop: '1px solid #24454f', color: '#799', fontSize: 12 }}>
        슬롯별 워크스페이스를 섞어 배치할 수 있습니다.
      </div>
    </div>
  );
};
