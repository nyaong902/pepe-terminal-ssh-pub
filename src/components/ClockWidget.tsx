// src/components/ClockWidget.tsx
// 스위스 철도 시계(SBB) 스타일 데스크톱 위젯 — 시침/분침은 실제 현재 시각을 따라가고,
// 세컨드핸드 자리는 뽀모도로 타이머로 대체된다: 시계판을 좌클릭 드래그해 놓은 지점까지
// 빨간 파이 영역이 "남은 시간"을 나타내고, 손을 떼는 즉시 타이머가 시작되며 점점 줄어든다.
// 창 이동은 우클릭 드래그(좌클릭은 타이머 설정에 이미 쓰이므로 버튼으로 구분).
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { playReminderChime } from '../utils/reminderChime';

const SIZE = 220;
const CENTER = SIZE / 2;
const RADIUS = SIZE / 2 - 3;
const MAX_MINUTES = 60;

function angleForMinutes(minutes: number): number {
  // 12시 방향(-90도)을 0분으로 두고 시계방향으로 진행 — 실제 아날로그 시계의 분침과 동일한 회전 방향.
  return (minutes / MAX_MINUTES) * 360;
}

function polarToXY(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: CENTER + radius * Math.cos(rad), y: CENTER + radius * Math.sin(rad) };
}

// 12시 방향에서 시계방향으로 sweepDeg 만큼 펼쳐진 파이(부채꼴) 조각의 SVG path.
function pieSlicePath(sweepDeg: number, radius: number): string {
  const clamped = Math.max(0, Math.min(360, sweepDeg));
  if (clamped <= 0) return '';
  if (clamped >= 359.999) {
    // 완전한 원 — arc 로는 360도를 한 번에 못 그리므로 두 개의 반원으로 나눈다.
    return `M ${CENTER} ${CENTER - radius} A ${radius} ${radius} 0 1 1 ${CENTER - 0.01} ${CENTER - radius} Z`;
  }
  const start = polarToXY(0, radius);
  const end = polarToXY(clamped, radius);
  const largeArc = clamped > 180 ? 1 : 0;
  return `M ${CENTER} ${CENTER} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

// 마우스 이벤트 좌표(위젯 창 기준)를 시계 중심 기준 각도(0~360, 12시=0)로 변환.
function pointToMinutes(clientX: number, clientY: number, rect: DOMRect): number {
  const cx = rect.left + CENTER;
  const cy = rect.top + CENTER;
  const dx = clientX - cx;
  const dy = clientY - cy;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  if (deg < 0) deg += 360;
  const minutes = (deg / 360) * MAX_MINUTES;
  // 1분 단위로 스냅 — 정확히 원하는 시간에 맞추기 쉽게.
  return Math.round(minutes);
}

function formatCountdown(ms: number): string {
  // ceil 을 쓰면 설정 직후(예: "30분" 확정 순간부터 몇 ms 가 자연히 지나있어 endTime-now 가
  // 1800000ms 보다 살짝 작아짐) 30:00 이 아니라 30:01 로 한 틱 높게 보이는 문제가 있었다.
  // round 로 가장 가까운 초에 맞추면 설정 직후엔 정확히 30:00 부터, 이후에는 매초 자연스럽게
  // 줄어드는 카운트다운이 된다.
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export default function ClockWidget() {
  const [now, setNow] = useState(() => new Date());
  // 드래그 중 미리보기용 분(설정 예정 시간) — 드래그가 끝나면 실제 타이머(endTime)로 확정된다.
  const [previewMinutes, setPreviewMinutes] = useState<number | null>(null);
  const [endTime, setEndTime] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const firedRef = useRef(false);
  // 팝업에 "N분 타이머 종료" 처럼 원래 설정 시간을 보여주기 위해 마지막으로 커밋된 총 시간 보관.
  const totalMsRef = useRef<number | null>(null);

  // 현재 시각 — 초 단위 갱신(시침/분침/카운트다운용).
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // 앱 시작 시 저장된 타이머 상태 복원(진행 중이던 타이머가 있으면 이어서 표시).
  useEffect(() => {
    (async () => {
      try {
        const state = await (window as any).api?.clockWidgetGetState?.();
        if (state?.endTime && state.endTime > Date.now()) {
          setEndTime(state.endTime);
          totalMsRef.current = state.totalMs ?? null;
        }
      } catch {}
    })();
  }, []);

  // 타이머 종료 감지 — 매초 tick(now 갱신)에 얹혀 확인, 0 이하가 되면 알림 후 리셋.
  useEffect(() => {
    if (endTime == null) { firedRef.current = false; return; }
    const remaining = endTime - now.getTime();
    if (remaining <= 0 && !firedRef.current) {
      firedRef.current = true;
      void playReminderChime();
      // OS 알림(Notification)은 dev/미패키징 환경에서 안 뜨는 경우가 많아, 메인 앱 창에
      // 화면 중앙 팝업(worklog 알람과 동일 스타일)으로 띄우도록 main 프로세스에 위임한다 —
      // 위젯 자신은 220x220 짜리 작은 창이라 팝업을 여기 띄우면 잘려 보인다.
      try { (window as any).api?.clockWidgetNotifyDone?.(totalMsRef.current); } catch {}
      setEndTime(null);
      try { (window as any).api?.clockWidgetSetTimer?.(null, null); } catch {}
    }
  }, [now, endTime]);

  const commitTimer = useCallback((minutes: number) => {
    if (minutes <= 0) {
      setEndTime(null);
      firedRef.current = false;
      try { (window as any).api?.clockWidgetSetTimer?.(null, null); } catch {}
      return;
    }
    const ms = minutes * 60 * 1000;
    const end = Date.now() + ms;
    setEndTime(end);
    totalMsRef.current = ms;
    firedRef.current = false;
    try { (window as any).api?.clockWidgetSetTimer?.(end, ms); } catch {}
  }, []);

  // 좌클릭 드래그 — 타이머 설정. 손을 떼는 즉시(pointerup) commitTimer 로 확정해 타이머가 바로 시작된다.
  const handlePointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    draggingRef.current = true;
    (e.target as Element).setPointerCapture(e.pointerId);
    const rect = svgRef.current!.getBoundingClientRect();
    setPreviewMinutes(pointToMinutes(e.clientX, e.clientY, rect));
    e.preventDefault();
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    setPreviewMinutes(pointToMinutes(e.clientX, e.clientY, rect));
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch {}
    setPreviewMinutes(prev => {
      if (prev != null) commitTimer(prev);
      return null;
    });
  }, [commitTimer]);

  // 우클릭 드래그 — 창 이동. window:start-drag/drag-move/end-drag 는 다른 frameless 창(메인/분리
  // 창)에서 이미 쓰는 IPC 를 그대로 재사용 — 화면 좌표(screenX/Y) 기준으로 메인 프로세스가 직접
  // BrowserWindow.setPosition 을 호출한다.
  const draggingWindowRef = useRef(false);
  const handleContextMenuDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 2) return;
    e.preventDefault();
    draggingWindowRef.current = true;
    try { (window as any).api?.windowStartDrag?.(e.screenX, e.screenY); } catch {}
    const onMove = (ev: MouseEvent) => {
      if (!draggingWindowRef.current) return;
      try { (window as any).api?.windowDragMove?.(ev.screenX, ev.screenY); } catch {}
    };
    const onUp = () => {
      draggingWindowRef.current = false;
      try { (window as any).api?.windowEndDrag?.(); } catch {}
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // 표시할 "남은 분" — 드래그 중이면 미리보기 값, 아니면 실제 타이머의 남은 시간.
  const displayMinutes = previewMinutes != null
    ? previewMinutes
    : (endTime != null ? Math.max(0, (endTime - now.getTime()) / 60000) : 0);
  const sweepDeg = angleForMinutes(displayMinutes);
  const remainingMs = endTime != null ? Math.max(0, endTime - now.getTime()) : previewMinutes != null ? previewMinutes * 60000 : 0;

  const hours = now.getHours() % 12;
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const hourAngle = (hours + minutes / 60) * 30;
  const minuteAngle = (minutes + seconds / 60) * 6;

  const hourTip = polarToXY(hourAngle, RADIUS * 0.5);
  const minuteTip = polarToXY(minuteAngle, RADIUS * 0.72);
  const timerHandTip = polarToXY(sweepDeg, RADIUS * 0.9);

  const ticks = Array.from({ length: 60 }, (_, i) => {
    const isHour = i % 5 === 0;
    const inner = isHour ? RADIUS * 0.82 : RADIUS * 0.88;
    const p1 = polarToXY(i * 6, RADIUS * 0.96);
    const p2 = polarToXY(i * 6, inner);
    return { key: i, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, isHour };
  });

  return (
    <svg
      ref={svgRef}
      width={SIZE} height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onMouseDown={handleContextMenuDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ display: 'block', cursor: 'pointer', userSelect: 'none' }}
    >
      <title>좌클릭 드래그: 타이머 설정 · 우클릭 드래그: 위젯 이동</title>
      <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="#ffffff" stroke="#d8d8d8" strokeWidth={1} />
      {sweepDeg > 0 && (
        <path d={pieSlicePath(sweepDeg, RADIUS * 0.96)} fill="#e2231a" opacity={0.92} />
      )}
      {ticks.map(t => (
        <line
          key={t.key}
          x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
          stroke="#111111"
          strokeWidth={t.isHour ? 3 : 1.4}
          strokeLinecap="square"
        />
      ))}
      {/* 시침 */}
      <line x1={CENTER} y1={CENTER} x2={hourTip.x} y2={hourTip.y} stroke="#111111" strokeWidth={6} strokeLinecap="round" />
      {/* 분침 */}
      <line x1={CENTER} y1={CENTER} x2={minuteTip.x} y2={minuteTip.y} stroke="#111111" strokeWidth={4} strokeLinecap="round" />
      {/* 타이머 바늘(세컨드핸드 자리) — 파이 경계선과 같은 각도, 얇고 빨갛게 */}
      {sweepDeg > 0 && (
        <line x1={CENTER} y1={CENTER} x2={timerHandTip.x} y2={timerHandTip.y} stroke="#e2231a" strokeWidth={1.5} strokeLinecap="round" />
      )}
      <circle cx={CENTER} cy={CENTER} r={5} fill="#111111" />
      {remainingMs > 0 && (
        <text
          x={CENTER} y={CENTER + RADIUS * 0.45}
          textAnchor="middle"
          fontSize={15}
          fontWeight={700}
          fill="#e2231a"
          stroke="#ffffff"
          strokeWidth={3}
          paintOrder="stroke"
          style={{ pointerEvents: 'none' }}
        >{formatCountdown(remainingMs)}</text>
      )}
    </svg>
  );
}
