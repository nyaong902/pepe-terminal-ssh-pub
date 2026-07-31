// electron/cloudOAuthServer.ts
// OAuth2 Authorization Code + PKCE 플로우용 임시 loopback HTTP 서버.
// 커스텀 프로토콜(딥링크) 등록이 없는 앱이라, 시스템 브라우저 인증 후 리다이렉트를
// 127.0.0.1 의 임시 포트로 받아 code 를 캡처하고 즉시 서버를 닫는다.
// (electron/plainAppConnectServer.ts 의 "짧게 떠 있다 스스로 닫히는 로컬 http 서버" 스타일)

import http from 'http';
import crypto from 'crypto';
import type { PkceParams } from './cloudProviders/types';

const CALLBACK_TIMEOUT_MS = 2 * 60 * 1000; // 2분 — 사용자가 로그인 창을 닫거나 방치하면 이 시간만큼 포트가 묶임

// provider(고정 포트)별로 현재 떠 있는 loopback 서버를 추적 — 사용자가 로그인을 완료하지 않고
// 창을 닫은 뒤 같은 서비스에 바로 재시도하면 이전 서버가 아직 CALLBACK_TIMEOUT_MS 동안 포트를
// 물고 있어 "포트 사용 중" 에러가 난다. 같은 포트로 새로 시작하기 직전 이전 서버를 먼저 정리한다.
const activeServersByPort = new Map<number, http.Server>();

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): PkceParams {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(16));
  return { codeVerifier, codeChallenge, state };
}

export type OAuthCallbackResult = { code: string } | { error: string };

const RESULT_PAGE = (ok: boolean, detail: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Pepe-Box</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee;">
<div style="text-align:center;">
<h2>${ok ? '연동이 완료되었습니다' : '연동에 실패했습니다'}</h2>
<p>${detail}</p>
<p>이 창은 닫으셔도 됩니다.</p>
</div></body></html>`;

// Dropbox 등 OAuth 앱 콘솔에서 redirect URI 를 포트까지 정확히 매칭하는 provider 가 많아,
// 매번 랜덤 포트를 쓰면 "Invalid redirect_uri" 에러가 난다. provider 별로 고정 포트를 배정해
// 사용자가 각 서비스 개발자 콘솔에 redirect URI 하나만 등록해두면 되게 한다.
// (포트가 이미 다른 프로그램에 점유돼 있으면 그 서비스만 연동 실패 — 에러 메시지로 안내)
export const OAUTH_FIXED_PORTS: Record<string, number> = {
  dropbox: 53682,
  gdrive: 53683,
  onedrive: 53684,
  naver: 53685,
  kakao: 53686,
};

// redirect URI 의 호스트명 표기 — Azure(Microsoft identity platform)는 "https 또는
// http://localhost 로 시작해야 함" 규칙이 있어 127.0.0.1 을 IP 리터럴로 거부한다.
// Dropbox/Google/Kakao/Naver 는 127.0.0.1 표기를 그대로 허용. 실제 서버는 어느 쪽이든
// 항상 127.0.0.1 에 바인딩하고(아래 listen 호출), redirect URI 문자열의 호스트명만
// provider 요구사항에 맞춰 다르게 표기한다 — localhost 는 127.0.0.1 로 resolve 되므로 동일 서버로 붙는다.
export const OAUTH_REDIRECT_HOST: Record<string, string> = {
  dropbox: '127.0.0.1',
  gdrive: '127.0.0.1',
  onedrive: 'localhost',
  naver: '127.0.0.1',
  kakao: '127.0.0.1',
};

/**
 * loopback 서버를 띄우고 /callback 요청 1건을 기다린다.
 * 반환된 redirectUri 를 authorize URL 의 redirect_uri 로 사용해야 한다.
 * fixedPort 를 넘기면 그 포트로 고정 바인딩(콘솔에 등록해둔 redirect URI 와 매칭용).
 * redirectHost 를 넘기면 redirect URI 문자열의 호스트명을 그 값으로 표기(서버 바인딩은 항상 127.0.0.1).
 */
export async function startOAuthLoopback(expectedState: string, fixedPort?: number, redirectHost: string = '127.0.0.1'): Promise<{ redirectUri: string; waitForCallback: Promise<OAuthCallbackResult> }> {
  // 같은 포트로 이전에 떠 있던(완료되지 않고 방치된) 서버가 있으면 먼저 정리 — 그래야 재시도가
  // CALLBACK_TIMEOUT_MS 를 기다리지 않고 바로 성공한다.
  if (fixedPort) {
    const stale = activeServersByPort.get(fixedPort);
    if (stale) {
      await new Promise<void>((res) => stale.close(() => res()));
      activeServersByPort.delete(fixedPort);
    }
  }

  return new Promise((resolveStart, rejectStart) => {
    const server = http.createServer();
    let settled = false;
    let resolveCallback: (r: OAuthCallbackResult) => void;
    const waitForCallback = new Promise<OAuthCallbackResult>((res) => { resolveCallback = res; });

    const finish = (result: OAuthCallbackResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolveCallback(result);
      setTimeout(() => {
        try { server.close(); } catch {}
        if (fixedPort && activeServersByPort.get(fixedPort) === server) activeServersByPort.delete(fixedPort);
      }, 500);
    };

    const timeoutHandle = setTimeout(() => finish({ error: 'timeout' }), CALLBACK_TIMEOUT_MS);

    server.on('request', (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const err = url.searchParams.get('error');
        if (err) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(RESULT_PAGE(false, err));
          finish({ error: err });
          return;
        }
        if (!code || state !== expectedState) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(RESULT_PAGE(false, 'invalid state/code'));
          finish({ error: 'invalid_state' });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(RESULT_PAGE(true, ''));
        finish({ code });
      } catch (e: any) {
        try { res.writeHead(500).end(); } catch {}
        finish({ error: String(e?.message || e) });
      }
    });

    let listening = false;
    server.on('error', (err: any) => {
      if (!listening) {
        // listen() 자체가 실패한 경우 — 시작 promise 를 reject. 이 시점엔 activeServersByPort 에
        // 등록되지 않았으므로 별도 정리 불필요.
        if (fixedPort && err?.code === 'EADDRINUSE') {
          rejectStart(new Error(`포트 ${fixedPort}이(가) 이미 사용 중입니다. 다른 프로그램을 종료하거나 잠시 후 다시 시도해주세요.`));
          return;
        }
        rejectStart(err);
        return;
      }
      // listen 성공 이후(요청 처리 중 소켓 에러 등)에는 waitForCallback 을 에러로 즉시 종료시켜야
      // finish() 가 전혀 호출되지 않고 CALLBACK_TIMEOUT_MS 만큼 포트가 묶이는 것을 막는다.
      finish({ error: String(err?.message || err) });
    });

    server.listen(fixedPort || 0, '127.0.0.1', () => {
      listening = true;
      if (fixedPort) activeServersByPort.set(fixedPort, server);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (fixedPort || 0);
      resolveStart({ redirectUri: `http://${redirectHost}:${port}/callback`, waitForCallback });
    });
  });
}
