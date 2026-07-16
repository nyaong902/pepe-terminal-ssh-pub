// src/utils/companyMessenger.ts
// 사내 메신저(네이버웍스) 관련 상수 — App.tsx(옵션 화면)와 ClaudeChat.tsx(임베드 렌더) 양쪽에서 공유.
export const COMPANY_MESSENGER_LOGIN_URL = 'https://auth.worksmobile.com/login/login?accessUrl=https%3A%2F%2Ftalk.worksmobile.com%2F';
export const COMPANY_MESSENGER_DOMAIN = '@ipageon.com';
// 자격증명 저장 키 — 호스트명 기준(BrowserPane.getBrowserSiteKey 와 동일 규칙).
export const COMPANY_MESSENGER_SITE_KEY = 'auth.worksmobile.com';
