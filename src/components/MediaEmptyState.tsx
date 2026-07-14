// src/components/MediaEmptyState.tsx
// 미디어 워크스페이스의 "아직 아무 문서도 안 열림" 상태 — OfficeEmptyState 와 같은 레이아웃이되
// 왼쪽 패널을 위(최근 문서)/아래(재생리스트) 절반으로 나눈다.
// - 최근 문서: 여러 개 Ctrl/Shift 클릭으로 다중 선택 후 우클릭 → 재생리스트에 추가.
// - 재생리스트: 드래그로 순서 변경 가능, 연속재생은 상위(MediaWorkspace)가 순서를 따라간다.
// pcap/pcapng 파일은 재생리스트에 넣지 않는다(RTP 스트림 선택이 필요해 자동 연속재생과 안 맞음).
import { useMemo, useState } from 'react';
import type { MediaRecentDoc } from '../utils/mediaRecents';
import type { MediaPlaylistItem } from '../utils/mediaPlaylist';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} style={{ background: 'var(--win-accent, #2b6b9b)', color: '#fff', borderRadius: 2, padding: '0 1px' }}>{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

const isPcapFileName = (fileName: string) => /\.(pcap|pcapng|cap)$/i.test(fileName);

type ContextMenuState = { x: number; y: number; filePaths: string[] } | null;

export function MediaEmptyState({
  recents, onOpenRecent, onRemoveRecent, message,
  playlist, onOpenPlaylistItem, onRemovePlaylistItem, onReorderPlaylist, onAddToPlaylist,
}: {
  recents: MediaRecentDoc[];
  onOpenRecent: (doc: MediaRecentDoc) => void;
  onRemoveRecent: (filePath: string) => void;
  message: string;
  playlist: MediaPlaylistItem[];
  onOpenPlaylistItem: (item: MediaPlaylistItem) => void;
  onRemovePlaylistItem: (filePath: string) => void;
  onReorderPlaylist: (orderedFilePaths: string[]) => void;
  onAddToPlaylist: (docs: { filePath: string; fileName: string; codec?: string }[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClickedIdx, setLastClickedIdx] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recents;
    return recents.filter(r => r.fileName.toLowerCase().includes(q) || r.filePath.toLowerCase().includes(q));
  }, [recents, query]);

  const handleRowClick = (doc: MediaRecentDoc, idx: number, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(doc.filePath)) next.delete(doc.filePath); else next.add(doc.filePath);
        return next;
      });
      setLastClickedIdx(idx);
      return;
    }
    if (e.shiftKey && lastClickedIdx !== null) {
      const [from, to] = idx < lastClickedIdx ? [idx, lastClickedIdx] : [lastClickedIdx, idx];
      setSelected(new Set(filtered.slice(from, to + 1).map(r => r.filePath)));
      return;
    }
    setSelected(new Set());
    setLastClickedIdx(idx);
    onOpenRecent(doc);
  };

  const handleContextMenu = (doc: MediaRecentDoc, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 우클릭한 항목이 이미 선택되어 있으면 선택 전체를, 아니면 이 항목 단독을 대상으로 한다.
    const filePaths = selected.has(doc.filePath) && selected.size > 0 ? Array.from(selected) : [doc.filePath];
    setContextMenu({ x: e.clientX, y: e.clientY, filePaths });
  };

  const handleAddSelectedToPlaylist = () => {
    if (!contextMenu) return;
    const docsToAdd = recents
      .filter(r => contextMenu.filePaths.includes(r.filePath))
      .filter(r => !isPcapFileName(r.fileName))
      .map(r => ({ filePath: r.filePath, fileName: r.fileName, codec: r.codec }));
    onAddToPlaylist(docsToAdd);
    setContextMenu(null);
    setSelected(new Set());
  };

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }} onClick={() => setContextMenu(null)}>
      <div style={{ width: 280, flex: '0 0 auto', borderRight: '1px solid var(--win-border, #30363d)', display: 'flex', flexDirection: 'column' }}>
        {/* ── 위쪽 절반: 최근 문서 ── */}
        <div style={{ flex: '1 1 50%', minHeight: 0, display: 'flex', flexDirection: 'column', borderBottom: '1px solid var(--win-border, #30363d)' }}>
          <div style={{ padding: 10, paddingBottom: 6, flex: '0 0 auto' }}>
            <div style={{ fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)', marginBottom: 8, fontWeight: 600 }}>
              최근 문서 {selected.size > 0 && `(${selected.size}개 선택됨)`}
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="문서 검색..."
              style={{
                width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6,
                border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface, #161b22)',
                color: 'var(--win-text, #e6edf3)', fontSize: 12,
              }}
            />
          </div>
          <div style={{ flex: '1 1 0', overflowY: 'auto', padding: '0 10px 10px' }}>
            {filtered.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)' }}>
                {recents.length === 0 ? '최근에 연 문서가 없습니다.' : '검색 결과가 없습니다.'}
              </div>
            )}
            {filtered.map((r, idx) => {
              const isSelected = selected.has(r.filePath);
              return (
                <div
                  key={r.filePath}
                  onClick={(e) => { e.stopPropagation(); handleRowClick(r, idx, e); }}
                  onContextMenu={(e) => handleContextMenu(r, e)}
                  title={`${r.filePath}\n(우클릭: 재생리스트에 추가, Ctrl/Shift+클릭: 다중 선택)`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 6,
                    cursor: 'pointer', fontSize: 12, color: 'var(--win-text, #e6edf3)',
                    background: isSelected ? 'var(--win-accent, #2b6b9b)' : 'transparent',
                  }}
                  onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--win-surface, #161b22)'; }}
                  onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                >
                  <span>{isPcapFileName(r.fileName) ? '📡' : '📄'}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <HighlightedText text={r.fileName} query={query} />
                  </span>
                  <span
                    onClick={(e) => { e.stopPropagation(); onRemoveRecent(r.filePath); }}
                    style={{ opacity: 0.6, padding: '0 2px' }}
                  >×</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── 아래쪽 절반: 재생리스트 ── */}
        <div style={{ flex: '1 1 50%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 10, paddingBottom: 6, flex: '0 0 auto', fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)', fontWeight: 600 }}>
            🎶 재생리스트 {playlist.length > 0 && `(${playlist.length}곡)`}
          </div>
          <div style={{ flex: '1 1 0', overflowY: 'auto', padding: '0 10px 10px' }}>
            {playlist.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)' }}>
                최근 문서에서 우클릭으로 추가하세요.
              </div>
            )}
            {playlist.map((item, idx) => (
              <div
                key={item.filePath}
                draggable
                onDragStart={(e) => {
                  setDraggingPath(item.filePath);
                  e.dataTransfer.effectAllowed = 'move';
                  try { e.dataTransfer.setData('text/x-pepe-playlist-item', item.filePath); } catch {}
                }}
                onDragEnd={() => { setDraggingPath(null); setDragOverPath(null); }}
                onDragOver={(e) => {
                  if (!draggingPath || draggingPath === item.filePath) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dragOverPath !== item.filePath) setDragOverPath(item.filePath);
                }}
                onDragLeave={() => { if (dragOverPath === item.filePath) setDragOverPath(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverPath(null);
                  if (!draggingPath || draggingPath === item.filePath) { setDraggingPath(null); return; }
                  const order = playlist.map(p => p.filePath);
                  const fromIdx = order.indexOf(draggingPath);
                  const toIdx = order.indexOf(item.filePath);
                  if (fromIdx < 0 || toIdx < 0) { setDraggingPath(null); return; }
                  order.splice(fromIdx, 1);
                  order.splice(toIdx, 0, draggingPath);
                  onReorderPlaylist(order);
                  setDraggingPath(null);
                }}
                onClick={(e) => { e.stopPropagation(); onOpenPlaylistItem(item); }}
                title={item.filePath}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 6,
                  cursor: 'grab', fontSize: 12, color: 'var(--win-text, #e6edf3)',
                  background: dragOverPath === item.filePath ? 'var(--win-accent, #2b6b9b)' : 'transparent',
                  opacity: draggingPath === item.filePath ? 0.4 : 1,
                  border: '1px solid transparent',
                }}
                onMouseEnter={(e) => { if (dragOverPath !== item.filePath) e.currentTarget.style.background = 'var(--win-surface, #161b22)'; }}
                onMouseLeave={(e) => { if (dragOverPath !== item.filePath) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ opacity: 0.5, fontSize: 10, width: 16, textAlign: 'right' }}>{idx + 1}</span>
                <span>🎵</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.fileName}</span>
                <span
                  onClick={(e) => { e.stopPropagation(); onRemovePlaylistItem(item.filePath); }}
                  style={{ opacity: 0.6, padding: '0 2px' }}
                >×</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div style={{ flex: '1 1 0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--win-text-dim, #9aa7b3)', fontSize: 13, textAlign: 'center', padding: 16 }}>
        {message}
      </div>
      {contextMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 10000,
            background: 'var(--win-surface, #161b22)', border: '1px solid var(--win-border, #30363d)',
            borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', padding: 4, minWidth: 180,
          }}
        >
          <div
            onClick={handleAddSelectedToPlaylist}
            style={{ padding: '6px 10px', fontSize: 12, color: 'var(--win-text, #e6edf3)', cursor: 'pointer', borderRadius: 4, whiteSpace: 'nowrap' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--win-accent, #2b6b9b)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            🎶 재생리스트에 추가 {contextMenu.filePaths.length > 1 && `(${contextMenu.filePaths.length}개)`}
          </div>
        </div>
      )}
    </div>
  );
}
