// src/components/IsolatedTabSlot.tsx
// host(App.tsx) 쪽에서 "이 탭은 별도 프로세스(WebContentsView)로 격리됐다"고 표시된 탭을
// 렌더링할 자리(placeholder) — 실제 Layout/xterm 은 여기 안 그려지고, main 프로세스가
// 이 자리 위에 진짜 WebContentsView 를 겹쳐 그린다(투명 배경, 이 div 는 자리만 차지).
//
// 뷰의 생성/파괴는 이 컴포넌트가 아니라 App.tsx 의 별도 lifecycle effect(isolatedTabIds
// 멤버십 + 실제 탭 존재 여부 기준)가 담당한다 — 그래야 이 슬롯이 마운트/언마운트(탭 전환으로
// activeTab/splitRightTab 자리에서 벗어남)되어도 백그라운드 세션이 파괴되지 않는다.
// 이 컴포넌트는 오직 "지금 이 자리에 보여야 한다"는 가시성(visible)+위치(bounds)만 알린다.
//
// 개발 전용 옵트인: 프로덕션에서는 아무 탭도 격리 대상이 아니므로(App.tsx 의 isolatedTabIds
// 는 기본 빈 Set) 이 컴포넌트는 아직 실사용에 영향 없다.
import { useEffect, useRef } from 'react';

export default function IsolatedTabSlot({ tabId, isActive }: { tabId: string; isActive: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);

  // 이 슬롯이 언마운트되면(탭 전환으로 화면에서 벗어남) 뷰를 파괴하지 않고 숨기기만 한다.
  useEffect(() => {
    return () => { try { (window as any).api?.tabSetVisibility?.(tabId, false); } catch {} };
  }, [tabId]);

  useEffect(() => {
    if (!isActive || !ref.current) {
      if (!isActive) { try { (window as any).api?.tabSetVisibility?.(tabId, false); } catch {} }
      return;
    }
    const report = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      try {
        (window as any).api?.tabSetVisibility?.(tabId, true, {
          x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
        });
      } catch {}
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(ref.current);
    window.addEventListener('resize', report);
    return () => { ro.disconnect(); window.removeEventListener('resize', report); };
  }, [isActive, tabId]);

  return <div ref={ref} style={{ width: '100%', height: '100%' }} />;
}
