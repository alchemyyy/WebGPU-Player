/*
 * TrueHD presentation decoder: any presentation of a Dolby TrueHD stream, the 16-channel one included,
 * and the object audio metadata payloads its access units carry.
 *
 * Ported from FFmpeg's MLP decoder (libavcodec/mlpdec.c, mlpdsp.c, mlp.c, and mlp_parse.c;
 * Copyright (c) 2007-2008 Ian Caulfield, 2009 Ramiro Polla), and generalized from FFmpeg's 8 channels and
 * 3 decoded substreams to 16 channels and 4 substreams.
 * FFmpeg stops at the 8-channel presentation; the parts it lacks follow layouts that only an open implementation
 * documents, the truehd crate of truehdd (https://github.com/truehdd/truehdd, Apache-2.0), which we read to learn
 * them and did not copy: the 0x31EC restart sync word of the 16-channel substream and its matrix syntax
 * (coefficient masks and shifts, multi-bit bypassed LSBs, per-access-unit coefficient interpolation),
 * the substreams each presentation is built from, the extra channel meaning of the major sync,
 * and the extra data after the substreams with its Evolution frame, whose payloads use the EMDF payload
 * configuration of ETSI TS 102 366 Annex H and carry object audio metadata as payload 11 (ETSI TS 103 420).
 *
 * This file is part of the TrueHD decoder package and is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public License as published by the Free Software
 * Foundation; either version 2.1 of the License, or (at your option) any later version.
 *
 * It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License
 * for more details.
 */

#include "truehd_presentation.h"

#include <stdlib.h>
#include <string.h>

#define MAJOR_SYNC_TRUEHD 0xF8726FBAU
#define MAJOR_SYNC_SIGNATURE 0xB752U
#define MAJOR_SYNC_SIZE 28
/* Flags bit: the extra data after the substreams holds an Evolution frame */
#define FLAG_EVOLUTION_FRAME 0x1000U
/* Restart sync words: two noise channels (substream 0), a noise table (substreams 1 and 2), and the 16-channel substream */
#define RESTART_SYNC_A 0x31EA
#define RESTART_SYNC_B 0x31EB
#define RESTART_SYNC_C 0x31EC
#define TERMINATOR_WORD 0xD234
/* The Evolution frame payload that carries object audio metadata */
#define EVOLUTION_PAYLOAD_OBJECT_AUDIO_METADATA 11

/* The matrix stage's columns: the channels and the two noise channels of 0x31EA substreams */
#define MATRIX_COLUMNS (TRUEHD_MAX_CHANNELS + 2)
#define MAX_PRIMITIVE_MATRICES 16
#define MAX_BLOCKSIZE_POW2 256
#define MAX_FIR_ORDER 8
#define MAX_IIR_ORDER 4
#define FIR 0
#define IIR 1
/* Matrix coefficients and their accumulations carry 18 fractional bits */
#define MATRIX_FRACTION_BITS 18

/* Decoding parameter presence flags */
#define PARAM_BLOCKSIZE (1 << 7)
#define PARAM_MATRIX (1 << 6)
#define PARAM_OUTSHIFT (1 << 5)
#define PARAM_QUANTSTEP (1 << 4)
#define PARAM_FIR (1 << 3)
#define PARAM_IIR (1 << 2)
#define PARAM_HUFFOFFSET (1 << 1)
#define PARAM_PRESENCE (1 << 0)

/* MSB-first bit reader over a byte range; reads past the end return zeros and mark the reader overrun */
typedef struct BitReader {
    const uint8_t *data;
    size_t bit_length;
    size_t position;
    int overrun;
} BitReader;

static void bits_init(BitReader *reader, const uint8_t *data, size_t byte_length) {
    reader->data = data;
    reader->bit_length = byte_length * 8;
    reader->position = 0;
    reader->overrun = 0;
}

/* Reads count bits, at most 32: whole bytes into a 64-bit window when they are all inside the range, else bit by bit */
static uint32_t bits_get(BitReader *reader, unsigned count) {
    if (count == 0) {
        return 0;
    }
    if (reader->position + count <= reader->bit_length) {
        const size_t first = reader->position >> 3;
        const unsigned skipped = (unsigned) (reader->position & 7);
        const unsigned byte_count = (skipped + count + 7) >> 3;
        uint64_t window = 0;
        for (unsigned index = 0; index < byte_count; index += 1) {
            window = (window << 8) | reader->data[first + index];
        }
        reader->position += count;
        return (uint32_t) ((window >> (byte_count * 8 - skipped - count)) & (((uint64_t) 1 << count) - 1));
    }
    uint32_t value = 0;
    for (unsigned index = 0; index < count; index += 1) {
        uint32_t bit = 0;
        if (reader->position < reader->bit_length) {
            bit = (reader->data[reader->position >> 3] >> (7 - (reader->position & 7))) & 1;
        } else {
            reader->overrun = 1;
        }
        value = (value << 1) | bit;
        reader->position += 1;
    }
    return value;
}

static int32_t bits_get_signed(BitReader *reader, unsigned count) {
    if (count == 0) {
        return 0;
    }
    const uint32_t value = bits_get(reader, count);
    const uint32_t sign = 1U << (count - 1);
    return (int32_t) ((value ^ sign) - sign);
}

/* Skips count bits; a skip past the end stops at the end and marks the reader overrun, so the position never wraps */
static void bits_skip(BitReader *reader, size_t count) {
    if (reader->position > reader->bit_length || count > reader->bit_length - reader->position) {
        reader->position = reader->bit_length;
        reader->overrun = 1;
        return;
    }
    reader->position += count;
}

/* variable_bits groups beyond these bound no field of a valid Evolution frame, as in wgpud/eac3/eac3_emdf.c */
#define MAX_VARIABLE_GROUPS 4

/* ETSI TS 102 366 Annex H variable_bits; more groups than MAX_VARIABLE_GROUPS mark the reader overrun */
static uint32_t bits_get_variable(BitReader *reader, unsigned count) {
    uint32_t value = 0;
    for (int group = 0; group < MAX_VARIABLE_GROUPS; group += 1) {
        value += bits_get(reader, count);
        if (!bits_get(reader, 1) || reader->overrun) {
            return value;
        }
        value = (value + 1) << count;
    }
    reader->overrun = 1;
    return 0;
}

static uint32_t read_be16(const uint8_t *bytes) {
    return ((uint32_t) bytes[0] << 8) | bytes[1];
}

static uint32_t read_be32(const uint8_t *bytes) {
    return (read_be16(bytes) << 16) | read_be16(bytes + 2);
}

static uint8_t xor_32_to_8(uint32_t value) {
    value ^= value >> 16;
    value ^= value >> 8;
    return (uint8_t) value;
}

/* The major sync's CRC-16 (polynomial 0x002D), checked the way FFmpeg's ff_mlp_checksum16 does */
static uint32_t crc16_2d(const uint8_t *bytes, size_t byte_length) {
    uint32_t crc = 0;
    for (size_t index = 0; index < byte_length; index += 1) {
        crc ^= (uint32_t) bytes[index] << 8;
        for (int bit = 0; bit < 8; bit += 1) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x002D) : (crc << 1);
            crc &= 0xFFFF;
        }
    }
    return crc;
}

static uint8_t parity_bytes(const uint8_t *bytes, size_t byte_length) {
    uint8_t parity = 0;
    for (size_t index = 0; index < byte_length; index += 1) {
        parity ^= bytes[index];
    }
    return parity;
}

/* The three Huffman codebooks: code and length of each value from -7 up, as FFmpeg's ff_mlp_huffman_tables lists them */
static const uint8_t huffman_codes[3][18][2] = {
    {
        {0x01, 9}, {0x01, 8}, {0x01, 7}, {0x01, 6}, {0x01, 5}, {0x01, 4}, {0x01, 3},
        {0x04, 3}, {0x05, 3}, {0x06, 3}, {0x07, 3},
        {0x03, 3}, {0x05, 4}, {0x09, 5}, {0x11, 6}, {0x21, 7}, {0x41, 8}, {0x81, 9},
    }, {
        {0x01, 9}, {0x01, 8}, {0x01, 7}, {0x01, 6}, {0x01, 5}, {0x01, 4}, {0x01, 3},
        {0x02, 2}, {0x03, 2},
        {0x03, 3}, {0x05, 4}, {0x09, 5}, {0x11, 6}, {0x21, 7}, {0x41, 8}, {0x81, 9},
    }, {
        {0x01, 9}, {0x01, 8}, {0x01, 7}, {0x01, 6}, {0x01, 5}, {0x01, 4}, {0x01, 3},
        {0x01, 1},
        {0x03, 3}, {0x05, 4}, {0x09, 5}, {0x11, 6}, {0x21, 7}, {0x41, 8}, {0x81, 9},
    }
};
static const uint8_t huffman_code_counts[3] = { 18, 16, 15 };
#define HUFFMAN_LOOKUP_BITS 9

/* Per codebook, the value index and code length of every 9-bit prefix; a length of 0 marks an invalid code */
typedef struct HuffmanEntry {
    uint8_t value;
    uint8_t length;
} HuffmanEntry;
static HuffmanEntry huffman_lookup[3][1 << HUFFMAN_LOOKUP_BITS];
static int huffman_ready;

static void init_huffman(void) {
    if (huffman_ready) {
        return;
    }
    for (int book = 0; book < 3; book += 1) {
        for (int value = 0; value < huffman_code_counts[book]; value += 1) {
            const unsigned code = huffman_codes[book][value][0];
            const unsigned length = huffman_codes[book][value][1];
            const unsigned first = code << (HUFFMAN_LOOKUP_BITS - length);
            for (unsigned fill = 0; fill < (1U << (HUFFMAN_LOOKUP_BITS - length)); fill += 1) {
                huffman_lookup[book][first + fill] = (HuffmanEntry) { (uint8_t) value, (uint8_t) length };
            }
        }
    }
    huffman_ready = 1;
}

/* Looks the next nine bits up, zeros past the end, and consumes the code they start with */
static int read_huffman(BitReader *reader, int codebook) {
    BitReader peek = *reader;
    const HuffmanEntry entry = huffman_lookup[codebook - 1][bits_get(&peek, HUFFMAN_LOOKUP_BITS)];
    if (entry.length == 0) {
        return -1;
    }
    bits_skip(reader, entry.length);
    return entry.value;
}

/* The noise table of 0x31EB and 0x31EC substreams */
static const int8_t noise_table[256] = {
     30,  51,  22,  54,   3,   7,  -4,  38,  14,  55,  46,  81,  22,  58,  -3,   2,
     52,  31,  -7,  51,  15,  44,  74,  30,  85, -17,  10,  33,  18,  80,  28,  62,
     10,  32,  23,  69,  72,  26,  35,  17,  73,  60,   8,  56,   2,   6,  -2,  -5,
     51,   4,  11,  50,  66,  76,  21,  44,  33,  47,   1,  26,  64,  48,  57,  40,
     38,  16, -10, -28,  92,  22, -18,  29, -10,   5, -13,  49,  19,  24,  70,  34,
     61,  48,  30,  14,  -6,  25,  58,  33,  42,  60,  67,  17,  54,  17,  22,  30,
     67,  44,  -9,  50, -11,  43,  40,  32,  59,  82,  13,  49, -14,  55,  60,  36,
     48,  49,  31,  47,  15,  12,   4,  65,   1,  23,  29,  39,  45,  -2,  84,  69,
      0,  72,  37,  57,  27,  41, -15, -16,  35,  31,  14,  61,  24,   0,  27,  24,
     16,  41,  55,  34,  53,   9,  56,  12,  25,  29,  53,   5,  20, -20,  -8,  20,
     13,  28,  -3,  78,  38,  16,  11,  62,  46,  29,  21,  24,  46,  65,  43, -23,
     89,  18,  74,  21,  38, -12,  19,  12, -19,   8,  15,  33,   4,  57,   9,  -8,
     36,  35,  26,  28,   7,  83,  63,  79,  75,  11,   3,  87,  37,  47,  34,  40,
     39,  19,  20,  42,  27,  34,  39,  77,  13,  42,  59,  64,  45,  -1,  32,  37,
     45,  -5,  53,  -6,   7,  36,  50,  23,   6,  32,   9, -21,  18,  71,  27,  52,
    -25,  31,  35,  42,  -1,  68,  63,  52,  26,  43,  66,  37,  41,  25,  40,  70,
};

typedef struct FilterParams {
    uint8_t order;
    uint8_t shift;
    /* The filter's latest inputs (FIR) or outputs (IIR), newest first */
    int32_t state[MAX_FIR_ORDER];
} FilterParams;

typedef struct ChannelParams {
    FilterParams filter_params[2];
    int32_t coeff[2][MAX_FIR_ORDER];
    int16_t huff_offset;
    int32_t sign_huff_offset;
    uint8_t codebook;
    uint8_t huff_lsbs;
} ChannelParams;

typedef struct Substream {
    /* A valid restart header has been read since the last major sync */
    uint8_t restart_seen;
    uint8_t end_of_stream;
    uint16_t sync_word;
    uint8_t min_channel;
    uint8_t max_channel;
    uint8_t max_matrix_channel;
    /* The output channel of each matrix channel */
    uint8_t ch_assign[TRUEHD_MAX_CHANNELS];
    ChannelParams channel_params[TRUEHD_MAX_CHANNELS];
    uint8_t noise_shift;
    uint32_t noisegen_seed;
    uint8_t data_check_present;
    uint8_t param_presence_flags;

    uint8_t num_primitive_matrices;
    uint8_t matrix_out_ch[MAX_PRIMITIVE_MATRICES];
    /* Bypassed LSB bits per sample: 0 or 1, and up to 3 in 0x31EC substreams */
    uint8_t lsb_bypass_bits[MAX_PRIMITIVE_MATRICES];
    /* Coefficients with MATRIX_FRACTION_BITS fractional bits over the matrix columns */
    int32_t matrix_coeff[MAX_PRIMITIVE_MATRICES][MATRIX_COLUMNS];
    /* Left shift of noise into the accumulation, 0 for none */
    uint8_t matrix_noise_shift[MAX_PRIMITIVE_MATRICES];
    /* 0x31EC matrix configuration and interpolation */
    uint8_t frac_bits[MAX_PRIMITIVE_MATRICES];
    int8_t cf_shift[MAX_PRIMITIVE_MATRICES];
    uint16_t cf_mask[MAX_PRIMITIVE_MATRICES];
    uint8_t delta_bits[MAX_PRIMITIVE_MATRICES];
    uint8_t delta_precision[MAX_PRIMITIVE_MATRICES];
    int32_t delta_coeff[MAX_PRIMITIVE_MATRICES][TRUEHD_MAX_CHANNELS];

    uint8_t quant_step_size[TRUEHD_MAX_CHANNELS];
    uint16_t blocksize;
    uint16_t blockpos;
    int8_t output_shift[TRUEHD_MAX_CHANNELS];
    uint8_t lossless_check;
    int lossless_check_active;
    uint32_t lossless_check_data;
    uint16_t zero_samples;
} Substream;

struct TrueHDPresentationDecoder {
    int requested_presentation;
    int params_valid;
    int sample_rate;
    int access_unit_size;
    int access_unit_size_pow2;
    int num_substreams;
    int major_sync_size;
    uint32_t flags;
    uint8_t substream_info;
    uint8_t extended_substream_info;
    /* The presentation decoded and the substreams it is built from */
    int presentation;
    uint8_t substream_mask;
    TrueHDObjectPresentationInfo object_info;

    Substream substreams[TRUEHD_MAX_SUBSTREAMS];
    int matrix_changed;
    int filter_changed[TRUEHD_MAX_CHANNELS][2];
    int8_t noise_buffer[MAX_BLOCKSIZE_POW2];
    uint8_t bypassed_lsbs[TRUEHD_MAX_ACCESS_UNIT_SAMPLES][MAX_PRIMITIVE_MATRICES];
    int32_t sample_buffer[TRUEHD_MAX_ACCESS_UNIT_SAMPLES][MATRIX_COLUMNS];

    int32_t output[TRUEHD_MAX_ACCESS_UNIT_SAMPLES][TRUEHD_MAX_CHANNELS];
    int output_frames;
    int output_channels;
    uint32_t lossless_check_failures;

    int metadata_count;
    size_t metadata_used;
    TrueHDMetadataPayload metadata[TRUEHD_MAX_METADATA_PAYLOADS];
    uint8_t metadata_bytes[TRUEHD_MAX_METADATA_BYTES];
};

TrueHDPresentationDecoder *truehd_presentation_create(int presentation) {
    if (presentation < 0 || presentation >= TRUEHD_MAX_SUBSTREAMS) {
        return NULL;
    }
    init_huffman();
    TrueHDPresentationDecoder *decoder = calloc(1, sizeof(*decoder));
    if (decoder != NULL) {
        decoder->requested_presentation = presentation;
    }
    return decoder;
}

void truehd_presentation_destroy(TrueHDPresentationDecoder *decoder) {
    free(decoder);
}

void truehd_presentation_reset(TrueHDPresentationDecoder *decoder) {
    decoder->params_valid = 0;
    decoder->output_frames = 0;
    decoder->metadata_count = 0;
    for (int index = 0; index < TRUEHD_MAX_SUBSTREAMS; index += 1) {
        decoder->substreams[index].restart_seen = 0;
        decoder->substreams[index].lossless_check_active = 0;
    }
}

/* The substreams each of the four presentations is built from, by the major sync's substream info */
static uint8_t presentation_mask(uint8_t substream_info, uint8_t extended_substream_info, int presentation) {
    switch (presentation) {
        case 0:
            return 1;
        case 1:
            return (substream_info >> 2) & 3;
        case 2:
            return (substream_info >> 4) & 7;
        default:
            return (uint8_t) (((substream_info >> 4) & 8) | (7 ^ (7 >> (extended_substream_info & 3))));
    }
}

/*
 * Resolves the requested presentation: one whose mask includes its own substream is carried itself;
 * otherwise it is a copy of the highest lower presentation its mask reaches, or absent.
 */
static void resolve_presentation(TrueHDPresentationDecoder *decoder) {
    int presentation = decoder->requested_presentation;
    uint8_t mask = presentation_mask(decoder->substream_info, decoder->extended_substream_info, presentation);
    if ((mask >> presentation) == 0) {
        int copy = -1;
        for (int lower = presentation - 1; lower >= 0; lower -= 1) {
            if ((mask >> lower) != 0) {
                copy = lower;
                break;
            }
        }
        presentation = copy;
        mask = copy < 0 ? 0 : presentation_mask(decoder->substream_info, decoder->extended_substream_info, copy);
    }
    if (presentation >= decoder->num_substreams) {
        presentation = -1;
        mask = 0;
    }
    decoder->presentation = presentation;
    decoder->substream_mask = mask;
}

/* The major sync's extra channel meaning, which describes the 16-channel presentation */
static void read_extra_channel_meaning(TrueHDPresentationDecoder *decoder, const uint8_t *bytes, size_t byte_length) {
    TrueHDObjectPresentationInfo *info = &decoder->object_info;
    memset(info, 0, sizeof(*info));
    if (!(decoder->substream_info >> 7)) {
        return;
    }
    BitReader reader;
    bits_init(&reader, bytes, byte_length);
    bits_skip(&reader, 4); /* extra_channel_meaning_length */
    bits_skip(&reader, 5 + 6); /* dialogue norm, mix level */
    info->element_count = (int) bits_get(&reader, 5) + 1;
    info->dynamic_objects_only = (int) bits_get(&reader, 1);
    if (info->dynamic_objects_only) {
        info->lfe_present = (int) bits_get(&reader, 1);
    } else {
        info->content_description = (int) bits_get(&reader, 4);
        if (info->content_description & 1) {
            bits_skip(&reader, 2); /* chan_distribute, reserved */
            info->lfe_only = (int) bits_get(&reader, 1);
            if (!info->lfe_only) {
                bits_skip(&reader, 1);
                info->channel_assignment = (int) bits_get(&reader, 10);
            }
        }
        if (info->content_description & 2) {
            bits_skip(&reader, 3); /* intermediate spatial format */
        }
        if (info->content_description & 4) {
            info->dynamic_object_count = (int) bits_get(&reader, 5);
        }
    }
    info->present = !reader.overrun;
}

/* Reads a TrueHD major sync at bytes, which length bytes of the access unit follow */
static int read_major_sync(TrueHDPresentationDecoder *decoder, const uint8_t *bytes, size_t length) {
    if (length < MAJOR_SYNC_SIZE) {
        return -1;
    }
    size_t size = MAJOR_SYNC_SIZE;
    if (bytes[25] & 1) {
        size += 2 + (size_t) (bytes[26] >> 4) * 2;
    }
    if (length < size) {
        return -1;
    }
    if ((crc16_2d(bytes, size - 4) ^ read_be16(bytes + size - 4)) != read_be16(bytes + size - 2)) {
        return -1;
    }
    if (read_be32(bytes) != MAJOR_SYNC_TRUEHD || read_be16(bytes + 8) != MAJOR_SYNC_SIGNATURE) {
        return -1;
    }
    const int ratebits = bytes[4] >> 4;
    if (ratebits == 0xF || (ratebits & 7) > 2) {
        return -1;
    }
    const int num_substreams = bytes[16] >> 4;
    if (num_substreams == 0 || num_substreams > TRUEHD_MAX_SUBSTREAMS) {
        return -1;
    }
    decoder->sample_rate = ((ratebits & 8) ? 44100 : 48000) << (ratebits & 7);
    decoder->access_unit_size = 40 << (ratebits & 7);
    decoder->access_unit_size_pow2 = 64 << (ratebits & 7);
    decoder->flags = read_be16(bytes + 10);
    decoder->num_substreams = num_substreams;
    decoder->extended_substream_info = bytes[16] & 3;
    decoder->substream_info = bytes[17];
    decoder->major_sync_size = (int) size;
    if (bytes[25] & 1) {
        read_extra_channel_meaning(decoder, bytes + 26, size - 28);
    } else {
        memset(&decoder->object_info, 0, sizeof(decoder->object_info));
    }
    resolve_presentation(decoder);
    decoder->params_valid = 1;
    for (int index = 0; index < TRUEHD_MAX_SUBSTREAMS; index += 1) {
        decoder->substreams[index].restart_seen = 0;
    }
    return 0;
}

static int read_restart_header(TrueHDPresentationDecoder *decoder, BitReader *reader, int substream_index, int is_presentation) {
    Substream *s = &decoder->substreams[substream_index];
    const int sync_word = (int) bits_get(reader, 14);
    if (sync_word != RESTART_SYNC_A && sync_word != RESTART_SYNC_B && sync_word != RESTART_SYNC_C) {
        return -1;
    }
    if (sync_word == RESTART_SYNC_C && substream_index != TRUEHD_OBJECT_PRESENTATION) {
        return -1;
    }
    bits_skip(reader, 16); /* output timing */
    const int min_channel = (int) bits_get(reader, 4);
    const int max_channel = (int) bits_get(reader, 4);
    const int max_matrix_channel = (int) bits_get(reader, 4);
    if (max_channel + 1 < min_channel) {
        return -1;
    }
    s->noise_shift = (uint8_t) bits_get(reader, 4);
    s->noisegen_seed = bits_get(reader, 23);
    bits_skip(reader, 19); /* max_shift, max_lsbs, max_bits, max_bits_repeat */
    s->data_check_present = (uint8_t) bits_get(reader, 1);
    const uint8_t lossless_check = (uint8_t) bits_get(reader, 8);
    bits_skip(reader, 16);
    uint8_t ch_assign[TRUEHD_MAX_CHANNELS];
    for (int channel = 0; channel <= max_matrix_channel; channel += 1) {
        ch_assign[channel] = (uint8_t) bits_get(reader, 6);
        if (ch_assign[channel] > max_matrix_channel) {
            return -1;
        }
    }
    bits_skip(reader, 8); /* restart header checksum */
    if (reader->overrun) {
        return -1;
    }

    if (is_presentation && s->lossless_check_active && xor_32_to_8(s->lossless_check_data) != lossless_check) {
        decoder->lossless_check_failures += 1;
    }
    s->lossless_check = lossless_check;
    s->lossless_check_active = is_presentation;
    s->lossless_check_data = 0;

    s->sync_word = (uint16_t) sync_word;
    s->min_channel = (uint8_t) min_channel;
    s->max_channel = (uint8_t) max_channel;
    s->max_matrix_channel = (uint8_t) max_matrix_channel;
    memcpy(s->ch_assign, ch_assign, sizeof(ch_assign));

    /* Default decoding parameters */
    s->param_presence_flags = 0xFF;
    s->num_primitive_matrices = 0;
    s->blocksize = 8;
    s->zero_samples = 0;
    memset(s->output_shift, 0, sizeof(s->output_shift));
    memset(s->quant_step_size, 0, sizeof(s->quant_step_size));
    memset(s->delta_coeff, 0, sizeof(s->delta_coeff));
    memset(s->delta_bits, 0, sizeof(s->delta_bits));
    memset(s->delta_precision, 0, sizeof(s->delta_precision));
    for (int channel = min_channel; channel <= max_channel; channel += 1) {
        ChannelParams *cp = &s->channel_params[channel];
        cp->filter_params[FIR].order = 0;
        cp->filter_params[IIR].order = 0;
        cp->filter_params[FIR].shift = 0;
        cp->filter_params[IIR].shift = 0;
        /* Default audio coding is 24-bit raw PCM */
        cp->huff_offset = 0;
        cp->sign_huff_offset = -(1 << 23);
        cp->codebook = 0;
        cp->huff_lsbs = 24;
    }
    return 0;
}

static int read_filter_params(TrueHDPresentationDecoder *decoder, BitReader *reader, Substream *s, int channel, int filter) {
    FilterParams *fp = &s->channel_params[channel].filter_params[filter];
    const int max_order = filter == IIR ? MAX_IIR_ORDER : MAX_FIR_ORDER;
    if (decoder->filter_changed[channel][filter]++ > 1) {
        return -1;
    }
    const int order = (int) bits_get(reader, 4);
    if (order > max_order) {
        return -1;
    }
    fp->order = (uint8_t) order;
    if (order > 0) {
        int32_t *coeff = s->channel_params[channel].coeff[filter];
        fp->shift = (uint8_t) bits_get(reader, 4);
        const int coeff_bits = (int) bits_get(reader, 5);
        const int coeff_shift = (int) bits_get(reader, 3);
        if (coeff_bits < 1 || coeff_bits > 16 || coeff_bits + coeff_shift > 16) {
            return -1;
        }
        for (int index = 0; index < order; index += 1) {
            coeff[index] = bits_get_signed(reader, (unsigned) coeff_bits) * (1 << coeff_shift);
        }
        if (bits_get(reader, 1)) {
            if (filter == FIR) {
                return -1;
            }
            const int state_bits = (int) bits_get(reader, 4);
            const int state_shift = (int) bits_get(reader, 4);
            for (int index = 0; index < order; index += 1) {
                fp->state[index] = state_bits ? bits_get_signed(reader, (unsigned) state_bits) * (1 << state_shift) : 0;
            }
        }
    }
    return 0;
}

/* Matrix parameters of 0x31EA and 0x31EB substreams */
static int read_matrix_params(Substream *s, BitReader *reader) {
    s->num_primitive_matrices = (uint8_t) bits_get(reader, 4);
    if (s->num_primitive_matrices > (s->max_matrix_channel + 1 > 8 ? MAX_PRIMITIVE_MATRICES : 8)) {
        s->num_primitive_matrices = 0;
        return -1;
    }
    for (int mat = 0; mat < s->num_primitive_matrices; mat += 1) {
        s->matrix_out_ch[mat] = (uint8_t) bits_get(reader, 4);
        const int frac_bits = (int) bits_get(reader, 4);
        s->lsb_bypass_bits[mat] = (uint8_t) bits_get(reader, 1);
        if (s->matrix_out_ch[mat] > s->max_matrix_channel || frac_bits > 14) {
            s->num_primitive_matrices = 0;
            return -1;
        }
        int max_chan = s->max_matrix_channel;
        if (s->sync_word == RESTART_SYNC_A) {
            max_chan += 2;
        }
        memset(s->matrix_coeff[mat], 0, sizeof(s->matrix_coeff[mat]));
        for (int channel = 0; channel <= max_chan; channel += 1) {
            int32_t coeff = 0;
            if (bits_get(reader, 1)) {
                coeff = bits_get_signed(reader, (unsigned) frac_bits + 2);
            }
            s->matrix_coeff[mat][channel] = coeff * (1 << (MATRIX_FRACTION_BITS - frac_bits));
        }
        s->matrix_noise_shift[mat] = s->sync_word == RESTART_SYNC_B ? (uint8_t) bits_get(reader, 4) : 0;
    }
    return 0;
}

/*
 * Matrix parameters of the 0x31EC substream: an optional new configuration (count, output channels, fractional bits,
 * coefficient shifts, bypassed LSB widths, noise shifts, and which coefficients are coded), new coefficients,
 * and per-access-unit coefficient deltas that interpolate across the access unit.
 */
static int read_object_matrix_params(Substream *s, BitReader *reader) {
    const int columns = s->max_matrix_channel + 1;
    if (bits_get(reader, 1)) {
        if (bits_get(reader, 1)) {
            s->num_primitive_matrices = (uint8_t) (bits_get(reader, 4) + 1);
            for (int mat = 0; mat < s->num_primitive_matrices; mat += 1) {
                s->matrix_out_ch[mat] = (uint8_t) bits_get(reader, 4);
                s->frac_bits[mat] = (uint8_t) bits_get(reader, 4);
                s->cf_shift[mat] = (int8_t) ((int) bits_get(reader, 3) - 1);
                s->lsb_bypass_bits[mat] = (uint8_t) bits_get(reader, 2);
                s->matrix_noise_shift[mat] = (uint8_t) bits_get(reader, 4);
                s->cf_mask[mat] = (uint16_t) bits_get(reader, (unsigned) columns);
                if (s->matrix_out_ch[mat] > s->max_matrix_channel || s->frac_bits[mat] > 14) {
                    s->num_primitive_matrices = 0;
                    return -1;
                }
            }
        }
        for (int mat = 0; mat < s->num_primitive_matrices; mat += 1) {
            const int shift = MATRIX_FRACTION_BITS + s->cf_shift[mat] - s->frac_bits[mat];
            memset(s->matrix_coeff[mat], 0, sizeof(s->matrix_coeff[mat]));
            for (int channel = 0; channel < columns; channel += 1) {
                if ((s->cf_mask[mat] >> channel) & 1) {
                    s->matrix_coeff[mat][channel] = (int32_t) ((uint32_t) bits_get_signed(reader, s->frac_bits[mat] + 2U) << shift);
                }
            }
        }
    }
    if (bits_get(reader, 1)) {
        if (bits_get(reader, 1)) {
            if (bits_get(reader, 1)) {
                for (int mat = 0; mat < s->num_primitive_matrices; mat += 1) {
                    s->delta_bits[mat] = (uint8_t) bits_get(reader, 4);
                    s->delta_precision[mat] = (uint8_t) bits_get(reader, 2);
                }
            }
            for (int mat = 0; mat < s->num_primitive_matrices; mat += 1) {
                const int shift = MATRIX_FRACTION_BITS + s->cf_shift[mat] - s->frac_bits[mat] - s->delta_precision[mat];
                for (int channel = 0; channel < columns; channel += 1) {
                    int32_t delta = 0;
                    if (s->delta_bits[mat] != 0 && ((s->cf_mask[mat] >> channel) & 1)) {
                        delta = bits_get_signed(reader, s->delta_bits[mat] + 1U);
                    }
                    s->delta_coeff[mat][channel] = shift >= 0 ? (int32_t) ((uint32_t) delta << shift) : delta >> -shift;
                }
            }
        }
    } else {
        memset(s->delta_coeff, 0, sizeof(s->delta_coeff));
    }
    return 0;
}

static int32_t calculate_sign_huff(const Substream *s, int channel) {
    const ChannelParams *cp = &s->channel_params[channel];
    const int lsb_bits = cp->huff_lsbs - s->quant_step_size[channel];
    const int sign_shift = lsb_bits + (cp->codebook ? 2 - cp->codebook : -1);
    int64_t offset = cp->huff_offset;
    if (cp->codebook > 0) {
        offset -= (int64_t) 7 << lsb_bits;
    }
    if (sign_shift >= 0) {
        offset -= (int64_t) 1 << sign_shift;
    }
    return (int32_t) (uint32_t) offset;
}

static int read_channel_params(TrueHDPresentationDecoder *decoder, BitReader *reader, Substream *s, int channel) {
    ChannelParams *cp = &s->channel_params[channel];
    FilterParams *fir = &cp->filter_params[FIR];
    FilterParams *iir = &cp->filter_params[IIR];
    if ((s->param_presence_flags & PARAM_FIR) && bits_get(reader, 1) && read_filter_params(decoder, reader, s, channel, FIR) < 0) {
        return -1;
    }
    if ((s->param_presence_flags & PARAM_IIR) && bits_get(reader, 1) && read_filter_params(decoder, reader, s, channel, IIR) < 0) {
        return -1;
    }
    if (fir->order + iir->order > 8) {
        return -1;
    }
    if (fir->order && iir->order && fir->shift != iir->shift) {
        return -1;
    }
    /* Only the FIR filter's precision is used, so an IIR-only channel carries it there */
    if (!fir->order && iir->order) {
        fir->shift = iir->shift;
    }
    if ((s->param_presence_flags & PARAM_HUFFOFFSET) && bits_get(reader, 1)) {
        cp->huff_offset = (int16_t) bits_get_signed(reader, 15);
    }
    cp->codebook = (uint8_t) bits_get(reader, 2);
    cp->huff_lsbs = (uint8_t) bits_get(reader, 5);
    const int max_huff_lsbs = s->sync_word == RESTART_SYNC_C ? 31 : 24;
    if ((cp->codebook > 0 || s->sync_word == RESTART_SYNC_C) && cp->huff_lsbs > max_huff_lsbs) {
        cp->huff_lsbs = 0;
        return -1;
    }
    return 0;
}

static int read_decoding_params(TrueHDPresentationDecoder *decoder, BitReader *reader, Substream *s) {
    uint32_t recompute = 0;
    int result = 0;
    if ((s->param_presence_flags & PARAM_PRESENCE) && bits_get(reader, 1)) {
        s->param_presence_flags = (uint8_t) bits_get(reader, 8);
    }
    if ((s->param_presence_flags & PARAM_BLOCKSIZE) && bits_get(reader, 1)) {
        s->blocksize = (uint16_t) bits_get(reader, 9);
        if (s->blocksize < 8 || s->blocksize > decoder->access_unit_size) {
            s->blocksize = 0;
            return -1;
        }
    }
    if ((s->param_presence_flags & PARAM_MATRIX) && bits_get(reader, 1)) {
        if (decoder->matrix_changed++ > 1) {
            return -1;
        }
        const int status = s->sync_word == RESTART_SYNC_C ? read_object_matrix_params(s, reader) : read_matrix_params(s, reader);
        if (status < 0) {
            return -1;
        }
    }
    if ((s->param_presence_flags & PARAM_OUTSHIFT) && bits_get(reader, 1)) {
        for (int channel = 0; channel <= s->max_matrix_channel; channel += 1) {
            s->output_shift[channel] = (int8_t) bits_get_signed(reader, 4);
            /* FFmpeg ignores negative shifts in the substreams it decodes; the 16-channel substream uses them */
            if (s->output_shift[channel] < 0 && s->sync_word != RESTART_SYNC_C) {
                s->output_shift[channel] = 0;
            }
        }
    }
    if ((s->param_presence_flags & PARAM_QUANTSTEP) && bits_get(reader, 1)) {
        for (int channel = 0; channel <= s->max_channel; channel += 1) {
            s->quant_step_size[channel] = (uint8_t) bits_get(reader, 4);
            recompute |= 1U << channel;
        }
    }
    for (int channel = s->min_channel; channel <= s->max_channel; channel += 1) {
        if (bits_get(reader, 1)) {
            recompute |= 1U << channel;
            if (read_channel_params(decoder, reader, s, channel) < 0) {
                result = -1;
                break;
            }
        }
    }
    for (int channel = 0; channel <= s->max_channel; channel += 1) {
        if (recompute & (1U << channel)) {
            ChannelParams *cp = &s->channel_params[channel];
            if (cp->codebook > 0 && cp->huff_lsbs < s->quant_step_size[channel]) {
                result = -1;
                s->quant_step_size[channel] = 0;
            }
            cp->sign_huff_offset = calculate_sign_huff(s, channel);
        }
    }
    return result;
}

/* Rebuilds a channel's samples from its residuals through its FIR and IIR prediction filters */
static void filter_channel(TrueHDPresentationDecoder *decoder, Substream *s, int channel) {
    ChannelParams *cp = &s->channel_params[channel];
    FilterParams *fir = &cp->filter_params[FIR];
    FilterParams *iir = &cp->filter_params[IIR];
    int32_t fir_buffer[TRUEHD_MAX_ACCESS_UNIT_SAMPLES + MAX_FIR_ORDER];
    int32_t iir_buffer[TRUEHD_MAX_ACCESS_UNIT_SAMPLES + MAX_FIR_ORDER];
    int32_t *firbuf = fir_buffer + TRUEHD_MAX_ACCESS_UNIT_SAMPLES;
    int32_t *iirbuf = iir_buffer + TRUEHD_MAX_ACCESS_UNIT_SAMPLES;
    const int32_t mask = (int32_t) (~0U << s->quant_step_size[channel]);
    const unsigned filter_shift = fir->shift;
    memcpy(firbuf, fir->state, MAX_FIR_ORDER * sizeof(int32_t));
    memcpy(iirbuf, iir->state, MAX_IIR_ORDER * sizeof(int32_t));
    for (int index = 0; index < s->blocksize; index += 1) {
        int32_t *sample = &decoder->sample_buffer[s->blockpos + index][channel];
        int64_t accum = 0;
        for (int order = 0; order < fir->order; order += 1) {
            accum += (int64_t) firbuf[order] * cp->coeff[FIR][order];
        }
        for (int order = 0; order < iir->order; order += 1) {
            accum += (int64_t) iirbuf[order] * cp->coeff[IIR][order];
        }
        accum >>= filter_shift;
        const int32_t result = (int32_t) (((uint32_t) accum + (uint32_t) *sample) & (uint32_t) mask);
        *--firbuf = result;
        *--iirbuf = (int32_t) ((uint32_t) result - (uint32_t) accum);
        *sample = result;
    }
    memcpy(fir->state, firbuf, MAX_FIR_ORDER * sizeof(int32_t));
    memcpy(iir->state, iirbuf, MAX_IIR_ORDER * sizeof(int32_t));
}

static int read_block_data(TrueHDPresentationDecoder *decoder, BitReader *reader, Substream *s) {
    size_t expected_position = 0;
    if (s->data_check_present) {
        expected_position = reader->position;
        expected_position += bits_get(reader, 16);
    }
    if (s->blockpos + s->blocksize > decoder->access_unit_size) {
        return -1;
    }
    for (int index = 0; index < s->blocksize; index += 1) {
        const int position = s->blockpos + index;
        for (int mat = 0; mat < s->num_primitive_matrices; mat += 1) {
            decoder->bypassed_lsbs[position][mat] = s->lsb_bypass_bits[mat] ? (uint8_t) bits_get(reader, s->lsb_bypass_bits[mat]) : 0;
        }
        for (int channel = s->min_channel; channel <= s->max_channel; channel += 1) {
            const ChannelParams *cp = &s->channel_params[channel];
            const int quant_step_size = s->quant_step_size[channel];
            const int lsb_bits = cp->huff_lsbs - quant_step_size;
            uint32_t result = 0;
            if (cp->codebook > 0) {
                const int value = read_huffman(reader, cp->codebook);
                if (value < 0) {
                    return -1;
                }
                result = (uint32_t) value;
            }
            if (lsb_bits > 0) {
                result = (result << lsb_bits) + bits_get(reader, (unsigned) lsb_bits);
            }
            result += (uint32_t) cp->sign_huff_offset;
            result <<= quant_step_size;
            decoder->sample_buffer[position][channel] = (int32_t) result;
        }
    }
    for (int channel = s->min_channel; channel <= s->max_channel; channel += 1) {
        filter_channel(decoder, s, channel);
    }
    if (s->data_check_present) {
        if (reader->position != expected_position) {
            return -1;
        }
        bits_skip(reader, 8);
    }
    return reader->overrun ? -1 : 0;
}

/* The two noise channels of 0x31EA substreams, as matrix columns past the last channel */
static void generate_2_noise_channels(TrueHDPresentationDecoder *decoder, Substream *s, int start, int count) {
    uint32_t seed = s->noisegen_seed;
    const int column = s->max_matrix_channel + 1;
    for (int index = start; index < start + count; index += 1) {
        const uint16_t seed_shr7 = (uint16_t) (seed >> 7);
        decoder->sample_buffer[index][column] = (int32_t) ((uint32_t) (int8_t) (seed >> 15) << s->noise_shift);
        decoder->sample_buffer[index][column + 1] = (int32_t) ((uint32_t) (int8_t) seed_shr7 << s->noise_shift);
        seed = (seed << 16) ^ seed_shr7 ^ ((uint32_t) seed_shr7 << 5);
    }
    s->noisegen_seed = seed;
}

/* The noise table of 0x31EB and 0x31EC substreams, drawn once per access unit */
static void fill_noise_buffer(TrueHDPresentationDecoder *decoder, Substream *s) {
    uint32_t seed = s->noisegen_seed;
    for (int index = 0; index < decoder->access_unit_size_pow2; index += 1) {
        const uint8_t seed_shr15 = (uint8_t) (seed >> 15);
        decoder->noise_buffer[index] = noise_table[seed_shr15];
        seed = (seed << 8) ^ seed_shr15 ^ ((uint32_t) seed_shr15 << 5);
    }
    s->noisegen_seed = seed;
}

/*
 * Applies the presentation's primitive matrices to one block, then its output shifts and channel assignment.
 * Lower substreams' channels are already in the sample buffer for the whole access unit.
 */
static void output_block(TrueHDPresentationDecoder *decoder, Substream *s, int start, int count) {
    const int max_matrix_channel = s->max_matrix_channel;
    const int primitive_matrices = s->num_primitive_matrices;
    const int pow2_mask = decoder->access_unit_size_pow2 - 1;
    int columns = max_matrix_channel;
    if (s->sync_word == RESTART_SYNC_A) {
        generate_2_noise_channels(decoder, s, start, count);
        columns += 2;
    } else if (start == 0) {
        fill_noise_buffer(decoder, s);
    }
    /* The interpolation step per sample, for 0x31EC coefficient deltas */
    const int64_t interpolation = (int64_t) ((1 << 16) / decoder->access_unit_size) << 2;
    for (int index = start; index < start + count; index += 1) {
        int32_t *samples = decoder->sample_buffer[index];
        for (int mat = 0; mat < primitive_matrices; mat += 1) {
            const int dest = s->matrix_out_ch[mat];
            const int32_t *coeffs = s->matrix_coeff[mat];
            int64_t accum = 0;
            for (int column = 0; column <= columns; column += 1) {
                accum += (int64_t) samples[column] * coeffs[column];
            }
            if (s->matrix_noise_shift[mat] && s->sync_word != RESTART_SYNC_A) {
                const int noise_index = ((primitive_matrices - mat) * (2 * index + 1) + index) & pow2_mask;
                accum += (int64_t) decoder->noise_buffer[noise_index] * ((int64_t) 1 << (s->matrix_noise_shift[mat] + 11));
            }
            if (s->sync_word == RESTART_SYNC_C) {
                int64_t delta = 0;
                for (int column = 0; column <= columns; column += 1) {
                    delta += (int64_t) samples[column] * s->delta_coeff[mat][column];
                }
                accum += (delta >> MATRIX_FRACTION_BITS) * index * interpolation;
            }
            const uint32_t mask = ~0U << s->quant_step_size[dest];
            samples[dest] = (int32_t) (((uint32_t) (accum >> MATRIX_FRACTION_BITS) & mask) + decoder->bypassed_lsbs[index][mat]);
        }
        uint32_t check = 0;
        for (int channel = 0; channel <= max_matrix_channel; channel += 1) {
            const int shift = s->output_shift[channel];
            const int32_t sample = shift >= 0 ? (int32_t) ((uint32_t) samples[channel] << shift) : samples[channel] >> -shift;
            decoder->output[index][s->ch_assign[channel]] = sample;
            check ^= ((uint32_t) sample & 0xFFFFFFU) << (channel & 7);
        }
        s->lossless_check_data ^= check;
    }
    if (s->sync_word == RESTART_SYNC_C && start + count == decoder->access_unit_size) {
        for (int mat = 0; mat < primitive_matrices; mat += 1) {
            for (int column = 0; column <= max_matrix_channel; column += 1) {
                s->matrix_coeff[mat][column] += s->delta_coeff[mat][column];
            }
        }
    }
}

/* Decodes one substream's segment; output_block runs on each block of the presentation's own substream */
static int decode_substream(TrueHDPresentationDecoder *decoder, int substream_index, const uint8_t *data, size_t length) {
    Substream *s = &decoder->substreams[substream_index];
    const int is_presentation = substream_index == decoder->presentation;
    BitReader reader;
    bits_init(&reader, data, length);
    decoder->matrix_changed = 0;
    memset(decoder->filter_changed, 0, sizeof(decoder->filter_changed));
    s->blockpos = 0;
    do {
        if (bits_get(&reader, 1)) {
            if (bits_get(&reader, 1)) {
                if (read_restart_header(decoder, &reader, substream_index, is_presentation) < 0) {
                    return -1;
                }
                s->restart_seen = 1;
            }
            if (!s->restart_seen) {
                return 1;
            }
            if (read_decoding_params(decoder, &reader, s) < 0) {
                return -1;
            }
        }
        if (!s->restart_seen) {
            return 1;
        }
        if (read_block_data(decoder, &reader, s) < 0) {
            return -1;
        }
        if (is_presentation) {
            output_block(decoder, s, s->blockpos, s->blocksize);
        }
        s->blockpos += s->blocksize;
        if (reader.position >= length * 8) {
            return -1;
        }
    } while (!bits_get(&reader, 1));

    bits_skip(&reader, (16 - (reader.position & 15)) & 15);
    s->zero_samples = 0;
    if (length * 8 >= reader.position + 32) {
        if (bits_get(&reader, 16) != TERMINATOR_WORD) {
            return -1;
        }
        const uint32_t shorten_by = bits_get(&reader, 16);
        if (shorten_by & 0x2000) {
            const uint32_t zero_samples = shorten_by & 0x1FFF;
            s->zero_samples = (uint16_t) (zero_samples < s->blockpos ? zero_samples : s->blockpos);
        }
        s->end_of_stream = 1;
    }
    return reader.overrun ? -1 : 0;
}

/* Reads the Evolution frame in the extra data after the substreams and keeps its object audio metadata payloads */
static void read_extra_data(TrueHDPresentationDecoder *decoder, const uint8_t *data, size_t length) {
    if (length < 4 || !(decoder->flags & FLAG_EVOLUTION_FRAME)) {
        return;
    }
    const size_t extra_length = (size_t) (read_be16(data) & 0xFFF) * 2;
    if (extra_length == 0 || extra_length + 2 > length || extra_length < 2) {
        return;
    }
    const size_t frame_length = read_be16(data + 2) & 0xFFF;
    if (frame_length == 0 || frame_length + 3 > extra_length) {
        return;
    }
    BitReader reader;
    bits_init(&reader, data + 4, frame_length);
    if (bits_get(&reader, 2) == 3) {
        bits_get_variable(&reader, 2);
    }
    if (bits_get(&reader, 3) == 7) {
        bits_get_variable(&reader, 3);
    }
    for (;;) {
        const uint32_t payload_id = bits_get(&reader, 5);
        if (payload_id == 0 || reader.overrun) {
            return;
        }
        uint32_t sample_offset = 0;
        const int has_sample_offset = (int) bits_get(&reader, 1);
        if (has_sample_offset) {
            sample_offset = bits_get_variable(&reader, 11);
        }
        if (bits_get(&reader, 1)) {
            bits_get_variable(&reader, 11); /* duration */
        }
        if (bits_get(&reader, 1)) {
            bits_get_variable(&reader, 2); /* group identifier */
        }
        if (bits_get(&reader, 1)) {
            bits_skip(&reader, 8); /* codec-specific data */
        }
        if (!bits_get(&reader, 1)) {
            int frame_aligned = 0;
            if (!has_sample_offset) {
                frame_aligned = (int) bits_get(&reader, 1);
                if (frame_aligned) {
                    bits_skip(&reader, 2); /* create and remove duplicate */
                }
            }
            if (has_sample_offset || frame_aligned) {
                bits_skip(&reader, 5 + 2); /* priority, processing allowed */
            }
        }
        const uint32_t payload_length = bits_get_variable(&reader, 8);
        // In whole bytes left, so no product or sum can wrap
        if (reader.overrun || payload_length > (reader.bit_length - reader.position) / 8) {
            return;
        }
        if (payload_id == EVOLUTION_PAYLOAD_OBJECT_AUDIO_METADATA && decoder->metadata_count < TRUEHD_MAX_METADATA_PAYLOADS
                && payload_length <= TRUEHD_MAX_METADATA_BYTES - decoder->metadata_used) {
            uint8_t *bytes = decoder->metadata_bytes + decoder->metadata_used;
            for (uint32_t index = 0; index < payload_length; index += 1) {
                bytes[index] = (uint8_t) bits_get(&reader, 8);
            }
            decoder->metadata[decoder->metadata_count] = (TrueHDMetadataPayload) { bytes, payload_length, sample_offset };
            decoder->metadata_count += 1;
            decoder->metadata_used += payload_length;
        } else {
            bits_skip(&reader, (size_t) payload_length * 8);
        }
    }
}

static enum TrueHDPresentationResult invalidate(TrueHDPresentationDecoder *decoder) {
    truehd_presentation_reset(decoder);
    return TRUEHD_PRESENTATION_INVALID;
}

enum TrueHDPresentationResult truehd_presentation_decode(TrueHDPresentationDecoder *decoder, const uint8_t *data,
        size_t byte_length, size_t *access_unit_length) {
    *access_unit_length = 0;
    decoder->output_frames = 0;
    decoder->metadata_count = 0;
    decoder->metadata_used = 0;
    if (byte_length < 4) {
        return TRUEHD_PRESENTATION_INVALID;
    }
    const size_t length = (size_t) (read_be16(data) & 0xFFF) * 2;
    if (length < 4 || length > byte_length) {
        return TRUEHD_PRESENTATION_INVALID;
    }
    *access_unit_length = length;

    size_t header_size = 4;
    int is_major_sync = 0;
    if (length >= 8 && read_be32(data + 4) == MAJOR_SYNC_TRUEHD) {
        if (read_major_sync(decoder, data + 4, length - 4) < 0) {
            return invalidate(decoder);
        }
        is_major_sync = 1;
        header_size += (size_t) decoder->major_sync_size;
    }
    if (!decoder->params_valid) {
        return TRUEHD_PRESENTATION_AWAITING_SYNC;
    }

    /* The substream directory */
    size_t substream_start[TRUEHD_MAX_SUBSTREAMS];
    size_t substream_end[TRUEHD_MAX_SUBSTREAMS];
    size_t directory_size = 0;
    size_t previous_end = 0;
    for (int index = 0; index < decoder->num_substreams; index += 1) {
        if (length < header_size + directory_size + 2) {
            return invalidate(decoder);
        }
        const uint8_t *entry = data + header_size + directory_size;
        const int extraword_present = entry[0] >> 7;
        const int nonrestart_substream = (entry[0] >> 6) & 1;
        const size_t end = (size_t) (read_be16(entry) & 0xFFF) * 2;
        directory_size += extraword_present ? 4 : 2;
        // An entry's extra word may reach past the access unit, as mlpdec.c checks after reading it
        if (header_size + directory_size > length || nonrestart_substream == is_major_sync || end < previous_end) {
            return invalidate(decoder);
        }
        substream_start[index] = previous_end;
        substream_end[index] = end;
        previous_end = end;
    }
    const uint8_t parity = parity_bytes(data, 4) ^ parity_bytes(data + header_size, directory_size);
    if ((((parity >> 4) ^ parity) & 0xF) != 0xF) {
        return invalidate(decoder);
    }
    const uint8_t *substream_data = data + header_size + directory_size;
    const size_t substream_space = length - header_size - directory_size;
    if (previous_end > substream_space) {
        return invalidate(decoder);
    }

    read_extra_data(decoder, substream_data + previous_end, substream_space - previous_end);

    if (decoder->presentation < 0) {
        return TRUEHD_PRESENTATION_AWAITING_SYNC;
    }
    int ready = 1;
    for (int index = 0; index <= decoder->presentation; index += 1) {
        if (!((decoder->substream_mask >> index) & 1)) {
            continue;
        }
        const int status = decode_substream(decoder, index, substream_data + substream_start[index],
            substream_end[index] - substream_start[index]);
        if (status < 0) {
            return invalidate(decoder);
        }
        if (status > 0) {
            ready = 0;
        }
    }
    if (!ready) {
        return TRUEHD_PRESENTATION_AWAITING_SYNC;
    }
    Substream *s = &decoder->substreams[decoder->presentation];
    if (s->blockpos == 0) {
        return invalidate(decoder);
    }
    decoder->output_frames = s->blockpos - s->zero_samples;
    decoder->output_channels = s->max_matrix_channel + 1;
    for (int index = 0; index <= decoder->presentation; index += 1) {
        if (decoder->substreams[index].end_of_stream) {
            decoder->substreams[index].end_of_stream = 0;
            decoder->substreams[index].lossless_check_active = 0;
            decoder->params_valid = 0;
        }
    }
    return TRUEHD_PRESENTATION_DECODED;
}

int truehd_presentation_sample_rate(const TrueHDPresentationDecoder *decoder) {
    return decoder->sample_rate;
}

int truehd_presentation_access_unit_size(const TrueHDPresentationDecoder *decoder) {
    return decoder->access_unit_size;
}

int truehd_presentation_available(const TrueHDPresentationDecoder *decoder) {
    return decoder->presentation == decoder->requested_presentation;
}

const TrueHDObjectPresentationInfo *truehd_presentation_object_info(const TrueHDPresentationDecoder *decoder) {
    return &decoder->object_info;
}

int truehd_presentation_frame_count(const TrueHDPresentationDecoder *decoder) {
    return decoder->output_frames;
}

int truehd_presentation_channel_count(const TrueHDPresentationDecoder *decoder) {
    return decoder->output_channels;
}

const int32_t (*truehd_presentation_samples(const TrueHDPresentationDecoder *decoder))[TRUEHD_MAX_CHANNELS] {
    return (const int32_t (*)[TRUEHD_MAX_CHANNELS]) decoder->output;
}

int truehd_presentation_metadata_count(const TrueHDPresentationDecoder *decoder) {
    return decoder->metadata_count;
}

TrueHDMetadataPayload truehd_presentation_metadata(const TrueHDPresentationDecoder *decoder, int index) {
    if (index < 0 || index >= decoder->metadata_count) {
        return (TrueHDMetadataPayload) { NULL, 0, 0 };
    }
    return decoder->metadata[index];
}

uint32_t truehd_presentation_lossless_check_failures(const TrueHDPresentationDecoder *decoder) {
    return decoder->lossless_check_failures;
}
