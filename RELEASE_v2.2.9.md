# v2.2.9

## 자동 업데이트 설치 창 안 뜨는 문제 — 근본 원인 특정 및 수정

문제가 재현되는 PC에서 결정적인 단서를 확보했습니다: `elevate.exe`를 앱을 거치지 않고 명령 프롬프트에서 **직접 실행**하면 UAC 창도 뜨고 설치 창도 정상적으로 떴습니다. 즉 elevate.exe나 설치 파일 자체, 백신/SmartScreen은 문제가 아니었습니다.

직접 실행과 앱을 통한 실행의 유일한 차이는 **부모 프로세스가 살아있는지 여부**입니다. electron-updater의 `quitAndInstall`은 `elevate.exe`를 실행시키자마자(로그상 200ms 이내) 곧바로 앱을 완전히 종료합니다. `elevate.exe`가 UAC 승인 요청을 마치기도 전에 앱 프로세스가 사라지면서, 일부 PC 환경에서 그 이후 단계(승인된 자식 프로세스의 창 표시)가 조용히 실패하는 것으로 보입니다. 명령 프롬프트로 직접 실행하면 cmd.exe가 계속 살아있어서 이 문제가 안 생겼던 것이고요.

- electron-updater의 `quitAndInstall`을 그대로 쓰는 대신, `elevate.exe`를 직접 실행하고 **앱 종료를 5초 지연**시켜 UAC 승인과 설치 프로그램 실행이 확실히 끝날 시간을 주도록 변경

이전 시도들(v2.2.1 페이지 표시 방식, v2.2.3 packElevateHelper, v2.2.7 Zone.Identifier 제거)은 모두 현장에서 효과가 없는 것으로 확인됐고, 이번 수정이 실제 근본 원인(타이밍 경쟁 조건)을 겨냥합니다.

---

## 산출물
- `PePe-Terminal-SSH-Setup-2.2.9.exe` (NSIS 설치본)
- `PePe-Terminal-SSH-2.2.9-portable.exe` (포터블)
