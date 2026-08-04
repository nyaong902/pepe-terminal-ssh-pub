// src/utils/inputLineKill.ts
// 입력창에서 Ctrl+U — 커서 앞을 지운다. 셸(readline)의 unix-line-discard 와 같은 동작이다.
//
// 터미널에서는 Ctrl+U 를 누르면 입력한 줄이 사라지는데, 앱의 입력창(일괄전송 바, 검색창, 세션
// 편집기 등)에서는 안 되어 손이 헛돌았다. 그래서 모든 입력창에 같은 동작을 붙인다.
//
// 정확히는 "줄 전체"가 아니라 "커서 앞"을 지운다 — 셸이 그렇게 동작하고, 커서를 끝에 두고 쓰는
// 보통의 경우에는 결과가 같다. 커서 뒤 내용은 남으므로 중간에서 눌러도 뒤쪽을 잃지 않는다.
//
// 키는 옵션 > 단축키에서 바꿀 수 있다(액션 ID: inputKillLine, 기본 Ctrl+U).
import { matchKeybinding } from './keybindings';

// React 가 값 변경을 알아채게 하려면 네이티브 setter 로 값을 넣고 input 이벤트를 직접 쏴야 한다.
// el.value = ... 만 하면 React 의 상태와 어긋나 다음 렌더에서 되돌아간다.
function setValueReactSafe(el: HTMLInputElement | HTMLTextAreaElement, next: string, caret: number) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, next);
  else el.value = next;
  try { el.setSelectionRange(caret, caret); } catch {}
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// 지우면 안 되는 곳:
//  - 터미널(.xterm): Ctrl+U 를 셸로 그대로 보내야 한다. 여기서 가로채면 원래 기능이 죽는다.
//  - Monaco 편집기: 자체 Ctrl+U 바인딩(cursorUndo)이 있다.
function isExcluded(el: Element | null): boolean {
  if (!el) return true;
  return !!el.closest?.('.xterm, .monaco-editor');
}

function isEditableTarget(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    // 선택 위치를 다룰 수 있는 타입만 — number/checkbox 등은 setSelectionRange 가 예외를 던진다.
    const ok = ['text', 'search', 'url', 'tel', 'password', 'email', ''];
    return ok.includes(el.type) && !el.readOnly && !el.disabled;
  }
  return false;
}

export function installCtrlULineKill(): void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!matchKeybinding(e, 'inputKillLine')) return;
    const el = e.target;
    if (!isEditableTarget(el) || isExcluded(el)) return;

    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    // 선택 영역이 있으면 그것만 지운다(일반 편집기 관례). 없으면 커서 앞을 지운다.
    const from = start === end ? 0 : start;
    if (from === end) return;   // 커서가 맨 앞이면 지울 것이 없다

    e.preventDefault();
    e.stopPropagation();
    const v = el.value;
    setValueReactSafe(el, v.slice(0, from) + v.slice(end), from);
  };
  // capture 단계 — 입력창을 감싼 컴포넌트가 먼저 가로채 preventDefault 하는 경우가 있다.
  window.addEventListener('keydown', onKeyDown, true);
}
