// src/utils/officeRecents.ts
// 오피스 워크스페이스 형식별(hwp/docx/xlsx/pptx/pdf) 최근 문서 목록 — electron 메인 프로세스의
// userData/office-recents.json 에 저장되므로 앱을 껐다 켜도 유지된다. 형식당 최대 100개,
// 초과 시 방문 빈도가 가장 낮은 항목부터 제거 (electron/officeRecentsStore.ts 에서 실제 처리).
const api = () => (window as any).api || {};

export type RecentDoc = { filePath: string; fileName: string; openedAt: number; openCount: number };

export async function getRecents(kind: string): Promise<RecentDoc[]> {
  return (await api().officeRecentsGet?.(kind)) || [];
}

export async function addRecent(kind: string, doc: { filePath: string; fileName: string }): Promise<RecentDoc[]> {
  return (await api().officeRecentsAdd?.(kind, doc)) || [];
}

export async function removeRecent(kind: string, filePath: string): Promise<RecentDoc[]> {
  return (await api().officeRecentsRemove?.(kind, filePath)) || [];
}
