// src/utils/messengerScraper.ts
// NAVER WORKS 웹 메신저(talk.worksmobile.com) DOM 스크래핑 — 서버측 데몬/공식 API 없이,
// 이미 로그인된 webview 안에 JS를 주입해 대화 내용을 읽어온다. 렌더러에서 webview ref로 직접
// 실행(webview.executeJavaScript)하고, 결과만 IPC(window.api.chatArchive*)로 메인에 넘겨
// 임베딩/암호화/저장은 electron/chatArchiveStore.ts 가 담당한다.
//
// DOM 구조(2026-07 기준, 실측):
//   #chat_room_scroll(.scroller)         — 메시지 목록 스크롤 컨테이너. scrollTop=0 으로 스크롤하면
//                                           과거 메시지가 자동으로 더 로드됨(버튼 없음, 무한스크롤).
//   div[scroll-key]                      — 메시지 하나. scroll-key 는 메시지별 고유 순번(정렬용).
//     data-for-copy = '{"fromUserName":"...","messageTime":<epoch ms>,"updateTime":...}'
//     .hl_content (p 태그, class="msg hl_content" 형태 — 메시지 안에 여러 개일 수 있음) — 본문 텍스트.
//   .inform_msg (msg_wrap 에 추가되는 클래스)  — "메시지를 회수하였습니다" 등 시스템 알림. 본문이
//     .hl_content 가 아니라 <span class="txt">에 있어 자동으로 빈 텍스트 처리되어 스킵됨(의도된 동작).
//   div.inform_date                      — 날짜 구분선(scroll-key 없음) — 메시지 아님, 무시.
//   ul.chat_grp_lst > li.item_chat[data-key="<숫자ID>"]  — 왼쪽 대화방 목록 항목. data-key 가
//     방의 안정적인 고유 ID(roomId 로 그대로 사용). 현재 열려있는 방은 추가로 class="selected".

export type ScrapedMessage = { scrollKey: string; sender: string; ts: number; text: string };

// webview(Electron <webview> 엘리먼트)에 최소한의 타입만 필요 — executeJavaScript 반환값은 any.
// sendInputEvent — 방 목록 무한스크롤 대응(아래 SCROLL_ROOM_LIST_TO_BOTTOM_SCRIPT 주석 참고)에 필요.
type WebviewLike = { executeJavaScript: (code: string) => Promise<any>; sendInputEvent?: (event: any) => void };

const EXTRACT_SCRIPT = `
(function() {
  const scroller = document.querySelector('#chat_room_scroll');
  if (!scroller) return { ok: false, error: 'scroller-not-found' };
  // textContent 는 <br> 을 그냥 무시해서 줄바꿈 있는 메시지가 다 붙어버림(예: "확인했습니다.쏴~리")
  // — <br> 을 개행으로 바꿔가며 직접 순회.
  function extractText(el) {
    var out = '';
    el.childNodes.forEach(function(node) {
      if (node.nodeType === 3) out += node.textContent || '';
      else if (node.tagName === 'BR') out += '\\n';
      else out += node.textContent || '';
    });
    return out;
  }
  const nodes = Array.from(scroller.querySelectorAll('[scroll-key]'));
  const messages = nodes.map(function(el) {
    const key = el.getAttribute('scroll-key') || '';
    let meta = {};
    try { meta = JSON.parse(el.getAttribute('data-for-copy') || '{}'); } catch (e) {}
    // 답장(reply) 메시지는 .hl_content 가 아니라 <p class="msg"> 에 본문이 들어있고, 그 위
    // <div class="reply_msg"> 안에는 인용된 원본 메시지(dd.msg)가 별도로 존재한다 — .hl_content
    // 만 보면 이런 메시지는 textEls 가 비어서 text가 ''가 되어 통째로 스크래핑에서 누락된다.
    // .hl_content 가 없을 때 p.msg(답장 본문)로 폴백. 인용된 원본(.reply_msg 안의 dd.msg)은
    // 원본 메시지 자체가 별도 scroll-key로 이미 수집되므로 여기서 또 긁으면 중복이라 제외.
    let textEls = Array.from(el.querySelectorAll('.hl_content'));
    if (textEls.length === 0) {
      textEls = Array.from(el.querySelectorAll('p.msg')).filter(function(p) {
        return !p.closest('.reply_msg');
      });
    }
    // &nbsp;(U+00A0) 등 특수 공백이 원문에 섞여 있으면 겉보기엔 일반 스페이스와 똑같아 보이지만,
    // 나중에 이 텍스트를 검색어로 그대로 써서 메신저 자체 검색을 돌릴 때 매칭이 안 되는 문제가
    // 있었음 — 개행은 보존하되 그 외 공백류는 전부 일반 스페이스로 정규화.
    const text = textEls.map(extractText).join('\\n')
      .replace(/[^\\S\\n]+/g, ' ').trim();
    return {
      scrollKey: key,
      sender: meta.fromUserName || '',
      ts: meta.messageTime || meta.updateTime || 0,
      text: text,
    };
  }).filter(function(m) { return m.text; });
  return { ok: true, messages: messages, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
})()
`;

const SCROLL_TO_TOP_SCRIPT = `
(function() {
  const scroller = document.querySelector('#chat_room_scroll');
  if (!scroller) return { ok: false };
  const beforeCount = scroller.querySelectorAll('[scroll-key]').length;
  scroller.scrollTop = 0;
  return { ok: true, beforeCount: beforeCount };
})()
`;

async function extractVisibleMessages(webview: WebviewLike): Promise<ScrapedMessage[]> {
  const res = await execJs(webview, EXTRACT_SCRIPT);
  if (!res?.ok) return [];
  return (res.messages || []) as ScrapedMessage[];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// webview.executeJavaScript() 는 webview 가 크래시했거나 응답 없는 상태(네비게이션 중, 렌더러
// 프로세스 행 등)가 되면 Promise 가 영원히 pending 될 수 있다 — 이걸 그대로 await 하는 백필
// 함수(scrapeAllRooms, listAllRoomsWithNames 등)는 그 await 에서 영영 안 풀려, 호출부의
// archiveBackfill.running/archiveRoomPickerLoading 같은 로딩 state 가 영구히 true 로 고정되는
// "좀비" 상태가 된다(finally 블록도 실행 안 됨, "중지" 버튼도 무력화). 모든 executeJavaScript
// 호출을 이 헬퍼로 감싸 유한 시간 안에 반드시 resolve/reject 되도록 강제한다.
const EXECUTE_JS_TIMEOUT_MS = 10000;
function execJs(webview: WebviewLike, script: string, timeoutMs = EXECUTE_JS_TIMEOUT_MS): Promise<any> {
  return Promise.race([
    webview.executeJavaScript(script),
    new Promise((_, reject) => setTimeout(() => reject(new Error('executeJavaScript timed out')), timeoutMs)),
  ]);
}

const COUNT_SCRIPT = `
(function() {
  const scroller = document.querySelector('#chat_room_scroll');
  return scroller ? scroller.querySelectorAll('[scroll-key]').length : 0;
})()
`;

// 고정 sleep 대신 실제로 메시지 개수가 늘어나는 걸 짧은 간격으로 확인 — 앱이 빠르게 반응하면
// 그만큼 빨리 다음 단계로 넘어가고, 느릴 때만 maxWaitMs 까지 안전하게 기다린다.
async function waitForCountAbove(webview: WebviewLike, baseline: number, maxWaitMs: number, pollIntervalMs = 150): Promise<number> {
  const deadline = Date.now() + maxWaitMs;
  let last = baseline;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    last = await execJs(webview, COUNT_SCRIPT).catch(() => baseline);
    if (last > baseline) return last;
  }
  return last;
}

async function flushChunks(roomId: string, msgs: ScrapedMessage[]): Promise<void> {
  if (msgs.length === 0) return;
  const chunks = msgs.map(m => ({ ts: m.ts, sender: m.sender, text: m.text }));
  try {
    const res = await (window as any).api?.chatArchiveAppendChunks?.(roomId, chunks);
    // IPC 핸들러는 예외를 던지지 않고 {ok:false, error} 를 반환하므로, 여기서 명시적으로 확인 안 하면
    // 실패가 콘솔에 아무 흔적도 안 남고 조용히 사라진다 — 저장 실패를 반드시 눈에 보이게 함.
    if (!res?.ok) console.error('[chat-archive] 저장 실패', roomId, res?.error);
  } catch (err) {
    console.error('[chat-archive] 저장 IPC 호출 실패', roomId, err);
  }
}

// 현재 화면에 로드돼 있는 메시지만 긁어서 저장 — 백필 이후 주기적 업데이트용 경량 버전.
// (과거로 스크롤하지 않음. 이미 저장된 것은 chatArchiveStore 쪽 dedup 이 걸러줌.)
export async function scrapeLatestForRoom(webview: WebviewLike, roomId: string): Promise<{ scraped: number }> {
  const msgs = await extractVisibleMessages(webview);
  await flushChunks(roomId, msgs);
  return { scraped: msgs.length };
}

// 지금 열려있는 대화방의 roomId(data-key) — 주기적 업데이트가 "현재 보고 있는 방"만 가볍게
// 갱신할 때 사용(백그라운드에서 임의로 다른 방을 열어 사용자 작업을 방해하지 않기 위함).
export async function getSelectedRoomKey(webview: WebviewLike): Promise<string | null> {
  const res = await execJs(webview, `
    (function() {
      const li = document.querySelector('ul.chat_grp_lst > li.item_chat.selected[data-key]');
      return { ok: true, key: li ? li.getAttribute('data-key') : null };
    })()
  `).catch(() => null);
  return res?.ok ? (res.key || null) : null;
}

export type BackfillProgress = { roomId: string; totalMessages: number; rounds: number };
// mode: 'incremental'(기본) — 이미 저장된(ts+sender 동일) 지점을 만나면 곧 조기 종료, 빠름.
// 'full' — 이미 저장된 메시지를 만나도 텍스트 내용이 실제로 바뀐 것("새로움")으로 취급해 끝까지
// 스크롤한다. 실측 사례: 스크래퍼의 <br> 개행 처리 로직을 고치기 전에 저장된 메시지들은 지금
// 다시 긁으면 텍스트가 달라지는데(개행 복원), incremental 모드는 ts+sender 만 보고 "이미 안다"고
// 판단해 금방 멈추는 바람에 오래된 메시지까지 도달하지 못해 갱신이 안 된다. full 모드는 이런
// 과거 오염 데이터를 확실히 다시 훑어 appendChunks 의 텍스트-변경 감지(chatArchiveStore.ts)로
// 갱신되게 한다 — 대신 방 전체를 끝까지 스크롤하므로 느리다.
export type BackfillMode = 'incremental' | 'full';

// 방 하나의 과거 전체 히스토리 백필 — 맨 위로 스크롤을 반복해 계속 옛 메시지를 불러오다가,
// 연속 STALE_ROUNDS_LIMIT 회 동안 새 메시지가 하나도 안 늘어나면 "맨 위(대화 시작)"로 판단하고 종료.
const STALE_ROUNDS_LIMIT = 3;
const MAX_SCROLL_WAIT_MS = 2500; // 새 메시지가 안 늘어날 때의 최대 대기 — 늘어나면 훨씬 일찍 리턴됨
const FLUSH_BATCH_SIZE = 200; // 이 개수만큼 새 메시지가 쌓이면 중간에 한 번 저장(중단돼도 유실 최소화)

export async function scrapeRoomHistory(
  webview: WebviewLike,
  roomId: string,
  onProgress?: (p: BackfillProgress) => void,
  shouldStop?: () => boolean,
  mode: BackfillMode = 'incremental',
): Promise<BackfillProgress> {
  const seenKeys = new Set<string>();
  let pending: ScrapedMessage[] = [];
  let totalMessages = 0;
  let staleRounds = 0;
  let rounds = 0;

  // 이번 실행에서 처음 보는 메시지 중, 저장소에도 이미 있는지까지 확인해서 "진짜 새 정보"인
  // 개수를 반환한다 — 재백필(이미 한 번 끝까지 돌았던 방을 다시 백필)일 때, 예전에 이미 저장한
  // 지점까지 스크롤해 올라가면 이 값이 0이 되면서 STALE_ROUNDS_LIMIT 에 도달해 빠르게 멈춘다.
  // (pending 에는 로컬 신규분을 전부 넣어둠 — 어차피 저장 단계에서 다시 걸러지므로 안전.)
  // full 모드에서는 이 "이미 안다" 판정 자체를 건너뛰고 화면에 보이는 걸 전부 새로움으로 취급 —
  // 그래야 STALE_ROUNDS_LIMIT 이 앞부분에서 걸리지 않고 방 전체를 끝까지 스크롤한다.
  const collectNew = async (msgs: ScrapedMessage[]): Promise<number> => {
    const locallyNew = msgs.filter(m => !seenKeys.has(m.scrollKey));
    for (const m of locallyNew) seenKeys.add(m.scrollKey);
    if (locallyNew.length === 0) return 0;
    pending.push(...locallyNew);
    if (mode === 'full') return locallyNew.length;
    try {
      const res = await (window as any).api?.chatArchiveFilterUnknown?.(
        roomId,
        locallyNew.map(m => ({ ts: m.ts, sender: m.sender })),
      );
      if (res?.ok) return (res.items || []).length;
    } catch {}
    return locallyNew.length; // 조회 실패 시 안전하게 "전부 새 것"으로 취급(조기종료 안 함)
  };

  // 초기 화면에 보이는 메시지부터 시작
  await collectNew(await extractVisibleMessages(webview));

  while (staleRounds < STALE_ROUNDS_LIMIT) {
    if (shouldStop?.()) break;
    const scrollRes = await execJs(webview, SCROLL_TO_TOP_SCRIPT);
    const beforeCount = scrollRes?.beforeCount ?? 0;
    await waitForCountAbove(webview, beforeCount, MAX_SCROLL_WAIT_MS);
    const msgs = await extractVisibleMessages(webview);
    const added = await collectNew(msgs);
    rounds++;
    staleRounds = added > 0 ? 0 : staleRounds + 1;

    if (pending.length >= FLUSH_BATCH_SIZE) {
      totalMessages += pending.length;
      await flushChunks(roomId, pending);
      pending = [];
    }
    onProgress?.({ roomId, totalMessages: totalMessages + pending.length, rounds });
  }

  if (pending.length > 0) {
    totalMessages += pending.length;
    await flushChunks(roomId, pending);
  }
  onProgress?.({ roomId, totalMessages, rounds });
  return { roomId, totalMessages, rounds };
}

// 방 목록: ul.chat_grp_lst > li.item_chat[data-key="<숫자ID>"] — data-key 가 방의 안정적인
// 고유 ID(콘솔에 뜨는 MQTT channel id 와 동일 계열로 보임) 라 roomId 로 그대로 사용.
//
// 방 목록도 메시지 목록처럼 가상 스크롤이라, 사이드바 컨테이너(#chat_list_scroll)를 끝까지
// 스크롤하지 않으면 화면에 로드된 일부(실측: 42개)만 잡힌다 — 실제로는 훨씬 많음(실측: 111개).
// LIST_ROOMS_SCRIPT 를 부르기 전에 반드시 이 스크롤을 먼저 끝까지 내려야 한다.
// 실측: staleRounds 임계값이 낮으면(5라운드 = 1.5초) 네이버웍스 서버가 다음 페이지를 불러오는
// 데 그보다 오래 걸릴 때(네트워크 상태에 따라 매번 다름 — 같은 코드로 111개까지 간 적도, 42개
// 에서 멈춘 적도 있었음) 아직 더 있는데도 "끝"으로 오판하고 조기 종료한다. 임계값과 폴링 간격을
// 늘려 로딩 텀을 더 넉넉히 흡수한다(무변화 15라운드 연속, 각 500ms 간격 = 최대 7.5초까지 대기).
const STALE_ROUNDS_LIMIT_ROOM_LIST = 15;
const POLL_INTERVAL_MS_ROOM_LIST = 500;

// 실측: scrollTop 을 scrollHeight 로 대입하면 실제로 바닥(scrollHeight - clientHeight)까지는
// 이동하지만(즉 "스크롤 자체는 됨"), 방 개수가 그 뒤로 전혀 늘지 않고 고착된다(45개 등, 매번 다른
// 숫자에서 멈춤). 스크립트로 만든 WheelEvent/scroll 이벤트를 추가로 dispatch 해도 마찬가지였다 —
// 반면 외부 브라우저 탭에서 사람이 직접 마우스 휠로 스크롤하면 잘 로드된다. 즉 이 무한스크롤은
// 스크립트가 만든 합성(untrusted) 이벤트에는 반응하지 않고, 진짜 OS 레벨 입력에만 반응하는 것으로
// 보인다 — 그래서 document 안에서 dispatchEvent 하는 대신, Electron webview 의 sendInputEvent()
// (진짜 마우스/휠 입력처럼 렌더러에 전달되는 API)로 실제 화면 좌표에 mouseWheel 이벤트를 보낸다.
const CONTAINER_RECT_SCRIPT = `
(function() {
  const el = document.querySelector('#chat_list_scroll');
  if (!el) return { ok: false };
  const r = el.getBoundingClientRect();
  return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height - 10) };
})()
`;

const ROOM_LIST_COUNT_SCRIPT = `
document.querySelectorAll('ul.chat_grp_lst > li.item_chat[data-key]').length
`;

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 방 이름: li.item_chat 안의 strong.name (title 속성에 풀네임, textContent 는 잘려 보일 수 있어
// title 우선) — 방 목록을 한 번만 훑으면 전체 방 이름을 다 얻을 수 있어, 방을 하나씩 열어 헤더에서
// 읽는 GET_ROOM_TITLE_SCRIPT 보다 훨씬 빠르다.
const LIST_ROOMS_SCRIPT = `
(function() {
  const items = Array.from(document.querySelectorAll('ul.chat_grp_lst > li.item_chat[data-key]'));
  return { ok: true, rooms: items.map(function(li) {
    const nameEl = li.querySelector('strong.name');
    const name = nameEl ? (nameEl.getAttribute('title') || nameEl.textContent || '').trim() : '';
    return { key: li.getAttribute('data-key') || '', name: name };
  }) };
})()
`;

function clickRoomScript(key: string): string {
  const safeKey = JSON.stringify(key);
  return `
(function() {
  const li = document.querySelector('ul.chat_grp_lst > li.item_chat[data-key="' + ${safeKey} + '"]');
  if (!li) return { ok: false, error: 'room-not-found' };
  li.click();
  return { ok: true };
})()
`;
}

// 방 이름 표시용(부가정보) — 정확한 헤더 셀렉터는 아직 미확인이라 추정 셀렉터로 시도하고
// 실패하면 빈 값으로 넘어감(roomId=data-key 가 진짜 키라 이름 추출 실패는 저장/검색에 영향 없음).
const GET_ROOM_TITLE_SCRIPT = `
(function() {
  const header = document.querySelector('.chat_view .chat_title, .chat_header .name, .chat_hd_name, [class*="chat_title"]');
  return { ok: true, title: header ? (header.textContent || '').trim() : '' };
})()
`;

// 실측 사례: 네이버웍스 페이지 자체가 아직 다 로드되기 전에(수동 마우스 휠 스크롤조차 안 먹히는
// 상태) 백필을 시작하면, 방 목록이 예를 들어 22개 같은 훨씬 적은 수에서 고착돼 버린다(스크롤 로직
// 문제가 아니라 페이지가 준비 안 된 상태였음). 스크롤을 시작하기 전에 방 목록 컨테이너/항목이
// 실제로 존재하고, 짧은 시간 안정적으로 유지되는지 먼저 확인해 이런 조기 실행을 방지한다.
const READY_CHECK_INTERVAL_MS = 300;
const READY_CHECK_STABLE_ROUNDS = 3; // 이 라운드만큼 연속으로 개수가 그대로면 "로드 완료"로 판단
const READY_CHECK_MAX_WAIT_MS = 15000;

async function waitForRoomListReady(webview: WebviewLike): Promise<boolean> {
  const deadline = Date.now() + READY_CHECK_MAX_WAIT_MS;
  let lastCount = -1;
  let stableRounds = 0;
  while (Date.now() < deadline) {
    const count: number = await execJs(webview, ROOM_LIST_COUNT_SCRIPT).catch(() => 0);
    if (count > 0 && count === lastCount) {
      stableRounds++;
      if (stableRounds >= READY_CHECK_STABLE_ROUNDS) return true;
    } else {
      stableRounds = 0;
    }
    lastCount = count;
    await sleepMs(READY_CHECK_INTERVAL_MS);
  }
  return lastCount > 0; // 끝까지 완전히 안정되진 않았어도 방이 하나라도 잡혔으면 진행은 해본다
}

// 방 목록 컨테이너(#chat_list_scroll)를 실제 마우스 휠 입력으로 끝까지 스크롤한다 — 위 주석 참고
// (스크립트 합성 이벤트로는 무한스크롤이 안 먹혀서, webview.sendInputEvent 로 진짜 입력을 보낸다).
// 매 tick 마다 방 개수를 세어, STALE_ROUNDS_LIMIT_ROOM_LIST 회 연속 변화가 없으면 끝으로 본다.
async function scrollRoomListToBottom(webview: WebviewLike): Promise<{ ok: boolean; count: number }> {
  await waitForRoomListReady(webview);
  const rect = await execJs(webview, CONTAINER_RECT_SCRIPT).catch(() => null);
  if (!rect?.ok) return { ok: false, count: 0 };
  if (typeof webview.sendInputEvent !== 'function') return { ok: false, count: 0 };

  let lastCount = 0;
  let staleRounds = 0;
  for (let rounds = 0; rounds < 300 && staleRounds < STALE_ROUNDS_LIMIT_ROOM_LIST; rounds++) {
    // mouseWheel 타입 — Electron webview 의 sendInputEvent 가 지원하는 입력 이벤트 타입 중 하나로,
    // 실제 트랙패드/마우스 휠처럼 페이지에 전달돼 스크립트 합성 이벤트와 달리 신뢰된 입력으로 처리된다.
    webview.sendInputEvent!({
      type: 'mouseWheel',
      x: rect.x, y: rect.y,
      deltaX: 0, deltaY: -120, // 음수 deltaY = 아래로 스크롤(Electron 휠 이벤트 부호 규약)
      canScroll: true,
    });
    await sleepMs(POLL_INTERVAL_MS_ROOM_LIST);
    const count: number = await execJs(webview, ROOM_LIST_COUNT_SCRIPT).catch(() => lastCount);
    if (count === lastCount) staleRounds++; else { staleRounds = 0; lastCount = count; }
  }
  return { ok: true, count: lastCount };
}

const MAX_ROOM_SWITCH_WAIT_MS = 3000; // 방 클릭 후 사이드바 selected 표시가 그 방으로 바뀔 때까지 최대 대기
const ROOM_SWITCH_SETTLE_MS = 400; // selected 확인 후에도 메시지 렌더링이 살짝 늦을 수 있어 주는 짧은 여유

const SELECTED_KEY_SCRIPT = `
(function() {
  const li = document.querySelector('ul.chat_grp_lst > li.item_chat.selected[data-key]');
  return li ? li.getAttribute('data-key') : null;
})()
`;

// 메시지 개수만 보고 "방이 전환됐다"고 판단하면, 이전 방의 메시지가 아직 안 지워진 상태에서
// 새 방으로 착각해 이전 방 대화를 새 roomId 로 잘못 저장할 위험이 있음 — 그래서 메시지 개수가
// 아니라 사이드바의 "선택된 방" 표시(li.selected 의 data-key)가 실제로 클릭한 방으로 바뀌는지를
// 기준으로 기다린다. 이건 방 정체성 자체를 보는 신호라 더 안전함.
async function waitForRoomSelected(webview: WebviewLike, key: string, maxWaitMs: number, pollIntervalMs = 150): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const selected = await execJs(webview, SELECTED_KEY_SCRIPT).catch(() => null);
    if (selected === key) return true;
    await sleep(pollIntervalMs);
  }
  return false;
}

export type RoomBackfillProgress = BackfillProgress & { roomIndex: number; roomTotal: number; roomName?: string };

// 방 목록만 빠르게 얻는다(방 이름 포함, 실제 백필은 하지 않음) — 백필 버튼을 누르면 먼저 이 함수로
// 전체 방 리스트를 뽑아 사용자에게 체크박스로 보여주고, 선택된 방만 scrapeAllRooms(roomIds) 로
// 넘기는 2단계 흐름에서 1단계로 쓰인다.
//
// 방 목록 자체가 가상 스크롤이라, 끝까지 스크롤해 전체 방을 로드해두지 않으면 화면에 보이는
// 일부만 잡힌다(실측: 스크롤 전 42개 vs 스크롤 후 111개) — LIST_ROOMS_SCRIPT 전에 반드시 먼저 실행.
// scrollRoomListToBottom 은 sendInputEvent 로 진짜 마우스 휠 입력을 보낸다(위 함수 정의 주석 참고
// — 스크립트 합성 이벤트로는 이 무한스크롤이 안 먹혔음). 그래도 한 번에 끝까지 못 갈 수 있어(정체
// 판정 타이밍), 이전 시도와 개수가 같아질 때까지(진짜 끝) 반복 재시도한다.
// shouldStop 이 주어지면(scrapeAllRooms 에서 "중지" 버튼과 연결) 재시도 루프 사이사이 체크해
// 사용자가 중지했을 때 이 단계에서도 즉시 빠져나올 수 있게 한다 — 이게 없으면 방 목록 로딩만
// 최대 90초(6회 재시도 × waitForRoomListReady 15초)까지 "중지"가 안 먹힐 수 있었다.
export async function listAllRoomsWithNames(webview: WebviewLike, shouldStop?: () => boolean): Promise<Array<{ key: string; name?: string }>> {
  let roomListScrollCount = 0;
  let prevScrollCount = -1;
  let scrollStaleAttempts = 0;
  for (let attempt = 0; attempt < 6 && scrollStaleAttempts < 2; attempt++) {
    if (shouldStop?.()) break;
    const scrollRes = await scrollRoomListToBottom(webview).catch((err: any) => {
      console.warn('[chat-archive] 방 목록 스크롤 실패', err);
      return { ok: false, count: 0 };
    });
    roomListScrollCount = scrollRes.count;
    console.log('[chat-archive] 방 목록 스크롤 결과:', scrollRes, '(시도', attempt + 1, ')');
    if (roomListScrollCount > 0 && roomListScrollCount === prevScrollCount) scrollStaleAttempts++;
    else scrollStaleAttempts = 0;
    prevScrollCount = roomListScrollCount;
  }
  const listRes = await execJs(webview, LIST_ROOMS_SCRIPT);
  return listRes?.ok ? (listRes.rooms || []) : [];
}

export async function scrapeAllRooms(
  webview: WebviewLike,
  onProgress?: (p: RoomBackfillProgress) => void,
  shouldStop?: () => boolean,
  mode: BackfillMode = 'incremental',
  // roomIds 가 주어지면 그 목록에 속한 방만 순회한다(방 선택 UI 에서 사용) — 없으면 기존처럼 전체
  // 방을 순회한다(하위 호환).
  roomIds?: string[],
): Promise<BackfillProgress[]> {
  const allRooms = await listAllRoomsWithNames(webview, shouldStop);
  const rooms = roomIds ? allRooms.filter(r => roomIds.includes(r.key)) : allRooms;
  const results: BackfillProgress[] = [];
  for (let i = 0; i < rooms.length; i++) {
    if (shouldStop?.()) break;
    const key = rooms[i].key;
    if (!key) continue;
    // 방 이름은 방 목록(LIST_ROOMS_SCRIPT)에서 이미 얻었으므로(strong.name), 예전처럼 방을 열어
    // 헤더에서 다시 읽을 필요가 없다 — 방 개수(실측 111개)만큼 왕복이 줄어 백필이 더 빨라진다.
    // 목록에서 이름을 못 얻은 경우(레이아웃 변경 등)에만 방을 연 뒤 헤더에서 폴백으로 읽는다.
    let roomName: string | undefined = rooms[i].name || undefined;
    const clickRes = await execJs(webview, clickRoomScript(key));
    if (!clickRes?.ok) continue;
    await waitForRoomSelected(webview, key, MAX_ROOM_SWITCH_WAIT_MS);
    await sleep(ROOM_SWITCH_SETTLE_MS); // selected 전환 확인 후에도 메시지 렌더링 여유를 짧게 둠
    if (!roomName) {
      const titleRes = await execJs(webview, GET_ROOM_TITLE_SCRIPT).catch(() => null);
      roomName = titleRes?.title || undefined;
    }
    const result = await scrapeRoomHistory(
      webview,
      key,
      p => onProgress?.({ ...p, roomIndex: i + 1, roomTotal: rooms.length, roomName }),
      shouldStop,
      mode,
    );
    results.push(result);
  }
  return results;
}
