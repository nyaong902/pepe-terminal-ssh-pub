import React from 'react'
import ReactDOM from 'react-dom/client'
// ⚠ CSS 임포트 순서 중요: xterm.css → index.css → App.css 순서로 들어가야 우리 커스텀 스타일이
// 라이브러리 기본 스타일을 덮어쓴다. dev 모드에선 동적 import 로 자연스럽게 그 순서지만, 빌드는
// 의존성 정적 분석 결과 xterm.css 가 가장 마지막에 들어가 커스텀이 덮이는 문제 발생 → main 에서 강제.
import 'xterm/css/xterm.css'
import './index.css'
import App from './App'
import SessionEditorPopout from './SessionEditorPopout'
import './i18n'  // i18next 초기화 (side-effect import — App 렌더 전에 lng 셋팅)
import { initWindowTheme, applyWindowTheme } from './utils/windowThemes'

// 저장된 윈도우(앱 chrome) 테마를 렌더 전에 적용 — 깜빡임 방지. popout 창에도 동일 적용.
initWindowTheme();
// 다른 창에서 테마가 바뀌면 이 창에도 즉시 반영 (재저장·재브로드캐스트 없이 적용만).
try { (window as any).api?.onWindowTheme?.((id: string) => applyWindowTheme(id, false)); } catch {}

const params = new URLSearchParams(window.location.search);
const popout = params.get('popout');

// popout=options 모드는 표시 — App 렌더 + auto open Options
if (popout === 'options') {
  (window as any).__popoutMode = 'options';
  document.body.classList.add('popout-options');
}
if (popout === 'session-editor') {
  document.body.classList.add('popout-session-editor');
  document.documentElement.style.background = '#1a1a1a';
  document.documentElement.style.margin = '0';
  document.documentElement.style.padding = '0';
  document.body.style.background = '#1a1a1a';
  document.body.style.margin = '0';
  document.body.style.padding = '0';
  document.body.style.border = 'none';
  document.body.style.outline = 'none';
}

let root: React.ReactNode;
if (popout === 'session-editor') {
  root = <SessionEditorPopout sessionId={params.get('sessionId') || 'new'} />;
} else {
  root = <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{root}</React.StrictMode>
);
