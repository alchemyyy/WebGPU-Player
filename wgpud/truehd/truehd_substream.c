/*
 * Single-substream TrueHD decode for the TrueHD package: decodes a stream whose one substream carries more than two channels,
 * which FFmpeg's decoder refuses, with truehd_presentation.c, and lays the substream's channels out as FFmpeg lays out a decodable
 * stream's: the major sync's channel arrangement names them in TrueHD order, which the block reorders into WAVE order.
 *
 * This file is part of the TrueHD decoder package and is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public License as published by the Free Software
 * Foundation; either version 2.1 of the License, or (at your option) any later version.
 */

#include "truehd_substream.h"

#include <stdlib.h>
#include <string.h>

#include "truehd_presentation.h"

/* Decoded samples are 24-bit */
#define SAMPLE_SCALE (1.0f / 8388608.0f)
/* The most frames one block may hold, the engine's PACKAGE_AUDIO_MAXIMUM_BLOCK_FRAME_COUNT */
#define TRUEHD_SUBSTREAM_MAXIMUM_BLOCK_FRAMES 16384
/* The major sync's first word, after an access unit's 4-byte header */
#define MAJOR_SYNC_TRUEHD 0xF8726FBAU
#define ACCESS_UNIT_HEADER_SIZE 4
/* The major sync bytes the layout and substream count come from */
#define MAJOR_SYNC_LAYOUT_SIZE 18
#define ARRANGEMENT_GROUPS 13
/* The arrangement groups of a stereo and a mono stream */
#define ARRANGEMENT_LEFT_RIGHT 0x1
#define ARRANGEMENT_CENTER 0x2
/* FNV-1a, as ffmpeg_truehd_bridge.c fingerprints FFmpeg's output */
#define FNV1A_OFFSET_BASIS 2166136261U
#define FNV1A_PRIME 16777619U

/*
 * The channel arrangement's groups from bit 0, in TrueHD order, as FFmpeg's thd_channel_order and ff_truehd_layout map them:
 * L R, C, LFE, Ls Rs, Lvh Rvh, Lc Rc, Lrs Rrs, Cs, Ts, Lsd Rsd, Lw Rw, Cvh, LFE2.
 * Each holds the WAVE bits of its one or two channels; 0 marks a channel WAVE does not name.
 */
static const struct {
    uint8_t channel_count;
    uint32_t wave_bits[2];
} arrangement_groups[ARRANGEMENT_GROUPS] = {
    { 2, { 0x1, 0x2 } },
    { 1, { 0x4, 0 } },
    { 1, { 0x8, 0 } },
    { 2, { 0x200, 0x400 } },
    { 2, { 0x1000, 0x4000 } },
    { 2, { 0x10, 0x20 } },
    { 2, { 0x40, 0x80 } },
    { 1, { 0x100, 0 } },
    { 1, { 0x800, 0 } },
    { 2, { 0, 0 } },
    { 2, { 0, 0 } },
    { 1, { 0x2000, 0 } },
    { 1, { 0, 0 } },
};

struct TrueHDSubstream {
    TrueHDPresentationDecoder *presentation;
    /* The 6- and 8-channel presentations' arrangements of the latest major sync */
    uint32_t arrangement_6;
    uint32_t arrangement_8;
    /* The latest block's layout: its WAVE mask, and the plane each decoded channel goes to */
    uint32_t channel_mask;
    uint8_t plane_of_channel[TRUEHD_MAX_CHANNELS];
    float *planes;
    size_t plane_capacity;
    uint32_t frame_count;
    uint32_t sample_rate;
    uint32_t channel_count;
    uint32_t pcm_fingerprint;
};

static uint32_t read_be32(const uint8_t *bytes) {
    return ((uint32_t) bytes[0] << 24) | ((uint32_t) bytes[1] << 16) | ((uint32_t) bytes[2] << 8) | bytes[3];
}

static int arrangement_channel_count(uint32_t arrangement) {
    int count = 0;
    for (int group = 0; group < ARRANGEMENT_GROUPS; group += 1) {
        if (arrangement & (1U << group)) {
            count += arrangement_groups[group].channel_count;
        }
    }
    return count;
}

/* The length an access unit's header states, or 0 when it runs past the packet or is shorter than its header */
static size_t access_unit_length(const uint8_t *data, size_t byte_length, size_t offset) {
    if (offset + ACCESS_UNIT_HEADER_SIZE > byte_length) {
        return 0;
    }
    const size_t length = (size_t) (((data[offset] << 8) | data[offset + 1]) & 0xFFF) * 2;
    return length < ACCESS_UNIT_HEADER_SIZE || length > byte_length - offset ? 0 : length;
}

/* The major sync of the packet's first access unit that has one, or NULL */
static const uint8_t *find_major_sync(const uint8_t *data, size_t byte_length) {
    for (size_t offset = 0, length; (length = access_unit_length(data, byte_length, offset)) != 0; offset += length) {
        if (length >= ACCESS_UNIT_HEADER_SIZE + MAJOR_SYNC_LAYOUT_SIZE
                && read_be32(data + offset + ACCESS_UNIT_HEADER_SIZE) == MAJOR_SYNC_TRUEHD) {
            return data + offset + ACCESS_UNIT_HEADER_SIZE;
        }
    }
    return NULL;
}

/* The major sync's 5-bit 6-channel and 13-bit 8-channel presentation arrangements, after the rate bits and the channel modifiers */
static uint32_t read_arrangement_6(const uint8_t *major_sync) {
    return ((uint32_t) (major_sync[5] & 0xF) << 1) | (uint32_t) (major_sync[6] >> 7);
}

static uint32_t read_arrangement_8(const uint8_t *major_sync) {
    return ((uint32_t) (major_sync[6] & 0x1F) << 8) | major_sync[7];
}

int truehd_substream_stock_refuses(const uint8_t *data, size_t byte_length) {
    const uint8_t *major_sync = find_major_sync(data, byte_length);
    if (major_sync == NULL) {
        return -1;
    }
    const int substream_count = major_sync[16] >> 4;
    const int channels_6 = arrangement_channel_count(read_arrangement_6(major_sync));
    const int channels_8 = arrangement_channel_count(read_arrangement_8(major_sync));
    /* FFmpeg's read_major_sync names substream 0's channels for these alone */
    const int stereo = channels_6 == 2 && channels_8 == 2;
    const int mono = channels_6 == 1 && channels_8 == 1;
    return substream_count == 1 && !stereo && !mono;
}

TrueHDSubstream *truehd_substream_create(void) {
    TrueHDSubstream *substream = calloc(1, sizeof(*substream));
    if (substream == NULL) {
        return NULL;
    }
    /* The 2-channel presentation is substream 0, which carries every channel of a single-substream stream */
    substream->presentation = truehd_presentation_create(0);
    if (substream->presentation == NULL) {
        free(substream);
        return NULL;
    }
    return substream;
}

void truehd_substream_destroy(TrueHDSubstream *substream) {
    if (substream == NULL) {
        return;
    }
    truehd_presentation_destroy(substream->presentation);
    free(substream->planes);
    free(substream);
}

void truehd_substream_reset(TrueHDSubstream *substream) {
    truehd_presentation_reset(substream->presentation);
    substream->frame_count = 0;
}

/*
 * Lays out a block of channel_count channels: the arrangement whose presentation has that many channels names them in TrueHD order,
 * and the planes take them in WAVE order. A count no arrangement matches, or a channel WAVE does not name, keeps the TrueHD order
 * under mask 0.
 */
static void set_layout(TrueHDSubstream *substream, uint32_t channel_count) {
    uint32_t arrangement = 0;
    if (arrangement_channel_count(substream->arrangement_8) == (int) channel_count) {
        arrangement = substream->arrangement_8;
    } else if (arrangement_channel_count(substream->arrangement_6) == (int) channel_count) {
        arrangement = substream->arrangement_6;
    } else if (channel_count == 2) {
        arrangement = ARRANGEMENT_LEFT_RIGHT;
    } else if (channel_count == 1) {
        arrangement = ARRANGEMENT_CENTER;
    }
    uint32_t wave_bits[TRUEHD_MAX_CHANNELS] = { 0 };
    uint32_t channel = 0;
    uint32_t mask = 0;
    int named = arrangement != 0;
    for (int group = 0; group < ARRANGEMENT_GROUPS && named; group += 1) {
        if (!(arrangement & (1U << group))) {
            continue;
        }
        for (int member = 0; member < arrangement_groups[group].channel_count; member += 1, channel += 1) {
            const uint32_t bit = arrangement_groups[group].wave_bits[member];
            if (bit == 0 || channel >= channel_count) {
                named = 0;
                break;
            }
            wave_bits[channel] = bit;
            mask |= bit;
        }
    }
    for (uint32_t index = 0; index < channel_count; index += 1) {
        uint8_t plane = (uint8_t) index;
        if (named) {
            plane = 0;
            for (uint32_t other = 0; other < channel_count; other += 1) {
                plane += wave_bits[other] < wave_bits[index];
            }
        }
        substream->plane_of_channel[index] = plane;
    }
    substream->channel_mask = named ? mask : 0;
}

/* Reserves planes of capacity frames for every channel the presentation may decode */
static int reserve_planes(TrueHDSubstream *substream, size_t capacity_frames) {
    const size_t samples = capacity_frames * TRUEHD_MAX_CHANNELS;
    if (samples <= substream->plane_capacity) {
        return 1;
    }
    float *planes = realloc(substream->planes, samples * sizeof(float));
    if (planes == NULL) {
        return 0;
    }
    substream->planes = planes;
    substream->plane_capacity = samples;
    return 1;
}

/* The frames the packet's access units can hold, or 0 for a packet whose headers run past it or that exceeds the block bound */
static size_t packet_capacity(const TrueHDSubstream *substream, const uint8_t *data, size_t byte_length) {
    const int access_unit_size = truehd_presentation_access_unit_size(substream->presentation);
    const size_t frames_per_access_unit = access_unit_size > 0 ? (size_t) access_unit_size : TRUEHD_MAX_ACCESS_UNIT_SAMPLES;
    size_t frames = 0;
    size_t offset = 0;
    while (offset < byte_length) {
        const size_t length = access_unit_length(data, byte_length, offset);
        if (length == 0) {
            return 0;
        }
        frames += frames_per_access_unit;
        offset += length;
    }
    return frames > TRUEHD_SUBSTREAM_MAXIMUM_BLOCK_FRAMES ? 0 : frames;
}

static uint32_t fingerprint_word(uint32_t fingerprint, uint32_t word) {
    for (int byte = 0; byte < 4; byte += 1) {
        fingerprint ^= (word >> (8 * byte)) & 0xFF;
        fingerprint *= FNV1A_PRIME;
    }
    return fingerprint;
}

enum TrueHDSubstreamResult truehd_substream_decode(TrueHDSubstream *substream, const uint8_t *data, size_t byte_length) {
    substream->frame_count = 0;
    const uint8_t *major_sync = find_major_sync(data, byte_length);
    if (major_sync != NULL) {
        substream->arrangement_6 = read_arrangement_6(major_sync);
        substream->arrangement_8 = read_arrangement_8(major_sync);
    }
    const size_t capacity_frames = packet_capacity(substream, data, byte_length);
    if (capacity_frames == 0) {
        truehd_presentation_reset(substream->presentation);
        return TRUEHD_SUBSTREAM_INVALID;
    }
    if (!reserve_planes(substream, capacity_frames)) {
        truehd_presentation_reset(substream->presentation);
        return TRUEHD_SUBSTREAM_FAILED;
    }
    int awaiting_sync = 0;
    uint32_t channel_count = 0;
    uint32_t frame_count = 0;
    uint8_t channel_of_plane[TRUEHD_MAX_CHANNELS];
    uint32_t fingerprint = FNV1A_OFFSET_BASIS;
    for (size_t offset = 0, length = 0; offset < byte_length; offset += length) {
        const enum TrueHDPresentationResult result = truehd_presentation_decode(substream->presentation, data + offset,
            byte_length - offset, &length);
        if (length == 0 || result == TRUEHD_PRESENTATION_INVALID) {
            /* The presentation decoder resumes at the next major sync, so the packet's block would have a gap */
            truehd_presentation_reset(substream->presentation);
            return TRUEHD_SUBSTREAM_INVALID;
        }
        if (result == TRUEHD_PRESENTATION_AWAITING_SYNC) {
            awaiting_sync = 1;
            continue;
        }
        const uint32_t decoded_channels = (uint32_t) truehd_presentation_channel_count(substream->presentation);
        const uint32_t frames = (uint32_t) truehd_presentation_frame_count(substream->presentation);
        if (frame_count == 0) {
            channel_count = decoded_channels;
            set_layout(substream, channel_count);
            for (uint32_t channel = 0; channel < channel_count; channel += 1) {
                channel_of_plane[substream->plane_of_channel[channel]] = (uint8_t) channel;
            }
        }
        if (decoded_channels != channel_count || (size_t) frame_count + frames > capacity_frames) {
            truehd_presentation_reset(substream->presentation);
            return TRUEHD_SUBSTREAM_INVALID;
        }
        const int32_t (*samples)[TRUEHD_MAX_CHANNELS] = truehd_presentation_samples(substream->presentation);
        for (uint32_t frame = 0; frame < frames; frame += 1) {
            for (uint32_t plane = 0; plane < channel_count; plane += 1) {
                const int32_t sample = samples[frame][channel_of_plane[plane]];
                substream->planes[(size_t) plane * capacity_frames + frame_count + frame] = (float) sample * SAMPLE_SCALE;
                fingerprint = fingerprint_word(fingerprint, (uint32_t) sample << 8);
            }
        }
        frame_count += frames;
    }
    if (frame_count == 0) {
        return awaiting_sync ? TRUEHD_SUBSTREAM_AWAITING_SYNC : TRUEHD_SUBSTREAM_INVALID;
    }
    /* Close the planes up to the block's length */
    for (uint32_t plane = 1; plane < channel_count; plane += 1) {
        memmove(substream->planes + (size_t) plane * frame_count, substream->planes + (size_t) plane * capacity_frames,
            frame_count * sizeof(float));
    }
    substream->frame_count = frame_count;
    substream->channel_count = channel_count;
    substream->sample_rate = (uint32_t) truehd_presentation_sample_rate(substream->presentation);
    substream->pcm_fingerprint = fingerprint;
    return TRUEHD_SUBSTREAM_DECODED;
}

uint32_t truehd_substream_frame_count(const TrueHDSubstream *substream) {
    return substream->frame_count;
}

uint32_t truehd_substream_sample_rate(const TrueHDSubstream *substream) {
    return substream->sample_rate;
}

uint32_t truehd_substream_channel_count(const TrueHDSubstream *substream) {
    return substream->channel_count;
}

uint32_t truehd_substream_channel_mask(const TrueHDSubstream *substream) {
    return substream->channel_mask;
}

float *truehd_substream_channel_pointer(TrueHDSubstream *substream, uint32_t channel) {
    if (substream->planes == NULL || channel >= substream->channel_count) {
        return NULL;
    }
    return substream->planes + (size_t) channel * substream->frame_count;
}

uint32_t truehd_substream_pcm_fingerprint(const TrueHDSubstream *substream) {
    return substream->pcm_fingerprint;
}
