import React from 'react'
import ReactDOM from 'react-dom/client'
// ⚠ CSS 임포트 순서 중요: xterm.css → index.css → App.css 순서로 들어가야 우리 커스텀 스타일이
// 라이브러리 기본 스타일을 덮어쓴다. dev 모드에선 동적 import 로 자연스럽게 그 순서지만, 빌드는
// 의존성 정적 분석 결과 xterm.css 가 가장 마지막에 들어가 커스텀이 덮이는 문제 발생 → main 에서 강제.
import 'xterm/css/xterm.css'
import './index.css'
import App from './App'
import SessionEditorPopout from './SessionEditorPopout'
import TabApp from './components/TabApp'
import PanelHost from './components/PanelHost'
import StickyNotePopout from './components/StickyNotePopout'
import ClockWidget from './components/ClockWidget'
import './i18n'  // i18next 초기화 (side-effect import — App 렌더 전에 lng 셋팅)
import { initWindowTheme, applyWindowTheme } from './utils/windowThemes'
import { setWebglDisabledForTesting } from './components/TerminalPanel'
import { initScrollbarHoverTracking } from './utils/scrollbarHover'

// Windows 터미널 스타일 스크롤바(마우스가 스크롤바 픽셀 영역에 있을 때만 확장) 추적 시작 —
// 이 파일은 host/tab/panel/popout 등 모든 렌더러 진입점에서 로드되므로 한 번만 등록해도 전체
// 앱에 적용된다.
initScrollbarHoverTracking();

// 개발용 진단 스위치 — 이 프로세스(호스트/탭/패널 어느 쪽이든) 안에서 앞으로 마운트되는 xterm 의
// WebGL 렌더러를 끄고 DOM 렌더러로 비교 테스트할 때 devtools 콘솔에서 호출.
(window as any).__pepeSetWebglDisabled = setWebglDisabledForTesting;

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
if (window.location.hash.includes('panel-app')) {
  // 패널 단위 프로세스 분리 진입점 — '#panel-app?tabId=X&nodeId=Y&panel=<json>'
  const hashQuery = window.location.hash.split('?')[1] || '';
  const q = new URLSearchParams(hashQuery);
  const tabId = q.get('tabId') || '';
  const nodeId = q.get('nodeId') || '';
  let initialPanel: any = { id: nodeId, sessions: [], activeIdx: 0 };
  try { initialPanel = JSON.parse(q.get('panel') || ''); } catch {}
  root = <PanelHost tabId={tabId} nodeId={nodeId} initialPanel={initialPanel} />;
} else if (window.location.hash.includes('tab-app')) {
  // 실제 탭별 프로세스 분리 진입점 — '#tab-app?tabId=X' (electron/main.ts 의 tab:create-view 가 로드)
  const hashQuery = window.location.hash.split('?')[1] || '';
  const tabId = new URLSearchParams(hashQuery).get('tabId') || '';
  root = <TabApp tabId={tabId} />;
} else if (window.location.hash.includes('sticky-note')) {
  // 포스트잇 독립 창 진입점 — '#sticky-note?id=X' (electron/main.ts 의 createStickyNoteWindow 가 로드)
  const hashQuery = window.location.hash.split('?')[1] || '';
  const noteId = new URLSearchParams(hashQuery).get('id') || '';
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  document.body.style.margin = '0';
  document.body.style.padding = '0';
  root = <StickyNotePopout noteId={noteId} />;
} else if (window.location.hash.includes('clock-widget')) {
  // 시계 위젯 독립 창 진입점 — '#clock-widget' (electron/main.ts 의 createClockWidgetWindow 가 로드)
  // index.css 의 전역 `body { min-height: 100vh }` 가 이 작은(220x220) 창에도 적용되면 body 가
  // 창보다 훨씬 커져 스크롤이 생기고 시계가 왼쪽 위 구석에 작게 표시되는 문제가 있었다 —
  // 이 창에서만 명시적으로 크기를 창 크기에 고정하고 오버플로를 막는다.
  document.documentElement.style.background = 'transparent';
  document.documentElement.style.width = '100%';
  document.documentElement.style.height = '100%';
  document.documentElement.style.overflow = 'hidden';
  document.body.classList.add('clock-widget-window');
  document.body.style.background = 'transparent';
  document.body.style.margin = '0';
  document.body.style.padding = '0';
  document.body.style.width = '100%';
  document.body.style.height = '100%';
  document.body.style.minHeight = '0';
  document.body.style.minWidth = '0';
  document.body.style.overflow = 'hidden';
  root = <ClockWidget />;
} else if (window.location.hash.includes('tab-poc')) {
  // 개발용 PoC — 실제 WebContentsView 가 이 frameless/transparent 창 위에서 정상
  // 렌더링/IPC 되는지만 확인하는 임시 경로. 실제 앱 UI 와는 무관.
  function TabPocProbe() {
    const [log, setLog] = React.useState<string[]>([]);
    const append = (s: string) => setLog(prev => [...prev, s]);
    React.useEffect(() => {
      append('mounted in ' + (window.location.hash));
      const off = (window as any).api?.onTermStateUpdate?.((p: any) => append('state-update: ' + JSON.stringify(p)));
      return () => { try { off?.(); } catch {} };
    }, []);
    return (
      <div style={{ background: '#1e1e2e', color: '#a6e3a1', width: '100%', height: '100%', padding: 12, fontFamily: 'monospace', fontSize: 12, overflow: 'auto' }}>
        <div>tab-poc WebContentsView probe</div>
        <button onClick={() => { (window as any).api?.termRegisterTerm?.('poc-term-1', 'tab-poc'); append('registered poc-term-1'); }}>register</button>
        <button onClick={() => { (window as any).api?.termCall?.('poc-term-1', 'focusTerm', []); append('sent term:call focusTerm'); }}>call focusTerm</button>
        <button onClick={async () => { const r = await (window as any).api?.termInvoke?.('poc-term-1', 'searchInTerm', ['x']); append('invoke result: ' + JSON.stringify(r)); }}>invoke searchInTerm</button>
        <pre>{log.join('\n')}</pre>
      </div>
    );
  }
  root = <TabPocProbe />;
} else if (popout === 'session-editor') {
  root = <SessionEditorPopout sessionId={params.get('sessionId') || 'new'} />;
} else {
  root = <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{root}</React.StrictMode>
);
