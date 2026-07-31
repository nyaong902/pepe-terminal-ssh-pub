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
  // 기본은 매번 독립 세션을 쓰되, 특수 워크스페이스는 안정적인 session partition 을 공유할 수 있게 한다.
  partitionKey?: string;
  // 커스텀 워크스페이스 그리드 슬롯 안에 배치된 경우 true. 일반 브라우저 탭(전체 탭 하나를 차지)은
  // 기존 sizing 로직을 그대로 쓰고, 커스텀 워크스페이스 슬롯(그리드 셀, 크기가 작고 자주 리사이즈됨)만
  // 별도 sizing 로직을 쓴다 — 기존 탭 동작에 영향 없이 커스텀 워크스페이스의 "150px 고정" 버그만 고친다.
  embedded?: boolean;
  // 탭 바 + 주소창/줌/DevTools/프록시 툴바를 아예 렌더하지 않음 — 사내 메신저처럼 고정된 단일
  // 사이트를 임베드할 때, 브라우저 크롬 UI 없이 webview 만 꽉 채워 보여주고 싶을 때 사용.
  chromeless?: boolean;
  // 링크 클릭 시 현재 webview 안에서 새 페이지로 빠져나가지 않고 외부 브라우저로 연다.
  externalizeLinks?: boolean;
  // 화면 폭이 좁을 때 페이지 자체를 축소해서 내부 가로 스크롤이 생기지 않도록 맞춘다.
  autoFitZoom?: boolean;
  autoFitBaseWidth?: number;
  autoFitMinZoom?: number;
  autoFitMaxZoom?: number;
  // 내부 webview 엘리먼트를 상위 컴포넌트에 노출 — 사내 메신저 대화 아카이브 스크래핑처럼
  // 상위에서 executeJavaScript 를 직접 호출해야 하는 경우에 사용(dom-ready 마다 최신 참조로 호출됨).
  onWebviewReady?: (webview: any) => void;
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

export const BrowserPane: React.FC<Props> = ({ initialUrl, onTitleChange, connectedSessions = [], initialState, onStateChange, partitionKey, embedded = false, chromeless = false, externalizeLinks = false, autoFitZoom = false, autoFitBaseWidth = 960, autoFitMinZoom = 0.35, autoFitMaxZoom = 1, onWebviewReady }) => {
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
  const autoFitMeasureSeqRef = useRef(0);
  const autoFitRetryTimersRef = useRef<number[]>([]);
  const resizeSettledTimerRef = useRef<number | null>(null);
  const lastAutoFitViewportWidthRef = useRef<number>(0);
  const externalLinkGestureWindowMs = 1500;
  // 실제로 webview 에 적용된(setZoomFactor 를 마지막으로 호출한) 값 — 같은 값이어도 매
  // did-navigate/dom-ready/did-stop-loading 마다 setZoomFactor 를 반복 호출하고 있었는데,
  // Electron 의 setZoomFactor 는 호출될 때마다 게스트의 CSS vh/vw 뷰포트 재계산이 실제 픽셀
  // 크기와 어긋나는(값이 그대로여도) 버그가 있어 이게 "구글 footer 가 하단에 안 붙는" 증상의
  // 원인으로 의심된다. 값이 실제로 바뀔 때만 호출하도록 막는다.
  const appliedZoomFactorRef = useRef<number>(1);
  const applyZoomFactorIfChanged = useCallback((wv: any) => {
    if (!wv) return;
    const z = zoomRef.current;
    if (appliedZoomFactorRef.current === z) return;
    try { wv.setZoomFactor?.(z); appliedZoomFactorRef.current = z; } catch {}
  }, []);
  const applyAutoFitZoomIfNeeded = useCallback((viewportWidth: number, contentWidth?: number) => {
    if (!autoFitZoom) return;
    if (!viewportWidth || viewportWidth < 10) return;
    const base = Math.max(320, autoFitBaseWidth || 960);
    const measuredContentWidth = Math.max(0, Number(contentWidth || 0));
    // 고정폭/반응형 혼합 페이지는 scrollWidth 가 실제 필요 폭보다 과하게 크게 잡히는 경우가 있다.
    // 너무 큰 값이 zoom 재상승을 막지 않도록, base 대비 과도하게 큰 폭은 기준 폭으로 되돌린다.
    const effectiveContentWidth =
      measuredContentWidth > 0 && measuredContentWidth <= base * 1.35
        ? measuredContentWidth
        : base;
    const fitWidth = Math.max(base, effectiveContentWidth);
    const maxZoom = Math.min(1, Math.max(autoFitMinZoom, autoFitMaxZoom || 1));
    const nextZoom = Math.max(autoFitMinZoom, Math.min(maxZoom, +(viewportWidth / fitWidth).toFixed(2)));
    const currentZoom = zoomRef.current;
    const delta = nextZoom - currentZoom;
    if (delta > 0) {
      if (delta < 0.01) return;
    } else if (Math.abs(delta) < 0.02) {
      return;
    }
    applyZoom(nextZoom);
  }, [autoFitZoom, autoFitBaseWidth, autoFitMinZoom, autoFitMaxZoom]);
  const measureAndApplyAutoFitZoom = useCallback((viewportWidth: number) => {
    if (!autoFitZoom) return;
    const wv: any = webviewRef.current;
    if (!wv || !webviewDomReadyRef.current) {
      applyAutoFitZoomIfNeeded(viewportWidth);
      return;
    }
    const seq = ++autoFitMeasureSeqRef.current;
    window.setTimeout(() => {
      Promise.resolve(wv.executeJavaScript?.(`(() => {
        try {
          const doc = document.documentElement;
          const body = document.body;
          const widths = [
            window.innerWidth || 0,
            doc?.scrollWidth || 0,
            doc?.offsetWidth || 0,
            doc?.clientWidth || 0,
            body?.scrollWidth || 0,
            body?.offsetWidth || 0,
            body?.clientWidth || 0,
          ].map(v => Number(v) || 0);
          return Math.max(...widths);
        } catch (e) {
          return 0;
        }
      })()`, true))
        .then((raw: any) => {
          if (seq !== autoFitMeasureSeqRef.current) return;
          const contentWidth = Number(raw || 0);
          applyAutoFitZoomIfNeeded(viewportWidth, contentWidth);
        })
        .catch(() => {
          if (seq === autoFitMeasureSeqRef.current) applyAutoFitZoomIfNeeded(viewportWidth);
        });
    }, 0);
  }, [autoFitZoom, applyAutoFitZoomIfNeeded]);
  const clearAutoFitRetryTimers = useCallback(() => {
    for (const id of autoFitRetryTimersRef.current) {
      try { window.clearTimeout(id); } catch {}
    }
    autoFitRetryTimersRef.current = [];
  }, []);
  const clearResizeSettledTimer = useCallback(() => {
    if (resizeSettledTimerRef.current != null) {
      try { window.clearTimeout(resizeSettledTimerRef.current); } catch {}
      resizeSettledTimerRef.current = null;
    }
  }, []);
  const scheduleAutoFitZoomRecheck = useCallback((viewportWidth: number) => {
    if (!autoFitZoom) return;
    clearAutoFitRetryTimers();
    const delays = [0, 180, 600, 1400];
    autoFitRetryTimersRef.current = delays.map(delay => window.setTimeout(() => {
      measureAndApplyAutoFitZoom(viewportWidth);
    }, delay));
  }, [autoFitZoom, clearAutoFitRetryTimers, measureAndApplyAutoFitZoom]);
  const onTitleChangeRef = useRef<Props['onTitleChange']>(onTitleChange);
  const urlHistoryKey = 'pepe-browser-url-history';
  const partitionName = useMemo(
    () => partitionKey?.trim() || `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    [partitionKey],
  );
  // 복원된 URL 이 있으면 그걸로 시작.
  const startUrl = (initialState?.editUrl && initialState.editUrl.trim()) ? initialState.editUrl : initialUrl;
  const initialSrcRef = useRef(startUrl);
  const initialOrigin = useMemo(() => {
    try {
      return new URL(startUrl).origin;
    } catch {
      return '';
    }
  }, [startUrl]);
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
  const openInExternalBrowser = useCallback((url: string) => {
    const raw = String(url || '').trim();
    if (!raw) return;
    try { (window as any).api?.shellOpenExternal?.(raw); } catch {}
  }, []);
  useEffect(() => {
    const updateFocus = () => {
      hostWindowFocusedRef.current = typeof document !== 'undefined'
        ? document.visibilityState === 'visible' && document.hasFocus()
        : true;
    };
    updateFocus();
    window.addEventListener('focus', updateFocus);
    window.addEventListener('blur', updateFocus);
    document.addEventListener('visibilitychange', updateFocus);
    return () => {
      window.removeEventListener('focus', updateFocus);
      window.removeEventListener('blur', updateFocus);
      document.removeEventListener('visibilitychange', updateFocus);
    };
  }, []);
  const consumeWindowOpenEvent = useCallback((url: string) => {
    const raw = String(url || '').trim();
    if (!raw) return false;
    const now = Date.now();
    const last = lastWindowOpenRef.current;
    if (last.url === raw && (now - last.at) < 1200) return false;
    lastWindowOpenRef.current = { url: raw, at: now };
    return true;
  }, []);
  const shouldOpenExternally = useCallback((url: string) => {
    if (!externalizeLinks) return false;
    const raw = String(url || '').trim();
    if (!raw) return false;
    if (/^(javascript:|data:|file:)/i.test(raw)) return false;
    if (/^about:blank$/i.test(raw)) return false;
    try {
      const parsed = new URL(raw, initialSrcRef.current || startUrl);
      if (!/^https?:$/i.test(parsed.protocol) && !/^mailto:$/i.test(parsed.protocol) && !/^tel:$/i.test(parsed.protocol)) return false;
      if (!initialOrigin) return true;
      if (/^https?:$/i.test(parsed.protocol)) return parsed.origin !== initialOrigin;
      return true;
    } catch {
      return true;
    }
  }, [externalizeLinks, initialOrigin, startUrl]);
  const hasRecentExternalGesture = useCallback(async (): Promise<boolean> => {
    const wv: any = webviewRef.current;
    if (!wv) return false;
    try {
      const seenAt = await Promise.resolve(wv.executeJavaScript?.('window.__pepeLastExternalGestureAt || 0', true));
      const ts = Number(seenAt || 0);
      return !!ts && (Date.now() - ts) <= externalLinkGestureWindowMs;
    } catch {
      return false;
    }
  }, [externalLinkGestureWindowMs]);
  const injectExternalGestureTracker = useCallback(() => {
    const wv: any = webviewRef.current;
    if (!wv) return;
    try {
      void wv.executeJavaScript?.(`
        (() => {
          try {
            if (window.__pepeExternalGestureTrackerInjected) return;
            window.__pepeExternalGestureTrackerInjected = true;
            const mark = () => { try { window.__pepeLastExternalGestureAt = Date.now(); } catch {} };
            ['pointerdown', 'mousedown', 'click', 'touchstart', 'keydown'].forEach(evt => {
              document.addEventListener(evt, mark, { capture: true, passive: true });
            });
          } catch {}
        })();
      `, true);
    } catch {}
  }, []);
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
  const allowExternalLinkRoutingRef = useRef(false);
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
  const lastWindowOpenRef = useRef<{ url: string; at: number }>({ url: '', at: 0 });
  const hostWindowFocusedRef = useRef<boolean>(typeof document !== 'undefined' ? document.hasFocus() : true);
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
      measureAndApplyAutoFitZoom(nextWidth);
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
  }, [emitDebugLog, autoFitZoom, autoFitBaseWidth, autoFitMinZoom, autoFitMaxZoom, measureAndApplyAutoFitZoom]);

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
        wrap.style.flex = 'none';
        wrap.style.width = '100%';
        wrap.style.height = `${nextHeight}px`;
        wrap.style.minHeight = `${nextHeight}px`;
        wrap.style.maxHeight = `${nextHeight}px`;
        wrap.style.background = '#ffffff';
        // autosize="on" + width/height/min/max 속성을 매번 락 걸던 예전 방식은, 커스텀
        // 워크스페이스 쪽에서 이미 겪은 "150px 고정" 버그와 동일 계열(Chromium autosize 가
        // 새 min/max 로 제대로 재반영을 못 하고 이전 게스트 뷰포트 크기에 눌러붙는 문제)의
        // 원인이었다. embedded 경로처럼 autosize 를 끄고 CSS(position:absolute; inset:0;
        // 100%)로만 게스트를 호스트 박스에 맞춘다 — wrap 이 이미 정확한 픽셀 높이로 고정돼
        // 있으므로 webview 는 그 안을 100% 로 채우기만 하면 된다.
        wv.style.position = 'absolute';
        wv.style.inset = '0';
        wv.style.width = '100%';
        wv.style.height = '100%';
        wv.style.minWidth = '0';
        wv.style.minHeight = '0';
        wv.style.maxWidth = 'none';
        wv.style.maxHeight = 'none';
        wv.style.display = 'flex';
        wv.style.background = '#ffffff';
      }
      // autosize 잔여 속성 정리는 sizeChanged 여부와 무관하게 매 호출마다 보장한다 — dev HMR 등으로
      // 이전 코드가 이미 autosize="on"/min·max 속성을 박아둔 webview 엘리먼트가 재사용되는 경우,
      // 크기가 우연히 안 바뀌면 위 sizeChanged 블록을 안 타서 잔여 속성이 안 지워지는 문제 방지.
      try {
        if (wv.getAttribute?.('autosize') !== 'off') wv.setAttribute?.('autosize', 'off');
        wv.removeAttribute?.('width');
        wv.removeAttribute?.('height');
        wv.removeAttribute?.('minwidth');
        wv.removeAttribute?.('maxwidth');
        wv.removeAttribute?.('minheight');
        wv.removeAttribute?.('maxheight');
      } catch {}
      if (shouldForceGuestResize) {
        try {
          // webview 엘리먼트의 display 를 껐다 켜서 게스트를 강제로 재부착하는 방식은 되돌렸다 —
          // mount 직후 ResizeObserver 가 flex 레이아웃이 안정화되는 동안 짧은 시간에 여러 번
          // 연달아 발화할 수 있는데, 그때마다 재부착이 걸리면서 Electron 내부의 did-stop-loading
          // 포워딩 구독이 정리 없이 누적돼 MaxListenersExceededWarning 이 뜨는 원인이었다("브라우저
          // 워크스페이스 시작하자마자" 뜨는 것과 정확히 일치). wrap 높이 1px nudge 만 유지하고,
          // 진짜 "게스트가 작은 크기에 눌러붙음" 케이스는 아래 onStop 의 실측 기반 자동 복구
          // (webviewNonce 로 webview 자체를 재생성)에 맡긴다 — 이건 이미 안전하게 최대 2회로
          // 제한돼 있다.
          wrap.style.height = `${Math.max(120, nextHeight - 1)}px`;
          window.requestAnimationFrame(() => {
            if (webviewWrapRef.current === wrap) {
              wrap.style.height = `${nextHeight}px`;
            }
          });
          // 호스트 쪽 CSS 로 <webview> 박스 크기를 바꾸는 건 게스트 페이지 안에 실제
          // window resize 이벤트를 발생시키지 않는다. window.innerHeight 자체는 정확히
          // 갱신되지만(디버그 로그로 확인됨), 구글 홈페이지처럼 resize 리스너로 footer 를
          // JS 로 한 번 계산해서 고정 배치하는 페이지는 그 계산이 다시 안 돌아 예전(마운트
          // 시점) 위치에 눌러붙는다 — 게스트 안에 합성 resize 이벤트를 직접 쏴서 그런
          // resize 리스너들이 재계산하도록 강제한다.
          if (webviewDomReadyRef.current) {
            try {
              void wv.executeJavaScript?.('window.dispatchEvent(new Event("resize"));', true).catch(() => {});
            } catch {}
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

  // 실제 게스트 내부 뷰포트(window.innerHeight)를 실측해서 기대 높이의 절반도 안 되면 —
  // "게스트가 이전(작은) 크기에 눌러붙음" 상태로 보고 webviewNonce 를 올려 webview 자체를
  // 통째로 재생성한다(최대 2회 제한). did-stop-loading 뿐 아니라 resize/active-tab-changed 로
  // 인한 강제 리사이즈 뒤에도 이 실측 검증을 태워서, "탭 전환/윈도우 리사이즈 후 게스트가 작게
  // 남는" 증상을 페이지 재로딩 없이도 잡아낸다.
  const verifyAndRecoverViewport = useCallback((tag: string) => {
    const wv: any = webviewRef.current;
    if (!wv || !webviewDomReadyRef.current) return;
    try {
      const url = String(wv.getURL?.() || '');
      Promise.resolve(wv.executeJavaScript?.(`
        (() => {
          try {
            const body = document.body;
            const docEl = document.documentElement;
            // id 를 추측하는 대신, 화면 하단에 고정되려는(position:fixed, bottom 값이 낮은)
            // 모든 엘리먼트를 실제로 스캔한다 — "게스트 뷰포트가 작게 눌러붙은 버그"인지
            // 아니면 "이 페이지가 원래 footer 를 하단 고정 안 하는 레이아웃을 타는 것"인지 구분.
            const fixedBottomEls = [];
            const all = document.querySelectorAll('body *');
            for (let i = 0; i < all.length && fixedBottomEls.length < 5; i++) {
              const elx = all[i];
              const cs = window.getComputedStyle(elx);
              if (cs.position === 'fixed' || cs.position === 'sticky') {
                const r = elx.getBoundingClientRect();
                if (r.height > 0) {
                  fixedBottomEls.push({
                    tag: elx.tagName,
                    id: elx.id || null,
                    className: typeof elx.className === 'string' ? elx.className.slice(0, 60) : null,
                    position: cs.position,
                    cssTop: cs.top,
                    cssBottom: cs.bottom,
                    rectTop: r.top,
                    rectBottom: r.bottom,
                    rectHeight: r.height,
                  });
                }
              }
            }
            const footerInfo = fixedBottomEls;
            // Chromium 게스트 리사이즈 후 100vh 단위가 실제 window.innerHeight 와 어긋나는
            // (알려진) 버그가 있는지 직접 측정한다 — flex/grid 로 "min-height:100vh" 로 footer 를
            // 하단에 붙이는 최신 방식의 페이지는 이게 어긋나면 정확히 이 증상(내용은 짧게, 아래
            // 여백)이 난다.
            let vhTestPx = 0;
            try {
              const probe = document.createElement('div');
              probe.style.cssText = 'position:fixed;left:-9999px;top:0;height:100vh;width:1px;pointer-events:none;';
              document.body.appendChild(probe);
              vhTestPx = probe.getBoundingClientRect().height;
              document.body.removeChild(probe);
            } catch {}
            return {
              vhTestPx,
              vhMismatch: Math.abs(vhTestPx - (window.innerHeight || 0)) > 2,
              bodyScrollHeight: body ? body.scrollHeight : 0,
              bodyOffsetHeight: body ? body.offsetHeight : 0,
              docScrollHeight: docEl ? docEl.scrollHeight : 0,
              docOffsetHeight: docEl ? docEl.offsetHeight : 0,
              htmlComputedHeight: docEl ? window.getComputedStyle(docEl).height : '',
              bodyComputedHeight: body ? window.getComputedStyle(body).height : '',
              innerHeight: window.innerHeight || 0,
              innerWidth: window.innerWidth || 0,
              devicePixelRatio: window.devicePixelRatio || 1,
              footerInfo,
            };
          } catch (e) {
            return { bodyScrollHeight: 0, bodyOffsetHeight: 0, docScrollHeight: 0, docOffsetHeight: 0, innerHeight: 0, innerWidth: 0, error: String(e) };
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
        emitDebugLog('[cw-debug][browser-viewport-verify]', {
          tag,
          activeTabId: activeTabIdRef.current,
          tabsLength: tabsRef.current.length,
          url,
          doc,
          expectedHeight,
          shouldRecoverViewport,
          recoveryAttempt: recoveryAttemptRef.current,
        });
      }).catch((err: any) => {
        emitDebugLog('[cw-debug][browser-viewport-verify-error]', { tag, error: String(err?.message || err || '') });
      });
    } catch (err: any) {
      emitDebugLog('[cw-debug][browser-viewport-verify-error]', { tag, error: String(err?.message || err || '') });
    }
  }, [emitDebugLog]);

  const syncBrowserLayoutAfterResize = useCallback((tag: string) => {
    syncWebviewHeight(tag);
    const wv: any = webviewRef.current;
    const wrapWidth = Math.max(1, Math.floor(webviewWrapRef.current?.getBoundingClientRect?.().width || webviewWrapRef.current?.clientWidth || 0));
    const rootRect = browserPaneRef.current?.getBoundingClientRect?.();
    const wrect = wv?.getBoundingClientRect?.();
    emitDebugLog('[cw-debug][browser-size]', tag, {
      pane: rootRect ? { clientWidth: browserPaneRef.current?.clientWidth, clientHeight: browserPaneRef.current?.clientHeight, rectW: Math.round(rootRect.width), rectH: Math.round(rootRect.height) } : null,
      webview: wrect ? { width: Math.round(wrect.width), height: Math.round(wrect.height) } : null,
    });
    if (autoFitZoom) {
      scheduleAutoFitZoomRecheck(wrapWidth);
    }
    window.setTimeout(() => verifyAndRecoverViewport(tag), 250);
  }, [autoFitZoom, emitDebugLog, scheduleAutoFitZoomRecheck, syncWebviewHeight, verifyAndRecoverViewport]);
  const scheduleBrowserLayoutAfterResize = useCallback((tag: string) => {
    const wrapWidth = Math.max(1, Math.floor(webviewWrapRef.current?.getBoundingClientRect?.().width || webviewWrapRef.current?.clientWidth || 0));
    const prevWidth = lastAutoFitViewportWidthRef.current || 0;
    lastAutoFitViewportWidthRef.current = wrapWidth;
    if (autoFitZoom && wrapWidth > prevWidth + 8) {
      window.requestAnimationFrame(() => measureAndApplyAutoFitZoom(wrapWidth));
    }
    clearResizeSettledTimer();
    resizeSettledTimerRef.current = window.setTimeout(() => {
      resizeSettledTimerRef.current = null;
      syncBrowserLayoutAfterResize(`${tag}-settled`);
    }, 160);
  }, [clearResizeSettledTimer, syncBrowserLayoutAfterResize]);

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
    syncBrowserLayoutAfterResize('mount');
    const ro = new ResizeObserver(() => scheduleBrowserLayoutAfterResize('resize'));
    ro.observe(el);
    if (embedded) {
      // embedded 는 wrap 이 flex 로 실제 가용 영역을 채우므로 직접 관찰 — 그리드/분할 리사이즈에 확실히 추종.
      const wrapEl = webviewWrapRef.current;
      if (wrapEl && wrapEl !== el) ro.observe(wrapEl);
    }
    const timer = window.setTimeout(() => syncBrowserLayoutAfterResize('delayed-200ms'), 200);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
      clearResizeSettledTimer();
    };
  }, [syncBrowserLayoutAfterResize, scheduleBrowserLayoutAfterResize, clearResizeSettledTimer, embedded]);

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
    // did-navigate 등 리스너-바인딩 effect 와 동일한 이유의 방어적 가드 — 아래 참고.
    if (wv.__pepeOnReadyBound) return;
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
      applyZoomFactorIfChanged(wv);
      // dev 환경에서 Vite Fast Refresh 로 이 컴포넌트의 리스너-바인딩 effect 가 같은
      // <webview> 에 대해 정리 없이 여러 번 재실행되는 경우가 있어(코드 수정마다 발생),
      // 실제 리스너 개수가 진짜로 새는지와 별개로 그 과정에서 뜨는
      // MaxListenersExceededWarning 노이즈를 없애기 위해 이 게스트 WebContents 의
      // 한도를 넉넉히 올려둔다 — 프로덕션 빌드는 HMR 이 없어 애초에 해당 없음.
      try {
        const webContentsId = wv.getWebContentsId?.();
        if (webContentsId) void (window as any).api?.bumpWebviewMaxListeners?.({ webContentsId });
      } catch {}
      syncWebviewHeight('dom-ready');
      window.setTimeout(() => syncWebviewHeight('dom-ready-late'), 60);
      try { onWebviewReady?.(wv); } catch {}
    };
    wv.__pepeOnReadyHandler = onReady;
    wv.__pepeOnReadyBound = true;
    wv.addEventListener('dom-ready', onReady);
    return () => {
      wv.__pepeOnReadyBound = false;
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
    // 이 effect 의 의존성(emitDebugLog, syncWebviewHeight)은 항상 안정적인 참조라 마운트
    // 시 한 번만 실행되면 충분하다. 그런데도 같은 <webview> 엘리먼트에 대해 정리 없이
    // 반복 호출되는 경우(dev 환경의 Vite Fast Refresh 등)를 대비해, 이미 바인딩된 상태면
    // 통째로 건너뛴다 — remove-then-readd 를 매번 반복하다 어느 한 번이라도 remove 매칭이
    // 실패하면 리스너가 누적되는데(→ MaxListenersExceededWarning, 리사이즈 로직 중복 실행
    // 으로 인한 뷰포트 계산 오차/작은 스크롤바 증상), 애초에 재실행 자체를 막으면 그 경로가
    // 원천 차단된다. 진짜 새 엘리먼트(재마운트)라면 이 플래그가 없으므로 정상적으로 바인딩된다.
    if (wv.__pepeListenersBound) return;
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
      applyZoomFactorIfChanged(wv);
      try { setCanBack(wv.canGoBack()); setCanFwd(wv.canGoForward()); } catch {}
    };
  const onStart = () => {
      setLoading(true);
      // 새 네비게이션이 시작되면 Electron 이 게스트의 zoom factor 를 리셋하는 경우가 있어
      // (기존 주석에도 명시돼 있던 이유) "이번 네비게이션에서 한 번은 실제로 재적용해야 함"
      // 표시로 무효화한다 — dom-ready/onNav/onStop 는 같은 네비게이션 사이클 안에서 서로
      // 중복 호출만 걸러내고, 매 네비게이션마다 최소 한 번은 확실히 재적용되게 한다.
      appliedZoomFactorRef.current = -1;
      clearAutoFitRetryTimers();
    };
    const onStop = () => {
      setLoading(false);
      onNav();
      syncWebviewHeight('did-stop-loading');
      verifyAndRecoverViewport('did-stop-loading');
      if (externalizeLinks) {
        allowExternalLinkRoutingRef.current = true;
      }
      if (autoFitZoom) {
        const wrapRect = webviewWrapRef.current?.getBoundingClientRect();
        const nextWidth = Math.max(1, Math.floor(wrapRect?.width || 0));
        scheduleAutoFitZoomRecheck(nextWidth);
      }
    };
    const onTitle = (e: any) => {
      onTitleChangeRef.current?.(e.title || '');
      setTabTitle(activeTabIdRef.current, e.title || '');
    };
    const maybeOpenExternally = async (url: string) => {
      const nextUrl = String(url || '').trim();
      if (!nextUrl) return false;
      if (!hostWindowFocusedRef.current) return false;
      if (!allowExternalLinkRoutingRef.current) return false;
      if (!shouldOpenExternally(nextUrl)) return false;
      if (!(await hasRecentExternalGesture())) return false;
      openInExternalBrowser(nextUrl);
      return true;
    };
    // 링크 클릭이 새 창을 요청하면 새 탭으로 열기.
    // Electron 25+ 에서 <webview> 의 new-window preventDefault 가 무시되므로
    // main process 의 setWindowOpenHandler 가 URL 을 IPC 로 전달 → 여기서 새 탭으로.
    const onNewWindow = (e: any) => {
      try { e.preventDefault?.(); } catch {}
      const url = String(e?.url || '');
      if (!url) return;
      if (!consumeWindowOpenEvent(url)) return;
      if (!shouldOpenExternally(url)) {
        openInNewTab(url);
        return;
      }
      void maybeOpenExternally(url);
    };
    const onWillNavigate = (e: any) => {
      const url = String(e?.url || '');
      if (!url) return;
      if (!shouldOpenExternally(url)) return;
      if (!consumeWindowOpenEvent(url)) return;
      try { e.preventDefault?.(); } catch {}
      void maybeOpenExternally(url);
    };
    const offBrowserNewWindow = (window as any).api?.onBrowserWebviewNewWindow?.((p: { guestId: number; url: string }) => {
      if (!p?.url) return;
      let currentGuestId: number | undefined;
      try { currentGuestId = wv.getWebContentsId?.(); } catch {}
      // guestId 매칭 — 다른 브라우저 워크스페이스 인스턴스와 충돌 방지.
      if (currentGuestId != null && p.guestId !== currentGuestId) return;
      if (!consumeWindowOpenEvent(p.url)) return;
      if (!shouldOpenExternally(p.url)) return openInNewTab(p.url);
      void maybeOpenExternally(p.url);
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
    wv.__pepeListenersBound = true;
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('page-title-updated', onTitle);
    wv.addEventListener('did-fail-load', onFail);
    wv.addEventListener('dom-ready', injectExternalGestureTracker);
    wv.addEventListener('did-navigate', injectExternalGestureTracker);
    wv.addEventListener('will-navigate', onWillNavigate);
    wv.addEventListener('new-window', onNewWindow);
    injectExternalGestureTracker();
    return () => {
      wv.__pepeListenersBound = false;
      try {
        wv.removeEventListener('did-navigate', onNav);
        wv.removeEventListener('did-navigate-in-page', onNav);
        wv.removeEventListener('did-start-loading', onStart);
        wv.removeEventListener('did-stop-loading', onStop);
        wv.removeEventListener('page-title-updated', onTitle);
        wv.removeEventListener('did-fail-load', onFail);
        wv.removeEventListener('dom-ready', injectExternalGestureTracker);
        wv.removeEventListener('did-navigate', injectExternalGestureTracker);
        wv.removeEventListener('will-navigate', onWillNavigate);
        wv.removeEventListener('new-window', onNewWindow);
      } catch {}
      try { offBrowserNewWindow?.(); } catch {}
      if (wv.__pepeLifecycleHandlers?.onStop === onStop) {
        try { delete wv.__pepeLifecycleHandlers; } catch {}
      }
    };
  }, [emitDebugLog, syncWebviewHeight, verifyAndRecoverViewport, autoFitZoom, scheduleAutoFitZoomRecheck, clearAutoFitRetryTimers]);

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
        overflow-x: hidden !important;
      }
      body {
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
          try { document.documentElement.style.overflowX = 'hidden'; } catch {}
          try { document.body && (document.body.style.background = '#fff'); } catch {}
          try { document.body && (document.body.style.minHeight = '100vh'); } catch {}
          try { document.body && (document.body.style.overflowX = 'hidden'); } catch {}
        })();
      `, true);
    } catch {}
  };

  const installBrowserCredentialHooks = async (url: string, username: string, password: string, siteKey: string, autoSubmit = false) => {
    const wv: any = webviewRef.current;
    if (!wv || !siteKey) return;
    const seq = ++credSyncSeqRef.current;
    // teardown 은 아래 credSyncSeqRef 시퀀스 체크와 무관하게 항상 즉시 실행한다 — 네비게이션이
    // 짧은 시간에 여러 번 겹치면(did-navigate/did-navigate-in-page/did-stop-loading 이 거의
    // 동시에 발생) 먼저 시작된 이 함수의 await 가 끝나기 전에 나중 호출이 seq 를 증가시켜버려서,
    // "본 스크립트"가 seq 불일치로 통째로 취소되는 경우가 있었다 — 그러면 teardown 도 같이
    // 취소되어 이전(로그인 페이지) 클로저가 계속 살아남아 검색창 등을 계속 오염시켰다.
    try {
      await wv.executeJavaScript(`
        if (window.__pepeBrowserCredTeardown) { try { window.__pepeBrowserCredTeardown(); } catch {} }
      `, true);
    } catch {}
    const script = `
      (() => {
        const cred = ${JSON.stringify({ username, password, siteKey, sourceUrl: url, autoSubmit })};
        const currentSiteKey = String(cred.siteKey || '').toLowerCase();
        const prefix = '__PEPE_BROWSER_CRED__:';
        console.log('__PEPE_AUTOSUBMIT_DEBUG__:' + JSON.stringify({
          tag: 'script-injected', href: location.href,
          hasUsername: !!cred.username, hasPassword: !!cred.password, autoSubmit: cred.autoSubmit,
        }));
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
        // 로그인 버튼 후보 — <button type=submit>, input[type=submit], 텍스트에 로그인/login 이
        // 들어간 button/a 요소. 스코어링으로 가장 그럴듯한 것 하나만 고른다(여러 버튼이 있는
        // 페이지에서 엉뚱한 걸 누르지 않도록).
        const findSubmitEl = (form) => {
          const scope = form || document;
          // button/input[submit]/role=button 외에, 클릭 가능한 커스텀 요소(div/span 에 클릭
          // 핸들러만 붙인 SPA 버튼)도 후보에 넣는다 — "로그인" 텍스트를 가진 리프 노드까지 포함.
          const candidates = Array.from(scope.querySelectorAll(
            'button, input[type="submit"], a[role="button"], [role="button"], div, span'
          ));
          const scoreBtn = (el) => {
            const text = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
            const meta = [el.type, el.id, el.className].filter(Boolean).join(' ').toLowerCase();
            const tag = el.tagName.toLowerCase();
            let score = 0;
            if (tag === 'button' || tag === 'a') score += 3;
            if (el.type === 'submit') score += 3;
            if (el.getAttribute && el.getAttribute('role') === 'button') score += 2;
            // 텍스트가 정확히 "로그인"/"login" 뿐인 요소(자식 노드 없이 리프)를 우대 — div/span
            // 후보 중 페이지 전체 텍스트를 다 포함하는 큰 컨테이너가 걸리는 걸 방지.
            if (/^(login|log in|로그인|sign in)$/.test(text)) score += 6;
            else if (/login|log in|로그인|sign in/.test(text)) score += 2;
            if (/login|signin/.test(meta)) score += 2;
            // 네이버웍스 로그인 페이지에서 실측된 실제 구조(id=loginBtn, class=btn_submit) — 있으면 확정 우대.
            if (/\bloginbtn\b/.test(meta)) score += 10;
            if (/\bbtn_submit\b/.test(meta)) score += 4;
            if (text.length > 20) score -= 5; // 버튼 텍스트치고 너무 긴 컨테이너는 감점
            if (el.children && el.children.length > 3) score -= 3; // 자식이 많으면 버튼이 아닐 확률↑
            if (el.disabled) score -= 100;
            const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
            if (style && (style.display === 'none' || style.visibility === 'hidden')) score -= 100;
            return score;
          };
          const best = pickBest(candidates.filter(el => !el.disabled), scoreBtn);
          return best;
        };
        // 네이티브 el.click() 만으로는 반응하지 않는 SPA(React 등)를 위해, 실제 마우스 클릭과
        // 동일한 이벤트 시퀀스(pointerdown→mousedown→pointerup→mouseup→click)를 모두 디스패치.
        const simulateClick = (el) => {
          const rect = el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
          try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch {}
          try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch {}
          try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch {}
          try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch {}
          try { el.dispatchEvent(new MouseEvent('click', opts)); } catch {}
          try { el.click(); } catch {}
        };
        // 값을 채운 뒤 자동 제출 — 같은 페이지에서 중복 시도하지 않도록 window 플래그로 1회만
        // "시작"하되, 실제 클릭은 버튼이 활성화될 때까지 최대 5초간 200ms 간격으로 재시도한다.
        // (많은 로그인 폼이 비밀번호 입력 직후에만 버튼을 활성화하며, 그 활성화가 프레임워크의
        // 다음 렌더 틱에 일어나 setValue 직후엔 아직 disabled 인 경우가 흔하다.)
        const autoSubmitIfReady = () => {
          // cred 에 자격증명이 아예 없으면(이 페이지엔 해당 사항 없음) 절대 진행하지 않는다 —
          // 아래 userOk/passOk 는 "해당 자격증명이 없으면 통과(!cred.username)"로 설계돼 있어서,
          // username/password 가 둘 다 없는 페이지에서도 우연히 password 필드 하나만 있으면
          // (talk.worksmobile.com 의 숨은 설정 폼 등) 자동제출이 발동해 페이지의 엉뚱한 버튼
          // (정렬 버튼 등)을 로그인 버튼으로 오인해 클릭해버리는 사고가 여기서 났었다.
          if (!cred.username && !cred.password) return;
          if (!cred.autoSubmit || window.__pepeBrowserCredAutoSubmitting) return;
          const inputs = getInputs();
          const user = pickBest(inputs, scoreText);
          const pass = pickBest(inputs, scorePass);
          // 완전일치(===) 대신 포함 관계로 완화 — 예: 저장된 계정은 "id@domain.com" 전체인데,
          // 이 사이트처럼 아이디 입력칸에는 "id" 부분만 들어있고 "@domain.com" 은 옆에 별도
          // 고정 텍스트로 표시되는 폼이 있어(네이버웍스가 그런 구조), 완전일치면 항상 실패했다.
          const userValNorm = user ? String(user.value || '').trim().toLowerCase() : '';
          const credUserNorm = String(cred.username || '').trim().toLowerCase();
          const userOk = !cred.username || (!!userValNorm && (userValNorm === credUserNorm
            || credUserNorm.startsWith(userValNorm) || userValNorm.startsWith(credUserNorm)));
          const passOk = !cred.password || (pass && String(pass.value || '') === cred.password);
          console.log('__PEPE_AUTOSUBMIT_DEBUG__:' + JSON.stringify({
            tag: 'ready-check', userOk: !!userOk, passOk: !!passOk, hasPass: !!pass,
            userVal: user ? String(user.value || '').trim().slice(0, 3) + '...' : null,
            credUser: cred.username ? cred.username.slice(0, 3) + '...' : null,
          }));
          if (!userOk || !passOk || !pass) return;
          window.__pepeBrowserCredAutoSubmitting = true;
          let tries = 0;
          const attempt = () => {
            tries++;
            const form = pass.form || pass.closest('form');
            const btn = findSubmitEl(form);
            console.log('__PEPE_AUTOSUBMIT_DEBUG__:' + JSON.stringify({
              tries, found: !!btn,
              btnTag: btn ? btn.tagName : null,
              btnText: btn ? (btn.innerText || btn.value || btn.textContent || '').trim().slice(0, 30) : null,
              btnDisabled: btn ? !!btn.disabled : null,
              hasForm: !!form,
            }));
            if (btn && !btn.disabled) {
              simulateClick(btn);
              return;
            }
            if (tries >= 25) {
              // 25 회(5초) 안에 버튼이 안 풀리면 form 자체 제출로 폴백.
              try { if (form && form.requestSubmit) form.requestSubmit(); else if (form) form.submit(); } catch {}
              return;
            }
            setTimeout(attempt, 200);
          };
          setTimeout(attempt, 150);
        };
        const fill = () => {
          const inputs = getInputs();
          const pass = pickBest(inputs, scorePass);
          // 로그인 폼에는 반드시 password 타입 입력칸이 있다 — 이게 없는 페이지(로그인 후
          // 넘어간 실제 서비스 화면의 검색창 등 일반 텍스트 입력창)까지 아이디로 오인해 채우는
          // 사고를 막기 위해, 비밀번호 필드가 있는 페이지에서만 채운다.
          if (!pass) return;
          const user = pickBest(inputs, scoreText);
          if (cred.username && user && !String(user.value || '').trim()) setValue(user, cred.username);
          if (cred.password && !String(pass.value || '').trim()) setValue(pass, cred.password);
          autoSubmitIfReady();
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
        // 이 사이트(talk.worksmobile.com)처럼 해시 라우팅 SPA 는 did-navigate-in-page 로 URL 만
        // 바뀌고 document/window 는 그대로 유지된다 — 그래서 로그인 페이지에서 걸어둔 이전 훅이
        // (cred 를 클로저로 캡처한 채) 계속 살아남아, siteKey/자격증명이 바뀐 뒤에도 옛 계정으로
        // 계속 채워 넣는 사고가 났었다. window.__pepeBrowserCredHooked 로 최초 1회만 거는 대신,
        // 매 스크립트 주입마다 이전 리스너/옵저버를 확실히 정리(teardown)하고 새로 건다.
        if (window.__pepeBrowserCredTeardown) {
          try { window.__pepeBrowserCredTeardown(); } catch {}
        }
        const onFocusIn = (e) => {
          const el = e.target;
          if (!(el instanceof HTMLInputElement)) return;
          if (!isTextLike(el) && !isPassLike(el)) return;
          fill();
        };
        const onSubmit = () => setTimeout(capture, 0);
        const onKeydown = (e) => {
          const el = e.target;
          if (!(el instanceof HTMLInputElement)) return;
          if (e.key === 'Enter' && isPassLike(el)) setTimeout(capture, 0);
        };
        document.addEventListener('focusin', onFocusIn, true);
        document.addEventListener('submit', onSubmit, true);
        document.addEventListener('keydown', onKeydown, true);
        const mo = new MutationObserver(() => fill());
        mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
        window.__pepeBrowserCredTeardown = () => {
          document.removeEventListener('focusin', onFocusIn, true);
          document.removeEventListener('submit', onSubmit, true);
          document.removeEventListener('keydown', onKeydown, true);
          try { mo.disconnect(); } catch {}
        };
        window.addEventListener('beforeunload', () => { try { window.__pepeBrowserCredTeardown?.(); } catch {} }, { once: true });
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
    // chromeless(사내 메신저 등 고정 임베드)일 때만 자동 제출까지 — 일반 브라우저 탭에서는
    // 사용자가 로그인 버튼을 직접 눌러야 하는 통상적인 동작을 유지한다.
    await installBrowserCredentialHooks(url, username, password, siteKey, chromeless);
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
    try {
      webviewRef.current?.setZoomFactor?.(clamped);
      appliedZoomFactorRef.current = clamped;
    } catch {}
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
        return;
      }
      // 자동 로그인 버튼 탐색/클릭 디버그 — 개발자도구 콘솔(F12)에서 확인 가능.
      if (m.startsWith('__PEPE_AUTOSUBMIT_DEBUG__:')) {
        console.log('[auto-submit]', m.slice('__PEPE_AUTOSUBMIT_DEBUG__:'.length));
        return;
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
      {/* 탭 바 — 링크가 새 창을 요청하면 새 탭으로 열림. + 로 빈 탭 추가. chromeless 면 렌더하지 않음. */}
      {!chromeless && <div style={{ display: 'flex', alignItems: 'stretch', background: '#1e1e1e', borderBottom: '1px solid #333', overflowX: 'auto', minHeight: 28 }}>
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
      </div>}
      {!chromeless && <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', background: '#222', borderBottom: '1px solid #333', flexWrap: 'wrap' }}>
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
      </div>}
      {!chromeless && testResult ? (
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
