import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react';

// 앱 안의 모든 탭 바가 같은 방식으로 움직이게 하는 공용 조각.
//
// 예전에는 탭 바마다 컨테이너에 overflow-x:auto 만 걸어두었다. 그러면 두 가지가 불편하다.
//   1. 전역 ::-webkit-scrollbar-button(index.css) 이 붙은 굵은 가로 스크롤바가 그대로 드러난다.
//   2. 브라우저는 세로 휠을 가로 스크롤로 바꿔주지 않아서 휠로는 탭을 넘길 수 없다.
// 그래서 "탭 목록만 스크롤 영역에 넣고 ‹ › 는 밖에 고정" 하는 구조를 쓰고, 스크롤바는 CSS 로
// 완전히 숨긴다(App.css 의 .pepe-tabs / .pepe-tabs-scroll / .pepe-tab-scroll-*).

/** 탭이 넘칠 때만 ‹ › 를 띄우기 위한 상태 + 휠 처리. items 에는 탭 배열을 넘긴다. */
export function useTabStripScroll(items: unknown) {
  const tabScrollRef = useRef<HTMLDivElement | null>(null);
  const [tabsOverflow, setTabsOverflow] = useState(false);

  const measureTabsOverflow = useCallback(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    const next = el.scrollWidth > el.clientWidth + 1;
    setTabsOverflow(prev => (prev === next ? prev : next));
  }, []);

  useEffect(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measureTabsOverflow());
    try { ro?.observe(el); } catch {}
    window.addEventListener('resize', measureTabsOverflow);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measureTabsOverflow); };
  }, [measureTabsOverflow]);

  // 탭 추가/삭제/제목 변경은 컨테이너 크기를 안 바꿔서 ResizeObserver 가 안 뜬다 — 직접 다시 잰다.
  useEffect(() => { measureTabsOverflow(); }, [items, measureTabsOverflow]);

  const scrollTabs = useCallback((dx: number) => {
    tabScrollRef.current?.scrollBy({ left: dx, behavior: 'smooth' });
  }, []);

  const onTabWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;               // 넘칠 게 없으면 그대로 둔다
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;       // 트랙패드 가로 제스처는 기본 동작
    el.scrollLeft += e.deltaY > 0 ? 60 : -60;
  }, []);

  return { tabScrollRef, tabsOverflow, scrollTabs, onTabWheel };
}

/** 가운데 버튼(휠 클릭)으로 탭 닫기. 탭 요소에 펼쳐서 붙인다 — {...middleClickClose(() => close(id))}
 *
 *  mousedown 에서 기본 동작을 막아야 한다 — 안 막으면 가운데 클릭이 자동 스크롤 위젯을 띄우고
 *  그 뒤 auxclick 이 오지 않는 경우가 있다. */
export function middleClickClose(close: () => void) {
  return {
    onMouseDown: (e: ReactMouseEvent) => { if (e.button === 1) e.preventDefault(); },
    onAuxClick: (e: ReactMouseEvent) => { if (e.button === 1) { e.preventDefault(); close(); } },
  };
}

/** ref 로 넘겨서 가로로만 늘어선 줄(탭이 아닌 아이콘 줄 등)을 세로 휠로 굴리게 한다.
 *  React 의 onWheel 은 passive 로 붙어 preventDefault 가 듣지 않으므로 직접 붙인다. */
export function attachWheelToScrollX(el: HTMLElement | null) {
  if (!el || (el as any).__pepeWheelX) return;
  (el as any).__pepeWheelX = true;
  el.addEventListener('wheel', (ev: WheelEvent) => {
    if (el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
    el.scrollLeft += ev.deltaY;
    ev.preventDefault();
  }, { passive: false });
}
