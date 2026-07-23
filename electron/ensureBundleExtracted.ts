// electron/ensureBundleExtracted.ts
// 선택 설치 기능(VPN/MicroSIP/SIPp/미디어/오피스) 번들을 지연 압축 해제한다.
//
// 배경: 예전엔 electron-builder extraResources 가 각 기능 폴더를 통째로(파일 수십~수천 개)
// 번들해서, 설치 프로그램(NSIS)이 "기능 선택" 체크박스를 해제해도 일단 전부 압축 해제한
// 뒤에야 안 쓰는 폴더를 지웠다 — 체크 해제해도 설치 시간이 전혀 안 줄던 진짜 원인.
// scripts/zip-optional-bundles.js 가 빌드 시 각 폴더를 zip 하나로 묶어두고,
// build/installer.nsh 의 customInstall 이 체크된 기능만 그 자리에서 tar 로 풀도록 바꿨다.
//
// 문제는 "포터블(exe 하나)" 빌드는 NSIS customInstall 을 절대 거치지 않는다는 것 — zip 만
// 번들된 채로 방치되면 그 기능이 통째로 깨진다. resources/x11-server.zip 이 예전부터 이미
// 이 문제를 겪고 있었고(x11Bundled.ts 의 ensureExtracted), 해법은 "그 기능을 실제로 처음 쓸
// 때 앱이 직접 풀기" 였다 — 이 파일은 그 패턴을 다른 번들에도 재사용할 수 있게 일반화한 것.
//
// 정상 설치(NSIS)로 깔린 경우엔 zip 이 이미 삭제되고 폴더가 이미 존재하므로, 아래 함수는
// existsSync 확인 한 번으로 끝나는 사실상 no-op 이다 — 포터블/구버전 업데이트 케이스에서만
// 실제로 압축을 푼다.
import { app } from 'electron';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

/**
 * @param zipBaseName  resources/ 바로 아래(설치 시)에 있을 zip 파일 이름(확장자 제외).
 *                     예: "gstreamer-sidecar-win-x64" → "gstreamer-sidecar-win-x64.zip"
 * @param targetRelDir zip 을 풀어야 할 resources/ 기준 상대 경로. 예: "gstreamer-sidecar/win-x64"
 * @param markerRelPath targetRelDir 안에서 "이미 풀렸는지" 판단할 파일(보통 실행 파일).
 * @returns 압축 해제 성공(또는 이미 풀려 있음) 여부. zip 도 마커도 없으면 false(그 기능
 *          자체가 설치에서 제외된 것 — 정상적인 "미설치" 상태이므로 에러 아님).
 */
export function ensureBundleExtracted(
  zipBaseName: string,
  targetRelDir: string,
  markerRelPath: string,
  log?: (m: string) => void,
): boolean {
  if (process.platform !== 'win32') return true; // zip 번들은 win 전용 — 다른 플랫폼은 그대로 폴더 사용
  let resourcesBase: string;
  try {
    resourcesBase = app.isPackaged ? process.resourcesPath : path.join(process.cwd(), 'resources');
  } catch {
    return false;
  }
  const target = path.join(resourcesBase, targetRelDir);
  const marker = path.join(target, markerRelPath);
  try { if (fs.existsSync(marker)) return true; } catch {}

  const zip = path.join(resourcesBase, `${zipBaseName}.zip`);
  try {
    if (!fs.existsSync(zip)) return false; // zip 도 없음 = 이 기능은 설치에서 제외됨(정상)
  } catch { return false; }

  log?.(`[ensureBundleExtracted] ${zipBaseName} 압축 해제 중 → ${target}`);
  try { fs.mkdirSync(target, { recursive: true }); } catch {}
  try {
    execFileSync('tar', ['-xf', zip, '-C', target], { windowsHide: true });
  } catch (e: any) {
    log?.(`[ensureBundleExtracted] tar 실패(${e?.message}) — PowerShell 폴백`);
    try {
      execFileSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-Command', `Expand-Archive -Path "${zip}" -DestinationPath "${target}" -Force`,
      ], { windowsHide: true });
    } catch (e2: any) {
      log?.(`[ensureBundleExtracted] PowerShell 폴백도 실패: ${e2?.message}`);
    }
  }
  try {
    const ok = fs.existsSync(marker);
    if (ok) log?.(`[ensureBundleExtracted] ${zipBaseName} 압축 해제 완료`);
    return ok;
  } catch { return false; }
}
