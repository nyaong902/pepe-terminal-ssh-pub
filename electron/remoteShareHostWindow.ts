// electron/remoteShareHostWindow.ts
// 원격 공유 WebRTC 호스트 — desktopCapturer + getUserMedia + RTCPeerConnection 은
// 브라우저(webContents) API 라 메인 프로세스에서 직접 열 수 없다. 그래서 화면에
// 보이지 않는 전용 BrowserWindow(hidden)를 하나 띄우고, 그 렌더러 안에서 mainWindow
// 화면을 캡처해 WebRTC 로 스트리밍한다. 뷰어 쪽 입력(DataChannel)은 이 창의
// preload 를 통해 IPC 로 메인 프로세스에 전달되고, 메인 프로세스가 기존
// RemoteShareServer.dispatchInput() 으로 mainWindow 에 주입한다.

import { BrowserWindow, desktopCapturer, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';

export type RemoteShareSignal =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'ice'; candidate: unknown };

export type RemoteInputMessage = { id?: number; [key: string]: unknown };

type HostEvents = {
  onSignal: (signal: RemoteShareSignal) => void;
  // 입력 메시지를 처리한 결과(예: pointer up 이후 { editable }) 를 뷰어에게 데이터채널로
  // 돌려줄 때 이 reply 콜백을 호출한다. 응답이 필요 없는 메시지(key, text, wheel)는 호출하지 않아도 된다.
  onInput: (input: RemoteInputMessage, reply: (result: unknown) => void) => void;
};

const PRELOAD_SOURCE = `
const { ipcRenderer, contextBridge } = require('electron');
contextBridge.exposeInMainWorld('remoteShareHost', {
  sendSignal: (signal) => ipcRenderer.send('remote-share-host:signal', signal),
  sendInput: (input) => ipcRenderer.send('remote-share-host:input', input),
  onInputResult: (cb) => ipcRenderer.on('remote-share-host:input-result', (_e, result) => cb(result)),
  onRemoteSignal: (cb) => ipcRenderer.on('remote-share-host:remote-signal', (_e, signal) => cb(signal)),
  onStart: (cb) => ipcRenderer.on('remote-share-host:start', () => cb()),
  onStop: (cb) => ipcRenderer.on('remote-share-host:stop', () => cb()),
});
`;

const RENDERER_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>pepe-remote-share-host</title></head>
<body>
<script>
(() => {
  let pc = null;
  let stream = null;
  let dataChannel = null;

  async function ensureStream() {
    if (stream) return stream;
    // setDisplayMediaRequestHandler(메인 프로세스)가 OS 피커 없이 mainWindow 소스를
    // 바로 돌려주도록 등록되어 있어, 여기서는 표준 getDisplayMedia 호출만 하면 된다.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    console.log('[remote-share-host] got display media stream, tracks=' + stream.getTracks().length);
    return stream;
  }

  async function startSession() {
    try {
      await stopSession();
      const media = await ensureStream();
      pc = new RTCPeerConnection({ iceServers: [] });
      for (const track of media.getTracks()) pc.addTrack(track, media);
      dataChannel = pc.createDataChannel('input', { ordered: true });
      dataChannel.addEventListener('message', ev => {
        try { window.remoteShareHost.sendInput(JSON.parse(ev.data)); } catch {}
      });
      pc.addEventListener('icecandidate', ev => {
        if (ev.candidate) window.remoteShareHost.sendSignal({ kind: 'ice', candidate: ev.candidate.toJSON() });
      });
      pc.addEventListener('connectionstatechange', () => {
        console.log('[remote-share-host] connectionState=' + pc.connectionState);
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      window.remoteShareHost.sendSignal({ kind: 'offer', sdp: pc.localDescription.sdp });
      console.log('[remote-share-host] offer sent');
    } catch (err) {
      console.log('[remote-share-host] startSession failed: ' + (err && err.message || err));
    }
  }

  async function stopSession() {
    if (dataChannel) { try { dataChannel.close(); } catch {} dataChannel = null; }
    if (pc) { try { pc.close(); } catch {} pc = null; }
  }

  window.remoteShareHost.onStart(() => { void startSession(); });
  window.remoteShareHost.onStop(() => { void stopSession(); });
  window.remoteShareHost.onInputResult(result => {
    if (dataChannel && dataChannel.readyState === 'open') {
      try { dataChannel.send(JSON.stringify(result)); } catch {}
    }
  });
  window.remoteShareHost.onRemoteSignal(async signal => {
    if (!pc) return;
    if (signal.kind === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    } else if (signal.kind === 'ice' && signal.candidate) {
      try { await pc.addIceCandidate(signal.candidate); } catch {}
    }
  });
})();
</script>
</body>
</html>`;

let preloadPath: string | null = null;
let htmlPath: string | null = null;
function ensureHostFiles(): { preload: string; html: string } {
  if (preloadPath && htmlPath && fs.existsSync(preloadPath) && fs.existsSync(htmlPath)) {
    return { preload: preloadPath, html: htmlPath };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pepe-remote-host-'));
  preloadPath = path.join(dir, 'preload.cjs');
  htmlPath = path.join(dir, 'host.html');
  fs.writeFileSync(preloadPath, PRELOAD_SOURCE, 'utf8');
  fs.writeFileSync(htmlPath, RENDERER_HTML, 'utf8');
  return { preload: preloadPath, html: htmlPath };
}

export class RemoteShareHostWindow {
  private win: BrowserWindow | null = null;
  private events: HostEvents | null = null;
  private ipcBound = false;

  constructor(private readonly getTargetWindow: () => BrowserWindow | null) {}

  private bindIpcOnce(): void {
    if (this.ipcBound) return;
    this.ipcBound = true;
    ipcMain.on('remote-share-host:signal', (_event, signal: RemoteShareSignal) => {
      this.events?.onSignal(signal);
    });
    ipcMain.on('remote-share-host:input', (_event, input: RemoteInputMessage) => {
      this.events?.onInput(input, result => {
        if (input && typeof input.id === 'number') {
          this.win?.webContents.send('remote-share-host:input-result', { id: input.id, ...(result as object) });
        }
      });
    });
  }

  // mainWindow 에 해당하는 DesktopCapturerSource 를 찾는다 — 렌더러에서는
  // desktopCapturer 를 직접 쓸 수 없으므로(Electron 17 부터 제거됨) 메인 프로세스에서
  // win.getMediaSourceId() (desktopCapturer source.id 와 동일 포맷: "window:hwnd:0")로
  // 정확히 매칭해 setDisplayMediaRequestHandler 콜백에 넘긴다 — 창 제목 매칭은 다국어/
  // 동적 타이틀·중복 제목 창이 있으면 틀릴 수 있어 쓰지 않는다.
  private async findTargetSource(): Promise<Electron.DesktopCapturerSource | null> {
    const target = this.getTargetWindow();
    if (!target || target.isDestroyed()) return null;
    const mediaSourceId = target.getMediaSourceId();
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    return sources.find(s => s.id === mediaSourceId) || null;
  }

  async ensureWindow(): Promise<BrowserWindow> {
    this.bindIpcOnce();
    if (this.win && !this.win.isDestroyed()) return this.win;
    const { preload, html } = ensureHostFiles();
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        preload,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    // hidden window 라 devtools 를 열 수 없으므로, getDisplayMedia/RTCPeerConnection 실패가
    // 조용히 묻히지 않도록 렌더러 console.* 을 메인 프로세스 콘솔로 그대로 전달한다.
    win.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
      console.log(`[remote-share-host] ${message} (${sourceId}:${line})`);
    });
    win.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
      const source = await this.findTargetSource();
      callback(source ? { video: source } : {});
    }, { useSystemPicker: false });
    // data: URL 은 opaque origin 이 되어 getDisplayMedia 등 일부 API 가 제한될 수 있어
    // file:// 로 로드한다(secure context 로 취급됨).
    await win.loadFile(html);
    this.win = win;
    return win;
  }

  async startSession(events: HostEvents): Promise<void> {
    this.events = events;
    const win = await this.ensureWindow();
    win.webContents.send('remote-share-host:start');
  }

  stopSession(): void {
    this.win?.webContents.send('remote-share-host:stop');
    this.events = null;
  }

  sendRemoteSignal(signal: RemoteShareSignal): void {
    this.win?.webContents.send('remote-share-host:remote-signal', signal);
  }

  destroy(): void {
    this.events = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
