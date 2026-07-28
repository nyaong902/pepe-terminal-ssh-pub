# v2.2.32

## 자동 업데이트 재현 테스트용 버전

기능 변경 없음. v2.2.31을 수동 설치한 PC에서 "v2.2.31 → v2.2.32" 자동 업데이트를 테스트하기 위한 버전입니다.

v2.2.31이 실제로 실행 중인 상태에서 처음으로 다음이 모두 적용된 채로 테스트됩니다:
- 옛 앱내 기능선택 모달 제거 (v2.2.30)
- sudo-prompt 제거, PowerShell `Start-Process -Verb RunAs` 직접 호출로 승격 실행 (v2.2.31)
- 차등 다운로드 비활성화 (v2.2.29)
- `autoInstallOnAppQuit=false` 중복 무음 설치 경쟁 수정 (이전 세션)

---

## 산출물
- `PePe-Terminal-SSH-Setup-2.2.32.exe` (NSIS 설치본)
- `PePe-Terminal-SSH-2.2.32-portable.exe` (포터블)
