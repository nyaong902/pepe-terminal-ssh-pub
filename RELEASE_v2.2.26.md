# v2.2.26

## v2.2.25 빌드 실패 수정

v2.2.25도 NSIS 컴파일 에러로 빌드가 실패했습니다("warning 6000: unknown variable/constant mui.ComponentsPage.DescriptionText detected" — 경고가 에러로 처리되는 설정 때문에 빌드 중단). 원인은 `MUI_FUNCTION_DESCRIPTION_BEGIN`이 참조하는 `$mui.ComponentsPage.DescriptionText` 변수가 원래 `MUI_PAGE_COMPONENTS` 매크로가 삽입될 때(`customPageAfterChangeDir`, 더 뒤에서 실행) 선언되는데, 우리 파일은 그보다 먼저 top-level로 include돼서 참조 시점에 변수가 아직 없었던 것입니다.

`installer.nsh`에서 `MUI_FUNCTION_DESCRIPTION_BEGIN` 사용 전에 `MUI_COMPONENTSPAGE_INTERFACE`를 직접 호출해 변수만 미리 선언하도록 고쳤습니다(내부적으로 중복 선언 가드가 있어 나중에 `MUI_PAGE_COMPONENTS`가 다시 호출해도 안전). 기능은 v2.2.24/25와 동일합니다.

---

## 산출물
- `PePe-Terminal-SSH-Setup-2.2.26.exe` (NSIS 설치본)
- `PePe-Terminal-SSH-2.2.26-portable.exe` (포터블)
