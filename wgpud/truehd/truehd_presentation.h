/*
 * TrueHD presentation decoder: any presentation of a Dolby TrueHD stream, the 16-channel one included,
 * and the object audio metadata payloads its access units carry.
 * truehd_presentation.c implements it; ffmpeg_truehd_bridge.c uses it for the 16-channel presentation,
 * which FFmpeg's decoder does not decode.
 *
 * This file is part of the TrueHD decoder package and is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public License as published by the Free Software
 * Foundation; either version 2.1 of the License, or (at your option) any later version.
 */
#ifndef TRUEHD_PRESENTATION_H
#define TRUEHD_PRESENTATION_H

#include <stddef.h>
#include <stdint.h>

#define TRUEHD_MAX_CHANNELS 16
#define TRUEHD_MAX_SUBSTREAMS 4
/* Samples in one access unit at 192 kHz, the most any access unit holds */
#define TRUEHD_MAX_ACCESS_UNIT_SAMPLES 160
/* The 16-channel presentation, which Dolby Atmos streams carry */
#define TRUEHD_OBJECT_PRESENTATION 3
/* Object audio metadata payloads one access unit may carry */
#define TRUEHD_MAX_METADATA_PAYLOADS 4
#define TRUEHD_MAX_METADATA_BYTES 4096

/* What truehd_presentation_decode reports for an access unit */
enum TrueHDPresentationResult {
    /* The access unit decoded to truehd_presentation_frame_count frames */
    TRUEHD_PRESENTATION_DECODED = 0,
    /* No major sync has been seen since the start or the last error, so the access unit decodes to nothing */
    TRUEHD_PRESENTATION_AWAITING_SYNC = 1,
    /* The access unit is invalid; decoding resumes at the next major sync */
    TRUEHD_PRESENTATION_INVALID = 2
};

/* The 16-channel presentation's description in the major sync's extra channel meaning */
typedef struct TrueHDObjectPresentationInfo {
    /* Whether the latest major sync describes a 16-channel presentation */
    int present;
    /* Elements (bed channels and objects) the presentation carries, as the major sync states it */
    int element_count;
    int dynamic_objects_only;
    int lfe_present;
    int content_description;
    int lfe_only;
    /* The bed's channel groups: L R, C, LFE, Ls Rs, Lb Rb, Tfl Tfr, Tsl Tsr, Tbl Tbr, Lw Rw, LFE2 from bit 0 */
    int channel_assignment;
    int dynamic_object_count;
} TrueHDObjectPresentationInfo;

/* One object audio metadata payload of an access unit's Evolution frame */
typedef struct TrueHDMetadataPayload {
    const uint8_t *bytes;
    size_t byte_length;
    /* The payload's sample offset into its access unit, 0 when it states none */
    uint32_t sample_offset;
} TrueHDMetadataPayload;

typedef struct TrueHDPresentationDecoder TrueHDPresentationDecoder;

TrueHDPresentationDecoder *truehd_presentation_create(int presentation);
void truehd_presentation_destroy(TrueHDPresentationDecoder *decoder);
/* Forgets the stream, so decoding resumes at the next major sync */
void truehd_presentation_reset(TrueHDPresentationDecoder *decoder);

/*
 * Reads the access unit at the start of data, whose length its header states.
 * Sets *access_unit_length to the bytes the access unit spans, or 0 when data holds no whole access unit.
 */
enum TrueHDPresentationResult truehd_presentation_decode(TrueHDPresentationDecoder *decoder, const uint8_t *data,
    size_t byte_length, size_t *access_unit_length);

/* Facts of the latest major sync */
int truehd_presentation_sample_rate(const TrueHDPresentationDecoder *decoder);
/* Samples in each access unit, 0 before the first major sync */
int truehd_presentation_access_unit_size(const TrueHDPresentationDecoder *decoder);
/* Whether the stream carries the requested presentation itself, rather than a copy or nothing */
int truehd_presentation_available(const TrueHDPresentationDecoder *decoder);
const TrueHDObjectPresentationInfo *truehd_presentation_object_info(const TrueHDPresentationDecoder *decoder);

/* The latest decoded access unit: frames of channel_count samples, each a 24-bit value in an int32_t, in the presentation's channel order */
int truehd_presentation_frame_count(const TrueHDPresentationDecoder *decoder);
int truehd_presentation_channel_count(const TrueHDPresentationDecoder *decoder);
const int32_t (*truehd_presentation_samples(const TrueHDPresentationDecoder *decoder))[TRUEHD_MAX_CHANNELS];

/* The object audio metadata payloads of the latest access unit, decoded or not */
int truehd_presentation_metadata_count(const TrueHDPresentationDecoder *decoder);
TrueHDMetadataPayload truehd_presentation_metadata(const TrueHDPresentationDecoder *decoder, int index);

/* Restart headers whose lossless check disagreed with the decoded samples, since creation */
uint32_t truehd_presentation_lossless_check_failures(const TrueHDPresentationDecoder *decoder);

#endif
