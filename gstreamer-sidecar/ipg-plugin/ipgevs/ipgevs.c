/*
 * ipgevs.c - thin adapter implementation. See ipgevs.h.
 *
 * Decode path: wraps the ETSI EVS reference decoder's jitter-buffered
 * EVS_RX_* API (lib_dec/EvsRXlib.h). Each call to evs_dec_process()
 * feeds exactly one compact-format frame ([1-byte ToC][speech payload],
 * as produced by ipgevsparse/crypto_tool's "#!EVS_MC1.0\n" file format)
 * to EVS_RX_FeedFrame() (which wants the payload bytes already packed,
 * same as the file's on-disk layout - see evs_dec_process()'s comment
 * for why an unpacked bit array here silently corrupts the decode) and
 * immediately drains one frame of PCM via EVS_RX_GetSamples().
 *
 * Encode path: wraps the raw init_encoder/evs_enc/indices_to_serial API
 * directly (there is no jitter-buffered TX-side helper lib), producing
 * the same compact [ToC][speech] format on output.
 */
#include "ipgevs.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#include "options.h"
#include "cnst.h"
#include "prot.h"
#include "stat_dec.h"
#include "stat_enc.h"
#include "EvsRXlib.h"

/* Same frame-size (bytes-per-payload, indexed by ToC FT nibble) tables as
 * gstipgevsbase.c's toc_evs_map/toc_wb_map - kept duplicated here since
 * this file must compile standalone against only the EVS reference
 * headers (no GStreamer plugin headers). */
static const int g_toc_evs_map[16] = {
    7, 18, 20, 24, 33, 41, 61, 80, 120, 160, 240, 320, 6, -1, -1, 0
};
static const int g_toc_wb_map[16] = {
    17, 23, 32, 36, 40, 46, 50, 58, 60, 5, -1, -1, -1, -1, 0, 0
};

struct _EvsDecoder {
    Decoder_State *st;
    EVS_RX_HANDLE hRx;
    unsigned int rtpSeq;
    unsigned int rcvTimeMs;
};

struct _EvsEncoder {
    Encoder_State *st;
    Indice *ind_list;
};

static void set_err(evs_error **err, const char *msg)
{
    if (!err) return;
    *err = (evs_error *)calloc(1, sizeof(evs_error));
    if (*err) {
        snprintf((*err)->log, sizeof((*err)->log), "%s", msg);
    }
}

void evs_error_free(evs_error *err)
{
    free(err);
}

EvsDecConfig *evs_dec_config_new(void)
{
    EvsDecConfig *cfg = (EvsDecConfig *)calloc(1, sizeof(EvsDecConfig));
    if (cfg) cfg->sample_rate = 48000;
    return cfg;
}

EvsEncConfig *evs_enc_config_new(void)
{
    EvsEncConfig *cfg = (EvsEncConfig *)calloc(1, sizeof(EvsEncConfig));
    if (cfg) {
        cfg->sample_rate = 16000;
        cfg->rate = 13200;
        cfg->max_band = 1; /* EVS_BANDWIDTH_WIDEBAND, kept in sync with gstipgevsenc.c's enum */
        cfg->limited_bw = TRUE;
    }
    return cfg;
}

EvsDecoder *evs_dec_init(EvsDecConfig *cfg, evs_error **err)
{
    EvsDecoder *dec;
    Decoder_State *st;

    /* gstipgevsdec.c declares its local `evs_error* error;` without
     * initializing it to NULL, then does `if (error) { ...fail... }` -
     * on the success path we must explicitly clear *err ourselves or
     * the caller's uninitialized stack garbage is misread as a failure. */
    if (err) *err = NULL;

    if (!cfg) { set_err(err, "evs_dec_init: null config"); return NULL; }

    dec = (EvsDecoder *)calloc(1, sizeof(EvsDecoder));
    if (!dec) { set_err(err, "evs_dec_init: out of memory"); return NULL; }

    st = (Decoder_State *)calloc(1, sizeof(Decoder_State));
    if (!st) { free(dec); set_err(err, "evs_dec_init: out of memory (Decoder_State)"); return NULL; }

    st->output_Fs = cfg->sample_rate;
    st->Opt_VOIP = 1;

    if (EVS_RX_Open(&dec->hRx, st, 0) != EVS_RX_NO_ERROR) {
        free(st);
        free(dec);
        set_err(err, "evs_dec_init: EVS_RX_Open failed");
        return NULL;
    }

    dec->st = st;
    dec->rtpSeq = 0;
    dec->rcvTimeMs = 0;
    return dec;
}

void evs_dec_process(EvsDecoder *dec, gint16 *pcm_out, gint *out_samples,
                      const guint8 *frame_with_toc, gint frame_size, evs_error **err)
{
    unsigned char packed[MAX_BITS_PER_FRAME / 8];
    unsigned int nOutSamples = 0;
    guint8 toc;
    gint ft, payload_size, num_bits;
    const int *map;
    const guint8 *payload;

    if (err) *err = NULL;
    if (out_samples) *out_samples = 0;

    if (!dec || !frame_with_toc || frame_size < 1) {
        set_err(err, "evs_dec_process: invalid arguments");
        return;
    }

    toc = frame_with_toc[0];
    payload = frame_with_toc + 1;
    ft = toc & 0x0F;
    map = (toc & 0x20) ? g_toc_wb_map : g_toc_evs_map; /* EVS-mode bit, matches ipgevsparse/ipgevsbase */
    payload_size = map[ft];
    if (payload_size < 0) {
        set_err(err, "evs_dec_process: reserved/unsupported ToC frame type");
        return;
    }
    if (1 + payload_size > frame_size) {
        set_err(err, "evs_dec_process: frame shorter than ToC indicates");
        return;
    }

    num_bits = payload_size * 8;
    if (num_bits > MAX_BITS_PER_FRAME) {
        set_err(err, "evs_dec_process: frame too large");
        return;
    }

    /* EVS_RX_FeedFrame's `au` param is the PACKED byte stream (it does
     * `memcpy(dataUnit->data, au, (auSize + 7) / 8)` internally, i.e. it
     * expects auSize in BITS but au already byte-packed) - passing an
     * unpacked one-bit-per-byte array here (as an earlier version of this
     * adapter did) makes it copy only the first (auSize+7)/8 *elements* of
     * that unpacked array, truncating to garbage and producing decoded
     * audio at roughly 1/1000th the correct amplitude instead of a clean
     * decode failure. Just forward the payload bytes as-is. */
    memcpy(packed, payload, (size_t)payload_size);

    if (EVS_RX_FeedFrame(dec->hRx, packed, (unsigned int)num_bits,
                          (unsigned short)(dec->rtpSeq++), dec->rcvTimeMs, dec->rcvTimeMs) != EVS_RX_NO_ERROR) {
        set_err(err, "evs_dec_process: EVS_RX_FeedFrame failed");
        return;
    }
    dec->rcvTimeMs += 20;

    if (EVS_RX_GetSamples(dec->hRx, &nOutSamples, (Word16 *)pcm_out,
                           (unsigned int)(dec->st->output_Fs / 50) * 4, dec->rcvTimeMs) != EVS_RX_NO_ERROR) {
        set_err(err, "evs_dec_process: EVS_RX_GetSamples failed");
        return;
    }

    if (out_samples) *out_samples = (gint)nOutSamples;
}

void evs_dec_free(EvsDecoder *dec)
{
    if (!dec) return;
    if (dec->hRx) EVS_RX_Close(&dec->hRx);
    free(dec->st);
    free(dec);
}

/* ---- Encoder ---- */

/* Mirrors lib_enc/io_enc.c's io_ini_enc() MODE1/MODE2 selection table -
 * init_encoder() itself does not derive codec_mode from total_brate, it
 * only reads whatever the caller already set, so getting this wrong
 * leads to internal DSP assertion failures/corruption (e.g. TCX overlap
 * mismatches) rather than a clean error. */
static short codec_mode_for_rate(gint rate)
{
    switch (rate) {
        case 5900: case 7200: case 8000: case 13200: case 32000: case 64000:
            return MODE1;
        case 9600: case 16400: case 24400: case 48000: case 96000: case 128000:
            return MODE2;
        default:
            return MODE1;
    }
}

EvsEncoder *evs_enc_init(EvsEncConfig *cfg, evs_error **err)
{
    EvsEncoder *enc;
    Encoder_State *st;

    if (err) *err = NULL;
    if (!cfg) { set_err(err, "evs_enc_init: null config"); return NULL; }

    enc = (EvsEncoder *)calloc(1, sizeof(EvsEncoder));
    if (!enc) { set_err(err, "evs_enc_init: out of memory"); return NULL; }

    st = (Encoder_State *)calloc(1, sizeof(Encoder_State));
    if (!st) { free(enc); set_err(err, "evs_enc_init: out of memory (Encoder_State)"); return NULL; }

    enc->ind_list = (Indice *)calloc(MAX_NUM_INDICES, sizeof(Indice));
    if (!enc->ind_list) { free(st); free(enc); set_err(err, "evs_enc_init: out of memory (ind_list)"); return NULL; }

    st->input_Fs = cfg->sample_rate;
    st->total_brate = cfg->rate;
    st->max_bwidth = cfg->max_band;
    if (st->input_Fs == 8000 && st->max_bwidth > 0) st->max_bwidth = 0;        /* NB */
    else if (st->input_Fs == 16000 && st->max_bwidth > 1) st->max_bwidth = 1; /* WB */
    else if (st->input_Fs == 32000 && st->max_bwidth > 2) st->max_bwidth = 2; /* SWB */
    st->Opt_AMR_WB = 0;
    st->Opt_DTX_ON = cfg->dtx_mode ? 1 : 0;
    st->Opt_RF_ON = cfg->rf_mode ? 1 : 0;
    st->bitstreamformat = MIME;
    st->ind_list = enc->ind_list;
    st->codec_mode = codec_mode_for_rate(cfg->rate);
    if (st->total_brate == 13200 && st->Opt_RF_ON == 1) st->codec_mode = MODE2;

    init_encoder(st);

    enc->st = st;
    return enc;
}

void evs_enc_process(EvsEncoder *enc, const gint16 *speech_in, gint in_samples,
                      guint8 *out, gint *out_size, evs_error **err)
{
    unsigned char pFrame[(MAX_BITS_PER_FRAME + 7) / 8];
    Word16 pFrame_size = 0;
    gint num_bytes, ft, i;
    const int *map = g_toc_evs_map;

    if (err) *err = NULL;
    if (out_size) *out_size = 0;
    if (!enc || !speech_in || !out) { set_err(err, "evs_enc_process: invalid arguments"); return; }

    /* evs_enc() appends new indices onto st->ind_list starting at
     * st->next_ind without resetting it first (encoder.c's own reference
     * main loop relies on this only being zeroed once, at init_encoder()
     * time, and apparently never encodes more than one frame per process
     * lifetime in its documented usage) - reset per-frame here or indices
     * (and therefore indices_to_serial()'s output size) accumulate across
     * calls. */
    reset_indices_enc(enc->st);
    evs_enc(enc->st, (const short *)speech_in, (short)in_samples);
    indices_to_serial(enc->st, pFrame, &pFrame_size);

    num_bytes = (pFrame_size + 7) / 8;
    /* find matching ToC FT for this frame's bit-length among the EVS primary table */
    ft = -1;
    for (i = 0; i < 16; i++) {
        if (map[i] == num_bytes) { ft = i; break; }
    }
    if (ft < 0) {
        set_err(err, "evs_enc_process: could not map encoded frame size to a ToC entry");
        return;
    }

    out[0] = (guint8)ft; /* H=0,F=0,EVS-mode-bit=0 (primary mode) */
    memcpy(out + 1, pFrame, num_bytes);
    if (out_size) *out_size = 1 + num_bytes;
}

void evs_enc_free(EvsEncoder *enc)
{
    if (!enc) return;
    free(enc->st);
    free(enc->ind_list);
    free(enc);
}
