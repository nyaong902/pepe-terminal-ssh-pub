const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const cacheDir = path.join(projectRoot, '.cache', 'electron-builder');
// 직전 빌드 산출물이 다른 프로세스(잔존 PePe Terminal 등) 에 잠겨 삭제 불가한 경우를
// 회피하기 위해 매번 고유 타임스탬프 디렉토리 사용.
const tempOutputDir = path.join(projectRoot, '.cache', 'electron-builder-output-' + Date.now());
const finalOutputDir = path.join(projectRoot, 'release');

fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(tempOutputDir, { recursive: true });

// ELECTRON_BUILDER_CACHE 를 프로젝트 .cache 로 두면 winCodeSign 압축 해제 시
// 심볼릭 링크 생성 권한 부족(symlink: 잘못된 함수) 오류가 날 수 있어 유저 글로벌 캐시(기본 위치) 사용.
const env = { ...process.env };

const cliPath = require.resolve('electron-builder/out/cli/cli.js');
const args = ['--config.directories.output=' + tempOutputDir, ...process.argv.slice(2)];
if (process.env.SKIP_SIGN && process.env.SKIP_SIGN !== '0') {
  console.log('[run-electron-builder] SKIP_SIGN enabled: disabling Windows code signing');
  args.push('--config.win.sign=false');
}
const result = spawnSync(process.execPath, [cliPath, ...args], {
  stdio: 'inherit',
  env,
  cwd: projectRoot,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

if ((result.status ?? 1) === 0) {
  try {
    fs.rmSync(finalOutputDir, { recursive: true, force: true });
    fs.cpSync(tempOutputDir, finalOutputDir, { recursive: true });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }

  // release/ 로 복사 완료했으니 .cache 밑 타임스탬프 산출물 폴더(이번 것 + 이전 실행에서
  // 파일 잠금 등으로 못 지우고 남은 것들)를 모두 정리 — 빌드마다 수백MB~수GB씩 계속 쌓이는 것 방지.
  // 실패해도(다른 프로세스가 파일을 잠그고 있는 경우 등) 빌드 자체는 성공으로 취급한다.
  try {
    for (const name of fs.readdirSync(path.join(projectRoot, '.cache'))) {
      if (!name.startsWith('electron-builder-output-')) continue;
      try {
        fs.rmSync(path.join(projectRoot, '.cache', name), { recursive: true, force: true });
      } catch (err) {
        console.warn('[run-electron-builder] .cache 산출물 정리 실패(무시):', name, err.message);
      }
    }
  } catch (err) {
    console.warn('[run-electron-builder] .cache 정리 중 오류(무시):', err.message);
  }
}

process.exit(result.status ?? 1);
