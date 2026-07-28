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

// 몬데인 SBB 시계처럼 끝이 각진(rounded 아님) 막대 모양의 바늘 — 중심에서 tailLength 만큼
// 반대쪽으로도 짧게 나온 막대를 그린다(실제 SBB 바늘은 중심 축을 살짝 지나 짧은 꼬리가 있다).
function handRectPath(angleDeg: number, length: number, tailLength: number, width: number): string {
  const dir = polarToXY(angleDeg, 1);
  const dx = dir.x - CENTER, dy = dir.y - CENTER;
  const px = -dy, py = dx; // 바늘 방향에 수직인 단위벡터
  const hw = width / 2;
  const tipX = CENTER + dx * length, tipY = CENTER + dy * length;
  const tailX = CENTER - dx * tailLength, tailY = CENTER - dy * tailLength;
  const p1 = { x: tailX + px * hw, y: tailY + py * hw };
  const p2 = { x: tipX + px * hw, y: tipY + py * hw };
  const p3 = { x: tipX - px * hw, y: tipY - py * hw };
  const p4 = { x: tailX - px * hw, y: tailY - py * hw };
  return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} L ${p3.x} ${p3.y} L ${p4.x} ${p4.y} Z`;
}

// 눈금(시/분)도 몬데인 SBB 처럼 얇은 선이 아니라 두꺼운 막대로 — outerR~innerR 사이를 폭 width 로.
function tickRectPath(angleDeg: number, outerR: number, innerR: number, width: number): string {
  const dir = polarToXY(angleDeg, 1);
  const dx = dir.x - CENTER, dy = dir.y - CENTER;
  const px = -dy, py = dx;
  const hw = width / 2;
  const outerX = CENTER + dx * outerR, outerY = CENTER + dy * outerR;
  const innerX = CENTER + dx * innerR, innerY = CENTER + dy * innerR;
  const p1 = { x: innerX + px * hw, y: innerY + py * hw };
  const p2 = { x: outerX + px * hw, y: outerY + py * hw };
  const p3 = { x: outerX - px * hw, y: outerY - py * hw };
  const p4 = { x: innerX - px * hw, y: innerY - py * hw };
  return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} L ${p3.x} ${p3.y} L ${p4.x} ${p4.y} Z`;
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

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
  // 좌클릭 더블클릭으로 흑백 반전(검은 바탕에 흰 바늘 ↔ 흰 바탕에 검은 바늘) — localStorage 에
  // 저장해 위젯을 껐다 켜도 유지. 드래그(타이머 설정)와 겹치지 않도록 pointerUp 에서 클릭 간격만
  // 재서 처리(실제 dblclick 이벤트는 pointer capture 때문에 잘 안 잡혀서 직접 타이밍 비교).
  const [inverted, setInverted] = useState(() => {
    try { return localStorage.getItem('pepe-clock-widget-inverted') === '1'; } catch { return false; }
  });
  const lastClickRef = useRef(0);

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
    const commitNow = Date.now();
    const end = commitNow + ms;
    setEndTime(end);
    // now(state) 는 독립된 1초 setInterval 로만 갱신되므로, 커밋 순간과 마지막 tick 사이의
    // 어긋난 시간만큼(최대 ~1초) endTime-now 가 ms 보다 커져 "30:01" 처럼 한 틱 높게 표시되는
    // 문제가 있었다 — 커밋과 동시에 now 를 강제로 지금 시각에 맞춰 정확히 30:00 부터 시작하게 한다.
    setNow(new Date(commitNow));
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
  // BrowserWindow.setPosition 을 호출한다. 드래그 없이(거의 제자리에서) 뗀 우클릭만 더블클릭
  // 판정 대상으로 삼아 흑백 반전 토글 — 창 이동 드래그와 구분된다.
  const draggingWindowRef = useRef(false);
  const rightDownPointRef = useRef<{ x: number; y: number } | null>(null);
  const handleContextMenuDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 2) return;
    e.preventDefault();
    draggingWindowRef.current = true;
    rightDownPointRef.current = { x: e.screenX, y: e.screenY };
    try { (window as any).api?.windowStartDrag?.(e.screenX, e.screenY); } catch {}
    const onMove = (ev: MouseEvent) => {
      if (!draggingWindowRef.current) return;
      try { (window as any).api?.windowDragMove?.(ev.screenX, ev.screenY); } catch {}
    };
    const onUp = (ev: MouseEvent) => {
      draggingWindowRef.current = false;
      try { (window as any).api?.windowEndDrag?.(); } catch {}
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const down = rightDownPointRef.current;
      const isPlainClick = down != null
        && Math.abs(ev.screenX - down.x) < 4
        && Math.abs(ev.screenY - down.y) < 4;
      if (isPlainClick) {
        const nowMs = performance.now();
        if (nowMs - lastClickRef.current < 400) {
          setInverted(prev => {
            const next = !prev;
            try { localStorage.setItem('pepe-clock-widget-inverted', next ? '1' : '0'); } catch {}
            return next;
          });
          lastClickRef.current = 0;
        } else {
          lastClickRef.current = nowMs;
        }
      }
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

  // 시침이 3시(90도)~9시(270도) 사이(시계판 아래쪽 절반)를 향할 때는 기본 위치(중앙 아래)에
  // 날짜/시간을 표시하면 시침과 겹치므로, 그 구간에서는 중앙 위쪽으로 올려서 표시한다.
  const hourHandInLowerHalf = hourAngle >= 90 && hourAngle <= 270;
  const dateTimeYs = hourHandInLowerHalf
    ? { dateY: CENTER - RADIUS * 0.48, timeY: CENTER - RADIUS * 0.32 }
    : { dateY: CENTER + RADIUS * 0.32, timeY: CENTER + RADIUS * 0.48 };

  // 몬데인 SBB 사진 비율 — 분침은 시 눈금(RADIUS*0.8) 바로 아래까지 거의 닿을 정도로 길고,
  // 시침도 워치페이스 시 눈금 쪽에 가깝게 늘렸다(그래도 분침보다는 확연히 짧게 유지).
  const hourHandPath = handRectPath(hourAngle, RADIUS * 0.68, RADIUS * 0.12, 9);
  const minuteHandPath = handRectPath(minuteAngle, RADIUS * 0.94, RADIUS * 0.14, 6.5);
  const timerHandTip = polarToXY(sweepDeg, RADIUS * 0.9);

  // 눈금도 몬데인 SBB 처럼 두꺼운 막대 — 시 눈금(12/1/2...)은 굵고 길게, 분 눈금은 시 눈금 대비
  // 훨씬 짧지만 얇은 선보다는 살짝 두꺼운 막대로.
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const isHour = i % 5 === 0;
    const path = isHour
      ? tickRectPath(i * 6, RADIUS * 0.97, RADIUS * 0.8, 6.5)
      : tickRectPath(i * 6, RADIUS * 0.96, RADIUS * 0.9, 2.2);
    return { key: i, path };
  });

  // 좌클릭 더블클릭 시 흑백 반전 — 바탕/바늘/눈금 색만 서로 뒤바뀌고, 타이머(빨강) 관련 색은
  // 유지한다(어느 배경에서도 눈에 띄어야 하므로).
  const faceColor = inverted ? '#111111' : '#ffffff';
  const inkColor = inverted ? '#ffffff' : '#111111';
  const faceStroke = inverted ? '#3a3a3a' : '#d8d8d8';

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
      <title>좌클릭 드래그: 타이머 설정 · 우클릭 드래그: 위젯 이동 · 우클릭 더블클릭: 색 반전</title>
      <circle cx={CENTER} cy={CENTER} r={RADIUS} fill={faceColor} stroke={faceStroke} strokeWidth={1} />
      {sweepDeg > 0 && (
        <path d={pieSlicePath(sweepDeg, RADIUS * 0.96)} fill="#e2231a" opacity={0.92} />
      )}
      {ticks.map(t => (
        <path key={t.key} d={t.path} fill={inkColor} />
      ))}
      {/* 시침 — 몬데인 SBB 스타일: 끝이 각진 두꺼운 막대, 중심 반대편으로 짧은 꼬리 */}
      <path d={hourHandPath} fill={inkColor} />
      {/* 분침 — 안쪽 시 눈금 근처까지 닿는 긴 막대 */}
      <path d={minuteHandPath} fill={inkColor} />
      {/* 타이머 바늘(세컨드핸드 자리) — 파이 경계선과 같은 각도, 얇고 빨갛게, 끝에 둥근 팁 */}
      {sweepDeg > 0 && (
        <line x1={CENTER} y1={CENTER} x2={timerHandTip.x} y2={timerHandTip.y} stroke="#e2231a" strokeWidth={1.5} strokeLinecap="round" />
      )}
      <circle cx={CENTER} cy={CENTER} r={5} fill={inkColor} />
      {remainingMs > 0 ? (
        <text
          x={CENTER} y={hourHandInLowerHalf ? CENTER - RADIUS * 0.4 : CENTER + RADIUS * 0.45}
          textAnchor="middle"
          fontSize={15}
          fontWeight={700}
          fill="#e2231a"
          stroke={faceColor}
          strokeWidth={3}
          paintOrder="stroke"
          style={{ pointerEvents: 'none' }}
        >{formatCountdown(remainingMs)}</text>
      ) : (
        // 타이머가 동작하지 않을 때는 날짜(위) + 현재 시각(아래) 두 줄을 표시 — 잉크 색 글씨 +
        // 바탕색 테두리로, 타이머 표시(빨간 글씨)와 구분되면서도 위젯이 비어 보이지 않게 한다.
        // 시침이 3시~9시 사이(아래쪽 절반)에 있으면 기본 위치(중앙 아래)와 겹치므로 위쪽으로 올린다.
        <>
          <text
            x={CENTER} y={dateTimeYs.dateY}
            textAnchor="middle"
            fontSize={11}
            fontWeight={600}
            fill={inkColor}
            stroke={faceColor}
            strokeWidth={2.5}
            paintOrder="stroke"
            style={{ pointerEvents: 'none' }}
          >{formatDate(now)}</text>
          <text
            x={CENTER} y={dateTimeYs.timeY}
            textAnchor="middle"
            fontSize={15}
            fontWeight={700}
            fill={inkColor}
            stroke={faceColor}
            strokeWidth={3}
            paintOrder="stroke"
            style={{ pointerEvents: 'none' }}
          >{`${String(now.getHours()).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`}</text>
        </>
      )}
    </svg>
  );
}
