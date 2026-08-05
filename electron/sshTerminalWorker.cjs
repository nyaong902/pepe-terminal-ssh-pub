'use strict';
// 인터랙티브 터미널 SSH 채널 전용 Worker Thread — "단순 연결"(점프 호스트 없음,
// 로그인 스크립트 없음 — X11 은 지원)만 지원한다. 이 worker 안에서 ssh2 Client 를 직접
// 소유하기 때문에, SSH2 프로토콜 자체의 암호화 해제(cipher decrypt)가 메인 프로세스가
// 아니라 여기서 일어난다 — 실측 CPU 프로파일에서 이 작업이 메인 프로세스 self-time 의
// 상당 부분(~20%+)을 차지하는 것으로 확인됐고, 세션 여러 개를 동시에 heavy 하게 쓸 때
// (예: tail -F 두 개) 메인 프로세스 하나가 병목이 되어 다른 세션/IPC 라우팅까지 버벅이게
// 만드는 원인이었다.
//
// sshBridge.ts 는 이 worker 가 보내는 메시지를 기존 conn/stream 이벤트와 동일한 모양으로
// 받아서 그대로 termBroadcast 등 기존 파이프라인에 흘려보낸다 — 그래서 렌더러/IPC 쪽은
// 이 세션이 worker 로 처리되는지 전혀 몰라도 된다.
const { workerData, parentPort } = require('worker_threads');
const NUL_CH = String.fromCharCode(0);   // 유휴 문자열 기본값 — 화면에 흔적을 남기지 않는다

// 끊김 진단과 유휴 판단에 쓰는 시각들. 워커 하나가 연결 하나를 담당하므로 모듈 스코프에 둔다
// (헬퍼 함수들이 참조해야 하는데 connectSimple 의 지역 변수면 닿지 않는다).
let readyAt = 0;
let lastInboundAt = 0;
let lastOutboundAt = 0;

// 연결 유지 설정을 ssh2 옵션으로 바꾼다. 미설정 세션은 XShell 기본값(60초)과 같게 동작한다.
// keepaliveCountMax 3 이므로 허용 시간은 간격의 3배다(60초 -> 180초). 예전에는 10초여서 30초만
// 응답이 없으면 끊었는데, 출력이 폭주하거나 서버가 잠깐 바쁠 때 성급하게 끊는 원인이었다.
// 원격 셸에 주기적으로 입력을 보낸다(XShell 의 "네트워크가 유휴 상태일 때 문자열을 보냄").
// SSH 수준 keepalive 로는 서버의 TMOUT(셸 자동 로그아웃)을 막을 수 없다 — bash 는 자기가 읽은
// 입력만 세기 때문이다. 그래서 실제 입력을 보내야 하는데, 화면에 흔적을 남기지 않으려고 기본값은
// NUL 문자를 쓴다. 셸은 이를 읽고 유휴 타이머를 리셋하지만 아무것도 출력하지 않는다.
// 마지막으로 주고받은 시점에서 간격이 지났을 때만 보낸다(= 유휴 상태일 때만).
function startIdleStringSender(session, stream) {
  if (!session || !session.keepAliveSendString) return;
  const sec = Number(session.keepAliveStringIntervalSec);
  if (!Number.isFinite(sec) || sec <= 0) return;
  const payload = session.keepAliveString ? String(session.keepAliveString) : NUL_CH;
  const timer = setInterval(() => {
    try {
      if (!stream || stream.destroyed) { clearInterval(timer); return; }
      const idleMs = Date.now() - Math.max(lastInboundAt || 0, lastOutboundAt || 0);
      if (idleMs < sec * 1000) return;
      stream.write(payload);
      lastOutboundAt = Date.now();
    } catch (_e) { clearInterval(timer); }
  }, Math.max(1000, Math.round(sec * 1000 / 2)));
  try { stream.on('close', () => clearInterval(timer)); } catch (_e) {}
}

// TCP 수준 keepalive. 중간 장비가 SSH 트래픽이 아니라 TCP 만 보고 세션을 정리할 때 쓸모가 있다.
// ssh2 는 소켓을 내부에 두므로 비공개 필드로 접근한다 — 실패하면 조용히 넘어간다.
function applyTcpKeepAlive(conn, session) {
  if (!session || !session.keepAliveTcp) return;
  try {
    const sock = conn._sock || (conn._protocol && conn._protocol._sock);
    if (sock && typeof sock.setKeepAlive === 'function') sock.setKeepAlive(true, 30000);
  } catch (_e) {}
}

function keepAliveCfg(session) {
  const on = session.keepAliveEnabled !== false;
  const sec = Number(session.keepAliveIntervalSec);
  // 0 도 유효한 값이다 — 사용자가 간격을 0 으로 두면 keepalive 를 보내지 않는다(ssh2 는 0 이면 끔).
  // 값이 비었거나 숫자가 아닐 때만 기본 60초를 쓴다.
  const interval = on ? (Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : 60000) : 0;
  return { keepaliveInterval: interval, keepaliveCountMax: 3 };
}
const { Client } = require('ssh2');
const iconv = require('iconv-lite');
const net = require('net');

// 로컬 X 서버로 X11 채널 forward — sshBridge.ts 의 setupX11Forwarding 과 동일 로직.
// 로컬 X 서버 자체(VcXsrv/내장) 는 메인 프로세스가 이미 띄워두고 확정된 displayNum 만 여기로 전달.
function setupX11Forwarding(conn, displayNum) {
  conn.on('x11', (_info, accept) => {
    const xstream = accept();
    const port = 6000 + displayNum;
    const xclient = net.connect(port, '127.0.0.1', () => { xstream.pipe(xclient).pipe(xstream); });
    xclient.on('error', (err) => {
      try { xstream.end(); } catch (_e) {}
      parentPort.postMessage({ type: 'log', data: `X11: 로컬 X 서버 연결 실패 (localhost:${port}). ${err.message}` });
    });
    xstream.on('error', () => { try { xclient.end(); } catch (_e) {} });
    xstream.on('close', () => { try { xclient.end(); } catch (_e) {} });
  });
}

let conn = null;
let stream = null;
let encoding = 'utf-8';

// ── pwd 프롬프트 파싱 (기존 sshBridge.ts _parsePromptCwd/_detectAndApplyPromptCwd 이식) ──
// 이 worker 로 옮긴 핵심 이유 중 하나 — 이 정규식 스캔 자체도 heavy 스트림에서 비용이 컸음.
let promptTail = '';
let autoTrackOn = false;
let promptCwdDebounceTimer = null;
let promptCwdActive = false;
let homeDir = null;
let homeFetching = false;
let ccViewRoot = null;

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}

// 프롬프트는 버퍼 끝에서만 찾으므로(promptTail 은 4096자만 유지) 청크 전체를 훑을 필요가 없다.
// 프로파일에서 이 함수가 주 프로세스 JS 자기시간 1위였다(2.9%) — 로그 폭주 시 청크마다
// ANSI 제거 정규식 두 개를 청크 전체에 돌리고 있었다.
//  (1) 스캔 범위를 끝 8192자로 제한한다(ANSI 제거로 짧아지는 것까지 감안한 여유값).
//  (2) ESC 가 아예 없으면 정규식을 건너뛴다 — 일반 로그 출력이 대부분 이 경로다.
const PROMPT_TAIL_MAX = 4096;                  // 프롬프트 탐지에 유지하는 꼬리 길이
const ESC = String.fromCharCode(27);
function parsePromptCwd(chunk) {
  const src = chunk.length > PROMPT_TAIL_MAX ? chunk.slice(-PROMPT_TAIL_MAX) : chunk;
  const clean = src.indexOf(ESC) === -1 ? src : stripAnsi(src);
  // 꼬리가 이미 찼으면 이전 버퍼와 연결하지 않는다 — 결과가 어차피 clean 의 꼬리다.
  if (clean.length >= PROMPT_TAIL_MAX) {
    promptTail = clean.length === PROMPT_TAIL_MAX ? clean : clean.slice(-PROMPT_TAIL_MAX);
  } else {
    const merged = promptTail + clean;
    promptTail = merged.length > PROMPT_TAIL_MAX ? merged.slice(-PROMPT_TAIL_MAX) : merged;
  }
  if (!autoTrackOn) return;
  if (promptCwdDebounceTimer) clearTimeout(promptCwdDebounceTimer);
  promptCwdDebounceTimer = setTimeout(() => {
    promptCwdDebounceTimer = null;
    detectAndApplyPromptCwd();
  }, 80);
}

function detectAndApplyPromptCwd() {
  const buf = promptTail;
  if (!buf) return;
  const re = /@[A-Za-z0-9_.\-]+(?:\(([A-Za-z0-9_.\-]+)\))?:(~?\/[^\s\]>$#)]*|~)\s*[\]$#>]/g;
  let m;
  let lastViewTag = '';
  let lastPath = '';
  while ((m = re.exec(buf)) !== null) {
    lastViewTag = m[1] || lastViewTag;
    lastPath = m[2];
  }
  if (!lastPath) return;
  if (lastViewTag) {
    const newRoot = `/view/${lastViewTag}`;
    if (ccViewRoot !== newRoot) { ccViewRoot = newRoot; }
  }
  let p = lastPath;
  if (p === '~' || p.startsWith('~/')) {
    if (!homeDir) { fetchHomeDir(); return; }
    p = p === '~' ? homeDir : homeDir.replace(/\/$/, '') + p.slice(1);
  }
  if (p.startsWith('/')) {
    promptCwdActive = true;
    parentPort.postMessage({ type: 'pwd', data: p });
  }
}

function fetchHomeDir() {
  if (homeDir || homeFetching || !conn) return;
  homeFetching = true;
  conn.exec('printf %s "$HOME"', (err, s) => {
    if (err) { homeFetching = false; return; }
    let out = '';
    s.on('data', (d) => { out += d.toString('utf8'); });
    s.on('close', () => {
      homeFetching = false;
      const h = out.trim();
      if (h.startsWith('/')) homeDir = h;
    });
    s.on('error', () => { homeFetching = false; });
  });
}

// ── exec RPC (메인의 execCommand/getShellCwd 등이 conn.exec() 을 이 worker 로 위임) ──
// panelId 별 sshBridge.ts 의 _handleExecInner 와 동일한 목적의 pty:false 채널 — 원격 셸이
// 접속 시 "계속하려면 Enter" 류의 확인 프롬프트로 stdin 을 기다리면 명령이 시작도 못 하고
// 영원히 멈춘다(실제 pty 있는 터미널에서는 같은 명령이 바로 됨). 채널을 열자마자 개행 1개를
// 보내고 곧바로 EOF 로 닫아 그런 프롬프트를 통과시킨다 — stdin 을 안 쓰는 일반 명령엔 영향 없음.
// 또한 이 worker 쪽엔 기존에 타임아웃이 전혀 없어, 메인 프로세스가 먼저 포기해도 여기 stream 은
// 계속 열려 원격 프로세스가 안 끝나면 계속 남아있었다 — 여기서도 타임아웃 + kill 을 건다.
const EXEC_TIMEOUT_MS = 55000; // 메인 쪽 handleExec 기본 타임아웃(60s)보다 짧게 — 여기서 먼저 정리.
function handleExecRequest(reqId, command) {
  if (!conn) { parentPort.postMessage({ type: 'exec-error', reqId, error: '연결되지 않음' }); return; }
  let settled = false;
  let liveStream = null;
  const to = setTimeout(() => {
    if (settled) return;
    settled = true;
    // signal('KILL') 은 서버/프록시 지원이 들쭉날쭉해 잘못 처리되면 이 채널뿐 아니라 conn 을
    // 공유하는 인터랙티브 셸 채널까지 먹통이 될 수 있다(실제로 겪음) — close() 만 보낸다.
    try { liveStream?.close?.(); } catch (_e) {}
    parentPort.postMessage({ type: 'exec-error', reqId, error: 'exec timeout (worker)' });
  }, EXEC_TIMEOUT_MS);
  conn.exec(command, { pty: false }, (err, s) => {
    if (err) { if (!settled) { settled = true; clearTimeout(to); parentPort.postMessage({ type: 'exec-error', reqId, error: String(err) }); } return; }
    liveStream = s;
    try { s.write('\n'); s.end(); } catch (_e) {}
    let out = '';
    s.on('data', (d) => { out += d.toString('utf8'); });
    s.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      parentPort.postMessage({ type: 'exec-done', reqId, data: out });
    });
    s.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      parentPort.postMessage({ type: 'exec-error', reqId, error: String(e) });
    });
  });
}

// ── SFTP RPC (제네릭 프록시) — createReadStream/createWriteStream 등 스트림 반환형은 지원 안 함(v1 한계).
// 파일탐색기 목록조회(readdir)/stat/rename/unlink/mkdir 등 콜백형 API 만 지원 — 실제 대용량 전송은
// 이미 별도 sftpTransferWorker 경로를 우선 사용하므로 이 worker 에서 다룰 필요가 없음.
let sftp = null;
function ensureSftp(cb) {
  if (sftp) return cb(null, sftp);
  if (!conn) return cb(new Error('연결되지 않음'));
  conn.sftp((err, s) => {
    if (err) return cb(err);
    sftp = s;
    s.on('close', () => { sftp = null; });
    s.on('end', () => { sftp = null; });
    cb(null, s);
  });
}
// ssh2 의 Stats(attrs) 는 isDirectory()/isSymbolicLink()/isFile() 같은 "메서드"를 가진 클래스
// 인스턴스라, worker_threads 의 postMessage(구조적 복제)로 그대로 넘기면
// "DataCloneError: function () { [native code] } could not be cloned" 로 죽는다 — 메서드 결과를
// 같은 이름의 평범한 boolean 필드로 미리 계산해 넣어준다(수신측 sshBridge.ts 는 두 형태 다 처리).
function sanitizeForClone(value) {
  if (Array.isArray(value)) return value.map(sanitizeForClone);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = sanitizeForClone(value[key]);
    if (typeof value.isDirectory === 'function') out.isDirectory = value.isDirectory();
    if (typeof value.isSymbolicLink === 'function') out.isSymbolicLink = value.isSymbolicLink();
    if (typeof value.isFile === 'function') out.isFile = value.isFile();
    return out;
  }
  return value;
}
function handleSftpCall(reqId, method, args) {
  ensureSftp((err, s) => {
    if (err) { parentPort.postMessage({ type: 'sftp-reply', reqId, error: String(err) }); return; }
    if (typeof s[method] !== 'function') {
      parentPort.postMessage({ type: 'sftp-reply', reqId, error: `unsupported sftp method in worker mode: ${method}` });
      return;
    }
    // postMessage 구조적 복제를 거치며 Buffer 인자(예: writeFile 의 content)가 평범한
    // Uint8Array 로 바뀐다 — ssh2 내부가 Buffer 전용 동작(slice 등)을 기대하므로 여기서 복원.
    args = args.map(a => (a instanceof Uint8Array && !Buffer.isBuffer(a)) ? Buffer.from(a) : a);
    try {
      s[method](...args, (cbErr, result) => {
        parentPort.postMessage({ type: 'sftp-reply', reqId, error: cbErr ? String(cbErr) : undefined, result: sanitizeForClone(result) });
      });
    } catch (e) {
      parentPort.postMessage({ type: 'sftp-reply', reqId, error: String(e) });
    }
  });
}

function connectSimple(session, cols, rows, x11Display) {
  conn = new Client();
  encoding = session.encoding || 'utf-8';

  parentPort.postMessage({ type: 'log', data: `▶ ${session.host}:${session.port || 22} (${session.username}) 연결 중...` });

  conn.on('handshake', () => parentPort.postMessage({ type: 'log-inline', data: '  [handshake OK] ' }));
  conn.on('banner', () => parentPort.postMessage({ type: 'log-inline', data: '[banner] ' }));

  const x11Enabled = typeof x11Display === 'number';
  if (x11Enabled) setupX11Forwarding(conn, x11Display);

  // 끊김 진단용 — 연결이 얼마나 유지됐는지 사유와 함께 남긴다. "2시간쯤 뒤에 끊긴다" 는
  // 증상이 정확히 몇 초인지(방화벽/VPN 의 고정 수명이면 7200초처럼 일정하다), 그리고 끊기기
  // 직전까지 keepalive 응답이 오고 있었는지를 구분하기 위한 것이다.
  readyAt = 0;
  lastInboundAt = 0;
  lastOutboundAt = 0;
  const upFor = () => {
    if (!readyAt) return 'not-connected';
    const sec = Math.round((Date.now() - readyAt) / 1000);
    const quiet = lastInboundAt ? Math.round((Date.now() - lastInboundAt) / 1000) : -1;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ${sec % 60}s (${sec}초)`
      + (quiet >= 0 ? `, 마지막 수신 ${quiet}초 전` : '');
  };

  conn.on('ready', () => {
    readyAt = Date.now();
    applyTcpKeepAlive(conn, cfg.__session);
    // 일반(non-worker) 경로의 logInline('92', '[SSH 연결 완료]\r\n') 과 동일 — 이 줄바꿈이
    // 없으면 handshake/banner 인라인 메시지 바로 뒤에 첫 셸 프롬프트가 같은 줄에 붙어버림.
    parentPort.postMessage({ type: 'log-inline-green', data: '[SSH 연결 완료]\r\n' });
    parentPort.postMessage({ type: 'connected' });
    const shellOpts = { cols: cols || 120, rows: rows || 24, term: 'xterm-256color' };
    if (x11Enabled) {
      const cookie = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      shellOpts.x11 = { single: false, screen: x11Display, protocol: 'MIT-MAGIC-COOKIE-1', cookie };
    }
    conn.shell(shellOpts, (err, s) => {
      if (err) {
        parentPort.postMessage({ type: 'error', error: String(err) });
        try { conn.end(); } catch (_e) {}
        return;
      }
      stream = s;
      startIdleStringSender(session, s);
      // ── 화면이 따라갈 수 없는 분량은 여기서 버린다 ────────────────────────────
      // 실측: 이 로그는 초당 5.7MB / 71,000 줄이 온다. 화면은 초당 500줄쯤 보여주므로
      // 터미널은 142배 뒤처져 있었고, 그 전량을 디코딩 -> postMessage -> IPC -> xterm 파싱까지
      // 처리한 뒤 화면 밖으로 흘려보내고 있었다. 그게 CPU 였다(주 프로세스는 그 구조적 복제로
      // 생긴 ArrayBuffer GC 에 9%, 렌더러는 파싱·레이아웃에).
      //
      // 그래서 가장 이른 지점에서 버린다. 한 프레임에 화면 한 장(약 60줄)보다 많이 보내는 것은
      // 어차피 낭비이므로, 16ms 마다 최신 KEEP 바이트만 올려보낸다. 디코딩도 남긴 만큼만 한다
      // (예전에는 버릴 것까지 전부 문자열로 만들었다).
      //
      // 출력은 모아서 보내고(메시지 수 감소), 폭주 시에는 "버려도 화면이 어긋나지 않는 경우에만"
      // 앞부분을 버린다.
      //
      // 왜 조건부인가 — 2.3.6 에서 조건 없이 버렸다가 vi 화면이 직전 내용과 겹쳐 보였다.
      // 터미널 스트림은 상태가 있다: 화면 지우기·커서 이동·대체 화면 전환 같은 제어 시퀀스가
      // 앞부분에 있으면 그것을 버리는 순간 화면이 어긋난다. vi 는 화면 전체를 그리는 출력이
      // 6KB 를 넘기 때문에 그 앞부분(대체 화면 전환 + 화면 지우기)이 통째로 사라졌다.
      // 반대로 tail -f 같은 순수 로그 폭주는 줄이 아래로 흐를 뿐이라, 지나간 줄을 버리는 것이
      // 스크롤백을 넘겨버리는 것과 다르지 않다 — 그때만 버린다.
      //
      // 버리기를 아예 없애면 CPU 가 다시 10% 이상으로 올라간다(실측). 초당 2MB 를 xterm 이 전부
      // 파싱해야 하기 때문이다. 그래서 "안전할 때만 버린다" 가 두 요구를 모두 만족하는 지점이다.
      const OUT_FLUSH_MS_IDLE = 8;      // 대화형(타이핑 에코) — 짧게 유지해야 지연이 안 느껴진다
      const OUT_FLUSH_MS_FLOOD = 32;    // 폭주 — 메시지 수를 1/4 로
      const OUT_KEEP_BYTES = 6 * 1024;  // 폭주 시 남기는 분량(화면 한 장 정도)
      let outChunks = [];
      let outLen = 0;
      let outTimer = null;
      let outFlood = false;   // 최근 flush 에서 버렸는가(= 화면이 못 따라가는 상태)
      // 멀티바이트 문자가 flush 경계에 걸쳐 쪼개지면 깨져 보인다 — 마지막 불완전한 UTF-8 조각은
      // 다음 flush 로 넘긴다(UTF-8 일 때만. 다른 인코딩은 iconv 에 그대로 맡긴다).
      let outCarry = null;

      const isUtf8 = (encoding.toLowerCase() === 'utf-8' || encoding.toLowerCase() === 'utf8');
      const ESC = 0x1b, LF = 0x0a;

      // buf 끝에서 "아직 완성되지 않은 UTF-8 시퀀스" 의 시작 위치. 없으면 buf.length.
      const utf8SplitPoint = (buf) => {
        const max = Math.min(4, buf.length);
        for (let back = 1; back <= max; back++) {
          const b = buf[buf.length - back];
          if ((b & 0x80) === 0) return buf.length;                 // ASCII — 경계가 깔끔하다
          if ((b & 0xc0) === 0x80) continue;                       // 뒤따르는 바이트 — 더 앞을 본다
          const need = (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
          return back >= need ? buf.length : buf.length - back;     // 모자라면 그 앞에서 끊는다
        }
        return buf.length;
      };

      // 이 구간을 버려도 화면 상태가 어긋나지 않는가?
      //
      // 버리면 안 되는 것: 화면을 지우거나(J), 커서를 특정 위치로 보내거나(H/f/A/B/C/D/E/F/G/d),
      // 커서를 저장·복원하거나(ESC 7/8), 스크롤 영역을 바꾸거나(r), 대체 화면으로 전환하는(?1049/?47)
      // 시퀀스. 이런 것이 하나라도 있으면 전체화면 프로그램(vi/top/less)이 그리는 중이라는 뜻이다.
      // 색상(SGR, ...m)과 커서 표시(?25) 는 버려도 화면 배치가 어긋나지 않는다 — 대신 버린 뒤
      // ESC[0m 을 앞에 붙여 남은 속성이 새 출력에 번지지 않게 한다.
      const dropIsSafe = (buf, end) => {
        for (let i = 0; i < end; i++) {
          if (buf[i] !== ESC) continue;
          const c1 = buf[i + 1];
          if (c1 === 0x37 || c1 === 0x38) return false;            // ESC 7 / ESC 8 — 커서 저장/복원
          if (c1 === 0x4d || c1 === 0x44 || c1 === 0x45) return false; // ESC M / D / E — 줄 스크롤
          if (c1 !== 0x5b) continue;                               // CSI 가 아니면 신경 쓰지 않는다
          // CSI 파라미터를 지나 최종 바이트를 찾는다.
          let j = i + 2;
          let question = false;
          while (j < end) {
            const b = buf[j];
            if (b === 0x3f) { question = true; j++; continue; }     // '?' — private mode
            if ((b >= 0x30 && b <= 0x39) || b === 0x3b) { j++; continue; }  // 숫자 / ';'
            break;
          }
          if (j >= end) return false;                              // 시퀀스가 이 구간에서 잘렸다 — 위험
          const fin = buf[j];
          if (question) {
            // ?1049 / ?47 (대체 화면) 은 위험. ?25(커서 표시) 등은 무해.
            const param = buf.toString('latin1', i + 3, j);
            if (param === '1049' || param === '47' || param === '1047' || param === '1048') return false;
          } else if (
            fin === 0x48 || fin === 0x66 ||                        // H, f — 커서 위치 지정
            fin === 0x41 || fin === 0x42 || fin === 0x43 || fin === 0x44 ||  // A,B,C,D — 커서 이동
            fin === 0x45 || fin === 0x46 || fin === 0x47 || fin === 0x64 ||  // E,F,G,d — 커서 이동
            fin === 0x4a ||                                        // J — 화면 지우기
            fin === 0x72 ||                                        // r — 스크롤 영역
            fin === 0x4c || fin === 0x4d || fin === 0x53 || fin === 0x54     // L,M,S,T — 줄 삽입/삭제·스크롤
          ) return false;
          i = j;
        }
        return true;
      };

      const flushOut = () => {
        outTimer = null;
        if (outChunks.length === 0 && !outCarry) return;
        if (outCarry) { outChunks.unshift(outCarry); outLen += outCarry.length; outCarry = null; }
        let buf = outChunks.length === 1 ? outChunks[0] : Buffer.concat(outChunks, outLen);
        outChunks = []; outLen = 0;
        if (isUtf8) {
          const cut = utf8SplitPoint(buf);
          if (cut < buf.length) { outCarry = buf.subarray(cut); buf = buf.subarray(0, cut); }
        }
        if (buf.length === 0) return;

        let dropped = false;
        if (buf.length > OUT_KEEP_BYTES) {
          // 줄 경계에서 자른다 — 바이트 중간에서 자르면 UTF-8 문자나 이스케이프 시퀀스가 쪼개진다.
          let cut = buf.length - OUT_KEEP_BYTES;
          const nlAt = buf.indexOf(LF, cut);
          cut = nlAt === -1 ? -1 : nlAt + 1;
          if (cut > 0 && dropIsSafe(buf, cut)) {
            buf = Buffer.concat([Buffer.from('\x1b[0m'), buf.subarray(cut)]);
            dropped = true;
          }
          // 안전하지 않으면(전체화면 프로그램이 그리는 중) 전부 보낸다 — 화면 정확성이 우선이다.
        }
        outFlood = dropped;   // 버릴 게 없어지면 즉시 대화형 주기로 복귀

        let str;
        try {
          str = isUtf8 ? buf.toString('utf8') : iconv.decode(buf, encoding);
        } catch (_e) {
          str = buf.toString('utf8');
        }
        if (!str) return;
        parentPort.postMessage({ type: 'data', data: str });
        parsePromptCwd(str);
      };

      const pushOut = (data) => {
        lastInboundAt = Date.now();   // 끊김 진단용 — 마지막으로 서버에서 뭔가 온 시점
        outChunks.push(data);
        outLen += data.length;
        if (!outTimer) {
          outTimer = setTimeout(flushOut, outFlood ? OUT_FLUSH_MS_FLOOD : OUT_FLUSH_MS_IDLE);
        }
      };

      s.on('data', pushOut);
      s.stderr?.on('data', pushOut);   // 같은 버퍼로 순서 보존
      s.on('close', () => {
        // 배치 잔여분을 먼저 흘린다 — 안 하면 마지막 8ms 분량이 사라진다.
        if (outTimer) { clearTimeout(outTimer); outTimer = null; }
        flushOut();
        parentPort.postMessage({ type: 'closed' });
      });
      s.on('error', (e) => { parentPort.postMessage({ type: 'log', data: `stream error: ${e?.message || e}` }); });
    });
  });

  conn.on('error', (err) => {
    const msg = String(err && err.message || err);
    parentPort.postMessage({ type: 'log', data: `[ssh-drop] error=${msg} | 유지 ${upFor()}` });
    parentPort.postMessage({ type: 'error', error: msg });
  });

  // 연결이 닫히면 사유 없이도 유지 시간을 남긴다(error 없이 close 만 오는 경우가 있다).
  // 연결이 닫히면 반드시 closed 를 올려보낸다. 예전에는 셸 스트림의 close 에서만 보냈는데,
  // TCP 가 리셋되면(read ECONNRESET) 그 스트림 close 가 오지 않거나 늦어서 렌더러가 끊김을
  // 모른 채 남아 있었다. 그래서 자동 재접속 카운트다운이 시작되지 않고, 사용자가 다른 탭을
  // 갔다 와야(= 재마운트 시 연결 상태를 다시 확인) 비로소 재연결됐다.
  // 같은 세션에서 stream close 와 겹쳐 두 번 올 수 있는데, 렌더러 핸들러가 중복을 무시한다.
  conn.on('close', () => {
    parentPort.postMessage({ type: 'log', data: `[ssh-drop] close | 유지 ${upFor()}` });
    parentPort.postMessage({ type: 'closed' });
  });

  conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
    if (cfgPassword) {
      finish([cfgPassword]);
    } else {
      pendingAuthFinish = finish;
      parentPort.postMessage({ type: 'auth-prompt', prompts: prompts.map((p) => p.prompt) });
    }
  });

  conn.connect(cfg);
}

let cfg;
let cfgPassword;
let pendingAuthFinish = null;

parentPort.on('message', (msg) => {
  switch (msg.type) {
    // 흐름 제어 — main 의 대기 버퍼가 상한을 넘으면 pause 를 보낸다. ssh2 채널 스트림을
    // 멈추면 SSH 윈도가 차고 서버 쪽 tail 이 write 에서 막혀 출력 속도가 떨어진다.
    // 표시 속도만 제한하면 백로그가 무한히 쌓여 Ctrl+C 도 안 먹고 CPU 도 오른다.
    case 'flow':
      try { if (stream) { if (msg.pause) stream.pause(); else stream.resume(); } } catch (_e) {}
      break;
    case 'connect': {
      const session = msg.session;
      autoTrackOn = !!msg.autoTrack;
      cfg = {
        host: session.host,
        port: session.port || 22,
        username: session.username,
        tryKeyboard: true,
        readyTimeout: 15000,
        // 연결 유지 — 세션 설정을 따른다(기본은 XShell 기본값과 같은 60초).
        // 자세한 배경은 sessionsStore.ts 의 Session.keepAlive* 주석 참고.
        ...keepAliveCfg(session),
      };
      cfg.__session = session;   // ready 시점에 TCP keepalive 를 적용하려면 세션 설정이 필요하다
      if (session.auth && session.auth.type === 'password' && session.auth.password) {
        cfg.password = session.auth.password;
        cfgPassword = session.auth.password;
      } else if (session.auth && session.auth.type === 'key') {
        try { cfg.privateKey = require('fs').readFileSync(session.auth.keyPath); } catch (_e) {}
      }
      try {
        const c = require('ssh2/lib/protocol/constants');
        cfg.algorithms = { kex: c.SUPPORTED_KEX, serverHostKey: c.SUPPORTED_SERVER_HOST_KEY, cipher: c.SUPPORTED_CIPHER, hmac: c.SUPPORTED_MAC };
      } catch (_e) {}
      connectSimple(session, msg.cols, msg.rows, msg.x11Display);
      break;
    }
    case 'auth-response': {
      if (pendingAuthFinish) { const f = pendingAuthFinish; pendingAuthFinish = null; f(msg.responses || []); }
      break;
    }
    case 'input': {
      if (stream) { try { stream.write(Buffer.from(msg.dataB64, 'base64')); } catch (_e) {} }
      break;
    }
    case 'set-encoding': {
      encoding = msg.encoding || 'utf-8';
      break;
    }
    case 'resize': {
      if (stream) { try { stream.setWindow(msg.rows, msg.cols, msg.rows, msg.cols); } catch (_e) {} }
      break;
    }
    case 'disconnect': {
      try { if (conn) conn.end(); } catch (_e) {}
      break;
    }
    case 'exec': {
      handleExecRequest(msg.reqId, msg.command);
      break;
    }
    case 'sftp-call': {
      handleSftpCall(msg.reqId, msg.method, msg.args);
      break;
    }
    case 'set-autotrack': {
      autoTrackOn = !!msg.enabled;
      if (autoTrackOn) detectAndApplyPromptCwd();
      break;
    }
    case 'shutdown': {
      try { if (conn) conn.end(); } catch (_e) {}
      process.exit(0);
      break;
    }
    default:
      break;
  }
});

void workerData; // 세션은 'connect' 메시지로 받으므로 workerData 는 현재 미사용(placeholder).
