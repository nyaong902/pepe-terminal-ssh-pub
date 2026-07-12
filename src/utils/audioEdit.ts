// src/utils/audioEdit.ts
// Audacity 참고 — 초 단위 선택 구간에 대한 기본 편집 연산(자르기/삭제/페이드/게인)을
// AudioBuffer -> AudioBuffer 순수 함수로 구현. 실제 재생/디코딩 로직과는 분리.

function cloneBuffer(ctx: BaseAudioContext, src: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
  for (let ch = 0; ch < src.numberOfChannels; ch++) {
    out.getChannelData(ch).set(src.getChannelData(ch));
  }
  return out;
}

function secToSample(buffer: AudioBuffer, sec: number): number {
  return Math.max(0, Math.min(buffer.length, Math.round(sec * buffer.sampleRate)));
}

/** 선택 구간만 남기고 나머지를 잘라낸다 (Audacity의 "Trim Audio"). */
export function trimToSelection(ctx: BaseAudioContext, buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const s = secToSample(buffer, startSec);
  const e = secToSample(buffer, endSec);
  const len = Math.max(1, e - s);
  const out = ctx.createBuffer(buffer.numberOfChannels, len, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.getChannelData(ch).set(buffer.getChannelData(ch).subarray(s, e));
  }
  return out;
}

/** 선택 구간을 삭제하고 앞뒤를 이어붙인다 (Audacity의 "Delete"). */
export function deleteSelection(ctx: BaseAudioContext, buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const s = secToSample(buffer, startSec);
  const e = secToSample(buffer, endSec);
  const removed = Math.max(0, e - s);
  const newLen = Math.max(1, buffer.length - removed);
  const out = ctx.createBuffer(buffer.numberOfChannels, newLen, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.subarray(0, s), 0);
    dst.set(src.subarray(e), s);
  }
  return out;
}

/** 선택 구간에 선형 페이드 인/아웃 적용 (원본 복제 후 구간만 수정). */
export function applyFade(ctx: BaseAudioContext, buffer: AudioBuffer, startSec: number, endSec: number, direction: 'in' | 'out'): AudioBuffer {
  const out = cloneBuffer(ctx, buffer);
  const s = secToSample(buffer, startSec);
  const e = secToSample(buffer, endSec);
  const len = Math.max(1, e - s);
  for (let ch = 0; ch < out.numberOfChannels; ch++) {
    const data = out.getChannelData(ch);
    for (let i = s; i < e; i++) {
      const t = (i - s) / len;
      const gain = direction === 'in' ? t : 1 - t;
      data[i] *= gain;
    }
  }
  return out;
}

/** 선택 구간(또는 미선택 시 전체)의 게인을 dB 단위로 조절. */
export function applyGainDb(ctx: BaseAudioContext, buffer: AudioBuffer, startSec: number, endSec: number, gainDb: number): AudioBuffer {
  const out = cloneBuffer(ctx, buffer);
  const s = secToSample(buffer, startSec);
  const e = secToSample(buffer, endSec);
  const factor = Math.pow(10, gainDb / 20);
  for (let ch = 0; ch < out.numberOfChannels; ch++) {
    const data = out.getChannelData(ch);
    for (let i = s; i < e; i++) {
      data[i] = Math.max(-1, Math.min(1, data[i] * factor));
    }
  }
  return out;
}

/** 무음 구간을 선택 구간(또는 전체 끝)에 삽입. */
export function insertSilence(ctx: BaseAudioContext, buffer: AudioBuffer, atSec: number, durationSec: number): AudioBuffer {
  const at = secToSample(buffer, atSec);
  const silenceLen = Math.max(1, Math.round(durationSec * buffer.sampleRate));
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length + silenceLen, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.subarray(0, at), 0);
    dst.set(src.subarray(at), at + silenceLen);
  }
  return out;
}

/** AudioBuffer 를 표준 PCM16 WAV 바이트로 인코딩 (저장/내보내기용). */
export function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = buffer.length * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return out;
}
