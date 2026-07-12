// src/components/SearchBar.tsx
import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { Tab } from '../App';
import { collectAllSessions } from '../utils/layoutUtils';
import {
  searchInTerm,
  searchNextInTerm,
  searchPrevInTerm,
  clearSearchInTerm,
  getAllTermIds,
  highlightAllMatches,
  clearHighlights,
  searchFromTop,
  markSearchAnchor,
  clearSearchAnchor,
} from './TerminalPanel';

type Props = {
  tabs: Tab[];
  activeTab: Tab;
  selectedPanelId: string | null;
  onNavigateToTerm?: (termId: string) => void;
  onClose: () => void;
};

type MatchResult = { termId: string; sessionName: string; tabTitle: string };

export const SearchBar: React.FC<Props> = ({ tabs, activeTab, selectedPanelId, onNavigateToTerm, onClose }) => {
  const { t } = useTranslation('search');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'current' | 'all'>('current');
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [historyIdx, setHistoryIdx] = useState(-1);
  // 검색 이력 — 예전엔 이 컴포넌트 모듈 전역 배열에만 담아둬서 렌더러가 리로드되면(HMR·앱 재시작)
  // 그냥 사라졌다. 이제 electron/main.ts 가 파일(<userData>/search-history.json)로 영속화한다.
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  useEffect(() => {
    (window as any).api?.searchHistoryGet?.().then((h: string[]) => setSearchHistory(h || []));
  }, []);
  const addSearchHistory = (q: string) => {
    if (!q.trim()) return;
    try { (window as any).api?.searchHistoryAdd?.(q); } catch {}
    setSearchHistory(prev => [q, ...prev.filter(x => x !== q)].slice(0, 50));
  };
  const inputRef = useRef<HTMLInputElement>(null);
  // 기본은 고정 위치 — "분리" 버튼을 눌러야만 자유롭게 드래그해서 옮길 수 있는 상태(움직이는 모드)로
  // 전환된다. 별도 OS 창을 띄우던 예전 방식은 위치/크기가 계속 어긋나서 걷어내고, 그냥 이 인라인
  // 검색줄 자체를 움직이게/고정으로 토글하는 걸로 단순화했다.
  const [detached, setDetached] = useState(false);
  // null 이면 App.css 의 기본 위치(top/right 고정)를 그대로 쓴다.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const onGripMouseDown = (e: React.MouseEvent) => {
    if (!detached) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = e.clientX, startY = e.clientY;
    const origX = pos?.x ?? rect.left;
    const origY = pos?.y ?? rect.top;
    const onMove = (ev: MouseEvent) => {
      const maxX = window.innerWidth - (barRef.current?.offsetWidth ?? 0);
      const maxY = window.innerHeight - (barRef.current?.offsetHeight ?? 0);
      const nx = Math.min(Math.max(0, origX + (ev.clientX - startX)), Math.max(0, maxX));
      const ny = Math.min(Math.max(0, origY + (ev.clientY - startY)), Math.max(0, maxY));
      setPos({ x: nx, y: ny });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    // 검색 시작 — 모든 터미널의 현재 스크롤 위치를 anchor 로 저장.
    // 매치가 없을 때 이 위치로 되돌려, 스크롤이 맨 위로 튀는 문제 방지.
    for (const tid of getAllTermIds()) markSearchAnchor(tid);
    return () => { for (const tid of getAllTermIds()) clearSearchAnchor(tid); };
  }, []);

  // 모드 변경 시에만 자동 검색
  useEffect(() => {
    if (!query) return;
    try {
      if (mode === 'current') {
        searchCurrent();
      } else {
        searchAll();
      }
    } catch {}
  }, [mode]);

  // query/regex/caseSensitive/mode 변경 시: 모든 매치 하이라이트 + 맨 위부터 검색 시작 (새 검색).
  useEffect(() => {
    for (const tid of getAllTermIds()) clearHighlights(tid);
    if (!query) return;
    if (mode === 'current') {
      const termId = getActiveTermId();
      if (termId) {
        highlightAllMatches(termId, query, useRegex, caseSensitive);
        searchFromTop(termId, query, useRegex, caseSensitive);
      }
    } else {
      for (const tab of tabs) {
        const sessions = collectAllSessions(tab.layout);
        for (const sess of sessions) {
          highlightAllMatches(sess.termId, query, useRegex, caseSensitive);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, useRegex, caseSensitive, mode]);

  // 미니탭 전환 시 anchor(Next/Prev 실패 시 복귀 위치)만 그 미니탭의 현재 위치로 갱신한다.
  // 하이라이트 자체는 이제 xterm-addon-search 의 네이티브 decorations(마커 기반)를 쓰므로
  // DOM 이 어떻게 옮겨붙든(미니탭 전환으로 xterm 엘리먼트가 컨테이너를 바꿔도) 별도로 다시
  // 칠해줄 필요가 없다 — 예전 커스텀 DOM 오버레이 시절엔 미니탭 전환마다 오버레이가 통째로
  // 날아가서 직접 복구해야 했지만, 마커는 버퍼(Terminal 인스턴스)에 묶여 있어 DOM 과 무관하게
  // 유지된다("다른 미니탭에서 활성화 전환했더니 처음부터 찾는다" 문제도 anchor 로 계속 해결됨).
  const activeTermId = mode === 'current' ? (() => {
    if (!selectedPanelId) return null;
    const findInLayout = (node: any): string | null => {
      if (node.type === 'leaf' && node.id === selectedPanelId) {
        const sess = node.panel.sessions[node.panel.activeIdx];
        return sess?.termId ?? null;
      }
      if (node.children) for (const c of node.children) { const r = findInLayout(c); if (r) return r; }
      return null;
    };
    return findInLayout(activeTab.layout);
  })() : null;
  useEffect(() => {
    if (!query || !activeTermId) return;
    try { markSearchAnchor(activeTermId); } catch {}
  }, [activeTermId]);

  const getActiveTermId = (): string | null => {
    if (!selectedPanelId) return null;
    const findInLayout = (node: any): string | null => {
      if (node.type === 'leaf' && node.id === selectedPanelId) {
        const sess = node.panel.sessions[node.panel.activeIdx];
        return sess?.termId ?? null;
      }
      if (node.children) {
        for (const c of node.children) { const r = findInLayout(c); if (r) return r; }
      }
      return null;
    };
    return findInLayout(activeTab.layout);
  };

  const searchCurrent = () => {
    const termId = getActiveTermId();
    if (!termId || !query) return;
    searchInTerm(termId, query, useRegex, caseSensitive);
  };

  const searchAll = () => {
    try {
      const results: MatchResult[] = [];
      for (const tab of tabs) {
        const sessions = collectAllSessions(tab.layout);
        for (const sess of sessions) {
          try {
            const found = searchInTerm(sess.termId, query, useRegex, caseSensitive);
            if (found) {
              results.push({ termId: sess.termId, sessionName: sess.sessionName, tabTitle: tab.title });
            }
          } catch {}
        }
      }
      setMatches(results);
      setActiveMatchIdx(0);
    } catch {}
  };

  const clearAll = () => {
    for (const termId of getAllTermIds()) {
      clearSearchInTerm(termId);
    }
  };

  const handleNext = () => {
    if (mode === 'current') {
      const termId = getActiveTermId();
      if (termId && query) searchNextInTerm(termId, query, useRegex, caseSensitive);
    } else {
      if (matches.length === 0) return;
      const nextIdx = (activeMatchIdx + 1) % matches.length;
      setActiveMatchIdx(nextIdx);
      onNavigateToTerm?.(matches[nextIdx].termId);
      searchNextInTerm(matches[nextIdx].termId, query, useRegex, caseSensitive);
    }
  };

  const handlePrev = () => {
    if (mode === 'current') {
      const termId = getActiveTermId();
      if (termId && query) searchPrevInTerm(termId, query, useRegex, caseSensitive);
    } else {
      if (matches.length === 0) return;
      const prevIdx = (activeMatchIdx - 1 + matches.length) % matches.length;
      setActiveMatchIdx(prevIdx);
      onNavigateToTerm?.(matches[prevIdx].termId);
      searchPrevInTerm(matches[prevIdx].termId, query, useRegex, caseSensitive);
    }
  };

  const handleClose = () => {
    clearAll();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      if (showHistory) { setShowHistory(false); setHistoryIdx(-1); return; }
      handleClose(); return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (searchHistory.length === 0) return;
      if (!showHistory) { setShowHistory(true); setHistoryIdx(0); setQuery(searchHistory[0]); return; }
      const next = Math.min(historyIdx + 1, searchHistory.length - 1);
      setHistoryIdx(next);
      setQuery(searchHistory[next]);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!showHistory) return;
      const next = historyIdx - 1;
      if (next < 0) { setHistoryIdx(-1); setShowHistory(false); return; }
      setHistoryIdx(next);
      setQuery(searchHistory[next]);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      setShowHistory(false); setHistoryIdx(-1);
      if (!query) return;
      addSearchHistory(query);
      if (e.shiftKey) handlePrev();
      else handleNext();
    }
  };

  // 검색바 내 모든 키/마우스 이벤트가 터미널로 전파되지 않도록 차단
  const stopProp = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      ref={barRef}
      className="search-bar"
      style={pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined}
      onKeyDown={stopProp} onKeyUp={stopProp} onKeyPress={stopProp} onMouseDown={stopProp} onClick={stopProp} onDoubleClick={stopProp}
    >
      <div className="search-bar-inner">
        <span
          className="search-drag-grip"
          onMouseDown={onGripMouseDown}
          title={detached ? t('dragToMove') : t('popout')}
          style={{ cursor: detached ? 'move' : 'default', opacity: detached ? 1 : 0.4 }}
        >⋮⋮</span>
        <span className="search-icon">🔍</span>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <div style={{ display: 'flex' }}>
            <input
              ref={inputRef}
              className="search-input"
              type="text"
              value={query}
              onChange={e => { setQuery(e.target.value); setShowHistory(false); setHistoryIdx(-1); }}
              onKeyDown={handleKeyDown}
              placeholder={t('placeholder')}
              autoComplete="off"
            />
            <button
              className="search-history-toggle"
              onClick={() => { setShowHistory(prev => !prev); inputRef.current?.focus(); }}
              title={t('history')}
              tabIndex={-1}
            >▾</button>
          </div>
          {showHistory && searchHistory.length > 0 && (
            <div className="search-history-dropdown">
              {searchHistory.map((h, i) => (
                <div
                  key={`${h}-${i}`}
                  ref={el => { if (el && i === historyIdx) el.scrollIntoView({ block: 'nearest' }); }}
                  className={`search-history-item ${i === historyIdx ? 'active' : ''}`}
                  onMouseDown={e => { e.preventDefault(); setQuery(h); setShowHistory(false); setHistoryIdx(-1); inputRef.current?.focus(); }}
                >{h}</div>
              ))}
            </div>
          )}
        </div>
        <button className="search-btn" onClick={handlePrev} title={t('prev')}>&#9650;</button>
        <button className="search-btn" onClick={handleNext} title={t('next')}>&#9660;</button>
        <button
          className={`search-regex-btn ${caseSensitive ? 'active' : ''}`}
          onClick={() => setCaseSensitive(prev => !prev)}
          title={t('caseSensitive')}
        >Aa</button>
        <button
          className={`search-regex-btn ${useRegex ? 'active' : ''}`}
          onClick={() => setUseRegex(prev => !prev)}
          title={t('regex')}
        >.*</button>
        <div className="search-mode-toggle">
          <button
            className={`search-mode-btn ${mode === 'current' ? 'active' : ''}`}
            onClick={() => setMode('current')}
          >
            {t('modeCurrent')}
          </button>
          <button
            className={`search-mode-btn ${mode === 'all' ? 'active' : ''}`}
            onClick={() => setMode('all')}
          >
            {t('modeAll')}
          </button>
        </div>
        {mode === 'all' && matches.length > 0 && (
          <span className="search-match-count">{activeMatchIdx + 1}/{matches.length}</span>
        )}
        <button
          className={`search-btn ${detached ? 'active' : ''}`}
          title={detached ? t('dock') : t('popout')}
          onClick={() => {
            setDetached(prev => {
              const next = !prev;
              // 다시 고정으로 돌아가면 드래그했던 위치를 버리고 기본 위치로 되돌린다.
              if (!next) setPos(null);
              return next;
            });
          }}
        >{detached ? '📌' : '🔓'}</button>
        <button className="search-btn search-close-btn" onClick={handleClose} title={t('close')}>&times;</button>
      </div>
      {mode === 'all' && matches.length > 0 && (
        <div className="search-match-list">
          {matches.map((m, i) => (
            <span
              key={m.termId}
              className={`search-match-item ${i === activeMatchIdx ? 'active' : ''}`}
              onClick={() => {
                setActiveMatchIdx(i);
                // 결과 목록의 termId 는 다른 워크스페이스 탭/패널/미니탭에 있을 수 있으므로,
                // 실제 매치를 찾기 전에 먼저 그 화면으로 이동시켜야 한다 — 이동 없이 그냥
                // searchInTerm 만 부르면 그 터미널이 화면에 없어서 아무 반응이 없는 것처럼 보였다.
                onNavigateToTerm?.(m.termId);
                searchInTerm(m.termId, query, useRegex, caseSensitive);
              }}
            >
              {m.tabTitle} &gt; {m.sessionName}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
