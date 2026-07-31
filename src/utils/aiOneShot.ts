// src/utils/aiOneShot.ts
// "프롬프트 하나 보내고 최종 텍스트 하나 받기" — 앱에 이런 API가 따로 없어서(전부 대화형
// 스트리밍 전제) 기존 *Send + onClaudeStream 조합을 재사용하는 얇은 헬퍼.
// ClaudeChat.tsx 의 스트림 파싱 로직(assistant 텍스트 블록 누적 → result/done 종료)과 동일한 프로토콜.
export type AiOneShotAgent = 'claude' | 'gemini' | 'codex' | 'antigravity' | 'custom';

const ONE_SHOT_TIMEOUT_MS = 60_000;

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
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { dispose?.(); } catch {}
      fn();
    };

    const onAbort = () => {
      stopAgent();
      settle(() => reject(new DOMException('Aborted', 'AbortError')));
    };
    signal?.addEventListener('abort', onAbort);

    const timer = setTimeout(() => {
      stopAgent();
      settle(() => (text.trim() ? resolve(text) : reject(new Error('AI 응답 시간이 초과되었습니다.'))));
    }, ONE_SHOT_TIMEOUT_MS);

    dispose = api.onClaudeStream((p: any) => {
      if (!p || p.sessionId !== sessionId || p.requestId !== requestId) return;
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
