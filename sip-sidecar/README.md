# MicroSIP 워크스페이스 — 네이티브 PJSIP 사이드카 (Phase 2 사양)

Electron 렌더러/메인은 VoIP 미디어(RTP)와 AMR/AMR-WB/EVS 코덱을 직접 처리할 수 없으므로,
실제 SIP/RTP/코덱은 **PJSIP(PJSUA2) 기반 네이티브 데몬**이 담당하고 Electron 은 UI/제어만 한다.

```
[React UI]  ──IPC──  [electron main: sipSidecar.ts]  ──stdio(JSON/line)──  [native pjsua daemon]  ──UDP/TCP SIP+RTP──  [SIP 서버]
```

## 코덱
| 코덱 | 구현 | 비고 |
|---|---|---|
| ULAW(PCMU)/ALAW(PCMA) | PJMEDIA 내장 | 추가 작업 없음 |
| AMR-NB | `opencore-amr` (Apache-2.0) | PJSIP `--with-opencore-amr` 또는 PJMEDIA codec 등록 |
| AMR-WB | `opencore-amr`(decode) + `vo-amrwbenc`(encode) | 〃 |
| **EVS** | **3GPP TS 26.442/26.443 레퍼런스 C 코드** 를 PJMEDIA 커스텀 코덱으로 래핑 | PJSIP 미포함. **라이선스/특허 확인 필요**. 가장 난도 높음 |

## 빌드 (Windows) — ✅ 검증됨: G.711 + AMR + AMR-WB (MinGW, pjproject 2.17)

MinGW/MSYS2 경로로 빌드하면 **AMR/AMR-WB 코덱까지 한 번에** 포함된다(autotools 코덱 라이브러리와 ABI 일치). 아래 절차로 standalone `sipd.exe`(정적, ~15MB)를 생성·검증했다 — ready/audio-devices 핸드셰이크, AMR 코덱 임베드, MinGW 런타임 DLL 비의존 확인.

```sh
# 0) 툴체인 (1회): MSYS2 설치 후 mingw64 toolchain
winget install -e --id MSYS2.MSYS2
/c/msys64/usr/bin/bash -lc "pacman -Sy --noconfirm --needed \
  mingw-w64-x86_64-gcc make autoconf automake libtool pkgconf"
# 이후 모든 빌드는 MSYS2 bash + PATH=/mingw64/bin:/usr/bin, PKG_CONFIG_PATH=/mingw64/lib/pkgconfig

BUILD=/c/Users/<user>/pepe-sip-build
curl -fsSL --create-dirs -o "$BUILD/include/nlohmann/json.hpp" \
  https://github.com/nlohmann/json/releases/latest/download/json.hpp

# 1) AMR 코덱 라이브러리 → /mingw64 에 설치 (pjproject가 pkg-config 로 자동 탐지)
git clone --depth 1 https://github.com/BelledonneCommunications/opencore-amr.git
git clone --depth 1 https://github.com/Distrotech/vo-amrwbenc.git
for d in opencore-amr vo-amrwbenc; do
  (cd $d && autoreconf -i && ./configure --prefix=/mingw64 --disable-shared --enable-static && make -j4 && make install)
done   # → libopencore-amrnb/-amrwb/-vo-amrwbenc.a + .pc

# 2) pjproject (config_site.h: 영상 off / 한도 상향) → configure 가 AMR 자동 활성
git clone --depth 1 https://github.com/pjsip/pjproject.git
printf '#define PJMEDIA_HAS_VIDEO 0\n#define PJSUA_MAX_ACC 32\n#define PJSUA_MAX_CALLS 64\n' \
  > pjproject/pjlib/include/pj/config_site.h
(cd pjproject && ./configure --disable-shared --disable-video --disable-ssl && make dep && make)
#   configure 로그에 "AMR-NB support enabled" / "AMR-WB support enabled" 확인

# 3) sipd 링크 (pjproject build.mak 의 PJ_* 플래그 사용, 정적)
#    g++ -O2 -std=c++17 $(PJ_CFLAGS) -I$BUILD/include sipd.cpp \
#       $(PJ_LDFLAGS) -lpjsua2-x86_64-w64-mingw32 $(PJ_LDLIBS) \
#       -static -static-libgcc -static-libstdc++ -o sip-sidecar/bin/win-x64/sipd.exe
#    (PJ_LDLIBS 에 -lopencore-amrnb/-amrwb/-vo-amrwbenc 자동 포함. 전체 Makefile: pepe-sip-build/sipd.mak)
```
- 산출물 `sipd.exe`(정적 ~15MB): KERNEL32/msvcrt/ole32/winmm/ws2_32 등 **Win 표준 DLL 만** 의존(MinGW·VC++ 런타임 불필요) → 그대로 배포 가능.
- 배포: electron-builder `extraResources` 에 `{ from: "sip-sidecar/bin", to: "sip-sidecar" }`, 또는 `PEPE_SIPD` 환경변수. dev 는 `sip-sidecar/bin/win-x64/sipd.exe` 자동 탐색.
- (참고) MSVC v143 로도 빌드 가능하나 그 경로는 G.711 만 — AMR 은 위 MinGW 경로 권장.

### 코덱 현황
- **G.711 (ulaw/alaw)**: ✅ 동작 (pjproject 내장).
- **AMR-NB / AMR-WB**: ✅ 동작 (opencore-amr + vo-amrwbenc, 위 절차로 빌드·임베드 확인).
- **EVS**: 🔶 진행 중. 3GPP TS 26.443 레퍼런스(floating-point) **라이브러리 빌드 완료**, pjmedia 래퍼는 미완.

### EVS 빌드 (✅ 라이브러리까지 — `libevs.a`)
3GPP EVS 레퍼런스는 라이선스상 리포에 커밋하지 않고 `pepe-sip-build/evs-src` 에서 외부 빌드한다.
```sh
# 1) ETSI 소스 (브라우저 UA 필수 — 기본 curl UA 는 403)
curl -fSL -A "Mozilla/5.0" -e https://www.etsi.org/ -o ts_evs.zip \
  https://www.etsi.org/deliver/etsi_ts/126400_126499/126443/16.01.00_60/ts_126443v160100p0.zip
unzip ts_evs.zip && unzip 26443-*-ANSI-C_source_code.zip -d ccode   # → ccode/c-code (369 .c)
# 2) MinGW 호환 패치: lib_com/typedef.h 의 __unix__ 분기에
#    || defined(__MINGW32__) || defined(__MINGW64__) || defined(__GNUC__) 추가 (Word16 등 typedef)
# 3) 빌드 → 오브젝트를 정적 라이브러리로 (EVS_cod/EVS_dec 실행파일 링크 실패는 무시 — ntohs/ntohl 은 sipd 가 -lws2_32 로 해결)
cd ccode/c-code && make CC="gcc -std=gnu11 -fcommon -w"
find build -name '*.o' -print0 | xargs -0 ar rcs libevs.a   # → libevs.a (~39MB)
```
임베드 API: `init_encoder`/`evs_enc`/`destroy_encoder`(lib_enc), `init_decoder`/`evs_dec`/`destroy_decoder`(lib_dec).

**래퍼 구현 완료 → EVS 코덱 등록됨**: `src/evs_glue.c`(EVS 헤더 격리 thin C API: init_encoder/evs_enc/indices_to_serial, init_decoder/read_indices_from_djb/evs_dec) + `src/pjmedia_codec_evs.c`(pjmedia factory/ops, EVS Primary **WB 13.2kbps**, 16kHz/20ms/33B compact, 동적 PT). sipd 가 `PEPE_EVS` 빌드 시 libInit 직후 `pjmedia_codec_evs_init` 호출 → 기동 로그 `EVS codec register: ok`, SDP 에 `EVS/16000` 노출.

EVS 라이브러리 링크 시 AMR-WB/iLBC 와 **심볼 충돌**(enhancer/autocorr/dico*_isf/wb_vad 등 3GPP 공통명)이 나므로, libevs.a 를 단일 오브젝트로 합쳐 **9개 API 심볼만 global, 나머지 local화**한 `evs_local.o` 를 만들어 링크 맨 뒤에 둔다(+ CLI main 의 전역 `frame` 은 evs_glue.c 에서 정의):
```sh
cd evs-src/ccode/c-code
ar d libevs.a encoder.o decoder.o                       # CLI main(중복 main/frame) 제거
ld -r --whole-archive libevs.a --no-whole-archive -o evs_all.o
objcopy --keep-global-symbol=init_encoder --keep-global-symbol=evs_enc \
  --keep-global-symbol=reset_indices_enc --keep-global-symbol=indices_to_serial \
  --keep-global-symbol=destroy_encoder --keep-global-symbol=init_decoder \
  --keep-global-symbol=evs_dec --keep-global-symbol=read_indices_from_djb \
  --keep-global-symbol=destroy_decoder  evs_all.o evs_local.o
# sipd 링크: ... sipd.cpp evs_glue.o pjmedia_codec_evs.o $(PJ_LDFLAGS) -lpjsua2 $(PJ_LDLIBS) evs_local.o -Wl,--allow-multiple-definition -static ...
# (전체: pepe-sip-build/sipd_new.mak)
```
**남은 검증/조정(실 SIP 서버 interop)**: SDP fmtp(br/bw 등) 게이트웨이 요구치 매칭, compact↔header-full 페이로드, 실제 양방향 음성 확인. 현재 고정 13.2kbps WB compact 로 시작.

## 제어 프로토콜 (stdio, 1줄=1 JSON)
요청(→) / 이벤트(←):
```
→ {"cmd":"register","endpoint":{"id","server","domain","port","transport","username","authId","password","displayName","proxy","hideCallerId":false,"disableSessionTimer":false,"publishPresence":true,"mwiSubscribe":true,"codecs":["evs","amrwb","amr","alaw","ulaw"],"autoAnswer","dnd":false,"callWaiting":true,"keepAlive":15,"regExpiry":300,"dtmfMode":"rfc2833|info|inband(200ms 단일톤, 톤제너레이터로 마이크와 믹스)","srtp":"disabled|optional|mandatory","iceEnabled":false,"stunServer":"host:port","turnServer":"host:port","turnUser","turnPassword","rtpPortMin":0,"rtpPortMax":0,"localSipPort":0,"userAgent":"","contactForced":"","divertHeader":"(번호만)","rpidHeader":"(번호만)","paiHeader":"(번호만)","paiPrivacy":"none|header|session|user|id|critical","rejectCode":486,"rejectTiming":"immediate|after180","rejectDelaySec":0,"callerIdPriority":["rpid","from","pai"],"holdViaInfo":false,"rtpTimeoutSec":0}}
→ {"cmd":"unregister","endpointId":"ep-.."}
→ {"cmd":"call","endpointId":"ep-..","target":"1001"}
→ {"cmd":"hangup","endpointId":"ep-.."}
→ {"cmd":"answer","endpointId":"ep-.."}
→ {"cmd":"reject","endpointId":"ep-.."}   // endpoint 의 rejectCode/rejectTiming/rejectDelaySec 사용
→ {"cmd":"hold","endpointId":"ep-..","hold":true}    // holdViaInfo=true 계정은 재협상 대신 SIP INFO 플래시(0x10 04 00 00)로 신호
→ {"cmd":"mute","endpointId":"ep-..","mute":true}
→ {"cmd":"transfer","endpointId":"ep-..","target":"2002"}   // blind transfer(REFER)
→ {"cmd":"sendInfo","endpointId":"ep-..","header":"P-Enbloc-Info","value":"*20138012341234*"}  // 범용 in-dialog INFO(커스텀 헤더 1개)
→ {"cmd":"ctrTransfer","endpointId":"ep-..","digits":"20","number":"01012341234"}  // SSW CTR 전용: 보류신호→200ms→P-Enbloc-Info 포함 신호 순서 보장
→ {"cmd":"record","endpointId":"ep-..","on":true,"file":"C:/.../ep-..-<ts>.wav"}  // 통화 녹음(WAV)
→ {"cmd":"mediaPlay","endpointId":"ep-..","file":"C:/.../test.wav"}   // 통화 상대에게 WAV/MP3 재생 송출
→ {"cmd":"mediaStop","endpointId":"ep-.."}
→ {"cmd":"dtmf","endpointId":"ep-..","digit":"1"}          // dtmfMode 에 따라 RFC2833/SIP INFO
→ {"cmd":"audio","input":"<장치 name|>","output":"<장치 name|>"}  // 빈 값=기본 장치
→ {"cmd":"listAudio"}                                          // 오디오 장치 목록 요청
→ {"cmd":"volume","mic":1.0,"speaker":1.0}                     // 마이크/스피커 음량(1=기본, -1=변경안함)
→ {"cmd":"dnd","endpointId":"ep-..","dnd":true}                // 방해 금지(인입을 rejectCode/rejectTiming 대로 자동 거절)
→ {"cmd":"im","endpointId":"ep-..","target":"1001","text":"안녕"}      // pager MESSAGE 송신
→ {"cmd":"presence","endpointId":"ep-..","online":true}                // 자신의 프레즌스 게시
→ {"cmd":"subscribe","endpointId":"ep-..","target":"1001","subscribe":true}  // 상대 프레즌스 구독/해제
← {"ev":"reg","endpointId":"ep-..","reg":"registered|registering|failed|unregistered","error":"?"}
← {"ev":"call","endpointId":"ep-..","call":"calling|ringing|incoming|connected|held|ended","remote":"?"}   // remote 는 callerIdPriority 순서로 RPID/PAI/From 중 선택
← {"ev":"audio-devices","inputs":[{"idx":0,"name":".."}],"outputs":[{"idx":0,"name":".."}]}  // ready 직후 + listAudio 응답
← {"ev":"im","endpointId":"ep-..","from":"sip:1001@..","text":"안녕","dir":"in"}            // 수신 IM
← {"ev":"im-status","endpointId":"ep-..","to":"sip:1001@..","code":200,"reason":"OK"}       // 송신 IM 전달 상태
← {"ev":"presence","endpointId":"ep-..","buddy":"sip:1001@..","status":"online|offline|unknown","note":"?"}
← {"ev":"record","endpointId":"ep-..","recording":true,"file":"..","error":"?"}
← {"ev":"media","endpointId":"ep-..","playing":true,"file":"..","error":"?"}
← {"ev":"mwi","endpointId":"ep-..","waiting":true}   // 음성사서함(MWI NOTIFY)
```

### SSW(SKB) 콜플로우 정밀 이식 — MiniSoftphone(C#/SIPSorcery) 캡처 기준 (네이티브 재빌드 필요)
- `holdViaInfo` — true 면 보류/재개를 표준 re-INVITE 대신 in-dialog SIP INFO(`Content-Type: audio/telephone-event`, body `0x10 04 00 00`, `Supported: replaces`)로 신호한다. 실단말(MOIMSTONE) 캡처 기준 — SKB 교환기가 이 시그널링을 기대한다. SSW 소프트폰이 새로 만드는 단말은 기본 true, 일반 MicroSIP 계정은 기본 false(표준 서버 호환).
- CTR(호전환) 실행 직후엔 SSW 소프트폰 UI 의 보류 버튼이 "↩ 호전환 복귀"로 바뀐다(`EndpointRuntime.ctrActive`, MiniSoftphone: `_ctrTransferActive`). 눌러도 실제로 보내는 신호는 평소 보류와 완전히 동일(같은 INFO 플래시) — 순수 UI 상태 표시일 뿐, 다시 누르면(또는 통화 종료 시) 해제된다.
- `ctrTransfer` — CTR(호전환)을 ①보류신호(P-Enbloc 없음) → 200ms 대기 → ②같은 신호 + `P-Enbloc-Info: <sip:*20+번호+*@내Contact호스트>` 순서로 보낸다(캡처 기준 — 기존 `sendInfo` 두 번 연속 호출은 타이밍/바디/헤더 포맷이 달라 부정확했음). SSW 소프트폰 UI 상 CTR 버튼은 보류 중이 아니어도 활성 통화 중이면 활성화된다(MiniSoftphone: `HeldLine() ?? ActiveTalkingLine()` — 보류를 우선하되 없으면 활성 통화로 대체).
- **통화 중 두 번째 인입 — 진짜 통화중대기(2회선)는 없다.** MiniSoftphone 소스엔 `_lineA`/`_lineB`/`SwitchCwCall`/`AnswerWaitingAsync` 같은 2회선 스캐폴딩이 있어 한때 이걸 진짜 기능으로 오해해 이식(`g_waitingCalls`/`switchCall` 명령/UI 전환 버튼)했었으나, 재확인 결과 `_waitingUas`(대기 콜을 채워야 할 필드)에 값이 할당되는 코드가 전혀 없어 **죽은 코드**였다 — 실제로 실행되는 경로는 `callWaiting` 체크박스뿐이라 전부 되돌렸다: `callWaiting`(기본 on) 켜짐 → 항상 `486 Busy Here` + `Reason: Q.850;cause=17;text="User busy"` 로 거절, 꺼짐 → 아무 응답도 안 보내고 무시. 어느 쪽이든 두 번째 콜은 절대 연결/대기되지 않는다(기존 통화는 그대로 보존). DND 자동 거절은 별개로 기존처럼 `rejectCode`/`rejectTiming` 설정을 그대로 사용.
- `divertHeader`/`rpidHeader`/`paiHeader` 입력값은 이제 "번호만" — 데몬이 `<sip:번호@domain>;reason=unconditional;counter=1`(Diversion), `<sip:번호@domain:port>;party=calling;id-type=subscriber;privacy=off;screen=yes`(RPID), `<sip:번호@domain>`(PAI)로 자동 포맷한다(전에는 입력값을 그대로 헤더 값으로 보내 SBC 가 거부/무시할 수 있었음).
- `paiPrivacy` — `Privacy` 헤더(RFC 3323). `paiHeader` 가 있을 때만 같이 보냄(`hideCallerId`가 이미 `Privacy: id`를 넣었으면 중복 방지로 생략).
- `rtpTimeoutSec` — RTP 무응답(무음) 자동 종료(초), 0=사용 안 함. 보류 중(`MyCall::held`)인 통화는 감시 제외. 5초 간격 백그라운드 스레드(`rtpWatchdogLoop`)가 `Call::getStreamStat(0).rtcp.rxStat.pkt` 로 수신 패킷 변화를 감시. MiniSoftphone 기본 60초.
- `mwiSubscribe` — 음성사서함(MWI) SUBSCRIBE 여부, 기본 true. MiniSoftphone 은 SUBSCRIBE 를 전혀 하지 않고 순수 수동(NOTIFY 수신만) 이라 SSW 소프트폰은 기본 false.
- `authId` — INVITE 의 From 헤더(`op.txOption.localUri`)를 계정 번호 대신 이 값으로 override(비어있으면 기존과 동일). REGISTER 의 AOR/idUri 는 그대로 유지 — MiniSoftphone 은 로그인 계정과 표시 번호가 다른 트렁크에서 발신 From 을 authId 기준으로 만든다.
- REGISTER 요청에 항상 `Allow: ACK, BYE, CANCEL, INFO, INVITE, NOTIFY, OPTIONS, PRACK, REFER, REGISTER, SUBSCRIBE` 헤더를 명시(이전엔 pjsip 자동 생성 목록에 의존) — MiniSoftphone 과 동일한 고정 문자열.
- 자동응답(`autoAnswer`)은 이제 180 Ringing 을 먼저 보내고 1초 지연 후 200 OK(이전엔 180 자체를 생략하고 즉시 200) — MiniSoftphone 과 동일한 타이밍.
- SSW 소프트폰 신규 단말 기본값: `disableSessionTimer:true`(SKB SBC 가 세션타이머 refresh re-INVITE 와 충돌해 491→BYE 로 끊는 문제 회피 — MiniSoftphone 은 세션타이머 자체를 협상 안 함), `regExpiry:120`(MiniSoftphone 기본값, 일반 계정은 300 유지).
- **통화 중 재등록 지연 — 부분 포팅**: MiniSoftphone 은 진행 중인 호가 있으면 재등록을 15초 뒤로 미룬다. pjsip 의 만료 기반 자동 REGISTER 갱신(내부 타이머)은 pjsua2 공개 API 로 가로챌 훅이 없어(disable/delay 콜백 없음 — `AccountRegConfig.delayBeforeRefreshSec` 는 만료 몇 초 전에 보낼지 고정값일 뿐 통화 상태를 못 봄) 그대로 두지만, 우리가 직접 트리거하는 "설정 변경 → 재등록" 경로(`SswSoftphoneWorkspace.tsx` 의 `attemptReRegister`)는 앱에서 완전히 제어 가능하므로 통화/벨울림 중이면 15초 뒤로 재시도하도록 이미 막았다.
- `dtmfMode:"inband"` 구현 — `cmdDtmfInband`(`pjsua2::ToneGenerator`)가 표준 DTMF 주파수로 200ms 단일 톤을 만들어 통화 오디오에 믹스해서 보낸다(MiniSoftphone 은 동일 200ms/표준 주파수지만 마이크 바이트를 직접 톤으로 대체 — 우리는 PJSIP 컨퍼런스 브리지로 믹스, SBC 톤 검출 결과는 동일).

### 이전에 추가된 명령/필드 (네이티브 재빌드 필요 — 위 CTR/sendInfo 와 동일 상황)
- `rtpPortMin`/`rtpPortMax` — 계정별 RTP 포트 범위(`AccountConfig.mediaConfig.transportConfig`). 둘 다 0 이면 자동.
- `contactForced` — Contact 헤더 고정(`AccountSipConfig.contactForced`). 비우면 자동(권장).
- `divertHeader`/`rpidHeader`/`paiHeader` — 발신(INVITE) 시 Diversion/Remote-Party-ID/P-Asserted-Identity 헤더 추가(값 있을 때만).
- `rejectCode`/`rejectTiming`/`rejectDelaySec` — 수신 거절(수동 거절 버튼, DND/통화중대기 자동 거절 공통) 시 보낼 상태 코드와 타이밍. `after180`이면 180 송신 후 `rejectDelaySec`초 뒤 별도 스레드로 최종 코드 전송.
- `callerIdPriority` — 수신 시 표시할 발신번호를 고를 헤더 우선순위(`rpid`/`from`/`pai`). `SipRxData.wholeMsg` 원문에서 헤더 줄을 직접 찾는다(저수준 `pjsip_msg` API 미사용).
- `mediaPlay`/`mediaStop` — `AudioMediaPlayer` 로 WAV/MP3 파일을 통화 상대에게 재생 송출(`record`와 대칭 구조, `g_players` 로 추적).
- 단말당 1개의 PJSUA account, 최대 10개 동시. 각 account 의 코덱 우선순위는 `pjsua_codec_set_priority` 로 endpoint.codecs 순서대로 설정.
- 오디오 장치: PJMEDIA snd dev 인덱스로 매핑(렌더러의 deviceId ↔ 데몬의 장치 목록 동기화 필요). 대안: 데몬이 장치 열거를 제공하고 UI 가 그 목록에서 선택.

## 현재 상태 (Phase 2)
- **Electron 연결 완료**: `electron/sipSidecar.ts` 가 `sipd` 를 spawn, stdin/stdout JSON 으로 제어/이벤트. 바이너리 없으면 `ready=false` graceful.
- **데몬 빌드·구동 검증 완료(✅)**: `src/sipd.cpp`(PJSUA2)를 pjproject 2.17(MinGW/x64)에 링크해 standalone `sip-sidecar/bin/win-x64/sipd.exe`(정적 ~15MB) 생성. ready/audio-devices 핸드셰이크·실장치 열거 정상, **G.711 + AMR-NB + AMR-WB 코덱 임베드 확인**. 전 제어 명령(register/call/answer/reject/hold/mute/transfer/record/dtmf/audio/volume/dnd/im/presence/subscribe) 구현.
- **남은 작업**:
  1. **EVS** — 3GPP 레퍼런스(라이선스) 통합 후 `libInit` 직후 등록(`sipd.cpp` 주석 위치). 자동 취득 불가.
  2. 배포 시 electron-builder `extraResources` 에 `{ from: "sip-sidecar/bin", to: "sip-sidecar" }` 추가(또는 `PEPE_SIPD`). mac/linux 는 동일 절차로 각 플랫폼에서 빌드.

빌드된 `sipd` 가 경로에 있으면 MicroSIP 워크스페이스의 등록/통화/IM/프레즌스/녹음 등 전 기능이 **G.711·AMR·AMR-WB** 로 그대로 동작한다. EVS 만 위 통합 후 활성화된다.
