// src/components/FileExplorer.tsx
import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePanel, PanelSource } from './FilePanel';
import { TransferLog } from './TransferLog';
import { setTermFocusBlocked, isTermConnected } from './TerminalPanel';
import { notifyError } from './Notify';
import type { PanelSession } from '../utils/layoutUtils';
import {
  type FeTab, type FePanel, type FeLayoutNode,
  makeFeTab, createInitialFeLayout, splitFeNode, removeFeLeafNode, updateFeLeafPanel,
  countFeLeaves, findFirstFeLeafId, collectFeLeaves, findFeTabByTermId, mapAllFeTabs,
  setFeContainerSizes, serializeFeLayout, reviveFeLayout, isLiveBackendConnId,
  consumePreservedFeConnId,
} from '../utils/feLayoutUtils';
import { makeId } from '../utils/layoutUtils';

const api = (window as any).api || {};

// 세션의 점프 체인을 SFTP 연결용 배열로 정규화. host 있는 항목만, 첫 빈 host 에서 종료.
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

type Props = {
  sessions: PanelSession[];
  initialTermId?: string | null;
  // 파일 전송 탭을 열 때 활성 SSH 세션의 현재 pwd — 있으면 홈 대신 이 경로로 우측 패널을 연다.
  initialRemotePath?: string | null;
  // 이 FileExplorer 가 속한 워크스페이스 탭 id — 세션→파일전송 연결 이벤트를 이 탭으로만 라우팅.
  tabId?: string;
  // 새 창으로 분리/병합 시 레이아웃 트리 복원용 스냅샷.
  initialState?: { layout?: any; selectedLeafId?: string; lazyConns?: string[] } | null;
  // 상태가 바뀔 때마다 부모(App.tsx)에 보고 — 분리 시 직렬화하기 위해.
  onStateChange?: (state: { layout: any; selectedLeafId: string; lazyConns: string[] }) => void;
  // true면 "이미 연결된 세션 중 첫 번째를 자동으로 연결"하는 로직을 건너뜀.
  // 세션 우클릭 "파일전송"처럼 fe-sftp-connected 이벤트로 명시적 연결이 곧 도착하는 경우 사용 —
  // 아니면 그 명시적 연결과 별개로 다른(관련 없는) 세션이 함께 자동 연결돼버린다.
  suppressAutoSelect?: boolean;
};

export const FileExplorer: React.FC<Props> = ({ sessions, initialTermId, initialRemotePath, tabId, initialState, onStateChange, suppressAutoSelect }) => {
  // 이 FileExplorer 인스턴스의 고유 ID — 전송 이벤트 필터링에 사용
  const workspaceIdRef = React.useRef(`fe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const { t } = useTranslation('fileExplorer');
  const [bootReady, setBootReady] = useState(false);
  const localLabel = t('local');
  const [sources, setSources] = useState<PanelSource[]>([{ mode: 'local', label: localLabel }]);

  // 패널 레이아웃 — 상하좌우로 자유롭게 분할되는 트리(터미널 세션의 Layout 과 동일한 구조).
  // 최초 1회 계산 값을 layout/selectedLeafId 두 state 가 같이 참조해야 하므로 ref 에 담아 공유.
  const initialLayoutRef = useRef<FeLayoutNode | null>(null);
  if (!initialLayoutRef.current) {
    // "살아있는 연결" 판정에 isTermConnected 만 쓰면 안 된다 — 파일전송이 직접 맺는 SFTP 전용
    // 연결(fe-lazy-…/sftp-…)은 인터랙티브 터미널이 아니라 항상 false 로 나와서, 창을 분리/복원할
    // 때마다 살아있는 연결까지 강등돼 전부 재연결 + 파일목록 재로딩이 됐다. 백엔드가 알려준
    // 실제 생존 목록(isLiveBackendConnId)도 함께 본다.
    const isLive = (tid: string) => isTermConnected(tid) || isLiveBackendConnId(tid);
    initialLayoutRef.current = reviveFeLayout(initialState?.layout, localLabel, isLive) || createInitialFeLayout(localLabel);
    // 재연결이 필요해진 소스가 있으면 그 개수만 남긴다 — 정상 분리/복원에서는 0 이어야 한다.
    // (0 이 아니면 살아있어야 할 연결이 끊긴 것이므로 조사 시작점이 된다.)
    if (initialState?.layout) {
      try {
        const demoted = collectFeLeaves(initialLayoutRef.current)
          .flatMap(l => l.panel.tabs).filter(tb => tb.source.mode === 'lazy-remote').length;
        if (demoted > 0) console.log('[fe-revive] 재연결 필요한 소스', demoted, '개 —', tabId);
      } catch {}
    }
  }
  const [layout, setLayout] = useState<FeLayoutNode>(() => initialLayoutRef.current!);
  const [selectedLeafId, setSelectedLeafId] = useState<string>(() => {
    const initial = initialLayoutRef.current!;
    const saved = initialState?.selectedLeafId;
    return (saved && collectFeLeaves(initial).some(l => l.id === saved)) ? saved : (findFirstFeLeafId(initial) || '');
  });
  const layoutRef = useRef<FeLayoutNode>(layout);
  useEffect(() => { layoutRef.current = layout; });
  const selectedLeafIdRef = useRef(selectedLeafId);
  useEffect(() => { selectedLeafIdRef.current = selectedLeafId; }, [selectedLeafId]);

  const getLeaf = (leafId: string) => collectFeLeaves(layoutRef.current).find(l => l.id === leafId) || null;
  // 한 leaf 의 panel 을 갱신
  const updatePanel = (leafId: string, updater: (p: FePanel) => FePanel) => {
    setLayout(prev => updateFeLeafPanel(prev, leafId, updater));
  };
  const setLeafSource = (leafId: string, s: PanelSource) =>
    updatePanel(leafId, p => ({ ...p, tabs: p.tabs.map((t, i) => i === p.activeIdx ? { ...t, source: s } : t) }));
  const setLeafPath = (leafId: string, path: string) =>
    updatePanel(leafId, p => ({ ...p, tabs: p.tabs.map((t, i) => i === p.activeIdx ? { ...t, path } : t) }));
  const setLeafSelected = (leafId: string, sel: Set<string>) =>
    updatePanel(leafId, p => ({ ...p, tabs: p.tabs.map((t, i) => i === p.activeIdx ? { ...t, selected: sel } : t) }));
  // 로드된 목록을 활성 탭에 캐싱 — 창 분리/재합침으로 재마운트될 때 initialFiles 로 즉시 표시하기 위함.
  const setLeafEntries = (leafId: string, entries: any[]) =>
    updatePanel(leafId, p => ({ ...p, tabs: p.tabs.map((t, i) => i === p.activeIdx ? { ...t, entries } : t) }));

  const [initDone, setInitDone] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // 패널 탭 스트립(.fe-panel-tabs-scroll)이 넘칠 때만 ‹ › 스크롤 버튼을 노출한다 — 워크스페이스
  // 탭바(TabBar.tsx)와 같은 UX. leaf 마다 스트립이 하나씩이라 leafId 로 키를 잡는다.
  const feTabScrollEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const feTabsRO = useRef<ResizeObserver | null>(null);
  const [feTabsOverflow, setFeTabsOverflow] = useState<Record<string, boolean>>({});
  const measureFeTabsOverflow = React.useCallback(() => {
    setFeTabsOverflow(prev => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const [id, el] of feTabScrollEls.current) {
        next[id] = el.scrollWidth > el.clientWidth + 1;
        if (prev[id] !== next[id]) changed = true;
      }
      // 사라진 leaf 의 키가 남아있어도 changed 로 잡아 정리
      if (!changed && Object.keys(prev).length !== Object.keys(next).length) changed = true;
      return changed ? next : prev;
    });
  }, []);
  const setFeTabScrollRef = (leafId: string) => (el: HTMLDivElement | null) => {
    const map = feTabScrollEls.current;
    const prev = map.get(leafId);
    if (prev === el) return;
    if (prev) { try { feTabsRO.current?.unobserve(prev); } catch {} }
    if (el) { map.set(leafId, el); try { feTabsRO.current?.observe(el); } catch {} }
    else map.delete(leafId);
  };
  useEffect(() => {
    const ro = new ResizeObserver(() => measureFeTabsOverflow());
    feTabsRO.current = ro;
    for (const el of feTabScrollEls.current.values()) { try { ro.observe(el); } catch {} }
    window.addEventListener('resize', measureFeTabsOverflow);
    return () => { ro.disconnect(); feTabsRO.current = null; window.removeEventListener('resize', measureFeTabsOverflow); };
  }, [measureFeTabsOverflow]);
  // 탭 추가/삭제/라벨변경은 컨테이너 크기를 안 바꿔서 ResizeObserver 가 안 뜬다 — 레이아웃이
  // 바뀔 때마다 직접 다시 잰다.
  useEffect(() => { measureFeTabsOverflow(); }, [layout, measureFeTabsOverflow]);
  // initialState 로 시작했으면(분리 창에서 복원) 자동 원격 연결 effect 비활성 — 복원 상태 우선.
  const autoConnectDoneRef = React.useRef<boolean>(!!suppressAutoSelect || !!initialState?.layout);
  const [showSftpConnect, setShowSftpConnect] = useState<string | null>(null); // leafId
  const [sftpHost, setSftpHost] = useState('');
  const [sftpPort, setSftpPort] = useState(22);
  const [sftpUser, setSftpUser] = useState('');
  const [sftpPass, setSftpPass] = useState('');
  const [sftpConnecting, setSftpConnecting] = useState(false);
  const [transfersHeight, setTransfersHeight] = useState(() => {
    const saved = localStorage.getItem('feTransfersHeight');
    return saved ? Number(saved) : 200;
  });
  const resizing = React.useRef<{ startY: number; startH: number } | null>(null);
  // 세션 ID → 폴더 이름 매핑 (드롭다운 label 에 폴더 접두사 붙이기용)
  const [sessionFolderMap, setSessionFolderMap] = useState<Record<string, string>>({});
  // 전체 세션 리스트 (드롭다운 확장용 — 미연결 포함)
  const [allSessionsList, setAllSessionsList] = useState<any[]>([]);
  // lazy 연결로 생성된 SFTP 임시 connId — FileExplorer unmount 시 정리
  const [lazyConns, setLazyConns] = useState<string[]>(Array.isArray(initialState?.lazyConns) ? initialState!.lazyConns! : []);
  // 자격증명 입력 프롬프트 — 비밀번호 미저장 세션 연결 실패 시 표시
  // tabId — 자격증명 재입력 대상 탭. 병합으로 한 leaf 에 여러 세션 탭이 모일 수 있으므로, 완료 후
  // "활성 탭"이 아니라 정확히 이 탭에만 결과를 써야 한다(안 그러면 다른 세션 탭이 덮어써진다).
  const [credPrompt, setCredPrompt] = useState<{ sess: any; leafId: string; tabId?: string; jumps: any[] } | null>(null);
  const [credUser, setCredUser] = useState('');
  const [credPass, setCredPass] = useState('');
  const [credShowPass, setCredShowPass] = useState(false);
  const [credConnecting, setCredConnecting] = useState(false);
  const credUserInputRef = useRef<HTMLInputElement>(null);
  const credModalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => setBootReady(true));
    return () => window.cancelAnimationFrame(raf);
  }, []);
  // useLayoutEffect — DOM 커밋 직후(브라우저 페인트 이전)에 실행되어
  // 어떤 포스트-렌더 포커스 이벤트보다 먼저 input 을 확보
  useLayoutEffect(() => {
    if (!credPrompt) {
      setTermFocusBlocked(false);
      return;
    }
    // DOM 커밋 직후 즉시 포커스
    credUserInputRef.current?.focus();

    // 추가 보강: focusin capture 로 모달 외부 포커스를 input 으로 리다이렉트
    const trap = (e: FocusEvent) => {
      const modal = credModalRef.current;
      const input = credUserInputRef.current;
      if (!modal || !input) return;
      if (!modal.contains(e.target as Node)) {
        e.stopImmediatePropagation();
        input.focus();
      }
    };
    document.addEventListener('focusin', trap, true);
    return () => {
      document.removeEventListener('focusin', trap, true);
    };
  }, [credPrompt]);

  useEffect(() => {
    if (!bootReady) return;
    let cancelled = false;
    const load = async () => {
      try {
        const data: any = await api.listSessions?.();
        if (cancelled) return;
        const allSessions: any[] = data?.sessions ?? [];
        const folders: any[] = data?.folders ?? [];
        setAllSessionsList(allSessions);
        const folderById: Record<string, any> = {};
        for (const f of folders) folderById[f.id] = f;
        const folderPath = (fid?: string): string => {
          if (!fid) return '';
          const f = folderById[fid];
          if (!f) return '';
          const parent = folderPath(f.parentId);
          return parent ? `${parent}/${f.name}` : f.name;
        };
        const map: Record<string, string> = {};
        for (const s of allSessions) map[s.id] = folderPath(s.folderId);
        setSessionFolderMap(map);
      } catch {}
    };
    load();
    return () => { cancelled = true; };
  }, [sessions.length, bootReady]);

  // 항상 최신 lazyConns 를 들고 있는 ref — 아래 언마운트 cleanup 이 "진짜 언마운트" 때만
  // 최신 목록으로 정리하도록 함(다음 주석 참고).
  const lazyConnsRef = useRef<string[]>(lazyConns);
  useEffect(() => { lazyConnsRef.current = lazyConns; }, [lazyConns]);
  // 언마운트 시 lazy 연결 정리 — 다만 "새 창 분리" 케이스에서는 보존(window.__preserveFileExplorerConns).
  // 버그 수정: deps 에 lazyConns 를 직접 넣으면, 연결을 하나 더 추가할 때마다(배열 참조 변경)
  // "새 effect 적용 전 이전 effect의 cleanup"이 실행되어 그 순간의 lazyConns(추가 전 목록)를
  // 통째로 disconnect 해버린다 — 즉 두 번째 파일전송 연결을 열 때마다 첫 번째 연결이 끊기는
  // 버그였다(병합으로 연속 연결할 때 실사용 중 재현: 두 번째 서버를 합치자 첫 번째 서버가
  // "연결되지 않음" 에러로 끊김). deps 를 [bootReady] 로 고정해 이 effect가 실제 언마운트
  // 때만 cleanup 을 실행하도록 하고, 정리 시점엔 ref 로 항상 최신 lazyConns 를 읽는다.
  useEffect(() => {
    if (!bootReady) return;
    return () => {
      if ((window as any).__preserveFileExplorerConns) return;
      for (const cid of lazyConnsRef.current) {
        // 분리로 다른 창이 그대로 이어받는 연결은 끊지 않는다. 전역 플래그만으로는 React 18 이
        // 언마운트를 스케줄러 태스크로 미룰 때 플래그가 먼저 꺼져버리는 레이스가 있어서(그러면
        // 새 창이 쓰려던 연결을 여기서 끊어 전부 재연결됐다) connId 단위로 명시 등록된 목록도 본다.
        if (consumePreservedFeConnId(cid)) continue;
        try { api?.feSftpDisconnect?.(cid); } catch {}
      }
    };
  }, [bootReady]);
  // 상태 변경 시 부모(App.tsx)에 보고 — 분리 시 사용. selected 는 Set → Array 로 직렬화.
  useEffect(() => {
    if (!bootReady) return;
    if (!onStateChange) return;
    try {
      onStateChange({ layout: serializeFeLayout(layout), selectedLeafId, lazyConns });
    } catch {}
  }, [layout, selectedLeafId, lazyConns, onStateChange, bootReady]);

  // 초기 경로
  useEffect(() => {
    if (!bootReady) return;
    (async () => {
      try {
        const home = await api?.feGetHome?.();
        if (home) {
          // initialState 로 복원된 상태에서는 저장된 path 를 덮어쓰지 않는다.
          const hasRestoredState = !!initialState?.layout;
          if (!hasRestoredState) {
            const soleLeafId = findFirstFeLeafId(layoutRef.current);
            if (soleLeafId) setLeafPath(soleLeafId, home);
          }
        }
      } catch {}
      setInitDone(true);
    })();
  }, [bootReady]);

  // 새 세션 탭을 열 대상 leaf 결정 후 추가.
  // leaf 가 1개뿐이면(가장 흔한 "기본 로컬 하나"인 상태) 자동으로 분할해 새 세션을 옆에 띄우고,
  // 이미 여러 leaf 로 나뉜 복잡한 배치라면 사용자가 마지막으로 선택한 leaf 에 탭으로 추가한다.
  const openNewSessionTab = (tab: FeTab) => {
    const leaves = collectFeLeaves(layoutRef.current);
    if (leaves.length === 1) {
      const newId = makeId('fenode');
      setLayout(prev => splitFeNode(prev, leaves[0].id, 'row', localLabel, false, newId));
      setLayout(prev => updateFeLeafPanel(prev, newId, p => ({ ...p, tabs: [tab], activeIdx: 0 })));
      setSelectedLeafId(newId);
    } else {
      const target = (selectedLeafIdRef.current && leaves.some(l => l.id === selectedLeafIdRef.current))
        ? selectedLeafIdRef.current : leaves[leaves.length - 1].id;
      updatePanel(target, p => ({ ...p, tabs: [...p.tabs, tab], activeIdx: p.tabs.length }));
      setSelectedLeafId(target);
    }
  };

  // 파일 전송 탭에서 세션 더블클릭으로 SFTP 연결된 이벤트 수신
  useEffect(() => {
    if (!bootReady) return;
    const handler = async (e: Event) => {
      const { connId, sessionName, host, feTabId, sessionId } = (e as CustomEvent).detail;
      // 특정 파일 전송 탭을 대상으로 한 이벤트면 그 탭의 인스턴스만 처리 (중복 추가 방지)
      if (feTabId && tabId && feTabId !== tabId) return;
      // 이미 추가된 연결이면 무시
      if (findFeTabByTermId(layoutRef.current, connId)) return;
      const sameNameCount = sources.filter(s => s.label?.includes(sessionName)).length;
      const num = sameNameCount + 1;
      const label = `🌐 ${sessionName} #${num} (${host})`;
      // sessionId 를 안 넣으면 창 분리/파일전송 탭 병합 시 이 연결을 재구성할 방법이 없어 유실된다.
      const newSrc: PanelSource = { mode: 'remote', termId: connId, sessionId: sessionId || undefined, label };
      // 소스 드롭다운 목록에도 추가
      setSources(prev => {
        if (prev.find(s => s.termId === connId)) return prev;
        const idx = prev.findIndex(s => (s.mode as any) === 'sftp-connect');
        const arr = [...prev];
        if (idx >= 0) arr.splice(idx, 0, newSrc); else arr.push(newSrc);
        return arr;
      });
      // 홈 경로 확보 후 탭 생성/활성화
      const home = await getHomeWithRetry('remote', connId);
      openNewSessionTab(makeFeTab(newSrc, home));
    };
    window.addEventListener('fe-sftp-connected', handler);
    return () => window.removeEventListener('fe-sftp-connected', handler);
  }, [bootReady]);

  // 이미 열린 파일 전송 워크스페이스에서, 터미널의 "파일전송" 버튼/단축키로 활성 세션을 여는 이벤트 수신
  // (fe-sftp-connected 와 달리 별도 SFTP 연결을 새로 만들지 않고, 이미 연결된 터미널의 SSH 세션을 그대로 재사용)
  useEffect(() => {
    if (!bootReady) return;
    const handler = async (e: Event) => {
      const { termId: tid, remotePath, feTabId } = (e as CustomEvent).detail || {};
      if (!tid) return;
      // 특정 파일 전송 탭을 대상으로 한 이벤트면 그 탭의 인스턴스만 처리
      if (feTabId && tabId && feTabId !== tabId) return;
      // 이미 그 세션이 열려있으면 새로 만들지 않고 그 탭으로 포커스만 이동
      const existing = findFeTabByTermId(layoutRef.current, tid);
      if (existing) {
        setSelectedLeafId(existing.leafId);
        updatePanel(existing.leafId, p => ({ ...p, activeIdx: existing.idx }));
        if (remotePath && remotePath.trim() && remotePath !== '/') {
          updatePanel(existing.leafId, p => ({
            ...p, tabs: p.tabs.map((t, i) => i === existing.idx ? { ...t, path: remotePath.trim() } : t),
          }));
        }
        return;
      }
      const sess = sessions.find(s => s.termId === tid);
      const label = sess ? `🌐 ${sess.sessionName}` : `🌐 ${tid}`;
      const newSrc: PanelSource = { mode: 'remote', termId: tid, sessionId: sess?.sessionId, label };
      const path = (remotePath && remotePath.trim() && remotePath !== '/') ? remotePath.trim() : await getHomeWithRetry('remote', tid);
      openNewSessionTab(makeFeTab(newSrc, path));
    };
    window.addEventListener('fe-open-session', handler);
    return () => window.removeEventListener('fe-open-session', handler);
  }, [sessions, bootReady]);

  // 빠른 연결 바에서 들어오는 SFTP 직접 연결 요청 처리
  useEffect(() => {
    if (!bootReady) return;
    const handler = async (ev: any) => {
      const info = ev.detail || {};
      if (!info.host || !info.username) return;
      // 특정 파일 전송 탭 대상이면 그 인스턴스만 처리
      if (info.feTabId && tabId && info.feTabId !== tabId) return;
      const connId = `sftp-${Date.now()}`;
      try {
        const manualConn = { host: info.host, port: Number(info.port) || 22, username: info.username, password: info.auth?.password ?? '' };
        const result = await api.feSftpConnect?.(connId, info.host, manualConn.port, info.username, { type: 'password', password: manualConn.password });
        if (!result?.success) { notifyError(t('connectFail', { err: result?.error || t('unknownError') })); return; }
        if (findFeTabByTermId(layoutRef.current, connId)) return;
        const newSrc: PanelSource = { mode: 'remote', termId: connId, label: `🔌 ${info.username}@${info.host}`, manualConn };
        setSources(prev => {
          if (prev.find(s => s.termId === connId)) return prev;
          const idx = prev.findIndex(s => (s.mode as any) === 'sftp-connect');
          const arr = [...prev];
          if (idx >= 0) arr.splice(idx, 0, newSrc); else arr.push(newSrc);
          return arr;
        });
        let home = '/';
        try { home = (await api.feHomeDir('remote', connId)) || '/'; } catch {}
        openNewSessionTab(makeFeTab(newSrc, home));
      } catch (err: any) { notifyError(t('connectFail', { err })); }
    };
    window.addEventListener('fe-quick-sftp-connect', handler);
    return () => window.removeEventListener('fe-quick-sftp-connect', handler);
  }, [bootReady]);

  // sessions prop 변경 시 소스 목록 갱신
  const sessKey = sessions.map(s => s.termId).join(',');
  useEffect(() => {
    if (!bootReady) return;
    const newSources: PanelSource[] = [{ mode: 'local', label: localLabel }];
    // 이미 터미널로 연결된 세션의 sessionId
    const connectedSessionIds = new Set(sessions.map(s => s.sessionId).filter(Boolean));
    // 1) 이미 연결된 세션을 먼저 🟢 로 추가
    for (const sess of sessions) {
      const folder = sessionFolderMap[sess.sessionId];
      const label = folder ? `🟢 ${sess.sessionName}  [${folder}]` : `🟢 ${sess.sessionName}`;
      newSources.push({ mode: 'remote', termId: sess.termId, sessionId: sess.sessionId, label });
    }
    // 2) 미연결 세션을 ⚪ (lazy-remote) 로 추가 — 선택 시 자동 백그라운드 SFTP 연결
    for (const s of allSessionsList) {
      if (connectedSessionIds.has(s.id)) continue;
      const folder = sessionFolderMap[s.id];
      const label = folder ? `⚪ ${s.name}  [${folder}] (${s.host})` : `⚪ ${s.name} (${s.host})`;
      newSources.push({ mode: 'lazy-remote', sessionId: s.id, label });
    }
    // 3) 기존 SFTP 직접 연결 유지 — 수동(🔌, termId=sftp-…) + 세션 우클릭 파일전송(🌐,
    //    termId=sftp-fe-…) + lazy-remote 를 자동/수동으로 실제 연결한 것(termId=fe-lazy-…,
    //    realizeLazyRemote 참고) 모두 sessions/allSessionsList 로 재현되지 않으므로 재구성 시
    //    명시적으로 보존해야 한다 — 안 그러면 다른 탭에 갔다 돌아오는 등으로 이 effect 가 다시
    //    실행될 때마다 드롭다운에서 사라지거나 lazy-remote(미연결) 로 되돌아가 보인다.
    for (const s of sources) {
      if (s.mode === 'remote' && typeof s.termId === 'string' && (s.termId.startsWith('sftp') || s.termId.startsWith('fe-lazy-'))
          && !newSources.find(n => n.termId === s.termId)) {
        newSources.push(s);
      }
    }
    newSources.push({ mode: 'sftp-connect' as any, label: t('sftpDirectOption') });
    setSources(newSources);
    // 최초 1회만: 원격 소스가 있으면 자동으로 세션을 연결한다.
    // initialTermId 가 있으면 해당 세션 우선, 없으면 첫 번째 세션. leaf 가 1개뿐이면 분할해서 옆에 연다.
    if (initDone && sessions.length > 0 && !autoConnectDoneRef.current) {
      autoConnectDoneRef.current = true;
      const first = (initialTermId ? sessions.find(s => s.termId === initialTermId) : null) || sessions[0];
      // sessionId 를 빠뜨리면(터미널 인스턴스 termId만 있으면) 창 분리/파일전송 탭 병합 시 이
      // 소스를 재연결할 방법이 없어 그대로 유실된다 — 저장된 세션이면 반드시 같이 넣는다.
      const newSrc: PanelSource = { mode: 'remote', termId: first.termId, sessionId: first.sessionId || undefined, label: `🌐 ${first.sessionName}` };
      const leaves = collectFeLeaves(layoutRef.current);
      let targetLeafId: string;
      if (leaves.length === 1) {
        targetLeafId = makeId('fenode');
        setLayout(prev => splitFeNode(prev, leaves[0].id, 'row', localLabel, false, targetLeafId));
      } else {
        targetLeafId = (selectedLeafIdRef.current && leaves.some(l => l.id === selectedLeafIdRef.current))
          ? selectedLeafIdRef.current : leaves[leaves.length - 1].id;
      }
      setLayout(prev => updateFeLeafPanel(prev, targetLeafId, p => ({ ...p, tabs: [makeFeTab(newSrc)], activeIdx: 0 })));
      setSelectedLeafId(targetLeafId);
      // initialRemotePath(활성 SSH 세션의 현재 pwd) 가 있으면 그 경로로, 없으면 홈 디렉토리로 연다.
      const initPath = (initialRemotePath && initialRemotePath.trim() && initialRemotePath !== '/') ? initialRemotePath.trim() : '';
      if (initPath) {
        // SFTP 준비 보장 후 경로 적용 — feHomeDir 로 연결을 establish/대기한 뒤 initPath 로 이동.
        // (연결 직후 곧장 listDir 하면 SFTP 서브시스템 미준비로 에러나는 케이스 회피)
        (async () => {
          for (let i = 0; i < 10; i++) {
            try { const h = await api?.feHomeDir?.('remote', first.termId); if (h) break; } catch {}
            await new Promise(r => setTimeout(r, 500));
          }
          setLeafPath(targetLeafId, initPath);
        })();
      } else {
        // SSH 연결 완료 대기 후 홈 디렉토리 가져오기 (최대 10초)
        const tryGetHome = async (retries: number) => {
          for (let i = 0; i < retries; i++) {
            try {
              const home = await api?.feHomeDir?.('remote', first.termId);
              if (home && home !== '/') { setLeafPath(targetLeafId, home); return; }
            } catch {}
            await new Promise(r => setTimeout(r, 1000));
          }
          setLeafPath(targetLeafId, '/');
        };
        tryGetHome(10);
      }
    }
  }, [sessKey, initDone, sessionFolderMap, allSessionsList, bootReady]);

  const sep = (source: PanelSource) => source.mode === 'local' && navigator.platform.startsWith('Win') ? '\\' : '/';

  const getHomeWithRetry = async (mode: string, termId?: string): Promise<string> => {
    for (let i = 0; i < 5; i++) {
      try {
        const home = await api?.feHomeDir?.(mode, termId);
        if (home && home !== '/') return home;
      } catch {}
      if (mode === 'local') break;
      await new Promise(r => setTimeout(r, 1000));
    }
    return mode === 'local' ? 'C:\\' : '/';
  };

  // lazy-remote 소스를 실제 연결된 remote 소스로 변환. 실패 시 null 반환.
  // 연결 실패(인증 오류 등) → 자격증명 입력 다이얼로그 표시.
  // forTabId — 자격증명 다이얼로그로 넘어가는 경우, 완료 후 결과를 써야 할 탭. 병합으로 한 leaf 에
  // 여러 세션 탭이 모일 수 있어서 "활성 탭"에 쓰면 엉뚱한 세션 탭이 덮어써진다.
  const realizeLazyRemote = async (src: PanelSource, leafId: string, forTabId?: string): Promise<PanelSource | null> => {
    if (src.mode !== 'lazy-remote') return null;
    // 세션 저장이 안 된 즉석 SFTP 연결(manualConn 만 있고 sessionId 없음) — 자격증명이 이미
    // 있으므로 자격증명 다이얼로그 없이 바로 연결한다.
    if (!src.sessionId && src.manualConn) {
      const { host, port, username, password } = src.manualConn;
      const connId = `sftp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        const r: any = await api?.feSftpConnect?.(connId, host, port || 22, username, { type: 'password', password: password || '' });
        if (!r?.success) { notifyError(t('connectFail', { err: r?.error || t('unknownError') })); return null; }
      } catch (err: any) { notifyError(t('connectFail', { err })); return null; }
      setLazyConns(prev => [...prev, connId]);
      // ClearCase 뷰 루트가 src 에 실려 있으면(이전 병합/재연결에서 이관받은 값) 새 termId 에도
      // 심어서 계속 이어간다 — 인터랙티브 셸이 없는 이 연결은 스스로 알아낼 방법이 없다.
      if (src.viewRoot) { try { await api?.feSetViewRoot?.(connId, src.viewRoot); } catch {} }
      const newSrc: PanelSource = { mode: 'remote', termId: connId, label: `🔌 ${username}@${host}`, manualConn: src.manualConn, viewRoot: src.viewRoot };
      setSources(prev => {
        if (prev.find(s => s.termId === connId)) return prev;
        const idx = prev.findIndex(s => (s.mode as any) === 'sftp-connect');
        const arr = [...prev];
        if (idx >= 0) arr.splice(idx, 0, newSrc); else arr.push(newSrc);
        return arr;
      });
      return newSrc;
    }
    if (!src.sessionId) return null;
    const sess = allSessionsList.find(s => s.id === src.sessionId);
    if (!sess) { notifyError(t('remoteSessionMissing')); return null; }
    const connId = `fe-lazy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const jumps = buildJumpChain(sess);
    // 비밀번호가 없는 세션은 바로 자격증명 다이얼로그 표시
    const hasCredential = sess.auth?.type === 'key' || (sess.auth?.type === 'password' && sess.auth?.password);
    const openCred = () => {
      setTermFocusBlocked(true); // 렌더 전에 동기 차단 — useEffect 보다 먼저 실행됨
      setCredPrompt({ sess, leafId, tabId: forTabId, jumps });
      setCredUser(sess.username || '');
      setCredPass('');
      setCredShowPass(false);
    };
    if (!hasCredential) {
      openCred();
      return null;
    }
    try {
      const r: any = await api?.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth, undefined, jumps.length ? jumps : undefined);
      if (!r?.success) {
        openCred();
        return null;
      }
    } catch {
      openCred();
      return null;
    }
    setLazyConns(prev => [...prev, connId]);
    if (src.viewRoot) { try { await api?.feSetViewRoot?.(connId, src.viewRoot); } catch {} }
    const folder = sessionFolderMap[sess.id];
    const label = folder ? `🟢 ${sess.name}  [${folder}]` : `🟢 ${sess.name}`;
    const newSrc: PanelSource = { mode: 'remote', termId: connId, sessionId: sess.id, label, viewRoot: src.viewRoot };
    // 소스 리스트 업데이트 — lazy 항목 제거하고 연결된 항목 추가
    setSources(prev => {
      const filtered = prev.filter(s => !(s.mode === 'lazy-remote' && s.sessionId === sess.id));
      // '직접 연결' 항목 앞에 삽입
      const idx = filtered.findIndex(s => (s.mode as any) === 'sftp-connect');
      const arr = [...filtered];
      if (idx >= 0) arr.splice(idx, 0, newSrc); else arr.push(newSrc);
      return arr;
    });
    return newSrc;
  };

  // 자격증명 다이얼로그 확인 — 입력된 id/비밀번호로 연결 재시도
  const handleCredSubmit = async () => {
    if (!credPrompt) return;
    const { sess, leafId, tabId: credTabId, jumps } = credPrompt;
    setCredConnecting(true);
    const newConnId = `fe-lazy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const r: any = await api?.feSftpConnect?.(newConnId, sess.host, sess.port || 22, credUser, { type: 'password', password: credPass }, undefined, (jumps && jumps.length) ? jumps : undefined);
      if (!r?.success) {
        notifyError(t('connectFailNamed', { name: sess.name, err: r?.error || t('unknownError') }));
        setCredConnecting(false);
        return;
      }
      setLazyConns(prev => [...prev, newConnId]);
      const folder = sessionFolderMap[sess.id];
      const label = folder ? `🟢 ${sess.name}  [${folder}]` : `🟢 ${sess.name}`;
      const newSrc: PanelSource = { mode: 'remote', termId: newConnId, sessionId: sess.id, label };
      setSources(prev => {
        const filtered = prev.filter(s => !(s.mode === 'lazy-remote' && s.sessionId === sess.id));
        const idx = filtered.findIndex(s => (s.mode as any) === 'sftp-connect');
        const arr = [...filtered];
        if (idx >= 0) arr.splice(idx, 0, newSrc); else arr.push(newSrc);
        return arr;
      });
      const credHome = await getHomeWithRetry('remote', newSrc.termId);
      // 대상 탭이 특정돼 있으면 그 탭만 갱신 — setLeafSource/setLeafPath 는 활성 탭에 쓰므로
      // 한 leaf 에 여러 세션 탭이 있으면 엉뚱한 탭을 덮어쓴다.
      if (credTabId) {
        updatePanel(leafId, p => ({ ...p, tabs: p.tabs.map(t => t.id === credTabId ? { ...t, source: newSrc, path: credHome } : t) }));
      } else {
        setLeafSource(leafId, newSrc);
        setLeafPath(leafId, credHome);
      }
      setCredPrompt(null);
    } catch (err: any) {
      notifyError(t('connectFailNamed', { name: sess.name, err: err?.message || err }));
    }
    setCredConnecting(false);
  };

  const handleSourceChangeForLeaf = async (leafId: string, src: PanelSource) => {
    if (src.mode === 'sftp-connect' as any) { setShowSftpConnect(leafId); return; }
    if (src.mode === 'lazy-remote') {
      const real = await realizeLazyRemote(src, leafId);
      if (!real) return;
      setLeafSource(leafId, real);
      setLeafPath(leafId, await getHomeWithRetry('remote', real.termId));
      return;
    }
    setLeafSource(leafId, src);
    setLeafPath(leafId, await getHomeWithRetry(src.mode, src.termId));
  };

  const handleDisconnect = async (src: PanelSource) => {
    if (src.mode !== 'remote' || !src.termId) return;
    try { await api?.feSftpDisconnect?.(src.termId); } catch {}
    setSources(prev => prev.filter(s => s.termId !== src.termId));
    // 트리 전체에서 해당 termId 를 가진 모든 탭은 local 로 fallback
    const localHome = await getHomeWithRetry('local');
    const localSrc: PanelSource = { mode: 'local', label: localLabel };
    setLayout(prev => mapAllFeTabs(prev, t => t.source.termId === src.termId
      ? { ...t, source: localSrc, path: localHome, selected: new Set() } : t));
  };

  // 커스텀 워크스페이스 탭을 닫았다가 다시 열거나 앱을 재시작한 뒤 복원된 경우 — reviveFeLayout
  // 이 remote 소스를 lazy-remote 로 강등해뒀으므로, 여기서 자동으로 재연결하고 저장했던 경로로
  // 이동한다(realizeLazyRemote 는 성공 시 홈 디렉토리로 이동시키므로, 그 다음에 원래 path 를
  // 다시 적용). allSessionsList 가 아직 비어있으면(세션 목록 로드 전) 재시도한다.
  const restoredReconnectDoneRef = useRef(false);
  useEffect(() => {
    if (!bootReady || !initDone) return;
    if (!initialState?.layout) return;
    if (restoredReconnectDoneRef.current) return;
    if (allSessionsList.length === 0) return; // 세션 목록 로드 대기
    restoredReconnectDoneRef.current = true;
    (async () => {
      const leaves = collectFeLeaves(layoutRef.current);
      for (const leaf of leaves) {
        for (let i = 0; i < leaf.panel.tabs.length; i++) {
          const tab = leaf.panel.tabs[i];
          if (tab.source.mode !== 'lazy-remote' || (!tab.source.sessionId && !tab.source.manualConn)) continue;
          const savedPath = tab.path;
          const real = await realizeLazyRemote(tab.source, leaf.id, tab.id);
          if (!real) continue; // 세션이 삭제됐거나 자격증명이 없어 다이얼로그로 넘어간 경우
          // 버그 수정: 예전엔 source 를 먼저 반영한 뒤 savedPath 를 setLeafPath 로 적용했는데,
          // setLeafPath 는 "그 leaf 의 **활성** 탭"에 쓴다(p.activeIdx) — 한 leaf 에 탭이 여러
          // 개면(병합으로 여러 세션이 한 leaf 에 모인 경우) 복원 중인 탭이 아니라 활성 탭에
          // 경로가 덮어써진다. 그래서 A세션 탭에 B세션의 저장 경로(/root 등)가 꽂혀
          // "Permission denied"가 나던 문제가 있었다(사용자 재현: ClearCase 개발서버 탭에 다른
          // 세션의 /root 가 뜸). 반드시 복원 중인 탭(tab.id)만 지정해서 갱신한다.
          // 또한 source 를 먼저 반영하면 FilePanel 이 준비 안 된 연결로 즉시 목록을 읽으려
          // 하므로(버그 수정 #1 과 동일한 레이스), 워밍업을 먼저 끝내고 source+path 를 한 번에 쓴다.
          if (savedPath) {
            for (let r = 0; r < 10; r++) {
              try { const h = await api?.feHomeDir?.('remote', real.termId); if (h) break; } catch {}
              await new Promise(res => setTimeout(res, 500));
            }
          }
          updatePanel(leaf.id, p => ({ ...p, tabs: p.tabs.map(t => t.id === tab.id ? { ...t, source: real, path: savedPath || t.path } : t) }));
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootReady, initDone, allSessionsList]);

  const handleSftpConnect = async () => {
    if (!sftpHost || !sftpUser || !showSftpConnect) return;
    const targetLeafId = showSftpConnect;
    setSftpConnecting(true);
    const connId = `sftp-${Date.now()}`;
    try {
      const result = await api.feSftpConnect?.(connId, sftpHost, sftpPort, sftpUser, { type: 'password', password: sftpPass });
      if (!result?.success) { notifyError(t('connectFail', { error: result?.error || t('unknownError') })); setSftpConnecting(false); return; }
      const newSrc: PanelSource = { mode: 'remote', termId: connId, label: `🔌 ${sftpUser}@${sftpHost}`, manualConn: { host: sftpHost, port: sftpPort, username: sftpUser, password: sftpPass } };
      setSources(prev => [...prev, newSrc]);
      setLeafSource(targetLeafId, newSrc);
      try { const home = await api.feHomeDir('remote', connId); setLeafPath(targetLeafId, home || '/'); } catch { setLeafPath(targetLeafId, '/'); }
    } catch (err: any) { notifyError(t('connectFail', { err })); }
    setSftpConnecting(false);
    setShowSftpConnect(null);
    setSftpHost(''); setSftpPort(22); setSftpUser(''); setSftpPass('');
  };

  // 다른 (창의) 파일 전송 탭을 이 탭 위로 끌어다 놓아 병합할 때 — 그 탭에 열려있던 세션ID 기반
  // 원격 소스와 즉석 SFTP(manualConn) 소스를 이 인스턴스에 새로 열어 재연결한다. termId 는 서로
  // 다른 프로세스/창의 것이라 그대로 옮길 수 없어 항상 새로 연결한다(기존 세션 그대로 이관 X).
  const mergeInRemoteSource = async (item: { sessionId?: string; manualConn?: any; label?: string; path?: string; viewRoot?: string }) => {
    let src: PanelSource | null = null;
    if (item.sessionId) src = { mode: 'lazy-remote', sessionId: item.sessionId, label: item.label || '', viewRoot: item.viewRoot };
    else if (item.manualConn) src = { mode: 'lazy-remote', manualConn: item.manualConn, label: item.label || '', viewRoot: item.viewRoot };
    if (!src) return;
    const tab = makeFeTab(src, item.path || '');
    const leaves = collectFeLeaves(layoutRef.current);
    let leafId: string;
    if (leaves.length === 1) {
      leafId = makeId('fenode');
      setLayout(prev => splitFeNode(prev, leaves[0].id, 'row', localLabel, false, leafId));
      setLayout(prev => updateFeLeafPanel(prev, leafId, p => ({ ...p, tabs: [tab], activeIdx: 0 })));
    } else {
      leafId = (selectedLeafIdRef.current && leaves.some(l => l.id === selectedLeafIdRef.current))
        ? selectedLeafIdRef.current : leaves[leaves.length - 1].id;
      updatePanel(leafId, p => ({ ...p, tabs: [...p.tabs, tab], activeIdx: p.tabs.length }));
    }
    setSelectedLeafId(leafId);
    const real = await realizeLazyRemote(src, leafId, tab.id);
    if (!real) return; // 연결 실패(자격증명 오류 등) — 탭은 lazy-remote 상태로 남아 사용자가 다시 시도 가능
    // ClearCase 뷰 루트(src.viewRoot) 이관은 realizeLazyRemote 내부에서 처리됨(App.tsx의
    // extractMergeableFeSources 가 원본 연결에서 미리 읽어와 item.viewRoot 로 실어 보낸 값).
    // source 를 먼저 반영하면 FilePanel 이 termId 변경을 감지해 즉시 목록 로딩을 시도하는데,
    // 이 시점엔 SFTP 서브시스템이 아직 준비 안 돼 실패/빈 목록으로 끝나버린다. 게다가 그 다음
    // setLeafPath(item.path) 는 path 값이 이미 같아서(탭 생성 시 이미 넣어둠) no-op 라 재시도도
    // 안 걸린다 — "병합하면 목록이 안 뜨는" 버그의 원인. 워밍업 확인 후 source+path 를 한 번에
    // 반영해서 첫 로딩 자체가 준비된 상태에서 일어나게 한다.
    for (let i = 0; i < 10; i++) {
      try { const h = await api?.feHomeDir?.('remote', real.termId); if (h) break; } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    updatePanel(leafId, p => ({ ...p, tabs: p.tabs.map(t => t.id === tab.id ? { ...t, source: real, path: item.path || t.path } : t) }));
  };

  useEffect(() => {
    if (!bootReady) return;
    const handler = async (e: Event) => {
      const { feTabId, items } = (e as CustomEvent).detail || {};
      if (feTabId && tabId && feTabId !== tabId) return;
      if (!Array.isArray(items)) return;
      for (const item of items) { await mergeInRemoteSource(item); }
      // source/path 갱신만으로 FilePanel 의 자동 재로딩 effect 가 못 미더운 케이스(관찰됨)에 대한
      // 안전망 — 파일 전송 완료 후에도 쓰는 것과 동일한 강제 새로고침 트리거.
      setRefreshKey(k => k + 1);
    };
    window.addEventListener('fe-merge-remote-sources', handler);
    return () => window.removeEventListener('fe-merge-remote-sources', handler);
    // allSessionsList 를 deps 에 넣어야 한다 — 안 그러면 이 리스너가 bootReady 최초 true 시점의
    // (아직 세션 목록 로딩 전이라 비어있는) allSessionsList 를 클로저로 영구히 물고 있어서,
    // 나중에 목록이 채워진 뒤 병합 이벤트가 와도 realizeLazyRemote 가 "세션 정보를 찾을 수
    // 없습니다"로 실패한다(사용자가 실제로 겪은 버그).
  }, [bootReady, allSessionsList]);

  // feTransfer는 즉시 반환 + fe:transfer-done 이벤트로 완료 통보 → IPC 채널 해제로 progress 이벤트 실시간 수신
  const doTransfer = (src: any, dst: any, name: string): Promise<{ success: boolean; error?: string }> =>
    new Promise(resolve => {
      api.feTransfer?.(src, dst, name, workspaceIdRef.current).then((result: any) => {
        const seq: number = result?.seq;
        if (seq == null) { resolve({ success: result?.success ?? true }); return; }
        const unsub = api.onFeTransferDone?.((p: any) => {
          if (p.seq === seq) { unsub?.(); resolve(p); }
        });
        if (!unsub) resolve({ success: true });
      }).catch((err: any) => resolve({ success: false, error: String(err) }));
    });

  const handleFileDrop = async (targetLeafId: string, fileNames: string[], srcMode: string, srcTermId?: string, srcPath?: string) => {
    const leaf = getLeaf(targetLeafId);
    if (!leaf) return;
    const dstTab = leaf.panel.tabs[leaf.panel.activeIdx];
    if (!dstTab) return;
    const dstSep = sep(dstTab.source);
    const srcSep = srcMode === 'local' && navigator.platform.startsWith('Win') ? '\\' : '/';

    // 실패할 때마다 모달을 하나씩 띄우면(예: 연결이 끊긴 채로 수백~수천 개 파일을 계속
    // 시도) 사용자가 그 개수만큼 "확인"을 눌러야 하는 문제가 있었다 — 실패는 모아뒀다가
    // 끝나고 한 번만 요약해서 보여준다. 또한 같은 에러가 연속으로 반복되면(연결 끊김처럼
    // 남은 파일도 다 실패할 게 뻔한 경우) 나머지를 무의미하게 다 시도하지 않고 중단한다.
    const failures: { name: string; err: string }[] = [];
    let consecutiveSameError = 0;
    let lastError = '';
    let aborted = false;
    for (const name of fileNames) {
      const srcFull = (srcPath || '').endsWith(srcSep) ? (srcPath || '') + name : (srcPath || '') + srcSep + name;
      const dstFull = dstTab.path.endsWith(dstSep) ? dstTab.path + name : dstTab.path + dstSep + name;
      const result = await doTransfer(
        { mode: srcMode, termId: srcTermId, path: srcFull },
        { mode: dstTab.source.mode, termId: dstTab.source.termId, path: dstFull },
        name,
      );
      if (!result.success) {
        const err = String(result.error || '');
        failures.push({ name, err });
        if (err && err === lastError) consecutiveSameError++; else { consecutiveSameError = 1; lastError = err; }
        if (consecutiveSameError >= 5) { aborted = true; break; }
      }
    }
    if (failures.length > 0) {
      const preview = failures.slice(0, 5).map(f => `${f.name}: ${f.err}`).join('\n');
      const more = failures.length > 5 ? `\n... 외 ${failures.length - 5}개` : '';
      const abortedNote = aborted ? `\n\n(동일 오류 반복 감지 — 남은 파일 전송을 중단했습니다)` : '';
      notifyError(t('transferFailSummary', { count: failures.length, defaultValue: `파일 전송 실패 ${failures.length}건` }), `${preview}${more}${abortedNote}`);
    }
    setRefreshKey(k => k + 1);
  };

  // Windows 탐색기 등 OS 밖에서 실제 파일(절대경로)을 끌어다 놓았을 때 — 항상 local 소스로 취급해
  // 현재 패널(로컬이면 local→local 복사, 원격이면 local→remote 업로드)로 그대로 전송한다.
  const handleOsFilesDrop = async (targetLeafId: string, absPaths: string[]) => {
    const leaf = getLeaf(targetLeafId);
    if (!leaf) return;
    const dstTab = leaf.panel.tabs[leaf.panel.activeIdx];
    if (!dstTab) return;
    const dstSep = sep(dstTab.source);
    const failures: { name: string; err: string }[] = [];
    for (const absPath of absPaths) {
      const name = absPath.split(/[\\/]/).pop() || absPath;
      const dstFull = dstTab.path.endsWith(dstSep) ? dstTab.path + name : dstTab.path + dstSep + name;
      const result = await doTransfer(
        { mode: 'local', path: absPath },
        { mode: dstTab.source.mode, termId: dstTab.source.termId, path: dstFull },
        name,
      );
      if (!result.success) failures.push({ name, err: String(result.error || '') });
    }
    if (failures.length > 0) {
      const preview = failures.slice(0, 5).map(f => `${f.name}: ${f.err}`).join('\n');
      const more = failures.length > 5 ? `\n... 외 ${failures.length - 5}개` : '';
      notifyError(t('transferFailSummary', { count: failures.length, defaultValue: `파일 전송 실패 ${failures.length}건` }), `${preview}${more}`);
    }
    setRefreshKey(k => k + 1);
  };

  // 폴더 탭 추가 — 현재 활성 탭의 source/path 복제 (사용자가 현재 위치에서 가지 치기 의도)
  const addPanelTab = (leafId: string) => {
    const leaf = getLeaf(leafId);
    if (!leaf) return;
    const cur = leaf.panel.tabs[leaf.panel.activeIdx] || leaf.panel.tabs[0];
    updatePanel(leafId, p => ({ ...p, tabs: [...p.tabs, makeFeTab(cur.source, cur.path)], activeIdx: p.tabs.length }));
  };

  const closeTabInLeaf = (leafId: string, idx: number) => {
    const leaves = collectFeLeaves(layoutRef.current);
    // 트리 전체에 leaf 가 1개뿐이고 그 안에 탭도 1개뿐이면 — 전체가 빈 상태가 되므로 닫기 금지.
    if (leaves.length === 1 && leaves[0].panel.tabs.length <= 1) return;
    const leaf = leaves.find(l => l.id === leafId);
    if (!leaf) return;
    if (leaf.panel.tabs.length <= 1) {
      // 이 leaf 의 마지막 탭 — leaf 자체를 닫아 트리를 축약(동적 패널 전환)
      setLayout(prev => removeFeLeafNode(prev, leafId));
      if (selectedLeafId === leafId) {
        const other = leaves.find(l => l.id !== leafId);
        if (other) setSelectedLeafId(other.id);
      }
      return;
    }
    updatePanel(leafId, p => {
      const tabs = p.tabs.filter((_, i) => i !== idx);
      let activeIdx = p.activeIdx;
      if (idx < activeIdx) activeIdx -= 1;
      else if (idx === activeIdx) activeIdx = Math.min(activeIdx, tabs.length - 1);
      return { ...p, tabs, activeIdx };
    });
  };

  // 패널(leaf) 전체 닫기 — 탭 개수와 무관하게 이 패널을 트리에서 제거. 마지막 남은 패널은 닫을 수 없다.
  const closeLeaf = (leafId: string) => {
    const leaves = collectFeLeaves(layoutRef.current);
    if (leaves.length <= 1) return;
    setLayout(prev => removeFeLeafNode(prev, leafId));
    if (selectedLeafId === leafId) {
      const other = leaves.find(l => l.id !== leafId);
      if (other) setSelectedLeafId(other.id);
    }
  };

  const splitLeaf = (leafId: string, direction: 'row' | 'column') => {
    const newId = makeId('fenode');
    setLayout(prev => splitFeNode(prev, leafId, direction, localLabel, false, newId));
    setSelectedLeafId(newId);
    // 새로 생긴 로컬 탭은 path 가 빈 문자열로 시작 — 홈 디렉토리를 채워줘야 목록이 보인다.
    (async () => { setLeafPath(newId, await getHomeWithRetry('local')); })();
  };

  const handleContainerResize = (containerId: string, sizes: number[]) => {
    setLayout(prev => setFeContainerSizes(prev, containerId, sizes));
  };

  // .fe-dual 컨테이너의 실측 픽셀 크기 — leaf/divider 절대좌표 계산에 사용
  const dualRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = dualRef.current;
    if (!el) return;
    const update = () => setContainerSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // bootReady 가 false→true 로 바뀌기 전에는 .fe-dual 자체가 아직 렌더되지 않아 dualRef.current 가 null —
    // deps 를 비워두면 그 첫 실행에서만 관찰이 무산되고 이후 다시 붙지 않으므로 bootReady 를 의존성에 포함.
  }, [bootReady]);
  // 탭이 display:none 으로 숨겨지면 .fe-dual 의 clientWidth/Height 가 0 이 되는데, 그때마다
  // leafRects 를 빈 Map 으로 만들면 아래 렌더에서 모든 leaf 가 null 을 반환해 FilePanel 이
  // 통째로 언마운트되고(→ bootReady/디렉토리 목록이 리셋), 탭을 다시 보이면 처음부터 새로
  // 마운트되며 "재접속처럼" 보인다. 0 사이즈일 때는 새로 계산하지 않고 마지막으로 계산된
  // (실제 크기였을 때의) geometry 를 그대로 재사용해 FilePanel 이 계속 마운트 상태를 유지하게 한다.
  const lastGeometryRef = useRef<{ leafRects: Map<string, FeRect>; dividers: FeDividerInfo[] }>({ leafRects: new Map(), dividers: [] });
  const { leafRects, dividers } = React.useMemo(() => {
    if (containerSize.width > 0 && containerSize.height > 0) {
      const leafRects = new Map<string, FeRect>();
      const dividers: FeDividerInfo[] = [];
      computeFeGeometry(layout, { left: 0, top: 0, width: containerSize.width, height: containerSize.height }, leafRects, dividers);
      lastGeometryRef.current = { leafRects, dividers };
    }
    return lastGeometryRef.current;
  }, [layout, containerSize.width, containerSize.height]);
  // 분할선 드래그 — 해당 컨테이너의 sizes 를 픽셀 delta 로 조정
  const onDividerMouseDown = (e: React.MouseEvent, d: FeDividerInfo) => {
    e.preventDefault();
    e.stopPropagation();
    const start = d.isRow ? e.clientX : e.clientY;
    const startSizes = [...d.sizes];
    const sizeSum = startSizes.reduce((a, b) => a + b, 0) || 1;
    const avail = d.avail;
    const onMove = (ev: MouseEvent) => {
      const delta = (d.isRow ? ev.clientX : ev.clientY) - start;
      let nL = (startSizes[d.index] / sizeSum) * avail + delta;
      let nR = (startSizes[d.index + 1] / sizeSum) * avail - delta;
      const min = 80, comb = (startSizes[d.index] / sizeSum + startSizes[d.index + 1] / sizeSum) * avail;
      if (nL < min) { nL = min; nR = comb - min; }
      if (nR < min) { nR = min; nL = comb - min; }
      const ns = [...startSizes];
      ns[d.index] = (nL / avail) * sizeSum;
      ns[d.index + 1] = (nR / avail) * sizeSum;
      handleContainerResize(d.containerId, ns);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // 로컬 탭은 폴더명(기존 방식), 원격 탭은 항상 접속 세션명 — 폴더명 기준이면 같은 이름 디렉토리에서
  // 서로 다른 세션이 구분 안 되므로, 원격은 "어느 세션인지"가 우선이다.
  const tabLabel = (tab: FeTab): string => {
    if (tab.source.mode === 'local') {
      const p = tab.path || '';
      if (p) {
        const m = p.match(/[^\\/]+$/);
        if (m) return m[0];
      }
      return '~';
    }
    const lbl = tab.source.label || '';
    return lbl
      .replace(/^[🟢⚪🌐🔌🔒]\s*/u, '')
      .replace(/\s*\[[^\]]*\]/, '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim()
      .slice(0, 24) || '~';
  };
  // source.label 맨 앞 상태 아이콘(🟢/⚪/🌐/🔌) 추출 — u 플래그로 서로게이트 페어 안전하게 매칭. 로컬은 💻 고정.
  const tabIcon = (tab: FeTab): string => {
    if (tab.source.mode === 'local') return '💻';
    const m = (tab.source.label || '').match(/^[🟢⚪🌐🔌]/u);
    return m ? m[0] : '🌐';
  };

  // 드래그 상태 — fromLeafId 와 overLeafId 분리: 한 패널 내 reorder + 패널 간 이동 모두 지원
  const [tabDrag, setTabDrag] = useState<{ fromLeafId: string; from: number; overLeafId: string; over: number } | null>(null);
  // 같은 leaf 내 reorder
  const reorderTabInLeaf = (leafId: string, from: number, to: number) => {
    if (from === to) return;
    updatePanel(leafId, p => {
      if (from < 0 || from >= p.tabs.length || to < 0 || to >= p.tabs.length) return p;
      const tabs = [...p.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      let activeIdx = p.activeIdx;
      if (activeIdx === from) activeIdx = to;
      else if (from < activeIdx && to >= activeIdx) activeIdx--;
      else if (from > activeIdx && to <= activeIdx) activeIdx++;
      return { ...p, tabs, activeIdx };
    });
  };
  // leaf 간 탭 이동(드래그) — 원본 leaf 가 비면 자동으로 닫혀 트리가 축약된다.
  const moveTabBetweenLeaves = (fromLeafId: string, from: number, toLeafId: string, to: number) => {
    if (fromLeafId === toLeafId) { reorderTabInLeaf(fromLeafId, from, to); return; }
    const fromLeaf = getLeaf(fromLeafId);
    if (!fromLeaf || from < 0 || from >= fromLeaf.panel.tabs.length) return;
    const moved = fromLeaf.panel.tabs[from];
    setLayout(prev => {
      let next = updateFeLeafPanel(prev, fromLeafId, p => {
        const tabs = p.tabs.filter((_, i) => i !== from);
        const activeIdx = Math.min(p.activeIdx > from ? p.activeIdx - 1 : p.activeIdx, Math.max(0, tabs.length - 1));
        return { ...p, tabs, activeIdx };
      });
      // 원본 leaf 가 비었고 트리에 다른 leaf 가 남아있다면 그 leaf 자체를 제거
      if (countFeLeaves(next) > 1) {
        const stillThere = collectFeLeaves(next).find(l => l.id === fromLeafId);
        if (stillThere && stillThere.panel.tabs.length === 0) next = removeFeLeafNode(next, fromLeafId);
      }
      next = updateFeLeafPanel(next, toLeafId, p => {
        const insertAt = Math.max(0, Math.min(to, p.tabs.length));
        const tabs = [...p.tabs];
        tabs.splice(insertAt, 0, moved);
        return { ...p, tabs, activeIdx: insertAt };
      });
      return next;
    });
    if (selectedLeafId === fromLeafId) setSelectedLeafId(toLeafId);
  };

  const renderPanelTabs = (leafId: string, panel: FePanel) => {
    const tabs = panel.tabs;
    const active = panel.activeIdx;
    const totalLeaves = countFeLeaves(layout);
    const scrollFeTabs = (dx: number) => {
      feTabScrollEls.current.get(leafId)?.scrollBy({ left: dx, behavior: 'smooth' });
    };
    // 탭 목록만 스크롤 영역에 넣고, +/분할/닫기 버튼은 밖에 고정 — 예전엔 버튼들도 스크롤
    // 컨테이너 안에 있어서 탭이 많아지면 같이 밀려 사라졌다.
    // onWheel: 스크롤바를 숨겼으므로(App.css 참고) 세로 휠을 가로 스크롤로 변환 — 메인 탭바와 동일.
    return (
      <div className="fe-panel-tabs">
        <div
          className="fe-panel-tabs-scroll"
          ref={setFeTabScrollRef(leafId)}
          onWheel={e => { e.currentTarget.scrollLeft += e.deltaY > 0 ? 60 : -60; }}
        >
        {tabs.map((tab, idx) => {
          const isDragging = tabDrag?.fromLeafId === leafId && tabDrag.from === idx;
          const isDropTarget = tabDrag && tabDrag.overLeafId === leafId && tabDrag.over === idx
            && !(tabDrag.fromLeafId === leafId && tabDrag.from === idx);
          return (
          <div
            key={tab.id}
            draggable
            className={`fe-panel-tab ${idx === active ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`}
            onMouseDown={() => {
              setSelectedLeafId(leafId);
              updatePanel(leafId, p => ({ ...p, activeIdx: idx }));
            }}
            onAuxClick={e => { if (e.button === 1) { e.preventDefault(); closeTabInLeaf(leafId, idx); } }}
            onDragStart={e => {
              setTabDrag({ fromLeafId: leafId, from: idx, overLeafId: leafId, over: idx });
              try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx)); } catch {}
            }}
            onDragOver={e => {
              if (!tabDrag) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (tabDrag.overLeafId !== leafId || tabDrag.over !== idx) {
                setTabDrag({ ...tabDrag, overLeafId: leafId, over: idx });
              }
            }}
            onDrop={e => {
              if (tabDrag) {
                e.preventDefault();
                moveTabBetweenLeaves(tabDrag.fromLeafId, tabDrag.from, leafId, idx);
              }
              setTabDrag(null);
            }}
            onDragEnd={() => setTabDrag(null)}
            title={tab.path ? `${tab.source.label}\n${tab.path}` : tab.source.label}
          >
            <span className="fe-panel-tab-label">{tabIcon(tab) ? `${tabIcon(tab)} ` : ''}{tabLabel(tab)}</span>
            {(tabs.length > 1 || totalLeaves > 1) && (
              <button
                className="fe-panel-tab-close"
                onClick={e => { e.stopPropagation(); closeTabInLeaf(leafId, idx); }}
                title={t('tabClose')}
              >×</button>
            )}
          </div>
          );
        })}
        {/* 탭바 끝 빈 영역으로 drop → 맨 끝에 추가 */}
        <div
          className="fe-panel-tabs-end-drop"
          onDragOver={e => {
            if (!tabDrag) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (tabDrag.overLeafId !== leafId || tabDrag.over !== tabs.length) {
              setTabDrag({ ...tabDrag, overLeafId: leafId, over: tabs.length });
            }
          }}
          onDrop={e => {
            if (tabDrag) {
              e.preventDefault();
              moveTabBetweenLeaves(tabDrag.fromLeafId, tabDrag.from, leafId, tabs.length);
            }
            setTabDrag(null);
          }}
        />
        </div>
        {feTabsOverflow[leafId] && (
          <div className="fe-panel-tab-scroll-group">
            <button className="fe-panel-tab-scroll-btn" onClick={() => scrollFeTabs(-150)} title={t('scrollPrev', { defaultValue: '이전' })}>‹</button>
            <button className="fe-panel-tab-scroll-btn" onClick={() => scrollFeTabs(150)} title={t('scrollNext', { defaultValue: '다음' })}>›</button>
          </div>
        )}
        <button
          className="fe-panel-tab-add"
          onClick={() => addPanelTab(leafId)}
          title={t('newTabDup')}
        >+</button>
        <button
          className="fe-panel-split-btn"
          onClick={() => splitLeaf(leafId, 'row')}
          title={t('splitRow')}
        >⬌</button>
        <button
          className="fe-panel-split-btn"
          onClick={() => splitLeaf(leafId, 'column')}
          title={t('splitColumn')}
        >⬍</button>
        {totalLeaves > 1 && (
          <button
            className="fe-panel-close-btn"
            onClick={() => closeLeaf(leafId)}
            title={t('closePanel')}
          >×</button>
        )}
      </div>
    );
  };

  const renderLeafContent = (leafId: string, panel: FePanel) => {
    const emptyTab: FeTab = { id: '', source: { mode: 'local', label: localLabel }, path: '', selected: new Set() };
    const tab = panel.tabs[panel.activeIdx] || panel.tabs[0] || emptyTab;
    return (
      <>
        {renderPanelTabs(leafId, panel)}
        <FilePanel panelId={leafId} refreshKey={refreshKey}
          source={tab.source} sources={sources} onSourceChange={src => handleSourceChangeForLeaf(leafId, src)}
          selectedFiles={tab.selected} onSelectionChange={sel => setLeafSelected(leafId, sel)}
          currentPath={tab.path} onPathChange={p => setLeafPath(leafId, p)}
          onFileDrop={(files, srcMode, srcTermId, srcPath) => handleFileDrop(leafId, files, srcMode, srcTermId, srcPath)}
          onOsFilesDrop={absPaths => handleOsFilesDrop(leafId, absPaths)}
          onDisconnect={() => handleDisconnect(tab.source)}
          workspaceId={workspaceIdRef.current}
          initialFiles={tab.entries}
          onFilesLoaded={entries => setLeafEntries(leafId, entries)}
        />
      </>
    );
  };

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = { startY: e.clientY, startH: transfersHeight };
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const delta = resizing.current.startY - ev.clientY;
      const newH = Math.max(80, Math.min(600, resizing.current.startH + delta));
      setTransfersHeight(newH);
    };
    const onUp = () => {
      resizing.current = null;
      localStorage.setItem('feTransfersHeight', String(transfersHeight));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!bootReady) {
    return (
      <div className="fe-container" style={{ alignItems: 'center', justifyContent: 'center', color: '#8aa', background: '#111', minHeight: 0 }}>
        파일전송 워크스페이스를 준비하는 중...
      </div>
    );
  }

  const allLeaves = collectFeLeaves(layout);

  try { return (
    <div className="fe-container">
      <div className="fe-dual fe-dual-flat" ref={dualRef}>
        {allLeaves.map(leaf => {
          const r = leafRects.get(leaf.id);
          if (!r) return null;
          return (
            <div key={leaf.id}
              className={`fe-panel-wrap ${selectedLeafId === leaf.id ? 'selected' : ''}`}
              style={{ position: 'absolute', left: r.left, top: r.top, width: r.width, height: r.height }}
              onMouseDownCapture={() => setSelectedLeafId(leaf.id)}
            >
              {renderLeafContent(leaf.id, leaf.panel)}
            </div>
          );
        })}
        {dividers.map(d => (
          <div key={d.key}
            className={`layout-divider ${d.isRow ? 'row' : 'column'}`}
            style={{ position: 'absolute', left: d.rect.left, top: d.rect.top, width: d.rect.width, height: d.rect.height }}
            onMouseDown={e => onDividerMouseDown(e, d)}
          >
            <div className="layout-divider-line" />
          </div>
        ))}
      </div>
      <div className="fe-transfers-resize" onMouseDown={onResizeStart} />
      <div className="fe-transfers" style={{ height: transfersHeight }}>
        <TransferLog workspaceId={workspaceIdRef.current} />
      </div>
      {credPrompt && (
        <div className="session-editor-backdrop" onClick={() => setCredPrompt(null)}>
          <div className="cred-modal" ref={credModalRef} tabIndex={-1} onClick={e => e.stopPropagation()} style={{ outline: 'none' }}>
            <div className="cred-modal-header">
              <span className="cred-modal-title">🔒 {t('credModalTitle')}</span>
              <button className="cred-modal-close" onClick={() => setCredPrompt(null)}>✕</button>
            </div>
            <div className="cred-modal-host">{credPrompt.sess.host} {t('credModalConnectTo')}</div>
            <div className="cred-modal-fields">
              <input
                ref={credUserInputRef}
                className="cred-modal-input"
                placeholder="username"
                value={credUser}
                onChange={e => setCredUser(e.target.value)}
              />
              <div className="cred-modal-pass-wrap">
                <input
                  className="cred-modal-input"
                  type={credShowPass ? 'text' : 'password'}
                  placeholder="password"
                  value={credPass}
                  onChange={e => setCredPass(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCredSubmit(); }}
                />
                <button
                  type="button"
                  className="cred-modal-eye-btn"
                  tabIndex={-1}
                  onClick={() => setCredShowPass(v => !v)}
                  title={credShowPass ? t('hide') : t('show')}
                >
                  {credShowPass ? '🙈' : '👁'}
                </button>
              </div>
            </div>
            <div className="cred-modal-actions">
              <button className="btn-cancel" onClick={() => setCredPrompt(null)}>{t('cancel')}</button>
              <button className="btn-save" onClick={handleCredSubmit} disabled={credConnecting}>
                {credConnecting ? t('connecting') : t('connect')}
              </button>
            </div>
          </div>
        </div>
      )}
      {showSftpConnect && (
        <div className="session-editor-backdrop" onClick={() => setShowSftpConnect(null)}>
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 400 }}>
            <h3>{t('sftpDirectTitle')}</h3>
            <div className="session-editor-grid">
              <label>{t('host')}</label>
              <input value={sftpHost} onChange={e => setSftpHost(e.target.value)} placeholder="192.168.0.1" autoFocus />
              <label>{t('port')}</label>
              <input type="number" value={sftpPort} onChange={e => setSftpPort(Number(e.target.value) || 22)} />
              <label>{t('user')}</label>
              <input value={sftpUser} onChange={e => setSftpUser(e.target.value)} placeholder="root" />
              <label>{t('password')}</label>
              <input type="password" value={sftpPass} onChange={e => setSftpPass(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSftpConnect(); }}
              />
            </div>
            <div className="session-editor-actions">
              <button className="btn-cancel" onClick={() => setShowSftpConnect(null)}>{t('cancel')}</button>
              <button className="btn-save" onClick={handleSftpConnect} disabled={sftpConnecting}>
                {sftpConnecting ? t('connecting') : t('connect')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  ); } catch (err: any) {
    return <div style={{ padding: 20, color: '#e74c3c' }}>{t('loadFail', { err: String(err) })}</div>;
  }
};

// ── 레이아웃 기하 계산 ──────────────────────────────────────────────────────
// leaf 를 트리 깊이에 따라 실제로 중첩된 DOM 으로 렌더링하면, 분할/병합으로 트리 모양이
// 바뀔 때마다 React 가 기존 leaf 의 위치(부모 체인)를 다른 것으로 인식해 언마운트→재마운트한다.
// (FilePanel 이 다시 마운트되며 디렉토리 목록을 처음부터 다시 불러오는 "재접속처럼 보이는" 원인.)
// 그래서 leaf 는 항상 평평한(flat) 형제 목록으로 한 번만 렌더링하고 — key 가 leafId 로 고정되어
// React 가 트리 모양과 무관하게 같은 컴포넌트 인스턴스로 계속 재사용한다 — 트리 구조는 각 leaf 의
// 절대좌표(px)를 계산하는 데만 쓴다. 분할선(divider)도 같은 방식으로 평평하게 렌더링한다.
type FeRect = { left: number; top: number; width: number; height: number };
type FeDividerInfo = { key: string; containerId: string; index: number; isRow: boolean; rect: FeRect; sizes: number[]; avail: number };
const FE_DIVIDER_PX = 8;

function computeFeGeometry(
  node: FeLayoutNode, rect: FeRect,
  leafRects: Map<string, FeRect>, dividers: FeDividerInfo[],
) {
  if (node.type === 'leaf') { leafRects.set(node.id, rect); return; }
  const isRow = node.type === 'row';
  const n = node.children.length;
  const gapTotal = FE_DIVIDER_PX * Math.max(0, n - 1);
  const avail = Math.max(0, (isRow ? rect.width : rect.height) - gapTotal);
  const sizes = (Array.isArray(node.sizes) && node.sizes.length === n) ? node.sizes : node.children.map(() => 1);
  const sizeSum = sizes.reduce((a, b) => a + b, 0) || 1;
  let offset = isRow ? rect.left : rect.top;
  node.children.forEach((child, i) => {
    const childLen = (sizes[i] / sizeSum) * avail;
    const childRect: FeRect = isRow
      ? { left: offset, top: rect.top, width: childLen, height: rect.height }
      : { left: rect.left, top: offset, width: rect.width, height: childLen };
    computeFeGeometry(child, childRect, leafRects, dividers);
    offset += childLen;
    if (i < n - 1) {
      const dividerRect: FeRect = isRow
        ? { left: offset, top: rect.top, width: FE_DIVIDER_PX, height: rect.height }
        : { left: rect.left, top: offset, width: rect.width, height: FE_DIVIDER_PX };
      dividers.push({ key: `${node.id}-${i}`, containerId: node.id, index: i, isRow, rect: dividerRect, sizes, avail });
      offset += FE_DIVIDER_PX;
    }
  });
}
