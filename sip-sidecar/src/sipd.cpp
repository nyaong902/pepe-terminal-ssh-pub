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
        MyCall* call = new MyCall(*this, epId, prm.callId);
        g_calls[epId] = call;
        CallInfo ci = call->getInfo();
        emitJson({{"ev","call"},{"endpointId",epId},{"call","incoming"},{"remote",ci.remoteUri}});
        if (autoAnswer) {
            CallOpParam op; op.statusCode = PJSIP_SC_OK;
            try { call->answer(op); } catch (...) {}
        }
    }
};

static Endpoint g_ep;

static void setCodecPriorities(const json& codecs) {
    // 먼저 전부 0(비활성) 후, endpoint.codecs 순서대로 높은 우선순위 부여
    try {
        const CodecInfoVector2 all = g_ep.codecEnum2();
        for (auto& ci : all) g_ep.codecSetPriority(ci.codecId, 0);
    } catch (...) {}
    int prio = 254;
    for (auto& c : codecs) {
        std::string id = codecPjId(c.get<std::string>());
        if (id.empty()) continue;
        try { g_ep.codecSetPriority(id, (pj_uint8_t)prio); } catch (...) {}
        if (prio > 1) prio -= 8;
    }
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

    if (ep.contains("codecs")) setCodecPriorities(ep["codecs"]);

    std::string scheme = "sip";
    std::string tparam = transport == "tls" ? ";transport=tls" : transport == "tcp" ? ";transport=tcp" : "";
    AccountConfig acfg;
    std::string idUri = (disp.empty() ? std::string() : ("\"" + disp + "\" ")) + "<" + scheme + ":" + user + "@" + server + ">";
    acfg.idUri = idUri;
    acfg.regConfig.registrarUri = scheme + ":" + server + ":" + std::to_string(port) + tparam;
    if (!proxy.empty()) acfg.sipConfig.proxies.push_back(scheme + ":" + proxy + tparam);
    AuthCredInfo cred("digest", "*", authId.empty() ? user : authId, 0, pass);
    acfg.sipConfig.authCreds.push_back(cred);
    acfg.callConfig.timerMinSESec = 90;

    auto it = g_accounts.find(id);
    try {
        if (it == g_accounts.end()) {
            MyAccount* acc = new MyAccount(id);
            acc->autoAnswer = ep.value("autoAnswer", false);
            acc->create(acfg);
            g_accounts[id] = acc;
        } else {
            it->second->autoAnswer = ep.value("autoAnswer", false);
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
    emitJson({{"ev","reg"},{"endpointId",id},{"reg","unregistered"}});
}

static void cmdCall(const std::string& id, const std::string& target) {
    auto it = g_accounts.find(id);
    if (it == g_accounts.end()) { emitJson({{"ev","call"},{"endpointId",id},{"call","ended"},{"error","not registered"}}); return; }
    // target 이 sip URI 가 아니면 계정 도메인 기준으로 보정
    std::string uri = target;
    if (uri.rfind("sip:", 0) != 0 && uri.rfind("sips:", 0) != 0) {
        AccountInfo ai = it->second->getInfo();
        std::string domain = ai.uri; // sip:user@domain
        size_t at = domain.find('@');
        std::string host = at != std::string::npos ? domain.substr(at + 1) : "";
        // host 에서 닫는 '>' 제거
        size_t gt = host.find('>'); if (gt != std::string::npos) host = host.substr(0, gt);
        uri = "sip:" + target + "@" + host;
    }
    MyCall* call = new MyCall(*it->second, id);
    g_calls[id] = call;
    try { CallOpParam op(true); call->makeCall(uri, op); }
    catch (Error& e) { emitJson({{"ev","call"},{"endpointId",id},{"call","ended"},{"error",e.info()}}); g_calls.erase(id); delete call; }
}

static void cmdHangup(const std::string& id) {
    auto c = g_calls.find(id);
    if (c == g_calls.end()) return;
    try { CallOpParam p; c->second->hangup(p); } catch (...) {}
}

static void cmdDtmf(const std::string& id, const std::string& digit) {
    auto c = g_calls.find(id);
    if (c == g_calls.end()) return;
    try { c->second->dialDtmf(digit); } catch (...) {}
}

static void cmdAudio(const std::string& /*input*/, const std::string& /*output*/) {
    // deviceId(렌더러) ↔ PJMEDIA 장치 인덱스 매핑은 별도 동기화 필요.
    // 우선은 기본 장치를 사용; 확장 시 audDevManager().setCaptureDev/ setPlaybackDev 호출.
    emitLog("info", "audio device 설정은 Phase 2.1 에서 매핑 예정 (기본 장치 사용)");
}

int main() {
    try {
        g_ep.libCreate();
        EpConfig epcfg;
        epcfg.logConfig.level = 1;
        epcfg.logConfig.consoleLevel = 0; // PJSIP 로그가 stdout(프로토콜) 을 오염시키지 않도록
        g_ep.libInit(epcfg);

        // EVS 등 커스텀 코덱은 여기서 등록:  pjmedia_codec_evs_init(g_ep.mediaEndpt());  (구현 시)

        // 전송 — UDP/TCP/TLS 모두 준비 (계정이 transport param 으로 선택)
        { TransportConfig t; t.port = 0; try { g_ep.transportCreate(PJSIP_TRANSPORT_UDP, t); } catch (...) {} }
        { TransportConfig t; t.port = 0; try { g_ep.transportCreate(PJSIP_TRANSPORT_TCP, t); } catch (...) {} }
        { TransportConfig t; t.port = 0; try { g_ep.transportCreate(PJSIP_TRANSPORT_TLS, t); } catch (...) {} }

        g_ep.libStart();
        emitJson({{"ev","ready"}});
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
            else if (cmd == "dtmf")       cmdDtmf(msg.value("endpointId", ""), msg.value("digit", ""));
            else if (cmd == "audio")      cmdAudio(msg.value("input", ""), msg.value("output", ""));
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
