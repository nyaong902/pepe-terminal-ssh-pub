// electron/sippSidecar.ts
// SIPp 워크스페이스 — 네이티브 SIPp(부하 발생기) 프로세스 제어 계층.
//
// MicroSIP 워크스페이스(sipSidecar.ts)와 달리 SIPp 는 상시 상주 데몬이 아니라
// "테스트 1회 실행" 모델이다: 사용자가 편집한 헤더/바디로 SIPp XML 시나리오 파일을
// 임시로 생성하고, sipp.exe 를 CPS(-r)/최대 콜 수(-m) 옵션과 함께 spawn 한다.
// stdout 의 주기적 화면 갱신(screen dump)을 파싱해 통계를 이벤트로 올린다.
//
// 바이너리 경로:
//   env PEPE_SIPP 우선 → 패키지: <resources>/sipp-sidecar/<plat>/sipp.exe
//                      → dev:    <repo>/sipp-sidecar/bin/<plat>/sipp.exe
import { app } from 'electron';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

function platDir(): string {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return 'linux-x64';
}
function binName(): string { return process.platform === 'win32' ? 'sipp.exe' : 'sipp'; }

function resolveBinary(): string | null {
  const candidates: string[] = [];
  if (process.env.PEPE_SIPP) candidates.push(process.env.PEPE_SIPP);
  try {
    if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'sipp-sidecar', platDir(), binName()));
    else candidates.push(path.join(process.cwd(), 'sipp-sidecar', 'bin', platDir(), binName()));
  } catch {}
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  return null;
}

export type SippTestOptions = {
  targetHost: string;
  targetPort: number;
  localIp?: string;
  localPort?: number;
  transport?: 'udp'; // SIPp 는 tcp/tls 도 지원하나 초기 버전은 udp 만 노출
  cps: number;       // -r  (calls per second)
  maxCalls?: number; // -m
  callDurationMs?: number; // INVITE~BYE 사이 Pause (0=즉시 종료)
  /** 시나리오 고급 모드: 완전한 SIPp XML 을 그대로 사용. 지정 시 headers/body 무시. */
  rawScenarioXml?: string;
  /** 기본 INVITE 에 덧붙일 커스텀 헤더 (한 줄에 하나, "Header: value" 형식) */
  extraHeaders?: string;
  /** SDP 바디 — 비우면 SIPp 기본 PCMU SDP 사용 */
  sdpBody?: string;
};

export type SippStats = {
  callsCreated: number;
  successfulCalls: number;
  failedCalls: number;
  currentCalls: number;
  cps: number;
  elapsed?: string;
};

function buildScenarioXml(opts: SippTestOptions): string {
  if (opts.rawScenarioXml && opts.rawScenarioXml.trim()) return opts.rawScenarioXml;

  const extraHeaders = (opts.extraHeaders || '').split('\n').map(l => l.trim()).filter(Boolean).join('\n      ');
  const sdpBody = (opts.sdpBody && opts.sdpBody.trim())
    ? opts.sdpBody
    : [
      'v=0',
      'o=user1 53655765 2353687637 IN IP[local_ip_type] [local_ip]',
      's=-',
      'c=IN IP[media_ip_type] [media_ip]',
      't=0 0',
      'm=audio [media_port] RTP/AVP 0',
      'a=rtpmap:0 PCMU/8000',
    ].join('\n      ');

  const pauseMs = Math.max(0, opts.callDurationMs ?? 0);

  // NOTE: [call_id]/[branch]/[cseq]/[pid] 등은 SIPp 자체 치환 키워드이며 반드시
  // 유지해야 각 콜이 고유하게 식별된다. 사용자가 편집하는 부분은 extraHeaders/sdpBody 뿐.
  return `<?xml version="1.0" encoding="ISO-8859-1" ?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<scenario name="PePe SIPp Workspace">
  <send retrans="500">
    <![CDATA[

      INVITE sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: sipp <sip:sipp@[local_ip]:[local_port]>;tag=[pid]SIPpTag00[call_number]
      To: [service] <sip:[service]@[remote_ip]:[remote_port]>
      Call-ID: [call_id]
      CSeq: 1 INVITE
      Contact: sip:sipp@[local_ip]:[local_port]
      Max-Forwards: 70
      ${extraHeaders}
      Content-Type: application/sdp
      Content-Length: [len]

      ${sdpBody}

    ]]>
  </send>

  <recv response="100" optional="true"></recv>
  <recv response="180" optional="true"></recv>
  <recv response="183" optional="true"></recv>
  <recv response="200" rtd="true"></recv>

  <send>
    <![CDATA[

      ACK sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: sipp <sip:sipp@[local_ip]:[local_port]>;tag=[pid]SIPpTag00[call_number]
      To: [service] <sip:[service]@[remote_ip]:[remote_port]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: 1 ACK
      Contact: sip:sipp@[local_ip]:[local_port]
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>

  <pause milliseconds="${pauseMs}"/>

  <send retrans="500">
    <![CDATA[

      BYE sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: sipp <sip:sipp@[local_ip]:[local_port]>;tag=[pid]SIPpTag00[call_number]
      To: [service] <sip:[service]@[remote_ip]:[remote_port]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: 2 BYE
      Contact: sip:sipp@[local_ip]:[local_port]
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>

  <recv response="200" crlf="true"></recv>

  <ResponseTimeRepartition value="10, 20, 30, 40, 50, 100, 150, 200"/>
  <CallLengthRepartition value="10, 50, 100, 500, 1000, 5000, 10000"/>
</scenario>
`;
}

// 화면 갱신에서 통계 라인을 뽑아낸다. 예:
//   Successful call        |        0                  |        3
//   Failed call             |        0                  |        0
//   Total Calls created    |                           |        3
//   Call Rate              |    0.000 cps              |    4.831 cps
function parseStats(text: string): Partial<SippStats> {
  const out: Partial<SippStats> = {};
  const num = (re: RegExp) => { const m = text.match(re); return m ? Number(m[1]) : undefined; };
  const successful = num(/Successful call\s*\|\s*(\d+)\s*\|\s*(\d+)/);
  const totalMatch = text.match(/Successful call\s*\|\s*(\d+)\s*\|\s*(\d+)/);
  if (totalMatch) out.successfulCalls = Number(totalMatch[2]);
  const failedMatch = text.match(/Failed call\s*\|\s*(\d+)\s*\|\s*(\d+)/);
  if (failedMatch) out.failedCalls = Number(failedMatch[2]);
  const totalCallsMatch = text.match(/Total Calls created\s*\|\s*\|\s*(\d+)/) || text.match(/Total Calls created\s*\|\s*(\d+)\s*\|\s*(\d+)/);
  if (totalCallsMatch) out.callsCreated = Number(totalCallsMatch[totalCallsMatch.length - 1]);
  const cpsMatch = text.match(/Call Rate\s*\|\s*[\d.]+\s*cps\s*\|\s*([\d.]+)\s*cps/);
  if (cpsMatch) out.cps = Number(cpsMatch[1]);
  const currentMatch = text.match(/Current Calls\s*\|\s*(\d+)/);
  if (currentMatch) out.currentCalls = Number(currentMatch[1]);
  const elapsedMatch = text.match(/Elapsed Time\s*\|\s*([\d:]+)/);
  if (elapsedMatch) out.elapsed = elapsedMatch[1];
  void successful;
  return out;
}

// SIPp 는 -nostdin 상태에서도 주기적으로 화면 전체를 다시 찍는다(커브시스 화면 갱신).
// "Scenario Screen"(진행 중 콜 흐름/스텝별 카운터)과 "Statistics Screen"(누적 통계,
// 테스트 종료 시 함께 찍힘) 두 종류 헤더로 시작하는 블록을 통째로 뽑아 최신 것만 유지한다.
function extractLatestScreens(buf: string): { scenario?: string; statistics?: string; lastHeaderIndex: number } {
  // 매 호출마다 새 RegExp 인스턴스를 만든다 — 모듈 전역에 공유된 g-플래그 정규식은
  // lastIndex 를 수동 관리해야 해서 실수하기 쉽고(재진입/예외 시 어긋남), 굳이 공유할
  // 이득도 없다.
  const headerRe = /-{5,}\s*(Scenario Screen|Statistics Screen)\s*-{2,}.*?Change Screen --/g;
  const positions: { kind: 'scenario' | 'statistics'; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(buf))) {
    positions.push({ kind: m[1] === 'Scenario Screen' ? 'scenario' : 'statistics', index: m.index });
  }
  const result: { scenario?: string; statistics?: string; lastHeaderIndex: number } = { lastHeaderIndex: -1 };
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    const end = i + 1 < positions.length ? positions[i + 1].index : buf.length;
    result[positions[i].kind] = buf.slice(start, end).trimEnd();
  }
  if (positions.length > 0) result.lastHeaderIndex = positions[positions.length - 1].index;
  return result;
}

class SippSidecar extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private running = false;
  private startError: string | null = null;
  private scenarioFile: string | null = null;
  private ctrlFile: string | null = null;
  private stdoutBuf = '';
  private lastScenarioScreen = '';
  private lastStatisticsScreen = '';

  status() { return { running: this.running, binary: resolveBinary(), error: this.startError }; }

  start(opts: SippTestOptions): { ok: boolean; error?: string } {
    if (this.proc && !this.proc.killed) {
      return { ok: false, error: '이미 실행 중인 SIPp 테스트가 있습니다. 먼저 중지하세요.' };
    }
    const bin = resolveBinary();
    if (!bin) {
      const msg = '네이티브 SIPp 바이너리를 찾을 수 없습니다. sipp-sidecar/bin/<plat>/ 에 배치하거나 PEPE_SIPP 환경변수로 경로를 지정하세요.';
      this.startError = msg;
      return { ok: false, error: msg };
    }

    let scenarioXml: string;
    try {
      scenarioXml = buildScenarioXml(opts);
    } catch (e: any) {
      return { ok: false, error: `시나리오 생성 실패: ${e?.message || e}` };
    }

    try {
      const tmpFile = path.join(os.tmpdir(), `pepe-sipp-scenario-${Date.now()}.xml`);
      fs.writeFileSync(tmpFile, scenarioXml, 'utf8');
      this.scenarioFile = tmpFile;
    } catch (e: any) {
      return { ok: false, error: `시나리오 파일 저장 실패: ${e?.message || e}` };
    }

    // -ctrl_file: our Windows sipp build can't take live '+'/'-' rate changes
    // via stdin (WSAPoll can't poll non-SOCKET handles), so instead it polls
    // this file for a new CPS value — writing to it is how the GUI's CPS
    // slider takes effect on a test that's already running.
    const ctrlFile = path.join(os.tmpdir(), `pepe-sipp-ctrl-${Date.now()}.txt`);
    try { fs.writeFileSync(ctrlFile, String(opts.cps || 1), 'utf8'); } catch {}
    this.ctrlFile = ctrlFile;

    const args: string[] = [
      `${opts.targetHost}:${opts.targetPort}`,
      '-sf', this.scenarioFile,
      '-r', String(opts.cps || 1),
      '-ctrl_file', ctrlFile,
      '-nostdin',
    ];
    if (opts.maxCalls && opts.maxCalls > 0) args.push('-m', String(opts.maxCalls));
    if (opts.localIp) args.push('-i', opts.localIp);
    if (opts.localPort) args.push('-p', String(opts.localPort));

    try {
      this.proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.startError = null;
    } catch (e: any) {
      this.startError = `sipp 실행 실패: ${e?.message || e}`;
      this.proc = null;
      return { ok: false, error: this.startError };
    }

    this.stdoutBuf = '';
    this.lastScenarioScreen = '';
    this.lastStatisticsScreen = '';
    this.running = true;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d: string) => {
      try { this.emit('event', { ev: 'log', level: 'stderr', text: String(d) }); } catch {}
    });
    this.proc.on('error', (err: any) => {
      this.startError = String(err?.message || err);
      this.running = false;
      try { this.emit('event', { ev: 'error', error: this.startError }); } catch {}
    });
    this.proc.on('exit', (code) => {
      this.running = false;
      this.proc = null;
      const scenarioFile = this.scenarioFile;
      this.scenarioFile = null;
      if (scenarioFile) { try { fs.unlinkSync(scenarioFile); } catch {} }
      const ctrlFileToClean = this.ctrlFile;
      this.ctrlFile = null;
      if (ctrlFileToClean) { try { fs.unlinkSync(ctrlFileToClean); } catch {} }
      try { this.emit('event', { ev: 'exit', code }); } catch {}
    });

    try { this.emit('event', { ev: 'started' }); } catch {}
    return { ok: true };
  }

  stop(): { ok: boolean } {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch {}
    }
    this.running = false;
    return { ok: true };
  }

  /** 실행 중인 테스트의 CPS 를 즉시(다음 -ctrl_file 폴링 주기, 최대 300ms 내) 바꾼다. */
  setRate(cps: number): { ok: boolean; error?: string } {
    if (!this.running || !this.ctrlFile) {
      return { ok: false, error: '실행 중인 테스트가 없습니다.' };
    }
    if (!(cps > 0)) {
      return { ok: false, error: 'CPS 는 0보다 커야 합니다.' };
    }
    try {
      fs.writeFileSync(this.ctrlFile, String(cps), 'utf8');
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  /** SIPp 의 인터랙티브 'p' 키(트래픽 일시정지/재개)와 동일한 동작을 -ctrl_file 로 수행한다. */
  setPaused(paused: boolean): { ok: boolean; error?: string } {
    if (!this.running || !this.ctrlFile) {
      return { ok: false, error: '실행 중인 테스트가 없습니다.' };
    }
    try {
      fs.writeFileSync(this.ctrlFile, paused ? 'PAUSE' : 'RESUME', 'utf8');
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  private onStdout(chunk: string) {
    this.stdoutBuf += chunk;
    // 화면 전체를 raw 로도 넘겨서 UI 에서 그대로 보여줄 수 있게 하고,
    // 동시에 통계 값을 정규식으로 뽑아 구조화된 이벤트도 올린다.
    try { this.emit('event', { ev: 'log', level: 'stdout', text: chunk }); } catch {}
    const stats = parseStats(chunk);
    if (Object.keys(stats).length > 0) {
      try { this.emit('event', { ev: 'stats', stats }); } catch {}
    }

    // "Scenario Screen"(진행 중 화면)/"Statistics Screen"(종료 시 누적 통계) 블록을
    // 뽑아서 바뀐 것만 이벤트로 올린다 — UI 는 진행 중엔 Scenario, 종료되면
    // Statistics 를 보여준다. 정규식 예외가 통계/로그 스트림까지 끊지 않도록 분리.
    let lastHeaderIndex = -1;
    try {
      const screens = extractLatestScreens(this.stdoutBuf);
      if (screens.scenario && screens.scenario !== this.lastScenarioScreen) {
        this.lastScenarioScreen = screens.scenario;
        try { this.emit('event', { ev: 'screen', kind: 'scenario', text: screens.scenario }); } catch {}
      }
      if (screens.statistics && screens.statistics !== this.lastStatisticsScreen) {
        this.lastStatisticsScreen = screens.statistics;
        try { this.emit('event', { ev: 'screen', kind: 'statistics', text: screens.statistics }); } catch {}
      }
      lastHeaderIndex = screens.lastHeaderIndex;
    } catch (e: any) {
      try { this.emit('event', { ev: 'log', level: 'stderr', text: `[sipp-screen-parse-error] ${e?.message || e}\n` }); } catch {}
    }

    // 버퍼가 과도하게 커지지 않도록(테스트가 오래 실행될 경우) 주기적으로 정리 — 단,
    // 마지막으로 찾은 화면 블록의 시작 지점보다 앞부분만 잘라내어, 진행 중인
    // 최신 블록의 헤더가 잘려서 다음 갱신 때 다시 못 찾는 일이 없게 한다.
    if (this.stdoutBuf.length > 200_000) {
      const keepFrom = lastHeaderIndex >= 0 ? Math.min(lastHeaderIndex, this.stdoutBuf.length - 50_000) : this.stdoutBuf.length - 50_000;
      this.stdoutBuf = this.stdoutBuf.slice(Math.max(0, keepFrom));
    }
  }
}

let singleton: SippSidecar | null = null;
export function getSippSidecar(): SippSidecar {
  if (!singleton) singleton = new SippSidecar();
  return singleton;
}
