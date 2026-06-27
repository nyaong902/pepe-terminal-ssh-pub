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

## 빌드 (Windows, 예시)
1. pjproject 소스 받기 (MicroSIP 가 쓰는 버전 참고).
2. `config_site.h` 에 opencore-amr/vo-amrwbenc 경로 + `PJMEDIA_HAS_*` 활성.
3. EVS: 3GPP 레퍼런스 코드를 `pjmedia/src/pjmedia-codec/evs.c` 형태의 커스텀 코덱으로 추가하고 `pjmedia_codec_evs_init(endpt)` 등록.
4. 데몬(`pjsua2` C++ 또는 pjsua sample 변형)에 아래 stdio 프로토콜 어댑터를 붙여 빌드 → `sip-sidecar/bin/<platform>/sipd(.exe)`.
5. electron-builder `extraResources` 에 `sip-sidecar/bin` 포함, `sipSidecar.ts` 에서 spawn.

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
```
- 단말당 1개의 PJSUA account, 최대 10개 동시. 각 account 의 코덱 우선순위는 `pjsua_codec_set_priority` 로 endpoint.codecs 순서대로 설정.
- 오디오 장치: PJMEDIA snd dev 인덱스로 매핑(렌더러의 deviceId ↔ 데몬의 장치 목록 동기화 필요). 대안: 데몬이 장치 열거를 제공하고 UI 가 그 목록에서 선택.

## 현재 상태 (Phase 2)
- **Electron 측 연결 완료**: `electron/sipSidecar.ts` 가 `sipd` 를 child_process 로 spawn 하고
  stdin/stdout JSON 프로토콜로 제어/이벤트를 주고받는다. 바이너리가 없으면 `ready=false` 로 graceful.
- **데몬 소스 제공**: `src/sipd.cpp`(PJSUA2) + `CMakeLists.txt`. register/unregister/call/hangup/dtmf
  + reg/call 이벤트 + 코덱 우선순위 설정 구현.
- **남은 작업(네이티브 빌드 — 컴파일 툴체인/라이선스 필요)**:
  1. pjproject 를 opencore-amr / vo-amrwbenc 포함해 빌드.
  2. **EVS**: 3GPP 레퍼런스 코드를 PJMEDIA 커스텀 코덱으로 통합 후 `libInit` 직후 등록 (sipd.cpp 의 주석 위치).
  3. `cmake` 로 `sipd` 빌드 → `sip-sidecar/bin/<plat>/sipd(.exe)` 에 배치 (또는 `PEPE_SIPD` 환경변수로 경로 지정).
  4. 배포 시 electron-builder `extraResources` 에 `{ from: "sip-sidecar/bin", to: "sip-sidecar" }` 추가.

  ✔ 구현 완료(소스): answer/reject/hold/mute/transfer, 등록 만료·DTMF 방식·SRTP 설정,
    오디오 장치 매핑(데몬이 PJMEDIA 장치 목록을 `audio-devices` 이벤트로 제공 → UI 가 name 으로 선택 → `audio` 명령으로 setCaptureDev/setPlaybackDev),
    IM(pager MESSAGE, `Buddy::sendInstantMessage`) + 프레즌스(`Buddy` SUBSCRIBE/NOTIFY, `setOnlineStatus` 게시),
    NAT 통과(단말별 ICE/STUN/TURN — `natConfig` + 전역 `natUpdateStunServers`).

빌드된 `sipd` 가 경로에 있으면 MicroSIP 워크스페이스의 등록/통화/DTMF 가 그대로 동작한다.
