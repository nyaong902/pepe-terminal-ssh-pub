// electron/sessionsStore.ts
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export type LoginScriptRule = {
  expect: string;
  send: string;
  isRegex?: boolean;
};

// 다단계 점프 체인의 한 홉. host 만 필수, 나머지는 생략 시 기본값/직전 홉 인증 재사용.
export type JumpHop = {
  host: string;
  user?: string;     // 생략 시 'root'
  port?: number;     // 생략 시 22
  password?: string; // 있으면 비밀번호 인증, 비어 있으면 직전 홉의 ~/.ssh/ 키 자동 사용
};

export type Session = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth?: { type: 'password'; password: string } | { type: 'key'; keyPath: string };
  encoding?: string;
  folderId?: string;
  loginScript?: LoginScriptRule[];
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
  icon?: string;
  initialPath?: string; // SSH 연결 시 파일 트리 초기 경로 (없으면 홈 디렉토리)
  fileTreeEnabled?: boolean; // 세션 연결 즉시 파일트리(SFTP) 자동 연결. false 면 사용자가 버튼으로 명시 연결할 때까지 SFTP 안 열림.
  autoTrackPwd?: boolean; // 터미널에서 cd 하면 파일 트리 경로 자동 갱신 (파일트리가 연결되어 있을 때만 의미 있음)
  // 터미널 키 시퀀스 (stty-like) — 세션별 설정. 미설정이면 xterm 기본.
  backspaceKeyMode?: 'vt220' | 'ascii127' | 'backspace'; // VT220 Del(Esc[3~) / ASCII 127(0x7F) / Backspace(0x08)
  deleteKeyMode?: 'vt220' | 'ascii127' | 'backspace';
  logPath?: string;  // LogAnalyzer 가 이 세션 선택 시 자동으로 채울 로그 파일 경로
  codePath?: string; // CompareWorkspace 가 이 세션 선택 시 자동으로 채울 base 디렉토리
  x11Forward?: boolean; // X11 forwarding 활성화 (원격 GUI 앱 → 로컬 X 서버)
  x11Display?: number;  // 로컬 X 서버 display 번호 (기본 0 → localhost:6000)
  browserUrl?: string;   // Browser workspace 가 세션 선택 시 자동으로 열 URL
  // 다단계 점프 (ProxyJump 체인). primary → jumps[0] → jumps[1] → ... → 최종 호스트.
  // 비어 있으면 primary 직접 연결. 각 홉의 password 가 비어 있으면 직전 홉의 ~/.ssh/ 키를 자동 재사용.
  // (이전 단일/2단 필드 jumpTargetHost·jump2TargetHost 는 이 배열로 대체됨.)
  jumps?: JumpHop[];
  // 연결 유지 — XShell 의 "연결 유지" 탭과 같은 세 가지. 미설정이면 아래 기본값.
  //
  // 왜 세션별로 두는가: 2시간쯤 붙여두면 read ECONNRESET 으로 끊기는 서버가 있는데, 같은 서버에
  // XShell 로 붙어두면 끊기지 않았다. 확인된 차이는 keepalive 간격뿐이었다(XShell 60초, 예전 PePe
  // 10초). 서버·방화벽마다 사정이 달라 하나의 값으로 맞출 수 없으므로 세션마다 조절하게 한다.
  //
  // 세 가지가 각각 다른 계층이라는 점이 중요하다:
  //  - keepAliveEnabled: SSH 프로토콜 수준(global request). TCP·SSH 연결은 살리지만 원격 셸은
  //    "입력이 없다"고 보므로 서버의 TMOUT(셸 자동 로그아웃)은 막지 못한다.
  //  - keepAliveSendString: 원격 셸에 실제 입력을 보낸다. TMOUT 을 리셋할 수 있는 유일한 방법.
  //    화면에 흔적이 남지 않게 기본 문자열은 NUL(\0) 을 쓴다. 서버 정책을 우회하는 동작이라 기본 꺼짐.
  //  - keepAliveTcp: TCP 수준 keepalive 패킷. 중간 장비가 SSH 트래픽을 안 보고 TCP 만 볼 때 쓴다.
  keepAliveEnabled?: boolean;      // 기본 true
  keepAliveIntervalSec?: number;   // 기본 60 (XShell 기본값과 동일)
  keepAliveSendString?: boolean;   // 기본 false
  keepAliveStringIntervalSec?: number; // 기본 0(= 사용 안 함)
  keepAliveString?: string;        // 기본 '' → NUL 문자를 보냄
  keepAliveTcp?: boolean;          // 기본 false

  // 스크롤 동작 — XShell 의 터미널 > 고급 옵션과 같다.
  //  - scrollOnOutput: 출력이 올 때마다 맨 아래로 내린다. 기본 꺼짐(= xterm 기본 동작으로,
  //    스크롤을 올려두면 새 출력이 와도 그 자리에 머문다). 예전에 이 동작이 의도치 않게
  //    항상 켜져 있어서 지난 내용을 보려고 올려도 계속 끌려 내려갔다 — 그래서 옵션으로 분리했다.
  //  - scrollOnOutputPauseOnScrollLock: 위 동작을 ScrollLock 이 켜진 동안만 잠시 멈춘다.
  //    로그가 흐르는 중에 잠깐 멈춰 읽을 때 쓴다.
  //  - scrollOnKeyPress: 키를 누르면 맨 아래로 내린다. xterm 의 scrollOnUserInput 이라 기본 켜짐.
  scrollOnOutput?: boolean;                    // 기본 false
  scrollOnOutputPauseOnScrollLock?: boolean;   // 기본 false
  scrollOnKeyPress?: boolean;                  // 기본 true
  //  - altScrollShowsScrollback: vi/less/top 처럼 대체 화면을 쓰는 프로그램 안에서 위로 스크롤할 때,
  //    그 프로그램에 스크롤을 전달하는 대신 "프로그램을 실행하기 전의 화면"(일반 버퍼의 스크롤백)을
  //    겹쳐서 보여준다. XShell 이 그렇게 동작해서 같은 선택지를 둔다. 기본 꺼짐.
  altScrollShowsScrollback?: boolean;          // 기본 false
  // dbms 필드는 더 이상 여기 없음 — SQL Tool DB 연결 프로필은 sqlSessionsStore.ts(sql-sessions.json)
  // 로 완전히 독립됐다. 과거 데이터 마이그레이션(sqlSessionsStore.migrateFromSshSessions)에서만
  // (s as any).dbms 로 과거 값을 읽어 옮기고 지운다.
};

export type Folder = {
  id: string;
  name: string;
  parentId?: string;
};

export type SessionsData = {
  folders: Folder[];
  sessions: Session[];
  childOrder?: Record<string, string[]>; // parentId → 자식 ID 목록 (폴더+세션 혼합 순서)
  keySeqDefaultsV1?: boolean; // 키시퀀스 기본값(Delete=vt220, Backspace=backspace) 일괄 적용 완료 표식
};

let customSessionsPath: string | null = null;

function getConfigPath(): string {
  try { return path.join(app.getPath('userData'), 'config.json'); }
  catch { return path.join(process.cwd(), 'config.json'); }
}

export function loadCustomPath(): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
    return cfg.sessionsPath || null;
  } catch { return null; }
}

export function saveCustomPath(p: string | null) {
  customSessionsPath = p;
  const cfgPath = getConfigPath();
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  cfg.sessionsPath = p || undefined;
  const dir = path.dirname(cfgPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

export function loadUIPrefs(): Record<string, any> {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
    return (cfg && typeof cfg.uiPrefs === 'object' && cfg.uiPrefs) ? cfg.uiPrefs : {};
  } catch { return {}; }
}

// ── AI 채팅 기록 저장소 ──────────────────────────────────────────────────────────
// 예전에는 config.json 의 uiPrefs.claudeChatHistory 에 넣었는데, 그 파일이 3.4MB 까지 커졌고
// (대화 47개 = 2.46MB) saveUIPrefs 는 파일 전체를 동기로 읽고-파싱하고-쓰기 때문에 UI 설정을
// 하나 바꿀 때마다 약 14MB 를 주 스레드에서 처리했다. 호출 지점이 41곳이라 사이드바 토글,
// 패널 고정, 워크스페이스 전환마다 그 비용이 들었고, AI 스트리밍 중에는 1.5s 마다 반복됐다.
// 주 스레드가 막히면 SSH 데이터 처리까지 멈춘다.
// 그래서 채팅 기록만 별도 파일로 분리한다 — config.json 은 약 90KB 로 줄어든다.
function getChatHistoryPath(): string {
  try { return path.join(app.getPath('userData'), 'chatHistory.json'); }
  catch { return path.join(process.cwd(), 'chatHistory.json'); }
}

function readJsonSafe(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// 임시 파일에 쓰고 rename — 쓰는 도중 죽어도 원본이 깨지지 않는다(2.5MB 를 다루므로 특히 중요).
function writeJsonAtomic(file: string, data: any, indent?: number): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, indent), 'utf8');
  fs.renameSync(tmp, file);
}

const CHAT_HISTORY_KEY = 'claudeChatHistory';

// 채팅 기록을 읽는다. config.json 에 남아 있는 레거시 기록이 있으면 새 파일로 이관한다.
// 다른 PC 에서 업데이트할 때 기록이 사라지지 않는 것이 이 함수의 핵심 요구사항이라, 어느 쪽도
// 버리지 않고 id 기준으로 합친다(같은 id 면 updatedAt 이 큰 쪽). 새 파일에 쓰고 다시 읽어
// 개수까지 확인한 뒤에만 config 에서 제거하므로, 중간에 실패하면 레거시가 그대로 남아 다음
// 실행에서 재시도된다.
// 이관만 수행한다(읽기와 분리). 앱 시작 시 한 번 부르기 위한 것 — 예전에는 loadChatHistory 안에만
// 있어서 AI 패널을 열지 않으면 이관이 안 되고 config.json 이 계속 3.4MB 로 남았다.
// 레거시 기록이 없으면 config 만 읽고 즉시 반환하므로(채팅 파일은 건드리지 않는다) 상시 호출해도 싸다.
export function migrateChatHistoryIfNeeded(): void {
  const cfgPath = getConfigPath();
  const cfg = readJsonSafe(cfgPath);
  const legacy: any[] = Array.isArray(cfg?.uiPrefs?.[CHAT_HISTORY_KEY]) ? cfg.uiPrefs[CHAT_HISTORY_KEY] : [];
  if (legacy.length === 0) return;

  const fromFile = readJsonSafe(getChatHistoryPath());
  const current: any[] = Array.isArray(fromFile) ? fromFile : [];

  const byId = new Map<string, any>();
  for (const e of current) if (e && e.id) byId.set(e.id, e);
  for (const e of legacy) {
    if (!e || !e.id) continue;
    const cur = byId.get(e.id);
    if (!cur || (Number(e.updatedAt) || 0) > (Number(cur.updatedAt) || 0)) byId.set(e.id, e);
  }
  const merged = Array.from(byId.values());

  try {
    writeJsonAtomic(getChatHistoryPath(), merged);
    const verify = readJsonSafe(getChatHistoryPath());
    if (Array.isArray(verify) && verify.length === merged.length) {
      delete cfg.uiPrefs[CHAT_HISTORY_KEY];
      writeJsonAtomic(cfgPath, cfg, 2);
      console.log(`[chat-history] config.json 에서 ${legacy.length}개 이관 완료 -> chatHistory.json (총 ${merged.length}개)`);
    } else {
      console.error('[chat-history] 이관 검증 실패 — config.json 의 레거시 기록을 그대로 둔다');
    }
  } catch (e) {
    console.error('[chat-history] 이관 실패 — config.json 의 레거시 기록을 그대로 둔다:', e);
  }
}

export function loadChatHistory(): any[] {
  migrateChatHistoryIfNeeded();
  const fromFile = readJsonSafe(getChatHistoryPath());
  return Array.isArray(fromFile) ? fromFile : [];
}

export function saveChatHistory(entries: any[]): void {
  writeJsonAtomic(getChatHistoryPath(), Array.isArray(entries) ? entries : []);
}

export function saveUIPrefs(prefs: Record<string, any>) {
  // 채팅 기록은 별도 파일로 돌린다 — 예전 호출 경로가 남아 있어도 config.json 이 다시 커지지 않는다.
  if (prefs && Object.prototype.hasOwnProperty.call(prefs, CHAT_HISTORY_KEY)) {
    const { [CHAT_HISTORY_KEY]: history, ...rest } = prefs;
    try { saveChatHistory(history as any[]); } catch {}
    if (Object.keys(rest).length === 0) return;
    prefs = rest;
  }
  const cfgPath = getConfigPath();
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  cfg.uiPrefs = { ...(cfg.uiPrefs || {}), ...prefs };
  const dir = path.dirname(cfgPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

export function getSessionsPath(): string {
  if (customSessionsPath) return customSessionsPath;
  const loaded = loadCustomPath();
  if (loaded) { customSessionsPath = loaded; return loaded; }
  try {
    return path.join(app.getPath('userData'), 'sessions.json');
  } catch {
    return path.join(process.cwd(), 'sessions.json');
  }
}

// fileTreeEnabled/autoTrackPwd 옵션 분리 이전에 만든 세션 마이그레이션.
// 과거엔 autoTrackPwd 만으로 파일트리 자동연결+추적이 동작했으므로,
// autoTrackPwd=true 이고 fileTreeEnabled 가 미설정(undefined)이면 fileTreeEnabled 도 true 로 본다.
// (안 하면 신규 게이트 `autoTrackPwd && fileTreeEnabled` 에서 추적이 꺼져 /vobs 등 cwd 추적이 안 됨)
function migrateSessions(sessions: Session[]): Session[] {
  // 신규 UI 는 fileTreeEnabled 가 꺼지면 autoTrackPwd 체크박스를 비활성화하므로
  // {autoTrackPwd:true, fileTreeEnabled:false/undefined} 조합은 과거 데이터(또는 전환기)에서만 발생.
  // autoTrack 이 켜져 있으면 파일트리도 켜진 것으로 정규화한다.
  for (const s of sessions) {
    if (s && s.autoTrackPwd === true && s.fileTreeEnabled !== true) {
      s.fileTreeEnabled = true;
    }
  }
  return sessions;
}

// 키시퀀스 기본값 일괄 적용(1회) — 기존에 저장된 세션도 Delete=VT220, Backspace=Backspace(^H) 로 정규화.
// 전역 플래그(keySeqDefaultsV1)로 단 한 번만 강제하므로, 이후 사용자가 개별 변경하면 그대로 유지된다.
function applyKeySeqDefaultsOnce(data: SessionsData): SessionsData {
  if (data.keySeqDefaultsV1) return data;
  for (const s of data.sessions) {
    if (!s) continue;
    s.deleteKeyMode = 'vt220';
    s.backspaceKeyMode = 'backspace';
  }
  data.keySeqDefaultsV1 = true;
  try { saveSessionsData(data); } catch {}
  return data;
}

export function loadSessionsData(): SessionsData {
  const filePath = getSessionsPath();
  if (!fs.existsSync(filePath)) return { folders: [], sessions: [], keySeqDefaultsV1: true };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // 기존 flat array 마이그레이션
    if (Array.isArray(raw)) return applyKeySeqDefaultsOnce({ folders: [], sessions: migrateSessions(raw) });
    return applyKeySeqDefaultsOnce({ folders: raw.folders ?? [], sessions: migrateSessions(raw.sessions ?? []), childOrder: raw.childOrder ?? undefined, keySeqDefaultsV1: raw.keySeqDefaultsV1 === true });
  } catch {
    return { folders: [], sessions: [], keySeqDefaultsV1: true };
  }
}

export function saveSessionsData(data: SessionsData) {
  const filePath = getSessionsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}
