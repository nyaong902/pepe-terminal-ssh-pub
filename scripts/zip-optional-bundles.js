#!/usr/bin/env node
// scripts/zip-optional-bundles.js
// 설치 프로그램의 "기능 선택"(VPN/MicroSIP/SIPp/미디어/오피스) 체크박스가 실제로 설치
// 시간을 줄이도록, 각 선택 기능의 원본 폴더를 미리 zip 하나로 묶어둔다.
//
// 예전엔 electron-builder 의 extraResources 가 각 폴더를 통째로(파일 수천 개까지) 그대로
// 번들해서, NSIS 가 설치 시 무조건 전부 압축 해제한 뒤에야(체크 해제해도!) customInstall 에서
// 안 쓰는 폴더를 rmdir 로 지웠다 — 체크 해제해도 설치 시간이 전혀 줄지 않는 게 진짜 원인이었다.
// (참고: build/installer.nsh 의 x11-server.zip 처리가 바로 이 zip+tar 패턴이고, "50MB/5천 파일을
// tar 로 약 3초"라는 실측 코멘트가 있다 — 다파일 개별 File 명령보다 훨씬 빠르다.)
//
// 이제 각 폴더를 zip 하나로 묶어 extraResources 에 "그 zip 파일 하나만" 번들한다 — NSIS 는
// 파일 하나만 처리하면 되고, 체크 해제된 기능은 customInstall 에서 압축 해제 없이 zip 삭제만
// 하면 되므로 그 기능만큼의 압축 해제 시간을 완전히 건너뛴다.
//
// win32 에서만 의미가 있다(NSIS 설치 프로그램은 Windows 전용) — 다른 플랫폼에서는 그냥 종료.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  console.log('[zip-optional-bundles] win32 아님 — 건너뜀');
  process.exit(0);
}

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, 'resources', 'optional-bundles');
fs.mkdirSync(outDir, { recursive: true });

// PATH 에 Git for Windows(usr/bin) 의 MSYS tar 가 시스템 tar.exe 보다 먼저 잡히면, Windows
// 드라이브 경로(C:\...)의 콜론을 원격 호스트 지정으로 오인해 "Cannot connect to C:" 로 실패한다
// (bsdtar 는 정상 처리하지만 MSYS/GNU tar 는 아님). Windows 10 1803+ 내장 bsdtar 를 명시적으로
// 지정해 PATH 순서와 무관하게 항상 올바른 tar 를 쓴다.
const SYSTEM_TAR = 'C:\\Windows\\System32\\tar.exe';
const tarCmd = fs.existsSync(SYSTEM_TAR) ? SYSTEM_TAR : 'tar';

// [zip 파일 이름, 원본 디렉터리(zip 안에서는 이 폴더 내용이 루트가 됨), 필수 여부]
const BUNDLES = [
  { name: 'openvpn-win', srcDir: path.join(projectRoot, 'resources', 'openvpn-win') },
  { name: 'sip-sidecar-win-x64', srcDir: path.join(projectRoot, 'sip-sidecar', 'bin', 'win-x64'), only: ['sipd.exe'] },
  { name: 'sipp-sidecar-win-x64', srcDir: path.join(projectRoot, 'sipp-sidecar', 'bin', 'win-x64'), only: ['sipp.exe'] },
  { name: 'gstreamer-sidecar-win-x64', srcDir: path.join(projectRoot, 'gstreamer-sidecar', 'bin', 'win-x64') },
  { name: 'office-editor', srcDir: path.join(projectRoot, 'resources', 'office-editor') },
  { name: 'rhwp-studio', srcDir: path.join(projectRoot, 'resources', 'rhwp-studio') },
  { name: 'flowchart-editor', srcDir: path.join(projectRoot, 'resources', 'flowchart-editor') },
  { name: 'calllog-cdr-tool', srcDir: path.join(projectRoot, 'resources', 'calllog-cdr-tool') },
  // JRE(JDBC 사이드카용) — 체크박스 없이 항상 설치되지만 Temurin 배포본이 300개+ 개별 파일이라
  // (bin/lib/conf/legal 등) X11 서버와 같은 이유로 NSIS 기본 File-by-file 복사가 느리다.
  // x11-server 와 동일한 zip+tar 패턴 적용 — package.json 의 win.extraResources 도 loose 폴더
  // 대신 이 zip 하나만 가리키도록 바꿨고, build/installer.nsh 에 압축 해제 블록을 추가했다.
  { name: 'jre-win-x64', srcDir: path.join(projectRoot, 'resources', 'jre', 'win-x64') },
  // X11 서버(VcXsrv) — 체크박스 없이 항상 설치되지만, 파일 수(~5천 개)가 가장 많아 NSIS 의
  // 기본 File-by-file 복사가 유독 느리다(체감상 install "파일 복사" 단계 대부분을 차지).
  // build/installer.nsh 에 이미 x11-server.zip → tar 압축 해제 로직이 있었는데(예전엔 이
  // 방식이었다가 한때 폴더 직접 번들로 바뀜) zip 자체가 안 만들어지고 있어서 no-op 이었다 —
  // 여기서 다시 만들어 그 기존 로직이 실제로 쓰이게 한다. resources/ 바로 아래 두는 이유는
  // installer.nsh 가 정확히 "$INSTDIR\resources\x11-server.zip" 경로를 찾기 때문.
  { name: 'x11-server', srcDir: path.join(projectRoot, 'resources', 'x11-server'), outDir: path.join(projectRoot, 'resources') },
];

let failed = false;
for (const b of BUNDLES) {
  if (!fs.existsSync(b.srcDir)) {
    console.warn(`[zip-optional-bundles] 건너뜀(원본 없음): ${b.srcDir}`);
    continue;
  }
  const zipPath = path.join(b.outDir || outDir, `${b.name}.zip`);
  try { fs.rmSync(zipPath, { force: true }); } catch {}

  // only 지정 시 그 파일들만, 아니면 폴더 전체를 zip 루트에 그대로 담는다(-C 로 이동 후 '.').
  const args = b.only
    ? ['-a', '-cf', zipPath, '-C', b.srcDir, ...b.only]
    : ['-a', '-cf', zipPath, '-C', b.srcDir, '.'];
  const res = spawnSync(tarCmd, args, { stdio: 'inherit', windowsHide: true });
  if (res.status !== 0 || !fs.existsSync(zipPath)) {
    console.error(`[zip-optional-bundles] 실패: ${b.name} (tar exit=${res.status})`);
    failed = true;
    continue;
  }
  const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(`[zip-optional-bundles] ✓ ${b.name}.zip (${sizeMb}MB)`);
}

if (failed) {
  console.error('[zip-optional-bundles] 일부 번들 압축 실패 — 빌드 중단');
  process.exit(1);
}
