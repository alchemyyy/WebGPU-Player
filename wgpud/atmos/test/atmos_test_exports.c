/*
 * The exports of the object audio test module beside atmos.h's: building scenes and metadata by hand and reading parsed metadata back,
 * for Atmos.test.ts. No package carries this file.
 */

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

#include "atmos.h"

/* Fields of AtmosObjectProperties, by the test's numbering */
enum TestProperty {
    TEST_PROPERTY_X = 0,
    TEST_PROPERTY_Y = 1,
    TEST_PROPERTY_Z = 2,
    TEST_PROPERTY_GAIN = 3,
    TEST_PROPERTY_WIDTH = 4,
    TEST_PROPERTY_DEPTH = 5,
    TEST_PROPERTY_HEIGHT = 6,
    TEST_PROPERTY_PRIORITY = 7,
    TEST_PROPERTY_DIVERGENCE = 8,
    TEST_PROPERTY_SCREEN_FACTOR = 9,
    TEST_PROPERTY_DEPTH_FACTOR = 10,
    TEST_PROPERTY_ZONE_CONSTRAINTS = 11,
    TEST_PROPERTY_ELEVATION = 12,
    TEST_PROPERTY_SNAP = 13,
    TEST_PROPERTY_ACTIVE = 14
};

/* Fields of AtmosMetadata and its scene */
enum TestField {
    TEST_FIELD_VERSION = 0,
    TEST_FIELD_OBJECT_COUNT = 1,
    TEST_FIELD_BED_COUNT = 2,
    TEST_FIELD_ISF_COUNT = 3,
    TEST_FIELD_DYNAMIC_COUNT = 4,
    TEST_FIELD_ISF_INDEX = 5,
    TEST_FIELD_BED_DISTRIBUTE = 6,
    TEST_FIELD_UPDATE_COUNT = 7
};

EMSCRIPTEN_KEEPALIVE
AtmosMetadata *atmos_test_metadata_create(void) {
    return calloc(1, sizeof(AtmosMetadata));
}

EMSCRIPTEN_KEEPALIVE
void atmos_test_metadata_destroy(AtmosMetadata *metadata) {
    free(metadata);
}

EMSCRIPTEN_KEEPALIVE
double atmos_test_metadata_field(const AtmosMetadata *metadata, uint32_t field) {
    switch (field) {
        case TEST_FIELD_VERSION:
            return metadata->version;
        case TEST_FIELD_OBJECT_COUNT:
            return metadata->scene.object_count;
        case TEST_FIELD_BED_COUNT:
            return metadata->scene.bed_count;
        case TEST_FIELD_ISF_COUNT:
            return metadata->scene.isf_count;
        case TEST_FIELD_DYNAMIC_COUNT:
            return metadata->scene.dynamic_count;
        case TEST_FIELD_ISF_INDEX:
            return metadata->scene.isf_index;
        case TEST_FIELD_BED_DISTRIBUTE:
            return metadata->bed_distribute;
        case TEST_FIELD_UPDATE_COUNT:
            return metadata->update_count;
        default:
            return -1;
    }
}

EMSCRIPTEN_KEEPALIVE
double atmos_test_metadata_kind(const AtmosMetadata *metadata, uint32_t object) {
    return object < ATMOS_MAX_OBJECTS ? metadata->scene.kind[object] : -1;
}

EMSCRIPTEN_KEEPALIVE
double atmos_test_metadata_bed_channel(const AtmosMetadata *metadata, uint32_t object) {
    return object < ATMOS_MAX_OBJECTS ? (double) metadata->scene.bed_channel[object] : -1;
}

EMSCRIPTEN_KEEPALIVE
double atmos_test_metadata_start(const AtmosMetadata *metadata, uint32_t update) {
    return update < ATMOS_MAX_UPDATES ? metadata->timing[update].start_sample : -1;
}

EMSCRIPTEN_KEEPALIVE
double atmos_test_metadata_ramp(const AtmosMetadata *metadata, uint32_t update) {
    return update < ATMOS_MAX_UPDATES ? metadata->timing[update].ramp_duration : -1;
}

EMSCRIPTEN_KEEPALIVE
double atmos_test_metadata_property(const AtmosMetadata *metadata, uint32_t update, uint32_t object, uint32_t property) {
    if (update >= ATMOS_MAX_UPDATES || object >= ATMOS_MAX_OBJECTS) {
        return -1;
    }
    const AtmosObjectProperties *properties = &metadata->properties[update][object];
    switch (property) {
        case TEST_PROPERTY_X:
            return properties->x;
        case TEST_PROPERTY_Y:
            return properties->y;
        case TEST_PROPERTY_Z:
            return properties->z;
        case TEST_PROPERTY_GAIN:
            return properties->gain;
        case TEST_PROPERTY_WIDTH:
            return properties->width;
        case TEST_PROPERTY_DEPTH:
            return properties->depth;
        case TEST_PROPERTY_HEIGHT:
            return properties->height;
        case TEST_PROPERTY_PRIORITY:
            return properties->priority;
        case TEST_PROPERTY_DIVERGENCE:
            return properties->divergence;
        case TEST_PROPERTY_SCREEN_FACTOR:
            return properties->screen_factor;
        case TEST_PROPERTY_DEPTH_FACTOR:
            return properties->depth_factor;
        case TEST_PROPERTY_ZONE_CONSTRAINTS:
            return properties->zone_constraints;
        case TEST_PROPERTY_ELEVATION:
            return properties->elevation;
        case TEST_PROPERTY_SNAP:
            return properties->snap;
        case TEST_PROPERTY_ACTIVE:
            return properties->active;
        default:
            return -1;
    }
}

/* Appends an object to the metadata's scene: a bed object on a channel bit, or a dynamic object when the channel is 0 */
EMSCRIPTEN_KEEPALIVE
int atmos_test_metadata_add_object(AtmosMetadata *metadata, double bed_channel) {
    AtmosScene *scene = &metadata->scene;
    if (scene->object_count >= ATMOS_MAX_OBJECTS) {
        return ATMOS_ERROR_OBJECT_COUNT;
    }
    const uint32_t object = scene->object_count++;
    if (bed_channel != 0) {
        scene->kind[object] = ATMOS_OBJECT_BED;
        scene->bed_channel[object] = (uint64_t) bed_channel;
        scene->bed_count++;
    } else {
        scene->kind[object] = ATMOS_OBJECT_DYNAMIC;
        scene->bed_channel[object] = 0;
        scene->dynamic_count++;
    }
    return (int) object;
}

/* Sets an update's timing, extending update_count to cover it; the update starts as a copy of the one before it */
EMSCRIPTEN_KEEPALIVE
int atmos_test_metadata_set_update(AtmosMetadata *metadata, uint32_t update, uint32_t start_sample, uint32_t ramp_duration) {
    if (update >= ATMOS_MAX_UPDATES) {
        return ATMOS_ERROR_ARGUMENT;
    }
    while (metadata->update_count <= update) {
        const uint32_t next = metadata->update_count++;
        for (uint32_t object = 0; object < ATMOS_MAX_OBJECTS; object++) {
            AtmosObjectProperties *properties = &metadata->properties[next][object];
            if (next > 0) {
                *properties = metadata->properties[next - 1][object];
            } else {
                memset(properties, 0, sizeof(*properties));
                properties->x = 0.5f;
                properties->y = 0.5f;
                properties->gain = 1.0f;
                properties->elevation = 1;
                properties->active = 1;
                properties->depth_factor = 0.25f;
            }
        }
    }
    metadata->timing[update].start_sample = start_sample;
    metadata->timing[update].ramp_duration = ramp_duration;
    return ATMOS_OK;
}

EMSCRIPTEN_KEEPALIVE
int atmos_test_metadata_set_property(AtmosMetadata *metadata, uint32_t update, uint32_t object, uint32_t property, double value) {
    if (update >= ATMOS_MAX_UPDATES || object >= ATMOS_MAX_OBJECTS) {
        return ATMOS_ERROR_ARGUMENT;
    }
    AtmosObjectProperties *properties = &metadata->properties[update][object];
    switch (property) {
        case TEST_PROPERTY_X:
            properties->x = (float) value;
            break;
        case TEST_PROPERTY_Y:
            properties->y = (float) value;
            break;
        case TEST_PROPERTY_Z:
            properties->z = (float) value;
            break;
        case TEST_PROPERTY_GAIN:
            properties->gain = (float) value;
            break;
        case TEST_PROPERTY_WIDTH:
            properties->width = (float) value;
            break;
        case TEST_PROPERTY_DEPTH:
            properties->depth = (float) value;
            break;
        case TEST_PROPERTY_HEIGHT:
            properties->height = (float) value;
            break;
        case TEST_PROPERTY_ZONE_CONSTRAINTS:
            properties->zone_constraints = (uint8_t) value;
            break;
        case TEST_PROPERTY_ELEVATION:
            properties->elevation = (uint8_t) value;
            break;
        case TEST_PROPERTY_SNAP:
            properties->snap = (uint8_t) value;
            break;
        case TEST_PROPERTY_ACTIVE:
            properties->active = (uint8_t) value;
            break;
        default:
            return ATMOS_ERROR_ARGUMENT;
    }
    return ATMOS_OK;
}

EMSCRIPTEN_KEEPALIVE
int atmos_test_renderer_set_scene(AtmosRenderer *renderer, const AtmosMetadata *metadata) {
    return atmos_renderer_set_scene(renderer, &metadata->scene);
}
