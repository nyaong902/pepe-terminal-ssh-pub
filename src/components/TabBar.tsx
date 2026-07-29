// src/components/TabBar.tsx
import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Tab, TabColor } from '../App';
import { ContextMenu } from './ContextMenu';

// 커스텀 워크스페이스 메뉴에서 순서 구분용 — 1~9는 키캡 이모지, 10은 🔟, 그 이상은 숫자만.
const NUMBER_KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
function numberBadge(n: number): string {
  if (n >= 1 && n <= 9) return NUMBER_KEYCAPS[n - 1];
  if (n === 10) return '🔟';
  return `${n}.`;
}

// 탭을 네이티브(HTML5) 드래그로 잡고 있는 동안 true — 이 시점에 자식 프로세스(PowerShell 아이콘
// 추출 등)를 spawn 하면 Windows 의 OS 레벨 드래그 중첩 메시지 루프와 충돌해 렌더러가 완전히
// 멈추는(강제종료해야 하는) 데드락이 발생할 수 있다. 다른 모듈(FilePanel 등)이 이 값을 참고해
// 드래그 중엔 아이콘 요청 spawn 을 미룬다.
export let isTabDragActive = false;
const tabDragListeners = new Set<() => void>();
export function onTabDragChange(fn: () => void): () => void {
  tabDragListeners.add(fn);
  return () => { tabDragListeners.delete(fn); };
}
function setTabDragActive(v: boolean) {
  isTabDragActive = v;
  tabDragListeners.forEach(fn => { try { fn(); } catch {} });
}

type ShellInfo = { name: string; path: string; icon?: string };
type Props = {
  tabs: Tab[];
  activeTabId: string | null;
  onChange: (id: string) => void;
  onAddTab: (shellName?: string, shellPath?: string) => void;
  onAddBrowserTab?: (url?: string) => void;
  onAddCompareTab?: () => void;
  onAddLogAnalyzerTab?: () => void;
  onAddVpnTab?: () => void;
  onAddMicroSipTab?: () => void;
  onAddSswPhoneTab?: () => void;
  onAddSippTab?: () => void;
  onAddOfficeTab?: () => void;
  onAddMediaTab?: () => void;
  onAddI18nEditorTab?: () => void;
  onAddCustomWorkspace?: (templateId?: string) => void;
  customWorkspaces?: { id: string; name: string }[];
  onCloseTab: (id: string) => void;
  onRenameTab?: (id: string, name: string) => void;
  onReorderTabs?: (fromId: string, toId: string) => void;
  // 파일전송 탭을 다른 파일전송 탭 위로 정확히 드롭했을 때 — 순서 재정렬 대신 병합.
  onMergeFileExplorerTabs?: (fromId: string, toId: string) => void;
  onDetachTab?: (id: string, screenX?: number, screenY?: number) => void;
  onSetTabColor?: (id: string, color: TabColor) => void;
  // 우측 분할 관련 — 활성 탭 옆에 다른 워크스페이스 탭 표시
  splitRightTabId?: string | null;
  onSplitRight?: (id: string) => void;
  onUnsplitRight?: () => void;
  canSplitType?: (type: any) => boolean;
  hasSession?: Record<string, boolean>;
  themeName?: string;
  themeList?: string[];
  onThemeChange?: (name: string) => void;
  availableShells?: ShellInfo[];
  // 설치 시 선택 해제됐을 수 있는 기능(VPN/MicroSIP/SIPp) 의 "+" 워크스페이스 메뉴 표시 여부
  availableFeatures?: { vpn: boolean; microsip: boolean; sipp: boolean; office: boolean; media: boolean };
};

export const TabBar: React.FC<Props> = ({ tabs, activeTabId, onChange, onAddTab, onAddBrowserTab, onAddCompareTab, onAddLogAnalyzerTab, onAddVpnTab, onAddMicroSipTab, onAddSswPhoneTab, onAddSippTab, onAddOfficeTab, onAddMediaTab, onAddCustomWorkspace, customWorkspaces, onCloseTab, onRenameTab, onReorderTabs, onMergeFileExplorerTabs, onDetachTab, onSetTabColor, hasSession, themeName, themeList, onThemeChange, availableShells, availableFeatures, splitRightTabId, onSplitRight, onUnsplitRight, canSplitType }) => {
  const { t } = useTranslation('tabBar');
  const { t: tc } = useTranslation('common');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [shellMenu, setShellMenu] = useState<{ x: number; y: number } | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // 탭 드래그(재정렬/분리) — HTML5 네이티브 drag-and-drop 대신 mousedown/mousemove/mouseup 로 직접
  // 구현한다. .tab-bar-row 가 -webkit-app-region:drag(타이틀바) 인데, 그 안에서 네이티브 HTML5
  // 드래그를 시작하면 Windows 에서 OS 창-드래그와 충돌해 렌더러가 완전히 멈추는(강제종료 필요)
  // 알려진 Electron 버그가 있다(electron/electron#7107 등) — 네이티브 DnD 자체를 안 쓰면 원천 차단된다.
  const pointerDragRef = useRef<{ tabId: string; startX: number; startY: number; moved: boolean } | null>(null);
  // 네이티브 HTML5 드래그를 안 쓰기로 하면서(위 이유), 브라우저가 자동으로 그려주던 "마우스에 탭
  // 모양이 붙어서 따라다니는" 드래그 고스트도 같이 사라졌다. 렌더러 안의 DOM 엘리먼트로는 앱 창
  // 경계를 못 벗어나므로(분리하려고 창 밖으로 끌 때 안 보임), 별도의 작은 always-on-top 창을
  // main 프로세스에 띄워 화면 좌표로 커서를 따라다니게 한다 — 클릭은 항상 통과시켜(ignore mouse
  // events) 실제 드래그 판정(mousemove/mouseup)에는 전혀 관여하지 않는다.
  const ghostActiveRef = useRef(false);
  const startPointerDrag = (tabId: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const st = { tabId, startX: e.clientX, startY: e.clientY, moved: false };
    pointerDragRef.current = st;
    const sourceEl = e.currentTarget as HTMLElement;
    const rect = sourceEl.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const cs = window.getComputedStyle(sourceEl);
    const createGhost = (screenX: number, screenY: number) => {
      ghostActiveRef.current = true;
      try {
        (window as any).api?.tabDragGhostStart?.({
          x: screenX - offsetX, y: screenY - offsetY,
          width: rect.width, height: rect.height,
          label: sourceEl.innerText || '',
          bg: cs.backgroundColor, color: cs.color,
          accent: cs.borderColor && cs.borderColor !== 'rgba(0, 0, 0, 0)' ? cs.borderColor : undefined,
        });
      } catch {}
    };
    const positionGhost = (screenX: number, screenY: number) => {
      if (!ghostActiveRef.current) return;
      try { (window as any).api?.tabDragGhostMove?.(screenX - offsetX, screenY - offsetY); } catch {}
    };
    const removeGhost = () => {
      if (!ghostActiveRef.current) return;
      ghostActiveRef.current = false;
      try { (window as any).api?.tabDragGhostEnd?.(); } catch {}
    };
    const onMove = (ev: MouseEvent) => {
      if (pointerDragRef.current !== st) return;
      if (!st.moved) {
        if (Math.abs(ev.clientX - st.startX) < 4 && Math.abs(ev.clientY - st.startY) < 4) return;
        st.moved = true;
        setDraggingId(st.tabId);
        setTabDragActive(true);
        createGhost(ev.screenX, ev.screenY);
      }
      positionGhost(ev.screenX, ev.screenY);
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const overItem = el?.closest('.tab-item') as HTMLElement | null;
      const overId = overItem?.getAttribute('data-tab-id') || null;
      setDragOverId(overId && overId !== st.tabId ? overId : null);
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      removeGhost();
      if (pointerDragRef.current !== st) return;
      pointerDragRef.current = null;
      if (!st.moved) return; // 그냥 클릭 — onClick 이 처리
      setTabDragActive(false);
      const sx = ev.screenX, sy = ev.screenY;
      const clientX = ev.clientX, clientY = ev.clientY;
      (async () => {
        try {
          const b: any = await (window as any).api?.getWindowBounds?.();
          const outside = b && (sx < b.x || sx > b.x + b.width || sy < b.y || sy > b.y + b.height);
          if (outside) {
            onDetachTab?.(st.tabId, sx, sy);
          } else {
            const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
            const overItem = el?.closest('.tab-item') as HTMLElement | null;
            const overId = overItem?.getAttribute('data-tab-id') || null;
            if (overId && overId !== st.tabId) {
              const fromTab = tabs.find(x => x.id === st.tabId);
              const toTab = tabs.find(x => x.id === overId);
              if (fromTab?.type === 'fileExplorer' && toTab?.type === 'fileExplorer' && onMergeFileExplorerTabs) {
                onMergeFileExplorerTabs(st.tabId, overId);
              } else {
                onReorderTabs?.(st.tabId, overId);
              }
            }
          }
        } catch {}
        setDraggingId(null);
        setDragOverId(null);
      })();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const workspaceTabs = tabs;
  const getWorkspaceShortcutLabel = (tabId: string): string | null => {
    const idx = workspaceTabs.findIndex(tab => tab.id === tabId);
    if (idx < 0 || idx >= 10) return null;
    return idx === 9 ? '0' : String(idx + 1);
  };

  const startRename = (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    setRenamingId(tabId);
    setRenameValue(tab.title);
  };

  const submitRename = () => {
    if (renamingId && renameValue.trim()) {
      onRenameTab?.(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const scrollBy = (dx: number) => { scrollRef.current?.scrollBy({ left: dx, behavior: 'smooth' }); };
  // 탭이 영역을 넘는지 감지 → 스크롤 버튼 노출 여부
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    window.addEventListener('resize', check);
    return () => { ro.disconnect(); window.removeEventListener('resize', check); };
  }, [tabs.length]);
  return (
    <div className="tab-bar">
      <div className="tab-bar-scroll" ref={scrollRef} onWheel={e => {
        e.currentTarget.scrollLeft += e.deltaY > 0 ? 60 : -60;
      }}>
      {tabs.map(tab => (
        <div
          key={tab.id}
          data-tab-id={tab.id}
          className={`tab-item ${tab.id === activeTabId ? 'active' : ''}${draggingId === tab.id ? ' dragging' : ''}${dragOverId === tab.id && draggingId && draggingId !== tab.id ? ' drag-over' : ''}${tab.color && tab.color !== 'default' ? ` tab-color-${tab.color}` : ''}`}
          onClick={() => onChange(tab.id)}
          onMouseDown={e => {
            if (e.button === 1) { e.preventDefault(); e.stopPropagation(); onCloseTab(tab.id); return; }
            if (e.button === 0 && renamingId !== tab.id) startPointerDrag(tab.id, e);
          }}
          onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onCloseTab(tab.id); } }}
          onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id }); }}
        >
          <span className="tab-title-row">
            {hasSession?.[tab.id] && <span className="tab-status-dot" />}
            {(() => {
              const shortcut = getWorkspaceShortcutLabel(tab.id);
              return shortcut ? <span className="tab-shortcut-badge" aria-label={`Ctrl+${shortcut}`}>{shortcut}</span> : null;
            })()}
          </span>
          {renamingId === tab.id ? (
            <input
              className="tab-rename-input"
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onBlur={submitRename}
              onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenamingId(null); }}
              autoFocus
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span>{(() => {
              if (tab.customTitle) return tab.title;
              switch (tab.type) {
                case 'compare': return t('compareWorkspace');
                case 'logAnalyzer': return t('logAnalyzerWorkspace');
                case 'vpn': return t('vpnWorkspace');
                case 'i18nEditor': return t('translationEditor');
                case 'fileExplorer': return tab.title.startsWith('📁') ? t('fileTransferTab', { defaultValue: tab.title }) : tab.title;
              }
              const m = tab.title.match(/^Workspace (\d+)$/);
              if (m) return t('workspaceN', { n: m[1] });
              return tab.title;
            })()}</span>
          )}
          {tabs.length > 1 && (
            <button
              className="tab-close"
              onClick={e => { e.stopPropagation(); onCloseTab(tab.id); }}
            >
              &times;
            </button>
          )}
        </div>
      ))}
      </div>
      <button className="tab-add-btn" onClick={e => {
        const r = e.currentTarget.getBoundingClientRect();
        setAddMenu({ x: r.left, y: r.bottom });
      }} title={t('addTooltip')}>+</button>
      {overflowing && (
        <div className="tab-scroll-group">
          <button className="tab-scroll-btn" onClick={() => scrollBy(-150)} title={t('scrollPrev')}>‹</button>
          <button className="tab-scroll-btn" onClick={() => scrollBy(150)} title={t('scrollNext')}>›</button>
        </div>
      )}
      {themeList && onThemeChange && (
        <select className="theme-select" value={themeName} onChange={e => onThemeChange(e.target.value)}>
          {themeList.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x} y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            { icon: '✏️', label: tc('rename'), onClick: () => startRename(contextMenu.tabId) },
            ...(onDetachTab && tabs.length > 1 ? [{ icon: '🪟', label: t('openInNewWindow'), onClick: () => onDetachTab(contextMenu.tabId) }] : []),
            ...((() => {
              const target = tabs.find(t2 => t2.id === contextMenu.tabId);
              if (!target || !onSplitRight || !onUnsplitRight) return [];
              const isRight = splitRightTabId === target.id;
              const eligible = canSplitType ? canSplitType(target.type) : false;
              const isActive = activeTabId === target.id;
              if (isRight) {
                return [{ icon: '↔', label: '분할 해제', onClick: () => onUnsplitRight() }];
              }
              if (eligible && !isActive) {
                return [{ icon: '↔', label: '우측에 함께 보기', onClick: () => onSplitRight(target.id) }];
              }
              return [];
            })()),
            ...(onSetTabColor ? [{
              icon: '🎨',
              label: t('colorSetting'),
              submenu: ([
                { id: 'default' as TabColor, label: t('colorDefault') },
                { id: 'red' as TabColor,     label: t('colorRed'),    swatch: '#e74c3c' },
                { id: 'orange' as TabColor,  label: t('colorOrange'), swatch: '#e67e22' },
                { id: 'yellow' as TabColor,  label: t('colorYellow'), swatch: '#f1c40f' },
                { id: 'green' as TabColor,   label: t('colorGreen'),  swatch: '#27ae60' },
                { id: 'blue' as TabColor,    label: t('colorBlue'),   swatch: '#3498db' },
                { id: 'purple' as TabColor,  label: t('colorPurple'), swatch: '#9b59b6' },
              ]).map(opt => {
                const cur = tabs.find(t2 => t2.id === contextMenu.tabId)?.color || 'default';
                return {
                  label: (cur === opt.id ? '✓ ' : '   ') + opt.label,
                  icon: opt.swatch ? <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: opt.swatch }} /> : undefined,
                  onClick: () => onSetTabColor(contextMenu.tabId, opt.id),
                };
              }),
            }] : []),
            { icon: '✕', label: tc('close'), onClick: () => onCloseTab(contextMenu.tabId) },
          ]}
        />
      )}
      {shellMenu && availableShells && (
        <ContextMenu
          x={shellMenu.x} y={shellMenu.y}
          onClose={() => setShellMenu(null)}
          items={availableShells.map(sh => ({
            label: `${sh.icon || ''} ${sh.name}`.trim(),
            onClick: () => onAddTab(sh.name, sh.path),
          }))}
        />
      )}
      {addMenu && (
        <ContextMenu
          x={addMenu.x} y={addMenu.y}
          onClose={() => setAddMenu(null)}
          items={[
            {
              label: `🐚  ${t('shellSelect')}`,
              submenu: (availableShells && availableShells.length > 0
                ? availableShells.map(sh => ({ label: `${sh.icon || '▪'}  ${sh.name}`, onClick: () => onAddTab(sh.name, sh.path) }))
                : [{ label: t('terminalWorkspace'), onClick: () => onAddTab() }]
              ),
            },
            {
              label: `🗂  ${t('workspace')}`,
              submenu: [
                { label: t('terminalWorkspace'), onClick: () => onAddTab() },
                { label: t('browserWorkspace'), onClick: () => onAddBrowserTab?.() },
                { label: t('compareWorkspace'), onClick: () => onAddCompareTab?.() },
                { label: t('logAnalyzerWorkspace'), onClick: () => onAddLogAnalyzerTab?.() },
                ...((availableFeatures?.vpn ?? true) ? [{ label: t('vpnWorkspace'), onClick: () => onAddVpnTab?.() }] : []),
                ...((availableFeatures?.microsip ?? true) ? [{ label: '📞 MicroSIP', onClick: () => onAddMicroSipTab?.() }] : []),
                ...((availableFeatures?.microsip ?? true) ? [{ label: '📡 SSW 소프트폰', onClick: () => onAddSswPhoneTab?.() }] : []),
                ...((availableFeatures?.sipp ?? true) ? [{ label: '📶 SIPp', onClick: () => onAddSippTab?.() }] : []),
                ...((availableFeatures?.office ?? true) ? [{ label: '📄 오피스', onClick: () => onAddOfficeTab?.() }] : []),
                ...((availableFeatures?.media ?? true) ? [{ label: '🎵 미디어', onClick: () => onAddMediaTab?.() }] : []),
              ],
            },
            {
              label: `🧩  ${t('customWorkspace', { defaultValue: '커스텀 워크스페이스' })}`,
              submenu: [
                { label: `➕  ${t('customWorkspaceAdd', { defaultValue: '추가' })}`, onClick: () => onAddCustomWorkspace?.() },
                ...(customWorkspaces?.map((ws, i) => ({ label: `${numberBadge(i + 1)}  ${ws.name}`, onClick: () => onAddCustomWorkspace?.(ws.id) })) || []),
              ],
            },
          ]}
        />
      )}
    </div>
  );
};
