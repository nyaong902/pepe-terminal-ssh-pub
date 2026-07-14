// src/components/MediaEditPanel.tsx
// Audacity 참고 — 파형 표시 + 구간 선택 기반 기본 편집(자르기/삭제/페이드 인·아웃/게인) 툴바.
// 실제 편집 연산은 utils/audioEdit.ts 의 순수 함수에 위임하고, 결과 AudioBuffer 를
// onBufferReplace 로 상위(MediaWorkspace)에 되돌려준다.
import { useState, useEffect } from 'react';
import { MediaWaveform, type Selection } from './MediaWaveform';
import { MediaPasswordPrompt } from './MediaPasswordPrompt';
import { trimToSelection, deleteSelection, applyFade, applyGainDb, audioBufferToWav } from '../utils/audioEdit';

const api = () => (window as any).api || {};

type MediaCodec = 'wav' | 'alaw' | 'ulaw' | 'amrnb' | 'amrwb' | 'evs' | 'opus' | 'raw' | 'video' | 'unknown';

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const toolBtnStyle: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 6, border: '1px solid var(--win-border, #30363d)',
  background: 'var(--win-surface, #161b22)', color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer',
};

export function MediaEditPanel({ docId: _docId, fileName, originalCodec, buffer, position, selection, onSelectionChange, onSeek, onPlayPause, isPlaying, onBufferReplace }: {
  docId: string;
  fileName: string;
  originalCodec: MediaCodec;
  buffer: AudioBuffer;
  position: number;
  selection: Selection;
  onSelectionChange: (sel: Selection) => void;
  onSeek: (sec: number) => void;
  onPlayPause: () => void;
  isPlaying: boolean;
  onBufferReplace: (buffer: AudioBuffer) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [savingAllCodecs, setSavingAllCodecs] = useState(false);
  const [pendingEncryptPassword, setPendingEncryptPassword] = useState(false);
  const [encrypting, setEncrypting] = useState(false);
  const [cryptoAvailable, setCryptoAvailable] = useState(false);

  useEffect(() => {
    api().mediaCryptoAvailable?.().then((available: boolean) => setCryptoAvailable(!!available));
  }, []);

  const hasSelection = !!selection && Math.abs(selection.endSec - selection.startSec) > 0.01;
  const ctx = () => new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);

  const doTrim = () => {
    if (!hasSelection || !selection) return;
    onBufferReplace(trimToSelection(ctx(), buffer, selection.startSec, selection.endSec));
  };
  const doDelete = () => {
    if (!hasSelection || !selection) return;
    onBufferReplace(deleteSelection(ctx(), buffer, selection.startSec, selection.endSec));
  };
  const doFadeIn = () => {
    if (!hasSelection || !selection) return;
    onBufferReplace(applyFade(ctx(), buffer, selection.startSec, selection.endSec, 'in'));
  };
  const doFadeOut = () => {
    if (!hasSelection || !selection) return;
    onBufferReplace(applyFade(ctx(), buffer, selection.startSec, selection.endSec, 'out'));
  };
  const doGain = (db: number) => {
    const s = hasSelection && selection ? selection.startSec : 0;
    const e = hasSelection && selection ? selection.endSec : buffer.duration;
    onBufferReplace(applyGainDb(ctx(), buffer, s, e, db));
  };

  const baseFileName = () => fileName.replace(/\.[^./\\]+$/, '');

  const summarizeResult = (result: any): string => {
    if (!result || result.error) return `저장 실패: ${result?.error || '알 수 없는 오류'}`;
    if (result.canceled) return '';
    const savedCount = result.saved?.length || 0;
    const failedCount = result.failed?.length || 0;
    let msg = `${result.targetDir} 에 ${savedCount}개 파일 저장됨`;
    if (failedCount > 0) {
      const failList = result.failed.map((f: any) => `${f.codec}(${f.error})`).join(', ');
      msg += ` — 실패 ${failedCount}개: ${failList}`;
    }
    return msg;
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const wav = audioBufferToWav(buffer);
      const defaultName = baseFileName() + '_edited.wav';
      const result = await api().officeDocSaveFile?.({
        data: wav,
        defaultName,
        filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
      });
      if (result?.success) setMessage(`저장됨: ${result.filePath}`);
      else if (!result?.canceled) setMessage(`저장 실패: ${result?.error || '알 수 없는 오류'}`);
    } finally {
      setSaving(false);
    }
  };

  // 원본 파일의 코덱을 제외한 나머지 코덱(alaw/ulaw/opus/evs/amrwb/amrnb/wav 중 6개)으로
  // 한 번에 인코딩해 저장 — 편집된 오디오를 WAV 바이트로 만들어 메인 프로세스에 넘기면
  // 거기서 코덱별 인코딩(GStreamer 사이드카 또는 로컬 alaw/ulaw)을 수행한다.
  const handleSaveAllCodecs = async () => {
    setSavingAllCodecs(true);
    setMessage(null);
    try {
      const wav = audioBufferToWav(buffer);
      const result = await api().mediaSaveAllCodecs?.({
        wavData: wav,
        baseFileName: baseFileName(),
        excludeCodec: originalCodec,
      });
      const summary = summarizeResult(result);
      if (summary) setMessage(summary);
    } finally {
      setSavingAllCodecs(false);
    }
  };

  const handleEncryptedSave = async (password: string, version: number) => {
    setPendingEncryptPassword(false);
    setEncrypting(true);
    setMessage(null);
    try {
      const wav = audioBufferToWav(buffer);
      const result = await api().mediaSaveEncryptedAllCodecs?.({
        wavData: wav,
        baseFileName: baseFileName(),
        password,
        version,
      });
      const summary = summarizeResult(result);
      if (summary) setMessage(summary);
    } finally {
      setEncrypting(false);
    }
  };

  return (
    <div style={{ width: '100%', maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <MediaWaveform
        buffer={buffer}
        position={position}
        selection={selection}
        onSeek={onSeek}
        onSelectionChange={onSelectionChange}
      />
      <div style={{ fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)', textAlign: 'center' }}>
        {fmtTime(position)} / {fmtTime(buffer.duration)}
        {hasSelection && selection && ` — 선택: ${fmtTime(selection.startSec)} ~ ${fmtTime(selection.endSec)}`}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button onClick={onPlayPause} style={toolBtnStyle}>{isPlaying ? '⏸ 일시정지' : '▶ 재생'}</button>
        <button onClick={doTrim} disabled={!hasSelection} style={{ ...toolBtnStyle, opacity: hasSelection ? 1 : 0.5 }}>✂️ 선택 구간만 남기기</button>
        <button onClick={doDelete} disabled={!hasSelection} style={{ ...toolBtnStyle, opacity: hasSelection ? 1 : 0.5 }}>🗑 선택 구간 삭제</button>
        <button onClick={doFadeIn} disabled={!hasSelection} style={{ ...toolBtnStyle, opacity: hasSelection ? 1 : 0.5 }}>📈 페이드 인</button>
        <button onClick={doFadeOut} disabled={!hasSelection} style={{ ...toolBtnStyle, opacity: hasSelection ? 1 : 0.5 }}>📉 페이드 아웃</button>
        <button onClick={() => doGain(3)} style={toolBtnStyle}>🔊 +3dB{hasSelection ? ' (선택)' : ' (전체)'}</button>
        <button onClick={() => doGain(-3)} style={toolBtnStyle}>🔉 -3dB{hasSelection ? ' (선택)' : ' (전체)'}</button>
        <button onClick={handleSave} disabled={saving} style={toolBtnStyle}>{saving ? '저장 중...' : '💾 WAV로 저장'}</button>
        <button onClick={handleSaveAllCodecs} disabled={savingAllCodecs} style={toolBtnStyle}>{savingAllCodecs ? '저장 중...' : '🎛 모든 코덱 저장'}</button>
        <button
          onClick={() => setPendingEncryptPassword(true)}
          disabled={encrypting || !cryptoAvailable}
          title={cryptoAvailable ? undefined : '암호화 기능을 사용할 수 없습니다 (crypto-local-package 미설치)'}
          style={{ ...toolBtnStyle, opacity: cryptoAvailable ? 1 : 0.5 }}
        >{encrypting ? '저장 중...' : '🔒 암호화 코덱 저장'}</button>
      </div>
      {message && <div style={{ fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)', textAlign: 'center', maxWidth: 700 }}>{message}</div>}
      {pendingEncryptPassword && (
        <MediaPasswordPrompt
          fileName={fileName}
          title="🔒 암호화 코덱 저장"
          description={`편집된 오디오를 모든 코덱(alaw/ulaw/opus/evs/amrwb/amrnb/wav)으로 변환한 뒤, 설정한 비밀번호와 버전으로 각각 암호화해 저장합니다.`}
          showVersionInput
          onSubmit={handleEncryptedSave}
          onCancel={() => setPendingEncryptPassword(false)}
        />
      )}
    </div>
  );
}
