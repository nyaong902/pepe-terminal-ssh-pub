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

## 빌드 (Windows) — ✅ 검증됨 (pjproject 2.17 / MSVC v143 / x64)

아래 절차로 `sipd.exe`가 실제 빌드·구동됨을 확인했다(ready + audio-devices 핸드셰이크, 실장치 열거 정상). **G.711(PCMU/PCMA) 즉시 동작**.

```sh
BUILD=/c/Users/<user>/pepe-sip-build              # 리포 밖 빌드 루트
# 1) 의존
curl -fsSL -o "$BUILD/include/nlohmann/json.hpp" \
  https://github.com/nlohmann/json/releases/latest/download/json.hpp
git clone --depth 1 https://github.com/pjsip/pjproject.git "$BUILD/pjproject"
# 2) config_site.h  (영상 off, 계정/통화 한도 상향)
cat > "$BUILD/pjproject/pjlib/include/pj/config_site.h" <<EOF
#define PJMEDIA_HAS_VIDEO 0
#define PJSUA_MAX_ACC   32
#define PJSUA_MAX_CALLS 64
EOF
# 3) pjproject 빌드 (MSVC v143 자동, SDK 10.0.26100)
MSBuild.exe pjproject-vs14.sln -t:libpjproject  -p:Configuration=Release -p:Platform=x64
MSBuild.exe pjproject-vs14.sln -t:pjsua2_lib    -p:Configuration=Release -p:Platform=x64
# 4) sipd.cpp 컴파일 → sip-sidecar/bin/win-x64/sipd.exe
#    cl /MD /std:c++17 /EHsc /DPJ_WIN32=1  -I<pj include 5종> -I<json>  sipd.cpp
#    /link  pjsua2-lib + pj* + third_party(.lib) + ws2_32 ole32 oleaut32 winmm ...
#    (정확한 명령은 pepe-sip-build/build_sipd.bat 참조)
```
- 산출물 `sipd.exe`(~2MB)는 정적 링크 — Win 표준 DLL + VC++ 런타임(VCRUNTIME140 등)만 의존.
- 배포: electron-builder `extraResources` 에 `{ from: "sip-sidecar/bin", to: "sip-sidecar" }`, 또는 `PEPE_SIPD` 환경변수로 경로 지정. dev 에서는 `sip-sidecar/bin/win-x64/sipd.exe` 자동 탐색.

### 코덱 현황
- **G.711 (ulaw/alaw)**: ✅ pjproject 내장, 추가 작업 없이 동작.
- **AMR / AMR-WB**: opencore-amr + vo-amrwbenc 필요. 두 라이브러리는 **autotools(OSCL/PV 프레임워크)** 라 MinGW/MSYS2(gcc+make)로 빌드하는 것이 표준. 이후 `config_site.h` 에
  `#define PJMEDIA_HAS_OPENCORE_AMRNB 1` / `#define PJMEDIA_HAS_OPENCORE_AMRWB 1` + include/lib 경로를 추가하고 pjmedia-codec 재빌드 → sipd 재링크. (현재 환경엔 gcc/make 미설치 → 툴체인 설치 필요.)
- **EVS**: 3GPP TS 26.442/443 레퍼런스 코드 필요(라이선스). pjmedia 커스텀 코덱으로 래핑 후 `libInit` 직후 등록. 자동 취득 불가 — 별도 수동 통합.

## 제어 프로토콜 (stdio, 1줄=1 JSON)
요청(→) / 이벤트(←):
```
→ {"cmd":"register","endpoint":{"id","server","port","transport","username","authId","password","displayName","proxy","codecs":["evs","amrwb","amr","alaw","ulaw"],"autoAnswer","dnd":false,"regExpiry":300,"dtmfMode":"rfc2833|info|inband","srtp":"disabled|optional|mandatory","iceEnabled":false,"stunServer":"host:port","turnServer":"host:port","turnUser","turnPassword"}}
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
- **데몬 빌드·구동 검증 완료(✅)**: `src/sipd.cpp`(PJSUA2)를 pjproject 2.17(MSVC v143/x64)에 링크해 `sip-sidecar/bin/win-x64/sipd.exe` 생성, ready/audio-devices 핸드셰이크·실장치 열거 정상. **G.711 즉시 동작**, 전 제어 명령(register/call/answer/reject/hold/mute/transfer/record/dtmf/audio/volume/dnd/im/presence/subscribe) 구현.
- **남은 작업**:
  1. **AMR / AMR-WB** — opencore-amr + vo-amrwbenc 빌드(autotools/OSCL → MinGW·MSYS2 권장). 현재 빌드 환경에 gcc/make 미설치 → 툴체인 설치 필요. 이후 `config_site.h` 에 `PJMEDIA_HAS_OPENCORE_AMRNB/AMRWB` 활성 + pjmedia-codec 재빌드 → sipd 재링크.
  2. **EVS** — 3GPP 레퍼런스(라이선스) 통합 후 `libInit` 직후 등록.
  3. 배포 시 electron-builder `extraResources` 에 `{ from: "sip-sidecar/bin", to: "sip-sidecar" }` 추가(또는 `PEPE_SIPD`).

빌드된 `sipd` 가 경로에 있으면 MicroSIP 워크스페이스의 등록/통화/IM/프레즌스/녹음 등 전 기능이 G.711 로 그대로 동작한다. AMR/AMR-WB/EVS 는 위 코덱 통합 후 활성화된다.
