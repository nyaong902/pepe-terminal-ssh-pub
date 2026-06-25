!macro customInit
  ; 모든 사용자 / 전용 모두 Program Files에 설치
  StrCpy $INSTDIR "$PROGRAMFILES\PePe Terminal(SSH)"
  ; 설치 시 파일 복사 단계도 detail 패널에 출력되도록 — 기본 SetDetailsPrint=lastused → both
  SetDetailsPrint both
!macroend

!macro customHeader
  ; 상세 내역 항상 표시
  ShowInstDetails show
  ShowUninstDetails show
!macroend

; 부드러운 진행 바 — 퍼센티지 갱신 부드럽게
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
; install/uninstall 페이지 자동 닫힘 방지 → 사용자가 detail 확인 가능
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_UNFINISHPAGE_NOAUTOCLOSE

!macro customInstall
  ; install 단계 진입 시 detail 출력 활성 (ShowInstDetails 는 section 밖 customHeader 에서만 가능)
  SetDetailsPrint both
  SetAutoClose false

  DetailPrint "─────────────────────────────────────────"
  DetailPrint "✓ 1단계 완료: PePe Terminal 본체 파일 복사"
  DetailPrint "  (X11 서버 포함 약 5천 개 파일)"
  DetailPrint "─────────────────────────────────────────"

  DetailPrint "▶ 2단계: 탐색기 우클릭 메뉴 등록..."
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\PepeTerminal" "" "Open PePe Terminal here"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\PepeTerminal" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\PepeTerminal\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\PepeTerminal" "" "Open PePe Terminal here"
  WriteRegStr HKCU "Software\Classes\Directory\shell\PepeTerminal" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\PepeTerminal\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  DetailPrint "  ✓ 우클릭 메뉴 등록 완료"

  ; X11 서버(VcXsrv) 번들 압축 해제 — Windows 10+ 내장 tar.exe (bsdtar) 로 빠르게 (~3초)
  IfFileExists "$INSTDIR\resources\x11-server.zip" 0 lbl_no_x11
    DetailPrint "▶ 3단계: X11 서버(VcXsrv) 번들 설치 중..."
    DetailPrint "  (50MB → ~5천 개 파일 압축 해제)"
    nsExec::ExecToLog 'cmd /c tar -xf "$INSTDIR\resources\x11-server.zip" -C "$INSTDIR\resources\x11-server"'
    Pop $0
    ${If} $0 == 0
      DetailPrint "  ✓ X11 서버 설치 완료 (tar.exe, Qt/GTK X11 앱 호환)"
      Delete "$INSTDIR\resources\x11-server.zip"
    ${Else}
      DetailPrint "  ⚠ tar.exe 실패 (code=$0) — PowerShell 폴백"
      nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path \"$INSTDIR\resources\x11-server.zip\" -DestinationPath \"$INSTDIR\resources\x11-server\" -Force"'
      Pop $0
      ${If} $0 == 0
        DetailPrint "  ✓ X11 서버 설치 완료 (PowerShell)"
        Delete "$INSTDIR\resources\x11-server.zip"
      ${Else}
        DetailPrint "  ✕ X11 서버 압축 해제 실패 — 첫 X11 사용 시 자동 재시도"
      ${EndIf}
    ${EndIf}
  lbl_no_x11:

  ; ─────────────────────────────────────────
  ; 메신저(LAN 자동 탐색) 방화벽 규칙 등록
  ;  - 탐색은 UDP 브로드캐스트(39455)+유니캐스트 hello, 메시지는 TCP(임의 포트)
  ;  - Windows Defender 방화벽이 인바운드 UDP/TCP 를 막으면 서로 장치를 못 찾음
  ;  - 실행파일 기준 인바운드 허용 규칙으로 포트에 의존하지 않게 처리(사설/도메인 프로필만)
  ; ─────────────────────────────────────────
  DetailPrint "▶ 메신저 방화벽 규칙 등록..."
  ; 재설치/업그레이드 시 중복 방지 — 기존 동일 이름 규칙 먼저 삭제
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="PePe Terminal Messenger"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="PePe Terminal Messenger ICMP"'
  Pop $0
  ; 앱 실행파일의 인바운드 트래픽(모든 프로토콜) 허용 → UDP 탐색 + TCP 메시지 수신
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="PePe Terminal Messenger" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=private,domain'
  Pop $0
  ${If} $0 == 0
    DetailPrint "  ✓ 메신저 인바운드 허용 규칙 등록 완료"
  ${Else}
    DetailPrint "  ⚠ 방화벽 규칙 등록 실패(code=$0) — 메신저 첫 실행 시 Windows 허용 창에서 수동 허용 가능"
  ${EndIf}
  ; 보조: ICMPv4 echo(ping) 인바운드 허용 — 수동 ping 진단용(탐색 자체에는 불필요)
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="PePe Terminal Messenger ICMP" dir=in action=allow protocol=icmpv4:8,any enable=yes profile=private,domain'
  Pop $0

  DetailPrint "─────────────────────────────────────────"
  DetailPrint "✓ 모든 설치 완료. PePe Terminal(SSH) v${VERSION}"
  DetailPrint "─────────────────────────────────────────"
!macroend

; customUnInit: 제거 시작 시점 — electron-builder 의 자동 파일 삭제 (수천 개 파일 하나씩 출력) 이전에 실행
; X11 서버 폴더를 cmd /c rmdir 로 미리 통째로 삭제 → 자동 삭제 루프가 도달했을 땐 이미 비어 있어 출력 X
!macro customUnInit
  ${if} ${FileExists} "$INSTDIR\resources\x11-server\*"
    DetailPrint "X11 서버 폴더 삭제 중 (한 번에 처리)..."
    nsExec::Exec 'cmd /c rmdir /S /Q "$INSTDIR\resources\x11-server"'
    DetailPrint "X11 서버 폴더 삭제 완료"
  ${endif}
!macroend

!macro customUnInstall
  ; 메신저 방화벽 규칙 삭제
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="PePe Terminal Messenger"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="PePe Terminal Messenger ICMP"'
  Pop $0

  ; 탐색기 우클릭 메뉴 삭제
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\PepeTerminal"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\PepeTerminal"
  DeleteRegKey HKLM "Software\Classes\Directory\Background\shell\PepeTerminal"
  DeleteRegKey HKLM "Software\Classes\Directory\shell\PepeTerminal"

  ; 사용자 데이터 삭제 확인
  MessageBox MB_YESNO|MB_ICONQUESTION "사용자 데이터(세션, 설정)를 삭제하시겠습니까?" IDNO +4
    SetShellVarContext current
    RMDir /r "$APPDATA\PePe Terminal(SSH)"
    SetShellVarContext all
    RMDir /r "$APPDATA\PePe Terminal(SSH)"
!macroend
