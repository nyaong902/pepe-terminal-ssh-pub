# v2.2.30

## "재시작하여 설치" 클릭 시 아무 반응 없던 문제 수정 — 옛 앱내 기능선택 모달 제거

v2.2.28 수동 설치 후 "재시작하여 설치"를 누르면 v2.2.21에서 만든 **앱 자체 기능 선택 모달**이 떴고, 거기서 "설치 후 재시작"을 눌러도 아무 반응이 없었습니다.

이 모달은 v2.2.21 당시 "자동 업데이트 중엔 설치 프로그램의 인터랙티브 페이지를 못 띄운다"는 가설 하에 만든 대체 UX였는데, v2.2.24부터 NSIS 자체 컴포넌트 선택 페이지(`MUI_PAGE_COMPONENTS`)로 전환하면서 더 이상 필요 없어졌음에도 코드가 제거되지 않고 남아있었습니다. 게다가 제출 버튼 핸들러가 에러를 전부 `catch {}`로 삼키고 있어서, 무언가 실패해도 사용자에게는 그냥 "아무 반응 없음"으로만 보였습니다.

- `src/App.tsx`: 옛 기능 선택 모달과 관련 상태(`featureSelectModal`) 완전 제거. "재시작하여 설치" 버튼은 이제 바로 `updaterQuitAndInstall()`을 호출합니다. 기능 선택은 이후 뜨는 NSIS 설치 프로그램의 컴포넌트 페이지에서 합니다.
- `electron/main.ts`, `electron/preload.ts`: 이 모달 전용이었던 `features:get-selection`/`features:set-selection` IPC와 관련 레지스트리 read/write 함수 제거 (NSIS 쪽 `customInit`/`customInstall`이 직접 레지스트리를 읽고 쓰는 경로는 그대로 유지 — 영향 없음).

---

## 산출물
- `PePe-Terminal-SSH-Setup-2.2.30.exe` (NSIS 설치본)
- `PePe-Terminal-SSH-2.2.30-portable.exe` (포터블)
