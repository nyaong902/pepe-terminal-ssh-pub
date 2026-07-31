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

// https://vitejs.dev/config/
export default defineConfig({
  // CPU 진단용 — 프로덕션 빌드에도 sourcemap 을 남겨서, 문제 PC에서 뜬 DevTools Performance
  // 트레이스의 난독화된 함수명(예: $q, N5e)을 실제 소스 위치로 역매핑할 수 있게 한다.
  // 'hidden' = .js.map 은 그대로 생성하되 번들에 sourceMappingURL 참조를 안 남김(devtools가
  // 자동으로 안 불러옴). package.json build.files 에서 *.map 을 제외해 설치본에는 아예 안 들어가고,
  // 로컬 dist/에만 남아 트레이스 분석용으로 계속 쓸 수 있다.
  build: {
    sourcemap: 'hidden',
  },
  plugins: [
    react(),
    serveExternalStaticDirs(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
        vite: {
          build: {
            sourcemap: 'hidden',
            rollupOptions: {
              external: ['ssh2', 'cpu-features', 'iconv-lite', 'node-pty', 'webdav-server', 'electron-updater'],
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
