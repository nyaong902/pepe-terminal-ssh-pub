// src/components/MediaWorkspace.tsx
// 미디어 플레이어 워크스페이스 — 오피스 워크스페이스와 동일한 미니탭 구조.
// WAV/A-law/u-law/raw 는 메인 프로세스에서 16bit PCM 으로 디코딩한 뒤 Web Audio API 로 직접 재생(로컬 코드).
// EVS/AMR-WB/AMR-NB/OPUS 는 네이티브 GStreamer 사이드카가 WAV 로 디코딩한 뒤 같은 Web Audio 경로로 재생.
// #!ENC 헤더가 감지되면 평문 비밀번호를 입력받아 복호화한 뒤 임시 파일을 재생 파이프라인에 넘긴다.
import { useEffect, useRef, useState } from 'react';
import { TabListMenu } from './TabListMenu';
import { middleClickClose, useTabStripScroll } from '../utils/tabStrip';
import { OfficeBackBar } from './OfficeBackBar';
import { MediaEmptyState } from './MediaEmptyState';
import { MediaPasswordPrompt } from './MediaPasswordPrompt';
import { MediaPcapStreamPicker, type RtpStreamInfo, type RtpPayloadCodec, type EvsRtpFormat } from './MediaPcapStreamPicker';
import { type Selection } from './MediaWaveform';
import { MediaEditPanel } from './MediaEditPanel';
import { getMediaRecents, addMediaRecent, removeMediaRecent, setMediaPosition, type MediaRecentDoc } from '../utils/mediaRecents';
import { getMediaPlaylist, addMediaPlaylistItems, removeMediaPlaylistItem, reorderMediaPlaylist, type MediaPlaylistItem } from '../utils/mediaPlaylist';
import { audioBufferToWav } from '../utils/audioEdit';

const api = () => (window as any).api || {};

type MediaCodec = 'wav' | 'alaw' | 'ulaw' | 'amrnb' | 'amrwb' | 'evs' | 'opus' | 'raw' | 'video' | 'unknown';
const LOCAL_CODECS: MediaCodec[] = ['wav', 'alaw', 'ulaw', 'raw'];
const GSTREAMER_CODECS: MediaCodec[] = ['evs', 'amrnb', 'amrwb', 'opus'];
const CODEC_LABEL: Record<MediaCodec, string> = {
  wav: 'WAV', alaw: 'A-law', ulaw: 'u-law', raw: 'RAW PCM',
  amrnb: 'AMR-NB', amrwb: 'AMR-WB', evs: 'EVS', opus: 'OPUS', video: '영상', unknown: '알 수 없음',
};

type PlayState = 'idle' | 'loading' | 'need-password' | 'need-stream-pick' | 'ready' | 'playing' | 'paused' | 'error';

type OpenMedia = {
  id: string;
  filePath: string;
  fileName: string;
  codec: MediaCodec;
  state: PlayState;
  error?: string;
  duration: number;
  position: number;
  videoUrl?: string;
  volume: number;
};

let nextTabId = 0;

const tabStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: '6px 6px 0 0',
  background: active ? 'var(--win-surface, #161b22)' : 'transparent',
  border: '1px solid var(--win-border, #30363d)',
  color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer', maxWidth: 200, whiteSpace: 'nowrap', flex: '0 0 auto',
});

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

type MediaWorkspaceState = { files: { filePath: string; fileName: string }[]; activeFilePath: string | null };

export function MediaWorkspace(props: {
  instanceId: string;
  // 다른 창으로 분리될 때 "어떤 파일들이 열려 있었는지"만 보존해서 다시 열어준다 — 디코딩된
  // 오디오 버퍼/재생 위치/편집 선택 구간은 데이터가 크고 창 경계를 못 넘어가 다시 초기화된다.
  initialState?: MediaWorkspaceState;
  onStateChange?: (state: MediaWorkspaceState) => void;
}) {
  const { initialState, onStateChange } = props;
  const [docs, setDocs] = useState<OpenMedia[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recents, setRecents] = useState<MediaRecentDoc[]>([]);
  const [playlist, setPlaylist] = useState<MediaPlaylistItem[]>([]);
  // 재생리스트에서 연 문서인지, 그리고 그 안에서 몇 번째인지 — 재생 종료 시 다음 곡 자동재생용.
  const [playlistPlaybackIdx, setPlaylistPlaybackIdx] = useState<number | null>(null);
  const [pendingPassword, setPendingPassword] = useState<{ id: string; filePath: string; fileName: string; error?: string } | null>(null);
  const [pendingPcap, setPendingPcap] = useState<{ id: string; filePath: string; fileName: string; streams: RtpStreamInfo[]; error?: string } | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<Map<string, AudioBufferSourceNode>>(new Map());
  const gainRef = useRef<Map<string, GainNode>>(new Map());
  const bufferRef = useRef<Map<string, AudioBuffer>>(new Map());
  const startedAtRef = useRef<Map<string, { ctxTime: number; offset: number }>>(new Map());
  const rafRef = useRef<number | null>(null);
  const videoUrlRef = useRef<Map<string, string>>(new Map());
  const playlistRef = useRef<MediaPlaylistItem[]>([]);
  const playlistPlaybackIdxRef = useRef<number | null>(null);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    getMediaRecents().then(setRecents);
    getMediaPlaylist().then(setPlaylist);
  }, []);

  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  // 연속재생 진행 중 다음 곡을 열 때 최신 재생리스트/인덱스를 참조해야 하는데, onended 콜백은
  // 클로저 시점의 state 를 캡처해 stale 해질 수 있어 ref 로 항상 최신값을 유지한다.
  useEffect(() => { playlistRef.current = playlist; }, [playlist]);
  useEffect(() => { playlistPlaybackIdxRef.current = playlistPlaybackIdx; }, [playlistPlaybackIdx]);

  const ensureAudioCtx = (): AudioContext => {
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    return audioCtxRef.current;
  };

  // 미디어 워크스페이스 탭 자체가 닫힐 때(개별 문서 close 가 아니라 컴포넌트 언마운트) —
  // AudioContext 를 닫지 않으면 실시간 오디오 렌더링 스레드가 탭을 닫은 뒤에도 계속 남아있고,
  // 열려있던 문서들의 video Object URL 도 회수되지 않아 메모리가 누적된다.
  useEffect(() => {
    return () => {
      try { audioCtxRef.current?.close(); } catch {}
      audioCtxRef.current = null;
      for (const url of videoUrlRef.current.values()) { try { URL.revokeObjectURL(url); } catch {} }
      videoUrlRef.current.clear();
    };
  }, []);

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

  // mp4/webm/mov 등 — PCM 디코딩은 안 하지만, file:// URL 을 <video src> 에 바로 넣는 방식은
  // 이 앱 렌더러에서 로드가 안 됐다(검은 화면, 재생 자체가 안 됨 — webSecurity 때문으로 보임).
  // PDF/오피스 파일들과 같은 방식으로 파일을 통째로 읽어와 Blob URL 로 바꿔서 재생한다.
  const videoMime = (fileName: string): string => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (ext === 'webm') return 'video/webm';
    if (ext === 'ogv') return 'video/ogg';
    if (ext === 'mov') return 'video/quicktime';
    return 'video/mp4'; // mp4, m4v
  };
  const loadVideo = async (id: string, filePath: string, fileName: string) => {
    const result = await api().mediaReadVideo?.(filePath);
    if (!result || result.error) {
      patchDoc(id, { state: 'error', error: result?.error || '영상 파일을 열 수 없습니다.' });
      return;
    }
    const blob = new Blob([result.data as ArrayBuffer], { type: videoMime(fileName) });
    const url = URL.createObjectURL(blob);
    videoUrlRef.current.set(id, url);
    patchDoc(id, { state: 'ready', videoUrl: url });
  };

  const loadByCodec = async (id: string, filePath: string, codec: MediaCodec, fileName: string) => {
    if (codec === 'video') {
      await loadVideo(id, filePath, fileName);
    } else if (LOCAL_CODECS.includes(codec)) {
      await loadLocalCodec(id, filePath, codec);
    } else if (GSTREAMER_CODECS.includes(codec)) {
      await loadGstreamerCodec(id, filePath, codec);
    } else {
      patchDoc(id, { state: 'error', error: `지원하지 않는 코덱입니다: ${codec}` });
    }
  };

  const openPath = async (filePath: string, fileName: string, fromPlaylistIdx: number | null = null) => {
    const id = `media-${++nextTabId}`;
    setDocs(prev => [...prev, { id, filePath, fileName, codec: 'unknown', state: 'loading', duration: 0, position: 0, volume: 1 }]);
    setActiveId(id);
    setPlaylistPlaybackIdx(fromPlaylistIdx);

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
    await loadByCodec(id, filePath, probe.codec, fileName);
  };

  // 창 분리 등으로 initialState 가 넘어오면 열려 있던 파일들을 다시 연다(재디코딩 — 원래 재생
  // 위치/편집 상태는 못 살림). 마운트 시 1회만.
  useEffect(() => {
    if (!initialState?.files?.length) return;
    (async () => {
      for (const f of initialState.files) {
        await openPath(f.filePath, f.fileName);
      }
      if (initialState.activeFilePath) {
        setDocs(prev => {
          const match = prev.find(d => d.filePath === initialState.activeFilePath);
          if (match) setActiveId(match.id);
          return prev;
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!onStateChange) return;
    const active = docs.find(d => d.id === activeId);
    onStateChange({
      files: docs.map(d => ({ filePath: d.filePath, fileName: d.fileName })),
      activeFilePath: active?.filePath || null,
    });
  }, [docs, activeId]);

  const handleOpenFile = async () => {
    const result = await api().mediaOpenFile?.();
    if (!result || result.error) return;
    if (result.isPcap) {
      openPcapPath(result.filePath, result.fileName, result.streams as RtpStreamInfo[]);
      return;
    }
    await openPath(result.filePath, result.fileName);
  };

  const isPcapFile = (fileName: string): boolean => /\.(pcap|pcapng|cap)$/i.test(fileName);

  // pcap/pcapng — RTP 스트림을 찾아 목록으로 보여주고, 선택된 스트림만 추출해 재생.
  const openPcapPath = (filePath: string, fileName: string, streams: RtpStreamInfo[]) => {
    const id = `media-${++nextTabId}`;
    setDocs(prev => [...prev, { id, filePath, fileName, codec: 'unknown', state: 'need-stream-pick', duration: 0, position: 0, volume: 1 }]);
    setActiveId(id);
    setPendingPcap({ id, filePath, fileName, streams });
  };

  const handleOpenPcapRecent = async (filePath: string, fileName: string) => {
    const result = await api().pcapProbeFile?.(filePath);
    if (!result || result.error) return;
    const { streams } = result as { streams: RtpStreamInfo[] };
    openPcapPath(filePath, fileName, streams);
  };

  // 외부(Windows 탐색기 등)에서 파일을 창으로 드래그앤드롭 — electron/main.ts 의 will-navigate
  // 가로채기가 파일 경로를 이 전역 IPC 이벤트로 전달한다(여러 워크스페이스가 동시에 구독 가능).
  // 미디어 재생 가능한 확장자일 때만 반응하고, 그 외(문서/이미지 등)는 다른 워크스페이스(AI 채팅
  // 첨부 등)가 처리하도록 무시한다.
  // 파일마다 개별 IPC 이벤트로 도착하므로(배열 일괄 전달이 아님), 여러 파일을 한 번에 드롭하면
  // 이 콜백이 짧은 간격으로 여러 번 호출된다 — 그걸 곧바로 열어버리면(자동 재생) 한 번에 여러 개를
  // 끌어다 놓았을 때 마지막 파일만 재생되며 탭이 우르르 열리는 문제가 있었다. 그래서 짧은 시간
  // 창(150ms) 안에 도착한 파일들을 모아서, 1개뿐이면 기존처럼 열고, 2개 이상이면 전부 최근 문서에만
  // 등록하고 자동으로 열지 않는다(사용자가 목록에서 원하는 것만 선택해서 열도록).
  const MEDIA_DROP_EXT_RE = /\.(wav|alaw|pcma|al|ulaw|pcmu|mulaw|ul|amr|amrnb|amrwb|awb|evs|opus|raw|mp4|m4v|mov|webm|ogv|pcap|pcapng|cap)$/i;
  useEffect(() => {
    let batch: { fp: string; fileName: string }[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = async () => {
      const items = batch; batch = []; timer = null;
      if (items.length === 1) {
        const { fp, fileName } = items[0];
        if (isPcapFile(fileName)) handleOpenPcapRecent(fp, fileName);
        else openPath(fp, fileName);
        return;
      }
      // 여러 개 동시 드롭 — pcap 은 스트림 추출 전이라 코덱을 알 수 없으므로 최근 문서 등록에서 제외.
      for (const { fp, fileName } of items) {
        if (isPcapFile(fileName)) continue;
        const probe = await api().mediaProbeFile?.(fp).catch(() => null);
        if (!probe || probe.error) continue;
        addMediaRecent({ filePath: fp, fileName, codec: probe.codec }).then(setRecents);
      }
    };
    const off = api().onChatExternalFileDropped?.((payload: { path: string }) => {
      const fp = payload?.path;
      if (!fp || !MEDIA_DROP_EXT_RE.test(fp)) return;
      const fileName = fp.split(/[\\/]/).pop() || fp;
      batch.push({ fp, fileName });
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 150);
    });
    return () => { try { off?.(); } catch {} if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectPcapStream = async (streamId: string, forcedCodec: RtpPayloadCodec, evsFormat: EvsRtpFormat) => {
    if (!pendingPcap) return;
    const { id, filePath, fileName } = pendingPcap;
    const result = await api().pcapExtractStream?.(filePath, streamId, forcedCodec, evsFormat);
    if (!result || result.error) {
      setPendingPcap({ ...pendingPcap, error: result?.error || '스트림 추출 실패' });
      return;
    }
    const { tempPath, codec } = result as { tempPath: string; codec: MediaCodec };
    setPendingPcap(null);
    const streamLabel = pendingPcap.streams.find(s => s.id === streamId);
    const displayName = streamLabel ? `${fileName} — ${streamLabel.srcIp}:${streamLabel.srcPort}` : fileName;
    patchDoc(id, { codec, fileName: displayName, state: 'loading' });
    addMediaRecent({ filePath, fileName, codec }).then(setRecents);
    await loadByCodec(id, tempPath, codec, displayName);
  };

  const handleOpenRecent = async (doc: MediaRecentDoc) => {
    if (isPcapFile(doc.fileName)) {
      await handleOpenPcapRecent(doc.filePath, doc.fileName);
      return;
    }
    await openPath(doc.filePath, doc.fileName);
  };

  const handleRemoveRecent = async (filePath: string) => {
    const next = await removeMediaRecent(filePath);
    setRecents(next);
  };

  // ── 재생리스트 ──
  const handleAddToPlaylist = async (docsToAdd: { filePath: string; fileName: string; codec?: string }[]) => {
    if (docsToAdd.length === 0) return;
    const next = await addMediaPlaylistItems(docsToAdd);
    setPlaylist(next);
  };

  const handleRemovePlaylistItem = async (filePath: string) => {
    const next = await removeMediaPlaylistItem(filePath);
    setPlaylist(next);
  };

  const handleReorderPlaylist = async (orderedFilePaths: string[]) => {
    // 드래그 직후 즉시 반영해 UI 가 끊기지 않게 하고, 실제 영속 저장은 뒤따라 확정한다.
    setPlaylist(prev => {
      const byPath = new Map(prev.map(i => [i.filePath, i]));
      return orderedFilePaths.map(fp => byPath.get(fp)).filter((i): i is MediaPlaylistItem => !!i);
    });
    const next = await reorderMediaPlaylist(orderedFilePaths);
    setPlaylist(next);
  };

  const handleOpenPlaylistItem = async (item: MediaPlaylistItem) => {
    const idx = playlistRef.current.findIndex(i => i.filePath === item.filePath);
    await openPath(item.filePath, item.fileName, idx >= 0 ? idx : null);
  };

  // 재생리스트에서 연 곡이 끝까지 재생되면(사용자가 직접 멈춘 게 아니라 자연 종료) 다음 곡을
  // 이어서 자동 재생 — src.onended 콜백에서 이 함수를 호출한다. 탭이 계속 쌓이지 않도록
  // 방금 끝난 탭은 닫고 다음 곡을 새 탭으로 연다.
  const playNextInPlaylist = () => {
    const idx = playlistPlaybackIdxRef.current;
    if (idx === null) return;
    const list = playlistRef.current;
    const nextIdx = idx + 1;
    if (nextIdx >= list.length) { setPlaylistPlaybackIdx(null); return; }
    const finishedId = activeIdRef.current;
    const nextItem = list[nextIdx];
    if (finishedId) closeDoc(finishedId);
    openPath(nextItem.filePath, nextItem.fileName, nextIdx);
  };

  // pcap 에서 추출한 RTP 스트림은 원본이 raw 코덱 파일이라 다른 도구에서 못 여니, WAV 로
  // 저장할 수 있게 한다 — 이미 재생용으로 디코딩된 bufferRef 의 AudioBuffer 를 그대로 재사용.
  const handleSavePcapWav = async (id: string, fileName: string) => {
    const buffer = bufferRef.current.get(id);
    if (!buffer) return;
    const wav = audioBufferToWav(buffer);
    const defaultName = fileName.replace(/[\\/:*?"<>|]/g, '_') + '.wav';
    await api().officeDocSaveFile?.({
      data: wav,
      defaultName,
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    });
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
    await loadByCodec(id, tempPath, codec, fileName);
  };

  const stopPlayback = (id: string) => {
    const src = sourceRef.current.get(id);
    if (src) {
      try { src.onended = null; src.stop(); } catch { /* 이미 정지된 경우 무시 */ }
      sourceRef.current.delete(id);
    }
    gainRef.current.delete(id);
  };

  const play = (id: string) => {
    const buffer = bufferRef.current.get(id);
    const doc = docs.find(d => d.id === id);
    if (!buffer || !doc) return;
    const ctx = ensureAudioCtx();
    stopPlayback(id);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = doc.volume;
    src.connect(gain);
    gain.connect(ctx.destination);
    gainRef.current.set(id, gain);
    const offset = doc.position >= doc.duration ? 0 : doc.position;
    src.start(0, offset);
    startedAtRef.current.set(id, { ctxTime: ctx.currentTime, offset });
    src.onended = () => {
      sourceRef.current.delete(id);
      gainRef.current.delete(id);
      patchDoc(id, { state: 'ready', position: 0 });
      // 재생리스트로 열린 곡이 끝까지 재생되어 자연 종료된 경우에만 다음 곡으로 이어간다
      // (탭 자체가 여러 개일 수 있어, 지금 끝난 탭이 재생리스트 재생 중인 활성 탭일 때만).
      if (id === activeIdRef.current && playlistPlaybackIdxRef.current !== null) playNextInPlaylist();
    };
    sourceRef.current.set(id, src);
    patchDoc(id, { state: 'playing' });
  };

  const setVolume = (id: string, volume: number) => {
    patchDoc(id, { volume });
    const gain = gainRef.current.get(id);
    if (gain) gain.gain.value = volume;
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
    const videoUrl = videoUrlRef.current.get(id);
    if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrlRef.current.delete(id); }
    const doc = docs.find(d => d.id === id);
    if (doc && doc.position > 0) setMediaPosition(doc.filePath, doc.position);
    const idx = docs.findIndex(d => d.id === id);
    const next = docs.filter(d => d.id !== id);
    setDocs(next);
    if (activeId === id) setActiveId(next.length ? next[Math.min(idx, next.length - 1)].id : null);
  };

  // 탭 바 — 넘칠 때 ‹ › , 세로 휠로 가로 스크롤(공용 처리).
  const { tabScrollRef, tabsOverflow, scrollTabs, onTabWheel } = useTabStripScroll(docs);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
      {docs.length > 0 && (
        <div className="pepe-tabs pepe-tabs-docs">
          <div className="pepe-tabs-scroll" ref={tabScrollRef} onWheel={onTabWheel}>
            {docs.map(d => (
              <div key={d.id} onClick={() => setActiveId(d.id)} {...middleClickClose(() => closeDoc(d.id))} style={tabStyle(d.id === activeId)}>
                <span>{d.codec === 'video' ? '🎬' : '🎵'}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.fileName}</span>
                <span onClick={(e) => { e.stopPropagation(); closeDoc(d.id); }} style={{ opacity: 0.7, padding: '0 2px', borderRadius: 4 }}>×</span>
              </div>
            ))}
          </div>
          {tabsOverflow && (
            <div className="pepe-tab-scroll-group">
              <button className="pepe-tab-scroll-btn" onClick={() => scrollTabs(-150)} title="이전">‹</button>
              <button className="pepe-tab-scroll-btn" onClick={() => scrollTabs(150)} title="다음">›</button>
            </div>
          )}
          <button
            onClick={handleOpenFile}
            title="미디어 파일 열기 (pcap/pcapng 도 지원)"
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--win-border, #30363d)', background: 'transparent', color: 'var(--win-text, #e6edf3)', fontSize: 13, cursor: 'pointer' }}
          >＋</button>
          {/* 모든 탭 보기 — 탭이 많을 때 ‹ › 로 넘기지 않고 목록에서 바로 고른다. */}
          <TabListMenu
            items={docs.map(d => ({ id: d.id, label: d.fileName, icon: '🎬' }))}
            activeId={activeId}
            onSelect={id => setActiveId(id)}
            onCloseItem={id => closeDoc(id)}
          />
        </div>
      )}
      <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, position: 'relative' }}>
        {docs.length === 0 && (
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            <MediaEmptyState
              recents={recents}
              onOpenRecent={handleOpenRecent}
              onRemoveRecent={handleRemoveRecent}
              message="🎵🎬 미디어 플레이어 — 음원/영상 파일 및 PCAP(RTP 스트림)을 재생합니다. 왼쪽에서 최근 재생 항목을 선택하거나 아래 버튼으로 파일을 여세요."
              playlist={playlist}
              onOpenPlaylistItem={handleOpenPlaylistItem}
              onRemovePlaylistItem={handleRemovePlaylistItem}
              onReorderPlaylist={handleReorderPlaylist}
              onAddToPlaylist={handleAddToPlaylist}
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
              right={isPlayable && d.codec !== 'video' ? (
                <>
                  <span title={`음량 ${Math.round(d.volume * 100)}%`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>
                    🔈<input
                      type="range" min={0} max={2} step={0.05} value={d.volume}
                      onChange={(e) => setVolume(d.id, Number(e.target.value))}
                      style={{ width: 64 }}
                    />
                  </span>
                  <button
                    onClick={() => { setEditMode(v => !v); setSelection(null); }}
                    style={{ ...playBtnStyle, padding: '4px 10px', fontSize: 12 }}
                  >{editMode ? '재생 모드' : '✂️ 편집'}</button>
                </>
              ) : undefined}
            />
            <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'row' }}>
            <div style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}>
              {d.state === 'loading' && <div style={{ color: 'var(--win-text-dim, #9aa7b3)' }}>불러오는 중...</div>}
              {d.state === 'need-password' && <div style={{ color: 'var(--win-text-dim, #9aa7b3)' }}>🔒 비밀번호 입력 대기 중...</div>}
              {d.state === 'need-stream-pick' && <div style={{ color: 'var(--win-text-dim, #9aa7b3)' }}>📡 RTP 스트림 선택 대기 중...</div>}
              {d.state === 'error' && <div style={{ color: '#e5534b', textAlign: 'center', maxWidth: 420 }}>{d.error}</div>}
              {isPlayable && editMode && buffer && (
                <MediaEditPanel
                  docId={d.id}
                  fileName={d.fileName}
                  originalCodec={d.codec}
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
              {isPlayable && d.codec === 'video' && (
                <video
                  src={d.videoUrl}
                  controls
                  autoPlay={false}
                  style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', background: '#000', borderRadius: 6 }}
                />
              )}
              {isPlayable && d.codec !== 'video' && !editMode && (
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
                    {isPcapFile(d.filePath) && (
                      <button onClick={() => handleSavePcapWav(d.id, d.fileName)} style={playBtnStyle}>💾 WAV로 저장</button>
                    )}
                  </div>
                </>
              )}
            </div>
            {playlistPlaybackIdx !== null && d.id === activeId && (
              <div style={{ width: 220, flex: '0 0 auto', borderLeft: '1px solid var(--win-border, #30363d)', display: 'flex', flexDirection: 'column', padding: '10px 8px' }}>
                <div style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)', fontWeight: 600, marginBottom: 8, padding: '0 4px' }}>
                  🎶 재생 중 ({playlistPlaybackIdx + 1}/{playlist.length})
                </div>
                <div style={{ flex: '1 1 0', overflowY: 'auto' }}>
                  {playlist.map((item, idx) => (
                    <div
                      key={item.filePath}
                      onClick={() => handleOpenPlaylistItem(item)}
                      title={item.filePath}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px', borderRadius: 6,
                        cursor: 'pointer', fontSize: 11.5,
                        color: idx === playlistPlaybackIdx ? '#fff' : 'var(--win-text, #e6edf3)',
                        background: idx === playlistPlaybackIdx ? 'var(--win-accent, #2b6b9b)' : 'transparent',
                        fontWeight: idx === playlistPlaybackIdx ? 600 : 400,
                      }}
                      onMouseEnter={(e) => { if (idx !== playlistPlaybackIdx) e.currentTarget.style.background = 'var(--win-surface, #161b22)'; }}
                      onMouseLeave={(e) => { if (idx !== playlistPlaybackIdx) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{ opacity: 0.6, fontSize: 10, width: 14, textAlign: 'right' }}>{idx + 1}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.fileName}</span>
                    </div>
                  ))}
                </div>
              </div>
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
      {pendingPcap && (
        <MediaPcapStreamPicker
          fileName={pendingPcap.fileName}
          streams={pendingPcap.streams}
          error={pendingPcap.error}
          onSelect={selectPcapStream}
          onCancel={() => {
            const id = pendingPcap.id;
            setPendingPcap(null);
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
