// electron/mediaPlaylistStore.ts
// 미디어 플레이어 재생리스트 — userData/media-playlist.json 에 영속 저장.
// mediaRecentsStore.ts(최근 재생, 빈도/시각 기반 자동 정렬)와 달리, 이 목록은 사용자가
// 명시적으로 추가하고 드래그로 순서를 바꾸는 것이라 배열 순서 자체가 곧 재생 순서다.
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export type MediaPlaylistItem = {
  filePath: string;
  fileName: string;
  codec?: string;
  addedAt: number;
};

function storePath(): string {
  return path.join(app.getPath('userData'), 'media-playlist.json');
}

function loadAll(): MediaPlaylistItem[] {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf-8')) || [];
  } catch {
    return [];
  }
}

function saveAll(list: MediaPlaylistItem[]) {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(list), 'utf-8');
  } catch { /* 저장 실패는 조용히 무시 */ }
}

export function getMediaPlaylist(): MediaPlaylistItem[] {
  return loadAll();
}

/** 이미 목록에 있는 항목은 건너뛰고, 나머지만 끝에 이어붙인다 (다중 선택 추가 지원). */
export function addMediaPlaylistItems(items: { filePath: string; fileName: string; codec?: string }[]): MediaPlaylistItem[] {
  const list = loadAll();
  const existing = new Set(list.map(i => i.filePath));
  const now = Date.now();
  for (const item of items) {
    if (existing.has(item.filePath)) continue;
    existing.add(item.filePath);
    list.push({ ...item, addedAt: now });
  }
  saveAll(list);
  return list;
}

export function removeMediaPlaylistItem(filePath: string): MediaPlaylistItem[] {
  const list = loadAll().filter(i => i.filePath !== filePath);
  saveAll(list);
  return list;
}

/** 드래그앤드롭 재정렬 — 렌더러가 계산한 전체 순서(파일 경로 배열)를 그대로 반영한다. */
export function reorderMediaPlaylist(orderedFilePaths: string[]): MediaPlaylistItem[] {
  const list = loadAll();
  const byPath = new Map(list.map(i => [i.filePath, i]));
  const reordered: MediaPlaylistItem[] = [];
  for (const fp of orderedFilePaths) {
    const item = byPath.get(fp);
    if (item) { reordered.push(item); byPath.delete(fp); }
  }
  // 혹시 orderedFilePaths 에 빠진 기존 항목이 있으면(경합 등) 끝에 보존 — 데이터 유실 방지.
  for (const remaining of byPath.values()) reordered.push(remaining);
  saveAll(reordered);
  return reordered;
}
