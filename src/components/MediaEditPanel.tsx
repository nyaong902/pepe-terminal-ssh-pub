// src/components/MediaEditPanel.tsx
// Audacity 참고 — 파형 표시 + 구간 선택 기반 기본 편집(자르기/삭제/페이드 인·아웃/게인) 툴바.
// 실제 편집 연산은 utils/audioEdit.ts 의 순수 함수에 위임하고, 결과 AudioBuffer 를
// onBufferReplace 로 상위(MediaWorkspace)에 되돌려준다.
import { useState } from 'react';
import { MediaWaveform, type Selection } from './MediaWaveform';
import { trimToSelection, deleteSelection, applyFade, applyGainDb, audioBufferToWav } from '../utils/audioEdit';

const api = () => (window as any).api || {};

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

export function MediaEditPanel({ docId: _docId, fileName, buffer, position, selection, onSelectionChange, onSeek, onPlayPause, isPlaying, onBufferReplace }: {
  docId: string;
  fileName: string;
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

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const wav = audioBufferToWav(buffer);
      const defaultName = fileName.replace(/\.[^./\\]+$/, '') + '_edited.wav';
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
      </div>
      {message && <div style={{ fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)', textAlign: 'center' }}>{message}</div>}
    </div>
  );
}
