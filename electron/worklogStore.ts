// electron/worklogStore.ts
// 작업일지 — 앱 전체에서 공유되는 일별 todo 저장소. sessionsStore.ts 와 동일한 패턴.
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export type WorklogTodo = {
  id: string;
  text: string;
  done: boolean;
  memo?: string;
  createdAt: number;
  doneAt?: number;
  sharedFromPeerId?: string;
  sharedFromPeerName?: string;
  sharedFromDate?: string;
  sharedFromMessageId?: string;
};

export type WorklogDay = {
  todos: WorklogTodo[];
  dayType?: 'vacation' | 'trip'; // 달력 월별 보기에서 우클릭으로 지정 — 휴가/출장 표시용
};

export type WorklogData = {
  days: Record<string, WorklogDay>; // key: 'YYYY-MM-DD'
};

function getWorklogPath(): string {
  try {
    return path.join(app.getPath('userData'), 'worklog.json');
  } catch {
    return path.join(process.cwd(), 'worklog.json');
  }
}

export function loadWorklog(): WorklogData {
  const filePath = getWorklogPath();
  if (!fs.existsSync(filePath)) return { days: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { days: (raw && typeof raw.days === 'object' && raw.days) ? raw.days : {} };
  } catch {
    return { days: {} };
  }
}

export function saveWorklogDay(date: string, day: WorklogDay) {
  const filePath = getWorklogPath();
  const data = loadWorklog();
  // todos 가 비어도 dayType(휴가/출장 표시)이 있으면 레코드를 지우면 안 됨 — 둘 다 없을 때만 정리.
  if (day.todos.length === 0 && !day.dayType) {
    delete data.days[date];
  } else {
    data.days[date] = day;
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}
