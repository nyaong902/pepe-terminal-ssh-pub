// src/utils/chatArchiveRoomNames.ts
// 대화 아카이브의 roomId(NAVER WORKS data-key, 숫자 문자열) -> 방 이름 매핑.
// 저장/검색 등 내부 로직은 전부 roomId 그대로 다룬다 — 이 매핑은 오직 화면(UI) 표시 시점에만
// roomId 를 사람이 읽을 수 있는 방 이름으로 바꿔주는 용도.
//
// 원래 렌더러 localStorage 에 저장했었는데, dev(Vite dev server, http://localhost:PORT origin)와
// 패키지된 앱(커스텀 프로토콜 origin)은 origin 이 서로 달라 localStorage 가 완전히 격리된다 —
// dev 에서 방 목록을 조회해 채운 매핑이 실제 설치된 앱 화면에는 전혀 안 보이는 문제가 있었다
// (실측). electron/chatArchiveStore.ts 에 파일로 저장하도록 옮겨, dev/설치본이 이미 공유하는
// userData 경로를 그대로 재사용한다.
//
// displayRoomLabel() 은 렌더링 중 동기 호출되는 자리(JSX 안)에서 쓰이므로, IPC(비동기) 결과를
// 인메모리 캐시에 담아두고 그 캐시를 동기로 읽는 방식을 쓴다. 캐시가 없을 때는 일단 roomId 를
// 그대로 보여주고, 백그라운드에서 채운 뒤 구독자에게 알려 리렌더를 유도한다.
let cache: Record<string, string> = {};
let cacheLoaded = false;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach(fn => { try { fn(); } catch {} });
}

function ensureLoaded(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const res = await (window as any).api?.chatArchiveGetRoomNames?.();
      if (res?.ok && res.names && typeof res.names === 'object') {
        cache = res.names;
      }
    } catch {
    } finally {
      cacheLoaded = true;
      notifyListeners();
    }
  })();
  return loadPromise;
}

// 컴포넌트가 마운트 시 호출해 캐시 로딩을 트리거하고, 로딩 완료(또는 갱신) 시 리렌더할 수 있게
// 구독한다. React 컴포넌트에서는 useEffect 안에서 이 함수를 부르고 반환값(unsubscribe)을 cleanup 으로 쓰면 된다.
export function subscribeRoomNames(onChange: () => void): () => void {
  listeners.add(onChange);
  ensureLoaded();
  return () => { listeners.delete(onChange); };
}

// 방 이름이 확인될 때마다(방 목록 조회, 백필 진행 중 등) 호출해 매핑을 누적 갱신한다. 캐시를
// 즉시 갱신해 이후 displayRoomLabel 호출에 바로 반영하고, 파일 저장은 비동기로 흘려보낸다.
export function setRoomName(roomId: string, name: string) {
  if (!roomId || !name) return;
  if (cache[roomId] === name) return;
  cache = { ...cache, [roomId]: name };
  notifyListeners();
  try { (window as any).api?.chatArchiveSetRoomNames?.([{ roomId, name }]); } catch {}
}

// UI 표시용 — 매핑에 있으면 "이름 (roomId)", 없으면 roomId 그대로. 캐시가 아직 안 실렸으면
// 백그라운드 로딩을 트리거만 해두고(구독자가 있다면 완료 시 알아서 리렌더됨) roomId 를 그대로 보여준다.
export function displayRoomLabel(roomId: string): string {
  if (!cacheLoaded) ensureLoaded();
  const name = cache[roomId];
  return name ? `${name} (${roomId})` : roomId;
}
