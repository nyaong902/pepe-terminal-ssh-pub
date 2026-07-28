# v2.2.25

## v2.2.24 빌드 실패 수정

v2.2.24는 NSIS 컴파일 에러로 빌드가 실패했습니다("macro named MUI_FUNCTION_DESCRIPTION_BEGIN not found") — `MUI2.nsh`가 include되기 전에 그 매크로를 쓰려고 해서 발생한 문제였습니다. `installer.nsh`에서 직접 `MUI2.nsh`를 include하도록 고쳤습니다. 기능은 v2.2.24와 동일합니다 (기능 선택을 NSIS 내장 컴포넌트 페이지로 전환, 자동 업데이트 중에도 표시).

---

## 산출물
- `PePe-Terminal-SSH-Setup-2.2.25.exe` (NSIS 설치본)
- `PePe-Terminal-SSH-2.2.25-portable.exe` (포터블)
