/*
 * FFmpeg's MLP and TrueHD decoders behind version 1 of the engine's audio decoder interface.
 * truehd.manifest beside this file names the codecs, attributes, options, and error codes declared here.
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
enum TrueHDCodec {
    TRUEHD_CODEC_MLP = 0,
    TRUEHD_CODEC_TRUEHD = 1
};

/* The manifest's attribute keys */
enum TrueHDAttribute {
    TRUEHD_ATTRIBUTE_BITS_PER_SAMPLE = 1,
    TRUEHD_ATTRIBUTE_PROFILE = 2,
    TRUEHD_ATTRIBUTE_PCM_FINGERPRINT = 3,
    TRUEHD_ATTRIBUTE_LIBRARY_VERSION = 4
};

/* The manifest's option keys */
enum TrueHDOption {
    TRUEHD_OPTION_PCM_FINGERPRINT = 1
};

/* The manifest's error codes */
enum TrueHDError {
    TRUEHD_ERROR_INPUT = 1,
    TRUEHD_ERROR_SEND = 2,
    TRUEHD_ERROR_RECEIVE = 3,
    TRUEHD_ERROR_SAMPLE_FORMAT = 4,
    TRUEHD_ERROR_OPTION = 5,
    TRUEHD_ERROR_OUTPUT = 6
};

/* FNV-1a over the decoder's packed PCM bytes, which only an exact qualification reads */
#define FNV1A_OFFSET_BASIS 2166136261U
#define FNV1A_PRIME 16777619U

typedef struct TrueHDDecoder {
    AVCodecContext *codec_context;
    AVPacket *packet;
    AVFrame *frame;
    /* The received frame as planar float, one plane after another */
    float *planes;
    size_t plane_capacity;
    int computes_pcm_fingerprint;
    uint32_t pcm_fingerprint;
    uint32_t error_code;
    uint32_t error_value;
} TrueHDDecoder;

static int fail(TrueHDDecoder *decoder, uint32_t code, uint32_t value) {
    decoder->error_code = code;
    decoder->error_value = value;
    return AUDIO_DECODER_FAILED;
}

static void free_decoder(TrueHDDecoder *decoder) {
    av_frame_free(&decoder->frame);
    av_packet_free(&decoder->packet);
    avcodec_free_context(&decoder->codec_context);
    free(decoder->planes);
    free(decoder);
}

static enum AVCodecID get_codec_id(int codec) {
    switch (codec) {
        case TRUEHD_CODEC_MLP:
            return AV_CODEC_ID_MLP;
        case TRUEHD_CODEC_TRUEHD:
            return AV_CODEC_ID_TRUEHD;
        default:
            return AV_CODEC_ID_NONE;
    }
}

static uint32_t fingerprint_bytes(const uint8_t *bytes, size_t byte_length) {
    uint32_t fingerprint = FNV1A_OFFSET_BASIS;
    for (size_t index = 0; index < byte_length; index += 1) {
        fingerprint ^= bytes[index];
        fingerprint *= FNV1A_PRIME;
    }
    return fingerprint;
}

/*
 * Deinterleaves the received frame into planar float.
 * Each sample is scaled in double by the exact power-of-two reciprocal of full scale and then rounded to float once,
 * which is bit-identical to dividing by the full-scale value.
 */
static int convert_frame(TrueHDDecoder *decoder) {
    const AVFrame *frame = decoder->frame;
    const size_t channel_count = (size_t) frame->ch_layout.nb_channels;
    const size_t frame_count = (size_t) frame->nb_samples;
    const size_t sample_count = channel_count * frame_count;
    if (sample_count > decoder->plane_capacity) {
        float *planes = realloc(decoder->planes, sample_count * sizeof(float));
        if (planes == NULL) {
            return fail(decoder, TRUEHD_ERROR_OUTPUT, (uint32_t) sample_count);
        }
        decoder->planes = planes;
        decoder->plane_capacity = sample_count;
    }
    const int bytes_per_sample = av_get_bytes_per_sample(frame->format);
    if (decoder->computes_pcm_fingerprint) {
        decoder->pcm_fingerprint = fingerprint_bytes(frame->data[0], sample_count * (size_t) bytes_per_sample);
    }
    switch (frame->format) {
        case AV_SAMPLE_FMT_S16: {
            const int16_t *samples = (const int16_t *) frame->data[0];
            for (size_t frame_index = 0; frame_index < frame_count; frame_index += 1) {
                for (size_t channel = 0; channel < channel_count; channel += 1) {
                    decoder->planes[channel * frame_count + frame_index] = (float) ((double) samples[frame_index * channel_count + channel] * 0x1p-15);
                }
            }
            return AUDIO_DECODER_SUCCESS;
        }
        case AV_SAMPLE_FMT_S32: {
            const int32_t *samples = (const int32_t *) frame->data[0];
            for (size_t frame_index = 0; frame_index < frame_count; frame_index += 1) {
                for (size_t channel = 0; channel < channel_count; channel += 1) {
                    decoder->planes[channel * frame_count + frame_index] = (float) ((double) samples[frame_index * channel_count + channel] * 0x1p-31);
                }
            }
            return AUDIO_DECODER_SUCCESS;
        }
        default:
            return fail(decoder, TRUEHD_ERROR_SAMPLE_FORMAT, (uint32_t) frame->format);
    }
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_abi_version(void) {
    return AUDIO_DECODER_ABI_VERSION;
}

EMSCRIPTEN_KEEPALIVE
TrueHDDecoder *audio_decoder_create(int codec) {
    const enum AVCodecID codec_id = get_codec_id(codec);
    const AVCodec *codec_implementation = codec_id == AV_CODEC_ID_NONE ? NULL : avcodec_find_decoder(codec_id);
    if (codec_implementation == NULL) {
        return NULL;
    }
    av_log_set_level(AV_LOG_QUIET);

    TrueHDDecoder *decoder = calloc(1, sizeof(*decoder));
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
void audio_decoder_destroy(TrueHDDecoder *decoder) {
    if (decoder != NULL) {
        free_decoder(decoder);
    }
}

/* The packet buffer, with FFmpeg's input padding past it */
EMSCRIPTEN_KEEPALIVE
uint8_t *audio_decoder_reserve_input(TrueHDDecoder *decoder, uint32_t byte_length) {
    av_packet_unref(decoder->packet);
    if (byte_length == 0 || byte_length > INT32_MAX || av_new_packet(decoder->packet, (int) byte_length) < 0) {
        fail(decoder, TRUEHD_ERROR_INPUT, byte_length);
        return NULL;
    }
    return decoder->packet->data;
}

/* Neither codec takes codec private data */
EMSCRIPTEN_KEEPALIVE
int audio_decoder_configure(TrueHDDecoder *decoder, uint32_t byte_length) {
    (void) decoder;
    (void) byte_length;
    return AUDIO_DECODER_SUCCESS;
}

EMSCRIPTEN_KEEPALIVE
int audio_decoder_set_option(TrueHDDecoder *decoder, uint32_t key, double value) {
    switch (key) {
        case TRUEHD_OPTION_PCM_FINGERPRINT:
            decoder->computes_pcm_fingerprint = value != 0.0;
            return AUDIO_DECODER_SUCCESS;
        default:
            return fail(decoder, TRUEHD_ERROR_OPTION, key);
    }
}

EMSCRIPTEN_KEEPALIVE
int audio_decoder_send(TrueHDDecoder *decoder, uint32_t byte_length, double timestamp) {
    if (decoder->packet->data == NULL || byte_length == 0 || byte_length > (uint32_t) decoder->packet->size) {
        return fail(decoder, TRUEHD_ERROR_INPUT, byte_length);
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
    return fail(decoder, TRUEHD_ERROR_SEND, (uint32_t) -result);
}

EMSCRIPTEN_KEEPALIVE
int audio_decoder_receive(TrueHDDecoder *decoder) {
    av_frame_unref(decoder->frame);
    const int result = avcodec_receive_frame(decoder->codec_context, decoder->frame);
    if (result == AVERROR(EAGAIN) || result == AVERROR_EOF || result == AVERROR_INVALIDDATA) {
        return AUDIO_DECODER_RECEIVE_NONE;
    }
    if (result < 0) {
        return fail(decoder, TRUEHD_ERROR_RECEIVE, (uint32_t) -result);
    }
    if (convert_frame(decoder) != AUDIO_DECODER_SUCCESS) {
        return AUDIO_DECODER_FAILED;
    }
    return AUDIO_DECODER_RECEIVE_READY;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_frame_count(TrueHDDecoder *decoder) {
    return (uint32_t) decoder->frame->nb_samples;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_sample_rate(TrueHDDecoder *decoder) {
    return (uint32_t) decoder->frame->sample_rate;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_channel_count(TrueHDDecoder *decoder) {
    return (uint32_t) decoder->frame->ch_layout.nb_channels;
}

/* The WAVE channel mask of a native-order layout, or 0 for a layout without one */
EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_channel_mask(TrueHDDecoder *decoder) {
    const AVChannelLayout *layout = &decoder->frame->ch_layout;
    if (layout->order != AV_CHANNEL_ORDER_NATIVE || (layout->u.mask >> 32) != 0) {
        return 0;
    }
    return (uint32_t) layout->u.mask;
}

EMSCRIPTEN_KEEPALIVE
float *audio_decoder_channel_pointer(TrueHDDecoder *decoder, uint32_t channel) {
    if (decoder->planes == NULL || channel >= (uint32_t) decoder->frame->ch_layout.nb_channels) {
        return NULL;
    }
    return decoder->planes + (size_t) channel * (size_t) decoder->frame->nb_samples;
}

EMSCRIPTEN_KEEPALIVE
double audio_decoder_timestamp(TrueHDDecoder *decoder) {
    return decoder->frame->pts == AV_NOPTS_VALUE ? AUDIO_DECODER_NO_TIMESTAMP : (double) decoder->frame->pts;
}

EMSCRIPTEN_KEEPALIVE
double audio_decoder_attribute(TrueHDDecoder *decoder, uint32_t key) {
    switch (key) {
        case TRUEHD_ATTRIBUTE_BITS_PER_SAMPLE:
            return (double) decoder->codec_context->bits_per_raw_sample;
        case TRUEHD_ATTRIBUTE_PROFILE:
            return (double) decoder->codec_context->profile;
        case TRUEHD_ATTRIBUTE_PCM_FINGERPRINT:
            return decoder->computes_pcm_fingerprint ? (double) decoder->pcm_fingerprint : AUDIO_DECODER_NO_ATTRIBUTE;
        case TRUEHD_ATTRIBUTE_LIBRARY_VERSION:
            return (double) avcodec_version();
        default:
            return AUDIO_DECODER_NO_ATTRIBUTE;
    }
}

EMSCRIPTEN_KEEPALIVE
void audio_decoder_clear(TrueHDDecoder *decoder) {
    av_packet_unref(decoder->packet);
    av_frame_unref(decoder->frame);
    avcodec_flush_buffers(decoder->codec_context);
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_error_code(TrueHDDecoder *decoder) {
    return decoder->error_code;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_error_value(TrueHDDecoder *decoder) {
    return decoder->error_value;
}
