import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// 탭 바 오른쪽의 "모든 탭 보기(▾)" — SQL Tool 워크스페이스에 있던 것을 앱 공용으로 뺀 것.
// 탭이 많아 ‹ › 로 넘겨야 할 때, 목록에서 바로 고르는 쪽이 빠르다.
//
// 목록은 body 로 포털해서 화면 좌표(position:fixed)로 띄운다. 탭 바들은 탭이 밖으로 삐져나오지
// 않게 overflow:hidden 이라, 탭 바 안에 position:absolute 로 두면 목록이 통째로 잘려서
// "눌러도 아무 일도 안 일어나는" 것처럼 보인다(브라우저 .bp-tabs, 공용 .pepe-tabs 둘 다).
//
// 스타일을 CSS 클래스로 두지 않고 인라인으로 두는 이유: 이걸 쓰는 탭 바들(문서형 워크스페이스,
// 브라우저, Pepe-Box)이 서로 다른 색 체계를 인라인으로 들고 있어서, 클래스로 빼면 한쪽에 맞춘
// 색이 다른 쪽에서 튄다. --win-* 변수만 쓰면 어느 탭 바에서도 주변과 맞는다.

export type TabListEntry = { id: string; label: string; icon?: string };

const MENU_WIDTH = 240;

export function TabListMenu({ items, activeId, onSelect, onCloseItem, title = '모든 탭' }: {
  items: TabListEntry[];
  activeId?: string | null;
  onSelect: (id: string) => void;
  /** 넘기면 목록의 각 줄에 × 가 붙는다. 탭이 하나뿐이면 자동으로 숨긴다. */
  onCloseItem?: (id: string) => void;
  title?: string;
}) {
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const open = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    const top = r.bottom + 2;
    setPos({ left, top, maxHeight: Math.max(120, window.innerHeight - top - 12) });
  };

  // 바깥을 누르면 닫는다 — 목록 위에 투명막을 깔지 않고 document 에서 잡는다(막을 깔면
  // 그 아래 탭을 한 번 더 눌러야 반응해서 답답하다). 스크롤·리사이즈로 좌표가 어긋나면 닫는다.
  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setPos(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPos(null); };
    const close = () => setPos(null);
    // 목록 안에서 굴릴 때는 닫지 않는다 — 스크롤을 capture 로 잡으면 목록 자신의 스크롤까지
    // 여기로 올라와서, 항목을 보려고 굴리는 순간 사라져 버린다. 바깥(탭 바·본문)이 움직일 때만
    // 좌표가 어긋나므로 그때만 닫는다.
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      close();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [pos]);

  if (items.length === 0) return null;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (pos ? setPos(null) : open())}
        title={title}
        style={{
          background: 'transparent', border: 0, color: 'var(--win-text-dim, #9cdcfe)',
          padding: '0 8px', height: 22, cursor: 'pointer', fontSize: 11, lineHeight: 1,
          flex: '0 0 auto',
        }}
      >▾</button>
      {pos && createPortal(
        <div
          ref={menuRef}
          style={{
            position: 'fixed', left: pos.left, top: pos.top, zIndex: 6000,
            width: MENU_WIDTH, maxHeight: pos.maxHeight, overflowY: 'auto',
            background: 'var(--win-surface, #1e1e1e)',
            border: '1px solid var(--win-border, #30363d)', borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)', padding: 4,
          }}
        >
          {items.map(it => {
            const active = it.id === activeId;
            return (
              <div
                key={it.id}
                onClick={() => { onSelect(it.id); setPos(null); }}
                title={it.label}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
                  borderRadius: 4, cursor: 'pointer', fontSize: 12,
                  background: active ? 'var(--win-accent, #0e639c)' : 'transparent',
                  color: 'var(--win-text, #e6edf3)',
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.07)'; }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
              >
                {it.icon && <span>{it.icon}</span>}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                {onCloseItem && items.length > 1 && (
                  <span
                    onClick={e => { e.stopPropagation(); onCloseItem(it.id); setPos(null); }}
                    title="닫기"
                    style={{ opacity: 0.7, padding: '0 2px', borderRadius: 4 }}
                  >×</span>
                )}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
