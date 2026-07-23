// src/utils/sipShared.ts
// MicroSipWorkspace.tsx 와 SswSoftphoneWorkspace.tsx 가 공유하는 데이터 모델/헬퍼.
// 두 워크스페이스는 서로 다른 컴포넌트(별개 화면/기능 구성)지만, 같은 sip-sidecar 엔진과
// 프로토콜(electron/sipSidecar.ts, sip-sidecar/src/sipd.cpp)을 쓰므로 계정 필드/타입은
// 반드시 여기 한 곳에서만 정의해 양쪽이 어긋나지 않게 한다.

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
  mwiSubscribe?: boolean;        // 음성사서함(MWI) SUBSCRIBE, 기본 on — SSW 는 기본 off(MiniSoftphone 은 미구현)
  codecs: SipCodec[];      // 우선순위 순서
  autoAnswer?: boolean;
  autoRegister?: boolean;  // 워크스페이스 진입(엔진 준비) 시 자동 등록 (기본 on)
  dnd?: boolean;           // 방해 금지 — 인입을 486 Busy 로 자동 거절
  voicemailNumber?: string; // 음성사서함 접속 번호
  dialPrefix?: string;       // 발신 시 앞에 붙이는 prefix (외부 회선 등; */# 코드·SIP URI 제외)
  keepAlive?: number;        // UDP keep-alive(살아유지) 초, 기본 15
  // ── 프로그램 설정(단말별) ──
  ring?: boolean;            // 인입 벨소리 (단말별), 기본 on
  callWaiting?: boolean;     // 통화 중 두 번째 인입 거절 방식 — on(기본)이면 486 Busy 명시 거절, off면 무응답(무시).
                             // 어느 쪽이든 두 번째 콜은 연결/대기되지 않음(MiniSoftphone: CallWaitingEnabled — 실제로 진짜 통화중대기(2회선)는 미구현).
  autoRecord?: boolean;      // 연결 시 자동 녹음, 기본 off
  mediaFile?: string;        // 🎵 미디어 송출 버튼이 사용할 파일(미리 지정 — 통화 중 선택 다이얼로그 생략)
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
  // ── 네트워크(RTP/SIP 포트) — 단말(계정)별로 독립 지정 가능 ──
  rtpPortMin?: number;                              // RTP 포트 범위 시작 (0/미지정 = 자동)
  rtpPortMax?: number;                              // RTP 포트 범위 끝
  localSipPort?: number;                            // 로컬 SIP 포트(0/미지정 = 자동·공용). 지정 시 이 단말 전용 전송 생성
  userAgent?: string;                               // User-Agent(비우면 데몬 기본값). 계정별로 헤더에 직접 실어 전송
  // ── Contact 고정(SBC 등에서 안정적인 Contact 필요 시) ──
  contactForced?: string;                           // 비우면 자동 계산(권장), 값이 있으면 그 URI 로 고정
  // ── 발신 시 추가 헤더(값이 있을 때만 실제 통화에 포함) ──
  divertHeader?: string;                            // Diversion
  rpidHeader?: string;                              // Remote-Party-ID
  paiHeader?: string;                               // P-Asserted-Identity
  paiPrivacy?: string;                              // Privacy (RFC 3323: none/header/session/user/id/critical) — paiHeader 값이 있을 때만 포함
  // ── 수신(UAS) 거절 응답 ──
  rejectCode?: number;                              // 거절 시 보낼 상태 코드, 기본 486(MiniSoftphone 과 동일)
  rejectTiming?: 'immediate' | 'after180';          // 즉시 거절 vs 180 송신 후 지연 거절, 기본 immediate
  rejectDelaySec?: number;                          // after180 일 때 180 이후 지연 시간(초)
  // ── 수신 발신번호 우선순위(표시용) — 앞쪽 헤더부터 확인해 첫 값 사용 ──
  callerIdPriority?: ('rpid' | 'from' | 'pai')[];   // 기본 ['rpid','from','pai']
  // ── SKB(SSW) 콜플로우 — 표준 re-INVITE 대신 SIP INFO(0x10 04 00 00 + Supported: replaces)로
  //    보류/재개를 신호한다(실단말 캡처 기준). SSW 소프트폰이 만드는 단말만 기본 on, 일반
  //    MicroSIP 계정은 표준 서버 호환을 위해 기본 off(re-INVITE) 유지.
  holdViaInfo?: boolean;
  // RTP 무응답(무음) 자동 종료(초) — 0/미지정 = 사용 안 함. 보류 중인 통화는 감시하지 않는다.
  // MiniSoftphone 이식(SIPSorcery 안정성 워크어라운드, 기본 60초) — SKB 프로토콜 자체는 아님.
  rtpTimeoutSec?: number;
  // ── 단말 전용 마이크/스피커 (비우면 "자동" = 전역 공용 장치) ──
  // PJSUA2 는 프로세스 전체에 하나의 사운드 장치만 지원해 기본적으로 모든 단말이 같은
  // 마이크/스피커를 공유한다. 여기 지정하면 sipd 가 저수준 API 로 이 단말의 통화만 별도
  // 물리 장치에 연결한다(다른 단말과 동시에 서로 다른 장치 사용 가능).
  audioIn?: string;
  audioOut?: string;
  // 단말 전용 마이크/스피커 음량(1.0=조정 없음, 0=음소거, 미지정 시 1.0). 전역 공통 음량은
  // 제거되고 단말별 지정으로 대체됨 — 통화 자신의 오디오에 직접 적용되므로 위 audioIn/Out
  // 지정(전용 장치) 여부와 무관하게 항상 적용된다.
  micLevel?: number;
  spkLevel?: number;
};

export type RegState = 'unregistered' | 'registering' | 'registered' | 'failed' | 'no-engine';
export type CallState = 'idle' | 'calling' | 'ringing' | 'incoming' | 'connected' | 'held' | 'ended';
export type EndpointRuntime = { reg: RegState; call: CallState; dialed: string; remote?: string; muted?: boolean; speakerMuted?: boolean; recording?: boolean; mwi?: boolean; error?: string; capturing?: boolean; captureFile?: string; mediaPlaying?: boolean; ctrActive?: boolean };

export type MacroStep =
  | { type: 'key'; key: string }
  | { type: 'hold'; ms: number }
  | { type: 'call'; target: string }
  | { type: 'answer' }
  | { type: 'hangup' };
export type Macro = { id: string; name: string; steps: MacroStep[]; repeat?: number };

export type Contact = { id: string; name: string; number: string; epId?: string };

export type ImMsg = { id: string; dir: 'in' | 'out'; text: string; ts: number; status?: string };
// 대화는 `${epId}|${peer}` 키로 묶는다. peer 는 정규화된 상대 식별자.
export type Conversations = Record<string, ImMsg[]>;
// 프레즌스: `${epId}|${peer}` → 'online'|'offline'|'unknown'
export type PresenceMap = Record<string, string>;
// sip:user@host / <...> → bare user(peer) 정규화
export const normPeer = (uri: string): string => {
  let s = (uri || '').trim();
  s = s.replace(/^<|>$/g, '');
  const lt = s.indexOf('<'); if (lt >= 0) { const gt = s.indexOf('>', lt); s = gt > lt ? s.slice(lt + 1, gt) : s.slice(lt + 1); }
  s = s.replace(/^sips?:/i, '');
  const at = s.indexOf('@'); if (at >= 0) s = s.slice(0, at);
  const semi = s.indexOf(';'); if (semi >= 0) s = s.slice(0, semi);
  return s.trim();
};

export type CallHistEntry = {
  id: string;
  epId: string;
  dir: 'in' | 'out';
  remote: string;
  ts: number;            // 통화 시작 시각
  durationSec: number;   // 연결 통화 시간(초)
  result: 'answered' | 'missed' | 'no-answer';
};

export const MAX_ENDPOINTS = 100;
export const DIAL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

// 수신 거절 응답 코드 — MiniSoftphone(PBX/SBC 응답코드 테스트 도구)의 코드 목록 그대로.
export const REJECT_CODES: { code: number; label: string }[] = [
  { code: 403, label: '403 Forbidden' },
  { code: 404, label: '404 Not Found' },
  { code: 408, label: '408 Request Timeout' },
  { code: 480, label: '480 Temporarily Unavailable' },
  { code: 486, label: '486 Busy Here' },
  { code: 487, label: '487 Request Terminated' },
  { code: 488, label: '488 Not Acceptable Here' },
  { code: 500, label: '500 Server Internal Error' },
  { code: 503, label: '503 Service Unavailable' },
  { code: 600, label: '600 Busy Everywhere' },
  { code: 603, label: '603 Decline' },
  { code: 604, label: '604 Does Not Exist Anywhere' },
  { code: 606, label: '606 Not Acceptable' },
];

// DTMF 톤 주파수 — RFC 4733 / ITU-T Q.23 표준
export const DTMF_FREQ: Record<string, [number, number]> = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};
let _audioCtx: AudioContext | null = null;
export function playDtmfTone(key: string) {
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

// 단말/설정 카드 공통 최소 폭 — 둘 중 더 넓은(설정) 기준으로 맞춰 동일 grid 컬럼 폭 사용.
// (원래 300 → 80% 요청으로 240. zoom 으로 시각적으로만 줄이면 Chromium 이 flex 말줄임
// (text-overflow:ellipsis) 계산을 어긋나게 해서 카드마다 줄바꿈 위치가 들쭉날쭉해지는
// 렌더링 버그가 있었다 — zoom 대신 그리드 칸 자체를 진짜로 좁혀서 우회.)
export const CARD_MIN = 240;
export const cardGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN}px, 1fr))`, gap: 12, alignItems: 'start' };

// 등록에 영향 없는 필드(id/label) 제외한 설정 직렬화 — 자동 재등록 트리거 비교용
const REG_CFG_OMIT = new Set(['id', 'label']);
export const cfgKey = (ep: SipEndpoint) => JSON.stringify(Object.entries(ep).filter(([k]) => !REG_CFG_OMIT.has(k)).sort(([a], [b]) => a.localeCompare(b)));

export const api = () => (window as any).api || {};
export const uid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function defaultEndpoint(n: number): SipEndpoint {
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
    mwiSubscribe: true,
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
    mediaFile: '',
    regExpiry: 300,
    dtmfMode: 'rfc2833',
    srtp: 'disabled',
    iceEnabled: false,
    stunServer: '',
    turnServer: '',
    turnUser: '',
    turnPassword: '',
    rtpPortMin: 0,
    rtpPortMax: 0,
    localSipPort: 0,
    userAgent: '',
    contactForced: '',
    divertHeader: '',
    rpidHeader: '',
    paiHeader: '',
    paiPrivacy: '',
    rejectCode: 486,
    rejectTiming: 'immediate',
    rejectDelaySec: 0,
    callerIdPriority: ['rpid', 'from', 'pai'],
    holdViaInfo: false,
    rtpTimeoutSec: 0,
  };
}
