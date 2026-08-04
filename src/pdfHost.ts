// src/pdfHost.ts
// pdf-host.html 의 스크립트 — <webview> 안에서 pdfjs 로 PDF 를 그린다.
//
// 예전에는 앱 본체(PdfWorkspace)가 pdfjs-dist 를 직접 import 해서 메인 렌더러에서 그렸다. 그러면
// pdfjs 와 문서 데이터가 앱 본체 프로세스에 얹혀, 워크스페이스를 닫아도 메모리가 OS 로 돌아가지
// 않았다. 이 파일은 별도 Vite 진입점(pdf-host.html)이라 pdfjs 가 이 청크로 빠지고, 실행도 webview
// 프로세스에서 이뤄진다 — 닫으면 프로세스째 회수된다.
//
// 호스트와의 통신은 preload 브리지(electron/preload.ts)를 거친다.
//   호스트 -> {method:'setMode'|'save', params}
//   게스트 -> {event:'ready'|'saved'|'error', ...}
import * as pdfjsLib from 'pdfjs-dist';
import { PDFViewer, EventBus, PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

type EditorMode = 'none' | 'highlight' | 'freetext' | 'ink' | 'stamp';

const MODE_TO_TYPE: Record<Exclude<EditorMode, 'none'>, number> = {
  highlight: pdfjsLib.AnnotationEditorType.HIGHLIGHT,
  freetext: pdfjsLib.AnnotationEditorType.FREETEXT,
  ink: pdfjsLib.AnnotationEditorType.INK,
  stamp: pdfjsLib.AnnotationEditorType.STAMP,
};

const msgEl = document.getElementById('msg');
const setMsg = (t: string) => {
  if (!msgEl) return;
  msgEl.textContent = t;
  msgEl.style.display = t ? 'flex' : 'none';
};

// 호스트로 보낸다 — preload 가 window.message 를 잡아 ipc 로 넘긴다(방향 구분은 event 키).
// 문자열이 아니라 객체로 보낸다: 저장한 PDF 바이트(ArrayBuffer)는 JSON 으로 직렬화되지 않는다
// (JSON.stringify 를 거치면 {} 가 되어 빈 파일이 저장된다). 구조적 복제는 ArrayBuffer 를 그대로 옮긴다.
const toHost = (payload: Record<string, any>) => {
  try { window.postMessage(payload, '*'); } catch {}
};

let viewer: any = null;
let pdfDocument: any = null;

async function load(fileUrl: string) {
  const container = document.getElementById('viewerContainer');
  if (!container) return;
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  viewer = new PDFViewer({
    container: container as HTMLDivElement,
    eventBus,
    linkService,
    annotationEditorMode: pdfjsLib.AnnotationEditorType.NONE,
  });
  linkService.setViewer(viewer);

  // cMap/표준폰트 데이터 없이는, 시스템 폰트를 CID(Adobe-Korea1 등)로 참조하는 비임베드 한글
  // 폰트를 못 풀어서 페이지 배경·표·테두리는 멀쩡한데 글자만 전부 안 보이는 증상이 생긴다
  // (HWP 에서 변환한 PDF 에서 흔하다) — public/ 에 복사해둔 pdfjs 리소스를 가리킨다.
  const loadingTask = pdfjsLib.getDocument({
    url: fileUrl,
    cMapUrl: '/pdfjs-cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs-standard-fonts/',
  });
  pdfDocument = await loadingTask.promise;
  viewer.setDocument(pdfDocument);
  linkService.setDocument(pdfDocument);
  setMsg('');
  toHost({ event: 'ready', pageCount: pdfDocument.numPages });
}

function setMode(mode: EditorMode) {
  if (!viewer) return;
  const target = mode === 'none' ? pdfjsLib.AnnotationEditorType.NONE : MODE_TO_TYPE[mode];
  // pdfjs 6.x 는 이벤트버스가 아니라 PDFViewer.annotationEditorMode 세터로 모드를 바꾼다.
  // AnnotationEditorUIManager 는 첫 페이지 렌더 이후 비동기로 만들어지므로, 아직이면 조용히
  // 넘어간다(다음 모드 변경에서 다시 시도된다).
  try { viewer.annotationEditorMode = { mode: target }; } catch {}
}

async function save() {
  if (!pdfDocument) { toHost({ event: 'error', message: '저장할 문서가 없습니다.' }); return; }
  try {
    const bytes: Uint8Array = await pdfDocument.saveDocument();
    // ArrayBuffer 로 잘라 보낸다 — 뷰에 오프셋이 있으면 호스트에서 엉뚱한 구간이 저장된다.
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    toHost({ event: 'saved', data: buf });
  } catch (e: any) {
    toHost({ event: 'error', message: String(e?.message || e) });
  }
}

// 호스트 요청 수신. preload 가 ipc 를 window.postMessage 로 바꿔 넣는다(method 키로 구분).
window.addEventListener('message', (e) => {
  const d: any = e.data;
  if (!d || typeof d !== 'object' || typeof d.method !== 'string') return;
  if (d.method === 'setMode') setMode(d.params?.mode || 'none');
  else if (d.method === 'save') void save();
});

// 열 파일은 쿼리로 받는다.
const fileUrl = new URLSearchParams(location.search).get('file') || '';
if (!fileUrl) {
  setMsg('열 파일이 지정되지 않았습니다.');
} else {
  load(fileUrl).catch((e: any) => {
    setMsg(`로드 실패: ${e?.message || e}`);
    toHost({ event: 'error', message: String(e?.message || e) });
  });
}
