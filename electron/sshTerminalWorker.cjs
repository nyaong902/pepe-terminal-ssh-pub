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

function parsePromptCwd(chunk) {
  const clean = stripAnsi(chunk);
  promptTail = (promptTail + clean).slice(-4096);
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
function handleExecRequest(reqId, command) {
  if (!conn) { parentPort.postMessage({ type: 'exec-error', reqId, error: '연결되지 않음' }); return; }
  conn.exec(command, (err, s) => {
    if (err) { parentPort.postMessage({ type: 'exec-error', reqId, error: String(err) }); return; }
    let out = '';
    s.on('data', (d) => { out += d.toString('utf8'); });
    s.on('close', () => { parentPort.postMessage({ type: 'exec-done', reqId, data: out }); });
    s.on('error', (e) => { parentPort.postMessage({ type: 'exec-error', reqId, error: String(e) }); });
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
      s.on('data', (data) => {
        let str;
        try {
          str = (encoding.toLowerCase() === 'utf-8' || encoding.toLowerCase() === 'utf8')
            ? data.toString('utf8')
            : iconv.decode(data, encoding);
        } catch (_e) {
          str = data.toString('utf8');
        }
        parentPort.postMessage({ type: 'data', data: str });
        parsePromptCwd(str);
      });
      s.stderr?.on('data', (data) => {
        parentPort.postMessage({ type: 'data', data: data.toString('utf8') });
      });
      s.on('close', () => { parentPort.postMessage({ type: 'closed' }); });
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
