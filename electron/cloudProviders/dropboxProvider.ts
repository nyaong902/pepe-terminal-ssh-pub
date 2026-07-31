// electron/cloudProviders/dropboxProvider.ts
// Dropbox OAuth2 (PKCE) + Files API 어댑터. 진짜 경로 기반 스토리지라 path 가 곧 API 인자.

import fs from 'fs';
import type { CloudFileEntry, CloudProvider, ListFolderResult, PkceParams, TokenRecord } from './types';

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API_BASE = 'https://api.dropboxapi.com/2';
const CONTENT_BASE = 'https://content.dropboxapi.com/2';

function toEntry(item: any): CloudFileEntry {
  const isDir = item['.tag'] === 'folder';
  return {
    name: item.name,
    path: item.path_display || item.path_lower || `/${item.name}`,
    isDir,
    size: isDir ? undefined : item.size,
    mtime: item.server_modified ? Math.floor(new Date(item.server_modified).getTime() / 1000) : undefined,
    remoteId: item.id || item.path_lower || item.path_display,
  };
}

export const dropboxProvider: CloudProvider = {
  kind: 'dropbox',
  capabilities: { list: true, download: true, upload: true, delete: true, createFolder: true },

  buildAuthUrl(clientId: string, redirectUri: string, pkce: PkceParams): string {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      token_access_type: 'offline',
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      state: pkce.state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  async exchangeCodeForToken({ code, clientId, clientSecret, redirectUri, codeVerifier }): Promise<TokenRecord> {
    const params = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    if (clientSecret) params.set('client_secret', clientSecret);
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    if (!res.ok) throw new Error(`Dropbox token exchange failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return {
      accountId: '',
      provider: 'dropbox',
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in || 14400) * 1000,
      obtainedAt: Date.now(),
      scope: json.scope,
    };
  },

  async refreshToken(record, clientId, clientSecret): Promise<TokenRecord> {
    if (!record.refreshToken) throw new Error('no refresh token');
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: record.refreshToken,
      client_id: clientId,
    });
    if (clientSecret) params.set('client_secret', clientSecret);
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    if (!res.ok) throw new Error(`Dropbox refresh failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return { ...record, accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in || 14400) * 1000, obtainedAt: Date.now() };
  },

  async getAccountProfile(token): Promise<{ label: string }> {
    const res = await fetch(`${API_BASE}/users/get_current_account`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    if (!res.ok) throw new Error(`Dropbox profile fetch failed: ${res.status}`);
    const json: any = await res.json();
    return { label: json.email || json.name?.display_name || 'Dropbox' };
  },

  async homeDir(): Promise<string> {
    return '/';
  },

  async listFolder(token, folderPath, cursor): Promise<ListFolderResult> {
    const path = folderPath === '/' ? '' : folderPath;
    if (cursor) {
      const res = await fetch(`${API_BASE}/files/list_folder/continue`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursor }),
      });
      if (!res.ok) throw new Error(`Dropbox list_folder/continue failed: ${res.status} ${await res.text()}`);
      const json: any = await res.json();
      return { entries: json.entries.map(toEntry), nextCursor: json.has_more ? json.cursor : undefined };
    }
    const res = await fetch(`${API_BASE}/files/list_folder`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, recursive: false, include_deleted: false }),
    });
    if (!res.ok) throw new Error(`Dropbox list_folder failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return { entries: json.entries.map(toEntry), nextCursor: json.has_more ? json.cursor : undefined };
  },

  async download(token, entry, destLocalPath): Promise<void> {
    const res = await fetch(`${CONTENT_BASE}/files/download`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path: entry.path }),
      },
    });
    if (!res.ok) throw new Error(`Dropbox download failed: ${res.status} ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(destLocalPath, buf);
  },

  async upload(token, parentPath, localPath, name): Promise<CloudFileEntry> {
    const dest = (parentPath === '/' ? '' : parentPath) + '/' + name;
    const buf = await fs.promises.readFile(localPath);
    const res = await fetch(`${CONTENT_BASE}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: dest, mode: 'overwrite', autorename: false }),
      },
      body: buf,
    });
    if (!res.ok) throw new Error(`Dropbox upload failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return toEntry(json);
  },

  async createFolder(token, parentPath, name): Promise<CloudFileEntry> {
    const dest = (parentPath === '/' ? '' : parentPath) + '/' + name;
    const res = await fetch(`${API_BASE}/files/create_folder_v2`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dest, autorename: false }),
    });
    if (!res.ok) throw new Error(`Dropbox create_folder failed: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    return toEntry(json.metadata);
  },

  async deleteEntry(token, entry): Promise<void> {
    const res = await fetch(`${API_BASE}/files/delete_v2`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entry.path }),
    });
    if (!res.ok) throw new Error(`Dropbox delete failed: ${res.status} ${await res.text()}`);
  },
};
