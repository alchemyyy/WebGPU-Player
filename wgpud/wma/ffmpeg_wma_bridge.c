/*
 * FFmpeg's WMA 1, WMA 2, WMA Pro, WMA Lossless, and WMA Voice decoders behind version 1 of the engine's audio decoder interface.
 * wma.manifest beside this file names the codecs, attributes, and error codes declared here.
 *
 * Every one of these decoders needs the track's WAVEFORMATEX, so a decoder opens only in audio_decoder_configure, which reads it
 * as FFmpeg's ff_get_wav_header (libavformat/riffdec.c) does, and audio_decoder_send refuses packets until a configure succeeded.
 * Each configure after the first opens a fresh codec context, so a decoder reconfigured with a new WAVEFORMATEX keeps no state of the old one.
 * The decoders hold frames back, such as WMA 1 and 2's last overlap and the frames WMA Lossless has buffered, so the module adds the optional
 * audio_decoder_drain, after which audio_decoder_receive returns them; audio_decoder_clear starts a new stream after a drain.
 */

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "libavcodec/avcodec.h"
#include "libavutil/channel_layout.h"
#include "libavutil/error.h"
#include "libavutil/intreadwrite.h"
#include "libavutil/log.h"
#include "libavutil/mem.h"
#include "libavutil/samplefmt.h"

#include "audio_decoder_interface.h"

/* The codecs in the manifest's `accepts:` order */
enum WMACodec {
    WMA_CODEC_WMAV1 = 0,
    WMA_CODEC_WMAV2 = 1,
    WMA_CODEC_WMAPRO = 2,
    WMA_CODEC_WMALOSSLESS = 3,
    WMA_CODEC_WMAVOICE = 4
};

/* The manifest's attribute keys */
enum WMAAttribute {
    WMA_ATTRIBUTE_LIBRARY_VERSION = 1
};

/* The manifest's error codes */
enum WMAError {
    WMA_ERROR_INPUT = 1,
    WMA_ERROR_SEND = 2,
    WMA_ERROR_RECEIVE = 3,
    WMA_ERROR_SAMPLE_FORMAT = 4,
    WMA_ERROR_OPTION = 5,
    WMA_ERROR_OUTPUT = 6,
    WMA_ERROR_WAVE_FORMAT = 7,
    WMA_ERROR_FORMAT_TAG = 8,
    WMA_ERROR_OPEN = 9,
    WMA_ERROR_UNCONFIGURED = 10
};

/* The WAVEFORMATEX fields, little endian, up to and including cbSize */
#define WAVE_FORMAT_HEADER_SIZE 18
#define WAVE_FORMAT_TAG_OFFSET 0
#define WAVE_FORMAT_CHANNELS_OFFSET 2
#define WAVE_FORMAT_SAMPLE_RATE_OFFSET 4
#define WAVE_FORMAT_BYTES_PER_SECOND_OFFSET 8
#define WAVE_FORMAT_BLOCK_ALIGN_OFFSET 12
#define WAVE_FORMAT_BITS_PER_SAMPLE_OFFSET 14
#define WAVE_FORMAT_EXTENSION_SIZE_OFFSET 16
/* WAVE_FORMAT_EXTENSIBLE: wValidBitsPerSample, dwChannelMask, and the SubFormat GUID after the header */
#define WAVE_FORMAT_EXTENSIBLE_TAG 0xFFFE
#define WAVE_FORMAT_EXTENSIBLE_SIZE 22
#define WAVE_FORMAT_VALID_BITS_OFFSET 18
#define WAVE_FORMAT_CHANNEL_MASK_OFFSET 20
#define WAVE_FORMAT_SUBFORMAT_OFFSET 24
#define SUBFORMAT_TAG_SIZE 4
#define SUBFORMAT_BASE_SIZE 12

/* The last 12 bytes of the SubFormat GUIDs whose first 4 bytes are a format tag, as riffdec.c's parse_waveformatex accepts them */
static const uint8_t SUBFORMAT_TAG_BASES[][SUBFORMAT_BASE_SIZE] = {
    /* FF_MEDIASUBTYPE_BASE_GUID */
    { 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71 },
    /* FF_AMBISONIC_BASE_GUID */
    { 0x21, 0x07, 0xD3, 0x11, 0x86, 0x44, 0xC8, 0xC1, 0xCA, 0x00, 0x00, 0x00 },
    /* FF_BROKEN_BASE_GUID */
    { 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA }
};

typedef struct WMADecoder {
    const AVCodec *codec;
    /* The format tag of the codec, as libavformat/riff.c's ff_codec_wav_tags lists it */
    uint32_t format_tag;
    AVCodecContext *codec_context;
    AVPacket *packet;
    AVFrame *frame;
    /* Whether a configure used codec_context, which a later configure then replaces */
    int context_used;
    int opened;
    /* The received frame as planar float, one plane after another, unless the frame's own planes are planar float */
    float *planes;
    size_t plane_capacity;
    int planes_in_frame;
    uint32_t error_code;
    uint32_t error_value;
} WMADecoder;

static int fail(WMADecoder *decoder, uint32_t code, uint32_t value) {
    decoder->error_code = code;
    decoder->error_value = value;
    return AUDIO_DECODER_FAILED;
}

static void free_decoder(WMADecoder *decoder) {
    av_frame_free(&decoder->frame);
    av_packet_free(&decoder->packet);
    avcodec_free_context(&decoder->codec_context);
    free(decoder->planes);
    free(decoder);
}

static enum AVCodecID get_codec_id(int codec) {
    switch (codec) {
        case WMA_CODEC_WMAV1:
            return AV_CODEC_ID_WMAV1;
        case WMA_CODEC_WMAV2:
            return AV_CODEC_ID_WMAV2;
        case WMA_CODEC_WMAPRO:
            return AV_CODEC_ID_WMAPRO;
        case WMA_CODEC_WMALOSSLESS:
            return AV_CODEC_ID_WMALOSSLESS;
        case WMA_CODEC_WMAVOICE:
            return AV_CODEC_ID_WMAVOICE;
        default:
            return AV_CODEC_ID_NONE;
    }
}

static uint32_t get_format_tag(int codec) {
    switch (codec) {
        case WMA_CODEC_WMAV1:
            return 0x0160;
        case WMA_CODEC_WMAV2:
            return 0x0161;
        case WMA_CODEC_WMAPRO:
            return 0x0162;
        case WMA_CODEC_WMALOSSLESS:
            return 0x0163;
        default:
            return 0x000A;
    }
}

/* Whether a SubFormat GUID's last 12 bytes are a base whose first 4 bytes carry a format tag */
static int has_subformat_tag(const uint8_t *subformat) {
    for (size_t index = 0; index < sizeof(SUBFORMAT_TAG_BASES) / sizeof(SUBFORMAT_TAG_BASES[0]); index += 1) {
        if (memcmp(subformat + SUBFORMAT_TAG_SIZE, SUBFORMAT_TAG_BASES[index], SUBFORMAT_BASE_SIZE) == 0) {
            return 1;
        }
    }
    return 0;
}

/*
 * Converts the received frame into planar float.
 * Planar float stays in the frame. Integers are scaled in double by the exact power-of-two reciprocal of full scale and then rounded to
 * float once, which is bit-identical to dividing by the full-scale value; packed float is deinterleaved.
 */
static int convert_frame(WMADecoder *decoder) {
    const AVFrame *frame = decoder->frame;
    const size_t channel_count = (size_t) frame->ch_layout.nb_channels;
    const size_t frame_count = (size_t) frame->nb_samples;
    const size_t sample_count = channel_count * frame_count;
    decoder->planes_in_frame = frame->format == AV_SAMPLE_FMT_FLTP;
    if (decoder->planes_in_frame) {
        return AUDIO_DECODER_SUCCESS;
    }
    if (frame->format != AV_SAMPLE_FMT_S16P && frame->format != AV_SAMPLE_FMT_S32P && frame->format != AV_SAMPLE_FMT_FLT) {
        return fail(decoder, WMA_ERROR_SAMPLE_FORMAT, (uint32_t) frame->format);
    }
    if (sample_count > decoder->plane_capacity) {
        float *planes = realloc(decoder->planes, sample_count * sizeof(float));
        if (planes == NULL) {
            return fail(decoder, WMA_ERROR_OUTPUT, (uint32_t) sample_count);
        }
        decoder->planes = planes;
        decoder->plane_capacity = sample_count;
    }
    switch (frame->format) {
        case AV_SAMPLE_FMT_S16P:
            for (size_t channel = 0; channel < channel_count; channel += 1) {
                const int16_t *samples = (const int16_t *) frame->extended_data[channel];
                float *plane = decoder->planes + channel * frame_count;
                for (size_t frame_index = 0; frame_index < frame_count; frame_index += 1) {
                    plane[frame_index] = (float) ((double) samples[frame_index] * 0x1p-15);
                }
            }
            break;
        case AV_SAMPLE_FMT_S32P:
            for (size_t channel = 0; channel < channel_count; channel += 1) {
                const int32_t *samples = (const int32_t *) frame->extended_data[channel];
                float *plane = decoder->planes + channel * frame_count;
                for (size_t frame_index = 0; frame_index < frame_count; frame_index += 1) {
                    plane[frame_index] = (float) ((double) samples[frame_index] * 0x1p-31);
                }
            }
            break;
        default: {
            const float *samples = (const float *) frame->data[0];
            for (size_t frame_index = 0; frame_index < frame_count; frame_index += 1) {
                for (size_t channel = 0; channel < channel_count; channel += 1) {
                    decoder->planes[channel * frame_count + frame_index] = samples[frame_index * channel_count + channel];
                }
            }
            break;
        }
    }
    return AUDIO_DECODER_SUCCESS;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_abi_version(void) {
    return AUDIO_DECODER_ABI_VERSION;
}

EMSCRIPTEN_KEEPALIVE
WMADecoder *audio_decoder_create(int codec) {
    const enum AVCodecID codec_id = get_codec_id(codec);
    const AVCodec *codec_implementation = codec_id == AV_CODEC_ID_NONE ? NULL : avcodec_find_decoder(codec_id);
    if (codec_implementation == NULL) {
        return NULL;
    }
    av_log_set_level(AV_LOG_QUIET);

    WMADecoder *decoder = calloc(1, sizeof(*decoder));
    if (decoder == NULL) {
        return NULL;
    }
    decoder->codec = codec_implementation;
    decoder->format_tag = get_format_tag(codec);
    decoder->codec_context = avcodec_alloc_context3(codec_implementation);
    decoder->packet = av_packet_alloc();
    decoder->frame = av_frame_alloc();
    if (decoder->codec_context == NULL || decoder->packet == NULL || decoder->frame == NULL) {
        free_decoder(decoder);
        return NULL;
    }
    return decoder;
}

EMSCRIPTEN_KEEPALIVE
void audio_decoder_destroy(WMADecoder *decoder) {
    if (decoder != NULL) {
        free_decoder(decoder);
    }
}

/* The packet or WAVEFORMATEX buffer, with FFmpeg's input padding past it */
EMSCRIPTEN_KEEPALIVE
uint8_t *audio_decoder_reserve_input(WMADecoder *decoder, uint32_t byte_length) {
    av_packet_unref(decoder->packet);
    if (byte_length == 0 || byte_length > INT32_MAX || av_new_packet(decoder->packet, (int) byte_length) < 0) {
        fail(decoder, WMA_ERROR_INPUT, byte_length);
        return NULL;
    }
    return decoder->packet->data;
}

/*
 * Reads the track's WAVEFORMATEX, or WAVE_FORMAT_EXTENSIBLE, and opens the decoder with what ff_get_wav_header sets from it:
 * the sample rate, the channels, the extensible channel mask when it describes that many channels, the bit rate, the block alignment,
 * the bits per sample, and the cbSize bytes after the header, after the extensible fields, as extradata.
 * The header must hold its cbSize bytes, where ff_get_wav_header would read only what a Matroska CodecPrivate holds, and a sample rate
 * that ff_get_wav_header takes; it refuses no channel count, which this bridge requires to be nonzero, since the decoders divide by it.
 */
EMSCRIPTEN_KEEPALIVE
int audio_decoder_configure(WMADecoder *decoder, uint32_t byte_length) {
    const uint8_t *input = decoder->packet->data;
    if (input == NULL || byte_length == 0 || byte_length > (uint32_t) decoder->packet->size) {
        return fail(decoder, WMA_ERROR_INPUT, byte_length);
    }
    decoder->opened = 0;
    if (decoder->context_used) {
        avcodec_free_context(&decoder->codec_context);
        decoder->codec_context = avcodec_alloc_context3(decoder->codec);
        if (decoder->codec_context == NULL) {
            return fail(decoder, WMA_ERROR_OPEN, (uint32_t) -AVERROR(ENOMEM));
        }
    }
    decoder->context_used = 1;

    if (byte_length < WAVE_FORMAT_HEADER_SIZE) {
        return fail(decoder, WMA_ERROR_WAVE_FORMAT, byte_length);
    }
    const uint32_t tag = AV_RL16(input + WAVE_FORMAT_TAG_OFFSET);
    const uint32_t channel_count = AV_RL16(input + WAVE_FORMAT_CHANNELS_OFFSET);
    const uint32_t sample_rate = AV_RL32(input + WAVE_FORMAT_SAMPLE_RATE_OFFSET);
    const uint32_t bytes_per_second = AV_RL32(input + WAVE_FORMAT_BYTES_PER_SECOND_OFFSET);
    const uint32_t block_align = AV_RL16(input + WAVE_FORMAT_BLOCK_ALIGN_OFFSET);
    uint32_t bits_per_sample = AV_RL16(input + WAVE_FORMAT_BITS_PER_SAMPLE_OFFSET);
    uint32_t extension_size = AV_RL16(input + WAVE_FORMAT_EXTENSION_SIZE_OFFSET);
    if (extension_size > byte_length - WAVE_FORMAT_HEADER_SIZE || sample_rate == 0 || sample_rate > INT32_MAX || channel_count == 0) {
        return fail(decoder, WMA_ERROR_WAVE_FORMAT, byte_length);
    }
    const uint8_t *extradata = input + WAVE_FORMAT_HEADER_SIZE;
    uint32_t channel_mask = 0;
    uint32_t subformat_tag = tag;
    if (tag == WAVE_FORMAT_EXTENSIBLE_TAG) {
        if (extension_size < WAVE_FORMAT_EXTENSIBLE_SIZE) {
            return fail(decoder, WMA_ERROR_WAVE_FORMAT, byte_length);
        }
        const uint32_t valid_bits = AV_RL16(input + WAVE_FORMAT_VALID_BITS_OFFSET);
        if (valid_bits != 0) {
            bits_per_sample = valid_bits;
        }
        channel_mask = AV_RL32(input + WAVE_FORMAT_CHANNEL_MASK_OFFSET);
        const uint8_t *subformat = input + WAVE_FORMAT_SUBFORMAT_OFFSET;
        subformat_tag = AV_RL32(subformat);
        if (!has_subformat_tag(subformat)) {
            return fail(decoder, WMA_ERROR_FORMAT_TAG, subformat_tag);
        }
        extradata += WAVE_FORMAT_EXTENSIBLE_SIZE;
        extension_size -= WAVE_FORMAT_EXTENSIBLE_SIZE;
    }
    if (subformat_tag != decoder->format_tag) {
        return fail(decoder, WMA_ERROR_FORMAT_TAG, subformat_tag);
    }

    AVCodecContext *context = decoder->codec_context;
    context->sample_rate = (int) sample_rate;
    context->bit_rate = (int64_t) bytes_per_second * 8;
    context->block_align = (int) block_align;
    context->bits_per_coded_sample = (int) bits_per_sample;
    // The extensible mask stands only when it describes the header's channel count, as ff_get_wav_header keeps it
    av_channel_layout_uninit(&context->ch_layout);
    if (channel_mask == 0 || av_channel_layout_from_mask(&context->ch_layout, channel_mask) < 0
        || (uint32_t) context->ch_layout.nb_channels != channel_count) {
        av_channel_layout_uninit(&context->ch_layout);
        context->ch_layout.order = AV_CHANNEL_ORDER_UNSPEC;
        context->ch_layout.nb_channels = (int) channel_count;
    }
    if (extension_size > 0) {
        context->extradata = av_mallocz((size_t) extension_size + AV_INPUT_BUFFER_PADDING_SIZE);
        if (context->extradata == NULL) {
            return fail(decoder, WMA_ERROR_OPEN, (uint32_t) -AVERROR(ENOMEM));
        }
        memcpy(context->extradata, extradata, extension_size);
        context->extradata_size = (int) extension_size;
    }
    // Timestamps are integer microseconds
    context->pkt_timebase = (AVRational) { 1, 1000000 };
    av_packet_unref(decoder->packet);
    const int result = avcodec_open2(context, decoder->codec, NULL);
    if (result < 0) {
        return fail(decoder, WMA_ERROR_OPEN, (uint32_t) -result);
    }
    decoder->opened = 1;
    return AUDIO_DECODER_SUCCESS;
}

EMSCRIPTEN_KEEPALIVE
int audio_decoder_set_option(WMADecoder *decoder, uint32_t key, double value) {
    (void) value;
    return fail(decoder, WMA_ERROR_OPTION, key);
}

EMSCRIPTEN_KEEPALIVE
int audio_decoder_send(WMADecoder *decoder, uint32_t byte_length, double timestamp) {
    if (!decoder->opened) {
        av_packet_unref(decoder->packet);
        return fail(decoder, WMA_ERROR_UNCONFIGURED, byte_length);
    }
    if (decoder->packet->data == NULL || byte_length == 0 || byte_length > (uint32_t) decoder->packet->size) {
        return fail(decoder, WMA_ERROR_INPUT, byte_length);
    }
    decoder->packet->size = (int) byte_length;
    decoder->packet->pts = (int64_t) timestamp;
    decoder->packet->dts = (int64_t) timestamp;
    const int result = avcodec_send_packet(decoder->codec_context, decoder->packet);
    av_packet_unref(decoder->packet);
    if (result == 0) {
        return AUDIO_DECODER_SEND_ACCEPTED;
    }
    if (result == AVERROR_INVALIDDATA) {
        return AUDIO_DECODER_SEND_DROPPED;
    }
    return fail(decoder, WMA_ERROR_SEND, (uint32_t) -result);
}

/* Ends the stream: the frames the decoder held back follow from audio_decoder_receive. A second drain changes nothing */
EMSCRIPTEN_KEEPALIVE
int audio_decoder_drain(WMADecoder *decoder) {
    if (!decoder->opened) {
        return fail(decoder, WMA_ERROR_UNCONFIGURED, 0);
    }
    // FFmpeg reports a drain that already started as the end of the stream
    const int result = avcodec_send_packet(decoder->codec_context, NULL);
    if (result < 0 && result != AVERROR_EOF) {
        return fail(decoder, WMA_ERROR_SEND, (uint32_t) -result);
    }
    return AUDIO_DECODER_SUCCESS;
}

EMSCRIPTEN_KEEPALIVE
int audio_decoder_receive(WMADecoder *decoder) {
    av_frame_unref(decoder->frame);
    if (!decoder->opened) {
        return AUDIO_DECODER_RECEIVE_NONE;
    }
    const int result = avcodec_receive_frame(decoder->codec_context, decoder->frame);
    if (result == AVERROR(EAGAIN) || result == AVERROR_EOF || result == AVERROR_INVALIDDATA) {
        return AUDIO_DECODER_RECEIVE_NONE;
    }
    if (result < 0) {
        return fail(decoder, WMA_ERROR_RECEIVE, (uint32_t) -result);
    }
    if (convert_frame(decoder) != AUDIO_DECODER_SUCCESS) {
        return AUDIO_DECODER_FAILED;
    }
    return AUDIO_DECODER_RECEIVE_READY;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_frame_count(WMADecoder *decoder) {
    return (uint32_t) decoder->frame->nb_samples;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_sample_rate(WMADecoder *decoder) {
    return (uint32_t) decoder->frame->sample_rate;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_channel_count(WMADecoder *decoder) {
    return (uint32_t) decoder->frame->ch_layout.nb_channels;
}

/* The WAVE channel mask of a native-order layout, or for a layout without one, FFmpeg's default layout of its channel count */
EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_channel_mask(WMADecoder *decoder) {
    const AVChannelLayout *layout = &decoder->frame->ch_layout;
    if (layout->order == AV_CHANNEL_ORDER_NATIVE && (layout->u.mask >> 32) == 0) {
        return (uint32_t) layout->u.mask;
    }
    AVChannelLayout default_layout;
    av_channel_layout_default(&default_layout, layout->nb_channels);
    if (default_layout.order != AV_CHANNEL_ORDER_NATIVE || (default_layout.u.mask >> 32) != 0) {
        return 0;
    }
    return (uint32_t) default_layout.u.mask;
}

EMSCRIPTEN_KEEPALIVE
float *audio_decoder_channel_pointer(WMADecoder *decoder, uint32_t channel) {
    if (channel >= (uint32_t) decoder->frame->ch_layout.nb_channels) {
        return NULL;
    }
    if (decoder->planes_in_frame) {
        return (float *) decoder->frame->extended_data[channel];
    }
    if (decoder->planes == NULL) {
        return NULL;
    }
    return decoder->planes + (size_t) channel * (size_t) decoder->frame->nb_samples;
}

EMSCRIPTEN_KEEPALIVE
double audio_decoder_timestamp(WMADecoder *decoder) {
    return decoder->frame->pts == AV_NOPTS_VALUE ? AUDIO_DECODER_NO_TIMESTAMP : (double) decoder->frame->pts;
}

EMSCRIPTEN_KEEPALIVE
double audio_decoder_attribute(WMADecoder *decoder, uint32_t key) {
    (void) decoder;
    switch (key) {
        case WMA_ATTRIBUTE_LIBRARY_VERSION:
            return (double) avcodec_version();
        default:
            return AUDIO_DECODER_NO_ATTRIBUTE;
    }
}

EMSCRIPTEN_KEEPALIVE
void audio_decoder_clear(WMADecoder *decoder) {
    av_packet_unref(decoder->packet);
    av_frame_unref(decoder->frame);
    if (decoder->opened) {
        avcodec_flush_buffers(decoder->codec_context);
    }
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_error_code(WMADecoder *decoder) {
    return decoder->error_code;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_error_value(WMADecoder *decoder) {
    return decoder->error_value;
}
