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
#else
static std::string toUtf8(const std::string& s) { return s; }
#endif

#ifdef PEPE_EVS
/* EVS 커스텀 코덱 등록 (pjmedia_codec_evs.c) + pjsua 미디어 엔드포인트 획득 */
extern "C" pj_status_t pjmedia_codec_evs_init(pjmedia_endpt *endpt);
extern "C" pjmedia_endpt *pjsua_get_pjmedia_endpt(void);
#endif

static std::mutex g_out;
static void emitJson(const json& j) {
    std::lock_guard<std::mutex> lk(g_out);
    std::cout << j.dump() << "\n";
    std::cout.flush();
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

class MyCall;
class MyAccount;

// endpointId → Account/Call 매핑
static std::map<std::string, MyAccount*> g_accounts;
static std::map<std::string, MyCall*>    g_calls;   // endpointId → 활성 call (1통화/단말 가정)
static std::map<std::string, std::string> g_dtmfMode; // endpointId → "rfc2833"|"info"|"inband"
static std::map<std::string, AudioMediaRecorder*> g_recorders; // endpointId → 녹음기(활성 시)

class MyCall : public Call {
    std::string epId;
public:
    MyCall(Account& acc, const std::string& id, int callId = PJSUA_INVALID_ID)
        : Call(acc, callId), epId(id) {}

    virtual void onCallState(OnCallStateParam& /*prm*/) override {
        CallInfo ci = getInfo();
        std::string st = "ended";
        switch (ci.state) {
            case PJSIP_INV_STATE_CALLING:    st = "calling"; break;
            case PJSIP_INV_STATE_INCOMING:   st = "incoming"; break;
            case PJSIP_INV_STATE_EARLY:
            case PJSIP_INV_STATE_CONNECTING: st = "ringing"; break;
            case PJSIP_INV_STATE_CONFIRMED:  st = "connected"; break;
            case PJSIP_INV_STATE_DISCONNECTED: st = "ended"; break;
            default: break;
        }
        emitJson({{"ev","call"},{"endpointId",epId},{"call",st},{"remote",ci.remoteUri}});
        if (ci.state == PJSIP_INV_STATE_DISCONNECTED) {
            // 녹음 중이면 종료
            auto r = g_recorders.find(epId);
            if (r != g_recorders.end()) { try { delete r->second; } catch (...) {} g_recorders.erase(r); emitJson({{"ev","record"},{"endpointId",epId},{"recording",false}}); }
            if (g_calls[epId] == this) g_calls.erase(epId);
            delete this; // PJSUA2: DISCONNECTED 후 안전하게 해제
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
    }
};

class MyAccount : public Account {
public:
    std::string epId;
    bool autoAnswer = false;
    bool dnd = false;
    bool callWaiting = true;
    bool hideCallerId = false; // 발신자 번호 숨기기 (Privacy: id)
    explicit MyAccount(const std::string& id) : epId(id) {}

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
        CallInfo ci = call->getInfo();
        // 방해 금지 또는 (통화중대기 off + 이미 통화중) → 486 Busy 자동 거절
        if (dnd || (!callWaiting && busy)) {
            CallOpParam op; op.statusCode = PJSIP_SC_BUSY_HERE;
            try { call->hangup(op); } catch (...) {}
            if (!busy) g_calls[epId] = call; // 활성 호가 없을 때만 추적(onCallState 가 정리). 통화중이면 기존 호 보존.
            return;
        }
        g_calls[epId] = call;
        emitJson({{"ev","call"},{"endpointId",epId},{"call","incoming"},{"remote",ci.remoteUri}});
        if (autoAnswer) {
            CallOpParam op; op.statusCode = PJSIP_SC_OK;
            try { call->answer(op); } catch (...) {}
        }
    }
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
    acfg.mwiConfig.enabled = true; // 음성사서함(MWI) 구독
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

    auto it = g_accounts.find(id);
    try {
        if (it == g_accounts.end()) {
            MyAccount* acc = new MyAccount(id);
            acc->autoAnswer = ep.value("autoAnswer", false);
            acc->dnd = ep.value("dnd", false);
            acc->callWaiting = ep.value("callWaiting", true);
            acc->hideCallerId = ep.value("hideCallerId", false);
            acc->create(acfg);
            g_accounts[id] = acc;
        } else {
            it->second->autoAnswer = ep.value("autoAnswer", false);
            it->second->dnd = ep.value("dnd", false);
            it->second->callWaiting = ep.value("callWaiting", true);
            it->second->hideCallerId = ep.value("hideCallerId", false);
            it->second->modify(acfg);
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
    try {
        AccountInfo ai = acc->getInfo();
        std::string domain = ai.uri; // sip:user@domain
        size_t at = domain.find('@');
        host = at != std::string::npos ? domain.substr(at + 1) : "";
        size_t gt = host.find('>'); if (gt != std::string::npos) host = host.substr(0, gt);
    } catch (...) {}
    return "sip:" + target + (host.empty() ? "" : ("@" + host));
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
    std::string uri = toSipUri(it->second, target);
    MyCall* call = new MyCall(*it->second, id);
    g_calls[id] = call;
    try {
        CallOpParam op(true);
        // 텍스트 미디어(t140/red) 비활성화 — SDP 크기를 줄여 UDP MTU(1300) 안에 들어가게.
        // 일부 SIP 서버(SKBroadband 등) 가 TCP 로 fallback 한 INVITE 를 즉시 끊어 통화 실패.
        op.opt.audioCount = 1;
        op.opt.videoCount = 0;
        op.opt.textCount  = 0;
        if (it->second->hideCallerId) { // 발신자 번호 숨기기 (RFC3323)
            SipHeader h; h.hName = "Privacy"; h.hValue = "id"; op.txOption.headers.push_back(h);
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
    try { CallOpParam op; op.statusCode = PJSIP_SC_DECLINE; c->second->hangup(op); } catch (...) {}
}
static void cmdHold(const std::string& id, bool hold) {
    auto c = g_calls.find(id);
    if (c == g_calls.end()) return;
    try {
        CallOpParam op(true);
        if (hold) c->second->setHold(op);
        else { op.opt.flag = PJSUA_CALL_UNHOLD; c->second->reinvite(op); }
    } catch (...) {}
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
            rec->createRecorder(file);
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

// 호전환 — 현재 통화를 target 으로 blind transfer(REFER).
static void cmdTransfer(const std::string& id, const std::string& target) {
    auto c = g_calls.find(id);
    if (c == g_calls.end() || target.empty()) return;
    try { CallOpParam op; c->second->xfer(target, op); } catch (...) {}
}

static void cmdDtmf(const std::string& id, const std::string& digit) {
    auto c = g_calls.find(id);
    if (c == g_calls.end()) return;
    std::string mode = g_dtmfMode.count(id) ? g_dtmfMode[id] : "rfc2833";
    try {
        if (mode == "info") {
            CallSendDtmfParam p; p.method = PJSUA_DTMF_METHOD_SIP_INFO; p.digits = digit;
            c->second->sendDtmf(p);
        } else {
            // rfc2833(기본) / inband — dialDtmf 는 RFC2833 telephony-event 사용
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
        // SIP 전체 트레이스를 파일로 — stdout(프로토콜)은 깨끗이 유지(consoleLevel=0).
        // 경로: env PEPE_SIPD_LOG > %TEMP%\pepe-sipd.log > 현재 디렉터리.
        epcfg.logConfig.level = 5;
        epcfg.logConfig.consoleLevel = 0;
        // UDP MTU 초과 시 TCP fallback 임계치를 더 크게 — SDP 안에 text 미디어/여러 코덱 포함되면
        // 기본 1300 을 넘기 쉽다. 일부 SIP 서버(SKBroadband 등) 는 TCP INVITE 를 즉시 끊어버려
        // 통화가 실패함. 1500 (이더넷 MTU) 까지 UDP 로 보내도록 한다.
        epcfg.uaConfig.userAgent = "PePe-MicroSIP/1.0";
        {
            const char* envlog = getenv("PEPE_SIPD_LOG");
            std::string logf;
            if (envlog && *envlog) logf = envlog;
            else { const char* tmp = getenv("TEMP"); logf = (tmp && *tmp ? std::string(tmp) : std::string(".")) + "\\pepe-sipd.log"; }
            epcfg.logConfig.filename = logf;
            emitJson({{"ev","log"},{"level","info"},{"text",std::string("sipd log → ") + logf}});
        }
        g_ep.libInit(epcfg);

#ifdef PEPE_EVS
        // EVS(3GPP TS26.443) 커스텀 코덱 등록 — EVS/16000 이 코덱 매니저/SDP 에 노출됨
        {
            pjmedia_endpt *me = pjsua_get_pjmedia_endpt();
            pj_status_t es = me ? pjmedia_codec_evs_init(me) : -1;
            emitJson({{"ev","log"},{"level", es == PJ_SUCCESS ? "info" : "error"},
                      {"text", std::string("EVS codec register: ") + (es == PJ_SUCCESS ? "ok" : "failed")}});
        }
#endif

        // 전송 — UDP/TCP/TLS 모두 준비 (계정이 transport param 으로 선택)
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
            else if (cmd == "mute")       cmdMute(msg.value("endpointId", ""), msg.value("mute", false));
            else if (cmd == "transfer")   cmdTransfer(msg.value("endpointId", ""), msg.value("target", ""));
            else if (cmd == "record")     cmdRecord(msg.value("endpointId", ""), msg.value("on", false), msg.value("file", ""));
            else if (cmd == "dtmf")       cmdDtmf(msg.value("endpointId", ""), msg.value("digit", ""));
            else if (cmd == "audio")      cmdAudio(msg.value("input", ""), msg.value("output", ""));
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
