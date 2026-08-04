// src/components/FlowChartWorkspace.tsx
// 플로우차트 워크스페이스 — draw.io(https://github.com/jgraph/drawio)를 public/flowchart-editor 에
// 자체 호스팅해 "임베드 모드"(?embed=1&proto=json) iframe 으로 넣는다. draw.io 임베드 모드는
// postMessage 로 통신한다: iframe 이 준비되면 {event:'init'} 을 보내고, 우리가 {action:'load',
// xml, autosave:1} 로 응답하면 그 이후 편집할 때마다 {event:'autosave', xml} 을 계속 보내준다 —
// 그 최신 xml 을 들고 있다가 "저장" 누르면 파일로 쓴다. (문서: https://www.drawio.com/doc/faq/embed-mode)
import { useEffect, useRef, useState } from 'react';
import { OfficeBackBar } from './OfficeBackBar';
import { OfficeEmptyState } from './OfficeEmptyState';
import { getRecents, addRecent, removeRecent, type RecentDoc } from '../utils/officeRecents';

const api = () => (window as any).api || {};

const toolbarBtn: React.CSSProperties = {
  padding: '4px 12px', borderRadius: 6, border: '1px solid var(--win-border, #30363d)',
  background: 'var(--win-surface, #161b22)', color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer',
};

type OpenChart = { id: string; title: string; filePath: string | null; initialXml: string };

let nextChartId = 0;

export function FlowChartWorkspace(_props: { instanceId: string }) {
  const [docs, setDocs] = useState<OpenChart[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [recents, setRecents] = useState<RecentDoc[]>([]);
  useEffect(() => { getRecents('drawio').then(setRecents); }, []);

  const docsRef = useRef<OpenChart[]>(docs);
  docsRef.current = docs;
  // 탭 id → webview 엘리먼트 / 최신 xml 캐시.
  //
  // <iframe> 에서 <webview> 로 바꿨다: iframe 은 같은 origin 이면 같은 렌더러 프로세스라 draw.io 가
  // 쓰는 메모리가 앱 본체에 얹히고, 워크스페이스를 닫아도 OS 로 돌아가지 않았다. webview 는 별도
  // 프로세스라 닫으면 프로세스째 회수된다.
  //
  // 그래서 통신 경로도 바뀐다. 예전에는 window 의 message 이벤트를 하나 듣고 evt.source 와
  // contentWindow 를 비교해 어느 탭인지 찾았는데, webview 에는 contentWindow 가 없다. 대신 각
  // webview 가 자기 ipc-message 를 내므로 탭마다 리스너를 달면 발신자를 찾을 필요가 없다.
  // 게스트 쪽 postMessage ↔ ipc 변환은 preload(electron/preload.ts)의 draw.io 브리지가 한다.
  const webviewsRef = useRef<Map<string, any>>(new Map());
  const latestXmlRef = useRef<Map<string, string>>(new Map());
  const [preloadUrl, setPreloadUrl] = useState('');
  useEffect(() => {
    (window as any).api?.getWebviewPreloadUrl?.().then((u: string) => setPreloadUrl(u || '')).catch(() => {});
  }, []);

  const registerWebview = (id: string, el: any) => {
    if (webviewsRef.current.get(id) === el) return;
    webviewsRef.current.set(id, el);
    el.addEventListener('ipc-message', (e: any) => {
      if (e?.channel !== 'drawio-to-host') return;
      let data: any;
      try { data = JSON.parse(e.args?.[0]); } catch { return; }
      if (data.event === 'init') {
        const doc = docsRef.current.find(d => d.id === id);
        try {
          el.send('drawio-to-guest', JSON.stringify({ action: 'load', xml: doc?.initialXml || '', autosave: 1 }));
        } catch {}
      } else if (data.event === 'autosave' || data.event === 'save' || data.event === 'load') {
        if (typeof data.xml === 'string') latestXmlRef.current.set(id, data.xml);
      }
    });
  };

  const addDoc = (title: string, filePath: string | null, initialXml: string) => {
    const id = `chart-${++nextChartId}`;
    setDocs(prev => [...prev, { id, title, filePath, initialXml }]);
    setActiveId(id);
  };

  const closeDoc = (id: string) => {
    webviewsRef.current.delete(id);
    latestXmlRef.current.delete(id);
    setDocs(prev => prev.filter(d => d.id !== id));
    setActiveId(prev => {
      if (prev !== id) return prev;
      const remaining = docsRef.current.filter(d => d.id !== id);
      return remaining.length ? remaining[remaining.length - 1].id : null;
    });
  };

  const handleNew = () => {
    setError('');
    const count = docsRef.current.filter(d => d.title.startsWith('새 문서')).length + 1;
    addDoc(`새 문서 ${count}`, null, '');
  };

  const handleOpen = async () => {
    const result = await api().officeDocOpenFile?.('drawio');
    if (!result || result.error) {
      if (result?.error) setError(`열기 실패: ${result.error}`);
      return;
    }
    setError('');
    const xml = new TextDecoder('utf-8').decode(result.data);
    addDoc(result.fileName, result.filePath, xml);
    addRecent('drawio', { filePath: result.filePath, fileName: result.fileName }).then(setRecents);
  };

  const handleOpenRecent = async (doc: RecentDoc) => {
    const result = await api().officeDocReadFile?.(doc.filePath);
    if (!result || result.error) {
      setError(`열기 실패: ${result?.error || '파일을 찾을 수 없습니다'}`);
      removeRecent('drawio', doc.filePath).then(setRecents);
      return;
    }
    setError('');
    const xml = new TextDecoder('utf-8').decode(result.data);
    addDoc(result.fileName, doc.filePath, xml);
    addRecent('drawio', { filePath: doc.filePath, fileName: result.fileName }).then(setRecents);
  };

  const handleSave = async () => {
    if (!activeId) return;
    const xml = latestXmlRef.current.get(activeId);
    if (xml == null) { setError('저장할 내용이 없습니다.'); return; }
    const doc = docsRef.current.find(d => d.id === activeId);
    const defaultName = doc?.filePath ? doc.title : `${doc?.title || '새 문서'}.drawio`;
    const result = await api().saveTextFile?.({
      defaultName,
      content: xml,
      filters: [{ name: 'draw.io Diagram', extensions: ['drawio', 'xml'] }],
    });
    if (result?.success) {
      setError('');
      const fileName = result.filePath.split(/[\\/]/).pop() || defaultName;
      setDocs(prev => prev.map(d => (d.id === activeId ? { ...d, title: fileName, filePath: result.filePath } : d)));
      addRecent('drawio', { filePath: result.filePath, fileName }).then(setRecents);
    } else if (!result?.canceled) {
      setError(`저장 실패: ${result?.error || '알 수 없는 오류'}`);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0', width: '100%', height: '100%', minWidth: 0, minHeight: 0, background: 'var(--win-bg, #0d1117)' }}>
      <OfficeBackBar
        label="플로우차트 (draw.io)"
        right={(
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button style={toolbarBtn} onClick={handleNew}>📄 새 문서</button>
            <button style={toolbarBtn} onClick={handleOpen}>📂 열기</button>
            <button style={toolbarBtn} onClick={handleSave} disabled={!activeId}>💾 저장</button>
            {error && <span style={{ fontSize: 11, color: '#e5534b' }}>{error}</span>}
          </div>
        )}
      />
      {docs.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px 0', borderBottom: '1px solid var(--win-border, #30363d)', overflowX: 'auto', flex: '0 0 auto' }}>
          {docs.map(d => (
            <div
              key={d.id}
              onClick={() => setActiveId(d.id)}
              title={d.filePath || d.title}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: '6px 6px 0 0',
                background: d.id === activeId ? 'var(--win-surface, #161b22)' : 'transparent',
                border: '1px solid var(--win-border, #30363d)',
                color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer', maxWidth: 180, whiteSpace: 'nowrap',
              }}
            >
              <span>🧩</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</span>
              <span
                onClick={(e) => { e.stopPropagation(); closeDoc(d.id); }}
                style={{ opacity: 0.7, padding: '0 2px', borderRadius: 4 }}
              >×</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, position: 'relative' }}>
        {docs.length === 0 && (
          <OfficeEmptyState
            recents={recents}
            onOpenRecent={handleOpenRecent}
            onRemoveRecent={(fp) => removeRecent('drawio', fp).then(setRecents)}
            message='"새 문서" 또는 "열기"를 눌러 플로우차트를 시작하세요.'
          />
        )}
        {/* preload 경로를 받기 전에는 만들지 않는다 — webview 는 생성 시점의 preload 만 적용하므로
            나중에 속성을 채워도 브리지가 붙지 않는다(문서가 열리지 않던 원인). */}
        {preloadUrl && docs.map(d => (
          /* @ts-ignore — webview 는 React 표준 element 가 아니지만 Electron 환경에서 동작 */
          <webview
            key={d.id}
            ref={(el: any) => { if (el) registerWebview(d.id, el); }}
            /* draw.io 를 webview 에 직접 띄우면 아무것도 열리지 않는다 — 번들이 임베드 메시지를
               window.parent != window 로 감싸는데 webview 게스트에서는 그게 거짓이다. 그래서 중계
               페이지를 띄우고 그 안에서 iframe 으로 연다(public/flowchart-host.html 주석 참고). */
            src={`${window.location.origin}/flowchart-host.html?embed=1&proto=json&spin=1&noSaveBtn=1&saveAndExit=0&modified=unsavedChanges`}
            preload={preloadUrl}
            /* display 는 반드시 flex — block 이면 내부 게스트가 크롭돼 렌더된다(Electron 문서). */
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              minWidth: 0, minHeight: 0, border: 'none', background: '#ffffff',
              display: d.id === activeId ? 'flex' : 'none',
            }}
          />
        ))}
      </div>
    </div>
  );
}
