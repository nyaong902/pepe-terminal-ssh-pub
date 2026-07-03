// src/components/TabBar.tsx
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { Tab, TabColor } from '../App';
import { ContextMenu } from './ContextMenu';

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
  onAddI18nEditorTab?: () => void;
  onCloseTab: (id: string) => void;
  onRenameTab?: (id: string, name: string) => void;
  onReorderTabs?: (fromId: string, toId: string) => void;
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
};

export const TabBar: React.FC<Props> = ({ tabs, activeTabId, onChange, onAddTab, onAddBrowserTab, onAddCompareTab, onAddLogAnalyzerTab, onAddVpnTab, onAddMicroSipTab, onAddI18nEditorTab, onCloseTab, onRenameTab, onReorderTabs, onDetachTab, onSetTabColor, hasSession, themeName, themeList, onThemeChange, availableShells, splitRightTabId, onSplitRight, onUnsplitRight, canSplitType }) => {
  const { t } = useTranslation('tabBar');
  const { t: tc } = useTranslation('common');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [shellMenu, setShellMenu] = useState<{ x: number; y: number } | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
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
          className={`tab-item ${tab.id === activeTabId ? 'active' : ''}${draggingId === tab.id ? ' dragging' : ''}${dragOverId === tab.id && draggingId && draggingId !== tab.id ? ' drag-over' : ''}${tab.color && tab.color !== 'default' ? ` tab-color-${tab.color}` : ''}`}
          draggable={renamingId !== tab.id}
          onDragStart={e => {
            setDraggingId(tab.id);
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('application/x-pepe-tab', tab.id); } catch {}
          }}
          onDragEnd={e => {
            const sx = e.screenX, sy = e.screenY;
            setDraggingId(null); setDragOverId(null);
            // 창 밖에 드롭하면 새 창으로 분리
            if (!onDetachTab) return;
            (async () => {
              try {
                const b: any = await (window as any).api?.getWindowBounds?.();
                if (b && (sx < b.x || sx > b.x + b.width || sy < b.y || sy > b.y + b.height)) {
                  onDetachTab(tab.id, sx, sy);
                }
              } catch {}
            })();
          }}
          onDragOver={e => {
            if (!draggingId || draggingId === tab.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dragOverId !== tab.id) setDragOverId(tab.id);
          }}
          onDragLeave={() => { if (dragOverId === tab.id) setDragOverId(null); }}
          onDrop={e => {
            e.preventDefault();
            if (draggingId && draggingId !== tab.id) onReorderTabs?.(draggingId, tab.id);
            setDraggingId(null);
            setDragOverId(null);
          }}
          onClick={() => onChange(tab.id)}
          onMouseDown={e => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); onCloseTab(tab.id); } }}
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
            ...(onDetachTab ? [{ icon: '🪟', label: t('openInNewWindow'), onClick: () => onDetachTab(contextMenu.tabId) }] : []),
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
                { label: t('vpnWorkspace'), onClick: () => onAddVpnTab?.() },
                { label: '📞 MicroSIP', onClick: () => onAddMicroSipTab?.() },
                { label: t('translationEditor'), onClick: () => onAddI18nEditorTab?.() },
              ],
            },
          ]}
        />
      )}
    </div>
  );
};
