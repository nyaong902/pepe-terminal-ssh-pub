/* pjmedia_codec_evs.c — pjmedia 코덱 팩토리/구현: 3GPP EVS Primary WB 13.2kbps.
 * EVS 인코더/디코더는 evs_glue.c(별도 컴파일 단위, EVS 헤더 격리)를 호출한다.
 * 동적 PT, encoding_name "EVS", 16kHz mono, 20ms(320 샘플), 33바이트/프레임(compact).
 *
 * 등록: sipd 가 libInit 직후 pjmedia_codec_evs_init(endpt) 호출.
 */
#include <pjmedia/codec.h>
#include <pjmedia/errno.h>
#include <pjmedia/endpoint.h>
#include <pjmedia/port.h>
#include <pj/assert.h>
#include <pj/pool.h>
#include <pj/string.h>
#include <pj/os.h>
#include "evs_glue.h"

#define EVS_PTIME       20
#define EVS_SAMPLES     EVS_GLUE_FRAME      /* 320 */
#define EVS_PCM_BYTES   (EVS_SAMPLES * 2)   /* 640 */
#define EVS_CLOCK       EVS_GLUE_FS         /* 16000 */
#define EVS_SPEECH_BYTES 33                 /* 13.2 kbps → 264 bits → 33 bytes (음성부) */
#define EVS_FRAME_BYTES  34                 /* header-full: ToC(1) + 33 = 34 bytes/frame */
#define EVS_DEF_PT      96                  /* 동적 PT 기본값(SDP 협상 시 재배정) */

PJ_DECL(pj_status_t) pjmedia_codec_evs_init(pjmedia_endpt *endpt);
PJ_DECL(pj_status_t) pjmedia_codec_evs_deinit(void);

/* factory ops */
static pj_status_t evs_test_alloc(pjmedia_codec_factory *f, const pjmedia_codec_info *id);
static pj_status_t evs_default_attr(pjmedia_codec_factory *f, const pjmedia_codec_info *id, pjmedia_codec_param *attr);
static pj_status_t evs_enum_codecs(pjmedia_codec_factory *f, unsigned *count, pjmedia_codec_info codecs[]);
static pj_status_t evs_alloc_codec(pjmedia_codec_factory *f, const pjmedia_codec_info *id, pjmedia_codec **p_codec);
static pj_status_t evs_dealloc_codec(pjmedia_codec_factory *f, pjmedia_codec *codec);

/* codec ops */
static pj_status_t evs_codec_init(pjmedia_codec *codec, pj_pool_t *pool);
static pj_status_t evs_codec_open(pjmedia_codec *codec, pjmedia_codec_param *attr);
static pj_status_t evs_codec_close(pjmedia_codec *codec);
static pj_status_t evs_codec_modify(pjmedia_codec *codec, const pjmedia_codec_param *attr);
static pj_status_t evs_codec_parse(pjmedia_codec *codec, void *pkt, pj_size_t pkt_size,
                                   const pj_timestamp *ts, unsigned *frame_cnt, pjmedia_frame frames[]);
static pj_status_t evs_codec_encode(pjmedia_codec *codec, const struct pjmedia_frame *input,
                                    unsigned out_size, struct pjmedia_frame *output);
static pj_status_t evs_codec_decode(pjmedia_codec *codec, const struct pjmedia_frame *input,
                                    unsigned out_size, struct pjmedia_frame *output);

static pjmedia_codec_op evs_op =
{
    &evs_codec_init, &evs_codec_open, &evs_codec_close, &evs_codec_modify,
    &evs_codec_parse, &evs_codec_encode, &evs_codec_decode, NULL /* recover(PLC) */
};

static pjmedia_codec_factory_op evs_factory_op =
{
    &evs_test_alloc, &evs_default_attr, &evs_enum_codecs,
    &evs_alloc_codec, &evs_dealloc_codec, &pjmedia_codec_evs_deinit
};

static struct evs_factory
{
    pjmedia_codec_factory  base;
    pjmedia_endpt         *endpt;
    pj_pool_t             *pool;
    pj_mutex_t            *mutex;
    pjmedia_codec          codec_list;
} evs_factory;

struct evs_priv
{
    void *enc;   /* evs_glue 인코더 */
    void *dec;   /* evs_glue 디코더 */
};

static const pj_str_t EVS_NAME = { "EVS", 3 };

PJ_DEF(pj_status_t) pjmedia_codec_evs_init(pjmedia_endpt *endpt)
{
    pjmedia_codec_mgr *mgr;
    pj_status_t status;

    if (evs_factory.pool != NULL) return PJ_SUCCESS;

    evs_factory.base.op = &evs_factory_op;
    evs_factory.base.factory_data = NULL;
    evs_factory.endpt = endpt;
    evs_factory.pool = pjmedia_endpt_create_pool(endpt, "evs", 1000, 1000);
    if (!evs_factory.pool) return PJ_ENOMEM;
    pj_list_init(&evs_factory.codec_list);

    status = pj_mutex_create_simple(evs_factory.pool, "evs", &evs_factory.mutex);
    if (status != PJ_SUCCESS) goto on_error;

    mgr = pjmedia_endpt_get_codec_mgr(endpt);
    if (!mgr) { status = PJ_EINVALIDOP; goto on_error; }

    status = pjmedia_codec_mgr_register_factory(mgr, &evs_factory.base);
    if (status != PJ_SUCCESS) goto on_error;
    return PJ_SUCCESS;

on_error:
    if (evs_factory.mutex) { pj_mutex_destroy(evs_factory.mutex); evs_factory.mutex = NULL; }
    pj_pool_release(evs_factory.pool);
    evs_factory.pool = NULL;
    return status;
}

PJ_DEF(pj_status_t) pjmedia_codec_evs_deinit(void)
{
    pjmedia_codec_mgr *mgr;
    pj_status_t status = PJ_SUCCESS;
    if (evs_factory.pool == NULL) return PJ_SUCCESS;
    mgr = pjmedia_endpt_get_codec_mgr(evs_factory.endpt);
    if (mgr) status = pjmedia_codec_mgr_unregister_factory(mgr, &evs_factory.base);
    if (evs_factory.mutex) { pj_mutex_destroy(evs_factory.mutex); evs_factory.mutex = NULL; }
    pj_pool_release(evs_factory.pool);
    evs_factory.pool = NULL;
    return status;
}

static pj_status_t evs_test_alloc(pjmedia_codec_factory *f, const pjmedia_codec_info *id)
{
    PJ_UNUSED_ARG(f);
    if (id->type != PJMEDIA_TYPE_AUDIO) return PJMEDIA_CODEC_EUNSUP;
    if (pj_stricmp(&id->encoding_name, &EVS_NAME) != 0) return PJMEDIA_CODEC_EUNSUP;
    if (id->clock_rate != EVS_CLOCK) return PJMEDIA_CODEC_EUNSUP;
    return PJ_SUCCESS;
}

static pj_status_t evs_default_attr(pjmedia_codec_factory *f, const pjmedia_codec_info *id,
                                    pjmedia_codec_param *attr)
{
    PJ_UNUSED_ARG(f); PJ_UNUSED_ARG(id);
    pj_bzero(attr, sizeof(pjmedia_codec_param));
    attr->info.clock_rate = EVS_CLOCK;
    attr->info.channel_cnt = 1;
    attr->info.avg_bps = EVS_GLUE_BRATE;
    attr->info.max_bps = EVS_GLUE_BRATE;
    attr->info.pcm_bits_per_sample = 16;
    attr->info.frm_ptime = EVS_PTIME;
    attr->info.pt = EVS_DEF_PT;
    attr->setting.frm_per_pkt = 1;
    attr->setting.vad = 0;
    attr->setting.plc = 0;
    /* fmtp 기본은 비움(EVS 기본 동작) — 게이트웨이 요구에 맞춰 추후 br/bw 추가 가능 */
    return PJ_SUCCESS;
}

static pj_status_t evs_enum_codecs(pjmedia_codec_factory *f, unsigned *count, pjmedia_codec_info codecs[])
{
    PJ_UNUSED_ARG(f);
    PJ_ASSERT_RETURN(codecs && *count > 0, PJ_EINVAL);
    pj_bzero(&codecs[0], sizeof(pjmedia_codec_info));
    codecs[0].encoding_name = EVS_NAME;
    codecs[0].pt = EVS_DEF_PT;
    codecs[0].type = PJMEDIA_TYPE_AUDIO;
    codecs[0].clock_rate = EVS_CLOCK;
    codecs[0].channel_cnt = 1;
    *count = 1;
    return PJ_SUCCESS;
}

static pj_status_t evs_alloc_codec(pjmedia_codec_factory *f, const pjmedia_codec_info *id,
                                   pjmedia_codec **p_codec)
{
    pjmedia_codec *codec;
    PJ_ASSERT_RETURN(f && id && p_codec, PJ_EINVAL);
    PJ_ASSERT_RETURN(f == &evs_factory.base, PJ_EINVAL);

    pj_mutex_lock(evs_factory.mutex);
    if (!pj_list_empty(&evs_factory.codec_list)) {
        codec = evs_factory.codec_list.next;
        pj_list_erase(codec);
    } else {
        codec = PJ_POOL_ZALLOC_T(evs_factory.pool, pjmedia_codec);
        codec->op = &evs_op;
        codec->factory = f;
        codec->codec_data = PJ_POOL_ZALLOC_T(evs_factory.pool, struct evs_priv);
    }
    pj_mutex_unlock(evs_factory.mutex);
    *p_codec = codec;
    return PJ_SUCCESS;
}

static pj_status_t evs_dealloc_codec(pjmedia_codec_factory *f, pjmedia_codec *codec)
{
    PJ_UNUSED_ARG(f);
    PJ_ASSERT_RETURN(codec, PJ_EINVAL);
    evs_codec_close(codec);
    pj_mutex_lock(evs_factory.mutex);
    pj_list_push_front(&evs_factory.codec_list, codec);
    pj_mutex_unlock(evs_factory.mutex);
    return PJ_SUCCESS;
}

static pj_status_t evs_codec_init(pjmedia_codec *codec, pj_pool_t *pool)
{
    PJ_UNUSED_ARG(codec); PJ_UNUSED_ARG(pool);
    return PJ_SUCCESS;
}

static pj_status_t evs_codec_open(pjmedia_codec *codec, pjmedia_codec_param *attr)
{
    struct evs_priv *d = (struct evs_priv *) codec->codec_data;
    PJ_UNUSED_ARG(attr);
    pj_assert(d && d->enc == NULL && d->dec == NULL);
    d->enc = evs_glue_enc_create();
    d->dec = evs_glue_dec_create();
    if (!d->enc || !d->dec) { evs_codec_close(codec); return PJMEDIA_CODEC_EFAILED; }
    return PJ_SUCCESS;
}

static pj_status_t evs_codec_close(pjmedia_codec *codec)
{
    struct evs_priv *d = (struct evs_priv *) codec->codec_data;
    if (d->enc) { evs_glue_enc_destroy(d->enc); d->enc = NULL; }
    if (d->dec) { evs_glue_dec_destroy(d->dec); d->dec = NULL; }
    return PJ_SUCCESS;
}

static pj_status_t evs_codec_modify(pjmedia_codec *codec, const pjmedia_codec_param *attr)
{
    PJ_UNUSED_ARG(codec); PJ_UNUSED_ARG(attr);
    return PJ_SUCCESS;
}

/* EVS는 RTP 패킷당 1 프레임(ptime 20ms). 페이로드(ToC[+CMR]+음성)를 통째로 1프레임으로 전달
 * → 디코더(evs_glue)가 헤더를 자동 스킵한다. (멀티프레임 패킷은 미사용) */
static pj_status_t evs_codec_parse(pjmedia_codec *codec, void *pkt, pj_size_t pkt_size,
                                   const pj_timestamp *ts, unsigned *frame_cnt, pjmedia_frame frames[])
{
    PJ_UNUSED_ARG(codec);
    PJ_ASSERT_RETURN(frame_cnt && *frame_cnt > 0, PJ_EINVAL);
    if (pkt_size == 0) { *frame_cnt = 0; return PJ_SUCCESS; }
    frames[0].type = PJMEDIA_FRAME_TYPE_AUDIO;
    frames[0].buf = pkt;
    frames[0].size = pkt_size;
    frames[0].timestamp = *ts;
    *frame_cnt = 1;
    return PJ_SUCCESS;
}

static pj_status_t evs_codec_encode(pjmedia_codec *codec, const struct pjmedia_frame *input,
                                    unsigned out_size, struct pjmedia_frame *output)
{
    struct evs_priv *d = (struct evs_priv *) codec->codec_data;
    const pj_int16_t *pcm = (const pj_int16_t *) input->buf;
    pj_size_t in_size = input->size;
    pj_size_t produced = 0;

    pj_assert(d && d->enc);
    PJ_ASSERT_RETURN(in_size % EVS_PCM_BYTES == 0, PJMEDIA_CODEC_EPCMFRMINLEN);
    PJ_ASSERT_RETURN(out_size >= EVS_FRAME_BYTES * (in_size / EVS_PCM_BYTES), PJMEDIA_CODEC_EFRMTOOSHORT);

    while (in_size >= EVS_PCM_BYTES) {
        int n = evs_glue_encode(d->enc, pcm, (unsigned char *) output->buf + produced);
        if (n <= 0) return PJMEDIA_CODEC_EFAILED;
        produced += (pj_size_t) n;
        pcm += EVS_SAMPLES;
        in_size -= EVS_PCM_BYTES;
    }
    output->size = produced;
    output->type = PJMEDIA_FRAME_TYPE_AUDIO;
    output->timestamp = input->timestamp;
    return PJ_SUCCESS;
}

static pj_status_t evs_codec_decode(pjmedia_codec *codec, const struct pjmedia_frame *input,
                                    unsigned out_size, struct pjmedia_frame *output)
{
    struct evs_priv *d = (struct evs_priv *) codec->codec_data;
    int n;
    pj_assert(d && d->dec);
    PJ_ASSERT_RETURN(out_size >= EVS_PCM_BYTES, PJMEDIA_CODEC_EPCMTOOSHORT);
    if (input->size < EVS_SPEECH_BYTES) return PJMEDIA_CODEC_EFRMTOOSHORT;

    n = evs_glue_decode(d->dec, (const unsigned char *) input->buf, (int) input->size,
                        (short *) output->buf);
    if (n <= 0) return PJMEDIA_CODEC_EFAILED;
    output->size = EVS_PCM_BYTES;
    output->type = PJMEDIA_FRAME_TYPE_AUDIO;
    output->timestamp = input->timestamp;
    return PJ_SUCCESS;
}
