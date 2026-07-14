// electron/cryptoNative.ts
// UEnc.c 호환 음원 암복호화의 시스템키(get_uenc_system_key(), "LGU_VHVMS")를 담은 네이티브
// 애드온(pepe_crypto_native.node)을 로드한다. 이 애드온 자체(소스/바이너리)는 회사 소유 시스템
// 키가 들어있어 공개 git 저장소에는 절대 커밋하지 않는다 — gstreamer-sidecar 의 EVS 플러그인과
// 동일한 패턴으로, crypto-local-package/install-crypto-local.bat 을 통해 사내에서만
// out-of-band 로 배포하고, 사용자 로컬 경로(PEPE_CRYPTO_ROOT 환경변수 또는 기본 경로)에 설치한다.
//
// 이 애드온이 없는(=git 클론만 받은) 빌드에서는 isCryptoNativeAvailable() 이 false 를 반환하고,
// mediaCodec.ts 의 모든 암복호화 관련 함수가 명확한 에러를 던져 UI 단에서 암호화 관련
// 버튼/메뉴를 비활성화할 수 있게 한다(electron/gstreamerSidecar.ts 의 EVS 플레이스홀더 게이트와
// 동일한 설계).
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

type CryptoNativeAddon = { getSystemKey: () => string };

let cachedAddon: CryptoNativeAddon | null | undefined; // undefined = 아직 시도 안 함, null = 실패/없음

function candidatePaths(): string[] {
  const candidates: string[] = [];
  if (process.env.PEPE_CRYPTO_ROOT) {
    candidates.push(path.join(process.env.PEPE_CRYPTO_ROOT, 'pepe_crypto_native.node'));
  }
  // install-crypto-local.bat 의 기본 설치 위치.
  candidates.push(path.join(os.homedir(), '.pepe-crypto-local', 'pepe_crypto_native.node'));
  return candidates;
}

function loadAddon(): CryptoNativeAddon | null {
  for (const candidate of candidatePaths()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const addon = require(candidate) as CryptoNativeAddon;
      if (addon && typeof addon.getSystemKey === 'function') return addon;
    } catch { /* 다음 후보 경로 시도 */ }
  }
  return null;
}

export function isCryptoNativeAvailable(): boolean {
  if (cachedAddon === undefined) cachedAddon = loadAddon();
  return cachedAddon !== null;
}

/** 시스템키를 반환한다. 네이티브 애드온이 없으면 throw — 호출부는 반드시 isCryptoNativeAvailable() 로 먼저 확인할 것. */
export function getSystemKey(): string {
  if (cachedAddon === undefined) cachedAddon = loadAddon();
  if (!cachedAddon) {
    throw new Error(
      '암호화 기능을 사용할 수 없습니다 (crypto-local-package 미설치). ' +
      '사내 배포 패키지의 install-crypto-local.bat 을 실행한 뒤 앱을 재시작하세요.'
    );
  }
  return cachedAddon.getSystemKey();
}
