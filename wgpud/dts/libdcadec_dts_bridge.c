/*
 * libdcadec's DTS decoder behind version 1 of the engine's audio decoder interface.
 * dts.manifest beside this file names the codec, attributes, and error codes declared here.
 * A packet decodes to one block, which the receive after its send hands over.
 */

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "dca_context.h"
#include "dca_frame.h"

#include "audio_decoder_interface.h"

#define DTS_MAXIMUM_PACKET_SIZE (2U * 1024U * 1024U)
// dcadec_frame_buffer_size pads a packet by at most this many bytes
#define DTS_MAXIMUM_PACKET_PADDING 64U
#define DTS_MAXIMUM_CHANNEL_COUNT 32U
// libdcadec's status for a packet before the next sync point of its lossless extension
#define DTS_NO_SYNC_STATUS (-5)

/* The codecs in the manifest's `accepts:` order */
enum DTSCodec {
    DTS_CODEC_DTS = 0
};

/* The manifest's attribute keys */
enum DTSAttribute {
    DTS_ATTRIBUTE_BITS_PER_SAMPLE = 1,
    DTS_ATTRIBUTE_PROFILE = 2,
    DTS_ATTRIBUTE_PARSE_STATUS = 3,
    DTS_ATTRIBUTE_FILTER_STATUS = 4,
    DTS_ATTRIBUTE_LIBRARY_VERSION = 5
};

/* The manifest's error codes */
enum DTSError {
    DTS_ERROR_INPUT = 1,
    DTS_ERROR_CONVERT = 2,
    DTS_ERROR_PARSE = 3,
    DTS_ERROR_FILTER = 4,
    DTS_ERROR_OPTION = 5,
    DTS_ERROR_OUTPUT = 6
};

typedef struct DTSDecoder {
    struct dcadec_context *context;
    uint8_t *packet_buffer;
    size_t packet_capacity;
    size_t packet_size;
    /* The decoded block as planar float, one plane after another */
    float *planes;
    size_t plane_capacity;
    int block_ready;
    int channel_count;
    int sample_count;
    int channel_mask;
    int sample_rate;
    int bits_per_sample;
    int profile;
    int parse_status;
    int filter_status;
    uint32_t error_code;
    uint32_t error_value;
} DTSDecoder;

static int fail(DTSDecoder *decoder, uint32_t code, uint32_t value) {
    decoder->error_code = code;
    decoder->error_value = value;
    return AUDIO_DECODER_FAILED;
}

static void clear_output(DTSDecoder *decoder) {
    decoder->block_ready = 0;
    decoder->channel_count = 0;
    decoder->sample_count = 0;
    decoder->channel_mask = 0;
    decoder->sample_rate = 0;
    decoder->bits_per_sample = 0;
    decoder->profile = DCADEC_PROFILE_UNKNOWN;
    decoder->parse_status = 0;
    decoder->filter_status = 0;
}

static int count_channels(int channel_mask) {
    int count = 0;
    for (unsigned int remaining = (unsigned int) channel_mask; remaining != 0; remaining &= remaining - 1) {
        count += 1;
    }
    return count;
}

/*
 * Converts libdcadec's integer planes to float.
 * Each sample is scaled in double by the exact power-of-two reciprocal of full scale and then rounded to float once,
 * which is bit-identical to dividing by the full-scale value.
 */
static int convert_planes(DTSDecoder *decoder, int *const *samples) {
    const size_t channel_count = (size_t) decoder->channel_count;
    const size_t frame_count = (size_t) decoder->sample_count;
    const size_t sample_count = channel_count * frame_count;
    if (sample_count > decoder->plane_capacity) {
        float *planes = realloc(decoder->planes, sample_count * sizeof(float));
        if (planes == NULL) {
            return fail(decoder, DTS_ERROR_OUTPUT, (uint32_t) sample_count);
        }
        decoder->planes = planes;
        decoder->plane_capacity = sample_count;
    }
    const double reciprocal = 1.0 / (double) (1U << (decoder->bits_per_sample - 1));
    for (size_t channel = 0; channel < channel_count; channel += 1) {
        const int *plane = samples[channel];
        float *output = decoder->planes + channel * frame_count;
        for (size_t frame_index = 0; frame_index < frame_count; frame_index += 1) {
            output[frame_index] = (float) ((double) plane[frame_index] * reciprocal);
        }
    }
    return AUDIO_DECODER_SUCCESS;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_abi_version(void) {
    return AUDIO_DECODER_ABI_VERSION;
}

EMSCRIPTEN_KEEPALIVE
DTSDecoder *audio_decoder_create(int codec) {
    if (codec != DTS_CODEC_DTS) {
        return NULL;
    }
    DTSDecoder *decoder = calloc(1, sizeof(*decoder));
    if (decoder == NULL) {
        return NULL;
    }
    decoder->context = dcadec_context_create(DCADEC_FLAG_STRICT);
    if (decoder->context == NULL) {
        free(decoder);
        return NULL;
    }
    clear_output(decoder);
    return decoder;
}

EMSCRIPTEN_KEEPALIVE
void audio_decoder_destroy(DTSDecoder *decoder) {
    if (decoder == NULL) {
        return;
    }
    dcadec_context_destroy(decoder->context);
    free(decoder->packet_buffer);
    free(decoder->planes);
    free(decoder);
}

/* The packet buffer, with the padding libdcadec reads past a packet */
EMSCRIPTEN_KEEPALIVE
uint8_t *audio_decoder_reserve_input(DTSDecoder *decoder, uint32_t byte_length) {
    decoder->packet_size = 0;
    if (byte_length == 0 || byte_length > DTS_MAXIMUM_PACKET_SIZE) {
        fail(decoder, DTS_ERROR_INPUT, byte_length);
        return NULL;
    }
    const size_t required_capacity = dcadec_frame_buffer_size(byte_length);
    if (required_capacity < byte_length || required_capacity > DTS_MAXIMUM_PACKET_SIZE + DTS_MAXIMUM_PACKET_PADDING) {
        fail(decoder, DTS_ERROR_INPUT, byte_length);
        return NULL;
    }
    if (required_capacity > decoder->packet_capacity) {
        uint8_t *packet_buffer = realloc(decoder->packet_buffer, required_capacity);
        if (packet_buffer == NULL) {
            fail(decoder, DTS_ERROR_INPUT, byte_length);
            return NULL;
        }
        decoder->packet_buffer = packet_buffer;
        decoder->packet_capacity = required_capacity;
    }
    memset(decoder->packet_buffer + byte_length, 0, decoder->packet_capacity - byte_length);
    decoder->packet_size = byte_length;
    return decoder->packet_buffer;
}

/* DTS takes no codec private data */
EMSCRIPTEN_KEEPALIVE
int audio_decoder_configure(DTSDecoder *decoder, uint32_t byte_length) {
    (void) decoder;
    (void) byte_length;
    return AUDIO_DECODER_SUCCESS;
}

EMSCRIPTEN_KEEPALIVE
int audio_decoder_set_option(DTSDecoder *decoder, uint32_t key, double value) {
    (void) value;
    return fail(decoder, DTS_ERROR_OPTION, key);
}

/* Decodes the packet into the block the next receive hands over; a packet before the lossless extension's next sync point awaits sync */
EMSCRIPTEN_KEEPALIVE
int audio_decoder_send(DTSDecoder *decoder, uint32_t byte_length, double timestamp) {
    (void) timestamp;
    clear_output(decoder);
    if (decoder->packet_buffer == NULL || byte_length == 0 || byte_length != decoder->packet_size) {
        return fail(decoder, DTS_ERROR_INPUT, byte_length);
    }
    size_t converted_size = byte_length;
    const int bitstream_format = dcadec_frame_convert_bitstream(decoder->packet_buffer, &converted_size, decoder->packet_buffer, byte_length);
    if (bitstream_format < 0) {
        return fail(decoder, DTS_ERROR_CONVERT, (uint32_t) -bitstream_format);
    }
    if (converted_size == 0 || converted_size > decoder->packet_capacity) {
        return fail(decoder, DTS_ERROR_CONVERT, (uint32_t) converted_size);
    }
    memset(decoder->packet_buffer + converted_size, 0, decoder->packet_capacity - converted_size);

    decoder->parse_status = dcadec_context_parse(decoder->context, decoder->packet_buffer, converted_size);
    if (decoder->parse_status == DTS_NO_SYNC_STATUS) {
        return AUDIO_DECODER_SEND_AWAITING_SYNC;
    }
    if (decoder->parse_status < 0) {
        return fail(decoder, DTS_ERROR_PARSE, (uint32_t) -decoder->parse_status);
    }
    int **samples = NULL;
    decoder->filter_status = dcadec_context_filter(
        decoder->context,
        &samples,
        &decoder->sample_count,
        &decoder->channel_mask,
        &decoder->sample_rate,
        &decoder->bits_per_sample,
        &decoder->profile
    );
    if (decoder->filter_status == DTS_NO_SYNC_STATUS) {
        clear_output(decoder);
        return AUDIO_DECODER_SEND_AWAITING_SYNC;
    }
    if (decoder->filter_status < 0) {
        const int filter_status = decoder->filter_status;
        clear_output(decoder);
        return fail(decoder, DTS_ERROR_FILTER, (uint32_t) -filter_status);
    }
    decoder->channel_count = count_channels(decoder->channel_mask);
    if (samples == NULL || decoder->channel_count <= 0 || (unsigned int) decoder->channel_count > DTS_MAXIMUM_CHANNEL_COUNT
        || decoder->sample_count <= 0 || decoder->bits_per_sample < 2 || decoder->bits_per_sample > 32) {
        const uint32_t channel_mask = (uint32_t) decoder->channel_mask;
        clear_output(decoder);
        return fail(decoder, DTS_ERROR_OUTPUT, channel_mask);
    }
    if (convert_planes(decoder, samples) != AUDIO_DECODER_SUCCESS) {
        clear_output(decoder);
        return AUDIO_DECODER_FAILED;
    }
    decoder->block_ready = 1;
    return AUDIO_DECODER_SEND_ACCEPTED;
}

EMSCRIPTEN_KEEPALIVE
int audio_decoder_receive(DTSDecoder *decoder) {
    if (!decoder->block_ready) {
        return AUDIO_DECODER_RECEIVE_NONE;
    }
    // The block stays readable until the next send; this receive only hands it over once
    decoder->block_ready = 0;
    return AUDIO_DECODER_RECEIVE_READY;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_frame_count(DTSDecoder *decoder) {
    return (uint32_t) decoder->sample_count;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_sample_rate(DTSDecoder *decoder) {
    return (uint32_t) decoder->sample_rate;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_channel_count(DTSDecoder *decoder) {
    return (uint32_t) decoder->channel_count;
}

/* libdcadec reports WAVE channel masks */
EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_channel_mask(DTSDecoder *decoder) {
    return (uint32_t) decoder->channel_mask;
}

EMSCRIPTEN_KEEPALIVE
float *audio_decoder_channel_pointer(DTSDecoder *decoder, uint32_t channel) {
    if (decoder->planes == NULL || channel >= (uint32_t) decoder->channel_count) {
        return NULL;
    }
    return decoder->planes + (size_t) channel * (size_t) decoder->sample_count;
}

/* A block takes its packet's timestamp */
EMSCRIPTEN_KEEPALIVE
double audio_decoder_timestamp(DTSDecoder *decoder) {
    (void) decoder;
    return AUDIO_DECODER_NO_TIMESTAMP;
}

EMSCRIPTEN_KEEPALIVE
double audio_decoder_attribute(DTSDecoder *decoder, uint32_t key) {
    switch (key) {
        case DTS_ATTRIBUTE_BITS_PER_SAMPLE:
            return (double) decoder->bits_per_sample;
        case DTS_ATTRIBUTE_PROFILE:
            return (double) decoder->profile;
        case DTS_ATTRIBUTE_PARSE_STATUS:
            return (double) decoder->parse_status;
        case DTS_ATTRIBUTE_FILTER_STATUS:
            return (double) decoder->filter_status;
        case DTS_ATTRIBUTE_LIBRARY_VERSION:
            return (double) dcadec_version();
        default:
            return AUDIO_DECODER_NO_ATTRIBUTE;
    }
}

EMSCRIPTEN_KEEPALIVE
void audio_decoder_clear(DTSDecoder *decoder) {
    dcadec_context_clear(decoder->context);
    clear_output(decoder);
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_error_code(DTSDecoder *decoder) {
    return decoder->error_code;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_error_value(DTSDecoder *decoder) {
    return decoder->error_value;
}
