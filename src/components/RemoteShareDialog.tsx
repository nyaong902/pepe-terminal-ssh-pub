import { useEffect, useState } from 'react';

type ShareState = {
  running: boolean;
  address: string;
  pin: string;
  pinMode: 'random' | 'fixed';
  port: number;
  clients: number;
  tailscale: {
    installed: boolean;
    connected: boolean;
    address: string;
  };
  error?: string;
};

type RemoteShareApi = {
  remoteShareState?: () => Promise<ShareState>;
  remoteShareStart?: (options?: { port?: number; pinMode?: 'random' | 'fixed'; fixedPin?: string }) => Promise<ShareState>;
  remoteShareStop?: () => Promise<ShareState>;
};

const EMPTY_STATE: ShareState = {
  running: false,
  address: '',
  pin: '',
  pinMode: 'random',
  port: 17800,
  clients: 0,
  tailscale: {
    installed: false,
    connected: false,
    address: '',
  },
};

export function RemoteShareDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<ShareState>(EMPTY_STATE);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pinMode, setPinMode] = useState<'random' | 'fixed'>(() => (
    localStorage.getItem('remoteSharePinMode') === 'fixed' ? 'fixed' : 'random'
  ));
  const [fixedPin, setFixedPin] = useState(() => localStorage.getItem('remoteShareFixedPin') || '');
  const api = window.api as RemoteShareApi | undefined;

  useEffect(() => {
    api?.remoteShareState?.().then((next) => setState(next || EMPTY_STATE));
    const timer = setInterval(() => {
      api?.remoteShareState?.().then((next) => setState(next || EMPTY_STATE)).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [api]);

  const start = async () => {
    if (pinMode === 'fixed' && !/^\d{6}$/.test(fixedPin)) return;
    setBusy(true);
    try {
      localStorage.setItem('remoteSharePinMode', pinMode);
      if (pinMode === 'fixed') localStorage.setItem('remoteShareFixedPin', fixedPin);
      const next = await api?.remoteShareStart?.({ port: state.port, pinMode, fixedPin });
      setState(next || EMPTY_STATE);
      if (next?.running) {
        onClose();
      }
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
    const text = state.pinMode === 'random'
      ? `${state.address}\nPIN: ${state.pin}`
      : state.address;
    await navigator.clipboard.writeText(text);
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
              <label>{state.pinMode === 'fixed' ? '고정 PIN' : '일회용 PIN'}</label>
              <div className={`remote-share-pin ${state.pinMode === 'fixed' ? 'fixed' : ''}`}>
                {state.pinMode === 'fixed' ? '고정 PIN 사용 중' : state.pin}
              </div>
            </div>
            <p className="remote-share-note">같은 Tailscale 네트워크의 PC나 휴대폰 브라우저에서 주소를 열고 PIN을 입력하세요.</p>
            <button className="remote-share-primary stop" disabled={busy} onClick={stop}>원격 공유 중지</button>
          </>
        ) : (
          <>
            <div className={`remote-share-tailscale ${state.tailscale.connected ? 'connected' : 'warning'}`}>
              <span className="remote-share-status-dot" />
              <div>
                <strong>
                  {!state.tailscale.installed
                    ? 'Tailscale 설치 필요'
                    : state.tailscale.connected
                      ? 'Tailscale 연결됨'
                      : 'Tailscale 연결 필요'}
                </strong>
                <small>
                  {!state.tailscale.installed
                    ? '먼저 Tailscale을 설치하고 로그인해 주세요.'
                    : state.tailscale.connected
                      ? state.tailscale.address
                      : 'Tailscale을 실행하고 네트워크 연결 상태를 확인해 주세요.'}
                </small>
              </div>
            </div>
            <div className="remote-share-intro">
              <strong>PePe 창만 공유합니다.</strong>
              <p>Windows 바탕화면이나 다른 프로그램은 보이지 않습니다. 연결된 브라우저에서는 PePe 내부 클릭, 스크롤, 키보드 입력을 제어할 수 있습니다.</p>
            </div>
            <div className="remote-share-pin-settings">
              <label className={pinMode === 'random' ? 'selected' : ''}>
                <input type="radio" name="remote-pin-mode" checked={pinMode === 'random'} onChange={() => setPinMode('random')} />
                <span><strong>랜덤 PIN</strong><small>공유를 시작할 때마다 새 PIN 생성</small></span>
              </label>
              <label className={pinMode === 'fixed' ? 'selected' : ''}>
                <input type="radio" name="remote-pin-mode" checked={pinMode === 'fixed'} onChange={() => setPinMode('fixed')} />
                <span><strong>고정 PIN</strong><small>항상 같은 6자리 PIN 사용</small></span>
              </label>
              {pinMode === 'fixed' && (
                <input
                  className="remote-share-fixed-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  placeholder="숫자 6자리"
                  value={fixedPin}
                  onChange={e => setFixedPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
              )}
            </div>
            {state.error && <div className="remote-share-error">{state.error}</div>}
            <button
              className="remote-share-primary"
              disabled={busy || !state.tailscale.connected || (pinMode === 'fixed' && !/^\d{6}$/.test(fixedPin))}
              onClick={start}
            >
              {busy ? '공유 서버 여는 중...' : '원격 공유 시작'}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
