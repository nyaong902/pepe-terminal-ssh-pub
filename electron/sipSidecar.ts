// electron/sipSidecar.ts
// MicroSIP 네이티브 PJSIP 사이드카 제어 계층 (Phase 2 — 프로세스 호스트 + 프로토콜).
//
// 네이티브 데몬(sip-sidecar/src/sipd.cpp, PJSUA2 + AMR/AMR-WB/EVS/G.711)을 child_process 로
// spawn 하고, stdin/stdout 으로 1줄=1 JSON 메시지를 주고받는다.
//   → (제어)  {"cmd":"register"|"unregister"|"call"|"hangup"|"dtmf"|"audio", ...}
//   ← (이벤트) {"ev":"ready"|"reg"|"call"|"log"|"error", ...}
// 데몬 바이너리가 없으면 ready=false 로 graceful 동작(렌더러는 구성/저장만 가능).
//
// 바이너리 경로:
//   env PEPE_SIPD 우선 → 패키지: <resources>/sip-sidecar/<plat>/sipd(.exe)
//                      → dev:    <repo>/sip-sidecar/bin/<plat>/sipd(.exe)
import { app } from 'electron';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';

function platDir(): string {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return 'linux-x64';
}
function binName(): string { return process.platform === 'win32' ? 'sipd.exe' : 'sipd'; }

function resolveBinary(): string | null {
  const candidates: string[] = [];
  if (process.env.PEPE_SIPD) candidates.push(process.env.PEPE_SIPD);
  try {
    if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'sip-sidecar', platDir(), binName()));
    else candidates.push(path.join(process.cwd(), 'sip-sidecar', 'bin', platDir(), binName()));
  } catch {}
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  return null;
}

class SipSidecar extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private stdoutBuf = '';
  private startError: string | null = null;

  status() { return { ready: this.ready, binary: resolveBinary(), error: this.startError }; }

  /** 데몬이 떠 있지 않으면 spawn. 반환: 사용 가능 여부. */
  private ensure(): boolean {
    if (this.proc && !this.proc.killed) return true;
    const bin = resolveBinary();
    if (!bin) {
      this.startError = '네이티브 SIP 데몬(sipd) 바이너리를 찾을 수 없습니다. sip-sidecar/ 빌드 후 bin/<plat>/ 에 배치하거나 PEPE_SIPD 환경변수로 경로를 지정하세요. (sip-sidecar/README.md)';
      this.ready = false;
      return false;
    }
    try {
      this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.startError = null;
    } catch (e: any) {
      this.startError = `sipd 실행 실패: ${e?.message || e}`;
      this.ready = false;
      this.proc = null;
      return false;
    }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d: string) => { try { this.emit('event', { ev: 'log', level: 'stderr', text: String(d).trim() }); } catch {} });
    this.proc.on('error', (err: any) => { this.startError = String(err?.message || err); this.ready = false; });
    this.proc.on('exit', (code) => {
      this.ready = false;
      this.proc = null;
      this.stdoutBuf = '';
      try { this.emit('event', { ev: 'log', level: 'info', text: `sipd 종료 (code=${code})` }); } catch {}
    });
    this.ready = true; // 프로세스 기동 성공 (개별 등록 상태는 reg 이벤트로)
    return true;
  }

  private onStdout(chunk: string) {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg?.ev === 'ready') { this.ready = true; continue; }
      if (msg?.ev) { try { this.emit('event', msg); } catch {} }
    }
  }

  private send(obj: any): boolean {
    if (!this.ensure() || !this.proc) return false;
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); return true; }
    catch { return false; }
  }

  async register(endpoint: any): Promise<{ ok: boolean; error?: string }> {
    if (!this.ensure()) return { ok: false, error: this.startError || 'sipd 미가용' };
    return this.send({ cmd: 'register', endpoint }) ? { ok: true } : { ok: false, error: 'sipd 전송 실패' };
  }
  async unregister(endpointId: string): Promise<{ ok: boolean }> {
    this.send({ cmd: 'unregister', endpointId });
    return { ok: true };
  }
  async call(endpointId: string, target: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.ensure()) return { ok: false, error: this.startError || 'sipd 미가용' };
    return this.send({ cmd: 'call', endpointId, target }) ? { ok: true } : { ok: false, error: 'sipd 전송 실패' };
  }
  async hangup(endpointId: string): Promise<{ ok: boolean }> { this.send({ cmd: 'hangup', endpointId }); return { ok: true }; }
  async answer(endpointId: string): Promise<{ ok: boolean }> { this.send({ cmd: 'answer', endpointId }); return { ok: true }; }
  async reject(endpointId: string): Promise<{ ok: boolean }> { this.send({ cmd: 'reject', endpointId }); return { ok: true }; }
  async hold(endpointId: string, hold: boolean): Promise<{ ok: boolean }> { this.send({ cmd: 'hold', endpointId, hold }); return { ok: true }; }
  async mute(endpointId: string, mute: boolean): Promise<{ ok: boolean }> { this.send({ cmd: 'mute', endpointId, mute }); return { ok: true }; }
  async transfer(endpointId: string, target: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.ensure()) return { ok: false, error: this.startError || 'sipd 미가용' };
    return this.send({ cmd: 'transfer', endpointId, target }) ? { ok: true } : { ok: false, error: 'sipd 전송 실패' };
  }
  async record(endpointId: string, on: boolean, file: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.ensure()) return { ok: false, error: this.startError || 'sipd 미가용' };
    return this.send({ cmd: 'record', endpointId, on, file }) ? { ok: true } : { ok: false, error: 'sipd 전송 실패' };
  }
  async sendDtmf(endpointId: string, digit: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.ensure()) return { ok: false, error: this.startError || 'sipd 미가용' };
    return this.send({ cmd: 'dtmf', endpointId, digit }) ? { ok: true } : { ok: false, error: 'sipd 전송 실패' };
  }
  setAudioDevices(input?: string, output?: string): void { this.send({ cmd: 'audio', input: input || '', output: output || '' }); }
  listAudioDevices(): void { this.send({ cmd: 'listAudio' }); }
  async sendIm(endpointId: string, target: string, text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.ensure()) return { ok: false, error: this.startError || 'sipd 미가용' };
    return this.send({ cmd: 'im', endpointId, target, text }) ? { ok: true } : { ok: false, error: 'sipd 전송 실패' };
  }
  setPresence(endpointId: string, online: boolean): void { this.send({ cmd: 'presence', endpointId, online }); }
  subscribePresence(endpointId: string, target: string, subscribe: boolean): void { this.send({ cmd: 'subscribe', endpointId, target, subscribe }); }

  dispose(): void {
    try { if (this.proc && !this.proc.killed) { this.send({ cmd: 'quit' }); this.proc.kill(); } } catch {}
    this.proc = null; this.ready = false;
  }
}

let inst: SipSidecar | null = null;
export function getSipSidecar(): SipSidecar { if (!inst) inst = new SipSidecar(); return inst; }
