// src/utils/aiOneShot.ts
// "프롬프트 하나 보내고 최종 텍스트 하나 받기" — 앱에 이런 API가 따로 없어서(전부 대화형
// 스트리밍 전제) 기존 *Send + onClaudeStream 조합을 재사용하는 얇은 헬퍼.
// ClaudeChat.tsx 의 스트림 파싱 로직(assistant 텍스트 블록 누적 → result/done 종료)과 동일한 프로토콜.
export type AiOneShotAgent = 'claude' | 'gemini' | 'codex' | 'antigravity' | 'custom';

// 타임아웃은 "전체 소요"가 아니라 "침묵" 기준이다.
//
// 예전에는 전체 60초 고정이었다. 그런데 대화 아카이브 검색은 프롬프트가 16만 자(약 4만 토큰)에
// 달하고 모델이 확장 사고(extended thinking)를 오래 하기 때문에, 아직 정상적으로 생성 중인데도
// 60초에서 프로세스를 죽여버렸다(메인 로그의 `[claude] close, code: 1` 이 그것 — CLI 가 실패한 게
// 아니라 우리가 죽인 결과였다).
//
// CLI 는 생각하는 동안에도 thinking_tokens 이벤트를 계속 흘려보낸다. 그래서 마지막 이벤트 이후
// 침묵한 시간으로 재면 "정말 멈춘 것"과 "오래 생각하는 것"이 구분된다. 전체 상한은 따로 둬서
// 스트림이 끊기지 않고 무한정 도는 경우까지 막는다.
const ONE_SHOT_IDLE_TIMEOUT_MS = 120_000;
const ONE_SHOT_MAX_TOTAL_MS = 10 * 60_000;

const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function runOneShotPrompt(agent: AiOneShotAgent, prompt: string, model?: string, signal?: AbortSignal): Promise<string> {
  const api = (window as any).api;
  if (!api?.onClaudeStream) return Promise.reject(new Error('API unavailable'));
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

  const sessionId = uid('worklog');
  const requestId = uid('worklog-req');

  return new Promise<string>((resolve, reject) => {
    let text = '';
    let settled = false;
    let dispose: (() => void) | undefined;

    const stopAgent = () => {
      try {
        if (agent === 'claude') api.claudeStop?.(sessionId, requestId);
        else if (agent === 'gemini') api.geminiStop?.(sessionId, requestId);
        else if (agent === 'codex') api.codexStop?.(sessionId, requestId);
        else if (agent === 'antigravity') api.antigravityStop?.(sessionId, requestId);
        else api.customStop?.(sessionId, requestId);
      } catch {}
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      signal?.removeEventListener('abort', onAbort);
      try { dispose?.(); } catch {}
      fn();
    };

    const onAbort = () => {
      stopAgent();
      settle(() => reject(new DOMException('Aborted', 'AbortError')));
    };
    signal?.addEventListener('abort', onAbort);

    // 침묵으로 끝나든 전체 상한에 걸리든, 받아둔 텍스트가 있으면 그것으로 성공 처리한다.
    const giveUp = (why: string) => {
      stopAgent();
      settle(() => (text.trim() ? resolve(text) : reject(new Error(why))));
    };
    let idleTimer = setTimeout(() => giveUp('AI 응답 시간이 초과되었습니다.'), ONE_SHOT_IDLE_TIMEOUT_MS);
    const totalTimer = setTimeout(() => giveUp('AI 응답이 너무 오래 걸립니다.'), ONE_SHOT_MAX_TOTAL_MS);
    // 이 요청에 대한 스트림이 하나라도 오면 침묵 타이머를 다시 시작한다 — 본문 텍스트뿐 아니라
    // thinking_tokens 같은 진행 신호도 "살아 있다"는 증거다.
    const touch = () => {
      if (settled) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => giveUp('AI 응답 시간이 초과되었습니다.'), ONE_SHOT_IDLE_TIMEOUT_MS);
    };

    dispose = api.onClaudeStream((p: any) => {
      if (!p || p.sessionId !== sessionId || p.requestId !== requestId) return;
      touch();
      const msg = p.message;
      if (!msg) return;
      if (msg.type === 'assistant' && msg.message?.content) {
        const chunk = msg.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
        if (chunk) text += chunk;
      } else if (msg.type === 'result' || msg.type === 'done') {
        settle(() => resolve(text));
      } else if (msg.type === 'error') {
        settle(() => reject(new Error(String(msg.text || 'AI 요청 실패'))));
      }
    });

    try {
      if (agent === 'claude') {
        // disallowBash — Bash 등 실행형 툴 차단(최선 노력). SSH/로컬 마운트 컨텍스트 없이 호출하므로
        // 요약 작업에 불필요한 툴(SSH exec 등)은 애초에 등록되지 않는다.
        api.claudeSend?.(sessionId, prompt, [], true, undefined, null, undefined, model, false, requestId);
      } else if (agent === 'gemini') {
        api.geminiSend?.(sessionId, prompt, requestId, model);
      } else if (agent === 'codex') {
        api.codexSend?.(sessionId, prompt, requestId, model);
      } else if (agent === 'antigravity') {
        api.antigravitySend?.(sessionId, prompt, requestId, model);
      } else {
        api.customSend?.(sessionId, [{ role: 'user', content: prompt }], requestId);
      }
    } catch (err: any) {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}
