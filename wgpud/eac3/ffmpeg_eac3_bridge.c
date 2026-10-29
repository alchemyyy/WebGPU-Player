/*
 * FFmpeg's E-AC-3 and AC-3 decoders behind version 1 of the engine's audio decoder interface, with the Dolby Atmos objects of
 * E-AC-3 with joint object coding (JOC, ETSI TS 103 420) rendered to the playback's output layout or to binaural stereo.
 * eac3.manifest beside this file names the codecs, options, attributes, and error codes declared here.
 *
 * Stock first: every block is FFmpeg's unchanged decode, unless the engine set a render target (renderChannelMask, renderBinaural)
 * that the decoded channels do not already hold, binaural, or a layout with a speaker the stream's core lacks, and the stream's
 * syncframes carry JOC and object audio metadata (OAMD). Then the module rebuilds the objects (eac3_joc.c) from the decoded
 * channels and renders them with the OAMD (wgpud/atmos/) into the target's layout.
 *
 * Object blocks keep their packets' timestamps exactly: the filter bank delays objects by 577 samples and binaural rendering
 * by its latency, so an object block leaves the module once the frames after it have filled that delay. The first packet
 * after a start, a seek, or a switch from stock blocks therefore outputs no block, the next one outputs the first one's, and
 * audio_decoder_drain, which the engine calls at the end of a track, outputs the last ones.
 */

#include <emscripten.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "libavcodec/ac3_parser_internal.h"
#include "libavcodec/avcodec.h"
#include "libavutil/channel_layout.h"
#include "libavutil/error.h"
#include "libavutil/frame.h"
#include "libavutil/log.h"
#include "libavutil/mem.h"
#include "libavutil/samplefmt.h"

#include "atmos.h"
#include "audio_decoder_interface.h"
#include "eac3_emdf.h"
#include "eac3_joc.h"

/* The codecs in the manifest's `accepts:` order */
enum EAC3Codec {
    EAC3_CODEC_EAC3 = 0,
    EAC3_CODEC_AC3 = 1
};

/* The manifest's option keys */
enum EAC3Option {
    EAC3_OPTION_RENDER_CHANNEL_MASK = 1,
    EAC3_OPTION_RENDER_BINAURAL = 2
};

/* The manifest's attribute keys */
enum EAC3Attribute {
    EAC3_ATTRIBUTE_LIBRARY_VERSION = 1,
    EAC3_ATTRIBUTE_OBJECT_COUNT = 2
};

/* The manifest's error codes */
enum EAC3Error {
    EAC3_ERROR_INPUT = 1,
    EAC3_ERROR_SEND = 2,
    EAC3_ERROR_RECEIVE = 3,
    EAC3_ERROR_SAMPLE_FORMAT = 4,
    EAC3_ERROR_OPTION = 5,
    EAC3_ERROR_OUTPUT = 6
};

/* E-AC-3 syncframes are 256 samples per audio block, at most six blocks */
#define MAX_FRAME_COUNT 1536
/* The access units, an independent syncframe with its dependent ones, a packet may carry with their payloads */
#define ACCESS_UNIT_QUEUE_LENGTH 32
/* Blocks waiting for audio_decoder_receive: a frame outputs at most a held object block, a held one finished early, and its own */
#define BLOCK_QUEUE_LENGTH 8
/* Samples a FIFO of the object pipeline holds: the filter bank delay, the binaural latency, and a frame, with room to spare */
#define FIFO_LENGTH 4096
/* A frame of silence finishes the held object blocks at a drain; a few cover any delay */
#define MAX_FLUSH_FRAMES 4

/* One access unit of a packet, with the object audio payloads of its EMDF container */
typedef struct AccessUnit {
    uint32_t frame_count;
    uint32_t sample_rate;
    int64_t timestamp;
    int found;
    EAC3AtmosPayloads payloads;
} AccessUnit;

/* One block for audio_decoder_receive: FFmpeg's frame, or planes the renderer wrote */
typedef struct Block {
    AVFrame *frame;
    float *planes;
    uint32_t frame_count;
    uint32_t channel_count;
    uint32_t channel_mask;
    uint32_t sample_rate;
    uint32_t object_count;
    double timestamp;
} Block;

/* An object block waiting for its samples: where it starts on the pipeline's timeline, its length, and its packet time */
typedef struct PendingBlock {
    int64_t start;
    uint32_t frame_count;
    int64_t timestamp;
} PendingBlock;

/* Rebuilds and renders objects; its timeline counts samples from the first frame it took */
typedef struct ObjectPipeline {
    int active;
    uint32_t sample_rate;
    uint32_t target_mask;
    int binaural;
    /* The core's layout when the pipeline started; another one stops it */
    uint64_t core_mask;
    /* The JOC downmix configuration when the pipeline started; another one restarts it */
    uint8_t downmix;
    uint32_t latency;
    uint32_t object_count;
    AtmosRenderer *renderer;
    EAC3JOCDecoder joc;
    /* The last JOC frame and OAMD payload parsed */
    EAC3JOCFrame joc_frame;
    AtmosMetadata metadata;
    /* Per scene object: its JOC object, -1 for the LFE, which the core holds, or -2 for none */
    int scene_sources[ATMOS_MAX_OBJECTS];
    uint32_t scene_object_count;
    /* The next frame's start, and the filter bank delay samples still to drop from the objects */
    int64_t next_start;
    uint32_t delay_to_drop;
    /* Objects and the LFE on the timeline from their start, the rendered output from its start */
    int64_t objects_start;
    uint32_t objects_length;
    int64_t lfe_start;
    uint32_t lfe_length;
    int64_t output_start;
    uint32_t output_length;
    float objects[EAC3_JOC_MAX_OBJECTS][FIFO_LENGTH];
    float lfe[FIFO_LENGTH];
    float output[ATMOS_MAX_CHANNELS][FIFO_LENGTH];
    float frame_objects[EAC3_JOC_MAX_OBJECTS][MAX_FRAME_COUNT];
    PendingBlock pending[BLOCK_QUEUE_LENGTH];
    uint32_t pending_count;
} ObjectPipeline;

typedef struct EAC3Decoder {
    AVCodecContext *codec_context;
    AVPacket *packet;
    AVFrame *frame;
    AC3HeaderInfo *header;
    uint32_t error_code;
    uint32_t error_value;
    /* The options: a WAVE channel mask, 0 before the engine sets one, and binaural rendering */
    uint32_t render_mask;
    int render_binaural;
    AccessUnit access_units[ACCESS_UNIT_QUEUE_LENGTH];
    uint32_t access_unit_head;
    uint32_t access_unit_count;
    Block blocks[BLOCK_QUEUE_LENGTH];
    uint32_t block_head;
    uint32_t block_count;
    /* The block audio_decoder_receive last returned, which the frame and channel calls read */
    Block current;
    int has_current;
    ObjectPipeline *pipeline;
} EAC3Decoder;

static int fail(EAC3Decoder *decoder, uint32_t code, uint32_t value) {
    decoder->error_code = code;
    decoder->error_value = value;
    return AUDIO_DECODER_FAILED;
}

static void release_block(Block *block) {
    if (block->frame != NULL) {
        av_frame_unref(block->frame);
    }
}

static void free_decoder(EAC3Decoder *decoder) {
    for (int i = 0; i < BLOCK_QUEUE_LENGTH; i++) {
        av_frame_free(&decoder->blocks[i].frame);
        free(decoder->blocks[i].planes);
    }
    av_frame_free(&decoder->current.frame);
    free(decoder->current.planes);
    if (decoder->pipeline != NULL) {
        atmos_renderer_destroy(decoder->pipeline->renderer);
        free(decoder->pipeline);
    }
    av_freep(&decoder->header);
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

/* Math.round of the engine's audioFramesToMicroseconds */
static int64_t frames_to_microseconds(int64_t frame_count, uint32_t sample_rate) {
    return (int64_t) floor((double) frame_count * 1000000.0 / sample_rate + 0.5);
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
    decoder->current.frame = av_frame_alloc();
    decoder->current.planes = malloc(sizeof(float) * ATMOS_MAX_CHANNELS * MAX_FRAME_COUNT);
    int allocated = decoder->codec_context != NULL && decoder->packet != NULL && decoder->frame != NULL
        && decoder->current.frame != NULL && decoder->current.planes != NULL;
    for (int i = 0; i < BLOCK_QUEUE_LENGTH; i++) {
        decoder->blocks[i].frame = av_frame_alloc();
        decoder->blocks[i].planes = malloc(sizeof(float) * ATMOS_MAX_CHANNELS * MAX_FRAME_COUNT);
        allocated = allocated && decoder->blocks[i].frame != NULL && decoder->blocks[i].planes != NULL;
    }
    if (!allocated) {
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
    switch (key) {
        case EAC3_OPTION_RENDER_CHANNEL_MASK:
            if (!(value >= 0.0 && value <= (double) UINT32_MAX) || value != floor(value)) {
                return fail(decoder, EAC3_ERROR_OPTION, key);
            }
            decoder->render_mask = (uint32_t) value;
            return AUDIO_DECODER_SUCCESS;
        case EAC3_OPTION_RENDER_BINAURAL:
            if (value != 0.0 && value != 1.0) {
                return fail(decoder, EAC3_ERROR_OPTION, key);
            }
            decoder->render_binaural = value == 1.0;
            return AUDIO_DECODER_SUCCESS;
        default:
            return fail(decoder, EAC3_ERROR_OPTION, key);
    }
}

/* Whether the options ask for anything a decode may lack, which is when the module looks for object audio */
static int render_target_set(const EAC3Decoder *decoder) {
    return decoder->render_binaural || decoder->render_mask != 0;
}

/*
 * Splits a packet into access units as FFmpeg's decoder takes them: an independent syncframe of substream 0, or an AC-3 one,
 * with the dependent syncframes right after it. Other substreams FFmpeg skips, so they start none.
 */
static void queue_access_units(EAC3Decoder *decoder, const uint8_t *data, uint32_t byte_length, int64_t timestamp) {
    decoder->access_unit_head = 0;
    decoder->access_unit_count = 0;
    const int find_payloads = render_target_set(decoder);
    uint32_t position = 0;
    int64_t preceding_frames = 0;
    while (position < byte_length && decoder->access_unit_count < ACCESS_UNIT_QUEUE_LENGTH) {
        if (avpriv_ac3_parse_header(&decoder->header, data + position, byte_length - position) < 0
                || decoder->header->frame_size == 0 || decoder->header->frame_size > byte_length - position) {
            return;
        }
        const AC3HeaderInfo *header = decoder->header;
        const uint32_t start = position;
        position += header->frame_size;
        if (header->frame_type == EAC3_FRAME_TYPE_DEPENDENT || header->substreamid != 0) {
            continue;
        }
        AccessUnit *unit = &decoder->access_units[decoder->access_unit_count++];
        unit->frame_count = (uint32_t) header->num_blocks * 256;
        unit->sample_rate = header->sample_rate;
        unit->timestamp = timestamp + frames_to_microseconds(preceding_frames, header->sample_rate);
        unit->found = 0;
        preceding_frames += unit->frame_count;
        // The dependent syncframes, the last of which carries the container (TS 103 420 clause 8.2)
        uint32_t frame_starts[16] = { start };
        uint32_t frame_sizes[16] = { header->frame_size };
        int frame_count = 1;
        while (position < byte_length && frame_count < 16
                && avpriv_ac3_parse_header(&decoder->header, data + position, byte_length - position) >= 0
                && decoder->header->frame_type == EAC3_FRAME_TYPE_DEPENDENT
                && decoder->header->frame_size != 0 && decoder->header->frame_size <= byte_length - position) {
            frame_starts[frame_count] = position;
            frame_sizes[frame_count++] = decoder->header->frame_size;
            position += decoder->header->frame_size;
        }
        for (int i = frame_count - 1; find_payloads && i >= 0 && !unit->found; i--) {
            unit->found = eac3_find_atmos_payloads(data + frame_starts[i], frame_sizes[i], &unit->payloads);
        }
    }
}

EMSCRIPTEN_KEEPALIVE
int audio_decoder_send(EAC3Decoder *decoder, uint32_t byte_length, double timestamp) {
    if (decoder->packet->data == NULL || byte_length == 0 || byte_length > (uint32_t) decoder->packet->size) {
        return fail(decoder, EAC3_ERROR_INPUT, byte_length);
    }
    decoder->packet->size = (int) byte_length;
    decoder->packet->pts = (int64_t) timestamp;
    decoder->packet->dts = (int64_t) timestamp;
    queue_access_units(decoder, decoder->packet->data, byte_length, (int64_t) timestamp);
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

/* The next free block of the queue, holding no frame */
static Block *push_block(EAC3Decoder *decoder) {
    if (decoder->block_count == BLOCK_QUEUE_LENGTH) {
        return NULL;
    }
    Block *block = &decoder->blocks[(decoder->block_head + decoder->block_count++) % BLOCK_QUEUE_LENGTH];
    av_frame_unref(block->frame);
    block->object_count = 0;
    return block;
}

/*
 * Queues FFmpeg's frame as a block. FFmpeg gives only a packet's first frame its timestamp, so a later one takes its access unit's:
 * the engine would count it from the packet's timestamp past every block of the packet, object blocks a flush finished included.
 */
static int push_stock_block(EAC3Decoder *decoder, AVFrame *frame, const AccessUnit *unit) {
    Block *block = push_block(decoder);
    if (block == NULL) {
        return fail(decoder, EAC3_ERROR_OUTPUT, BLOCK_QUEUE_LENGTH);
    }
    av_frame_move_ref(block->frame, frame);
    const AVChannelLayout *layout = &block->frame->ch_layout;
    block->frame_count = (uint32_t) block->frame->nb_samples;
    block->channel_count = (uint32_t) layout->nb_channels;
    // The WAVE channel mask of a native-order layout, or 0 for a layout without one
    block->channel_mask = layout->order == AV_CHANNEL_ORDER_NATIVE && (layout->u.mask >> 32) == 0 ? (uint32_t) layout->u.mask : 0;
    block->sample_rate = (uint32_t) block->frame->sample_rate;
    block->timestamp = block->frame->pts != AV_NOPTS_VALUE ? (double) block->frame->pts
        : unit != NULL ? (double) unit->timestamp : AUDIO_DECODER_NO_TIMESTAMP;
    return AUDIO_DECODER_SUCCESS;
}

/* The downmix channels of a JOC configuration in a decoded frame, and its LFE; 0 when the frame lacks one of them */
static int find_inputs(const AVFrame *frame, int downmix, int channel_count, const float **inputs, const float **lfe) {
    const AVChannelLayout *layout = &frame->ch_layout;
    const int has_side = av_channel_layout_index_from_channel(layout, AV_CHAN_SIDE_LEFT) >= 0;
    for (int i = 0; i < channel_count; i++) {
        enum AVChannel channel;
        switch (eac3_joc_input_channel(downmix, i)) {
            case EAC3_JOC_LEFT: channel = AV_CHAN_FRONT_LEFT; break;
            case EAC3_JOC_RIGHT: channel = AV_CHAN_FRONT_RIGHT; break;
            case EAC3_JOC_CENTRE: channel = AV_CHAN_FRONT_CENTER; break;
            // A 5.1 core's surrounds are FFmpeg's side channels, or its back ones in a back layout
            case EAC3_JOC_LEFT_SURROUND: channel = has_side ? AV_CHAN_SIDE_LEFT : AV_CHAN_BACK_LEFT; break;
            case EAC3_JOC_RIGHT_SURROUND: channel = has_side ? AV_CHAN_SIDE_RIGHT : AV_CHAN_BACK_RIGHT; break;
            case EAC3_JOC_LEFT_BACK: channel = has_side ? AV_CHAN_BACK_LEFT : AV_CHAN_NONE; break;
            case EAC3_JOC_RIGHT_BACK: channel = has_side ? AV_CHAN_BACK_RIGHT : AV_CHAN_NONE; break;
            case EAC3_JOC_TOP_FRONT_LEFT: channel = AV_CHAN_TOP_FRONT_LEFT; break;
            default: channel = AV_CHAN_TOP_FRONT_RIGHT; break;
        }
        const int index = channel == AV_CHAN_NONE ? -1 : av_channel_layout_index_from_channel(layout, channel);
        if (index < 0) {
            return 0;
        }
        inputs[i] = (const float *) frame->extended_data[index];
    }
    const int lfe_index = av_channel_layout_index_from_channel(layout, AV_CHAN_LOW_FREQUENCY);
    *lfe = lfe_index >= 0 ? (const float *) frame->extended_data[lfe_index] : NULL;
    return 1;
}

/* Maps the scene's objects to their signals: each LFE bed to the core's LFE, the others in order to the JOC objects */
static void map_scene(ObjectPipeline *pipeline, const AtmosScene *scene, uint32_t joc_object_count) {
    uint32_t next_object = 0;
    pipeline->object_count = 0;
    pipeline->scene_object_count = scene->object_count;
    for (uint32_t i = 0; i < scene->object_count; i++) {
        if (scene->kind[i] == ATMOS_OBJECT_BED && scene->bed_channel[i] == ATMOS_CHANNEL_LOW_FREQUENCY) {
            pipeline->scene_sources[i] = -1;
        } else if (next_object < joc_object_count) {
            pipeline->scene_sources[i] = (int) next_object++;
            pipeline->object_count += scene->kind[i] == ATMOS_OBJECT_DYNAMIC;
        } else {
            pipeline->scene_sources[i] = -2;
        }
    }
}

/* Drops the samples before a position from the front of a FIFO's planes */
static void advance_fifo(float *planes, int plane_count, int64_t *start, uint32_t *length, int64_t position) {
    if (position <= *start) {
        return;
    }
    const uint32_t dropped = position - *start >= *length ? *length : (uint32_t) (position - *start);
    for (int plane = 0; plane < plane_count; plane++) {
        float *samples = planes + (size_t) plane * FIFO_LENGTH;
        memmove(samples, samples + dropped, sizeof(float) * (*length - dropped));
    }
    *start += dropped;
    *length -= dropped;
}

/* Renders the pipeline's timeline up to a position, as far as the objects and the LFE reach */
static int render_until(ObjectPipeline *pipeline, int64_t position) {
    const int64_t rendered = pipeline->output_start + pipeline->output_length;
    int64_t end = position;
    if (end > pipeline->objects_start + pipeline->objects_length) {
        end = pipeline->objects_start + pipeline->objects_length;
    }
    if (end > pipeline->lfe_start + pipeline->lfe_length) {
        end = pipeline->lfe_start + pipeline->lfe_length;
    }
    if (end <= rendered) {
        return 0;
    }
    if (pipeline->output_length + (end - rendered) > FIFO_LENGTH) {
        return -1;
    }
    // The renderer reads as many planes as its scene has objects; one it took that this pipeline has not mapped stays silent
    const float *planes[ATMOS_MAX_OBJECTS] = { NULL };
    for (uint32_t i = 0; i < pipeline->scene_object_count; i++) {
        const int source = pipeline->scene_sources[i];
        planes[i] = source == -1 ? pipeline->lfe + (rendered - pipeline->lfe_start)
            : source >= 0 ? pipeline->objects[source] + (rendered - pipeline->objects_start) : NULL;
    }
    float *output[ATMOS_MAX_CHANNELS];
    for (uint32_t channel = 0; channel < ATMOS_MAX_CHANNELS; channel++) {
        output[channel] = pipeline->output[channel] + pipeline->output_length;
    }
    if (atmos_renderer_render(pipeline->renderer, planes, (uint32_t) (end - rendered), output) != ATMOS_OK) {
        return -1;
    }
    pipeline->output_length += (uint32_t) (end - rendered);
    // The objects and the LFE before the rendered position are spent
    advance_fifo(&pipeline->objects[0][0], EAC3_JOC_MAX_OBJECTS, &pipeline->objects_start, &pipeline->objects_length, end);
    advance_fifo(pipeline->lfe, 1, &pipeline->lfe_start, &pipeline->lfe_length, end);
    return 0;
}

/* Outputs every held object block whose samples the renderer has, or can now render */
static int emit_object_blocks(EAC3Decoder *decoder) {
    ObjectPipeline *pipeline = decoder->pipeline;
    const uint32_t channel_count = atmos_renderer_channel_count(pipeline->renderer);
    while (pipeline->pending_count > 0) {
        const PendingBlock pending = pipeline->pending[0];
        // A rendered sample leaves the renderer its latency later
        const int64_t output_from = pending.start + pipeline->latency;
        const int64_t output_end = output_from + pending.frame_count;
        if (render_until(pipeline, output_end) < 0) {
            return fail(decoder, EAC3_ERROR_OUTPUT, 0);
        }
        if (pipeline->output_start + pipeline->output_length < output_end) {
            return AUDIO_DECODER_SUCCESS;
        }
        memmove(pipeline->pending, pipeline->pending + 1, sizeof(PendingBlock) * --pipeline->pending_count);
        // A block reports no negative time, so the part of one before zero is dropped
        uint32_t skipped = 0;
        int64_t timestamp = pending.timestamp;
        if (timestamp < 0) {
            const double skip = ceil((double) -timestamp * pipeline->sample_rate / 1000000.0);
            skipped = skip >= pending.frame_count ? pending.frame_count : (uint32_t) skip;
            timestamp += frames_to_microseconds(skipped, pipeline->sample_rate);
        }
        if (skipped < pending.frame_count) {
            Block *block = push_block(decoder);
            if (block == NULL) {
                return fail(decoder, EAC3_ERROR_OUTPUT, BLOCK_QUEUE_LENGTH);
            }
            block->frame_count = pending.frame_count - skipped;
            block->channel_count = channel_count;
            block->channel_mask = atmos_renderer_channel_mask(pipeline->renderer);
            block->sample_rate = pipeline->sample_rate;
            block->object_count = pipeline->object_count;
            block->timestamp = (double) (timestamp < 0 ? 0 : timestamp);
            const int64_t offset = output_from + skipped - pipeline->output_start;
            for (uint32_t channel = 0; channel < channel_count; channel++) {
                memcpy(block->planes + (size_t) channel * block->frame_count, pipeline->output[channel] + offset,
                    sizeof(float) * block->frame_count);
            }
        }
        advance_fifo(&pipeline->output[0][0], ATMOS_MAX_CHANNELS, &pipeline->output_start, &pipeline->output_length, output_end);
    }
    return AUDIO_DECODER_SUCCESS;
}

/*
 * Takes one frame into the pipeline: its objects, rebuilt from its downmix channels (all zero for a flush), its LFE, and its OAMD.
 * A null JOC frame keeps the last matrices; a null metadata keeps the objects' properties.
 */
static int feed_pipeline(EAC3Decoder *decoder, const EAC3JOCFrame *joc, const float *const *inputs, const float *lfe,
        uint32_t frame_count, const AtmosMetadata *metadata, uint32_t metadata_offset) {
    ObjectPipeline *pipeline = decoder->pipeline;
    float *objects[EAC3_JOC_MAX_OBJECTS];
    for (int i = 0; i < EAC3_JOC_MAX_OBJECTS; i++) {
        objects[i] = pipeline->frame_objects[i];
    }
    const int object_count = eac3_joc_decode(&pipeline->joc, joc, inputs, (int) (frame_count / EAC3_QMF_BANDS), objects);
    for (int i = object_count; i < EAC3_JOC_MAX_OBJECTS; i++) {
        memset(objects[i], 0, sizeof(float) * frame_count);
    }
    // The objects lag the downmix by the filter bank delay: their first samples belong before the pipeline's start
    const uint32_t dropped = pipeline->delay_to_drop < frame_count ? pipeline->delay_to_drop : frame_count;
    pipeline->delay_to_drop -= dropped;
    const uint32_t kept = frame_count - dropped;
    if (pipeline->objects_length + kept > FIFO_LENGTH || pipeline->lfe_length + frame_count > FIFO_LENGTH) {
        return fail(decoder, EAC3_ERROR_OUTPUT, 0);
    }
    for (int i = 0; i < EAC3_JOC_MAX_OBJECTS; i++) {
        memcpy(pipeline->objects[i] + pipeline->objects_length, objects[i] + dropped, sizeof(float) * kept);
    }
    pipeline->objects_length += kept;
    if (lfe != NULL) {
        memcpy(pipeline->lfe + pipeline->lfe_length, lfe, sizeof(float) * frame_count);
    } else {
        memset(pipeline->lfe + pipeline->lfe_length, 0, sizeof(float) * frame_count);
    }
    pipeline->lfe_length += frame_count;
    if (metadata != NULL) {
        const int64_t rendered = pipeline->output_start + pipeline->output_length;
        if (atmos_renderer_add_metadata(pipeline->renderer, metadata,
                (int32_t) (pipeline->next_start + metadata_offset - rendered)) == ATMOS_OK) {
            map_scene(pipeline, &metadata->scene, pipeline->joc.object_count);
        }
    }
    pipeline->next_start += frame_count;
    return AUDIO_DECODER_SUCCESS;
}

/* Finishes the held object blocks with silence after the last frame, and stops the pipeline */
static int stop_pipeline(EAC3Decoder *decoder) {
    ObjectPipeline *pipeline = decoder->pipeline;
    if (pipeline == NULL || !pipeline->active) {
        return AUDIO_DECODER_SUCCESS;
    }
    static const float silence[MAX_FRAME_COUNT];
    const float *inputs[EAC3_JOC_MAX_CHANNELS];
    for (int i = 0; i < EAC3_JOC_MAX_CHANNELS; i++) {
        inputs[i] = silence;
    }
    for (int i = 0; i < MAX_FLUSH_FRAMES && pipeline->pending_count > 0; i++) {
        if (feed_pipeline(decoder, NULL, inputs, NULL, MAX_FRAME_COUNT, NULL, 0) != AUDIO_DECODER_SUCCESS
                || emit_object_blocks(decoder) != AUDIO_DECODER_SUCCESS) {
            pipeline->active = 0;
            return AUDIO_DECODER_FAILED;
        }
    }
    pipeline->active = 0;
    return AUDIO_DECODER_SUCCESS;
}

/* The output's target when the options ask for objects that this frame's decode lacks, else 0 */
static int wanted_target(const EAC3Decoder *decoder, uint64_t core_mask, uint32_t sample_rate, uint32_t *mask, int *binaural) {
    if (decoder->render_binaural) {
        *mask = ATMOS_LAYOUT_STEREO;
        *binaural = 1;
        return sample_rate == ATMOS_BINAURAL_SAMPLE_RATE;
    }
    *mask = decoder->render_mask;
    *binaural = 0;
    return atmos_layout_supported(decoder->render_mask) && (decoder->render_mask & ~core_mask) != 0;
}

/* Starts the pipeline at a frame, with the target it renders to and the downmix its JOC frames rebuild objects from */
static int start_pipeline(ObjectPipeline *pipeline, uint32_t sample_rate, uint64_t core_mask, uint32_t mask, int binaural,
        uint8_t downmix) {
    if (pipeline->renderer != NULL && pipeline->sample_rate != sample_rate) {
        atmos_renderer_destroy(pipeline->renderer);
        pipeline->renderer = NULL;
    }
    if (pipeline->renderer == NULL) {
        pipeline->renderer = atmos_renderer_create(sample_rate);
        if (pipeline->renderer == NULL) {
            return 0;
        }
    }
    pipeline->sample_rate = sample_rate;
    if (atmos_renderer_set_target(pipeline->renderer, mask, binaural) != ATMOS_OK) {
        return 0;
    }
    // The scene starts empty, so no object plays before the first metadata the renderer takes
    static const AtmosScene empty_scene;
    atmos_renderer_reset(pipeline->renderer);
    if (atmos_renderer_set_scene(pipeline->renderer, &empty_scene) != ATMOS_OK) {
        return 0;
    }
    eac3_joc_decoder_reset(&pipeline->joc);
    pipeline->active = 1;
    pipeline->target_mask = mask;
    pipeline->binaural = binaural;
    pipeline->core_mask = core_mask;
    pipeline->downmix = downmix;
    pipeline->latency = atmos_renderer_latency(pipeline->renderer);
    pipeline->object_count = 0;
    pipeline->scene_object_count = 0;
    pipeline->next_start = 0;
    pipeline->delay_to_drop = EAC3_QMF_DELAY;
    pipeline->objects_start = 0;
    pipeline->objects_length = 0;
    pipeline->lfe_start = 0;
    pipeline->lfe_length = 0;
    pipeline->output_start = 0;
    pipeline->output_length = 0;
    pipeline->pending_count = 0;
    return 1;
}

/*
 * Outputs a decoded frame: as FFmpeg's block, or into the object pipeline, whose held blocks it may finish.
 * The access unit is the frame's own, with its payloads, or null when the module could not pair them.
 */
static int process_frame(EAC3Decoder *decoder, AVFrame *frame, const AccessUnit *unit) {
    const uint64_t core_mask = frame->ch_layout.order == AV_CHANNEL_ORDER_NATIVE ? frame->ch_layout.u.mask : 0;
    const uint32_t sample_rate = (uint32_t) frame->sample_rate;
    const uint32_t frame_count = (uint32_t) frame->nb_samples;
    uint32_t mask = 0;
    int binaural = 0;
    const int objects = wanted_target(decoder, core_mask, sample_rate, &mask, &binaural)
        && unit != NULL && unit->found && frame_count % EAC3_QMF_BANDS == 0 && frame_count <= MAX_FRAME_COUNT;
    if (objects && decoder->pipeline == NULL) {
        decoder->pipeline = calloc(1, sizeof(ObjectPipeline));
    }
    ObjectPipeline *pipeline = decoder->pipeline;
    // Damaged payloads keep the last matrices or the objects' properties once objects play
    const int joc_parsed = objects && pipeline != NULL
        && eac3_joc_parse(&pipeline->joc_frame, unit->payloads.joc, unit->payloads.joc_size) == 0;
    const int oamd_parsed = objects && pipeline != NULL && unit->payloads.has_oamd
        && atmos_parse_oamd(unit->payloads.oamd, unit->payloads.oamd_size, &pipeline->metadata) == ATMOS_OK;
    // A change of target or binaural rendering changes the layout or the latency of blocks already rendered or held, and a change of core,
    // rate, or downmix the pipeline's inputs: each restarts it
    if (pipeline != NULL && pipeline->active && (!objects || pipeline->binaural != binaural || pipeline->target_mask != mask
            || pipeline->core_mask != core_mask || pipeline->sample_rate != sample_rate
            || (joc_parsed && pipeline->joc_frame.downmix != pipeline->downmix))) {
        if (stop_pipeline(decoder) != AUDIO_DECODER_SUCCESS) {
            return AUDIO_DECODER_FAILED;
        }
    }
    if (!objects || pipeline == NULL) {
        return push_stock_block(decoder, frame, unit);
    }
    const float *inputs[EAC3_JOC_MAX_CHANNELS];
    const float *lfe = NULL;
    const AtmosMetadata *metadata = oamd_parsed ? &pipeline->metadata : NULL;
    if (!pipeline->active) {
        // Objects start only at a frame whose payloads both parse, whose decode holds the JOC downmix, and whose scene the renderer takes
        if (!joc_parsed || !oamd_parsed || !find_inputs(frame, pipeline->joc_frame.downmix, pipeline->joc_frame.channel_count, inputs, &lfe)
                || !start_pipeline(pipeline, sample_rate, core_mask, mask, binaural, pipeline->joc_frame.downmix)) {
            return push_stock_block(decoder, frame, unit);
        }
        if (atmos_renderer_add_metadata(pipeline->renderer, metadata, (int32_t) unit->payloads.oamd_sample_offset) != ATMOS_OK) {
            pipeline->active = 0;
            return push_stock_block(decoder, frame, unit);
        }
        map_scene(pipeline, &metadata->scene, pipeline->joc_frame.object_count);
        metadata = NULL;
    } else if (!find_inputs(frame, pipeline->downmix, pipeline->joc.channel_count, inputs, &lfe)) {
        // The pipeline's core layout matched, so its downmix channels are there
        return fail(decoder, EAC3_ERROR_OUTPUT, 0);
    }
    if (pipeline->pending_count == BLOCK_QUEUE_LENGTH) {
        return fail(decoder, EAC3_ERROR_OUTPUT, BLOCK_QUEUE_LENGTH);
    }
    pipeline->pending[pipeline->pending_count++] = (PendingBlock) { pipeline->next_start, frame_count, unit->timestamp };
    if (feed_pipeline(decoder, joc_parsed ? &pipeline->joc_frame : NULL, inputs, lfe, frame_count, metadata,
            unit->payloads.oamd_sample_offset) != AUDIO_DECODER_SUCCESS) {
        return AUDIO_DECODER_FAILED;
    }
    av_frame_unref(frame);
    return emit_object_blocks(decoder);
}

/* The access unit of the next decoded frame, when its sample count pairs them */
static const AccessUnit *next_access_unit(EAC3Decoder *decoder, const AVFrame *frame) {
    while (decoder->access_unit_count > 0) {
        const AccessUnit *unit = &decoder->access_units[decoder->access_unit_head++];
        decoder->access_unit_count--;
        if (unit->frame_count == (uint32_t) frame->nb_samples && unit->sample_rate == (uint32_t) frame->sample_rate) {
            return unit;
        }
    }
    return NULL;
}

static void pop_block(EAC3Decoder *decoder) {
    Block *block = &decoder->blocks[decoder->block_head];
    decoder->block_head = (decoder->block_head + 1) % BLOCK_QUEUE_LENGTH;
    decoder->block_count--;
    // The current block takes the queued one's frame and planes, and gives its own to the queue's free slot
    const Block current = decoder->current;
    decoder->current = *block;
    block->frame = current.frame;
    block->planes = current.planes;
    decoder->has_current = 1;
}

EMSCRIPTEN_KEEPALIVE
int audio_decoder_receive(EAC3Decoder *decoder) {
    if (decoder->has_current) {
        release_block(&decoder->current);
        decoder->has_current = 0;
    }
    while (decoder->block_count == 0) {
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
        if (process_frame(decoder, decoder->frame, next_access_unit(decoder, decoder->frame)) != AUDIO_DECODER_SUCCESS) {
            return AUDIO_DECODER_FAILED;
        }
    }
    pop_block(decoder);
    return AUDIO_DECODER_RECEIVE_READY;
}

/* Ends the stream: the object blocks the pipeline holds follow from audio_decoder_receive. A second drain changes nothing */
EMSCRIPTEN_KEEPALIVE
int audio_decoder_drain(EAC3Decoder *decoder) {
    // FFmpeg's AC-3 decoders hold no frame back; a drain that already started reports the end of the stream
    const int result = avcodec_send_packet(decoder->codec_context, NULL);
    if (result < 0 && result != AVERROR_EOF) {
        return fail(decoder, EAC3_ERROR_SEND, (uint32_t) -result);
    }
    return stop_pipeline(decoder);
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_frame_count(EAC3Decoder *decoder) {
    return decoder->current.frame_count;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_sample_rate(EAC3Decoder *decoder) {
    return decoder->current.sample_rate;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_channel_count(EAC3Decoder *decoder) {
    return decoder->current.channel_count;
}

/* The WAVE channel mask of the block's layout, or 0 for a layout without one */
EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_channel_mask(EAC3Decoder *decoder) {
    return decoder->current.channel_mask;
}

EMSCRIPTEN_KEEPALIVE
float *audio_decoder_channel_pointer(EAC3Decoder *decoder, uint32_t channel) {
    if (!decoder->has_current || channel >= decoder->current.channel_count) {
        return NULL;
    }
    if (decoder->current.frame->nb_samples > 0) {
        return (float *) decoder->current.frame->extended_data[channel];
    }
    return decoder->current.planes + (size_t) channel * decoder->current.frame_count;
}

EMSCRIPTEN_KEEPALIVE
double audio_decoder_timestamp(EAC3Decoder *decoder) {
    return decoder->current.timestamp;
}

EMSCRIPTEN_KEEPALIVE
double audio_decoder_attribute(EAC3Decoder *decoder, uint32_t key) {
    switch (key) {
        case EAC3_ATTRIBUTE_LIBRARY_VERSION:
            return (double) avcodec_version();
        case EAC3_ATTRIBUTE_OBJECT_COUNT:
            return (double) decoder->current.object_count;
        default:
            return AUDIO_DECODER_NO_ATTRIBUTE;
    }
}

EMSCRIPTEN_KEEPALIVE
void audio_decoder_clear(EAC3Decoder *decoder) {
    av_packet_unref(decoder->packet);
    av_frame_unref(decoder->frame);
    avcodec_flush_buffers(decoder->codec_context);
    decoder->access_unit_head = 0;
    decoder->access_unit_count = 0;
    // The current block's frame goes back to the queue's free slot as each queued block passes through, so it is released first
    release_block(&decoder->current);
    while (decoder->block_count > 0) {
        pop_block(decoder);
        release_block(&decoder->current);
    }
    decoder->has_current = 0;
    if (decoder->pipeline != NULL) {
        decoder->pipeline->active = 0;
    }
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_error_code(EAC3Decoder *decoder) {
    return decoder->error_code;
}

EMSCRIPTEN_KEEPALIVE
uint32_t audio_decoder_error_value(EAC3Decoder *decoder) {
    return decoder->error_value;
}
