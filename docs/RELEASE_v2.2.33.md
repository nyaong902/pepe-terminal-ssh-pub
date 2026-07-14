# v2.2.33

## PowerShell 승격 실행 결과를 로그에 남기도록 진단 강화

v2.2.31 → v2.2.32 테스트에서 예외 없이 `PowerShell Start-Process 로 설치 프로그램 승격 실행` 로그까지는 찍혔지만 그 이후 아무 것도 안 남고 설치 창도 안 떴습니다. 원인은 `elevatedRunWindows()`가 `stdio: 'ignore'`로 PowerShell의 출력을 전부 버리고 있어서, `Start-Process -Verb RunAs`가 실제로 성공했는지/UAC가 취소됐는지/에러가 났는지 알 방법이 없었던 것입니다.

- PowerShell 스크립트를 `try/catch`로 감싸서 `ELEVATE_OK` 또는 `ELEVATE_FAIL: <메시지>`를 표준출력에 남기도록 함
- `stdio`를 `pipe`로 바꿔 그 출력을 캡처해서 `update-debug.log`에 기록
- 앱 종료를 PowerShell 종료 이벤트가 로그를 남길 때까지(최대 4초) 기다렸다가 하도록 변경 (기존엔 무조건 1.5초 후 종료해서 로그가 끊길 수 있었음)

이번 버전으로 다시 테스트하면, 설치 창이 안 떠도 최소한 `elevatedRunWindows: powershell 종료(code=...) 출력: ...` 로그로 정확한 실패 원인(UAC 취소, 경로 문제, 기타 에러)을 알 수 있습니다.

---

## 산출물
- `PePe-Terminal-SSH-Setup-2.2.33.exe` (NSIS 설치본)
- `PePe-Terminal-SSH-2.2.33-portable.exe` (포터블)
