// src/components/PanelHost.tsx
// 패널 단위 프로세스 분리 — 이 컴포넌트는 leaf 패널 "하나"만을 소유하는, 별도
// WebContentsView 프로세스에서 로드되는 진입점이다 (electron/main.ts 가
// '#panel-app?tabId=X&nodeId=Y&panel=<json>' 해시로 이 번들을 로드 — src/main.tsx 참고).
//
// TerminalPanel.tsx 는 전혀 수정하지 않고 그대로 재사용한다 — 이 프로세스가 통째로
// TerminalPanel 하나를 마운트해서 xterm 마운트/SSH/PTY 로직을 100% 기존 코드로 처리하고,
// 세션 전환/추가/닫기만 이 프로세스 안에서 로컬로 처리한다(TabApp 쪽 트리 사본은 v1에서는
// 갱신되지 않음 — 격리 해제나 탭 종료 시에만 최신 상태가 필요 없을 만큼 충분한 근사치).
import { useCallback, useState } from 'react';
import { TerminalPanel, disposeTermFully, setCurrentTabId } from './TerminalPanel';
import type { Panel, PanelSession } from '../utils/layoutUtils';

const DEFAULT_SHELL = { name: 'Windows PowerShell', path: 'powershell.exe' };

export default function PanelHost({ nodeId, initialPanel }: { tabId: string; nodeId: string; initialPanel: Panel }) {
  // TerminalPanel 이 마운트되며 ensureSSHSetup/ensurePtySetup 을 호출하기 전에 동기적으로 설정
  // (같은 이유로 TabApp.tsx 에서도 렌더 시작 시 바로 호출함).
  setCurrentTabId(`panel:${nodeId}`);
  const [panel, setPanel] = useState<Panel>(initialPanel);

  const releaseTermResources = useCallback((termId: string) => {
    if (!termId) return;
    try { (window as any).api?.disconnectSSH?.(termId); } catch {}
    try { (window as any).api?.feReleaseSftp?.(termId); } catch {}
    setTimeout(() => { try { disposeTermFully(termId); } catch {} }, 200);
  }, []);

  const onSwitchSession = useCallback((_nid: string, idx: number) => {
    setPanel(p => ({ ...p, activeIdx: idx }));
  }, []);

  const onCloseSession = useCallback((_nid: string, termId: string) => {
    releaseTermResources(termId);
    setPanel(p => {
      const idx = p.sessions.findIndex(s => s.termId === termId);
      if (idx < 0) return p;
      const sessions = p.sessions.filter(s => s.termId !== termId);
      if (sessions.length === 0) return { ...p, sessions };
      const activeIdx = Math.min(p.activeIdx, sessions.length - 1);
      return { ...p, sessions, activeIdx };
    });
  }, [releaseTermResources]);

  const onReorderSession = useCallback((_nid: string, fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    setPanel(p => {
      const sessions = [...p.sessions];
      const [moved] = sessions.splice(fromIdx, 1);
      sessions.splice(toIdx, 0, moved);
      return { ...p, sessions, activeIdx: toIdx };
    });
  }, []);

  const onAddSession = useCallback((_nid: string, shellName?: string, shellPath?: string) => {
    const termId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sess: PanelSession = {
      termId, sessionId: '', sessionName: shellName || DEFAULT_SHELL.name, shellPath: shellPath || DEFAULT_SHELL.path,
    };
    setPanel(p => ({ ...p, sessions: [...p.sessions, sess], activeIdx: p.sessions.length }));
    try { (window as any).api?.termRegisterTerm?.(termId, `panel:${nodeId}`); } catch {}
  }, [nodeId]);

  return (
    <div style={{ width: '100%', height: '100%', background: 'transparent', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
      <TerminalPanel
        nodeId={nodeId}
        panel={panel}
        onSplit={() => {}}
        onClose={() => {}}
        onSwitchSession={onSwitchSession}
        onCloseSession={onCloseSession}
        onReorderSession={onReorderSession}
        onAddSession={onAddSession}
      />
    </div>
  );
}
