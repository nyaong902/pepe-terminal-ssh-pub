// src/components/LazyMonaco.tsx
// monaco 편집기를 "처음 열 때" 로드하는 래퍼.
//
// monaco 를 CDN 대신 로컬 번들로 쓰도록 바꾸면서(utils/monacoSetup.ts) 처음엔 main.tsx 에서
// 미리 로드했다. 그런데 main.tsx 는 본체뿐 아니라 패널/탭 창·스티키 노트·시계 위젯까지 6종의
// 창이 공유하는 진입점이라, 편집기와 아무 상관 없는 작은 창들까지 monaco 전체를 파싱·컴파일해
// 유휴 메모리가 늘었다(시작 청크가 7.46MB 로 커졌다). 그래서 편집기를 실제로 그릴 때 로드한다.
//
// @monaco-editor/react 는 <Editor> 가 마운트될 때 loader.init() 을 부르고, 그 시점에
// loader.config({ monaco }) 가 안 돼 있으면 CDN 으로 가버린다. 그래서 React.lazy 의 로더
// 안에서 설정까지 끝낸 뒤 컴포넌트를 넘긴다 — 마운트 시점에는 이미 설정이 끝나 있다.
import { lazy, Suspense, type ComponentProps } from 'react';
import type MonacoEditor from '@monaco-editor/react';
import type { DiffEditor as MonacoDiffEditor } from '@monaco-editor/react';

type EditorProps = ComponentProps<typeof MonacoEditor>;
type DiffEditorProps = ComponentProps<typeof MonacoDiffEditor>;

// monaco 본체 로드 + 로더 설정. 편집기가 여러 개 열려도 한 번만 수행한다.
let configured: Promise<void> | null = null;
function ensureLocalMonaco(): Promise<void> {
  if (!configured) {
    configured = import('../utils/monacoSetup').then(m => m.setupLocalMonaco());
  }
  return configured;
}

const RealEditor = lazy(async () => {
  const [mod] = await Promise.all([import('@monaco-editor/react'), ensureLocalMonaco()]);
  return { default: mod.default };
});

const RealDiffEditor = lazy(async () => {
  const [mod] = await Promise.all([import('@monaco-editor/react'), ensureLocalMonaco()]);
  return { default: mod.DiffEditor };
});

// 로딩 중 자리 표시 — @monaco-editor/react 의 loading prop 과 같은 자리에 같은 톤으로 둔다.
function EditorLoading() {
  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-muted, #888)', fontSize: 13,
    }}>
      편집기 준비 중…
    </div>
  );
}

export function Editor(props: EditorProps) {
  return (
    <Suspense fallback={<EditorLoading />}>
      <RealEditor {...props} />
    </Suspense>
  );
}

export function DiffEditor(props: DiffEditorProps) {
  return (
    <Suspense fallback={<EditorLoading />}>
      <RealDiffEditor {...props} />
    </Suspense>
  );
}
