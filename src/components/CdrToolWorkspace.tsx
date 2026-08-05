// src/components/CdrToolWorkspace.tsx
// SKB SSW Call Log / CDR(C5) 파서 도구 — 순수 클라이언트 사이드(정적) 도구라 flowchart-editor 와
// 같은 방식으로 public/calllog-cdr-tool 에 자체 호스팅해 앱과 같은 origin(pepeapp://app)에서
// iframe 으로 띄운다. 문서 open/save 개념이 없는 도구라(붙여넣기/파일선택 입력, 화면 내 결과만)
// 여러 문서 미니탭 관리 없이 iframe 하나로 충분하다.
//
// SSH 세션 연결 — 이 iframe 은 자체 SSH 연결이 없으므로, "SSH 세션에서 clog 파일 가져오기"는
// postMessage 로 부모(이 컴포넌트)에 위임한다: iframe 이 {type:'read-file', termId, path} 를
// 보내면, 여기서 이미 연결돼 있는 터미널의 window.api.sftpReadFile() 을 그대로 재사용해 결과만
// 돌려준다 — 새 SSH 연결이나 새 백엔드 IPC가 필요 없다. "실시간"도 이 read-file 요청을 iframe
// 쪽에서 주기적으로 반복하는 폴링일 뿐, 여기서는 별도 처리가 없다.
import { useEffect, useRef } from 'react';

export type CdrSshSession = { termId: string; label: string };
// 창 분리/재도킹으로 이 워크스페이스가 다른 창으로 옮겨가면 iframe 은 새 렌더러에서 처음부터
// 다시 로드되어 입력과 결과가 전부 사라졌다("초기화"). 결과 표는 입력에서 즉시 다시 계산되므로,
// 입력과 활성 탭만 옮기면 화면이 그대로 복원된다 — 도구 쪽(resources/calllog-cdr-tool/index.html)이
// 입력이 바뀔 때마다 state 메시지를 보내고, 여기서 그것을 워크스페이스 상태로 올린다.
// clogSrc/cdrSrc — 파싱에 쓰인 "원문 전체". 파일이나 SSH 로 불러오면 입력창에는 앞 5줄 + 요약만
// 남고 원문은 도구 안에 따로 보관되므로(setSourceText), 입력창 값만 옮기면 내용이 다 안 나온다.
// stashed — 원문이 커서 workspaceState 에 싣지 않고 메인 프로세스에 맡겼다는 표식(App.tsx 의
// serializeTab 참고). 새 창은 이 표식을 보고 cdrUnstash 로 받아온다.
export type CdrToolState = {
  activeTab?: string; clogSrc?: string; cdrSrc?: string; stashed?: boolean;
  // 파일명 표시줄과 출처 라벨 — 데이터만 살아나고 "어느 파일이었는지" 가 사라지면 헷갈린다.
  clogOrigin?: string; cdrOrigin?: string; clogFileLabel?: string; cdrFileLabel?: string;
};

// 워크스페이스별 최신 상태를 모듈 스코프에 둔다.
//
// 처음에는 onStateChange -> workspaceStateRef 만 썼는데, 창을 옮기는 시점(serializeTab)에 그 값이
// 비어 있는 경우가 있었다(실측: 상태는 2945자로 잘 들어왔는데 복원 때 clog=0). 탭 제거/추가와
// 컴포넌트 재마운트가 얽히면서 갓 뜬 빈 iframe 의 보고가 덮어쓰는 순서가 생긴다.
// SqlToolWorkspace 가 같은 문제로 이미 쓰는 방식을 따른다 — 직렬화 시점에 여기서 직접 꺼내 간다.
const cdrStateCache = new Map<string, CdrToolState>();
const hasContent = (st?: CdrToolState) => !!st && !!((st.clogSrc || '').trim() || (st.cdrSrc || '').trim());
/** App.tsx 의 serializeTab 이 창 이동 시 호출한다.
 *
 * 원문이 크면(파일에서 불러온 CDR 은 수십 MB 가 흔하다) 상태에 그대로 실으면 serializeTab 의
 * JSON 왕복에 걸려 창 이동이 멈춘다. 그래서 큰 것은 메인 프로세스에 맡기고(cdr:stash) 표식만
 * 남긴다 — 새 창이 뜨면서 받아간다. 작은 것은 그대로 실어 보낸다(왕복이 필요 없는 크기다). */
const CDR_INLINE_LIMIT = 200000;
export function serializeCdrState(instanceId: string): CdrToolState | undefined {
  const st = cdrStateCache.get(instanceId);
  if (!st) return undefined;
  const size = (st.clogSrc || '').length + (st.cdrSrc || '').length;
  if (size <= CDR_INLINE_LIMIT) return st;
  try {
    void (window as any).api?.cdrStash?.({ tabId: instanceId, state: st });
    console.log('[cdr] 원문', size, '자 — 메인에 맡김');
    return {
      activeTab: st.activeTab, stashed: true,
      // 라벨은 작으니 표식과 함께 실어 보낸다 — 원문을 받아오기 전에도 화면이 맞게 보인다.
      clogOrigin: st.clogOrigin, cdrOrigin: st.cdrOrigin,
      clogFileLabel: st.clogFileLabel, cdrFileLabel: st.cdrFileLabel,
    };
  } catch {
    return st;   // 맡기지 못했으면 그대로 실어 본다
  }
}

const api = () => (window as any).api || {};

export function CdrToolWorkspace({ instanceId, sshSessions, initialState, onStateChange }: {
  instanceId: string;
  sshSessions: CdrSshSession[];
  initialState?: CdrToolState;
  onStateChange?: (state: CdrToolState) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // 복원은 iframe 이 로드된 뒤에 한 번만 — 스크립트가 준비되기 전에 보내면 무시된다.
  // 넘겨받은 상태가 비어 있으면 모듈 캐시에 남은 값을 쓴다 — 같은 창 안에서 탭이 제거/재추가
  // 되는 경로(재도킹)에서는 payload 쪽이 비어 있을 수 있다.
  const restoreRef = useRef(hasContent(initialState) ? initialState : (cdrStateCache.get(instanceId) || initialState));
  const restoredRef = useRef(false);
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const sshSessionsRef = useRef(sshSessions);
  sshSessionsRef.current = sshSessions;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const postSessions = () => {
      iframe.contentWindow?.postMessage({ source: 'pepe-cdr', type: 'sessions', sessions: sshSessionsRef.current }, '*');
    };
    // 복원은 load 이벤트가 아니라 도구가 보내는 ready 신호를 보고 한다(아래 message 핸들러).
    // load 직후에 보내면 아직 빈 문서(about:blank)에 닿아 조용히 사라진다.
    const onLoad = () => { postSessions(); };
    onLoad();
    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshSessions]);

  useEffect(() => {
    const handler = async (evt: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || evt.source !== iframe.contentWindow) return;
      const data = evt.data;
      if (!data || data.source !== 'pepe-cdr') return;
      if (data.type === 'ready') {
        const st = restoreRef.current;
        if (st && !restoredRef.current && (st.clogSrc || st.cdrSrc)) {
          restoredRef.current = true;
          iframe.contentWindow?.postMessage({ source: 'pepe-cdr', type: 'restore', state: st }, '*');
        } else if (st?.stashed && !restoredRef.current) {
          // 메인에 맡겨둔 원문을 받아온다. 맡기는 쪽(원본 창)의 IPC 가 아직 도착하지 않았을 수
          // 있어 몇 번 다시 시도한다.
          restoredRef.current = true;
          void (async () => {
            for (let i = 0; i < 8; i++) {
              const got = await (window as any).api?.cdrUnstash?.(instanceId).catch(() => null);
              if (got && ((got.clogSrc || '').length || (got.cdrSrc || '').length)) {
                console.log('[cdr] 맡겨둔 원문 받음', (got.clogSrc || '').length, (got.cdrSrc || '').length);
                cdrStateCache.set(instanceId, got);
                iframe.contentWindow?.postMessage({ source: 'pepe-cdr', type: 'restore', state: got }, '*');
                return;
              }
              await new Promise(r => setTimeout(r, 300));
            }
            console.warn('[cdr] 맡겨둔 원문을 받지 못했습니다');
          })();
        }
        // 세션 목록도 이 시점에 다시 넣어준다 — load 때 보낸 것이 빈 문서에 닿았을 수 있다.
        iframe.contentWindow?.postMessage({ source: 'pepe-cdr', type: 'sessions', sessions: sshSessionsRef.current }, '*');
        return;
      }
      if (data.type === 'state') {
        // 도구가 알려준 최신 입력 — 창을 옮기는 순간 serializeTab 이 이 값을 집어간다.
        const st = data.state || {};
        cdrStateCache.set(instanceId, st);
        onStateChangeRef.current?.(st);
        return;
      }
      if (data.type !== 'read-file') return;
      try {
        const r = await api().sftpReadFile?.(data.termId, data.path);
        iframe.contentWindow?.postMessage({ source: 'pepe-cdr', type: 'read-file-result', reqId: data.reqId, success: !!r?.success, text: r?.text, error: r?.error }, '*');
      } catch (e: any) {
        iframe.contentWindow?.postMessage({ source: 'pepe-cdr', type: 'read-file-result', reqId: data.reqId, success: false, error: String(e?.message || e) }, '*');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
      <iframe
        ref={iframeRef}
        title="Call Log / CDR Parser Tool"
        src={`${window.location.origin}/calllog-cdr-tool/index.html`}
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
      />
    </div>
  );
}
