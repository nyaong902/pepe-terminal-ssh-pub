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
  const [proxyState, setProxyState] = useState<{ proxyId: string; localPort: number; panelId: string } | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string>('');
  const [testOk, setTestOk] = useState(false);
  const proxySeqRef = useRef(0);
  const lastAutoLoadedRef = useRef<string>('');
  const liveTargets = connectedSessions.length > 0 ? connectedSessions : sshTargets;

  const currentProxyLabel = useMemo(() => {
    if (!targetSessionId) return t('directConnect');
    const stored = storedSessions.find(s => s.id === targetSessionId);
    const match = liveTargets.find(t => t.sessionId === targetSessionId);
    const title = stored?.name?.trim() || match?.sessionName || match?.sessionId || targetSessionId;
    return `${title}${match?.host ? ` (${match.host}${match.port && match.port !== 22 ? `:${match.port}` : ''})` : ''}`;
  }, [liveTargets, storedSessions, targetSessionId]);

  const resolvePanelLabelForDisplay = (sessionId: string) => {
    const stored = storedSessions.find(s => s.id === sessionId);
    const active = liveTargets.find(t => t.sessionId === sessionId);
    return stored?.name?.trim() || active?.sessionName || active?.sessionId || sessionId;
  };

  const resolveBrowserUrlForSession = (sessionId: string) => {
    const storedUrl = storedSessions.find(s => s.id === sessionId)?.browserUrl?.trim();
    if (storedUrl) return storedUrl;
    const active = sshTargets.find(t => t.sessionId === sessionId) || connectedSessions.find(t => t.sessionId === sessionId);
    const activeUrl = active?.browserUrl?.trim();
    if (activeUrl) return activeUrl;
    return '';
  };

  const connectedSessionTargets = useMemo(() => {
    const seen = new Set<string>();
    return liveTargets.filter(t => {
      const sid = t.sessionId?.trim();
      if (!sid || seen.has(sid)) return false;
      seen.add(sid);
      return true;
    });
  }, [liveTargets]);

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
      setStoredSessions(sessions.map((s: any) => ({ id: String(s.id || ''), name: s.name, browserUrl: s.browserUrl })));
    } catch {}
  };

  useEffect(() => {
    refreshSshTargets();
    const timer = window.setInterval(refreshSshTargets, 4000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!targetSessionId) return;
    const active = liveTargets.find(t => t.sessionId === targetSessionId);
    if (!active) {
      setTargetPanelId('');
      setTargetSessionId('');
      return;
    }
    setTargetPanelId(active.panelId || '');
    if (proxyState?.panelId === active.panelId) return;
  }, [liveTargets, targetSessionId, proxyState?.panelId]);

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
        try { await (window as any).api?.sshCloseSocksProxy?.({ proxyId: cur.proxyId }); } catch {}
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
      await (window as any).api?.setWebviewProxy?.({ webContentsId, proxyRules: `socks5://127.0.0.1:${r.localPort}` });
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

  useEffect(() => {
    if (!targetPanelId) return;
    applyProxyForPanel(targetPanelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPanelId]);

  useEffect(() => {
    if (!proxyState) return;
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

  useEffect(() => {
    const wv: any = webviewRef.current;
    if (!wv) return;
    const onNav = () => {
      try { setEditUrl(wv.getURL()); } catch {}
      try { setCanBack(wv.canGoBack()); setCanFwd(wv.canGoForward()); } catch {}
    };
    const onStart = () => setLoading(true);
    const onStop = () => { setLoading(false); onNav(); };
    const onTitle = (e: any) => onTitleChange?.(e.title || '');
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
    return () => {
      try {
        wv.removeEventListener('did-navigate', onNav);
        wv.removeEventListener('did-navigate-in-page', onNav);
        wv.removeEventListener('did-start-loading', onStart);
        wv.removeEventListener('did-stop-loading', onStop);
        wv.removeEventListener('page-title-updated', onTitle);
        wv.removeEventListener('did-fail-load', onFail);
      } catch {}
    };
  }, [onTitleChange]);

  const resolveBrowserUrl = (target: string) => {
    let t = target.trim();
    if (!t) return '';
    if (!/^[a-z]+:\/\//i.test(t)) {
      // URL 형태가 아니면 (공백 또는 점이 없으면) 구글 검색으로 폴백
      if (!t.includes('.') && !t.includes(':')) {
        t = 'https://www.google.com/search?q=' + encodeURIComponent(t);
      } else {
        t = 'https://' + t;
      }
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
      const testPanelId = targetPanelId || (liveTargets.find(t => t.sessionId === targetSessionId)?.panelId || '');
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
    try { wv.addEventListener('before-input-event', onInput); } catch {}
    return () => { try { wv.removeEventListener('before-input-event', onInput); } catch {} };
  }, [zoom]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: '#1a1a1a' }}>
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
          {connectedSessionTargets.map(tgt => {
            const sid = tgt.sessionId || '';
            return (
            <option key={tgt.panelId} value={sid}>
              {resolvePanelLabelForDisplay(sid)}
              {tgt.host ? ` (${tgt.host}${tgt.port && tgt.port !== 22 ? `:${tgt.port}` : ''})` : ''}
              {resolveBrowserUrlForSession(sid) ? ' · ' + resolveBrowserUrlForSession(sid) : ''}
            </option>
          )})}
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
        style={{ flex: 1, width: '100%', display: 'flex' } as any}
        allowpopups={'true' as any}
      />
    </div>
  );
};
