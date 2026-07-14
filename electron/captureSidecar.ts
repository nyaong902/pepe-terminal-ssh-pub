// electron/captureSidecar.ts
// MicroSIP 단말별 패킷 캡처 — Wireshark 배포판의 dumpcap.exe(BSD 라이선스)를 child_process 로
// spawn 해 실시간 캡처를 수행한다. dumpcap.exe 자체는 Npcap(패킷 드라이버)에 의존하므로,
// 공개 git 저장소에는 어느 쪽도 포함하지 않고 사용자가 로컬로 설치한 Wireshark/Npcap 을
// 가리키는 사이드카 취급으로 간주한다 — evs-local-package/crypto-local-package 와 동일한
// "외부 설치가 있어야 기능이 켜진다" 게이팅 패턴.
//
// dumpcap 자체는 캡처 도중 진행 상황을 stderr 로 사람이 읽는 텍스트 라인으로 출력한다(고정
// 프로토콜 없음) — sipSidecar.ts 처럼 stdin/stdout JSON 프로토콜을 쓰지 않고, 프로세스
// 생존 여부와 종료 코드만으로 상태를 판단한다.
import { spawn, execFile, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export type CaptureInterface = { id: string; name: string };

function candidateDumpcapPaths(): string[] {
  const candidates: string[] = [];
  if (process.env.PEPE_DUMPCAP) candidates.push(process.env.PEPE_DUMPCAP);
  // microsip-capture-local-package/install-capture-local.bat 의 기본 설치 위치.
  candidates.push(path.join(os.homedir(), '.pepe-capture-local', 'dumpcap.exe'));
  // Wireshark 기본 설치 경로(사용자가 이미 Wireshark 를 설치해 둔 경우).
  candidates.push('C:\\Program Files\\Wireshark\\dumpcap.exe');
  candidates.push('C:\\Program Files (x86)\\Wireshark\\dumpcap.exe');
  return candidates;
}

export function resolveDumpcap(): string | null {
  for (const c of candidateDumpcapPaths()) {
    try { if (c && fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

export function isCaptureAvailable(): boolean {
  return resolveDumpcap() !== null;
}

export function listInterfaces(): Promise<{ ok: boolean; interfaces?: CaptureInterface[]; error?: string }> {
  return new Promise((resolve) => {
    const bin = resolveDumpcap();
    if (!bin) {
      resolve({ ok: false, error: 'dumpcap.exe를 찾을 수 없습니다 (패킷 캡처 로컬 패키지 미설치).' });
      return;
    }
    execFile(bin, ['-D'], { windowsHide: true }, (err, stdout) => {
      if (err) { resolve({ ok: false, error: String(err.message || err) }); return; }
      // 출력 예: "1. \Device\NPF_{...} (이더넷)"
      const interfaces: CaptureInterface[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^(\d+)\.\s+(\S+)\s*(?:\((.+)\))?/);
        if (!m) continue;
        const id = m[2];
        const label = m[3] ? `${m[3]} (${id})` : id;
        interfaces.push({ id, name: label });
      }
      resolve({ ok: true, interfaces });
    });
  });
}

type CaptureHandle = { proc: ChildProcess; filePath: string };

class CaptureManager {
  private handles = new Map<string, CaptureHandle>();

  status(endpointId: string): { capturing: boolean; filePath?: string } {
    const h = this.handles.get(endpointId);
    if (!h || h.proc.killed || h.proc.exitCode !== null) return { capturing: false };
    return { capturing: true, filePath: h.filePath };
  }

  start(endpointId: string, iface: string, outPath: string): { ok: boolean; error?: string; filePath?: string } {
    if (this.handles.has(endpointId)) return { ok: false, error: '이미 이 단말은 캡처 중입니다.' };
    const bin = resolveDumpcap();
    if (!bin) return { ok: false, error: 'dumpcap.exe를 찾을 수 없습니다 (패킷 캡처 로컬 패키지 미설치). install-capture-local.bat 을 실행한 뒤 다시 시도하세요.' };
    if (!iface) return { ok: false, error: '캡처할 네트워크 인터페이스를 먼저 선택하세요.' };
    try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); } catch (e: any) {
      return { ok: false, error: `저장 폴더를 만들 수 없습니다: ${e?.message || e}` };
    }
    let proc: ChildProcess;
    try {
      // SIP/RTP 만 필요하므로 UDP 로 한정 — 무제한 캡처로 디스크가 차는 것을 막는다.
      proc = spawn(bin, ['-i', iface, '-w', outPath, '-f', 'udp'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (e: any) {
      return { ok: false, error: `dumpcap 실행 실패: ${e?.message || e}` };
    }
    let startError = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (d: string) => { startError = String(d).trim() || startError; });
    proc.on('exit', () => { this.handles.delete(endpointId); });
    proc.on('error', () => { this.handles.delete(endpointId); });
    this.handles.set(endpointId, { proc, filePath: outPath });
    void startError;
    return { ok: true, filePath: outPath };
  }

  stop(endpointId: string): { ok: boolean; filePath?: string } {
    const h = this.handles.get(endpointId);
    if (!h) return { ok: false };
    try { h.proc.kill(); } catch {}
    this.handles.delete(endpointId);
    return { ok: true, filePath: h.filePath };
  }

  stopAll(): void {
    for (const id of Array.from(this.handles.keys())) this.stop(id);
  }
}

let inst: CaptureManager | null = null;
export function getCaptureManager(): CaptureManager { if (!inst) inst = new CaptureManager(); return inst; }
