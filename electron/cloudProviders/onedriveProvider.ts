// electron/cloudProviders/onedriveProvider.ts
// Microsoft identity platform (Azure AD v2, consumers/personal 계정 지원) OAuth2 + Graph API 어댑터.
// OneDrive 도 Drive 처럼 item id 기반 탐색.

import fs from 'fs';
import type { CloudFileEntry, CloudProvider, ListFolderResult, TokenRecord } from './types';

const AUTHORITY = 'https://login.microsoftonline.com/consumers';
const AUTH_URL = `${AUTHORITY}/oauth2/v2.0/authorize`;
const TOKEN_URL = `${AUTHORITY}/oauth2/v2.0/token`;
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'offline_access Files.ReadWrite User.Read';

function toEntry(item: any, parentId: string): CloudFileEntry {
  const isDir = !!item.folder;
  return {
    name: item.name,
    path: item.name, // 상위 레이어가 부모 체인으로 전체 path 합성
    isDir,
    size: item.size,
    mtime: item.lastModifiedDateTime ? Math.floor(new Date(item.lastModifiedDateTime).getTime() / 1000) : undefined,
    remoteId: item.id,
    parentId,
  };
}

export const onedriveProvider: CloudProvider = {
  kind: 'onedrive',
  capabilities: { list: true, download: true, upload: true, delete: true, createFolder: true },

  buildAuthUrl(clientId, redirectUri, pkce): string {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: SCOPES,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      state: pkce.state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  async exchangeCodeForToken({ code, clientId, clientSecret, redirectUri, codeVerifier }): Promise<TokenRecord> {
    const params = new URLSearchParams({
      client_id: clientId,
      scope: SCOPES,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });
    if (clientSecret) params.set('client_secret', clientSecret);
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    if (!res.ok) throw new Error(`Microsoft token exchange failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return {
      accountId: '',
      provider: 'onedrive',
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
      obtainedAt: Date.now(),
      scope: json.scope,
    };
  },

  async refreshToken(record, clientId, clientSecret): Promise<TokenRecord> {
    if (!record.refreshToken) throw new Error('no refresh token');
    const params = new URLSearchParams({
      client_id: clientId,
      scope: SCOPES,
      refresh_token: record.refreshToken,
      grant_type: 'refresh_token',
    });
    if (clientSecret) params.set('client_secret', clientSecret);
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    if (!res.ok) throw new Error(`Microsoft refresh failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return {
      ...record,
      accessToken: json.access_token,
      refreshToken: json.refresh_token || record.refreshToken,
      expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
      obtainedAt: Date.now(),
    };
  },

  async getAccountProfile(token): Promise<{ label: string }> {
    const res = await fetch(`${GRAPH_BASE}/me`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!res.ok) throw new Error(`Microsoft profile fetch failed: ${res.status}`);
    const json: any = await res.json();
    return { label: json.mail || json.userPrincipalName || json.displayName || 'OneDrive' };
  },

  async homeDir(): Promise<string> {
    return 'root';
  },

  async listFolder(token, folderId, cursor): Promise<ListFolderResult> {
    const url = cursor || `${GRAPH_BASE}/me/drive/items/${folderId}/children?$select=id,name,folder,size,lastModifiedDateTime&$top=200`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!res.ok) throw new Error(`Graph children list failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return {
      entries: (json.value || []).map((f: any) => toEntry(f, folderId)),
      nextCursor: json['@odata.nextLink'],
    };
  },

  async download(token, entry, destLocalPath): Promise<void> {
    const res = await fetch(`${GRAPH_BASE}/me/drive/items/${entry.remoteId}/content`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`Graph download failed: ${res.status} ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(destLocalPath, buf);
  },

  async upload(token, parentId, localPath, name): Promise<CloudFileEntry> {
    const buf = await fs.promises.readFile(localPath);
    // 4MB 미만 단순 업로드 — 대용량은 upload session 필요(추후 확장 지점)
    const encodedName = encodeURIComponent(name);
    const res = await fetch(`${GRAPH_BASE}/me/drive/items/${parentId}:/${encodedName}:/content`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    if (!res.ok) throw new Error(`Graph upload failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return toEntry(json, parentId);
  },

  async createFolder(token, parentId, name): Promise<CloudFileEntry> {
    const res = await fetch(`${GRAPH_BASE}/me/drive/items/${parentId}/children`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
    });
    if (!res.ok) throw new Error(`Graph create folder failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return toEntry(json, parentId);
  },

  async deleteEntry(token, entry): Promise<void> {
    const res = await fetch(`${GRAPH_BASE}/me/drive/items/${entry.remoteId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    if (!res.ok && res.status !== 204) throw new Error(`Graph delete failed: ${res.status} ${await res.text()}`);
  },
};
