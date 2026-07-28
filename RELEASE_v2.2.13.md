# v2.2.13

## 자동 업데이트 설치 창 안 뜨는 문제 — Job Object 분리 시도

v2.2.11의 중복 실행(무음 인스턴스) 수정은 로그로 확인됐지만, 여전히 일부 PC에서 UAC 승인 이후 설치 창이 뜨지 않았습니다.

남은 용의자는 Windows의 Job Object입니다. Electron은 자식 프로세스를 Job Object로 묶어 관리하는데, 앱이 `app.quit()`으로 종료될 때 그 Job에 딸린 프로세스는 Node의 `detached: true`로 띄웠어도 함께 강제 종료될 수 있습니다. `elevate.exe`가 UAC 승인까지 마치고 설치 프로그램을 막 띄우려는 순간 우리 앱 프로세스가 사라지면서 그 프로세스 트리 전체가 같이 죽는 것이라면, 종료를 5초 늦춰도 소용이 없었던(v2.2.9~v2.2.12) 이유가 설명됩니다.

- `elevate.exe` 실행을 `cmd.exe /c start`로 한 번 더 감싸서, Electron의 Job Object와 완전히 분리된 새 프로세스 트리로 띄우도록 변경 — Electron 앱들이 이 문제를 피할 때 흔히 쓰는 방법

---

## 산출물
- `PePe-Terminal-SSH-Setup-2.2.13.exe` (NSIS 설치본)
- `PePe-Terminal-SSH-2.2.13-portable.exe` (포터블)
