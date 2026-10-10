/*
 * FFmpeg decoder bridge for HEVC Main and Main 10.
 */

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>

#include "libavcodec/avcodec.h"
#include "libavutil/avutil.h"
#include "libavutil/frame.h"
#include "libavutil/mem.h"
#include "libavutil/pixfmt.h"

#define MAXIMUM_EXTRADATA_SIZE (1024 * 1024)
#define MICROSECONDS_PER_SECOND 1000000
#define PLANE_COUNT 3

typedef struct HEVCDecoderContext {
    AVCodecContext *codec_context;
    AVPacket *packet;
    AVFrame *frame;
    int opened;
    int draining;
} HEVCDecoderContext;

static void free_decoder(HEVCDecoderContext *decoder) {
    if (!decoder) {
        return;
    }

    av_frame_free(&decoder->frame);
    av_packet_free(&decoder->packet);
    avcodec_free_context(&decoder->codec_context);
    free(decoder);
}

/*
 * Creates an unopened decoder.
 * Extradata, when there is any, is an HEVCDecoderConfigurationRecord that the caller writes before opening, and its packets are length-prefixed.
 * Without extradata the packets are Annex B.
 */
EMSCRIPTEN_KEEPALIVE
HEVCDecoderContext *hevc_decoder_create(int extradata_size) {
    if (extradata_size < 0 || extradata_size > MAXIMUM_EXTRADATA_SIZE) {
        return NULL;
    }

    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_HEVC);
    if (!codec) {
        return NULL;
    }

    HEVCDecoderContext *decoder = calloc(1, sizeof(HEVCDecoderContext));
    if (!decoder) {
        return NULL;
    }

    decoder->codec_context = avcodec_alloc_context3(codec);
    decoder->packet = av_packet_alloc();
    decoder->frame = av_frame_alloc();
    if (!decoder->codec_context || !decoder->packet || !decoder->frame) {
        free_decoder(decoder);
        return NULL;
    }

    decoder->codec_context->pkt_timebase = (AVRational) { 1, MICROSECONDS_PER_SECOND };
    decoder->codec_context->thread_count = 1;
    // Crops to the conformance window exactly, even where the cropped planes start unaligned
    decoder->codec_context->flags |= AV_CODEC_FLAG_UNALIGNED;
    if (extradata_size > 0) {
        decoder->codec_context->extradata = av_mallocz(
            extradata_size + AV_INPUT_BUFFER_PADDING_SIZE
        );
        if (!decoder->codec_context->extradata) {
            free_decoder(decoder);
            return NULL;
        }
        decoder->codec_context->extradata_size = extradata_size;
    }

    return decoder;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *hevc_decoder_get_extradata(HEVCDecoderContext *decoder) {
    if (!decoder || !decoder->codec_context || decoder->opened) {
        return NULL;
    }
    return decoder->codec_context->extradata;
}

EMSCRIPTEN_KEEPALIVE
int hevc_decoder_open(HEVCDecoderContext *decoder) {
    if (!decoder || !decoder->codec_context || decoder->opened) {
        return AVERROR(EINVAL);
    }

    int result = avcodec_open2(decoder->codec_context, decoder->codec_context->codec, NULL);
    if (result >= 0) {
        decoder->opened = 1;
    }
    return result;
}

/* Allocates the next packet and returns its data for the caller to fill. */
EMSCRIPTEN_KEEPALIVE
uint8_t *hevc_decoder_configure_packet(HEVCDecoderContext *decoder, int packet_size) {
    if (!decoder || !decoder->opened || decoder->draining || packet_size <= 0) {
        return NULL;
    }

    av_packet_unref(decoder->packet);
    if (av_new_packet(decoder->packet, packet_size) < 0) {
        return NULL;
    }
    return decoder->packet->data;
}

/* Sends the configured packet; its timestamp and duration return with the frame it codes. */
EMSCRIPTEN_KEEPALIVE
int hevc_decoder_send_packet(
    HEVCDecoderContext *decoder,
    int64_t presentation_timestamp,
    int64_t duration
) {
    if (!decoder || !decoder->opened || decoder->draining) {
        return AVERROR(EINVAL);
    }

    decoder->packet->pts = presentation_timestamp;
    decoder->packet->dts = AV_NOPTS_VALUE;
    decoder->packet->duration = duration;
    int result = avcodec_send_packet(decoder->codec_context, decoder->packet);
    av_packet_unref(decoder->packet);
    return result;
}

EMSCRIPTEN_KEEPALIVE
int hevc_decoder_start_drain(HEVCDecoderContext *decoder) {
    if (!decoder || !decoder->opened) {
        return AVERROR(EINVAL);
    }
    if (decoder->draining) {
        return 0;
    }

    int result = avcodec_send_packet(decoder->codec_context, NULL);
    if (result >= 0 || result == AVERROR_EOF) {
        decoder->draining = 1;
    }
    return result;
}

EMSCRIPTEN_KEEPALIVE
int hevc_decoder_receive_frame(HEVCDecoderContext *decoder) {
    if (!decoder || !decoder->opened) {
        return AVERROR(EINVAL);
    }

    av_frame_unref(decoder->frame);
    return avcodec_receive_frame(decoder->codec_context, decoder->frame);
}

/* Discards held pictures and ends a drain, so decoding resumes at the next random-access point with the parameter sets it already has. */
EMSCRIPTEN_KEEPALIVE
void hevc_decoder_reset(HEVCDecoderContext *decoder) {
    if (!decoder || !decoder->opened) {
        return;
    }

    av_frame_unref(decoder->frame);
    avcodec_flush_buffers(decoder->codec_context);
    decoder->draining = 0;
}

/* Returns the received frame's bit depth when it is 4:2:0 at 8 or 10 bits, the formats of Main and Main 10, and 0 otherwise. */
EMSCRIPTEN_KEEPALIVE
int hevc_decoder_get_bit_depth(HEVCDecoderContext *decoder) {
    if (!decoder || !decoder->frame) {
        return 0;
    }
    switch (decoder->frame->format) {
        case AV_PIX_FMT_YUV420P:
            return 8;
        case AV_PIX_FMT_YUV420P10:
            return 10;
        default:
            return 0;
    }
}

EMSCRIPTEN_KEEPALIVE
uint8_t *hevc_decoder_get_plane(HEVCDecoderContext *decoder, int plane) {
    if (!decoder || !decoder->frame || plane < 0 || plane >= PLANE_COUNT) {
        return NULL;
    }
    return decoder->frame->data[plane];
}

/* Returns a plane's row stride in bytes. */
EMSCRIPTEN_KEEPALIVE
int hevc_decoder_get_stride(HEVCDecoderContext *decoder, int plane) {
    if (!decoder || !decoder->frame || plane < 0 || plane >= PLANE_COUNT) {
        return 0;
    }
    return decoder->frame->linesize[plane];
}

EMSCRIPTEN_KEEPALIVE
int hevc_decoder_get_width(HEVCDecoderContext *decoder) {
    return decoder && decoder->frame ? decoder->frame->width : 0;
}

EMSCRIPTEN_KEEPALIVE
int hevc_decoder_get_height(HEVCDecoderContext *decoder) {
    return decoder && decoder->frame ? decoder->frame->height : 0;
}

EMSCRIPTEN_KEEPALIVE
int64_t hevc_decoder_get_timestamp(HEVCDecoderContext *decoder) {
    if (!decoder || !decoder->frame) {
        return AV_NOPTS_VALUE;
    }
    return decoder->frame->pts;
}

EMSCRIPTEN_KEEPALIVE
int64_t hevc_decoder_get_duration(HEVCDecoderContext *decoder) {
    if (!decoder || !decoder->frame) {
        return 0;
    }
    return decoder->frame->duration;
}

EMSCRIPTEN_KEEPALIVE
int hevc_decoder_error_again(void) {
    return AVERROR(EAGAIN);
}

EMSCRIPTEN_KEEPALIVE
int hevc_decoder_error_eof(void) {
    return AVERROR_EOF;
}

EMSCRIPTEN_KEEPALIVE
void hevc_decoder_close(HEVCDecoderContext *decoder) {
    free_decoder(decoder);
}
