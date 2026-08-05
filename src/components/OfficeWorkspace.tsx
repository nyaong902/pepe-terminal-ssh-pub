// src/components/OfficeWorkspace.tsx
// 한글(HWP/HWPX) 워크스페이스 — @rhwp/editor(https://github.com/edwardkim/rhwp)를 iframe 으로
// 임베드한다. rhwp-studio 는 public/rhwp-studio 에 자체 호스팅되어 앱과 같은 origin
// (pepeapp://app, electron/main.ts 의 커스텀 프로토콜) 에서 서빙되므로 열기/저장은 내부 파일
// 메뉴(showOpenFilePicker/showSaveFilePicker)로도 처리되지만, 워드/엑셀/파워포인트와 동일하게
// 상단 "새 문서"/"열기" 버튼 + 미니탭으로 여러 문서를 동시에 열어둘 수 있게 한다.
import { useEffect, useRef, useState } from 'react';
import { RhwpWebviewEditor } from '../utils/rhwpWebviewEditor';
import { OfficeBackBar } from './OfficeBackBar';
import { OfficeEmptyState } from './OfficeEmptyState';
import { getRecents, addRecent, removeRecent, type RecentDoc } from '../utils/officeRecents';

const api = () => (window as any).api || {};

const toolbarBtn: React.CSSProperties = {
  padding: '4px 12px', borderRadius: 6, border: '1px solid var(--win-border, #30363d)',
  background: 'var(--win-surface, #161b22)', color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer',
};

type FileData = { data: ArrayBuffer; fileName: string };
type OpenHwp = { id: string; title: string; fileData?: FileData; filePath?: string | null };

let nextHwpId = 0;

export function OfficeWorkspace({ instanceId: _instanceId, initialFilePath, initialFilePaths, onOpenPathsChange }: {
  instanceId: string; initialFilePath?: string;
  initialFilePaths?: string[]; onOpenPathsChange?: (paths: string[]) => void;
}) {
  const [docs, setDocs] = useState<OpenHwp[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statusById, setStatusById] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [recents, setRecents] = useState<RecentDoc[]>([]);
  useEffect(() => { getRecents('hwp').then(setRecents); }, []);
  const docsRef = useRef<OpenHwp[]>(docs);
  docsRef.current = docs;
  const editorsRef = useRef<Map<string, RhwpWebviewEditor>>(new Map());
  const mountedRef = useRef<Set<string>>(new Set());

  const setStatus = (id: string, s: string) => setStatusById(prev => ({ ...prev, [id]: s }));

  const mountEditor = (id: string, container: HTMLDivElement, fileData?: FileData) => {
    if (mountedRef.current.has(id)) return;
    mountedRef.current.add(id);
    setStatus(id, '에디터 로딩 중...');
    (async () => {
      // <webview> 로 띄운다 — iframe 이면 같은 렌더러 프로세스라 편집기 WASM 이 앱 본체에 얹히고,
      // 닫아도 메모리가 OS 로 돌아가지 않는다(자세한 배경은 utils/rhwpWebviewEditor.ts 주석).
      const preloadUrl = (await (window as any).api?.getWebviewPreloadUrl?.()) || '';
      const editor = await RhwpWebviewEditor.create(
        container,
        `${window.location.origin}/rhwp-studio/index.html`,
        preloadUrl,
      );
      editorsRef.current.set(id, editor);
      if (fileData) {
        const result = await editor.loadFile(fileData.data, fileData.fileName);
        setStatus(id, `${fileData.fileName} — ${result?.pageCount ?? '?'}페이지 로드 완료`);
      } else {
        // createEditor() 직후를 그냥 "빈 문서" 라고 가정하면 환경에 따라 캔버스가 비어 보이는
        // 문제가 있었다 — "파일 > 새로 만들기" 메뉴 항목은 이 시점에 DOM 상 disabled 상태라
        // 클릭해도 무시된다. 그래서 실제 단축키(Alt+N)를 흘려보내 내부 커맨드를 직접 트리거한다.
        // iframe 시절에는 contentDocument 에 KeyboardEvent 를 dispatch 했는데, webview 는 게스트
        // 문서에 손댈 수 없으므로 sendInputEvent 로 진짜 키 입력을 보낸다(rhwpWebviewEditor 참고).
        editor.newDocument();
        setStatus(id, '새 문서');
      }
    })().catch((e) => setStatus(id, `초기화 실패: ${e?.message || e}`));
  };

  const addDoc = (title: string, fileData?: FileData, filePath?: string | null) => {
    const id = `hwp-${++nextHwpId}`;
    setDocs(prev => [...prev, { id, title, fileData, filePath: filePath || null }]);
    setActiveId(id);
  };

  const closeDoc = (id: string) => {
    editorsRef.current.get(id)?.destroy();
    editorsRef.current.delete(id);
    mountedRef.current.delete(id);
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
    addDoc(`새 문서 ${count}`);
  };

  const handleOpen = async () => {
    const result = await api().officeDocOpenFile?.('hwp');
    if (!result || result.error) {
      if (result?.error) setError(`열기 실패: ${result.error}`);
      return;
    }
    setError('');
    addDoc(result.fileName, { data: result.data, fileName: result.fileName }, result.filePath);
    addRecent('hwp', { filePath: result.filePath, fileName: result.fileName }).then(setRecents);
  };

  const handleOpenRecent = async (doc: RecentDoc) => {
    const result = await api().officeDocReadFile?.(doc.filePath);
    if (!result || result.error) {
      setError(`열기 실패: ${result?.error || '파일을 찾을 수 없습니다'}`);
      removeRecent('hwp', doc.filePath).then(setRecents);
      return;
    }
    setError('');
    addDoc(result.fileName, { data: result.data, fileName: result.fileName }, doc.filePath);
    addRecent('hwp', { filePath: doc.filePath, fileName: result.fileName }).then(setRecents);
  };

  // Pepe-Thing(파일 검색) 등 외부에서 "이 파일을 오피스 워크스페이스로 열기"를 선택했을 때 —
  // 마운트 시 1회, 사용자가 열기 버튼을 누른 것과 동일하게 자동으로 문서를 연다.

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
        label="한글 (HWP/HWPX)"
        right={(
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button style={toolbarBtn} onClick={handleNew}>📄 새 문서</button>
            <button style={toolbarBtn} onClick={handleOpen}>📂 열기</button>
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
              title={d.title}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: '6px 6px 0 0',
                background: d.id === activeId ? 'var(--win-surface, #161b22)' : 'transparent',
                border: '1px solid var(--win-border, #30363d)',
                color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer', maxWidth: 180, whiteSpace: 'nowrap',
              }}
            >
              <span>📄</span>
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
            onRemoveRecent={(fp) => removeRecent('hwp', fp).then(setRecents)}
            message='"새 문서" 또는 "열기"를 눌러 한글 문서를 시작하세요.'
          />
        )}
        {docs.map(d => (
          <div key={d.id} style={{ position: 'absolute', inset: 0, display: d.id === activeId ? 'flex' : 'none', flexDirection: 'column' }}>
            <div ref={(el) => { if (el) mountEditor(d.id, el, d.fileData); }} style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, position: 'relative' }} />
            <div style={{ position: 'absolute', bottom: 6, right: 10, fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)', pointerEvents: 'none' }}>{statusById[d.id]}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
