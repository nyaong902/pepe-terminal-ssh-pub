# 파일전송 탭 병합 (File Transfer Tab Merge)

## 배경

파일전송("📁 파일 전송") 워크스페이스는 탭마다 독립된 `FileExplorer` 컴포넌트 인스턴스로 동작한다.
지금까지는 파일전송 탭을 다른 창으로 분리했다가, 같은 창의 다른 파일전송 탭 위로 끌어다 놓아도
그냥 별개의 새 탭으로 추가될 뿐이었다 — 사용자가 기대한 "하나의 파일전송 탭 안에 여러 세션이
같이 보이는" 동작이 안 됐다.

**요청 사양** (사용자 확인):
- 파일전송 탭을 **다른 파일전송 탭 위에 정확히 얹는(drop) 액션**일 때만 → 병합(merge). 새 탭을
  만들지 않고, 끌어온 탭에 열려있던 원격 연결들을 대상 탭에 이어서 연다.
- 그 외의 위치(탭바 빈 공간 등)에 드롭 → 기존처럼 별개 탭 생성. 변경 없음.
- 같은 창 안에서의 드래그, 창이 서로 다른 경우(분리된 창 ↔ 다른 창) 모두 지원.

## 핵심 제약 — termId는 창을 못 넘는다

각 창(BrowserWindow)은 자신만의 렌더러 프로세스를 가진다. `FileExplorer`가 들고 있는 SFTP
연결의 `termId`/`connId`는 연결을 새로 열 때 생성되는 논리적 키일 뿐, "그 연결이 진짜 무엇에
연결되어 있었는지"(host/port/user/비밀번호)는 별도로 보존해두지 않으면 다른 창(다른
FileExplorer 인스턴스)에서 재구성할 방법이 없다. 그래서 병합은 "기존 연결을 그대로 옮기는 것"이
아니라 "같은 자격증명으로 새로 연결하는 것"으로 구현했다.

재연결에 필요한 자격증명 소스는 두 가지뿐이다:

1. **저장된 세션(sessionId)** — `sessions.json`에 저장된 세션이면 `sessionId`로
   `allSessionsList`에서 host/port/user/auth를 다시 찾아 연결할 수 있다.
2. **즉석 SFTP 연결(manualConn)** — "SFTP 연결" 다이얼로그나 빠른연결 바로 맺은, 세션에
   저장되지 않은 연결. 이번 작업 이전에는 이 정보가 어디에도 저장되지 않아 **영구 유실**됐다.
   이번에 `PanelSource.manualConn`(host/port/username/password)을 추가해서 창 분리/병합 시에도
   재연결 가능하게 만들었다(다른 저장 세션과 동일하게 평문 저장 — 이 앱의 `sessions.json`과 같은
   신뢰 수준).

세션ID도 manualConn도 없는 원격 소스(이 기능 이전에 저장된 구버전 즉석 연결 등)는 여전히
재연결할 방법이 없어 병합에서 조용히 제외되며, 제외된 게 있으면 알림 모달로 안내한다.

## 구현

### 1. `PanelSource.manualConn` 추가
[`FilePanel.tsx`](../src/components/FilePanel.tsx) — `manualConn?: { host, port, username, password? }`.
"SFTP 연결" 다이얼로그(`handleSftpConnect`)와 빠른연결 바(`fe-quick-sftp-connect` 핸들러)에서
연결 시 이 정보를 같이 채운다.

### 2. 재연결 로직 확장
[`feLayoutUtils.ts`](../src/utils/feLayoutUtils.ts)의 `reviveFeLayout` — `sessionId` 없이
`manualConn`만 있는 remote 소스도 `lazy-remote`로 강등해 복원 대상에 포함.

[`FileExplorer.tsx`](../src/components/FileExplorer.tsx)의 `realizeLazyRemote` — `sessionId`가
없고 `manualConn`만 있으면 자격증명 다이얼로그 없이 바로 `feSftpConnect`로 연결.

### 3. 병합 이벤트 — `fe-merge-remote-sources`
`FileExplorer.tsx`에 새 `window` 커스텀 이벤트 리스너 추가. `detail: { feTabId, items }` 를
받아 각 `item`(sessionId 또는 manualConn + 저장된 path)을 `mergeInRemoteSource()`로 순차
연결해서 그 인스턴스의 레이아웃에 새 leaf/탭으로 추가한다.

> **버그 수정 (React stale closure)**: 이 리스너의 `useEffect` 의존성 배열에 처음엔
> `[bootReady]`만 있었는데, 그러면 `bootReady`가 최초로 `true`가 된 시점(아직 `allSessionsList`
> 세션 목록 로딩 전이라 빈 배열)의 클로저를 영구히 물고 있어서, 나중에 세션 목록이 다 채워진
> 후에 병합해도 항상 "세션 정보를 찾을 수 없습니다"로 실패했다. `allSessionsList`를 의존성에
> 추가해서 해결.

### 4. 창 간(cross-window) 병합 감지
[`App.tsx`](../src/App.tsx)의 `onAdoptTab` 핸들러(다른 창에서 끌어온 탭을 받는 지점) 히트테스트에
분기 추가: 드래그해온 탭이 `type==='fileExplorer'`이고 드롭 지점이 정확히 기존 탭 아이템
(`.tab-item`, `data-tab-id`)위이며 그 탭도 `fileExplorer`면 → 새 탭으로 추가하는 대신
`fe-merge-remote-sources` 디스패치. 원본 탭이 detach 시 보존해뒀던 옛 SFTP 연결(`lazyConns`)은
더 이상 쓰이지 않으므로 여기서 정리(`feSftpDisconnect`)한다.

### 5. 같은 창 안 병합
[`TabBar.tsx`](../src/components/TabBar.tsx) 드래그 종료(`onUp`) 시, 드롭 대상 탭이 마침
`fileExplorer`이고 드래그한 탭도 `fileExplorer`면 재정렬(`onReorderTabs`) 대신
`onMergeFileExplorerTabs` 호출 → `App.tsx`의 `mergeFileExplorerTabs`가 병합 디스패치 후 원본
탭을 닫는다(`closeTab` — 언마운트 시 `FileExplorer` 자체의 정리 effect가 자신의 `lazyConns`를
정리).

### 6. `PanelSource`에 `sessionId` 누락 버그 수정
병합 로직을 실제로 테스트하며 발견: "파일전송" 버튼으로 세션 파일전송을 여는 **가장 흔한
경로**(`FileExplorer`의 최초 자동연결 effect, 그리고 세션 우클릭 → 파일전송의
`fe-sftp-connected` 이벤트)가 `PanelSource`에 `sessionId`를 아예 안 넣고 있었다. 그러면 병합
시 재연결할 실마리가 하나도 없어 그 세션의 파일전송 탭 전체가 소리 없이 사라지는 것처럼
보였다(`파일전송목록탭에도 없음`). 두 경로 모두 `sessionId`를 채우도록 수정.

## 알려진 한계

- 이 기능 적용 **이전**에 이미 저장된 즉석 SFTP 연결(`manualConn` 없는 구버전 상태)은 여전히
  병합 시 재연결 불가 — 자격증명 자체가 저장돼 있지 않았으므로 복구 불가능. 병합 시 몇 개가
  제외됐는지는 알림 모달로 안내된다.
- 세션에 저장되지 않은 SSH 터미널의 "빠른연결"(SFTP 아님, SSH 자체 quick-connect)로 연 파일전송은
  이번 범위에 포함하지 않음 — 별도 자격증명 캐리 메커니즘이 필요.

## 변경 파일

- `src/components/FilePanel.tsx` — `PanelSource.manualConn`/`viewRoot` 타입 추가, `loadDir`의
  lazy-remote 가드(버그 수정 #4)
- `src/utils/feLayoutUtils.ts` — `reviveFeLayout`에서 manualConn 기반 lazy-remote 복원,
  `viewRoot` 이관(버그 수정 #5)
- `src/components/FileExplorer.tsx` — manualConn 연결/재연결, `fe-merge-remote-sources` 리스너,
  `sessionId` 누락 수정 2건, lazyConns 언마운트 cleanup 버그 수정(버그 수정 #3)
- `src/App.tsx` — `extractMergeableFeSources`, `dispatchFeMerge`, `mergeFileExplorerTabs`,
  `onAdoptTab` 크로스윈도우 병합 분기
- `src/components/TabBar.tsx` — `onMergeFileExplorerTabs` prop, 드롭 시 병합/재정렬 분기
- `resources/i18n/{ko,en,fr,ar,zh-CN}/app.json` — `fileTransfer.mergeLostTitle`/`mergeLostDetail`
- `electron/sshBridge.ts` — `getCcViewRoot` public 전환, `setCcViewRoot` 추가 (버그 수정 #2)
- `electron/main.ts` — IPC `fe:get-view-root`/`fe:set-view-root` 핸들러 추가 (버그 수정 #2)
- `electron/preload.ts` — `feGetViewRoot`/`feSetViewRoot` 브리지 추가 (버그 수정 #2)
- `electron/sshBridge.ts` — `getSftp`/`handleSFTPListDir` 타임아웃 안전장치 추가 (버그 수정 #6)

## 검증 상태

- `npx tsc --noEmit -p .` 통과 (재확인, 2026-07-29).
- 사용자 실사용 테스트 중 stale closure 버그(§3) 발견 → 수정 완료.
- 2026-07-29 코드 리뷰: 병합 관련 5개 파일 diff 재확인 —
  - `mergeFileExplorerTabs`(같은 창)가 `closeTab`으로 원본 탭을 닫을 때 `__preserveFileExplorerConns`
    플래그가 서 있지 않아 언마운트 cleanup effect(`FileExplorer.tsx:176-184`)가 정상적으로
    `lazyConns`를 disconnect함 — 별도 정리 불필요, 의도대로 동작.
  - 크로스윈도우 경로는 `onAdoptTab`에서 `payload.tab.fileExplorerState.lazyConns`를 명시적으로
    disconnect — 원본 창이 분리 시 보존해둔 연결이라 언마운트 cleanup을 안 타므로 이 명시적 정리가
    맞음.
  - `eslint`: 변경 파일 전체에서 650개 에러가 나오지만 전부 프로젝트 기존 컨벤션(`any` 허용,
    `catch {}` 빈 블록)과 동일한 패턴이며 이번 변경으로 새로 늘어난 카테고리 없음. 새 useEffect의
    `exhaustive-deps` 경고(`mergeInRemoteSource`/`tabId` 누락)는 §3의 stale-closure 교훈과 반대로
    "매 렌더 재구독"을 피하려는 의도적 설계 — 다만 `allSessionsList`는 이미 넣었으므로 문제되는
    클로저는 없음.
- **버그 수정 #1 (2026-07-29, 사용자 실사용 테스트 중 재현)**: 병합 직후 파일 목록이 항상 빈
  채로 뜨는 문제. `mergeInRemoteSource`에서 SFTP 연결 성공 직후 `updatePanel(... source: real
  ...)`로 탭의 `source`를 먼저 반영했는데, `FilePanel`은 `source.termId` 변경을 감지하면 곧장
  `feListDir`을 호출한다 — 이 시점엔 아직 SFTP 서브시스템이 준비되지 않아 실패/빈 목록으로
  끝난다. 그 다음에 오는 `setLeafPath(leafId, item.path)`는 `path` 값이 탭 생성 시점에 이미
  `item.path`로 들어가 있어서 값이 안 바뀌는 no-op라 재로딩도 안 걸렸다(다른 기존 경로들,
  예: `restoredReconnectDoneRef` 재연결 로직도 동일 순서라 이론상 같은 레이스 가능성 있음 —
  이번엔 병합 경로만 수정, 필요시 별도 확인). [FileExplorer.tsx](../src/components/FileExplorer.tsx)의
  `mergeInRemoteSource`에서 `feHomeDir` 워밍업 폴링을 먼저 끝낸 뒤 `source`+`path`를 한 번에
  반영하도록 순서 변경. 추가로, 병합 배치 전체가 끝난 뒤 `setRefreshKey`를 한 번 더 호출해
  (파일 전송 완료 후 쓰는 것과 동일한 강제 새로고침 기제) 자동 재로딩이 안 걸리는 경우의
  안전망을 추가.
- **버그 수정 #2 (2026-07-29, 사용자 재현 — "일반 파일전송은 되는데 ClearCase 개발서버는 안 됨")**:
  ClearCase dynamic view 경로(`/vobs/...`)를 병합하면 목록이 영구히 비어 보이는 문제 — #1과는
  다른 근본 원인. `sshBridge.ts`의 `resolveCcPath`/`getCcViewRoot`는 `/vobs/...`를
  `/view/<tag>/vobs/...` 실경로로 바꾸기 위해 **살아있는 인터랙티브 셸의 PID**(cwd 폴링이
  추적한 `activeShellPids`/`shellPids`)에서 `CLEARCASE_ROOT` 환경변수를 읽는다. 병합으로 새로
  여는 연결은 `feSftpConnect`로만 맺는 **SFTP 전용 채널이라 인터랙티브 셸 자체가 없어서**, 뷰
  루트를 절대 스스로 알아낼 수 없다 — 자격증명이 맞아도 구조적으로 불가능한 케이스였다(단순
  타이밍 문제가 아님).
  - 해결: 원본(구) 연결은 아직 살아있는 동안(병합 대상 termId를 disconnect 하기 전) 그 뷰
    루트를 미리 읽어서 병합 항목에 실어 보내고, 새로 연결한 termId에 그대로 심어준다.
  - `sshBridge.ts` — `getCcViewRoot`를 `public`으로 변경, `setCcViewRoot(panelId, root)` 추가
    (캐시에 강제로 주입해 자동탐지를 건너뜀).
  - `main.ts` — IPC `fe:get-view-root`(읽기) / `fe:set-view-root`(쓰기) 핸들러 추가.
  - `preload.ts` — `feGetViewRoot`/`feSetViewRoot` 브리지 추가.
  - [App.tsx](../src/App.tsx) — `extractMergeableFeSources`를 async로 변경, 각 항목의 원본
    `src.termId`로 `feGetViewRoot`를 호출해 `viewRoot`를 항목에 포함. `dispatchFeMerge`도
    async로 바뀌었고, `mergeFileExplorerTabs`(같은 창)와 `onAdoptTab`의 크로스윈도우 병합
    분기 모두 **`await dispatchFeMerge(...)` 완료 후에** 원본 연결 정리(`closeTab`/
    `feSftpDisconnect`)를 하도록 순서를 맞춰, 뷰 루트를 읽기 전에 원본 연결이 끊기지 않게 함.
  - [FileExplorer.tsx](../src/components/FileExplorer.tsx) — `mergeInRemoteSource`가 연결
    성공 직후, `item.viewRoot`가 있으면 `feSetViewRoot(real.termId, item.viewRoot)`를 호출해
    새 연결에 이관.
  - 일반 서버(뷰 루트 없음)는 `viewRoot`가 빈 문자열이라 항목에서 아예 생략되므로 영향 없음.
  - `npx tsc --noEmit -p .` 재확인 통과. Electron 앱은 실 SFTP 서버(+ClearCase 개발서버) 연결이
    필요해 브라우저 자동화로 재현 불가 — 사용자 재검증 필요.
- **버그 수정 #3 (2026-07-29, 사용자 재현 — "일반 서버까지 합치니까 먼저 합친 ClearCase 연결이
  끊김")**: 병합 자체와 무관하게 **이 FileExplorer 인스턴스에서 lazy 연결을 2개 이상 열면 항상
  재현되는** 기존 버그. [FileExplorer.tsx](../src/components/FileExplorer.tsx)의 언마운트 정리
  effect가 `useEffect(() => {... return () => {for (cid of lazyConns) disconnect(cid)} ...},
  [lazyConns, bootReady])` 형태였는데, `lazyConns`를 deps에 넣으면 **배열이 바뀔 때마다**(=
  connId 하나를 추가할 때마다) React 가 "새 effect 적용 전 이전 effect의 cleanup"을 실행한다 —
  즉 실제 언마운트가 아닌데도 그 순간의(추가되기 전) `lazyConns` 전체를 disconnect 해버린다.
  두 번째 SFTP 연결을 여는 순간 첫 번째 연결이 통째로 끊기는 버그 — 콘솔 로그로 확인:
  `melvor`(172.16.49.6) 연결이 `saved as` 되자마자 바로 `rxwnne`(192.168.191.11, 먼저 합친
  ClearCase 서버)가 `primary end/close closed — clearing record`로 끊김. 병합 기능이 만든
  버그가 아니라, 병합으로 인해 한 인스턴스에 lazy 연결이 여러 개 쌓이는 상황이 처음으로 자주
  발생하면서 드러난 기존 잠재 버그.
  - 해결: `lazyConnsRef`(항상 최신 lazyConns를 가리키는 ref)를 추가하고, cleanup effect의
    deps를 `[bootReady]`로 고정 — 실제 언마운트 시에만 실행되며, 그 시점엔 ref로 최신 목록을
    읽어 정리한다.
  - `npx tsc --noEmit -p .` 재확인 통과.
- **버그 수정 #4 (2026-07-29, 사용자 재현 — "연결 ID가 없습니다 뜨고 1초 뒤 정상 로딩되는게 이상해")**:
  기능은 정상화됐지만, 탭 삽입 직후(아직 `lazy-remote`, 연결 전) `FilePanel`의 최초 `loadDir`
  호출이 `feListDir(source.mode='lazy-remote', dir, termId=undefined, ...)`를 그대로 실행해
  "연결 ID가 없습니다" 에러가 잠깐 화면에 떴다가, 실제 연결 완료 후 두 번째 `loadDir` 호출이
  성공하며 덮어써지는 시각적 깜빡임. [FilePanel.tsx](../src/components/FilePanel.tsx)의
  `loadDir`에 `source.mode === 'lazy-remote'`면 API 호출 자체를 건너뛰고 로딩 상태만 유지하는
  가드 추가 — 에러 없이 로딩 스피너만 보이다가 연결 완료 후 자연스럽게 목록으로 전환.
  `npx tsc --noEmit -p .` 재확인 통과.
- **버그 수정 #5 (2026-07-29, 사용자 재현 — "분리됐던 창2에서 다시 창1로 돌아오면 ClearCase 목록이
  다시 안 보여")**: 버그 수정 #2(뷰 루트 이관)는 "병합 시점의 원본 termId가 아직 살아있고 그
  ccViewRoot를 조회할 수 있는" 1회성 이관만 처리했다. 그런데 병합으로 재연결된 SFTP 전용 connId
  (예: `fe-lazy-...`)는 인터랙티브 터미널이 아니라서 `isTermConnected`가 항상 false를 반환한다
  → 이 탭을 **다른 창으로 분리**하면 `reviveFeLayout`이 "라이브 termId 아님"으로 보고
  `lazy-remote`로 강등하는데, 강등 시 `sessionId`/`manualConn`만 옮기고 `viewRoot`는 버렸다.
  분리된 창에서 `realizeLazyRemote`가 재연결하면 또 새 connId가 생기는데 이번엔 뷰 루트를 심어줄
  값 자체가 없어서(버려졌으므로) ClearCase 목록이 다시 실패 — 그 상태로 창1에 다시 병합해도
  원본 termId가 이미 이 새 connId로 바뀌어 있어 살릴 수 있는 값이 없었다.
  - 해결: `viewRoot`를 `PanelSource`의 정식 필드로 승격해 **연결마다 이어 전달**하도록 함(1회성
    이관이 아니라 소스 자체에 실려 다니는 값으로 변경).
    - [FilePanel.tsx](../src/components/FilePanel.tsx) — `PanelSource.viewRoot?: string` 추가.
    - [feLayoutUtils.ts](../src/utils/feLayoutUtils.ts) — `reviveFeLayout`의 lazy-remote 강등
      시 `viewRoot`도 함께 이관(기존엔 버려짐).
    - [FileExplorer.tsx](../src/components/FileExplorer.tsx) — `realizeLazyRemote`의 두 분기
      (manualConn / sessionId) 모두: 연결 성공 후 `src.viewRoot`가 있으면 `feSetViewRoot`로 새
      termId에 심고, 반환하는 `PanelSource`에도 그대로 실어서 다음 hop(재분리·재병합·재시작)에도
      이어지게 함. `mergeInRemoteSource`는 이제 `src` 생성 시 `viewRoot: item.viewRoot`만
      넣어주면 나머지는 `realizeLazyRemote`가 일괄 처리(중복 로직 제거).
    - [App.tsx](../src/App.tsx) — `extractMergeableFeSources`가 `src.viewRoot`가 이미 실려
      있으면(이전 hop에서 이관받은 값) 그걸 우선 사용하고, 없을 때만(첫 hop, 터미널 세션 재사용
      등) 살아있는 termId로 `feGetViewRoot` 조회하는 폴백으로 사용하도록 변경 — 원본 연결이
      이미 끊긴 뒤에도(창을 여러 번 오가도) 값이 유지된다.
  - `handleCredSubmit`(비밀번호 미저장 세션의 자격증명 재입력 경로)은 `viewRoot` 이관 대상에서
    아직 빠져있음 — 발생 빈도가 낮아 이번 범위 밖으로 남김, 필요시 추가.
  - `npx tsc --noEmit -p .` 재확인 통과.
- **버그 수정 #6 (2026-07-29, 사용자 재현 — "분리 → 원래 창 복귀 → 재분리를 반복하면 병합이 잘
  안 되고 'Error invoking remote method fe:list-dir: reply was never sent'가 뜸")**: 분리/병합을
  여러 번 오가면 `this.clients`(sshBridge.ts)에 레코드는 남아있지만 실제로는 죽은 소켓인
  `Client`가 생기는 경우가 있는 것으로 보인다 — 이 상태에서 `conn.sftp(cb)`/`sftp.readdir(cb)`
  콜백이 영영 안 불려서 `getSftp`/`handleSFTPListDir`의 Promise가 무한 대기하고, 렌더러에는
  원인을 알 수 없는 Electron 자체 에러("reply was never sent")로만 드러난다.
  [sshBridge.ts](../electron/sshBridge.ts)의 `getSftp`와 `handleSFTPListDir`에 15초 타임아웃
  안전장치를 추가 — 콜백이 안 오면 "연결이 끊어졌을 수 있습니다. 재연결해 주세요" 같은 명확한
  에러로 정리(reject)해서 무한 대기 대신 최소한 재시도 가능한 상태로 만든다. "가끔 병합이 잘
  안 된다"는 증상도 이 무한 대기와 같은 원인일 가능성이 있어 함께 완화될 것으로 예상 — 다만
  드롭 지점 히트테스트(`elementFromPoint` + `.tab-item` 판정) 자체의 정밀도 이슈일 가능성도
  있어 완전히 배제하지는 않음. 근본 원인(왜 `this.clients`에 죽은 레코드가 남는지)은 아직 못
  찾음 — 재현 시 추가 조사 필요.
  `npx tsc --noEmit -p .` 재확인 통과.

## UX 변경 (2026-07-29) — 정밀 드롭 요구 제거

사용자 피드백: "정확히 그 파일전송 탭 위에 올려야 합쳐지는 게 가끔 안 먹힌다. 어차피 창마다
파일전송 탭은 하나씩만 가져가는 걸로 하고, 탭바 위에만 올려놓으면 합쳐지게 해달라."

기존엔 드래그한 파일전송 탭을 **다른 파일전송 탭 아이템 위에 정확히(`.tab-item` 히트) 올려야만**
병합이 트리거됐다. 이제는 "각 창은 파일전송 탭을 최대 1개만 유지한다"는 전제로, **탭바 위 어디든**
놓으면 그 창의 (유일한) 파일전송 탭과 병합되도록 완화했다. 특정 탭 위에 정확히 놓였으면 그 탭을
우선 대상으로 삼고, 아니면 그 창에서 찾은 첫 파일전송 탭을 대상으로 한다(창에 파일전송 탭이
아예 없으면 기존처럼 새 탭 생성으로 폴백).

- [App.tsx](../src/App.tsx) `onAdoptTab`(크로스윈도우) — `overTabId` 존재를 요구하던 조건을
  `onChrome`(탭바 영역 전체)으로 완화. 대상 탭은 `overTabId`가 fileExplorer면 그걸, 아니면
  `tabsRef.current`에서 찾은 첫 fileExplorer 탭.
- [TabBar.tsx](../src/components/TabBar.tsx) 같은 창 드래그(`onUp`) — `overId`가 다른
  fileExplorer 탭인지 확인하던 조건을, 드롭 지점이 `.tab-bar` 안이기만 하면(정확한 탭 아이템
  불문) 이 창의 다른 fileExplorer 탭을 찾아 병합하도록 변경.
- "각 창당 파일전송 탭 1개"는 아직 강제(다른 경로로 2번째 파일전송 탭을 여는 것 자체를 막는
  로직)는 아님 — 드래그 병합의 드롭 판정만 완화한 것. 한 창에 파일전송 탭이 2개 이상 있는
  상태에서 탭바 빈 공간에 드롭하면 "첫 번째로 찾은" 탭이 대상이 된다.
- `npx tsc --noEmit -p .` 재확인 통과.

## 버그 수정 #7 — stale ClearCase 뷰 루트로 인한 무한 블록 (2026-07-29)

사용자 재현: "창2에서 합쳐진 후 → 다시 창1로 파일전송 탭 전체를 옮기고 → 파일전송 탭 전체를 닫고
→ 다시 파일전송을 창3으로 분리하면" `/vobs/REL/SSW_SKBC4_70A: Error: SFTP 목록 조회 응답 없음`.

버그 수정 #6의 타임아웃이 실제 블록을 잡아낸 케이스. 원인은 **stale 뷰 루트**로 판단된다:
버그 수정 #5에서 `viewRoot`를 `PanelSource`에 실어 연결마다 이어가게 만들었는데, 이 값은
레이아웃과 함께 직렬화되므로 탭을 닫았다 다시 열어도 살아남는다. 그런데 ClearCase dynamic view는
`/view/<tag>/...` 경로가 **그 뷰가 여전히 mount 되어 있을 때만** 유효하고, mount 가 풀린 뒤에는
MVFS lookup 이 에러가 아니라 그냥 **블록**된다 — 그래서 이관받은 뷰 루트가 한 번 stale 해지면 그
패널은 영구히 멈춘 것처럼 보였다.

- [sshBridge.ts](../electron/sshBridge.ts) `handleSFTPListDir` — readdir 를 `_sftpReaddirOnce`
  헬퍼로 분리하고 self-healing 폴백을 추가: 뷰 루트로 변환된 경로는 **짧게(8초)** 끊고, 실패하면
  ① 캐시된 `ccViewRoots` 항목을 버려 다음 호출이 다시 탐지하게 하고 ② 변환 전 원래 `/vobs/...`
  경로로 한 번 재시도한다(뷰 안에서 SFTP 가 열린 경우엔 변환 없이도 접근되므로 이쪽이 성공할 수
  있음). 변환이 없는 일반 경로는 기존대로 15초.
- `handleSFTPDisconnect` — `ccViewRoots`/`activeShellPids` 정리를 early return **앞으로** 이동.
  기존엔 `clients` 레코드가 이미 `cleanupOnClose` 로 지워진 경우 early return 에 걸려 죽은
  connId 의 뷰 루트가 계속 쌓였다.
- `npx tsc --noEmit -p .` 재확인 통과. 실 ClearCase 서버 + 다중 창 드래그가 필요해 자동 검증
  불가 — 사용자 재검증 필요.

## UI 수정 — 창이 좁아질 때 탭바에 가로 스크롤바 노출 (2026-07-29)

사용자 재현: 창 폭을 줄여 탭이 넘치면 탭바 아래에 굵은 가로 스크롤바가 생김.

`.tab-bar-scroll` 은 이미 `scrollbar-width: none` + `::-webkit-scrollbar { display: none }` 로
스크롤바를 숨기고 있었는데, [index.css](../src/index.css)의 전역
`::-webkit-scrollbar-button { display: block; ... }` 규칙이 그대로 살아있어서 버튼 박스가
스크롤바를 강제로 렌더시키고 있었다. [App.css](../src/App.css)에서 `.tab-bar-scroll` 의
`::-webkit-scrollbar-button`/`-track`/`-thumb`/`-corner` 까지 모두 `display: none` 으로 눌러
해결(탭바는 휠/드래그로만 스크롤).

**후속 (2026-07-29)** — 같은 원인이 파일전송 패널 **내부** 탭 스트립(`.fe-panel-tabs`)에도 있었다.
`::-webkit-scrollbar { height: 4px }` 로 얇게 지정해뒀지만 전역 버튼 규칙이 16px 화살표 버튼을
붙여 굵은 바가 됐다. 사용자 요청("워크스페이스 탭바처럼 되면 좋을 듯")대로 스크롤바를 없애고
워크스페이스 탭바와 동일한 `‹ ›` 스크롤 버튼 방식으로 교체했다:

- DOM 재구성 ([FileExplorer.tsx](../src/components/FileExplorer.tsx) `renderPanelTabs`) — 기존엔
  `+`/분할/닫기 버튼까지 전부 스크롤 컨테이너(`.fe-panel-tabs`) 안에 있어서 **탭이 많아지면 그
  버튼들도 같이 밀려 사라졌다**. 이제 탭 목록만 새 내부 컨테이너 `.fe-panel-tabs-scroll` 에서
  스크롤하고, 버튼들은 바깥 `.fe-panel-tabs` 에 고정으로 남는다.
- 넘칠 때만 `‹ ›` 버튼 노출 — leaf 마다 스트립이 하나씩이므로 `leafId` 로 키를 잡아
  `feTabScrollEls`(ref Map) + `feTabsOverflow`(state) 로 관리. 공용 `ResizeObserver` 하나로
  컨테이너 크기 변화를 감지하고, 탭 추가/삭제/라벨변경은 컨테이너 크기를 안 바꿔서 옵저버가
  안 뜨므로 `layout` 변경 시에도 다시 측정한다.
- 세로 휠 → 가로 스크롤 `onWheel` 핸들러도 함께 추가(메인 탭바와 동일).
- [App.css](../src/App.css) — `.fe-panel-tabs-scroll`(스크롤바 전 파트 `display:none`),
  `.fe-panel-tab-scroll-group`/`.fe-panel-tab-scroll-btn`(18px 소형, 메인 탭바 `.tab-scroll-btn`
  스타일 축소판) 추가. 탭이 줄지 않고 넘치도록 `.fe-panel-tabs-scroll > .fe-panel-tab
  { flex-shrink: 0 }`, 우측 고정 버튼들엔 `flex-shrink: 0`.
- `npx tsc --noEmit -p .` + `npx vite build` 통과.

## 버그 수정 #10 — 창 분리/복원마다 전부 재연결 + 파일목록 재로딩 (2026-07-29)

사용자 재현: "창분리 / 복원할 때마다 파일전송목록이 재로딩이 되버려."

`reviveFeLayout` 은 `isLiveTermId(termId)` 로 "지금도 살아있는 연결"이면 `remote` 를 그대로 유지하고,
아니면 `lazy-remote` 로 강등해 재연결하게 되어 있다(의도는 애초에 문서화돼 있었다 — 코드 주석:
"안 그러면 살아있는 연결인데도 매번 재연결 + 파일목록 재로딩이 발생한다"). 문제는 FileExplorer 가
그 자리에 `isTermConnected`(TerminalPanel) 를 넘긴다는 것 — 파일전송이 직접 맺는 **SFTP 전용 연결
(`fe-lazy-…` / `sftp-…`)은 인터랙티브 터미널이 아니라서 항상 false** 다. 그래서 창 분리 시
`__preserveFileExplorerConns` 로 연결을 살려뒀는데도 전부 강등 → 재연결 → 목록 재로딩이 됐다.

- [feLayoutUtils.ts](../src/utils/feLayoutUtils.ts) — 모듈 레벨 생존 연결 레지스트리 추가
  (`setLiveBackendConnIds` / `isLiveBackendConnId`). main 이 authoritative 이므로 누적이 아니라 대체.
- [App.tsx](../src/App.tsx) `seedReattach` — 기존 IPC `fe:connected-sessions`
  (= `SSHBridge.getConnectedPanelIds()`, 이미 존재했지만 렌더러에서 미사용이었다) 로 백엔드의 실제
  생존 목록을 받아 레지스트리에 심는다. 호출부 두 곳(분리창 init, `onAdoptTab`)이 모두
  `await seedReattach(...)` 후에 `setTabs(...)` 를 하므로 FileExplorer 마운트보다 먼저 채워진다.
- [FileExplorer.tsx](../src/components/FileExplorer.tsx) — `reviveFeLayout` 에 넘기는 판정을
  `isTermConnected(tid) || isLiveBackendConnId(tid)` 로 확장.
- 앱 재시작 시엔 `seedReattach` 가 안 돌아 레지스트리가 비어 있으므로 기존처럼 정상 강등 →
  재연결된다(백엔드 연결도 실제로 죽어있으니 그게 맞는 동작).
- 살아남은 `remote` 소스는 `viewRoot` 등 필드가 그대로 유지되고, 캐시된 목록(`entries` →
  `initialFiles`)이 즉시 그려지므로 사용자에겐 재로딩이 보이지 않는다(백그라운드 새로고침 1회만).
- `npx tsc --noEmit -p .` + `npx vite build` 통과.

## 버그 수정 #8 — 다른 세션의 경로가 엉뚱한 탭에 꽂히던 문제 (2026-07-29)

사용자 재현: 병합 후 ClearCase 개발서버(dev@192.168.191.11) 탭에 `/root: Error: Permission denied`.
사용자 확인: "저 /root 는 **다른 세션**의 파일전송인데 clearcase 개발서버쪽에 오류로 떴어."

`setLeafPath(leafId, path)` / `setLeafSource(leafId, src)` 는 **그 leaf 의 활성 탭**(`p.activeIdx`)에
쓴다. 병합 기능 때문에 이제 한 leaf 에 여러 세션 탭이 모이는데, 복원/재연결 코드가 이 헬퍼를
쓰고 있어서 "지금 복원 중인 탭"이 아니라 "활성 탭"에 결과가 써졌다 — A세션 탭에 B세션의 저장
경로(`/root`)가 꽂혀 Permission denied 가 났다.

- [FileExplorer.tsx](../src/components/FileExplorer.tsx) 복원 재연결 effect
  (`restoredReconnectDoneRef`) — `source` 는 인덱스로, `path` 는 `setLeafPath`(활성 탭)로 쓰던 걸
  둘 다 `t.id === tab.id` 로 지정해 한 번에 쓰도록 수정. 겸사겸사 버그 수정 #1 과 같은 이유로
  워밍업을 먼저 끝낸 뒤 `source`+`path` 를 함께 반영하게 순서도 정리.
- `realizeLazyRemote(src, leafId, forTabId?)` — 자격증명 다이얼로그로 넘어갈 때 대상 탭 id 를
  `credPrompt` 에 실어 보내도록 파라미터 추가. `handleCredSubmit` 은 `credTabId` 가 있으면 그 탭만
  갱신한다(없으면 기존 활성 탭 동작 유지). 병합/복원 호출부 두 곳에서 `tab.id` 를 넘긴다.
  — 이전 문서에서 "발생 빈도가 낮아 범위 밖"으로 남겨뒀던 항목인데, 병합으로 한 leaf 에 여러 탭이
  모이는 게 일반화되면서 같은 종류의 사고가 날 수 있어 이번에 함께 처리.

## 버그 수정 #9 — 병합할 게 없으면 탭이 그냥 사라지던 문제 (2026-07-29)

`dispatchFeMerge` 가 항상 void 였고, 호출부는 결과와 무관하게 원본을 정리했다:
크로스윈도우는 무조건 `return`(새 탭 복원 폴백을 건너뜀), 같은 창은 무조건 `closeTab(fromId)`.
그래서 `extractMergeableFeSources` 가 재연결 가능한 원격 소스를 하나도 못 찾으면(로컬 패널만
있거나 `fileExplorerState` 가 유실된 경우) **끌어온 탭이 어디에도 안 생기고 그냥 사라졌다** —
"잘 안 합쳐진다"로 체감되던 원인 중 하나.

- `dispatchFeMerge` 가 `Promise<boolean>`(dispatch 했는지) 을 반환.
- 크로스윈도우(`onAdoptTab`) — `merged` 가 false 면 `return` 하지 않고 아래 일반 경로로 흘려보내
  새 탭으로 복원.
- 같은 창(`mergeFileExplorerTabs`) — `merged` 가 false 면 `closeTab` 하지 않고 원본 탭 유지.
- 진단 로그 추가: `[fe-merge] dispatch { items, droppedCount, hasLayout }`,
  `[tab-drop] hit-test { ... }`.

## 후속 수정 — 드롭 위치 판정 완전 제거 (2026-07-29)

사용자 재현: "파일전송탭과 **멀찌감치** 끌어다놓으면 잘 안 합쳐져. 아무곳에 놓아도 되어야 하는데."

앞선 완화는 여전히 "탭바 영역인지"를 따졌는데(`.tab-bar-row` 등 셀렉터 + y좌표 40px), 탭에서 멀리
떨어진 지점이나 사이드 레일 위 등에서는 판정이 빗나갔다. 창마다 파일전송 탭을 하나만 유지한다는
전제이므로 **위치 판정을 아예 없앴다**:

- [TabBar.tsx](../src/components/TabBar.tsx) 같은 창 — 드래그한 탭이 파일전송 탭이고 이 창에 다른
  파일전송 탭이 있으면, 창 안 어디에 놓든 병합. 단 **다른 워크스페이스 탭 아이템 위에 정확히**
  올린 경우엔 순서 재정렬 의도로 보고 양보(`wantsReorder`).
- [App.tsx](../src/App.tsx) 크로스윈도우 — `onChrome` 조건 제거. 받는 창에 파일전송 탭이 있으면
  드롭 위치 무관하게 병합(특정 탭 위에 올렸으면 그 탭 우선).
- `npx tsc --noEmit -p .` + `npx vite build` 통과.

## 이전 후속 수정 — "탭바 아무곳" 판정이 좁았던 문제 (2026-07-29)

사용자 재현: "워크스페이스 있는 탭바 아무곳에 놔도 잘 안 합쳐져."

같은 창 드래그(TabBar.tsx `onUp`)에서 병합 조건을 `el?.closest('.tab-bar')` 로 판정했는데,
`.tab-bar` 는 **탭 아이템들만 감싸는 좁은 박스**다 — 탭 오른쪽의 넓은 빈 공간은 형제 요소인
`.titlebar-drag-area` 라서 거기 놓으면 병합이 안 걸렸다("아무곳에 놔도 된다"는 의도와 불일치).
[TabBar.tsx](../src/components/TabBar.tsx) 의 판정을 App.tsx `onAdoptTab` 과 같은 셀렉터 목록
(`.tab-bar-row, .tab-bar, .titlebar-drag-area, .titlebar, .menu-bar`) + y좌표 40px 폴백으로
교체. 크로스윈도우 경로는 이미 같은 방식(`onChrome`)이라 수정 불필요.
