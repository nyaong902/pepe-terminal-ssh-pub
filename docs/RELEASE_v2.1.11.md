# PePe Terminal(SSH) v2.1.11 릴리즈 노트

릴리즈일: 2026-06-25

---

## 🆕 주요 신규 기능

### 1. Antigravity CLI(agy) 에이전트 통합 — 5번째 AI

- AI 채팅 패널에 **Antigravity** 탭 추가 (Claude → Gemini → Antigravity → Codex → Custom LLM)
- agy.exe 와 pepe_ssh MCP 동적 연동 — SSH 세션에 바로 도구 호출
- **모델 5종 선택**: Gemini 3.5 Flash / 3.1 Pro / Claude Sonnet·Opus 4.6 / GPT-OSS 120B
- **자동 승인 체크박스**: `--dangerously-skip-permissions` + MCP 측 `PEPE_YOLO` 동기화. OFF 시 변경성 도구(ssh_write_file/ssh_exec) 호출 시 사용자 승인 모달
- **사용량 패널** (`/usage` TUI 캡처 파싱):
  - 그룹별(GEMINI / CLAUDE+GPT) Weekly·5-Hour 한도, 남은 % + 리셋 시간
  - 모델별 컨텍스트 윈도우 반영 (gemini 3.x=1M, sonnet=1M, opus=200k, gpt-oss=128k)
- **응답 잘림 우회**: agy 가 큰 응답 중간을 `<truncated N bytes>` 로 자르는 문제 → 분석 결과는 `analysis_report.md` 파일로 저장하도록 시스템 프롬프트 강제, 우리가 자동으로 읽어 inline 표시 후 파일 삭제 (디스크 누적 방지)
- **OAuth 토큰 자동 refresh** (cloudcode-pa.googleapis.com)
- **프롬프트 길이 한계 우회**: > 28,000 자면 앞쪽 컨텍스트 자동 truncate
- 응답 아이콘을 공식 Antigravity 로고(주황/파랑 'A')로 표시

### 2. PePe Messenger — 사내 P2P 메신저

- 별도 워크스페이스 탭으로 동작
- 동일 네트워크 사용자 자동 발견(UDP broadcast) + IP 범위 스캔 fallback
- 텍스트 메시지 + 로컬·원격(SSH) 파일 전송
- 한글 IME 입력 안정화, 미확인 메시지 뱃지, peer 메뉴
- **백그라운드 알림** + LAN 방화벽 자동 등록

### 3. 다단계 SSH Jump — 무한 확장

- 기존 단일 ProxyJump → **`jumps[]` 배열**로 일반화 → 3단·4단·N단 점프
- 추가 버튼으로 홉 무한 확장
- 셸 / 파일트리(전용 SFTP) / 전송 worker 4개 경로 모두 체인 적용
- 각 홉 비밀번호가 비면 직전 홉 `~/.ssh` 키 자동 재사용 (passwordless ProxyJump)

### 4. dbtool / Web Browser → SSH Jump 지원

- SqlTool 의 JDBC 연결과 BrowserPane(웹 브라우저)이 SSH 점프를 통해 원격 호스트의 DB / 웹서버에 직접 접속
- SOCKS5 프록시 + 로컬 포트 포워딩 자동 셋업
- 연결 끊김 시 자원(포워딩/프록시) 자동 정리

### 5. 파일 트리 Quick Share + Tailscale 원격 공유

- 원격 파일을 SSH 터널을 통해 임시 HTTP 링크로 공유
- Tailscale 기반 원격 공유 다이얼로그 (모바일 친화 UI, 5개 언어 지원)
- 웹 프로브 진단(URL/포트 reachability) 도구

### 6. Custom LLM (OpenAI 호환) 에이전트

- LM Studio / Ollama 등 OpenAI 호환 서버 직접 연결
- SSH MCP 도구 호출 루프 + tool result 캐시
- 코드 분석 시 모든 파일 강제 완독 + mermaid 다이어그램 가이드

### 7. AI 메뉴 5종 통일

- "AI 자동 생성"(SqlTool) / "분석 요청"(LogAnalyzer) / "AI 분석 요청"(FileEditor) 모든 드롭다운에 **Claude / Gemini / Antigravity / Codex / Custom LLM** 5종 옵션

### 8. Altibase 6 JDBC 드라이버 번들

- `resources/jdbc-drivers/bundled/altibase-6.jar` 기본 포함

---

## 🪟 워크스페이스 분리/병합 강화

탭을 새 창으로 끌어내거나 다시 본 창에 병합할 때, **모든 워크스페이스의 작업 상태가 보존**되도록 일반화된 메커니즘 적용.

| 워크스페이스 | 보존 항목 |
|---|---|
| **파일 전송** | 좌·우 패널의 모든 탭 / 활성 인덱스 / lazy SFTP 연결 / sibling 세션 스냅샷 |
| **메신저** | 선택된 peer / 입력 텍스트 / 설정 펼침 |
| **브라우저** | URL / 줌 / 프록시 세션 |
| **파일 비교** | 비교 모드(dir/file) / 좌·우 소스 / diff 결과 / 선택된 파일 / 좌·우 본문 / EOL·인코딩 |
| **로그 분석** | 소스 모드 / 세션 termId / 경로 / 파싱된 entries |
| **터미널** | xterm 스크린 버퍼 + 테마/폰트 스타일 |

구조: `Tab.workspaceState` + ref Map 으로 변경마다 보고, 분리 직전 serialize 에 함께 carry, 분리 창에서 그대로 복원.

---

## 🐛 주요 버그 수정

### X11 forwarding
- port 6000 점유 시 → X11 프로토콜 핸드셰이크로 **진짜 X 서버인지 검증**
- 무관한 프로세스가 점유 중이면 `:1`~`:32` 자동 탐색해 사용 가능한 display 로 bundled X 시작
- SSH X11 forwarder 와 shell screen 번호도 자동 매칭

### 빌드
- **SHA-1 dual-signing 우회**: electron-builder 가 기본적으로 SHA-1 + SHA-256 dual code-signing 시도 → 현대 Windows 는 SHA-1 거부로 SignerSign() 0x80096005 실패 → sign-with-retry 에서 SHA-1 pass skip
- **CSS 임포트 순서 고정**: `xterm.css → index.css → App.css` 순서로 main.tsx 에서 강제 → 빌드 모드 스타일 깨짐(PowerShell 줄무늬, 버튼 외곽 돌출, 텍스트 색 어긋남) 해결
- **빌드 출력 디렉토리 lock 회피**: timestamped tempOutputDir 사용

### UI
- **UI 라벨/탭/버튼 드래그 선택 차단**: chrome 영역은 user-select: none. 입력 필드/터미널/AI 채팅/메신저/파일 비교/Monaco 등 텍스트 영역에서만 selection 활성
- **터미널 선택 텍스트 외부 드래그 차단**: 선택/복사는 그대로, 외부 창/앱으로의 drag-drop만 차단

### 기타
- SSH 재연결 시 stale 상태 (포워딩/프록시 잔존) 정리
- Messenger 한글 IME 입력 클리어 / peer 연결 유지 / 미확인 뱃지
- 일괄 파일 전송: "전체 적용" 매 파일 재질의 / 성공해도 실패 표시 → 배치 workspaceId + fe:transfer-done await
- Plan 모드 ExitPlanMode 거절(is_error) / 턴 종료 시 승인 모달 자동 닫힘
- AI 파일 읽기/쓰기 base64-셸 exec → SFTP 직결 전환 (셸 rc 비용 제거)
- ssh_read_file / ssh_glob 단기 TTL 캐시 (4초)
- mermaid 다이어그램 `` ``` `` 펜스 누락 자동 감지/감싸기

---

## 🔁 마이그레이션 / 호환성

- **agy CLI 별도 설치 필요**: https://antigravity.google — 첫 실행 시 `agy` 명령으로 OAuth 로그인
- **기존 단일 ProxyJump 세션은 자동으로 `jumps[]` 배열로 마이그레이션**됩니다 (sessions.json)
- 메신저는 LAN 내 UDP broadcast 사용 — 방화벽이 차단하면 IP 범위 스캔으로 fallback

---

## 🙏 기여자

@HyungdukSeo (winrelease 브랜치: 다단계 jump / 메신저 / quick share / db·browser 라우팅 / Tailscale 원격 공유 통합)
