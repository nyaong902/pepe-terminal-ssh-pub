// electron/cloudProviders/naverProvider.ts
// 네이버 로그인 OAuth2 만 지원 — MYBOX 파일 접근용 서드파티 공개 API 는 없음.
// capabilities.list=false 로 명시하고, 실제 파일 화면은 PepeBoxWorkspace 에서 BrowserPane(webview)
// 으로 mybox.naver.com 을 띄운다. 여기서는 "로그인 연동됨" 상태만 관리.

import type { CloudProvider, PkceParams, TokenRecord } from './types';

const AUTH_URL = 'https://nid.naver.com/oauth2.0/authorize';
const TOKEN_URL = 'https://nid.naver.com/oauth2.0/token';
const PROFILE_URL = 'https://openapi.naver.com/v1/nid/me';

export const naverProvider: CloudProvider = {
  kind: 'naver',
  capabilities: { list: false, download: false, upload: false, delete: false, createFolder: false },

  buildAuthUrl(clientId, redirectUri, pkce: PkceParams): string {
    // 네이버 로그인은 PKCE 미지원 — state 로만 CSRF 방지 (code_verifier 는 미사용, 형식 통일을 위해 인자만 유지)
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state: pkce.state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  async exchangeCodeForToken({ code, clientId, clientSecret, redirectUri }): Promise<TokenRecord> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret || '',
      code,
      redirect_uri: redirectUri,
    });
    const res = await fetch(`${TOKEN_URL}?${params.toString()}`);
    if (!res.ok) throw new Error(`Naver token exchange failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    if (json.error) throw new Error(`Naver token exchange error: ${json.error_description || json.error}`);
    return {
      accountId: '',
      provider: 'naver',
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
      obtainedAt: Date.now(),
    };
  },

  async refreshToken(record, clientId, clientSecret): Promise<TokenRecord> {
    if (!record.refreshToken) throw new Error('no refresh token');
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret || '',
      refresh_token: record.refreshToken,
    });
    const res = await fetch(`${TOKEN_URL}?${params.toString()}`);
    if (!res.ok) throw new Error(`Naver refresh failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    if (json.error) throw new Error(`Naver refresh error: ${json.error_description || json.error}`);
    return { ...record, accessToken: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000, obtainedAt: Date.now() };
  },

  async getAccountProfile(token): Promise<{ label: string }> {
    const res = await fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!res.ok) throw new Error(`Naver profile fetch failed: ${res.status}`);
    const json: any = await res.json();
    return { label: json.response?.email || json.response?.name || '네이버 MYBOX' };
  },
};
