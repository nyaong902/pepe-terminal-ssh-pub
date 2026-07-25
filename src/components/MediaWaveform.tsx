// src/components/MediaWaveform.tsx
// Audacity 스타일 파형 표시 + 구간 선택 UI. 실제 오디오 처리는 하지 않고
// AudioBuffer 를 <canvas> 에 그리고 마우스 드래그로 [start,end] 초 단위 선택 구간을
// 콜백으로 알려주는 순수 표시/입력 컴포넌트 — 편집 로직은 MediaEditPanel 이 담당한다.
import { useEffect, useRef, useState } from 'react';

export type Selection = { startSec: number; endSec: number } | null;

export function MediaWaveform({ buffer, position, selection, onSeek, onSelectionChange }: {
  buffer: AudioBuffer;
  position: number;
  selection: Selection;
  onSeek: (sec: number) => void;
  onSelectionChange: (sel: Selection) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const peaksRef = useRef<{ min: Float32Array; max: Float32Array } | null>(null);

  // 채널 0 기준으로 캔버스 폭만큼 min/max 피크를 미리 계산 — 매 렌더마다 전체 샘플을 훑지 않도록 캐싱.
  useEffect(() => {
    const width = containerRef.current?.clientWidth || 800;
    const data = buffer.getChannelData(0);
    const samplesPerPixel = Math.max(1, Math.floor(data.length / width));
    const min = new Float32Array(width);
    const max = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      let lo = 1, hi = -1;
      const start = x * samplesPerPixel;
      const end = Math.min(start + samplesPerPixel, data.length);
      for (let i = start; i < end; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[x] = lo === 1 ? 0 : lo;
      max[x] = hi === -1 ? 0 : hi;
    }
    peaksRef.current = { min, max };
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer]);

  // deps 없이 매 렌더마다 draw() 를 돌리면, 재생 중인 문서의 position 이 rAF 루프로 60fps
  // 갱신될 때마다 MediaWorkspace 전체가 리렌더되면서 "재생 중이 아닌" 다른 열린 문서의
  // 파형까지 전부 다시 그려지는 문제가 있었다(문서 개수만큼 배로 CPU/GPU 부담). position/
  // selection/buffer 가 실제로 바뀔 때만 다시 그리도록 제한.
  useEffect(() => { draw(); }, [position, selection, buffer]);

  const draw = () => {
    const canvas = canvasRef.current;
    const peaks = peaksRef.current;
    if (!canvas || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'var(--win-bg, #0d1117)';
    ctx.fillRect(0, 0, width, height);

    const mid = height / 2;
    const n = Math.min(peaks.min.length, width);
    ctx.strokeStyle = '#4a9eda';
    ctx.beginPath();
    for (let x = 0; x < n; x++) {
      const y1 = mid - peaks.max[x] * mid;
      const y2 = mid - peaks.min[x] * mid;
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y2);
    }
    ctx.stroke();

    if (selection) {
      const x1 = (selection.startSec / buffer.duration) * width;
      const x2 = (selection.endSec / buffer.duration) * width;
      ctx.fillStyle = 'rgba(74, 158, 218, 0.25)';
      ctx.fillRect(Math.min(x1, x2), 0, Math.abs(x2 - x1), height);
    }

    const px = (position / buffer.duration) * width;
    ctx.strokeStyle = '#e5534b';
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
    ctx.stroke();
  };

  const secAtClientX = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * buffer.duration;
  };

  return (
    <div ref={containerRef} style={{ width: '100%', height: 160, position: 'relative' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', cursor: 'text', display: 'block' }}
        onMouseDown={(e) => {
          const sec = secAtClientX(e.clientX);
          setDragStart(sec);
          onSelectionChange({ startSec: sec, endSec: sec });
        }}
        onMouseMove={(e) => {
          if (dragStart === null) return;
          const sec = secAtClientX(e.clientX);
          onSelectionChange({ startSec: Math.min(dragStart, sec), endSec: Math.max(dragStart, sec) });
        }}
        onMouseUp={(e) => {
          if (dragStart !== null && Math.abs(secAtClientX(e.clientX) - dragStart) < 0.05) {
            onSeek(dragStart);
            onSelectionChange(null);
          }
          setDragStart(null);
        }}
      />
    </div>
  );
}
