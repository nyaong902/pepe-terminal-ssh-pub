// 윈도우(앱 chrome) 테마 — 터미널 테마와 별개로 프로그램 전반의 색상을 바꾼다.
// App.css/index.css 의 주요 배경/표면/보더/액센트/텍스트 색이 var(--win-*, #원본) 형태로 치환돼 있어,
// 아래 토큰을 documentElement 에 주입하면 터미널(xterm)을 제외한 전 영역의 색이 함께 바뀐다.
// (토큰 미설정 시 fallback = 기존색 → 기본 테마는 무변경)
//
// 팔레트는 colorhunt.co 스타일 조합 참고. 밝은 테마는 text/textDim 을 어둡게 주어 가독성 확보.

export type WindowTheme = {
  id: string;
  name: string;
  light?: boolean;
  bg: string;        // 가장 어두운 배경 (앱 본문/사이드바)
  surface: string;   // 패널/카드/탭바 표면
  surface2: string;  // 호버/입력/elevated
  border: string;    // 경계선
  accent: string;    // 버튼/링크/하이라이트
  text?: string;     // 본문 텍스트 (미지정 시 원본 유지 — 기본 테마용)
  textDim?: string;  // 보조 텍스트
};

// 액센트 hue 가 서로 겹치지 않도록 구성: 중립·파랑·청록·초록·보라·자홍·주황·황갈 + 밝은 2종.
export const WINDOW_THEMES: WindowTheme[] = [
  // 기본 — text/textDim 미지정 → 원본 텍스트색 그대로(무변경). 중립 다크.
  { id: 'default',     name: 'Dark (기본)',   bg: '#0d0f10', surface: '#1a1a1a', surface2: '#2a2a3e', border: '#2a3548', accent: '#2b6b9b' },
  { id: 'cyber',       name: 'Cyber Blue',    bg: '#0d1117', surface: '#161b22', surface2: '#21262d', border: '#30363d', accent: '#58a6ff', text: '#e6edf3', textDim: '#9aa7b3' }, // 파랑
  { id: 'deepTeal',    name: 'Deep Teal',     bg: '#06202a', surface: '#0b3a47', surface2: '#16555e', border: '#16555e', accent: '#2cc2b0', text: '#e6f3f1', textDim: '#9fc0bb' }, // 청록
  { id: 'emerald',     name: 'Emerald',       bg: '#08231d', surface: '#0f3a30', surface2: '#1a5544', border: '#1a5544', accent: '#3ddc84', text: '#e4f5ec', textDim: '#9fc8b4' }, // 초록
  { id: 'royalPurple', name: 'Royal Purple',  bg: '#1a1423', surface: '#2b1c3a', surface2: '#3f2a54', border: '#3f2a54', accent: '#9d6ff0', text: '#ece4f7', textDim: '#b3a3c8' }, // 보라
  { id: 'wine',        name: 'Wine',          bg: '#2a1218', surface: '#3a1c25', surface2: '#532935', border: '#532935', accent: '#e06a7e', text: '#f3e3e6', textDim: '#c8a3ab' }, // 자홍/와인
  { id: 'sunset',      name: 'Sunset',        bg: '#1b1320', surface: '#2a1b2e', surface2: '#43263f', border: '#43263f', accent: '#ff7e67', text: '#f3e6ef', textDim: '#c8a3bd' }, // 주황
  { id: 'coffee',      name: 'Coffee',        bg: '#211a14', surface: '#2e251c', surface2: '#43362a', border: '#43362a', accent: '#c89b6a', text: '#f1e9df', textDim: '#c2b09a' }, // 황갈
  // 밝은 테마 — 텍스트/아이콘을 어둡게 대비 (가독성)
  { id: 'solarizedLight', name: 'Solarized Light', light: true, bg: '#fdf6e3', surface: '#fbf3dd', surface2: '#eee8d5', border: '#ddd6c1', accent: '#b58900', text: '#073642', textDim: '#657b83' }, // 따뜻한 베이지
  { id: 'paper',          name: 'Paper',           light: true, bg: '#eceff4', surface: '#f7f9fc', surface2: '#e2e6ee', border: '#cdd3de', accent: '#5e81ac', text: '#2e3440', textDim: '#5a6473' }, // 차가운 회청
];

const STORAGE_KEY = 'app:windowTheme';
const DEFAULT_ID = 'default';

export function getWindowThemeList(): WindowTheme[] {
  return WINDOW_THEMES;
}

export function getCurrentWindowThemeId(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && WINDOW_THEMES.some(t => t.id === saved)) return saved;
  } catch {}
  return DEFAULT_ID;
}

export function applyWindowTheme(id: string, persist = true): void {
  const theme = WINDOW_THEMES.find(t => t.id === id) || WINDOW_THEMES[0];
  try {
    const root = document.documentElement;
    const s = root.style;
    s.setProperty('--win-bg', theme.bg);
    s.setProperty('--win-surface', theme.surface);
    s.setProperty('--win-surface-2', theme.surface2);
    s.setProperty('--win-border', theme.border);
    s.setProperty('--win-accent', theme.accent);
    // text/textDim — 지정 시 적용, 미지정(기본 테마)이면 제거해 원본 텍스트색 유지
    if (theme.text) s.setProperty('--win-text', theme.text); else s.removeProperty('--win-text');
    if (theme.textDim) s.setProperty('--win-text-dim', theme.textDim); else s.removeProperty('--win-text-dim');
    root.setAttribute('data-window-theme', theme.id);
    root.classList.toggle('win-theme-light', !!theme.light);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, theme.id); } catch {}
      // 저장 + 모든 창(팝아웃/분리 포함)에 라이브 반영 (main 에서 broadcast)
      try { (window as any).api?.setWindowTheme?.(theme.id); } catch {}
    }
  } catch {}
}

/** 앱 시작 시 저장된 윈도우 테마 적용. */
export function initWindowTheme(): void {
  applyWindowTheme(getCurrentWindowThemeId(), false);
}
