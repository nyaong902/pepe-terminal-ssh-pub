// electron/cloudProviders/registry.ts
import type { CloudProvider, ProviderKind } from './types';
import { dropboxProvider } from './dropboxProvider';
import { gdriveProvider } from './gdriveProvider';
import { onedriveProvider } from './onedriveProvider';
import { naverProvider } from './naverProvider';
import { kakaoProvider } from './kakaoProvider';

const REGISTRY: Record<ProviderKind, CloudProvider> = {
  dropbox: dropboxProvider,
  gdrive: gdriveProvider,
  onedrive: onedriveProvider,
  naver: naverProvider,
  kakao: kakaoProvider,
};

export function getProvider(kind: ProviderKind): CloudProvider {
  const provider = REGISTRY[kind];
  if (!provider) throw new Error(`Unknown cloud provider: ${kind}`);
  return provider;
}

export function accountIdProvider(accountId: string): ProviderKind {
  return accountId.split(':')[0] as ProviderKind;
}

export function capabilitiesFor(kind: ProviderKind) {
  return getProvider(kind).capabilities;
}

// getAccountProfile() 실패 시(권한 부족/일시적 API 오류 등) 계정 표시 이름의 최종 폴백.
// provider kind 원문("gdrive" 등)을 그대로 노출하면 탭 이름이 초라해 보이므로 사람이 읽을 수 있는 이름으로.
const DISPLAY_NAME: Record<ProviderKind, string> = {
  dropbox: 'Dropbox',
  gdrive: 'Google Drive',
  onedrive: 'MS OneDrive',
  naver: '네이버 MYBOX',
  kakao: '카카오톡 톡서랍',
};

export function displayNameFor(kind: ProviderKind): string {
  return DISPLAY_NAME[kind] || kind;
}
