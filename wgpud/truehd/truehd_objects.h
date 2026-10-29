/*
 * Object rendering for the TrueHD package: decodes a Dolby TrueHD stream's 16-channel presentation with truehd_presentation.c,
 * reads its object audio metadata, and renders bed channels and dynamic objects with the shared renderer in wgpud/atmos/.
 */
#ifndef TRUEHD_OBJECTS_H
#define TRUEHD_OBJECTS_H

#include <stddef.h>
#include <stdint.h>

typedef struct TrueHDObjects TrueHDObjects;

TrueHDObjects *truehd_objects_create(void);
void truehd_objects_destroy(TrueHDObjects *objects);
/* Forgets the stream and the scene, so rendering resumes once a major sync and object metadata arrive */
void truehd_objects_reset(TrueHDObjects *objects);

/* Sets the target: a WAVE channel mask, or binaural stereo; takes effect from the next packet */
void truehd_objects_set_target(TrueHDObjects *objects, uint32_t channel_mask, int binaural);
/* Whether the latest target can be rendered at the stream's sample rate, once one is known */
int truehd_objects_target_renderable(const TrueHDObjects *objects);

/*
 * Decodes and renders every access unit of a packet into one block.
 * Returns 1 when every access unit rendered, 0 when the packet holds one that did not (no major sync or object metadata yet,
 * or no 16-channel presentation in the stream), which the caller replaces with the stock decode.
 */
int truehd_objects_decode(TrueHDObjects *objects, const uint8_t *data, size_t byte_length);
/* Renders the binaural delay's tail after the last packet; returns 1 when it made a block */
int truehd_objects_drain(TrueHDObjects *objects);

/* Whether the latest major sync declared the 16-channel presentation */
int truehd_objects_stream_has_objects(const TrueHDObjects *objects);

/* The rendered block: planes of frame_count samples one after another, in the mask's channel order */
uint32_t truehd_objects_frame_count(const TrueHDObjects *objects);
uint32_t truehd_objects_sample_rate(const TrueHDObjects *objects);
uint32_t truehd_objects_channel_count(const TrueHDObjects *objects);
uint32_t truehd_objects_channel_mask(const TrueHDObjects *objects);
float *truehd_objects_channel_pointer(TrueHDObjects *objects, uint32_t channel);
/* Dynamic objects the block rendered */
uint32_t truehd_objects_dynamic_count(const TrueHDObjects *objects);

#endif
