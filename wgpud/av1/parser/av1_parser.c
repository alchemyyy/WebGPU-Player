// The AV1 package's module: version 2 of the engine's parser interface over libaom's decoder, which runs its parse-only pass.
// The engine creates one instance per worker. Its coordinator instance configures the track's av1C, plans each packet in decode order,
// and finishes the packet's pictures one at a time; every libaom call happens in plan, which parses each frame of the packet into its
// GPU record (av1_record.c). Plans have no parse units, so the engine makes no parse call; one made anyway returns an empty job.
// The module imports only its memory; libaom's frame buffers point at an address outside it, so a pixel write would trap.

#include <stdlib.h>
#include <string.h>

#include "aom/aom_frame_buffer.h"
#include "aom_mem/aom_mem.h"
#include "av1/common/alloccommon.h"
#include "av1/common/av1_common_int.h"
#include "av1/common/cdef.h"
#include "av1/common/restoration.h"
#include "av1/decoder/decoder.h"

#include "av1_parser.h"

// av1C: the marker and version byte, then three bytes of sequence facts the configuration OBUs repeat
#define AV1C_HEADER_BYTES 4u
#define AV1C_MARKER_VERSION 0x81u
// ERROR_CONFIGURATION values: the record is shorter than its header, its marker or version is not 1, or libaom refused its OBUs
#define CONFIGURATION_TOO_SHORT 1u
#define CONFIGURATION_MARKER 2u
#define CONFIGURATION_OBUS 3u
// ERROR_RECORD_INVALID values of the parser's own calls
#define INVALID_UNIT_RANGE 1u
#define NO_PENDING_PICTURE 2u
#define UNPLANNED_PICTURES 3u
// What one libaom call on a packet did: nothing more to parse, a picture, or a frame before the first key frame, which ends the packet
#define FRAME_RESULT_NONE 0
#define FRAME_RESULT_PICTURE 1
#define FRAME_RESULT_AWAITING_KEY_FRAME 2
// An address no wasm32 instance of at most 1 GiB maps, where libaom's frame buffers point: any pixel access traps
#define UNMAPPED_FRAME_BUFFER_ADDRESS ((uintptr_t)0x80000000u)
#define KIBIBYTE_SHIFT 10u
#define GROWTH_FACTOR 2u
#define MINIMUM_WORD_CAPACITY 1024u

AV1Parser *av1_active_parser = NULL;

int word_buffer_resize(WordBuffer *buffer, size_t count) {
  if (count > buffer->capacity) {
    size_t capacity = buffer->capacity < MINIMUM_WORD_CAPACITY
                          ? MINIMUM_WORD_CAPACITY
                          : buffer->capacity;
    while (capacity < count) capacity *= GROWTH_FACTOR;
    uint32_t *const words = (uint32_t *)realloc(buffer->words, capacity * sizeof(uint32_t));
    if (words == NULL) return -1;
    buffer->words = words;
    buffer->capacity = capacity;
  }
  if (count > buffer->count) {
    memset(buffer->words + buffer->count, 0, (count - buffer->count) * sizeof(uint32_t));
  }
  buffer->count = count;
  return 0;
}

int word_buffer_append(WordBuffer *buffer, const uint32_t *words, size_t count) {
  const size_t first = buffer->count;
  if (word_buffer_resize(buffer, first + count) != 0) return -1;
  memcpy(buffer->words + first, words, count * sizeof(uint32_t));
  return 0;
}

void word_buffer_free(WordBuffer *buffer) {
  free(buffer->words);
  buffer->words = NULL;
  buffer->count = 0;
  buffer->capacity = 0;
}

// libaom's frame buffers: an unmapped address of the size libaom asks for, so the parser holds no samples
static int get_unmapped_frame_buffer(void *private_data, size_t minimum_size,
                                     aom_codec_frame_buffer_t *frame_buffer) {
  (void)private_data;
  frame_buffer->data = (uint8_t *)UNMAPPED_FRAME_BUFFER_ADDRESS;
  frame_buffer->size = minimum_size;
  frame_buffer->priv = NULL;
  return 0;
}

static int release_unmapped_frame_buffer(void *private_data,
                                         aom_codec_frame_buffer_t *frame_buffer) {
  (void)private_data;
  (void)frame_buffer;
  return 0;
}

// Records a failure of the parser's own; returns the failed status
static int32_t fail(AV1Parser *parser, uint32_t error_code, uint32_t error_value) {
  parser->error_code = error_code;
  parser->error_value = error_value & ERROR_VALUE_MASK;
  return PARSER_STATUS_FAILED;
}

// Records a failure libaom reported, unless a hook already recorded the parser's own reason
static int32_t fail_from_decoder(AV1Parser *parser) {
  if (parser->error_code != 0) return PARSER_STATUS_FAILED;
  const uint32_t picture = parser->picture_index + parser->picture_count;
  switch (parser->decoder->error.error_code) {
    case AOM_CODEC_CORRUPT_FRAME: return fail(parser, ERROR_BITSTREAM_CORRUPT, picture);
    case AOM_CODEC_UNSUP_BITSTREAM:
    case AOM_CODEC_UNSUP_FEATURE:
    case AOM_CODEC_INCAPABLE: return fail(parser, ERROR_BITSTREAM_UNSUPPORTED, picture);
    case AOM_CODEC_MEM_ERROR: return fail(parser, ERROR_PARSER_MEMORY, picture);
    default: return fail(parser, ERROR_PARSER_ERROR, (uint32_t)parser->decoder->error.error_code);
  }
}

// Releases the frames libaom queued for output; the parser only reads which frame a call showed
static void release_output_frames(AV1Parser *parser) {
  AV1Decoder *const decoder = parser->decoder;
  for (size_t index = 0; index < decoder->num_output_frames; ++index) {
    decrease_ref_count(decoder->output_frames[index], parser->pool);
  }
  decoder->num_output_frames = 0;
}

// Frees the record frame buffers of the pool buffers libaom no longer holds
static void release_unused_frame_buffers(AV1Parser *parser) {
  for (uint32_t pool_index = 0; pool_index < FRAME_BUFFERS; ++pool_index) {
    if (parser->pool->frame_bufs[pool_index].ref_count == 0) {
      parser->frame_buffer_of[pool_index] = PARSER_NO_FRAME_BUFFER;
    }
  }
}

static void destroy_decoder(AV1Parser *parser) {
  if (parser->decoder != NULL) {
    AV1Decoder *const decoder = parser->decoder;
    release_output_frames(parser);
    aom_free(decoder->common.tpl_mvs);
    decoder->common.tpl_mvs = NULL;
    av1_remove_common(&decoder->common);
    av1_free_cdef_buffers(&decoder->common, &decoder->cdef_worker, &decoder->cdef_sync);
    av1_free_cdef_sync(&decoder->cdef_sync);
    av1_free_restoration_buffers(&decoder->common);
    av1_decoder_remove(decoder);
    parser->decoder = NULL;
  }
  if (parser->pool != NULL) {
    av1_free_ref_frame_buffers(parser->pool);
    aom_free(parser->pool);
    parser->pool = NULL;
  }
  memset(parser->frame_buffer_of, PARSER_NO_FRAME_BUFFER, sizeof(parser->frame_buffer_of));
}

// Creates libaom's decoder as its interface would for serial decoding of operating point 0, with the parser's frame buffers
static int create_decoder(AV1Parser *parser) {
  BufferPool *const pool = (BufferPool *)aom_calloc(1, sizeof(BufferPool));
  if (pool == NULL) return -1;
  pool->num_frame_bufs = FRAME_BUFFERS;
  pool->frame_bufs = (RefCntBuffer *)aom_calloc(FRAME_BUFFERS, sizeof(*pool->frame_bufs));
  if (pool->frame_bufs == NULL) {
    aom_free(pool);
    return -1;
  }
  pool->get_fb_cb = get_unmapped_frame_buffer;
  pool->release_fb_cb = release_unmapped_frame_buffer;
  pool->cb_priv = NULL;
  parser->pool = pool;
  AV1Decoder *const decoder = av1_decoder_create(pool);
  if (decoder == NULL) {
    destroy_decoder(parser);
    return -1;
  }
  decoder->allow_lowbitdepth = 1;
  decoder->max_threads = 1;
  decoder->inv_tile_order = 0;
  decoder->common.tiles.large_scale = 0;
  decoder->is_annexb = 0;
  decoder->dec_tile_row = -1;
  decoder->dec_tile_col = -1;
  decoder->operating_point = 0;
  decoder->output_all_layers = 0;
  decoder->frame_size_limit = RECORD_MAXIMUM_AREA;
  decoder->ext_tile_debug = 0;
  decoder->row_mt = 0;
  decoder->common.cur_frame = NULL;
  decoder->common.features.byte_alignment = 0;
  decoder->skip_loop_filter = 0;
  decoder->skip_film_grain = 0;
  parser->decoder = decoder;
  parser->awaiting_key_frame = 1;
  memset(parser->frame_buffer_of, PARSER_NO_FRAME_BUFFER, sizeof(parser->frame_buffer_of));
  return 0;
}

// Drops the pictures of the last packet
static void clear_pictures(AV1Parser *parser) {
  parser->picture_index += parser->picture_count;
  parser->picture_count = 0;
  parser->planned_count = 0;
  parser->finished_count = 0;
}

// Whether a failed libaom call came from a frame before the first key frame: libaom still waits for a key or intra-only frame, or the
// frame needs references that an intra-only frame did not provide; a key frame's own failure is the bitstream's
static int failed_awaiting_key_frame(const AV1Parser *parser) {
  if (!parser->awaiting_key_frame || parser->error_code != 0) return 0;
  const AV1Decoder *const decoder = parser->decoder;
  return decoder->need_resync || decoder->common.current_frame.frame_type != KEY_FRAME;
}

// Runs libaom on the next frame of the packet; returns FRAME_RESULT_PICTURE when the call parsed or showed a frame, FRAME_RESULT_NONE
// when the rest held none, FRAME_RESULT_AWAITING_KEY_FRAME for a frame libaom cannot decode before the first key frame, or the failed status
static int32_t parse_next_frame(AV1Parser *parser, const uint8_t **data, const uint8_t *data_end) {
  AV1Decoder *const decoder = parser->decoder;
  parser->frame_parsed = 0;
  av1_record_reset_sections(parser);
  av1_active_parser = parser;
  const int result = av1_receive_compressed_data(decoder, (size_t)(data_end - *data), data);
  av1_active_parser = NULL;
  if (result != 0) {
    // A frame that failed after its record was built makes no picture
    if (parser->frame_parsed) parser->picture_count -= 1;
    release_output_frames(parser);
    release_unused_frame_buffers(parser);
    if (failed_awaiting_key_frame(parser)) return FRAME_RESULT_AWAITING_KEY_FRAME;
    return fail_from_decoder(parser);
  }
  int32_t pictures = FRAME_RESULT_NONE;
  if (parser->frame_parsed) {
    // A decoded frame: its final frame buffer now belongs to its pool buffer, which the references may hold
    parser->frame_buffer_of[parser->parsed_pool_index] = (uint8_t)parser->parsed_final_buffer;
    if (decoder->common.current_frame.frame_type == KEY_FRAME) parser->awaiting_key_frame = 0;
    pictures = FRAME_RESULT_PICTURE;
  } else if (decoder->num_output_frames > 0) {
    // A show_existing_frame: the output frame is a reference's
    if (parser->picture_count >= PARSER_MAXIMUM_PICTURES_PER_PACKET) {
      release_output_frames(parser);
      return fail(parser, ERROR_BITSTREAM_UNSUPPORTED, parser->picture_count);
    }
    const uint32_t pool_index = (uint32_t)(decoder->output_frames[0] - parser->pool->frame_bufs);
    const uint32_t frame_buffer = parser->frame_buffer_of[pool_index];
    if (frame_buffer == PARSER_NO_FRAME_BUFFER) {
      release_output_frames(parser);
      return fail(parser, ERROR_REFERENCE_INVALID, pool_index);
    }
    if (av1_record_build_show_existing(parser, &parser->pictures[parser->picture_count], frame_buffer) != 0) {
      release_output_frames(parser);
      return PARSER_STATUS_FAILED;
    }
    // Showing an existing key frame resets the references as a key frame does
    if (decoder->output_frames[0]->frame_type == KEY_FRAME) parser->awaiting_key_frame = 0;
    parser->picture_count += 1;
    pictures = FRAME_RESULT_PICTURE;
  }
  release_output_frames(parser);
  release_unused_frame_buffers(parser);
  return pictures;
}

// Parses every frame of the packet into the pictures, then decides their events: the packet's last shown frame presents,
// as libaom outputs one frame per temporal unit, and every other frame drops
static int32_t parse_packet(AV1Parser *parser) {
  const uint8_t *data = parser->packet;
  const uint8_t *const data_end = data + parser->packet_length;
  while (data < data_end) {
    const uint8_t *const start = data;
    const int32_t result = parse_next_frame(parser, &data, data_end);
    if (result < 0) return result;
    // A frame before the first key frame ends the packet: the rest predicts from what libaom does not hold
    if (result == FRAME_RESULT_AWAITING_KEY_FRAME) break;
    // Zero bytes may follow a frame, as libaom's interface allows
    while (data < data_end && *data == 0) ++data;
    if (data == start) break;
  }
  int32_t presented = -1;
  for (uint32_t index = 0; index < parser->picture_count; ++index) {
    if (parser->pictures[index].shown) presented = (int32_t)index;
  }
  for (uint32_t index = 0; index < parser->picture_count; ++index) {
    ParserPicture *const picture = &parser->pictures[index];
    const uint32_t picture_number = (parser->picture_index + index) & PARSER_EVENT_INDEX_MASK;
    picture->event = picture_number | ((int32_t)index == presented ? 0u : PARSER_EVENT_DROP);
    if ((int32_t)index != presented) {
      // A frame that drops writes no output
      picture->record.words[RECORD_HEADER_FLAGS] &= ~(1u << RECORD_FLAG_SHOW_FRAME);
    }
  }
  return PARSER_STATUS_SUCCESS;
}

static void clear_output(AV1Parser *parser) {
  parser->output = NULL;
  parser->output_byte_length = 0;
  parser->event_count = 0;
  parser->picture_width = 0;
  parser->picture_height = 0;
  parser->picture_format = 0;
  parser->picture_wave_pairs = 0;
  parser->maximum_picture_width = 0;
  parser->maximum_picture_height = 0;
  parser->error_code = 0;
  parser->error_value = 0;
}

// The output format a record's frame decodes into, as parser_picture_format() reports it: its sequence's chroma format and bit depth
static uint32_t get_picture_format(const uint32_t *header) {
  uint32_t chroma_format = PICTURE_CHROMA_FORMAT_444;
  switch ((header[RECORD_HEADER_SUBSAMPLING_X] << 1) | header[RECORD_HEADER_SUBSAMPLING_Y]) {
    case 3u: chroma_format = PICTURE_CHROMA_FORMAT_420; break;
    case 2u: chroma_format = PICTURE_CHROMA_FORMAT_422; break;
    default: break;
  }
  // A monochrome sequence codes 4:2:0 subsampling without chroma planes
  if ((header[RECORD_HEADER_FLAGS] >> RECORD_FLAG_MONOCHROME) & 1u) chroma_format = PICTURE_CHROMA_FORMAT_400;
  return (chroma_format << PICTURE_FORMAT_CHROMA_SHIFT) | header[RECORD_HEADER_BIT_DEPTH];
}

// Hands out the next planned picture: its plan is empty, and plan_next hands out the rest of the packet
static int32_t hand_out_picture(AV1Parser *parser) {
  if (parser->planned_count >= parser->picture_count) return PARSER_STATUS_NO_PICTURE;
  parser->planned_count += 1;
  return parser->planned_count < parser->picture_count ? PARSER_STATUS_MORE_PICTURES : PARSER_STATUS_SUCCESS;
}

uint32_t parser_abi_version(void) {
  return PARSER_ABI_VERSION;
}

AV1Parser *parser_create(void) {
  AV1Parser *const parser = (AV1Parser *)calloc(1, sizeof(AV1Parser));
  if (parser == NULL) return NULL;
  memset(parser->frame_buffer_of, PARSER_NO_FRAME_BUFFER, sizeof(parser->frame_buffer_of));
  return parser;
}

void parser_destroy(AV1Parser *parser) {
  if (parser == NULL) return;
  destroy_decoder(parser);
  av1_record_free_sections(parser);
  for (uint32_t index = 0; index < PARSER_MAXIMUM_PICTURES_PER_PACKET; ++index) {
    word_buffer_free(&parser->pictures[index].record);
  }
  free(parser->input);
  free(parser->packet);
  free(parser);
}

uint8_t *parser_reserve_input(AV1Parser *parser, uint32_t byte_length) {
  if (byte_length == 0) return NULL;
  if (byte_length > parser->input_capacity) {
    uint8_t *const input = (uint8_t *)realloc(parser->input, byte_length);
    if (input == NULL) return NULL;
    parser->input = input;
    parser->input_capacity = byte_length;
  }
  return parser->input;
}

int32_t parser_configure(AV1Parser *parser, uint32_t byte_length) {
  clear_output(parser);
  if (byte_length < AV1C_HEADER_BYTES) return fail(parser, ERROR_CONFIGURATION, CONFIGURATION_TOO_SHORT);
  if (parser->input[0] != AV1C_MARKER_VERSION) return fail(parser, ERROR_CONFIGURATION, CONFIGURATION_MARKER);
  if (parser->decoder == NULL && create_decoder(parser) != 0) return fail(parser, ERROR_PARSER_MEMORY, 0);
  // The configuration OBUs, a sequence header and metadata, hold no frame
  const uint8_t *data = parser->input + AV1C_HEADER_BYTES;
  const uint8_t *const data_end = parser->input + byte_length;
  while (data < data_end) {
    const uint8_t *const start = data;
    parser->frame_parsed = 0;
    av1_active_parser = parser;
    const int result = av1_receive_compressed_data(parser->decoder, (size_t)(data_end - data), &data);
    av1_active_parser = NULL;
    const int showed_frame = parser->decoder->num_output_frames > 0;
    release_output_frames(parser);
    release_unused_frame_buffers(parser);
    if (result != 0 || parser->frame_parsed || showed_frame) {
      clear_pictures(parser);
      return fail(parser, ERROR_CONFIGURATION, CONFIGURATION_OBUS);
    }
    if (data == start) break;
  }
  // The sequence header's largest frame, which every frame of its sequence fits, spatial layers and frame size changes included;
  // a later sequence header may raise it, which its pictures report
  if (parser->decoder->sequence_header_ready) {
    const SequenceHeader *const sequence = parser->decoder->common.seq_params;
    parser->maximum_picture_width = (uint32_t)sequence->max_frame_width;
    parser->maximum_picture_height = (uint32_t)sequence->max_frame_height;
  }
  return PARSER_STATUS_SUCCESS;
}

void parser_reset(AV1Parser *parser) {
  clear_output(parser);
  destroy_decoder(parser);
  parser->picture_index = 0;
  parser->picture_count = 0;
  parser->planned_count = 0;
  parser->finished_count = 0;
  parser->neutral_fill_mask = 0;
  memset(parser->statistics, 0, sizeof(parser->statistics));
}

int32_t parser_plan(AV1Parser *parser, uint32_t byte_length) {
  clear_output(parser);
  // A packet's pictures wait for every earlier picture to finish, so at most one packet's records exist
  if (parser->finished_count < parser->planned_count) return PARSER_STATUS_BLOCKED;
  if (parser->planned_count < parser->picture_count) return fail(parser, ERROR_RECORD_INVALID, UNPLANNED_PICTURES);
  clear_pictures(parser);
  if (byte_length == 0) return PARSER_STATUS_NO_PICTURE;
  if (parser->decoder == NULL && create_decoder(parser) != 0) return fail(parser, ERROR_PARSER_MEMORY, 0);
  if (byte_length > parser->packet_capacity) {
    uint8_t *const packet = (uint8_t *)realloc(parser->packet, byte_length);
    if (packet == NULL) return fail(parser, ERROR_PARSER_MEMORY, byte_length >> KIBIBYTE_SHIFT);
    parser->packet = packet;
    parser->packet_capacity = byte_length;
  }
  memcpy(parser->packet, parser->input, byte_length);
  parser->packet_length = byte_length;
  const int32_t status = parse_packet(parser);
  if (status != PARSER_STATUS_SUCCESS) return status;
  return hand_out_picture(parser);
}

int32_t parser_plan_next(AV1Parser *parser) {
  clear_output(parser);
  return hand_out_picture(parser);
}

uint32_t parser_plan_unit_count(AV1Parser *parser) {
  (void)parser;
  return 0;
}

int32_t parser_parse(AV1Parser *parser, uint32_t byte_length, uint32_t first_unit, uint32_t unit_count) {
  (void)byte_length;
  clear_output(parser);
  // An AV1 plan has no units, so the engine skips the parse call; one with no units returns an empty job
  if (first_unit != 0 || unit_count != 0) return fail(parser, ERROR_RECORD_INVALID, INVALID_UNIT_RANGE);
  return PARSER_STATUS_SUCCESS;
}

int32_t parser_finish(AV1Parser *parser, uint32_t byte_length) {
  (void)byte_length;
  clear_output(parser);
  if (parser->finished_count >= parser->planned_count) return fail(parser, ERROR_RECORD_INVALID, NO_PENDING_PICTURE);
  const ParserPicture *const picture = &parser->pictures[parser->finished_count];
  parser->finished_count += 1;
  const uint32_t *const header = picture->record.words;
  parser->output = (const uint8_t *)header;
  parser->output_byte_length = (uint32_t)(picture->record.count * sizeof(uint32_t));
  parser->events[0] = picture->event;
  parser->event_count = 1;
  // The picture's visible size is its output frame's, after super-resolution; its waves come in pairs of an even and an odd one.
  // Its format and its sequence's largest frame let the engine move to a session that holds them, as a new sequence header needs
  parser->picture_width = header[RECORD_HEADER_UPSCALED_WIDTH];
  parser->picture_height = header[RECORD_HEADER_FRAME_HEIGHT];
  parser->picture_format = get_picture_format(header);
  parser->picture_wave_pairs =
      (header[RECORD_HEADER_WAVE_COUNT] + PARSER_WAVES_PER_REPEAT - 1u) / PARSER_WAVES_PER_REPEAT;
  parser->maximum_picture_width = picture->maximum_width;
  parser->maximum_picture_height = picture->maximum_height;
  return PARSER_STATUS_SUCCESS;
}

int32_t parser_decode(AV1Parser *parser, uint32_t byte_length) {
  const int32_t status = parser_plan(parser, byte_length);
  if (status != PARSER_STATUS_SUCCESS && status != PARSER_STATUS_MORE_PICTURES) return status;
  const int32_t finished = parser_finish(parser, 0);
  return finished == PARSER_STATUS_SUCCESS ? status : finished;
}

int32_t parser_decode_next(AV1Parser *parser) {
  const int32_t status = parser_plan_next(parser);
  if (status != PARSER_STATUS_SUCCESS && status != PARSER_STATUS_MORE_PICTURES) return status;
  const int32_t finished = parser_finish(parser, 0);
  return finished == PARSER_STATUS_SUCCESS ? status : finished;
}

uint32_t parser_picture_width(AV1Parser *parser) {
  return parser->picture_width;
}

uint32_t parser_picture_height(AV1Parser *parser) {
  return parser->picture_height;
}

uint32_t parser_picture_format(AV1Parser *parser) {
  return parser->picture_format;
}

uint32_t parser_picture_repeat_count(AV1Parser *parser, uint32_t repeat) {
  return repeat == PARSER_INTRA_WAVE_REPEAT ? parser->picture_wave_pairs : 0u;
}

uint32_t parser_maximum_picture_width(AV1Parser *parser) {
  return parser->maximum_picture_width;
}

uint32_t parser_maximum_picture_height(AV1Parser *parser) {
  return parser->maximum_picture_height;
}

const uint8_t *parser_output_pointer(AV1Parser *parser) {
  return parser->output;
}

uint32_t parser_output_byte_length(AV1Parser *parser) {
  return parser->output_byte_length;
}

const uint32_t *parser_event_pointer(AV1Parser *parser) {
  return parser->events;
}

uint32_t parser_event_count(AV1Parser *parser) {
  return parser->event_count;
}

uint32_t parser_error_code(AV1Parser *parser) {
  return parser->error_code;
}

uint32_t parser_error_value(AV1Parser *parser) {
  return parser->error_value;
}
