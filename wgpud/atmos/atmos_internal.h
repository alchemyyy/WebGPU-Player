/*
 * What the renderer and its binaural stage share inside wgpud/atmos/; the packages use atmos.h only.
 */
#ifndef WGPUD_ATMOS_INTERNAL_H
#define WGPUD_ATMOS_INTERNAL_H

#include <stdint.h>

#include "atmos.h"

/* The virtual layout the binaural stage listens to: 7.1.4, whose LFE plane is the fourth */
#define ATMOS_BINAURAL_VIRTUAL_LAYOUT ATMOS_LAYOUT_7_1_4
#define ATMOS_BINAURAL_VIRTUAL_CHANNELS 12
#define ATMOS_BINAURAL_LFE_CHANNEL 3
/* The virtual speakers with head-related impulse responses: every 7.1.4 channel but the LFE, in its plane order */
#define ATMOS_HRIR_SPEAKER_COUNT 11

/* The HRIR table atmos_hrir.c holds, which scripts/generate-atmos-hrir.mjs writes: per virtual speaker, the left then the right ear,
 * ATMOS_HRIR_LENGTH taps at ATMOS_BINAURAL_SAMPLE_RATE */
#define ATMOS_HRIR_LENGTH 160
extern const float atmos_hrir[ATMOS_HRIR_SPEAKER_COUNT][2][ATMOS_HRIR_LENGTH];

/* The LFE's gain into each ear, which bypasses the HRIRs */
#define ATMOS_BINAURAL_LFE_GAIN 0.5f

typedef struct AtmosBinaural AtmosBinaural;

AtmosBinaural *atmos_binaural_create(void);
void atmos_binaural_destroy(AtmosBinaural *binaural);
/* Clears the delay line and the convolution's history */
void atmos_binaural_reset(AtmosBinaural *binaural);
/* Convolves frame_count samples of the virtual layout's planes into the two ears, ATMOS_BINAURAL_LATENCY samples late */
void atmos_binaural_process(AtmosBinaural *binaural, float *const *virtual_planes, uint32_t frame_count, float *left, float *right);

#endif
