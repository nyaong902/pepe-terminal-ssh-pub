// electron/sipSidecar.ts
// MicroSIP 네이티브 PJSIP 사이드카 제어 계층.
//
// Phase 1 (현재): 스켈레톤. 엔진(네이티브 데몬)이 아직 없으므로 ready=false 이며 제어 호출은
//   친화 메시지를 반환한다. 렌더러 UI 는 이 상태에서도 단말/설정/매크로를 구성·저장할 수 있다.
// Phase 2: sip-sidecar/ 의 네이티브 데몬(PJSUA2 + opencore-amr/vo-amrwbenc + EVS 플러그인)을
//   child_process 로 spawn 하고, 아래 protocol 주석대로 JSON-over-stdio(1줄=1메시지) 로
//   register/call/hangup/dtmf 를 보내고, reg/call 상태 이벤트를 받아 emit('event', ...) 한다.
//
// ── 제어 프로토콜(예정) ──
//  → {"cmd":"register","endpoint":{id,server,port,transport,username,authId,password,displayName,proxy,codecs[],autoAnswer}}
//  → {"cmd":"unregister","endpointId":"..."}
//  → {"cmd":"call","endpointId":"...","target":"1001"}
//  → {"cmd":"hangup","endpointId":"..."}
//  → {"cmd":"dtmf","endpointId":"...","digit":"1"}
//  → {"cmd":"audio","input":"<deviceId|>","output":"<deviceId|>"}
//  ← {"ev":"reg","endpointId":"...","reg":"registered|registering|failed|unregistered","error?":"..."}
//  ← {"ev":"call","endpointId":"...","call":"calling|ringing|incoming|connected|held|ended","remote?":"..."}
import { EventEmitter } from 'events';

const NOT_READY = '네이티브 SIP 사이드카가 아직 빌드/연결되지 않았습니다 (Phase 2). sip-sidecar/README.md 참고.';

class SipSidecar extends EventEmitter {
  private ready = false;
  // Phase 2: private proc?: import('child_process').ChildProcess;

  status() { return { ready: this.ready }; }

  async register(_endpoint: any): Promise<{ ok: boolean; error?: string }> { return { ok: false, error: NOT_READY }; }
  async unregister(_endpointId: string): Promise<{ ok: boolean }> { return { ok: true }; }
  async call(_endpointId: string, _target: string): Promise<{ ok: boolean; error?: string }> { return { ok: false, error: NOT_READY }; }
  async hangup(_endpointId: string): Promise<{ ok: boolean }> { return { ok: true }; }
  async sendDtmf(_endpointId: string, _digit: string): Promise<{ ok: boolean; error?: string }> { return { ok: false, error: NOT_READY }; }
  setAudioDevices(_input?: string, _output?: string): void { /* Phase 2 */ }
  dispose(): void { /* Phase 2: proc.kill() */ }
}

let inst: SipSidecar | null = null;
export function getSipSidecar(): SipSidecar { if (!inst) inst = new SipSidecar(); return inst; }
