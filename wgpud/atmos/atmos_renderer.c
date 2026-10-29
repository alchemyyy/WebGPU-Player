/*
 * The object audio renderer: bed channels and dynamic objects into a speaker layout, or through a virtual 7.1.4 layout into binaural stereo.
 * Our own code. Speaker positions follow ETSI TS 103 420 Table B.10 in room-anchored coordinates, which place the layouts of
 * ITU-R BS.2051 on the walls of the room; the panner is a room-centric, separable one in the manner of the allocentric panning
 * of ITU-R BS.2127: an object pans between the two layers around its height, in each layer between the two rows of speakers around its depth,
 * and in each row between the two speakers around its width, each step with the sine and cosine law, so the gains' squares sum to 1.
 */

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "atmos.h"
#include "atmos_internal.h"

/* Samples between the gain vectors a ramp computes; the gains ramp linearly in between */
#define RAMP_STEP 32
/* Samples the renderer mixes at once */
#define CHUNK_LENGTH 256
/* Points per axis that an object with that extent is spread over: its two edges and its center, so at most 27 pans per gain vector */
#define SIZE_POINTS 3
/* channelLock's distance in ADM units, where the room spans 2 in x and y and 1 in z (TS 103 420 Table B.15) */
#define SNAP_DISTANCE 0.4f
/* Layers, rows per layer, and speakers per row of the layouts */
#define MAX_LAYERS 2
#define MAX_ROWS 3
#define MAX_ROW_SPEAKERS 3
/* Zone configurations: six constraints, with and without elevation */
#define ZONE_CONFIGURATIONS 12

#define HALF_PI 1.57079632679489661923f
#define SQRT_HALF 0.70710678118654752440f

/* Speaker zones (TS 103 420 Annex A.2) */
#define ZONE_SCREEN 0x01u
#define ZONE_SIDE 0x02u
#define ZONE_SURROUND 0x04u
#define ZONE_BACK 0x08u
#define ZONE_CENTER 0x10u
#define ZONE_TOP 0x20u

typedef struct Speaker {
    uint64_t channel;
    float x;
    float y;
    float z;
    uint8_t zones;
} Speaker;

typedef struct PanRow {
    float y;
    uint32_t count;
    float x[MAX_ROW_SPEAKERS];
    uint8_t speaker[MAX_ROW_SPEAKERS];
} PanRow;

typedef struct PanLayer {
    float z;
    uint32_t row_count;
    PanRow rows[MAX_ROWS];
} PanLayer;

/* The speakers one zone configuration allows, arranged for the panner */
typedef struct PanGeometry {
    uint32_t layer_count;
    PanLayer layers[MAX_LAYERS];
    uint32_t speaker_mask;
} PanGeometry;

typedef struct ObjectState {
    /* The properties at the current sample; during a ramp, interpolated between ramp_from and ramp_to */
    AtmosObjectProperties current;
    AtmosObjectProperties ramp_from;
    AtmosObjectProperties ramp_to;
    int64_t ramp_start;
    uint32_t ramp_length;
    int ramping;
    /* The gain of each output channel at the current sample */
    float gains[ATMOS_MAX_CHANNELS];
} ObjectState;

typedef struct PendingUpdate {
    int64_t start;
    uint32_t ramp_duration;
    AtmosObjectProperties properties[ATMOS_MAX_OBJECTS];
} PendingUpdate;

struct AtmosRenderer {
    uint32_t sample_rate;
    /* The target: the output mask, and the speaker layout objects pan to, the virtual 7.1.4 one when binaural */
    uint32_t output_mask;
    int binaural;
    uint32_t layout_mask;
    uint32_t channel_count;
    Speaker speakers[ATMOS_MAX_CHANNELS];
    int lfe_channel;
    PanGeometry geometries[ZONE_CONFIGURATIONS];

    AtmosScene scene;
    /* Each bed object's gain per channel at unit object gain */
    float bed_routes[ATMOS_MAX_OBJECTS][ATMOS_MAX_CHANNELS];
    ObjectState objects[ATMOS_MAX_OBJECTS];

    /* The sample position of the next render call's first sample */
    int64_t clock;
    PendingUpdate *pending;
    uint32_t pending_count;

    AtmosBinaural *binaural_stage;
    float *virtual_planes[ATMOS_BINAURAL_VIRTUAL_CHANNELS];
    float *chunk_storage;
};

/* Speaker positions (TS 103 420 Table B.10, as x from left, y from front, z up) and zones (Annex A.2) */
static int describe_speaker(uint64_t channel, uint32_t layout_mask, Speaker *speaker) {
    /* Without side speakers, the surround pair sits at the back corners and is in the surround and back zones; with them, Ls and Rs
     * are side speakers in the surround and side zones, and the back pair is in the back zone */
    const int has_sides = (layout_mask & ATMOS_CHANNEL_SIDE_LEFT) != 0;
    const int has_backs = (layout_mask & ATMOS_CHANNEL_BACK_LEFT) != 0;
    const uint8_t surround_zones = (uint8_t) (has_sides && has_backs ? (ZONE_SURROUND | ZONE_SIDE) : (ZONE_SURROUND | ZONE_BACK));
    speaker->channel = channel;
    speaker->z = 0.0f;
    switch (channel) {
        case ATMOS_CHANNEL_FRONT_LEFT:
            speaker->x = 0.0f;
            speaker->y = 0.0f;
            speaker->zones = ZONE_SCREEN;
            return 1;
        case ATMOS_CHANNEL_FRONT_RIGHT:
            speaker->x = 1.0f;
            speaker->y = 0.0f;
            speaker->zones = ZONE_SCREEN;
            return 1;
        case ATMOS_CHANNEL_FRONT_CENTER:
            speaker->x = 0.5f;
            speaker->y = 0.0f;
            speaker->zones = ZONE_SCREEN | ZONE_CENTER;
            return 1;
        case ATMOS_CHANNEL_LOW_FREQUENCY:
            speaker->x = 0.0f;
            speaker->y = 0.0f;
            speaker->zones = 0;
            return 1;
        case ATMOS_CHANNEL_BACK_LEFT:
        case ATMOS_CHANNEL_BACK_RIGHT:
            speaker->x = channel == ATMOS_CHANNEL_BACK_LEFT ? 0.0f : 1.0f;
            speaker->y = 1.0f;
            speaker->zones = has_sides ? ZONE_BACK : surround_zones;
            return 1;
        case ATMOS_CHANNEL_SIDE_LEFT:
        case ATMOS_CHANNEL_SIDE_RIGHT:
            speaker->x = channel == ATMOS_CHANNEL_SIDE_LEFT ? 0.0f : 1.0f;
            /* The side pair of a 7.1 layout is level with the listener; a 5.1 layout's surround pair, whichever bits name it, at the back */
            speaker->y = has_backs ? 0.5f : 1.0f;
            speaker->zones = surround_zones;
            return 1;
        case ATMOS_CHANNEL_TOP_FRONT_LEFT:
        case ATMOS_CHANNEL_TOP_FRONT_RIGHT:
            speaker->x = channel == ATMOS_CHANNEL_TOP_FRONT_LEFT ? 0.0f : 1.0f;
            speaker->y = 0.0f;
            speaker->z = 1.0f;
            speaker->zones = ZONE_TOP;
            return 1;
        case ATMOS_CHANNEL_TOP_BACK_LEFT:
        case ATMOS_CHANNEL_TOP_BACK_RIGHT:
            speaker->x = channel == ATMOS_CHANNEL_TOP_BACK_LEFT ? 0.0f : 1.0f;
            speaker->y = 1.0f;
            speaker->z = 1.0f;
            speaker->zones = ZONE_TOP;
            return 1;
        default:
            return 0;
    }
}

int atmos_layout_supported(uint32_t channel_mask) {
    switch (channel_mask) {
        case ATMOS_LAYOUT_STEREO:
        case ATMOS_LAYOUT_5_1_BACK:
        case ATMOS_LAYOUT_5_1_SIDE:
        case ATMOS_LAYOUT_7_1:
        case ATMOS_LAYOUT_5_1_2:
        case ATMOS_LAYOUT_5_1_4:
        case ATMOS_LAYOUT_7_1_2:
        case ATMOS_LAYOUT_7_1_4:
            return 1;
        default:
            return 0;
    }
}

static float clampf(float value, float low, float high) {
    return value < low ? low : (value > high ? high : value);
}

/* Whether a zone configuration allows a speaker (TS 103 420 Tables 20 and 21, Annex A.2) */
static int zone_allows(uint8_t zones, unsigned constraints, int elevation) {
    if (zones & ZONE_TOP) {
        return elevation;
    }
    switch (constraints) {
        case ATMOS_ZONES_NO_BACK:
            return (zones & ZONE_BACK) == 0;
        case ATMOS_ZONES_NO_SIDE:
            return (zones & ZONE_SIDE) == 0;
        case ATMOS_ZONES_CENTER_AND_BACK_ONLY:
            return (zones & (ZONE_CENTER | ZONE_BACK)) != 0;
        case ATMOS_ZONES_SCREEN_ONLY:
            return (zones & ZONE_SCREEN) != 0;
        case ATMOS_ZONES_SURROUND_ONLY:
            return (zones & ZONE_SURROUND) != 0;
        default:
            return 1;
    }
}

static void insert_sorted(float *values, uint8_t *speakers, uint32_t *count, float value, uint8_t speaker) {
    uint32_t index = *count;
    while (index > 0 && values[index - 1] > value) {
        values[index] = values[index - 1];
        speakers[index] = speakers[index - 1];
        index--;
    }
    values[index] = value;
    speakers[index] = speaker;
    (*count)++;
}

/* Arranges the speakers of a mask into layers by height, rows by depth, and columns by width */
static void build_geometry(const AtmosRenderer *renderer, uint32_t speaker_mask, PanGeometry *geometry) {
    memset(geometry, 0, sizeof(*geometry));
    geometry->speaker_mask = speaker_mask;
    for (uint32_t index = 0; index < renderer->channel_count; index++) {
        if (!(speaker_mask & (1u << index))) {
            continue;
        }
        const Speaker *speaker = &renderer->speakers[index];
        PanLayer *layer = NULL;
        for (uint32_t layer_index = 0; layer_index < geometry->layer_count; layer_index++) {
            if (geometry->layers[layer_index].z == speaker->z) {
                layer = &geometry->layers[layer_index];
            }
        }
        if (layer == NULL) {
            /* Layers in rising order: floor before top */
            uint32_t position = geometry->layer_count++;
            while (position > 0 && geometry->layers[position - 1].z > speaker->z) {
                geometry->layers[position] = geometry->layers[position - 1];
                position--;
            }
            layer = &geometry->layers[position];
            memset(layer, 0, sizeof(*layer));
            layer->z = speaker->z;
        }
        PanRow *row = NULL;
        for (uint32_t row_index = 0; row_index < layer->row_count; row_index++) {
            if (layer->rows[row_index].y == speaker->y) {
                row = &layer->rows[row_index];
            }
        }
        if (row == NULL) {
            uint32_t position = layer->row_count++;
            while (position > 0 && layer->rows[position - 1].y > speaker->y) {
                layer->rows[position] = layer->rows[position - 1];
                position--;
            }
            row = &layer->rows[position];
            memset(row, 0, sizeof(*row));
            row->y = speaker->y;
        }
        insert_sorted(row->x, row->speaker, &row->count, speaker->x, (uint8_t) index);
    }
}

/*
 * Where a coordinate falls between sorted positions: the lower position's index, and the power the sine and cosine law gives it and the next one.
 * The shares sum to 1 exactly, and a coordinate on a position, or beyond the first or last, gives that position all of it
 */
static uint32_t locate(const float *positions, uint32_t count, float value, float shares[2]) {
    shares[0] = 1.0f;
    shares[1] = 0.0f;
    if (count == 1 || value <= positions[0]) {
        return 0;
    }
    if (value >= positions[count - 1]) {
        shares[0] = 0.0f;
        shares[1] = 1.0f;
        return count - 2;
    }
    uint32_t index = 0;
    while (value > positions[index + 1]) {
        index++;
    }
    const float fraction = (value - positions[index]) / (positions[index + 1] - positions[index]);
    const float lower = cosf(fraction * HALF_PI);
    shares[0] = lower * lower;
    shares[1] = 1.0f - shares[0];
    return index;
}

/* Adds a point's squared gains, scaled by weight, to power: the pan between layers, then rows, then speakers in a row */
static void pan_point_power(const PanGeometry *geometry, float x, float y, float z, float weight, float *power) {
    float layer_z[MAX_LAYERS];
    for (uint32_t index = 0; index < geometry->layer_count; index++) {
        layer_z[index] = geometry->layers[index].z;
    }
    float layer_shares[2];
    const uint32_t layer_index = locate(layer_z, geometry->layer_count, z, layer_shares);
    for (uint32_t layer_step = 0; layer_step < 2; layer_step++) {
        const float layer_weight = weight * layer_shares[layer_step];
        if (layer_weight <= 0.0f) {
            continue;
        }
        const PanLayer *layer = &geometry->layers[layer_index + layer_step];
        float row_y[MAX_ROWS];
        for (uint32_t index = 0; index < layer->row_count; index++) {
            row_y[index] = layer->rows[index].y;
        }
        float row_shares[2];
        const uint32_t row_index = locate(row_y, layer->row_count, y, row_shares);
        for (uint32_t row_step = 0; row_step < 2; row_step++) {
            const float row_weight = layer_weight * row_shares[row_step];
            if (row_weight <= 0.0f) {
                continue;
            }
            const PanRow *row = &layer->rows[row_index + row_step];
            float column_shares[2];
            const uint32_t column = locate(row->x, row->count, x, column_shares);
            for (uint32_t column_step = 0; column_step < 2; column_step++) {
                if (column_shares[column_step] > 0.0f) {
                    power[row->speaker[column + column_step]] += row_weight * column_shares[column_step];
                }
            }
        }
    }
}

/* The zone configuration of an object's properties */
static const PanGeometry *select_geometry(const AtmosRenderer *renderer, const AtmosObjectProperties *properties) {
    const unsigned constraints = properties->zone_constraints <= ATMOS_ZONES_SURROUND_ONLY ? properties->zone_constraints : ATMOS_ZONES_ALL;
    return &renderer->geometries[constraints * 2 + (properties->elevation ? 1 : 0)];
}

/* A dynamic object's gain per channel: its position, spread over its extent, locked to its nearest speaker when asked, times its gain */
static void pan_object(const AtmosRenderer *renderer, const AtmosObjectProperties *properties, float *gains) {
    memset(gains, 0, sizeof(float) * ATMOS_MAX_CHANNELS);
    if (properties->gain <= 0.0f) {
        return;
    }
    const PanGeometry *geometry = select_geometry(renderer, properties);
    const float x = clampf(properties->x, 0.0f, 1.0f);
    const float y = clampf(properties->y, 0.0f, 1.0f);
    /* The layouts have no speakers below the listener */
    const float z = clampf(properties->elevation ? properties->z : 0.0f, 0.0f, 1.0f);
    if (properties->snap) {
        int nearest = -1;
        float nearest_distance = SNAP_DISTANCE;
        for (uint32_t index = 0; index < renderer->channel_count; index++) {
            if (!(geometry->speaker_mask & (1u << index))) {
                continue;
            }
            const Speaker *speaker = &renderer->speakers[index];
            const float dx = 2.0f * (speaker->x - x);
            const float dy = 2.0f * (speaker->y - y);
            const float dz = speaker->z - z;
            const float distance = sqrtf(dx * dx + dy * dy + dz * dz);
            if (distance <= nearest_distance) {
                nearest_distance = distance;
                nearest = (int) index;
            }
        }
        if (nearest >= 0) {
            gains[nearest] = properties->gain;
            return;
        }
    }
    float power[ATMOS_MAX_CHANNELS] = { 0 };
    const float extents[3] = { properties->width, properties->depth, properties->height };
    uint32_t counts[3];
    for (int axis = 0; axis < 3; axis++) {
        counts[axis] = extents[axis] > 0.0f ? SIZE_POINTS : 1;
    }
    const float weight = 1.0f / (float) (counts[0] * counts[1] * counts[2]);
    for (uint32_t i = 0; i < counts[0]; i++) {
        const float px = counts[0] > 1 ? clampf(x + extents[0] * ((float) i / (SIZE_POINTS - 1) - 0.5f), 0.0f, 1.0f) : x;
        for (uint32_t j = 0; j < counts[1]; j++) {
            const float py = counts[1] > 1 ? clampf(y + extents[1] * ((float) j / (SIZE_POINTS - 1) - 0.5f), 0.0f, 1.0f) : y;
            for (uint32_t k = 0; k < counts[2]; k++) {
                const float pz = counts[2] > 1 ? clampf(z + extents[2] * ((float) k / (SIZE_POINTS - 1) - 0.5f), 0.0f, 1.0f) : z;
                pan_point_power(geometry, px, py, pz, weight, power);
            }
        }
    }
    for (uint32_t index = 0; index < renderer->channel_count; index++) {
        gains[index] = properties->gain * sqrtf(power[index]);
    }
}

static int channel_index(const AtmosRenderer *renderer, uint64_t channel) {
    for (uint32_t index = 0; index < renderer->channel_count; index++) {
        if (renderer->speakers[index].channel == channel) {
            return (int) index;
        }
    }
    return -1;
}

/*
 * The channels of a layout mask a bed channel plays from, as the engine folds layouts: its own channel; else a side channel the back one
 * on its side and a back channel the side one; a top front or top back channel the floor channel under it, folding on from there; a wide
 * channel the front one on its side; LFE2 the LFE. A top side channel, which the engine's layouts lack, splits over the top front and top
 * back pair on its side, plays from the top front one of a layout with only that pair, and otherwise from the side channel under it.
 * Returns the number of channels, 0 for a channel the layout drops (an LFE without an LFE speaker); two channels are a split.
 */
static uint32_t resolve_bed_channel(uint64_t channel, uint64_t mask, uint64_t targets[2]) {
    if (mask & channel) {
        targets[0] = channel;
        return 1;
    }
    switch (channel) {
        case ATMOS_CHANNEL_SIDE_LEFT:
        case ATMOS_CHANNEL_BACK_LEFT:
        case ATMOS_CHANNEL_SIDE_RIGHT:
        case ATMOS_CHANNEL_BACK_RIGHT: {
            const uint64_t other = channel == ATMOS_CHANNEL_SIDE_LEFT ? ATMOS_CHANNEL_BACK_LEFT
                : (channel == ATMOS_CHANNEL_BACK_LEFT ? ATMOS_CHANNEL_SIDE_LEFT
                    : (channel == ATMOS_CHANNEL_SIDE_RIGHT ? ATMOS_CHANNEL_BACK_RIGHT : ATMOS_CHANNEL_SIDE_RIGHT));
            if (mask & other) {
                targets[0] = other;
                return 1;
            }
            return 0;
        }
        case ATMOS_CHANNEL_TOP_FRONT_LEFT:
            return resolve_bed_channel(ATMOS_CHANNEL_FRONT_LEFT, mask, targets);
        case ATMOS_CHANNEL_TOP_FRONT_RIGHT:
            return resolve_bed_channel(ATMOS_CHANNEL_FRONT_RIGHT, mask, targets);
        case ATMOS_CHANNEL_TOP_BACK_LEFT:
            return resolve_bed_channel(ATMOS_CHANNEL_BACK_LEFT, mask, targets);
        case ATMOS_CHANNEL_TOP_BACK_RIGHT:
            return resolve_bed_channel(ATMOS_CHANNEL_BACK_RIGHT, mask, targets);
        case ATMOS_CHANNEL_TOP_SIDE_LEFT:
        case ATMOS_CHANNEL_TOP_SIDE_RIGHT: {
            const int left = channel == ATMOS_CHANNEL_TOP_SIDE_LEFT;
            const uint64_t front = left ? ATMOS_CHANNEL_TOP_FRONT_LEFT : ATMOS_CHANNEL_TOP_FRONT_RIGHT;
            const uint64_t back = left ? ATMOS_CHANNEL_TOP_BACK_LEFT : ATMOS_CHANNEL_TOP_BACK_RIGHT;
            if ((mask & front) && (mask & back)) {
                targets[0] = front;
                targets[1] = back;
                return 2;
            }
            if (mask & front) {
                targets[0] = front;
                return 1;
            }
            return resolve_bed_channel(left ? ATMOS_CHANNEL_SIDE_LEFT : ATMOS_CHANNEL_SIDE_RIGHT, mask, targets);
        }
        case ATMOS_CHANNEL_WIDE_LEFT:
            return resolve_bed_channel(ATMOS_CHANNEL_FRONT_LEFT, mask, targets);
        case ATMOS_CHANNEL_WIDE_RIGHT:
            return resolve_bed_channel(ATMOS_CHANNEL_FRONT_RIGHT, mask, targets);
        case ATMOS_CHANNEL_LOW_FREQUENCY_2:
            return resolve_bed_channel(ATMOS_CHANNEL_LOW_FREQUENCY, mask, targets);
        default:
            return 0;
    }
}

/* Adds a 7.1 channel into stereo with the engine's default Lo/Ro matrix: fronts at 1, center, sides, and backs at sqrt(1/2), no LFE */
static void add_lo_ro(uint64_t channel, float gain, float *route) {
    switch (channel) {
        case ATMOS_CHANNEL_FRONT_LEFT:
            route[0] += gain;
            break;
        case ATMOS_CHANNEL_FRONT_RIGHT:
            route[1] += gain;
            break;
        case ATMOS_CHANNEL_FRONT_CENTER:
            route[0] += gain * SQRT_HALF;
            route[1] += gain * SQRT_HALF;
            break;
        case ATMOS_CHANNEL_SIDE_LEFT:
        case ATMOS_CHANNEL_BACK_LEFT:
            route[0] += gain * SQRT_HALF;
            break;
        case ATMOS_CHANNEL_SIDE_RIGHT:
        case ATMOS_CHANNEL_BACK_RIGHT:
            route[1] += gain * SQRT_HALF;
            break;
        default:
            break;
    }
}

/*
 * Each bed object's gain per channel, as the engine routes a decoded layout into an output: every bed channel the layout folds whole into a
 * speaker, and every one already there, takes 1/sqrt(n) of the n channels that speaker sums, which keeps the power of content common to them,
 * and a channel split over two speakers takes sqrt(1/2) on each. Stereo routes the bed into 7.1 that way and mixes that with Lo/Ro,
 * as the engine mixes a height layout to stereo through its folded floor.
 */
static void route_beds(AtmosRenderer *renderer) {
    const AtmosScene *scene = &renderer->scene;
    const int stereo = renderer->layout_mask == ATMOS_LAYOUT_STEREO;
    const uint64_t mask = stereo ? ATMOS_LAYOUT_7_1 : renderer->layout_mask;
    uint64_t targets[ATMOS_MAX_OBJECTS][2];
    uint32_t target_counts[ATMOS_MAX_OBJECTS];
    uint32_t whole_counts[64] = { 0 };
    for (uint32_t object = 0; object < scene->object_count; object++) {
        target_counts[object] = scene->kind[object] == ATMOS_OBJECT_BED ? resolve_bed_channel(scene->bed_channel[object], mask, targets[object]) : 0;
        if (target_counts[object] == 1) {
            whole_counts[__builtin_ctzll(targets[object][0])]++;
        }
    }
    memset(renderer->bed_routes, 0, sizeof(renderer->bed_routes));
    for (uint32_t object = 0; object < scene->object_count; object++) {
        for (uint32_t target = 0; target < target_counts[object]; target++) {
            const uint64_t channel = targets[object][target];
            const float gain = target_counts[object] > 1 ? SQRT_HALF : 1.0f / sqrtf((float) whole_counts[__builtin_ctzll(channel)]);
            if (stereo) {
                add_lo_ro(channel, gain, renderer->bed_routes[object]);
            } else {
                renderer->bed_routes[object][channel_index(renderer, channel)] += gain;
            }
        }
    }
}

/* Lays out the speakers of a layout mask in WAVE bit order, with the zone geometries and the bed routes */
static void configure_layout(AtmosRenderer *renderer) {
    renderer->channel_count = 0;
    renderer->lfe_channel = -1;
    for (uint32_t bit = 0; bit < 32; bit++) {
        const uint64_t channel = 1ull << bit;
        if ((renderer->layout_mask & channel) && describe_speaker(channel, renderer->layout_mask, &renderer->speakers[renderer->channel_count])) {
            if (channel == ATMOS_CHANNEL_LOW_FREQUENCY) {
                renderer->lfe_channel = (int) renderer->channel_count;
            }
            renderer->channel_count++;
        }
    }
    uint32_t all = 0;
    for (uint32_t index = 0; index < renderer->channel_count; index++) {
        if ((int) index != renderer->lfe_channel) {
            all |= 1u << index;
        }
    }
    for (unsigned constraints = 0; constraints <= ATMOS_ZONES_SURROUND_ONLY; constraints++) {
        for (int elevation = 0; elevation < 2; elevation++) {
            uint32_t mask = 0;
            for (uint32_t index = 0; index < renderer->channel_count; index++) {
                if ((all & (1u << index)) && zone_allows(renderer->speakers[index].zones, constraints, elevation)) {
                    mask |= 1u << index;
                }
            }
            /* Constraints that leave a layout no speaker fall back to all of them */
            build_geometry(renderer, mask != 0 ? mask : all, &renderer->geometries[constraints * 2 + (unsigned) elevation]);
        }
    }
    route_beds(renderer);
}

static void compute_gains(const AtmosRenderer *renderer, uint32_t object, const AtmosObjectProperties *properties, float *gains) {
    if (renderer->scene.kind[object] == ATMOS_OBJECT_BED) {
        for (uint32_t index = 0; index < ATMOS_MAX_CHANNELS; index++) {
            gains[index] = renderer->bed_routes[object][index] * properties->gain;
        }
    } else {
        pan_object(renderer, properties, gains);
    }
}

static void reset_objects(AtmosRenderer *renderer) {
    for (uint32_t object = 0; object < ATMOS_MAX_OBJECTS; object++) {
        ObjectState *state = &renderer->objects[object];
        memset(state, 0, sizeof(*state));
        state->current.x = 0.5f;
        state->current.y = 0.5f;
        state->current.elevation = 1;
        state->current.depth_factor = 0.25f;
        if (object < renderer->scene.object_count && renderer->scene.kind[object] == ATMOS_OBJECT_BED) {
            state->current.gain = 1.0f;
            state->current.active = 1;
        }
        if (object < renderer->scene.object_count) {
            compute_gains(renderer, object, &state->current, state->gains);
        }
    }
}

AtmosRenderer *atmos_renderer_create(uint32_t sample_rate) {
    if (sample_rate == 0) {
        return NULL;
    }
    AtmosRenderer *renderer = calloc(1, sizeof(*renderer));
    if (renderer == NULL) {
        return NULL;
    }
    renderer->sample_rate = sample_rate;
    renderer->pending = calloc(ATMOS_MAX_PENDING_UPDATES, sizeof(PendingUpdate));
    renderer->chunk_storage = calloc((size_t) ATMOS_BINAURAL_VIRTUAL_CHANNELS * CHUNK_LENGTH, sizeof(float));
    if (renderer->pending == NULL || renderer->chunk_storage == NULL) {
        atmos_renderer_destroy(renderer);
        return NULL;
    }
    for (uint32_t channel = 0; channel < ATMOS_BINAURAL_VIRTUAL_CHANNELS; channel++) {
        renderer->virtual_planes[channel] = renderer->chunk_storage + (size_t) channel * CHUNK_LENGTH;
    }
    if (sample_rate == ATMOS_BINAURAL_SAMPLE_RATE) {
        renderer->binaural_stage = atmos_binaural_create();
        if (renderer->binaural_stage == NULL) {
            atmos_renderer_destroy(renderer);
            return NULL;
        }
    }
    renderer->output_mask = ATMOS_LAYOUT_STEREO;
    renderer->layout_mask = ATMOS_LAYOUT_STEREO;
    configure_layout(renderer);
    reset_objects(renderer);
    return renderer;
}

void atmos_renderer_destroy(AtmosRenderer *renderer) {
    if (renderer == NULL) {
        return;
    }
    atmos_binaural_destroy(renderer->binaural_stage);
    free(renderer->chunk_storage);
    free(renderer->pending);
    free(renderer);
}

int atmos_renderer_set_target(AtmosRenderer *renderer, uint32_t channel_mask, int binaural) {
    if (renderer == NULL) {
        return ATMOS_ERROR_ARGUMENT;
    }
    if (binaural) {
        if (renderer->binaural_stage == NULL) {
            return ATMOS_ERROR_SAMPLE_RATE;
        }
        if (!renderer->binaural) {
            atmos_binaural_reset(renderer->binaural_stage);
        }
        renderer->binaural = 1;
        renderer->output_mask = ATMOS_LAYOUT_STEREO;
        renderer->layout_mask = ATMOS_BINAURAL_VIRTUAL_LAYOUT;
    } else {
        if (!atmos_layout_supported(channel_mask)) {
            return ATMOS_ERROR_LAYOUT;
        }
        renderer->binaural = 0;
        renderer->output_mask = channel_mask;
        renderer->layout_mask = channel_mask;
    }
    configure_layout(renderer);
    for (uint32_t object = 0; object < renderer->scene.object_count; object++) {
        ObjectState *state = &renderer->objects[object];
        compute_gains(renderer, object, &state->current, state->gains);
    }
    return ATMOS_OK;
}

uint32_t atmos_renderer_channel_mask(const AtmosRenderer *renderer) {
    return renderer->output_mask;
}

uint32_t atmos_renderer_channel_count(const AtmosRenderer *renderer) {
    return renderer->binaural ? 2 : renderer->channel_count;
}

uint32_t atmos_renderer_latency(const AtmosRenderer *renderer) {
    return renderer->binaural ? ATMOS_BINAURAL_LATENCY : 0;
}

static int same_scene(const AtmosScene *a, const AtmosScene *b) {
    if (a->object_count != b->object_count || a->bed_count != b->bed_count || a->isf_count != b->isf_count
        || a->dynamic_count != b->dynamic_count) {
        return 0;
    }
    for (uint32_t object = 0; object < a->object_count; object++) {
        if (a->kind[object] != b->kind[object] || (a->kind[object] == ATMOS_OBJECT_BED && a->bed_channel[object] != b->bed_channel[object])) {
            return 0;
        }
    }
    return 1;
}

int atmos_renderer_set_scene(AtmosRenderer *renderer, const AtmosScene *scene) {
    if (renderer == NULL || scene == NULL || scene->object_count > ATMOS_MAX_OBJECTS) {
        return scene != NULL && scene->object_count > ATMOS_MAX_OBJECTS ? ATMOS_ERROR_OBJECT_COUNT : ATMOS_ERROR_ARGUMENT;
    }
    for (uint32_t object = 0; object < scene->object_count; object++) {
        if (scene->kind[object] == ATMOS_OBJECT_ISF) {
            return ATMOS_ERROR_UNSUPPORTED;
        }
        if (scene->kind[object] > ATMOS_OBJECT_DYNAMIC) {
            return ATMOS_ERROR_ARGUMENT;
        }
    }
    if (same_scene(&renderer->scene, scene)) {
        return ATMOS_OK;
    }
    renderer->scene = *scene;
    renderer->pending_count = 0;
    configure_layout(renderer);
    reset_objects(renderer);
    return ATMOS_OK;
}

int atmos_renderer_add_metadata(AtmosRenderer *renderer, const AtmosMetadata *metadata, int32_t sample_offset) {
    if (renderer == NULL || metadata == NULL || metadata->update_count > ATMOS_MAX_UPDATES) {
        return ATMOS_ERROR_ARGUMENT;
    }
    const int result = atmos_renderer_set_scene(renderer, &metadata->scene);
    if (result != ATMOS_OK) {
        return result;
    }
    if (renderer->pending_count + metadata->update_count > ATMOS_MAX_PENDING_UPDATES) {
        return ATMOS_ERROR_QUEUE;
    }
    for (uint32_t update = 0; update < metadata->update_count; update++) {
        const int64_t start = renderer->clock + sample_offset + (int64_t) metadata->timing[update].start_sample;
        /* In start order; an update keeps its place after earlier ones that start at the same sample */
        uint32_t position = renderer->pending_count;
        while (position > 0 && renderer->pending[position - 1].start > start) {
            renderer->pending[position] = renderer->pending[position - 1];
            position--;
        }
        PendingUpdate *pending = &renderer->pending[position];
        pending->start = start;
        pending->ramp_duration = metadata->timing[update].ramp_duration;
        memcpy(pending->properties, metadata->properties[update], sizeof(AtmosObjectProperties) * metadata->scene.object_count);
        renderer->pending_count++;
    }
    return ATMOS_OK;
}

/* Properties a fraction of the way through a ramp: continuous ones interpolate, discrete ones take the target's at once */
static void interpolate_properties(const AtmosObjectProperties *from, const AtmosObjectProperties *to, float fraction,
    AtmosObjectProperties *result) {
    *result = *to;
    result->x = from->x + (to->x - from->x) * fraction;
    result->y = from->y + (to->y - from->y) * fraction;
    result->z = from->z + (to->z - from->z) * fraction;
    result->gain = from->gain + (to->gain - from->gain) * fraction;
    result->width = from->width + (to->width - from->width) * fraction;
    result->depth = from->depth + (to->depth - from->depth) * fraction;
    result->height = from->height + (to->height - from->height) * fraction;
}

/* Starts the update at the front of the queue at sample time now */
static void start_update(AtmosRenderer *renderer, const PendingUpdate *update, int64_t now) {
    const int64_t elapsed = now - update->start;
    for (uint32_t object = 0; object < renderer->scene.object_count; object++) {
        ObjectState *state = &renderer->objects[object];
        if (elapsed >= (int64_t) update->ramp_duration) {
            state->current = update->properties[object];
            state->ramping = 0;
            compute_gains(renderer, object, &state->current, state->gains);
        } else {
            state->ramp_from = state->current;
            state->ramp_to = update->properties[object];
            state->ramp_start = now;
            state->ramp_length = (uint32_t) ((int64_t) update->ramp_duration - elapsed);
            state->ramping = 1;
        }
    }
}

/* Adds gains times the input into the mixed planes, the gains moving linearly from start to end over the samples */
static void mix_ramp(const float *input, uint32_t count, const float *start, const float *end, uint32_t channel_count, float *const *mix,
    uint32_t offset) {
    const float step = 1.0f / (float) count;
    for (uint32_t channel = 0; channel < channel_count; channel++) {
        const float from = start[channel];
        const float delta = end[channel] - from;
        if (from == 0.0f && delta == 0.0f) {
            continue;
        }
        float *output = mix[channel] + offset;
        for (uint32_t sample = 0; sample < count; sample++) {
            output[sample] += input[sample] * (from + delta * step * (float) (sample + 1));
        }
    }
}

static void mix_constant(const float *input, uint32_t count, const float *gains, uint32_t channel_count, float *const *mix, uint32_t offset) {
    for (uint32_t channel = 0; channel < channel_count; channel++) {
        const float gain = gains[channel];
        if (gain == 0.0f) {
            continue;
        }
        float *output = mix[channel] + offset;
        for (uint32_t sample = 0; sample < count; sample++) {
            output[sample] += input[sample] * gain;
        }
    }
}

/* Mixes one object's samples [from, to) of the chunk, relative to the chunk's start time, advancing its ramp */
static void mix_object(AtmosRenderer *renderer, uint32_t object, const float *input, int64_t chunk_start, uint32_t from, uint32_t to,
    float *const *mix) {
    ObjectState *state = &renderer->objects[object];
    uint32_t position = from;
    while (position < to) {
        if (!state->ramping) {
            if (input != NULL) {
                mix_constant(input + position, to - position, state->gains, renderer->channel_count, mix, position);
            }
            return;
        }
        const int64_t now = chunk_start + position;
        const int64_t ramp_end = state->ramp_start + state->ramp_length;
        const int64_t elapsed = now - state->ramp_start;
        /* Gain vectors at every RAMP_STEP samples of the ramp and at its end, so the ramp reaches its target at ramp_end exactly */
        int64_t step_end = state->ramp_start + (elapsed / RAMP_STEP + 1) * RAMP_STEP;
        if (step_end > ramp_end) {
            step_end = ramp_end;
        }
        const uint32_t count = (uint32_t) ((step_end - now) < (int64_t) (to - position) ? (step_end - now) : (int64_t) (to - position));
        const float fraction = (float) ((double) (now + count - state->ramp_start) / (double) state->ramp_length);
        float end_gains[ATMOS_MAX_CHANNELS];
        AtmosObjectProperties properties;
        interpolate_properties(&state->ramp_from, &state->ramp_to, fraction, &properties);
        compute_gains(renderer, object, &properties, end_gains);
        if (input != NULL) {
            mix_ramp(input + position, count, state->gains, end_gains, renderer->channel_count, mix, position);
        }
        memcpy(state->gains, end_gains, sizeof(end_gains));
        state->current = properties;
        position += count;
        if (now + count >= ramp_end) {
            state->current = state->ramp_to;
            state->ramping = 0;
        }
    }
}

/* Renders one chunk of at most CHUNK_LENGTH samples into the layout's planes */
static void render_chunk(AtmosRenderer *renderer, const float *const *objects, uint32_t offset, uint32_t count, float *const *mix) {
    for (uint32_t channel = 0; channel < renderer->channel_count; channel++) {
        memset(mix[channel], 0, sizeof(float) * count);
    }
    const int64_t chunk_start = renderer->clock;
    uint32_t position = 0;
    while (position < count) {
        while (renderer->pending_count > 0 && renderer->pending[0].start <= chunk_start + position) {
            start_update(renderer, &renderer->pending[0], chunk_start + position);
            renderer->pending_count--;
            memmove(renderer->pending, renderer->pending + 1, sizeof(PendingUpdate) * renderer->pending_count);
        }
        uint32_t end = count;
        if (renderer->pending_count > 0 && renderer->pending[0].start < chunk_start + count) {
            end = (uint32_t) (renderer->pending[0].start - chunk_start);
        }
        for (uint32_t object = 0; object < renderer->scene.object_count; object++) {
            const float *input = objects != NULL && objects[object] != NULL ? objects[object] + offset : NULL;
            mix_object(renderer, object, input, chunk_start, position, end, mix);
        }
        position = end;
    }
    renderer->clock += count;
}

int atmos_renderer_render(AtmosRenderer *renderer, const float *const *objects, uint32_t frame_count, float *const *output) {
    if (renderer == NULL || (output == NULL && frame_count > 0)) {
        return ATMOS_ERROR_ARGUMENT;
    }
    const uint32_t output_count = atmos_renderer_channel_count(renderer);
    for (uint32_t channel = 0; channel < output_count; channel++) {
        if (output[channel] == NULL) {
            return ATMOS_ERROR_ARGUMENT;
        }
    }
    for (uint32_t offset = 0; offset < frame_count; offset += CHUNK_LENGTH) {
        const uint32_t count = frame_count - offset < CHUNK_LENGTH ? frame_count - offset : CHUNK_LENGTH;
        if (renderer->binaural) {
            render_chunk(renderer, objects, offset, count, renderer->virtual_planes);
            atmos_binaural_process(renderer->binaural_stage, renderer->virtual_planes, count, output[0] + offset, output[1] + offset);
        } else {
            float *planes[ATMOS_MAX_CHANNELS];
            for (uint32_t channel = 0; channel < renderer->channel_count; channel++) {
                planes[channel] = output[channel] + offset;
            }
            render_chunk(renderer, objects, offset, count, planes);
        }
    }
    return ATMOS_OK;
}

void atmos_renderer_reset(AtmosRenderer *renderer) {
    if (renderer == NULL) {
        return;
    }
    renderer->pending_count = 0;
    renderer->clock = 0;
    if (renderer->binaural_stage != NULL) {
        atmos_binaural_reset(renderer->binaural_stage);
    }
    reset_objects(renderer);
}
