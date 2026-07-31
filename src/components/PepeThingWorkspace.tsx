// src/components/PepeThingWorkspace.tsx
// Pepe-Thing — voidtools Everything 의 로컬 파일 인덱스를 그대로 조회하는 검색 워크스페이스.
// 자체 인덱싱은 하지 않는다: 이미 설치되어 상주 중인 Everything.exe 의 인덱스를
// electron/everythingService.ts(koffi 로 Everything64.dll 직접 호출)를 통해 조회만 한다.
// Everything 이 설치/실행되어 있지 않으면 설치 안내로 대체 표시.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FixedSizeList as VList, ListChildComponentProps } from 'react-window';
import { useTranslation } from 'react-i18next';
import { ContextMenu, MenuItem } from './ContextMenu';
import { notifyConfirm } from './Notify';
import type { OfficeFormat } from './OfficeLauncher';
import { isMediaExtension, getOfficeFormatForFile } from '../utils/openableFileTypes';

const api = (window as any).api || {};
const EVERYTHING_DOWNLOAD_URL = 'https://www.voidtools.com/ko-kr/downloads/';

type EverythingResult = {
  name: string;
  path: string;
  fullPath: string;
  size: number | null;
  dateModified: number | null;
  isFolder: boolean;
};

function formatBytes(n: number | null): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function formatDate(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

type Props = {
  onOpenInMedia?: (filePath: string, fileName: string) => void;
  onOpenInOffice?: (format: OfficeFormat, filePath: string, fileName: string) => void;
};

export const PepeThingWorkspace: React.FC<Props> = ({ onOpenInMedia, onOpenInOffice }) => {
  const { t } = useTranslation('pepeThing');
  const [available, setAvailable] = useState<{ checked: boolean; ok: boolean; reason?: string }>({ checked: false, ok: false });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<EverythingResult[]>([]);
  const [total, setTotal] = useState(0);
  const [matchCase, setMatchCase] = useState(false);
  const [matchWholeWord, setMatchWholeWord] = useState(false);
  const [matchPath, setMatchPath] = useState(false);
  const [regex, setRegex] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; result: EverythingResult } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);

  const checkAvailability = useCallback(async () => {
    setAvailable(prev => ({ ...prev, checked: false }));
    try {
      const res = await api.everythingIsAvailable?.();
      setAvailable({ checked: true, ok: !!res?.available, reason: res?.reason });
    } catch (err: any) {
      setAvailable({ checked: true, ok: false, reason: String(err?.message || err) });
    }
  }, []);

  useEffect(() => { checkAvailability(); }, [checkAvailability]);

  const runSearch = useCallback(async (q: string) => {
    const seq = ++requestSeqRef.current;
    if (!q.trim()) { setResults([]); setTotal(0); return; }
    try {
      const res = await api.everythingSearch?.(q, { matchCase, matchWholeWord, matchPath, regex, max: 500 });
      if (seq !== requestSeqRef.current) return; // 늦게 도착한 이전 검색 응답은 버림
      if (!res?.ok) {
        setResults([]);
        setTotal(0);
        if (res?.reason === 'not-running') setAvailable({ checked: true, ok: false, reason: 'not-running' });
        return;
      }
      setResults(res.results || []);
      setTotal(res.total || 0);
    } catch {
      if (seq !== requestSeqRef.current) return;
      setResults([]);
      setTotal(0);
    }
  }, [matchCase, matchWholeWord, matchPath, regex]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { runSearch(query); }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, runSearch]);

  const openResult = useCallback(async (r: EverythingResult) => {
    if (r.isFolder) { api.shellOpenPath?.(r.fullPath); return; }
    if (isMediaExtension(r.name) && onOpenInMedia) {
      const yes = await notifyConfirm(t('openInMediaTitle'), t('openInMediaBody', { name: r.name }));
      if (yes) { onOpenInMedia(r.fullPath, r.name); return; }
      api.shellOpenPath?.(r.fullPath);
      return;
    }
    const officeFormat = getOfficeFormatForFile(r.name);
    if (officeFormat && onOpenInOffice) {
      const yes = await notifyConfirm(t('openInOfficeTitle'), t('openInOfficeBody', { name: r.name }));
      if (yes) { onOpenInOffice(officeFormat, r.fullPath, r.name); return; }
      api.shellOpenPath?.(r.fullPath);
      return;
    }
    api.shellOpenPath?.(r.fullPath);
  }, [onOpenInMedia, onOpenInOffice, t]);
  const revealResult = useCallback((r: EverythingResult) => {
    api.shellShowItem?.(r.fullPath);
  }, []);
  const copyPath = useCallback((r: EverythingResult) => {
    try { navigator.clipboard.writeText(r.fullPath); } catch {}
  }, []);

  if (available.checked && !available.ok) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 14, padding: 24, textAlign: 'center', color: '#ddd', background: '#14141f' }}>
        <div style={{ fontSize: 32 }}>🔎</div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{t('notInstalledTitle')}</div>
        <div style={{ fontSize: 12.5, color: '#9aa', maxWidth: 420, lineHeight: 1.6 }}>{t('notInstalledBody')}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => api.shellOpenExternal?.(EVERYTHING_DOWNLOAD_URL)}
            style={{ padding: '7px 16px', borderRadius: 4, border: '1px solid #3a3a5a', background: '#2b6b9b', color: '#fff', cursor: 'pointer', fontSize: 13 }}
          >
            {t('downloadButton')}
          </button>
          <button
            onClick={checkAvailability}
            style={{ padding: '7px 16px', borderRadius: 4, border: '1px solid #3a3a5a', background: '#1a1a2e', color: '#ccc', cursor: 'pointer', fontSize: 13 }}
          >
            {t('retryButton')}
          </button>
        </div>
      </div>
    );
  }

  const Row = ({ index, style }: ListChildComponentProps) => {
    const r = results[index];
    return (
      <div
        style={{ ...style, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', borderBottom: '1px solid #22222f', cursor: 'default', fontSize: 12.5 }}
        onDoubleClick={() => openResult(r)}
        onContextMenu={e => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY, result: r });
        }}
        title={r.fullPath}
      >
        <span style={{ flex: '0 0 18px', textAlign: 'center' }}>{r.isFolder ? '📁' : '📄'}</span>
        <span style={{ flex: '1 1 32%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
        <span style={{ flex: '1 1 40%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#9aa' }}>{r.path}</span>
        <span style={{ flex: '0 0 80px', textAlign: 'right', color: '#9aa' }}>{r.isFolder ? '' : formatBytes(r.size)}</span>
        <span style={{ flex: '0 0 150px', textAlign: 'right', color: '#9aa' }}>{formatDate(r.dateModified)}</span>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minWidth: 0, minHeight: 0, background: '#14141f', color: '#ddd' }}>
      <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderBottom: '1px solid #2a2a3a' }}>
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
          style={{ background: '#1a1a2e', color: '#eee', border: '1px solid #3a3a5a', borderRadius: 4, padding: '7px 10px', fontSize: 13.5 }}
        />
        <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: '#9aa' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={matchCase} onChange={e => setMatchCase(e.target.checked)} /> {t('matchCase')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={matchWholeWord} onChange={e => setMatchWholeWord(e.target.checked)} /> {t('matchWholeWord')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={matchPath} onChange={e => setMatchPath(e.target.checked)} /> {t('matchPath')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={regex} onChange={e => setRegex(e.target.checked)} /> {t('regex')}
          </label>
        </div>
      </div>

      <div style={{ flex: '0 0 auto', padding: '6px 10px', fontSize: 11, color: '#889', borderBottom: '1px solid #2a2a3a' }}>
        {query.trim()
          ? (results.length > 0 ? t('resultCount', { n: results.length, total }) : t('noResults'))
          : t('typeToSearch')}
      </div>

      {results.length > 0 && (
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '4px 10px', fontSize: 11, color: '#778', borderBottom: '1px solid #22222f' }}>
          <span style={{ flex: '0 0 18px' }} />
          <span style={{ flex: '1 1 32%' }}>{t('colName')}</span>
          <span style={{ flex: '1 1 40%' }}>{t('colPath')}</span>
          <span style={{ flex: '0 0 80px', textAlign: 'right' }}>{t('colSize')}</span>
          <span style={{ flex: '0 0 150px', textAlign: 'right' }}>{t('colDateModified')}</span>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {results.length > 0 && (
          <AutoSizedList itemCount={results.length} Row={Row} />
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            { label: t('openFile'), onClick: () => openResult(contextMenu.result) },
            { label: t('openFolder'), onClick: () => revealResult(contextMenu.result) },
            { separator: true },
            { label: t('copyPath'), onClick: () => copyPath(contextMenu.result) },
          ] as MenuItem[]}
        />
      )}
    </div>
  );
};

// react-window 는 명시적 픽셀 height 가 필요 — 부모(flex:1) 의 실제 렌더 높이를 ResizeObserver 로 측정.
const AutoSizedList: React.FC<{ itemCount: number; Row: React.FC<ListChildComponentProps> }> = ({ itemCount, Row }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      {size.width > 0 && size.height > 0 && (
        <VList width={size.width} height={size.height} itemCount={itemCount} itemSize={26}>
          {Row}
        </VList>
      )}
    </div>
  );
};

export default PepeThingWorkspace;
