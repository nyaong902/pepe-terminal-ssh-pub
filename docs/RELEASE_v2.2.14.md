# v2.2.14

## 자동 업데이트 — 표준 방식으로 단순화

v2.2.9~v2.2.13에서 `elevate.exe` 직접 spawn, 앱 종료 지연, `cmd /c start` 감싸기 등 자체적으로 재구현을 시도했지만 현장에서 계속 재현됐습니다.

검증된 대형 오픈소스 Electron 터미널 앱(Eugeny/tabby)의 실제 구현을 확인해보니, 별다른 우회 로직 없이 표준 `autoUpdater.quitAndInstall()` 하나만 호출하고 있었습니다. 저희의 자체 재구현이 오히려 문제를 더 꼬이게 만들었을 가능성이 있어, 표준 방식으로 되돌렸습니다.

- `elevate.exe` 직접 spawn/지연/cmd 감싸기 로직을 모두 제거하고 표준 `autoUpdater.quitAndInstall(false, true)` 호출로 단순화
- v2.2.11에서 확인된 실제 버그 수정(`autoInstallOnAppQuit` 비활성화로 무음 중복 실행 방지)은 유지
- 진단 로그(`update-debug.log`)도 계속 유지

---

## 산출물
- `PePe-Terminal-SSH-Setup-2.2.14.exe` (NSIS 설치본)
- `PePe-Terminal-SSH-2.2.14-portable.exe` (포터블)
