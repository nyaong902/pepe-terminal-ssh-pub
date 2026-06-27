// src/components/MicroSipWorkspace.tsx
// MicroSIP 유사 VoIP 단말 워크스페이스 (Phase 1 — UI 셸 + 제어 계층).
// 실제 SIP/RTP/코덱(AMR/AMR-WB/EVS/G.711)은 네이티브 PJSIP 사이드카가 담당하며,
// 여기서는 window.api.sip* IPC 로 제어/상태만 다룬다. 사이드카 미연결 시 status='no-engine'.
import React, { useEffect, useRef, useState } from 'react';

export type SipCodec = 'evs' | 'amrwb' | 'amr' | 'alaw' | 'ulaw';
export const ALL_CODECS: { id: SipCodec; label: string }[] = [
  { id: 'evs', label: 'EVS' },
  { id: 'amrwb', label: 'AMR-WB' },
  { id: 'amr', label: 'AMR' },
  { id: 'alaw', label: 'G.711 A-law (alaw)' },
  { id: 'ulaw', label: 'G.711 µ-law (ulaw)' },
];

export type SipEndpoint = {
  id: string;
  label: string;
  server: string;          // registrar/도메인 host
  port: number;            // 5060
  transport: 'udp' | 'tcp' | 'tls';
  username: string;
  authId?: string;
  password: string;
  displayName?: string;
  proxy?: string;          // outbound proxy (선택)
  codecs: SipCodec[];      // 우선순위 순서
  autoAnswer?: boolean;
  // ── 고급 설정 ──
  regExpiry?: number;                              // 등록 만료(초), 기본 300
  dtmfMode?: 'rfc2833' | 'info' | 'inband';        // DTMF 전송 방식
  srtp?: 'disabled' | 'optional' | 'mandatory';    // 미디어 암호화(SRTP)
};

type RegState = 'unregistered' | 'registering' | 'registered' | 'failed' | 'no-engine';
type CallState = 'idle' | 'calling' | 'ringing' | 'incoming' | 'connected' | 'held' | 'ended';
type EndpointRuntime = { reg: RegState; call: CallState; dialed: string; remote?: string; muted?: boolean; error?: string };

type MacroStep =
  | { type: 'key'; key: string }
  | { type: 'hold'; ms: number }
  | { type: 'call'; target: string }
  | { type: 'hangup' };
type Macro = { id: string; name: string; steps: MacroStep[] };

type Contact = { id: string; name: string; number: string; epId?: string };

type CallHistEntry = {
  id: string;
  epId: string;
  dir: 'in' | 'out';
  remote: string;
  ts: number;            // 통화 시작 시각
  durationSec: number;   // 연결 통화 시간(초)
  result: 'answered' | 'missed' | 'no-answer';
};

const MAX_ENDPOINTS = 10;
const DIAL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
// 단말/설정 카드 공통 최소 폭 — 둘 중 더 넓은(설정) 기준으로 맞춰 동일 grid 컬럼 폭 사용
const CARD_MIN = 300;
const cardGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN}px, 1fr))`, gap: 12, alignItems: 'start' };

const api = () => (window as any).api || {};
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function defaultEndpoint(n: number): SipEndpoint {
  return {
    id: uid('ep'),
    label: `단말 ${n}`,
    server: '',
    port: 5060,
    transport: 'udp',
    username: '',
    password: '',
    displayName: '',
    proxy: '',
    codecs: ['evs', 'amrwb', 'amr', 'alaw', 'ulaw'],
    autoAnswer: false,
    regExpiry: 300,
    dtmfMode: 'rfc2833',
    srtp: 'disabled',
  };
}

export const MicroSipWorkspace: React.FC = () => {
  const [view, setView] = useState<'phones' | 'settings' | 'macros' | 'contacts' | 'log'>('phones');
  const [activity, setActivity] = useState<{ ts: number; epId: string; text: string; kind: string }[]>([]);
  const [endpoints, setEndpoints] = useState<SipEndpoint[]>([]);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [runtime, setRuntime] = useState<Record<string, EndpointRuntime>>({});
  const [engineReady, setEngineReady] = useState<boolean | null>(null);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  // 네이티브 데몬(PJMEDIA)이 제공하는 장치 목록 — 엔진 ON 시 이쪽을 우선 사용
  const [sipInputs, setSipInputs] = useState<{ idx: number; name: string }[]>([]);
  const [sipOutputs, setSipOutputs] = useState<{ idx: number; name: string }[]>([]);
  const [audioIn, setAudioIn] = useState('');
  const [audioOut, setAudioOut] = useState('');
  const [callHistory, setCallHistory] = useState<CallHistEntry[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [ringEnabled, setRingEnabled] = useState(true);
  const loadedRef = useRef(false);
  const ringCtxRef = useRef<AudioContext | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 진행 중 통화 추적(이벤트로 기록 항목 산출) — endpointId → 누적 상태
  const callTrackRef = useRef<Record<string, { dir: 'in' | 'out'; remote: string; sawConnected: boolean; connectedTs: number }>>({});

  // ── 영속(UI prefs) ──
  useEffect(() => {
    (async () => {
      try {
        const prefs = await api().getUIPrefs?.().catch(() => ({}));
        const ms = prefs?.microsip || {};
        if (Array.isArray(ms.endpoints)) setEndpoints(ms.endpoints);
        if (Array.isArray(ms.macros)) setMacros(ms.macros);
        if (Array.isArray(ms.callHistory)) setCallHistory(ms.callHistory);
        if (Array.isArray(ms.contacts)) setContacts(ms.contacts);
        if (typeof ms.ringEnabled === 'boolean') setRingEnabled(ms.ringEnabled);
        if (ms.audioIn) setAudioIn(ms.audioIn);
        if (ms.audioOut) setAudioOut(ms.audioOut);
      } catch {}
      loadedRef.current = true;
    })();
  }, []);
  const persist = (patch: Record<string, any>) => {
    try { api().setUIPrefs?.({ microsip: { endpoints, macros, callHistory, contacts, ringEnabled, audioIn, audioOut, ...patch } }); } catch {}
  };
  useEffect(() => { if (loadedRef.current) persist({ endpoints }); /* eslint-disable-next-line */ }, [endpoints]);
  useEffect(() => { if (loadedRef.current) persist({ macros }); /* eslint-disable-next-line */ }, [macros]);
  useEffect(() => { if (loadedRef.current) persist({ callHistory }); /* eslint-disable-next-line */ }, [callHistory]);
  useEffect(() => { if (loadedRef.current) persist({ contacts }); /* eslint-disable-next-line */ }, [contacts]);

  // ── 오디오 장치 열거 (마이크/스피커 선택) ──
  useEffect(() => {
    const enumerate = async () => {
      try {
        // 라벨을 얻으려면 권한 필요 — 한 번 요청
        try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
        const devs = await navigator.mediaDevices.enumerateDevices();
        setAudioInputs(devs.filter(d => d.kind === 'audioinput'));
        setAudioOutputs(devs.filter(d => d.kind === 'audiooutput'));
      } catch {}
    };
    enumerate();
    navigator.mediaDevices?.addEventListener?.('devicechange', enumerate);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', enumerate);
  }, []);

  // ── SIP 엔진(사이드카) 상태 + 이벤트 구독 ──
  useEffect(() => {
    (async () => {
      try {
        const st = await api().sipEngineStatus?.();
        setEngineReady(!!st?.ready);
        if (st?.ready) { try { api().sipListAudioDevices?.(); } catch {} }
      } catch { setEngineReady(false); }
    })();
    const off = api().onSipEvent?.((ev: any) => {
      if (!ev) return;
      if (ev.ev === 'audio-devices') {
        setSipInputs(Array.isArray(ev.inputs) ? ev.inputs : []);
        setSipOutputs(Array.isArray(ev.outputs) ? ev.outputs : []);
        return;
      }
      // 활동 로그 적재 (reg/call/error/log)
      const txt =
        ev.ev === 'reg' ? `등록: ${ev.reg}${ev.error ? ` (${ev.error})` : ''}` :
        ev.ev === 'call' ? `통화: ${ev.call}${ev.remote ? ` ${ev.remote}` : ''}${ev.error ? ` (${ev.error})` : ''}` :
        ev.ev === 'error' ? `오류: ${ev.error || ''}` :
        ev.ev === 'log' ? String(ev.text || '') : '';
      if (txt) setActivity(prev => [{ ts: Date.now(), epId: ev.endpointId || '', text: txt, kind: ev.ev }, ...prev].slice(0, 200));
      if (!ev.endpointId) return;
      // 통화 기록 추적 — call 상태 전이로 항목 산출
      if (ev.ev === 'call' && ev.call) {
        const ep = ev.endpointId as string;
        const track = callTrackRef.current;
        if (ev.call === 'calling' || ev.call === 'incoming') {
          track[ep] = { dir: ev.call === 'incoming' ? 'in' : 'out', remote: ev.remote || '', sawConnected: false, connectedTs: 0 };
        } else if (ev.call === 'connected') {
          if (!track[ep]) track[ep] = { dir: 'out', remote: ev.remote || '', sawConnected: false, connectedTs: 0 };
          track[ep].sawConnected = true;
          track[ep].connectedTs = Date.now();
          if (ev.remote) track[ep].remote = ev.remote;
        } else if (ev.call === 'ended' || ev.call === 'idle') {
          const t = track[ep];
          if (t) {
            const durationSec = t.connectedTs ? Math.max(0, Math.round((Date.now() - t.connectedTs) / 1000)) : 0;
            const result: CallHistEntry['result'] = t.sawConnected ? 'answered' : (t.dir === 'in' ? 'missed' : 'no-answer');
            const entry: CallHistEntry = { id: uid('ch'), epId: ep, dir: t.dir, remote: t.remote, ts: Date.now() - durationSec * 1000, durationSec, result };
            setCallHistory(prev => [entry, ...prev].slice(0, 200));
            delete track[ep];
          }
        }
      }
      setRuntime(prev => ({
        ...prev,
        [ev.endpointId]: {
          ...(prev[ev.endpointId] || { reg: 'unregistered', call: 'idle', dialed: '' }),
          ...(ev.reg ? { reg: ev.reg } : {}),
          ...(ev.call ? { call: ev.call } : {}),
          ...(ev.remote !== undefined ? { remote: ev.remote } : {}),
          ...(ev.error !== undefined ? { error: ev.error } : {}),
        },
      }));
    });
    return () => { if (off) off(); };
  }, []);

  const rt = (id: string): EndpointRuntime => runtime[id] || { reg: engineReady === false ? 'no-engine' : 'unregistered', call: 'idle', dialed: '' };
  const setRt = (id: string, patch: Partial<EndpointRuntime>) =>
    setRuntime(prev => ({ ...prev, [id]: { ...rt(id), ...patch } }));

  // ── 인입 벨소리 (WebAudio) ──
  const anyIncoming = Object.values(runtime).some(r => r.call === 'incoming');
  useEffect(() => {
    const stop = () => {
      if (ringTimerRef.current) { clearInterval(ringTimerRef.current); ringTimerRef.current = null; }
    };
    if (!ringEnabled || !anyIncoming) { stop(); return; }
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    if (!ringCtxRef.current) { try { ringCtxRef.current = new Ctx(); } catch { return; } }
    const ctx = ringCtxRef.current!;
    try { ctx.resume?.(); } catch {}
    const beep = () => {
      try {
        const now = ctx.currentTime;
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.0001, now);
        // 전화 벨 비슷한 1초 울림(440+480Hz), 페이드 인/아웃
        [440, 480].forEach(f => { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(gain); o.start(now); o.stop(now + 1.0); });
        gain.gain.exponentialRampToValueAtTime(0.18, now + 0.05);
        gain.gain.setValueAtTime(0.18, now + 0.9);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.0);
      } catch {}
    };
    beep();
    ringTimerRef.current = setInterval(beep, 3000); // 1s 울림 / 2s 정적 케이던스
    return stop;
  }, [anyIncoming, ringEnabled]);
  useEffect(() => () => { // 언마운트 정리
    if (ringTimerRef.current) clearInterval(ringTimerRef.current);
    try { ringCtxRef.current?.close(); } catch {}
  }, []);

  // ── 단말 추가/삭제 ──
  const addEndpoint = () => {
    if (endpoints.length >= MAX_ENDPOINTS) return;
    setEndpoints(prev => [...prev, defaultEndpoint(prev.length + 1)]);
  };
  const removeEndpoint = (id: string) => {
    if (!confirm('이 단말을 삭제할까요? (등록 해제됩니다)')) return;
    try { api().sipUnregister?.({ endpointId: id }); } catch {}
    setEndpoints(prev => prev.filter(e => e.id !== id));
    setRuntime(prev => { const n = { ...prev }; delete n[id]; return n; });
  };
  const updateEndpoint = (id: string, patch: Partial<SipEndpoint>) =>
    setEndpoints(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e)));
  const copyFrom = (targetId: string, sourceId: string) => {
    const src = endpoints.find(e => e.id === sourceId);
    if (!src) return;
    const { id, label, username, ...rest } = src; // 계정 식별자(label/username)는 유지, 나머지(서버/전송/코덱 등) 덮어씀
    updateEndpoint(targetId, rest);
  };

  // ── SIP 제어 ──
  const register = async (e: SipEndpoint) => {
    setRt(e.id, { reg: 'registering', error: undefined });
    const r = await api().sipRegister?.({ endpoint: e }).catch((err: any) => ({ ok: false, error: String(err?.message || err) }));
    if (!r?.ok) setRt(e.id, { reg: engineReady === false ? 'no-engine' : 'failed', error: r?.error });
  };
  const unregister = async (id: string) => { await api().sipUnregister?.({ endpointId: id }).catch(() => {}); setRt(id, { reg: 'unregistered', call: 'idle' }); };
  const registerAll = () => endpoints.filter(e => e.server.trim() && e.username.trim()).forEach(e => register(e));
  const unregisterAll = () => endpoints.forEach(e => unregister(e.id));
  const makeCall = async (id: string, number: string) => {
    if (!number.trim()) return;
    setRt(id, { call: 'calling', remote: number });
    const r = await api().sipCall?.({ endpointId: id, target: number }).catch((err: any) => ({ ok: false, error: String(err?.message || err) }));
    if (!r?.ok) setRt(id, { call: 'idle', error: r?.error });
  };
  const hangup = async (id: string) => { await api().sipHangup?.({ endpointId: id }).catch(() => {}); setRt(id, { call: 'idle', muted: false }); };
  const answer = async (id: string) => { await api().sipAnswer?.({ endpointId: id }).catch(() => {}); };
  const reject = async (id: string) => { await api().sipReject?.({ endpointId: id }).catch(() => {}); setRt(id, { call: 'idle' }); };
  const toggleMute = async (id: string) => { const m = !rt(id).muted; setRt(id, { muted: m }); await api().sipMute?.({ endpointId: id, mute: m }).catch(() => {}); };
  const toggleHold = async (id: string) => { const held = rt(id).call !== 'held'; setRt(id, { call: held ? 'held' : 'connected' }); await api().sipHold?.({ endpointId: id, hold: held }).catch(() => {}); };
  const redial = (epId: string, remote: string) => {
    if (!remote.trim()) return;
    if (!endpoints.some(e => e.id === epId)) return; // 단말이 삭제된 기록
    setView('phones');
    void makeCall(epId, remote);
  };
  const transfer = async (id: string) => {
    const target = (typeof window !== 'undefined' ? window.prompt('전환할 번호/대상(SIP)을 입력하세요:', '') : '') || '';
    if (!target.trim()) return;
    await api().sipTransfer?.({ endpointId: id, target: target.trim() }).catch(() => {});
  };
  const sendDtmf = async (id: string, digit: string) => { await api().sipSendDtmf?.({ endpointId: id, digit }).catch(() => {}); };
  const pressKey = (id: string, key: string) => {
    const cur = rt(id);
    if (cur.call === 'connected') { void sendDtmf(id, key); }
    else setRt(id, { dialed: (cur.dialed || '') + key });
  };

  const applyAudioDevices = (inId: string, outId: string) => {
    setAudioIn(inId); setAudioOut(outId);
    persist({ audioIn: inId, audioOut: outId });
    try { api().sipSetAudioDevices?.({ input: inId, output: outId }); } catch {}
  };

  // ── 매크로 ──
  const runMacro = async (macro: Macro, targetIds: string[]) => {
    // 선택된 단말들에서 "동시" 실행
    await Promise.all(targetIds.map(async (epId) => {
      for (const step of macro.steps) {
        if (step.type === 'key') { pressKey(epId, step.key); await new Promise(r => setTimeout(r, 60)); }
        else if (step.type === 'hold') { await new Promise(r => setTimeout(r, step.ms)); }
        else if (step.type === 'call') { await makeCall(epId, step.target || rt(epId).dialed); }
        else if (step.type === 'hangup') { await hangup(epId); }
      }
    }));
  };

  return (
    <div className="microsip-ws" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)' }}>
      <MicroSipHeader
        view={view} setView={setView}
        engineReady={engineReady}
        canAdd={endpoints.length < MAX_ENDPOINTS}
        onAdd={addEndpoint}
        onRegisterAll={registerAll} onUnregisterAll={unregisterAll}
        ringEnabled={ringEnabled} onToggleRing={() => { setRingEnabled(v => { persist({ ringEnabled: !v }); return !v; }); }}
        audioInputs={audioInputs} audioOutputs={audioOutputs}
        sipInputs={sipInputs} sipOutputs={sipOutputs}
        audioIn={audioIn} audioOut={audioOut} onAudio={applyAudioDevices}
        epCount={endpoints.length}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
        {endpoints.length === 0 && (
          <div style={{ color: 'var(--win-text-dim, #9aa7b3)', padding: 24, textAlign: 'center' }}>
            단말이 없습니다. 우측 상단 <b>+ 단말</b> 으로 추가하세요 (최대 {MAX_ENDPOINTS}대).
          </div>
        )}

        {view === 'phones' && (
          <div style={cardGrid}>
            {endpoints.map(e => (
              <PhoneCard key={e.id} ep={e} rt={rt(e.id)}
                onKey={(k) => pressKey(e.id, k)}
                onBackspace={() => setRt(e.id, { dialed: (rt(e.id).dialed || '').slice(0, -1) })}
                onCall={() => makeCall(e.id, rt(e.id).dialed)}
                onHangup={() => hangup(e.id)}
                onClear={() => setRt(e.id, { dialed: '' })}
                onAnswer={() => answer(e.id)}
                onReject={() => reject(e.id)}
                onToggleMute={() => toggleMute(e.id)}
                onToggleHold={() => toggleHold(e.id)}
                onTransfer={() => transfer(e.id)}
              />
            ))}
          </div>
        )}

        {view === 'settings' && (
          <div style={cardGrid}>
            {endpoints.map(e => (
              <SettingsCard key={e.id} ep={e} all={endpoints} reg={rt(e.id).reg}
                onChange={(p) => updateEndpoint(e.id, p)}
                onCopyFrom={(srcId) => copyFrom(e.id, srcId)}
                onRegister={() => register(e)}
                onUnregister={() => unregister(e.id)}
                onRemove={() => removeEndpoint(e.id)}
              />
            ))}
          </div>
        )}

        {view === 'macros' && (
          <MacrosView macros={macros} setMacros={setMacros} endpoints={endpoints} onRun={runMacro} />
        )}

        {view === 'contacts' && (
          <ContactsView contacts={contacts} setContacts={setContacts} endpoints={endpoints} onDial={redial} />
        )}

        {view === 'log' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <CallHistory history={callHistory} endpoints={endpoints} onRedial={redial} onClear={() => setCallHistory([])} />
            <ActivityLog activity={activity} endpoints={endpoints} onClear={() => setActivity([])} />
          </div>
        )}
      </div>
    </div>
  );
};

// ───────────────────────── 헤더 ─────────────────────────
const MicroSipHeader: React.FC<{
  view: 'phones' | 'settings' | 'macros' | 'contacts' | 'log'; setView: (v: any) => void;
  engineReady: boolean | null; canAdd: boolean; onAdd: () => void; epCount: number;
  onRegisterAll: () => void; onUnregisterAll: () => void;
  ringEnabled: boolean; onToggleRing: () => void;
  audioInputs: MediaDeviceInfo[]; audioOutputs: MediaDeviceInfo[];
  sipInputs: { idx: number; name: string }[]; sipOutputs: { idx: number; name: string }[];
  audioIn: string; audioOut: string; onAudio: (i: string, o: string) => void;
}> = (p) => {
  // 네이티브 엔진이 장치를 제공하면(name 기준) 그 목록을, 아니면 브라우저 장치를 사용
  const useSip = p.sipInputs.length > 0 || p.sipOutputs.length > 0;
  const tab = (id: string, label: string) => (
    <button onClick={() => p.setView(id)}
      style={{ padding: '6px 12px', borderRadius: '8px 8px 0 0', border: '1px solid var(--win-border, #30363d)', borderBottom: 'none',
        background: p.view === id ? 'var(--win-surface, #161b22)' : 'transparent', color: p.view === id ? 'var(--win-text, #fff)' : 'var(--win-text-dim, #9aa7b3)',
        fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>{label}</button>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px 0', borderBottom: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface, #161b22)', flexWrap: 'wrap' }}>
      {tab('phones', '☎ 단말')}
      {tab('settings', '⚙ 설정')}
      {tab('macros', '⚡ 매크로')}
      {tab('contacts', '👤 주소록')}
      {tab('log', '🗒 기록')}
      <button onClick={p.onRegisterAll} disabled={p.epCount === 0} title="모든 단말 등록"
        style={miniBtn(p.epCount > 0)}>전체 등록</button>
      <button onClick={p.onUnregisterAll} disabled={p.epCount === 0} title="모든 단말 해제"
        style={miniBtn(p.epCount > 0)}>전체 해제</button>
      <button onClick={p.onToggleRing} title={p.ringEnabled ? '인입 벨소리 끄기' : '인입 벨소리 켜기'}
        style={miniBtn(true)}>{p.ringEnabled ? '🔔' : '🔕'}</button>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: p.engineReady ? '#3fb950' : '#d29922' }}
        title={p.engineReady ? 'SIP 엔진 연결됨' : 'SIP 엔진(네이티브 사이드카) 미연결 — Phase 2에서 활성화'}>
        ● {p.engineReady ? 'SIP 엔진 ON' : 'SIP 엔진 미연결'}
      </span>
      <select value={p.audioIn} onChange={e => p.onAudio(e.target.value, p.audioOut)} title={useSip ? '마이크(SIP 엔진)' : '마이크'} style={selStyle}>
        <option value="">🎤 기본 마이크</option>
        {useSip
          ? p.sipInputs.map(d => <option key={d.idx} value={d.name}>🎤 {d.name}</option>)
          : p.audioInputs.map(d => <option key={d.deviceId} value={d.deviceId}>🎤 {d.label || d.deviceId.slice(0, 8)}</option>)}
      </select>
      <select value={p.audioOut} onChange={e => p.onAudio(p.audioIn, e.target.value)} title={useSip ? '스피커(SIP 엔진)' : '스피커'} style={selStyle}>
        <option value="">🔊 기본 스피커</option>
        {useSip
          ? p.sipOutputs.map(d => <option key={d.idx} value={d.name}>🔊 {d.name}</option>)
          : p.audioOutputs.map(d => <option key={d.deviceId} value={d.deviceId}>🔊 {d.label || d.deviceId.slice(0, 8)}</option>)}
      </select>
      <button onClick={p.onAdd} disabled={!p.canAdd} title={p.canAdd ? '단말 추가' : '최대 10대'}
        style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--win-accent, #2b6b9b)', background: 'var(--win-accent, #2b6b9b)', color: '#fff', fontWeight: 700, cursor: p.canAdd ? 'pointer' : 'not-allowed', opacity: p.canAdd ? 1 : 0.5 }}>
        + 단말 ({p.epCount}/{MAX_ENDPOINTS})
      </button>
    </div>
  );
};
const selStyle: React.CSSProperties = { padding: '4px 8px', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 11, maxWidth: 160 };
const miniBtn = (enabled: boolean): React.CSSProperties => ({ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text, #e6edf3)', fontSize: 11, fontWeight: 600, cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5 });

// ───────────────────────── 주소록 ─────────────────────────
const ContactsView: React.FC<{
  contacts: Contact[]; setContacts: React.Dispatch<React.SetStateAction<Contact[]>>;
  endpoints: SipEndpoint[]; onDial: (epId: string, number: string) => void;
}> = ({ contacts, setContacts, endpoints, onDial }) => {
  const inp: React.CSSProperties = { padding: '6px 8px', background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 12 };
  const add = () => setContacts(prev => [...prev, { id: uid('c'), name: '', number: '', epId: endpoints[0]?.id }]);
  const update = (id: string, patch: Partial<Contact>) => setContacts(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
  const remove = (id: string) => setContacts(prev => prev.filter(c => c.id !== id));
  const dialEp = (c: Contact) => (c.epId && endpoints.some(e => e.id === c.epId)) ? c.epId : endpoints[0]?.id;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ fontSize: 13 }}>👤 주소록</b>
        <span style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>{contacts.length}건</span>
        <button onClick={add} style={{ ...inp, cursor: 'pointer', background: 'var(--win-accent, #2b6b9b)', color: '#fff', border: 'none', fontWeight: 700, marginLeft: 'auto' }}>+ 연락처 추가</button>
      </div>
      {contacts.length === 0 && (
        <div style={{ color: 'var(--win-text-dim, #9aa7b3)', padding: 16, textAlign: 'center', fontSize: 12 }}>연락처가 없습니다. <b>+ 연락처 추가</b> 로 등록하세요.</div>
      )}
      {contacts.map(c => {
        const ep = dialEp(c);
        return (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: 8, borderRadius: 8, background: 'var(--win-surface, #161b22)', border: '1px solid var(--win-border, #30363d)', flexWrap: 'wrap' }}>
            <input value={c.name} onChange={e => update(c.id, { name: e.target.value })} placeholder="이름" style={{ ...inp, flex: '1 1 120px', minWidth: 100 }} />
            <input value={c.number} onChange={e => update(c.id, { number: e.target.value })} placeholder="번호/SIP" style={{ ...inp, flex: '1 1 120px', minWidth: 100, fontFamily: 'Consolas, monospace' }} />
            <select value={c.epId || ''} onChange={e => update(c.id, { epId: e.target.value || undefined })} title="발신 단말" style={{ ...inp, flex: '0 1 130px' }}>
              <option value="">단말 자동</option>
              {endpoints.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
            <button onClick={() => ep && onDial(ep, c.number)} disabled={!c.number.trim() || !ep} title={ep ? '통화' : '등록된 단말 없음'}
              style={{ ...inp, cursor: (c.number.trim() && ep) ? 'pointer' : 'not-allowed', background: '#238636', color: '#fff', border: 'none', fontWeight: 700, opacity: (c.number.trim() && ep) ? 1 : 0.5 }}>📞</button>
            <button onClick={() => remove(c.id)} title="삭제" style={{ ...inp, cursor: 'pointer', color: '#f85149' }}>🗑</button>
          </div>
        );
      })}
    </div>
  );
};

// ───────────────────────── 통화 기록 ─────────────────────────
const histResult: Record<CallHistEntry['result'], { label: string; color: string }> = {
  answered: { label: '응답', color: '#3fb950' },
  missed: { label: '부재중', color: '#f85149' },
  'no-answer': { label: '무응답', color: '#d29922' },
};
const fmtDur = (s: number) => s <= 0 ? '' : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const CallHistory: React.FC<{
  history: CallHistEntry[]; endpoints: SipEndpoint[];
  onRedial: (epId: string, remote: string) => void; onClear: () => void;
}> = ({ history, endpoints, onRedial, onClear }) => {
  const labelOf = (id: string) => endpoints.find(e => e.id === id)?.label || id;
  const exists = (id: string) => endpoints.some(e => e.id === id);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ fontSize: 13 }}>📞 통화 기록</b>
        <span style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>최근 {history.length}건</span>
        <button onClick={onClear} disabled={history.length === 0} style={{ ...miniBtn(history.length > 0), marginLeft: 'auto' }}>지우기</button>
      </div>
      {history.length === 0 && (
        <div style={{ color: 'var(--win-text-dim, #9aa7b3)', padding: 16, textAlign: 'center', fontSize: 12 }}>통화 기록이 없습니다.</div>
      )}
      {history.map(h => {
        const r = histResult[h.result];
        return (
          <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, background: 'var(--win-surface, #161b22)', border: '1px solid var(--win-border, #30363d)', fontSize: 12 }}>
            <span title={h.dir === 'in' ? '수신' : '발신'} style={{ fontSize: 13, color: h.dir === 'in' ? '#58a6ff' : '#3fb950' }}>{h.dir === 'in' ? '↙' : '↗'}</span>
            <span style={{ flex: 1, fontFamily: 'Consolas, monospace', color: 'var(--win-text, #e6edf3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.remote || '(번호 없음)'}</span>
            <span style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', whiteSpace: 'nowrap' }}>{labelOf(h.epId)}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: r.color, whiteSpace: 'nowrap' }}>{r.label}{h.durationSec > 0 ? ` ${fmtDur(h.durationSec)}` : ''}</span>
            <span style={{ fontFamily: 'Consolas, monospace', fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', whiteSpace: 'nowrap' }}>{new Date(h.ts).toLocaleString()}</span>
            <button onClick={() => onRedial(h.epId, h.remote)} disabled={!h.remote || !exists(h.epId)} title={exists(h.epId) ? '재다이얼' : '단말 삭제됨'}
              style={{ ...miniBtn(!!h.remote && exists(h.epId)), padding: '3px 8px' }}>↺</button>
          </div>
        );
      })}
    </div>
  );
};

// ───────────────────────── 활동 로그 ─────────────────────────
const logKindColor: Record<string, string> = { reg: '#58a6ff', call: '#3fb950', error: '#f85149', log: '#8b949e' };
const ActivityLog: React.FC<{
  activity: { ts: number; epId: string; text: string; kind: string }[];
  endpoints: SipEndpoint[]; onClear: () => void;
}> = ({ activity, endpoints, onClear }) => {
  const labelOf = (id: string) => endpoints.find(e => e.id === id)?.label || id || '시스템';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ fontSize: 13 }}>🗒 활동 기록</b>
        <span style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>최근 {activity.length}건</span>
        <button onClick={onClear} disabled={activity.length === 0} style={{ ...miniBtn(activity.length > 0), marginLeft: 'auto' }}>지우기</button>
      </div>
      {activity.length === 0 && (
        <div style={{ color: 'var(--win-text-dim, #9aa7b3)', padding: 16, textAlign: 'center', fontSize: 12 }}>아직 기록이 없습니다. 등록·통화 이벤트가 여기에 표시됩니다.</div>
      )}
      {activity.map((a, i) => (
        <div key={`${a.ts}-${i}`} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 8px', borderRadius: 6, background: 'var(--win-surface, #161b22)', border: '1px solid var(--win-border, #30363d)', fontSize: 12 }}>
          <span style={{ fontFamily: 'Consolas, monospace', fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', whiteSpace: 'nowrap' }}>
            {new Date(a.ts).toLocaleTimeString()}
          </span>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: logKindColor[a.kind] || '#8b949e', flex: '0 0 auto', alignSelf: 'center' }} />
          <b style={{ fontSize: 11, color: 'var(--win-text, #e6edf3)', whiteSpace: 'nowrap' }}>{labelOf(a.epId)}</b>
          <span style={{ color: 'var(--win-text-dim, #c9d1d9)' }}>{a.text}</span>
        </div>
      ))}
    </div>
  );
};

// ───────────────────────── 단말 카드(키패드) ─────────────────────────
const regColor: Record<RegState, string> = { registered: '#3fb950', registering: '#d29922', unregistered: '#8b949e', failed: '#f85149', 'no-engine': '#8b949e' };
const PhoneCard: React.FC<{
  ep: SipEndpoint; rt: EndpointRuntime;
  onKey: (k: string) => void; onBackspace: () => void; onCall: () => void; onHangup: () => void; onClear: () => void;
  onAnswer: () => void; onReject: () => void; onToggleMute: () => void; onToggleHold: () => void; onTransfer: () => void;
}> = ({ ep, rt, onKey, onBackspace, onCall, onHangup, onClear, onAnswer, onReject, onToggleMute, onToggleHold, onTransfer }) => {
  const inCall = rt.call === 'connected' || rt.call === 'calling' || rt.call === 'ringing' || rt.call === 'held';
  const incoming = rt.call === 'incoming';
  // 통화 시간 타이머 (connected/held 동안)
  const [sec, setSec] = useState(0);
  const startRef = useRef(0);
  useEffect(() => {
    if (rt.call === 'connected' || rt.call === 'held') {
      if (!startRef.current) startRef.current = Date.now();
      const t = setInterval(() => setSec(Math.floor((Date.now() - startRef.current) / 1000)), 500);
      return () => clearInterval(t);
    }
    startRef.current = 0; setSec(0);
  }, [rt.call]);
  const mmss = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  return (
    <div style={{ border: '1px solid var(--win-border, #30363d)', borderRadius: 12, background: 'var(--win-surface, #161b22)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 9, height: 9, borderRadius: 999, background: regColor[rt.reg] }} title={rt.reg} />
        <b style={{ fontSize: 13 }}>{ep.label}</b>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)' }}>{ep.username || '미설정'}@{ep.server || '—'}</span>
      </div>
      <div style={{ minHeight: 34, padding: '6px 10px', borderRadius: 8, background: 'var(--win-bg, #0d1117)', border: '1px solid var(--win-border, #30363d)', fontFamily: 'Consolas, monospace', fontSize: 16, letterSpacing: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{(inCall || incoming) ? (rt.remote || '') : (rt.dialed || '')}</span>
        <span style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>
          {(rt.call === 'connected' || rt.call === 'held') ? mmss : (rt.call !== 'idle' ? rt.call : '')}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
        {DIAL_KEYS.map(k => (
          <button key={k} onClick={() => onKey(k)}
            style={{ padding: '10px 0', borderRadius: 8, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text, #e6edf3)', fontSize: 16, fontWeight: 600, cursor: 'pointer' }}>{k}</button>
        ))}
      </div>
      {incoming ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onAnswer} style={callBtn('#238636')}>📞 받기</button>
          <button onClick={onReject} style={callBtn('#da3633')}>✖ 거절</button>
        </div>
      ) : (rt.call === 'connected' || rt.call === 'held') ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onHangup} style={callBtn('#da3633')}>⛔ 끊기</button>
          <button onClick={onToggleMute} title="마이크 뮤트" style={{ ...callBtn(rt.muted ? '#d29922' : 'var(--win-surface-2, #21262d)'), flex: '0 0 52px', color: '#fff' }}>{rt.muted ? '🔇' : '🎤'}</button>
          <button onClick={onToggleHold} title="홀드" style={{ ...callBtn(rt.call === 'held' ? '#d29922' : 'var(--win-surface-2, #21262d)'), flex: '0 0 52px', color: '#fff' }}>{rt.call === 'held' ? '▶' : '⏸'}</button>
          <button onClick={onTransfer} title="호전환" style={{ ...callBtn('var(--win-surface-2, #21262d)'), flex: '0 0 52px', color: '#fff' }}>↪</button>
        </div>
      ) : inCall ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onHangup} style={callBtn('#da3633')}>⛔ 끊기</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onCall} style={callBtn('#238636')}>📞 통화</button>
          <button onClick={onBackspace} title="지우기" style={{ ...callBtn('var(--win-surface-2, #21262d)'), flex: '0 0 48px', color: 'var(--win-text, #e6edf3)' }}>⌫</button>
          <button onClick={onClear} title="초기화" style={{ ...callBtn('var(--win-surface-2, #21262d)'), flex: '0 0 48px', color: 'var(--win-text, #e6edf3)' }}>C</button>
        </div>
      )}
      {rt.error && <div style={{ fontSize: 10, color: '#f85149' }}>{rt.error}</div>}
    </div>
  );
};
const callBtn = (bg: string): React.CSSProperties => ({ flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', background: bg, color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' });

// ───────────────────────── 설정 카드 ─────────────────────────
const SettingsCard: React.FC<{
  ep: SipEndpoint; all: SipEndpoint[]; reg: RegState;
  onChange: (p: Partial<SipEndpoint>) => void; onCopyFrom: (srcId: string) => void;
  onRegister: () => void; onUnregister: () => void; onRemove: () => void;
}> = ({ ep, all, reg, onChange, onCopyFrom, onRegister, onUnregister, onRemove }) => {
  const field = (label: string, node: React.ReactNode) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>
      <span>{label}</span>{node}
    </label>
  );
  const inp: React.CSSProperties = { padding: '6px 8px', background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 12 };
  const toggleCodec = (c: SipCodec) => {
    const has = ep.codecs.includes(c);
    onChange({ codecs: has ? ep.codecs.filter(x => x !== c) : [...ep.codecs, c] });
  };
  const moveCodec = (c: SipCodec, dir: -1 | 1) => {
    const i = ep.codecs.indexOf(c); if (i < 0) return;
    const j = i + dir; if (j < 0 || j >= ep.codecs.length) return;
    const next = [...ep.codecs];[next[i], next[j]] = [next[j], next[i]]; onChange({ codecs: next });
  };
  return (
    <div style={{ border: '1px solid var(--win-border, #30363d)', borderRadius: 12, background: 'var(--win-surface, #161b22)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ width: 9, height: 9, borderRadius: 999, background: regColor[reg] }} title={reg} />
        <input value={ep.label} onChange={e => onChange({ label: e.target.value })} style={{ ...inp, fontWeight: 700, fontSize: 13, minWidth: 120 }} />
        <select defaultValue="" onChange={e => { if (e.target.value) { onCopyFrom(e.target.value); e.target.value = ''; } }} title="다른 단말 설정 복사" style={inp}>
          <option value="">설정 복사 ←</option>
          {all.filter(x => x.id !== ep.id).map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {reg === 'registered'
            ? <button onClick={onUnregister} style={{ ...inp, cursor: 'pointer', background: 'var(--win-surface-2, #21262d)' }}>등록 해제</button>
            : <button onClick={onRegister} style={{ ...inp, cursor: 'pointer', background: 'var(--win-accent, #2b6b9b)', color: '#fff', border: 'none', fontWeight: 700 }}>등록</button>}
          <button onClick={onRemove} title="단말 삭제" style={{ ...inp, cursor: 'pointer', color: '#f85149' }}>🗑</button>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {field('SIP 서버/도메인', <input value={ep.server} onChange={e => onChange({ server: e.target.value })} placeholder="sip.example.com" style={inp} />)}
        {field('포트', <input type="number" value={ep.port} onChange={e => onChange({ port: Number(e.target.value) || 5060 })} style={inp} />)}
        {field('전송', <select value={ep.transport} onChange={e => onChange({ transport: e.target.value as any })} style={inp}><option value="udp">UDP</option><option value="tcp">TCP</option><option value="tls">TLS</option></select>)}
        {field('사용자(번호)', <input value={ep.username} onChange={e => onChange({ username: e.target.value })} style={inp} />)}
        {field('인증 ID(선택)', <input value={ep.authId || ''} onChange={e => onChange({ authId: e.target.value })} style={inp} />)}
        {field('비밀번호', <input type="password" value={ep.password} onChange={e => onChange({ password: e.target.value })} style={inp} />)}
        {field('표시 이름(선택)', <input value={ep.displayName || ''} onChange={e => onChange({ displayName: e.target.value })} style={inp} />)}
        {field('아웃바운드 프록시(선택)', <input value={ep.proxy || ''} onChange={e => onChange({ proxy: e.target.value })} placeholder="proxy:5060" style={inp} />)}
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)', marginBottom: 4 }}>코덱 (체크=사용, 위가 우선순위)</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {ALL_CODECS.slice().sort((a, b) => {
            const ia = ep.codecs.indexOf(a.id), ib = ep.codecs.indexOf(b.id);
            if (ia < 0 && ib < 0) return 0; if (ia < 0) return 1; if (ib < 0) return -1; return ia - ib;
          }).map(c => {
            const on = ep.codecs.includes(c.id);
            return (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <input type="checkbox" checked={on} onChange={() => toggleCodec(c.id)} />
                <span style={{ flex: 1, opacity: on ? 1 : 0.5 }}>{c.label}</span>
                {on && <>
                  <button onClick={() => moveCodec(c.id, -1)} style={{ ...inp, padding: '2px 6px', cursor: 'pointer' }}>▲</button>
                  <button onClick={() => moveCodec(c.id, 1)} style={{ ...inp, padding: '2px 6px', cursor: 'pointer' }}>▼</button>
                </>}
              </div>
            );
          })}
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 8 }}>
          <input type="checkbox" checked={!!ep.autoAnswer} onChange={e => onChange({ autoAnswer: e.target.checked })} /> 자동 응답
        </label>
      </div>
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--win-border, #30363d)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>고급</div>
        {field('등록 만료(초)', <input type="number" value={ep.regExpiry ?? 300} onChange={e => onChange({ regExpiry: Number(e.target.value) || 300 })} style={inp} />)}
        {field('DTMF 방식', <select value={ep.dtmfMode || 'rfc2833'} onChange={e => onChange({ dtmfMode: e.target.value as any })} style={inp}><option value="rfc2833">RFC 2833</option><option value="info">SIP INFO</option><option value="inband">In-band</option></select>)}
        {field('미디어 암호화(SRTP)', <select value={ep.srtp || 'disabled'} onChange={e => onChange({ srtp: e.target.value as any })} style={inp}><option value="disabled">사용 안 함</option><option value="optional">선택(optional)</option><option value="mandatory">필수(mandatory)</option></select>)}
      </div>
    </div>
  );
};

// ───────────────────────── 매크로 뷰 ─────────────────────────
const MacrosView: React.FC<{
  macros: Macro[]; setMacros: React.Dispatch<React.SetStateAction<Macro[]>>;
  endpoints: SipEndpoint[]; onRun: (m: Macro, targetIds: string[]) => void;
}> = ({ macros, setMacros, endpoints, onRun }) => {
  const [sel, setSel] = useState<Record<string, string[]>>({}); // macroId -> endpointIds
  const inp: React.CSSProperties = { padding: '5px 7px', background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 12 };
  const addMacro = () => setMacros(prev => [...prev, { id: uid('macro'), name: `매크로 ${prev.length + 1}`, steps: [] }]);
  const update = (id: string, patch: Partial<Macro>) => setMacros(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
  const addStep = (id: string, step: MacroStep) => setMacros(prev => prev.map(m => m.id === id ? { ...m, steps: [...m.steps, step] } : m));
  const removeStep = (id: string, idx: number) => setMacros(prev => prev.map(m => m.id === id ? { ...m, steps: m.steps.filter((_, i) => i !== idx) } : m));
  const stepLabel = (s: MacroStep) => s.type === 'key' ? `키 '${s.key}'` : s.type === 'hold' ? `${s.ms}ms 대기` : s.type === 'call' ? `통화${s.target ? ` ${s.target}` : '(입력값)'}` : '끊기';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div><button onClick={addMacro} style={{ ...inp, cursor: 'pointer', background: 'var(--win-accent, #2b6b9b)', color: '#fff', border: 'none', fontWeight: 700 }}>+ 매크로 추가</button></div>
      {macros.map(m => {
        const targets = sel[m.id] || endpoints.map(e => e.id);
        return (
          <div key={m.id} style={{ border: '1px solid var(--win-border, #30363d)', borderRadius: 12, background: 'var(--win-surface, #161b22)', padding: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input value={m.name} onChange={e => update(m.id, { name: e.target.value })} style={{ ...inp, fontWeight: 700 }} />
              <button onClick={() => onRun(m, targets)} title="선택 단말에서 동시 실행" style={{ ...inp, cursor: 'pointer', background: '#238636', color: '#fff', border: 'none', fontWeight: 700 }}>▶ 동시 실행 ({targets.length})</button>
              <button onClick={() => setMacros(prev => prev.filter(x => x.id !== m.id))} style={{ ...inp, cursor: 'pointer', color: '#f85149', marginLeft: 'auto' }}>🗑</button>
            </div>
            {/* 스텝 목록 */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {m.steps.length === 0 && <span style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>스텝을 추가하세요 (키 → 홀드 → 키 …)</span>}
              {m.steps.map((s, i) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 999, background: 'var(--win-surface-2, #21262d)', fontSize: 11 }}>
                  {i + 1}. {stepLabel(s)}
                  <button onClick={() => removeStep(m.id, i)} style={{ border: 'none', background: 'transparent', color: '#f85149', cursor: 'pointer' }}>×</button>
                </span>
              ))}
            </div>
            {/* 스텝 추가 컨트롤 */}
            <StepAdder onAdd={(s) => addStep(m.id, s)} />
            {/* 대상 단말 선택 */}
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>대상 단말:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              {endpoints.map(e => {
                const on = targets.includes(e.id);
                return (
                  <label key={e.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    <input type="checkbox" checked={on} onChange={() => setSel(prev => ({ ...prev, [m.id]: on ? targets.filter(x => x !== e.id) : [...targets, e.id] }))} />
                    {e.label}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};
const StepAdder: React.FC<{ onAdd: (s: MacroStep) => void }> = ({ onAdd }) => {
  const [key, setKey] = useState('1');
  const [ms, setMs] = useState(1000);
  const [target, setTarget] = useState('');
  const inp: React.CSSProperties = { padding: '4px 6px', background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 12 };
  const btn: React.CSSProperties = { ...inp, cursor: 'pointer', background: 'var(--win-surface-2, #21262d)' };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <select value={key} onChange={e => setKey(e.target.value)} style={inp}>{DIAL_KEYS.map(k => <option key={k} value={k}>{k}</option>)}</select>
      <button onClick={() => onAdd({ type: 'key', key })} style={btn}>+ 키</button>
      <input type="number" value={ms} onChange={e => setMs(Number(e.target.value) || 0)} style={{ ...inp, width: 80 }} />
      <button onClick={() => onAdd({ type: 'hold', ms })} style={btn}>+ 홀드(ms)</button>
      <input value={target} onChange={e => setTarget(e.target.value)} placeholder="통화 대상(선택)" style={{ ...inp, width: 120 }} />
      <button onClick={() => onAdd({ type: 'call', target })} style={btn}>+ 통화</button>
      <button onClick={() => onAdd({ type: 'hangup' })} style={btn}>+ 끊기</button>
    </div>
  );
};
