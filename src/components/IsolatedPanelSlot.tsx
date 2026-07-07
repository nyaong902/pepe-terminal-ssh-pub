// src/components/IsolatedPanelSlot.tsx
// Layout.tsx 가 특정 leaf 를 격리 대상으로 판단하면 <TerminalPanel> 대신 이걸 렌더한다.
// 실제 xterm/미니탭 UI는 여기 안 그려지고, 그 자리 위에 별도 WebContentsView(PanelHost.tsx,
// 완전히 새 프로세스)가 겹쳐 그린다 — 그 프로세스는 이 panel 데이터의 스냅샷을 받아 그대로
// <TerminalPanel> 을 마운트하므로 TerminalPanel.tsx 자체는 한 줄도 안 건드린다.
//
// 생성 시점에 panel 스냅샷을 1회 query string 으로 넘기고, 이후 세션 전환/추가/닫기는
// 그 프로세스 자신이 로컬로 처리한다(TabApp 의 트리 쪽 사본은 갱신되지 않음 — v1 한계,
// 패널을 다시 격리 해제하거나 탭을 닫을 때만 최신 상태가 필요 없는 정도로 충분).
import { useEffect, useRef } from 'react';
import type { Panel } from '../utils/layoutUtils';

export default function IsolatedPanelSlot({ nodeId, panel, tabId }: { nodeId: string; panel: Panel; tabId: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const viewId = `panel:${nodeId}`;

  useEffect(() => {
    const route = `panel-app?tabId=${encodeURIComponent(tabId)}&nodeId=${encodeURIComponent(nodeId)}&panel=${encodeURIComponent(JSON.stringify(panel))}`;
    (window as any).api?.tabCreateView?.(viewId, route);
    return () => { try { (window as any).api?.tabDestroyView?.(viewId); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId]);

  useEffect(() => {
    if (!ref.current) return;
    const report = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      try {
        (window as any).api?.tabSetVisibility?.(viewId, true, {
          x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
        });
      } catch {}
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(ref.current);
    window.addEventListener('resize', report);
    return () => { ro.disconnect(); window.removeEventListener('resize', report); };
  }, [viewId]);

  return <div ref={ref} className="panel-terminal-area" style={{ width: '100%', height: '100%' }} />;
}
