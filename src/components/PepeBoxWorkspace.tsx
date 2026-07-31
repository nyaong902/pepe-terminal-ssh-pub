// src/components/PepeBoxWorkspace.tsx
// Pepe-Box — 클라우드 스토리지 통합 워크스페이스.
// 좌측: Dropbox/Google Drive/OneDrive/네이버 MYBOX/카카오톡 톡서랍/iCloud 목록.
// 우측: 연결된 계정별 탭 — 네이티브 3사(Dropbox/Drive/OneDrive)는 FilePanel 로 실제 API 파일 탐색,
// 나머지 3사(네이버/카카오/iCloud)는 공식 파일 API 가 없어 BrowserPane(webview)으로 서비스 웹 화면을 임베드.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePanel, type PanelSource } from './FilePanel';
import { BrowserPane } from './BrowserPane';
import { CloudAccountSettingsDialog } from './CloudAccountSettingsDialog';

const api = (window as any).api || {};

export type CloudServiceKind = 'dropbox' | 'gdrive' | 'onedrive' | 'naver' | 'kakao' | 'icloud';

export type CloudServiceMeta = {
  kind: CloudServiceKind;
  label: string;
  icon: string;
  webviewUrl?: string; // webview-only 서비스의 임베드 URL
  capabilities: { list: boolean };
  // true 면 OAuth Client ID/Secret 설정 없이 클릭 즉시 webview 탭을 연다.
  // 네이버/카카오/iCloud 는 서드파티 파일 API 자체가 없어 OAuth Connect 절차가 무의미하고,
  // 오히려 "시스템 브라우저에서 로그인 완료 → webview 는 별도 세션이라 로그인 정보 없음"으로
  // 사용자를 헷갈리게 만든다 — webview 안에서 직접 로그인하는 것만이 유일하게 의미 있는 경로.
  directWebview?: boolean;
};

const SERVICE_META: CloudServiceMeta[] = [
  { kind: 'dropbox', label: 'Dropbox', icon: '📦', capabilities: { list: true } },
  { kind: 'gdrive', label: 'Google Drive', icon: '🟢', capabilities: { list: true } },
  { kind: 'onedrive', label: 'MS OneDrive', icon: '☁️', capabilities: { list: true } },
  // 로그인 세션이 없는 첫 방문(또는 세션 만료) 시 바로 로그인 폼이 뜨도록 로그인 페이지 URL로 진입.
  // 로그인 완료 후에는 각 서비스가 자체적으로 continue/url 파라미터가 가리키는 목적지로 이동한다.
  { kind: 'naver', label: '네이버 MYBOX', icon: '🟩', webviewUrl: 'https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fmybox.naver.com&realname=Y', capabilities: { list: false }, directWebview: true },
  { kind: 'kakao', label: '카카오톡 톡서랍 플러스', icon: '🟡', webviewUrl: 'https://accounts.kakao.com/login/?continue=https://talkcloud.kakao.com/#login', capabilities: { list: false }, directWebview: true },
  { kind: 'icloud', label: 'Apple iCloud', icon: '☁', webviewUrl: 'https://www.icloud.com', capabilities: { list: false }, directWebview: true },
];

type CloudAccount = {
  id: string;
  provider: CloudServiceKind;
  label: string;
  connectedAt: number;
  status: 'connected' | 'reauth-required';
};

type OpenTab = {
  id: string; // account.id 또는 icloud 의 경우 'icloud:webview'
  service: CloudServiceKind;
  label: string;
};

// FileExplorer 전체 대신, 클라우드 계정 하나를 위한 단일 FilePanel 래퍼.
// FilePanel 은 source/selection/currentPath 를 전부 제어 컴포넌트로 받으므로 여기서 최소 상태만 유지.
const CloudFilePanel: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [currentPath, setCurrentPath] = useState('/');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const source: PanelSource = useMemo(() => ({ mode: 'cloud', termId: accountId, label: accountId }), [accountId]);

  return (
    <FilePanel
      source={source}
      sources={[source]}
      onSourceChange={() => {}}
      selectedFiles={selectedFiles}
      onSelectionChange={setSelectedFiles}
      currentPath={currentPath}
      onPathChange={setCurrentPath}
      panelId={`pepebox-${accountId}`}
      workspaceId={`pepebox-${accountId}`}
    />
  );
};

export const PepeBoxWorkspace: React.FC = () => {
  const { t } = useTranslation('pepeBox');
  const [accounts, setAccounts] = useState<CloudAccount[]>([]);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [settingsFor, setSettingsFor] = useState<CloudServiceMeta | null>(null);

  const refreshAccountsQuiet = useCallback(() => {
    api.cloudboxListAccounts?.().then((list: CloudAccount[]) => setAccounts(list || []));
  }, []);
  const refreshAccounts = useCallback(() => {
    api.cloudboxListAccounts?.().then((list: CloudAccount[]) => {
      setAccounts(list || []);
      // getAccountProfile() 이 최초 연결 시점(예: Drive API 미활성화 상태)에 실패해서
      // provider 표시명("Google Drive" 등) 그대로 저장된 계정은, 실제 이메일/사용자명으로
      // 한 번 조용히 재시도 — 사용자가 재연결(Disconnect→Connect) 안 해도 자동으로 고쳐지게.
      for (const acc of list || []) {
        const meta = SERVICE_META.find(s => s.kind === acc.provider);
        // 표시명 폴백("Google Drive" 등)이거나, 그 이전 버전에서 저장된 provider kind 원문
        // ("gdrive" 등) 그대로인 계정 — 둘 다 프로필 조회 실패로 남은 흔적이므로 재시도 대상.
        const looksLikeFallback = meta && (acc.label === meta.label || acc.label === acc.provider);
        if (looksLikeFallback) {
          api.cloudboxRefreshLabel?.(acc.id).then((res: any) => { if (res?.ok) refreshAccountsQuiet(); });
        }
      }
    });
  }, [refreshAccountsQuiet]);

  useEffect(() => {
    refreshAccounts();
    const unsub = api.onCloudboxEvent?.((ev: any) => {
      if (ev?.type === 'auth-success' || ev?.type === 'reauth-required') refreshAccounts();
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [refreshAccounts]);

  const accountsByService = useMemo(() => {
    const map = new Map<CloudServiceKind, CloudAccount[]>();
    for (const a of accounts) {
      const arr = map.get(a.provider) || [];
      arr.push(a);
      map.set(a.provider, arr);
    }
    return map;
  }, [accounts]);

  const openTab = (tab: OpenTab) => {
    setOpenTabs(prev => prev.some(t2 => t2.id === tab.id) ? prev : [...prev, tab]);
    setActiveTabId(tab.id);
  };

  const closeTab = (id: string) => {
    // 다음 활성 탭 계산을 setOpenTabs 의 함수형 업데이트 콜백 안에서 함께 처리 —
    // 렌더 시점 openTabs 클로저를 읽으면 탭을 빠르게 연속으로 닫을 때(각 클릭이 아직
    // 반영 안 된 이전 배열을 기준으로 계산) 잘못된 다음 탭이 선택될 수 있다.
    setOpenTabs(prev => {
      const next = prev.filter(t2 => t2.id !== id);
      setActiveTabId(activePrev => (activePrev === id ? (next[0]?.id || null) : activePrev));
      return next;
    });
  };

  const handleServiceClick = (service: CloudServiceMeta) => {
    if (service.directWebview) {
      openTab({ id: `${service.kind}:webview`, service: service.kind, label: service.label });
      return;
    }
    const connected = accountsByService.get(service.kind) || [];
    if (connected.length > 0) {
      const acc = connected[0];
      openTab({ id: acc.id, service: service.kind, label: service.label });
    } else {
      setSettingsFor(service);
    }
  };

  const handleReauth = async (accountId: string) => {
    const res = await api.cloudboxReauth?.(accountId);
    // 재연동 성공 시 backend 가 accountId 를 새로 발급하므로, 이미 열려있는 탭이 삭제된
    // 예전 accountId 를 계속 참조해 "재연동 필요" 상태로 고착되지 않도록 탭 id 를 갱신한다.
    if (res?.ok && res.newAccountId && res.newAccountId !== accountId) {
      setOpenTabs(prev => prev.map(t2 => (t2.id === accountId ? { ...t2, id: res.newAccountId } : t2)));
      setActiveTabId(prev => (prev === accountId ? res.newAccountId : prev));
    }
    refreshAccounts();
  };

  const handleDisconnect = async (accountId: string) => {
    await api.cloudboxDisconnect?.(accountId);
    closeTab(accountId);
    refreshAccounts();
  };

  return (
    <div className="pepebox-workspace">
      <aside className="pepebox-side">
        <div className="pepebox-side-title">{t('title')}</div>
        <div className="pepebox-services">
          {SERVICE_META.map(service => {
            const connected = accountsByService.get(service.kind) || [];
            const isConnected = service.directWebview ? openTabs.some(t2 => t2.id === `${service.kind}:webview`) : connected.length > 0;
            const needsReauth = connected.some(a => a.status === 'reauth-required');
            return (
              <button
                key={service.kind}
                className={`pepebox-service${isConnected ? ' active' : ''}${needsReauth ? ' reauth-required' : ''}`}
                onClick={() => handleServiceClick(service)}
                title={service.label}
              >
                <span className="pepebox-service-icon">{service.icon}</span>
                <span className="pepebox-service-label">{service.label}</span>
                {!service.capabilities.list && <span className="pepebox-service-badge">{t('webviewBadge')}</span>}
                {!service.directWebview && connected.length > 0 && (
                  <span className="pepebox-service-account">{connected[0].label}</span>
                )}
                {!service.directWebview && needsReauth && (
                  <span
                    className="pepebox-reauth-btn"
                    onClick={(e) => { e.stopPropagation(); handleReauth(connected[0].id); }}
                  >
                    {t('reconnect')}
                  </span>
                )}
                {!service.directWebview && connected.length > 0 && (
                  <span
                    className="pepebox-disconnect-btn"
                    onClick={(e) => { e.stopPropagation(); handleDisconnect(connected[0].id); }}
                  >
                    ✕
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      <main className="pepebox-main">
        {openTabs.length === 0 ? (
          <div className="pepebox-empty">{t('emptyState')}</div>
        ) : (
          <>
            <div className="pepebox-tabbar">
              {openTabs.map(tab => (
                <div key={tab.id} className={`pepebox-tab${activeTabId === tab.id ? ' active' : ''}`} onClick={() => setActiveTabId(tab.id)}>
                  <span>{tab.label}</span>
                  <span className="pepebox-tab-close" onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}>✕</span>
                </div>
              ))}
            </div>
            <div className="pepebox-tab-content">
              {openTabs.map(tab => {
                const meta = SERVICE_META.find(s => s.kind === tab.service)!;
                const hidden = activeTabId !== tab.id;
                return (
                  <div key={tab.id} style={{ display: hidden ? 'none' : 'flex', flex: 1, minHeight: 0 }}>
                    {meta.capabilities.list ? (
                      <CloudFilePanel accountId={tab.id} />
                    ) : (
                      <BrowserPane
                        initialUrl={meta.webviewUrl || 'about:blank'}
                        chromeless={false}
                        partitionKey={`persist:pepebox-${tab.service}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </main>

      {settingsFor && (
        <CloudAccountSettingsDialog
          service={settingsFor}
          onClose={() => setSettingsFor(null)}
          onConnected={() => { refreshAccounts(); }}
        />
      )}
    </div>
  );
};
