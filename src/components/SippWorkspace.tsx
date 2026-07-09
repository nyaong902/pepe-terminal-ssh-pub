// src/components/SippWorkspace.tsx
// SIPp 워크스페이스 — 네이티브 SIPp(부하 발생기) 제어 UI.
// 실제 SIP 콜은 electron/sippSidecar.ts 가 sipp.exe 를 spawn 해서 발생시키며,
// 여기서는 window.api.sipp* IPC 로 시작/중지/통계 스트림만 다룬다.
import React, { useEffect, useRef, useState } from 'react';
import { notifyConfirm } from './Notify';

const api = () => (window as any).api || {};
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const inp: React.CSSProperties = { padding: '6px 8px', background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 12, width: '100%', boxSizing: 'border-box' };
const label: React.CSSProperties = { fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)', marginBottom: 4, display: 'block' };
const card: React.CSSProperties = { background: 'var(--win-surface, #161b22)', border: '1px solid var(--win-border, #30363d)', borderRadius: 8, padding: 12 };
const btn = (enabled: boolean, kind: 'primary' | 'danger' = 'primary'): React.CSSProperties => ({
  padding: '8px 16px', borderRadius: 6, border: 'none', fontWeight: 700, fontSize: 13,
  background: !enabled ? 'var(--win-surface-2, #21262d)' : kind === 'danger' ? '#da3633' : 'var(--win-accent, #2b6b9b)',
  color: enabled ? '#fff' : 'var(--win-text-dim, #9aa7b3)', cursor: enabled ? 'pointer' : 'not-allowed',
});

type SippStats = {
  callsCreated?: number;
  successfulCalls?: number;
  failedCalls?: number;
  currentCalls?: number;
  cps?: number;
  elapsed?: string;
};

export const SippWorkspace: React.FC = () => {
  const [targetHost, setTargetHost] = useState('127.0.0.1');
  const [targetPort, setTargetPort] = useState(5060);
  const [localIp, setLocalIp] = useState('');
  const [localPort, setLocalPort] = useState<string>('');
  const [cps, setCps] = useState(5);
  const [maxCalls, setMaxCalls] = useState<string>('100');
  const [callDurationMs, setCallDurationMs] = useState(0);
  const [extraHeaders, setExtraHeaders] = useState('');
  const [sdpBody, setSdpBody] = useState('');
  const [advancedMode, setAdvancedMode] = useState(false);
  const [rawScenarioXml, setRawScenarioXml] = useState('');

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<SippStats>({});
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logCollapsed, setLogCollapsed] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  // 진행 중엔 SIPp 의 "Scenario Screen"(스텝별 메시지 흐름), 테스트가 끝나면
  // "Statistics Screen"(누적 통계)을 그대로 화면에 보여준다 — 실제 sipp 콘솔과 동일한 뷰.
  const [scenarioScreen, setScenarioScreen] = useState('');
  const [statisticsScreen, setStatisticsScreen] = useState('');
  const [screenPhase, setScreenPhase] = useState<'idle' | 'running' | 'done'>('idle');

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      try {
        const st = await api().sippStatus?.();
        if (st) setRunning(!!st.running);
      } catch {}
      unsub = api().onSippEvent?.((p: any) => {
        if (!p) return;
        if (p.ev === 'started') {
          setRunning(true); setError(null); setStats({}); setLogLines([]);
          setScenarioScreen(''); setStatisticsScreen(''); setScreenPhase('running');
          setPaused(false);
        }
        else if (p.ev === 'exit') { setRunning(false); }
        else if (p.ev === 'error') { setError(p.error || '알 수 없는 오류'); setRunning(false); }
        else if (p.ev === 'stats') { setStats(prev => ({ ...prev, ...p.stats })); }
        else if (p.ev === 'screen') {
          if (p.kind === 'scenario') { setScenarioScreen(String(p.text || '')); setScreenPhase(prev => prev === 'done' ? prev : 'running'); }
          else if (p.kind === 'statistics') { setStatisticsScreen(String(p.text || '')); setScreenPhase('done'); }
        }
        else if (p.ev === 'log') {
          setLogLines(prev => {
            const next = [...prev, String(p.text || '')].slice(-500);
            return next;
          });
        }
      });
    })();
    return () => { try { unsub?.(); } catch {} };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const start = async () => {
    setError(null);
    const host = targetHost.trim();
    const maxCallsNum = maxCalls.trim() ? Number(maxCalls) : undefined;
    // 127.0.0.1/localhost 가 아닌 실제 장비를 대상으로 콜을 여러 개(또는 무제한) 쏘려는
    // 경우, 실수로 대량의 실제 콜이 나가는 것(운영 스위치로 나가는 경우 특히 위험)을
    // 막기 위해 시작 전 한 번 더 확인한다.
    const isLoopback = LOOPBACK_HOSTS.has(host);
    const isBulk = maxCallsNum === undefined || maxCallsNum > 1;
    if (!isLoopback && isBulk) {
      const countLabel = maxCallsNum === undefined ? '무제한' : `${maxCallsNum}개`;
      const confirmed = await notifyConfirm(
        '실제 장비로 콜 발생',
        `대상 ${host}:${targetPort} 로 CPS ${cps}, 최대 콜 수 ${countLabel} 설정으로 실제 SIP 콜을 보냅니다. 실제 통신 장비/서비스에 영향을 줄 수 있습니다. 계속할까요?`
      );
      if (!confirmed) return;
    }
    const opts: any = {
      targetHost: host,
      targetPort: Number(targetPort) || 5060,
      cps: Number(cps) || 1,
      callDurationMs: Number(callDurationMs) || 0,
    };
    if (localIp.trim()) opts.localIp = localIp.trim();
    if (localPort.trim()) opts.localPort = Number(localPort);
    if (maxCallsNum !== undefined) opts.maxCalls = maxCallsNum;
    if (advancedMode && rawScenarioXml.trim()) {
      opts.rawScenarioXml = rawScenarioXml;
    } else {
      if (extraHeaders.trim()) opts.extraHeaders = extraHeaders;
      if (sdpBody.trim()) opts.sdpBody = sdpBody;
    }
    try {
      const res = await api().sippStart?.({ opts });
      if (!res?.ok) setError(res?.error || '시작 실패');
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  };

  const stop = async () => {
    try { await api().sippStop?.(); } catch {}
  };

  const [rateApplyMsg, setRateApplyMsg] = useState<string | null>(null);
  const applyRate = async (value?: number) => {
    const target = value ?? Number(cps);
    setRateApplyMsg(null);
    try {
      const res = await api().sippSetRate?.({ cps: target });
      setRateApplyMsg(res?.ok ? `CPS ${target} 적용됨 (최대 0.3초 내 반영)` : (res?.error || '적용 실패'));
    } catch (e: any) {
      setRateApplyMsg(String(e?.message || e));
    }
  };
  // SIPp 인터랙티브 키('+'/'-' 는 1cps, '*'/'/' 는 10cps 단위 조절, 'p' 는 일시정지) 와
  // 동일한 동작을 버튼으로 노출 — 내부적으로 -ctrl_file 에 씀.
  const adjustRate = async (delta: number) => {
    const next = Math.max(1, Number(cps) + delta);
    setCps(next);
    await applyRate(next);
  };
  const [paused, setPaused] = useState(false);
  const [pauseMsg, setPauseMsg] = useState<string | null>(null);
  const togglePause = async () => {
    setPauseMsg(null);
    const next = !paused;
    try {
      const res = await api().sippSetPaused?.({ paused: next });
      if (res?.ok) { setPaused(next); }
      else { setPauseMsg(res?.error || '적용 실패'); }
    } catch (e: any) {
      setPauseMsg(String(e?.message || e));
    }
  };

  const canStart = !running && targetHost.trim().length > 0 && Number(targetPort) > 0 && Number(cps) > 0;

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', overflow: 'auto', padding: 12, gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>📶 SIPp 워크스페이스</span>
        <span style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>네이티브 SIPp 부하 발생기 — 헤더/바디 편집, CPS(초당 콜 수) 제어</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px', borderRadius: 999, background: running ? '#238636' : 'var(--win-surface-2, #21262d)', color: running ? '#fff' : 'var(--win-text-dim, #9aa7b3)' }}>
          {running ? '실행 중' : '대기'}
        </span>
      </div>

      {error && (
        <div style={{ padding: 8, borderRadius: 6, background: '#3d1518', border: '1px solid #f85149', color: '#e6edf3', fontSize: 12 }}>{error}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        <div style={card}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>대상 / 속도</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 2 }}>
              <label style={label}>대상 호스트</label>
              <input style={inp} value={targetHost} onChange={e => setTargetHost(e.target.value)} disabled={running} placeholder="127.0.0.1" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>포트</label>
              <input style={inp} type="number" value={targetPort} onChange={e => setTargetPort(Number(e.target.value))} disabled={running} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={label}>로컬 IP (선택)</label>
              <input style={inp} value={localIp} onChange={e => setLocalIp(e.target.value)} disabled={running} placeholder="자동" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>로컬 포트 (선택)</label>
              <input style={inp} value={localPort} onChange={e => setLocalPort(e.target.value)} disabled={running} placeholder="자동" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={label}>CPS (초당 콜){running ? ' — 실행 중 조절 가능' : ''}</label>
              <div style={{ display: 'flex', gap: 4 }}>
                <input style={inp} type="number" min={1} value={cps} onChange={e => { setCps(Number(e.target.value)); setRateApplyMsg(null); }} />
                {running && (
                  <button onClick={() => applyRate()} style={{ ...btn(Number(cps) > 0), padding: '6px 10px', fontSize: 11, whiteSpace: 'nowrap' }} disabled={!(Number(cps) > 0)}>적용</button>
                )}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>최대 콜 수 (비우면 무제한)</label>
              <input style={inp} value={maxCalls} onChange={e => setMaxCalls(e.target.value)} disabled={running} placeholder="예: 100" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>콜 유지 시간(ms)</label>
              <input style={inp} type="number" min={0} value={callDurationMs} onChange={e => setCallDurationMs(Number(e.target.value))} disabled={running} />
            </div>
          </div>
          {rateApplyMsg && <div style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', marginTop: 4 }}>{rateApplyMsg}</div>}
          {running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8 }}>
              <button onClick={() => adjustRate(-10)} style={{ ...btn(true), padding: '4px 8px', fontSize: 11, flex: 1 }} title="10cps 감소 ('/' 키와 동일)">-10</button>
              <button onClick={() => adjustRate(-1)} style={{ ...btn(true), padding: '4px 8px', fontSize: 11, flex: 1 }} title="1cps 감소 ('-' 키와 동일)">-1</button>
              <button onClick={() => adjustRate(1)} style={{ ...btn(true), padding: '4px 8px', fontSize: 11, flex: 1 }} title="1cps 증가 ('+' 키와 동일)">+1</button>
              <button onClick={() => adjustRate(10)} style={{ ...btn(true), padding: '4px 8px', fontSize: 11, flex: 1 }} title="10cps 증가 ('*' 키와 동일)">+10</button>
            </div>
          )}
          {pauseMsg && <div style={{ fontSize: 10, color: '#f85149', marginTop: 4 }}>{pauseMsg}</div>}
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            {!running ? (
              <button style={{ ...btn(canStart), flex: 1 }} disabled={!canStart} onClick={start}>▶ 테스트 시작</button>
            ) : (
              <>
                <button style={{ ...btn(true, 'danger'), flex: 1 }} onClick={stop}>■ 중지</button>
                <button style={{ ...btn(true, paused ? 'primary' : 'danger'), flex: 1 }} onClick={togglePause} title="트래픽 일시정지/재개 ('p' 키와 동일)">
                  {paused ? '▶ 재개' : '⏸ 일시정지'}
                </button>
              </>
            )}
          </div>
        </div>

        <div style={card}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>요약</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
            <StatBox label="생성된 콜" value={stats.callsCreated} />
            <StatBox label="현재 콜" value={stats.currentCalls} />
            <StatBox label="성공" value={stats.successfulCalls} color="#3fb950" />
            <StatBox label="실패" value={stats.failedCalls} color={stats.failedCalls ? '#f85149' : undefined} />
            <StatBox label="실측 CPS" value={stats.cps} />
            <StatBox label="경과 시간" value={stats.elapsed as any} />
          </div>
        </div>
      </div>

      {screenPhase !== 'idle' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, flexShrink: 0 }}>
          <ScreenPanel
            title="📟 Scenario Screen (진행 중 메시지별 건수)"
            badge={screenPhase === 'running' ? '실행 중' : '완료'}
            badgeColor={screenPhase === 'running' ? '#9e6a03' : '#238636'}
            text={scenarioScreen}
          />
          <ScreenPanel
            title="📊 Statistics Screen (종료 후 누적 통계)"
            badge={statisticsScreen ? '완료' : '대기'}
            badgeColor={statisticsScreen ? '#238636' : 'var(--win-surface-2, #21262d)'}
            text={statisticsScreen}
          />
        </div>
      )}

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>시나리오 (헤더 / 바디)</span>
          <label style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={advancedMode} onChange={e => setAdvancedMode(e.target.checked)} disabled={running} />
            고급: 전체 SIPp XML 시나리오 직접 작성
          </label>
        </div>
        {!advancedMode ? (
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={label}>추가 INVITE 헤더 (한 줄에 하나, "Header: value")</label>
              <textarea style={{ ...inp, minHeight: 120, fontFamily: 'monospace', resize: 'vertical' }} value={extraHeaders} onChange={e => setExtraHeaders(e.target.value)} disabled={running} placeholder={'X-Custom-Header: value\nP-Asserted-Identity: <sip:user@example.com>'} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>SDP 바디 (비우면 기본 PCMU 사용)</label>
              <textarea style={{ ...inp, minHeight: 120, fontFamily: 'monospace', resize: 'vertical' }} value={sdpBody} onChange={e => setSdpBody(e.target.value)} disabled={running} placeholder={'v=0\no=user1 ... IN IP[local_ip_type] [local_ip]\ns=-\nc=IN IP[media_ip_type] [media_ip]\nt=0 0\nm=audio [media_port] RTP/AVP 0\na=rtpmap:0 PCMU/8000'} />
            </div>
          </div>
        ) : (
          <div>
            <label style={label}>전체 SIPp 시나리오 XML (INVITE/ACK/BYE 흐름을 직접 정의)</label>
            <textarea style={{ ...inp, minHeight: 220, fontFamily: 'monospace', resize: 'vertical' }} value={rawScenarioXml} onChange={e => setRawScenarioXml(e.target.value)} disabled={running} placeholder={'<?xml version="1.0" encoding="ISO-8859-1" ?>\n<!DOCTYPE scenario SYSTEM "sipp.dtd">\n<scenario name="Custom">\n  ...\n</scenario>'} />
          </div>
        )}
      </div>

      <div style={{ ...card, flex: logCollapsed ? '0 0 auto' : 1, display: 'flex', flexDirection: 'column', minHeight: logCollapsed ? 0 : 400 }}>
        <div
          style={{ fontSize: 12, fontWeight: 700, marginBottom: logCollapsed ? 0 : 8, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}
          onClick={() => setLogCollapsed(v => !v)}
        >
          <span style={{ fontSize: 10, transform: logCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▼</span>
          실행 로그
          <span style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', fontWeight: 400 }}>({logLines.length}줄)</span>
        </div>
        {!logCollapsed && (
          <div ref={logRef} style={{ flex: 1, overflow: 'auto', minHeight: 340, background: 'var(--win-bg, #0d1117)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, padding: 8, fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--win-text-dim, #9aa7b3)' }}>
            {logLines.length === 0 ? '테스트를 시작하면 SIPp 출력이 여기 표시됩니다.' : logLines.join('')}
          </div>
        )}
      </div>
    </div>
  );
};

const StatBox: React.FC<{ label: string; value?: number | string; color?: string }> = ({ label: l, value, color }) => (
  <div style={{ background: 'var(--win-bg, #0d1117)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, padding: '6px 10px' }}>
    <div style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)' }}>{l}</div>
    <div style={{ fontSize: 16, fontWeight: 700, color: color || 'var(--win-text, #e6edf3)' }}>{value ?? '—'}</div>
  </div>
);

const ScreenPanel: React.FC<{ title: string; badge: string; badgeColor: string; text: string }> = ({ title, badge, badgeColor, text }) => (
  <div style={{ background: 'var(--win-surface, #161b22)', border: '1px solid var(--win-border, #30363d)', borderRadius: 8, padding: 0, overflow: 'hidden', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--win-border, #30363d)' }}>
      <span style={{ fontSize: 12, fontWeight: 700 }}>{title}</span>
      <span style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 8px', borderRadius: 999, background: badgeColor, color: badgeColor === 'var(--win-surface-2, #21262d)' ? 'var(--win-text-dim, #9aa7b3)' : '#fff' }}>{badge}</span>
    </div>
    <pre style={{ margin: 0, padding: 12, background: '#010409', color: '#c9d1d9', fontFamily: 'Consolas, "Courier New", monospace', fontSize: 12, lineHeight: 1.5, overflow: 'auto', minHeight: 420, maxHeight: 640, whiteSpace: 'pre', flex: 1 }}>
      {text || '테스트를 시작하면 화면이 여기 표시됩니다.'}
    </pre>
  </div>
);
