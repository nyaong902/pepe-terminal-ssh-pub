// electron/cloudProviders/kakaoProvider.ts
// 카카오 로그인 OAuth2 만 지원 — 톡서랍 플러스는 서드파티 공개 파일 API 가 없음.
// capabilities.list=false 로 명시하고, 실제 파일 화면은 PepeBoxWorkspace 에서 BrowserPane(webview)
// 으로 톡서랍 웹을 띄운다. 여기서는 "로그인 연동됨" 상태만 관리.

import type { CloudProvider, PkceParams, TokenRecord } from './types';

const AUTH_URL = 'https://kauth.kakao.com/oauth/authorize';
const TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const PROFILE_URL = 'https://kapi.kakao.com/v2/user/me';

export const kakaoProvider: CloudProvider = {
  kind: 'kakao',
  capabilities: { list: false, download: false, upload: false, delete: false, createFolder: false },

  buildAuthUrl(clientId, redirectUri, pkce: PkceParams): string {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      state: pkce.state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  async exchangeCodeForToken({ code, clientId, clientSecret, redirectUri, codeVerifier }): Promise<TokenRecord> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    });
    if (clientSecret) params.set('client_secret', clientSecret);
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    if (!res.ok) throw new Error(`Kakao token exchange failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return {
      accountId: '',
      provider: 'kakao',
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in || 21599) * 1000,
      obtainedAt: Date.now(),
      scope: json.scope,
    };
  },

  async refreshToken(record, clientId, clientSecret): Promise<TokenRecord> {
    if (!record.refreshToken) throw new Error('no refresh token');
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: record.refreshToken,
    });
    if (clientSecret) params.set('client_secret', clientSecret);
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    if (!res.ok) throw new Error(`Kakao refresh failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return {
      ...record,
      accessToken: json.access_token,
      refreshToken: json.refresh_token || record.refreshToken,
      expiresAt: Date.now() + (json.expires_in || 21599) * 1000,
      obtainedAt: Date.now(),
    };
  },

  async getAccountProfile(token): Promise<{ label: string }> {
    const res = await fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!res.ok) throw new Error(`Kakao profile fetch failed: ${res.status}`);
    const json: any = await res.json();
    const account = json.kakao_account || {};
    return { label: account.email || json.properties?.nickname || '카카오톡 톡서랍' };
  },
};
