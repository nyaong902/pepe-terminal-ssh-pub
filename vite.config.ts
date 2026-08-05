import { defineConfig } from 'vite'
import path from 'node:path'
import fs from 'node:fs'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// office-editor/rhwp-studio/flowchart-editor/calllog-cdr-tool 은 설치 시 선택 해제될 수 있는 번들이라
// public/ 에서 resources/ 로 옮기고(electron-builder extraResources 로만 패키징됨), 패키지된
// 앱에서는 electron/main.ts 의 pepeapp:// 핸들러가 resourcesPath 에서 직접 서빙한다. 개발 서버에서는
// public/ 밖이라 자동 서빙되지 않으므로, 같은 URL 프리픽스로 정적 파일을 서빙하는 미들웨어가 필요하다
// (같은 origin 이어야 iframe 내부의 File System Access API 등이 cross-origin 취급받지 않는다).
const EXTERNAL_STATIC_DIRS = ['office-editor', 'rhwp-studio', 'flowchart-editor', 'calllog-cdr-tool'];
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function serveExternalStaticDirs(): Plugin {
  return {
    name: 'serve-external-static-dirs',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        const top = url.split('/').filter(Boolean)[0];
        if (!top || !EXTERNAL_STATIC_DIRS.includes(top)) return next();
        const rel = url.slice(1 + top.length) || '/';
        const candidates = rel.endsWith('/') ? [rel + 'index.html'] : [rel, `${rel}.html`, `${rel}/index.html`];
        for (const candidate of candidates) {
          const filePath = path.join(__dirname, 'resources', top, candidate);
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            res.setHeader('content-type', MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        }
        next();
      });
    },
  };
}

// dev 서버에서 로컬 파일을 서빙한다 — 패키지된 앱의 pepeapp://app/__local-file 핸들러와 짝이다.
// 오피스 편집기를 <webview>(별도 프로세스)로 띄우면서 필요해졌다: 예전에는 파일 바이트로 blob:
// URL 을 만들어 넘겼는데, blob: 은 만든 컨텍스트에서만 유효해서 다른 프로세스인 게스트가 열 수
// 없다. 그래서 편집기에 "파일을 가져갈 수 있는 URL" 을 준다 — 원본 경로를 그대로 서빙하면
// 임시 파일도 필요 없다.
// dev 전용이다(vite 개발 서버 미들웨어). 패키지된 앱은 위 프로토콜 핸들러가 같은 일을 한다.
function serveLocalFile(): Plugin {
  return {
    name: 'serve-local-file',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const [urlPath, query] = (req.url || '').split('?');
        if (urlPath !== '/__local-file') return next();
        const params = new URLSearchParams(query || '');
        const raw = (params.get('path') || '').trim();
        if (!raw) { res.statusCode = 400; res.end('Bad Request'); return; }
        const filePath = path.resolve(raw);
        try {
          const st = fs.statSync(filePath);
          if (!st.isFile()) throw new Error('not a file');
          res.setHeader('content-type', MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
          res.setHeader('content-length', String(st.size));
          fs.createReadStream(filePath).pipe(res);
        } catch {
          res.statusCode = 404;
          res.end('Not Found');
        }
      });
    },
  };
}

// 런타임에 경로로 로드되는 .cjs 들(worker_threads / child_process)을 dist-electron/ 으로 복사한다.
// vite 는 electron/main.ts 만 번들하고 이 파일들은 번들 그래프에 없어서 손대지 않는데,
// sshBridge 는 path.join(__dirname, 'sshTerminalWorker.cjs') 로 dist-electron/ 의 사본을 로드한다.
// 예전에는 이 복사가 package.json 의 build 스크립트에만 있어서, dev 에서 worker 를 고쳐도
// 앱은 마지막 풀빌드 시점의 사본을 계속 썼다 — 수정이 조용히 무시되는 함정이었다(실제로 하루치
// worker 최적화가 전부 실행되지 않았고, 그걸 알아내는 데 오래 걸렸다).
// 그래서 dev 서버 시작 시 한 번 복사하고, 이후 파일이 바뀌면 다시 복사한다.
const RUNTIME_CJS = ['sshTerminalWorker.cjs', 'sftpTransferWorker.cjs', 'mcpSshServer.cjs', 'chatArchiveEmbedWorker.cjs'];
function copyRuntimeCjs(): Plugin {
  const copyOne = (name: string) => {
    const from = path.join(__dirname, 'electron', name);
    const to = path.join(__dirname, 'dist-electron', name);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      return true;
    } catch {
      return false;
    }
  };
  return {
    name: 'copy-runtime-cjs',
    buildStart() {
      for (const name of RUNTIME_CJS) copyOne(name);
    },
    configureServer(server) {
      for (const name of RUNTIME_CJS) copyOne(name);
      // 변경 감시 — 저장하면 즉시 사본을 갱신한다(앱 재시작만 하면 반영됨).
      for (const name of RUNTIME_CJS) server.watcher.add(path.join(__dirname, 'electron', name));
      server.watcher.on('change', (file) => {
        const name = path.basename(file);
        if (RUNTIME_CJS.includes(name) && copyOne(name)) {
          server.config.logger.info(`[copy-runtime-cjs] ${name} -> dist-electron/ (앱 재시작 필요)`);
        }
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  // CPU 진단용 — 프로덕션 빌드에도 sourcemap 을 남겨서, 문제 PC에서 뜬 DevTools Performance
  // 트레이스의 난독화된 함수명(예: $q, N5e)을 실제 소스 위치로 역매핑할 수 있게 한다.
  // 'hidden' = .js.map 은 그대로 생성하되 번들에 sourceMappingURL 참조를 안 남김(devtools가
  // 자동으로 안 불러옴). package.json build.files 에서 *.map 을 제외해 설치본에는 아예 안 들어가고,
  // 로컬 dist/에만 남아 트레이스 분석용으로 계속 쓸 수 있다.
  build: {
    sourcemap: 'hidden',
    rollupOptions: {
      // 진입점 두 개. pdf-host.html 은 <webview> 로 띄우는 PDF 뷰어이고, pdfjs 를 여기서만
      // import 하므로 앱 본체 청크에서 pdfjs 가 빠진다(메모리를 프로세스째 회수하려는 목적).
      input: {
        index: path.resolve(__dirname, 'index.html'),
        'pdf-host': path.resolve(__dirname, 'pdf-host.html'),
      },
    },
  },
  plugins: [
    react(),
    serveExternalStaticDirs(),
    copyRuntimeCjs(),
    serveLocalFile(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
        vite: {
          build: {
            sourcemap: 'hidden',
            rollupOptions: {
              external: ['ssh2', 'cpu-features', 'iconv-lite', 'node-pty', 'webdav-server', 'electron-updater', '@xenova/transformers', 'onnxruntime-node', 'sharp', 'koffi'],
            },
          },
        },
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      // Ployfill the Electron and Node.js API for Renderer process.
      // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: process.env.NODE_ENV === 'test'
        // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
        ? undefined
        : {},
    }),
  ],
})
