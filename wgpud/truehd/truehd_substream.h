/*
 * Single-substream TrueHD decode: a Dolby TrueHD stream whose one substream carries more than two channels,
 * which FFmpeg's decoder refuses. FFmpeg names the channels of a stream's substream 0 only when that substream is stereo or mono,
 * so every restart header of such a stream fails its channel assignment and no access unit decodes.
 * truehd_substream.c decodes the substream with truehd_presentation.c and lays its channels out as FFmpeg would have;
 * ffmpeg_truehd_bridge.c uses it for every packet of such a stream.
 *
 * This file is part of the TrueHD decoder package and is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public License as published by the Free Software
 * Foundation; either version 2.1 of the License, or (at your option) any later version.
 */
#ifndef TRUEHD_SUBSTREAM_H
#define TRUEHD_SUBSTREAM_H

#include <stddef.h>
#include <stdint.h>

/* What truehd_substream_decode reports for a packet */
enum TrueHDSubstreamResult {
    /* The packet decoded to a block of truehd_substream_frame_count frames */
    TRUEHD_SUBSTREAM_DECODED = 0,
    /* No major sync has been seen since the start or the last error, so the packet decodes to nothing */
    TRUEHD_SUBSTREAM_AWAITING_SYNC = 1,
    /* The packet is invalid; decoding resumes at the next major sync */
    TRUEHD_SUBSTREAM_INVALID = 2,
    /* The packet's block cannot be held: too many frames, or no memory */
    TRUEHD_SUBSTREAM_FAILED = 3
};

typedef struct TrueHDSubstream TrueHDSubstream;

/*
 * Whether the packet's first major sync describes a TrueHD stream FFmpeg refuses: one substream, whose 6- and 8-channel
 * presentations are not both stereo or both mono. Returns 1 for such a stream, 0 for another, and -1 for a packet without a major sync.
 */
int truehd_substream_stock_refuses(const uint8_t *data, size_t byte_length);

TrueHDSubstream *truehd_substream_create(void);
void truehd_substream_destroy(TrueHDSubstream *substream);
/* Forgets the stream, so decoding resumes at the next major sync */
void truehd_substream_reset(TrueHDSubstream *substream);

/* Decodes every access unit of a packet into one block of planar float, in the WAVE order of the stream's layout */
enum TrueHDSubstreamResult truehd_substream_decode(TrueHDSubstream *substream, const uint8_t *data, size_t byte_length);

/* The latest block */
uint32_t truehd_substream_frame_count(const TrueHDSubstream *substream);
uint32_t truehd_substream_sample_rate(const TrueHDSubstream *substream);
uint32_t truehd_substream_channel_count(const TrueHDSubstream *substream);
/* The WAVE channel mask of the block's layout, or 0 for a layout with a channel WAVE does not name, whose planes keep the stream's order */
uint32_t truehd_substream_channel_mask(const TrueHDSubstream *substream);
float *truehd_substream_channel_pointer(TrueHDSubstream *substream, uint32_t channel);
/* FNV-1a over the block packed as FFmpeg packs its output: 24-bit samples shifted into interleaved little-endian int32 in the layout's order */
uint32_t truehd_substream_pcm_fingerprint(const TrueHDSubstream *substream);

#endif
