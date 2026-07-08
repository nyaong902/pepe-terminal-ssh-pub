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
};

export const CommandPalette: React.FC<Props> = ({ commands, onClose }) => {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(c => {
      if (c.label.toLowerCase().includes(q)) return true;
      return !!c.keywords?.some(k => k.toLowerCase().includes(q));
    });
  }, [commands, query]);

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
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => { setActiveIdx(i); runActive(); }}
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
