#!/usr/bin/env node
// scripts/verify-sidecar-bin.js
// 빌드 전 네이티브 SIP 데몬(sipd) 바이너리가 존재하는지 확인.
// 누락 시 빌드 실패 + 안내 — "설치본에 데몬 누락" 사고 방지.
//
// sipd.exe 는 별도 툴체인(MinGW + pjproject + EVS)으로 빌드해 sip-sidecar/bin/<plat>/ 에
// 배치한다(.gitignore 대상). electron-builder 가 이를 resources/sip-sidecar/<plat>/ 로 번들한다.
//
// 사용법:
//   node scripts/verify-sidecar-bin.js          → 현재 OS 기준 검증
//   node scripts/verify-sidecar-bin.js --skip    → 검증 건너뜀 (SIP 없는 빌드)

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.includes('--skip')) {
  console.log('[verify-sidecar-bin] --skip 플래그 — 검증 건너뜀');
  process.exit(0);
}

function platDir() {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return 'linux-x64';
}
function binName() { return process.platform === 'win32' ? 'sipd.exe' : 'sipd'; }

const dir = path.join(__dirname, '..', 'sip-sidecar', 'bin', platDir());
const bin = path.join(dir, binName());

if (fs.existsSync(bin)) {
  const sz = fs.statSync(bin).size;
  console.log(`[verify-sidecar-bin] ✓ ${path.relative(path.join(__dirname, '..'), bin)} (${sz} bytes)`);
  process.exit(0);
}

console.error(`\n[verify-sidecar-bin] ✕ 네이티브 SIP 데몬이 없습니다: ${bin}`);
console.error('  이대로 빌드하면 설치본에서 등록 시 "네이티브 SIP 데몬 없음" 에러가 납니다.');
console.error('  해결: sip-sidecar 를 빌드해 위 경로에 sipd 바이너리를 배치하세요 (sip-sidecar/README.md).');
console.error('  SIP 기능 없이 빌드하려면: node scripts/verify-sidecar-bin.js --skip\n');
process.exit(1);
