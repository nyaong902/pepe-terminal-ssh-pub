!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
; 기능 선택 페이지를 NSIS 내장 MUI_PAGE_COMPONENTS 로 쓰기 위해 직접 include 한다.
; 우리 파일이 electron-builder 자체 스크립트보다 먼저 include 돼서, 이 시점엔 MUI2.nsh 매크로가
; 아직 정의돼 있지 않다("macro named ... not found" 컴파일 에러) — MUI2.nsh 는 중복 include
; 가드가 있어 여기서 먼저 불러도 안전하다.
!include "MUI2.nsh"

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

; 선택 설치 — NSIS 내장 MUI_PAGE_COMPONENTS(체크박스 + 스크롤 + 항목별 설명 기본 제공).
;
; 이력: v2.2.24~33 에서 이 방식을 썼다가 v2.2.34 에서 nsDialogs 커스텀 페이지로 되돌렸다.
; 되돌린 이유로 "실제 Section 을 5개 추가로 선언한 뒤로 설치(파일 복사)가 눈에 띄게 느려졌다는
; 현장 보고"가 적혀 있었는데, 그때 git 이력을 보면 그 Section 들은 본문이 AddSize 한 줄뿐이었다
; (파일 복사를 전혀 하지 않는다). 즉 Section 선언과 복사 속도는 인과관계가 없었다 —
; 실제 압축 해제는 예전에도 지금처럼 customInstall 의 zip+tar 가 담당한다.
; 항목이 10개로 늘어 nsDialogs 로는 페이지 영역(약 140u)에 다 들어가지 않으므로 다시 이 방식으로
; 온다. 스크롤이 기본 제공돼 앞으로 항목이 더 늘어도 레이아웃을 다시 손볼 필요가 없다.
;
; Section 본문은 AddSize 뿐이다 — 선택 상태만 전달하고, 실제 설치/압축 해제는 전부 customInstall.
; AddSize 는 "압축 해제 후" 실측값이다(du 기준). 예전 라벨에 적혀 있던 값은 실제와 크게 달랐다 —
; MicroSIP 104MB(실제 52MB: sipd.exe 하나만 담는다), 미디어 49MB(실제 14MB). 값을 바꿀 때는
; 라벨을 베끼지 말고 resources/ 아래 원본 폴더 크기를 다시 재서 넣을 것.
Var VpnChecked
Var MicroSipChecked
Var SippChecked
Var MediaChecked
Var OfficeChecked
Var SswPhoneChecked
Var CdrToolChecked
Var ChatArchiveChecked
Var RemoteShareChecked
Var PepeThingChecked
Var PepeBoxChecked

Section "VPN - OpenVPN (약 9MB)" SEC_VPN
  AddSize 9000
SectionEnd
Section "MicroSIP - SIP 소프트폰 (약 52MB)" SEC_MICROSIP
  AddSize 52000
SectionEnd
Section "SIPp - SIP 부하테스트 (약 14MB)" SEC_SIPP
  AddSize 14000
SectionEnd
Section "미디어 재생 - EVS/AMR/OPUS 코덱 (약 14MB)" SEC_MEDIA
  AddSize 14000
SectionEnd
Section "오피스 - 한글/워드/엑셀/PPT/FlowChart (약 220MB)" SEC_OFFICE
  AddSize 220000
SectionEnd
Section "대화 아카이브 검색 - AI 검색 런타임 (약 158MB)" SEC_CHATARCHIVE
  AddSize 158000
SectionEnd
Section "SSW CDR 로그 분석 - Clog/CDR 파서 (약 1MB)" SEC_CDRTOOL
  AddSize 1000
SectionEnd
Section "SSW 소프트폰 (추가 용량 없음)" SEC_SSWPHONE
SectionEnd
Section "Pepe-Thing - 파일 검색 (추가 용량 없음)" SEC_PEPETHING
SectionEnd
Section "Pepe-Box - 클라우드 저장소 (추가 용량 없음)" SEC_PEPEBOX
SectionEnd
; 원격 공유(WebRTC) — 시그널링에 쓰는 ws 패키지만 들어간다. 용량은 작지만 체크를 해제하면
; 관련 파일이 아예 안 깔리도록 다른 선택 기능과 같은 방식으로 번들(remote-share.zip)로 분리했다.
Section "원격 공유 - 화면 공유(WebRTC) (약 1MB)" SEC_REMOTESHARE
  AddSize 1000
SectionEnd

; MUI_FUNCTION_DESCRIPTION_BEGIN/TEXT 는 $mui.ComponentsPage.DescriptionText 변수를 참조하는데,
; 이 변수는 원래 MUI_PAGE_COMPONENTS 매크로가 삽입될 때(customPageAfterChangeDir, 더 뒤에서 실행)
; 선언된다. 우리 파일은 그보다 먼저 top-level 로 include 돼서 참조 시점에 변수가 없어
; "unknown variable" 경고(=치명적 에러)가 났다 — MUI_COMPONENTSPAGE_INTERFACE 를 여기서 먼저
; 호출해 변수만 미리 선언해둔다(내부적으로 !ifndef 가드가 있어 나중에 MUI_PAGE_COMPONENTS 가
; 다시 호출해도 중복 선언 에러는 나지 않는다).
!insertmacro MUI_COMPONENTSPAGE_INTERFACE

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  ; PePe 본체(electron-builder 의 install 섹션)에는 설명을 달지 않는다 — 그 섹션 ID
  ; (INSTALL_SECTION_ID) 는 우리 파일이 include 되는 시점엔 아직 정의되지 않았다.
  ; 이름만 customInit 에서 런타임에 바꿔준다(아래 참고).
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_VPN} "OpenVPN 클라이언트 — 회사망 VPN 접속이 필요 없으면 해제해도 됩니다."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MICROSIP} "SIP 소프트폰 — MicroSIP 워크스페이스를 안 쓰면 해제해도 됩니다."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_SIPP} "SIP 부하테스트 도구 — SIPp 워크스페이스를 안 쓰면 해제해도 됩니다."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MEDIA} "EVS/AMR/OPUS 코덱 재생 — 미디어 워크스페이스의 일반 영상/WAV 재생은 이 옵션과 무관하게 계속 됩니다."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_OFFICE} "한글/워드/엑셀/파워포인트/FlowChart 편집기 — 오피스 워크스페이스를 안 쓰면 해제해도 됩니다."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CHATARCHIVE} "지난 메신저 대화를 자연어로 검색하는 기능과 그 AI 런타임. 이 설치본에서 가장 큰 항목입니다 — 해제하면 설치 용량이 약 158MB 줄어듭니다."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CDRTOOL} "SKB SSW 의 Clog/CDR 원문을 필드별로 풀어보는 워크스페이스."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_SSWPHONE} "MicroSIP 과 독립된 프로세스로 동작하지만 같은 설치 파일을 씁니다 — 해제해도 설치 용량은 줄지 않고 메뉴에서만 숨겨집니다."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_PEPETHING} "voidtools Everything 의 로컬 인덱스로 파일을 찾는 워크스페이스(Everything 별도 설치 필요). 화면이 앱 본체에 포함돼 있어 해제해도 설치 용량은 줄지 않고 메뉴에서만 숨겨집니다."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_PEPEBOX} "Dropbox/Google Drive/OneDrive/네이버/카카오 연동 워크스페이스(작업 중인 기능). 해제해도 설치 용량은 줄지 않고 메뉴에서만 숨겨집니다."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_REMOTESHARE} "다른 PC 나 휴대폰의 브라우저로 이 화면을 공유합니다(WebRTC). 해제하면 메뉴에서 숨겨지고 관련 파일도 설치되지 않습니다."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; 레지스트리에 저장된 이전 선택값(없으면 전체 선택)을 컴포넌트 페이지의 기본 체크 상태로 반영.
; $R2 = 레지스트리 값, $R4 = 섹션 플래그 임시.
!macro ApplySectionDefault SecId RegName
  ReadRegStr $R2 HKCU "Software\PePeTerminal\Features" "${RegName}"
  ${If} $R2 == "0"
    SectionGetFlags ${SecId} $R4
    IntOp $R4 $R4 & ${SECTION_OFF}
    SectionSetFlags ${SecId} $R4
  ${EndIf}
!macroend

; 선택 상태를 $XxxChecked (1/0) 로 읽어온다 — customInstall 의 기존 로직이 이 변수들을 쓴다.
!macro ReadSectionChecked SecId OutVar
  SectionGetFlags ${SecId} $R3
  IntOp $R3 $R3 & ${SF_SELECTED}
  ${If} $R3 == ${SF_SELECTED}
    StrCpy ${OutVar} "1"
  ${Else}
    StrCpy ${OutVar} "0"
  ${EndIf}
!macroend
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

    ; 선택 설치 기본값 = 전체 선택(Section 선언 시 기본 SF_SELECTED). 이전 설치나 앱이 저장한
    ; 선택값이 "0" 인 항목만 체크를 풀어, 일반 설치와 자동 업데이트 모두 같은 선택으로 시작한다.
    !insertmacro ApplySectionDefault ${SEC_VPN} "Vpn"
    !insertmacro ApplySectionDefault ${SEC_MICROSIP} "MicroSip"
    !insertmacro ApplySectionDefault ${SEC_SIPP} "Sipp"
    !insertmacro ApplySectionDefault ${SEC_MEDIA} "Media"
    !insertmacro ApplySectionDefault ${SEC_OFFICE} "Office"
    !insertmacro ApplySectionDefault ${SEC_CHATARCHIVE} "ChatArchive"
    !insertmacro ApplySectionDefault ${SEC_CDRTOOL} "CdrTool"
    !insertmacro ApplySectionDefault ${SEC_SSWPHONE} "SswPhone"
    !insertmacro ApplySectionDefault ${SEC_PEPETHING} "PepeThing"
    !insertmacro ApplySectionDefault ${SEC_PEPEBOX} "PepeBox"
    !insertmacro ApplySectionDefault ${SEC_REMOTESHARE} "RemoteShare"

    ; PePe 본체(electron-builder 의 install 섹션)는 필수 — 컴포넌트 페이지에서 해제할 수 없게
    ; 읽기 전용(SF_RO)으로 고정하고, 이름도 "install" 대신 알아볼 수 있게 바꾼다.
    ;
    ; INSTALL_SECTION_ID 를 쓸 수 없다 — 이 파일은 electron-builder 스크립트보다 먼저 include
    ; 되고 customInit 도 그 Section 선언(installer.nsi 의 `Section "install" INSTALL_SECTION_ID`,
    ; 파일 기준 customInit 삽입 지점보다 뒤)보다 앞에서 확장돼서, 그 시점엔 정의가 없어
    ; "unknown variable/constant" 경고(=빌드 실패)가 났다.
    ; 섹션 인덱스 자체는 런타임엔 전부 유효하므로 템플릿의 원래 표시 이름("install")으로 찾는다.
    StrCpy $R5 0
    lbl_core_sec_loop:
      ClearErrors
      SectionGetText $R5 $R6
      ${If} ${Errors}
        Goto lbl_core_sec_done
      ${EndIf}
      ${If} $R6 == "install"
        SectionGetFlags $R5 $R4
        IntOp $R4 $R4 | ${SF_SELECTED}
        IntOp $R4 $R4 | ${SF_RO}
        SectionSetFlags $R5 $R4
        SectionSetText $R5 "PePe Terminal 본체 (필수)"
        !insertmacro DbgLog "customInit: core section found at index=$R5 -> RO"
        Goto lbl_core_sec_done
      ${EndIf}
      IntOp $R5 $R5 + 1
      ${If} $R5 < 40
        Goto lbl_core_sec_loop
      ${EndIf}
      !insertmacro DbgLog "customInit: core section NOT found (install 섹션 이름 변경?)"
    lbl_core_sec_done:

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
  !insertmacro MUI_PAGE_COMPONENTS
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
  ; 컴포넌트 페이지의 최종 선택 상태를 $XxxChecked (1/0) 로 읽어온다 — 아래 로직은 그대로 쓴다.
  !insertmacro ReadSectionChecked ${SEC_VPN} $VpnChecked
  !insertmacro ReadSectionChecked ${SEC_MICROSIP} $MicroSipChecked
  !insertmacro ReadSectionChecked ${SEC_SIPP} $SippChecked
  !insertmacro ReadSectionChecked ${SEC_MEDIA} $MediaChecked
  !insertmacro ReadSectionChecked ${SEC_OFFICE} $OfficeChecked
  !insertmacro ReadSectionChecked ${SEC_CHATARCHIVE} $ChatArchiveChecked
  !insertmacro ReadSectionChecked ${SEC_CDRTOOL} $CdrToolChecked
  !insertmacro ReadSectionChecked ${SEC_SSWPHONE} $SswPhoneChecked
  !insertmacro ReadSectionChecked ${SEC_PEPETHING} $PepeThingChecked
  !insertmacro ReadSectionChecked ${SEC_PEPEBOX} $PepeBoxChecked
  !insertmacro ReadSectionChecked ${SEC_REMOTESHARE} $RemoteShareChecked
  !insertmacro DbgLog "customInstall: enter DeleteDataChecked=$DeleteDataChecked VpnChecked=$VpnChecked MicroSipChecked=$MicroSipChecked SippChecked=$SippChecked MediaChecked=$MediaChecked OfficeChecked=$OfficeChecked SswPhoneChecked=$SswPhoneChecked CdrToolChecked=$CdrToolChecked ChatArchiveChecked=$ChatArchiveChecked PepeThingChecked=$PepeThingChecked PepeBoxChecked=$PepeBoxChecked"
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
  WriteRegStr HKCU "Software\PePeTerminal\Features" "CdrTool" "$CdrToolChecked"
  WriteRegStr HKCU "Software\PePeTerminal\Features" "ChatArchive" "$ChatArchiveChecked"
  ; Pepe-Thing / Pepe-Box 는 동봉 파일이 없어 파일 존재로 선택 여부를 알 수 없다 — 앱이
  ; features:get-available 에서 이 레지스트리 값을 읽어 메뉴 노출을 결정한다(SswPhone 과 동일).
  WriteRegStr HKCU "Software\PePeTerminal\Features" "PepeThing" "$PepeThingChecked"
  WriteRegStr HKCU "Software\PePeTerminal\Features" "PepeBox" "$PepeBoxChecked"
  WriteRegStr HKCU "Software\PePeTerminal\Features" "RemoteShare" "$RemoteShareChecked"

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
  !insertmacro ExtractOrSkipBundle $CdrToolChecked "calllog-cdr-tool" "calllog-cdr-tool" "SSW CDR 로그 분석"
  ; 대화 아카이브 검색의 AI 런타임 — 다른 번들과 달리 resources/ 아래 전용 폴더가 아니라
  ; app.asar.unpacked\node_modules 로 푼다. transformers 가 정적 import 하는 sharp / @img 가
  ; 이미 그 폴더에 있어서(앱 본체가 써서 항상 설치됨) 같은 node_modules 안에 있어야 Node 가
  ; 상위 탐색으로 찾는다 — 다른 위치로 풀면 그 20MB 를 번들에 중복으로 넣어야 한다.
  ; 자세한 배경은 electron/chatArchiveStore.ts 의 resolveTransformersSpecifier 주석 참고.
  !insertmacro ExtractOrSkipBundle $ChatArchiveChecked "chat-archive-ai" "app.asar.unpacked\node_modules" "대화 아카이브 검색(AI 런타임)"
  ; 원격 공유의 ws 패키지도 같은 위치로 — asar 에서 제외했으므로(package.json build.files)
  ; remoteShareServer 가 이 경로를 직접 require 한다.
  !insertmacro ExtractOrSkipBundle $RemoteShareChecked "remote-share" "app.asar.unpacked\node_modules" "원격 공유(WebRTC)"

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

  ; JRE(JDBC 사이드카용) 번들 압축 해제 — Temurin 배포본이 300개+ 개별 파일이라 X11 서버와
  ; 같은 이유로 loose 폴더 그대로 두면 NSIS File-by-file 복사가 느리다. 동일한 zip+tar 패턴.
  IfFileExists "$INSTDIR\resources\jre-win-x64.zip" 0 lbl_no_jre
    DetailPrint "▶ JRE(JDBC 사이드카) 번들 설치 중..."
    CreateDirectory "$INSTDIR\resources\jre"
    nsExec::ExecToLog 'cmd /c tar -xf "$INSTDIR\resources\jre-win-x64.zip" -C "$INSTDIR\resources\jre"'
    Pop $0
    ${If} $0 == 0
      DetailPrint "  ✓ JRE 설치 완료 (tar.exe)"
      Delete "$INSTDIR\resources\jre-win-x64.zip"
    ${Else}
      DetailPrint "  ⚠ tar.exe 실패 (code=$0) — PowerShell 폴백"
      nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path \"$INSTDIR\resources\jre-win-x64.zip\" -DestinationPath \"$INSTDIR\resources\jre\" -Force"'
      Pop $0
      ${If} $0 == 0
        DetailPrint "  ✓ JRE 설치 완료 (PowerShell)"
        Delete "$INSTDIR\resources\jre-win-x64.zip"
      ${Else}
        DetailPrint "  ✕ JRE 압축 해제 실패 — SQL Tool 기능이 동작하지 않을 수 있음"
      ${EndIf}
    ${EndIf}
  lbl_no_jre:

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
  ${if} ${FileExists} "$INSTDIR\resources\calllog-cdr-tool\*"
    nsExec::Exec 'cmd /c rmdir /S /Q "$INSTDIR\resources\calllog-cdr-tool"'
  ${endif}
  ${if} ${FileExists} "$INSTDIR\resources\jre\*"
    DetailPrint "JRE 폴더 삭제 중 (한 번에 처리)..."
    nsExec::Exec 'cmd /c rmdir /S /Q "$INSTDIR\resources\jre"'
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
