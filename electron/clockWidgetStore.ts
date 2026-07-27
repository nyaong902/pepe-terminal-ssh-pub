// electron/clockWidgetStore.ts
// 스위스 철도 시계 + 뽀모도로 타이머 위젯 — 단일 인스턴스 독립 창의 위치/타이머 상태 저장소.
// stickyNotesStore.ts 와 동일 패턴이나, 위젯은 하나뿐이라 배열이 아니라 단일 객체.
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export type ClockWidgetState = {
  x: number | null;
  y: number | null;
  visible: boolean;
  // 타이머가 진행 중이면 종료 시각(ms epoch), 아니면 null.
  endTime: number | null;
  // 타이머가 설정한 총 시간(ms) — endTime 과 함께 남은 비율을 계산하는 데 사용.
  totalMs: number | null;
};

const DEFAULT_STATE: ClockWidgetState = {
  x: null,
  y: null,
  visible: false,
  endTime: null,
  totalMs: null,
};

function getClockWidgetPath(): string {
  try {
    return path.join(app.getPath('userData'), 'clockWidget.json');
  } catch {
    return path.join(process.cwd(), 'clockWidget.json');
  }
}

export function loadClockWidgetState(): ClockWidgetState {
  const filePath = getClockWidgetPath();
  if (!fs.existsSync(filePath)) return { ...DEFAULT_STATE };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveClockWidgetState(patch: Partial<ClockWidgetState>) {
  const current = loadClockWidgetState();
  const next = { ...current, ...patch };
  const filePath = getClockWidgetPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
