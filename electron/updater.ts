// electron/updater.ts
// electron-updater 기반 자동 업데이트.
// 배포 채널: GitHub Releases (public repo nyaong902/pepe-terminal-ssh)
// - 시작 시 1회 자동 확인 + 메뉴의 "업데이트 확인" 수동 트리거
// - autoDownload=false 로 두고 사용자가 모달에서 동의해야 다운로드
// - 다운로드 완료 후 사용자가 "재시작하여 설치" 누르면 quitAndInstall
import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as fs from 'fs';
import * as path from 'path';

// 패키지 빌드에선 main.ts 가 console.log 를 무력화해서(6번째 줄), electron-updater 의 진단 로그가
// 지금까지 어디에도 안 남고 있었다 — 다른 PC 에서 "재시작 설치" 버튼을 눌러도 설치 창이 안 뜨는
// 문제를 원격으로 여러 번 추정만으로 고치려다 실패해서(v2.2.1 ${Silent} 변경, v2.2.3
// packElevateHelper 모두 현장에서 확인 안 됨), 다음에 같은 문제가 재현되면 실제 로그를 받아
// 원인을 확정할 수 있도록 파일에 남긴다.
const UPDATE_LOG_PATH = (() => {
  try { return path.join(app.getPath('userData'), 'update-debug.log'); } catch { return null; }
})();
function logUpdate(msg: string) {
  console.log(msg); // 개발 모드에선 그대로 콘솔에도 보임
  if (!UPDATE_LOG_PATH) return;
  try { fs.appendFileSync(UPDATE_LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

type UpdaterState =
  | 'idle'
  | 'unsupported'   // dev / portable — 자동 업데이트 미지원
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

let getWin: () => BrowserWindow | null = () => null;
let wired = false;
let manualCheck = false;   // 수동 '업데이트 확인' 으로 트리거된 확인인지 (UX 분기용)
let lastInfo: any = null;

function send(payload: { state: UpdaterState; [k: string]: any }) {
  try { getWin()?.webContents.send('updater:status', { manual: manualCheck, ...payload }); } catch {}
}

// electron-builder portable 타깃은 실행 시 PORTABLE_EXECUTABLE_DIR 환경변수를 설정한다.
// portable 빌드는 in-place 자동 업데이트를 지원하지 않으므로 건너뛴다.
function isPortable(): boolean {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

function supported(): boolean {
  return app.isPackaged && !isPortable();
}

export function setupAutoUpdater(getWindow: () => BrowserWindow | null) {
  getWin = getWindow;

  // IPC: 렌더러 → 메인
  ipcMain.handle('updater:check', () => triggerCheck(true));
  ipcMain.handle('updater:download', () => {
    if (!supported()) return { ok: false, reason: 'unsupported' };
    try { autoUpdater.downloadUpdate(); return { ok: true }; }
    catch (e: any) { return { ok: false, reason: String(e?.message || e) }; }
  });
  ipcMain.handle('updater:quit-and-install', () => {
    if (!supported()) return { ok: false, reason: 'unsupported' };
    logUpdate(`quit-and-install 호출됨 — version=${app.getVersion()} platform=${process.platform} arch=${process.arch}`);
    // isSilent=false, isForceRunAfter=true — 설치 후 자동 재실행
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (e: any) {
        logUpdate(`quitAndInstall 예외: ${String(e?.stack || e)}`);
      }
    });
    return { ok: true };
  });
  ipcMain.handle('updater:state', () => ({
    supported: supported(),
    version: app.getVersion(),
    info: lastInfo,
  }));

  if (!supported()) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  // 진단 로그 — 패키지 빌드에서도 남도록 파일에 기록 (위 logUpdate 참고)
  try { (autoUpdater as any).logger = { info: logUpdate, warn: logUpdate, error: logUpdate, debug: () => {} }; } catch {}
  logUpdate(`setupAutoUpdater 초기화 — version=${app.getVersion()} logPath=${UPDATE_LOG_PATH}`);

  // ── 자가서명 인증서 우회 ─────────────────────────────────────────────
  // PePe 는 자가서명 인증서(cert/PePeTerminal_v2.pfx, Subject=Issuer=CN=PePe Terminal)로
  // 코드 서명. Windows 가 Trusted Root 에 등록되지 않은 자가서명 cert 의 trust chain 을
  // 검증하지 못해 electron-updater 기본 verifyUpdateCodeSignature 가
  // "not signed by application owner" 로 거부함.
  //
  // 무결성은 latest.yml 의 sha512 + GitHub HTTPS 가 이미 보장하므로
  // (서버 측 변조엔 GitHub release + latest.yml 동시 위·변조가 필요) 코드 서명
  // verifyUpdateCodeSignature 만 우회.
  //
  // ※ 추후 EV/CA 인증서 도입 시 이 override 를 제거하면 자동으로 정상 검증 복원됨.
  try {
    (autoUpdater as any).verifyUpdateCodeSignature = async () => null;
  } catch {}

  if (!wired) {
    wired = true;
    autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
    autoUpdater.on('update-available', (info) => { lastInfo = info; send({ state: 'available', info }); });
    autoUpdater.on('update-not-available', (info) => { lastInfo = info; send({ state: 'not-available', info }); });
    autoUpdater.on('download-progress', (p) => send({
      state: 'downloading',
      info: lastInfo,   // download-progress 이벤트엔 version 이 없어 'available' 때의 info 를 같이 보냄
      progress: {
        percent: Math.round((p.percent || 0) * 10) / 10,
        transferred: p.transferred,
        total: p.total,
        bytesPerSecond: p.bytesPerSecond,
      },
    }));
    autoUpdater.on('update-downloaded', (info) => { lastInfo = info; logUpdate(`update-downloaded: ${info?.version} → ${info?.path || ''}`); send({ state: 'downloaded', info }); });
    autoUpdater.on('error', (err) => {
      logUpdate(`autoUpdater error: ${String((err as any)?.stack || err)}`);
      send({ state: 'error', error: String((err as any)?.message || err) });
    });
  }
}

async function triggerCheck(manual: boolean): Promise<{ ok: boolean; reason?: string }> {
  manualCheck = manual;
  if (!supported()) {
    if (manual) send({ state: 'unsupported' });
    return { ok: false, reason: 'unsupported' };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e: any) {
    send({ state: 'error', error: String(e?.message || e) });
    return { ok: false, reason: String(e?.message || e) };
  }
}

// 앱 시작 시 1회 자동 확인 (창 준비 후 지연 호출)
export function checkForUpdatesOnStartup(delayMs = 4000) {
  if (!supported()) return;
  setTimeout(() => { triggerCheck(false); }, delayMs);
}
