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

/* RTP header-full ToC(EVS Primary 13.2kbps): H=0,F=0,FT=PRIMARY_13200(4) → 0x04.
 * fmtp 미지정 시 RFC8627 기본은 header-full(프레임마다 ToC) 이므로 ToC 를 붙인다. */
#define EVS_TOC_13K2   0x04
#define EVS_SPEECH_BYTES ((EVS_GLUE_BRATE / 50 + 7) / 8)  /* 13200/50=264bit → 33 */

int evs_glue_encode(void *enc, const short *pcm, unsigned char *out)
{
    evs_enc_obj *o = (evs_enc_obj *) enc;
    unsigned char frame[EVS_GLUE_MAX_BYTES];
    short nbits = 0;
    int fb;
    if (!o || !pcm || !out) return 0;
    reset_indices_enc(&o->st);
    evs_enc(&o->st, pcm, EVS_GLUE_FRAME);
    indices_to_serial(&o->st, frame, &nbits);
    fb = (nbits + 7) / 8;
    out[0] = EVS_TOC_13K2;            /* ToC */
    memcpy(out + 1, frame, (size_t) fb);
    return fb + 1;                    /* header-full: 1(ToC) + 33 = 34 */
}

void evs_glue_enc_destroy(void *enc)
{
    if (enc) { destroy_encoder(&((evs_enc_obj *) enc)->st); free(enc); }
}

/* ── 디코더 ── */
typedef struct {
    Decoder_State st;
} evs_dec_obj;

void *evs_glue_dec_create(void)
{
    evs_dec_obj *o = (evs_dec_obj *) calloc(1, sizeof(evs_dec_obj));
    Decoder_State *st;
    if (!o) return NULL;
    st = &o->st;
    /* io_ini_dec 가 설정하는 필드 복제 */
    st->output_Fs         = EVS_GLUE_FS;
    st->total_brate       = EVS_GLUE_BRATE;
    st->Opt_AMR_WB        = 0;
    st->Opt_VOIP          = 0;
    st->codec_mode        = MODE1;
    st->last_codec_mode   = MODE1;
    st->bitstreamformat   = G192;
    st->amrwb_rfc4867_flag = 0;
    st->ini_frame         = 0;
    st->writeFECoffset    = 0;
    init_decoder(st);
    return o;
}

int evs_glue_decode(void *dec, const unsigned char *in, int in_bytes, short *pcm)
{
    evs_dec_obj *o = (evs_dec_obj *) dec;
    float synth[EVS_GLUE_FRAME];
    int i;
    int off;
    if (!o || !in || !pcm || in_bytes <= 0) return 0;
    o->st.total_brate = EVS_GLUE_BRATE; /* 고정 13.2k (rate 는 ToC/fmtp 가 아닌 고정값 사용) */
    /* 헤더(ToC[+CMR]) 자동 스킵: 음성 프레임은 33바이트 고정 → 앞쪽 잉여를 헤더로 간주.
     * compact(33)→off0, header-full(34: ToC+33)→off1, CMR+ToC(35)→off2. */
    off = in_bytes - EVS_SPEECH_BYTES;
    if (off < 0) off = 0;
    read_indices_from_djb(&o->st, (unsigned char *) in + off, EVS_SPEECH_BYTES * 8, 0, 0);
    evs_dec(&o->st, synth, FRAMEMODE_NORMAL);
    for (i = 0; i < EVS_GLUE_FRAME; i++) {
        float v = synth[i];
        if (v > 32767.0f) v = 32767.0f;
        else if (v < -32768.0f) v = -32768.0f;
        pcm[i] = (short) v;
    }
    return EVS_GLUE_FRAME;
}

void evs_glue_dec_destroy(void *dec)
{
    if (dec) { destroy_decoder(&((evs_dec_obj *) dec)->st); free(dec); }
}
