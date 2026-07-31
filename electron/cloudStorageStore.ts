// electron/cloudStorageStore.ts
// Pepe-Box 계정 메타데이터 + OAuth 토큰 + provider 설정(Client ID/Secret) 영속화.
// 계정 메타데이터는 평문 JSON (민감정보 없음), 토큰/시크릿은 safeStorage 로 whole-blob 암호화
// (electron/main.ts 의 browser-credentials.json 패턴과 동일).

import fs from 'fs';
import path from 'path';
import { app, safeStorage } from 'electron';
import type { CloudAccount, ProviderKind, TokenRecord } from './cloudProviders/types';

export type ProviderSettings = {
  clientId: string;
  clientSecret?: string;
};

function accountsFile(): string {
  return path.join(app.getPath('userData'), 'cloudbox-accounts.json');
}
function tokensFile(): string {
  return path.join(app.getPath('userData'), 'cloudbox-tokens.json');
}
function settingsFile(): string {
  return path.join(app.getPath('userData'), 'cloudbox-provider-settings.json');
}

function loadJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(file: string, data: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// OS 안전 저장소(safeStorage)가 일시적으로 불가능한 상태(예: 화면 잠금 직후, 원격 세션 전환 등)를
// "토큰이 진짜로 없음"과 구분하지 않고 그냥 빈 객체를 반환해버리면, getValidToken() 이 이를
// "저장된 토큰 없음"으로 오인해 이미 연결된 계정을 전부 reauth-required 로 표시해버린다 —
// 실제로는 재로그인이 전혀 필요 없는데도. 구분할 수 있게 전용 에러를 던진다.
export class SafeStorageUnavailableError extends Error {
  constructor() { super('OS 안전 저장소를 일시적으로 사용할 수 없습니다'); this.name = 'SafeStorageUnavailableError'; }
}

function loadEncryptedBlob<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return fallback;
  if (!safeStorage.isEncryptionAvailable()) throw new SafeStorageUnavailableError();
  try {
    const dec = safeStorage.decryptString(Buffer.from(raw, 'base64'));
    const parsed = JSON.parse(dec);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function saveEncryptedBlob(file: string, data: any) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS 안전 저장소 사용 불가');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const enc = safeStorage.encryptString(JSON.stringify(data)).toString('base64');
  fs.writeFileSync(file, enc, 'utf8');
}

// ── 계정 메타데이터 (평문) ──
export function loadAccounts(): CloudAccount[] {
  return loadJson<CloudAccount[]>(accountsFile(), []);
}
export function saveAccounts(accounts: CloudAccount[]) {
  saveJson(accountsFile(), accounts);
}
export function addAccount(account: CloudAccount) {
  const accounts = loadAccounts().filter(a => a.id !== account.id);
  accounts.push(account);
  saveAccounts(accounts);
}
export function removeAccount(accountId: string) {
  saveAccounts(loadAccounts().filter(a => a.id !== accountId));
  const tokens = loadTokens();
  delete tokens[accountId];
  saveTokens(tokens);
}
export function setAccountStatus(accountId: string, status: CloudAccount['status']) {
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.id === accountId);
  if (acc) { acc.status = status; saveAccounts(accounts); }
}

// ── 토큰 (암호화) ──
export function loadTokens(): Record<string, TokenRecord> {
  return loadEncryptedBlob<Record<string, TokenRecord>>(tokensFile(), {});
}
export function saveTokens(tokens: Record<string, TokenRecord>) {
  saveEncryptedBlob(tokensFile(), tokens);
}
export function getToken(accountId: string): TokenRecord | null {
  return loadTokens()[accountId] || null;
}
export function saveTokenForAccount(accountId: string, record: TokenRecord) {
  const tokens = loadTokens();
  tokens[accountId] = record;
  saveTokens(tokens);
}

// ── Provider 설정 (Client ID/Secret, 암호화) ──
export function loadProviderSettings(): Partial<Record<ProviderKind, ProviderSettings>> {
  return loadEncryptedBlob(settingsFile(), {});
}
export function saveProviderSettings(kind: ProviderKind, settings: ProviderSettings) {
  const all = loadProviderSettings();
  all[kind] = settings;
  saveEncryptedBlob(settingsFile(), all);
}
export function getProviderSettings(kind: ProviderKind): ProviderSettings | null {
  return loadProviderSettings()[kind] || null;
}
