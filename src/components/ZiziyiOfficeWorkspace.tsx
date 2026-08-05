// src/components/ZiziyiOfficeWorkspace.tsx
// 워드/엑셀/파워포인트 워크스페이스 — ZIZIYI Office(https://github.com/baotlake/office-website,
// ONLYOFFICE sdkjs/web-apps + x2t-wasm 기반)를 public/office-editor 에 자체 호스팅해 iframe 으로
// 임베드한다. 앱과 같은 origin 이므로 내부 저장/다운로드가 will-download 훅으로 자연스럽게 처리된다.
// 파일 열기는 네이티브 다이얼로그로 읽은 바이트를 blob: URL 로 만들어 office-editor 의
// /editor?url=... 쿼리 인터페이스로 넘긴다 (office-editor 자체 파일피커 대신 우리가 직접 제어).
// 여러 문서를 동시에 열어둘 수 있도록 미니탭으로 관리 — 탭을 전환해도 iframe 은 언마운트하지 않고
// display 만 숨겨서 편집 중인 상태(저장 안 한 변경 등)가 유지되게 한다.
import { useEffect, useRef, useState } from 'react';
import { OfficeBackBar } from './OfficeBackBar';
import { OfficeEmptyState } from './OfficeEmptyState';
import { getRecents, addRecent, removeRecent, type RecentDoc } from '../utils/officeRecents';

const api = () => (window as any).api || {};

type DocKind = 'docx' | 'xlsx' | 'pptx';

const KIND_LABEL: Record<DocKind, string> = { docx: '워드 (Word)', xlsx: '엑셀 (Excel)', pptx: '파워포인트 (PowerPoint)' };
const KIND_ICON: Record<DocKind, string> = { docx: '📝', xlsx: '📊', pptx: '📽️' };
// KIND_MIME 은 blob 을 만들 때만 필요했고, URL 방식으로 바꾸면서 쓰이지 않는다.

const toolbarBtn: React.CSSProperties = {
  padding: '4px 12px', borderRadius: 6, border: '1px solid var(--win-border, #30363d)',
  background: 'var(--win-surface, #161b22)', color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer',
};

type OpenDoc = { id: string; title: string; src: string; blobUrl: string | null; filePath?: string | null };

let nextDocId = 0;

export function ZiziyiOfficeWorkspace({ kind, initialFilePath, initialFilePaths, onOpenPathsChange }: {
  instanceId: string; kind: DocKind; initialFilePath?: string;
  initialFilePaths?: string[]; onOpenPathsChange?: (paths: string[]) => void;
}) {
  const [docs, setDocs] = useState<OpenDoc[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState('');
  // 열기 전 사전 검사(큰 임베디드 OLE 개체 등)에서 나온 비차단 경고 — ONLYOFFICE 변환 엔진이
  // 이런 파일에서 종종 실패하지만, 실제로 실패할지는 열어봐야 알 수 있어 열기 자체는 막지 않는다.
  const [warning, setWarning] = useState('');
  const [recents, setRecents] = useState<RecentDoc[]>([]);
  useEffect(() => { getRecents(kind).then(setRecents); }, [kind]);
  const docsRef = useRef<OpenDoc[]>(docs);
  docsRef.current = docs;

  const addDoc = (title: string, src: string, blobUrl: string | null, filePath?: string | null) => {
    const id = `doc-${++nextDocId}`;
    setDocs(prev => [...prev, { id, title, src, blobUrl, filePath: filePath || null }]);
    setActiveId(id);
  };

  const closeDoc = (id: string) => {
    const doc = docsRef.current.find(d => d.id === id);
    if (doc?.blobUrl) URL.revokeObjectURL(doc.blobUrl);
    setDocs(prev => prev.filter(d => d.id !== id));
    setActiveId(prev => {
      if (prev !== id) return prev;
      const remaining = docsRef.current.filter(d => d.id !== id);
      return remaining.length ? remaining[remaining.length - 1].id : null;
    });
  };

  const handleNew = async () => {
    setError('');
    const count = docsRef.current.filter(d => d.title.startsWith('새 문서')).length + 1;
    const title = `새 문서 ${count}`;
    if (kind === 'pptx') {
      // office-editor 자체 ?new=pptx 숏컷이 빈 화면만 나오는 버그가 있어, 미리 준비해둔 blank.pptx 를
      // 실제 파일 열기와 동일한(검증된) 변환 경로로 대신 연다.
      // 템플릿도 URL 을 그대로 넘긴다 — 바이트를 읽어 blob 을 만들 필요가 없어졌다.
      openUrl(`${window.location.origin}/office-templates/blank.pptx`, `${title}.pptx`);
      return;
    }
    addDoc(title, `${window.location.origin}/office-editor/editor.html?new=${kind}`, null);
  };

  // 편집기에 넘길 "파일을 가져갈 수 있는 URL" 로 문서를 연다.
  // 예전에는 파일 바이트로 blob: URL 을 만들어 넘겼는데, blob: 은 만든 컨텍스트에서만 유효해서
  // <webview>(별도 프로세스)인 게스트가 열 수 없다. 그래서 파일을 서빙하는 URL 을 준다 —
  // dev 는 vite 미들웨어(vite.config.ts 의 serveLocalFile), 패키지된 앱은 pepeapp:// 핸들러의
  // __local-file 이 같은 일을 한다. 임시 파일을 만들 필요도 없다.
  const openUrl = (fileUrl: string, fileName: string, filePath?: string) => {
    const src = `${window.location.origin}/office-editor/editor.html?url=${encodeURIComponent(fileUrl)}&fileType=${kind}&fileName=${encodeURIComponent(fileName)}`;
    addDoc(fileName, src, null, filePath);   // blob 을 쓰지 않으므로 해제할 것이 없다
  };

  const openLocalFile = (filePath: string, fileName: string) =>
    openUrl(`${window.location.origin}/__local-file?path=${encodeURIComponent(filePath)}`, fileName, filePath);

  const handleOpen = async () => {
    const result = await api().officeDocOpenFile?.(kind);
    if (!result || result.error) {
      if (result?.error) setError(`열기 실패: ${result.error}`);
      return;
    }
    setError('');
    setWarning(result.warning || '');
    openLocalFile(result.filePath, result.fileName);
    addRecent(kind, { filePath: result.filePath, fileName: result.fileName }).then(setRecents);
  };

  const handleOpenRecent = async (doc: RecentDoc) => {
    const result = await api().officeDocReadFile?.(doc.filePath);
    if (!result || result.error) {
      setError(`열기 실패: ${result?.error || '파일을 찾을 수 없습니다'}`);
      removeRecent(kind, doc.filePath).then(setRecents);
      return;
    }
    setError('');
    setWarning(result.warning || '');
    openLocalFile(doc.filePath, result.fileName);
    addRecent(kind, { filePath: doc.filePath, fileName: result.fileName }).then(setRecents);
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

  // 넘겨받은 경로들을 한 번만 다시 연다.
  const restoredPathsRef = useRef(false);
  useEffect(() => {
    if (restoredPathsRef.current) return;
    const paths = (initialFilePaths || []).filter(Boolean);
    if (paths.length === 0) return;
    restoredPathsRef.current = true;
    (async () => {
      for (const fp of paths) {
        await handleOpenRecent({ filePath: fp, fileName: fp.split(/[\\/]/).pop() || fp, openedAt: 0, openCount: 0 });
      }
    })();
    /* eslint-disable-next-line */
  }, [initialFilePaths]);

  const initialFileOpenedRef = useRef(false);
  useEffect(() => {
    if (!initialFilePath || initialFileOpenedRef.current) return;
    initialFileOpenedRef.current = true;
    handleOpenRecent({ filePath: initialFilePath, fileName: initialFilePath.split(/[\\/]/).pop() || initialFilePath, openedAt: 0, openCount: 0 });
  }, [initialFilePath]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0', width: '100%', height: '100%', minWidth: 0, minHeight: 0, background: 'var(--win-bg, #0d1117)' }}>
      <OfficeBackBar
        label={KIND_LABEL[kind]}
        right={(
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button style={toolbarBtn} onClick={handleNew}>📄 새 문서</button>
            <button style={toolbarBtn} onClick={handleOpen}>📂 열기</button>
            {error && <span style={{ fontSize: 11, color: '#e5534b' }}>{error}</span>}
          </div>
        )}
      />
      {warning && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', flex: '0 0 auto',
          background: 'rgba(210,153,34,0.15)', borderBottom: '1px solid rgba(210,153,34,0.4)',
          fontSize: 12, color: 'var(--win-text, #e6edf3)',
        }}>
          <span>⚠️</span>
          <span style={{ flex: '1 1 0' }}>{warning}</span>
          <span onClick={() => setWarning('')} style={{ cursor: 'pointer', opacity: 0.7, padding: '0 4px' }}>×</span>
        </div>
      )}
      {docs.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px 0', borderBottom: '1px solid var(--win-border, #30363d)', overflowX: 'auto', flex: '0 0 auto' }}>
          {docs.map(d => (
            <div
              key={d.id}
              onClick={() => setActiveId(d.id)}
              title={d.title}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: '6px 6px 0 0',
                background: d.id === activeId ? 'var(--win-surface, #161b22)' : 'transparent',
                border: '1px solid var(--win-border, #30363d)', borderBottom: d.id === activeId ? '1px solid var(--win-surface, #161b22)' : '1px solid var(--win-border, #30363d)',
                color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer', maxWidth: 180, whiteSpace: 'nowrap',
              }}
            >
              <span>{KIND_ICON[kind]}</span>
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
            onRemoveRecent={(fp) => removeRecent(kind, fp).then(setRecents)}
            message={`"새 문서" 또는 "열기"를 눌러 ${KIND_LABEL[kind]} 문서를 시작하세요.`}
          />
        )}
        {docs.map(d => (
          /* @ts-ignore — webview 는 React 표준 element 가 아니지만 Electron 환경에서 동작 */
          <webview
            key={d.id}
            data-doc-id={d.id}
            src={d.src}
            /* display 는 반드시 flex 여야 한다 — block/inline-block 이면 내부 게스트가 세로로
               늘어나지 않고 크롭돼 렌더된다(Electron 문서에 명시된 동작). 브라우저 워크스페이스도
               같은 이유로 flex 를 쓴다. 숨길 때는 none. */
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
