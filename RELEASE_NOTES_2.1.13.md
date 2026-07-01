# v2.1.13

## MicroSIP 워크스페이스

### 콜로그 패널 (전화 탭 하단)
- 폴드/언폴드 가능한 콜로그 패널 신설 — 단말 카드 영역과 분리되어 단말이 많아져도 가려지지 않음
- 드래그 핸들로 패널 크기 조절 (sessionStorage 저장)
- **목록 / 시퀀스** 뷰 토글
- **시퀀스 뷰**: 단말별 lifeline + 원격 서버 (IP·호스트명) 컬럼으로 SIP 흐름을 시간순 추적
- SIP 메시지 행 클릭 시 헤더+SDP 전체 펼침
- SIP 상세 메시지 표시 on/off 토글 (목록 뷰)

### 단말 매칭 (시퀀스 뷰)
- 메시지 종류별 정확한 단말 매칭
  - TX request → From / TX response → To / RX request → Request-URI/To / RX response → From
  - 이전에 단말2→단말3 통화 시 단말3 컬럼만 표시되던 문제 수정
- SBC 가 도메인 재작성해도 user-part(번호) 만으로 매칭하는 fallback
- 원격 서버 컬럼이 IP 별로 분리 — 다른 서버(skbroadband/tbssw001.catvphone.com 등) 에 등록된 단말들이 각자 lifeline

### PhoneCard / 단말 설정
- 단말별 등록/해제 버튼, 직접 번호 입력, ↻ 재다이얼
- 키패드 버튼 클릭 시 DTMF 톤(RFC 4733) 재생
- 단말 설정 카드에 **저장/취소** — 저장 시 재등록 결과(성공/실패) 확인 후 commit
- 통화 시 활성 코덱 0개면 INVITE 전 사전 안내

### 사이드카 안정성 (sipd.cpp)
- 모든 PJSIP 모듈 콜백 try/catch 보호
- `emitJson` 비-UTF-8 sanitize 폴백 (nlohmann::json throw → sipd 크래시 → PePe EPIPE 차단)
- `pjsua_acc_find_for_incoming` 제거 (일부 RX 흐름에서 stale state 로 SIGSEGV)

---

## SQL Tool

### 결과 패널 접기/펼치기
- MicroSip 콜로그 스타일 토글 헤더 — `▼ 📊 결과 (N행 · M열) · 핀 K개` 항상 표시
- 우측 **⤢ 최대 / ⤡ 복원** 버튼
- 히스토리 패널 기본 접힌 상태

### 타이핑 팅김 수정
- 결과 그리드(수천 셀) 표시 상태에서 편집기 타이핑 시 매 키스트로크마다 부모 리렌더 → JSX 재생성 100ms+ → **다음 키 삼킴/뒤집힘** 문제
- Monaco Editor 를 `defaultValue` + uncontrolled 로 전환 (탭 전환 시 remount)
- onChange 250ms 디바운스 → 타이핑 중 부모 리렌더 없음
- `quickSuggestions=false` — 자동완성 팝업이 키 삼키던 문제 차단 (Ctrl+Space 로 명시 트리거)

### fetchSize
- `runSql` useCallback deps 에 `fetchSize` 누락 → 클로저가 초기값(200)을 잡아 사용자가 바꿔도 반영 안 되던 문제 수정

### AI 자동 생성
- 스트리밍 진행 패널 (우측 하단) — 응답이 흘러나오는 것 실시간 표시, 도구 호출 칩, ⏹ 중단 / × 닫기 버튼
- 에이전트 라우팅 수정 (Codex/Antigravity/Gemini 선택 시 Claude 로 갔던 버그)

### JDBC 연결 검증
- IP 만 살아있고 세션이 깨진(서버 timeout/version mismatch) 경우 '연결됨' 오표시 차단
- `ensureConnected` 이후 pingSql 로 post-connect 검증
- Java 사이드카 `isConnected` 가 `c.isValid(2)` 추가

---

## 기타

### %TEMP% 정리
- `pepe-sipd.log`, `pepe-agy-*.log`, `pepe-mcp-ssh-server.cjs`, `pepe-claude-hook.cjs`, `pepe-claude-hook-wrap.cmd` 자동 정리
- 매 기동 시 재생성되는 정적 스크립트는 mtime 무관 즉시 삭제
- before-quit 시에도 동일 파일 삭제

### 코드 서명
- SHA-256 서명 (DigiCert timestamp)

---

## 산출물
- `PePe-Terminal-SSH-Setup-2.1.13.exe` (NSIS 설치본)
- `PePe-Terminal-SSH-2.1.13-portable.exe` (포터블)
