// src/components/SqlSessionEditor.tsx
// SQL Tool 전용 DB 연결 프로필 편집 모달 — SSH 세션 편집과 완전히 분리된 독립 폼.
// 이전엔 SessionEditor 의 "DBMS" 탭에서 SSH 세션에 얹혀 편집했지만, SQL Tool 이 자체적으로
// 연결을 관리하도록 옮겨왔다. SSH 터널이 필요하면 이 화면에서 직접 SSH 접속 정보(호스트/포트/
// 사용자/비밀번호)를 입력한다 — 더 이상 "이 세션이 물려있는 SSH 터미널"에 의존하지 않는다.
import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { DriverManagerModal } from './DriverManagerModal';

export type SqlSession = {
  id: string;
  name: string;
  folderId?: string;
  dbms: {
    type: 'altibase' | 'mysql' | 'postgres' | 'oracle' | 'mssql' | 'sqlite';
    driverId?: string;
    database?: string;
    useSshTunnel?: boolean;
    urlOverride?: string;
    props?: Record<string, string>;
    port: number;
    user: string;
    password: string;
    host?: string;
  };
  sshTunnel?: {
    host: string;
    port: number;
    username: string;
    auth?: { type: 'password'; password: string } | { type: 'key'; keyPath: string };
  };
};

type Props = {
  session: SqlSession;
  onSave: (s: SqlSession) => void;
  onCancel: () => void;
};

const api = (window as any).api || {};

export const SqlSessionEditor: React.FC<Props> = ({ session, onSave, onCancel }) => {
  const { t } = useTranslation('sessionEditor');
  const [name, setName] = useState(session.name);
  const [dbmsDriverId, setDbmsDriverId] = useState(session.dbms.driverId ?? 'altibase-builtin');
  const [dbmsHost, setDbmsHost] = useState(session.dbms.host ?? '127.0.0.1');
  const [dbmsPort, setDbmsPort] = useState<number>(session.dbms.port ?? 20300);
  const [dbmsDatabase, setDbmsDatabase] = useState(session.dbms.database ?? '');
  const [dbmsUser, setDbmsUser] = useState(session.dbms.user ?? '');
  const [dbmsPassword, setDbmsPassword] = useState(session.dbms.password ?? '');
  const [showDbmsPassword, setShowDbmsPassword] = useState(false);
  const [dbmsUrlEditMode, setDbmsUrlEditMode] = useState(!!session.dbms.urlOverride);
  const [dbmsUrlOverride, setDbmsUrlOverride] = useState(session.dbms.urlOverride ?? '');

  const [useSshTunnel, setUseSshTunnel] = useState(!!session.dbms.useSshTunnel);
  const [tunnelHost, setTunnelHost] = useState(session.sshTunnel?.host ?? '');
  const [tunnelPort, setTunnelPort] = useState<number>(session.sshTunnel?.port ?? 22);
  const [tunnelUsername, setTunnelUsername] = useState(session.sshTunnel?.username ?? '');
  const [tunnelPassword, setTunnelPassword] = useState(
    session.sshTunnel?.auth?.type === 'password' ? session.sshTunnel.auth.password : ''
  );
  const [showTunnelPassword, setShowTunnelPassword] = useState(false);

  const [jdbcDrivers, setJdbcDrivers] = useState<any[]>([]);
  const refreshJdbcDrivers = useCallback(async () => {
    try {
      const list = await api.jdbcListDrivers?.();
      if (Array.isArray(list)) setJdbcDrivers(list);
    } catch {}
  }, []);
  useEffect(() => { void refreshJdbcDrivers(); }, [refreshJdbcDrivers]);
  const [driverManagerOpen, setDriverManagerOpen] = useState(false);

  const [testResult, setTestResult] = useState('');
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState('');

  const selectedDriver = jdbcDrivers.find(d => d.id === dbmsDriverId);
  const composedUrl = selectedDriver?.urlTemplate
    ? selectedDriver.urlTemplate
        .replace('{host}', dbmsHost || '127.0.0.1')
        .replace('{port}', String(dbmsPort || selectedDriver.defaultPort || 0))
        .replace('{database}', dbmsDatabase || '')
        .replace(/\/+$/, '')
    : '';
  const effectiveUrl = dbmsUrlEditMode && dbmsUrlOverride ? dbmsUrlOverride : composedUrl;
  const driverUsable = selectedDriver?.diag?.usable;

  const buildSession = (): SqlSession => ({
    id: session.id,
    name: name.trim() || 'New DB Connection',
    folderId: session.folderId,
    dbms: {
      type: (selectedDriver?.dialect || session.dbms.type || 'altibase') as SqlSession['dbms']['type'],
      driverId: dbmsDriverId || undefined,
      port: dbmsPort || selectedDriver?.defaultPort || 20300,
      user: dbmsUser.trim(),
      password: dbmsPassword,
      host: dbmsHost.trim() || '127.0.0.1',
      database: dbmsDatabase.trim() || undefined,
      useSshTunnel: useSshTunnel || undefined,
      urlOverride: dbmsUrlEditMode && dbmsUrlOverride.trim() ? dbmsUrlOverride.trim() : undefined,
    },
    sshTunnel: useSshTunnel
      ? { host: tunnelHost.trim(), port: tunnelPort || 22, username: tunnelUsername.trim(), auth: { type: 'password', password: tunnelPassword } }
      : undefined,
  });

  const runTest = async () => {
    if (!selectedDriver) { setTestResult(t('dbms.noDriver')); return; }
    if (!driverUsable) { setTestResult(t('dbms.driverJarMissing')); return; }
    setTesting(true);
    setTestResult(t('dbms.testing'));
    const cid = `test-${Date.now().toString(36)}`;
    let testUrl = effectiveUrl;
    let forwardId = '';
    try {
      if (useSshTunnel) {
        if (!tunnelHost.trim()) { setTestResult(t('dbms.sshIpcMissing')); return; }
        if (typeof api.sshOpenDedicatedForward !== 'function') { setTestResult(t('dbms.sshIpcMissing')); return; }
        setTestResult(t('dbms.sshOpening'));
        const remoteHost = dbmsHost || '127.0.0.1';
        const remotePort = dbmsPort || selectedDriver?.defaultPort || 0;
        const fwd = await api.sshOpenDedicatedForward({
          remoteHost, remotePort,
          sshConn: { host: tunnelHost.trim(), port: tunnelPort || 22, username: tunnelUsername.trim(), auth: { type: 'password', password: tunnelPassword } },
        });
        if (!fwd?.success) { setTestResult(t('dbms.sshFailed', { error: fwd?.error || '?' })); return; }
        forwardId = fwd.forwardId;
        const orig = `${dbmsHost || '127.0.0.1'}:${dbmsPort || selectedDriver?.defaultPort || 0}`;
        testUrl = effectiveUrl.replace(orig, `127.0.0.1:${fwd.localPort}`);
        setTestResult(t('dbms.sshTunnelOk', { remoteHost, remotePort, localPort: fwd.localPort }));
        // 테스트 전용 dedicated forward — 정리 시 connId 도 같이 닫아야 하므로 별도 보관.
        (window as any).__sqlTestFwdConnId = fwd.connId;
      }
      const cr = await api.jdbcConnect?.({ connectionId: cid, driver: selectedDriver, url: testUrl, user: dbmsUser, password: dbmsPassword });
      if (!cr?.success) { setTestResult(`❌ ${cr?.error || '?'} (URL: ${testUrl})`); return; }
      const info = cr.result || {};
      setTestResult(`✅ ${info.productName || ''} ${info.productVersion || ''} (driver: ${info.driverName || '?'})${forwardId ? ' [via SSH tunnel]' : ''}`);
      await api.jdbcDisconnect?.(cid);
    } catch (e: any) {
      setTestResult(t('dbms.exception', { error: e?.message || e }));
    } finally {
      if (forwardId) {
        const connId = (window as any).__sqlTestFwdConnId;
        try { await api.sshCloseDedicatedForward?.({ forwardId, connId }); } catch {}
      }
      setTesting(false);
    }
  };

  const save = () => {
    if (!dbmsUser.trim() && !(dbmsUrlEditMode && dbmsUrlOverride.trim())) {
      setSaveError(t('fields.dbmsUser'));
      return;
    }
    onSave(buildSession());
  };

  return (
    <div className="session-editor-backdrop" onMouseDown={onCancel}>
      <div className="session-editor" style={{ width: 560, maxWidth: 'calc(100vw - 40px)' }} onMouseDown={e => e.stopPropagation()}>
        <h3>🗄️ {t('categories.dbms')}</h3>
        <div style={{ padding: '0 0 4px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="session-editor-grid">
              <label>{t('dbms.sqlSessionName')}</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} />
              <label>{t('fields.jdbcDriver')}</label>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <select
                  value={dbmsDriverId}
                  onChange={e => {
                    const next = e.target.value;
                    setDbmsDriverId(next);
                    const d = jdbcDrivers.find(x => x.id === next);
                    if (d?.defaultPort && d.defaultPort > 0) setDbmsPort(d.defaultPort);
                  }}
                  style={{ flex: 1 }}
                >
                  {jdbcDrivers.length === 0 && <option value="">{t('dbms.driverLoading')}</option>}
                  {jdbcDrivers.map(d => (
                    <option key={d.id} value={d.id}>{d.diag?.usable ? '✓' : '⚠'} {d.name} [{d.dialect}]</option>
                  ))}
                </select>
                <button type="button" className="btn-cancel" onClick={() => setDriverManagerOpen(true)} title={t('dbms.driverManager')}>
                  🔧 {t('dbms.driverManager')}
                </button>
              </div>
              <label>{t('fields.dbmsHost')}</label>
              <input type="text" value={dbmsHost} onChange={e => setDbmsHost(e.target.value)} placeholder="127.0.0.1" />
              <label>{t('fields.dbmsPort')}</label>
              <input type="number" value={dbmsPort} onChange={e => setDbmsPort(Number(e.target.value) || 0)} placeholder={String(selectedDriver?.defaultPort || 0)} min={1} max={65535} />
              <label>{t('fields.dbmsDatabase')}</label>
              <input type="text" value={dbmsDatabase} onChange={e => setDbmsDatabase(e.target.value)} placeholder={selectedDriver?.dialect === 'sqlite' ? '/path/to/file.db' : 'mydb'} />
              <label>{t('fields.dbmsUser')}</label>
              <input type="text" value={dbmsUser} onChange={e => setDbmsUser(e.target.value)} placeholder="ipageon" autoComplete="off" />
              <label>{t('fields.dbmsPassword')}</label>
              <div style={{ display: 'flex', gap: 4 }}>
                <input type={showDbmsPassword ? 'text' : 'password'} value={dbmsPassword} onChange={e => setDbmsPassword(e.target.value)} style={{ flex: 1 }} autoComplete="off" />
                <button type="button" onClick={() => setShowDbmsPassword(v => !v)}>{showDbmsPassword ? '🙈' : '👁'}</button>
              </div>
            </div>

            <div style={{ background: '#1e1e1e', border: '1px solid #333', borderRadius: 3, padding: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontWeight: 600, fontSize: 12, color: '#9cdcfe' }}>JDBC URL</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#aaa', fontSize: 11 }}>
                  <input type="checkbox" checked={dbmsUrlEditMode} onChange={e => { setDbmsUrlEditMode(e.target.checked); if (e.target.checked && !dbmsUrlOverride) setDbmsUrlOverride(composedUrl); }} />
                  <span>{t('fields.directInput')}</span>
                </label>
                {!dbmsUrlEditMode && composedUrl && (
                  <button type="button" onClick={() => navigator.clipboard.writeText(composedUrl)} style={{ marginLeft: 'auto', background: 'transparent', color: '#aaa', border: '1px solid #444', padding: '1px 6px', borderRadius: 2, cursor: 'pointer', fontSize: 11 }}>{t('dbms.copy')}</button>
                )}
              </div>
              {dbmsUrlEditMode ? (
                <input type="text" value={dbmsUrlOverride} onChange={e => setDbmsUrlOverride(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12 }} />
              ) : (
                <code style={{ color: '#d4d4d4', fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>{composedUrl || t('dbms.urlPlaceholder')}</code>
              )}
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={useSshTunnel} onChange={e => setUseSshTunnel(e.target.checked)} />
              <span>{t('dbms.tunnelEnable')}</span>
            </label>
            {useSshTunnel && (
              <div style={{ background: '#1e1e1e', border: '1px solid #333', borderRadius: 3, padding: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: '#9cdcfe', marginBottom: 2 }}>{t('dbms.tunnelSectionTitle')}</div>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>{t('dbms.tunnelSectionSub')}</div>
                <div className="session-editor-grid">
                  <label>{t('fields.host')}</label>
                  <input type="text" value={tunnelHost} onChange={e => setTunnelHost(e.target.value)} placeholder="192.168.0.1" />
                  <label>{t('fields.port')}</label>
                  <input type="number" value={tunnelPort} onChange={e => setTunnelPort(Number(e.target.value) || 22)} min={1} max={65535} />
                  <label>{t('fields.username')}</label>
                  <input type="text" value={tunnelUsername} onChange={e => setTunnelUsername(e.target.value)} autoComplete="off" />
                  <label>{t('fields.password')}</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input type={showTunnelPassword ? 'text' : 'password'} value={tunnelPassword} onChange={e => setTunnelPassword(e.target.value)} style={{ flex: 1 }} autoComplete="off" />
                    <button type="button" onClick={() => setShowTunnelPassword(v => !v)}>{showTunnelPassword ? '🙈' : '👁'}</button>
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" onClick={runTest} disabled={testing || !selectedDriver} style={{ background: '#3a7d3a', color: '#fff', border: 0, padding: '5px 12px', borderRadius: 3, cursor: testing ? 'wait' : 'pointer', fontSize: 12 }}>
                {testing ? '...' : t('dbms.testConnect')}
              </button>
              {testResult && (
                <span style={{ color: testResult.startsWith('✅') ? '#5fb55f' : (testResult.startsWith('테스트') ? '#bbb' : '#fcc'), fontSize: 12, fontFamily: 'monospace' }}>{testResult}</span>
              )}
            </div>
          </div>
        </div>
        <div className="session-editor-actions">
          {saveError && <span className="session-editor-error">{saveError}</span>}
          <button className="btn-cancel" onClick={onCancel}>{t('actions.close')}</button>
          <button className="btn-save" onClick={save}>{t('actions.apply')}</button>
        </div>
      </div>
      <DriverManagerModal open={driverManagerOpen} onClose={() => { setDriverManagerOpen(false); void refreshJdbcDrivers(); }} />
    </div>
  );
};
