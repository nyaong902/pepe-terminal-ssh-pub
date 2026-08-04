// 플랫폼 감지 — 키 라벨 변환 및 단축키 일치 판정에 사용
// (functional matching 은 keyEventToCombo 에서 e.metaKey 도 Ctrl 로 취급하므로 이미 호환됨)
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

// 콤보 문자열(예: "Ctrl+Shift+F")을 현재 OS 의 표기로 변환
// macOS: Ctrl→⌘, Alt→⌥, Shift→⇧, Enter→↵, Tab→⇥, Backspace→⌫, Delete→⌦
// Windows/Linux: 그대로
export function formatKeyComboForOS(combo: string): string {
  if (!IS_MAC || !combo) return combo;
  const macMap: Record<string, string> = {
    'Ctrl': '⌘',
    'Cmd': '⌘',
    'Alt': '⌥',
    'Option': '⌥',
    'Shift': '⇧',
    'Enter': '↵',
    'Return': '↵',
    'Tab': '⇥',
    'Backspace': '⌫',
    'Delete': '⌦',
    'Escape': '⎋',
    'Up': '↑',
    'Down': '↓',
    'Left': '←',
    'Right': '→',
  };
  return combo.split('+').map(p => macMap[p] ?? p).join('');
}

// 일반 텍스트(예: 매뉴얼 본문) 내 단축키 표기를 OS 에 맞게 변환
// "Ctrl+Shift+F" 같이 단어 경계로 둘러싸인 콤보만 치환
export function formatKeyTextForOS(text: string): string {
  if (!IS_MAC || !text) return text;
  // Ctrl/Alt/Shift 등이 + 로 이어진 콤보 단위를 잡는다 (개별 단어가 아닌 콤보 전체)
  return text.replace(/\b(?:Ctrl|Cmd|Alt|Option|Shift)(?:\+(?:Ctrl|Cmd|Alt|Option|Shift|Enter|Return|Tab|Escape|Backspace|Delete|Space|Up|Down|Left|Right|F\d{1,2}|[A-Za-z0-9~`!@#$%^&*()\-_=\[\]\\;',./<>?:"{}|]))+/g, (m) => formatKeyComboForOS(m));
}

// Default keybindings map
export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  'fullscreen': 'Alt+Enter',
  // 입력창에서 커서 앞을 지운다 — 셸(readline)의 unix-line-discard 와 같은 동작.
  // 터미널에서는 이 키를 가로채지 않고 셸로 그대로 보낸다(utils/inputLineKill.ts).
  'inputKillLine': 'Ctrl+U',
  // 'V' 액션 ID = row 방향(좌/우 분할). 옵션 화면에서 가로 → 세로 순서로 노출되도록 V 를 먼저 둠.
  'splitSessionV': 'Alt+Shift+V',
  'splitSessionH': 'Alt+Shift+H',
  'switchWorkspace1': 'Ctrl+1',
  'switchWorkspace2': 'Ctrl+2',
  'switchWorkspace3': 'Ctrl+3',
  'switchWorkspace4': 'Ctrl+4',
  'switchWorkspace5': 'Ctrl+5',
  'switchWorkspace6': 'Ctrl+6',
  'switchWorkspace7': 'Ctrl+7',
  'switchWorkspace8': 'Ctrl+8',
  'switchWorkspace9': 'Ctrl+9',
  'switchWorkspace10': 'Ctrl+0',
  'openMessenger': 'Ctrl+M',
  'openAiChat': 'Ctrl+N',
  'openWorkLog': 'Ctrl+,',
  'openStickyNotes': 'Ctrl+.',
  'openFileTransfer': 'Ctrl+T',
  'closeWorkspace': 'Ctrl+F4',
  'nextTab': 'Ctrl+Tab',
  'prevTab': 'Ctrl+Shift+Tab',
  'cloneSplitV': 'Ctrl+Alt+V',
  'cloneSplitH': 'Ctrl+Alt+H',
  'commandPalette': 'Ctrl+W',
  'find': 'Ctrl+Shift+F',
  'clearScrollback': 'Ctrl+Shift+B',
  'clearScreen': 'Ctrl+Shift+L',
  'clearAll': 'Ctrl+Shift+A',
  'toggleFileTree': 'Ctrl+Shift+E',
  'copy': 'Ctrl+Shift+C',
  'paste': 'Ctrl+Shift+V',
  'selectAll': 'Ctrl+A',
  // 파일 비교 — hunk 이동/적용
  'diffPrevHunk': 'Alt+Up',
  'diffNextHunk': 'Alt+Down',
  'diffApplyLeft': 'Alt+Left',   // 타겟의 현재 hunk → 소스
  'diffApplyRight': 'Alt+Right', // 소스의 현재 hunk → 타겟
};

// Action labels for UI
export const KEYBINDING_LABELS: Record<string, string> = {
  'fullscreen': '전체화면 토글',
  'inputKillLine': '입력창에서 커서 앞 지우기',
  // 'V' 액션 ID = row 방향(좌/우 분할) = "가로 분할". 빈 패널 분할(local shell) 이므로 "빈세션"
  // 'H' 액션 ID = column 방향(상/하 분할) = "세로 분할"
  'splitSessionV': '빈세션 가로 분할 (좌/우)',
  'splitSessionH': '빈세션 세로 분할 (상/하)',
  'switchWorkspace1': '워크스페이스 1로 이동',
  'switchWorkspace2': '워크스페이스 2로 이동',
  'switchWorkspace3': '워크스페이스 3로 이동',
  'switchWorkspace4': '워크스페이스 4로 이동',
  'switchWorkspace5': '워크스페이스 5로 이동',
  'switchWorkspace6': '워크스페이스 6로 이동',
  'switchWorkspace7': '워크스페이스 7로 이동',
  'switchWorkspace8': '워크스페이스 8로 이동',
  'switchWorkspace9': '워크스페이스 9로 이동',
  'switchWorkspace10': '워크스페이스 10으로 이동',
  'openMessenger': '메신저 열기',
  'openAiChat': 'AI 채팅 열기',
  'openWorkLog': '작업일지 열기',
  'openStickyNotes': '스티커 메모 리스트 열기',
  'openFileTransfer': '파일전송 워크스페이스 열기',
  'closeWorkspace': '현재 워크스페이스 닫기',
  'nextTab': '다음 미니탭',
  'prevTab': '이전 미니탭',
  // 현재 활성 세션을 복제한 분할 — 그냥 "세션 ..." 으로 표기
  'cloneSplitV': '세션 가로 분할 (좌/우)',
  'cloneSplitH': '세션 세로 분할 (상/하)',
  'commandPalette': '커맨드 팔레트 (메뉴/워크스페이스 검색)',
  'find': '찾기',
  'clearScrollback': '스크롤백 지우기',
  'clearScreen': '화면 지우기',
  'clearAll': '전체 지우기',
  'toggleFileTree': '파일 트리 토글',
  'copy': '복사 (선택 → 클립보드)',
  'paste': '붙여넣기 (클립보드 → 터미널)',
  'selectAll': '전체 선택',
  'diffPrevHunk': '파일 비교: 이전 변경',
  'diffNextHunk': '파일 비교: 다음 변경',
  'diffApplyLeft': '파일 비교: 타겟 → 소스 적용',
  'diffApplyRight': '파일 비교: 소스 → 타겟 적용',
};

// Current keybindings (merged with defaults)
let currentKeybindings: Record<string, string> = { ...DEFAULT_KEYBINDINGS };

// 단축키 변경 중 플래그 (글로벌 핸들러/TerminalPanel에서 참조)
let isListeningMode = false;
export function setKeybindingListening(v: boolean) { isListeningMode = v; }
export function isKeybindingListening(): boolean { return isListeningMode; }

export function loadKeybindings(saved: Record<string, string> | undefined) {
  currentKeybindings = { ...DEFAULT_KEYBINDINGS, ...(saved || {}) };
}

export function getKeybindings(): Record<string, string> {
  return currentKeybindings;
}

export function getKeybinding(actionId: string): string {
  return currentKeybindings[actionId] || DEFAULT_KEYBINDINGS[actionId] || '';
}

// Convert KeyboardEvent to combo string like "Ctrl+Shift+F"
export function keyEventToCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  // Normalize key code to readable name — modifier 키 자체는 무시
  if (/^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(e.code)) {
    // modifier 키만 누른 상태 — 아직 조합 키가 아님
    return parts.join('+');
  }
  const key = normalizeKeyCode(e.code, e.key);
  if (key) parts.push(key);
  return parts.join('+');
}

function normalizeKeyCode(code: string, key: string): string {
  // Special keys
  if (code === 'Enter' || code === 'NumpadEnter') return 'Enter';
  if (code === 'Tab') return 'Tab';
  if (code === 'Escape') return 'Escape';
  if (code === 'Space') return 'Space';
  if (code === 'Backspace') return 'Backspace';
  if (code === 'Delete') return 'Delete';
  if (code === 'ArrowUp') return 'Up';
  if (code === 'ArrowDown') return 'Down';
  if (code === 'ArrowLeft') return 'Left';
  if (code === 'ArrowRight') return 'Right';
  if (code === 'Backslash') return '\\';
  // Letter keys
  if (code.startsWith('Key')) return code.slice(3);
  // Digit keys
  if (code.startsWith('Digit')) return code.slice(5);
  // F keys
  if (code.startsWith('F') && /^F\d+$/.test(code)) return code;
  return key || code;
}

// Check if a KeyboardEvent matches a combo string
export function matchKeybinding(e: KeyboardEvent, actionId: string): boolean {
  const combo = getKeybinding(actionId);
  if (!combo) return false;
  return keyEventToCombo(e) === combo;
}
