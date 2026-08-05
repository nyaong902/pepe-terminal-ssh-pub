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

// 어떤 패키지의 런타임 의존성 닫힘(transitive closure)을 node_modules 기준 상대 경로로 돌려준다.
//
// 왜 닫힘 전체가 필요한가: chat-archive-ai 번들은 app.asar.unpacked/node_modules 로 풀리고,
// 거기서 로드된 모듈의 bare import 는 **실제 파일시스템**만 거슬러 올라가며 해석된다(asar 내부는
// 절대 보지 못한다). 그래서 @xenova/transformers 만 넣었더니 실사용에서
//   Cannot find package '@huggingface/jinja' imported from ...\@xenova\transformers\src\tokenizers.js
// 로 죽었다. sharp 처럼 앱이 이미 unpacked 에 갖고 있는 패키지도 그 하위 의존성
// (detect-libc/semver)까지 같은 트리에 있어야 하므로 예외 없이 전부 담는다 — asar 안에서
// require 될 때는 asar 네임스페이스에서 해석돼 지금까지 문제가 없었을 뿐이다.
//
// 목록을 손으로 적으면 의존성이 바뀔 때 조용히 깨지므로 빌드 시점에 계산한다.
// 선두 '@' 는 bsdtar 가 "다른 아카이브 이어붙이기" 지시어로 해석하므로 './' 를 붙인다.
//
// 중첩 node_modules 를 반드시 Node 와 같은 방식으로 따라가야 한다. 처음엔 최상위
// node_modules/<이름>/package.json 만 읽었더니, @xenova/transformers/node_modules/sharp
// (최상위 sharp 와 다른 버전이 중첩 설치돼 있다)의 의존성 'color' 를 놓쳐서 실사용에서
//   Cannot find module 'color' ... @xenova/transformers/node_modules/sharp/lib/input.js
// 로 죽었다. 그래서 각 의존성을 그 패키지 디렉터리에서부터 상위로 올라가며 해석한다.

// Node 의 모듈 해석과 동일하게 fromDir 에서 위로 올라가며 node_modules/<dep> 를 찾는다.
// (require.resolve 는 exports 맵이 ./package.json 을 막아둔 패키지에서 실패하므로 직접 구현)
function resolvePkgDir(fromDir, dep) {
  let cur = fromDir;
  for (;;) {
    const cand = path.join(cur, 'node_modules', dep);
    try { if (fs.existsSync(path.join(cand, 'package.json'))) return cand; } catch {}
    const parent = path.dirname(cur);
    if (parent === cur || !parent.startsWith(projectRoot)) return null;
    cur = parent;
  }
}

function depClosure(rootPkg) {
  const nm = path.join(projectRoot, 'node_modules');
  const topNames = new Set();   // zip 에 담을 "최상위 node_modules 기준" 이름
  const visited = new Set();    // 이미 훑은 패키지 디렉터리(중첩 포함)
  const start = path.join(nm, rootPkg);
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop();
    if (visited.has(dir)) continue;
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
    catch { continue; }
    visited.add(dir);
    // 이 디렉터리가 속한 최상위 패키지를 목록에 넣는다. 중첩된 것은 그 조상을 담으면
    // tar 가 재귀로 함께 가져가므로 따로 넣지 않아도 된다.
    const rel = path.relative(nm, dir).split(path.sep);
    if (rel[0] && rel[0] !== '..') {
      topNames.add(rel[0].startsWith('@') ? `${rel[0]}/${rel[1]}` : rel[0]);
    }
    for (const dep of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) })) {
      const d = resolvePkgDir(dir, dep);
      if (d) stack.push(d);   // 못 찾으면 설치 안 된 optional 의존성 — 건너뛴다
    }
  }
  const list = [...topNames].sort().map(n => './' + n);
  console.log(`[zip-optional-bundles] ${rootPkg} 의존성 닫힘 — 패키지 디렉터리 ${visited.size}개, 최상위 ${list.length}개`);
  return list;
}

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
  // 대화 아카이브 검색의 AI 런타임 — 설치본에서 가장 큰 선택 항목(약 142MB: @xenova/transformers
  // 50MB + onnxruntime-node 92MB + web/common). 다른 번들과 달리 원본이 resources/ 가 아니라
  // node_modules 라서, package.json 의 build.files 에서 그 패키지들을 asar 대상에서 빼고(!패턴)
  // 여기서 zip 하나로 묶는다.
  //
  // zip 루트에 패키지 폴더가 그대로 오도록(-C node_modules @xenova ...) 만들고, 설치 시에는
  // resources/app.asar.unpacked/node_modules 로 푼다. 그 위치여야 transformers 가 정적으로
  // import 하는 sharp / @img (합쳐 20MB, 앱 본체가 이미 쓰고 있어 항상 설치됨)를 같은
  // node_modules 에서 찾는다 — 별도 폴더로 풀면 이 둘을 번들에 중복으로 넣어야 한다.
  // (transformers 는 sharp / onnxruntime-node / onnxruntime-web 를 모두 정적 ESM import 한다.)
  // '@xenova' 를 그대로 넘기면 bsdtar 가 선두 @ 를 "다른 아카이브의 항목을 이어붙이기"
  // 지시어로 해석해 "Failed to open 'xenova'" 로 실패한다 — './' 를 붙여 파일 이름으로 넘긴다.
  //
  // store: 압축하지 않고 담기만 한다. 처음엔 다른 번들처럼 deflate 로 압축했는데(76.6MB),
  // 그러면 설치 파일(.exe)이 442MB -> 468MB 로 오히려 25MB 커졌다 — 선택 설치 번들은 체크
  // 여부와 무관하게 설치 파일에 항상 들어가야 하고, NSIS 는 자체 LZMA 로 페이로드를 압축하는데
  // 이미 압축된 zip 은 더 줄일 수 없기 때문이다(같은 253MB 원본을 NSIS LZMA 는 약 51MB 로,
  // zip deflate 는 76.6MB 로 줄인다). 무압축으로 담아 NSIS 가 직접 압축하게 하면 설치 파일
  // 크기가 원래대로 돌아오고, 설치 시 압축 해제도 그만큼 빨라진다.
  //
  // exclude:
  //  - *.map — 소스맵은 런타임에 전혀 읽히지 않는데 이 세 패키지에 18.8MB 들어 있다
  //    (@xenova/transformers 4.1MB + onnxruntime-web 14.7MB). package.json 의 build.files 가
  //    이미 우리 코드에 대해 '!dist/**/*.map' 로 같은 정책을 쓰고 있어 그것과 맞춘 것.
  //  - *.wasm — 브라우저용 WASM 실행 백엔드. 같은 파일이 두 벌(@xenova/transformers/dist 36.6MB +
  //    onnxruntime-web/dist 36.6MB = 73MB) 들어 있는데, Electron 메인 프로세스(Node)에서는
  //    네이티브 onnxruntime-node(92MB)가 백엔드로 쓰이고 wasm 은 세션 생성 시점에야 로드된다.
  //    onnxruntime-web 패키지 자체는 transformers 가 정적 import 하므로 JS 는 남겨둔다.
  //    ⚠ 이건 빌드로는 검증되지 않는다 — 대화 아카이브 검색이 실제로 결과를 내는지 확인이 필요하다.
  //    문제가 생기면 아래 exclude 에서 '*.wasm' 만 빼면 원상복구된다.
  { name: 'chat-archive-ai', srcDir: path.join(projectRoot, 'node_modules'), store: true,
    exclude: ['*.map', '*.wasm'],
    only: depClosure('@xenova/transformers') },
  // 원격 공유(WebRTC) — 시그널링에 쓰는 ws 패키지(약 195KB)만 필요하다. 용량은 작지만 체크를
  // 해제하면 관련 파일이 아예 안 깔리게 해달라는 요청이라 다른 선택 기능과 같은 방식으로 묶는다.
  // chat-archive-ai 와 같은 구조(원본이 node_modules) — build.files 에서 asar 대상에서 빼고
  // 설치 시 app.asar.unpacked/node_modules 로 푼다. ws 는 런타임 의존성이 없어 닫힘도 자기 하나다.
  { name: 'remote-share', srcDir: path.join(projectRoot, 'node_modules'), store: true,
    only: depClosure('ws') },
  // 원격 공유(WebRTC) — 시그널링에 쓰는 ws 패키지(약 195KB)만 필요하다. 용량은 작지만 체크를
  // 해제하면 관련 파일이 아예 안 깔리게 해달라는 요청이라 다른 선택 기능과 같은 방식으로 묶는다.
  // chat-archive-ai 와 같은 구조(원본이 node_modules) — build.files 에서 asar 대상에서 빼고
  // 설치 시 app.asar.unpacked/node_modules 로 푼다. ws 는 런타임 의존성이 없어 닫힘도 자기 하나다.
  { name: 'remote-share', srcDir: path.join(projectRoot, 'node_modules'), store: true,
    only: depClosure('ws') },
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
  // store 지정 시 무압축(위 chat-archive-ai 주석 참고) — 확장자는 그대로 .zip 이라
  // installer.nsh / ensureBundleExtracted 의 tar -xf 로 똑같이 풀린다.
  const storeOpt = b.store ? ['--options', 'zip:compression=store'] : [];
  const exclOpt = (b.exclude || []).flatMap(pat => ['--exclude', pat]);
  const args = b.only
    ? ['-a', ...storeOpt, ...exclOpt, '-cf', zipPath, '-C', b.srcDir, ...b.only]
    : ['-a', ...storeOpt, ...exclOpt, '-cf', zipPath, '-C', b.srcDir, '.'];
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
