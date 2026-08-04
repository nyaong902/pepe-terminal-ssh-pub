// src/utils/terminalSettings.ts

// 마우스 단추 동작 — 'none'(아무것도 안 함) / 'menu'(팝업 메뉴) / 'paste'(클립보드 붙여넣기)
// 'properties'(옵션 대화상자) / 'enter'(캐리지 리턴 전송) / 'paste-selection'(선택 텍스트 붙여넣기)
export type MouseButtonAction = 'none' | 'menu' | 'paste' | 'properties' | 'enter' | 'paste-selection';

export type TerminalSettings = {
  autoCopyOnSelect: boolean;
  includeTrailingNewline: boolean;
  trimTrailingWhitespace: boolean;
  multiLinePaste: 'dialog' | 'direct';
  // 여러 줄 붙여넣기 창이 떠 있을 때 다시 붙여넣으면: true=기존 내용에 누적, false=새 내용으로 교체
  multiLinePasteAccumulate: boolean;
  // 마우스 버튼 동작
  rightClickAction: MouseButtonAction;   // 오른쪽 단추
  middleClickAction: MouseButtonAction;  // 가운데 단추
  scrollback: number;
  aiAgent: 'claude' | 'gemini' | 'codex';
  // 텍스트 편집기 — 터미널 우클릭 > 텍스트 편집기로(선택 영역/전체/현재 화면) 에서 쓴다.
  // XShell 의 같은 기능과 설정 항목을 맞추고, 앱 내장 편집기 선택지를 더했다.
  //  - internal: 앱 안에서 Monaco 로 띄운다(임시 파일을 만들지 않는다). 기본값.
  //  - default:  임시 파일로 저장하고 OS 기본 연결 프로그램(보통 메모장)으로 연다.
  //  - custom:   임시 파일로 저장하고 지정한 편집기로 연다.
  textEditorTarget: 'internal' | 'default' | 'custom';
  textEditorPath: string;         // custom 일 때 편집기 실행 파일 경로
  textEditorArgs: string;         // 명령줄 옵션. %FILEPATH 가 임시 파일 경로로 치환된다
  textEditorName: string;         // 설정 화면에 보일 이름(표시용)
};

const DEFAULTS: TerminalSettings = {
  autoCopyOnSelect: true,
  includeTrailingNewline: false,
  trimTrailingWhitespace: true,
  multiLinePaste: 'dialog',
  multiLinePasteAccumulate: false,
  rightClickAction: 'menu',
  middleClickAction: 'none',
  scrollback: 5000,
  textEditorTarget: 'internal',
  textEditorPath: '',
  textEditorArgs: '%FILEPATH',
  textEditorName: '',
  aiAgent: 'claude',
};

let cached: TerminalSettings | null = null;

export function getTerminalSettings(): TerminalSettings {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem('terminalSettings');
    if (raw) { cached = { ...DEFAULTS, ...JSON.parse(raw) }; return cached!; }
  } catch {}
  cached = { ...DEFAULTS };
  return cached;
}

export function saveTerminalSettings(s: TerminalSettings) {
  cached = { ...s };
  localStorage.setItem('terminalSettings', JSON.stringify(s));
}
