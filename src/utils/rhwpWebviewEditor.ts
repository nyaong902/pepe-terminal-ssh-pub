// src/utils/rhwpWebviewEditor.ts
// 한글(HWP) 편집기를 <webview> 로 띄우는 호스트. @rhwp/editor 가 하던 일을 대신한다.
//
// 왜 직접 만드나: @rhwp/editor 는 rhwp-studio 를 <iframe> 으로 띄운다. iframe 은 같은 origin 이면
// 같은 렌더러 프로세스라서, 편집기의 WASM 힙(문서 하나에 수백 MB)과 캔버스가 앱 본체 프로세스에
// 얹힌다. WebAssembly.Memory 는 한 번 커지면 줄지 않으므로, 워크스페이스를 닫아도 그 프로세스가
// 사는 동안 메모리가 OS 로 돌아가지 않았다(실측: 앱 시작 600MB → 한글 문서 열고 2.6GB).
// <webview> 는 별도 프로세스라 닫으면 프로세스가 죽고 전부 회수된다.
//
// 통신은 @rhwp/editor 와 같은 프로토콜(rhwp-request / rhwp-response)을 쓴다. 다만 webview 게스트에서
// window.parent 는 자기 자신이라 스튜디오의 응답이 호스트에 닿지 않으므로, preload(electron/preload.ts)
// 가 postMessage ↔ ipc 를 이어준다.
//
// 필요한 만큼만 구현했다 — 화면에서 실제로 쓰는 것은 loadFile / newDocument / destroy 뿐이다.
// 저장은 스튜디오 자체 기능이고 앱은 다운로드를 가로채므로 호스트 API 가 필요 없다.

type WebviewEl = HTMLElement & {
  send: (channel: string, ...args: any[]) => void;
  sendInputEvent: (event: any) => void;
  addEventListener: HTMLElement['addEventListener'];
  getWebContentsId?: () => number;
};

let requestSeq = 0;

export class RhwpWebviewEditor {
  private wv: WebviewEl;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private destroyed = false;

  private constructor(wv: WebviewEl) {
    this.wv = wv;
    this.wv.addEventListener('ipc-message', (e: any) => {
      if (e?.channel !== 'rhwp-response') return;
      const d = e.args?.[0];
      if (!d || d.id == null) return;
      const p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error));
      else p.resolve(d.result);
    });
  }

  /**
   * container 안에 webview 를 만들고 스튜디오가 준비될 때까지 기다린다.
   * preloadUrl 은 메인이 알려주는 file:// URL(app:webview-preload-url).
   */
  static async create(container: HTMLElement, studioUrl: string, preloadUrl: string): Promise<RhwpWebviewEditor> {
    const wv = document.createElement('webview') as WebviewEl;
    wv.setAttribute('src', studioUrl);
    if (preloadUrl) wv.setAttribute('preload', preloadUrl);
    wv.setAttribute('allowpopups', 'false');
    // display 는 반드시 flex — block/inline-block 이면 내부 게스트가 세로로 늘어나지 않고 크롭된다
    // (Electron 문서에 명시된 동작). 브라우저/오피스 워크스페이스도 같은 이유로 flex 를 쓴다.
    wv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;min-width:0;min-height:0;display:flex;border:none;background:#ffffff';
    container.appendChild(wv);

    const editor = new RhwpWebviewEditor(wv);
    await new Promise<void>((resolve) => {
      wv.addEventListener('dom-ready', () => resolve(), { once: true } as any);
    });
    await editor.waitReady();
    return editor;
  }

  private request(method: string, params: Record<string, any> = {}, timeoutMs = 10000): Promise<any> {
    if (this.destroyed) return Promise.reject(new Error('editor destroyed'));
    return new Promise((resolve, reject) => {
      const id = ++requestSeq;
      this.pending.set(id, { resolve, reject });
      try {
        this.wv.send('rhwp-request', { type: 'rhwp-request', id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`rhwp ${method} timeout`));
        }
      }, timeoutMs);
    });
  }

  // WASM 초기화가 끝날 때까지 ready 를 재시도한다(@rhwp/editor 와 같은 방식).
  private async waitReady(): Promise<void> {
    for (let i = 0; i < 30; i++) {
      try {
        await this.request('ready', {}, 1000);
        return;
      } catch {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    throw new Error('rhwp-studio 준비 실패(시간 초과)');
  }

  async loadFile(data: ArrayBuffer | Uint8Array, fileName = 'document.hwp'): Promise<any> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    // 큰 문서는 변환에 시간이 걸리므로 기본 타임아웃보다 넉넉히 준다.
    return this.request('loadFile', { data: bytes, fileName }, 60000);
  }

  /**
   * 빈 문서 만들기. 스튜디오에 새 문서 API 가 없어서 단축키(Alt+N)를 그대로 흘려보낸다.
   * iframe 시절에는 contentDocument 에 KeyboardEvent 를 dispatch 했는데, webview 는 게스트 문서에
   * 직접 손댈 수 없으므로 sendInputEvent 로 실제 키 입력을 보낸다(같은 결과, 더 정직한 경로).
   */
  newDocument(): void {
    try {
      this.wv.sendInputEvent({ type: 'keyDown', keyCode: 'n', modifiers: ['alt'] });
      this.wv.sendInputEvent({ type: 'keyUp', keyCode: 'n', modifiers: ['alt'] });
    } catch {}
  }

  destroy(): void {
    this.destroyed = true;
    this.pending.clear();
    try { this.wv.remove(); } catch {}
  }
}
