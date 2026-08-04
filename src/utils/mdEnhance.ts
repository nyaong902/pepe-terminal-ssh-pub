// src/utils/mdEnhance.ts
// 렌더된 마크다운(HTML)에 뒤늦게 얹는 기능들 — 코드 복사 버튼, 코드 색칠, mermaid 잡아 움직이기/확대.
//
// 파일 편집기의 마크다운 미리보기와 AI 채팅이 같은 동작을 써야 해서 여기로 모았다.
// 두 곳 모두 marked 로 만든 HTML 을 innerHTML 로 넣은 뒤, 그 DOM 을 찾아 손보는 방식이다.

// ── 아이콘 ──────────────────────────────────────────────────────────────────────
// 문자(✥, −, ⬜)를 쓰면 폰트에 따라 이모지로 대체돼 크기·색이 제멋대로다(마지막 버튼이 분홍
// 사각형으로 보이던 이유). currentColor 를 쓰는 SVG 로 두면 버튼 색(기본/hover/활성)을 따라간다.
const ICON_OPEN = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">';
/** 사방 화살표 — 잡아 움직이기 토글 */
export const ICON_PAN = ICON_OPEN + '<path d="M8 2v12M2 8h12"/><path d="M8 2 6.4 3.8M8 2l1.6 1.8M8 14l-1.6-1.8M8 14l1.6-1.8M2 8l1.8-1.6M2 8l1.8 1.6M14 8l-1.8-1.6M14 8l-1.8 1.6"/></svg>';
/** 돋보기 − */
export const ICON_ZOOM_OUT = ICON_OPEN + '<circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2 14 14M5.2 7h3.6"/></svg>';
/** 돋보기 + */
export const ICON_ZOOM_IN = ICON_OPEN + '<circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2 14 14M5.2 7h3.6M7 5.2v3.6"/></svg>';
/** 네 모서리 꺾쇠 — 원래 크기로 */
export const ICON_RESET = ICON_OPEN + '<path d="M2 5.6V2h3.6M14 5.6V2h-3.6M2 10.4V14h3.6M14 10.4V14h-3.6"/></svg>';

export type PanZoomLabels = { pan: string; zoomIn: string; zoomOut: string; reset: string };

// 색칠 전 원본 코드를 기억한다. colorize 뒤에는 줄 구분이 <br/> 로 바뀌어 textContent 에서
// 개행이 사라지므로, 복사 버튼이 이 값을 써야 여러 줄 코드가 한 줄로 붙지 않는다.
const codeSrc = new WeakMap<HTMLElement, string>();

/**
 * 코드블록마다 복사 버튼을 붙인다(마우스를 올릴 때만 보이게 CSS 에서 처리).
 * mermaid 블록은 SVG 로 교체되므로 건너뛴다.
 */
export function attachCodeCopyButtons(
  root: HTMLElement,
  labels: { copy: string; copied: string },
  isCancelled?: () => boolean,
): void {
  for (const pre of Array.from(root.querySelectorAll<HTMLElement>('pre'))) {
    if (isCancelled?.()) return;
    if (pre.getAttribute('data-copy-done')) continue;
    const codeEl = pre.querySelector<HTMLElement>('code');
    if (!codeEl || codeEl.classList.contains('language-mermaid')) continue;
    pre.setAttribute('data-copy-done', '1');
    pre.classList.add('has-copy');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'md-code-copy';
    btn.textContent = labels.copy;
    btn.title = labels.copy;
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const text = codeSrc.get(codeEl) ?? (codeEl.textContent || '');
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = labels.copied;
        btn.classList.add('done');
        setTimeout(() => { btn.textContent = labels.copy; btn.classList.remove('done'); }, 1200);
      }).catch(() => {});
    });
    pre.appendChild(btn);
  }
}

// monaco 는 무겁다(약 5MB 파싱). 색칠이 실제로 필요할 때만 불러오고, 한 번만 로드한다.
// 편집기가 이미 열려 있으면 같은 청크를 공유하므로 추가 비용이 없다.
let monacoPromise: Promise<any> | null = null;
function loadMonaco(): Promise<any> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      // 로더 설정(CDN 차단 환경 대응)을 먼저 끝낸다 — 편집기 경로와 같은 설정을 쓴다.
      try { (await import('./monacoSetup')).setupLocalMonaco(); } catch {}
      const m = await import('monaco-editor');
      // colorize 는 "현재 활성 테마" 를 쓴다. 새로 불러온 monaco 는 기본값이 vs(밝은 테마)라서
      // 일반 식별자·연산자가 거의 검정으로 나와 어두운 배경에서 글자가 안 보였다(키워드만 보였다).
      // 앱의 편집기들은 모두 vs-dark 를 쓰므로 여기서도 맞춘다.
      try { m.editor.setTheme('vs-dark'); } catch {}
      return m;
    })();
  }
  return monacoPromise;
}

/**
 * 코드블록을 monaco 의 colorize 로 색칠한다 — 편집기와 색이 같고 새 하이라이터가 필요 없다.
 * monacoOverride 를 주면 그것을 쓴다(편집기 화면처럼 이미 로드된 인스턴스가 있을 때).
 * 언어를 알아볼 수 없으면 평문으로 남긴다.
 */
export async function highlightCodeBlocks(
  root: HTMLElement,
  monacoOverride?: any,
  isCancelled?: () => boolean,
): Promise<void> {
  const targets = Array.from(root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]'))
    .filter(el => !el.classList.contains('language-mermaid') && !el.getAttribute('data-hl-done'));
  if (targets.length === 0) return;

  const monaco = monacoOverride ?? await loadMonaco().catch(() => null);
  if (!monaco?.editor?.colorize) return;
  if (isCancelled?.()) return;

  const langs = new Set<string>(
    (monaco.languages?.getLanguages?.() || [])
      .flatMap((l: any) => [l.id, ...(l.aliases || [])])
      .filter(Boolean)
      .map((x: string) => String(x).toLowerCase()),
  );

  for (const el of targets) {
    if (isCancelled?.()) return;
    const cls = Array.from(el.classList).find(c => c.startsWith('language-')) || '';
    const lang = cls.slice('language-'.length).toLowerCase();
    if (!lang || !langs.has(lang)) continue;
    el.setAttribute('data-hl-done', '1');
    const src = el.textContent || '';
    codeSrc.set(el, src);   // 복사 버튼이 쓸 원본 (colorize 뒤에는 개행이 사라진다)
    try {
      const html = await monaco.editor.colorize(src, lang, { tabSize: 2 });
      if (isCancelled?.()) return;
      el.innerHTML = html;
      el.classList.add('hl');
    } catch {
      // 색칠 실패는 무시 — 평문으로 보이면 된다.
    }
  }
}

/**
 * mermaid SVG 에 잡아 움직이기 / 확대·축소 / 원래 크기로 를 붙인다(VS Code 미리보기와 같은 조작).
 * SVG 를 감싼 안쪽 div 에 transform 을 걸어 옮기고 키운다 — SVG 자체를 건드리지 않으므로
 * 다이어그램이 다시 그려져도 상태가 섞이지 않는다.
 *
 * content 는 SVG 문자열이거나 이미 만들어둔 요소다. AI 채팅은 SVG 를 담은 div 를 복사/저장
 * 기능에서 계속 참조하므로 그 요소를 그대로 넘긴다.
 * existingToolbar 를 주면 그 툴바에 버튼을 덧붙인다(AI 채팅처럼 이미 툴바가 있는 경우).
 * 반환값은 전역 리스너 정리 함수다.
 */
export function attachMermaidPanZoom(
  wrap: HTMLElement,
  content: string | HTMLElement,
  labels: PanZoomLabels,
  existingToolbar?: HTMLElement,
): () => void {
  const viewport = document.createElement('div');
  viewport.className = 'md-mermaid-viewport';
  const inner = document.createElement('div');
  inner.className = 'md-mermaid-inner';
  if (typeof content === 'string') inner.innerHTML = content;
  else inner.appendChild(content);
  viewport.appendChild(inner);

  let scale = 1, tx = 0, ty = 0, panMode = false;
  const MIN = 0.2, MAX = 8;
  // 처음에 전체가 보이도록 줄이는 배율. 다이어그램이 뷰포트보다 크면 1보다 작아진다.
  // 이 값을 기억해서 "원래 크기로" 버튼도 여기로 돌아가게 한다 — 1 로 돌리면 다시 잘려 보인다.
  let fitScale = 1;
  const apply = () => { inner.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };
  // 뷰포트 중심을 기준으로 키운다 — 버튼으로 확대할 때 보고 있던 부분이 화면 밖으로 나가지 않게.
  const zoomBy = (factor: number) => {
    const next = Math.min(MAX, Math.max(MIN, scale * factor));
    const r = next / scale;
    const rect = viewport.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    tx = cx - (cx - tx) * r;
    ty = cy - (cy - ty) * r;
    scale = next;
    apply();
  };

  const toolbar = existingToolbar ?? document.createElement('div');
  if (!existingToolbar) toolbar.className = 'md-mermaid-toolbar';
  const mk = (iconSvg: string, title: string, onClick: (btn: HTMLButtonElement) => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'md-mermaid-btn';
    b.innerHTML = iconSvg;
    b.title = title;
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(b); });
    toolbar.appendChild(b);
    return b;
  };
  mk(ICON_PAN, labels.pan, (b) => {
    panMode = !panMode;
    b.classList.toggle('on', panMode);
    viewport.classList.toggle('pan', panMode);
  });
  mk(ICON_ZOOM_OUT, labels.zoomOut, () => zoomBy(1 / 1.25));
  mk(ICON_ZOOM_IN, labels.zoomIn, () => zoomBy(1.25));
  mk(ICON_RESET, labels.reset, () => { scale = fitScale; tx = 0; ty = 0; apply(); });

  // 잡아 움직이기 — 모드가 켜져 있을 때만. 가운데 버튼 드래그는 모드와 무관하게 허용한다.
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  viewport.addEventListener('mousedown', (e) => {
    if (!panMode && e.button !== 1) return;
    e.preventDefault();
    dragging = true; sx = e.clientX; sy = e.clientY; ox = tx; oy = ty;
    viewport.classList.add('dragging');
  });
  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    tx = ox + (e.clientX - sx);
    ty = oy + (e.clientY - sy);
    apply();
  };
  const onUp = () => { dragging = false; viewport.classList.remove('dragging'); };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  // Ctrl+휠 로 커서 위치를 기준으로 확대·축소. 일반 휠은 스크롤로 넘긴다.
  viewport.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const next = Math.min(MAX, Math.max(MIN, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const r = next / scale;
    tx = px - (px - tx) * r;
    ty = py - (py - ty) * r;
    scale = next;
    apply();
  }, { passive: false });

  if (!existingToolbar) wrap.appendChild(toolbar);
  wrap.appendChild(viewport);
  apply();
  // 레이아웃이 잡힌 뒤에 크기를 재서 맞춤 배율을 정한다. transform 은 레이아웃 크기를 바꾸지
  // 않으므로 scrollWidth/Height 가 다이어그램의 실제 크기다.
  const fitToViewport = () => {
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    const cw = inner.scrollWidth, ch = inner.scrollHeight;
    if (vw > 0 && vh > 0 && cw > 0 && ch > 0) {
      fitScale = Math.max(MIN, Math.min(1, vw / cw, vh / ch));
      scale = fitScale; tx = 0; ty = 0;
      apply();
    }
  };
  requestAnimationFrame(fitToViewport);
  return () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
}
