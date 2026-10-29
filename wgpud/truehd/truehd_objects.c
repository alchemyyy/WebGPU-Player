/*
 * Object rendering for the TrueHD package: decodes a Dolby TrueHD stream's 16-channel presentation with truehd_presentation.c,
 * reads its object audio metadata, and renders bed channels and dynamic objects with the shared renderer in wgpud/atmos/.
 *
 * The presentation's channels are the metadata's objects in its order, bed objects first, as the truehd crate of truehdd
 * (https://github.com/truehdd/truehdd, Apache-2.0) lays its object presentation out; a presentation without metadata is
 * a channel bed that the major sync's 16-channel channel assignment names.
 */

#include "truehd_objects.h"

#include <stdlib.h>
#include <string.h>

#include "atmos.h"
#include "truehd_presentation.h"

/* Decoded samples are 24-bit */
#define SAMPLE_SCALE (1.0f / 8388608.0f)
/* The most frames one block may hold, the engine's PACKAGE_AUDIO_MAXIMUM_BLOCK_FRAME_COUNT */
#define TRUEHD_OBJECTS_MAXIMUM_BLOCK_FRAMES 16384

/* The 16-channel channel assignment's groups, from bit 0: L R, C, LFE, Ls Rs, Lb Rb, Tfl Tfr, Tsl Tsr, Tbl Tbr, Lw Rw, LFE2 */
static const uint64_t bed_groups[10][2] = {
    { ATMOS_CHANNEL_FRONT_LEFT, ATMOS_CHANNEL_FRONT_RIGHT },
    { ATMOS_CHANNEL_FRONT_CENTER, 0 },
    { ATMOS_CHANNEL_LOW_FREQUENCY, 0 },
    { ATMOS_CHANNEL_SIDE_LEFT, ATMOS_CHANNEL_SIDE_RIGHT },
    { ATMOS_CHANNEL_BACK_LEFT, ATMOS_CHANNEL_BACK_RIGHT },
    { ATMOS_CHANNEL_TOP_FRONT_LEFT, ATMOS_CHANNEL_TOP_FRONT_RIGHT },
    { ATMOS_CHANNEL_TOP_SIDE_LEFT, ATMOS_CHANNEL_TOP_SIDE_RIGHT },
    { ATMOS_CHANNEL_TOP_BACK_LEFT, ATMOS_CHANNEL_TOP_BACK_RIGHT },
    { ATMOS_CHANNEL_WIDE_LEFT, ATMOS_CHANNEL_WIDE_RIGHT },
    { ATMOS_CHANNEL_LOW_FREQUENCY_2, 0 },
};

struct TrueHDObjects {
    TrueHDPresentationDecoder *presentation;
    AtmosRenderer *renderer;
    uint32_t sample_rate;
    uint32_t target_mask;
    int target_binaural;
    int target_renderable;
    /* The renderer has a scene whose object count matches the presentation's channels */
    int has_scene;
    uint32_t scene_object_count;
    uint32_t dynamic_count;
    AtmosMetadata metadata;
    AtmosScene bed_scene;

    float object_samples[TRUEHD_MAX_CHANNELS][TRUEHD_MAX_ACCESS_UNIT_SAMPLES];
    /* The rendered block */
    float *planes;
    size_t plane_capacity;
    uint32_t frame_count;
    uint32_t channel_count;
    uint32_t channel_mask;
};

TrueHDObjects *truehd_objects_create(void) {
    TrueHDObjects *objects = calloc(1, sizeof(*objects));
    if (objects == NULL) {
        return NULL;
    }
    objects->presentation = truehd_presentation_create(TRUEHD_OBJECT_PRESENTATION);
    if (objects->presentation == NULL) {
        free(objects);
        return NULL;
    }
    objects->target_mask = ATMOS_LAYOUT_STEREO;
    return objects;
}

void truehd_objects_destroy(TrueHDObjects *objects) {
    if (objects == NULL) {
        return;
    }
    truehd_presentation_destroy(objects->presentation);
    atmos_renderer_destroy(objects->renderer);
    free(objects->planes);
    free(objects);
}

void truehd_objects_reset(TrueHDObjects *objects) {
    truehd_presentation_reset(objects->presentation);
    if (objects->renderer != NULL) {
        atmos_renderer_reset(objects->renderer);
    }
    objects->has_scene = 0;
    objects->frame_count = 0;
}

static void apply_target(TrueHDObjects *objects) {
    objects->target_renderable = objects->renderer != NULL
        && atmos_renderer_set_target(objects->renderer, objects->target_mask, objects->target_binaural) == ATMOS_OK;
}

void truehd_objects_set_target(TrueHDObjects *objects, uint32_t channel_mask, int binaural) {
    objects->target_mask = channel_mask;
    objects->target_binaural = binaural;
    if (objects->renderer != NULL) {
        apply_target(objects);
    } else {
        /* Known before the first major sync from the layout alone; the sample rate decides binaural later */
        objects->target_renderable = binaural || atmos_layout_supported(channel_mask);
    }
}

int truehd_objects_target_renderable(const TrueHDObjects *objects) {
    return objects->target_renderable;
}

int truehd_objects_stream_has_objects(const TrueHDObjects *objects) {
    return truehd_presentation_object_info(objects->presentation)->present;
}

/* Creates the renderer at the stream's sample rate, again when the rate changes */
static int prepare_renderer(TrueHDObjects *objects, uint32_t sample_rate) {
    if (objects->renderer != NULL && objects->sample_rate == sample_rate) {
        return objects->target_renderable;
    }
    atmos_renderer_destroy(objects->renderer);
    objects->renderer = atmos_renderer_create(sample_rate);
    objects->sample_rate = sample_rate;
    objects->has_scene = 0;
    apply_target(objects);
    return objects->target_renderable;
}

/* A presentation without object metadata is a bed whose channels the major sync's channel assignment names */
static int set_bed_scene(TrueHDObjects *objects, int channel_count) {
    const TrueHDObjectPresentationInfo *info = truehd_presentation_object_info(objects->presentation);
    if (!info->present || info->dynamic_objects_only || info->lfe_only || !(info->content_description & 1)) {
        return 0;
    }
    AtmosScene *scene = &objects->bed_scene;
    memset(scene, 0, sizeof(*scene));
    for (int group = 0; group < 10; group += 1) {
        if (!((info->channel_assignment >> group) & 1)) {
            continue;
        }
        for (int member = 0; member < 2 && bed_groups[group][member] != 0; member += 1) {
            if (scene->object_count >= ATMOS_MAX_OBJECTS) {
                return 0;
            }
            scene->kind[scene->object_count] = ATMOS_OBJECT_BED;
            scene->bed_channel[scene->object_count] = bed_groups[group][member];
            scene->object_count += 1;
        }
    }
    scene->bed_count = scene->object_count;
    if ((int) scene->object_count != channel_count || atmos_renderer_set_scene(objects->renderer, scene) != ATMOS_OK) {
        return 0;
    }
    objects->scene_object_count = scene->object_count;
    objects->dynamic_count = 0;
    return 1;
}

/* Queues the access unit's object metadata, which counts from the access unit's first sample */
static void add_metadata(TrueHDObjects *objects, int channel_count) {
    const int count = truehd_presentation_metadata_count(objects->presentation);
    for (int index = 0; index < count; index += 1) {
        const TrueHDMetadataPayload payload = truehd_presentation_metadata(objects->presentation, index);
        if (atmos_parse_oamd(payload.bytes, payload.byte_length, &objects->metadata) != ATMOS_OK
                || (int) objects->metadata.scene.object_count != channel_count
                || atmos_renderer_add_metadata(objects->renderer, &objects->metadata, (int32_t) payload.sample_offset) != ATMOS_OK) {
            continue;
        }
        objects->has_scene = 1;
        objects->scene_object_count = objects->metadata.scene.object_count;
        objects->dynamic_count = objects->metadata.scene.dynamic_count;
    }
}

static int reserve_planes(TrueHDObjects *objects, size_t frame_count) {
    const size_t sample_count = (size_t) ATMOS_MAX_CHANNELS * frame_count;
    if (sample_count <= objects->plane_capacity) {
        return 1;
    }
    float *planes = realloc(objects->planes, sample_count * sizeof(float));
    if (planes == NULL) {
        return 0;
    }
    objects->planes = planes;
    objects->plane_capacity = sample_count;
    return 1;
}

/*
 * Renders frame_count frames into the block at frame offset start, whose planes hold capacity_frames frames each.
 * The planes are laid out for the block's final length, so earlier access units' samples stay where they are.
 */
static int render_into(TrueHDObjects *objects, const float *const *inputs, uint32_t frame_count, uint32_t start, size_t capacity_frames) {
    float *outputs[ATMOS_MAX_CHANNELS];
    for (uint32_t channel = 0; channel < objects->channel_count; channel += 1) {
        outputs[channel] = objects->planes + (size_t) channel * capacity_frames + start;
    }
    return atmos_renderer_render(objects->renderer, inputs, frame_count, outputs) == ATMOS_OK;
}

/*
 * Counts the access units of a packet by their headers and the frames they can hold, so the block's planes are laid out once.
 * Returns 0 for a packet whose headers run past it, or whose frames could exceed the engine's block bound, which then plays the stock decode.
 */
static size_t packet_capacity(const TrueHDObjects *objects, const uint8_t *data, size_t byte_length) {
    const int access_unit_size = truehd_presentation_access_unit_size(objects->presentation);
    const size_t frames_per_access_unit = access_unit_size > 0 ? (size_t) access_unit_size : TRUEHD_MAX_ACCESS_UNIT_SAMPLES;
    size_t frames = 0;
    size_t offset = 0;
    while (offset + 4 <= byte_length) {
        const size_t length = (size_t) (((data[offset] << 8) | data[offset + 1]) & 0xFFF) * 2;
        if (length < 4 || length > byte_length - offset) {
            return 0;
        }
        frames += frames_per_access_unit;
        if (frames > TRUEHD_OBJECTS_MAXIMUM_BLOCK_FRAMES) {
            return 0;
        }
        offset += length;
    }
    return frames;
}

int truehd_objects_decode(TrueHDObjects *objects, const uint8_t *data, size_t byte_length) {
    objects->frame_count = 0;
    const size_t capacity_frames = packet_capacity(objects, data, byte_length);
    if (capacity_frames == 0 || !reserve_planes(objects, capacity_frames)) {
        // The decoder misses this packet, so it must not carry its filter and matrix state into the next one
        truehd_objects_reset(objects);
        return 0;
    }
    int rendered = 1;
    uint32_t frame_count = 0;
    size_t offset = 0;
    while (offset + 4 <= byte_length) {
        size_t length = 0;
        const enum TrueHDPresentationResult result = truehd_presentation_decode(objects->presentation, data + offset,
            byte_length - offset, &length);
        if (length == 0) {
            rendered = 0;
            break;
        }
        offset += length;
        if (result != TRUEHD_PRESENTATION_DECODED || !truehd_presentation_available(objects->presentation)
                || !prepare_renderer(objects, (uint32_t) truehd_presentation_sample_rate(objects->presentation))) {
            rendered = 0;
            continue;
        }
        const int channel_count = truehd_presentation_channel_count(objects->presentation);
        add_metadata(objects, channel_count);
        if (!objects->has_scene) {
            objects->has_scene = set_bed_scene(objects, channel_count);
        }
        if (!objects->has_scene || (int) objects->scene_object_count != channel_count) {
            rendered = 0;
            continue;
        }
        const int frames = truehd_presentation_frame_count(objects->presentation);
        if ((size_t) frame_count + (size_t) frames > capacity_frames) {
            rendered = 0;
            continue;
        }
        const int32_t (*samples)[TRUEHD_MAX_CHANNELS] = truehd_presentation_samples(objects->presentation);
        const float *inputs[TRUEHD_MAX_CHANNELS];
        for (int channel = 0; channel < channel_count; channel += 1) {
            float *plane = objects->object_samples[channel];
            for (int frame = 0; frame < frames; frame += 1) {
                plane[frame] = (float) samples[frame][channel] * SAMPLE_SCALE;
            }
            inputs[channel] = plane;
        }
        objects->channel_count = atmos_renderer_channel_count(objects->renderer);
        objects->channel_mask = atmos_renderer_channel_mask(objects->renderer);
        if (!render_into(objects, inputs, (uint32_t) frames, frame_count, capacity_frames)) {
            rendered = 0;
            continue;
        }
        frame_count += (uint32_t) frames;
    }
    if (!rendered || frame_count == 0) {
        return 0;
    }
    /* Close the planes up to the block's length */
    for (uint32_t channel = 1; channel < objects->channel_count; channel += 1) {
        memmove(objects->planes + (size_t) channel * frame_count, objects->planes + (size_t) channel * capacity_frames,
            frame_count * sizeof(float));
    }
    objects->frame_count = frame_count;
    return 1;
}

int truehd_objects_drain(TrueHDObjects *objects) {
    objects->frame_count = 0;
    if (objects->renderer == NULL || !objects->has_scene) {
        return 0;
    }
    const uint32_t latency = atmos_renderer_latency(objects->renderer);
    if (latency == 0 || !reserve_planes(objects, latency)) {
        return 0;
    }
    objects->channel_count = atmos_renderer_channel_count(objects->renderer);
    objects->channel_mask = atmos_renderer_channel_mask(objects->renderer);
    if (!render_into(objects, NULL, latency, 0, latency)) {
        return 0;
    }
    objects->frame_count = latency;
    return 1;
}

uint32_t truehd_objects_frame_count(const TrueHDObjects *objects) {
    return objects->frame_count;
}

uint32_t truehd_objects_sample_rate(const TrueHDObjects *objects) {
    return objects->sample_rate;
}

uint32_t truehd_objects_channel_count(const TrueHDObjects *objects) {
    return objects->channel_count;
}

uint32_t truehd_objects_channel_mask(const TrueHDObjects *objects) {
    return objects->channel_mask;
}

float *truehd_objects_channel_pointer(TrueHDObjects *objects, uint32_t channel) {
    if (objects->frame_count == 0 || channel >= objects->channel_count) {
        return NULL;
    }
    return objects->planes + (size_t) channel * objects->frame_count;
}

uint32_t truehd_objects_dynamic_count(const TrueHDObjects *objects) {
    return objects->dynamic_count;
}
