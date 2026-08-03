// src/components/PepeTransferDialog.tsx
// "QR로 전송" 모달 — 파일전송 패널/원격 파일트리에서 이미 고른 파일 하나를 화면의 애니메이션
// QR 스트림으로 내보낸다. UI 는 PePe 자체 디자인(cf-* 다이얼로그 스타일 재사용)이고, QR
// 인코딩/fountain 코드 로직만 decimen-optical-transfer(MIT, src/pepe-transfer/ 참고)에서
// 순수 로직 파일만 vendoring 했다 — 그쪽의 HTML/CSS/파일피커 UI 는 전혀 쓰지 않는다.
//
// 카메라로 받는 쪽은 이미 공개 호스팅된 https://decimen.app/receive/ 를 그대로 안내 QR 로
// 띄운다 — 광학 전송 자체는 화면→카메라만으로 끝나고 네트워크가 필요 없으므로, receive 페이지는
// 우리가 따로 만들거나 호스팅할 이유가 없다(사용자 확인 사항).
import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { packFile, packFrame, fnv1a, type FrameHeader, type PackedOpticalFile } from '../pepe-transfer/protocol';
import { LTEncoder } from '../pepe-transfer/fountain';
import { blockLength, fitsInOneStream, minimumFrameBytes, smallestSufficientFrameSize, sourceBlockCount, MAX_SOURCE_BLOCKS } from '../pepe-transfer/frame-capacity';
import { rasterizeQr } from '../pepe-transfer/qr-raster';
import { fitQrDisplaySize } from '../pepe-transfer/display';
import { TX_FPS_OPTIONS, FRAME_BYTES_OPTIONS, DEFAULT_TX_FPS, DEFAULT_FRAME_BYTES } from '../pepe-transfer/send-settings';

const api = (window as any).api || {};

const MARGIN = 4;
const LOOKAHEAD = 3;
const RECEIVE_URL = 'https://decimen.app/receive/';

type Props = {
  localPath: string;
  fileName: string;
  onClose: () => void;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const PepeTransferDialog: React.FC<Props> = ({ localPath, fileName, onClose }) => {
  const [phase, setPhase] = useState<'loading' | 'error' | 'streaming'>('loading');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('파일을 읽는 중...');
  const [txFps, setTxFps] = useState(DEFAULT_TX_FPS);
  const [frameBytes, setFrameBytes] = useState(DEFAULT_FRAME_BYTES);
  const [ecc, setEcc] = useState<'L' | 'M' | 'Q' | 'H'>('L');
  const [displayPx, setDisplayPx] = useState(360);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const receiveQrRef = useRef<HTMLCanvasElement | null>(null);
  const packedRef = useRef<PackedOpticalFile | null>(null);
  const generationRef = useRef(0);
  const originalSizeRef = useRef(0);

  // 받는 쪽 안내 QR — 정적이라 한 번만 그린다.
  useEffect(() => {
    if (!receiveQrRef.current) return;
    QRCode.toCanvas(receiveQrRef.current, RECEIVE_URL, { errorCorrectionLevel: 'M', margin: 2, width: 140 }).catch(() => {});
  }, []);

  // 파일 로드 + 패킹 — 마운트 시 한 번.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase('loading');
      setStatus(`${fileName} 불러오는 중...`);
      try {
        const r = await api.pepeTransferReadFile?.(localPath, fileName);
        if (!r?.success) throw new Error(r?.error || '파일을 읽지 못했습니다.');
        if (cancelled) return;
        const bytes = Uint8Array.from(atob(r.base64), c => c.charCodeAt(0));
        originalSizeRef.current = bytes.length;
        const packed = await packFile(fileName, r.mime, bytes);
        if (cancelled) return;
        packedRef.current = packed;
        setPhase('streaming');
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || String(e));
        setPhase('error');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localPath, fileName]);

  // QR 스트림 루프 — 설정(fps/bytes/ecc/크기)이 바뀌면 재시작.
  useEffect(() => {
    if (phase !== 'streaming' || !packedRef.current || !canvasRef.current) return;
    const gen = ++generationRef.current;
    const canvas = canvasRef.current;
    const packed = packedRef.current;

    const blockLen = blockLength(frameBytes);
    if (!fitsInOneStream(packed.container.length, frameBytes)) {
      const offered = [...FRAME_BYTES_OPTIONS];
      const suggestion = smallestSufficientFrameSize(packed.container.length, offered) ?? minimumFrameBytes(packed.container.length);
      setError(
        `${formatBytes(packed.container.length)} 는 ${frameBytes} bytes/frame 기준 ` +
        `${sourceBlockCount(packed.container.length, frameBytes).toLocaleString()} 블록이 필요한데, ` +
        `한 프레임은 최대 ${MAX_SOURCE_BLOCKS.toLocaleString()} 블록까지만 표현할 수 있습니다. ` +
        `bytes/frame 을 ${suggestion} 이상으로 올리세요.`,
      );
      setPhase('error');
      return;
    }

    const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
    const encoder = new LTEncoder(packed.container, blockLen, sessionId);
    const header: FrameHeader = {
      sessionId, seq: 0, k: encoder.k, blockLen,
      totalLen: packed.container.length,
      payloadFnv: fnv1a(packed.container),
    };

    let version: number | undefined;
    let modules = 0;
    let scale = 1;
    const staging = document.createElement('canvas');
    const queue: ImageData[] = [];
    let nextSeq = 0;

    const sizeCanvas = () => {
      const total = modules + 2 * MARGIN;
      const dpr = window.devicePixelRatio || 1;
      const containerWidth = stageWrapRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      const cssBudget = fitQrDisplaySize(window.innerWidth, window.innerHeight, containerWidth, displayPx, 0);
      scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
      staging.width = total; staging.height = total;
      canvas.width = total * scale; canvas.height = total * scale;
      canvas.style.width = `${(total * scale) / dpr}px`;
      canvas.style.height = `${(total * scale) / dpr}px`;
    };

    const makeFrame = (): ImageData => {
      const bytes = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
      nextSeq++;
      const qr = QRCode.create([{ data: bytes, mode: 'byte' } as any], { errorCorrectionLevel: ecc, version, maskPattern: 4 });
      if (version === undefined) {
        version = qr.version;
        modules = qr.modules.size;
        sizeCanvas();
        setStatus(
          `${txFps} FPS · ${frameBytes} bytes/frame · V${version} · ECC ${ecc} · ` +
          `${fileName} · ${formatBytes(originalSizeRef.current)} · K=${encoder.k}`,
        );
      }
      const raster = rasterizeQr(qr.modules.size, qr.modules.data, MARGIN);
      return new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size);
    };

    let generatorFailed = false;
    const pump = (max = LOOKAHEAD) => {
      if (generatorFailed || generationRef.current !== gen) return;
      try {
        for (let n = 0; n < max && queue.length < LOOKAHEAD; n++) queue.push(makeFrame());
      } catch (err: any) {
        generatorFailed = true;
        setError(err?.message || String(err));
        setPhase('error');
      }
    };
    pump();

    const interval = 1000 / txFps;
    let nextAt = performance.now();
    let rafId = 0;
    const tick = (now: number) => {
      if (generationRef.current !== gen || generatorFailed) return;
      rafId = requestAnimationFrame(tick);
      if (now < nextAt) return;
      const img = queue.shift();
      pump(1);
      if (!img) { nextAt = now + interval; return; }
      staging.getContext('2d')!.putImageData(img, 0, 0);
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
      nextAt += interval;
      if (now - nextAt > 3 * interval) nextAt = now + interval;
    };
    rafId = requestAnimationFrame(tick);

    const onResize = () => { if (version !== undefined) sizeCanvas(); };
    window.addEventListener('resize', onResize);
    return () => {
      generationRef.current++;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, txFps, frameBytes, ecc, displayPx]);

  const onKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };

  return (
    <div className="cf-backdrop">
      <div className="cf-dialog pepe-transfer-dialog" onKeyDown={onKeyDown} tabIndex={-1} style={{ minWidth: 480, maxWidth: 560 }}>
        <div className="cf-titlebar">
          <span className="cf-title">📶 QR로 전송 — pepe-transfer</span>
          <button className="cf-close" onClick={onClose} title="닫기">✕</button>
        </div>
        <div className="cf-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          {phase === 'error' && (
            <div style={{ color: '#e5534b', fontSize: 12, textAlign: 'center', maxWidth: 460 }}>✗ {error}</div>
          )}
          {phase !== 'error' && (
            <div style={{ fontSize: 11, color: 'var(--win-text-dim, #999)', textAlign: 'center', maxWidth: 460 }}>{status}</div>
          )}

          <div ref={stageWrapRef} style={{ background: '#fff', padding: 16, borderRadius: 8, minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {phase === 'loading' && <div style={{ color: '#333', fontSize: 12 }}>불러오는 중...</div>}
            <canvas ref={canvasRef} style={{ display: phase === 'streaming' ? 'block' : 'none', imageRendering: 'pixelated' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '8px 12px', border: '1px solid var(--win-border, #444)', borderRadius: 6 }}>
            <canvas ref={receiveQrRef} style={{ imageRendering: 'pixelated' }} />
            <div style={{ fontSize: 10.5, color: 'var(--win-text-dim, #888)', textAlign: 'center' }}>
              받는 폰에서 이 QR을 찍으면 <a href={RECEIVE_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--win-accent, #3a8bc5)' }}>decimen.app/receive</a> 가 열립니다
            </div>
          </div>

          <details style={{ width: '100%', fontSize: 12 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--win-text-dim, #bbb)' }}>전송 세부설정</summary>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                tx fps
                <select className="cf-select" value={txFps} onChange={e => setTxFps(Number(e.target.value))}>
                  {TX_FPS_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                bytes / frame
                <select className="cf-select" value={frameBytes} onChange={e => setFrameBytes(Number(e.target.value))}>
                  {FRAME_BYTES_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                error correction
                <select className="cf-select" value={ecc} onChange={e => setEcc(e.target.value as any)}>
                  <option value="L">L</option><option value="M">M</option><option value="Q">Q</option><option value="H">H</option>
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                display size ({displayPx}px)
                <input type="range" min={200} max={900} step={20} value={displayPx} onChange={e => setDisplayPx(Number(e.target.value))} />
              </label>
            </div>
          </details>
        </div>
        <div className="cf-actions">
          <button className="cf-btn" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
};
