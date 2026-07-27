# SQL Tool

Altibase/Oracle/PostgreSQL/MySQL/MariaDB/MS SQL Server/SQLite 등 JDBC로 접속 가능한
DB를 PePe 안에서 바로 조회·관리하는 워크스페이스입니다. SSH와 별개로 세션 목록에서 우클릭 →
"SQL Tool로 열기"로 사용하며, JDBC는 별도 Java 사이드카(JVM)에서 구동돼 렌더러/메인 프로세스와
분리되어 있습니다.

![SQL Tool 데모](../videos/sql-tool-demo.gif)

📹 [전체 데모 영상 보기](../videos/sql-tool-demo.mp4) (드라이버 등록 → 접속 → 스키마 탐색 →
쿼리 실행까지 전체 흐름)

![스키마 트리 + 쿼리 편집/뷰 정의 확인](../screenshots/sql-tool-01-schema.png)
![테이블스페이스 사용량 시각화 + DB 세션 관리자](../screenshots/sql-tool-02-monitor.png)

## 핵심 기능

- **스키마 트리 탐색** — 테이블/뷰/인덱스/시퀀스/프로시저/함수/패키지/트리거까지 계층형으로 탐색
- **다중 쿼리 탭** — 세션당 여러 쿼리 탭을 동시에 열어두고 전환하며 작업
- **컬럼/DDL/실행계획(Plan) 확인** — 테이블·뷰의 컬럼 정의와 `CREATE OR REPLACE` DDL을
  바로 확인, 쿼리 실행 전 Plan으로 실행계획 미리보기
- **AI 자동 생성** — 자연어로 요청하면 Claude가 스키마를 참고해 쿼리를 작성
- **DB 세션/테이블스페이스 모니터링** — 현재 접속 세션(Session ID/User/SQL 등) 실시간 확인,
  테이블스페이스별 사용량을 막대그래프로 시각화
- **즐겨찾기 / 저장된 쿼리** — 자주 쓰는 쿼리를 즐겨찾기에 저장해 재사용
- **JDBC ping / 재연결** — 연결 끊김 감지 및 원클릭 재연결

## JDBC 드라이버 관리자

상단 툴바(접속 후) 또는 **세션 편집 화면의 "드라이버 관리" 버튼**(접속 전에도 가능)에서 JDBC
드라이버를 직접 추가/편집할 수 있습니다.

![JDBC 드라이버 관리자 — 드라이버 추가/편집](../screenshots/sql-tool-03-driver-manager.png)

- PostgreSQL / MySQL·MariaDB / Microsoft SQL Server / SQLite / Altibase 6.x·7.x / Oracle
  이 기본(builtin) 드라이버로 내장돼 있습니다
- **+ 추가**로 새 드라이버 정의(이름, Dialect, Driver 클래스, URL 템플릿, 기본 포트) 등록 가능
- **Libraries** 탭에서 드라이버 JAR을 직접 추가하거나 Maven Central에서 자동 다운로드
- **테스트 로드**로 클래스 로딩이 정상인지 즉시 확인, 문제 시 **사이드카 재시작**으로 JVM만
  다시 띄워 복구
- 세션 편집 화면에서 드라이버를 새로 등록하면 그 자리에서 드롭다운에 바로 반영되어, 접속 세션을
  처음 만들 때부터 원하는 드라이버를 바로 선택할 수 있습니다
