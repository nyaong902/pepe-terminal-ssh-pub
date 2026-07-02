// src/App.tsx
import { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import './App.css';
import { TabBar } from './components/TabBar';
import { MenuBar } from './components/MenuBar';
import type { MenuDef } from './components/MenuBar';
import { Layout } from './components/Layout';
import { SearchBar } from './components/SearchBar';
import { FileExplorer } from './components/FileExplorer';
import { ConflictDialogQueue } from './components/ConflictDialog';
import { NotifyHost, notifyError, notifyOk } from './components/Notify';
import { FileEditor } from './components/FileEditor';
import { ClaudeChat } from './components/ClaudeChat';
import { BrowserPane } from './components/BrowserPane';
import { CompareWorkspace } from './components/CompareWorkspace';
import { LogAnalyzer } from './components/LogAnalyzer';
import { VpnWorkspace } from './components/VpnWorkspace';
import { MicroSipWorkspace } from './components/MicroSipWorkspace';
import { TranslationEditor } from './components/TranslationEditor';
import { SqlToolWorkspace, serializeSqlSession, hydrateSqlSession } from './components/SqlToolWorkspace';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RemoteFileTree } from './components/RemoteFileTree';
import { QuickConnectBar, QuickConnectResult } from './components/QuickConnectDialog';
import { StatusBar } from './components/StatusBar';
import { RemoteShareDialog } from './components/RemoteShareDialog';
import { resetTermConnectState, clearScrollbackInTerm, clearScreenInTerm, clearAllInTerm, applyThemeToAll, applyThemeToTerm, applyFontToTerm, applyFontToAll, getCurrentThemeName, registerTermSession, getTermSessionInfo, getWordSeparator, setWordSeparator, refitAllTerms, applyScrollbackToAll, applyScrollbackToTerm, cloneTermStyle, isTermConnected, isTermConnecting, isTermPty, subscribeConnectedChange, focusTerm, pasteToTerm, getSelectionFromTerm, selectAllInTerm, promptPasswordAndConnect, startInitialConnectWatchdog, getCurrentPwdForTerm, refitTerm, searchInTerm, searchNextInTerm, searchPrevInTerm, clearSearchInTerm, highlightAllMatches, clearHighlights, searchFromTop, getAllTermIds, applyCursorStyleToTerm, markQuickConnectPending, clearQuickConnectPending, writeToTerm, termStore, setTermFocusBlocked, setTermBackspaceMode, setTermDeleteMode, disposeTermFully, markTermConnected, markTermSnapshotOnly, markSuppressAutoConnect, clearSuppressAutoConnect, serializeTermBuffer, setPendingRestoreBuffer, getTermStyle, setPendingRestoreStyle } from './components/TerminalPanel';
import { marked } from 'marked';
// @ts-ignore — vite ?raw 로 docs/MANUAL.md 를 번들 문자열로 임베드
import manualMd from '../docs/MANUAL.md?raw';
import { getClaudeFontFamily, getClaudeFontSize, setClaudeFontFamily, setClaudeFontSize, applyClaudeFontVars } from './utils/claudeFont';
import { getTerminalSettings, saveTerminalSettings, TerminalSettings } from './utils/terminalSettings';
import { loadKeybindings, matchKeybinding, getKeybindings, getKeybinding, DEFAULT_KEYBINDINGS, KEYBINDING_LABELS, keyEventToCombo, setKeybindingListening } from './utils/keybindings';
import { getThemeList } from './utils/terminalThemes';
import { getWindowThemeList, getCurrentWindowThemeId, applyWindowTheme } from './utils/windowThemes';
import { setLanguage, getCurrentLanguage } from './i18n';
import { useTranslation } from 'react-i18next';
import { SessionList } from './components/SessionList';
import { SessionEditor } from './components/SessionEditor';
import {
  LayoutNode,
  PanelSession,
  splitNode,
  splitNodeWithSessions,
  addSessionsAsTile,
  removeLeafNode,
  addSessionToPanel,
  appendSessionsToPanel,
  removeSessionFromPanel,
  switchPanelSession,
  reorderPanelSession,
  countLeaves,
  collectAllSessions,
  findFirstLeafId,
  findEmptyLeafId,
  createInitialLayout,
  resetLayoutSizes,
} from './utils/layoutUtils';

export type { LayoutNode, ContainerNode, LeafNode, Panel, PanelSession } from './utils/layoutUtils';

export type TabId = string;
export type TabType = 'terminal' | 'fileExplorer' | 'fileEditor' | 'browser' | 'compare' | 'logAnalyzer' | 'vpn' | 'i18nEditor' | 'sqlTool' | 'messenger' | 'microsip';
export type TabColor = 'default' | 'red' | 'purple' | 'yellow' | 'green' | 'blue' | 'orange';
export type Tab = { id: TabId; title: string; layout: LayoutNode; type?: TabType; customTitle?: boolean; color?: TabColor; editor?: { termId: string; remotePath: string; fileName: string }; sqlTool?: { sessionId: string; sessionName: string }; initialTermId?: string; initialRemotePath?: string; fileExplorerState?: any; workspaceState?: any };

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

// 일괄전송 히스토리 (앱 실행 중 유지, 최대 50개)
const broadcastHistory: string[] = [];
const MAX_BROADCAST_HISTORY = 50;
function addBroadcastHistory(text: string) {
  if (!text.trim()) return;
  const idx = broadcastHistory.indexOf(text);
  if (idx !== -1) broadcastHistory.splice(idx, 1);
  broadcastHistory.unshift(text);
  if (broadcastHistory.length > MAX_BROADCAST_HISTORY) broadcastHistory.pop();
}

// 분리된(탭 tear-off) 창 여부 — main 이 #detached 해시로 로드.
const IS_DETACHED_WINDOW = typeof window !== 'undefined' && /detached/.test(window.location.hash);

function App() {
  const { t: tOpt } = useTranslation('options');
  const { t: tMenu } = useTranslation('menu');
  const { t: tKb } = useTranslation('keybindings');
  const { t: tMsg } = useTranslation('messenger');
  const { t: tApp } = useTranslation('app');
  const [tabs, setTabs] = useState<Tab[]>(() => {
    // 분리 창은 빈 상태로 시작 — 마운트 후 main 에서 받은 탭 페이로드로 채운다(기본 워크스페이스/자동 셸 생성 방지).
    if (IS_DETACHED_WINDOW) return [];
    return [{ id: 'tab-1', title: 'Workspace 1', layout: createInitialLayout('tab-1') }];
  });
  // 빈 deps useEffect 에서 최신 tabs 참조용 — state 변경 시마다 ref 동기화
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const [activeTabId, setActiveTabId] = useState<TabId>(IS_DETACHED_WINDOW ? '' : 'tab-1');
  // 우측 분할로 함께 볼 워크스페이스 탭 — 특수 워크스페이스(브라우저·SQL·비교·로그·VPN·MicroSip·i18n) 만.
  // 터미널 탭은 activeTab 캡처 IIFE 구조라 이번 단계에선 제외 (2차 단계에서 처리).
  const [splitRightTabId, setSplitRightTabId] = useState<TabId | null>(null);
  const [splitRatio, setSplitRatio] = useState<number>(0.5); // 좌 비율 0.2~0.8
  // 지원 대상: 특수 워크스페이스 전체 + 터미널 (type undefined / 'terminal').
  const SPLITTABLE_TYPES: (TabType | undefined)[] = ['terminal', 'browser', 'compare', 'logAnalyzer', 'vpn', 'i18nEditor', 'sqlTool', 'microsip', 'fileExplorer', 'fileEditor', undefined];
  const canSplit = (tab: Tab | undefined) => !!tab && (tab.type === undefined || SPLITTABLE_TYPES.includes(tab.type));
  const splitRightTab = tabs.find(t => t.id === splitRightTabId) || null;
  // 활성 탭 자체를 분할 대상으로 설정 못 하게 — 자동 해제
  useEffect(() => {
    if (splitRightTabId && splitRightTabId === activeTabId) setSplitRightTabId(null);
    if (splitRightTabId && !tabs.find(t => t.id === splitRightTabId)) setSplitRightTabId(null);
  }, [activeTabId, splitRightTabId, tabs]);
  // 각 워크스페이스 탭 컨테이너의 display / order / flex 계산 헬퍼.
  const tabSlotStyle = (t: Tab): React.CSSProperties => {
    const isActive = activeTab?.id === t.id;
    const isRight = splitRightTabId === t.id && canSplit(t) && canSplit(activeTab);
    if (!isActive && !isRight) return { display: 'none' };
    if (isRight && !isActive) {
      return { display: 'flex', flex: `${(1 - splitRatio) * 100} 1 0`, order: 2, minHeight: 0, minWidth: 0 };
    }
    // active
    return { display: 'flex', flex: splitRightTab ? `${splitRatio * 100} 1 0` : '1 1 0', order: 0, minHeight: 0, minWidth: 0 };
  };
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);
  // 탭별로 선택된 패널 ID 기억
  const [selectedPanelByTab, setSelectedPanelByTab] = useState<Record<string, string | null>>({});
  const selectedPanelId = selectedPanelByTab[activeTabId] ?? null;
  const setSelectedPanelId = useCallback((id: string | null) => {
    setSelectedPanelByTab(prev => ({ ...prev, [activeTabId]: id }));
  }, [activeTabId]);
  // 좌우 분할된 워크스페이스(activeTab / splitRightTab) 어느 쪽이든 정확한 탭에 선택 패널을 기록.
  const setSelectedPanelForTab = useCallback((tabId: TabId, id: string | null) => {
    setSelectedPanelByTab(prev => ({ ...prev, [tabId]: id }));
  }, []);
  // 좌우 분할 상태에서 사용자가 마지막으로 클릭/포커스한 쪽의 터미널 탭 — 세션 더블클릭 연결 시
  // activeTab(좌측) 이 아니라 실제 커서가 있던 쪽으로 연결하기 위해 추적. state 로 둬서
  // 포커스된 쪽만 활성 테두리 색으로 표시하는 UI 갱신도 함께 반영.
  const [lastFocusedTerminalTabId, setLastFocusedTerminalTabId] = useState<TabId | null>(null);
  const lastFocusedTerminalTabIdRef = useRef<TabId | null>(null);
  const markFocusedTerminalTab = useCallback((tabId: TabId) => {
    lastFocusedTerminalTabIdRef.current = tabId;
    setLastFocusedTerminalTabId(prev => prev === tabId ? prev : tabId);
  }, []);
  // 탭바에서 탭을 클릭해 활성화할 때 — 그 탭이 이미 splitRightTab 으로 우측에 떠서 화면에
  // 보이고 있으면, 좌우 배치를 건드리지 않고 그대로 둠 (분할 해제도 안 되고, 좌우가 바뀌지도 않음).
  // 화면에 없는 다른 탭을 클릭했을 때만 activeTab 을 그 탭으로 전환.
  const switchActiveTab = useCallback((tabId: TabId) => {
    if (splitRightTabId === tabId) return;
    setActiveTabId(tabId);
  }, [splitRightTabId]);

  // 파일 전송 탭 생성 시 현재 활성 termId 를 즉시 읽는 헬퍼 (getActiveTermId 는 아래 정의)
  // — getActiveTermId 는 activeTab(tabs state) + selectedPanelId + panel.activeIdx 를 참조하므로
  //   미니탭 전환 직후에도 최신 값을 반환한다. useEffect 기반 state 를 쓰면 미니탭 전환 시
  //   selectedPanelId 가 불변이어서 effect 가 재실행되지 않는 문제가 있었음.

  // 앱 구동 시 + 탭 전환 시 해당 탭의 패널 자동 선택 (선택된 패널이 현재 탭에 없을 때)
  useEffect(() => {
    const curTab = tabs.find(t => t.id === activeTabId);
    if (!curTab) return;
    // 현재 selectedPanelId가 이 탭의 레이아웃 안에 있는지 확인
    const findLeaf = (node: any, id: string | null): any => {
      if (!id) return null;
      if (node.type === 'leaf') return node.id === id ? node : null;
      for (const c of node.children) { const r = findLeaf(c, id); if (r) return r; }
      return null;
    };
    const inCurTab = selectedPanelId && findLeaf(curTab.layout, selectedPanelId);
    if (inCurTab) return;
    // 현재 탭의 첫 번째 leaf 찾기
    const findFirstLeaf = (node: any): any => {
      if (node.type === 'leaf') return node;
      for (const c of node.children) { const r = findFirstLeaf(c); if (r) return r; }
      return null;
    };
    const leaf = findFirstLeaf(curTab.layout);
    if (leaf) setSelectedPanelId(leaf.id);
  }, [activeTabId, tabs]);

  // 선택된 패널 변경 시 또는 탭 전환 시 해당 패널의 활성 터미널에 포커스
  useEffect(() => {
    if (!selectedPanelId) return;
    const curTab = tabs.find(t => t.id === activeTabId);
    if (!curTab) return;
    const findLeaf = (node: any, id: string): any => {
      if (node.type === 'leaf') return node.id === id ? node : null;
      for (const c of node.children) { const r = findLeaf(c, id); if (r) return r; }
      return null;
    };
    const leaf = findLeaf(curTab.layout, selectedPanelId);
    if (leaf && leaf.panel.sessions.length > 0) {
      const tid = leaf.panel.sessions[leaf.panel.activeIdx]?.termId;
      if (tid) {
        // 여러 번 시도 (DOM 렌더링 타이밍 대응)
        [50, 150, 300, 500].forEach(ms => setTimeout(() => focusTerm(tid), ms));
      }
    }
  }, [selectedPanelId, activeTabId]);
  const [showSearch, setShowSearch] = useState(false);
  // 비밀번호 저장 권유 모달 — 'ssh-fresh-password-success' 이벤트로 트리거됨
  const [savePwdPrompt, setSavePwdPrompt] = useState<{ termId: string; sessionId: string; password: string; hostHint?: string } | null>(null);
  // 비밀번호 입력 모달들 — 동시에 여러 세션 비밀번호 입력 가능 (단일 모달이 다른 세션
  // 더블클릭을 막지 않도록). 배경은 pointer-events:none 으로 통과시킴.
  type AskPwdItem = { termId: string; sessionId: string; hostHint?: string; userHint?: string; needUsername?: boolean; resolve: (result: any) => void; input: string; userInput: string };
  const [askPwdPrompts, setAskPwdPrompts] = useState<AskPwdItem[]>([]);
  // portal 마운트 타깃(.layout-leaf) 이 활성 세션 변경 후 한 tick 늦게 등장할 수 있어
  // 첫 렌더에서 targetEl=null 이면 다음 frame 에 재시도하기 위한 강제 리렌더 tick.
  const [, setLayoutTick] = useState(0);
  // activeTab.layout 의 active idx 변경 감지를 위한 키 — 모달 표시 위치 갱신용
  // (실제 activeTab 객체는 아래에서 선언됨. 여기선 tabs/activeTabId 만 사용해서 시리얼라이즈)
  const layoutSignature = (() => {
    const t = tabs.find(x => x.id === activeTabId);
    if (!t) return '';
    const walk = (n: any): string => {
      if (n.type === 'leaf') return `${n.id}@${n.panel.activeIdx}:${n.panel.sessions.map((s: any) => s.termId).join(',')}`;
      return n.children.map(walk).join('|');
    };
    return walk(t.layout);
  })();
  useEffect(() => {
    if (askPwdPrompts.length === 0) return;
    let rafId = 0;
    const tick = () => { setLayoutTick(n => n + 1); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    setTimeout(() => cancelAnimationFrame(rafId), 200);
    return () => cancelAnimationFrame(rafId);
  }, [askPwdPrompts.length, selectedPanelId, activeTabId, layoutSignature]);

  // askPwdPrompts 열림/닫힘 시 터미널 포커스 차단 + 입력창 강제 포커스
  useEffect(() => {
    if (askPwdPrompts.length === 0) {
      setTermFocusBlocked(false);
      return;
    }
    setTermFocusBlocked(true);

    const focusInput = () => {
      const input = document.querySelector<HTMLElement>('.ask-pwd-card .ask-pwd-input');
      if (input && document.activeElement !== input) input.focus();
    };

    // 포커스 트랩: 모달 외부로 포커스 이동 시 첫 번째 ask-pwd-input 으로 리다이렉트.
    // 단, 사용자가 명시적으로 다른 텍스트 입력란/편집기에 클릭한 경우는 빼앗지 않음
    // (예: 세션 트리에서 이름 변경 input — 트랩이 막으면 rename 불가).
    const trap = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.ask-pwd-card')) return;
      const tag = target.tagName;
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
      if (isEditable) return; // 다른 입력란은 그대로 둔다
      e.stopImmediatePropagation();
      focusInput();
    };
    document.addEventListener('focusin', trap, true);

    // 포털이 DOM에 마운트되기까지 약간 기다린 후 포커스
    // (createPortal 은 렌더 후 다음 tick 에 DOM 반영)
    const timers = [0, 50, 100].map(ms => setTimeout(focusInput, ms));

    return () => {
      document.removeEventListener('focusin', trap, true);
      timers.forEach(clearTimeout);
    };
  }, [askPwdPrompts.length]);
  useEffect(() => {
    const onFresh = (e: any) => {
      const d = e?.detail || {};
      if (!d.sessionId || typeof d.password !== 'string') return;
      setSavePwdPrompt({ termId: d.termId, sessionId: d.sessionId, password: d.password });
    };
    const onAsk = (e: any) => {
      const d = e?.detail || {};
      if (typeof d.resolve !== 'function') return;
      setAskPwdPrompts(prev => {
        // 같은 termId 가 이미 있으면 교체 (중복 방지)
        const filtered = prev.filter(x => x.termId !== d.termId);
        return [...filtered, { termId: d.termId, sessionId: d.sessionId, hostHint: d.hostHint, userHint: d.userHint, needUsername: !!d.needUsername, resolve: d.resolve, input: '', userInput: d.userHint || '' }];
      });
    };
    window.addEventListener('ssh-fresh-password-success', onFresh as any);
    window.addEventListener('ssh-password-prompt', onAsk as any);
    return () => {
      window.removeEventListener('ssh-fresh-password-success', onFresh as any);
      window.removeEventListener('ssh-password-prompt', onAsk as any);
    };
  }, []);
  const closeAskPwd = (termId: string, password: string | null) => {
    setAskPwdPrompts(prev => {
      const target = prev.find(x => x.termId === termId);
      if (target) {
        // needUsername 모드면 객체로 결과 전달
        const result = password === null ? null
          : (target.needUsername ? { username: target.userInput, password } : password);
        try { target.resolve(result); } catch {}
        setTimeout(() => focusTerm(termId), 0);
      }
      return prev.filter(x => x.termId !== termId);
    });
  };
  const updateAskPwdInput = (termId: string, value: string) => {
    setAskPwdPrompts(prev => prev.map(x => x.termId === termId ? { ...x, input: value } : x));
  };
  const updateAskPwdUserInput = (termId: string, value: string) => {
    setAskPwdPrompts(prev => prev.map(x => x.termId === termId ? { ...x, userInput: value } : x));
  };
  const [themeName, setThemeName] = useState(getCurrentThemeName);
  const [windowTheme, setWindowThemeState] = useState<string>(getCurrentWindowThemeId);
  const handleWindowThemeChange = (id: string) => { applyWindowTheme(id); setWindowThemeState(id); };
  const [uiLang, setUiLang] = useState<string>(getCurrentLanguage());
  const [availableLangs, setAvailableLangs] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const langs: string[] = await (window as any).api?.i18nListLanguages?.() || [];
        // en, ko 우선 + 나머지 추가 순서
        const priority = ['en', 'ko'];
        const head = priority.filter(p => langs.includes(p));
        const rest = langs.filter(l => !priority.includes(l));
        setAvailableLangs([...head, ...rest]);
      } catch {}
    })();
  }, []);
  const [wordSepValue, setWordSepValue] = useState('');
  const [termSettings, setTermSettings] = useState<TerminalSettings>(getTerminalSettings);
  const isOptionsPopout = false; // popout 비활성 — localStorage 격리로 데이터 유실 위험
  const [showOptions, setShowOptions] = useState(false);
  const [showRemoteShare, setShowRemoteShare] = useState(false);
  const [editSessionCtx, setEditSessionCtx] = useState<{ session: any; termId: string; isQuick?: boolean } | null>(null);
  const [editSessionFolders, setEditSessionFolders] = useState<any[]>([]);
  const [optFontFamily, setOptFontFamily] = useState(() => localStorage.getItem('terminalFontFamily') || '');
  const [optFontSize, setOptFontSize] = useState(() => Number(localStorage.getItem('terminalFontSize')) || 14);
  const [availableFonts, setAvailableFonts] = useState<string[]>([]);
  const [optionsTab, setOptionsTab] = useState<'terminal' | 'session' | 'messenger' | 'keybindings'>('terminal');
  const [keybindingsState, setKeybindingsState] = useState<Record<string, string>>({});
  const [keybindingsDraft, setKeybindingsDraft] = useState<Record<string, string>>({});

  // popout=options 모드에선 keybindingsState 로드 후 자동으로 draft 동기화
  useEffect(() => {
    if (isOptionsPopout && Object.keys(keybindingsState).length > 0) {
      setKeybindingsDraft({ ...keybindingsState });
    }
  }, [isOptionsPopout, keybindingsState]);
  const [listeningAction, setListeningAction] = useState<string | null>(null);
  const [keybindingWarning, setKeybindingWarning] = useState<string | null>(null);
  const [sessionsPathDisplay, setSessionsPathDisplay] = useState('');
  const [contextMenuRegistered, setContextMenuRegistered] = useState(false);
  const [, setSftpProgress] = useState<{ filename: string; transferred: number; total: number; direction: string } | null>(null);
  const [availableShells, setAvailableShells] = useState<{ name: string; path: string; icon?: string }[]>([]);
  const [defaultShell, setDefaultShell] = useState<{ name: string; path: string }>({ name: 'Windows PowerShell', path: 'powershell.exe' });
  const [shellPrefsLoaded, setShellPrefsLoaded] = useState<boolean>(false);
  const [optDefaultShellPath, setOptDefaultShellPath] = useState('');
  const [showBroadcast, setShowBroadcast] = useState<boolean>(true);
  const showBroadcastLoadedRef = useRef(false);
  // 사용 가능한 로컬 쉘 목록 로드 + 기본 쉘 설정 로드 + startupCwd
  useEffect(() => {
    Promise.all([
      (window as any).api?.ptyListShells?.().catch(() => []),
      (window as any).api?.getUIPrefs?.().catch(() => ({})),
      (window as any).api?.getStartupCwd?.().catch(() => null),
    ]).then(([shells, prefs, cwd]: [any[], any, string | null]) => {
      if (shells?.length) setAvailableShells(shells);
      let name = prefs?.defaultShellName || shells?.[0]?.name || 'Windows PowerShell';
      // name 으로 shells 목록에서 path 를 찾아 일치시킴 — name/path 불일치 방지
      const matchedShell = shells?.find((s: any) => s.name === name);
      const spath = matchedShell?.path || prefs?.defaultShellPath || shells?.[0]?.path || 'powershell.exe';
      // name 이 shells 목록에 없으면 실제 사용될 shell 의 name 으로 교정 (탭 이름 ↔ 실제 shell 미스매치 방지)
      if (!matchedShell) {
        const resolvedShell = shells?.find((s: any) => s.path === spath) || shells?.[0];
        if (resolvedShell) name = resolvedShell.name;
      }
      if (prefs?.defaultShellName && prefs.defaultShellName !== name) {
        try { (window as any).api?.setUIPrefs?.({ defaultShellName: name }); } catch {}
      }
      setDefaultShell({ name, path: spath });
      setMessengerHidden(!!prefs?.messenger?.hidePresence);
      setShellPrefsLoaded(true);
      // 초기 탭의 세션명/경로/cwd를 업데이트
      setTabs(prev => prev.map((t, i) => {
        if (i !== 0) return t;
        const update = (node: LayoutNode): LayoutNode => {
          if (node.type === 'leaf') {
            return { ...node, panel: { ...node.panel, sessions: node.panel.sessions.map(s =>
              !s.sessionId ? { ...s, sessionName: name, shellPath: spath, shellCwd: cwd || undefined } : s
            )}};
          }
          return { ...node, children: node.children.map(update) } as LayoutNode;
        };
        return { ...t, layout: update(t.layout) };
      }));
    });
  }, []);
  // 앱 시작 시 ui-prefs(config.json) 에서 로드 — sessionData 가 매 실행 분리되어
  // localStorage 가 영속되지 않으므로 IPC 로 영구 저장한다.
  useEffect(() => {
    (async () => {
      try {
        const prefs = await (window as any).api?.getUIPrefs?.();
        if (prefs && typeof prefs.showBroadcast === 'boolean') {
          setShowBroadcast(prefs.showBroadcast);
        }
        if (prefs?.keybindings) {
          loadKeybindings(prefs.keybindings);
          setKeybindingsState(prefs.keybindings);
        }
        if (Array.isArray(prefs?.quickCmds)) setQuickCmds(prefs.quickCmds);
        quickCmdsLoadedRef.current = true;
        if (typeof prefs?.claudeChatWidth === 'number' && prefs.claudeChatWidth >= 280 && prefs.claudeChatWidth <= 1200) {
          setClaudeChatWidth(prefs.claudeChatWidth);
        }
        if (typeof prefs?.claudeChatPinned === 'boolean') {
          setClaudeChatPinned(prefs.claudeChatPinned);
          if (!prefs.claudeChatPinned) setClaudeChatVisible(false);
        }
        if (typeof prefs?.showClaudeChat === 'boolean') {
          setShowClaudeChat(prefs.showClaudeChat);
        }
        if (prefs?.claudeChatView === 'ai' || prefs?.claudeChatView === 'messenger') {
          setClaudeChatView(prefs.claudeChatView);
        }
        if (typeof prefs?.remoteTreeWidth === 'number' && prefs.remoteTreeWidth >= 160 && prefs.remoteTreeWidth <= 800) {
          setRemoteTreeWidth(prefs.remoteTreeWidth);
        }
        if (typeof prefs?.remoteTreePinned === 'boolean') {
          setRemoteTreePinned(prefs.remoteTreePinned);
          if (!prefs.remoteTreePinned) setRemoteTreeVisible(false);
        }
        if (typeof prefs?.terminalPinned === 'boolean') {
          setTerminalPinned(prefs.terminalPinned);
          if (!prefs.terminalPinned) setTerminalVisible(false);
        }
        terminalPinnedLoadedRef.current = true;
        remoteTreeWidthLoadedRef.current = true;
        remoteTreePinnedLoadedRef.current = true;
        claudeChatPinnedLoadedRef.current = true;
        showClaudeChatLoadedRef.current = true;
        claudeChatViewLoadedRef.current = true;
      } catch {}
      showBroadcastLoadedRef.current = true;
    })();
  }, []);
  // 옵션 다이얼로그 열림 시 글로벌 플래그 동기화 (TerminalPanel에서 참조)
  useEffect(() => { setKeybindingListening(showOptions); }, [showOptions]);

  // 터미널 마우스 동작 '등록 정보 대화 상자' → 옵션 다이얼로그 열기
  useEffect(() => {
    const open = () => setShowOptions(true);
    window.addEventListener('open-options', open);
    return () => window.removeEventListener('open-options', open);
  }, []);

  // 단축키 변경 listening 중: window capture phase에서 키 캡처
  useEffect(() => {
    if (!listeningAction) return;
    const captureHandler = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      const combo = keyEventToCombo(ev);
      console.log('[keybind-capture] combo:', combo);
      if (!combo || /^(Ctrl|Alt|Shift|Meta)(\+(Ctrl|Alt|Shift|Meta))*$/.test(combo)) return; // modifier만이면 무시
      // 중복 체크
      const allBindings = { ...DEFAULT_KEYBINDINGS, ...keybindingsDraft };
      const duplicate = Object.entries(allBindings).find(
        ([id, key]) => id !== listeningAction && key === combo
      );
      if (duplicate) {
        const dupLabel = KEYBINDING_LABELS[duplicate[0]] || duplicate[0];
        setKeybindingWarning(tKb('duplicateWarn', { combo, dupLabel }));
        setTimeout(() => setKeybindingWarning(null), 5000);
      } else {
        setKeybindingWarning(null);
      }
      setKeybindingsDraft(prev => ({ ...prev, [listeningAction!]: combo }));
      setListeningAction(null);
    };
    window.addEventListener('keydown', captureHandler, true);
    return () => window.removeEventListener('keydown', captureHandler, true);
  }, [listeningAction, keybindingsDraft]);

  useEffect(() => {
    if (!showBroadcastLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ showBroadcast }); } catch {}
  }, [showBroadcast]);
  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastAppendNewline, setBroadcastAppendNewline] = useState(true);
  const [broadcastScope, setBroadcastScope] = useState<'current' | 'visible' | 'connected'>('visible');
  const [broadcastShowHistory, setBroadcastShowHistory] = useState(false);
  // 빠른 명령 버튼 — 사용자가 미리 정의한 명령을 원클릭으로 전송. UI prefs 에 영속.
  type QuickCmd = { id: string; label: string; cmd: string };
  const [quickCmds, setQuickCmds] = useState<QuickCmd[]>([]);
  const [quickCmdEditor, setQuickCmdEditor] = useState<QuickCmd | null>(null);
  const [quickCmdMenuOpen, setQuickCmdMenuOpen] = useState(false);
  const quickCmdsLoadedRef = useRef(false);
  useEffect(() => {
    if (!quickCmdsLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ quickCmds }); } catch {}
  }, [quickCmds]);
  // 일괄 파일 전송 모달
  const [showBcastFileXfer, setShowBcastFileXfer] = useState(false);
  const [bcastXferPath, setBcastXferPath] = useState(''); // 비우면 세션별 현재 경로 사용
  // source 가 있으면 그 termId(원격 서버) 에서 읽어오는 파일, 없으면 로컬 path
  const [bcastXferFiles, setBcastXferFiles] = useState<{ path: string; isFolder: boolean; sourceTermId?: string; sourceLabel?: string }[]>([]);
  const [bcastXferInProgress, setBcastXferInProgress] = useState(false);
  const [bcastXferLog, setBcastXferLog] = useState<string[]>([]);
  // 원격 소스 picker (일괄 파일 전송 서브 모달)
  const [remotePickerOpen, setRemotePickerOpen] = useState(false);
  // 선택된 세션의 ID (sessionsStore 기준). 실제 SFTP 연결의 termId/connId 는 remotePickerConnId.
  const [remotePickerSessionId, setRemotePickerSessionId] = useState<string>('');
  const [remotePickerConnId, setRemotePickerConnId] = useState<string>('');
  const [remotePickerPath, setRemotePickerPath] = useState<string>('');
  const [remotePickerFiles, setRemotePickerFiles] = useState<{ name: string; isDir: boolean }[]>([]);
  const [remotePickerSelected, setRemotePickerSelected] = useState<Set<string>>(new Set());
  const [remotePickerLoading, setRemotePickerLoading] = useState(false);
  const [remotePickerConnecting, setRemotePickerConnecting] = useState(false);
  const [showManual, setShowManual] = useState(false);
  // 도움말/정보 등 단순 텍스트 모달 (alert 대체 — 스크롤 가능 + 닫을 때 터미널 포커스 복원)
  const [infoModal, setInfoModal] = useState<{ title: string; text: string } | null>(null);
  const [sessionWipeDialog, setSessionWipeDialog] = useState(false);
  const [sessionOrganizeBusy, setSessionOrganizeBusy] = useState(false);
  // 자동 업데이트 상태 모달 (electron-updater)
  const [updateStatus, setUpdateStatus] = useState<any | null>(null);
  // 활성 터미널로 포커스 복원 (모달 닫기 / 빠른연결 닫기 / 외부 영역 클릭 후 등)
  // activeTab/selectedPanelId 는 ref 로 읽음 (선언 순서 의존 회피)
  const restoreTermFocusRef = useRef<() => void>(() => {});
  const restoreTerminalFocus = useCallback(() => {
    restoreTermFocusRef.current();
  }, []);
  const manualHtml = useMemo(() => {
    try { return marked.parse(manualMd) as string; } catch { return `<pre>${tApp('manual.loadFail')}</pre>`; }
  }, []);
  const [remotePickerSessions, setRemotePickerSessions] = useState<any[]>([]); // 전체 세션 리스트
  const [remotePickerFolders, setRemotePickerFolders] = useState<any[]>([]); // 폴더 맵
  // picker 가 새로 만든 임시 SFTP 연결 connId 들 — 모달 닫힐 때 일괄 해제
  const [remotePickerTempConns, setRemotePickerTempConns] = useState<string[]>([]);
  // 자격증명 입력 다이얼로그 — 비밀번호 미저장 세션 연결 실패 시 표시
  const [remotePickerCredPrompt, setRemotePickerCredPrompt] = useState<{ sess: any; jumps: any[] } | null>(null);
  const [remotePickerCredUser, setRemotePickerCredUser] = useState('');
  const [remotePickerCredPass, setRemotePickerCredPass] = useState('');
  const [remotePickerCredShowPass, setRemotePickerCredShowPass] = useState(false);
  const [remotePickerCredConnecting, setRemotePickerCredConnecting] = useState(false);
  const [askPwdShowPass, setAskPwdShowPass] = useState<Record<string, boolean>>({});
  // 비밀번호 모달 드래그 오프셋 — termId 별 (탭 전환해도 위치 기억).
  const [askPwdOffset, setAskPwdOffset] = useState<Record<string, { x: number; y: number }>>({});
  const remotePickerCredUserRef = useRef<HTMLInputElement>(null);
  const remotePickerCredModalRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!remotePickerCredPrompt) {
      setTermFocusBlocked(false);
      return;
    }
    remotePickerCredUserRef.current?.focus();
    const trap = (e: FocusEvent) => {
      const modal = remotePickerCredModalRef.current;
      const input = remotePickerCredUserRef.current;
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
  }, [remotePickerCredPrompt]);

  // picker 가 열릴 때 전체 세션/폴더 로드
  useEffect(() => {
    if (!remotePickerOpen) return;
    (async () => {
      try {
        const data: any = await (window as any).api?.listSessions?.();
        setRemotePickerSessions(data?.sessions || []);
        setRemotePickerFolders(data?.folders || []);
      } catch {}
    })();
  }, [remotePickerOpen]);

  // 세션 선택 변경 시 자동으로 연결 보장 + 파일 리스트 로드
  useEffect(() => {
    if (!remotePickerOpen || !remotePickerSessionId) return;
    let cancelled = false;
    (async () => {
      // 0) 빠른연결 가상 세션 — id 가 termId 와 동일. 모든 워크스페이스의 termId 매치 시 그대로 사용.
      for (const t of tabs) {
        const found = collectAllSessions(t.layout).find(s => s.termId === remotePickerSessionId && isTermConnected(s.termId) && !s.sessionId);
        if (found) {
          if (!cancelled) {
            setRemotePickerConnId(found.termId);
            const pwd = getCurrentPwdForTerm(found.termId) || '/';
            setRemotePickerPath(pwd);
          }
          return;
        }
      }
      // 1) 이미 터미널로 열린 세션이면 그 termId 재사용
      if (activeTab) {
        const open = collectAllSessions(activeTab.layout).find(s => s.sessionId === remotePickerSessionId && isTermConnected(s.termId));
        if (open) {
          if (!cancelled) {
            setRemotePickerConnId(open.termId);
            const pwd = getCurrentPwdForTerm(open.termId) || '/';
            setRemotePickerPath(pwd);
          }
          return;
        }
      }
      // 2) 아니면 백그라운드 SFTP 연결 시도
      const sess = remotePickerSessions.find(s => s.id === remotePickerSessionId);
      if (!sess) return;
      const jumps = buildJumpChain(sess);
      // 비밀번호 미저장 세션 → 자격증명 다이얼로그 먼저 표시
      const hasCredential = sess.auth?.type === 'key' || (sess.auth?.type === 'password' && sess.auth?.password);
      const openRemoteCred = () => {
        setTermFocusBlocked(true); // 렌더 전에 동기 차단
        setRemotePickerCredPrompt({ sess, jumps });
        setRemotePickerCredUser(sess.username || '');
        setRemotePickerCredPass('');
        setRemotePickerCredShowPass(false);
      };
      if (!hasCredential) {
        if (!cancelled) openRemoteCred();
        return;
      }
      setRemotePickerConnecting(true);
      try {
        const connId = `bcast-pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const r: any = await (window as any).api?.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth, undefined, jumps.length ? jumps : undefined);
        if (cancelled) return;
        if (!r?.success) {
          if (!cancelled) { openRemoteCred(); setRemotePickerConnecting(false); }
          return;
        }
        setRemotePickerTempConns(prev => [...prev, connId]);
        setRemotePickerConnId(connId);
        try {
          const home: any = await (window as any).api?.feHomeDir?.('remote', connId);
          const homePath = typeof home === 'string' ? home : (home?.path || '/');
          if (!cancelled) setRemotePickerPath(homePath || '/');
        } catch { if (!cancelled) setRemotePickerPath('/'); }
      } catch {
        if (!cancelled) openRemoteCred();
      }
      if (!cancelled) setRemotePickerConnecting(false);
    })();
    return () => { cancelled = true; };
  }, [remotePickerOpen, remotePickerSessionId, remotePickerSessions]);

  // 경로/connId 기반 파일 리스트 로드
  useEffect(() => {
    if (!remotePickerOpen || !remotePickerConnId || !remotePickerPath) return;
    let cancelled = false;
    (async () => {
      setRemotePickerLoading(true);
      try {
        const r: any = await (window as any).api?.feListDir?.('remote', remotePickerPath, remotePickerConnId);
        if (!cancelled) setRemotePickerFiles(r?.files || []);
      } catch {
        if (!cancelled) setRemotePickerFiles([]);
      }
      if (!cancelled) setRemotePickerLoading(false);
    })();
    return () => { cancelled = true; };
  }, [remotePickerOpen, remotePickerConnId, remotePickerPath]);

  // 모달 닫힐 때 임시 연결 정리
  useEffect(() => {
    if (remotePickerOpen) return;
    if (remotePickerTempConns.length === 0) return;
    for (const cid of remotePickerTempConns) {
      try { (window as any).api?.feSftpDisconnect?.(cid); } catch {}
    }
    setRemotePickerTempConns([]);
  }, [remotePickerOpen]);

  // 자격증명 다이얼로그 확인 — 입력된 id/비밀번호로 SFTP 연결 재시도
  const handleRemotePickerCredSubmit = async () => {
    if (!remotePickerCredPrompt) return;
    const { sess, jumps } = remotePickerCredPrompt;
    setRemotePickerCredConnecting(true);
    const connId = `bcast-pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const r: any = await (window as any).api?.feSftpConnect?.(connId, sess.host, sess.port || 22, remotePickerCredUser, { type: 'password', password: remotePickerCredPass }, undefined, (jumps && jumps.length) ? jumps : undefined);
      if (!r?.success) {
        notifyError(tApp('connect.fail'), tApp('connect.failDetail', { name: sess.name, error: r?.error || tApp('common.unknownError') }));
        setRemotePickerCredConnecting(false);
        return;
      }
      setRemotePickerTempConns(prev => [...prev, connId]);
      setRemotePickerConnId(connId);
      try {
        const home: any = await (window as any).api?.feHomeDir?.('remote', connId);
        const homePath = typeof home === 'string' ? home : (home?.path || '/');
        setRemotePickerPath(homePath || '/');
      } catch { setRemotePickerPath('/'); }
      setRemotePickerCredPrompt(null);
    } catch (err: any) {
      notifyError(tApp('connect.fail'), tApp('connect.failDetail', { name: sess.name, error: err?.message || err }));
    }
    setRemotePickerCredConnecting(false);
  };
  const [broadcastHistoryIdx, setBroadcastHistoryIdx] = useState(-1);
  // 히스토리 드롭다운에서 방향키로 이동한 항목이 보이게 스크롤 따라오기
  useEffect(() => {
    if (!broadcastShowHistory || broadcastHistoryIdx < 0) return;
    const active = document.querySelector('.broadcast-history-dropdown .broadcast-history-item.active');
    if (active instanceof HTMLElement) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [broadcastHistoryIdx, broadcastShowHistory]);
  const [splitSessionPicker, setSplitSessionPicker] = useState<{
    dir: 'row' | 'column';
    sessions: { sessionId: string; sessionName: string; host: string; termId: string; folderId?: string; icon?: string }[];
    folders: { id: string; name: string; parentId?: string }[];
    srcTermId?: string;
    targetNodeId: string;
    targetTabId: TabId;
  } | null>(null);
  const [splitPickerCollapsed, setSplitPickerCollapsed] = useState<Set<string>>(new Set());

  // 세션 선택 picker prefix 키 핸들러 — 파일 트리와 동일한 동작 (folder + session 가시 항목 순회, startsWith, 같은 키 반복 시 순환)
  const splitPickerLastSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!splitSessionPicker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSplitSessionPicker(null); e.preventDefault(); e.stopPropagation(); return; }
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
      const { sessions, folders } = splitSessionPicker;
      // 폴더 + 세션 모두 가시 순서대로 flatten (트리에 보이는 그대로)
      const items: { id: string; name: string; type: 'folder' | 'session'; data?: any }[] = [];
      const walk = (parentId?: string) => {
        const subF = folders.filter(f => (f.parentId ?? undefined) === (parentId ?? undefined));
        for (const f of subF) {
          items.push({ id: f.id, name: f.name, type: 'folder' });
          if (!splitPickerCollapsed.has(f.id)) walk(f.id);
        }
        const subS = sessions.filter(s => (s.folderId ?? undefined) === (parentId ?? undefined));
        for (const s of subS) {
          items.push({ id: s.sessionId, name: s.sessionName, type: 'session', data: s });
        }
      };
      walk(undefined);
      const ch = e.key.toLowerCase();
      const lastId = splitPickerLastSelectedRef.current;
      const curIdx = lastId ? items.findIndex(it => it.id === lastId) : -1;
      let target = -1;
      for (let i = 1; i <= items.length; i++) {
        const idx = (curIdx + i) % items.length;
        if (items[idx].name.toLowerCase().startsWith(ch)) { target = idx; break; }
      }
      if (target < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const it = items[target];
      splitPickerLastSelectedRef.current = it.id;
      setTimeout(() => {
        const sel = it.type === 'session'
          ? `.folder-picker .folder-picker-item[data-sid="${CSS.escape(it.id)}"]`
          : `.folder-picker .folder-picker-item.folder-row[data-fid="${CSS.escape(it.id)}"]`;
        const el = document.querySelector(sel) as HTMLElement | null;
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        el?.classList.add('picker-highlight');
        setTimeout(() => el?.classList.remove('picker-highlight'), 800);
      }, 0);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [splitSessionPicker, splitPickerCollapsed]);
  const [floatingPanelId, setFloatingPanelId] = useState<string | null>(null);
  const [remoteTreeWidth, setRemoteTreeWidth] = useState<number>(240);
  const remoteTreeWidthLoadedRef = useRef(false);
  const [remoteTreePinned, setRemoteTreePinned] = useState<boolean>(true);
  const [remoteTreeVisible, setRemoteTreeVisible] = useState<boolean>(true);
  const [terminalPinned, setTerminalPinned] = useState<boolean>(true);
  const [terminalVisible, setTerminalVisible] = useState<boolean>(true);
  const terminalPinnedLoadedRef = useRef(false);
  const terminalHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalHoverShowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 어느 오버레이가 최상위인지 — hover 중인 쪽이 다른 쪽 위에 오도록
  const [topPanel, setTopPanel] = useState<'session' | 'filetree' | null>(null);
  const remoteTreePinnedLoadedRef = useRef(false);
  const remoteTreeHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteTreeHoverShowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 세션 트리거 top 버튼 하단 y 좌표 (파일 트리 트리거의 top 위치 맞추기용)
  const [fileTreeTriggerTop, setFileTreeTriggerTop] = useState<number>(135);
  // 파일트리 패널의 top 오프셋 — 세션 사이드바(pinned)와 픽셀 단위로 정확히 맞추기 위해
  // "타이틀바(.tab-bar-row) 바로 아래" 위치를 직접 측정해서 사용 (CSS padding/margin 계산에 의존하지 않음).
  const [fileTreePanelTop, setFileTreePanelTop] = useState<number>(40);
  // 파일트리 패널의 left 오프셋 — 트리거의 실제 오른쪽 끝(getBoundingClientRect().right)을 측정.
  // 세션 사이드바가 pinned(실제 폭 차지)면 트리거가 그만큼 오른쪽에 있으므로, 하드코딩된 22px 로는
  // 안 맞음 — 트리거 우측 끝을 그대로 패널의 left 로 사용해서 항상 트리거 바로 오른쪽에서 열리게 함.
  const [fileTreePanelLeft, setFileTreePanelLeft] = useState<number>(22);
  // 세션 사이드바가 unpinned(auto-hide, 접힘) 상태인지 감지 — 접혀 있을 땐 파일트리 트리거를
  // 세션 트리거 바로 아래 같은 컬럼(x=0)에 세로로 스택시켜야 함 (세션 사이드바 pin 상태는
  // SessionList 내부 로컬 state 라 App 에서 직접 접근 불가 → DOM 감지).
  const [sessionSidebarUnpinned, setSessionSidebarUnpinned] = useState<boolean>(false);
  // 위 4개 측정을 body 를 각자 감시하는 MutationObserver 4개 대신 하나로 묶어서 오버헤드를 줄임.
  useEffect(() => {
    const measure = () => {
      const triggerEl = document.querySelector('.session-sidebar-trigger-top') as HTMLElement | null;
      if (triggerEl) setFileTreeTriggerTop(triggerEl.getBoundingClientRect().bottom);
      const tabBarEl = document.querySelector('.tab-bar-row') as HTMLElement | null;
      if (tabBarEl) setFileTreePanelTop(tabBarEl.getBoundingClientRect().bottom);
      const fileTreeTriggerEl = document.querySelector('.global-file-tree-wrap .workspace-file-tree-trigger') as HTMLElement | null;
      if (fileTreeTriggerEl) setFileTreePanelLeft(fileTreeTriggerEl.getBoundingClientRect().right);
      setSessionSidebarUnpinned(!!document.querySelector('.session-sidebar-inner.auto-hide'));
    };
    measure();
    const t1 = setTimeout(measure, 100);
    const t2 = setTimeout(measure, 500);
    window.addEventListener('resize', measure);
    const mo = new MutationObserver(measure);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true });
    return () => {
      clearTimeout(t1); clearTimeout(t2);
      window.removeEventListener('resize', measure);
      mo.disconnect();
    };
  }, []);
  useEffect(() => {
    if (!remoteTreePinnedLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ remoteTreePinned }); } catch {}
    if (remoteTreePinned) setRemoteTreeVisible(true);
  }, [remoteTreePinned]);
  useEffect(() => {
    if (!terminalPinnedLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ terminalPinned }); } catch {}
    if (terminalPinned) setTerminalVisible(true);
    [50, 200, 500].forEach(ms => setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
      refitAllTerms();
    }, ms));
  }, [terminalPinned]);
  const [showClaudeChat, setShowClaudeChat] = useState(true);
  const [claudeChatView, setClaudeChatView] = useState<'ai' | 'messenger'>('ai');
  const claudeChatViewLoadedRef = useRef(false);
  const [messengerPopup, setMessengerPopup] = useState<{
    peerId: string;
    peerName: string;
    text: string;
    ts: number;
    style: 'toast' | 'center';
    holdSec: number;
  } | null>(null);
  // 팝업을 클릭/포커스했는지 — true 면 유지시간과 무관하게 계속 표시.
  const [messengerPopupEngaged, setMessengerPopupEngaged] = useState(false);
  const messengerPopupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [messengerReplyText, setMessengerReplyText] = useState('');
  const [messengerAttention, setMessengerAttention] = useState(false);
  const [messengerUnreadCount, setMessengerUnreadCount] = useState(0);
  const [messengerHidden, setMessengerHidden] = useState(false);
  // 외부 워크스페이스의 prefill 요청 시 채팅창 자동 열기
  useEffect(() => {
    const onPrefill = () => setShowClaudeChat(true);
    window.addEventListener('claude-prefill', onPrefill);
    return () => window.removeEventListener('claude-prefill', onPrefill);
  }, []);
  const [claudeChatWidth, setClaudeChatWidth] = useState<number>(360);
  const [claudeChatPinned, setClaudeChatPinned] = useState<boolean>(false);
  const [claudeChatVisible, setClaudeChatVisible] = useState<boolean>(false);
  const showClaudeChatLoadedRef = useRef(false);
  const claudeChatPinnedLoadedRef = useRef(false);
  const claudeChatHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const claudeChatHoverShowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!showClaudeChatLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ showClaudeChat }); } catch {}
  }, [showClaudeChat]);
  useEffect(() => {
    if (!claudeChatViewLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ claudeChatView }); } catch {}
  }, [claudeChatView]);
  useEffect(() => {
    const onMessengerEvent = (p: any) => {
      // 모든 이벤트에서 prefs(나의 접속 숨기기) 동기화 — 상단 상태 표시 LED/문구 반영.
      if (p?.state?.prefs) setMessengerHidden(!!p.state.prefs.hidePresence);
      if (p?.type !== 'message' || p?.message?.direction !== 'in') return;
      setMessengerAttention(true);
      const peerId = String(p.message.peerId || '');
      const peerName = String(p.state?.peers?.find?.((x: any) => x.id === peerId)?.name || peerId || tApp('messenger.defaultPeerName'));
      const text = p.message.kind === 'file'
        ? tApp('messenger.filePrefix', { name: p.message.fileName || tApp('messenger.attachedFile') })
        : String(p.message.text || '');
      const messengerVisible = showClaudeChat && claudeChatView === 'messenger' && (claudeChatPinned || claudeChatVisible);
      if (messengerVisible) return;
      setMessengerUnreadCount(c => c + 1);
      (async () => {
        const prefs = await (window as any).api?.getUIPrefs?.().catch(() => ({}));
        const m = prefs?.messenger || {};
        const popupEnabled = m.popupNotify !== false;
        if (!popupEnabled) return;
        const rawStyle = m.popupStyle;
        const popupStyle: 'toast' | 'center' = (rawStyle === 'center' || rawStyle === 'edge') ? 'center' : 'toast';
        const holdRaw = Number(m.popupHoldSec);
        const holdSec = Number.isFinite(holdRaw) && holdRaw >= 0 ? holdRaw : 5;
        setMessengerPopupEngaged(false);
        setMessengerPopup({ peerId, peerName, text, ts: Number(p.message.ts) || Date.now(), style: popupStyle, holdSec });
        setMessengerReplyText('');
      })();
    };
    const off = (window as any).api?.onMessengerEvent?.(onMessengerEvent);
    return () => { if (off) off(); };
  }, [showClaudeChat, claudeChatView, claudeChatPinned, claudeChatVisible]);
  useEffect(() => {
    if (!claudeChatPinnedLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ claudeChatPinned }); } catch {}
    if (claudeChatPinned) setClaudeChatVisible(true);
    // 레이아웃 변경 → 터미널 재측정
    [50, 200, 500].forEach(ms => setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
      refitAllTerms();
    }, ms));
  }, [claudeChatPinned]);
  useEffect(() => {
    if (showClaudeChat && claudeChatView === 'messenger' && (claudeChatPinned || claudeChatVisible)) {
      setMessengerPopup(null);
      setMessengerReplyText('');
      setMessengerAttention(false);
      setMessengerUnreadCount(0);
    }
  }, [showClaudeChat, claudeChatView, claudeChatPinned, claudeChatVisible]);
  const openClaudeChatView = (view: 'ai' | 'messenger') => {
    setShowClaudeChat(true);
    setClaudeChatView(view);
    if (!claudeChatPinned) setClaudeChatVisible(true);
    if (view === 'messenger') {
      setMessengerAttention(false);
      setMessengerUnreadCount(0);
      setMessengerPopup(null);
      setMessengerReplyText('');
    }
  };
  const dismissMessengerPopup = () => {
    setMessengerPopup(null);
    setMessengerReplyText('');
    setMessengerPopupEngaged(false);
  };
  // 팝업 자동 닫힘 — 유지시간(초) 경과 시. 0 이면 무한 유지. 클릭/포커스(engaged) 시 타이머 해제.
  useEffect(() => {
    if (messengerPopupTimerRef.current) { clearTimeout(messengerPopupTimerRef.current); messengerPopupTimerRef.current = null; }
    if (!messengerPopup) return;
    if (messengerPopupEngaged) return;
    if (!messengerPopup.holdSec || messengerPopup.holdSec <= 0) return;
    messengerPopupTimerRef.current = setTimeout(() => {
      setMessengerPopup(null);
      setMessengerReplyText('');
    }, messengerPopup.holdSec * 1000);
    return () => { if (messengerPopupTimerRef.current) { clearTimeout(messengerPopupTimerRef.current); messengerPopupTimerRef.current = null; } };
  }, [messengerPopup, messengerPopupEngaged]);
  const sendMessengerPopupReply = async () => {
    if (!messengerPopup || !messengerReplyText.trim()) return;
    const body = messengerReplyText.trim();
    const res = await (window as any).api?.messengerSendMessage?.(messengerPopup.peerId, body);
    if (res?.success) {
      dismissMessengerPopup();
    } else {
      try { notifyError(tMsg('replyFail'), String(res?.error || 'unknown')); } catch {}
    }
  };
  // 사이드바 너비 드래그 중인지 — 드래그 중엔 매 픽셀 refit 을 건너뛰어 버벅임 방지 (종료 시 1회만 refit)
  const chatResizingRef = useRef(false);
  // 너비/표시 변경 시에도 터미널 리핏 — 드래그 중이면 skip
  useEffect(() => {
    if (chatResizingRef.current) return;
    [50, 200].forEach(ms => setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
      refitAllTerms();
    }, ms));
  }, [claudeChatWidth, showClaudeChat]);
  const [claudeFileContext, setClaudeFileContext] = useState<{ fileName: string; remotePath: string; content: string }[] | null>(null);
  const [aiAgent, setAiAgent] = useState<'claude' | 'gemini' | 'codex' | 'custom' | 'antigravity'>('claude');
  // WebDAV 마운트 첨부 엔트리
  const [claudeMountEntries, setClaudeMountEntries] = useState<{ termId: string; remotePath: string; uncPath: string; isDir: boolean }[]>([]);
  // 연결 상태 변경 tick — 아래 영속화 effect 가 새 SSH 연결을 감지하도록 미리 선언.
  const [connectedTick, setConnectedTick] = useState(0);
  // 세션별 첨부 프리셋(영속화) — key = 저장된 sessionId, value = remotePath/isDir 목록.
  // 세션 재선택 시 자동 복원. termId/uncPath 는 매 연결마다 바뀌므로 저장하지 않음.
  type MountPreset = { remotePath: string; isDir: boolean };
  const [mountPresetsBySession, setMountPresetsBySession] = useState<Record<string, MountPreset[]>>({});
  const mountPresetsLoadedRef = useRef(false);
  // prefs 에서 1회 로드
  useEffect(() => {
    (async () => {
      try {
        const prefs = await (window as any).api?.getUIPrefs?.();
        const m = prefs?.claudeMountPresetsBySession;
        if (m && typeof m === 'object') setMountPresetsBySession(m);
      } catch {}
      mountPresetsLoadedRef.current = true;
    })();
  }, []);
  // 현재 claudeMountEntries 가 변할 때마다 prefs 에 저장 (sessionId 가 있는 세션만 — quick connect 제외)
  useEffect(() => {
    if (!mountPresetsLoadedRef.current) return;
    const next: Record<string, MountPreset[]> = { ...mountPresetsBySession };
    // 현재 entries 를 sessionId 단위로 그룹화
    const grouped = new Map<string, MountPreset[]>();
    for (const e of claudeMountEntries) {
      const info = getTermSessionInfo(e.termId);
      const sid = info?.sessionId;
      if (!sid) continue; // 저장된 세션이 아니면 영속화 안 함
      const arr = grouped.get(sid) || [];
      arr.push({ remotePath: e.remotePath, isDir: e.isDir });
      grouped.set(sid, arr);
    }
    // 현재 화면에서 보인 sessionId 들의 preset 만 갱신 (다른 세션 preset 은 보존)
    let changed = false;
    for (const [sid, arr] of grouped) {
      const prev = next[sid];
      const same = prev && prev.length === arr.length && prev.every((p, i) => p.remotePath === arr[i].remotePath && p.isDir === arr[i].isDir);
      if (!same) { next[sid] = arr; changed = true; }
    }
    // 현재 연결된 세션이지만 entry 가 비었으면 preset 도 제거 — 사용자가 모두 지운 경우
    const liveSessionIds = new Set<string>();
    for (const e of claudeMountEntries) {
      const info = getTermSessionInfo(e.termId);
      if (info?.sessionId) liveSessionIds.add(info.sessionId);
    }
    // (claudeMountEntries 에 등장하지 않더라도 연결된 세션의 preset 은 그대로 둠 — 화면에 안 보이는 다른 세션 보존)
    void liveSessionIds;
    if (changed) {
      setMountPresetsBySession(next);
      try { (window as any).api?.setUIPrefs?.({ claudeMountPresetsBySession: next }); } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeMountEntries]);
  // 연결된 세션 termId 가 등장하면 그 sessionId 의 preset 으로 entries 복원
  // (이미 같은 sessionId 의 entry 가 화면에 있으면 skip)
  useEffect(() => {
    if (!mountPresetsLoadedRef.current) return;
    if (Object.keys(mountPresetsBySession).length === 0) return;
    // 현재 화면에 연결된 모든 termId 수집
    const connectedTermIds: string[] = [];
    const walk = (n: any) => {
      if (n.type === 'leaf') {
        for (const s of (n.panel?.sessions || [])) {
          if (s.termId && isTermConnected(s.termId)) connectedTermIds.push(s.termId);
        }
      } else if (n.children) for (const c of n.children) walk(c);
    };
    for (const t of tabs) walk(t.layout);
    if (connectedTermIds.length === 0) return;
    // 각 termId 의 sessionId 가 preset 을 가지면 자동 복원 (이미 화면에 있는 entry 는 dedup)
    setClaudeMountEntries(prev => {
      const exists = new Set(prev.map(e => `${e.termId}|${e.remotePath}`));
      const additions: typeof prev = [];
      for (const termId of connectedTermIds) {
        const info = getTermSessionInfo(termId);
        const sid = info?.sessionId;
        if (!sid) continue;
        // 이 termId 의 prev entries 가 이미 있으면 복원 skip (사용자가 직접 지운 상태일 수 있음)
        if (prev.some(e => e.termId === termId)) continue;
        const presets = mountPresetsBySession[sid];
        if (!presets || presets.length === 0) continue;
        for (const p of presets) {
          const key = `${termId}|${p.remotePath}`;
          if (exists.has(key)) continue;
          // uncPath 는 더 이상 사용하지 않으므로 빈 값. ClaudeChat 은 remotePath 기준으로 동작.
          additions.push({ termId, remotePath: p.remotePath, uncPath: '', isDir: p.isDir });
          exists.add(key);
        }
      }
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountPresetsBySession, tabs, connectedTick]);
  const [claudeAttaching, setClaudeAttaching] = useState<{ message: string; progress: number; total: number } | null>(null);
  // 글로벌 연결 상태 변경시 일괄전송 카운트 등 재계산을 위해 강제 리렌더 (connectedTick 은 위에 선언됨)
  useEffect(() => subscribeConnectedChange(() => setConnectedTick(n => n + 1)), []);
  const connectedBrowserSessions = useMemo(() => {
    const out: { panelId: string; sessionId?: string; sessionName?: string; host?: string; port?: number }[] = [];
    const seen = new Set<string>();
    const walk = (n: any) => {
      if (n.type === 'leaf') {
        for (const s of (n.panel?.sessions || [])) {
          if (!s.termId || !isTermConnected(s.termId) || !s.sessionId) continue;
          const key = s.sessionId;
          if (seen.has(key)) continue;
          const info = getTermSessionInfo(s.termId);
          out.push({
            panelId: s.termId,
            sessionId: s.sessionId,
            sessionName: info?.sessionName || s.sessionName || info?.host || s.termId,
            host: info?.host,
            port: (info as any)?.port,
          });
          seen.add(key);
        }
      } else if (n.children) {
        for (const c of n.children) walk(c);
      }
    };
    for (const t of tabs) walk(t.layout);
    return out;
  }, [tabs, connectedTick]);
  const connectedWebdavRestoreInitRef = useRef(false);
  const prevConnectedWebdavTermIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Map<string, { termId: string; sessionId?: string; label: string }>();
    for (const t of tabs) {
      for (const s of collectAllSessions(t.layout)) {
        if (!s.termId || !isTermConnected(s.termId)) continue;
        const info = getTermSessionInfo(s.termId);
        const label = info?.sessionName || s.sessionName || info?.host || s.termId;
        current.set(s.termId, { termId: s.termId, sessionId: info?.sessionId, label });
      }
    }
    const currentIds = new Set(current.keys());
    if (!connectedWebdavRestoreInitRef.current) {
      connectedWebdavRestoreInitRef.current = true;
      prevConnectedWebdavTermIdsRef.current = currentIds;
      return;
    }
    const added = [...currentIds].filter(termId => !prevConnectedWebdavTermIdsRef.current.has(termId)).map(termId => current.get(termId)!);
    prevConnectedWebdavTermIdsRef.current = currentIds;
    if (added.length === 0) return;
    console.log('[App][ClaudeWebDAV] connected session(s) added', {
      added,
    });
    window.dispatchEvent(new CustomEvent('claude-webdav-auto-restore', {
      detail: { sessions: added },
    }));
  }, [tabs, connectedTick]);
  // 세션 설정 변경 (X11 forwarding 등) 이벤트 — 활성 연결을 즉시 재접속해서 새 설정 반영
  useEffect(() => {
    const onSettingChanged = (e: any) => {
      const d = e?.detail || {};
      if (!d.sessionId || !d.requiresReconnect) return;
      const sessionId: string = d.sessionId;
      // 현재 모든 탭에서 이 sessionId 로 연결된 termId 수집 (안내용)
      let affectedCount = 0;
      for (const t of tabsRef.current) {
        if (t.type === 'fileExplorer' || t.type === 'fileEditor') continue;
        for (const s of collectAllSessions(t.layout)) {
          if (s.sessionId === sessionId && (isTermConnected(s.termId) || isTermConnecting(s.termId))) {
            affectedCount += 1;
          }
        }
      }
      if (affectedCount === 0) return;
      // 자동 재접속 안 함 — 안내만 (SSH X11 은 shell 채널 생성 시점에 설정되므로 재접속 필요)
      showToast(tApp('x11.settingChanged', { count: affectedCount }), 6000);
    };
    window.addEventListener('session-setting-changed', onSettingChanged as any);
    return () => window.removeEventListener('session-setting-changed', onSettingChanged as any);
  }, []);
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    (window as any).api?.windowIsMaximized?.().then((m: boolean) => setIsMaximized(!!m)).catch(() => {});
    const off = (window as any).api?.onWindowMaximized?.((m: boolean) => setIsMaximized(!!m));
    return () => { try { off?.(); } catch {} };
  }, []);
  // Claude 채팅 전용 폰트/크기 — 터미널과 독립 설정 (src/utils/claudeFont)
  const [claudeFontFamily, setClaudeFontFamilyState] = useState(() => getClaudeFontFamily());
  const [claudeFontSize, setClaudeFontSizeState] = useState(() => getClaudeFontSize());
  useEffect(() => { applyClaudeFontVars(); }, []);
  // ClaudeChat 의 Ctrl+Wheel 이 외부에서 변경 시 옵션 창 값 동기화용
  useEffect(() => {
    const onChange = () => {
      setClaudeFontFamilyState(getClaudeFontFamily());
      setClaudeFontSizeState(getClaudeFontSize());
    };
    window.addEventListener('claude-font-changed', onChange);
    return () => window.removeEventListener('claude-font-changed', onChange);
  }, []);
  // main 프로세스 디버그 로그를 DevTools Console 로 포워딩
  useEffect(() => {
    const off = (window as any).api?.onDebugLog?.((msg: string) => {
      // eslint-disable-next-line no-console
      console.log('%c[main]', 'color:#8ab4f8', msg);
    });
    return () => { try { off?.(); } catch {} };
  }, []);
  const [fullscreenTermId, setFullscreenTermId] = useState<string | null>(null);
  const fsWasMaxRef = useRef(false);
  const [showQuickConnect, setShowQuickConnect] = useState(() => {
    const v = localStorage.getItem('showQuickConnect');
    return v === null ? true : v === '1';
  });
  useEffect(() => { localStorage.setItem('showQuickConnect', showQuickConnect ? '1' : '0'); }, [showQuickConnect]);

  // 도구 모음 바 위치 슬롯
  type ToolbarSlot = 'top' | 'qc-left' | 'qc-right';
  const [toolbarSlot, setToolbarSlot] = useState<ToolbarSlot>(() => {
    try { const s = localStorage.getItem('toolbarSlot') as ToolbarSlot | null; if (s === 'top' || s === 'qc-left' || s === 'qc-right') return s; } catch {}
    return 'qc-right';
  });
  useEffect(() => { try { localStorage.setItem('toolbarSlot', toolbarSlot); } catch {} }, [toolbarSlot]);
  const [toolbarDragHint, setToolbarDragHint] = useState<ToolbarSlot | null>(null);
  // (qcWidth 제거됨 — QC 바는 항상 자연 너비)
  useEffect(() => { try { localStorage.removeItem('qcWidth'); } catch {} }, []);
  // 도구모음 바 표시/숨기기
  const [showToolbar, setShowToolbar] = useState<boolean>(() => {
    try { const v = localStorage.getItem('showToolbar'); if (v === '0') return false; } catch {}
    return true;
  });
  useEffect(() => { try { localStorage.setItem('showToolbar', showToolbar ? '1' : '0'); } catch {} }, [showToolbar]);

  // 인라인 토스트 알림 (alert 대체)
  const showToast = useCallback((msg: string, duration = 3000) => {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed', bottom: '60px', left: '50%', transform: 'translateX(-50%)',
      background: '#1a1a2e', color: '#eee', padding: '8px 18px', borderRadius: '6px',
      fontSize: '13px', zIndex: '9999', border: '1px solid #444', whiteSpace: 'nowrap',
    });
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, duration);
  }, []);

  // fs-visible class 는 Layout 컴포넌트가 fullscreenTermId prop 으로 직접 className 에 포함시킴
  // (이전엔 querySelector + classList 조작 → React 의 rerender 가 className 을 통째로 교체할 때 fs-visible 이 사라지는 버그 있었음)

  // 윈도우 포커스 복귀 시 터미널 자동 포커스 (alt-tab 등으로 돌아올 때)
  useEffect(() => {
    const onWinFocus = () => {
      // 활성 요소가 input/textarea/contenteditable 이면 그쪽 포커스 유지
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      restoreTerminalFocus();
    };
    window.addEventListener('focus', onWinFocus);
    return () => window.removeEventListener('focus', onWinFocus);
  }, [restoreTerminalFocus]);

  // 모달/오버레이 상태가 모두 닫힐 때 자동으로 터미널 포커스 복원.
  // 닫힘 트랜지션 검출용으로 이전 상태를 ref 에 저장.
  const overlayOpenRef = useRef(false);
  useEffect(() => {
    // showQuickConnect / showBroadcast 는 영구 toolbar 가시성 (focus 안 뺏음) — 제외
    const anyOpen = !!(showOptions || showManual || infoModal);
    if (overlayOpenRef.current && !anyOpen) {
      // 직전엔 오버레이가 열려있었고, 지금은 다 닫힘 → 터미널 포커스 복원
      restoreTerminalFocus();
    }
    overlayOpenRef.current = anyOpen;
  }, [showOptions, showManual, infoModal, restoreTerminalFocus]);

  // 자동 업데이트 상태 구독 — 메인 프로세스 electron-updater 이벤트 수신
  useEffect(() => {
    const api = (window as any).api;
    if (!api?.onUpdaterStatus) return;
    const off = api.onUpdaterStatus((payload: any) => {
      setUpdateStatus((prev: any) => {
        // 자동(시작 시) 확인은 업데이트가 없거나 확인 중이면 모달을 띄우지 않음 (조용히)
        if (!payload?.manual && (payload.state === 'not-available' || payload.state === 'checking' || payload.state === 'unsupported')) {
          return prev;
        }
        return payload;
      });
    });
    return off;
  }, []);

  // 미니탭 우클릭 → '세션 편집' 이벤트 수신
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.sessionId && !detail?.quickSession) return;
      try {
        const data = await (window as any).api?.listSessions?.();
        const all = data?.sessions ?? data ?? [];
        const flds = data?.folders ?? [];
        if (detail.quickSession) {
          const q = detail.quickSession;
          setEditSessionCtx({
            session: {
              id: `quick-${detail.termId || Date.now()}`,
              name: q.name || detail.sessionName || q.host || 'Quick Connect',
              host: q.host || '',
              port: q.port || 22,
              username: q.username || '',
              auth: q.auth || { type: 'password', password: '' },
              encoding: q.encoding || 'utf-8',
            },
            termId: detail.termId,
            isQuick: true,
          });
          setEditSessionFolders(flds);
          return;
        }
        const sess = all.find((x: any) => x.id === detail.sessionId);
        if (sess) {
          setEditSessionCtx({ session: sess, termId: detail.termId });
          setEditSessionFolders(flds);
        }
      } catch {}
    };
    window.addEventListener('open-session-editor', handler);
    return () => window.removeEventListener('open-session-editor', handler);
  }, []);

  // 세션 변경 사항을 활성 터미널에 실시간 반영
  const applySessionToTerm = (s: any, termId: string) => {
    try {
      if (s.theme) applyThemeToTerm(termId, s.theme);
      if (s.fontFamily || s.fontSize) applyFontToTerm(termId, s.fontFamily, s.fontSize);
      if (typeof s.scrollback === 'number') applyScrollbackToTerm(termId, s.scrollback);
      applyCursorStyleToTerm(termId, s.cursorStyle || 'block', !!s.cursorBlink);
      setTermBackspaceMode(termId, s.backspaceKeyMode);
      setTermDeleteMode(termId, s.deleteKeyMode);
    } catch (e) { console.error('[applySessionToTerm]', e); }
  };

  const applySavedSessionToTerm = (s: any, termId: string) => {
    registerTermSession(termId, s.id, s.name, s.host ?? '');
    setTabs(prev => prev.map(tab => ({
      ...tab,
      layout: (function walk(node: LayoutNode): LayoutNode {
        if (node.type === 'leaf') {
          const sessions = node.panel.sessions.map(sess =>
            sess.termId === termId ? { ...sess, sessionId: s.id, sessionName: s.name } : sess
          );
          return { ...node, panel: { ...node.panel, sessions } };
        }
        return { ...node, children: node.children.map(walk) };
      })(tab.layout),
    })));
    applySessionToTerm(s, termId);
  };

  // 외부 검색 창 IPC — listener 는 한 번만 등록, 최신 tabs/activeTab 은 ref 로 참조
  // (활성 useState/useEffect 들이 모두 선언된 후 — activeTab 은 아래에서 계산되므로 lazy init)
  const searchStateRef = useRef<any>({ tabs: [], activeTab: null, lastQuery: '', lastCs: false, lastRe: false, lastMode: 'current' as 'current' | 'all' });
  useEffect(() => {
    const api = (window as any).api;
    if (!api) return;
    const getActiveTermIdLocal = (): string | null => {
      try {
        const selInner = document.querySelector('.layout-leaf-inner.selected') as HTMLElement | null;
        const tid = selInner?.parentElement?.getAttribute('data-active-term');
        if (tid) return tid;
      } catch {}
      const ct = searchStateRef.current.activeTab;
      if (!ct) return null;
      return collectAllSessions(ct.layout)[0]?.termId || null;
    };
    const getAllVisibleTermIds = (): string[] => {
      const ids: string[] = [];
      for (const tab of searchStateRef.current.tabs) {
        if (tab.type === 'fileExplorer' || tab.type === 'fileEditor') continue;
        for (const s of collectAllSessions(tab.layout)) ids.push(s.termId);
      }
      return ids;
    };
    const st = searchStateRef.current;
    const runSearch = (q: string, ureg: boolean, cs: boolean, mode: 'current' | 'all') => {
      st.lastQuery = q; st.lastCs = cs; st.lastRe = ureg; st.lastMode = mode;
      // 모든 터미널의 기존 하이라이트 정리
      for (const t of getAllTermIds()) { try { clearHighlights(t); } catch {} }
      if (!q) {
        for (const t of getAllVisibleTermIds()) { try { clearSearchInTerm(t); } catch {} }
        api.sendSearchResult?.({ current: 0, total: 0 });
        return;
      }
      if (mode === 'current') {
        const tid = getActiveTermIdLocal();
        if (!tid) { api.sendSearchResult?.({ current: 0, total: 0 }); return; }
        try {
          highlightAllMatches(tid, q, ureg, cs);
          const found = searchFromTop(tid, q, ureg, cs);
          api.sendSearchResult?.({ current: found ? 1 : 0, total: found ? 1 : 0 });
        } catch {}
      } else {
        let totalTerms = 0;
        for (const tid of getAllVisibleTermIds()) {
          try {
            highlightAllMatches(tid, q, ureg, cs);
            if (searchInTerm(tid, q, ureg, cs)) totalTerms++;
          } catch {}
        }
        api.sendSearchResult?.({ current: totalTerms > 0 ? 1 : 0, total: totalTerms });
      }
    };
    const offQ = api.onSearchQuery?.((p: { q: string; caseSensitive: boolean; useRegex: boolean; mode?: 'current' | 'all' }) => {
      console.log('[search-debug] query received:', p, 'activeTermId=', getActiveTermIdLocal(), 'allIds=', getAllVisibleTermIds());
      runSearch(p.q, p.useRegex, p.caseSensitive, p.mode || 'current');
    });
    const offN = api.onSearchNext?.((p?: { mode?: 'current' | 'all' }) => {
      if (!st.lastQuery) return;
      const mode = p?.mode || st.lastMode;
      if (mode === 'current') {
        const tid = getActiveTermIdLocal();
        if (tid) { try { searchNextInTerm(tid, st.lastQuery, st.lastRe, st.lastCs); } catch {} }
      } else {
        for (const tid of getAllVisibleTermIds()) { try { searchNextInTerm(tid, st.lastQuery, st.lastRe, st.lastCs); } catch {} }
      }
    });
    const offP = api.onSearchPrev?.((p?: { mode?: 'current' | 'all' }) => {
      if (!st.lastQuery) return;
      const mode = p?.mode || st.lastMode;
      if (mode === 'current') {
        const tid = getActiveTermIdLocal();
        if (tid) { try { searchPrevInTerm(tid, st.lastQuery, st.lastRe, st.lastCs); } catch {} }
      } else {
        for (const tid of getAllVisibleTermIds()) { try { searchPrevInTerm(tid, st.lastQuery, st.lastRe, st.lastCs); } catch {} }
      }
    });
    const offC = api.onSearchClosed?.(() => {
      for (const tid of getAllTermIds()) {
        try { clearSearchInTerm(tid); clearHighlights(tid); } catch {}
      }
    });
    // 외부 검색창에서 📌 클릭 → 인라인 모드로 복귀
    const offD = api.onSearchDock?.(() => { setShowSearch(true); });
    // 터미널 우클릭 메뉴 등에서 디스패치하는 'open-search' 커스텀 이벤트
    const onOpenSearch = () => setShowSearch(true);
    window.addEventListener('open-search', onOpenSearch);
    return () => { offQ?.(); offN?.(); offP?.(); offC?.(); offD?.(); window.removeEventListener('open-search', onOpenSearch); };
  }, []); // listener 한 번만 — tabs/activeTab 은 ref 로 항상 최신 참조

  // 워크스페이스 전환 시 전체화면이면 새 워크스페이스의 선택된/첫번째 연결 패널로 fs-visible 전환
  useEffect(() => {
    if (!fullscreenTermId) return;
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.type === 'fileExplorer' || tab.type === 'fileEditor') {
      setFullscreenTermId(null);
      return;
    }
    // 현재 fullscreenTermId 가 새 워크스페이스에 있는지 확인
    const walk = (n: any): string[] => {
      if (n.type === 'leaf') {
        return (n.panel?.sessions || []).map((s: any) => s.termId);
      }
      return (n.children || []).flatMap(walk);
    };
    const termIds = walk(tab.layout);
    let targetTermId = fullscreenTermId;
    if (!termIds.includes(fullscreenTermId)) {
      const findFirst = (n: any): string | null => {
        if (n.type === 'leaf') {
          const s = n.panel?.sessions?.[n.panel?.activeIdx ?? 0];
          return s?.termId || null;
        }
        for (const c of (n.children || [])) { const r = findFirst(c); if (r) return r; }
        return null;
      };
      const candidate = findFirst(tab.layout);
      setFullscreenTermId(candidate);
      targetTermId = candidate || fullscreenTermId;
    }
    // fs-visible 전환 후 fit + refresh — 워크스페이스 전환 시 xterm 사이즈 재계산 + scrollbar 재렌더
    if (targetTermId) {
      const tid = targetTermId;
      [50, 200, 500].forEach(delay => setTimeout(() => refitTerm(tid), delay));
    }
  }, [activeTabId, tabs, fullscreenTermId]);

  // 텍스트 일괄 전송 대상 termId 수집
  const collectBroadcastTargets = (scope: 'current' | 'visible' | 'connected'): string[] => {
    const ids: string[] = [];
    if (scope === 'current') {
      const tid = getActiveTermId();
      if (tid && isTermConnected(tid)) ids.push(tid);
      return ids;
    }
    if (scope === 'visible') {
      if (!activeTab) return ids;
      const walk = (node: LayoutNode) => {
        if (node.type === 'leaf') {
          const sess = node.panel.sessions[node.panel.activeIdx];
          if (sess && isTermConnected(sess.termId)) ids.push(sess.termId);
        } else for (const c of node.children) walk(c);
      };
      walk(activeTab.layout);
      return ids;
    }
    // connected: 모든 워크스페이스의 모든 미니탭 중 연결된 것
    for (const t of tabs) {
      if (t.type === 'fileExplorer') continue;
      const sessions = collectAllSessions(t.layout);
      for (const s of sessions) if (isTermConnected(s.termId)) ids.push(s.termId);
    }
    return ids;
  };

  const [broadcastNotice, setBroadcastNotice] = useState<{ text: string; kind: 'ok' | 'warn' } | null>(null);
  const broadcastNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashBroadcastNotice = (text: string, kind: 'ok' | 'warn' = 'ok') => {
    setBroadcastNotice({ text, kind });
    if (broadcastNoticeTimer.current) clearTimeout(broadcastNoticeTimer.current);
    broadcastNoticeTimer.current = setTimeout(() => setBroadcastNotice(null), 2500);
  };
  const sendBroadcast = (scope: 'current' | 'visible' | 'connected', override?: { raw: string; label?: string }, opts?: { keepFocusOnInput?: boolean }) => {
    let text: string;
    let label: string;
    if (override) {
      text = override.raw;
      label = override.label ?? '(raw)';
    } else {
      text = broadcastAppendNewline ? (broadcastText.endsWith('\n') ? broadcastText : broadcastText + '\n') : broadcastText;
      label = tApp('broadcast.textLabel');
      if (!text) { flashBroadcastNotice(tApp('broadcast.enterText'), 'warn'); return; }
      addBroadcastHistory(broadcastText);
    }
    const targets = collectBroadcastTargets(scope);
    if (targets.length === 0) {
      flashBroadcastNotice(tApp('broadcast.noTargets'), 'warn');
      return;
    }
    for (const tid of targets) {
      try {
        if (isTermPty(tid)) {
          (window as any).api?.ptyInput?.(tid, text);
        } else {
          (window as any).api?.sendSSHInput?.(tid, text);
        }
      } catch {}
    }
    flashBroadcastNotice(tApp('broadcast.sentToast', { label, count: targets.length }), 'ok');
    // 전송 후 입력창 비우기 (override는 제어 문자라 제외)
    if (!override) setBroadcastText('');
    // 포커스 복귀: 기본은 활성 터미널로, 일괄작업창에서 전송한 경우엔 입력창 유지
    setTimeout(() => {
      if (opts?.keepFocusOnInput) {
        const inp = document.querySelector('.broadcast-input') as HTMLInputElement | null;
        inp?.focus();
      } else {
        const atid = getActiveTermId();
        if (atid) focusTerm(atid);
      }
    }, 0);
  };

  const handleThemeChange = (name: string) => {
    setThemeName(name);
    const tid = getActiveTermId();
    if (tid) applyThemeToTerm(tid, name);
    else applyThemeToAll(name);
  };

  type SessionOrganizeFolder = { path: string; name: string; parentPath?: string | null };
  type SessionOrganizeSession = { id: string; name: string; folderPath?: string | null };
  type SessionOrganizePlan = { folders: SessionOrganizeFolder[]; sessions: SessionOrganizeSession[] };

  const stripAiJson = (text: string) => {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
    return trimmed;
  };

  const checkAiAvailability = useCallback(async (): Promise<'claude' | 'gemini' | 'codex' | 'custom' | 'antigravity' | null> => {
    const order: ('claude' | 'gemini' | 'codex' | 'custom' | 'antigravity')[] = [];
    for (const agent of [aiAgent as 'claude' | 'gemini' | 'codex' | 'custom' | 'antigravity', 'claude', 'gemini', 'codex'] as const) {
      if (!order.includes(agent)) order.push(agent);
    }
    for (const agent of order) {
      try {
        const ok = agent === 'claude'
          ? await (window as any).api?.claudeCheck?.()
          : agent === 'gemini'
            ? await (window as any).api?.geminiCheck?.()
            : await (window as any).api?.codexCheck?.();
        if (ok && (ok.success !== false)) return agent;
      } catch {}
    }
    return null;
  }, [aiAgent]);

  const runAiSessionOrganize = useCallback(async () => {
    if (sessionOrganizeBusy) return;
    const agent = await checkAiAvailability();
    if (!agent) {
      notifyError(tApp('ai.serviceRequiredTitle'), tApp('ai.serviceRequiredDesc'));
      return;
    }
    setSessionOrganizeBusy(true);
    showToast(tApp('ai.organizingToast', { agent }), 3500);
    try {
      const data = await (window as any).api?.listSessions?.();
      const sessionsRaw: any[] = Array.isArray(data?.sessions) ? data.sessions : [];
      const foldersRaw: any[] = Array.isArray(data?.folders) ? data.folders : [];
      const prompt = [
        'You are organizing an SSH session list for a terminal app.',
        'Return ONLY valid JSON. No markdown, no code fences, no explanation.',
        'Schema:',
        '{',
        '  "folders": [',
        '    { "path": "root/child", "name": "Display Name", "parentPath": null | "root" }',
        '  ],',
        '  "sessions": [',
        '    { "id": "existing-session-id", "name": "New Session Name", "folderPath": null | "root/child" }',
        '  ]',
        '}',
        'Rules:',
        '- Keep every existing session id exactly once.',
        '- Do not change host, port, username, auth, encoding, dbms, or other technical fields.',
        '- You may rename sessions and create/rename folders freely.',
        '- folder paths must be unique and use "/" as separator.',
        '- Prefer short, readable folder names grouped by site/project/network segment.',
        '- Put sessions with similar hosts or purpose into shared folders when helpful.',
        '- If a session should stay at the root, use folderPath null.',
        '- Preserve all sessions; do not drop any.',
        '',
        'Current folders:',
        JSON.stringify(foldersRaw.map(f => ({ id: f.id, name: f.name, parentId: f.parentId ?? null })), null, 2),
        '',
        'Current sessions:',
        JSON.stringify(sessionsRaw.map(s => ({ id: s.id, name: s.name, host: s.host, port: s.port, username: s.username, folderId: s.folderId ?? null })), null, 2),
      ].join('\n');
      const requestId = `session-organize-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sessionId = `session-organize-${Date.now()}`;
      const collected: string[] = [];
      const resultText = await new Promise<string>(async (resolve, reject) => {
        const off = (window as any).api?.onClaudeStream?.((p: any) => {
          if (p.sessionId !== sessionId || p.requestId !== requestId) return;
          const msg = p.message || {};
          if (msg.type === 'assistant' && msg.message?.content) {
            const texts = msg.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
            if (texts) collected.push(texts);
          } else if (msg.type === 'text' && typeof msg.text === 'string') {
            collected.push(msg.text);
          } else if (msg.type === 'error') {
            try { off?.(); } catch {}
            reject(new Error(msg.text || 'AI response error'));
          } else if (msg.type === 'done' || msg.type === 'result') {
            try { off?.(); } catch {}
            resolve(collected.join(''));
          }
        });
        try {
          if (agent === 'claude') {
            await (window as any).api?.claudeSend?.(sessionId, prompt, undefined, true, undefined, null, 'bypassPermissions', undefined, false, requestId);
          } else if (agent === 'gemini') {
            await (window as any).api?.geminiSend?.(sessionId, prompt, requestId, undefined, true);
          } else {
            await (window as any).api?.codexSend?.(sessionId, prompt, requestId, undefined, 'full-auto');
          }
        } catch (err) {
          try { off?.(); } catch {}
          reject(err);
        }
      });

      const jsonText = stripAiJson(resultText);
      let parsed: SessionOrganizePlan;
      try {
        parsed = JSON.parse(jsonText);
      } catch (err) {
        throw new Error(tApp('ai.parseFail', { error: String(err) }));
      }
      if (!parsed || !Array.isArray(parsed.folders) || !Array.isArray(parsed.sessions)) {
        throw new Error(tApp('ai.invalidFormat'));
      }

      const existingSessionsById = new Map(sessionsRaw.map(s => [s.id, s]));
      const normalizedFolders = parsed.folders
        .filter(f => f && typeof f.path === 'string' && typeof f.name === 'string')
        .map(f => ({
          path: String(f.path).trim().replace(/^\/+|\/+$/g, ''),
          name: String(f.name).trim() || String(f.path).trim().split('/').pop() || 'Folder',
          parentPath: f.parentPath == null ? null : String(f.parentPath).trim().replace(/^\/+|\/+$/g, ''),
        }))
        .filter(f => f.path.length > 0);
      const normalizedSessions = parsed.sessions
        .filter(s => s && typeof s.id === 'string' && existingSessionsById.has(s.id))
        .map(s => ({
          id: s.id,
          name: String(s.name || existingSessionsById.get(s.id)?.name || '').trim(),
          folderPath: s.folderPath == null ? null : String(s.folderPath).trim().replace(/^\/+|\/+$/g, ''),
        }));
      if (normalizedSessions.length === 0) {
        throw new Error(tApp('ai.noApplicableSessions'));
      }

      const folderInputByPath = new Map<string, SessionOrganizeFolder>();
      for (const folder of normalizedFolders) folderInputByPath.set(folder.path, folder);
      const ensureFolderInput = (path: string): SessionOrganizeFolder | null => {
        const clean = path.trim().replace(/^\/+|\/+$/g, '');
        if (!clean) return null;
        const existing = folderInputByPath.get(clean);
        if (existing) return existing;
        const parentPath = clean.includes('/') ? clean.split('/').slice(0, -1).join('/') || null : null;
        const autoFolder: SessionOrganizeFolder = { path: clean, name: clean.split('/').pop() || clean, parentPath };
        folderInputByPath.set(clean, autoFolder);
        return autoFolder;
      };
      const createdFolderIds = new Map<string, string>();
      const resolvedFolders: any[] = [];
      const resolveFolder = (path: string): string => {
        const clean = path.trim().replace(/^\/+|\/+$/g, '');
        const cached = createdFolderIds.get(clean);
        if (cached) return cached;
        const folder = ensureFolderInput(clean);
        if (!folder) return '';
        const parentPath = folder.parentPath && folder.parentPath.length > 0
          ? folder.parentPath
          : (folder.path.includes('/') ? folder.path.split('/').slice(0, -1).join('/') || null : null);
        const parentId = parentPath ? resolveFolder(parentPath) : undefined;
        const id = `folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        createdFolderIds.set(clean, id);
        resolvedFolders.push({
          id,
          name: folder.name,
          parentId: parentId || undefined,
        });
        return id;
      };
      for (const folder of [...normalizedFolders].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
        resolveFolder(folder.path);
      }

      const resolvedSessions = sessionsRaw.map(orig => {
        const plan = normalizedSessions.find(s => s.id === orig.id);
        const folderId = plan?.folderPath ? (resolveFolder(plan.folderPath) || undefined) : undefined;
        return {
          ...orig,
          name: plan?.name || orig.name,
          folderId,
        };
      });

      const replaceResult = await (window as any).api?.sessionsReplaceAll?.({
        folders: resolvedFolders,
        sessions: resolvedSessions,
        keySeqDefaultsV1: true,
      });
      if (!replaceResult?.success) {
        throw new Error(replaceResult?.error || tApp('ai.saveFail'));
      }
      window.dispatchEvent(new Event('sessions-reload'));
      notifyOk(tApp('ai.organizeDoneTitle'), tApp('ai.organizeDoneDesc', { agent, sessions: resolvedSessions.length, folders: resolvedFolders.length }));
    } catch (err: any) {
      notifyError(tApp('ai.organizeFailTitle'), String(err?.message || err));
    } finally {
      setSessionOrganizeBusy(false);
    }
  }, [aiAgent, checkAiAvailability, sessionOrganizeBusy, showToast]);

  const handleClearSessions = async (mode: 'backup' | 'delete') => {
    try {
      if (mode === 'backup') {
        const exportResult = await (window as any).api?.exportSessions?.();
        if (!exportResult) return;
        showToast(tApp('sessionWipe.backupToast'));
      }
      const result = await (window as any).api?.sessionsClear?.();
      if (!result?.success) throw new Error(result?.error || tApp('sessionWipe.deleteFail'));
      window.dispatchEvent(new Event('sessions-reload'));
      setSessionWipeDialog(false);
      notifyOk(tApp('sessionWipe.emptiedTitle'), mode === 'backup' ? tApp('sessionWipe.emptiedBackupDesc') : tApp('sessionWipe.emptiedDesc'));
    } catch (err: any) {
      notifyError(tApp('sessionWipe.emptyFailTitle'), String(err?.message || err));
    }
  };

  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];

  // 검색 상태 ref 동기화 — tabs/activeTab 변경 시 갱신 + 활성 터미널에서 자동 재하이라이트
  useEffect(() => {
    searchStateRef.current.tabs = tabs;
    searchStateRef.current.activeTab = activeTab;
    const st = searchStateRef.current;
    if (!st.lastQuery) return;
    setTimeout(() => {
      try {
        const selInner = document.querySelector('.layout-leaf-inner.selected') as HTMLElement | null;
        const tid = selInner?.parentElement?.getAttribute('data-active-term');
        const targetTid = tid || (st.activeTab ? collectAllSessions(st.activeTab.layout)[0]?.termId : null);
        if (targetTid) {
          highlightAllMatches(targetTid, st.lastQuery, st.lastRe, st.lastCs);
          searchInTerm(targetTid, st.lastQuery, st.lastRe, st.lastCs);
        }
      } catch {}
    }, 100);
  }, [tabs, activeTab, selectedPanelId]);

  // 실제 포커스 복원 구현 — activeTab/selectedPanelId 가 선언된 후 ref 에 주입.
  // 모달 닫힌 후 브라우저가 body 로 포커스 이동시키는 케이스가 있어 여러 시점에 재시도.
  restoreTermFocusRef.current = () => {
    const doFocus = () => {
      try {
        if (!activeTab) return;
        const sessions = collectAllSessions(activeTab.layout);
        if (sessions.length === 0) return;
        let targetTermId: string | null = null;
        const selInner = document.querySelector('.layout-leaf-inner.selected') as HTMLElement | null;
        const selLeaf = selInner?.parentElement as HTMLElement | null;
        const selTerm = selLeaf?.getAttribute('data-active-term');
        if (selTerm) targetTermId = selTerm;
        if (!targetTermId) {
          const fsLeaf = document.querySelector('.layout-leaf.fs-visible') as HTMLElement | null;
          const t = fsLeaf?.getAttribute('data-active-term');
          if (t) targetTermId = t;
        }
        if (!targetTermId) targetTermId = sessions[0].termId;
        if (!targetTermId) return;
        try {
          const ae = document.activeElement as HTMLElement | null;
          if (ae && ae !== document.body) ae.blur();
        } catch {}
        focusTerm(targetTermId);
      } catch {}
    };
    [0, 30, 80, 150, 300].forEach(ms => setTimeout(doFocus, ms));
  };

  // 활성 터미널 termId를 가져오는 헬퍼
  const getActiveTermId = useCallback((): string | null => {
    if (!activeTab || !selectedPanelId) return null;
    const find = (node: LayoutNode): string | null => {
      if (node.type === 'leaf' && node.id === selectedPanelId) {
        const sess = node.panel.sessions[node.panel.activeIdx];
        return sess?.termId ?? null;
      }
      if (node.type !== 'leaf') for (const c of node.children) { const r = find(c); if (r) return r; }
      return null;
    };
    return find(activeTab.layout);
  }, [activeTab, selectedPanelId]);

  // 활성 SSH 세션의 현재 작업 디렉토리(pwd) — 파일 전송 탭을 그 경로로 열 때 사용.
  const getActiveRemotePwd = useCallback((): string | undefined => {
    const tid = getActiveTermId();
    if (!tid) return undefined;
    // 로컬 셸(PTY) 은 원격 SFTP 경로로 의미 없음 → 제외
    if (isTermPty(tid)) return undefined;
    const pwd = getCurrentPwdForTerm(tid);
    return pwd && pwd !== '/' ? pwd : undefined;
  }, [getActiveTermId]);

  // 파일 전송 탭 열기 — 활성 SSH 세션의 현재 pwd 를 (추적값 우선, 없으면 온디맨드 조회) 로 해석해 그 경로로 연다.
  const openFileTransferTab = useCallback(async (title: string) => {
    const tid = getActiveTermId() ?? undefined;
    let remotePath = getActiveRemotePwd();
    // 추적된 pwd 가 없으면 SSH 셸 cwd 를 온디맨드로 조회 (autoTrackPwd 꺼진 세션 대응)
    if (!remotePath && tid && !isTermPty(tid)) {
      try {
        const r: any = await (window as any).api?.sshGetShellCwd?.({ termId: tid });
        if (r?.ok && r.pwd) remotePath = r.pwd;
      } catch {}
    }
    const id = `tab-fe-${Date.now()}`;
    setTabs(prev => [...prev, { id, title, layout: createInitialLayout(id), type: 'fileExplorer', initialTermId: tid, initialRemotePath: remotePath }]);
    setActiveTabId(id);
  }, [getActiveTermId, getActiveRemotePwd]);

  // 글로벌 단축키
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 옵션 다이얼로그 열려있으면 글로벌 핸들러 무시
      if (showOptions) return;
      // 전체화면 토글 (창도 최대화, 해제 시 원래 상태로)
      if (matchKeybinding(e, 'fullscreen')) {
        e.preventDefault();
        const tid = getActiveTermId();
        if (tid) {
          setFullscreenTermId(prev => {
            const toFullscreen = prev !== tid;
            (async () => {
              try {
                const isMax = await (window as any).api?.windowIsMaximized?.();
                if (toFullscreen) {
                  // 진입: 현재 최대화 상태 저장 + 최대화
                  fsWasMaxRef.current = !!isMax;
                  if (!isMax) await (window as any).api?.windowToggleMaximize?.();
                } else {
                  // 해제: 진입 전 최대화가 아니었으면 원래대로 복원
                  if (!fsWasMaxRef.current && isMax) await (window as any).api?.windowToggleMaximize?.();
                }
              } catch {}
            })();
            return toFullscreen ? tid : null;
          });
          setTimeout(() => { refitAllTerms(); focusTerm(tid); }, 150);
        }
        return;
      }
      // 연결된 세션 선택 + 가로/세로 분할
      if ((matchKeybinding(e, 'splitSessionH') || matchKeybinding(e, 'splitSessionV')) && activeTab && selectedPanelId) {
        e.preventDefault();
        const dir: 'row' | 'column' = matchKeybinding(e, 'splitSessionV') ? 'row' : 'column';
        openSplitSessionPicker(dir, selectedPanelId);
        return;
      }
      // Alt+1..9: 워크스페이스 내 모든 미니탭(모든 패널) 기준 N번째 탭으로 이동 (Alt+9는 마지막 탭)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const m = /^Digit([1-9])$/.exec(e.code);
        if (m) {
          if (!activeTab) return;
          const leaves: { nodeId: string; sessions: PanelSession[]; activeIdx: number }[] = [];
          const collect = (node: LayoutNode) => {
            if (node.type === 'leaf') {
              if (node.panel.sessions.length > 0) {
                leaves.push({ nodeId: node.id, sessions: node.panel.sessions, activeIdx: node.panel.activeIdx });
              }
            } else {
              for (const c of node.children) collect(c);
            }
          };
          collect(activeTab.layout);
          const total = leaves.reduce((n, l) => n + l.sessions.length, 0);
          if (total === 0) return;
          e.preventDefault();
          const n = Number(m[1]);
          const targetGlobal = n === 9 ? total - 1 : Math.min(n - 1, total - 1);
          let acc = 0;
          for (const l of leaves) {
            if (targetGlobal < acc + l.sessions.length) {
              const localIdx = targetGlobal - acc;
              if (l.nodeId !== selectedPanelId) setSelectedPanelId(l.nodeId);
              if (localIdx !== l.activeIdx) handleSwitchSession(l.nodeId, localIdx);
              const tid = l.sessions[localIdx]?.termId;
              if (tid) setTimeout(() => focusTerm(tid), 50);
              break;
            }
            acc += l.sessions.length;
          }
          return;
        }
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      // 미니탭 순환
      if (matchKeybinding(e, 'nextTab') || matchKeybinding(e, 'prevTab')) {
        if (!activeTab) return;
        const leaves: { nodeId: string; sessions: PanelSession[]; activeIdx: number }[] = [];
        const collect = (node: LayoutNode) => {
          if (node.type === 'leaf') {
            if (node.panel.sessions.length > 0) {
              leaves.push({ nodeId: node.id, sessions: node.panel.sessions, activeIdx: node.panel.activeIdx });
            }
          } else {
            for (const c of node.children) collect(c);
          }
        };
        collect(activeTab.layout);
        const total = leaves.reduce((n, l) => n + l.sessions.length, 0);
        if (total < 2) return;
        e.preventDefault();
        // 현재 활성 위치(global index) 계산
        let curGlobal = 0;
        let found = false;
        for (const l of leaves) {
          if (l.nodeId === selectedPanelId) { curGlobal += l.activeIdx; found = true; break; }
          curGlobal += l.sessions.length;
        }
        if (!found) curGlobal = 0;
        const dir = matchKeybinding(e, 'prevTab') ? -1 : 1;
        const nextGlobal = (curGlobal + dir + total) % total;
        // global index → 해당 leaf + 로컬 index
        let acc = 0;
        for (const l of leaves) {
          if (nextGlobal < acc + l.sessions.length) {
            const localIdx = nextGlobal - acc;
            if (l.nodeId !== selectedPanelId) setSelectedPanelId(l.nodeId);
            if (localIdx !== l.activeIdx) handleSwitchSession(l.nodeId, localIdx);
            const tid = l.sessions[localIdx]?.termId;
            if (tid) setTimeout(() => focusTerm(tid), 50);
            break;
          }
          acc += l.sessions.length;
        }
        return;
      }
      // 현재 세션 복제 + 가로/세로 분할
      if ((matchKeybinding(e, 'cloneSplitH') || matchKeybinding(e, 'cloneSplitV')) && activeTab && selectedPanelId) {
        e.preventDefault();
        const dir: 'row' | 'column' = matchKeybinding(e, 'cloneSplitV') ? 'row' : 'column';
        const tid = getActiveTermId();
        const sessInfo = tid ? getTermSessionInfo(tid) : null;
        if (sessInfo && sessInfo.sessionId) {
          const newTermId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const cloneName = makeUniqueDisplayName(sessInfo.sessionId, sessInfo.sessionName || 'Session');
          const newSess: PanelSession = { termId: newTermId, sessionId: sessInfo.sessionId, sessionName: cloneName };
          updateLayout(activeTab.id, layout => splitNodeWithSessions(layout, selectedPanelId, dir, [newSess], false));
          setTimeout(async () => {
            if (tid) cloneTermStyle(tid, newTermId);
            try {
              const r = await (window as any).api.connectSSH(newTermId, sessInfo.sessionId);
              if (r === 'need-password') promptPasswordAndConnect(newTermId, sessInfo.sessionId);
            } catch {}
            registerTermSession(newTermId, sessInfo.sessionId, cloneName, sessInfo.host);
            setTimeout(() => { refitAllTerms(); focusTerm(newTermId); }, 100);
          }, 100);
        } else {
          splitPanel(activeTab.id, selectedPanelId, dir);
        }
        return;
      }
      if (matchKeybinding(e, 'find')) { e.preventDefault(); setShowSearch(prev => !prev); return; }
      if (matchKeybinding(e, 'toggleFileTree')) {
        e.preventDefault();
        // 워크스페이스 공유 파일 트리 핀/언핀 토글
        setRemoteTreePinned(p => {
          const newVal = !p;
          try { (window as any).api?.setUIPrefs?.({ remoteTreePinned: newVal }); } catch {}
          // 언핀 시 즉시 숨김 (마우스 hover 안 해도 retract). 핀 시엔 visible 자동 true.
          if (!newVal) setRemoteTreeVisible(false);
          return newVal;
        });
        [50, 200].forEach(ms => setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
          refitAllTerms();
        }, ms));
        return;
      }
      // 입력 가능한 요소(프롬프트 textarea, input, contenteditable)에 포커스가 있으면
      // 터미널 텍스트 조작 단축키(전체선택/복사/붙여넣기)는 건너뜀 → 네이티브 동작 보장.
      // 단, xterm 이 렌더링하는 hidden textarea (터미널 포커스) 는 제외 — clear* 등 터미널 단축키는
      // 여기서 처리해야 함. xterm 의 textarea 는 .xterm-helper-textarea 클래스로 식별.
      const ae = document.activeElement as HTMLElement | null;
      const isTermTextarea = !!ae && ae.classList?.contains('xterm-helper-textarea');
      const isEditable = !!ae && !isTermTextarea && (
        ae.tagName === 'INPUT' ||
        ae.tagName === 'TEXTAREA' ||
        ae.isContentEditable
      );
      const termId = getActiveTermId();
      // clear* 는 터미널 포커스에서도 동작해야 함 — isEditable 체크보다 먼저 처리.
      if (termId) {
        if (matchKeybinding(e, 'clearScrollback')) { e.preventDefault(); clearScrollbackInTerm(termId); return; }
        else if (matchKeybinding(e, 'clearScreen')) { e.preventDefault(); clearScreenInTerm(termId); return; }
        else if (matchKeybinding(e, 'clearAll')) { e.preventDefault(); clearAllInTerm(termId); return; }
      }
      if (isEditable) return;
      if (!termId) return;
      if (matchKeybinding(e, 'copy')) {
        const sel = getSelectionFromTerm(termId);
        if (sel) { e.preventDefault(); navigator.clipboard.writeText(sel).catch(() => {}); }
      }
      else if (matchKeybinding(e, 'paste')) {
        e.preventDefault();
        navigator.clipboard.readText().then(text => {
          if (text) pasteToTerm(termId, text);
        }).catch(() => {});
      }
      else if (matchKeybinding(e, 'selectAll')) {
        e.preventDefault();
        selectAllInTerm(termId);
      }
    };
    window.addEventListener('keydown', handler, true); // capture phase
    return () => window.removeEventListener('keydown', handler, true);
  }, [getActiveTermId, showOptions]);

  // SFTP 진행률/완료 이벤트
  useEffect(() => {
    const onProgress = (window as any).api?.onSFTPProgress?.((p: any) => {
      try { setSftpProgress(JSON.parse(p.data)); } catch {}
    });
    const onComplete = (window as any).api?.onSFTPComplete?.((p: any) => {
      setSftpProgress(null);
      try {
        JSON.parse(p.data);
        // 전송 완료 — 전송 목록에서 확인 가능
      } catch {}
    });
    return () => { onProgress?.(); onComplete?.(); };
  }, []);

  const addTab = (shellName?: string, shellPath?: string) => {
    const id = `tab-${Date.now()}`;
    const sn = shellName || defaultShell.name;
    const sp = shellPath || defaultShell.path;
    const layout = createInitialLayout(id, sn, sp);
    setTabs(prev => [...prev, { id, title: `Workspace ${prev.length + 1}`, layout }]);
    setActiveTabId(id);
    // 새 워크스페이스의 루트 패널 자동 선택
    if (layout.type === 'leaf') setSelectedPanelId(layout.id);
  };

  // 원격 파일을 에디터 탭에서 열기
  const handleOpenRemoteFile = (termId: string, remotePath: string, fileName: string) => {
    // 이미 같은 파일 열린 탭 있으면 전환
    const existing = tabs.find(t => t.type === 'fileEditor' && t.editor?.termId === termId && t.editor?.remotePath === remotePath);
    if (existing) { setActiveTabId(existing.id); return; }
    const id = `editor-${Date.now()}`;
    const layout = createInitialLayout(id);
    setTabs(prev => [...prev, { id, title: `📝 ${fileName}`, layout, type: 'fileEditor', editor: { termId, remotePath, fileName } }]);
    setActiveTabId(id);
  };

  // Claude 에 파일/폴더 첨부 — WebDAV 마운트는 제거됨. pepe_ssh MCP 도구로 직접 접근.
  // uncPath 는 더 이상 사용하지 않음 (빈 값). ClaudeChat 은 remotePath + termId 만으로 동작.
  const handleAttachToClaude = async (termId: string, remotePath: string, _fileName: string, isDir: boolean) => {
    setShowClaudeChat(true);
    try {
      setClaudeMountEntries(prev => {
        const map = new Map(prev.map(e => [`${e.termId}:${e.remotePath}`, e]));
        map.set(`${termId}:${remotePath}`, { termId, remotePath, uncPath: '', isDir });
        return Array.from(map.values());
      });
    } catch (err: any) {
      setClaudeAttaching({ message: tApp('claudeAttach.attachFail', { error: err }), progress: 0, total: 0 });
      setTimeout(() => setClaudeAttaching(null), 3500);
    }
  };


  const renameTab = (id: TabId, name: string) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, title: name } : t));
  };

  // 특수 워크스페이스 탭 추가 helpers — 빈 layout (사용 안 함) + type 만 의미 있음
  const addSpecialTab = (type: TabType, title: string) => {
    const id = `tab-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` as TabId;
    const emptyLayout: LayoutNode = { id: `node-${id}`, type: 'leaf', panel: { id: `panel-${id}`, sessions: [], activeIdx: 0 } };
    setTabs(prev => [...prev, { id, title, layout: emptyLayout, type }]);
    setActiveTabId(id);
  };
  const addBrowserTab = () => addSpecialTab('browser', tApp('tabs.browser'));
  const addCompareTab = () => addSpecialTab('compare', tApp('tabs.compare'));
  const addLogAnalyzerTab = () => addSpecialTab('logAnalyzer', tApp('tabs.logAnalyzer'));
  const addVpnTab = () => addSpecialTab('vpn', tApp('tabs.vpn'));
  const addMicroSipTab = () => addSpecialTab('microsip', '📞 MicroSIP');
  const addI18nEditorTab = () => addSpecialTab('i18nEditor', tApp('tabs.i18nEditor'));
  const openSqlToolTab = (sessionId: string, sessionName: string) => {
    // 동일 sessionId 의 SQL Tool 탭이 이미 있으면 그 탭으로 전환
    const existing = tabs.find(t => t.type === 'sqlTool' && t.sqlTool?.sessionId === sessionId);
    if (existing) { setActiveTabId(existing.id); return; }
    const id = `tab-sqltool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` as TabId;
    const emptyLayout: LayoutNode = { id: `node-${id}`, type: 'leaf', panel: { id: `panel-${id}`, sessions: [], activeIdx: 0 } };
    setTabs(prev => [...prev, { id, title: `🗄️ ${sessionName}`, layout: emptyLayout, type: 'sqlTool', sqlTool: { sessionId, sessionName } }]);
    setActiveTabId(id);
  };

  // 단일 termId 의 모든 백엔드 리소스 해제 — close 경로 어디서든 일관되게 호출
  const releaseTermResources = useCallback((termId: string) => {
    if (!termId) return;
    try { (window as any).api?.disconnectSSH?.(termId); } catch {}
    try { (window as any).api?.feReleaseSftp?.(termId); } catch {}
    try { (window as any).api?.claudeUnregisterMount?.(termId); } catch {}
    // ClaudeChat 의 mounted entries 정리
    setClaudeMountEntries(prev => prev.filter(e => e.termId !== termId));
    // xterm Terminal 인스턴스 + termId 키 보조 캐시 모두 정리 (메모리 회수)
    // 백엔드 종료 메시지가 IPC 로 처리될 시간을 약간 두고 dispose
    setTimeout(() => { try { disposeTermFully(termId); } catch {} }, 200);
  }, []);

  const closeTab = (id: TabId) => {
    // 워크스페이스가 단 하나만 남아있으면 닫지 못하게 막는다 — 빈 앱 상태 방지.
    if (tabs.length <= 1) return;
    // 닫히는 탭이 들고 있는 모든 세션의 백엔드 리소스 해제
    const tab = tabs.find(t => t.id === id);
    if (tab) {
      try {
        const sessions = collectAllSessions(tab.layout);
        for (const s of sessions) if (s.termId) releaseTermResources(s.termId);
      } catch {}
    }
    setTabs(prev => { const f = prev.filter(t => t.id !== id); return f.length === 0 ? prev : f; });
    // 닫히는 탭이 우측 분할 탭 자신이면 분할도 같은 배치에서 즉시 해제.
    if (splitRightTabId === id) setSplitRightTabId(null);
    setActiveTabId(prev => {
      if (prev !== id) return prev;
      const r = tabs.filter(t => t.id !== id);
      if (r.length === 0) return prev;
      // 우측 분할 탭과 같은 걸 activeTab 으로 고르면 분할 자동해제 useEffect 가 (한 박자 늦게) 발동해서
      // 그 사이 같은 탭이 좌/우 슬롯에 동시에 렌더링되며 xterm DOM 이 고아가 되는 문제가 있었음 —
      // 여기서 같은 배치에 splitRightTabId 도 즉시 비워서 중간 상태 없이 한 번에 정리.
      const nonSplitRight = r.find(t => t.id !== splitRightTabId);
      const nextActiveId = (nonSplitRight ?? r[0]).id;
      if (nextActiveId === splitRightTabId) setSplitRightTabId(null);
      return nextActiveId;
    });
    // 분할되어 있던 탭이 닫히면서 남은 탭 하나가 전체 화면을 차지하게 될 때, 그 안의 터미널이
    // 포커스를 못 받아 입력이 안 먹는 경우가 있어 레이아웃 정리 후 다시 포커스.
    setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); restoreTerminalFocus(); }, 100);
  };

  const updateLayout = (tabId: TabId, fn: (layout: LayoutNode) => LayoutNode) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, layout: fn(t.layout) } : t));
  };

  // ── 탭 분리/재부착(멀티 윈도우) ──────────────────────────────────────
  // 라이브 세션 재부착: 세션 매핑 등록 + 연결 상태 시딩 (이후 출력은 broadcast 로 수신, 재연결 방지)
  // FileExplorer 인스턴스 별 현재 상태(leftTabs/rightTabs/...) — 분리 직전 serializeTab 이 끌어다 쓴다.
  const fileExplorerStateRef = useRef<Map<string, any>>(new Map());
  // 그 외 모든 워크스페이스 (메신저/파일비교/브라우저/로그분석) 공통 — tab.id → state.
  const workspaceStateRef = useRef<Map<string, any>>(new Map());
  // 다른 탭에서 끌어온 sibling 세션 스냅샷 — FileExplorer 가 비어보이지 않도록 보관.
  const [carriedSiblingSessions, setCarriedSiblingSessions] = useState<{ termId: string; sessionId: string; sessionName: string; host: string }[]>([]);
  const seedReattach = useCallback(async (tab: Tab, siblings?: { termId: string; sessionId: string; sessionName: string; host: string; quickSession?: any }[]) => {
    let connected: string[] = [];
    try { connected = (await (window as any).api?.getConnectedPanels?.()) || []; } catch {}
    const connSet = new Set(connected);
    try {
      for (const s of collectAllSessions(tab.layout)) {
        if (!s.termId) continue;
        registerTermSession(s.termId, s.sessionId || '', s.sessionName, (s as any).host || '');
        if (connSet.has(s.termId)) markTermConnected(s.termId);
      }
      // sibling 세션(다른 탭의 활성 SSH 등) 도 termRegistry 에 다시 등록 — FileExplorer 가 인식 가능.
      if (Array.isArray(siblings)) {
        for (const s of siblings) {
          if (!s.termId) continue;
          registerTermSession(s.termId, s.sessionId || '', s.sessionName, s.host || '', s.quickSession);
          if (connSet.has(s.termId)) markTermConnected(s.termId);
        }
        setCarriedSiblingSessions(siblings.map(s => ({ termId: s.termId, sessionId: s.sessionId || '', sessionName: s.sessionName || '', host: s.host || '' })));
      }
    } catch {}
  }, []);

  // 분리된 창: 마운트 직후 main 에서 받은 탭 페이로드로 채운다.
  useEffect(() => {
    if (!IS_DETACHED_WINDOW) return;
    (async () => {
      try {
        const init: any = await (window as any).api?.getDetachedInit?.();
        if (!init?.tab) return;
        await seedReattach(init.tab, init.siblingSessions);
        try { for (const [tid, s] of Object.entries(init.styles || {})) setPendingRestoreStyle(tid, s); } catch {}
        try { for (const [tid, b] of Object.entries(init.buffers || {})) setPendingRestoreBuffer(tid, b as string); } catch {}
        // 복제→새 창 분리: SSH 재연결 금지 — 버퍼 표시만.
        if (init.snapshotOnly) {
          try { for (const tid of Object.keys(init.buffers || {})) markTermSnapshotOnly(tid); } catch {}
        }
        // TerminalPanel auto-connect 가 일반(시끄러운) 연결을 먼저 가져가지 않도록 setTabs 전에 차단.
        if (Array.isArray(init.connectAfterAdopt)) {
          try { for (const it of init.connectAfterAdopt) markSuppressAutoConnect(it.termId); } catch {}
        }
        setTabs([init.tab]);
        setActiveTabId(init.tab.id);
        if (Array.isArray(init.connectAfterAdopt)) {
          setTimeout(() => {
            for (const it of init.connectAfterAdopt) {
              try {
                clearSuppressAutoConnect(it.termId);
                console.log('[connectAfterAdopt:detached] termId=', it.termId, 'cdAfterConnect=', it.cdAfterConnect);
                if (it.cdAfterConnect) {
                  const targetCwd = String(it.cdAfterConnect).replace(/"/g, '\\"');
                  let off: (() => void) | undefined;
                  off = (window as any).api?.onSSHConnected?.((p: any) => {
                    console.log('[onSSHConnected:detached] panelId=', p?.panelId, 'expected=', it.termId);
                    if (p?.panelId !== it.termId) return;
                    try { off?.(); } catch {}
                    setTimeout(() => {
                      console.log('[duplicate:detached] sending cd:', targetCwd);
                      try { (window as any).api?.sendSSHInput?.(it.termId, `cd "${targetCwd}"\r`); } catch (e) { console.error('cd send failed', e); }
                    }, 1500);
                  });
                }
                if (it.sessionId) (window as any).api?.connectSSH?.(it.termId, it.sessionId);
                else if (it.quickSession) (window as any).api?.quickConnectSSH?.(it.termId, it.quickSession);
              } catch (e) { console.error('[connectAfterAdopt:detached] fail', e); }
            }
          }, 500);
        }
      } catch (err) { console.error('[detached] init fail', err); }
    })();
  }, [seedReattach]);

  // 다른 창에서 끌어온 탭을 이 창이 받아들임 (re-dock).
  //  - 미니탭(kind='session')이고 드롭 좌표 아래에 패널이 있으면 → 그 패널의 미니탭으로 병합.
  //  - 그 외 → 새 워크스페이스 탭으로 추가.
  useEffect(() => {
    const off = (window as any).api?.onAdoptTab?.(async (payload: any) => {
      if (!payload?.tab) return;
      await seedReattach(payload.tab, payload.siblingSessions);
      try { for (const [tid, s] of Object.entries(payload.styles || {})) setPendingRestoreStyle(tid, s); } catch {}
      try { for (const [tid, b] of Object.entries(payload.buffers || {})) setPendingRestoreBuffer(tid, b as string); } catch {}
      if (payload.snapshotOnly) {
        try { for (const tid of Object.keys(payload.buffers || {})) markTermSnapshotOnly(tid); } catch {}
      }
      if (Array.isArray(payload.connectAfterAdopt)) {
        try { for (const it of payload.connectAfterAdopt) markSuppressAutoConnect(it.termId); } catch {}
        setTimeout(() => {
          for (const it of payload.connectAfterAdopt) {
            try {
              clearSuppressAutoConnect(it.termId);
              console.log('[connectAfterAdopt] termId=', it.termId, 'cdAfterConnect=', it.cdAfterConnect);
              if (it.cdAfterConnect) {
                const targetCwd = String(it.cdAfterConnect).replace(/"/g, '\\"');
                let off: (() => void) | undefined;
                off = (window as any).api?.onSSHConnected?.((p: any) => {
                  console.log('[onSSHConnected] panelId=', p?.panelId, 'expected=', it.termId);
                  if (p?.panelId !== it.termId) return;
                  try { off?.(); } catch {}
                  setTimeout(() => {
                    console.log('[duplicate] sending cd:', targetCwd);
                    try { (window as any).api?.sendSSHInput?.(it.termId, `cd "${targetCwd}"\r`); } catch (e) { console.error('cd send failed', e); }
                  }, 1500);
                });
              }
              if (it.sessionId) (window as any).api?.connectSSH?.(it.termId, it.sessionId);
              else if (it.quickSession) (window as any).api?.quickConnectSSH?.(it.termId, it.quickSession);
            } catch (e) { console.error('connectAfterAdopt fail', e); }
          }
        }, 500);
      }
      // 드롭 지점 hit-test — 탭바면 활성 패널에 미니탭 병합, panel 내부면 zone 분할/병합, 그 외 새 탭.
      if (payload.point) {
        try {
          // 수신 측 cursor 위치를 main 에서 직접 받아 사용 — DIPs 보장, DPI/멀티모니터 환경 일관.
          const cursorPt: any = await (window as any).api?.getCursorPoint?.();
          const b: any = await (window as any).api?.getWindowBounds?.();
          if (b) {
            const sx = cursorPt?.x ?? payload.point.x;
            const sy = cursorPt?.y ?? payload.point.y;
            const cx = sx - b.x;
            const cy = sy - b.y;
            const el = document.elementFromPoint(cx, cy) as HTMLElement | null;
            // 탭바 영역 검출 — 클래스 매칭 우선, 못 잡으면 y 좌표(상단 50px 이내) 폴백.
            const onChrome = !!el?.closest('.tab-bar-row, .tab-bar, .titlebar-drag-area, .titlebar, .menu-bar, [data-no-drop-zone]') || cy < 50;
            console.log('[adopt-tab] hit-test', { kind: payload.kind, cx, cy, elTag: el?.tagName, elClass: el?.className, onChrome });
            const leafEl = onChrome ? null : (el?.closest('[data-leaf-id]') as HTMLElement | null);
            const leafId = leafEl?.getAttribute('data-leaf-id') || null;
            const allSess = collectAllSessions(payload.tab.layout);
            const sess = allSess[0];
            const curTabId = activeTabIdRef.current;
            // 탭바 위 드롭 — kind 무관, 가져온 모든 세션을 활성 탭의 첫 leaf 에 미니탭으로 병합.
            if (onChrome && allSess.length > 0 && curTabId) {
              const curTab = tabsRef.current.find(t => t.id === curTabId);
              const targetLeafId = curTab ? findFirstLeafId(curTab.layout) : null;
              console.log('[adopt-tab] tabbar→merge', { curTab: !!curTab, targetLeafId, sessions: allSess.length });
              if (targetLeafId) {
                updateLayout(curTabId, l => appendSessionsToPanel(l, targetLeafId, allSess, true));
                setSelectedPanelId(targetLeafId);
                setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
                return;
              }
            }
            // 패널 미니탭바(panel-header / panel-session-tabs)에 드롭 → 그 패널에 미니탭 병합 (split 금지)
            const onPanelTabBar = !!el?.closest('.panel-header, .panel-session-tabs, .panel-session-tabs-wrapper');
            if (onPanelTabBar && leafId && sess && curTabId) {
              console.log('[adopt-tab] panel-tabbar→merge', { leafId });
              updateLayout(curTabId, l => appendSessionsToPanel(l, leafId, [sess], true));
              setSelectedPanelId(leafId);
              setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
              return;
            }
            // panel 내부 드롭은 kind='session' 일 때만 zone 기반 분할/병합 (워크스페이스 전체는 새 탭으로).
            if (payload.kind === 'session' && !onPanelTabBar && leafId && leafEl && sess && curTabId) {
              // 패널 내 드롭 위치로 zone 판정 (가장자리=분할, 중앙=미니탭 병합)
              const rect = leafEl.getBoundingClientRect();
              // 드롭이 leaf 사각형 바깥이면 zone 계산 의미 없음 → 새 탭 fallback.
              if (cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) {
                const rx = (cx - rect.left) / rect.width;
                const ry = (cy - rect.top) / rect.height;
                const th = 0.2;
                let zone: 'left' | 'right' | 'top' | 'bottom' | 'center' = 'center';
                if (rx < th) zone = 'left'; else if (rx > 1 - th) zone = 'right';
                else if (ry < th) zone = 'top'; else if (ry > 1 - th) zone = 'bottom';
                console.log('[adopt-tab] zone', { sx, sy, winBounds: b, cx, cy, leafId, rect, rx, ry, zone, fromCursorApi: !!cursorPt });
                updateLayout(curTabId, l => {
                  if (zone === 'center') return appendSessionsToPanel(l, leafId, [sess], true);
                  const direction: 'row' | 'column' = (zone === 'left' || zone === 'right') ? 'row' : 'column';
                  const insertBefore = zone === 'left' || zone === 'top';
                  return splitNodeWithSessions(l, leafId, direction, [sess], insertBefore);
                });
                setSelectedPanelId(leafId);
                setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
                return; // 병합/분할 완료
              }
            }
          }
        } catch {}
      }
      // 폴백: 새 워크스페이스 탭
      setTabs(prev => prev.find(t => t.id === payload.tab.id) ? prev : [...prev, payload.tab]);
      setActiveTabId(payload.tab.id);
    });
    return () => { try { off?.(); } catch {} };
  }, [seedReattach]);

  // 탭의 모든 세션 화면 버퍼 + 스타일을 직렬화 (분리 시 화면/테마 이관용)
  const collectTabBuffers = (tab: Tab): Record<string, string> => {
    const buffers: Record<string, string> = {};
    try {
      for (const s of collectAllSessions(tab.layout)) {
        if (!s.termId) continue;
        const b = serializeTermBuffer(s.termId);
        if (b) buffers[s.termId] = b;
      }
    } catch {}
    return buffers;
  };
  const collectTabStyles = (tab: Tab): Record<string, any> => {
    const styles: Record<string, any> = {};
    try {
      for (const s of collectAllSessions(tab.layout)) {
        if (!s.termId) continue;
        const st = getTermStyle(s.termId);
        if (st) styles[s.termId] = st;
      }
    } catch {}
    return styles;
  };

  // FileExplorer 탭 분리 시 — 같은 창의 다른 탭들로부터 계산되는 sessions 가 새 창에서 비어버리는
  // 문제 방지용 스냅샷. detached 창에서 props 로 그대로 주입한다.
  const collectSiblingSessions = (tab: Tab) => {
    try {
      return tabsRef.current
        .filter(x => x.id !== tab.id && x.type !== 'fileExplorer')
        .flatMap(x => collectAllSessions(x.layout))
        .filter(s => s.sessionId || getTermSessionInfo(s.termId)?.quickSession)
        .map(s => ({
          termId: s.termId,
          sessionId: s.sessionId || '',
          sessionName: s.sessionName || getTermSessionInfo(s.termId)?.sessionName || '',
          host: (s as any).host || getTermSessionInfo(s.termId)?.host || '',
          quickSession: getTermSessionInfo(s.termId)?.quickSession || null,
        }));
    } catch { return []; }
  };
  const serializeTab = (tab: Tab) => {
    const liveFeState = fileExplorerStateRef.current.get(tab.id);
    let liveWsState = workspaceStateRef.current.get(tab.id);
    // SqlTool 은 module-level sqlStateCache 에 상태를 보관 — 분리 시 직접 dump.
    if (tab.type === 'sqlTool' && tab.sqlTool?.sessionId) {
      liveWsState = serializeSqlSession(tab.sqlTool.sessionId);
    }
    return {
      kind: 'workspace' as const,
      buffers: collectTabBuffers(tab),
      styles: collectTabStyles(tab),
      siblingSessions: collectSiblingSessions(tab),
      tab: JSON.parse(JSON.stringify({
        id: tab.id, title: tab.title, type: tab.type, layout: tab.layout,
        sqlTool: tab.sqlTool, editor: tab.editor,
        initialTermId: tab.initialTermId, initialRemotePath: tab.initialRemotePath,
        fileExplorerState: liveFeState || tab.fileExplorerState,
        workspaceState: liveWsState || tab.workspaceState,
      })),
    };
  };

  // 원본 창에서 분리된/이동한 탭 제거 — 백엔드 세션은 살리고 xterm 만 dispose.
  const removeTabAfterMove = (tabId: TabId, layout: LayoutNode) => {
    try { collectAllSessions(layout).forEach(s => { if (s.termId) disposeTermFully(s.termId); }); } catch {}
    const remaining = tabsRef.current.filter(t => t.id !== tabId);
    if (remaining.length === 0) {
      // 분리 창이 비면 창을 닫고, 메인 창이면 빈 워크스페이스로 대체.
      if (IS_DETACHED_WINDOW) { try { (window as any).api?.windowClose?.(); } catch {} return; }
      const id = `tab-${Date.now()}`;
      setTabs([{ id, title: 'Workspace 1', layout: createInitialLayout(id) }]);
      setActiveTabId(id);
      return;
    }
    setTabs(prev => prev.filter(t => t.id !== tabId));
    setActiveTabId(prev => prev === tabId ? remaining[0].id : prev);
  };

  // 탭 드래그 분리/재부착 — 드롭 좌표가 다른 앱 창 위면 그 창으로 re-dock, 아니면 새 창.
  // 좌표 미지정(컨텍스트 메뉴)이면 항상 새 창.
  const detachTabToNewWindow = useCallback(async (tabId: TabId, screenX?: number, screenY?: number) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab) return;
    const point = (screenX != null && screenY != null) ? { x: screenX, y: screenY } : undefined;
    // FileExplorer 가 unmount 될 때 lazy SFTP connId 를 끊지 않게 한다 — 새 창에서 그대로 이어쓰기 위해.
    // SqlTool 도 마찬가지로 sidecar JDBC connection 보존 → 새 창이 같은 connectionId 로 adopt.
    (window as any).__preserveFileExplorerConns = true;
    (window as any).__preserveSqlConns = true;
    try {
      const res = await (window as any).api?.dropTab?.(serializeTab(tab), point);
      if (res === undefined) return; // IPC 실패
      removeTabAfterMove(tabId, tab.layout);
    } finally {
      // unmount cleanup 이 다 끝난 다음 플래그 해제 (마이크로태스크 두 번)
      setTimeout(() => {
        (window as any).__preserveFileExplorerConns = false;
        (window as any).__preserveSqlConns = false;
      }, 0);
    }
  }, []);

  // 현재 활성 세션의 folderId 기준으로 같은 폴더 세션들을 picker 로 띄운다.
  // 픽커에서 선택된 세션을 새 termId 로 연결해서 targetNodeId 패널을 분할해 배치.
  // 활성 세션이 없거나 folder 내 다른 세션이 없으면 그냥 빈 분할.
  const openSplitSessionPicker = async (dir: 'row' | 'column', targetNodeId: string, tabId?: TabId) => {
    // 세션 픽커 없이 바로 빈 분할 (로컬 쉘 패널 자동 생성)
    const tid = tabId ?? activeTab?.id;
    if (!tid) return;
    splitPanel(tid, targetNodeId, dir);
  };

  // 세션 선택 팝업 — 파일트리 형식 (폴더 + 세션 계층 구조)
  const openSplitSessionPickerWithPrompt = async (dir: 'row' | 'column', targetNodeId: string, tabId?: TabId) => {
    const tid = tabId ?? activeTab?.id;
    if (!tid) return;
    const curTid = getActiveTermId();
    try {
      const data: any = await (window as any).api?.listSessions?.();
      const sessions: any[] = data?.sessions ?? data ?? [];
      const folders: any[] = data?.folders ?? [];
      const sessionItems = sessions.map(s => ({
        sessionId: s.id, sessionName: s.name, host: s.host || '', termId: '',
        folderId: s.folderId, icon: s.icon,
      }));
      const folderItems = folders.map((f: any) => ({ id: f.id, name: f.name, parentId: f.parentId }));
      if (sessionItems.length === 0) {
        splitPanel(tid, targetNodeId, dir);
        return;
      }
      setSplitPickerCollapsed(new Set());
      setSplitSessionPicker({
        dir, sessions: sessionItems, folders: folderItems,
        srcTermId: curTid || undefined, targetNodeId, targetTabId: tid,
      });
    } catch {
      splitPanel(tid, targetNodeId, dir);
    }
  };

  const splitPanel = (tabId: TabId, targetNodeId: string, direction: 'row' | 'column') => {
    updateLayout(tabId, layout => splitNode(layout, targetNodeId, direction));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  };

  const handleSplitSessionSelect = async (target: { sessionId: string; sessionName: string; host: string; termId: string }) => {
    if (!splitSessionPicker) return;
    const { dir, targetNodeId, targetTabId } = splitSessionPicker;
    const newTermId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const splitName = makeUniqueDisplayName(target.sessionId, target.sessionName);
    const newSess: PanelSession = { termId: newTermId, sessionId: target.sessionId, sessionName: splitName };
    // 세션 데이터에서 theme/font 가져오기
    let fullSess: any = null;
    try {
      const data: any = await (window as any).api?.listSessions?.();
      const all: any[] = data?.sessions ?? data ?? [];
      fullSess = all.find((s: any) => s.id === target.sessionId);
    } catch {}
    updateLayout(targetTabId, layout => splitNodeWithSessions(layout, targetNodeId, dir, [newSess], false));
    // 다른 연결 세션과 마운트 순서를 맞추기 위해 auto-connect 를 억제하고 여기서만 명시적으로 연결.
    markSuppressAutoConnect(newTermId);
    registerTermSession(newTermId, target.sessionId, splitName, target.host);
    setTimeout(async () => {
      // 세션 설정 적용 (theme / fontFamily / fontSize / scrollback)
      if (fullSess?.scrollback) applyScrollbackToTerm(newTermId, fullSess.scrollback);
      setTimeout(() => {
        if (fullSess?.theme) applyThemeToTerm(newTermId, fullSess.theme);
        if (fullSess?.fontFamily || fullSess?.fontSize) applyFontToTerm(newTermId, fullSess?.fontFamily, fullSess?.fontSize);
      }, 200);
      try {
        // 분할로 새 leaf 가 생기는 경우(레이아웃 트리 재구성) 기존 패널에 추가하는 경우보다 실제
        // 터미널 컴포넌트 마운트(termStore 등록)가 늦을 수 있음 — 마운트될 때까지 잠깐 대기 후 연결
        // (promptPasswordAndConnect 는 termStore 에 없으면 조용히 아무 것도 안 하고 리턴함).
        for (let i = 0; i < 20 && !termStore.get(newTermId); i++) {
          await new Promise(res => setTimeout(res, 30));
        }
        const r = await (window as any).api.connectSSH(newTermId, target.sessionId);
        if (r === 'need-password') promptPasswordAndConnect(newTermId, target.sessionId);
      } catch {}
      clearSuppressAutoConnect(newTermId);
      setTimeout(() => { refitAllTerms(); focusTerm(newTermId); }, 100);
    }, 100);
    setSplitSessionPicker(null);
  };

  const closePanel = (tabId: TabId, targetNodeId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    // 닫히는 leaf 의 모든 세션 termId 수집 후 백엔드 리소스 해제
    const collectLeafSessions = (node: LayoutNode): PanelSession[] => {
      if (node.type === 'leaf') return node.id === targetNodeId ? [...node.panel.sessions] : [];
      return node.children.flatMap(collectLeafSessions);
    };
    if (countLeaves(tab.layout) === 1) {
      // 마지막 leaf — layout 은 유지하되 세션 종료
      if (tab.layout.type === 'leaf') tab.layout.panel.sessions.forEach(s => { if (s.termId) releaseTermResources(s.termId); });
      return;
    }
    const sessionsToClose = collectLeafSessions(tab.layout);
    for (const s of sessionsToClose) if (s.termId) releaseTermResources(s.termId);
    updateLayout(tabId, layout => removeLeafNode(layout, targetNodeId));
  };

  const handleSwitchSession = (nodeId: string, idx: number, tabId?: TabId) => {
    const targetTab = tabId ? tabs.find(t => t.id === tabId) : activeTab;
    if (!targetTab) return;
    // 동일 idx 면 layout 변경 안함 — 더블클릭 시 onClick × 2 가 동일 idx 로 호출되어 React 재렌더 cascade 발생하던 문제 회피
    let alreadySame = false;
    const findActive = (node: any): void => {
      if (alreadySame) return;
      if (node.type === 'leaf' && node.id === nodeId) {
        if (node.panel.activeIdx === idx) alreadySame = true;
        return;
      }
      if (node.type !== 'leaf') node.children.forEach(findActive);
    };
    findActive(targetTab.layout);
    if (alreadySame) return;
    updateLayout(targetTab.id, layout => switchPanelSession(layout, nodeId, idx));
  };

  const handleReorderSession = (nodeId: string, fromIdx: number, toIdx: number, tabId?: TabId) => {
    const tid = tabId ?? activeTab?.id;
    if (!tid || fromIdx === toIdx) return;
    updateLayout(tid, layout => reorderPanelSession(layout, nodeId, fromIdx, toIdx));
  };

  // 세션 제거 후 빈 패널 정리 (leaf가 1개뿐이면 유지)
  const cleanEmptyLeaf = (layout: LayoutNode, nodeId: string): LayoutNode => {
    if (countLeaves(layout) <= 1) return layout;
    const isEmpty = (node: LayoutNode): boolean => {
      if (node.type === 'leaf') return node.id === nodeId && node.panel.sessions.length === 0;
      return node.children.some(isEmpty);
    };
    return isEmpty(layout) ? removeLeafNode(layout, nodeId) : layout;
  };

  // 세션(터미널)을 다른 워크스페이스로 통째로 이동 — 단일 상태 업데이트로 termId 유지하며 옮김
  const handleMoveSessionToWorkspace = (fromNodeId: string, termId: string, targetTabId: string, sourceTabId?: TabId) => {
    const fromTabId = sourceTabId ?? activeTab?.id;
    if (!fromTabId) return;
    // 새 워크스페이스 생성 옵션
    if (targetTabId === '__new__') {
      const newId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // createInitialLayout 은 기본 'Local Shell' 세션을 자동 생성 → 이동 직후 빈 슬롯이 아니라
      // Local Shell + 이동된 세션 2개가 됨. 새 워크스페이스는 빈 leaf 로 만들어서 이동된 세션만 들어가게.
      const emptyLayout: LayoutNode = {
        id: `node-root-${Date.now().toString(36)}`,
        type: 'leaf',
        panel: { id: `panel-${Date.now().toString(36)}`, sessions: [], activeIdx: 0 },
      };
      const newTab = { id: newId, title: `Workspace ${tabs.length + 1}`, layout: emptyLayout } as any;
      setTabs(prev => [...prev, newTab]);
      // 다음 tick 에 이동 진행
      setTimeout(() => handleMoveSessionToWorkspace(fromNodeId, termId, newId, fromTabId), 30);
      return;
    }
    if (fromTabId === targetTabId) return;
    setTabs(prev => {
      const fromTab = prev.find(t => t.id === fromTabId);
      const toTab = prev.find(t => t.id === targetTabId);
      if (!fromTab || !toTab) return prev;
      // 세션 객체 추출
      const findSess = (node: LayoutNode): PanelSession | null => {
        if (node.type === 'leaf' && node.id === fromNodeId) return node.panel.sessions.find(s => s.termId === termId) ?? null;
        if (node.type !== 'leaf') for (const c of node.children) { const r = findSess(c); if (r) return r; }
        return null;
      };
      const sess = findSess(fromTab.layout);
      if (!sess) return prev;
      // from 에서 제거
      let fromLayout = removeSessionFromPanel(fromTab.layout, fromNodeId, termId);
      fromLayout = cleanEmptyLeaf(fromLayout, fromNodeId);
      // to 에 추가 (첫 leaf, 추가된 세션을 active 로)
      const targetLeafId = findFirstLeafId(toTab.layout);
      if (!targetLeafId) return prev;
      const toLayout = appendSessionsToPanel(toTab.layout, targetLeafId, [sess], true);
      return prev.map(t => {
        if (t.id === fromTab.id) return { ...t, layout: fromLayout };
        if (t.id === toTab.id) return { ...t, layout: toLayout };
        return t;
      });
    });
    // 타겟 워크스페이스로 전환
    setActiveTabId(targetTabId);
  };

  const handleMoveSession = (fromNodeId: string, termId: string, toNodeId: string, tabId?: TabId) => {
    const tid = tabId ?? activeTab?.id;
    if (!tid) return;
    updateLayout(tid, layout => {
      const findSess = (node: LayoutNode): PanelSession | null => {
        if (node.type === 'leaf' && node.id === fromNodeId) return node.panel.sessions.find(s => s.termId === termId) ?? null;
        if (node.type !== 'leaf') for (const c of node.children) { const r = findSess(c); if (r) return r; }
        return null;
      };
      const sess = findSess(layout);
      if (!sess) return layout;
      let updated = removeSessionFromPanel(layout, fromNodeId, termId);
      updated = appendSessionsToPanel(updated, toNodeId, [sess], true);
      updated = cleanEmptyLeaf(updated, fromNodeId);
      return updated;
    });
    setSelectedPanelForTab(tid, toNodeId);
  };

  // 미니탭을 다른 패널 가장자리에 드롭 → 분할 + 세션 이동
  const handleSplitMoveSession = (fromNodeId: string, termId: string, toNodeId: string, zone: 'left' | 'right' | 'top' | 'bottom', tabId?: TabId) => {
    const tid = tabId ?? activeTab?.id;
    if (!tid) return;
    updateLayout(tid, layout => {
      const findSess = (node: LayoutNode): PanelSession | null => {
        if (node.type === 'leaf' && node.id === fromNodeId) return node.panel.sessions.find(s => s.termId === termId) ?? null;
        if (node.type !== 'leaf') for (const c of node.children) { const r = findSess(c); if (r) return r; }
        return null;
      };
      const sess = findSess(layout);
      if (!sess) return layout;
      const direction: 'row' | 'column' = (zone === 'left' || zone === 'right') ? 'row' : 'column';
      const insertBefore = zone === 'left' || zone === 'top';
      let updated = removeSessionFromPanel(layout, fromNodeId, termId);
      updated = cleanEmptyLeaf(updated, fromNodeId);
      updated = splitNodeWithSessions(updated, toNodeId, direction, [sess], insertBefore);
      return updated;
    });
    setSelectedPanelForTab(tid, toNodeId);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  };

  const handleAddSession = (nodeId: string, shellName?: string, shellPath?: string, tabId?: TabId) => {
    const tid = tabId ?? activeTab?.id;
    if (!tid) return;
    const termId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sess: PanelSession = { termId, sessionId: '', sessionName: shellName || defaultShell.name, shellPath: shellPath || defaultShell.path };
    updateLayout(tid, layout => appendSessionsToPanel(layout, nodeId, [sess], true));
    setSelectedPanelForTab(tid, nodeId);
  };

  const handleDuplicateSession = (nodeId: string, termId: string, tabId?: TabId) => {
    const tid = tabId ?? activeTab?.id;
    if (!tid) return;
    const info = getTermSessionInfo(termId);
    if (!info) return;
    const newTermId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sess: PanelSession = { termId: newTermId, sessionId: info.sessionId || '', sessionName: info.sessionName || 'New Tab' };
    // 생성 전에 스타일(테마/폰트/불투명도)을 복제 → 새 터미널 생성 시 바로 반영됨
    cloneTermStyle(termId, newTermId);
    updateLayout(tid, layout => appendSessionsToPanel(layout, nodeId, [sess], true));
    registerTermSession(newTermId, info.sessionId || '', info.sessionName, info.host, info.quickSession);
    // 복제 대상이 quick connect 세션이면 PTY 스폰 차단 표식
    if (!info.sessionId && info.quickSession) markQuickConnectPending(newTermId);
    setTimeout(async () => {
      try {
        if (info.sessionId) {
          await (window as any).api?.connectSSH?.(newTermId, info.sessionId);
        } else if (info.quickSession) {
          // 빠른연결 복제 — 자격증명(username/password) 이 quickSession 에 없으면 prompt 모달로 입력 받기.
          // 원본 quick-connect 의 retry 로직과 동일 패턴.
          const tryConnect = async (sessInfo: any): Promise<void> => {
            const r = await (window as any).api?.quickConnectSSH?.(newTermId, sessInfo);
            if (r === 'need-credentials' || r === 'need-password') {
              const needUsername = r === 'need-credentials';
              window.dispatchEvent(new CustomEvent('ssh-password-prompt', {
                detail: {
                  termId: newTermId,
                  sessionId: '',
                  hostHint: sessInfo.host,
                  userHint: sessInfo.username,
                  needUsername,
                  resolve: (result: any) => {
                    if (result === null) {
                      clearQuickConnectPending(newTermId);
                      writeToTerm(newTermId, `\r\n\x1b[90m${tApp('term.connectCancelled')}\x1b[0m\r\n`);
                      writeToTerm(newTermId, `\x1b[33m${tApp('term.retryHint')}\x1b[0m\r\n`);
                      // 터미널 영역 클릭 1회 → 자격증명 모달 재오픈
                      setTimeout(() => {
                        const entry = termStore.get(newTermId);
                        const el = (entry?.term as any)?.element as HTMLElement | undefined;
                        if (!el) return;
                        const onceClick = (ev: MouseEvent) => {
                          ev.stopPropagation();
                          el.removeEventListener('mousedown', onceClick, true);
                          markQuickConnectPending(newTermId);
                          tryConnect(sessInfo).catch(() => {});
                        };
                        el.addEventListener('mousedown', onceClick, true);
                      }, 100);
                      return;
                    }
                    let nextUsername = sessInfo.username;
                    let nextPassword = '';
                    if (typeof result === 'string') nextPassword = result;
                    else if (result && typeof result === 'object') {
                      nextUsername = result.username || sessInfo.username;
                      nextPassword = result.password || '';
                    }
                    const next: any = {
                      ...sessInfo,
                      username: nextUsername,
                      name: nextUsername ? `${nextUsername}@${sessInfo.host}` : sessInfo.host,
                      auth: { type: 'password', password: nextPassword },
                    };
                    // 새 termId 의 quickSession 에 자격증명 저장 — 추후 재복제 시 또 재입력 안 함
                    registerTermSession(newTermId, '', nextUsername ? `${nextUsername}@${sessInfo.host}` : sessInfo.host, sessInfo.host, next);
                    tryConnect(next).catch(() => {});
                  },
                },
              }));
            }
          };
          tryConnect(info.quickSession).catch(() => {});
        }
        // 런타임에 변경된 인코딩까지 복제
        try {
          const srcEnc = await (window as any).api?.getSSHEncoding?.(termId);
          if (srcEnc) await (window as any).api?.setSSHEncoding?.(newTermId, srcEnc);
        } catch {}
        // 복제 직후 스타일 재적용 (새 xterm 마운트 이후에도 확실히 반영)
        cloneTermStyle(termId, newTermId);
      } catch {}
    }, 50);
  };

  const handleRenameSession = (nodeId: string, termId: string, name: string, tabId?: TabId) => {
    const tid = tabId ?? activeTab?.id;
    if (!tid) return;
    updateLayout(tid, layout => {
      function walk(node: LayoutNode): LayoutNode {
        if (node.type === 'leaf' && node.id === nodeId) {
          const sessions = node.panel.sessions.map(s => s.termId === termId ? { ...s, sessionName: name } : s);
          return { ...node, panel: { ...node.panel, sessions } };
        }
        if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
        return node;
      }
      return walk(layout);
    });
  };

  // 같은 sessionId 가 이미 열려있을 때 "이름 #N" 형식으로 고유 displayName 생성.
  // 이미 사용 중인 #N 은 건너뛰고 빈 번호를 채워 넣음.
  const makeUniqueDisplayName = (sessionId: string, baseName: string): string => {
    const stripMatch = baseName.match(/^(.*) #\d+$/);
    const root = stripMatch ? stripMatch[1] : baseName;
    const used = new Set<number>();
    let plainSeen = false;
    for (const t of tabs) {
      for (const s of collectAllSessions(t.layout)) {
        if (s.sessionId !== sessionId) continue;
        const m = s.sessionName.match(/^(.*) #(\d+)$/);
        if (m && m[1] === root) used.add(parseInt(m[2], 10));
        else if (s.sessionName === root) plainSeen = true;
      }
    }
    if (!plainSeen && used.size === 0) return `${root} #1`;
    let n = 1;
    while (used.has(n)) n++;
    return `${root} #${n}`;
  };

  const handleConnectDrop = (nodeId: string, sessionId: string, tabId?: TabId) => {
    const tid = tabId ?? activeTab?.id;
    const targetTab = tabId ? tabs.find(t => t.id === tabId) : activeTab;
    if (!tid || !targetTab) return;
    const doConnect = async () => {
      try {
        const data = await (window as any).api.listSessions();
        const allSessions = data?.sessions ?? data ?? [];
        const session = allSessions.find((s: any) => s.id === sessionId);
        if (!session) return;

        const displayName = makeUniqueDisplayName(sessionId, session.name);

        // 해당 패널의 활성 미니탭이 빈(sessionId='') 세션이면 교체
        const findEmpty = (node: LayoutNode): PanelSession | null => {
          if (node.type === 'leaf' && node.id === nodeId) {
            const sess = node.panel.sessions[node.panel.activeIdx];
            return (sess && !sess.sessionId) ? sess : null;
          }
          if (node.type !== 'leaf') for (const c of node.children) { const r = findEmpty(c); if (r) return r; }
          return null;
        };
        const emptySess = findEmpty(targetTab.layout);

        if (emptySess) {
          // 빈 미니탭 → 세션 정보 교체 후 연결
          resetTermConnectState(emptySess.termId);
          updateLayout(tid, layout => {
            function walk(node: LayoutNode): LayoutNode {
              if (node.type === 'leaf' && node.id === nodeId) {
                const sessions = node.panel.sessions.map((s, i) =>
                  i === node.panel.activeIdx ? { ...s, sessionId, sessionName: displayName } : s
                );
                return { ...node, panel: { ...node.panel, sessions } };
              }
              if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
              return node;
            }
            return walk(layout);
          });
          setTimeout(() => (window as any).api.connectSSH(emptySess.termId, sessionId), 100);
          if (session.theme) setTimeout(() => applyThemeToTerm(emptySess.termId, session.theme), 200);
          if (session.fontFamily || session.fontSize) setTimeout(() => applyFontToTerm(emptySess.termId, session.fontFamily, session.fontSize), 200);
          if (session.scrollback) applyScrollbackToTerm(emptySess.termId, session.scrollback);
          setTermBackspaceMode(emptySess.termId, session.backspaceKeyMode);
          setTermDeleteMode(emptySess.termId, session.deleteKeyMode);
          registerTermSession(emptySess.termId, sessionId, displayName, session.host ?? '');
        } else {
          // 빈 미니탭 없으면 기존 흐름
          setSelectedPanelForTab(tid, nodeId);
          handleConnectSession(session.id, session.name, null, session.theme, session.fontFamily, session.fontSize, session.scrollback);
        }
      } catch {}
    };
    doConnect();
  };

  const handleCloseSession = (nodeId: string, termId: string, tabId?: TabId) => {
    const tid = tabId ?? activeTab?.id;
    if (!tid) return;
    // 미니탭 X 버튼 — 해당 session 의 백엔드 리소스도 즉시 해제
    if (termId) releaseTermResources(termId);
    updateLayout(tid, layout => {
      let updated = removeSessionFromPanel(layout, nodeId, termId);
      updated = cleanEmptyLeaf(updated, nodeId);
      return updated;
    });
  };

  // 미니탭(개별 세션)을 분리/재부착 — 단일 세션 워크스페이스로 넘긴다.
  // 드롭 좌표가 다른 앱 창 위면 그 창으로 re-dock, 아니면 새 창. 좌표 미지정(메뉴)이면 새 창.
  // 복제하여 새 창으로 분리 — 원본은 그대로 두고, 새 termId 로 같은 sessionId 에 연결하는
  // 워크스페이스를 새 창에 만든다. 원본 터미널의 현재 화면 버퍼/스타일도 그대로 시드.
  const duplicateSessionToNewWindow = useCallback(async (_nodeId: string, termId: string) => {
    const info = getTermSessionInfo(termId);
    if (!info) return;
    const newTermId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const panelId = `panel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const layout: LayoutNode = {
      id: panelId, type: 'leaf',
      panel: { id: panelId, activeIdx: 0, sessions: [{ termId: newTermId, sessionId: info.sessionId || '', sessionName: info.sessionName || '' }] },
    };
    const st = getTermStyle(termId);
    // 원본 cwd 확보 — autoTrackPwd 캐시 우선, 없으면 main 에 온디맨드 조회 (/proc 기반).
    let originalCwd: string | null = getCurrentPwdForTerm(termId) || null;
    if (!originalCwd) {
      try {
        const r = await (window as any).api?.sshGetShellCwd?.({ termId });
        if (r?.ok && r.pwd) originalCwd = r.pwd;
      } catch {}
    }
    console.log('[duplicate] originalCwd =', originalCwd, 'sourceTermId =', termId);
    const payload: any = {
      kind: 'session' as const,
      buffers: {},
      styles: st ? { [newTermId]: st } : {},
      tab: JSON.parse(JSON.stringify({ id: tabId, title: info.sessionName || 'Session', layout })),
      connectAfterAdopt: [{ termId: newTermId, sessionId: info.sessionId || '', quickSession: info.quickSession || null, cdAfterConnect: originalCwd }],
    };
    await (window as any).api?.dropTab?.(payload, undefined);
  }, []);

  const detachSessionToNewWindow = useCallback(async (nodeId: string, termId: string, screenX?: number, screenY?: number) => {
    const tab = tabsRef.current.find(t => t.id === activeTabId);
    if (!tab) return;
    const sess = collectAllSessions(tab.layout).find(s => s.termId === termId);
    if (!sess) return;
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const panelId = `panel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const layout: LayoutNode = {
      id: panelId, type: 'leaf',
      panel: { id: panelId, activeIdx: 0, sessions: [{
        termId: sess.termId, sessionId: sess.sessionId, sessionName: sess.sessionName,
        shellPath: (sess as any).shellPath, shellCwd: (sess as any).shellCwd,
      }] },
    };
    const buf = serializeTermBuffer(termId);
    const st = getTermStyle(termId);
    const payload = { kind: 'session' as const, buffers: buf ? { [termId]: buf } : {}, styles: st ? { [termId]: st } : {}, tab: JSON.parse(JSON.stringify({ id: tabId, title: sess.sessionName || 'Session', layout })) };
    const point = (screenX != null && screenY != null) ? { x: screenX, y: screenY } : undefined;
    const res = await (window as any).api?.dropTab?.(payload, point);
    if (res === undefined) return;
    // 원본: 세션 제거 + xterm 만 dispose (백엔드 유지 — 대상 창이 재부착)
    try { disposeTermFully(termId); } catch {}
    // 분리 창에서 이게 마지막 세션이었으면 창을 닫는다 (빈 워크스페이스로 남지 않게).
    if (IS_DETACHED_WINDOW) {
      const total = tabsRef.current.reduce((n, t) => n + collectAllSessions(t.layout).length, 0);
      if (total <= 1) { try { (window as any).api?.windowClose?.(); } catch {} return; }
    }
    updateLayout(tab.id, l => cleanEmptyLeaf(removeSessionFromPanel(l, nodeId, termId), nodeId));
  }, [activeTabId]);

  const movePanel = useCallback((fromPanelId: string, toPanelId: string | null, position: 'before' | 'after' | 'inside' = 'after', tabId?: TabId) => {
    const tid = tabId ?? activeTab?.id;
    if (!tid) return;
    updateLayout(tid, layout => {
      const rr = removeLeafFromTree(layout, fromPanelId);
      if (!rr.removed) return layout;
      if (!toPanelId || position === 'inside') return replaceLeaf(rr.root, toPanelId ?? fromPanelId, rr.removed);
      return insertNear(rr.root, toPanelId, rr.removed, position);
    });
  }, [activeTab]);

  // ── SSH 연결 ──

  // 선택된 패널의 활성 미니탭이 끊겨있는지 확인
  const findDisconnectedActiveSession = (layout: LayoutNode, panelId: string): PanelSession | null => {
    if (layout.type === 'leaf') {
      if (layout.id !== panelId) return null;
      const sess = layout.panel.sessions[layout.panel.activeIdx];
      if (!sess) return null;
      // 로컬 쉘(PTY)이 실행 중이면 재사용하지 않음 → 새 미니탭 생성
      if (isTermPty(sess.termId)) return null;
      return sess;
    }
    for (const c of layout.children) { const r = findDisconnectedActiveSession(c, panelId); if (r) return r; }
    return null;
  };

  const handleConnectSession = (sessionId: string, sessionName: string, _targetPanelId?: string | null, sessionTheme?: string, sessionFontFamily?: string, sessionFontSize?: number, sessionScrollback?: number) => {
    if (!activeTab) return;
    // 터미널이 아닌 워크스페이스(브라우저/파일비교/로그분석/VPN/다국어/SQL Tool)에서 더블클릭한 경우
    // → 기존 터미널 워크스페이스 탭을 찾아 활성화하고 거기서 세션 연결 (없으면 새로 생성).
    // fileExplorer / fileEditor 는 아래에서 별도 처리(SFTP/편집기 흐름).
    const NON_TERMINAL_NON_FE: TabType[] = ['browser', 'compare', 'logAnalyzer', 'vpn', 'i18nEditor', 'sqlTool', 'messenger', 'microsip'];
    const isTermTabType = (t: TabType | undefined) => t === undefined || t === 'terminal';
    if (activeTab.type && NON_TERMINAL_NON_FE.includes(activeTab.type)) {
      // 이미 우측 분할에 터미널 워크스페이스가 떠 있으면 — activeTab 을 전환하지 않고
      // (분할이 풀리거나 좌우가 바뀌지 않게) 그 터미널에 바로 연결.
      if (splitRightTab && isTermTabType(splitRightTab.type)) {
        const panelId = selectedPanelByTab[splitRightTab.id] ?? findFirstLeafId(splitRightTab.layout);
        if (panelId) setSelectedPanelForTab(splitRightTab.id, panelId);
        connectSessionToTerminal(splitRightTab, panelId, sessionId, sessionName, sessionTheme, sessionFontFamily, sessionFontSize, sessionScrollback);
        return;
      }
      // 터미널 탭은 type 미지정 또는 'terminal' (실제로 type 필드 없는 게 일반적)
      let termTab = tabs.find(t => !t.type || t.type === 'terminal');
      let targetLeafId: string | null = null;
      let targetTabId: TabId;
      if (termTab) {
        setActiveTabId(termTab.id);
        targetLeafId = findFirstLeafId(termTab.layout);
        targetTabId = termTab.id;
      } else {
        // 터미널 탭이 하나도 없으면 새로 생성
        const id = `tab-${Date.now()}`;
        const layout = createInitialLayout(id);
        setTabs(prev => [...prev, { id, title: `Workspace ${prev.length + 1}`, layout }]);
        setActiveTabId(id);
        targetLeafId = findFirstLeafId(layout);
        targetTabId = id;
      }
      // 새 layout 의 leaf 로 선택 패널 갱신 — 옛 패널 ID 가 새 layout 에 없어서 연결 실패하던 문제 회피
      if (targetLeafId) setSelectedPanelForTab(targetTabId, targetLeafId);
      // setActiveTabId/setTabs 적용 후 최신 closure 의 handleConnectSession 을 호출하기 위해 ref 경유.
      // 직접 재귀 호출은 옛 activeTab 을 캡쳐한 stale closure 라 무한루프 발생.
      setTimeout(() => handleConnectSessionRef.current?.(sessionId, sessionName, _targetPanelId, sessionTheme, sessionFontFamily, sessionFontSize, sessionScrollback), 50);
      return;
    }
    // 파일 전송 탭이면 SFTP 직접 연결하여 파일 탐색기에 추가 (점프 호스트 설정도 반영)
    if (activeTab.type === 'fileExplorer') {
      (async () => {
        try {
          const data = await (window as any).api.listSessions();
          const allSessions = data?.sessions ?? data ?? [];
          const sess = allSessions.find((s: any) => s.id === sessionId);
          if (!sess) return;
          console.log('[fe-transfer dblclick] session:', { name: sess.name, host: sess.host, jumps: sess.jumps?.length || 0 });
          const connId = `sftp-fe-${Date.now()}`;
          const jumps = buildJumpChain(sess);
          const displayHost = jumps.length ? jumps[jumps.length - 1].host : sess.host;
          const result = await (window as any).api.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth, undefined, jumps.length ? jumps : undefined);
          if (result?.success) {
            window.dispatchEvent(new CustomEvent('fe-sftp-connected', { detail: { connId, sessionName, host: displayHost } }));
          } else {
            const msg = result?.error || tApp('common.unknownError');
            console.error('[fe-sftp-connect dblclick] failed:', msg);
            notifyError(tApp('fileTransfer.connectFail'), tApp('fileTransfer.connectFailDetail', { name: sessionName, msg }));
          }
        } catch (err: any) {
          console.error('[fe-sftp-connect dblclick] exception:', err);
        }
      })();
      return;
    }
    // activeTab(좌측) 과 splitRightTab(우측) 둘 다 터미널 워크스페이스인 경우 — 마지막으로
    // 커서/포커스가 있던 쪽에 연결 (항상 좌측이 아니라, 실제 사용자가 보고 있던 쪽).
    if (splitRightTab && isTermTabType(splitRightTab.type) && lastFocusedTerminalTabIdRef.current === splitRightTab.id) {
      const panelId = selectedPanelByTab[splitRightTab.id] ?? findFirstLeafId(splitRightTab.layout);
      connectSessionToTerminal(splitRightTab, panelId, sessionId, sessionName, sessionTheme, sessionFontFamily, sessionFontSize, sessionScrollback);
      return;
    }
    connectSessionToTerminal(activeTab, selectedPanelId, sessionId, sessionName, sessionTheme, sessionFontFamily, sessionFontSize, sessionScrollback);
  };

  // handleConnectSession 의 실제 연결 로직 — 대상 탭/패널을 명시적으로 받아서, 좌우 분할된
  // 워크스페이스 중 activeTab 이 아닌 splitRightTab 에도 activeTab 전환 없이 연결할 수 있게 분리.
  const connectSessionToTerminal = (
    tab: Tab, panelId: string | null, sessionId: string, sessionName: string,
    sessionTheme?: string, sessionFontFamily?: string, sessionFontSize?: number, sessionScrollback?: number,
  ) => {
    const applySessionTheme = (termId: string) => {
      if (sessionScrollback) applyScrollbackToTerm(termId, sessionScrollback);
      // backspace/delete 키 시퀀스 모드 — 즉시 + 세션 fetch 후 한 번 더 적용 (연결 직후 vi 등에서 바로 동작하도록)
      (async () => {
        try {
          const data = await (window as any).api?.listSessions?.();
          const all = data?.sessions ?? data ?? [];
          const s = all.find((x: any) => x.id === sessionId);
          if (s) {
            setTermBackspaceMode(termId, s.backspaceKeyMode);
            setTermDeleteMode(termId, s.deleteKeyMode);
          }
        } catch {}
      })();
      setTimeout(() => {
        if (sessionTheme) applyThemeToTerm(termId, sessionTheme);
        if (sessionFontFamily || sessionFontSize) applyFontToTerm(termId, sessionFontFamily, sessionFontSize);
        // cursorStyle / cursorBlink + 키 시퀀스 모드 적용 (세션 데이터에서 fetch)
        (async () => {
          try {
            const data = await (window as any).api?.listSessions?.();
            const all = data?.sessions ?? data ?? [];
            const s = all.find((x: any) => x.id === sessionId);
            // cursorStyle 미지정 시 'block' 으로 기본화. cursorBlink 는 항상 적용 (사용자 의도 반영)
            applyCursorStyleToTerm(termId, s?.cursorStyle || 'block', !!s?.cursorBlink);
            // 키 시퀀스 모드 재적용 — 터미널 생성/마운트가 늦어 첫 적용이 누락되는 race 보강
            if (s) {
              setTermBackspaceMode(termId, s.backspaceKeyMode);
              setTermDeleteMode(termId, s.deleteKeyMode);
            }
          } catch {}
        })();
      }, 200);
    };
    const registerTerm = async (termId: string, nameOverride?: string) => {
      // 세션 이름/호스트 정보도 전달
      const name = nameOverride ?? displayName;
      try {
        const data = await (window as any).api.listSessions();
        const sessions = data?.sessions ?? data ?? [];
        const sess = sessions.find((s: any) => s.id === sessionId);
        registerTermSession(termId, sessionId, name, sess?.host ?? '');
      } catch {
        registerTermSession(termId, sessionId, name, '');
      }
    };
    const displayName = makeUniqueDisplayName(sessionId, sessionName);

    // 선택된 패널의 활성 미니탭 확인
    if (panelId) {
      const activeSess = findDisconnectedActiveSession(tab.layout, panelId);
      if (!activeSess) {
        // 활성 세션 없거나 PTY 실행 중 → 선택된 패널에 새 미니탭으로 추가
        const { layout, termId } = addSessionToPanel(tab.layout, panelId, sessionId, displayName);
        setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, layout } : t));
        setTimeout(async () => {
          const r = await (window as any).api.connectSSH(termId, sessionId);
          if (r === 'need-password') {
            promptPasswordAndConnect(termId, sessionId);
          }
        }, 0);
        applySessionTheme(termId); registerTerm(termId);
        return;
      }
      if (activeSess) {
        // 연결 상태 확인 후 분기 — 연결 중(connecting)도 "사용 중"으로 간주해서 새 미니탭으로 추가
        const checkAndConnect = async () => {
          let connected = false;
          try { connected = await (window as any).api.isSSHConnected(activeSess.termId); } catch {}
          const connecting = isTermConnecting(activeSess.termId);
          if (connected || connecting) {
            // 연결 중이면 → 같은 패널에 새 미니탭으로 추가
            const { layout, termId } = addSessionToPanel(tab.layout, panelId!, sessionId, displayName);
            setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, layout } : t));
            setTimeout(async () => {
              const r = await (window as any).api.connectSSH(termId, sessionId);
              if (r === 'need-password') {
                promptPasswordAndConnect(termId, sessionId);
              }
            }, 0);
            applySessionTheme(termId); registerTerm(termId);
          } else {
            // 끊겨있으면 → 기존 termId 유지, 세션 정보만 교체 후 재연결
            // 같은 sessionId 였다면 기존 이름(#N) 유지, 아니면 새 unique 이름
            const reuseName = (activeSess.sessionId === sessionId && activeSess.sessionName)
              ? activeSess.sessionName
              : displayName;
            resetTermConnectState(activeSess.termId);
            updateLayout(tab.id, layout => {
              function walk(node: LayoutNode): LayoutNode {
                if (node.type === 'leaf' && node.id === panelId) {
                  const sessions = node.panel.sessions.map((s, i) =>
                    i === node.panel.activeIdx ? { ...s, sessionId, sessionName: reuseName } : s
                  );
                  return { ...node, panel: { ...node.panel, sessions } };
                }
                if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
                return node;
              }
              return walk(layout);
            });
            setTimeout(async () => {
              const r = await (window as any).api.connectSSH(activeSess.termId, sessionId);
              if (r === 'need-password') {
                promptPasswordAndConnect(activeSess.termId, sessionId);
              }
            }, 100);
            applySessionTheme(activeSess.termId); registerTerm(activeSess.termId, reuseName);
          }
        };
        checkAndConnect();
        return;
      }
    }

    const emptyLeafId = findEmptyLeafId(tab.layout);

    if (emptyLeafId) {
      const { layout, termId } = addSessionToPanel(tab.layout, emptyLeafId, sessionId, displayName);
      setSelectedPanelForTab(tab.id, emptyLeafId);
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, layout } : t));
      setTimeout(() => window.api?.connectSSH?.(termId, sessionId), 0);
      applySessionTheme(termId); registerTerm(termId);
      return;
    }

    // 빈 패널 없으면 첫 번째 패널에 미니탭으로 추가
    const firstLeafId = findFirstLeafId(tab.layout);
    if (firstLeafId) {
      const { layout, termId } = addSessionToPanel(tab.layout, firstLeafId, sessionId, displayName);
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, layout } : t));
      setTimeout(() => window.api?.connectSSH?.(termId, sessionId), 0);
      applySessionTheme(termId); registerTerm(termId);
    }
  };

  // 매 렌더마다 최신 클로저로 갱신 — 비-터미널 워크스페이스에서 탭 전환 후 connect 를
  // setTimeout 으로 재호출할 때 stale closure(옛 activeTab) 회피용.
  const handleConnectSessionRef = useRef(handleConnectSession);
  handleConnectSessionRef.current = handleConnectSession;

  const handleQuickConnect = (info: QuickConnectResult) => {
    if (!activeTab) return;
    // SFTP 프로토콜이거나 파일 전송 워크스페이스가 활성이면 SFTP 직접 연결로 처리
    if (info.protocol === 'sftp' || activeTab.type === 'fileExplorer') {
      // 이미 열린 파일 전송 워크스페이스가 있으면 재사용(거기에 새 탭으로 연결) — 없으면 새로 생성.
      const existingFe = tabs.find(t => t.type === 'fileExplorer');
      let feTabId: string;
      if (existingFe) {
        feTabId = existingFe.id;
        setActiveTabId(existingFe.id);
      } else {
        const id = `tab-fe-${Date.now()}`;
        const feTab = { id, title: tApp('tabs.fileTransfer'), layout: createInitialLayout(id), type: 'fileExplorer' as TabType };
        setTabs(prev => [...prev, feTab]);
        setActiveTabId(id);
        feTabId = id;
      }
      // FileExplorer 마운트 후 이벤트가 처리되도록 약간 지연
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('fe-quick-sftp-connect', { detail: { ...info, feTabId } }));
      }, 100);
      return;
    }
    const termId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const displayName = info.name;
    const sess: PanelSession = { termId, sessionId: '', sessionName: displayName };

    // 선택된 패널의 빈 미니탭을 우선 사용, 없으면 첫 빈 패널, 없으면 첫 패널에 미니탭 추가.
    // 재사용 조건: sessionId 비어있고, PTY 미실행, SSH 미연결/미연결중, 빠른연결 대기 중도 아님.
    // (로컬 셸 / 이미 SSH 접속된 빠른연결 세션 / 입력 대기 중 세션을 SSH 가 덮어쓰면 혼란스러움)
    const findEmptyActiveInPanel = (layout: LayoutNode, panelId: string): PanelSession | null => {
      if (layout.type === 'leaf') {
        if (layout.id !== panelId) return null;
        const s = layout.panel.sessions[layout.panel.activeIdx];
        if (!s || s.sessionId) return null;
        if (isTermPty(s.termId)) return null;
        if (isTermConnected(s.termId) || isTermConnecting(s.termId)) return null;
        return s;
      }
      for (const c of layout.children) { const r = findEmptyActiveInPanel(c, panelId); if (r) return r; }
      return null;
    };

    const connect = (tid: string) => {
      // 빠른연결은 sessionId='' 이지만 SSH 핸드셰이크 진행 중 — PTY 스폰 차단 표식
      markQuickConnectPending(tid);
      registerTermSession(tid, '', displayName, info.host, info);
      // 텔넷(raw TCP) — 접근통제 솔루션 로컬 평문 프록시. 자격증명 모달 없이 바로 raw 접속,
      // 로그인은 터미널 안에서(프록시가 보내는 로그인 프롬프트에) 사용자가 직접 입력.
      if ((info as any).protocol === 'telnet') {
        setTimeout(() => {
          try { (window as any).api?.telnetConnect?.(tid, info.host, info.port, undefined, undefined, info.encoding); }
          catch (e) { console.error('[telnet]', e); }
        }, 60);
        return;
      }
      setTimeout(async () => {
        const tryConnect = async (sessInfo: QuickConnectResult): Promise<void> => {
          const r = await (window as any).api?.quickConnectSSH?.(tid, sessInfo);
          if (r === 'need-credentials' || r === 'need-password') {
            const needUsername = r === 'need-credentials';
            // 자격증명 입력 모달 띄우기
            window.dispatchEvent(new CustomEvent('ssh-password-prompt', {
              detail: {
                termId: tid,
                sessionId: '',
                hostHint: sessInfo.host,
                userHint: sessInfo.username,
                needUsername,
                resolve: (result: any) => {
                  if (result === null) {
                    // 취소 — pending 해제 + 터미널에 취소/재시도 안내 메시지
                    clearQuickConnectPending(tid);
                    writeToTerm(tid, `\r\n\x1b[90m${tApp('term.connectCancelled')}\x1b[0m\r\n`);
                    writeToTerm(tid, `\x1b[33m${tApp('term.retryHint')}\x1b[0m\r\n`);
                    // 터미널 영역 클릭 1회 → 자격증명 모달 재오픈
                    setTimeout(() => {
                      const entry = termStore.get(tid);
                      const el = (entry?.term as any)?.element as HTMLElement | undefined;
                      if (!el) return;
                      const onceClick = (ev: MouseEvent) => {
                        ev.stopPropagation();
                        el.removeEventListener('mousedown', onceClick, true);
                        // 재연결 — quickConnectSSH 재호출하면 다시 need-credentials 반환 → 모달 재오픈
                        markQuickConnectPending(tid);
                        tryConnect(info).catch(() => {});
                      };
                      el.addEventListener('mousedown', onceClick, true);
                    }, 100);
                    return;
                  }
                  let nextUsername = sessInfo.username;
                  let nextPassword = '';
                  if (typeof result === 'string') {
                    nextPassword = result;
                  } else if (result && typeof result === 'object') {
                    nextUsername = result.username || sessInfo.username;
                    nextPassword = result.password || '';
                  }
                  const next: QuickConnectResult = {
                    ...sessInfo,
                    username: nextUsername,
                    name: nextUsername ? `${nextUsername}@${sessInfo.host}` : sessInfo.host,
                    auth: { type: 'password', password: nextPassword },
                  };
                  // 자격증명을 termSessionMap 에 저장 — 세션 복제 시 재입력 불필요
                  registerTermSession(tid, '', nextUsername ? `${nextUsername}@${sessInfo.host}` : sessInfo.host, sessInfo.host, next);
                  tryConnect(next).catch(() => {});
                },
              },
            }));
          }
        };
        tryConnect(info).catch(() => {});
      }, 100);
    };

    if (selectedPanelId) {
      const empty = findEmptyActiveInPanel(activeTab.layout, selectedPanelId);
      if (empty) {
        resetTermConnectState(empty.termId);
        updateLayout(activeTab.id, layout => {
          function walk(node: LayoutNode): LayoutNode {
            if (node.type === 'leaf' && node.id === selectedPanelId) {
              const sessions = node.panel.sessions.map((s, i) =>
                i === node.panel.activeIdx ? { ...s, sessionName: displayName } : s
              );
              return { ...node, panel: { ...node.panel, sessions } };
            }
            if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
            return node;
          }
          return walk(layout);
        });
        connect(empty.termId);
        return;
      }
    }

    const emptyLeafId = findEmptyLeafId(activeTab.layout);
    const targetLeafId = emptyLeafId || findFirstLeafId(activeTab.layout);
    if (!targetLeafId) return;
    updateLayout(activeTab.id, layout => appendSessionsToPanel(layout, targetLeafId, [sess], true));
    setSelectedPanelId(targetLeafId);
    connect(termId);
  };

  // 외부 프로그램(자산관리툴 등)이 ssh://host:port 인자로 PePe 를 호출한 경우 자동 SSH 접속.
  // 앱 초기화(shellPrefsLoaded) + 활성 탭 준비 후 1회만 실행.
  const startupSshHandledRef = useRef(false);
  useEffect(() => {
    if (startupSshHandledRef.current) return;
    if (IS_DETACHED_WINDOW) { startupSshHandledRef.current = true; return; } // 분리 창은 CLI 시작 SSH 무시
    if (!shellPrefsLoaded || !activeTab) return;
    startupSshHandledRef.current = true;
    (async () => {
      try {
        const tgt = await (window as any).api?.getStartupSshTarget?.();
        if (!tgt?.host) return;
        // 한 번 쓰고 비워서 이후 새 탭/리로드 시 재접속 안 되게
        try { (window as any).api?.clearStartupSshTarget?.(); } catch {}
        const proto: 'ssh' | 'telnet' = tgt.protocol === 'telnet' ? 'telnet' : 'ssh';
        const info: QuickConnectResult = {
          name: tgt.username ? `${tgt.username}@${tgt.host}` : `${tgt.host}:${tgt.port || (proto === 'telnet' ? 23 : 22)}`,
          host: tgt.host,
          port: tgt.port || (proto === 'telnet' ? 23 : 22),
          username: tgt.username || '',
          auth: { type: 'password', password: tgt.password || '' },
          encoding: 'utf-8',
          protocol: proto,
        };
        // 약간 지연 — 레이아웃/패널 마운트 완료 후 연결
        setTimeout(() => { try { handleQuickConnect(info); } catch (e) { console.error('[startup-ssh]', e); } }, 300);
      } catch (e) { console.error('[startup-ssh] fetch fail', e); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellPrefsLoaded, activeTab]);

  const handleDisconnectSession = (targetPanelId?: string | null) => {
    if (!activeTab) return;
    const findTerm = (node: LayoutNode): string | null => {
      if (node.type === 'leaf') {
        if (targetPanelId && node.id !== targetPanelId) return null;
        const sess = node.panel.sessions[node.panel.activeIdx];
        return sess?.termId ?? null;
      }
      for (const c of node.children) { const r = findTerm(c); if (r) return r; }
      return null;
    };
    const tid = findTerm(activeTab.layout);
    if (tid) releaseTermResources(tid);
  };

  // 아이콘은 JSON 값에 직접 포함됨 — 코드에서 prefix 부착하지 않음
  const menuDefs: MenuDef[] = [
    {
      label: tMenu('file.title'),
      items: [
        { label: tMenu('file.newWorkspace'), action: () => addTab() },
        { label: tMenu('file.closeWorkspace'), action: () => activeTab && closeTab(activeTab.id), disabled: tabs.length <= 1 },
        { separator: true, label: '' },
        { label: tMenu('file.exportSessions'), action: () => (window as any).api.exportSessions() },
        { label: tMenu('file.importSessions'), action: async () => { const r = await (window as any).api.importSessions(); if (r) { window.dispatchEvent(new Event('sessions-reload')); showToast(r.addedCount != null ? tMenu('file.importedToast', { added: r.addedCount, total: r.totalParsed }) : tMenu('file.importedToastSimple')); } } },
        { label: tApp('sessionMenu.wipe'), action: () => setSessionWipeDialog(true) },
        { label: tApp('sessionMenu.autoOrganize'), action: () => { void runAiSessionOrganize(); }, disabled: sessionOrganizeBusy },
        { separator: true, label: '' },
        { label: tMenu('file.quit'), action: () => window.close() },
      ],
    },
    {
      label: tMenu('edit.title'),
      items: [
        { label: tMenu('edit.copy'), shortcut: getKeybinding('copy'), action: () => document.execCommand('copy') },
        { label: tMenu('edit.paste'), shortcut: getKeybinding('paste'), action: () => { navigator.clipboard.readText().then(text => { const tid = getActiveTermId(); if (!tid) return; pasteToTerm(tid, text); }); } },
        { separator: true, label: '' },
        { label: tMenu('edit.find'), shortcut: getKeybinding('find'), action: () => setShowSearch(true) },
      ],
    },
    {
      label: tMenu('view.title'),
      items: [
        {
          label: tMenu('view.terminalTheme'),
          submenu: getThemeList().map(t => ({
            label: (t === themeName ? '✓ ' : '   ') + t,
            action: () => handleThemeChange(t),
          })),
        },
        {
          label: tMenu('view.windowTheme'),
          submenu: getWindowThemeList().map(wt => ({
            label: (wt.id === windowTheme ? '✓ ' : '   ') + wt.name,
            action: () => handleWindowThemeChange(wt.id),
          })),
        },
        {
          label: tMenu('view.uiLanguage'),
          submenu: availableLangs.map(l => ({
            label: (l === uiLang ? '✓ ' : '   ') + l,
            action: () => { setUiLang(l); setLanguage(l); },
          })),
        },
        { separator: true, label: '' },
        { label: tMenu('view.fontSizeUp'), shortcut: tMenu('view.wheelUp'), action: () => applyFontToAll(undefined, (Number(localStorage.getItem('terminalFontSize')) || 14) + 1) },
        { label: tMenu('view.fontSizeDown'), shortcut: tMenu('view.wheelDown'), action: () => applyFontToAll(undefined, Math.max(8, (Number(localStorage.getItem('terminalFontSize')) || 14) - 1)) },
      ],
    },
    {
      label: tMenu('window.title'),
      items: [
        { label: tMenu('window.splitV'), action: () => { if (activeTab && selectedPanelId) openSplitSessionPicker('column', selectedPanelId); }, disabled: !selectedPanelId },
        { label: tMenu('window.splitH'), action: () => { if (activeTab && selectedPanelId) openSplitSessionPicker('row', selectedPanelId); }, disabled: !selectedPanelId },
        { separator: true, label: '' },
        { label: tMenu('window.clearScreen'), shortcut: getKeybinding('clearScreen'), action: () => { const tid = getActiveTermId(); if (tid) clearScreenInTerm(tid); } },
        { label: tMenu('window.clearScrollback'), shortcut: getKeybinding('clearScrollback'), action: () => { const tid = getActiveTermId(); if (tid) clearScrollbackInTerm(tid); } },
        { label: tMenu('window.clearAll'), shortcut: getKeybinding('clearAll'), action: () => { const tid = getActiveTermId(); if (tid) clearAllInTerm(tid); } },
      ],
    },
    {
      label: tMenu('tools.title'),
      items: [
        { label: tMenu('tools.fileTransfer'), action: () => { void openFileTransferTab(tMenu('tools.fileTransfer')); }},
        { label: tMenu('tools.browserWs'), action: addBrowserTab },
        { label: tMenu('tools.compareWs'), action: addCompareTab },
        { label: tMenu('tools.logAnalyzerWs'), action: addLogAnalyzerTab },
        { label: tMenu('tools.vpnWs'), action: addVpnTab },
        { label: '📞 MicroSIP', action: addMicroSipTab },
        { label: tMenu('tools.i18nWs'), action: addI18nEditorTab },
        { separator: true, label: '' },
        { label: tMenu('tools.remoteShare'), action: () => setShowRemoteShare(true) },
        { separator: true, label: '' },
        { label: showToolbar ? tMenu('tools.toolbarHide') : tMenu('tools.toolbarShow'), action: () => setShowToolbar(v => !v) },
        { label: showQuickConnect ? tMenu('tools.quickConnectHide') : tMenu('tools.quickConnectShow'), action: () => setShowQuickConnect(v => !v) },
        { label: showClaudeChat ? tMenu('tools.claudeHide') : tMenu('tools.claudeShow'), action: () => setShowClaudeChat(v => !v) },
        { label: showBroadcast ? tMenu('tools.broadcastHide') : tMenu('tools.broadcastShow'), action: () => { setShowBroadcast(v => !v); } },
        { separator: true, label: '' },
        { label: tMenu('tools.xStart'), action: async () => {
          try {
            const r = await (window as any).api?.x11Start?.(0);
            if (r?.usedBundled) {
              setInfoModal({ title: tMenu('tools.xStartTitle'), text: tMenu('tools.xStartOk', { pid: r.pid }) });
              setTimeout(() => { setInfoModal(null); restoreTerminalFocus(); }, 1200);
            } else {
              setInfoModal({ title: tMenu('tools.xStartTitle'), text: `${tMenu('tools.xStartNoBundle')}\n\n${(r?.logs || []).slice(-5).join('\n')}` });
            }
          } catch (e: any) {
            setInfoModal({ title: tMenu('tools.xStartFail'), text: String(e?.message || e) });
          }
        }},
        { label: tMenu('tools.xStop'), action: async () => {
          try {
            await (window as any).api?.x11Stop?.(0);
            setInfoModal({ title: tMenu('tools.xStopTitle'), text: tMenu('tools.xStopOk') });
            setTimeout(() => { setInfoModal(null); restoreTerminalFocus(); }, 1200);
          } catch (e: any) {
            setInfoModal({ title: tMenu('tools.xStopFail'), text: String(e?.message || e) });
          }
        }},
        { label: tMenu('tools.xStatus'), action: async () => {
          try {
            const r = await (window as any).api?.x11Status?.();
            const text = r?.anyRunning
              ? `${tMenu('tools.xStatusRunning')}\n\n` + r.running.map((x: any) => `  • DISPLAY=:${x.displayNum}  PID=${x.pid}`).join('\n')
              : tMenu('tools.xStatusNone');
            setInfoModal({ title: tMenu('tools.xStatusTitle'), text });
          } catch (e: any) {
            setInfoModal({ title: tMenu('tools.xStatusFail'), text: String(e?.message || e) });
          }
        }},
        { separator: true, label: '' },
        { label: tMenu('tools.options'), action: async () => {
          setWordSepValue(getWordSeparator());
          setTermSettings(getTerminalSettings());
          setOptFontFamily(localStorage.getItem('terminalFontFamily') || '');
          setOptFontSize(Number(localStorage.getItem('terminalFontSize')) || 14);
          setOptDefaultShellPath(defaultShell.path);
          (window as any).api?.checkContextMenu?.().then((v: boolean) => setContextMenuRegistered(v)).catch(() => {});
          // 시스템 고정폭 폰트 감지
          const monoFonts = [
            'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Courier New',
            'D2Coding', 'D2Coding ligature', 'D2CodingLigature',
            'Fira Code', 'Fira Mono', 'JetBrains Mono',
            'Source Code Pro', 'Ubuntu Mono', 'IBM Plex Mono',
            'Hack', 'Inconsolata', 'Monaco', 'Menlo',
            'Noto Sans Mono', 'Roboto Mono', 'SF Mono',
            'NanumGothicCoding', 'Malgun Gothic',
            'Lucida Console', 'DejaVu Sans Mono',
          ];
          const detected: string[] = [];
          for (const f of monoFonts) {
            try { if (document.fonts.check(`12px "${f}"`)) detected.push(f); } catch {}
          }
          setAvailableFonts(detected);
          setOptionsTab('terminal');
          setKeybindingsDraft({ ...keybindingsState });
          try { const p = await (window as any).api.getSessionsPath(); setSessionsPathDisplay(p || ''); } catch {}
          setShowOptions(true);
        } },
      ],
    },
    {
      label: tMenu('help.title'),
      items: [
        { label: tMenu('help.manual'), action: () => setShowManual(true) },
        { separator: true, label: '' },
        { label: tMenu('help.keybindings'), action: () => {
          const kb = getKeybindings();
          const lines = Object.keys(KEYBINDING_LABELS).map(id => `${kb[id] || '(없음)'} — ${KEYBINDING_LABELS[id]}`);
          setInfoModal({ title: tKb('title'), text: (
            '── 사용자 지정 단축키 ──\n' +
            lines.join('\n') +
            '\n\n── 고정 단축키 ──\n' +
            'Alt+1~9 — 미니탭 전환\n' +
            'Alt+Enter — 현재 터미널 전체화면 토글\n' +
            'Ctrl+L — 스크롤 맨 아래로\n' +
            'Ctrl+마우스 휠 — 글꼴 크기 조절\n' +
            'F2 — 이름 변경\n' +
            '가운데 클릭 — 탭 닫기\n' +
            'Ctrl+↑/↓ — 세션/폴더 순서 이동\n\n' +
            '── 미니탭 ──\n' +
            '∨ 버튼 — 쉘 선택 (PowerShell, CMD, Git Bash 등)\n' +
            '우클릭 — 이름 변경 / 세션 복제 / 닫기\n' +
            '휠 스크롤 — 좌우 스크롤 (‹ › 버튼)\n\n' +
            '── 터미널 ──\n' +
            '우클릭 — 복사 / 붙여넣기 / 글꼴 / 인코딩 / 화면 지우기 등\n' +
            '더블클릭 (세션) — 연결\n\n' +
            '── 파일 트리 / 원격 편집 ──\n' +
            '파일 더블클릭 — 에디터 탭에서 열기\n' +
            'Ctrl+클릭 / Shift+클릭 — 다중 선택 (일괄 다운로드)\n' +
            '우클릭 — Claude 에 첨부 / 경로 복사 / 삭제\n' +
            '🔄 — 현재 경로 새로고침\n' +
            '📌 — 파일트리 고정/자동숨김 토글\n' +
            '좌측 경계 드래그 — 너비 조절\n' +
            'Ctrl+S (에디터) — 저장\n\n' +
            '── Claude 채팅 ──\n' +
            '오른쪽 가장자리 🤖 Claude 영역 hover — 사이드바 펼침 (unpin 모드)\n' +
            '📌 — 사이드바 고정/자동숨김 토글\n' +
            '좌측 경계 드래그 — 너비 조절 (더블클릭 = 기본값)\n' +
            '/ 버튼 — 슬래시 명령 팔레트 (↑↓ 탐색, Enter 실행, Esc 닫기)\n' +
            '📄+ / 📁+ — 로컬 파일 / 폴더 첨부\n' +
            'Ctrl+Wheel — 채팅 폰트 크기 조절\n' +
            'Enter (입력창) — 전송, Shift+Enter — 줄바꿈\n' +
            '🗑 — 대화 + 컨텍스트 초기화\n\n' +
            '── 일괄 전송 ──\n' +
            'Enter — 텍스트 전송\n' +
            'Ctrl+C / Ctrl+D — ^C / ^D 신호 전송\n' +
            '↑/↓ — 히스토리 탐색 / 세션 드롭다운\n' +
            'Esc — 히스토리 드롭다운만 닫음 (바는 유지)\n\n' +
            '── 빠른 연결 바 ──\n' +
            'Enter — 연결\n' +
            'Esc — 무시 (닫기는 ✕ 버튼으로만)'
          ) });
        }},
        { separator: true, label: '' },
        { label: tApp('update.check'), action: async () => {
          setUpdateStatus({ state: 'checking', manual: true });
          try { await (window as any).api?.updaterCheck?.(); } catch {}
        }},
        { separator: true, label: '' },
        { label: tMenu('help.about'), action: async () => {
          let sessPath = '';
          try { sessPath = await (window as any).api.getSessionsPath(); } catch {}
          // 버전은 Electron 에서 동적으로 가져옴 (package.json 기반 — 빌드시마다 자동 반영)
          let version = '';
          try { version = await (window as any).api?.getAppVersion?.() || ''; } catch {}
          // 최신 릴리즈 노트도 동적으로 — docs/RELEASE_v{version}.md 가 있으면 사용
          let releaseNotes = '';
          try { releaseNotes = await (window as any).api?.getReleaseNotes?.() || ''; } catch {}
          setInfoModal({ title: tMenu('help.about'), text: (
          `PePe Terminal(SSH) v${version || '?'}\n\n` +
          '만든이: Claude (feat. ghjeong[prompt])\n\n' +
          '── 터미널 기본 ──\n' +
          'SSH/SFTP 원격 접속 (비밀번호/키/Expect-Send 로그인)\n' +
          'ProxyJump — primary 호스트 경유 점프 타겟 SSH+SFTP 직결\n' +
          '로컬 쉘 (PowerShell, CMD, Git Bash, WSL)\n' +
          '기본 쉘 설정 / 미니탭별 쉘 선택\n' +
          '테마 / 글꼴 / 인코딩(utf-8/cp949/euc-kr) 변경\n' +
          '자동 재연결 (30초), 초기 연결 watchdog (20초 × 3회 재시도)\n' +
          '터미널 투명도 (0~100 슬라이더) / 데스크톱 투시 / Alt+Enter 전체화면\n\n' +
          '── 워크스페이스 / 패널 ──\n' +
          '다중 워크스페이스 탭\n' +
          '분할 패널 (가로/세로/타일 ⊞ N×ceil√N)\n' +
          '플로팅 확대 (패널 전체화면 오버레이)\n' +
          '패널별 미니탭, 탭 간 드래그앤드롭\n' +
          '미니탭 휠 스크롤 / ‹ › 버튼\n' +
          '탭별 선택 패널 기억 (재진입 시 자동 포커스)\n' +
          '선택된 패널 클릭 포커스 → 파일트리/Claude 컨텍스트 자동 전환\n\n' +
          '── 세션 관리 ──\n' +
          '폴더 + 세션 혼합 정렬 (Ctrl+↑/↓ 이동, 다중 선택)\n' +
          'Shift+클릭 범위 선택 / Ctrl+클릭 다중 선택\n' +
          '세션 가져오기/내보내기 (SecureCRT, Xshell)\n' +
          '세션 재클릭으로 encoding 창 토글\n' +
          'host:port 호버 플로팅 툴팁\n' +
          '폴더 펼침/접힘 상태 영속화 (앱 재시작 후 유지)\n' +
          '세션 편집:\n' +
          '  - 파일트리 초기 경로 지정\n' +
          '  - ProxyJump 점프 호스트 설정\n' +
          '  - 파일트리 자동추적 옵션 (cd 시 동기화)\n' +
          '  - 로그인 스크립트 (Expect/Send)\n\n' +
          '── 원격 파일 탐색/편집 (VS Code Remote 스타일) ──\n' +
          '워크스페이스 공유 파일 트리 (선택된 패널 세션 기준)\n' +
          '파일트리 핀/자동숨김 (📌 토글)\n' +
          '파일트리 너비 드래그 리사이즈 (160~800px)\n' +
          'SFTP 목록, mtime 정렬, 확장자별 색상/아이콘 (15+ 카테고리)\n' +
          '다중 선택 (Ctrl/Shift+클릭) + 일괄 다운로드\n' +
          '우클릭 메뉴: 파일 열기 / Claude 첨부 / 경로 복사 / 삭제\n' +
          'Monaco 에디터 탭 (구문강조, Ctrl+S 저장)\n' +
          '듀얼 패널 파일 탐색기 (SFTP/로컬 양방향) + ProxyJump 지원\n\n' +
          '── Claude Code 통합 ──\n' +
          '우측 Claude 채팅 사이드바 (핀/자동숨김, 드래그 리사이즈)\n' +
          '세션/파일트리/Claude 모두 unpin 시 z-index 마우스호버 우선\n' +
          'WebDAV 브리지 — 원격 SSH 를 로컬 UNC 로 실시간 마운트\n' +
          'Unix 경로 자동 UNC 번역 (/view/... → \\\\127.0.0.1@port\\...)\n' +
          'MCP ssh_exec — Claude 가 원격 SSH 명령 실행 (cleartool 등)\n' +
          '모델 목록 동적 갱신 — Anthropic /v1/models API 자동 조회 (1시간 캐시), 새 모델 출시 시 즉시 사용 가능\n' +
          '권한 모드 3종 — 권한 요청 / 편집 자동 수락 / 계획 모드 (모드별 도구별 승인 자동 토글)\n' +
          'effort 선택 (low / medium / high / max)\n' +
          'Plan 모드 + ExitPlanMode 승인 모달 (마크다운 + Mermaid 렌더)\n' +
          'PreToolUse hooks 기반 툴 단위 승인 (체크박스)\n' +
          '대화 세션 이어가기 (--resume) + stale 세션 자동 폴백\n' +
          '로컬 파일/폴더 첨부 (📄+ / 📁+ webkitdirectory 재귀)\n' +
          '슬래시 명령 팔레트 — Context/Model/Permission/Effort/Slash 섹션, 현재 개발된 기능에 맞게 동적 구성 (필터 + ↑↓ 네비)\n' +
          '사용량 패널 — Anthropic OAuth API 연동 (5h/주간/월간 한도 + 잔량)\n' +
          '거부한 계획 다시 보기 — 실수로 거부한 계획 내용 복기 가능\n' +
          '도구 호출 타임라인 접기/펼치기 (그룹/항목 양쪽)\n' +
          '툴 타임라인 실시간 인디케이터 (⏳/✓/✕)\n' +
          '채팅창 독립 폰트 설정 + Ctrl+Wheel 크기 조절\n' +
          '대화 이력 관리 (Pinned/Recents, 이름 변경, 핀 고정, 삭제)\n' +
          '대화 백그라운드 진행 — + 새 대화 시작해도 이전 대화 응답 계속 수신\n' +
          '대화 포크 (메시지 우클릭 → 여기서 포크하기, 이전 컨텍스트 transcript 자동 inject)\n' +
          '메시지 우클릭 메뉴 (텍스트/마크다운 복사, 컨텍스트 첨부, 포크)\n' +
          'Mermaid 다이어그램 자동 SVG 렌더 + 우클릭 PNG/SVG 저장·복사\n' +
          'GFM 테이블 자동 렌더 (탭 정렬 텍스트도 표로 자동 변환)\n' +
          'AskUserQuestion / ToolSearch 도구 차단 (비대화형 모드 안정성)\n' +
          'requestId 단위 프로세스 분리 — 다중 대화 동시 진행, 정확한 stop\n\n' +
          '── v2.0.6 신규 ──\n' +
          'PWD 자동추적 백그라운드 폴링 — 셸 history 0건 (별도 SSH exec 채널로 /proc/PID/cwd 폴링)\n' +
          '세션관리/파일트리/Claude 사이드바 트리거 둥근 모서리\n' +
          '워크스페이스 탭 드래그로 순서 변경\n' +
          '미니탭바 우측 컨트롤 토글 (⋯ 버튼) — 분할/플로팅/투명도 플로팅 팝업\n' +
          '터미널 우클릭 메뉴에 테마 변경 추가 (per-term)\n' +
          'Mermaid 다이어그램 PNG/SVG 저장·복사 + 우클릭 메뉴\n' +
          'Plan 승인 모달도 Mermaid 자동 렌더\n' +
          'GFM 테이블 + 탭 정렬 텍스트 자동 변환\n' +
          '일괄전송바·파일전송 세션 드롭다운: 🟢 연결됨 / ⚪ 연결안됨 그룹화\n' +
          '타이틀바 단순 클릭으로 최대화 창 복원되던 문제 수정 (5px 드래그 임계값)\n' +
          '터미널 vi 등 풀스크린 앱 사이즈 즉시 동기화 — refit 시 숨겨진 터미널 스킵\n' +
          'Alt+Enter 최대화 + 미니탭 플로팅 토글 시 화면 사라지는 문제 수정\n' +
          '도움말/정보 모달 스크롤 가능, 닫을 때 자동 터미널 포커스 복원\n' +
          '윈도우 포커스 복귀 시 자동 터미널 포커스 (Alt+Tab 등)\n\n' +
          '── 입력/브로드캐스트 ──\n' +
          '텍스트 일괄 전송 (현재/보이는 탭/연결된 세션/전체 세션 lazy connect)\n' +
          '빠른 연결 바 (host/user/password/enc 즉석 접속)\n' +
          'Ctrl+C / Ctrl+D 브로드캐스트\n' +
          '브로드캐스트 히스토리 (↑↓ 네비)\n' +
          'Esc 로 바가 닫히지 않음 — 닫기는 ✕ 버튼으로만\n\n' +
          '── 찾기 / 검색 ──\n' +
          '터미널 찾기 (Ctrl+Shift+F), 이력, 하이라이트\n' +
          '이전 / 다음 네비게이션\n\n' +
          '── 설정 (옵션) ──\n' +
          '기본 로컬 쉘 선택\n' +
          '탐색기 우클릭 "Open here" 등록/해제\n' +
          '세션 저장 경로 변경\n' +
          '단축키 커스터마이즈\n' +
          '터미널 설정 (word separator, scrollback 등)\n' +
          '내부 매뉴얼 뷰어 (docs/MANUAL.md)\n\n' +
          '── Windows 시스템 연동 ──\n' +
          '윈도우 프레임 없음 / 투명 / 최대화-복원\n' +
          '탐색기 "Open here" → 워크스페이스 해당 디렉토리 쉘\n\n' +
          '── 기술 스택 ──\n' +
          'Electron + React + TypeScript + Vite\n' +
          'xterm.js (터미널), Monaco Editor (코드 편집)\n' +
          'node-pty (로컬 쉘), ssh2 (SSH/SFTP)\n' +
          'webdav-server (SFTP→WebDAV 프록시)\n' +
          'marked (Markdown), iconv-lite (인코딩)\n' +
          'Claude Code CLI (@anthropic-ai/claude-code)\n\n' +
          '── 세션 저장 경로 ──\n' +
          (sessPath || '(알 수 없음)') +
          (releaseNotes ? `\n\n──────────────────────────────\n📋 v${version} 릴리즈 노트\n──────────────────────────────\n${releaseNotes}` : '')
        ) }); } },
      ],
    },
  ];

  // ── 파일 트리 — app-root 레벨에서 세션 사이드바 옆에 통합 렌더링 (세션 사이드바와 동일한 동작 패턴). ──
  // 우선순위: activeTab 이 터미널이면 그 탭, 아니면 splitRightTab 이 터미널이면 그 탭.
  const buildGlobalFileTree = (): React.ReactNode => {
    const isTerm = (t: Tab | undefined | null): boolean => !!t && (t.type === undefined || t.type === 'terminal');
    let primaryTab: Tab | null = null;
    let primaryPanelId: string | null = null;
    if (isTerm(activeTab)) {
      primaryTab = activeTab!;
      primaryPanelId = selectedPanelId;
    } else if (splitRightTab && isTerm(splitRightTab)) {
      primaryTab = splitRightTab;
      primaryPanelId = selectedPanelByTab[splitRightTab.id] ?? null;
    }
    if (!primaryTab) return null;
    const findLeaf = (n: any, id: string): any => {
      if (n.type === 'leaf') return n.id === id ? n : null;
      for (const c of n.children) { const r = findLeaf(c, id); if (r) return r; }
      return null;
    };
    const leaf = primaryPanelId ? findLeaf(primaryTab.layout, primaryPanelId) : null;
    const sess = leaf?.panel?.sessions[leaf.panel.activeIdx];
    const sessInfo = sess ? getTermSessionInfo(sess.termId) : null;
    const hasFileTree = !!(sess && (((sess.sessionId || sessInfo?.quickSession) && isTermConnected(sess.termId)) || isTermPty(sess.termId)));
    const onClickTrigger = () => {
      if (remoteTreePinned) return;
      if (remoteTreeHideTimer.current) { clearTimeout(remoteTreeHideTimer.current); remoteTreeHideTimer.current = null; }
      if (remoteTreeHoverShowTimer.current) { clearTimeout(remoteTreeHoverShowTimer.current); remoteTreeHoverShowTimer.current = null; }
      setRemoteTreeVisible(v => !v);
      setTopPanel('filetree');
    };
    const onEnterTrigger = () => {
      if (remoteTreePinned) return;
      if (remoteTreeHideTimer.current) { clearTimeout(remoteTreeHideTimer.current); remoteTreeHideTimer.current = null; }
      if (remoteTreeHoverShowTimer.current) clearTimeout(remoteTreeHoverShowTimer.current);
      remoteTreeHoverShowTimer.current = setTimeout(() => { setRemoteTreeVisible(true); setTopPanel('filetree'); }, 2500);
    };
    const onEnterTree = () => {
      if (remoteTreePinned) return;
      if (remoteTreeHideTimer.current) { clearTimeout(remoteTreeHideTimer.current); remoteTreeHideTimer.current = null; }
      setTopPanel('filetree');
    };
    const onLeaveTree = () => {
      if (remoteTreePinned) return;
      if (remoteTreeHideTimer.current) clearTimeout(remoteTreeHideTimer.current);
      remoteTreeHideTimer.current = setTimeout(() => setRemoteTreeVisible(false), 500);
    };
    const onLeaveTrigger = () => {
      if (remoteTreePinned) return;
      if (remoteTreeHoverShowTimer.current) { clearTimeout(remoteTreeHoverShowTimer.current); remoteTreeHoverShowTimer.current = null; }
    };
    const togglePin = () => {
      setRemoteTreePinned(p => !p);
      [50, 200, 500].forEach(ms => setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, ms));
    };
    return (
      <div className="global-file-tree-wrap">
        {!remoteTreePinned && (
          <div
            className="workspace-file-tree-trigger"
            style={
              sessionSidebarUnpinned
                ? { position: 'fixed', top: fileTreeTriggerTop, left: 0, bottom: 24, margin: 0, zIndex: 2000 }
                : { position: 'static', marginTop: fileTreePanelTop, marginBottom: 24 }
            }
          >
            <div className="workspace-file-tree-trigger-top" onClick={onClickTrigger} onMouseEnter={onEnterTrigger} onMouseLeave={onLeaveTrigger} style={{ cursor: 'pointer' }} title={tApp('fileTree.triggerTooltip')}>
              <span className="workspace-file-tree-trigger-text">{tApp('fileTree.triggerLabel')}</span>
            </div>
            <div className="workspace-file-tree-trigger-bottom" />
          </div>
        )}
        <div
          className={`workspace-file-tree ${!remoteTreePinned ? 'auto-hide' : ''} ${!remoteTreePinned && !remoteTreeVisible ? 'hidden' : ''} ${topPanel === 'filetree' ? 'top' : ''}`}
          style={remoteTreePinned ? { width: `${remoteTreeWidth}px`, flexShrink: 0 } : { width: `${remoteTreeWidth}px`, flexShrink: 0, left: fileTreePanelLeft }}
          onMouseEnter={onEnterTree}
          onMouseLeave={onLeaveTree}
        >
          <div className="workspace-file-tree-toolbar">
            <button
              className={`workspace-file-tree-pin ${remoteTreePinned ? 'pinned' : ''}`}
              onClick={togglePin}
              title={remoteTreePinned ? tApp('fileTree.unpinTooltip') : tApp('fileTree.pinTooltip')}
            >📌</button>
          </div>
          {hasFileTree ? (
            <RemoteFileTree
              key={sess.termId}
              termId={sess.termId}
              sessionName={sess.sessionName}
              sessionId={sess.sessionId}
              initialPath={getCurrentPwdForTerm(sess.termId)}
              onOpenFile={handleOpenRemoteFile}
              onAttachToClaude={handleAttachToClaude}
            />
          ) : (
            <div style={{ padding: 16, color: 'var(--win-text-dim)', fontSize: 12, flex: 1 }}>
              {tApp('fileTree.noSession', { defaultValue: '연결된 세션이 없습니다.' })}
            </div>
          )}
          <div
            className="workspace-file-tree-resizer"
            title={tApp('fileTree.resizeTooltip2')}
            onMouseDown={e => {
              e.preventDefault();
              const startX = e.clientX;
              const startWidth = remoteTreeWidth;
              const onMove = (ev: MouseEvent) => {
                const w = Math.max(160, Math.min(800, startWidth + (ev.clientX - startX)));
                setRemoteTreeWidth(w);
              };
              const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                setRemoteTreeWidth(curW => {
                  if (remoteTreeWidthLoadedRef.current) { try { (window as any).api?.setUIPrefs?.({ remoteTreeWidth: curW }); } catch {} }
                  return curW;
                });
                window.dispatchEvent(new Event('resize'));
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
            onDoubleClick={() => {
              setRemoteTreeWidth(240);
              try { (window as any).api?.setUIPrefs?.({ remoteTreeWidth: 240 }); } catch {}
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <div
      className={`app-root${showBroadcast ? ' has-broadcast' : ''}${showQuickConnect ? ' has-quickconnect' : ''}${(showQuickConnect || (showToolbar && toolbarSlot !== 'top')) ? ' has-topbar' : ''}${(showToolbar && toolbarSlot === 'top') ? ' has-toptoolbar' : ''}${fullscreenTermId ? ' term-fullscreen' : ''}${showClaudeChat && claudeChatPinned ? ' has-claude-pinned' : ''}${showClaudeChat && !claudeChatPinned ? ' has-claude-autohide' : ''}${showClaudeChat && !claudeChatPinned && claudeChatVisible ? ' has-claude-visible' : ''}${topPanel ? ' top-panel-' + topPanel : ''}`}
      onMouseMove={e => {
        // 세션/파일트리 모두 unpinned 상태에서 마우스 위치에 따라 topPanel 전환
        const t = e.target as HTMLElement | null;
        if (!t || !t.closest) return;
        if (t.closest('.session-sidebar-inner, .session-sidebar-trigger')) {
          if (topPanel !== 'session') setTopPanel('session');
        } else if (t.closest('.workspace-file-tree, .workspace-file-tree-trigger')) {
          if (topPanel !== 'filetree') setTopPanel('filetree');
        }
      }}
      data-fs-term={fullscreenTermId || ''}
      style={{ ['--claude-chat-width' as any]: `${claudeChatWidth}px` }}
    >
      <SessionList
        onConnect={(sid, name, panelId, sessTheme, ff, fs, sb) => handleConnectSession(sid, name, panelId, sessTheme, ff, fs, sb)}
        workspaceTabs={tabs.map(t => ({ id: t.id, title: t.title }))}
        activeTabId={activeTabId}
        onSetTopPanel={setTopPanel}
        onMultiConnect={(sessList, mode, opts) => {
          if (sessList.length === 0) return;
          let targetTabId = '';
          let targetPanelId: string | null = null;
          // 터미널 세션을 받을 수 있는 워크스페이스인지(파일 전송/편집기/브라우저/SQL 등 특수 탭 제외)
          const isTerminalWs = (t: any) => !t?.type || t.type === 'terminal';
          const openInNewWorkspace = () => {
            const newTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const newTab = { id: newTabId, title: `Workspace ${tabs.length + 1}`, layout: createInitialLayout(newTabId) } as any;
            setTabs(prev => [...prev, newTab]);
            setActiveTabId(newTabId);
            targetTabId = newTabId;
            targetPanelId = findFirstLeafId(newTab.layout);
          };
          if (opts?.newWorkspace) {
            openInNewWorkspace();
          } else if (opts?.targetTabId) {
            const wsTab = tabs.find(t => t.id === opts.targetTabId);
            if (!wsTab) return;
            if (!isTerminalWs(wsTab)) {
              notifyError(tApp('workspace.cannotConnectTitle'), tApp('workspace.cannotConnectTab', { title: wsTab.title }));
              openInNewWorkspace();
            } else {
              targetTabId = wsTab.id;
              setActiveTabId(wsTab.id);
              targetPanelId = findFirstLeafId(wsTab.layout);
            }
          } else {
            if (!activeTab) return;
            if (!isTerminalWs(activeTab)) {
              notifyError(tApp('workspace.cannotConnectTitle'), tApp('workspace.cannotConnectActive', { title: activeTab.title }));
              openInNewWorkspace();
            } else {
              targetTabId = activeTab.id;
              targetPanelId = selectedPanelId || findFirstLeafId(activeTab.layout);
            }
          }
          if (!targetTabId || !targetPanelId) return;
          const panelId = targetPanelId;
          if (mode === 'minitab') {
            // 한 번의 layout 업데이트로 모든 세션을 미니탭에 추가
            const newTermIds: string[] = [];
            updateLayout(targetTabId, layout => {
              let current = layout;
              for (const s of sessList) {
                const result = addSessionToPanel(current, panelId, s.id, s.name);
                newTermIds.push(result.termId);
                current = result.layout;
              }
              return current;
            });
            // 모든 세션 동시 연결 + 테마/폰트 적용
            setTimeout(() => {
              for (let i = 0; i < sessList.length; i++) {
                const s = sessList[i] as any;
                const tid = newTermIds[i];
                if (s.scrollback) applyScrollbackToTerm(tid, s.scrollback);
                setTimeout(() => {
                  if (s.theme) applyThemeToTerm(tid, s.theme);
                  if (s.fontFamily || s.fontSize) applyFontToTerm(tid, s.fontFamily, s.fontSize);
                }, 200);
                registerTermSession(tid, s.id, s.name, s.host ?? '');
                // sshd MaxStartups(기본 10:30:60) 초과 drop 방지 — 500ms 엇갈림으로 connect
                setTimeout(() => {
                  startInitialConnectWatchdog(tid, s.id);
                  window.api?.connectSSH?.(tid, s.id)?.then((r: string) => {
                    if (r === 'need-password') promptPasswordAndConnect(tid, s.id);
                  }).catch(() => {});
                }, i * 500);
              }
              // refit + 첫 세션으로 포커스 고정 (동시 연결 시 마지막 연결 세션이 포커스 훔치는 현상 방지)
              setTimeout(() => { refitAllTerms(); if (newTermIds[0]) focusTerm(newTermIds[0]); }, 200);
            }, 50);
          } else if (mode === 'split-tile') {
            // 타일 분할: N 개 세션을 ceil(sqrt(N)) 열 × ceil(N/cols) 행 그리드로 배치
            const newTermIds = sessList.map(() => `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
            const panelSessions: PanelSession[] = sessList.map((s, i) => ({
              termId: newTermIds[i],
              sessionId: s.id,
              sessionName: s.name,
            }));
            updateLayout(targetTabId, layout =>
              addSessionsAsTile(layout, panelId, panelSessions[0], panelSessions.slice(1))
            );
            setTimeout(() => {
              for (let i = 0; i < sessList.length; i++) {
                const s = sessList[i] as any;
                const tid = newTermIds[i];
                if (s.scrollback) applyScrollbackToTerm(tid, s.scrollback);
                setTimeout(() => {
                  if (s.theme) applyThemeToTerm(tid, s.theme);
                  if (s.fontFamily || s.fontSize) applyFontToTerm(tid, s.fontFamily, s.fontSize);
                }, 200);
                registerTermSession(tid, s.id, s.name, s.host ?? '');
                // sshd MaxStartups(기본 10:30:60) 초과 drop 방지 — 500ms 엇갈림으로 connect
                setTimeout(() => {
                  startInitialConnectWatchdog(tid, s.id);
                  window.api?.connectSSH?.(tid, s.id)?.then((r: string) => {
                    if (r === 'need-password') promptPasswordAndConnect(tid, s.id);
                  }).catch(() => {});
                }, i * 500);
              }
              // refit + 첫 세션 포커스 — stagger 전체가 끝난 뒤 포커스 확정 (뒤늦게 마운트되는 터미널이 훔쳐가는 것 방지)
              const focusDelay = 200 + sessList.length * 500 + 300;
              setTimeout(() => { refitAllTerms(); if (newTermIds[0]) focusTerm(newTermIds[0]); }, focusDelay);
            }, 50);
          } else {
            const dir: 'row' | 'column' = mode === 'split-v' ? 'row' : 'column';
            // 모든 세션의 termId를 미리 생성
            const newTermIds = sessList.map(() => `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
            // 단일 세션 분할: 현재 패널을 쪼개고 새 패널에 세션 추가
            if (sessList.length === 1) {
              const s = sessList[0];
              const newSess: PanelSession = { termId: newTermIds[0], sessionId: s.id, sessionName: s.name };
              updateLayout(targetTabId, layout => splitNodeWithSessions(layout, panelId, dir, [newSess], false));
              setTimeout(() => {
                const sAny = s as any;
                if (sAny.scrollback) applyScrollbackToTerm(newTermIds[0], sAny.scrollback);
                setTimeout(() => {
                  if (sAny.theme) applyThemeToTerm(newTermIds[0], sAny.theme);
                  if (sAny.fontFamily || sAny.fontSize) applyFontToTerm(newTermIds[0], sAny.fontFamily, sAny.fontSize);
                }, 200);
                registerTermSession(newTermIds[0], s.id, s.name, sAny.host ?? '');
                startInitialConnectWatchdog(newTermIds[0], s.id);
                window.api?.connectSSH?.(newTermIds[0], s.id)?.then((r: string) => {
                  if (r === 'need-password') promptPasswordAndConnect(newTermIds[0], s.id);
                }).catch(() => {});
                setTimeout(() => { refitAllTerms(); focusTerm(newTermIds[0]); }, 300);
              }, 50);
              return;
            }
            // 첫 번째는 현재 패널에 세션 추가, 나머지는 분할 패널 생성 — 한 번의 layout 업데이트로 처리
            updateLayout(targetTabId, layout => {
              // 첫 번째 세션을 현재 패널에 추가
              const result = addSessionToPanel(layout, panelId, sessList[0].id, sessList[0].name);
              // 첫 번째 세션의 termId를 교체
              const replaceTermId = (node: LayoutNode): LayoutNode => {
                if (node.type === 'leaf') {
                  const sessions = node.panel.sessions.map(s => s.termId === result.termId ? { ...s, termId: newTermIds[0] } : s);
                  return { ...node, panel: { ...node.panel, sessions } };
                }
                return { ...node, children: node.children.map(replaceTermId) };
              };
              let currentLayout = replaceTermId(result.layout);
              // 나머지 세션은 분할로 추가
              let lastPanelId = panelId;
              for (let i = 1; i < sessList.length; i++) {
                const newSess: PanelSession = { termId: newTermIds[i], sessionId: sessList[i].id, sessionName: sessList[i].name };
                currentLayout = splitNodeWithSessions(currentLayout, lastPanelId, dir, [newSess], false);
              }
              return currentLayout;
            });
            // 모든 세션 동시 연결 + 테마/폰트 적용
            setTimeout(() => {
              for (let i = 0; i < sessList.length; i++) {
                const s = sessList[i] as any;
                const tid = newTermIds[i];
                if (s.scrollback) applyScrollbackToTerm(tid, s.scrollback);
                setTimeout(() => {
                  if (s.theme) applyThemeToTerm(tid, s.theme);
                  if (s.fontFamily || s.fontSize) applyFontToTerm(tid, s.fontFamily, s.fontSize);
                }, 200);
                registerTermSession(tid, s.id, s.name, s.host ?? '');
                // sshd MaxStartups(기본 10:30:60) 초과 drop 방지 — 500ms 엇갈림으로 connect
                setTimeout(() => {
                  startInitialConnectWatchdog(tid, s.id);
                  window.api?.connectSSH?.(tid, s.id)?.then((r: string) => {
                    if (r === 'need-password') promptPasswordAndConnect(tid, s.id);
                  }).catch(() => {});
                }, i * 500);
              }
              // refit + 첫 세션 포커스 — stagger 전체가 끝난 뒤 포커스 확정 (뒤늦게 마운트되는 터미널이 훔쳐가는 것 방지)
              const focusDelay = 200 + sessList.length * 500 + 300;
              setTimeout(() => { refitAllTerms(); if (newTermIds[0]) focusTerm(newTermIds[0]); }, focusDelay);
            }, 50);
          }
        }}
        onDisconnect={panelId => handleDisconnectSession(panelId)}
        onOpenSqlTool={(sessionId, sessionName) => openSqlToolTab(sessionId, sessionName)}
        targetPanelId={selectedPanelId}
        onFileTransfer={async (sessionId, sessionName) => {
          // 이미 열린 파일 전송 워크스페이스가 있으면 재사용(거기에 새 연결 추가) — 없으면 새로 생성.
          const existingFe = tabs.find(t => t.type === 'fileExplorer');
          let feTabId: string;
          if (existingFe) {
            feTabId = existingFe.id;
            setActiveTabId(existingFe.id);
          } else {
            // 연결 대상은 우클릭한 세션의 SFTP(아래 fe-sftp-connected 로 탭 생성)이므로
            // initialTermId(활성 터미널 기준 auto-init)는 넘기지 않는다 — 무관한 세션 자동 오픈 방지.
            const id = `tab-fe-${Date.now()}`;
            const feTab = { id, title: tApp('tabs.fileTransfer'), layout: createInitialLayout(id), type: 'fileExplorer' as TabType };
            setTabs(prev => [...prev, feTab]);
            setActiveTabId(id);
            feTabId = id;
          }
          // SFTP 연결 — 점프 타겟 설정돼 있으면 ProxyJump 로 내부 서버까지 직결
          try {
            const data = await (window as any).api.listSessions();
            const allSessions = data?.sessions ?? data ?? [];
            const sess = allSessions.find((s: any) => s.id === sessionId);
            if (!sess) return;
            console.log('[fe-transfer] selected session:', { name: sess.name, host: sess.host, jumps: sess.jumps?.length || 0 });
            const connId = `sftp-fe-${Date.now()}`;
            const jumps = buildJumpChain(sess);
            const displayHost = jumps.length ? jumps[jumps.length - 1].host : sess.host;
            const result = await (window as any).api.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth, undefined, jumps.length ? jumps : undefined);
            if (result?.success) {
              window.dispatchEvent(new CustomEvent('fe-sftp-connected', { detail: { connId, sessionName, host: displayHost, feTabId } }));
            } else {
              const msg = result?.error || tApp('common.unknownError');
              console.error('[fe-sftp-connect] failed:', msg);
              notifyError(tApp('fileTransfer.connectFail'), tApp('fileTransfer.connectFailDetailLog', { name: sessionName, msg }));
            }
          } catch (err: any) {
            console.error('[fe-sftp-connect] exception:', err);
            notifyError(tApp('fileTransfer.connectException'), String(err?.message || err));
          }
        }}
      />
      {/* 통합 파일트리 — SessionList 옆(app-root) 에서 세션 사이드바와 동일한 패턴으로 항상 창 좌측에 렌더링. 좌우 분할 여부 무관. */}
      {buildGlobalFileTree()}
      <div className="app-main">
        <div className="tab-bar-row">
          <MenuBar menus={menuDefs} />
          <TabBar tabs={tabs} activeTabId={activeTabId} onChange={switchActiveTab} onAddTab={addTab}
          onAddBrowserTab={addBrowserTab}
          onAddCompareTab={addCompareTab}
          onAddLogAnalyzerTab={addLogAnalyzerTab}
          onAddVpnTab={addVpnTab}
          onAddMicroSipTab={addMicroSipTab}
          onAddI18nEditorTab={addI18nEditorTab}
          onCloseTab={closeTab} onRenameTab={renameTab}
          onReorderTabs={(fromId, toId) => {
            setTabs(prev => {
              const from = prev.findIndex(t => t.id === fromId);
              const to = prev.findIndex(t => t.id === toId);
              if (from < 0 || to < 0 || from === to) return prev;
              const next = prev.slice();
              const [moved] = next.splice(from, 1);
              next.splice(to, 0, moved);
              return next;
            });
          }}
          onDetachTab={detachTabToNewWindow}
          onSetTabColor={(id, color) => setTabs(prev => prev.map(t => t.id === id ? { ...t, color } : t))}
          splitRightTabId={splitRightTabId}
          onSplitRight={(id) => setSplitRightTabId(id)}
          onUnsplitRight={() => setSplitRightTabId(null)}
          canSplitType={(type: any) => SPLITTABLE_TYPES.includes(type)}
          hasSession={tabs.reduce((acc, t) => { acc[t.id] = collectAllSessions(t.layout).length > 0; return acc; }, {} as Record<string, boolean>)}
          availableShells={availableShells}
        />
          <div className="titlebar-drag-area"
            onDoubleClick={() => {
              (window as any).api?.windowEndDrag?.();
              (window as any).api?.windowToggleMaximize?.();
              [50, 200, 500].forEach(ms => setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, ms));
            }}
            onMouseDown={e => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              const api = (window as any).api;
              const startX = e.screenX, startY = e.screenY;
              let dragStarted = false;
              const THRESHOLD = 5; // 픽셀 — 이 이상 움직여야 실제 드래그로 처리 (단순 클릭은 창 복원 안되도록)
              const onMove = (ev: MouseEvent) => {
                if (!dragStarted) {
                  if (Math.abs(ev.screenX - startX) < THRESHOLD && Math.abs(ev.screenY - startY) < THRESHOLD) return;
                  dragStarted = true;
                  api?.windowStartDrag?.(startX, startY);
                }
                ev.preventDefault();
                api?.windowDragMove?.(ev.screenX, ev.screenY);
              };
              const onUp = () => {
                if (dragStarted) api?.windowEndDrag?.();
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
          />
          <div className="window-controls-right">
            <button className="window-ctrl-btn" onClick={() => (window as any).api?.windowMinimize?.()}>─</button>
            <button
              className="window-ctrl-btn"
              onClick={() => { (window as any).api?.windowToggleMaximize?.(); [50, 200, 500].forEach(ms => setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, ms)); }}
              title={isMaximized ? tApp('titlebar.restore') : tApp('titlebar.maximize')}
            >{isMaximized ? '❐' : '☐'}</button>
            <button className="window-ctrl-btn close" onClick={() => (window as any).api?.windowClose?.()}>✕</button>
          </div>
        </div>

        {/* 도구 모음 바 — 드래그하여 빠른연결 좌/우 또는 상단으로 이동 */}
        {(() => {
          const onDragStart = (e: React.MouseEvent) => {
            e.preventDefault();
            const onMove = (ev: MouseEvent) => {
              const qc = document.querySelector('.quick-connect-bar') as HTMLElement | null;
              if (qc) {
                const r = qc.getBoundingClientRect();
                if (ev.clientY >= r.top - 8 && ev.clientY <= r.bottom + 8) {
                  const mid = r.left + r.width / 2;
                  setToolbarDragHint(ev.clientX < mid ? 'qc-left' : 'qc-right');
                  return;
                }
              }
              setToolbarDragHint('top');
            };
            const onUp = () => {
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onUp);
              setToolbarDragHint(curr => {
                if (curr) setToolbarSlot(curr);
                return null;
              });
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          };
          const toolbar = (
            <div className="tool-toolbar" role="toolbar">
              <span
                className="tool-drag"
                title={tApp('toolbar.dragHint')}
                onMouseDown={onDragStart}
              >⋮⋮</span>
              <button className="tool-btn" title={tApp('toolbar.fileTransferTooltip')} onClick={() => { void openFileTransferTab(tApp('tabs.fileTransfer')); }}>📁</button>
          <button
            className="tool-btn"
            title={tApp('toolbar.resetSplitTooltip')}
            onClick={() => {
              if (!activeTab) return;
              updateLayout(activeTab.id, layout => resetLayoutSizes(layout));
              try { window.dispatchEvent(new CustomEvent('terminal-fit-all')); } catch {}
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* 2x2 균등 분할 패널 — 4개 같은 크기 박스 */}
              <rect x="0.7" y="0.7" width="5.8" height="5.8" rx="1" fill="#1e2d3d" stroke="#4a7a9b" strokeWidth="1"/>
              <rect x="7.5" y="0.7" width="5.8" height="5.8" rx="1" fill="#1e2d3d" stroke="#4a7a9b" strokeWidth="1"/>
              <rect x="0.7" y="7.5" width="5.8" height="5.8" rx="1" fill="#1e2d3d" stroke="#4a7a9b" strokeWidth="1"/>
              <rect x="7.5" y="7.5" width="5.8" height="5.8" rx="1" fill="#1e2d3d" stroke="#4a7a9b" strokeWidth="1"/>
              {/* 균등 정렬 인디케이터 — 우측 하단에 작은 ✓ */}
              <path d="M10 11.5 L11 12.5 L13 10.3" stroke="#4ade80" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            </svg>
          </button>
          <span className="tool-sep" />
          <button className={`tool-btn ${showQuickConnect ? 'active' : ''}`} title={showQuickConnect ? tApp('toolbar.quickConnectHide') : tApp('toolbar.quickConnectShow')} onClick={() => setShowQuickConnect(v => !v)}>⚡</button>
          <button
            className={`tool-btn ${showClaudeChat && claudeChatView === 'ai' ? 'active' : ''}`}
            title={showClaudeChat && claudeChatView === 'ai' ? tMsg('aiChatHide') : tMsg('aiChatShow')}
            onClick={() => {
              if (showClaudeChat && claudeChatView === 'ai') setShowClaudeChat(false);
              else openClaudeChatView('ai');
            }}
          >🤖</button>
          <button
            className={`tool-btn ${showClaudeChat && claudeChatView === 'messenger' ? 'active' : ''}${messengerAttention || messengerPopup ? ' messenger-alert' : ''}`}
            title={showClaudeChat && claudeChatView === 'messenger' ? tMsg('messengerHide') : (messengerAttention || messengerPopup ? tMsg('newMessage') : tMsg('messengerShow'))}
            onClick={() => {
              if (showClaudeChat && claudeChatView === 'messenger') setShowClaudeChat(false);
              else openClaudeChatView('messenger');
            }}
          >💬</button>
          <button className={`tool-btn ${showBroadcast ? 'active' : ''}`} title={showBroadcast ? tApp('toolbar.broadcastHide') : tApp('toolbar.broadcastShow')} onClick={() => setShowBroadcast(v => !v)}>📢</button>
          <button
            className={`tool-btn btn-pin${terminalPinned ? ' pinned' : ''}`}
            title={terminalPinned ? tApp('toolbar.terminalUnpin') : tApp('toolbar.terminalPin')}
            onClick={() => { const next = !terminalPinned; setTerminalPinned(next); if (!next) setTerminalVisible(false); }}
          >
            {terminalPinned ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" strokeLinecap="round" strokeLinejoin="round">
                {/* 눕혀진 터미널 */}
                <rect x="0.7" y="5.5" width="12.6" height="7.8" rx="1.5" fill="#1e2d3d" stroke="#4a7a9b" strokeWidth="1"/>
                <line x1="0.7" y1="7.5" x2="13.3" y2="7.5" stroke="#4a7a9b" strokeWidth="0.8"/>
                <polyline points="2,11.5 3.2,10.5 2,9.5" stroke="#4ade80" strokeWidth="1.3"/>
                <line x1="3.7" y1="10.5" x2="6.5" y2="10.5" stroke="#4ade80" strokeWidth="1.3"/>
                {/* 박힌 압정 (빨간색) */}
                <circle cx="10" cy="2" r="1.8" fill="#f87171" stroke="#dc2626" strokeWidth="0.8"/>
                <line x1="10" y1="3.8" x2="10" y2="8.5" stroke="#ef4444" strokeWidth="1.4"/>
                <polygon points="10,10.2 9.1,8.2 10.9,8.2" fill="#ef4444"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" strokeLinecap="round" strokeLinejoin="round">
                {/* 눕혀진 터미널 (점선 = 숨겨질 수 있음) */}
                <rect x="0.7" y="5.5" width="12.6" height="7.8" rx="1.5" fill="#1e2d3d" stroke="#4a7a9b" strokeWidth="1" strokeDasharray="2.5 1.5"/>
                <line x1="0.7" y1="7.5" x2="13.3" y2="7.5" stroke="#4a7a9b" strokeWidth="0.8" strokeDasharray="2.5 1.5"/>
                <polyline points="2,11.5 3.2,10.5 2,9.5" stroke="#4ade80" strokeWidth="1.3" opacity="0.4"/>
                <line x1="3.7" y1="10.5" x2="6.5" y2="10.5" stroke="#4ade80" strokeWidth="1.3" opacity="0.4"/>
                {/* 빠진 압정 — 눕혀져 있음 (회색) */}
                <circle cx="12" cy="1.8" r="1.5" fill="#94a3b8" stroke="#64748b" strokeWidth="0.7"/>
                <line x1="10.6" y1="2.6" x2="6.5" y2="5.5" stroke="#94a3b8" strokeWidth="1.3"/>
                <polygon points="5.8,6 6.2,4.6 7.5,5.1" fill="#94a3b8"/>
              </svg>
            )}
          </button>
          <span className="tool-sep" />
          <button className="tool-btn" title={tApp('toolbar.xStart')} onClick={async () => {
            try {
              const r = await (window as any).api?.x11Start?.(0);
              if (r?.usedBundled) {
                setInfoModal({ title: tApp('xServer.startTitle'), text: tApp('xServer.startOk', { pid: r.pid }) });
                setTimeout(() => { setInfoModal(null); restoreTerminalFocus(); }, 1200);
              } else {
                setInfoModal({ title: tApp('xServer.startTitle'), text: tApp('xServer.startNoBundle', { logs: (r?.logs || []).slice(-5).join('\n') }) });
              }
            } catch (e: any) { setInfoModal({ title: tApp('xServer.startFail'), text: String(e?.message || e) }); }
          }}>🖥️</button>
          <button className="tool-btn" title={tApp('toolbar.xStop')} onClick={async () => {
            try {
              await (window as any).api?.x11Stop?.(0);
              setInfoModal({ title: tApp('xServer.stopTitle'), text: tApp('xServer.stopOk') });
              setTimeout(() => { setInfoModal(null); restoreTerminalFocus(); }, 1200);
            } catch (e: any) { setInfoModal({ title: tApp('xServer.stopFail'), text: String(e?.message || e) }); }
          }}>🛑</button>
          <button className="tool-btn" title={tApp('toolbar.xStatus')} onClick={async () => {
            try {
              const r = await (window as any).api?.x11Status?.();
              const text = r?.anyRunning
                ? tApp('xServer.statusRunning') + '\n\n' + r.running.map((x: any) => `  • DISPLAY=:${x.displayNum}  PID=${x.pid}`).join('\n')
                : tApp('xServer.statusNone');
              setInfoModal({ title: tApp('xServer.statusTitle'), text });
            } catch (e: any) { setInfoModal({ title: tApp('xServer.statusFail'), text: String(e?.message || e) }); }
          }}>ℹ️</button>
          <span className="tool-sep" />
          <button className="tool-btn" title={tApp('toolbar.options')} onClick={async () => {
            setWordSepValue(getWordSeparator());
            setTermSettings(getTerminalSettings());
            setOptFontFamily(localStorage.getItem('terminalFontFamily') || '');
            setOptFontSize(Number(localStorage.getItem('terminalFontSize')) || 14);
            setOptDefaultShellPath(defaultShell.path);
            (window as any).api?.checkContextMenu?.().then((v: boolean) => setContextMenuRegistered(v)).catch(() => {});
            const monoFonts = ['Cascadia Mono','Cascadia Code','Consolas','Courier New','D2Coding','D2Coding ligature','D2CodingLigature','Fira Code','Fira Mono','JetBrains Mono','Source Code Pro','Ubuntu Mono','IBM Plex Mono','Hack','Inconsolata','Monaco','Menlo','Noto Sans Mono','Roboto Mono','SF Mono','NanumGothicCoding','Malgun Gothic','Lucida Console','DejaVu Sans Mono'];
            const detected: string[] = [];
            for (const f of monoFonts) { try { if (document.fonts.check(`12px "${f}"`)) detected.push(f); } catch {} }
            setAvailableFonts(detected);
            setOptionsTab('terminal');
            setKeybindingsDraft({ ...keybindingsState });
            try { const p = await (window as any).api.getSessionsPath(); setSessionsPathDisplay(p || ''); } catch {}
            setShowOptions(true);
          }}>⚙️</button>
            </div>
          );
          return (
            <>
              {showToolbar && toolbarSlot === 'top' && toolbar}
              {showToolbar && toolbarDragHint && toolbarDragHint !== toolbarSlot && (
                <div className="tool-drag-hint">{tApp('toolbar.dragHintPrefix', { target: toolbarDragHint === 'top' ? tApp('toolbar.dragTargetTop') : toolbarDragHint === 'qc-left' ? tApp('toolbar.dragTargetQcLeft') : tApp('toolbar.dragTargetQcRight') })}</div>
              )}
              {(showQuickConnect || (showToolbar && toolbarSlot !== 'top')) && (() => {
                const divider = <div className="qc-divider-static" />;
                const qcStyle: React.CSSProperties = (toolbarSlot === 'top' || !showToolbar)
                  ? { flex: 1 }
                  : { flex: '0 0 auto' };
                const qc = showQuickConnect ? (
                  <div className="qc-wrap" style={qcStyle}>
                    <QuickConnectBar
                      onConnect={handleQuickConnect}
                      onCancel={() => setShowQuickConnect(false)}
                      forceProtocol={activeTab?.type === 'fileExplorer' ? 'sftp' : undefined}
                    />
                  </div>
                ) : null;
                const tb = showToolbar ? toolbar : null;
                const onRowMouseDown = (e: React.MouseEvent) => {
                  // 인터랙티브 요소 위는 무시 — 빈 영역에서만 윈도우 드래그.
                  const tgt = e.target as HTMLElement;
                  if (tgt.closest('button, input, select, textarea, a, [contenteditable], .tool-btn, .tool-drag, .quickconnect-input, .qc-input')) return;
                  if (e.button !== 0) return;
                  e.preventDefault();
                  const startX = e.screenX, startY = e.screenY;
                  const api = (window as any).api;
                  const THRESHOLD = 5;
                  let dragStarted = false;
                  const onMove = (ev: MouseEvent) => {
                    if (!dragStarted) {
                      if (Math.abs(ev.screenX - startX) < THRESHOLD && Math.abs(ev.screenY - startY) < THRESHOLD) return;
                      dragStarted = true;
                      api?.windowStartDrag?.(startX, startY);
                    }
                    ev.preventDefault();
                    api?.windowDragMove?.(ev.screenX, ev.screenY);
                  };
                  const onUp = () => {
                    if (dragStarted) api?.windowEndDrag?.();
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                  };
                  window.addEventListener('mousemove', onMove);
                  window.addEventListener('mouseup', onUp);
                };
                return (
                  <div
                    className="quickconnect-row"
                    onMouseDown={onRowMouseDown}
                    onDoubleClick={() => {
                      (window as any).api?.windowEndDrag?.();
                      (window as any).api?.windowToggleMaximize?.();
                      [50, 200, 500].forEach(ms => setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, ms));
                    }}
                  >
                    {(toolbarSlot === 'top' || !showToolbar) && qc}
                    {showToolbar && toolbarSlot === 'qc-left' && (
                      <>
                        {tb}
                        {qc && divider}
                        {qc}
                      </>
                    )}
                    {showToolbar && toolbarSlot === 'qc-right' && (
                      <>
                        {qc}
                        {qc && divider}
                        {tb}
                      </>
                    )}
                  </div>
                );
              })()}
            </>
          );
        })()}

        {/* 콘텐츠 영역 — 핀 모드에서 이 래퍼에만 margin-right 적용 (상단 바들은 영향 없음) */}
        <div className="app-content-area">
        {showSearch && activeTab && (
          <SearchBar
            tabs={tabs}
            activeTab={activeTab}
            selectedPanelId={selectedPanelId}
            onClose={() => setShowSearch(false)}
          />
        )}

        {/* 워크스페이스 슬롯 — split 활성 시 activeTab / splitRightTab 이 좌우로 배치.
            각 탭의 display 는 flex/none, order 로 왼→오 순서 강제. */}
        <div className="workspace-row" style={{ display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0, minWidth: 0 }}>
        {/* FileExplorer — 탭마다 독립 인스턴스, 비활성 시 CSS 숨김 */}
        {tabs.filter(t => t.type === 'fileExplorer').map(t => (
          <div key={t.id} style={tabSlotStyle(t)}>
            <FileExplorer
              sessions={(() => {
                const live = tabs.filter(x => x.type !== 'fileExplorer')
                  .flatMap(x => collectAllSessions(x.layout))
                  .filter(s => s.sessionId || getTermSessionInfo(s.termId)?.quickSession);
                // 분리 창으로 옮겨진 직후 같은 창에 다른 탭이 없을 때를 위한 fallback: 떼어내기 직전 스냅샷.
                const liveTermIds = new Set(live.map((s: any) => s.termId));
                const fromCarry = carriedSiblingSessions
                  .filter(s => !liveTermIds.has(s.termId))
                  .map(s => ({ termId: s.termId, sessionId: s.sessionId, sessionName: s.sessionName, host: s.host } as any));
                return [...live, ...fromCarry];
              })()}
              initialTermId={t.initialTermId}
              initialRemotePath={t.initialRemotePath}
              tabId={t.id}
              initialState={t.fileExplorerState}
              onStateChange={(st) => {
                // ref 에 저장 — setTabs 를 매번 호출하면 재렌더 루프 발생. 분리 시점(serializeTab)에 끌어 쓴다.
                fileExplorerStateRef.current.set(t.id, st);
              }}
            />
          </div>
        ))}

        {/* FileEditor 탭들 - 마운트 유지. 파일트리 사이드바 동반 (해당 editor termId 기준). */}
        {tabs.filter(t => t.type === 'fileEditor' && t.editor).map(t => {
          // editor termId 로 세션 정보 찾기 — 터미널 탭에서 검색 → fallback to termSessionMap
          let sess: any = null;
          const target = t.editor!.termId;
          const findByTermId = (n: any): any => {
            if (n.type === 'leaf') {
              return n.panel?.sessions?.find((x: any) => x.termId === target) || null;
            }
            for (const c of n.children) { const r = findByTermId(c); if (r) return r; }
            return null;
          };
          for (const tt of tabs) {
            if (tt.type === 'fileEditor' || tt.type === 'fileExplorer') continue;
            const found = findByTermId(tt.layout);
            if (found) { sess = found; break; }
          }
          if (!sess) {
            const info = getTermSessionInfo(target);
            if (info) sess = { termId: target, sessionId: info.sessionId, sessionName: info.sessionName };
          }
          const sessInfo = sess ? getTermSessionInfo(sess.termId) : null;
          const showFileTree = !!sess && (
            ((sess.sessionId || sessInfo?.quickSession) && isTermConnected(sess.termId))
            || isTermPty(sess.termId)
          );
          const onClickTrigger = () => {
            if (remoteTreePinned) return;
            if (remoteTreeHideTimer.current) { clearTimeout(remoteTreeHideTimer.current); remoteTreeHideTimer.current = null; }
            if (remoteTreeHoverShowTimer.current) { clearTimeout(remoteTreeHoverShowTimer.current); remoteTreeHoverShowTimer.current = null; }
            setRemoteTreeVisible(v => !v);
            setTopPanel('filetree');
          };
          const onEnterTrigger = () => {
            if (remoteTreePinned) return;
            if (remoteTreeHideTimer.current) { clearTimeout(remoteTreeHideTimer.current); remoteTreeHideTimer.current = null; }
            if (remoteTreeHoverShowTimer.current) clearTimeout(remoteTreeHoverShowTimer.current);
            remoteTreeHoverShowTimer.current = setTimeout(() => { setRemoteTreeVisible(true); setTopPanel('filetree'); }, 2500);
          };
          const onEnterTree = () => {
            if (remoteTreePinned) return;
            if (remoteTreeHideTimer.current) { clearTimeout(remoteTreeHideTimer.current); remoteTreeHideTimer.current = null; }
            setTopPanel('filetree');
          };
          const onLeaveTree = () => {
            if (remoteTreePinned) return;
            if (remoteTreeHideTimer.current) clearTimeout(remoteTreeHideTimer.current);
            remoteTreeHideTimer.current = setTimeout(() => setRemoteTreeVisible(false), 500);
          };
          const onLeaveTrigger = () => {
            if (remoteTreePinned) return;
            if (remoteTreeHoverShowTimer.current) { clearTimeout(remoteTreeHoverShowTimer.current); remoteTreeHoverShowTimer.current = null; }
          };
          return (
            <div key={t.id} style={{ ...tabSlotStyle(t), overflow: 'hidden', flexDirection: 'row', position: 'relative' }}>
              {showFileTree && !remoteTreePinned && (
                <div
                  className="workspace-file-tree-trigger"
                  style={{ ['--file-tree-trigger-top' as any]: `${fileTreeTriggerTop}px` }}
                >
                  <div className="workspace-file-tree-trigger-top" onClick={onClickTrigger} onMouseEnter={onEnterTrigger} onMouseLeave={onLeaveTrigger} style={{ cursor: 'pointer' }} title={tApp('fileTree.triggerTooltip')}>
                    <span className="workspace-file-tree-trigger-text">{tApp('fileTree.triggerLabel')}</span>
                  </div>
                  <div className="workspace-file-tree-trigger-bottom" />
                </div>
              )}
              {showFileTree && (
                <div
                  className={`workspace-file-tree ${!remoteTreePinned ? 'auto-hide' : ''} ${!remoteTreePinned && !remoteTreeVisible ? 'hidden' : ''} ${topPanel === 'filetree' ? 'top' : ''}`}
                  style={{ width: `${remoteTreeWidth}px`, flexShrink: 0 }}
                  onMouseEnter={onEnterTree}
                  onMouseLeave={onLeaveTree}
                >
                  <div className="workspace-file-tree-toolbar">
                    <button
                      className={`workspace-file-tree-pin ${remoteTreePinned ? 'pinned' : ''}`}
                      onClick={() => setRemoteTreePinned(p => !p)}
                      title={remoteTreePinned ? tApp('fileTree.unpinTooltip') : tApp('fileTree.pinTooltip')}
                    >📌</button>
                  </div>
                  <RemoteFileTree
                    key={sess.termId}
                    termId={sess.termId}
                    sessionName={sess.sessionName}
                    sessionId={sess.sessionId}
                    initialPath={getCurrentPwdForTerm(sess.termId)}
                    onOpenFile={handleOpenRemoteFile}
                    onAttachToClaude={handleAttachToClaude}
                  />
                  <div
                    className="workspace-file-tree-resizer"
                    title={tApp('fileTree.resizeTooltip')}
                    onMouseDown={e => {
                      e.preventDefault();
                      const startX = e.clientX;
                      const startW = remoteTreeWidth;
                      const onMove = (ev: MouseEvent) => {
                        const dx = ev.clientX - startX;
                        const next = Math.max(160, Math.min(720, startW + dx));
                        setRemoteTreeWidth(next);
                      };
                      const onUp = () => {
                        window.removeEventListener('mousemove', onMove);
                        window.removeEventListener('mouseup', onUp);
                        setRemoteTreeWidth(curW => {
                          if (remoteTreeWidthLoadedRef.current) { try { (window as any).api?.setUIPrefs?.({ remoteTreeWidth: curW }); } catch {} }
                          return curW;
                        });
                        window.dispatchEvent(new Event('resize'));
                      };
                      window.addEventListener('mousemove', onMove);
                      window.addEventListener('mouseup', onUp);
                    }}
                    onDoubleClick={() => {
                      setRemoteTreeWidth(240);
                      try { (window as any).api?.setUIPrefs?.({ remoteTreeWidth: 240 }); } catch {}
                    }}
                  />
                </div>
              )}
              <FileEditor
                termId={t.editor!.termId}
                remotePath={t.editor!.remotePath}
                fileName={t.editor!.fileName}
                onAnalyzeWithAI={(ctx, agent) => {
                  setClaudeFileContext([ctx]);
                  setAiAgent(agent);
                  setShowClaudeChat(true);
                }}
              />
            </div>
          );
        })}

        {/* 특수 워크스페이스 탭들 — ErrorBoundary 로 격리 (한 컴포넌트 크래시가 전체 앱 죽이지 않도록) */}
        {tabs.filter(t => t.type === 'browser').map(t => (
          <div key={t.id} style={tabSlotStyle(t)}>
            <ErrorBoundary label={tApp('errorBoundary.browser')}>
              <BrowserPane
                initialUrl="https://www.google.com"
                connectedSessions={connectedBrowserSessions}
                onTitleChange={(title) => renameTab(t.id, `🌐 ${title}`)}
                initialState={t.workspaceState}
                onStateChange={(st: any) => { workspaceStateRef.current.set(t.id, st); }}
              />
            </ErrorBoundary>
          </div>
        ))}
        {tabs.filter(t => t.type === 'compare').map(t => (
          <div key={t.id} style={tabSlotStyle(t)}>
            <ErrorBoundary label={tApp('errorBoundary.compare')}>
              <CompareWorkspace
                sessions={tabs.filter(t => t.type !== 'fileExplorer' && t.type !== 'fileEditor' && !t.type?.match(/browser|compare|logAnalyzer|vpn|i18n|sqlTool|messenger|microsip/)).flatMap(t => collectAllSessions(t.layout)).filter(s => s.sessionId)}
                initialState={t.workspaceState}
                onStateChange={(st: any) => { workspaceStateRef.current.set(t.id, st); }}
              />
            </ErrorBoundary>
          </div>
        ))}
        {tabs.filter(t => t.type === 'logAnalyzer').map(t => (
          <div key={t.id} style={tabSlotStyle(t)}>
            <ErrorBoundary label={tApp('errorBoundary.logAnalyzer')}>
              <LogAnalyzer
                sessions={tabs.filter(t => t.type !== 'fileExplorer' && t.type !== 'fileEditor' && !t.type?.match(/browser|compare|logAnalyzer|vpn|i18n|sqlTool|messenger|microsip/)).flatMap(t => collectAllSessions(t.layout)).filter(s => s.sessionId)}
                initialState={t.workspaceState}
                onStateChange={(st: any) => { workspaceStateRef.current.set(t.id, st); }}
              />
            </ErrorBoundary>
          </div>
        ))}
        {tabs.filter(t => t.type === 'vpn').map(t => (
          <div key={t.id} style={tabSlotStyle(t)}>
            <ErrorBoundary label="VPN">
              <VpnWorkspace />
            </ErrorBoundary>
          </div>
        ))}
        {tabs.filter(t => t.type === 'microsip').map(t => (
          <div key={t.id} style={tabSlotStyle(t)}>
            <ErrorBoundary label="MicroSIP">
              <MicroSipWorkspace />
            </ErrorBoundary>
          </div>
        ))}
        {tabs.filter(t => t.type === 'i18nEditor').map(t => (
          <div key={t.id} style={tabSlotStyle(t)}>
            <ErrorBoundary label={tApp('errorBoundary.i18nEditor')}>
              <TranslationEditor />
            </ErrorBoundary>
          </div>
        ))}
        {/* SQL Tool 탭은 sessionId 별로 마운트 유지 (재방문 시 쿼리/연결 상태 보존) */}
        {tabs.filter(t => t.type === 'sqlTool').map(t => {
          // 분리/복원으로 carry 된 workspaceState 가 있으면 자식 마운트 전 cache 에 hydrate.
          if (t.workspaceState && t.sqlTool?.sessionId) {
            hydrateSqlSession(t.sqlTool.sessionId, t.workspaceState);
          }
          return (
            <div key={t.id} style={{ ...tabSlotStyle(t), overflow: 'hidden' }}>
              <ErrorBoundary label={`SQL Tool — ${t.sqlTool!.sessionName}`}>
                <SqlToolWorkspace sessionId={t.sqlTool!.sessionId} sessionName={t.sqlTool!.sessionName} />
              </ErrorBoundary>
            </div>
          );
        })}

        {(() => {
          // 터미널 워크스페이스 렌더 — activeTab / splitRightTab 이 터미널이면 각각 호출.
          const renderTerminalTab = (tab: Tab, panelId: string | null, setPanelId: (id: string) => void, opts?: { showFileTree?: boolean; splitRightSlot?: boolean }) => {
          const splitRightSlot = !!opts?.splitRightSlot;
          // 파일트리는 app-root 레벨(buildGlobalFileTree)에서 세션 사이드바 옆에 통합 렌더링됨.
          const isUnfocusedSplitSide = !!splitRightTab && lastFocusedTerminalTabId !== null && lastFocusedTerminalTabId !== tab.id;
          return (
            <div
              className={[splitRightSlot ? 'split-right-terminal-slot' : null, isUnfocusedSplitSide ? 'split-side-unfocused' : null].filter(Boolean).join(' ') || undefined}
              style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0, position: 'relative', ['--file-tree-trigger-top' as any]: `${fileTreeTriggerTop}px` }}
              onMouseDownCapture={() => markFocusedTerminalTab(tab.id)}
              onFocusCapture={() => markFocusedTerminalTab(tab.id)}
            >
              <div className="workspace-content-row" style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
              <div className="workspace-content-col" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'row', position: 'relative' }}>
                {!terminalPinned && (() => {
                  const leaves: { nodeId: string; name: string }[] = [];
                  const walkLeaves = (node: any) => {
                    if (node.type === 'leaf') {
                      const sess = node.panel.sessions[node.panel.activeIdx];
                      leaves.push({ nodeId: node.id, name: sess?.sessionName || 'Terminal' });
                    } else if (node.children) {
                      node.children.forEach(walkLeaves);
                    }
                  };
                  walkLeaves(tab.layout);
                  const openPanel = (nodeId: string) => {
                    if (!nodeId) return;
                    if (terminalHideTimer.current) { clearTimeout(terminalHideTimer.current); terminalHideTimer.current = null; }
                    if (terminalHoverShowTimer.current) { clearTimeout(terminalHoverShowTimer.current); terminalHoverShowTimer.current = null; }
                    setPanelId(nodeId);
                    setTerminalVisible(true);
                    setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, 80);
                  };
                  return (
                    <div className="terminal-sidebar-trigger">
                      <div
                        className="terminal-sidebar-trigger-top"
                        title={tApp('panel.openTerminalTooltip')}
                        onClick={() => openPanel(leaves[0]?.nodeId || '')}
                        onMouseEnter={() => {
                          if (terminalHideTimer.current) { clearTimeout(terminalHideTimer.current); terminalHideTimer.current = null; }
                          if (terminalHoverShowTimer.current) clearTimeout(terminalHoverShowTimer.current);
                          terminalHoverShowTimer.current = setTimeout(() => setTerminalVisible(true), 300);
                        }}
                        onMouseLeave={() => {
                          if (terminalHoverShowTimer.current) { clearTimeout(terminalHoverShowTimer.current); terminalHoverShowTimer.current = null; }
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="1" y="3" width="12" height="9" rx="1.5" />
                          <line x1="1" y1="6" x2="13" y2="6" />
                          <line x1="4" y1="3" x2="4" y2="6" />
                          <line x1="7" y1="3" x2="7" y2="6" />
                        </svg>
                      </div>
                      <div
                        className="terminal-sidebar-trigger-pin"
                        title={tApp('panel.pinTerminalTooltip')}
                        onClick={(e) => { e.stopPropagation(); setTerminalPinned(true); }}
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="0.7" y="5.5" width="12.6" height="7.8" rx="1.5" fill="#1e2d3d" stroke="#4a7a9b" strokeWidth="1"/>
                          <line x1="0.7" y1="7.5" x2="13.3" y2="7.5" stroke="#4a7a9b" strokeWidth="0.8"/>
                          <polyline points="2,11.5 3.2,10.5 2,9.5" stroke="#4ade80" strokeWidth="1.3"/>
                          <line x1="3.7" y1="10.5" x2="6.5" y2="10.5" stroke="#4ade80" strokeWidth="1.3"/>
                          <circle cx="10" cy="2" r="1.8" fill="#f87171" stroke="#dc2626" strokeWidth="0.8"/>
                          <line x1="10" y1="3.8" x2="10" y2="8.5" stroke="#ef4444" strokeWidth="1.4"/>
                          <polygon points="10,10.2 9.1,8.2 10.9,8.2" fill="#ef4444"/>
                        </svg>
                      </div>
                      {leaves.map(leaf => (
                        <div
                          key={leaf.nodeId}
                          className={`terminal-sidebar-trigger-tab${panelId === leaf.nodeId ? ' active' : ''}`}
                          title={leaf.name}
                          onClick={() => openPanel(leaf.nodeId)}
                        >
                          <span className="terminal-sidebar-trigger-tab-text">{leaf.name}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                <div
                  className={`terminal-layout-wrap${!terminalPinned ? ' auto-hide' : ''}${!terminalPinned && !terminalVisible ? ' hidden' : ''}`}
                  onMouseLeave={() => {
                    if (terminalPinned) return;
                    if (terminalHideTimer.current) clearTimeout(terminalHideTimer.current);
                    terminalHideTimer.current = setTimeout(() => {
                      setTerminalVisible(false);
                      setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, 80);
                    }, 500);
                  }}
                  onMouseEnter={() => {
                    if (terminalPinned) return;
                    if (terminalHideTimer.current) { clearTimeout(terminalHideTimer.current); terminalHideTimer.current = null; }
                  }}
                >
                  {/* shellPrefsLoaded 전에 마운트되면 shellPath=undefined 로 PowerShell 폴백되므로 지연 렌더 */}
                  {shellPrefsLoaded && <Layout root={tab.layout}
                    selectedPanelId={panelId}
                    onSplit={(nodeId, dir) => openSplitSessionPicker(dir, nodeId, tab.id)}
                    onSplitWithPicker={(nodeId, dir) => openSplitSessionPickerWithPrompt(dir, nodeId, tab.id)}
                    onClose={nodeId => closePanel(tab.id, nodeId)}
                    onContainerResize={(nodeId, sizes) => {
                      // 컨테이너 노드의 sizes 를 트리에 저장 — 워크스페이스 전환 후 복원
                      updateLayout(tab.id, root => {
                        const walk = (node: any): any => {
                          if (node.id === nodeId && (node.type === 'row' || node.type === 'column')) {
                            return { ...node, sizes: [...sizes] };
                          }
                          if (node.type !== 'leaf' && node.children) {
                            return { ...node, children: node.children.map(walk) };
                          }
                          return node;
                        };
                        return walk(root);
                      });
                    }}
                    floatingPanelId={floatingPanelId}
                    fullscreenTermId={fullscreenTermId}
                    workspaceList={tabs.filter(t => !t.type || t.type === 'terminal').map(t => ({ id: t.id, title: t.title }))}
                    currentWorkspaceId={tab.id}
                    onMoveSessionToWorkspace={(fromNodeId, termId, targetTabId) => handleMoveSessionToWorkspace(fromNodeId, termId, targetTabId, tab.id)}
                    onToggleFloat={nodeId => {
                      setFloatingPanelId(prev => prev === nodeId ? null : nodeId);
                      setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, 120);
                    }}
                    onSelectPanel={id => setPanelId(id)}
                    onMovePanel={(fromPanelId, toPanelId, position) => movePanel(fromPanelId, toPanelId, position, tab.id)}
                    onSwitchSession={(nodeId, idx) => handleSwitchSession(nodeId, idx, tab.id)}
                    onCloseSession={(nodeId, termId) => handleCloseSession(nodeId, termId, tab.id)}
                    onDetachSession={detachSessionToNewWindow}
                    onDuplicateSessionToNewWindow={duplicateSessionToNewWindow}
                    onSetSessionColor={(nodeId, termId, color) => {
                      updateLayout(tab.id, layout => {
                        const walk = (n: LayoutNode): LayoutNode => {
                          if (n.type === 'leaf') {
                            if (n.id !== nodeId) return n;
                            return { ...n, panel: { ...n.panel, sessions: n.panel.sessions.map(s => s.termId === termId ? { ...s, color } : s) } };
                          }
                          return { ...n, children: n.children.map(walk) };
                        };
                        return walk(layout);
                      });
                    }}
                    onMoveSession={(fromNodeId, termId, toNodeId) => handleMoveSession(fromNodeId, termId, toNodeId, tab.id)}
                    onSplitMoveSession={(fromNodeId, termId, toNodeId, zone) => handleSplitMoveSession(fromNodeId, termId, toNodeId, zone, tab.id)}
                    onReorderSession={(nodeId, fromIdx, toIdx) => handleReorderSession(nodeId, fromIdx, toIdx, tab.id)}
                    onAddSession={(nodeId, shellName, shellPath) => handleAddSession(nodeId, shellName, shellPath, tab.id)}
                    onRenameSession={(nodeId, termId, name) => handleRenameSession(nodeId, termId, name, tab.id)}
                    onConnectDrop={(nodeId, sessionId) => handleConnectDrop(nodeId, sessionId, tab.id)}
                    onDuplicateSession={(nodeId, termId) => handleDuplicateSession(nodeId, termId, tab.id)}
                    availableShells={availableShells}
                    treeWidth={remoteTreeWidth}
                    onTreeWidthChange={w => {
                      setRemoteTreeWidth(w);
                      if (remoteTreeWidthLoadedRef.current) { try { (window as any).api?.setUIPrefs?.({ remoteTreeWidth: w }); } catch {} }
                    }}
                    onOpenRemoteFile={handleOpenRemoteFile}
                    onAttachToClaude={handleAttachToClaude}
                  />}
                </div>
              </div>
              </div>
            </div>
          );
          }; // end renderTerminalTab
          const isTerm = (t: Tab | null | undefined) => !!t && (t.type === undefined || t.type === 'terminal');
          const setPanelForTab = (tabId: string) => (id: string) => {
            setSelectedPanelByTab(prev => ({ ...prev, [tabId]: id }));
          };
          const nodes: React.ReactNode[] = [];
          if (isTerm(activeTab)) {
            // 키에 '-left' 를 포함 — 같은 탭이 splitRightSlot(-right) 이었다가 좌측 primary 슬롯으로
            // 전환되면(예: 우측에 분할되어 있던 탭이 유일하게 남는 경우) 강제로 remount 시켜서
            // xterm DOM 이 새 컨테이너에 제대로 재부착되게 함 (안 그러면 입력이 먹통이 되는 문제).
            nodes.push(
              <div key={activeTab!.id + '-slot-left'} style={tabSlotStyle(activeTab!)}>
                {renderTerminalTab(activeTab!, selectedPanelId, setSelectedPanelId)}
              </div>
            );
          }
          if (splitRightTab && isTerm(splitRightTab) && canSplit(activeTab)) {
            nodes.push(
              <div key={splitRightTab.id + '-slot-right'} style={tabSlotStyle(splitRightTab)}>
                {renderTerminalTab(splitRightTab, selectedPanelByTab[splitRightTab.id] ?? null, setPanelForTab(splitRightTab.id), { splitRightSlot: true })}
              </div>
            );
          }
          return <>{nodes}</>;
        })()}
        {/* 분할 divider — 우측 분할 활성 시 activeTab 과 splitRightTab 사이에 배치 (flex order 로 위치 강제). */}
        {splitRightTab && canSplit(activeTab) && (
          <div
            style={{ flex: '0 0 4px', order: 1, background: '#333', cursor: 'col-resize', zIndex: 5 }}
            onMouseEnter={e => (e.currentTarget.style.background = '#0e639c')}
            onMouseLeave={e => (e.currentTarget.style.background = '#333')}
            onMouseDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const wrap = (e.currentTarget.parentElement as HTMLElement | null);
              const wrapRect = wrap?.getBoundingClientRect();
              const w = wrapRect?.width || 800;
              const startRatio = splitRatio;
              // <webview> 는 별도 렌더러 프로세스라 그 위로 마우스가 지나가면 mousemove/mouseup 이
              // 이 창의 window 로 전달되지 않아 드래그가 끊기거나 "눌린 채로 고정"되는 문제가 있음 —
              // 드래그 중엔 전체 화면을 덮는 투명 오버레이로 모든 마우스 이벤트를 여기서 가로챔.
              const overlay = document.createElement('div');
              overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;cursor:col-resize;';
              document.body.appendChild(overlay);
              // 실시간 미리보기 — 양쪽 슬롯의 flex 를 직접 DOM 으로 조작(React state 는 매 프레임
              // 갱신하지 않아 리렌더 비용 없음). wrap 안엔 숨겨진(display:none) 다른 탭들도 있고
              // 그것들은 order 기본값이 0이라 order 만으로는 혼동될 수 있어 display:none 이 아닌
              // 것만 대상으로 order(0=좌, 2=우) 로 식별.
              const kids = wrap
                ? (Array.from(wrap.children) as HTMLElement[]).filter(k => getComputedStyle(k).display !== 'none')
                : [];
              const leftEl = kids.find(k => getComputedStyle(k).order === '0');
              const rightEl = kids.find(k => getComputedStyle(k).order === '2');
              let latest = startRatio;
              let raf = 0;
              const onMove = (ev: MouseEvent) => {
                const dx = ev.clientX - startX;
                latest = Math.max(0.2, Math.min(0.8, startRatio + dx / w));
                if (raf) return;
                raf = requestAnimationFrame(() => {
                  raf = 0;
                  if (leftEl) leftEl.style.flex = `${latest * 100} 1 0`;
                  if (rightEl) rightEl.style.flex = `${(1 - latest) * 100} 1 0`;
                });
              };
              const onUp = () => {
                overlay.removeEventListener('mousemove', onMove);
                overlay.removeEventListener('mouseup', onUp);
                overlay.removeEventListener('mouseleave', onUp);
                overlay.remove();
                if (raf) cancelAnimationFrame(raf);
                setSplitRatio(latest);
                window.dispatchEvent(new Event('resize'));
                refitAllTerms();
              };
              overlay.addEventListener('mousemove', onMove);
              overlay.addEventListener('mouseup', onUp);
              overlay.addEventListener('mouseleave', onUp);
            }}
            title="드래그로 좌우 비율 조절"
          />
        )}
        </div>{/* /workspace-row */}
        </div>
      </div>

      {showBroadcast && (
        <div className="broadcast-bar">
          <button className="broadcast-close" onClick={() => setShowBroadcast(false)} title={tApp('broadcast.close')}>✕</button>
          <span className="broadcast-label" title={tApp('broadcast.labelTooltip')}>📢</span>
          <select
            className="broadcast-scope"
            value={broadcastScope}
            onChange={e => setBroadcastScope(e.target.value as any)}
            title={tApp('broadcast.scopeTooltip')}
          >
            <option value="visible">{tApp('broadcast.scopeVisible', { count: collectBroadcastTargets('visible').length })}</option>
            <option value="current">{tApp('broadcast.scopeCurrent', { count: collectBroadcastTargets('current').length })}</option>
            <option value="connected">{tApp('broadcast.scopeConnected', { count: collectBroadcastTargets('connected').length })}</option>
          </select>
          <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
            <input
              className="broadcast-input"
              autoFocus
              value={broadcastText}
              onChange={e => { setBroadcastText(e.target.value); setBroadcastShowHistory(false); }}
              onBlur={() => setTimeout(() => setBroadcastShowHistory(false), 150)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  // Esc 는 히스토리 드롭다운만 닫고 바 자체는 유지 — 닫기는 ✕ 버튼으로만
                  if (broadcastShowHistory) { e.preventDefault(); setBroadcastShowHistory(false); }
                  return;
                }
                if (e.key === 'ArrowDown' && !broadcastShowHistory) {
                  if (broadcastHistory.length > 0) { e.preventDefault(); setBroadcastShowHistory(true); setBroadcastHistoryIdx(0); setBroadcastText(broadcastHistory[0]); }
                  return;
                }
                if (e.key === 'ArrowDown' && broadcastShowHistory) {
                  e.preventDefault();
                  const next = Math.min(broadcastHistoryIdx + 1, broadcastHistory.length - 1);
                  setBroadcastHistoryIdx(next); setBroadcastText(broadcastHistory[next]);
                  return;
                }
                if (e.key === 'ArrowUp' && broadcastShowHistory) {
                  e.preventDefault();
                  const prev = Math.max(broadcastHistoryIdx - 1, 0);
                  setBroadcastHistoryIdx(prev); setBroadcastText(broadcastHistory[prev]);
                  return;
                }
                if (e.key === 'Enter') { e.preventDefault(); setBroadcastShowHistory(false); sendBroadcast(broadcastScope, undefined, { keepFocusOnInput: true }); return; }
                if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
                  if (e.key === 'c' || e.key === 'C') {
                    const inp = e.currentTarget as HTMLInputElement;
                    if (inp.selectionStart !== inp.selectionEnd) return;
                    e.preventDefault();
                    sendBroadcast(broadcastScope, { raw: '\x03', label: '^C' }, { keepFocusOnInput: true });
                  } else if (e.key === 'd' || e.key === 'D') {
                    e.preventDefault();
                    sendBroadcast(broadcastScope, { raw: '\x04', label: '^D' }, { keepFocusOnInput: true });
                  }
                }
              }}
              placeholder={tApp('broadcast.inputPlaceholder')}
              style={{ flex: 1, borderRadius: '4px 0 0 4px' }}
            />
            <button
              className="broadcast-history-toggle"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { setBroadcastShowHistory(v => !v); setBroadcastHistoryIdx(-1); }}
              title={tApp('broadcast.historyTooltip')}
            >▾</button>
            {broadcastShowHistory && broadcastHistory.length > 0 && (
              <div className="broadcast-history-dropdown">
                {broadcastHistory.map((h, i) => (
                  <div key={`${h}-${i}`}
                    className={`broadcast-history-item ${i === broadcastHistoryIdx ? 'active' : ''}`}
                    onMouseDown={e => { e.preventDefault(); setBroadcastText(h); setBroadcastShowHistory(false); }}
                  >{h}</div>
                ))}
              </div>
            )}
          </div>
          <label className="broadcast-chk" title={tApp('broadcast.appendNewlineTooltip')}>
            <input type="checkbox" checked={broadcastAppendNewline} onChange={e => setBroadcastAppendNewline(e.target.checked)} />
            <span>↵</span>
          </label>
          <button className="broadcast-btn" onClick={() => sendBroadcast(broadcastScope)} title={tApp('broadcast.sendTooltip')}>{tApp('broadcast.send')}</button>
          <button className="broadcast-btn" onClick={() => { setBcastXferFiles([]); setBcastXferPath(''); setBcastXferLog([]); setShowBcastFileXfer(true); }} title={tApp('broadcast.fileTransferTooltip')}>{tApp('broadcast.fileTransfer')}</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x1b[A', label: '↑' })} title={tApp('broadcast.arrowUpTooltip')}>↑</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x1b[B', label: '↓' })} title={tApp('broadcast.arrowDownTooltip')}>↓</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x03', label: '^C' })} title={tApp('broadcast.sigintTooltip')}>^C</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x04', label: '^D' })} title={tApp('broadcast.eofTooltip')}>^D</button>
          {/* 빠른 명령 — 드롭다운 하나로 모아 보관. 클릭 시 broadcastScope 대로 전송. */}
          <span style={{ width: 1, height: 18, background: '#333', margin: '0 2px' }} />
          <div style={{ position: 'relative' }}>
            <button className="broadcast-btn"
              onClick={() => setQuickCmdMenuOpen(v => !v)}
              title={quickCmds.length > 0 ? `빠른 명령 (${quickCmds.length}개)` : '빠른 명령 추가·관리'}
              style={{ background: '#2a4a6a', color: '#e0eaf5' }}>
              🚀 빠른 명령 {quickCmds.length > 0 ? `(${quickCmds.length})` : ''} ▾
            </button>
            {quickCmdMenuOpen && (
              <>
                <div onClick={() => setQuickCmdMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9990 }} />
                <div style={{
                  position: 'absolute', bottom: '100%', right: 0, marginBottom: 4,
                  background: '#252526', border: '1px solid #444', borderRadius: 4,
                  minWidth: 280, maxHeight: 400, overflowY: 'auto',
                  boxShadow: '0 -4px 20px rgba(0,0,0,0.5)', zIndex: 9991,
                }}>
                  {quickCmds.length === 0 && (
                    <div style={{ padding: '10px 12px', color: '#888', fontSize: 11 }}>
                      아직 빠른 명령이 없습니다. 아래 "+ 새 명령 추가" 로 만들어 보세요.
                    </div>
                  )}
                  {quickCmds.map(qc => (
                    <div key={qc.id}
                      onClick={() => {
                        sendBroadcast(broadcastScope, { raw: (qc.cmd.endsWith('\n') ? qc.cmd : qc.cmd + '\n'), label: qc.label });
                        setQuickCmdMenuOpen(false);
                      }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid #333' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#2d2d2d')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: '#9cdcfe', fontWeight: 600 }}>{qc.label}</div>
                        <div style={{ fontSize: 10, color: '#888', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{qc.cmd}</div>
                      </div>
                      <button onClick={e => { e.stopPropagation(); setQuickCmdMenuOpen(false); setQuickCmdEditor(qc); }}
                        title="편집"
                        style={{ background: 'transparent', border: '1px solid #444', color: '#9cdcfe', cursor: 'pointer', padding: '2px 6px', borderRadius: 3, fontSize: 10 }}>✎</button>
                    </div>
                  ))}
                  <div onClick={() => { setQuickCmdMenuOpen(false); setQuickCmdEditor({ id: '', label: '', cmd: '' }); }}
                    style={{ padding: '8px 10px', cursor: 'pointer', color: '#3fb950', fontSize: 12, fontWeight: 600, textAlign: 'center' }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#2d2d2d')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    + 새 명령 추가
                  </div>
                </div>
              </>
            )}
          </div>
          {broadcastNotice && (
            <span className={`broadcast-notice ${broadcastNotice.kind}`}>{broadcastNotice.text}</span>
          )}
        </div>
      )}
      {/* 빠른 명령 편집 모달 */}
      {quickCmdEditor && (
        <div onClick={() => setQuickCmdEditor(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#252526', border: '1px solid #444', borderRadius: 6, padding: 20, minWidth: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}>
            <h3 style={{ margin: '0 0 12px', color: '#e0e0e0', fontSize: 14 }}>{quickCmdEditor.id ? '빠른 명령 편집' : '빠른 명령 추가'}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={{ fontSize: 11, color: '#aaa' }}>
                라벨 (버튼 표시)
                <input value={quickCmdEditor.label}
                  onChange={e => setQuickCmdEditor(q => q ? { ...q, label: e.target.value } : q)}
                  autoFocus maxLength={30}
                  style={{ width: '100%', marginTop: 4, padding: '4px 8px', background: '#1e1e1e', color: '#eee', border: '1px solid #444', borderRadius: 3, fontSize: 12 }} />
              </label>
              <label style={{ fontSize: 11, color: '#aaa' }}>
                명령
                <textarea value={quickCmdEditor.cmd}
                  onChange={e => setQuickCmdEditor(q => q ? { ...q, cmd: e.target.value } : q)}
                  rows={3}
                  style={{ width: '100%', marginTop: 4, padding: '4px 8px', background: '#1e1e1e', color: '#eee', border: '1px solid #444', borderRadius: 3, fontSize: 12, fontFamily: 'monospace', resize: 'vertical' }} />
                <span style={{ fontSize: 10, color: '#666' }}>※ 자동으로 개행 추가됨. 여러 줄 스크립트 가능.</span>
              </label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              {quickCmdEditor.id && (
                <button onClick={() => { setQuickCmds(prev => prev.filter(q => q.id !== quickCmdEditor.id)); setQuickCmdEditor(null); }}
                  style={{ background: '#7a3a3a', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12, marginRight: 'auto' }}>삭제</button>
              )}
              <button onClick={() => setQuickCmdEditor(null)}
                style={{ background: '#444', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}>취소</button>
              <button onClick={() => {
                if (!quickCmdEditor.label.trim() || !quickCmdEditor.cmd) return;
                if (quickCmdEditor.id) {
                  setQuickCmds(prev => prev.map(q => q.id === quickCmdEditor.id ? quickCmdEditor : q));
                } else {
                  setQuickCmds(prev => [...prev, { ...quickCmdEditor, id: `qc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }]);
                }
                setQuickCmdEditor(null);
              }}
                disabled={!quickCmdEditor.label.trim() || !quickCmdEditor.cmd}
                style={{ background: '#0e639c', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}>저장</button>
            </div>
          </div>
        </div>
      )}

      <StatusBar
        activeTab={activeTab}
        selectedPanelId={selectedPanelId}
        tabs={tabs}
        messenger={{
          visible: true,
          hidden: messengerHidden,
          unreadCount: messengerUnreadCount,
          onClick: () => openClaudeChatView('messenger'),
        }}
        windowTheme={{
          current: windowTheme,
          list: getWindowThemeList(),
          onChange: handleWindowThemeChange,
          label: tMenu('view.windowTheme'),
        }}
      />

      {editSessionCtx && (
        <SessionEditor
          session={editSessionCtx.session}
          folders={editSessionFolders}
          onSave={async (s: any) => {
            if (editSessionCtx.isQuick) {
              try { await (window as any).api?.saveSession?.(s); } catch {}
              applySavedSessionToTerm(s, editSessionCtx.termId);
              setEditSessionCtx({ session: s, termId: editSessionCtx.termId });
              try { window.dispatchEvent(new Event('sessions-reload')); } catch {}
              return;
            }
            // 변경 전 세션 — X11 forwarding 등 재접속 필요 설정 비교
            const prev = editSessionCtx.session as any;
            try { await (window as any).api?.saveSession?.(s); } catch {}
            // 활성 터미널에 실시간 반영
            applySessionToTerm(s, editSessionCtx.termId);
            // 편집 컨텍스트 갱신 (창 유지)
            setEditSessionCtx({ session: s, termId: editSessionCtx.termId });
            // X11 forwarding 변경 시 안내 (수동 재접속 권유)
            const x11Changed = !!prev && (!!prev.x11Forward !== !!s.x11Forward || (prev.x11Display ?? 0) !== (s.x11Display ?? 0));
            if (x11Changed) {
              try {
                window.dispatchEvent(new CustomEvent('session-setting-changed', {
                  detail: { sessionId: s.id, fields: ['x11Forward', 'x11Display'], requiresReconnect: true },
                }));
              } catch {}
            }
          }}
          onSaveAndConnect={async (s: any) => {
            if (editSessionCtx.isQuick) {
              const editedTid = editSessionCtx.termId;
              try { await (window as any).api?.saveSession?.(s); } catch {}
              applySavedSessionToTerm(s, editedTid);
              try { window.dispatchEvent(new Event('sessions-reload')); } catch {}
              setEditSessionCtx(null);
              setTimeout(async () => {
                try {
                  window.api?.disconnectSSH?.(editedTid);
                  await new Promise(res => setTimeout(res, 250));
                  resetTermConnectState(editedTid);
                  const entry = termStore.get(editedTid);
                  const cols = entry ? (entry.term as any).cols : 80;
                  const rows = entry ? (entry.term as any).rows : 24;
                  await (window as any).api?.connectSSH?.(editedTid, s.id, cols, rows);
                  focusTerm(editedTid);
                } catch {}
              }, 50);
              return;
            }
            try { await (window as any).api?.saveSession?.(s); } catch {}
            const editedTid = editSessionCtx.termId;
            setEditSessionCtx(null);
            // 새 탭으로 연결 (panelId=null → 새 패널/탭 생성)
            setTimeout(() => {
              try { handleConnectSession(s.id, s.name, null, s.theme, s.fontFamily, s.fontSize, s.scrollback); } catch (e) { console.error('[editor saveAndConnect]', e); }
              if (editedTid) focusTerm(editedTid);
            }, 50);
          }}
          onCancel={() => {
            const editedTid = editSessionCtx.termId;
            setEditSessionCtx(null);
            if (editedTid) setTimeout(() => focusTerm(editedTid), 0);
          }}
        />
      )}
      {showOptions && (() => {
        const onDragStart = (e: React.MouseEvent) => {
          if ((e.target as HTMLElement).closest('button, input, select, textarea, label, .options-tab')) return;
          e.preventDefault();
          const modal = e.currentTarget.parentElement as HTMLElement;
          const rect = modal.getBoundingClientRect();
          const offX = e.clientX - rect.left;
          const offY = e.clientY - rect.top;
          modal.style.position = 'fixed';
          modal.style.left = rect.left + 'px';
          modal.style.top = rect.top + 'px';
          modal.style.transform = 'none';
          modal.style.margin = '0';
          const onMove = (ev: MouseEvent) => {
            modal.style.left = Math.max(0, Math.min(window.innerWidth - rect.width, ev.clientX - offX)) + 'px';
            modal.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offY)) + 'px';
          };
          const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        };
        return (
        <div className="session-editor-backdrop">
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 640 }}>
            <h3 style={isOptionsPopout ? { userSelect: 'none' } : { cursor: 'move', userSelect: 'none' }} onMouseDown={isOptionsPopout ? undefined : onDragStart} title={isOptionsPopout ? '' : tOpt('dragToMove')}>{tOpt('title')}</h3>

            <div className="options-body">
              <div className="options-tabs options-tabs-side">
                <button className={`options-tab ${optionsTab === 'terminal' ? 'active' : ''}`} onClick={() => setOptionsTab('terminal')}>{tOpt('tabs.terminal')}</button>
                <button className={`options-tab ${optionsTab === 'session' ? 'active' : ''}`} onClick={() => setOptionsTab('session')}>{tOpt('tabs.session')}</button>
                <button className={`options-tab ${optionsTab === 'keybindings' ? 'active' : ''}`} onClick={() => setOptionsTab('keybindings')}>{tOpt('tabs.keybindings')}</button>
                <button className={`options-tab ${optionsTab === 'messenger' ? 'active' : ''}`} onClick={() => setOptionsTab('messenger')}>{tOpt('messenger.tab')}</button>
              </div>
              <div className="options-pane">

            {optionsTab === 'terminal' && (
              <div className="options-content">
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{tOpt('clipboard.heading')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label className="settings-checkbox">
                      <input type="checkbox" checked={termSettings.autoCopyOnSelect}
                        onChange={e => setTermSettings(s => ({ ...s, autoCopyOnSelect: e.target.checked }))} />
                      <span>{tOpt('clipboard.autoCopyOnSelect')}</span>
                    </label>
                    <label className="settings-checkbox">
                      <input type="checkbox" checked={termSettings.includeTrailingNewline}
                        onChange={e => setTermSettings(s => ({ ...s, includeTrailingNewline: e.target.checked }))} />
                      <span>{tOpt('clipboard.includeTrailingNewline')}</span>
                    </label>
                    <label className="settings-checkbox">
                      <input type="checkbox" checked={termSettings.trimTrailingWhitespace}
                        onChange={e => setTermSettings(s => ({ ...s, trimTrailingWhitespace: e.target.checked }))} />
                      <span>{tOpt('clipboard.trimTrailingWhitespace')}</span>
                    </label>
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{tOpt('paste.heading')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ color: '#aaa', fontSize: 12, marginBottom: 2 }}>{tOpt('paste.multiLineNote')}</div>
                    <label className="settings-radio">
                      <input type="radio" name="multiLinePaste" checked={termSettings.multiLinePaste === 'dialog'}
                        onChange={() => setTermSettings(s => ({ ...s, multiLinePaste: 'dialog' }))} />
                      <span>{tOpt('paste.dialog')}</span>
                    </label>
                    <label className="settings-radio">
                      <input type="radio" name="multiLinePaste" checked={termSettings.multiLinePaste === 'direct'}
                        onChange={() => setTermSettings(s => ({ ...s, multiLinePaste: 'direct' }))} />
                      <span>{tOpt('paste.direct')}</span>
                    </label>
                    {termSettings.multiLinePaste === 'dialog' && (
                      <label className="settings-radio" style={{ marginTop: 4, opacity: 0.95 }} title={tOpt('paste.accumulateTooltip')}>
                        <input type="checkbox" checked={!!termSettings.multiLinePasteAccumulate}
                          onChange={e => setTermSettings(s => ({ ...s, multiLinePasteAccumulate: e.target.checked }))} />
                        <span>{tOpt('paste.accumulate')}</span>
                      </label>
                    )}
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{tOpt('mouse.heading')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 110, color: '#bbb', fontSize: 13 }}>{tOpt('mouse.rightButton')}</span>
                      <select
                        style={{ flex: 1, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '6px', fontSize: 13, cursor: 'pointer' }}
                        value={termSettings.rightClickAction}
                        onChange={e => setTermSettings(s => ({ ...s, rightClickAction: e.target.value as TerminalSettings['rightClickAction'] }))}
                      >
                        <option value="none">{tOpt('mouse.none')}</option>
                        <option value="menu">{tOpt('mouse.menu')}</option>
                        <option value="paste">{tOpt('mouse.paste')}</option>
                        <option value="properties">{tOpt('mouse.properties')}</option>
                        <option value="enter">{tOpt('mouse.enter')}</option>
                        <option value="paste-selection">{tOpt('mouse.pasteSelection')}</option>
                      </select>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 110, color: '#bbb', fontSize: 13 }}>{tOpt('mouse.middleButton')}</span>
                      <select
                        style={{ flex: 1, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '6px', fontSize: 13, cursor: 'pointer' }}
                        value={termSettings.middleClickAction}
                        onChange={e => setTermSettings(s => ({ ...s, middleClickAction: e.target.value as TerminalSettings['middleClickAction'] }))}
                      >
                        <option value="none">{tOpt('mouse.none')}</option>
                        <option value="menu">{tOpt('mouse.menu')}</option>
                        <option value="paste">{tOpt('mouse.paste')}</option>
                        <option value="properties">{tOpt('mouse.properties')}</option>
                        <option value="enter">{tOpt('mouse.enter')}</option>
                        <option value="paste-selection">{tOpt('mouse.pasteSelection')}</option>
                      </select>
                    </label>
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{tOpt('font.heading')}</div>
                  <select
                    style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, boxSizing: 'border-box', cursor: 'pointer' }}
                    value={optFontFamily}
                    onChange={e => setOptFontFamily(e.target.value)}
                  >
                    <option value="">{tOpt('font.defaultLabel')}</option>
                    {availableFonts.map(f => <option key={f} value={f} style={{ fontFamily: `"${f}", monospace` }}>{f}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{tOpt('font.size')}</div>
                  <input
                    type="number"
                    min={8}
                    max={40}
                    step={1}
                    style={{ width: 100, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
                    value={optFontSize}
                    onChange={e => setOptFontSize(Math.max(8, Math.min(40, Number(e.target.value) || 14)))}
                  />
                </div>
                <div style={{ marginBottom: 16, borderTop: '1px solid #333', paddingTop: 12 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{tOpt('font.claudeHeading')}</div>
                  <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px' }}>{tOpt('font.claudeHint')}</p>
                  <select
                    style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, boxSizing: 'border-box', cursor: 'pointer' }}
                    value={claudeFontFamily}
                    onChange={e => { setClaudeFontFamily(e.target.value); setClaudeFontFamilyState(e.target.value); }}
                  >
                    <option value="">{tOpt('font.claudeDefaultLabel')}</option>
                    {availableFonts.map(f => <option key={f} value={f} style={{ fontFamily: `"${f}", sans-serif` }}>{f}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{tOpt('font.claudeSize')}</div>
                  <input
                    type="number"
                    min={9}
                    max={32}
                    step={1}
                    style={{ width: 100, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
                    value={claudeFontSize}
                    onChange={e => {
                      const v = Math.max(9, Math.min(32, Number(e.target.value) || 13));
                      setClaudeFontSize(v);
                      setClaudeFontSizeState(v);
                    }}
                  />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{tOpt('scrollback.heading')}</div>
                  <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px' }}>{tOpt('scrollback.hint')}</p>
                  <input
                    type="number"
                    min={1000}
                    max={1000000}
                    step={1000}
                    style={{ width: 160, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
                    value={termSettings.scrollback}
                    onChange={e => {
                      const v = Math.max(1000, Math.min(1000000, Number(e.target.value) || 0));
                      setTermSettings(s => ({ ...s, scrollback: v }));
                    }}
                  />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{tOpt('defaultShell.heading')}</div>
                  <select
                    style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, boxSizing: 'border-box', cursor: 'pointer' }}
                    value={optDefaultShellPath}
                    onChange={e => setOptDefaultShellPath(e.target.value)}
                  >
                    {availableShells.map(sh => <option key={sh.path} value={sh.path}>{sh.icon ? sh.icon + ' ' : ''}{sh.name}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{tOpt('wordSeparator.heading')}</div>
                  <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px' }}>{tOpt('wordSeparator.hint')}</p>
                  <input
                    style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
                    value={wordSepValue}
                    onChange={e => setWordSepValue(e.target.value)}
                  />
                </div>
              </div>
            )}

            {optionsTab === 'session' && (
              <div className="options-content">
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{tOpt('sessionsPath.heading')}</div>
                  <div style={{ background: '#111', border: '1px solid #333', borderRadius: 4, padding: '8px 10px', fontSize: 12, fontFamily: 'monospace', color: '#aaa', wordBreak: 'break-all', marginBottom: 8 }}>
                    {sessionsPathDisplay || tOpt('sessionsPath.unknown')}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn-add" onClick={() => (window as any).api.openSessionsFolder()}>{tOpt('sessionsPath.open')}</button>
                    <button className="btn-add" onClick={async () => {
                      const r = await (window as any).api.setSessionsPath();
                      if (r) { setSessionsPathDisplay(r.path); window.dispatchEvent(new Event('sessions-reload')); }
                    }}>{tOpt('sessionsPath.change')}</button>
                    <button className="btn-add" onClick={async () => {
                      const r = await (window as any).api.resetSessionsPath();
                      if (r) { setSessionsPathDisplay(r.path); window.dispatchEvent(new Event('sessions-reload')); }
                    }}>{tOpt('sessionsPath.reset')}</button>
                    <button className="btn-add" onClick={() => (window as any).api.openSessionsEditor()}>{tOpt('sessionsPath.editFile')}</button>
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{tOpt('contextMenu.heading')}</div>
                  <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px' }}>{tOpt('contextMenu.hint')}</p>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-add" onClick={async () => {
                      const r = await (window as any).api?.registerContextMenu?.();
                      if (r?.success) { setContextMenuRegistered(true); }
                    }}>{tOpt('contextMenu.register')}</button>
                    <button className="btn-add" onClick={async () => {
                      const r = await (window as any).api?.unregisterContextMenu?.();
                      if (r?.success) { setContextMenuRegistered(false); }
                    }}>{tOpt('contextMenu.unregister')}</button>
                    <span style={{ color: contextMenuRegistered ? '#4caf50' : '#888', fontSize: 12, alignSelf: 'center' }}>
                      {contextMenuRegistered ? tOpt('contextMenu.registered') : tOpt('contextMenu.notRegistered')}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {optionsTab === 'messenger' && (
              <div className="options-content">
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{tOpt('messenger.heading')}</div>
                  <p style={{ color: '#888', fontSize: 12, margin: '0 0 12px' }}>
                    {tOpt('messenger.desc')}
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-cancel" onClick={async () => {
                      if (!confirm(tOpt('messenger.confirmDeleteConversations'))) return;
                      await (window as any).api?.messengerClearAll?.();
                    }}>{tOpt('messenger.deleteConversations')}</button>
                    <button className="btn-cancel" onClick={async () => {
                      if (!confirm(tOpt('messenger.confirmDeleteUsers'))) return;
                      await (window as any).api?.messengerClearPeers?.();
                    }}>{tOpt('messenger.deleteUsers')}</button>
                  </div>
                </div>
              </div>
            )}

            {optionsTab === 'keybindings' && (
              <div className="options-content">
                <div className="keybinding-list">
                  {Object.keys(DEFAULT_KEYBINDINGS).map(actionId => {
                    const draftCombo = keybindingsDraft[actionId] || DEFAULT_KEYBINDINGS[actionId];
                    const isListening = listeningAction === actionId;
                    return (
                      <div className="keybinding-row" key={actionId}>
                        <span className="keybinding-label">{tKb(`labels.${actionId}`, { defaultValue: KEYBINDING_LABELS[actionId] || actionId })}</span>
                        <input
                          className={`keybinding-combo ${isListening ? 'listening' : ''}`}
                          readOnly
                          value={isListening ? tOpt('keybindings.pressKey') : draftCombo}
                        />
                        <button className="keybinding-btn" onClick={() => setListeningAction(isListening ? null : actionId)}>
                          {isListening ? tOpt('keybindings.cancel') : tOpt('keybindings.change')}
                        </button>
                      </div>
                    );
                  })}
                </div>
                {keybindingWarning && (
                  <div className="keybinding-warning">⚠ {keybindingWarning}</div>
                )}
                <div className="keybinding-reset">
                  <button className="keybinding-btn" onClick={() => {
                    setKeybindingsDraft({});
                    setListeningAction(null);
                    setKeybindingWarning(null);
                  }}>{tOpt('keybindings.reset')}</button>
                </div>
              </div>
            )}
              </div>
            </div>

            <div className="session-editor-actions">
              <button className="btn-cancel" onClick={() => {
                if (isOptionsPopout) { try { (window as any).api?.optionsClose?.(); } catch {} return; }
                setShowOptions(false); setListeningAction(null);
              }}>{tOpt('actions.cancel')}</button>
              <button className="btn-save" onClick={() => {
                saveTerminalSettings(termSettings);
                setWordSeparator(wordSepValue);
                applyScrollbackToAll(termSettings.scrollback);
                applyFontToAll(optFontFamily || undefined, optFontSize);
                // 기본 쉘 저장
                const selShell = availableShells.find(s => s.path === optDefaultShellPath);
                if (selShell) {
                  setDefaultShell({ name: selShell.name, path: selShell.path });
                  (window as any).api?.setUIPrefs?.({ defaultShellName: selShell.name, defaultShellPath: selShell.path });
                }
                // 단축키 저장 — draft를 실제로 반영
                setKeybindingsState(keybindingsDraft);
                loadKeybindings(keybindingsDraft);
                (window as any).api?.setUIPrefs?.({ keybindings: keybindingsDraft });
                setListeningAction(null);
                setShowOptions(false);
                if (isOptionsPopout) {
                  // localStorage 의 디스크 flush 시간 확보 후 창 닫기 (즉시 닫으면 변경사항 유실 가능)
                  setTimeout(() => { try { (window as any).api?.optionsSaved?.(); } catch {} }, 250);
                }
              }}>{tOpt('actions.save')}</button>
            </div>
          </div>
        </div>
        );
      })()}
      {showRemoteShare && <RemoteShareDialog onClose={() => setShowRemoteShare(false)} />}

      {/* 하단 상태바 SFTP 진행률 — 파일전송 탭의 TransferLog 로 대체됨 */}
      <ConflictDialogQueue />
      <NotifyHost />
      {showClaudeChat && (() => {
        // 모든 연결된 SSH 세션 수집 (panel.sessions 내의 termId 들)
        const connectedSessions: { termId: string; label: string }[] = [];
        const seen = new Set<string>();
        const walk = (n: any) => {
          if (n.type === 'leaf') {
            const sessions = n.panel?.sessions || [];
            for (const s of sessions) {
              if (s.termId && !seen.has(s.termId) && isTermConnected(s.termId)) {
                const info = getTermSessionInfo(s.termId);
                const label = info?.sessionName || s.sessionName || info?.host || s.termId;
                connectedSessions.push({ termId: s.termId, label });
                seen.add(s.termId);
              }
            }
          } else if (n.children) {
            for (const c of n.children) walk(c);
          }
        };
        for (const t of tabs) walk(t.layout);

        // 현재 선택된 패널의 activeTermId 가 연결된 SSH 세션이면 기본 우선
        let defaultSsh: { termId: string; label: string } | null = connectedSessions[0] || null;
        if (selectedPanelId && activeTab) {
          const findLeaf = (n: any, id: string): any => {
            if (n.type === 'leaf') return n.id === id ? n : null;
            for (const c of n.children) { const r = findLeaf(c, id); if (r) return r; }
            return null;
          };
          const leaf = findLeaf(activeTab.layout, selectedPanelId);
          if (leaf && leaf.panel) {
            const activeTerm = leaf.panel.activeTermId || leaf.panel.sessions?.[0]?.termId;
            if (activeTerm && isTermConnected(activeTerm)) {
              const info = getTermSessionInfo(activeTerm);
              const s = leaf.panel.sessions.find((x: any) => x.termId === activeTerm);
              defaultSsh = { termId: activeTerm, label: info?.sessionName || s?.sessionName || info?.host || activeTerm };
            }
          }
        }

        const onEnterTriggerHover = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) { clearTimeout(claudeChatHideTimer.current); claudeChatHideTimer.current = null; }
          if (claudeChatHoverShowTimer.current) clearTimeout(claudeChatHoverShowTimer.current);
          claudeChatHoverShowTimer.current = setTimeout(() => setClaudeChatVisible(true), 2500);
        };
        const onLeaveTriggerHover = () => {
          if (claudeChatHoverShowTimer.current) { clearTimeout(claudeChatHoverShowTimer.current); claudeChatHoverShowTimer.current = null; }
        };
        const onEnterSidebar = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) { clearTimeout(claudeChatHideTimer.current); claudeChatHideTimer.current = null; }
        };
        const onLeaveSidebar = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) clearTimeout(claudeChatHideTimer.current);
          claudeChatHideTimer.current = setTimeout(() => setClaudeChatVisible(false), 500);
        };
        const onClickTrigger = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) { clearTimeout(claudeChatHideTimer.current); claudeChatHideTimer.current = null; }
          if (claudeChatHoverShowTimer.current) { clearTimeout(claudeChatHoverShowTimer.current); claudeChatHoverShowTimer.current = null; }
          setClaudeChatVisible(v => !v);
        };
        const onLeaveTrigger = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) clearTimeout(claudeChatHideTimer.current);
          claudeChatHideTimer.current = setTimeout(() => setClaudeChatVisible(false), 500);
        };
        void onLeaveTrigger;
        return (
          <>
            {!claudeChatPinned && (
              <div className="claude-chat-sidebar-trigger">
                <div
                  className="claude-chat-sidebar-trigger-top claude-chat-sidebar-trigger-ai"
                  onClick={() => { if (claudeChatView === 'ai' && claudeChatVisible) { onClickTrigger(); } else { openClaudeChatView('ai'); } }}
                  onMouseEnter={onEnterTriggerHover}
                  onMouseLeave={onLeaveTriggerHover}
                  style={{ cursor: 'pointer' }}
                  title={tApp('claudeChat.triggerTooltip')}
                >
                  <span className="claude-chat-sidebar-trigger-text">{tMsg('triggerTextAi')}</span>
                </div>
                <div
                  className="claude-chat-sidebar-trigger-top claude-chat-sidebar-trigger-messenger"
                  onClick={() => { if (claudeChatView === 'messenger' && claudeChatVisible) { onClickTrigger(); } else { openClaudeChatView('messenger'); } }}
                  onMouseEnter={onEnterTriggerHover}
                  onMouseLeave={onLeaveTriggerHover}
                  style={{ cursor: 'pointer' }}
                  title={tApp('claudeChat.triggerTooltip')}
                >
                  <span className="claude-chat-sidebar-trigger-text">{tMsg('triggerTextMessenger')}</span>
                </div>
                <div className="claude-chat-sidebar-trigger-bottom" />
              </div>
            )}
            <div
              className={`claude-chat-sidebar ${!claudeChatPinned ? 'auto-hide' : ''} ${!claudeChatPinned && !claudeChatVisible ? 'hidden' : ''}`}
              style={{ width: `${claudeChatWidth}px`, right: claudeChatPinned ? '0px' : '20px' }}
              onMouseEnter={onEnterSidebar}
              onMouseLeave={onLeaveSidebar}
            >
            <div
              className="claude-chat-sidebar-resizer"
              title={tApp('claudeChat.resizeTooltip')}
              onMouseDown={e => {
                e.preventDefault();
                const startX = e.clientX;
                const startWidth = claudeChatWidth;
                chatResizingRef.current = true;
                let rafId = 0;
                let pendingW = startWidth;
                const onMove = (ev: MouseEvent) => {
                  const dx = startX - ev.clientX;
                  pendingW = Math.max(280, Math.min(1200, startWidth + dx));
                  // rAF 스로틀 — 프레임당 1회만 상태 갱신 (드래그 중 refit 은 effect 에서 skip)
                  if (rafId) return;
                  rafId = requestAnimationFrame(() => {
                    rafId = 0;
                    setClaudeChatWidth(pendingW);
                  });
                };
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
                  chatResizingRef.current = false;
                  // 최종 너비 확정 + prefs 저장 + refit 1회
                  setClaudeChatWidth(pendingW);
                  try { (window as any).api?.setUIPrefs?.({ claudeChatWidth: pendingW }); } catch {}
                  [0, 60, 180].forEach(ms => setTimeout(() => {
                    window.dispatchEvent(new Event('resize'));
                    refitAllTerms();
                  }, ms));
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
              onDoubleClick={() => {
                setClaudeChatWidth(360);
                try { (window as any).api?.setUIPrefs?.({ claudeChatWidth: 360 }); } catch {}
              }}
            />
            <ClaudeChat
              onClose={() => setShowClaudeChat(false)}
              pendingContext={claudeFileContext}
              onContextConsumed={() => setClaudeFileContext(null)}
              mountEntries={claudeMountEntries}
              onClearMounted={() => setClaudeMountEntries([])}
              onRemoveMountedEntry={(rp, termId) => setClaudeMountEntries(prev => prev.filter(e => !(e.remotePath === rp && e.termId === termId)))}
              connectedSessions={connectedSessions}
              defaultSshSession={defaultSsh}
              pinned={claudeChatPinned}
              onTogglePin={() => setClaudeChatPinned(p => !p)}
              visible={claudeChatPinned || claudeChatVisible}
              view={claudeChatView}
              onViewChange={setClaudeChatView}
              aiAgent={aiAgent}
              onAgentChange={setAiAgent}
            />
            </div>
          </>
        );
      })()}
      {claudeAttaching && (
        <div className="claude-attach-toast">
          <div className="claude-attach-toast-msg">🤖 {claudeAttaching.message}</div>
          {claudeAttaching.total > 0 && (
            <div className="claude-attach-toast-bar">
              <div className="claude-attach-toast-bar-fill" style={{ width: `${Math.min(100, (claudeAttaching.progress / claudeAttaching.total) * 100)}%` }} />
            </div>
          )}
        </div>
      )}
      {messengerPopup && (
        <div
          className={`messenger-popup ${messengerPopup.style}${messengerPopupEngaged ? ' engaged' : ''}`}
          onMouseDown={() => setMessengerPopupEngaged(true)}
          onFocusCapture={() => setMessengerPopupEngaged(true)}
        >
          <div className="messenger-popup-head">
            <div>
              <div className="messenger-popup-title">💬 {messengerPopup.peerName}</div>
              <div className="messenger-popup-time">{new Date(messengerPopup.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            </div>
            <button className="messenger-popup-close" onClick={dismissMessengerPopup}>×</button>
          </div>
          <div className="messenger-popup-body">{messengerPopup.text || tMsg('popupEmpty')}</div>
          <textarea
            className="messenger-popup-reply"
            value={messengerReplyText}
            onChange={e => setMessengerReplyText(e.target.value)}
            placeholder={tMsg('replyPlaceholder')}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendMessengerPopupReply();
              }
            }}
          />
          <div className="messenger-popup-actions">
            <button className="messenger-popup-open" onClick={() => openClaudeChatView('messenger')}>{tMsg('open')}</button>
            <button className="messenger-popup-send" onClick={() => { void sendMessengerPopupReply(); }} disabled={!messengerReplyText.trim()}>{tMsg('sendReply')}</button>
          </div>
        </div>
      )}
      {splitSessionPicker && (() => {
        const { folders, sessions } = splitSessionPicker;
        const toggleFolder = (fid: string) => {
          setSplitPickerCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(fid)) next.delete(fid); else next.add(fid);
            return next;
          });
        };
        const renderTree = (parentId: string | undefined, depth: number): React.ReactNode[] => {
          const rows: React.ReactNode[] = [];
          const subFolders = folders.filter(f => (f.parentId ?? undefined) === (parentId ?? undefined));
          for (const f of subFolders) {
            const isCollapsed = splitPickerCollapsed.has(f.id);
            rows.push(
              <div
                key={`f-${f.id}`}
                data-fid={f.id}
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
                data-sid={s.sessionId}
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
            <div
              className="folder-picker"
              onClick={e => e.stopPropagation()}
            >
              <div className="folder-picker-title">{splitSessionPicker.dir === 'row' ? tApp('splitPicker.titleRow') : tApp('splitPicker.titleCol')}</div>
              <div className="folder-picker-list">
                {renderTree(undefined, 0)}
              </div>
              <div className="folder-picker-actions">
                <button onClick={() => setSplitSessionPicker(null)}>{tApp('splitPicker.cancel')}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {infoModal && (() => {
        const closeAndFocus = () => {
          setInfoModal(null);
          restoreTerminalFocus();
        };
        return (
          <div className="session-editor-backdrop" onClick={closeAndFocus}>
            <div className="session-editor" onClick={e => e.stopPropagation()}
              style={{ minWidth: 320, maxWidth: 700, maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}
              onKeyDown={e => { if (e.key === 'Escape') closeAndFocus(); }}
              tabIndex={-1}
              ref={el => { if (el) setTimeout(() => el.focus(), 0); }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px 8px', borderBottom: '1px solid #333' }}>
                <h3 style={{ margin: 0 }}>{infoModal.title}</h3>
                <button onClick={closeAndFocus} title={tApp('infoModal.closeTooltip')}>✕</button>
              </div>
              <pre style={{ overflow: 'auto', margin: 0, padding: '12px 16px', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#ddd' }}>
                {infoModal.text}
              </pre>
            </div>
          </div>
        );
      })()}

      {updateStatus && (() => {
        const st = updateStatus.state as string;
        const info = updateStatus.info || {};
        const ver = info.version || '';
        const close = () => { setUpdateStatus(null); restoreTerminalFocus(); };
        const fmtBytes = (n: number) => {
          if (!n && n !== 0) return '';
          const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n;
          while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
          return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
        };
        let title = tApp('update.title');
        if (st === 'checking') title = tApp('update.titleChecking');
        else if (st === 'available') title = tApp('update.titleAvailable');
        else if (st === 'downloading') title = tApp('update.titleDownloading');
        else if (st === 'downloaded') title = tApp('update.titleDownloaded');
        else if (st === 'not-available') title = tApp('update.titleNotAvailable');
        else if (st === 'unsupported') title = tApp('update.titleUnsupported');
        else if (st === 'error') title = tApp('update.titleError');
        const pct = updateStatus.progress?.percent || 0;
        const rn = typeof info.releaseNotes === 'string' ? info.releaseNotes.replace(/<[^>]+>/g, '').trim() : '';
        return (
          <div className="session-editor-backdrop" onClick={st === 'downloading' ? undefined : close}>
            <div className="session-editor" onClick={e => e.stopPropagation()}
              style={{ minWidth: 360, maxWidth: 560, maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}
              onKeyDown={e => { if (e.key === 'Escape' && st !== 'downloading') close(); }}
              tabIndex={-1}
              ref={el => { if (el) setTimeout(() => el.focus(), 0); }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px 8px', borderBottom: '1px solid #333' }}>
                <h3 style={{ margin: 0 }}>{title}</h3>
                {st !== 'downloading' && <button onClick={close} title={tApp('update.closeTooltip')}>✕</button>}
              </div>
              <div style={{ padding: '14px 16px', color: '#ddd', fontSize: 13, lineHeight: 1.6, overflow: 'auto' }}>
                {st === 'checking' && <div>{tApp('update.checkingMsg')}</div>}
                {st === 'available' && (
                  <div>
                    <div>{tApp('update.availableMsgPlain', { ver })}</div>
                    {rn && (
                      <pre style={{ marginTop: 10, padding: '8px 10px', background: '#1c1c1c', border: '1px solid #333', borderRadius: 4, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, fontFamily: 'inherit' }}>{rn}</pre>
                    )}
                  </div>
                )}
                {st === 'downloading' && (
                  <div>
                    <div style={{ marginBottom: 8 }}>{tApp('update.downloadingMsg', { ver, pct: pct.toFixed(1) })}</div>
                    <div style={{ height: 10, background: '#2a2a2a', borderRadius: 5, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,#3a8,#5cf)', transition: 'width .2s' }} />
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11, color: '#999' }}>
                      {fmtBytes(updateStatus.progress?.transferred)} / {fmtBytes(updateStatus.progress?.total)}
                      {updateStatus.progress?.bytesPerSecond ? ` · ${fmtBytes(updateStatus.progress.bytesPerSecond)}/s` : ''}
                    </div>
                  </div>
                )}
                {st === 'downloaded' && <div>{tApp('update.downloadedMsg', { ver })}<br />{tApp('update.downloadedMsg2')}</div>}
                {st === 'not-available' && <div>{tApp('update.notAvailableMsg', { suffix: ver ? ` (v${ver})` : '' })}</div>}
                {st === 'unsupported' && <div>{tApp('update.unsupportedMsg')}<br />{tApp('update.unsupportedMsg2')}</div>}
                {st === 'error' && <div style={{ color: '#f88' }}>{tApp('update.errorMsg')}<br /><span style={{ fontSize: 11, color: '#caa' }}>{String(updateStatus.error || '')}</span></div>}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '8px 12px', borderTop: '1px solid #333' }}>
                {st === 'available' && (
                  <>
                    <button onClick={close}>{tApp('update.later')}</button>
                    <button style={{ background: '#2a6', color: '#fff' }} onClick={async () => {
                      setUpdateStatus({ state: 'downloading', info, progress: { percent: 0 } });
                      try { await (window as any).api?.updaterDownload?.(); } catch {}
                    }}>{tApp('update.downloadNow')}</button>
                  </>
                )}
                {st === 'downloaded' && (
                  <>
                    <button onClick={close}>{tApp('update.later')}</button>
                    <button style={{ background: '#2a6', color: '#fff' }} onClick={async () => {
                      try { await (window as any).api?.updaterQuitAndInstall?.(); } catch {}
                    }}>{tApp('update.restartNow')}</button>
                  </>
                )}
                {(st === 'not-available' || st === 'unsupported' || st === 'error' || st === 'checking') && (
                  <button onClick={close}>{st === 'checking' ? tApp('update.background') : tApp('update.ok')}</button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {sessionWipeDialog && (
        <div
          className="session-editor-backdrop"
          onClick={() => setSessionWipeDialog(false)}
        >
          <div
            className="session-editor"
            onClick={e => e.stopPropagation()}
            style={{ minWidth: 380, maxWidth: 560, display: 'flex', flexDirection: 'column' }}
            tabIndex={-1}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px 8px', borderBottom: '1px solid #333' }}>
              <h3 style={{ margin: 0 }}>{tApp('sessionWipe.dialogTitle')}</h3>
              <button onClick={() => setSessionWipeDialog(false)} title={tApp('common.close')}>✕</button>
            </div>
            <div style={{ padding: '14px 16px', color: '#ddd', fontSize: 13, lineHeight: 1.65 }}>
              {tApp('sessionWipe.dialogDesc')}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '8px 12px', borderTop: '1px solid #333', flexWrap: 'wrap' }}>
              <button onClick={() => setSessionWipeDialog(false)}>{tApp('sessionWipe.cancel')}</button>
              <button style={{ background: '#735f16', color: '#fff' }} onClick={async () => {
                setSessionWipeDialog(false);
                await handleClearSessions('backup');
              }}>{tApp('sessionWipe.backup')}</button>
              <button style={{ background: '#a53030', color: '#fff' }} onClick={async () => {
                setSessionWipeDialog(false);
                await handleClearSessions('delete');
              }}>{tApp('sessionWipe.delete')}</button>
            </div>
          </div>
        </div>
      )}

      {showManual && (        <div className="session-editor-backdrop" onClick={() => setShowManual(false)}>
          <div className="session-editor manual-modal" onClick={e => e.stopPropagation()}
            style={{ width: '80vw', maxWidth: 1000, height: '85vh', display: 'flex', flexDirection: 'column' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px 8px', borderBottom: '1px solid #333' }}>
              <h3 style={{ margin: 0 }}>{tApp('manual.title')}</h3>
              <button onClick={() => setShowManual(false)} title={tApp('common.close')}>✕</button>
            </div>
            <div className="manual-content" style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}
              dangerouslySetInnerHTML={{ __html: manualHtml }}
            />
          </div>
        </div>
      )}

      {remotePickerOpen && (
        <div className="session-editor-backdrop" style={{ zIndex: 10000 }} onClick={() => setRemotePickerOpen(false)}>
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 580, maxHeight: '80vh', display: 'flex', flexDirection: 'column', zIndex: 10001 }}>
            <h3>{tApp('remotePicker.title')}</h3>

            <label style={{ fontSize: 12, color: '#bbb' }}>{tApp('remotePicker.sourceSession')}</label>
            {(() => {
              // 연결된 sessionId 맵 — 모든 워크스페이스의 모든 세션 검사
              const connectedSet = new Set<string>();
              // 빠른연결로 접속한 세션들 — 가상 세션으로 picker dropdown 에 합류 (id 는 termId 그대로 사용)
              const quickConnectSessions: Array<{ id: string; name: string; host: string; port?: number; username?: string; auth?: any; folderId?: string; __quick?: boolean; __termId?: string }> = [];
              for (const t of tabs) {
                for (const s of collectAllSessions(t.layout)) {
                  if (!isTermConnected(s.termId)) continue;
                  if (s.sessionId) {
                    connectedSet.add(s.sessionId);
                  } else {
                    const info = getTermSessionInfo(s.termId);
                    const q = info?.quickSession;
                    if (q) {
                      quickConnectSessions.push({
                        id: s.termId, // termId 를 id 로 — 일반 sessionId 와 구분되도록 그대로 사용
                        name: s.sessionName || q.host || tApp('remotePicker.quickConnect'),
                        host: q.host || info?.host || '',
                        port: q.port,
                        username: q.username,
                        __quick: true,
                        __termId: s.termId,
                      });
                    }
                  }
                }
              }
              // 폴더 트리 (간단 평면화) — 각 세션을 "폴더경로/세션명" 으로 정렬
              const folderPath = (fid?: string): string => {
                if (!fid) return '';
                const f = remotePickerFolders.find(x => x.id === fid);
                if (!f) return '';
                const parent = folderPath(f.parentId);
                return parent ? `${parent}/${f.name}` : f.name;
              };
              // 연결된 세션이 위로 — 같은 그룹 내에서는 폴더 경로 + 이름으로 정렬
              const sortFn = (a: any, b: any) => {
                const fa = folderPath(a.folderId);
                const fb = folderPath(b.folderId);
                return fa.localeCompare(fb) || a.name.localeCompare(b.name);
              };
              const connected = [
                ...remotePickerSessions.filter(s => connectedSet.has(s.id)),
                ...quickConnectSessions,
              ].sort(sortFn);
              const disconnected = remotePickerSessions.filter(s => !connectedSet.has(s.id)).sort(sortFn);
              const renderOption = (s: any) => {
                const fp = folderPath(s.folderId);
                const isQuick = !!s.__quick;
                const mark = (isQuick || connectedSet.has(s.id)) ? '🟢' : '⚪';
                const suffix = isQuick ? tApp('remotePicker.quickConnectSuffix') : '';
                return (
                  <option key={s.id} value={s.id}>
                    {mark} {s.name}{fp ? ` [${fp}]` : ''} ({s.host}){suffix}
                  </option>
                );
              };
              return (
                <select value={remotePickerSessionId} onChange={e => {
                  setRemotePickerSessionId(e.target.value);
                  setRemotePickerFiles([]);
                  setRemotePickerSelected(new Set());
                }}>
                  <option value="">{tApp('remotePicker.selectSession')}</option>
                  {connected.length > 0 && (
                    <optgroup label={tApp('remotePicker.groupConnected')}>
                      {connected.map(renderOption)}
                    </optgroup>
                  )}
                  {disconnected.length > 0 && (
                    <optgroup label={tApp('remotePicker.groupDisconnected')}>
                      {disconnected.map(renderOption)}
                    </optgroup>
                  )}
                </select>
              );
            })()}
            {remotePickerConnecting && (
              <div style={{ fontSize: 11, color: '#f0c64c', marginTop: 4 }}>
                {tApp('remotePicker.connecting')}
              </div>
            )}

            <label style={{ fontSize: 12, color: '#bbb', marginTop: 10 }}>{tApp('remotePicker.path')}</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input type="text" value={remotePickerPath} onChange={e => setRemotePickerPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setRemotePickerSelected(new Set());
                    // path 변경은 useEffect 가 자동 재로드
                  }
                }}
                style={{ flex: 1 }}
                disabled={!remotePickerConnId} />
              <button onClick={() => {
                const parent = remotePickerPath.replace(/\/[^/]+\/?$/, '') || '/';
                setRemotePickerPath(parent);
                setRemotePickerSelected(new Set());
              }} title={tApp('remotePicker.parentTooltip')} disabled={!remotePickerConnId}>▲</button>
              <button onClick={async () => {
                if (!remotePickerConnId) return;
                setRemotePickerLoading(true);
                try { const r: any = await (window as any).api?.feListDir?.('remote', remotePickerPath, remotePickerConnId); setRemotePickerFiles(r?.files || []); } catch { setRemotePickerFiles([]); }
                setRemotePickerLoading(false);
              }} title={tApp('remotePicker.refreshTooltip')} disabled={!remotePickerConnId}>⟳</button>
            </div>

            <div style={{ flex: 1, minHeight: 200, maxHeight: 320, overflowY: 'auto', border: '1px solid #333', borderRadius: 4, marginTop: 8, background: '#161616' }}>
              {!remotePickerConnId ? (
                <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>{tApp('remotePicker.selectSessionHint')}</div>
              ) : remotePickerLoading || remotePickerConnecting ? (
                <div style={{ color: '#888', fontSize: 12, padding: 16, textAlign: 'center' }}>{tApp('remotePicker.loading')}</div>
              ) : remotePickerFiles.length === 0 ? (
                <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>{tApp('remotePicker.emptyOrError')}</div>
              ) : (
                remotePickerFiles
                  .filter(f => f.name !== '.' && f.name !== '..')
                  .sort((a, b) => (a.isDir !== b.isDir) ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name))
                  .map(f => (
                    <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', cursor: 'pointer', background: remotePickerSelected.has(f.name) ? '#2b4e74' : 'transparent' }}
                      onClick={() => {
                        setRemotePickerSelected(prev => {
                          const next = new Set(prev);
                          if (next.has(f.name)) next.delete(f.name); else next.add(f.name);
                          return next;
                        });
                      }}
                      onDoubleClick={() => {
                        if (!f.isDir) return;
                        const sep = remotePickerPath.endsWith('/') ? '' : '/';
                        setRemotePickerPath(remotePickerPath + sep + f.name);
                        setRemotePickerSelected(new Set());
                      }}
                    >
                      <input type="checkbox" readOnly checked={remotePickerSelected.has(f.name)} />
                      <span style={{ fontSize: 12 }}>{f.isDir ? '📁' : '📄'} {f.name}</span>
                    </div>
                  ))
              )}
            </div>
            <div style={{ fontSize: 11, color: '#777', marginTop: 4 }}>
              {tApp('remotePicker.legend', { count: remotePickerSelected.size })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button onClick={() => setRemotePickerOpen(false)}>{tApp('remotePicker.close')}</button>
              <button className="primary" disabled={remotePickerSelected.size === 0 || !remotePickerConnId}
                onClick={() => {
                  const sess = remotePickerSessions.find(s => s.id === remotePickerSessionId);
                  const sessLabel = sess?.name || remotePickerConnId.slice(-6);
                  const toAdd = [...remotePickerSelected].map(name => {
                    const sep = remotePickerPath.endsWith('/') ? '' : '/';
                    const fullPath = remotePickerPath + sep + name;
                    const isFolder = remotePickerFiles.find(f => f.name === name)?.isDir || false;
                    return { path: fullPath, isFolder, sourceTermId: remotePickerConnId, sourceLabel: sessLabel };
                  });
                  setBcastXferFiles(prev => [...prev, ...toAdd]);
                  // 닫진 않음 — 여러 세션에서 연속 선택 가능하도록 유지. 세션만 초기화.
                  setRemotePickerSelected(new Set());
                }}
              >{tApp('remotePicker.addSelected', { count: remotePickerSelected.size })}</button>
            </div>
          </div>
        </div>
      )}

      {remotePickerCredPrompt && (
        <div className="session-editor-backdrop" style={{ zIndex: 10100 }} onClick={() => setRemotePickerCredPrompt(null)}>
          <div className="cred-modal" ref={remotePickerCredModalRef} tabIndex={-1} onClick={e => e.stopPropagation()} style={{ outline: 'none' }}>
            <div className="cred-modal-header">
              <span className="cred-modal-title">{tApp('cred.title')}</span>
              <button className="cred-modal-close" onClick={() => setRemotePickerCredPrompt(null)}>✕</button>
            </div>
            <div className="cred-modal-host">{tApp('cred.connectTo', { host: remotePickerCredPrompt.sess.host })}</div>
            <div className="cred-modal-fields">
              <input
                ref={remotePickerCredUserRef}
                className="cred-modal-input"
                placeholder="username"
                value={remotePickerCredUser}
                onChange={e => setRemotePickerCredUser(e.target.value)}
              />
              <div className="cred-modal-pass-wrap">
                <input
                  className="cred-modal-input"
                  type={remotePickerCredShowPass ? 'text' : 'password'}
                  placeholder="password"
                  value={remotePickerCredPass}
                  onChange={e => setRemotePickerCredPass(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleRemotePickerCredSubmit(); }}
                />
                <button
                  type="button"
                  className="cred-modal-eye-btn"
                  tabIndex={-1}
                  onClick={() => setRemotePickerCredShowPass(v => !v)}
                  title={remotePickerCredShowPass ? tApp('cred.hide') : tApp('cred.show')}
                >
                  {remotePickerCredShowPass ? '🙈' : '👁'}
                </button>
              </div>
            </div>
            <div className="cred-modal-actions">
              <button className="btn-cancel" onClick={() => setRemotePickerCredPrompt(null)}>{tApp('cred.cancel')}</button>
              <button className="btn-save" onClick={handleRemotePickerCredSubmit} disabled={remotePickerCredConnecting}>
                {remotePickerCredConnecting ? tApp('cred.connecting') : tApp('cred.connect')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showBcastFileXfer && (
        <div className="session-editor-backdrop" onClick={() => !bcastXferInProgress && setShowBcastFileXfer(false)}>
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 620, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <h3>{tApp('bcastXfer.title')}</h3>

            <label style={{ fontSize: 12, color: '#bbb', marginTop: 8 }}>{tApp('bcastXfer.targetSession')}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select value={broadcastScope} onChange={e => setBroadcastScope(e.target.value as any)} style={{ flex: 1 }}>
                <option value="visible">{tApp('bcastXfer.scopeVisible')}</option>
                <option value="current">{tApp('bcastXfer.scopeCurrent')}</option>
                <option value="connected">{tApp('bcastXfer.scopeConnected')}</option>
              </select>
              <span style={{ color: '#8ab', fontSize: 12 }}>{tApp('bcastXfer.count', { count: collectBroadcastTargets(broadcastScope).length })}</span>
            </div>

            <label style={{ fontSize: 12, color: '#bbb', marginTop: 12 }}>{tApp('bcastXfer.remotePath')}</label>
            <input type="text" value={bcastXferPath} onChange={e => setBcastXferPath(e.target.value)}
              placeholder={tApp('bcastXfer.remotePathPlaceholder')} />

            <label style={{ fontSize: 12, color: '#bbb', marginTop: 12 }}>{tApp('bcastXfer.uploadFiles')}</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              <button onClick={async () => {
                const r: any = await (window as any).api?.pickFiles?.(true);
                if (r?.paths?.length) {
                  setBcastXferFiles(prev => [...prev, ...r.paths.map((p: string) => ({ path: p, isFolder: false }))]);
                }
              }}>{tApp('bcastXfer.addLocalFile')}</button>
              <button onClick={async () => {
                const r: any = await (window as any).api?.pickFolder?.();
                if (r?.path) setBcastXferFiles(prev => [...prev, { path: r.path, isFolder: true }]);
              }}>{tApp('bcastXfer.addLocalFolder')}</button>
              <button onClick={() => {
                // 전체 세션 리스트에서 선택 — 미연결이면 백그라운드 연결
                setRemotePickerSessionId('');
                setRemotePickerConnId('');
                setRemotePickerPath('');
                setRemotePickerFiles([]);
                setRemotePickerSelected(new Set());
                setRemotePickerOpen(true);
              }}>{tApp('bcastXfer.addRemoteFile')}</button>
              <button onClick={() => setBcastXferFiles([])} disabled={bcastXferFiles.length === 0}>{tApp('bcastXfer.removeAll')}</button>
            </div>
            <div style={{ flex: 1, minHeight: 100, maxHeight: 220, overflowY: 'auto', border: '1px solid #333', borderRadius: 4, padding: 6, background: '#161616' }}>
              {bcastXferFiles.length === 0 ? (
                <div style={{ color: '#666', fontSize: 12, textAlign: 'center', padding: 16 }}>{tApp('bcastXfer.emptyHint')}</div>
              ) : (
                bcastXferFiles.map((f, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 6px', gap: 6 }}>
                    <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={`${f.sourceTermId ? tApp('bcastXfer.remoteSourcePrefix', { label: f.sourceLabel }) : tApp('bcastXfer.localSourcePrefix')} ${f.path}`}>
                      {f.sourceTermId ? '🌐' : '💻'} {f.isFolder ? '📁' : '📄'} {f.path}
                      {f.sourceTermId && <span style={{ color: '#8ab', fontSize: 10, marginLeft: 6 }}>[{f.sourceLabel}]</span>}
                    </span>
                    <button onClick={() => setBcastXferFiles(prev => prev.filter((_, idx) => idx !== i))} style={{ padding: '0 8px' }}>✕</button>
                  </div>
                ))
              )}
            </div>
            {bcastXferLog.length > 0 && (
              <div style={{ maxHeight: 120, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace', color: '#aaa', background: '#0c0c0c', padding: 6, borderRadius: 4, marginTop: 8 }}>
                {bcastXferLog.map((l, i) => (
                  <div key={i} style={{ color: l.startsWith('✓') ? '#7fcf6e' : (l.startsWith('✗') ? '#e36b6b' : '#aaa') }}>{l}</div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button onClick={() => setShowBcastFileXfer(false)} disabled={bcastXferInProgress}>{tApp('bcastXfer.close')}</button>
              <button className="primary" disabled={bcastXferInProgress || bcastXferFiles.length === 0 || collectBroadcastTargets(broadcastScope).length === 0}
                onClick={async () => {
                  const targets = collectBroadcastTargets(broadcastScope);
                  if (targets.length === 0) { flashBroadcastNotice(tApp('bcastXfer.noTargets'), 'warn'); return; }
                  setBcastXferInProgress(true);
                  setBcastXferLog([tApp('bcastXfer.startLog', { targets: targets.length, files: bcastXferFiles.length })]);
                  const override = bcastXferPath.trim();
                  // 이 일괄전송 1회 전체에 같은 workspaceId 부여 → 충돌 "전체 적용" 결정이 모든 파일·세션에 재사용됨.
                  // (이게 없으면 매 feTransfer 가 새 transferId 라 "전체 적용" 이 기억 안 되고 매번 다시 물음)
                  const bcastWid = `bcast-xfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                  let okCount = 0;
                  let errCount = 0;
                  for (const tid of targets) {
                    const basePath = override || getCurrentPwdForTerm(tid) || '/';
                    const info = getTermSessionInfo(tid);
                    const label = info?.sessionName || tid.slice(-6);
                    for (const f of bcastXferFiles) {
                      const filename = f.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
                      const remotePath = basePath.endsWith('/') ? basePath + filename : basePath + '/' + filename;
                      // 동일 세션은 source == target 이므로 skip
                      if (f.sourceTermId && f.sourceTermId === tid) {
                        setBcastXferLog(prev => [...prev, tApp('bcastXfer.skipSameSession', { label, filename })]);
                        continue;
                      }
                      const src: any = f.sourceTermId
                        ? { mode: 'remote', termId: f.sourceTermId, path: f.path }
                        : { mode: 'local', path: f.path };
                      try {
                        // feTransfer 는 즉시 { seq } 만 반환하므로 fe:transfer-done 이벤트로 실제 완료를 await.
                        const r: any = await new Promise(resolve => {
                          (window as any).api?.feTransfer?.(
                            src,
                            { mode: 'remote', termId: tid, path: remotePath },
                            filename,
                            bcastWid,
                          ).then((res: any) => {
                            const seq: number = res?.seq;
                            if (seq == null) { resolve({ success: res?.success ?? true }); return; }
                            const unsub = (window as any).api?.onFeTransferDone?.((p: any) => {
                              if (p.seq === seq) { unsub?.(); resolve(p); }
                            });
                            if (!unsub) resolve({ success: true });
                          }).catch((e: any) => resolve({ success: false, error: String(e) }));
                        });
                        if (r?.success) {
                          okCount++;
                          setBcastXferLog(prev => [...prev, `✓ ${label}: ${filename} → ${basePath}`]);
                        } else {
                          errCount++;
                          setBcastXferLog(prev => [...prev, `✗ ${label}: ${filename} — ${r?.error || 'unknown'}`]);
                        }
                      } catch (err: any) {
                        errCount++;
                        setBcastXferLog(prev => [...prev, `✗ ${label}: ${filename} — ${err?.message || err}`]);
                      }
                    }
                  }
                  setBcastXferLog(prev => [...prev, tApp('bcastXfer.doneLog', { ok: okCount, err: errCount })]);
                  setBcastXferInProgress(false);
                  flashBroadcastNotice(tApp('bcastXfer.doneToast', { ok: okCount, total: okCount + errCount }), errCount === 0 ? 'ok' : 'warn');
                }}>
                {bcastXferInProgress ? tApp('bcastXfer.sending') : tApp('bcastXfer.send')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 비밀번호 입력 모달 — 현재 활성 세션(termId) 의 모달만 표시.
          여러 세션 동시 진행 가능, 각 세션 탭으로 전환하면 해당 비밀번호 카드가 보임.
          위치는 활성 세션 패널(.layout-leaf) 의 중앙. */}
      {askPwdPrompts.length > 0 && (() => {
        // 모든 탭에서 살아있는 termId 집합 — 닫힌 미니탭의 유령 모달 항목 정리용
        const liveTermIds = new Set<string>();
        const walkCollect = (n: any) => {
          if (n.type === 'leaf') {
            for (const s of n.panel.sessions) liveTermIds.add(s.termId);
          } else {
            for (const c of n.children) walkCollect(c);
          }
        };
        for (const t of tabs) {
          if (t.type === 'fileExplorer' || t.type === 'fileEditor') continue;
          walkCollect(t.layout);
        }
        const validPrompts = askPwdPrompts.filter(p => liveTermIds.has(p.termId));
        // 정리 — 다음 렌더 사이클에 state 도 동기화
        if (validPrompts.length !== askPwdPrompts.length) {
          setTimeout(() => {
            setAskPwdPrompts(prev => prev.filter(p => liveTermIds.has(p.termId)));
          }, 0);
        }
        if (validPrompts.length === 0) return null;
        // 현재 활성 termId 찾기 — activeTab + selectedPanelId + activeIdx 우선,
        // 매칭되는 모달이 없으면 현재 탭에서 askPwdPrompts 의 termId 를 가진 leaf 의 활성 세션을 찾음.
        let activeTid: string | null = null;
        const findLeaf = (n: any, id: string | null): any => {
          if (n.type === 'leaf') return (!id || n.id === id) ? n : null;
          for (const c of n.children) { const r = findLeaf(c, id); if (r) return r; }
          return null;
        };
        const findLeafContainingTermId = (n: any, tid: string): any => {
          if (n.type === 'leaf') {
            return n.panel.sessions.some((s: any) => s.termId === tid) ? n : null;
          }
          for (const c of n.children) { const r = findLeafContainingTermId(c, tid); if (r) return r; }
          return null;
        };
        try {
          if (activeTab) {
            const leaf = findLeaf(activeTab.layout, selectedPanelId || null);
            if (leaf) activeTid = leaf.panel.sessions[leaf.panel.activeIdx]?.termId || null;
            // selectedPanelId 가 다른 탭 패널이거나 모달 termId 와 안 맞으면, 현재 탭에서
            // 모달 termId 를 가진 leaf 의 활성 세션을 활성으로 간주.
            const matchedItem = activeTid && validPrompts.find(x => x.termId === activeTid);
            if (!matchedItem) {
              for (const it of validPrompts) {
                const lf = findLeafContainingTermId(activeTab.layout, it.termId);
                if (lf) {
                  const activeOfLeaf = lf.panel.sessions[lf.panel.activeIdx]?.termId;
                  if (activeOfLeaf === it.termId) { activeTid = it.termId; break; }
                }
              }
            }
          }
          // activeTab 에서 못 찾았으면 좌우 분할된 splitRightTab 도 확인 — 우측 터미널에서
          // 세션 선택 분할 등으로 비밀번호 프롬프트가 뜬 경우 activeTab 이 브라우저 등이라 위에서
          // 못 찾을 수 있음.
          if (!activeTid || !validPrompts.find(x => x.termId === activeTid)) {
            if (splitRightTab) {
              for (const it of validPrompts) {
                const lf = findLeafContainingTermId(splitRightTab.layout, it.termId);
                if (lf) {
                  const activeOfLeaf = lf.panel.sessions[lf.panel.activeIdx]?.termId;
                  if (activeOfLeaf === it.termId) { activeTid = it.termId; break; }
                }
              }
            }
          }
        } catch {}
        const item = activeTid ? validPrompts.find(x => x.termId === activeTid) : null;
        if (!item) return null;
        // React portal 로 활성 세션 패널(.layout-leaf) 내부에 모달 렌더 — CSS 가 패널 내 중앙 자동 정렬.
        // 분할창 변경/세션 전환 후에도 항상 해당 패널의 정중앙에 위치 보장.
        const targetEl = (() => {
          try { return document.querySelector(`.layout-leaf[data-active-term="${activeTid}"]`) as HTMLElement | null; } catch { return null; }
        })();
        if (!targetEl) return null;
        const offset = askPwdOffset[item.termId] || { x: 0, y: 0 };
        const startDrag = (e: React.MouseEvent) => {
          // 닫기 버튼/입력 영역은 드래그 시작 제외
          const tag = (e.target as HTMLElement).tagName;
          if (tag === 'BUTTON' || tag === 'INPUT' || (e.target as HTMLElement).closest('.ask-pwd-close')) return;
          e.preventDefault();
          const startX = e.clientX, startY = e.clientY;
          const baseX = offset.x, baseY = offset.y;
          const onMove = (ev: MouseEvent) => {
            setAskPwdOffset(prev => ({ ...prev, [item.termId]: { x: baseX + (ev.clientX - startX), y: baseY + (ev.clientY - startY) } }));
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        };
        return createPortal(
          <div className="ask-pwd-stack">
            <div key={item.termId} className="ask-pwd-card" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
              <div className="ask-pwd-header" onMouseDown={startDrag} style={{ cursor: 'move', userSelect: 'none' }}>
                <span className="ask-pwd-icon">🔐</span>
                <span className="ask-pwd-title">{item.needUsername ? tApp('askPwd.credTitle') : tApp('askPwd.pwdTitle')}</span>
                <button className="ask-pwd-close" title={tApp('askPwd.cancelTooltip')} onClick={() => closeAskPwd(item.termId, null)}>✕</button>
              </div>
              <div className="ask-pwd-desc">
                {item.hostHint ? tApp('askPwd.connectToPlain', { host: item.hostHint }) : tApp('askPwd.needCred')}
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
                      // 다음 입력란(비밀번호)로 포커스 이동
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
                  title={askPwdShowPass[item.termId] ? tApp('askPwd.hide') : tApp('askPwd.show')}
                >
                  {askPwdShowPass[item.termId] ? '🙈' : '👁'}
                </button>
              </div>
              <div className="ask-pwd-actions">
                <button onClick={() => closeAskPwd(item.termId, null)}>{tApp('askPwd.cancel')}</button>
                <button className="primary" onClick={() => closeAskPwd(item.termId, item.input)}>{tApp('askPwd.connect')}</button>
              </div>
              {validPrompts.length > 1 && (
                <div className="ask-pwd-hint">
                  {tApp('askPwd.waiting', { count: validPrompts.length - 1 })}
                </div>
              )}
            </div>
          </div>,
          targetEl,
        );
      })()}
      {/* 비밀번호 저장 권유 모달 */}
      {savePwdPrompt && (
        <div className="save-pwd-backdrop" onClick={() => { setSavePwdPrompt(null); setTimeout(() => focusTerm(savePwdPrompt.termId), 0); }}>
          <div className="save-pwd-modal" onClick={e => e.stopPropagation()}>
            <div className="save-pwd-icon">🔑</div>
            <div className="save-pwd-title">{tApp('savePwd.title')}</div>
            <div className="save-pwd-desc">{tApp('savePwd.desc')}</div>
            <div className="save-pwd-actions">
              <button
                onClick={() => {
                  const tid = savePwdPrompt.termId;
                  setSavePwdPrompt(null);
                  setTimeout(() => focusTerm(tid), 0);
                }}
              >{tApp('savePwd.dontSave')}</button>
              <button
                className="primary"
                onClick={async () => {
                  const { sessionId, password, termId } = savePwdPrompt;
                  setSavePwdPrompt(null);
                  try {
                    const data: any = await (window as any).api?.listSessions?.();
                    const list: any[] = Array.isArray(data) ? data : (data?.sessions || []);
                    const sess = list.find((s: any) => s.id === sessionId);
                    if (sess) {
                      const updated = { ...sess, auth: { ...(sess.auth || {}), type: 'password', password } };
                      await (window as any).api?.saveSession?.(updated);
                      try { window.dispatchEvent(new Event('sessions-reload')); } catch {}
                      showToast(tApp('savePwd.savedToast'));
                    }
                  } catch {}
                  setTimeout(() => focusTerm(termId), 0);
                }}
              >{tApp('savePwd.save')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

// ── 패널 이동 헬퍼 ──

function removeLeafFromTree(root: LayoutNode, targetId: string): { root: LayoutNode; removed?: LayoutNode } {
  if (root.type === 'leaf') {
    if (root.id === targetId) return { root: { ...root }, removed: root };
    return { root };
  }
  const children: LayoutNode[] = []; let removed: LayoutNode | undefined;
  for (const child of root.children) {
    const r = removeLeafFromTree(child, targetId);
    if (r.removed && !removed) removed = r.removed;
    if (!r.removed || r.root.type !== 'leaf' || r.root.id !== targetId) children.push(r.root);
  }
  if (children.length === 0) return { root, removed };
  if (children.length === 1) return { root: children[0], removed };
  return { root: { ...root, children }, removed };
}

function replaceLeaf(root: LayoutNode, targetId: string, leaf: LayoutNode): LayoutNode {
  if (root.type === 'leaf') return root.id === targetId ? leaf : root;
  return { ...root, children: root.children.map(c => replaceLeaf(c, targetId, leaf)) };
}

function insertNear(root: LayoutNode, targetId: string, leaf: LayoutNode, pos: 'before' | 'after'): LayoutNode {
  if (root.type === 'leaf') return root;
  const nc: LayoutNode[] = [];
  for (const c of root.children) {
    if (c.type === 'leaf' && c.id === targetId) { if (pos === 'before') nc.push(leaf); nc.push(c); if (pos === 'after') nc.push(leaf); }
    else nc.push(insertNear(c, targetId, leaf, pos));
  }
  return { ...root, children: nc };
}
