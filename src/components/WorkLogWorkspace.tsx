// src/components/WorkLogWorkspace.tsx
// 작업일지 — 앱 전체에서 공유되는 일별 todo 기록 + 기간 지정 AI 정리.
// 우측 사이드바(ClaudeChat.tsx)의 세 번째 탭으로 AI Chat/메신저와 나란히 배치.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runOneShotPrompt, type AiOneShotAgent } from '../utils/aiOneShot';
import { getCurrentLanguage } from '../i18n';

const api = () => (window as any).api || {};

type Todo = {
  id: string;
  text: string;
  done: boolean;
  memo?: string;
  createdAt: number;
  doneAt?: number;
  sharedFromPeerId?: string;
  sharedFromPeerName?: string;
  sharedFromDate?: string;
  sharedFromMessageId?: string;
};

type DayType = 'vacation' | 'trip';
type WorklogDayRec = { todos: Todo[]; dayType?: DayType };
type MessengerPeer = { id: string; name: string; host: string; port: number; lastSeen: number; online?: boolean };
type MessengerState = { self?: { id: string; name: string; port: number; hidden?: boolean }; peers: MessengerPeer[]; prefs?: { hidePresence?: boolean } };
type WorklogDays = Record<string, WorklogDayRec>;
type ViewMode = 'year' | 'month' | 'day';

const uid = () => `wl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const pad2 = (n: number) => String(n).padStart(2, '0');
const toDateStr = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (dateStr: string, delta: number): string => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return toDateStr(d);
};
const addMonths = (dateStr: string, delta: number): string => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + delta);
  return toDateStr(d);
};
const addYears = (dateStr: string, delta: number): string => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setFullYear(d.getFullYear() + delta);
  return toDateStr(d);
};
const startOfWeek = (dateStr: string): string => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - d.getDay()); // 0=일요일
  return toDateStr(d);
};
// 날짜 범위(inclusive) — 과도한 프롬프트 길이 방지를 위해 최대 90일로 제한.
const MAX_RANGE_DAYS = 90;
const dateRange = (from: string, to: string): string[] => {
  const out: string[] = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard < MAX_RANGE_DAYS) {
    out.push(cur);
    cur = addDays(cur, 1);
    guard++;
  }
  return out;
};
// 네이티브 date input 은 로케일에 따라 요일 표기가 깨지거나(빈 "()") OS 마다 다르게 나와서,
// 직접 Intl 로 계산한 요일을 별도 텍스트로 붙여 항상 정확하게 보여준다.
const weekdayLabel = (dateStr: string): string => {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(getCurrentLanguage(), { weekday: 'short' }).format(d);
  } catch {
    // getCurrentLanguage() 가 Intl 이 못 알아듣는 값을 줄 경우 — 런타임 기본 로케일로 재시도.
    try { return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d); } catch { return ''; }
  }
};
// 연/월 헤더 라벨과 월 박스 라벨도 Intl 로 로케일에 맞게 계산 — 언어별 번역 문자열 없이도 정확한 표기.
const yearLabel = (year: number): string => {
  try { return new Intl.DateTimeFormat(getCurrentLanguage(), { year: 'numeric' }).format(new Date(year, 0, 1)); }
  catch { return String(year); }
};
const monthLabel = (year: number, month: number): string => {
  try { return new Intl.DateTimeFormat(getCurrentLanguage(), { year: 'numeric', month: 'long' }).format(new Date(year, month - 1, 1)); }
  catch { return `${year}-${pad2(month)}`; }
};
const monthShortLabel = (month: number): string => {
  try { return new Intl.DateTimeFormat(getCurrentLanguage(), { month: 'short' }).format(new Date(2024, month - 1, 1)); }
  catch { return String(month); }
};

// 네이티브 <input type="date"> 는 요일 같은 커스텀 텍스트를 안에 끼워넣을 수 없어서(브라우저가
// 자체 포맷으로만 렌더링) — 실제로 보여주는 건 "YYYY-MM-DD (요일)" 텍스트 버튼으로 하고,
// 진짜 <input type="date"> 는 화면에서 숨긴 채 버튼 클릭 시 showPicker() 로 네이티브 달력만 띄운다.
const DateField: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const wd = value ? weekdayLabel(value) : '';
  const display = value ? (wd ? `${value} (${wd})` : value) : '';
  const openPicker = () => {
    const el = inputRef.current;
    if (!el) return;
    try {
      if (typeof (el as any).showPicker === 'function') (el as any).showPicker();
      else el.focus();
    } catch { el.focus(); }
  };
  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <button
        type="button"
        onClick={openPicker}
        style={{ width: '100%', textAlign: 'left', background: 'var(--win-surface, #1b1e29)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #2a2e3a)', borderRadius: 6, padding: '5px 8px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}
      >{display || ' '}</button>
      <input
        ref={inputRef}
        type="date"
        value={value}
        onChange={e => onChange(e.target.value)}
        tabIndex={-1}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, pointerEvents: 'none' }}
      />
    </div>
  );
};

export const WorkLogWorkspace: React.FC<{
  visible?: boolean;
  aiAgent: AiOneShotAgent;
}> = ({ visible = true, aiAgent }) => {
  const { t } = useTranslation('workLog');
  const [loaded, setLoaded] = useState(false);
  const [days, setDays] = useState<WorklogDays>({});
  const [viewMode, setViewMode] = useState<ViewMode>('day');
  const [selectedDate, setSelectedDate] = useState(() => toDateStr(new Date()));
  const [newTodoText, setNewTodoText] = useState('');
  const [editingMemoId, setEditingMemoId] = useState<string | null>(null);

  const [rangeFrom, setRangeFrom] = useState(() => startOfWeek(toDateStr(new Date())));
  const [rangeTo, setRangeTo] = useState(() => toDateStr(new Date()));
  const [summarizing, setSummarizing] = useState(false);
  const [summaryText, setSummaryText] = useState('');
  const [summaryError, setSummaryError] = useState('');
  const [copied, setCopied] = useState(false);
  const [messengerSelf, setMessengerSelf] = useState<{ id: string; name: string } | null>(null);
  const [sharePeers, setSharePeers] = useState<MessengerPeer[]>([]);
  const [todoMenu, setTodoMenu] = useState<{ date: string; todoId: string; x: number; y: number } | null>(null);
  const [sharePicker, setSharePicker] = useState<{ date: string; todoId: string } | null>(null);
  const [shareBusyPeerId, setShareBusyPeerId] = useState('');
  const [shareError, setShareError] = useState('');
  // 월별 보기에서 날짜 우클릭 시 뜨는 휴가/출장 지정 메뉴.
  const [dayMenu, setDayMenu] = useState<{ date: string; x: number; y: number } | null>(null);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const data = await api().worklogGetAll?.();
        setDays(data?.days || {});
      } catch {}
      try {
        const messenger: MessengerState = await api().messengerGetState?.();
        if (!disposed && messenger?.peers) {
          setSharePeers(Array.isArray(messenger.peers) ? messenger.peers : []);
          if (messenger.self) setMessengerSelf({ id: String(messenger.self.id || ''), name: String(messenger.self.name || '') });
        }
      } catch {}
      setLoaded(true);
    })();
    const offWorklog = api().onWorklogEvent?.((p: any) => {
      if (p?.state?.days) setDays(p.state.days || {});
    });
    const offMessenger = api().onMessengerEvent?.((p: any) => {
      if (p?.state?.peers) setSharePeers(Array.isArray(p.state.peers) ? p.state.peers : []);
      if (p?.state?.self) setMessengerSelf({ id: String(p.state.self.id || ''), name: String(p.state.self.name || '') });
    });
    return () => {
      disposed = true;
      if (offWorklog) offWorklog();
      if (offMessenger) offMessenger();
    };
  }, []);

  const todosForDate = (date: string): Todo[] => days[date]?.todos || [];
  const todos = todosForDate(selectedDate);
  const onlinePeers = useMemo(() => sharePeers.filter(peer => peer.online), [sharePeers]);
  const selectedShareTodo = sharePicker ? todosForDate(sharePicker.date).find(todo => todo.id === sharePicker.todoId) || null : null;

  // todos 를 바꿀 때도 그 날의 dayType(휴가/출장 표시)은 그대로 유지해야 한다.
  const persistDay = (date: string, nextTodos: Todo[]) => {
    const dayType = days[date]?.dayType;
    const next: WorklogDayRec = { todos: nextTodos, ...(dayType ? { dayType } : {}) };
    setDays(prev => ({ ...prev, [date]: next }));
    try { api().worklogSaveDay?.(date, next); } catch {}
  };

  const setDayType = (date: string, dayType: DayType | undefined) => {
    const nextTodos = todosForDate(date);
    const next: WorklogDayRec = { todos: nextTodos, ...(dayType ? { dayType } : {}) };
    setDays(prev => ({ ...prev, [date]: next }));
    try { api().worklogSaveDay?.(date, next); } catch {}
    setDayMenu(null);
  };

  const addTodo = () => {
    const text = newTodoText.trim();
    if (!text) return;
    const todo: Todo = { id: uid(), text, done: false, createdAt: Date.now() };
    persistDay(selectedDate, [...todos, todo]);
    setNewTodoText('');
  };
  const toggleTodo = (id: string) => {
    persistDay(selectedDate, todos.map(t => t.id === id ? { ...t, done: !t.done, doneAt: !t.done ? Date.now() : undefined } : t));
  };
  const deleteTodo = (id: string) => {
    persistDay(selectedDate, todos.filter(t => t.id !== id));
  };
  const updateMemo = (id: string, memo: string) => {
    persistDay(selectedDate, todos.map(t => t.id === id ? { ...t, memo } : t));
  };
  const openSharePicker = (date: string, todoId: string) => {
    setTodoMenu(null);
    setShareError('');
    setSharePicker({ date, todoId });
  };
  const sendShareToPeer = async (peerId: string) => {
    if (!sharePicker) return;
    const todo = todosForDate(sharePicker.date).find(item => item.id === sharePicker.todoId);
    if (!todo) {
      setShareError(t('shareMissingTodo'));
      return;
    }
    setShareBusyPeerId(peerId);
    setShareError('');
    try {
      const res = await api().messengerSendWorklogShare?.(peerId, {
        sourceDate: sharePicker.date,
        sourceTodo: todo,
        sourcePeerId: messengerSelf?.id,
        sourcePeerName: messengerSelf?.name,
        sourceMessageId: todo.sharedFromMessageId || todo.id,
      });
      if (!res?.success) {
        setShareError(t('shareFail', { error: String(res?.error || 'unknown') }));
        return;
      }
      setSharePicker(null);
    } catch (err: any) {
      setShareError(t('shareFail', { error: String(err?.message || err) }));
    } finally {
      setShareBusyPeerId('');
    }
  };

  // 이전/다음/오늘 네비게이션 — 현재 보기 모드(년/월/일)에 따라 이동 단위가 달라진다.
  const goPrev = () => setSelectedDate(d => viewMode === 'year' ? addYears(d, -1) : viewMode === 'month' ? addMonths(d, -1) : addDays(d, -1));
  const goNext = () => setSelectedDate(d => viewMode === 'year' ? addYears(d, 1) : viewMode === 'month' ? addMonths(d, 1) : addDays(d, 1));
  const goToday = () => { setSelectedDate(toDateStr(new Date())); setViewMode('day'); };

  const selYear = Number(selectedDate.slice(0, 4));
  const selMonth = Number(selectedDate.slice(5, 7)); // 1-12

  // 연간 보기 — 월별 등록된 할 일 개수 합계.
  const monthCounts = useMemo(() => {
    const counts = new Array(13).fill(0); // index 1~12 사용
    for (const [date, day] of Object.entries(days)) {
      if (!date.startsWith(`${selYear}-`)) continue;
      const m = Number(date.slice(5, 7));
      counts[m] += day.todos.length;
    }
    return counts;
  }, [days, selYear]);

  // 월간 보기 — 일별 등록된 할 일 개수 + 요일(주말 배경용) + dayType(휴가/출장 배경용).
  const monthGrid = useMemo(() => {
    const daysInMonth = new Date(selYear, selMonth, 0).getDate();
    const firstWeekday = new Date(selYear, selMonth - 1, 1).getDay();
    const cells: Array<{ date: string; day: number; count: number; weekday: number; dayType?: DayType } | null> = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${selYear}-${pad2(selMonth)}-${pad2(day)}`;
      const weekday = new Date(selYear, selMonth - 1, day).getDay();
      cells.push({ date, day, count: days[date]?.todos.length || 0, weekday, dayType: days[date]?.dayType });
    }
    return cells;
  }, [days, selYear, selMonth]);

  const todayStr = toDateStr(new Date());
  const weekdayNames = useMemo(() => {
    // 일요일부터 시작하는 짧은 요일명 (로케일 대응)
    const base = new Date(2024, 0, 7); // 2024-01-07 은 일요일
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      return new Intl.DateTimeFormat(getCurrentLanguage(), { weekday: 'short' }).format(d);
    });
  }, []);

  const handleSummarize = async () => {
    const from = rangeFrom <= rangeTo ? rangeFrom : rangeTo;
    const to = rangeFrom <= rangeTo ? rangeTo : rangeFrom;
    const dates = dateRange(from, to);
    const lines: string[] = [];
    for (const date of dates) {
      const dayTodos = todosForDate(date);
      if (dayTodos.length === 0) continue;
      lines.push(`${date} (${weekdayLabel(date)})`);
      for (const item of dayTodos) {
        const mark = item.done ? 'x' : ' ';
        const memoSuffix = item.memo?.trim() ? ` (${item.memo.trim()})` : '';
        lines.push(`- [${mark}] ${item.text}${memoSuffix}`);
      }
      lines.push('');
    }
    if (lines.length === 0) {
      setSummaryText('');
      setSummaryError(t('summaryEmpty'));
      return;
    }
    // 기간 내 달력에 휴가/출장으로 표시된 날짜가 있으면 AI 에게 컨텍스트로 알려준다
    // (그 날 작업 기록이 없는 게 정상임을 알 수 있도록).
    const dayTypeLines = dates
      .map(date => ({ date, dayType: days[date]?.dayType }))
      .filter((d): d is { date: string; dayType: DayType } => !!d.dayType)
      .map(d => t('dayTypeLine', { date: `${d.date} (${weekdayLabel(d.date)})`, type: t(d.dayType === 'vacation' ? 'vacationLabel' : 'tripLabel') }));
    const contextLines = dayTypeLines.length > 0 ? [t('dayTypeContextHeader'), ...dayTypeLines] : [];
    setSummarizing(true);
    setSummaryError('');
    setSummaryText('');
    setCopied(false);
    const promptParts = [t('aiPromptInstruction'), ...contextLines, '', lines.join('\n')];
    const prompt = promptParts.join('\n');
    try {
      const result = await runOneShotPrompt(aiAgent, prompt);
      setSummaryText(result.trim() || t('summaryEmpty'));
    } catch (err: any) {
      setSummaryError(t('summaryError', { error: String(err?.message || err) }));
    } finally {
      setSummarizing(false);
    }
  };

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  void visible; // 현재는 배경 작업이 없어 미사용 — 부모(ClaudeChat.tsx)가 CSS display:none 으로만 숨김 (상태 보존)

  // 월별 보기 날짜 셀 배경 — 휴가/출장 표시가 요일 색보다 우선, 그 외엔 토(6)/일(0)만 검은색.
  const DAY_TYPE_COLOR: Record<DayType, string> = { vacation: '#1c5d8c', trip: '#8a5a1f' };
  const dayCellBackground = (weekday: number, dayType?: DayType): string | undefined => {
    if (dayType) return DAY_TYPE_COLOR[dayType];
    if (weekday === 0 || weekday === 6) return '#000';
    return undefined; // boxStyle 기본 배경 사용
  };

  const boxStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
    border: '1px solid var(--win-border, #2a2e3a)', borderRadius: 8, background: 'var(--win-surface, #1b1e29)',
    color: 'var(--win-text, #e6edf3)', padding: '10px 4px', cursor: 'pointer', fontSize: 12,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--win-bg, #14161f)', color: 'var(--win-text, #e6edf3)' }}>
      {/* 보기 모드 전환 + 날짜 네비게이션 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--win-border, #2a2e3a)' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['year', 'month', 'day'] as ViewMode[]).map(mode => (
            <button
              key={mode}
              className={`panel-btn ${viewMode === mode ? 'primary' : ''}`}
              onClick={() => setViewMode(mode)}
              style={{ flex: 1, fontSize: 12 }}
            >{t(mode === 'year' ? 'yearView' : mode === 'month' ? 'monthView' : 'dayView')}</button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button className="panel-btn" onClick={goPrev} title={t('prev')}>◀</button>
          {viewMode === 'day' ? (
            <DateField value={selectedDate} onChange={v => setSelectedDate(v || toDateStr(new Date()))} />
          ) : (
            <div style={{ flex: 1, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>
              {viewMode === 'year' ? yearLabel(selYear) : monthLabel(selYear, selMonth)}
            </div>
          )}
          <button className="panel-btn" onClick={goNext} title={t('next')}>▶</button>
          <button className="panel-btn" onClick={goToday} title={t('today')}>{t('today')}</button>
        </div>
      </div>

      {/* 본문 — 보기 모드에 따라 연/월 달력 또는 일별 할 일 목록 */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {!loaded ? (
          <div style={{ color: 'var(--win-text-dim, #8a93a6)', fontSize: 12, padding: 12 }}>{t('loading')}</div>
        ) : viewMode === 'year' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
              <div
                key={m}
                onClick={() => { setSelectedDate(`${selYear}-${pad2(m)}-01`); setViewMode('month'); }}
                style={{ ...boxStyle, border: m === selMonth ? '1px solid #4a9eff' : boxStyle.border }}
              >
                <div style={{ fontWeight: 700 }}>{monthShortLabel(m)}</div>
                <div style={{ color: 'var(--win-text-dim, #8a93a6)', fontSize: 11 }}>{t('itemsCount', { count: monthCounts[m] })}</div>
              </div>
            ))}
          </div>
        ) : viewMode === 'month' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {weekdayNames.map(w => (
              <div key={w} style={{ textAlign: 'center', fontSize: 11, color: 'var(--win-text-dim, #8a93a6)', padding: '2px 0' }}>{w}</div>
            ))}
            {monthGrid.map((cell, idx) => {
              if (!cell) return <div key={`blank-${idx}`} />;
              const bg = dayCellBackground(cell.weekday, cell.dayType);
              return (
                <div
                  key={cell.date}
                  onClick={() => { setSelectedDate(cell.date); setViewMode('day'); }}
                  onContextMenu={e => { e.preventDefault(); setDayMenu({ date: cell.date, x: e.clientX, y: e.clientY }); }}
                  style={{ ...boxStyle, ...(bg ? { background: bg } : {}), border: cell.date === todayStr ? '1px solid #4a9eff' : boxStyle.border, minHeight: 48 }}
                >
                  <div style={{ fontWeight: 700 }}>{cell.day}</div>
                  {cell.count > 0 && <div style={{ color: 'var(--win-text-dim, #8a93a6)', fontSize: 11 }}>{t('itemsCount', { count: cell.count })}</div>}
                </div>
              );
            })}
          </div>
        ) : todos.length === 0 ? (
          <div style={{ color: 'var(--win-text-dim, #8a93a6)', fontSize: 12, padding: 12, textAlign: 'center' }}>{t('noTodos')}</div>
        ) : todos.map(item => (
          <div
            key={item.id}
            onContextMenu={e => {
              e.preventDefault();
              setTodoMenu({ date: selectedDate, todoId: item.id, x: e.clientX, y: e.clientY });
            }}
            style={{ border: '1px solid var(--win-border, #2a2e3a)', borderRadius: 8, background: 'var(--win-surface, #1b1e29)', padding: '8px 10px', cursor: 'context-menu' }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input type="checkbox" checked={item.done} onChange={() => toggleTodo(item.id)} style={{ marginTop: 3, cursor: 'pointer' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, textDecoration: item.done ? 'line-through' : 'none', color: item.done ? 'var(--win-text-dim, #8a93a6)' : 'var(--win-text, #e6edf3)', wordBreak: 'break-word' }}>
                  {item.text}
                </div>
                {editingMemoId === item.id ? (
                  <textarea
                    autoFocus
                    rows={3}
                    value={item.memo || ''}
                    onChange={e => updateMemo(item.id, e.target.value)}
                    onBlur={() => setEditingMemoId(null)}
                    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setEditingMemoId(null); }}
                    placeholder={t('memoPlaceholder')}
                    style={{ width: '100%', marginTop: 4, fontSize: 11, background: 'var(--win-bg, #14161f)', color: 'var(--win-text-dim, #8a93a6)', border: '1px solid var(--win-border, #2a2e3a)', borderRadius: 4, padding: '3px 6px', resize: 'vertical', fontFamily: 'inherit' }}
                  />
                ) : (
                  <div
                    onClick={() => setEditingMemoId(item.id)}
                    style={{ marginTop: 4, fontSize: 11, color: 'var(--win-text-dim, #8a93a6)', cursor: 'text', minHeight: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                  >
                    {item.memo?.trim() || t('memoPlaceholder')}
                  </div>
                )}
                {(item.sharedFromPeerName || item.sharedFromDate) && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, padding: '3px 8px', borderRadius: 999, border: '1px solid var(--win-border, #2a2e3a)', background: 'rgba(255,255,255,0.03)', color: 'var(--win-text-dim, #8a93a6)', fontSize: 10, lineHeight: 1.2 }}>
                    <span>🤝</span>
                    <span>{t('sharedFrom', { name: item.sharedFromPeerName || '', date: item.sharedFromDate || '' })}</span>
                  </div>
                )}
              </div>
              <button className="panel-btn" onClick={() => deleteTodo(item.id)} title={t('delete')} style={{ padding: '2px 8px', fontSize: 12 }}>✕</button>
            </div>
          </div>
        ))}
      </div>

      {/* 할 일 추가 — 일별 보기에서만 표시 */}
      {viewMode === 'day' && (
        <div style={{ display: 'flex', gap: 6, padding: '10px 12px', borderTop: '1px solid var(--win-border, #2a2e3a)' }}>
          <input
            value={newTodoText}
            onChange={e => setNewTodoText(e.target.value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') addTodo(); }}
            placeholder={t('addPlaceholder')}
            style={{ flex: 1, minWidth: 0, background: 'var(--win-surface, #1b1e29)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #2a2e3a)', borderRadius: 6, padding: '6px 10px', fontSize: 12 }}
          />
          <button className="panel-btn primary" onClick={addTodo} disabled={!newTodoText.trim()}>{t('add')}</button>
        </div>
      )}

      {/* 작업 일지 요약 (AI) */}
      <div style={{ borderTop: '1px solid var(--win-border, #2a2e3a)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '50%', overflow: 'auto' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--win-text-dim, #8a93a6)' }}>{t('summaryTitle')}</div>
        {/* 날짜 2개 + 요일 라벨 + 버튼을 한 줄에 다 넣으면 사이드바 폭에서 넘쳐서(overflow:hidden 인
            상위 컨테이너에 잘려) 요일 텍스트/버튼이 안 보이는 문제가 있었다 — 두 줄로 분리 + flexWrap
            안전장치로 좁은 폭에서도 항상 보이게 함. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <DateField value={rangeFrom} onChange={setRangeFrom} />
          <span style={{ color: 'var(--win-text-dim, #8a93a6)', fontSize: 12 }}>~</span>
          <DateField value={rangeTo} onChange={setRangeTo} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="panel-btn primary" onClick={handleSummarize} disabled={summarizing}>
            {summarizing ? t('summarizing') : t('summarizeButton')}
          </button>
        </div>
        {summaryError && <div style={{ color: '#f38ba8', fontSize: 12, whiteSpace: 'pre-wrap' }}>{summaryError}</div>}
        {summaryText && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
              <button className="panel-btn" onClick={copySummary} style={{ fontSize: 11, padding: '3px 8px' }}>{copied ? t('copied') : t('copy')}</button>
            </div>
            <div style={{ background: 'var(--win-surface, #1b1e29)', border: '1px solid var(--win-border, #2a2e3a)', borderRadius: 8, padding: 10, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', userSelect: 'text', cursor: 'text' }}>
              {summaryText}
            </div>
          </div>
        )}
      </div>
      {/* 작업 항목 우클릭 메뉴 — 메신저 공유 */}
      {todoMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 2000 }} onClick={() => setTodoMenu(null)} onContextMenu={e => { e.preventDefault(); setTodoMenu(null); }} />
          <div style={{ position: 'fixed', left: todoMenu.x, top: todoMenu.y, zIndex: 2001, minWidth: 170, border: '1px solid var(--win-border, #2a2e3a)', borderRadius: 8, background: 'var(--win-surface, #1b1e29)', boxShadow: '0 12px 28px rgba(0,0,0,0.5)', overflow: 'hidden' }}>
            <button
              onClick={() => openSharePicker(todoMenu.date, todoMenu.todoId)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 0, background: 'transparent', color: 'var(--win-text, #e6edf3)', cursor: 'pointer', fontSize: 12 }}
            >{t('shareMenu')}</button>
          </div>
        </>
      )}
      {/* 작업일지 항목 공유 — 온라인 메신저 사용자만 선택 */}
      {sharePicker && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 2100, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(2px)' }} onClick={() => { setSharePicker(null); setShareError(''); }} />
          <div style={{ position: 'fixed', inset: 0, zIndex: 2101, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div style={{ width: 'min(560px, 100%)', maxHeight: 'min(80vh, 760px)', display: 'flex', flexDirection: 'column', border: '1px solid var(--win-border, #2a2e3a)', borderRadius: 12, background: 'var(--win-surface, #1b1e29)', color: 'var(--win-text, #e6edf3)', boxShadow: '0 24px 72px rgba(0,0,0,0.55)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--win-border, #2a2e3a)' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{t('shareTitle')}</div>
                  <div style={{ marginTop: 4, color: 'var(--win-text-dim, #8a93a6)', fontSize: 12 }}>{t('shareHint')}</div>
                </div>
                <button className="panel-btn" onClick={() => { setSharePicker(null); setShareError(''); }} style={{ flex: '0 0 auto' }}>{t('close')}</button>
              </div>
              <div style={{ padding: 16, borderBottom: '1px solid var(--win-border, #2a2e3a)' }}>
                {selectedShareTodo ? (
                  <div style={{ border: '1px solid var(--win-border, #2a2e3a)', borderRadius: 10, background: 'rgba(255,255,255,0.03)', padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ color: 'var(--win-text-dim, #8a93a6)', fontSize: 11 }}>{sharePicker.date} · {weekdayLabel(sharePicker.date)}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, wordBreak: 'break-word' }}>{selectedShareTodo.text}</div>
                    {selectedShareTodo.memo?.trim() && <div style={{ color: 'var(--win-text-dim, #8a93a6)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{selectedShareTodo.memo}</div>}
                  </div>
                ) : (
                  <div style={{ color: '#f38ba8', fontSize: 12 }}>{t('shareMissingTodo')}</div>
                )}
              </div>
              <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--win-text-dim, #8a93a6)' }}>{t('shareOnlineUsers')}</div>
                  <div style={{ fontSize: 12, color: 'var(--win-text-dim, #8a93a6)' }}>{onlinePeers.length} / {sharePeers.length}</div>
                </div>
                {onlinePeers.length === 0 ? (
                  <div style={{ padding: 12, border: '1px dashed var(--win-border, #2a2e3a)', borderRadius: 10, color: 'var(--win-text-dim, #8a93a6)', fontSize: 12 }}>{t('shareNoOnlineUsers')}</div>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {onlinePeers.map(peer => (
                      <button
                        key={peer.id}
                        className="panel-btn"
                        disabled={!!shareBusyPeerId || !selectedShareTodo}
                        onClick={() => void sendShareToPeer(peer.id)}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left', padding: '10px 12px' }}
                      >
                        <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <b style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{peer.name}</b>
                          <small style={{ color: 'var(--win-text-dim, #8a93a6)' }}>{peer.host}:{peer.port}</small>
                        </span>
                        <span style={{ flex: '0 0 auto', color: 'var(--win-text-dim, #8a93a6)', fontSize: 12 }}>
                          {shareBusyPeerId === peer.id ? t('shareSending') : t('shareSend')}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {shareError && <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,120,120,0.28)', background: 'rgba(255,120,120,0.08)', color: '#ffb3b3', fontSize: 12, whiteSpace: 'pre-wrap' }}>{shareError}</div>}
              </div>
            </div>
          </div>
        </>
      )}
      {/* 월별 보기 날짜 우클릭 메뉴 — 휴가/출장 지정/해제 */}
      {dayMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 2000 }} onClick={() => setDayMenu(null)} onContextMenu={e => { e.preventDefault(); setDayMenu(null); }} />
          <div style={{ position: 'fixed', left: dayMenu.x, top: dayMenu.y, zIndex: 2001, minWidth: 140, border: '1px solid var(--win-border, #2a2e3a)', borderRadius: 8, background: 'var(--win-surface, #1b1e29)', boxShadow: '0 12px 28px rgba(0,0,0,0.5)', overflow: 'hidden' }}>
            <button onClick={() => setDayType(dayMenu.date, 'vacation')} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 0, background: 'transparent', color: 'var(--win-text, #e6edf3)', cursor: 'pointer', fontSize: 12 }}>{t('setVacation')}</button>
            <button onClick={() => setDayType(dayMenu.date, 'trip')} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 0, background: 'transparent', color: 'var(--win-text, #e6edf3)', cursor: 'pointer', fontSize: 12 }}>{t('setTrip')}</button>
            <button onClick={() => setDayType(dayMenu.date, undefined)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 0, background: 'transparent', color: 'var(--win-text-dim, #8a93a6)', cursor: 'pointer', fontSize: 12 }}>{t('clearDayType')}</button>
          </div>
        </>
      )}
    </div>
  );
};
