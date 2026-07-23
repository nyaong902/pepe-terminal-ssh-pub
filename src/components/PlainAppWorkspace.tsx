import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';

type WorkspaceState = {
  editUrl?: string;
  zoom?: number;
  targetSessionId?: string;
  targetPanelId?: string;
  pairingToken?: string;
  qrContent?: string;
  requestId?: string;
  callbackUrl?: string;
  callbackUrls?: string[];
  connected?: boolean;
  connectedResponse?: {
    requestId?: string;
    deviceId?: string;
    deviceName?: string;
    httpUrls?: string[];
    httpsUrls?: string[];
    primaryUrl?: string;
    timestamp?: number;
  };
  error?: string;
};

type Props = {
  initialState?: WorkspaceState | null;
  onStateChange?: (state: WorkspaceState) => void;
  onTitleChange?: (title: string) => void;
};

type UrlCandidate = {
  label: string;
  url: string;
};

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function uniqueCandidates(urls: string[]): UrlCandidate[] {
  const seen = new Set<string>();
  const out: UrlCandidate[] = [];
  for (const raw of urls) {
    const url = String(raw || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ label: safeHostname(url), url });
  }
  return out;
}

export function PlainAppWorkspace({ initialState, onStateChange, onTitleChange }: Props) {
  const [selectedConnectionUrl, setSelectedConnectionUrl] = useState(initialState?.editUrl || '');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [connectState, setConnectState] = useState<any>(null);
  const [showUrlPopup, setShowUrlPopup] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [browserError, setBrowserError] = useState('');
  // 미러링 화면(webview)에 새로 진입할 때마다 증가시켜 webview key 에 넣는다 — plain-app 웹 UI 는
  // 화면 미러링 canvas 를 v-show(display:none) 로만 숨기고 실제로 지우지 않아서, 같은 URL 로
  // 재연결(연결 끊기→다시 QR 스캔→같은 폰)하면 새 <webview> 로 리로드되지 않는 한 이전 세션의
  // 마지막 프레임이 canvas 에 그대로 남아있는 채로 다시 보였다(폰은 아직 미러링을 시작하지도
  // 않았는데 PC 에 "미러링 중"처럼 보이는 정지화면). key 에 이 카운터를 포함시켜 매 연결마다
  // webview 를 완전히 새로 마운트(=페이지 전체 리로드)해서 stale canvas 상태를 원천 차단한다.
  const [sessionNonce, setSessionNonce] = useState(0);
  const webviewRef = useRef<any>(null);
  const webviewWrapRef = useRef<HTMLDivElement | null>(null);
  const dismissedRequestIdRef = useRef('');
  // applyConnected/이 아래 effect 안에서 "최신" selectedConnectionUrl/onStateChange 를 읽기 위한
  // ref — 이 값들을 effect 의 deps 에 넣으면 값이 바뀔 때마다 effect 가 재실행되어
  // plainAppStart() 를 또 호출하게 되는데, 그게 바로 아래에서 고치는 버그의 근본 원인이었다.
  const selectedConnectionUrlRef = useRef(selectedConnectionUrl);
  useEffect(() => { selectedConnectionUrlRef.current = selectedConnectionUrl; }, [selectedConnectionUrl]);
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => { onStateChangeRef.current = onStateChange; }, [onStateChange]);

  useEffect(() => {
    setSelectedConnectionUrl(initialState?.editUrl || '');
  }, [initialState?.editUrl]);

  // 마운트 시 딱 한 번만 plainAppStart() 를 호출한다. 이전엔 deps 에 selectedConnectionUrl/
  // initialState/onStateChange 가 들어 있어서, "취소"나 인터페이스 재선택으로 그 값들이 바뀔
  // 때마다 이 effect 가 재실행되어 plainAppStart() 를 다시 호출했다 — Electron 메인 프로세스의
  // PlainAppConnectServer.ensureStarted() 는 서버가 이미 떠 있으면 리셋 없이 그대로
  // this.state()(이전 연결의 response 를 포함)를 돌려주므로, 결국 방금 지운 이전 연결 정보가
  // 곧바로 다시 살아나 URL 선택 팝업이 옛 목록으로 재등장하는 원인이었다.
  useEffect(() => {
    let alive = true;
    const api = (window as any).api;

    const applyConnected = (payload: any) => {
      const nextRequestId = String(payload?.requestId || payload?.state?.requestId || '').trim();
      const response = payload?.response || payload?.connectedResponse;
      const nextCallbackUrl = String(payload?.callbackUrl || payload?.state?.callbackUrl || '').trim();
      const nextCallbackUrls = Array.isArray(payload?.callbackUrls)
        ? payload.callbackUrls
        : Array.isArray(payload?.state?.callbackUrls)
          ? payload.state.callbackUrls
          : [];
      setConnectState(payload);
      if (nextRequestId && dismissedRequestIdRef.current === nextRequestId) {
        setShowUrlPopup(false);
        return;
      }
      setShowUrlPopup(true);
      onStateChangeRef.current?.({
        editUrl: selectedConnectionUrlRef.current || '',
        requestId: nextRequestId,
        callbackUrl: nextCallbackUrl,
        callbackUrls: nextCallbackUrls,
        connected: true,
        connectedResponse: response,
      });
    };

    void api?.plainAppStart?.().then((state: any) => {
      if (!alive) return;
      setConnectState(state);
      if (state?.connected && state?.response) {
        applyConnected(state);
      }
    }).catch((err: any) => {
      if (!alive) return;
      setConnectState({ error: String(err?.message || err || 'plain app start failed') });
    });

    const off = api?.onPlainAppEvent?.((event: any) => {
      if (!alive) return;
      if (event?.type === 'state') {
        setConnectState(event.state);
        return;
      }
      if (event?.type === 'connected') {
        applyConnected(event);
      }
    });

    return () => {
      alive = false;
      try { off?.(); } catch {}
    };
  }, []);

  const requestId = String(connectState?.requestId || connectState?.state?.requestId || initialState?.requestId || '').trim();
  const connectionUrl = useMemo(() => selectedConnectionUrl.trim(), [selectedConnectionUrl]);
  const response = connectState?.response || connectState?.connectedResponse || {};

  useEffect(() => {
    const wv = webviewRef.current;
    if (!showBrowser || !connectionUrl || !wv) return;

    setBrowserError('');

    const handleTitle = (event: any) => {
      const clean = String(event?.title || event?.newTitle || '').trim();
      if (!clean) return;
      onTitleChange?.(`📱 pepe-connect - ${clean}`);
    };

    const handleFail = (event: any) => {
      const code = Number(event?.errorCode ?? 0);
      if (code === -3) return;
      const url = String(event?.validatedURL || event?.url || connectionUrl || '').trim();
      setBrowserError(url ? `미러링 접속 실패(${code}): ${url}` : `미러링 접속 실패(${code})`);
    };

    const handleStart = () => setBrowserError('');

    try {
      wv.addEventListener('page-title-updated', handleTitle);
      wv.addEventListener('did-fail-load', handleFail);
      wv.addEventListener('did-start-loading', handleStart);
    } catch {}

    return () => {
      try { wv.removeEventListener('page-title-updated', handleTitle); } catch {}
      try { wv.removeEventListener('did-fail-load', handleFail); } catch {}
      try { wv.removeEventListener('did-start-loading', handleStart); } catch {}
    };
  }, [showBrowser, connectionUrl, onTitleChange]);

  useEffect(() => {
    if (!showBrowser) return;
    const wrap = webviewWrapRef.current;
    const wv: any = webviewRef.current;
    if (!wrap || !wv) return;

    const syncSize = () => {
      try {
        const rect = wrap.getBoundingClientRect();
        const nextHeight = Math.max(1, Math.floor(rect.height || 0));
        wv.style.position = 'absolute';
        wv.style.inset = '0';
        wv.style.width = '100%';
        wv.style.height = '100%';
        wv.style.minWidth = '0';
        wv.style.minHeight = '0';
        wv.style.maxWidth = 'none';
        wv.style.maxHeight = 'none';
        wv.style.display = 'flex';
        wv.style.background = '#fff';
        if (nextHeight > 1) {
          const prevHeight = wrap.style.height;
          wrap.style.height = `${nextHeight - 1}px`;
          window.requestAnimationFrame(() => {
            if (webviewWrapRef.current === wrap) wrap.style.height = prevHeight;
          });
        }
      } catch {}
    };

    syncSize();
    const ro = new ResizeObserver(syncSize);
    ro.observe(wrap);
    const timer = window.setTimeout(syncSize, 100);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [showBrowser, connectionUrl]);

  const interfaceCandidates = useMemo(() => {
    const urls = [
      ...(Array.isArray(connectState?.callbackUrls) ? connectState.callbackUrls : []),
      ...(Array.isArray(connectState?.state?.callbackUrls) ? connectState.state.callbackUrls : []),
      connectState?.callbackUrl,
      connectState?.state?.callbackUrl,
    ]
      .map((url: any) => String(url || '').trim())
      .filter(Boolean);
    const byHost = new Map<string, UrlCandidate>();
    for (const candidate of uniqueCandidates(urls)) {
      const host = candidate.label;
      if (!byHost.has(host)) byHost.set(host, candidate);
    }
    return Array.from(byHost.values());
  }, [connectState?.callbackUrls, connectState?.callbackUrl, connectState?.state?.callbackUrls, connectState?.state?.callbackUrl]);

  // VideoDecoder/AudioDecoder(WebCodecs) 는 secure context(HTTPS)에서만 존재하므로 미러링에는
  // http:// 주소가 애초에 쓸모없다 — 팝업에서 아예 제외해 사용자가 잘못 고르지 않게 한다.
  const serviceCandidates = useMemo(() => {
    const urls = [
      ...(Array.isArray(response?.httpsUrls) ? response.httpsUrls : []),
      response?.primaryUrl,
    ]
      .map((url: any) => String(url || '').trim())
      .filter(Boolean)
      .filter(url => url.startsWith('https://'));
    return Array.from(new Set(urls));
  }, [response?.httpsUrls, response?.primaryUrl]);

  const qrPayload = selectedConnectionUrl && requestId
    ? `plainapp://pepe-connect?r=${encodeURIComponent(requestId)}&u=${encodeURIComponent(selectedConnectionUrl)}`
    : String(connectState?.qrContent || '').trim();

  useEffect(() => {
    if (!qrPayload) {
      setQrDataUrl(null);
      return;
    }

    let alive = true;
    void QRCode.toDataURL(qrPayload, {
      width: 256,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#e6edf3', light: '#07111b' },
    })
      .then(dataUrl => { if (alive) setQrDataUrl(dataUrl); })
      .catch(() => { if (alive) setQrDataUrl(null); });
    return () => { alive = false; };
  }, [qrPayload]);

  // 서버(포트/네트워크 인터페이스 목록)는 그대로 두고 requestId 만 새로 발급한다 — 렌더러 쪽
  // state 만 지우고 서버를 안 건드리면 다음 plainAppStart() 호출(재마운트 등 어떤 경로로든)
  // 때 이전 response 가 되살아나서 URL 선택 팝업이 옛 목록으로 재등장했었다. 반대로 stop→start
  // 로 서버 자체를 내렸다 올리면 네트워크 인터페이스 재수집 + 포트 재바인딩이 다시 일어나
  // QR 이 잠깐 사라지는 깜빡임이 생겼다 — IP 목록은 그대로 유지하고 QR(requestId)만 바꾸는
  // resetRequest() 가 정확히 필요한 만큼만 리셋한다. "취소"/"인터페이스 재선택"/"연결 끊기"
  // 모두 이걸로 통일.
  const resetPairingRequest = async () => {
    const api = (window as any).api;
    try {
      const next = await api?.plainAppResetRequest?.();
      if (next) setConnectState(next);
    } catch (err: any) {
      setConnectState((prev: any) => ({ ...(prev || {}), error: String(err?.message || err || 'reset failed') }));
    }
  };

  // IP(네트워크 인터페이스) 목록은 자동으로 갱신하지 않는다 — 사용자가 명시적으로 이 버튼을
  // 눌렀을 때만 서버를 완전히 stop→start 해서 목록을 다시 수집한다.
  const [refreshingInterfaces, setRefreshingInterfaces] = useState(false);
  const handleRefreshInterfaces = async () => {
    const api = (window as any).api;
    setRefreshingInterfaces(true);
    try {
      await api?.plainAppStop?.();
      const restarted = await api?.plainAppStart?.();
      if (restarted) setConnectState(restarted);
    } catch (err: any) {
      setConnectState({ error: String(err?.message || err || 'refresh failed') });
    } finally {
      setRefreshingInterfaces(false);
    }
  };

  const handleChooseInterface = (candidate: UrlCandidate) => {
    setSelectedConnectionUrl(candidate.url);
    setShowBrowser(false);
    setShowUrlPopup(false);
    dismissedRequestIdRef.current = '';
    onStateChange?.({ editUrl: candidate.url });
    void resetPairingRequest();
  };

  const handleOpenService = (url: string) => {
    const chosen = String(url || '').trim();
    if (!chosen) return;
    dismissedRequestIdRef.current = requestId;
    setSelectedConnectionUrl(chosen);
    setShowUrlPopup(false);
    setShowBrowser(true);
    setBrowserError('');
    setSessionNonce(n => n + 1);
    // 여기도 initialState 를 이어받지 않는다 — 실제로 방금 폰이 보낸 최신 response/requestId 만
    // 저장해야, 다음에 취소/연결끊기로 지운 뒤 재연결할 때 과거 값이 섞여 들어가지 않는다.
    onStateChange?.({
      editUrl: chosen,
      requestId: connectState?.requestId || connectState?.state?.requestId,
      callbackUrl: connectState?.callbackUrl || connectState?.state?.callbackUrl,
      callbackUrls: connectState?.callbackUrls || connectState?.state?.callbackUrls,
      connected: true,
      connectedResponse: response,
    });
  };

  // 탭에 영속 저장된 이전 연결 정보(선택했던 IP, 이전 응답의 httpUrls/httpsUrls 목록)를 지운다 —
  // 렌더러 state 만 지우고 서버를 안 건드리면(예전 버그) 아무 소용 없으므로 항상
  // resetPairingRequest() 와 함께 호출한다. "연결 끊기"와 URL 선택 팝업의 "취소" 둘 다 호출.
  const clearStoredConnectionInfo = () => {
    setSelectedConnectionUrl('');
    onStateChange?.({});
    void resetPairingRequest();
  };

  const handleDisconnect = () => {
    dismissedRequestIdRef.current = '';
    // webview 를 치우기 전에, 그 안에서 돌고 있는 웹 UI(ScreenMirrorView)가 등록해 둔
    // window.__pepeStopMirror 브릿지를 호출해 폰의 미러링을 정지시킨다. webview 가
    // 사라진 뒤에는 이 페이지의 JS 컨텍스트 자체가 없어져 더 이상 호출할 방법이 없다.
    // GraphQL mutation 을 PC 쪽에서 직접(별도 fetch 로) 쏘는 방식 대신, 이미 인증/암호화
    // 컨텍스트를 갖춘 웹뷰 내부 스크립트를 그대로 재사용하는 쪽이 훨씬 안전하다.
    //
    // 여기서 반드시 executeJavaScript() 의 Promise 가 끝날 때까지 기다린 뒤에 webview 를
    // 언마운트해야 한다 — 예전엔 await 없이 바로 setShowBrowser(false) 를 호출했는데, 그러면
    // JSX 조건부 렌더링에 의해 webview(따라서 그 프로세스의 JS 컨텍스트)가 즉시 파괴되어
    // stopScreenMirror GraphQL mutation 요청이 실제로 네트워크에 나가기도 전에 취소되는
    // 경쟁 상태가 있었다. 그 결과 폰은 여전히 미러링이 켜진 채로 남아, 재연결 시 상태가
    // 어긋나(폰은 "이미 스트리밍 중", PC 는 새 세션 시작) 연결이 비정상적으로 늦게 붙거나
    // 아예 실패하는 버그로 이어졌다.
    const finishDisconnect = () => {
      setShowBrowser(false);
      setShowUrlPopup(false);
      setBrowserError('');
      clearStoredConnectionInfo();
    };
    const wv = webviewRef.current as any;
    const stopPromise: Promise<any> | undefined = wv?.executeJavaScript?.(
      'typeof window.__pepeStopMirror === "function" ? window.__pepeStopMirror() : undefined',
    );
    if (stopPromise && typeof stopPromise.then === 'function') {
      // stopScreenMirror 응답이 비정상적으로 늦어 UI 가 멈춘 것처럼 보이지 않도록 짧은
      // 타임아웃을 둔다 — 실패하든 성공하든 결국 webview 를 정리하는 게 목적이라 응답
      // 내용 자체는 신경 쓰지 않는다.
      Promise.race([
        stopPromise.catch(() => undefined),
        new Promise(resolve => setTimeout(resolve, 1500)),
      ]).then(finishDisconnect);
    } else {
      finishDisconnect();
    }
  };

  const connected = !!connectState?.connected || !!connectState?.response;

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minWidth: 0, minHeight: 0, background: 'linear-gradient(180deg, #08111b 0%, #050a12 100%)' }}>
      <div
        style={{
          flex: '0 0 auto',
          padding: '12px 14px',
          borderBottom: '1px solid rgba(122, 162, 255, 0.18)',
          background: 'linear-gradient(180deg, rgba(15,21,33,0.98), rgba(8,12,18,0.98))',
          color: 'var(--win-text, #e6edf3)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 15, letterSpacing: '-0.02em' }}>📱 Pepe-Connect</div>
            <div style={{ color: 'var(--win-text-dim, #8aa0b5)', fontSize: 12, marginTop: 3 }}>
              휴대폰이 QR을 읽으면 앱이 열리고, 접속 후보 URL은 팝업으로 받아 선택합니다.
            </div>
          </div>
          <div style={{ fontSize: 11, color: connected ? '#8ef0b6' : connectState?.error ? '#ffb4b4' : '#8aa0b5', fontWeight: 700 }}>
            {connected ? '연결 정보 수신됨' : connectState?.error ? 'QR 오류' : 'QR 대기 중'}
          </div>
        </div>
      </div>

      {showBrowser && connectionUrl ? (
        <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: '0 0 auto', padding: '10px 12px', borderBottom: '1px solid rgba(122, 162, 255, 0.12)', color: '#cfe2ff', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ fontWeight: 800 }}>연결 URL</span>
              <code style={{ color: '#e6edf3', background: 'rgba(255,255,255,0.04)', padding: '3px 8px', borderRadius: 999, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 'min(72vw, 900px)' }}>
                {connectionUrl}
              </code>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => { try { (webviewRef.current as any)?.openDevTools?.(); } catch {} }}
                title="개발자 도구 열기 (미러링 연결 문제 진단용)"
                style={{
                  border: '1px solid rgba(122, 162, 255, 0.28)',
                  background: 'linear-gradient(180deg, rgba(21,31,46,0.98), rgba(12,18,28,0.98))',
                  color: '#e6edf3',
                  borderRadius: 999,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {'<>'}
              </button>
              <button
                onClick={handleDisconnect}
                style={{
                  border: '1px solid rgba(255, 120, 120, 0.32)',
                  background: 'linear-gradient(180deg, rgba(120, 28, 28, 0.98), rgba(72, 16, 16, 0.98))',
                  color: '#fff',
                  borderRadius: 999,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                연결 끊기
              </button>
            </div>
          </div>
          <div ref={webviewWrapRef} style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, position: 'relative', background: '#fff', overflow: 'hidden' }}>
            <webview
              key={`${connectionUrl}#${sessionNonce}`}
              ref={webviewRef}
              src={connectionUrl}
              partition="persist:pepe-connect"
              allowpopups
              style={{ width: '100%', height: '100%', border: 'none', display: 'block', background: '#fff' }}
            />
            {browserError ? (
              <div style={{
                position: 'absolute',
                left: 12,
                right: 12,
                bottom: 12,
                padding: '10px 12px',
                borderRadius: 12,
                background: 'rgba(111, 23, 23, 0.92)',
                color: '#fff',
                fontSize: 12,
                boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
              }}>
                {browserError}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, display: 'grid', placeItems: 'center', padding: 20 }}>
          <div style={{
            width: 'min(100%, 420px)',
            borderRadius: 20,
            border: '1px solid rgba(122, 162, 255, 0.18)',
            background: 'linear-gradient(180deg, rgba(12,18,28,0.96), rgba(7,10,16,0.98))',
            boxShadow: '0 18px 40px rgba(0,0,0,0.32)',
            padding: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            alignItems: 'center',
          }}>
            <div style={{ width: 268, height: 268, borderRadius: 18, padding: 10, background: 'radial-gradient(circle at 50% 30%, rgba(74, 107, 168, 0.24), rgba(4, 9, 16, 0.95))', display: 'grid', placeItems: 'center' }}>
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="pepe-connect QR" style={{ width: 256, height: 256, borderRadius: 12, background: '#07111b' }} />
              ) : (
                <div style={{ color: '#9ab0c3', fontSize: 12 }}>QR 생성 중...</div>
              )}
            </div>

            <div style={{ textAlign: 'center', color: '#dbe7f3' }}>
            <div style={{ fontWeight: 900, fontSize: 16 }}>Pepe-Connect를 스캔하세요</div>
              <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.7, color: '#9ab0c3' }}>
                선택한 인터페이스 주소를 담은 앱 딥링크 QR입니다. 모바일 기본 카메라로 읽으면 Pepe-Connect 앱이 열려야 합니다.
              </div>
            </div>

            {connectState?.error ? (
              <div style={{ fontSize: 11, color: '#ffb4b4', lineHeight: 1.6, textAlign: 'center' }}>
                {connectState.error}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: '#7f94aa', lineHeight: 1.6, textAlign: 'center' }}>
                {connectState?.callbackUrl ? '앱이 연결 정보를 보내면 URL 후보 팝업이 뜹니다.' : 'QR 생성 중...'}
              </div>
            )}

            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch', marginTop: 4 }}>
              {interfaceCandidates.length > 0 ? interfaceCandidates.map(candidate => (
                <button
                  key={candidate.url}
                  onClick={() => handleChooseInterface(candidate)}
                  style={{
                    width: '100%',
                    border: '1px solid rgba(122, 162, 255, 0.22)',
                    background: String(candidate.url) === connectionUrl
                      ? 'linear-gradient(180deg, rgba(48,73,112,0.98), rgba(20,31,48,0.98))'
                      : 'linear-gradient(180deg, rgba(21,31,46,0.98), rgba(12,18,28,0.98))',
                    color: '#e6edf3',
                    borderRadius: 12,
                    padding: '10px 12px',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontSize: 12,
                    lineHeight: 1.5,
                    wordBreak: 'break-all',
                  }}
                >
                  {candidate.label}
                </button>
              )) : (
                <div style={{ fontSize: 12, color: '#9ab0c3', lineHeight: 1.7 }}>
                  네트워크 인터페이스를 아직 찾지 못했어요.
                </div>
              )}
              <button
                onClick={handleRefreshInterfaces}
                disabled={refreshingInterfaces}
                style={{
                  width: '100%',
                  border: '1px dashed rgba(122, 162, 255, 0.3)',
                  background: 'transparent',
                  color: '#9ab0c3',
                  borderRadius: 12,
                  padding: '8px 12px',
                  textAlign: 'center',
                  cursor: refreshingInterfaces ? 'default' : 'pointer',
                  fontSize: 12,
                  opacity: refreshingInterfaces ? 0.6 : 1,
                }}
              >
                {refreshingInterfaces ? '갱신 중...' : '↻ 목록 갱신'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUrlPopup ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 30,
            background: 'rgba(2, 6, 11, 0.72)',
            backdropFilter: 'blur(8px)',
            display: 'grid',
            placeItems: 'center',
            padding: 20,
          }}
        >
          <div style={{
            width: 'min(100%, 620px)',
            maxHeight: 'min(88vh, 860px)',
            overflow: 'auto',
            borderRadius: 20,
            border: '1px solid rgba(122, 162, 255, 0.22)',
            background: 'linear-gradient(180deg, rgba(12,18,28,0.98), rgba(7,10,16,0.99))',
            boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
            padding: 18,
            color: '#dbe7f3',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 17 }}>서비스 URL 선택</div>
                <div style={{ marginTop: 4, color: '#9ab0c3', fontSize: 12 }}>
                  모바일이 전달한 서비스 주소 목록입니다. 하나를 선택하면 미러링 화면으로 이동합니다.
                </div>
              </div>
              <button
                onClick={() => {
                  dismissedRequestIdRef.current = requestId;
                  setShowUrlPopup(false);
                  clearStoredConnectionInfo();
                }}
                style={{
                  border: '1px solid rgba(122, 162, 255, 0.2)',
                  background: 'linear-gradient(180deg, rgba(21,31,46,0.98), rgba(12,18,28,0.98))',
                  color: '#e6edf3',
                  borderRadius: 999,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                취소
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {serviceCandidates.length > 0 ? serviceCandidates.map(url => (
                <button
                  key={url}
                  onClick={() => handleOpenService(url)}
                  style={{
                    width: '100%',
                    border: '1px solid rgba(122, 162, 255, 0.22)',
                    background: 'linear-gradient(180deg, rgba(21,31,46,0.98), rgba(12,18,28,0.98))',
                    color: '#e6edf3',
                    borderRadius: 14,
                    padding: '12px 14px',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontSize: 13,
                    lineHeight: 1.5,
                    wordBreak: 'break-all',
                  }}
                >
                  {url}
                </button>
              )) : (
                <div style={{ color: '#9ab0c3', fontSize: 13, lineHeight: 1.7 }}>
                  전달된 서비스 URL이 없습니다.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
