import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation('remoteShare');
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
            <span className="remote-share-kicker">{t('badge')}</span>
            <h2>{t('title')}</h2>
          </div>
          <button className="remote-share-close" onClick={onClose} aria-label={t('close')}>×</button>
        </header>

        <div className={`remote-share-status ${state.running ? 'running' : ''}`}>
          <span className="remote-share-status-dot" />
          <div>
            <strong>{state.running ? t('status.running') : t('status.stopped')}</strong>
            <small>{state.running ? t('status.clients', { count: state.clients }) : t('status.stoppedHelp')}</small>
          </div>
        </div>

        {state.running ? (
          <>
            <div className="remote-share-card">
              <label>{t('address')}</label>
              <button className="remote-share-address" onClick={copyAddress}>
                <span>{state.address}</span>
                <em>{copied ? t('copied') : t('copy')}</em>
              </button>
              <label>{state.pinMode === 'fixed' ? t('pin.fixed') : t('pin.oneTime')}</label>
              <div className={`remote-share-pin ${state.pinMode === 'fixed' ? 'fixed' : ''}`}>
                {state.pinMode === 'fixed' ? t('pin.fixedActive') : state.pin}
              </div>
            </div>
            <p className="remote-share-note">{t('runningHelp')}</p>
            <button className="remote-share-primary stop" disabled={busy} onClick={stop}>{t('stop')}</button>
          </>
        ) : (
          <>
            <div className={`remote-share-tailscale ${state.tailscale.connected ? 'connected' : 'warning'}`}>
              <span className="remote-share-status-dot" />
              <div>
                <strong>
                  {!state.tailscale.installed
                    ? t('tailscale.installRequired')
                    : state.tailscale.connected
                      ? t('tailscale.connected')
                      : t('tailscale.connectionRequired')}
                </strong>
                <small>
                  {!state.tailscale.installed
                    ? t('tailscale.installHelp')
                    : state.tailscale.connected
                      ? state.tailscale.address
                      : t('tailscale.connectionHelp')}
                </small>
              </div>
            </div>
            <div className="remote-share-intro">
              <strong>{t('intro.title')}</strong>
              <p>{t('intro.body')}</p>
            </div>
            <div className="remote-share-pin-settings">
              <label className={pinMode === 'random' ? 'selected' : ''}>
                <input type="radio" name="remote-pin-mode" checked={pinMode === 'random'} onChange={() => setPinMode('random')} />
                <span><strong>{t('pin.random')}</strong><small>{t('pin.randomHelp')}</small></span>
              </label>
              <label className={pinMode === 'fixed' ? 'selected' : ''}>
                <input type="radio" name="remote-pin-mode" checked={pinMode === 'fixed'} onChange={() => setPinMode('fixed')} />
                <span><strong>{t('pin.fixed')}</strong><small>{t('pin.fixedHelp')}</small></span>
              </label>
              {pinMode === 'fixed' && (
                <input
                  className="remote-share-fixed-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  placeholder={t('pin.placeholder')}
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
              {busy ? t('starting') : t('start')}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
