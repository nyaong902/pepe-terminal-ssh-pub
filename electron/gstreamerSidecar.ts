// electron/gstreamerSidecar.ts
// 미디어 플레이어 — EVS/AMR-NB/AMR-WB/OPUS 재생을 위한 네이티브 GStreamer 사이드카.
//
// SIPp 사이드카와 달리 상시 상주 프로세스가 아니라 "파일 1개 디코딩 1회 실행" 모델이다:
// gst-launch-1.0.exe 를 짧은 파이프라인(파일 읽기 → 해당 코덱 디코더 → WAV 인코딩 →
// 임시 파일 저장)으로 spawn 하고, 종료를 기다렸다가 결과 WAV 경로를 반환한다.
// 렌더러는 이후 이 WAV 파일을 mediaDecodeLocal(로컬 코드 경로)로 읽어 Web Audio API 로
// 재생한다 — GStreamer 사이드카는 "디코딩"만 담당하고 실제 재생 파이프라인은 통일한다.
//
// 바이너리/플러그인 경로:
//   env PEPE_GST 우선 → 패키지: <resources>/gstreamer-sidecar/<plat>/gst-launch-1.0.exe
//                     → dev:    <repo>/gstreamer-sidecar/bin/<plat>/gst-launch-1.0.exe
import { app } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

function platDir(): string {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return 'linux-x64';
}

function sidecarRoot(): string | null {
  const candidates: string[] = [];
  if (process.env.PEPE_GST_ROOT) candidates.push(process.env.PEPE_GST_ROOT);
  try {
    if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'gstreamer-sidecar', platDir()));
    else candidates.push(path.join(process.cwd(), 'gstreamer-sidecar', 'bin', platDir()));
  } catch { /* app not ready 등 — 다음 후보로 */ }
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  return null;
}

export function resolveBinary(): string | null {
  const root = sidecarRoot();
  if (!root) return null;
  const bin = path.join(root, process.platform === 'win32' ? 'gst-launch-1.0.exe' : 'gst-launch-1.0');
  return fs.existsSync(bin) ? bin : null;
}

// libgstipgevs.dll(EVS 플러그인)은 회사 소유 코덱 소스로 로컬 빌드해야 하는 바이너리라
// git 공개 저장소에는 절대 커밋하지 않는다 — 대신 진짜 플러그인이 아닌 더미 텍스트
// placeholder 를 커밋해 둔다(gstreamer-sidecar/ipg-plugin/ipgevs/README.md 참고).
// git 클론만 받아 빌드한 사람은 이 더미가 로드되므로 EVS 선택 시 아래에서 명확히
// 에러 처리한다. 실제 동작하는 DLL을 로컬에 두려면 PEPE_GST_ROOT 를 그 DLL이 포함된
// 사이드카 루트 디렉터리로 지정하면 된다(레포 트리 바깥, 커밋 대상 아님).
const EVS_PLACEHOLDER_MAGIC = '#!PEPE_EVS_PLACEHOLDER';
const EVS_UNAVAILABLE_MSG =
  'EVS 코덱은 이 빌드에서 지원되지 않습니다 (라이선스 제약으로 EVS 플러그인 바이너리가 포함되어 있지 않음). ' +
  '이 파일이 EVS로 암호화/인코딩된 음원이라면 재생할 수 없습니다.';

function isEvsPluginAvailable(root: string): boolean {
  const dll = path.join(root, 'gstreamer-1.0', process.platform === 'win32' ? 'libgstipgevs.dll' : 'libgstipgevs.so');
  try {
    if (!fs.existsSync(dll)) return false;
    const fd = fs.openSync(dll, 'r');
    try {
      const head = Buffer.alloc(EVS_PLACEHOLDER_MAGIC.length);
      fs.readSync(fd, head, 0, head.length, 0);
      return head.toString('latin1') !== EVS_PLACEHOLDER_MAGIC;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function isEvsSupported(): boolean {
  const root = sidecarRoot();
  return !!root && isEvsPluginAvailable(root);
}

export type MediaCodecKind = 'evs' | 'amrnb' | 'amrwb' | 'opus';

// gst-launch 는 property 문자열 값 안의 '\' 를 이스케이프 문자로 해석해 그대로 제거해버린다
// (Windows 경로 "C:\Users\..." 를 "C:Users..." 로 깨뜨림) — 슬래시로 바꿔서 넘겨야 한다.
// Windows 는 forward-slash 경로도 그대로 지원하므로 안전하다.
function toGstPath(p: string): string {
  return p.replace(/\\/g, '/');
}

// 3GPP EVS 컴팩트 저장 포맷(#!EVS_MC1.0\n[TOC][SPEECH]...)을 읽는 ipgevsparse+ipgevsdec,
// 3GPP TS26.201 표준 AMR/AMR-WB 저장 포맷(#!AMR\n / #!AMR-WB\n)을 읽는 amrparse+amrnbdec/amrwbdec,
// Ogg-Opus 컨테이너를 읽는 oggdemux+opusdec — 모두 표준 헤더 감지 기반이라 별도 옵션 불필요.
function buildDecodePipeline(kind: MediaCodecKind, inPath: string, outPath: string): string[] {
  const src = ['filesrc', `location=${toGstPath(inPath)}`];
  const sink = ['wavenc', '!', 'filesink', `location=${toGstPath(outPath)}`];
  switch (kind) {
    case 'evs':
      return [...src, '!', 'ipgevsparse', '!', 'ipgevsdec', '!', 'audioconvert', '!', ...sink];
    case 'amrnb':
      return [...src, '!', 'amrparse', '!', 'amrnbdec', '!', 'audioconvert', '!', ...sink];
    case 'amrwb':
      return [...src, '!', 'amrparse', '!', 'amrwbdec', '!', 'audioconvert', '!', ...sink];
    case 'opus':
      return [...src, '!', 'oggdemux', '!', 'opusdec', '!', 'audioconvert', '!', ...sink];
  }
}

// gst-launch 를 spawn 해서 종료를 기다리고, 결과 파일이 실제로 만들어졌는지까지 확인한다
// (디코드/인코드 둘 다 "파이프라인 실행 → 출력 파일 검증"이라는 동일한 모양이라 공용 헬퍼로 뺐다).
function runGstPipeline(args: string[], outPath: string, minOutSize: number): Promise<{ ok: true } | { error: string }> {
  return new Promise((resolve) => {
    const bin = resolveBinary();
    const root = sidecarRoot();
    if (!bin || !root) {
      resolve({ error: 'GStreamer 사이드카 바이너리를 찾을 수 없습니다. gstreamer-sidecar/bin/<plat>/ 에 배치하거나 PEPE_GST_ROOT 환경변수로 경로를 지정하세요.' });
      return;
    }
    const registryPath = path.join(os.tmpdir(), `pepe-gst-registry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        GST_PLUGIN_PATH: path.join(root, 'gstreamer-1.0'),
        GST_PLUGIN_SYSTEM_PATH: '',
        GST_REGISTRY: registryPath,
      },
    });
    let stderrBuf = '';
    proc.stderr.on('data', (d) => { stderrBuf += d.toString('utf-8'); });
    proc.on('error', (e) => resolve({ error: `GStreamer 실행 실패: ${e?.message || e}` }));
    proc.on('exit', (code) => {
      try { fs.unlinkSync(registryPath); } catch {}
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > minOutSize) {
        resolve({ ok: true });
      } else {
        resolve({ error: `GStreamer 처리 실패 (exit ${code}): ${stderrBuf.slice(-500) || '알 수 없는 오류'}` });
      }
    });
  });
}

export function decodeToWav(filePath: string, kind: MediaCodecKind): Promise<{ wavPath: string } | { error: string }> {
  return new Promise(async (resolve) => {
    const root = sidecarRoot();
    if (root && kind === 'evs' && !isEvsPluginAvailable(root)) {
      resolve({ error: EVS_UNAVAILABLE_MSG });
      return;
    }
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outPath = path.join(os.tmpdir(), `pepe-gst-dec-${runId}.wav`);
    const args = buildDecodePipeline(kind, filePath, outPath);
    const result = await runGstPipeline(args, outPath, 44);
    if ('error' in result) resolve({ error: result.error });
    else resolve({ wavPath: outPath });
  });
}

// ── 인코딩 — 미디어 편집기의 "모든 코덱으로 저장" 기능용. WAV 입력 → 각 코덱 출력. ──
// EVS/AMR-NB/AMR-WB 는 통화 음성 코덱이라 8kHz(NB)/16kHz(WB/EVS) 모노가 표준 입력이므로
// audioresample+audioconvert 로 맞춰준다. OPUS 는 48kHz 가 권장 샘플레이트.
function buildEncodePipeline(kind: MediaCodecKind, inPath: string, outPath: string): string[] {
  const src = ['filesrc', `location=${toGstPath(inPath)}`, '!', 'wavparse', '!', 'audioconvert', '!', 'audioresample'];
  const sinkTo = (loc: string) => ['filesink', `location=${loc}`];
  switch (kind) {
    case 'amrnb':
      return [...src, '!', 'audio/x-raw,rate=8000,channels=1', '!', 'amrnbenc', '!', ...sinkTo(toGstPath(outPath))];
    case 'amrwb':
      return [...src, '!', 'audio/x-raw,rate=16000,channels=1', '!', 'voamrwbenc', '!', ...sinkTo(toGstPath(outPath))];
    case 'evs':
      return [...src, '!', 'audio/x-raw,rate=16000,channels=1', '!', 'ipgevsenc', '!', ...sinkTo(toGstPath(outPath))];
    case 'opus':
      return [...src, '!', 'audio/x-raw,rate=48000', '!', 'opusenc', '!', 'oggmux', '!', ...sinkTo(toGstPath(outPath))];
  }
}

/**
 * WAV 파일을 지정 코덱의 raw 인코드 바이트로 변환한다 (저장 포맷 헤더/매직은 호출부에서 씌운다
 * — AMR-NB/AMR-WB 인코더 raw 출력은 이미 [ToC][frame] storage 구조와 동일하고, OPUS 는
 * oggmux 를 거쳐 완결된 Ogg 컨테이너를 그대로 파일로 쓴다).
 */
export function encodeFromWav(wavPath: string, kind: MediaCodecKind): Promise<{ outPath: string } | { error: string }> {
  return new Promise(async (resolve) => {
    const root = sidecarRoot();
    if (root && kind === 'evs' && !isEvsPluginAvailable(root)) {
      resolve({ error: EVS_UNAVAILABLE_MSG });
      return;
    }
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ext = kind === 'opus' ? '.ogg' : '.raw';
    const outPath = path.join(os.tmpdir(), `pepe-gst-enc-${runId}${ext}`);
    const args = buildEncodePipeline(kind, wavPath, outPath);
    const result = await runGstPipeline(args, outPath, 0);
    if ('error' in result) resolve({ error: result.error });
    else resolve({ outPath });
  });
}

/**
 * 임의의 WAV 파일을 8kHz 모노 16bit WAV 로 리샘플링한다 — A-law/u-law(G.711) 저장은 항상
 * 8kHz 모노 입력을 요구하는데, 편집된 오디오는 원본 코덱의 샘플레이트(예: EVS/AMR-WB 의
 * 16kHz)를 그대로 갖고 있을 수 있어 로컬 인코더에 넘기기 전에 GStreamer 로 리샘플한다.
 */
export function resampleWavTo8kMono(wavPath: string): Promise<{ outPath: string } | { error: string }> {
  return new Promise(async (resolve) => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outPath = path.join(os.tmpdir(), `pepe-gst-resample-${runId}.wav`);
    const args = [
      'filesrc', `location=${toGstPath(wavPath)}`, '!', 'wavparse', '!', 'audioconvert', '!', 'audioresample',
      '!', 'audio/x-raw,rate=8000,channels=1', '!', 'wavenc', '!', 'filesink', `location=${toGstPath(outPath)}`,
    ];
    const result = await runGstPipeline(args, outPath, 44);
    if ('error' in result) resolve({ error: result.error });
    else resolve({ outPath });
  });
}
