// src/components/ChatArchiveSearch.tsx
// 사내 메신저 대화 아카이브 검색 — 질문을 임베딩해 로컬 암호화 저장소(electron/chatArchiveStore.ts)에서
// 관련 대화 청크를 찾고, 그 컨텍스트로 AI(runOneShotPrompt, 기존 Claude/Codex 등 원샷 호출 인프라)에게
// 질의해 답변을 생성한다. 서버/클라우드 없음 — 검색과 복호화 모두 로컬에서만 일어남.
//
// 레이아웃: 좌(관련 대화 후보 리스트) / 우(AI와 대화하며 후보를 좁혀나가는 채팅). 첫 검색으로 후보를
// 넉넉히 모은 뒤, 사용자가 우측 채팅으로 "이거 말고", "더 자세히" 등 이어가면 AI가 매 턴 판단해
// (a) 기존 후보 안에서 관련성 재평가 후 필터링/재정렬 하거나 (b) 첫 검색 자체가 빗나갔다고 판단되면
// 새 검색어로 재검색해 후보 자체를 다시 확보한다 — 검색 로직만으로는 첫 질문의 표현이 안 맞으면
// 그걸로 끝이라 결과 품질이 "케바케"가 된다는 지적을 반영.
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { runOneShotPrompt } from '../utils/aiOneShot';
import { displayRoomLabel } from '../utils/chatArchiveRoomNames';

type ContextMessage = { ts: number; sender: string; text: string; isHit: boolean };
// matchCount — 질문 키워드 중 이 메시지에 그대로 포함된 개수. search() 의 1차 정렬 기준이라,
// 여러 표현(paraphrase)의 결과를 합칠 때도 이 값을 score 보다 먼저 봐야 순위가 유지된다.
type SearchResult = { roomId: string; ts: number; sender: string; text: string; score: number; matchCount?: number; context?: ContextMessage[] };
type RoomStat = { roomId: string; count: number; lastTs: number };
type ChatMessage = { role: 'user' | 'assistant'; content: string };

function formatTs(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// marked 는 HTML 특수문자(따옴표 포함)를 이스케이프하므로, 나중에 삽입할 <a>/<span> 마커나 원본
// 따옴표를 그대로 심어두면 같이 이스케이프되거나(따옴표가 두 겹으로 보임), 마크다운 리스트/문단
// 파서가 앞뒤 공백을 트리밍해 공백에 의존하는 마커가 유실될 수 있다. 그래서 알파벳+숫자로만 된,
// 공백 없는 유니크 마커를 심어두고 HTML 변환이 끝난 뒤 실제 태그로 치환하는 2단계 방식을 쓴다.
const REF_MARKER = (n: number) => `xREFx${n}xMARKx`;
const QUOTE_OPEN = 'xQOPENxMARKx';
const QUOTE_CLOSE = 'xQCLOSExMARKx';

// 답변 안의 "[29]" "[49][50]" 같은 발췌문 번호 참조를 찾아 마커로 치환.
function markRefPlaceholders(text: string): string {
  return text.replace(/\[(\d+)\]/g, (_m, n) => REF_MARKER(Number(n)));
}

// 답변 안의 " 따옴표로 묶인 실제 인용문 "을 찾아 원본 큰따옴표를 마커로 대체한다 — 여는/닫는
// 쌍만 대상으로 하고(홑따옴표는 흔히 강조 등 다른 용도로도 쓰여 오탐이 잦음), 문서 전체가 아니라
// 줄 단위로 처리해 따옴표가 짝 없이 등장하는 줄에서 뒤 내용을 통째로 삼키는 걸 방지한다. 원본 "를
// 남기지 않고 완전히 마커로 바꿔야 marked 가 그 위에 또 &quot; 이스케이프를 씌우지 않는다.
function markQuotePlaceholders(text: string): string {
  return text
    .split('\n')
    .map(line => {
      const parts = line.split('"');
      if (parts.length < 3 || parts.length % 2 === 0) return line; // 짝 없는 따옴표 — 건드리지 않음
      return parts
        .map((part, i) => (i % 2 === 1 ? `${QUOTE_OPEN}${part}${QUOTE_CLOSE}` : part))
        .join('');
    })
    .join('\n');
}

// AI 답변을 마크다운으로 렌더 — 그냥 텍스트로 뿌리면 **굵게** 같은 문법이 그대로 별표로 보여서
// 가독성이 떨어졌음. 이 화면은 mermaid/표 등 복잡한 전처리가 필요 없어 marked 만 바로 사용.
// 추가로 두 가지 후처리: "[N]" 발췌문 번호는 클릭 가능한 링크로(누르면 그 결과의 "메신저에서 보기"와
// 동일하게 동작), 실제 인용된 대화 문장(" "로 묶인 부분)은 색을 달리해 눈에 띄게 한다.
const AnswerMarkdown: React.FC<{ content: string; results: SearchResult[]; onRefClick: (index: number) => void }> = ({ content, results, onRefClick }) => {
  const html = useMemo(() => {
    const marked_ = markQuotePlaceholders(markRefPlaceholders(content));
    let out = marked.parse(marked_, { breaks: true }) as string;
    out = out.replace(/xREFx(\d+)xMARKx/g, (_m, nStr) => {
      const n = Number(nStr);
      const r = results[n - 1];
      if (!r) return `[${n}]`;
      return `<a href="#" class="chat-archive-ref-link" data-ref-index="${n - 1}">[${n}]</a>`;
    });
    out = out.split(QUOTE_OPEN).join('<span class="chat-archive-quote">"');
    out = out.split(QUOTE_CLOSE).join('"</span>');
    return out;
  }, [content, results]);

  const onClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest('.chat-archive-ref-link') as HTMLElement | null;
    if (!target) return;
    e.preventDefault();
    const idx = Number(target.dataset.refIndex);
    const r = results[idx];
    if (!r) return;
    // 참조 링크([N])가 속한 문장/블록(li, p 등) 안에 인용문(하이라이트된 " " 문구)이 있으면
    // 그 인용문으로 검색시킨다 — 참조번호 자체가 가리키는 원본 검색 문장(r.text)과, AI 답변에
    // 실제로 인용된 문장이 다른 경우가 많아, 답변 화면에서 눈에 보이는 그 인용문으로 찾는 게
    // 사용자가 방금 읽은 내용과 일치해 훨씬 자연스럽다. 인용문이 없으면 기존처럼 r.text 로 폴백.
    const block = target.closest('li, p, td, th') || target.parentElement;
    const quote = block?.querySelector('.chat-archive-quote')?.textContent?.trim();
    const text = quote ? quote.replace(/^"|"$/g, '') : r.text;
    // AI 가 인용하며 어미/구두점을 미묘하게 바꿔 적으면(예: "문제되서"→"문제되어") 그 인용문으로는
    // 메신저 자체 검색(정확한 부분 문자열 매칭)이 조용히 실패한다(실측 사례) — 인용문으로 검색해
    // 결과가 없을 때 재시도할 수 있도록 원본 발췌 문장(r.text, 아카이브에 저장된 그대로)을
    // fallbackText 로 같이 실어 보낸다.
    try { window.dispatchEvent(new CustomEvent('chat-archive-open-in-messenger', { detail: { text, fallbackText: r.text, sender: r.sender, roomId: r.roomId } })); } catch {}
    onRefClick(idx);
  }, [results, onRefClick]);

  return (
    <>
      <style>{`
        .chat-archive-ref-link { color: #6ab0ff; text-decoration: none; font-weight: 600; cursor: pointer; }
        .chat-archive-ref-link:hover { text-decoration: underline; }
        .chat-archive-quote { color: #f0c674; }
      `}</style>
      <div
        className="chat-archive-answer claude-chat-msg-content"
        style={{ alignSelf: 'flex-start', maxWidth: '90%', background: '#1a1a2e', border: '1px solid #3a3a5a', borderRadius: 6, padding: '12px 16px', fontSize: 13, lineHeight: 1.6 }}
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
};

const HISTORY_STORAGE_KEY = 'chatArchiveSearch.history';
const HISTORY_MAX = 20;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string') : [];
  } catch { return []; }
}

function saveHistory(history: string[]) {
  try { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, HISTORY_MAX))); } catch {}
}

// AI 프롬프트에 넣을 개수 상한 — chatArchiveStore.search() 자체는 하드캡이 없어 화면 리스트는
// 전부 다 보여줄 수 있지만, 프롬프트가 무한정 커지는 걸 막기 위해 여기서만 자른다. "재판단"이
// 리스트 전체에 걸쳐 일어나야 하므로, 화면에 보여주는 candidates 자체도 이 범위로 맞춘다(이원화 제거).
const AI_CONTEXT_LIMIT = 60;

// 검색된 메시지 한 줄만 주면 "원인 파악 중" 같은 발언만 걸리고, 몇 마디 뒤에 나온 실제 결론(문장이
// 달라 임베딩 유사도가 낮음)을 AI 가 못 보는 문제가 있어 — 검색된 메시지 앞뒤로 같이 저장된 대화
// 흐름(context)을 통째로 프롬프트에 넣는다. → 표시가 실제 검색에 걸린 줄. 최초 검색/재검색(RESEARCH
// 액션) 양쪽에서 재사용.
function buildCandidateContext(candidates: SearchResult[]): string {
  return candidates
    .map((r, i) => {
      const convo = (r.context && r.context.length > 0 ? r.context : [{ ts: r.ts, sender: r.sender, text: r.text, isHit: true }])
        .map(m => `${m.isHit ? '→' : ' '} (${formatTs(m.ts)}, ${m.sender || '알수없음'}) ${m.text}`)
        .join('\n');
      return `[${i + 1}] 방 ${r.roomId} 대화 흐름 (→ 표시가 검색에 걸린 줄):\n${convo}`;
    })
    .join('\n\n');
}

export const ChatArchiveSearch: React.FC = () => {
  const [loading, setLoading] = useState(false);
  // candidates — 현재 후보 리스트. 첫 채팅 메시지로 채워지고, 이후 대화에서 AI 가 KEEP(재판단
  // 필터링)/RESEARCH(재검색) 액션을 낼 때마다 통째로 교체된다.
  const [candidates, setCandidates] = useState<SearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<RoomStat[] | null>(null);
  // chatLog — 대화 히스토리. 검색바 없이, 사용자가 채팅 입력창에 치는 첫 메시지가 곧 최초 검색어가
  // 되고, 그 결과 요약이 첫 assistant 메시지가 된다. 이후 모든 대화가 이 하나의 흐름으로 이어진다.
  const [chatLog, setChatLog] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  // 이전에 입력했던 첫 질문들 중 지금 입력과 비슷한 것을 드롭다운으로 보여준다 — localStorage 에
  // 누적 저장해두고, 입력값이 바뀔 때마다 부분일치로 필터링. 대화가 아직 시작 전(chatLog 비어있음)
  // 일 때만 노출 — 대화 중간에 예전 "첫 질문" 자동완성이 뜨면 오히려 헷갈린다.
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [showHistory, setShowHistory] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(-1);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const filteredHistory = useMemo(() => {
    if (chatLog.length > 0) return [];
    const q = chatInput.trim().toLowerCase();
    if (!q) return history.slice(0, 8);
    return history.filter(h => h !== chatInput && h.toLowerCase().includes(q)).slice(0, 8);
  }, [history, chatInput, chatLog.length]);
  const commitHistory = useCallback((q: string) => {
    setHistory(prev => {
      const next = [q, ...prev.filter(h => h !== q)].slice(0, HISTORY_MAX);
      saveHistory(next);
      return next;
    });
  }, []);
  // AI 답변 안의 "[N]" 링크를 클릭하면 좌측 "관련 대화" 리스트에서 그 항목으로 스크롤 이동시키고
  // 잠깐 하이라이트해 눈에 띄게 한다 — 어느 항목을 눌렀는지 바로 확인할 수 있게.
  const resultItemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onRefClick = useCallback((index: number) => {
    const el = resultItemRefs.current[index];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedIndex(index);
    highlightTimerRef.current = setTimeout(() => setHighlightedIndex(null), 2000);
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const res = await (window as any).api?.chatArchiveGetStats?.();
      if (res?.ok) setStats(res.stats || []);
    } catch {}
  }, []);

  // 검색 파이프라인 — 질문 문자열 하나를 받아 여러 표현(paraphrase)으로 확장해 검색하고, matchCount
  // 우선 정렬된 SearchResult[] 를 반환한다. 최초 검색(첫 채팅 메시지)과 재검색(RESEARCH 액션) 양쪽에서 재사용.
  const searchCandidates = useCallback(async (q: string, signal: AbortSignal): Promise<SearchResult[]> => {
    // 질문을 몇 가지 다른 표현으로 바꿔서 같이 검색한다 — 짧은 문구 하나만 임베딩하면 실제
    // 대화에 쓰인 표현과 조금만 달라도(예: "vob엔"↔"vob 에", "안들어감"↔"없음") 임베딩 유사도가
    // 벌어져서 못 찾는 경우가 있었음. 표현을 늘리면 그중 하나는 원문 표현과 가까울 확률이 높아짐.
    let paraphrases: string[] = [];
    try {
      const pRes = await runOneShotPrompt('claude', `다음 질문을 사내 메신저 대화 검색에 쓸 다른 표현 3가지로 바꿔줘(같은 뜻, 어순/어미/띄어쓰기를 다양하게). 설명 없이 표현만 한 줄에 하나씩 적어줘.\n\n질문: ${q}`, undefined, signal);
      paraphrases = pRes.split('\n').map(s => s.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean).slice(0, 3);
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      /* 재구성 실패해도 원문 질문만으로는 계속 진행 */
    }
    const allQueries = Array.from(new Set([q, ...paraphrases]));

    // topK 를 넉넉히 잡고, 표현별 결과를 합친다(같은 메시지가 여러 표현에서 걸리면 더 나은 쪽
    // 유지 — matchCount 를 score 보다 먼저 비교해야, search() 가 매긴 "키워드 여러 개 겹침"
    // 우선순위가 여기서 다시 무너지지 않는다. 순수 score 비교로 이걸 덮으면, chatArchiveStore.ts
    // 가 어렵게 끌어올린 순위가 여러 표현을 합치는 과정에서 원점수 기준으로 도로 밀려난다.
    const isBetter = (a: SearchResult, b: SearchResult) =>
      (a.matchCount ?? 0) !== (b.matchCount ?? 0) ? (a.matchCount ?? 0) > (b.matchCount ?? 0) : a.score > b.score;
    const merged = new Map<string, SearchResult>();
    for (const qq of allQueries) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const embedRes = await (window as any).api?.chatArchiveEmbedText?.(qq);
      if (!embedRes?.ok) continue;
      const searchRes = await (window as any).api?.chatArchiveSearch?.(qq, embedRes.embedding, 20);
      if (!searchRes?.ok) continue;
      for (const r of (searchRes.results || []) as SearchResult[]) {
        const key = `${r.roomId}|${r.ts}|${r.sender}`;
        const existing = merged.get(key);
        if (!existing || isBetter(r, existing)) merged.set(key, r);
      }
    }
    return Array.from(merged.values()).sort((a, b) =>
      (b.matchCount ?? 0) !== (a.matchCount ?? 0) ? (b.matchCount ?? 0) - (a.matchCount ?? 0) : b.score - a.score);
  }, []);

  // 최초 검색 — chatLog 가 비어있는 상태에서 첫 채팅 메시지를 보내면 트리거된다. 사용자 메시지는
  // sendChatMessage 가 이미 chatLog 에 즉시 넣어둔 상태(입력 즉시 화면에 보이도록) — 여기서는
  // candidates 를 채우고 첫 AI 응답(요약)을 assistant 메시지로 append 만 한다.
  const runInitialSearch = useCallback(async (q: string, signal: AbortSignal) => {
    commitHistory(q);
    const found = await searchCandidates(q, signal);
    const limited = found.slice(0, AI_CONTEXT_LIMIT);
    setCandidates(limited);
    if (limited.length === 0) {
      setError('관련된 대화를 찾지 못했습니다. 아직 백필이 안 됐거나, 관련 대화가 없을 수 있습니다.');
      return;
    }
    const context = buildCandidateContext(limited);
    // 인용문(따옴표로 묶는 부분)은 [N] 클릭 시 그 문구 그대로 사내 메신저 자체 검색창에 넘어간다
    // (AnswerMarkdown 의 onClick 참고) — 메신저 검색은 부분 문자열이라도 "정확히 일치"해야
    // 매칭되므로, AI 가 어미/조사/구두점을 자연스럽게 살짝 바꿔 인용하면(예: 원문 "문제되서"를
    // "문제되어"로) 검색이 조용히 실패한다(실측 사례). 반드시 원문 그대로 베끼도록 명시.
    const prompt = `다음은 사내 메신저 대화 기록에서 질문과 관련성이 높은 부분을 찾아, 그 앞뒤 대화 흐름과 함께 발췌한 것입니다. → 표시된 줄이 검색에 직접 걸린 메시지이고, 나머지는 문맥 이해를 위한 주변 대화입니다. 흐름 전체를 보고 실제 원인/결론을 찾아 답하세요(→ 표시된 줄 자체가 아니라, 그 뒤에 이어진 대화에서 실제 결론이 나온 경우가 많습니다).\n\n주의: 발췌문들이 서로 다른 시점/사건에 대한 것일 수 있습니다. 하나의 원인으로 단정하지 말고, 발췌문들에서 확인되는 서로 다른 원인/사례를 전부 나열하세요 — 각 원인마다 근거가 된 발췌문 번호([1], [2] 등)를 같이 표시하고, 어느 것이 질문 상황과 가장 가까워 보이는지도 언급하세요. 근거가 부족한 부분은 "확실하지 않다"고 표시하세요.\n\n답변에서 " "로 원문을 인용할 때는 어미/조사/띄어쓰기/구두점 하나도 바꾸지 말고 발췌문에 있는 글자 그대로 정확히 옮기세요(자연스럽게 다듬지 마세요) — 이 인용문은 그대로 검색어로도 쓰입니다.\n\n${context}\n\n질문: ${q}`;
    const ai = await runOneShotPrompt('claude', prompt, undefined, signal);
    setChatLog(prev => [...prev, { role: 'assistant', content: ai }]);
  }, [commitHistory, searchCandidates]);

  // 후속 대화 — 사용자가 이어서 대화할 때마다, AI 에게 (a) 기존 후보 중 관련 있는 것만 남기고
  // 재정렬(KEEP) 할지, (b) 지금까지의 후보 전체가 빗나갔다고 판단해 새 검색어로 재검색(RESEARCH)
  // 할지 판단시킨다. 프롬프트 맨 앞줄에 파싱 가능한 ACTION 마커를 강제하고, 그 아래부터를
  // 사용자에게 보일 본문으로 쓴다.
  const runFollowUp = useCallback(async (nextLog: ChatMessage[], signal: AbortSignal) => {
    const context = buildCandidateContext(candidates);
    const historyText = nextLog.map(m => `${m.role === 'user' ? '사용자' : 'AI'}: ${m.content}`).join('\n\n');
    // "찾아보겠습니다", "확인해보겠습니다" 같은 예고성 문구만 남기고 실제 결과(KEEP/RESEARCH 마커
    // + 본문)를 안 주는 경우가 있었다(실측) — 이 대화는 한 번의 응답으로 끝나고 그 다음엔 사용자가
    // 다시 말을 걸어야 이어지므로, 예고 없이 그 자리에서 바로 마커와 결과 본문을 내도록 강제한다.
    const prompt = `당신은 사내 메신저 대화 아카이브에서 사용자가 원하는 대화를 찾아주는 assistant 입니다. 아래는 지금까지의 대화 후보 목록과, 사용자와 나눈 대화 기록입니다.\n\n반드시 첫 줄에 다음 두 형식 중 하나로 ACTION 마커를 쓰고, 그 다음 줄부터 사용자에게 보여줄 최종 답변을 이어서 쓰세요(마커 자체는 답변에 노출되지 않으니 자연스럽게 써도 됩니다):\n- ACTION: KEEP [1,3,7]  — 후보 목록 중 실제로 관련 있는 항목만, 관련성이 높은 순서로 번호를 나열(기존 후보 안에서 답이 있다고 판단될 때)\n- ACTION: RESEARCH "새 검색어"  — 사용자가 "그게 아니라", "다시 찾아줘"처럼 기존 후보 전체가 방향이 틀렸다고 암시할 때, 새로 검색할 문구를 따옴표 안에 작성\n\n중요: 이 응답은 사용자와의 한 턴짜리 대화입니다. "찾아보겠습니다", "확인해보겠습니다", "정리해 드리겠습니다" 처럼 나중에 결과를 주겠다는 예고만 하고 끝내지 마세요 — 지금 이 응답 안에서 바로 최종 결과(관련 항목 목록이나 답변 내용)까지 전부 제시해야 합니다. 사용자는 이 응답 뒤에 곧바로 결과를 받아야 하며, 다시 재촉해야 결과가 나오면 안 됩니다.\n\n인용문(" "로 묶는 부분)은 발췌문 원문 그대로(어미/조사/구두점 변경 금지) 옮기세요 — 검색어로도 쓰입니다.\n\n현재 후보 목록:\n${context}\n\n대화 기록:\n${historyText}`;
    const ai = await runOneShotPrompt('claude', prompt, undefined, signal);
    // AI 가 마커 앞에 공백/개행을 넣는 경우가 있어(예: "\nACTION: KEEP [...]"), ^ 앵커가 실제
    // 문자열 맨 앞만 보는 것과 어긋나 파싱이 실패하고 마커 원문이 그대로 사용자에게 노출되는
    // 문제가 있었다(실측) — 매칭 전에 trim 해서 이 어긋남을 없앤다.
    const aiTrimmed = ai.trim();
    const keepMatch = aiTrimmed.match(/^ACTION:\s*KEEP\s*\[([\d,\s]*)\]\s*\n?/i);
    const researchMatch = aiTrimmed.match(/^ACTION:\s*RESEARCH\s*"([^"]+)"\s*\n?/i);

    if (researchMatch) {
      const newQuery = researchMatch[1].trim();
      const body = aiTrimmed.slice(researchMatch[0].length).trim();
      const found = await searchCandidates(newQuery, signal);
      const limited = found.slice(0, AI_CONTEXT_LIMIT);
      setCandidates(limited);
      setChatLog([...nextLog, { role: 'assistant', content: body || ai }]);
    } else if (keepMatch) {
      const indices = keepMatch[1].split(',').map(s => Number(s.trim()) - 1).filter(n => Number.isInteger(n) && n >= 0);
      const body = aiTrimmed.slice(keepMatch[0].length).trim();
      if (indices.length > 0) {
        setCandidates(prev => indices.map(i => prev[i]).filter(Boolean));
      }
      setChatLog([...nextLog, { role: 'assistant', content: body || ai }]);
    } else {
      // 마커 파싱 실패 — 안전하게 candidates 는 그대로 두고 응답 전체를 그냥 보여준다.
      setChatLog([...nextLog, { role: 'assistant', content: ai }]);
    }
  }, [candidates, searchCandidates]);

  const sendChatMessage = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || loading) return;
    setShowHistory(false);
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    setLoading(true);
    setError(null);
    setChatInput('');
    // 사용자 메시지는 AI 응답을 기다리지 않고 즉시 화면에 반영 — 입력한 게 바로 보여야 자연스럽다.
    // AI 가 생각하는 동안은 렌더링 쪽에서 loading 상태로 "..." 표시를 보여주다 응답이 오면 대체한다.
    const isFirstMessage = chatLog.length === 0;
    const nextLog: ChatMessage[] = [...chatLog, { role: 'user', content: text }];
    setChatLog(nextLog);
    try {
      if (isFirstMessage) {
        // 아직 대화가 없었던 상태 — 이 메시지가 곧 최초 검색어.
        await runInitialSearch(text, signal);
      } else {
        await runFollowUp(nextLog, signal);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setError('중지했습니다.');
      } else {
        setError(String(err?.message || err));
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [chatInput, loading, chatLog, runInitialSearch, runFollowUp]);

  const stopSearch = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minWidth: 0, minHeight: 0, background: '#14141f', color: '#ddd' }}>
      <div style={{ flex: '0 0 auto', display: 'flex', justifyContent: 'flex-end', padding: '6px 10px', borderBottom: '1px solid #2a2a3a' }}>
        <button
          onClick={loadStats}
          title="방별 아카이브 현황"
          style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #3a3a5a', background: '#1a1a2e', color: '#ccc', cursor: 'pointer', fontSize: 12 }}
        >
          현황
        </button>
      </div>

      {stats && (
        <div style={{ flex: '0 0 auto', maxHeight: 140, overflowY: 'auto', padding: '6px 10px', fontSize: 11, color: '#9aa', borderBottom: '1px solid #2a2a3a' }}>
          {stats.length === 0 ? '아카이브된 대화가 없습니다 — 사내 메신저 탭에서 "전체 백필"을 먼저 실행하세요.' : (
            stats.map(s => (
              <div key={s.roomId}>방 {displayRoomLabel(s.roomId)} — {s.count}건, 최근 {formatTs(s.lastTs)}</div>
            ))
          )}
        </div>
      )}

      {error && (
        <div style={{ flex: '0 0 auto', padding: '8px 12px', color: '#e06060', fontSize: 12 }}>⚠ {error}</div>
      )}

      {/* 좌: 관련 대화 후보 리스트 / 우: AI 와 대화하며 후보를 좁혀나가는 채팅. 검색바 없이, 우측
          채팅 입력창에 치는 첫 메시지가 곧 최초 검색어가 된다(sendChatMessage 참고). */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' }}>
        <div style={{ flex: '0 0 380px', minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #2a2a3a' }}>
          {candidates.length > 0 ? (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 }}>
              <div style={{ fontSize: 11, color: '#889', marginBottom: 6 }}>관련 대화 {candidates.length}건</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {candidates.map((r, i) => (
                  <div
                    key={`${r.roomId}-${r.ts}-${i}`}
                    ref={el => { resultItemRefs.current[i] = el; }}
                    style={{
                      background: '#1a1a2a', border: '1px solid #2a2a3a', borderRadius: 4, padding: '6px 10px', fontSize: 12,
                      transition: 'background-color 0.3s, border-color 0.3s',
                      ...(highlightedIndex === i ? { background: '#3a3a1a', borderColor: '#f0c674' } : {}),
                    }}
                  >
                    <div style={{ color: '#889', marginBottom: 2, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span>[{i + 1}] 방 {displayRoomLabel(r.roomId)} · {r.sender || '알수없음'} · {formatTs(r.ts)} · 유사도 {r.score.toFixed(2)}</span>
                      <a
                        href="#"
                        onClick={e => {
                          e.preventDefault();
                          try { window.dispatchEvent(new CustomEvent('chat-archive-open-in-messenger', { detail: { text: r.text, sender: r.sender, roomId: r.roomId } })); } catch {}
                        }}
                        title="사내 메신저 검색창에서 이 대화 찾기 — 옛 대화라 바로 스크롤 이동은 안 되지만, 메신저 자체 검색 결과로 진입합니다"
                        style={{ color: '#6ab0ff', textDecoration: 'none', whiteSpace: 'nowrap', flexShrink: 0 }}
                      >
                        🔗 메신저에서 보기
                      </a>
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{r.text}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#667', fontSize: 12, padding: 20, textAlign: 'center' }}>
              오른쪽 채팅창에 질문을 입력해 검색을 시작하세요.
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {chatLog.length === 0 && (
              <div style={{ color: '#667', fontSize: 12 }}>궁금한 걸 물어보세요. 예: "vnf 패키지 준비중인데 amen 관련 작업 정리해줘"</div>
            )}
            {chatLog.map((m, i) => (
              m.role === 'assistant' ? (
                <AnswerMarkdown key={i} content={m.content} results={candidates} onRefClick={onRefClick} />
              ) : (
                <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', background: '#2b3f5a', border: '1px solid #3a5a7a', borderRadius: 6, padding: '8px 12px', fontSize: 13, whiteSpace: 'pre-wrap' }}>
                  {m.content}
                </div>
              )
            ))}
            {/* 사용자 메시지는 sendChatMessage 가 이미 chatLog 에 즉시 넣어두므로, loading 중이고
                마지막이 user 메시지면(=아직 assistant 응답이 안 붙음) AI 가 답변을 만드는 동안임을
                점(...) 애니메이션으로 보여준다 — 응답이 오면 이 자리에 실제 assistant 메시지가
                append 되면서 자연스럽게 사라진다. */}
            {loading && chatLog.length > 0 && chatLog[chatLog.length - 1].role === 'user' && (
              <div style={{ alignSelf: 'flex-start', background: '#1a1a2e', border: '1px solid #3a3a5a', borderRadius: 6, padding: '10px 16px' }}>
                <style>{`
                  @keyframes chatArchiveDotPulse { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
                  .chat-archive-typing span { animation: chatArchiveDotPulse 1.2s infinite; display: inline-block; }
                  .chat-archive-typing span:nth-child(2) { animation-delay: 0.2s; }
                  .chat-archive-typing span:nth-child(3) { animation-delay: 0.4s; }
                `}</style>
                <span className="chat-archive-typing" style={{ color: '#889', fontSize: 18, lineHeight: 1 }}>
                  <span>.</span><span>.</span><span>.</span>
                </span>
              </div>
            )}
          </div>
          <div style={{ flex: '0 0 auto', position: 'relative', display: 'flex', gap: 8, padding: 10, borderTop: '1px solid #2a2a3a' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <input
                ref={chatInputRef}
                value={chatInput}
                onChange={e => { setChatInput(e.target.value); setShowHistory(true); setHistoryActiveIndex(-1); }}
                onFocus={() => setShowHistory(true)}
                onBlur={() => { window.setTimeout(() => setShowHistory(false), 120); }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (showHistory && historyActiveIndex >= 0 && filteredHistory[historyActiveIndex]) {
                      setChatInput(filteredHistory[historyActiveIndex]);
                      setShowHistory(false);
                    } else {
                      sendChatMessage();
                    }
                    return;
                  }
                  if (e.key === 'ArrowDown') {
                    if (!showHistory || filteredHistory.length === 0) return;
                    e.preventDefault();
                    setHistoryActiveIndex(i => (i + 1) % filteredHistory.length);
                  } else if (e.key === 'ArrowUp') {
                    if (!showHistory || filteredHistory.length === 0) return;
                    e.preventDefault();
                    setHistoryActiveIndex(i => (i <= 0 ? filteredHistory.length - 1 : i - 1));
                  } else if (e.key === 'Escape') {
                    setShowHistory(false);
                  }
                }}
                placeholder={chatLog.length === 0 ? '예: rld-enc-key 동작시 CurrKEY가 포함되나' : '예: 그거 말고 배포 지시문 쪽으로'}
                style={{ width: '100%', boxSizing: 'border-box', background: '#1a1a2e', color: '#eee', border: '1px solid #3a3a5a', borderRadius: 4, padding: '6px 10px', fontSize: 13 }}
              />
              {showHistory && filteredHistory.length > 0 && (
                <div style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 2, background: '#1a1a2e', border: '1px solid #3a3a5a', borderRadius: 4, zIndex: 10, boxShadow: '0 -4px 12px rgba(0,0,0,0.4)', maxHeight: 220, overflowY: 'auto' }}>
                  {filteredHistory.map((h, i) => (
                    <div
                      key={h}
                      onMouseDown={e => { e.preventDefault(); setChatInput(h); setShowHistory(false); chatInputRef.current?.focus(); }}
                      onMouseEnter={() => setHistoryActiveIndex(i)}
                      style={{ padding: '6px 10px', fontSize: 12, cursor: 'pointer', color: '#ccc', background: i === historyActiveIndex ? '#2b3f5a' : 'transparent', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {h}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={loading ? stopSearch : sendChatMessage}
              disabled={!loading && !chatInput.trim()}
              style={{ padding: '6px 14px', borderRadius: 4, border: '1px solid #3a3a5a', background: loading ? '#8b2b2b' : '#2b6b9b', color: '#fff', cursor: 'pointer', fontSize: 13 }}
            >
              {loading ? '중지' : '전송'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatArchiveSearch;
