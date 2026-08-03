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

  conn.on('ready', () => {
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
      // 버릴 때는 줄 경계에서 자른다 — 바이트 중간에서 자르면 UTF-8 문자나 이스케이프
      // 시퀀스가 쪼개져 화면이 깨진다.
      const LF_CH = String.fromCharCode(10);   // 소스에 원시 제어문자를 넣지 않는다
      // 방출 주기를 상황에 따라 나눈다. 프로파일에서 폭주 시 주 프로세스 비용의 상위가
      // 스레드 간 메시지 처리(worker L333 2.2~3.0%)와 그에 딸린 native/타이머 비용이었다.
      // 16ms 고정이면 초당 62개 메시지가 오가는데, 폭주 중에는 어차피 화면 한 장씩만 보내므로
      // 주기를 늘려도 보이는 차이가 없다. 반대로 대화형(타이핑 에코)에서는 지연이 그대로 체감되니
      // 짧게 유지해야 한다 — 그래서 버리기가 발동한 동안만 늘린다.
      const OUT_FLUSH_MS_IDLE = 8;      // 대화형 — 예전 16ms 보다 오히려 빠르다
      const OUT_FLUSH_MS_FLOOD = 32;    // 폭주 — 메시지 수를 1/4 로
      // 화면 한 장 분량. 2KB(약 20줄)까지 줄여 실험해봤지만 CPU 는 전혀 내려가지 않았다 —
      // 렌더러로 가는 양이 원인이 아니라는 증거다. 그래서 보여주는 양이 더 많은 6KB 로 둔다.
      // 남은 비용은 이 지점보다 앞단(ssh2 의 JS 프로토콜 처리와 초당 수천 건의 소켓 이벤트)
      // 이고, 그건 여기서 버려도 피할 수 없다. 줄이려면 데이터를 덜 받아야 한다.
      const OUT_KEEP_BYTES = 6 * 1024;
      let outChunks = [];
      let outLen = 0;
      let outDropped = false;
      let outTimer = null;
      let outFlood = false;   // 최근 flush 에서 버렸는가(= 화면이 못 따라가는 상태)

      const flushOut = () => {
        outTimer = null;
        if (outChunks.length === 0) return;
        const buf = outChunks.length === 1 ? outChunks[0] : Buffer.concat(outChunks, outLen);
        const dropped = outDropped;
        outChunks = []; outLen = 0; outDropped = false;
        outFlood = dropped;   // 버릴 게 없어지면 즉시 대화형 주기로 복귀
        let str;
        try {
          str = (encoding.toLowerCase() === 'utf-8' || encoding.toLowerCase() === 'utf8')
            ? buf.toString('utf8')
            : iconv.decode(buf, encoding);
        } catch (_e) {
          str = buf.toString('utf8');
        }
        // 앞부분을 버렸다면 첫 줄은 잘려 있을 수 있으니 줄 경계까지 더 버린다.
        if (dropped) {
          const i = str.indexOf(LF_CH);
          if (i !== -1) str = str.slice(i + 1);
        }
        if (!str) return;
        parentPort.postMessage({ type: 'data', data: str });
        parsePromptCwd(str);
      };

      const pushOut = (data) => {
        // 조각 하나가 이미 유지 분량을 넘는 경우를 반드시 따로 처리해야 한다. ssh2 는 채널 패킷을
        // 최대 32KB 로 주므로 이런 일이 흔한데, 예전 구현은 "조각이 2개 이상일 때만 버린다"는
        // 조건 때문에 32KB 조각을 통째로 올려보냈다 — 상한이 사실상 무력화돼 의도한 375KB/s 대신
        // 약 2MB/s 를 렌더러로 보내고 있었다. OUT_KEEP_BYTES 를 6KB/2KB 로 바꿔도 CPU 가 변하지
        // 않았던 이유가 이것이다.
        if (data.length >= OUT_KEEP_BYTES) {
          outChunks = [data.subarray(data.length - OUT_KEEP_BYTES)];
          outLen = OUT_KEEP_BYTES;
          outDropped = true;
        } else {
          outChunks.push(data);
          outLen += data.length;
          // 오래된 조각부터 버린다(조각 단위라 복사 없음).
          while (outLen > OUT_KEEP_BYTES && outChunks.length > 1) {
            outLen -= outChunks.shift().length;
            outDropped = true;
          }
          // 조각 단위로 버려도 남으면 맨 앞 조각 자체를 잘라 상한을 반드시 지킨다.
          if (outLen > OUT_KEEP_BYTES) {
            const cut = outLen - OUT_KEEP_BYTES;
            outChunks[0] = outChunks[0].subarray(cut);
            outLen -= cut;
            outDropped = true;
          }
        }
        if (!outTimer) outTimer = setTimeout(flushOut, outFlood ? OUT_FLUSH_MS_FLOOD : OUT_FLUSH_MS_IDLE);
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
    parentPort.postMessage({ type: 'error', error: String(err && err.message || err) });
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
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      };
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
