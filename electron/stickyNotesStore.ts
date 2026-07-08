// electron/stickyNotesStore.ts
// 포스트잇 — 화면 어디든 띄울 수 있는 독립 창들의 위치/내용 저장소. worklogStore.ts 와 동일 패턴.
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export type StickyNote = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  html: string; // contentEditable innerHTML — 텍스트 + <img> 모두 여기 포함
  createdAt: number;
  updatedAt: number;
};

export type StickyNotesData = {
  notes: StickyNote[];
};

function getStickyNotesPath(): string {
  try {
    return path.join(app.getPath('userData'), 'stickyNotes.json');
  } catch {
    return path.join(process.cwd(), 'stickyNotes.json');
  }
}

export function loadStickyNotes(): StickyNotesData {
  const filePath = getStickyNotesPath();
  if (!fs.existsSync(filePath)) return { notes: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { notes: Array.isArray(raw?.notes) ? raw.notes : [] };
  } catch {
    return { notes: [] };
  }
}

function persist(data: StickyNotesData) {
  const filePath = getStickyNotesPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export function addStickyNote(note: StickyNote) {
  const data = loadStickyNotes();
  data.notes.push(note);
  persist(data);
}

export function updateStickyNote(id: string, patch: Partial<StickyNote>) {
  const data = loadStickyNotes();
  const idx = data.notes.findIndex(n => n.id === id);
  if (idx === -1) return;
  data.notes[idx] = { ...data.notes[idx], ...patch, id, updatedAt: Date.now() };
  persist(data);
}

export function removeStickyNote(id: string) {
  const data = loadStickyNotes();
  data.notes = data.notes.filter(n => n.id !== id);
  persist(data);
}

export function getStickyNote(id: string): StickyNote | undefined {
  return loadStickyNotes().notes.find(n => n.id === id);
}
