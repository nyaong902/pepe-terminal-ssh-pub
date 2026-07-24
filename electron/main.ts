// electron/main.ts
import { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu, shell, clipboard, nativeImage, safeStorage, screen, webContents, protocol, session } from 'electron';

// 패키지된(production/설치본) 빌드에서는 메인 프로세스 console.log(진단 로그)를 끈다.
// dev 실행 시에만 [claude]/[codex]/[mcp-control] 등 디버그 로그 출력. console.error/warn 은 유지.
if (app.isPackaged) { console.log = () => {}; }

if (process.env.PEPE_CDP_DEBUG) app.commandLine.appendSwitch('remote-debugging-port', '9333');
// 백그라운드/blur 상태에서도 렌더러가 정상 동작하도록
// (Windows 에서 자식 프로세스 spawn 이 잠깐 foreground 를 뺏어가도 input/caret 영향 최소화)
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// transparent BrowserWindow + file drag-drop 은 Chromium 의 GPU 합성기/IDropTarget
// 레이어 때문에 우리 프로세스에서 드롭 이벤트를 받을 수 없는 알려진 한계.
// (3개 HWND 모두 IDropTarget COM 등록 성공해도 OS 가 GPU 프로세스 합성 윈도우로 라우팅)
// disable-direct-composition 은 캐시 에러만 만들고 효과 없어 적용 안 함.
// 사용자는 Ctrl+V (paste) 또는 📄+ 버튼(파일 픽커) 으로 첨부 가능.
// IntensiveWakeUpThrottling: Chromium 이 5분 넘게 안 보이는 프레임의 setTimeout/setInterval 을
// 1분에 1번으로 강하게 몰아버리는 기능 — 백그라운드에서도 SSH 로그가 실시간으로 나와야 하므로 끔.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
// ── 다중 인스턴스 캐시 충돌 제거 ────────────────────────────────────────────
// 여러 PePe 인스턴스를 동시에 띄우면 같은 userData 의 캐시 디렉토리를 두고 충돌해
// 'Unable to move the cache (0x5) / Gpu Cache Creation failed / Unable to create cache' 가
// 반복 출력된다. (userData/sessionData 를 인스턴스별로 분리하면 충돌은 없지만 Windows
//  safeStorage 키가 Local State 에 따로 생겨 저장된 자격증명 복호화가 깨지므로 분리 불가.)
// → 충돌의 원인인 디스크 캐시(GPU 셰이더 + HTTP)를 끈다. 터미널/SSH 앱이라 HTTP 캐시는
//   거의 쓰이지 않아 영향이 미미하고, userData 는 공유되어 자격증명은 그대로 동작.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');
// pepe-connect(휴대폰 화면 미러링, <webview> 로 plain-app 웹 UI 임베드)가 H.264/Opus 를
// 디코딩하는 데 WebCodecs API(VideoDecoder/AudioDecoder)를 쓰는데, 번들 Chromium 은 기본
// 비활성 상태라 "VideoDecoder is not defined" 로 화면이 아예 안 뜬다 — 명시적으로 켜야 함.
app.commandLine.appendSwitch('enable-blink-features', 'WebCodecs');
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import * as pty from 'node-pty';
import { fileURLToPath } from 'url';
import { loadSessionsData, saveSessionsData, getSessionsPath, saveCustomPath, loadUIPrefs, saveUIPrefs, Session, Folder, SessionsData } from './sessionsStore';
import { loadWorklog, saveWorklogDay, WorklogDay } from './worklogStore';
import { loadStickyNotes, addStickyNote, updateStickyNote, removeStickyNote, getStickyNote, StickyNote } from './stickyNotesStore';
import { xferLog } from './sshBridge';
import { getSSHBridge } from './sshBridge';
import { getSipSidecar, getAllSipSidecars, resolveBinary as resolveSipdBinary } from './sipSidecar';
import { getCaptureManager, isCaptureAvailable, listInterfaces as listCaptureInterfaces } from './captureSidecar';
import { getSippSidecar, disposeSippSidecar, resolveBinary as resolveSippBinary, type SippTestOptions } from './sippSidecar';
import { loadSippScenarios, saveSippScenario, deleteSippScenario } from './sippScenarioStore';
import { getRecents as getOfficeRecents, addRecent as addOfficeRecent, removeRecent as removeOfficeRecent } from './officeRecentsStore';
import { getMediaRecents, addMediaRecent, removeMediaRecent, updateMediaPosition } from './mediaRecentsStore';
import { getMediaPlaylist, addMediaPlaylistItems, removeMediaPlaylistItem, reorderMediaPlaylist } from './mediaPlaylistStore';
import { mediaProbeFile, mediaDecryptToTemp, decodeLocalCodec, encodeAlaw, encodeUlaw, parseWavHeader, mediaEncryptToFile, type MediaCodec } from './mediaCodec';
import { isCryptoNativeAvailable } from './cryptoNative';
import { decodeToWav, encodeFromWav, resampleWavTo8kMono, resolveBinary as resolveGstreamerBinary } from './gstreamerSidecar';
import { probePcapFile, extractRtpStreamToTemp } from './pcapParser';
import { getTelnetBridge } from './telnetBridge';
import { getSharedJdbcSidecar, shutdownAllJdbcSidecars, findSidecarJar, findJavaExecutable } from './jdbcBridge';
import { listDrivers, upsertUserDriver, removeUserDriver, diagnoseDriver, getBundledDriversRoot, getUserJdbcDriversRoot, resolveDriverJarsExisting, parseMavenCoord, mavenCoordToUrl, JdbcDriverDef } from './driversStore';
import { getSessionState as getSqlToolState, setSessionState as setSqlToolState, duplicateSessionState, SqlToolSessionState } from './sqlToolStore';
import { createWebDAVBridge } from './webdavBridge';
import { installX11DisplayHook } from './x11Display';
import { startBundledX11, stopBundledX11, stopAllBundledX11, listRunningX11 } from './x11Bundled';
import { stopEmbeddedX11 } from './x11Server';
import { getVpnService } from './vpnService';
import { ensureBundleExtracted } from './ensureBundleExtracted';
import { listLanguages, listNamespaces, loadNamespace, loadBundledNamespace, loadOverrideNamespace, saveOverrideNamespace, addLanguage, removeLanguage } from './i18nStore';
import { t, setCurrentLang } from './i18n';
import { setupAutoUpdater, checkForUpdatesOnStartup } from './updater';
import { RemoteShareServer, type RemoteShareStartOptions } from './remoteShareServer';
import { PlainAppConnectServer } from './plainAppConnectServer';
// MCP 서버 스크립트를 번들에 임베드 (vite ?raw) — 런타임에 임시 파일로 추출 후 spawn
// @ts-ignore
import mcpSshServerScript from './mcpSshServer.cjs?raw';
// @ts-ignore
import mcpLocalFsServerScript from './mcpLocalFsServer.cjs?raw';
// @ts-ignore
import claudeHookScript from './claudeHookScript.cjs?raw';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
(globalThis as any).__dirname = __dirname;

// 멀티 인스턴스 캐시 충돌 방지 — 매 실행 unique sessionData 로 분리하던 코드.
// 단점: Electron 의 safeStorage 가 sessionData 안에 키 파일(Local State 등) 두는 경우
//        매 실행마다 키가 사라져서 자격증명 복호화 실패. 그래서 비활성화.
// 대안 검토 필요: 단일 인스턴스 lock + window focus 회수 패턴 (전형적 Electron 멀티 인스턴스 처리).
// const instanceId = `${process.pid}-${Date.now()}`;
// const sessionDataPath = path.join(app.getPath('userData'), `session-${instanceId}`);
// app.setPath('sessionData', sessionDataPath);

// 오피스 워크스페이스(rhwp-studio iframe, public/rhwp-studio 에 자체 호스팅)가 File System
// Access API(showOpenFilePicker 등)를 쓰려면 top frame 과 iframe 이 "동일 origin" 이어야 한다.
// file:// 로 loadFile 하면 각 파일마다 opaque(고유) origin 이 되어 cross-origin 취급을 받으므로,
// standard 스킴으로 등록한 커스텀 프로토콜로 앱 shell 과 rhwp-studio 를 같은 origin(scheme+host)
// 아래에서 서빙한다 — path 만 다르면 origin 은 동일하게 취급된다.
// (registerSchemesAsPrivileged 는 app 'ready' 이전, 모듈 로드 시점에 호출해야 한다.)
const PEPE_PROTOCOL = 'pepeapp';
protocol.registerSchemesAsPrivileged([
  { scheme: PEPE_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
function pepeAppUrl(hash?: string): string {
  return `${PEPE_PROTOCOL}://app/index.html${hash ? '#' + hash : ''}`;
}

let mainWindow: BrowserWindow | null = null;
const remoteShareServer = new RemoteShareServer(() => mainWindow);
const plainAppConnectServer = new PlainAppConnectServer((event) => {
  const payload = event.type === 'connected'
    ? { type: 'connected', state: event.state, response: event.response }
    : { type: 'state', state: event.state };
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('plainapp:event', payload); } catch {}
  for (const w of detachedWindows) {
    try { if (!w.isDestroyed()) w.webContents.send('plainapp:event', payload); } catch {}
  }
});
// 분리된(탭 tear-off) 보조 앱 창들 — 터미널/파일전송 데이터 broadcast 대상
const detachedWindows = new Set<BrowserWindow>();
// 터미널/SFTP 데이터를 메인 + 모든 분리 창에 전달한다. 수신 측 렌더러는 자기 termId 만 처리하므로
// (모르는 panelId 는 무시) 전체 broadcast 해도 안전하다. 창이 하나뿐이면 기존과 동일하게 동작.
function termBroadcast(channel: string, payload: any) {
  // payload.panelId(=termId) 가 격리된 탭 프로세스에 등록돼 있으면 그 탭에만 보낸다 —
  // 그래야 백그라운드 탭의 대량 출력이 host/다른 탭 프로세스를 깨우지 않는다(오늘 세션에서
  // 측정한 실제 병목: 여러 패널이 같은 프로세스에서 동시에 write() 를 하는 것 자체).
  const panelId = payload?.panelId;
  const tabId = panelId ? termIdToTabId.get(panelId) : undefined;
  if (tabId && tabId !== 'host') {
    try { tabWebContentsMap.get(tabId)?.send(channel, payload); } catch {}
    return;
  }
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload); } catch {}
  for (const w of detachedWindows) { try { if (!w.isDestroyed()) w.webContents.send(channel, payload); } catch {} }
}
// tail -f 같은 고빈도 출력은 stream 'data' 이벤트가 초당 수백 번씩 발생 — 매번 개별 IPC 로
// 보내면 (구조적 복제 비용 + 렌더러 쪽 xterm 파싱/렌더 1회씩) 탭이 많아질수록 렌더러 메인
// 스레드가 포화되어 버벅임. 짧은 시간창(8ms) 동안 같은 패널의 데이터를 합쳐 IPC 1회로 축소.
//
// 렌더러가 지금 화면에 실제로 보여주고 있는 패널(termId)을 알려주면(term:set-visibility),
// 안 보이는 패널은 배치 주기를 훨씬 길게(300ms) 늘려서 IPC wake-up 빈도 자체를 줄인다.
// 앱이 포커스를 잃으면 Windows 가 렌더러 프로세스에 주는 CPU 타임슬라이스가 줄어드는데,
// 이때 탭이 여러 개 다 8ms 마다 IPC 를 깨우면 (안 보이는 탭은 어차피 xterm.write 도 안 하면서)
// 컨텍스트 스위칭 오버헤드만 늘어 활성 탭 렌더링까지 버벅이게 만든다.
const visiblePanelIds = new Set<string>();
const dataBatchBuf = new Map<string, string>();
const dataBatchScheduled = new Set<string>();
const DATA_BATCH_MS_VISIBLE = 8;
const DATA_BATCH_MS_HIDDEN = 300;
// SSH 연결이 여러 개 동시에 활발하면 메인 프로세스 이벤트 루프가 그 사이를 오가면서 타이밍이
// 밀리고, 그 결과 배치 타이머가 늦게 발동해 한 번에 훨씬 큰 덩어리가 쌓일 수 있다. xterm.js 는
// 한 번의 write() 로 들어온 텍스트를 파싱하는 데 실제로 CPU 시간이 들기 때문에(렌더링이 아니라
// 파싱 자체가 비용), 덩어리가 커질수록 그걸 한 번에 처리하며 눈에 띄게 멈칫거린다(프로파일링으로
// 확인됨: xterm 내부 _innerWrite 가 self time 대부분을 차지). IPC 로 보내는 조각 크기 자체에
// 상한을 둬서, 아무리 밀렸어도 한 번의 write() 가 처리할 양은 항상 작게 유지한다.
const DATA_CHUNK_MAX_CHARS = 32_768;
function queueTermData(channel: 'ssh:data' | 'pty:data', panelId: string, data: string) {
  const key = `${channel}:${panelId}`;
  dataBatchBuf.set(key, (dataBatchBuf.get(key) || '') + data);
  if (dataBatchScheduled.has(key)) return;
  dataBatchScheduled.add(key);
  const delay = visiblePanelIds.has(panelId) ? DATA_BATCH_MS_VISIBLE : DATA_BATCH_MS_HIDDEN;
  setTimeout(() => {
    dataBatchScheduled.delete(key);
    const merged = dataBatchBuf.get(key);
    dataBatchBuf.delete(key);
    if (!merged) return;
    if (merged.length <= DATA_CHUNK_MAX_CHARS) {
      termBroadcast(channel, { panelId, data: merged });
      return;
    }
    for (let i = 0; i < merged.length; i += DATA_CHUNK_MAX_CHARS) {
      termBroadcast(channel, { panelId, data: merged.slice(i, i + DATA_CHUNK_MAX_CHARS) });
    }
  }, delay);
}
// ── 탭별 프로세스 분리(Wave Terminal 방식) 준비 — 제네릭 relay ──────────────────
// 실제 WebContentsView 는 아직 만들지 않는다(그건 tab lifecycle 단계에서 추가).
// 지금은 모든 termId 를 'host' 탭(=mainWindow 자신)에 매핑해두어, 탭 프로세스가
// 실제로 분리되기 전에 relay 프로토콜(term:call / term:invoke / term:state-update)
// 자체가 올바르게 동작하는지 같은 프로세스 안에서 먼저 검증한다. 나중에 진짜 탭
// WebContentsView 가 생기면 termIdToTabId 매핑만 바꿔주면 되고 relay 코드는 그대로 재사용된다.
const tabWebContentsMap = new Map<string, Electron.WebContents>(); // tabId -> webContents ('host' 는 mainWindow)
const termIdToTabId = new Map<string, string>(); // termId -> tabId
const pendingTermInvokes = new Map<string, (result: any) => void>(); // requestId -> resolve

function getTabWebContentsFor(termId: string): Electron.WebContents | undefined {
  const tabId = termIdToTabId.get(termId) || 'host';
  if (tabId === 'host') return mainWindow?.webContents;
  return tabWebContentsMap.get(tabId);
}

ipcMain.on('term:register-term', (_event, { termId, tabId }: { termId: string; tabId?: string }) => {
  termIdToTabId.set(termId, tabId || 'host');
});
ipcMain.on('term:unregister-term', (_event, { termId }: { termId: string }) => {
  termIdToTabId.delete(termId);
});
// fire-and-forget 커맨드 relay (Category B/E) — 호출부가 반환값을 안 쓰는 함수들
ipcMain.on('term:call', (_event, { termId, fn, args }: { termId: string; fn: string; args: any[] }) => {
  const wc = getTabWebContentsFor(termId);
  try { wc?.send('term:dispatch', { termId, fn, args }); } catch {}
});
// 반환값이 필요한 커맨드 relay (Category C: searchInTerm 등) — request/reply
ipcMain.handle('term:invoke', (_event, { termId, fn, args }: { termId: string; fn: string; args: any[] }) => {
  const wc = getTabWebContentsFor(termId);
  if (!wc) return Promise.resolve(undefined);
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    pendingTermInvokes.set(requestId, resolve);
    try { wc.send('term:dispatch-invoke', { termId, fn, args, requestId }); } catch { pendingTermInvokes.delete(requestId); resolve(undefined); }
    // 탭 프로세스가 죽어있거나 응답이 없는 극단적 상황 대비 타임아웃
    setTimeout(() => { if (pendingTermInvokes.has(requestId)) { pendingTermInvokes.delete(requestId); resolve(undefined); } }, 5000);
  });
});
ipcMain.on('term:invoke-reply', (_event, { requestId, result }: { requestId: string; result: any }) => {
  const resolve = pendingTermInvokes.get(requestId);
  if (resolve) { pendingTermInvokes.delete(requestId); resolve(result); }
});
// 상태 캐시 push (Category A: isTermConnected 등) — 탭 프로세스가 상태 변경 시점마다 보내고,
// host 는 이걸 termStateCache 에 반영만 한다(폴링 없음).
ipcMain.on('term:state-update', (_event, { termId, patch }: { termId: string; patch: any }) => {
  try { mainWindow?.webContents.send('term:state-update', { termId, patch }); } catch {}
});
// ── 탭 간 세션 이동(release/adopt) ────────────────────────────────────────
// 세션을 옮길 때 원본/대상 둘 중 하나라도 격리된 탭/패널 프로세스면, 레이아웃 트리를
// 직접 조작(같은 프로세스 가정)할 수 없다 — 실제 소유 프로세스에 release(내보내기)/
// adopt(받기)를 relay 해서, 그 프로세스 자신의 React 상태를 직접 바꾸게 한다.
function getWebContentsForTabId(tabId: string): Electron.WebContents | undefined {
  if (tabId === 'host') return mainWindow?.webContents;
  return tabWebContentsMap.get(tabId);
}
ipcMain.on('tab:release-session', (_event, { tabId, payload }: { tabId: string; payload: any }) => {
  try { getWebContentsForTabId(tabId)?.send('tab:release-session', payload); } catch {}
});
ipcMain.on('tab:adopt-session', (_event, { tabId, payload }: { tabId: string; payload: any }) => {
  try { getWebContentsForTabId(tabId)?.send('tab:adopt-session', payload); } catch {}
});

// ── 개발용 PoC: 이 frameless/transparent BrowserWindow 위에 실제 WebContentsView 가
// 붙고 렌더링되는지 먼저 검증(6단계 본 작업 전 최대 리스크 지점 선확인). 앱 UI 는 전혀
// 건드리지 않는 별도 경로 — dev:toggle-poc-view IPC 로만 생성/토글된다.
let pocView: InstanceType<typeof WebContentsView> | null = null;
ipcMain.handle('dev:toggle-poc-view', () => {
  if (!mainWindow) return false;
  if (pocView) {
    mainWindow.contentView.removeChildView(pocView);
    pocView.webContents.close();
    pocView = null;
    return false;
  }
  pocView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  pocView.setBounds({ x: 60, y: 120, width: 640, height: 420 });
  mainWindow.contentView.addChildView(pocView);
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'] || process.env['VITE_DEV_SERVER_URL'];
  if (!app.isPackaged && devServerUrl) {
    pocView.webContents.loadURL(devServerUrl + '#tab-poc');
  } else {
    pocView.webContents.loadURL(pepeAppUrl('tab-poc'));
  }
  return true;
});

// ── 실제 탭 프로세스 분리 lifecycle ────────────────────────────────────────
// 워크스페이스 탭 하나를 별도 WebContentsView 프로세스로 분리한다. 여러 개가 동시에
// tabViews 에 있을 수 있지만(백그라운드 탭도 살아있어야 하므로), setVisible 로 현재
// activeTabId 인 것만 보이게 하고 나머지는 숨긴다 — 다만 숨겨도 프로세스/렌더는 계속 돈다
// (backgroundThrottling: false 로 백그라운드 SSH 출력도 실시간 유지, 사용자 요구사항).
const tabViews = new Map<string, InstanceType<typeof WebContentsView>>();

function loadTabView(view: InstanceType<typeof WebContentsView>, viewId: string, route?: string) {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'] || process.env['VITE_DEV_SERVER_URL'];
  const hash = route || `tab-app?tabId=${encodeURIComponent(viewId)}`;
  if (!app.isPackaged && devServerUrl) {
    view.webContents.loadURL(devServerUrl + '#' + hash);
  } else {
    view.webContents.loadURL(pepeAppUrl(hash));
  }
}

// viewId 는 탭 격리든(예: 'tab-1') 패널 격리든(예: 'panel:node-abc') 그냥 문자열 키 —
// tabViews/tabWebContentsMap 은 어느 쪽이든 동일하게 다룬다. route 를 넘기면 그 해시로 로드
// (패널 격리는 '#panel-app?...', 탭 격리는 기본 '#tab-app?tabId=...').
ipcMain.handle('tab:create-view', (_event, { tabId, route }: { tabId: string; route?: string }) => {
  if (!mainWindow || tabViews.has(tabId)) return false;
  // backgroundThrottling:false — mainWindow 와 동일하게, 안 보이는 동안에도 GPU/타이머가
  // 죽지 않게(격리된 탭/패널은 백그라운드에서도 실시간 출력을 유지해야 하는 요구사항).
  const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false } });
  view.setVisible(false);
  mainWindow.contentView.addChildView(view);
  loadTabView(view, tabId, route);
  tabViews.set(tabId, view);
  tabWebContentsMap.set(tabId, view.webContents); // term:call/term:invoke relay 가 이 뷰를 찾을 수 있도록
  return true;
});
// 개발용 검증 헬퍼 — 격리된 탭들이 실제로 서로 다른 OS 프로세스인지 확인용 (host+각 탭의 PID).
ipcMain.handle('dev:get-tab-pids', () => {
  const result: Record<string, number> = {};
  if (mainWindow) result['host'] = mainWindow.webContents.getOSProcessId();
  for (const [tabId, view] of tabViews) result[tabId] = view.webContents.getOSProcessId();
  return result;
});
// 개발용 — termId->tabId 라우팅 매핑 확인 (SSH 이벤트가 엉뚱한 프로세스로 가는지 디버깅용).
ipcMain.handle('dev:get-term-tab-map', () => Object.fromEntries(termIdToTabId));

// ── 임시: 문서화용 스크린샷 캡처 ────────────────────────────────────────────
// 격리된 탭(WebContentsView, 예: 브라우저/오피스/SQL Tool)은 mainWindow 위에 별도로 얹힌
// 자체 GPU 합성 레이어라 일반 OS 화면 캡처 도구로는 안 잡힌다(검은 박스로 보임) — 이 핸들러는
// Chromium 자체 리드백 API(webContents.capturePage)로 메인 윈도우 + 그 위에 떠 있는 격리 탭들을
// 각각 읽어 sharp 로 올바른 위치에 합성해서 완전한 스크린샷 하나로 저장한다.
ipcMain.handle('dev:capture-screenshot', async () => {
  const dbgDir = path.join(app.getPath('userData'), 'doc-captures');
  const dbgLog = (msg: string) => { try { fs.mkdirSync(dbgDir, { recursive: true }); fs.appendFileSync(path.join(dbgDir, 'debug.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch {} };
  dbgLog('handler invoked');
  if (!mainWindow) { dbgLog('no mainWindow'); return { success: false, error: 'no window' }; }
  try {
    dbgLog('requiring sharp...');
    const sharp = require('sharp');
    dbgLog('sharp ok, capturing mainWindow...');
    const baseImg = await mainWindow.webContents.capturePage();
    dbgLog(`mainWindow captured, empty=${baseImg.isEmpty()}`);
    const layers: { input: Buffer; left: number; top: number }[] = [];
    for (const [, view] of tabViews) {
      try {
        let visible = true;
        try { visible = typeof (view as any).getVisible === 'function' ? (view as any).getVisible() : true; } catch {}
        if (!visible) continue;
        const b = view.getBounds();
        if (!b || b.width <= 0 || b.height <= 0) continue;
        const img = await view.webContents.capturePage();
        if (img.isEmpty()) continue;
        layers.push({ input: img.toPNG(), left: b.x, top: b.y });
      } catch {}
    }
    dbgLog(`layers=${layers.length}, compositing...`);
    let pipeline = sharp(baseImg.toPNG());
    if (layers.length) pipeline = pipeline.composite(layers);
    const dir = path.join(app.getPath('userData'), 'doc-captures');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `capture-${Date.now()}.png`);
    await pipeline.png().toFile(file);
    dbgLog(`saved ${file}`);
    return { success: true, file, layers: layers.length };
  } catch (e: any) {
    dbgLog(`ERROR: ${String(e?.stack || e?.message || e)}`);
    return { success: false, error: String(e?.message || e) };
  }
});
// 실제 탭이 닫힐 때만 호출 — 탭 전환(다른 탭으로 이동)으로는 절대 호출되지 않는다.
// (뷰 생성/파괴는 isolatedTabIds 멤버십 + 실제 탭 존재 여부로만 결정 — 렌더 마운트/언마운트와 무관.)
ipcMain.on('tab:destroy-view', (_event, { tabId }: { tabId: string }) => {
  const view = tabViews.get(tabId);
  if (!view || !mainWindow) return;
  try { mainWindow.contentView.removeChildView(view); } catch {}
  try { view.webContents.close(); } catch {}
  tabViews.delete(tabId);
  tabWebContentsMap.delete(tabId);
  // 이 탭이 소유했던 termId 매핑도 정리 (누수 방지)
  for (const [termId, tid] of termIdToTabId) if (tid === tabId) termIdToTabId.delete(termId);
});
// 탭이 화면에 실제로 보이는지(활성 탭 또는 split-right 탭) 여부만 다룬다 — 안 보인다고
// 뷰를 파괴하지 않는다(백그라운드에서도 세션이 살아있어야 하므로). 여러 탭이 동시에
// visible=true 일 수 있음(activeTab + splitRightTab 동시 표시).
ipcMain.on('tab:set-visibility', (_event, { tabId, visible, bounds }: { tabId: string; visible: boolean; bounds?: { x: number; y: number; width: number; height: number } }) => {
  const view = tabViews.get(tabId);
  if (!view) return;
  view.setVisible(visible);
  if (visible && bounds) view.setBounds(bounds);
});

let sessionsData: SessionsData = { folders: [], sessions: [] };
const connectedPanels = new Set<string>();
const connectingPanels = new Set<string>();
// 텔넷(raw TCP)으로 접속한 패널 — ssh:input/resize/disconnect 등을 텔넷 브리지로 라우팅
const telnetPanels = new Set<string>();

// Safety net — ssh2 같은 라이브러리에서 뒤늦게 던지는 stray error 로 앱 전체가
// 다이얼로그와 함께 죽지 않도록 uncaught 를 로깅만 하고 삼킨다.
// 치명적 원인은 소스에서 제대로 처리해야 하지만, 최소한 사용자 경험 보호용.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
  try { mainWindow?.webContents.send('debug:log', `[uncaughtException] ${err?.message || err}`); } catch {}
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  try { mainWindow?.webContents.send('debug:log', `[unhandledRejection] ${(reason as any)?.message || reason}`); } catch {}
});
ipcMain.on('debug:log', (_e, msg: any) => {
  try { mainWindow?.webContents.send('debug:log', String(msg ?? '')); } catch {}
});

// 커맨드라인에서 전달된 초기 경로 (탐색기 우클릭 → "터미널에서 열기")
function getStartupCwd(): string | null {
  // 1) 커맨드라인 인자에서 경로 탐색
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    try {
      const stat = fs.statSync(arg);
      if (stat.isDirectory()) return arg;
      if (stat.isFile()) return path.dirname(arg);
    } catch {}
  }
  // 2) 임시 파일에서 경로 읽기 (portable 대응)
  const tmpFile = path.join(require('os').tmpdir(), '.pepe-terminal-cwd');
  try {
    const fileStat = fs.statSync(tmpFile);
    // 30초 이내 생성된 파일만 사용 (이전 세션 잔여 파일 무시)
    const tooOld = Date.now() - fileStat.mtimeMs > 30000;
    // 읽기 후 즉시 삭제 (어떤 경우든 파일은 삭제)
    const cwd = tooOld ? '' : fs.readFileSync(tmpFile, 'utf8').trim();
    fs.unlinkSync(tmpFile);
    if (cwd) {
      try {
        const dirStat = fs.statSync(cwd);
        if (dirStat.isDirectory()) return cwd;
        if (dirStat.isFile()) return path.dirname(cwd);
      } catch {}
    }
  } catch {
    // 파일이 없거나 읽기 실패 — 삭제 한번 더 시도
    try { fs.unlinkSync(tmpFile); } catch {}
  }
  return null;
}
let startupCwd: string | null = getStartupCwd();

// 외부 프로그램(HIWARE/자산관리툴 등)이 "터미널 프로그램"으로 PePe 를 호출하면서
// 넘겨주는 접속 정보 파싱. 자산관리툴마다 터미널별 파라미터 형식이 제각각이라 모두 지원:
//   • SecureCRT/Xshell : ... telnet://<IP>:<PORT> ...   (URL 형식)
//   • PuTTY            : -telnet <IP> <PORT>  (또는 -ssh <IP> -P <PORT>)
//   • TeraTerm         : /T=1 <IP>:<PORT>     (bare host:port 토큰)
// telnet:// 은 자산관리툴의 URL 관례일 뿐, 실제 대상은 SSH 서버이므로 host:port 만
// 뽑아 SSH 로 접속한다. <TITLE_CHANGE_OFF>, /url, -newtab, "<TITLE>" 등 나머지 인자는 무시.
// telnet:// / -telnet / bare host:port 는 접근통제 솔루션의 평문 프록시 → protocol 'telnet'.
// ssh:// / -ssh 는 실제 SSH → 'ssh'. (telnet 으로 잡힌 건 PePe 가 raw TCP 로 접속)
type StartupSsh = { host: string; port: number; username?: string; password?: string; protocol: 'ssh' | 'telnet' };
function getStartupSshTarget(): StartupSsh | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  // 1) URL 형식: ssh://... / telnet://...  (SecureCRT, Xshell)
  const urlRe = /(ssh|telnet):\/\/(?:([^:@/\s]+)(?::([^@/\s]+))?@)?([^:/\s]+)(?::(\d+))?/i;
  for (const a of args) {
    const m = urlRe.exec(a);
    if (m) {
      return {
        protocol: m[1].toLowerCase() === 'ssh' ? 'ssh' : 'telnet',
        username: m[2] ? decodeURIComponent(m[2]) : undefined,
        password: m[3] ? decodeURIComponent(m[3]) : undefined,
        host: m[4],
        port: m[5] ? parseInt(m[5], 10) : (m[1].toLowerCase() === 'ssh' ? 22 : 23),
      };
    }
  }
  // 2) PuTTY: -telnet <IP> <PORT>  /  -ssh <IP> [-P <PORT>]
  const lower = args.map(a => a.toLowerCase());
  const flagIdx = lower.findIndex(a => a === '-telnet' || a === '-ssh');
  if (flagIdx >= 0) {
    const isSsh = lower[flagIdx] === '-ssh';
    let host: string | null = null;
    let port = isSsh ? 22 : 23;
    let portSeen = false;
    for (let i = flagIdx + 1; i < args.length; i++) {
      const tok = args[i];
      if (!tok || tok.startsWith('-') || tok.startsWith('/')) continue;
      if (!host) { host = tok; continue; }
      if (/^\d+$/.test(tok)) { port = parseInt(tok, 10); portSeen = true; break; }
    }
    const pIdx = lower.findIndex(a => a === '-p');
    if (pIdx >= 0 && /^\d+$/.test(args[pIdx + 1] || '')) { port = parseInt(args[pIdx + 1], 10); portSeen = true; }
    void portSeen;
    if (host) return { host, port, protocol: isSsh ? 'ssh' : 'telnet' };
  }
  // 3) bare host:port 토큰 (TeraTerm /T=1 <IP>:<PORT>) — 접근통제 평문 프록시로 간주(telnet)
  for (const a of args) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*):(\d{1,5})$/.exec(a);
    if (m) return { host: m[1], port: parseInt(m[2], 10), protocol: 'telnet' };
  }
  return null;
}
let startupSshTarget: StartupSsh | null = getStartupSshTarget();

function ensureTempScript(fileName: string, content: string) {
  const fullPath = path.join(os.tmpdir(), fileName);
  try {
    const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
    if (existing !== content) fs.writeFileSync(fullPath, content, 'utf-8');
  } catch (err) {
    console.error('[temp-script] write failed:', fileName, err);
  }
  return fullPath;
}

function safeJsonArray(value: any) {
  try {
    return JSON.stringify(Array.isArray(value) ? value : []);
  } catch {
    return '[]';
  }
}

function normalizeLocalAttachmentRoots(localAttachmentRoots?: string[]) {
  const roots = Array.isArray(localAttachmentRoots) ? localAttachmentRoots : [];
  return Array.from(new Set(roots.map(r => String(r || '').trim()).filter(r => !!r && fs.existsSync(r))));
}

function buildLocalFsMcpEnv(localRoots: string[]) {
  return {
    PEPE_LOCAL_ROOTS: safeJsonArray(localRoots),
    ELECTRON_RUN_AS_NODE: '1',
  };
}

type AiMirrorSession = {
  panelId: string;
  remotePath: string;
  localRoot: string;
  isDir: boolean;
  bundleRoot: string;
  watcher?: fs.FSWatcher;
  timer?: NodeJS.Timeout;
  pendingPaths: Set<string>;
  syncing: boolean;
};

const aiMirrorSessions = new Map<string, AiMirrorSession>();
const aiMirrorPending = new Map<string, { bundleRoot: string; aborted: boolean }>();
const aiMirrorSessionKey = (panelId: string, remotePath: string) => `${panelId}:${remotePath}`;
function aiMirrorLog(msg: string) {
  console.log('[ai-mirror]', msg);
  try { mainWindow?.webContents.send('debug:log', `[ai-mirror] ${msg}`); } catch {}
}

function normalizeRemotePathJoin(basePath: string, relPath: string) {
  const rel = String(relPath || '').replace(/[\\/]+/g, '/').replace(/^\/+/, '');
  if (!rel) return basePath;
  return String(basePath || '').replace(/[\\/]+$/g, '') + '/' + rel;
}

async function ensureRemoteDirRecursive(panelId: string, remoteDir: string) {
  const bridge: any = getSSHBridge();
  const clean = String(remoteDir || '').replace(/[\\/]+$/g, '');
  if (!clean) return;
  const parts = clean.split('/').filter(Boolean);
  if (parts.length === 0) return;
  const isAbs = clean.startsWith('/');
  let cur = isAbs ? '/' : '';
  for (const part of parts) {
    cur = cur === '/' ? `/${part}` : (cur ? `${cur}/${part}` : part);
    try { await bridge.handleSFTPMkdir(panelId, cur); } catch {}
  }
}

function scheduleMirrorSync(session: AiMirrorSession, delay = 1200) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    void flushMirrorSync(session);
  }, delay);
}

async function flushMirrorSync(session: AiMirrorSession) {
  if (session.syncing) {
    scheduleMirrorSync(session, 250);
    return;
  }
  const pending = Array.from(session.pendingPaths);
  session.pendingPaths.clear();
  if (pending.length === 0) return;
  session.syncing = true;
  try {
    const uniq = Array.from(new Set(pending.map(p => path.resolve(p))));
    aiMirrorLog(`flush start panel=${session.panelId} remote=${session.remotePath} items=${uniq.length}`);
    for (const p of uniq) await syncMirrorLocalPath(session, p);
  } finally {
    session.syncing = false;
    if (session.pendingPaths.size > 0) scheduleMirrorSync(session, 250);
    else aiMirrorLog(`flush done panel=${session.panelId} remote=${session.remotePath}`);
  }
}

async function syncMirrorLocalPath(session: AiMirrorSession, localPath: string) {
  const bridge: any = getSSHBridge();
  const pending = aiMirrorPending.get(aiMirrorSessionKey(session.panelId, session.remotePath));
  if (pending?.aborted) return;
  const abs = path.resolve(localPath);
  const rootAbs = path.resolve(session.localRoot);
  const remoteBase = String(session.remotePath || '');
  const rel = path.relative(rootAbs, abs);
  const remotePath = rel ? normalizeRemotePathJoin(remoteBase, rel) : remoteBase;
  try {
    if (!fs.existsSync(abs)) {
      aiMirrorLog(`skip remote delete panel=${session.panelId} remote=${remotePath} reason=local-missing`);
      return;
    }
    if (pending?.aborted) return;
    const st = await fs.promises.stat(abs);
    if (st.isDirectory()) {
      aiMirrorLog(`sync dir panel=${session.panelId} local=${abs} remote=${remotePath}`);
      await ensureRemoteDirRecursive(session.panelId, remotePath);
      let localEntries: fs.Dirent[] = [];
      try {
        localEntries = await fs.promises.readdir(abs, { withFileTypes: true });
      } catch {}
      for (const entry of localEntries) {
        const childLocal = path.join(abs, entry.name);
        await syncMirrorLocalPath(session, childLocal);
      }
      return;
    }
    if (pending?.aborted) return;
    if (st.size > 10 * 1024 * 1024) return;
    const parentRemote = remotePath.includes('/') ? remotePath.slice(0, remotePath.lastIndexOf('/')) : '';
    if (parentRemote) await ensureRemoteDirRecursive(session.panelId, parentRemote);
    const buf = await fs.promises.readFile(abs);
    const text = await decodeRemoteText(buf);
    aiMirrorLog(`write remote panel=${session.panelId} local=${abs} remote=${remotePath} bytes=${buf.length}`);
    await bridge.handleSFTPWriteFile(session.panelId, remotePath, text);
  } catch (err) {
    console.error('[ai-mirror] sync failed:', session.panelId, session.remotePath, localPath, err);
  }
}

function disposeAiMirrorSession(panelId: string, remotePath: string) {
  const key = aiMirrorSessionKey(panelId, remotePath);
  const pending = aiMirrorPending.get(key);
  if (pending) {
    pending.aborted = true;
    try { fs.rmSync(pending.bundleRoot, { recursive: true, force: true }); } catch {}
    aiMirrorPending.delete(key);
  }
  const session = aiMirrorSessions.get(key);
  if (!session) return { success: true, removed: false };
  aiMirrorLog(`dispose panel=${panelId} remote=${remotePath}`);
  try { if (session.timer) clearTimeout(session.timer); } catch {}
  try { session.watcher?.close(); } catch {}
  aiMirrorSessions.delete(key);
  try { fs.rmSync(session.bundleRoot, { recursive: true, force: true }); } catch {}
  return { success: true, removed: true };
}

function disposeAiMirrorPanel(panelId: string) {
  const keys = new Set<string>();
  for (const key of aiMirrorSessions.keys()) {
    if (key.startsWith(`${panelId}:`)) keys.add(key);
  }
  for (const key of aiMirrorPending.keys()) {
    if (key.startsWith(`${panelId}:`)) keys.add(key);
  }
  let removed = false;
  for (const key of keys) {
    const [pId, ...rest] = key.split(':');
    const remotePath = rest.join(':');
    removed = !!disposeAiMirrorSession(pId, remotePath) || removed;
  }
  return { success: true, removed };
}

function registerAiMirrorSession(panelId: string, remotePath: string, localRoot: string, isDir: boolean, bundleRoot: string) {
  const key = aiMirrorSessionKey(panelId, remotePath);
  const existing = aiMirrorSessions.get(key);
  if (existing) {
    aiMirrorLog(`replace existing panel=${panelId} remote=${remotePath}`);
    try { if (existing.timer) clearTimeout(existing.timer); } catch {}
    try { existing.watcher?.close(); } catch {}
    aiMirrorSessions.delete(key);
    try { fs.rmSync(existing.bundleRoot, { recursive: true, force: true }); } catch {}
  }
  try { fs.mkdirSync(localRoot, { recursive: true }); } catch {}
  const session: AiMirrorSession = { panelId, remotePath, localRoot, isDir, bundleRoot, pendingPaths: new Set(), syncing: false };
  try {
    aiMirrorLog(`register panel=${panelId} remote=${remotePath} localRoot=${localRoot} kind=${isDir ? 'dir' : 'file'}`);
    const startWatcher = (recursive: boolean) => fs.watch(localRoot, { recursive }, (_eventType, filename) => {
      const rel = filename ? String(filename).replace(/^[\\/]+/, '') : '';
      const changed = rel ? path.join(localRoot, rel) : localRoot;
      aiMirrorLog(`watch event panel=${panelId} remote=${remotePath} change=${changed}`);
      session.pendingPaths.add(changed);
      scheduleMirrorSync(session);
    });
    try {
      session.watcher = startWatcher(!!isDir);
    } catch (err) {
      aiMirrorLog(`recursive watcher fallback panel=${panelId} remote=${remotePath} err=${String((err as any)?.message || err)}`);
      session.watcher = startWatcher(false);
    }
  } catch (err) {
    console.error('[ai-mirror] watcher failed:', err);
  }
  aiMirrorSessions.set(key, session);
  return session;
}

// 창 최대화 상태 + 복원 좌표
let isMaximized = false;
let savedBounds = { x: 100, y: 100, width: 1400, height: 900 };

function createWindow() {
  if (app.isPackaged) Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, '../public/icon.ico'),
    frame: false,
    transparent: true,
    // transparent + drag-drop 의 Chromium 합성 이슈 우회 — 명시적 backgroundColor
    // 지정 시 일부 케이스에서 drop 이벤트가 렌더러로 정상 라우팅됨.
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false, // 준비 완료 후 표시
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true, // 브라우저 워크스페이스 (<webview>) 활성화
      // 창이 포커스를 잃거나 다른 창에 가려져도 Chromium 이 setTimeout/rAF 를 스로틀링하지
      // 않도록 — 꺼두지 않으면 백그라운드에서 SSH 로그 출력이 버벅이며 지연됨.
      backgroundThrottling: false,
    },
  });

  // 콘텐츠 렌더링 완료 후 창 표시 (빈 화면 방지)
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // Aero Snap 미리보기 창 사전 생성 + 로드 — 첫 드래그 시 BrowserWindow 생성 지연(수백ms) 제거
    setTimeout(() => ensureSnapPreview(), 500);
  });


  const devServerUrl = process.env['ELECTRON_RENDERER_URL'] || process.env['VITE_DEV_SERVER_URL'];
  if (!app.isPackaged && devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    // DevTools 자동 오픈 제거 — detach 창이 항상 300MB+ 를 추가로 잡아먹음.
    // 필요하면 Ctrl+Shift+I (또는 F12) 로 수동으로 열 수 있음.
  } else {
    mainWindow.loadURL(pepeAppUrl());
  }

  // transparent BrowserWindow 에서 Chromium 이 drop 이벤트를 렌더러로 전달하지 못해도
  // 파일을 드롭하면 file:// URL 로 navigate 를 시도함. 이 navigate 를 가로채서:
  //   1) 페이지 이동은 차단 (preventDefault)
  //   2) URL 에서 파일 경로를 추출해 렌더러로 IPC 전송 → ClaudeChat 이 첨부 처리
  // 결과: drop 이벤트가 안 와도 file drop 자체는 작동.
  const fileUrlToPath = (fileUrl: string): string | null => {
    try {
      let u = decodeURI(fileUrl.replace(/^file:\/{2,}/, ''));
      // Windows: file:///C:/foo → C:/foo 추출. /가 leading 이면 제거
      if (/^[A-Za-z]:[/\\]/.test(u)) return u.replace(/\//g, '\\');
      if (u.startsWith('/')) u = u.slice(1);
      if (/^[A-Za-z]:[/\\]/.test(u)) return u.replace(/\//g, '\\');
      return u || null;
    } catch { return null; }
  };
  // ── 외부 파일 드래그앤드롭 백스톱 ──────────────────────────────────────────
  // 패키지 빌드(file:// origin)에서 렌더러가 drop 을 preventDefault 하지 못하고 흘려보내면
  // Chromium 이 드롭한 파일로 navigate/download 를 시도한다. 그걸 가로채 경로만 추출해
  // 렌더러(AI Chat)로 전달. (정상 경로는 렌더러의 window drop 핸들러가 직접 처리)
  // ※ dev 모드(http://localhost)에서는 http→file navigate 가 보안 차단되어 발화하지 않음 —
  //    드래그앤드롭은 패키지 설치본에서 테스트해야 함.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // http(s) 외부 링크(예: AI 채팅 메시지 내 URL) → 앱 창을 덮지 않고 기본 브라우저로 연다.
    if (/^https?:\/\//i.test(url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
      return;
    }
    if (!url.startsWith('file://')) return;
    const cur = mainWindow?.webContents.getURL() || '';
    if (url === cur) return;
    event.preventDefault();
    const fp = fileUrlToPath(url);
    if (fp && fs.existsSync(fp)) {
      console.log('[drag-drop] will-navigate intercepted →', fp);
      mainWindow?.webContents.send('chat:external-file-dropped', { path: fp });
    }
  });
  // will-download — Chromium 이 navigate 대신 다운로드로 처리하는 경우(zip 등)
  mainWindow.webContents.session.on('will-download', (event, item) => {
    const url = item.getURL();
    if (url.startsWith('file://')) {
      event.preventDefault();
      const fp = fileUrlToPath(url);
      if (fp && fs.existsSync(fp)) {
        console.log('[drag-drop] will-download intercepted →', fp);
        mainWindow?.webContents.send('chat:external-file-dropped', { path: fp });
      }
      return;
    }
    // 오피스 워크스페이스(rhwp-studio / office-editor iframe) 내부 "저장" 메뉴가 blob: 다운로드로
    // 문서를 내보낼 때 — 조용히 Downloads 폴더에 저장되는 기본 동작 대신 저장 위치를 고르는
    // 네이티브 다이얼로그를 띄운다.
    const fileName = item.getFilename();
    const ext = path.extname(fileName).toLowerCase();
    const OFFICE_SAVE_FILTERS: Record<string, { name: string; extensions: string[] }> = {
      '.hwp': { name: 'HWP Document', extensions: ['hwp'] },
      '.hwpx': { name: 'HWPX Document', extensions: ['hwpx'] },
      '.docx': { name: 'Word Document', extensions: ['docx'] },
      '.xlsx': { name: 'Excel Workbook', extensions: ['xlsx'] },
      '.pptx': { name: 'PowerPoint Presentation', extensions: ['pptx'] },
      '.pdf': { name: 'PDF Document', extensions: ['pdf'] },
    };
    const filter = OFFICE_SAVE_FILTERS[ext];
    if (filter) {
      item.setSaveDialogOptions({ title: '문서 저장', defaultPath: fileName, filters: [filter] });
    }
  });
  // will-frame-navigate 도 보강
  mainWindow.webContents.on('will-frame-navigate' as any, (event: any, url: any) => {
    if (typeof url === 'string' && url.startsWith('file://')) {
      event.preventDefault();
      const fp = fileUrlToPath(url);
      if (fp && fs.existsSync(fp)) {
        console.log('[drag-drop] frame file navigate intercepted → renderer:', fp);
        mainWindow?.webContents.send('chat:external-file-dropped', { path: fp });
      }
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('file://')) {
      const fp = fileUrlToPath(url);
      if (fp && fs.existsSync(fp)) {
        console.log('[drag-drop] window-open file intercepted → renderer:', fp);
        mainWindow?.webContents.send('chat:external-file-dropped', { path: fp });
      }
      return { action: 'deny' };
    }
    // http(s) 새 창 요청(target=_blank 등) → 기본 브라우저로 열고 앱 내 새 창은 막음
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 타이틀바 더블클릭 → 최대화 토글
  mainWindow.on('maximize', () => {
    console.log('[window] maximize event, bounds:', mainWindow?.getBounds());
    isMaximized = true;
    mainWindow?.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    console.log('[window] unmaximize event, bounds:', mainWindow?.getBounds(), 'savedBounds:', savedBounds);
    isMaximized = false;
    // savedBounds의 위치/크기로 강제 복원 (Windows native restore 좌표 오류 방지)
    if (mainWindow) {
      const cur = mainWindow.getBounds();
      if (cur.x !== savedBounds.x || cur.y !== savedBounds.y || cur.width !== savedBounds.width || cur.height !== savedBounds.height) {
        mainWindow.setBounds(savedBounds);
      }
    }
    mainWindow?.webContents.send('window:maximized', false);
  });
  // non-maximized 상태에서 resize/move가 멈춘 후 300ms 뒤 savedBounds 갱신 (debounce)
  let savedBoundsTimer: NodeJS.Timeout | null = null;
  const updateSaved = () => {
    if (savedBoundsTimer) clearTimeout(savedBoundsTimer);
    savedBoundsTimer = setTimeout(() => {
      if (!mainWindow || isMaximized || mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
      savedBounds = mainWindow.getBounds();
    }, 300);
  };
  mainWindow.on('resize', updateSaved);
  mainWindow.on('move', updateSaved);

  mainWindow.on('closed', onMainWindowClosed);
}

// 메인 창(또는 승격된 창)이 닫힐 때 — 부수창 정리 + 살아있는 분리 창 중 하나를 새 main 으로 승격,
// 없으면 앱 종료.
function onMainWindowClosed() {
  for (const [, pw] of pasteWindows) { try { if (!pw.isDestroyed()) pw.close(); } catch {} }
  const aliveDetached = Array.from(detachedWindows).filter(w => w && !w.isDestroyed());
  if (aliveDetached.length > 0) {
    const promoted = aliveDetached[0];
    mainWindow = promoted;
    detachedWindows.delete(promoted);
    promoted.on('closed', onMainWindowClosed);
    console.log(`[main] mainWindow closed — promoting detached window (id=${promoted.id}); ${aliveDetached.length - 1} other detached survive`);
    return;
  }
  mainWindow = null;
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.destroy(); } catch {}
    }
  } catch {}
  console.log('[main] no windows left — forcing exit');
  // before-quit 핸들러 발동을 기다리지 않고, 자식 프로세스(taskkill)와 자체 exit 를 즉시 큐잉.
  // app.quit() 은 신호로만 보내고 의존하지 않음.
  try { app.quit(); } catch {}
  // before-quit 가 동기 cleanup 할 시간 ~50ms 후 hard exit. taskkill 도 백업으로 같이 큐잉.
  if (process.platform === 'win32') {
    try {
      require('child_process').spawn('taskkill', ['/pid', String(process.pid), '/T', '/F'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {}
  }
  setTimeout(() => { try { process.exit(0); } catch {} }, 100);
  setImmediate(() => { try { process.exit(0); } catch {} });
}

// ── App lifecycle ──

// 자기서명 인증서 / 사설 CA 서버 접속 허용 — 내부 인프라 (172.x, 10.x, 192.168.x) 가 흔히 self-signed.
// 브라우저 워크스페이스의 <webview> 와 fetch 모두에 영향. 외부 공용 사이트는 일반적으로 정상 cert 라 영향 없음.
// 보안 트레이드오프: 이 앱은 신뢰된 내부 도구 환경 가정. 공용 사이트의 MITM 까지 허용되므로 주의.
app.on('certificate-error', (event, _webContents, url, error, _certificate, callback) => {
  console.warn('[certificate-error] allowing', { url, error });
  event.preventDefault();
  callback(true);
});

// 브라우저 워크스페이스의 <webview> 에서 window.open / target="_blank" 로 팝업이 뜨는 경우
// 새 BrowserWindow 대신 host 렌더러로 URL 을 알려 새 탭으로 처리.
app.on('web-contents-created', (_e, contents) => {
  try {
    if (contents.getType() !== 'webview') return;
    // did-stop-loading 등 네비게이션 이벤트에 대한 MaxListenersExceededWarning 이 계속 떴는데,
    // 렌더러 쪽 addEventListener 는 idempotency guard 로 이미 1회로 확인됐고, dom-ready 시점에
    // 렌더러→IPC 로 setMaxListeners 를 올리는 것도 시도했지만 비동기 라운드트립이라 실제 리스너가
    // 붙는 시점(구글 홈페이지처럼 iframe 이 여러 개인 페이지는 서브프레임 attach 가 매우 빨리
    // 연달아 일어남)보다 늦게 적용되는 레이스가 있었던 것으로 보인다. 게스트 WebContents 가
    // 생성되는 바로 이 시점(동기, 어떤 프레임도 아직 attach 되기 전)에 즉시 한도를 올려서
    // 그 레이스 자체를 없앤다.
    contents.setMaxListeners(50);
    contents.setWindowOpenHandler(({ url }) => {
      // hostWebContents 가 undefined 인 케이스 대비 — 모든 BrowserWindow 에 브로드캐스트.
      // 렌더러 측이 자신의 webview guestId 와 매칭해 자신 것만 처리.
      try {
        const host = (contents as any).hostWebContents as Electron.WebContents | undefined;
        if (host && !host.isDestroyed()) {
          host.send('browser-webview:new-window', { guestId: contents.id, url });
        } else {
          BrowserWindow.getAllWindows().forEach(w => {
            try { if (!w.isDestroyed()) w.webContents.send('browser-webview:new-window', { guestId: contents.id, url }); } catch {}
          });
        }
      } catch {}
      return { action: 'deny' };
    });
  } catch (e) {
    console.warn('[web-contents-created] webview open handler wire failed', e);
  }
});

// 시작 시 %TEMP% 의 오래된 잔여 임시파일 정리 — 작업마다 timestamp 로 생성되어 누적되는 것들.
// 30분 이상 된 것만 삭제 (동시 실행 중인 다른 인스턴스의 활성 파일 보호).
function cleanupStaleTempFiles() {
  try {
    const dir = os.tmpdir();
    const now = Date.now();
    const MAX_AGE = 30 * 60 * 1000; // 30분
    // 우리 앱이 만드는 임시 파일/폴더 패턴 (timestamp 접미)
    const patterns = [
      /^pepe-gemini-\d+/, /^pepe-xshell-import-\d+/, /^pepe-desktop-\d+/,
      /^pepe-mypc-\d+/, /^pepe-shell-\d+/, /^pepe-drives-\d+/,
      /^pepe-ext-icon-list-\d+/, /^pepe-ext-icons-\d+/, /^pepe-icon-list-\d+/,
      /^pepe-icons-batch-\d+/, /^pepe-shellicon-\d+/, /^pepe-icon-\d+/,
      /^pepe-mermaid-src\.txt$/, /^pepe-autotrack-/, /^pepe-pwd-/, /^pepe-mcp-\d+/,
      /^pepe-ai-mirror-/, /^pepe-mcp-localfs-server\.cjs$/,
      /^gemini-prompt-\d+/, /^gemini-mcp-\d+/, /^claude-mcp-\d+/,
      /^pepe-sipd\.log$/, // SIP 사이드카 파일 로그 제거 (env 설정 안 했을 때 잔존 정리)
      /^pepe-agy-\d+/,    // Antigravity CLI 로그/리포트 (정상 종료 시 본인이 지우지만 비정상 종료 잔존)
      /^pepe-agy-report-\d+/, /^pepe-agy-cont-\d+/,
      /^pepe-mcp-ssh-server\.cjs$/, /^pepe-claude-hook\.cjs$/, /^pepe-claude-hook-wrap\.cmd$/, // 매 기동 시 재생성되는 정적 스크립트
    ];
    // 매 기동 시 재생성되는 파일은 mtime 무관하게 즉시 삭제 — 가동 중 잠겨있지 않음 (스크립트 생성 전 단계).
    const forceDeletePatterns = [
      /^pepe-sipd\.log$/,
      /^pepe-mcp-ssh-server\.cjs$/, /^pepe-claude-hook\.cjs$/, /^pepe-claude-hook-wrap\.cmd$/,
    ];
    for (const name of fs.readdirSync(dir)) {
      if (!patterns.some(re => re.test(name))) continue;
      const full = path.join(dir, name);
      try {
        // forceDelete 패턴은 mtime 무관 즉시 삭제 (정적 이름 또는 사용 안 함)
        if (forceDeletePatterns.some(re => re.test(name))) { try { fs.rmSync(full, { force: true }); } catch {} continue; }
        const st = fs.statSync(full);
        if (now - st.mtimeMs < MAX_AGE) continue; // 최근 것은 보존
        fs.rmSync(full, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
  // 채팅/메신저 첨부 임시 복사본(pepe-chat-attachments) — 재첨부하거나 앱을 재시작해도 계속 쌓이므로
  // 같은 나이 기반 정책으로 정리. 다른 PePe 인스턴스가 방금 만든 파일은 아직 "오래된" 게 아니라서
  // 자연히 보호됨 (PID 추적 없이도 멀티 인스턴스 안전).
  try {
    const attachDir = path.join(os.tmpdir(), 'pepe-chat-attachments');
    if (fs.existsSync(attachDir)) {
      const now = Date.now();
      const MAX_AGE = 60 * 60 * 1000; // 60분 — 첨부는 좀 더 오래 들고 있을 수 있어 여유를 둠
      for (const name of fs.readdirSync(attachDir)) {
        const full = path.join(attachDir, name);
        try {
          const st = fs.statSync(full);
          if (now - st.mtimeMs < MAX_AGE) continue;
          fs.rmSync(full, { force: true });
        } catch {}
      }
    }
  } catch {}
}

const PEPE_INSTANCE_REGISTRY_FILE = path.join(os.tmpdir(), 'pepe-instance-registry.json');
const PEPE_INSTANCE_LOCK_FILE = path.join(os.tmpdir(), 'pepe-instance-registry.lock');

type PepeInstanceRecord = { pid: number; startedAt: number };

function withInstanceRegistryLock<T>(fn: () => T): T {
  const deadline = Date.now() + 1500;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(PEPE_INSTANCE_LOCK_FILE, 'wx');
      try { return fn(); } finally {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(PEPE_INSTANCE_LOCK_FILE); } catch {}
      }
    } catch (err: any) {
      if (fd != null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (Date.now() >= deadline) return fn();
      try { if (!fs.existsSync(PEPE_INSTANCE_LOCK_FILE)) continue; } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function readInstanceRegistry(): PepeInstanceRecord[] {
  try {
    const raw = fs.readFileSync(PEPE_INSTANCE_REGISTRY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is PepeInstanceRecord => !!x && Number.isFinite(x.pid) && Number.isFinite(x.startedAt)) : [];
  } catch {
    return [];
  }
}

function writeInstanceRegistry(records: PepeInstanceRecord[]) {
  try {
    fs.writeFileSync(PEPE_INSTANCE_REGISTRY_FILE, JSON.stringify(records), 'utf-8');
  } catch {}
}

function pruneDeadInstanceRecords(records: PepeInstanceRecord[]) {
  return records.filter(r => {
    try {
      process.kill(r.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

function registerPepeInstance() {
  const now = Date.now();
  withInstanceRegistryLock(() => {
    const next = pruneDeadInstanceRecords(readInstanceRegistry());
    if (!next.some(r => r.pid === process.pid)) next.push({ pid: process.pid, startedAt: now });
    writeInstanceRegistry(next);
  });
}

function unregisterPepeInstanceAndMaybeCleanup() {
  let shouldCleanup = false;
  withInstanceRegistryLock(() => {
    const current = pruneDeadInstanceRecords(readInstanceRegistry()).filter(r => r.pid !== process.pid);
    writeInstanceRegistry(current);
    shouldCleanup = current.length === 0;
  });
  if (shouldCleanup) scheduleDetachedTempCleanup();
}

function scheduleDetachedTempCleanup() {
  const cleanupScript = String.raw`
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const dir = os.tmpdir();
    const patterns = [
      /^pepe-gemini-\d+/, /^pepe-xshell-import-\d+/, /^pepe-desktop-\d+/,
      /^pepe-mypc-\d+/, /^pepe-shell-\d+/, /^pepe-drives-\d+/,
      /^pepe-ext-icon-list-\d+/, /^pepe-ext-icons-\d+/, /^pepe-icon-list-\d+/,
      /^pepe-icons-batch-\d+/, /^pepe-shellicon-\d+/, /^pepe-icon-\d+/,
      /^pepe-mermaid-src\.txt$/, /^pepe-autotrack-/, /^pepe-pwd-/, /^pepe-mcp-\d+/,
      /^pepe-ai-mirror-/, /^pepe-mcp-localfs-server\.cjs$/, /^pepe-mcp-ssh-server\.cjs$/,
      /^pepe-codex-home-/, /^pepe-agy-/, /^pepe-agy-report-/, /^pepe-agy-cont-/,
      /^gemini-prompt-\d+/, /^gemini-mcp-\d+/, /^claude-mcp-\d+/, /^claude-prompt-\d+/,
      /^codex-prompt-\d+/, /^pepe-quick-share-/, /^pepe-openvpn-/, /^pepe-openvpn-auth-/,
      /^pepe-claude-hook(\.cjs|\.cmd)?$/, /^claude-settings-\d+\.json$/,
      /^claude-mcp-\d+.*\.json$/, /^gemini-settings-\d+\.json$/, /^gemini-mcp-\d+.*\.json$/,
    ];
    const isTarget = (name) => patterns.some(re => re.test(name));
    const rm = (full) => { try { fs.rmSync(full, { recursive: true, force: true }); } catch {} };
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!isTarget(name)) continue;
        rm(path.join(dir, name));
      }
    } catch {}
  `;
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', cleanupScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
  } catch {}
}

function cleanupAiMirrorTempRoots(force = false) {
  try {
    const dir = os.tmpdir();
    const liveRoots = new Set<string>();
    for (const session of aiMirrorSessions.values()) {
      if (session?.bundleRoot) liveRoots.add(path.resolve(session.bundleRoot));
    }
    for (const name of fs.readdirSync(dir)) {
      if (!/^pepe-ai-mirror-/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (!force && liveRoots.has(path.resolve(full))) continue;
        fs.rmSync(full, { recursive: true, force: true });
        aiMirrorLog(`cleanup temp root ${full}`);
      } catch (err) {
        console.warn('[ai-mirror] cleanup failed:', full, err);
      }
    }
  } catch {}
}

// net.fetch(file://...) 를 그대로 리턴하면 Response.url 이 file:// 로 남아 Chromium 이 이 프레임의
// origin 을 file:// 로 취급해버린다 (주소창엔 pepeapp://app 이 떠도 실제 origin 은 opaque file://) —
// 그러면 iframe 이 여전히 cross-origin 취급되어 File System Access API 가 막힌다. 그래서 파일을
// 직접 읽어 file:// URL 이 전혀 섞이지 않는 새 Response 를 만들어 돌려준다.
const PEPE_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
app.whenReady().then(() => {
  // pepe-connect(휴대폰 화면 미러링) 는 폰이 즉석에서 만든 자체서명 HTTPS(8443)로 접속하는데,
  // 위 certificate-error 이벤트는 일반 문서/서브리소스 로드에만 적용되고 WebSocket(wss://) 핸드셰이크와
  // Service Worker 스크립트 페치에는 신뢰성 있게 적용되지 않는 게 Electron 의 알려진 한계다
  // (electron/electron#15709, #19748) — 그래서 WebSocket 이 "closed before the connection is
  // established" 로 반복 실패하고, 그 WebSocket 으로만 되는 로그인/실시간 미러링이 간헐적으로
  // 안 되거나 여러 번 재시도된 뒤에야 겨우 붙었다. setCertificateVerifyProc 은 인증서 검증
  // 로직 자체를 가로채므로 WebSocket 을 포함한 모든 연결에 적용되어 이 문제를 근본적으로 없앤다.
  // pepe-connect 전용 partition 에만 적용해 다른 세션(브라우저 워크스페이스 등)에는 영향 없음.
  // session.fromPartition() 은 app.ready 이전에는 호출할 수 없어 반드시 이 블록 안에 있어야 한다.
  session.fromPartition('persist:pepe-connect').setCertificateVerifyProc((_request, callback) => {
    callback(0); // 0 = net::OK(신뢰함). 이 partition 은 로컬 pepe-connect 페어링 전용이라 안전.
  });

  // pepeapp://app/... → dist/... 로 매핑. office-editor/rhwp-studio/flowchart-editor 는 설치 시
  // 선택 해제될 수 있는 대용량 번들(build/installer.nsh 참고)이라 dist(app.asar) 밖의
  // resources/<name>(패키지) 또는 repo resources/<name>(dev) 에서 별도로 서빙한다 — asar 안에 있으면
  // 설치 후 부분 삭제가 불가능하기 때문.
  const EXTERNAL_STATIC_DIRS = new Set(['office-editor', 'rhwp-studio', 'flowchart-editor']);
  protocol.handle(PEPE_PROTOCOL, async (request) => {
    const requestUrl = new URL(request.url);
    const { pathname } = requestUrl;
    const relPath = decodeURIComponent(pathname === '' ? '/' : pathname);
    const topSeg = relPath.split('/').filter(Boolean)[0];
    if (topSeg === '__local-file') {
      const rawPath = String(requestUrl.searchParams.get('path') || '').trim();
      if (!rawPath) return new Response('Bad Request', { status: 400 });
      const filePath = path.resolve(rawPath);
      try {
        const data = await fs.promises.readFile(filePath);
        const mime = PEPE_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        return new Response(data, { status: 200, headers: { 'content-type': mime } });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }
    const isExternal = !!topSeg && EXTERNAL_STATIC_DIRS.has(topSeg);
    if (isExternal && app.isPackaged) {
      // 포터블 빌드는 customInstall 을 안 거쳐서 zip 이 안 풀려있을 수 있다 — 처음 요청이 올 때 풀어준다.
      const marker: Record<string, string> = { 'office-editor': '_headers', 'rhwp-studio': 'favicon.ico', 'flowchart-editor': 'clear.html' };
      ensureBundleExtracted(topSeg as string, topSeg as string, marker[topSeg as string] || '');
    }
    const baseDir = isExternal
      ? (app.isPackaged ? path.join(process.resourcesPath, topSeg) : path.join(process.cwd(), 'resources', topSeg))
      : path.join(__dirname, '../dist');
    const stripPrefix = isExternal ? '/' + topSeg : '';
    // Next.js 정적 export(office-editor) 는 확장자 없는 라우트를 /editor.html 로 내보낸다(디렉터리
    // index.html 이 아니라). Caddyfile 의 try_files 규칙과 동일하게: 정확한 경로 → path.html →
    // path/index.html 순으로 시도 — rhwp-studio(디렉터리+index.html)와 office-editor(플랫 .html) 양쪽 다 커버.
    const candidates = relPath.endsWith('/')
      ? [relPath + 'index.html']
      : [relPath, `${relPath}.html`, `${relPath}/index.html`];
    for (const candidate of candidates) {
      const rel = stripPrefix && candidate.startsWith(stripPrefix) ? (candidate.slice(stripPrefix.length) || '/') : candidate;
      const filePath = path.join(baseDir, rel);
      try {
        const data = await fs.promises.readFile(filePath);
        const mime = PEPE_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        return new Response(data, { status: 200, headers: { 'content-type': mime } });
      } catch { /* try next candidate */ }
    }
    return new Response('Not Found', { status: 404 });
  });
  sessionsData = loadSessionsData();
  cleanupStaleTempFiles();
  cleanupAiMirrorTempRoots(false);
  registerPepeInstance();
  createWindow();
  if (loadUIPrefs().stickyNoteAutoShow !== false) restoreStickyNotes();
  installX11DisplayHook();
  void messengerStartService();

  // 자동 업데이트 (GitHub Releases) — IPC 배선 + 시작 시 1회 확인
  setupAutoUpdater(() => mainWindow);
  checkForUpdatesOnStartup();

  // ── SFTP 고빈도 이벤트 배치 버퍼 ──────────────────────────────────────────
  // file-start / dir-list / complete / progress 를 setImmediate 로 묶어
  // webContents.send 호출 횟수를 최소화 → 터미널 I/O 이벤트 우선 처리 보장.
  // (setImmediate 는 Node 이벤트루프 "check" 단계 실행 — I/O poll 이후이므로
  //  SSH 소켓 수신 데이터가 먼저 처리된 뒤 IPC 전송이 일어남)
  const sftpBatchBuf: Array<{ channel: string; payload: any }> = [];
  let sftpBatchScheduled = false;
  function flushSftpBatch() {
    sftpBatchScheduled = false;
    if (!sftpBatchBuf.length || !mainWindow) return;
    const batch = sftpBatchBuf.splice(0);
    termBroadcast('sftp:batch', batch);
  }
  function queueSftpEvent(channel: string, payload: any) {
    sftpBatchBuf.push({ channel, payload });
    if (!sftpBatchScheduled) { sftpBatchScheduled = true; setImmediate(flushSftpBatch); }
  }

  // TELNET 브리지 — 평문 raw TCP. SSH 와 동일한 ssh:* 렌더러 채널로 메시지 라우팅.
  getTelnetBridge().onMessage((msg) => {
    if (!mainWindow) return;
    switch (msg.type) {
      case 'data':
        queueTermData('ssh:data', msg.panelId, msg.data);
        break;
      case 'connected':
        connectingPanels.delete(msg.panelId);
        connectedPanels.add(msg.panelId);
        termBroadcast('ssh:connected', { panelId: msg.panelId });
        break;
      case 'closed':
        connectingPanels.delete(msg.panelId);
        connectedPanels.delete(msg.panelId);
        telnetPanels.delete(msg.panelId);
        termBroadcast('ssh:closed', { panelId: msg.panelId });
        break;
      case 'error':
        connectingPanels.delete(msg.panelId);
        termBroadcast('ssh:error', { panelId: msg.panelId, error: msg.error });
        break;
    }
  });

  const bridge = getSSHBridge();
  bridge.onMessage((msg) => {
    if (!mainWindow) return;

    switch (msg.type) {
      case 'data':
        if (msg.panelId) queueTermData('ssh:data', msg.panelId, msg.data || '');
        break;
      case 'connected':
        connectingPanels.delete(msg.panelId);
        connectedPanels.add(msg.panelId);
        termBroadcast('ssh:connected', { panelId: msg.panelId });
        break;
      case 'closed':
        connectingPanels.delete(msg.panelId);
        connectedPanels.delete(msg.panelId);
        termBroadcast('ssh:closed', { panelId: msg.panelId });
        break;
      case 'error':
        connectingPanels.delete(msg.panelId);
        termBroadcast('ssh:error', { panelId: msg.panelId, error: msg.error });
        break;
      case 'auth-prompt':
        termBroadcast('ssh:auth-prompt', { panelId: msg.panelId, prompts: msg.prompts });
        break;
      case 'sftp-progress':
        // progress 는 고빈도 — 배치로 묶어 전송
        queueSftpEvent('sftp:progress', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-complete':
        // complete 는 고빈도 — 배치로 묶어 전송
        queueSftpEvent('sftp:complete', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-error':
        termBroadcast('sftp:error', { panelId: msg.panelId, error: msg.error, data: (msg as any).data });
        break;
      case 'sftp-transfer-start':
        // 전송 시작은 즉시 — UI 에 즉각 표시
        termBroadcast('sftp:transfer-start', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-file-start':
        // file-start 는 고빈도 — 배치로 묶어 전송
        queueSftpEvent('sftp:file-start', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-dir-list':
        // dir-list 는 고빈도 — 배치로 묶어 전송
        queueSftpEvent('sftp:dir-list', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-conflict':
        // conflict 는 즉시 — 사용자 응답 대기
        termBroadcast('sftp:conflict', { panelId: msg.panelId, data: msg.data });
        break;
      case 'auto-track':
        termBroadcast('ssh:auto-track', { panelId: msg.panelId, enabled: msg.enabled });
        break;
      case 'pwd':
        termBroadcast('ssh:pwd', { panelId: msg.panelId, pwd: (msg as any).data });
        break;
      case 'x11-log':
        // x11 관련 로그를 renderer 콘솔로 — DevTools 에서 확인
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.executeJavaScript(`console.log('[X11]', ${JSON.stringify(msg.data)})`).catch(() => {}); } catch {}
        // [hint] 로 시작하는 사용자 친화 안내는 터미널에도 노란색으로 표시
        if (typeof msg.data === 'string' && msg.data.includes('[hint]')) {
          const body = msg.data.replace(/^\[[^\]]+\]\s*/, '');
          const colored = body.split('\n').map(l => `\x1b[33m${l}\x1b[0m`).join('\r\n');
          termBroadcast('ssh:data', { panelId: msg.panelId, data: `\r\n${colored}\r\n` });
        }
        break;
      case 'sftp-delete-start':
        termBroadcast('sftp:delete-start', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-delete-progress':
        // delete-progress 고빈도 — 배치로 묶어 전송
        queueSftpEvent('sftp:delete-progress', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-delete-complete':
        termBroadcast('sftp:delete-complete', { panelId: msg.panelId, data: msg.data });
        break;
    }
  });
});

ipcMain.handle('remote-share:state', () => remoteShareServer.state());
ipcMain.handle('remote-share:start', (_event, options?: RemoteShareStartOptions) => remoteShareServer.start(options));
ipcMain.handle('remote-share:stop', () => remoteShareServer.stop());
ipcMain.handle('plainapp:state', () => plainAppConnectServer.state());
ipcMain.handle('plainapp:start', () => plainAppConnectServer.ensureStarted());
ipcMain.handle('plainapp:stop', () => plainAppConnectServer.stop());
ipcMain.handle('plainapp:reset-request', () => plainAppConnectServer.resetRequest());

app.on('window-all-closed', () => {
  // 단일 윈도우 앱 — macOS 에서도 마지막 창 닫히면 완전 종료 (activate 핸들러 없어 dock 클릭으로 복귀 불가).
  app.quit();
});

app.on('before-quit', () => {
  unregisterPepeInstanceAndMaybeCleanup();
});

// 앱 종료 직전 — 띄워놓은 모든 VcXsrv/embedded X 서버 + 활성 SSH 세션 정리.
// PTY/Claude 자식 프로세스 정리는 파일 하단에서 추가 등록 (Map 선언 후).
// WebDAV 는 별도 종료 API 가 없지만 SSH 끊으면 의존 스트림이 모두 close.
app.on('before-quit', () => {
  // 종료 안전 장치 — 어떤 cleanup 도 실패해도 강제 종료가 무조건 진행되도록 setTimeout 을 가장 먼저 큐잉.
  setTimeout(() => { try { process.exit(0); } catch {} }, 600);
  try { remoteShareServer.stop(); } catch {}
  try { plainAppConnectServer.stop(); } catch {}
  try { stopAllBundledX11(); } catch {}
  try { for (const s of getAllSipSidecars()) s.dispose(); } catch {}
  try { getCaptureManager().stopAll(); } catch {}
  try { getSSHBridge().disconnectAll(); } catch {}
  try { shutdownAllJdbcSidecars(); } catch {}
  // 매 기동 시 재생성되는 정적 임시 스크립트 정리 — %TEMP% 에 남아 있는 것 즉시 삭제.
  try {
    for (const name of ['pepe-mcp-ssh-server.cjs', 'pepe-claude-hook.cjs', 'pepe-claude-hook-wrap.cmd', 'pepe-sipd.log']) {
      try { fs.rmSync(path.join(os.tmpdir(), name), { force: true }); } catch {}
    }
  } catch {}
});

// 앱 시작 5초 후 비동기로 과거 session-* 폴더 정리 (현재 더 이상 안 만드는데 기존 orphan 잔존 가능)
setTimeout(() => {
  try {
    const userDataDir = app.getPath('userData');
    for (const entry of fs.readdirSync(userDataDir)) {
      if (!entry.startsWith('session-')) continue;
      try { fs.rmSync(path.join(userDataDir, entry), { recursive: true }); } catch {}
    }
  } catch {}
}, 5000);

// ── Session IPC ──

ipcMain.handle('sessions:path', () => {
  try { return getSessionsPath(); }
  catch { return ''; }
});

ipcMain.handle('sessions:set-path', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t('dialog.sessionsPathTitle'),
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const newPath = path.join(result.filePaths[0], 'sessions.json');
  saveCustomPath(newPath);
  // 새 경로에서 데이터 다시 로드
  sessionsData = loadSessionsData();
  return { path: newPath, data: sessionsData };
});

ipcMain.handle('sessions:reset-path', () => {
  saveCustomPath(null);
  sessionsData = loadSessionsData();
  return { path: getSessionsPath(), data: sessionsData };
});

ipcMain.handle('sessions:open-folder', () => {
  try { shell.openPath(path.dirname(path.join(app.getPath('userData'), 'sessions.json'))); }
  catch {}
});

ipcMain.handle('sessions:open-editor', () => {
  try { shell.openPath(path.join(app.getPath('userData'), 'sessions.json')); }
  catch {}
});

ipcMain.handle('ui-prefs:get', () => loadUIPrefs());
ipcMain.handle('ui-prefs:set', (_e, prefs: Record<string, any>) => { saveUIPrefs(prefs); return true; });
// 작업일지 — 앱 전체에서 공유되는 일별 todo 저장소.
ipcMain.handle('worklog:get-all', () => loadWorklog());
function emitWorklogState() {
  const state = loadWorklog();
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('worklog:event', { type: 'state', state }); } catch {}
  }
  return state;
}
function pad2(n: number) {
  return String(n).padStart(2, '0');
}
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
type WorklogSharePayload = {
  sourceDate: string;
  sourceTodo: {
    id: string;
    text: string;
    done: boolean;
    memo?: string;
    createdAt: number;
    doneAt?: number;
  };
  sourcePeerId?: string;
  sourcePeerName?: string;
  sourceMessageId?: string;
};
function normalizeWorklogSharePayload(raw: any): WorklogSharePayload | null {
  const src = raw && typeof raw === 'object' ? raw : {};
  const todoRaw = src.sourceTodo || src.todo || src.item || {};
  const text = String(todoRaw.text || '').trim();
  if (!text) return null;
  const sourceDate = String(src.sourceDate || src.date || localDateStr()).slice(0, 10) || localDateStr();
  return {
    sourceDate,
    sourceTodo: {
      id: String(todoRaw.id || src.sourceTodoId || src.id || `share-${Date.now()}`),
      text,
      done: !!todoRaw.done,
      memo: typeof todoRaw.memo === 'string' ? todoRaw.memo : undefined,
      createdAt: Number(todoRaw.createdAt) || Date.now(),
      doneAt: Number(todoRaw.doneAt) || undefined,
    },
    sourcePeerId: String(src.sourcePeerId || src.peerId || src.fromId || ''),
    sourcePeerName: String(src.sourcePeerName || src.name || src.fromName || ''),
    sourceMessageId: String(src.sourceMessageId || src.messageId || ''),
  };
}
function messengerWorklogShareSummary(share: WorklogSharePayload) {
  const parts = [share.sourceDate, share.sourceTodo.text].filter(Boolean);
  return parts.length > 0 ? `🗓️ ${parts.join(' · ')}` : '🗓️ 작업일지 공유';
}
ipcMain.handle('worklog:save-day', (_e, { date, day }: { date: string; day: WorklogDay }) => {
  saveWorklogDay(date, day);
  emitWorklogState();
  return true;
});

// 작업일지 알람 — 1분마다 모든 날짜를 스캔해 도달한 알람(remindAt<=now, 아직 안 울린 것)을
// 찾아 렌더러에 broadcast 하고, 다시 안 울리도록 remindNotified 를 표시해 저장한다.
// main 프로세스에서 도는 이유: 창이 백그라운드/최소화 상태여도(렌더러의 setInterval 은
// Chromium 이 스로틀링할 수 있음) 항상 정확히 체크되어야 하기 때문.
function scanWorklogReminders() {
  const data = loadWorklog();
  const now = Date.now();
  for (const [date, day] of Object.entries(data.days)) {
    let changed = false;
    const nextTodos = day.todos.map(todo => {
      if (!todo.remindAt || todo.remindNotified || todo.remindAt > now) return todo;
      changed = true;
      for (const win of BrowserWindow.getAllWindows()) {
        try { win.webContents.send('worklog:reminder', { date, todo }); } catch {}
      }
      return { ...todo, remindNotified: true };
    });
    if (changed) saveWorklogDay(date, { ...day, todos: nextTodos });
  }
}
setInterval(scanWorklogReminders, 60_000);
// 앱 기동 시 곧바로 한 번 — 창이 닫혀있던 사이 지나버린 알람(remindAt 이 과거)도 뜨자마자 확인.
setTimeout(scanWorklogReminders, 5_000);
// 윈도우 테마 변경 — 저장 후 모든 창(메인/옵션·세션편집 팝아웃/분리된 탭)에 broadcast → 라이브 반영.
ipcMain.handle('window-theme:set', (_e, id: string) => {
  const themeId = String(id || '');
  try { saveUIPrefs({ windowTheme: themeId }); } catch {}
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send('window-theme:changed', themeId); } catch {}
  }
  return true;
});

// ── LAN Mini Messenger ─────────────────────────────────────────────
type MessengerPeer = { id: string; name: string; host: string; port: number; lastSeen: number; online?: boolean };
type MessengerMessage = {
  id: string;
  peerId: string;
  direction: 'in' | 'out';
  kind: 'text' | 'file' | 'sticker' | 'worklog-share';
  text?: string;
  fileName?: string;
  filePath?: string;
  size?: number;
  ts: number;
  read?: boolean;
  recalled?: boolean;
  worklogShare?: WorklogSharePayload;
  shareStatus?: 'pending' | 'accepted' | 'rejected';
  shareHandledAt?: number;
};
type MessengerPrefs = { enabled?: boolean; displayName?: string; retainEnabled?: boolean; retainDays?: number; downloadDir?: string; hidePresence?: boolean; popupNotify?: boolean; popupStyle?: 'toast' | 'center' | 'edge'; popupHoldSec?: number };
type MessengerEmoticonAsset = { name: string; path: string; size: number; updatedAt: number; ext: string };
type MessengerEmoticonPack = { id: string; name: string; rootDir: string; cover: MessengerEmoticonAsset; items: MessengerEmoticonAsset[] };

const MSG_DISCOVERY_PORT = 39455;
// Presence: a peer is "online" while we've heard from it within this window.
// We send keepalive hellos every MSG_KEEPALIVE_MS, so the window must comfortably
// absorb a few dropped UDP packets (lossy on Wi-Fi / broadcast-filtered switches).
const MSG_KEEPALIVE_MS = 3000;
const MSG_ONLINE_WINDOW_MS = 35_000;
let messengerUdp: any = null;
let messengerTcp: any = null;
let messengerTimer: any = null;
let messengerId = '';
let messengerPort = 0;
let messengerPrefs: MessengerPrefs = {};
const messengerPeers = new Map<string, MessengerPeer>();
let messengerMessages: MessengerMessage[] = [];
const MESSENGER_EMOTICON_EXTS = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp']);

function messengerEmoticonRoots(): string[] {
  const roots = new Set<string>();
  const override = String(process.env.PEPE_EMOTICON_ROOT || '').trim();
  if (override) roots.add(path.resolve(override));
  if (app.isPackaged) roots.add(path.join(path.dirname(app.getPath('exe')), 'messenger-emoticons'));
  roots.add(path.join(app.getPath('userData'), 'messenger-emoticons'));
  return [...roots];
}

function messengerReadEmoticonAssets(dir: string): MessengerEmoticonAsset[] {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const filePath = path.join(dir, entry.name);
        const ext = path.extname(entry.name).toLowerCase();
        if (!MESSENGER_EMOTICON_EXTS.has(ext)) return null;
        const st = fs.statSync(filePath);
        return {
          name: entry.name,
          path: filePath,
          size: st.size,
          updatedAt: st.mtimeMs,
          ext,
        } as MessengerEmoticonAsset;
      })
      .filter((v): v is MessengerEmoticonAsset => !!v)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  } catch {
    return [];
  }
}

function messengerReadEmoticonPacks(): MessengerEmoticonPack[] {
  const packs: MessengerEmoticonPack[] = [];
  const seen = new Set<string>();
  for (const rootDir of messengerEmoticonRoots()) {
    try {
      if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) continue;
      const entries = fs.readdirSync(rootDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      for (const entry of entries) {
        const packName = entry.name.trim();
        if (!packName) continue;
        const key = packName.toLowerCase();
        if (seen.has(key)) continue;
        const packDir = path.join(rootDir, entry.name);
        const assets = messengerReadEmoticonAssets(packDir);
        if (assets.length === 0) continue;
        const cover = assets[0];
        packs.push({
          id: `${rootDir}::${entry.name}`,
          name: packName,
          rootDir: packDir,
          cover,
          items: assets.slice(1),
        });
        seen.add(key);
      }
    } catch {}
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function messengerDir() {
  const dir = path.join(app.getPath('userData'), 'messenger');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function messengerMessagesPath() { return path.join(messengerDir(), 'messages.json'); }
function messengerIdentityPath() { return path.join(messengerDir(), 'identity.json'); }
function messengerPeersPath() { return path.join(messengerDir(), 'peers.json'); }
function messengerDownloadsDir() {
  const dir = messengerPrefs.downloadDir || path.join(messengerDir(), 'downloads');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function messengerEmit(payload: any) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('messenger:event', payload); } catch {}
  }
}
function messengerLoadIdentity() {
  const crypto = require('crypto');
  const { execFileSync } = require('child_process');
  const stableId = () => {
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true });
        const m = out.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
        if (m?.[1]) return `pepe-${crypto.createHash('sha256').update(`win:${m[1].trim()}`).digest('hex').slice(0, 24)}`;
      }
    } catch {}
    try {
      const seed = `${os.hostname()}|${os.userInfo().username}|${os.platform()}|${os.arch()}`;
      return `pepe-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
    } catch {
      return '';
    }
  };
  try {
    const obj = JSON.parse(fs.readFileSync(messengerIdentityPath(), 'utf8'));
    if (obj?.id) messengerId = String(obj.id);
  } catch {}
  if (!messengerId) {
    messengerId = stableId() || `pepe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try { fs.writeFileSync(messengerIdentityPath(), JSON.stringify({ id: messengerId }, null, 2), 'utf8'); } catch {}
  }
}
function messengerLoadPeers() {
  try {
    const raw = JSON.parse(fs.readFileSync(messengerPeersPath(), 'utf8'));
    if (Array.isArray(raw)) {
      messengerPeers.clear();
      for (const p of raw) {
        if (p?.id) messengerPeers.set(String(p.id), {
          id: String(p.id),
          name: String(p.name || 'PePe'),
          host: String(p.host || ''),
          port: Number(p.port) || 0,
          lastSeen: Number(p.lastSeen) || 0,
        });
      }
    }
  } catch {}
}
function messengerSavePeers() {
  try { fs.writeFileSync(messengerPeersPath(), JSON.stringify([...messengerPeers.values()].map(({ online, ...p }) => p), null, 2), 'utf8'); } catch {}
}
function messengerLoadMessages() {
  try {
    const raw = JSON.parse(fs.readFileSync(messengerMessagesPath(), 'utf8'));
    messengerMessages = Array.isArray(raw) ? raw : [];
  } catch { messengerMessages = []; }
  messengerPruneMessages();
}
function messengerSaveMessages() {
  try { fs.writeFileSync(messengerMessagesPath(), JSON.stringify(messengerMessages, null, 2), 'utf8'); } catch {}
}
function messengerPruneMessages() {
  if (!messengerPrefs.retainEnabled) return;
  const days = Math.max(1, Number(messengerPrefs.retainDays) || 30);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const before = messengerMessages.length;
  messengerMessages = messengerMessages.filter(m => m.ts >= cutoff);
  if (messengerMessages.length !== before) messengerSaveMessages();
}
function messengerState() {
  const now = Date.now();
  const peers = [...messengerPeers.values()]
    .map(p => ({ ...p, online: now - p.lastSeen < MSG_ONLINE_WINDOW_MS }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    self: { id: messengerId, name: messengerPrefs.displayName || os.userInfo().username || 'PePe', port: messengerPort, hidden: !!messengerPrefs.hidePresence },
    peers,
    messages: messengerMessages,
    prefs: messengerPrefs,
    emoticonPacks: messengerReadEmoticonPacks(),
    // 렌더러가 파일/이미지 메시지의 filePath 가 앱 관리 폴더 안(=아직 "저장" 안 함)인지, 밖(=사용자가
    // 다른 이름으로 저장 완료)인지 판별해 "위치 열기"↔"폴더 열기" 버튼 라벨을 바꾸는 데 쓴다.
    downloadsDir: messengerDownloadsDir(),
  };
}
function messengerRemember(msg: MessengerMessage) {
  messengerMessages.push(msg);
  messengerPruneMessages();
  messengerSaveMessages();
  messengerEmit({ type: 'message', message: msg, state: messengerState() });
}
// 상대에게 "읽음" 확인을 보냄 — 보낸 사람 쪽에서 회수(recall) 가능 여부 판단에 사용.
async function messengerSendReadAck(peer: MessengerPeer, messageId: string) {
  try {
    await messengerWritePeer(peer, { app: 'pepe-terminal-ssh', type: 'read', fromId: messengerId, messageId, ts: Date.now() });
  } catch {}
}
// 내가 보낸 메시지를 회수(삭제) — 아직 상대가 안 읽었을 때만 허용. 로컬 기록도 같이 지움.
async function messengerRecallMessage(peerId: string, messageId: string): Promise<{ success: boolean; error?: string }> {
  const peer = messengerPeers.get(peerId);
  if (!peer) return { success: false, error: 'peer not found' };
  const msg = messengerMessages.find(m => m.id === messageId && m.peerId === peerId && m.direction === 'out');
  if (!msg) return { success: false, error: 'message not found' };
  if (msg.read) return { success: false, error: 'already read' };
  try {
    await messengerWritePeer(peer, { app: 'pepe-terminal-ssh', type: 'recall', fromId: messengerId, messageId, ts: Date.now() });
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
  msg.recalled = true;
  msg.text = undefined;
  // 주의: msg.filePath 는 사용자가 📎 다이얼로그로 고른 원본 파일일 수 있어 삭제하지 않음
  // (드래그/붙여넣기로 첨부한 임시 사본은 전송 성공 시 이미 정리됨 — messenger:send-file-paths 참고).
  msg.filePath = undefined;
  msg.fileName = undefined;
  messengerSaveMessages();
  messengerEmit({ type: 'state', state: messengerState() });
  return { success: true };
}
function messengerPacket(reply = false) {
  return Buffer.from(JSON.stringify({
    app: 'pepe-terminal-ssh',
    type: 'hello',
    id: messengerId,
    name: messengerPrefs.displayName || os.userInfo().username || 'PePe',
    port: messengerPort,
    reply,
    ts: Date.now(),
  }));
}
function messengerBroadcast() {
  if (!messengerUdp || !messengerPort) return;
  if (messengerPrefs.hidePresence) return;
  const packet = messengerPacket();
  try { messengerUdp.send(packet, 0, packet.length, MSG_DISCOVERY_PORT, '255.255.255.255'); } catch {}
}
function messengerSendHelloTo(host: string, reply = false) {
  if (!messengerUdp || !messengerPort || !host) return;
  if (messengerPrefs.hidePresence) return;
  const packet = messengerPacket(reply);
  try { messengerUdp.send(packet, 0, packet.length, MSG_DISCOVERY_PORT, host); } catch {}
}
// Directed keepalive: ping every known peer's last address so presence survives
// even when broadcast frames are dropped or filtered (Wi-Fi, cross-subnet, overlays).
// The receiver answers each hello with its own hello (see UDP handler), so the
// liveness check stays mutual without any extra protocol.
function messengerKeepalive() {
  if (!messengerUdp || !messengerPort) return;
  if (messengerPrefs.hidePresence) return;
  const seen = new Set<string>();
  for (const peer of messengerPeers.values()) {
    const host = String(peer.host || '').trim();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    messengerSendHelloTo(host);
  }
}
function messengerAssignedBClassPrefixes() {
  const prefixes = new Set<string>();
  try {
    const nets = os.networkInterfaces();
    for (const addrs of Object.values(nets)) {
      for (const addr of addrs || []) {
        if (!addr || addr.family !== 'IPv4' || addr.internal) continue;
        const ip = String(addr.address || '');
        const parts = ip.split('.').map(n => Number(n));
        if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) continue;
        if (parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || parts[0] === 0) continue;
        prefixes.add(`${parts[0]}.${parts[1]}`);
      }
    }
  } catch {}
  return [...prefixes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
function messengerKnownOverlayHosts() {
  const hosts = new Set<string>();
  const addHost = (ip: string) => {
    const parts = String(ip || '').split('.').map(n => Number(n));
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return;
    if (parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || parts[0] === 0) return;
    hosts.add(parts.join('.'));
  };
  try {
    const { execFileSync } = require('child_process');
    const candidates = process.platform === 'win32'
      ? ['tailscale.exe', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
      : ['tailscale'];
    for (const exe of candidates) {
      try {
        const out = execFileSync(exe, ['status', '--json'], { encoding: 'utf8', timeout: 2500, windowsHide: true });
        const data = JSON.parse(out || '{}');
        for (const peer of Object.values(data?.Peer || {}) as any[]) {
          for (const ip of peer?.TailscaleIPs || []) addHost(String(ip));
        }
        break;
      } catch {}
    }
  } catch {}
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const ps = "Get-NetRoute -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -like '*Tailscale*' -and $_.DestinationPrefix -match '^\\d+\\.\\d+\\.\\d+\\.\\d+/32$' } | ForEach-Object { $_.DestinationPrefix.Split('/')[0] }";
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 2500, windowsHide: true });
      for (const line of out.split(/\r?\n/)) addHost(line.trim());
    } catch {}
  }
  return [...hosts].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
function messengerScanRange(prefix?: string) {
  if (!messengerUdp || !messengerPort) return { success: false, error: 'messenger not started' };
  if (messengerPrefs.hidePresence) return { success: false, error: 'presence hidden' };
  const prefixes = prefix
    ? [String(prefix).replace(/[^\d.]/g, '').replace(/\.+$/, '')]
    : messengerAssignedBClassPrefixes();
  const cleanPrefixes = [...new Set(prefixes)]
    .filter(p => /^\d{1,3}\.\d{1,3}$/.test(p))
    .filter(p => p.split('.').every(n => Number(n) >= 0 && Number(n) <= 255));
  const directHosts = prefix ? [] : messengerKnownOverlayHosts();
  if (cleanPrefixes.length === 0 && directHosts.length === 0) return { success: false, error: 'no assigned IPv4 network found' };
  let prefixIdx = 0;
  let third = 0;
  let fourth = 1;
  let directIdx = 0;
  let sent = 0;
  const batchSize = 512;
  const total = cleanPrefixes.length * 256 * 254 + directHosts.length;
  const tick = () => {
    let count = 0;
    while (prefixIdx < cleanPrefixes.length && count < batchSize) {
      messengerSendHelloTo(`${cleanPrefixes[prefixIdx]}.${third}.${fourth}`);
      sent++;
      count++;
      fourth++;
      if (fourth >= 255) {
        fourth = 1;
        third++;
      }
      if (third > 255) {
        third = 0;
        prefixIdx++;
      }
    }
    while (prefixIdx >= cleanPrefixes.length && directIdx < directHosts.length && count < batchSize) {
      messengerSendHelloTo(directHosts[directIdx]);
      directIdx++;
      sent++;
      count++;
    }
    messengerEmit({ type: 'scan-progress', prefixes: cleanPrefixes, directHosts, sent, total, state: messengerState() });
    if (prefixIdx < cleanPrefixes.length || directIdx < directHosts.length) setTimeout(tick, 25);
    else messengerEmit({ type: 'scan-complete', prefixes: cleanPrefixes, directHosts, sent, state: messengerState() });
  };
  setTimeout(tick, 0);
  return { success: true, prefixes: cleanPrefixes, directHosts, total };
}
function messengerWritePeer(peer: MessengerPeer, payload: any): Promise<void> {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: peer.host, port: peer.port, timeout: 8000 }, () => {
      socket.write(JSON.stringify(payload) + '\n');
      socket.end();
    });
    socket.on('close', () => resolve());
    socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
    socket.on('error', reject);
  });
}
async function messengerSendFileBuffer(peer: MessengerPeer, fileName: string, filePath: string, data: Buffer, kind: 'file' | 'sticker' = 'file') {
  if (data.length > 25 * 1024 * 1024) throw new Error('25MB 이하 파일만 전송 가능합니다');
  const msg: MessengerMessage = {
    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    peerId: peer.id,
    direction: 'out',
    kind,
    fileName,
    filePath,
    size: data.length,
    ts: Date.now(),
  };
  await messengerWritePeer(peer, {
    app: 'pepe-terminal-ssh',
    type: 'file',
    kind,
    fromId: messengerId,
    fromName: messengerPrefs.displayName || os.userInfo().username || 'PePe',
    fromPort: messengerPort,
    messageId: msg.id,
    fileName: msg.fileName,
    size: data.length,
    dataBase64: data.toString('base64'),
    ts: msg.ts,
  });
  messengerRemember(msg);
}
async function messengerSendStickerBuffer(peer: MessengerPeer, fileName: string, filePath: string, data: Buffer) {
  return messengerSendFileBuffer(peer, fileName, filePath, data, 'sticker');
}
async function messengerSendWorklogShare(peer: MessengerPeer, share: WorklogSharePayload) {
  const msg: MessengerMessage = {
    id: `share-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    peerId: peer.id,
    direction: 'out',
    kind: 'worklog-share',
    text: messengerWorklogShareSummary(share),
    ts: Date.now(),
    worklogShare: share,
    shareStatus: 'pending',
  };
  await messengerWritePeer(peer, {
    app: 'pepe-terminal-ssh',
    type: 'message',
    kind: 'worklog-share',
    fromId: messengerId,
    fromName: messengerPrefs.displayName || os.userInfo().username || 'PePe',
    fromPort: messengerPort,
    messageId: msg.id,
    text: msg.text,
    worklogShare: share,
    ts: msg.ts,
  });
  messengerRemember(msg);
}
function messengerHandleIncoming(payload: any, remoteHost: string) {
  if (!payload || payload.app !== 'pepe-terminal-ssh' || payload.fromId === messengerId) return;
  if (messengerPrefs.hidePresence) return;
  const peerId = String(payload.fromId || payload.id || '');
  if (!peerId) return;
  const peer = messengerPeers.get(peerId) || { id: peerId, name: payload.fromName || 'PePe', host: remoteHost, port: Number(payload.fromPort) || 0, lastSeen: Date.now() };
  peer.name = payload.fromName || peer.name;
  peer.host = remoteHost || peer.host;
  peer.port = Number(payload.fromPort || peer.port) || peer.port;
  peer.lastSeen = Date.now();
  messengerPeers.set(peerId, peer);
  messengerSavePeers();

  if (payload.type === 'message') {
    if (payload.kind === 'worklog-share') {
      const share = normalizeWorklogSharePayload(payload.worklogShare || payload.share || payload);
      messengerRemember({
        id: payload.messageId || `share-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        peerId,
        direction: 'in',
        kind: 'worklog-share',
        text: String(payload.text || (share ? messengerWorklogShareSummary(share) : '') || ''),
        ts: Number(payload.ts) || Date.now(),
        worklogShare: share || undefined,
        shareStatus: 'pending',
      });
    } else {
      messengerRemember({ id: payload.messageId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, peerId, direction: 'in', kind: 'text', text: String(payload.text || ''), ts: Number(payload.ts) || Date.now() });
    }
  } else if (payload.type === 'file') {
    const fileName = path.basename(String(payload.fileName || 'received.bin')).replace(/[<>:"/\\|?*]/g, '_');
    const data = Buffer.from(String(payload.dataBase64 || ''), 'base64');
    const savePath = path.join(messengerDownloadsDir(), `${Date.now()}-${fileName}`);
    fs.writeFileSync(savePath, data);
    const kind = payload.kind === 'sticker' ? 'sticker' : 'file';
    messengerRemember({ id: payload.messageId || `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, peerId, direction: 'in', kind, fileName, filePath: savePath, size: data.length, ts: Number(payload.ts) || Date.now() });
  } else if (payload.type === 'read') {
    // 상대가 내가 보낸 메시지를 읽었다는 확인 — 그 메시지엔 더 이상 회수(recall) 못 하게 표시.
    const msg = messengerMessages.find(m => m.id === payload.messageId && m.peerId === peerId && m.direction === 'out');
    if (msg && !msg.read) {
      msg.read = true;
      messengerSaveMessages();
      messengerEmit({ type: 'state', state: messengerState() });
    }
  } else if (payload.type === 'recall') {
    // 상대가 자기가 보낸(내 입장에선 받은) 메시지를 회수함 — 내 쪽 기록도 삭제 표시로 갱신.
    const msg = messengerMessages.find(m => m.id === payload.messageId && m.peerId === peerId && m.direction === 'in');
    if (msg && !msg.recalled) {
      msg.recalled = true;
      msg.text = undefined;
      // 받은 파일은 우리가 messengerDownloadsDir() 에 직접 저장한 사본이라 안전하게 삭제 가능.
      if ((msg.kind === 'file' || msg.kind === 'sticker') && msg.filePath) {
        try { if (fs.existsSync(msg.filePath)) fs.unlinkSync(msg.filePath); } catch {}
      }
      msg.filePath = undefined;
      msg.fileName = undefined;
      messengerSaveMessages();
      messengerEmit({ type: 'state', state: messengerState() });
    }
  }
}

async function messengerStartService(prefs?: MessengerPrefs) {
  const dgram = require('dgram');
  const net = require('net');
  messengerPrefs = { retainEnabled: false, retainDays: 30, ...(loadUIPrefs().messenger || {}), ...(prefs || {}) };
  saveUIPrefs({ messenger: messengerPrefs });
  messengerLoadIdentity();
  messengerLoadPeers();
  messengerLoadMessages();
  if (!messengerTcp) {
    messengerTcp = net.createServer((socket: any) => {
      let buf = '';
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try { messengerHandleIncoming(JSON.parse(line), String(socket.remoteAddress || '').replace(/^::ffff:/, '')); } catch {}
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      messengerTcp.listen(0, '0.0.0.0', () => {
        const addr = messengerTcp.address();
        messengerPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
      messengerTcp.once('error', reject);
    });
  }
  if (!messengerUdp) {
    messengerUdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    messengerUdp.on('message', (msg: Buffer, rinfo: any) => {
      try {
        const p = JSON.parse(msg.toString('utf8'));
        if (p?.app !== 'pepe-terminal-ssh' || p?.type !== 'hello' || p?.id === messengerId) return;
        messengerPeers.set(String(p.id), { id: String(p.id), name: String(p.name || 'PePe'), host: rinfo.address, port: Number(p.port) || 0, lastSeen: Date.now() });
        messengerSavePeers();
        if (!p.reply) messengerSendHelloTo(rinfo.address, true);
        messengerEmit({ type: 'peers', state: messengerState() });
      } catch {}
    });
    await new Promise<void>((resolve, reject) => {
      messengerUdp.bind(MSG_DISCOVERY_PORT, () => {
        try { messengerUdp.setBroadcast(true); } catch {}
        resolve();
      });
      messengerUdp.once('error', reject);
    });
  }
  if (!messengerTimer) messengerTimer = setInterval(() => {
    messengerBroadcast();
    messengerKeepalive();
    messengerEmit({ type: 'peers', state: messengerState() });
  }, MSG_KEEPALIVE_MS);
  messengerBroadcast();
  messengerKeepalive();
  return { success: true, state: messengerState() };
}
ipcMain.handle('messenger:start', async (_e, prefs?: MessengerPrefs) => messengerStartService(prefs));
ipcMain.handle('messenger:stop', () => {
  if (messengerTimer) clearInterval(messengerTimer);
  messengerTimer = null;
  try { messengerUdp?.close(); } catch {}
  try { messengerTcp?.close(); } catch {}
  messengerUdp = null; messengerTcp = null; messengerPort = 0;
  return { success: true };
});
ipcMain.handle('messenger:get-state', () => { messengerLoadIdentity(); messengerLoadMessages(); return messengerState(); });
ipcMain.handle('messenger:update-prefs', (_e, prefs: MessengerPrefs) => {
  messengerPrefs = { ...messengerPrefs, ...(prefs || {}) };
  saveUIPrefs({ messenger: messengerPrefs });
  messengerPruneMessages();
  if (!messengerPrefs.hidePresence) messengerBroadcast();
  // prefs(특히 hidePresence) 변경을 모든 창/컴포넌트에 전파 — 상단 상태 표시 등 동기화.
  messengerEmit({ type: 'state', state: messengerState() });
  return { success: true, state: messengerState() };
});
ipcMain.handle('messenger:scan-range', (_e, { prefix }: { prefix?: string }) => messengerScanRange(prefix));
ipcMain.handle('messenger:send-message', async (_e, { peerId, text }: { peerId: string; text: string }) => {
  if (messengerPrefs.hidePresence) return { success: false, error: 'presence hidden' };
  const peer = messengerPeers.get(peerId);
  if (!peer) return { success: false, error: 'peer not found' };
  if (Date.now() - peer.lastSeen >= MSG_ONLINE_WINDOW_MS) return { success: false, error: 'peer is offline' };
  const msg: MessengerMessage = { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, peerId, direction: 'out', kind: 'text', text, ts: Date.now() };
  await messengerWritePeer(peer, { app: 'pepe-terminal-ssh', type: 'message', fromId: messengerId, fromName: messengerPrefs.displayName || os.userInfo().username || 'PePe', fromPort: messengerPort, messageId: msg.id, text, ts: msg.ts });
  messengerRemember(msg);
  return { success: true };
});
ipcMain.handle('messenger:send-worklog-share', async (_e, { peerId, share }: { peerId: string; share: any }) => {
  if (messengerPrefs.hidePresence) return { success: false, error: 'presence hidden' };
  const peer = messengerPeers.get(peerId);
  if (!peer) return { success: false, error: 'peer not found' };
  if (Date.now() - peer.lastSeen >= MSG_ONLINE_WINDOW_MS) return { success: false, error: 'peer is offline' };
  const normalized = normalizeWorklogSharePayload(share);
  if (!normalized) return { success: false, error: 'invalid share payload' };
  await messengerSendWorklogShare(peer, normalized);
  return { success: true, state: messengerState() };
});
ipcMain.handle('messenger:respond-worklog-share', (_e, { peerId, messageId, decision }: { peerId: string; messageId: string; decision: 'accepted' | 'rejected' }) => {
  const msg = messengerMessages.find(m => m.id === messageId && m.peerId === peerId && m.direction === 'in' && m.kind === 'worklog-share');
  if (!msg) return { success: false, error: 'message not found' };
  if (msg.shareStatus && msg.shareStatus !== 'pending') {
    return { success: true, state: messengerState(), worklog: loadWorklog() };
  }
  const now = Date.now();
  if (decision === 'accepted') {
    const share = msg.worklogShare;
    if (!share?.sourceTodo?.text.trim()) return { success: false, error: 'invalid share payload' };
    const today = localDateStr();
    const data = loadWorklog();
    const day = data.days[today] || { todos: [] };
    const duplicate = day.todos.some((todo: any) => todo.sharedFromMessageId === messageId || todo.sharedFromMessageId === share.sourceMessageId);
    if (!duplicate) {
      const nextTodo = {
        id: `wl-share-${now}-${Math.random().toString(36).slice(2, 6)}`,
        text: share.sourceTodo.text,
        done: !!share.sourceTodo.done,
        memo: share.sourceTodo.memo,
        createdAt: share.sourceTodo.createdAt || now,
        doneAt: share.sourceTodo.doneAt,
        sharedFromPeerId: share.sourcePeerId || peerId,
        sharedFromPeerName: share.sourcePeerName || messengerPeers.get(peerId)?.name || '',
        sharedFromDate: share.sourceDate,
        sharedFromMessageId: messageId,
      } as any;
      day.todos.push(nextTodo);
      saveWorklogDay(today, day);
      emitWorklogState();
    }
  }
  msg.shareStatus = decision;
  msg.shareHandledAt = now;
  messengerSaveMessages();
  messengerEmit({ type: 'state', state: messengerState() });
  return { success: true, state: messengerState(), worklog: loadWorklog() };
});
ipcMain.handle('messenger:mark-read', async (_e, { peerId, messageId }: { peerId: string; messageId: string }) => {
  const peer = messengerPeers.get(peerId);
  const msg = messengerMessages.find(m => m.id === messageId && m.peerId === peerId && m.direction === 'in');
  if (!peer || !msg) return { success: false };
  await messengerSendReadAck(peer, messageId);
  return { success: true };
});
ipcMain.handle('messenger:recall-message', async (_e, { peerId, messageId }: { peerId: string; messageId: string }) => {
  return messengerRecallMessage(peerId, messageId);
});
// 메신저로 받은/보낸 파일·이미지는 messengerDownloadsDir()(고정 폴더)에 자동 저장되지만, 사용자가
// 원하는 위치에 별도로 저장할 수 있게 하는 다이얼로그. 그 고정 폴더 안의 앱 관리 사본이면 저장 후
// 원본(폴더 안 사본)은 지우고 메시지의 filePath 를 새 위치로 갱신 — "위치 열기"/미리보기가 계속 그
// 파일을 따라가게 한다. 📎 버튼으로 고른 사용자의 원본 파일(고정 폴더 밖)은 절대 지우지 않는다.
ipcMain.handle('messenger:save-file-as', async (_e, args: { filePath: string; fileName?: string; peerId?: string; messageId?: string }) => {
  if (!mainWindow) return { success: false, error: 'no window' };
  try {
    if (!args?.filePath || !fs.existsSync(args.filePath)) return { success: false, error: '원본 파일을 찾을 수 없습니다' };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '파일 저장',
      defaultPath: args.fileName || path.basename(args.filePath),
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    fs.copyFileSync(args.filePath, result.filePath);
    const managedByApp = path.dirname(args.filePath) === messengerDownloadsDir();
    if (managedByApp) {
      try { fs.unlinkSync(args.filePath); } catch {}
      if (args.peerId && args.messageId) {
        const msg = messengerMessages.find(m => m.id === args.messageId && m.peerId === args.peerId);
        if (msg) {
          msg.filePath = result.filePath;
          messengerSaveMessages();
          messengerEmit({ type: 'message-updated', message: msg, state: messengerState() });
        }
      }
    }
    return { success: true, filePath: result.filePath };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
// 다이얼로그로 파일만 선택 — 바로 전송하지 않고 렌더러의 첨부 목록에 올릴 경로 목록을 반환.
ipcMain.handle('messenger:pick-files', async () => {
  if (!mainWindow) return { success: false, error: 'no window' };
  const picked = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
  if (picked.canceled || picked.filePaths.length === 0) return { success: false, canceled: true };
  const files = picked.filePaths
    .filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } })
    .map(p => ({ path: p, name: path.basename(p), size: fs.statSync(p).size }));
  return { success: true, files };
});
ipcMain.handle('messenger:send-files', async (_e, { peerId }: { peerId: string }) => {
  if (messengerPrefs.hidePresence) return { success: false, error: 'presence hidden' };
  const peer = messengerPeers.get(peerId);
  if (!peer || !mainWindow) return { success: false, error: 'peer not found' };
  if (Date.now() - peer.lastSeen >= MSG_ONLINE_WINDOW_MS) return { success: false, error: 'peer is offline' };
  const picked = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
  if (picked.canceled || picked.filePaths.length === 0) return { success: false, canceled: true };
  for (const filePath of picked.filePaths) {
    const st = fs.statSync(filePath);
    if (!st.isFile()) continue;
    await messengerSendFileBuffer(peer, path.basename(filePath), filePath, fs.readFileSync(filePath));
  }
  return { success: true };
});
// 네이티브 다이얼로그 없이 — 드래그앤드롭 등으로 이미 알고 있는 파일 경로를 바로 전송.
// files[].name 은 첨부 목록에 보이던 원래 표시명(예: "스크린샷 2026-...") — 붙여넣기 첨부는 디스크에는
// 충돌 방지용 무작위 파일명(pepe-<ts>-<rand>.ext)으로 저장돼 있으므로, 지정이 없으면 그 파일명으로 폴백.
ipcMain.handle('messenger:send-file-paths', async (_e, { peerId, files }: { peerId: string; files: { path: string; name?: string }[] }) => {
  if (messengerPrefs.hidePresence) return { success: false, error: 'presence hidden' };
  const peer = messengerPeers.get(peerId);
  if (!peer) return { success: false, error: 'peer not found' };
  if (Date.now() - peer.lastSeen >= MSG_ONLINE_WINDOW_MS) return { success: false, error: 'peer is offline' };
  const items = Array.isArray(files) ? files.filter(f => f?.path) : [];
  if (items.length === 0) return { success: false, error: 'no files' };
  // 드래그/붙여넣기 첨부는 chatCopyExternalFile/chatSavePastedBlob 이 이 임시 폴더로 복사해둔 사본이다.
  // 예전엔 전송 성공 시 바로 지웠는데, 보낸 메시지의 filePath 가 그 지워진 경로를 그대로 가리키고
  // 있어서 정작 채팅창에 남는 "내가 보낸" 말풍선의 이미지 미리보기/저장이 깨지는 버그가 있었다 —
  // 받은 파일과 동일하게 영구 보관 폴더(messengerDownloadsDir)로 옮기고, 그 새 경로로 전송해서
  // 말풍선이 항상 유효한 파일을 가리키게 한다. (📎 버튼으로 고른 사용자의 원본 파일은 이 폴더 밖이라
  // 건드리지 않는다 — 이동 없이 그 경로 그대로 사용.)
  const attachTmpDir = path.join(os.tmpdir(), 'pepe-chat-attachments');
  try {
    for (const item of items) {
      const filePath = item.path;
      if (!fs.existsSync(filePath)) continue;
      const st = fs.statSync(filePath);
      if (!st.isFile()) continue;
      let sendPath = filePath;
      const fileName = item.name || path.basename(filePath);
      if (path.dirname(filePath) === attachTmpDir) {
        const safeName = fileName.replace(/[<>:"/\\|?*]/g, '_');
        const permPath = path.join(messengerDownloadsDir(), `${Date.now()}-${safeName}`);
        try { fs.renameSync(filePath, permPath); sendPath = permPath; }
        catch { try { fs.copyFileSync(filePath, permPath); fs.unlinkSync(filePath); sendPath = permPath; } catch {} }
      }
      await messengerSendFileBuffer(peer, fileName, sendPath, fs.readFileSync(sendPath));
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('messenger:send-sticker-paths', async (_e, { peerId, filePaths }: { peerId: string; filePaths: string[] }) => {
  if (messengerPrefs.hidePresence) return { success: false, error: 'presence hidden' };
  const peer = messengerPeers.get(peerId);
  if (!peer) return { success: false, error: 'peer not found' };
  if (Date.now() - peer.lastSeen >= MSG_ONLINE_WINDOW_MS) return { success: false, error: 'peer is offline' };
  const paths = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [];
  if (paths.length === 0) return { success: false, error: 'no files' };
  try {
    for (const filePath of paths) {
      if (!fs.existsSync(filePath)) continue;
      const st = fs.statSync(filePath);
      if (!st.isFile()) continue;
      await messengerSendStickerBuffer(peer, path.basename(filePath), filePath, fs.readFileSync(filePath));
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('messenger:open-emoticon-folder', async () => {
  try {
    const roots = messengerEmoticonRoots();
    const primary = roots[0] || path.join(app.getPath('userData'), 'messenger-emoticons');
    try { fs.mkdirSync(primary, { recursive: true }); } catch {}
    await shell.openPath(primary);
    return { success: true, path: primary };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('messenger:send-remote-files', async (_e, { peerId, connId, remotePaths }: { peerId: string; connId: string; remotePaths: string[] }) => {
  try {
    if (messengerPrefs.hidePresence) return { success: false, error: 'presence hidden' };
    const peer = messengerPeers.get(peerId);
    if (!peer) return { success: false, error: 'peer not found' };
    if (Date.now() - peer.lastSeen >= MSG_ONLINE_WINDOW_MS) return { success: false, error: 'peer is offline' };
    const paths = Array.isArray(remotePaths) ? remotePaths.filter(Boolean) : [];
    if (!connId || paths.length === 0) return { success: false, error: 'no remote files selected' };
    const bridge = getSSHBridge();
    for (const remotePath of paths) {
      const data = await bridge.handleSFTPReadFile(connId, remotePath);
      await messengerSendFileBuffer(peer, path.posix.basename(String(remotePath)) || path.basename(String(remotePath)) || 'remote-file', String(remotePath), data);
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('messenger:delete-conversation', (_e, { peerId }: { peerId: string }) => {
  messengerMessages = messengerMessages.filter(m => m.peerId !== peerId);
  messengerSaveMessages();
  messengerEmit({ type: 'state', state: messengerState() });
  return { success: true };
});
ipcMain.handle('messenger:delete-peer', (_e, { peerId }: { peerId: string }) => {
  messengerPeers.delete(peerId);
  messengerMessages = messengerMessages.filter(m => m.peerId !== peerId);
  messengerSavePeers();
  messengerSaveMessages();
  messengerEmit({ type: 'state', state: messengerState() });
  return { success: true };
});
ipcMain.handle('messenger:clear-all', () => {
  messengerMessages = [];
  messengerSaveMessages();
  messengerEmit({ type: 'state', state: messengerState() });
  return { success: true };
});
// 전체 사용자(피어) 삭제 — 발견된 사용자 목록과 그 대화내역을 모두 초기화.
ipcMain.handle('messenger:clear-peers', () => {
  messengerPeers.clear();
  messengerMessages = [];
  messengerSavePeers();
  messengerSaveMessages();
  messengerEmit({ type: 'state', state: messengerState() });
  return { success: true };
});

// 외부(Explorer) 에서 드래그된 파일을 chat 첨부 디렉토리로 복사 후 경로 반환.
// 렌더러는 webUtils.getPathForFile() 로 얻은 원본 절대경로를 전달.
ipcMain.handle('chat:copy-external-file', async (_e, { srcPath, displayName }: { srcPath: string; displayName?: string }) => {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) return { success: false, error: '원본 파일 없음: ' + srcPath };
    const st = fs.statSync(srcPath);
    const MAX_BYTES = 50 * 1024 * 1024; // 50MB
    if (st.size > MAX_BYTES) return { success: false, error: `파일이 너무 큼 (${(st.size/1024/1024).toFixed(1)}MB > 50MB)` };
    const dir = path.join(os.tmpdir(), 'pepe-chat-attachments');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const base = displayName || path.basename(srcPath);
    const ext = path.extname(base).replace(/[^.\w]/g, '').slice(0, 8);
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    const safe = `pepe-${ts}-${rand}${ext}`;
    const fpath = path.join(dir, safe);
    fs.copyFileSync(srcPath, fpath);
    // mime 유추 — 확장자 기반 단순 매핑 (없으면 application/octet-stream)
    const mime = (() => {
      const e = ext.toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'].includes(e)) return 'image/' + e.slice(1).replace('jpg', 'jpeg');
      if (e === '.pdf') return 'application/pdf';
      if (['.zip', '.gz', '.tar', '.7z', '.rar'].includes(e)) return 'application/' + e.slice(1);
      if (['.txt', '.md', '.log'].includes(e)) return 'text/plain';
      if (['.json'].includes(e)) return 'application/json';
      return 'application/octet-stream';
    })();
    return { success: true, path: fpath, dir, displayName: base, size: st.size, mime };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

// AI Chat 입력창 paste/drop 으로 받은 이미지/바이너리 파일을 디스크에 저장 후 경로 반환.
// Claude 가 절대경로로 Read 할 수 있도록 add-dir 에 부모 디렉토리 함께 전달됨.
// 저장 위치: <tmpdir>/pepe-chat-attachments/ — 앱 종료 후에도 잠시 남지만 OS 가 정리.
ipcMain.handle('chat:save-pasted-blob', async (_e, { dataUrl, name, mimeType }: { dataUrl: string; name?: string; mimeType?: string }) => {
  try {
    const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
    if (!m) return { success: false, error: '유효하지 않은 dataUrl' };
    const mime = mimeType || m[1] || 'application/octet-stream';
    const buf = Buffer.from(m[2], 'base64');
    const MAX_BYTES = 20 * 1024 * 1024; // 20MB 안전 한계
    if (buf.length > MAX_BYTES) return { success: false, error: `파일이 너무 큼 (${(buf.length/1024/1024).toFixed(1)}MB > 20MB)` };
    const dir = path.join(os.tmpdir(), 'pepe-chat-attachments');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    // 확장자: name 우선, 없으면 mime 으로 유추
    let ext = '';
    if (name && name.includes('.')) ext = name.split('.').pop()!.toLowerCase();
    if (!ext) {
      if (/png/i.test(mime)) ext = 'png';
      else if (/jpe?g/i.test(mime)) ext = 'jpg';
      else if (/gif/i.test(mime)) ext = 'gif';
      else if (/webp/i.test(mime)) ext = 'webp';
      else if (/svg/i.test(mime)) ext = 'svg';
      else if (/pdf/i.test(mime)) ext = 'pdf';
      else ext = 'bin';
    }
    ext = ext.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5) || 'bin';
    // 파일명 정리 — 표시명에는 사용자 원래 이름 보존
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    const displayName = name && name.length < 80 ? name : `paste-${ts}.${ext}`;
    const safe = `pepe-${ts}-${rand}.${ext}`;
    const fpath = path.join(dir, safe);
    fs.writeFileSync(fpath, buf);
    return { success: true, path: fpath, dir, displayName, size: buf.length, mime };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
// 대기 중이던 첨부를 전송 전에 목록에서 제거했을 때 그 임시 사본도 즉시 정리.
// pepe-chat-attachments 폴더 안의 파일만 지움 — 사용자의 원본 파일(📎 다이얼로그로 고른 것)은 보호.
ipcMain.handle('chat:remove-pending-attachment', (_e, { filePath }: { filePath: string }) => {
  try {
    if (!filePath) return { success: false };
    const attachDir = path.join(os.tmpdir(), 'pepe-chat-attachments');
    if (path.dirname(filePath) !== attachDir) return { success: false, error: 'not a temp attachment' };
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

app.on('before-quit', () => {
});

ipcMain.handle('local-fs:read-file', async (_e, { filePath }: { filePath: string }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: '파일이 없습니다' };
    const buf = await fs.promises.readFile(filePath);
    const text = await decodeRemoteText(buf);
    return { success: true, text, size: buf.length };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});

const AI_ATTACH_BINARY_EXT = new Set([
  'png','jpg','jpeg','gif','bmp','ico','webp','tiff','heic','zip','gz','tar','bz2','7z','rar','exe','dll','so','dylib','bin','pdf','mp3','mp4','avi','mkv','mov','wav','flac','ogg','class','o','a','obj','lib','pyc','woff','woff2','ttf','otf','eot',
  'pptx','ppt','docx','doc','xlsx','xls','hwp','hwpx','odt','ods','odp',
]);
function isLikelyBinaryName(name: string) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return AI_ATTACH_BINARY_EXT.has(ext);
}

function safeMirrorName(remotePath: string) {
  return String(remotePath)
    .replace(/^[A-Za-z]:[\\/]/, '')
    .replace(/^\/+/, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'attachment';
}

function quoteShellArg(value: string) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function normalizeRemoteSlash(p: string) {
  return String(p || '').replace(/[\\/]+/g, '/');
}

function remoteRelPath(base: string, full: string) {
  const rel = path.posix.relative(normalizeRemoteSlash(base).replace(/\/+$/, ''), normalizeRemoteSlash(full));
  return rel === '.' ? '' : rel;
}

const AI_ATTACH_EXCLUDE_DIRS = [
  '.git', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.idea', '.vscode',
  '__pycache__', '.venv', 'venv', '.next', 'target', 'out', 'bin', 'obj', 'logs', 'tmp',
  '.mypy_cache', '.pytest_cache', '.gradle', '.terraform', '.cargo', 'vendor', 'release',
];

function shellFindPruneExpr() {
  return AI_ATTACH_EXCLUDE_DIRS.map(d => `-path ${quoteShellArg(`*/${d}/*`)}`).join(' -o ');
}

const AI_ATTACH_TEXT_EXTS = [
  '*.c', '*.h', '*.cpp', '*.hpp', '*.cc', '*.hh', '*.js', '*.jsx', '*.ts', '*.tsx', '*.mjs', '*.cjs',
  '*.py', '*.sh', '*.bash', '*.zsh', '*.json', '*.yaml', '*.yml', '*.xml', '*.md', '*.txt', '*.ini',
  '*.cfg', '*.toml', '*.sql', '*.go', '*.java', '*.kt', '*.rb', '*.php', '*.css', '*.scss', '*.html',
  '*.htm', '*.vue', '*.svelte', '*.gradle', '*.dockerfile', 'Dockerfile*', '*.properties', '*.env',
  '*.conf', '*.service', '*.ps1', '*.psm1', '*.bat', '*.cmd', '*.r', '*.swift', '*.dart', '*.lock',
];

async function decodeRemoteText(buf: Buffer) {
  let text = buf.toString('utf-8');
  if (text.includes('�')) {
    try {
      const iconv = require('iconv-lite');
      const cp949 = iconv.decode(buf, 'cp949');
      const curBad = (text.match(/�/g) || []).length;
      const altBad = (cp949.match(/�/g) || []).length;
      if (altBad < curBad) text = cp949;
    } catch {}
  }
  return text;
}

async function mirrorRemoteAttachment(panelId: string, remotePath: string, isDir: boolean) {
  const bridge: any = getSSHBridge();
  const bundleRoot = path.join(os.tmpdir(), `pepe-ai-mirror-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const targetRoot = path.join(bundleRoot, safeMirrorName(remotePath));
  const key = aiMirrorSessionKey(panelId, remotePath);
  aiMirrorPending.set(key, { bundleRoot, aborted: false });
  const stats = { copiedFiles: 0, skippedFiles: 0, copiedBytes: 0 };
  aiMirrorLog(`mirror start panel=${panelId} remote=${remotePath} kind=${isDir ? 'dir' : 'file'} target=${targetRoot}`);

  const MIRROR_PARALLEL_FILES = 4;

  const runQueue = async <T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) => {
    const queue = [...items];
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= queue.length) return;
        await worker(queue[idx], idx);
      }
    });
    await Promise.all(runners);
  };

  const collectMirrorFiles = async (rootPath: string): Promise<{ files: string[]; mode: 'mime' | 'ext' }> => {
    const normalized = normalizeRemoteSlash(rootPath).replace(/\/+$/, '');
    const rootQ = quoteShellArg(normalized);
    const pruneExpr = shellFindPruneExpr();
    const extExpr = AI_ATTACH_TEXT_EXTS.map(ext => `-name ${quoteShellArg(ext)}`).join(' -o ');
    const script = `
ROOT=${rootQ}
if command -v file >/dev/null 2>&1; then
  printf "__MODE__:mime\\n"
  find "$ROOT" \\( ${pruneExpr} \\) -prune -o -type f -exec sh -c '
    for f do
      mime=$(file -b --mime-type "$f" 2>/dev/null || echo unknown)
      case "$mime" in
        text/*|inode/x-empty|application/json|application/xml|application/yaml|application/x-yaml|application/javascript|application/x-javascript|application/x-sh|application/x-shellscript|application/x-python|application/x-perl|application/x-ruby|application/x-php|application/sql|application/x-sql|application/x-httpd-php)
          printf "%s\\n" "$f"
          ;;
      esac
    done
  ' sh {} +
else
  printf "__MODE__:ext\\n"
  find "$ROOT" \\( ${pruneExpr} \\) -prune -o -type f \\( ${extExpr} \\) -print
fi
`;
    const r = await bridge.handleExec(panelId, script, 120000);
    const out = String(r?.stdout || '').trim();
    const err = String(r?.stderr || '').trim();
    if (err) aiMirrorLog(`collect stderr panel=${panelId} remote=${remotePath} err=${err.slice(0, 500)}`);
    if (typeof r?.exitCode === 'number' && r.exitCode !== 0) aiMirrorLog(`collect exit panel=${panelId} remote=${remotePath} code=${r.exitCode}`);
    if (!out) return { files: [], mode: 'mime' };
    const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const modeLine = lines[0] && lines[0].startsWith('__MODE__:') ? lines.shift()! : '__MODE__:mime';
    const mode = modeLine.replace('__MODE__:', '') as 'mime' | 'ext';
    return { files: Array.from(new Set(lines)), mode };
  };

  try {
    fs.mkdirSync(targetRoot, { recursive: true });
    const pending = aiMirrorPending.get(key);
    if (pending?.aborted) throw new Error('mirror cancelled');
    const collected = isDir ? await collectMirrorFiles(remotePath) : { files: [normalizeRemoteSlash(remotePath)], mode: 'mime' as const };
    let files = collected.files;
    if (files.length === 0) {
      aiMirrorLog(`mirror candidate list empty panel=${panelId} remote=${remotePath}`);
      if (isDir) {
        aiMirrorLog(`mirror fallback to recursive list panel=${panelId} remote=${remotePath}`);
        const fallbackList: string[] = [];
        const seen = new Set<string>();
        const walk = async (baseRemote: string) => {
          const entries: any[] = await bridge.handleSFTPListDir(panelId, baseRemote);
          for (const entry of entries) {
            const childName = String(entry?.name || '');
            if (!childName || childName === '.' || childName === '..') continue;
            const childRemote = baseRemote.replace(/[\\/]+$/, '') + '/' + childName;
            if (entry.isDir) {
              await walk(childRemote);
            } else {
              const rel = remoteRelPath(remotePath, childRemote);
              if (seen.has(rel)) continue;
              seen.add(rel);
              fallbackList.push(childRemote);
            }
          }
        };
        try {
          await walk(remotePath);
          collected.files = Array.from(new Set(fallbackList));
          files = collected.files;
          aiMirrorLog(`mirror fallback candidate count panel=${panelId} remote=${remotePath} candidates=${collected.files.length}`);
        } catch (e: any) {
          aiMirrorLog(`mirror fallback failed panel=${panelId} remote=${remotePath} err=${String(e?.message || e)}`);
        }
      }
    } else {
      aiMirrorLog(`mirror candidate list ready panel=${panelId} remote=${remotePath} candidates=${files.length} mode=${collected.mode}`);
    }
    await runQueue(files, MIRROR_PARALLEL_FILES, async (src) => {
      const pendingNow = aiMirrorPending.get(key);
      if (pendingNow?.aborted) throw new Error('mirror cancelled');
      const rel = isDir ? remoteRelPath(remotePath, src) : path.posix.basename(normalizeRemoteSlash(src));
      const dst = rel ? path.join(targetRoot, rel.split('/').join(path.sep)) : targetRoot;
      const name = path.posix.basename(normalizeRemoteSlash(src));
      try {
        const buf = await bridge.handleSFTPReadFile(panelId, src);
        const pendingAfterRead = aiMirrorPending.get(key);
        if (pendingAfterRead?.aborted) throw new Error('mirror cancelled');
        if (buf.length > 5 * 1024 * 1024) { stats.skippedFiles++; return; }
        const parent = path.dirname(dst);
        try { fs.mkdirSync(parent, { recursive: true }); } catch {}
        const text = await decodeRemoteText(buf);
        fs.writeFileSync(dst, text, 'utf-8');
        stats.copiedFiles++;
        stats.copiedBytes += buf.length;
      } catch (err: any) {
        const msg = String(err?.message || err || '');
        if (/is a directory|EISDIR/i.test(msg)) {
          stats.skippedFiles++;
          return;
        }
        if (isLikelyBinaryName(name)) {
          stats.skippedFiles++;
          return;
        }
        throw new Error(`Failed to mirror ${src}: ${msg}`);
      }
    });
    const pendingAfter = aiMirrorPending.get(key);
    if (pendingAfter?.aborted) throw new Error('mirror cancelled');
    registerAiMirrorSession(panelId, remotePath, targetRoot, isDir, bundleRoot);
    aiMirrorLog(`mirror done panel=${panelId} remote=${remotePath} copiedFiles=${stats.copiedFiles} skippedFiles=${stats.skippedFiles} copiedBytes=${stats.copiedBytes}`);
    return { success: true, bundleRoot, localRoot: targetRoot, ...stats };
  } finally {
    const pending = aiMirrorPending.get(key);
    if (pending && pending.bundleRoot === bundleRoot) aiMirrorPending.delete(key);
    if (!aiMirrorSessions.has(key)) {
      try { fs.rmSync(bundleRoot, { recursive: true, force: true }); } catch {}
    }
  }
}

ipcMain.handle('ai-attach:mirror-remote', async (_e, { panelId, remotePath, isDir }: { panelId: string; remotePath: string; isDir: boolean }) => {
  try {
    if (!panelId || !remotePath) return { success: false, error: 'panelId and remotePath are required' };
    return await mirrorRemoteAttachment(panelId, remotePath, !!isDir);
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('ai-attach:dispose-remote', async (_e, { panelId, remotePath }: { panelId: string; remotePath: string }) => {
  try {
    return disposeAiMirrorSession(panelId, remotePath);
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('ai-attach:dispose-panel', async (_e, { panelId }: { panelId: string }) => {
  try {
    return disposeAiMirrorPanel(panelId);
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:get-release-notes', () => {
  // 빌드 후 패키지된 release notes 파일들 — 최신 버전 우선 매칭
  const v = app.getVersion();
  const candidates = [
    path.join(process.resourcesPath, 'docs', `RELEASE_v${v}.md`),
    path.join(app.getAppPath(), 'docs', `RELEASE_v${v}.md`),
    path.join(__dirname, '..', '..', 'docs', `RELEASE_v${v}.md`),
    path.join(__dirname, '..', 'docs', `RELEASE_v${v}.md`),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch {}
  }
  return null;
});
// Electron native confirm/alert 후 Chromium renderer focus 가 멈춰서 caret 이 안 그려지는 버그 우회.
// OS 레벨 blur → focus 사이클을 강제로 한 번 돌리면 alt-tab 한 효과와 동일하게 focus 정상 복귀.
ipcMain.handle('win:refocus', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  try { win.blur(); win.focus(); } catch {}
});

ipcMain.handle('app:startup-cwd', () => startupCwd);
ipcMain.handle('app:clear-startup-cwd', () => {
  startupCwd = null;
  // 임시 파일도 확실히 삭제
  try { fs.unlinkSync(path.join(require('os').tmpdir(), '.pepe-terminal-cwd')); } catch {}
});
// 외부 프로그램이 ssh://host:port 인자로 PePe 를 호출한 경우의 자동 접속 대상
ipcMain.handle('app:startup-ssh-target', () => startupSshTarget);
ipcMain.handle('app:clear-startup-ssh-target', () => { startupSshTarget = null; });

// 여러 줄 붙여넣기 — 별도 BrowserWindow (다른 모니터로도 이동 가능)
const pasteWindows = new Map<string, BrowserWindow>();
ipcMain.handle('paste-modal:open', (_e, { id, text, accumulate }: { id: string; text: string; accumulate?: boolean }) => {
  // 붙여넣기 창은 항상 1개만 — 기존에 떠 있던 모든 붙여넣기 창을 닫는다.
  // (같은 터미널이면 같은 id, 다른 패널이면 다른 id 라 id 기준만으로는 중복 창이 남았음)
  for (const [eid, ew] of pasteWindows) {
    if (ew && !ew.isDestroyed()) {
      try { ew.removeAllListeners('closed'); } catch {}  // closed 핸들러의 지연 delete 와의 race 차단
      try { ew.destroy(); } catch {}
    }
    pasteWindows.delete(eid);
  }

  // 메인 창의 우상단 부근에 위치 (검색창과 같은 영역)
  let pasteX = 100, pasteY = 100;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const b = mainWindow.getBounds();
    pasteX = Math.max(b.x + 24, b.x + b.width - 600 - 100);
    pasteY = b.y + 60;
  }
  const win = new BrowserWindow({
    x: pasteX, y: pasteY,
    width: 620, height: 460,
    minWidth: 360, minHeight: 240,
    frame: false, resizable: true,
    thickFrame: false,                 // Windows Aero Snap (자석) 비활성
    transparent: false, hasShadow: true,
    backgroundColor: '#1a1a1a',
    parent: mainWindow ?? undefined,
    modal: false,
    skipTaskbar: true,
    // alwaysOnTop floating 을 쓰면 PePe 밖 다른 앱을 클릭해도 이 창만 최상단에 떠 있어
    // 거슬림. parent 관계로 메인 위에는 유지되되, 다른 앱으로 전환하면 같이 뒤로 가도록 false.
    alwaysOnTop: false,
    show: false,
    title: t('popup.pasteModalTitle'),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.once('ready-to-show', () => { try { win.show(); win.focus(); } catch {} });
  pasteWindows.set(id, win);
  // ⚠ 같은 id 로 빠르게 두 번 열면: 옛 창 close() → 새 창 set() → 옛 창의 closed 이벤트가
  //   뒤늦게 발화해 새 창을 맵에서 지워버림 → 새 창이 맵에 없어 취소/닫기가 안 먹는 버그.
  //   맵이 여전히 '이 창' 을 가리킬 때만 삭제하도록 가드.
  win.on('closed', () => { if (pasteWindows.get(id) === win) pasteWindows.delete(id); });

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body { margin:0; padding:0; background:#1a1a1a; color:#eee; font-family: 'Segoe UI', sans-serif; height:100%; overflow:hidden; -webkit-user-select:none; user-select:none; }
    .header { padding:10px 14px; border-bottom:1px solid #333; display:flex; align-items:center; justify-content:space-between; -webkit-app-region:drag; cursor:move; background:#222; }
    .header strong { font-size:13px; }
    .header button { -webkit-app-region:no-drag; background:transparent; border:none; color:#aaa; cursor:pointer; font-size:16px; padding:0 4px; }
    .body { padding:14px; display:flex; flex-direction:column; height: calc(100% - 41px); box-sizing:border-box; }
    .body p { color:#888; font-size:12px; margin:0 0 8px; }
    textarea { flex:1; min-height:0; width:100%; box-sizing:border-box; background:#111; color:#eee; border:1px solid #333; border-radius:4px; padding:8px; font-size:12px; font-family:monospace; resize:none; -webkit-user-select:text; user-select:text; }
    .actions { display:flex; gap:8px; margin-top:12px; justify-content:flex-end; }
    .actions button { padding:6px 16px; border:none; border-radius:4px; cursor:pointer; font-size:12px; }
    .btn-cancel { background:#333; border:1px solid #555 !important; color:#eee; }
    .btn-paste { background:#2b6b9b; border:1px solid #3a8bc8 !important; color:#fff; }
  </style></head><body>
    <div class="header">
      <strong>${t('paste.title')}</strong>
      <button id="x">✕</button>
    </div>
    <div class="body">
      <p>${t('paste.prompt')}</p>
      <textarea id="t" autofocus spellcheck="false"></textarea>
      <div class="actions">
        <button id="c" class="btn-cancel">${t('paste.cancel')}</button>
        <button id="p" class="btn-paste">${t('paste.paste')}</button>
      </div>
    </div>
    <script>
      const { ipcRenderer } = require('electron');
      const t = document.getElementById('t');
      t.value = ${JSON.stringify(text)};
      t.focus();
      const sendResult = (action) => ipcRenderer.send('paste-modal:result', { id: ${JSON.stringify(id)}, action, text: t.value });
      document.getElementById('x').onclick = () => sendResult('cancel');
      document.getElementById('c').onclick = () => sendResult('cancel');
      document.getElementById('p').onclick = () => sendResult('paste');
      t.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') sendResult('cancel');
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendResult('paste'); }
      });
      // 창이 떠 있는 상태에서 다시 여러 줄 붙여넣기(Ctrl+V) 시:
      //   accumulate=true  → 기존 내용 끝에 이어붙임(누적)
      //   accumulate=false → 새 내용으로 통째 교체('새로 뜬 것'처럼 최신만 표시)
      // (정규식/개행 리터럴은 data: URL 인라인 스크립트에서 깨질 수 있어 charCode 로 처리)
      var NL = String.fromCharCode(10);
      var ACCUMULATE = ${accumulate ? 'true' : 'false'};
      t.addEventListener('paste', function(e) {
        try {
          var pasted = (e.clipboardData || window.clipboardData).getData('text');
          if (!pasted) return;
          var lines = pasted.split(NL).filter(function(l){ return l.trim().length > 0; });
          if (lines.length >= 2) {
            e.preventDefault();
            if (ACCUMULATE) {
              var cur = t.value;
              t.value = cur && cur.length > 0 ? (cur.replace(/\\s+$/, '') + NL + pasted) : pasted;
            } else {
              t.value = pasted;
            }
            t.setSelectionRange(t.value.length, t.value.length);
            t.scrollTop = t.scrollHeight;
          }
        } catch (_) {}
      });
    </script>
  </body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return { success: true };
});

// 결과 IPC — id 별로 main → renderer 로 forward
ipcMain.on('paste-modal:result', (_e, payload: { id: string; action: 'paste' | 'cancel'; text: string }) => {
  const win = pasteWindows.get(payload.id);
  if (win && !win.isDestroyed()) {
    try { win.removeAllListeners('closed'); } catch {}
    try { win.destroy(); } catch {}
  }
  pasteWindows.delete(payload.id);
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 붙여넣기 창을 닫은 뒤 메인 창으로 포커스 복원 — 안 그러면(특히 앱 밖 클릭 후 복귀했을 때)
    // 자식 창이 닫히며 메인이 다른 윈도우 뒤로 가려지는 문제.
    try {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.moveTop();
      mainWindow.focus();
      mainWindow.webContents.focus();
    } catch {}
    mainWindow.webContents.send('paste-modal:result', payload);
  }
});

// 옵션 popout 창
let optionsWindow: BrowserWindow | null = null;
ipcMain.handle('options:open', () => {
  if (optionsWindow && !optionsWindow.isDestroyed()) { optionsWindow.focus(); return { success: true }; }
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  const baseUrl = mainWindow.webContents.getURL().split('?')[0].split('#')[0];
  const sep = baseUrl.includes('?') ? '&' : '?';
  const popUrl = `${baseUrl}${sep}popout=options`;
  const win = new BrowserWindow({
    width: 560, height: 720,
    minWidth: 480, minHeight: 500,
    frame: false, resizable: true,
    backgroundColor: '#111',
    parent: mainWindow,
    skipTaskbar: true,
    title: t('popup.optionsTitle'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  win.setMenu(null);
  optionsWindow = win;
  win.on('closed', () => { optionsWindow = null; });
  win.loadURL(popUrl);
  return { success: true };
});
ipcMain.on('options:close', () => {
  if (optionsWindow && !optionsWindow.isDestroyed()) { try { optionsWindow.close(); } catch {} }
});
ipcMain.on('options:saved', () => {
  // 메인 창에 알림 (필요하면 설정 reload)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('options:saved');
  if (optionsWindow && !optionsWindow.isDestroyed()) { try { optionsWindow.close(); } catch {} }
});

// 세션 편집기 popout 창 — 동일 renderer URL 을 ?popout=session-editor 로 다시 로드
let sessionEditorWindow: BrowserWindow | null = null;
ipcMain.handle('session-editor:open', (_e, { sessionId }: { sessionId: string }) => {
  if (sessionEditorWindow && !sessionEditorWindow.isDestroyed()) { sessionEditorWindow.focus(); return { success: true }; }
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  const baseUrl = mainWindow.webContents.getURL().split('?')[0].split('#')[0];
  const sep = baseUrl.includes('?') ? '&' : '?';
  const popUrl = `${baseUrl}${sep}popout=session-editor&sessionId=${encodeURIComponent(sessionId || 'new')}`;
  const win = new BrowserWindow({
    width: 560, height: 780,
    minWidth: 480, minHeight: 600,
    frame: false, resizable: true, thickFrame: false,
    transparent: false, hasShadow: true,
    roundedCorners: false,            // Windows 11 둥근 모서리 / 보라색 accent border 비활성
    backgroundColor: '#111',
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: t('popup.sessionEditorTitle'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  try { win.setAlwaysOnTop(true, 'floating'); } catch {}
  win.once('ready-to-show', () => { try { win.show(); win.focus(); } catch {} });
  win.setMenu(null); // File/Edit/... 메뉴 제거
  sessionEditorWindow = win;
  win.on('closed', () => { sessionEditorWindow = null; });
  win.loadURL(popUrl);
  return { success: true };
});
ipcMain.on('session-editor:close', () => {
  if (sessionEditorWindow && !sessionEditorWindow.isDestroyed()) { try { sessionEditorWindow.close(); } catch {} }
});
ipcMain.on('session-editor:saved', (_e, payload) => {
  // 저장 완료 후 메인 창에 알림 → 세션 목록 갱신
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('session-editor:saved', payload);
  if (sessionEditorWindow && !sessionEditorWindow.isDestroyed()) { try { sessionEditorWindow.close(); } catch {} }
});

// 검색 이력 — 렌더러 재시작/HMR 이나 앱 재시작에도 남아있도록 파일로 영속화.
// (이전엔 SearchBar.tsx 안 모듈 전역 배열에만 담아뒀는데, 렌더러가 리로드되면 그냥 날아갔다.)
function searchHistoryFile(): string { return path.join(app.getPath('userData'), 'search-history.json'); }
function loadSearchHistory(): string[] {
  try {
    const p = searchHistoryFile();
    if (!fs.existsSync(p)) return [];
    const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(arr) ? arr.filter((x: any) => typeof x === 'string') : [];
  } catch { return []; }
}
function saveSearchHistory(list: string[]) {
  try { fs.writeFileSync(searchHistoryFile(), JSON.stringify(list.slice(0, 50)), 'utf-8'); } catch {}
}
ipcMain.handle('search:history-get', () => loadSearchHistory());
ipcMain.on('search:history-add', (_e, q: string) => {
  if (!q || !q.trim()) return;
  const list = loadSearchHistory().filter(x => x !== q);
  list.unshift(q);
  saveSearchHistory(list);
});

// X11 서버 제어 IPC
ipcMain.handle('x11:start', async (_e, displayNum: number = 0) => {
  const logs: string[] = [];
  const result = await startBundledX11(displayNum, (m) => logs.push(m));
  return { usedBundled: result.usedBundled, pid: result.proc?.pid ?? null, displayNum: result.displayNum, logs };
});
ipcMain.handle('x11:stop', (_e, displayNum: number = 0) => {
  stopBundledX11(displayNum);
  stopEmbeddedX11();
  return { success: true };
});
ipcMain.handle('x11:status', () => {
  const running = listRunningX11();
  return { running, anyRunning: running.length > 0 };
});

// 클립보드에 이미지(PNG bytes) 쓰기 — renderer 의 navigator.clipboard.write 가 실패하는 환경 대비
ipcMain.handle('clipboard:write-image', (_e, { dataUrl }: { dataUrl: string }) => {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) return { success: false, error: 'empty image' };
    clipboard.writeImage(img);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

// 탐색기 우클릭 컨텍스트 메뉴 등록/해제
ipcMain.handle('app:register-context-menu', () => {
  if (process.platform !== 'win32') return { success: false, error: 'Windows only' };
  const { execSync } = require('child_process');
  const os = require('os');
  try {
    // Portable: PORTABLE_EXECUTABLE_FILE 환경변수로 원본 exe 경로 사용
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const tmpCwdFile = path.join(os.tmpdir(), '.pepe-terminal-cwd');
    const iconPath = app.isPackaged ? exePath : path.join(__dirname, '..', 'public', 'icon.ico');

    // 런처 vbs 생성 — 창 없이 경로를 임시파일에 쓰고 exe 실행
    const vbsPath = path.join(app.getPath('userData'), 'pepe-open-here.vbs');
    const vbsContent = [
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      `Set f = fso.CreateTextFile("${tmpCwdFile}", True)`,
      'f.Write WScript.Arguments(0)',
      'f.Close',
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run """${exePath}""" & " """ & WScript.Arguments(0) & """", 1, False`,
    ].join('\r\n');
    fs.writeFileSync(vbsPath, vbsContent, 'utf8');

    const vbsEsc = vbsPath.replace(/\\/g, '\\\\');
    const iconEsc = iconPath.replace(/\\/g, '\\\\');

    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal" /ve /d "Open PePe Terminal here" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal" /v Icon /d "${iconEsc}" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal\\command" /ve /d "wscript \\"${vbsEsc}\\" \\"%V\\"" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\shell\\PepeTerminal" /ve /d "Open PePe Terminal here" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\shell\\PepeTerminal" /v Icon /d "${iconEsc}" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\shell\\PepeTerminal\\command" /ve /d "wscript \\"${vbsEsc}\\" \\"%1\\"" /f`, { stdio: 'pipe' });
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('app:unregister-context-menu', () => {
  if (process.platform !== 'win32') return { success: false, error: 'Windows only' };
  const { execSync } = require('child_process');
  try {
    execSync(`reg delete "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal" /f`, { stdio: 'pipe' });
    execSync(`reg delete "HKCU\\Software\\Classes\\Directory\\shell\\PepeTerminal" /f`, { stdio: 'pipe' });
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('app:check-context-menu', () => {
  if (process.platform !== 'win32') return false;
  const { execSync } = require('child_process');
  try {
    execSync(`reg query "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal"`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
});

ipcMain.handle('sessions:list', () => sessionsData);

ipcMain.handle('sessions:save', (_e, s: Session) => {
  const idx = sessionsData.sessions.findIndex(x => x.id === s.id);
  const saved: Session = { ...s, name: uniqueSessionName(s.name, s.id) };
  if (idx >= 0) sessionsData.sessions[idx] = saved;
  else sessionsData.sessions.push(saved);
  saveSessionsData(sessionsData);
  return sessionsData;
});

// 세션을 복사/복제하거나("New Session" 기본값 그대로 저장하는 등) 그냥 새로 추가할 때도 매번
// 똑같은 이름이 생성돼서 목록에 구분 안 되는 동명 세션이 여러 개 쌓였다 — 자기 자신(id 로 구분,
// 이름 안 바꾸고 그냥 다시 저장하는 경우) 을 제외한 다른 세션과 이름이 겹치면 " 2", " 3"... 을
// 붙여서 유일한 이름이 나올 때까지 늘린다.
function uniqueSessionName(baseName: string, excludeId?: string): string {
  const existingNames = new Set(sessionsData.sessions.filter(s => s.id !== excludeId).map(s => s.name));
  if (!existingNames.has(baseName)) return baseName;
  let i = 2;
  while (existingNames.has(`${baseName} ${i}`)) i++;
  return `${baseName} ${i}`;
}

function cloneSessionForDuplicate(source: Session, newId: string, nameSuffix: string): Session {
  const cloned: Session = JSON.parse(JSON.stringify(source));
  cloned.id = newId;
  cloned.name = uniqueSessionName(`${source.name} (${nameSuffix || 'Copy'})`);
  return cloned;
}

ipcMain.handle('sessions:duplicate', (_e, args: { sessionId: string; targetFolderId?: string | null; nameSuffix?: string }) => {
  const source = sessionsData.sessions.find(s => s.id === args?.sessionId);
  if (!source) return { success: false, error: 'source session not found' };

  const newId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const duplicateFolderId = args?.targetFolderId !== undefined ? (args.targetFolderId ?? undefined) : (source.folderId ?? undefined);
  const cloned = cloneSessionForDuplicate(source, newId, args?.nameSuffix || 'Copy');
  cloned.folderId = duplicateFolderId;

  sessionsData.sessions.push(cloned);

  if (duplicateFolderId === (source.folderId ?? undefined)) {
    addToChildOrder(duplicateFolderId, cloned.id, { after: source.id });
  } else {
    addToChildOrder(duplicateFolderId, cloned.id, 'last');
  }

  duplicateSessionState(source.id, cloned.id);
  saveSessionsData(sessionsData);
  return { success: true, session: cloned, data: sessionsData };
});

// childOrder 헬퍼: 부모의 자식 순서 목록 가져오기 (없으면 폴더 먼저, 세션 나중 기본값 생성)
function getChildOrder(parentId?: string): string[] {
  const key = parentId || '__root__';
  if (!sessionsData.childOrder) sessionsData.childOrder = {};
  if (!sessionsData.childOrder[key]) {
    // 기본값: 폴더 먼저, 세션 나중 (기존 동작 호환)
    const folders = sessionsData.folders.filter(f => (f.parentId ?? undefined) === parentId).map(f => f.id);
    const sessions = sessionsData.sessions.filter(s => (s.folderId ?? undefined) === parentId).map(s => s.id);
    sessionsData.childOrder[key] = [...folders, ...sessions];
  }
  // 실제 존재하는 항목만 필터 + 누락된 항목 추가
  const allIds = new Set([
    ...sessionsData.folders.filter(f => (f.parentId ?? undefined) === parentId).map(f => f.id),
    ...sessionsData.sessions.filter(s => (s.folderId ?? undefined) === parentId).map(s => s.id),
  ]);
  const order = sessionsData.childOrder[key].filter(id => allIds.has(id));
  for (const aid of allIds) { if (!order.includes(aid)) order.push(aid); }
  sessionsData.childOrder[key] = order;
  return order;
}

function setChildOrder(parentId: string | undefined, order: string[]) {
  if (!sessionsData.childOrder) sessionsData.childOrder = {};
  sessionsData.childOrder[parentId || '__root__'] = order;
}

function removeFromChildOrder(parentId: string | undefined, itemId: string) {
  const order = getChildOrder(parentId);
  const idx = order.indexOf(itemId);
  if (idx >= 0) order.splice(idx, 1);
  setChildOrder(parentId, order);
}

function addToChildOrder(parentId: string | undefined, itemId: string, position: 'first' | 'last' | { before: string } | { after: string }) {
  const order = getChildOrder(parentId);
  // 이미 있으면 제거
  const existIdx = order.indexOf(itemId);
  if (existIdx >= 0) order.splice(existIdx, 1);
  if (position === 'first') order.unshift(itemId);
  else if (position === 'last') order.push(itemId);
  else if ('before' in position) {
    const ti = order.indexOf(position.before);
    order.splice(ti >= 0 ? ti : 0, 0, itemId);
  } else {
    const ti = order.indexOf(position.after);
    order.splice(ti >= 0 ? ti + 1 : order.length, 0, itemId);
  }
  setChildOrder(parentId, order);
}

ipcMain.handle('sessions:reorder', (_e, { id, type, direction }: { id: string; type: 'session' | 'folder'; direction: 'up' | 'down' | 'top' | 'bottom' }) => {
  // 현재 부모 찾기
  let parentId: string | undefined;
  if (type === 'session') {
    const sess = sessionsData.sessions.find(s => s.id === id);
    if (!sess) return sessionsData;
    parentId = sess.folderId;
  } else {
    const folder = sessionsData.folders.find(f => f.id === id);
    if (!folder) return sessionsData;
    parentId = folder.parentId;
  }

  const order = getChildOrder(parentId);
  const idx = order.indexOf(id);
  if (idx < 0) return sessionsData;

  if (direction === 'top') {
    // 같은 폴더 내 맨 처음
    order.splice(idx, 1);
    order.unshift(id);
    setChildOrder(parentId, order);
  } else if (direction === 'bottom') {
    // 같은 폴더 내 맨 끝
    order.splice(idx, 1);
    order.push(id);
    setChildOrder(parentId, order);
  } else if (direction === 'up') {
    if (idx > 0) {
      const prevId = order[idx - 1];
      const prevIsFolder = sessionsData.folders.some(f => f.id === prevId);
      if (prevIsFolder) {
        // 위가 폴더 → 그 폴더 안으로 진입 (마지막 자식으로)
        removeFromChildOrder(parentId, id);
        if (type === 'session') {
          sessionsData.sessions.find(s => s.id === id)!.folderId = prevId;
        } else {
          sessionsData.folders.find(f => f.id === id)!.parentId = prevId;
        }
        addToChildOrder(prevId, id, 'last');
      } else {
        // 위가 세션 → swap
        [order[idx], order[idx - 1]] = [order[idx - 1], order[idx]];
        setChildOrder(parentId, order);
      }
    } else if (parentId) {
      // 폴더 맨 위 → 부모 폴더로 올라감
      removeFromChildOrder(parentId, id);
      if (type === 'session') {
        sessionsData.sessions.find(s => s.id === id)!.folderId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      } else {
        sessionsData.folders.find(f => f.id === id)!.parentId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      }
      const grandParentId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      addToChildOrder(grandParentId, id, { before: parentId });
    }
  } else { // down
    if (idx < order.length - 1) {
      // 아래 항목 확인: 폴더면 진입, 아니면 swap
      const nextId = order[idx + 1];
      const isFolder = sessionsData.folders.some(f => f.id === nextId);
      if (isFolder) {
        // 다음이 폴더 → 그 폴더에 진입 (첫 번째 자식으로)
        removeFromChildOrder(parentId, id);
        if (type === 'session') {
          sessionsData.sessions.find(s => s.id === id)!.folderId = nextId;
        } else {
          sessionsData.folders.find(f => f.id === id)!.parentId = nextId;
        }
        addToChildOrder(nextId, id, 'first');
      } else {
        // 다음이 세션 → swap
        [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
        setChildOrder(parentId, order);
      }
    } else if (parentId) {
      // 폴더 맨 아래 → 부모 폴더 밖으로 (부모 뒤에 배치)
      removeFromChildOrder(parentId, id);
      if (type === 'session') {
        sessionsData.sessions.find(s => s.id === id)!.folderId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      } else {
        sessionsData.folders.find(f => f.id === id)!.parentId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      }
      const grandParentId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      addToChildOrder(grandParentId, id, { after: parentId });
    }
  }

  saveSessionsData(sessionsData);
  return sessionsData;
});

ipcMain.handle('sessions:move-to-folder', (_e, { sessionId, targetFolderId }: { sessionId: string; targetFolderId: string | null }) => {
  const sess = sessionsData.sessions.find(s => s.id === sessionId);
  if (!sess) return sessionsData;
  const oldParent = sess.folderId;
  sess.folderId = targetFolderId ?? undefined;
  // childOrder 갱신 — 옛 부모에서 제거, 새 부모 맨 뒤에 추가
  removeFromChildOrder(oldParent, sessionId);
  addToChildOrder(targetFolderId ?? undefined, sessionId, 'last');
  saveSessionsData(sessionsData);
  return sessionsData;
});

// 드래그앤드롭 위치 지정 이동 — 항목을 target 부모로 옮기고 beforeId 앞 / 없으면 맨 뒤로 삽입.
// type='session' 이면 folderId, 'folder' 면 parentId 갱신. (폴더의 자기 자손으로 이동 금지)
ipcMain.handle('sessions:drop-reorder', (_e, { id, type, targetParentId, beforeId }: { id: string; type: 'session' | 'folder'; targetParentId: string | null; beforeId?: string | null }) => {
  const newParent = targetParentId ?? undefined;
  if (type === 'session') {
    const sess = sessionsData.sessions.find(s => s.id === id);
    if (!sess) return sessionsData;
    const oldParent = sess.folderId;
    sess.folderId = newParent;
    removeFromChildOrder(oldParent, id);
    addToChildOrder(newParent, id, beforeId ? { before: beforeId } : 'last');
  } else {
    const folder = sessionsData.folders.find(f => f.id === id);
    if (!folder) return sessionsData;
    // 자기 자신 또는 자손 폴더로는 이동 금지 (순환 방지)
    const isDescendant = (candidate: string | undefined): boolean => {
      let cur = candidate;
      while (cur) {
        if (cur === id) return true;
        cur = sessionsData.folders.find(f => f.id === cur)?.parentId;
      }
      return false;
    };
    if (isDescendant(newParent)) return sessionsData;
    const oldParent = folder.parentId;
    folder.parentId = newParent;
    removeFromChildOrder(oldParent, id);
    addToChildOrder(newParent, id, beforeId ? { before: beforeId } : 'last');
  }
  saveSessionsData(sessionsData);
  return sessionsData;
});

ipcMain.handle('sessions:delete', (_e, id: string) => {
  sessionsData.sessions = sessionsData.sessions.filter(s => s.id !== id);
  saveSessionsData(sessionsData);
  return sessionsData;
});

ipcMain.handle('folders:save', (_e, f: Folder) => {
  const idx = sessionsData.folders.findIndex(x => x.id === f.id);
  if (idx >= 0) sessionsData.folders[idx] = f;
  else sessionsData.folders.push(f);
  saveSessionsData(sessionsData);
  return sessionsData;
});

ipcMain.handle('folders:delete', (_e, id: string) => {
  // 하위 폴더의 parentId를 삭제된 폴더의 parentId로 올림
  const deleted = sessionsData.folders.find(f => f.id === id);
  const parentId = deleted?.parentId;
  sessionsData.folders = sessionsData.folders.filter(f => f.id !== id);
  sessionsData.folders.forEach(f => { if (f.parentId === id) f.parentId = parentId; });
  // 하위 세션의 folderId도 올림
  sessionsData.sessions.forEach(s => { if (s.folderId === id) s.folderId = parentId; });
  saveSessionsData(sessionsData);
  return sessionsData;
});

// ── SSH IPC ──

// ── Export/Import Sessions ──

// 일반 텍스트 파일 저장 (SQL Tool 데이터 추출 등) — 사용자에게 저장 위치 묻고 UTF-8 로 기록.
ipcMain.handle('dialog:save-text-file', async (_e, args: { defaultName?: string; content: string; filters?: { name: string; extensions: string[] }[] }) => {
  if (!mainWindow) return { success: false, error: 'no window' };
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '파일로 저장',
      defaultPath: args.defaultName || 'export.txt',
      filters: args.filters || [{ name: 'Text', extensions: ['txt'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    // CSV 등 한글이 포함될 수 있으므로 UTF-8 BOM 을 옵션으로 추가하지 않고 plain UTF-8 (Excel 한글 깨짐 대비는 호출부에서 BOM 부착).
    fs.writeFileSync(result.filePath, args.content, 'utf8');
    return { success: true, filePath: result.filePath };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

// 오피스 워크스페이스 — 워드/엑셀/파워포인트/PDF 파일 열기 (office-editor iframe 이 same-origin
// blob: URL 로 로드할 수 있도록 바이너리를 렌더러에 그대로 넘긴다).
const OFFICE_OPEN_FILTERS: Record<string, { name: string; extensions: string[] }> = {
  hwp: { name: 'HWP Document', extensions: ['hwp', 'hwpx'] },
  docx: { name: 'Word Document', extensions: ['docx'] },
  xlsx: { name: 'Excel Workbook', extensions: ['xlsx'] },
  pptx: { name: 'PowerPoint Presentation', extensions: ['pptx'] },
  pdf: { name: 'PDF Document', extensions: ['pdf'] },
  drawio: { name: 'draw.io Diagram', extensions: ['drawio', 'xml'] },
};
function readOfficeFile(filePath: string) {
  const data = fs.readFileSync(filePath);
  return { filePath, fileName: path.basename(filePath), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
}
ipcMain.handle('office-doc:open-file', async (_e, { kind }: { kind: 'hwp' | 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'drawio' }) => {
  if (!mainWindow) return null;
  const filter = OFFICE_OPEN_FILTERS[kind];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '파일 열기',
    filters: filter ? [filter, { name: 'All Files', extensions: ['*'] }] : [{ name: 'All Files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  try {
    return readOfficeFile(result.filePaths[0]);
  } catch (e: any) {
    return { error: String(e?.message || e) };
  }
});
// 최근 문서 리스트에서 다시 열 때 — 다이얼로그 없이 저장된 경로로 바로 읽는다.
ipcMain.handle('office-doc:read-file', async (_e, { filePath }: { filePath: string }) => {
  try {
    return readOfficeFile(filePath);
  } catch (e: any) {
    return { error: String(e?.message || e) };
  }
});

// 오피스 워크스페이스 — 임의 바이너리 저장 (PDF 주석 편집 등, pdf.js saveDocument() 결과 등).
ipcMain.handle('office-doc:save-file', async (_e, args: { data: ArrayBuffer; defaultName?: string; filters?: { name: string; extensions: string[] }[] }) => {
  if (!mainWindow) return { success: false, error: 'no window' };
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '파일 저장',
      defaultPath: args.defaultName || 'document',
      filters: args.filters || [{ name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    fs.writeFileSync(result.filePath, Buffer.from(args.data));
    return { success: true, filePath: result.filePath };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('office-recents:get', (_e, { kind }: { kind: string }) => getOfficeRecents(kind));
ipcMain.handle('office-recents:add', (_e, { kind, doc }: { kind: string; doc: { filePath: string; fileName: string } }) => addOfficeRecent(kind, doc));
ipcMain.handle('office-recents:remove', (_e, { kind, filePath }: { kind: string; filePath: string }) => removeOfficeRecent(kind, filePath));

// ── 미디어 플레이어 — 파일 열기 / 최근 재생 목록 / #!ENC 복호화 ──
const MEDIA_OPEN_FILTER = { name: 'Audio Files', extensions: ['wav', 'alaw', 'pcma', 'al', 'ulaw', 'pcmu', 'mulaw', 'ul', 'amr', 'amrnb', 'awb', 'amrwb', 'evs', 'opus', 'raw'] };
// mp4/m4v/mov/webm/ogv 는 GStreamer 사이드카나 로컬 디코딩 없이 Chromium 내장 디코더로 그대로
// 재생한다(electron/mediaCodec.ts 의 VIDEO_EXTENSIONS 와 동일 목록).
const MEDIA_OPEN_VIDEO_FILTER = { name: 'Video Files', extensions: ['mp4', 'm4v', 'mov', 'webm', 'ogv'] };
const MEDIA_OPEN_PCAP_FILTER = { name: 'PCAP Files', extensions: ['pcap', 'pcapng', 'cap'] };
const PCAP_EXT_RE = /\.(pcap|pcapng|cap)$/i;
ipcMain.handle('media:open-file', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '미디어 파일 열기',
    filters: [MEDIA_OPEN_FILTER, MEDIA_OPEN_VIDEO_FILTER, MEDIA_OPEN_PCAP_FILTER, { name: 'All Files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  if (PCAP_EXT_RE.test(filePath)) {
    try {
      const streams = probePcapFile(filePath);
      return { filePath, fileName: path.basename(filePath), isPcap: true, streams };
    } catch (e: any) {
      return { error: String(e?.message || e) };
    }
  }
  try {
    return { ...mediaProbeFile(filePath), isPcap: false };
  } catch (e: any) {
    return { error: String(e?.message || e) };
  }
});
ipcMain.handle('media:probe-file', (_e, { filePath }: { filePath: string }) => {
  try {
    return mediaProbeFile(filePath);
  } catch (e: any) {
    return { error: String(e?.message || e) };
  }
});
ipcMain.handle('media:crypto-available', () => isCryptoNativeAvailable());
ipcMain.handle('media:decrypt', (_e, { filePath, password }: { filePath: string; password: string }) => {
  try {
    return mediaDecryptToTemp(filePath, password);
  } catch (e: any) {
    return { error: String(e?.message || e) };
  }
});
ipcMain.handle('media-recents:get', () => getMediaRecents());
ipcMain.handle('media-recents:add', (_e, { doc }: { doc: { filePath: string; fileName: string; durationSec?: number; codec?: string } }) => addMediaRecent(doc));
ipcMain.handle('media-recents:remove', (_e, { filePath }: { filePath: string }) => removeMediaRecent(filePath));
ipcMain.handle('media-recents:set-position', (_e, { filePath, positionSec }: { filePath: string; positionSec: number }) => updateMediaPosition(filePath, positionSec));
ipcMain.handle('media-playlist:get', () => getMediaPlaylist());
ipcMain.handle('media-playlist:add', (_e, { items }: { items: { filePath: string; fileName: string; codec?: string }[] }) => addMediaPlaylistItems(items));
ipcMain.handle('media-playlist:remove', (_e, { filePath }: { filePath: string }) => removeMediaPlaylistItem(filePath));
ipcMain.handle('media-playlist:reorder', (_e, { orderedFilePaths }: { orderedFilePaths: string[] }) => reorderMediaPlaylist(orderedFilePaths));
// WAV/A-law/u-law/raw 는 GStreamer 없이 로컬 코드로 직접 디코딩 — 16bit PCM 을 렌더러로 넘겨 Web Audio API 로 재생.
ipcMain.handle('media:decode-local', (_e, { filePath, codec }: { filePath: string; codec: MediaCodec }) => {
  try {
    const { pcm, sampleRate, channels } = decodeLocalCodec(filePath, codec);
    return { sampleRate, channels, pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) };
  } catch (e: any) {
    return { error: String(e?.message || e) };
  }
});
// EVS/AMR-NB/AMR-WB/OPUS 는 네이티브 GStreamer 사이드카로 WAV 로 디코딩한 뒤,
// 그 WAV 를 media:decode-local(로컬 코드 경로)로 다시 읽어 재생 파이프라인을 통일한다.
ipcMain.handle('media:decode-gstreamer', async (_e, { filePath, codec }: { filePath: string; codec: 'evs' | 'amrnb' | 'amrwb' | 'opus' }) => {
  const result = await decodeToWav(filePath, codec);
  if ('error' in result) return { error: result.error };
  try {
    const { pcm, sampleRate, channels } = decodeLocalCodec(result.wavPath, 'wav');
    fs.unlink(result.wavPath, () => {});
    return { sampleRate, channels, pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) };
  } catch (e: any) {
    fs.unlink(result.wavPath, () => {});
    return { error: String(e?.message || e) };
  }
});
// 영상 파일 — PCM 디코딩은 안 하지만, file:// URL 을 <video src> 에 직접 넣는 방식은 이 앱에서
// 렌더러가 항상 로드하지 못했다(검은 화면, 재생 버튼 자체가 안 뜸 — webSecurity 로 인해 렌더러
// origin 에서 임의 file:// 리소스를 못 읽는 것으로 보임). PDF/오피스 파일들과 동일하게, 파일을
// 통째로 읽어 ArrayBuffer 로 넘기고 렌더러에서 Blob URL 로 바꿔 재생한다 — 이미 검증된 경로.
ipcMain.handle('media:read-video', (_e, { filePath }: { filePath: string }) => {
  try {
    const data = fs.readFileSync(filePath);
    return { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  } catch (e: any) {
    return { error: String(e?.message || e) };
  }
});

// ── pcap/pcapng — RTP 스트림 탐색 및 재생용 추출 (파일 열기는 media:open-file 에 통합됨) ──
ipcMain.handle('pcap:probe-file', (_e, { filePath }: { filePath: string }) => {
  try {
    const streams = probePcapFile(filePath);
    return { filePath, fileName: path.basename(filePath), streams };
  } catch (e: any) {
    return { error: String(e?.message || e) };
  }
});
ipcMain.handle('pcap:extract-stream', (_e, { filePath, streamId, forcedCodec, evsFormat }: { filePath: string; streamId: string; forcedCodec?: string; evsFormat?: 'header-full' | 'compact' }) => {
  try {
    return extractRtpStreamToTemp(filePath, streamId, { forcedCodec: forcedCodec as any, evsFormat });
  } catch (e: any) {
    return { error: String(e?.message || e) };
  }
});

// ── 미디어 편집기 — "모든 코덱으로 저장" / "암호화 코덱 저장" ──
// 렌더러에서 audioBufferToWav() 로 만든 WAV 바이트를 받아, 원본 파일의 코덱을 제외한 나머지
// 6개 코덱(alaw/ulaw/opus/evs/amrwb/amrnb, wav 자체 제외 시 7개 중 원본 제외분)으로 각각
// 인코딩해 지정 폴더에 저장한다. alaw/ulaw/wav 는 GStreamer 없이 로컬 코드로 바로 인코딩하고
// (mediaCodec.ts), amrnb/amrwb/evs/opus 는 GStreamer 사이드카로 인코딩한다(gstreamerSidecar.ts).
const ALL_MEDIA_CODECS: MediaCodec[] = ['wav', 'alaw', 'ulaw', 'amrnb', 'amrwb', 'evs', 'opus'];
const MEDIA_CODEC_EXT: Record<MediaCodec, string> = {
  wav: '.wav', alaw: '.alaw', ulaw: '.ulaw', amrnb: '.amrnb', amrwb: '.amrwb', evs: '.evs', opus: '.opus',
  raw: '.raw', video: '', unknown: '',
};

/** WAV 바이트(16bit PCM)를 지정 코덱의 최종 파일 바이트(매직 헤더/컨테이너 포함)로 인코딩한다. */
async function encodeWavToCodecBytes(wavBuf: Buffer, codec: MediaCodec): Promise<Buffer> {
  if (codec === 'wav') return wavBuf;

  if (codec === 'alaw' || codec === 'ulaw') {
    // G.711(A-law/u-law)은 항상 8kHz 모노 입력이 필요 — 편집된 오디오가 다른 샘플레이트/채널
    // (예: EVS/AMR-WB 원본의 16kHz)를 갖고 있으면 GStreamer 로 8kHz 모노로 리샘플링한 뒤 인코딩한다.
    let { pcm, sampleRate, channels } = decodeLocalCodec_fromBuffer(wavBuf);
    if (sampleRate !== 8000 || channels !== 1) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pepe-media-resample-'));
      const tempWavPath = path.join(tempDir, 'input.wav');
      fs.writeFileSync(tempWavPath, wavBuf);
      try {
        const result = await resampleWavTo8kMono(tempWavPath);
        if ('error' in result) throw new Error(result.error);
        const resampledBuf = fs.readFileSync(result.outPath);
        try { fs.unlinkSync(result.outPath); } catch {}
        ({ pcm, sampleRate, channels } = decodeLocalCodec_fromBuffer(resampledBuf));
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    }
    return codec === 'alaw' ? encodeAlaw(pcm) : encodeUlaw(pcm);
  }

  // amrnb/amrwb/evs/opus — GStreamer 사이드카 인코딩. 사이드카는 파일 경로 기반이라 WAV 를
  // 임시 파일로 먼저 써야 한다(리샘플/모노 변환은 GStreamer 파이프라인이 audioresample 로 처리).
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pepe-media-enc-'));
  const tempWavPath = path.join(tempDir, 'input.wav');
  fs.writeFileSync(tempWavPath, wavBuf);
  try {
    const kind = codec as 'amrnb' | 'amrwb' | 'evs' | 'opus';
    const result = await encodeFromWav(tempWavPath, kind);
    if ('error' in result) throw new Error(result.error);
    const rawBuf = fs.readFileSync(result.outPath);
    try { fs.unlinkSync(result.outPath); } catch {}
    if (kind === 'opus') return rawBuf; // oggmux 가 이미 완결된 Ogg 컨테이너를 만들어줌
    const magic = kind === 'amrnb' ? '#!AMR\n' : kind === 'amrwb' ? '#!AMR-WB\n' : '#!EVS_MC1.0\n';
    return Buffer.concat([Buffer.from(magic, 'latin1'), rawBuf]);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

// decodeLocalCodec 은 파일 경로를 받으므로, 이미 메모리에 있는 WAV 바이트를 임시파일 없이
// 바로 파싱하기 위한 얇은 래퍼 (WAV 헤더 파싱 자체는 mediaCodec.ts 의 parseWavHeader 재사용).
function decodeLocalCodec_fromBuffer(wavBuf: Buffer): { pcm: Int16Array; sampleRate: number; channels: number } {
  const info = parseWavHeader(wavBuf);
  const dataBuf = wavBuf.subarray(info.dataOffset, info.dataOffset + info.dataLength);
  if (info.bitsPerSample !== 16) throw new Error(`지원하지 않는 WAV 비트: ${info.bitsPerSample}`);
  const pcm = new Int16Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.length / 2);
  return { pcm: pcm.slice(), sampleRate: info.sampleRate, channels: info.channels || 1 };
}

ipcMain.handle('media:save-all-codecs', async (_e, args: { wavData: ArrayBuffer; baseFileName: string; excludeCodec: MediaCodec }) => {
  if (!mainWindow) return { success: false, error: 'no window' };
  const pick = await dialog.showOpenDialog(mainWindow, {
    title: '저장할 폴더 선택',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (pick.canceled || pick.filePaths.length === 0) return { success: false, canceled: true };
  const targetDir = pick.filePaths[0];

  const wavBuf = Buffer.from(args.wavData);
  const codecs = ALL_MEDIA_CODECS.filter((c) => c !== args.excludeCodec);
  const saved: string[] = [];
  const failed: { codec: MediaCodec; error: string }[] = [];
  for (const codec of codecs) {
    try {
      const bytes = await encodeWavToCodecBytes(wavBuf, codec);
      const outPath = path.join(targetDir, `${args.baseFileName}${MEDIA_CODEC_EXT[codec]}`);
      fs.writeFileSync(outPath, bytes);
      saved.push(outPath);
    } catch (e: any) {
      failed.push({ codec, error: String(e?.message || e) });
    }
  }
  return { success: true, targetDir, saved, failed };
});

ipcMain.handle('media:save-encrypted-all-codecs', async (_e, args: { wavData: ArrayBuffer; baseFileName: string; password: string; version: number }) => {
  if (!mainWindow) return { success: false, error: 'no window' };
  if (!Number.isInteger(args.version) || args.version < 1 || args.version > 99) {
    return { success: false, error: '#!ENC 버전은 01~99 사이의 정수여야 합니다.' };
  }
  const pick = await dialog.showOpenDialog(mainWindow, {
    title: '저장할 폴더 선택',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (pick.canceled || pick.filePaths.length === 0) return { success: false, canceled: true };
  const targetDir = pick.filePaths[0];

  const wavBuf = Buffer.from(args.wavData);
  const saved: string[] = [];
  const failed: { codec: MediaCodec; error: string }[] = [];
  for (const codec of ALL_MEDIA_CODECS) {
    try {
      const bytes = await encodeWavToCodecBytes(wavBuf, codec);
      const outPath = path.join(targetDir, `${args.baseFileName}${MEDIA_CODEC_EXT[codec]}`);
      mediaEncryptToFile(bytes, args.password, outPath, args.version);
      saved.push(outPath);
    } catch (e: any) {
      failed.push({ codec, error: String(e?.message || e) });
    }
  }
  return { success: true, targetDir, saved, failed };
});

ipcMain.handle('sessions:export', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Sessions',
    defaultPath: 'sessions-export.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  try {
    fs.writeFileSync(result.filePath, JSON.stringify(sessionsData, null, 2), 'utf8');
    return result.filePath;
  } catch { return null; }
});

ipcMain.handle('sessions:import', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Sessions',
    filters: [
      { name: 'All Supported', extensions: ['json', 'xml', 'xts'] },
      { name: 'PePe Terminal JSON', extensions: ['json'] },
      { name: 'SecureCRT XML', extensions: ['xml'] },
      { name: 'Xshell Backup (xts)', extensions: ['xts'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const ext = path.extname(filePath).toLowerCase();
  try {
    let imported: SessionsData;
    if (ext === '.xml') {
      imported = parseSecureCRTXml(filePath);
    } else if (ext === '.xts') {
      imported = parseXshellXts(filePath);
    } else {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      imported = Array.isArray(raw)
        ? { folders: [], sessions: raw }
        : { folders: raw.folders ?? [], sessions: raw.sessions ?? [] };
    }
    // 기존 데이터에 머지 (중복: host+port+username 동일하면 스킵)
    for (const f of imported.folders) {
      const exists = sessionsData.folders.some(x => x.name === f.name && x.parentId === f.parentId);
      if (!exists) sessionsData.folders.push(f);
      else {
        // 같은 이름+부모의 기존 폴더 ID로 세션의 folderId를 매핑
        const existing = sessionsData.folders.find(x => x.name === f.name && x.parentId === f.parentId)!;
        for (const s of imported.sessions) {
          if (s.folderId === f.id) s.folderId = existing.id;
        }
        // 하위 폴더의 parentId도 매핑
        for (const cf of imported.folders) {
          if (cf.parentId === f.id) cf.parentId = existing.id;
        }
      }
    }
    let addedCount = 0;
    for (const s of imported.sessions) {
      const dup = sessionsData.sessions.some(x => x.host === s.host && x.port === s.port && x.username === s.username && x.name === s.name);
      if (!dup) { sessionsData.sessions.push(s); addedCount++; }
    }
    saveSessionsData(sessionsData);
    return { data: sessionsData, addedCount, totalParsed: imported.sessions.length };
  } catch (err: any) { console.error('Import error:', err); return null; }
});

ipcMain.handle('sessions:clear', () => {
  sessionsData = { folders: [], sessions: [], keySeqDefaultsV1: true };
  saveSessionsData(sessionsData);
  return { success: true, data: sessionsData };
});

ipcMain.handle('sessions:replace-all', (_e, data: SessionsData) => {
  try {
    sessionsData = {
      folders: Array.isArray(data?.folders) ? data.folders : [],
      sessions: Array.isArray(data?.sessions) ? data.sessions : [],
      childOrder: data?.childOrder && typeof data.childOrder === 'object' ? data.childOrder : undefined,
      keySeqDefaultsV1: data?.keySeqDefaultsV1 === true,
    };
    saveSessionsData(sessionsData);
    return { success: true, data: sessionsData };
  } catch (err: any) {
    console.error('sessions:replace-all error:', err);
    return { success: false, error: String(err?.message || err) };
  }
});

// ── SecureCRT XML 파서 ──
function parseSecureCRTXml(filePath: string): SessionsData {
  const xml = fs.readFileSync(filePath, 'utf8');
  const lines = xml.split('\n');
  const folders: Folder[] = [];
  const sessions: Session[] = [];

  let inSessions = false;
  let depth = 0;
  const keyStack: { name: string; folderId?: string; props: Record<string, string> }[] = [];

  for (const line of lines) {
    if (line.includes('<key name="Sessions">')) { inSessions = true; depth = 0; continue; }
    if (!inSessions) continue;

    const keyMatch = line.match(/<key name="([^"]+)">/);
    if (keyMatch) {
      depth++;
      const parentFolderId = keyStack.length > 0 ? keyStack[keyStack.length - 1].folderId : undefined;
      keyStack.push({ name: keyMatch[1], folderId: undefined, props: {} });
      // 부모 폴더 ID 기억
      keyStack[keyStack.length - 1].folderId = `folder-scrt-${Date.now()}-${depth}-${Math.random().toString(36).slice(2, 6)}`;
      keyStack[keyStack.length - 1].props['_parentFolderId'] = parentFolderId || '';
      continue;
    }

    if (line.includes('</key>')) {
      if (keyStack.length > 0) {
        const item = keyStack.pop()!;
        const hostname = item.props['Hostname'];
        if (hostname) {
          // 이것은 세션
          const portStr = item.props['[SSH2] Port'] || '22';
          const username = item.props['Username'] || '';
          const encodingRaw = item.props['Output Transformer Name'] || '';
          let encoding = 'utf-8';
          if (encodingRaw.toLowerCase().includes('euc-kr') || encodingRaw.toLowerCase().includes('euc_kr')) encoding = 'euc-kr';
          else if (encodingRaw.toLowerCase().includes('cp949')) encoding = 'cp949';
          else if (encodingRaw.toLowerCase().includes('utf-8') || encodingRaw.toLowerCase().includes('utf8') || encodingRaw === 'UTF-8') encoding = 'utf-8';
          else if (encodingRaw) encoding = encodingRaw.toLowerCase();

          const parentFolderId = item.props['_parentFolderId'] || undefined;
          sessions.push({
            id: `sess-scrt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: item.name,
            host: hostname,
            port: parseInt(portStr, 10) || 22,
            username,
            encoding,
            folderId: parentFolderId || undefined,
            auth: { type: 'password', password: '' },
          });
        } else {
          // 하위 세션이 있었다면 이것은 폴더
          const hasSessions = sessions.some(s => s.folderId === item.folderId);
          const hasSubFolders = folders.some(f => f.parentId === item.folderId);
          if (hasSessions || hasSubFolders) {
            const parentFolderId = item.props['_parentFolderId'] || undefined;
            folders.push({
              id: item.folderId!,
              name: item.name,
              parentId: parentFolderId || undefined,
            });
          }
        }
      }
      depth--;
      if (depth < 0) break;
      continue;
    }

    // 프로퍼티 파싱
    if (keyStack.length > 0) {
      const strMatch = line.match(/<string name="([^"]+)">([^<]*)<\/string>/);
      if (strMatch) { keyStack[keyStack.length - 1].props[strMatch[1]] = strMatch[2]; continue; }
      const dwordMatch = line.match(/<dword name="([^"]+)">(\d+)<\/dword>/);
      if (dwordMatch) { keyStack[keyStack.length - 1].props[dwordMatch[1]] = dwordMatch[2]; continue; }
      const emptyStr = line.match(/<string name="([^"]+)"\/>/);
      if (emptyStr) { keyStack[keyStack.length - 1].props[emptyStr[1]] = ''; continue; }
    }
  }

  return { folders, sessions };
}

// ── Xshell xts(ZIP) 파서 ──
function parseXshellXts(filePath: string): SessionsData {
  const folders: Folder[] = [];
  const sessions: Session[] = [];
  const folderMap = new Map<string, string>(); // path → folderId

  // 임시 디렉토리에 추출
  const tmpDir = path.join(os.tmpdir(), `pepe-xshell-import-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // PowerShell Expand-Archive는 .zip만 허용하므로 .xts → .zip 복사 후 추출
    const zipCopy = path.join(tmpDir, 'import.zip');
    fs.copyFileSync(filePath, zipCopy);
    execSync(`powershell -Command "Expand-Archive -Path '${zipCopy}' -DestinationPath '${tmpDir}' -Force"`, { timeout: 30000 });
    try { fs.unlinkSync(zipCopy); } catch {}

    // Xshell 폴더 찾기
    const xshellDir = path.join(tmpDir, 'Xshell');
    if (!fs.existsSync(xshellDir)) {
      // Xshell 폴더가 없으면 tmpDir 자체를 탐색
      walkXshellDir(tmpDir, '', folders, sessions, folderMap);
    } else {
      walkXshellDir(xshellDir, '', folders, sessions, folderMap);
    }
  } finally {
    // 임시 디렉토리 정리
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  return { folders, sessions };
}

// Xshell encoding 숫자 → 문자열 매핑
function xshellEncodingMap(val: string): string {
  switch (val) {
    case '2': return 'euc-kr';
    case '0': case '65001': return 'utf-8';
    case '1': return 'cp949';
    case '28591': return 'latin1';
    default: return 'utf-8';
  }
}

function getOrCreateFolder(folderPath: string, folders: Folder[], folderMap: Map<string, string>): string | undefined {
  if (!folderPath || folderPath === '.') return undefined;
  if (folderMap.has(folderPath)) return folderMap.get(folderPath)!;

  const parts = folderPath.split(/[\\/]/);
  let currentPath = '';
  let parentId: string | undefined;

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    if (folderMap.has(currentPath)) {
      parentId = folderMap.get(currentPath)!;
      continue;
    }
    const folderId = `folder-xsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    folders.push({ id: folderId, name: part, parentId });
    folderMap.set(currentPath, folderId);
    parentId = folderId;
  }
  return parentId;
}

function walkXshellDir(dir: string, relPath: string, folders: Folder[], sessions: Session[], folderMap: Map<string, string>) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkXshellDir(fullPath, relPath ? `${relPath}/${entry.name}` : entry.name, folders, sessions, folderMap);
    } else if (entry.name.endsWith('.xsh')) {
      try {
        const buf = fs.readFileSync(fullPath);
        const txt = buf.toString('utf16le');
        const lines = txt.split(/\r?\n/);
        let host = '', port = '22', user = '', enc = 'utf-8';
        let useExpectSend = false, expectSendCount = 0;
        const expectMap: Record<string, string> = {};
        const sendMap: Record<string, string> = {};
        for (const l of lines) {
          const m = l.match(/^(.+?)=(.*)$/);
          if (!m) continue;
          const k = m[1].trim(), v = m[2].trim();
          if (k === 'Host') host = v;
          if (k === 'Port') port = v;
          if (k === 'UserName') user = v;
          if (k === 'Encoding') enc = xshellEncodingMap(v);
          if (k === 'UseExpectSend' && v === '1') useExpectSend = true;
          if (k === 'ExpectSend_Count') expectSendCount = parseInt(v, 10) || 0;
          const expectMatch = k.match(/^ExpectSend_Expect_(\d+)$/);
          if (expectMatch) expectMap[expectMatch[1]] = v;
          const sendMatch = k.match(/^ExpectSend_Send_(\d+)$/);
          if (sendMatch) sendMap[sendMatch[1]] = v;
        }
        if (host) {
          const folderId = getOrCreateFolder(relPath, folders, folderMap);
          const name = entry.name.replace(/\.xsh$/, '');
          // Expect/Send 로그인 스크립트 변환
          const loginScript: { expect: string; send: string }[] = [];
          if (useExpectSend && expectSendCount > 0) {
            for (let i = 0; i < expectSendCount; i++) {
              const expect = expectMap[String(i)] ?? '';
              const send = sendMap[String(i)] ?? '';
              if (send) loginScript.push({ expect, send });
            }
          }
          sessions.push({
            id: `sess-xsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            host,
            port: parseInt(port, 10) || 22,
            username: user,
            encoding: enc,
            folderId,
            auth: { type: 'password', password: '' },
            loginScript: loginScript.length > 0 ? loginScript : undefined,
          });
        }
      } catch {}
    }
  }
}

// ── 파일 탐색기 IPC ──

// 로컬 파일 다중 선택 다이얼로그 — 일괄 파일전송 모달 등에서 사용
ipcMain.handle('dialog:pick-files', async (_e, { multi }: { multi?: boolean }) => {
  if (!mainWindow) return { paths: [] };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: multi ? t('dialog.pickFilesMulti') : t('dialog.pickFile'),
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
  });
  if (result.canceled) return { paths: [] };
  return { paths: result.filePaths };
});

ipcMain.handle('dialog:pick-folder', async () => {
  if (!mainWindow) return { path: null };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t('dialog.pickFolder'),
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return { path: null };
  return { path: result.filePaths[0] };
});

// Windows Explorer 의 "바탕 화면" 가상 항목들을 Shell.Application 으로 열거.
// Windows 의 바탕 화면 namespace = 0x00. 가상 항목 (내 PC, 네트워크, 라이브러리 등) 도 포함.
function getShellDesktopVirtualItems(): any[] {
  try {
    const { execFileSync } = require('child_process');
    const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$desk = $shell.Namespace(0)
# 알려진 shell CLSID → 친화 shell:* 매핑 (My Computer / Network / Recycle Bin 등)
$clsidMap = @{
  '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}' = 'shell:MyComputerFolder'
  '::{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}' = 'shell:NetworkPlacesFolder'
  '::{645FF040-5081-101B-9F08-00AA002F954E}' = 'shell:RecycleBinFolder'
}
if ($desk) {
  $items = @()
  foreach ($it in $desk.Items()) {
    $name = $it.Name
    $path = $it.Path
    $isFolder = $it.IsFolder
    if (-not $name) { continue }
    # 가상 항목 — 알려진 CLSID 면 친화 shell:* 로, 알려지지 않은 CLSID 는 Desktop 체인 (ParseName)
    # 일반 파일 경로면 그대로
    $shellPath = if ($path -and $clsidMap.ContainsKey($path)) {
      $clsidMap[$path]
    } elseif ($path -and $path.StartsWith('::')) {
      # 체인 포맷: shell-pidl:shell:Desktop||<name> — 친화 표시 ('바탕 화면 › 갤러리') + ParseName 트래버설
      'shell-pidl:shell:Desktop||' + $name
    } else {
      $path
    }
    $items += [PSCustomObject]@{ Name = $name; Path = $shellPath; IsDir = [bool]$isFolder }
  }
  $items | ConvertTo-Json -Compress
}`;
    const tmpPs = path.join(os.tmpdir(), `pepe-desktop-${Date.now()}.ps1`);
    try {
      fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
      const out: string = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
      ], { windowsHide: true, timeout: 10000 }).toString('utf-8');
      try { fs.unlinkSync(tmpPs); } catch {}
      const data = JSON.parse(out.trim() || '[]');
      const arr: any[] = Array.isArray(data) ? data : [data];
      const now = Math.floor(Date.now() / 1000);
      const seen = new Set<string>();
      const result: any[] = [];
      for (const x of arr) {
        const name = String(x.Name || '');
        const p = String(x.Path || '');
        if (!name || seen.has(name)) continue;
        seen.add(name);
        result.push({ name, isDir: !!x.IsDir, size: 0, mtime: now, shellPath: p });
      }
      return result;
    } catch {
      try { fs.unlinkSync(tmpPs); } catch {}
      // fallback: 최소한의 가상 항목
      return [
        { name: '내 PC', isDir: true, size: 0, mtime: Math.floor(Date.now()/1000), shellPath: 'shell:MyComputerFolder' },
        { name: '네트워크', isDir: true, size: 0, mtime: Math.floor(Date.now()/1000), shellPath: 'shell:NetworkPlacesFolder' },
        { name: '홈', isDir: true, size: 0, mtime: Math.floor(Date.now()/1000), shellPath: require('os').homedir() },
      ];
    }
  } catch {
    return [];
  }
}

ipcMain.handle('fe:list-dir', async (_e, { mode, termId, dirPath: dirPathArg, encoding }: { mode: string; termId?: string; dirPath: string; encoding?: string }) => {
  let dirPath = dirPathArg;
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') {
      // 특수 shell path 처리
      // shell:Desktop — 가상 데스크톱 (내 PC, 네트워크, 라이브러리, 갤러리 등 + 물리 데스크톱 파일)
      if (dirPath === 'shell:Desktop') {
        const virtuals = getShellDesktopVirtualItems();
        // 물리 데스크톱 폴더의 파일도 같이 enumerate
        try {
          const desktopDir = path.join(os.homedir(), 'Desktop');
          const onedriveDesktop = path.join(os.homedir(), 'OneDrive', '바탕 화면');
          const onedriveDesktopEn = path.join(os.homedir(), 'OneDrive', 'Desktop');
          const candidates = [onedriveDesktop, onedriveDesktopEn, desktopDir];
          for (const d of candidates) {
            if (fs.existsSync(d)) {
              const entries = await fs.promises.readdir(d, { withFileTypes: true });
              const now = Math.floor(Date.now() / 1000);
              const seenNames = new Set(virtuals.map((x: any) => x.name));
              for (const e of entries) {
                if (seenNames.has(e.name)) continue;
                const fp = path.join(d, e.name);
                let size = 0, mtime = now;
                try { const st = await fs.promises.stat(fp); size = st.size; mtime = Math.floor(st.mtimeMs / 1000); } catch {}
                virtuals.push({ name: e.name, isDir: e.isDirectory(), size, mtime, shellPath: fp, realPath: fp });
              }
              break; // 첫 번째 매칭하는 desktop 폴더만
            }
          }
        } catch {}
        return { files: virtuals };
      }
      if (dirPath === 'shell:MyComputerFolder') {
        // "내 PC" — Shell.Application NameSpace(0x11) 로 enumerate: 드라이브 + MTP 디바이스 + 네트워크 단축
        try {
          const { execFileSync } = require('child_process');
          const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$wsh = New-Object -ComObject WScript.Shell

function Resolve-NetHoodPath {
  param([string]$p)
  if (-not $p) { return $p }
  if ($p.StartsWith('\\\\')) { return $p }
  if (-not (Test-Path $p)) { return $p }
  $tlnk = Join-Path $p 'target.lnk'
  if (Test-Path $tlnk) {
    try {
      $lk = $wsh.CreateShortcut($tlnk)
      if ($lk.TargetPath -and $lk.TargetPath.StartsWith('\\\\')) { return $lk.TargetPath }
    } catch {}
  }
  try {
    $lnks = Get-ChildItem -Path $p -Filter '*.lnk' -File -ErrorAction SilentlyContinue
    foreach ($f in $lnks) {
      try {
        $lk = $wsh.CreateShortcut($f.FullName)
        if ($lk.TargetPath -and $lk.TargetPath.StartsWith('\\\\')) { return $lk.TargetPath }
      } catch {}
    }
  } catch {}
  return $p
}

$items = @()
try {
  $pc = $shell.Namespace(0x11)
  if ($pc) {
    foreach ($it in $pc.Items()) {
      $p = $it.Path
      $n = $it.Name
      if (-not $p -or -not $n) { continue }
      $isDir = [bool]$it.IsFolder
      $resolved = Resolve-NetHoodPath $p
      # shell namespace (::{guid}) → shell-pidl: prefix (디바이스 등)
      $finalPath = if ($resolved -and $resolved.StartsWith('::')) { 'shell-pidl:' + $resolved } else { $resolved }
      # Order: 드라이브 1, 디바이스 2, 네트워크 3, 기타 4
      $order = if ($resolved -match '^[A-Z]:') { 1 } elseif ($resolved.StartsWith('::')) { 2 } elseif ($resolved.StartsWith('\\\\')) { 3 } else { 4 }
      $items += [PSCustomObject]@{ Name = $n; IsDir = $isDir; Path = $finalPath; Order = $order }
    }
  }
} catch {}
$items | Sort-Object Order, Name | ConvertTo-Json -Compress`;
          const tmpPs = path.join(os.tmpdir(), `pepe-mypc-${Date.now()}.ps1`);
          fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
          const out: string = execFileSync('powershell', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
          ], { windowsHide: true, timeout: 15000 }).toString('utf-8').trim();
          try { fs.unlinkSync(tmpPs); } catch {}
          const data = JSON.parse(out || '[]');
          const arr: any[] = Array.isArray(data) ? data : [data];
          const now = Math.floor(Date.now() / 1000);
          return { files: arr.map((x: any) => ({
            name: String(x.Name || ''),
            isDir: !!x.IsDir,
            size: 0,
            mtime: now,
            shellPath: String(x.Path || ''),
          })).filter((x: any) => x.name) };
        } catch (err: any) {
          // PowerShell 실패시 fallback — A-Z 드라이브 letter 만
          const drives: any[] = [];
          for (let i = 65; i <= 90; i++) {
            const d = String.fromCharCode(i) + ':\\';
            try { await fs.promises.access(d); drives.push({ name: String.fromCharCode(i) + ':', isDir: true, size: 0, mtime: Math.floor(Date.now()/1000), shellPath: d }); } catch {}
          }
          return { files: drives, error: 'My Computer 열거 fallback (A-Z 드라이브만)' };
        }
      }
      if (dirPath === 'shell:NetworkPlacesFolder') {
        // "네트워크" — NetHood 항목들 UNC 로
        try {
          const netHood = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Network Shortcuts');
          const list: any[] = [];
          if (fs.existsSync(netHood)) {
            const entries = fs.readdirSync(netHood, { withFileTypes: true });
            for (const e of entries) {
              if (!e.isDirectory()) continue;
              const tlnk = path.join(netHood, e.name, 'target.lnk');
              if (fs.existsSync(tlnk)) {
                list.push({ name: e.name, isDir: true, size: 0, mtime: Math.floor(Date.now()/1000), shellPath: 'lnk:' + tlnk });
              }
            }
          }
          return { files: list };
        } catch {
          return { files: [] };
        }
      }
      // shell:* 경로 (위에서 명시적으로 처리되지 않은 것 — RecycleBinFolder, Downloads, Documents 등)
      // shell-pidl:<dirPath> 로 라우팅해서 Shell.Application NameSpace 로 열거.
      if (dirPath.startsWith('shell:') && !dirPath.startsWith('shell-pidl:')) {
        // shell-pidl 경로로 변환해서 동일 로직 진입 (아래 if 블록과 같은 PowerShell enum)
        dirPath = 'shell-pidl:' + dirPath;
      }
      // shell-pidl:: PIDL — Shell.Application 으로 enum
      // path 형식: 'shell-pidl:<root>' (단일) 또는 'shell-pidl:<root>||<name1>||<name2>' (체인)
      // MTP 디바이스 등은 직접 NameSpace 가 안 돼서, root 에서 ParseName 으로 한 단계씩 descend
      if (dirPath.startsWith('shell-pidl:')) {
        const pidlPath = dirPath.slice('shell-pidl:'.length);
        const segs = pidlPath.split('||');
        const rootPath = segs[0];
        const chain = segs.slice(1); // 이름 체인 (각 ParseName 단계)
        // 다음 단계 child 들의 path prefix
        const childPrefix = `shell-pidl:${pidlPath}||`;
        try {
          const { execFileSync } = require('child_process');
          // PowerShell 에 root + 체인 이름 목록 전달
          const psChain = chain.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
          // shell:Desktop 은 파일시스템 데스크톱 만 반환하므로, 가상 항목 enumerate 하려면 CSIDL 0 사용
          const rootArg = rootPath === 'shell:Desktop'
            ? '0'
            : `'${rootPath.replace(/'/g, "''")}'`;
          const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$ns = $shell.NameSpace(${rootArg})
if (-not $ns) {
  Write-Error "NameSpace 실패"
  '[]'
  exit
}
$folder = $ns
$chainNames = @(${psChain})
$ok = $true
foreach ($name in $chainNames) {
  if (-not $folder) { $ok = $false; break }
  # 1차: ParseName (실제 파일 경로 기반 항목에 안정적)
  $child = $folder.ParseName($name)
  # 2차: Items() 순회로 이름 매칭 (가상 항목 fallback)
  if (-not $child) {
    foreach ($c in $folder.Items()) {
      if ($c.Name -eq $name) { $child = $c; break }
    }
  }
  if (-not $child) { $ok = $false; break }
  $sub = $child.GetFolder
  if (-not $sub) {
    # GetFolder 가 null 인 경우 — Path 로 다시 NameSpace 시도
    if ($child.Path) {
      $sub = $shell.NameSpace($child.Path)
    }
  }
  if (-not $sub) { $ok = $false; break }
  $folder = $sub
}
if ($ok -and $folder) {
  $items = @()
  $epoch = (Get-Date '1970-01-01').ToUniversalTime()
  foreach ($it in $folder.Items()) {
    $name = $it.Name
    $isFolder = $it.IsFolder
    if (-not $name) { continue }
    $size = 0
    $mtime = 0
    $realPath = ''
    $itPath = $it.Path
    # 실제 파일시스템 경로면 Get-Item 으로 정확한 size/mtime + realPath 조회
    if ($itPath -and -not $itPath.StartsWith('::') -and (Test-Path -LiteralPath $itPath -ErrorAction SilentlyContinue)) {
      $realPath = $itPath
      try {
        $fi = Get-Item -LiteralPath $itPath -ErrorAction Stop
        if (-not $isFolder) { $size = [int64]$fi.Length }
        if ($fi.LastWriteTime) {
          $mtime = [int][Math]::Floor(($fi.LastWriteTime.ToUniversalTime() - $epoch).TotalSeconds)
        }
      } catch {}
    } else {
      try {
        $d = $it.ModifyDate
        if ($d -is [DateTime]) { $mtime = [int][Math]::Floor(($d.ToUniversalTime() - $epoch).TotalSeconds) }
      } catch {}
      try { if (-not $isFolder) { $size = [int64]$it.Size } } catch {}
    }
    $items += [PSCustomObject]@{ Name = $name; IsDir = [bool]$isFolder; Size = $size; MTime = $mtime; RealPath = $realPath }
  }
  if ($items.Count -gt 0) { $items | ConvertTo-Json -Compress } else { '[]' }
} else {
  '[]'
}`;
          const tmpPs = path.join(os.tmpdir(), `pepe-shell-${Date.now()}.ps1`);
          try {
            fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
            const out: string = execFileSync('powershell', [
              '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
            ], { windowsHide: true, timeout: 15000 }).toString('utf-8');
            try { fs.unlinkSync(tmpPs); } catch {}
            const data = JSON.parse(out.trim() || '[]');
            const arr: any[] = Array.isArray(data) ? data : [data];
            const now = Math.floor(Date.now() / 1000);
            // 각 child 의 shellPath = 현재 path + '||' + 이름 (ParseName 체인 다음 단계)
            // realPath: 실제 파일시스템 경로 (있으면 fs 연산용)
            return { files: arr.map((x: any) => ({
              name: String(x.Name || ''),
              isDir: !!x.IsDir,
              size: Number(x.Size) || 0,
              mtime: Number(x.MTime) || now,
              shellPath: String(x.RealPath || (childPrefix + String(x.Name || ''))),
              realPath: String(x.RealPath || ''),
            })).filter((x: any) => x.name) };
          } catch (e) {
            try { fs.unlinkSync(tmpPs); } catch {}
            return { files: [], error: 'shell namespace 열거 실패' };
          }
        } catch {
          return { files: [], error: 'shell namespace 접근 실패' };
        }
      }
      // .lnk 단축 — 파싱해서 target 으로 리다이렉트
      if (dirPath.startsWith('lnk:')) {
        const lnk = dirPath.slice(4);
        // 1) Electron shell.readShortcutLink — 일반 .lnk 의 target 을 가장 빠르고 안정적으로 읽음
        let target = '';
        try {
          const info = shell.readShortcutLink(lnk);
          if (info?.target) target = String(info.target).trim();
        } catch {}
        // 2) 네트워크 단축 (\\server\share 가리키는 .lnk) — WScript.Shell.TargetPath 가 비어 올 수 있음.
        //    PowerShell 백업 경로 — TargetPath 와 Arguments 둘 다 시도.
        if (!target) {
          try {
            const { execFileSync } = require('child_process');
            const out: string = execFileSync('powershell', [
              '-NoProfile', '-NonInteractive', '-Command',
              // TargetPath 가 비어있으면 .lnk 파일 내부 LinkInfo 의 NetName 을 시도하는 대체 명령
              `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');`
              + `if($s.TargetPath){$s.TargetPath}else{$s.Arguments}`,
            ], { windowsHide: true, timeout: 5000 }).toString('utf-8').trim();
            if (out) target = out;
          } catch {}
        }
        // 3) 그래도 안 되면 .lnk 바이너리에서 직접 UNC 추출 — 네트워크 단축에 자주 효과적.
        if (!target) {
          try {
            const buf = fs.readFileSync(lnk);
            // .lnk 파일 안에는 표시용 string 으로 \\server\share 가 보통 UTF-16LE 또는 ASCII 로 포함됨.
            const asUtf16 = buf.toString('utf16le');
            const asAscii = buf.toString('binary');
            const uncMatch = /\\\\[^\x00<>:"/|?*]+\\[^\x00<>:"/|?*]+/g;
            const m1 = asUtf16.match(uncMatch);
            const m2 = asAscii.match(uncMatch);
            const candidates = [...(m1 || []), ...(m2 || [])]
              // null/제어문자 제거 + 길이순 정렬
              .map(s => s.replace(/\x00/g, '').trim())
              .filter(s => s.length >= 5)
              .sort((a, b) => b.length - a.length);
            if (candidates.length > 0) target = candidates[0];
          } catch {}
        }
        if (target) {
          try {
            const files = await bridge.handleLocalListDir(target);
            return { files, resolvedPath: target };
          } catch (e: any) {
            return { files: [], error: `shortcut 대상 접근 실패: ${target}` };
          }
        }
        return { files: [], error: 'shortcut 해석 실패' };
      }
      // 일반 로컬 디렉토리 — 물리 파일만 (가상 항목은 shell:Desktop 경로에서만)
      const physical = await bridge.handleLocalListDir(dirPath);
      return { files: physical };
    } else {
      if (!termId) return { error: t('error.noConnectionId') };
      const files = await bridge.handleSFTPListDir(termId, dirPath);
      // 인코딩 변환 — UTF-8 외에 cp949/euc-kr 등 선택 시 filename 을 재디코딩
      // ssh2 가 utf-8 로 디코딩한 string 을 latin1 바이트로 보존했다 다시 iconv 로 재해석
      if (encoding && encoding !== 'utf-8' && encoding !== 'utf8') {
        try {
          const iconv = require('iconv-lite');
          if (iconv.encodingExists(encoding)) {
            for (const f of files) {
              if (typeof f.name === 'string' && f.name) {
                try {
                  const bytes = Buffer.from(f.name, 'binary');
                  const decoded = iconv.decode(bytes, encoding);
                  if (decoded && !decoded.includes('�')) f.name = decoded;
                } catch {}
              }
            }
          }
        } catch {}
      }
      return { files };
    }
  } catch (err: any) { return { error: `${dirPath}: ${String(err)}` }; }
});

// ── 파일 비교 (CompareWorkspace) ──
const COMPARE_BINARY_EXTS = new Set([
  '.a', '.o', '.obj', '.lib', '.dll', '.exe', '.so', '.dylib', '.class', '.jar', '.war', '.ear',
  '.zip', '.7z', '.gz', '.bz2', '.xz', '.rar', '.iso', '.pdf', '.png', '.jpg', '.jpeg', '.gif',
  '.bmp', '.webp', '.ico', '.mp3', '.mp4', '.mov', '.mkv', '.avi', '.wav', '.woff', '.woff2',
  '.ttf', '.otf', '.eot', '.psd', '.sqlite', '.db', '.bin',
]);
function isBinaryComparePath(relPath: string): boolean {
  const leaf = String(relPath || '').replace(/\\/g, '/').split('/').pop() || '';
  const ext = leaf.includes('.') ? leaf.slice(leaf.lastIndexOf('.')).toLowerCase() : '';
  return COMPARE_BINARY_EXTS.has(ext);
}
// 재귀 walk — 한 번의 IPC 로 폴더 전체 트리를 평탄화해서 반환. 대용량 폴더에서 N번 round-trip 회피.
// 결과는 [{ relPath, isDir, size, mtime }] flat 배열. 상한 옵션으로 walk 폭주 방지.
const COMPARE_WALK_MAX_ENTRIES = 50000;
ipcMain.handle('compare:walk', async (_e, { mode, termId, basePath, maxEntries, ignoreBinaryFiles }: { mode: string; termId?: string; basePath: string; maxEntries?: number; ignoreBinaryFiles?: boolean }) => {
  const cap = Math.min(maxEntries || COMPARE_WALK_MAX_ENTRIES, COMPARE_WALK_MAX_ENTRIES);
  const out: { relPath: string; isDir: boolean; size: number; mtime: number }[] = [];
  let truncated = false;
  try {
    const bridge = getSSHBridge();
    const sep = mode === 'local' && process.platform === 'win32' ? '\\' : '/';
    const join = (a: string, b: string) => a.endsWith(sep) ? a + b : a + sep + b;
    const walk = async (cur: string, rel: string): Promise<void> => {
      if (out.length >= cap) { truncated = true; return; }
      let entries: any[];
      try {
        if (mode === 'local') entries = await bridge.handleLocalListDir(cur);
        else entries = await bridge.handleSFTPListDir(termId!, cur);
      } catch { return; }
      // 정렬 — 폴더 먼저, 이름순
      entries.sort((a, b) => (a.isDir !== b.isDir) ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
      for (const e of entries) {
        if (e.name === '.' || e.name === '..') continue;
        if (out.length >= cap) { truncated = true; return; }
        const childRel = rel ? rel + '/' + e.name : e.name;
        if (!e.isDir && ignoreBinaryFiles && isBinaryComparePath(childRel)) continue;
        out.push({ relPath: childRel, isDir: e.isDir, size: e.size ?? 0, mtime: e.mtime ?? 0 });
        if (e.isDir) await walk(join(cur, e.name), childRel);
      }
    };
    await walk(basePath, '');
    return { entries: out, truncated };
  } catch (err: any) {
    return { entries: out, truncated, error: String(err) };
  }
});

type CompareRow = {
  relPath: string;
  isDir: boolean;
  status: 'same' | 'changed' | 'left-only' | 'right-only';
  leftSize?: number;
  rightSize?: number;
};
type CompareNode = { name: string; relPath: string; isDir: boolean; size: number; mtime: number };
const stoppedCompareRequests: Set<string> = new Set();
function markCompareStopped(requestId: string) {
  if (!requestId) return;
  stoppedCompareRequests.add(requestId);
  setTimeout(() => stoppedCompareRequests.delete(requestId), 60_000);
}
function isCompareStopped(requestId?: string): boolean {
  return !!requestId && stoppedCompareRequests.has(requestId);
}

ipcMain.handle('compare:dir-compare', async (_e, {
  leftMode, leftTermId, leftBasePath,
  rightMode, rightTermId, rightBasePath,
  maxEntries, ignoreBinaryFiles, skipOrphanDirectories, requestId,
}: {
  leftMode: string; leftTermId?: string; leftBasePath: string;
  rightMode: string; rightTermId?: string; rightBasePath: string;
  maxEntries?: number; ignoreBinaryFiles?: boolean; skipOrphanDirectories?: boolean; requestId?: string;
  }) => {
  const cap = Math.min(maxEntries || COMPARE_WALK_MAX_ENTRIES, COMPARE_WALK_MAX_ENTRIES);
  const out: CompareRow[] = [];
  let truncated = false;
  try {
    const bridge = getSSHBridge();
    const sep = (mode: string) => mode === 'local' && process.platform === 'win32' ? '\\' : '/';
    const join = (a: string, b: string, mode: string) => a.endsWith(sep(mode)) ? a + b : a + sep(mode) + b;

    const listDir = async (mode: string, termId: string | undefined, dirPath: string): Promise<CompareNode[]> => {
      let entries: any[];
      try {
        entries = mode === 'local' ? await bridge.handleLocalListDir(dirPath) : await bridge.handleSFTPListDir(termId!, dirPath);
      } catch {
        return [];
      }
      entries.sort((a, b) => (a.isDir !== b.isDir) ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
      return entries
        .filter(e => e.name !== '.' && e.name !== '..')
        .map(e => ({
          name: e.name,
          relPath: '',
          isDir: !!e.isDir,
          size: e.size ?? 0,
          mtime: e.mtime ?? 0,
        }));
    };

    const emit = (entry: CompareRow) => {
      if (isCompareStopped(requestId)) return false;
      if (out.length >= cap) {
        truncated = true;
        return false;
      }
      out.push(entry);
      return true;
    };

    const emitOrphanTree = async (
      mode: string,
      termId: string | undefined,
      dirPath: string,
      rel: string,
      side: 'left' | 'right',
    ): Promise<void> => {
      if (truncated || isCompareStopped(requestId)) return;
      const entries = await listDir(mode, termId, dirPath);
      for (const entry of entries) {
        if (truncated || isCompareStopped(requestId)) return;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDir) {
          if (!emit({ relPath: childRel, isDir: true, status: side === 'left' ? 'left-only' : 'right-only' })) return;
          if (!skipOrphanDirectories) {
            await emitOrphanTree(mode, termId, join(dirPath, entry.name, mode), childRel, side);
          }
        } else {
          if (ignoreBinaryFiles && isBinaryComparePath(childRel)) continue;
          if (!emit({
            relPath: childRel,
            isDir: false,
            status: side === 'left' ? 'left-only' : 'right-only',
            ...(side === 'left' ? { leftSize: entry.size } : { rightSize: entry.size }),
          })) return;
        }
      }
    };

    const compareDir = async (
      leftDir: string,
      rightDir: string,
      rel: string,
    ): Promise<void> => {
      if (truncated || isCompareStopped(requestId)) return;
      const [leftEntries, rightEntries] = await Promise.all([
        listDir(leftMode, leftTermId, leftDir),
        listDir(rightMode, rightTermId, rightDir),
      ]);
      if (truncated || isCompareStopped(requestId)) return;

      const leftMap = new Map(leftEntries.map(e => [e.name, e]));
      const rightMap = new Map(rightEntries.map(e => [e.name, e]));
      const names = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort((a, b) => {
        const la = leftMap.get(a);
        const ra = rightMap.get(a);
        const aDir = !!la?.isDir || !!ra?.isDir;
        const bDir = !!leftMap.get(b)?.isDir || !!rightMap.get(b)?.isDir;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
      });

      for (const name of names) {
        if (truncated || isCompareStopped(requestId)) return;
        const l = leftMap.get(name);
        const r = rightMap.get(name);
        const childRel = rel ? `${rel}/${name}` : name;
        if (l && r) {
          if (l.isDir && r.isDir) {
            if (!emit({ relPath: childRel, isDir: true, status: 'same' })) return;
            await compareDir(join(leftDir, name, leftMode), join(rightDir, name, rightMode), childRel);
          } else if (l.isDir !== r.isDir) {
            if (ignoreBinaryFiles && ((!l.isDir && isBinaryComparePath(childRel)) || (!r.isDir && isBinaryComparePath(childRel)))) continue;
            if (!emit({ relPath: childRel, isDir: false, status: 'changed', leftSize: l.size, rightSize: r.size })) return;
          } else {
            if (ignoreBinaryFiles && isBinaryComparePath(childRel)) continue;
            const same = l.size === r.size;
            if (!emit({ relPath: childRel, isDir: false, status: same ? 'same' : 'changed', leftSize: l.size, rightSize: r.size })) return;
          }
        } else if (l) {
          if (ignoreBinaryFiles && !l.isDir && isBinaryComparePath(childRel)) continue;
          if (!emit({ relPath: childRel, isDir: l.isDir, status: 'left-only', leftSize: l.size })) return;
          if (l.isDir && !skipOrphanDirectories) {
            await emitOrphanTree(leftMode, leftTermId, join(leftDir, name, leftMode), childRel, 'left');
          }
        } else if (r) {
          if (ignoreBinaryFiles && !r.isDir && isBinaryComparePath(childRel)) continue;
          if (!emit({ relPath: childRel, isDir: r.isDir, status: 'right-only', rightSize: r.size })) return;
          if (r.isDir && !skipOrphanDirectories) {
            await emitOrphanTree(rightMode, rightTermId, join(rightDir, name, rightMode), childRel, 'right');
          }
        }
      }
    };

    await compareDir(leftBasePath, rightBasePath, '');
    return { entries: out, truncated, stopped: isCompareStopped(requestId) };
  } catch (err: any) {
    if (isCompareStopped(requestId)) return { entries: out, truncated, stopped: true };
    return { entries: out, truncated, error: String(err) };
  }
});

ipcMain.handle('compare:stop', (_e, { requestId }: { requestId: string }) => {
  markCompareStopped(String(requestId || ''));
  return { success: true };
});

// 파일 쓰기 — Compare 에디터에서 수정 후 저장. 로컬은 fs, 원격은 SFTP.
ipcMain.handle('compare:write', async (_e, { mode, termId, filePath, content }: { mode: string; termId?: string; filePath: string; content: string }) => {
  try {
    if (mode === 'local') {
      await fs.promises.writeFile(filePath, content, 'utf-8');
      return { ok: true };
    } else {
      if (!termId) return { ok: false, error: t('error.noConnectionId') };
      const bridge = getSSHBridge();
      await bridge.handleSFTPWriteFile(termId, filePath, content);
      return { ok: true };
    }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// 파일 읽기 — 텍스트 diff 용. 로컬은 fs, 원격은 SFTP. 텍스트로 디코드 (utf-8 기본).
// UTF-8 디코딩 후 대체 문자(U+FFFD)가 있으면 CP949(EUC-KR 상위집합)로 재시도
function decodeFileBuffer(buf: Buffer): { text: string; encoding: string } {
  const utf8 = buf.toString('utf-8');
  if (!utf8.includes('�')) return { text: utf8, encoding: 'UTF-8' };
  try {
    const iconv = require('iconv-lite');
    if (iconv.encodingExists('cp949')) return { text: iconv.decode(buf, 'cp949'), encoding: 'CP949' };
  } catch {}
  return { text: utf8, encoding: 'UTF-8' };
}
// EOL/BOM 정규화 + whitespace 옵션 적용 후 SHA1 해시 — "size 가 달라도 내용은 동일" 검증용
ipcMain.handle('compare:hash', async (_e, { mode, termId, filePath, maxBytes, wsMode }: { mode: string; termId?: string; filePath: string; maxBytes?: number; wsMode?: string }) => {
  const cap = maxBytes || 256 * 1024;
  const applyWs = (s: string): string => {
    if (!wsMode || wsMode === 'significant') return s;
    const lines = s.split('\n');
    const proc = lines.map(ln => {
      if (wsMode === 'ignoreLeading') return ln.replace(/^\s+/, '');
      if (wsMode === 'ignoreTrailing') return ln.replace(/\s+$/, '');
      if (wsMode === 'ignoreConsecutive') return ln.replace(/[ \t]+/g, ' ');
      if (wsMode === 'ignoreAll') return ln.replace(/[ \t]/g, '');
      return ln;
    });
    return proc.join('\n');
  };
  try {
    let buf: Buffer;
    if (mode === 'local') {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > cap) return { skipped: true, size: stat.size };
      buf = await fs.promises.readFile(filePath);
    } else {
      if (!termId) return { error: t('error.noConnectionId') };
      const bridge = getSSHBridge();
      buf = await bridge.handleSFTPReadFile(termId, filePath);
      if (buf.length > cap) return { skipped: true, size: buf.length };
    }
    // BOM 제거 + CRLF/CR → LF 통일 (텍스트 한정 — 바이너리도 동일 정규화하지만 차이 없으면 same 으로 인식하는 것이 정상)
    let s = buf.toString('utf-8');
    if (s.includes('�')) {
      // utf-8 디코딩 실패 시 raw bytes 로 정규화 (CR/LF 만 처리)
      const bytes = Array.from(buf);
      const out: number[] = [];
      // BOM (EF BB BF) skip
      let start = (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) ? 3 : 0;
      for (let i = start; i < bytes.length; i++) {
        if (bytes[i] === 0x0D) { // CR
          out.push(0x0A);
          if (bytes[i + 1] === 0x0A) i++;
        } else {
          out.push(bytes[i]);
        }
      }
      const norm = Buffer.from(out);
      const sha = require('crypto').createHash('sha1').update(norm).digest('hex');
      return { hash: sha, size: buf.length };
    }
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    s = applyWs(s);
    const sha = require('crypto').createHash('sha1').update(s, 'utf-8').digest('hex');
    return { hash: sha, size: buf.length };
  } catch (err: any) {
    return { error: String(err?.message || err) };
  }
});

// ── Log Watch (실시간 tail) ──
type LogWatcher = { cleanup: () => void };
const logWatchers: Map<string, LogWatcher> = new Map();
ipcMain.handle('log:watch-start', async (_e, { watchId, mode, termId, filePath }: { watchId: string; mode: string; termId?: string; filePath: string }) => {
  // 기존 watcher 정리
  const prev = logWatchers.get(watchId);
  if (prev) { try { prev.cleanup(); } catch {} logWatchers.delete(watchId); }
  const send = (text: string) => {
    try { mainWindow?.webContents.send('log:watch-data', { watchId, text }); } catch {}
  };
  const sendErr = (error: string) => {
    try { mainWindow?.webContents.send('log:watch-error', { watchId, error }); } catch {}
  };
  try {
    if (mode === 'local') {
      let offset = 0;
      try { const st = await fs.promises.stat(filePath); offset = st.size; } catch (e: any) { return { success: false, error: String(e?.message || e) }; }
      let busy = false;
      const pump = async () => {
        if (busy) return;
        busy = true;
        try {
          const st = await fs.promises.stat(filePath);
          if (st.size < offset) {
            // 파일이 잘렸음 (logrotate 등) → 처음부터 다시
            offset = 0;
          }
          if (st.size > offset) {
            const fh = await fs.promises.open(filePath, 'r');
            try {
              const len = st.size - offset;
              const buf = Buffer.alloc(len);
              await fh.read(buf, 0, len, offset);
              offset = st.size;
              send(buf.toString('utf-8'));
            } finally { await fh.close(); }
          }
        } catch (e: any) {
          // 일시적 read 실패는 무시
        }
        busy = false;
      };
      let watcher: fs.FSWatcher | null = null;
      try { watcher = fs.watch(filePath, { persistent: false }, () => { pump(); }); }
      catch (e: any) { return { success: false, error: 'fs.watch 실패: ' + (e?.message || e) }; }
      // 안전망: 500ms polling (fs.watch 가 일부 환경/네트워크 드라이브에서 미동작)
      const poll = setInterval(pump, 500);
      logWatchers.set(watchId, { cleanup: () => { try { watcher?.close(); } catch {} clearInterval(poll); } });
      return { success: true, initialSize: offset };
    } else {
      if (!termId) return { success: false, error: 'no termId' };
      const bridge = getSSHBridge();
      const conn = (bridge as any).clients?.get(termId)?.conn;
      if (!conn) return { success: false, error: 'SSH not connected' };
      // tail -n 0 -F : 기존 데이터 출력 안 함, 새 append 라인만.
      // 원격 사용자 셸이 csh/tcsh 인 경우가 많아 POSIX 호환 구문을 못 씀 → /bin/sh -c 로 강제 래핑.
      // stdbuf/unbuffer 가 없는 시스템 대비 폴백 체인.
      const safePath = filePath.replace(/'/g, `'\\''`);
      const inner = `(command -v stdbuf >/dev/null 2>&1 && exec stdbuf -oL -eL tail -n 0 -F '${safePath}') || (command -v unbuffer >/dev/null 2>&1 && exec unbuffer -p tail -n 0 -F '${safePath}') || exec tail -n 0 -F '${safePath}'`;
      // /bin/sh -c "<inner>"  → inner 안의 작은따옴표는 위에서 '\\'' 로 이미 이스케이프. 외부에서 "..." 로 감싸면 sh -c 가 받음.
      const cmd = `/bin/sh -c "${inner.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        conn.exec(cmd, { pty: true }, (err: any, stream: any) => {
          if (err) {
            // pty 옵션 실패 시 일반 exec 재시도
            conn.exec(cmd, (err2: any, stream2: any) => {
              if (err2) { resolve({ success: false, error: String(err2?.message || err2) }); return; }
              stream2.on('data', (d: Buffer) => send(d.toString('utf-8')));
              stream2.stderr?.on('data', (d: Buffer) => sendErr(d.toString('utf-8')));
              stream2.on('close', () => { try { mainWindow?.webContents.send('log:watch-closed', { watchId }); } catch {} });
              logWatchers.set(watchId, { cleanup: () => { try { stream2.close(); } catch {} } });
              resolve({ success: true });
            });
            return;
          }
          stream.on('data', (d: Buffer) => send(d.toString('utf-8')));
          stream.stderr?.on('data', (d: Buffer) => sendErr(d.toString('utf-8')));
          stream.on('close', () => { try { mainWindow?.webContents.send('log:watch-closed', { watchId }); } catch {} });
          logWatchers.set(watchId, { cleanup: () => { try { stream.close(); } catch {} } });
          resolve({ success: true });
        });
      });
    }
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('log:watch-stop', (_e, { watchId }: { watchId: string }) => {
  const w = logWatchers.get(watchId);
  if (w) { try { w.cleanup(); } catch {} logWatchers.delete(watchId); }
  return { success: true };
});

// 양쪽 파일의 라인 diff 수 카운트 — ChangeFolder 컬럼용. 양쪽 ≤ maxBytes 일 때만 정확. LCS 기반.
ipcMain.handle('compare:diff-count', async (_e, {
  leftMode, leftTermId, leftPath, rightMode, rightTermId, rightPath, maxBytes, wsMode,
}: { leftMode: string; leftTermId?: string; leftPath: string; rightMode: string; rightTermId?: string; rightPath: string; maxBytes?: number; wsMode?: string }) => {
  const cap = maxBytes || 256 * 1024;
  const applyWs = (s: string): string => {
    if (!wsMode || wsMode === 'significant') return s;
    return s.split('\n').map(ln => {
      if (wsMode === 'ignoreLeading') return ln.replace(/^\s+/, '');
      if (wsMode === 'ignoreTrailing') return ln.replace(/\s+$/, '');
      if (wsMode === 'ignoreConsecutive') return ln.replace(/[ \t]+/g, ' ');
      if (wsMode === 'ignoreAll') return ln.replace(/[ \t]/g, '');
      return ln;
    }).join('\n');
  };
  const readNorm = async (mode: string, termId: string | undefined, fp: string): Promise<string[] | null> => {
    let buf: Buffer;
    if (mode === 'local') {
      const stat = await fs.promises.stat(fp);
      if (stat.size > cap) return null;
      buf = await fs.promises.readFile(fp);
    } else {
      if (!termId) return null;
      const bridge = getSSHBridge();
      buf = await bridge.handleSFTPReadFile(termId, fp);
      if (buf.length > cap) return null;
    }
    let s = buf.toString('utf-8');
    if (s.includes('�')) {
      const iconv = require('iconv-lite');
      if (iconv.encodingExists('cp949')) s = iconv.decode(buf, 'cp949');
    }
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    s = applyWs(s);
    return s.split('\n');
  };
  try {
    const [L, R] = await Promise.all([readNorm(leftMode, leftTermId, leftPath), readNorm(rightMode, rightTermId, rightPath)]);
    if (!L || !R) return { skipped: true };
    // LCS 길이 계산 (Hirschberg 없이 O(n*m), 두 파일 ≤ 256KB 라인 가정)
    const n = L.length, m = R.length;
    // 너무 큰 라인 수는 거부 (메모리 폭발 방지) — 약 8000 라인 ^ 2 = 64M cell. 너무 크면 skip.
    if (n * m > 4_000_000) return { skipped: true, reason: 'too-many-lines' };
    // 1행만 보유하는 LCS DP
    const prev = new Uint32Array(m + 1);
    const cur = new Uint32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      const li = L[i - 1];
      for (let j = 1; j <= m; j++) {
        cur[j] = li === R[j - 1]
          ? prev[j - 1] + 1
          : Math.max(prev[j], cur[j - 1]);
      }
      prev.set(cur);
    }
    const lcs = prev[m];
    // 변경 라인 수 = 양쪽 unique 라인 합. 일반적으로 (n - lcs) + (m - lcs).
    const changes = (n - lcs) + (m - lcs);
    return { changes, leftLines: n, rightLines: m };
  } catch (err: any) {
    return { error: String(err?.message || err) };
  }
});

ipcMain.handle('compare:read', async (_e, { mode, termId, filePath, maxBytes }: { mode: string; termId?: string; filePath: string; maxBytes?: number }) => {
  const cap = maxBytes || 100 * 1024 * 1024; // 기본 100MB
  try {
    if (mode === 'local') {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > cap) return { error: t('error.fileTooLargeCap', { mb: (stat.size / 1024 / 1024).toFixed(1), cap: (cap / 1024 / 1024).toFixed(0) }), size: stat.size };
      const buf = await fs.promises.readFile(filePath);
      const { text, encoding } = decodeFileBuffer(buf);
      return { content: text, encoding, size: stat.size };
    } else {
      if (!termId) return { error: t('error.noConnectionId') };
      const bridge = getSSHBridge();
      const buf = await bridge.handleSFTPReadFile(termId, filePath);
      if (buf.length > cap) return { error: t('error.fileTooLarge', { mb: (buf.length / 1024 / 1024).toFixed(1) }), size: buf.length };
      const { text, encoding } = decodeFileBuffer(buf);
      return { content: text, encoding, size: buf.length };
    }
  } catch (err: any) {
    return { error: String(err?.message || err) };
  }
});

// 파일/폴더의 Windows shell 아이콘을 data URL 로 반환 — FilePanel 에서 lazy 로딩
const fileIconCache = new Map<string, string>(); // path → dataUrl
// 확장자 → 아이콘 (SFTP/SSH 원격 파일용 — 로컬에 파일 없어도 확장자만으로 Windows 아이콘 추출)
const extIconCache = new Map<string, string>(); // ext → dataUrl
ipcMain.handle('fe:get-icons-by-ext', async (_e, { exts, isDir }: { exts: string[]; isDir?: boolean }) => {
  if (!Array.isArray(exts) || exts.length === 0) return { icons: {} };
  if (process.platform !== 'win32') return { icons: {} };
  const result: Record<string, string> = {};
  const remaining: string[] = [];
  const keyOf = (e: string) => `${isDir ? 'dir' : 'file'}:${e || ''}`;
  for (const e of exts) {
    const k = keyOf(e);
    if (extIconCache.has(k)) result[e] = extIconCache.get(k) || '';
    else remaining.push(e);
  }
  if (remaining.length === 0) return { icons: result };
  try {
    const { execFile } = require('child_process');
    // 확장자별로 가짜 경로 ".${ext}" 만들어 SHGFI_USEFILEATTRIBUTES 로 확장자 아이콘 조회
    const fakeList = remaining.map(e => isDir ? 'dummyfolder' : `dummy.${e}`).join('\n');
    const tmpList = path.join(os.tmpdir(), `pepe-ext-icon-list-${Date.now()}.txt`);
    fs.writeFileSync(tmpList, fakeList, { encoding: 'utf8' });
    const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IconHelper2 {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  public struct SHFILEINFO {
    public IntPtr hIcon;
    public int iIcon;
    public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Auto)]
  public static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool DestroyIcon(IntPtr hIcon);
}
"@ -ErrorAction SilentlyContinue
$SHGFI_ICON = 0x100
$SHGFI_SMALLICON = 0x1
$SHGFI_USEFILEATTRIBUTES = 0x10
$FILE_ATTRIBUTE_NORMAL = 0x80
$FILE_ATTRIBUTE_DIRECTORY = 0x10
$attr = ${isDir ? '$FILE_ATTRIBUTE_DIRECTORY' : '$FILE_ATTRIBUTE_NORMAL'}
$paths = Get-Content -LiteralPath '${tmpList.replace(/'/g, "''")}' -Encoding UTF8
$results = @{}
foreach ($p in $paths) {
  if (-not $p) { continue }
  try {
    $shfi = New-Object IconHelper2+SHFILEINFO
    $sz = [System.Runtime.InteropServices.Marshal]::SizeOf($shfi)
    [IconHelper2]::SHGetFileInfo($p, $attr, [ref]$shfi, $sz, $SHGFI_ICON -bor $SHGFI_SMALLICON -bor $SHGFI_USEFILEATTRIBUTES) | Out-Null
    if ($shfi.hIcon -ne [IntPtr]::Zero) {
      $icon = [System.Drawing.Icon]::FromHandle($shfi.hIcon)
      $bmp = $icon.ToBitmap()
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $results[$p] = [Convert]::ToBase64String($ms.ToArray())
      $ms.Dispose(); $bmp.Dispose(); $icon.Dispose()
      [IconHelper2]::DestroyIcon($shfi.hIcon) | Out-Null
    } else { $results[$p] = '' }
  } catch { $results[$p] = '' }
}
$results | ConvertTo-Json -Compress`;
    const tmpPs = path.join(os.tmpdir(), `pepe-ext-icons-${Date.now()}.ps1`);
    try {
      fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
      const out: string = await new Promise<string>((resolve, reject) => {
        execFile('powershell', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
        ], { windowsHide: true, timeout: 30000, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
        (err: any, stdout: string) => {
          if (err) reject(err);
          else resolve((stdout || '').trim());
        });
      });
      try { fs.unlinkSync(tmpPs); } catch {}
      try { fs.unlinkSync(tmpList); } catch {}
      if (out) {
        const parsed = JSON.parse(out);
        for (const e of remaining) {
          const fake = isDir ? 'dummyfolder' : `dummy.${e}`;
          const b64 = parsed[fake];
          if (b64 && typeof b64 === 'string' && b64.length > 50) {
            const dataUrl = `data:image/png;base64,${b64}`;
            result[e] = dataUrl;
            extIconCache.set(keyOf(e), dataUrl);
          } else {
            result[e] = '';
          }
        }
      }
    } catch {
      try { fs.unlinkSync(tmpPs); } catch {}
      try { fs.unlinkSync(tmpList); } catch {}
    }
  } catch {}
  return { icons: result };
});

// 배치 아이콘 추출 — 한 번의 PowerShell 호출로 여러 파일 처리 (개별 호출 시 process spawn 오버헤드 + 일부 실패 회피)
ipcMain.handle('fe:get-file-icons-batch', async (_e, { filePaths }: { filePaths: string[] }) => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return { icons: {} };
  if (process.platform !== 'win32') return { icons: {} };
  const result: Record<string, string> = {};
  // 캐시 hit 먼저 처리
  const remaining: string[] = [];
  for (const fp of filePaths) {
    const key = `${fp}|small`;
    if (fileIconCache.has(key)) {
      result[fp] = fileIconCache.get(key) || '';
    } else if (fs.existsSync(fp)) {
      remaining.push(fp);
    } else {
      result[fp] = '';
    }
  }
  if (remaining.length === 0) return { icons: result };
  try {
    const { execFile } = require('child_process');
    // 임시 파일에 경로 리스트 작성 (UTF-8) → PowerShell 이 읽어 한 번에 처리
    const tmpList = path.join(os.tmpdir(), `pepe-icon-list-${Date.now()}.txt`);
    fs.writeFileSync(tmpList, remaining.join('\n'), { encoding: 'utf8' });
    const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
# Windows Explorer 와 동일한 SHGetFileInfo API 로 아이콘 추출 — 폴더 custom icon (desktop.ini),
# .lnk target icon, 파일 확장자 아이콘 등 모두 정확히 처리
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IconHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  public struct SHFILEINFO {
    public IntPtr hIcon;
    public int iIcon;
    public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Auto)]
  public static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool DestroyIcon(IntPtr hIcon);
}
"@ -ErrorAction SilentlyContinue
$SHGFI_ICON = 0x100
$SHGFI_SMALLICON = 0x1
$paths = Get-Content -LiteralPath '${tmpList.replace(/'/g, "''")}' -Encoding UTF8
$results = @{}
foreach ($p in $paths) {
  if (-not $p) { continue }
  try {
    $shfi = New-Object IconHelper+SHFILEINFO
    $sz = [System.Runtime.InteropServices.Marshal]::SizeOf($shfi)
    $r = [IconHelper]::SHGetFileInfo($p, 0, [ref]$shfi, $sz, $SHGFI_ICON -bor $SHGFI_SMALLICON)
    if ($shfi.hIcon -ne [IntPtr]::Zero) {
      $icon = [System.Drawing.Icon]::FromHandle($shfi.hIcon)
      $bmp = $icon.ToBitmap()
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $results[$p] = [Convert]::ToBase64String($ms.ToArray())
      $ms.Dispose(); $bmp.Dispose(); $icon.Dispose()
      [IconHelper]::DestroyIcon($shfi.hIcon) | Out-Null
    } else {
      # SHGetFileInfo 실패 시 ExtractAssociatedIcon 으로 폴백
      try {
        $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
        if ($icon) {
          $bmp = $icon.ToBitmap()
          $ms = New-Object System.IO.MemoryStream
          $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
          $results[$p] = [Convert]::ToBase64String($ms.ToArray())
          $ms.Dispose(); $bmp.Dispose(); $icon.Dispose()
        } else { $results[$p] = '' }
      } catch { $results[$p] = '' }
    }
  } catch {
    $results[$p] = ''
  }
}
$results | ConvertTo-Json -Compress`;
    const tmpPs = path.join(os.tmpdir(), `pepe-icons-batch-${Date.now()}.ps1`);
    try {
      fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
      // async execFile — main process 블록 안 함 → 렌더러의 windowFocus 요청 등이 즉시 처리됨
      const out: string = await new Promise<string>((resolve, reject) => {
        execFile('powershell', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
        ], { windowsHide: true, timeout: 30000, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
        (err: any, stdout: string) => {
          if (err) reject(err);
          else resolve((stdout || '').trim());
        });
      });
      try { fs.unlinkSync(tmpPs); } catch {}
      try { fs.unlinkSync(tmpList); } catch {}
      if (out) {
        const parsed = JSON.parse(out);
        for (const fp of remaining) {
          const b64 = parsed[fp];
          if (b64 && typeof b64 === 'string' && b64.length > 50) {
            const dataUrl = `data:image/png;base64,${b64}`;
            result[fp] = dataUrl;
            if (fileIconCache.size > 500) {
              const firstKey = fileIconCache.keys().next().value;
              if (firstKey) fileIconCache.delete(firstKey);
            }
            fileIconCache.set(`${fp}|small`, dataUrl);
          } else {
            result[fp] = '';
          }
        }
      }
    } catch (err) {
      try { fs.unlinkSync(tmpPs); } catch {}
      try { fs.unlinkSync(tmpList); } catch {}
    }
  } catch {}
  return { icons: result };
});

ipcMain.handle('fe:get-file-icon', async (_e, { filePath, size }: { filePath: string; size?: 'small' | 'normal' | 'large' }) => {
  if (!filePath || typeof filePath !== 'string') return { dataUrl: '' };
  const cacheKey = `${filePath}|${size || 'small'}`;
  if (fileIconCache.has(cacheKey)) return { dataUrl: fileIconCache.get(cacheKey) };
  // shell:* / shell-pidl:* / ::CLSID 가상 항목 — Shell.Application ParseName 체인 + SHGetFileInfo(SHGFI_PIDL) 로 네이티브 아이콘 추출
  const isVirtual = /^(shell:|shell-pidl:|::\{)/i.test(filePath);
  if (isVirtual && process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      // shell-pidl:<root>||a||b 형식 분해
      let rootPath: string;
      let chain: string[] = [];
      if (filePath.startsWith('shell-pidl:')) {
        const body = filePath.slice('shell-pidl:'.length);
        const segs = body.split('||');
        rootPath = segs[0];
        chain = segs.slice(1);
      } else {
        rootPath = filePath;
      }
      const psChain = chain.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
      const rootArg = rootPath === 'shell:Desktop' ? '0' : `'${rootPath.replace(/'/g, "''")}'`;
      const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class ShellIcon {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  public static extern int SHParseDisplayName(string pszName, IntPtr pbc, out IntPtr ppidl, uint sfgaoIn, out uint psfgaoOut);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SHGetFileInfo(IntPtr pidl, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr hIcon);
  [DllImport("ole32.dll")]
  public static extern void CoTaskMemFree(IntPtr ptr);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct SHFILEINFO {
    public IntPtr hIcon;
    public int iIcon;
    public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string szTypeName;
  }
}
"@
# 1) ParseName chain 으로 최종 FolderItem 의 Path 를 얻는다 (체인 없으면 root 자체)
$shell = New-Object -ComObject Shell.Application
$resolved = ''
$ns = $shell.NameSpace(${rootArg})
if ($ns) {
  $chainNames = @(${psChain})
  if ($chainNames.Count -eq 0) {
    # root 자체 — Self.Path
    try { $resolved = $ns.Self.Path } catch {}
  } else {
    $folder = $ns
    $finalItem = $null
    foreach ($name in $chainNames) {
      if (-not $folder) { break }
      $child = $folder.ParseName($name)
      if (-not $child) {
        foreach ($c in $folder.Items()) { if ($c.Name -eq $name) { $child = $c; break } }
      }
      if (-not $child) { break }
      $finalItem = $child
      $sub = $null
      try { $sub = $child.GetFolder } catch {}
      if (-not $sub -and $child.Path) {
        try { $sub = $shell.NameSpace($child.Path) } catch { $sub = $null }
      }
      $folder = $sub
    }
    if ($finalItem) { try { $resolved = $finalItem.Path } catch {} }
  }
}
if (-not $resolved) { $resolved = '${rootPath.replace(/'/g, "''")}' }
# 2) resolved Path 로 SHParseDisplayName → SHGetFileInfo
$pidl = [IntPtr]::Zero
$attr = [uint32]0
$hr = [ShellIcon]::SHParseDisplayName($resolved, [IntPtr]::Zero, [ref]$pidl, 0, [ref]$attr)
if ($hr -eq 0 -and $pidl -ne [IntPtr]::Zero) {
  $info = New-Object ShellIcon+SHFILEINFO
  $sz = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  $flags = 0x100 -bor 0x008  # SHGFI_ICON | SHGFI_PIDL
  [void][ShellIcon]::SHGetFileInfo($pidl, 0, [ref]$info, $sz, $flags)
  if ($info.hIcon -ne [IntPtr]::Zero) {
    try {
      $icon = [System.Drawing.Icon]::FromHandle($info.hIcon)
      $bmp = $icon.ToBitmap()
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output ([Convert]::ToBase64String($ms.ToArray()))
      $ms.Dispose()
      $bmp.Dispose()
      $icon.Dispose()
    } catch {}
    [void][ShellIcon]::DestroyIcon($info.hIcon)
  }
  [ShellIcon]::CoTaskMemFree($pidl)
}`;
      const tmpPs = path.join(os.tmpdir(), `pepe-shellicon-${Date.now()}.ps1`);
      try {
        fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
        const out: string = execFileSync('powershell', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
        ], { windowsHide: true, timeout: 7000 }).toString('utf-8').trim();
        try { fs.unlinkSync(tmpPs); } catch {}
        if (out && out.length > 50) {
          const dataUrl = `data:image/png;base64,${out}`;
          if (fileIconCache.size > 500) {
            const firstKey = fileIconCache.keys().next().value;
            if (firstKey) fileIconCache.delete(firstKey);
          }
          fileIconCache.set(cacheKey, dataUrl);
          return { dataUrl };
        }
      } catch {
        try { fs.unlinkSync(tmpPs); } catch {}
      }
    } catch {}
    return { dataUrl: '' };
  }
  try {
    if (!fs.existsSync(filePath)) return { dataUrl: '' };
    let dataUrl = '';
    // 1차: PowerShell System.Drawing.Icon.ExtractAssociatedIcon — .lnk 의 실제 target 아이콘까지
    //   처리. Win32 SHGetFileInfo 와 동일 결과로, 거의 모든 케이스에서 동작.
    if (process.platform === 'win32') {
      try {
        const { execFileSync } = require('child_process');
        const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
try {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon('${filePath.replace(/'/g, "''")}')
  if ($icon) {
    $bmp = $icon.ToBitmap()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ([Convert]::ToBase64String($ms.ToArray()))
    $ms.Dispose()
    $bmp.Dispose()
    $icon.Dispose()
  }
} catch {}`;
        const tmpPs = path.join(os.tmpdir(), `pepe-icon-${Date.now()}.ps1`);
        try {
          fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
          const out: string = execFileSync('powershell', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
          ], { windowsHide: true, timeout: 5000 }).toString('utf-8').trim();
          try { fs.unlinkSync(tmpPs); } catch {}
          if (out && out.length > 50) dataUrl = `data:image/png;base64,${out}`;
        } catch {
          try { fs.unlinkSync(tmpPs); } catch {}
        }
      } catch {}
    }
    // 2차 fallback: Electron app.getFileIcon (cross-platform)
    if (!dataUrl) {
      try {
        const img = await app.getFileIcon(filePath, { size: (size || 'small') as any });
        if (img && !img.isEmpty()) dataUrl = img.toDataURL();
      } catch {}
    }
    if (!dataUrl) return { dataUrl: '' };
    if (fileIconCache.size > 500) {
      const firstKey = fileIconCache.keys().next().value;
      if (firstKey) fileIconCache.delete(firstKey);
    }
    fileIconCache.set(cacheKey, dataUrl);
    return { dataUrl };
  } catch {
    return { dataUrl: '' };
  }
});

ipcMain.handle('fe:get-drives', async () => {
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      // PowerShell 스크립트 — 임시 파일로 저장 후 실행 (UTF-8 인코딩 안정성 + NetHood 항목 UNC 해석)
      const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$wsh = New-Object -ComObject WScript.Shell

function Resolve-NetHoodPath {
  param([string]$p)
  # NetHood 의 단축아이콘 폴더면 target.lnk 또는 내부 .lnk 의 UNC 타깃 반환
  if (-not $p) { return $p }
  if ($p.StartsWith('\\')) { return $p }
  if (-not (Test-Path $p)) { return $p }
  $tlnk = Join-Path $p 'target.lnk'
  if (Test-Path $tlnk) {
    try {
      $lk = $wsh.CreateShortcut($tlnk)
      if ($lk.TargetPath -and $lk.TargetPath.StartsWith('\\')) { return $lk.TargetPath }
    } catch {}
  }
  # *.lnk 파일 직접 검색
  try {
    $lnks = Get-ChildItem -Path $p -Filter '*.lnk' -File -ErrorAction SilentlyContinue
    foreach ($f in $lnks) {
      try {
        $lk = $wsh.CreateShortcut($f.FullName)
        if ($lk.TargetPath -and $lk.TargetPath.StartsWith('\\')) { return $lk.TargetPath }
      } catch {}
    }
  } catch {}
  return $p
}

function Get-DriveIcon {
  param([string]$path, [int]$driveType)
  if ($path -match '^[A-Z]:') {
    # DriveType: 2=Removable, 3=Local, 4=Network, 5=CDROM
    switch ($driveType) {
      2 { return '🔌' }
      3 { return '💾' }
      4 { return '🌐' }
      5 { return '💿' }
      default { return '💾' }
    }
  }
  if ($path.StartsWith('\\')) { return '🌐' }
  return '📁'
}

# Win32_LogicalDisk 로 DriveType 정보 미리 수집 (드라이브 letter → type 매핑)
$driveTypes = @{}
try {
  Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
    $driveTypes[$_.DeviceID.ToUpper()] = [int]$_.DriveType
  }
} catch {}

$items = @()
# 트리 구조:
# 바탕 화면 (depth 0, 가상 데스크톱 = shell:Desktop)
#   내 PC (depth 1)
#     드라이브 / MTP / 네트워크 (depth 2)
#   다운로드, 문서, 사진, 동영상, 음악, 홈 (depth 1, 내 PC 아래에 위치)
# 바탕 화면 (depth 0) — 가상 데스크톱으로 navigate (안에 내 PC / 갤러리 / 라이브러리 등)
$items += [PSCustomObject]@{
  Path = 'shell:Desktop'
  Label = '🖼 바탕 화면'
  Depth = 0
  Order = 0
}
# 내 PC (depth 1, 첫 번째)
$items += [PSCustomObject]@{
  Path = 'shell:MyComputerFolder'
  Label = '💻 내 PC'
  Depth = 1
  Order = 100
}
# 내 PC 자식 (depth 2) — 드라이브 / MTP / 네트워크
$childIdx = 0
try {
  $pc = $shell.Namespace(0x11)
  if ($pc) {
    foreach ($it in $pc.Items()) {
      $p = $it.Path
      $n = $it.Name
      if (-not $p -or -not $n) { continue }
      $resolved = Resolve-NetHoodPath $p
      $icon = '📁'
      if ($resolved -match '^([A-Z]:)') {
        $dev = $Matches[1].ToUpper()
        $dt = if ($driveTypes.ContainsKey($dev)) { $driveTypes[$dev] } else { 3 }
        $icon = Get-DriveIcon -path $resolved -driveType $dt
      } elseif ($resolved.StartsWith('\\')) {
        $icon = '🌐'
      } elseif ($p -match 'samsung|android|iphone|ipad|usb|mtp') {
        $icon = '📱'
      } else {
        $icon = '📁'
      }
      $groupOrder = if ($resolved -match '^[A-Z]:') { 0 } elseif ($resolved.StartsWith('::')) { 1 } elseif ($resolved.StartsWith('\\')) { 2 } else { 3 }
      $finalPath = if ($resolved -and $resolved.StartsWith('::')) { 'shell-pidl:' + $resolved } else { $resolved }
      $items += [PSCustomObject]@{
        Path = $finalPath
        Label = "$icon $n"
        Depth = 2
        Order = 100 + 0.01 + $groupOrder * 0.001 + ($childIdx * 0.0001)
      }
      $childIdx++
    }
  }
} catch {}
# 다운로드, 문서, 사진, 동영상, 음악 (depth 1, 내 PC 아래)
$specialFolders = @(
  @{ Name = 'Downloads'; Label = '⬇ 다운로드' },
  @{ Name = 'MyDocuments'; Label = '📄 문서' },
  @{ Name = 'MyPictures'; Label = '🖼 사진' },
  @{ Name = 'MyVideos'; Label = '🎬 동영상' },
  @{ Name = 'MyMusic'; Label = '🎵 음악' }
)
$sfOrder = 200
foreach ($sf in $specialFolders) {
  try {
    $p = $null
    if ($sf.Name -eq 'Downloads') {
      $shellFolder = $shell.Namespace('shell:Downloads')
      if ($shellFolder) { $p = $shellFolder.Self.Path }
    } else {
      $p = [Environment]::GetFolderPath($sf.Name)
    }
    if ($p -and (Test-Path $p)) {
      $items += [PSCustomObject]@{
        Path = $p
        Label = $sf.Label
        Depth = 1
        Order = $sfOrder
      }
      $sfOrder++
    }
  } catch {}
}
# 홈 (depth 1, 마지막)
try {
  $userProfile = [Environment]::GetFolderPath('UserProfile')
  if ($userProfile) {
    $items += [PSCustomObject]@{
      Path = $userProfile
      Label = "🏠 홈 ($([System.IO.Path]::GetFileName($userProfile)))"
      Depth = 1
      Order = $sfOrder
    }
  }
} catch {}
$items | Sort-Object Order | ConvertTo-Json -Compress`;
      // 스크립트를 UTF-8 (BOM 포함) 임시 파일로 — PowerShell 이 한글 안전하게 파싱하도록
      const tmpPs = path.join(os.tmpdir(), `pepe-drives-${Date.now()}.ps1`);
      try {
        fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
        const out: string = execFileSync('powershell', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
        ], { windowsHide: true, timeout: 10000 }).toString('utf-8');
        try { fs.unlinkSync(tmpPs); } catch {}
        const data = JSON.parse(out.trim() || '[]');
        const arr: any[] = Array.isArray(data) ? data : [data];
        return arr.map(x => ({
          path: String(x.Path || ''),
          label: String(x.Label || x.Path || ''),
          depth: Number(x.Depth) || 0,
        })).filter(x => x.path);
      } catch (innerErr) {
        try { fs.unlinkSync(tmpPs); } catch {}
        throw innerErr;
      }
    } catch (err: any) {
      console.error('[fe:get-drives] PS failed:', err?.message || err);
      // PowerShell 실패 시 fallback — drive letter 만
      const letters: { path: string; label: string }[] = [];
      for (let i = 65; i <= 90; i++) {
        const d = String.fromCharCode(i) + ':\\';
        try { await fs.promises.access(d); letters.push({ path: d, label: d }); } catch {}
      }
      return letters;
    }
  }
  return [{ path: '/', label: '/' }];
});

ipcMain.handle('fe:get-home', () => {
  return require('os').homedir();
});

// 파일 전송 — 백그라운드 실행하여 IPC 채널 즉시 해제 (progress 이벤트 실시간 수신 가능)
let _feTransferSeq = 0;
ipcMain.handle('fe:transfer', (_e, { src, dst, filename, workspaceId }: any) => {
  const seq = ++_feTransferSeq;
  const bridge = getSSHBridge();
  bridge.handleTransfer(src, dst, filename, undefined, workspaceId)
    .then(() => mainWindow?.webContents.send('fe:transfer-done', { seq, success: true }))
    .catch((err: any) => mainWindow?.webContents.send('fe:transfer-done', { seq, success: false, error: String(err) }));
  return { seq }; // 즉시 반환 — 완료는 fe:transfer-done 이벤트로 수신
});

ipcMain.handle('fe:resolve-conflict', (_e, { requestId, decision }: any) => {
  const bridge = getSSHBridge();
  bridge.resolveConflict(requestId, decision);
  return { success: true };
});

ipcMain.handle('fe:cancel-transfer', (_e, { transferId }: any) => {
  const bridge = getSSHBridge();
  bridge.cancelTransfer(transferId);
  return { success: true };
});

// 파일 탐색기에서 파일/폴더 위치 보기 (Windows Explorer 에 선택 상태로 열기)
ipcMain.handle('shell:show-item', (_e, { fullPath }: { fullPath: string }) => {
  try { shell.showItemInFolder(fullPath); return { success: true }; }
  catch (err: any) { return { success: false, error: String(err) }; }
});

// 폴더 직접 열기
ipcMain.handle('shell:open-path', async (_e, { dirPath }: { dirPath: string }) => {
  try { const err = await shell.openPath(dirPath); return { success: !err, error: err || undefined }; }
  catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:chmod', async (_e, { mode, termId, paths, octal, recursive }: any) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') {
      const walkAndChmod = async (p: string): Promise<void> => {
        const fs = require('fs');
        try {
          const st = await fs.promises.stat(p);
          await fs.promises.chmod(p, octal);
          if (recursive && st.isDirectory()) {
            const entries = await fs.promises.readdir(p);
            for (const e of entries) await walkAndChmod(require('path').join(p, e));
          }
        } catch (err) { /* 권한 변경 실패한 항목은 무시 — Windows 는 mode 매핑이 제한적 */ }
      };
      for (const p of paths) await walkAndChmod(p);
      return { success: true };
    }
    // 원격 — SSH exec 로 chmod 실행
    const flag = recursive ? '-R ' : '';
    const octStr = octal.toString(8).padStart(3, '0');
    // 경로 쉘 escape (single-quote)
    const quote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    const cmd = `chmod ${flag}${octStr} ${paths.map(quote).join(' ')}`;
    const result = await bridge.handleExec(termId, cmd, 30000);
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr || `exit ${result.exitCode}` };
    }
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err?.message || err) }; }
});

ipcMain.handle('fe:mkdir', async (_e, { mode, termId, dirPath }: any) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') await bridge.handleLocalMkdir(dirPath);
    else await bridge.handleSFTPMkdir(termId, dirPath);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:create-file', async (_e, { mode, termId, filePath }: any) => {
  try {
    if (mode === 'local') {
      const fs = require('fs');
      await fs.promises.writeFile(filePath, '', { flag: 'wx' });
    } else {
      const bridge = getSSHBridge();
      const sftp: any = await bridge.getSftp(termId);
      await new Promise<void>((res, rej) => {
        // 'wx' = exclusive write, 이미 있으면 실패
        sftp.open(filePath, 'wx', (err: any, handle: any) => {
          if (err) return rej(err);
          sftp.close(handle, (e: any) => e ? rej(e) : res());
        });
      });
    }
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err?.message || err) }; }
});

ipcMain.handle('fe:delete', (_e, { mode, termId, filePath, workspaceId }: any) => {
  const deleteId = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bridge = getSSHBridge();
  bridge.handleDeleteWithProgress(deleteId, mode, termId, filePath, workspaceId)
    .then(() => mainWindow?.webContents.send('fe:delete-done', { deleteId, success: true }))
    .catch((err: any) => mainWindow?.webContents.send('fe:delete-done', { deleteId, success: false, error: String(err) }));
  return { deleteId };
});

ipcMain.handle('fe:rename', async (_e, { mode, termId, oldPath, newPath }: any) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') await bridge.handleLocalRename(oldPath, newPath);
    else await bridge.handleSFTPRename(termId, oldPath, newPath);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:home-dir', async (_e, { mode, termId }: { mode: string; termId?: string }) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') return require('os').homedir();
    const home = await bridge.handleSFTPRealPath(termId!, '.');
    // 경로 접근 가능한지 확인
    try { await bridge.handleSFTPListDir(termId!, home); return home; } catch {}
    // 접근 불가하면 / 시도
    try { await bridge.handleSFTPListDir(termId!, '/'); return '/'; } catch {}
    return home;
  } catch { return '/'; }
});

ipcMain.handle('fe:sftp-connect', async (_e, { connId, host, port, username, auth, jumpOpts, jumps }: any) => {
  try {
    const bridge = getSSHBridge();
    await bridge.handleSFTPConnect(connId, host, port || 22, username, auth, jumpOpts, jumps);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:sftp-disconnect', (_e, { connId }: any) => {
  const bridge = getSSHBridge();
  bridge.handleSFTPDisconnect(connId);
});

// 파일트리/Compare 등에서 사용한 dedicated SFTP 만 종료. 터미널 SSH 연결은 유지.
ipcMain.handle('fe:release-sftp', (_e, { panelId }: { panelId: string }) => {
  const bridge = getSSHBridge();
  bridge.releaseDedicatedSftp(panelId);
  return { success: true };
});

// SQL Tool — 결과 파일 저장 다이얼로그 (확장자에 따라 CSV/JSON/TSV/TXT)
ipcMain.handle('sql:save-csv', async (_e, { defaultName, content }: { defaultName?: string; content: string }) => {
  if (!mainWindow) return { success: false, error: 'no window' };
  const name = defaultName || 'query-result.csv';
  const ext = (name.match(/\.([A-Za-z0-9]+)$/)?.[1] || 'csv').toLowerCase();
  const filterByExt: Record<string, { name: string; extensions: string[] }> = {
    csv: { name: 'CSV', extensions: ['csv'] },
    json: { name: 'JSON', extensions: ['json'] },
    tsv: { name: 'TSV', extensions: ['tsv'] },
    txt: { name: 'Text', extensions: ['txt'] },
  };
  const primaryFilter = filterByExt[ext] || filterByExt.csv;
  const r = await dialog.showSaveDialog(mainWindow, {
    title: t('dialog.saveCsv'),
    defaultPath: name,
    filters: [primaryFilter, { name: 'All Files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePath) return { success: false, canceled: true };
  try {
    // CSV 만 Excel 호환 BOM. 나머지는 순수 UTF-8.
    const payload = ext === 'csv' ? ('﻿' + content) : content;
    fs.writeFileSync(r.filePath, payload, 'utf8');
    return { success: true, path: r.filePath };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});

// 사이드카 JVM 재시작 — JAR 업데이트(빌드) 후 새 코드를 적용하려면 호출. 모든 활성 JDBC 연결도 끊김.
ipcMain.handle('jdbc:restart-sidecar', async () => {
  try {
    shutdownAllJdbcSidecars();
    // 다음 jdbcSharedSidecar().call 호출 시 자동 spawn — 여기서 ping 해서 즉시 재기동 검증
    const r = await getSharedJdbcSidecar().call('ping', null, 8000);
    return { success: true, result: r };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

// JDBC 사이드카 진단 — Java 프로세스 spawn + ping 라운드트립.
// E-2.2 단계: Driver Manager UI 의 "사이드카 확인" 버튼이 이걸 호출.
ipcMain.handle('jdbc:ping', async () => {
  const jar = findSidecarJar();
  const java = findJavaExecutable();
  if (!jar) {
    return { success: false, error: 'pepe-jdbc.jar 누락 — `npm run build:sidecar` 실행 필요', jar: null, java };
  }
  try {
    const result = await getSharedJdbcSidecar().call('ping', null, 8000);
    return { success: true, result, jar, java };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e), jar, java };
  }
});

// JDBC Driver Manager IPC — 등록된 드라이버 목록 조회/저장/삭제.
ipcMain.handle('jdbc:list-drivers', async () => {
  const drivers = listDrivers();
  // 진단 정보(누락된 JAR) 포함 — UI 가 "JAR 없음" 표시할 때 사용.
  return drivers.map(d => ({ ...d, diag: diagnoseDriver(d) }));
});
ipcMain.handle('jdbc:save-driver', async (_e, def: JdbcDriverDef) => {
  try {
    if (!def || !def.id) return { success: false, error: 'id 필수' };
    const next = upsertUserDriver(def);
    return { success: true, drivers: next };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('jdbc:remove-driver', async (_e, id: string) => {
  try {
    if (!id) return { success: false, error: 'id 필수' };
    const next = removeUserDriver(id);
    return { success: true, drivers: next };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('jdbc:driver-roots', async () => ({
  bundled: getBundledDriversRoot(),
  user: getUserJdbcDriversRoot(),
}));
// 사용자가 JAR 파일을 골라 ${userJdbc}/ 디렉토리로 복사 — Driver Manager 의 "JAR 추가" 버튼이 호출.
ipcMain.handle('jdbc:pick-and-import-jar', async () => {
  if (!mainWindow) return { success: false, error: 'no window' };
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'JDBC 드라이버 JAR 선택',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'JAR', extensions: ['jar'] }],
  });
  if (r.canceled || r.filePaths.length === 0) return { success: false, canceled: true };
  // DBeaver "Add File" 동등 — 원본 경로를 그대로 저장 (복사 X). 사용자가 어느 경로에서 가져왔는지 보존.
  return { success: true, imported: r.filePaths };
});
// 폴더 단위 JAR 가져오기 — DBeaver "Add Folder" 와 동일. 선택 폴더의 .jar 모두 복사.
ipcMain.handle('jdbc:pick-and-import-folder', async () => {
  if (!mainWindow) return { success: false, error: 'no window' };
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'JAR 폴더 선택 (하위 .jar 모두 참조)',
    properties: ['openDirectory'],
  });
  if (r.canceled || r.filePaths.length === 0) return { success: false, canceled: true };
  // DBeaver "Add Folder" 동등 — 원본 폴더의 .jar 들을 절대 경로로 참조 (복사 X).
  const imported: string[] = [];
  try {
    for (const dir of r.filePaths) {
      const entries = fs.readdirSync(dir);
      for (const f of entries) {
        if (!/\.jar$/i.test(f)) continue;
        const src = path.join(dir, f);
        const stat = fs.statSync(src);
        if (!stat.isFile()) continue;
        imported.push(src);
      }
    }
    return { success: true, imported };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});
// Maven artifact 다운로드 — DBeaver "Add Artifact" 와 동일 (Maven Central 에서 jar 다운로드 후 user JAR 로 복사).
//   coords 형식: "groupId:artifactId:version"  (DBeaver 와 동일)
ipcMain.handle('jdbc:download-maven-artifact', async (_e, args: { groupId: string; artifactId: string; version: string }) => {
  const { groupId, artifactId, version } = args || ({} as any);
  if (!groupId || !artifactId || !version) return { success: false, error: 'groupId/artifactId/version 모두 필요' };
  const groupPath = groupId.replace(/\./g, '/');
  const fileName = `${artifactId}-${version}.jar`;
  const url = `https://repo1.maven.org/maven2/${groupPath}/${artifactId}/${version}/${fileName}`;
  const userRoot = getUserJdbcDriversRoot();
  const dst = path.join(userRoot, fileName);
  try {
    const https = require('https');
    const http = require('http');
    await new Promise<void>((resolve, reject) => {
      const get = (u: string, depth: number) => {
        if (depth > 5) { reject(new Error('redirect 횟수 초과')); return; }
        const lib = u.startsWith('https:') ? https : http;
        lib.get(u, (res: any) => {
          // redirect 처리
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            get(res.headers.location, depth + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} ${url}`));
            return;
          }
          const out = fs.createWriteStream(dst);
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve()));
          out.on('error', reject);
        }).on('error', reject);
      };
      get(url, 0);
    });
    return { success: true, imported: `\${userJdbc}/${fileName}`, url };
  } catch (err: any) {
    try { fs.unlinkSync(dst); } catch {} // 실패 시 잔여 파일 제거
    return { success: false, error: `${String(err?.message || err)} (URL: ${url})` };
  }
});
// Driver 의 모든 maven: 좌표를 일괄 다운로드 (이미 캐시된 경우 스킵). DBeaver "Download/Update" 동등.
ipcMain.handle('jdbc:download-driver-libraries', async (_e, def: JdbcDriverDef) => {
  if (!def?.jars) return { success: false, error: 'no jars' };
  const results: { coord: string; ok: boolean; cached?: boolean; path?: string; error?: string }[] = [];
  const userRoot = getUserJdbcDriversRoot();
  const https = require('https');
  const http = require('http');
  for (const jar of def.jars) {
    // 공용 파서 — classifier + @ext(packaging) 지원
    const parsed = parseMavenCoord(jar);
    if (!parsed) continue;
    const fileName = parsed.fileName;
    const dst = path.join(userRoot, fileName);
    // 이미 캐시됨
    if (fs.existsSync(dst)) {
      results.push({ coord: jar, ok: true, cached: true, path: dst });
      continue;
    }
    const url = mavenCoordToUrl(jar)!;
    try {
      await new Promise<void>((resolve, reject) => {
        const get = (u: string, depth: number) => {
          if (depth > 5) { reject(new Error('redirect 초과')); return; }
          const lib = u.startsWith('https:') ? https : http;
          lib.get(u, (res: any) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              get(res.headers.location, depth + 1); return;
            }
            if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
            const out = fs.createWriteStream(dst);
            res.pipe(out);
            out.on('finish', () => out.close(() => resolve()));
            out.on('error', reject);
          }).on('error', reject);
        };
        get(url, 0);
      });
      results.push({ coord: jar, ok: true, cached: false, path: dst });
    } catch (err: any) {
      try { fs.unlinkSync(dst); } catch {}
      results.push({ coord: jar, ok: false, error: `${err?.message || err} (URL: ${url})` });
    }
  }
  return { success: true, results };
});
// 사이드카에 전달할 수 있는 드라이버의 "절대 JAR 경로" 해석 — 미리보기/디버그용.
ipcMain.handle('jdbc:resolve-jars', async (_e, def: JdbcDriverDef) => {
  return resolveDriverJarsExisting(def?.jars || []);
});

// 사이드카 정식 RPC 메서드 IPC. 모두 jdbcBridge.getSharedJdbcSidecar().call(method, params) 로 위임.
ipcMain.handle('jdbc:load-driver', async (_e, def: JdbcDriverDef) => {
  try {
    const jars = resolveDriverJarsExisting(def?.jars || []);
    if (jars.length === 0) return { success: false, error: 'JAR 없음(드라이버 정의 확인)' };
    const result = await getSharedJdbcSidecar().call('loadDriver', {
      driverId: def.id, className: def.className, jars,
    }, 30000);
    return { success: true, result };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
ipcMain.handle('jdbc:connect', async (_e, args: {
  connectionId: string;
  driver: JdbcDriverDef;
  url: string;
  user?: string;
  password?: string;
  props?: Record<string, string>;
}) => {
  try {
    // loadDriver 가 idempotent 라 자동 호출 — UI 가 신경 안 써도 됨.
    const jars = resolveDriverJarsExisting(args.driver?.jars || []);
    if (jars.length === 0) return { success: false, error: 'JAR 없음(드라이버 정의 확인)' };
    await getSharedJdbcSidecar().call('loadDriver', {
      driverId: args.driver.id, className: args.driver.className, jars,
    }, 30000);
    const result = await getSharedJdbcSidecar().call('connect', {
      connectionId: args.connectionId,
      driverId: args.driver.id,
      url: args.url,
      user: args.user,
      password: args.password,
      props: args.props,
    }, 60000);
    return { success: true, result };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
ipcMain.handle('jdbc:is-connected', async (_e, connectionId: string) => {
  try {
    const result = await getSharedJdbcSidecar().call('isConnected', { connectionId }, 8000);
    return { success: true, result };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
ipcMain.handle('jdbc:disconnect', async (_e, connectionId: string) => {
  try {
    const result = await getSharedJdbcSidecar().call('disconnect', { connectionId }, 8000);
    return { success: true, result };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
ipcMain.handle('jdbc:exec', async (_e, args: { connectionId: string; sql: string; maxRows?: number }) => {
  try {
    const result = await getSharedJdbcSidecar().call('exec', args, 120000);
    return { success: true, result };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
// 트랜잭션 — DBeaver 와 동일하게 Connection.setAutoCommit(false) / commit() / rollback() 네이티브 호출.
ipcMain.handle('jdbc:tx-begin', async (_e, args: { connectionId: string }) => {
  try { return { success: true, result: await getSharedJdbcSidecar().call('tx.begin', args, 15000) }; }
  catch (e: any) { return { success: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jdbc:tx-commit', async (_e, args: { connectionId: string }) => {
  try { return { success: true, result: await getSharedJdbcSidecar().call('tx.commit', args, 30000) }; }
  catch (e: any) { return { success: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jdbc:tx-rollback', async (_e, args: { connectionId: string }) => {
  try { return { success: true, result: await getSharedJdbcSidecar().call('tx.rollback', args, 30000) }; }
  catch (e: any) { return { success: false, error: String(e?.message || e) }; }
});
// Altibase 전용 — AltibaseConnection.setExplainPlan + AltibaseStatement.getExplainPlan reflection 사용.
ipcMain.handle('jdbc:altibase-explain', async (_e, args: { connectionId: string; sql: string }) => {
  try { return { success: true, result: await getSharedJdbcSidecar().call('altibase.explain', args, 30000) }; }
  catch (e: any) { return { success: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jdbc:meta-tables', async (_e, args: { connectionId: string; catalog?: string; schema?: string; types?: string[] }) => {
  try { return { success: true, result: await getSharedJdbcSidecar().call('meta.tables', args, 30000) }; }
  catch (e: any) { return { success: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jdbc:meta-columns', async (_e, args: { connectionId: string; catalog?: string; schema?: string; table: string }) => {
  try { return { success: true, result: await getSharedJdbcSidecar().call('meta.columns', args, 30000) }; }
  catch (e: any) { return { success: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jdbc:meta-primary-keys', async (_e, args: { connectionId: string; catalog?: string; schema?: string; table: string }) => {
  try { return { success: true, result: await getSharedJdbcSidecar().call('meta.primaryKeys', args, 30000) }; }
  catch (e: any) { return { success: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jdbc:meta-schemas', async (_e, args: { connectionId: string }) => {
  try { return { success: true, result: await getSharedJdbcSidecar().call('meta.schemas', args, 30000) }; }
  catch (e: any) { return { success: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jdbc:meta-functions', async (_e, args: { connectionId: string; catalog?: string; schema?: string }) => {
  try { return { success: true, result: await getSharedJdbcSidecar().call('meta.functions', args, 30000) }; }
  catch (e: any) { return { success: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jdbc:meta-procedures', async (_e, args: { connectionId: string; catalog?: string; schema?: string }) => {
  try { return { success: true, result: await getSharedJdbcSidecar().call('meta.procedures', args, 30000) }; }
  catch (e: any) { return { success: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jdbc:meta-indexes', async (_e, args: { connectionId: string; catalog?: string; schema?: string; table: string }) => {
  try { return { success: true, result: await getSharedJdbcSidecar().call('meta.indexes', args, 30000) }; }
  catch (e: any) { return { success: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jdbc:meta-procedure-columns', async (_e, args: { connectionId: string; catalog?: string; schema?: string; procedureName: string }) => {
  try { return { success: true, result: await getSharedJdbcSidecar().call('meta.procedureColumns', args, 30000) }; }
  catch (e: any) { return { success: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jdbc:meta-function-columns', async (_e, args: { connectionId: string; catalog?: string; schema?: string; functionName: string }) => {
  try { return { success: true, result: await getSharedJdbcSidecar().call('meta.functionColumns', args, 30000) }; }
  catch (e: any) { return { success: false, error: String(e?.message || e) }; }
});

// SQL Tool 세션 상태 영속화 (history / favorites / editorTabs).
// renderer 는 localStorage 대신 이 IPC 쌍을 통해 main 의 JSON 파일과 통신.
ipcMain.handle('sql-tool:get-state', async (_e, sessionId: string) => {
  if (!sessionId) return {};
  return getSqlToolState(sessionId);
});
ipcMain.handle('sql-tool:set-state', async (_e, args: { sessionId: string; partial: SqlToolSessionState }) => {
  if (!args?.sessionId) return { success: false, error: 'sessionId 누락' };
  try {
    const next = setSqlToolState(args.sessionId, args.partial || {});
    return { success: true, state: next };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});

// Compare 워크스페이스에서 좌/우 파일 내용을 로컬로 다운로드 (편집된 메모리 내용을 그대로 저장)
ipcMain.handle('compare:download', async (_e, { defaultName, content, encoding }: { defaultName?: string; content: string; encoding?: string }) => {
  if (!mainWindow) return { success: false, error: 'no window' };
  const r = await dialog.showSaveDialog(mainWindow, {
    title: '파일 다운로드',
    defaultPath: defaultName || 'download.txt',
  });
  if (r.canceled || !r.filePath) return { success: false, canceled: true };
  try {
    // 인코딩 별 처리: 기본 utf-8. cp949/euc-kr 은 iconv 로.
    const enc = (encoding || 'UTF-8').toUpperCase();
    if (enc === 'CP949' || enc === 'EUC-KR') {
      const iconv = require('iconv-lite');
      const buf = iconv.encode(content, 'cp949');
      fs.writeFileSync(r.filePath, buf);
    } else {
      fs.writeFileSync(r.filePath, content, 'utf-8');
    }
    return { success: true, path: r.filePath };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});

// SQL Tool — 동일 SSH 연결의 exec 채널로 isql 등 임의 명령 실행
ipcMain.handle('sql:exec', async (_e, { connId, command, timeoutMs }: { connId: string; command: string; timeoutMs?: number }) => {
  try {
    const bridge = getSSHBridge();
    const r = await bridge.handleSQLExec(connId, command, timeoutMs);
    return { success: true, ...r };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('fe:connected-sessions', () => {
  const bridge = getSSHBridge();
  return bridge.getConnectedPanelIds();
});

// ── SFTP IPC ──

ipcMain.handle('sftp:download', async (_e, { panelId, remotePath, isDir }: { panelId: string; remotePath: string; isDir?: boolean }) => {
  xferLog(`ipc sftp:download 요청 panelId=${panelId} remotePath=${remotePath} isDir=${!!isDir}`);
  if (!mainWindow) { xferLog('ipc sftp:download 중단 — mainWindow 없음'); return null; }
  const bridge = getSSHBridge();
  const baseName = remotePath.split('/').filter(Boolean).pop() || 'download';
  if (isDir) {
    // 폴더 다운로드 — 부모 폴더 고른 뒤 그 안에 원격 폴더 이름으로 재귀 복사
    xferLog('ipc sftp:download 폴더 저장 위치 선택 다이얼로그 표시');
    const pick = await dialog.showOpenDialog(mainWindow, {
      title: t('dialog.saveDownloadLocation'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (pick.canceled || pick.filePaths.length === 0) { xferLog('ipc sftp:download 폴더 선택 취소됨'); return null; }
    const parentDir = pick.filePaths[0];
    const localDst = path.join(parentDir, baseName);
    xferLog(`ipc sftp:download 폴더 선택됨 → ${localDst}`);
    try {
      await bridge.handleTransfer(
        { mode: 'remote', termId: panelId, path: remotePath },
        { mode: 'local', path: localDst },
        baseName,
      );
      xferLog('ipc sftp:download 폴더 다운로드 완료');
      return { success: true, localPath: localDst };
    } catch (err: any) {
      xferLog(`ipc sftp:download 폴더 다운로드 실패: ${err?.message || err}`);
      return { success: false, error: String(err) };
    }
  }
  // 파일 다운로드 — 저장 이름까지 지정
  xferLog('ipc sftp:download 파일 저장 위치 선택 다이얼로그 표시');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: t('dialog.saveRemoteFile'),
    defaultPath: baseName,
  });
  if (result.canceled || !result.filePath) { xferLog('ipc sftp:download 저장 취소됨'); return null; }
  xferLog(`ipc sftp:download 저장 위치 선택됨 → ${result.filePath}`);
  try {
    await bridge.handleSFTPDownload(panelId, remotePath, result.filePath);
    xferLog('ipc sftp:download 완료');
    return { success: true, localPath: result.filePath };
  } catch (err: any) {
    xferLog(`ipc sftp:download 실패: ${err?.message || err}`);
    return { success: false, error: String(err) };
  }
});

// 다중 파일 다운로드 — 한번 폴더 고른 뒤 모든 항목을 그 폴더 안에 저장
ipcMain.handle('sftp:download-multi', async (_e, { panelId, items }: { panelId: string; items: { path: string; isDir: boolean }[] }) => {
  if (!mainWindow || !items || items.length === 0) return null;
  const bridge = getSSHBridge();
  const pick = await dialog.showOpenDialog(mainWindow, {
    title: t('dialog.downloadMultiTitle', { count: items.length }),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (pick.canceled || pick.filePaths.length === 0) return null;
  const parentDir = pick.filePaths[0];
  const results: { path: string; success: boolean; error?: string }[] = [];
  for (const item of items) {
    const baseName = item.path.split('/').filter(Boolean).pop() || 'download';
    const localDst = path.join(parentDir, baseName);
    try {
      await bridge.handleTransfer(
        { mode: 'remote', termId: panelId, path: item.path },
        { mode: 'local', path: localDst },
        baseName,
      );
      results.push({ path: item.path, success: true });
    } catch (err: any) {
      results.push({ path: item.path, success: false, error: String(err) });
    }
  }
  const okCount = results.filter(r => r.success).length;
  return { success: okCount > 0, total: items.length, ok: okCount, results, localDir: parentDir };
});

function safeDownloadName(name: string): string {
  const cleaned = String(name || 'download').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return cleaned || 'download';
}

function uniqueLocalPath(dir: string, name: string): string {
  const parsed = path.parse(safeDownloadName(name));
  let candidate = path.join(dir, parsed.base);
  let idx = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name || 'download'} (${idx++})${parsed.ext || ''}`);
  }
  return candidate;
}

function findGoogleQuickShareExe(): string | null {
  if (process.platform !== 'win32') return null;
  const candidates = [
    path.join(process.env.ProgramFiles || '', 'Google', 'NearbyShare', 'nearby_share.exe'),
    path.join(process.env.ProgramFiles || '', 'Google', 'NearbyShare', 'nearby_share_launcher.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'NearbyShare', 'nearby_share.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'NearbyShare', 'nearby_share_launcher.exe'),
  ];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

async function openQuickShareForLocalPaths(localPaths: string[], tempDir: string): Promise<{ method: string; warning?: string }> {
  if (process.platform !== 'win32') {
    await shell.openPath(tempDir);
    return { method: 'folder', warning: 'Quick Share는 Windows에서만 자동 호출됩니다.' };
  }
  const payloadPath = path.join(tempDir, 'quick-share-paths.json');
  const scriptPath = path.join(tempDir, 'invoke-quick-share.ps1');
  fs.writeFileSync(payloadPath, JSON.stringify(localPaths), 'utf8');
  fs.writeFileSync(scriptPath, `
$ErrorActionPreference = 'Stop'
$paths = Get-Content -LiteralPath $args[0] -Raw | ConvertFrom-Json
$preferred = @('Quick Share', 'Nearby Share', '빠른 공유', '퀵 쉐어', '근거리 공유')
$fallback = @('공유', 'Share')
$shell = New-Object -ComObject Shell.Application
$miss = New-Object System.Collections.Generic.List[string]
foreach ($p in $paths) {
  $parent = [System.IO.Path]::GetDirectoryName([string]$p)
  $leaf = [System.IO.Path]::GetFileName([string]$p)
  $folder = $shell.Namespace($parent)
  if ($null -eq $folder) { $miss.Add("$p :: folder not found"); continue }
  $item = $folder.ParseName($leaf)
  if ($null -eq $item) { $miss.Add("$p :: item not found"); continue }
  $verbs = @($item.Verbs())
  $chosen = $null
  foreach ($needle in $preferred) {
    $chosen = $verbs | Where-Object { (($_.Name -replace '&','').Trim()) -like "*$needle*" } | Select-Object -First 1
    if ($null -ne $chosen) { break }
  }
  if ($null -eq $chosen) {
    foreach ($needle in $fallback) {
      $chosen = $verbs | Where-Object { (($_.Name -replace '&','').Trim()) -eq $needle -or (($_.Name -replace '&','').Trim()) -like "$needle(*)" } | Select-Object -First 1
      if ($null -ne $chosen) { break }
    }
  }
  if ($null -ne $chosen) {
    $chosen.DoIt()
    Start-Sleep -Milliseconds 350
  } else {
    $names = ($verbs | ForEach-Object { ($_.Name -replace '&','').Trim() }) -join ', '
    $miss.Add("$p :: $names")
  }
}
if ($miss.Count -gt 0) { throw ('share verb not found: ' + ($miss -join ' | ')) }
`, 'utf8');

  try {
    const { execFileSync } = require('child_process');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, payloadPath], {
      timeout: 15000,
      windowsHide: true,
      stdio: 'pipe',
    });
    return { method: 'shell-verb' };
  } catch (err: any) {
    const exe = findGoogleQuickShareExe();
    if (exe) {
      try {
        const { spawn } = require('child_process');
        const proc = spawn(exe, localPaths, { detached: true, stdio: 'ignore', windowsHide: false });
        proc.unref();
        return { method: 'google-quick-share-exe', warning: String(err?.stderr?.toString?.() || err?.message || err).slice(0, 1000) };
      } catch {}
    }
    await shell.openPath(tempDir);
    return { method: 'folder', warning: String(err?.stderr?.toString?.() || err?.message || err).slice(0, 1000) };
  }
}

async function downloadRemoteItemsToTemp(panelId: string, items: { path: string; isDir: boolean }[], prefix: string) {
  const bridge = getSSHBridge();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const results: { remotePath: string; localPath?: string; success: boolean; error?: string }[] = [];
  const localPaths: string[] = [];
  for (const item of items) {
    const baseName = safeDownloadName(item.path.split('/').filter(Boolean).pop() || 'download');
    const localDst = uniqueLocalPath(tempDir, baseName);
    try {
      if (item.isDir) {
        await bridge.handleTransfer(
          { mode: 'remote', termId: panelId, path: item.path },
          { mode: 'local', path: localDst },
          baseName,
        );
      } else {
        await bridge.handleSFTPDownload(panelId, item.path, localDst);
      }
      localPaths.push(localDst);
      results.push({ remotePath: item.path, localPath: localDst, success: true });
    } catch (err: any) {
      results.push({ remotePath: item.path, success: false, error: String(err?.message || err) });
    }
  }
  return { tempDir, results, localPaths };
}

ipcMain.handle('sftp:quick-share', async (_e, { panelId, items }: { panelId: string; items: { path: string; isDir: boolean }[] }) => {
  if (!mainWindow || !items || items.length === 0) return { success: false, error: '공유할 파일이 없습니다.' };
  const { tempDir, results, localPaths } = await downloadRemoteItemsToTemp(panelId, items, 'pepe-quick-share-');

  if (localPaths.length === 0) {
    return { success: false, error: 'Quick Share용 임시 다운로드에 실패했습니다.', results, localDir: tempDir };
  }

  const opened = await openQuickShareForLocalPaths(localPaths, tempDir);
  return {
    success: true,
    total: items.length,
    ok: localPaths.length,
    results,
    localDir: tempDir,
    method: opened.method,
    warning: opened.warning,
  };
});

ipcMain.handle('sftp:upload', async (_e, { panelId, remotePath, kind }: { panelId: string; remotePath: string; kind?: 'file' | 'folder' | 'multi-file' }) => {
  if (!mainWindow) return null;
  const isFolder = kind === 'folder';
  const isMulti = kind === 'multi-file';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: isFolder ? t('dialog.uploadFolder') : (isMulti ? t('dialog.uploadFileMulti') : t('dialog.uploadFile')),
    properties: isFolder ? ['openDirectory'] : (isMulti ? ['openFile', 'multiSelections'] : ['openFile']),
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  // 다중 파일 업로드 — 각 파일을 순차 업로드
  if (isMulti) {
    const bridge = getSSHBridge();
    const results: { filename: string; success: boolean; error?: string }[] = [];
    for (const localPath of result.filePaths) {
      const filename = localPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
      const fullRemote = remotePath.endsWith('/') ? remotePath + filename : remotePath + '/' + filename;
      try {
        await bridge.handleTransfer(
          { mode: 'local', path: localPath },
          { mode: 'remote', termId: panelId, path: fullRemote },
          filename,
        );
        results.push({ filename, success: true });
      } catch (err: any) {
        results.push({ filename, success: false, error: String(err) });
      }
    }
    const okCount = results.filter(r => r.success).length;
    return { success: okCount > 0, total: result.filePaths.length, ok: okCount, results };
  }
  const localPath = result.filePaths[0];
  const filename = localPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  const fullRemote = remotePath.endsWith('/') ? remotePath + filename : remotePath + '/' + filename;
  try {
    const bridge = getSSHBridge();
    if (isFolder) {
      await bridge.handleTransfer(
        { mode: 'local', path: localPath },
        { mode: 'remote', termId: panelId, path: fullRemote },
        filename,
      );
    } else {
      await bridge.handleSFTPUpload(panelId, localPath, fullRemote);
    }
    return { success: true, remotePath: fullRemote };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('sftp:list-dir', async (_e, { panelId, remotePath }: { panelId: string; remotePath: string }) => {
  try {
    const bridge = getSSHBridge();
    return await bridge.handleSFTPListDir(panelId, remotePath);
  } catch (err: any) {
    return { error: String(err) };
  }
});

ipcMain.handle('sftp:read-file', async (_e, { panelId, remotePath, encoding }: { panelId: string; remotePath: string; encoding?: string }) => {
  try {
    const bridge: any = getSSHBridge();
    let buf: Buffer;
    try {
      buf = await bridge.handleSFTPReadFile(panelId, remotePath);
    } catch (e: any) {
      // 로컬 PTY (SSH 연결 없는 미니탭) — 로컬 fs 로 폴백
      if (/연결되지 않음|not connected/i.test(String(e?.message || e))) {
        buf = await fs.promises.readFile(remotePath);
      } else throw e;
    }
    const iconv = require('iconv-lite');
    // 인코딩 명시 안 됐으면 세션의 encoding (터미널 인코딩) 사용. 없으면 휴리스틱: utf-8 디코드 실패하면 cp949 폴백.
    let enc = (encoding || '').toLowerCase();
    if (!enc) {
      try {
        const sess = bridge.sessionStore?.get?.(panelId) || bridge.clients?.get?.(panelId)?.session;
        if (sess?.encoding) enc = String(sess.encoding).toLowerCase();
      } catch {}
    }
    // UTF-8 시도 후 �(REPLACEMENT) 가 많으면 cp949 로 재해석 (Korean Linux 호스트에서 흔함).
    const decodeAuto = (b: Buffer): string => {
      const utf = b.toString('utf-8');
      const bad = (utf.match(/�/g) || []).length;
      if (bad > 0 && bad * 50 > utf.length) {
        try { return iconv.decode(b, 'cp949'); } catch { return utf; }
      }
      return utf;
    };
    let text: string;
    try {
      if (!enc || enc === 'utf-8' || enc === 'utf8') {
        text = decodeAuto(buf);
      } else if (iconv.encodingExists(enc)) {
        text = iconv.decode(buf, enc);
      } else {
        text = decodeAuto(buf);
      }
    } catch {
      text = decodeAuto(buf);
    }
    return { success: true, text, size: buf.length };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('sftp:write-file', async (_e, { panelId, remotePath, content, encoding }: { panelId: string; remotePath: string; content: string; encoding?: string }) => {
  try {
    const bridge = getSSHBridge();
    const iconv = require('iconv-lite');
    const enc = (encoding || 'utf-8').toLowerCase();
    let buf: Buffer;
    if (enc === 'utf-8' || enc === 'utf8') {
      buf = Buffer.from(content, 'utf-8');
    } else if (iconv.encodingExists(enc)) {
      buf = iconv.encode(content, enc);
    } else {
      buf = Buffer.from(content, 'utf-8');
    }
    try {
      await bridge.handleSFTPWriteFile(panelId, remotePath, buf);
    } catch (e: any) {
      // 로컬 PTY 폴백
      if (/연결되지 않음|not connected/i.test(String(e?.message || e))) {
        await fs.promises.writeFile(remotePath, buf);
      } else throw e;
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});



// ── 창 제어 ──
let dragStartPos: { x: number; y: number } | null = null;
// Aero Snap — 드래그 중 마우스가 화면 가장자리에 닿으면 release 시 해당 위치로 스냅.
// 모서리(corner) 는 1/4 분할, 위/좌/우 는 최대화·좌반·우반. 미리보기는 별도 투명 오버레이 창으로 표시.
type SnapZone = 'top' | 'left' | 'right' | 'tl' | 'tr' | 'bl' | 'br' | null;
let pendingSnapZone: SnapZone = null;
let snapPreviewWin: BrowserWindow | null = null;
const SNAP_EDGE_PX = 10; // 마우스가 디스플레이 경계에서 몇 px 이내일 때 스냅 발동 (반응 즉시성을 위해 넉넉히)
const SNAP_CORNER_PX = 80; // 모서리 영역 판정 — 가장자리에 닿은 상태에서 코너 80px 이내면 1/4 분할

// 시작 시 미리 빈 BrowserWindow 를 만들어 두면 첫 호출 시 BrowserWindow 생성 + HTML 로드로 인한
// 첫 표시 지연 (수백 ms) 이 사라짐. 이후엔 hide/show + setBounds 로만 토글.
function ensureSnapPreview(): BrowserWindow | null {
  if (snapPreviewWin && !snapPreviewWin.isDestroyed()) return snapPreviewWin;
  try {
    snapPreviewWin = new BrowserWindow({
      x: 0, y: 0, width: 200, height: 200,
      frame: false, transparent: true, hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
      backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    snapPreviewWin.setIgnoreMouseEvents(true);
    snapPreviewWin.setAlwaysOnTop(true, 'screen-saver');
    const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden;">
      <div style="position:fixed;inset:0;border:3px solid rgba(80,160,255,0.85);
        background:rgba(80,160,255,0.18);box-sizing:border-box;border-radius:6px;
        box-shadow:0 0 24px rgba(80,160,255,0.55), inset 0 0 24px rgba(80,160,255,0.25);
        pointer-events:none;"></div></body></html>`;
    snapPreviewWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  } catch { return null; }
  return snapPreviewWin;
}
function hideSnapPreview() {
  if (snapPreviewWin && !snapPreviewWin.isDestroyed() && snapPreviewWin.isVisible()) {
    try { snapPreviewWin.hide(); } catch {}
  }
}
function computeSnapBounds(zone: SnapZone, workArea: { x: number; y: number; width: number; height: number }) {
  const { x, y, width, height } = workArea;
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  switch (zone) {
    case 'top':   return { x, y, width, height };
    case 'left':  return { x, y, width: halfW, height };
    case 'right': return { x: x + width - halfW, y, width: halfW, height };
    case 'tl':    return { x, y, width: halfW, height: halfH };
    case 'tr':    return { x: x + width - halfW, y, width: halfW, height: halfH };
    case 'bl':    return { x, y: y + height - halfH, width: halfW, height: halfH };
    case 'br':    return { x: x + width - halfW, y: y + height - halfH, width: halfW, height: halfH };
    default:      return null;
  }
}
function showSnapPreview(zone: SnapZone, workArea: { x: number; y: number; width: number; height: number }) {
  const bounds = computeSnapBounds(zone, workArea);
  if (!bounds) { hideSnapPreview(); return; }
  const w = ensureSnapPreview();
  if (!w) return;
  try {
    w.setBounds(bounds);
    if (!w.isVisible()) w.showInactive();
  } catch {}
}
function detectSnapZone(mouseX: number, mouseY: number): { zone: SnapZone; workArea: { x: number; y: number; width: number; height: number } } {
  const display = screen.getDisplayNearestPoint({ x: mouseX, y: mouseY });
  const wa = display.workArea;
  const nearTop    = mouseY <= wa.y + SNAP_EDGE_PX;
  const nearLeft   = mouseX <= wa.x + SNAP_EDGE_PX;
  const nearRight  = mouseX >= wa.x + wa.width - SNAP_EDGE_PX - 1;
  const nearBottom = mouseY >= wa.y + wa.height - SNAP_EDGE_PX - 1;
  // 모서리 판정 — 한쪽 가장자리에 닿은 상태 + 다른 축이 모서리 코너 80px 이내
  const yNearTopCorner    = mouseY <= wa.y + SNAP_CORNER_PX;
  const yNearBottomCorner = mouseY >= wa.y + wa.height - SNAP_CORNER_PX;
  const xNearLeftCorner   = mouseX <= wa.x + SNAP_CORNER_PX;
  const xNearRightCorner  = mouseX >= wa.x + wa.width - SNAP_CORNER_PX;
  let zone: SnapZone = null;
  if ((nearTop && xNearLeftCorner) || (nearLeft && yNearTopCorner)) zone = 'tl';
  else if ((nearTop && xNearRightCorner) || (nearRight && yNearTopCorner)) zone = 'tr';
  else if ((nearBottom && xNearLeftCorner) || (nearLeft && yNearBottomCorner)) zone = 'bl';
  else if ((nearBottom && xNearRightCorner) || (nearRight && yNearBottomCorner)) zone = 'br';
  else if (nearTop) zone = 'top';
  else if (nearLeft) zone = 'left';
  else if (nearRight) zone = 'right';
  return { zone, workArea: wa };
}

// IPC 를 보낸 렌더러가 속한 BrowserWindow. (분리 창 지원 — 없으면 메인 창)
function winOf(e: any): BrowserWindow | null {
  try { return BrowserWindow.fromWebContents(e.sender) || mainWindow; } catch { return mainWindow; }
}

// 렌더러가 완전히 멈춰 Ctrl+Shift+I(전역 키 핸들러 포함) 조차 안 먹는 경우를 대비해,
// 툴바 버튼으로도 개발자도구를 열 수 있게 — 키보드 경로에 의존하지 않는 별도 진입점.
ipcMain.handle('window:toggle-devtools', (e) => {
  try { winOf(e)?.webContents.toggleDevTools(); return true; } catch { return false; }
});
// 현재 타이틀바 드래그 중인 창 (분리 창도 드래그 가능하도록 추적)
let draggingWin: BrowserWindow | null = null;

ipcMain.on('window:start-drag', (e, { mouseX, mouseY }: any) => {
  const w = winOf(e);
  if (!w) return;
  draggingWin = w;
  const [wx, wy] = w.getPosition();
  dragStartPos = { x: mouseX - wx, y: mouseY - wy };
  pendingSnapZone = null;
});

ipcMain.on('window:drag-move', (e, { mouseX, mouseY }: any) => {
  const w = draggingWin || winOf(e);
  if (!w || !dragStartPos) return;
  // 최대화 상태에서 드래그하면 자동 복원
  if (w.isMaximized()) {
    const restoreW = savedBounds.width;
    const restoreH = savedBounds.height;
    const offsetX = Math.min(dragStartPos.x, restoreW - 80);
    const newX = mouseX - offsetX;
    const newY = mouseY - Math.min(dragStartPos.y, 20);
    w.unmaximize();
    w.setBounds({ x: newX, y: newY, width: restoreW, height: restoreH });
    dragStartPos = { x: offsetX, y: Math.min(dragStartPos.y, 20) };
    if (w === mainWindow) isMaximized = false;
    return;
  }
  w.setPosition(mouseX - dragStartPos.x, mouseY - dragStartPos.y);
  // Aero Snap 영역 검출 + 미리보기 토글
  const { zone, workArea } = detectSnapZone(mouseX, mouseY);
  if (zone !== pendingSnapZone) {
    pendingSnapZone = zone;
    if (zone) showSnapPreview(zone, workArea);
    else hideSnapPreview();
  }
});

ipcMain.on('window:end-drag', () => {
  dragStartPos = null;
  const w = draggingWin;
  draggingWin = null;
  // 스냅 영역에서 release → 스냅 실행
  if (pendingSnapZone && w) {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const bounds = computeSnapBounds(pendingSnapZone, display.workArea);
    if (bounds) {
      if (pendingSnapZone === 'top') {
        // 최대화는 OS native maximize 호출 — 작업표시줄 회피 + 모니터 변경 자동 대응
        w.maximize();
      } else {
        w.setBounds(bounds);
      }
    }
  }
  pendingSnapZone = null;
  hideSnapPreview();
});

ipcMain.handle('window:minimize', (e) => winOf(e)?.minimize());
ipcMain.handle('window:toggle-maximize', (e) => {
  const w = winOf(e);
  if (!w) return;
  dragStartPos = null;
  let max: boolean;
  if (w.isMaximized()) {
    w.unmaximize();
    max = false;
  } else {
    if (w === mainWindow) savedBounds = w.getBounds();
    w.maximize();
    max = true;
  }
  if (w === mainWindow) isMaximized = max;
  w.webContents.send('window:maximized', max);
});
ipcMain.handle('window:is-maximized', (e) => !!winOf(e)?.isMaximized());
ipcMain.handle('window:close', (e) => winOf(e)?.close());
ipcMain.handle('window:focus', (e) => {
  const w = winOf(e);
  if (!w) return;
  try {
    if (w.isMinimized()) w.restore();
    // Windows 에서 백그라운드 process(PowerShell 등) 가 잠시 foreground 를 채간 경우,
    // 단순한 focus() 는 무시될 수 있음 → alwaysOnTop 토글 트릭으로 강제 foreground
    w.show();
    // alwaysOnTop 토글: 잠시 최상위로 올렸다 내림. Windows 에서 foreground 강제 효과적.
    const wasOnTop = w.isAlwaysOnTop();
    if (!wasOnTop) {
      w.setAlwaysOnTop(true);
    }
    w.moveTop();
    w.focus();
    // 명시적 webContents focus — 키보드 입력 capture 보장
    try { w.webContents.focus(); } catch {}
    // 토글 복귀 — 다음 tick 에 alwaysOnTop 해제 (이때는 이미 foreground 됨)
    if (!wasOnTop) {
      setTimeout(() => {
        try { if (!w.isDestroyed()) w.setAlwaysOnTop(false); } catch {}
      }, 50);
    }
    // app.focus() 도 추가 — Electron 앱 자체를 foreground 로
    try { app.focus({ steal: true }); } catch {}
  } catch (err) { console.error('[window:focus] failed', err); }
});

// ── 탭 분리(멀티 윈도우) ─────────────────────────────────────────────
// 분리된 창에 전달할 탭 페이로드 — webContents.id 로 키잉, 새 렌더러가 로드 후 가져감.
const detachedInitPayloads = new Map<number, any>();

function createDetachedWindow(payload: any, bounds?: { x?: number; y?: number; width?: number; height?: number }) {
  if (app.isPackaged) Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: bounds?.width || 1100,
    height: bounds?.height || 740,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 600,
    minHeight: 400,
    icon: path.join(__dirname, '../public/icon.ico'),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
    },
  });
  detachedWindows.add(win);
  detachedInitPayloads.set(win.webContents.id, payload);
  console.log('[detached] payload preview:', JSON.stringify({
    kind: payload?.kind,
    tabId: payload?.tab?.id,
    connectAfterAdopt: payload?.connectAfterAdopt,
    snapshotOnly: payload?.snapshotOnly,
  }));
  win.once('ready-to-show', () => { try { win.show(); win.focus(); } catch {} });
  // closed 시점엔 win.webContents 가 이미 destroy 됐을 수 있으므로 id 를 미리 캡처.
  // 핸들러 내부 throw 가 같은 'closed' 의 다른 리스너(onMainWindowClosed) 호출을 막지 않게 try 로 감싼다.
  const wcId = win.webContents.id;
  win.on('closed', () => {
    try { detachedWindows.delete(win); } catch {}
    try { detachedInitPayloads.delete(wcId); } catch {}
  });
  // http(s) 외부 링크는 기본 브라우저로 (메인 창과 동일 정책)
  win.webContents.on('will-navigate', (event, url) => {
    if (/^https?:\/\//i.test(url)) { event.preventDefault(); shell.openExternal(url).catch(() => {}); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) { shell.openExternal(url).catch(() => {}); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'] || process.env['VITE_DEV_SERVER_URL'];
  if (!app.isPackaged && devServerUrl) {
    win.loadURL(devServerUrl + '#detached');
  } else {
    win.loadURL(pepeAppUrl('detached'));
  }
  return win;
}

ipcMain.handle('window:detach-tab', (_e, { payload, bounds }: { payload: any; bounds?: any }) => {
  try { createDetachedWindow(payload, bounds); return true; } catch (err) { console.error('[detach] fail', err); return false; }
});

// ── 포스트잇(Sticky Note) — 화면 어디든 붙일 수 있는 독립 창들 ───────────────
// 각 노트는 frameless/transparent/always-on-top 인 별도 BrowserWindow. 위치/크기/내용은
// stickyNotesStore.ts 에 즉시 저장되어 앱을 껐다 켜도 마지막 위치에 그대로 복원된다.
const stickyNoteWindows = new Map<string, BrowserWindow>();
const stickyNoteBoundsSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
// "최소화"된 포스트잇 — OS 작업표시줄 대신 메인 창 우측 사이드바(스티커 메모 패널)에서 관리한다
// (skipTaskbar 라 OS 최소화로는 복구할 방법이 없었음). 창을 파괴하지 않고 숨기기만 한다.
const minimizedStickyNoteIds = new Set<string>();
// 사이드바 패널은 최소화 여부와 무관하게 전체 포스트잇 목록을 보여준다(Windows 스티커 메모 앱 패턴) —
// 만들기/수정/삭제/최소화/복구 어느 쪽이든 바뀔 때마다 전체 목록을 다시 브로드캐스트.
function broadcastStickyNoteList() {
  try {
    const { notes } = loadStickyNotes();
    const list = notes.map(n => ({ id: n.id, html: n.html, updatedAt: n.updatedAt, minimized: minimizedStickyNoteIds.has(n.id) }));
    mainWindow?.webContents.send('sticky-note:list', list);
  } catch {}
}

function loadStickyNoteWindow(url: string, win: BrowserWindow) {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'] || process.env['VITE_DEV_SERVER_URL'];
  if (!app.isPackaged && devServerUrl) {
    win.loadURL(devServerUrl + url);
  } else {
    win.loadURL(pepeAppUrl(url.replace(/^#/, '')));
  }
}

function createStickyNoteWindow(note: StickyNote, focus: boolean) {
  const existing = stickyNoteWindows.get(note.id);
  if (existing && !existing.isDestroyed()) { if (focus) { existing.show(); existing.focus(); } return existing; }
  const win = new BrowserWindow({
    x: Math.round(note.x), y: Math.round(note.y),
    width: Math.round(note.width), height: Math.round(note.height),
    minWidth: 240, minHeight: 220,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  stickyNoteWindows.set(note.id, win);
  // frame:false 창의 드래그 영역(-webkit-app-region:drag) 우클릭 시 Windows 가 자동으로 띄우는
  // 시스템 메뉴(이동/크기조정/최소화 등)를 막는다 — 포커스를 뺏어가 편집 중이던 내용이 끊기는 문제.
  win.on('system-context-menu', (e) => e.preventDefault());
  win.once('ready-to-show', () => { try { win.show(); if (focus) win.focus(); } catch {} });
  const saveBoundsDebounced = () => {
    const timer = stickyNoteBoundsSaveTimers.get(note.id);
    if (timer) clearTimeout(timer);
    stickyNoteBoundsSaveTimers.set(note.id, setTimeout(() => {
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      try { updateStickyNote(note.id, { x: b.x, y: b.y, width: b.width, height: b.height }); } catch {}
    }, 300));
  };
  win.on('move', saveBoundsDebounced);
  win.on('resize', saveBoundsDebounced);
  win.on('closed', () => {
    stickyNoteWindows.delete(note.id);
    const timer = stickyNoteBoundsSaveTimers.get(note.id);
    if (timer) clearTimeout(timer);
    stickyNoteBoundsSaveTimers.delete(note.id);
    if (minimizedStickyNoteIds.delete(note.id)) broadcastStickyNoteList();
  });
  loadStickyNoteWindow(`#sticky-note?id=${encodeURIComponent(note.id)}`, win);
  return win;
}

function restoreStickyNotes() {
  try {
    const { notes } = loadStickyNotes();
    for (const note of notes) createStickyNoteWindow(note, false);
  } catch (err) { console.error('[sticky-note] restore failed:', err); }
}

ipcMain.handle('sticky-note:create', () => {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x: ax, y: ay, width: aw, height: ah } = display.workArea;
  const count = stickyNoteWindows.size;
  const defaultWidth = 380;
  const defaultHeight = 380;
  const note: StickyNote = {
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    x: ax + Math.min(60 + (count % 8) * 28, aw - defaultWidth),
    y: ay + Math.min(60 + (count % 8) * 28, ah - defaultHeight),
    width: defaultWidth,
    height: defaultHeight,
    html: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  addStickyNote(note);
  createStickyNoteWindow(note, true);
  broadcastStickyNoteList();
  return note;
});

ipcMain.handle('sticky-note:get', (_e, id: string) => getStickyNote(id) || null);

ipcMain.handle('sticky-note:update-content', (_e, { id, html }: { id: string; html: string }) => {
  try { updateStickyNote(id, { html }); } catch {}
  broadcastStickyNoteList();
});

ipcMain.handle('sticky-note:delete', (_e, id: string) => {
  const win = stickyNoteWindows.get(id);
  if (win && !win.isDestroyed()) win.destroy();
  stickyNoteWindows.delete(id);
  try { removeStickyNote(id); } catch {}
  minimizedStickyNoteIds.delete(id);
  broadcastStickyNoteList();
});

// 사이드바 패널로 최소화 — 창을 숨기고(파괴 아님) id 를 목록에 추가.
ipcMain.handle('sticky-note:minimize-to-sidebar', (_e, id: string) => {
  const win = stickyNoteWindows.get(id);
  if (win && !win.isDestroyed()) win.hide();
  minimizedStickyNoteIds.add(id);
  broadcastStickyNoteList();
});

// 사이드바 패널에서 특정 포스트잇을 클릭 — 최소화 여부와 무관하게 보이고 포커스.
ipcMain.handle('sticky-note:focus', (_e, id: string) => {
  const win = stickyNoteWindows.get(id);
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
  } else {
    // 창이 (Alt+F4 등으로) 닫혔지만 데이터는 남아있는 경우 — 다시 띄운다.
    const note = getStickyNote(id);
    if (note) createStickyNoteWindow(note, true);
  }
  minimizedStickyNoteIds.delete(id);
  broadcastStickyNoteList();
});

ipcMain.handle('sticky-note:get-list', () => {
  const { notes } = loadStickyNotes();
  return notes.map(n => ({ id: n.id, html: n.html, updatedAt: n.updatedAt, minimized: minimizedStickyNoteIds.has(n.id) }));
});
// 탭 드롭 — 드롭 지점(point, 화면좌표)이 다른 앱 창 위면 그 창으로 re-dock, 아니면 새 창 생성.
ipcMain.handle('window:drop-tab', (e, { payload, point, sourceTabCount }: { payload: any; point?: { x: number; y: number }; sourceTabCount?: number }) => {
  try {
    const sourceWin = winOf(e);
    // 최소화/숨김 창은 화면에 안 보여도 getBounds() 가 restored 좌표를 돌려주므로
    // hit-test 에 포함하면 안 됨 (사용자가 그 위치에 드롭할 의도가 없음).
    const appWins = [mainWindow, ...detachedWindows].filter(w => {
      if (!w || w.isDestroyed()) return false;
      try { if (w.isMinimized() || !w.isVisible()) return false; } catch {}
      return true;
    }) as BrowserWindow[];
    let target: BrowserWindow | null = null;
    if (point) {
      for (const w of appWins) {
        if (w === sourceWin) continue;
        const b = w.getBounds();
        if (point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height) { target = w; break; }
      }
    }
    if (target) {
      target.webContents.send('window:adopt-tab', { ...payload, point });
      try { target.show(); target.focus(); } catch {}
      return { docked: true };
    }
    // 다른 앱 창으로 재도킹되는 게 아니라 진짜 새 창을 만드는 경우에만, 원본 창에 탭이
    // 하나(sourceTabCount<=1)뿐이면 거부한다 — 그러면 원본 창에 탭이 하나도 안 남게 됨.
    // (재도킹 드래그도 같은 함수를 타므로, 여기서 target 유무로 분기해야 재도킹이 막히지 않는다.)
    if (sourceTabCount != null && sourceTabCount <= 1) {
      return { docked: false, blocked: true };
    }
    // 멀티모니터 환경에서 음수 좌표(주모니터 왼쪽/위쪽 모니터)도 그대로 보존해야
    // 사용자가 드롭한 모니터에 정확히 분리 창이 생성됨. Math.max(0, ...) 클램프는 금지.
    createDetachedWindow(payload, point ? { x: point.x - 250, y: point.y - 16 } : undefined);
    return { docked: false };
  } catch (err) { console.error('[drop-tab] fail', err); return { docked: false, error: String(err) }; }
});
// 분리 창 렌더러가 로드 직후 자기 페이로드를 가져감 (1회성)
ipcMain.handle('window:get-detached-init', (e) => {
  const p = detachedInitPayloads.get(e.sender.id);
  detachedInitPayloads.delete(e.sender.id);
  return p || null;
});
function getLiveSshPanelIds(): string[] {
  const bridge: any = getSSHBridge();
  for (const panelId of [...connectedPanels]) {
    if (!bridge.hasActiveClient?.(panelId)) connectedPanels.delete(panelId);
  }
  return Array.from(connectedPanels);
}

function hasLiveSshPanel(panelId: string): boolean {
  const bridge: any = getSSHBridge();
  if (!connectedPanels.has(panelId)) return false;
  if (bridge.hasActiveClient?.(panelId)) return true;
  connectedPanels.delete(panelId);
  return false;
}

// 새 창에서 라이브 세션 연결 상태 시딩용 — 현재 연결된 panelId 목록
ipcMain.handle('ssh:connected-panels', () => getLiveSshPanelIds());
// 현재 마우스의 화면 좌표 (탭 드래그 분리 판정용)
ipcMain.handle('window:cursor-point', () => { try { return screen.getCursorScreenPoint(); } catch { return null; } });
// 호출 창이 화면 어디에 있는지 (드롭 좌표가 창 밖인지 판정용)
ipcMain.handle('window:get-bounds', (e) => { try { return winOf(e)?.getBounds() || null; } catch { return null; } });

ipcMain.handle('ssh:auth-response', (_e, { panelId, responses }: { panelId: string; responses: string[] }) => {
  const bridge = getSSHBridge();
  bridge.handleAuthResponse(panelId, responses);
  return 'ok';
});

ipcMain.handle('ssh:reset-state', (_e, panelId: string) => {
  connectedPanels.delete(panelId);
  connectingPanels.delete(panelId);
  return 'ok';
});
// SSH 위 로컬 포트 포워딩 — SqlTool 의 JDBC 연결을 SSH 세션을 통해 라우팅.
//   sessionId 로 활성 SSH 패널을 찾고, 그 위에 forwardOut(remote→127.0.0.1:auto) 매핑 생성.
ipcMain.handle('ssh:open-local-forward', async (_e, args: { sessionId: string; remoteHost: string; remotePort: number; sshHost?: string; sshPort?: number }) => {
  try {
    const bridge: any = getSSHBridge();
    // 1차: sessionId 매칭. 2차: SSH host:port 힌트 매칭 (quick-connect 시).
    let panelId: string | null = bridge.findPanelBySessionId?.(args.sessionId, { host: args.sshHost, port: args.sshPort }) ?? null;
    // 3차 fallback: 활성 SSH 가 1개뿐이면 그것을 사용 (사용자가 명시적으로 그것을 띄워놓은 것이 명백)
    if (!panelId) {
      const active: string[] = bridge.listActivePanels?.() || [];
      if (active.length === 1) {
        panelId = active[0];
        console.log(`[ssh-tunnel] only 1 active SSH panel — using ${panelId} as fallback`);
      } else {
        // 전체 디버그 dump 는 메인 콘솔로만 — UI 에는 핵심 정보만 노출 (이전엔 16+ 터미널 상세를 빨간 박스에 쏟아냈음)
        const dump = bridge.dumpSessionInfo?.() || '(dump unavailable)';
        console.log(`[ssh-tunnel] match fail. sessionId=${args.sessionId}, sshHost=${args.sshHost}, sshPort=${args.sshPort}, dump=${dump}`);
        const hosts: string[] = bridge.listActiveHosts?.() || [];
        const hint = args.sshHost ? `${args.sshHost}${args.sshPort && args.sshPort !== 22 ? ':' + args.sshPort : ''}` : '(없음)';
        const hostsTxt = hosts.length === 0 ? '(연결된 SSH 터미널 없음)' : hosts.slice(0, 8).join(', ') + (hosts.length > 8 ? ` 외 ${hosts.length - 8}개` : '');
        return { success: false, error: `${hint} 에 연결된 활성 SSH 터미널이 없습니다.\n현재 연결된 SSH: ${hostsTxt}\n→ 먼저 ${hint} 로 SSH 세션을 연결한 뒤 다시 시도하세요.` };
      }
    }
    const { forwardId, localPort } = await bridge.openLocalForward(panelId, args.remoteHost, args.remotePort);
    return { success: true, forwardId, localPort, panelId };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
ipcMain.handle('ssh:close-local-forward', (_e, args: { forwardId: string }) => {
  try {
    const bridge: any = getSSHBridge();
    const ok = bridge.closeLocalForward?.(args.forwardId);
    return { success: !!ok };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
// SQL Tool 등 — 활성 터미널 없이도 세션의 점프 체인으로 백그라운드 SSH 연결을 직접 맺고
// 그 위로 DB 포트를 로컬 포워딩. (점프된 세션에서 터미널을 안 띄워도 SQL 연결되도록)
ipcMain.handle('ssh:open-dedicated-forward', async (_e, args: { sessionId: string; remoteHost: string; remotePort: number }) => {
  try {
    const bridge: any = getSSHBridge();
    const session = sessionsData.sessions.find(s => s.id === args.sessionId);
    if (!session) return { success: false, error: '세션을 찾을 수 없습니다.' };
    const needsPw = !session.auth || (session.auth.type === 'password' && !session.auth.password);
    if (needsPw) return { success: false, error: '이 세션은 저장된 비밀번호/키가 없어 백그라운드 SSH 연결을 만들 수 없습니다. 세션에 자격증명을 저장하거나 먼저 해당 세션으로 터미널을 연결하세요.' };
    const connId = `sqlfwd-${args.sessionId}-${Date.now().toString(36)}`;
    try {
      await bridge.handleSFTPConnect(connId, session.host, session.port || 22, session.username, session.auth, undefined, (session as any).jumps);
    } catch (e: any) {
      try { bridge.handleSFTPDisconnect?.(connId); } catch {}
      return { success: false, error: `백그라운드 SSH 연결 실패: ${e?.message || e}` };
    }
    try {
      const { forwardId, localPort } = await bridge.openLocalForward(connId, args.remoteHost, args.remotePort);
      return { success: true, forwardId, localPort, connId, panelId: connId };
    } catch (e: any) {
      try { bridge.handleSFTPDisconnect?.(connId); } catch {}
      return { success: false, error: `포워드 열기 실패: ${e?.message || e}` };
    }
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
ipcMain.handle('ssh:close-dedicated-forward', (_e, args: { forwardId?: string; connId?: string }) => {
  try {
    const bridge: any = getSSHBridge();
    if (args.forwardId) { try { bridge.closeLocalForward?.(args.forwardId); } catch {} }
    if (args.connId) { try { bridge.handleSFTPDisconnect?.(args.connId); } catch {} }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
// 브라우저 — 활성 터미널 없이도 세션의 점프 체인으로 백그라운드 SSH 연결을 직접 맺고
// 그 위로 SOCKS5 프록시를 열어 webview 트래픽을 라우팅. (점프+URL 세션을 터미널 없이 브라우저만 열어도 사용)
ipcMain.handle('ssh:open-dedicated-socks', async (_e, args: { sessionId: string }) => {
  try {
    const bridge: any = getSSHBridge();
    const session = sessionsData.sessions.find(s => s.id === args.sessionId);
    if (!session) return { success: false, error: '세션을 찾을 수 없습니다.' };
    const needsPw = !session.auth || (session.auth.type === 'password' && !session.auth.password);
    if (needsPw) return { success: false, error: '이 세션은 저장된 비밀번호/키가 없어 백그라운드 SSH 연결을 만들 수 없습니다. 세션에 자격증명을 저장하거나 먼저 해당 세션으로 터미널을 연결하세요.' };
    const connId = `websocks-${args.sessionId}-${Date.now().toString(36)}`;
    try {
      await bridge.handleSFTPConnect(connId, session.host, session.port || 22, session.username, session.auth, undefined, (session as any).jumps);
    } catch (e: any) {
      try { bridge.handleSFTPDisconnect?.(connId); } catch {}
      return { success: false, error: `백그라운드 SSH 연결 실패: ${e?.message || e}` };
    }
    try {
      const r = await bridge.openSocksProxy(connId);
      return { success: !!r, ...(r || {}), connId };
    } catch (e: any) {
      try { bridge.handleSFTPDisconnect?.(connId); } catch {}
      return { success: false, error: `SOCKS 프록시 열기 실패: ${e?.message || e}` };
    }
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
ipcMain.handle('ssh:close-dedicated-socks', (_e, args: { proxyId?: string; connId?: string }) => {
  try {
    const bridge: any = getSSHBridge();
    if (args.proxyId) { try { bridge.closeSocksProxy?.(args.proxyId); } catch {} }
    if (args.connId) { try { bridge.handleSFTPDisconnect?.(args.connId); } catch {} }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

// ── MicroSIP / SSW 소프트폰 (네이티브 PJSIP 사이드카) 제어 ──
// 둘은 완전히 독립된 sipd.exe 프로세스를 쓴다(getSipSidecar(engine), sipSidecar.ts 참고) — 한쪽
// 엔진이 죽거나 재시작해도 다른 쪽 통화에 전혀 영향을 주지 않는다. 렌더러는 모든 sip:* 호출에
// args.engine('microsip'|'ssw')을 실어 보내고, 이벤트는 payload.engine 을 보고 필터링한다.
{
  const engineOf = (args: any): 'microsip' | 'ssw' => (args?.engine === 'ssw' ? 'ssw' : 'microsip');
  for (const engine of ['microsip', 'ssw'] as const) {
    const sip = getSipSidecar(engine);
    sip.on('event', (payload: any) => {
      for (const w of BrowserWindow.getAllWindows()) {
        try { if (!w.isDestroyed()) w.webContents.send('sip:event', { ...payload, engine }); } catch {}
      }
    });
  }
  ipcMain.handle('sip:engine-status', (_e, args: any) => getSipSidecar(engineOf(args)).ensureStarted());
  ipcMain.handle('sip:register', async (_e, args: { endpoint: any; engine?: string }) => getSipSidecar(engineOf(args)).register(args?.endpoint));
  ipcMain.handle('sip:unregister', async (_e, args: { endpointId: string; engine?: string }) => getSipSidecar(engineOf(args)).unregister(args?.endpointId));
  ipcMain.handle('sip:call', async (_e, args: { endpointId: string; target: string; engine?: string }) => getSipSidecar(engineOf(args)).call(args?.endpointId, args?.target));
  ipcMain.handle('sip:hangup', async (_e, args: { endpointId: string; engine?: string }) => getSipSidecar(engineOf(args)).hangup(args?.endpointId));
  ipcMain.handle('sip:answer', async (_e, args: { endpointId: string; engine?: string }) => getSipSidecar(engineOf(args)).answer(args?.endpointId));
  ipcMain.handle('sip:reject', async (_e, args: { endpointId: string; engine?: string }) => getSipSidecar(engineOf(args)).reject(args?.endpointId));
  ipcMain.handle('sip:hold', async (_e, args: { endpointId: string; hold: boolean; engine?: string }) => getSipSidecar(engineOf(args)).hold(args?.endpointId, !!args?.hold));
  ipcMain.handle('sip:ctr-transfer', async (_e, args: { endpointId: string; digits: string; number: string; engine?: string }) => getSipSidecar(engineOf(args)).ctrTransfer(args?.endpointId, args?.digits, args?.number));
  ipcMain.handle('sip:mute', async (_e, args: { endpointId: string; mute: boolean; engine?: string }) => getSipSidecar(engineOf(args)).mute(args?.endpointId, !!args?.mute));
  ipcMain.handle('sip:speaker-mute', async (_e, args: { endpointId: string; mute: boolean; engine?: string }) => getSipSidecar(engineOf(args)).speakerMute(args?.endpointId, !!args?.mute));
  ipcMain.handle('sip:transfer', async (_e, args: { endpointId: string; target: string; engine?: string }) => getSipSidecar(engineOf(args)).transfer(args?.endpointId, args?.target));
  ipcMain.handle('sip:send-info', async (_e, args: { endpointId: string; header: string; value: string; engine?: string }) => getSipSidecar(engineOf(args)).sendInfo(args?.endpointId, args?.header, args?.value));
  ipcMain.handle('sip:record', async (_e, args: { endpointId: string; on: boolean; engine?: string }) => {
    let file = '';
    if (args?.on) {
      try {
        const dir = path.join(app.getPath('userData'), 'microsip-recordings');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        file = path.join(dir, `${args.endpointId}-${stamp}.wav`);
      } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
    }
    return getSipSidecar(engineOf(args)).record(args?.endpointId, !!args?.on, file);
  });
  // 미디어(WAV) 송출 — 파일 선택은 렌더러가 이 다이얼로그로 먼저 받아온 뒤 media-play 호출.
  ipcMain.handle('sip:media-pick-file', async () => {
    if (!mainWindow) return null;
    // pjsua2 AudioMediaPlayer(pjmedia_wav_player_port_create)는 비압축 PCM WAV만 지원한다.
    // MP3/M4A/OGG 등은 렌더러가 Web Audio(decodeAudioData)로 디코드 후 WAV 로 변환해서 넘긴다
    // (sip:media-read-file + sip:media-write-temp-wav, MicroSipWorkspace.tsx toggleMedia 참고).
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '송출할 오디오 파일 선택',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  // 임의 오디오 파일의 원본 바이트 — 렌더러에서 Web Audio(decodeAudioData)로 디코드하기 위함.
  ipcMain.handle('sip:media-read-file', async (_e, args: { file: string }) => {
    try { return fs.readFileSync(args.file).buffer; }
    catch (e: any) { return { error: String(e?.message || e) }; }
  });
  // 렌더러가 디코드+WAV 인코딩(audioBufferToWav)한 바이트를 임시 파일로 저장 — sipMediaPlay 가
  // 그 경로를 sipd 에 넘긴다. 저장 대화상자 없이 조용히 저장(office-doc:save-file 과 달리).
  ipcMain.handle('sip:media-write-temp-wav', async (_e, args: { data: ArrayBuffer }) => {
    try {
      const p = path.join(require('os').tmpdir(), `pepe-sip-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
      fs.writeFileSync(p, Buffer.from(args.data));
      return { ok: true, path: p };
    } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
  });
  ipcMain.handle('sip:media-play', async (_e, args: { endpointId: string; file: string; engine?: string }) => getSipSidecar(engineOf(args)).mediaPlay(args?.endpointId, args?.file));
  ipcMain.handle('sip:media-stop', async (_e, args: { endpointId: string; engine?: string }) => getSipSidecar(engineOf(args)).mediaStop(args?.endpointId));
  ipcMain.handle('sip:send-dtmf', async (_e, args: { endpointId: string; digit: string; engine?: string }) => getSipSidecar(engineOf(args)).sendDtmf(args?.endpointId, args?.digit));
  ipcMain.handle('sip:set-audio-devices', (_e, args: { input?: string; output?: string; engine?: string }) => { getSipSidecar(engineOf(args)).setAudioDevices(args?.input, args?.output); return { ok: true }; });
  ipcMain.handle('sip:set-account-audio-devices', (_e, args: { endpointId: string; input?: string; output?: string; engine?: string }) => {
    getSipSidecar(engineOf(args)).setAccountAudioDevices(args?.endpointId, args?.input, args?.output);
    return { ok: true };
  });
  ipcMain.handle('sip:set-account-volume', (_e, args: { endpointId: string; mic: number; speaker: number; engine?: string }) => {
    getSipSidecar(engineOf(args)).setAccountVolume(args?.endpointId, args?.mic, args?.speaker);
    return { ok: true };
  });
  ipcMain.handle('sip:list-audio-devices', (_e, args: any) => { getSipSidecar(engineOf(args)).listAudioDevices(); return { ok: true }; });
  ipcMain.handle('sip:volume', (_e, args: { mic: number; speaker: number; engine?: string }) => { getSipSidecar(engineOf(args)).setVolume(Number(args?.mic), Number(args?.speaker)); return { ok: true }; });
  ipcMain.handle('sip:dnd', (_e, args: { endpointId: string; dnd: boolean; engine?: string }) => { getSipSidecar(engineOf(args)).setDnd(args?.endpointId, !!args?.dnd); return { ok: true }; });
  ipcMain.handle('sip:im', async (_e, args: { endpointId: string; target: string; text: string; engine?: string }) => getSipSidecar(engineOf(args)).sendIm(args?.endpointId, args?.target, args?.text));
  ipcMain.handle('sip:presence', (_e, args: { endpointId: string; online: boolean; engine?: string }) => { getSipSidecar(engineOf(args)).setPresence(args?.endpointId, !!args?.online); return { ok: true }; });
  ipcMain.handle('sip:subscribe', (_e, args: { endpointId: string; target: string; subscribe: boolean; engine?: string }) => { getSipSidecar(engineOf(args)).subscribePresence(args?.endpointId, args?.target, !!args?.subscribe); return { ok: true }; });
}

// ── MicroSIP 단말별 패킷 캡처 (dumpcap.exe, 로컬 설치 필요) ──
{
  const capture = getCaptureManager();
  ipcMain.handle('capture:available', () => isCaptureAvailable());
  ipcMain.handle('capture:list-interfaces', () => listCaptureInterfaces());
  ipcMain.handle('capture:pick-folder', async () => {
    if (!mainWindow) return { canceled: true };
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, dir: result.filePaths[0] };
  });
  ipcMain.handle('capture:start', (_e, args: { endpointId: string; label: string; iface: string; dir: string }) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(args?.label || args?.endpointId || 'endpoint').replace(/[\\/:*?"<>|]/g, '_');
    const outPath = path.join(args?.dir || '', `${safeLabel}_${stamp}.pcap`);
    return capture.start(args?.endpointId, args?.iface, outPath);
  });
  ipcMain.handle('capture:stop', (_e, args: { endpointId: string }) => capture.stop(args?.endpointId));
  ipcMain.handle('capture:status', (_e, args: { endpointId: string }) => capture.status(args?.endpointId));
}

// ── SIPp 워크스페이스 (네이티브 SIPp 부하 발생기) 제어 ──
{
  // 탭마다 독립된 sipp.exe 인스턴스 — id 는 렌더러의 워크스페이스 탭 id.
  // 이벤트에 sippId 를 실어 보내야 렌더러가 "내 탭 것"만 골라 처리할 수 있다
  // (브로드캐스트는 모든 창에 나가지만, sippId 로 각 SippWorkspace 컴포넌트가 필터링).
  const sippListenerAttached = new Set<string>();
  function sippFor(id: string) {
    const inst = getSippSidecar(id);
    if (!sippListenerAttached.has(id)) {
      sippListenerAttached.add(id);
      inst.on('event', (payload: any) => {
        for (const w of BrowserWindow.getAllWindows()) {
          try { if (!w.isDestroyed()) w.webContents.send('sipp:event', { ...payload, sippId: id }); } catch {}
        }
      });
    }
    return inst;
  }
  ipcMain.handle('sipp:status', (_e, args: { id: string }) => sippFor(args?.id).status());
  ipcMain.handle('sipp:start', (_e, args: { id: string; opts: SippTestOptions }) => sippFor(args?.id).start(args?.opts));
  ipcMain.handle('sipp:stop', (_e, args: { id: string }) => sippFor(args?.id).stop());
  ipcMain.handle('sipp:set-rate', (_e, args: { id: string; cps: number }) => sippFor(args?.id).setRate(Number(args?.cps)));
  ipcMain.handle('sipp:set-paused', (_e, args: { id: string; paused: boolean }) => sippFor(args?.id).setPaused(!!args?.paused));
  ipcMain.handle('sipp:dispose', (_e, args: { id: string }) => {
    disposeSippSidecar(args?.id);
    sippListenerAttached.delete(args?.id);
    return { ok: true };
  });

  // 저장된 시나리오(블록 조립/고급 XML) 목록 관리
  ipcMain.handle('sipp-scenario:list', () => loadSippScenarios());
  ipcMain.handle('sipp-scenario:save', (_e, args: { id?: string; name: string; mode: 'blocks' | 'xml'; blocksData?: any; rawXml?: string; targetSettings?: any; injectionCsv?: string }) => saveSippScenario(args));
  ipcMain.handle('sipp-scenario:delete', (_e, args: { id: string }) => { deleteSippScenario(args?.id); return { ok: true }; });
}
// 브라우저 webview 의 프록시 설정 — SSH SOCKS 프록시 경유(점프된 서버에서 같은 로컬망 웹서버 접속) / 직접 연결 전환.
ipcMain.handle('browser:set-proxy', async (_e, args: { webContentsId: number; proxyRules: string | null; proxyBypassRules?: string }) => {
  try {
    const wc = webContents.fromId(args.webContentsId);
    if (!wc) return { success: false, error: 'webContents not found' };
    const session = wc.session;
    if (!session) return { success: false, error: 'session not found' };
    if (!args.proxyRules) {
      await session.setProxy({ mode: 'direct' });
      try { await session.closeAllConnections?.(); } catch {}
      return { success: true };
    }
    // 점프 경유로 "원격지 기준 127.0.0.1/localhost" 에 접속하려면 그 주소도 프록시를 타야 하므로,
    // 호출 측이 빈 문자열(또는 미지정)을 주면 bypass 없이 모든 트래픽을 SOCKS 로 보낸다.
    const proxyBypassRules = typeof args.proxyBypassRules === 'string' ? args.proxyBypassRules : 'localhost,127.0.0.1,::1';
    await session.setProxy({ mode: 'fixed_servers', proxyRules: args.proxyRules, proxyBypassRules });
    try { await session.closeAllConnections?.(); } catch {}
    return { success: true };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
ipcMain.handle('browser:resize-guest', async (_e, args: { webContentsId: number; width: number; height: number }) => {
  try {
    const wc: any = webContents.fromId(args.webContentsId);
    if (!wc) return { success: false, error: 'webContents not found' };
    const width = Math.max(1, Math.floor(Number(args?.width || 0)));
    const height = Math.max(1, Math.floor(Number(args?.height || 0)));
    wc.setSize?.({ normal: { width, height } });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
// 브라우저 워크스페이스 <webview> 게스트의 WebContents(EventEmitter) 리스너 한도를 넉넉히
// 올린다 — dev 환경에서 Vite Fast Refresh 로 렌더러의 리스너-바인딩 effect 가 정리 없이
// 반복 실행될 수 있어 MaxListenersExceededWarning 노이즈가 뜨는 걸 막기 위함.
ipcMain.handle('browser:bump-max-listeners', (_e, args: { webContentsId: number }) => {
  try {
    const wc: any = webContents.fromId(args?.webContentsId);
    wc?.setMaxListeners?.(50);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
// 활성 SSH 세션 목록 (브라우저 서버 선택 드롭다운용 — browserUrl 포함).
ipcMain.handle('ssh:list-active-sessions', () => {
  try {
    const bridge: any = getSSHBridge();
    return bridge.listActiveSessions?.() || [];
  } catch {
    return [];
  }
});
// SSH 세션 위에 SOCKS5 프록시 오픈 — 브라우저 트래픽을 점프된 SSH 장비 경유로 전송.
ipcMain.handle('ssh:open-socks-proxy', async (_e, args: { panelId: string }) => {
  try {
    const bridge: any = getSSHBridge();
    const r = await bridge.openSocksProxy?.(args.panelId);
    return { success: !!r, ...(r || {}) };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
ipcMain.handle('ssh:close-socks-proxy', (_e, args: { proxyId: string }) => {
  try {
    const bridge: any = getSSHBridge();
    const ok = bridge.closeSocksProxy?.(args.proxyId);
    return { success: !!ok };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
// 선택한 SSH 세션을 통해 대상 URL 도달 가능 여부 테스트.
ipcMain.handle('ssh:test-web-target', async (_e, args: { panelId: string; url: string }) => {
  try {
    const bridge: any = getSSHBridge();
    const raw = String(args.url || '').trim();
    if (!raw) return { success: false, error: 'URL이 비어 있습니다' };
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: 'http/https URL만 테스트할 수 있습니다' };
    }
    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
    const result = await bridge.testWebTarget?.(args.panelId, {
      protocol: parsed.protocol,
      host: parsed.hostname,
      port,
      path,
      timeoutMs: 10000,
    });
    return { success: true, result };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('ssh:connect', (_e, { panelId, sessionId, cols, rows }) => {
  if (connectingPanels.has(panelId)) return 'already';
  if (hasLiveSshPanel(panelId)) return 'already';

  const session = sessionsData.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('Session not found');

  // 비밀번호가 비어있으면 renderer에 비밀번호 요청
  const needsPassword = !session.auth || (session.auth.type === 'password' && !session.auth.password);
  if (needsPassword) {
    return 'need-password';
  }

  connectingPanels.add(panelId);

  const bridge = getSSHBridge();
  bridge.handleConnect(panelId, session, cols, rows);
  return 'ok';
});

ipcMain.handle('ssh:connect-with-password', (_e, { panelId, sessionId, password, cols, rows }) => {
  if (connectingPanels.has(panelId)) return 'already';
  if (hasLiveSshPanel(panelId)) return 'already';
  const session = sessionsData.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('Session not found');
  connectingPanels.add(panelId);
  const bridge = getSSHBridge();
  // 임시로 비밀번호를 설정해서 연결
  const sessionWithPw = { ...session, auth: { type: 'password' as const, password } };
  bridge.handleConnect(panelId, sessionWithPw, cols, rows);
  return 'ok';
});

ipcMain.handle('ssh:quick-connect', (_e, { panelId, session, cols, rows }) => {
  if (connectingPanels.has(panelId)) return 'already';
  if (hasLiveSshPanel(panelId)) return 'already';
  if (!session || !session.host) throw new Error('Invalid session');
  // username 이나 비밀번호가 비어있으면 renderer 에 자격증명 요청
  if (!session.username) return 'need-credentials';
  const needsPassword = !session.auth || (session.auth.type === 'password' && !session.auth.password);
  if (needsPassword) return 'need-password';

  connectingPanels.add(panelId);
  const bridge = getSSHBridge();
  bridge.handleConnect(panelId, session, cols, rows);
  return 'ok';
});

ipcMain.handle('ssh:is-connected', (_e, panelId: string) => {
  return hasLiveSshPanel(panelId);
});

// 텔넷(raw TCP) 접속 — 접근통제 솔루션의 로컬 평문 프록시(127.0.0.1:port) 용.
ipcMain.handle('telnet:connect', (_e, { panelId, host, port, cols, rows, encoding }: { panelId: string; host: string; port: number; cols?: number; rows?: number; encoding?: string }) => {
  if (connectingPanels.has(panelId) || connectedPanels.has(panelId)) return 'already';
  if (!host || !port) throw new Error('Invalid telnet target');
  connectingPanels.add(panelId);
  telnetPanels.add(panelId);
  getTelnetBridge().connect(panelId, host, port, cols, rows, encoding);
  return 'ok';
});

// 렌더러가 지금 실제로 화면에 보여주고 있는 패널을 알려줌 — queueTermData 배치 주기 조절용.
ipcMain.on('term:set-visibility', (_e, { panelId, visible }: { panelId: string; visible: boolean }) => {
  if (!panelId) return;
  if (visible) visiblePanelIds.add(panelId);
  else visiblePanelIds.delete(panelId);
});

ipcMain.on('ssh:input', (_e, { panelId, data, b64 }) => {
  if (telnetPanels.has(panelId)) { getTelnetBridge().input(panelId, data, b64); return; }
  getSSHBridge().handleInput(panelId, data, b64);
});

ipcMain.on('ssh:disconnect', (_e, { panelId }) => {
  if (telnetPanels.has(panelId)) {
    telnetPanels.delete(panelId);
    connectedPanels.delete(panelId);
    connectingPanels.delete(panelId);
    getTelnetBridge().disconnect(panelId);
    return;
  }
  connectedPanels.delete(panelId);
  connectingPanels.delete(panelId);
  getSSHBridge().handleDisconnect(panelId);
  try { disposeAiMirrorPanel(panelId); } catch {}
  termBroadcast('ssh:closed', { panelId });
  if (webdavBridge) {
    try { webdavBridge.unregisterSession(panelId); } catch {}
  }
});

const _lastSshResize = new Map<string, { cols: number; rows: number }>();
ipcMain.on('ssh:resize', (_e, { panelId, cols, rows, force }: { panelId: string; cols: number; rows: number; force?: boolean }) => {
  if (!cols || !rows || !isFinite(cols) || !isFinite(rows) || cols < 1 || rows < 1) return;
  const last = _lastSshResize.get(panelId);
  // force 가 명시되면 dedup 우회 (vim 등 alt-buffer 진입 시 PTY 사이즈 재동기화)
  if (!force && last && last.cols === cols && last.rows === rows) return;
  _lastSshResize.set(panelId, { cols, rows });
  if (telnetPanels.has(panelId)) { getTelnetBridge().resize(panelId, cols, rows); return; }
  getSSHBridge().handleResize(panelId, cols, rows);
});

ipcMain.handle('ssh:set-encoding', (_e, { panelId, encoding }) => {
  if (telnetPanels.has(panelId)) return getTelnetBridge().setEncoding(panelId, encoding);
  return getSSHBridge().setEncoding(panelId, encoding);
});

ipcMain.handle('ssh:set-auto-track', (_e, { panelId, enabled }: { panelId: string; enabled: boolean }) => {
  return getSSHBridge().setAutoTrack(panelId, !!enabled);
});

ipcMain.handle('ssh:get-encoding', (_e, panelId: string) => {
  return getSSHBridge().getEncoding(panelId);
});

// ── Local Shell (node-pty) ──
const ptyProcesses = new Map<string, pty.IPty>();

// 앱 종료 직전 — PTY/Claude 자식 프로세스 일괄 정리. (SSH/X11 정리는 위쪽 핸들러)
app.on('before-quit', () => {
  for (const proc of ptyProcesses.values()) { try { proc.kill(); } catch {} }
  ptyProcesses.clear();
  for (const proc of claudeProcesses.values()) {
    try {
      if (process.platform === 'win32') {
        require('child_process').spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
      } else {
        proc.kill('SIGTERM');
      }
    } catch {}
  }
  claudeProcesses.clear();
  for (const proc of geminiProcesses.values()) {
    try {
      if (process.platform === 'win32') {
        require('child_process').spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
      } else {
        proc.kill('SIGTERM');
      }
    } catch {}
  }
  geminiProcesses.clear();
  for (const proc of codexProcesses.values()) {
    try {
      if (process.platform === 'win32') {
        require('child_process').spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
      } else {
        proc.kill('SIGTERM');
      }
    } catch {}
  }
  codexProcesses.clear();
});

let shellsCache: { name: string; path: string; icon?: string }[] | null = null;
ipcMain.handle('pty:list-shells', async () => {
  if (shellsCache) return shellsCache;
  const shells: { name: string; path: string; icon?: string }[] = [];
  if (process.platform === 'win32') {
    shells.push({ name: 'Windows PowerShell', path: 'powershell.exe', icon: '⚡' });
    const pwshPaths = [
      path.join(process.env.ProgramFiles || '', 'PowerShell', '7', 'pwsh.exe'),
      path.join(process.env.ProgramFiles || '', 'PowerShell', '6', 'pwsh.exe'),
    ];
    for (const p of pwshPaths) {
      try { fs.accessSync(p); shells.push({ name: 'PowerShell Core', path: p, icon: '⚡' }); break; } catch {}
    }
    shells.push({ name: 'CMD', path: 'cmd.exe', icon: '▪' });
    const gitBashPaths = [
      path.join(process.env.ProgramFiles || '', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Git', 'bin', 'bash.exe'),
      'C:\\Program Files\\Git\\bin\\bash.exe',
    ];
    for (const p of gitBashPaths) {
      try { fs.accessSync(p); shells.push({ name: 'Git Bash', path: p, icon: '' }); break; } catch {}
    }
    try { fs.accessSync('C:\\Windows\\System32\\wsl.exe'); shells.push({ name: 'WSL', path: 'wsl.exe', icon: '🐧' }); } catch {}
  } else {
    const sh = process.env.SHELL || '/bin/bash';
    shells.push({ name: 'Default Shell', path: sh });
    if (sh !== '/bin/bash') try { fs.accessSync('/bin/bash'); shells.push({ name: 'Bash', path: '/bin/bash' }); } catch {}
    if (sh !== '/bin/zsh') try { fs.accessSync('/bin/zsh'); shells.push({ name: 'Zsh', path: '/bin/zsh' }); } catch {}
  }
  shellsCache = shells;
  return shells;
});

// node-pty 의 spawn-helper(macOS/Linux) 가 asar.unpacked 에 unpack 되었지만 실행권한이 빠질 수 있음 → 매 spawn 직전에 검사 + chmod.
function ensurePtyHelperExecutable() {
  if (process.platform === 'win32') return;
  try {
    let dir: string;
    try { dir = path.dirname(require.resolve('node-pty/package.json')); }
    catch { dir = path.join(__dirname, '..', 'node_modules', 'node-pty'); }
    dir = dir.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep).replace('app.asar/', 'app.asar.unpacked/');
    const helper = path.join(dir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (fs.existsSync(helper)) {
      const st = fs.statSync(helper);
      if (!(st.mode & 0o111)) { fs.chmodSync(helper, 0o755); console.log('[pty] chmod +x', helper); }
    } else {
      console.warn('[pty] spawn-helper not found at', helper);
    }
  } catch (e: any) { console.warn('[pty] chmod helper failed:', e?.message || e); }
}

// 셸 별 OSC 7 cwd hook 을 spawn 인자로 주입 — 사용자에게 echo 되지 않음.
// zsh 의 경우 임시 ZDOTDIR 를 만들어 두고, 호출 측에서 env.ZDOTDIR 로 주입해야 함 (zdotdir 필드 반환).
// WSL 등 인자로 주입 불가한 케이스는 postSpawnInject 로 첫 프롬프트 후 stdin 주입.
function buildShellLaunch(shellPath: string): { args: string[]; postSpawnInject?: string; zdotdir?: string; promptEnv?: string } {
  const lc = shellPath.toLowerCase();
  // PowerShell (Windows PowerShell 5.1 / pwsh 7+) — [char]27 사용해 호환
  // -Command 는 배너를 자동 억제하므로, 배너를 직접 Write-Host 로 출력 + OSC 7 hook 을 silently 설치.
  // 이 방식은 stdin 주입이 없어서 에코가 전혀 발생하지 않음.
  if (lc.includes('powershell') || lc.includes('pwsh')) {
    const banner = "if ($PSVersionTable.PSEdition -eq 'Desktop') { Write-Host 'Windows PowerShell'; Write-Host 'Copyright (C) Microsoft Corporation. All rights reserved.'; Write-Host ''; if ((Get-UICulture).Name -like 'ko*') { Write-Host '새로운 기능 및 개선 사항에 대 한 최신 PowerShell을 설치 하세요! https://aka.ms/PSWindows' } else { Write-Host 'Try the new cross-platform PowerShell https://aka.ms/pscore6' }; Write-Host '' } else { Write-Host ('PowerShell ' + $PSVersionTable.PSVersion); Write-Host '' }";
    const psHook = "if (-not $global:__pepePromptOrig) { $global:__pepePromptOrig = $function:prompt }; function global:prompt { [Console]::Write([char]27 + ']7;file:///' + ($PWD.Path -replace '\\\\','/') + [char]27 + '\\'); & $global:__pepePromptOrig }";
    return { args: ['-NoExit', '-Command', `${banner}; ${psHook}`] };
  }
  // cmd.exe — PROMPT 환경변수로 프롬프트 형식 설정. /K prompt 명령 방식은 명령 실행 후
  // 빈 줄(\r\n)이 생기므로 사용 안 함. 환경변수는 호출 측 spawnEnv 에서 직접 주입.
  if (lc.endsWith('cmd.exe') || lc.endsWith('\\cmd') || lc.endsWith('/cmd')) {
    return { args: [], promptEnv: '$E]7;file:///$P$E\\$P$G' };
  }
  // wsl.exe 진입은 인자로 inner shell init 주입 불가 → 첫 프롬프트 후 stdin 주입 fallback.
  if (lc.endsWith('wsl.exe') || lc.endsWith('\\wsl') || lc.endsWith('/wsl')) {
    const bashHook = " __pepe_osc7() { printf '\\e]7;file://localhost%s\\e\\\\' \"$PWD\"; }; PROMPT_COMMAND=\"__pepe_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"";
    return { args: [], postSpawnInject: bashHook };
  }
  // bash (git bash / Linux / macOS) — --init-file 로 임시 rc 사용 (사용자 .bashrc 도 source).
  // 주의: --init-file 은 non-login interactive 에서만 ~/.bashrc 자리를 대체. -l 과 함께 쓰면 무시되므로 login 모드는 사용 안 함.
  if (lc.includes('bash') || lc.endsWith('/sh') || lc.endsWith('\\sh.exe')) {
    try {
      const tmpDir = os.tmpdir();
      const rcPath = path.join(tmpDir, `pepe-bashrc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`);
      const rcContent = [
        '# pepe-terminal: source user rc files first',
        '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
        '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
        // macOS bash 사용자는 보통 ~/.bash_profile 만 두므로 그것도 시도
        '[ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile"',
        '# pepe cwd auto-track (OSC 7)',
        "__pepe_osc7() { printf '\\e]7;file://localhost%s\\e\\\\' \"$PWD\"; }",
        'PROMPT_COMMAND="__pepe_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
      ].join('\n');
      fs.writeFileSync(rcPath, rcContent, 'utf8');
      return { args: ['--init-file', rcPath] };
    } catch {
      return { args: [] };
    }
  }
  // zsh — ZDOTDIR 를 임시 디렉토리로 바꿔 .zshrc 에 hook 주입. 호출 측에서 env.ZDOTDIR 설정 필수.
  if (lc.includes('zsh')) {
    try {
      const tmpDir = os.tmpdir();
      const dirPath = path.join(tmpDir, `pepe-zdotdir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      fs.mkdirSync(dirPath, { recursive: true });
      const userZdotdir = process.env.ZDOTDIR || process.env.HOME || '';
      const rcContent = [
        '# pepe-terminal: source user .zshrc',
        userZdotdir ? `ZDOTDIR='${userZdotdir}' . '${userZdotdir}/.zshrc' 2>/dev/null` : '',
        '# pepe cwd auto-track (OSC 7)',
        "__pepe_osc7() { printf '\\e]7;file://localhost%s\\e\\\\' \"$PWD\"; }",
        'precmd_functions+=(__pepe_osc7)',
      ].filter(Boolean).join('\n');
      fs.writeFileSync(path.join(dirPath, '.zshrc'), rcContent, 'utf8');
      return { args: [], zdotdir: dirPath };
    } catch {
      return { args: [] };
    }
  }
  return { args: [] };
}

ipcMain.handle('pty:spawn', (_e, { panelId, shell: shellPath, cols, rows, cwd }: { panelId: string; shell?: string; cols?: number; rows?: number; cwd?: string }) => {
  if (ptyProcesses.has(panelId)) return 'already';
  ensurePtyHelperExecutable();
  // OS 별 기본 셸 결정. GUI 앱은 SHELL 환경변수 미설정인 경우가 있어 darwin 은 /bin/zsh, linux 는 /bin/bash 로 폴백.
  const isWin = process.platform === 'win32';
  const isDarwin = process.platform === 'darwin';
  let sh = shellPath;
  if (!sh) {
    if (isWin) sh = 'powershell.exe';
    else if (isDarwin) sh = process.env.SHELL || '/bin/zsh';
    else sh = process.env.SHELL || '/bin/bash';
  }
  // 셸별 OSC 7 hook 인자 — bash 는 --init-file, zsh 는 ZDOTDIR(env), powershell/cmd 는 -Command/-K, 기타는 빈 args
  const launch = buildShellLaunch(sh);
  const baseName = (sh.split('/').pop() || sh).toLowerCase();
  const isUnixShell = !isWin && /^(zsh|bash|sh|fish|ksh|dash)$/.test(baseName);
  const spawnEnv: Record<string, string> = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>;
  if (isUnixShell) spawnEnv.SHELL = sh;
  if (!spawnEnv.HOME && process.env.USERPROFILE) spawnEnv.HOME = process.env.USERPROFILE;
  // zsh 는 임시 ZDOTDIR 를 환경변수로 주입해야 OSC 7 hook 적용됨
  if (launch.zdotdir) spawnEnv.ZDOTDIR = launch.zdotdir;
  // cmd.exe: PROMPT 환경변수로 OSC 7 프롬프트 형식 설정 (/K prompt 명령 없이)
  if (launch.promptEnv) spawnEnv.PROMPT = launch.promptEnv;
  const spawnCwd = cwd || spawnEnv.HOME || process.env.HOME || process.env.USERPROFILE || (isWin ? 'C:\\' : '/');
  console.log('[pty:spawn]', { panelId, sh, args: launch.args, cwd: spawnCwd, hasShellEnv: !!process.env.SHELL });
  const trySpawn = (shellPath: string, shellArgs: string[]): pty.IPty | Error => {
    try {
      return pty.spawn(shellPath, shellArgs, {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: spawnCwd,
        env: spawnEnv,
      });
    } catch (e: any) { return e; }
  };
  let proc = trySpawn(sh, launch.args);
  // ENOENT 등으로 실패 시 macOS/Linux 기본 셸로 재시도 (이때는 OSC 7 hook 없이라도 우선 살림)
  if (proc instanceof Error && !isWin) {
    console.warn('[pty:spawn] first attempt failed:', proc.message, '— falling back to /bin/zsh');
    const fbLaunch = buildShellLaunch('/bin/zsh');
    if (fbLaunch.zdotdir) spawnEnv.ZDOTDIR = fbLaunch.zdotdir;
    const fb = trySpawn('/bin/zsh', fbLaunch.args);
    if (!(fb instanceof Error)) proc = fb;
    else {
      const fb2Launch = buildShellLaunch('/bin/bash');
      const fb2 = trySpawn('/bin/bash', fb2Launch.args);
      if (!(fb2 instanceof Error)) proc = fb2;
    }
  }
  if (proc instanceof Error) {
    console.error('[pty:spawn] all attempts failed:', proc.message);
    termBroadcast('pty:data', { panelId, data: `\r\n[shell spawn 실패] ${proc.message}\r\n` });
    return 'error';
  }
  ptyProcesses.set(panelId, proc);
  proc.onData((data: string) => {
    queueTermData('pty:data', panelId, data);
  });
  proc.onExit(({ exitCode }: { exitCode: number }) => {
    ptyProcesses.delete(panelId);
    termBroadcast('pty:exit', { panelId, exitCode });
  });
  // wsl.exe 등 인자 주입 불가 셸: 첫 프롬프트 후 stdin 으로 hook 주입
  if (launch.postSpawnInject) {
    setTimeout(() => {
      try { proc.write(launch.postSpawnInject + '\r'); } catch {}
    }, 1500);
  }
  return 'ok';
});

ipcMain.on('pty:input', (_e, { panelId, data }: { panelId: string; data: string }) => {
  ptyProcesses.get(panelId)?.write(data);
});

const _lastPtyResize = new Map<string, { cols: number; rows: number }>();
ipcMain.on('pty:resize', (_e, { panelId, cols, rows }: { panelId: string; cols: number; rows: number }) => {
  if (!cols || !rows || !isFinite(cols) || !isFinite(rows) || cols < 1 || rows < 1) return;
  const last = _lastPtyResize.get(panelId);
  if (last && last.cols === cols && last.rows === rows) return;
  _lastPtyResize.set(panelId, { cols, rows });
  try { ptyProcesses.get(panelId)?.resize(cols, rows); } catch {}
});

ipcMain.on('pty:kill', (_e, { panelId }: { panelId: string }) => {
  const proc = ptyProcesses.get(panelId);
  if (proc) { proc.kill(); ptyProcesses.delete(panelId); }
});

// ── i18n ──
ipcMain.handle('i18n:list-languages', () => listLanguages());
ipcMain.handle('i18n:list-namespaces', (_e, { lang }: { lang: string }) => listNamespaces(lang));
ipcMain.handle('i18n:load', (_e, { lang, ns }: { lang: string; ns: string }) => loadNamespace(lang, ns));
ipcMain.handle('i18n:load-bundled', (_e, { lang, ns }: { lang: string; ns: string }) => loadBundledNamespace(lang, ns));
ipcMain.handle('i18n:load-override', (_e, { lang, ns }: { lang: string; ns: string }) => loadOverrideNamespace(lang, ns));
ipcMain.handle('i18n:save-override', (_e, { lang, ns, kv }: { lang: string; ns: string; kv: Record<string, string> }) => saveOverrideNamespace(lang, ns, kv));
ipcMain.handle('i18n:add-language', (_e, { lang }: { lang: string }) => addLanguage(lang));
ipcMain.handle('i18n:remove-language', (_e, { lang }: { lang: string }) => removeLanguage(lang));
ipcMain.handle('i18n:set-lang', (_e, { lang }: { lang: string }) => { setCurrentLang(lang); return { ok: true }; });
// AI 자동 번역 — Anthropic Claude API. ko 기준으로 target 언어로 번역. 빈 값/혹은 전체 강제 갱신.
// API 키 우선순위: 인자로 받은 키 > 환경변수 ANTHROPIC_API_KEY
ipcMain.handle('i18n:auto-translate', async (_e, { sourceLang, targetLang, items, apiKey }: { sourceLang: string; targetLang: string; items: Record<string, string>; apiKey?: string }) => {
  const key = (apiKey || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY 환경변수가 없거나 빈 값입니다 (또는 인자로 전달)' };
  const keys = Object.keys(items);
  if (keys.length === 0) return { ok: true, translations: {} };
  // 키-값 쌍 JSON 으로 만들어 Claude 에게 줌. {{var}} 자리표시자는 보존 요구.
  const prompt = `다음 ${sourceLang} 번역 키-값 JSON 을 ${targetLang} 로 번역해 주세요. 규칙:
- 출력은 정확히 같은 키를 갖는 JSON 객체 1개만 (설명/마크다운 코드블럭 없이 순수 JSON).
- 값만 ${targetLang} 로 번역. 키는 그대로.
- {{변수}} 같은 자리표시자는 변형 없이 그대로 유지.
- 이모지/특수문자는 유지.
- 짧고 자연스러운 UI 문구로.

입력 JSON:
${JSON.stringify(items, null, 2)}`;
  try {
    const resp = await (globalThis as any).fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return { ok: false, error: `API ${resp.status}: ${errText.slice(0, 300)}` };
    }
    const data: any = await resp.json();
    const text: string = data?.content?.[0]?.text || '';
    // 응답이 마크다운 코드블럭 안에 있을 수도 있음 — 추출
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, error: '응답에서 JSON 을 찾지 못함', raw: text.slice(0, 300) };
    let translations: Record<string, string>;
    try {
      translations = JSON.parse(match[0]);
    } catch (e: any) {
      return { ok: false, error: 'JSON 파싱 실패: ' + e.message, raw: match[0].slice(0, 300) };
    }
    return { ok: true, translations };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// office-editor/rhwp-studio/flowchart-editor 는 오피스 워크스페이스가 함께 쓰는 3개 대용량
// 정적 번들(pepeapp:// 핸들러가 resourcesPath 에서 직접 서빙 — electron/main.ts 상단 참고).
// 셋 다 설치 시 "오피스" 체크박스 하나로 같이 설치/삭제되므로 대표로 office-editor 만 확인한다.
function officeBundleAvailable(): boolean {
  try {
    const base = app.isPackaged ? path.join(process.resourcesPath, 'office-editor') : path.join(process.cwd(), 'resources', 'office-editor');
    return fs.existsSync(path.join(base, 'editor.html'));
  } catch { return false; }
}

// 설치 시 선택 해제한 기능(build/installer.nsh 참고 — 각 사이드카/번들 폴더가 통째로 빠질 수
// 있다)의 메뉴 항목을 렌더러에서 숨기기 위한 가용성 체크. 파일 존재 여부만 실시간으로 보고,
// 설치 시점 값을 어딘가 저장해두지 않는다 — 나중에 사용자가 폴더를 수동으로 넣거나 빼도 항상
// 실제 상태와 일치한다.
//
// SSW 소프트폰은 예외 — MicroSIP과 완전히 독립된 sipd.exe 프로세스로 뜨지만(getSipSidecar('ssw'),
// sipSidecar.ts), 설치 파일(sip-sidecar-win-x64.zip)은 하나만 번들되어 같은 바이너리를 공유한다.
// 그래서 파일 존재만으로는 "MicroSIP만 설치했나 / SSW만 설치했나"를 구분할 수 없다. installer.nsh가
// 설치 시 사용자의 SSW 체크박스 선택을 레지스트리(HKCU\Software\PePeTerminal\Features\SswPhone)에
// 별도로 저장해두므로, 그 값을 읽어 UI 노출 여부를 독립적으로 판단한다.
function readSswPhoneFeatureFlag(): boolean {
  if (process.platform !== 'win32') return true;
  try {
    const out = execSync('reg query "HKCU\\Software\\PePeTerminal\\Features" /v SswPhone', { stdio: 'pipe' }).toString();
    const m = out.match(/SswPhone\s+REG_SZ\s+(\S+)/);
    if (!m) return true;
    return m[1] === '1';
  } catch {
    return true; // 레지스트리 값 없음(구버전 설치 등) — 기본 노출
  }
}

ipcMain.handle('features:get-available', () => ({
  vpn: !!getVpnService().binaryPath(),
  microsip: !!resolveSipdBinary(),
  sswPhone: !!resolveSipdBinary() && readSswPhoneFeatureFlag(),
  sipp: !!resolveSippBinary(),
  office: officeBundleAvailable(),
  media: !!resolveGstreamerBinary(),
}));

// ── OpenVPN ──
const vpn = getVpnService();
const safeSend = (channel: string, payload: any) => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed?.()) return;
    wc.send(channel, payload);
  } catch {}
};
vpn.on('state', (st: any) => safeSend('vpn:state', st));
vpn.on('log', (line: string) => safeSend('vpn:log', line));
vpn.on('passwordRequired', (line: string) => safeSend('vpn:password-required', line));
vpn.on('authFailed', (line: string) => safeSend('vpn:auth-failed', line));
// 앱 종료 시 VPN 정리 — management SIGTERM 보내서 elevated openvpn.exe 가 스스로 깔끔히 종료하도록
app.on('before-quit', () => {
  try { vpn.disconnect(); } catch {}
});

// 자격증명 영속화 — OS 안전 저장소(Windows DPAPI / macOS Keychain) 로 암호화 후 JSON 저장.
// 파일: <userData>/vpn-credentials.json. Key = config 절대경로, Value = base64(encrypted).
function vpnCredsFile(): string { return path.join(app.getPath('userData'), 'vpn-credentials.json'); }
// 진단 로그 — renderer DevTools console 에 [main] 프리픽스로 표시됨
function credsLog(msg: string) {
  console.log('[vpn-creds]', msg);
  try { mainWindow?.webContents.send('debug:log', `[vpn-creds] ${msg}`); } catch {}
}
function loadCredsMap(): Record<string, string> {
  try {
    const p = vpnCredsFile();
    if (!fs.existsSync(p)) { credsLog(`loadCredsMap: 파일 없음 (${p})`); return {}; }
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) || {};
    credsLog(`loadCredsMap: ${p} (${Object.keys(parsed).length}개 항목, 파일 ${raw.length}바이트)`);
    return parsed;
  } catch (err: any) {
    credsLog(`loadCredsMap 실패: ${err?.message || err}`);
    return {};
  }
}
function saveCredsMap(m: Record<string, string>) {
  const p = vpnCredsFile();
  try {
    const text = JSON.stringify(m, null, 2);
    fs.writeFileSync(p, text, { mode: 0o600 });
    const exists = fs.existsSync(p);
    const size = exists ? fs.statSync(p).size : -1;
    credsLog(`saveCredsMap: ${p} (${text.length}바이트 쓰기 시도, 실제 ${size}바이트, exists=${exists})`);
  } catch (err: any) {
    credsLog(`saveCredsMap 실패: ${err?.message || err}`);
  }
}
ipcMain.handle('vpn:save-creds', (_e, { configPath, username, password }: { configPath: string; username: string; password: string }) => {
  const avail = safeStorage.isEncryptionAvailable();
  credsLog(`save 요청: configPath="${configPath}", user="${username}", pw길이=${password?.length || 0}, isEncryptionAvailable=${avail}`);
  if (!avail) return { ok: false, error: 'OS 안전 저장소 사용 불가 (저장 안 됨)' };
  try {
    const plain = JSON.stringify({ username, password });
    const encBuf = safeStorage.encryptString(plain);
    const enc = encBuf.toString('base64');
    credsLog(`encryptString OK (평문 ${plain.length}바이트 → 암호 ${encBuf.length}바이트, base64 ${enc.length}바이트)`);
    const m = loadCredsMap();
    m[configPath] = enc;
    saveCredsMap(m);
    // 즉시 검증 — write 직후 다시 읽어서 항목 존재 확인
    const verify = loadCredsMap();
    const verifyOk = !!verify[configPath];
    credsLog(`save 검증: 다시 읽었을 때 해당 키 존재=${verifyOk}`);
    return { ok: true };
  } catch (err: any) {
    credsLog(`save 실패: ${err?.message || err}`);
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('vpn:load-creds', (_e, { configPath }: { configPath: string }) => {
  credsLog(`load 요청: configPath="${configPath}"`);
  try {
    const m = loadCredsMap();
    const enc = m[configPath];
    if (!enc) {
      credsLog(`load: 키 없음 (저장된 키: ${Object.keys(m).join(', ') || '없음'})`);
      return { ok: false };
    }
    credsLog(`load: 암호화 데이터 발견 (base64 ${enc.length}바이트), decryptString 시도`);
    const buf = Buffer.from(enc, 'base64');
    const dec = safeStorage.decryptString(buf);
    const parsed = JSON.parse(dec);
    credsLog(`load 성공: user="${parsed.username}", pw길이=${parsed.password?.length || 0}`);
    return { ok: true, username: parsed.username || '', password: parsed.password || '' };
  } catch (err: any) {
    credsLog(`load 실패: ${err?.message || err}`);
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('vpn:clear-creds', (_e, { configPath }: { configPath: string }) => {
  credsLog(`clear 요청: configPath="${configPath}"`);
  try {
    const m = loadCredsMap();
    delete m[configPath];
    saveCredsMap(m);
    return { ok: true };
  } catch (err: any) { return { ok: false, error: String(err?.message || err) }; }
});
ipcMain.handle('vpn:has-creds', (_e, { configPath }: { configPath: string }) => {
  const m = loadCredsMap();
  const has = !!m[configPath];
  credsLog(`has 요청: configPath="${configPath}" → ${has}`);
  return { has };
});

type BrowserCredRecord = {
  siteKey: string;
  username: string;
  password: string;
  updatedAt: number;
};

function browserCredsFile(): string { return path.join(app.getPath('userData'), 'browser-credentials.json'); }
function browserCredsLog(msg: string) {
  console.log('[browser-creds]', msg);
  try { mainWindow?.webContents.send('debug:log', `[browser-creds] ${msg}`); } catch {}
}
function loadBrowserCredsMap(): Record<string, BrowserCredRecord> {
  try {
    const p = browserCredsFile();
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return {};
    if (!safeStorage.isEncryptionAvailable()) {
      browserCredsLog('safeStorage unavailable, refusing to read browser creds file');
      return {};
    }
    const dec = safeStorage.decryptString(Buffer.from(raw, 'base64'));
    const parsed = JSON.parse(dec) || {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err: any) {
    browserCredsLog(`load failed: ${err?.message || err}`);
    return {};
  }
}
function saveBrowserCredsMap(m: Record<string, BrowserCredRecord>) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS 안전 저장소 사용 불가');
  const text = JSON.stringify(m, null, 2);
  const enc = safeStorage.encryptString(text).toString('base64');
  fs.writeFileSync(browserCredsFile(), enc, 'utf8');
}
function browserSiteCandidates(input: string): string[] {
  let host = '';
  try {
    const u = new URL(input);
    host = u.hostname.toLowerCase();
    if (u.port && u.port !== '80' && u.port !== '443') host = `${host}:${u.port}`;
  } catch {
    host = String(input || '').trim().toLowerCase();
  }
  if (!host) return [];
  const out = new Set<string>();
  const colonIdx = host.indexOf(':');
  const baseHost = colonIdx >= 0 ? host.slice(0, colonIdx) : host;
  const portSuffix = colonIdx >= 0 ? host.slice(colonIdx) : '';
  const parts = baseHost.split('.').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join('.') + portSuffix;
    out.add(cand);
  }
  out.add(baseHost + portSuffix);
  if (baseHost.startsWith('www.')) out.add(baseHost.slice(4) + portSuffix);
  return Array.from(out);
}
function browserSiteKeyFromUrl(input: string): string {
  const cands = browserSiteCandidates(input);
  return cands[0] || '';
}
function getBrowserCredForUrl(input: string): BrowserCredRecord | null {
  const map = loadBrowserCredsMap();
  for (const key of browserSiteCandidates(input)) {
    const rec = map[key];
    if (rec) return rec;
  }
  return null;
}
ipcMain.handle('browser-creds:get', (_e, { url, siteKey }: { url?: string; siteKey?: string }) => {
  try {
    const target = siteKey?.trim() || url || '';
    if (!target) return { ok: false, found: false };
    const rec = getBrowserCredForUrl(target);
    if (!rec) return { ok: true, found: false };
    return { ok: true, found: true, siteKey: rec.siteKey, username: rec.username || '', password: rec.password || '', updatedAt: rec.updatedAt || 0 };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('browser-creds:save', (_e, { url, siteKey, username, password }: { url?: string; siteKey?: string; username: string; password: string }) => {
  try {
    const key = (siteKey?.trim() || browserSiteKeyFromUrl(url || '')).toLowerCase();
    if (!key) return { ok: false, error: 'siteKey/url 누락' };
    const map = loadBrowserCredsMap();
    map[key] = { siteKey: key, username: username || '', password: password || '', updatedAt: Date.now() };
    saveBrowserCredsMap(map);
    return { ok: true, siteKey: key };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('browser-creds:delete', (_e, { url, siteKey }: { url?: string; siteKey?: string }) => {
  try {
    const key = (siteKey?.trim() || browserSiteKeyFromUrl(url || '')).toLowerCase();
    if (!key) return { ok: false, error: 'siteKey/url 누락' };
    const map = loadBrowserCredsMap();
    delete map[key];
    saveBrowserCredsMap(map);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('browser-creds:list', async () => {
  try {
    const map = loadBrowserCredsMap();
    return {
      ok: true,
      entries: Object.values(map).map(v => ({
        siteKey: v.siteKey,
        username: v.username || '',
        updatedAt: v.updatedAt || 0,
      })),
    };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('vpn:available', () => vpn.isAvailable());
ipcMain.handle('vpn:state', () => vpn.getState());
ipcMain.handle('vpn:logs', () => vpn.getLogs());
ipcMain.handle('vpn:list-configs', () => vpn.listConfigs());
ipcMain.handle('vpn:import-config', async (_e, { srcPath }: { srcPath?: string }) => {
  if (!srcPath) {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: t('dialog.vpnImportTitle'),
      filters: [{ name: 'OpenVPN config', extensions: ['ovpn'] }, { name: 'All Files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    srcPath = r.filePaths[0];
  }
  return vpn.importConfig(srcPath);
});
ipcMain.handle('vpn:remove-config', (_e, { filePath }: { filePath: string }) => ({ ok: vpn.removeConfig(filePath) }));
ipcMain.handle('vpn:connect', (_e, { configPath, username, password }: { configPath: string; username?: string; password?: string }) =>
  vpn.connect(configPath, { username, password }));
ipcMain.handle('vpn:disconnect', () => vpn.disconnect());

// ── 터미널 녹화 (REC) ──
// 렌더러는 term.write() 직전에 tap 을 걸어 raw 바이트와 사용자 입력을 IPC 로 흘려보내고,
// main 은 단순히 WriteStream 으로 append. flush 는 OS 가 알아서 하지만 추가 보호로 매 라인
// 결정마다 fsyncSync 는 하지 않는다 (성능 이슈). 앱 종료/세션 닫기 시 stop 호출 보장 필요.
const recordingStreams: Map<string, { stream: fs.WriteStream; path: string; startedAt: number }> = new Map();
function recPickFilePath(suggested: string): string | null {
  if (!mainWindow) return null;
  const res = dialog.showSaveDialogSync(mainWindow, {
    title: t('dialog.recordingSaveTitle'),
    defaultPath: suggested,
    filters: [{ name: 'Recording Log (ANSI)', extensions: ['log'] }, { name: 'All Files', extensions: ['*'] }],
  });
  return res || null;
}
ipcMain.handle('rec:start', async (_e, { panelId, sessionName }: { panelId: string; sessionName?: string }) => {
  if (recordingStreams.has(panelId)) return { ok: false, reason: 'already-recording' };
  const ts = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  const safeName = (sessionName || 'terminal').replace(/[\\/:*?"<>|]/g, '_');
  const suggested = path.join(app.getPath('documents') || os.homedir(), `pepe-${safeName}-${stamp}.log`);
  const target = recPickFilePath(suggested);
  if (!target) return { ok: false, reason: 'cancelled' };
  try {
    const stream = fs.createWriteStream(target, { flags: 'a' });
    stream.on('error', (err) => {
      try { mainWindow?.webContents.send('rec:error', { panelId, message: String(err?.message || err) }); } catch {}
    });
    const header = `\r\n--- recording started at ${ts.toLocaleString()} (${path.basename(target)}) ---\r\n`;
    stream.write(header);
    recordingStreams.set(panelId, { stream, path: target, startedAt: Date.now() });
    return { ok: true, path: target };
  } catch (err: any) {
    return { ok: false, reason: 'open-failed', message: String(err?.message || err) };
  }
});
// ANSI escape / control sequence stripper — 녹화 파일이 화면과 동일한 plain text 로 보이도록.
// CSI (\x1b[...), OSC (\x1b]...\x07 or \x1b\\), 단일 ESC 시퀀스, 기타 제어문자 (carriage return 제외) 제거.
function stripAnsi(s: string): string {
  if (!s) return s;
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b[@-Z\\-_]/g, '')                       // single-char ESC seq
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')             // CSI
    .replace(/\x1b\([AB012]/g, '');                      // charset designator
}
ipcMain.on('rec:append', (_e, { panelId, data, kind }: { panelId: string; data: string; kind?: 'out' | 'in' | 'mark' }) => {
  const rec = recordingStreams.get(panelId);
  if (!rec) return;
  try {
    // 입력은 별도 기록 안 함 — 셸이 echo 한 문자가 'out' 으로 이미 들어옴 (중복/마커 노이즈 방지)
    if (kind === 'in') return;
    if (kind === 'mark') rec.stream.write(`\r\n--- ${stripAnsi(data)} ---\r\n`);
    else rec.stream.write(stripAnsi(data));
  } catch {}
});
ipcMain.handle('rec:stop', async (_e, { panelId }: { panelId: string }) => {
  const rec = recordingStreams.get(panelId);
  if (!rec) return { ok: false, reason: 'not-recording' };
  recordingStreams.delete(panelId);
  try {
    const footer = `\r\n--- recording stopped at ${new Date().toLocaleString()} ---\r\n`;
    await new Promise<void>(resolve => rec.stream.write(footer, () => resolve()));
    await new Promise<void>(resolve => rec.stream.end(() => resolve()));
    return { ok: true, path: rec.path };
  } catch (err: any) {
    return { ok: false, message: String(err?.message || err) };
  }
});
ipcMain.handle('rec:status', (_e, { panelId }: { panelId?: string }) => {
  if (panelId) {
    const r = recordingStreams.get(panelId);
    return r ? { recording: true, path: r.path, startedAt: r.startedAt } : { recording: false };
  }
  return { panels: Array.from(recordingStreams.keys()) };
});
ipcMain.handle('rec:list-active', () => Array.from(recordingStreams.keys()));
// 앱 종료 시 모든 stream flush — 사용자가 모달에서 "종료" 선택했을 때 데이터 유실 방지
app.on('before-quit', () => {
  for (const [, rec] of recordingStreams) {
    try { rec.stream.write(`\r\n--- recording interrupted (app quit) ---\r\n`); rec.stream.end(); } catch {}
  }
  recordingStreams.clear();
});

// ── Claude Code CLI 연동 ──
const claudeProcesses: Map<string, any> = new Map();

// ── Gemini CLI 연동 ──
const geminiProcesses: Map<string, any> = new Map();

// ── Antigravity CLI(agy) 연동 ──
// Gemini CLI(gemini.cmd) 와 별개 — agy.exe 를 별도 에이전트로 노출.
// Auth 는 agy 자체 OAuth(브라우저). 사용량은 transcript/usage 파일에서 파싱.
const antigravityProcesses: Map<string, any> = new Map();

function findAgyExePath(): string | null {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'));
    if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'));
  }
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  try {
    const { spawnSync } = require('child_process');
    const augmentedPath = buildAugmentedPath();
    const env = { ...process.env, PATH: augmentedPath, Path: augmentedPath };
    const lookup = process.platform === 'win32'
      ? spawnSync('where.exe', ['agy'], { shell: false, encoding: 'utf8', env, windowsHide: true })
      : spawnSync('which', ['agy'], { shell: false, encoding: 'utf8', env });
    const found = String(lookup.stdout || '').split(/\r?\n/).map((s: string) => s.trim()).find(Boolean);
    if (lookup.status === 0 && found) return found;
  } catch {}
  return null;
}

/** agy 로그 파일에서 transcript.jsonl 경로 추출 (conversation id 가 만들어진 뒤에만 가능) */
function getAgyTranscriptPath(logPath: string): string | null {
  try {
    if (!logPath || !fs.existsSync(logPath)) return null;
    const logText = fs.readFileSync(logPath, 'utf8');
    const m = Array.from(logText.matchAll(/(?:Created conversation|Print mode: conversation=)\s*([0-9a-f-]{36})/gi));
    const cid = m.length ? m[m.length - 1][1] : null;
    if (!cid) return null;
    return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', cid,
      '.system_generated', 'logs', 'transcript.jsonl');
  } catch { return null; }
}

/**
 * 모델이 ```mermaid 펜스를 빠뜨리고 raw flowchart 문법을 본문에 흘려보낸 경우 자동 감지/감싸기.
 * - flowchart/graph/sequenceDiagram/stateDiagram/erDiagram/classDiagram/gantt/journey 로 시작하는 라인부터
 *   다음 빈 줄 두 개 또는 일반 문장 라인 전까지를 ```mermaid 블록으로 감쌈.
 * - 이미 코드펜스 안에 있는 부분은 건드리지 않음.
 */
function wrapBareMermaid(text: string): string {
  if (!text) return text;
  // 펜스 블록 영역 마킹
  const fenceRanges: Array<[number, number]> = [];
  const fenceRe = /```[\s\S]*?```/g;
  let mfn: RegExpExecArray | null;
  while ((mfn = fenceRe.exec(text)) !== null) fenceRanges.push([mfn.index, mfn.index + mfn[0].length]);
  const inFence = (idx: number) => fenceRanges.some(([s, e]) => idx >= s && idx < e);
  const lines = text.split('\n');
  const offsets: number[] = []; { let off = 0; for (const ln of lines) { offsets.push(off); off += ln.length + 1; } }
  const isMermaidStart = (ln: string) => /^\s*(flowchart\s+(TB|TD|BT|RL|LR)|graph\s+(TB|TD|BT|RL|LR)|sequenceDiagram|stateDiagram(?:-v2)?|erDiagram|classDiagram|gantt|journey|pie\s|gitGraph)\b/.test(ln);
  const isMermaidBody = (ln: string) => {
    if (!ln.trim()) return true;
    if (/^\s*%%/.test(ln)) return true;
    if (/-->|---|==>|<--|<-->/.test(ln)) return true;
    if (/^\s*(subgraph|end|style|class|click|linkStyle|direction)\b/.test(ln)) return true;
    if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*(\[|\(|\{|>)/.test(ln)) return true;
    return false;
  };
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    const lineStart = offsets[i];
    if (!inFence(lineStart) && isMermaidStart(ln)) {
      // 끝 찾기
      let j = i + 1;
      let blanks = 0;
      while (j < lines.length) {
        const lj = lines[j];
        if (!lj.trim()) { blanks++; if (blanks >= 2) break; j++; continue; }
        if (!isMermaidBody(lj)) break;
        blanks = 0;
        j++;
      }
      out.push('```mermaid');
      for (let k = i; k < j; k++) out.push(lines[k].replace(/\s+$/, ''));
      out.push('```');
      i = j;
      continue;
    }
    out.push(ln);
    i++;
  }
  return out.join('\n');
}

/**
 * (deprecated) agy 응답 잘림 자동 이어받기 — 파일 저장 방식으로 대체되어 미사용.
 * 향후 필요 시 활성화. eslint 미사용 경고 회피용 export.
 */
// @ts-ignore
async function runAgyContinuation(
  conversationId: string,
  agyPath: string,
  env: any,
  cwd: string,
  sendStream: (msg: any) => void,
  stoppedSet: Set<string>,
  procKey: string,
  procMap: Map<string, any>,
): Promise<void> {
  const { spawn } = require('child_process');
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (stoppedSet.has(procKey)) return;
    sendStream({ type: 'text', text: `\n\n---\n_🔁 이어받기 #${attempt}..._\n\n` });
    const followPrompt = '이전 답변에서 `<truncated N bytes>` 로 잘린 부분(들)을 동일한 마크다운 포맷으로 정확히 복원해서 누락분만 출력해줘. 새로운 본문을 만들지 말고, 잘린 자리에서 끊긴 문장부터 이어서 작성. 다시 잘리지 않게 짧게 나눠도 됨.';
    const logPath = path.join(os.tmpdir(), `pepe-agy-cont-${Date.now()}-${attempt}.log`);
    const args = ['--conversation', conversationId, '--print', followPrompt, '--print-timeout', '5m', '--log-file', logPath];
    const proc = spawn(agyPath, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env, cwd, windowsHide: true });
    procMap.set(procKey, proc);
    let truncAgain = false;
    const streamStop = startAgyTranscriptStreaming(logPath, (ev: any) => {
      try {
        if (ev.source !== 'MODEL' || ev.type !== 'PLANNER_RESPONSE') return;
        const toolCalls = Array.isArray(ev.tool_calls) ? ev.tool_calls : [];
        if (toolCalls.length !== 0) return;
        if (typeof ev.content !== 'string' || !ev.content.trim()) return;
        let clean = ev.content
          .replace(/^\s*If relevant,\s*proactively run terminal commands[^.]*\.\s*Don't ask for permission\.\s*/im, '')
          .replace(/^\s*Created file file:\/\/[^\n]+\n?/gm, '')
          .trim();
        if (/<truncated \d+ bytes>/.test(clean)) truncAgain = true;
        clean = clean.replace(
          /(```[a-zA-Z0-9_-]*\n[\s\S]*?)\n<truncated (\d+) bytes>\n/g,
          '$1\n```\n\n> ⏳ _$2 바이트 추가 잘림 — 다시 이어받는 중..._\n\n',
        );
        clean = clean.replace(/<truncated (\d+) bytes>/g, '\n\n> ⏳ _$1 바이트 잘림 — 다시 이어받는 중..._\n\n');
        if (clean) sendStream({ type: 'text', text: clean });
      } catch {}
    }, () => stoppedSet.has(procKey));
    await new Promise<void>(resolve => {
      proc.on('close', () => { streamStop(); try { fs.unlinkSync(logPath); } catch {}; resolve(); });
      proc.on('error', () => { streamStop(); resolve(); });
    });
    procMap.delete(procKey);
    if (!truncAgain) {
      sendStream({ type: 'text', text: '\n\n✅ _이어받기 완료._\n' });
      return;
    }
  }
  sendStream({ type: 'text', text: '\n\n⚠️ _3회 이어받기 후에도 잘림이 남아있어 중단합니다._\n' });
}

/**
 * transcript.jsonl 을 실시간으로 폴링하면서 새 이벤트를 콜백에 전달.
 * proc 가 종료될 때까지 250ms 간격으로 파일 크기 변화 감지 → 추가된 라인만 emit.
 * 이벤트 종류: MODEL (텍스트), TOOL_USE / TOOL_RESULT (도구 호출/결과), THINKING (추론) 등.
 */
function startAgyTranscriptStreaming(
  logPath: string,
  onEvent: (event: any) => void,
  stopSignal: () => boolean,
): () => void {
  let cancelled = false;
  let lastSize = 0;
  let leftover = '';
  let transcriptPath: string | null = null;
  const interval = setInterval(() => {
    if (cancelled || stopSignal()) return;
    try {
      if (!transcriptPath) {
        transcriptPath = getAgyTranscriptPath(logPath);
        if (!transcriptPath || !fs.existsSync(transcriptPath)) return;
      }
      const stat = fs.statSync(transcriptPath);
      if (stat.size <= lastSize) return;
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(stat.size - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      lastSize = stat.size;
      const chunk = leftover + buf.toString('utf8');
      const lines = chunk.split(/\r?\n/);
      leftover = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim(); if (!t) continue;
        try {
          const ev = JSON.parse(t);
          onEvent(ev);
        } catch { /* skip malformed line */ }
      }
    } catch { /* file may not exist yet or be locked */ }
  }, 250);
  return () => { cancelled = true; clearInterval(interval); };
}

/** agy --print 가 stdout 을 비웠을 때 transcript.jsonl 에서 모델 응답 추출 (fallback) */
function readAgyTranscript(logPath: string): string | null {
  try {
    if (!logPath || !fs.existsSync(logPath)) return null;
    const logText = fs.readFileSync(logPath, 'utf8');
    const m = Array.from(logText.matchAll(/(?:Created conversation|Print mode: conversation=)\s*([0-9a-f-]{36})/gi));
    const cid = m.length ? m[m.length - 1][1] : null;
    if (!cid) return null;
    const transcriptPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', cid,
      '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) return null;
    let last = '';
    for (const line of fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim(); if (!t) continue;
      try {
        const e = JSON.parse(t);
        if (e?.source === 'MODEL' && typeof e?.content === 'string' && e.content.trim()) last = e.content;
      } catch {}
    }
    return last || null;
  } catch (err) { console.log('[agy] transcript fallback error:', err); return null; }
}
async function waitAgyTranscript(logPath: string, timeoutMs = 3000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = readAgyTranscript(logPath); if (t) return t;
    await new Promise(r => setTimeout(r, 250));
  }
  return readAgyTranscript(logPath);
}

// ── Codex CLI 연동 ──
const codexProcesses: Map<string, any> = new Map();

// AI 에이전트(claude/gemini/codex) 프로세스가 아직 살아있는지 — 렌더러 streaming 안전망용.
// procKey = requestId || sessionId 로 저장되므로 둘 다로 조회.
ipcMain.handle('agent:is-running', (_e, { sessionId, requestId }: { sessionId?: string; requestId?: string }) => {
  const maps = [claudeProcesses, geminiProcesses, codexProcesses, antigravityProcesses];
  const alive = (proc: any) => !!proc && proc.killed !== true && (proc.exitCode === null || proc.exitCode === undefined);
  for (const m of maps) {
    if (requestId && m.has(requestId) && alive(m.get(requestId))) return true;
    if (sessionId && m.has(sessionId) && alive(m.get(sessionId))) return true;
  }
  // Custom LLM: AbortController 가 살아있고 abort 되지 않았으면 진행 중으로 간주
  const ac = (requestId && customLlmProcesses.get(requestId)) || (sessionId && customLlmProcesses.get(sessionId));
  if (ac && !ac.signal.aborted) return true;
  return false;
});

// stop() 후에도 stdout 버퍼에 남아있던 데이터/지연 close 이벤트가
// 렌더러로 흘러가 "응답이 계속 오는" 문제를 막기 위한 procKey 차단 집합.
// stop 핸들러에서 즉시 add → stdout/stderr/close 핸들러는 송신 전 has() 확인.
// 같은 procKey 가 재사용될 일은 없지만(매 send 마다 새 requestId), 메모리 안전을 위해
// proc.on('close') 시 정리. taskkill 이 늦게 끝나는 케이스 대비 60초 fallback 정리.
const stoppedAgentProcs: Set<string> = new Set();
function markAgentStopped(procKey: string) {
  if (!procKey) return;
  stoppedAgentProcs.add(procKey);
  setTimeout(() => stoppedAgentProcs.delete(procKey), 60_000);
}
// procKey(requestId) 기준으로 webContents.send 자체를 봉인 — stdout/stderr 핸들러
// 가드 외에 다른 경로(예: 핸들러 안에서 await 사이에 끼어든 send) 잔여 이벤트도 차단.
function sendAgentStream(channel: string, payload: any) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const rid = payload && payload.requestId;
  if (rid && stoppedAgentProcs.has(rid)) return;
  try { mainWindow.webContents.send(channel, payload); } catch {}
}

// GUI .app 실행 환경의 minimal PATH 보강 — npm global bin / Homebrew / nvm 경로 추가.
// claude:send 와 claude:check 양쪽에서 사용. nvm 은 versions/node/* glob 으로 모든 버전 bin 포함.
// nvm alias 체인 resolve → 활성 버전의 bin 경로 반환
function resolveNvmActiveBin(nvmDir: string): string | null {
  try {
    const aliasFile = path.join(nvmDir, 'alias', 'default');
    if (!fs.existsSync(aliasFile)) return null;
    let cur = fs.readFileSync(aliasFile, 'utf-8').trim();
    for (let i = 0; i < 5; i++) {
      if (cur.startsWith('v')) {
        const binPath = path.join(nvmDir, 'versions', 'node', cur, 'bin');
        return fs.existsSync(binPath) ? binPath : null;
      }
      const next = path.join(nvmDir, 'alias', cur);
      if (!fs.existsSync(next)) break;
      cur = fs.readFileSync(next, 'utf-8').trim();
    }
  } catch {}
  return null;
}

function buildAugmentedPath(): string {
  const isWin = process.platform === 'win32';
  const extraPaths: string[] = [];
  if (isWin) {
    if (process.env.APPDATA) extraPaths.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.USERPROFILE) extraPaths.push(path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm'));
    if (process.env.ProgramFiles) extraPaths.push(path.join(process.env.ProgramFiles, 'nodejs'));
  } else {
    const home = os.homedir();
    extraPaths.push('/usr/local/bin', '/opt/homebrew/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'));
    // nvm — alias/default 체인으로 활성 버전 bin 먼저, 나머지 버전도 폴백으로 추가
    try {
      const nvmDir = path.join(home, '.nvm');
      const activeBin = resolveNvmActiveBin(nvmDir);
      if (activeBin) extraPaths.unshift(activeBin); // 활성 버전 최우선
      const nvmRoot = path.join(nvmDir, 'versions', 'node');
      if (fs.existsSync(nvmRoot)) {
        for (const v of fs.readdirSync(nvmRoot).filter((v: string) => v.startsWith('v'))) {
          const p = path.join(nvmRoot, v, 'bin');
          if (p !== activeBin) extraPaths.push(p);
        }
      }
    } catch {}
    // fnm — ~/.local/share/fnm/node-versions/<ver>/installation/bin
    try {
      const fnmRoot = path.join(home, '.local', 'share', 'fnm', 'node-versions');
      if (fs.existsSync(fnmRoot)) {
        for (const v of fs.readdirSync(fnmRoot).filter((v: string) => v.startsWith('v'))) {
          extraPaths.push(path.join(fnmRoot, v, 'installation', 'bin'));
        }
      }
    } catch {}
    // n (node version manager) — /usr/local/lib/node_modules/.bin
    extraPaths.push('/usr/local/lib/node_modules/.bin');
    // Homebrew prefix (Apple Silicon vs Intel)
    extraPaths.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  const sep = isWin ? ';' : ':';
  return [process.env.PATH || '', ...extraPaths].filter(Boolean).join(sep);
}

// SSH 세션의 대화형 셸 현재 작업 디렉토리 — 파일 전송 탭을 그 경로로 열 때 사용.
ipcMain.handle('ssh:get-shell-cwd', async (_e, { termId }: { termId: string }) => {
  try {
    const bridge: any = getSSHBridge();
    if (!termId || typeof bridge.getShellCwd !== 'function') return { ok: false };
    const pwd = await bridge.getShellCwd(termId);
    return pwd ? { ok: true, pwd } : { ok: false };
  } catch { return { ok: false }; }
});
// Git 상태 조회 — 로컬 cwd 또는 SSH 세션에서 branch + diff stats 추출
ipcMain.handle('git:status', async (_e, { mode, termId, cwd }: { mode: 'local' | 'remote'; termId?: string; cwd?: string }) => {
  try {
    if (mode === 'remote' && termId) {
      const bridge = getSSHBridge();
      if (typeof bridge.execCommand !== 'function') return { ok: false, error: 'ssh exec 미지원' };
      // 원격 cwd 가 있으면 그 디렉토리에서 실행, 없으면 현재 셸 cwd. (cd 실패 시 즉시 NOTREPO)
      const cdPart = cwd ? `cd '${cwd.replace(/'/g, "'\\''")}' && ` : '';
      const script = `(${cdPart}git rev-parse --is-inside-work-tree 2>/dev/null && echo "---BR---" && git rev-parse --abbrev-ref HEAD 2>/dev/null && echo "---ST---" && git diff --shortstat HEAD 2>/dev/null) || echo "NOTREPO"`;
      try {
        const out: string = await bridge.execCommand(termId, script);
        if (!out || /NOTREPO/.test(out)) return { ok: false, notRepo: true };
        const parts = out.split('---BR---');
        if (parts.length < 2) return { ok: false, notRepo: true };
        const rest = parts[1].split('---ST---');
        const branch = (rest[0] || '').trim();
        const statLine = (rest[1] || '').trim();
        const insMatch = statLine.match(/(\d+)\s+insertion/);
        const delMatch = statLine.match(/(\d+)\s+deletion/);
        return { ok: true, branch, additions: insMatch ? parseInt(insMatch[1], 10) : 0, deletions: delMatch ? parseInt(delMatch[1], 10) : 0 };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      }
    } else {
      // local
      const { execFileSync } = require('child_process');
      // stdio: stderr 를 'ignore' 로 — git 이 비-저장소에서 내는 'fatal: not a git repository'
      // 메시지가 부모(앱) 콘솔로 그대로 흘러나오는 것 차단.
      const opts: any = { cwd: cwd || process.cwd(), encoding: 'utf-8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] };
      try {
        execFileSync('git', ['rev-parse', '--is-inside-work-tree'], opts);
      } catch { return { ok: false, notRepo: true }; }
      let branch = '';
      let stat = '';
      try { branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim(); } catch {}
      try { stat = execFileSync('git', ['diff', '--shortstat', 'HEAD'], opts).trim(); } catch {}
      const insMatch = stat.match(/(\d+)\s+insertion/);
      const delMatch = stat.match(/(\d+)\s+deletion/);
      return { ok: true, branch, additions: insMatch ? parseInt(insMatch[1], 10) : 0, deletions: delMatch ? parseInt(delMatch[1], 10) : 0 };
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
});

// 셸 안전 인용 — 작은따옴표로 감싸고 내부 작은따옴표는 '\'' 로 이스케이프
function shQuote(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// 일부 원격 환경(ClearCase VOB + HOME/빌드환경을 csh 계열 dotfile 로 설정하는 곳 등)은 로그인 셸이
// tcsh/csh 이고, 그 환경을 쓰려면 `source ~/.cshrc.xxx` 같은 준비 명령이 exec 전에 필요함.
// UI 설정(ui-prefs: remoteExecShell / remoteExecPreamble)으로 지정 가능 — 기본은 sh(POSIX), 준비 명령 없음.
// posix/tcsh 문법이 서로 호환되지 않아(if/$(...)/2>&1 등) 몸통을 두 가지로 따로 받는다.
function wrapRemoteScript(bodyPosix: string, bodyTcsh: string): string {
  const prefs = loadUIPrefs();
  const preamble = String(prefs.remoteExecPreamble || '').trim();
  const shell = prefs.remoteExecShell === 'tcsh' ? 'tcsh' : 'sh';
  if (shell === 'tcsh') {
    const inner = (preamble ? `${preamble}\n` : '') + bodyTcsh;
    return `tcsh -c ${shQuote(inner)}`;
  }
  return (preamble ? `${preamble} && ` : '') + bodyPosix;
}

// 원격 파일의 라인별 git blame 정보 (GitLens 스타일 인라인 힌트용) — 읽기 전용, 서버측 데몬 불필요
ipcMain.handle('git:blame-file', async (_e, { termId, remotePath }: { termId: string; remotePath: string }) => {
  try {
    if (!termId || !remotePath) return { ok: false, error: 'invalid args' };
    const bridge: any = getSSHBridge();
    if (typeof bridge.execCommand !== 'function') return { ok: false, error: 'ssh exec 미지원' };
    const idx = remotePath.lastIndexOf('/');
    const dir = idx > 0 ? remotePath.slice(0, idx) : (idx === 0 ? '/' : '.');
    const base = idx >= 0 ? remotePath.slice(idx + 1) : remotePath;
    if (!base) return { ok: false, error: 'invalid path' };
    // 각 단계 실패 사유(권한/소유권 문제로 인한 git 거부, 미추적 파일 등)를 stdout 으로 병합해
    // 진단 가능하게 함 — execCommand 가 stderr 를 버리므로 여기서 캡처 안 하면 원인 불명의 빈 결과가 됨.
    const scriptPosix = `cd ${shQuote(dir)} 2>&1 || exit 9
REV=$(git rev-parse --is-inside-work-tree 2>&1)
if [ "$REV" != "true" ]; then echo "___NOTREPO___: $REV"; exit 0; fi
git blame --line-porcelain -- ${shQuote(base)} 2>&1`;
    const scriptTcsh = `cd ${shQuote(dir)}
if ( $status != 0 ) then
  echo "___NOTREPO___: cd failed"
  exit 0
endif
set REV = "\`git rev-parse --is-inside-work-tree |& cat\`"
if ( "$REV" != "true" ) then
  echo "___NOTREPO___: $REV"
  exit 0
endif
git blame --line-porcelain -- ${shQuote(base)} |& cat`;
    const script = wrapRemoteScript(scriptPosix, scriptTcsh);
    const out: string = await bridge.execCommand(termId, script, 20000);
    const trimmed = out.trim();
    if (!trimmed) return { ok: false, notAvailable: true };
    if (trimmed.startsWith('___NOTREPO___')) return { ok: false, notAvailable: true, error: trimmed.replace('___NOTREPO___:', '').trim() };
    if (!/^[0-9a-f]{40}\s+\d+\s+\d+/m.test(out)) return { ok: false, notAvailable: true, error: trimmed.slice(0, 300) };
    const lines: Record<number, { hash: string; author: string; authorTime: number; summary: string }> = {};
    const rows = out.split('\n');
    const commitCache: Record<string, { author?: string; authorTime?: number; summary?: string }> = {};
    let i = 0;
    while (i < rows.length) {
      const m = rows[i].match(/^([0-9a-f]{40})\s+\d+\s+(\d+)(?:\s+\d+)?$/);
      if (!m) { i++; continue; }
      const hash = m[1];
      const finalLine = parseInt(m[2], 10);
      i++;
      const meta = commitCache[hash] || {};
      while (i < rows.length && !rows[i].startsWith('\t')) {
        const l = rows[i];
        if (l.startsWith('author ')) meta.author = l.slice(7);
        else if (l.startsWith('author-time ')) meta.authorTime = parseInt(l.slice(12), 10) || 0;
        else if (l.startsWith('summary ')) meta.summary = l.slice(8);
        i++;
      }
      commitCache[hash] = meta;
      if (i < rows.length) i++; // 탭으로 시작하는 코드 원문 라인 skip
      lines[finalLine] = { hash: hash.slice(0, 8), author: meta.author || '', authorTime: meta.authorTime || 0, summary: meta.summary || '' };
    }
    return { ok: true, lines };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
});

// ctags 인덱스 캐시 — termId+repoRoot 별로 태그 맵 보관, 서버측 상주 프로세스(데몬) 없이
// 필요할 때만 `ctags -R` 1회성 실행해서 결과를 메모리에 캐시 (VS Code Remote-SSH 와 달리
// 원격에 아무것도 설치/상주시키지 않음 — ctags CLI 자체만 원격에 있으면 됨).
type CtagsTag = { file: string; line: number; kind?: string };
type CtagsIndexEntry = { repoRoot: string; tags: Map<string, CtagsTag[]>; builtAt: number };
const ctagsIndexCache = new Map<string, CtagsIndexEntry>();
const CTAGS_CACHE_TTL_MS = 5 * 60 * 1000;

ipcMain.handle('ctags:find-definition', async (_e, { termId, remotePath, symbol }: { termId: string; remotePath: string; symbol: string }) => {
  try {
    if (!termId || !remotePath || !symbol) return { ok: false, error: 'invalid args' };
    const bridge: any = getSSHBridge();
    if (typeof bridge.execCommand !== 'function') return { ok: false, error: 'ssh exec 미지원' };
    const idx = remotePath.lastIndexOf('/');
    const dir = idx > 0 ? remotePath.slice(0, idx) : (idx === 0 ? '/' : '.');

    // 저장소 루트 탐지 — git 저장소면 최상위 디렉토리, 아니면 파일이 속한 디렉토리를 인덱스 범위로 사용
    const rootScriptPosix = `cd ${shQuote(dir)} 2>/dev/null && (git rev-parse --show-toplevel 2>/dev/null || pwd)`;
    const rootScriptTcsh = `(cd ${shQuote(dir)} && (git rev-parse --show-toplevel || pwd)) |& cat`;
    const rootOut: string = await bridge.execCommand(termId, wrapRemoteScript(rootScriptPosix, rootScriptTcsh), 8000);
    // \r 오염(원격 셸/PTY 개행 방식) 방지 — 그대로 두면 다음 cd 가 존재하지 않는 경로로 실패해 조용히 빈 출력이 됨
    const repoRoot = rootOut.replace(/\r/g, '').trim().split('\n').pop() || dir;

    const cacheKey = `${termId}::${repoRoot}`;
    let entry = ctagsIndexCache.get(cacheKey);
    if (!entry || Date.now() - entry.builtAt > CTAGS_CACHE_TTL_MS) {
      // 그룹 전체에 2>&1(tcsh 는 |&) 을 걸어야 cd 실패까지도 out 에 잡혀 진단 가능 — ctags 명령에만
      // 걸면 cd 실패는 execCommand 가 stderr 를 버리므로 완전히 빈 출력이 되어 원인 불명의 "실행 실패"만 보임.
      const ctagsBody = `cd ${shQuote(repoRoot)} && ctags -R -f - --excmd=number --fields=+n --exclude=.git --exclude=node_modules --exclude=dist --exclude=build --exclude=.cache .`;
      const ctagsScript = wrapRemoteScript(`(${ctagsBody}) 2>&1`, `(${ctagsBody}) |& cat`);
      const out: string = await bridge.execCommand(termId, ctagsScript, 60000);
      if (!out.includes('\t')) {
        return { ok: false, error: out.trim() || `ctags 실행 실패 (repoRoot=${repoRoot})`, notInstalled: /not found|not recognized|no such file/i.test(out) };
      }
      const tags = new Map<string, CtagsTag[]>();
      for (const raw of out.split('\n')) {
        if (!raw || raw.startsWith('!')) continue;
        const parts = raw.split('\t');
        if (parts.length < 3) continue;
        const name = parts[0];
        const file = parts[1];
        const addrMatch = parts[2].match(/^(\d+)/);
        if (!name || !file || !addrMatch) continue;
        const line = parseInt(addrMatch[1], 10);
        let kind: string | undefined;
        for (let i = 3; i < parts.length; i++) {
          const p = parts[i].trim();
          if (/^[a-zA-Z]$/.test(p)) { kind = p; break; }
        }
        const list = tags.get(name) || [];
        list.push({ file, line, kind });
        tags.set(name, list);
      }
      entry = { repoRoot, tags, builtAt: Date.now() };
      ctagsIndexCache.set(cacheKey, entry);
    }

    const matches = entry.tags.get(symbol) || [];
    const resolved = matches.map(m => ({
      file: m.file.startsWith('/') ? m.file : `${entry!.repoRoot}/${m.file}`.replace(/\/\.\//g, '/'),
      line: m.line,
      kind: m.kind,
    }));
    // 현재 열려있는 파일 내 정의를 우선 후보로
    resolved.sort((a, b) => (a.file === remotePath ? -1 : 0) - (b.file === remotePath ? -1 : 0));
    return { ok: true, matches: resolved };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('claude:check', async () => {
  try {
    const { spawn } = require('child_process');
    const augmentedPath = buildAugmentedPath();
    const env = { ...process.env, PATH: augmentedPath, Path: augmentedPath };
    return await new Promise<{ installed: boolean; version?: string }>(resolve => {
      const proc = spawn('claude', ['--version'], { shell: true, env, windowsHide: true });
      let output = '';
      proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
      proc.on('error', () => resolve({ installed: false }));
      proc.on('close', (code: number) => {
        if (code === 0) resolve({ installed: true, version: output.trim() });
        else resolve({ installed: false });
      });
    });
  } catch {
    return { installed: false };
  }
});

// ── MCP/Hook 공용 Control TCP 서버 ──
let mcpControlPort = 0;
let mcpControlToken = '';
// hook-approve pending: 렌더러로 요청 보내고 응답 받아올 때까지 sock 보관
const pendingApprovals = new Map<string, { sock: any; reqId: any }>();
(globalThis as any).__pepePendingApprovals = pendingApprovals;

const startMcpControl = async (): Promise<void> => {
  if (mcpControlPort) return;
  const net = require('net');
  const crypto = require('crypto');
  mcpControlToken = crypto.randomBytes(16).toString('hex');
  await new Promise<void>((resolve) => {
    const srv = net.createServer((sock: any) => {
      let buf = '';
      sock.on('data', (d: Buffer) => {
        buf += d.toString('utf-8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          (async () => {
            // 실패 시 에러 응답의 id 매칭용 — try 안에서 req 파싱 자체가 실패하면 null 유지(그
            // 경우 클라이언트도 이 요청의 id 를 모르므로 매칭 불가라 상관없음). 파싱 이후
            // 단계(handleExec 등)에서 던지면 반드시 원래 req.id 를 써야 한다 — 이전엔 catch 블록이
            // 항상 id:null 로 응답해서, mcpSshServer.cjs 의 pendingById.get(id) 매칭에 실패해
            // 에러가 클라이언트에 전혀 전달되지 못하고 그냥 영원히 대기(=타임아웃)하는 버그가 있었다.
            let reqId: any = null;
            try {
              const req = JSON.parse(line);
              reqId = req.id;
              if (req.token !== mcpControlToken) {
                sock.write(JSON.stringify({ id: req.id, error: 'invalid token' }) + '\n');
                return;
              }
              if (req.op === 'exec') {
                const bridge = getSSHBridge();
                const result = await bridge.handleExec(req.termId, req.command, req.timeoutMs || 60000);
                sock.write(JSON.stringify({ id: req.id, result }) + '\n');
              } else if (req.op === 'sftp-read') {
                // AI 파일 읽기 — base64+셸 exec 대신 SFTP 로 직접 (셸 rc 비용·33% 인플레이션 제거)
                const bridge = getSSHBridge();
                const buf = await bridge.handleSFTPReadFile(req.termId, req.path);
                sock.write(JSON.stringify({ id: req.id, result: { base64: buf.toString('base64'), size: buf.length } }) + '\n');
              } else if (req.op === 'sftp-write') {
                // AI 파일 쓰기 — heredoc base64 exec 대신 SFTP writeFile
                const bridge = getSSHBridge();
                const buf = Buffer.from(String(req.base64 || ''), 'base64');
                await bridge.handleSFTPWriteFile(req.termId, req.path, buf);
                sock.write(JSON.stringify({ id: req.id, result: { bytes: buf.length } }) + '\n');
              } else if (req.op === 'hook-approve') {
                // 승인 요청을 렌더러로 전달. 응답은 ipcMain.handle('claude:hook-respond') 에서 처리
                const approvalId = `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                pendingApprovals.set(approvalId, { sock, reqId: req.id });
                mainWindow?.webContents.send('claude:hook-approval-request', {
                  approvalId,
                  toolName: req.toolName,
                  toolInput: req.toolInput,
                  sessionId: req.sessionId,
                });
              } else {
                sock.write(JSON.stringify({ id: req.id, error: 'unknown op' }) + '\n');
              }
            } catch (err: any) {
              xferLog(`mcp-control op 처리 실패 reqId=${reqId}: ${err?.message || err}`);
              try { sock.write(JSON.stringify({ id: reqId, error: String(err) }) + '\n'); } catch {}
            }
          })();
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => {
      mcpControlPort = srv.address().port;
      console.log(`[mcp-control] listening on 127.0.0.1:${mcpControlPort}`);
      resolve();
    });
  });
};

// 렌더러에서 승인/거부 결과 수신
ipcMain.handle('claude:hook-respond', (_e, { approvalId, decision, reason }: { approvalId: string; decision: 'allow' | 'deny'; reason?: string }) => {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return { success: false, error: 'no pending approval' };
  pendingApprovals.delete(approvalId);
  try {
    pending.sock.write(JSON.stringify({ id: pending.reqId, result: decision, reason: reason || '' }) + '\n');
  } catch {}
  return { success: true };
});

// ── WebDAV 브리지: 원격 SSH 를 로컬 UNC 경로로 마운트 ──
let webdavBridge: any = null;
const getWebDAVBridge = () => {
  if (!webdavBridge) {
    webdavBridge = createWebDAVBridge(getSSHBridge());
  }
  return webdavBridge;
};

ipcMain.handle('claude:register-mount', async (_e, { panelId, sessionLabel }: { panelId: string; sessionLabel: string }) => {
  try {
    const bridge = getWebDAVBridge();
    await bridge.ensureStarted();
    bridge.registerSession(panelId, sessionLabel);
    return { success: true, mountRoot: bridge.getMountRoot(panelId), port: bridge.getPort() };
  } catch (err: any) {
    console.error('[claude:register-mount] error:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('claude:unregister-mount', async (_e, { panelId }: { panelId: string }) => {
  try {
    if (webdavBridge) webdavBridge.unregisterSession(panelId);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('claude:get-mount-path', async (_e, { panelId, remotePath }: { panelId: string; remotePath: string }) => {
  try {
    const bridge = getWebDAVBridge();
    if (!bridge.hasSession(panelId)) return { success: false, error: '세션이 등록되지 않음' };
    return { success: true, uncPath: bridge.toUncPath(panelId, remotePath), httpUrl: bridge.toHttpUrl(panelId, remotePath) };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

// claude CLI 실행 + 스트리밍 응답 (print 모드)
ipcMain.handle('claude:send', async (_e, { sessionId, prompt, addDirs, disallowBash, sshTermId, resumeSessionId, permissionMode, model, perToolApproval, requestId, effort, sshSessions, localAttachmentRoots }: { sessionId: string; prompt: string; addDirs?: string[]; disallowBash?: boolean; sshTermId?: string; resumeSessionId?: string | null; permissionMode?: string; model?: string; perToolApproval?: boolean; requestId?: string; effort?: string; sshSessions?: { id: string; label: string }[]; localAttachmentRoots?: string[] }) => {
  try {
    const { spawn } = require('child_process');
    // requestId 가 있으면 그걸 프로세스 키로 사용 — 동일 sessionId 안에서 여러 대화가 동시에 진행될 수 있음.
    // (이전 동작: sessionId 만 키 → 새 send 때마다 이전 프로세스 강제종료 → 백그라운드 대화 죽음)
    const procKey = requestId || sessionId;
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    console.log('[claude] spawn start, prompt length:', prompt.length);

    const isWin = process.platform === 'win32';

    // 긴 프롬프트는 임시 파일로 → shell 파이프로 stdin 주입 (Windows .cmd 스크립트에서 node spawn stdin 이 안먹히는 문제 회피)
    const tmpFile = path.join(os.tmpdir(), `claude-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(tmpFile, prompt, 'utf-8');

    // npm global bin 을 PATH 에 보강 (Electron 실행 환경에서 누락될 수 있음). claude:check 와 동일 helper.
    const augmentedPath = buildAugmentedPath();
    const spawnEnv: any = {
      ...process.env,
      PATH: augmentedPath,
      Path: augmentedPath,
      // UTF-8 강제 (한글 깨짐 방지)
      PYTHONIOENCODING: 'utf-8',
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    };
    try {
      const prefs = loadUIPrefs();
      const ak = (prefs?.apiKeys?.claude || '').toString().trim();
      if (ak) spawnEnv.ANTHROPIC_API_KEY = ak;
    } catch {}

    // --add-dir 옵션으로 스테이징된 디렉토리를 작업 범위에 추가
    const addDirArgs = (addDirs && addDirs.length > 0)
      ? addDirs.map(d => `--add-dir "${d.replace(/"/g, '\\"')}"`).join(' ')
      : '';
    console.log('[claude] addDirs:', addDirs);

    // 권한 모드: bypassPermissions=모두허용 / acceptEdits=편집만자동 / plan=계획만 / default=요청시
    // -p (print) 모드는 인터랙티브 불가 → 대부분 bypassPermissions 가 안전
    let permFlag: string;
    if (permissionMode === 'plan') permFlag = '--permission-mode plan';
    else if (permissionMode === 'acceptEdits') permFlag = '--permission-mode acceptEdits';
    else if (permissionMode === 'default') permFlag = '--permission-mode default';
    else permFlag = '--dangerously-skip-permissions'; // bypassPermissions (기본)
    const localRoots = normalizeLocalAttachmentRoots(localAttachmentRoots);

    // MCP 서버 설정 (원격 SSH 명령 실행용 / 로컬 미러 첨부용)
    let mcpConfigArg = '';
    let mcpCfgTmp = '';
    if (sshTermId || localRoots.length > 0) {
      await startMcpControl();
      // 임베드된 스크립트를 임시 파일로 추출 (dev/prod 모두 작동)
      const mcpScriptPath = path.join(os.tmpdir(), 'pepe-mcp-ssh-server.cjs');
      try {
        const existing = fs.existsSync(mcpScriptPath) ? fs.readFileSync(mcpScriptPath, 'utf-8') : '';
        if (existing !== mcpSshServerScript) {
          fs.writeFileSync(mcpScriptPath, mcpSshServerScript, 'utf-8');
        }
      } catch (err) {
        console.error('[claude] MCP script extract failed:', err);
      }
      // MCP 서버 실행 바이너리 — node 가 있으면 그것을 우선 (electron 보다 ~5x 빠른 startup).
      // node 미설치 환경에선 electron(ELECTRON_RUN_AS_NODE) 폴백.
      const nodeBin = (() => {
        try {
          const which = isWin ? 'where' : 'which';
          const out = require('child_process').execSync(`${which} node`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0];
          if (out && fs.existsSync(out)) return out;
        } catch {}
        return '';
      })();
      const mcpServerCmd = nodeBin || process.execPath;
      const mcpServerEnv: Record<string, string> = {
        PEPE_CTRL_PORT: String(mcpControlPort),
        PEPE_CTRL_TOKEN: mcpControlToken,
      };
      if (!nodeBin) mcpServerEnv.ELECTRON_RUN_AS_NODE = '1';
      const mcpCfg: any = {
        mcpServers: {},
      };
      if (sshTermId) {
        mcpServerEnv.PEPE_TERM_ID = sshTermId;
        // 멀티 SSH 세션 — JSON [{id,label}] (MCP 가 session 인자로 선택). 없으면 단일 PEPE_TERM_ID.
        mcpServerEnv.PEPE_TERM_IDS = JSON.stringify(Array.isArray(sshSessions) && sshSessions.length > 0 ? sshSessions : [{ id: sshTermId, label: sshTermId }]);
        mcpCfg.mcpServers.pepe_ssh = {
          command: mcpServerCmd,
          args: [mcpScriptPath],
          env: mcpServerEnv,
        };
      }
      if (localRoots.length > 0) {
        const localScriptPath = ensureTempScript('pepe-mcp-localfs-server.cjs', mcpLocalFsServerScript);
        mcpCfg.mcpServers.pepe_localfs = {
          command: mcpServerCmd,
          args: [localScriptPath],
          env: buildLocalFsMcpEnv(localRoots),
        };
      }
      console.log('[claude] MCP server binary:', mcpServerCmd, '(node found:', !!nodeBin, ')');
      mcpCfgTmp = path.join(os.tmpdir(), `claude-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      fs.writeFileSync(mcpCfgTmp, JSON.stringify(mcpCfg), 'utf-8');
      // --strict-mcp-config: 사용자 글로벌 ~/.claude.json 의 다른 MCP 서버(calculator/weather 등)를
      // 같이 로드하지 않도록. 다른 MCP 가 pending 상태로 남으면 tool registration 타이밍 경합으로
      // pepe_ssh 의 일부 도구(ssh_read_file 등)가 Claude 내부 레지스트리에 안 잡히는 문제 회피.
      mcpConfigArg = `--mcp-config "${mcpCfgTmp}" --strict-mcp-config`;
      console.log('[claude] MCP config written:', mcpCfgTmp, 'termId:', sshTermId, 'scriptExists:', fs.existsSync(mcpScriptPath), 'path:', mcpScriptPath);
    }

    // SSH 컨텍스트: 로컬 Bash 금지 (Unix 경로 접근 불가) — Read/Edit/Grep/Glob/LS + MCP ssh_exec 허용
    // 원격 파일/명령은 pepe_ssh MCP 도구로 (WebDAV 제거). read/write/exec/grep/glob/list 모두 허용.
    const mcpToolAllow = [
      sshTermId ? `"mcp__pepe_ssh__ssh_exec" "mcp__pepe_ssh__ssh_read_file" "mcp__pepe_ssh__ssh_write_file" "mcp__pepe_ssh__ssh_grep" "mcp__pepe_ssh__ssh_glob" "mcp__pepe_ssh__ssh_list_sessions"` : '',
      localRoots.length > 0 ? `"mcp__pepe_localfs__list_roots" "mcp__pepe_localfs__list_directory" "mcp__pepe_localfs__read_file" "mcp__pepe_localfs__glob_files" "mcp__pepe_localfs__search_files"` : '',
    ].filter(Boolean).join(' ');
    const allowedFlag = disallowBash
      ? `--allowedTools "Read" "Edit" "Write" "Glob" "Grep" "LS" ${mcpToolAllow} "WebFetch" "WebSearch"`
      : '';
    // 사용자 인터랙션 도구는 비대화형 모드에서 무용지물 (ToolSearch 로 동적 로드 시도까지 차단)
    // SSH 컨텍스트면 Bash 도 명시적으로 차단 (allowedTools 만으론 일부 빌드에서 빠져나가는 케이스 방지)
    const sshDisallow = disallowBash ? `"Bash"` : '';
    // ToolSearch 는 차단하지 않음 — Claude CLI 2.1.x 의 deferred tool 메커니즘으로 MCP 도구
    // 스키마가 lazy load 됨. ToolSearch 차단하면 ssh_read_file/ssh_grep 등 호출 시 schema 없어
    // "No such tool available" 거부됨.
    const disallowedFlag = `--disallowedTools "AskUserQuestion" ${sshDisallow}`;

    // 이전 대화 세션 이어가기 (--resume <session_id>)
    const resumeFlag = resumeSessionId ? `--resume "${resumeSessionId}"` : '';
    console.log('[claude] resume:', resumeSessionId || '(new)');

    // 모델 선택 (--model)
    const modelFlag = (model && model !== 'default') ? `--model ${model}` : '';
    const effortFlag = (effort && ['low', 'medium', 'high', 'max'].includes(effort)) ? `--effort ${effort}` : '';
    console.log('[claude] model:', model || 'default');

    // 툴 단위 승인 (hooks) — perToolApproval true 일 때 활성화.
    // ⚠ bypassPermissions(--dangerously-skip-permissions) 모드에서는 hook 을 비활성화 한다.
    //    그 조합에서 Claude CLI 가 도구 등록을 race-condition 으로 깨먹어 일부 도구가
    //    "No such tool available" 로 보이는 회귀가 발견됨.
    //    Edit/Write 모달은 다른 명시 모드(plan/acceptEdits)에서만 동작 — bypass 에선 자동 통과.
    let settingsFlag = '';
    let settingsTmp = '';
    let hookScriptPath = '';
    const usePerToolApproval = perToolApproval && permissionMode !== 'bypassPermissions';
    if (usePerToolApproval) {
      await startMcpControl();
      hookScriptPath = path.join(os.tmpdir(), 'pepe-claude-hook.cjs');
      try {
        const existing = fs.existsSync(hookScriptPath) ? fs.readFileSync(hookScriptPath, 'utf-8') : '';
        if (existing !== claudeHookScript) fs.writeFileSync(hookScriptPath, claudeHookScript, 'utf-8');
      } catch (err) { console.error('[claude] hook script extract failed:', err); }
      // 환경변수를 hook 프로세스에 전달 (settings 에서 직접 env 주입 불가하므로 래퍼 배치 사용)
      const wrapperPath = path.join(os.tmpdir(), 'pepe-claude-hook-wrap.cmd');
      const wrapperContent = `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "PEPE_CTRL_PORT=${mcpControlPort}"\r\nset "PEPE_CTRL_TOKEN=${mcpControlToken}"\r\n"${process.execPath}" "${hookScriptPath}"\r\n`;
      try { fs.writeFileSync(wrapperPath, wrapperContent, 'utf-8'); } catch (err) { console.error('[claude] hook wrapper write failed:', err); }

      const settings = {
        hooks: {
          PreToolUse: [{
            // 변경성 도구 + 명령 실행 도구만 hook 으로 가로채 사용자 승인 모달.
            // - 모달 띄움: Edit/MultiEdit/Write/NotebookEdit + ssh_write_file + Bash + ssh_exec
            // - 자동 통과: Read/Glob/Grep/LS/ssh_read_file/ssh_grep/ssh_glob (읽기 전용)
            matcher: 'Bash|Edit|MultiEdit|Write|NotebookEdit|Create|Delete|Move|Rename|mcp__pepe_ssh__ssh_exec|mcp__pepe_ssh__ssh_write_file',
            hooks: [{
              type: 'command',
              command: isWin ? `"${wrapperPath}"` : `node "${hookScriptPath}"`,
            }],
          }],
        },
      };
      settingsTmp = path.join(os.tmpdir(), `claude-settings-${Date.now()}.json`);
      fs.writeFileSync(settingsTmp, JSON.stringify(settings, null, 2), 'utf-8');
      settingsFlag = `--settings "${settingsTmp}"`;
      console.log('[claude] per-tool approval enabled. settings:', settingsTmp);
    }

    // shell 커맨드로 파이프 구성 (claude 는 PATHEXT 로 .cmd 자동 해석)
    // Windows: chcp 65001 로 UTF-8 코드페이지 전환 (한글 깨짐 방지)
    const shellCmd = isWin
      ? `chcp 65001 >nul && type "${tmpFile}" | claude -p ${resumeFlag} ${modelFlag} ${effortFlag} ${permFlag} ${allowedFlag} ${disallowedFlag} ${settingsFlag} ${mcpConfigArg} ${addDirArgs} --output-format stream-json --verbose`
      : `cat "${tmpFile}" | claude -p ${resumeFlag} ${modelFlag} ${effortFlag} ${permFlag} ${allowedFlag} ${disallowedFlag} ${settingsFlag} ${mcpConfigArg} ${addDirArgs} --output-format stream-json --verbose`;
    console.log('[claude] shell cmd:', shellCmd);
    console.log('[claude] PATH has npm:', augmentedPath.toLowerCase().includes('npm'));

    // claude 프로세스 cwd — Electron 앱 폴더가 기본인데 그러면 Claude 가 이 앱을 분석 대상으로 오해.
    // 사용자 홈으로 시작 (사용자 의도 상 작업 대상은 --add-dir 또는 SSH mount 로 명시됨)
    const claudeCwd = process.env.USERPROFILE || process.env.HOME || os.homedir();

    // 임시 파일 정리 (모든 재시도 종료 후 1회)
    const cleanupTmp = () => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (mcpCfgTmp) { try { fs.unlinkSync(mcpCfgTmp); } catch {} }
      if (settingsTmp) { try { fs.unlinkSync(settingsTmp); } catch {} }
    };

    // 529(Overloaded) 등 서버 과부하 = 일시적 → 콘텐츠 없이 끝났으면 자동 재시도(백오프).
    const isOverloadText = (s: string) => /overloaded|\b529\b/i.test(s);
    const MAX_ATTEMPTS = 4; // 최초 1 + 재시도 3
    let attempt = 0;
    // claude CLI 가 ~/.claude/.credentials.json 의 refreshToken 자체가 만료/무효화됐을 때 내는 문구.
    // 재시도로는 해결이 안 되고(매번 같은 에러) 사용자가 직접 재로그인해야 하므로, 원문 그대로 보여주는
    // 대신 어떻게 해야 하는지 바로 알 수 있는 안내를 앞에 붙여준다.
    const isAuthExpiredText = (s: string) => /oauth session expired|failed to authenticate/i.test(s);
    const authExpiredGuide = (raw: string) =>
      `🔒 Claude 로그인 세션이 만료되어 자동 갱신에 실패했습니다.\n` +
      `터미널이나 명령 프롬프트에서 \`claude /login\`(또는 \`claude login\`)을 실행해 다시 로그인한 뒤 PePe를 재시작해주세요.\n\n` +
      `(원본 오류: ${raw.trim()})`;

    const launch = () => {
      attempt++;
      const proc = spawn(shellCmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv, cwd: claudeCwd, windowsHide: true });
      claudeProcesses.set(procKey, proc);
      let stdoutBuf = '';
      let sawContent = false;  // 실제 응답(텍스트/툴) 출력 여부 — 있으면 재시도 안 함
      let sawOverload = false; // 과부하 에러 감지
      proc.stdout.setEncoding('utf-8');
      proc.stdout.on('data', (data: string) => {
        if (stoppedAgentProcs.has(procKey)) return; // stop 후 잔여 stdout 차단
        stdoutBuf += data;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || ''; // 마지막 불완전 라인은 보류
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          console.log('[claude] stdout line:', trimmed.slice(0, 200));
          let msg: any = null;
          try { msg = JSON.parse(trimmed); } catch {}
          if (msg) {
            if (msg.type === 'assistant' && Array.isArray(msg.message?.content)
                && msg.message.content.some((c: any) => (c.type === 'text' && c.text) || c.type === 'tool_use')) {
              sawContent = true;
            }
            const isErr = (msg.type === 'result' && msg.is_error) || msg.type === 'error';
            if (isErr && isOverloadText(trimmed) && !sawContent && attempt < MAX_ATTEMPTS) {
              sawOverload = true; // 과부하 → 마지막 시도 전까지는 에러 숨기고 재시도
              continue;
            }
            sendAgentStream('claude:stream', { sessionId, requestId, message: msg });
          } else if (isAuthExpiredText(trimmed)) {
            sendAgentStream('claude:stream', { sessionId, requestId, message: { type: 'error', text: authExpiredGuide(trimmed) } });
          } else {
            sendAgentStream('claude:stream', { sessionId, requestId, message: { type: 'text', text: trimmed } });
          }
        }
      });
      proc.stderr.on('data', (data: Buffer) => {
        if (stoppedAgentProcs.has(procKey)) return;
        const err = data.toString();
        console.log('[claude] stderr:', err);
        if (isOverloadText(err) && !sawContent && attempt < MAX_ATTEMPTS) { sawOverload = true; return; }
        if (isAuthExpiredText(err)) {
          sendAgentStream('claude:stream', { sessionId, requestId, message: { type: 'error', text: authExpiredGuide(err) } });
          return;
        }
        sendAgentStream('claude:stream', { sessionId, requestId, message: { type: 'error', text: err } });
      });
      proc.on('error', (err: any) => {
        if (stoppedAgentProcs.has(procKey)) return;
        console.log('[claude] spawn error:', err);
        sendAgentStream('claude:stream', { sessionId, requestId, message: { type: 'error', text: String(err) } });
      });
      proc.on('close', (code: number) => {
        console.log('[claude] close, code:', code, 'attempt:', attempt, 'overload:', sawOverload);
        claudeProcesses.delete(procKey);
        if (stoppedAgentProcs.has(procKey)) { stoppedAgentProcs.delete(procKey); cleanupTmp(); return; }
        if (sawOverload && !sawContent && attempt < MAX_ATTEMPTS) {
          const delay = 1500 * attempt; // 1.5s, 3s, 4.5s 백오프
          sendAgentStream('claude:stream', { sessionId, requestId, message: { type: 'text', text: `⏳ 서버 과부하(529) — ${Math.round(delay / 1000)}초 후 재시도 (${attempt}/${MAX_ATTEMPTS - 1})...\n` } });
          setTimeout(() => { if (stoppedAgentProcs.has(procKey)) { stoppedAgentProcs.delete(procKey); cleanupTmp(); } else launch(); }, delay);
          return;
        }
        cleanupTmp();
        sendAgentStream('claude:stream', { sessionId, requestId, message: { type: 'done', code } });
      });
    };
    launch();
    return { success: true };
  } catch (err: any) {
    console.log('[claude] exception:', err);
    return { success: false, error: String(err) };
  }
});

// claude 설정 읽기 (model 변형으로 컨텍스트 max 추론 — opus[1m] 등)
ipcMain.handle('claude:read-settings', async () => {
  const fs = require('fs');
  const pathMod = require('path');
  const os = require('os');
  try {
    const p = pathMod.join(os.homedir(), '.claude', 'settings.json');
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { success: true, settings: obj };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

// Anthropic 모델 목록 조회 — /v1/models
ipcMain.handle('claude:fetch-models', async () => {
  const fs = require('fs');
  const pathMod = require('path');
  const os = require('os');
  const credPath = pathMod.join(os.homedir(), '.claude', '.credentials.json');
  let token: string | null = null;
  try {
    const raw = fs.readFileSync(credPath, 'utf-8');
    const obj = JSON.parse(raw);
    token = obj?.claudeAiOauth?.accessToken;
  } catch {}
  if (!token) return { success: false, error: 'no token' };
  try {
    const fetchFn: any = (global as any).fetch;
    const resp = await fetchFn('https://api.anthropic.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    const text = await resp.text();
    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}`, body: text.slice(0, 300) };
    const data = JSON.parse(text);
    return { success: true, models: data.data || [] };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

// Anthropic OAuth API 직접 호출 — ~/.claude/.credentials.json 의 accessToken 사용
ipcMain.handle('claude:fetch-usage-api', async () => {
  const fs = require('fs');
  const pathMod = require('path');
  const os = require('os');
  const credPath = pathMod.join(os.homedir(), '.claude', '.credentials.json');
  let token: string | null = null;
  try {
    const raw = fs.readFileSync(credPath, 'utf-8');
    const obj = JSON.parse(raw);
    token = obj?.claudeAiOauth?.accessToken;
  } catch (e: any) {
    return { success: false, error: 'credentials 읽기 실패: ' + e?.message };
  }
  if (!token) return { success: false, error: 'accessToken 없음 (claude login 필요)' };
  try {
    const fetchFn: any = (global as any).fetch;
    if (!fetchFn) return { success: false, error: 'fetch 미지원 (Node 18+ 필요)' };
    const resp = await fetchFn('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/oauth',
      },
    });
    const status = resp.status;
    const text = await resp.text();
    if (!resp.ok) return { success: false, error: `HTTP ${status}`, body: text.slice(0, 500) };
    const data = JSON.parse(text);
    return { success: true, data };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

// claude TUI 를 PTY 로 띄우고 /usage 명령 보내서 출력 캡처 (Anthropic 구독 한도 정보)
ipcMain.handle('claude:probe-usage-tui', async () => {
  return new Promise((resolve) => {
    let proc: any = null;
    let buf = '';
    let resolved = false;
    const finish = (result: any) => {
      if (resolved) return;
      resolved = true;
      try { proc?.write?.('\x03'); } catch {}
      try { proc?.write?.('/exit\n'); } catch {}
      setTimeout(() => { try { proc?.kill?.(); } catch {} }, 300);
      resolve(result);
    };
    try {
      const { execSync } = require('child_process');
      const isWin = process.platform === 'win32';
      // claude 실행 경로 직접 찾기 (cmd.exe wrapper 우회)
      let claudeBin = 'claude';
      try {
        const which = execSync(isWin ? 'where claude' : 'which claude', { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
        if (which) claudeBin = which;
      } catch {}
      proc = pty.spawn(claudeBin, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: process.env.USERPROFILE || process.env.HOME || process.cwd(),
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } as any,
      });
    } catch (e: any) {
      return resolve({ success: false, error: 'PTY spawn 실패: ' + (e?.message || e) });
    }
    let trustHandled = false;
    let usageStartLen = 0;
    let usageSent = false;
    const captureAndFinish = () => {
      const after = usageStartLen ? buf.slice(usageStartLen) : buf;
      const stripped = after
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[()][AB012]/g, '')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      finish({ success: true, raw: stripped, length: buf.length });
    };
    proc.onData((d: string) => {
      buf += d;
      if (!trustHandled && /trust this folder|이 폴더를 신뢰|1\.\s*Yes/i.test(buf)) {
        trustHandled = true;
        try { proc.write('1\r'); } catch {}
      }
      // /usage 패널 완성 감지 — "Esc to cancel" 마커 (TUI 패널 완전히 그려진 시점)
      if (usageSent && /Esc\s*to\s*cancel/i.test(buf.slice(usageStartLen))) {
        setTimeout(captureAndFinish, 200);
      }
    });
    proc.onExit(() => {});
    // 5초 후 /usage 송신 — 우선 더미 키(스페이스+백스페이스)로 입력 박스 활성화
    setTimeout(() => {
      if (usageSent) return;
      usageSent = true;
      // 입력 박스 깨우기 — 스페이스 후 백스페이스
      try { proc.write(' '); } catch {}
      setTimeout(() => { try { proc.write('\b'); } catch {} }, 100);
      setTimeout(() => {
        usageStartLen = buf.length;
        const cmd = '/usage';
        let i = 0;
        const typer = () => {
          if (i < cmd.length) {
            try { proc.write(cmd[i]); } catch {}
            i++;
            setTimeout(typer, 50);
          } else {
            // ENTER 두 번 시도 — \r 와 \n 모두
            setTimeout(() => { try { proc.write('\r\n'); } catch {} }, 300);
          }
        };
        typer();
      }, 300);
    }, 5000);
    // 최대 12초 후 무조건 캡처
    setTimeout(captureAndFinish, 12000);
    // 안전 타임아웃
    setTimeout(() => finish({ success: false, error: 'timeout', raw: buf }), 15000);
  });
});

// ~/.claude/projects 의 모든 세션 jsonl 을 스캔해 usage 합산 (전체 누적 사용량)
ipcMain.handle('claude:probe-usage', async () => {
  const fs = require('fs');
  const pathMod = require('path');
  const os = require('os');
  const claudeDir = pathMod.join(os.homedir(), '.claude', 'projects');
  let totalIn = 0, totalOut = 0, totalCacheCreate = 0, totalCacheRead = 0, sessionCount = 0, msgCount = 0;
  const projectStats: { project: string; in: number; out: number; cacheRead: number; sessions: number }[] = [];
  try {
    if (!fs.existsSync(claudeDir)) return { success: false, error: '~/.claude/projects 폴더 없음' };
    const projects = fs.readdirSync(claudeDir);
    for (const proj of projects) {
      const projPath = pathMod.join(claudeDir, proj);
      let stat;
      try { stat = fs.statSync(projPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let projIn = 0, projOut = 0, projCacheRead = 0, projSessions = 0;
      const walk = (dir: string) => {
        let items: string[] = [];
        try { items = fs.readdirSync(dir); } catch { return; }
        for (const it of items) {
          const full = pathMod.join(dir, it);
          let s; try { s = fs.statSync(full); } catch { continue; }
          if (s.isDirectory()) { walk(full); continue; }
          if (!it.endsWith('.jsonl')) continue;
          projSessions++;
          sessionCount++;
          let content = '';
          try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              const u = obj?.message?.usage;
              if (u) {
                msgCount++;
                projIn += u.input_tokens || 0;
                projOut += u.output_tokens || 0;
                projCacheRead += u.cache_read_input_tokens || 0;
                totalIn += u.input_tokens || 0;
                totalOut += u.output_tokens || 0;
                totalCacheCreate += u.cache_creation_input_tokens || 0;
                totalCacheRead += u.cache_read_input_tokens || 0;
              }
            } catch {}
          }
        }
      };
      walk(projPath);
      if (projIn || projOut) projectStats.push({ project: proj, in: projIn, out: projOut, cacheRead: projCacheRead, sessions: projSessions });
    }
    projectStats.sort((a, b) => (b.in + b.out) - (a.in + a.out));
    return { success: true, totalIn, totalOut, totalCacheCreate, totalCacheRead, sessionCount, msgCount, projects: projectStats.slice(0, 20) };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('claude:stop', (_e, { sessionId, requestId }: { sessionId: string; requestId?: string }) => {
  const { spawn } = require('child_process');
  // requestId 가 명시되면 해당 프로세스만 종료, 아니면 sessionId 키로 fallback (legacy)
  const procKey = requestId || sessionId;
  // 즉시 stream 차단 — taskkill 비동기 완료 전 stdout 버퍼에 남은 데이터/지연 close 가
  // 렌더러로 흘러가서 "응답이 계속 오는" 문제를 막는다.
  markAgentStopped(procKey);
  // 권한 모달 대기 중인 hook 들도 모두 deny 처리 — hook 자식이 5분 timeout 까지 살아남으면
  // taskkill /T 로 죽지 않고 새 approval request 를 계속 보내거나, claude CLI 가 hook 응답을
  // 기다리며 stdout 을 계속 흘릴 수 있음. (동시 다중 chat 은 드물어 전체 deny 가 실용적)
  for (const [aid, pending] of pendingApprovals) {
    try { pending.sock.write(JSON.stringify({ id: pending.reqId, result: 'deny', reason: 'User stopped' }) + '\n'); } catch {}
    pendingApprovals.delete(aid);
  }
  const proc = claudeProcesses.get(procKey);
  if (proc) {
    // shell 을 통해 spawn 했으므로 proc.kill() 만으로는 자식 claude 가 살아남는다.
    // Windows: taskkill /T /F 를 ★동기★ 로 실행 — 비동기 spawn 직후 곧바로 proc.kill 을 호출하면
    // cmd.exe 부모가 먼저 죽어 자식들이 orphan 이 되고 taskkill /T 가 트리를 못 따라간다.
    // (= stop 눌렀는데 claude.exe/node.exe 가 계속 살아있어 새 tool_use 가 흘러나오던 원인)
    // Unix: process group 시그널 (-pid) → SIGKILL
    try {
      if (process.platform === 'win32') {
        const pid = proc.pid;
        if (pid) {
          const { execFileSync } = require('child_process');
          try {
            execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
          } catch {
            // 동기 taskkill 실패 시 fallback — 비동기 + proc.kill
            try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
            try { proc.kill('SIGKILL'); } catch {}
          }
        }
      } else {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
      }
    } catch {}
    claudeProcesses.delete(procKey);
  }
  return { success: true };
});


ipcMain.handle('gemini:check', async () => {
  try {
    const { spawn } = require('child_process');
    const augmentedPath = buildAugmentedPath();
    const env = { ...process.env, PATH: augmentedPath, Path: augmentedPath };
    return await new Promise<{ installed: boolean; version?: string }>(resolve => {
      const proc = spawn('gemini', ['--version'], { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = '';
      proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
      proc.on('error', () => resolve({ installed: false }));
      proc.on('close', (code: number) => {
        if (code === 0) resolve({ installed: true, version: output.trim() });
        else resolve({ installed: false });
      });
    });
  } catch {
    return { installed: false };
  }
});

// 진단용 임시 dump — 렌더러가 sanitize 결과를 파일에 기록 (mermaid 디버그)
ipcMain.handle('debug:dump', (_e, { name, content }: { name: string; content: string }) => {
  try {
    const os = require('os'), path = require('path'), fs = require('fs');
    const safe = String(name || 'pepe-debug.txt').replace(/[^A-Za-z0-9._-]/g, '_');
    fs.writeFileSync(path.join(os.tmpdir(), safe), String(content ?? ''), 'utf-8');
  } catch {}
  return { ok: true };
});

ipcMain.handle('gemini:modelInfo', async () => {
  try {
    const fs = require('fs'), path = require('path'), os = require('os'), https = require('https');
    const credPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
    if (!fs.existsSync(credPath)) return { success: false, error: 'no oauth creds' };
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    // 토큰은 gemini CLI 가 oauth_creds.json 에 관리/갱신 — 그대로 사용 (만료 시 API 가 401 → 실패 처리)
    const token = cred.access_token;
    if (!token) return { success: false, error: 'no token' };
    const codeAssistPost = (endpoint: string, bodyObj: any, pick: (j: any) => any): Promise<any> => new Promise(resolve => {
      const body = JSON.stringify(bodyObj);
      const req = https.request(`https://cloudcode-pa.googleapis.com/v1internal:${endpoint}`,
        { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } },
        (res: any) => { let d = ''; res.on('data', (x: any) => d += x); res.on('end', () => { try { resolve(pick(JSON.parse(d))); } catch { resolve(null); } }); });
      req.on('error', () => resolve(null));
      req.write(body); req.end();
    });
    // 1) loadCodeAssist → 요금제(tier) + cloudaicompanionProject
    const ca: any = await codeAssistPost('loadCodeAssist',
      { metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }, j => j);
    const tier = ca?.currentTier;
    if (!tier) return { success: false, error: 'tier query failed' };
    // 2) retrieveUserQuota — ⚠ project 파라미터 필수. 없으면 전부 remainingFraction=1 인 placeholder 가 옴.
    const project = ca?.cloudaicompanionProject;
    const quota = project
      ? await codeAssistPost('retrieveUserQuota', { project }, j => j.buckets || null)
      : null;
    const quotaBuckets = Array.isArray(quota)
      ? quota.filter((b: any) => b && b.modelId).map((b: any) => ({
          modelId: b.modelId,
          remainingFraction: typeof b.remainingFraction === 'number' ? b.remainingFraction : null,
          resetTime: b.resetTime || null,
        }))
      : [];
    return { success: true, tierId: tier.id, tierName: tier.name, isPaid: tier.id !== 'free-tier', quotaBuckets };
  } catch (e: any) {
    return { success: false, error: String(e) };
  }
});

ipcMain.handle('gemini:send', async (_e, { sessionId, prompt, requestId, model, yolo, addDirs, sshTermId, sshSessions, localAttachmentRoots }: { sessionId: string; prompt: string; requestId?: string; model?: string; yolo?: boolean; addDirs?: string[]; sshTermId?: string; sshSessions?: { id: string; label: string }[]; localAttachmentRoots?: string[] }) => {
  try {
    // 같은 sessionId로 실행 중인 Codex 프로세스 정리
    const prevCodex = codexProcesses.get(sessionId);
    if (prevCodex) { try { prevCodex.kill('SIGKILL'); } catch {} codexProcesses.delete(sessionId); }
    const { spawn } = require('child_process');
    const procKey = requestId || sessionId;
    const os = require('os');
    const path = require('path');
    const fs = require('fs');

    const tmpFile = path.join(os.tmpdir(), `gemini-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    // 기본 응답 언어를 한국어로 (사용자가 다른 언어를 명시 요청하지 않는 한)
    const geminiLangPrefix = '[시스템 지시] 특별한 언어 요청이 없으면 항상 한국어로 응답하세요.\n\n';
    fs.writeFileSync(tmpFile, geminiLangPrefix + prompt, 'utf-8');

    const augmentedPath = buildAugmentedPath();
    const spawnEnv: any = {
      ...process.env,
      PATH: augmentedPath,
      Path: augmentedPath,
      PYTHONIOENCODING: 'utf-8',
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    };
    try {
      const prefs = loadUIPrefs();
      const ak = (prefs?.apiKeys?.codex || '').toString().trim();
      if (ak) spawnEnv.OPENAI_API_KEY = ak;
    } catch {}
  // OAuth 무료티어가 차단된 경우(Antigravity 이관 요구) API key 로 인증 가능.
    // uiPrefs.apiKeys.gemini 가 있으면 환경변수로 주입 — gemini-cli 가 OAuth 대신 이 키 사용.
    try {
      const prefs = loadUIPrefs();
      const ak = (prefs?.apiKeys?.gemini || prefs?.geminiApiKey || '').toString().trim();
      if (ak) spawnEnv.GEMINI_API_KEY = ak;
    } catch {}

    // ── SSH MCP 서버 연결 — sshTermId 가 있으면 gemini 에 pepe_ssh MCP(ssh_exec/read/write) 제공 ──
    // gemini 는 WebDAV UNC 워크스페이스를 못 쓰므로(realpathSync hang) 원격 파일은 MCP 로 처리.
    // GEMINI_CLI_SYSTEM_SETTINGS_PATH 로 임시 system settings 를 주입 → ~/.gemini/settings.json 오염 없음.
    let geminiSettingsTmp = '';
    const localRoots = normalizeLocalAttachmentRoots(localAttachmentRoots);
    if (sshTermId || localRoots.length > 0) {
      try {
        await startMcpControl();
        const geminiSettings: any = {
          mcpServers: {},
        };
        if (sshTermId) {
          const mcpScriptPath = path.join(os.tmpdir(), 'pepe-mcp-ssh-server.cjs');
          try {
            const existing = fs.existsSync(mcpScriptPath) ? fs.readFileSync(mcpScriptPath, 'utf-8') : '';
            if (existing !== mcpSshServerScript) fs.writeFileSync(mcpScriptPath, mcpSshServerScript, 'utf-8');
          } catch (e) { console.error('[gemini] MCP script extract failed:', e); }
          geminiSettings.mcpServers.pepe_ssh = {
            command: process.execPath,
            args: [mcpScriptPath],
            env: {
              PEPE_CTRL_PORT: String(mcpControlPort),
              PEPE_CTRL_TOKEN: mcpControlToken,
              PEPE_TERM_ID: sshTermId,
              PEPE_TERM_IDS: JSON.stringify(Array.isArray(sshSessions) && sshSessions.length > 0 ? sshSessions : [{ id: sshTermId, label: sshTermId }]),
              ELECTRON_RUN_AS_NODE: '1',
            },
            trust: true,
          };
        }
        if (localRoots.length > 0) {
          const localScriptPath = ensureTempScript('pepe-mcp-localfs-server.cjs', mcpLocalFsServerScript);
          geminiSettings.mcpServers.pepe_localfs = {
            command: process.execPath,
            args: [localScriptPath],
            env: buildLocalFsMcpEnv(localRoots),
            trust: true,
          };
        }
        // API 키가 설정돼 있으면 OAuth 무료티어 우회 — gemini-cli 가 GEMINI_API_KEY 모드로 인증.
        // (이게 없으면 OAuth(_doSetupUser) 흐름으로 빠져 IneligibleTierError 발생)
        // selectedType + enforcedType 모두 지정해 user 설정의 oauth-personal 을 확실히 override.
        // GOOGLE_API_KEY 도 호환을 위해 함께 설정.
        if (spawnEnv.GEMINI_API_KEY) {
          spawnEnv.GOOGLE_API_KEY = spawnEnv.GEMINI_API_KEY;
          geminiSettings.security = { auth: { selectedType: 'gemini-api-key', enforcedType: 'gemini-api-key' } };
        }
        geminiSettingsTmp = path.join(os.tmpdir(), `gemini-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        fs.writeFileSync(geminiSettingsTmp, JSON.stringify(geminiSettings), 'utf-8');
        spawnEnv.GEMINI_CLI_SYSTEM_SETTINGS_PATH = geminiSettingsTmp;
        console.log('[gemini] MCP(pepe_ssh) configured — termId:', sshTermId, '| settings:', geminiSettingsTmp);
      } catch (e) {
        console.error('[gemini] MCP setup failed:', e);
      }
    }

    const modelFlag = model ? ` -m ${model}` : '';
    // gemini 는 비대화형이라 항상 --yolo 필요 (없으면 도구가 막힘).
    // 승인 게이트는 렌더러의 "계획 승인" 흐름이 담당.
    void yolo;
    const yoloFlag = ' --yolo';
    const localDirs = Array.isArray(addDirs) ? addDirs.filter(d => d && !d.startsWith('\\\\')) : [];
    const skippedUnc = Array.isArray(addDirs) ? addDirs.filter(d => d && d.startsWith('\\\\')) : [];
    const includeFlag = localDirs.length > 0
      ? ' ' + localDirs.map(d => `--include-directories "${d}"`).join(' ')
      : '';
    const trustFlag = ' --skip-trust';
    const isWin = process.platform === 'win32';
    const cwd = process.env.USERPROFILE || process.env.HOME || os.homedir();
    // -o stream-json: 도구 호출/응답을 JSONL 이벤트로 출력 → 도구 타임라인 표시
    const shellCmd = isWin
      ? `chcp 65001 >nul && type "${tmpFile}" | gemini -o stream-json${modelFlag}${yoloFlag}${trustFlag}${includeFlag}`
      : `cat "${tmpFile}" | gemini -o stream-json${modelFlag}${yoloFlag}${trustFlag}${includeFlag}`;
    console.log('[gemini] include-dirs(local):', localDirs.length ? localDirs.join(', ') : '(none)');
    if (skippedUnc.length) console.log('[gemini] UNC dirs skipped (realpathSync hang 회피):', skippedUnc.join(', '));
    const proc = spawn(shellCmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv, cwd, windowsHide: true });
    geminiProcesses.set(procKey, proc);

    const cleanupTmp = () => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (geminiSettingsTmp) { try { fs.unlinkSync(geminiSettingsTmp); } catch {} }
    };

    console.log('[gemini] spawn — model:', model || 'default', '| yolo:', yolo !== false);
    const sendStream = (message: any) => sendAgentStream('claude:stream', { sessionId, requestId, message });
    // gemini stream-json 이벤트 → claude:stream (Claude 호환 포맷) 변환
    const gIdPrefix = requestId || `gmn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let geminiHadOutput = false;
    let gTextBuf = '';
    let gSegment = 0;
    // flush 시 누적 텍스트에 대한 최종 정리. 모델이 update_topic 의 내부
    // 파라미터(strategic_intent 등)를 평문으로 흘리는 경우가 있는데, 이 누수는
    // 여러 델타에 걸쳐 쪼개져 오므로 per-delta 정리로는 못 잡고 flush 시 한 번 더 거른다.
    // 'strategic_intent:' 다음부터 첫 마침표(.) 또는 줄바꿈까지를 한 단위로 제거.
    // update_topic / save_memory 같은 메타 도구의 함수 호출 형태를 균형 잡힌 괄호 파서로 제거.
    // (regex 만으로는 따옴표 안 ')' / unescape 된 따옴표 / 긴 multiline 값을 안정적으로 처리 못함)
    const stripFnCall = (s: string, fnName: string): string => {
      const re = new RegExp(`\\b${fnName}\\s*\\(`);
      let result = s;
      // 반복 — 같은 fnName 호출이 여러 개 있을 수 있음
      for (let safety = 0; safety < 20; safety++) {
        const m = re.exec(result);
        if (!m) break;
        const start = m.index;
        let depth = 1;
        let i = m.index + m[0].length;
        let inStr: string | null = null;
        while (i < result.length && depth > 0) {
          const c = result[i];
          if (inStr) {
            if (c === '\\' && i + 1 < result.length) { i += 2; continue; }
            if (c === inStr) inStr = null;
          } else {
            if (c === '"' || c === "'") inStr = c;
            else if (c === '(') depth++;
            else if (c === ')') depth--;
          }
          i++;
        }
        if (depth === 0) {
          // 닫는 ')' 찾음 → 그 뒤 선행 개행 1개까지 같이 제거
          let end = i;
          if (result[end] === '\n') end++;
          result = result.slice(0, start) + result.slice(end);
        } else {
          // 닫는 ')' 못 찾음 (모델이 미완 출력) → 줄 끝까지 잘라냄. 줄 없으면 전체.
          const nlIdx = result.indexOf('\n', m.index);
          if (nlIdx !== -1) result = result.slice(0, start) + result.slice(nlIdx + 1);
          else result = result.slice(0, start);
          break;
        }
      }
      return result;
    };
    const finalizeGeminiText = (s: string): string => {
      let out = s;
      // 1) update_topic(...) / save_memory(...) 함수 호출 — 균형 괄호 파서로 안전하게 제거
      out = stripFnCall(out, 'update_topic');
      out = stripFnCall(out, 'save_memory');
      // 2) bare 'strategic_intent: ...' narration 누수 — 첫 마침표/줄바꿈까지 제거
      out = out.replace(/\bstrategic_intent\s*:[^.\n]*[.\n]?/gi, '');
      // 3) 제거 후 선두 공백/개행 정리
      out = out.replace(/^\s+/, '');
      return out;
    };
    const flushGeminiText = () => {
      const cleaned = finalizeGeminiText(gTextBuf);
      if (cleaned.trim()) {
        sendStream({ type: 'assistant', message: { id: `${gIdPrefix}-m-${gSegment}`, content: [{ type: 'text', text: cleaned }] } });
        gSegment++;
      }
      gTextBuf = '';
    };
    // gemini 내부 메타 도구 — 화면에 표시하지 않음 (대화 토픽 관리용 bookkeeping)
    const GEMINI_META_TOOLS = new Set(['update_topic', 'save_memory']);
    const geminiMetaToolIds = new Set<string>();
    // 모델이 텍스트에 섞어 내보내는 update_topic(...) 등 토픽 지시문 제거
    // ⚠ trimStart() 금지 — 스트리밍 delta 마다 호출되므로 줄바꿈으로 시작하는 delta 의
    // 선행 개행이 잘려 인접 줄이 붙어버림(코드블록/mermaid 깨짐). 지시문만 제거.
    const stripGeminiDirectives = (s: string): string =>
      s.replace(/update_topic\s*\(\s*\w+\s*=\s*(['"])[\s\S]*?\1(?:\s*,\s*\w+\s*=\s*(['"])[\s\S]*?\2)*\s*\)/g, '');

    const handleGeminiEvent = (evt: any) => {
      const t = evt?.type;
      if (t === 'message') {
        // role=user 는 입력 에코 → 무시. assistant 만 누적.
        if (evt.role === 'assistant' && typeof evt.content === 'string' && evt.content) {
          const cleaned = stripGeminiDirectives(evt.content);
          if (cleaned) {
            geminiHadOutput = true;
            gTextBuf += cleaned;
          }
        }
      } else if (t === 'tool_use') {
        // 메타 도구는 타임라인에 표시 안 함
        if (GEMINI_META_TOOLS.has(evt.tool_name)) { geminiMetaToolIds.add(evt.tool_id); return; }
        geminiHadOutput = true;
        flushGeminiText(); // 도구 앞의 텍스트를 먼저 메시지로 확정 (타임라인 인터리브)
        sendStream({ type: 'assistant', message: { id: `${gIdPrefix}-a-${evt.tool_id}`, content: [{ type: 'tool_use', id: `${gIdPrefix}-${evt.tool_id}`, name: evt.tool_name || 'tool', input: evt.parameters || {} }] } });
      } else if (t === 'tool_result') {
        if (geminiMetaToolIds.has(evt.tool_id)) return; // 메타 도구 결과 무시
        const out = evt.output ?? evt.content ?? evt.result ?? evt.error ?? evt.status ?? '';
        sendStream({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `${gIdPrefix}-${evt.tool_id}`, content: typeof out === 'string' ? out : JSON.stringify(out), is_error: !!evt.status && evt.status !== 'success' }] } });
      } else if (t === 'error') {
        // Gemini CLI 는 응답 끝에 meta 도구(update_topic 등)가 있으면
        // "Invalid stream: empty response or malformed tool call" 같은 거짓 에러를 종종 뿜는다.
        // 이미 텍스트/도구 출력이 있었다면(geminiHadOutput) 응답은 정상 전달된 것이므로
        // 보류 중인 텍스트를 먼저 flush 하고 거짓 에러는 무시한다.
        const msg = String(evt.message || evt.error || '');
        if (geminiHadOutput || gTextBuf.trim()) {
          flushGeminiText();
          if (/invalid stream|empty response|malformed tool call/i.test(msg)) return;
        }
        sendStream({ type: 'error', text: msg || 'gemini error' });
      } else if (t === 'result') {
        // 토큰 사용량(컨텍스트) — 렌더러 usage 표시용
        if (evt.stats) sendStream({ type: 'gemini_usage', stats: evt.stats });
      }
      // init / thought → 무시 (done 은 close 에서)
    };

    let stdoutBuf = '';
    proc.stdout.setEncoding('utf-8');
    proc.stdout.on('data', (data: string) => {
      if (stoppedAgentProcs.has(procKey)) return; // stop 후 잔여 stdout 차단
      stdoutBuf += data;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        console.log('[gemini] stdout:', line.slice(0, 200));
        try { handleGeminiEvent(JSON.parse(line)); }
        catch { /* JSONL 아닌 노이즈 라인 → 무시 */ }
      }
    });
    // stderr 노이즈 — 재시도 백오프/경고 (gemini 가 내부 재시도 후 성공하면 무시)
    const GEMINI_NOISE = /YOLO mode is enabled|Ripgrep is not available|Falling back to GrepTool|256-color|overriding the built-in|^\s*$/;
    let stderrBuf = '';
    proc.stderr.on('data', (data: Buffer) => {
      if (stoppedAgentProcs.has(procKey)) return;
      const s = data.toString();
      stderrBuf += s;
      console.log('[gemini] stderr:', s.slice(0, 300).replace(/\n/g, ' '));
    });
    proc.on('error', (err: any) => {
      if (stoppedAgentProcs.has(procKey)) return;
      console.log('[gemini] spawn error:', err);
      sendStream({ type: 'error', text: String(err) });
    });
    proc.on('close', (code: number) => {
      // 남은 stdout 버퍼 + 마지막 텍스트 세그먼트 플러시
      if (stdoutBuf.trim()) {
        try { handleGeminiEvent(JSON.parse(stdoutBuf)); } catch {}
      }
      flushGeminiText();
      console.log('[gemini] close, code:', code, '| had output:', geminiHadOutput);
      // ⚠ 에러는 gemini 가 실제 실패(출력 없음)했을 때만 표시.
      // gemini 는 일시적 429/rate-limit 시 stderr 에 "quota will reset after 5s" 를 찍고
      // 내부 재시도 → 성공함. 출력이 있으면 stderr 는 재시도 노이즈이므로 무시.
      if (!geminiHadOutput) {
        const lines = stderrBuf.split('\n').filter(l => l.trim() && !GEMINI_NOISE.test(l));
        const joined = lines.join('\n');
        if (joined.trim()) {
          let errText = joined;
          if (/ModelNotFoundError|Requested entity was not found|code:\s*404/i.test(joined)) {
            errText = `❌ Gemini 모델을 찾을 수 없습니다 (404). 모델 선택에서 Flash 계열 모델을 선택하세요.`;
          } else if (/TerminalQuotaError|QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED|\b429\b/.test(joined)) {
            const qm = joined.match(/quota will reset after ([^\n.]+)/i);
            errText = qm
              ? `❌ Gemini API 할당량 초과. ${qm[1]} 후 재시도하세요.`
              : `❌ Gemini API 한도 초과. 잠시 후 다시 시도하세요.`;
          }
          console.log('[gemini] error reported:', errText.slice(0, 120));
          sendStream({ type: 'error', text: errText });
        }
      }
      cleanupTmp();
      geminiProcesses.delete(procKey);
      if (stoppedAgentProcs.has(procKey)) { stoppedAgentProcs.delete(procKey); return; }
      sendStream({ type: 'done', code });
    });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('gemini:stop', (_e, { sessionId, requestId }: { sessionId: string; requestId?: string }) => {
  const { spawn } = require('child_process');
  const procKey = requestId || sessionId;
  markAgentStopped(procKey);
  const proc = geminiProcesses.get(procKey);
  if (proc) {
    try {
      if (process.platform === 'win32') {
        const pid = proc.pid;
        if (pid) {
          const { execFileSync } = require('child_process');
          try {
            execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
          } catch {
            try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
            try { proc.kill('SIGKILL'); } catch {}
          }
        }
      } else {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
      }
    } catch {}
    geminiProcesses.delete(procKey);
  }
  return { success: true };
});

ipcMain.handle('codex:check', async () => {
  try {
    const { spawn } = require('child_process');
    const augmentedPath = buildAugmentedPath();
    const env = { ...process.env, PATH: augmentedPath, Path: augmentedPath };
    return await new Promise<{ installed: boolean; version?: string }>(resolve => {
      const proc = spawn('codex', ['--version'], { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = '';
      proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
      proc.on('error', () => resolve({ installed: false }));
      proc.on('close', (code: number) => {
        if (code === 0) resolve({ installed: true, version: output.trim() });
        else resolve({ installed: false });
      });
    });
  } catch {
    return { installed: false };
  }
});

// codex 토큰/요금 한도 — 가장 최근 세션 rollout 파일에서 추출 (대화 없이도 탭 진입 시 표시용)
ipcMain.handle('codex:rateLimits', async () => {
  try {
    const fs = require('fs'), path = require('path'), os = require('os');
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(sessionsDir)) return { success: false };
    let newest: string | null = null, newestMtime = 0;
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      let entries: string[] = [];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        const p = path.join(dir, name);
        let st: any;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p, depth + 1);
        else if (name.startsWith('rollout-') && name.endsWith('.jsonl') && st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs; newest = p;
        }
      }
    };
    walk(sessionsDir, 0);
    if (!newest) return { success: false };
    const lines = fs.readFileSync(newest, 'utf-8').split('\n').filter(Boolean);
    let lastUsage: any = null, totalUsage: any = null, ctxWindow: any = null, rateLimits: any = null, saw = false;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e?.payload?.type === 'token_count') {
          saw = true;
          const inf = e.payload.info;
          if (inf?.last_token_usage) lastUsage = inf.last_token_usage;
          if (inf?.total_token_usage) totalUsage = inf.total_token_usage;
          if (inf?.model_context_window) ctxWindow = inf.model_context_window;
          if (e.payload.rate_limits) rateLimits = e.payload.rate_limits;
        }
      } catch {}
    }
    if (!saw) return { success: false };
    return { success: true, info: { last_token_usage: lastUsage, total_token_usage: totalUsage, model_context_window: ctxWindow }, rateLimits };
  } catch (e: any) {
    return { success: false, error: String(e) };
  }
});

ipcMain.handle('codex:send', async (_e, { sessionId, prompt, requestId, model, approvalPolicy, effort, sshTermId, sshSessions, localAttachmentRoots }: { sessionId: string; prompt: string; requestId?: string; model?: string; approvalPolicy?: 'suggest' | 'auto-edit' | 'full-auto'; effort?: string; sshTermId?: string; sshSessions?: Array<{ id: string; label: string }>; localAttachmentRoots?: string[] }) => {
  try {
    // 같은 sessionId로 실행 중인 Gemini 프로세스 정리
    const prevGemini = geminiProcesses.get(sessionId);
    if (prevGemini) { try { prevGemini.kill('SIGKILL'); } catch {} geminiProcesses.delete(sessionId); }
    const { spawn } = require('child_process');
    const procKey = requestId || sessionId;
    const os = require('os');
    const path = require('path');
    const fs = require('fs');

    console.log('[codex] spawn start, prompt length:', prompt.length);
    console.log('[codex] model:', model || 'default', '| effort:', effort || 'default', '| approval:', approvalPolicy || 'suggest');

    const isWin = process.platform === 'win32';
    const tmpFile = path.join(os.tmpdir(), `codex-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    // codex.exe(Rust)는 stdin을 raw UTF-8로 검증하며 읽음 (invalid UTF-8 시 에러 후 종료)
    // → 반드시 UTF-8 바이트를 전달해야 함 (fallback shell 방식용 tmpFile)
    fs.writeFileSync(tmpFile, prompt, 'utf-8');

    const augmentedPath = buildAugmentedPath();
    const spawnEnv: any = {
      ...process.env,
      PATH: augmentedPath,
      Path: augmentedPath,
      PYTHONIOENCODING: 'utf-8',
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    };

    // ── SSH MCP 서버 연결 — sshTermId 가 있으면 codex 에 pepe_ssh MCP(ssh_exec/read/write/grep/glob) 제공 ──
    // codex 는 WebDAV UNC 워크스페이스를 못 쓰므로 원격 파일/명령은 MCP 로 처리.
    // -c override 는 값에 공백/#/따옴표가 있으면 깨지므로, 임시 CODEX_HOME 에 config.toml 을
    // 직접 쓰고 auth.json·기존 config.toml 을 복사 → 로그인 유지 + 사용자 ~/.codex 오염 없음.
    const realCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    let effectiveCodexHome = realCodexHome;
    let tmpCodexHome = '';
    const localRoots = normalizeLocalAttachmentRoots(localAttachmentRoots);
    if (sshTermId || localRoots.length > 0) {
      try {
        await startMcpControl();
        tmpCodexHome = path.join(os.tmpdir(), `pepe-codex-home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        fs.mkdirSync(tmpCodexHome, { recursive: true });
        // 로그인(auth.json) 유지를 위해 실제 홈에서 복사
        if (sshTermId) {
          for (const f of ['auth.json']) {
            try {
              const src = path.join(realCodexHome, f);
              if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpCodexHome, f));
            } catch {}
          }
        }
        // 기존 config.toml(모델/설정) 보존 — mcp_servers 블록만 덧붙임
        let baseToml = '';
        try {
          const srcCfg = path.join(realCodexHome, 'config.toml');
          if (fs.existsSync(srcCfg)) baseToml = fs.readFileSync(srcCfg, 'utf-8');
        } catch {}

        const tomlStr = (s: string) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
        const blocks: string[] = [];
        if (sshTermId) {
          const mcpScriptPath = path.join(os.tmpdir(), 'pepe-mcp-ssh-server.cjs');
          try {
            const existing = fs.existsSync(mcpScriptPath) ? fs.readFileSync(mcpScriptPath, 'utf-8') : '';
            if (existing !== mcpSshServerScript) fs.writeFileSync(mcpScriptPath, mcpSshServerScript, 'utf-8');
          } catch (e) { console.error('[codex] MCP script extract failed:', e); }
          const termIdsJson = JSON.stringify(Array.isArray(sshSessions) && sshSessions.length > 0 ? sshSessions : [{ id: sshTermId, label: sshTermId }]);
          blocks.push([
            '',
            '# pepe_ssh — PePe Terminal SSH MCP (auto-generated, do not edit)',
            '[mcp_servers.pepe_ssh]',
            `command = ${tomlStr(process.execPath)}`,
            `args = [${tomlStr(mcpScriptPath)}]`,
            '',
            '[mcp_servers.pepe_ssh.env]',
            `PEPE_CTRL_PORT = ${tomlStr(String(mcpControlPort))}`,
            `PEPE_CTRL_TOKEN = ${tomlStr(mcpControlToken)}`,
            `PEPE_TERM_ID = ${tomlStr(sshTermId)}`,
            `PEPE_TERM_IDS = ${tomlStr(termIdsJson)}`,
            `ELECTRON_RUN_AS_NODE = ${tomlStr('1')}`,
            '',
          ].join('\n'));
        }
        if (localRoots.length > 0) {
          const localScriptPath = ensureTempScript('pepe-mcp-localfs-server.cjs', mcpLocalFsServerScript);
          blocks.push([
            '',
            '# pepe_localfs — synced local attachment MCP (auto-generated, do not edit)',
            '[mcp_servers.pepe_localfs]',
            `command = ${tomlStr(process.execPath)}`,
            `args = [${tomlStr(localScriptPath)}]`,
            '',
            '[mcp_servers.pepe_localfs.env]',
            `PEPE_LOCAL_ROOTS = ${tomlStr(safeJsonArray(localRoots))}`,
            `ELECTRON_RUN_AS_NODE = ${tomlStr('1')}`,
            '',
          ].join('\n'));
        }
        fs.writeFileSync(path.join(tmpCodexHome, 'config.toml'), baseToml + '\n' + blocks.join('\n'), 'utf-8');
        effectiveCodexHome = tmpCodexHome;
        console.log('[codex] MCP configured via CODEX_HOME:', tmpCodexHome, '| termId:', sshTermId || '(none)', '| localRoots:', localRoots.length);
      } catch (e) {
        console.error('[codex] MCP setup failed:', e);
        effectiveCodexHome = realCodexHome;
        tmpCodexHome = '';
      }
    }
    if (effectiveCodexHome) { spawnEnv.CODEX_HOME = effectiveCodexHome; }

    const codexEffort = effort === 'max' ? 'xhigh' : effort;
    // codex 는 항상 danger-full-access(샌드박스 OFF)로 실행 — claude 와 동일하게 OS 샌드박스 없음.
    // Windows 샌드박스(restricted token)는 UNC/WebDAV 네트워크 경로를 차단하므로 반드시 꺼야 함.
    void approvalPolicy;
    // cwd 를 USERPROFILE 로 두면 codex 가 <cwd>/.codex/config.toml(사용자 실제 config)을
    // project-local config 로 인식해 'notify' 등 전역 전용 키 경고를 띄움. 임시 CODEX_HOME 이
    // 있으면 그 dir(.codex 하위 없음)을 cwd 로 써서 경고 제거. (SSH 컨텍스트는 MCP 절대경로라 cwd 무관)
    const cwd = tmpCodexHome || process.env.USERPROFILE || process.env.HOME || os.homedir();

    const modelFlag = model ? ` -m ${model}` : '';
    // effort: 값이 단순 영문(low/medium/high/xhigh)이므로 cmd.exe 에서 따옴표 불필요
    const effortFlag = codexEffort && ['low', 'medium', 'high', 'xhigh'].includes(codexEffort)
      ? ` -c model_reasoning_effort=${codexEffort}`
      : '';

    // Windows: codex.exe 직접 spawn — cmd.exe/type/chcp/codex.cmd/codex.js 계층을
    // 전부 우회. 이 계층들이 UTF-8 바이트를 코드페이지 변환해서 한글이 깨짐.
    // (claude 는 codex.js 같은 sub-binary spawn 계층이 없어 정상 동작)
    // codex.exe 에 Node pipe 로 UTF-8 바이트 직접 write → Rust 가 raw UTF-8 정상 수신.
    const findCodexExe = (): string | null => {
      try {
        const codexCmdLine = execSync('where codex.cmd', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }) as string;
        const codexCmdPath = codexCmdLine.split('\n')[0].trim();
        const npmDir = path.dirname(codexCmdPath);
        const codexPkgDir = path.join(npmDir, 'node_modules', '@openai', 'codex');
        const archName = process.arch === 'x64' ? 'x64' : 'arm64';
        const triple = process.arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
        const candidates = [
          path.join(codexPkgDir, 'node_modules', '@openai', `codex-win32-${archName}`, 'vendor', triple, 'codex', 'codex.exe'),
          path.join(codexPkgDir, 'vendor', triple, 'codex', 'codex.exe'),
        ];
        for (const p of candidates) { if (fs.existsSync(p)) return p; }
      } catch {}
      return null;
    };

    // 직접 spawn 용 인수 배열 (shell 없음 → 따옴표/이스케이프 불필요)
    const buildCodexArgs = (): string[] => {
      const args = ['exec', '--json'];
      if (model) args.push('-m', model);
      if (codexEffort && ['low', 'medium', 'high', 'xhigh'].includes(codexEffort)) {
        args.push('-c', `model_reasoning_effort="${codexEffort}"`);
      }
      args.push('--skip-git-repo-check');
      // 샌드박스 OFF — UNC/WebDAV 네트워크 경로 접근 허용
      args.push('--sandbox', 'danger-full-access');
      // SSH MCP(pepe_ssh)는 CODEX_HOME/config.toml 로 주입됨 (spawnEnv.CODEX_HOME)
      return args;
    };

    let proc: any;
    let usedDirectExe = false;
    const codexExePath = isWin ? findCodexExe() : null;

    if (isWin && codexExePath) {
      // ✅ codex.exe 직접 spawn + stdin pipe → UTF-8 바이트 그대로 전달
      const args = buildCodexArgs();
      console.log('[codex] direct exe:', codexExePath);
      console.log('[codex] args:', args.join(' '));
      proc = spawn(codexExePath, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv, cwd, windowsHide: true });
      usedDirectExe = true;
    } else if (isWin) {
      // fallback: codex.exe 못 찾으면 shell 방식 (한글 깨질 수 있음)
      const sandbox = `--sandbox danger-full-access`;
      const shellCmd = `chcp 65001 >nul && type "${tmpFile}" | codex exec --json${modelFlag}${effortFlag} --skip-git-repo-check ${sandbox}`;
      console.log('[codex] shell fallback (win):', shellCmd);
      proc = spawn(shellCmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv, cwd, windowsHide: true });
    } else {
      // Mac/Linux
      const sandbox = `--sandbox danger-full-access`;
      const shellCmd = `cat "${tmpFile}" | codex exec --json${modelFlag}${effortFlag} --skip-git-repo-check ${sandbox}`;
      console.log('[codex] shell cmd (unix):', shellCmd);
      proc = spawn(shellCmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv, cwd, windowsHide: true });
    }
    console.log('[codex] PATH has npm:', augmentedPath.toLowerCase().includes('npm'));
    codexProcesses.set(procKey, proc);

    // 직접 spawn 시: 프롬프트 UTF-8 바이트를 stdin 에 직접 write (cmd.exe 우회)
    if (usedDirectExe) {
      try {
        proc.stdin.write(Buffer.from(prompt, 'utf-8'));
        proc.stdin.end();
      } catch (e) {
        console.log('[codex] stdin write error:', e);
      }
    }

    const cleanupTmp = () => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (tmpCodexHome) { try { fs.rmSync(tmpCodexHome, { recursive: true, force: true }); } catch {} }
    };

    let stdoutBuf = '';
    let stdoutHadContent = false;
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[mGKHF]/g, '').replace(/\r/g, '');
    proc.stdout.setEncoding('utf-8');

    // ── codex --json (JSONL) 이벤트 → claude:stream (Claude 호환 포맷) 변환 ──
    // codex 의 도구 사용 내역(command_execution, file_change, mcp_tool_call 등)을
    // Claude 의 tool_use/tool_result 포맷으로 매핑 → 렌더러가 그대로 타임라인에 표시.
    const sendStream = (message: any) =>
      sendAgentStream('claude:stream', { sessionId, requestId, message });
    // codex item id(item_0, item_1...)는 매 실행마다 0부터 재사용됨 → 요청별 prefix 로
    // 전역 고유 id 생성 (없으면 메시지/툴 id 가 이전 응답과 충돌해 새 응답이 묻힘)
    const idPrefix = requestId || `cdx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let codexThreadId = '';

    // codex 세션 rollout 파일에서 token_count(토큰 사용량 + rate_limits) 추출.
    // exec --json stdout 에는 rate_limits 가 안 나오지만 ~/.codex/sessions/.../rollout-*.jsonl 에 기록됨.
    const readCodexSessionInfo = (threadId: string): any => {
      try {
        const sessionsDir = path.join(effectiveCodexHome, 'sessions');
        if (!fs.existsSync(sessionsDir)) return null;
        let target: string | null = null;
        const walk = (dir: string, depth: number) => {
          if (target || depth > 4) return;
          let entries: string[] = [];
          try { entries = fs.readdirSync(dir).sort().reverse(); } catch { return; }
          for (const name of entries) {
            if (target) return;
            const p = path.join(dir, name);
            let st: any;
            try { st = fs.statSync(p); } catch { continue; }
            if (st.isDirectory()) walk(p, depth + 1);
            else if (name.startsWith('rollout-') && name.endsWith('.jsonl') && threadId && name.includes(threadId)) {
              target = p;
              return;
            }
          }
        };
        walk(sessionsDir, 0);
        if (!target) return null;
        const lines = fs.readFileSync(target, 'utf-8').split('\n').filter(Boolean);
        // 모든 token_count 이벤트를 순회하며 필드별 최신값을 누적 수집.
        // (특정 이벤트가 rate_limits / model_context_window 를 누락해도 다른 이벤트에서 보강)
        let lastUsage: any = null, totalUsage: any = null, ctxWindow: any = null, rateLimits: any = null;
        let sawTokenCount = false;
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            if (e?.payload?.type === 'token_count') {
              sawTokenCount = true;
              const inf = e.payload.info;
              if (inf?.last_token_usage) lastUsage = inf.last_token_usage;
              if (inf?.total_token_usage) totalUsage = inf.total_token_usage;
              if (inf?.model_context_window) ctxWindow = inf.model_context_window;
              if (e.payload.rate_limits) rateLimits = e.payload.rate_limits;
            }
          } catch {}
        }
        if (!sawTokenCount) return null;
        return {
          info: { last_token_usage: lastUsage, total_token_usage: totalUsage, model_context_window: ctxWindow },
          rateLimits,
        };
      } catch {}
      return null;
    };
    const isToolItem = (t: string) => !!t && t !== 'agent_message' && t !== 'reasoning' && t !== 'error';
    const codexToolName = (it: any): string => {
      switch (it?.type) {
        case 'command_execution': return 'Shell';
        case 'file_change': return 'FileChange';
        case 'mcp_tool_call': return it.tool ? `${it.server || 'mcp'}.${it.tool}` : 'McpTool';
        case 'web_search': return 'WebSearch';
        case 'todo_list': return 'TodoList';
        case 'patch_apply': return 'PatchApply';
        default: return it?.type || 'Tool';
      }
    };
    const codexToolInput = (it: any): any => {
      switch (it?.type) {
        case 'command_execution': return { command: it.command };
        case 'file_change': return { changes: it.changes };
        case 'mcp_tool_call': return it.arguments || it.input || {};
        case 'web_search': return { query: it.query };
        case 'todo_list': return { items: it.items };
        default: { const { id, type, status, aggregated_output, ...rest } = it || {}; return rest; }
      }
    };
    // MCP 도구 결과({content:[{type:'text',text}]} 형태)에서 text 만 추출 → JSON/이스케이프 노출 방지
    const extractMcpText = (res: any): string => {
      if (res == null) return '';
      if (typeof res === 'string') {
        // 문자열이 JSON content 객체를 직렬화한 것이면 파싱해 text 추출
        const s = res.trimStart();
        if (s.startsWith('{') || s.startsWith('[')) {
          try { return extractMcpText(JSON.parse(res)); } catch { return res; }
        }
        return res;
      }
      const content = Array.isArray(res) ? res : (Array.isArray(res.content) ? res.content : null);
      if (content) {
        const txt = content
          .map((c: any) => (typeof c === 'string' ? c : (c?.type === 'text' ? c.text : (c?.text ?? ''))))
          .filter(Boolean).join('\n');
        if (txt) return txt;
      }
      try { return JSON.stringify(res, null, 2); } catch { return String(res); }
    };
    const codexToolResult = (it: any): string => {
      if (it?.type === 'command_execution') return it.aggregated_output || '';
      if (it?.type === 'mcp_tool_call') return extractMcpText(it.result);
      if (it?.type === 'file_change') return (it.changes || []).map((c: any) => `${c.kind || ''} ${c.path || ''}`.trim()).join('\n') || 'applied';
      if (it?.type === 'web_search') return it.query || '';
      if (it?.type === 'todo_list') return (it.items || []).map((t: any) => `${t.completed ? '✓' : '○'} ${t.text ?? t}`).join('\n');
      try { return JSON.stringify(it); } catch { return ''; }
    };
    const codexIsError = (it: any): boolean =>
      it?.status === 'failed' || (typeof it?.exit_code === 'number' && it.exit_code !== 0);

    const handleCodexEvent = (evt: any) => {
      const t = evt?.type;
      if (t === 'thread.started') {
        codexThreadId = evt?.thread_id || '';
      } else if (t === 'item.started' || t === 'item.updated') {
        const it = evt.item;
        if (it && isToolItem(it.type)) {
          stdoutHadContent = true;
          sendStream({ type: 'assistant', message: { id: `${idPrefix}-a-${it.id}`, content: [{ type: 'tool_use', id: `${idPrefix}-${it.id}`, name: codexToolName(it), input: codexToolInput(it) }] } });
        }
      } else if (t === 'item.completed') {
        const it = evt.item;
        if (!it) return;
        if (it.type === 'agent_message') {
          if (it.text) {
            stdoutHadContent = true;
            sendStream({ type: 'assistant', message: { id: `${idPrefix}-m-${it.id}`, content: [{ type: 'text', text: it.text }] } });
          }
        } else if (it.type === 'reasoning') {
          // 추론 단계 — 화면 표시 안 함
        } else if (it.type === 'error') {
          sendStream({ type: 'error', text: it.message || it.text || 'codex error' });
        } else if (isToolItem(it.type)) {
          stdoutHadContent = true;
          // tool_use (started 이벤트 누락 대비 — 중복 id 는 렌더러가 무시) + tool_result
          sendStream({ type: 'assistant', message: { id: `${idPrefix}-a-${it.id}`, content: [{ type: 'tool_use', id: `${idPrefix}-${it.id}`, name: codexToolName(it), input: codexToolInput(it) }] } });
          sendStream({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `${idPrefix}-${it.id}`, content: codexToolResult(it), is_error: codexIsError(it) }] } });
        }
      } else if (t === 'turn.completed') {
        // 토큰 사용량은 close 시점에 rollout 파일에서 더 정확히 읽음 (여기선 skip)
      } else if (t === 'error' || t === 'turn.failed') {
        const m = evt?.error?.message || evt?.message || evt?.error || 'codex error';
        sendStream({ type: 'error', text: typeof m === 'string' ? m : JSON.stringify(m) });
      }
      // thread.started / turn.started → 무시 (done 은 close 에서 전송)
    };

    const handleCodexLine = (rawLine: string) => {
      const line = stripAnsi(rawLine);
      if (!line.trim()) return;
      console.log('[codex] stdout line:', line.slice(0, 200));
      const trimmed = line.trimStart();
      // JSONL 이벤트
      if (trimmed.startsWith('{')) {
        try { handleCodexEvent(JSON.parse(trimmed)); return; }
        catch { /* JSON 아님 → 평문 처리로 폴백 */ }
      }
      // ERROR: {json} 평문
      if (trimmed.startsWith('ERROR:')) {
        const jsonStr = trimmed.slice('ERROR:'.length).trim();
        try {
          const obj = JSON.parse(jsonStr);
          sendStream({ type: 'error', text: obj?.error?.message || obj?.message || jsonStr });
        } catch {
          sendStream({ type: 'error', text: jsonStr || line });
        }
        return;
      }
      // 그 외 평문 → 텍스트
      stdoutHadContent = true;
      sendStream({ type: 'text', text: line + '\n' });
    };

    proc.stdout.on('data', (data: string) => {
      if (stoppedAgentProcs.has(procKey)) return; // stop 후 잔여 stdout 차단
      stdoutBuf += data;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const rawLine of lines) handleCodexLine(rawLine);
    });
    // Codex stderr = stdin echo + 세션 메타데이터
    let codexStderrBuf = '';
    const CODEX_STDERR_ERR = /^(error|Error|failed|invalid|quota|unauthorized|rate.limit|\d{3}\s)/i;
    const CODEX_META_RE = /^(Reading prompt from stdin|OpenAI Codex v|-----+|workdir:|model:|provider:|approval:|sandbox:|reasoning effort:|reasoning summaries:|session id:|tokens used|user$|codex$)/m;
    proc.stderr.on('data', (data: Buffer | string) => {
      if (stoppedAgentProcs.has(procKey)) return;
      const s = Buffer.isBuffer(data) ? data.toString('utf-8') : data;
      console.log('[codex] stderr:', s.slice(0, 300));
      codexStderrBuf += s;
    });
    proc.on('error', (err: any) => {
      if (stoppedAgentProcs.has(procKey)) return;
      console.log('[codex] spawn error:', err);
      sendAgentStream('claude:stream', { sessionId, requestId, message: { type: 'error', text: String(err) } });
    });
    proc.on('close', (code: number) => {
      console.log('[codex] close, code:', code);
      // 남은 stdout 버퍼 플러시
      if (stdoutBuf.trim()) handleCodexLine(stdoutBuf);
      // stderr: stdout 에 아무 내용도 없을 때만 명백한 에러 라인 표시
      if (!stdoutHadContent && code !== 0 && codexStderrBuf.trim()) {
        const errLines = codexStderrBuf.split('\n')
          .filter(l => l.trim() && !CODEX_META_RE.test(l) && CODEX_STDERR_ERR.test(l));
        if (errLines.length) {
          sendAgentStream('claude:stream', { sessionId, requestId, message: { type: 'error', text: errLines.join('\n') } });
        }
      }
      // 토큰 사용량 + rate_limits(요금 한도) — codex 세션 rollout 파일에서 추출
      try {
        const sess = readCodexSessionInfo(codexThreadId);
        console.log('[codex] rollout read — thread:', codexThreadId, '| found:', !!sess,
          sess ? `| info keys: ${sess.info ? Object.keys(sess.info).join(',') : 'none'} | ctxWin: ${sess.info?.model_context_window} | rateLimits: ${sess.rateLimits ? 'yes' : 'no'}` : '');
        if (sess && (sess.info || sess.rateLimits)) {
          sendStream({ type: 'codex_usage', info: sess.info, rateLimits: sess.rateLimits });
        }
      } catch (e) { console.log('[codex] session info read fail:', e); }
      cleanupTmp();
      codexProcesses.delete(procKey);
      if (stoppedAgentProcs.has(procKey)) { stoppedAgentProcs.delete(procKey); return; }
      sendAgentStream('claude:stream', { sessionId, requestId, message: { type: 'done', code } });
    });
    return { success: true };
  } catch (err: any) {
    console.log('[codex] exception:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('codex:stop', (_e, { sessionId, requestId }: { sessionId: string; requestId?: string }) => {
  const { spawn } = require('child_process');
  const procKey = requestId || sessionId;
  markAgentStopped(procKey);
  const proc = codexProcesses.get(procKey);
  if (proc) {
    try {
      if (process.platform === 'win32') {
        const pid = proc.pid;
        if (pid) {
          const { execFileSync } = require('child_process');
          try {
            execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
          } catch {
            try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
            try { proc.kill('SIGKILL'); } catch {}
          }
        }
      } else {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
      }
    } catch {}
    codexProcesses.delete(procKey);
  }
  return { success: true };
});

// ─── Custom LLM (OpenAI 호환 / LM Studio / Ollama 등) ─────────────────────────
// 외부 CLI 없이 fetch 로 직접 /v1/chat/completions 스트리밍. 클라이언트 측은 Claude 와
// 동일한 claude:stream 채널로 청크를 받아 표시한다.
const customLlmProcesses = new Map<string, AbortController>();
ipcMain.handle('custom-llm:check', () => {
  try {
    const prefs = loadUIPrefs();
    const baseUrl = (prefs?.apiKeys?.customBaseUrl || '').toString().trim();
    return { installed: !!baseUrl, version: baseUrl || 'not-configured' };
  } catch {
    return { installed: false, version: 'error' };
  }
});
ipcMain.handle('custom-llm:stop', (_e, { sessionId, requestId }: { sessionId: string; requestId?: string }) => {
  const procKey = requestId || sessionId;
  markAgentStopped(procKey);
  const ac = customLlmProcesses.get(procKey);
  if (ac) { try { ac.abort(); } catch {} customLlmProcesses.delete(procKey); }
  return { success: true };
});
ipcMain.handle('custom-llm:list-models', async (_e, args: { baseUrl?: string; apiKey?: string } = {}) => {
  try {
    // 인자로 받은 값(저장 전 입력 중 값) 우선, 없으면 디스크에서 로드
    let baseUrl = (args.baseUrl || '').toString().trim().replace(/\/+$/, '');
    let apiKey = (args.apiKey || '').toString().trim();
    if (!baseUrl) {
      const prefs = loadUIPrefs();
      baseUrl = (prefs?.apiKeys?.customBaseUrl || '').toString().trim().replace(/\/+$/, '');
      apiKey = apiKey || (prefs?.apiKeys?.customApiKey || '').toString().trim();
    }
    if (!baseUrl) return { success: false, error: 'Base URL 미설정' };
    const res = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    const data: any = await res.json();
    const ids = Array.isArray(data?.data) ? data.data.map((m: any) => m.id).filter(Boolean) : [];
    return { success: true, models: ids };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});
ipcMain.handle('custom-llm:send', async (_e, { sessionId, messages, requestId, sshTermId }: { sessionId: string; messages: Array<any>; requestId?: string; sshTermId?: string }) => {
  const procKey = requestId || sessionId;
  const reqId = requestId || `cus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let baseUrl = '';
  let apiKey = '';
  let model = '';
  try {
    const prefs = loadUIPrefs();
    baseUrl = (prefs?.apiKeys?.customBaseUrl || '').toString().trim().replace(/\/+$/, '');
    apiKey = (prefs?.apiKeys?.customApiKey || '').toString().trim();
    model = (prefs?.apiKeys?.customModel || '').toString().trim();
  } catch {}
  if (!baseUrl) {
    sendAgentStream('claude:stream', { sessionId, requestId: reqId, message: { type: 'error', text: '❌ Custom LLM 설정 누락: 🔑 버튼에서 Base URL 입력' } });
    return { success: false };
  }
  if (!model) {
    sendAgentStream('claude:stream', { sessionId, requestId: reqId, message: { type: 'error', text: '❌ Custom LLM 설정 누락: 🔑 버튼에서 Model 이름 입력' } });
    return { success: false };
  }
  const ac = new AbortController();
  customLlmProcesses.set(procKey, ac);
  // OpenAI tool schema — SSH 활성 시에만 도구 노출 (LM Studio/오픈소스 모델이 도구 호출 못 해도 텍스트로 응답)
  const tools = sshTermId ? [
    {
      type: 'function',
      function: {
        name: 'ssh_exec',
        description: '활성 SSH 원격 서버에서 셸 명령을 실행하고 stdout/stderr 를 반환합니다. 예: ls, cat, grep, find',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: '실행할 셸 명령' } },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ssh_read_file',
        description: '활성 SSH 원격 서버의 파일을 읽어 텍스트로 반환합니다.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '원격 파일 절대 경로' } },
          required: ['path'],
        },
      },
    },
  ] : undefined;
  const runTool = async (name: string, argsJson: string): Promise<string> => {
    if (!sshTermId) return 'ERROR: 활성 SSH 세션 없음';
    let args: any = {};
    try { args = JSON.parse(argsJson || '{}'); } catch { return 'ERROR: invalid JSON arguments'; }
    try {
      const bridge = getSSHBridge();
      if (name === 'ssh_exec') {
        const cmd = String(args.command || '').slice(0, 4000);
        if (!cmd) return 'ERROR: command 비어있음';
        const out = await bridge.execCommand(sshTermId, cmd, 30000);
        return out.slice(0, 50000);
      }
      if (name === 'ssh_read_file') {
        const p = String(args.path || '');
        if (!p) return 'ERROR: path 비어있음';
        const buf = await bridge.handleSFTPReadFile(sshTermId, p);
        return buf.toString('utf-8').slice(0, 100000);
      }
      return `ERROR: 알 수 없는 도구 ${name}`;
    } catch (e: any) {
      return `ERROR: ${String(e?.message || e)}`;
    }
  };
  // 도구 루프: 최대 8회 반복하며 assistant.tool_calls 처리
  let conv = Array.isArray(messages) ? [...messages] : [];
  // SSH 활성 시: 모델이 도구를 적극적으로 활용하도록 system 메시지 prepend (이미 있으면 skip).
  if (sshTermId && !conv.some(m => m.role === 'system')) {
    const sys = [
      '당신은 원격 SSH 서버의 소스 코드를 철저히 분석하는 시니어 엔지니어입니다.',
      '제공된 도구 ssh_exec(셸 명령), ssh_read_file(파일 읽기) 를 적극적으로 여러 번 사용해 충분한 정보를 모은 뒤 분석을 작성하세요.',
      '',
      '## 필수 절차',
      '1. ssh_exec 로 `ls -la <경로>` 로 디렉토리 구조 파악',
      '2. ssh_exec 로 `ls -la <경로>/*.c <경로>/*.h` 또는 find 로 헤더/소스 파일 목록 확보',
      '3. **최소 3~5개 이상의 핵심 소스 파일/헤더를 ssh_read_file 로 읽으세요.** (메인 진입 함수, 헤더, 핵심 모듈 등)',
      '4. 충분히 읽었다고 판단되면 한국어 마크다운으로 다음 항목을 **반드시 모두 포함**해 분석 보고서 작성:',
      '   - **모듈 개요** (디렉토리 역할, 전체 구조)',
      '   - **주요 파일 설명** (각 파일별 역할, 책임)',
      '   - **핵심 함수/구조체** (이름, 시그니처, 동작 요약)',
      '   - **의존 관계** (헤더 include, 모듈 간 호출)',
      '   - **개선/주의 사항** (있다면)',
      '',
      '## 절대 규칙',
      '- 추측한 파일명을 사용하지 마세요. 반드시 ls 결과에 있는 정확한 이름을 사용하세요.',
      '- "No such file" 에러가 나면 멈추지 말고 다른 파일을 시도하세요.',
      '- 1~2개 파일만 읽고 분석을 끝내면 안 됩니다. 최소 3개 이상 읽어야 합니다.',
      '- 도구 호출이 끝나면 반드시 **상세한 마크다운 보고서**를 작성하세요. 짧은 답변은 금지입니다.',
      '- **이미 호출한 도구를 같은 인자로 다시 호출하지 마세요.** 이전 결과를 그대로 활용하세요. 같은 인자로 중복 호출을 감지하면 즉시 멈추고 분석을 작성하세요.',
      '- 도구 호출이 끝났다고 판단되면 **충분히 길고 구체적인 한국어 분석 보고서**(코드 인용 포함)를 마크다운으로 작성하세요.',
      '',
      '## 분석 보고서 작성 시 다이어그램 필수',
      '단순 텍스트만으로는 부족합니다. 사용자 환경은 **mermaid 다이어그램을 자동 SVG 렌더**하므로 반드시 다음을 포함하세요:',
      '',
      '1. **모듈 구조도(flowchart)** — 주요 파일들의 호출/의존 관계',
      '   ```mermaid',
      '   flowchart TB',
      '     Main[RrdhMain.c] --> Proc[RrdhProc.c]',
      '     Proc --> Hdr[Rrdh.h]',
      '   ```',
      '',
      '2. **DFD (데이터 흐름도)** — 입출력/메시지/큐 흐름이 있다면',
      '   ```mermaid',
      '   flowchart LR',
      '     입력원 -->|메시지| 파싱 -->|구조체| 로직 -->|결과| 출력',
      '   ```',
      '',
      '3. **시퀀스 다이어그램** — 함수 호출 순서가 중요하다면',
      '   ```mermaid',
      '   sequenceDiagram',
      '     Main->>Proc: doProcess()',
      '     Proc->>DB: query()',
      '     DB-->>Proc: result',
      '   ```',
      '',
      '**다이어그램 작성 규칙:**',
      '- 라벨에 영문 식별자 권장 (한글 가능하지만 영문이 더 안정적)',
      '- 노드 ID 는 영문/숫자/언더스코어만, label 에 한글 설명 가능: `Main["메인 진입점"]`',
      '- 다크 테마이므로 색상은 지정하지 마세요 (style 절 사용 금지)',
      '- 도형 Unicode(★ ◆ ▲ 등)를 라벨 prefix 로 쓰지 마세요',
      '',
      '## 보고서 권장 구조',
      '1. **개요** (1~2문단)',
      '2. **모듈 구조도** (mermaid flowchart)',
      '3. **주요 파일별 역할** (각 파일마다 짧은 설명 + 핵심 함수/구조체)',
      '4. **데이터 흐름** (mermaid DFD)',
      '5. **핵심 시퀀스** (mermaid sequenceDiagram, 1~2개)',
      '6. **개선/주의 사항** (있으면)',
    ].join('\n');
    conv = [{ role: 'system', content: sys }, ...conv];
  }
  const MAX_ITER = 30;
  const toolCache = new Map<string, string>(); // name|args → result (재호출 시 그대로 반환)
  const readPaths = new Set<string>(); // ssh_read_file 로 이미 읽은 경로
  const execCmds = new Set<string>();  // ssh_exec 로 이미 실행한 command
  // ls 결과에서 발견한 소스 파일 (.c/.h/.cpp/.hpp). 분석 종료 조건으로 사용.
  const discoveredSources = new Set<string>();
  const extractSources = (lsOutput: string, baseDir: string) => {
    // "drwxr-xr-x. 2 dev users 863 Jun 23 RrdhMain.c" 패턴에서 파일명 추출.
    // 파일 라인은 보통 -로 시작, 디렉토리(d)는 제외. 한 줄당 1파일.
    const lines = lsOutput.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || !/^-/.test(t)) continue; // 파일만 (디렉토리 제외)
      const m = t.match(/([^\s/]+\.(?:c|cpp|cc|h|hpp))$/i);
      if (m && !/^\./.test(m[1])) {
        discoveredSources.add(`${baseDir.replace(/\/+$/, '')}/${m[1]}`);
      }
    }
  };
  try {
    for (let iter = 0; iter < MAX_ITER; iter++) {
      if (stoppedAgentProcs.has(procKey)) break;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, stream: true, messages: conv, ...(tools ? { tools, tool_choice: 'auto' } : {}) }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        sendAgentStream('claude:stream', { sessionId, requestId: reqId, message: { type: 'error', text: `❌ Custom LLM HTTP ${res.status}: ${body.slice(0, 500)}` } });
        return { success: false };
      }
      const reader = res.body?.getReader();
      if (!reader) {
        sendAgentStream('claude:stream', { sessionId, requestId: reqId, message: { type: 'error', text: '❌ 응답 스트림을 읽을 수 없습니다' } });
        return { success: false };
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantContent = '';
      const toolCallsAcc: Record<number, { id: string; name: string; arguments: string }> = {};
      let finishReason: string | null = null;
      while (true) {
        if (stoppedAgentProcs.has(procKey)) break;
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t || !t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const ch = j.choices?.[0];
            const delta = ch?.delta;
            if (delta?.content) {
              assistantContent += delta.content;
              sendAgentStream('claude:stream', { sessionId, requestId: reqId, message: { type: 'text', text: String(delta.content) } });
            }
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: '', name: '', arguments: '' };
                if (tc.id) toolCallsAcc[idx].id = tc.id;
                if (tc.function?.name) toolCallsAcc[idx].name = tc.function.name;
                if (typeof tc.function?.arguments === 'string') toolCallsAcc[idx].arguments += tc.function.arguments;
              }
            }
            if (ch?.finish_reason) finishReason = ch.finish_reason;
          } catch { /* skip */ }
        }
      }
      const toolCallList = Object.keys(toolCallsAcc).map(k => toolCallsAcc[Number(k)]).filter(tc => tc.name);
      // assistant 턴 기록
      const assistantMsg: any = { role: 'assistant', content: assistantContent || null };
      if (toolCallList.length > 0) {
        assistantMsg.tool_calls = toolCallList.map(tc => ({ id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`, type: 'function', function: { name: tc.name, arguments: tc.arguments } }));
      }
      conv.push(assistantMsg);
      // 도구 호출 없이 종료하려는 경우: 발견한 소스 파일 중 안 읽은 게 있으면 강제로 더 읽도록 user 메시지 주입.
      if (toolCallList.length === 0) {
        const unreadSources = [...discoveredSources].filter(p => !readPaths.has(p));
        if (unreadSources.length > 0) {
          sendAgentStream('claude:stream', { sessionId, requestId: reqId, message: { type: 'text', text: `\n\n— 시스템: 분석 종료 거부 (${unreadSources.length}개 파일 미독). 추가 읽기 강제 —\n\n` } });
          conv.push({
            role: 'user',
            content: [
              `❌ 아직 분석을 종료하면 안 됩니다. ${unreadSources.length}개의 소스 파일이 안 읽혔습니다.`,
              `반드시 다음 파일들을 ssh_read_file 로 모두 읽으세요:`,
              ...unreadSources.map(p => `- ${p}`),
              `한 번에 여러 파일을 병렬로 호출해도 됩니다. 즉시 ssh_read_file 호출하세요.`,
            ].join('\n'),
          });
          continue;
        }
        break; // 도구 호출 없음 + 안 읽은 파일도 없음 → 종료
      }
      if (finishReason === 'stop' && toolCallList.length === 0) break;
      // 도구 실행 + 결과. Claude 와 동일하게 `{type:'assistant', message:{content:[{type:'tool_use',...}]}}`
      // 와 `{type:'user', message:{content:[{type:'tool_result',...}]}}` 형식으로 emit 해 렌더러의
      // toolTimeline UI(접이식 카드)와 매칭되도록 함.
      const toolUseBlocks: any[] = [];
      const toolResultBlocks: any[] = [];
      for (const tc of assistantMsg.tool_calls) {
        const key = `${tc.function.name}|${tc.function.arguments}`;
        let parsedInput: any = {};
        try { parsedInput = JSON.parse(tc.function.arguments || '{}'); } catch { parsedInput = { _raw: tc.function.arguments }; }
        toolUseBlocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parsedInput });
        let result: string;
        if (toolCache.has(key)) {
          // 이미 호출한 도구 — 실제 실행 skip, 짧은 안내 메시지로 응답.
          // 모델이 같은 결과를 다시 받으면 또 같은 결정을 내릴 수 있어 "재호출 금지" 명시.
          const target = tc.function.name === 'ssh_read_file' ? (parsedInput?.path || '') : (parsedInput?.command || '');
          result = `[SKIPPED — 이미 처리된 호출] ${tc.function.name}(${target})\n이 도구를 같은 인자로 다시 호출하지 마세요. 이미 처리한 결과를 활용하거나 다른 항목을 시도하세요.`;
        } else {
          const raw = await runTool(tc.function.name, tc.function.arguments);
          toolCache.set(key, raw);
          if (tc.function.name === 'ssh_read_file' && parsedInput?.path) readPaths.add(String(parsedInput.path));
          if (tc.function.name === 'ssh_exec' && parsedInput?.command) {
            execCmds.add(String(parsedInput.command));
            // ls 결과면 소스 파일 목록 자동 추출 (모델에게 어디서 찾아야 할지 알려주기 위함)
            const cmd = String(parsedInput.command);
            const lsm = cmd.match(/\bls\b[^|;&]*?(\/[^\s|;&]+)/);
            if (lsm) extractSources(raw, lsm[1]);
          }
          // 진행도 — 발견한 소스 파일 중 안 읽은 게 있으면 명시
          const unreadSources = [...discoveredSources].filter(p => !readPaths.has(p));
          const MIN_READS = Math.max(6, discoveredSources.size);
          const remaining = Math.max(unreadSources.length, MIN_READS - readPaths.size);
          const progressBlock = remaining > 0
            ? `\n\n⚠️ **분석 진행도: ${readPaths.size}/${discoveredSources.size || MIN_READS} 소스 파일 읽음.**\n` +
              `**아직 읽지 않은 파일 (반드시 모두 ssh_read_file 로 읽으세요):**\n${unreadSources.length > 0 ? unreadSources.map(p => `- ${p}`).join('\n') : '(ls 한 번 더 실행해서 새 파일 발견 필요)'}\n\n` +
              `❌ 분석 종료 금지. 위 파일을 즉시 모두 읽으세요. 한 번에 여러 파일을 병렬 호출해도 됩니다.`
            : `\n\n✅ 모든 소스 파일(${readPaths.size}개) 읽음 — 충분히 정보를 모았습니다. 이제 **상세한 한국어 마크다운 분석 보고서**를 작성하세요. 짧으면 안 됩니다.`;
          const hint = [
            '',
            '---',
            `(누적 처리: 읽은파일=${readPaths.size}개, 실행명령=${execCmds.size}개)`,
            readPaths.size > 0 ? `이미 읽은 파일 (재호출 금지): ${[...readPaths].join(', ')}` : '',
            execCmds.size > 0 ? `이미 실행한 명령 (재호출 금지): ${[...execCmds].join(' / ')}` : '',
            '⚠ 같은 인자로 다시 호출하면 SKIPPED 됩니다.',
            progressBlock,
          ].filter(Boolean).join('\n');
          result = raw + hint;
        }
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
        conv.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      sendAgentStream('claude:stream', { sessionId, requestId: reqId, message: {
        type: 'assistant',
        message: { id: `asst-${reqId}-${iter}`, content: toolUseBlocks },
      }});
      sendAgentStream('claude:stream', { sessionId, requestId: reqId, message: {
        type: 'user',
        message: { content: toolResultBlocks },
      }});
    }
    sendAgentStream('claude:stream', { sessionId, requestId: reqId, message: { type: 'result', subtype: 'success' } });
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      sendAgentStream('claude:stream', { sessionId, requestId: reqId, message: { type: 'error', text: `❌ Custom LLM 오류: ${String(err?.message || err)}` } });
    }
  } finally {
    customLlmProcesses.delete(procKey);
  }
  return { success: true };
});

// ── Antigravity (agy.exe) IPC 핸들러 ──────────────────────────────────────────
ipcMain.handle('antigravity:check', async () => {
  try {
    const { spawn } = require('child_process');
    const agyPath = findAgyExePath();
    if (!agyPath) return { installed: false, error: 'agy executable not found' };
    const augmentedPath = buildAugmentedPath();
    const env = { ...process.env, PATH: augmentedPath, Path: augmentedPath };
    return await new Promise(resolve => {
      const proc = spawn(agyPath, ['--version'], { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = ''; let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      proc.on('error', (err: any) => resolve({ installed: false, error: String(err?.message || err) }));
      proc.on('close', (code: number) => {
        if (code === 0) resolve({ installed: true, version: stdout.trim() || 'agy', path: agyPath });
        else resolve({ installed: false, error: stderr.trim() || `exit ${code}` });
      });
    });
  } catch (err: any) { return { installed: false, error: String(err?.message || err) }; }
});

ipcMain.handle('antigravity:modelInfo', async () => {
  try {
    const agyPath = findAgyExePath();
    if (!agyPath) return { success: false, error: 'agy 미설치' };
    // agy 는 gemini-cli 와 동일한 ~/.gemini/oauth_creds.json + cloudcode-pa.googleapis.com 사용.
    const fsm = require('fs'), pathm = require('path'), osm = require('os'), https = require('https');
    const credPath = pathm.join(osm.homedir(), '.gemini', 'oauth_creds.json');
    if (!fsm.existsSync(credPath)) return { success: false, error: 'no oauth creds (agy 로그인 필요)' };
    let cred = JSON.parse(fsm.readFileSync(credPath, 'utf-8'));
    // 토큰 만료 시 refresh_token 으로 갱신
    if (cred.expiry_date && cred.expiry_date < Date.now() + 60_000 && cred.refresh_token) {
      try {
        const params = new URLSearchParams({
          client_id: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
          client_secret: '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',
          refresh_token: cred.refresh_token,
          grant_type: 'refresh_token',
        }).toString();
        const refreshed: any = await new Promise(resolve => {
          const req = https.request('https://oauth2.googleapis.com/token',
            { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
            (res: any) => { let d = ''; res.on('data', (x: any) => d += x); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
          req.on('error', () => resolve(null));
          req.write(params); req.end();
        });
        if (refreshed?.access_token) {
          cred.access_token = refreshed.access_token;
          if (refreshed.expires_in) cred.expiry_date = Date.now() + refreshed.expires_in * 1000;
          if (refreshed.id_token) cred.id_token = refreshed.id_token;
          try { fsm.writeFileSync(credPath, JSON.stringify(cred, null, 2), 'utf-8'); } catch {}
        }
      } catch (e) { console.error('[antigravity] token refresh failed:', e); }
    }
    const token = cred.access_token;
    if (!token) return { success: false, error: 'no token' };
    const codeAssistPost = (endpoint: string, bodyObj: any, pick: (j: any) => any): Promise<any> => new Promise(resolve => {
      const body = JSON.stringify(bodyObj);
      const req = https.request(`https://cloudcode-pa.googleapis.com/v1internal:${endpoint}`,
        { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } },
        (res: any) => { let d = ''; res.on('data', (x: any) => d += x); res.on('end', () => { try { resolve(pick(JSON.parse(d))); } catch { resolve(null); } }); });
      req.on('error', () => resolve(null));
      req.write(body); req.end();
    });
    const ca: any = await codeAssistPost('loadCodeAssist',
      { metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }, j => j);
    const tier = ca?.currentTier;
    if (!tier) return { success: false, error: 'tier query failed (access_token 만료일 수 있음 — agy 로 한번 명령 실행해 갱신 후 재시도)' };
    const project = ca?.cloudaicompanionProject;
    const quota = project
      ? await codeAssistPost('retrieveUserQuota', { project }, j => j.buckets || null)
      : null;
    const quotaBuckets = Array.isArray(quota)
      ? quota.filter((b: any) => b && b.modelId).map((b: any) => ({
          modelId: b.modelId,
          remainingFraction: typeof b.remainingFraction === 'number' ? b.remainingFraction : null,
          resetTime: b.resetTime || null,
        }))
      : [];
    return { success: true, tierId: tier.id, tierName: tier.name, isPaid: tier.id !== 'free-tier', quotaBuckets };
  } catch (e: any) { return { success: false, error: String(e) }; }
});

// agy 인터랙티브 TUI 를 PTY 로 띄우고 /usage 명령 보내서 출력 캡처 → 파싱
ipcMain.handle('antigravity:probeUsageTui', async () => {
  return new Promise((resolve) => {
    let proc: any = null;
    let buf = '';
    let resolved = false;
    const finish = (result: any) => {
      if (resolved) return;
      resolved = true;
      try { proc?.write?.('\x03'); } catch {}
      try { proc?.write?.('/exit\r'); } catch {}
      setTimeout(() => { try { proc?.kill?.(); } catch {} }, 300);
      resolve(result);
    };
    const agyPath = findAgyExePath();
    if (!agyPath) return resolve({ success: false, error: 'agy 미설치' });
    try {
      proc = pty.spawn(agyPath, [], {
        name: 'xterm-256color', cols: 120, rows: 50,
        cwd: process.env.USERPROFILE || process.env.HOME || process.cwd(),
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } as any,
      });
    } catch (e: any) {
      return resolve({ success: false, error: 'PTY spawn 실패: ' + (e?.message || e) });
    }
    let usageStartLen = 0;
    let usageSent = false;
    const stripAnsi = (s: string) => s
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b[()][AB012]/g, '')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    // raw text 에서 buckets 파싱: 그룹별 (Weekly Limit, Five Hour Limit) percentage / refresh-in
    const parseUsage = (raw: string) => {
      const lines = raw.split(/\r?\n/).map(l => l.trim());
      const groups: any[] = [];
      let current: any = null;
      for (const ln of lines) {
        const mGroup = ln.match(/^(GEMINI|CLAUDE.*GPT|ANTHROPIC|GOOGLE|OPENAI)[\w\s&]*MODELS?$/i);
        if (mGroup) {
          if (current) groups.push(current);
          current = { name: ln, models: '', weekly: null, fiveHour: null };
          continue;
        }
        const mModels = ln.match(/Models? within this group:\s*(.+)$/i);
        if (mModels && current) { current.models = mModels[1].trim(); continue; }
        const mPct = ln.match(/(\d+(?:\.\d+)?)%\s*remaining\s*[·•]\s*Refreshes in\s+([\d\w\s]+)/i);
        if (mPct && current) {
          const entry = { remainingPct: parseFloat(mPct[1]), refreshIn: mPct[2].trim() };
          if (current.weekly == null) current.weekly = entry;
          else if (current.fiveHour == null) current.fiveHour = entry;
          continue;
        }
        const mAvail = ln.match(/Quota available/i);
        if (mAvail && current) {
          const entry = { remainingPct: 100, refreshIn: '' };
          if (current.weekly == null) current.weekly = entry;
          else if (current.fiveHour == null) current.fiveHour = entry;
          continue;
        }
        const mEmail = ln.match(/Account:\s*(\S+@\S+)/i);
        if (mEmail) (groups as any).account = mEmail[1];
      }
      if (current) groups.push(current);
      return { account: (groups as any).account || '', groups };
    };
    const captureAndFinish = () => {
      const stripped = stripAnsi(buf);
      const parsed = parseUsage(stripped);
      finish({ success: true, raw: stripped.slice(-6000), parsed });
    };
    proc.onData((d: string) => {
      buf += d;
      // TUI 가 로드되어 prompt 입력이 가능해진 시점 감지 — agy 에서는 "?" 또는 ">" 프롬프트가 나타남
      if (!usageSent && /[?>│|]\s*$/m.test(stripAnsi(buf).slice(-50))) {
        usageSent = true;
        setTimeout(() => {
          usageStartLen = buf.length;
          try { proc.write('/usage\r'); } catch {}
        }, 500);
      }
      // /usage 완성 마커 — Refreshes in 이 2번 이상 보이거나, "Five Hour" 가 보이면
      const sub = stripAnsi(buf.slice(usageStartLen));
      if (usageSent && (/Five Hour Limit/i.test(sub) || (sub.match(/Refreshes in/g) || []).length >= 2 || /Quota available/i.test(sub))) {
        setTimeout(captureAndFinish, 800);
      }
    });
    proc.onExit(() => {});
    setTimeout(() => { if (!usageSent) { usageSent = true; usageStartLen = buf.length; try { proc.write('/usage\r'); } catch {} } }, 6000);
    setTimeout(captureAndFinish, 15000);
    setTimeout(() => finish({ success: false, error: 'timeout', raw: stripAnsi(buf).slice(-3000) }), 18000);
  });
});

// 외부 cmd 창에서 agy 인터랙티브 + /quota 명령 실행 — 사용량 시각화 (agy TUI 직접 표시)
ipcMain.handle('antigravity:openUsage', async () => {
  try {
    const agyPath = findAgyExePath();
    if (!agyPath) return { success: false, error: 'agy 미설치' };
    const { spawn } = require('child_process');
    // start cmd /k "title PePe Antigravity Usage && <agyPath> -i /quota"
    spawn('cmd.exe', ['/c', 'start', '"PePe Antigravity Usage"', 'cmd.exe', '/k', `"${agyPath}" -i "/quota"`], {
      shell: false, detached: true, stdio: 'ignore', windowsHide: false,
    }).unref();
    return { success: true };
  } catch (e: any) { return { success: false, error: String(e) }; }
});

ipcMain.handle('antigravity:send', async (_e, { sessionId, prompt, requestId, model, yolo, addDirs, sshTermId, sshSessions, localAttachmentRoots }: { sessionId: string; prompt: string; requestId?: string; model?: string; yolo?: boolean; addDirs?: string[]; sshTermId?: string; sshSessions?: { id: string; label: string }[]; localAttachmentRoots?: string[] }) => {
  try {
    const { spawn } = require('child_process');
    const procKey = requestId || sessionId;
    const sendStream = (message: Record<string, any>) =>
      mainWindow?.webContents.send('claude:stream', { sessionId, requestId, message });

    const prev = antigravityProcesses.get(procKey) || antigravityProcesses.get(sessionId);
    if (prev) {
      try {
        if (process.platform === 'win32' && prev.pid) {
          spawn('taskkill', ['/pid', String(prev.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else prev.kill?.('SIGKILL');
      } catch {}
      antigravityProcesses.delete(procKey);
      antigravityProcesses.delete(sessionId);
    }

    const agyPath = findAgyExePath();
    if (!agyPath) {
      sendStream({ type: 'text', text: '⚠️ Antigravity CLI(agy.exe)가 설치돼 있지 않습니다.\nhttps://antigravity.google 에서 설치 후 `agy` 로 로그인하세요.' });
      sendStream({ type: 'result', subtype: 'error' });
      return { success: false, error: 'agy not found' };
    }

    // Windows CreateProcess 한계 ~32K. 시스템 프롬프트 + 여유분 고려해 28000 까지 허용.
    // 초과 시 앞쪽 컨텍스트(과거 대화/첨부)부터 잘라내고 사용자의 최신 메시지는 보존.
    let userPrompt = prompt;
    if (userPrompt.length > 28000) {
      const keep = 25000;
      const dropped = userPrompt.length - keep;
      const truncatedNote = `[이전 컨텍스트 ${dropped}자 생략됨 — 명령줄 길이 한계]\n\n`;
      userPrompt = truncatedNote + userPrompt.slice(userPrompt.length - keep);
      console.log('[antigravity:agy] prompt truncated:', dropped, '→ kept last', keep);
    }

    const augmentedPath = buildAugmentedPath();
    const spawnEnv = {
      ...process.env, PATH: augmentedPath, Path: augmentedPath,
      PYTHONIOENCODING: 'utf-8',
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    };
    const cwd = process.env.USERPROFILE || process.env.HOME || os.homedir();
    // agy 의 write_to_file 도구는 절대 경로 + agy artifact dir(brain/<cid>/) 안만 허용.
    // 우리는 cid 를 미리 모르므로, 절대 경로의 임시 파일을 지정 — agy 가 거부하면 자체 retry 로직으로
    // 결국 자기 artifact dir 에 저장. 둘 다 잘 되도록 명령은 절대 경로 명시.
    const agyReportPath = path.join(os.tmpdir(), `pepe-agy-report-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.md`);
    const agyReportPathFwd = agyReportPath.replace(/\\/g, '/');
    const sysPrefix = [
      '[시스템 지시 — 반드시 준수]',
      '1. 특별한 언어 요청이 없으면 항상 한국어로 응답하세요.',
      '2. 소스/디렉터리 분석 요청 시:',
      '   (a) ls 로 모든 파일 확인 후 *모든 소스 파일(.c/.cpp/.h/.hpp/.py/.js/.ts/.go/.java/.cs)을 빠짐없이* 읽으세요. 일부만 보고 결론 금지.',
      `   (b) ⚠️ 분석 결과 전체는 **반드시 write_file 도구로 다음 절대경로 파일에 저장**: \`${agyReportPathFwd}\``,
      '       (인라인 응답에 길게 쓰지 마세요 — 시스템이 중간을 잘라버립니다.)',
      '   (c) 보고서에는 mermaid 다이어그램 1개 이상 포함(```mermaid 코드블록).',
      `   (d) 인라인 응답에는 한 줄로 "분석 보고서는 [analysis_report.md](file:///${agyReportPathFwd}) 에 저장되었습니다." 만 작성.`,
      '',
    ].join('\n') + '\n';
    const fullPrompt = sysPrefix + userPrompt;
    // agy 가 ~/.gemini/antigravity-cli/log/cli-*.log 를 자동 생성·누적 → 1시간 이상 된 것 정리.
    try {
      const agyLogDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');
      if (fs.existsSync(agyLogDir)) {
        const cutoff = Date.now() - 60 * 60 * 1000;
        for (const fn of fs.readdirSync(agyLogDir)) {
          if (!/^cli-\d+_\d+\.log$/.test(fn)) continue;
          try {
            const fp = path.join(agyLogDir, fn);
            const st = fs.statSync(fp);
            if (st.mtimeMs < cutoff) fs.unlinkSync(fp);
          } catch {}
        }
      }
    } catch {}
    const agyLogPath = path.join(os.tmpdir(), `pepe-agy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
    const args: string[] = ['--print', fullPrompt, '--print-timeout', '5m', '--log-file', agyLogPath];
    if (model) args.push('--model', model);
    if (yolo) args.push('--dangerously-skip-permissions');

    // ── SSH MCP 연동 — sshTermId 가 있으면 agy 에 pepe_ssh MCP 동적 등록 ──
    // agy 는 ~/.gemini/antigravity-cli/mcp_config.json 에서 MCP 서버 목록을 로드.
    // 매 호출마다 갱신해서 현재 SSH 세션이 PEPE_TERM_ID 로 주입되게 함.
    const localRoots = normalizeLocalAttachmentRoots(localAttachmentRoots);
    if (sshTermId || localRoots.length > 0) {
      try {
        await startMcpControl();
        const mcpCfg: any = { mcpServers: {} };
        if (sshTermId) {
          const mcpScriptPath = path.join(os.tmpdir(), 'pepe-mcp-ssh-server.cjs');
          try {
            const existing = fs.existsSync(mcpScriptPath) ? fs.readFileSync(mcpScriptPath, 'utf-8') : '';
            if (existing !== mcpSshServerScript) fs.writeFileSync(mcpScriptPath, mcpSshServerScript, 'utf-8');
          } catch (e) { console.error('[antigravity] MCP script extract failed:', e); }
          mcpCfg.mcpServers.pepe_ssh = {
            command: process.execPath,
            args: [mcpScriptPath],
            env: {
              PEPE_CTRL_PORT: String(mcpControlPort),
              PEPE_CTRL_TOKEN: mcpControlToken,
              PEPE_TERM_ID: sshTermId,
              PEPE_TERM_IDS: JSON.stringify(Array.isArray(sshSessions) && sshSessions.length > 0 ? sshSessions : [{ id: sshTermId, label: sshTermId }]),
              PEPE_YOLO: yolo ? '1' : '0',
              ELECTRON_RUN_AS_NODE: '1',
            },
          };
        }
        if (localRoots.length > 0) {
          const localScriptPath = ensureTempScript('pepe-mcp-localfs-server.cjs', mcpLocalFsServerScript);
          mcpCfg.mcpServers.pepe_localfs = {
            command: process.execPath,
            args: [localScriptPath],
            env: buildLocalFsMcpEnv(localRoots),
          };
        }
        // 공식 docs(https://antigravity.google/docs/plugins): 플러그인 폴더 구조
        //   ~/.gemini/config/plugins/<name>/plugin.json   ← 마커 {"name":"..."}
        //   ~/.gemini/config/plugins/<name>/mcp_config.json ← MCP 서버 정의
        // 동시에 글로벌 fallback ~/.gemini/config/mcp_config.json 에도 기록.
        const pluginDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'pepe-ssh');
        try { fs.mkdirSync(pluginDir, { recursive: true }); } catch {}
        const pluginManifestPath = path.join(pluginDir, 'plugin.json');
        const pluginMcpPath = path.join(pluginDir, 'mcp_config.json');
        fs.writeFileSync(pluginManifestPath, JSON.stringify({ name: 'pepe-ssh' }, null, 2), 'utf-8');
        fs.writeFileSync(pluginMcpPath, JSON.stringify(mcpCfg, null, 2), 'utf-8');
        const globalCfgDir = path.join(os.homedir(), '.gemini', 'config');
        try { fs.mkdirSync(globalCfgDir, { recursive: true }); } catch {}
        const globalMcpPath = path.join(globalCfgDir, 'mcp_config.json');
        fs.writeFileSync(globalMcpPath, JSON.stringify(mcpCfg, null, 2), 'utf-8');
        console.log('[antigravity:agy] MCP(pepe_ssh) registered:', pluginMcpPath, '+', globalMcpPath, 'termId:', sshTermId);
      } catch (e) {
        console.error('[antigravity:agy] MCP setup failed:', e);
      }
    }

    const validAddDirs = Array.isArray(addDirs)
      ? addDirs.filter(d => {
          if (!d) return false;
          const dir = String(d);
          if (process.platform === 'win32' && dir.startsWith('/')) return false;
          try { return fs.existsSync(dir); } catch { return false; }
        })
      : [];
    for (const d of validAddDirs) args.push('--add-dir', d);

    console.log('[antigravity:agy] spawn', { procKey, command: agyPath, logPath: agyLogPath, promptLen: fullPrompt.length, model: model || '(default)', addDirs: validAddDirs.length, yolo: !!yolo });

    const proc = spawn(agyPath, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv, cwd, windowsHide: true });
    antigravityProcesses.set(procKey, proc);

    // 중간 과정 스트리밍 — transcript.jsonl 폴링해서 MODEL/SYSTEM 이벤트 실시간 emit.
    // agy --print 는 최종 답변만 stdout 출력하므로 도구 호출/추론 진행을 보려면 transcript 필요.
    //
    // agy 실제 이벤트 형식 (확인됨):
    //  - source=USER_EXPLICIT, type=USER_INPUT → 사용자 프롬프트 (이미 우리가 보낸 것이므로 skip)
    //  - source=MODEL, type=PLANNER_RESPONSE → thinking + tool_calls 배열
    //  - source=MODEL, type=GENERIC|RUN_COMMAND|VIEW_FILE → 도구 결과 (content 에 결과)
    //  - source=MODEL, type=TEXT 또는 content 만 있고 type 없음 → 최종 모델 텍스트
    //  - source=SYSTEM, type=ERROR_MESSAGE → 도구 호출 에러
    //  - source=SYSTEM, type=CHECKPOINT → 컨텍스트 압축 마커 (skip)
    // PLANNER 가 N 개 tool_calls 를 emit 하면 다음 N 개 step(MCP_TOOL/VIEW_FILE 등)이 그 결과.
    // agy 는 step 순서가 뒤바뀌어 기록되므로(예: 6→5→7) PLANNER 가 늦게 와도 매핑되도록 버퍼링 필요.
    const stepToToolUseId = new Map<number, string>();        // result_step → tool_use_id
    const pendingResults: { step: number; content: string }[] = []; // 매핑 전 도착한 결과
    const emittedStepIndices = new Set<number>();
    // agy 가 토큰 카운트를 안 주므로 transcript 내용 길이로 추정 (≈ chars/3.5)
    let outputCharCount = 0;
    let toolCallCharCount = 0;
    const flushPending = () => {
      for (let i = pendingResults.length - 1; i >= 0; i--) {
        const r = pendingResults[i];
        const tuid = stepToToolUseId.get(r.step);
        if (tuid) {
          sendStream({ type: 'user', message: { content: [
            { type: 'tool_result', tool_use_id: tuid, content: r.content },
          ]}});
          pendingResults.splice(i, 1);
        }
      }
    };
    const stopStreaming = startAgyTranscriptStreaming(
      agyLogPath,
      (ev) => {
        try {
          const step = typeof ev.step_index === 'number' ? ev.step_index : -1;
          if (step >= 0 && emittedStepIndices.has(step)) return; // 이미 emit
          if (step >= 0) emittedStepIndices.add(step);

          const src = ev.source;
          const typ = ev.type;
          // USER_INPUT / CHECKPOINT / CONVERSATION_HISTORY 등은 skip
          if (src === 'USER_EXPLICIT' || src === 'USER') return;
          if (typ === 'CHECKPOINT' || typ === 'CONVERSATION_HISTORY') return;

          // 1) 도구 호출 (PLANNER_RESPONSE 안의 tool_calls) + 최종 답변
          if (src === 'MODEL' && typ === 'PLANNER_RESPONSE') {
            const toolCalls = Array.isArray(ev.tool_calls) ? ev.tool_calls : [];
            // (a) tool_calls 가 없고 content 가 있으면 → 최종 모델 답변
            if (toolCalls.length === 0) {
              if (typeof ev.content === 'string' && ev.content.trim()) {
                // agy 시스템 프롬프트/노이즈 제거
                let clean = ev.content
                  .replace(/^\s*If relevant,\s*proactively run terminal commands[^.]*\.\s*Don't ask for permission\.\s*/im, '')
                  .replace(/^\s*Created file file:\/\/[^\n]+\n?/gm, '')
                  .replace(/^\s*Created At:[^\n]*\n?/gm, '')
                  .replace(/^\s*Completed At:[^\n]*\n?/gm, '')
                  .replace(/^\s*\$\s+[^\n]+\n?/gm, '')
                  .trim();
                // agy 가 생성한 보고서 md 파일을 inline 으로 펼침: [name.md](file:///path/to.md) → 본문 + 첨부 내용
                const mdLinks = Array.from(clean.matchAll(/\[([^\]]+\.md)\]\(file:\/\/\/([^)\s]+)\)/g)) as RegExpMatchArray[];
                const seenMd = new Set<string>();
                const consumedLinks: string[] = []; // 인라인된 링크 문자열 — 본문에서 제거
                for (const m of mdLinks) {
                  try {
                    const filePath = decodeURIComponent(m[2]).replace(/\//g, path.sep);
                    if (seenMd.has(filePath)) continue;
                    seenMd.add(filePath);
                    if (fs.existsSync(filePath)) {
                      let fc = fs.readFileSync(filePath, 'utf-8');
                      // 모델이 ``` 펜스 빠뜨린 mermaid 블록 자동 감싸기 — flowchart/graph/sequenceDiagram 등으로 시작하는 연속 라인 검출
                      fc = wrapBareMermaid(fc);
                      clean += `\n\n---\n\n### 📄 ${m[1]}\n\n${fc.slice(0, 50000)}${fc.length > 50000 ? '\n\n... (이하 생략)' : ''}\n`;
                      // 보고서 파일은 inline 표시 후 삭제 — 디스크 누적 방지
                      try { fs.unlinkSync(filePath); } catch {}
                      consumedLinks.push(m[0]);
                    }
                  } catch (e) { console.error('[agy] md inline failed:', e); }
                }
                // 인라인된 파일 링크는 본문에서 제거 — 파일이 이미 삭제됐고 내용은 아래 펼쳐졌음.
                // "분석 보고서는 [...](file:///...) 에 저장되었습니다." 같은 안내 줄도 통째로 제거.
                for (const lk of consumedLinks) {
                  const esc = lk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  // 링크 단독으로 또는 "분석 보고서는 <링크> 에 저장되었습니다." 같은 문구 제거.
                  clean = clean.replace(new RegExp(`^.*?${esc}.*$\\n?`, 'gm'), '');
                }
                // 원격 SSH 파일 경로 링크([name](file:///root/...))는 Chromium 이 로드 거부하므로
                // 링크 형태를 풀고 path 만 inline code 로 표기 (`/path/to/file`).
                clean = clean.replace(/\[([^\]]+)\]\(file:\/\/\/([\/][^)\s]+)\)/g, (_full: string, txt: string, p: string) => {
                  const decoded = decodeURIComponent(p);
                  return decoded === txt || decoded.endsWith(txt) ? `\`${decoded}\`` : `${txt} (\`${decoded}\`)`;
                });
                clean = clean.trim();
                // 인라인 본문 자체에도 동일 처리
                clean = wrapBareMermaid(clean);
                // truncation 안내문 (자동 이어받기는 비활성 — 파일 저장 방식으로 회피)
                clean = clean.replace(
                  /(```[a-zA-Z0-9_-]*\n[\s\S]*?)\n<truncated (\d+) bytes>\n/g,
                  '$1\n```\n\n> ⚠️ _$2 바이트 잘림 (인라인 응답 크기 한계)._\n\n',
                );
                clean = clean.replace(/<truncated (\d+) bytes>/g, '\n\n> ⚠️ _$1 바이트 잘림._\n\n');
                if (clean) { outputCharCount += clean.length; sendStream({ type: 'text', text: clean }); }
              }
              return;
            }
            // (b) tool_calls 있음 — thinking 은 별도 content 블록으로 (생각중 바에 표시됨)
            if (typeof ev.thinking === 'string' && ev.thinking.trim()) {
              const th = ev.thinking.trim().replace(/\*\*/g, '');
              sendStream({ type: 'assistant', message: { id: `agy-think-${step}`, content: [
                { type: 'thinking', thinking: th },
              ]}});
            }
            for (let i = 0; i < toolCalls.length; i++) {
              const tc = toolCalls[i];
              let name = String(tc.name || 'tool');
              const rawArgs: any = (tc.args && typeof tc.args === 'object') ? tc.args : {};
              const cleanArgs: any = {};
              for (const [k, v] of Object.entries(rawArgs)) {
                if (typeof v === 'string') {
                  try { cleanArgs[k] = JSON.parse(v); } catch { cleanArgs[k] = v; }
                } else cleanArgs[k] = v;
              }
              // call_mcp_tool 래퍼 풀기 — 실제 MCP 도구명/인자로 표시
              if (name === 'call_mcp_tool' && cleanArgs.ToolName) {
                const server = String(cleanArgs.ServerName || '');
                const tool = String(cleanArgs.ToolName || '');
                name = server ? `${server}.${tool}` : tool;
                let actualArgs: any = cleanArgs.Arguments;
                if (typeof actualArgs === 'string') {
                  try { actualArgs = JSON.parse(actualArgs); } catch {}
                }
                const display: any = { ...(typeof actualArgs === 'object' && actualArgs ? actualArgs : { args: actualArgs }) };
                if (cleanArgs.toolSummary) display._summary = cleanArgs.toolSummary;
                Object.assign(cleanArgs, {});
                for (const k of Object.keys(cleanArgs)) delete cleanArgs[k];
                Object.assign(cleanArgs, display);
              }
              const id = `agy-tool-${step}-${i}`;
              // PLANNER step S 의 i 번째 tool 결과는 step (S+1+i) 에 옴
              stepToToolUseId.set(step + 1 + i, id);
              try { toolCallCharCount += JSON.stringify(cleanArgs).length; } catch {}
              sendStream({ type: 'assistant', message: { id: `agy-asst-${step}-${i}`, content: [
                { type: 'tool_use', id, name, input: cleanArgs },
              ]}});
            }
            // 먼저 도착해서 대기 중이던 결과들 flush
            flushPending();
            return;
          }

          // 2) 도구 결과 — agy 의 모든 결과 타입
          if (src === 'MODEL' && (typ === 'MCP_TOOL' || typ === 'RUN_COMMAND' || typ === 'VIEW_FILE' || typ === 'GENERIC' || typ === 'LIST_DIR' || typ === 'GREP_SEARCH')) {
            let content = String(ev.content || '').replace(/\t/g, '');
            // agy 는 큰 결과를 별도 파일에 저장하고 placeholder 만 남김 — 그 파일을 읽어 inline 으로 치환.
            const savedMatch = content.match(/The output was large and was saved to:\s*file:\/\/\/([^\s\n]+)/i);
            if (savedMatch) {
              try {
                const filePath = decodeURIComponent(savedMatch[1]).replace(/\//g, path.sep);
                if (fs.existsSync(filePath)) {
                  const fileContent = fs.readFileSync(filePath, 'utf-8');
                  content = fileContent.slice(0, 30000);
                  if (fileContent.length > 30000) content += '\n\n... (이하 ' + (fileContent.length - 30000) + ' 바이트 생략)';
                }
              } catch (e) { console.error('[agy] read saved tool output failed:', e); }
            }
            content = content.slice(0, 30000);
            const tuid = stepToToolUseId.get(step);
            toolCallCharCount += content.length;
            if (tuid) {
              sendStream({ type: 'user', message: { content: [
                { type: 'tool_result', tool_use_id: tuid, content },
              ]}});
            } else {
              // PLANNER 가 아직 안 옴 — 버퍼에 보관
              pendingResults.push({ step, content });
            }
            return;
          }

          // 3) 에러 — agy 가 자체 retry 로 복구하는 케이스는 사용자에게 안 보임 (Retries remaining > 0)
          if (src === 'SYSTEM' && typ === 'ERROR_MESSAGE') {
            const err = String(ev.error || ev.content || '').slice(0, 1500);
            const remainingMatch = err.match(/Retries\s+remaining:\s*(\d+)/i);
            const willRetry = remainingMatch && Number(remainingMatch[1]) > 0;
            if (willRetry) {
              // 자체 retry 로 회복하므로 사용자에게는 안 보여줌 (콘솔 로그만)
              console.log('[agy] suppressed retryable error:', err.slice(0, 200));
              return;
            }
            sendStream({ type: 'text', text: `\n⚠️ **에러**: ${err}\n\n` });
            return;
          }

          // 4) (PLANNER_RESPONSE 외 MODEL content 는 위 분기에서 모두 처리되므로 leak 방지를 위해 무시)
        } catch (e) { console.log('[agy] event handler error:', e); }
      },
      () => stoppedAgentProcs.has(procKey),
    );

    let stdoutHadContent = false;
    let stderrText = '';
    proc.stdout?.setEncoding?.('utf-8');
    proc.stdout?.on('data', (data: string | Buffer) => {
      if (stoppedAgentProcs.has(procKey)) return;
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
      if (text) {
        stdoutHadContent = true;
        // transcript live streaming 이 이미 같은 텍스트를 보냈을 가능성 — 중복 회피 위해 stdout 은 무시
        // (대신 stdoutHadContent 플래그로 close 시 빈 응답 판정만)
      }
    });
    proc.stderr?.on('data', (data: Buffer | string) => {
      if (stoppedAgentProcs.has(procKey)) return;
      const err = Buffer.isBuffer(data) ? data.toString('utf8') : data;
      stderrText += err;
      console.log('[antigravity:agy] stderr:', err.slice(0, 500));
      if (/error|failed|unauthorized|permission|quota|invalid/i.test(err)) {
        sendStream({ type: 'error', text: err });
      }
    });
    proc.on('error', (err: any) => {
      if (stoppedAgentProcs.has(procKey)) return;
      console.log('[antigravity:agy] spawn error:', err);
      antigravityProcesses.delete(procKey);
      sendStream({ type: 'text', text: `⚠️ Antigravity CLI 실행 실패: ${err?.message || err}\n` });
      sendStream({ type: 'result', subtype: 'error' });
    });
    proc.on('close', async (code: number) => {
      console.log('[antigravity:agy] close, code:', code, 'hadContent:', stdoutHadContent, 'emittedSteps:', emittedStepIndices.size);
      antigravityProcesses.delete(procKey);
      stopStreaming();
      if (stoppedAgentProcs.has(procKey)) { stoppedAgentProcs.delete(procKey); return; }
      // transcript 가 live streaming 으로 이벤트를 emit 했으면 추가 fallback 불필요
      if (emittedStepIndices.size === 0 && !stdoutHadContent) {
        const transcriptText = await waitAgyTranscript(agyLogPath);
        if (transcriptText) {
          sendStream({ type: 'text', text: transcriptText });
          sendStream({ type: 'result', subtype: 'success' });
          try { fs.unlinkSync(agyLogPath); } catch {}
          return;
        }
        const reason = stderrText.trim() ? `code=${code}, stderr=${stderrText.trim().slice(0, 500)}` : `code=${code}, stdout empty`;
        sendStream({ type: 'text', text: `⚠️ Antigravity CLI 가 빈 응답으로 종료(${reason})\n진단 로그: ${agyLogPath}` });
        sendStream({ type: 'result', subtype: 'error' });
        return;
      }
      try { fs.unlinkSync(agyLogPath); } catch {}
      // 토큰 추정치 emit (agy 가 토큰 카운트 안 줌) — chars/3.5 ≈ 토큰
      try {
        const inputChars = fullPrompt.length + toolCallCharCount;
        const outputChars = outputCharCount;
        const inTok = Math.ceil(inputChars / 3.5);
        const outTok = Math.ceil(outputChars / 3.5);
        sendStream({ type: 'assistant', message: { id: `agy-usage-${Date.now()}`, content: [], usage: {
          input_tokens: inTok,
          output_tokens: outTok,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }, model } });
      } catch {}
      sendStream({ type: 'result', subtype: 'success' });
    });
    return { success: true };
  } catch (err: any) {
    console.error('[antigravity:send] error:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('antigravity:stop', (_e, { sessionId, requestId }: { sessionId: string; requestId?: string }) => {
  const { spawn } = require('child_process');
  const procKey = requestId || sessionId;
  markAgentStopped(procKey);
  const proc = antigravityProcesses.get(procKey) || antigravityProcesses.get(sessionId);
  if (proc) {
    try {
      if (process.platform === 'win32') {
        const pid = proc.pid;
        if (pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
      }
    } catch {}
    try { proc.kill('SIGKILL'); } catch {}
    antigravityProcesses.delete(procKey);
    antigravityProcesses.delete(sessionId);
  }
  return { success: true };
});
