import { useEffect, useState } from 'react';

type ShareState = {
  running: boolean;
  address: string;
  pin: string;
  port: number;
  clients: number;
  error?: string;
};

type RemoteShareApi = {
  remoteShareState?: () => Promise<ShareState>;
  remoteShareStart?: (port?: number) => Promise<ShareState>;
  remoteShareStop?: () => Promise<ShareState>;
};

const EMPTY_STATE: ShareState = {
  running: false,
  address: '',
  pin: '',
  port: 17800,
  clients: 0,
};

export function RemoteShareDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<ShareState>(EMPTY_STATE);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const api = window.api as RemoteShareApi | undefined;

  useEffect(() => {
    api?.remoteShareState?.().then((next) => setState(next || EMPTY_STATE));
    const timer = setInterval(() => {
      api?.remoteShareState?.().then((next) => setState(next || EMPTY_STATE)).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [api]);

  const start = async () => {
    setBusy(true);
    try {
      const next = await api?.remoteShareStart?.(state.port);
      setState(next || EMPTY_STATE);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const next = await api?.remoteShareStop?.();
      setState(next || EMPTY_STATE);
    } finally {
      setBusy(false);
    }
  };

  const copyAddress = async () => {
    if (!state.address) return;
    await navigator.clipboard.writeText(`${state.address}\nPIN: ${state.pin}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="session-editor-backdrop remote-share-backdrop" onMouseDown={e => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <section className="remote-share-dialog" onMouseDown={e => e.stopPropagation()}>
        <header>
          <div>
            <span className="remote-share-kicker">TAILSCALE ONLY</span>
            <h2>PePe 원격 공유</h2>
          </div>
          <button className="remote-share-close" onClick={onClose} aria-label="닫기">×</button>
        </header>

        <div className={`remote-share-status ${state.running ? 'running' : ''}`}>
          <span className="remote-share-status-dot" />
          <div>
            <strong>{state.running ? '공유 중' : '공유 꺼짐'}</strong>
            <small>{state.running ? `접속 브라우저 ${state.clients}대` : '외부에서 PePe 화면을 볼 수 없습니다.'}</small>
          </div>
        </div>

        {state.running ? (
          <>
            <div className="remote-share-card">
              <label>브라우저 접속 주소</label>
              <button className="remote-share-address" onClick={copyAddress}>
                <span>{state.address}</span>
                <em>{copied ? '복사됨' : '복사'}</em>
              </button>
              <label>일회용 PIN</label>
              <div className="remote-share-pin">{state.pin}</div>
            </div>
            <p className="remote-share-note">같은 Tailscale 네트워크의 PC나 휴대폰 브라우저에서 주소를 열고 PIN을 입력하세요.</p>
            <button className="remote-share-primary stop" disabled={busy} onClick={stop}>원격 공유 중지</button>
          </>
        ) : (
          <>
            <div className="remote-share-intro">
              <strong>PePe 창만 공유합니다.</strong>
              <p>Windows 바탕화면이나 다른 프로그램은 보이지 않습니다. 연결된 브라우저에서는 PePe 내부 클릭, 스크롤, 키보드 입력을 제어할 수 있습니다.</p>
            </div>
            {state.error && <div className="remote-share-error">{state.error}</div>}
            <button className="remote-share-primary" disabled={busy} onClick={start}>{busy ? '공유 서버 여는 중...' : '원격 공유 시작'}</button>
          </>
        )}
      </section>
    </div>
  );
}
