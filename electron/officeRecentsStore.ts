// electron/officeRecentsStore.ts
// 오피스 워크스페이스 형식별(hwp/docx/xlsx/pptx/pdf) 최근 문서 목록 — userData/office-recents.json 에
// 영속 저장 (localStorage 대신 메인 프로세스 파일로 저장해 앱을 껐다 켜도 유지된다).
// 형식당 최대 100개, 초과 시 방문 빈도(openCount)가 가장 낮은 항목부터 제거.
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export type RecentDoc = { filePath: string; fileName: string; openedAt: number; openCount: number };

const MAX_RECENTS = 100;

function storePath(): string {
  return path.join(app.getPath('userData'), 'office-recents.json');
}

function loadAll(): Record<string, RecentDoc[]> {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf-8')) || {};
  } catch {
    return {};
  }
}

function saveAll(data: Record<string, RecentDoc[]>) {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(data), 'utf-8');
  } catch { /* 저장 실패는 조용히 무시 — 다음 열기 때 다시 시도됨 */ }
}

export function getRecents(kind: string): RecentDoc[] {
  return loadAll()[kind] || [];
}

export function addRecent(kind: string, doc: { filePath: string; fileName: string }): RecentDoc[] {
  const all = loadAll();
  const list = all[kind] || [];
  const idx = list.findIndex(d => d.filePath === doc.filePath);
  if (idx >= 0) {
    list[idx] = { ...list[idx], fileName: doc.fileName, openedAt: Date.now(), openCount: list[idx].openCount + 1 };
  } else {
    list.push({ ...doc, openedAt: Date.now(), openCount: 1 });
  }
  let trimmed = list;
  if (trimmed.length > MAX_RECENTS) {
    // 빈도(openCount) 오름차순으로 정렬해 가장 덜 쓴 항목부터 잘라내고, 다시 최근 연 순으로 정렬.
    trimmed = [...trimmed].sort((a, b) => a.openCount - b.openCount || a.openedAt - b.openedAt);
    trimmed = trimmed.slice(trimmed.length - MAX_RECENTS);
  }
  trimmed = [...trimmed].sort((a, b) => b.openedAt - a.openedAt);
  all[kind] = trimmed;
  saveAll(all);
  return trimmed;
}

export function removeRecent(kind: string, filePath: string): RecentDoc[] {
  const all = loadAll();
  const list = (all[kind] || []).filter(d => d.filePath !== filePath);
  all[kind] = list;
  saveAll(all);
  return list;
}
