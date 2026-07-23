// sip-sidecar/src/sipd.cpp
// MicroSIP 워크스페이스용 네이티브 SIP 데몬 (PJSUA2 기반).
//
// Electron(electron/sipSidecar.ts)이 이 프로세스를 spawn 하고 stdin/stdout 으로
// 1줄=1 JSON 메시지를 주고받는다.
//   ← stdin(제어): {"cmd":"register","endpoint":{...}} / unregister / call / hangup / dtmf / audio / quit
//   → stdout(이벤트): {"ev":"ready"} / {"ev":"reg",...} / {"ev":"call",...} / {"ev":"log",...} / {"ev":"error",...}
//
// 의존:
//   - PJSIP/PJSUA2 (pjproject) — opencore-amr(AMR-NB), vo-amrwbenc(AMR-WB), EVS(커스텀 플러그인) 포함 빌드
//   - nlohmann/json (header-only)  https://github.com/nlohmann/json
//
// EVS: PJSIP 기본 미포함. 3GPP TS 26.442/443 레퍼런스 코드를 PJMEDIA 코덱으로 래핑한 뒤
//      lib.libInit 이후 pjmedia_codec_evs_init(endpt) 로 등록해야 "EVS/16000" 우선순위 지정이 동작한다.

#include <pjsua2.hpp>
#include <nlohmann/json.hpp>
#include <iostream>
#include <string>
#include <map>
#include <mutex>
#include <memory>
#include <thread>
#include <chrono>
#include <vector>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#ifdef _WIN32
#include <strings.h>  // MinGW-w64: strncasecmp
#endif

using namespace pj;
using json = nlohmann::json;

#ifdef _WIN32
#include <windows.h>
// Windows PJSIP 장치 이름은 시스템 ANSI 코드페이지(한국어 → CP949) 인데 nlohmann::json 은
// UTF-8 만 받아 type_error 316 으로 throw → sipd 가 비정상 종료. 모든 외부 문자열을 UTF-8 로 정규화.
static std::string toUtf8(const std::string& s) {
    if (s.empty()) return s;
    // 이미 valid UTF-8 인지 빠른 검사 (>=0x80 가 잘 짜인 다중바이트 시퀀스인지)
    const unsigned char* p = (const unsigned char*)s.c_str();
    bool nonAscii = false;
    for (size_t i = 0; i < s.size(); ++i) if (p[i] >= 0x80) { nonAscii = true; break; }
    if (!nonAscii) return s;
    auto isUtf8 = [&]() {
        size_t i = 0;
        while (i < s.size()) {
            unsigned c = p[i];
            size_t need;
            if (c < 0x80) { i++; continue; }
            else if ((c & 0xE0) == 0xC0) need = 1;
            else if ((c & 0xF0) == 0xE0) need = 2;
            else if ((c & 0xF8) == 0xF0) need = 3;
            else return false;
            if (i + need >= s.size()) return false;
            for (size_t k = 1; k <= need; ++k) if ((p[i + k] & 0xC0) != 0x80) return false;
            i += need + 1;
        }
        return true;
    };
    if (isUtf8()) return s;
    // ANSI(CP_ACP) → UTF-16 → UTF-8
    int wlen = MultiByteToWideChar(CP_ACP, 0, s.c_str(), (int)s.size(), nullptr, 0);
    if (wlen <= 0) return "?";
    std::wstring w(wlen, 0);
    MultiByteToWideChar(CP_ACP, 0, s.c_str(), (int)s.size(), &w[0], wlen);
    int ulen = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), wlen, nullptr, 0, nullptr, nullptr);
    if (ulen <= 0) return "?";
    std::string u(ulen, 0);
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), wlen, &u[0], ulen, nullptr, nullptr);
    return u;
}
// 역방향 — pjsip 의 파일 열기(pj_file_open → pj_ansi_to_unicode)는 내부적으로 항상
// MultiByteToWideChar(CP_ACP, ...) 로 좁은 문자열을 해석한다. 우리가 JSON(UTF-8)으로 받은 파일
// 경로(예: 한글 경로의 WAV)를 그대로 넘기면 ACP 로 잘못 해석돼 파일을 못 찾는다(PJ_ENOTFOUND) —
// 미디어 재생/녹음 파일 경로는 반드시 이 함수로 시스템 ANSI 코드페이지로 변환한 뒤 넘겨야 한다.
static std::string toAnsi(const std::string& utf8) {
    if (utf8.empty()) return utf8;
    int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), nullptr, 0);
    if (wlen <= 0) return utf8;
    std::wstring w(wlen, 0);
    MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), &w[0], wlen);
    int alen = WideCharToMultiByte(CP_ACP, 0, w.c_str(), wlen, nullptr, 0, nullptr, nullptr);
    if (alen <= 0) return utf8;
    std::string a(alen, 0);
    WideCharToMultiByte(CP_ACP, 0, w.c_str(), wlen, &a[0], alen, nullptr, nullptr);
    return a;
}
#else
static std::string toUtf8(const std::string& s) { return s; }
static std::string toAnsi(const std::string& s) { return s; }
#endif

#ifdef PEPE_EVS
/* EVS 커스텀 코덱 등록 (pjmedia_codec_evs.c) + pjsua 미디어 엔드포인트 획득 */
extern "C" pj_status_t pjmedia_codec_evs_init(pjmedia_endpt *endpt);
extern "C" pjmedia_endpt *pjsua_get_pjmedia_endpt(void);
#endif

static std::mutex g_out;
// 비-UTF-8 바이트(예: SIP 본문 안의 CP949 한글, 바이너리) → '?'  로 치환해 nlohmann::json
// 검증 실패(throw) 방지. ASCII < 0x80 은 그대로.
static std::string sanitizeUtf8(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ) {
        unsigned char c = (unsigned char)s[i];
        if (c < 0x80) { out.push_back((char)c); i++; continue; }
        // multi-byte: validate
        int need = 0;
        if ((c & 0xE0) == 0xC0) need = 1;
        else if ((c & 0xF0) == 0xE0) need = 2;
        else if ((c & 0xF8) == 0xF0) need = 3;
        else { out.push_back('?'); i++; continue; }
        if (i + need >= s.size()) { out.push_back('?'); i++; continue; }
        bool ok = true;
        for (int k = 1; k <= need; k++) if (((unsigned char)s[i + k] & 0xC0) != 0x80) { ok = false; break; }
        if (ok) { out.append(s, i, need + 1); i += need + 1; }
        else { out.push_back('?'); i++; }
    }
    return out;
}
static json sanitizeJson(json j) {
    if (j.is_string()) j = sanitizeUtf8(j.get<std::string>());
    else if (j.is_object()) for (auto& it : j.items()) it.value() = sanitizeJson(it.value());
    else if (j.is_array()) for (auto& el : j) el = sanitizeJson(el);
    return j;
}
static void emitJson(const json& j) {
    std::lock_guard<std::mutex> lk(g_out);
    try {
        std::cout << j.dump() << "\n";
        std::cout.flush();
    } catch (...) {
        // 비-UTF-8 으로 dump 실패 — 모든 문자열 sanitize 후 재시도. 그래도 실패면 포기.
        try {
            std::cout << sanitizeJson(j).dump() << "\n";
            std::cout.flush();
        } catch (...) {}
    }
}
static void emitLog(const std::string& level, const std::string& text) {
    emitJson({{"ev", "log"}, {"level", level}, {"text", text}});
}

// endpoint.codecs(["evs","amrwb","amr","alaw","ulaw"]) → PJMEDIA codec id 매핑
static std::string codecPjId(const std::string& c) {
    if (c == "ulaw")  return "PCMU/8000";
    if (c == "alaw")  return "PCMA/8000";
    if (c == "amr")   return "AMR/8000";
    if (c == "amrwb") return "AMR-WB/16000";
    if (c == "evs")   return "EVS/16000";   // 커스텀 EVS 플러그인 등록 시
    return "";
}

// endpointId → AOR(user@domain) 매핑 — SIP 메시지에서 어느 단말 트래픽인지 매칭하는 데 사용.
// (cmdRegister 에서 채워지고, cmdUnregister 에서 정리됨)
static std::map<std::string, std::string> g_accountAor;
// endpointId → server (등록 registrar host) — 시퀀스 뷰의 "원격" 컬럼 그룹화에 사용.
static std::map<std::string, std::string> g_accountServer;
// endpointId → 계정 생성 시 실제로 바인딩된 localSipPort. PJSUA2 Account::modify() 는 이미
// create() 된 계정의 전송(transport)을 바꾸지 못한다(전송은 생성 시점에 고정) — 그래서 설정에서
// 로컬 SIP 포트 값만 바꾸고 저장해도 modify() 경로로는 실제 포트가 그대로 유지되는 버그가 있었다
// (실사용 테스트로 확인: 5060 으로 바꿔 저장해도 REGISTER/INVITE 가 계속 예전 자동 포트로 나감).
// 이 값과 새 localSipPort 가 다르면 계정을 완전히 지우고 다시 만들어야 한다.
static std::map<std::string, int> g_accountLocalPort;
// Request-URI (요청 메시지 첫 줄) 의 sip URI 에서 user@host 추출.
// 응답(SIP/2.0 ...) 면 빈 문자열.
static std::string extractRequestUriAor(const std::string& body) {
    size_t e = body.find('\n');
    std::string first = body.substr(0, e == std::string::npos ? body.size() : e);
    while (!first.empty() && first.back() == '\r') first.pop_back();
    if (first.compare(0, 7, "SIP/2.0") == 0) return ""; // response
    size_t s = first.find("sip:");
    if (s == std::string::npos) s = first.find("sips:");
    if (s == std::string::npos) return "";
    s = first.find(':', s) + 1;
    size_t end = s;
    while (end < first.size() && first[end] != ';' && first[end] != ' ' && first[end] != ',' && first[end] != '?' && first[end] != '>') end++;
    std::string aor = first.substr(s, end - s);
    size_t colon = aor.find(':');
    if (colon != std::string::npos) aor = aor.substr(0, colon);
    return aor;
}
// 지정한 헤더(From:/To:) 의 sip URI 에서 user@host 부분 추출. 포트/파라미터 제외.
// 본문은 CRLF/줄바꿈 혼재 가능 — case-insensitive 헤더 매칭.
static std::string extractHeaderAor(const std::string& body, const char* hdrName, const char* hdrShort) {
    size_t hlen = std::strlen(hdrName);
    size_t slen = std::strlen(hdrShort);
    std::string line;
    for (size_t pos = 0; pos < body.size(); ) {
        size_t end = body.find('\n', pos);
        if (end == std::string::npos) end = body.size();
        size_t lineLen = end - pos;
        // strip \r
        if (lineLen > 0 && body[pos + lineLen - 1] == '\r') lineLen--;
        bool match = false;
        if (lineLen > hlen && strncasecmp(body.c_str() + pos, hdrName, hlen) == 0 && (body[pos + hlen] == ':' || body[pos + hlen] == ' ')) match = true;
        else if (lineLen > slen && strncasecmp(body.c_str() + pos, hdrShort, slen) == 0 && (body[pos + slen] == ':' || body[pos + slen] == ' ')) match = true;
        if (match) { line.assign(body.c_str() + pos, lineLen); break; }
        pos = end + 1;
    }
    if (line.empty()) return "";
    size_t s = line.find("sip:");
    if (s == std::string::npos) s = line.find("sips:");
    if (s == std::string::npos) return "";
    s = line.find(':', s) + 1;
    size_t e = s;
    while (e < line.size() && line[e] != '>' && line[e] != ';' && line[e] != ' ' && line[e] != ',' && line[e] != '?') e++;
    std::string aor = line.substr(s, e - s);
    size_t colon = aor.find(':');
    if (colon != std::string::npos) aor = aor.substr(0, colon);
    return aor;
}
// pjsua_acc_id → epId 변환. g_accounts 의 MyAccount->getId() 가 pjsua_acc_id 와 동일.
static std::string lookupEpIdByAccId(int accId);
// SIP 메시지 캡처 — PJSIP 모듈 콜백으로 RX/TX 양방향 가로채기. pjsip_msg_print 로 전체
// 헤더+본문을 텍스트화해 UI 콜로그에 emit.
// peer_ip — RX 면 src_addr (보낸 측), TX 면 dst (받는 측) — 시퀀스 뷰의 원격 컬럼 그룹화에 사용.
static void emitSipMsg(const char* dir, pjsip_msg* msg, int acc_id_hint = -1, const std::string& peer_ip = "") {
    if (!msg) return;
    char buf[16384];
    int n = pjsip_msg_print(msg, buf, sizeof(buf) - 1);
    if (n <= 0) return;
    buf[n] = 0;
    std::string body(buf, (size_t)n);
    size_t end = body.find('\n');
    std::string first = body.substr(0, end == std::string::npos ? body.size() : end);
    while (!first.empty() && (first.back() == '\r' || first.back() == ' ')) first.pop_back();
    while (!body.empty() && (body.back() == '\n' || body.back() == '\r' || body.back() == ' ')) body.pop_back();
    if (first.empty()) return;
    std::string epId;
    bool isOut = (std::string(dir) == "out");
    bool isResponse = (first.compare(0, 7, "SIP/2.0") == 0);
    // 매칭 — 우리 쪽 단말이 어느 헤더에 들어있는지는 메시지 종류에 따라 다름:
    //  TX request (보낸 요청):       From = 우리(요청자), Contact = 우리(우리가 실어보낸 값)
    //  TX response (보낸 응답):      To   = 우리(응답자), Contact = 우리(우리가 실어보낸 값)
    //  RX request (받은 요청):       To/RURI = 우리(피호출자) — Contact 은 "상대(발신자)" 것이라
    //                                 절대 우리 후보가 될 수 없다(체크하면 안 됨).
    //  RX response (받은 응답):      From = 우리(원래 요청자) — Contact 은 "상대(응답자)" 것이라
    //                                 마찬가지로 우리 후보가 될 수 없다.
    // (예전엔 RX 쪽에서도 Contact 를 후보로 넣었는데, 같은 sipd 프로세스에 등록된 다른 단말의
    //  Contact 가 우연히 "우리"(엉뚱한 다른 단말) 의 AOR 문자열과 일치해버리면 착신 메시지가
    //  전혀 무관한 단말로 오매칭되는 버그가 있었다 — 실사용에서 재현·확인됨.)
    auto tryMatch = [&](const std::string& aor) {
        if (aor.empty()) return false;
        for (const auto& p : g_accountAor) if (p.second == aor) { epId = p.first; return true; }
        return false;
    };
    if (isOut && !isResponse) {
        tryMatch(extractHeaderAor(body, "From", "f"))
        || tryMatch(extractRequestUriAor(body))
        || tryMatch(extractHeaderAor(body, "Contact", "m"));
    } else if (isOut && isResponse) {
        tryMatch(extractHeaderAor(body, "To", "t"))
        || tryMatch(extractHeaderAor(body, "Contact", "m"));
    } else if (!isOut && !isResponse) {
        tryMatch(extractRequestUriAor(body))
        || tryMatch(extractHeaderAor(body, "To", "t"));
    } else { // RX response
        tryMatch(extractHeaderAor(body, "From", "f"));
    }
    // 최종 fallback — 우리 쪽 헤더에서만 user-part 매칭 (SBC 가 도메인 재작성하는 경우 대비).
    if (epId.empty()) {
        std::string ourHdr;
        if (isOut && !isResponse)      ourHdr = extractHeaderAor(body, "From", "f");
        else if (isOut && isResponse)  ourHdr = extractHeaderAor(body, "To", "t");
        else if (!isOut && !isResponse) {
            ourHdr = extractRequestUriAor(body);
            if (ourHdr.empty()) ourHdr = extractHeaderAor(body, "To", "t");
        } else                          ourHdr = extractHeaderAor(body, "From", "f");
        size_t at = ourHdr.find('@');
        std::string userPart = at != std::string::npos ? ourHdr.substr(0, at) : "";
        if (!userPart.empty()) {
            for (const auto& p : g_accountAor) {
                size_t at2 = p.second.find('@');
                if (at2 == std::string::npos || at2 == 0) continue;
                if (p.second.substr(0, at2) == userPart) { epId = p.first; break; }
            }
        }
    }
    // 원격 — IP (peer_ip, 전송 계층 가장 정확) + 호스트명(등록된 server). 프런트가 둘 다 표시.
    std::string remoteIp = peer_ip;
    std::string remoteName;
    if (!epId.empty()) {
        auto it = g_accountServer.find(epId);
        if (it != g_accountServer.end()) remoteName = it->second;
    }
    if (remoteIp.empty() && remoteName.empty()) {
        std::string uri = isOut ? extractRequestUriAor(body) : extractHeaderAor(body, "From", "f");
        size_t at = uri.find('@');
        if (at != std::string::npos) remoteName = uri.substr(at + 1);
    }
    (void)acc_id_hint;
    // 진단 로그 — 통화 관련 메시지인데 어느 단말 것인지 끝내 못 찾은 경우, 실제 헤더 값을 남긴다.
    // (2026-07 — 같은 PBX 안의 두 단말 간 통화에서 착신 측 메시지가 시퀀스에서 통째로 빠지는
    // 현상 재현/원인 파악용. 매칭 성공 시엔 아무 것도 안 남기므로 평상시엔 조용하다.)
    if (epId.empty()) {
        bool isCallMsg = first.compare(0, 6, "INVITE") == 0 || first.compare(0, 3, "ACK") == 0
            || first.compare(0, 3, "BYE") == 0 || first.compare(0, 6, "CANCEL") == 0;
        if (isCallMsg) {
            emitJson({{"ev","log"},{"level","warn"},{"text",
                std::string("SIP 캡처: epId 매칭 실패 — dir=") + dir + " first=\"" + first + "\""
                + " RURI=\"" + extractRequestUriAor(body) + "\""
                + " To=\"" + extractHeaderAor(body, "To", "t") + "\""
                + " From=\"" + extractHeaderAor(body, "From", "f") + "\""
                + " Contact=\"" + extractHeaderAor(body, "Contact", "m") + "\""}});
        }
    }
    // remote = IP 우선 (시퀀스 그룹화 키), remoteName = 호스트명 (라벨 보조 표시)
    emitJson({{"ev","sip"},{"dir", dir},{"summary", first},{"body", body},{"endpointId", epId},
              {"remote", !remoteIp.empty() ? remoteIp : remoteName}, {"remoteName", remoteName}});
}
// 모든 콜백을 try/catch — 절대로 C++ 예외가 PJSIP C 코드로 전파되지 않도록.
static std::string rxPeerIp(pjsip_rx_data* rdata) {
    if (!rdata) return "";
    try { return std::string(rdata->pkt_info.src_name); } catch (...) { return ""; }
}
static std::string txPeerIp(pjsip_tx_data* tdata) {
    if (!tdata) return "";
    try {
        // tp_info.dst_name 은 char[] — 라우팅 후 채워짐. 미설정이면 빈 문자열.
        const char* s = tdata->tp_info.dst_name;
        if (s && *s) return std::string(s);
    } catch (...) {}
    return "";
}
// R-URI user 파트가 SSW 스타코드 모양(*...* 또는 %23...*)인지 — buildSswDial 이 만드는 다이얼
// 문자열과 toSipUri() 의 퍼센트인코딩을 거친 뒤의 실제 전송 형태를 그대로 검사한다.
static bool isSswStarCodeUri(pjsip_msg* msg) {
    if (!msg || msg->type != PJSIP_REQUEST_MSG) return false;
    if (msg->line.req.method.id != PJSIP_INVITE_METHOD) return false;
    pjsip_uri* uri = (pjsip_uri*)pjsip_uri_get_uri(msg->line.req.uri);
    if (!uri || (!PJSIP_URI_SCHEME_IS_SIP(uri) && !PJSIP_URI_SCHEME_IS_SIPS(uri))) return false;
    pjsip_sip_uri* sipUri = (pjsip_sip_uri*)uri;
    const pj_str_t& u = sipUri->user;
    if (u.slen < 2) return false;
    bool startsOk = (u.ptr[0] == '*') || (u.slen >= 3 && strncmp(u.ptr, "%23", 3) == 0);
    return startsOk && u.ptr[u.slen - 1] == '*';
}
// 전송 직전(PJSIP_MOD_PRIORITY_TRANSPORT_LAYER-1) 단계 — 이 시점엔 실제 전송 목적지(dest_info)가
// 이미 앞선 라우팅 단계에서 확정된 뒤라, 여기서 헤더 텍스트만 지워도 패킷이 실제로 어디로
// 가는지에는 전혀 영향이 없다(순수 wire-format 조정). MiniSoftphone(SIPSorcery SIPUserAgent.Call())
// 실캡처 기준 100% 매칭 — 일반 통화 INVITE 에는 Allow 헤더가 없다(REGISTER 는 이미 명시적으로
// 같은 Allow 값을 넣어 일치시켰으므로 안 건드림). SSW 스타코드 INVITE(R-URI 가 서버 IP 로 직접
// 가는 경우)는 Route 헤더도 없다 — 단, 심볼릭 도메인(tbssw001.catvphone.com 등) 기반 일반 통화는
// 실제 프록시 라우팅에 Route 가 필요하므로 절대 건드리지 않는다(MiniSoftphone 캡처에 그 경우
// 자체가 없어 근거도 없음).
static void stripMiniSoftphoneMismatchedHeaders(pjsip_tx_data* tdata) {
    if (!tdata || !tdata->msg) return;
    pjsip_msg* msg = tdata->msg;
    if (msg->type != PJSIP_REQUEST_MSG || msg->line.req.method.id != PJSIP_INVITE_METHOD) return;
    pjsip_hdr* h;
    bool changed = false;
    while ((h = (pjsip_hdr*)pjsip_msg_find_hdr(msg, PJSIP_H_ALLOW, NULL)) != NULL) { pj_list_erase(h); changed = true; }
    if (isSswStarCodeUri(msg)) {
        pjsip_hdr* r;
        while ((r = (pjsip_hdr*)pjsip_msg_find_hdr(msg, PJSIP_H_ROUTE, NULL)) != NULL) { pj_list_erase(r); changed = true; }
    }
    // PJSIP 은 tdata->msg 를 한 번 print(직렬화)한 뒤 그 바이트 버퍼(tdata->buf)를 캐시해뒀다가
    // 그대로 전송한다 — on_tx_request 콜백 시점엔 이미 이 버퍼가 만들어져 있는 경우가 많아서,
    // 헤더 리스트(msg->hdr)만 고쳐서는 실제 와이어 바이트가 전혀 안 바뀐다(pj_list_erase 는 성공해도
    // 캡처엔 그대로 남던 버그의 원인). 캐시를 무효화해 전송 직전에 다시 print 하도록 강제해야 한다.
    if (changed) pjsip_tx_data_invalidate_msg(tdata);
}
extern "C" pj_bool_t pepe_on_rx_request(pjsip_rx_data* rdata) {
    try { if (rdata && rdata->msg_info.msg) emitSipMsg("in", rdata->msg_info.msg, -1, rxPeerIp(rdata)); } catch (...) {}
    return PJ_FALSE;
}
extern "C" pj_bool_t pepe_on_rx_response(pjsip_rx_data* rdata) {
    try { if (rdata && rdata->msg_info.msg) emitSipMsg("in", rdata->msg_info.msg, -1, rxPeerIp(rdata)); } catch (...) {}
    return PJ_FALSE;
}
extern "C" pj_status_t pepe_on_tx_request(pjsip_tx_data* tdata) {
    try {
        if (tdata && tdata->msg) {
            // stripMiniSoftphoneMismatchedHeaders(tdata) 를 여기서 호출했었는데, 헤더 리스트를
            // 고친 뒤 pjsip_tx_data_invalidate_msg() 로 캐시를 무효화하는 조합이 통화(일반/스타코드
            // 모두) 자체를 크래시시키는 심각한 회귀를 일으켰다(실사용 테스트로 확인 — 5060/자동
            // 포트 둘 다에서 발신 시 sipd 프로세스가 죽음). Allow/Route 헤더를 MiniSoftphone 과
            // 100% 맞추는 것보다 통화가 되는 게 훨씬 중요하므로 완전히 되돌린다. 재시도할 경우
            // pjsip_tx_data_encode()/재직렬화 경로를 더 깊이 조사한 뒤에.
            emitSipMsg("out", tdata->msg, -1, txPeerIp(tdata));
        }
    } catch (...) {}
    return PJ_SUCCESS;
}
extern "C" pj_status_t pepe_on_tx_response(pjsip_tx_data* tdata) {
    try { if (tdata && tdata->msg) emitSipMsg("out", tdata->msg, -1, txPeerIp(tdata)); } catch (...) {}
    return PJ_SUCCESS;
}
static pjsip_module g_sipMsgMod = {
    NULL, NULL, { (char*)"pepe-sip-log", 12 }, -1,
    (int)(PJSIP_MOD_PRIORITY_TRANSPORT_LAYER - 1),
    NULL, NULL, NULL, NULL,
    &pepe_on_rx_request, &pepe_on_rx_response,
    &pepe_on_tx_request, &pepe_on_tx_response,
    NULL
};

class MyCall;
class MyAccount;

// endpointId → Account/Call 매핑
static std::map<std::string, MyAccount*> g_accounts;
static std::map<std::string, MyCall*>    g_calls;   // endpointId → 활성 call (1통화/단말 가정)
// endpointId → 현재 UI 에 "이 통화"로 노출 중인 dialog 의 SIP Call-ID.
// REFER 로 상대가 자동으로 후속 통화를 붙이는 경우(pjsua2/pjsua-lib 기본 동작 — 별도
// onCallTransferRequest 오버라이드 없이도 라이브러리가 같은 계정으로 refer-to 대상에 새 호를
// 자동 연결) 같은 MyCall C++ 객체가 서로 다른 Call-ID(별개 dialog)를 순차적으로 넘겨받아
// 재사용되는 것으로 관찰됨 — 그래서 g_calls(객체 포인터 비교)만으로는 "이전 dialog가 뒤늦게
// 끊길 때" 를 걸러낼 수 없다. Call-ID 문자열로 "지금 화면에 보여줄 dialog가 맞는지" 를 판단한다.
static std::map<std::string, std::string> g_activeCallId;
static std::map<std::string, std::string> g_dtmfMode; // endpointId → "rfc2833"|"info"|"inband"
static std::map<std::string, AudioMediaRecorder*> g_recorders; // endpointId → 녹음기(활성 시)
static std::map<std::string, AudioMediaPlayer*> g_players; // endpointId → 미디어(WAV) 재생기(활성 시)

// ── 단말별 전용 마이크/스피커 ── PJSUA2 AudDevManager 는 프로세스 전체에 하나뿐인 전역
// 사운드 장치만 지원한다(모든 통화가 같은 컨퍼런스 브릿지 슬롯 0 에 연결됨). 단말마다 서로
// 다른 물리 장치를 동시에 쓰려면 pjsua-lib 저수준 API 로 단말별 별도 snd_port 를 만들어
// 컨퍼런스 브릿지에 추가 슬롯으로 붙이고, 그 단말의 통화 슬롯만 슬롯 0 대신 그 슬롯에
// 연결해야 한다. 지정 안 한 단말("자동")은 기존과 동일하게 슬롯 0(전역 장치)을 그대로 쓴다.
static std::map<std::string, std::string> g_acctAudioIn;   // endpointId → 지정 마이크(빈 문자열=자동)
static std::map<std::string, std::string> g_acctAudioOut;  // endpointId → 지정 스피커(빈 문자열=자동)
static std::map<std::string, pjsua_ext_snd_dev*> g_acctExtSnd; // endpointId → 이 단말 전용 확장 사운드 장치(있으면)
// 단말별 마이크/스피커 음량(1.0=조정 없음, 0=음소거) — 장치(슬롯)와 무관하게 그 통화 자신의
// AudioMedia 에 직접 적용하므로, 전역 슬롯0 이든 전용 확장 장치든 상관없이 항상 적용된다.
static std::map<std::string, double> g_acctMicLevel;
static std::map<std::string, double> g_acctSpkLevel;
// 정의는 findAudioDev() 이후(뒤쪽)에 있음 — MyCall 안에서 먼저 호출하므로 전방 선언.
static void applyAcctAudioRouting(const std::string& epId);
static void applyAcctVolume(const std::string& epId);
static void teardownAcctSnd(const std::string& epId);

class MyCall : public Call {
    std::string epId;
public:
    bool isIncomingCall = false; // onIncomingCall 에서 true — 우리가 받는(응답 대기) 호
    bool held = false; // cmdHold 가 갱신 — RTP 무응답 감시(watchdog)가 보류 중인 통화는 건너뛰도록
    // 이미 통화 중일 때 두 번째 INVITE 를 즉시 거절하는 경우 true — 이 call 은 UI 에
    // 한 번도 노출되지 않았으므로(incoming 이벤트 미발생) onCallState 의 ended 도 내보내지 않는다.
    // 안 그러면 같은 epId 로 전송된 "ended" 이벤트가 프런트엔드에서 실제 진행 중인 통화(다른 call
    // 객체)의 화면을 덮어써버린다 — 단말이 통화 중일 때 제3자가 걸어와 busy 거절되면, 실제
    // 연결돼 있는 통화 화면이 "종료"로 잘못 표시되는 버그.
    bool silentReject = false;
    // 이미 통화 중인 상태에서 새로 발신한 콜(예: 통화 중 SSW 부가서비스 다이얼) — MiniSoftphone
    // 은 이런 경우를 위한 두 번째 "line B" 슬롯이 있어 기존 통화(line A)와 완전히 독립적으로
    // 성공/실패한다. 우리는 엔드포인트당 g_calls 슬롯이 하나뿐이라 이 콜은 g_calls/g_activeCallId
    // (현재 화면에 보여줄 dialog)를 절대 건드리지 않고, UI 로 "call" 이벤트도 내보내지 않는다 —
    // 안 그러면 이 콜의 상태(calling/ended 등)가 실제 진행 중인 기존 통화의 화면을 잠깐이라도
    // 덮어쓰게 된다. 실제 SIP 메시지는 별도의 g_sipMsgMod 트레이스로 그대로 로그에 남는다.
    bool secondaryDial = false;
    MyCall(Account& acc, const std::string& id, int callId = PJSUA_INVALID_ID)
        : Call(acc, callId), epId(id) {}

    virtual void onCallState(OnCallStateParam& /*prm*/) override {
        CallInfo ci = getInfo();
        if (silentReject || secondaryDial) {
            if (ci.state == PJSIP_INV_STATE_DISCONNECTED) delete this;
            return;
        }
        std::string st = "ended";
        switch (ci.state) {
            case PJSIP_INV_STATE_CALLING:    st = "calling"; break;
            case PJSIP_INV_STATE_INCOMING:   st = "incoming"; break;
            case PJSIP_INV_STATE_EARLY:
            case PJSIP_INV_STATE_CONNECTING:
                // 인입 호는 180 을 보낸 뒤에도 사용자가 아직 답 안 한 상태 → UI 는 계속 'incoming'
                // (받기/거절 버튼 유지). 발신 호만 'ringing' 표시.
                st = isIncomingCall ? "incoming" : "ringing";
                break;
            case PJSIP_INV_STATE_CONFIRMED:  st = "connected"; break;
            case PJSIP_INV_STATE_DISCONNECTED: st = "ended"; break;
            default: break;
        }
        // REFER 로 상대가 자동으로 후속 통화를 붙이는 경우(pjsua2/pjsua-lib 기본 동작 —
        // onCallTransferRequest 를 오버라이드하지 않으면 라이브러리가 같은 계정으로 refer-to
        // 대상에 새 dialog 를 자동 연결) 실측 결과 같은 MyCall C++ 객체가 서로 다른 Call-ID(별개
        // dialog)를 순차적으로 넘겨받아 재사용된다 — 즉 g_calls(객체 포인터)만으로는 "이전 dialog가
        // 뒤늦게 끊길 때" 를 걸러낼 수 없다(this 는 항상 같음). Call-ID 문자열로 지금 화면에 보여줄
        // dialog 를 추적: 진행 상태가 될 때마다 이 call 의 현재 Call-ID 를 "현재 통화"로 승격.
        if (ci.state != PJSIP_INV_STATE_DISCONNECTED) {
            g_calls[epId] = this;
            g_activeCallId[epId] = ci.callIdString;
        }
        json ev = {{"ev","call"},{"endpointId",epId},{"call",st},{"remote",ci.remoteUri}};
        // 통화가 비정상 종료된 경우(SIP 4xx/5xx/6xx 또는 미디어 거절 등) 상세 사유를 함께 전달.
        // 488 Not Acceptable Here = 코덱 불일치, 486 Busy, 480 Unavailable 등.
        if (ci.state == PJSIP_INV_STATE_DISCONNECTED && ci.lastStatusCode >= 300) {
            std::string reason = std::to_string((int)ci.lastStatusCode) + " " + ci.lastReason;
            if (ci.lastStatusCode == 488) reason += " (사용 가능한 코덱 없음 — 설정에서 코덱 활성화 확인)";
            ev["error"] = reason;
        }
        // 이 dialog(Call-ID)가 해당 endpointId 의 "현재 통화"로 추적되고 있지 않다면(예: 위 REFER
        // 자동 후속 통화로 대체된 이후의 원래 dialog) DISCONNECTED 이벤트를 UI 로 내보내지 않는다 —
        // 이미 다른(새) 통화 화면으로 넘어갔으므로 여기서 "종료"를 보내면 그 화면을 잘못 덮어쓴다.
        auto idIt = g_activeCallId.find(epId);
        bool isCurrent = (idIt == g_activeCallId.end() || idIt->second == ci.callIdString);
        if (ci.state != PJSIP_INV_STATE_DISCONNECTED || isCurrent) {
            emitJson(ev);
        }
        if (ci.state == PJSIP_INV_STATE_DISCONNECTED) {
            // isCurrent 가 false 라는 건 이 dialog 는 이미 다른(새) dialog 로 교체된 "과거" 라는
            // 뜻 — 실측 결과 REFER 자동 후속 통화는 같은 MyCall 객체/callId 슬롯이 재사용되는
            // 경우가 있어, 여기서 무조건 g_calls 를 지우고 delete this 를 하면 실제로는 여전히
            // 진행 중인(새 dialog 로 이미 넘어간) 통화 객체를 파괴해버려 "멀쩡히 연결돼 있던 통화가
            // 갑자기 끊기는" 심각한 버그가 된다. 과거 dialog 정리는 녹음/미디어 정리만 하고,
            // g_calls 제거·객체 delete 는 진짜 "현재 통화"가 끝났을 때만 한다.
            if (isCurrent) {
                auto r = g_recorders.find(epId);
                if (r != g_recorders.end()) { try { delete r->second; } catch (...) {} g_recorders.erase(r); emitJson({{"ev","record"},{"endpointId",epId},{"recording",false}}); }
                auto p = g_players.find(epId);
                if (p != g_players.end()) { try { delete p->second; } catch (...) {} g_players.erase(p); emitJson({{"ev","media"},{"endpointId",epId},{"playing",false}}); }
                teardownAcctSnd(epId); // 통화 종료 — 전용 마이크/스피커를 물고 있었다면 반납
                auto cIt = g_calls.find(epId);
                if (cIt != g_calls.end() && cIt->second == this) g_calls.erase(cIt);
                auto aIt = g_activeCallId.find(epId);
                if (aIt != g_activeCallId.end() && aIt->second == ci.callIdString) g_activeCallId.erase(aIt);
                delete this; // PJSUA2: DISCONNECTED 후 안전하게 해제
            }
        }
    }
    virtual void onCallMediaState(OnCallMediaStateParam& /*prm*/) override {
        CallInfo ci = getInfo();
        for (unsigned i = 0; i < ci.media.size(); i++) {
            if (ci.media[i].type == PJMEDIA_TYPE_AUDIO && getMedia(i)) {
                AudioMedia* am = static_cast<AudioMedia*>(getMedia(i));
                AudDevManager& mgr = Endpoint::instance().audDevManager();
                am->startTransmit(mgr.getPlaybackDevMedia());
                mgr.getCaptureDevMedia().startTransmit(*am);
            }
        }
        // 이 단말에 전용 마이크/스피커가 지정돼 있으면 방금 연결된 기본(전역) 장치 대신
        // 그 장치로 다시 라우팅한다.
        applyAcctAudioRouting(epId);
        // 단말별 마이크/스피커 음량 적용(지정돼 있으면).
        applyAcctVolume(epId);
    }
};

class MyAccount : public Account {
public:
    std::string epId;
    bool autoAnswer = false;
    bool dnd = false;
    bool callWaiting = true;
    bool hideCallerId = false; // 발신자 번호 숨기기 (Privacy: id)
    // ── 발신 시 추가 헤더 ──
    std::string divertHeader;  // Diversion — 번호만(자동으로 <sip:번호@domain>;reason=unconditional;counter=1 로 포맷)
    std::string rpidHeader;    // Remote-Party-ID — 번호만(자동 포맷)
    std::string paiHeader;     // P-Asserted-Identity — 번호만(자동 포맷)
    std::string paiPrivacy;    // Privacy (RFC 3323) — paiHeader 가 있을 때만 같이 실어 보냄
    // ── 수신(UAS) 거절 응답 ── 기본값 486 은 MiniSoftphone(SKB 캡처 기준) UI 기본 선택과 동일.
    int rejectCode = PJSIP_SC_BUSY_HERE;     // 수동/자동(DND) 거절 시 쓸 상태 코드
    std::string rejectTiming = "immediate";  // "immediate" | "after180"
    int rejectDelaySec = 0;                  // after180 일 때 180 이후 지연(초)
    // ── 발신 헤더 자동 포맷용(도메인/포트/인증ID) — cmdRegister 에서 채움 ──
    std::string domain;
    int port = 5060;
    // 인증 ID(로그인, authId) — MiniSoftphone 은 발신(INVITE)의 From 헤더를 계정 번호가 아니라
    // 이 값으로 만든다(로그인 계정과 표시 번호가 다른 SBC 트렁크 대응). 비어있으면 계정 번호 그대로.
    std::string authId;
    // SKB(SSW) 콜플로우 — 보류/재개를 표준 re-INVITE 대신 SIP INFO 로 신호(실단말 캡처 기준).
    bool holdViaInfo = false;
    // RTP 무응답(무음) 자동 종료(초) — 0=사용 안 함. 보류 중인 통화는 감시 대상에서 제외.
    // MiniSoftphone(SIPSorcery 안정성 워크어라운드, 기본 60초) 이식 — SKB 프로토콜 자체는 아니지만
    // 동일 사용자 경험을 위해 옵션으로 포팅.
    int rtpTimeoutSec = 0;
    // 계정별 User-Agent — pjsua2 UaConfig 는 프로세스 전역 1개뿐이라, REGISTER/INVITE 요청에
    // "User-Agent" 헤더를 직접 실어 계정마다 다른 값을 낼 수 있게 한다(cmdRegister/cmdCall 참고).
    std::string userAgent;
    explicit MyAccount(const std::string& id) : epId(id) {}

    // dnd/통화중대기 자동 거절, 수동 거절(cmdReject) 공통 — rejectTiming/rejectDelaySec 반영.
    // after180 이면 180(이미 응답됐다고 가정하지 않고 필요 시 먼저 보냄) 이후 별도 스레드로
    // rejectDelaySec 만큼 대기했다가 최종 코드를 보낸다 — 그 사이 통화가 이미 끝났을 수 있으니
    // 타이머 만료 시점에 g_calls 에서 다시 조회해 유효성을 확인한다.
    void rejectCall(MyCall* call, const std::string& id) {
        if (rejectTiming == "after180" && rejectDelaySec > 0) {
            try { CallOpParam ring; ring.statusCode = PJSIP_SC_RINGING; call->answer(ring); } catch (...) {}
            int code = rejectCode; int delay = rejectDelaySec;
            std::thread([id, code, delay]() {
                std::this_thread::sleep_for(std::chrono::seconds(delay));
                // PJSIP/PJSUA2 API 는 pj_thread_register() 로 등록된 스레드에서만 호출 가능 —
                // 새로 뜬 std::thread 는 등록 안 된 "외부" 스레드라 등록 없이 호출하면 pjlib 이
                // assert 로 프로세스를 죽인다(실제 크래시로 확인됨). 최초 1회 등록 필요.
                try { Endpoint::instance().libRegisterThread("pepe-reject-timer"); } catch (...) {}
                auto it = g_calls.find(id);
                if (it == g_calls.end()) return; // 이미 종료/변경됨
                try { CallOpParam op; op.statusCode = (pjsip_status_code)code; it->second->hangup(op); } catch (...) {}
            }).detach();
        } else {
            try { CallOpParam op; op.statusCode = (pjsip_status_code)rejectCode; call->hangup(op); } catch (...) {}
        }
    }

    virtual void onRegState(OnRegStateParam& prm) override {
        AccountInfo ai = getInfo();
        std::string reg = ai.regIsActive ? "registered" : "unregistered";
        if (prm.code / 100 != 2 && prm.code != 0) reg = "failed";
        json j = {{"ev","reg"},{"endpointId",epId},{"reg",reg}};
        if (reg == "failed") j["error"] = std::string("SIP ") + std::to_string(prm.code) + " " + prm.reason;
        emitJson(j);
    }
    virtual void onIncomingCall(OnIncomingCallParam& prm) override {
        bool busy = (g_calls.find(epId) != g_calls.end()); // 이미 통화 중인 호가 있나
        MyCall* call = new MyCall(*this, epId, prm.callId);
        call->isIncomingCall = true;
        CallInfo ci = call->getInfo();
        // 방해 금지 → 설정된 코드/타이밍으로 거절(사용자 설정 rejectCode/rejectTiming 사용).
        if (dnd) {
            if (!busy) g_calls[epId] = call; // 활성 호가 없을 때만 추적(onCallState 가 정리). 통화중이면 기존 호 보존.
            else call->silentReject = true; // 통화 중일 때 dnd 거절 — 기존 통화 화면을 덮어쓰지 않도록
            rejectCall(call, epId);
            return;
        }
        // 이미 통화 중일 때 두 번째 INVITE — MiniSoftphone(SKB 캡처 기준) 실제 동작을 그대로 이식.
        // (참고: MiniSoftphone 소스엔 _lineA/_lineB 기반의 "진짜 2회선 통화중대기" 스캐폴딩이
        // 있어 보이지만, 실제 대기 콜을 채워넣는 코드(_waitingUas 대입)가 전혀 없어 죽은 코드다 —
        // 실행되는 경로는 딱 하나, 아래 callWaiting 체크뿐이라 이걸 그대로 따른다.)
        // callWaiting(체크박스, 기본 on) 켜짐 → 486 Busy Here + Reason:Q.850;cause=17 로 명시 거절.
        // 꺼짐 → 아무 응답도 안 보내고 무시(전화망 쪽에서 타임아웃 처리 — call 객체는 상대가
        // CANCEL 하면 onCallState(DISCONNECTED) 로 자연스레 정리된다). 어느 쪽이든 기존 통화는
        // 그대로 보존하고 두 번째 콜은 절대 연결/대기되지 않는다.
        if (busy) {
            call->silentReject = true; // 기존 통화 화면을 덮어쓰지 않도록(콜백은 응답 무시든 486 이든 항상 옴)
            if (callWaiting) {
                try {
                    CallOpParam op; op.statusCode = PJSIP_SC_BUSY_HERE;
                    SipHeader h; h.hName = "Reason"; h.hValue = "Q.850;cause=17;text=\"User busy\"";
                    op.txOption.headers.push_back(h);
                    call->hangup(op);
                } catch (...) {}
            }
            return;
        }
        // 발신번호 우선순위 — RPID/PAI 헤더 원문을 우선순위대로 확인, 전부 없으면 From(ci.remoteUri).
        // SipRxData::wholeMsg(헤더+본문 원문 텍스트)에서 줄 단위로 헤더 이름을 찾는다 — 저수준
        // pjsip_msg 포인터를 직접 다루지 않아도 되는 간단하고 안전한 방법.
        std::string remote = ci.remoteUri;
        try {
            const std::string& raw = prm.rdata.wholeMsg;
            auto findHeader = [&raw](const char* name) -> std::string {
                size_t nlen = strlen(name);
                size_t pos = 0;
                while (pos < raw.size()) {
                    size_t lineEnd = raw.find("\r\n", pos);
                    if (lineEnd == std::string::npos) lineEnd = raw.size();
                    if (lineEnd - pos > nlen && strncasecmp(raw.c_str() + pos, name, nlen) == 0 && raw[pos + nlen] == ':') {
                        size_t vstart = pos + nlen + 1;
                        while (vstart < lineEnd && raw[vstart] == ' ') vstart++;
                        return raw.substr(vstart, lineEnd - vstart);
                    }
                    if (lineEnd == pos) break; // 빈 줄 = 헤더 끝
                    pos = lineEnd + 2;
                }
                return "";
            };
            for (const auto& pref : callerIdPriority) {
                if (pref == "from") break; // From 은 기본값(ci.remoteUri)이므로 더 볼 것 없음
                const char* hname = pref == "rpid" ? "Remote-Party-ID" : pref == "pai" ? "P-Asserted-Identity" : nullptr;
                if (!hname) continue;
                std::string v = findHeader(hname);
                if (!v.empty()) { remote = v; break; }
            }
        } catch (...) {}
        g_calls[epId] = call;
        emitJson({{"ev","call"},{"endpointId",epId},{"call","incoming"},{"remote",remote}});
        // 180 Ringing 즉시 응답 — 발신측이 링백톤을 재생하도록.
        CallOpParam ring; ring.statusCode = PJSIP_SC_RINGING;
        try { call->answer(ring); } catch (...) {}
        if (autoAnswer) {
            // 180 이후 1초 지연하고 200 OK — MiniSoftphone(SKB 캡처 기준)과 동일한 타이밍.
            // 그 사이 통화가 끝나거나(취소 등) 다른 call 로 바뀌었으면 재조회로 걸러낸다.
            std::string epIdCopy = epId;
            std::thread([epIdCopy, call]() {
                std::this_thread::sleep_for(std::chrono::milliseconds(1000));
                // 등록 안 된 스레드에서 PJSIP API 호출 시 pjlib assert 로 프로세스가 죽는다.
                try { Endpoint::instance().libRegisterThread("pepe-autoanswer-timer"); } catch (...) {}
                auto it = g_calls.find(epIdCopy);
                if (it == g_calls.end() || it->second != call) return;
                try { CallOpParam op; op.statusCode = PJSIP_SC_OK; call->answer(op); } catch (...) {}
            }).detach();
        }
    }
    // 발신번호 우선순위 순서 — customInit 이 아니라 cmdRegister 에서 채워진다(account 필드).
    std::vector<std::string> callerIdPriority = {"rpid", "from", "pai"};
    // 수신 IM(pager MESSAGE)
    virtual void onInstantMessage(OnInstantMessageParam& prm) override {
        emitJson({{"ev","im"},{"endpointId",epId},{"from",prm.fromUri},{"text",prm.msgBody},{"contentType",prm.contentType},{"dir","in"}});
    }
    // 송신 IM 전달 상태
    virtual void onInstantMessageStatus(OnInstantMessageStatusParam& prm) override {
        emitJson({{"ev","im-status"},{"endpointId",epId},{"to",prm.toUri},{"code",(int)prm.code},{"reason",prm.reason}});
    }
    // 음성사서함 알림(MWI NOTIFY)
    virtual void onMwiInfo(OnMwiInfoParam& prm) override {
        std::string body = prm.rdata.wholeMsg;
        // "Messages-Waiting: yes/no" 파싱 (공백 유무 모두 허용)
        bool waiting = body.find("Messages-Waiting: yes") != std::string::npos
                    || body.find("Messages-Waiting:yes") != std::string::npos;
        emitJson({{"ev","mwi"},{"endpointId",epId},{"waiting",waiting}});
    }
};

// pjsua_acc_id 로 우리 단말 id 역참조 — SIP 메시지 캡처 시 사용.
static std::string lookupEpIdByAccId(int accId) {
    if (accId < 0) return "";
    for (const auto& p : g_accounts) {
        try { if (p.second && p.second->getId() == accId) return p.first; } catch (...) {}
    }
    return "";
}

// 프레즌스 버디 — 상태 변경을 이벤트로 전달
class MyBuddy : public Buddy {
public:
    std::string epId;
    explicit MyBuddy(const std::string& id) : epId(id) {}
    virtual void onBuddyState() override {
        BuddyInfo bi = getInfo();
        std::string status =
            bi.presStatus.status == PJSUA_BUDDY_STATUS_ONLINE  ? "online"  :
            bi.presStatus.status == PJSUA_BUDDY_STATUS_OFFLINE ? "offline" : "unknown";
        emitJson({{"ev","presence"},{"endpointId",epId},{"buddy",bi.uri},{"status",status},{"note",bi.presStatus.note}});
    }
};
// (endpointId + "|" + uri) → buddy
static std::map<std::string, MyBuddy*> g_buddies;

static Endpoint g_ep;

// 계정별 로컬 SIP 포트 — pjsua2 기본 전송(자동 포트, 위 main())은 그대로 두고, 계정이
// localSipPort 를 지정하면 그 포트 전용 전송을 이 캐시에서 찾거나 새로 만들어 반환한다.
// key = "port:transportTypeChar"(같은 포트라도 udp/tcp/tls 는 서로 다른 전송이 필요).
static std::map<std::string, TransportId> g_transportsByPort;
static TransportId ensureTransport(unsigned port, const std::string& transportParam) {
    pjsip_transport_type_e type = transportParam == "tls" ? PJSIP_TRANSPORT_TLS
                                 : transportParam == "tcp" ? PJSIP_TRANSPORT_TCP
                                 : PJSIP_TRANSPORT_UDP;
    char kbuf[32]; snprintf(kbuf, sizeof(kbuf), "%u:%c", port, transportParam.empty() ? 'u' : transportParam[0]);
    std::string key(kbuf);
    auto it = g_transportsByPort.find(key);
    if (it != g_transportsByPort.end()) return it->second;
    TransportConfig t; t.port = port;
    TransportId id = g_ep.transportCreate(type, t); // 실패 시 Error throw — 호출부에서 catch
    g_transportsByPort[key] = id;
    return id;
}

static void setCodecPriorities(const json& codecs, const std::string& epId) {
    // 등록된 코덱 목록 수집 + 먼저 전부 0(비활성)
    std::vector<std::string> avail;
    try {
        const CodecInfoVector2 all = g_ep.codecEnum2();
        for (auto& ci : all) { g_ep.codecSetPriority(ci.codecId, 0); avail.push_back(ci.codecId); }
    } catch (...) {}
    int prio = 254;
    json unsupported = json::array();
    for (auto& c : codecs) {
        std::string cs = c.get<std::string>();
        std::string id = codecPjId(cs);
        if (id.empty()) continue;
        // 등록 여부 확인 (codecEnum2 의 id 는 "AMR-WB/16000/1" 처럼 접미사 가능 → prefix 비교)
        bool found = false;
        for (auto& a : avail) if (a.rfind(id, 0) == 0) { found = true; break; }
        if (!found) { unsupported.push_back(cs); continue; } // 미등록 코덱(예: EVS 래퍼 미완) → 건너뛰고 경고
        try { g_ep.codecSetPriority(id, (pj_uint8_t)prio); } catch (...) {}
        if (prio > 1) prio -= 8;
    }
    if (!unsupported.empty())
        emitJson({{"ev","codec-warn"},{"endpointId",epId},{"unsupported",unsupported}});
}

static void cmdRegister(const json& ep) {
    std::string id = ep.value("id", "");
    if (id.empty()) return;
    std::string server = ep.value("server", "");
    int port = ep.value("port", 5060);
    std::string transport = ep.value("transport", "udp");
    std::string user = ep.value("username", "");
    std::string authId = ep.value("authId", user);
    std::string pass = ep.value("password", "");
    std::string disp = ep.value("displayName", "");
    std::string proxy = ep.value("proxy", "");
    std::string domain = ep.value("domain", "");           // 도메인(미지정 시 server 사용)
    if (domain.empty()) domain = server;
    // 필수 필드 검증 — 비어있으면 invalid URI 로 PJSIP 가 throw 하니 미리 친화 메시지로 거절.
    if (user.empty() || server.empty() || domain.empty()) {
        emitJson({{"ev","reg"},{"endpointId",id},{"reg","failed"},
                  {"error", std::string("필수 필드 누락 — 사용자 번호/SIP 서버/도메인 모두 입력 필요")}});
        return;
    }
    bool disableTimer = ep.value("disableSessionTimer", false);
    bool publishPres = ep.value("publishPresence", true);
    int regExpiry = ep.value("regExpiry", 300);
    std::string srtp = ep.value("srtp", "disabled");
    bool iceEnabled = ep.value("iceEnabled", false);
    int keepAlive = ep.value("keepAlive", 15);
    std::string stunServer = ep.value("stunServer", "");
    std::string turnServer = ep.value("turnServer", "");
    std::string turnUser = ep.value("turnUser", "");
    std::string turnPass = ep.value("turnPassword", "");
    g_dtmfMode[id] = ep.value("dtmfMode", std::string("rfc2833"));
    // ── 네트워크(RTP 포트 범위) / Contact 고정 / 발신 헤더 / 수신 거절 응답 ──
    int rtpPortMin = ep.value("rtpPortMin", 0);
    int rtpPortMax = ep.value("rtpPortMax", 0);
    std::string contactForced = ep.value("contactForced", "");
    std::string divertHeader = ep.value("divertHeader", "");
    std::string rpidHeader = ep.value("rpidHeader", "");
    std::string paiHeader = ep.value("paiHeader", "");
    std::string paiPrivacy = ep.value("paiPrivacy", "");
    int rejectCode = ep.value("rejectCode", (int)PJSIP_SC_BUSY_HERE);
    std::string rejectTiming = ep.value("rejectTiming", std::string("immediate"));
    int rejectDelaySec = ep.value("rejectDelaySec", 0);
    int localSipPort = ep.value("localSipPort", 0);        // 계정별 로컬 SIP 포트(0=자동/공용)
    std::string userAgent = ep.value("userAgent", "");     // 계정별 User-Agent(헤더로 직접 주입)
    bool holdViaInfo = ep.value("holdViaInfo", false);      // SKB(SSW) 콜플로우 — 보류/재개를 SIP INFO 로 신호
    int rtpTimeoutSec = ep.value("rtpTimeoutSec", 0);       // RTP 무응답 자동 종료(초), 0=사용 안 함
    bool mwiSubscribe = ep.value("mwiSubscribe", true);     // 음성사서함(MWI) SUBSCRIBE 여부 — SSW 는 기본 off(MiniSoftphone 은 SUBSCRIBE 안 함, 검증 안 된 동작)
    std::vector<std::string> callerIdPriority = {"rpid", "from", "pai"};
    if (ep.contains("callerIdPriority") && ep["callerIdPriority"].is_array()) {
        callerIdPriority.clear();
        for (auto& v : ep["callerIdPriority"]) { try { callerIdPriority.push_back(v.get<std::string>()); } catch (...) {} }
    }

    if (ep.contains("codecs")) setCodecPriorities(ep["codecs"], id);

    std::string scheme = "sip";
    std::string tparam = transport == "tls" ? ";transport=tls" : transport == "tcp" ? ";transport=tcp" : "";
    // 기본 SIP 포트(5060/5061)는 URI 에서 생략 — MicroSIP/대부분 클라이언트가 그렇게 보내고,
    // 일부 서버(SKBroadband 등) 가 명시적 포트가 있는 URI 의 auth username 매칭을 거부함.
    int defaultPort = (transport == "tls") ? 5061 : 5060;
    std::string portSuffix = (port > 0 && port != defaultPort) ? (":" + std::to_string(port)) : "";
    AccountConfig acfg;
    // 계정 식별(AOR)은 도메인 기준, 등록은 SIP 서버(registrar) 기준
    std::string idUri = (disp.empty() ? std::string() : ("\"" + disp + "\" ")) + "<" + scheme + ":" + user + "@" + domain + ">";
    acfg.idUri = idUri;
    g_accountAor[id] = user + "@" + domain;
    g_accountServer[id] = server;
    acfg.regConfig.registrarUri = scheme + ":" + server + portSuffix + tparam;
    if (regExpiry > 0) acfg.regConfig.timeoutSec = regExpiry;
    if (!proxy.empty()) {
        // 프록시는 IP:port 형식 그대로 사용 (포트 지정이 의도된 케이스가 대부분 — SBC 위치 명시).
        acfg.sipConfig.proxies.push_back(scheme + ":" + proxy + tparam);
    }
    AuthCredInfo cred("digest", "*", authId.empty() ? user : authId, 0, pass);
    acfg.sipConfig.authCreds.push_back(cred);
    acfg.callConfig.timerMinSESec = 90;
    acfg.callConfig.timerUse = disableTimer ? PJSUA_SIP_TIMER_INACTIVE : PJSUA_SIP_TIMER_OPTIONAL; // 세션 타이머
    // 통화 연결 직후 PJSUA 가 자동으로 UPDATE 보내 코덱 1개로 재협상하는 동작 비활성화.
    // 일부 서버(SK 브로드밴드 SBC 등)가 자기쪽 re-INVITE 와 충돌해 491 후 BYE 로 호를 끊는다.
    acfg.mediaConfig.lockCodecEnabled = false;
    acfg.presConfig.publishEnabled = publishPres; // 계정 상태(프레즌스 PUBLISH)
    acfg.mwiConfig.enabled = mwiSubscribe; // 음성사서함(MWI) 구독 — 계정별 on/off
    if (keepAlive > 0) acfg.natConfig.udpKaIntervalSec = keepAlive; // UDP keep-alive(살아유지)
    // SRTP(미디어 암호화)
    if (srtp == "mandatory")      { acfg.mediaConfig.srtpUse = PJMEDIA_SRTP_MANDATORY; acfg.mediaConfig.srtpSecureSignaling = 1; }
    else if (srtp == "optional")  { acfg.mediaConfig.srtpUse = PJMEDIA_SRTP_OPTIONAL;  acfg.mediaConfig.srtpSecureSignaling = 0; }
    else                          { acfg.mediaConfig.srtpUse = PJMEDIA_SRTP_DISABLED;  acfg.mediaConfig.srtpSecureSignaling = 0; }
    // NAT 통과 — ICE / STUN / TURN
    acfg.natConfig.iceEnabled = iceEnabled;
    if (!stunServer.empty()) {
        acfg.natConfig.sipStunUse   = PJSUA_STUN_USE_DEFAULT;
        acfg.natConfig.mediaStunUse = PJSUA_STUN_USE_DEFAULT;
        // STUN 서버는 PJSUA 전역 — 마지막 등록값이 적용된다(단일 STUN 환경 가정).
        try { StringVector v; v.push_back(stunServer); g_ep.natUpdateStunServers(v, false); } catch (...) {}
    } else {
        acfg.natConfig.sipStunUse   = PJSUA_STUN_USE_DISABLED;
        acfg.natConfig.mediaStunUse = PJSUA_STUN_USE_DISABLED;
    }
    if (!turnServer.empty()) {
        acfg.natConfig.turnEnabled = true;
        acfg.natConfig.turnServer = turnServer;
        acfg.natConfig.turnUserName = turnUser;
        acfg.natConfig.turnPassword = turnPass;
        acfg.natConfig.turnPasswordType = PJ_STUN_PASSWD_PLAIN;
    }
    // Contact 고정 — 비어있으면 자동 계산(권장), 값이 있으면 그 URI 로 고정(SBC 등에서 필요할 때만).
    if (!contactForced.empty()) acfg.sipConfig.contactForced = contactForced;
    // RTP 포트 범위 — 둘 다 0(미지정)이면 자동(pjsua 기본 동작 그대로).
    if (rtpPortMin > 0 && rtpPortMax > rtpPortMin) {
        acfg.mediaConfig.transportConfig.port = (unsigned)rtpPortMin;
        acfg.mediaConfig.transportConfig.portRange = (unsigned)(rtpPortMax - rtpPortMin);
    }
    // 계정별 로컬 SIP 포트 — 지정 시 그 포트 전용 전송을 만들어(없으면 생성) 이 계정만 묶는다.
    // 미지정(0)이면 main() 에서 만든 공용(자동 포트) 전송을 그대로 쓴다(기존 동작 그대로).
    if (localSipPort > 0) {
        try { acfg.sipConfig.transportId = ensureTransport((unsigned)localSipPort, transport); }
        catch (Error& e) { emitJson({{"ev","log"},{"level","error"},{"text", std::string("로컬 SIP 포트 ") + std::to_string(localSipPort) + " 바인딩 실패: " + e.info()}}); }
    }
    // 계정별 User-Agent — pjsua2 는 프로세스 전역 1개뿐이라 REGISTER 요청에 헤더로 직접 주입한다
    // (INVITE 는 cmdCall 에서 같은 방식으로 추가). 비어있으면 데몬 기본값(PePe-MicroSIP/1.0) 유지.
    if (!userAgent.empty()) {
        SipHeader h; h.hName = "User-Agent"; h.hValue = userAgent; acfg.regConfig.headers.push_back(h);
    }
    // REGISTER 에 명시적 Allow 헤더 — MiniSoftphone(SKB 캡처 기준) 이 항상 보내는 고정 목록과
    // 동일하게 맞춘다(pjsip 자동 생성 목록에 의존하지 않음).
    {
        SipHeader h; h.hName = "Allow";
        h.hValue = "ACK, BYE, CANCEL, INFO, INVITE, NOTIFY, OPTIONS, PRACK, REFER, REGISTER, SUBSCRIBE";
        acfg.regConfig.headers.push_back(h);
    }

    auto it = g_accounts.find(id);
    // 이미 존재하는 계정인데 로컬 SIP 포트가 바뀌었으면 modify() 로는 반영이 안 되므로(전송은
    // 생성 시 고정) 완전히 지우고 새로 만든다 — 아래 if(it==end()) 의 "새로 생성" 경로를 그대로
    // 타도록 g_accounts 에서 지운 뒤 it 를 다시 조회한다.
    if (it != g_accounts.end()) {
        auto pIt = g_accountLocalPort.find(id);
        int prevPort = (pIt != g_accountLocalPort.end()) ? pIt->second : 0;
        if (prevPort != localSipPort) {
            try { it->second->setRegistration(false); } catch (...) {}
            try { delete it->second; } catch (...) {}
            g_accounts.erase(it);
            it = g_accounts.find(id);
        }
    }
    try {
        if (it == g_accounts.end()) {
            MyAccount* acc = new MyAccount(id);
            acc->autoAnswer = ep.value("autoAnswer", false);
            acc->dnd = ep.value("dnd", false);
            acc->callWaiting = ep.value("callWaiting", true);
            acc->hideCallerId = ep.value("hideCallerId", false);
            acc->divertHeader = divertHeader;
            acc->rpidHeader = rpidHeader;
            acc->paiHeader = paiHeader;
            acc->paiPrivacy = paiPrivacy;
            acc->rejectCode = rejectCode;
            acc->rejectTiming = rejectTiming;
            acc->rejectDelaySec = rejectDelaySec;
            acc->callerIdPriority = callerIdPriority;
            acc->userAgent = userAgent;
            acc->domain = domain;
            acc->port = port;
            acc->authId = authId;
            acc->holdViaInfo = holdViaInfo;
            acc->rtpTimeoutSec = rtpTimeoutSec;
            acc->create(acfg);
            g_accounts[id] = acc;
            g_accountLocalPort[id] = localSipPort;
        } else {
            it->second->autoAnswer = ep.value("autoAnswer", false);
            it->second->dnd = ep.value("dnd", false);
            it->second->callWaiting = ep.value("callWaiting", true);
            it->second->hideCallerId = ep.value("hideCallerId", false);
            it->second->divertHeader = divertHeader;
            it->second->rpidHeader = rpidHeader;
            it->second->paiHeader = paiHeader;
            it->second->paiPrivacy = paiPrivacy;
            it->second->rejectCode = rejectCode;
            it->second->rejectTiming = rejectTiming;
            it->second->rejectDelaySec = rejectDelaySec;
            it->second->callerIdPriority = callerIdPriority;
            it->second->userAgent = userAgent;
            it->second->domain = domain;
            it->second->port = port;
            it->second->authId = authId;
            it->second->holdViaInfo = holdViaInfo;
            it->second->rtpTimeoutSec = rtpTimeoutSec;
            it->second->modify(acfg);
            // modify() 후 PJSUA2 가 onRegState 를 호출하지 않을 수 있어, 현재 등록 상태를
            // 명시 emit. 활성 등록이 유지되면 'registered' 를 다시 알려 UI 의 버튼/표시가
            // 'registering' 에 멈춰있지 않도록 한다.
            try {
                AccountInfo ai = it->second->getInfo();
                if (ai.regIsActive) {
                    emitJson({{"ev","reg"},{"endpointId",id},{"reg","registered"}});
                    return;
                }
            } catch (...) {}
        }
        emitJson({{"ev","reg"},{"endpointId",id},{"reg","registering"}});
    } catch (Error& e) {
        emitJson({{"ev","reg"},{"endpointId",id},{"reg","failed"},{"error",e.info()}});
    }
}

static void cmdUnregister(const std::string& id) {
    auto it = g_accounts.find(id);
    if (it == g_accounts.end()) return;
    try { it->second->setRegistration(false); } catch (...) {}
    auto c = g_calls.find(id);
    if (c != g_calls.end()) { try { CallOpParam p; c->second->hangup(p); } catch (...) {} }
    delete it->second;
    g_accounts.erase(it);
    g_dtmfMode.erase(id);
    g_accountAor.erase(id);
    g_accountServer.erase(id);
    g_accountLocalPort.erase(id);
    // 이 계정의 버디 정리
    for (auto bit = g_buddies.begin(); bit != g_buddies.end(); ) {
        if (bit->first.rfind(id + "|", 0) == 0) { try { delete bit->second; } catch (...) {} bit = g_buddies.erase(bit); }
        else ++bit;
    }
    emitJson({{"ev","reg"},{"endpointId",id},{"reg","unregistered"}});
}

// target 이 sip URI 가 아니면 계정 도메인 기준으로 보정해 sip URI 로 만든다.
static std::string toSipUri(MyAccount* acc, const std::string& target) {
    if (target.rfind("sip:", 0) == 0 || target.rfind("sips:", 0) == 0) return target;
    std::string host;
    // 같은 sipd 프로세스에 등록된 다른 단말(내선)로 거는 경우 — 발신자 자신의 도메인이 아니라
    // 그 단말 자신의 등록 도메인을 쓴다. 예전엔 무조건 발신자(acc) 자신의 도메인을 붙였는데,
    // 두 단말의 "도메인" 설정이 다르면(예: 한쪽은 IP, 한쪽은 호스트명) PBX 가 착신 측에 전달하는
    // 헤더의 호스트 문자열이 우리 쪽 epId 매칭 휴리스틱(emitSipMsg)과 어긋나 시퀀스 로그에서
    // 착신 측(callee) 메시지가 통째로 안 잡히는 문제가 있었다.
    for (const auto& p : g_accountAor) {
        size_t at = p.second.find('@');
        if (at == std::string::npos || at == 0) continue;
        if (p.second.substr(0, at) == target) { host = p.second.substr(at + 1); break; }
    }
    // SSW 스타코드(*44...* / #44...* 형태 — buildSswDial 이 만드는 정확한 모양) 다이얼인지 판별.
    // 앞뒤로 '*'/'#' + ... + '*' 를 요구하는 건, MicroSIP 사용자가 직접 다이얼패드로 입력하는
    // 일반 PSTN 스타코드(예: 발신자번호 차단 *67, 착신전환 확인 뒤 즉시전송용 트레일링 # 등)와
    // 겹치지 않게 하기 위함 — 이 아래 두 처리(서버 IP 직접 사용, '#' 퍼센트인코딩)는 SSW 전용
    // 동작이라 MicroSIP 계정/다이얼에는 절대 적용되면 안 된다(일반 SIP 서버는 오히려 깨질 수 있음).
    bool isSswStarCode = target.size() >= 2 &&
        (target.front() == '*' || target.front() == '#') && target.back() == '*';
    // MiniSoftphone 실캡처 기준, 계정의 심볼릭 등록 도메인이 아니라 실제 SIP 서버(레지스트라) IP 를
    // R-URI 호스트로 직접 써야 한다. 심볼릭 도메인으로 보내면 교환기가 "다른 도메인의 번호"로
    // 오인해 로컬 prefix(SUPP) 테이블을 안 태우고 CS_INVALID_NUMBER_FORMAT 으로 거절함(*44 DND
    // 실장비 테스트로 확인).
    if (host.empty() && isSswStarCode) {
        auto sIt = g_accountServer.find(acc->epId);
        if (sIt != g_accountServer.end()) host = sIt->second;
    }
    if (host.empty()) {
        try {
            AccountInfo ai = acc->getInfo();
            std::string domain = ai.uri; // sip:user@domain
            size_t at = domain.find('@');
            host = at != std::string::npos ? domain.substr(at + 1) : "";
            size_t gt = host.find('>'); if (gt != std::string::npos) host = host.substr(0, gt);
        } catch (...) {}
    }
    // '#' 는 SIP/일반 URI 문법상 user 파트에 그대로 못 쓰는 예약문자(fragment 구분자) — SSW
    // 스타코드 해제 코드(#44, #88 등)의 선두 문자로 나오는데, MiniSoftphone(SIPSorcery) 실캡처를
    // 보면 이걸 %23 으로 퍼센트인코딩해서 보낸다(예: sip:%2344*@172.16.124.33). '*' 는 SIP URI
    // user-unreserved 문자라 인코딩 없이 그대로 둔다. isSswStarCode 일 때만 적용.
    std::string escaped = target;
    if (isSswStarCode) {
        size_t hpos = 0;
        while ((hpos = escaped.find('#', hpos)) != std::string::npos) { escaped.replace(hpos, 1, "%23"); hpos += 3; }
    }
    return "sip:" + escaped + (host.empty() ? "" : ("@" + host));
}

// (endpointId,uri) 버디 확보(없으면 생성). subscribe=true 면 프레즌스 구독.
static MyBuddy* ensureBuddy(MyAccount* acc, const std::string& epId, const std::string& uri, bool subscribe) {
    std::string key = epId + "|" + uri;
    auto it = g_buddies.find(key);
    if (it != g_buddies.end()) return it->second;
    MyBuddy* b = new MyBuddy(epId);
    BuddyConfig cfg; cfg.uri = uri; cfg.subscribe = subscribe;
    try { b->create(*acc, cfg); } catch (...) { delete b; return nullptr; }
    g_buddies[key] = b;
    return b;
}

static void cmdCall(const std::string& id, const std::string& target) {
    auto it = g_accounts.find(id);
    if (it == g_accounts.end()) { emitJson({{"ev","call"},{"endpointId",id},{"call","ended"},{"error","not registered"}}); return; }
    // MiniSoftphone(SoftphoneEngine.cs CallAsync)은 이미 통화 중이어도 발신 자체를 막지 않는다 —
    // IdleLine()이 구조적으로 남아있는 두 번째 회선(line B) 슬롯을 잡아 그 위에서 새 INVITE를
    // 그대로 보내고, 403(CS_CALL_REJECTED) 등으로 실패해도 line A(기존 통화)는 전혀 안 건드린다
    // (실장비 테스트로 확인 — 통화 중 SSW 부가서비스를 눌러도 403만 받고 기존 통화는 안 끊김).
    // 우리는 엔드포인트당 g_calls 슬롯이 하나뿐이라 line B 개념이 없으므로, 이미 통화 중일 때의
    // 새 발신은 g_calls/g_activeCallId(=현재 화면에 보여줄 dialog)를 절대 건드리지 않는
    // "secondaryDial"로 표시해 처리한다 — 실패/성공 여부와 무관하게 기존 통화 화면은 그대로 둔다.
    bool busy = (g_calls.find(id) != g_calls.end());
    std::string uri = toSipUri(it->second, target);
    MyCall* call = new MyCall(*it->second, id);
    call->secondaryDial = busy;
    if (!busy) g_calls[id] = call;
    try {
        CallOpParam op(true);
        // 텍스트 미디어(t140/red) 비활성화 — SDP 크기를 줄여 UDP MTU(1300) 안에 들어가게.
        // 일부 SIP 서버(SKBroadband 등) 가 TCP 로 fallback 한 INVITE 를 즉시 끊어 통화 실패.
        op.opt.audioCount = 1;
        op.opt.videoCount = 0;
        op.opt.textCount  = 0;
        // 발신 From 헤더 — MiniSoftphone(SKB 캡처 기준)은 계정 번호가 아니라 인증 ID(로그인)로
        // From 을 만든다(로그인 계정과 표시 번호가 다른 트렁크 대응). 등록(REGISTER)의 AOR/idUri
        // 는 건드리지 않고 이 통화(INVITE)의 From 만 localUri 로 override — authId 미지정 시 기존과 동일.
        if (!it->second->authId.empty()) {
            op.txOption.localUri = "<sip:" + it->second->authId + "@" + it->second->domain + ">";
        }
        if (it->second->hideCallerId) { // 발신자 번호 숨기기 (RFC3323)
            SipHeader h; h.hName = "Privacy"; h.hValue = "id"; op.txOption.headers.push_back(h);
        }
        // 발신 시 추가 헤더(값이 있을 때만) — Diversion / Remote-Party-ID / P-Asserted-Identity.
        // 입력값은 "번호만"이며, MiniSoftphone(SKB 캡처 기준)과 동일한 포맷으로 여기서 완성한다.
        const std::string& hdomain = it->second->domain;
        if (!it->second->divertHeader.empty()) {
            SipHeader h; h.hName = "Diversion";
            h.hValue = "<sip:" + it->second->divertHeader + "@" + hdomain + ">;reason=unconditional;counter=1";
            op.txOption.headers.push_back(h);
        }
        if (!it->second->rpidHeader.empty()) {
            std::string portSuf = it->second->port > 0 ? (":" + std::to_string(it->second->port)) : "";
            SipHeader h; h.hName = "Remote-Party-ID";
            h.hValue = "<sip:" + it->second->rpidHeader + "@" + hdomain + portSuf + ">;party=calling;id-type=subscriber;privacy=off;screen=yes";
            op.txOption.headers.push_back(h);
        }
        if (!it->second->paiHeader.empty()) {
            SipHeader h; h.hName = "P-Asserted-Identity";
            h.hValue = "<sip:" + it->second->paiHeader + "@" + hdomain + ">";
            op.txOption.headers.push_back(h);
            // Privacy — PAI 값이 있을 때만 같이 실어 보냄 (MiniSoftphone 과 동일). hideCallerId 가 이미
            // "Privacy: id" 를 넣었다면 중복 헤더를 피하기 위해 건너뜀.
            if (!it->second->hideCallerId && !it->second->paiPrivacy.empty()) {
                SipHeader ph; ph.hName = "Privacy"; ph.hValue = it->second->paiPrivacy; op.txOption.headers.push_back(ph);
            }
        }
        if (!it->second->userAgent.empty()) {
            SipHeader h; h.hName = "User-Agent"; h.hValue = it->second->userAgent; op.txOption.headers.push_back(h);
        }
        call->makeCall(uri, op);
    }
    catch (Error& e) { emitJson({{"ev","call"},{"endpointId",id},{"call","ended"},{"error",e.info()}}); g_calls.erase(id); delete call; }
}

static void cmdHangup(const std::string& id) {
    auto c = g_calls.find(id);
    if (c == g_calls.end()) return;
    try { CallOpParam p; c->second->hangup(p); } catch (...) {}
}

static void cmdAnswer(const std::string& id) {
    auto c = g_calls.find(id);
    if (c == g_calls.end()) return;
    try { CallOpParam op; op.statusCode = PJSIP_SC_OK; c->second->answer(op); } catch (...) {}
}
static void cmdReject(const std::string& id) {
    auto c = g_calls.find(id);
    if (c == g_calls.end()) return;
    auto a = g_accounts.find(id);
    if (a != g_accounts.end()) { a->second->rejectCall(c->second, id); return; }
    try { CallOpParam op; op.statusCode = PJSIP_SC_DECLINE; c->second->hangup(op); } catch (...) {}
}
// SKB(SSW) 콜플로우 — 보류/재개/CTR 모두 표준 SDP 재협상이 아니라 in-dialog SIP INFO 로
// 신호한다(Content-Type: audio/telephone-event, body 0x10 04 00 00, Supported: replaces —
// 실단말(MOIMSTONE) 캡처 기준, MiniSoftphone 이식). enblocUri 가 있으면 P-Enbloc-Info 헤더를
// 같이 실어 보낸다(CTR 2번째 INFO 용).
static void sendFlashInfo(MyCall* call, const std::string& enblocUri) {
    try {
        CallSendRequestParam prm;
        prm.method = "INFO";
        prm.txOption.contentType = "audio/telephone-event";
        prm.txOption.msgBody = std::string("\x10\x04\x00\x00", 4);
        SipHeader sup; sup.hName = "Supported"; sup.hValue = "replaces";
        prm.txOption.headers.push_back(sup);
        if (!enblocUri.empty()) {
            SipHeader h; h.hName = "P-Enbloc-Info"; h.hValue = enblocUri;
            prm.txOption.headers.push_back(h);
        }
        call->sendRequest(prm);
    } catch (...) {}
}
// "<sip:user@host:port>" 형태의 URI 문자열에서 host[:port] 부분만 뽑아낸다 — CTR 의
// P-Enbloc-Info 값(<sip:다이얼문자열@내호스트>)을 만드는 데 쓴다.
static std::string hostFromUri(const std::string& uri) {
    std::string s = uri;
    size_t lt = s.find('<');
    if (lt != std::string::npos) { size_t gt = s.find('>', lt); s = (gt != std::string::npos) ? s.substr(lt + 1, gt - lt - 1) : s.substr(lt + 1); }
    size_t at = s.find('@');
    if (at == std::string::npos) return s;
    std::string rest = s.substr(at + 1);
    size_t semi = rest.find(';');
    if (semi != std::string::npos) rest = rest.substr(0, semi);
    return rest;
}
static void cmdHold(const std::string& id, bool hold) {
    auto c = g_calls.find(id);
    if (c == g_calls.end()) return;
    c->second->held = hold; // RTP 무응답 감시가 보류 중엔 건너뛰도록
    auto a = g_accounts.find(id);
    if (a != g_accounts.end() && a->second->holdViaInfo) { sendFlashInfo(c->second, ""); return; }
    try {
        CallOpParam op(true);
        if (hold) c->second->setHold(op);
        else { op.opt.flag = PJSUA_CALL_UNHOLD; c->second->reinvite(op); }
    } catch (...) {}
}
// SSW CTR(호전환) — 실단말 캡처 기준 시퀀스: ①보류신호(P-Enbloc 없음) → 200ms 대기 →
// ②같은 신호 + P-Enbloc-Info(<sip:*20+번호+*@내Contact호스트>). digits 는 SSW_SERVICES 의 ctr
// 항목 코드(기본 "20"), number 는 전환할 번호.
static void cmdCtrTransfer(const std::string& id, const std::string& digits, const std::string& number) {
    auto c = g_calls.find(id);
    if (c == g_calls.end() || number.empty()) return;
    MyCall* call = c->second;
    sendFlashInfo(call, ""); // ① 보류 신호(플래시)
    std::string host;
    try { host = hostFromUri(call->getInfo().localContact); } catch (...) {}
    std::string enbloc = "<sip:*" + digits + number + "*@" + host + ">";
    std::thread([id, enbloc]() {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        // 등록 안 된 스레드에서 PJSIP API(sendFlashInfo→sendRequest) 호출 시 pjlib 이 assert 로
        // 프로세스를 죽인다 — 실제로 CTR 호전환 시 이 크래시가 재현됨(로그로 확인).
        try { Endpoint::instance().libRegisterThread("pepe-ctr-timer"); } catch (...) {}
        auto it = g_calls.find(id);
        if (it == g_calls.end()) return; // 그 사이 통화가 끝났으면 중단
        sendFlashInfo(it->second, enbloc); // ② P-Enbloc-Info 포함
    }).detach();
}

// RTP 무응답(무음) 자동 종료 — 계정의 rtpTimeoutSec(0=사용 안 함) 초 동안 상대로부터 RTP 를
// 한 패킷도 못 받으면 통화를 끊는다. 보류(MyCall::held) 중인 통화는 감시 대상에서 제외한다
// (MiniSoftphone: SIPSorcery 가 재협상 후 미디어를 자동 재개하지 않는 문제의 안전장치였는데,
// SKB 프로토콜 자체는 아니지만 동일 사용자 경험을 위해 옵션으로 포팅).
static void rtpWatchdogLoop() {
    // 이 루프는 별도 std::thread 로 detach 돼 있어 PJSIP 관점에선 "등록 안 된 외부 스레드" —
    // 등록 없이 call->getStreamStat()/hangup() 등을 호출하면 pjlib 이 assert 로 프로세스를 죽인다.
    try { Endpoint::instance().libRegisterThread("pepe-rtp-watchdog"); } catch (...) {}
    std::map<std::string, unsigned> lastPkt;      // epId → 마지막으로 관측한 rx 패킷 수
    std::map<std::string, std::chrono::steady_clock::time_point> lastChange; // epId → 마지막으로 패킷 수가 바뀐 시각
    for (;;) {
        std::this_thread::sleep_for(std::chrono::seconds(5));
        // g_calls 스냅샷 — 순회 중 hangup()이 onCallState 를 재귀적으로 유발해 맵을 바꿀 수 있음.
        std::vector<std::pair<std::string, MyCall*>> snapshot(g_calls.begin(), g_calls.end());
        auto now = std::chrono::steady_clock::now();
        for (auto& kv : snapshot) {
            const std::string& epId = kv.first;
            MyCall* call = kv.second;
            if (call->held) { lastPkt.erase(epId); lastChange.erase(epId); continue; }
            auto a = g_accounts.find(epId);
            int timeout = (a != g_accounts.end()) ? a->second->rtpTimeoutSec : 0;
            if (timeout <= 0) continue;
            try {
                CallInfo ci = call->getInfo();
                if (ci.state != PJSIP_INV_STATE_CONFIRMED) { lastPkt.erase(epId); lastChange.erase(epId); continue; }
                StreamStat st = call->getStreamStat(0);
                unsigned pkt = st.rtcp.rxStat.pkt;
                auto pIt = lastPkt.find(epId);
                if (pIt == lastPkt.end() || pIt->second != pkt) {
                    lastPkt[epId] = pkt;
                    lastChange[epId] = now;
                    continue;
                }
                auto cIt = lastChange.find(epId);
                if (cIt != lastChange.end() && std::chrono::duration_cast<std::chrono::seconds>(now - cIt->second).count() >= timeout) {
                    emitJson({{"ev","log"},{"level","info"},{"text", std::string("RTP 무응답 ") + std::to_string(timeout) + "초 — 자동 종료: " + epId}});
                    CallOpParam op; call->hangup(op);
                    lastPkt.erase(epId); lastChange.erase(epId);
                }
            } catch (...) {}
        }
    }
}

// 마이크 뮤트 — capture 장치 → call 오디오 전송을 끊거나 잇는다.
static AudioMedia* firstCallAudio(MyCall* call) {
    try {
        CallInfo ci = call->getInfo();
        for (unsigned i = 0; i < ci.media.size(); i++)
            if (ci.media[i].type == PJMEDIA_TYPE_AUDIO && call->getMedia(i))
                return static_cast<AudioMedia*>(call->getMedia(i));
    } catch (...) {}
    return nullptr;
}
static void cmdMute(const std::string& id, bool mute) {
    auto c = g_calls.find(id);
    if (c == g_calls.end()) return;
    AudioMedia* am = firstCallAudio(c->second);
    if (!am) return;
    try {
        AudDevManager& mgr = Endpoint::instance().audDevManager();
        if (mute) mgr.getCaptureDevMedia().stopTransmit(*am);
        else      mgr.getCaptureDevMedia().startTransmit(*am);
    } catch (...) {}
}
// 스피커 뮤트 — call 오디오 → playback 장치 전송을 끊거나 잇는다(마이크 뮤트와 반대 방향).
// 상대방은 계속 내 목소리를 들을 수 있고, 나만 상대방 소리가 안 들리게 된다.
static void cmdSpeakerMute(const std::string& id, bool mute) {
    auto c = g_calls.find(id);
    if (c == g_calls.end()) return;
    AudioMedia* am = firstCallAudio(c->second);
    if (!am) return;
    try {
        AudDevManager& mgr = Endpoint::instance().audDevManager();
        if (mute) am->stopTransmit(mgr.getPlaybackDevMedia());
        else      am->startTransmit(mgr.getPlaybackDevMedia());
    } catch (...) {}
}

// 통화 녹음 — 상대 오디오 + 내 마이크를 WAV 로 기록.
static void cmdRecord(const std::string& id, bool on, const std::string& file) {
    auto c = g_calls.find(id);
    if (c == g_calls.end()) return;
    auto existing = g_recorders.find(id);
    if (on) {
        if (existing != g_recorders.end()) return; // 이미 녹음 중
        AudioMedia* am = firstCallAudio(c->second);
        if (!am || file.empty()) { emitJson({{"ev","record"},{"endpointId",id},{"recording",false},{"error","미디어/경로 없음"}}); return; }
        AudioMediaRecorder* rec = new AudioMediaRecorder();
        try {
            rec->createRecorder(toAnsi(file)); // 경로가 UTF-8(JSON) → pjsip 는 ANSI(CP_ACP)로 해석함
            am->startTransmit(*rec);                                                  // 상대 음성
            Endpoint::instance().audDevManager().getCaptureDevMedia().startTransmit(*rec); // 내 음성
            g_recorders[id] = rec;
            emitJson({{"ev","record"},{"endpointId",id},{"recording",true},{"file",file}});
        } catch (Error& e) { delete rec; emitJson({{"ev","record"},{"endpointId",id},{"recording",false},{"error",e.info()}}); }
    } else {
        if (existing != g_recorders.end()) { try { delete existing->second; } catch (...) {} g_recorders.erase(existing); }
        emitJson({{"ev","record"},{"endpointId",id},{"recording",false}});
    }
}

// 미디어(WAV) 송출 — 파일을 통화 상대에게 재생(테스트 톤/안내음 송출용). 녹음(g_recorders)과
// 대칭 구조 — g_players 로 재생기를 추적, 이미 재생 중이면 무시.
static void cmdMediaPlay(const std::string& id, const std::string& file) {
    auto c = g_calls.find(id);
    if (c == g_calls.end()) return;
    auto existing = g_players.find(id);
    if (existing != g_players.end()) return; // 이미 재생 중
    AudioMedia* am = firstCallAudio(c->second);
    if (!am || file.empty()) { emitJson({{"ev","media"},{"endpointId",id},{"playing",false},{"error","미디어/경로 없음"}}); return; }
    AudioMediaPlayer* pl = new AudioMediaPlayer();
    try {
        pl->createPlayer(toAnsi(file), PJMEDIA_FILE_NO_LOOP); // 경로가 UTF-8(JSON) → pjsip 는 ANSI(CP_ACP)로 해석함
        pl->startTransmit(*am); // 재생 파일 → 상대에게 송출
        g_players[id] = pl;
        emitJson({{"ev","media"},{"endpointId",id},{"playing",true},{"file",file}});
    } catch (Error& e) { delete pl; emitJson({{"ev","media"},{"endpointId",id},{"playing",false},{"error",e.info()}}); }
}
static void cmdMediaStop(const std::string& id) {
    auto existing = g_players.find(id);
    if (existing != g_players.end()) { try { delete existing->second; } catch (...) {} g_players.erase(existing); }
    emitJson({{"ev","media"},{"endpointId",id},{"playing",false}});
}

// 호전환 — 현재 통화를 target 으로 blind transfer(REFER).
// Refer-To 는 RFC 3515 상 완전한 SIP URI 여야 한다 — 번호만 그대로 넘기면(예: "07088008001")
// SBC 가 이를 올바르게 해석하지 못해 전환 대상 호 생성이 500 Server Internal Error 로 실패한다
// (실사용 캡처로 확인). cmdCall/cmdIm 과 동일하게 toSipUri 로 완전한 URI를 만들어 넘긴다.
static void cmdTransfer(const std::string& id, const std::string& target) {
    auto c = g_calls.find(id);
    auto a = g_accounts.find(id);
    if (c == g_calls.end() || a == g_accounts.end() || target.empty()) return;
    std::string uri = toSipUri(a->second, target);
    try { CallOpParam op; c->second->xfer(uri, op); } catch (...) {}
}

// in-dialog INFO 요청에 커스텀 헤더 하나를 실어 보낸다 — SSW PBX 의 CTR(호전환) 부가서비스처럼
// 표준 REFER 가 아니라 커스텀 헤더(P-Enbloc-Info 등)로 동작하는 기능용. body 는 쓰지 않는다.
static void cmdSendInfo(const std::string& id, const std::string& headerName, const std::string& headerValue) {
    auto c = g_calls.find(id);
    if (c == g_calls.end() || headerName.empty()) return;
    try {
        CallSendRequestParam prm;
        prm.method = "INFO";
        SipHeader h; h.hName = headerName; h.hValue = headerValue;
        prm.txOption.headers.push_back(h);
        c->second->sendRequest(prm);
    } catch (...) {}
}

// DTMF in-band — MiniSoftphone(SKB 캡처 기준): 표준 DTMF 주파수로 200ms 단일 톤을 만들어
// 오디오에 직접 실어 보낸다(대역 내 신호 — 신호 자체가 RTP 오디오 페이로드에 실림, RFC2833/INFO
// 대역외 방식과 다름). 원본은 그 순간 마이크 바이트를 톤으로 대체해 보내지만, 여기서는 PJSIP
// 컨퍼런스 브리지의 톤 제너레이터로 마이크와 믹스해서 내보낸다 — 대부분의 PJSIP 기반 소프트폰이
// 쓰는 표준적인 in-band 구현 방식이고, SBC 쪽 톤 검출기 입장에서는 결과가 동일하다.
static void cmdDtmfInband(const std::string& id, const std::string& digit) {
    auto c = g_calls.find(id);
    if (c == g_calls.end() || digit.empty()) return;
    AudioMedia* am = firstCallAudio(c->second);
    if (!am) return;
    ToneGenerator* tg = new ToneGenerator();
    try {
        tg->createToneGenerator();
        tg->startTransmit(*am);
        ToneDigit d; d.digit = digit[0]; d.on_msec = 200; d.off_msec = 0; d.volume = 0;
        ToneDigitVector v; v.push_back(d);
        tg->playDigits(v);
    } catch (...) { delete tg; return; }
    // 200ms 톤 + 여유를 두고 정리 — 그 사이 통화가 끝났으면(g_calls 에서 사라졌으면) stop() 은
    // 건너뛰고 객체만 해제한다(이미 파괴된 미디어 싱크에 stop 을 걸지 않기 위함).
    std::thread([id, tg]() {
        std::this_thread::sleep_for(std::chrono::milliseconds(260));
        // 등록 안 된 스레드에서 PJSIP API(tg->stop()) 호출 시 pjlib 이 assert 로 프로세스를 죽인다.
        try { Endpoint::instance().libRegisterThread("pepe-dtmf-tone-cleanup"); } catch (...) {}
        if (g_calls.find(id) != g_calls.end()) { try { tg->stop(); } catch (...) {} }
        try { delete tg; } catch (...) {}
    }).detach();
}
static void cmdDtmf(const std::string& id, const std::string& digit) {
    auto c = g_calls.find(id);
    if (c == g_calls.end()) return;
    std::string mode = g_dtmfMode.count(id) ? g_dtmfMode[id] : "rfc2833";
    if (mode == "inband") { cmdDtmfInband(id, digit); return; }
    try {
        if (mode == "info") {
            CallSendDtmfParam p; p.method = PJSUA_DTMF_METHOD_SIP_INFO; p.digits = digit;
            c->second->sendDtmf(p);
        } else {
            // rfc2833(기본) — dialDtmf 는 RFC2833 telephony-event 사용
            c->second->dialDtmf(digit);
        }
    } catch (...) {}
}

// PJMEDIA 오디오 장치 목록을 이벤트로 제공 — UI 가 이 목록(name)에서 선택한다.
static void cmdListAudio() {
    json inputs = json::array(), outputs = json::array();
    try {
        AudDevManager& mgr = Endpoint::instance().audDevManager();
        const AudioDevInfoVector2 devs = mgr.enumDev2();
        for (unsigned i = 0; i < devs.size(); i++) {
            const AudioDevInfo& d = devs[i];
            std::string nm = toUtf8(d.name);
            if (d.inputCount  > 0) inputs.push_back({{"idx",(int)i},{"name",nm}});
            if (d.outputCount > 0) outputs.push_back({{"idx",(int)i},{"name",nm}});
        }
    } catch (...) {}
    emitJson({{"ev","audio-devices"},{"inputs",inputs},{"outputs",outputs}});
}

// 장치 식별자(name)로 PJMEDIA 인덱스를 찾는다. 빈 문자열이면 -1(기본 장치).
static int findAudioDev(const std::string& name, bool capture) {
    if (name.empty()) return -1;
    try {
        AudDevManager& mgr = Endpoint::instance().audDevManager();
        const AudioDevInfoVector2 devs = mgr.enumDev2();
        for (unsigned i = 0; i < devs.size(); i++) {
            const AudioDevInfo& d = devs[i];
            if ((capture ? d.inputCount : d.outputCount) > 0 && toUtf8(d.name) == name) return (int)i;
        }
    } catch (...) {}
    return -1;
}

// 단말 전용 확장 사운드 장치(있으면)를 컨퍼런스 브릿지에서 떼어내고 정리한다.
static void teardownAcctSnd(const std::string& epId) {
    auto it = g_acctExtSnd.find(epId);
    if (it != g_acctExtSnd.end()) {
        try { pjsua_ext_snd_dev_destroy(it->second); } catch (...) {}
        g_acctExtSnd.erase(it);
    }
}

// 이 단말의 통화가 지금 연결돼 있으면, 지정된 전용 마이크/스피커로 그 통화의 컨퍼런스
// 슬롯을 다시 연결한다. 지정이 없으면("자동") 기본(전역, 슬롯 0) 장치로 되돌린다.
//
// (처음 구현은 pjmedia_snd_port_create() 로 만든 snd_port 를 pjsua_conf_add_port() 에 바로
// 넘겼는데, pjmedia_snd_port_get_port() 가 반환하는 포트는 pjmedia_snd_port_connect() 를
// 별도로 호출해 "다른 포트와 연결"하기 전까진 채워지지 않는 필드라 NULL 이 넘어가 컨퍼런스
// 브릿지 어서션(conf && pool && strm_port)에 걸려 엔진이 죽었다. pjsua-lib 은 이 정확한
// 용도 — 계정/그룹별 추가 사운드 장치를 브릿지에 별도 슬롯으로 등록 — 를 위한 공개 API
// pjsua_ext_snd_dev_create()/_destroy()/_get_conf_port() 를 이미 제공한다(내부적으로
// splitcomb+snd_port_connect 로 올바르게 배선함) — 그걸 그대로 쓰도록 재작성.)
static void applyAcctAudioRouting(const std::string& epId) {
    auto cIt = g_calls.find(epId);
    if (cIt == g_calls.end()) return;
    int callSlot = pjsua_call_get_conf_port(cIt->second->getId());
    if (callSlot == PJSUA_INVALID_ID) return;

    std::string in  = g_acctAudioIn.count(epId)  ? g_acctAudioIn[epId]  : "";
    std::string out = g_acctAudioOut.count(epId) ? g_acctAudioOut[epId] : "";
    teardownAcctSnd(epId); // 기존에 전용 장치를 물고 있었으면 먼저 정리(장치 교체 시에도 이 경로 재사용)
    if (in.empty() && out.empty()) {
        try { pjsua_conf_connect(0, callSlot); pjsua_conf_connect(callSlot, 0); } catch (...) {}
        return;
    }
    int cap  = findAudioDev(in, true);
    int play = findAudioDev(out, false);
    if (cap < 0)  cap  = PJMEDIA_AUD_DEFAULT_CAPTURE_DEV;
    if (play < 0) play = PJMEDIA_AUD_DEFAULT_PLAYBACK_DEV;

    pjmedia_snd_port_param param;
    pjmedia_snd_port_param_default(&param);
    pj_status_t st = pjmedia_aud_dev_default_param(cap, &param.base);
    if (st != PJ_SUCCESS) return;
    param.base.dir = PJMEDIA_DIR_CAPTURE_PLAYBACK;
    param.base.rec_id = cap;
    param.base.play_id = play;
    param.base.clock_rate = 16000;
    param.base.channel_count = 1; // pjsua_ext_snd_dev_create() 는 모노만 허용
    param.base.samples_per_frame = 320;
    param.base.bits_per_sample = 16;

    pjsua_ext_snd_dev* dev = nullptr;
    st = pjsua_ext_snd_dev_create(&param, &dev);
    if (st != PJ_SUCCESS || !dev) return;
    pjsua_conf_port_id slot = pjsua_ext_snd_dev_get_conf_port(dev);
    if (slot == PJSUA_INVALID_ID) { pjsua_ext_snd_dev_destroy(dev); return; }

    pjsua_conf_disconnect(0, callSlot);
    pjsua_conf_disconnect(callSlot, 0);
    pjsua_conf_connect(slot, callSlot);
    pjsua_conf_connect(callSlot, slot);
    g_acctExtSnd[epId] = dev;
}

// 단말별 전용 마이크/스피커 지정 — 이미 통화 중이면 즉시 재적용.
static void cmdAccountAudio(const std::string& id, const std::string& input, const std::string& output) {
    if (id.empty()) return;
    g_acctAudioIn[id] = input;
    g_acctAudioOut[id] = output;
    if (g_calls.count(id)) applyAcctAudioRouting(id);
}

// 이 단말의 통화가 지금 연결돼 있으면, 지정된 마이크/스피커 음량을 그 통화 자신의
// AudioMedia 에 직접 적용한다(전역 슬롯0/전용 확장 장치 어느 쪽에 연결돼 있든 무관하게 동작).
static void applyAcctVolume(const std::string& epId) {
    auto cIt = g_calls.find(epId);
    if (cIt == g_calls.end()) return;
    double mic = g_acctMicLevel.count(epId) ? g_acctMicLevel[epId] : 1.0;
    double spk = g_acctSpkLevel.count(epId) ? g_acctSpkLevel[epId] : 1.0;
    try {
        CallInfo ci = cIt->second->getInfo();
        for (unsigned i = 0; i < ci.media.size(); i++) {
            if (ci.media[i].type == PJMEDIA_TYPE_AUDIO && cIt->second->getMedia(i)) {
                AudioMedia* am = static_cast<AudioMedia*>(cIt->second->getMedia(i));
                try { am->adjustTxLevel((float)mic); } catch (...) {}
                try { am->adjustRxLevel((float)spk); } catch (...) {}
            }
        }
    } catch (...) {}
}

// 단말별 마이크/스피커 음량 지정 — 이미 통화 중이면 즉시 재적용.
static void cmdAccountVolume(const std::string& id, double mic, double spk) {
    if (id.empty()) return;
    if (mic >= 0) g_acctMicLevel[id] = mic;
    if (spk >= 0) g_acctSpkLevel[id] = spk;
    if (g_calls.count(id)) applyAcctVolume(id);
}

static void cmdAudio(const std::string& input, const std::string& output) {
    try {
        AudDevManager& mgr = Endpoint::instance().audDevManager();
        int cap = findAudioDev(input, true);
        int play = findAudioDev(output, false);
        // 기본(-1) 이면 PJMEDIA 기본 장치 인덱스 사용
        if (cap < 0)  cap  = PJMEDIA_AUD_DEFAULT_CAPTURE_DEV;
        if (play < 0) play = PJMEDIA_AUD_DEFAULT_PLAYBACK_DEV;
        mgr.setCaptureDev(cap);
        mgr.setPlaybackDev(play);
    } catch (...) {}
}

// ── IM / 프레즌스 ──
// 인스턴트 메시지(pager MESSAGE) 송신
static void cmdIm(const std::string& id, const std::string& target, const std::string& text) {
    auto it = g_accounts.find(id);
    if (it == g_accounts.end() || target.empty()) return;
    std::string uri = toSipUri(it->second, target);
    MyBuddy* b = ensureBuddy(it->second, id, uri, false);
    if (!b) { emitJson({{"ev","im-status"},{"endpointId",id},{"to",uri},{"code",0},{"reason","buddy 생성 실패"}}); return; }
    try { SendInstantMessageParam p; p.content = text; b->sendInstantMessage(p); }
    catch (Error& e) { emitJson({{"ev","im-status"},{"endpointId",id},{"to",uri},{"code",0},{"reason",e.info()}}); }
}
// 자신의 프레즌스(온/오프라인) 게시
static void cmdPresence(const std::string& id, bool online) {
    auto it = g_accounts.find(id);
    if (it == g_accounts.end()) return;
    try {
        PresenceStatus ps;
        ps.status = online ? PJSUA_BUDDY_STATUS_ONLINE : PJSUA_BUDDY_STATUS_OFFLINE;
        it->second->setOnlineStatus(ps);
    } catch (...) {}
}
// 상대 프레즌스 구독/해제
static void cmdSubscribe(const std::string& id, const std::string& target, bool sub) {
    auto it = g_accounts.find(id);
    if (it == g_accounts.end() || target.empty()) return;
    std::string uri = toSipUri(it->second, target);
    if (sub) {
        MyBuddy* b = ensureBuddy(it->second, id, uri, true);
        if (b) { try { b->subscribePresence(true); } catch (...) {} }
    } else {
        std::string key = id + "|" + uri;
        auto bit = g_buddies.find(key);
        if (bit != g_buddies.end()) { try { delete bit->second; } catch (...) {} g_buddies.erase(bit); }
    }
}

// 방해 금지(DND) 런타임 토글
static void cmdDnd(const std::string& id, bool on) {
    auto it = g_accounts.find(id);
    if (it != g_accounts.end()) it->second->dnd = on;
}

// 마이크(송신)/스피커(수신) 음량 — 1.0=기본, 0=무음, 2.0=+6dB 부근
static void cmdVolume(double mic, double spk) {
    try {
        AudDevManager& mgr = Endpoint::instance().audDevManager();
        if (mic >= 0) { try { mgr.getCaptureDevMedia().adjustTxLevel((float)mic); } catch (...) {} }
        if (spk >= 0) { try { mgr.getPlaybackDevMedia().adjustRxLevel((float)spk); } catch (...) {} }
    } catch (...) {}
}

int main() {
    try {
        g_ep.libCreate();
        // UDP MTU 초과 시 TCP 자동 전환 비활성화 — SDP+Proxy-Auth 합쳐 ~1500 바이트 INVITE 가
        // PJSIP 기본 임계치 1300 을 넘어 TCP 로 전환되는데, 일부 SIP 서버(SKBroadband) 가 TCP
        // INVITE 를 즉시 끊어 통화 실패. UDP 단편화 허용해 그대로 송신하도록 함.
        pjsip_cfg()->endpt.disable_tcp_switch = PJ_TRUE;
        EpConfig epcfg;
        // SIP 트레이스 — 파일 로그는 기본 OFF (env PEPE_SIPD_LOG 가 있을 때만 파일로 남김).
        // 대신 SIP 프로토콜 메시지 라인을 LogWriter 로 캡처해 'sip' 이벤트로 emit → UI 콜로그에 표시.
        epcfg.logConfig.level = 4;       // 4 = SIP request/response 메시지 레벨
        epcfg.logConfig.consoleLevel = 0;
        epcfg.uaConfig.userAgent = "PePe-MicroSIP/1.0";
        {
            const char* envlog = getenv("PEPE_SIPD_LOG");
            if (envlog && *envlog) { epcfg.logConfig.filename = envlog; }
            // else: filename 미설정 → 파일 로그 안 남김.
        }
        g_ep.libInit(epcfg);
        // SIP 메시지 캡처 모듈 등록 — libInit 후 pjsua_get_pjsip_endpt() 가능.
        // RX/TX 양방향 onMsg 콜백 → 헤더+SDP 전체를 'sip' 이벤트로 IPC emit.
        {
            pjsip_endpoint* pe = pjsua_get_pjsip_endpt();
            if (pe) pjsip_endpt_register_module(pe, &g_sipMsgMod);
        }

#ifdef PEPE_EVS
        // EVS(3GPP TS26.443) 커스텀 코덱 등록 — EVS/16000 이 코덱 매니저/SDP 에 노출됨
        {
            pjmedia_endpt *me = pjsua_get_pjmedia_endpt();
            pj_status_t es = me ? pjmedia_codec_evs_init(me) : -1;
            emitJson({{"ev","log"},{"level", es == PJ_SUCCESS ? "info" : "error"},
                      {"text", std::string("EVS codec register: ") + (es == PJ_SUCCESS ? "ok" : "failed")}});
        }
#endif

        // 전송 — UDP/TCP/TLS 기본(자동 포트) 준비. 계정이 localSipPort 를 지정하면 cmdRegister 가
        // ensureTransport() 로 그 포트 전용 전송을 별도로 만들어 그 계정만 바인딩한다(계정별 로컬
        // SIP 포트 — AccountSipConfig::transportId).
        { TransportConfig t; t.port = 0; try { g_ep.transportCreate(PJSIP_TRANSPORT_UDP, t); } catch (...) {} }
        { TransportConfig t; t.port = 0; try { g_ep.transportCreate(PJSIP_TRANSPORT_TCP, t); } catch (...) {} }
        { TransportConfig t; t.port = 0; try { g_ep.transportCreate(PJSIP_TRANSPORT_TLS, t); } catch (...) {} }

        g_ep.libStart();

        // AMR octet-align=1 강제 — 대부분의 통신사/IMS 서버가 octet-align=1 을 요구한다.
        // pjproject 기본은 octet-align=0(대역효율)이라, 우리 offer 에 fmtp 가 없으면
        // 서버(octet-align=1)와 프레이밍이 달라 협상에서 AMR 이 제거되고 "No active media
        // stream"(EINVALIDPT) 으로 통화가 즉시 끊긴다. dec_fmtp 에 넣어 offer 에 광고한다.
        auto forceAmrOctetAlign = [](const char* codecId) {
            try {
                CodecParam prm = g_ep.codecGetParam(codecId);
                bool found = false;
                for (auto& f : prm.setting.decFmtp) if (f.name == "octet-align") { f.val = "1"; found = true; }
                if (!found) { CodecFmtp f; f.name = "octet-align"; f.val = "1"; prm.setting.decFmtp.push_back(f); }
                g_ep.codecSetParam(codecId, prm);
            } catch (...) {}
        };
        forceAmrOctetAlign("AMR-WB/16000");
        forceAmrOctetAlign("AMR/8000");

        emitJson({{"ev","ready"}});
        cmdListAudio(); // 기동 직후 오디오 장치 목록 1회 통지
        std::thread(rtpWatchdogLoop).detach(); // RTP 무응답 자동 종료 감시(rtpTimeoutSec>0 인 계정만 대상)
    } catch (Error& e) {
        emitJson({{"ev","error"},{"error",e.info()}});
        return 1;
    }

    // stdin 명령 루프
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        json msg;
        try { msg = json::parse(line); } catch (...) { continue; }
        std::string cmd = msg.value("cmd", "");
        try {
            if (cmd == "register")        cmdRegister(msg["endpoint"]);
            else if (cmd == "unregister") cmdUnregister(msg.value("endpointId", ""));
            else if (cmd == "call")       cmdCall(msg.value("endpointId", ""), msg.value("target", ""));
            else if (cmd == "hangup")     cmdHangup(msg.value("endpointId", ""));
            else if (cmd == "answer")     cmdAnswer(msg.value("endpointId", ""));
            else if (cmd == "reject")     cmdReject(msg.value("endpointId", ""));
            else if (cmd == "hold")       cmdHold(msg.value("endpointId", ""), msg.value("hold", false));
            else if (cmd == "ctrTransfer") cmdCtrTransfer(msg.value("endpointId", ""), msg.value("digits", "20"), msg.value("number", ""));
            else if (cmd == "mute")       cmdMute(msg.value("endpointId", ""), msg.value("mute", false));
            else if (cmd == "speakerMute") cmdSpeakerMute(msg.value("endpointId", ""), msg.value("mute", false));
            else if (cmd == "transfer")   cmdTransfer(msg.value("endpointId", ""), msg.value("target", ""));
            else if (cmd == "sendInfo")   cmdSendInfo(msg.value("endpointId", ""), msg.value("header", "P-Enbloc-Info"), msg.value("value", ""));
            else if (cmd == "record")     cmdRecord(msg.value("endpointId", ""), msg.value("on", false), msg.value("file", ""));
            else if (cmd == "mediaPlay")  cmdMediaPlay(msg.value("endpointId", ""), msg.value("file", ""));
            else if (cmd == "mediaStop")  cmdMediaStop(msg.value("endpointId", ""));
            else if (cmd == "dtmf")       cmdDtmf(msg.value("endpointId", ""), msg.value("digit", ""));
            else if (cmd == "audio")      cmdAudio(msg.value("input", ""), msg.value("output", ""));
            else if (cmd == "account-audio") cmdAccountAudio(msg.value("endpointId", ""), msg.value("input", ""), msg.value("output", ""));
            else if (cmd == "account-volume") cmdAccountVolume(msg.value("endpointId", ""), msg.value("mic", -1.0), msg.value("speaker", -1.0));
            else if (cmd == "listAudio")  cmdListAudio();
            else if (cmd == "volume")     cmdVolume(msg.value("mic", -1.0), msg.value("speaker", -1.0));
            else if (cmd == "dnd")        cmdDnd(msg.value("endpointId", ""), msg.value("dnd", false));
            else if (cmd == "im")         cmdIm(msg.value("endpointId", ""), msg.value("target", ""), msg.value("text", ""));
            else if (cmd == "presence")   cmdPresence(msg.value("endpointId", ""), msg.value("online", false));
            else if (cmd == "subscribe")  cmdSubscribe(msg.value("endpointId", ""), msg.value("target", ""), msg.value("subscribe", true));
            else if (cmd == "quit")       break;
        } catch (Error& e) {
            emitJson({{"ev","error"},{"error",e.info()}});
        } catch (std::exception& e) {
            emitJson({{"ev","error"},{"error",std::string(e.what())}});
        }
    }

    try { g_ep.libDestroy(); } catch (...) {}
    return 0;
}
