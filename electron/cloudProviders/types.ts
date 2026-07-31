// electron/cloudProviders/types.ts
// Pepe-Box 클라우드 스토리지 연동 공통 타입.

export type ProviderKind = 'dropbox' | 'gdrive' | 'onedrive' | 'naver' | 'kakao';

// 좌측 목록에 노출되는 전체 서비스 (webview-only 인 iCloud 는 provider 어댑터가 없다)
export type CloudServiceKind = ProviderKind | 'icloud';

export type CloudFileEntry = {
  name: string;
  path: string;      // 표시/네비게이션용 경로 (Drive/OneDrive 는 parent 체인으로 합성)
  isDir: boolean;
  size?: number;
  mtime?: number;     // epoch seconds
  remoteId: string;   // 실제 API 호출에 쓰이는 식별자 (Dropbox 는 path 와 동일해도 무방)
  parentId?: string;
};

export type TokenRecord = {
  accountId: string;
  provider: ProviderKind;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;  // epoch ms
  obtainedAt: number; // epoch ms
  scope?: string;
};

export type CloudAccountStatus = 'connected' | 'reauth-required';

export type CloudAccount = {
  id: string;         // `${provider}:${uuid}`
  provider: ProviderKind;
  label: string;       // 표시 이름 (보통 이메일/사용자명)
  connectedAt: number;
  status: CloudAccountStatus;
};

export type ProviderCapabilities = {
  list: boolean;
  download: boolean;
  upload: boolean;
  delete: boolean;
  createFolder: boolean;
};

export type PkceParams = {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
};

export type ListFolderResult = {
  entries: CloudFileEntry[];
  nextCursor?: string;
};

export interface CloudProvider {
  kind: ProviderKind;
  capabilities: ProviderCapabilities;

  buildAuthUrl(clientId: string, redirectUri: string, pkce: PkceParams): string;

  exchangeCodeForToken(params: {
    code: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<TokenRecord>;

  refreshToken(record: TokenRecord, clientId: string, clientSecret?: string): Promise<TokenRecord>;

  getAccountProfile(token: TokenRecord): Promise<{ label: string }>;

  listFolder?(token: TokenRecord, folderIdOrPath: string, cursor?: string): Promise<ListFolderResult>;
  download?(token: TokenRecord, entry: CloudFileEntry, destLocalPath: string): Promise<void>;
  upload?(token: TokenRecord, parentIdOrPath: string, localPath: string, name: string): Promise<CloudFileEntry>;
  createFolder?(token: TokenRecord, parentIdOrPath: string, name: string): Promise<CloudFileEntry>;
  deleteEntry?(token: TokenRecord, entry: CloudFileEntry): Promise<void>;
  homeDir?(token: TokenRecord): Promise<string>;
}
