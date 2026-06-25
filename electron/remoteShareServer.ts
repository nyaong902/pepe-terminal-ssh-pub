import { BrowserWindow, type InputEvent } from 'electron';
import http, { IncomingMessage, ServerResponse } from 'http';
import os from 'os';

export type RemoteShareState = {
  running: boolean;
  address: string;
  pin: string;
  port: number;
  clients: number;
  error?: string;
};

type RemoteInput =
  | { type: 'pointer'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
  | { type: 'wheel'; x: number; y: number; deltaX?: number; deltaY?: number }
  | { type: 'key'; action: 'down' | 'up'; key: string; modifiers?: string[] }
  | { type: 'text'; text: string };

type InputModifier = NonNullable<InputEvent['modifiers']>[number];

const DEFAULT_PORT = 17800;
const MAX_REQUEST_BYTES = 16 * 1024;
const FRAME_INTERVAL_MS = 160;

function isTailscaleIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  return parts.length === 4
    && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && parts[0] === 100
    && parts[1] >= 64
    && parts[1] <= 127;
}

function findTailscaleIpv4(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && isTailscaleIpv4(entry.address)) {
        return entry.address;
      }
    }
  }
  return null;
}

function makePin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function htmlPage(): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>PePe Remote Share</title>
  <style>
    :root { color-scheme: dark; font-family: "Malgun Gothic", sans-serif; background:#071018; color:#e9f3f7; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:radial-gradient(circle at top,#17384a 0,#071018 52%); }
    #login { width:min(92vw,380px); padding:28px; border:1px solid #315568; border-radius:18px; background:#0d1c26e8; box-shadow:0 22px 70px #0009; }
    h1 { margin:0 0 8px; font-size:23px; }
    p { color:#9fb8c5; line-height:1.55; }
    input,button { width:100%; height:46px; border-radius:10px; border:1px solid #3d6274; font:inherit; }
    input { padding:0 14px; background:#07131b; color:white; letter-spacing:5px; text-align:center; font-size:20px; }
    button { margin-top:12px; background:#2c85a7; color:white; border:0; font-weight:700; cursor:pointer; }
    #error { min-height:22px; color:#ff9d91; font-size:13px; margin-top:10px; }
    #viewer { display:none; position:fixed; inset:0; overflow:hidden; background:#020608; touch-action:none; }
    #screen { width:100%; height:100%; object-fit:contain; display:block; user-select:none; -webkit-user-drag:none; }
    #bar { position:fixed; top:10px; left:50%; transform:translateX(-50%); display:flex; gap:8px; align-items:center; padding:7px 10px; border-radius:999px; background:#061119d9; border:1px solid #365767; font-size:12px; opacity:.82; }
    #keyboard { position:fixed; left:-9999px; top:0; opacity:0; }
  </style>
</head>
<body>
  <main id="login">
    <h1>PePe 원격 공유</h1>
    <p>PePe 화면에 표시된 6자리 PIN을 입력하세요.</p>
    <input id="pin" inputmode="numeric" maxlength="6" autocomplete="one-time-code" autofocus>
    <button id="connect">연결</button>
    <div id="error"></div>
  </main>
  <main id="viewer">
    <img id="screen" alt="PePe 화면">
    <div id="bar"><span>PePe Remote</span><span>화면을 터치하거나 클릭해 제어</span></div>
    <textarea id="keyboard" autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
  </main>
<script>
(() => {
  const login = document.querySelector('#login');
  const viewer = document.querySelector('#viewer');
  const pinInput = document.querySelector('#pin');
  const error = document.querySelector('#error');
  const screen = document.querySelector('#screen');
  const keyboard = document.querySelector('#keyboard');
  let pin = '';
  let lastMove = 0;

  async function send(payload) {
    if (!pin) return;
    try {
      await fetch('/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pepe-pin': pin },
        body: JSON.stringify(payload),
        cache: 'no-store'
      });
    } catch {}
  }

  function normalized(ev) {
    const r = screen.getBoundingClientRect();
    const naturalRatio = (screen.naturalWidth || r.width) / (screen.naturalHeight || r.height);
    const boxRatio = r.width / r.height;
    let width = r.width, height = r.height, left = r.left, top = r.top;
    if (boxRatio > naturalRatio) {
      width = r.height * naturalRatio;
      left += (r.width - width) / 2;
    } else {
      height = r.width / naturalRatio;
      top += (r.height - height) / 2;
    }
    return {
      x: Math.max(0, Math.min(1, (ev.clientX - left) / width)),
      y: Math.max(0, Math.min(1, (ev.clientY - top) / height))
    };
  }

  async function connect() {
    pin = pinInput.value.trim();
    if (!/^\\d{6}$/.test(pin)) { error.textContent = '6자리 PIN을 입력하세요.'; return; }
    const res = await fetch('/status', { headers: { 'x-pepe-pin': pin }, cache: 'no-store' }).catch(() => null);
    if (!res || !res.ok) { error.textContent = 'PIN이 올바르지 않거나 공유가 종료되었습니다.'; pin = ''; return; }
    login.style.display = 'none';
    viewer.style.display = 'block';
    screen.src = '/stream?pin=' + encodeURIComponent(pin) + '&t=' + Date.now();
  }

  document.querySelector('#connect').addEventListener('click', connect);
  pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
  screen.addEventListener('pointerdown', e => {
    e.preventDefault();
    screen.setPointerCapture(e.pointerId);
    const p = normalized(e);
    send({ type:'pointer', action:'down', ...p, button:e.button === 2 ? 'right' : 'left' });
    keyboard.focus({ preventScroll:true });
  });
  screen.addEventListener('pointerup', e => {
    e.preventDefault();
    const p = normalized(e);
    send({ type:'pointer', action:'up', ...p, button:e.button === 2 ? 'right' : 'left' });
  });
  screen.addEventListener('pointermove', e => {
    const now = performance.now();
    if (now - lastMove < 32) return;
    lastMove = now;
    const p = normalized(e);
    send({ type:'pointer', action:'move', ...p });
  });
  screen.addEventListener('wheel', e => {
    e.preventDefault();
    const p = normalized(e);
    send({ type:'wheel', ...p, deltaX:e.deltaX, deltaY:e.deltaY });
  }, { passive:false });
  screen.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('keydown', e => {
    if (document.activeElement === pinInput) return;
    e.preventDefault();
    send({ type:'key', action:'down', key:e.key, modifiers:[
      e.ctrlKey && 'control', e.shiftKey && 'shift', e.altKey && 'alt', e.metaKey && 'meta'
    ].filter(Boolean) });
  });
  window.addEventListener('keyup', e => {
    if (document.activeElement === pinInput) return;
    e.preventDefault();
    send({ type:'key', action:'up', key:e.key, modifiers:[
      e.ctrlKey && 'control', e.shiftKey && 'shift', e.altKey && 'alt', e.metaKey && 'meta'
    ].filter(Boolean) });
  });
  keyboard.addEventListener('input', () => {
    if (!keyboard.value) return;
    send({ type:'text', text:keyboard.value });
    keyboard.value = '';
  });
})();
</script>
</body>
</html>`;
}

export class RemoteShareServer {
  private server: http.Server | null = null;
  private pin = '';
  private address = '';
  private port = DEFAULT_PORT;
  private streams = new Set<ServerResponse>();
  private frameTimer: NodeJS.Timeout | null = null;
  private captureBusy = false;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  state(error?: string): RemoteShareState {
    return {
      running: !!this.server,
      address: this.server ? `http://${this.address}:${this.port}` : '',
      pin: this.server ? this.pin : '',
      port: this.port,
      clients: this.streams.size,
      ...(error ? { error } : {}),
    };
  }

  async start(port = DEFAULT_PORT): Promise<RemoteShareState> {
    if (this.server) return this.state();
    const address = findTailscaleIpv4();
    if (!address) return this.state('Tailscale IPv4 주소(100.64.0.0/10)를 찾지 못했습니다.');

    this.pin = makePin();
    this.address = address;
    this.port = Number.isFinite(port) && port > 0 && port < 65536 ? Math.floor(port) : DEFAULT_PORT;

    const server = http.createServer((req, res) => void this.handleRequest(req, res));
    this.server = server;
    return await new Promise(resolve => {
      server.once('error', err => {
        this.stop();
        resolve(this.state(err.message));
      });
      server.listen(this.port, this.address, () => resolve(this.state()));
    });
  }

  stop(): RemoteShareState {
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.frameTimer = null;
    for (const stream of this.streams) {
      try { stream.end(); } catch {
        // The browser may already have closed the stream.
      }
    }
    this.streams.clear();
    try { this.server?.close(); } catch {
      // Closing an already stopped server is harmless.
    }
    this.server = null;
    this.pin = '';
    this.address = '';
    return this.state();
  }

  private authorized(req: IncomingMessage, requestUrl: URL): boolean {
    const headerPin = String(req.headers['x-pepe-pin'] || '');
    return !!this.pin && (headerPin === this.pin || requestUrl.searchParams.get('pin') === this.pin);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url || '/', `http://${this.address || '127.0.0.1'}`);
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');

    if (req.method === 'GET' && requestUrl.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage());
      return;
    }
    if (!this.authorized(req, requestUrl)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":false,"error":"unauthorized"}');
      return;
    }
    if (req.method === 'GET' && requestUrl.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, clients: this.streams.size }));
      return;
    }
    if (req.method === 'GET' && requestUrl.pathname === '/stream') {
      res.writeHead(200, {
        'content-type': 'multipart/x-mixed-replace; boundary=pepeframe',
        connection: 'keep-alive',
      });
      this.streams.add(res);
      req.on('close', () => {
        this.streams.delete(res);
        if (!this.streams.size) this.stopFramePump();
      });
      this.startFramePump();
      return;
    }
    if (req.method === 'POST' && requestUrl.pathname === '/input') {
      try {
        const payload = await this.readJson(req) as RemoteInput;
        this.dispatchInput(payload);
        res.writeHead(204);
        res.end();
      } catch (err: unknown) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : 'invalid request',
        }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  }

  private readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) {
          reject(new Error('request too large'));
          req.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('invalid json')); }
      });
      req.on('error', reject);
    });
  }

  private startFramePump(): void {
    if (this.frameTimer) return;
    void this.captureFrame();
    this.frameTimer = setInterval(() => void this.captureFrame(), FRAME_INTERVAL_MS);
  }

  private stopFramePump(): void {
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.frameTimer = null;
  }

  private async captureFrame(): Promise<void> {
    if (this.captureBusy || !this.streams.size) return;
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    this.captureBusy = true;
    try {
      const image = await win.capturePage();
      const jpeg = image.toJPEG(72);
      const header = Buffer.from(`--pepeframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      const tail = Buffer.from('\r\n');
      for (const stream of [...this.streams]) {
        try {
          stream.write(header);
          stream.write(jpeg);
          stream.write(tail);
        } catch {
          this.streams.delete(stream);
        }
      }
    } catch {
      // A transient capture failure is retried on the next frame.
    }
    finally {
      this.captureBusy = false;
    }
  }

  private dispatchInput(input: RemoteInput): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    const contents = win.webContents;
    const bounds = win.getContentBounds();
    win.focus();

    if (input.type === 'pointer') {
      const x = Math.round(Math.max(0, Math.min(1, Number(input.x))) * Math.max(1, bounds.width - 1));
      const y = Math.round(Math.max(0, Math.min(1, Number(input.y))) * Math.max(1, bounds.height - 1));
      const type = input.action === 'move' ? 'mouseMove' : input.action === 'down' ? 'mouseDown' : 'mouseUp';
      contents.sendInputEvent({
        type,
        x,
        y,
        button: input.button || 'left',
        clickCount: 1,
      });
      return;
    }
    if (input.type === 'wheel') {
      const x = Math.round(Math.max(0, Math.min(1, Number(input.x))) * Math.max(1, bounds.width - 1));
      const y = Math.round(Math.max(0, Math.min(1, Number(input.y))) * Math.max(1, bounds.height - 1));
      contents.sendInputEvent({
        type: 'mouseWheel',
        x,
        y,
        deltaX: Math.round(Number(input.deltaX) || 0),
        deltaY: Math.round(-(Number(input.deltaY) || 0)),
      });
      return;
    }
    if (input.type === 'key') {
      if (!input.key || input.key === 'Process' || input.key === 'Dead') return;
      contents.sendInputEvent({
        type: input.action === 'down' ? 'keyDown' : 'keyUp',
        keyCode: input.key,
        modifiers: (input.modifiers || []).filter((value): value is InputModifier => (
          ['shift', 'control', 'ctrl', 'alt', 'meta', 'command', 'cmd'].includes(value)
        )),
      });
      return;
    }
    if (input.type === 'text' && input.text) {
      for (const char of [...input.text].slice(0, 512)) {
        contents.sendInputEvent({ type: 'char', keyCode: char });
      }
    }
  }
}
