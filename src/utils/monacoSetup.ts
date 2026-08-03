// src/utils/monacoSetup.ts
// monaco-editor 를 "로컬 번들"로 쓰게 만드는 설정.
//
// 배경: @monaco-editor/react 는 기본적으로 @monaco-editor/loader 를 통해 monaco 를 CDN
// (https://cdn.jsdelivr.net/npm/monaco-editor@x.y.z/min/vs) 에서 <script> 로 받아온다.
// 그래서 node_modules/monaco-editor 가 설치돼 있어도 실제로는 한 번도 로드되지 않았고,
// 인터넷이 막힌 환경에서는 편집기 4개(SQL Tool / 파일 편집기 / 파일 비교 / 객체 상세)가
// 전부 동작하지 않았다. loader.config({ monaco }) 로 이미 번들된 인스턴스를 넘기면 로더가
// CDN 주입 단계를 건너뛰고 그 인스턴스를 그대로 쓴다.
//
// **이 모듈은 반드시 동적 import 로만 불러야 한다.** 처음엔 main.tsx 에서 side-effect
// import 로 미리 실행했는데, main.tsx 는 본체 외에도 패널/탭 창·스티키 노트·시계 위젯 등
// 6종의 창을 모두 처리하는 진입점이라 시계 위젯 같은 작은 창까지 monaco 전체(약 5MB)를
// 파싱·컴파일했다. 편집기를 열지 않아도 모든 렌더러 프로세스가 그 비용을 물어 유휴 메모리가
// 늘었다. 지금은 components/LazyMonaco.tsx 가 편집기를 처음 그릴 때만 이 모듈을 불러온다.
//
// 워커: monaco 는 언어 서비스를 Web Worker 로 돌리고, self.MonacoEnvironment.getWorker 가
// 없으면 예외를 던진다. Vite 의 `?worker` 임포트가 각 워커를 별도 청크로 빌드해주므로 그것을
// 라벨별로 연결한다. 라벨 목록은 FileEditor 의 확장자→언어 매핑에서 실제로 쓰는 것들이다
// (json / typescript / javascript / css / scss / less / html). 그 외 언어는 monarch 문법
// 하이라이트만 쓰고 워커가 필요 없어 기본 editor.worker 로 보낸다.
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

let done = false;

// 로컬 monaco 인스턴스와 워커를 로더에 연결한다. 여러 편집기가 동시에 열려도 한 번만 돈다.
export function setupLocalMonaco(): void {
  if (done) return;
  done = true;

  (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  loader.config({ monaco });
}
