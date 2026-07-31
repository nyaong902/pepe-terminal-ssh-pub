// electron/sqlSessionsStore.ts
// SQL Tool 전용 DB 연결 프로필 저장소 — 이전엔 SSH Session.dbms 필드에 얹혀있었지만, SQL Tool
// 워크스페이스가 자체적으로 연결을 관리하도록 독립시켰다. SSH 세션이 없어도(원격 서버가 직접
// 노출된 DB 포트를 갖고 있거나, SSH 터널을 직접 지정하는 경우) DB 연결을 등록할 수 있다.
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { loadSessionsData, saveSessionsData } from './sessionsStore';

export type SqlSessionAuth = { type: 'password'; password: string } | { type: 'key'; keyPath: string };

export type SqlFolder = { id: string; name: string; parentId?: string };

export type SqlSession = {
  id: string;
  name: string;
  folderId?: string;
  dbms: {
    type: 'altibase' | 'mysql' | 'postgres' | 'oracle' | 'mssql' | 'sqlite';
    driverId?: string;
    database?: string;
    useSshTunnel?: boolean;
    urlOverride?: string;
    props?: Record<string, string>;
    port: number;
    user: string;
    password: string;
    host?: string; // useSshTunnel=true 면 "SSH 서버 자신에게서 본" DB 주소(보통 127.0.0.1), 아니면 실제 접근 가능한 DB 호스트
  };
  // dbms.useSshTunnel 일 때만 사용 — SSH 터미널 세션에 얹혀가지 않고 독립적으로 자기 SSH 접속 정보를 가진다.
  sshTunnel?: {
    host: string;
    port: number;
    username: string;
    auth?: SqlSessionAuth;
  };
};

export type SqlSessionsData = {
  sessions: SqlSession[];
  folders: SqlFolder[];
  childOrder?: Record<string, string[]>; // parentId('__root__' 포함) → 자식 ID 목록 (폴더+세션 혼합 순서)
  migratedFromSessions?: boolean;
};

export function getSqlSessionsPath(): string {
  try { return path.join(app.getPath('userData'), 'sql-sessions.json'); }
  catch { return path.join(process.cwd(), 'sql-sessions.json'); }
}

export function loadSqlSessionsData(): SqlSessionsData {
  const filePath = getSqlSessionsPath();
  if (!fs.existsSync(filePath)) return migrateFromSshSessions();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(raw)) return { sessions: raw, folders: [], migratedFromSessions: true };
    return { sessions: raw.sessions || [], folders: raw.folders || [], childOrder: raw.childOrder || undefined, migratedFromSessions: !!raw.migratedFromSessions };
  } catch {
    return { sessions: [], folders: [] };
  }
}

export function saveSqlSessionsData(data: SqlSessionsData) {
  const filePath = getSqlSessionsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// 최초 1회 — 기존 SSH Session.dbms 로 등록돼 있던 DB 연결들을 독립 SqlSession 으로 복사하고,
// SSH 세션 쪽 dbms 필드는 지운다(더 이상 세션편집에서 dbms 를 다루지 않으므로 남겨두면 죽은 데이터).
// useSshTunnel 이던 항목은 그 SSH 세션 자신의 host/port/username/auth 를 sshTunnel 로 그대로 옮겨
// 터널이 계속 동작하게 한다.
function migrateFromSshSessions(): SqlSessionsData {
  try {
    const sessionsData = loadSessionsData();
    const migrated: SqlSession[] = [];
    let changed = false;
    for (const s of sessionsData.sessions) {
      const legacyDbms = (s as any).dbms;
      if (!legacyDbms) continue;
      const sql: SqlSession = {
        id: s.id,
        name: s.name,
        dbms: { ...legacyDbms },
      };
      if (legacyDbms.useSshTunnel) {
        sql.sshTunnel = { host: s.host, port: s.port || 22, username: s.username, auth: s.auth as any };
      }
      migrated.push(sql);
      delete (s as any).dbms;
      changed = true;
    }
    if (changed) {
      try { saveSessionsData(sessionsData); } catch {}
    }
    const data: SqlSessionsData = { sessions: migrated, folders: [], migratedFromSessions: true };
    saveSqlSessionsData(data);
    return data;
  } catch {
    const empty: SqlSessionsData = { sessions: [], folders: [], migratedFromSessions: true };
    try { saveSqlSessionsData(empty); } catch {}
    return empty;
  }
}
