!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

; 진단용 파일 로그 — 자동 업데이트 중 설치 창이 안 뜨는 문제의 실제 발생 지점을 확인하기 위함.
; 앱 쪽 update-debug.log 는 앱이 이미 종료된 뒤(설치 프로그램 실행 중)엔 아무것도 못 남기므로,
; 설치 프로그램 자신이 직접 기록한다(권한/승격 여부 무관).
;  - 경로: C:\Users\Public — 승격되어 다른 관리자 계정으로 실행돼도 항상 같은 위치, 표준 사용자도
;    쓰기 가능하고 계정과 무관하게 찾기 쉽다(%TEMP% 는 실행 계정마다 달라 혼란을 준다).
;  - append('a') 모드는 파일이 없으면 실패할 수 있으므로, 실패 시 write('w') 로 폴백해 반드시 생성.
;  - preInit(설치·제거 양쪽 .onInit 에 삽입됨) 에서 쓰이므로 BUILD_UNINSTALLER 가드 밖(전역)에 둔다.
!define DBG_LOG_PATH "C:\Users\Public\pepe-install-debug.log"
!macro DbgLog msg
  ClearErrors
  FileOpen $9 "${DBG_LOG_PATH}" a
  ${If} ${Errors}
    ClearErrors
    FileOpen $9 "${DBG_LOG_PATH}" w
  ${EndIf}
  ${IfNot} ${Errors}
    FileSeek $9 0 END
    FileWrite $9 "${msg}$\r$\n"
    FileClose $9
  ${EndIf}
!macroend

; nsDialogs 사용자 데이터 삭제 옵션 페이지 관련 변수/함수 — 설치용에만 필요.
!ifndef BUILD_UNINSTALLER
Var DeleteDataCheckbox
Var DeleteDataChecked  ; 0 = 유지(기본), 1 = 삭제
Var IsUpdateRun        ; "1" = --updated 로 실행된 자동 업데이트 (customInit 에서 판별) — 레지스트리
                        ; 이전 선택값을 기본 체크 상태로 미리 채우는 용도로만 쓴다(아래 참고).

; SW_SHOWNORMAL(1) + SetForegroundWindow — BringToFront 는 "이미 보이는 창을 앞으로" 가져올 뿐이라,
; 자동 업데이트 흐름에서 이 페이지가 설치 프로그램이 처음 화면에 뭔가를 보여주는 순간이면(그
; 전 페이지들은 다 건너뛰므로) 부족할 수 있다 — 창을 명시적으로 SW_SHOWNORMAL 로 띄우고
; SetForegroundWindow 로 강제 포그라운드까지 시도한다.
!macro ForceShowInstallerWindow
  System::Call 'user32::ShowWindow(i $HWNDPARENT, i 1)'
  System::Call 'user32::SetForegroundWindow(i $HWNDPARENT) i .r0'
!macroend

Function nsShowDeleteDataPage
  ; v2.2.14/v2.2.15 에서 "자동 업데이트 시 이 페이지를 무조건 건너뛴다"가 그 문제의 PC에서
  ; 확실히 검증됐었다(설치 창 정상). v2.2.16/v2.2.18 에서 페이지를 다시 보여주도록 바꿨다가
  ; 두 번 다 재현됐고, v2.2.19 에서 perMachine:false(관리자 권한 자체를 없앰) 로 바꾸면서
  ; 실수로 이 페이지 표시 여부는 되돌리지 않고 남겨뒀다 — 관리자 권한 문제와 이 페이지 문제는
  ; 서로 별개의 원인이었다. 확실히 검증된 상태로 되돌린다: --updated 실행이면 무조건 건너뛴다.
  !insertmacro DbgLog "nsShowDeleteDataPage: enter IsUpdateRun=$IsUpdateRun"
  ${If} $IsUpdateRun == "1"
    !insertmacro DbgLog "nsShowDeleteDataPage: skip (IsUpdateRun=1)"
    Abort
  ${EndIf}
  !insertmacro ForceShowInstallerWindow
  ; 사용자 데이터는 현재 사용자의 Roaming(AppData) 에 있음. perMachine 모드에선
  ; SetShellVarContext=all 이라 $APPDATA 가 ProgramData 로 잡히니, current 로 잠깐 전환.
  SetShellVarContext current
  StrCpy $0 "$APPDATA\PePe Terminal(SSH)"
  SetShellVarContext all
  IfFileExists "$0\*.*" +2 0
    Abort
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "이 컴퓨터에 기존 PePe Terminal(SSH) 사용자 데이터가 있습니다.$\r$\n(위치: %APPDATA%\PePe Terminal(SSH))"
  ${NSD_CreateCheckBox} 0 40u 100% 12u "새로 시작 — 기존 사용자 데이터(세션·설정·즐겨찾기)를 모두 삭제합니다"
  Pop $DeleteDataCheckbox
  ; 기본은 체크 해제 = 유지
  ${NSD_SetState} $DeleteDataCheckbox 0
  ${NSD_CreateLabel} 0 60u 100% 40u "체크 안 함(기본·권장): 기존 세션과 설정을 그대로 유지합니다.$\r$\n체크: %APPDATA%\PePe Terminal(SSH) 폴더 전체를 삭제합니다. 되돌릴 수 없습니다."
  nsDialogs::Show
FunctionEnd

Function nsLeaveDeleteDataPage
  ${NSD_GetState} $DeleteDataCheckbox $DeleteDataChecked
FunctionEnd

; 선택 설치(용량 큰 기능만) — VPN/MicroSIP/SIPp/미디어 재생/오피스는 각각 전용 번들
; 바이너리·정적 파일을 쓰고 서로 공유하지 않아서 필요 없으면 통째로 뺄 수 있다(브라우저/파일
; 비교/로그 분석은 별도 번들이 없는 순수 JS 기능이라 선택 설치 대상이 아님 — 항상 설치됨).
;
; v2.2.24~33 에서 "nsDialogs 가 설치 창 안 뜨는 문제의 원인일 수 있다"는 가설로 NSIS 내장
; MUI_PAGE_COMPONENTS(실제 Section 5개 선언)로 바꿨었는데, 그 문제의 진짜 원인은 이후
; electron-updater 의 elevate.exe 자체 실패 → sudo-prompt 의 Node.util.isObject 미존재로 인한
; 즉시 예외 → PowerShell 자식 프로세스를 detached:true 로 spawn 했을 때 스크립트 실행 자체가
; 시작되지 않던 문제로 최종 확정됐다(nsDialogs 는 관계 없었음). 반면 실제 Section 을 5개 추가로
; 선언한 뒤로 설치(파일 복사) 자체가 눈에 띄게 느려졌다는 현장 보고가 있어, 원인이 사라진 지금
; nsDialogs 방식(v2.2.1 과 동일 — 실제 Section 없이 체크박스만)으로 되돌린다. 삭제 로직
; (customInstall 에서 체크 해제된 번들 폴더만 지우는 방식)은 그대로 유지.
Var VpnCheckbox
Var VpnChecked
Var MicroSipCheckbox
Var MicroSipChecked
Var SippCheckbox
Var SippChecked
Var MediaCheckbox
Var MediaChecked
Var OfficeCheckbox
Var OfficeChecked
Var SswPhoneCheckbox
Var SswPhoneChecked

Function nsShowFeaturesPage
  ; 삭제 확인 페이지와 달리, 이 페이지는 자동 업데이트 중에도 항상 보여준다(사용자 요청) —
  ; IsUpdateRun 체크 없음. customInit 에서 레지스트리 이전 선택값을 이미 기본 체크 상태로
  ; 채워뒀으므로, 조용히 넘어가고 싶으면 그냥 다음으로 누르면 된다.
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 20u "설치할 기능을 선택하세요 (기본: 전체 설치). 용량이 큰 기능만 선택 해제할 수 있습니다."
  ${NSD_CreateCheckBox} 0 26u 100% 12u "VPN (OpenVPN, 약 9MB)"
  Pop $VpnCheckbox
  ${NSD_SetState} $VpnCheckbox $VpnChecked
  ${NSD_CreateCheckBox} 0 40u 100% 12u "MicroSIP (SIP 소프트폰, 약 104MB)"
  Pop $MicroSipCheckbox
  ${NSD_SetState} $MicroSipCheckbox $MicroSipChecked
  ${NSD_CreateCheckBox} 0 54u 100% 12u "SIPp (SIP 부하테스트, 약 15MB)"
  Pop $SippCheckbox
  ${NSD_SetState} $SippCheckbox $SippChecked
  ${NSD_CreateCheckBox} 0 68u 100% 12u "미디어 재생 — EVS/AMR/OPUS 코덱 (약 49MB)"
  Pop $MediaCheckbox
  ${NSD_SetState} $MediaCheckbox $MediaChecked
  ${NSD_CreateCheckBox} 0 82u 100% 12u "오피스 — 한글/워드/엑셀/파워포인트/FlowChart 편집기 (약 220MB)"
  Pop $OfficeCheckbox
  ${NSD_SetState} $OfficeCheckbox $OfficeChecked
  ${NSD_CreateCheckBox} 0 96u 100% 12u "SSW 소프트폰 (MicroSIP과 독립된 프로세스로 동작, 같은 설치 파일을 써서 추가 용량 없음)"
  Pop $SswPhoneCheckbox
  ${NSD_SetState} $SswPhoneCheckbox $SswPhoneChecked
  ${NSD_CreateLabel} 0 114u 100% 30u "터미널/브라우저/파일 비교/로그 분석/SQL Tool 등 나머지는 별도 용량이 없어 항상 설치됩니다.$\r$\n선택은 다음 업데이트에도 유지됩니다 — 바꾸려면 재설치하세요."
  nsDialogs::Show
FunctionEnd

Function nsLeaveFeaturesPage
  ${NSD_GetState} $VpnCheckbox $VpnChecked
  ${NSD_GetState} $MicroSipCheckbox $MicroSipChecked
  ${NSD_GetState} $SippCheckbox $SippChecked
  ${NSD_GetState} $MediaCheckbox $MediaChecked
  ${NSD_GetState} $OfficeCheckbox $OfficeChecked
  ${NSD_GetState} $SswPhoneCheckbox $SswPhoneChecked
FunctionEnd
!endif

; preInit — electron-builder .onInit 의 가장 첫 훅. 외부(비승격)·내부(승격) 인스턴스 모두 여기부터 실행된다.
; initMultiUser(승격/설치모드 결정) 보다 앞이므로, "preInit 은 찍히는데 customInit 은 안 찍힘" = 승격/모드
; 결정 단계에서 죽는다는 뜻. $CMDLINE 에 UAC 플러그인이 붙인 /UAC: 토큰이 있으면 승격된 내부 인스턴스다.
!macro preInit
  !insertmacro DbgLog "preInit: .onInit start v${VERSION} cmdline=[$CMDLINE]"
  ${If} ${Silent}
    !insertmacro DbgLog "preInit: Silent=YES"
  ${Else}
    !insertmacro DbgLog "preInit: Silent=NO"
  ${EndIf}
!macroend

!macro customInit
  !insertmacro DbgLog "customInit: ENTRY (past initMultiUser) v${VERSION} cmdline=[$CMDLINE]"
  ; 설치 화면이 뒤에 숨는 경우를 대비한 안전장치.
  BringToFront
  ; 모든 사용자 / 전용 모두 Program Files에 설치.
  StrCpy $INSTDIR "$PROGRAMFILES\PePe Terminal(SSH)"
  ; 설치 시 파일 복사 단계도 detail 패널에 출력되도록 — 기본 SetDetailsPrint=lastused → both
  SetDetailsPrint both
  !ifndef BUILD_UNINSTALLER
    StrCpy $DeleteDataChecked "0"

    ; 자동 업데이트(electron-updater 의 quitAndInstall)로 실행됐는지 여기서 한 번만 판별해
    ; 이후 여러 페이지의 PRE 훅에서 재사용한다 — --updated 인자가 붙어 있으면 업데이트.
    ${GetParameters} $R0
    ${GetOptions} $R0 "--updated" $R1
    ${IfNot} ${Errors}
      StrCpy $IsUpdateRun "1"
    ${Else}
      StrCpy $IsUpdateRun "0"
    ${EndIf}
    ClearErrors
    !insertmacro DbgLog "customInit: IsUpdateRun=$IsUpdateRun params=$R0"

    ; 선택 설치 기본값 = 전체 설치. 앱 또는 이전 설치가 저장한 선택값이 있으면,
    ; 일반 설치와 자동 업데이트 모두 컴포넌트 선택 페이지의 기본 체크 상태로 반영한다.
    StrCpy $VpnChecked "1"
    StrCpy $MicroSipChecked "1"
    StrCpy $SippChecked "1"
    StrCpy $MediaChecked "1"
    StrCpy $OfficeChecked "1"
    StrCpy $SswPhoneChecked "1"
    ReadRegStr $R2 HKCU "Software\PePeTerminal\Features" "Vpn"
    ${IfNot} $R2 == ""
      StrCpy $VpnChecked $R2
    ${EndIf}
    ReadRegStr $R2 HKCU "Software\PePeTerminal\Features" "MicroSip"
    ${IfNot} $R2 == ""
      StrCpy $MicroSipChecked $R2
    ${EndIf}
    ReadRegStr $R2 HKCU "Software\PePeTerminal\Features" "Sipp"
    ${IfNot} $R2 == ""
      StrCpy $SippChecked $R2
    ${EndIf}
    ReadRegStr $R2 HKCU "Software\PePeTerminal\Features" "Media"
    ${IfNot} $R2 == ""
      StrCpy $MediaChecked $R2
    ${EndIf}
    ReadRegStr $R2 HKCU "Software\PePeTerminal\Features" "Office"
    ${IfNot} $R2 == ""
      StrCpy $OfficeChecked $R2
    ${EndIf}
    ReadRegStr $R2 HKCU "Software\PePeTerminal\Features" "SswPhone"
    ${IfNot} $R2 == ""
      StrCpy $SswPhoneChecked $R2
    ${EndIf}

  !endif
!macroend

!macro customHeader
  ; 상세 내역 항상 표시
  ShowInstDetails show
  ShowUninstDetails show
!macroend

; 사용자 데이터 옵션 페이지 — electron-builder assistedInstaller.nsh 가 MUI_PAGE_DIRECTORY 이후
; MUI_PAGE_INSTFILES 이전에 customPageAfterChangeDir 훅을 삽입한다.
!macro customPageAfterChangeDir
  Page custom nsShowDeleteDataPage nsLeaveDeleteDataPage
  Page custom nsShowFeaturesPage nsLeaveFeaturesPage
!macroend

; 부드러운 진행 바 — 퍼센티지 갱신 부드럽게
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
; install/uninstall 페이지 자동 닫힘 방지 → 사용자가 detail 확인 가능
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_UNFINISHPAGE_NOAUTOCLOSE

; 선택 기능 zip 을 체크된 것만 그 자리에서 tar 로 푼다(체크 해제면 압축 해제 자체를 건너뛰고
; zip 만 지운다) — scripts/zip-optional-bundles.js 가 빌드 시 만들어 electron-builder 가
; resources\<Name>.zip 하나로만 번들해둔 것을 여기서 처리한다.
;
; 예전엔 electron-builder 가 각 기능 폴더를 통째로(파일 수십~수천 개) 번들해서, 체크
; 해제해도 일단 전부 압축 해제된 뒤에야(NSIS 기본 동작) rmdir 로 지웠다 — 체크 해제가 설치
; 시간에 전혀 영향을 못 준 진짜 원인. zip 하나만 번들해두면 체크 해제 시 그 압축 해제
; 자체를 건너뛸 수 있어 그만큼 설치 시간이 실제로 줄어든다.
!macro ExtractOrSkipBundle CheckedVar ZipName TargetRelDir Label
  ${If} ${CheckedVar} == 1
    DetailPrint "▶ ${Label} — 압축 해제 중..."
    CreateDirectory "$INSTDIR\resources\${TargetRelDir}"
    nsExec::ExecToLog 'cmd /c tar -xf "$INSTDIR\resources\${ZipName}.zip" -C "$INSTDIR\resources\${TargetRelDir}"'
    Pop $0
    ${If} $0 == 0
      DetailPrint "  ✓ ${Label} 설치 완료"
    ${Else}
      DetailPrint "  ⚠ ${Label} 압축 해제 실패(code=$0) — 첫 사용 시 앱이 자동 재시도"
    ${EndIf}
  ${Else}
    DetailPrint "▶ 선택 해제: ${Label} — 압축 해제 건너뜀"
  ${EndIf}
  Delete "$INSTDIR\resources\${ZipName}.zip"
!macroend

!macro customInstall
  ; nsLeaveFeaturesPage 에서 이미 사용자의 최종 체크 상태를 $VpnChecked 등에 읽어뒀다
  ; (nsDialogs 체크박스라 Section 플래그를 거칠 필요가 없다).
  !insertmacro DbgLog "customInstall: enter DeleteDataChecked=$DeleteDataChecked VpnChecked=$VpnChecked MicroSipChecked=$MicroSipChecked SippChecked=$SippChecked MediaChecked=$MediaChecked OfficeChecked=$OfficeChecked SswPhoneChecked=$SswPhoneChecked"
  ; install 단계 진입 시 detail 출력 활성 (ShowInstDetails 는 section 밖 customHeader 에서만 가능)
  SetDetailsPrint both
  SetAutoClose false

  ; 사용자가 옵션 페이지에서 "새로 시작" 체크했으면 기존 데이터 삭제
  ${If} $DeleteDataChecked == 1
    DetailPrint "▶ 사용자 요청: 기존 사용자 데이터 삭제 중..."
    SetShellVarContext current
    RMDir /r "$APPDATA\PePe Terminal(SSH)"
    SetShellVarContext all
    RMDir /r "$APPDATA\PePe Terminal(SSH)"
    DetailPrint "  ✓ 기존 사용자 데이터 삭제 완료"
  ${EndIf}

  ; 다음 업데이트 때(페이지 없이 조용히 진행) 같은 선택을 다시 적용할 수 있도록 저장.
  WriteRegStr HKCU "Software\PePeTerminal\Features" "Vpn" "$VpnChecked"
  WriteRegStr HKCU "Software\PePeTerminal\Features" "MicroSip" "$MicroSipChecked"
  WriteRegStr HKCU "Software\PePeTerminal\Features" "Sipp" "$SippChecked"
  WriteRegStr HKCU "Software\PePeTerminal\Features" "Media" "$MediaChecked"
  WriteRegStr HKCU "Software\PePeTerminal\Features" "Office" "$OfficeChecked"
  WriteRegStr HKCU "Software\PePeTerminal\Features" "SswPhone" "$SswPhoneChecked"

  ; SSW 소프트폰은 MicroSIP과 완전히 같은 sip-sidecar(sipd.exe) 엔진을 쓴다(별도 바이너리 없음) —
  ; 둘 중 하나라도 체크됐으면 엔진을 풀어야 한다. UI 노출 여부는 앱이 레지스트리의 SswPhone 값을
  ; 따로 읽어 결정한다(electron/main.ts의 features:get-available).
  StrCpy $R3 "0"
  ${If} $MicroSipChecked == 1
    StrCpy $R3 "1"
  ${EndIf}
  ${If} $SswPhoneChecked == 1
    StrCpy $R3 "1"
  ${EndIf}

  ; 체크된 기능만 zip 을 그 자리에서 풀고, 체크 해제된 기능은 압축 해제 자체를 건너뛰고
  ; zip 만 지운다(위 ExtractOrSkipBundle 매크로 참고 — 이게 이번에 진짜로 설치 시간을 줄이는 부분).
  !insertmacro ExtractOrSkipBundle $VpnChecked "openvpn-win" "openvpn" "VPN"
  !insertmacro ExtractOrSkipBundle $R3 "sip-sidecar-win-x64" "sip-sidecar\win-x64" "MicroSIP/SSW 소프트폰"
  !insertmacro ExtractOrSkipBundle $SippChecked "sipp-sidecar-win-x64" "sipp-sidecar\win-x64" "SIPp"
  !insertmacro ExtractOrSkipBundle $MediaChecked "gstreamer-sidecar-win-x64" "gstreamer-sidecar\win-x64" "미디어 재생(GStreamer)"
  !insertmacro ExtractOrSkipBundle $OfficeChecked "office-editor" "office-editor" "오피스 — 한글/워드/엑셀/파워포인트"
  !insertmacro ExtractOrSkipBundle $OfficeChecked "rhwp-studio" "rhwp-studio" "오피스 — 한글(rhwp-studio)"
  !insertmacro ExtractOrSkipBundle $OfficeChecked "flowchart-editor" "flowchart-editor" "오피스 — FlowChart 편집기"

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
  ;  - Windows Defender 방화벽이 UDP/TCP 를 막으면 서로 장치를 못 찾음
  ;  - 실행파일 기준 인바운드/아웃바운드 허용 규칙으로 포트에 의존하지 않게 처리(사설/도메인 프로필만)
  ;  - 인바운드와 아웃바운드 규칙은 같은 이름을 사용 → delete rule name=... 한 번에 정리됨
  ; ─────────────────────────────────────────
  DetailPrint "▶ 메신저 방화벽 규칙 등록..."
  ; 재설치/업그레이드 시 중복 방지 — 기존 동일 이름 규칙(인바운드/아웃바운드 모두) 먼저 삭제
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PePe Terminal Messenger"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PePe Terminal Messenger ICMP"'
  Pop $0
  ; 앱 실행파일의 인바운드 트래픽(모든 프로토콜) 허용 → UDP 탐색 + TCP 메시지 수신
  nsExec::Exec 'netsh advfirewall firewall add rule name="PePe Terminal Messenger" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=private,domain'
  Pop $0
  ${If} $0 == 0
    DetailPrint "  ✓ 메신저 인바운드 허용 규칙 등록 완료"
  ${Else}
    DetailPrint "  ⚠ 인바운드 규칙 등록 실패(code=$0) — 메신저 첫 실행 시 Windows 허용 창에서 수동 허용 가능"
  ${EndIf}
  ; 앱 실행파일의 아웃바운드 트래픽(모든 프로토콜) 허용 → UDP 브로드캐스트/유니캐스트 송신 + TCP 연결
  nsExec::Exec 'netsh advfirewall firewall add rule name="PePe Terminal Messenger" dir=out action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=private,domain'
  Pop $0
  ${If} $0 == 0
    DetailPrint "  ✓ 메신저 아웃바운드 허용 규칙 등록 완료"
  ${Else}
    DetailPrint "  ⚠ 아웃바운드 규칙 등록 실패(code=$0)"
  ${EndIf}
  ; 보조: ICMPv4 echo(ping) 인바운드/아웃바운드 허용 — 수동 ping 진단용(탐색 자체에는 불필요)
  nsExec::Exec 'netsh advfirewall firewall add rule name="PePe Terminal Messenger ICMP" dir=in action=allow protocol=icmpv4:8,any enable=yes profile=private,domain'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="PePe Terminal Messenger ICMP" dir=out action=allow protocol=icmpv4:8,any enable=yes profile=private,domain'
  Pop $0

  DetailPrint "─────────────────────────────────────────"
  DetailPrint "✓ 모든 설치 완료. PePe Terminal(SSH) v${VERSION}"
  DetailPrint "─────────────────────────────────────────"
  !insertmacro DbgLog "customInstall: complete"
!macroend

; customUnInit: 제거 시작 시점 — electron-builder 의 자동 파일 삭제 (수천 개 파일 하나씩 출력) 이전에 실행
; X11 서버 폴더를 cmd /c rmdir 로 미리 통째로 삭제 → 자동 삭제 루프가 도달했을 땐 이미 비어 있어 출력 X
!macro customUnInit
  ${if} ${FileExists} "$INSTDIR\resources\x11-server\*"
    DetailPrint "X11 서버 폴더 삭제 중 (한 번에 처리)..."
    nsExec::Exec 'cmd /c rmdir /S /Q "$INSTDIR\resources\x11-server"'
    DetailPrint "X11 서버 폴더 삭제 완료"
  ${endif}

  ; 선택 설치 기능(VPN/MicroSIP/SIPp/미디어/오피스) 번들 폴더 삭제 — customInstall 이 zip 을
  ; File 목록이 아니라 tar 로 직접 풀어 넣은 폴더들이라, electron-builder 가 자동 생성하는
  ; 제거 목록(설치 시 File 로 넣은 항목만 앎)에 안 잡혀 있다. 안 지우면 제거 후에도 남는다.
  ${if} ${FileExists} "$INSTDIR\resources\openvpn\*"
    nsExec::Exec 'cmd /c rmdir /S /Q "$INSTDIR\resources\openvpn"'
  ${endif}
  ${if} ${FileExists} "$INSTDIR\resources\sip-sidecar\*"
    nsExec::Exec 'cmd /c rmdir /S /Q "$INSTDIR\resources\sip-sidecar"'
  ${endif}
  ${if} ${FileExists} "$INSTDIR\resources\sipp-sidecar\*"
    nsExec::Exec 'cmd /c rmdir /S /Q "$INSTDIR\resources\sipp-sidecar"'
  ${endif}
  ${if} ${FileExists} "$INSTDIR\resources\gstreamer-sidecar\*"
    nsExec::Exec 'cmd /c rmdir /S /Q "$INSTDIR\resources\gstreamer-sidecar"'
  ${endif}
  ${if} ${FileExists} "$INSTDIR\resources\office-editor\*"
    nsExec::Exec 'cmd /c rmdir /S /Q "$INSTDIR\resources\office-editor"'
  ${endif}
  ${if} ${FileExists} "$INSTDIR\resources\rhwp-studio\*"
    nsExec::Exec 'cmd /c rmdir /S /Q "$INSTDIR\resources\rhwp-studio"'
  ${endif}
  ${if} ${FileExists} "$INSTDIR\resources\flowchart-editor\*"
    nsExec::Exec 'cmd /c rmdir /S /Q "$INSTDIR\resources\flowchart-editor"'
  ${endif}
!macroend

!macro customUnInstall
  ; 메신저 방화벽 규칙 삭제
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PePe Terminal Messenger"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PePe Terminal Messenger ICMP"'
  Pop $0

  ; 탐색기 우클릭 메뉴 삭제
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\PepeTerminal"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\PepeTerminal"
  DeleteRegKey HKLM "Software\Classes\Directory\Background\shell\PepeTerminal"
  DeleteRegKey HKLM "Software\Classes\Directory\shell\PepeTerminal"

  ; 선택 설치 기능 플래그(설정값, 사용자 데이터 아님) 삭제
  DeleteRegKey HKCU "Software\PePeTerminal\Features"

  ; 사용자 데이터(세션·설정) 는 자동 삭제하지 않음 — 재설치/업그레이드 시 세션 유지 보장.
  ; 완전 삭제가 필요하면 사용자가 %APPDATA%\PePe Terminal(SSH) 폴더를 수동 삭제.
!macroend
