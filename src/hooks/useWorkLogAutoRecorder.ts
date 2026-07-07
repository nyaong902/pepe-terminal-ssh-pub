// src/hooks/useWorkLogAutoRecorder.ts
// AI Chat 대화 내용을 하루 중 지정한 시각에 1번, 주제별로 정리해서 작업일지(오늘 날짜)에
// 자동으로 반영(추가/갱신)하는 백그라운드 스케줄러. ClaudeChat.tsx 에서 호출.
import { useEffect, useRef, useState } from 'react';
import { runOneShotPrompt } from '../utils/aiOneShot';
import type { AgentType, ChatHistoryEntry } from '../components/ClaudeChat';

const api = () => (window as any).api || {};

type WorklogTodo = { id: string; text: string; done: boolean; memo?: string; createdAt: number; doneAt?: number };
type WorklogDay = { todos: WorklogTodo[]; dayType?: 'vacation' | 'trip' };

const CHECK_INTERVAL_MS = 60_000; // 1분마다 "지정 시각을 지났는지" 체크
const MAX_TRANSCRIPT_CHARS = 12_000; // 프롬프트 폭주 방지 — 초과 시 앞부분(오래된 것) 자름

const pad2 = (n: number) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const nowHHMM = () => {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const uid = () => `wl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// 모델이 ```json 코드블록으로 감싸서 응답하는 경우를 대비해 벗겨낸다.
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : trimmed;
}

export function useWorkLogAutoRecorder(chatHistory: ChatHistoryEntry[], agent: AgentType) {
  const [enabled, setEnabledState] = useState(false);
  const [time, setTimeState] = useState('18:00');
  const [lastRunDate, setLastRunDate] = useState('');
  const [running, setRunning] = useState(false);
  const loadedRef = useRef(false);
  const chatHistoryRef = useRef(chatHistory);
  chatHistoryRef.current = chatHistory;
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const lastSeqRef = useRef(0);
  const runningRef = useRef(false);

  // 설정 + 체크포인트 로드 (앱 재시작 후에도 "오늘 이미 실행함"/"어디까지 처리함"을 기억해야
  // 매번 전체를 다시 처리하지 않는다).
  useEffect(() => {
    (async () => {
      try {
        const prefs = await api().getUIPrefs?.();
        if (typeof prefs?.workLogAutoRecordEnabled === 'boolean') setEnabledState(prefs.workLogAutoRecordEnabled);
        if (typeof prefs?.workLogAutoRecordTime === 'string') setTimeState(prefs.workLogAutoRecordTime);
        if (typeof prefs?.workLogAutoRecordLastRunDate === 'string') setLastRunDate(prefs.workLogAutoRecordLastRunDate);
        if (typeof prefs?.workLogAutoRecordLastSeq === 'number') lastSeqRef.current = prefs.workLogAutoRecordLastSeq;
      } catch {}
      loadedRef.current = true;
    })();
  }, []);

  const setEnabled = (v: boolean) => {
    setEnabledState(v);
    try { api().setUIPrefs?.({ workLogAutoRecordEnabled: v }); } catch {}
  };
  const setTime = (v: string) => {
    setTimeState(v);
    try { api().setUIPrefs?.({ workLogAutoRecordTime: v }); } catch {}
  };

  // chatHistory 전체(모든 대화)에서 lastSeq 이후 메시지만 모아 텍스트로 합친다.
  // Message 에는 시각이 없고 전역 seq 만 있어 "마지막 처리 이후 새 메시지" 판별은 seq 비교로 한다.
  const collectNewTranscript = (): { text: string; maxSeq: number } => {
    const lastSeq = lastSeqRef.current;
    const items: { seq: number; role: string; content: string }[] = [];
    let maxSeq = lastSeq;
    for (const conv of chatHistoryRef.current) {
      for (const msg of conv.messages) {
        const seq = msg.seq ?? 0;
        if (seq > maxSeq) maxSeq = seq;
        if (seq <= lastSeq) continue;
        const content = (msg.content || '').trim();
        if (!content) continue;
        items.push({ seq, role: msg.role, content });
      }
    }
    items.sort((a, b) => a.seq - b.seq);
    let text = items.map(it => `[${it.role}] ${it.content}`).join('\n\n');
    if (text.length > MAX_TRANSCRIPT_CHARS) {
      text = '...(이전 내용 생략)...\n' + text.slice(text.length - MAX_TRANSCRIPT_CHARS);
    }
    return { text, maxSeq };
  };

  // 시각 조건과 무관하게 즉시 1회 실행 — 자동 스케줄과 "지금 실행" 버튼이 공유.
  const runOnce = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    const today = todayStr();
    try {
      const { text: transcript, maxSeq } = collectNewTranscript();
      if (!transcript.trim()) {
        // 새 대화가 없었다면 AI 호출 없이 "오늘 처리함"만 기록 — 매분 재시도하지 않도록.
        lastSeqRef.current = maxSeq;
        try { await api().setUIPrefs?.({ workLogAutoRecordLastRunDate: today, workLogAutoRecordLastSeq: maxSeq }); } catch {}
        setLastRunDate(today);
        return;
      }
      const data = await api().worklogGetAll?.();
      const todayDay: WorklogDay = data?.days?.[today] || { todos: [] };
      const existingJson = JSON.stringify(todayDay.todos.map(t => ({ id: t.id, text: t.text, memo: t.memo || '' })));
      const prompt = [
        '당신은 사용자의 AI 코딩/작업 대화를 분석해서 개인 작업일지를 관리하는 도우미입니다.',
        `아래는 오늘(${today}) 이미 기록된 작업일지 항목과, 그 이후 새로 진행된 대화 내용입니다.`,
        '새 대화에서 실제로 수행되거나 논의된 "작업"을 주제 단위로 파악하세요.',
        '- 기존 항목 중 같은 주제를 다루는 항목이 있으면 update로 그 항목을 최신 내용으로 갱신하세요(반드시 기존 id 사용).',
        '- 새로운 주제라면 add로 새 항목을 추가하세요(id 없이).',
        '- 잡담/단순 확인 등 실질적 작업이 없으면 어떤 것도 추가/수정하지 마세요.',
        '- text 는 한 줄 요약, memo 는 1~3줄 상세 설명으로 작성하세요.',
        '반드시 아래 JSON 형식 하나만 출력하세요 (설명, 마크다운 코드블록 없이 순수 JSON 객체 하나만):',
        '{"actions":[{"type":"update","id":"기존id","text":"...","memo":"..."},{"type":"add","text":"...","memo":"..."}]}',
        '',
        '[오늘 기존 작업일지 항목]',
        existingJson,
        '',
        '[새 대화 내용]',
        transcript,
      ].join('\n');
      const result = await runOneShotPrompt(agentRef.current, prompt);
      const parsed = JSON.parse(stripCodeFence(result));
      const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
      const nextTodos = [...todayDay.todos];
      for (const action of actions) {
        if (!action || typeof action.text !== 'string' || !action.text.trim()) continue;
        const memo = typeof action.memo === 'string' ? action.memo.trim() : undefined;
        if (action.type === 'update' && action.id) {
          const idx = nextTodos.findIndex(t => t.id === action.id);
          if (idx >= 0) {
            nextTodos[idx] = { ...nextTodos[idx], text: action.text.trim(), memo: memo ?? nextTodos[idx].memo };
            continue;
          }
        }
        nextTodos.push({ id: uid(), text: action.text.trim(), done: false, memo, createdAt: Date.now() });
      }
      try { await api().worklogSaveDay?.(today, { todos: nextTodos, dayType: todayDay.dayType }); } catch {}
      // seq 체크포인트는 성공했을 때만 전진 — 실패분은 다음 실행 때 다시 포함되게 한다.
      lastSeqRef.current = maxSeq;
      try { await api().setUIPrefs?.({ workLogAutoRecordLastRunDate: today, workLogAutoRecordLastSeq: maxSeq }); } catch {}
      setLastRunDate(today);
    } catch (err: any) {
      // 실패해도 "오늘 1회" 는 보장 — 같은 날 반복 재시도로 스팸이 되지 않게 함.
      try { await api().setUIPrefs?.({ workLogAutoRecordLastRunDate: today }); } catch {}
      setLastRunDate(today);
      try { api().debugLog?.(`[worklog-auto-record] failed: ${String(err?.message || err)}`); } catch {}
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  // 1분마다: 오늘 지정 시각을 지났고 아직 오늘 실행 안 했으면 자동 실행.
  useEffect(() => {
    const check = () => {
      if (!loadedRef.current || !enabled) return;
      if (lastRunDate === todayStr()) return;
      if (nowHHMM() < time) return;
      void runOnce();
    };
    check();
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, time, lastRunDate]);

  return { enabled, setEnabled, time, setTime, lastRunDate, running, runNow: runOnce };
}
