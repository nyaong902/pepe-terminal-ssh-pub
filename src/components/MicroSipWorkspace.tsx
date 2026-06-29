// src/components/MicroSipWorkspace.tsx
// MicroSIP 유사 VoIP 단말 워크스페이스 (Phase 1 — UI 셸 + 제어 계층).
// 실제 SIP/RTP/코덱(AMR/AMR-WB/EVS/G.711)은 네이티브 PJSIP 사이드카가 담당하며,
// 여기서는 window.api.sip* IPC 로 제어/상태만 다룬다. 사이드카 미연결 시 status='no-engine'.
import React, { useEffect, useRef, useState } from 'react';
import { notifyConfirm } from './Notify';

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
  server: string;          // registrar host (SIP 서버)
  domain?: string;         // 도메인(AOR) — 미지정 시 server 사용
  port: number;            // 5060
  transport: 'udp' | 'tcp' | 'tls';
  username: string;
  authId?: string;
  password: string;
  displayName?: string;
  proxy?: string;          // outbound proxy (선택)
  hideCallerId?: boolean;  // 발신자 번호 숨기기 (Privacy)
  disableSessionTimer?: boolean; // 세션 타이머 비활성화
  publishPresence?: boolean;     // 계정 상태(프레즌스 PUBLISH), 기본 on
  codecs: SipCodec[];      // 우선순위 순서
  autoAnswer?: boolean;
  autoRegister?: boolean;  // 워크스페이스 진입(엔진 준비) 시 자동 등록 (기본 on)
  dnd?: boolean;           // 방해 금지 — 인입을 486 Busy 로 자동 거절
  voicemailNumber?: string; // 음성사서함 접속 번호
  dialPrefix?: string;       // 발신 시 앞에 붙이는 prefix (외부 회선 등; */# 코드·SIP URI 제외)
  keepAlive?: number;        // UDP keep-alive(살아유지) 초, 기본 15
  // ── 프로그램 설정(단말별) ──
  ring?: boolean;            // 인입 벨소리 (단말별), 기본 on
  callWaiting?: boolean;     // 통화 중 대기 — off 면 통화중 인입을 486 Busy 거절, 기본 on
  autoRecord?: boolean;      // 연결 시 자동 녹음, 기본 off
  // ── 고급 설정 ──
  regExpiry?: number;                              // 등록 만료(초), 기본 300
  dtmfMode?: 'rfc2833' | 'info' | 'inband';        // DTMF 전송 방식
  srtp?: 'disabled' | 'optional' | 'mandatory';    // 미디어 암호화(SRTP)
  // ── NAT 통과 ──
  iceEnabled?: boolean;                            // ICE 사용
  stunServer?: string;                             // STUN 서버 (host:port)
  turnServer?: string;                             // TURN 서버 (host:port)
  turnUser?: string;
  turnPassword?: string;
};

type RegState = 'unregistered' | 'registering' | 'registered' | 'failed' | 'no-engine';
type CallState = 'idle' | 'calling' | 'ringing' | 'incoming' | 'connected' | 'held' | 'ended';
type EndpointRuntime = { reg: RegState; call: CallState; dialed: string; remote?: string; muted?: boolean; recording?: boolean; mwi?: boolean; error?: string };

type MacroStep =
  | { type: 'key'; key: string }
  | { type: 'hold'; ms: number }
  | { type: 'call'; target: string }
  | { type: 'answer' }
  | { type: 'hangup' };
type Macro = { id: string; name: string; steps: MacroStep[]; repeat?: number };

type Contact = { id: string; name: string; number: string; epId?: string };

type ImMsg = { id: string; dir: 'in' | 'out'; text: string; ts: number; status?: string };
// 대화는 `${epId}|${peer}` 키로 묶는다. peer 는 정규화된 상대 식별자.
type Conversations = Record<string, ImMsg[]>;
// 프레즌스: `${epId}|${peer}` → 'online'|'offline'|'unknown'
type PresenceMap = Record<string, string>;
// sip:user@host / <...> → bare user(peer) 정규화
const normPeer = (uri: string): string => {
  let s = (uri || '').trim();
  s = s.replace(/^<|>$/g, '');
  const lt = s.indexOf('<'); if (lt >= 0) { const gt = s.indexOf('>', lt); s = gt > lt ? s.slice(lt + 1, gt) : s.slice(lt + 1); }
  s = s.replace(/^sips?:/i, '');
  const at = s.indexOf('@'); if (at >= 0) s = s.slice(0, at);
  const semi = s.indexOf(';'); if (semi >= 0) s = s.slice(0, semi);
  return s.trim();
};

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

// DTMF 톤 주파수 — RFC 4733 / ITU-T Q.23 표준
const DTMF_FREQ: Record<string, [number, number]> = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};
let _audioCtx: AudioContext | null = null;
function playDtmfTone(key: string) {
  const f = DTMF_FREQ[key];
  if (!f) return;
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const ctx = _audioCtx;
    if (ctx.state === 'suspended') { void ctx.resume(); }
    const t0 = ctx.currentTime;
    const dur = 0.08; // 80ms
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.18, t0 + 0.005);
    gain.gain.linearRampToValueAtTime(0, t0 + dur);
    gain.connect(ctx.destination);
    for (const freq of f) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(t0);
      osc.stop(t0 + dur);
    }
  } catch {}
}
// 단말/설정 카드 공통 최소 폭 — 둘 중 더 넓은(설정) 기준으로 맞춰 동일 grid 컬럼 폭 사용
const CARD_MIN = 300;
const cardGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN}px, 1fr))`, gap: 12, alignItems: 'start' };

// 등록에 영향 없는 필드(id/label) 제외한 설정 직렬화 — 자동 재등록 트리거 비교용
const REG_CFG_OMIT = new Set(['id', 'label']);
const cfgKey = (ep: SipEndpoint) => JSON.stringify(Object.entries(ep).filter(([k]) => !REG_CFG_OMIT.has(k)).sort(([a], [b]) => a.localeCompare(b)));

const api = () => (window as any).api || {};
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function defaultEndpoint(n: number): SipEndpoint {
  return {
    id: uid('ep'),
    label: `단말 ${n}`,
    server: '',
    domain: '',
    port: 5060,
    transport: 'udp',
    username: '',
    password: '',
    displayName: '',
    proxy: '',
    hideCallerId: false,
    disableSessionTimer: false,
    publishPresence: true,
    codecs: ['evs', 'amrwb', 'amr', 'alaw', 'ulaw'],
    autoAnswer: false,
    autoRegister: true,
    dnd: false,
    voicemailNumber: '',
    dialPrefix: '',
    keepAlive: 15,
    ring: true,
    callWaiting: true,
    autoRecord: false,
    regExpiry: 300,
    dtmfMode: 'rfc2833',
    srtp: 'disabled',
    iceEnabled: false,
    stunServer: '',
    turnServer: '',
    turnUser: '',
    turnPassword: '',
  };
}

export const MicroSipWorkspace: React.FC = () => {
  const [view, setView] = useState<'phones' | 'settings' | 'macros' | 'contacts' | 'messages' | 'log'>('phones');
  const [activity, setActivity] = useState<{ ts: number; epId: string; text: string; kind: string; body?: string }[]>([]);
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
  const [micLevel, setMicLevel] = useState(1);   // 0~2 (1=기본)
  const [spkLevel, setSpkLevel] = useState(1);
  const [callHistory, setCallHistory] = useState<CallHistEntry[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [conversations, setConversations] = useState<Conversations>({});
  const [presence, setPresence] = useState<PresenceMap>({});
  const [ringEnabled, setRingEnabled] = useState(true);
  const loadedRef = useRef(false);
  const ringCtxRef = useRef<AudioContext | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const autoRegDoneRef = useRef(false);
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
        if (ms.conversations && typeof ms.conversations === 'object') setConversations(ms.conversations);
        if (typeof ms.ringEnabled === 'boolean') setRingEnabled(ms.ringEnabled);
        if (ms.audioIn) setAudioIn(ms.audioIn);
        if (ms.audioOut) setAudioOut(ms.audioOut);
        if (typeof ms.micLevel === 'number') setMicLevel(ms.micLevel);
        if (typeof ms.spkLevel === 'number') setSpkLevel(ms.spkLevel);
      } catch {}
      loadedRef.current = true;
    })();
  }, []);
  const persist = (patch: Record<string, any>) => {
    try { api().setUIPrefs?.({ microsip: { endpoints, macros, callHistory, contacts, conversations, ringEnabled, audioIn, audioOut, micLevel, spkLevel, ...patch } }); } catch {}
  };
  useEffect(() => { if (loadedRef.current) persist({ endpoints }); /* eslint-disable-next-line */ }, [endpoints]);
  useEffect(() => { if (loadedRef.current) persist({ macros }); /* eslint-disable-next-line */ }, [macros]);
  useEffect(() => { if (loadedRef.current) persist({ callHistory }); /* eslint-disable-next-line */ }, [callHistory]);
  useEffect(() => { if (loadedRef.current) persist({ contacts }); /* eslint-disable-next-line */ }, [contacts]);
  useEffect(() => { if (loadedRef.current) persist({ conversations }); /* eslint-disable-next-line */ }, [conversations]);

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
      if (ev.ev === 'ready') {
        setEngineReady(!!ev.ready);
        if (ev.ready) { try { api().sipListAudioDevices?.(); } catch {} }
        return;
      }
      if (ev.ev === 'audio-devices') {
        setSipInputs(Array.isArray(ev.inputs) ? ev.inputs : []);
        setSipOutputs(Array.isArray(ev.outputs) ? ev.outputs : []);
        return;
      }
      if (ev.ev === 'presence') {
        setPresence(prev => ({ ...prev, [`${ev.endpointId}|${normPeer(ev.buddy || '')}`]: ev.status || 'unknown' }));
        return;
      }
      if (ev.ev === 'im') {
        const peer = normPeer(ev.from || '');
        const key = `${ev.endpointId}|${peer}`;
        setConversations(prev => ({ ...prev, [key]: [...(prev[key] || []), { id: uid('im'), dir: 'in' as const, text: String(ev.text || ''), ts: Date.now() }].slice(-200) }));
        setActivity(prev => [{ ts: Date.now(), epId: ev.endpointId || '', text: `메시지 수신 ${peer}: ${String(ev.text || '').slice(0, 40)}`, kind: 'im' }, ...prev].slice(0, 200));
        return;
      }
      if (ev.ev === 'im-status') {
        return; // 전달 상태는 현재 표시만 생략(추후 확장)
      }
      if (ev.ev === 'record') {
        if (ev.endpointId) setRuntime(prev => ({ ...prev, [ev.endpointId]: { ...(prev[ev.endpointId] || { reg: 'unregistered', call: 'idle', dialed: '' }), recording: !!ev.recording } }));
        if (ev.error) setActivity(prev => [{ ts: Date.now(), epId: ev.endpointId || '', text: `녹음 오류: ${ev.error}`, kind: 'error' }, ...prev].slice(0, 200));
        return;
      }
      if (ev.ev === 'codec-warn') {
        const list = (Array.isArray(ev.unsupported) ? ev.unsupported : []).map((c: string) => c.toUpperCase()).join(', ');
        if (list) pushToast(`${labelOfEp(ev.endpointId)}: 미지원 코덱 ${list} — 무시됨 (AMR-WB 등 다른 코덱도 함께 선택하세요)`);
        return;
      }
      if (ev.ev === 'mwi') {
        if (ev.endpointId) setRuntime(prev => ({ ...prev, [ev.endpointId]: { ...(prev[ev.endpointId] || { reg: 'unregistered', call: 'idle', dialed: '' }), mwi: !!ev.waiting } }));
        setActivity(prev => [{ ts: Date.now(), epId: ev.endpointId || '', text: `음성사서함 ${ev.waiting ? '도착' : '없음'}`, kind: 'reg' }, ...prev].slice(0, 200));
        return;
      }
      // 활동 로그 적재 (reg/call/error/log/sip)
      const txt =
        ev.ev === 'reg' ? `등록: ${ev.reg}${ev.error ? ` (${ev.error})` : ''}` :
        ev.ev === 'call' ? `통화: ${ev.call}${ev.remote ? ` ${ev.remote}` : ''}${ev.error ? ` (${ev.error})` : ''}` :
        ev.ev === 'error' ? `오류: ${ev.error || ''}` :
        ev.ev === 'log' ? String(ev.text || '') :
        ev.ev === 'sip' ? `${ev.dir === 'out' ? '↗' : '↙'} ${ev.summary || ''}` : '';
      if (txt) setActivity(prev => [{ ts: Date.now(), epId: ev.endpointId || '', text: txt, kind: ev.ev, body: ev.ev === 'sip' ? String(ev.body || '') : undefined }, ...prev].slice(0, 500));
      // 실패는 토스트로 표면화
      if (ev.ev === 'reg' && ev.reg === 'failed') pushToast(`${labelOfEp(ev.endpointId)} 등록 실패 — ${ev.error || '서버 응답 없음'}`);
      else if (ev.ev === 'call' && ev.call === 'ended' && ev.error) pushToast(`${labelOfEp(ev.endpointId)} 통화 실패 — ${ev.error}`);
      else if (ev.ev === 'error' && ev.error) pushToast(String(ev.error));
      if (!ev.endpointId) return;
      // 등록 성공 시 자신의 프레즌스를 online 으로 게시
      if (ev.ev === 'reg' && ev.reg === 'registered') { try { api().sipSetPresence?.({ endpointId: ev.endpointId, online: true }); } catch {} }
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
      // in-flight 인 상태에서 일시 'unregistered' 가 오면 'registering' 으로 가림.
      // 'registered'/'failed' 가 오면 in-flight 해제.
      let regEv: RegState | undefined = ev.reg;
      if (regEv && reRegInFlightRef.current.has(ev.endpointId)) {
        if (regEv === 'unregistered') regEv = 'registering';
        else if (regEv === 'registered' || regEv === 'failed') reRegInFlightRef.current.delete(ev.endpointId);
      }
      setRuntime(prev => ({
        ...prev,
        [ev.endpointId]: {
          ...(prev[ev.endpointId] || { reg: 'unregistered', call: 'idle', dialed: '' }),
          ...(regEv ? { reg: regEv } : {}),
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
    setRuntime(prev => ({ ...prev, [id]: { ...(prev[id] || { reg: 'unregistered', call: 'idle', dialed: '' }), ...patch } }));
  // 매크로처럼 길게 도는 비동기 루프에서 "현재" 런타임을 읽기 위한 ref (stale closure 방지)
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const endpointsRef = useRef(endpoints);
  endpointsRef.current = endpoints;
  // 설정 변경 시 자동 재등록(디바운스) — 등록된 단말의 등록관련 설정이 바뀌면 unregister 없이 register 재적용
  const reRegTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lastRegCfgRef = useRef<Record<string, string>>({});
  // 코덱/설정 변경으로 우리가 직접 재등록을 트리거한 경우 사이드카의 일시 'unregistered'
  // 이벤트를 'registering' 으로 가려 UI 깜빡임 방지.
  const reRegInFlightRef = useRef<Set<string>>(new Set());

  // ── 토스트 알림 (등록/통화 실패 등) ──
  const [toasts, setToasts] = useState<{ id: string; text: string; kind: 'error' | 'info' }[]>([]);
  const pushToast = (text: string, kind: 'error' | 'info' = 'error') => {
    const id = uid('t');
    setToasts(p => [...p.slice(-4), { id, text, kind }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 6000);
  };
  const labelOfEp = (id: string) => endpointsRef.current.find(e => e.id === id)?.label || id;

  // ── 인입 벨소리 (WebAudio) ── 전역 마스터(ringEnabled) AND 단말별(ep.ring)
  const anyIncoming = endpoints.some(e => e.ring !== false && rt(e.id).call === 'incoming');
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
  const removeEndpoint = async (id: string) => {
    // native confirm 은 Chromium 측에서 caret/focus 를 빼앗아 되돌리지 않는 버그 — 자체 모달 사용.
    if (!(await notifyConfirm('단말 삭제', '이 단말을 삭제할까요? (등록 해제됩니다)'))) return;
    try { api().sipUnregister?.({ endpointId: id }); } catch {}
    setEndpoints(prev => prev.filter(e => e.id !== id));
    setRuntime(prev => { const n = { ...prev }; delete n[id]; return n; });
  };
  const updateEndpoint = (id: string, patch: Partial<SipEndpoint>) =>
    setEndpoints(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e)));
  const setDnd = (id: string, on: boolean) => { updateEndpoint(id, { dnd: on }); try { api().sipSetDnd?.({ endpointId: id, dnd: on }); } catch {} };
  const moveEndpoint = (id: string, dir: -1 | 1) => setEndpoints(prev => {
    const i = prev.findIndex(e => e.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= prev.length) return prev;
    const n = [...prev];[n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const copyFrom = (targetId: string, sourceId: string) => {
    const src = endpoints.find(e => e.id === sourceId);
    if (!src) return;
    // 계정 식별자(label/username/authId/displayName)는 비워서 새 단말이 자기 번호로 채우게 함.
    // (이전 코드는 authId/displayName 를 그대로 복사해서, 사용자가 username 만 바꿔도
    //  인증은 단말 1 의 ID 로 가서 401/실패하는 버그.)
    const { id, label, username, authId, displayName, ...rest } = src;
    void id; void label; void username; void authId; void displayName;
    updateEndpoint(targetId, { ...rest, label: '', username: '', authId: '', displayName: '' });
  };

  // ── 프로비저닝(설정 내보내기/가져오기) ──
  const exportConfig = () => {
    try {
      const data = JSON.stringify({ app: 'pepe-microsip', version: 1, exportedAt: new Date().toISOString(), endpoints, macros, contacts }, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'microsip-config.json';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch {}
  };
  const importConfig = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      const epCount = Array.isArray(obj.endpoints) ? obj.endpoints.length : 0;
      if (!(await notifyConfirm('설정 가져오기', `설정을 가져오면 현재 단말/매크로/주소록을 덮어씁니다. (단말 ${epCount}개) 계속할까요?`))) return;
      if (Array.isArray(obj.endpoints)) setEndpoints(obj.endpoints.slice(0, MAX_ENDPOINTS));
      if (Array.isArray(obj.macros)) setMacros(obj.macros);
      if (Array.isArray(obj.contacts)) setContacts(obj.contacts);
    } catch (e: any) {
      pushToast(`설정 파일을 읽을 수 없습니다: ${e?.message || e}`);
    }
  };

  // ── SIP 제어 ──
  const register = async (e: SipEndpoint) => {
    lastRegCfgRef.current[e.id] = cfgKey(e); // 자동 재등록 기준값 갱신
    // in-flight (자동 재등록) 인 경우엔 'registering' 으로 강제 전환하지 않음 — 서버 등록은 살아있음.
    if (!reRegInFlightRef.current.has(e.id)) {
      setRt(e.id, { reg: 'registering', error: undefined });
    }
    const r = await api().sipRegister?.({ endpoint: e }).catch((err: any) => ({ ok: false, error: String(err?.message || err) }));
    if (!r?.ok) { setRt(e.id, { reg: engineReady === false ? 'no-engine' : 'failed', error: r?.error }); pushToast(`${e.label} 등록 실패 — ${r?.error || 'SIP 엔진 미가용'}`); }
  };
  // 설정 카드 "저장" 전용 — draft commit 후 즉시 재등록 결과 반환.
  const saveEndpointDraft = async (id: string, draft: Partial<SipEndpoint>): Promise<{ ok: boolean; error?: string }> => {
    const cur = endpointsRef.current.find(e => e.id === id);
    if (!cur) return { ok: false, error: '단말을 찾을 수 없습니다' };
    const merged: SipEndpoint = { ...cur, ...draft };
    setEndpoints(prev => prev.map(e => e.id === id ? merged : e));
    if (!merged.server.trim() || !merged.username.trim()) return { ok: true };
    if (reRegTimers.current[id]) { clearTimeout(reRegTimers.current[id]); delete reRegTimers.current[id]; }
    reRegInFlightRef.current.delete(id);
    lastRegCfgRef.current[id] = cfgKey(merged);
    setRt(id, { reg: 'registering', error: undefined });
    const r = await api().sipRegister?.({ endpoint: merged }).catch((err: any) => ({ ok: false, error: String(err?.message || err) }));
    if (!r?.ok) {
      setRt(id, { reg: engineReady === false ? 'no-engine' : 'failed', error: r?.error });
      return { ok: false, error: r?.error || 'SIP 엔진 미가용' };
    }
    return await new Promise<{ ok: boolean; error?: string }>(resolve => {
      let done = false;
      const finish = (ok: boolean, error?: string) => { if (done) return; done = true; clearInterval(poll); clearTimeout(to); resolve({ ok, error }); };
      const poll = window.setInterval(() => {
        const rt2 = runtimeRef.current[id];
        if (!rt2) return;
        if (rt2.reg === 'registered') finish(true);
        else if (rt2.reg === 'failed') finish(false, rt2.error || '등록 실패');
      }, 150);
      const to = window.setTimeout(() => finish(false, '서버 응답 시간 초과(5초)'), 5000);
    });
  };
  const unregister = async (id: string) => {
    if (reRegTimers.current[id]) { clearTimeout(reRegTimers.current[id]); delete reRegTimers.current[id]; }
    delete lastRegCfgRef.current[id];
    reRegInFlightRef.current.delete(id);
    await api().sipUnregister?.({ endpointId: id }).catch(() => {}); setRt(id, { reg: 'unregistered', call: 'idle' });
  };
  const registerAll = () => endpoints.filter(e => e.server.trim() && e.username.trim()).forEach(e => register(e));
  const unregisterAll = () => endpoints.forEach(e => unregister(e.id));
  // 일괄 통화 제어 (다중 단말)
  const isActiveCall = (c: CallState) => c === 'connected' || c === 'held' || c === 'calling' || c === 'ringing' || c === 'incoming';
  const hangupAll = () => endpoints.forEach(e => { if (isActiveCall(rt(e.id).call)) hangup(e.id); });
  const muteAll = () => {
    const live = endpoints.filter(e => rt(e.id).call === 'connected' || rt(e.id).call === 'held');
    const mute = live.some(e => !rt(e.id).muted); // 하나라도 안 된게 있으면 전체 뮤트, 아니면 전체 해제
    live.forEach(e => { setRt(e.id, { muted: mute }); try { api().sipMute?.({ endpointId: e.id, mute }); } catch {} });
  };
  const applyDialPrefix = (id: string, number: string): string => {
    const ep = endpoints.find(e => e.id === id);
    const pfx = ep?.dialPrefix?.trim();
    const n = number.trim();
    if (!pfx || !n || /^[*#]/.test(n) || /^sips?:/i.test(n) || n.startsWith(pfx)) return n;
    return pfx + n;
  };
  const makeCall = async (id: string, number: string) => {
    const target = applyDialPrefix(id, number);
    if (!target) return;
    // 사전 검증 — 단말 설정에 활성 코덱이 하나도 없으면 INVITE 가 488 로 거절될 게 뻔하므로
    // 미리 안내. 사용자가 코덱 체크박스를 모두 끈 케이스.
    const ep = endpointsRef.current.find(e => e.id === id);
    if (ep && (!ep.codecs || ep.codecs.length === 0)) {
      const msg = '활성 코덱이 없습니다 — 설정에서 최소 1개 이상의 코덱을 활성화하세요 (예: G.711 ulaw/alaw)';
      setRt(id, { call: 'idle', error: msg });
      setActivity(prev => [{ ts: Date.now(), epId: id, text: msg, kind: 'error' }, ...prev].slice(0, 200));
      pushToast(`${labelOfEp(id)} 통화 실패 — ${msg}`);
      return;
    }
    setRt(id, { call: 'calling', remote: target, error: undefined });
    const r = await api().sipCall?.({ endpointId: id, target }).catch((err: any) => ({ ok: false, error: String(err?.message || err) }));
    if (!r?.ok) { setRt(id, { call: 'idle', error: r?.error }); pushToast(`${labelOfEp(id)} 통화 실패 — ${r?.error || 'SIP 엔진 미가용'}`); }
  };
  const hangup = async (id: string) => { await api().sipHangup?.({ endpointId: id }).catch(() => {}); setRt(id, { call: 'idle', muted: false }); };
  const answer = async (id: string) => { await api().sipAnswer?.({ endpointId: id }).catch(() => {}); };
  const reject = async (id: string) => { await api().sipReject?.({ endpointId: id }).catch(() => {}); setRt(id, { call: 'idle' }); };
  const toggleMute = async (id: string) => { const m = !rt(id).muted; setRt(id, { muted: m }); await api().sipMute?.({ endpointId: id, mute: m }).catch(() => {}); };
  const toggleHold = async (id: string) => { const held = rt(id).call !== 'held'; setRt(id, { call: held ? 'held' : 'connected' }); await api().sipHold?.({ endpointId: id, hold: held }).catch(() => {}); };
  const toggleRecord = async (id: string) => { await api().sipRecord?.({ endpointId: id, on: !rt(id).recording }).catch(() => {}); };
  const redial = (epId: string, remote: string) => {
    if (!remote.trim()) return;
    if (!endpoints.some(e => e.id === epId)) return; // 단말이 삭제된 기록
    setView('phones');
    void makeCall(epId, remote);
  };
  const sendIm = async (epId: string, peer: string, text: string) => {
    if (!epId || !peer.trim() || !text.trim()) return;
    const key = `${epId}|${normPeer(peer)}`;
    setConversations(prev => ({ ...prev, [key]: [...(prev[key] || []), { id: uid('im'), dir: 'out' as const, text, ts: Date.now() }].slice(-200) }));
    await api().sipSendIm?.({ endpointId: epId, target: peer, text }).catch(() => {});
  };
  const toggleSubscribe = (epId: string, peer: string, sub: boolean) => {
    if (!epId || !peer.trim()) return;
    try { api().sipSubscribePresence?.({ endpointId: epId, target: peer, subscribe: sub }); } catch {}
  };
  const transfer = async (id: string) => {
    const target = (typeof window !== 'undefined' ? window.prompt('전환할 번호/대상(SIP)을 입력하세요:', '') : '') || '';
    if (!target.trim()) return;
    await api().sipTransfer?.({ endpointId: id, target: target.trim() }).catch(() => {});
  };
  const sendDtmf = async (id: string, digit: string) => { await api().sipSendDtmf?.({ endpointId: id, digit }).catch(() => {}); };
  const pressKey = (id: string, key: string) => {
    const cur = rt(id);
    playDtmfTone(key);
    if (cur.call === 'connected') { void sendDtmf(id, key); }
    else setRt(id, { dialed: (cur.dialed || '') + key });
  };

  // 음량(마이크/스피커) — 변경/엔진 준비 시 데몬에 적용
  useEffect(() => { if (engineReady) { try { api().sipSetVolume?.({ mic: micLevel, speaker: spkLevel }); } catch {} } /* eslint-disable-next-line */ }, [engineReady, micLevel, spkLevel]);
  const applyVolume = (mic: number, spk: number) => { setMicLevel(mic); setSpkLevel(spk); persist({ micLevel: mic, spkLevel: spk }); };

  // 엔진 준비 + 단말 로드 완료 후 1회: autoRegister 단말 자동 등록
  useEffect(() => {
    if (autoRegDoneRef.current || !loadedRef.current || engineReady !== true || endpoints.length === 0) return;
    autoRegDoneRef.current = true;
    endpoints.forEach(e => { if (e.autoRegister !== false && e.server.trim() && e.username.trim()) void register(e); });
    /* eslint-disable-next-line */
  }, [engineReady, endpoints.length]);

  // 등록된 단말의 설정이 바뀌면 디바운스 후 자동 재등록(unregister 불필요) — 코덱 변경 등 즉시 반영
  useEffect(() => {
    endpoints.forEach(ep => {
      const reg = runtime[ep.id]?.reg;
      if (reg !== 'registered' && reg !== 'registering') return;
      const key = cfgKey(ep);
      if (!(ep.id in lastRegCfgRef.current)) { lastRegCfgRef.current[ep.id] = key; return; } // 기준값 최초 설정
      if (lastRegCfgRef.current[ep.id] === key) return; // 변경 없음
      if (reRegTimers.current[ep.id]) clearTimeout(reRegTimers.current[ep.id]);
      reRegTimers.current[ep.id] = setTimeout(() => {
        const cur = endpointsRef.current.find(e => e.id === ep.id);
        const r = runtimeRef.current[ep.id]?.reg;
        if (cur && (r === 'registered' || r === 'registering')) {
          reRegInFlightRef.current.add(ep.id); // 일시 unregistered 가림
          void register(cur);
          // 안전망 — confirm 이벤트가 안 오면 5초 후 강제 해제
          setTimeout(() => reRegInFlightRef.current.delete(ep.id), 5000);
        }
      }, 1000);
    });
    /* eslint-disable-next-line */
  }, [endpoints, runtime]);

  const applyAudioDevices = (inId: string, outId: string) => {
    setAudioIn(inId); setAudioOut(outId);
    persist({ audioIn: inId, audioOut: outId });
    try { api().sipSetAudioDevices?.({ input: inId, output: outId }); } catch {}
  };

  // ── 매크로 ──
  const runMacro = async (macro: Macro, targetIds: string[]) => {
    const reps = Math.max(1, macro.repeat || 1);
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const liveCall = (id: string): CallState => runtimeRef.current[id]?.call || 'idle';
    // 선택된 단말들에서 "동시" 실행. dialed 는 stale 상태(React) 대신 로컬 누적자 사용.
    await Promise.all(targetIds.map(async (epId) => {
      let dialed = runtimeRef.current[epId]?.dialed || '';
      for (let i = 0; i < reps; i++) {
        for (const step of macro.steps) {
          if (step.type === 'key') {
            // 통화 중이면 DTMF 전송, 아니면 번호 누적(+화면 표시)
            if (liveCall(epId) === 'connected') { await sendDtmf(epId, step.key); }
            else { dialed += step.key; setRt(epId, { dialed }); }
            await sleep(150);
          } else if (step.type === 'hold') { await sleep(step.ms); }
          else if (step.type === 'call') { await makeCall(epId, step.target || dialed); }
          else if (step.type === 'answer') { await answer(epId); }
          else if (step.type === 'hangup') { await hangup(epId); dialed = ''; }
        }
      }
    }));
  };

  return (
    <div className="microsip-ws" style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)' }}>
      {/* 토스트 알림 (등록/통화 실패 등) */}
      {toasts.length > 0 && (
        <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 }}>
          {toasts.map(t => (
            <div key={t.id} onClick={() => setToasts(p => p.filter(x => x.id !== t.id))}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                background: t.kind === 'error' ? '#3d1518' : 'var(--win-surface-2, #21262d)', border: `1px solid ${t.kind === 'error' ? '#f85149' : 'var(--win-border, #30363d)'}`,
                color: 'var(--win-text, #e6edf3)', fontSize: 12, boxShadow: '0 4px 14px rgba(0,0,0,0.4)' }}>
              <span style={{ flex: '0 0 auto' }}>{t.kind === 'error' ? '⛔' : 'ℹ'}</span>
              <span style={{ flex: 1, wordBreak: 'break-word' }}>{t.text}</span>
              <span style={{ flex: '0 0 auto', color: 'var(--win-text-dim, #9aa7b3)' }}>✕</span>
            </div>
          ))}
        </div>
      )}
      <MicroSipHeader
        view={view} setView={setView}
        engineReady={engineReady}
        canAdd={endpoints.length < MAX_ENDPOINTS}
        onAdd={addEndpoint}
        onRegisterAll={registerAll} onUnregisterAll={unregisterAll}
        onHangupAll={hangupAll} onMuteAll={muteAll}
        hasActiveCall={endpoints.some(e => isActiveCall(rt(e.id).call))}
        ringEnabled={ringEnabled} onToggleRing={() => { setRingEnabled(v => { persist({ ringEnabled: !v }); return !v; }); }}
        audioInputs={audioInputs} audioOutputs={audioOutputs}
        sipInputs={sipInputs} sipOutputs={sipOutputs}
        audioIn={audioIn} audioOut={audioOut} onAudio={applyAudioDevices}
        micLevel={micLevel} spkLevel={spkLevel} onVolume={applyVolume}
        epCount={endpoints.length}
      />

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {endpoints.length === 0 && (
          <div style={{ color: 'var(--win-text-dim, #9aa7b3)', padding: 24, textAlign: 'center' }}>
            단말이 없습니다. 우측 상단 <b>+ 단말</b> 으로 추가하세요 (최대 {MAX_ENDPOINTS}대).
          </div>
        )}

        {view === 'phones' && (
          // 단말이 많아지면 콜로그가 화면 밖으로 밀려나지 않도록 — 단말 영역(스크롤) + 콜로그(고정) 분리.
          <>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
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
                    onToggleRecord={() => toggleRecord(e.id)}
                    onVoicemail={() => e.voicemailNumber && makeCall(e.id, e.voicemailNumber)}
                    onRegister={() => register(e)}
                    onUnregister={() => unregister(e.id)}
                    onSetDialed={(s) => setRt(e.id, { dialed: s })}
                  />
                ))}
              </div>
            </div>
            {endpoints.length > 0 && (
              <div style={{ flexShrink: 0, padding: '0 12px 12px' }}>
                <CallLogPanel activity={activity} endpoints={endpoints} onClear={() => setActivity([])} />
              </div>
            )}
          </>
        )}

        {view === 'settings' && (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>프로비저닝:</span>
              <button onClick={exportConfig} title="단말/매크로/주소록을 JSON 으로 내보내기" style={miniBtn(true)}>⬇ 내보내기</button>
              <button onClick={() => importInputRef.current?.click()} title="JSON 설정 가져오기(덮어쓰기)" style={miniBtn(true)}>⬆ 가져오기</button>
              <input ref={importInputRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
                onChange={e => { void importConfig(e.target.files?.[0]); e.target.value = ''; }} />
              <span style={{ fontSize: 10, color: 'var(--win-text-dim, #6e7681)' }}>※ 비밀번호 평문 포함 — 취급 주의</span>
            </div>
            <div style={cardGrid}>
              {endpoints.map((e, idx) => (
                <SettingsCard key={e.id} ep={e} all={endpoints} reg={rt(e.id).reg}
                  idx={idx} total={endpoints.length}
                  onChange={(p) => updateEndpoint(e.id, p)}
                  onCopyFrom={(srcId) => copyFrom(e.id, srcId)}
                  onDnd={(on) => setDnd(e.id, on)}
                  onMove={(dir) => moveEndpoint(e.id, dir)}
                  onRegister={() => register(e)}
                  onUnregister={() => unregister(e.id)}
                  onRemove={() => removeEndpoint(e.id)}
                  onSave={(draft) => saveEndpointDraft(e.id, draft)}
                />
              ))}
            </div>
          </div>
        )}

        {view === 'macros' && (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
            <MacrosView macros={macros} setMacros={setMacros} endpoints={endpoints} onRun={runMacro} />
          </div>
        )}

        {view === 'contacts' && (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
            <ContactsView contacts={contacts} setContacts={setContacts} endpoints={endpoints} onDial={redial}
              presence={presence} onSubscribe={toggleSubscribe} />
          </div>
        )}

        {view === 'messages' && (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
            <MessagesView conversations={conversations} endpoints={endpoints} presence={presence}
              onSend={sendIm} onClear={(key) => setConversations(prev => { const n = { ...prev }; delete n[key]; return n; })} />
          </div>
        )}

        {view === 'log' && (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
            <CallHistory history={callHistory} endpoints={endpoints} onRedial={redial} onClear={() => setCallHistory([])} />
          </div>
        )}
      </div>
    </div>
  );
};

// ───────────────────────── 헤더 ─────────────────────────
const MicroSipHeader: React.FC<{
  view: 'phones' | 'settings' | 'macros' | 'contacts' | 'messages' | 'log'; setView: (v: any) => void;
  engineReady: boolean | null; canAdd: boolean; onAdd: () => void; epCount: number;
  onRegisterAll: () => void; onUnregisterAll: () => void;
  onHangupAll: () => void; onMuteAll: () => void; hasActiveCall: boolean;
  ringEnabled: boolean; onToggleRing: () => void;
  audioInputs: MediaDeviceInfo[]; audioOutputs: MediaDeviceInfo[];
  sipInputs: { idx: number; name: string }[]; sipOutputs: { idx: number; name: string }[];
  audioIn: string; audioOut: string; onAudio: (i: string, o: string) => void;
  micLevel: number; spkLevel: number; onVolume: (mic: number, spk: number) => void;
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
      {/* 메시지 탭 숨김 (요청에 따라 비표시) — {tab('messages', '💬 메시지')} */}
      {tab('log', '🗒 기록')}
      <button onClick={p.onRegisterAll} disabled={p.epCount === 0} title="모든 단말 등록"
        style={miniBtn(p.epCount > 0)}>전체 등록</button>
      <button onClick={p.onUnregisterAll} disabled={p.epCount === 0} title="모든 단말 해제"
        style={miniBtn(p.epCount > 0)}>전체 해제</button>
      <button onClick={p.onHangupAll} disabled={!p.hasActiveCall} title="진행 중인 모든 통화 끊기"
        style={{ ...miniBtn(p.hasActiveCall), color: p.hasActiveCall ? '#f85149' : undefined }}>전체 끊기</button>
      <button onClick={p.onMuteAll} disabled={!p.hasActiveCall} title="통화 중 단말 전체 뮤트/해제"
        style={miniBtn(p.hasActiveCall)}>전체 뮤트</button>
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
      <span title={`마이크 음량 ${Math.round(p.micLevel * 100)}%`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11 }}>
        🎙<input type="range" min={0} max={2} step={0.05} value={p.micLevel} onChange={e => p.onVolume(Number(e.target.value), p.spkLevel)} style={{ width: 64 }} />
      </span>
      <span title={`스피커 음량 ${Math.round(p.spkLevel * 100)}%`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11 }}>
        🔈<input type="range" min={0} max={2} step={0.05} value={p.spkLevel} onChange={e => p.onVolume(p.micLevel, Number(e.target.value))} style={{ width: 64 }} />
      </span>
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
const presColor: Record<string, string> = { online: '#3fb950', offline: '#8b949e', unknown: '#d29922' };
const ContactsView: React.FC<{
  contacts: Contact[]; setContacts: React.Dispatch<React.SetStateAction<Contact[]>>;
  endpoints: SipEndpoint[]; onDial: (epId: string, number: string) => void;
  presence: PresenceMap; onSubscribe: (epId: string, peer: string, sub: boolean) => void;
}> = ({ contacts, setContacts, endpoints, onDial, presence, onSubscribe }) => {
  const inp: React.CSSProperties = { padding: '6px 8px', background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 12 };
  const add = () => setContacts(prev => [...prev, { id: uid('c'), name: '', number: '', epId: endpoints[0]?.id }]);
  const update = (id: string, patch: Partial<Contact>) => setContacts(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
  const remove = (id: string) => setContacts(prev => prev.filter(c => c.id !== id));
  const dialEp = (c: Contact) => (c.epId && endpoints.some(e => e.id === c.epId)) ? c.epId : endpoints[0]?.id;
  const presOf = (epId: string | undefined, number: string) => epId ? presence[`${epId}|${normPeer(number)}`] : undefined;
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
        const pres = presOf(ep, c.number);
        return (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: 8, borderRadius: 8, background: 'var(--win-surface, #161b22)', border: '1px solid var(--win-border, #30363d)', flexWrap: 'wrap' }}>
            <span title={pres ? `프레즌스: ${pres}` : '프레즌스 미구독'} style={{ width: 9, height: 9, borderRadius: 999, flex: '0 0 auto', background: pres ? presColor[pres] || '#8b949e' : 'transparent', border: pres ? 'none' : '1px solid var(--win-border, #30363d)' }} />
            <input value={c.name} onChange={e => update(c.id, { name: e.target.value })} placeholder="이름" style={{ ...inp, flex: '1 1 110px', minWidth: 90 }} />
            <input value={c.number} onChange={e => update(c.id, { number: e.target.value })} placeholder="번호/SIP" style={{ ...inp, flex: '1 1 110px', minWidth: 90, fontFamily: 'Consolas, monospace' }} />
            <select value={c.epId || ''} onChange={e => update(c.id, { epId: e.target.value || undefined })} title="발신 단말" style={{ ...inp, flex: '0 1 120px' }}>
              <option value="">단말 자동</option>
              {endpoints.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
            <button onClick={() => ep && c.number.trim() && onSubscribe(ep, c.number, !pres)} disabled={!c.number.trim() || !ep} title={pres ? '프레즌스 구독 해제' : '프레즌스 구독'}
              style={{ ...inp, cursor: (c.number.trim() && ep) ? 'pointer' : 'not-allowed', opacity: (c.number.trim() && ep) ? 1 : 0.5 }}>{pres ? '👁' : '👁‍🗨'}</button>
            <button onClick={() => ep && onDial(ep, c.number)} disabled={!c.number.trim() || !ep} title={ep ? '통화' : '등록된 단말 없음'}
              style={{ ...inp, cursor: (c.number.trim() && ep) ? 'pointer' : 'not-allowed', background: '#238636', color: '#fff', border: 'none', fontWeight: 700, opacity: (c.number.trim() && ep) ? 1 : 0.5 }}>📞</button>
            <button onClick={() => remove(c.id)} title="삭제" style={{ ...inp, cursor: 'pointer', color: '#f85149' }}>🗑</button>
          </div>
        );
      })}
    </div>
  );
};

// ───────────────────────── 메시지(IM) + 프레즌스 ─────────────────────────
const MessagesView: React.FC<{
  conversations: Conversations; endpoints: SipEndpoint[]; presence: PresenceMap;
  onSend: (epId: string, peer: string, text: string) => void; onClear: (key: string) => void;
}> = ({ conversations, endpoints, presence, onSend, onClear }) => {
  const inp: React.CSSProperties = { padding: '6px 8px', background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 12 };
  const [activeKey, setActiveKey] = useState('');
  const [composeEp, setComposeEp] = useState(endpoints[0]?.id || '');
  const [peer, setPeer] = useState('');
  const [draft, setDraft] = useState('');
  const threadRef = useRef<HTMLDivElement | null>(null);
  const keys = Object.keys(conversations).sort((a, b) => {
    const la = conversations[a], lb = conversations[b];
    return (lb[lb.length - 1]?.ts || 0) - (la[la.length - 1]?.ts || 0);
  });
  const splitKey = (k: string): [string, string] => { const i = k.indexOf('|'); return i < 0 ? [k, ''] : [k.slice(0, i), k.slice(i + 1)]; };
  const [aEp, aPeer] = activeKey ? splitKey(activeKey) : ['', ''];
  const labelOf = (id: string) => endpoints.find(e => e.id === id)?.label || id;
  const msgs = activeKey ? (conversations[activeKey] || []) : [];
  const aPres = aEp ? presence[`${aEp}|${aPeer}`] : undefined;
  useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight; }, [activeKey, msgs.length]);
  const openConv = () => { if (!composeEp || !peer.trim()) return; setActiveKey(`${composeEp}|${normPeer(peer)}`); setPeer(''); };
  const send = () => { if (!activeKey || !draft.trim()) return; onSend(aEp, aPeer, draft.trim()); setDraft(''); };
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {/* 대화 목록 + 새 대화 */}
      <div style={{ flex: '1 1 220px', maxWidth: 280, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 8, background: 'var(--win-surface, #161b22)', border: '1px solid var(--win-border, #30363d)' }}>
          <div style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>새 대화</div>
          <select value={composeEp} onChange={e => setComposeEp(e.target.value)} style={inp}>
            {endpoints.length === 0 && <option value="">단말 없음</option>}
            {endpoints.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={peer} onChange={e => setPeer(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') openConv(); }} placeholder="상대 번호/SIP" style={{ ...inp, flex: 1, fontFamily: 'Consolas, monospace' }} />
            <button onClick={openConv} disabled={!composeEp || !peer.trim()} style={{ ...miniBtn(!!composeEp && !!peer.trim()) }}>열기</button>
          </div>
        </div>
        {keys.length === 0 && <div style={{ color: 'var(--win-text-dim, #9aa7b3)', fontSize: 12, padding: 8 }}>대화가 없습니다.</div>}
        {keys.map(k => {
          const [ep, pr] = splitKey(k);
          const last = conversations[k][conversations[k].length - 1];
          const pres = presence[k];
          return (
            <button key={k} onClick={() => setActiveKey(k)}
              style={{ textAlign: 'left', padding: 8, borderRadius: 8, cursor: 'pointer', border: '1px solid var(--win-border, #30363d)', background: k === activeKey ? 'var(--win-surface-2, #21262d)' : 'var(--win-surface, #161b22)', color: 'var(--win-text, #e6edf3)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, flex: '0 0 auto', background: pres ? (presColor[pres] || '#8b949e') : 'transparent', border: pres ? 'none' : '1px solid var(--win-border, #30363d)' }} />
                <b style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pr || '(미상)'}</b>
                <span style={{ fontSize: 9, color: 'var(--win-text-dim, #9aa7b3)' }}>{labelOf(ep)}</span>
              </div>
              {last && <div style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{last.dir === 'out' ? '나: ' : ''}{last.text}</div>}
            </button>
          );
        })}
      </div>
      {/* 대화 스레드 */}
      <div style={{ flex: '2 1 320px', minWidth: 260, display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--win-border, #30363d)', borderRadius: 8, background: 'var(--win-surface, #161b22)', padding: 10, minHeight: 360 }}>
        {!activeKey ? (
          <div style={{ color: 'var(--win-text-dim, #9aa7b3)', fontSize: 12, textAlign: 'center', margin: 'auto' }}>대화를 선택하거나 새로 시작하세요.</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--win-border, #30363d)', paddingBottom: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: 999, background: aPres ? (presColor[aPres] || '#8b949e') : 'transparent', border: aPres ? 'none' : '1px solid var(--win-border, #30363d)' }} title={aPres || '미구독'} />
              <b style={{ fontSize: 13, fontFamily: 'Consolas, monospace' }}>{aPeer}</b>
              <span style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)' }}>{labelOf(aEp)}</span>
              <button onClick={() => { onClear(activeKey); setActiveKey(''); }} title="대화 삭제" style={{ ...miniBtn(true), marginLeft: 'auto' }}>지우기</button>
            </div>
            <div ref={threadRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420 }}>
              {msgs.map(m => (
                <div key={m.id} style={{ alignSelf: m.dir === 'out' ? 'flex-end' : 'flex-start', maxWidth: '78%' }}>
                  <div style={{ padding: '6px 10px', borderRadius: 10, fontSize: 12, background: m.dir === 'out' ? 'var(--win-accent, #2b6b9b)' : 'var(--win-surface-2, #21262d)', color: m.dir === 'out' ? '#fff' : 'var(--win-text, #e6edf3)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>
                  <div style={{ fontSize: 9, color: 'var(--win-text-dim, #9aa7b3)', textAlign: m.dir === 'out' ? 'right' : 'left', marginTop: 2 }}>{new Date(m.ts).toLocaleTimeString()}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="메시지 입력 후 Enter" style={{ ...inp, flex: 1 }} />
              <button onClick={send} disabled={!draft.trim()} style={{ ...inp, cursor: draft.trim() ? 'pointer' : 'not-allowed', background: '#238636', color: '#fff', border: 'none', fontWeight: 700, opacity: draft.trim() ? 1 : 0.5 }}>전송</button>
            </div>
          </>
        )}
      </div>
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

// 활동 로그 색상 — 전화 탭 콜로그 패널에서 공통 사용
const logKindColor: Record<string, string> = { reg: '#58a6ff', call: '#3fb950', error: '#f85149', log: '#8b949e', im: '#a371f7', sip: '#d29922' };

// ───────────────────────── 폴드 가능 콜로그(전화 탭 하단) ─────────────────────────
// sessionStorage 에 펼침 여부 저장 — 새로 시작할 때마다 fold 기본.
const CALL_LOG_FOLD_KEY = 'pepe-microsip-callog-open';
const CallLogPanel: React.FC<{
  activity: { ts: number; epId: string; text: string; kind: string; body?: string }[];
  endpoints: SipEndpoint[]; onClear: () => void;
}> = ({ activity, endpoints, onClear }) => {
  const [open, setOpen] = useState<boolean>(() => {
    try { return sessionStorage.getItem(CALL_LOG_FOLD_KEY) === '1'; } catch { return false; }
  });
  // 클릭으로 펼친 행의 인덱스 집합 (recent slice 기준)
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpand = (i: number) => setExpanded(prev => {
    const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n;
  });
  const labelOf = (id: string) => endpoints.find(e => e.id === id)?.label || id || '시스템';
  const toggle = () => setOpen(v => {
    const n = !v;
    try { sessionStorage.setItem(CALL_LOG_FOLD_KEY, n ? '1' : '0'); } catch {}
    return n;
  });
  // 패널 높이 — 드래그로 조절. sessionStorage 보관.
  const [panelHeight, setPanelHeight] = useState<number>(() => {
    try { const v = parseInt(sessionStorage.getItem('pepe-microsip-callog-h') || '', 10); return isFinite(v) && v >= 120 ? v : 280; } catch { return 280; }
  });
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelHeight;
    const onMove = (ev: MouseEvent) => {
      // 위로 드래그 = 패널 커짐. 아래로 = 작아짐. 범위 120~window.innerHeight*0.8.
      const dy = startY - ev.clientY;
      const next = Math.max(120, Math.min(Math.round(window.innerHeight * 0.8), startH + dy));
      setPanelHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      try { sessionStorage.setItem('pepe-microsip-callog-h', String(panelHeightRef.current)); } catch {}
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const panelHeightRef = useRef(panelHeight);
  panelHeightRef.current = panelHeight;
  const [viewMode, setViewMode] = useState<'list' | 'seq'>(() => {
    try { return (sessionStorage.getItem('pepe-microsip-callog-mode') as any) || 'list'; } catch { return 'list'; }
  });
  const setMode = (m: 'list' | 'seq') => { setViewMode(m); try { sessionStorage.setItem('pepe-microsip-callog-mode', m); } catch {} };
  // SIP 상세 메시지 표시 토글 — 끄면 목록에서 SIP 패킷 라인을 숨김(통화/등록 이벤트만 표시).
  const [showSip, setShowSip] = useState<boolean>(() => {
    try { return sessionStorage.getItem('pepe-microsip-callog-sip') !== '0'; } catch { return true; }
  });
  const toggleSip = () => setShowSip(v => {
    const n = !v;
    try { sessionStorage.setItem('pepe-microsip-callog-sip', n ? '1' : '0'); } catch {}
    return n;
  });
  // 최근 콜/에러 우선 필터 — 통화/등록 실패 같은 항목이 위로. showSip=false 면 sip 제외.
  const recent = activity.filter(a => showSip || a.kind !== 'sip').slice(0, 30);
  // 시퀀스 뷰는 sip 메시지만, 오래된 순 (위→아래로 시간 흐름)
  const sipSeq = activity.filter(a => a.kind === 'sip').slice(0, 60).reverse();
  const errorCount = activity.filter(a => a.kind === 'error').length;
  return (
    <div style={{
      marginTop: 8, border: '1px solid var(--win-border, #30363d)', borderRadius: 8,
      background: 'var(--win-surface, #161b22)', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      ...(open ? { height: panelHeight } : {}),
    }}>
      {open && (
        <div onMouseDown={startResize}
          title="드래그해서 콜로그 크기 조절"
          style={{
            height: 5, cursor: 'ns-resize', background: 'var(--win-border, #30363d)',
            flexShrink: 0,
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--win-accent, #2b6b9b)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'var(--win-border, #30363d)')}
        />
      )}
      <div style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px', background: 'var(--win-surface-2, #21262d)',
        color: 'var(--win-text, #e6edf3)', fontSize: 12, fontWeight: 600,
      }}>
        <div onClick={toggle} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1 }}>
          <span style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)' }}>{open ? '▼' : '▶'}</span>
          <span>📋 콜로그 · 최근 활동</span>
          <span style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)' }}>({activity.length}건{errorCount > 0 ? ` · 오류 ${errorCount}` : ''})</span>
        </div>
        {open && (
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <button onClick={() => setMode('list')}
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, border: '1px solid var(--win-border, #30363d)', cursor: 'pointer', background: viewMode === 'list' ? 'var(--win-accent, #2b6b9b)' : 'transparent', color: '#fff' }}>
              📃 목록
            </button>
            <button onClick={() => setMode('seq')}
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, border: '1px solid var(--win-border, #30363d)', cursor: 'pointer', background: viewMode === 'seq' ? 'var(--win-accent, #2b6b9b)' : 'transparent', color: '#fff' }}>
              🔀 시퀀스
            </button>
            {viewMode === 'list' && (
              <button onClick={toggleSip}
                title={showSip ? 'SIP 상세 메시지 숨김' : 'SIP 상세 메시지 표시'}
                style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, border: '1px solid var(--win-border, #30363d)', cursor: 'pointer', background: showSip ? 'rgba(210,153,34,0.3)' : 'transparent', color: showSip ? '#fff' : 'var(--win-text-dim, #9aa7b3)' }}>
                {showSip ? '🟡 SIP 상세' : '⚪ SIP 상세'}
              </button>
            )}
            <button onClick={onClear} disabled={activity.length === 0}
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, border: '1px solid var(--win-border, #30363d)', background: 'transparent', color: 'var(--win-text-dim, #9aa7b3)', cursor: activity.length > 0 ? 'pointer' : 'not-allowed', opacity: activity.length > 0 ? 1 : 0.4 }}>
              지우기
            </button>
          </span>
        )}
      </div>
      {open && viewMode === 'seq' && (() => {
        // 활동 중인 endpoint 만 lifeline 컬럼으로 (등록 시도 / 메시지 발생 단말).
        // 모든 endpoint 를 다 보여주면 컬럼이 너무 많아짐. seq 에 등장한 endpointId 만.
        const eps = endpoints.filter(e => sipSeq.some(a => a.epId === e.id));
        const usedEps = eps.length > 0 ? eps : endpoints.slice(0, 1); // 비어 있어도 최소 1열
        const colCount = usedEps.length + 1; // +1 = 원격 컬럼
        const headerW = 70;
        return (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 0, display: 'flex', flexDirection: 'column' }}>
            {/* sticky 헤더 — 단말 1...N + 원격 */}
            <div style={{
              display: 'flex', alignItems: 'center', padding: '6px 8px', gap: 8,
              position: 'sticky', top: 0, background: 'var(--win-surface-2, #21262d)',
              borderBottom: '1px solid var(--win-border, #30363d)', zIndex: 1,
            }}>
              <span style={{ flex: `0 0 ${headerW}px`, fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)' }}>시간</span>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                {usedEps.map(e => (
                  <div key={e.id} style={{ flex: 1, textAlign: 'center' }}>
                    <b style={{ fontSize: 11, color: '#58a6ff' }}>📱 {e.label}</b>
                  </div>
                ))}
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <b style={{ fontSize: 11, color: '#3fb950' }}>🌐 원격 (서버/피어)</b>
                </div>
              </div>
            </div>
            {sipSeq.length === 0 && (
              <div style={{ color: 'var(--win-text-dim, #9aa7b3)', padding: 20, textAlign: 'center', fontSize: 11 }}>
                SIP 메시지가 아직 없습니다. 등록/통화 시도 시 REGISTER · INVITE · 200 OK 등이 여기 시퀀스로 표시됩니다.
              </div>
            )}
            {sipSeq.map((a, i) => {
              const isOut = a.text.startsWith('↗');
              const msg = a.text.replace(/^[↗↙]\s*/, '');
              const isOpen = expanded.has(i + 10000);
              const arrowColor = isOut ? '#58a6ff' : '#3fb950';
              // 어떤 단말 컬럼에 속하는지 — endpointId 매칭. 없으면 첫 컬럼.
              let epIdx = usedEps.findIndex(e => e.id === a.epId);
              if (epIdx < 0) epIdx = 0;
              const remoteIdx = usedEps.length; // 원격 = 맨 오른쪽
              // 화살표 시작/끝 컬럼 인덱스
              const fromIdx = isOut ? epIdx : remoteIdx;
              const toIdx = isOut ? remoteIdx : epIdx;
              const leftIdx = Math.min(fromIdx, toIdx);
              const rightIdx = Math.max(fromIdx, toIdx);
              // 컬럼 중심의 % 위치 (전체 콜로그 영역 기준)
              const colCenter = (idx: number) => (idx + 0.5) * (100 / colCount);
              const arrowLeft = colCenter(leftIdx);
              const arrowRight = 100 - colCenter(rightIdx);
              return (
                <div key={`s${a.ts}-${i}`} style={{ flexShrink: 0, borderBottom: '1px dashed rgba(255,255,255,0.06)' }}>
                  <div onClick={a.body ? () => toggleExpand(i + 10000) : undefined}
                    style={{
                      display: 'flex', alignItems: 'center', padding: '4px 8px', gap: 8,
                      cursor: a.body ? 'pointer' : 'default',
                      background: isOpen ? 'rgba(255,255,255,0.03)' : 'transparent',
                    }}>
                    <span style={{ flex: `0 0 ${headerW}px`, fontFamily: 'Consolas, monospace', fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', whiteSpace: 'nowrap' }}>
                      {new Date(a.ts).toLocaleTimeString()}
                    </span>
                    {/* lifeline 영역 — 각 컬럼 중심에 세로선, 화살표는 left→right 범위만 */}
                    <div style={{ position: 'relative', flex: 1, height: 28 }}>
                      {/* 각 컬럼의 lifeline */}
                      {Array.from({ length: colCount }).map((_, idx) => (
                        <div key={idx} style={{
                          position: 'absolute', left: `${colCenter(idx)}%`, top: 0, bottom: 0, width: 1,
                          background: idx === colCount - 1 ? 'rgba(63,185,80,0.4)' : 'rgba(88,166,255,0.4)',
                        }} />
                      ))}
                      {/* 화살표 라인 */}
                      <div style={{
                        position: 'absolute', left: `${arrowLeft}%`, right: `${arrowRight}%`,
                        top: 13, height: 1, background: arrowColor, opacity: 0.85,
                      }} />
                      {/* 화살표 head */}
                      <div style={{
                        position: 'absolute', top: 8,
                        [isOut ? 'right' : 'left' as any]: `${isOut ? arrowRight : arrowLeft}%`,
                        marginRight: isOut ? -3 : 0, marginLeft: isOut ? 0 : -3,
                        width: 0, height: 0, borderTop: '4px solid transparent', borderBottom: '4px solid transparent',
                        [isOut ? 'borderLeft' : 'borderRight' as any]: `6px solid ${arrowColor}`,
                      }} />
                      {/* 메시지 라벨 */}
                      <div style={{
                        position: 'absolute', left: `${arrowLeft + 1}%`, right: `${arrowRight + 1}%`,
                        top: 0, textAlign: 'center', fontSize: 11, color: '#e6edf3',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        lineHeight: '12px', background: 'var(--win-surface, #161b22)', padding: '0 6px',
                      }} title={msg}>{msg}</div>
                    </div>
                    {a.body && (
                      <span style={{ flex: '0 0 14px', fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)' }}>
                        {isOpen ? '▼' : '▶'}
                      </span>
                    )}
                  </div>
                  {isOpen && a.body && (
                    <pre style={{
                      margin: 0, padding: '8px 12px', borderTop: '1px dashed var(--win-border, #30363d)',
                      background: 'rgba(0,0,0,0.3)', color: '#c9d1d9',
                      fontFamily: 'Consolas, monospace', fontSize: 10, lineHeight: 1.4,
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflow: 'auto',
                    }}>{a.body}</pre>
                  )}
                </div>
              );
            })}
          </div>
        );
      })()}
      {open && viewMode === 'list' && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {recent.length === 0 && (
            <div style={{ color: 'var(--win-text-dim, #9aa7b3)', padding: 12, textAlign: 'center', fontSize: 11 }}>
              아직 기록이 없습니다. 등록·통화·오류 이벤트가 여기에 표시됩니다.
            </div>
          )}
          {recent.map((a, i) => {
            const hasDetail = !!a.body;
            const isOpen = expanded.has(i);
            return (
              <div key={`${a.ts}-${i}`} style={{
                borderRadius: 4, flexShrink: 0,
                background: a.kind === 'error' ? 'rgba(248,81,73,0.08)' : 'var(--win-bg, #0d1117)',
                border: `1px solid ${a.kind === 'error' ? 'rgba(248,81,73,0.3)' : 'var(--win-border, #30363d)'}`,
                overflow: 'hidden',
              }}>
                <div onClick={hasDetail ? () => toggleExpand(i) : undefined}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 12,
                    lineHeight: 1.4, minHeight: 22,
                    cursor: hasDetail ? 'pointer' : 'default',
                  }}>
                  <span style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', flex: '0 0 12px', textAlign: 'center' }}>
                    {hasDetail ? (isOpen ? '▼' : '▶') : ''}
                  </span>
                  <span style={{ fontFamily: 'Consolas, monospace', fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)', whiteSpace: 'nowrap', flex: '0 0 auto' }}>
                    {new Date(a.ts).toLocaleTimeString()}
                  </span>
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: logKindColor[a.kind] || '#8b949e', flex: '0 0 auto' }} />
                  <b style={{ fontSize: 11, color: 'var(--win-text, #e6edf3)', whiteSpace: 'nowrap', flex: '0 0 auto' }}>{labelOf(a.epId)}</b>
                  <span style={{ color: a.kind === 'error' ? '#f85149' : 'var(--win-text-dim, #c9d1d9)', wordBreak: 'break-word', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.text}>{a.text}</span>
                </div>
                {isOpen && hasDetail && (
                  <pre style={{
                    margin: 0, padding: '8px 10px', borderTop: '1px dashed var(--win-border, #30363d)',
                    background: 'rgba(0,0,0,0.25)', color: '#c9d1d9',
                    fontFamily: 'Consolas, monospace', fontSize: 10, lineHeight: 1.4,
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflow: 'auto',
                  }}>{a.body}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ───────────────────────── 단말 카드(키패드) ─────────────────────────
const regColor: Record<RegState, string> = { registered: '#3fb950', registering: '#d29922', unregistered: '#8b949e', failed: '#f85149', 'no-engine': '#8b949e' };
const PhoneCard: React.FC<{
  ep: SipEndpoint; rt: EndpointRuntime;
  onKey: (k: string) => void; onBackspace: () => void; onCall: () => void; onHangup: () => void; onClear: () => void;
  onAnswer: () => void; onReject: () => void; onToggleMute: () => void; onToggleHold: () => void; onTransfer: () => void; onToggleRecord: () => void; onVoicemail: () => void;
  onRegister: () => void; onUnregister: () => void;
  onSetDialed: (s: string) => void;
}> = ({ ep, rt, onKey, onBackspace, onCall, onHangup, onClear, onAnswer, onReject, onToggleMute, onToggleHold, onTransfer, onToggleRecord, onVoicemail, onRegister, onUnregister, onSetDialed }) => {
  // 재다이얼용 마지막 발신 번호 — sessionStorage 로 endpoint 별 영속 (앱 재시작 시 초기화)
  const lastDialedKey = `pepe-sip-last-${ep.id}`;
  const [lastDialed, setLastDialed] = useState<string>(() => {
    try { return sessionStorage.getItem(lastDialedKey) || ''; } catch { return ''; }
  });
  const callAndRemember = () => {
    if (rt.dialed && rt.dialed.trim()) {
      try { sessionStorage.setItem(lastDialedKey, rt.dialed.trim()); } catch {}
      setLastDialed(rt.dialed.trim());
    }
    onCall();
  };
  const redial = () => {
    if (!lastDialed) return;
    onSetDialed(lastDialed);
    setTimeout(() => onCall(), 50);
  };
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
  // 연결 시 자동 녹음 (단말별)
  useEffect(() => {
    if (rt.call === 'connected' && ep.autoRecord && !rt.recording) onToggleRecord();
    /* eslint-disable-next-line */
  }, [rt.call]);
  const mmss = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  return (
    <div style={{ border: '1px solid var(--win-border, #30363d)', borderRadius: 12, background: 'var(--win-surface, #161b22)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 9, height: 9, borderRadius: 999, background: regColor[rt.reg] }} title={rt.reg} />
        <b style={{ fontSize: 13 }}>{ep.label}</b>
        {ep.dnd && <span title="방해 금지" style={{ fontSize: 11 }}>🌙</span>}
        {rt.mwi && <button onClick={onVoicemail} title={ep.voicemailNumber ? '음성사서함 듣기' : '음성사서함 도착'} disabled={!ep.voicemailNumber}
          style={{ border: 'none', background: 'transparent', cursor: ep.voicemailNumber ? 'pointer' : 'default', fontSize: 12, padding: 0 }}>📨</button>}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={`${ep.username || '미설정'}@${ep.server || '—'}`}>{ep.username || '미설정'}@{ep.server || '—'}</span>
        {rt.reg === 'registered'
          ? <button onClick={onUnregister} title="이 단말 등록 해제"
              style={{ padding: '2px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text, #e6edf3)', cursor: 'pointer', flexShrink: 0 }}>해제</button>
          : <button onClick={onRegister} title="이 단말 등록" disabled={!ep.server.trim() || !ep.username.trim()}
              style={{ padding: '2px 8px', fontSize: 10, borderRadius: 4, border: 'none', background: 'var(--win-accent, #2b6b9b)', color: '#fff', fontWeight: 700, cursor: (ep.server.trim() && ep.username.trim()) ? 'pointer' : 'not-allowed', opacity: (ep.server.trim() && ep.username.trim()) ? 1 : 0.5, flexShrink: 0 }}>등록</button>}
      </div>
      <div style={{ minHeight: 26, padding: '2px 4px 2px 8px', borderRadius: 6, background: 'var(--win-bg, #0d1117)', border: '1px solid var(--win-border, #30363d)', display: 'flex', alignItems: 'center', gap: 4 }}>
        {(inCall || incoming) ? (
          <span style={{ flex: 1, fontFamily: 'Consolas, monospace', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rt.remote || ''}</span>
        ) : (
          <input
            value={rt.dialed || ''}
            onChange={e => onSetDialed(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') callAndRemember(); }}
            placeholder="번호 또는 sip:..."
            style={{ flex: 1, padding: 0, background: 'transparent', color: 'var(--win-text, #e6edf3)', border: 'none', outline: 'none', fontFamily: 'Consolas, monospace', fontSize: 12, letterSpacing: 0.5, minWidth: 0 }}
          />
        )}
        {!inCall && !incoming && lastDialed && (
          <button onClick={redial} title={`재다이얼: ${lastDialed}`}
            style={{ padding: '1px 6px', fontSize: 10, borderRadius: 4, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text-dim, #9aa7b3)', cursor: 'pointer', flexShrink: 0 }}>↻</button>
        )}
        <span style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', flexShrink: 0 }}>
          {(rt.call === 'connected' || rt.call === 'held') ? mmss : (rt.call !== 'idle' ? rt.call : '')}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
        {DIAL_KEYS.map(k => (
          <button key={k} onClick={() => onKey(k)}
            style={{ padding: '6px 0', borderRadius: 6, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text, #e6edf3)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{k}</button>
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
          <button onClick={onToggleRecord} title={rt.recording ? '녹음 중지' : '녹음'} style={{ ...callBtn(rt.recording ? '#da3633' : 'var(--win-surface-2, #21262d)'), flex: '0 0 52px', color: '#fff' }}>{rt.recording ? '⏹' : '⏺'}</button>
        </div>
      ) : inCall ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onHangup} style={callBtn('#da3633')}>⛔ 끊기</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={callAndRemember} style={callBtn('#238636')}>📞 통화</button>
          <button onClick={redial} disabled={!lastDialed} title={lastDialed ? `재다이얼: ${lastDialed}` : '재다이얼 (이전 발신 없음)'}
            style={{ ...callBtn('var(--win-surface-2, #21262d)'), flex: '0 0 48px', color: 'var(--win-text, #e6edf3)', opacity: lastDialed ? 1 : 0.4, cursor: lastDialed ? 'pointer' : 'not-allowed' }}>↻</button>
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
// 접이식 섹션 (단말 설정 그룹화)
const Section: React.FC<{ title: string; defaultOpen?: boolean; children: React.ReactNode }> = ({ title, defaultOpen, children }) => {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div style={{ borderTop: '1px solid var(--win-border, #30363d)', marginTop: 8, paddingTop: 8 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--win-text, #e6edf3)', fontSize: 12, fontWeight: 700, padding: '2px 0' }}>
        <span style={{ fontSize: 10, width: 10, color: 'var(--win-text-dim, #9aa7b3)' }}>{open ? '▾' : '▸'}</span>{title}
      </button>
      {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>{children}</div>}
    </div>
  );
};
const SettingsCard: React.FC<{
  ep: SipEndpoint; all: SipEndpoint[]; reg: RegState; idx: number; total: number;
  onChange: (p: Partial<SipEndpoint>) => void; onCopyFrom: (srcId: string) => void;
  onDnd: (on: boolean) => void; onMove: (dir: -1 | 1) => void;
  onRegister: () => void; onUnregister: () => void; onRemove: () => void;
  onSave: (draft: Partial<SipEndpoint>) => Promise<{ ok: boolean; error?: string }>;
}> = ({ ep, all, reg, idx, total, onChange, onCopyFrom, onDnd, onMove, onRegister, onUnregister, onRemove, onSave }) => {
  // draft — 사용자가 입력한 변경분. 저장(register 성공) 시에만 ep 에 commit.
  const [draft, setDraft] = useState<Partial<SipEndpoint>>({});
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string>('');
  const cur: SipEndpoint = { ...ep, ...draft };
  const dirty = Object.keys(draft).length > 0;
  const patch = (p: Partial<SipEndpoint>) => { setSaveErr(''); setDraft(prev => ({ ...prev, ...p })); };
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true); setSaveErr('');
    const r = await onSave(draft);
    setSaving(false);
    if (r.ok) setDraft({});
    else setSaveErr(r.error || '저장/등록 실패');
  };
  const cancel = () => { if (saving) return; setDraft({}); setSaveErr(''); };
  // 외부에서 들어오는 변경(설정 복사 등)은 onChange (parent endpoint 직접 변경) — 카드 내 입력은 patch.
  void onChange;
  const onChangeLocal = patch;
  const field = (label: string, node: React.ReactNode) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>
      <span>{label}</span>{node}
    </label>
  );
  const inp: React.CSSProperties = { padding: '6px 8px', background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 12 };
  const toggleCodec = (c: SipCodec) => {
    const has = cur.codecs.includes(c);
    onChangeLocal({ codecs: has ? cur.codecs.filter(x => x !== c) : [...cur.codecs, c] });
  };
  const moveCodec = (c: SipCodec, dir: -1 | 1) => {
    const i = cur.codecs.indexOf(c); if (i < 0) return;
    const j = i + dir; if (j < 0 || j >= cur.codecs.length) return;
    const next = [...cur.codecs];[next[i], next[j]] = [next[j], next[i]]; onChangeLocal({ codecs: next });
  };
  return (
    <div style={{ border: '1px solid var(--win-border, #30363d)', borderRadius: 12, background: 'var(--win-surface, #161b22)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ width: 9, height: 9, borderRadius: 999, background: regColor[reg] }} title={reg} />
        <input value={cur.label} onChange={e => onChangeLocal({ label: e.target.value })} style={{ ...inp, fontWeight: 700, fontSize: 13, minWidth: 120 }} />
        <select defaultValue="" onChange={e => { if (e.target.value) { onCopyFrom(e.target.value); e.target.value = ''; } }} title="다른 단말 설정 복사" style={inp}>
          <option value="">설정 복사 ←</option>
          {all.filter(x => x.id !== cur.id).map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => onMove(-1)} disabled={idx === 0} title="위로" style={{ ...inp, cursor: idx === 0 ? 'not-allowed' : 'pointer', opacity: idx === 0 ? 0.4 : 1, padding: '6px 8px' }}>▲</button>
          <button onClick={() => onMove(1)} disabled={idx >= total - 1} title="아래로" style={{ ...inp, cursor: idx >= total - 1 ? 'not-allowed' : 'pointer', opacity: idx >= total - 1 ? 0.4 : 1, padding: '6px 8px' }}>▼</button>
          {reg === 'registered'
            ? <button onClick={onUnregister} style={{ ...inp, cursor: 'pointer', background: 'var(--win-surface-2, #21262d)' }}>등록 해제</button>
            : <button onClick={onRegister} style={{ ...inp, cursor: 'pointer', background: 'var(--win-accent, #2b6b9b)', color: '#fff', border: 'none', fontWeight: 700 }}>등록</button>}
          <button onClick={onRemove} title="단말 삭제" style={{ ...inp, cursor: 'pointer', color: '#f85149' }}>🗑</button>
        </div>
      </div>
      {/* 📇 계정 */}
      <Section title="📇 계정" defaultOpen>
        {field('SIP 서버 (registrar)', <input value={cur.server} onChange={e => onChangeLocal({ server: e.target.value })} placeholder="sip.example.com" style={inp} />)}
        {field('도메인 (미지정 시 서버와 동일)', <input value={cur.domain || ''} onChange={e => onChangeLocal({ domain: e.target.value })} placeholder="example.com" style={inp} />)}
        <div style={{ display: 'flex', gap: 8 }}>
          {field('포트', <input type="number" value={cur.port} onChange={e => onChangeLocal({ port: Number(e.target.value) || 5060 })} style={inp} />)}
          {field('전송', <select value={cur.transport} onChange={e => onChangeLocal({ transport: e.target.value as any })} style={inp}><option value="udp">UDP</option><option value="tcp">TCP</option><option value="tls">TLS</option></select>)}
        </div>
        {field('사용자(번호)', <input value={cur.username} onChange={e => onChangeLocal({ username: e.target.value })} style={inp} />)}
        {field('인증 ID(로그인, 선택)', <input value={cur.authId || ''} onChange={e => onChangeLocal({ authId: e.target.value })} style={inp} />)}
        {field('비밀번호', <input type="password" value={cur.password} onChange={e => onChangeLocal({ password: e.target.value })} style={inp} />)}
        {field('표시 이름(선택)', <input value={cur.displayName || ''} onChange={e => onChangeLocal({ displayName: e.target.value })} style={inp} />)}
        {field('아웃바운드 프록시(선택)', <input value={cur.proxy || ''} onChange={e => onChangeLocal({ proxy: e.target.value })} placeholder="proxy:5060" style={inp} />)}
      </Section>

      {/* 🎚 코덱 */}
      <Section title="🎚 코덱 (체크=사용, 위가 우선순위)">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {ALL_CODECS.slice().sort((a, b) => {
            const ia = cur.codecs.indexOf(a.id), ib = cur.codecs.indexOf(b.id);
            if (ia < 0 && ib < 0) return 0; if (ia < 0) return 1; if (ib < 0) return -1; return ia - ib;
          }).map(c => {
            const on = cur.codecs.includes(c.id);
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
      </Section>

      {/* 📞 등록 · NAT · 보안 */}
      <Section title="📞 등록 · NAT · 보안">
        <div style={{ display: 'flex', gap: 8 }}>
          {field('등록 만료(초)', <input type="number" value={cur.regExpiry ?? 300} onChange={e => onChangeLocal({ regExpiry: Number(e.target.value) || 300 })} style={inp} />)}
          {field('살아유지(초)', <input type="number" value={cur.keepAlive ?? 15} onChange={e => onChangeLocal({ keepAlive: Number(e.target.value) || 0 })} style={inp} />)}
        </div>
        {field('미디어 암호화(SRTP)', <select value={cur.srtp || 'disabled'} onChange={e => onChangeLocal({ srtp: e.target.value as any })} style={inp}><option value="disabled">사용 안 함</option><option value="optional">선택(optional)</option><option value="mandatory">필수(mandatory)</option></select>)}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={!!cur.iceEnabled} onChange={e => onChangeLocal({ iceEnabled: e.target.checked })} /> ICE 사용
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={!!cur.disableSessionTimer} onChange={e => onChangeLocal({ disableSessionTimer: e.target.checked })} /> 세션 타이머 비활성화
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={cur.publishPresence !== false} onChange={e => onChangeLocal({ publishPresence: e.target.checked })} /> 계정 상태 게시
          </label>
        </div>
        {field('STUN 서버(host:port)', <input value={cur.stunServer || ''} onChange={e => onChangeLocal({ stunServer: e.target.value })} placeholder="stun.example.com:3478" style={inp} />)}
        {field('TURN 서버(host:port)', <input value={cur.turnServer || ''} onChange={e => onChangeLocal({ turnServer: e.target.value })} placeholder="turn.example.com:3478" style={inp} />)}
        {cur.turnServer ? field('TURN 사용자', <input value={cur.turnUser || ''} onChange={e => onChangeLocal({ turnUser: e.target.value })} style={inp} />) : null}
        {cur.turnServer ? field('TURN 비밀번호', <input type="password" value={cur.turnPassword || ''} onChange={e => onChangeLocal({ turnPassword: e.target.value })} style={inp} />) : null}
      </Section>

      {/* ⚙ 통화 · 프로그램 */}
      <Section title="⚙ 통화 · 프로그램">
        {field('발신 prefix', <input value={cur.dialPrefix || ''} onChange={e => onChangeLocal({ dialPrefix: e.target.value })} placeholder="예: 9 (외부 회선)" style={inp} />)}
        {field('음성사서함 번호', <input value={cur.voicemailNumber || ''} onChange={e => onChangeLocal({ voicemailNumber: e.target.value })} placeholder="*97" style={inp} />)}
        {field('DTMF 방식', <select value={cur.dtmfMode || 'rfc2833'} onChange={e => onChangeLocal({ dtmfMode: e.target.value as any })} style={inp}><option value="rfc2833">RFC 2833</option><option value="info">SIP INFO</option><option value="inband">In-band</option></select>)}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={cur.autoRegister !== false} onChange={e => onChangeLocal({ autoRegister: e.target.checked })} /> 시작 시 등록
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={!!cur.autoAnswer} onChange={e => onChangeLocal({ autoAnswer: e.target.checked })} /> 자동 응답
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={cur.callWaiting !== false} onChange={e => onChangeLocal({ callWaiting: e.target.checked })} /> 통화 중 대기
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={cur.ring !== false} onChange={e => onChangeLocal({ ring: e.target.checked })} /> 🔔 벨소리
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={!!cur.autoRecord} onChange={e => onChangeLocal({ autoRecord: e.target.checked })} /> ⏺ 자동 녹음
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={!!cur.hideCallerId} onChange={e => onChangeLocal({ hideCallerId: e.target.checked })} /> 발신번호 숨김
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={!!cur.dnd} onChange={e => onDnd(e.target.checked)} /> 🌙 방해 금지(DND)
          </label>
        </div>
        <div style={{ fontSize: 10, color: 'var(--win-text-dim, #6e7681)' }}>※ 마이크/스피커·음량은 상단 공통(전역) 설정을 사용합니다.</div>
      </Section>
      {/* 저장 / 취소 액션 바 — 변경분(draft) 이 있을 때만 활성. 저장 시 재등록 후 결과 확인. */}
      <div style={{
        marginTop: 12, padding: '10px 12px', borderTop: '1px solid var(--win-border, #30363d)',
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        background: dirty ? 'rgba(217,153,34,0.08)' : 'transparent', borderRadius: 6,
      }}>
        {saveErr && (
          <span style={{ flex: 1, fontSize: 11, color: '#f85149' }}>⚠ {saveErr}</span>
        )}
        {!saveErr && dirty && (
          <span style={{ flex: 1, fontSize: 11, color: '#d29922' }}>● 저장되지 않은 변경분이 있습니다</span>
        )}
        {!saveErr && !dirty && (
          <span style={{ flex: 1, fontSize: 11, color: 'var(--win-text-dim, #6e7681)' }}>변경 사항 없음</span>
        )}
        <button onClick={cancel} disabled={!dirty || saving}
          style={{ ...inp, cursor: (!dirty || saving) ? 'not-allowed' : 'pointer', opacity: (!dirty || saving) ? 0.5 : 1 }}>
          취소
        </button>
        <button onClick={save} disabled={!dirty || saving}
          style={{
            ...inp,
            cursor: (!dirty || saving) ? 'not-allowed' : 'pointer',
            background: dirty && !saving ? 'var(--win-accent, #2b6b9b)' : 'var(--win-surface-2, #21262d)',
            color: '#fff', border: 'none', fontWeight: 700,
            opacity: (!dirty || saving) ? 0.6 : 1,
          }}>
          {saving ? '저장 중...' : '저장'}
        </button>
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
  const stepLabel = (s: MacroStep) => s.type === 'key' ? `키 '${s.key}'` : s.type === 'hold' ? `${s.ms}ms 대기` : s.type === 'call' ? `통화${s.target ? ` ${s.target}` : '(입력값)'}` : s.type === 'answer' ? '받기' : '끊기';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div><button onClick={addMacro} style={{ ...inp, cursor: 'pointer', background: 'var(--win-accent, #2b6b9b)', color: '#fff', border: 'none', fontWeight: 700 }}>+ 매크로 추가</button></div>
      {macros.map(m => {
        const targets = sel[m.id] || endpoints.map(e => e.id);
        return (
          <div key={m.id} style={{ border: '1px solid var(--win-border, #30363d)', borderRadius: 12, background: 'var(--win-surface, #161b22)', padding: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input value={m.name} onChange={e => update(m.id, { name: e.target.value })} style={{ ...inp, fontWeight: 700 }} />
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }} title="매크로 전체 반복 횟수">
                반복 <input type="number" min={1} value={m.repeat || 1} onChange={e => update(m.id, { repeat: Math.max(1, Number(e.target.value) || 1) })} style={{ ...inp, width: 52 }} />
              </label>
              <button onClick={() => onRun(m, targets)} disabled={targets.length === 0} title="선택 단말에서 동시 실행" style={{ ...inp, cursor: targets.length ? 'pointer' : 'not-allowed', background: '#238636', color: '#fff', border: 'none', fontWeight: 700, opacity: targets.length ? 1 : 0.5 }}>▶ 동시 실행 ({targets.length})</button>
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
      <button onClick={() => onAdd({ type: 'answer' })} style={btn}>+ 받기</button>
      <button onClick={() => onAdd({ type: 'hangup' })} style={btn}>+ 끊기</button>
    </div>
  );
};
