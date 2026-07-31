// src/components/SqlToolTabShell.tsx
// SQL Tool 탭의 바깥 껍데기 — DBeaver 처럼 왼쪽에 독립 DB 연결 목록(SSH 세션과 무관, sql-sessions.json)
// 을 항상 띄워두고, 오른쪽에 선택된 연결의 실제 SqlToolWorkspace 를 보여준다. 목록에서 다른 연결을
// 고르면 같은 탭 안에서 워크스페이스만 바뀌고(연결별로 key 를 다르게 줘서 완전히 새로 마운트),
// "새 DB 연결"로 SSH 세션 생성 없이 DB 정보(+ 필요하면 자체 SSH 터널 정보)만 바로 등록할 수 있다.
// 세션 목록 UI 는 SSH SessionList 와 최대한 동일하게 맞춘다: 상단 툴바(📁+/추가/편집/삭제, 선택 기반
// 활성화), 검색바, 폴더 트리(접기/펼치기/드래그로 이동/우클릭 메뉴), pin/unpin(자동숨김) — 클래스도
// 대부분 App.css 의 session-toolbar/btn-add/btn-edit/btn-delete/session-search-bar 등을 그대로 재사용한다.
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SqlToolWorkspace } from './SqlToolWorkspace';
import { SqlSessionEditor, type SqlSession } from './SqlSessionEditor';
import { notifyConfirm, notifyOk, notifyError } from './Notify';

type SqlFolder = { id: string; name: string; parentId?: string };
type SearchScope = 'name' | 'all';

type Props = {
  sessionId: string;
  sessionName: string;
  onSessionChange: (sessionId: string, sessionName: string) => void;
};

type CtxMenu = { x: number; y: number; id: string; type: 'session' | 'folder'; name: string; folderId?: string } | null;

const api = (window as any).api || {};
// localStorage 는 인스턴스별 sessionData 분리 때문에 앱 재시작 시 영속되지 않는다(캐시 충돌 방지용
// PID+timestamp 분리, electron/main.ts 22줄 부근) — ui-prefs(config.json) IPC 로 저장한다.
const SIDEBAR_PIN_PREF = 'sqlToolSidebarPinned';
const SIDEBAR_COLLAPSED_PREF = 'sqlToolSidebarCollapsedFolders';
const SIDEBAR_WIDTH_PREF = 'sqlToolSidebarWidth';

function blankSqlSession(name: string, folderId?: string): SqlSession {
  return {
    id: `sql-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    folderId,
    dbms: { type: 'altibase', driverId: 'altibase-builtin', port: 20300, user: '', password: '' },
  };
}

export const SqlToolTabShell: React.FC<Props> = ({ sessionId, sessionName, onSessionChange }) => {
  const { t } = useTranslation('sqlTool');
  const [sessions, setSessions] = useState<SqlSession[] | null>(null);
  const [folders, setFolders] = useState<SqlFolder[]>([]);
  const [editing, setEditing] = useState<SqlSession | null>(null);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const collapsedLoadedRef = useRef(false);
  const [selected, setSelected] = useState<{ id: string; type: 'session' | 'folder' } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [childOrder, setChildOrderState] = useState<Record<string, string[]>>({});
  const [contextMenu, setContextMenu] = useState<CtxMenu>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingType, setRenamingType] = useState<'session' | 'folder'>('session');
  const [renameValue, setRenameValue] = useState('');
  const [dragOverId, setDragOverId] = useState<string | null | undefined>(undefined);
  const dragSessionIdRef = useRef<string | null>(null);
  const [searchScope, setSearchScope] = useState<SearchScope>('name');
  const [searchValue, setSearchValue] = useState('');
  const [copiedSession, setCopiedSession] = useState<SqlSession | null>(null);
  const [copiedFolder, setCopiedFolder] = useState<{ folder: SqlFolder; allFolders: SqlFolder[]; allSessions: SqlSession[] } | null>(null);

  const [pinned, setPinned] = useState<boolean>(true);
  const pinnedLoadedRef = useRef(false);
  const [visible, setVisible] = useState<boolean>(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverShowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [width, setWidth] = useState<number>(240);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);

  // 사이드바 pin/collapsed-folders/width 를 ui-prefs(config.json) 에서 로드 — localStorage 대신.
  useEffect(() => {
    (window as any).api?.getUIPrefs?.().then((prefs: any) => {
      if (typeof prefs?.[SIDEBAR_PIN_PREF] === 'boolean') {
        setPinned(prefs[SIDEBAR_PIN_PREF]);
        setVisible(prefs[SIDEBAR_PIN_PREF]);
      }
      if (Array.isArray(prefs?.[SIDEBAR_COLLAPSED_PREF])) setCollapsed(new Set(prefs[SIDEBAR_COLLAPSED_PREF]));
      if (typeof prefs?.[SIDEBAR_WIDTH_PREF] === 'number') setWidth(prefs[SIDEBAR_WIDTH_PREF]);
      pinnedLoadedRef.current = true;
      collapsedLoadedRef.current = true;
    }).catch(() => { pinnedLoadedRef.current = true; collapsedLoadedRef.current = true; });
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api.sqlSessionsList?.();
      setSessions(data?.sessions ?? []);
      setFolders(data?.folders ?? []);
      setChildOrderState(data?.childOrder ?? {});
    } catch {
      setSessions([]);
      setFolders([]);
      setChildOrderState({});
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!collapsedLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ [SIDEBAR_COLLAPSED_PREF]: Array.from(collapsed) }); } catch {}
  }, [collapsed]);

  const saveEditing = async (s: SqlSession) => {
    try { await api.sqlSessionsSave?.(s); } catch {}
    setEditing(null);
    await load();
    // 방금 저장한 게 새 연결이거나 이름이 바뀐 현재 연결이면 사이드바/워크스페이스 제목도 갱신.
    if (s.id === sessionId) onSessionChange(s.id, s.name);
  };

  const toggleCollapse = (folderId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
      return next;
    });
  };

  const handleAddFolder = async () => {
    const parentId = selected?.type === 'folder' ? selected.id : undefined;
    const folder: SqlFolder = { id: `sqlfolder-${Date.now()}`, name: t('sidebarNewFolderDefault'), parentId };
    try { await api.sqlSessionsSaveFolder?.(folder); } catch {}
    await load();
  };

  const handleAdd = () => {
    const folderId = selected?.type === 'folder' ? selected.id : undefined;
    setEditing(blankSqlSession(t('pickerAddNew'), folderId));
  };

  const handleEdit = () => {
    if (!selected || selected.type !== 'session') return;
    const s = sessions?.find(x => x.id === selected.id);
    if (s) setEditing(s);
  };

  const startRename = (id: string, type: 'session' | 'folder', currentName: string) => {
    setRenamingId(id);
    setRenamingType(type);
    setRenameValue(currentName);
  };

  const submitRename = async () => {
    if (!renamingId || !renameValue.trim()) { setRenamingId(null); return; }
    if (renamingType === 'folder') {
      const f = folders.find(x => x.id === renamingId);
      if (f) { try { await api.sqlSessionsSaveFolder?.({ ...f, name: renameValue.trim() }); } catch {} }
    } else {
      const s = sessions?.find(x => x.id === renamingId);
      if (s) {
        const updated = { ...s, name: renameValue.trim() };
        try { await api.sqlSessionsSave?.(updated); } catch {}
        if (s.id === sessionId) onSessionChange(s.id, updated.name);
      }
    }
    setRenamingId(null);
    await load();
  };

  const deleteItem = async (id: string, type: 'session' | 'folder') => {
    if (type === 'folder') {
      const f = folders.find(x => x.id === id);
      if (!f) return;
      const ok = await notifyConfirm(t('sidebarDelete'), t('sidebarDeleteFolderConfirm', { name: f.name }));
      if (!ok) return;
      try { await api.sqlSessionsDeleteFolder?.(id); } catch {}
      setSelected(null);
      setSelectedIds(new Set());
      await load();
      return;
    }
    const s = sessions?.find(x => x.id === id);
    if (!s) return;
    const ok = await notifyConfirm(t('sidebarDelete'), t('sidebarDeleteSessionConfirm', { name: s.name }));
    if (!ok) return;
    try { await api.sqlSessionsDelete?.(id); } catch {}
    if (id === sessionId) onSessionChange('', '');
    setSelected(null);
    setSelectedIds(new Set());
    await load();
  };

  // 삭제 확인 없이 단건 삭제 (다중 삭제 루프용)
  const deleteItemSilent = async (id: string, type: 'session' | 'folder') => {
    if (type === 'folder') { try { await api.sqlSessionsDeleteFolder?.(id); } catch {} }
    else { try { await api.sqlSessionsDelete?.(id); } catch {} }
    if (id === sessionId) onSessionChange('', '');
  };

  const handleDelete = async () => {
    if (selectedIds.size > 0) {
      const ids = [...selectedIds];
      const ok = await notifyConfirm(t('sidebarDelete'), t('sidebarDeleteItemsConfirm', { count: ids.length }));
      if (!ok) return;
      for (const id of ids) {
        const type: 'session' | 'folder' = folders.some(f => f.id === id) ? 'folder' : 'session';
        await deleteItemSilent(id, type);
      }
      setSelected(null);
      setSelectedIds(new Set());
      await load();
      return;
    }
    if (!selected) return;
    void deleteItem(selected.id, selected.type);
  };

  const moveSessionToFolder = async (targetSessionId: string, folderId: string | null) => {
    try { await api.sqlSessionsMoveToFolder?.(targetSessionId, folderId); } catch {}
    await load();
  };

  // 세션 복제 — 새 id 로 저장, 이름에 "(복사)" 접미사.
  const duplicateSession = async (source: SqlSession, targetFolderId?: string | null) => {
    const copy: SqlSession = {
      ...source,
      id: `sql-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${source.name} (${t('copySuffix')})`,
      folderId: targetFolderId ?? undefined,
    };
    try { await api.sqlSessionsSave?.(copy); } catch {}
    await load();
    setSelected({ id: copy.id, type: 'session' });
    setSelectedIds(new Set());
  };

  // 폴더 복사 — 하위 폴더/세션 전체 수집해 클립보드에 보관.
  const handleCopyFolder = (folderId: string) => {
    const folder = folders.find(x => x.id === folderId);
    if (!folder) return;
    const getAllSubFolders = (parentId: string): SqlFolder[] => {
      const children = folders.filter(f => f.parentId === parentId);
      return [...children, ...children.flatMap(c => getAllSubFolders(c.id))];
    };
    const subFolders = getAllSubFolders(folderId);
    const allFolders = [folder, ...subFolders];
    const folderIds = new Set(allFolders.map(f => f.id));
    const allSessions = (sessions || []).filter(s => s.folderId && folderIds.has(s.folderId));
    setCopiedFolder({ folder, allFolders, allSessions });
    setCopiedSession(null);
  };

  // 폴더 붙여넣기 — 새 id 로 재귀 저장. targetParentId: undefined=원본과 같은 레벨, string=그 폴더 안.
  const handlePasteFolder = async (targetParentId?: string | null) => {
    if (!copiedFolder) return;
    const { folder, allFolders, allSessions } = copiedFolder;
    let seq = 0;
    const makeId = (prefix: string) => `${prefix}-${Date.now()}-${(++seq).toString(36)}`;
    const idMap = new Map<string, string>();
    for (const f of allFolders) idMap.set(f.id, makeId('sqlfolder'));
    for (const f of allFolders) {
      const newId = idMap.get(f.id)!;
      let newParentId: string | undefined;
      if (f.id === folder.id) {
        newParentId = targetParentId != null ? targetParentId : (folder.parentId ?? undefined);
      } else {
        newParentId = f.parentId ? idMap.get(f.parentId) : undefined;
      }
      const name = f.id === folder.id ? `${f.name} (${t('copySuffix')})` : f.name;
      try { await api.sqlSessionsSaveFolder?.({ id: newId, name, parentId: newParentId }); } catch {}
    }
    for (const s of allSessions) {
      const newFolderId = s.folderId ? idMap.get(s.folderId) : undefined;
      try { await api.sqlSessionsSave?.({ ...s, id: makeId('sql'), folderId: newFolderId }); } catch {}
    }
    await load();
  };

  const handleCopy = () => {
    if (!selected) return;
    if (selected.type === 'session') {
      const s = sessions?.find(x => x.id === selected.id);
      if (s) { setCopiedSession(s); setCopiedFolder(null); }
    } else {
      handleCopyFolder(selected.id);
    }
  };

  const handleExport = async () => {
    try {
      const filePath = await api.sqlSessionsExport?.();
      if (filePath) notifyOk(t('sidebarExport'), t('sidebarExportedMsg', { path: filePath }));
    } catch (e: any) {
      notifyError(t('sidebarExport'), String(e?.message || e));
    }
  };

  const handleImport = async () => {
    try {
      const res = await api.sqlSessionsImport?.();
      if (res) {
        await load();
        const msg = res.duplicateCount > 0
          ? t('sidebarImportedMsgWithDup', { added: res.addedCount, total: res.totalParsed, dup: res.duplicateCount })
          : t('sidebarImportedMsg', { added: res.addedCount, total: res.totalParsed });
        notifyOk(t('sidebarImport'), msg);
      }
    } catch (e: any) {
      notifyError(t('sidebarImport'), String(e?.message || e));
    }
  };

  const handlePaste = () => {
    if (copiedFolder) {
      const target = selected?.type === 'folder' ? selected.id : null;
      void handlePasteFolder(target);
    } else if (copiedSession) {
      const targetFolderId = selected?.type === 'folder' ? selected.id : copiedSession.folderId ?? undefined;
      void duplicateSession(copiedSession, targetFolderId);
    }
  };

  // pin/unpin — 고정 시 항상 표시, 해제 시 마우스가 벗어나면 자동 숨김(파일트리 패널과 동일 패턴).
  useEffect(() => {
    if (pinnedLoadedRef.current) { try { (window as any).api?.setUIPrefs?.({ [SIDEBAR_PIN_PREF]: pinned }); } catch {} }
    if (pinned) setVisible(true);
  }, [pinned]);

  const onClickTrigger = () => {
    if (pinned) return;
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    setVisible(v => !v);
  };
  const onEnterTrigger = () => {
    if (pinned) return;
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    if (hoverShowTimer.current) clearTimeout(hoverShowTimer.current);
    hoverShowTimer.current = setTimeout(() => setVisible(true), 250);
  };
  const onLeaveTrigger = () => {
    if (hoverShowTimer.current) { clearTimeout(hoverShowTimer.current); hoverShowTimer.current = null; }
  };
  const onEnterSidebar = () => {
    if (pinned) return;
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
  };
  const onLeaveSidebar = () => {
    if (pinned) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), 500);
  };

  const closeContextMenu = () => setContextMenu(null);

  const onResizePointerMove = useCallback((ev: PointerEvent) => {
    if (!dragging.current) return;
    const delta = ev.clientX - dragging.current.startX;
    setWidth(Math.max(180, Math.min(800, dragging.current.startWidth + delta)));
  }, []);
  const onResizePointerUp = useCallback(() => {
    try { (window as any).api?.setUIPrefs?.({ [SIDEBAR_WIDTH_PREF]: widthRef.current }); } catch {}
    dragging.current = null;
    window.removeEventListener('pointermove', onResizePointerMove);
    window.removeEventListener('pointerup', onResizePointerUp);
  }, [onResizePointerMove]);
  const onResizePointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
    dragging.current = { startX: e.clientX, startWidth: width };
    window.addEventListener('pointermove', onResizePointerMove);
    window.addEventListener('pointerup', onResizePointerUp);
  };

  const sessionMatches = useCallback((s: SqlSession) => {
    const q = searchValue.trim().toLowerCase();
    if (!q) return true;
    if (s.name.toLowerCase().includes(q)) return true;
    if (searchScope === 'all') {
      if ((s.dbms.host || '').toLowerCase().includes(q)) return true;
      if ((s.dbms.type || '').toLowerCase().includes(q)) return true;
      if ((s.dbms.user || '').toLowerCase().includes(q)) return true;
    }
    return false;
  }, [searchValue, searchScope]);
  const folderMatches = useCallback((f: SqlFolder) => {
    const q = searchValue.trim().toLowerCase();
    return !q || f.name.toLowerCase().includes(q);
  }, [searchValue]);
  const folderHasVisibleDescendant = useCallback((folderId: string): boolean => {
    if (!searchValue.trim()) return true;
    const childSessions = (sessions || []).filter(s => (s.folderId || undefined) === folderId);
    if (childSessions.some(sessionMatches)) return true;
    const childFolders = folders.filter(f => (f.parentId || undefined) === folderId);
    return childFolders.some(cf => folderMatches(cf) || folderHasVisibleDescendant(cf.id));
  }, [searchValue, sessions, folders, sessionMatches, folderMatches]);

  // childOrder(parentId('__root__' 포함) → 자식 id 목록) 기반 혼합 순서 — 없으면 폴더 먼저/세션 나중.
  const orderedChildren = useCallback((parentId: string | undefined): { id: string; type: 'session' | 'folder' }[] => {
    const key = parentId || '__root__';
    const order = childOrder[key];
    const childFolders = folders.filter(f => (f.parentId || undefined) === parentId).filter(f => folderMatches(f) || folderHasVisibleDescendant(f.id));
    const childSessions = (sessions || []).filter(s => (s.folderId || undefined) === parentId).filter(sessionMatches);
    const folderIds = new Set(childFolders.map(f => f.id));
    const sessionIds = new Set(childSessions.map(s => s.id));
    const ordered = order
      ? [...order.filter(id => folderIds.has(id) || sessionIds.has(id)),
         ...childFolders.filter(f => !order.includes(f.id)).map(f => f.id),
         ...childSessions.filter(s => !order.includes(s.id)).map(s => s.id)]
      : [...childFolders.map(f => f.id), ...childSessions.map(s => s.id)];
    return ordered.map(id => ({ id, type: folderIds.has(id) ? 'folder' as const : 'session' as const }));
  }, [childOrder, folders, sessions, folderMatches, folderHasVisibleDescendant, sessionMatches]);

  // shift-클릭 범위선택용 — 현재 검색/펼침 상태를 반영한 전체 트리를 순서대로 평탄화.
  const flattenVisible = useCallback((parentId: string | undefined = undefined): string[] => {
    const out: string[] = [];
    for (const item of orderedChildren(parentId)) {
      out.push(item.id);
      if (item.type === 'folder') {
        const isCollapsed = !searchValue.trim() && collapsed.has(item.id);
        if (!isCollapsed) out.push(...flattenVisible(item.id));
      }
    }
    return out;
  }, [orderedChildren, collapsed, searchValue]);

  const onItemClick = (id: string, type: 'session' | 'folder', e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.size === 0 && selected) next.add(selected.id);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      return;
    }
    if (e.shiftKey) {
      const flat = flattenVisible(undefined);
      const anchor = selected && flat.includes(selected.id) ? selected.id : (flat[0] || id);
      const startIdx = flat.indexOf(anchor);
      const endIdx = flat.indexOf(id);
      if (startIdx >= 0 && endIdx >= 0) {
        const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        setSelectedIds(new Set(flat.slice(lo, hi + 1)));
        setSelected({ id, type });
        return;
      }
    }
    setSelected({ id, type });
    setSelectedIds(new Set());
  };

  const renderTree = (parentId: string | undefined, depth: number): React.ReactNode => {
    return (
      <>
        {orderedChildren(parentId).map(item => {
          if (item.type === 'folder') {
            const f = folders.find(x => x.id === item.id);
            if (!f) return null;
            const isCollapsed = !!searchValue.trim() ? false : collapsed.has(f.id);
            const isDragOver = dragOverId === f.id;
            const isSelected = (selected?.type === 'folder' && selected.id === f.id) || selectedIds.has(f.id);
            return (
              <div key={f.id}>
                <div
                  className="session-item folder-item"
                  style={{
                    paddingLeft: 8 + depth * 16, paddingRight: 8, height: 28, display: 'flex', alignItems: 'center', gap: 4,
                    cursor: 'pointer', fontSize: 12, color: 'var(--win-text-dim, #ccc)',
                    background: isDragOver ? 'rgba(43, 107, 155, 0.25)' : (isSelected ? 'var(--win-surface, #222)' : 'transparent'),
                    borderLeft: isSelected ? '3px solid var(--win-accent, #2b6b9b)' : '3px solid transparent',
                  }}
                  onClick={e => onItemClick(f.id, 'folder', e)}
                  onDoubleClick={() => toggleCollapse(f.id)}
                  onContextMenu={e => { e.preventDefault(); if (!selectedIds.has(f.id)) { setSelected({ id: f.id, type: 'folder' }); setSelectedIds(new Set()); } setContextMenu({ x: e.clientX, y: e.clientY, id: f.id, type: 'folder', name: f.name }); }}
                  onDragOver={e => { e.preventDefault(); setDragOverId(f.id); }}
                  onDragLeave={() => setDragOverId(prev => (prev === f.id ? undefined : prev))}
                  onDrop={e => {
                    e.preventDefault(); e.stopPropagation();
                    setDragOverId(undefined);
                    const sid = dragSessionIdRef.current;
                    if (sid) moveSessionToFolder(sid, f.id);
                  }}
                >
                  <span onClick={e => { e.stopPropagation(); toggleCollapse(f.id); }} style={{ width: 12, flexShrink: 0, color: 'var(--win-text-dim, #888)' }}>{isCollapsed ? '▶' : '▼'}</span>
                  <span style={{ flexShrink: 0 }}>📁</span>
                  {renamingId === f.id ? (
                    <input
                      autoFocus value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={submitRename}
                      onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenamingId(null); }}
                      onClick={e => e.stopPropagation()}
                      style={{ flex: 1, background: 'var(--win-bg, #111)', border: '1px solid var(--win-accent, #2b6b9b)', color: 'var(--win-text, #fff)', fontSize: 12, padding: '1px 4px', borderRadius: 3 }}
                    />
                  ) : (
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{f.name}</span>
                  )}
                </div>
                {!isCollapsed && renderTree(f.id, depth + 1)}
              </div>
            );
          }
          const s = (sessions || []).find(x => x.id === item.id);
          if (!s) return null;
          const active = s.id === sessionId;
          const isSelected = (selected?.type === 'session' && selected.id === s.id) || selectedIds.has(s.id);
          return (
            <div
              key={s.id}
              className="session-item"
              draggable
              onDragStart={() => { dragSessionIdRef.current = s.id; }}
              onDragEnd={() => { dragSessionIdRef.current = null; }}
              onClick={e => onItemClick(s.id, 'session', e)}
              onDoubleClick={() => { if (renamingId !== s.id) onSessionChange(s.id, s.name); }}
              onContextMenu={e => { e.preventDefault(); if (!selectedIds.has(s.id)) { setSelected({ id: s.id, type: 'session' }); setSelectedIds(new Set()); } setContextMenu({ x: e.clientX, y: e.clientY, id: s.id, type: 'session', name: s.name, folderId: s.folderId }); }}
              style={{
                padding: `6px 8px 6px ${16 + depth * 16}px`, cursor: 'pointer',
                background: isSelected ? 'var(--win-surface, #222)' : (active ? 'rgba(43, 107, 155, 0.18)' : 'transparent'),
                borderLeft: active ? '3px solid var(--win-accent, #2b6b9b)' : '3px solid transparent',
                borderBottom: '1px solid var(--win-border, #1a1a1a)',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: active ? 700 : 400, color: active ? 'var(--win-text, #fff)' : 'var(--win-text-dim, #ddd)' }}>
                {renamingId === s.id ? (
                  <input
                    autoFocus value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={submitRename}
                    onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenamingId(null); }}
                    onClick={e => e.stopPropagation()}
                    style={{ width: '100%', background: 'var(--win-bg, #111)', border: '1px solid var(--win-accent, #2b6b9b)', color: 'var(--win-text, #fff)', fontSize: 12, padding: '1px 4px', borderRadius: 3 }}
                  />
                ) : (
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{active ? '🔌 ' : ''}{s.name}</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--win-text-dim, #888)', marginTop: 2 }}>{s.dbms.type} · {s.dbms.host}:{s.dbms.port}</div>
            </div>
          );
        })}
      </>
    );
  };

  const scopeLabel: Record<SearchScope, string> = { name: t('scopeName'), all: t('scopeAll') };

  const sidebarClass = `sql-tool-sidebar ${!pinned ? 'auto-hide' : ''} ${!pinned && !visible ? 'hidden' : ''}`;
  const sidebarInner = (
    <div
      className={sidebarClass}
      style={pinned ? { width } : { width, position: 'absolute', left: 22, top: 0, bottom: 0 }}
      onMouseEnter={onEnterSidebar}
      onMouseLeave={onLeaveSidebar}
      onKeyDown={e => {
        if (e.key === 'Delete' && (selected || selectedIds.size > 0)) { e.preventDefault(); void handleDelete(); }
        if (e.key === 'F2' && selected) { e.preventDefault(); const name = selected.type === 'folder' ? folders.find(f => f.id === selected.id)?.name : sessions?.find(s => s.id === selected.id)?.name; if (name) startRename(selected.id, selected.type, name); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selected && !renamingId) { e.preventDefault(); handleCopy(); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !renamingId) { e.preventDefault(); handlePaste(); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowUp' && selected) {
          e.preventDefault();
          (async () => { await api.sqlSessionsReorder?.(selected.id, selected.type, 'up'); await load(); })();
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowDown' && selected) {
          e.preventDefault();
          (async () => { await api.sqlSessionsReorder?.(selected.id, selected.type, 'down'); await load(); })();
        }
      }}
    >
      <div className="session-toolbar">
        <div className="session-toolbar-title">🗄️ {t('sidebarTitle')}</div>
        <span style={{ display: 'flex', gap: 2 }}>
          <button className="btn-icon-plain" onClick={handleExport} title={t('sidebarExport')}>📤</button>
          <button className="btn-icon-plain" onClick={handleImport} title={t('sidebarImport')}>📥</button>
          <button
            className={`btn-pin claude-chat-pin ${pinned ? 'pinned' : ''}`}
            onClick={() => { const next = !pinned; setPinned(next); if (!next) setVisible(false); }}
            title={pinned ? t('sidebarUnpin') : t('sidebarPin')}
          >📌</button>
        </span>
      </div>

      <div className="session-bottom-actions">
        <button className="btn-add" onClick={handleAddFolder} title={t('sidebarAddFolder')}>📁+</button>
        <button className="btn-add" onClick={handleAdd}>{t('sidebarAdd')}</button>
        <button className="btn-edit" onClick={handleEdit} disabled={!selected || selected.type !== 'session' || selectedIds.size > 0}>{t('pickerEdit')}</button>
        <button className="btn-delete" onClick={handleDelete} disabled={!selected && selectedIds.size === 0}>{t('sidebarDelete')}</button>
      </div>

      <div className="session-search-bar">
        <select
          className="session-search-select"
          value={searchScope}
          onChange={e => setSearchScope(e.target.value as SearchScope)}
        >
          <option value="name">{t('scopeName')}</option>
          <option value="all">{t('scopeAll')}</option>
        </select>
        <input
          className="session-search-input"
          value={searchValue}
          onChange={e => setSearchValue(e.target.value)}
          placeholder={t('searchPlaceholder', { scope: scopeLabel[searchScope] })}
          spellCheck={false}
        />
        {searchValue && (
          <button className="session-search-clear" type="button" onClick={() => setSearchValue('')} title={t('searchClear')}>×</button>
        )}
      </div>

      <div
        className="session-list-scroll"
        tabIndex={0}
        onClick={e => { if (e.target === e.currentTarget) { setSelected(null); setSelectedIds(new Set()); } }}
        onDragOver={e => { e.preventDefault(); setDragOverId(null); }}
        onDrop={e => {
          e.preventDefault();
          setDragOverId(undefined);
          const sid = dragSessionIdRef.current;
          if (sid) moveSessionToFolder(sid, null);
        }}
      >
        {sessions === null ? null : (sessions.length === 0 && folders.length === 0) ? (
          <div style={{ padding: '16px 12px', color: 'var(--win-text-dim, #888)', fontSize: 12, lineHeight: 1.5 }}>{t('pickerEmpty')}</div>
        ) : renderTree(undefined, 0)}
      </div>
      <div className="session-resize-handle" onPointerDown={onResizePointerDown} />
    </div>
  );

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0, width: '100%', height: '100%', background: 'var(--win-bg, #0d0f10)' }}>
      <div className="sql-tool-sidebar-wrap">
        {!pinned && (
          <div
            className="sql-tool-sidebar-trigger"
            onClick={onClickTrigger}
            onMouseEnter={onEnterTrigger}
            onMouseLeave={onLeaveTrigger}
          >
            <div className="sql-tool-sidebar-trigger-top">
              <span className="sql-tool-sidebar-trigger-text">🗄️ {t('sidebarTitle')}</span>
            </div>
          </div>
        )}
        {sidebarInner}
      </div>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', overflow: 'hidden' }}>
        {sessionId
          ? <SqlToolWorkspace key={sessionId} sessionId={sessionId} sessionName={sessionName} />
          : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--win-text-dim, #888)', fontSize: 13, padding: 24, textAlign: 'center' }}>
              {t('pickerSubtitle')}
            </div>
          )}
      </div>
      {editing && <SqlSessionEditor session={editing} onSave={saveEditing} onCancel={() => setEditing(null)} />}
      {contextMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={closeContextMenu} onContextMenu={e => { e.preventDefault(); closeContextMenu(); }} />
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y, minWidth: 160 }}>
            <div
              className="context-menu-item"
              onClick={() => { startRename(contextMenu.id, contextMenu.type, contextMenu.name); closeContextMenu(); }}
            ><span className="context-menu-icon">✏️</span>{t('sidebarRename')}</div>
            {contextMenu.type === 'session' && (
              <div
                className="context-menu-item"
                onClick={() => { const s = sessions?.find(x => x.id === contextMenu.id); if (s) setEditing(s); closeContextMenu(); }}
              ><span className="context-menu-icon">✎</span>{t('pickerEdit')}</div>
            )}
            {contextMenu.type === 'session' && contextMenu.folderId && (
              <div
                className="context-menu-item"
                onClick={() => { moveSessionToFolder(contextMenu.id, null); closeContextMenu(); }}
              ><span className="context-menu-icon">📤</span>{t('sidebarMoveToRoot')}</div>
            )}
            <div
              className="context-menu-item"
              onClick={() => {
                if (contextMenu.type === 'session') {
                  const s = sessions?.find(x => x.id === contextMenu.id);
                  if (s) { setCopiedSession(s); setCopiedFolder(null); }
                } else {
                  handleCopyFolder(contextMenu.id);
                }
                closeContextMenu();
              }}
            ><span className="context-menu-icon">📋</span>{t('ctxCopy')}</div>
            {(copiedSession || copiedFolder) && (
              <div
                className="context-menu-item"
                onClick={() => {
                  if (copiedFolder) {
                    const target = contextMenu.type === 'folder' ? contextMenu.id : null;
                    void handlePasteFolder(target);
                  } else if (copiedSession) {
                    const targetFolderId = contextMenu.type === 'folder' ? contextMenu.id : copiedSession.folderId ?? undefined;
                    void duplicateSession(copiedSession, targetFolderId);
                  }
                  closeContextMenu();
                }}
              ><span className="context-menu-icon">📌</span>{t('ctxPaste')}</div>
            )}
            <div className="context-menu-separator" />
            <div
              className="context-menu-item"
              onClick={() => {
                if (selectedIds.size > 1 && selectedIds.has(contextMenu.id)) void handleDelete();
                else void deleteItem(contextMenu.id, contextMenu.type);
                closeContextMenu();
              }}
              style={{ color: '#e57373' }}
            ><span className="context-menu-icon">🗑</span>{t('sidebarDelete')}</div>
          </div>
        </>
      )}
    </div>
  );
};
