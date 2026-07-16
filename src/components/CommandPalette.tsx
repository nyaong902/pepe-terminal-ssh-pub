// src/components/CommandPalette.tsx
// 전역 커맨드 팔레트 — macOS Spotlight 스타일. Ctrl+W 로 화면 중앙에 검색창 하나만 띄우고,
// 메뉴/워크스페이스 등을 검색해서 방향키+Enter 로 바로 실행한다.
import React, { useEffect, useMemo, useRef, useState } from 'react';

export type CommandItem = {
  id: string;
  label: string;
  icon?: string;
  hint?: string;
  keywords?: string[];
  run: () => void;
};

type Props = {
  commands: CommandItem[];
  onClose: () => void;
  // 검색어가 비어 있을 때(전체 목록 표시 중)만 항목을 마우스로 위/아래 드래그해 순서를 바꿀 수 있다.
  // 드롭 시 새 순서의 id 배열을 전달 — 호출 측에서 영속화(UIPrefs 등)는 알아서 처리.
  onReorder?: (ids: string[]) => void;
};

export const CommandPalette: React.FC<Props> = ({ commands, onClose, onReorder }) => {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 드래그 중엔 부모 commands 순서와 별개로 로컬에서 즉시 재배열해 보여준다 — 드롭 시에만 onReorder 로 커밋.
  const [dragOrder, setDragOrder] = useState<CommandItem[] | null>(null);
  const dragState = useRef<{ fromIdx: number; itemId: string } | null>(null);
  // 드래그 중인지 여부(동기 플래그) — onMouseEnter 가 activeIdx 를 건드리지 못하게 막는 데 사용.
  // 드래그 중 마우스가 재정렬된 행 위를 지나가면 onMouseEnter 가 발동해 activeIdx 를 드래그 계산과
  // 다른 값으로 덮어써서, 빠르게 움직일 때 위로는 안 끌리고 아래로만 끌리는 것처럼 보이는 원인이었다.
  const isDraggingRef = useRef(false);
  // mouseup 이 click 보다 먼저 발생하므로, onUp 에서 dragState 를 바로 지우면 이어지는 click 에서
  // "방금 드래그했는지" 를 알 수 없다 — click 이 끝난 뒤(다음 tick)에 지우는 별도 플래그로 구분.
  const justDraggedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = (!q && dragOrder) ? dragOrder : commands;
    if (!q) return base;
    return base.filter(c => {
      if (c.label.toLowerCase().includes(q)) return true;
      return !!c.keywords?.some(k => k.toLowerCase().includes(q));
    });
  }, [commands, query, dragOrder]);

  // 드롭 후 부모가 내려준 commands 순서가 드래그 결과와 일치하면(재배열이 실제로 반영됨) 그제서야
  // 로컬 dragOrder 오버라이드를 해제 — 그 전에 지우면 아직 옛 순서인 commands 로 한 프레임
  // 되돌아가 보인다("놓으면 원래대로 돌아감"으로 체감됨).
  useEffect(() => {
    if (!dragOrder) return;
    const same = dragOrder.length === commands.length && dragOrder.every((c, i) => c.id === commands[i]?.id);
    if (same) { setDragOrder(null); dragState.current = null; }
  }, [commands, dragOrder]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const runActive = () => {
    const item = filtered[activeIdx];
    if (!item) return;
    onClose();
    // onClose 로 팔레트 unmount 후 실행 — 실행되는 액션이 다른 모달/포커스를 여는 경우 서로 간섭 방지.
    setTimeout(() => item.run(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => (filtered.length ? (i + 1) % filtered.length : 0)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); runActive(); return; }
  };

  const stopProp = (e: React.SyntheticEvent) => e.stopPropagation();

  // 검색어가 비어 있을 때만(전체 목록) 항목을 좌클릭 드래그로 위/아래 이동 — 클릭(실행)과 구분하기 위해
  // 일정 거리(threshold) 이상 움직였을 때만 드래그로 인정한다.
  const DRAG_THRESHOLD = 4;
  const startDrag = (e: React.MouseEvent, idx: number) => {
    if (e.button !== 0 || query.trim()) return;
    const startY = e.clientY;
    let dragging = false;
    let order = filtered;
    let curIdx = idx;
    // 드래그 시작 시점의 컨테이너 top/행 높이를 한 번만 재서 고정 — 이후 mousemove 마다 DOM 을
    // 다시 조회하지 않고 순수 좌표 계산만 하므로, 리렌더가 이벤트 처리 속도를 못 따라가도(빠르게
    // 움직일 때) 판정이 어긋나지 않는다. (기존엔 매번 querySelectorAll 로 낡은 DOM 순서를 읽어
    // 위/아래 판정이 비대칭으로 꼬였었다.)
    const containerTop = listRef.current?.getBoundingClientRect().top ?? 0;
    const rowEl = listRef.current?.querySelector(`[data-idx="${idx}"]`) as HTMLElement | null;
    const rowH = rowEl?.getBoundingClientRect().height || 32;
    const onMove = (me: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(me.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        isDraggingRef.current = true;
        dragState.current = { fromIdx: idx, itemId: filtered[idx]?.id };
      }
      const overIdx = Math.max(0, Math.min(order.length - 1, Math.floor((me.clientY - containerTop) / rowH)));
      if (overIdx === curIdx) return;
      const next = order.slice();
      const [moved] = next.splice(curIdx, 1);
      next.splice(overIdx, 0, moved);
      order = next;
      curIdx = overIdx;
      setDragOrder(next);
      setActiveIdx(overIdx);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (dragging) {
        onReorder?.(order.map(c => c.id));
        justDraggedRef.current = true;
        setTimeout(() => { justDraggedRef.current = false; isDraggingRef.current = false; }, 0);
        // dragOrder 를 여기서 바로 null 로 지우지 않는다 — onReorder 가 호출한 부모의 setState 는
        // (document 레벨 native 리스너라 React 배치 대상이 아닐 수 있어) 별도 렌더로 늦게 반영될 수
        // 있고, 그 사이 commands prop 이 아직 옛 순서라 filtered 가 한 프레임 되돌아가 보였다.
        // 대신 아래 effect 가 commands(부모에서 내려온 새 순서)가 실제로 반영된 걸 확인한 뒤 지운다.
      } else {
        isDraggingRef.current = false;
        dragState.current = null;
        setDragOrder(null);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div
      className="command-palette-overlay"
      onMouseDown={onClose}
      onKeyDown={stopProp} onKeyUp={stopProp} onKeyPress={stopProp}
    >
      <div className="command-palette-box" onMouseDown={stopProp}>
        <div className="command-palette-input-row">
          <span className="command-palette-icon">🔎</span>
          <input
            ref={inputRef}
            className="command-palette-input"
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onKeyUp={stopProp}
            placeholder="메뉴, 워크스페이스 검색..."
            autoComplete="off"
          />
          <span className="command-palette-esc">Esc</span>
        </div>
        <div className="command-palette-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="command-palette-empty">검색 결과가 없습니다.</div>
          ) : (
            filtered.map((c, i) => (
              <div
                key={c.id}
                data-idx={i}
                className={`command-palette-item ${i === activeIdx ? 'active' : ''}`}
                style={{ cursor: query.trim() ? 'pointer' : 'grab' }}
                onMouseEnter={() => { if (!isDraggingRef.current) setActiveIdx(i); }}
                onMouseDown={e => startDrag(e, i)}
                onClick={() => { if (justDraggedRef.current) return; setActiveIdx(i); runActive(); }}
              >
                {c.icon && <span className="command-palette-item-icon">{c.icon}</span>}
                <span className="command-palette-item-label">{c.label}</span>
                {c.hint && <span className="command-palette-item-hint">{c.hint}</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
