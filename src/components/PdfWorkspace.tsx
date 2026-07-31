// src/components/PdfWorkspace.tsx
// PDF 워크스페이스 — pdf.js(Apache-2.0, https://github.com/mozilla/pdf.js)의 PDFViewer +
// AnnotationEditorLayer 를 직접 사용해 하이라이트/텍스트박스/손글씨(잉크)/스탬프 주석 편집을
// 지원한다. Electron/Chromium 내장 PDF 뷰어는 iframe 안에 넣으면 주석 툴바가 아예 안 뜨는(읽기
// 전용) 것으로 확인되어, 대신 pdf.js 를 직접 렌더링 엔진으로 써서 실제 편집 가능한 뷰어를 만든다.
// 저장은 pdfDocument.saveDocument() 로 주석이 실제 PDF 객체로 구워진 바이트를 받아 그대로 쓴다.
import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFViewer, EventBus, PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { OfficeBackBar } from './OfficeBackBar';
import { OfficeEmptyState } from './OfficeEmptyState';
import { getRecents, addRecent, removeRecent, type RecentDoc } from '../utils/officeRecents';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

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

type OpenPdf = { id: string; title: string; filePath: string | null };
type EditorMode = 'none' | 'highlight' | 'freetext' | 'ink' | 'stamp';
const MODE_TO_TYPE: Record<Exclude<EditorMode, 'none'>, number> = {
  highlight: pdfjsLib.AnnotationEditorType.HIGHLIGHT,
  freetext: pdfjsLib.AnnotationEditorType.FREETEXT,
  ink: pdfjsLib.AnnotationEditorType.INK,
  stamp: pdfjsLib.AnnotationEditorType.STAMP,
};

let nextPdfId = 0;

export function PdfWorkspace({ initialFilePath }: { instanceId: string; initialFilePath?: string }) {
  const [docs, setDocs] = useState<OpenPdf[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<EditorMode>('none');
  const [recents, setRecents] = useState<RecentDoc[]>([]);
  useEffect(() => { getRecents('pdf').then(setRecents); }, []);

  const docsRef = useRef<OpenPdf[]>(docs);
  docsRef.current = docs;
  // 탭 id -> 원본 바이트(뷰어 리마운트용) / pdf.js PDFDocumentProxy(저장용).
  const dataRef = useRef<Map<string, ArrayBuffer>>(new Map());
  const pdfDocRef = useRef<Map<string, any>>(new Map());

  const closeDoc = (id: string) => {
    dataRef.current.delete(id);
    pdfDocRef.current.delete(id);
    setDocs(prev => prev.filter(d => d.id !== id));
    setActiveId(prev => {
      if (prev !== id) return prev;
      const remaining = docsRef.current.filter(d => d.id !== id);
      return remaining.length ? remaining[remaining.length - 1].id : null;
    });
  };

  const openBytes = (data: ArrayBuffer, fileName: string, filePath: string | null) => {
    const id = `pdf-${++nextPdfId}`;
    dataRef.current.set(id, data);
    setDocs(prev => [...prev, { id, title: fileName, filePath }]);
    setActiveId(id);
  };

  const handleOpen = async () => {
    const result = await api().officeDocOpenFile?.('pdf');
    if (!result || result.error) {
      if (result?.error) setError(`열기 실패: ${result.error}`);
      return;
    }
    setError('');
    openBytes(result.data, result.fileName, result.filePath);
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
    openBytes(result.data, result.fileName, doc.filePath);
    addRecent('pdf', { filePath: doc.filePath, fileName: result.fileName }).then(setRecents);
  };

  const initialFileOpenedRef = useRef(false);
  useEffect(() => {
    if (!initialFilePath || initialFileOpenedRef.current) return;
    initialFileOpenedRef.current = true;
    handleOpenRecent({ filePath: initialFilePath, fileName: initialFilePath.split(/[\\/]/).pop() || initialFilePath, openedAt: 0, openCount: 0 });
  }, [initialFilePath]);

  const handleSave = async () => {
    if (!activeId) return;
    const pdfDocument = pdfDocRef.current.get(activeId);
    if (!pdfDocument) { setError('저장할 문서가 없습니다.'); return; }
    try {
      const bytes: Uint8Array = await pdfDocument.saveDocument();
      const doc = docsRef.current.find(d => d.id === activeId);
      const result = await api().officeDocSaveFile?.({
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
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
              <span>🗎</span>
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
            onRemoveRecent={(fp) => removeRecent('pdf', fp).then(setRecents)}
            message='"열기"를 눌러 PDF 파일을 선택하세요. 하이라이트/텍스트/손글씨/스탬프 주석을 추가하고 저장할 수 있습니다.'
          />
        )}
        {docs.map(d => (
          <div key={d.id} style={{ position: 'absolute', inset: 0, display: d.id === activeId ? 'block' : 'none' }}>
            <PdfEditorPaneBound
              id={d.id}
              data={dataRef.current.get(d.id)!}
              mode={d.id === activeId ? mode : 'none'}
              onDocReady={(doc) => pdfDocRef.current.set(d.id, doc)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// PdfEditorPane 은 자기 자신의 PDFDocumentProxy 를 부모(PdfWorkspace)에게 넘겨줘야 저장이 가능하다 —
// 훅 규칙 위반 없이 onDocReady 콜백을 받는 얇은 래퍼.
function PdfEditorPaneBound({ id: _id, data, mode, onDocReady }: { id: string; data: ArrayBuffer; mode: EditorMode; onDocReady: (doc: any) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<InstanceType<typeof PDFViewer> | null>(null);
  const [status, setStatus] = useState('불러오는 중...');

  useEffect(() => {
    let disposed = false;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    (async () => {
      const container = containerRef.current;
      if (!container) return;
      const viewer = new PDFViewer({ container, eventBus, linkService, annotationEditorMode: pdfjsLib.AnnotationEditorType.NONE });
      linkService.setViewer(viewer);
      viewerRef.current = viewer;
      // cMap/표준폰트 데이터 없이는, 시스템 폰트를 CID(Adobe-Korea1 등) 로 참조하는 비임베드
      // 한글 폰트를 못 풀어서 페이지 배경/표/테두리는 멀쩡히 그려지는데 글자만 전부 안 보이는
      // 증상이 생긴다(HWP/한글 변환 PDF 에서 흔함) — public/ 에 복사해둔 pdfjs-dist 리소스를 가리킨다.
      const loadingTask = pdfjsLib.getDocument({
        data: data.slice(0),
        cMapUrl: `${import.meta.env.BASE_URL}pdfjs-cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs-standard-fonts/`,
      });
      const pdfDocument = await loadingTask.promise;
      if (disposed) return;
      onDocReady(pdfDocument);
      viewer.setDocument(pdfDocument);
      linkService.setDocument(pdfDocument);
      setStatus(`${pdfDocument.numPages}페이지`);
    })().catch((e) => setStatus(`로드 실패: ${e?.message || e}`));
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const targetMode = mode === 'none' ? pdfjsLib.AnnotationEditorType.NONE : MODE_TO_TYPE[mode];
    // pdfjs-dist 6.x 는 이벤트버스 dispatch 가 아니라 PDFViewer.annotationEditorMode 세터로
    // 모드를 바꾼다 — AnnotationEditorUIManager 가 첫 페이지 렌더 이후 비동기로 생성되므로
    // 아직 준비 안 됐으면 조용히 무시하고 넘어간다(다음 모드 변경 시 다시 시도됨).
    try {
      viewer.annotationEditorMode = { mode: targetMode };
    } catch { /* UI manager 아직 미준비 — 무시 */ }
  }, [mode]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} className="pdf-viewer-container" style={{ position: 'absolute', inset: 0, overflow: 'auto', background: '#525659' }}>
        <div className="pdfViewer" />
      </div>
      <div style={{ position: 'absolute', bottom: 6, right: 10, fontSize: 11, color: '#ccc', pointerEvents: 'none' }}>{status}</div>
    </div>
  );
}
