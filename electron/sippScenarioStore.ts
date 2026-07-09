// electron/sippScenarioStore.ts
// SIPp 워크스페이스 — 사용자가 저장한 시나리오(블록 조립 또는 고급 XML) 목록 저장소.
// stickyNotesStore.ts 와 동일 패턴. 블록 데이터의 실제 타입(ScenarioBlock 등)은
// 렌더러 쪽(SippWorkspace.tsx)에만 있으므로, 여기서는 구조를 강제하지 않고
// JSON 그대로(any) 보관한다 — 메인 프로세스는 그냥 저장소일 뿐이다.
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export type SavedSippScenario = {
  id: string;
  name: string;
  mode: 'blocks' | 'xml';
  /** mode === 'blocks' 일 때: { blocks, fromDomain, toDomain, responseTimeRepartition, callLengthRepartition } */
  blocksData?: any;
  /** mode === 'xml' 일 때: 시나리오 XML 문자열 */
  rawXml?: string;
  /** "대상 / 속도" 카드에서 설정한 값들 (대상 호스트/포트, CPS, 고급 옵션 등) — 있으면 불러올 때 같이 복원 */
  targetSettings?: any;
  createdAt: number;
  updatedAt: number;
};

type SippScenarioData = { scenarios: SavedSippScenario[] };

function getStorePath(): string {
  try {
    return path.join(app.getPath('userData'), 'sippScenarios.json');
  } catch {
    return path.join(process.cwd(), 'sippScenarios.json');
  }
}

export function loadSippScenarios(): SavedSippScenario[] {
  const filePath = getStorePath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SippScenarioData;
    return Array.isArray(raw?.scenarios) ? raw.scenarios : [];
  } catch {
    return [];
  }
}

function persist(scenarios: SavedSippScenario[]) {
  const filePath = getStorePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ scenarios }, null, 2), 'utf8');
}

/** id 가 있으면 덮어쓰기, 없으면 새로 만든다. 저장된(갱신된) 항목을 반환. */
export function saveSippScenario(entry: {
  id?: string; name: string; mode: 'blocks' | 'xml'; blocksData?: any; rawXml?: string; targetSettings?: any;
}): SavedSippScenario {
  const scenarios = loadSippScenarios();
  const now = Date.now();
  if (entry.id) {
    const idx = scenarios.findIndex(s => s.id === entry.id);
    if (idx !== -1) {
      scenarios[idx] = { ...scenarios[idx], name: entry.name, mode: entry.mode, blocksData: entry.blocksData, rawXml: entry.rawXml, targetSettings: entry.targetSettings, updatedAt: now };
      persist(scenarios);
      return scenarios[idx];
    }
  }
  const created: SavedSippScenario = {
    id: `sipp-scn-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: entry.name, mode: entry.mode, blocksData: entry.blocksData, rawXml: entry.rawXml, targetSettings: entry.targetSettings,
    createdAt: now, updatedAt: now,
  };
  scenarios.push(created);
  persist(scenarios);
  return created;
}

export function deleteSippScenario(id: string) {
  const scenarios = loadSippScenarios().filter(s => s.id !== id);
  persist(scenarios);
}
