// Windows 터미널 스타일 스크롤바 — 스크롤 가능한 요소의 "스크롤바가 실제로 그려지는 좁은
// 픽셀 영역"에 마우스가 있을 때만 두껍게 확장한다. CSS `:hover`는 요소 전체 단위로만 동작해서
// (`*:hover::-webkit-scrollbar`처럼) 큰 패널 안 아무 데나 마우스가 있어도 스크롤바가 확장돼버리는
// 문제가 있었고, `::-webkit-scrollbar:hover`(스크롤바 pseudo-element 자신의 hover)로 좁혀보려 했지만
// 이 Electron/Chromium 빌드에서는 그마저도 안 먹혀서, 마우스 좌표를 직접 계산해 클래스를 토글한다.
const HOT_CLASS = 'pepe-scrollbar-hot';
const EDGE_PX = 18; // 확장 전 스크롤바 두께(8px)보다 넉넉하게 잡아 확장 애니메이션 중에도 안 끊기게.

function isVScrollable(el: Element): boolean {
  const cs = getComputedStyle(el);
  return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
}
function isHScrollable(el: Element): boolean {
  const cs = getComputedStyle(el);
  return (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth;
}

let hotEl: Element | null = null;
let rafId = 0;
let pendingX = 0;
let pendingY = 0;

function computeHot(x: number, y: number): Element | null {
  let el: Element | null = document.elementFromPoint(x, y);
  while (el && el !== document.documentElement) {
    // 좌표 검사를 먼저 하고, 가장자리 근처일 때만 getComputedStyle 을 읽는다.
    // 순서가 반대였을 때는 조상 요소마다 getComputedStyle 이 불려 스타일 재계산이 강제됐다 —
    // 터미널처럼 DOM 이 깊은 곳에서 마우스를 움직이면 조상 수만큼 쌓였고, 트레이스에서 우리
    // 코드 중 강제 레이아웃 1위(161건, 0.10초)로 잡혔다. 가장자리 근처인 요소는 보통 0~1개다.
    const rect = el.getBoundingClientRect();
    const nearRight = x >= rect.right - EDGE_PX && x <= rect.right && y >= rect.top && y <= rect.bottom;
    const nearBottom = y >= rect.bottom - EDGE_PX && y <= rect.bottom && x >= rect.left && x <= rect.right;
    if (nearRight && isVScrollable(el)) return el;
    if (nearBottom && isHScrollable(el)) return el;
    el = el.parentElement;
  }
  return null;
}

function flush() {
  rafId = 0;
  const found = computeHot(pendingX, pendingY);
  if (found !== hotEl) {
    if (hotEl) hotEl.classList.remove(HOT_CLASS);
    if (found) found.classList.add(HOT_CLASS);
    hotEl = found;
  }
}

function onMouseMove(e: MouseEvent) {
  pendingX = e.clientX;
  pendingY = e.clientY;
  if (!rafId) rafId = window.requestAnimationFrame(flush);
}

function onMouseLeave() {
  if (hotEl) {
    hotEl.classList.remove(HOT_CLASS);
    hotEl = null;
  }
}

let initialized = false;
export function initScrollbarHoverTracking() {
  if (initialized) return;
  initialized = true;
  window.addEventListener('mousemove', onMouseMove, { passive: true });
  window.addEventListener('mouseout', (e: MouseEvent) => { if (!e.relatedTarget) onMouseLeave(); }, { passive: true });
}
