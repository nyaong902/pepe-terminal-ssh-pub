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
→ {"cmd":"register","endpoint":{"id","server","port","transport","username","authId","password","displayName","proxy","codecs":["evs","amrwb","amr","alaw","ulaw"],"autoAnswer"}}
→ {"cmd":"unregister","endpointId":"ep-.."}
→ {"cmd":"call","endpointId":"ep-..","target":"1001"}
→ {"cmd":"hangup","endpointId":"ep-.."}
→ {"cmd":"dtmf","endpointId":"ep-..","digit":"1"}       // RFC2833
→ {"cmd":"audio","input":"<deviceId|>","output":"<deviceId|>"}
← {"ev":"reg","endpointId":"ep-..","reg":"registered|registering|failed|unregistered","error":"?"}
← {"ev":"call","endpointId":"ep-..","call":"calling|ringing|incoming|connected|held|ended","remote":"?"}
```
- 단말당 1개의 PJSUA account, 최대 10개 동시. 각 account 의 코덱 우선순위는 `pjsua_codec_set_priority` 로 endpoint.codecs 순서대로 설정.
- 오디오 장치: PJMEDIA snd dev 인덱스로 매핑(렌더러의 deviceId ↔ 데몬의 장치 목록 동기화 필요). 대안: 데몬이 장치 열거를 제공하고 UI 가 그 목록에서 선택.

## 현재 상태 (Phase 1)
`electron/sipSidecar.ts` 는 스켈레톤 — `ready=false`, 제어 호출은 안내 메시지 반환.
UI(`src/components/MicroSipWorkspace.tsx`)는 단말/설정/매크로 구성·저장은 동작하며, 데몬 연결 후 그대로 통화 가능.
