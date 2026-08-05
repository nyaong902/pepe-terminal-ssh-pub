import { app, BrowserWindow, webContents as electronWebContents, type InputEvent, type WebContents } from 'electron';
import http, { IncomingMessage, ServerResponse } from 'http';
// ws 는 타입만 정적으로 가져온다(컴파일 시 지워진다) — 런타임 require 는 loadWs() 가 한다.
//
// 원격 공유는 선택 설치 기능이라 ws 패키지가 없을 수 있다. 예전처럼 최상위에서 import 하면
// main.js 가 시작할 때 require('ws') 를 실행해, 이 기능을 체크 해제한 설치본에서 앱 자체가
// 뜨지 않는다. 그래서 실제로 공유를 시작할 때만 불러온다.
import type { WebSocketServer as WsServer, WebSocket as WsSocket } from 'ws';
import { ensureBundleExtracted } from './ensureBundleExtracted';

let wsModule: any = null;
/** ws 를 필요한 순간에 불러온다. 없으면 사람이 읽을 수 있는 오류를 던진다. */
function loadWs(): any {
  if (wsModule) return wsModule;
  try {
    if (!app.isPackaged) {
      wsModule = require('ws');
      return wsModule;
    }
    // 포터블 빌드는 NSIS customInstall 을 거치지 않아 zip 만 남아 있다 — 첫 사용 시 여기서 푼다.
    ensureBundleExtracted(
      'remote-share',
      path.join('app.asar.unpacked', 'node_modules'),
      path.join('ws', 'package.json'),
      (m) => console.log(m),
    );
    // asar 안에서 bare require('ws') 는 asar 내부 node_modules 만 본다 — 번들로 빠져 있으므로
    // 풀린 위치를 절대 경로로 직접 가리킨다(chat-archive-ai 가 transformers 를 그렇게 로드한다).
    wsModule = require(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ws'));
    return wsModule;
  } catch (e: any) {
    throw new Error(
      '원격 공유 기능이 설치되지 않았습니다 — 설치 프로그램에서 "원격 공유"를 선택해 다시 설치하세요.'
      + ` (${String(e?.message || e)})`,
    );
  }
}

/** 이 설치본에 원격 공유 런타임이 있는가 — 메뉴 노출 판단에 쓴다. */
export function remoteShareRuntimeAvailable(): boolean {
  try {
    if (!app.isPackaged) return true;
    const base = process.resourcesPath;
    if (fs.existsSync(path.join(base, 'app.asar.unpacked', 'node_modules', 'ws', 'package.json'))) return true;
    return fs.existsSync(path.join(base, 'remote-share.zip'));
  } catch { return false; }
}
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { getCurrentLang } from './i18n';
import { loadNamespace } from './i18nStore';
import { RemoteShareHostWindow, type RemoteShareSignal } from './remoteShareHostWindow';

// 'webrtc': RTCPeerConnection 로 화면 전송(저지연, 고화질) — 기본값, Tailscale 등
// 같은 네트워크 환경에서 STUN/TURN 없이도 대개 연결됨.
// 'mjpeg': BrowserWindow.capturePage() 를 폴링해 JPEG 스트림으로 전송 — WebRTC 협상이
// 막히는 네트워크(엄격한 방화벽 등)에서의 폴백. 지연은 더 크지만 항상 동작함.
export type RemoteShareMode = 'webrtc' | 'mjpeg';

export type RemoteShareState = {
  running: boolean;
  address: string;
  pin: string;
  pinMode: 'random' | 'fixed';
  mode: RemoteShareMode;
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
  mode?: RemoteShareMode;
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
// 입력(특히 타이핑) 직후 잠시 더 짧은 간격으로 캡처해 화면 반영 지연을 줄인다.
const FRAME_INTERVAL_BOOST_MS = 60;
const FRAME_BOOST_DURATION_MS = 1200;

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
    #screenViewport.zoomed { overflow:auto; touch-action:pan-x pan-y; }
    #viewer.mouse-mode #screenViewport { overflow:hidden !important; touch-action:none; }
    #screenStage { position:relative; width:100%; height:100%; transform-origin:top left; will-change:transform; }
    #viewer.mouse-mode #screenStage { position:absolute; inset:0; }
    #screen, #screenImg { width:100%; height:100%; object-fit:contain; user-select:none; -webkit-user-drag:none; display:none; }
    #screen.active, #screenImg.active { display:block; }
    #bar { position:fixed; top:10px; left:50%; transform:translateX(-50%); display:flex; gap:8px; align-items:center; padding:7px 10px; border-radius:999px; background:#061119d9; border:1px solid #365767; font-size:12px; opacity:.82; z-index:5; }
    #barBtns { display:flex; gap:4px; margin-left:4px; }
    #barBtns button { all:unset; cursor:pointer; padding:3px 9px; border-radius:999px; background:#16303c; color:#cfe7f0; font-size:12px; line-height:1.6; }
    #barBtns button:hover { background:#204457; }
    #fullscreenToggle { position:fixed; top:10px; left:50%; transform:translateX(-50%); z-index:6; width:auto; height:auto; margin:0; padding:8px 16px; border-radius:999px; background:#061119d9; border:1px solid #365767; color:#cfe7f0; font-size:12px; opacity:.82; display:none; }
    #viewer.can-fullscreen #fullscreenToggle { display:block; }
    #viewer.can-fullscreen #bar { top:52px; }
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
        <video id="screen" autoplay playsinline muted></video>
        <img id="screenImg" alt="${html('title')}">
        <div id="remoteCursor" aria-hidden="true">
          <svg viewBox="0 0 28 34">
            <path d="M3 2.5v25.2l6.5-6.2 4.5 10.1 5-2.3-4.4-9.8h9.2L3 2.5Z" fill="#fff" stroke="#111" stroke-width="2.2" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>
    </div>
    <div id="bar">
      <span>PePe Remote</span><span>${html('client.directControl')}</span>
      <div id="barBtns">
        <button id="scaleDown" title="${html('client.zoomOut')}">-</button>
        <span id="scaleLabel">100%</span>
        <button id="scaleUp" title="${html('client.zoomIn')}">+</button>
        <button id="scaleReset" title="${html('client.fitScreen')}">${html('client.fitScreen')}</button>
      </div>
    </div>
    <button id="fullscreenToggle">${html('client.fullscreenEnter')}</button>
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
    invalidPin: ${text('client.invalidPin')},
    fullscreenEnter: ${text('client.fullscreenEnter')},
    fullscreenExit: ${text('client.fullscreenExit')}
  };
  const login = document.querySelector('#login');
  const ended = document.querySelector('#ended');
  const viewer = document.querySelector('#viewer');
  const pinInput = document.querySelector('#pin');
  const error = document.querySelector('#error');
  const screenViewport = document.querySelector('#screenViewport');
  const screenStage = document.querySelector('#screenStage');
  const screenVideo = document.querySelector('#screen');
  const screenImg = document.querySelector('#screenImg');
  // 현재 활성 화면 엘리먼트 — WebRTC 모드는 <video>, MJPEG 폴백 모드는 <img>.
  // videoWidth/naturalWidth 를 모두 시도해 두 모드 공용 크기 계산을 그대로 재사용한다.
  let screen = screenVideo;
  const keyboard = document.querySelector('#keyboard');
  const remoteCursor = document.querySelector('#remoteCursor');
  const virtualMouse = document.querySelector('#virtualMouse');
  const mouseToggle = document.querySelector('#mouseToggle');
  const touchpad = document.querySelector('#touchpad');
  const zoomLabel = document.querySelector('#zoomLabel');
  const scaleLabel = document.querySelector('#scaleLabel');
  const fullscreenToggle = document.querySelector('#fullscreenToggle');
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
  let keyboardComposing = false;
  let ws = null;
  let pc = null;
  let dataChannel = null;
  let nextRequestId = 1;
  const pendingReplies = new Map();
  let shareMode = 'webrtc';

  function closeConnection() {
    if (dataChannel) { try { dataChannel.close(); } catch {} dataChannel = null; }
    if (pc) { try { pc.close(); } catch {} pc = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
    for (const { reject } of pendingReplies.values()) reject(new Error('connection closed'));
    pendingReplies.clear();
  }

  function showEnded() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    stopEdgeScroll();
    closeConnection();
    pin = '';
    screenVideo.srcObject = null;
    screenImg.removeAttribute('src');
    screenStage.style.transform = 'none';
    viewer.style.display = 'none';
    login.style.display = 'none';
    ended.style.display = 'block';
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
    zoom = 1;
    panX = 0;
    panY = 0;
    saveView();
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

  // WebRTC 모드: 입력을 DataChannel(저지연 UDP 기반)로 보낸다. pointer up 처럼 응답(editable
  // 여부)이 필요한 메시지는 id 를 붙여 보내고, 호스트가 같은 id 로 결과를 돌려줄 때까지 기다린다.
  // MJPEG 폴백 모드: 기존처럼 HTTP POST /input 으로 보내고 JSON 응답을 그대로 결과로 쓴다.
  async function sendHttp(payload) {
    if (!pin) return null;
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

  function send(payload, expectReply = false) {
    if (shareMode === 'mjpeg') return sendHttp(payload);
    if (!dataChannel || dataChannel.readyState !== 'open') return Promise.resolve(null);
    if (!expectReply) {
      try { dataChannel.send(JSON.stringify(payload)); } catch {}
      return Promise.resolve(null);
    }
    const id = nextRequestId++;
    try { dataChannel.send(JSON.stringify({ ...payload, id })); } catch { return Promise.resolve(null); }
    return new Promise(resolve => {
      const timer = setTimeout(() => { pendingReplies.delete(id); resolve(null); }, 500);
      pendingReplies.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: () => { clearTimeout(timer); resolve(null); } });
    });
  }

  function normalized(ev) {
    const r = screen.getBoundingClientRect();
    const naturalRatio = (screen.videoWidth || r.width) / (screen.videoHeight || r.height);
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
    const naturalRatio = (screen.videoWidth || widthBase) / (screen.videoHeight || heightBase);
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
    const mouseMode = viewer.classList.contains('mouse-mode');
    if (mouseMode) {
      clampPan();
      screenStage.style.width = '';
      screenStage.style.height = '';
      screenStage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
    } else {
      screenViewport.classList.toggle('zoomed', zoom > 1);
      screenStage.style.transform = 'none';
      screenStage.style.width = (zoom * 100) + '%';
      screenStage.style.height = (zoom * 100) + '%';
    }
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
    scaleLabel.textContent = Math.round(zoom * 100) + '%';
    if (save) saveView();
    drawCursor();
  }

  function setZoom(next) {
    zoom = Math.max(1, Math.min(4, next));
    applyView(true);
  }

  function resetView() {
    zoom = 1;
    panX = 0;
    panY = 0;
    applyView(true);
  }

  const EDGE_ZONE = 56;
  const EDGE_MAX_SPEED = 18;
  let edgeVX = 0;
  let edgeVY = 0;
  let edgeFrame = null;
  let lastPointerEvent = null;

  function edgeScrollStep() {
    if (!edgeVX && !edgeVY) { edgeFrame = null; return; }
    screenViewport.scrollLeft += edgeVX;
    screenViewport.scrollTop += edgeVY;
    if (lastPointerEvent) {
      const p = normalized(lastPointerEvent);
      cursor = p;
      drawCursor();
      send({ type:'pointer', action:'move', ...p });
    }
    edgeFrame = requestAnimationFrame(edgeScrollStep);
  }

  function updateEdgeScroll(e) {
    if (viewer.classList.contains('mouse-mode') || zoom <= 1 || !screenViewport.classList.contains('zoomed')) {
      stopEdgeScroll();
      return;
    }
    lastPointerEvent = e;
    const r = screenViewport.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const factor = d => Math.max(0, Math.min(1, (EDGE_ZONE - d) / EDGE_ZONE));
    edgeVX = x < EDGE_ZONE ? -factor(x) * EDGE_MAX_SPEED
      : x > r.width - EDGE_ZONE ? factor(r.width - x) * EDGE_MAX_SPEED
      : 0;
    edgeVY = y < EDGE_ZONE ? -factor(y) * EDGE_MAX_SPEED
      : y > r.height - EDGE_ZONE ? factor(r.height - y) * EDGE_MAX_SPEED
      : 0;
    if ((edgeVX || edgeVY) && edgeFrame === null) {
      edgeFrame = requestAnimationFrame(edgeScrollStep);
    }
  }

  function stopEdgeScroll() {
    edgeVX = 0;
    edgeVY = 0;
    lastPointerEvent = null;
    if (edgeFrame !== null) {
      cancelAnimationFrame(edgeFrame);
      edgeFrame = null;
    }
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
          const result = await send({ type:'pointer', action:'up', x:cursor.x, y:cursor.y, button, clickCount }, true);
          if (result?.editable) keyboard.focus({ preventScroll:true });
        }, 45);
      }, i * 130);
    }
  }

  function connectSignalSocket() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(proto + '://' + location.host + '/signal?pin=' + encodeURIComponent(pin));
    ws = socket;
    pc = new RTCPeerConnection({ iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ] });
    pc.addEventListener('track', ev => {
      console.log('[pepe-remote] track received', ev.track.kind, ev.streams.length);
      if (ev.streams[0]) {
        screen.srcObject = ev.streams[0];
        screen.play?.().catch(err => console.log('[pepe-remote] video play() failed', err));
      }
    });
    pc.addEventListener('connectionstatechange', () => {
      console.log('[pepe-remote] connectionState', pc.connectionState);
    });
    pc.addEventListener('iceconnectionstatechange', () => {
      console.log('[pepe-remote] iceConnectionState', pc.iceConnectionState);
    });
    pc.addEventListener('icecandidate', ev => {
      if (ev.candidate && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ kind:'ice', candidate: ev.candidate.toJSON() }));
      }
    });
    pc.addEventListener('datachannel', ev => {
      dataChannel = ev.channel;
      dataChannel.addEventListener('message', msgEv => {
        let msg;
        try { msg = JSON.parse(msgEv.data); } catch { return; }
        if (msg && typeof msg.id === 'number' && pendingReplies.has(msg.id)) {
          pendingReplies.get(msg.id).resolve(msg);
          pendingReplies.delete(msg.id);
        }
      });
    });
    socket.addEventListener('message', async ev => {
      let signal;
      try { signal = JSON.parse(ev.data); } catch { return; }
      if (signal.kind === 'offer') {
        await pc.setRemoteDescription({ type:'offer', sdp: signal.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.send(JSON.stringify({ kind:'answer', sdp: pc.localDescription.sdp }));
      } else if (signal.kind === 'ice' && signal.candidate) {
        try { await pc.addIceCandidate(signal.candidate); } catch {}
      }
    });
    socket.addEventListener('close', () => { if (pin) showEnded(); });
    socket.addEventListener('error', () => {});
  }

  async function connect() {
    pin = pinInput.value.trim();
    if (!/^\\d{6}$/.test(pin)) { error.textContent = messages.pinRequired; return; }
    const res = await fetch('/status', { headers: { 'x-pepe-pin': pin }, cache: 'no-store' }).catch(() => null);
    if (!res || !res.ok) { error.textContent = messages.invalidPin; pin = ''; return; }
    let statusBody = null;
    try { statusBody = await res.clone().json(); } catch {}
    shareMode = statusBody && statusBody.mode === 'mjpeg' ? 'mjpeg' : 'webrtc';
    screen = shareMode === 'mjpeg' ? screenImg : screenVideo;
    screenVideo.classList.toggle('active', shareMode === 'webrtc');
    screenImg.classList.toggle('active', shareMode === 'mjpeg');
    login.style.display = 'none';
    viewer.style.display = 'block';
    if (shareMode === 'mjpeg') {
      screenImg.src = '/stream?pin=' + encodeURIComponent(pin) + '&t=' + Date.now();
    } else {
      connectSignalSocket();
    }
    applyView();
    statusFailures = 0;
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(checkShareStatus, 1500);
  }

  document.querySelector('#connect').addEventListener('click', connect);
  document.querySelector('#reload').addEventListener('click', () => location.reload());
  pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
  // 두 화면 엘리먼트(webrtc=video, mjpeg 폴백=img) 모두에 동일한 조작 리스너를 건다 —
  // 실행 시점엔 항상 현재 활성 엘리먼트(전역 screen 변수)를 기준으로 좌표를 계산하므로
  // 비활성 엘리먼트(display:none)에서는 이벤트 자체가 발생하지 않아 안전하다.
  [screenVideo, screenImg].forEach(el => {
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      screen.setPointerCapture(e.pointerId);
      const p = normalized(e);
      cursor = p;
      drawCursor();
      send({ type:'pointer', action:'down', ...p, button:e.button === 2 ? 'right' : 'left' });
    });
    el.addEventListener('pointerup', async e => {
      e.preventDefault();
      const p = normalized(e);
      cursor = p;
      drawCursor();
      const result = await send({ type:'pointer', action:'up', ...p, button:e.button === 2 ? 'right' : 'left' }, true);
      if (result?.editable) keyboard.focus({ preventScroll:true });
    });
    el.addEventListener('pointermove', e => {
      updateEdgeScroll(e);
      const now = performance.now();
      if (now - lastMove < 32) return;
      lastMove = now;
      const p = normalized(e);
      cursor = p;
      drawCursor();
      send({ type:'pointer', action:'move', ...p });
    });
    el.addEventListener('pointerleave', stopEdgeScroll);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const p = normalized(e);
      send({ type:'wheel', ...p, deltaX:e.deltaX, deltaY:e.deltaY });
    }, { passive:false });
  });
  // 우클릭 시 원격 화면 안의 우클릭(호스트로 전달됨)만 일어나야 하는데, 뷰어 브라우저
  // 자체의 네이티브 컨텍스트 메뉴도 함께 뜨는 경우가 있었다 — pointerdown 의
  // preventDefault() 만으로는 일부 브라우저에서 뒤이은 contextmenu 이벤트 발생을 막지
  // 못하고(캡처 단계까지 내려가기 전에 이미 메뉴가 예약됨), 또한 viewer 엘리먼트에만
  // 걸면 이벤트가 그 바깥(document/body)까지 올라가 처리되는 경우를 놓칠 수 있어
  // document 전체에 캡처 단계로 전역 차단을 걸어 확실히 막는다.
  document.addEventListener('contextmenu', e => e.preventDefault(), true);
  mouseToggle.addEventListener('click', () => {
    stopEdgeScroll();
    viewer.classList.add('mouse-mode');
    applyView();
  });
  document.querySelector('#mouseClose').addEventListener('click', () => {
    viewer.classList.remove('mouse-mode');
    applyView();
  });
  document.querySelector('#zoomReset').addEventListener('click', resetView);
  document.querySelector('#scaleUp').addEventListener('click', () => setZoom(zoom + 0.25));
  document.querySelector('#scaleDown').addEventListener('click', () => setZoom(zoom - 0.25));
  document.querySelector('#scaleReset').addEventListener('click', resetView);
  if (document.fullscreenEnabled || document.documentElement.webkitRequestFullscreen) {
    viewer.classList.add('can-fullscreen');
  }
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function updateFullscreenLabel() {
    fullscreenToggle.textContent = isFullscreen() ? messages.fullscreenExit : messages.fullscreenEnter;
  }
  fullscreenToggle.addEventListener('click', () => {
    if (isFullscreen()) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      const req = viewer.requestFullscreen || viewer.webkitRequestFullscreen;
      req?.call(viewer);
    }
  });
  document.addEventListener('fullscreenchange', updateFullscreenLabel);
  document.addEventListener('webkitfullscreenchange', updateFullscreenLabel);
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
    if (e.isComposing || e.key === 'Process' || e.key === 'Dead') return;
    e.preventDefault();
    send({ type:'key', action:'down', key:e.key, modifiers:[
      e.ctrlKey && 'control', e.shiftKey && 'shift', e.altKey && 'alt', e.metaKey && 'meta'
    ].filter(Boolean) });
  });
  window.addEventListener('keyup', e => {
    if (document.activeElement === pinInput) return;
    if (e.isComposing || e.key === 'Process' || e.key === 'Dead') return;
    e.preventDefault();
    send({ type:'key', action:'up', key:e.key, modifiers:[
      e.ctrlKey && 'control', e.shiftKey && 'shift', e.altKey && 'alt', e.metaKey && 'meta'
    ].filter(Boolean) });
  });
  keyboard.addEventListener('input', () => {
    if (keyboardComposing) return;
    if (!keyboard.value) return;
    send({ type:'text', text:keyboard.value });
    keyboard.value = '';
  });
  keyboard.addEventListener('compositionstart', () => {
    keyboardComposing = true;
  });
  keyboard.addEventListener('compositionend', () => {
    keyboardComposing = false;
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
  private mode: RemoteShareMode = 'webrtc';
  private address = '';
  private port = DEFAULT_PORT;
  private streams = new Set<ServerResponse>();
  private frameTimer: NodeJS.Timeout | null = null;
  private captureBusy = false;
  private lastPointerTarget: WebContents | null = null;
  private boostUntil = 0;
  private wss: WsServer | null = null;
  // 시그널링은 한 번에 뷰어 한 명만 지원 — 여러 명이 동시에 WebRTC 로 붙는 시나리오는
  // 없다고 가정(원격 "화면 공유"는 원래 단일 조작자 전제).
  private viewerSocket: WsSocket | null = null;
  private host: RemoteShareHostWindow;

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    this.host = new RemoteShareHostWindow(getWindow);
  }

  state(error?: string): RemoteShareState {
    const tailscale = getTailscaleStatus();
    return {
      running: !!this.server,
      address: this.server ? `http://${this.address}:${this.port}` : '',
      pin: this.server && this.pinMode === 'random' ? this.pin : '',
      pinMode: this.pinMode,
      mode: this.mode,
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
    this.mode = options.mode === 'mjpeg' ? 'mjpeg' : 'webrtc';
    this.address = tailscale.address;
    const port = Number(options.port);
    this.port = Number.isFinite(port) && port > 0 && port < 65536 ? Math.floor(port) : DEFAULT_PORT;

    const server = http.createServer((req, res) => void this.handleRequest(req, res));
    this.server = server;
    const { WebSocketServer } = loadWs();
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const requestUrl = new URL(req.url || '/', `http://${this.address || '127.0.0.1'}`);
      if (this.mode !== 'webrtc' || requestUrl.pathname !== '/signal' || !this.authorized(req, requestUrl)) {
        socket.destroy();
        return;
      }
      this.wss?.handleUpgrade(req, socket, head, ws => this.handleSignalSocket(ws));
    });
    return await new Promise(resolve => {
      server.once('error', err => {
        this.stop();
        resolve(this.state(err.message));
      });
      server.listen(this.port, this.address, () => resolve(this.state()));
    });
  }

  // 뷰어 브라우저가 /signal 로 붙는 시그널링 소켓 — WebRTC offer/answer/ICE candidate 를
  // 호스트 캡처 창(RemoteShareHostWindow)과 뷰어 사이에서 그대로 중계한다. 이 서버는
  // media/입력 데이터 자체를 다루지 않고 오직 연결 협상만 중계한다.
  private handleSignalSocket(ws: WsSocket): void {
    // 이전 뷰어가 남아있으면 새 접속으로 교체(단일 조작자 전제).
    if (this.viewerSocket && this.viewerSocket !== ws) {
      try { this.viewerSocket.close(); } catch { /* already closing */ }
    }
    this.viewerSocket = ws;
    void this.host.startSession({
      onSignal: signal => {
        if (this.viewerSocket === ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(signal));
        }
      },
      onInput: (input, reply) => {
        void this.dispatchInput(input as RemoteInput).then(reply);
      },
    });
    ws.on('message', raw => {
      let signal: RemoteShareSignal;
      try { signal = JSON.parse(String(raw)); } catch { return; }
      this.host.sendRemoteSignal(signal);
    });
    ws.on('close', () => {
      if (this.viewerSocket === ws) {
        this.viewerSocket = null;
        this.host.stopSession();
      }
    });
    ws.on('error', () => { /* 'close' 가 이어서 발생해 정리된다 */ });
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
    this.host.stopSession();
    this.host.destroy();
    if (this.viewerSocket) {
      try { this.viewerSocket.close(); } catch { /* already closing */ }
    }
    this.viewerSocket = null;
    try { this.wss?.close(); } catch { /* already closed */ }
    this.wss = null;
    try { this.server?.close(); } catch {
      // Closing an already stopped server is harmless.
    }
    this.server = null;
    this.pin = '';
    this.pinMode = 'random';
    this.mode = 'webrtc';
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
      res.end(JSON.stringify({ ok: true, clients: this.streams.size, mode: this.mode }));
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
    const tick = () => {
      void this.captureFrame();
      const interval = Date.now() < this.boostUntil ? FRAME_INTERVAL_BOOST_MS : FRAME_INTERVAL_MS;
      this.frameTimer = setTimeout(tick, interval);
    };
    tick();
  }

  private stopFramePump(): void {
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;
  }

  // 입력 직후 이 시각까지는 프레임 캡처 간격을 단축해 타이핑/클릭 결과가 화면에
  // 더 빨리 반영되도록 한다(체감 지연 완화).
  private boostFrameRate(): void {
    this.boostUntil = Date.now() + FRAME_BOOST_DURATION_MS;
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

  // 좌표가 <webview>(네이버웍스 메신저 등, 별도 게스트 프로세스) 위에 있으면 host webContents
  // 로는 그 안의 DOM 에 입력이 전달되지 않는다 — Electron 의 <webview> 는 OOPIF 라 host 쪽
  // sendInputEvent 는 host 문서 히트테스트만 수행하고 게스트로 라우팅해주지 않는다. 그 결과
  // 좌표가 우연히 겹치는 다른 host 레이어(예: 메인 패널의 터미널)가 입력을 받아가 버린다.
  // 이를 피하려면 좌표 위의 <webview> 엘리먼트를 찾아 그 게스트 webContents 로 직접 보낸다.
  private async resolveTargetContents(host: WebContents, x: number, y: number): Promise<{ contents: WebContents; x: number; y: number }> {
    try {
      const webviewId = await host.executeJavaScript(`
        (() => {
          const el = document.elementFromPoint(${x}, ${y});
          const wv = el && el.closest ? el.closest('webview') : null;
          if (!wv || typeof wv.getWebContentsId !== 'function') {
            return { debug: { tag: el && el.tagName, hasClosest: !!(el && el.closest), foundWebview: !!wv } };
          }
          const rect = wv.getBoundingClientRect();
          return { id: wv.getWebContentsId(), left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        })()
      `, true).catch(err => ({ debug: { error: String(err && err.message || err) } }));
      if (webviewId && typeof webviewId.id === 'number') {
        const guest = electronWebContents.fromId(webviewId.id);
        if (guest && !guest.isDestroyed()) {
          const localX = Math.round(x - webviewId.left);
          const localY = Math.round(y - webviewId.top);
          if (localX >= 0 && localY >= 0 && localX <= webviewId.width && localY <= webviewId.height) {
            console.log(`[pepe-remote-input] resolveTarget -> webview#${webviewId.id} at (${localX},${localY})`);
            return { contents: guest, x: localX, y: localY };
          }
          console.log(`[pepe-remote-input] resolveTarget: webview found but (${localX},${localY}) outside bounds ${webviewId.width}x${webviewId.height}`);
        } else {
          console.log(`[pepe-remote-input] resolveTarget: webContents.fromId(${webviewId.id}) missing/destroyed`);
        }
      } else {
        console.log(`[pepe-remote-input] resolveTarget -> host, debug=${JSON.stringify(webviewId)}`);
      }
    } catch (err) {
      console.log('[pepe-remote-input] resolveTarget threw: ' + String((err as Error)?.message || err));
    }
    return { contents: host, x, y };
  }

  private async dispatchInput(input: RemoteInput): Promise<{ editable?: boolean }> {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return {};
    const host = win.webContents;
    const bounds = win.getContentBounds();
    if (!win.isFocused()) win.focus();

    if (input.type === 'pointer') {
      const hostX = Math.round(Math.max(0, Math.min(1, Number(input.x))) * Math.max(1, bounds.width - 1));
      const hostY = Math.round(Math.max(0, Math.min(1, Number(input.y))) * Math.max(1, bounds.height - 1));
      const { contents, x, y } = await this.resolveTargetContents(host, hostX, hostY);
      if (input.action === 'down') this.lastPointerTarget = contents;
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
      const hostX = Math.round(Math.max(0, Math.min(1, Number(input.x))) * Math.max(1, bounds.width - 1));
      const hostY = Math.round(Math.max(0, Math.min(1, Number(input.y))) * Math.max(1, bounds.height - 1));
      const { contents, x, y } = await this.resolveTargetContents(host, hostX, hostY);
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
      this.boostFrameRate();
      const target = this.lastPointerTarget && !this.lastPointerTarget.isDestroyed() ? this.lastPointerTarget : host;
      console.log(`[pepe-remote-input] key action=${input.action} key=${JSON.stringify(input.key)} target=${target === host ? 'host' : 'webview#' + target.id}`);
      if (target !== host) {
        // <webview>(OOPIF) 대상 sendInputEvent 는 mouse 는 되지만 keyboard 는 씹히는
        // 알려진 Electron 제약이 있다(electron/electron#14905, #20333) — host webContents
        // 로는 정상 동작하므로, webview 로 라우팅된 경우만 JS 주입으로 우회한다.
        if (input.action === 'down') await this.injectWebviewKey(target, input.key, input.modifiers || []);
        return {};
      }
      const modifiers = (input.modifiers || []).filter((value): value is InputModifier => (
        ['shift', 'control', 'ctrl', 'alt', 'meta', 'command', 'cmd'].includes(value)
      ));
      target.sendInputEvent({
        type: input.action === 'down' ? 'keyDown' : 'keyUp',
        keyCode: input.key,
        modifiers,
      });
      // keyDown 만으로는 브라우저의 input 이벤트(실제 문자 입력)가 발생하지 않는 대상이
      // 있다(터미널의 xterm 은 keydown 리스너로 직접 렌더링해서 문제없지만, 일반 <textarea>/
      // <input> 은 실제 문자가 찍히려면 'char' 타입 이벤트가 별도로 필요) — Ctrl/Alt/Meta
      // 조합(단축키)까지 char 로 흘리면 예기치 않은 문자가 찍히므로 일반 문자 입력일 때만 보낸다.
      const hasCombo = modifiers.some(m => ['control', 'ctrl', 'alt', 'meta', 'command', 'cmd'].includes(m));
      if (input.action === 'down' && input.key.length === 1 && !hasCombo) {
        target.sendInputEvent({ type: 'char', keyCode: input.key, modifiers });
      }
      return {};
    }
    if (input.type === 'text' && input.text) {
      this.boostFrameRate();
      const target = this.lastPointerTarget && !this.lastPointerTarget.isDestroyed() ? this.lastPointerTarget : host;
      if (target !== host) {
        await this.injectWebviewText(target, input.text);
        return {};
      }
      for (const char of [...input.text].slice(0, 512)) {
        target.sendInputEvent({ type: 'char', keyCode: char });
      }
    }
    return {};
  }

  // webview 안의 activeElement 에 문자열을 그대로 삽입한다(sendInputEvent 대신 JS 주입).
  private async injectWebviewText(target: WebContents, text: string): Promise<void> {
    const safeText = JSON.stringify(text);
    const result = await target.executeJavaScript(`
      (() => {
        const el = document.activeElement;
        if (!el) return { ok: false, reason: 'no-active-element' };
        const ok = document.execCommand('insertText', false, ${safeText});
        return { ok, tag: el.tagName, editable: el.isContentEditable, iframe: window.location.href };
      })()
    `, true).catch(err => ({ ok: false, reason: String(err && err.message || err) }));
    console.log('[pepe-remote-input] injectWebviewText result=' + JSON.stringify(result));
  }

  // webview 안에서 sendInputEvent keyDown 이 씹히는 특수키(Enter/Backspace/Delete/화살표
  // 등)를 JS 로 흉내낸다 — execCommand 로 처리되지 않는 키만 다룬다. 그 외 일반 문자키는
  // 뷰어가 별도로 'text' 메시지(input 이벤트, compositionend 등)를 보내 injectWebviewText 로 처리된다.
  private async injectWebviewKey(target: WebContents, key: string, modifiers: string[]): Promise<void> {
    const command =
      key === 'Enter' ? 'insertParagraph' :
      key === 'Backspace' ? 'delete' :
      key === 'Delete' ? 'forwardDelete' :
      null;
    if (command) {
      await target.executeJavaScript(`document.execCommand(${JSON.stringify(command)}, false)`, true).catch(() => {});
      return;
    }
    if (key.length !== 1) return; // 화살표/Tab/Escape 등은 webview 안 텍스트 입력에는 영향 없어 무시
    if (modifiers.includes('control') || modifiers.includes('meta') || modifiers.includes('cmd')) return;
    await this.injectWebviewText(target, key);
  }
}
