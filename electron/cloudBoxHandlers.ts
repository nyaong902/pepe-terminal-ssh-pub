// electron/cloudBoxHandlers.ts
// Pepe-Box 오케스트레이션 — 계정/토큰 조회, refresh, IPC 'cloud' 모드에서 쓰는
// list/download/upload/delete 디스패치. Drive/OneDrive 의 folder-id ↔ 표시 path 캐시도 여기서 관리.

import path from 'path';
import { randomUUID } from 'crypto';
import { shell } from 'electron';
import * as store from './cloudStorageStore';
import { SafeStorageUnavailableError } from './cloudStorageStore';
import { getProvider, accountIdProvider, displayNameFor } from './cloudProviders/registry';
import { generatePkce, startOAuthLoopback, OAUTH_FIXED_PORTS, OAUTH_REDIRECT_HOST } from './cloudOAuthServer';
import type { CloudAccount, CloudFileEntry, ProviderKind, TokenRecord } from './cloudProviders/types';

const TOKEN_EXPIRY_SKEW_MS = 60_000;

// ── path ⇄ folderId 캐시 (Drive/OneDrive 전용, 계정별) ──
// key: accountId, value: Map<displayPath, folderId>
const pathIdCache = new Map<string, Map<string, string>>();

function cacheFor(accountId: string): Map<string, string> {
  let m = pathIdCache.get(accountId);
  if (!m) { m = new Map(); m.set('/', 'root'); pathIdCache.set(accountId, m); }
  return m;
}

function isIdBased(provider: ProviderKind): boolean {
  return provider === 'gdrive' || provider === 'onedrive';
}

// provider.listFolder() 는 페이지당 최대 200개(Drive)/기본 페이지 크기(Graph)만 반환하고
// nextCursor 로 다음 페이지를 넘겨준다. 폴더 이름/파일 이름으로 찾아야 하는 resolveFolderId·
// resolveEntry 가 첫 페이지만 보고 "찾을 수 없음"을 던지면, 실제로는 존재하지만 200번째 이후에
// 있는 폴더/파일을 계속 못 찾게 된다 — 모든 페이지를 순회해서 완전한 목록을 모은다.
async function listFolderAllPages(provider: ReturnType<typeof getProvider>, token: TokenRecord, folderId: string): Promise<CloudFileEntry[]> {
  const all: CloudFileEntry[] = [];
  let cursor: string | undefined;
  do {
    const { entries, nextCursor } = await provider.listFolder!(token, folderId, cursor);
    all.push(...entries);
    cursor = nextCursor;
  } while (cursor);
  return all;
}

export async function getValidToken(accountId: string, emit: (event: any) => void): Promise<TokenRecord> {
  let record: TokenRecord | null;
  try {
    record = store.getToken(accountId);
  } catch (err) {
    // OS 안전 저장소가 일시적으로 막힌 경우(화면 잠금 직후 등) — 실제로는 토큰이 저장돼 있으므로
    // reauth-required 로 격하시키지(계정 상태를 바꾸지) 않고 구분된 에러 그대로 전파해서
    // "재로그인" 대신 "잠시 후 다시 시도" 로 안내되게 한다.
    if (err instanceof SafeStorageUnavailableError) throw err;
    throw err; // 그 외 저장소 오류는 동일하게 전파(별도 처리 불필요)
  }
  if (!record) throw new Error('reauth-required');
  const provider = getProvider(accountIdProvider(accountId));
  if (Date.now() < record.expiresAt - TOKEN_EXPIRY_SKEW_MS) return record;
  if (!record.refreshToken) {
    store.setAccountStatus(accountId, 'reauth-required');
    emit({ type: 'reauth-required', accountId });
    throw new Error('reauth-required');
  }
  const settings = store.getProviderSettings(provider.kind);
  try {
    const refreshed = await provider.refreshToken(record, settings?.clientId || '', settings?.clientSecret);
    const merged: TokenRecord = { ...refreshed, accountId, provider: provider.kind };
    store.saveTokenForAccount(accountId, merged);
    return merged;
  } catch (err) {
    store.setAccountStatus(accountId, 'reauth-required');
    emit({ type: 'reauth-required', accountId });
    throw new Error('reauth-required');
  }
}

/**
 * 계정 root 부터 displayPath 까지 폴더 id 를 이미 캐시된 구간까지는 재사용하고,
 * 나머지는 폴더 리스팅으로 이름 매칭해서 순차적으로 resolve 한다. (Drive/OneDrive 전용)
 */
async function resolveFolderId(accountId: string, token: TokenRecord, displayPath: string): Promise<string> {
  const cache = cacheFor(accountId);
  const cached = cache.get(displayPath);
  if (cached) return cached;

  const provider = getProvider(accountIdProvider(accountId));
  const segments = displayPath.split('/').filter(Boolean);
  let curPath = '/';
  let curId = cache.get('/') || (await provider.homeDir!(token));
  cache.set('/', curId);

  for (const seg of segments) {
    const nextPath = curPath === '/' ? `/${seg}` : `${curPath}/${seg}`;
    const nextCached = cache.get(nextPath);
    if (nextCached) { curId = nextCached; curPath = nextPath; continue; }
    const entries = await listFolderAllPages(provider, token, curId);
    const match = entries.find(e => e.isDir && e.name === seg);
    if (!match) throw new Error(`경로를 찾을 수 없음: ${nextPath}`);
    cache.set(nextPath, match.remoteId);
    curId = match.remoteId;
    curPath = nextPath;
  }
  return curId;
}

function displayPathFor(parentDisplayPath: string, name: string): string {
  return parentDisplayPath === '/' ? `/${name}` : `${parentDisplayPath}/${name}`;
}

export async function cloudListFolder(accountId: string, displayPath: string, emit: (e: any) => void): Promise<{ files: CloudFileEntry[] } | { error: string }> {
  try {
    const providerKind = accountIdProvider(accountId);
    const provider = getProvider(providerKind);
    if (!provider.capabilities.list || !provider.listFolder) {
      return { error: 'not-supported: 이 서비스는 파일 탐색 API 를 제공하지 않습니다' };
    }
    const token = await getValidToken(accountId, emit);

    if (isIdBased(providerKind)) {
      const folderId = await resolveFolderId(accountId, token, displayPath || '/');
      // FilePanel 은 pagination 개념이 없어(result.files 를 그대로 렌더) 여기서 전체 페이지를
      // 모아서 한 번에 반환해야 한다 — 안 그러면 200개 넘는 폴더의 뒷부분 파일이 안 보인다.
      const entries = await listFolderAllPages(provider, token, folderId);
      const cache = cacheFor(accountId);
      const files = entries.map(e => {
        const p = displayPathFor(displayPath || '/', e.name);
        if (e.isDir) cache.set(p, e.remoteId);
        return { ...e, path: p };
      });
      return { files };
    }

    const entries = await listFolderAllPages(provider, token, displayPath || '/');
    return { files: entries };
  } catch (err: any) {
    if (String(err?.message) === 'reauth-required') return { error: 'reauth-required' };
    return { error: String(err?.message || err) };
  }
}

export async function cloudHomeDir(accountId: string, emit: (e: any) => void): Promise<string> {
  const providerKind = accountIdProvider(accountId);
  const provider = getProvider(providerKind);
  if (!provider.capabilities.list) return '/';
  await getValidToken(accountId, emit); // 토큰 유효성만 검증(만료 시 refresh/reauth-required 트리거)
  return '/';
}

export async function cloudDownload(accountId: string, displayPath: string, destLocalPath: string, emit: (e: any) => void): Promise<void> {
  const providerKind = accountIdProvider(accountId);
  const provider = getProvider(providerKind);
  if (!provider.download) throw new Error('not-supported');
  const token = await getValidToken(accountId, emit);
  const entry = await resolveEntry(accountId, provider, token, displayPath);
  await provider.download(token, entry, destLocalPath);
}

export async function cloudUpload(accountId: string, parentDisplayPath: string, localPath: string, name: string, emit: (e: any) => void): Promise<void> {
  const providerKind = accountIdProvider(accountId);
  const provider = getProvider(providerKind);
  if (!provider.upload) throw new Error('not-supported');
  const token = await getValidToken(accountId, emit);
  const parentIdOrPath = isIdBased(providerKind) ? await resolveFolderId(accountId, token, parentDisplayPath || '/') : (parentDisplayPath || '/');
  await provider.upload(token, parentIdOrPath, localPath, name);
}

export async function cloudDelete(accountId: string, displayPath: string, emit: (e: any) => void): Promise<void> {
  const providerKind = accountIdProvider(accountId);
  const provider = getProvider(providerKind);
  if (!provider.deleteEntry) throw new Error('not-supported');
  const token = await getValidToken(accountId, emit);
  const entry = await resolveEntry(accountId, provider, token, displayPath);
  await provider.deleteEntry(token, entry);
}

async function resolveEntry(accountId: string, provider: ReturnType<typeof getProvider>, token: TokenRecord, displayPath: string): Promise<CloudFileEntry> {
  const providerKind = provider.kind;
  if (!isIdBased(providerKind)) {
    return { name: path.basename(displayPath), path: displayPath, isDir: false, remoteId: displayPath };
  }
  const parentPath = displayPath.slice(0, displayPath.lastIndexOf('/')) || '/';
  const name = path.basename(displayPath);
  const parentId = await resolveFolderId(accountId, token, parentPath);
  const entries = await listFolderAllPages(provider, token, parentId);
  const match = entries.find(e => e.name === name);
  if (!match) throw new Error(`항목을 찾을 수 없음: ${displayPath}`);
  return match;
}

// ── 계정/연결 관리 ──

export function listAccounts(): CloudAccount[] {
  return store.loadAccounts();
}

export function getProviderSettingsSafe(kind: ProviderKind): { clientId: string; hasSecret: boolean } {
  const s = store.getProviderSettings(kind);
  return { clientId: s?.clientId || '', hasSecret: !!s?.clientSecret };
}

export function saveProviderSettings(kind: ProviderKind, clientId: string, clientSecret: string) {
  store.saveProviderSettings(kind, { clientId, clientSecret: clientSecret || undefined });
}

export function disconnectAccount(accountId: string) {
  store.removeAccount(accountId);
  pathIdCache.delete(accountId);
}

// getAccountProfile() 실패 시점(예: Drive API 미활성화 상태에서 최초 연결)에 provider 이름으로
// 저장돼버린 계정 label 을 갱신 — 재연결(Disconnect→Connect) 없이도 실제 이메일/사용자명으로 고칠 수 있게.
export async function refreshAccountLabel(accountId: string, emit: (e: any) => void): Promise<{ ok: boolean; label?: string; error?: string }> {
  try {
    const providerKind = accountIdProvider(accountId);
    const provider = getProvider(providerKind);
    const token = await getValidToken(accountId, emit);
    const { label } = await provider.getAccountProfile(token);
    const accounts = store.loadAccounts();
    const acc = accounts.find(a => a.id === accountId);
    if (acc) { acc.label = label; store.saveAccounts(accounts); }
    return { ok: true, label };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function connectAccount(providerKind: ProviderKind, emit: (e: any) => void): Promise<{ accountId?: string; error?: string }> {
  const settings = store.getProviderSettings(providerKind);
  if (!settings?.clientId) return { error: 'Client ID 가 설정되지 않았습니다. 먼저 설정에서 입력해주세요.' };

  const provider = getProvider(providerKind);
  const pkce = generatePkce();
  let loopback;
  try {
    loopback = await startOAuthLoopback(pkce.state, OAUTH_FIXED_PORTS[providerKind], OAUTH_REDIRECT_HOST[providerKind]);
  } catch (err: any) {
    return { error: `로컬 인증 서버 시작 실패: ${err?.message || err}` };
  }

  const authUrl = provider.buildAuthUrl(settings.clientId, loopback.redirectUri, pkce);
  shell.openExternal(authUrl).catch(() => {});

  const result = await loopback.waitForCallback;
  if ('error' in result) return { error: `인증 실패: ${result.error}` };

  try {
    const tokenRaw = await provider.exchangeCodeForToken({
      code: result.code,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      redirectUri: loopback.redirectUri,
      codeVerifier: pkce.codeVerifier,
    });
    const accountId = `${providerKind}:${randomUUID().slice(0, 8)}`;
    const token: TokenRecord = { ...tokenRaw, accountId, provider: providerKind };
    store.saveTokenForAccount(accountId, token);

    let label: string = displayNameFor(providerKind);
    try { label = (await provider.getAccountProfile(token)).label; } catch {}

    const account: CloudAccount = { id: accountId, provider: providerKind, label, connectedAt: Date.now(), status: 'connected' };
    store.addAccount(account);
    emit({ type: 'auth-success', accountId, account });
    return { accountId };
  } catch (err: any) {
    emit({ type: 'auth-error', provider: providerKind, error: String(err?.message || err) });
    return { error: String(err?.message || err) };
  }
}

export async function reauthAccount(accountId: string, emit: (e: any) => void): Promise<{ ok: boolean; newAccountId?: string; error?: string }> {
  const providerKind = accountIdProvider(accountId);
  const result = await connectAccount(providerKind, emit);
  if (result.error) return { ok: false, error: result.error };
  // 기존 accountId 를 새 것으로 대체(열려있는 FilePanel 탭이 이전 accountId 를 참조 중일 수 있으므로
  // 계정 목록에서는 이전 계정을 제거하고 새 계정으로 교체) — newAccountId 를 반환해 렌더러가
  // 열린 탭의 id 를 갱신할 수 있게 한다(안 그러면 탭은 삭제된 계정을 계속 참조해 영구히
  // reauth-required 로 고착된다).
  if (result.accountId && result.accountId !== accountId) {
    store.removeAccount(accountId);
    pathIdCache.delete(accountId);
  }
  return { ok: true, newAccountId: result.accountId };
}
