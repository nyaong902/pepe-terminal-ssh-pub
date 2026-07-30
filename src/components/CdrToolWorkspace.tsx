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

const api = () => (window as any).api || {};

export function CdrToolWorkspace({ sshSessions }: { instanceId: string; sshSessions: CdrSshSession[] }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const sshSessionsRef = useRef(sshSessions);
  sshSessionsRef.current = sshSessions;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const postSessions = () => {
      iframe.contentWindow?.postMessage({ source: 'pepe-cdr', type: 'sessions', sessions: sshSessionsRef.current }, '*');
    };
    postSessions();
    iframe.addEventListener('load', postSessions);
    return () => iframe.removeEventListener('load', postSessions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshSessions]);

  useEffect(() => {
    const handler = async (evt: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || evt.source !== iframe.contentWindow) return;
      const data = evt.data;
      if (!data || data.source !== 'pepe-cdr' || data.type !== 'read-file') return;
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
