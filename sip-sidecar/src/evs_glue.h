/* evs_glue.h — 3GPP EVS(TS 26.443) 레퍼런스에 대한 얇은 C API.
 * EVS 헤더(거대·매크로 다수)를 pjmedia 코덱 파일과 분리하기 위한 경계.
 * 고정 구성: EVS Primary, 16kHz WB, 13.2 kbps, 20ms 프레임(320 샘플, 33바이트/프레임 compact).
 */
#ifndef EVS_GLUE_H
#define EVS_GLUE_H
#ifdef __cplusplus
extern "C" {
#endif

#define EVS_GLUE_FS         16000   /* 샘플레이트 */
#define EVS_GLUE_FRAME      320     /* 20ms @ 16kHz */
#define EVS_GLUE_BRATE      13200   /* 13.2 kbps (WB) */
#define EVS_GLUE_MAX_BYTES  320     /* 페이로드 버퍼 여유 (실제 33바이트) */

void *evs_glue_enc_create(void);
/* pcm: 320 short. out: >=EVS_GLUE_MAX_BYTES. 반환: 인코딩 바이트 수(>0) / 실패 0 */
int   evs_glue_encode(void *enc, const short *pcm, unsigned char *out);
void  evs_glue_enc_destroy(void *enc);

void *evs_glue_dec_create(void);
/* in: compact 바이트. pcm: >=320 short. 반환: 디코딩 샘플 수(320) / 실패 0 */
int   evs_glue_decode(void *dec, const unsigned char *in, int in_bytes, short *pcm);
void  evs_glue_dec_destroy(void *dec);

#ifdef __cplusplus
}
#endif
#endif
