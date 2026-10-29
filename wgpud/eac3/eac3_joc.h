/*
 * Joint object coding of ETSI TS 103 420 V1.2.1 clause 6: the JOC payload an E-AC-3 frame's EMDF container carries,
 * and the decoder that rebuilds up to 16 object signals from the 5 or 7 channels of the decoded E-AC-3 downmix.
 */
#ifndef EAC3_JOC_H
#define EAC3_JOC_H

#include <stddef.h>
#include <stdint.h>

#include "eac3_qmf.h"

#define EAC3_JOC_MAX_OBJECTS 16
#define EAC3_JOC_MAX_CHANNELS 7
#define EAC3_JOC_MAX_BANDS 23
#define EAC3_JOC_MAX_DATA_POINTS 2
/* Timeslots of the longest E-AC-3 frame: six audio blocks of 256 samples */
#define EAC3_JOC_MAX_TIMESLOTS 24

/* Table 47's downmix configurations */
enum EAC3JOCDownmix {
    EAC3_JOC_DOWNMIX_5 = 0,
    EAC3_JOC_DOWNMIX_7 = 1,
    EAC3_JOC_DOWNMIX_5_2 = 2,
    EAC3_JOC_DOWNMIX_5_PHASE_SHIFTED = 3,
    EAC3_JOC_DOWNMIX_5_2_PHASE_SHIFTED = 4
};

/* The downmix channels a configuration's matrices address, in table 53's order */
enum EAC3JOCChannel {
    EAC3_JOC_LEFT,
    EAC3_JOC_RIGHT,
    EAC3_JOC_CENTRE,
    EAC3_JOC_LEFT_SURROUND,
    EAC3_JOC_RIGHT_SURROUND,
    EAC3_JOC_LEFT_BACK,
    EAC3_JOC_RIGHT_BACK,
    EAC3_JOC_TOP_FRONT_LEFT,
    EAC3_JOC_TOP_FRONT_RIGHT
};

typedef struct EAC3JOCObject {
    uint8_t present;
    uint8_t band_count;
    /* Steep interpolation, at the data points' timeslots, rather than smooth */
    uint8_t steep;
    uint8_t data_point_count;
    uint8_t data_point_timeslot[EAC3_JOC_MAX_DATA_POINTS];
    /* Clause 6.6.4's dequantized matrix per data point, input channel, and parameter band */
    float matrix[EAC3_JOC_MAX_DATA_POINTS][EAC3_JOC_MAX_CHANNELS][EAC3_JOC_MAX_BANDS];
} EAC3JOCObject;

/* One frame's JOC payload, parsed and dequantized */
typedef struct EAC3JOCFrame {
    uint8_t downmix;
    uint8_t channel_count;
    uint8_t object_count;
    uint16_t sequence_count;
    EAC3JOCObject objects[EAC3_JOC_MAX_OBJECTS];
} EAC3JOCFrame;

/* The input channel at index `index` of a downmix configuration's `channel_count` */
enum EAC3JOCChannel eac3_joc_input_channel(int downmix, int index);

/* Parses a JOC payload; 0 on success, -1 for a payload it refuses (reserved values, an invalid code, or too short) */
int eac3_joc_parse(EAC3JOCFrame *frame, const uint8_t *payload, size_t size);

/* The decoding state of one stream: the matrices that interpolation continues from, and the filter banks' histories */
typedef struct EAC3JOCDecoder {
    int configured;
    uint8_t channel_count;
    uint8_t object_count;
    uint16_t sequence_count;
    float previous[EAC3_JOC_MAX_OBJECTS][EAC3_JOC_MAX_CHANNELS][EAC3_QMF_BANDS];
    EAC3QMFAnalysis analysis[EAC3_JOC_MAX_CHANNELS];
    EAC3QMFSynthesis synthesis[EAC3_JOC_MAX_OBJECTS];
    /* One frame of the downmix in the filter bank domain, by channel, timeslot, and subband */
    float input_real[EAC3_JOC_MAX_CHANNELS][EAC3_JOC_MAX_TIMESLOTS][EAC3_QMF_BANDS];
    float input_imaginary[EAC3_JOC_MAX_CHANNELS][EAC3_JOC_MAX_TIMESLOTS][EAC3_QMF_BANDS];
} EAC3JOCDecoder;

/* Starts a new stream: zero matrices and histories */
void eac3_joc_decoder_reset(EAC3JOCDecoder *decoder);

/*
 * Rebuilds a frame's objects from its downmix channels, `timeslots` times 64 samples each, in table 53's order.
 * Each object's samples come out 577 samples (EAC3_QMF_DELAY) after the downmix samples they belong to.
 * A null frame, a frame lost to damage, holds every object's last matrix; the decoder then needs a configured stream.
 * Returns the object count, or 0 when it rebuilt nothing.
 */
int eac3_joc_decode(EAC3JOCDecoder *decoder, const EAC3JOCFrame *frame, const float *const *channels, int timeslots,
    float *const *objects);

#endif
