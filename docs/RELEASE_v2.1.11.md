# PePe Terminal(SSH) v2.1.11 릴리즈 노트

릴리즈일: 2026-06-25

---

## 🆕 주요 신규 기능

### 1. Antigravity CLI (agy) 에이전트 통합 — 5번째 AI

- AI 채팅 패널에 **Antigravity** 탭 추가 (Claude → Gemini → Antigravity → Codex → Custom LLM)
- agy.exe 와 pepe_ssh MCP 동적 연동 — SSH 세션에 바로 도구 호출
- **모델 5종 선택**: Gemini 3.5 Flash / 3.1 Pro / Claude Sonnet·Opus 4.6 / GPT-OSS 120B
- **자동 승인 체크박스**: 켜면 `--dangerously-skip-permissions`, 끄면 변경성 도구(ssh_write_file/ssh_exec) 호출 시 사용자 승인 모달
- **사용량 패널** (`/usage` TUI 캡처 파싱):
  - 그룹별(GEMINI / CLAUDE+GPT) Weekly·5-Hour 한도, 남은 % + 리셋 시간
  - 모델별 컨텍스트 윈도우 반영 (gemini 3.x=1M, sonnet=1M, opus=200k, gpt-oss=128k)
- **응답 잘림 우회**: agy 가 큰 응답 중간을 `<truncated N bytes>` 로 자르는 문제 →
  - 분석 결과는 `analysis_report.md` 파일로 저장하도록 시스템 프롬프트 강제
  - 우리가 자동으로 읽어 inline 표시 후 파일 삭제 (디스크 누적 방지)
- **OAuth 토큰 자동 refresh** (cloudcode-pa.googleapis.com)
- **프롬프트 길이 한계 우회**: > 28,000 자면 앞쪽 컨텍스트 자동 truncate (Windows CreateProcess 32K 한계)
- 응답 아이콘을 공식 Antigravity 로고(주황/파랑 'A')로 표시

### 2. PePe Messenger — 사내 P2P 메신저

- 별도 워크스페이스 탭으로 동작
- 동일 네트워크 사용자 자동 발견(broadcast) + IP 범위 스캔
- 텍스트 메시지 + 로컬·원격(SSH) 파일 전송
- 한글 IME 안정화, 미확인 메시지 뱃지, peer 메뉴

### 3. 다단계 SSH Jump — 무한 확장

- 기존 단일 ProxyJump → **jumps[] 배열**로 일반화 → 3단·4단·N단 점프
- 추가 버튼으로 홉 무한 확장
- 셸 / 파일트리(전용 SFTP) / 전송 worker 4개 경로 모두 체인 적용
- 각 홉 비밀번호가 비면 직전 홉 `~/.ssh` 키 자동 재사용 (passwordless ProxyJump)

### 4. dbtool / Web Browser → SSH Jump 지원

- SqlTool 의 JDBC 연결과 BrowserPane(웹 브라우저)이 SSH 점프를 통해 원격 호스트의 DB / 웹서버에 직접 접속
- SOCKS5 프록시 + 로컬 포트 포워딩 자동 셋업
- 연결 끊김 시 자원(포워딩/프록시) 정리 + 'closed' 이벤트 emit

### 5. 파일 트리 Quick Share 버튼

- 원격 파일을 SSH 터널을 통해 임시 HTTP 링크로 공유
- 웹 프로브 진단(URL/포트 reachability) 도구 추가

### 6. Custom LLM (OpenAI 호환) 에이전트 — v2.1.11 초반

- LM Studio / Ollama 등 OpenAI 호환 서버 직접 연결
- SSH MCP 도구 호출 루프 + tool result 캐시
- 코드 분석 시 모든 파일 강제 완독 + mermaid 다이어그램 가이드

### 7. SQL Tool / LogAnalyzer / FileEditor AI 메뉴 확장

- "AI 자동 생성", "분석 요청", "AI 분석 요청" 드롭다운에 **Antigravity + Custom LLM** 추가
- Claude / Gemini / Antigravity / Codex / Custom LLM 5종 선택 가능

---

## 🐛 주요 버그 수정

- SSH 재연결 시 stale 상태 (포워딩/프록시가 남던 문제)
- Messenger 미확인 뱃지·peer 연결 유지·한글 IME 입력 클리어 문제
- 일괄 파일 전송: "전체 적용"이 매 파일마다 다시 묻던 문제 → 배치 단위 workspaceId
- 일괄 파일 전송: 성공해도 실패 표시되던 문제 → fe:transfer-done 이벤트 await
- 연결 끊김 시 Enter=즉시 재연결 / 무입력 10초=세션 탭 닫기로 정리
- Plan 모드에서 SDK가 ExitPlanMode 거절(is_error) / 턴 종료 시 승인 모달 자동 닫힘
- AI 파일 읽기/쓰기를 base64-셸 exec → SFTP 직결로 전환 (셸 rc 비용 제거)
- ssh_read_file / ssh_glob 단기 TTL 캐시 추가 (TTL 4초)
- mermaid 다이어그램에 모델이 ``` 펜스 빠뜨려도 자동 감지/감싸기

---

## 📦 기타

- Altibase 6 JDBC 드라이버 번들에 추가
- ripgrep 번들 (resources/rg)
- 누락된 빌드 스크립트 (`download-ripgrep.js`, `run-electron-builder.js`) 복구

---

## 🔁 마이그레이션 / 호환성

- **agy CLI 별도 설치 필요**: https://antigravity.google — 첫 실행 시 `agy` 명령으로 OAuth 로그인
- **기존 단일 ProxyJump 세션은 자동으로 jumps[] 배열로 마이그레이션**됩니다 (sessions.json)
- 메신저는 LAN 내 UDP broadcast 사용 — 방화벽이 차단하면 IP 범위 스캔으로 fallback

---

## 🙏 기여자

@HyungdukSeo (winrelease 브랜치: 다단계 jump / 메신저 / quick share / db·browser 라우팅 통합)
