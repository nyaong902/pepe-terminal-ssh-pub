// electron/mediaCodec.ts
// 미디어 플레이어 — 파일 형식/코덱 판별, #!ENC 암호화 파일 복호화(사내 UEnc AES-256-CBC 포맷과 동일),
// 그리고 로컬 코드로 재생 가능한 WAV/A-law/u-law 디코딩을 담당한다.
//
// #!ENC 파일 포맷 (사내 UEnc.c: aes256_enc_file_core_direct / aes256_dec_file_core_direct 와 동일):
//   "#!ENC" + 2자리 버전(hex) + "\n"   (7바이트 헤더)
//   "Salted__"                         (8바이트 고정 문자열)
//   salt                                (8바이트, 파일마다 랜덤)
//   AES-256-CBC 암호문                  (키/IV = PBKDF2-HMAC-SHA256(password, salt, 10000회, 48바이트))
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const UENC_MAGIC = '#!ENC';
const UENC_SALTED_STR = 'Salted__';
const UENC_SALT_LEN = 8;
const UENC_KEY_LEN = 32;
const UENC_IV_LEN = 16;
const UENC_PBKDF2_ITER = 10000;

export type MediaCodec = 'wav' | 'alaw' | 'ulaw' | 'amrnb' | 'amrwb' | 'evs' | 'opus' | 'raw' | 'video' | 'unknown';

// 영상 컨테이너 — Chromium 내장 디코더(Electron 에 이미 포함된 ffmpeg)가 그대로 재생하므로
// GStreamer 사이드카나 로컬 PCM 디코딩 없이, 렌더러의 <video> 엘리먼트에 file:// 로 바로 넘긴다.
// mkv/avi 는 Chromium 이 컨테이너 자체를 지원하지 않아 제외했다.
const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm', '.ogv'];

export type MediaProbeResult = {
  filePath: string;
  fileName: string;
  isEncrypted: boolean;
  encVersion?: number;
  codec: MediaCodec;
};

function hasExtCi(name: string, ext: string): boolean {
  return name.toLowerCase().endsWith(ext);
}

// crypto_tool.c 의 detect_codec() 과 동일한 매직 헤더 + 확장자 판별 순서.
function detectCodec(headerBuf: Buffer, filePath: string): MediaCodec {
  if (headerBuf.length >= 9 && headerBuf.subarray(0, 9).toString('latin1') === '#!AMR-WB\n') return 'amrwb';
  if (headerBuf.length >= 6 && headerBuf.subarray(0, 6).toString('latin1') === '#!AMR\n') return 'amrnb';
  if (headerBuf.length >= 12 && headerBuf.subarray(0, 12).toString('latin1') === '#!EVS_MC1.0\n') return 'evs';
  if (headerBuf.length >= 4 && headerBuf.subarray(0, 4).toString('latin1') === 'OggS') return 'opus';
  if (headerBuf.length >= 4 && headerBuf.subarray(0, 4).toString('latin1') === 'RIFF') return 'wav';
  if (VIDEO_EXTENSIONS.some(ext => hasExtCi(filePath, ext))) return 'video';
  if (hasExtCi(filePath, '.pcma') || hasExtCi(filePath, '.alaw') || hasExtCi(filePath, '.al')) return 'alaw';
  if (hasExtCi(filePath, '.pcmu') || hasExtCi(filePath, '.ulaw') || hasExtCi(filePath, '.mulaw') || hasExtCi(filePath, '.ul')) return 'ulaw';
  if (hasExtCi(filePath, '.amr') || hasExtCi(filePath, '.amrnb')) return 'amrnb';
  if (hasExtCi(filePath, '.awb') || hasExtCi(filePath, '.amrwb')) return 'amrwb';
  if (hasExtCi(filePath, '.evs')) return 'evs';
  if (hasExtCi(filePath, '.opus')) return 'opus';
  if (hasExtCi(filePath, '.wav')) return 'wav';
  if (hasExtCi(filePath, '.raw')) return 'raw';
  return 'unknown';
}

/** #!ENC 헤더 여부 확인 (uenc_is_encrypted_file 과 동일 로직) — 암호화된 파일이면 내부 실제 코덱은 알 수 없으므로 codec: 'unknown'. */
export function mediaProbeFile(filePath: string): MediaProbeResult {
  const fd = fs.openSync(filePath, 'r');
  try {
    const headerBuf = Buffer.alloc(32);
    const n = fs.readSync(fd, headerBuf, 0, 32, 0);
    const header = headerBuf.subarray(0, n);
    if (n >= 7 && header.subarray(0, 5).toString('latin1') === UENC_MAGIC) {
      const versionStr = header.subarray(5, 7).toString('latin1');
      const version = parseInt(versionStr, 16);
      if (!Number.isNaN(version)) {
        return { filePath, fileName: path.basename(filePath), isEncrypted: true, encVersion: version, codec: 'unknown' };
      }
    }
    return { filePath, fileName: path.basename(filePath), isEncrypted: false, codec: detectCodec(header, filePath) };
  } finally {
    fs.closeSync(fd);
  }
}

function deriveKeyIvSalted(password: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const buffer = crypto.pbkdf2Sync(password, salt, UENC_PBKDF2_ITER, UENC_KEY_LEN + UENC_IV_LEN, 'sha256');
  return { key: buffer.subarray(0, UENC_KEY_LEN), iv: buffer.subarray(UENC_KEY_LEN, UENC_KEY_LEN + UENC_IV_LEN) };
}

/**
 * #!ENC 파일을 평문 비밀번호로 복호화해 임시 파일로 풀어낸다 (aes256_dec_file_core_direct 와 동일 포맷).
 * 실패 시(버전/Salted__ 매직 불일치, 비밀번호 오류로 인한 padding 오류 등) throw.
 */
export function mediaDecryptToTemp(filePath: string, password: string): { tempPath: string; codec: MediaCodec } {
  const input = fs.readFileSync(filePath);
  if (input.length < 7 || input.subarray(0, 5).toString('latin1') !== UENC_MAGIC) {
    throw new Error('#!ENC 헤더가 없는 파일입니다.');
  }
  let headerEnd = input.indexOf(0x0a); // '\n'
  if (headerEnd < 0 || headerEnd > 15) throw new Error('#!ENC 헤더 형식이 올바르지 않습니다.');
  headerEnd += 1;

  const saltedMagic = input.subarray(headerEnd, headerEnd + UENC_SALTED_STR.length).toString('latin1');
  if (saltedMagic !== UENC_SALTED_STR) throw new Error('Salted__ 마커를 찾을 수 없습니다.');
  const saltStart = headerEnd + UENC_SALTED_STR.length;
  const salt = input.subarray(saltStart, saltStart + UENC_SALT_LEN);
  if (salt.length !== UENC_SALT_LEN) throw new Error('salt 길이가 올바르지 않습니다.');

  const cipherStart = saltStart + UENC_SALT_LEN;
  const ciphertext = input.subarray(cipherStart);

  const { key, iv } = deriveKeyIvSalted(password, Buffer.from(salt));
  let plaintext: Buffer;
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('비밀번호가 올바르지 않거나 파일이 손상되었습니다.');
  }

  // 암호화된 파일은 원래 확장자를 그대로 유지하는 것이 관례(crypto_tool.c 배치 처리와 동일) —
  // A-law/u-law/raw 는 매직 헤더가 없어 확장자가 유일한 판별 근거이므로 원본 파일 경로로 판별한다.
  const probe = detectCodec(plaintext.subarray(0, 32), filePath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pepe-media-dec-'));
  const tempPath = path.join(tempDir, path.basename(filePath) || 'decrypted.bin');
  fs.writeFileSync(tempPath, plaintext);
  return { tempPath, codec: probe };
}

// ── WAV 파싱 (표준 RIFF/WAVE, fmt 청크 실제 값 기반 — 하드코딩 오프셋 사용 안 함) ──
export type WavInfo = { sampleRate: number; channels: number; bitsPerSample: number; audioFormat: number; dataOffset: number; dataLength: number };

export function parseWavHeader(buf: Buffer): WavInfo {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('올바른 WAV 파일이 아닙니다.');
  }
  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let data: { offset: number; length: number } | null = null;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('latin1', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(bodyStart),
        channels: buf.readUInt16LE(bodyStart + 2),
        sampleRate: buf.readUInt32LE(bodyStart + 4),
        bitsPerSample: buf.readUInt16LE(bodyStart + 14),
      };
    } else if (chunkId === 'data') {
      data = { offset: bodyStart, length: Math.min(chunkSize, buf.length - bodyStart) };
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }
  if (!fmt || !data) throw new Error('WAV fmt/data 청크를 찾을 수 없습니다.');
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, audioFormat: fmt.audioFormat, dataOffset: data.offset, dataLength: data.length };
}

// ── G.711 A-law / u-law → 16bit PCM 디코드 (표준 ITU-T G.711 테이블 기반, 로컬 코드로 처리) ──
function buildAlawTable(): Int16Array {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let alaw = i ^ 0x55;
    let sign = alaw & 0x80;
    let exponent = (alaw & 0x70) >> 4;
    let mantissa = alaw & 0x0f;
    let sample: number;
    if (exponent === 0) {
      sample = (mantissa << 4) + 8;
    } else {
      sample = ((mantissa << 4) + 0x108) << (exponent - 1);
    }
    table[i] = sign ? -sample : sample;
  }
  return table;
}

function buildUlawTable(): Int16Array {
  const table = new Int16Array(256);
  const BIAS = 0x84;
  for (let i = 0; i < 256; i++) {
    let ulaw = ~i & 0xff;
    let sign = ulaw & 0x80;
    let exponent = (ulaw >> 4) & 0x07;
    let mantissa = ulaw & 0x0f;
    let sample = ((mantissa << 3) + BIAS) << exponent;
    sample -= BIAS;
    table[i] = sign ? -sample : sample;
  }
  return table;
}

const ALAW_TABLE = buildAlawTable();
const ULAW_TABLE = buildUlawTable();

export function decodeAlaw(input: Buffer): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = ALAW_TABLE[input[i]];
  return out;
}

export function decodeUlaw(input: Buffer): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = ULAW_TABLE[input[i]];
  return out;
}

/** WAV/A-law/u-law/headerless-raw-PCM 을 16bit PCM 샘플로 변환 (렌더러에서 Web Audio API 로 재생). */
export function decodeLocalCodec(filePath: string, codec: MediaCodec): { pcm: Int16Array; sampleRate: number; channels: number } {
  const buf = fs.readFileSync(filePath);
  if (codec === 'wav') {
    const info = parseWavHeader(buf);
    const dataBuf = buf.subarray(info.dataOffset, info.dataOffset + info.dataLength);
    if (info.bitsPerSample === 16) {
      const pcm = new Int16Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.length / 2);
      return { pcm: pcm.slice(), sampleRate: info.sampleRate, channels: info.channels || 1 };
    }
    if (info.bitsPerSample === 8) {
      // 8bit WAV 는 unsigned PCM — 16bit signed 로 스케일 변환.
      const pcm = new Int16Array(dataBuf.length);
      for (let i = 0; i < dataBuf.length; i++) pcm[i] = (dataBuf[i] - 128) << 8;
      return { pcm, sampleRate: info.sampleRate, channels: info.channels || 1 };
    }
    throw new Error(`지원하지 않는 WAV 비트: ${info.bitsPerSample}`);
  }
  if (codec === 'alaw') return { pcm: decodeAlaw(buf), sampleRate: 8000, channels: 1 };
  if (codec === 'ulaw') return { pcm: decodeUlaw(buf), sampleRate: 8000, channels: 1 };
  if (codec === 'raw') {
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    return { pcm: pcm.slice(), sampleRate: 8000, channels: 1 };
  }
  throw new Error(`decodeLocalCodec 은 wav/alaw/ulaw/raw 만 지원합니다 (요청: ${codec})`);
}
