// src/components/MediaWorkspace.tsx
// 미디어 플레이어 워크스페이스 — 오피스 워크스페이스와 동일한 미니탭 구조.
// WAV/A-law/u-law/raw 는 메인 프로세스에서 16bit PCM 으로 디코딩한 뒤 Web Audio API 로 직접 재생(로컬 코드).
// EVS/AMR-WB/AMR-NB/OPUS 는 네이티브 GStreamer 사이드카가 WAV 로 디코딩한 뒤 같은 Web Audio 경로로 재생.
// #!ENC 헤더가 감지되면 평문 비밀번호를 입력받아 복호화한 뒤 임시 파일을 재생 파이프라인에 넘긴다.
import { useEffect, useRef, useState } from 'react';
import { OfficeBackBar } from './OfficeBackBar';
import { OfficeEmptyState } from './OfficeEmptyState';
import { MediaPasswordPrompt } from './MediaPasswordPrompt';
import { type Selection } from './MediaWaveform';
import { MediaEditPanel } from './MediaEditPanel';
import { getMediaRecents, addMediaRecent, removeMediaRecent, setMediaPosition, type MediaRecentDoc } from '../utils/mediaRecents';

const api = () => (window as any).api || {};

type MediaCodec = 'wav' | 'alaw' | 'ulaw' | 'amrnb' | 'amrwb' | 'evs' | 'opus' | 'raw' | 'unknown';
const LOCAL_CODECS: MediaCodec[] = ['wav', 'alaw', 'ulaw', 'raw'];
const GSTREAMER_CODECS: MediaCodec[] = ['evs', 'amrnb', 'amrwb', 'opus'];
const CODEC_LABEL: Record<MediaCodec, string> = {
  wav: 'WAV', alaw: 'A-law', ulaw: 'u-law', raw: 'RAW PCM',
  amrnb: 'AMR-NB', amrwb: 'AMR-WB', evs: 'EVS', opus: 'OPUS', unknown: '알 수 없음',
};

type PlayState = 'idle' | 'loading' | 'need-password' | 'ready' | 'playing' | 'paused' | 'error';

type OpenMedia = {
  id: string;
  filePath: string;
  fileName: string;
  codec: MediaCodec;
  state: PlayState;
  error?: string;
  duration: number;
  position: number;
};

let nextTabId = 0;

const tabStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: '6px 6px 0 0',
  background: active ? 'var(--win-surface, #161b22)' : 'transparent',
  border: '1px solid var(--win-border, #30363d)',
  color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer', maxWidth: 200, whiteSpace: 'nowrap',
});

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function MediaWorkspace(_props: { instanceId: string }) {
  const [docs, setDocs] = useState<OpenMedia[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recents, setRecents] = useState<MediaRecentDoc[]>([]);
  const [pendingPassword, setPendingPassword] = useState<{ id: string; filePath: string; fileName: string; error?: string } | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<Map<string, AudioBufferSourceNode>>(new Map());
  const bufferRef = useRef<Map<string, AudioBuffer>>(new Map());
  const startedAtRef = useRef<Map<string, { ctxTime: number; offset: number }>>(new Map());
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    getMediaRecents().then(setRecents);
  }, []);

  const ensureAudioCtx = (): AudioContext => {
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    return audioCtxRef.current;
  };

  const patchDoc = (id: string, patch: Partial<OpenMedia>) => {
    setDocs(prev => prev.map(d => (d.id === id ? { ...d, ...patch } : d)));
  };

  const applyDecodedPcm = (id: string, pcm: ArrayBuffer, sampleRate: number, channels: number) => {
    const int16 = new Int16Array(pcm);
    const frameCount = Math.floor(int16.length / channels);
    const ctx = ensureAudioCtx();
    const audioBuffer = ctx.createBuffer(channels, frameCount, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) channelData[i] = int16[i * channels + ch] / 32768;
    }
    bufferRef.current.set(id, audioBuffer);
    patchDoc(id, { state: 'ready', duration: audioBuffer.duration });
  };

  // WAV/A-law/u-law/raw — 메인 프로세스에서 16bit PCM 을 받아 AudioBuffer 로 변환.
  const loadLocalCodec = async (id: string, filePath: string, codec: MediaCodec) => {
    const result = await api().mediaDecodeLocal?.(filePath, codec);
    if (!result || result.error) {
      patchDoc(id, { state: 'error', error: result?.error || '디코딩 실패' });
      return;
    }
    const { pcm, sampleRate, channels } = result as { pcm: ArrayBuffer; sampleRate: number; channels: number };
    applyDecodedPcm(id, pcm, sampleRate, channels);
  };

  // EVS/AMR-NB/AMR-WB/OPUS — 네이티브 GStreamer 사이드카가 WAV 로 디코딩한 뒤 같은 PCM 경로로 재생.
  const loadGstreamerCodec = async (id: string, filePath: string, codec: MediaCodec) => {
    const result = await api().mediaDecodeGstreamer?.(filePath, codec);
    if (!result || result.error) {
      patchDoc(id, { state: 'error', error: result?.error || 'GStreamer 디코딩 실패' });
      return;
    }
    const { pcm, sampleRate, channels } = result as { pcm: ArrayBuffer; sampleRate: number; channels: number };
    applyDecodedPcm(id, pcm, sampleRate, channels);
  };

  const openPath = async (filePath: string, fileName: string) => {
    const id = `media-${++nextTabId}`;
    setDocs(prev => [...prev, { id, filePath, fileName, codec: 'unknown', state: 'loading', duration: 0, position: 0 }]);
    setActiveId(id);

    const probe = await api().mediaProbeFile?.(filePath);
    if (!probe || probe.error) {
      patchDoc(id, { state: 'error', error: probe?.error || '파일을 읽을 수 없습니다.' });
      return;
    }
    if (probe.isEncrypted) {
      patchDoc(id, { state: 'need-password' });
      setPendingPassword({ id, filePath, fileName });
      return;
    }
    patchDoc(id, { codec: probe.codec });
    addMediaRecent({ filePath, fileName, codec: probe.codec }).then(setRecents);
    if (LOCAL_CODECS.includes(probe.codec)) {
      await loadLocalCodec(id, filePath, probe.codec);
    } else if (GSTREAMER_CODECS.includes(probe.codec)) {
      await loadGstreamerCodec(id, filePath, probe.codec);
    } else {
      patchDoc(id, { state: 'error', error: `지원하지 않는 코덱입니다: ${probe.codec}` });
    }
  };

  const handleOpenFile = async () => {
    const result = await api().mediaOpenFile?.();
    if (!result || result.error) return;
    await openPath(result.filePath, result.fileName);
  };

  const handleOpenRecent = async (doc: MediaRecentDoc) => {
    await openPath(doc.filePath, doc.fileName);
  };

  const handleRemoveRecent = async (filePath: string) => {
    const next = await removeMediaRecent(filePath);
    setRecents(next);
  };

  const submitPassword = async (password: string) => {
    if (!pendingPassword) return;
    const { id, filePath, fileName } = pendingPassword;
    const result = await api().mediaDecrypt?.(filePath, password);
    if (!result || result.error) {
      setPendingPassword({ ...pendingPassword, error: result?.error || '복호화 실패' });
      return;
    }
    const { tempPath, codec } = result as { tempPath: string; codec: MediaCodec };
    setPendingPassword(null);
    patchDoc(id, { codec });
    addMediaRecent({ filePath, fileName, codec }).then(setRecents);
    if (LOCAL_CODECS.includes(codec)) {
      await loadLocalCodec(id, tempPath, codec);
    } else if (GSTREAMER_CODECS.includes(codec)) {
      await loadGstreamerCodec(id, tempPath, codec);
    } else {
      patchDoc(id, { state: 'error', error: `지원하지 않는 코덱입니다: ${codec}` });
    }
  };

  const stopPlayback = (id: string) => {
    const src = sourceRef.current.get(id);
    if (src) {
      try { src.onended = null; src.stop(); } catch { /* 이미 정지된 경우 무시 */ }
      sourceRef.current.delete(id);
    }
  };

  const play = (id: string) => {
    const buffer = bufferRef.current.get(id);
    const doc = docs.find(d => d.id === id);
    if (!buffer || !doc) return;
    const ctx = ensureAudioCtx();
    stopPlayback(id);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const offset = doc.position >= doc.duration ? 0 : doc.position;
    src.start(0, offset);
    startedAtRef.current.set(id, { ctxTime: ctx.currentTime, offset });
    src.onended = () => {
      sourceRef.current.delete(id);
      patchDoc(id, { state: 'ready', position: 0 });
    };
    sourceRef.current.set(id, src);
    patchDoc(id, { state: 'playing' });
  };

  const pause = (id: string) => {
    const started = startedAtRef.current.get(id);
    const ctx = audioCtxRef.current;
    if (started && ctx) {
      const elapsed = ctx.currentTime - started.ctxTime;
      patchDoc(id, { position: started.offset + elapsed });
    }
    stopPlayback(id);
    patchDoc(id, { state: 'paused' });
  };

  const seek = (id: string, position: number) => {
    const wasPlaying = docs.find(d => d.id === id)?.state === 'playing';
    stopPlayback(id);
    patchDoc(id, { position, state: 'paused' });
    if (wasPlaying) setTimeout(() => play(id), 0);
  };

  // 재생 위치 표시 갱신 (재생 중인 탭에 대해서만 애니메이션 프레임 폴링).
  useEffect(() => {
    const tick = () => {
      const ctx = audioCtxRef.current;
      if (ctx) {
        setDocs(prev => prev.map(d => {
          if (d.state !== 'playing') return d;
          const started = startedAtRef.current.get(d.id);
          if (!started) return d;
          const pos = started.offset + (ctx.currentTime - started.ctxTime);
          return pos !== d.position ? { ...d, position: Math.min(pos, d.duration) } : d;
        }));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const closeDoc = (id: string) => {
    stopPlayback(id);
    bufferRef.current.delete(id);
    startedAtRef.current.delete(id);
    const doc = docs.find(d => d.id === id);
    if (doc && doc.position > 0) setMediaPosition(doc.filePath, doc.position);
    const idx = docs.findIndex(d => d.id === id);
    const next = docs.filter(d => d.id !== id);
    setDocs(next);
    if (activeId === id) setActiveId(next.length ? next[Math.min(idx, next.length - 1)].id : null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
      {docs.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px', borderBottom: '1px solid var(--win-border, #30363d)', overflowX: 'auto', flex: '0 0 auto' }}>
          {docs.map(d => (
            <div key={d.id} onClick={() => setActiveId(d.id)} style={tabStyle(d.id === activeId)}>
              <span>🎵</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.fileName}</span>
              <span onClick={(e) => { e.stopPropagation(); closeDoc(d.id); }} style={{ opacity: 0.7, padding: '0 2px', borderRadius: 4 }}>×</span>
            </div>
          ))}
          <button
            onClick={handleOpenFile}
            title="음원 파일 열기"
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--win-border, #30363d)', background: 'transparent', color: 'var(--win-text, #e6edf3)', fontSize: 13, cursor: 'pointer' }}
          >＋</button>
        </div>
      )}
      <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, position: 'relative' }}>
        {docs.length === 0 && (
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            <OfficeEmptyState
              recents={recents}
              onOpenRecent={handleOpenRecent}
              onRemoveRecent={handleRemoveRecent}
              message="🎵 미디어 플레이어 — 왼쪽에서 최근 재생 항목을 선택하거나 아래 버튼으로 파일을 여세요."
            />
            <button
              onClick={handleOpenFile}
              style={{ position: 'absolute', left: '50%', bottom: '30%', transform: 'translateX(-50%)', padding: '8px 18px', borderRadius: 8, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface, #161b22)', color: 'var(--win-text, #e6edf3)', fontSize: 13, cursor: 'pointer' }}
            >파일 열기</button>
          </div>
        )}
        {docs.map(d => {
          const isPlayable = d.state === 'ready' || d.state === 'playing' || d.state === 'paused';
          const buffer = isPlayable ? bufferRef.current.get(d.id) : undefined;
          return (
          <div key={d.id} style={{ position: 'absolute', inset: 0, display: d.id === activeId ? 'flex' : 'none', flexDirection: 'column' }}>
            <OfficeBackBar
              label={`${d.fileName} — ${CODEC_LABEL[d.codec]}`}
              right={isPlayable ? (
                <button
                  onClick={() => { setEditMode(v => !v); setSelection(null); }}
                  style={{ ...playBtnStyle, padding: '4px 10px', fontSize: 12 }}
                >{editMode ? '재생 모드' : '✂️ 편집'}</button>
              ) : undefined}
            />
            <div style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}>
              {d.state === 'loading' && <div style={{ color: 'var(--win-text-dim, #9aa7b3)' }}>불러오는 중...</div>}
              {d.state === 'need-password' && <div style={{ color: 'var(--win-text-dim, #9aa7b3)' }}>🔒 비밀번호 입력 대기 중...</div>}
              {d.state === 'error' && <div style={{ color: '#e5534b', textAlign: 'center', maxWidth: 420 }}>{d.error}</div>}
              {isPlayable && editMode && buffer && (
                <MediaEditPanel
                  docId={d.id}
                  fileName={d.fileName}
                  buffer={buffer}
                  position={d.position}
                  selection={selection}
                  onSelectionChange={setSelection}
                  onSeek={(sec) => seek(d.id, sec)}
                  onPlayPause={() => (d.state === 'playing' ? pause(d.id) : play(d.id))}
                  isPlaying={d.state === 'playing'}
                  onBufferReplace={(newBuffer) => {
                    bufferRef.current.set(d.id, newBuffer);
                    stopPlayback(d.id);
                    patchDoc(d.id, { state: 'ready', duration: newBuffer.duration, position: 0 });
                    setSelection(null);
                  }}
                />
              )}
              {isPlayable && !editMode && (
                <>
                  <div style={{ fontSize: 48 }}>🎵</div>
                  <div style={{ fontWeight: 600, color: 'var(--win-text, #e6edf3)', maxWidth: 420, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.fileName}</div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(d.duration, 0.01)}
                    step={0.01}
                    value={Math.min(d.position, d.duration)}
                    onChange={(e) => seek(d.id, Number(e.target.value))}
                    style={{ width: 360 }}
                  />
                  <div style={{ fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)' }}>{fmtTime(d.position)} / {fmtTime(d.duration)}</div>
                  <div style={{ display: 'flex', gap: 12 }}>
                    {d.state === 'playing' ? (
                      <button onClick={() => pause(d.id)} style={playBtnStyle}>⏸ 일시정지</button>
                    ) : (
                      <button onClick={() => play(d.id)} style={playBtnStyle}>▶ 재생</button>
                    )}
                    <button onClick={() => seek(d.id, 0)} style={playBtnStyle}>⏮ 처음으로</button>
                  </div>
                </>
              )}
            </div>
          </div>
          );
        })}
      </div>
      {pendingPassword && (
        <MediaPasswordPrompt
          fileName={pendingPassword.fileName}
          error={pendingPassword.error}
          onSubmit={submitPassword}
          onCancel={() => {
            const id = pendingPassword.id;
            setPendingPassword(null);
            closeDoc(id);
          }}
        />
      )}
    </div>
  );
}

const playBtnStyle: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 8, border: '1px solid var(--win-border, #30363d)',
  background: 'var(--win-surface, #161b22)', color: 'var(--win-text, #e6edf3)', fontSize: 13, cursor: 'pointer',
};
