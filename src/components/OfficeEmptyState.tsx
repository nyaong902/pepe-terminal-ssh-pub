// src/components/OfficeEmptyState.tsx
// 오피스 형식별 에디터의 "아직 아무 문서도 안 열림" 상태 — 왼쪽에 최근 문서 목록(검색 가능),
// 오른쪽에 안내 문구.
import { useMemo, useState } from 'react';
import type { RecentDoc } from '../utils/officeRecents';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 검색어와 일치하는 부분만 <mark> 로 감싸 하이라이트 — 대소문자 무시.
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

export function OfficeEmptyState({ recents, onOpenRecent, onRemoveRecent, message }: {
  recents: RecentDoc[];
  onOpenRecent: (doc: RecentDoc) => void;
  onRemoveRecent: (filePath: string) => void;
  message: string;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recents;
    return recents.filter(r => r.fileName.toLowerCase().includes(q) || r.filePath.toLowerCase().includes(q));
  }, [recents, query]);

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <div style={{ width: 260, flex: '0 0 auto', borderRight: '1px solid var(--win-border, #30363d)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 10, paddingBottom: 6 }}>
          <div style={{ fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)', marginBottom: 8, fontWeight: 600 }}>최근 문서</div>
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
          {filtered.map(r => (
            <div
              key={r.filePath}
              onClick={() => onOpenRecent(r)}
              title={r.filePath}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 6,
                cursor: 'pointer', fontSize: 12, color: 'var(--win-text, #e6edf3)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--win-surface, #161b22)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span>📄</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <HighlightedText text={r.fileName} query={query} />
              </span>
              <span
                onClick={(e) => { e.stopPropagation(); onRemoveRecent(r.filePath); }}
                style={{ opacity: 0.6, padding: '0 2px' }}
              >×</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: '1 1 0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--win-text-dim, #9aa7b3)', fontSize: 13, textAlign: 'center', padding: 16 }}>
        {message}
      </div>
    </div>
  );
}
