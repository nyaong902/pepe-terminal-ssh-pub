// src/utils/chatArchiveRoomNames.ts
// 대화 아카이브의 roomId(NAVER WORKS data-key, 숫자 문자열) -> 방 이름 매핑.
// 저장/검색 등 내부 로직은 전부 roomId 그대로 다룬다 — 이 매핑은 오직 화면(UI) 표시 시점에만
// roomId 를 사람이 읽을 수 있는 방 이름으로 바꿔주는 용도. 로컬 스토리지에 평문으로 저장(방 이름은
// 대화 내용 자체가 아니라 이미 사이드바에 노출되는 정보라 암호화 저장소까지 쓸 필요는 없음).
const STORAGE_KEY = 'chatArchiveSearch.roomNames';

function loadMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function saveMap(map: Record<string, string>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch {}
}

export function getRoomNameMap(): Record<string, string> {
  return loadMap();
}

// 방 이름이 확인될 때마다(백필 진행 중, 방을 열 때 등) 호출해 매핑을 누적 갱신한다.
export function setRoomName(roomId: string, name: string) {
  if (!roomId || !name) return;
  const map = loadMap();
  if (map[roomId] === name) return;
  map[roomId] = name;
  saveMap(map);
}

// UI 표시용 — 매핑에 있으면 "이름 (roomId)", 없으면 roomId 그대로.
export function displayRoomLabel(roomId: string): string {
  const map = loadMap();
  const name = map[roomId];
  return name ? `${name} (${roomId})` : roomId;
}
