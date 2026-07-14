// src/utils/mediaPlaylist.ts
// 미디어 플레이어 재생리스트 — electron 메인 프로세스의 userData/media-playlist.json 에 저장.
// mediaRecents.ts(최근 재생, 자동 정렬)와 달리 사용자가 명시적으로 추가/순서변경하며,
// 배열 순서 자체가 연속재생 순서다. src/utils/mediaRecents.ts 와 동일한 얇은 IPC 래퍼 패턴.
const api = () => (window as any).api || {};

export type MediaPlaylistItem = {
  filePath: string;
  fileName: string;
  codec?: string;
  addedAt: number;
};

export async function getMediaPlaylist(): Promise<MediaPlaylistItem[]> {
  return (await api().mediaPlaylistGet?.()) || [];
}

export async function addMediaPlaylistItems(items: { filePath: string; fileName: string; codec?: string }[]): Promise<MediaPlaylistItem[]> {
  return (await api().mediaPlaylistAdd?.(items)) || [];
}

export async function removeMediaPlaylistItem(filePath: string): Promise<MediaPlaylistItem[]> {
  return (await api().mediaPlaylistRemove?.(filePath)) || [];
}

export async function reorderMediaPlaylist(orderedFilePaths: string[]): Promise<MediaPlaylistItem[]> {
  return (await api().mediaPlaylistReorder?.(orderedFilePaths)) || [];
}
