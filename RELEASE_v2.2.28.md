# v2.2.28

## electron-updater 내장 elevate.exe 우회 — sudo-prompt 로 직접 승격 실행

v2.2.26 → v2.2.27 자동 업데이트를 문제의 PC에서 재현 테스트한 결과, 현장 로그로 다음이 확정됐습니다:

- `autoInstallOnAppQuit` 중복 무음 설치 경쟁은 이미 해결된 상태였다(로그에 `Install on explicit quitAndInstall`이 한 번만 찍힘, 무음 인스턴스 흔적 없음).
- 하지만 `elevate.exe`를 실행한 직후 로그가 끊기고, UAC는 뜨지만 그 뒤 설치 창은 여전히 안 떴다.
- 반면 같은 시점에 다운로드된 설치 파일(`%LOCALAPPDATA%\pepe-terminal-ssh-updater\pending\...`)을 **수동으로 더블클릭하면 완전히 정상 동작**했다.

즉 설치 파일도, 우리 트리거 로직도 문제가 아니라 **electron-updater가 내장한 `elevate.exe`가 그 경로(공백과 괄호가 섞인 `pepe terminal(ssh)-updater` 폴더명)를 실행하는 단계 자체에서 조용히 실패**하는 것으로 보입니다.

이 버전부터는 `electron/updater.ts`의 설치 트리거가 `autoUpdater.quitAndInstall()`(내부적으로 `elevate.exe` 사용)을 호출하지 않고, VPN 연결(`vpnService.ts`)에서 이미 안정적으로 쓰고 있는 **`sudo-prompt`로 직접 승격 실행**하도록 바뀌었습니다. 경로는 항상 큰따옴표로 감싸 전달합니다.

**확인 필요**: 문제의 PC에서 v2.2.27 → v2.2.28 자동 업데이트 시 UAC 승인 후 설치 창이 뜨는지 확인 부탁드립니다.

---

## 산출물
- `PePe-Terminal-SSH-Setup-2.2.28.exe` (NSIS 설치본)
- `PePe-Terminal-SSH-2.2.28-portable.exe` (포터블)
