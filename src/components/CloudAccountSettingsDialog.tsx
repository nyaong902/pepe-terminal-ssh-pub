// src/components/CloudAccountSettingsDialog.tsx
// Pepe-Box 서비스별 Client ID/Secret 입력 + 계정 연결/해제 다이얼로그.
// directWebview 서비스(네이버/카카오/iCloud)는 OAuth Connect 절차 자체가 없어 이 다이얼로그를
// 거치지 않고 바로 webview 탭이 열리므로(PepeBoxWorkspace.handleServiceClick), 여기서는 항상
// OAuth Client ID/Secret 입력이 필요한 서비스(Dropbox/Google Drive/OneDrive)만 다룬다.
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CloudServiceMeta } from './PepeBoxWorkspace';

const api = (window as any).api || {};

// provider 별 단계별 연동 가이드 — 실제로 사용자가 겪었던 실패 지점(스코프 미설정, API 미활성화,
// 테스트 사용자 미등록, redirect URI 위치 헷갈림 등)을 그대로 체크리스트로 만들어 반복을 막는다.
// url 이 있는 단계는 클릭하면 시스템 브라우저로 해당 콘솔 페이지를 바로 연다.
type GuideStep = { textKey: string; url?: string };
const CONSOLE_GUIDE: Partial<Record<string, GuideStep[]>> = {
  dropbox: [
    { textKey: 'settings.guide.dropbox1', url: 'https://www.dropbox.com/developers/apps' },
    { textKey: 'settings.guide.dropbox2' },
    { textKey: 'settings.guide.dropbox3' },
    { textKey: 'settings.guide.dropbox4' },
    { textKey: 'settings.guide.dropbox5' },
  ],
  gdrive: [
    { textKey: 'settings.guide.gdrive1', url: 'https://console.cloud.google.com/apis/library/drive.googleapis.com' },
    { textKey: 'settings.guide.gdrive2', url: 'https://console.cloud.google.com/auth/clients' },
    { textKey: 'settings.guide.gdrive3' },
    { textKey: 'settings.guide.gdrive4' },
    { textKey: 'settings.guide.gdrive5', url: 'https://console.cloud.google.com/auth/audience' },
    { textKey: 'settings.guide.gdrive6' },
  ],
  onedrive: [
    { textKey: 'settings.guide.onedrive1', url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' },
    { textKey: 'settings.guide.onedrive2' },
    { textKey: 'settings.guide.onedrive3' },
  ],
};

type Props = {
  service: CloudServiceMeta;
  onClose: () => void;
  onConnected: () => void;
};

export const CloudAccountSettingsDialog: React.FC<Props> = ({ service, onClose, onConnected }) => {
  const { t } = useTranslation('pepeBox');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  // main 프로세스(electron/cloudOAuthServer.ts 의 OAUTH_FIXED_PORTS/OAUTH_REDIRECT_HOST)에서
  // 직접 받아온다 — 이전에는 이 값을 렌더러에 그대로 복제해뒀는데, 포트를 한쪽만 바꾸면 사용자에게
  // 실제 서버와 다른 redirect URI 를 안내하게 되는 문제가 있어 단일 출처로 통합했다.
  const [redirectUri, setRedirectUri] = useState('');
  const copyResetTimerRef = useRef<number | null>(null);

  const handleCopyRedirectUri = async () => {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  useEffect(() => () => { if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current); }, []);

  const openExternal = (url: string) => { api.shellOpenExternal?.(url); };

  useEffect(() => {
    api.cloudboxGetProviderSettings?.(service.kind).then((s: any) => {
      setClientId(s?.clientId || '');
      setHasSecret(!!s?.hasSecret);
    });
    api.cloudboxListProviders?.().then((list: any[]) => {
      const found = list?.find((p: any) => p.kind === service.kind);
      if (found?.redirectUri) setRedirectUri(found.redirectUri);
    });
  }, [service.kind]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await api.cloudboxSaveProviderSettings?.(service.kind, clientId.trim(), clientSecret);
      if (!res?.ok) setError(res?.error || t('settings.saveFailed'));
      else { setHasSecret(hasSecret || !!clientSecret); setClientSecret(''); }
    } finally {
      setSaving(false);
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    setError('');
    try {
      const res = await api.cloudboxConnect?.(service.kind);
      if (res?.error) setError(res.error);
      else { onConnected(); onClose(); }
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="pepebox-modal-overlay" onClick={onClose}>
      <div className="pepebox-modal" onClick={e => e.stopPropagation()}>
        <div className="pepebox-modal-header">
          <span className="pepebox-modal-icon">{service.icon}</span>
          <h3>{service.label}</h3>
          <button className="pepebox-modal-close" onClick={onClose}>✕</button>
        </div>

        {CONSOLE_GUIDE[service.kind] && (
          <div className="pepebox-guide">
            <div className="pepebox-guide-title">{t('settings.guideTitle')}</div>
            <ol className="pepebox-guide-list">
              {CONSOLE_GUIDE[service.kind]!.map((step, i) => (
                <li key={i}>
                  {t(step.textKey)}
                  {step.url && (
                    <button type="button" className="pepebox-guide-link" onClick={() => openExternal(step.url!)}>
                      {step.url.replace(/^https?:\/\//, '')} ↗
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="pepebox-redirect-banner">
          <div>{t('settings.redirectUriLabel')}</div>
          <div className="pepebox-redirect-row">
            <code>{redirectUri || '...'}</code>
            <button type="button" disabled={!redirectUri} onClick={handleCopyRedirectUri}>{copied ? t('settings.copied') : t('settings.copy')}</button>
          </div>
          <small>{t('settings.redirectUriHelp')}</small>
        </div>

        <label className="pepebox-field">
          <span>{t('settings.clientId')}</span>
          <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder={t('settings.clientIdPlaceholder')} />
        </label>
        <label className="pepebox-field">
          <span>{t('settings.clientSecret')}</span>
          <input
            type="password"
            value={clientSecret}
            onChange={e => setClientSecret(e.target.value)}
            placeholder={hasSecret ? t('settings.clientSecretSaved') : t('settings.clientSecretPlaceholder')}
          />
        </label>
        {error && <div className="pepebox-error">{error}</div>}
        <div className="pepebox-modal-actions">
          <button disabled={saving} onClick={handleSave}>{saving ? t('settings.saving') : t('settings.save')}</button>
          <button disabled={connecting || !clientId.trim()} className="pepebox-connect-btn" onClick={handleConnect}>
            {connecting ? t('settings.connecting') : t('settings.connect')}
          </button>
        </div>
      </div>
    </div>
  );
};
