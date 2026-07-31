// electron/cloudProviders/gdriveProvider.ts
// Google Drive OAuth2 (PKCE) + Drive API v3 어댑터. parentless-DAG 구조라 folder id 기반 탐색.
// path 문자열은 표시용일 뿐 — 실제 인자는 folderId ('root' 가 루트).

import fs from 'fs';
import type { CloudFileEntry, CloudProvider, ListFolderResult, TokenRecord } from './types';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const SCOPES = 'https://www.googleapis.com/auth/drive';

function toEntry(item: any, parentId: string): CloudFileEntry {
  const isDir = item.mimeType === 'application/vnd.google-apps.folder';
  return {
    name: item.name,
    path: item.name, // 상위 레이어(cloudBoxHandlers)가 부모 체인으로 전체 path 를 합성
    isDir,
    size: item.size ? Number(item.size) : undefined,
    mtime: item.modifiedTime ? Math.floor(new Date(item.modifiedTime).getTime() / 1000) : undefined,
    remoteId: item.id,
    parentId,
  };
}

export const gdriveProvider: CloudProvider = {
  kind: 'gdrive',
  capabilities: { list: true, download: true, upload: true, delete: true, createFolder: true },

  buildAuthUrl(clientId, redirectUri, pkce): string {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent', // refresh_token 을 항상 재발급 받기 위해 매번 강제
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      state: pkce.state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  async exchangeCodeForToken({ code, clientId, clientSecret, redirectUri, codeVerifier }): Promise<TokenRecord> {
    const params = new URLSearchParams({
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });
    if (clientSecret) params.set('client_secret', clientSecret);
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return {
      accountId: '',
      provider: 'gdrive',
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
      refresh_token: record.refreshToken,
      client_id: clientId,
      grant_type: 'refresh_token',
    });
    if (clientSecret) params.set('client_secret', clientSecret);
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    if (!res.ok) throw new Error(`Google refresh failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return { ...record, accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000, obtainedAt: Date.now() };
  },

  async getAccountProfile(token): Promise<{ label: string }> {
    const res = await fetch(`${API_BASE}/about?fields=user`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!res.ok) throw new Error(`Google profile fetch failed: ${res.status}`);
    const json: any = await res.json();
    return { label: json.user?.emailAddress || json.user?.displayName || 'Google Drive' };
  },

  async homeDir(): Promise<string> {
    return 'root';
  },

  async listFolder(token, folderId, cursor): Promise<ListFolderResult> {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
      pageSize: '200',
    });
    if (cursor) params.set('pageToken', cursor);
    const res = await fetch(`${API_BASE}/files?${params.toString()}`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!res.ok) throw new Error(`Google files.list failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return {
      entries: (json.files || []).map((f: any) => toEntry(f, folderId)),
      nextCursor: json.nextPageToken,
    };
  },

  async download(token, entry, destLocalPath): Promise<void> {
    const res = await fetch(`${API_BASE}/files/${entry.remoteId}?alt=media`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!res.ok) throw new Error(`Google download failed: ${res.status} ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(destLocalPath, buf);
  },

  async upload(token, parentId, localPath, name): Promise<CloudFileEntry> {
    const buf = await fs.promises.readFile(localPath);
    const boundary = `pepebox-${Date.now()}`;
    const metadata = JSON.stringify({ name, parents: [parentId] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const res = await fetch(`${UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error(`Google upload failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return toEntry(json, parentId);
  },

  async createFolder(token, parentId, name): Promise<CloudFileEntry> {
    const res = await fetch(`${API_BASE}/files?fields=id,name,mimeType,modifiedTime`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    });
    if (!res.ok) throw new Error(`Google create folder failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return toEntry(json, parentId);
  },

  async deleteEntry(token, entry): Promise<void> {
    const res = await fetch(`${API_BASE}/files/${entry.remoteId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    if (!res.ok && res.status !== 204) throw new Error(`Google delete failed: ${res.status} ${await res.text()}`);
  },
};
