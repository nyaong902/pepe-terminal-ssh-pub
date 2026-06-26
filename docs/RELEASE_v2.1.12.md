# PePe Terminal(SSH) v2.1.12 릴리즈 노트

릴리즈일: 2026-06-26

---

## 🎨 주요 신규 기능

### 1. 윈도우 테마 — 앱 전체 색감 일괄 적용

- 워크스페이스/탭바/패널/사이드바/상태바를 **하나의 팔레트** 로 묶어 통일감 있는 톤 전환.
- 메뉴에서 즉시 변경 가능, 분리된 창에도 같은 테마 자동 동기화.
- 터미널 테마와 별도 — 텍스트 가독성은 그대로 유지하면서 chrome 색만 변경.

### 2. 메신저 팝업 리워크 + 백그라운드 알림

- 새 메시지/peer 발견을 별도 팝업으로 표시 — 워크스페이스 가려져도 화면 모서리에 떠서 보임.
- peer 상태 라벨 (online / typing / away) + 미확인 메시지 뱃지 카운터.
- **인스톨러 단계에서 LAN 아웃바운드 방화벽 규칙 자동 등록** → UDP broadcast 발견이 첫 실행부터 동작.

### 3. i18n 5개 언어 전체 정비

- ar / en / fr / ko / zh-CN — 누락 키 일괄 보강 + 사용하지 않는 28개 stale 키 정리.
- `broadcast.json` → `app.json` / `messenger.json` / `sqlTool.json` / `transferLog.json` 으로 네임스페이스 분할.
- SqlTool 워크스페이스의 한국어 외 언어도 풀 번역.

---

## 🪟 멀티 윈도우 분리/복원 — 전면 안정화

### SqlTool — 분리/복원 시 JDBC 재연결 회피

- `JdbcBackend.connectionId` 를 `sql-${sessionId}` 로 안정화. 어느 창에서 인스턴스가 다시 만들어져도 동일 id.
- Java sidecar 에 **`isConnected` RPC** 추가 — 살아있는 connection 인지 확인 후 그대로 인계.
- 분리 시 unmount 핸들러가 `__preserveSqlConns` 플래그를 보고 disconnect 를 skip → 새 창은 SSH 터널/드라이버 로딩까지 전부 건너뛰고 즉시 adopt.
- 콘솔에 `[SqlTool] adopted existing JDBC connection sql-...` 로그 — 재연결 없이 인계 성공 표시.
- 그리드 SELECT 결과 / 핀 고정 스냅샷 / 활성 result 탭도 sqlStateCache 에 mirror → 분리 후에도 그대로 보임.

### 메인 창 닫기와 분리 창 — 진짜로 독립적으로

- 기존: 메인 창 X 클릭 시 `BrowserWindow.getAllWindows()` 전체를 destroy + taskkill /T /F 로 프로세스 트리를 죽여 **분리 창까지 같이 종료**.
- 신규: 분리 창이 살아있으면 그 중 하나를 새 mainWindow 로 **승격** — IPC 라우팅/이벤트 송신이 그대로 동작해 분리 창이 freeze 되지 않음.
- 다단계 분리/복원 후 마지막 창 닫을 때 앱이 종료 안 되던 문제 — createDetached `closed` 핸들러의 `win.webContents.id` 접근 throw 가 `onMainWindowClosed` 호출을 차단하던 버그를 수정.
- 마지막 창 닫힘 시 setTimeout/setImmediate/taskkill 다중 안전망으로 강제 종료 보장.

### 탭 드롭 동작 정리

- 수신 측 cursor 위치를 main 의 `screen.getCursorScreenPoint()` 로 직접 받음 — DPI/멀티모니터 환경에서도 좌표 정확.
- **탭바/타이틀바 위 드롭** → kind 무관, 가져온 모든 세션을 활성 탭의 첫 leaf 에 미니탭으로 병합.
- **패널 미니탭바(`.panel-header`/`.panel-session-tabs`) 드롭** → 그 패널에 미니탭 병합 (zone 기반 split 분기 우회).
- **패널 본문 드롭 (kind='session')** → 가장자리=split / 중앙=병합 (zone threshold 0.2).
- 최소화/숨김 분리 창은 hit-test 대상에서 제외 — 보이지 않는 창에 의도치 않게 흡수되던 문제 해결.
- 미니탭 이동 시 옮긴 탭이 자동 active 상태 + 대상 패널 selected 상태로 표시.

---

## 🐛 기타 수정

- **AI 채팅/메신저 자동 스크롤**: 워크스페이스 다시 띄울 때 항상 맨 아래로 스크롤되어 최신 메시지 즉시 보임.
- **브라우저 SSH 점프 라우팅**: 누락됐던 SOCKS/web IPC 핸들러 추가 — 점프 호스트 너머의 웹 접근 정상화.
- **X11 forwarding hint**: 원격 서버에 `xauth` 가 없을 때(`No xauth program; cannot forward X11`) 터미널에 노란색으로 OS별 설치 명령(`yum install xorg-x11-xauth` 등) 안내.

---

## 🔁 마이그레이션 / 호환성

- 기존 SqlTool 세션은 자동으로 새 connectionId 체계로 동작 — 추가 작업 불필요.
- i18n 네임스페이스 분할은 내부 변경, 사용자 영향 없음.
- 메신저 방화벽 규칙은 인스톨러가 자동 등록 — 수동 추가했던 경우 중복은 무해.
