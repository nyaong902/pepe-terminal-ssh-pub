// src/components/SswSoftphoneWorkspace.tsx
// SSW(SK브로드밴드) PBX 전용 소프트폰 워크스페이스 — MicroSipWorkspace.tsx 와는 완전히 별도
// 컴포넌트다(같은 SIP 계정을 등록하면 여전히 같은 전화선을 공유하지만, 서로 다른 계정을 쓰면
// 화면/데이터가 전혀 안 섞인다). 데이터 모델/엔진 연동 타입은 src/utils/sipShared.ts 공용.
// 실제 SIP/RTP/코덱(AMR/AMR-WB/EVS/G.711)은 네이티브 PJSIP 사이드카가 담당하며,
// 여기서는 window.api.sip* IPC 로 제어/상태만 다룬다. 사이드카 미연결 시 status='no-engine'.
import React, { useEffect, useRef, useState } from 'react';
import { notifyConfirm } from './Notify';
import { audioBufferToWav } from '../utils/audioEdit';
import {
  type SipCodec, ALL_CODECS, type SipEndpoint, type RegState, type CallState, type EndpointRuntime,
  type Macro, type Contact, type Conversations, type PresenceMap, normPeer,
  type CallHistEntry, MAX_ENDPOINTS, DIAL_KEYS, REJECT_CODES, playDtmfTone,
  cardGrid, cfgKey, api, sipApi, uid, defaultEndpoint,
} from '../utils/sipShared';

export type SswSoftphoneView = 'phones' | 'settings' | 'macros' | 'contacts' | 'messages' | 'calls' | 'log';

// ── SSW(SK브로드밴드) PBX 부가서비스 스타코드 ──
// 출처: MiniSoftphone(C#/SIPSorcery) MainForm.cs 의 Services 테이블·DialService() 로직 이식.
// 대부분 "*코드[NN]값*"(해제는 "#코드...") 형태의 다이얼 문자열을 일반 통화처럼 거는 것으로
// 동작한다(전화 걸듯이 sipCall) — 유일한 예외는 CTR(호전환)로, 표준 REFER 가 아니라 실단말
// 캡처 기준(보류신호 → 200ms → P-Enbloc-Info 포함 신호) 시퀀스라 전용 sipCtrTransfer 를 쓴다.
type SswService = {
  id: string; label: string; digits: string; hint: string; desc: string;
  hasNN?: boolean; nnMax?: number;         // NN(01~nnMax) 선택 — 기본 없음, 있으면 최대 09
  needsValue?: boolean;                    // 활성화 시 값 필수 여부(검증용, 기본 true)
  isTransfer?: boolean;                    // CTR — sipCtrTransfer 사용, on/off 버튼 없음
  noOffButton?: boolean;                   // 해제 버튼 자체가 없음(다른 서비스 해제로 대체)
  disabledOffButton?: boolean;             // 해제 버튼 표시하되 비활성화
  offDigits?: string;                      // 해제 코드가 다르면 지정(기본 digits 와 동일)
  offNeedsValue?: boolean;                 // 해제 시에도 값 필요 여부(기본 false)
};
const SSW_SERVICES: SswService[] = [
  { id: 'cfu', label: 'CFU 착신전환', digits: '88', hint: 'TDN', desc: '착신전환: *88 + TDN + *  (해제: #88*)' },
  { id: 'cfb', label: 'CFB/CFNA', digits: '84', hint: 'TDN', noOffButton: true, desc: '조건별 착신전환: *84 + TDN + *  (해제는 CFU 착신전환 해제(#88*)로 대체)' },
  { id: 'cfnaTimer', label: 'CFNA Timer', digits: '85', hint: '5~30 (초)', disabledOffButton: true, desc: '무응답 착신전환 타이머: *85 + 값(5~30초) + *  (예: 10 → *8510*)' },
  { id: 'dndOn', label: 'DND 시작', digits: '44', hint: 'mmddhhmm', desc: '착신거부 시작: *44 + mmddhhmm + *' },
  { id: 'dndOff', label: 'DND 종료', digits: '45', hint: 'mmddhhmm', desc: '착신거부 종료(CDND): *45 + mmddhhmm + *' },
  { id: 'absOn', label: 'ABS 시작', digits: '66', hint: 'hhmm (없으면 *66*)', needsValue: false, desc: '부재중 안내 시작: 값 입력 시 *66+hhmm+*, 비우면 *66*' },
  { id: 'absOff', label: 'ABS 종료', digits: '67', hint: 'mmddhhmm (없으면 *67*)', needsValue: false, desc: '부재중 안내 종료(CABS): 값 입력 시 *67+mmddhhmm+*, 비우면 *67*' },
  { id: 'cidb', label: 'CIDB 표시방지', digits: '69', hint: '(없음)', needsValue: false, desc: '발신자 정보표시방지: *69*' },
  { id: 'acr', label: 'ACR 익명거부', digits: '68', hint: '(없음)', needsValue: false, desc: '익명전화수신거부: *68*' },
  { id: 'wkp', label: 'WKP 시간통보', digits: '79', hint: 'hhmm', desc: '지정시간통보: *79 + hhmm + *' },
  { id: 'abd', label: 'ABD 단축다이얼', digits: '99', hint: 'TDN', hasNN: true, desc: '단축다이얼: *99 + NN(01~09) + TDN + *' },
  { id: 'ctr', label: 'CTR 호전환', digits: '20', hint: '전환할 번호', isTransfer: true, desc: '호전환: 통화 중(연결/보류 모두 가능) 클릭 → INFO 2회(P-Enbloc-Info: *20+번호+*)' },
  { id: 'scr', label: 'SCR 호제한', digits: '75', hint: 'TDN', hasNN: true, nnMax: 20, desc: '선택적 호제한: *75 + NN(01~20) + TDN + *' },
  { id: 'scf', label: 'SCF 선택전환', digits: '04', hint: 'TDN2', offNeedsValue: true, desc: '선택적 착신전환: *04 + TDN2 + * (CFU 필요) · 해제: #04 + TDN2 + *' },
];
// 활성화: *digits + nn + value + *   해제: #(offDigits??digits) + nn + (offNeedsValue?value:'') + *
// (MiniSoftphone 실캡처로 트레일링 '*' 필요함을 재확인 — CS_INVALID_NUMBER_FORMAT 의 실제 원인은
// 트레일링 '*'가 아니라 toSipUri() 가 심볼릭 등록 도메인으로 보내던 문제였다. sipd.cpp 쪽에서 수정.)
function buildSswDial(svc: SswService, activate: boolean, value: string, nn: string): string {
  if (activate) return '*' + svc.digits + nn + (value || '') + '*';
  const offCode = svc.offDigits || svc.digits;
  const offVal = svc.offNeedsValue ? (value || '') : '';
  return '#' + offCode + nn + offVal + '*';
}

export const SswSoftphoneWorkspace: React.FC<{
  initialView?: SswSoftphoneView;
  onViewChange?: (view: SswSoftphoneView) => void;
  // 커스텀 워크스페이스 그리드 슬롯에 배치된 경우 true. 일반 탭은 기존 동기화 로직을
  // 그대로 쓰고, embedded 일 때만 에코 차단 가드를 추가한다 — 기존 탭 동작 무변경 보장.
  embedded?: boolean;
}> = ({ initialView = 'phones', onViewChange, embedded = false }) => {
  // 이 워크스페이스는 항상 'ssw' 엔진(별도 sipd.exe 프로세스)으로만 통신한다 — MicroSipWorkspace와 완전히 독립.
  const api = () => sipApi('ssw');
  // 설정/매크로/기록 탭 제거(요청에 따라) — 예전에 저장된 initialView 가 그 값이면(과거 세션의
  // 탭 기억값) 빈 화면이 뜨지 않도록 단말 탭으로 되돌린다.
  const normalizeView = (v: SswSoftphoneView): SswSoftphoneView =>
    (v === 'settings' || v === 'macros' || v === 'log') ? 'phones' : v;
  const [view, setView] = useState<SswSoftphoneView>(normalizeView(initialView));
  const [activity, setActivity] = useState<{ ts: number; epId: string; text: string; kind: string; body?: string }[]>([]);
  const [endpoints, setEndpoints] = useState<SipEndpoint[]>([]);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [runtime, setRuntime] = useState<Record<string, EndpointRuntime>>({});
  const [engineReady, setEngineReady] = useState<boolean | null>(null);
  // 네이티브 데몬(PJMEDIA)이 제공하는 장치 목록 — 단말 카드의 마이크/스피커 선택에 사용
  // (전역 공통 마이크/스피커 선택은 단말별 지정으로 대체되어 제거됨)
  const [sipInputs, setSipInputs] = useState<{ idx: number; name: string }[]>([]);
  const [sipOutputs, setSipOutputs] = useState<{ idx: number; name: string }[]>([]);
  const [callHistory, setCallHistory] = useState<CallHistEntry[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [conversations, setConversations] = useState<Conversations>({});
  const [presence, setPresence] = useState<PresenceMap>({});
  const [ringEnabled, setRingEnabled] = useState(true);
  // 단말별 패킷 캡처(dumpcap.exe) — 로컬 패키지(capture-local-package) 설치 시에만 사용 가능.
  const [captureAvailable, setCaptureAvailable] = useState(false);
  const [captureInterfaces, setCaptureInterfaces] = useState<{ id: string; name: string }[]>([]);
  const [captureIface, setCaptureIface] = useState('');
  const loadedRef = useRef(false);
  const ringCtxRef = useRef<AudioContext | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const autoRegDoneRef = useRef(false);
  // 진행 중 통화 추적(이벤트로 기록 항목 산출) — endpointId → 누적 상태
  const callTrackRef = useRef<Record<string, { dir: 'in' | 'out'; remote: string; sawConnected: boolean; connectedTs: number }>>({});
  // 방금 이 단말에서 실제로 발신에 넘긴 문자열(dial prefix 적용 후) — 부가서비스(스타코드) 시험 시
  // "발신: 입력값 → 실제 URI" 를 MiniSoftphone 처럼 전문 로그에 남기기 위해 기억해둔다.
  const lastDialedTargetRef = useRef<Record<string, string>>({});

  // 뷰(탭)는 부모(initialView) ↔ 내부(view) 양방향 바인딩이다. 커스텀 워크스페이스(embedded) 는
  // 부모(CustomWorkspaceView)가 매 렌더마다 새 onViewChange 함수를 넘기고, 그 값을 다시 props 로
  // 되돌려 받는 이중 바인딩 구조라 에코 타이밍이 겹치면 탭이 계속 튕기는(재전환) 문제가 있었다.
  // embedded 일 때만 마지막으로 동기화한 뷰를 기억해 (1) 외부에서 실제로 바뀐 경우에만 setView,
  // (2) 사용자가 실제로 뷰를 바꿨을 때만 onViewChange 를 호출하도록 에코를 차단한다. 일반 MicroSIP
  // 탭(embedded=false)은 기존과 동일하게 매번 무조건 호출 — 기존 동작 무변경.
  const lastSyncedViewRef = useRef<SswSoftphoneView>(initialView);
  useEffect(() => {
    if (embedded && initialView === lastSyncedViewRef.current) return;
    lastSyncedViewRef.current = initialView;
    setView(normalizeView(initialView));
  }, [initialView]);
  useEffect(() => {
    if (embedded && view === lastSyncedViewRef.current) return;
    lastSyncedViewRef.current = view;
    onViewChange?.(view);
    // onViewChange 는 의도적으로 deps 에서 뺀다 — App.tsx 가 매 렌더마다 새 인라인 함수를 넘기는데
    // 이걸 deps 에 넣으면 "onViewChange 호출 → 부모 재렌더 → 새 onViewChange 참조 → effect 재실행
    // → onViewChange 재호출" 무한 루프(Maximum update depth exceeded)가 된다. view 변경 시에만
    // 반응하면 충분하다(호출 시점엔 항상 최신 onViewChange 클로저를 쓰므로 값 자체는 안 낡는다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // ── 영속(UI prefs) ── — MicroSIP 탭과 SSW 소프트폰 탭은 서로 다른 저장 키를 써서 완전히
  // 별개의 단말/매크로/연락처/통화기록을 갖는다(같은 sip-sidecar 엔진은 계속 공유하지만,
  // 등록 계정 목록 자체는 두 워크스페이스가 서로 안 보이고 안 섞인다).
  const prefsKey = 'sswPhone';
  useEffect(() => {
    (async () => {
      try {
        const prefs = await api().getUIPrefs?.().catch(() => ({}));
        const ms = prefs?.[prefsKey] || {};
        if (Array.isArray(ms.endpoints)) setEndpoints(ms.endpoints);
        if (Array.isArray(ms.macros)) setMacros(ms.macros);
        if (Array.isArray(ms.callHistory)) setCallHistory(ms.callHistory);
        if (Array.isArray(ms.contacts)) setContacts(ms.contacts);
        if (ms.conversations && typeof ms.conversations === 'object') setConversations(ms.conversations);
        if (typeof ms.ringEnabled === 'boolean') setRingEnabled(ms.ringEnabled);
      } catch {}
      loadedRef.current = true;
    })();
  }, []);
  const persist = (patch: Record<string, any>) => {
    try { api().setUIPrefs?.({ [prefsKey]: { endpoints, macros, callHistory, contacts, conversations, ringEnabled, ...patch } }); } catch {}
  };
  useEffect(() => { if (loadedRef.current) persist({ endpoints }); /* eslint-disable-next-line */ }, [endpoints]);
  useEffect(() => { if (loadedRef.current) persist({ macros }); /* eslint-disable-next-line */ }, [macros]);
  useEffect(() => { if (loadedRef.current) persist({ callHistory }); /* eslint-disable-next-line */ }, [callHistory]);
  useEffect(() => { if (loadedRef.current) persist({ contacts }); /* eslint-disable-next-line */ }, [contacts]);
  useEffect(() => { if (loadedRef.current) persist({ conversations }); /* eslint-disable-next-line */ }, [conversations]);

  // ── 패킷 캡처(dumpcap) 가용 여부 + 인터페이스 목록 ──
  useEffect(() => {
    (async () => {
      const available = await api().captureAvailable?.().catch(() => false);
      setCaptureAvailable(!!available);
      if (available) {
        const r = await api().captureListInterfaces?.().catch(() => null);
        if (r?.ok) setCaptureInterfaces(r.interfaces || []);
      }
    })();
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
      // sip-sidecar 는 등록된 모든 단말(양쪽 워크스페이스 통틀어)의 이벤트를 모든 렌더러에
      // 브로드캐스트한다 — 이 워크스페이스 인스턴스(MicroSIP 또는 SSW)가 소유하지 않은
      // endpointId 의 이벤트는 무시해야 서로 화면이 안 섞인다. ready/audio-devices 는 엔진
      // 전체 상태라 endpointId 가 없고, 그대로 통과시킨다.
      if (ev.endpointId && ev.ev !== 'ready' && ev.ev !== 'audio-devices' && !endpointsRef.current.some(e => e.id === ev.endpointId)) return;
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
      if (ev.ev === 'media') {
        if (ev.endpointId) setRuntime(prev => ({ ...prev, [ev.endpointId]: { ...(prev[ev.endpointId] || { reg: 'unregistered', call: 'idle', dialed: '' }), mediaPlaying: !!ev.playing } }));
        if (ev.error) setActivity(prev => [{ ts: Date.now(), epId: ev.endpointId || '', text: `미디어 송출 오류: ${ev.error}`, kind: 'error' }, ...prev].slice(0, 200));
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
      // 발신(calling) 전이는 MiniSoftphone 처럼 "발신: 입력값 → 실제 URI" 형태로 —
      // 부가서비스(스타코드) 시험 시 내가 뭘 눌렀는지와 실제로 어떤 URI 로 나갔는지를 한 줄로 보여준다.
      const txt =
        ev.ev === 'reg' ? `등록: ${ev.reg}${ev.error ? ` (${ev.error})` : ''}` :
        ev.ev === 'call' ? (ev.call === 'calling'
          ? `발신: ${lastDialedTargetRef.current[ev.endpointId] || ''}  →  ${ev.remote || ''}`
          : `통화: ${ev.call}${ev.remote ? ` ${ev.remote}` : ''}${ev.error ? ` (${ev.error})` : ''}`) :
        ev.ev === 'error' ? `오류: ${ev.error || ''}` :
        ev.ev === 'log' ? String(ev.text || '') :
        ev.ev === 'sip' ? `${ev.dir === 'out' ? '↗' : '↙'} ${ev.summary || ''}` : '';
      if (txt) setActivity(prev => [{ ts: Date.now(), epId: ev.endpointId || '', text: txt, kind: ev.ev, body: ev.ev === 'sip' ? String(ev.body || '') : undefined, remote: ev.ev === 'sip' ? String(ev.remote || '') : undefined, remoteName: ev.ev === 'sip' ? String(ev.remoteName || '') : undefined }, ...prev].slice(0, 500));
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

  // ── 호전환(↪) 대상 입력 — window.prompt() 는 이 앱(Electron)에서 동작하지 않아(알림/네이티브
  // 다이얼로그 금지 정책) 인앱 모달로 대체. ──
  const [transferPromptId, setTransferPromptId] = useState<string | null>(null);
  const [transferInput, setTransferInput] = useState('');
  const openTransferPrompt = (id: string) => { setTransferPromptId(id); setTransferInput(''); };
  // 단말 카드 뒤집기 — 설정탭으로 이동하면 콜로그 화면을 벗어나야 해서 불편하다는 피드백으로,
  // 단말 카드 자체에 설정 버튼을 달아 그 카드만 뒤집어 SettingsCard 를 보여준다(콜로그는 그대로 유지).
  const [flippedCards, setFlippedCards] = useState<Record<string, boolean>>({});
  // 단말 카드의 "📡 SSW 부가서비스" 버튼(당겨받기 아래) — 그 카드 안에서 바로 펼쳐진다(팝업/플로팅
  // 아님). 여러 단말을 동시에 비교/조작할 수 있어야 해서 단말 id 집합으로 열림 상태를 관리한다.
  const [sswOpenIds, setSswOpenIds] = useState<Set<string>>(new Set());
  const openSswPanel = (id: string) => setSswOpenIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleCardFlip = (id: string) => setFlippedCards(prev => ({ ...prev, [id]: !prev[id] }));
  // 단말 카드 전체를 한꺼번에 설정면으로 뒤집기/되돌리기 — 하나라도 앞면(통화)이면 "전체 보기"를
  // 눌렀을 때 전부 뒤집고, 전부 뒤집혀 있으면 눌렀을 때 전부 되돌린다.
  // 하나라도 설정면(뒤집힌 카드)이면 버튼이 "전체 통화 카드로"로 바뀌어, 누르면 전부 앞면으로
  // 되돌린다. 전부 통화면(앞면)일 때만 눌러서 전체를 설정면으로 뒤집는다.
  const anyCardFlipped = endpoints.some(e => flippedCards[e.id]);
  const toggleAllCardsFlip = () => setFlippedCards(Object.fromEntries(endpoints.map(e => [e.id, !anyCardFlipped])));
  const confirmTransfer = async () => {
    const id = transferPromptId; const target = transferInput.trim();
    setTransferPromptId(null);
    if (!id || !target) return;
    await api().sipTransfer?.({ endpointId: id, target }).catch(() => {});
  };

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
  // 워크스페이스 탭을 닫아도(컴포넌트 언마운트) sip-sidecar 는 계속 살아있어서, 통화/등록을
  // 그대로 두면 UI 없이 계정이 포트를 물고 백그라운드에 남는다. 이 상태로 다른 워크스페이스
  // (MicroSIP↔SSW 소프트폰)에서 같은 계정 구성으로 다시 등록/발신하면 남아있던 계정이 로컬
  // SIP 포트를 계속 점유하고 있어 새 계정이 트랜스포트를 못 잡아 통화가 안 나간다 — 탭을 닫을
  // 때 통화 중인 단말은 끊고, 등록돼 있던 단말은 모두 등록 해제해 포트/계정을 완전히 반납한다.
  useEffect(() => () => {
    // 창 분리/재도킹으로 이 컴포넌트가 다른 창에서 다시 살아나는 중이면 정리하지 않는다 —
    // 그 경우 통화와 등록은 사이드카에 그대로 살아 있어야 하고, 새 창이 sip:snapshot 으로
    // 상태를 이어받는다(App.tsx 의 detachTabToNewWindow 참고).
    const movingUntil = Number((window as any).__preserveSipUntil || 0);
    if (movingUntil && Date.now() < movingUntil) return;
    for (const ep of endpointsRef.current) {
      const call = runtimeRef.current[ep.id]?.call;
      if (call && call !== 'idle') { try { api().sipHangup?.({ endpointId: ep.id }); } catch {} }
      if (runtimeRef.current[ep.id]?.reg === 'registered') { try { api().sipUnregister?.({ endpointId: ep.id }); } catch {} }
      // 패킷 캡처(dumpcap.exe)도 탭을 닫을 때 같이 정리 — 안 그러면 캡처 중이던 단말의
      // dumpcap 프로세스가 앱 종료 전까지 백그라운드에 남아 계속 CPU/디스크를 쓴다.
      if (runtimeRef.current[ep.id]?.capturing) { try { api().captureStop?.({ endpointId: ep.id }); } catch {} }
    }
  }, []);

  // ── 단말 추가/삭제 ──
  const addEndpoint = () => {
    if (endpoints.length >= MAX_ENDPOINTS) return;
    // SSW(SKB) 전용 워크스페이스 — MiniSoftphone(실단말 캡처 기준) 검증 동작에 맞춘 기본값들:
    // 보류/재개는 SIP INFO 신호, RTP 무응답 60초 자동 종료, 세션 타이머 비활성화(SKB SBC 가 자체
    // re-INVITE 와 충돌해 끊는 문제 회피), MWI SUBSCRIBE 는 끔(MiniSoftphone 은 미구현·미검증),
    // 등록 만료 120초.
    setEndpoints(prev => [...prev, {
      ...defaultEndpoint(prev.length + 1),
      holdViaInfo: true,
      rtpTimeoutSec: 60,
      disableSessionTimer: true,
      mwiSubscribe: false,
      regExpiry: 120,
    }]);
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
  // 단말 전용 마이크/스피커 — 이미 통화 중이면 sipd 가 즉시 그 통화만 재라우팅한다.
  const setAcctAudio = (id: string, audioIn: string, audioOut: string) => {
    updateEndpoint(id, { audioIn, audioOut });
    try { api().sipSetAccountAudioDevices?.({ endpointId: id, input: audioIn, output: audioOut }); } catch {}
  };
  // 단말 전용 마이크/스피커 음량 — 통화 중이면 sipd 가 즉시 그 통화 자신의 오디오에 적용한다.
  const setAcctVolume = (id: string, micLevel: number, spkLevel: number) => {
    updateEndpoint(id, { micLevel, spkLevel });
    try { api().sipSetAccountVolume?.({ endpointId: id, mic: micLevel, speaker: spkLevel }); } catch {}
  };
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
      a.href = url; a.download = 'ssw-softphone-config.json';
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
      // 가져온 단말의 id 를 그대로 쓰면(예: 다른 워크스페이스 — MicroSIP↔SSW — 에서 내보낸 파일을
      // 가져올 때) sip-sidecar 입장에선 같은 id 라 "같은 계정"이 돼버려 두 워크스페이스 화면이
      // 서로 섞인다. 항상 새 id 를 발급하고, 연락처의 발신 단말 참조(epId)도 새 id 로 맞춘다.
      const idMap: Record<string, string> = {};
      const importedEndpoints: SipEndpoint[] = Array.isArray(obj.endpoints)
        ? obj.endpoints.slice(0, MAX_ENDPOINTS).map((e: SipEndpoint) => {
            const newId = uid('ep');
            if (e.id) idMap[e.id] = newId;
            return { ...e, id: newId };
          })
        : [];
      if (importedEndpoints.length) setEndpoints(importedEndpoints);
      if (Array.isArray(obj.macros)) setMacros(obj.macros);
      if (Array.isArray(obj.contacts)) setContacts(obj.contacts.map((c: Contact) => (c.epId && idMap[c.epId]) ? { ...c, epId: idMap[c.epId] } : c));
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
    lastDialedTargetRef.current[id] = target;
    setRt(id, { call: 'calling', remote: target, error: undefined });
    const r = await api().sipCall?.({ endpointId: id, target }).catch((err: any) => ({ ok: false, error: String(err?.message || err) }));
    if (!r?.ok) { setRt(id, { call: 'idle', error: r?.error }); pushToast(`${labelOfEp(id)} 통화 실패 — ${r?.error || 'SIP 엔진 미가용'}`); }
  };
  const hangup = async (id: string) => { await api().sipHangup?.({ endpointId: id }).catch(() => {}); setRt(id, { call: 'idle', muted: false, ctrActive: false }); };
  const answer = async (id: string) => { await api().sipAnswer?.({ endpointId: id }).catch(() => {}); };
  const reject = async (id: string) => { await api().sipReject?.({ endpointId: id }).catch(() => {}); setRt(id, { call: 'idle' }); };
  const toggleMute = async (id: string) => { const m = !rt(id).muted; setRt(id, { muted: m }); await api().sipMute?.({ endpointId: id, mute: m }).catch(() => {}); };
  // 스피커 뮤트 — 마이크 뮤트와 반대 방향(상대 음성 → 내 스피커 전송을 끊음). 상대방은 계속
  // 내 목소리를 들을 수 있고, 나만 상대방 소리가 안 들리게 된다.
  const toggleSpeakerMute = async (id: string) => { const m = !rt(id).speakerMuted; setRt(id, { speakerMuted: m }); await api().sipSpeakerMute?.({ endpointId: id, mute: m }).catch(() => {}); };
  // 보류/재개 — CTR(호전환) 직후엔 이 버튼이 "호전환 복귀"로 표시된다(MiniSoftphone 과 동일:
  // 실제로 보내는 신호는 보류 신호와 완전히 같고, 클릭하면 그 표시 상태만 해제).
  const toggleHold = async (id: string) => {
    const held = rt(id).call !== 'held';
    setRt(id, { call: held ? 'held' : 'connected', ctrActive: false });
    await api().sipHold?.({ endpointId: id, hold: held }).catch(() => {});
  };
  const toggleRecord = async (id: string) => { await api().sipRecord?.({ endpointId: id, on: !rt(id).recording }).catch(() => {}); };
  // 미디어(WAV/MP3) 송출 — 재생 중이면 중단, 아니면 파일 선택 후 송출 시작.
  // pjsua2 AudioMediaPlayer 는 비압축 PCM WAV만 재생 가능 — MP3/M4A/OGG 등은 브라우저 내장
  // Web Audio(decodeAudioData, MP3 등을 네이티브로 디코드)로 풀어서 WAV 로 다시 인코딩한 뒤
  // 임시 파일로 저장해 그 경로를 sipMediaPlay 에 넘긴다. 이미 .wav 면 그대로 사용.
  const convertToWavIfNeeded = async (file: string): Promise<string | null> => {
    if (/\.wav$/i.test(file)) return file;
    try {
      const bytes = await api().sipMediaReadFile?.({ file });
      if (!bytes || (bytes as any)?.error) { pushToast(`오디오 파일 읽기 실패 — ${(bytes as any)?.error || '알 수 없는 오류'}`); return null; }
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new AC();
      const audioBuf = await ctx.decodeAudioData((bytes as ArrayBuffer).slice(0));
      const wavBytes = audioBufferToWav(audioBuf);
      try { ctx.close(); } catch {}
      const w = await api().sipMediaWriteTempWav?.({ data: wavBytes });
      if (!w?.ok || !w.path) { pushToast(`WAV 변환 실패 — ${w?.error || '알 수 없는 오류'}`); return null; }
      return w.path;
    } catch (err: any) {
      pushToast(`오디오 변환 실패(${file.split(/[\\/]/).pop()}) — ${String(err?.message || err)}`);
      return null;
    }
  };
  const toggleMedia = async (id: string) => {
    if (rt(id).mediaPlaying) { await api().sipMediaStop?.({ endpointId: id }).catch(() => {}); return; }
    // 통화 걸기 전에 설정(단말 설정 → 🎵 미디어 송출 파일)해둔 파일이 있으면 그걸 바로 재생 —
    // 통화 중 매번 선택창을 띄우지 않는다. 미지정이면 그때그때 선택.
    const ep = endpointsRef.current.find(e => e.id === id);
    let file = ep?.mediaFile || await api().sipMediaPickFile?.().catch(() => null);
    if (!file) return;
    file = await convertToWavIfNeeded(file);
    if (!file) return;
    const r = await api().sipMediaPlay?.({ endpointId: id, file }).catch((err: any) => ({ ok: false, error: String(err?.message || err) }));
    if (!r?.ok) pushToast(`${labelOfEp(id)} 미디어 송출 실패 — ${r?.error || '알 수 없는 오류'}`);
  };

  // ── 단말별 패킷 캡처 토글(dumpcap.exe) ──
  const toggleCapture = async (id: string) => {
    if (!captureAvailable) { pushToast('패킷 캡처를 사용할 수 없습니다 (capture-local-package 미설치).'); return; }
    if (rt(id).capturing) {
      const r = await api().captureStop?.({ endpointId: id }).catch(() => null);
      setRt(id, { capturing: false });
      if (r?.filePath) pushToast(`캡처 저장됨: ${r.filePath}`);
      return;
    }
    if (!captureIface) { pushToast('설정에서 캡처할 네트워크 인터페이스를 먼저 선택하세요.'); return; }
    const pick = await api().capturePickFolder?.().catch(() => null);
    if (!pick || pick.canceled) return;
    const ep = endpointsRef.current.find(e => e.id === id);
    const r = await api().captureStart?.({ endpointId: id, label: ep?.label || id, iface: captureIface, dir: pick.dir })
      .catch((err: any) => ({ ok: false, error: String(err?.message || err) }));
    if (r?.ok) setRt(id, { capturing: true, captureFile: r.filePath });
    else pushToast(`캡처 시작 실패 — ${r?.error || '알 수 없는 오류'}`);
  };
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
  const sendDtmf = async (id: string, digit: string) => { await api().sipSendDtmf?.({ endpointId: id, digit }).catch(() => {}); };
  // SSW CTR(호전환) — 보류신호→200ms→P-Enbloc-Info 포함 신호 순서를 sipd 가 내부에서 처리.
  const ctrTransfer = async (id: string, digits: string, number: string) => {
    await api().sipCtrTransfer?.({ endpointId: id, digits, number }).catch(() => {});
    // MiniSoftphone: 호전환 실행되면 보류 버튼이 "호전환 복귀"로 바뀐다(_ctrTransferActive).
    setRt(id, { ctrActive: true });
  };
  const pressKey = (id: string, key: string) => {
    const cur = rt(id);
    playDtmfTone(key);
    if (cur.call === 'connected') { void sendDtmf(id, key); }
    else setRt(id, { dialed: (cur.dialed || '') + key });
  };
  const switchViewByDelta = (delta: number) => {
    // 설정/매크로/기록 탭 제거(요청에 따라) — 남은 뷰만 순환.
    const order: Exclude<SswSoftphoneView, 'messages' | 'settings' | 'macros' | 'log'>[] =
      ['phones', 'contacts', 'calls'];
    const idx = order.indexOf((view === 'messages' || view === 'settings' || view === 'macros' || view === 'log' ? 'phones' : view) as Exclude<SswSoftphoneView, 'messages' | 'settings' | 'macros' | 'log'>);
    const next = order[(idx + delta + order.length) % order.length];
    setView(next);
  };

  // 엔진 준비 + 단말 로드 완료 후 1회: 사이드카 현재 상태를 먼저 받아온 뒤, 아직 등록되지 않은
  // autoRegister 단말만 등록한다.
  //
  // 스냅샷을 먼저 받는 이유: 등록과 통화는 사이드카(별도 프로세스)에 살아 있는데 상태는 이
  // 컴포넌트에만 있다. 창 분리/재도킹으로 새 창에서 다시 마운트되면 렌더러는 "아무것도 등록 안 됨"
  // 으로 시작하므로, 그대로 자동 등록을 돌리면 통화 중에 REGISTER 가 나가 통화가 끊겼다
  // (실측: 통화하다 창 분리하면 다 끊김). 아래 "설정 변경 → 재등록" 경로는 통화 중이면 15초 뒤로
  // 미루는 보호가 있었는데, 이 최초 자동 등록 경로에는 없었다 — 통화 중에 실행될 일이 없다고
  // 보았기 때문이다. 창 분리가 바로 그 경우다.
  useEffect(() => {
    if (autoRegDoneRef.current || !loadedRef.current || engineReady !== true || endpoints.length === 0) return;
    autoRegDoneRef.current = true;
    void (async () => {
      let snap: Array<{ endpointId: string; state: any }> = [];
      try { snap = (await api().sipSnapshot?.()) || []; } catch {}
      const live = new Map(snap.map(s => [s.endpointId, s.state || {}]));
      // 살아 있는 상태를 화면에 먼저 반영 — 새 창이 통화 중인 단말을 idle 로 보여주지 않게.
      if (live.size > 0) {
        setRuntime(prev => {
          const next = { ...prev };
          for (const [id, st] of live) {
            next[id] = { ...(next[id] || { reg: 'unregistered', call: 'idle', dialed: '' }), ...st };
          }
          return next;
        });
      }
      endpoints.forEach(e => {
        if (e.autoRegister === false || !e.server.trim() || !e.username.trim()) return;
        const st: any = live.get(e.id);
        if (st && (st.reg === 'registered' || st.reg === 'registering' || isActiveCall(st.call || 'idle'))) {
          // 이미 사이드카에 등록/통화가 살아 있다 — 건드리지 않고 재등록 기준값만 맞춘다.
          lastRegCfgRef.current[e.id] = cfgKey(e);
          return;
        }
        void register(e);
      });
    })();
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
      // 통화/벨울림 중이면 재등록(REGISTER)을 미룬다 — MiniSoftphone(SKB 캡처 기준)도 진행 중인
      // 호 트랜잭션과 겹치지 않도록 15초 뒤로 재시도한다. 우리 엔진(pjsip)의 만료 기반 자동
      // 갱신 타이머까지는 앱에서 가로챌 수 없지만(라이브러리 내부 스케줄), 우리가 직접 트리거하는
      // "설정 변경 → 재등록" 경로는 여기서 안전하게 지연시킬 수 있다.
      const attemptReRegister = (delayMs: number) => {
        reRegTimers.current[ep.id] = setTimeout(() => {
          const cur = endpointsRef.current.find(e => e.id === ep.id);
          const r = runtimeRef.current[ep.id]?.reg;
          if (!cur || (r !== 'registered' && r !== 'registering')) return;
          if (isActiveCall(runtimeRef.current[ep.id]?.call || 'idle')) { attemptReRegister(15000); return; }
          reRegInFlightRef.current.add(ep.id); // 일시 unregistered 가림
          void register(cur);
          // 안전망 — confirm 이벤트가 안 오면 5초 후 강제 해제
          setTimeout(() => reRegInFlightRef.current.delete(ep.id), 5000);
        }, delayMs);
      };
      attemptReRegister(1000);
    });
    /* eslint-disable-next-line */
  }, [endpoints, runtime]);

  return (
    <div
      className="microsip-ws"
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)' }}
      onKeyDownCapture={e => {
        if (!(e.ctrlKey || e.metaKey) || e.key !== 'Tab') return;
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation?.();
        switchViewByDelta(e.shiftKey ? -1 : 1);
      }}
      tabIndex={-1}
    >
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
      {/* 호전환(↪) 대상 입력 모달 — window.prompt() 대체 */}
      {transferPromptId && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setTransferPromptId(null)}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--win-surface, #161b22)', border: '1px solid var(--win-border, #30363d)', borderRadius: 10, padding: 16, width: 300, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <b style={{ fontSize: 13 }}>↪ 호전환</b>
            <span style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>전환할 번호/대상(SIP)을 입력하세요</span>
            <input autoFocus value={transferInput} onChange={e => setTransferInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void confirmTransfer(); else if (e.key === 'Escape') setTransferPromptId(null); }}
              placeholder="예: 1002 또는 sip:1002@example.com"
              style={{ padding: '7px 9px', background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 12 }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setTransferPromptId(null)} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer' }}>취소</button>
              <button onClick={() => void confirmTransfer()} disabled={!transferInput.trim()}
                style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: 'var(--win-accent, #2b6b9b)', color: '#fff', fontWeight: 700, fontSize: 12, cursor: transferInput.trim() ? 'pointer' : 'not-allowed', opacity: transferInput.trim() ? 1 : 0.5 }}>전환</button>
            </div>
          </div>
        </div>
      )}
      <SswHeader
        view={view} setView={setView}
        engineReady={engineReady}
        canAdd={endpoints.length < MAX_ENDPOINTS}
        onAdd={addEndpoint}
        onRegisterAll={registerAll} onUnregisterAll={unregisterAll}
        onHangupAll={hangupAll} onMuteAll={muteAll}
        hasActiveCall={endpoints.some(e => isActiveCall(rt(e.id).call))}
        ringEnabled={ringEnabled} onToggleRing={() => { setRingEnabled(v => { persist({ ringEnabled: !v }); return !v; }); }}
        epCount={endpoints.length}
      />

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {view === 'phones' && (
          // 단말이 많아지면 콜로그가 화면 밖으로 밀려나지 않도록 — 단말 영역(스크롤) + 콜로그(고정) 분리.
          // 프로비저닝 툴바도 같은 이유로 스크롤 영역 밖(고정)에 둔다 — sticky 로 스크롤 영역
          // 안쪽에 두면 카드 내용이 겹쳐 보이는 렌더링 문제가 있었다.
          <>
            <div style={{ flex: '0 0 auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px 0 12px' }}>
              <span style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>프로비저닝:</span>
              <button onClick={exportConfig} disabled={endpoints.length === 0} title="단말/매크로/주소록을 JSON 으로 내보내기" style={miniBtn(endpoints.length > 0)}>⬆ 내보내기</button>
              <button onClick={() => importInputRef.current?.click()} title="JSON 설정 가져오기(덮어쓰기)" style={miniBtn(true)}>⬇ 가져오기</button>
              <input ref={importInputRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
                onChange={e => { void importConfig(e.target.files?.[0]); e.target.value = ''; }} />
              <span style={{ fontSize: 10, color: 'var(--win-text-dim, #6e7681)' }}>※ 비밀번호 평문 포함 — 취급 주의</span>
              {endpoints.length > 0 && (
                <button onClick={toggleAllCardsFlip} title="모든 단말 카드를 한꺼번에 설정면으로 뒤집기/되돌리기" style={{ ...miniBtn(true), marginLeft: 'auto' }}>
                  {anyCardFlipped ? '◀ 전체 통화 카드로' : '⚙ 전체 설정 보기'}
                </button>
              )}
            </div>
            {endpoints.length === 0 && (
              <div style={{ color: 'var(--win-text-dim, #9aa7b3)', padding: 24, textAlign: 'center' }}>
                단말이 없습니다. 우측 상단 <b>+ 단말</b> 으로 추가하세요 (최대 {MAX_ENDPOINTS}대).
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
              <div style={cardGrid}>
                {endpoints.map((e, idx) => (
                  <FlippableCard key={e.id} flipped={!!flippedCards[e.id]}
                    front={
                      <PhoneCard ep={e} rt={rt(e.id)}
                        onKey={(k) => pressKey(e.id, k)}
                        onBackspace={() => setRt(e.id, { dialed: (rt(e.id).dialed || '').slice(0, -1) })}
                        onCall={() => makeCall(e.id, rt(e.id).dialed)}
                        onHangup={() => hangup(e.id)}
                        onClear={() => setRt(e.id, { dialed: '' })}
                        onAnswer={() => answer(e.id)}
                        onReject={() => reject(e.id)}
                        onToggleMute={() => toggleMute(e.id)}
                        onToggleSpeakerMute={() => toggleSpeakerMute(e.id)}
                        onToggleHold={() => toggleHold(e.id)}
                        onTransfer={() => openTransferPrompt(e.id)}
                        onToggleRecord={() => toggleRecord(e.id)}
                        onToggleMedia={() => toggleMedia(e.id)}
                        onVoicemail={() => e.voicemailNumber && makeCall(e.id, e.voicemailNumber)}
                        onPickup={() => makeCall(e.id, '*30*')}
                        onRegister={() => register(e)}
                        onUnregister={() => unregister(e.id)}
                        onSetDialed={(s) => setRt(e.id, { dialed: s })}
                        onToggleCapture={() => toggleCapture(e.id)}
                        captureAvailable={captureAvailable}
                        onOpenSettings={() => toggleCardFlip(e.id)}
                        sswOpen={sswOpenIds.has(e.id)} onToggleSswServices={() => openSswPanel(e.id)}
                        onSswDial={(number) => makeCall(e.id, number)}
                        onSswCtrTransfer={(digits, number) => ctrTransfer(e.id, digits, number)}
                        sipInputs={sipInputs} sipOutputs={sipOutputs}
                        onAudioChange={(i, o) => setAcctAudio(e.id, i, o)}
                        onVolumeChange={(mic, spk) => setAcctVolume(e.id, mic, spk)}
                      />
                    }
                    back={
                      <SettingsCard ep={e} all={endpoints} reg={rt(e.id).reg} callState={rt(e.id).call}
                        idx={idx} total={endpoints.length}
                        onChange={(p) => updateEndpoint(e.id, p)}
                        onCopyFrom={(srcId) => copyFrom(e.id, srcId)}
                        onDnd={(on) => setDnd(e.id, on)}
                        onMove={(dir) => moveEndpoint(e.id, dir)}
                        onRegister={() => register(e)}
                        onUnregister={() => unregister(e.id)}
                        onRemove={() => removeEndpoint(e.id)}
                        onSave={(draft) => saveEndpointDraft(e.id, draft)}
                        onDial={(number) => makeCall(e.id, number)}
                        onCtrTransfer={(digits, number) => ctrTransfer(e.id, digits, number)}
                        capturing={!!rt(e.id).capturing}
                        captureAvailable={captureAvailable}
                        onToggleCapture={() => toggleCapture(e.id)}
                        captureInterfaces={captureInterfaces}
                        captureIface={captureIface}
                        onCaptureIfaceChange={setCaptureIface}
                        onBack={() => toggleCardFlip(e.id)}
                      />
                    }
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

        {view === 'contacts' && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <ContactsView contacts={contacts} setContacts={setContacts} endpoints={endpoints} onDial={redial}
              presence={presence} onSubscribe={toggleSubscribe} />
          </div>
        )}

        {view === 'calls' && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <CallLogView history={callHistory} setHistory={setCallHistory} endpoints={endpoints}
              contacts={contacts} onDial={redial} />
          </div>
        )}

        {view === 'messages' && (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
            <MessagesView conversations={conversations} endpoints={endpoints} presence={presence}
              onSend={sendIm} onClear={(key) => setConversations(prev => { const n = { ...prev }; delete n[key]; return n; })} />
          </div>
        )}

      </div>
    </div>
  );
};

// ───────────────────────── 헤더 ─────────────────────────
const SswHeader: React.FC<{
  view: SswSoftphoneView; setView: (v: any) => void;
  engineReady: boolean | null; canAdd: boolean; onAdd: () => void; epCount: number;
  onRegisterAll: () => void; onUnregisterAll: () => void;
  onHangupAll: () => void; onMuteAll: () => void; hasActiveCall: boolean;
  ringEnabled: boolean; onToggleRing: () => void;
}> = (p) => {
  const tab = (id: SswSoftphoneView, label: string) => (
    <button onClick={() => p.setView(id)}
      style={{ padding: '6px 12px', borderRadius: '8px 8px 0 0', border: '1px solid var(--win-border, #30363d)', borderBottom: 'none',
        background: p.view === id ? 'var(--win-surface, #161b22)' : 'transparent', color: p.view === id ? 'var(--win-text, #fff)' : 'var(--win-text-dim, #9aa7b3)',
        fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>{label}</button>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px 0', borderBottom: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface, #161b22)', flexWrap: 'wrap' }}>
      {tab('phones', '☎ 단말')}
      {tab('contacts', '👤 주소록')}
      {tab('calls', '🕒 통화기록')}
      {/* 메시지 탭 숨김 (요청에 따라 비표시) — {tab('messages', '💬 메시지')} */}
      {/* 설정/매크로/기록 탭 제거 (요청에 따라) — 설정은 단말 카드 ⚙ 버튼으로 뒤집어서 접근 */}
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
      <button onClick={p.onAdd} disabled={!p.canAdd} title={p.canAdd ? '단말 추가' : `최대 ${MAX_ENDPOINTS}대`}
        style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--win-accent, #2b6b9b)', background: 'var(--win-accent, #2b6b9b)', color: '#fff', fontWeight: 700, cursor: p.canAdd ? 'pointer' : 'not-allowed', opacity: p.canAdd ? 1 : 0.5 }}>
        + 단말 ({p.epCount}/{MAX_ENDPOINTS})
      </button>
    </div>
  );
};
const miniBtn = (enabled: boolean): React.CSSProperties => ({ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text, #e6edf3)', fontSize: 11, fontWeight: 600, cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5 });

// ───────────────────────── 통화기록 ─────────────────────────
// MicroSIP 의 Logs 탭과 같은 구성: 방향 아이콘 + 이름 / 번호 / 시간.
// 기록 자체는 예전부터 call 상태 전이에서 모아 저장하고 있었는데(callHistory) 보여주는 화면이
// 없었다 — 이 뷰가 그것을 표시한다.
//
// 열 제목과 행의 칸 폭이 어긋나지 않게 grid 템플릿을 공유한다(주소록과 같은 방식).
const callLogGrid = '22px minmax(0,1.4fr) minmax(0,1.2fr) minmax(0,1.1fr) 30px';

// 오늘이면 시각만, 그 외에는 날짜+시각 — MicroSIP 도 같은 방식이라 목록이 훨씬 읽기 쉽다.
const fmtCallTs = (ts: number): string => {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${ymd} ${d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
};
const fmtDur = (sec: number): string => {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
};

const CallLogView: React.FC<{
  history: CallHistEntry[];
  setHistory: React.Dispatch<React.SetStateAction<CallHistEntry[]>>;
  endpoints: SipEndpoint[];
  contacts: Contact[];
  onDial: (epId: string, number: string) => void;
}> = ({ history, setHistory, endpoints, contacts, onDial }) => {
  const [q, setQ] = useState('');
  const [onlyMissed, setOnlyMissed] = useState(false);
  // 이름은 주소록에서 번호로 찾아 붙인다 — 없으면 번호를 그대로 이름 칸에 보여준다(MicroSIP 동일).
  const nameOf = (remote: string): string => {
    const peer = normPeer(remote);
    const hit = contacts.find(c => c.number && normPeer(c.number) === peer);
    return (hit?.name || '').trim() || remote || '알수없음';
  };
  const labelOf = (epId: string): string => endpoints.find(e => e.id === epId)?.label || '';
  const rows = history.filter(h => {
    if (onlyMissed && h.result === 'answered') return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return `${h.remote} ${nameOf(h.remote)}`.toLowerCase().includes(needle);
  });
  const th: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--win-text-dim, #9aa7b3)', padding: '0 6px' };
  const td: React.CSSProperties = { fontSize: 12, color: 'var(--win-text, #e6edf3)', padding: '0 6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: 12, gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="이름 · 번호 검색"
          style={{ flex: '0 0 220px', padding: '6px 8px', background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 12 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyMissed} onChange={e => setOnlyMissed(e.target.checked)} />
          부재중만
        </label>
        <span style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>{rows.length}건</span>
        <button onClick={() => { if (history.length) setHistory([]); }} disabled={history.length === 0}
          title="통화기록 전체 삭제"
          style={{ marginLeft: 'auto', ...miniBtn(history.length > 0) }}>전체 삭제</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: callLogGrid, alignItems: 'center', gap: 4, padding: '0 2px 4px', borderBottom: '1px solid var(--win-border, #30363d)' }}>
        <span />
        <span style={th}>이름</span>
        <span style={th}>번호</span>
        <span style={th}>시간</span>
        <span />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {rows.length === 0 && (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)' }}>
            {history.length === 0 ? '통화기록이 없습니다.' : '조건에 맞는 기록이 없습니다.'}
          </div>
        )}
        {rows.map(h => {
          const missed = h.result !== 'answered';
          // 수신 응답=초록, 발신 응답=파랑, 부재중/무응답=빨강 (MicroSIP 의 색 구분과 같은 의미)
          const color = missed ? '#f85149' : h.dir === 'in' ? '#3fb950' : '#58a6ff';
          const epGone = !endpoints.some(e => e.id === h.epId);
          const dur = fmtDur(h.durationSec);
          return (
            <div key={h.id}
              onDoubleClick={() => { if (!epGone) onDial(h.epId, h.remote); }}
              title={epGone
                ? '이 기록을 만든 단말이 삭제되어 다시 걸 수 없습니다'
                : `두 번 클릭하면 ${h.remote} 로 발신${labelOf(h.epId) ? ` (${labelOf(h.epId)})` : ''}`}
              style={{ display: 'grid', gridTemplateColumns: callLogGrid, alignItems: 'center', gap: 4,
                padding: '5px 2px', borderBottom: '1px solid var(--win-border-weak, #21262d)',
                cursor: epGone ? 'default' : 'pointer', opacity: epGone ? 0.55 : 1 }}>
              <span style={{ color, fontWeight: 700, fontSize: 13, textAlign: 'center' }}>
                {h.dir === 'in' ? '↙' : '↗'}
              </span>
              <span style={{ ...td, color }}>{nameOf(h.remote)}</span>
              <span style={td}>{h.remote}</span>
              <span style={{ ...td, color: 'var(--win-text-dim, #9aa7b3)' }}>
                {fmtCallTs(h.ts)}{dur ? `  ${dur}` : ''}
              </span>
              <button onClick={e => { e.stopPropagation(); setHistory(prev => prev.filter(x => x.id !== h.id)); }}
                title="이 기록 삭제"
                style={{ border: 'none', background: 'transparent', color: 'var(--win-text-dim, #9aa7b3)', cursor: 'pointer', fontSize: 12 }}>✕</button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ───────────────────────── 주소록 ─────────────────────────
const presColor: Record<string, string> = { online: '#3fb950', offline: '#8b949e', unknown: '#d29922' };
// 주소록 열 제목과 실제 행의 칸 폭을 완전히 동일하게 맞추기 위한 공유 grid 템플릿.
// (프레즌스 점 / 이름 / 번호 / 발신 단말 / 구독 버튼 / 통화 버튼 / 삭제 버튼)
const CONTACT_ROW_COLS = '9px 1fr 1fr 120px 32px 32px 32px';
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
    // 제목/추가 버튼/열 제목은 스크롤과 무관하게 고정 — 리스트 부분만 내부에서 따로 스크롤한다.
    // maxWidth 는 바깥(스크롤 컨테이너)이 아니라 안쪽 콘텐츠에만 걸어야 스크롤바가 패널의
    // 진짜 오른쪽 끝에 붙는다 — 바깥에 걸면 컨테이너 자체가 좁아져 스크롤바가 중간에 생긴다.
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 0 12px', maxWidth: 760 }}>
        <b style={{ fontSize: 13 }}>👤 주소록</b>
        <span style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>{contacts.length}건</span>
        <button onClick={add} style={{ ...inp, cursor: 'pointer', background: 'var(--win-accent, #2b6b9b)', color: '#fff', border: 'none', fontWeight: 700, marginLeft: 'auto' }}>+ 연락처 추가</button>
      </div>
      {contacts.length > 0 && (
        // 입력값이 채워지면 placeholder 가 사라져 이름/번호/발신 단말 칸이 서로 구분 안 가는
        // 문제가 있었다 — 목록 위에 열 제목을 붙이되, flex 는 아래 행(버튼 개수가 다름)과 항목
        // 수가 달라 칸이 안 맞았다. grid 로 바꿔 행과 완전히 같은 열 폭을 공유해 정렬한다.
        <div style={{ flex: '0 0 auto', display: 'grid', gridTemplateColumns: CONTACT_ROW_COLS, gap: 6, padding: '10px 12px 0 12px', fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', maxWidth: 760 }}>
          <span />
          <span>이름</span>
          <span>번호/SIP (수신 대상)</span>
          <span>발신 단말</span>
          <span />
          <span />
          <span />
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: 12 }}>
        {contacts.length === 0 && (
          <div style={{ color: 'var(--win-text-dim, #9aa7b3)', padding: 16, textAlign: 'center', fontSize: 12, maxWidth: 760 }}>연락처가 없습니다. <b>+ 연락처 추가</b> 로 등록하세요.</div>
        )}
        {contacts.map(c => {
          const ep = dialEp(c);
          const pres = presOf(ep, c.number);
          return (
            <div key={c.id} style={{ display: 'grid', gridTemplateColumns: CONTACT_ROW_COLS, alignItems: 'center', gap: 6, padding: 8, borderRadius: 8, background: 'var(--win-surface, #161b22)', border: '1px solid var(--win-border, #30363d)', maxWidth: 760 }}>
              <span title={pres ? `프레즌스: ${pres}` : '프레즌스 미구독'} style={{ width: 9, height: 9, borderRadius: 999, background: pres ? presColor[pres] || '#8b949e' : 'transparent', border: pres ? 'none' : '1px solid var(--win-border, #30363d)' }} />
              <input value={c.name} onChange={e => update(c.id, { name: e.target.value })} placeholder="이름" style={{ ...inp, width: '100%', minWidth: 0 }} />
              <input value={c.number} onChange={e => update(c.id, { number: e.target.value })} placeholder="번호/SIP" style={{ ...inp, width: '100%', minWidth: 0, fontFamily: 'Consolas, monospace' }} />
              <select value={c.epId || ''} onChange={e => update(c.id, { epId: e.target.value || undefined })} title="발신 단말" style={{ ...inp, width: '100%', minWidth: 0 }}>
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

// 활동 로그 색상 — 전화 탭 콜로그 패널에서 공통 사용
const logKindColor: Record<string, string> = { reg: '#58a6ff', call: '#3fb950', error: '#f85149', log: '#8b949e', im: '#a371f7', sip: '#d29922' };

// 활동 로그를 MiniSoftphone 식 전문(raw transcript) 텍스트로 변환 — "전문" 뷰 표시 및 저장에 공용.
function formatActivityLog(
  activity: { ts: number; epId: string; text: string; kind: string; body?: string; remote?: string; remoteName?: string }[],
  labelOf: (id: string) => string,
): string {
  const chron = [...activity].reverse(); // activity 는 최신이 앞(index 0) — 시간순으로 뒤집는다.
  const lines: string[] = [];
  for (const a of chron) {
    const t = new Date(a.ts);
    const ts = `[${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}.${String(t.getMilliseconds()).padStart(3, '0')}]`;
    if (a.kind === 'sip') {
      const isOut = a.text.startsWith('↗');
      const msg = a.text.replace(/^[↗↙]\s*/, '');
      const isResp = /^SIP\/2\.0/.test(msg);
      const remote = a.remote || a.remoteName || '?';
      lines.push(`${ts} ${isOut ? '▶▶ 송신' : '◀◀ 수신'} ${isResp ? 'RESPONSE' : 'REQUEST '}  ${labelOf(a.epId)} ${isOut ? '→' : '←'} ${remote}`);
      if (a.body) lines.push(a.body);
      lines.push('');
      lines.push('─'.repeat(60));
    } else {
      lines.push(`${ts} [${labelOf(a.epId)}] ${a.text}`);
    }
  }
  return lines.join('\n');
}

// ───────────────────────── 폴드 가능 콜로그(전화 탭 하단) ─────────────────────────
// sessionStorage 에 펼침 여부 저장 — 새로 시작할 때마다 fold 기본.
const CALL_LOG_FOLD_KEY = 'pepe-microsip-callog-open';
const CallLogPanel: React.FC<{
  activity: { ts: number; epId: string; text: string; kind: string; body?: string; remote?: string; remoteName?: string }[];
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
  // 패널 높이 — 드래그로 조절. sessionStorage 보관.
  const [panelHeight, setPanelHeight] = useState<number>(() => {
    try { const v = parseInt(sessionStorage.getItem('pepe-microsip-callog-h') || '', 10); return isFinite(v) && v >= 120 ? v : 280; } catch { return 280; }
  });
  const setOpenPersist = (n: boolean) => { setOpen(n); try { sessionStorage.setItem(CALL_LOG_FOLD_KEY, n ? '1' : '0'); } catch {} };
  // 헤더 클릭 — 3단계 순환: 최대화(메시지 클릭으로 80vh 확장된 상태) → 절반(40vh) → 닫힘(초기
  // 상태, 시퀀스/로그가 아예 안 보임) → 다시 절반(40vh) → ...  드래그로 임의 높이로 바꿔둔
  // 경우엔 "최대화 근처"가 아니면 절반이 아니라 그냥 닫힘으로 취급한다.
  const HALF_PANEL_H = () => Math.round(window.innerHeight * 0.4);
  const toggle = () => {
    const maxH = MAX_PANEL_H();
    if (open && panelHeight >= maxH - 20) {
      setPanelHeight(HALF_PANEL_H());
    } else if (open) {
      setOpenPersist(false);
    } else {
      setPanelHeight(HALF_PANEL_H());
      setOpenPersist(true);
    }
  };
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
  const [viewMode, setViewMode] = useState<'list' | 'seq' | 'raw'>(() => {
    try { return (sessionStorage.getItem('pepe-microsip-callog-mode') as any) || 'list'; } catch { return 'list'; }
  });
  const setMode = (m: 'list' | 'seq' | 'raw') => { setViewMode(m); try { sessionStorage.setItem('pepe-microsip-callog-mode', m); } catch {} };
  // 시퀀스/전문 뷰 — 새 메시지 도착 시 자동으로 그쪽(맨 아래)으로 스크롤. 사용자가 과거 기록을
  // 보려고 위로 스크롤해둔 상태면 방해하지 않도록, 이미 맨 아래 근처에 있을 때만 따라간다.
  const seqScrollRef = useRef<HTMLDivElement | null>(null);
  const rawScrollRef = useRef<HTMLDivElement | null>(null);
  // 시퀀스 뷰의 각 메시지 행 DOM — 클릭 시 그 행을 스크롤 맨 위로 올려서(펼친 내용이 잘리지
  // 않게) 보여주는 데 쓴다.
  const seqRowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // 콜로그 패널 자체(카드 목록 위에 놓인 고정 높이 박스) 루트.
  const panelRootRef = useRef<HTMLDivElement | null>(null);
  // 메시지 클릭 시 스크롤로 옮기는 대신, 패널 자체를 화면에서 쓸 수 있는 만큼 꽉 채워서(드래그
  // 리사이즈 핸들과 같은 상한 — 80vh) 펼친 내용을 넉넉하게 볼 수 있게 한다.
  const MAX_PANEL_H = () => Math.round(window.innerHeight * 0.8);
  const scrollSeqRowToTop = (i: number) => {
    setPanelHeight(h => Math.max(h, MAX_PANEL_H()));
    requestAnimationFrame(() => {
      const el = seqRowRefs.current.get(i);
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  };
  const seqAtBottomRef = useRef(true);
  const rawAtBottomRef = useRef(true);
  const NEAR_BOTTOM_PX = 60;
  const onSeqScroll = () => {
    const el = seqScrollRef.current; if (!el) return;
    seqAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };
  const onRawScroll = () => {
    const el = rawScrollRef.current; if (!el) return;
    rawAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };
  // 일시정지 — 켜지는 순간의 activity 를 얼려서 그 이후 새 이벤트는 화면에 반영하지 않는다
  // (실제 통화/등록 처리 자체는 계속 정상 진행 — 로그 "표시"만 멈춘다. MiniSoftphone 의 로그
  // 패널 일시정지와 동일한 개념).
  const [paused, setPaused] = useState(false);
  const frozenRef = useRef<typeof activity | null>(null);
  if (paused && !frozenRef.current) frozenRef.current = activity;
  if (!paused) frozenRef.current = null;
  const liveActivity = (paused && frozenRef.current) ? frozenRef.current : activity;
  const saveLog = async () => {
    try {
      const text = formatActivityLog(liveActivity, labelOf);
      const data = new TextEncoder().encode(text).buffer;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await api().officeDocSaveFile?.({ data, defaultName: `ssw-sip-log-${stamp}.log`, filters: [{ name: 'Log', extensions: ['log', 'txt'] }] });
    } catch {}
  };
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
  const recent = liveActivity.filter(a => showSip || a.kind !== 'sip').slice(0, 30);
  // 시퀀스 뷰는 sip 메시지만, 오래된 순 (위→아래로 시간 흐름)
  const sipSeq = liveActivity.filter(a => a.kind === 'sip').slice(0, 60).reverse();
  const errorCount = liveActivity.filter(a => a.kind === 'error').length;
  // 전문(raw) 뷰 — MiniSoftphone 식 텍스트 트랜스크립트. 최근 200건만(과도한 렌더링 방지).
  const rawText = viewMode === 'raw' ? formatActivityLog(liveActivity.slice(0, 200), labelOf) : '';
  useEffect(() => {
    if (viewMode !== 'seq' || !seqAtBottomRef.current) return;
    const el = seqScrollRef.current; if (el) el.scrollTop = el.scrollHeight;
  }, [sipSeq.length, viewMode]);
  useEffect(() => {
    if (viewMode !== 'raw' || !rawAtBottomRef.current) return;
    const el = rawScrollRef.current; if (el) el.scrollTop = el.scrollHeight;
  }, [rawText, viewMode]);
  // 뷰 전환 시(목록→시퀀스/전문) 처음엔 항상 맨 아래(최신)부터 보이게.
  useEffect(() => {
    if (viewMode === 'seq') { seqAtBottomRef.current = true; const el = seqScrollRef.current; if (el) el.scrollTop = el.scrollHeight; }
    if (viewMode === 'raw') { rawAtBottomRef.current = true; const el = rawScrollRef.current; if (el) el.scrollTop = el.scrollHeight; }
  }, [viewMode]);
  return (
    <div ref={panelRootRef} style={{
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
            <button onClick={() => setMode('raw')}
              title="MiniSoftphone 식 전문(raw) 로그"
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, border: '1px solid var(--win-border, #30363d)', cursor: 'pointer', background: viewMode === 'raw' ? 'var(--win-accent, #2b6b9b)' : 'transparent', color: '#fff' }}>
              🗒 전문
            </button>
            {viewMode === 'list' && (
              <button onClick={toggleSip}
                title={showSip ? 'SIP 상세 메시지 숨김' : 'SIP 상세 메시지 표시'}
                style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, border: '1px solid var(--win-border, #30363d)', cursor: 'pointer', background: showSip ? 'rgba(210,153,34,0.3)' : 'transparent', color: showSip ? '#fff' : 'var(--win-text-dim, #9aa7b3)' }}>
                {showSip ? '🟡 SIP 상세' : '⚪ SIP 상세'}
              </button>
            )}
            <button onClick={() => setPaused(v => !v)}
              title={paused ? '재개 — 새 이벤트 다시 표시' : '일시정지 — 화면 표시만 멈춤(실제 처리는 계속됨)'}
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, border: '1px solid var(--win-border, #30363d)', cursor: 'pointer', background: paused ? 'rgba(248,81,73,0.25)' : 'transparent', color: paused ? '#f85149' : 'var(--win-text-dim, #9aa7b3)' }}>
              {paused ? '▶ 재개' : '⏸ 일시정지'}
            </button>
            <button onClick={saveLog} disabled={liveActivity.length === 0}
              title="현재 로그를 텍스트 파일로 저장"
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, border: '1px solid var(--win-border, #30363d)', background: 'transparent', color: 'var(--win-text-dim, #9aa7b3)', cursor: liveActivity.length > 0 ? 'pointer' : 'not-allowed', opacity: liveActivity.length > 0 ? 1 : 0.4 }}>
              💾 저장
            </button>
            <button onClick={onClear} disabled={activity.length === 0}
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, border: '1px solid var(--win-border, #30363d)', background: 'transparent', color: 'var(--win-text-dim, #9aa7b3)', cursor: activity.length > 0 ? 'pointer' : 'not-allowed', opacity: activity.length > 0 ? 1 : 0.4 }}>
              지우기
            </button>
          </span>
        )}
      </div>
      {open && viewMode === 'seq' && (() => {
        // 통화 관련 메시지(INVITE/ACK/BYE/CANCEL/PRACK/UPDATE/REFER/INFO + 그에 대한 응답)에
        // 등장한 endpoint 만 lifeline 컬럼으로. REGISTER/SUBSCRIBE/NOTIFY 만 있는 단말은 숨김.
        // 통화 응답(SIP/2.0 NNN) 은 그 직전 다이얼로그의 epId 와 같아 자연스럽게 포함됨.
        const isCallMethod = (s: string) => /^(INVITE|ACK|BYE|CANCEL|PRACK|UPDATE|REFER|INFO)\b/.test(s.replace(/^[↗↙]\s*/, ''));
        const callEpIds = new Set<string>();
        for (const a of sipSeq) {
          if (a.epId && isCallMethod(a.text)) callEpIds.add(a.epId);
        }
        // 통화 응답(SIP/2.0 200 OK 등) 도 같이 포함 — 같은 다이얼로그라 같은 epId.
        // 통화 메시지가 하나라도 있는 단말 = 활성 통화 참여 단말.
        let usedEps = endpoints.filter(e => callEpIds.has(e.id));
        // 통화 메시지가 전혀 없으면(등록만 있는 케이스) 기존 동작으로 fallback.
        if (usedEps.length === 0) usedEps = endpoints.filter(e => sipSeq.some(a => a.epId === e.id));
        if (usedEps.length === 0) usedEps = endpoints.slice(0, 1);
        // sipSeq 도 표시 대상으로 필터 — 컬럼에 없는 단말의 REGISTER 등은 시퀀스에서 숨김.
        const visibleSeq = callEpIds.size > 0
          ? sipSeq.filter(a => usedEps.some(e => e.id === a.epId))
          : sipSeq;
        // 원격 컬럼 — 각 메시지의 remote(IP) 별로 분리. remoteName(호스트명) 도 함께 저장.
        const usedRemotes: { ip: string; name: string }[] = [];
        for (const a of visibleSeq) {
          const ip = a.remote || '';
          const name = a.remoteName || '';
          if (!usedRemotes.some(r => r.ip === ip)) usedRemotes.push({ ip, name });
        }
        if (usedRemotes.length === 0) usedRemotes.push({ ip: '', name: '' });
        const colCount = usedEps.length + usedRemotes.length;
        const headerW = 70;
        return (
          <div ref={seqScrollRef} onScroll={onSeqScroll} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 0, display: 'flex', flexDirection: 'column' }}>
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
                {usedRemotes.map((r, i) => {
                  const label = r.ip && r.name ? `${r.ip} (${r.name})` : (r.ip || r.name || '원격');
                  return (
                    <div key={`rem-${i}`} style={{ flex: 1, textAlign: 'center', padding: '0 4px', overflow: 'hidden' }}>
                      <b style={{ fontSize: 11, color: '#3fb950', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block', maxWidth: '100%' }} title={label}>🌐 {label}</b>
                    </div>
                  );
                })}
              </div>
            </div>
            {visibleSeq.length === 0 && (
              <div style={{ color: 'var(--win-text-dim, #9aa7b3)', padding: 20, textAlign: 'center', fontSize: 11 }}>
                SIP 메시지가 아직 없습니다. 등록/통화 시도 시 REGISTER · INVITE · 200 OK 등이 여기 시퀀스로 표시됩니다.
              </div>
            )}
            {visibleSeq.map((a, i) => {
              const isOut = a.text.startsWith('↗');
              const msg = a.text.replace(/^[↗↙]\s*/, '');
              const isOpen = expanded.has(i + 10000);
              const arrowColor = isOut ? '#58a6ff' : '#3fb950';
              // 어떤 단말 컬럼에 속하는지 — endpointId 매칭. 없으면 첫 컬럼.
              let epIdx = usedEps.findIndex(e => e.id === a.epId);
              if (epIdx < 0) epIdx = 0;
              // 어떤 원격 컬럼에 속하는지 — remote IP 매칭. 없으면 첫 원격 컬럼.
              let remoteIdx = usedRemotes.findIndex(r => r.ip === (a.remote || ''));
              if (remoteIdx < 0) remoteIdx = 0;
              remoteIdx = usedEps.length + remoteIdx; // offset by endpoint columns
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
                <div key={`s${a.ts}-${i}`}
                  ref={el => { if (el) seqRowRefs.current.set(i, el); else seqRowRefs.current.delete(i); }}
                  style={{ flexShrink: 0, borderBottom: '1px dashed rgba(255,255,255,0.06)' }}>
                  <div onClick={() => { if (a.body) toggleExpand(i + 10000); scrollSeqRowToTop(i); }}
                    style={{
                      display: 'flex', alignItems: 'center', padding: '4px 8px', gap: 8,
                      cursor: 'pointer',
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
                          background: idx >= usedEps.length ? 'rgba(63,185,80,0.4)' : 'rgba(88,166,255,0.4)',
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
      {open && viewMode === 'raw' && (
        <div ref={rawScrollRef} onScroll={onRawScroll} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8 }}>
          {rawText ? (
            <pre style={{
              margin: 0, color: '#c9d1d9', fontFamily: 'Consolas, monospace', fontSize: 10, lineHeight: 1.5,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>{rawText}</pre>
          ) : (
            <div style={{ color: 'var(--win-text-dim, #9aa7b3)', padding: 12, textAlign: 'center', fontSize: 11 }}>
              아직 기록이 없습니다.
            </div>
          )}
        </div>
      )}
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
  onAnswer: () => void; onReject: () => void; onToggleMute: () => void; onToggleSpeakerMute: () => void; onToggleHold: () => void; onTransfer: () => void; onToggleRecord: () => void; onToggleMedia: () => void; onVoicemail: () => void; onPickup: () => void;
  onRegister: () => void; onUnregister: () => void;
  onSetDialed: (s: string) => void;
  onToggleCapture: () => void; captureAvailable: boolean;
  onOpenSettings: () => void;
  sswOpen: boolean; onToggleSswServices: () => void;
  onSswDial: (number: string) => void; onSswCtrTransfer: (digits: string, number: string) => void;
  sipInputs: { idx: number; name: string }[]; sipOutputs: { idx: number; name: string }[];
  onAudioChange: (input: string, output: string) => void;
  onVolumeChange: (mic: number, spk: number) => void;
}> = ({ ep, rt, onKey, onBackspace, onCall, onHangup, onClear, onAnswer, onReject, onToggleMute, onToggleSpeakerMute, onToggleHold, onTransfer, onToggleRecord, onToggleMedia, onVoicemail, onPickup, onRegister, onUnregister, onSetDialed, onToggleCapture, captureAvailable, onOpenSettings, sswOpen, onToggleSswServices, onSswDial, onSswCtrTransfer, sipInputs, sipOutputs, onAudioChange, onVolumeChange }) => {
  // 재다이얼용 마지막 발신 번호 — sessionStorage 로 endpoint 별 영속 (앱 재시작 시 초기화)
  const lastDialedKey = `pepe-sip-last-${ep.id}`;
  const [lastDialed, setLastDialed] = useState<string>(() => {
    try { return sessionStorage.getItem(lastDialedKey) || ''; } catch { return ''; }
  });
  // sessionStorage 는 창(렌더러)마다 따로다 — 창 분리로 새 창에서 다시 마운트되면 비어 있어서
  // 재다이얼이 비활성으로 보였다. 메인의 sip 스냅샷이 들고 있는 값으로 보충한다(수명은
  // sessionStorage 와 같다 — 앱을 끄면 사라진다).
  useEffect(() => {
    const fromEngine = (rt.lastDialed || '').trim();
    if (!fromEngine || lastDialed) return;
    setLastDialed(fromEngine);
    try { sessionStorage.setItem(lastDialedKey, fromEngine); } catch {}
    /* eslint-disable-next-line */
  }, [rt.lastDialed]);
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
    <div style={{ border: '1px solid var(--win-border, #30363d)', borderRadius: 10, background: 'var(--win-surface, #161b22)', padding: 9, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: regColor[rt.reg], flexShrink: 0 }} title={rt.reg} />
        <b style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }} title={ep.label}>{ep.label}</b>
        {ep.dnd && <span title="방해 금지" style={{ fontSize: 10, flexShrink: 0 }}>🌙</span>}
        {rt.mwi && <button onClick={onVoicemail} title={ep.voicemailNumber ? '음성사서함 듣기' : '음성사서함 도착'} disabled={!ep.voicemailNumber}
          style={{ border: 'none', background: 'transparent', cursor: ep.voicemailNumber ? 'pointer' : 'default', fontSize: 11, padding: 0, flexShrink: 0 }}>📨</button>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexShrink: 0 }}>
          <button onClick={onToggleCapture} disabled={!captureAvailable}
            title={captureAvailable ? (rt.capturing ? '패킷 캡처 중지' : '패킷 캡처 시작') : '패킷 캡처를 사용할 수 없습니다 (capture-local-package 미설치)'}
            style={{ padding: '1px 4px', fontSize: 9, borderRadius: 4, border: '1px solid var(--win-border, #30363d)', background: rt.capturing ? '#da3633' : 'var(--win-surface-2, #21262d)', color: rt.capturing ? '#fff' : 'var(--win-text, #e6edf3)', cursor: captureAvailable ? 'pointer' : 'not-allowed', opacity: captureAvailable ? 1 : 0.4 }}>
            {rt.capturing ? '⏺' : '📡'}
          </button>
          <button onClick={onOpenSettings} title="이 단말 설정 보기 (SSW 부가서비스 포함)"
            style={{ padding: '1px 4px', fontSize: 9, borderRadius: 4, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text, #e6edf3)', cursor: 'pointer' }}>
            ⚙
          </button>
          {rt.reg === 'registered'
            ? <button onClick={onUnregister} title="이 단말 등록 해제"
                style={{ padding: '1px 5px', fontSize: 9, borderRadius: 4, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text, #e6edf3)', cursor: 'pointer' }}>해제</button>
            : <button onClick={onRegister} title="이 단말 등록" disabled={!ep.server.trim() || !ep.username.trim()}
                style={{ padding: '1px 5px', fontSize: 9, borderRadius: 4, border: 'none', background: 'var(--win-accent, #2b6b9b)', color: '#fff', fontWeight: 700, cursor: (ep.server.trim() && ep.username.trim()) ? 'pointer' : 'not-allowed', opacity: (ep.server.trim() && ep.username.trim()) ? 1 : 0.5 }}>등록</button>}
        </div>
      </div>
      <div style={{ fontSize: 9, color: 'var(--win-text-dim, #9aa7b3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: -4 }} title={`${ep.username || '미설정'}@${ep.server || '—'}`}>{ep.username || '미설정'}@{ep.server || '—'}</div>
      {/* 이 단말 전용 마이크/스피커 — 비워두면(자동) 상단 공통(전역) 장치를 쓰고, 지정하면
          이 단말의 통화만 그 장치로 별도 라우팅한다(다른 단말과 동시에 서로 다른 장치 가능).
          변경 즉시 적용(통화 중이면 그 자리에서 재연결). */}
      <div style={{ display: 'flex', gap: 4 }}>
        <select value={ep.audioIn || ''} onChange={e => onAudioChange(e.target.value, ep.audioOut || '')} title="이 단말 마이크"
          style={{ flex: 1, minWidth: 0, padding: '1px 2px', fontSize: 9, borderRadius: 4, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text, #e6edf3)' }}>
          <option value="">🎤 자동</option>
          {sipInputs.map(d => <option key={d.idx} value={d.name}>🎤 {d.name}</option>)}
        </select>
        <select value={ep.audioOut || ''} onChange={e => onAudioChange(ep.audioIn || '', e.target.value)} title="이 단말 스피커"
          style={{ flex: 1, minWidth: 0, padding: '1px 2px', fontSize: 9, borderRadius: 4, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text, #e6edf3)' }}>
          <option value="">🔊 자동</option>
          {sipOutputs.map(d => <option key={d.idx} value={d.name}>🔊 {d.name}</option>)}
        </select>
      </div>
      {/* 이 단말 전용 마이크/스피커 음량(1.0=조정 없음) — 통화 자신의 오디오에 직접 적용되므로
          위 장치 지정(전용/자동)과 무관하게 항상 즉시 반영된다. */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span title={`마이크 음량 ${Math.round((ep.micLevel ?? 1) * 100)}%`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 9, flex: 1 }}>
          🎙<input type="range" min={0} max={2} step={0.05} value={ep.micLevel ?? 1} onChange={e => onVolumeChange(Number(e.target.value), ep.spkLevel ?? 1)} style={{ width: '100%' }} />
        </span>
        <span title={`스피커 음량 ${Math.round((ep.spkLevel ?? 1) * 100)}%`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 9, flex: 1 }}>
          🔈<input type="range" min={0} max={2} step={0.05} value={ep.spkLevel ?? 1} onChange={e => onVolumeChange(ep.micLevel ?? 1, Number(e.target.value))} style={{ width: '100%' }} />
        </span>
      </div>
      <div style={{ minHeight: 22, padding: '2px 4px 2px 8px', borderRadius: 6, background: 'var(--win-bg, #0d1117)', border: '1px solid var(--win-border, #30363d)', display: 'flex', alignItems: 'center', gap: 4 }}>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 3 }}>
        {DIAL_KEYS.map(k => (
          <button key={k} onClick={() => onKey(k)}
            style={{ padding: '4px 0', borderRadius: 5, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text, #e6edf3)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>{k}</button>
        ))}
      </div>
      {incoming ? (
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={onAnswer} style={callBtn('#238636')}>📞 받기</button>
          <button onClick={onReject} style={callBtn('#da3633')}>✖ 거절</button>
        </div>
      ) : (rt.call === 'connected' || rt.call === 'held') ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button onClick={onHangup} style={callBtn('#da3633')}>⛔ 끊기</button>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
            <button onClick={onToggleMute} title="마이크 뮤트" style={{ ...callBtn(rt.muted ? '#d29922' : 'var(--win-surface-2, #21262d)'), padding: '6px 0', color: '#fff' }}>{rt.muted ? '🔇' : '🎤'}</button>
            <button onClick={onToggleSpeakerMute} title="스피커 뮤트" style={{ ...callBtn(rt.speakerMuted ? '#d29922' : 'var(--win-surface-2, #21262d)'), padding: '6px 0', color: '#fff' }}>{rt.speakerMuted ? '🔈' : '🔊'}</button>
            <button onClick={onToggleHold} title={rt.ctrActive ? '호전환 복귀' : '홀드'}
              style={{ ...callBtn(rt.ctrActive ? '#8957e5' : rt.call === 'held' ? '#d29922' : 'var(--win-surface-2, #21262d)'), padding: '6px 0', color: '#fff' }}>
              {rt.ctrActive ? '↩' : rt.call === 'held' ? '▶' : '⏸'}
            </button>
            <button onClick={onTransfer} title="호전환" style={{ ...callBtn('var(--win-surface-2, #21262d)'), padding: '6px 0', color: '#fff' }}>↪</button>
            <button onClick={onToggleRecord} title={rt.recording ? '녹음 중지' : '녹음'} style={{ ...callBtn(rt.recording ? '#da3633' : 'var(--win-surface-2, #21262d)'), padding: '6px 0', color: '#fff' }}>{rt.recording ? '⏹' : '⏺'}</button>
            <button onClick={onToggleMedia} title={rt.mediaPlaying ? '미디어 송출 중단' : '미디어(WAV/MP3) 송출'} style={{ ...callBtn(rt.mediaPlaying ? '#da3633' : 'var(--win-surface-2, #21262d)'), padding: '6px 0', color: '#fff' }}>{rt.mediaPlaying ? '⏹' : '🎵'}</button>
          </div>
        </div>
      ) : inCall ? (
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={onHangup} style={callBtn('#da3633')}>⛔ 끊기</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={callAndRemember} style={callBtn('#238636')}>📞 통화</button>
          <button onClick={redial} disabled={!lastDialed} title={lastDialed ? `재다이얼: ${lastDialed}` : '재다이얼 (이전 발신 없음)'}
            style={{ ...callBtn('var(--win-surface-2, #21262d)'), flex: '0 0 36px', color: 'var(--win-text, #e6edf3)', opacity: lastDialed ? 1 : 0.4, cursor: lastDialed ? 'pointer' : 'not-allowed' }}>↻</button>
          <button onClick={onBackspace} title="지우기" style={{ ...callBtn('var(--win-surface-2, #21262d)'), flex: '0 0 36px', color: 'var(--win-text, #e6edf3)' }}>⌫</button>
          <button onClick={onClear} title="초기화" style={{ ...callBtn('var(--win-surface-2, #21262d)'), flex: '0 0 36px', color: 'var(--win-text, #e6edf3)' }}>C</button>
        </div>
      )}
      <button onClick={onPickup} disabled={rt.reg !== 'registered'}
        title={rt.reg === 'registered' ? '당겨받기 — Request-URI/To = *30*, From = 내 번호로 INVITE 전송' : '등록 후 사용 가능'}
        style={{ ...callBtn('var(--win-surface-2, #21262d)'), color: 'var(--win-text, #e6edf3)', opacity: rt.reg === 'registered' ? 1 : 0.4, cursor: rt.reg === 'registered' ? 'pointer' : 'not-allowed' }}>📲 당겨받기 (*30*)</button>
      <button onClick={onToggleSswServices}
        title="SSW 부가서비스(CFU/CFB/CTR 등)를 이 카드 안에서 바로 설정"
        style={{
          ...callBtn(sswOpen ? 'var(--win-accent, #2b6b9b)' : 'var(--win-surface-2, #21262d)'), color: sswOpen ? '#fff' : 'var(--win-text, #e6edf3)',
          // 펼친 내용이 길어 아래로 스크롤해도 닫는 버튼을 다시 찾으러 위로 스크롤하지 않도록,
          // 설정 카드의 "⚙ 설정 닫기"와 같은 방식으로 스크롤 영역 상단에 고정한다.
          ...(sswOpen ? { position: 'sticky' as const, top: 4, zIndex: 2, boxShadow: '0 2px 6px rgba(0,0,0,0.4)' } : {}),
        }}>
        📡 SSW 부가서비스 {sswOpen ? '▲' : '▼'}
      </button>
      {sswOpen && (
        <div style={{ border: '1px solid var(--win-border, #30363d)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--win-bg, #0d1117)' }}>
          <SswServicesPanel ep={ep} callState={rt.call} onDial={onSswDial} onCtrTransfer={onSswCtrTransfer} />
        </div>
      )}
      {rt.error && <div style={{ fontSize: 10, color: '#f85149' }}>{rt.error}</div>}
    </div>
  );
};
// 단말 카드 뒤집기 — 카드 뒷면에 SettingsCard 를 보여준다(설정탭으로 안 옮겨도 콜로그가 그대로 유지됨).
// 회전 중간(90도, 카드가 옆으로 선 순간이라 어차피 안 보임) 시점에 내용을 바꿔치기해 두 면의
// 높이가 달라도(둘 다 문서 흐름에 있는 하나의 카드) 그리드 셀 크기 계산이 어긋나지 않게 한다.
const FlippableCard: React.FC<{ flipped: boolean; front: React.ReactNode; back: React.ReactNode }> = ({ flipped, front, back }) => {
  const [showBack, setShowBack] = useState(flipped);
  useEffect(() => {
    const t = setTimeout(() => setShowBack(flipped), 150);
    return () => clearTimeout(t);
  }, [flipped]);
  return (
    <div style={{ perspective: 1200 }}>
      <div style={{ transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)', transition: 'transform 0.3s ease' }}>
        <div style={{ transform: showBack ? 'rotateY(180deg)' : 'none' }}>
          {showBack ? back : front}
        </div>
      </div>
    </div>
  );
};
const callBtn = (bg: string): React.CSSProperties => ({ flex: 1, padding: '6px 0', borderRadius: 7, border: 'none', background: bg, color: '#fff', fontWeight: 700, fontSize: 11, cursor: 'pointer' });

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
// SSW 부가서비스 컨트롤 목록 — SettingsCard(설정 카드 안 섹션)와 단말 카드의 "📡 부가서비스" 버튼이
// 뜨는 모달 양쪽에서 그대로 재사용한다(중복 구현 대신 이 하나만 유지).
const SswServicesPanel: React.FC<{
  ep: SipEndpoint; callState: CallState;
  onDial: (number: string) => void; onCtrTransfer: (digits: string, number: string) => void;
}> = ({ callState, onDial, onCtrTransfer }) => {
  const [sswValues, setSswValues] = useState<Record<string, string>>({});
  const [sswNns, setSswNns] = useState<Record<string, string>>({});
  const setSswValue = (svc: SswService, v: string) => setSswValues(prev => ({ ...prev, [svc.id]: v }));
  const setSswNn = (svc: SswService, v: string) => setSswNns(prev => ({ ...prev, [svc.id]: v }));
  const inp: React.CSSProperties = { padding: '6px 8px', background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 12, boxSizing: 'border-box', minWidth: 0 };
  // CTR(호전환)은 보류 중이 아니어도 활성 통화 중이면 바로 가능하다 — MiniSoftphone 도
  // HeldLine() ?? ActiveTalkingLine() 로 보류를 우선하되 없으면 활성 통화로 대체한다.
  const sswCanCtr = callState === 'held' || callState === 'connected';
  const isSswValid = (svc: SswService, activate: boolean): boolean => {
    const val = (sswValues[svc.id] || '').trim();
    if (svc.id === 'cfnaTimer' && activate) {
      const n = Number(val);
      if (!val || Number.isNaN(n) || n < 5 || n > 30) return false;
    }
    if (activate && svc.needsValue !== false && !val) return false;
    if (!activate && svc.offNeedsValue && !val) return false;
    return true;
  };
  const triggerSsw = (svc: SswService, activate: boolean) => {
    if (!isSswValid(svc, activate)) return;
    const val = (sswValues[svc.id] || '').trim();
    const nn = svc.hasNN ? (sswNns[svc.id] || '01') : '';
    onDial(buildSswDial(svc, activate, val, nn));
  };
  const triggerSswCtr = (svc: SswService) => {
    if (!sswCanCtr) return;
    const num = (sswValues[svc.id] || '').trim();
    if (!num) return;
    onCtrTransfer(svc.digits, num);
  };
  return (
    <>
      <div style={{ fontSize: 10, color: 'var(--win-text-dim, #6e7681)', marginBottom: 2 }}>SK브로드밴드 PBX 전용 스타코드 — 일반 통화처럼 해당 코드로 다이얼합니다.</div>
      {SSW_SERVICES.map(svc => (
        <div key={svc.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: 8, borderRadius: 8, background: 'var(--win-bg, #0d1117)', border: '1px solid var(--win-border, #30363d)', flexWrap: 'wrap' }}>
          <b style={{ fontSize: 12, flex: '0 0 130px' }}>{svc.label}</b>
          <span style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', flex: '1 1 180px', minWidth: 140 }}>{svc.desc}</span>
          {svc.hasNN && (
            <select value={sswNns[svc.id] || '01'} onChange={e => setSswNn(svc, e.target.value)} title="NN" style={{ ...inp, flex: '0 0 60px' }}>
              {Array.from({ length: svc.nnMax || 9 }, (_, i) => String(i + 1).padStart(2, '0')).map(nn => <option key={nn} value={nn}>{nn}</option>)}
            </select>
          )}
          <input value={sswValues[svc.id] || ''} onChange={e => setSswValue(svc, e.target.value)} placeholder={svc.hint}
            style={{ ...inp, flex: '0 1 120px', minWidth: 80, fontFamily: 'Consolas, monospace' }} />
          {svc.isTransfer ? (
            <button onClick={() => triggerSswCtr(svc)} disabled={!sswCanCtr || !(sswValues[svc.id] || '').trim()}
              title={sswCanCtr ? '호전환 (INFO 2회)' : '통화 중(또는 보류 중)이어야 합니다'}
              style={miniBtn(sswCanCtr && !!(sswValues[svc.id] || '').trim())}>전환</button>
          ) : (
            <>
              <button onClick={() => triggerSsw(svc, true)} disabled={!isSswValid(svc, true)}
                title={`활성화: ${buildSswDial(svc, true, (sswValues[svc.id] || '').trim(), svc.hasNN ? (sswNns[svc.id] || '01') : '')}`}
                style={{ ...miniBtn(isSswValid(svc, true)), background: '#238636', color: '#fff', border: 'none' }}>활성화</button>
              {!svc.noOffButton && (
                <button onClick={() => triggerSsw(svc, false)} disabled={svc.disabledOffButton || !isSswValid(svc, false)}
                  title={svc.disabledOffButton ? '해제 코드 없음' : `해제: ${buildSswDial(svc, false, (sswValues[svc.id] || '').trim(), svc.hasNN ? (sswNns[svc.id] || '01') : '')}`}
                  style={{ ...miniBtn(!svc.disabledOffButton && isSswValid(svc, false)), color: '#f85149' }}>해제</button>
              )}
            </>
          )}
        </div>
      ))}
    </>
  );
};

const SettingsCard: React.FC<{
  ep: SipEndpoint; all: SipEndpoint[]; reg: RegState; callState: CallState; idx: number; total: number;
  onChange: (p: Partial<SipEndpoint>) => void; onCopyFrom: (srcId: string) => void;
  onDnd: (on: boolean) => void; onMove: (dir: -1 | 1) => void;
  onRegister: () => void; onUnregister: () => void; onRemove: () => void;
  onSave: (draft: Partial<SipEndpoint>) => Promise<{ ok: boolean; error?: string }>;
  onDial: (number: string) => void; onCtrTransfer: (digits: string, number: string) => void;
  capturing: boolean; captureAvailable: boolean; onToggleCapture: () => void;
  captureInterfaces: { id: string; name: string }[]; captureIface: string; onCaptureIfaceChange: (id: string) => void;
  onBack?: () => void;
}> = ({ ep, all, reg, callState, idx, total, onChange, onCopyFrom, onDnd, onMove, onRegister, onUnregister, onRemove, onSave,
  onDial, onCtrTransfer, capturing, captureAvailable, onToggleCapture, captureInterfaces, captureIface, onCaptureIfaceChange, onBack }) => {
  // draft — 사용자가 입력한 변경분. 저장(register 성공) 시에만 ep 에 commit.
  const [draft, setDraft] = useState<Partial<SipEndpoint>>({});
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string>('');
  const [showPw, setShowPw] = useState(false);
  const [showTurnPw, setShowTurnPw] = useState(false);
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
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)', flex: 1, minWidth: 0 }}>
      <span>{label}</span>{node}
    </label>
  );
  const inp: React.CSSProperties = { padding: '6px 8px', background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 12, boxSizing: 'border-box', minWidth: 0 };
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
      {onBack && (
        // 설정 카드 내용이 길어 아래로 스크롤한 상태에서도 닫기 버튼을 다시 찾으러 위로 스크롤하지
        // 않도록 카드 스크롤 영역(바깥 overflow:auto) 기준으로 상단에 고정한다.
        <button onClick={onBack} title="설정 닫기 — 통화 카드로 돌아가기"
          style={{ position: 'sticky', top: 4, zIndex: 2, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10, padding: '4px 10px', fontSize: 11, borderRadius: 6, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface-2, #21262d)', color: 'var(--win-text, #e6edf3)', cursor: 'pointer', boxShadow: '0 2px 6px rgba(0,0,0,0.4)' }}>
          ⚙ 설정 닫기
        </button>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 9, height: 9, borderRadius: 999, background: regColor[reg], flexShrink: 0 }} title={reg} />
          <input value={cur.label} onChange={e => onChangeLocal({ label: e.target.value })} style={{ ...inp, flex: 1, fontWeight: 700, fontSize: 13 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <select defaultValue="" onChange={e => { if (e.target.value) { onCopyFrom(e.target.value); e.target.value = ''; } }} title="다른 단말 설정 복사" style={{ ...inp, flex: '1 1 100px', minWidth: 90 }}>
            <option value="">설정 복사 ←</option>
            {all.filter(x => x.id !== cur.id).map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
          <button onClick={() => onMove(-1)} disabled={idx === 0} title="위로" style={{ ...inp, whiteSpace: 'nowrap', flexShrink: 0, cursor: idx === 0 ? 'not-allowed' : 'pointer', opacity: idx === 0 ? 0.4 : 1, padding: '6px 8px' }}>▲</button>
          <button onClick={() => onMove(1)} disabled={idx >= total - 1} title="아래로" style={{ ...inp, whiteSpace: 'nowrap', flexShrink: 0, cursor: idx >= total - 1 ? 'not-allowed' : 'pointer', opacity: idx >= total - 1 ? 0.4 : 1, padding: '6px 8px' }}>▼</button>
          <button onClick={onToggleCapture} disabled={!captureAvailable}
            title={captureAvailable ? (capturing ? '패킷 캡처 중지' : '패킷 캡처 시작') : '패킷 캡처를 사용할 수 없습니다 (capture-local-package 미설치)'}
            style={{ ...inp, whiteSpace: 'nowrap', flexShrink: 0, cursor: captureAvailable ? 'pointer' : 'not-allowed', opacity: captureAvailable ? 1 : 0.4, background: capturing ? '#da3633' : 'var(--win-surface-2, #21262d)', color: capturing ? '#fff' : 'var(--win-text, #e6edf3)' }}>
            {capturing ? '⏺ 캡처 중' : '📡 캡처'}
          </button>
          {reg === 'registered'
            ? <button onClick={onUnregister} style={{ ...inp, whiteSpace: 'nowrap', flexShrink: 0, cursor: 'pointer', background: 'var(--win-surface-2, #21262d)' }}>해제</button>
            : <button onClick={onRegister} style={{ ...inp, whiteSpace: 'nowrap', flexShrink: 0, cursor: 'pointer', background: 'var(--win-accent, #2b6b9b)', color: '#fff', border: 'none', fontWeight: 700 }}>등록</button>}
          <button onClick={onRemove} title="단말 삭제" style={{ ...inp, whiteSpace: 'nowrap', flexShrink: 0, cursor: 'pointer', color: '#f85149' }}>🗑</button>
        </div>
      </div>
      {/* 📇 계정 */}
      <Section title="📇 계정" defaultOpen>
        {/* MiniSoftphone 과 동일하게 포트는 별도 필드 없이 "서버:포트" 형태로 이 한 칸에 같이 입력
            (SIP Proxy 필드에 별도 포트가 있어서 둘을 헷갈리기 쉬웠음) — 콜론+숫자 접미사가 있으면
            그걸 포트로, 없으면 기본 5060 으로 저장한다. */}
        {field('SIP 서버 (registrar)', <input
          value={cur.port && cur.port !== 5060 ? `${cur.server}${cur.server ? ':' : ''}${cur.port}` : cur.server}
          onChange={e => {
            const v = e.target.value;
            const m = v.match(/^(.*):(\d+)$/);
            if (m) onChangeLocal({ server: m[1], port: Number(m[2]) || 5060 });
            else onChangeLocal({ server: v, port: 5060 });
          }}
          placeholder="skbroadband.com 또는 skbroadband.com:5060" style={inp} />)}
        {field('SIP Proxy', <input value={cur.proxy || ''} onChange={e => onChangeLocal({ proxy: e.target.value })} placeholder="proxy:5060" style={inp} />)}
        {field('도메인 (미지정 시 서버와 동일)', <input value={cur.domain || ''} onChange={e => onChangeLocal({ domain: e.target.value })} placeholder="example.com" style={inp} />)}
        {field('전송', <select value={cur.transport} onChange={e => onChangeLocal({ transport: e.target.value as any })} style={inp}><option value="udp">UDP</option><option value="tcp">TCP</option><option value="tls">TLS</option></select>)}
        {field('사용자(번호)', <input value={cur.username} onChange={e => onChangeLocal({ username: e.target.value })} style={inp} />)}
        {field('인증 ID(로그인, 선택)', <input value={cur.authId || ''} onChange={e => onChangeLocal({ authId: e.target.value })} style={inp} />)}
        {field('비밀번호', (
          <div style={{ display: 'flex', gap: 4 }}>
            <input type={showPw ? 'text' : 'password'} value={cur.password} onChange={e => onChangeLocal({ password: e.target.value })} style={{ ...inp, flex: 1 }} />
            <button type="button" onClick={() => setShowPw(v => !v)} title={showPw ? '비밀번호 숨기기' : '비밀번호 보기'}
              style={{ ...inp, flex: '0 0 auto', cursor: 'pointer', padding: '6px 10px' }}>{showPw ? '🙈' : '👁'}</button>
          </div>
        ))}
        {field('표시 이름(선택)', <input value={cur.displayName || ''} onChange={e => onChangeLocal({ displayName: e.target.value })} style={inp} />)}
        {field('Contact 고정(선택 — 비우면 자동)', <input value={cur.contactForced || ''} onChange={e => onChangeLocal({ contactForced: e.target.value })} placeholder="sip:07076008342@1.2.3.4:5060" style={inp} />)}
        {field('User-Agent(선택 — 비우면 기본값)', <input value={cur.userAgent || ''} onChange={e => onChangeLocal({ userAgent: e.target.value })} placeholder="PePe-MicroSIP/1.0" style={inp} />)}
        {field('로컬 SIP 포트(선택 — 0=자동/공용)', <input type="text" inputMode="numeric" pattern="[0-9]*"
          value={cur.localSipPort ?? 0}
          onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ''); onChangeLocal({ localSipPort: v === '' ? 0 : Number(v) }); }}
          style={inp} />)}
      </Section>

      {/* 🌐 네트워크(RTP 포트) */}
      <Section title="🌐 네트워크(RTP 포트)">
        <div style={{ display: 'flex', gap: 8 }}>
          {field('RTP 포트 시작(0=자동)', <input type="number" value={cur.rtpPortMin ?? 0} onChange={e => onChangeLocal({ rtpPortMin: Number(e.target.value) || 0 })} style={inp} />)}
          {field('RTP 포트 끝', <input type="number" value={cur.rtpPortMax ?? 0} onChange={e => onChangeLocal({ rtpPortMax: Number(e.target.value) || 0 })} style={inp} />)}
        </div>
        <div style={{ fontSize: 10, color: 'var(--win-text-dim, #6e7681)' }}>※ 둘 다 0 이면 자동 할당(권장). 방화벽 정책상 범위를 제한해야 할 때만 지정하세요.</div>
        {field('RTP 무응답 자동 종료(초, 0=사용 안 함)', <input type="number" min={0} value={cur.rtpTimeoutSec ?? 0} onChange={e => onChangeLocal({ rtpTimeoutSec: Number(e.target.value) || 0 })} style={inp} />)}
        <div style={{ fontSize: 10, color: 'var(--win-text-dim, #6e7681)' }}>※ 보류 중인 통화는 감시하지 않음. 기본 60초(MiniSoftphone 과 동일).</div>
      </Section>

      {/* 📤 발신 추가 헤더 — 번호만 입력하면 엔진이 SKB 캡처 기준 포맷으로 완성해서 보낸다 */}
      <Section title="📤 발신 추가 헤더 (번호만 입력 · 비우면 미포함)">
        {field('Diversion', <input value={cur.divertHeader || ''} onChange={e => onChangeLocal({ divertHeader: e.target.value })} placeholder="0263961202" style={inp} />)}
        {field('Remote-Party-ID', <input value={cur.rpidHeader || ''} onChange={e => onChangeLocal({ rpidHeader: e.target.value })} placeholder="0263961202" style={inp} />)}
        {field('P-Asserted-Identity', <input value={cur.paiHeader || ''} onChange={e => onChangeLocal({ paiHeader: e.target.value })} placeholder="0263961202" style={inp} />)}
        {field('Privacy', (
          <select value={cur.paiPrivacy || ''} onChange={e => onChangeLocal({ paiPrivacy: e.target.value })} style={inp}>
            <option value="">(없음)</option>
            <option value="none">none</option>
            <option value="header">header</option>
            <option value="session">session</option>
            <option value="user">user</option>
            <option value="id">id</option>
            <option value="critical">critical</option>
          </select>
        ))}
      </Section>

      {/* 📡 SSW 부가서비스 (SK브로드밴드 PBX 스타코드) — 실제 컨트롤은 SswServicesPanel 공용 컴포넌트 */}
      <Section title="📡 SSW 부가서비스">
        <SswServicesPanel ep={cur} callState={callState} onDial={onDial} onCtrTransfer={onCtrTransfer} />
      </Section>

      {/* 📵 수신 거절 응답 */}
      <Section title="📵 수신 거절 응답">
        {field('거절 코드', (
          <select value={cur.rejectCode ?? 486} onChange={e => onChangeLocal({ rejectCode: Number(e.target.value) })} style={inp}>
            {REJECT_CODES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        ))}
        {field('거절 타이밍', (
          <select value={cur.rejectTiming || 'immediate'} onChange={e => onChangeLocal({ rejectTiming: e.target.value as any })} style={inp}>
            <option value="immediate">180 없이 즉시 거절</option>
            <option value="after180">180 송신 후 지연 거절</option>
          </select>
        ))}
        {cur.rejectTiming === 'after180' && field('180 후 지연(초)', <input type="number" min={0} value={cur.rejectDelaySec ?? 0} onChange={e => onChangeLocal({ rejectDelaySec: Number(e.target.value) || 0 })} style={inp} />)}
        <div style={{ fontSize: 10, color: 'var(--win-text-dim, #6e7681)' }}>※ 수동 거절 버튼과, 방해금지(DND)/통화중대기 꺼짐으로 인한 자동 거절 모두 이 설정을 사용합니다.</div>
        {field('발신번호 우선순위(위가 먼저 확인)', (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(cur.callerIdPriority || ['rpid', 'from', 'pai']).map((p, i, arr) => (
              <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ flex: 1 }}>{p === 'rpid' ? 'Remote-Party-ID' : p === 'pai' ? 'P-Asserted-Identity' : 'From'}</span>
                <button onClick={() => { const n = [...arr]; if (i > 0) { [n[i - 1], n[i]] = [n[i], n[i - 1]]; onChangeLocal({ callerIdPriority: n }); } }} disabled={i === 0} style={{ ...inp, padding: '2px 6px', cursor: i === 0 ? 'not-allowed' : 'pointer', opacity: i === 0 ? 0.4 : 1 }}>▲</button>
                <button onClick={() => { const n = [...arr]; if (i < arr.length - 1) { [n[i + 1], n[i]] = [n[i], n[i + 1]]; onChangeLocal({ callerIdPriority: n }); } }} disabled={i === arr.length - 1} style={{ ...inp, padding: '2px 6px', cursor: i === arr.length - 1 ? 'not-allowed' : 'pointer', opacity: i === arr.length - 1 ? 0.4 : 1 }}>▼</button>
              </div>
            ))}
          </div>
        ))}
      </Section>

      {/* 📡 패킷 캡처 — 인터페이스는 워크스페이스 전체 공통 설정(단말별 아님) */}
      <Section title="📡 패킷 캡처">
        {!captureAvailable && (
          <div style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>
            패킷 캡처를 사용할 수 없습니다 — capture-local-package(install-capture-local.bat) 를 설치한 뒤 앱을 재시작하세요.
          </div>
        )}
        {field('캡처 인터페이스 (모든 단말 공통)', (
          <select value={captureIface} onChange={e => onCaptureIfaceChange(e.target.value)} disabled={!captureAvailable} style={inp}>
            <option value="">인터페이스 선택...</option>
            {captureInterfaces.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        ))}
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
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }} title="켜짐: 보류/재개를 표준 재-INVITE 대신 SIP INFO(0x10 04 00 00)로 신호 — SSW/SKB 교환기(CHD) 캡처 기준. 꺼짐: 일반 SIP 서버 호환 표준 방식(재-INVITE + a=sendonly).">
            <input type="checkbox" checked={!!cur.holdViaInfo} onChange={e => onChangeLocal({ holdViaInfo: e.target.checked })} /> 보류를 SIP INFO로 신호(SSW CHD)
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={cur.publishPresence !== false} onChange={e => onChangeLocal({ publishPresence: e.target.checked })} /> 계정 상태 게시
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={cur.mwiSubscribe !== false} onChange={e => onChangeLocal({ mwiSubscribe: e.target.checked })} /> 음성사서함(MWI) 구독
          </label>
        </div>
        {field('STUN 서버(host:port)', <input value={cur.stunServer || ''} onChange={e => onChangeLocal({ stunServer: e.target.value })} placeholder="stun.example.com:3478" style={inp} />)}
        {field('TURN 서버(host:port)', <input value={cur.turnServer || ''} onChange={e => onChangeLocal({ turnServer: e.target.value })} placeholder="turn.example.com:3478" style={inp} />)}
        {cur.turnServer ? field('TURN 사용자', <input value={cur.turnUser || ''} onChange={e => onChangeLocal({ turnUser: e.target.value })} style={inp} />) : null}
        {cur.turnServer ? field('TURN 비밀번호', (
          <div style={{ display: 'flex', gap: 4 }}>
            <input type={showTurnPw ? 'text' : 'password'} value={cur.turnPassword || ''} onChange={e => onChangeLocal({ turnPassword: e.target.value })} style={{ ...inp, flex: 1 }} />
            <button type="button" onClick={() => setShowTurnPw(v => !v)} title={showTurnPw ? '비밀번호 숨기기' : '비밀번호 보기'}
              style={{ ...inp, flex: '0 0 auto', cursor: 'pointer', padding: '6px 10px' }}>{showTurnPw ? '🙈' : '👁'}</button>
          </div>
        )) : null}
      </Section>

      {/* ⚙ 통화 · 프로그램 */}
      <Section title="⚙ 통화 · 프로그램">
        {field('발신 prefix', <input value={cur.dialPrefix || ''} onChange={e => onChangeLocal({ dialPrefix: e.target.value })} placeholder="예: 9 (외부 회선)" style={inp} />)}
        {field('음성사서함 번호', <input value={cur.voicemailNumber || ''} onChange={e => onChangeLocal({ voicemailNumber: e.target.value })} placeholder="*97" style={inp} />)}
        {field('DTMF 방식', <select value={cur.dtmfMode || 'rfc2833'} onChange={e => onChangeLocal({ dtmfMode: e.target.value as any })} style={inp}><option value="rfc2833">RFC 2833</option><option value="info">SIP INFO</option><option value="inband">In-band</option></select>)}
        {field('🎵 미디어 송출 파일 — WAV/MP3/M4A/OGG(통화 중 버튼이 바로 이 파일 재생, WAV 아니면 자동 변환)', (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ ...inp, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: cur.mediaFile ? 'var(--win-text, #e6edf3)' : 'var(--win-text-dim, #6e7681)' }}>
              {cur.mediaFile || '(미지정 — 버튼 클릭 시마다 선택창)'}
            </span>
            <button onClick={async () => { const f = await api().sipMediaPickFile?.().catch(() => null); if (f) onChangeLocal({ mediaFile: f }); }} style={{ ...inp, cursor: 'pointer' }}>찾아보기</button>
            {cur.mediaFile && <button onClick={() => onChangeLocal({ mediaFile: '' })} title="해제" style={{ ...inp, cursor: 'pointer', color: '#f85149' }}>✕</button>}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={cur.autoRegister !== false} onChange={e => onChangeLocal({ autoRegister: e.target.checked })} /> 시작 시 등록
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={!!cur.autoAnswer} onChange={e => onChangeLocal({ autoAnswer: e.target.checked })} /> 자동 응답
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }} title="MiniSoftphone(SKB 캡처 기준): 통화 중 두 번째 인입은 절대 연결/대기되지 않음 — 이 옵션은 그 거절 방식만 고른다.">
            <input type="checkbox" checked={cur.callWaiting !== false} onChange={e => onChangeLocal({ callWaiting: e.target.checked })} /> 통화 중 486 거절 사용(꺼지면 무응답)
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

