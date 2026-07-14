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
const sudo = require('sudo-prompt');

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

// (v2.2.7 에서 추가 — 실제로는 원인이 아닌 것으로 확인됨: 현장 로그에서 Zone.Identifier 가
// 애초에 없었는데도 문제가 재현됐다. SmartScreen 표시 자체는 원인이 아니지만, 무해하므로
// 그대로 둔다.)
function unblockFile(filePath: string) {
  const adsPath = `${filePath}:Zone.Identifier`;
  try {
    fs.unlinkSync(adsPath);
    logUpdate(`Zone.Identifier 제거됨: ${filePath}`);
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      logUpdate(`Zone.Identifier 없음(이미 unblocked): ${filePath}`);
    } else {
      logUpdate(`Zone.Identifier 제거 실패: ${String(e?.message || e)}`);
    }
  }
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

    // v2.2.9~v2.2.13 에서 elevate.exe 를 직접 spawn + 지연 종료 + cmd/c start 로 감싸는 등
    // 자체 재구현을 시도했지만 현장에서 계속 재현됐고, 표준 quitAndInstall() 로 되돌려도(Tabby
    // 방식) 여전히 재현됐다. 현장 로그로 확인한 결과: autoInstallOnAppQuit 중복 무음 설치
    // 경쟁은 이미 해결됐는데도(로그에 "Install on explicit quitAndInstall" 한 번만 찍힘) UAC
    // 승인 뒤 아무 창도 안 뜨고, 정작 같은 설치 파일을 수동 더블클릭하면 완전히 정상 동작한다.
    // 즉 파일도, 우리 트리거 로직도 문제가 아니라 electron-updater 가 내장한 elevate.exe 가 그
    // 경로("...\pepe terminal(ssh)-updater\pending\...", 공백+괄호 포함)를 실행하는 단계
    // 자체에서 조용히 실패하는 것으로 보인다. VPN 연결(vpnService.ts)에서 이미 같은 PC 부류에서
    // 안정적으로 쓰고 있는 sudo-prompt 로 직접 승격 실행해 elevate.exe 를 완전히 우회한다.
    (async () => {
      try {
        const installerPath: string | undefined = (autoUpdater as any).installerPath;
        if (!installerPath) {
          logUpdate('installerPath 없음 — sudo-prompt 실행 불가, quitAndInstall 로 폴백');
          setImmediate(() => { try { autoUpdater.quitAndInstall(false, true); } catch (e: any) { logUpdate(`quitAndInstall 예외: ${String(e?.stack || e)}`); } });
          return;
        }
        unblockFile(installerPath);
        const quote = (s: string) => `"${s}"`;
        const cmd = `${quote(installerPath)} --updated --force-run`;
        logUpdate(`sudo-prompt 로 설치 프로그램 승격 실행: ${cmd}`);
        sudo.exec(cmd, { name: 'PePe Terminal SSH' }, (err: any, stdout: any, stderr: any) => {
          const out = (stdout?.toString?.() || '') + (stderr?.toString?.() || '');
          if (out) logUpdate('sudo-prompt 설치 프로그램 종료 출력: ' + out.trim());
          if (err) logUpdate(`sudo-prompt 설치 프로그램 실행 오류: ${String(err?.message || err)}`);
          else logUpdate('sudo-prompt 설치 프로그램 정상 종료(사용자가 설치 마법사를 완료함)');
        });
        // sudo-prompt 는 승격된 프로세스가 끝날 때까지 콜백을 기다리므로(설치 마법사 완료 시점),
        // 여기서 콜백을 기다리지 않고 UAC/설치 창이 뜰 시간만 잠깐 준 뒤 앱을 종료한다 — UAC 로
        // 승격된 프로세스는 Windows AppInfo 서비스가 별도로 띄우므로 우리 앱 프로세스가 먼저
        // 종료돼도 살아남는다(일반 자식 프로세스와 달리 Job Object 에 묶이지 않음).
        setTimeout(() => { app.quit(); }, 1500);
      } catch (e: any) {
        logUpdate(`sudo-prompt 승격 실행 예외: ${String(e?.stack || e)}`);
      }
    })();
    return { ok: true };
  });
  ipcMain.handle('updater:state', () => ({
    supported: supported(),
    version: app.getVersion(),
    info: lastInfo,
  }));

  if (!supported()) return;

  autoUpdater.autoDownload = false;
  // 문제의 PC에서 "0-temp-..." 차등 다운로드 임시 파일에 EBUSY(resource busy or locked)가
  // 발생해 다운로드 자체가 실패/파일 소실되는 현상이 확인됨 — 블록 단위 조립 과정을 아예
  // 없애고 매번 전체 파일을 새로 받도록 강제한다(용량은 늘지만 훨씬 안정적).
  autoUpdater.disableDifferentialDownload = true;
  // v2.2.9 진단 로그로 확정된 근본 원인: 이 값이 true 면, 우리가 'updater:quit-and-install' 에서
  // elevate.exe 를 직접 spawn 한 뒤 app.quit() 을 호출하는 바로 그 순간, electron-updater 가
  // 자체 등록해둔 "종료 시 자동 설치" 퀸 핸들러가 또 한 번 install() 을 트리거해 elevate.exe 를
  // *두 번째로* 실행한다 — 이번엔 isSilent:true, /S(완전 무음) 로. 같은 설치 파일의 두 인스턴스가
  // 거의 동시에 뜨고, NSIS 의 "동시 실행 하나만 허용" 규칙 때문에 둘 중 하나만 살아남는데
  // 하필 무음 인스턴스가 이겨서 화면 없이 조용히 설치되는 것으로 보인다(우리가 의도한, 화면
  // 있는 인스턴스가 밀려남) — "UAC 승인까지는 뜨는데 설치 창이 안 보인다"는 증상과 정확히
  // 일치한다. 설치 트리거를 이미 우리가 직접 제어하므로, 이 자동 핸들러는 끈다.
  autoUpdater.autoInstallOnAppQuit = false;
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
