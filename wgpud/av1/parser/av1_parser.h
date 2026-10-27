// The AV1 parser: libaom's decoder running its parse-only pass behind the engine's parser interface, version 2.
// The coordinator instance does all of libaom's work: plan parses every frame of a packet into its GPU record, one picture per frame,
// hidden frames and show_existing_frame included, and finish hands the records out in decode order. Plans have no parse units.

#ifndef AV1_PARSER_H_
#define AV1_PARSER_H_

#include <stddef.h>
#include <stdint.h>

#include "av1/decoder/decoder.h"
#include "av1_record_layout.h"

// The parser interface version the exports implement
#define PARSER_ABI_VERSION 2u

// Call statuses: a picture whose packet holds no more, no picture, a plan that waits for earlier pictures to finish,
// a picture whose packet may hold more (plan_next hands them out), and a failure
#define PARSER_STATUS_SUCCESS 0
#define PARSER_STATUS_NO_PICTURE 1
#define PARSER_STATUS_BLOCKED 2
#define PARSER_STATUS_MORE_PICTURES 3
#define PARSER_STATUS_FAILED (-1)

// An output event: a picture's index in decode order, and the bit that drops it instead of presenting it
#define PARSER_EVENT_INDEX_MASK 0x3FFFFFFFu
#define PARSER_EVENT_DROP 0x80000000u

// The most pictures one packet may hold: a temporal unit's hidden frames and its shown frames
#define PARSER_MAXIMUM_PICTURES_PER_PACKET 64u

// No frame buffer, in the map from libaom's pool buffers to the record's frame buffers
#define PARSER_NO_FRAME_BUFFER 255u

// The header's one repeat directive: the intra wavefront's pairs of waves
#define PARSER_INTRA_WAVE_REPEAT 0u
#define PARSER_WAVES_PER_REPEAT 2u

// A picture's output format as parser_picture_format() reports it: (chroma format << 8) | bit depth, the chroma format counted as
// chroma_format_idc counts it, 4:0:0 included, which decodes into 4:2:0 with neutral chroma
#define PICTURE_FORMAT_CHROMA_SHIFT 8u
#define PICTURE_CHROMA_FORMAT_400 0u
#define PICTURE_CHROMA_FORMAT_420 1u
#define PICTURE_CHROMA_FORMAT_422 2u
#define PICTURE_CHROMA_FORMAT_444 3u

// A growable array of 32-bit words
typedef struct WordBuffer {
  uint32_t *words;
  size_t count;
  size_t capacity;
} WordBuffer;

// The sections of the frame being parsed, which the hooks fill in decode order and av1_record_build_frame() joins into its record
typedef struct FrameSections {
  // Whether the frame's first hook ran, which sized the sections and set up the deblocking levels
  int started;
  uint32_t superblock_columns;
  uint32_t superblock_rows;
  // log2 of the superblock's size in 4x4 units
  uint32_t superblock_size_log2;
  // The intra wavefront's superblock slope for the frame
  uint32_t wave_slope;
  // The frame's 64x64 CDEF units
  uint32_t cdef_unit_columns;
  uint32_t cdef_unit_rows;
  // The planes the frame deblocks, whose blocks carry their levels
  uint32_t deblock_planes;
  WordBuffer superblocks;
  WordBuffer blocks;
  WordBuffer side_data;
  WordBuffer intra_jobs;
  // Transform jobs without a 64-point side, then those with one, which the record lists after the others for their own pass
  WordBuffer transform_jobs;
  WordBuffer large_transform_jobs;
  WordBuffer coefficients;
  WordBuffer restoration_units;
  // Per CDEF unit, nonzero when a block with coefficients covers it; not part of the record
  WordBuffer coded_cdef_units;
  // The superblock being parsed, in frame raster order, its wave, and its intra jobs per plane in decode order
  uint32_t superblock;
  uint32_t superblock_wave;
  WordBuffer plane_jobs[RECORD_PLANES];
  // The planes in which the block being parsed has a residual, from its transform hooks
  uint32_t residual_planes;
  // Whether an IntraBC or inter-intra job has a residual, which it adds over its whole block
  int block_residuals;
  // One more than the last wave that has intra jobs, chroma's lag included
  uint32_t wave_count;
  // The record's words so far, its header included, against the packet bound
  size_t record_words;
  // The packet bound in words for the frame's size rounded up to 64, which never exceeds its session's
  size_t packet_words;
} FrameSections;

// A picture of the packet being planned: its GPU record and its output event
typedef struct ParserPicture {
  WordBuffer record;
  uint32_t event;
  // Whether the frame is shown: decoded with show_frame, or a show_existing_frame
  int shown;
  // The largest frame its sequence header declares, which a later sequence header may raise
  uint32_t maximum_width;
  uint32_t maximum_height;
} ParserPicture;

// One instance of the parser
typedef struct AV1Parser {
  BufferPool *pool;
  AV1Decoder *decoder;
  // The buffer the next call reads its input from
  uint8_t *input;
  size_t input_capacity;
  // The packet being planned, which plan copies so plan_next reads no input
  uint8_t *packet;
  size_t packet_capacity;
  size_t packet_length;
  // The packet's pictures, in decode order: planned ones were handed out by plan or plan_next, finished ones by finish
  ParserPicture pictures[PARSER_MAXIMUM_PICTURES_PER_PACKET];
  uint32_t picture_count;
  uint32_t planned_count;
  uint32_t finished_count;
  // Pictures since the instance started or reset, in decode order
  uint32_t picture_index;
  // Whether the decoder waits for a key frame: from the start or a reset until the first key frame decodes, a frame libaom
  // cannot decode for want of one makes no picture, as after a seek
  int awaiting_key_frame;
  // The record frame buffer of each libaom pool buffer, or PARSER_NO_FRAME_BUFFER
  uint8_t frame_buffer_of[FRAME_BUFFERS];
  // Record frame buffers to fill with neutral grey before the frame being parsed decodes
  uint32_t neutral_fill_mask;
  // Whether the running libaom call parsed a frame, and that frame's pool buffer and final record frame buffer
  int frame_parsed;
  uint32_t parsed_pool_index;
  uint32_t parsed_final_buffer;
  // The frame being parsed: its sections and the counts its record reports
  FrameSections sections;
  uint32_t statistics[RECORD_STATISTICS_WORDS];
  // The largest frame of the configured sequence header after configure, or of the output picture's sequence after a call that
  // output one; 0 and 0 for none
  uint32_t maximum_picture_width;
  uint32_t maximum_picture_height;
  // The last call's output and events, and the visible size, output format, and wave pairs of the picture it output
  const uint8_t *output;
  uint32_t output_byte_length;
  uint32_t events[PARSER_MAXIMUM_PICTURES_PER_PACKET];
  uint32_t event_count;
  uint32_t picture_width;
  uint32_t picture_height;
  uint32_t picture_format;
  uint32_t picture_wave_pairs;
  // The last failure: an error code the header names, and its failing value
  uint32_t error_code;
  uint32_t error_value;
} AV1Parser;

// The instance whose libaom call is running, which the hooks write into; the parser runs on one thread
extern AV1Parser *av1_active_parser;

// Appends words to a buffer; returns 0, or -1 when memory runs out
int word_buffer_append(WordBuffer *buffer, const uint32_t *words, size_t count);
// Grows a buffer to count words, the new ones zero; returns 0, or -1 when memory runs out
int word_buffer_resize(WordBuffer *buffer, size_t count);
void word_buffer_free(WordBuffer *buffer);

// Forgets the sections of a frame whose parse did not finish, before the next libaom call
void av1_record_reset_sections(AV1Parser *parser);
void av1_record_free_sections(AV1Parser *parser);
// Builds the record of the frame libaom just parsed, from the decoder's state before the reference update
void av1_record_build_frame(AV1Parser *parser, ParserPicture *picture);
// Builds the record of a show_existing_frame that outputs a frame buffer; returns 0, or -1 with the parser's error set
int av1_record_build_show_existing(AV1Parser *parser, ParserPicture *picture,
                                   uint32_t frame_buffer);

#endif  // AV1_PARSER_H_
