/*
 * The object audio metadata (OAMD) parser: one object_audio_metadata_payload into AtmosMetadata.
 * Our own code, written from ETSI TS 103 420 V1.2.1 clause 5.
 *
 * Where the clause's pseudo-code and its tables disagree on which bit of a flag array is which, the tables win:
 * element [k] of an n-bit array is the k-th bit the payload carries, as Tables 11a, 12, 13, 30, 31, and 43 number them.
 * That disagreement is only in obj_render_info[]: clause 5.5.11 tests [0] for the position, Table 31 gives it [3], the last bit read.
 * Every other flag array of the payload carries the flag of the field parsed first as its last bit, and the AC-4 form of this syntax
 * (ETSI TS 103 190-2 clause 6.2.8.7) reads b_obj_render_position_present last, so the position's flag is the last bit here too.
 * Real streams confirm the numbering for content_description[] and the bed assignments; OpenJOC's synthetic fixtures write
 * obj_render_info[] the other way round and do not parse.
 * The open truehdd/oamd parser (Apache-2.0, https://github.com/truehdd/oamd), which decodes real streams, reads the bits the same way;
 * it was read to settle that ordering and the object order of a dynamic-object program with an LFE, nothing was taken from it.
 */

#include <math.h>
#include <string.h>

#include "atmos.h"

/* oa_element_id_idx values (Table 26) */
#define OA_ELEMENT_OBJECT 1
#define OA_ELEMENT_EXTENDED_OBJECT 5

typedef struct BitReader {
    const uint8_t *data;
    size_t end;
    size_t position;
    int overrun;
} BitReader;

/* Reads up to 32 bits; past the end it reads zeros and marks the overrun */
static uint32_t read_bits(BitReader *reader, unsigned count) {
    if (count == 0) {
        return 0;
    }
    if (reader->position + count > reader->end) {
        reader->overrun = 1;
        reader->position = reader->end;
        return 0;
    }
    uint32_t value = 0;
    for (unsigned bit = 0; bit < count; bit++) {
        const size_t position = reader->position + bit;
        value = (value << 1) | ((reader->data[position >> 3] >> (7 - (position & 7))) & 1u);
    }
    reader->position += count;
    return value;
}

static int read_flag(BitReader *reader) {
    return (int) read_bits(reader, 1);
}

/* A two's complement value of count bits */
static int32_t read_signed(BitReader *reader, unsigned count) {
    const uint32_t value = read_bits(reader, count);
    const uint32_t sign = 1u << (count - 1);
    return (int32_t) (value ^ sign) - (int32_t) sign;
}

static void skip_bits(BitReader *reader, size_t count) {
    if (count > reader->end - reader->position) {
        reader->overrun = 1;
        reader->position = reader->end;
        return;
    }
    reader->position += count;
}

/* variable_bits_max (clause 5.5.1), as its pseudo-code reads */
static uint32_t read_variable_bits_max(BitReader *reader, unsigned n, unsigned max_group_count) {
    uint32_t value = read_bits(reader, n);
    unsigned group_count = 1;
    int read_more = read_flag(reader);
    if (max_group_count > group_count) {
        if (read_more) {
            value = (value << n) + (1u << n);
        }
        while (read_more && !reader->overrun) {
            value += read_bits(reader, n);
            read_more = read_flag(reader);
            if (group_count >= max_group_count) {
                break;
            }
            if (read_more) {
                value = (value << n) + (1u << n);
                group_count++;
            }
        }
    }
    return value;
}

/* Speaker labels in bed_channel_assignment order (clause 4.4 speaker_labels, Tables 12 and 13) */
static const uint64_t BED_LABEL_CHANNELS[17] = {
    ATMOS_CHANNEL_FRONT_LEFT, ATMOS_CHANNEL_FRONT_RIGHT, ATMOS_CHANNEL_FRONT_CENTER, ATMOS_CHANNEL_LOW_FREQUENCY,
    ATMOS_CHANNEL_SIDE_LEFT, ATMOS_CHANNEL_SIDE_RIGHT, ATMOS_CHANNEL_BACK_LEFT, ATMOS_CHANNEL_BACK_RIGHT,
    ATMOS_CHANNEL_TOP_FRONT_LEFT, ATMOS_CHANNEL_TOP_FRONT_RIGHT, ATMOS_CHANNEL_TOP_SIDE_LEFT, ATMOS_CHANNEL_TOP_SIDE_RIGHT,
    ATMOS_CHANNEL_TOP_BACK_LEFT, ATMOS_CHANNEL_TOP_BACK_RIGHT, ATMOS_CHANNEL_WIDE_LEFT, ATMOS_CHANNEL_WIDE_RIGHT,
    ATMOS_CHANNEL_LOW_FREQUENCY_2
};
#define BED_LABEL_LFE 3

/* The labels each bed_channel_assignment[] element adds, by its index (Table 12): first label and count */
static const uint8_t STANDARD_BED_FIRST_LABEL[10] = { 16, 14, 12, 10, 8, 6, 4, 3, 2, 0 };
static const uint8_t STANDARD_BED_LABEL_COUNT[10] = { 1, 2, 2, 2, 2, 2, 2, 1, 1, 2 };

/* Objects per intermediate_spatial_format_idx (Table 11b); 6 and 7 are reserved */
static const uint8_t ISF_OBJECT_COUNTS[8] = { 4, 8, 10, 14, 15, 30, 0, 0 };

static const uint16_t SAMPLE_OFFSETS[4] = { 8, 16, 18, 24 };
static const uint16_t RAMP_DURATIONS[16] = {
    32, 64, 128, 256, 320, 480, 1000, 1001, 1024, 1600, 1601, 1602, 1920, 2000, 2002, 2048
};
static const float DISTANCE_FACTORS[16] = {
    1.1f, 1.3f, 1.6f, 2.0f, 2.5f, 3.2f, 4.0f, 5.0f, 6.3f, 7.9f, 10.0f, 12.6f, 15.8f, 20.0f, 25.1f, 50.1f
};
static const float DEPTH_FACTORS[4] = { 0.25f, 0.5f, 1.0f, 2.0f };
static const float DIVERGENCE_TABLE[4] = { 0.500755f, 0.608529f, 0.704833f, 1.0f };
/* Table 42; code 0 is reserved and reads as no divergence */
static const float DIVERGENCE_CODES[64] = {
    0.0f, 0.0f, 0.004026f, 0.00716f, 0.012731f, 0.020173f, 0.028485f, 0.04021f,
    0.050582f, 0.063601f, 0.079914f, 0.100299f, 0.125666f, 0.140532f, 0.157027f, 0.175282f,
    0.195417f, 0.217536f, 0.241718f, 0.268002f, 0.296377f, 0.326766f, 0.359017f, 0.392895f,
    0.428081f, 0.464184f, 0.500755f, 0.537316f, 0.573389f, 0.608529f, 0.642346f, 0.674524f,
    0.704833f, 0.733123f, 0.75932f, 0.783416f, 0.805451f, 0.825506f, 0.843686f, 0.860112f,
    0.874914f, 0.888222f, 0.900168f, 0.910875f, 0.920461f, 0.929035f, 0.936698f, 0.943544f,
    0.949656f, 0.955112f, 0.95998f, 0.964322f, 0.968195f, 0.974729f, 0.979923f, 0.98405f,
    0.98733f, 0.989935f, 0.992874f, 0.994955f, 0.996817f, 0.99821f, 0.998993f, 1.0f
};
/* ext_prec_pos3D_* values (Tables 44 to 46) */
static const int8_t EXTENDED_PRECISION_STEPS[4] = { 1, 2, -1, -2 };

/* Standard precision position codes per update and object, which differential coding and extended precision refine */
typedef struct PositionCodes {
    int32_t x;
    int32_t y;
    int32_t z;
    /* b_object_distance_specified, and its distance_factor (infinite at infinity) */
    uint8_t distance_specified;
    float distance_factor;
} PositionCodes;

typedef struct ParseState {
    AtmosMetadata *metadata;
    PositionCodes codes[ATMOS_MAX_UPDATES][ATMOS_MAX_OBJECTS];
    /* Extended precision steps per update and object, 0 without an extended_object_element */
    int8_t extended[ATMOS_MAX_UPDATES][ATMOS_MAX_OBJECTS][3];
    int has_object_element;
} ParseState;

static float clampf(float value, float low, float high) {
    return value < low ? low : (value > high ? high : value);
}

static int add_bed_label(AtmosScene *scene, unsigned label) {
    if (scene->bed_count >= ATMOS_MAX_OBJECTS) {
        return ATMOS_ERROR_OBJECT_COUNT;
    }
    scene->bed_channel[scene->bed_count++] = BED_LABEL_CHANNELS[label];
    return ATMOS_OK;
}

/* program_assignment (clause 5.5.3) into the scene, with object_count already set */
static int read_program_assignment(BitReader *reader, AtmosMetadata *metadata) {
    AtmosScene *scene = &metadata->scene;
    if (read_flag(reader)) {
        /* b_dyn_object_only_program: dynamic objects, after an LFE when b_lfe_present */
        if (read_flag(reader)) {
            const int result = add_bed_label(scene, BED_LABEL_LFE);
            if (result != ATMOS_OK) {
                return result;
            }
        }
        if (scene->bed_count > scene->object_count) {
            return ATMOS_ERROR_OBJECT_COUNT;
        }
        scene->dynamic_count = scene->object_count - scene->bed_count;
    } else {
        /* content_description[]: [3] beds, [2] ISF, [1] dynamic objects, [0] reserved data, in the order the payload carries them */
        const uint32_t content = read_bits(reader, 4);
        if (content & 0x1u) {
            metadata->bed_distribute = (uint32_t) read_flag(reader);
            const unsigned instance_count = read_flag(reader) ? read_bits(reader, 3) + 2 : 1;
            for (unsigned instance = 0; instance < instance_count && !reader->overrun; instance++) {
                int result = ATMOS_OK;
                if (read_flag(reader)) {
                    /* b_lfe_only */
                    result = add_bed_label(scene, BED_LABEL_LFE);
                } else if (read_flag(reader)) {
                    /* b_standard_chan_assign: bed_channel_assignment[0..9], each adding its labels (Table 12), in label order */
                    const uint32_t mask = read_bits(reader, 10);
                    for (unsigned label = 0; label < 17 && result == ATMOS_OK; label++) {
                        for (unsigned element = 0; element < 10; element++) {
                            const unsigned first = STANDARD_BED_FIRST_LABEL[element];
                            if ((mask >> (9 - element)) & 1u && label >= first && label < first + STANDARD_BED_LABEL_COUNT[element]) {
                                result = add_bed_label(scene, label);
                            }
                        }
                    }
                } else {
                    /* nonstd_bed_channel_assignment[0..16]: element 16 - label adds that label (Table 13), so the value's bit b is label b */
                    const uint32_t mask = read_bits(reader, 17);
                    for (unsigned label = 0; label < 17 && result == ATMOS_OK; label++) {
                        if ((mask >> label) & 1u) {
                            result = add_bed_label(scene, label);
                        }
                    }
                }
                if (result != ATMOS_OK) {
                    return result;
                }
            }
        }
        if (content & 0x2u) {
            scene->isf_index = read_bits(reader, 3);
            scene->isf_count = ISF_OBJECT_COUNTS[scene->isf_index];
            if (scene->isf_count == 0) {
                return ATMOS_ERROR_RESERVED;
            }
        }
        if (content & 0x4u) {
            uint32_t count = read_bits(reader, 5);
            if (count == 0x1F) {
                count += read_bits(reader, 7);
            }
            scene->dynamic_count = count + 1;
        }
        if (content & 0x8u) {
            /* reserved_data_size counts the reserved data and its padding in bytes */
            skip_bits(reader, ((size_t) read_bits(reader, 4) + 1) * 8);
        }
        if ((uint64_t) scene->bed_count + scene->isf_count + scene->dynamic_count != scene->object_count) {
            return ATMOS_ERROR_OBJECT_COUNT;
        }
    }
    if (reader->overrun) {
        return ATMOS_ERROR_TRUNCATED;
    }
    for (uint32_t object = 0; object < scene->object_count; object++) {
        if (object < scene->bed_count) {
            scene->kind[object] = ATMOS_OBJECT_BED;
        } else if (object < scene->bed_count + scene->isf_count) {
            scene->kind[object] = ATMOS_OBJECT_ISF;
            scene->bed_channel[object] = 0;
        } else {
            scene->kind[object] = ATMOS_OBJECT_DYNAMIC;
            scene->bed_channel[object] = 0;
        }
    }
    return ATMOS_OK;
}

/* The defaults of an object that is not active, or whose properties are not signalled (Tables 28 and 29) */
static void set_default_properties(AtmosObjectProperties *properties, PositionCodes *codes) {
    memset(properties, 0, sizeof(*properties));
    properties->x = 0.5f;
    properties->y = 0.5f;
    properties->depth_factor = DEPTH_FACTORS[0];
    properties->elevation = 1;
    memset(codes, 0, sizeof(*codes));
    codes->x = 31;
    codes->y = 31;
}

/* object_gain_idx and object_gain_bits (Tables 18 and 19) */
static float read_gain(BitReader *reader, const AtmosObjectProperties *previous_object) {
    switch (read_bits(reader, 2)) {
        case 0:
            return 1.0f;
        case 1:
            return 0.0f;
        case 2: {
            const int32_t bits = (int32_t) read_bits(reader, 6);
            const int32_t decibels = bits <= 14 ? 15 - bits : 14 - bits;
            return powf(10.0f, (float) decibels / 20.0f);
        }
        default:
            return previous_object != NULL ? previous_object->gain : 1.0f;
    }
}

/* object_basic_info (clause 5.5.10): obj_basic_info[1] gain, [0] priority */
static void read_basic_info(BitReader *reader, unsigned status, AtmosObjectProperties *properties,
    const AtmosObjectProperties *previous_object) {
    const uint32_t present = status == 1 ? 0x3u : read_bits(reader, 2);
    if (present & 0x1u) {
        properties->gain = read_gain(reader, previous_object);
    }
    if (present & 0x2u) {
        properties->priority = read_flag(reader) ? 1.0f : (float) read_bits(reader, 5) / 32.0f;
    }
}

/* object_render_info (clause 5.5.11): obj_render_info[3] position, [2] zones, [1] size, [0] screen reference */
static void read_render_info(BitReader *reader, unsigned status, unsigned update, AtmosObjectProperties *properties,
    PositionCodes *codes) {
    const uint32_t present = status == 1 ? 0xFu : read_bits(reader, 4);
    if (present & 0x1u) {
        if (update > 0 && read_flag(reader)) {
            /* b_differential_position_specified: steps from the previous update's standard precision codes */
            codes->x += read_signed(reader, 3);
            codes->y += read_signed(reader, 3);
            codes->z += read_signed(reader, 3);
        } else {
            codes->x = (int32_t) read_bits(reader, 6);
            codes->y = (int32_t) read_bits(reader, 6);
            const int32_t sign = read_flag(reader) ? 1 : -1;
            codes->z = sign * (int32_t) read_bits(reader, 4);
        }
        codes->distance_specified = (uint8_t) read_flag(reader);
        if (codes->distance_specified) {
            codes->distance_factor = read_flag(reader) ? INFINITY : DISTANCE_FACTORS[read_bits(reader, 4)];
        }
    }
    if (present & 0x2u) {
        const uint32_t zones = read_bits(reader, 3);
        properties->zone_constraints = (uint8_t) (zones <= ATMOS_ZONES_SURROUND_ONLY ? zones : ATMOS_ZONES_ALL);
        properties->elevation = (uint8_t) read_flag(reader);
    }
    if (present & 0x4u) {
        switch (read_bits(reader, 2)) {
            case 1: {
                const float size = (float) read_bits(reader, 5) / 31.0f;
                properties->width = size;
                properties->depth = size;
                properties->height = size;
                break;
            }
            case 2:
                properties->width = (float) read_bits(reader, 5) / 31.0f;
                properties->depth = (float) read_bits(reader, 5) / 31.0f;
                properties->height = (float) read_bits(reader, 5) / 31.0f;
                break;
            default:
                /* 0 is a point; 3 is reserved and reads as one */
                properties->width = 0.0f;
                properties->depth = 0.0f;
                properties->height = 0.0f;
                break;
        }
    }
    if (present & 0x8u) {
        if (read_flag(reader)) {
            properties->screen_factor = (float) (read_bits(reader, 3) + 1) / 8.0f;
            properties->depth_factor = DEPTH_FACTORS[read_bits(reader, 2)];
        } else {
            properties->screen_factor = 0.0f;
        }
    }
    properties->snap = (uint8_t) read_flag(reader);
}

/* object_element (clause 5.5.5) with md_update_info, block_update_info, and every object's object_info_blocks */
static int read_object_element(BitReader *reader, ParseState *state) {
    AtmosMetadata *metadata = state->metadata;
    const AtmosScene *scene = &metadata->scene;

    /* md_update_info */
    uint32_t sample_offset = 0;
    switch (read_bits(reader, 2)) {
        case 1:
            sample_offset = SAMPLE_OFFSETS[read_bits(reader, 2)];
            break;
        case 2:
            sample_offset = read_bits(reader, 5);
            break;
        default:
            /* 0, and 3, which is reserved and carries no value */
            break;
    }
    const uint32_t update_count = read_bits(reader, 3) + 1;
    for (uint32_t update = 0; update < update_count; update++) {
        AtmosUpdateTiming *timing = &metadata->timing[update];
        timing->start_sample = sample_offset + 32u * read_bits(reader, 6);
        switch (read_bits(reader, 2)) {
            case 0:
                timing->ramp_duration = 0;
                break;
            case 1:
                timing->ramp_duration = 512;
                break;
            case 2:
                timing->ramp_duration = 1536;
                break;
            default:
                timing->ramp_duration = read_flag(reader) ? RAMP_DURATIONS[read_bits(reader, 4)] : read_bits(reader, 11);
                break;
        }
    }
    if (!read_flag(reader)) {
        /* b_reserved_data_not_present clear: five reserved bits */
        skip_bits(reader, 5);
    }

    const uint32_t beds_or_isf = scene->bed_count + scene->isf_count;
    for (uint32_t object = 0; object < scene->object_count && !reader->overrun; object++) {
        for (uint32_t update = 0; update < update_count; update++) {
            AtmosObjectProperties *properties = &metadata->properties[update][object];
            PositionCodes *codes = &state->codes[update][object];
            const AtmosObjectProperties *previous_object = object > 0 ? &metadata->properties[update][object - 1] : NULL;
            /* Reused values come from the object's previous update, and the first update starts from the defaults */
            if (update > 0) {
                *properties = metadata->properties[update - 1][object];
                *codes = state->codes[update - 1][object];
            } else {
                set_default_properties(properties, codes);
            }
            const int not_active = read_flag(reader);
            properties->active = (uint8_t) !not_active;

            /* object_basic_info_status_idx: 0 default, 1 full, 2 reuse, 3 mixed (Table 28) */
            const unsigned basic_status = not_active ? 0 : (update == 0 ? 1 : read_bits(reader, 2));
            if (basic_status == 0) {
                properties->gain = 0.0f;
                properties->priority = 0.0f;
            } else if (basic_status != 2) {
                read_basic_info(reader, basic_status, properties, previous_object);
            }

            /* object_render_info_status_idx, for objects outside beds and ISF (Table 29) */
            const int in_bed_or_isf = object < beds_or_isf;
            const unsigned render_status = not_active || in_bed_or_isf ? 0 : (update == 0 ? 1 : read_bits(reader, 2));
            if (render_status == 0) {
                const uint8_t active = properties->active;
                const float gain = properties->gain;
                const float priority = properties->priority;
                set_default_properties(properties, codes);
                properties->active = active;
                properties->gain = gain;
                properties->priority = priority;
            } else if (render_status != 2) {
                read_render_info(reader, render_status, update, properties, codes);
            }

            if (read_flag(reader)) {
                /* b_additional_table_data_exists: additional_table_data_size bytes of table data and padding */
                skip_bits(reader, ((size_t) read_bits(reader, 4) + 1) * 8);
            }
        }
    }
    if (reader->overrun) {
        return ATMOS_ERROR_ELEMENT;
    }
    metadata->update_count = update_count;
    state->has_object_element = 1;
    return ATMOS_OK;
}

/* extended_object_element (clause 5.5.13): divergence and extended precision positions of active dynamic objects */
static int read_extended_object_element(BitReader *reader, ParseState *state) {
    AtmosMetadata *metadata = state->metadata;
    if (!state->has_object_element) {
        /* Its syntax depends on the object_element, which has to come first */
        return ATMOS_OK;
    }
    const AtmosScene *scene = &metadata->scene;
    const uint32_t beds_or_isf = scene->bed_count + scene->isf_count;
    const uint32_t update_count = metadata->update_count;
    if (read_flag(reader)) {
        /* b_obj_div_block */
        for (uint32_t object = 0; object < scene->object_count; object++) {
            for (uint32_t update = 0; update < update_count; update++) {
                AtmosObjectProperties *properties = &metadata->properties[update][object];
                if (!properties->active || object < beds_or_isf) {
                    properties->divergence = 0.0f;
                    continue;
                }
                if (!read_flag(reader)) {
                    properties->divergence = 0.0f;
                    continue;
                }
                switch (read_bits(reader, 2)) {
                    case 0:
                        properties->divergence = DIVERGENCE_TABLE[read_bits(reader, 2)];
                        break;
                    case 1:
                        /* Reuses the previous update's divergence */
                        properties->divergence = update > 0 ? metadata->properties[update - 1][object].divergence : 0.0f;
                        break;
                    default:
                        properties->divergence = DIVERGENCE_CODES[read_bits(reader, 6)];
                        break;
                }
            }
        }
    }
    if (read_flag(reader)) {
        /* b_ext_prec_pos_block; ext_prec_pos_presence[2] X, [1] Y, [0] Z */
        for (uint32_t object = 0; object < scene->object_count; object++) {
            for (uint32_t update = 0; update < update_count; update++) {
                if (!metadata->properties[update][object].active || object < beds_or_isf || !read_flag(reader)) {
                    continue;
                }
                const uint32_t present = read_bits(reader, 3);
                int8_t *steps = state->extended[update][object];
                if (present & 0x1u) {
                    steps[0] = EXTENDED_PRECISION_STEPS[read_bits(reader, 2)];
                }
                if (present & 0x2u) {
                    steps[1] = EXTENDED_PRECISION_STEPS[read_bits(reader, 2)];
                }
                if (present & 0x4u) {
                    steps[2] = EXTENDED_PRECISION_STEPS[read_bits(reader, 2)];
                }
            }
        }
    }
    return reader->overrun ? ATMOS_ERROR_ELEMENT : ATMOS_OK;
}

/* The room-anchored position of an object's codes (clauses 5.6.1.1.8 to 5.6.1.1.17), projected onto the room's walls when outside it */
static void resolve_position(const PositionCodes *codes, const int8_t steps[3], AtmosObjectProperties *properties) {
    float x = clampf((float) codes->x / 62.0f + (float) steps[0] / (62.0f * 5.0f), 0.0f, 1.0f);
    float y = clampf((float) codes->y / 62.0f + (float) steps[1] / (62.0f * 5.0f), 0.0f, 1.0f);
    float z = clampf((float) codes->z / 15.0f + (float) steps[2] / (15.0f * 5.0f), -1.0f, 1.0f);
    if (codes->distance_specified) {
        /* The object lies beyond the point where the ray from (0.5, 0.5, 0) through the coded position leaves the room (clause 5.2.1.2);
         * a renderer bounded by its speakers plays it from that point */
        const float dx = x - 0.5f;
        const float dy = y - 0.5f;
        float scale = INFINITY;
        if (fabsf(dx) > 0.0f) {
            scale = fminf(scale, 0.5f / fabsf(dx));
        }
        if (fabsf(dy) > 0.0f) {
            scale = fminf(scale, 0.5f / fabsf(dy));
        }
        if (fabsf(z) > 0.0f) {
            scale = fminf(scale, 1.0f / fabsf(z));
        }
        if (isfinite(scale)) {
            x = clampf(0.5f + dx * scale, 0.0f, 1.0f);
            y = clampf(0.5f + dy * scale, 0.0f, 1.0f);
            z = clampf(z * scale, -1.0f, 1.0f);
        }
    }
    properties->x = x;
    properties->y = y;
    properties->z = z;
}

int atmos_parse_oamd(const uint8_t *payload, size_t byte_length, AtmosMetadata *metadata) {
    if (payload == NULL || metadata == NULL || byte_length > SIZE_MAX / 8) {
        return ATMOS_ERROR_ARGUMENT;
    }
    /* About 7 KiB, well inside the module's stack */
    ParseState state;
    memset(&state, 0, sizeof(state));
    memset(metadata, 0, sizeof(*metadata));
    state.metadata = metadata;
    BitReader reader = { payload, byte_length * 8, 0, 0 };

    uint32_t version = read_bits(&reader, 2);
    if (version == 3) {
        version += read_bits(&reader, 3);
    }
    metadata->version = version;
    if (reader.overrun) {
        return ATMOS_ERROR_TRUNCATED;
    }
    if (version != 0) {
        return ATMOS_ERROR_VERSION;
    }
    uint32_t object_count = read_bits(&reader, 5);
    if (object_count == 0x1F) {
        object_count += read_bits(&reader, 7);
    }
    object_count += 1;
    if (reader.overrun) {
        return ATMOS_ERROR_TRUNCATED;
    }
    if (object_count > ATMOS_MAX_OBJECTS) {
        return ATMOS_ERROR_OBJECT_COUNT;
    }
    metadata->scene.object_count = object_count;
    int result = read_program_assignment(&reader, metadata);
    if (result != ATMOS_OK) {
        return result;
    }

    const int alternate_data = read_flag(&reader);
    uint32_t element_count = read_bits(&reader, 4);
    if (element_count == 0xF) {
        element_count += read_bits(&reader, 5);
    }
    if (reader.overrun) {
        return ATMOS_ERROR_TRUNCATED;
    }
    for (uint32_t element = 0; element < element_count; element++) {
        /* oa_element_md (clause 5.5.4): its size counts the bytes after oa_element_size_bits */
        const uint32_t id = read_bits(&reader, 4);
        const size_t size = ((size_t) read_variable_bits_max(&reader, 4, 4) + 1) * 8;
        if (reader.overrun) {
            return ATMOS_ERROR_TRUNCATED;
        }
        /* An element that claims more than the payload holds ends with the payload */
        const size_t end = size < reader.end - reader.position ? reader.position + size : reader.end;
        BitReader element_reader = { payload, end, reader.position, 0 };
        if (alternate_data) {
            skip_bits(&element_reader, 4);
        }
        /* b_discard_unknown_element */
        skip_bits(&element_reader, 1);
        if (id == OA_ELEMENT_OBJECT && !state.has_object_element) {
            result = read_object_element(&element_reader, &state);
        } else if (id == OA_ELEMENT_EXTENDED_OBJECT) {
            result = read_extended_object_element(&element_reader, &state);
        } else {
            result = element_reader.overrun ? ATMOS_ERROR_ELEMENT : ATMOS_OK;
        }
        if (result != ATMOS_OK) {
            return result;
        }
        reader.position = end;
    }

    for (uint32_t update = 0; update < metadata->update_count; update++) {
        for (uint32_t object = 0; object < object_count; object++) {
            if (metadata->scene.kind[object] == ATMOS_OBJECT_DYNAMIC) {
                resolve_position(&state.codes[update][object], state.extended[update][object], &metadata->properties[update][object]);
            }
        }
    }
    return ATMOS_OK;
}
