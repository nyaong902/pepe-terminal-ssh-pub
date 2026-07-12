// electron/mediaRecentsStore.ts
// 미디어 플레이어 최근 재생 목록 — userData/media-recents.json 에 영속 저장.
// 오피스 워크스페이스의 officeRecentsStore.ts 와 동일한 패턴(최대 100개, 초과 시
// 방문 빈도가 가장 낮은 항목부터 제거)이되, 마지막 재생 위치(lastPositionSec)를 추가로 기록한다.
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export type MediaRecentDoc = {
  filePath: string;
  fileName: string;
  openedAt: number;
  openCount: number;
  durationSec?: number;
  lastPositionSec?: number;
  codec?: string;
};

const MAX_RECENTS = 100;

function storePath(): string {
  return path.join(app.getPath('userData'), 'media-recents.json');
}

function loadAll(): MediaRecentDoc[] {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf-8')) || [];
  } catch {
    return [];
  }
}

function saveAll(list: MediaRecentDoc[]) {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(list), 'utf-8');
  } catch { /* 저장 실패는 조용히 무시 — 다음 열기 때 다시 시도됨 */ }
}

export function getMediaRecents(): MediaRecentDoc[] {
  return loadAll();
}

export function addMediaRecent(doc: { filePath: string; fileName: string; durationSec?: number; codec?: string }): MediaRecentDoc[] {
  const list = loadAll();
  const idx = list.findIndex(d => d.filePath === doc.filePath);
  if (idx >= 0) {
    list[idx] = { ...list[idx], fileName: doc.fileName, openedAt: Date.now(), openCount: list[idx].openCount + 1, durationSec: doc.durationSec ?? list[idx].durationSec, codec: doc.codec ?? list[idx].codec };
  } else {
    list.push({ ...doc, openedAt: Date.now(), openCount: 1 });
  }
  let trimmed = list;
  if (trimmed.length > MAX_RECENTS) {
    trimmed = [...trimmed].sort((a, b) => a.openCount - b.openCount || a.openedAt - b.openedAt);
    trimmed = trimmed.slice(trimmed.length - MAX_RECENTS);
  }
  trimmed = [...trimmed].sort((a, b) => b.openedAt - a.openedAt);
  saveAll(trimmed);
  return trimmed;
}

export function removeMediaRecent(filePath: string): MediaRecentDoc[] {
  const list = loadAll().filter(d => d.filePath !== filePath);
  saveAll(list);
  return list;
}

export function updateMediaPosition(filePath: string, positionSec: number): MediaRecentDoc[] {
  const list = loadAll();
  const idx = list.findIndex(d => d.filePath === filePath);
  if (idx >= 0) list[idx] = { ...list[idx], lastPositionSec: positionSec };
  saveAll(list);
  return list;
}
