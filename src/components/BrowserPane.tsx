// src/components/BrowserPane.tsx
// 브라우저 워크스페이스 — Electron <webview> 로 외부 사이트 렌더.
// 뒤로/앞으로/새로고침/URL 입력 바와 SSH SOCKS 프록시 선택을 제공.
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

type Props = {
  initialUrl: string;
  onTitleChange?: (title: string) => void;
  connectedSessions?: ActiveSshTarget[];
  // 새 창 분리/병합 시 상태 복원용.
  initialState?: { editUrl?: string; zoom?: number; targetSessionId?: string; targetPanelId?: string } | null;
  onStateChange?: (state: { editUrl: string; zoom: number; targetSessionId: string; targetPanelId: string }) => void;
  // 커스텀 워크스페이스 그리드 슬롯 안에 배치된 경우 true. 일반 브라우저 탭(전체 탭 하나를 차지)은
  // 기존 sizing 로직을 그대로 쓰고, 커스텀 워크스페이스 슬롯(그리드 셀, 크기가 작고 자주 리사이즈됨)만
  // 별도 sizing 로직을 쓴다 — 기존 탭 동작에 영향 없이 커스텀 워크스페이스의 "150px 고정" 버그만 고친다.
  embedded?: boolean;
};

type ActiveSshTarget = {
  panelId: string;
  sessionId?: string;
  sessionName?: string;
  host?: string;
  port?: number;
  browserUrl?: string;
};

type StoredSession = {
  id: string;
  name?: string;
  browserUrl?: string;
  host?: string;
  port?: number;
  hasJumps?: boolean;
};

export const BrowserPane: React.FC<Props> = ({ initialUrl, onTitleChange, connectedSessions = [], initialState, onStateChange, embedded = false }) => {
  const { t } = useTranslation('browser');
  const webviewRef = useRef<any>(null);
  const webviewWrapRef = useRef<HTMLDivElement | null>(null);
  const browserPaneRef = useRef<HTMLDivElement | null>(null);
  const lastAppliedWebviewHeightRef = useRef<number>(-1);
  const webviewDomReadyRef = useRef(false);
  const lastGuestResizeKeyRef = useRef('');
  const lastExpectedHeightRef = useRef<number>(0);
  const recoveryAttemptRef = useRef(0);
  const lastRecoveryAtRef = useRef(0);
  const [webviewNonce, setWebviewNonce] = useState(0);
  const activeTabIdRef = useRef<string>('');
  const tabsRef = useRef<BrowserTab[]>([]);
  const activeTargetPanelIdRef = useRef<string>('');
  const zoomRef = useRef<number>(1);
  const onTitleChangeRef = useRef<Props['onTitleChange']>(onTitleChange);
  const urlHistoryKey = 'pepe-browser-url-history';
  const partitionName = useMemo(
    () => `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );
  // 복원된 URL 이 있으면 그걸로 시작.
  const startUrl = (initialState?.editUrl && initialState.editUrl.trim()) ? initialState.editUrl : initialUrl;
  const initialSrcRef = useRef(startUrl);
  // ── 내부 탭 관리 — 링크가 새 창으로 열릴 때 새 탭으로 처리. ──
  type BrowserTab = { id: string; url: string; title: string; targetSessionId: string; targetPanelId: string };
  const newTabId = () => `t${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [{
    id: newTabId(),
    url: startUrl,
    title: '',
    targetSessionId: initialState?.targetSessionId || '',
    targetPanelId: initialState?.targetPanelId || '',
  }]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);
  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];
  const activeTargetSessionId = activeTab?.targetSessionId || '';
  const activeTargetPanelId = activeTab?.targetPanelId || '';
  const setTabUrl = (id: string, url: string) => setTabs(prev => prev.map(t => t.id === id ? { ...t, url } : t));
  const setTabTitle = (id: string, title: string) => setTabs(prev => prev.map(t => t.id === id ? { ...t, title } : t));
  const openInNewTab = (url: string) => {
    const t: BrowserTab = { id: newTabId(), url, title: '', targetSessionId: '', targetPanelId: '' };
    setTabs(prev => [...prev, t]);
    setActiveTabId(t.id);
  };
  const closeTab = (id: string) => {
    setTabs(prev => {
      if (prev.length <= 1) return prev; // 최소 1개 유지
      const idx = prev.findIndex(t => t.id === id);
      const next = prev.filter(t => t.id !== id);
      if (id === activeTabId) {
        const newActive = next[Math.max(0, idx - 1)] || next[0];
        setActiveTabId(newActive.id);
      }
      return next;
    });
  };
  const [editUrl, setEditUrl] = useState(startUrl);
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(initialState?.zoom ?? 1.0);
  const [sshTargets, setSshTargets] = useState<ActiveSshTarget[]>([]);
  const [storedSessions, setStoredSessions] = useState<StoredSession[]>([]);
  const [showUrlHistory, setShowUrlHistory] = useState(false);
  const [recentUrls, setRecentUrls] = useState<string[]>(() => {
    try {
      const raw = window.localStorage.getItem(urlHistoryKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((x: any) => typeof x === 'string' && x.trim()) : [];
    } catch {
      return [];
    }
  });
  const urlHistoryHideTimerRef = useRef<number | null>(null);
  const credSyncSeqRef = useRef(0);
  // 부모에게 상태 변경 보고 — 분리 시 직렬화.
  useEffect(() => {
    if (!onStateChange) return;
    try { onStateChange({ editUrl, zoom, targetSessionId: activeTargetSessionId, targetPanelId: activeTargetPanelId }); } catch {}
  }, [editUrl, zoom, activeTargetSessionId, activeTargetPanelId, onStateChange]);
  useEffect(() => {
    try {
      window.localStorage.setItem(urlHistoryKey, JSON.stringify(recentUrls.slice(0, 20)));
    } catch {}
  }, [recentUrls]);
  const [proxyState, setProxyState] = useState<{ proxyId: string; localPort: number; panelId: string; connId?: string; sessionId?: string } | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string>('');
  const [testOk, setTestOk] = useState(false);
  const proxySeqRef = useRef(0);
  const lastAutoLoadedRef = useRef<string>('');
  const liveTargets = connectedSessions.length > 0 ? connectedSessions : sshTargets;
  const emitDebugLog = useCallback((...parts: any[]) => {
    const line = parts.map(p => {
      if (typeof p === 'string') return p;
      try { return JSON.stringify(p); } catch { return String(p); }
    }).join(' ');
    try { (window as any).api?.debugLog?.(line); } catch {}
    try { console.log(line); } catch {}
  }, []);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
    tabsRef.current = tabs;
    activeTargetPanelIdRef.current = activeTargetPanelId;
    zoomRef.current = zoom;
    onTitleChangeRef.current = onTitleChange;
  }, [activeTabId, tabs, activeTargetPanelId, zoom, onTitleChange]);

  // embedded(커스텀 워크스페이스 그리드 슬롯)일 때만 아래 새 sizing 로직을 쓴다. 일반 브라우저 탭은
  // 기존 로직(occupied 계산 + wrap 고정 px + autosize 핀)을 그대로 유지 — 기존 동작 무변경 보장.
  const syncWebviewHeightEmbedded = useCallback((tag: string) => {
    const root = browserPaneRef.current;
    const wrap = webviewWrapRef.current;
    const wv: any = webviewRef.current;
    if (!root || !wrap || !wv) return;
    try {
      // 래퍼(wrap)는 flex:1 로 CSS 가 실제 가용 영역을 채운다. 그 실측값을 기준으로 삼는다.
      // (기존 로직은 root.clientHeight - 형제높이 로 계산해 wrap 을 flex:none + 고정 px 로 얼렸는데,
      //  커스텀 워크스페이스 그리드 안에서 최초 측정이 작게 잡히면 이후 root/wrap 둘 다 리사이즈가
      //  안 일어나 ~150px 로 굳어버리는 버그가 있었다. webview 는 position:absolute; inset:0 이라
      //  wrap 만 자연스럽게 flex 로 채워지면 화면도 꽉 찬다.)
      //
      // 중요: <webview autosize="on"> 는 호스트 CSS 박스를 무시하고 게스트를 컨텐츠 크기 기준
      // (minwidth~maxwidth / minheight~maxheight 범위)으로 스스로 맞춘다. min/max 를 안 주면
      // Chromium 의 대체 요소 기본 크기(300x150)로 폴백되는데, 이게 바로 "150px 고정" 의 원인이었다.
      // autosize 를 아예 쓰지 않고(off) CSS 로만 크기를 주면, non-autosize <webview> 는 호스트
      // 엘리먼트의 실제 렌더 박스 크기를 게스트에 자동으로 동기화한다 — 이게 표준 동작이다.
      const wrapRect = wrap.getBoundingClientRect();
      const nextHeight = Math.max(1, Math.floor(wrapRect.height || 0));
      const nextWidth = Math.max(1, Math.floor(wrapRect.width || 0));
      lastExpectedHeightRef.current = nextHeight;
      const sizeChanged = lastAppliedWebviewHeightRef.current !== nextHeight;
      const shouldNudge = sizeChanged || /mount|dom-ready|did-stop-loading|active-tab-changed/.test(tag);
      if (sizeChanged) {
        lastAppliedWebviewHeightRef.current = nextHeight;
        wv.style.position = 'absolute';
        wv.style.inset = '0';
        wv.style.width = '100%';
        wv.style.height = '100%';
        wv.style.minWidth = '0';
        wv.style.minHeight = '0';
        wv.style.maxWidth = 'none';
        wv.style.maxHeight = 'none';
        // display 는 반드시 flex 여야 함 — block/inline-block 이면 <webview> 내부 게스트(object)가
        // 세로로 늘어나지 않고 크롭돼 렌더된다 (Electron 공식 문서/이슈에 명시된 동작).
        wv.style.display = 'flex';
        wv.style.background = '#ffffff';
      }
      if (shouldNudge && nextHeight > 1) {
        // hidden→visible 전환 / 그리드 리사이즈 직후 게스트 컴포지터가 새 크기를 놓치는 경우가
        // 있어, wrap 높이를 1px 흔들어 실측 가능한 layout 변화를 강제로 한 번 더 일으킨다.
        // (webview 는 wrap 을 inset:0 로 채우므로 wrap 이 흔들리면 webview 도 함께 흔들린다.)
        const prevHeight = wrap.style.height;
        wrap.style.height = `${nextHeight - 1}px`;
        window.requestAnimationFrame(() => {
          if (webviewWrapRef.current === wrap) wrap.style.height = prevHeight;
        });
      }
      emitDebugLog('[cw-debug][browser-webview-size]', {
        tag,
        wrapWidth: nextWidth,
        nextHeight,
        sizeChanged,
        shouldNudge,
        currentUrl: webviewDomReadyRef.current ? String(wv.getURL?.() || '') : '',
      });
    } catch (err: any) {
      emitDebugLog('[cw-debug][browser-webview-size-error]', { tag, error: String(err?.message || err || '') });
    }
  }, [emitDebugLog]);

  // 일반 브라우저 탭(전체 탭 하나를 차지, 리사이즈가 드묾)에서 쓰던 기존 로직 — 그대로 보존.
  const syncWebviewHeightDefault = useCallback((tag: string) => {
    const root = browserPaneRef.current;
    const wrap = webviewWrapRef.current;
    const wv: any = webviewRef.current;
    if (!root || !wrap || !wv) return;
    try {
      const rootHeight = root.clientHeight || root.getBoundingClientRect().height || 0;
      const children = Array.from(root.children) as HTMLElement[];
      let occupied = 0;
      for (const child of children) {
        if (child === wrap) break;
        occupied += child.getBoundingClientRect().height;
      }
      const nextHeight = Math.max(120, Math.floor(rootHeight - occupied));
      lastExpectedHeightRef.current = nextHeight;
      const sizeChanged = lastAppliedWebviewHeightRef.current !== nextHeight;
      const shouldForceGuestResize = sizeChanged || /mount|dom-ready|did-stop-loading|active-tab-changed/.test(tag);
      if (sizeChanged) {
        lastAppliedWebviewHeightRef.current = nextHeight;
        const nextWidth = Math.max(1, Math.floor(root.clientWidth || root.getBoundingClientRect().width || 0));
        wrap.style.flex = 'none';
        wrap.style.width = '100%';
        wrap.style.height = `${nextHeight}px`;
        wrap.style.minHeight = `${nextHeight}px`;
        wrap.style.maxHeight = `${nextHeight}px`;
        wrap.style.background = '#ffffff';
        wv.style.position = 'absolute';
        wv.style.inset = '0';
        wv.style.width = `${nextWidth}px`;
        wv.style.height = `${nextHeight}px`;
        wv.style.minWidth = `${nextWidth}px`;
        wv.style.minHeight = `${nextHeight}px`;
        wv.style.maxWidth = `${nextWidth}px`;
        wv.style.maxHeight = `${nextHeight}px`;
        wv.style.display = 'block';
        wv.style.background = '#ffffff';
      }
      if (shouldForceGuestResize) {
        try {
          const nextWidth = Math.max(1, Math.floor(root.clientWidth || root.getBoundingClientRect().width || 0));
          try {
            wv.setAttribute?.('autosize', 'on');
            wv.setAttribute?.('width', String(nextWidth));
            wv.setAttribute?.('height', String(nextHeight));
            wv.setAttribute?.('minwidth', String(nextWidth));
            wv.setAttribute?.('maxwidth', String(nextWidth));
            wv.setAttribute?.('minheight', String(nextHeight));
            wv.setAttribute?.('maxheight', String(nextHeight));
          } catch {}
          // Hidden pane -> visible pane 전환 시 guest viewport 가 이전 높이에 머무는 문제가 있어
          // 래퍼 높이를 한 번 흔들어 실제 resize 를 유도한다.
          wrap.style.height = `${Math.max(120, nextHeight - 1)}px`;
          window.requestAnimationFrame(() => {
            if (webviewWrapRef.current === wrap) {
              wrap.style.height = `${nextHeight}px`;
            }
          });
          if (webviewDomReadyRef.current) {
            const guestKey = `${nextWidth}x${nextHeight}:${tag}`;
            if (lastGuestResizeKeyRef.current !== guestKey) {
              lastGuestResizeKeyRef.current = guestKey;
              const webContentsId = typeof wv.getWebContentsId === 'function' ? wv.getWebContentsId() : null;
              if (webContentsId) {
                [0, 80, 220].forEach(delay => {
                  window.setTimeout(() => {
                    try {
                      void (window as any).api?.resizeBrowserGuest?.({
                        webContentsId,
                        width: nextWidth,
                        height: nextHeight,
                      });
                    } catch {}
                  }, delay);
                });
              }
            }
          }
        } catch {}
      }
      emitDebugLog('[cw-debug][browser-webview-size]', {
        tag,
        rootHeight,
        occupied,
        nextHeight,
        sizeChanged,
        shouldForceGuestResize,
        currentUrl: webviewDomReadyRef.current ? String(wv.getURL?.() || '') : '',
      });
    } catch (err: any) {
      emitDebugLog('[cw-debug][browser-webview-size-error]', { tag, error: String(err?.message || err || '') });
    }
  }, [emitDebugLog]);

  const syncWebviewHeight = embedded ? syncWebviewHeightEmbedded : syncWebviewHeightDefault;

  useEffect(() => {
    emitDebugLog('[cw-debug][browser-state]', {
      activeTabId,
      tabsLength: tabs.length,
      activeTabUrl: activeTab?.url || '',
      activeTargetSessionId,
      activeTargetPanelId,
    });
  }, [activeTabId, tabs.length, activeTab?.url, activeTargetSessionId, activeTargetPanelId]);

  useEffect(() => {
    const el = browserPaneRef.current;
    if (!el) return;
    const logSize = (tag: string) => {
      syncWebviewHeight(tag);
      const wv: any = webviewRef.current;
      const rect = el.getBoundingClientRect();
      const wrect = wv?.getBoundingClientRect?.();
      emitDebugLog('[cw-debug][browser-size]', tag, {
        pane: { clientWidth: el.clientWidth, clientHeight: el.clientHeight, rectW: Math.round(rect.width), rectH: Math.round(rect.height) },
        webview: wrect ? { width: Math.round(wrect.width), height: Math.round(wrect.height) } : null,
      });
    };
    logSize('mount');
    const ro = new ResizeObserver(() => logSize('resize'));
    ro.observe(el);
    if (embedded) {
      // embedded 는 wrap 이 flex 로 실제 가용 영역을 채우므로 직접 관찰 — 그리드/분할 리사이즈에 확실히 추종.
      const wrapEl = webviewWrapRef.current;
      if (wrapEl && wrapEl !== el) ro.observe(wrapEl);
    }
    const timer = window.setTimeout(() => logSize('delayed-200ms'), 200);
    return () => { ro.disconnect(); window.clearTimeout(timer); };
  }, [syncWebviewHeight]);

  // 언마운트(탭 닫힘) 시 활성 프록시/전용 백그라운드 SSH 연결 정리 — 누수 방지.
  const proxyStateRef = useRef(proxyState);
  useEffect(() => { proxyStateRef.current = proxyState; }, [proxyState]);
  useEffect(() => {
    return () => {
      const ps = proxyStateRef.current;
      if (!ps?.proxyId) return;
      if (ps.connId) { try { (window as any).api?.sshCloseDedicatedSocks?.({ proxyId: ps.proxyId, connId: ps.connId }); } catch {} }
      else { try { (window as any).api?.sshCloseSocksProxy?.({ proxyId: ps.proxyId }); } catch {} }
    };
  }, []);

  const currentProxyLabel = useMemo(() => {
    if (!activeTargetSessionId) return t('directConnect');
    const stored = storedSessions.find(s => s.id === activeTargetSessionId);
    const match = liveTargets.find(t => t.sessionId === activeTargetSessionId);
    const title = stored?.name?.trim() || match?.sessionName || match?.sessionId || activeTargetSessionId;
    return `${title}${match?.host ? ` (${match.host}${match.port && match.port !== 22 ? `:${match.port}` : ''})` : ''}`;
  }, [liveTargets, storedSessions, activeTargetSessionId]);

  const resolveBrowserUrlForSession = (sessionId: string) => {
    const storedUrl = storedSessions.find(s => s.id === sessionId)?.browserUrl?.trim();
    if (storedUrl) return storedUrl;
    const active = sshTargets.find(t => t.sessionId === sessionId) || connectedSessions.find(t => t.sessionId === sessionId);
    const activeUrl = active?.browserUrl?.trim();
    if (activeUrl) return activeUrl;
    return '';
  };

  // 직접연결 목록 = "브라우저 URL + SSH 점프"가 둘 다 설정된 세션만 (터미널 연결 여부 무관).
  // 선택 시 항상 백그라운드 점프 SSH 연결을 직접 수립해 그 위로 SOCKS 프록시.
  const browserJumpTargets = useMemo(() =>
    storedSessions.filter(s => !!s.id && s.hasJumps && (s.browserUrl || '').trim()),
  [storedSessions]);

  const getBrowserSiteKey = (url: string) => {
    try {
      const raw = String(url || '').trim();
      if (!raw) return '';
      const resolved = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
      const u = new URL(resolved);
      let host = u.hostname.toLowerCase();
      if (u.port && u.port !== '80' && u.port !== '443') host = `${host}:${u.port}`;
      return host;
    } catch {
      return '';
    }
  };

  const updateActiveTabTargetState = useCallback((targetSessionId: string, targetPanelId: string = '') => {
    setTabs(prev => prev.map(t => (
      t.id === activeTabId
        ? { ...t, targetSessionId, targetPanelId }
        : t
    )));
  }, [activeTabId]);

  const addRecentUrl = (value: string) => {
    const next = value.trim();
    if (!next) return;
    setRecentUrls(prev => {
      const filtered = prev.filter(v => v !== next);
      return [next, ...filtered].slice(0, 20);
    });
  };

  const normalizeUrlForCompare = (url: string) => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}${u.pathname}${u.search}${u.hash}`;
    } catch {
      return url.trim();
    }
  };

  const refreshSshTargets = async () => {
    try {
      const list = await (window as any).api?.sshListActiveSessions?.();
      if (Array.isArray(list)) setSshTargets(list);
    } catch {}
    try {
      const data = await (window as any).api?.listSessions?.();
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      setStoredSessions(sessions.map((s: any) => ({
        id: String(s.id || ''),
        name: s.name,
        browserUrl: s.browserUrl,
        host: s.host,
        port: s.port,
        hasJumps: Array.isArray(s.jumps) && s.jumps.some((j: any) => j && typeof j.host === 'string' && j.host.trim()),
      })));
    } catch {}
  };

  useEffect(() => {
    refreshSshTargets();
    const timer = window.setInterval(refreshSshTargets, 4000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const cur = tabs.find(t => t.id === activeTabId);
    if (!cur) return;
    setEditUrl(cur.url || '');
    void loadBrowserCredentialsForUrl(cur.url || '');
  }, [activeTabId, tabs]);

  useEffect(() => {
    if (!activeTargetSessionId) return;
    updateActiveTabTargetState(activeTargetSessionId, '');
    // 이미 같은 세션으로 전용 프록시가 떠 있으면 재오픈 안 함 (4초 폴링 재실행 방지)
    if (proxyState?.connId && proxyState?.sessionId === activeTargetSessionId) return;
    void applyDedicatedProxy(activeTargetSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTargetSessionId, proxyState?.connId, proxyState?.sessionId]);

  useEffect(() => {
    if (activeTargetSessionId) return;
    if (!proxyState && !activeTargetPanelId) return;
    updateActiveTabTargetState('', '');
    void clearProxy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTargetSessionId]);

  const clearProxy = async () => {
    const cur = proxyState;
    proxySeqRef.current += 1;
    setProxyBusy(true);
    try {
      if (cur?.proxyId) {
        if (cur.connId) {
          // 전용(백그라운드) 연결 — 프록시 + 점프 SSH 연결 모두 정리
          try { await (window as any).api?.sshCloseDedicatedSocks?.({ proxyId: cur.proxyId, connId: cur.connId }); } catch {}
        } else {
          try { await (window as any).api?.sshCloseSocksProxy?.({ proxyId: cur.proxyId }); } catch {}
        }
      }
      const wv: any = webviewRef.current;
      const webContentsId = typeof wv?.getWebContentsId === 'function' ? wv.getWebContentsId() : null;
      if (webContentsId) {
        try { await (window as any).api?.setWebviewProxy?.({ webContentsId, proxyRules: null }); } catch {}
      }
      setProxyState(null);
      setTestResult('');
    } finally {
      setProxyBusy(false);
    }
  };

  const applyProxyForPanel = async (panelId: string) => {
    const seq = ++proxySeqRef.current;
    setProxyBusy(true);
    try {
      const wv: any = webviewRef.current;
      const webContentsId = typeof wv?.getWebContentsId === 'function' ? wv.getWebContentsId() : null;
      if (!webContentsId) return;

      if (!panelId) {
        await clearProxy();
        return;
      }

      if (proxyState?.panelId === panelId) return;

      if (proxyState?.proxyId) {
        try { await (window as any).api?.sshCloseSocksProxy?.({ proxyId: proxyState.proxyId }); } catch {}
      }
      const r: any = await (window as any).api?.sshOpenSocksProxy?.({ panelId });
      if (seq !== proxySeqRef.current) return;
      if (!r?.success || !r?.proxyId) {
        updateActiveTabTargetState(activeTargetSessionId, '');
        setTestOk(false);
        setTestResult(t('proxyOpenFailed', { reason: r?.error || t('proxyForwardingBlocked') }));
        setProxyState(null);
        return;
      }
      emitDebugLog('[cw-debug][browser-proxy-panel]', { panelId, localPort: r.localPort, webContentsId });
      // bypass 비움 → 원격지 기준 127.0.0.1/localhost 도 SOCKS(점프 SSH) 를 타게 함
      await (window as any).api?.setWebviewProxy?.({ webContentsId, proxyRules: `socks5://127.0.0.1:${r.localPort}`, proxyBypassRules: '' });
      if (seq !== proxySeqRef.current) return;
      setProxyState({ proxyId: r.proxyId, localPort: r.localPort, panelId });
      const savedBrowserUrl = resolveBrowserUrlForSession(
        liveTargets.find(t => t.panelId === panelId)?.sessionId || '',
      );
      if (savedBrowserUrl) {
        setEditUrl(savedBrowserUrl);
      }
      const currentUrl = (() => {
        try {
          return savedBrowserUrl
            ? resolveBrowserUrl(savedBrowserUrl)
            : (wv?.getURL?.() || initialSrcRef.current || '');
        } catch {
          return savedBrowserUrl ? resolveBrowserUrl(savedBrowserUrl) : (initialSrcRef.current || '');
        }
      })();
      if (currentUrl) {
        window.setTimeout(() => {
          if (seq !== proxySeqRef.current) return;
          try {
            wv?.loadURL?.(currentUrl).catch((err: any) => {
              const msg = String(err?.message || err || '');
              if (!/aborted/i.test(msg)) {
                setTestOk(false);
                setTestResult(t('browserLoadFailed', { msg }));
              }
            });
          } catch {}
        }, 150);
      }
    } finally {
      if (seq === proxySeqRef.current) setProxyBusy(false);
    }
  };

  // 활성 터미널 없이 세션의 점프 체인으로 백그라운드 SSH 연결을 수립하고 그 위로 SOCKS5 프록시 적용.
  const applyDedicatedProxy = async (sessionId: string) => {
    const seq = ++proxySeqRef.current;
    setProxyBusy(true);
    try {
      const wv: any = webviewRef.current;
      const webContentsId = typeof wv?.getWebContentsId === 'function' ? wv.getWebContentsId() : null;
      if (!webContentsId) return;
      // 기존 프록시 정리 (전용/일반 구분)
      if (proxyState?.proxyId) {
        if (proxyState.connId) { try { await (window as any).api?.sshCloseDedicatedSocks?.({ proxyId: proxyState.proxyId, connId: proxyState.connId }); } catch {} }
        else { try { await (window as any).api?.sshCloseSocksProxy?.({ proxyId: proxyState.proxyId }); } catch {} }
      }
      const r: any = await (window as any).api?.sshOpenDedicatedSocks?.({ sessionId });
      if (seq !== proxySeqRef.current) return;
      if (!r?.success || !r?.proxyId) {
        updateActiveTabTargetState('', '');
        setTestOk(false);
        setTestResult(t('proxyOpenFailed', { reason: r?.error || t('proxyForwardingBlocked') }));
        setProxyState(null);
        return;
      }
      emitDebugLog('[cw-debug][browser-proxy-dedicated]', { sessionId, localPort: r.localPort, connId: r.connId, webContentsId });
      // bypass 비움 → 원격지 기준 127.0.0.1/localhost 도 SOCKS(점프 SSH) 를 타게 함
      await (window as any).api?.setWebviewProxy?.({ webContentsId, proxyRules: `socks5://127.0.0.1:${r.localPort}`, proxyBypassRules: '' });
      if (seq !== proxySeqRef.current) return;
      setProxyState({ proxyId: r.proxyId, localPort: r.localPort, panelId: '', connId: r.connId, sessionId });
      const savedBrowserUrl = resolveBrowserUrlForSession(sessionId);
      if (savedBrowserUrl) setEditUrl(savedBrowserUrl);
      const loadUrl = savedBrowserUrl ? resolveBrowserUrl(savedBrowserUrl) : '';
      if (loadUrl) {
        window.setTimeout(() => {
          if (seq !== proxySeqRef.current) return;
          try {
            wv?.loadURL?.(loadUrl).catch((err: any) => {
              const msg = String(err?.message || err || '');
              if (!/aborted/i.test(msg)) { setTestOk(false); setTestResult(t('browserLoadFailed', { msg })); }
            });
          } catch {}
        }, 150);
      }
    } finally {
      if (seq === proxySeqRef.current) setProxyBusy(false);
    }
  };

  useEffect(() => {
    if (!activeTargetPanelId) return;
    applyProxyForPanel(activeTargetPanelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTargetPanelId]);

  useEffect(() => {
    if (!proxyState) return;
    if (proxyState.connId) return; // 전용(백그라운드) 연결은 활성 패널 목록과 무관 — 유지
    const cur = liveTargets.find(t => t.panelId === proxyState.panelId);
    if (cur) return;
    clearProxy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTargets]);

  useEffect(() => {
    if (!activeTargetSessionId) return;
    const browserUrl = resolveBrowserUrlForSession(activeTargetSessionId);
    if (!browserUrl) return;
    const current = (() => {
      try { return webviewRef.current?.getURL?.() || ''; } catch { return ''; }
    })();
    const normalizedCurrent = current ? normalizeUrlForCompare(current) : '';
    const normalizedTarget = normalizeUrlForCompare(resolveBrowserUrl(browserUrl));
    if (!normalizedTarget || normalizedTarget === lastAutoLoadedRef.current) return;
    if (normalizedCurrent === normalizedTarget) {
      lastAutoLoadedRef.current = normalizedTarget;
      return;
    }
    lastAutoLoadedRef.current = normalizedTarget;
    const timer = window.setTimeout(() => {
      if (!activeTargetPanelId) return;
      try { webviewRef.current?.loadURL?.(resolveBrowserUrl(browserUrl)).catch(() => {}); } catch {}
    }, 100);
    emitDebugLog('[cw-debug][browser-auto-load]', {
      activeTabId,
      tabsLength: tabs.length,
      activeTargetSessionId,
      activeTargetPanelId,
      browserUrl,
      normalizedTarget,
      normalizedCurrent,
    });
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedSessions, liveTargets, activeTargetSessionId]);

  useEffect(() => {
    const wv: any = webviewRef.current;
    if (!wv) return;
    const prevOnReady = wv.__pepeOnReadyHandler;
    if (prevOnReady) {
      try { wv.removeEventListener('dom-ready', prevOnReady); } catch {}
    }
    const onReady = () => {
      webviewDomReadyRef.current = true;
      lastGuestResizeKeyRef.current = '';
      const currentTargetPanelId = activeTargetPanelIdRef.current;
      if (currentTargetPanelId) void applyProxyForPanel(currentTargetPanelId);
      void forceBrowserLightTheme();
      try { wv.setZoomFactor?.(zoomRef.current); } catch {}
      syncWebviewHeight('dom-ready');
      window.setTimeout(() => syncWebviewHeight('dom-ready-late'), 60);
    };
    wv.__pepeOnReadyHandler = onReady;
    wv.addEventListener('dom-ready', onReady);
    return () => {
      try { wv.removeEventListener('dom-ready', onReady); } catch {}
      webviewDomReadyRef.current = false;
      if (wv.__pepeOnReadyHandler === onReady) {
        try { delete wv.__pepeOnReadyHandler; } catch {}
      }
    };
  }, [syncWebviewHeight]);

  // activeTab 변경 시 그 탭의 URL 로 로드 — 기존 webview 재사용.
  const lastLoadedTabRef = useRef<string>(activeTabId);
  useEffect(() => {
    if (activeTabId === lastLoadedTabRef.current) return;
    lastLoadedTabRef.current = activeTabId;
    const wv: any = webviewRef.current;
    if (!wv) return;
    const url = activeTab.url;
    if (!url) return;
    setEditUrl(url);
    try { wv.loadURL(resolveBrowserUrl(url)).catch(() => {}); } catch {}
    syncWebviewHeight('active-tab-changed');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, syncWebviewHeight]);
  useEffect(() => {
    const wv: any = webviewRef.current;
    if (!wv) return;
    const prevHandlers = wv.__pepeLifecycleHandlers;
    if (prevHandlers) {
      try { wv.removeEventListener('did-navigate', prevHandlers.onNav); } catch {}
      try { wv.removeEventListener('did-navigate-in-page', prevHandlers.onNav); } catch {}
      try { wv.removeEventListener('did-start-loading', prevHandlers.onStart); } catch {}
      try { wv.removeEventListener('did-stop-loading', prevHandlers.onStop); } catch {}
      try { wv.removeEventListener('page-title-updated', prevHandlers.onTitle); } catch {}
      try { wv.removeEventListener('did-fail-load', prevHandlers.onFail); } catch {}
      try { wv.removeEventListener('new-window', prevHandlers.onNewWindow); } catch {}
      try { prevHandlers.offBrowserNewWindow?.(); } catch {}
    }
    const onNav = () => {
      try {
        const u = wv.getURL();
        setEditUrl(u);
        setTabUrl(activeTabIdRef.current, u);
        void loadBrowserCredentialsForUrl(u);
      } catch {}
      void forceBrowserLightTheme();
      try { wv.setZoomFactor?.(zoomRef.current); } catch {}
      try { setCanBack(wv.canGoBack()); setCanFwd(wv.canGoForward()); } catch {}
    };
    const onStart = () => setLoading(true);
    const onStop = () => {
      setLoading(false);
      onNav();
      try { wv.setZoomFactor?.(zoomRef.current); } catch {}
      syncWebviewHeight('did-stop-loading');
      try {
        const url = String(wv.getURL?.() || '');
        Promise.resolve(wv.executeJavaScript?.(`
          (() => {
            try {
              const body = document.body;
              const docEl = document.documentElement;
              return {
                bodyScrollHeight: body ? body.scrollHeight : 0,
                bodyOffsetHeight: body ? body.offsetHeight : 0,
                docScrollHeight: docEl ? docEl.scrollHeight : 0,
                docOffsetHeight: docEl ? docEl.offsetHeight : 0,
                innerHeight: window.innerHeight || 0,
                innerWidth: window.innerWidth || 0,
              };
            } catch {
              return { bodyScrollHeight: 0, bodyOffsetHeight: 0, docScrollHeight: 0, docOffsetHeight: 0, innerHeight: 0, innerWidth: 0 };
            }
          })();
        `, true)).then((doc: any) => {
          const innerHeight = Number(doc?.innerHeight || 0);
          const expectedHeight = Math.max(0, lastExpectedHeightRef.current || 0);
          const shouldRecoverViewport =
            expectedHeight >= 240 &&
            innerHeight > 0 &&
            innerHeight < Math.floor(expectedHeight * 0.5) &&
            recoveryAttemptRef.current < 2 &&
            (Date.now() - lastRecoveryAtRef.current) > 800;
          if (shouldRecoverViewport) {
            recoveryAttemptRef.current += 1;
            lastRecoveryAtRef.current = Date.now();
            webviewDomReadyRef.current = false;
            lastGuestResizeKeyRef.current = '';
            lastAppliedWebviewHeightRef.current = -1;
            window.setTimeout(() => setWebviewNonce(prev => prev + 1), 0);
          }
          emitDebugLog('[cw-debug][browser-stop-loading]', {
            activeTabId: activeTabIdRef.current,
            tabsLength: tabsRef.current.length,
            url,
            doc,
            expectedHeight,
            shouldRecoverViewport,
            recoveryAttempt: recoveryAttemptRef.current,
          });
        }).catch((err: any) => {
          emitDebugLog('[cw-debug][browser-stop-loading-error]', {
            activeTabId: activeTabIdRef.current,
            tabsLength: tabsRef.current.length,
            url,
            error: String(err?.message || err || ''),
          });
        });
      } catch (err: any) {
        emitDebugLog('[cw-debug][browser-stop-loading-error]', {
          activeTabId: activeTabIdRef.current,
          tabsLength: tabsRef.current.length,
          url: '',
          error: String(err?.message || err || ''),
        });
      }
    };
    const onTitle = (e: any) => {
      onTitleChangeRef.current?.(e.title || '');
      setTabTitle(activeTabIdRef.current, e.title || '');
    };
    // 링크 클릭이 새 창을 요청하면 새 탭으로 열기.
    // Electron 25+ 에서 <webview> 의 new-window preventDefault 가 무시되므로
    // main process 의 setWindowOpenHandler 가 URL 을 IPC 로 전달 → 여기서 새 탭으로.
    const onNewWindow = (e: any) => {
      try { e.preventDefault?.(); } catch {}
      const url = String(e?.url || '');
      if (url) openInNewTab(url);
    };
    const offBrowserNewWindow = (window as any).api?.onBrowserWebviewNewWindow?.((p: { guestId: number; url: string }) => {
      if (!p?.url) return;
      let currentGuestId: number | undefined;
      try { currentGuestId = wv.getWebContentsId?.(); } catch {}
      // guestId 매칭 — 다른 브라우저 워크스페이스 인스턴스와 충돌 방지.
      if (currentGuestId != null && p.guestId !== currentGuestId) return;
      openInNewTab(p.url);
    });
    const onFail = (e: any) => {
      if (e?.isMainFrame === false) return;
      if (e?.errorCode === -3) return;
      const msg = String(e?.errorCode || e?.type || '');
      const url = String(e?.url || '');
      if (msg || url) {
        setTestOk(false);
        setTestResult(t('browserLoadFailedUrl', { msg, url: url ? ` (${url})` : '' }));
      }
    };
    wv.__pepeLifecycleHandlers = { onNav, onStart, onStop, onTitle, onFail, onNewWindow, offBrowserNewWindow };
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('page-title-updated', onTitle);
    wv.addEventListener('did-fail-load', onFail);
    wv.addEventListener('new-window', onNewWindow);
    return () => {
      try {
        wv.removeEventListener('did-navigate', onNav);
        wv.removeEventListener('did-navigate-in-page', onNav);
        wv.removeEventListener('did-start-loading', onStart);
        wv.removeEventListener('did-stop-loading', onStop);
        wv.removeEventListener('page-title-updated', onTitle);
        wv.removeEventListener('did-fail-load', onFail);
        wv.removeEventListener('new-window', onNewWindow);
      } catch {}
      try { offBrowserNewWindow?.(); } catch {}
      if (wv.__pepeLifecycleHandlers?.onStop === onStop) {
        try { delete wv.__pepeLifecycleHandlers; } catch {}
      }
    };
  }, [emitDebugLog, syncWebviewHeight]);

  const resolveBrowserUrl = (target: string) => {
    let t = target.trim();
    if (!t) return '';
    // 이미 스킴 있는 URL 은 그대로 (about:blank, chrome://, file://, data:, mailto: 등 포함)
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
    // 스킴 없음 — 검색어(공백/점 없음) 이면 구글, 그 외엔 https:// 프리픽스
    if (!t.includes('.') && !t.includes(':')) {
      t = 'https://www.google.com/search?q=' + encodeURIComponent(t);
    } else {
      t = 'https://' + t;
    }
    return t;
  };

  const forceBrowserLightTheme = async () => {
    const wv: any = webviewRef.current;
    if (!wv) return;
    const css = `
      :root,
      html,
      body {
        background: #fff !important;
        color-scheme: light !important;
        min-height: 100vh !important;
      }
      body {
        height: auto !important;
        -webkit-text-fill-color: initial !important;
      }
    `;
    try { await wv.insertCSS(css); } catch {}
    try {
      await wv.executeJavaScript(`
        (function() {
          try { document.documentElement.style.colorScheme = 'light'; } catch {}
          try { document.documentElement.style.background = '#fff'; } catch {}
          try { document.documentElement.style.minHeight = '100vh'; } catch {}
          try { document.body && (document.body.style.background = '#fff'); } catch {}
          try { document.body && (document.body.style.minHeight = '100vh'); } catch {}
          try { document.body && (document.body.style.height = 'auto'); } catch {}
        })();
      `, true);
    } catch {}
  };

  const installBrowserCredentialHooks = async (url: string, username: string, password: string, siteKey: string) => {
    const wv: any = webviewRef.current;
    if (!wv || !siteKey) return;
    const seq = ++credSyncSeqRef.current;
    const script = `
      (() => {
        const cred = ${JSON.stringify({ username, password, siteKey, sourceUrl: url })};
        const currentSiteKey = String(cred.siteKey || '').toLowerCase();
        const prefix = '__PEPE_BROWSER_CRED__:';
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        const setValue = (el, value) => {
          if (!el) return false;
          try {
            if (valueSetter) valueSetter.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          } catch { return false; }
        };
        const isTextLike = (el) => {
          const type = String(el?.type || '').toLowerCase();
          return ['text', 'email', 'tel', 'search', 'url', 'username'].includes(type);
        };
        const isPassLike = (el) => String(el?.type || '').toLowerCase() === 'password';
        const scoreText = (el) => {
          const meta = [el.name, el.id, el.placeholder, el.autocomplete, el.className].filter(Boolean).join(' ').toLowerCase();
          let score = 0;
          if (isTextLike(el)) score += 2;
          if (/user|login|email|id|account|name/.test(meta)) score += 4;
          if (/password|pass|pwd/.test(meta)) score -= 4;
          return score;
        };
        const scorePass = (el) => {
          const meta = [el.name, el.id, el.placeholder, el.autocomplete, el.className].filter(Boolean).join(' ').toLowerCase();
          let score = 0;
          if (isPassLike(el)) score += 8;
          if (/pass|pwd|password/.test(meta)) score += 4;
          if (/confirm/.test(meta)) score -= 2;
          return score;
        };
        const getInputs = () => Array.from(document.querySelectorAll('input')).filter((el) => !el.disabled && !el.readOnly);
        const pickBest = (inputs, scorer) => inputs.slice().sort((a, b) => scorer(b) - scorer(a))[0] || null;
        const fill = () => {
          const inputs = getInputs();
          const user = pickBest(inputs, scoreText);
          const pass = pickBest(inputs, scorePass);
          if (cred.username && user && !String(user.value || '').trim()) setValue(user, cred.username);
          if (cred.password && pass && !String(pass.value || '').trim()) setValue(pass, cred.password);
        };
        const capture = () => {
          const inputs = getInputs();
          const pass = pickBest(inputs, scorePass);
          if (!pass || !String(pass.value || '').trim()) return;
          const form = pass.form || pass.closest('form');
          const textInputs = form ? Array.from(form.querySelectorAll('input')) : inputs;
          const user = pickBest(textInputs.filter((el) => el !== pass), scoreText);
          const username = user ? String(user.value || '').trim() : '';
          const password = String(pass.value || '');
          if (!password) return;
          console.log(prefix + JSON.stringify({ url: location.href, siteKey: currentSiteKey, username, password }));
        };
        if (!window.__pepeBrowserCredHooked) {
          window.__pepeBrowserCredHooked = true;
          document.addEventListener('focusin', (e) => {
            const el = e.target;
            if (!(el instanceof HTMLInputElement)) return;
            if (!isTextLike(el) && !isPassLike(el)) return;
            fill();
          }, true);
          document.addEventListener('submit', () => setTimeout(capture, 0), true);
          document.addEventListener('keydown', (e) => {
            const el = e.target;
            if (!(el instanceof HTMLInputElement)) return;
            if (e.key === 'Enter' && isPassLike(el)) setTimeout(capture, 0);
          }, true);
          const mo = new MutationObserver(() => fill());
          mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
          window.addEventListener('beforeunload', () => { try { mo.disconnect(); } catch {} }, { once: true });
        }
        fill();
        return true;
      })();
    `;
    try {
      if (seq !== credSyncSeqRef.current) return;
      await wv.executeJavaScript(script, true);
      await forceBrowserLightTheme();
    } catch {}
  };

  const loadBrowserCredentialsForUrl = async (url: string) => {
    const target = getBrowserSiteKey(url);
    if (!target || !(window as any).api?.browserCredGet) return;
    let username = '';
    let password = '';
    let siteKey = target;
    try {
      const r: any = await (window as any).api.browserCredGet({ url });
      if (r?.ok && r?.found) {
        username = r.username || '';
        password = r.password || '';
        siteKey = r.siteKey || target;
      }
    } catch {}
    await installBrowserCredentialHooks(url, username, password, siteKey);
  };

  const go = async (target: string) => {
    const goUrl = resolveBrowserUrl(target);
    if (!goUrl) return;
    addRecentUrl(target);
    setTestResult('');
    if (!activeTargetSessionId) {
      await clearProxy();
    }
    try {
      await webviewRef.current?.loadURL(goUrl);
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (!/aborted/i.test(msg)) {
        setTestOk(false);
        setTestResult(t('browserLoadFailed', { msg }));
      }
    }
  };

  const runTargetTest = async () => {
    setTestResult('');
    if (!activeTargetSessionId) {
      setTestOk(false);
      setTestResult(t('testSelectSessionFirst'));
      return;
    }
    const targetUrl = resolveBrowserUrl(editUrl || resolveBrowserUrlForSession(activeTargetSessionId));
    if (!targetUrl) {
      setTestOk(false);
      setTestResult(t('testUrlEmpty'));
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      setTestOk(false);
      setTestResult(t('testUrlInvalid'));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setTestOk(false);
      setTestResult(t('testHttpOnly'));
      return;
    }
    setTestBusy(true);
    try {
      const testPanelId = activeTargetPanelId
        || (liveTargets.find(t => t.sessionId === activeTargetSessionId)?.panelId || '')
        || (proxyState?.sessionId === activeTargetSessionId ? (proxyState?.connId || '') : '');
      const r: any = await (window as any).api?.sshTestWebTarget?.({ panelId: testPanelId, url: targetUrl });
      if (!r?.success) {
        setTestOk(false);
        setTestResult(t('testFailed', { reason: r?.error || t('unknownError') }));
        return;
      }
      const res = r.result || {};
      const code = typeof res.statusCode === 'number' ? ` status=${res.statusCode}` : '';
      const line = res.statusLine ? ` (${res.statusLine})` : '';
      const proto = (res.protocol || parsed.protocol).replace(/:$/, '');
      const via = res.mode === 'exec' ? t('remoteExec') : '';
      const detail = `${proto}://${res.host || parsed.hostname}:${res.port || (parsed.protocol === 'https:' ? 443 : 80)}${res.path || parsed.pathname}${code}${line} / ${res.elapsedMs ?? '?'}ms`;
      setTestOk(true);
      setTestResult(t('testSuccess', { via, detail }));
    } catch (e: any) {
      setTestOk(false);
      setTestResult(t('testFailed', { reason: String(e?.message || e) }));
    } finally {
      setTestBusy(false);
    }
  };

  // 줌 — webview.setZoomFactor 로 페이지 스케일 조정. 0.25 ~ 5.0 범위.
  const applyZoom = (z: number) => {
    const clamped = Math.max(0.25, Math.min(5.0, +z.toFixed(2)));
    setZoom(clamped);
    try { webviewRef.current?.setZoomFactor?.(clamped); } catch {}
  };
  const zoomIn = () => applyZoom(zoom + 0.1);
  const zoomOut = () => applyZoom(zoom - 0.1);
  const zoomReset = () => applyZoom(1.0);

  // 페이지 로드 / 네비게이션 후 zoom factor 가 리셋되므로 다시 적용
  // Ctrl/Cmd + (+/-/0) 단축키 + Ctrl/Cmd + 휠 줌 — webview 외부에서 입력 받을 때만 동작.
  // webview 내부에서 받은 휠/키는 페이지가 자체 처리하므로 별도 처리 필요.
  // → webview 의 'before-input-event' 로 Ctrl+= / Ctrl+- 가로채서 줌 변경.
  useEffect(() => {
    const wv: any = webviewRef.current;
    if (!wv) return;
    const prevZoomHandlers = wv.__pepeZoomHandlers;
    if (prevZoomHandlers) {
      try { wv.removeEventListener('before-input-event', prevZoomHandlers.onInput); } catch {}
      try { wv.removeEventListener('dom-ready', prevZoomHandlers.injectWheelZoom); } catch {}
      try { wv.removeEventListener('did-navigate', prevZoomHandlers.injectWheelZoom); } catch {}
      try { wv.removeEventListener('console-message', prevZoomHandlers.onConsole); } catch {}
    }
    const onInput = (e: any) => {
      if (e.type !== 'keyDown') return;
      const ctrl = e.control || e.meta;
      if (!ctrl) return;
      if (e.key === '=' || e.key === '+') { applyZoom(zoom + 0.1); e.preventDefault?.(); }
      else if (e.key === '-' || e.key === '_') { applyZoom(zoom - 0.1); e.preventDefault?.(); }
      else if (e.key === '0') { applyZoom(1.0); e.preventDefault?.(); }
    };
    // Ctrl+휠 줌 — webview 내부 페이지가 wheel 을 소비하므로 페이지에 리스너 주입.
    // preload 없이도 동작하도록 console-message 채널 사용 (console.log → host 수신).
    const injectWheelZoom = () => {
      try {
        wv.executeJavaScript(`
          if (!window.__pepeWheelZoomInjected) {
            window.__pepeWheelZoomInjected = true;
            document.addEventListener('wheel', function(e) {
              if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                console.log('__PEPE_ZOOM__:' + (e.deltaY < 0 ? '+' : '-'));
              }
            }, { passive: false, capture: true });
          }
        `);
      } catch {}
    };
    const onConsole = (e: any) => {
      const m = String(e?.message || '');
      if (m.startsWith('__PEPE_ZOOM__:')) {
        const dir = m.substring(14);
        applyZoom(zoom + (dir === '+' ? 0.1 : -0.1));
        return;
      }
      if (m.startsWith('__PEPE_BROWSER_CRED__:')) {
        const payloadStr = m.slice('__PEPE_BROWSER_CRED__:'.length);
        try {
          const data = JSON.parse(payloadStr);
          const siteKey = String(data?.siteKey || '').trim();
          const username = String(data?.username || '').trim();
          const password = String(data?.password || '');
          if (siteKey && password && (window as any).api?.browserCredSave) {
            void (window as any).api.browserCredSave({ siteKey, url: String(data?.url || ''), username, password });
          }
        } catch {}
      }
    };
    wv.__pepeZoomHandlers = { onInput, injectWheelZoom, onConsole };
    try { wv.addEventListener('before-input-event', onInput); } catch {}
    try { wv.addEventListener('dom-ready', injectWheelZoom); } catch {}
    try { wv.addEventListener('did-navigate', injectWheelZoom); } catch {}
    try { wv.addEventListener('console-message', onConsole); } catch {}
    return () => {
      try { wv.removeEventListener('before-input-event', onInput); } catch {}
      try { wv.removeEventListener('dom-ready', injectWheelZoom); } catch {}
      try { wv.removeEventListener('did-navigate', injectWheelZoom); } catch {}
      try { wv.removeEventListener('console-message', onConsole); } catch {}
      if (wv.__pepeZoomHandlers?.onInput === onInput) {
        try { delete wv.__pepeZoomHandlers; } catch {}
      }
    };
  }, [zoom]);

  return (
    <div ref={browserPaneRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, height: '100%', background: '#1a1a1a', overflow: 'hidden' }}>
      {/* 탭 바 — 링크가 새 창을 요청하면 새 탭으로 열림. + 로 빈 탭 추가. */}
      <div style={{ display: 'flex', alignItems: 'stretch', background: '#1e1e1e', borderBottom: '1px solid #333', overflowX: 'auto', minHeight: 28 }}>
        {tabs.map(tab => {
          const isActive = tab.id === activeTabId;
          const label = (tab.title || tab.url || '새 탭').slice(0, 32);
          return (
            <div key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              onAuxClick={e => { if (e.button === 1) closeTab(tab.id); }}
              title={tab.url}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
                fontSize: 11, color: isActive ? '#ddd' : '#888',
                background: isActive ? '#2a2a2a' : 'transparent',
                borderRight: '1px solid #333', cursor: 'pointer', maxWidth: 220, minWidth: 80,
                borderTop: isActive ? '2px solid #0e639c' : '2px solid transparent',
              }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
              {tabs.length > 1 && (
                <span onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                  style={{ color: '#888', padding: '0 4px', borderRadius: 2, cursor: 'pointer' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#444')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>×</span>
              )}
            </div>
          );
        })}
        <button onClick={() => openInNewTab('about:blank')}
          title="새 탭"
          style={{ background: 'transparent', color: '#888', border: 'none', padding: '0 12px', cursor: 'pointer', fontSize: 14 }}>+</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', background: '#222', borderBottom: '1px solid #333', flexWrap: 'wrap' }}>
        <button className="panel-btn" disabled={!canBack} onClick={() => webviewRef.current?.goBack()} title={t('back')}>◀</button>
        <button className="panel-btn" disabled={!canFwd} onClick={() => webviewRef.current?.goForward()} title={t('forward')}>▶</button>
        <button className="panel-btn" onClick={() => loading ? webviewRef.current?.stop() : webviewRef.current?.reload()} title={loading ? t('stop') : t('refresh')}>{loading ? '✕' : '⟳'}</button>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <input
            type="text"
            value={editUrl}
            onFocus={() => {
              if (urlHistoryHideTimerRef.current) window.clearTimeout(urlHistoryHideTimerRef.current);
              setShowUrlHistory(true);
            }}
            onBlur={() => {
              urlHistoryHideTimerRef.current = window.setTimeout(() => setShowUrlHistory(false), 120);
            }}
            onChange={e => setEditUrl(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                setShowUrlHistory(false);
                go(editUrl);
              }
            }}
            spellCheck={false}
            style={{ width: '100%', padding: '4px 8px', background: '#111', border: '1px solid #333', borderRadius: 3, color: '#ddd', fontSize: 12, boxSizing: 'border-box' }}
            placeholder={t('urlPlaceholder')}
          />
          {showUrlHistory && recentUrls.length > 0 && (
            <div style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 'calc(100% + 4px)',
              background: '#151515',
              border: '1px solid #3a3a3a',
              borderRadius: 4,
              boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
              zIndex: 80,
              maxHeight: 220,
              overflowY: 'auto',
            }}>
              {recentUrls.map(url => (
                <div
                  key={url}
                  onMouseDown={e => {
                    e.preventDefault();
                    if (urlHistoryHideTimerRef.current) window.clearTimeout(urlHistoryHideTimerRef.current);
                    setEditUrl(url);
                    setShowUrlHistory(false);
                    go(url);
                  }}
                  title={url}
                  style={{
                    padding: '6px 10px',
                    color: '#ddd',
                    fontSize: 12,
                    cursor: 'pointer',
                    borderBottom: '1px solid #262626',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#242424'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {url}
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="panel-btn" onClick={() => go(editUrl)} title={t('go')}>↵</button>
        <div style={{ width: 1, height: 18, background: '#333', margin: '0 2px' }} />
        <button className="panel-btn" onClick={zoomOut} title={t('zoomOut')}>−</button>
        <button className="panel-btn" onClick={zoomReset} title={t('zoomReset')} style={{ minWidth: 42, fontSize: 11 }}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="panel-btn" onClick={zoomIn} title={t('zoomIn')}>+</button>
        <div style={{ width: 1, height: 18, background: '#333', margin: '0 2px' }} />
        <button className="panel-btn" onClick={() => { try { webviewRef.current?.openDevTools(); } catch {} }} title={t('devTools')}>{'<>'}</button>
        <button className="panel-btn" onClick={runTargetTest} disabled={testBusy} title={t('testTooltip')}>{t('test')}</button>
        <div style={{ width: 1, height: 18, background: '#333', margin: '0 2px' }} />
        <select
          value={activeTargetSessionId}
          onChange={e => {
            const sid = e.target.value;
            updateActiveTabTargetState(sid, '');
            if (!sid) {
              void clearProxy();
            }
          }}
          disabled={proxyBusy}
          style={{ minWidth: 260, maxWidth: 420, padding: '4px 8px', background: '#111', border: '1px solid #333', borderRadius: 3, color: '#ddd', fontSize: 12 }}
          title={t('proxySelectTooltip')}
        >
          <option value="">{t('directConnect')}</option>
          {browserJumpTargets.map(s => (
            <option key={s.id} value={s.id}>
              {(s.name?.trim() || s.id)}
              {s.host ? ` (${s.host}${s.port && s.port !== 22 ? `:${s.port}` : ''})` : ''}
              {s.browserUrl ? ` ⤳ ${s.browserUrl}` : ''}
            </option>
          ))}
        </select>
        <span style={{ color: '#9aa3ad', fontSize: 12, marginLeft: 2 }} title={proxyState ? `SOCKS5 127.0.0.1:${proxyState.localPort}` : t('directConnect')}>
          {proxyBusy ? t('proxyApplying') : currentProxyLabel}
        </span>
      </div>
      {testResult ? (
        <div style={{ padding: '4px 10px 0', color: testOk ? '#86efac' : '#fda4af', fontSize: 12, lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
          {testResult}
        </div>
      ) : null}
      <div ref={webviewWrapRef} style={{ position: 'relative', flex: '1 1 auto', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
        {/* @ts-ignore — webview 는 React 표준 element 가 아니지만 Electron 환경에서 동작 */}
        <webview
          key={`browser-webview-${webviewNonce}`}
          ref={webviewRef as any}
          src={initialSrcRef.current}
          partition={partitionName as any}
          // embedded(커스텀 워크스페이스)만 display:flex — block/inline-block 이면 내부 게스트(object)가
          // 세로로 늘어나지 않고 크롭돼 렌더된다 (Electron 공식 문서/이슈에 명시된 동작). 일반 탭은
          // 기존 동작 그대로 block 유지.
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', minHeight: 0, display: embedded ? 'flex' : 'block' } as any}
          allowpopups={'true' as any}
        />
      </div>
    </div>
  );
};
