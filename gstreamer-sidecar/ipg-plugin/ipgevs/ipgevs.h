/*
 * ipgevs.h - thin adapter exposing the simple encoder/decoder API that
 * gstipgevsdec.c / gstipgevsenc.c expect, implemented on top of the
 * ETSI EVS reference codec's EVS_RX_* (jitter-buffer receiver) API for
 * decoding, and the raw init_encoder/evs_enc API for encoding.
 *
 * This header intentionally hides all EVS reference-codec internal types
 * (Decoder_State, Encoder_State, Word16, etc.) behind opaque pointers so
 * that the GStreamer element code never needs to see them.
 */
#ifndef __IPGEVS_H__
#define __IPGEVS_H__

#include <glib.h>

G_BEGIN_DECLS

typedef struct _EvsDecConfig {
    gint sample_rate;   /* output PCM sample rate: 8000/16000/32000/48000 */
} EvsDecConfig;

typedef struct _EvsEncConfig {
    gint sample_rate;
    gint rate;              /* target bitrate in bps, e.g. 13200 */
    gint max_band;           /* EVS_BANDWIDTH_* */
    gboolean limited_bw;
    gboolean dtx_mode;
    gint dtx;
    gboolean rf_mode;
    gint rf_fec_indicator;
    gint rf_fec_offset;
} EvsEncConfig;

typedef struct _EvsDecoder EvsDecoder;
typedef struct _EvsEncoder EvsEncoder;

typedef struct _evs_error {
    gchar log[256];
} evs_error;

EvsDecConfig* evs_dec_config_new(void);
EvsEncConfig* evs_enc_config_new(void);

/* toc: 1-byte ToC (frame-type) byte read from the compact [TOC][speech] file
 * format (as produced by ipgevsparse). payload/payload_size: the speech
 * bytes that follow the ToC for this frame (NOT including the Toc byte
 * itself). pcm_out: caller-allocated buffer sized for the max frame
 * (sample_rate * 240/1000 samples). *out_samples receives the actual
 * decoded sample count. */
EvsDecoder* evs_dec_init(EvsDecConfig* cfg, evs_error** err);
void evs_dec_process(EvsDecoder* dec, gint16* pcm_out, gint* out_samples,
                      const guint8* frame_with_toc, gint frame_size, evs_error** err);
void evs_dec_free(EvsDecoder* dec);

EvsEncoder* evs_enc_init(EvsEncConfig* cfg, evs_error** err);
/* speech_in: interleaved S16 samples, in_samples: sample count.
 * out: caller-allocated buffer (see allocate_speech_data in gstipgevsenc.c),
 * *out_size receives the encoded byte count (ToC byte + payload). */
void evs_enc_process(EvsEncoder* enc, const gint16* speech_in, gint in_samples,
                      guint8* out, gint* out_size, evs_error** err);
void evs_enc_free(EvsEncoder* enc);

void evs_error_free(evs_error* err);

G_END_DECLS

#endif /* __IPGEVS_H__ */
