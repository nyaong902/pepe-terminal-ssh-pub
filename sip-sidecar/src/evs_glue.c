/* evs_glue.c — 3GPP EVS(TS 26.443, floating-point) 레퍼런스 인코더/디코더 래핑.
 * 이 파일은 EVS 헤더만 포함한다(pjmedia 헤더와 매크로 충돌 방지). EVS_GLUE_* 구성 고정.
 *
 * 빌드: gcc -I<evs>/lib_com -I<evs>/lib_enc -I<evs>/lib_dec ... evs_glue.c, libevs.a 링크.
 * 초기화는 EVS CLI(io_ini_enc/io_ini_dec)가 설정하는 state 필드만 복제 후 init_*().
 */
#include "options.h"
#include "cnst.h"
#include "prot.h"
#include "stat_enc.h"
#include "stat_dec.h"
#include <stdlib.h>
#include <string.h>
#include "evs_glue.h"

/* EVS 레퍼런스가 참조하는 전역 프레임 카운터(원래 CLI main 에 정의됨; 우린 CLI 미포함). */
long frame = 0;

/* 게이트웨이(IMS)는 EVS RTP 를 header-full 포맷으로 주고받는다: 매 프레임 앞에 1바이트
 * ToC(Table-of-Contents) 가 붙고 그 뒤가 음성 비트. ToC 의 FT 필드가 비트레이트를 지정.
 * (정상 클라이언트 pcap 분석으로 확정: 게이트웨이는 EVS Primary 64kbps = ToC(0x09)+160B.)
 * 13.2kbps Primary 송신용 ToC: H=0,F=0,E=0,x=0,FT=4 → 0x04. */
#define EVS_TOC_13200  0x04

/* ── 인코더 ── */
typedef struct {
    Encoder_State st;
    Indice        ind_list[MAX_NUM_INDICES];
} evs_enc_obj;

void *evs_glue_enc_create(void)
{
    evs_enc_obj *o = (evs_enc_obj *) calloc(1, sizeof(evs_enc_obj));
    Encoder_State *st;
    if (!o) return NULL;
    st = &o->st;
    /* io_ini_enc 가 설정하는 15개 필드 복제 (WB 13.2kbps Primary, DTX/RF off) */
    st->input_Fs          = EVS_GLUE_FS;
    st->total_brate       = EVS_GLUE_BRATE;
    st->Opt_AMR_WB        = 0;
    st->Opt_DTX_ON        = 0;
    st->Opt_RF_ON         = 0;
    st->rf_fec_offset     = 0;
    st->rf_fec_indicator  = 1;
    st->max_bwidth        = WB;
    st->interval_SID      = FIXED_SID_RATE;
    st->var_SID_rate_flag = 1;
    st->Opt_SC_VBR        = 0;
    st->last_Opt_SC_VBR   = 0;
    st->bitstreamformat   = G192;
    st->codec_mode        = MODE1;
    st->last_codec_mode   = MODE1;
    st->ind_list          = o->ind_list;
    init_encoder(st);
    return o;
}

/* 게이트웨이(IMS)가 fmtp 없이 compact(헤더 없는 음성 비트만, 레이트는 페이로드 크기로 구분)를
 * 쓰므로 우리도 compact 로 송신한다. 13.2kbps 고정 → 33바이트. */
int evs_glue_encode(void *enc, const short *pcm, unsigned char *out)
{
    evs_enc_obj *o = (evs_enc_obj *) enc;
    short nbits = 0;
    int nbytes;
    if (!o || !pcm || !out) return 0;
    reset_indices_enc(&o->st);
    evs_enc(&o->st, pcm, EVS_GLUE_FRAME);
    /* header-full: 선두에 ToC(13.2k) 1바이트, 그 뒤에 음성 비트(MSB-first) */
    out[0] = EVS_TOC_13200;
    indices_to_serial(&o->st, out + 1, &nbits);
    nbytes = (nbits + 7) / 8;
    return nbytes + 1;   /* ToC(1) + data */
}

void evs_glue_enc_destroy(void *enc)
{
    if (enc) { destroy_encoder(&((evs_enc_obj *) enc)->st); free(enc); }
}

/* ── 디코더 ── */
typedef struct {
    Decoder_State st;
} evs_dec_obj;

/* io_ini_dec(VOIP) 와 동일하게 셋업하되 init_decoder 는 첫 프레임으로 지연한다.
 * (EvsRXlib EVS_RX_Open: codec_mode=0 → 첫 프레임에서 init_decoder + 재파싱) */
void *evs_glue_dec_create(void)
{
    evs_dec_obj *o = (evs_dec_obj *) calloc(1, sizeof(evs_dec_obj));
    Decoder_State *st;
    if (!o) return NULL;
    st = &o->st;
    /* calloc 으로 cldfbAna/BPF/Syn, hFdCngDec = NULL, 모든 플래그 0 보장 */
    st->output_Fs          = EVS_GLUE_FS;
    st->codec_mode         = 0;   /* 첫 프레임 전 미정 — read_indices_from_djb 가 설정 */
    st->Opt_AMR_WB         = 0;
    st->Opt_VOIP           = 1;
    st->bitstreamformat    = G192;
    st->amrwb_rfc4867_flag = 0;
    st->total_brate        = 0;
    st->ini_frame          = 0;
    st->writeFECoffset     = 0;
    st->prev_use_partial_copy = 0;
    /* init_decoder 는 첫 evs_glue_decode 에서 호출 */
    return o;
}

/* EvsRXlib 의 프레임 디코드 루프를 그대로 복제(JBM 제외).
 * in==NULL || in_bytes<=0 → 손실 프레임(PLC) 로 처리해 디코더 상태 연속성 유지. */
int evs_glue_decode(void *dec, const unsigned char *in, int in_bytes, short *pcm)
{
    evs_dec_obj *o = (evs_dec_obj *) dec;
    Decoder_State *st;
    float synth[EVS_GLUE_FRAME];
    unsigned char *data = NULL;
    int num_bits;
    if (!o || !pcm) return 0;
    st = &o->st;
    /* header-full: 첫 바이트는 ToC, 데이터는 그 다음부터. 레이트는 데이터 비트수로 도출
     * (EVS Primary 전 레이트가 바이트 정렬 → num_bits=(in_bytes-1)*8 이 정확히 rate/50).
     * ToC만 있거나(NO_DATA) 빈 프레임이면 num_bits=0 → PLC. */
    if (in && in_bytes > 1) {
        if (in_bytes > EVS_GLUE_MAX_BYTES) return 0;
        data = (unsigned char *) in + 1;
        num_bits = (in_bytes - 1) * 8;
    } else {
        data = NULL;
        num_bits = 0;
    }

    /* 비트스트림을 디코더 상태로 읽어들임(레이트/모드/대역폭/bfi 도출) */
    if (st->codec_mode != 0) {
        read_indices_from_djb(st, data, num_bits, 0, 0);
    } else {
        /* 첫 프레임: init_decoder 가 total_brate 를 덮으므로 그 후 재파싱 */
        st->ini_frame = 0;
        st->prev_use_partial_copy = 0;
        init_decoder(st);
        read_indices_from_djb(st, data, num_bits, 0, 0);
    }

    /* 메인 디코딩 — codec_mode/bfi 에 따라 프레임 모드 선택(EvsRXlib 와 동일) */
    if (st->codec_mode == MODE1) {
        evs_dec(st, synth, FRAMEMODE_NORMAL);   /* Opt_AMR_WB=0 고정 */
    } else if (st->codec_mode == MODE2) {
        if (st->bfi == 0)      evs_dec(st, synth, FRAMEMODE_NORMAL);
        else if (st->bfi == 2) evs_dec(st, synth, FRAMEMODE_FUTURE);
        else                   evs_dec(st, synth, FRAMEMODE_MISSING);
    }

    if (st->codec_mode == MODE1 || st->codec_mode == MODE2) {
        /* syn_output 과 동일: mvr2s(반올림 + 16비트 saturation). syn_output 은 evs_local.o
         * 에서 로컬 심볼이라 링크 불가 → 동작을 그대로 인라인한다. */
        int i;
        for (i = 0; i < EVS_GLUE_FRAME; i++) {
            float v = synth[i];
            v = (v < 0.0f) ? (v - 0.5f) : (v + 0.5f);  /* round to nearest (mvr2s) */
            if (v > 32767.0f) v = 32767.0f;
            else if (v < -32768.0f) v = -32768.0f;
            pcm[i] = (short) v;
        }
        if (st->ini_frame < MAX_FRAME_COUNTER) st->ini_frame++;
    } else {
        memset(pcm, 0, sizeof(short) * EVS_GLUE_FRAME);
    }
    return EVS_GLUE_FRAME;
}

void evs_glue_dec_destroy(void *dec)
{
    if (dec) { destroy_decoder(&((evs_dec_obj *) dec)->st); free(dec); }
}
