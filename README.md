# PePe Terminal(SSH) 기능 문서

기능별로 페이지를 나눠 정리한 사용 안내입니다. 필요한 기능을 아래에서 찾아 들어가세요.

## 목차

| 기능 | 설명 |
|---|---|
| [터미널 / 세션 관리](features/terminal.md) | SSH 다중 세션, 분할 화면, 파일 트리·전송 |
| [파일 전송 워크스페이스](features/file-transfer.md) | 로컬↔원격 듀얼 패널 드래그앤드롭 전송, ClearCase 동적 뷰 지원 |
| [SQL Tool](features/sql-tool.md) | JDBC 기반 DB 클라이언트 — 스키마 탐색, 쿼리 실행, 드라이버 관리자 |
| [브라우저 워크스페이스](features/browser.md) | PePe 안에 내장된 웹 브라우저 탭 |
| [AI Chat](features/ai-chat.md) | Claude 기반 에이전트 — 여러 SSH 세션을 함께 인식하고 직접 작업 수행 |
| [SIPp 워크스페이스](features/sipp.md) | SIP 부하 테스트 도구 |
| [소프트폰 (MicroSIP / SSW)](features/softphone.md) | SIP 소프트폰 — 통화, Call Flow, SIP 메시지 시퀀스, 부가서비스 |
| [미디어 워크스페이스](features/media.md) | 녹취 음원 재생, pcap에서 RTP 오디오 추출 |
| [파일/디렉터리 비교](features/file-compare.md) | 로컬↔원격 파일·폴더 diff |
| [로그 분석](features/log-analysis.md) | 실시간 로그 tail, 필터, AI 분석 |
| [VPN (OpenVPN)](features/vpn.md) | .ovpn 프로필로 사내망 연결 |
| [PePe Messenger](features/messenger.md) | 같은 네트워크 PePe 사용자와 채팅/파일 전송 |
| [작업일지](features/work-journal.md) | 일일 할 일 + AI 주간 요약 |
| [스티커 메모](features/sticky-notes.md) | 포스트잇형 메모 |
| [옵션 (설정)](features/options.md) | 터미널/세션/단축키 등 전체 설정 |
| [다국어 지원 (i18n 편집기)](features/i18n-editor.md) | UI 문구 번역 편집 + AI 번역 |
| [PePe 원격 공유 / Pepe-Connect](features/pepe-connect.md) | 브라우저·모바일에서 PePe 화면 접근 |

> 📌 이 문서는 계속 보강 중입니다. 아래 "기여 방법"을 참고해 화면을 추가해주세요.

---

## 기여 방법 — 스크린샷 추가하기

PePe 개발 빌드(`npm run dev`)에는 툴바에 임시 **📸 버튼**이 있습니다. 이 버튼을 누르면 현재 창(내장 브라우저·오피스처럼 별도 렌더링되는 탭 포함)을 통째로 캡처해서

```
%APPDATA%\PePe Terminal(SSH)\doc-captures\
```

에 PNG로 저장합니다. 일반 OS 스크린샷 도구로는 이런 내장 탭들이 검은 박스로 나오는 문제가 있어서, 앱 자체의 캡처 API(`webContents.capturePage`)로 직접 읽어 합성하도록 만들었습니다. 캡처 후 `docs/screenshots/`로 옮기고 이름을 붙여서 이 문서에 추가해주세요. **민감한 사내 정보(IP·호스트명·전화번호 등)가 보이면 반드시 블러 처리 후 커밋하세요.**
