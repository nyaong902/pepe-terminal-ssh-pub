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
  // 알람 — 지정 시각(epoch ms)에 도달하면 화면 중앙 팝업 + 소리로 알린다.
  remindAt?: number;
  // 이미 알림을 울렸는지 — 앱을 여러 번 껐다 켜도 같은 알람이 중복으로 울리지 않게 방지.
  remindNotified?: boolean;
  // 알람 울릴 때 소리도 낼지 — 기본 true(미지정 시 소리 남).
  remindSound?: boolean;
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
