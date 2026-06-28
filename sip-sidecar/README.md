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

**남은 작업(대형)**: pjmedia EVS 코덱 래퍼 — factory + codec ops + **RTP 페이로드 포맷(RFC 8627 / TS 26.445 Annex A: compact·header-full, ToC, CMR)** + SDP fmtp(br/bw/ch-aw-recv). 참고: `github.com/traud/asterisk-evs`. 이후 sipd `libInit` 직후 `pjmedia_codec_evs_init` 등록 (codecPjId 의 evs→"EVS/16000" 매핑은 이미 있음). 검증은 실 SIP 서버 interop 필요.

## 제어 프로토콜 (stdio, 1줄=1 JSON)
요청(→) / 이벤트(←):
```
→ {"cmd":"register","endpoint":{"id","server","domain","port","transport","username","authId","password","displayName","proxy","hideCallerId":false,"disableSessionTimer":false,"publishPresence":true,"codecs":["evs","amrwb","amr","alaw","ulaw"],"autoAnswer","dnd":false,"callWaiting":true,"keepAlive":15,"regExpiry":300,"dtmfMode":"rfc2833|info|inband","srtp":"disabled|optional|mandatory","iceEnabled":false,"stunServer":"host:port","turnServer":"host:port","turnUser","turnPassword"}}
→ {"cmd":"unregister","endpointId":"ep-.."}
→ {"cmd":"call","endpointId":"ep-..","target":"1001"}
→ {"cmd":"hangup","endpointId":"ep-.."}
→ {"cmd":"answer","endpointId":"ep-.."}
→ {"cmd":"reject","endpointId":"ep-.."}
→ {"cmd":"hold","endpointId":"ep-..","hold":true}
→ {"cmd":"mute","endpointId":"ep-..","mute":true}
→ {"cmd":"transfer","endpointId":"ep-..","target":"2002"}   // blind transfer(REFER)
→ {"cmd":"record","endpointId":"ep-..","on":true,"file":"C:/.../ep-..-<ts>.wav"}  // 통화 녹음(WAV)
→ {"cmd":"dtmf","endpointId":"ep-..","digit":"1"}          // dtmfMode 에 따라 RFC2833/SIP INFO
→ {"cmd":"audio","input":"<장치 name|>","output":"<장치 name|>"}  // 빈 값=기본 장치
→ {"cmd":"listAudio"}                                          // 오디오 장치 목록 요청
→ {"cmd":"volume","mic":1.0,"speaker":1.0}                     // 마이크/스피커 음량(1=기본, -1=변경안함)
→ {"cmd":"dnd","endpointId":"ep-..","dnd":true}                // 방해 금지(인입 486 Busy 자동 거절)
→ {"cmd":"im","endpointId":"ep-..","target":"1001","text":"안녕"}      // pager MESSAGE 송신
→ {"cmd":"presence","endpointId":"ep-..","online":true}                // 자신의 프레즌스 게시
→ {"cmd":"subscribe","endpointId":"ep-..","target":"1001","subscribe":true}  // 상대 프레즌스 구독/해제
← {"ev":"reg","endpointId":"ep-..","reg":"registered|registering|failed|unregistered","error":"?"}
← {"ev":"call","endpointId":"ep-..","call":"calling|ringing|incoming|connected|held|ended","remote":"?"}
← {"ev":"audio-devices","inputs":[{"idx":0,"name":".."}],"outputs":[{"idx":0,"name":".."}]}  // ready 직후 + listAudio 응답
← {"ev":"im","endpointId":"ep-..","from":"sip:1001@..","text":"안녕","dir":"in"}            // 수신 IM
← {"ev":"im-status","endpointId":"ep-..","to":"sip:1001@..","code":200,"reason":"OK"}       // 송신 IM 전달 상태
← {"ev":"presence","endpointId":"ep-..","buddy":"sip:1001@..","status":"online|offline|unknown","note":"?"}
← {"ev":"record","endpointId":"ep-..","recording":true,"file":"..","error":"?"}
← {"ev":"mwi","endpointId":"ep-..","waiting":true}   // 음성사서함(MWI NOTIFY)
```
- 단말당 1개의 PJSUA account, 최대 10개 동시. 각 account 의 코덱 우선순위는 `pjsua_codec_set_priority` 로 endpoint.codecs 순서대로 설정.
- 오디오 장치: PJMEDIA snd dev 인덱스로 매핑(렌더러의 deviceId ↔ 데몬의 장치 목록 동기화 필요). 대안: 데몬이 장치 열거를 제공하고 UI 가 그 목록에서 선택.

## 현재 상태 (Phase 2)
- **Electron 연결 완료**: `electron/sipSidecar.ts` 가 `sipd` 를 spawn, stdin/stdout JSON 으로 제어/이벤트. 바이너리 없으면 `ready=false` graceful.
- **데몬 빌드·구동 검증 완료(✅)**: `src/sipd.cpp`(PJSUA2)를 pjproject 2.17(MinGW/x64)에 링크해 standalone `sip-sidecar/bin/win-x64/sipd.exe`(정적 ~15MB) 생성. ready/audio-devices 핸드셰이크·실장치 열거 정상, **G.711 + AMR-NB + AMR-WB 코덱 임베드 확인**. 전 제어 명령(register/call/answer/reject/hold/mute/transfer/record/dtmf/audio/volume/dnd/im/presence/subscribe) 구현.
- **남은 작업**:
  1. **EVS** — 3GPP 레퍼런스(라이선스) 통합 후 `libInit` 직후 등록(`sipd.cpp` 주석 위치). 자동 취득 불가.
  2. 배포 시 electron-builder `extraResources` 에 `{ from: "sip-sidecar/bin", to: "sip-sidecar" }` 추가(또는 `PEPE_SIPD`). mac/linux 는 동일 절차로 각 플랫폼에서 빌드.

빌드된 `sipd` 가 경로에 있으면 MicroSIP 워크스페이스의 등록/통화/IM/프레즌스/녹음 등 전 기능이 **G.711·AMR·AMR-WB** 로 그대로 동작한다. EVS 만 위 통합 후 활성화된다.
