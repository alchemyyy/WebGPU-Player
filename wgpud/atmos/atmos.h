/*
 * Object audio for the eac3 and truehd modules: the object audio metadata (OAMD) parser and the renderer.
 * Our own code; it depends on no other Atmos library. The engine's book (decoders.md) describes these sources.
 *
 * References: ETSI TS 103 420 V1.2.1 clause 5 (OAMD syntax and semantics, clause 4.2 coordinates, Annex A.2 zones,
 * Table B.10 speaker positions); Recommendation ITU-R BS.2051 (loudspeaker layouts) and BS.2127 (allocentric panning concepts).
 *
 * Conventions:
 * - Room-anchored coordinates as TS 103 420 clause 4.2.1 defines them: x from 0 (left wall) to 1 (right wall),
 *   y from 0 (front wall) to 1 (back wall), z from 0 (the listener's plane) to 1 (the ceiling), negative below it.
 * - Channels are named by FFmpeg's channel bits (AV_CH_*), which equal the WAVE channel mask bits below bit 31;
 *   a renderer's output planes are in that bit order, as every block the engine receives is.
 * - Timing is in samples at the stream's sample rate.
 * - Nothing allocates after atmos_renderer_create; every count is bounded by the limits below.
 * - Every function that can fail returns ATMOS_OK or a negative ATMOS_ERROR_* code and never traps.
 */
#ifndef WGPUD_ATMOS_H
#define WGPUD_ATMOS_H

#include <stddef.h>
#include <stdint.h>

/* Bounds. A payload or scene beyond them fails with ATMOS_ERROR_OBJECT_COUNT */
/* Objects per scene, bed, ISF, and dynamic objects together: E-AC-3 JOC carries at most 16 objects plus its LFE, TrueHD 16 channels */
#define ATMOS_MAX_OBJECTS 32
/* Metadata updates per payload: num_obj_info_blocks is at most 8 */
#define ATMOS_MAX_UPDATES 8
/* Updates a renderer holds before they start: four payloads' worth */
#define ATMOS_MAX_PENDING_UPDATES 32
/* Output channels: 7.1.4 */
#define ATMOS_MAX_CHANNELS 12

/* Status codes */
#define ATMOS_OK 0
/* The payload ends before its syntax does */
#define ATMOS_ERROR_TRUNCATED (-1)
/* oa_md_version other than 0, the only syntax TS 103 420 V1.2.1 defines */
#define ATMOS_ERROR_VERSION (-2)
/* More objects than ATMOS_MAX_OBJECTS, or a program assignment whose bed, ISF, and dynamic counts do not sum to object_count */
#define ATMOS_ERROR_OBJECT_COUNT (-3)
/* A value the syntax reserves where later fields depend on it (an ISF index of 6 or 7) */
#define ATMOS_ERROR_RESERVED (-4)
/* An oa_element whose contents run past its oa_element_size */
#define ATMOS_ERROR_ELEMENT (-5)
/* A null pointer, or a count beyond its bound */
#define ATMOS_ERROR_ARGUMENT (-6)
/* A target channel mask that is not one of the layouts below */
#define ATMOS_ERROR_LAYOUT (-7)
/* Binaural rendering at a sample rate other than ATMOS_BINAURAL_SAMPLE_RATE */
#define ATMOS_ERROR_SAMPLE_RATE (-8)
/* A scene the renderer does not render: intermediate spatial format (ISF) objects */
#define ATMOS_ERROR_UNSUPPORTED (-9)
/* More than ATMOS_MAX_PENDING_UPDATES updates waiting to start */
#define ATMOS_ERROR_QUEUE (-10)

/* Channel bits, FFmpeg's AV_CH_* values */
#define ATMOS_CHANNEL_FRONT_LEFT 0x1ULL
#define ATMOS_CHANNEL_FRONT_RIGHT 0x2ULL
#define ATMOS_CHANNEL_FRONT_CENTER 0x4ULL
#define ATMOS_CHANNEL_LOW_FREQUENCY 0x8ULL
#define ATMOS_CHANNEL_BACK_LEFT 0x10ULL
#define ATMOS_CHANNEL_BACK_RIGHT 0x20ULL
#define ATMOS_CHANNEL_SIDE_LEFT 0x200ULL
#define ATMOS_CHANNEL_SIDE_RIGHT 0x400ULL
#define ATMOS_CHANNEL_TOP_FRONT_LEFT 0x1000ULL
#define ATMOS_CHANNEL_TOP_FRONT_RIGHT 0x4000ULL
#define ATMOS_CHANNEL_TOP_BACK_LEFT 0x8000ULL
#define ATMOS_CHANNEL_TOP_BACK_RIGHT 0x20000ULL
#define ATMOS_CHANNEL_WIDE_LEFT 0x80000000ULL
#define ATMOS_CHANNEL_WIDE_RIGHT 0x100000000ULL
#define ATMOS_CHANNEL_LOW_FREQUENCY_2 0x800000000ULL
#define ATMOS_CHANNEL_TOP_SIDE_LEFT 0x1000000000ULL
#define ATMOS_CHANNEL_TOP_SIDE_RIGHT 0x2000000000ULL

/* The target layouts a renderer renders to, by WAVE channel mask */
#define ATMOS_LAYOUT_STEREO 0x3u
#define ATMOS_LAYOUT_5_1_BACK 0x3Fu
#define ATMOS_LAYOUT_5_1_SIDE 0x60Fu
#define ATMOS_LAYOUT_7_1 0x63Fu
#define ATMOS_LAYOUT_5_1_2 0x503Fu
#define ATMOS_LAYOUT_5_1_4 0x2D03Fu
#define ATMOS_LAYOUT_7_1_2 0x563Fu
#define ATMOS_LAYOUT_7_1_4 0x2D63Fu

/* Binaural rendering: its only sample rate, and the delay its convolution adds, in samples */
#define ATMOS_BINAURAL_SAMPLE_RATE 48000u
#define ATMOS_BINAURAL_LATENCY 128u

/* An object's kind, in the order the payload lists objects: beds first, then ISF, then dynamic objects */
typedef enum AtmosObjectKind {
    /* A bed channel, played from the speaker its channel bit names */
    ATMOS_OBJECT_BED = 0,
    /* An intermediate spatial format object */
    ATMOS_OBJECT_ISF = 1,
    /* A dynamic object with a room-anchored or screen-anchored position */
    ATMOS_OBJECT_DYNAMIC = 2
} AtmosObjectKind;

/* What a program carries, per object (TS 103 420 clause 5.5.3 program_assignment) */
typedef struct AtmosScene {
    uint32_t object_count;
    uint32_t bed_count;
    uint32_t isf_count;
    uint32_t dynamic_count;
    /* intermediate_spatial_format_idx when isf_count is nonzero */
    uint32_t isf_index;
    /* AtmosObjectKind per object */
    uint8_t kind[ATMOS_MAX_OBJECTS];
    /* The ATMOS_CHANNEL_* bit of each bed object, 0 for other objects */
    uint64_t bed_channel[ATMOS_MAX_OBJECTS];
} AtmosScene;

/* Zone constraints (TS 103 420 Table 20) */
typedef enum AtmosZoneConstraints {
    ATMOS_ZONES_ALL = 0,
    ATMOS_ZONES_NO_BACK = 1,
    ATMOS_ZONES_NO_SIDE = 2,
    ATMOS_ZONES_CENTER_AND_BACK_ONLY = 3,
    ATMOS_ZONES_SCREEN_ONLY = 4,
    ATMOS_ZONES_SURROUND_ONLY = 5
} AtmosZoneConstraints;

/* One object's properties as one update sets them, decoded to their values */
typedef struct AtmosObjectProperties {
    /* Position, room-anchored; a position outside the room (distance specified) is projected onto its walls */
    float x;
    float y;
    float z;
    /* Linear amplitude gain: 0 for an inactive object or -inf dB, at most +15 dB */
    float gain;
    /* Extent along x, y, and z, each in [0, 1] room units */
    float width;
    float depth;
    float height;
    /* object_priority in [0, 1] */
    float priority;
    /* object_divergence in [0, 1]; the renderer does not render it */
    float divergence;
    /* screen_factor and depth_factor of a screen-anchored position; screen_factor 0 for a room-anchored one */
    float screen_factor;
    float depth_factor;
    /* AtmosZoneConstraints value; reserved indexes read as ATMOS_ZONES_ALL */
    uint8_t zone_constraints;
    /* 1 when the Top-Bottom zone is included (b_enable_elevation) */
    uint8_t elevation;
    /* 1 when the object is locked to its nearest speaker (b_object_snap) */
    uint8_t snap;
    /* 0 when b_object_not_active marked the object silent */
    uint8_t active;
} AtmosObjectProperties;

/* When an update starts, and how long its properties take to reach their values from the ones before */
typedef struct AtmosUpdateTiming {
    /* sample_offset + 32 * block_offset_factor: the first sample the update applies to, from the first sample the payload applies to */
    uint32_t start_sample;
    /* ramp_duration: the update's values are reached at start_sample + ramp_duration */
    uint32_t ramp_duration;
} AtmosUpdateTiming;

/* One object_audio_metadata_payload, decoded */
typedef struct AtmosMetadata {
    uint32_t version;
    AtmosScene scene;
    /* 1 when b_bed_chan_distribute asked that bed channels be spread over several speakers */
    uint32_t bed_distribute;
    /* The updates of the payload's object_element, 0 when it carries none */
    uint32_t update_count;
    AtmosUpdateTiming timing[ATMOS_MAX_UPDATES];
    /* properties[update][object]; bed and ISF objects carry only gain, priority, and active */
    AtmosObjectProperties properties[ATMOS_MAX_UPDATES][ATMOS_MAX_OBJECTS];
} AtmosMetadata;

/*
 * Decodes the bytes of one object_audio_metadata_payload (TS 103 420 clause 5.5.2) into metadata.
 * Payloads are self-contained: each one's first update is a full update. Elements other than object_element and
 * extended_object_element (trim, and those V1.2.1 reserves) are skipped by their oa_element_size.
 */
int atmos_parse_oamd(const uint8_t *payload, size_t byte_length, AtmosMetadata *metadata);

/* Returns whether a WAVE channel mask is one of the ATMOS_LAYOUT_* target layouts */
int atmos_layout_supported(uint32_t channel_mask);

typedef struct AtmosRenderer AtmosRenderer;

/* Returns a renderer for a sample rate, targeting stereo, with an empty scene; NULL when allocation fails or the rate is 0 */
AtmosRenderer *atmos_renderer_create(uint32_t sample_rate);
void atmos_renderer_destroy(AtmosRenderer *renderer);

/*
 * Sets the target between render calls: a ATMOS_LAYOUT_* mask, or binaural stereo when binaural is nonzero, which ignores the mask.
 * Objects keep their properties and ramps; their speaker gains move to the new layout at once. Turning binaural on clears its convolution.
 */
int atmos_renderer_set_target(AtmosRenderer *renderer, uint32_t channel_mask, int binaural);

/* The output's WAVE channel mask (0x3 when binaural), channel count, and delay in samples (ATMOS_BINAURAL_LATENCY when binaural, else 0) */
uint32_t atmos_renderer_channel_mask(const AtmosRenderer *renderer);
uint32_t atmos_renderer_channel_count(const AtmosRenderer *renderer);
uint32_t atmos_renderer_latency(const AtmosRenderer *renderer);

/*
 * Sets the scene without metadata, as a stream whose objects are fixed declares it.
 * Bed objects start at unit object gain, dynamic objects silent at the room's center until their first update. A bed channel plays
 * from its own speaker or folds as the engine folds layouts, and each one landing whole on a speaker takes 1/sqrt(n) of the n there.
 * An unchanged scene keeps every object's state; a changed one resets them and drops pending updates.
 */
int atmos_renderer_set_scene(AtmosRenderer *renderer, const AtmosScene *scene);

/*
 * Queues a payload's updates. sample_offset is the sample the payload's timing counts from, relative to the first sample of the next
 * render call; negative when that sample has already been rendered. A payload whose scene differs from the renderer's sets its scene first,
 * as atmos_renderer_set_scene does. An update that started in the past takes effect at once, its ramp shortened by the samples it missed.
 */
int atmos_renderer_add_metadata(AtmosRenderer *renderer, const AtmosMetadata *metadata, int32_t sample_offset);

/*
 * Renders frame_count samples of the scene's objects into output, overwriting it.
 * objects holds scene.object_count planes of frame_count samples in the scene's object order; objects, or any plane of it, may be NULL for silence.
 * output holds atmos_renderer_channel_count planes of frame_count samples in the target's channel order.
 * Rendering latency samples of silence after the last block drains a binaural renderer's delay.
 */
int atmos_renderer_render(AtmosRenderer *renderer, const float *const *objects, uint32_t frame_count, float *const *output);

/* Drops pending updates, the binaural delay line, and every object's state, keeping the target and the scene, as after a seek */
void atmos_renderer_reset(AtmosRenderer *renderer);

#endif
