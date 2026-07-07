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
import './i18n'  // i18next 초기화 (side-effect import — App 렌더 전에 lng 셋팅)
import { initWindowTheme, applyWindowTheme } from './utils/windowThemes'
import { setWebglDisabledForTesting } from './components/TerminalPanel'

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
