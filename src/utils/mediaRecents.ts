// src/utils/mediaRecents.ts
// 미디어 플레이어 최근 재생 목록 — electron 메인 프로세스의 userData/media-recents.json 에 저장되므로
// 앱을 껐다 켜도 유지된다. 최대 100개, 초과 시 방문 빈도가 가장 낮은 항목부터 제거
// (electron/mediaRecentsStore.ts 에서 실제 처리). src/utils/officeRecents.ts 와 동일한 패턴.
const api = () => (window as any).api || {};

export type MediaRecentDoc = {
  filePath: string;
  fileName: string;
  openedAt: number;
  openCount: number;
  durationSec?: number;
  lastPositionSec?: number;
  codec?: string;
};

export async function getMediaRecents(): Promise<MediaRecentDoc[]> {
  return (await api().mediaRecentsGet?.()) || [];
}

export async function addMediaRecent(doc: { filePath: string; fileName: string; durationSec?: number; codec?: string }): Promise<MediaRecentDoc[]> {
  return (await api().mediaRecentsAdd?.(doc)) || [];
}

export async function removeMediaRecent(filePath: string): Promise<MediaRecentDoc[]> {
  return (await api().mediaRecentsRemove?.(filePath)) || [];
}

export async function setMediaPosition(filePath: string, positionSec: number): Promise<void> {
  await api().mediaRecentsSetPosition?.(filePath, positionSec);
}
