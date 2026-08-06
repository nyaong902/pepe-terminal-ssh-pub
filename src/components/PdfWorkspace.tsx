// src/components/PdfWorkspace.tsx
// PDF 워크스페이스 — pdf.js(Apache-2.0, https://github.com/mozilla/pdf.js)의 PDFViewer +
// AnnotationEditorLayer 를 직접 사용해 하이라이트/텍스트박스/손글씨(잉크)/스탬프 주석 편집을
// 지원한다. Electron/Chromium 내장 PDF 뷰어는 iframe 안에 넣으면 주석 툴바가 아예 안 뜨는(읽기
// 전용) 것으로 확인되어, 대신 pdf.js 를 직접 렌더링 엔진으로 써서 실제 편집 가능한 뷰어를 만든다.
// 저장은 pdfDocument.saveDocument() 로 주석이 실제 PDF 객체로 구워진 바이트를 받아 그대로 쓴다.
//
// 렌더링은 <webview>(pdf-host.html) 에서 한다. 예전에는 이 파일이 pdfjs 를 직접 import 해서 메인
// 렌더러에서 그렸는데, 그러면 pdfjs 와 문서 데이터가 앱 본체 프로세스에 얹혀 워크스페이스를 닫아도
// 메모리가 OS 로 돌아가지 않았다. 이제 pdfjs 는 pdf-host 청크에만 있고 별도 프로세스에서 돈다.
// 주석 모드 전환과 저장은 preload 브리지를 통한 요청/응답으로 처리한다(src/pdfHost.ts 참고).
import { useEffect, useRef, useState } from 'react';
import { TabListMenu } from './TabListMenu';
import { middleClickClose, useTabStripScroll } from '../utils/tabStrip';
import { OfficeBackBar } from './OfficeBackBar';
import { OfficeEmptyState } from './OfficeEmptyState';
import { getRecents, addRecent, removeRecent, type RecentDoc } from '../utils/officeRecents';

const api = () => (window as any).api || {};

const toolbarBtn: React.CSSProperties = {
  padding: '4px 12px', borderRadius: 6, border: '1px solid var(--win-border, #30363d)',
  background: 'var(--win-surface, #161b22)', color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer',
};
const modeBtn = (active: boolean): React.CSSProperties => ({
  ...toolbarBtn,
  background: active ? 'var(--win-accent, #2b6b9b)' : 'var(--win-surface, #161b22)',
  color: active ? '#fff' : 'var(--win-text, #e6edf3)',
});

type OpenPdf = { id: string; title: string; filePath: string | null; fileUrl: string };
type EditorMode = 'none' | 'highlight' | 'freetext' | 'ink' | 'stamp';

let nextPdfId = 0;

export function PdfWorkspace({ initialFilePath, initialFilePaths, onOpenPathsChange }: {
  instanceId: string; initialFilePath?: string;
  initialFilePaths?: string[]; onOpenPathsChange?: (paths: string[]) => void;
}) {
  const [docs, setDocs] = useState<OpenPdf[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<EditorMode>('none');
  const [recents, setRecents] = useState<RecentDoc[]>([]);
  useEffect(() => { getRecents('pdf').then(setRecents); }, []);

  const docsRef = useRef<OpenPdf[]>(docs);
  docsRef.current = docs;
  // 탭 id -> 원본 바이트(뷰어 리마운트용) / pdf.js PDFDocumentProxy(저장용).
  // 탭 id → webview. pdfjs 문서 객체는 게스트가 갖고 있으므로 호스트는 참조하지 않는다.
  const webviewsRef = useRef<Map<string, any>>(new Map());
  // 저장 요청의 응답(바이트)을 기다리는 resolver.
  const savePendingRef = useRef<Map<string, (v: any) => void>>(new Map());
  const [preloadUrl, setPreloadUrl] = useState('');
  useEffect(() => {
    (window as any).api?.getWebviewPreloadUrl?.().then((u: string) => setPreloadUrl(u || '')).catch(() => {});
  }, []);

  // 주석 모드가 바뀌면 활성 탭의 게스트에 알린다. 예전에는 PDFViewer 세터를 직접 만졌지만
  // 이제 뷰어가 다른 프로세스에 있으므로 요청으로 보낸다.
  useEffect(() => {
    if (!activeId) return;
    const wv = webviewsRef.current.get(activeId);
    try { wv?.send('pdf-to-guest', { method: 'setMode', params: { mode } }); } catch {}
  }, [mode, activeId]);

  const registerWebview = (id: string, el: any) => {
    if (webviewsRef.current.get(id) === el) return;
    webviewsRef.current.set(id, el);
    el.addEventListener('ipc-message', (e: any) => {
      if (e?.channel !== 'pdf-to-host') return;
      const d = e.args?.[0];
      if (!d) return;
      if (d.event === 'saved') {
        const resolve = savePendingRef.current.get(id);
        if (resolve) { savePendingRef.current.delete(id); resolve(d.data); }
      } else if (d.event === 'error') {
        const resolve = savePendingRef.current.get(id);
        if (resolve) { savePendingRef.current.delete(id); resolve(null); }
        setError(d.message || 'PDF 오류');
      }
    });
  };

  const closeDoc = (id: string) => {
    webviewsRef.current.delete(id);
    savePendingRef.current.delete(id);
    setDocs(prev => prev.filter(d => d.id !== id));
    setActiveId(prev => {
      if (prev !== id) return prev;
      const remaining = docsRef.current.filter(d => d.id !== id);
      return remaining.length ? remaining[remaining.length - 1].id : null;
    });
  };

  // 게스트가 URL 로 가져가므로 바이트를 들고 있지 않는다(메인 렌더러에 문서 데이터가 남지 않는다).
  const openLocalFile = (filePath: string, fileName: string) => {
    const id = `pdf-${++nextPdfId}`;
    // 게스트(webview)가 이 URL 로 파일을 가져간다 — dev 는 vite 미들웨어, 패키지된 앱은
    // pepeapp:// 의 __local-file 이 서빙한다.
    const fileUrl = `${window.location.origin}/__local-file?path=${encodeURIComponent(filePath)}`;
    setDocs(prev => [...prev, { id, title: fileName, filePath, fileUrl }]);
    setActiveId(id);
  };

  const handleOpen = async () => {
    const result = await api().officeDocOpenFile?.('pdf');
    if (!result || result.error) {
      if (result?.error) setError(`열기 실패: ${result.error}`);
      return;
    }
    setError('');
    openLocalFile(result.filePath, result.fileName);
    addRecent('pdf', { filePath: result.filePath, fileName: result.fileName }).then(setRecents);
  };

  const handleOpenRecent = async (doc: RecentDoc) => {
    const result = await api().officeDocReadFile?.(doc.filePath);
    if (!result || result.error) {
      setError(`열기 실패: ${result?.error || '파일을 찾을 수 없습니다'}`);
      removeRecent('pdf', doc.filePath).then(setRecents);
      return;
    }
    setError('');
    openLocalFile(doc.filePath, result.fileName);
    addRecent('pdf', { filePath: doc.filePath, fileName: result.fileName }).then(setRecents);
  };


  // 열려 있는 문서의 파일 경로를 상위(OfficeLauncher)에 알린다 — 워크스페이스를 다른 창으로
  // 옮기면 이 컴포넌트는 새 렌더러에서 처음부터 다시 마운트되므로, 경로를 넘겨받지 못하면 빈
  // 편집기가 떠서 "초기화" 로 보인다. 편집 중이던 내용은 옮길 수 없다(편집기는 별도 프로세스의
  // webview 이고 새 창에서 새로 만들어진다) — 같은 파일을 다시 열어주는 것까지가 한계다.
  useEffect(() => {
    if (!onOpenPathsChange) return;
    onOpenPathsChange(docs.map(d => d.filePath || '').filter(Boolean) as string[]);
    /* eslint-disable-next-line */
  }, [docs]);

  // 넘겨받은 경로들을 마운트 때 한 번만 다시 연다.
  //
  // 주의: initialFilePaths 는 상위(OfficeLauncher)가 위 onOpenPathsChange 보고로 갱신하는 값이라,
  // props 변화를 보고 열면 사용자가 방금 연 문서를 "복원 대상" 으로 오인해 같은 문서가 두 번 열린다
  // (실측). 그래서 마운트 시점 값만 쓰고 이후 변화는 무시한다.
  const initialPathsRef = useRef(initialFilePaths);
  const restoredPathsRef = useRef(false);
  useEffect(() => {
    if (restoredPathsRef.current) return;
    restoredPathsRef.current = true;   // 빈 목록이어도 표시해서 다시 들어오지 않게 한다
    // initialFilePath(외부에서 "이 파일 열기" 로 들어온 경우)가 있으면 그쪽이 열어주므로 건너뛴다.
    if (initialFilePath) return;
    const paths = (initialPathsRef.current || []).filter(Boolean);
    if (paths.length === 0) return;
    (async () => {
      for (const fp of paths) {
        await handleOpenRecent({ filePath: fp, fileName: fp.split(/[\/]/).pop() || fp, openedAt: 0, openCount: 0 });
      }
    })();
    /* eslint-disable-next-line */
  }, []);

  const initialFileOpenedRef = useRef(false);
  useEffect(() => {
    if (!initialFilePath || initialFileOpenedRef.current) return;
    initialFileOpenedRef.current = true;
    handleOpenRecent({ filePath: initialFilePath, fileName: initialFilePath.split(/[\\/]/).pop() || initialFilePath, openedAt: 0, openCount: 0 });
  }, [initialFilePath]);

  const handleSave = async () => {
    if (!activeId) return;
    const wv = webviewsRef.current.get(activeId);
    if (!wv) { setError('저장할 문서가 없습니다.'); return; }
    try {
      // 주석이 구워진 바이트는 게스트(pdfjs)가 만든다 — 요청하고 응답을 기다린다.
      const buf: ArrayBuffer | null = await new Promise((resolve) => {
        savePendingRef.current.set(activeId, resolve);
        try { wv.send('pdf-to-guest', { method: 'save' }); } catch { resolve(null); }
        setTimeout(() => {
          if (savePendingRef.current.has(activeId)) { savePendingRef.current.delete(activeId); resolve(null); }
        }, 60000);
      });
      if (!buf) { setError('저장 실패: 응답 없음'); return; }
      const doc = docsRef.current.find(d => d.id === activeId);
      const result = await api().officeDocSaveFile?.({
        data: buf,   // 게스트가 이미 오프셋 없는 ArrayBuffer 로 잘라 보냈다
        defaultName: doc?.title || 'document.pdf',
        filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
      });
      if (result?.success) {
        setError('');
        const fileName = result.filePath.split(/[\\/]/).pop() || doc?.title;
        setDocs(prev => prev.map(d => (d.id === activeId ? { ...d, title: fileName, filePath: result.filePath } : d)));
        addRecent('pdf', { filePath: result.filePath, fileName }).then(setRecents);
      } else if (!result?.canceled) {
        setError(`저장 실패: ${result?.error || '알 수 없는 오류'}`);
      }
    } catch (e: any) {
      setError(`저장 실패: ${e?.message || e}`);
    }
  };

  // 탭 바 — 넘칠 때 ‹ › , 세로 휠로 가로 스크롤(공용 처리).
  const { tabScrollRef, tabsOverflow, scrollTabs, onTabWheel } = useTabStripScroll(docs);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0', width: '100%', height: '100%', minWidth: 0, minHeight: 0, background: 'var(--win-bg, #0d1117)' }}>
      <OfficeBackBar
        label="PDF"
        right={(
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button style={toolbarBtn} onClick={handleOpen}>📂 열기</button>
            <button style={toolbarBtn} onClick={handleSave} disabled={!activeId}>💾 저장</button>
            <div style={{ width: 1, height: 18, background: 'var(--win-border, #30363d)', margin: '0 4px' }} />
            <button style={modeBtn(mode === 'highlight')} onClick={() => setMode(m => m === 'highlight' ? 'none' : 'highlight')}>🖍️ 하이라이트</button>
            <button style={modeBtn(mode === 'freetext')} onClick={() => setMode(m => m === 'freetext' ? 'none' : 'freetext')}>🔤 텍스트</button>
            <button style={modeBtn(mode === 'ink')} onClick={() => setMode(m => m === 'ink' ? 'none' : 'ink')}>✏️ 손글씨</button>
            <button style={modeBtn(mode === 'stamp')} onClick={() => setMode(m => m === 'stamp' ? 'none' : 'stamp')}>🖼️ 스탬프</button>
            {error && <span style={{ fontSize: 11, color: '#e5534b' }}>{error}</span>}
          </div>
        )}
      />
      {docs.length > 0 && (
        <div className="pepe-tabs pepe-tabs-docs">
          <div className="pepe-tabs-scroll" ref={tabScrollRef} onWheel={onTabWheel}>
            {docs.map(d => (
              <div
                key={d.id}
                onClick={() => setActiveId(d.id)}
                {...middleClickClose(() => closeDoc(d.id))}
                title={d.filePath || d.title}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: '6px 6px 0 0',
                  background: d.id === activeId ? 'var(--win-surface, #161b22)' : 'transparent',
                  border: '1px solid var(--win-border, #30363d)',
                  color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer', maxWidth: 180, whiteSpace: 'nowrap', flex: '0 0 auto',
                }}
              >
                <span>🗎</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</span>
                <span
                  onClick={(e) => { e.stopPropagation(); closeDoc(d.id); }}
                  style={{ opacity: 0.7, padding: '0 2px', borderRadius: 4 }}
                >×</span>
              </div>
            ))}
          </div>
          {tabsOverflow && (
            <div className="pepe-tab-scroll-group">
              <button className="pepe-tab-scroll-btn" onClick={() => scrollTabs(-150)} title="이전">‹</button>
              <button className="pepe-tab-scroll-btn" onClick={() => scrollTabs(150)} title="다음">›</button>
            </div>
          )}
          {/* 모든 탭 보기 — 탭이 많을 때 ‹ › 로 넘기지 않고 목록에서 바로 고른다. */}
          <TabListMenu
            items={docs.map(d => ({ id: d.id, label: d.title, icon: '📕' }))}
            activeId={activeId}
            onSelect={id => setActiveId(id)}
            onCloseItem={id => closeDoc(id)}
          />
        </div>
      )}
      <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, position: 'relative' }}>
        {docs.length === 0 && (
          <OfficeEmptyState
            recents={recents}
            onOpenRecent={handleOpenRecent}
            onRemoveRecent={(fp) => removeRecent('pdf', fp).then(setRecents)}
            message='"열기"를 눌러 PDF 파일을 선택하세요. 하이라이트/텍스트/손글씨/스탬프 주석을 추가하고 저장할 수 있습니다.'
          />
        )}
        {/* preload 경로를 받기 전에는 만들지 않는다 — webview 는 생성 시점의 preload 만 적용한다. */}
        {preloadUrl && docs.map(d => (
          /* @ts-ignore — webview 는 React 표준 element 가 아니지만 Electron 환경에서 동작 */
          <webview
            key={d.id}
            ref={(el: any) => { if (el) registerWebview(d.id, el); }}
            src={`${window.location.origin}/pdf-host.html?file=${encodeURIComponent(d.fileUrl)}`}
            preload={preloadUrl}
            /* display 는 반드시 flex — block 이면 내부 게스트가 크롭돼 렌더된다(Electron 문서). */
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              minWidth: 0, minHeight: 0, border: 'none', background: '#1e1e1e',
              display: d.id === activeId ? 'flex' : 'none',
            }}
          />
        ))}
      </div>
    </div>
  );
}
