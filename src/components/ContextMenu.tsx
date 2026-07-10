// src/components/ContextMenu.tsx
import React, { useEffect, useRef, useState } from 'react';

export type MenuItem = {
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  separator?: boolean;
  header?: boolean;
  disabled?: boolean;
  submenu?: MenuItem[];
};

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

export const ContextMenu: React.FC<Props> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  React.useEffect(() => {
    if (!menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    let nx = x, ny = y;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (nx + r.width > vw - 4) nx = Math.max(4, vw - r.width - 4);
    if (ny + r.height > vh - 4) ny = Math.max(4, vh - r.height - 4);
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny });
  }, [x, y, items.length]);

  // onClose 는 호출부(TabBar 등)가 매 렌더마다 새 인라인 함수를 넘기는 경우가 많다 — 예전엔
  // 이 effect 의 deps 에 onClose 를 직접 넣어서, 부모가 자주 리렌더되면(예: 커스텀 워크스페이스가
  // 활성 탭일 때 상태가 tabs 배열을 거쳐 위로 계속 왕복되며 매우 잦은 리렌더를 유발) 아래
  // "리스너 등록"이 setTimeout(0) 이 실행되기도 전에 매번 해제→재예약을 반복해서 리스너가
  // 사실상 영원히 안 붙는 문제가 있었다(= 메뉴가 바깥 클릭/Escape 로 절대 안 닫힘). ref 로
  // 최신 onClose 만 참조하고 리스너 등록 자체는 마운트 시 한 번만 하도록 분리한다.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current) return;
      // 자기 자신 또는 다른 context-menu (submenu) 내부 클릭이면 닫지 않음
      const target = e.target as HTMLElement;
      if (target.closest?.('.context-menu')) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 호버 중인 서브메뉴 인덱스 + 부모 row 의 위치
  const [openSub, setOpenSub] = useState<{ idx: number; top: number; left: number } | null>(null);

  return (
    <div ref={menuRef} className="context-menu" style={{ top: pos.y, left: pos.x }} onClick={e => e.stopPropagation()}>
      {items.map((item, i) => {
        if (item.separator) return <div key={i} className="context-menu-separator" />;
        if (item.header) return <div key={i} style={{ padding: '4px 12px', fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{item.label || ''}</div>;
        const hasSub = !!(item.submenu && item.submenu.length > 0);
        return (
          <div
            key={i}
            className={`context-menu-item ${item.disabled ? 'disabled' : ''} ${hasSub ? 'has-submenu' : ''} ${openSub?.idx === i ? 'submenu-open' : ''}`}
            onMouseEnter={(e) => {
              if (hasSub) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setOpenSub({ idx: i, top: r.top, left: r.right - 2 });
              } else {
                setOpenSub(null);
              }
            }}
            onClick={() => {
              if (item.disabled) return;
              if (hasSub) return; // 서브메뉴 부모는 클릭으로 닫지 않음
              item.onClick?.();
              onClose();
            }}
          >
            {item.icon !== undefined && <span className="context-menu-icon">{item.icon}</span>}
            <span className="context-menu-label-text">{item.label || ''}</span>
            {hasSub && <span className="context-menu-arrow">▶</span>}
            {hasSub && openSub?.idx === i && (
              <ContextMenu
                x={openSub.left}
                y={openSub.top}
                items={item.submenu!}
                onClose={onClose}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
