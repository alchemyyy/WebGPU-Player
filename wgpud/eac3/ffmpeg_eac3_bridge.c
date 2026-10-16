/*
 * FFmpeg's E-AC-3 and AC-3 decoders behind version 1 of the engine's audio decoder interface.
 * eac3.manifest beside this file names the codecs, attributes, and error codes declared here.
 */

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>

#include "libavcodec/avcodec.h"
#include "libavutil/channel_layout.h"
#include "libavutil/error.h"
#include "libavutil/log.h"
#include "libavutil/samplefmt.h"

#include "audio_decoder_interface.h"

/* The codecs in the manifest's `accepts:` order */
enum EAC3Codec {
    EAC3_CODEC_EAC3 = 0,
    EAC3_CODEC_AC3 = 1
};

/* The manifest's attribute keys */
enum EAC3Attribute {
    EAC3_ATTRIBUTE_LIBRARY_VERSION = 1
};

/* The manifest's error codes */
enum EAC3Error {
    EAC3_ERROR_INPUT = 1,
    EAC3_ERROR_SEND = 2,
    EAC3_ERROR_RECEIVE = 3,
    EAC3_ERROR_SAMPLE_FORMAT = 4,
    EAC3_ERROR_OPTION = 5
};

typedef struct EAC3Decoder {
    AVCodecContext *codec_context;
    AVPacket *packet;
    AVFrame *frame;
    uint32_t error_code;
    uint32_t error_value;
} EAC3Decoder;

static int fail(EAC3Decoder *decoder, uint32_t code, uint32_t value) {
    decoder->error_code = code;
    decoder->error_value = value;
    return AUDIO_DECODER_FAILED;
}

static void free_decoder(EAC3Decoder *decoder) {
    av_frame_free(&decoder->frame);
    av_packet_free(&decoder->packet);
    avcodec_free_context(&decoder->codec_context);
    free(decoder);
}

static enum AVCodecID get_codec_id(int codec) {
    switch (codec) {
        case EAC3_CODEC_EAC3:
            return AV_CODEC_ID_EAC3;
        case EAC3_CODEC_AC3:
            return AV_CODEC_ID_AC3;
        default:
            return AV_CODEC_ID_NONE;
    }
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_abi_version(void) {
    return AUDIO_DECODER_ABI_VERSION;
}

EMSCRIPTEN_KEEPALIVE
EAC3Decoder *audio_decoder_create(int codec) {
    const enum AVCodecID codec_id = get_codec_id(codec);
    const AVCodec *codec_implementation = codec_id == AV_CODEC_ID_NONE ? NULL : avcodec_find_decoder(codec_id);
    if (codec_implementation == NULL) {
        return NULL;
    }
    av_log_set_level(AV_LOG_QUIET);

    EAC3Decoder *decoder = calloc(1, sizeof(*decoder));
    if (decoder == NULL) {
        return NULL;
    }
    decoder->codec_context = avcodec_alloc_context3(codec_implementation);
    decoder->packet = av_packet_alloc();
    decoder->frame = av_frame_alloc();
    if (decoder->codec_context == NULL || decoder->packet == NULL || decoder->frame == NULL) {
        free_decoder(decoder);
        return NULL;
    }
    // Timestamps are integer microseconds
    decoder->codec_context->pkt_timebase = (AVRational) { 1, 1000000 };
    if (avcodec_open2(decoder->codec_context, codec_implementation, NULL) < 0) {
        free_decoder(decoder);
        return NULL;
    }
    return decoder;
}

EMSCRIPTEN_KEEPALIVE
void audio_decoder_destroy(EAC3Decoder *decoder) {
    if (decoder != NULL) {
        free_decoder(decoder);
    }
}

/* The packet buffer, with FFmpeg's input padding past it */
EMSCRIPTEN_KEEPALIVE
uint8_t *audio_decoder_reserve_input(EAC3Decoder *decoder, uint32_t byte_length) {
    av_packet_unref(decoder->packet);
    if (byte_length == 0 || byte_length > INT32_MAX || av_new_packet(decoder->packet, (int) byte_length) < 0) {
        fail(decoder, EAC3_ERROR_INPUT, byte_length);
        return NULL;
    }
    return decoder->packet->data;
}

/* Neither codec takes codec private data */
EMSCRIPTEN_KEEPALIVE
int audio_decoder_configure(EAC3Decoder *decoder, uint32_t byte_length) {
    (void) decoder;
    (void) byte_length;
    return AUDIO_DECODER_SUCCESS;
}

EMSCRIPTEN_KEEPALIVE
int audio_decoder_set_option(EAC3Decoder *decoder, uint32_t key, double value) {
    (void) value;
    return fail(decoder, EAC3_ERROR_OPTION, key);
}

EMSCRIPTEN_KEEPALIVE
int audio_decoder_send(EAC3Decoder *decoder, uint32_t byte_length, double timestamp) {
    if (decoder->packet->data == NULL || byte_length == 0 || byte_length > (uint32_t) decoder->packet->size) {
        return fail(decoder, EAC3_ERROR_INPUT, byte_length);
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
    return fail(decoder, EAC3_ERROR_SEND, (uint32_t) -result);
}

EMSCRIPTEN_KEEPALIVE
int audio_decoder_receive(EAC3Decoder *decoder) {
    av_frame_unref(decoder->frame);
    const int result = avcodec_receive_frame(decoder->codec_context, decoder->frame);
    if (result == AVERROR(EAGAIN) || result == AVERROR_EOF || result == AVERROR_INVALIDDATA) {
        return AUDIO_DECODER_RECEIVE_NONE;
    }
    if (result < 0) {
        return fail(decoder, EAC3_ERROR_RECEIVE, (uint32_t) -result);
    }
    // The decoders write planar float, which the interface hands over in place
    if (decoder->frame->format != AV_SAMPLE_FMT_FLTP) {
        return fail(decoder, EAC3_ERROR_SAMPLE_FORMAT, (uint32_t) decoder->frame->format);
    }
    return AUDIO_DECODER_RECEIVE_READY;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_frame_count(EAC3Decoder *decoder) {
    return (uint32_t) decoder->frame->nb_samples;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_sample_rate(EAC3Decoder *decoder) {
    return (uint32_t) decoder->frame->sample_rate;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_channel_count(EAC3Decoder *decoder) {
    return (uint32_t) decoder->frame->ch_layout.nb_channels;
}

/* The WAVE channel mask of a native-order layout, or 0 for a layout without one */
EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_channel_mask(EAC3Decoder *decoder) {
    const AVChannelLayout *layout = &decoder->frame->ch_layout;
    if (layout->order != AV_CHANNEL_ORDER_NATIVE || (layout->u.mask >> 32) != 0) {
        return 0;
    }
    return (uint32_t) layout->u.mask;
}

EMSCRIPTEN_KEEPALIVE
float *audio_decoder_channel_pointer(EAC3Decoder *decoder, uint32_t channel) {
    if (channel >= (uint32_t) decoder->frame->ch_layout.nb_channels) {
        return NULL;
    }
    return (float *) decoder->frame->extended_data[channel];
}

EMSCRIPTEN_KEEPALIVE
double audio_decoder_timestamp(EAC3Decoder *decoder) {
    return decoder->frame->pts == AV_NOPTS_VALUE ? AUDIO_DECODER_NO_TIMESTAMP : (double) decoder->frame->pts;
}

EMSCRIPTEN_KEEPALIVE
double audio_decoder_attribute(EAC3Decoder *decoder, uint32_t key) {
    (void) decoder;
    switch (key) {
        case EAC3_ATTRIBUTE_LIBRARY_VERSION:
            return (double) avcodec_version();
        default:
            return AUDIO_DECODER_NO_ATTRIBUTE;
    }
}

EMSCRIPTEN_KEEPALIVE
void audio_decoder_clear(EAC3Decoder *decoder) {
    av_packet_unref(decoder->packet);
    av_frame_unref(decoder->frame);
    avcodec_flush_buffers(decoder->codec_context);
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_error_code(EAC3Decoder *decoder) {
    return decoder->error_code;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_error_value(EAC3Decoder *decoder) {
    return decoder->error_value;
}
