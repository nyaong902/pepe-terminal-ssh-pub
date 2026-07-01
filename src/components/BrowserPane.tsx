// src/components/BrowserPane.tsx
// 브라우저 워크스페이스 — Electron <webview> 로 외부 사이트 렌더.
// 뒤로/앞으로/새로고침/URL 입력 바와 SSH SOCKS 프록시 선택을 제공.
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

type Props = {
  initialUrl: string;
  onTitleChange?: (title: string) => void;
  connectedSessions?: ActiveSshTarget[];
  // 새 창 분리/병합 시 상태 복원용.
  initialState?: { editUrl?: string; zoom?: number; targetSessionId?: string; targetPanelId?: string } | null;
  onStateChange?: (state: { editUrl: string; zoom: number; targetSessionId: string; targetPanelId: string }) => void;
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

export const BrowserPane: React.FC<Props> = ({ initialUrl, onTitleChange, connectedSessions = [], initialState, onStateChange }) => {
  const { t } = useTranslation('browser');
  const webviewRef = useRef<any>(null);
  const partitionName = useMemo(
    () => `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );
  // 복원된 URL 이 있으면 그걸로 시작.
  const startUrl = (initialState?.editUrl && initialState.editUrl.trim()) ? initialState.editUrl : initialUrl;
  const initialSrcRef = useRef(startUrl);
  // ── 내부 탭 관리 — 링크가 새 창으로 열릴 때 새 탭으로 처리. ──
  type BrowserTab = { id: string; url: string; title: string };
  const newTabId = () => `t${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [{ id: newTabId(), url: startUrl, title: '' }]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);
  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];
  const setTabUrl = (id: string, url: string) => setTabs(prev => prev.map(t => t.id === id ? { ...t, url } : t));
  const setTabTitle = (id: string, title: string) => setTabs(prev => prev.map(t => t.id === id ? { ...t, title } : t));
  const openInNewTab = (url: string) => {
    const t: BrowserTab = { id: newTabId(), url, title: '' };
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
  const [targetSessionId, setTargetSessionId] = useState<string>(initialState?.targetSessionId || '');
  const [targetPanelId, setTargetPanelId] = useState<string>(initialState?.targetPanelId || '');
  // 부모에게 상태 변경 보고 — 분리 시 직렬화.
  useEffect(() => {
    if (!onStateChange) return;
    try { onStateChange({ editUrl, zoom, targetSessionId, targetPanelId }); } catch {}
  }, [editUrl, zoom, targetSessionId, targetPanelId, onStateChange]);
  const [proxyState, setProxyState] = useState<{ proxyId: string; localPort: number; panelId: string; connId?: string; sessionId?: string } | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string>('');
  const [testOk, setTestOk] = useState(false);
  const proxySeqRef = useRef(0);
  const lastAutoLoadedRef = useRef<string>('');
  const liveTargets = connectedSessions.length > 0 ? connectedSessions : sshTargets;

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
    if (!targetSessionId) return t('directConnect');
    const stored = storedSessions.find(s => s.id === targetSessionId);
    const match = liveTargets.find(t => t.sessionId === targetSessionId);
    const title = stored?.name?.trim() || match?.sessionName || match?.sessionId || targetSessionId;
    return `${title}${match?.host ? ` (${match.host}${match.port && match.port !== 22 ? `:${match.port}` : ''})` : ''}`;
  }, [liveTargets, storedSessions, targetSessionId]);

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
    if (!targetSessionId) return;
    setTargetPanelId('');
    // 이미 같은 세션으로 전용 프록시가 떠 있으면 재오픈 안 함 (4초 폴링 재실행 방지)
    if (proxyState?.connId && proxyState?.sessionId === targetSessionId) return;
    void applyDedicatedProxy(targetSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSessionId, proxyState?.connId, proxyState?.sessionId]);

  useEffect(() => {
    if (targetSessionId) return;
    if (!proxyState && !targetPanelId) return;
    setTargetPanelId('');
    void clearProxy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSessionId]);

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
        setTargetPanelId('');
        setTestOk(false);
        setTestResult(t('proxyOpenFailed', { reason: r?.error || t('proxyForwardingBlocked') }));
        setProxyState(null);
        return;
      }
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
        setTargetSessionId('');
        setTargetPanelId('');
        setTestOk(false);
        setTestResult(t('proxyOpenFailed', { reason: r?.error || t('proxyForwardingBlocked') }));
        setProxyState(null);
        return;
      }
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
    if (!targetPanelId) return;
    applyProxyForPanel(targetPanelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPanelId]);

  useEffect(() => {
    if (!proxyState) return;
    if (proxyState.connId) return; // 전용(백그라운드) 연결은 활성 패널 목록과 무관 — 유지
    const cur = liveTargets.find(t => t.panelId === proxyState.panelId);
    if (cur) return;
    clearProxy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTargets]);

  useEffect(() => {
    if (!targetSessionId) return;
    const browserUrl = resolveBrowserUrlForSession(targetSessionId);
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
      if (!targetPanelId) return;
      try { webviewRef.current?.loadURL?.(resolveBrowserUrl(browserUrl)).catch(() => {}); } catch {}
    }, 100);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedSessions, liveTargets, targetSessionId]);

  useEffect(() => {
    const wv: any = webviewRef.current;
    if (!wv) return;
    const onReady = () => {
      if (targetPanelId) void applyProxyForPanel(targetPanelId);
    };
    wv.addEventListener('dom-ready', onReady);
    return () => {
      try { wv.removeEventListener('dom-ready', onReady); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPanelId, proxyState, sshTargets]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);
  useEffect(() => {
    const wv: any = webviewRef.current;
    if (!wv) return;
    const onNav = () => {
      try { const u = wv.getURL(); setEditUrl(u); setTabUrl(activeTabId, u); } catch {}
      try { setCanBack(wv.canGoBack()); setCanFwd(wv.canGoForward()); } catch {}
    };
    const onStart = () => setLoading(true);
    const onStop = () => { setLoading(false); onNav(); };
    const onTitle = (e: any) => { onTitleChange?.(e.title || ''); setTabTitle(activeTabId, e.title || ''); };
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onTitleChange, activeTabId]);

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

  const go = async (target: string) => {
    const goUrl = resolveBrowserUrl(target);
    if (!goUrl) return;
    setTestResult('');
    if (!targetSessionId) {
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
    if (!targetSessionId) {
      setTestOk(false);
      setTestResult(t('testSelectSessionFirst'));
      return;
    }
    const targetUrl = resolveBrowserUrl(editUrl || resolveBrowserUrlForSession(targetSessionId));
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
      const testPanelId = targetPanelId
        || (liveTargets.find(t => t.sessionId === targetSessionId)?.panelId || '')
        || (proxyState?.sessionId === targetSessionId ? (proxyState?.connId || '') : '');
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
  useEffect(() => {
    const wv: any = webviewRef.current;
    if (!wv) return;
    const reapply = () => { try { wv.setZoomFactor?.(zoom); } catch {} };
    wv.addEventListener('did-stop-loading', reapply);
    wv.addEventListener('did-navigate', reapply);
    return () => {
      try { wv.removeEventListener('did-stop-loading', reapply); wv.removeEventListener('did-navigate', reapply); } catch {}
    };
  }, [zoom]);

  // Ctrl/Cmd + (+/-/0) 단축키 + Ctrl/Cmd + 휠 줌 — webview 외부에서 입력 받을 때만 동작.
  // webview 내부에서 받은 휠/키는 페이지가 자체 처리하므로 별도 처리 필요.
  // → webview 의 'before-input-event' 로 Ctrl+= / Ctrl+- 가로채서 줌 변경.
  useEffect(() => {
    const wv: any = webviewRef.current;
    if (!wv) return;
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
      }
    };
    try { wv.addEventListener('before-input-event', onInput); } catch {}
    try { wv.addEventListener('dom-ready', injectWheelZoom); } catch {}
    try { wv.addEventListener('did-navigate', injectWheelZoom); } catch {}
    try { wv.addEventListener('console-message', onConsole); } catch {}
    return () => {
      try { wv.removeEventListener('before-input-event', onInput); } catch {}
      try { wv.removeEventListener('dom-ready', injectWheelZoom); } catch {}
      try { wv.removeEventListener('did-navigate', injectWheelZoom); } catch {}
      try { wv.removeEventListener('console-message', onConsole); } catch {}
    };
  }, [zoom]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: '#1a1a1a' }}>
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
        <input
          type="text"
          value={editUrl}
          onChange={e => setEditUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') go(editUrl); }}
          spellCheck={false}
          style={{ flex: 1, padding: '4px 8px', background: '#111', border: '1px solid #333', borderRadius: 3, color: '#ddd', fontSize: 12 }}
          placeholder={t('urlPlaceholder')}
        />
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
          value={targetSessionId}
          onChange={e => {
            const sid = e.target.value;
            setTargetSessionId(sid);
            if (!sid) {
              setTargetPanelId('');
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
      {/* @ts-ignore — webview 는 React 표준 element 가 아니지만 Electron 환경에서 동작 */}
      <webview
        ref={webviewRef as any}
        src={initialSrcRef.current}
        partition={partitionName as any}
        // display: flex 는 webview 렌더링과 호환성 문제 (내부 페이지 스크롤/포커스 안 됨).
        // inline-flex 또는 명시적 flex:1 + width/height 100% 로 처리.
        style={{ flex: '1 1 auto', width: '100%', minHeight: 0, display: 'inline-flex' } as any}
        allowpopups={'true' as any}
      />
    </div>
  );
};
