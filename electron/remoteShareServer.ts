import { BrowserWindow, type InputEvent } from 'electron';
import http, { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { getCurrentLang } from './i18n';
import { loadNamespace } from './i18nStore';

export type RemoteShareState = {
  running: boolean;
  address: string;
  pin: string;
  pinMode: 'random' | 'fixed';
  port: number;
  clients: number;
  tailscale: {
    installed: boolean;
    connected: boolean;
    address: string;
  };
  error?: string;
};

export type RemoteShareStartOptions = {
  port?: number;
  pinMode?: 'random' | 'fixed';
  fixedPin?: string;
};

type RemoteInput =
  | { type: 'pointer'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clickCount?: number }
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

function findTailscaleExecutable(): string | null {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Tailscale', 'tailscale.exe'),
      ]
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  const existing = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (existing) return existing;
  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const result = execFileSync(finder, ['tailscale'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean);
    return result || null;
  } catch {
    return null;
  }
}

function getTailscaleStatus() {
  const address = findTailscaleIpv4() || '';
  return {
    installed: !!findTailscaleExecutable(),
    connected: !!address,
    address,
  };
}

function makePin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function remoteShareText(key: string): string {
  const lang = getCurrentLang();
  const current = loadNamespace(lang, 'remoteShare');
  const fallback = lang === 'en' ? current : loadNamespace('en', 'remoteShare');
  return current[key] || fallback[key] || key;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlPage(): string {
  const text = (key: string) => JSON.stringify(remoteShareText(key));
  const html = (key: string) => escapeHtml(remoteShareText(key));
  return `<!doctype html>
<html lang="${escapeHtml(getCurrentLang())}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>${html('title')}</title>
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
    #ended { display:none; width:min(88vw,380px); padding:28px; border:1px solid #68444a; border-radius:18px; background:#1b1115ed; box-shadow:0 22px 70px #0009; text-align:center; }
    #ended h2 { margin:0 0 8px; }
    #ended button { margin-top:16px; }
    #viewer { display:none; position:fixed; inset:0; overflow:hidden; background:#020608; touch-action:none; }
    #screenViewport { position:absolute; inset:0; overflow:hidden; background:#020608; touch-action:none; }
    #screenStage { position:absolute; inset:0; transform-origin:center center; will-change:transform; }
    #screen { width:100%; height:100%; object-fit:contain; display:block; user-select:none; -webkit-user-drag:none; }
    #bar { position:fixed; top:10px; left:50%; transform:translateX(-50%); display:flex; gap:8px; align-items:center; padding:7px 10px; border-radius:999px; background:#061119d9; border:1px solid #365767; font-size:12px; opacity:.82; z-index:5; }
    #keyboard { position:fixed; left:-9999px; top:0; opacity:0; }
    #remoteCursor { display:none; position:absolute; width:24px; height:30px; pointer-events:none; z-index:8; transform:translate(-3px,-3px); filter:drop-shadow(0 2px 2px #000b); }
    #remoteCursor svg { display:block; width:100%; height:100%; overflow:visible; }
    #mouseToggle { display:none; position:fixed; right:12px; bottom:12px; z-index:10; width:auto; height:42px; margin:0; padding:0 15px; border:1px solid #4d7182; border-radius:999px; background:#0b1a23e8; box-shadow:0 8px 26px #0008; }
    #virtualMouse { display:none; position:fixed; left:10px; right:10px; bottom:10px; z-index:9; padding:10px; border:1px solid #456878; border-radius:16px; background:#07141df2; box-shadow:0 12px 40px #000a; backdrop-filter:blur(10px); }
    #mouseHead { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; color:#b7ced8; font-size:12px; }
    #mouseHeadActions { display:flex; align-items:center; gap:6px; }
    #zoomLabel { min-width:42px; color:#80cbe0; text-align:right; font-variant-numeric:tabular-nums; }
    #zoomReset,#mouseClose { width:auto; height:28px; margin:0; padding:0 10px; background:#243b47; font-size:12px; }
    #mouseGrid { display:grid; grid-template-columns:minmax(140px,1fr) 78px; gap:8px; }
    #touchpad { height:145px; border:1px solid #395867; border-radius:12px; background:linear-gradient(145deg,#152b36,#0b1921); touch-action:none; position:relative; overflow:hidden; }
    #touchpad::after { content:attr(data-hint); white-space:pre; position:absolute; inset:0; display:grid; place-items:center; color:#7895a1; text-align:center; font-size:12px; pointer-events:none; }
    #mouseSide { display:grid; grid-template-rows:1fr 1fr 1fr; gap:6px; }
    .mouseBtn { height:auto; min-height:0; margin:0; padding:0 5px; border:1px solid #3d6171; background:#18313e; font-size:12px; }
    #mouseButtons { display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-top:8px; }
    #mouseButtons .mouseBtn { height:40px; }
    #viewer.mouse-mode #screenViewport { bottom:clamp(285px,46dvh,390px); border-bottom:1px solid #294653; }
    #viewer.mouse-mode #screen { pointer-events:none; }
    #viewer.mouse-mode #bar { display:none; }
    #viewer.mouse-mode #virtualMouse { display:block; }
    #viewer.mouse-mode #mouseToggle { display:none !important; }
    #viewer.mouse-mode #remoteCursor { display:block; }
    @media (pointer:coarse), (max-width:800px) {
      #mouseToggle { display:block; }
      #bar { top:6px; max-width:calc(100vw - 16px); white-space:nowrap; overflow:hidden; }
      #virtualMouse { left:8px; right:8px; bottom:max(8px,env(safe-area-inset-bottom)); }
      #touchpad { height:clamp(145px,21dvh,210px); }
      #viewer.mouse-mode #screenViewport { bottom:clamp(300px,47dvh,410px); }
    }
  </style>
</head>
<body>
  <main id="login">
    <h1>${html('title')}</h1>
    <p>${html('client.loginHelp')}</p>
    <input id="pin" inputmode="numeric" maxlength="6" autocomplete="one-time-code" autofocus>
    <button id="connect">${html('client.connect')}</button>
    <div id="error"></div>
  </main>
  <main id="ended">
    <h2>${html('client.endedTitle')}</h2>
    <p>${html('client.endedHelp')}</p>
    <button id="reload">${html('client.reload')}</button>
  </main>
  <main id="viewer">
    <div id="screenViewport">
      <div id="screenStage">
        <img id="screen" alt="${html('title')}">
        <div id="remoteCursor" aria-hidden="true">
          <svg viewBox="0 0 28 34">
            <path d="M3 2.5v25.2l6.5-6.2 4.5 10.1 5-2.3-4.4-9.8h9.2L3 2.5Z" fill="#fff" stroke="#111" stroke-width="2.2" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>
    </div>
    <div id="bar"><span>PePe Remote</span><span>${html('client.directControl')}</span></div>
    <button id="mouseToggle">${html('client.virtualMouse')}</button>
    <section id="virtualMouse">
      <div id="mouseHead">
        <strong>${html('client.virtualMouse')}</strong>
        <div id="mouseHeadActions">
          <span id="zoomLabel">100%</span>
          <button id="zoomReset">${html('client.fitScreen')}</button>
          <button id="mouseClose">${html('client.collapse')}</button>
        </div>
      </div>
      <div id="mouseGrid">
        <div id="touchpad" data-hint="${html('client.touchpadHint')}"></div>
        <div id="mouseSide">
          <button class="mouseBtn" id="scrollUp">${html('client.scrollUp')}</button>
          <button class="mouseBtn" id="keyboardBtn">${html('client.keyboard')}</button>
          <button class="mouseBtn" id="scrollDown">${html('client.scrollDown')}</button>
        </div>
      </div>
      <div id="mouseButtons">
        <button class="mouseBtn" id="leftClick">${html('client.leftClick')}</button>
        <button class="mouseBtn" id="doubleClick">${html('client.doubleClick')}</button>
        <button class="mouseBtn" id="rightClick">${html('client.rightClick')}</button>
      </div>
    </section>
    <textarea id="keyboard" autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
  </main>
<script>
(() => {
  const messages = {
    pinRequired: ${text('client.pinRequired')},
    invalidPin: ${text('client.invalidPin')}
  };
  const login = document.querySelector('#login');
  const ended = document.querySelector('#ended');
  const viewer = document.querySelector('#viewer');
  const pinInput = document.querySelector('#pin');
  const error = document.querySelector('#error');
  const screenViewport = document.querySelector('#screenViewport');
  const screenStage = document.querySelector('#screenStage');
  const screen = document.querySelector('#screen');
  const keyboard = document.querySelector('#keyboard');
  const remoteCursor = document.querySelector('#remoteCursor');
  const virtualMouse = document.querySelector('#virtualMouse');
  const mouseToggle = document.querySelector('#mouseToggle');
  const touchpad = document.querySelector('#touchpad');
  const zoomLabel = document.querySelector('#zoomLabel');
  let pin = '';
  let lastMove = 0;
  let cursor = { x: 0.5, y: 0.5 };
  let padStart = null;
  let padMoved = false;
  let zoom = Math.max(1, Math.min(4, Number(localStorage.getItem('pepeRemoteZoom')) || 1));
  let panX = Number(localStorage.getItem('pepeRemotePanX')) || 0;
  let panY = Number(localStorage.getItem('pepeRemotePanY')) || 0;
  const zoomPointers = new Map();
  let pinchStart = null;
  let statusTimer = null;
  let statusFailures = 0;

  function showEnded() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    pin = '';
    screen.removeAttribute('src');
    screenStage.style.transform = 'none';
    viewer.style.display = 'none';
    login.style.display = 'none';
    ended.style.display = 'block';
  }

  async function checkShareStatus() {
    if (!pin) return;
    try {
      const response = await fetch('/status', {
        headers: { 'x-pepe-pin': pin },
        cache: 'no-store',
        signal: AbortSignal.timeout(2500)
      });
      if (!response.ok) {
        showEnded();
        return;
      }
      statusFailures = 0;
    } catch {
      statusFailures += 1;
      if (statusFailures >= 2) showEnded();
    }
  }

  async function send(payload) {
    if (!pin) return;
    try {
      const response = await fetch('/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pepe-pin': pin },
        body: JSON.stringify(payload),
        cache: 'no-store'
      });
      if (response.headers.get('content-type')?.includes('application/json')) {
        return await response.json();
      }
    } catch {}
    return null;
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

  function screenBox() {
    const widthBase = screenStage.clientWidth || 1;
    const heightBase = screenStage.clientHeight || 1;
    const naturalRatio = (screen.naturalWidth || widthBase) / (screen.naturalHeight || heightBase);
    const boxRatio = widthBase / heightBase;
    let width = widthBase, height = heightBase, left = 0, top = 0;
    if (boxRatio > naturalRatio) {
      width = heightBase * naturalRatio;
      left = (widthBase - width) / 2;
    } else {
      height = widthBase / naturalRatio;
      top = (heightBase - height) / 2;
    }
    return { width, height, left, top };
  }

  function drawCursor() {
    const box = screenBox();
    remoteCursor.style.left = (box.left + cursor.x * box.width) + 'px';
    remoteCursor.style.top = (box.top + cursor.y * box.height) + 'px';
  }

  function clampPan() {
    const width = screenViewport.clientWidth || 1;
    const height = screenViewport.clientHeight || 1;
    const maxX = Math.max(0, (width * zoom - width) / 2);
    const maxY = Math.max(0, (height * zoom - height) / 2);
    panX = Math.max(-maxX, Math.min(maxX, panX));
    panY = Math.max(-maxY, Math.min(maxY, panY));
  }

  function saveView() {
    localStorage.setItem('pepeRemoteZoom', String(zoom));
    localStorage.setItem('pepeRemotePanX', String(panX));
    localStorage.setItem('pepeRemotePanY', String(panY));
  }

  function applyView(save = false) {
    clampPan();
    const active = viewer.classList.contains('mouse-mode');
    screenStage.style.transform = active
      ? 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')'
      : 'translate(0,0) scale(1)';
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
    if (save) saveView();
    drawCursor();
  }

  function resetView() {
    zoom = 1;
    panX = 0;
    panY = 0;
    applyView(true);
  }

  function moveCursor(dx, dy) {
    const box = screenBox();
    cursor.x = Math.max(0, Math.min(1, cursor.x + dx * 1.35 / Math.max(1, box.width)));
    cursor.y = Math.max(0, Math.min(1, cursor.y + dy * 1.35 / Math.max(1, box.height)));
    drawCursor();
    send({ type:'pointer', action:'move', x:cursor.x, y:cursor.y });
  }

  function clickAtCursor(button = 'left', count = 1) {
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        const clickCount = i + 1;
        send({ type:'pointer', action:'down', x:cursor.x, y:cursor.y, button, clickCount });
        setTimeout(async () => {
          const result = await send({ type:'pointer', action:'up', x:cursor.x, y:cursor.y, button, clickCount });
          if (result?.editable) keyboard.focus({ preventScroll:true });
        }, 45);
      }, i * 130);
    }
  }

  async function connect() {
    pin = pinInput.value.trim();
    if (!/^\\d{6}$/.test(pin)) { error.textContent = messages.pinRequired; return; }
    const res = await fetch('/status', { headers: { 'x-pepe-pin': pin }, cache: 'no-store' }).catch(() => null);
    if (!res || !res.ok) { error.textContent = messages.invalidPin; pin = ''; return; }
    login.style.display = 'none';
    viewer.style.display = 'block';
    screen.src = '/stream?pin=' + encodeURIComponent(pin) + '&t=' + Date.now();
    drawCursor();
    statusFailures = 0;
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(checkShareStatus, 1500);
  }

  document.querySelector('#connect').addEventListener('click', connect);
  document.querySelector('#reload').addEventListener('click', () => location.reload());
  pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
  screen.addEventListener('pointerdown', e => {
    e.preventDefault();
    screen.setPointerCapture(e.pointerId);
    const p = normalized(e);
    cursor = p;
    drawCursor();
    send({ type:'pointer', action:'down', ...p, button:e.button === 2 ? 'right' : 'left' });
  });
  screen.addEventListener('pointerup', async e => {
    e.preventDefault();
    const p = normalized(e);
    cursor = p;
    drawCursor();
    const result = await send({ type:'pointer', action:'up', ...p, button:e.button === 2 ? 'right' : 'left' });
    if (result?.editable) keyboard.focus({ preventScroll:true });
  });
  screen.addEventListener('pointermove', e => {
    const now = performance.now();
    if (now - lastMove < 32) return;
    lastMove = now;
    const p = normalized(e);
    cursor = p;
    drawCursor();
    send({ type:'pointer', action:'move', ...p });
  });
  screen.addEventListener('wheel', e => {
    e.preventDefault();
    const p = normalized(e);
    send({ type:'wheel', ...p, deltaX:e.deltaX, deltaY:e.deltaY });
  }, { passive:false });
  screen.addEventListener('contextmenu', e => e.preventDefault());
  mouseToggle.addEventListener('click', () => {
    viewer.classList.add('mouse-mode');
    applyView();
  });
  document.querySelector('#mouseClose').addEventListener('click', () => {
    viewer.classList.remove('mouse-mode');
    applyView();
  });
  document.querySelector('#zoomReset').addEventListener('click', resetView);
  screenViewport.addEventListener('pointerdown', e => {
    if (!viewer.classList.contains('mouse-mode') || e.pointerType === 'mouse') return;
    e.preventDefault();
    screenViewport.setPointerCapture(e.pointerId);
    zoomPointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    if (zoomPointers.size === 2) {
      const points = [...zoomPointers.values()];
      pinchStart = {
        distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
        centerX: (points[0].x + points[1].x) / 2,
        centerY: (points[0].y + points[1].y) / 2,
        zoom,
        panX,
        panY
      };
    }
  });
  screenViewport.addEventListener('pointermove', e => {
    if (!viewer.classList.contains('mouse-mode') || !zoomPointers.has(e.pointerId)) return;
    e.preventDefault();
    zoomPointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    if (zoomPointers.size !== 2 || !pinchStart) return;
    const points = [...zoomPointers.values()];
    const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
    const centerX = (points[0].x + points[1].x) / 2;
    const centerY = (points[0].y + points[1].y) / 2;
    zoom = Math.max(1, Math.min(4, pinchStart.zoom * distance / Math.max(1, pinchStart.distance)));
    panX = pinchStart.panX + centerX - pinchStart.centerX;
    panY = pinchStart.panY + centerY - pinchStart.centerY;
    applyView();
  });
  const endZoomPointer = e => {
    if (!zoomPointers.has(e.pointerId)) return;
    zoomPointers.delete(e.pointerId);
    if (zoomPointers.size < 2) {
      pinchStart = null;
      applyView(true);
    }
  };
  screenViewport.addEventListener('pointerup', endZoomPointer);
  screenViewport.addEventListener('pointercancel', endZoomPointer);
  touchpad.addEventListener('pointerdown', e => {
    e.preventDefault();
    touchpad.setPointerCapture(e.pointerId);
    padStart = { x:e.clientX, y:e.clientY, lastX:e.clientX, lastY:e.clientY };
    padMoved = false;
  });
  touchpad.addEventListener('pointermove', e => {
    if (!padStart) return;
    e.preventDefault();
    const dx = e.clientX - padStart.lastX;
    const dy = e.clientY - padStart.lastY;
    if (Math.abs(e.clientX - padStart.x) + Math.abs(e.clientY - padStart.y) > 5) padMoved = true;
    padStart.lastX = e.clientX;
    padStart.lastY = e.clientY;
    moveCursor(dx, dy);
  });
  touchpad.addEventListener('pointerup', e => {
    e.preventDefault();
    if (!padMoved) clickAtCursor('left');
    padStart = null;
  });
  touchpad.addEventListener('pointercancel', () => { padStart = null; });
  document.querySelector('#leftClick').addEventListener('click', () => clickAtCursor('left'));
  document.querySelector('#doubleClick').addEventListener('click', () => clickAtCursor('left', 2));
  document.querySelector('#rightClick').addEventListener('click', () => clickAtCursor('right'));
  document.querySelector('#scrollUp').addEventListener('click', () => send({ type:'wheel', x:cursor.x, y:cursor.y, deltaY:-220 }));
  document.querySelector('#scrollDown').addEventListener('click', () => send({ type:'wheel', x:cursor.x, y:cursor.y, deltaY:220 }));
  document.querySelector('#keyboardBtn').addEventListener('click', () => keyboard.focus({ preventScroll:true }));
  window.addEventListener('resize', () => applyView());
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
  private pinMode: 'random' | 'fixed' = 'random';
  private address = '';
  private port = DEFAULT_PORT;
  private streams = new Set<ServerResponse>();
  private frameTimer: NodeJS.Timeout | null = null;
  private captureBusy = false;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  state(error?: string): RemoteShareState {
    const tailscale = getTailscaleStatus();
    return {
      running: !!this.server,
      address: this.server ? `http://${this.address}:${this.port}` : '',
      pin: this.server && this.pinMode === 'random' ? this.pin : '',
      pinMode: this.pinMode,
      port: this.port,
      clients: this.streams.size,
      tailscale,
      ...(error ? { error } : {}),
    };
  }

  async start(options: RemoteShareStartOptions = {}): Promise<RemoteShareState> {
    if (this.server) return this.state();
    const tailscale = getTailscaleStatus();
    if (!tailscale.installed) {
      return this.state(remoteShareText('errors.tailscaleNotInstalled'));
    }
    if (!tailscale.connected || !tailscale.address) {
      return this.state(remoteShareText('errors.tailscaleDisconnected'));
    }
    const fixedPin = String(options.fixedPin || '').trim();
    if (options.pinMode === 'fixed' && !/^\d{6}$/.test(fixedPin)) {
      return this.state(remoteShareText('errors.invalidFixedPin'));
    }

    this.pinMode = options.pinMode === 'fixed' ? 'fixed' : 'random';
    this.pin = this.pinMode === 'fixed' ? fixedPin : makePin();
    this.address = tailscale.address;
    const port = Number(options.port);
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
    this.pinMode = 'random';
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
        const result = await this.dispatchInput(payload);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...result }));
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

  private async dispatchInput(input: RemoteInput): Promise<{ editable?: boolean }> {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return {};
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
        clickCount: Math.max(1, Math.min(2, Number(input.clickCount) || 1)),
      });
      if (input.action === 'up') {
        await new Promise(resolve => setTimeout(resolve, 40));
        const editable = await contents.executeJavaScript(`
          (() => {
            const el = document.activeElement;
            if (!el) return false;
            const tag = String(el.tagName || '').toLowerCase();
            return tag === 'input'
              || tag === 'textarea'
              || el.isContentEditable
              || el.getAttribute?.('role') === 'textbox'
              || !!el.closest?.('.monaco-editor, .xterm-helper-textarea, [contenteditable="true"]');
          })()
        `, true).catch(() => false);
        return { editable: !!editable };
      }
      return {};
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
      return {};
    }
    if (input.type === 'key') {
      if (!input.key || input.key === 'Process' || input.key === 'Dead') return {};
      contents.sendInputEvent({
        type: input.action === 'down' ? 'keyDown' : 'keyUp',
        keyCode: input.key,
        modifiers: (input.modifiers || []).filter((value): value is InputModifier => (
          ['shift', 'control', 'ctrl', 'alt', 'meta', 'command', 'cmd'].includes(value)
        )),
      });
      return {};
    }
    if (input.type === 'text' && input.text) {
      for (const char of [...input.text].slice(0, 512)) {
        contents.sendInputEvent({ type: 'char', keyCode: char });
      }
    }
    return {};
  }
}
