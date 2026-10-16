// Builds each frame's GPU record from the hooks the patched libaom calls (av1/decoder/parser_hooks.h) while it parses.
// The record layout is av1.wgsl's, which record_layout.mjs generates av1_record_layout.h from; scratch/av1/DESIGN.md describes it.
// The hooks append the frame's sections in decode order: coding blocks with their side data, each superblock's intra jobs per plane,
// and transform jobs with their coefficient payloads. av1_record_build_frame() adds the superblocks' CDEF indices, the restoration
// units, and the header, and joins it all into the picture's record.

#include <string.h>

#include "av1/common/av1_common_int.h"
#include "av1/common/av1_loopfilter.h"
#include "av1/common/blockd.h"
#include "av1/common/cdef_block.h"
#include "av1/common/cfl.h"
#include "av1/common/reconinter.h"
#include "av1/common/reconintra.h"
#include "av1/common/resize.h"
#include "av1/common/restoration.h"
#include "av1/common/scale.h"
#include "av1/decoder/parser_hooks.h"

#include "av1_parser.h"

// The checksums' multiplier, Knuth's multiplicative hash constant
#define CHECKSUM_MULTIPLIER 2654435761u
// The CDEF secondary strength libaom codes as 3, which applies as 4
#define CDEF_CODED_SECONDARY_THREE 3
#define CDEF_APPLIED_SECONDARY_THREE 4
// The wavefront's superblock slope: two superblocks per row for intra edges, and wider for IntraBC's delay (av1_is_dv_valid)
#define WAVE_SLOPE_INTRA 2u
#define WAVE_SLOPE_INTRABC_64 5u
#define WAVE_SLOPE_INTRABC_128 3u
// Packing
#define BYTE_BITS 8u
#define BYTES_PER_WORD 4u
#define WORD_BITS 32u
#define HALF_WORD_BITS 16u
#define HALF_WORD_MASK 0xFFFFu
#define BYTE_MASK 0xFFu
#define FILM_GRAIN_OFFSET_MASK 0x1FFu
#define KIBIBYTE_SHIFT 10u
#define RECORD_PACKET_WORDS (RECORD_PACKET_BYTES / BYTES_PER_WORD)
// No superblock is being parsed
#define NO_SUPERBLOCK 0xFFFFFFFFu
// A section without a count field: the superblocks, which the superblock grid counts
#define NO_COUNT_FIELD 0xFFFFFFFFu
// A transform codes at most 32 coefficients per side: a 64-sample side codes its first 32
#define CODED_TRANSFORM_SIDE_MAXIMUM 32u
// A CDEF unit is 64x64 samples: log2 of its side in 4x4 units, and the units across a 128x128 superblock
#define CDEF_UNIT_MODE_INFO_LOG2 4u
#define CDEF_UNITS_PER_SUPERBLOCK_128 2u
// A palette color index map packs 4 bits per sample
#define PALETTE_INDICES_PER_WORD (WORD_BITS / RECORD_PALETTE_INDEX_BITS)
#define PALETTE_COLORS_PER_WORD 2u
// The palette's color words per plane
#define PALETTE_COLOR_WORDS_PER_PLANE (PALETTE_MAX_SIZE / PALETTE_COLORS_PER_WORD)
// The Wiener taps a restoration unit codes per direction, and the biases that make them non-negative
#define WIENER_CODED_TAPS 3u

// The frame's filter passes, as libaom's wrap-up decides them
typedef struct FrameFilters {
  int deblock;
  int cdef;
  int superres;
  int restoration;
} FrameFilters;

// Adds to one of the frame's counts
static void count_statistic(AV1Parser *parser, uint32_t statistic, uint32_t amount) {
  parser->statistics[statistic] += amount;
}

// Mixes a value into one of the frame's checksums
static void mix_checksum(AV1Parser *parser, uint32_t statistic, uint32_t value) {
  parser->statistics[statistic] =
      parser->statistics[statistic] * CHECKSUM_MULTIPLIER + value;
}

static uint32_t to_kibibytes(size_t words) {
  return (uint32_t)((words * sizeof(uint32_t)) >> KIBIBYTE_SHIFT);
}

// Ends the running libaom call with a parser failure. The hooks and the record builder run inside libaom's decode call, whose
// error path holds a jump buffer, so libaom's error unwinds to av1_receive_compressed_data() and never returns here
__attribute__((noreturn)) static void fail_frame(AV1Parser *parser,
                                                 uint32_t error_code,
                                                 uint32_t error_value) {
  parser->error_code = error_code;
  parser->error_value = error_value & ERROR_VALUE_MASK;
  aom_internal_error(&parser->decoder->error, AOM_CODEC_ERROR,
                     "WebGPU Player parser failure %u: %u",
                     (unsigned int)error_code, (unsigned int)error_value);
  __builtin_trap();
}

// Grows a section of the record by zeroed words within the packet bound; returns the new words
static uint32_t *reserve_record_words(AV1Parser *parser, WordBuffer *section,
                                      size_t count) {
  FrameSections *const sections = &parser->sections;
  const size_t record_words = sections->record_words + count;
  if (record_words > RECORD_PACKET_WORDS) {
    fail_frame(parser, ERROR_RECORD_SIZE, to_kibibytes(record_words));
  }
  const size_t first = section->count;
  if (word_buffer_resize(section, first + count) != 0) {
    fail_frame(parser, ERROR_PARSER_MEMORY, to_kibibytes(first + count));
  }
  sections->record_words = record_words;
  return section->words + first;
}

// Grows a working buffer that is no part of the record; returns the new words
static uint32_t *reserve_working_words(AV1Parser *parser, WordBuffer *buffer,
                                       size_t count) {
  const size_t first = buffer->count;
  if (word_buffer_resize(buffer, first + count) != 0) {
    fail_frame(parser, ERROR_PARSER_MEMORY, to_kibibytes(first + count));
  }
  return buffer->words + first;
}

// The frame's filter passes: none for IntraBC frames, and CDEF none for coded lossless ones
static FrameFilters get_frame_filters(const AV1_COMMON *common) {
  FrameFilters filters = { 0, 0, 0, 0 };
  if (common->features.allow_intrabc || common->tiles.single_tile_decoding) {
    return filters;
  }
  filters.deblock = common->lf.filter_level[0] || common->lf.filter_level[1];
  filters.cdef = !common->features.coded_lossless &&
                 (common->cdef_info.cdef_bits ||
                  common->cdef_info.cdef_strengths[0] ||
                  common->cdef_info.cdef_uv_strengths[0]);
  filters.superres = av1_superres_scaled(common);
  for (int plane = 0; plane < av1_num_planes(common); ++plane) {
    filters.restoration |=
        common->rst_info[plane].frame_restoration_type != RESTORE_NONE;
  }
  return filters;
}

// The planes deblocking filters: none when both luma levels are 0, as libaom's loop filter skips the frame
static uint32_t get_deblock_planes(const AV1_COMMON *common, int deblock) {
  if (!deblock) return 0;
  const int plane_count = av1_num_planes(common);
  uint32_t planes = 1u << AOM_PLANE_Y;
  if (plane_count > 1 && common->lf.filter_level_u) planes |= 1u << AOM_PLANE_U;
  if (plane_count > 1 && common->lf.filter_level_v) planes |= 1u << AOM_PLANE_V;
  return planes;
}

// The wavefront's superblock slope of the frame
static uint32_t get_wave_slope(const AV1_COMMON *common) {
  if (!common->features.allow_intrabc) return WAVE_SLOPE_INTRA;
  return common->seq_params->sb_size == BLOCK_128X128 ? WAVE_SLOPE_INTRABC_128
                                                      : WAVE_SLOPE_INTRABC_64;
}

void av1_record_reset_sections(AV1Parser *parser) {
  parser->sections.started = 0;
}

void av1_record_free_sections(AV1Parser *parser) {
  FrameSections *const sections = &parser->sections;
  WordBuffer *const buffers[] = {
    &sections->superblocks,    &sections->blocks,
    &sections->side_data,      &sections->intra_jobs,
    &sections->transform_jobs, &sections->large_transform_jobs,
    &sections->coefficients,   &sections->restoration_units,
    &sections->coded_cdef_units,
    &sections->plane_jobs[AOM_PLANE_Y], &sections->plane_jobs[AOM_PLANE_U],
    &sections->plane_jobs[AOM_PLANE_V]
  };
  for (size_t index = 0; index < sizeof(buffers) / sizeof(*buffers); ++index) {
    word_buffer_free(buffers[index]);
  }
  sections->started = 0;
}

// Sizes the frame's sections at its first hook, once libaom read the frame header
static void start_sections(AV1Parser *parser) {
  FrameSections *const sections = &parser->sections;
  if (sections->started) return;
  AV1_COMMON *const common = &parser->decoder->common;
  const SequenceHeader *const sequence = common->seq_params;
  sections->started = 1;
  sections->superblock_size_log2 = (uint32_t)sequence->mib_size_log2;
  const uint32_t superblock_mode_info = 1u << sections->superblock_size_log2;
  sections->superblock_columns =
      ((uint32_t)common->mi_params.mi_cols + superblock_mode_info - 1u) >>
      sections->superblock_size_log2;
  sections->superblock_rows =
      ((uint32_t)common->mi_params.mi_rows + superblock_mode_info - 1u) >>
      sections->superblock_size_log2;
  sections->wave_slope = get_wave_slope(common);
  const uint32_t cdef_unit_mode_info = 1u << CDEF_UNIT_MODE_INFO_LOG2;
  sections->cdef_unit_columns =
      ((uint32_t)common->mi_params.mi_cols + cdef_unit_mode_info - 1u) >>
      CDEF_UNIT_MODE_INFO_LOG2;
  sections->cdef_unit_rows =
      ((uint32_t)common->mi_params.mi_rows + cdef_unit_mode_info - 1u) >>
      CDEF_UNIT_MODE_INFO_LOG2;
  sections->deblock_planes =
      get_deblock_planes(common, get_frame_filters(common).deblock);
  sections->record_words = RECORD_HEADER_WORDS;
  sections->superblock = NO_SUPERBLOCK;
  sections->superblock_wave = 0;
  sections->residual_planes = 0;
  sections->block_residuals = 0;
  sections->wave_count = 0;
  WordBuffer *const buffers[] = {
    &sections->superblocks,    &sections->blocks,
    &sections->side_data,      &sections->intra_jobs,
    &sections->transform_jobs, &sections->large_transform_jobs,
    &sections->coefficients,   &sections->restoration_units,
    &sections->coded_cdef_units,
    &sections->plane_jobs[AOM_PLANE_Y], &sections->plane_jobs[AOM_PLANE_U],
    &sections->plane_jobs[AOM_PLANE_V]
  };
  for (size_t index = 0; index < sizeof(buffers) / sizeof(*buffers); ++index) {
    buffers[index]->count = 0;
  }
  reserve_record_words(parser, &sections->superblocks,
                       (size_t)sections->superblock_columns *
                           sections->superblock_rows * RECORD_SUPERBLOCK_WORDS);
  reserve_working_words(
      parser, &sections->coded_cdef_units,
      (size_t)sections->cdef_unit_columns * sections->cdef_unit_rows);
  // The blocks' deblocking levels read the frame's level table, which the loop filter would set up before filtering
  if (sections->deblock_planes != 0) {
    av1_loop_filter_frame_init(common, AOM_PLANE_Y, av1_num_planes(common));
  }
}

// Moves the parsed superblock's intra job lists into the intra job section, after the lists of the superblocks parsed before it
static void flush_superblock(AV1Parser *parser) {
  FrameSections *const sections = &parser->sections;
  if (sections->superblock == NO_SUPERBLOCK) return;
  static const uint32_t first_job_fields[RECORD_PLANES] = {
    RECORD_SUPERBLOCK_JOBS_Y, RECORD_SUPERBLOCK_JOBS_U, RECORD_SUPERBLOCK_JOBS_V
  };
  static const uint32_t job_count_fields[RECORD_PLANES] = {
    RECORD_SUPERBLOCK_JOB_COUNT_Y, RECORD_SUPERBLOCK_JOB_COUNT_U,
    RECORD_SUPERBLOCK_JOB_COUNT_V
  };
  for (uint32_t plane = 0; plane < RECORD_PLANES; ++plane) {
    WordBuffer *const list = &sections->plane_jobs[plane];
    const uint32_t first_job =
        (uint32_t)(sections->intra_jobs.count / RECORD_INTRA_JOB_WORDS);
    const uint32_t job_count = (uint32_t)(list->count / RECORD_INTRA_JOB_WORDS);
    uint32_t *const entry = sections->superblocks.words +
                            (size_t)sections->superblock * RECORD_SUPERBLOCK_WORDS;
    entry[first_job_fields[plane]] = first_job;
    entry[job_count_fields[plane]] = job_count;
    if (job_count == 0) continue;
    uint32_t *const jobs =
        reserve_record_words(parser, &sections->intra_jobs, list->count);
    memcpy(jobs, list->words, list->count * sizeof(uint32_t));
    list->count = 0;
    // Chroma runs a wave behind luma, so chroma from luma reads its block's reconstructed luma
    const uint32_t wave = sections->superblock_wave +
                          (plane == AOM_PLANE_Y ? 0u : RECORD_WAVE_CHROMA_LAG);
    if (wave + 1u > sections->wave_count) sections->wave_count = wave + 1u;
  }
  sections->superblock = NO_SUPERBLOCK;
}

// Makes the superblock of the block being parsed the current one: superblocks parse one after another, each completely
static void enter_superblock(AV1Parser *parser, const MACROBLOCKD *macroblock) {
  FrameSections *const sections = &parser->sections;
  const uint32_t row = (uint32_t)macroblock->mi_row >> sections->superblock_size_log2;
  const uint32_t column = (uint32_t)macroblock->mi_col >> sections->superblock_size_log2;
  const uint32_t superblock = row * sections->superblock_columns + column;
  if (superblock == sections->superblock) return;
  flush_superblock(parser);
  if (row >= sections->superblock_rows || column >= sections->superblock_columns) {
    fail_frame(parser, ERROR_PICTURE_SIZE, row >= sections->superblock_rows ? row : column);
  }
  sections->superblock = superblock;
  // Its wave: its column plus the slope times its row, within its tile
  const TileInfo *const tile = &macroblock->tile;
  const uint32_t tile_row = (uint32_t)tile->mi_row_start >> sections->superblock_size_log2;
  const uint32_t tile_column = (uint32_t)tile->mi_col_start >> sections->superblock_size_log2;
  sections->superblock_wave =
      (column - tile_column) + sections->wave_slope * (row - tile_row);
  sections->superblocks.words[(size_t)superblock * RECORD_SUPERBLOCK_WORDS +
                              RECORD_SUPERBLOCK_TILE] =
      (uint32_t)tile->tile_col |
      ((uint32_t)tile->tile_row << RECORD_SUPERBLOCK_TILE_ROW_SHIFT);
}

// Adds an intra job to the current superblock's list of its plane
static void append_plane_job(AV1Parser *parser, int plane,
                             const uint32_t words[RECORD_INTRA_JOB_WORDS]) {
  uint32_t *const job = reserve_working_words(
      parser, &parser->sections.plane_jobs[plane], RECORD_INTRA_JOB_WORDS);
  memcpy(job, words, RECORD_INTRA_JOB_WORDS * sizeof(uint32_t));
}

// The origin of a block's plane block in 4x4 units of the plane: a chroma block of a group of blocks narrower or shorter than 8
// sits at the group's origin, as libaom's setup_pred_plane() places it
static void get_plane_origin(const MACROBLOCKD *macroblock, int plane,
                             uint32_t *x4, uint32_t *y4) {
  const struct macroblockd_plane *const plane_descriptor = &macroblock->plane[plane];
  const BLOCK_SIZE block_size = macroblock->mi[0]->bsize;
  int mode_info_row = macroblock->mi_row;
  int mode_info_column = macroblock->mi_col;
  if (plane_descriptor->subsampling_y && (mode_info_row & 1) &&
      mi_size_high[block_size] == 1) {
    mode_info_row -= 1;
  }
  if (plane_descriptor->subsampling_x && (mode_info_column & 1) &&
      mi_size_wide[block_size] == 1) {
    mode_info_column -= 1;
  }
  *x4 = ((uint32_t)(MI_SIZE * mode_info_column) >> plane_descriptor->subsampling_x) >>
        MI_SIZE_LOG2;
  *y4 = ((uint32_t)(MI_SIZE * mode_info_row) >> plane_descriptor->subsampling_y) >>
        MI_SIZE_LOG2;
}

// The bits a two's complement value needs
static uint32_t get_signed_bits(int32_t value) {
  const uint32_t magnitude = (uint32_t)(value ^ (value >> (WORD_BITS - 1u)));
  return magnitude == 0 ? 1u : WORD_BITS + 1u - (uint32_t)__builtin_clz(magnitude);
}

// Writes the low bits of a value into a payload at a bit position, least significant bit first
static void write_payload_bits(uint32_t *payload, size_t bit_position,
                               uint32_t value, uint32_t bit_count) {
  const uint32_t masked = bit_count == WORD_BITS ? value : value & ((1u << bit_count) - 1u);
  const size_t word = bit_position / WORD_BITS;
  const uint32_t shift = (uint32_t)(bit_position % WORD_BITS);
  payload[word] |= masked << shift;
  if (shift + bit_count > WORD_BITS) payload[word + 1] |= masked >> (WORD_BITS - shift);
}

// Takes a transform block's coefficients: when it has any, appends its transform job and its coefficient payload, dense or sparse,
// whichever is smaller. Clears them as libaom's reconstruction would, since libaom writes only nonzero coefficients into a zeroed
// buffer. Returns 1 when the block has a residual.
static uint32_t take_transform_block(AV1Parser *parser,
                                     DecoderCodingBlock *coding_block, int plane,
                                     uint32_t x4, uint32_t y4,
                                     TX_SIZE transform_size,
                                     TX_TYPE transform_type,
                                     uint32_t destination, int lossless) {
  const eob_info *const end_of_block =
      coding_block->eob_data[plane] + coding_block->txb_offset[plane];
  if (end_of_block->eob == 0) return 0;
  tran_low_t *const coefficients =
      coding_block->dqcoeff_block[plane] + coding_block->cb_offset[plane];
  const uint32_t last_position = end_of_block->max_scan_line;
  // libaom's coefficient positions are column * coded height + row
  const uint32_t coded_height =
      AOMMIN((uint32_t)tx_size_high[transform_size], CODED_TRANSFORM_SIDE_MAXIMUM);
  uint32_t nonzero_count = 0;
  uint32_t box_columns = 0;
  uint32_t box_rows = 0;
  uint32_t value_bits = 1;
  for (uint32_t position = 0; position <= last_position; ++position) {
    const int32_t value = coefficients[position];
    if (value == 0) continue;
    nonzero_count += 1;
    box_columns = AOMMAX(box_columns, position / coded_height + 1u);
    box_rows = AOMMAX(box_rows, position % coded_height + 1u);
    value_bits = AOMMAX(value_bits, get_signed_bits(value));
    mix_checksum(parser, RECORD_STATISTIC_COEFFICIENT_CHECKSUM,
                 (uint32_t)value + position);
  }
  if (nonzero_count == 0) {
    memset(coefficients, 0, (last_position + 1) * sizeof(*coefficients));
    return 0;
  }
  count_statistic(parser, RECORD_STATISTIC_NONZERO_COEFFICIENTS, nonzero_count);
  count_statistic(parser, RECORD_STATISTIC_CODED_TRANSFORM_BLOCKS, 1);

  const size_t dense_bits = (size_t)box_columns * box_rows * value_bits;
  const size_t sparse_bits =
      (size_t)nonzero_count * (RECORD_TRANSFORM_JOB_POSITION_BITS + value_bits);
  const uint32_t sparse = sparse_bits < dense_bits;
  const size_t payload_bits = sparse ? sparse_bits : dense_bits;
  FrameSections *const sections = &parser->sections;
  const uint32_t payload_offset = (uint32_t)sections->coefficients.count;
  uint32_t *const payload = reserve_record_words(
      parser, &sections->coefficients, (payload_bits + WORD_BITS - 1u) / WORD_BITS);
  size_t bit_position = 0;
  if (sparse) {
    for (uint32_t position = 0; position <= last_position; ++position) {
      const int32_t value = coefficients[position];
      if (value == 0) continue;
      write_payload_bits(payload, bit_position, position,
                         RECORD_TRANSFORM_JOB_POSITION_BITS);
      bit_position += RECORD_TRANSFORM_JOB_POSITION_BITS;
      write_payload_bits(payload, bit_position, (uint32_t)value, value_bits);
      bit_position += value_bits;
    }
  } else {
    for (uint32_t column = 0; column < box_columns; ++column) {
      for (uint32_t row = 0; row < box_rows; ++row) {
        write_payload_bits(payload, bit_position,
                           (uint32_t)coefficients[column * coded_height + row],
                           value_bits);
        bit_position += value_bits;
      }
    }
  }
  memset(coefficients, 0, (last_position + 1) * sizeof(*coefficients));

  const uint32_t extent = sparse
      ? (nonzero_count - 1u) << RECORD_TRANSFORM_JOB_COUNT_SHIFT
      : ((box_columns - 1u) << RECORD_TRANSFORM_JOB_BOX_COLUMNS_SHIFT) |
            ((box_rows - 1u) << RECORD_TRANSFORM_JOB_BOX_ROWS_SHIFT);
  // A job with a 64-point side joins the ones the record lists last, for the pass that holds the 64-point transforms
  WordBuffer *const jobs = txsize_sqr_up_map[transform_size] == TX_64X64
                               ? &sections->large_transform_jobs
                               : &sections->transform_jobs;
  uint32_t *const job = reserve_record_words(parser, jobs, RECORD_TRANSFORM_JOB_WORDS);
  job[RECORD_TRANSFORM_JOB_POSITION] =
      (x4 << RECORD_TRANSFORM_JOB_X4_SHIFT) | (y4 << RECORD_TRANSFORM_JOB_Y4_SHIFT) |
      ((uint32_t)transform_size << RECORD_TRANSFORM_JOB_TX_SIZE_SHIFT) |
      ((uint32_t)plane << RECORD_TRANSFORM_JOB_PLANE_SHIFT) |
      ((uint32_t)(lossless != 0) << RECORD_TRANSFORM_JOB_LOSSLESS_SHIFT);
  job[RECORD_TRANSFORM_JOB_CODING] =
      ((uint32_t)transform_type << RECORD_TRANSFORM_JOB_TX_TYPE_SHIFT) |
      (destination << RECORD_TRANSFORM_JOB_DESTINATION_SHIFT) |
      (sparse << RECORD_TRANSFORM_JOB_SPARSE_SHIFT) |
      (value_bits << RECORD_TRANSFORM_JOB_VALUE_BITS_SHIFT) |
      ((uint32_t)end_of_block->eob << RECORD_TRANSFORM_JOB_EOB_SHIFT) | extent;
  job[RECORD_TRANSFORM_JOB_PAYLOAD] = payload_offset;
  return 1;
}

// The edge sample counts and edge filter type av1_predict_intra_block() would derive, packed as an intra job's edge word
static uint32_t get_intra_edges(AV1Parser *parser, const AV1_COMMON *common,
                                const MACROBLOCKD *macroblock, int plane,
                                TX_SIZE transform_size, PREDICTION_MODE mode,
                                int angle_delta,
                                FILTER_INTRA_MODE filter_intra_mode,
                                int column, int row) {
  const struct macroblockd_plane *const plane_descriptor = &macroblock->plane[plane];
  int top_count = 0;
  int top_right_count = 0;
  int left_count = 0;
  int bottom_left_count = 0;
  int edge_filter_type = 0;
  av1_parser_intra_edges(macroblock, common->seq_params->sb_size,
                         plane_descriptor->width, plane_descriptor->height,
                         transform_size, mode, angle_delta, filter_intra_mode,
                         column, row, plane, &top_count, &top_right_count,
                         &left_count, &bottom_left_count, &edge_filter_type);
  mix_checksum(parser, RECORD_STATISTIC_EDGE_CHECKSUM, (uint32_t)top_count);
  mix_checksum(parser, RECORD_STATISTIC_EDGE_CHECKSUM, (uint32_t)top_right_count);
  mix_checksum(parser, RECORD_STATISTIC_EDGE_CHECKSUM, (uint32_t)left_count);
  mix_checksum(parser, RECORD_STATISTIC_EDGE_CHECKSUM, (uint32_t)bottom_left_count);
  mix_checksum(parser, RECORD_STATISTIC_EDGE_CHECKSUM, (uint32_t)edge_filter_type);
  return ((uint32_t)top_count << RECORD_INTRA_JOB_TOP_SHIFT) |
         ((uint32_t)(top_right_count + (int)RECORD_INTRA_JOB_EDGE_BIAS)
          << RECORD_INTRA_JOB_TOP_RIGHT_SHIFT) |
         ((uint32_t)left_count << RECORD_INTRA_JOB_LEFT_SHIFT) |
         ((uint32_t)(bottom_left_count + (int)RECORD_INTRA_JOB_EDGE_BIAS)
          << RECORD_INTRA_JOB_BOTTOM_LEFT_SHIFT) |
         ((uint32_t)edge_filter_type << RECORD_INTRA_JOB_EDGE_FILTER_SHIFT);
}

// An intra job's position word
static uint32_t get_job_position(uint32_t x4, uint32_t y4, TX_SIZE transform_size,
                                 int plane, uint32_t has_residual) {
  return (x4 << RECORD_INTRA_JOB_X4_SHIFT) | (y4 << RECORD_INTRA_JOB_Y4_SHIFT) |
         ((uint32_t)transform_size << RECORD_INTRA_JOB_TX_SIZE_SHIFT) |
         ((uint32_t)plane << RECORD_INTRA_JOB_PLANE_SHIFT) |
         (has_residual << RECORD_INTRA_JOB_HAS_RESIDUAL_SHIFT);
}

// The index the block being parsed takes in the block section: its transform hooks run before its block hook appends it
static uint32_t get_next_block_index(const AV1Parser *parser) {
  return (uint32_t)(parser->sections.blocks.count / RECORD_BLOCK_WORDS);
}

void av1_parser_intra_transform_block(const AV1_COMMON *common,
                                      DecoderCodingBlock *coding_block,
                                      aom_reader *reader, int plane, int row,
                                      int column, TX_SIZE transform_size) {
  (void)reader;
  AV1Parser *const parser = av1_active_parser;
  MACROBLOCKD *const macroblock = &coding_block->xd;
  const MB_MODE_INFO *const mode_info = macroblock->mi[0];
  start_sections(parser);
  enter_superblock(parser, macroblock);
  count_statistic(parser, RECORD_STATISTIC_INTRA_TRANSFORM_BLOCKS, 1);

  uint32_t x4 = 0;
  uint32_t y4 = 0;
  get_plane_origin(macroblock, plane, &x4, &y4);
  x4 += (uint32_t)column;
  y4 += (uint32_t)row;
  // A skipped block read no coefficients, so its end-of-block data is stale
  uint32_t has_residual = 0;
  if (!mode_info->skip_txfm) {
    const TX_TYPE transform_type =
        av1_get_tx_type(macroblock, get_plane_type(plane), row, column,
                        transform_size, common->features.reduced_tx_set_used);
    has_residual = take_transform_block(
        parser, coding_block, plane, x4, y4, transform_size, transform_type,
        RECORD_TRANSFORM_DESTINATION_RESIDUAL,
        macroblock->lossless[mode_info->segment_id]);
  }

  // The edges libaom's prediction would read, and for chroma from luma the luma surface libaom stored for the block
  const PREDICTION_MODE mode = plane == AOM_PLANE_Y
                                   ? mode_info->mode
                                   : get_uv_mode(mode_info->uv_mode);
  const FILTER_INTRA_MODE filter_intra_mode =
      (plane == AOM_PLANE_Y && mode_info->filter_intra_mode_info.use_filter_intra)
          ? mode_info->filter_intra_mode_info.filter_intra_mode
          : FILTER_INTRA_MODES;
  const int angle_delta = mode_info->angle_delta[plane != AOM_PLANE_Y] * ANGLE_STEP;
  uint32_t chroma_from_luma = 0;
  if (plane != AOM_PLANE_Y && mode_info->uv_mode == UV_CFL_PRED) {
    const uint32_t size_mask = (1u << RECORD_INTRA_JOB_CFL_SIZE_BITS) - 1u;
    chroma_from_luma =
        ((((uint32_t)macroblock->cfl.buf_width >> 1) - 1u) & size_mask)
            << RECORD_INTRA_JOB_CFL_WIDTH_SHIFT |
        ((((uint32_t)macroblock->cfl.buf_height >> 1) - 1u) & size_mask)
            << RECORD_INTRA_JOB_CFL_HEIGHT_SHIFT;
  }
  const uint32_t job[RECORD_INTRA_JOB_WORDS] = {
    get_job_position(x4, y4, transform_size, plane, has_residual),
    get_next_block_index(parser) |
        (RECORD_INTRA_JOB_KIND_TRANSFORM << RECORD_INTRA_JOB_KIND_SHIFT) |
        chroma_from_luma,
    get_intra_edges(parser, common, macroblock, plane, transform_size, mode,
                    angle_delta, filter_intra_mode, column, row)
  };
  append_plane_job(parser, plane, job);
  // libaom stores the reconstructed luma a later chroma-from-luma block reads
  if (plane == AOM_PLANE_Y && store_cfl_required(common, macroblock)) {
    av1_parser_cfl_store_tx_extent(macroblock, row, column, transform_size,
                                   mode_info->bsize);
  }
}

void av1_parser_inter_transform_block(const AV1_COMMON *common,
                                      DecoderCodingBlock *coding_block,
                                      aom_reader *reader, int plane, int row,
                                      int column, TX_SIZE transform_size) {
  (void)reader;
  AV1Parser *const parser = av1_active_parser;
  MACROBLOCKD *const macroblock = &coding_block->xd;
  const MB_MODE_INFO *const mode_info = macroblock->mi[0];
  start_sections(parser);
  enter_superblock(parser, macroblock);
  count_statistic(parser, RECORD_STATISTIC_INTER_TRANSFORM_BLOCKS, 1);

  uint32_t x4 = 0;
  uint32_t y4 = 0;
  get_plane_origin(macroblock, plane, &x4, &y4);
  x4 += (uint32_t)column;
  y4 += (uint32_t)row;
  const TX_TYPE transform_type =
      av1_get_tx_type(macroblock, get_plane_type(plane), row, column,
                      transform_size, common->features.reduced_tx_set_used);
  // An inter block's residual adds to its prediction at once; IntraBC and inter-intra blocks predict in the wavefront, which adds it
  const uint32_t destination =
      (is_intrabc_block(mode_info) || is_interintra_pred(mode_info))
          ? RECORD_TRANSFORM_DESTINATION_RESIDUAL
          : RECORD_TRANSFORM_DESTINATION_TARGET;
  if (take_transform_block(parser, coding_block, plane, x4, y4, transform_size,
                           transform_type, destination,
                           macroblock->lossless[mode_info->segment_id])) {
    parser->sections.residual_planes |= 1u << plane;
  }
}

// The modes word of an intra block
static uint32_t get_intra_modes(const MB_MODE_INFO *mode_info) {
  const uint32_t filter_intra_mode =
      mode_info->filter_intra_mode_info.use_filter_intra
          ? (uint32_t)mode_info->filter_intra_mode_info.filter_intra_mode
          : RECORD_BLOCK_FILTER_INTRA_NONE;
  int alpha_u = 0;
  int alpha_v = 0;
  if (mode_info->uv_mode == UV_CFL_PRED) {
    alpha_u = av1_parser_cfl_alpha(mode_info->cfl_alpha_idx,
                                   mode_info->cfl_alpha_signs, CFL_PRED_U);
    alpha_v = av1_parser_cfl_alpha(mode_info->cfl_alpha_idx,
                                   mode_info->cfl_alpha_signs, CFL_PRED_V);
  }
  return ((uint32_t)mode_info->mode << RECORD_BLOCK_Y_MODE_SHIFT) |
         ((uint32_t)mode_info->uv_mode << RECORD_BLOCK_UV_MODE_SHIFT) |
         ((uint32_t)(mode_info->angle_delta[PLANE_TYPE_Y] +
                     (int)RECORD_BLOCK_ANGLE_DELTA_BIAS)
          << RECORD_BLOCK_ANGLE_DELTA_Y_SHIFT) |
         ((uint32_t)(mode_info->angle_delta[PLANE_TYPE_UV] +
                     (int)RECORD_BLOCK_ANGLE_DELTA_BIAS)
          << RECORD_BLOCK_ANGLE_DELTA_UV_SHIFT) |
         (filter_intra_mode << RECORD_BLOCK_FILTER_INTRA_SHIFT) |
         ((uint32_t)(alpha_u + (int)RECORD_BLOCK_CFL_ALPHA_BIAS)
          << RECORD_BLOCK_CFL_ALPHA_U_SHIFT) |
         ((uint32_t)(alpha_v + (int)RECORD_BLOCK_CFL_ALPHA_BIAS)
          << RECORD_BLOCK_CFL_ALPHA_V_SHIFT);
}

// Which warp a reference of an inter block predicts with, as av1_init_warp_params() and allow_warp() decide it before the plane
// block's own minimum of 8x8: local for a valid WARPED_CAUSAL block, global for a global motion block of a valid non-translation
// model, and none with integer motion vectors or a scaled reference
static uint32_t get_warp_kind(const AV1_COMMON *common, const MB_MODE_INFO *mode_info,
                              int reference) {
  const MV_REFERENCE_FRAME reference_frame = mode_info->ref_frame[reference];
  if (common->features.cur_frame_force_integer_mv) return RECORD_BLOCK_WARP_NONE;
  if (av1_is_scaled(get_ref_scale_factors_const(common, reference_frame))) {
    return RECORD_BLOCK_WARP_NONE;
  }
  if (mode_info->motion_mode == WARPED_CAUSAL && !mode_info->wm_params.invalid) {
    return RECORD_BLOCK_WARP_LOCAL;
  }
  const WarpedMotionParams *const global_motion = &common->global_motion[reference_frame];
  if (is_global_mv_block(mode_info, global_motion->wmtype) && !global_motion->invalid) {
    return RECORD_BLOCK_WARP_GLOBAL;
  }
  return RECORD_BLOCK_WARP_NONE;
}

// The modes word of an inter or IntraBC block
static uint32_t get_inter_modes(const AV1_COMMON *common, const MB_MODE_INFO *mode_info) {
  const int compound = has_second_ref(mode_info);
  const int intrabc = is_intrabc_block(mode_info);
  const uint32_t warp_0 = intrabc ? RECORD_BLOCK_WARP_NONE : get_warp_kind(common, mode_info, 0);
  const uint32_t warp_1 =
      compound && get_warp_kind(common, mode_info, 1) == RECORD_BLOCK_WARP_GLOBAL;
  return ((uint32_t)(mode_info->ref_frame[0] + (int)RECORD_BLOCK_REFERENCE_BIAS)
          << RECORD_BLOCK_REFERENCE_0_SHIFT) |
         ((uint32_t)(mode_info->ref_frame[1] + (int)RECORD_BLOCK_REFERENCE_BIAS)
          << RECORD_BLOCK_REFERENCE_1_SHIFT) |
         ((uint32_t)mode_info->motion_mode << RECORD_BLOCK_MOTION_MODE_SHIFT) |
         ((uint32_t)mode_info->interp_filters.as_filters.x_filter
          << RECORD_BLOCK_FILTER_X_SHIFT) |
         ((uint32_t)mode_info->interp_filters.as_filters.y_filter
          << RECORD_BLOCK_FILTER_Y_SHIFT) |
         (warp_0 << RECORD_BLOCK_WARP_0_SHIFT) | (warp_1 << RECORD_BLOCK_WARP_1_SHIFT) |
         ((uint32_t)(compound ? mode_info->interinter_comp.type : COMPOUND_AVERAGE)
          << RECORD_BLOCK_COMPOUND_TYPE_SHIFT) |
         ((uint32_t)(is_interintra_pred(mode_info) != 0) << RECORD_BLOCK_INTERINTRA_SHIFT);
}

// The motion extension's compound word: the masks, the inter-intra mode, the distance weights, and the inter mode
static uint32_t get_compound_word(const AV1_COMMON *common, const MB_MODE_INFO *mode_info) {
  uint32_t word = (uint32_t)mode_info->mode << RECORD_MOTION_INTER_MODE_SHIFT;
  if (has_second_ref(mode_info)) {
    const INTERINTER_COMPOUND_DATA *const compound = &mode_info->interinter_comp;
    switch (compound->type) {
      case COMPOUND_WEDGE:
        word |= ((uint32_t)compound->wedge_index << RECORD_MOTION_WEDGE_INDEX_SHIFT) |
                ((uint32_t)compound->wedge_sign << RECORD_MOTION_WEDGE_SIGN_SHIFT);
        break;
      case COMPOUND_DIFFWTD:
        word |= (uint32_t)compound->mask_type << RECORD_MOTION_MASK_TYPE_SHIFT;
        break;
      default: break;
    }
    int forward_offset = 0;
    int backward_offset = 0;
    int use_distance_weights = 0;
    av1_dist_wtd_comp_weight_assign(common, mode_info, &forward_offset,
                                    &backward_offset, &use_distance_weights, 1);
    word |= ((uint32_t)forward_offset << RECORD_MOTION_DISTANCE_FORWARD_SHIFT) |
            ((uint32_t)backward_offset << RECORD_MOTION_DISTANCE_BACKWARD_SHIFT);
  }
  if (is_interintra_pred(mode_info)) {
    word |= ((uint32_t)mode_info->interintra_mode << RECORD_MOTION_INTERINTRA_MODE_SHIFT) |
            ((uint32_t)(mode_info->use_wedge_interintra != 0)
             << RECORD_MOTION_INTERINTRA_WEDGE_SHIFT) |
            ((uint32_t)mode_info->interintra_wedge_index
             << RECORD_MOTION_INTERINTRA_WEDGE_INDEX_SHIFT);
  }
  return word;
}

// Packs two signed 16-bit values into a word, the first in the low half
static uint32_t pack_halves(int32_t low, int32_t high) {
  return ((uint32_t)low & HALF_WORD_MASK) |
         (((uint32_t)high & HALF_WORD_MASK) << HALF_WORD_BITS);
}

// Writes a warp model: its six matrix entries, then alpha and beta, then gamma and delta
static void write_warp_model(uint32_t *words, const WarpedMotionParams *model) {
  for (uint32_t entry = 0; entry < MAX_PARAMDIM; ++entry) {
    words[RECORD_LOCAL_WARP_MATRIX + entry] = (uint32_t)model->wmmat[entry];
  }
  words[RECORD_LOCAL_WARP_ALPHA_BETA] = pack_halves(model->alpha, model->beta);
  words[RECORD_LOCAL_WARP_GAMMA_DELTA] = pack_halves(model->gamma, model->delta);
}

// Writes the palette extension: the colors, the sizes, and the color index maps the block's planes read
static void write_palette(AV1Parser *parser, const MACROBLOCKD *macroblock,
                          const MB_MODE_INFO *mode_info) {
  const PALETTE_MODE_INFO *const palette = &mode_info->palette_mode_info;
  int map_widths[PLANE_TYPES] = { 0, 0 };
  int map_heights[PLANE_TYPES] = { 0, 0 };
  size_t map_words = 0;
  for (int plane_type = 0; plane_type < PLANE_TYPES; ++plane_type) {
    if (palette->palette_size[plane_type] == 0) continue;
    av1_get_block_dimensions(mode_info->bsize, plane_type, macroblock,
                             &map_widths[plane_type], &map_heights[plane_type],
                             NULL, NULL);
    const size_t samples = (size_t)map_widths[plane_type] * (size_t)map_heights[plane_type];
    map_words += (samples + PALETTE_INDICES_PER_WORD - 1u) / PALETTE_INDICES_PER_WORD;
  }
  FrameSections *const sections = &parser->sections;
  uint32_t *const words = reserve_record_words(
      parser, &sections->side_data, RECORD_PALETTE_HEADER_WORDS + map_words);
  static const uint32_t color_words[RECORD_PLANES] = {
    RECORD_PALETTE_COLORS_Y, RECORD_PALETTE_COLORS_U, RECORD_PALETTE_COLORS_V
  };
  for (uint32_t plane = 0; plane < RECORD_PLANES; ++plane) {
    const uint32_t size = palette->palette_size[plane != AOM_PLANE_Y];
    for (uint32_t color = 0; color < size; ++color) {
      words[color_words[plane] + color / PALETTE_COLORS_PER_WORD] |=
          (uint32_t)palette->palette_colors[plane * PALETTE_MAX_SIZE + color]
          << (HALF_WORD_BITS * (color % PALETTE_COLORS_PER_WORD));
    }
  }
  words[RECORD_PALETTE_SIZES] =
      ((uint32_t)palette->palette_size[0] << RECORD_PALETTE_SIZE_Y_SHIFT) |
      ((uint32_t)palette->palette_size[1] << RECORD_PALETTE_SIZE_UV_SHIFT);
  // The maps decode_token_recon_block() just moved past: libaom's color index map, extended past the frame edge
  uint32_t *map_word = words + RECORD_PALETTE_HEADER_WORDS;
  for (int plane_type = 0; plane_type < PLANE_TYPES; ++plane_type) {
    if (palette->palette_size[plane_type] == 0) continue;
    const size_t samples = (size_t)map_widths[plane_type] * (size_t)map_heights[plane_type];
    const uint8_t *const map = macroblock->plane[plane_type].color_index_map +
                               macroblock->color_index_map_offset[plane_type] - samples;
    for (size_t sample = 0; sample < samples; ++sample) {
      map_word[sample / PALETTE_INDICES_PER_WORD] |=
          (uint32_t)map[sample] << (RECORD_PALETTE_INDEX_BITS * (sample % PALETTE_INDICES_PER_WORD));
    }
    map_word += (samples + PALETTE_INDICES_PER_WORD - 1u) / PALETTE_INDICES_PER_WORD;
  }
}

// Writes a block's extensions into the side data section; returns its extension word
static uint32_t write_block_extensions(AV1Parser *parser, const AV1_COMMON *common,
                                       const MACROBLOCKD *macroblock,
                                       const MB_MODE_INFO *mode_info) {
  FrameSections *const sections = &parser->sections;
  const uint32_t offset = (uint32_t)sections->side_data.count;
  uint32_t presence = 0;
  if (is_inter_block(mode_info)) {
    presence |= 1u << RECORD_BLOCK_HAS_MOTION_SHIFT;
    uint32_t *const motion =
        reserve_record_words(parser, &sections->side_data, RECORD_MOTION_WORDS);
    motion[RECORD_MOTION_VECTOR_0] = mode_info->mv[0].as_int;
    motion[RECORD_MOTION_VECTOR_1] = has_second_ref(mode_info) ? mode_info->mv[1].as_int : 0u;
    motion[RECORD_MOTION_COMPOUND] = get_compound_word(common, mode_info);
    if (mode_info->motion_mode == WARPED_CAUSAL && !mode_info->wm_params.invalid) {
      presence |= 1u << RECORD_BLOCK_HAS_LOCAL_WARP_SHIFT;
      write_warp_model(reserve_record_words(parser, &sections->side_data, RECORD_LOCAL_WARP_WORDS),
                       &mode_info->wm_params);
    }
    if (!mode_info->skip_txfm) {
      presence |= 1u << RECORD_BLOCK_HAS_VARIABLE_TX_SHIFT;
      uint32_t *const sizes =
          reserve_record_words(parser, &sections->side_data, RECORD_VARIABLE_TX_WORDS);
      for (uint32_t index = 0; index < INTER_TX_SIZE_BUF_LEN; ++index) {
        sizes[index / BYTES_PER_WORD] |= (uint32_t)mode_info->inter_tx_size[index]
                                         << (BYTE_BITS * (index % BYTES_PER_WORD));
      }
    }
  } else if (mode_info->palette_mode_info.palette_size[0] > 0 ||
             mode_info->palette_mode_info.palette_size[1] > 0) {
    presence |= 1u << RECORD_BLOCK_HAS_PALETTE_SHIFT;
    write_palette(parser, macroblock, mode_info);
  }
  return presence == 0 ? 0u : offset | presence;
}

// Adds the wavefront jobs of an IntraBC or inter-intra block, one per plane it predicts, after its transform blocks
static void append_block_jobs(AV1Parser *parser, const AV1_COMMON *common,
                              const MACROBLOCKD *macroblock,
                              const MB_MODE_INFO *mode_info, uint32_t block_index) {
  const int intrabc = is_intrabc_block(mode_info);
  const int interintra = is_interintra_pred(mode_info);
  if (!intrabc && !interintra) return;
  for (int plane = 0; plane < av1_num_planes(common); ++plane) {
    if (plane != AOM_PLANE_Y && !macroblock->is_chroma_ref) break;
    uint32_t x4 = 0;
    uint32_t y4 = 0;
    get_plane_origin(macroblock, plane, &x4, &y4);
    const uint32_t has_residual = (parser->sections.residual_planes >> plane) & 1u;
    parser->sections.block_residuals |= (int)has_residual;
    uint32_t job[RECORD_INTRA_JOB_WORDS] = { 0, 0, 0 };
    if (interintra) {
      // av1_build_intra_predictors_for_interintra(): the plane block's intra prediction at its largest transform size
      const struct macroblockd_plane *const plane_descriptor = &macroblock->plane[plane];
      const BLOCK_SIZE plane_block_size =
          get_plane_block_size(mode_info->bsize, plane_descriptor->subsampling_x,
                               plane_descriptor->subsampling_y);
      const TX_SIZE transform_size = max_txsize_rect_lookup[plane_block_size];
      job[RECORD_INTRA_JOB_POSITION] =
          get_job_position(x4, y4, transform_size, plane, has_residual);
      job[RECORD_INTRA_JOB_BLOCK] =
          block_index | (RECORD_INTRA_JOB_KIND_INTERINTRA << RECORD_INTRA_JOB_KIND_SHIFT);
      job[RECORD_INTRA_JOB_EDGES] = get_intra_edges(
          parser, common, macroblock, plane, transform_size,
          interintra_to_intra_mode[mode_info->interintra_mode], 0,
          FILTER_INTRA_MODES, 0, 0);
    } else {
      job[RECORD_INTRA_JOB_POSITION] = get_job_position(x4, y4, TX_4X4, plane, has_residual);
      job[RECORD_INTRA_JOB_BLOCK] =
          block_index | (RECORD_INTRA_JOB_KIND_INTRABC << RECORD_INTRA_JOB_KIND_SHIFT);
    }
    append_plane_job(parser, plane, job);
  }
}

// Marks the CDEF units a block with coefficients covers within the frame: CDEF filters the units that hold one
static void mark_coded_cdef_units(FrameSections *sections, int mode_info_row,
                                  int mode_info_column, BLOCK_SIZE block_size) {
  const uint32_t first_row = (uint32_t)mode_info_row >> CDEF_UNIT_MODE_INFO_LOG2;
  const uint32_t first_column = (uint32_t)mode_info_column >> CDEF_UNIT_MODE_INFO_LOG2;
  const uint32_t last_row = AOMMIN(
      (uint32_t)(mode_info_row + mi_size_high[block_size] - 1) >> CDEF_UNIT_MODE_INFO_LOG2,
      sections->cdef_unit_rows - 1u);
  const uint32_t last_column = AOMMIN(
      (uint32_t)(mode_info_column + mi_size_wide[block_size] - 1) >> CDEF_UNIT_MODE_INFO_LOG2,
      sections->cdef_unit_columns - 1u);
  for (uint32_t row = first_row; row <= last_row; ++row) {
    for (uint32_t column = first_column; column <= last_column; ++column) {
      sections->coded_cdef_units.words[row * sections->cdef_unit_columns + column] = 1;
    }
  }
}

// The block's deblocking levels in the planes the frame deblocks, as av1_loopfilter.c's get_filter_level() derives them
static uint32_t get_block_levels(const FrameSections *sections, const AV1_COMMON *common,
                                 const MB_MODE_INFO *mode_info) {
  uint32_t levels = 0;
  if (sections->deblock_planes & (1u << AOM_PLANE_Y)) {
    levels |= (uint32_t)av1_parser_filter_level(common, 0, AOM_PLANE_Y, mode_info)
              << RECORD_BLOCK_LEVEL_Y_VERTICAL_SHIFT;
    levels |= (uint32_t)av1_parser_filter_level(common, 1, AOM_PLANE_Y, mode_info)
              << RECORD_BLOCK_LEVEL_Y_HORIZONTAL_SHIFT;
  }
  if (sections->deblock_planes & (1u << AOM_PLANE_U)) {
    levels |= (uint32_t)av1_parser_filter_level(common, 0, AOM_PLANE_U, mode_info)
              << RECORD_BLOCK_LEVEL_U_SHIFT;
  }
  if (sections->deblock_planes & (1u << AOM_PLANE_V)) {
    levels |= (uint32_t)av1_parser_filter_level(common, 0, AOM_PLANE_V, mode_info)
              << RECORD_BLOCK_LEVEL_V_SHIFT;
  }
  return levels;
}

// Counts a block into the frame's statistics
static void count_block(AV1Parser *parser, const MACROBLOCKD *macroblock,
                        const MB_MODE_INFO *mode_info) {
  count_statistic(parser, RECORD_STATISTIC_BLOCKS, 1);
  if (mode_info->skip_txfm) count_statistic(parser, RECORD_STATISTIC_SKIP_BLOCKS, 1);
  if (is_intrabc_block(mode_info)) {
    count_statistic(parser, RECORD_STATISTIC_INTRABC_BLOCKS, 1);
    return;
  }
  if (is_inter_block(mode_info)) {
    count_statistic(parser, RECORD_STATISTIC_INTER_BLOCKS, 1);
    if (has_second_ref(mode_info)) count_statistic(parser, RECORD_STATISTIC_COMPOUND_BLOCKS, 1);
    switch (mode_info->motion_mode) {
      case OBMC_CAUSAL: count_statistic(parser, RECORD_STATISTIC_OBMC_BLOCKS, 1); break;
      case WARPED_CAUSAL: count_statistic(parser, RECORD_STATISTIC_WARPED_BLOCKS, 1); break;
      default: break;
    }
    return;
  }
  count_statistic(parser, RECORD_STATISTIC_INTRA_BLOCKS, 1);
  if (mode_info->palette_mode_info.palette_size[0] > 0 ||
      mode_info->palette_mode_info.palette_size[1] > 0) {
    count_statistic(parser, RECORD_STATISTIC_PALETTE_BLOCKS, 1);
  }
  if (macroblock->is_chroma_ref && mode_info->uv_mode == UV_CFL_PRED) {
    count_statistic(parser, RECORD_STATISTIC_CFL_BLOCKS, 1);
  }
}

void av1_parser_block_parsed(AV1Decoder *decoder, ThreadData *thread_data,
                             int mode_info_row, int mode_info_column,
                             BLOCK_SIZE block_size) {
  AV1Parser *const parser = av1_active_parser;
  const AV1_COMMON *const common = &decoder->common;
  MACROBLOCKD *const macroblock = &thread_data->dcb.xd;
  const MB_MODE_INFO *const mode_info = macroblock->mi[0];
  FrameSections *const sections = &parser->sections;
  start_sections(parser);
  enter_superblock(parser, macroblock);
  count_block(parser, macroblock, mode_info);

  const uint32_t block_index = get_next_block_index(parser);
  const int inter = is_inter_block(mode_info);
  const uint32_t position =
      ((uint32_t)mode_info_row << RECORD_BLOCK_MI_ROW_SHIFT) |
      ((uint32_t)mode_info_column << RECORD_BLOCK_MI_COLUMN_SHIFT) |
      ((uint32_t)block_size << RECORD_BLOCK_SIZE_SHIFT) |
      ((uint32_t)(inter != 0) << RECORD_BLOCK_INTER_SHIFT) |
      ((uint32_t)(mode_info->skip_txfm != 0) << RECORD_BLOCK_SKIP_SHIFT) |
      ((uint32_t)(is_intrabc_block(mode_info) != 0) << RECORD_BLOCK_INTRABC_SHIFT);
  const uint32_t transform =
      ((uint32_t)mode_info->tx_size << RECORD_BLOCK_TX_SIZE_SHIFT) |
      ((uint32_t)mode_info->segment_id << RECORD_BLOCK_SEGMENT_SHIFT) |
      get_block_levels(sections, common, mode_info);
  const uint32_t modes =
      inter ? get_inter_modes(common, mode_info) : get_intra_modes(mode_info);
  const uint32_t extension = write_block_extensions(parser, common, macroblock, mode_info);
  uint32_t *const block = reserve_record_words(parser, &sections->blocks, RECORD_BLOCK_WORDS);
  block[RECORD_BLOCK_POSITION] = position;
  block[RECORD_BLOCK_TRANSFORM] = transform;
  block[RECORD_BLOCK_MODES] = modes;
  block[RECORD_BLOCK_EXTENSION] = extension;
  append_block_jobs(parser, common, macroblock, mode_info, block_index);
  // libaom stores an inter block's reconstructed luma for a later chroma-from-luma block of its group
  if (inter && store_cfl_required(common, macroblock)) {
    av1_parser_cfl_store_block_extent(macroblock, mode_info->bsize, mode_info->tx_size);
  }
  if (!mode_info->skip_txfm) {
    mark_coded_cdef_units(sections, mode_info_row, mode_info_column, block_size);
  }
  sections->residual_planes = 0;
}

// Returns the record frame buffers no live libaom pool buffer holds
static uint32_t get_free_frame_buffers(const AV1Parser *parser) {
  const BufferPool *const pool = parser->pool;
  uint32_t used_mask = 0;
  for (uint32_t pool_index = 0; pool_index < FRAME_BUFFERS; ++pool_index) {
    const uint32_t frame_buffer = parser->frame_buffer_of[pool_index];
    if (pool->frame_bufs[pool_index].ref_count > 0 &&
        frame_buffer != PARSER_NO_FRAME_BUFFER) {
      used_mask |= 1u << frame_buffer;
    }
  }
  return ~used_mask & ((1u << RECORD_FRAME_BUFFERS) - 1u);
}

// Takes the lowest record frame buffer of a mask; returns RECORD_FRAME_BUFFERS when the mask is empty
static uint32_t take_frame_buffer(uint32_t *mask) {
  for (uint32_t frame_buffer = 0; frame_buffer < RECORD_FRAME_BUFFERS;
       ++frame_buffer) {
    if ((*mask >> frame_buffer) & 1u) {
      *mask &= ~(1u << frame_buffer);
      return frame_buffer;
    }
  }
  return RECORD_FRAME_BUFFERS;
}

void av1_parser_missing_reference(AV1Decoder *decoder, RefCntBuffer *buffer) {
  AV1Parser *const parser = av1_active_parser;
  uint32_t free_mask = get_free_frame_buffers(parser);
  const uint32_t frame_buffer = take_frame_buffer(&free_mask);
  if (frame_buffer == RECORD_FRAME_BUFFERS) {
    fail_frame(parser, ERROR_FRAME_BUFFERS, RECORD_FRAME_BUFFERS);
  }
  parser->frame_buffer_of[buffer - decoder->common.buffer_pool->frame_bufs] =
      (uint8_t)frame_buffer;
  parser->neutral_fill_mask |= 1u << frame_buffer;
}

void av1_parser_frame_parsed(AV1Decoder *decoder) {
  (void)decoder;
  AV1Parser *const parser = av1_active_parser;
  if (parser->picture_count >= PARSER_MAXIMUM_PICTURES_PER_PACKET) {
    fail_frame(parser, ERROR_BITSTREAM_UNSUPPORTED, parser->picture_count);
  }
  ParserPicture *const picture = &parser->pictures[parser->picture_count];
  av1_record_build_frame(parser, picture);
  parser->picture_count += 1;
}

// Packs a run of small values into bytes, four per word, from a word of the header on
static void pack_bytes(uint32_t *header, uint32_t first_word,
                       const int *values, uint32_t value_count) {
  for (uint32_t index = 0; index < value_count; ++index) {
    header[first_word + index / BYTES_PER_WORD] |=
        ((uint32_t)values[index] & BYTE_MASK)
        << (BYTE_BITS * (index % BYTES_PER_WORD));
  }
}

// Writes the film grain parameters a frame outputs with, and whether the sequence's matrix coefficients are identity, which
// libaom's grain reads from the output image (av1_add_film_grain())
static void write_film_grain(uint32_t *header, const aom_film_grain_t *grain,
                             const SequenceHeader *sequence) {
  uint32_t *const words = header + RECORD_HEADER_FILM_GRAIN;
  words[RECORD_FILM_GRAIN_CONTROL] =
      ((uint32_t)(sequence->matrix_coefficients == AOM_CICP_MC_IDENTITY)
       << RECORD_FILM_GRAIN_MC_IDENTITY_SHIFT) |
      ((uint32_t)(grain->apply_grain != 0) << RECORD_FILM_GRAIN_APPLY_SHIFT) |
      ((uint32_t)(grain->overlap_flag != 0)
       << RECORD_FILM_GRAIN_OVERLAP_SHIFT) |
      ((uint32_t)(grain->clip_to_restricted_range != 0)
       << RECORD_FILM_GRAIN_CLIP_SHIFT) |
      ((uint32_t)(grain->chroma_scaling_from_luma != 0)
       << RECORD_FILM_GRAIN_CHROMA_FROM_LUMA_SHIFT) |
      ((uint32_t)grain->num_y_points << RECORD_FILM_GRAIN_POINTS_Y_COUNT_SHIFT) |
      ((uint32_t)grain->num_cb_points
       << RECORD_FILM_GRAIN_POINTS_CB_COUNT_SHIFT) |
      ((uint32_t)grain->num_cr_points
       << RECORD_FILM_GRAIN_POINTS_CR_COUNT_SHIFT) |
      ((uint32_t)grain->scaling_shift << RECORD_FILM_GRAIN_SCALING_SHIFT_SHIFT) |
      ((uint32_t)grain->ar_coeff_lag << RECORD_FILM_GRAIN_AR_LAG_SHIFT) |
      ((uint32_t)grain->ar_coeff_shift << RECORD_FILM_GRAIN_AR_SHIFT_SHIFT) |
      ((uint32_t)grain->grain_scale_shift
       << RECORD_FILM_GRAIN_GRAIN_SCALE_SHIFT_SHIFT);
  words[RECORD_FILM_GRAIN_SEED] = grain->random_seed;
  words[RECORD_FILM_GRAIN_CB] =
      ((uint32_t)grain->cb_mult << RECORD_FILM_GRAIN_MULTIPLIER_SHIFT) |
      ((uint32_t)grain->cb_luma_mult << RECORD_FILM_GRAIN_LUMA_MULTIPLIER_SHIFT) |
      (((uint32_t)grain->cb_offset & FILM_GRAIN_OFFSET_MASK)
       << RECORD_FILM_GRAIN_OFFSET_SHIFT);
  words[RECORD_FILM_GRAIN_CR] =
      ((uint32_t)grain->cr_mult << RECORD_FILM_GRAIN_MULTIPLIER_SHIFT) |
      ((uint32_t)grain->cr_luma_mult << RECORD_FILM_GRAIN_LUMA_MULTIPLIER_SHIFT) |
      (((uint32_t)grain->cr_offset & FILM_GRAIN_OFFSET_MASK)
       << RECORD_FILM_GRAIN_OFFSET_SHIFT);
  pack_bytes(words, RECORD_FILM_GRAIN_POINTS_Y, &grain->scaling_points_y[0][0],
             (uint32_t)(sizeof(grain->scaling_points_y) / sizeof(int)));
  pack_bytes(words, RECORD_FILM_GRAIN_POINTS_CB,
             &grain->scaling_points_cb[0][0],
             (uint32_t)(sizeof(grain->scaling_points_cb) / sizeof(int)));
  pack_bytes(words, RECORD_FILM_GRAIN_POINTS_CR,
             &grain->scaling_points_cr[0][0],
             (uint32_t)(sizeof(grain->scaling_points_cr) / sizeof(int)));
  pack_bytes(words, RECORD_FILM_GRAIN_AR_Y, grain->ar_coeffs_y,
             (uint32_t)(sizeof(grain->ar_coeffs_y) / sizeof(int)));
  pack_bytes(words, RECORD_FILM_GRAIN_AR_CB, grain->ar_coeffs_cb,
             (uint32_t)(sizeof(grain->ar_coeffs_cb) / sizeof(int)));
  pack_bytes(words, RECORD_FILM_GRAIN_AR_CR, grain->ar_coeffs_cr,
             (uint32_t)(sizeof(grain->ar_coeffs_cr) / sizeof(int)));
}

// Writes the references the frame predicts from: their frame buffers, sizes, scale factors, and global motion
static void write_references(AV1Parser *parser, uint32_t *header) {
  const AV1_COMMON *const common = &parser->decoder->common;
  const RefCntBuffer *const pool_buffers = parser->pool->frame_bufs;
  for (uint32_t reference = 0; reference < RECORD_REFERENCES; ++reference) {
    const MV_REFERENCE_FRAME reference_frame =
        (MV_REFERENCE_FRAME)(LAST_FRAME + reference);
    uint32_t *const entry =
        header + RECORD_HEADER_REFERENCES + reference * RECORD_REFERENCE_WORDS;
    entry[RECORD_REFERENCE_BUFFER] = RECORD_MISSING;
    const RefCntBuffer *const buffer = get_ref_frame_buf(common, reference_frame);
    if (buffer != NULL && !frame_is_intra_only(common)) {
      const uint32_t frame_buffer =
          parser->frame_buffer_of[buffer - pool_buffers];
      if (frame_buffer == PARSER_NO_FRAME_BUFFER) {
        fail_frame(parser, ERROR_REFERENCE_INVALID, reference);
      }
      const struct scale_factors *const scale =
          get_ref_scale_factors_const(common, reference_frame);
      entry[RECORD_REFERENCE_BUFFER] = frame_buffer;
      entry[RECORD_REFERENCE_WIDTH] = (uint32_t)buffer->buf.y_crop_width;
      entry[RECORD_REFERENCE_HEIGHT] = (uint32_t)buffer->buf.y_crop_height;
      entry[RECORD_REFERENCE_SCALE_X] = (uint32_t)scale->x_scale_fp;
      entry[RECORD_REFERENCE_SCALE_Y] = (uint32_t)scale->y_scale_fp;
    }
    const WarpedMotionParams *const motion =
        &common->global_motion[reference_frame];
    uint32_t *const global_motion = header + RECORD_HEADER_GLOBAL_MOTION +
                                    reference * RECORD_GLOBAL_MOTION_WORDS;
    global_motion[RECORD_GLOBAL_MOTION_TYPE] =
        (uint32_t)motion->wmtype |
        ((uint32_t)(motion->invalid != 0) << RECORD_GLOBAL_MOTION_INVALID_SHIFT);
    for (uint32_t entry_index = 0; entry_index < MAX_PARAMDIM; ++entry_index) {
      global_motion[RECORD_GLOBAL_MOTION_MATRIX + entry_index] =
          (uint32_t)motion->wmmat[entry_index];
    }
    global_motion[RECORD_GLOBAL_MOTION_ALPHA_BETA] =
        pack_halves(motion->alpha, motion->beta);
    global_motion[RECORD_GLOBAL_MOTION_GAMMA_DELTA] =
        pack_halves(motion->gamma, motion->delta);
  }
}

// Writes the loop filter parameters: the deblocked planes, CDEF, and the restoration types and unit grids
static void write_filters(const AV1Parser *parser, uint32_t *header,
                          const FrameFilters *filters) {
  const AV1_COMMON *const common = &parser->decoder->common;
  const int plane_count = av1_num_planes(common);
  header[RECORD_HEADER_DEBLOCK] =
      (get_deblock_planes(common, filters->deblock) << RECORD_DEBLOCK_PLANES_SHIFT) |
      ((uint32_t)common->lf.sharpness_level << RECORD_DEBLOCK_SHARPNESS_SHIFT);
  header[RECORD_HEADER_CDEF] =
      filters->cdef
          ? (((uint32_t)common->cdef_info.cdef_damping << RECORD_CDEF_DAMPING_SHIFT) |
             ((uint32_t)common->cdef_info.cdef_bits << RECORD_CDEF_INDEX_BITS_SHIFT))
          : 0;
  for (int strength = 0; filters->cdef && strength < common->cdef_info.nb_cdef_strengths;
       ++strength) {
    const int luma = common->cdef_info.cdef_strengths[strength];
    const int chroma = common->cdef_info.cdef_uv_strengths[strength];
    int luma_secondary = luma % CDEF_SEC_STRENGTHS;
    int chroma_secondary = chroma % CDEF_SEC_STRENGTHS;
    if (luma_secondary == CDEF_CODED_SECONDARY_THREE) luma_secondary = CDEF_APPLIED_SECONDARY_THREE;
    if (chroma_secondary == CDEF_CODED_SECONDARY_THREE) chroma_secondary = CDEF_APPLIED_SECONDARY_THREE;
    header[RECORD_HEADER_CDEF_STRENGTHS + (uint32_t)strength] =
        ((uint32_t)(luma / CDEF_SEC_STRENGTHS) << RECORD_CDEF_LUMA_PRIMARY_SHIFT) |
        ((uint32_t)luma_secondary << RECORD_CDEF_LUMA_SECONDARY_SHIFT) |
        ((uint32_t)(chroma / CDEF_SEC_STRENGTHS) << RECORD_CDEF_CHROMA_PRIMARY_SHIFT) |
        ((uint32_t)chroma_secondary << RECORD_CDEF_CHROMA_SECONDARY_SHIFT);
  }
  uint32_t first_unit = 0;
  for (int plane = 0; filters->restoration && plane < plane_count; ++plane) {
    const RestorationInfo *const restoration = &common->rst_info[plane];
    uint32_t *const entry = header + RECORD_HEADER_RESTORATION +
                            (uint32_t)plane * RECORD_RESTORATION_WORDS;
    if (restoration->frame_restoration_type == RESTORE_NONE) continue;
    entry[RECORD_RESTORATION_TYPE] = (uint32_t)restoration->frame_restoration_type;
    entry[RECORD_RESTORATION_UNIT_SIZE] =
        (uint32_t)restoration->restoration_unit_size;
    entry[RECORD_RESTORATION_HORIZONTAL_UNITS] =
        (uint32_t)restoration->horz_units;
    entry[RECORD_RESTORATION_VERTICAL_UNITS] = (uint32_t)restoration->vert_units;
    entry[RECORD_RESTORATION_FIRST_UNIT] = first_unit;
    first_unit += (uint32_t)restoration->num_rest_units;
  }
}

// The Wiener filter taps a restoration unit codes for one direction, biased to be non-negative
static uint32_t pack_wiener_taps(const int16_t *taps) {
  static const int biases[WIENER_CODED_TAPS] = {
    (int)RECORD_RESTORATION_UNIT_WIENER_TAP_0_BIAS,
    (int)RECORD_RESTORATION_UNIT_WIENER_TAP_1_BIAS,
    (int)RECORD_RESTORATION_UNIT_WIENER_TAP_2_BIAS
  };
  static const uint32_t widths[WIENER_CODED_TAPS] = {
    RECORD_RESTORATION_UNIT_WIENER_TAP_0_BITS, RECORD_RESTORATION_UNIT_WIENER_TAP_1_BITS,
    RECORD_RESTORATION_UNIT_WIENER_TAP_2_BITS
  };
  uint32_t packed = 0;
  uint32_t shift = 0;
  for (uint32_t tap = 0; tap < WIENER_CODED_TAPS; ++tap) {
    packed |= ((uint32_t)(taps[tap] + biases[tap]) & ((1u << widths[tap]) - 1u)) << shift;
    shift += widths[tap];
  }
  return packed;
}

// Appends the restoration units of the planes the frame restores, each plane's in raster order
static void write_restoration_units(AV1Parser *parser) {
  const AV1_COMMON *const common = &parser->decoder->common;
  FrameSections *const sections = &parser->sections;
  for (int plane = 0; plane < av1_num_planes(common); ++plane) {
    const RestorationInfo *const restoration = &common->rst_info[plane];
    if (restoration->frame_restoration_type == RESTORE_NONE) continue;
    const size_t unit_count = (size_t)restoration->num_rest_units;
    uint32_t *const words = reserve_record_words(
        parser, &sections->restoration_units, unit_count * RECORD_RESTORATION_UNIT_WORDS);
    for (size_t unit = 0; unit < unit_count; ++unit) {
      const RestorationUnitInfo *const info = &restoration->unit_info[unit];
      uint32_t *const entry = words + unit * RECORD_RESTORATION_UNIT_WORDS;
      entry[0] = (uint32_t)info->restoration_type << RECORD_RESTORATION_UNIT_TYPE_SHIFT;
      switch (info->restoration_type) {
        case RESTORE_SGRPROJ:
          entry[0] |=
              ((uint32_t)info->sgrproj_info.ep << RECORD_RESTORATION_UNIT_SGR_SET_SHIFT) |
              ((uint32_t)(info->sgrproj_info.xqd[0] +
                          (int)RECORD_RESTORATION_UNIT_SGR_WEIGHT_0_BIAS)
               << RECORD_RESTORATION_UNIT_SGR_WEIGHT_0_SHIFT) |
              ((uint32_t)(info->sgrproj_info.xqd[1] +
                          (int)RECORD_RESTORATION_UNIT_SGR_WEIGHT_1_BIAS)
               << RECORD_RESTORATION_UNIT_SGR_WEIGHT_1_SHIFT);
          break;
        case RESTORE_WIENER:
          entry[1] = (pack_wiener_taps(info->wiener_info.vfilter)
                      << RECORD_RESTORATION_UNIT_WIENER_VERTICAL_SHIFT) |
                     (pack_wiener_taps(info->wiener_info.hfilter)
                      << RECORD_RESTORATION_UNIT_WIENER_HORIZONTAL_SHIFT);
          break;
        default: break;
      }
    }
  }
}

// Writes each superblock's CDEF indices: per 64x64 unit, the strength index libaom read into the mode info at the unit's origin,
// or RECORD_SUPERBLOCK_CDEF_SKIP for a unit without a block with coefficients, or outside the frame, or when CDEF does not run
static void write_superblock_cdef(AV1Parser *parser, int cdef) {
  const AV1_COMMON *const common = &parser->decoder->common;
  const CommonModeInfoParams *const mode_info_parameters = &common->mi_params;
  FrameSections *const sections = &parser->sections;
  const uint32_t units_across =
      sections->superblock_size_log2 > CDEF_UNIT_MODE_INFO_LOG2 ? CDEF_UNITS_PER_SUPERBLOCK_128 : 1u;
  for (uint32_t row = 0; row < sections->superblock_rows; ++row) {
    for (uint32_t column = 0; column < sections->superblock_columns; ++column) {
      uint32_t indices = 0;
      for (uint32_t unit = 0; unit < units_across * units_across; ++unit) {
        const uint32_t unit_row = row * units_across + unit / units_across;
        const uint32_t unit_column = column * units_across + unit % units_across;
        uint32_t index = RECORD_SUPERBLOCK_CDEF_SKIP;
        if (cdef && unit_row < sections->cdef_unit_rows &&
            unit_column < sections->cdef_unit_columns &&
            sections->coded_cdef_units.words[unit_row * sections->cdef_unit_columns + unit_column]) {
          const MB_MODE_INFO *const unit_mode_info =
              mode_info_parameters->mi_grid_base[(size_t)(unit_row << CDEF_UNIT_MODE_INFO_LOG2) *
                                                     mode_info_parameters->mi_stride +
                                                 (unit_column << CDEF_UNIT_MODE_INFO_LOG2)];
          if (unit_mode_info != NULL && unit_mode_info->cdef_strength >= 0) {
            index = (uint32_t)unit_mode_info->cdef_strength;
          }
        }
        indices |= index << (RECORD_SUPERBLOCK_CDEF_INDEX_BITS * unit);
      }
      sections->superblocks.words[((size_t)row * sections->superblock_columns + column) *
                                      RECORD_SUPERBLOCK_WORDS +
                                  RECORD_SUPERBLOCK_CDEF] = indices;
    }
  }
}

// Writes the tile grid
static void write_tiles(const AV1Parser *parser, uint32_t *header) {
  const CommonTileParams *const tiles = &parser->decoder->common.tiles;
  header[RECORD_HEADER_TILE_COLUMNS] = (uint32_t)tiles->cols;
  header[RECORD_HEADER_TILE_ROWS] = (uint32_t)tiles->rows;
  for (int column = 0; column <= tiles->cols; ++column) {
    header[RECORD_HEADER_TILE_COLUMN_STARTS + (uint32_t)column] =
        (uint32_t)tiles->col_start_sb[column];
  }
  for (int row = 0; row <= tiles->rows; ++row) {
    header[RECORD_HEADER_TILE_ROW_STARTS + (uint32_t)row] =
        (uint32_t)tiles->row_start_sb[row];
  }
}

// Returns the header flags of the frame being decoded
static uint32_t get_frame_flags(const AV1Parser *parser, const FrameFilters *filters) {
  const AV1_COMMON *const common = &parser->decoder->common;
  const SequenceHeader *const sequence = common->seq_params;
  uint32_t flags = 0;
  flags |= (uint32_t)(common->show_frame != 0) << RECORD_FLAG_SHOW_FRAME;
  flags |= (uint32_t)(common->showable_frame != 0) << RECORD_FLAG_SHOWABLE_FRAME;
  flags |= (uint32_t)(frame_is_intra_only(common) != 0) << RECORD_FLAG_INTRA_ONLY;
  flags |= (uint32_t)(common->features.allow_intrabc != 0)
           << RECORD_FLAG_ALLOW_INTRABC;
  flags |= (uint32_t)(sequence->sb_size == BLOCK_128X128)
           << RECORD_FLAG_SUPERBLOCK_128;
  flags |= (uint32_t)(sequence->monochrome != 0) << RECORD_FLAG_MONOCHROME;
  flags |= (uint32_t)(sequence->enable_intra_edge_filter != 0)
           << RECORD_FLAG_INTRA_EDGE_FILTER;
  flags |= (uint32_t)(filters->superres != 0) << RECORD_FLAG_SUPERRES;
  flags |= (uint32_t)(filters->deblock != 0) << RECORD_FLAG_DEBLOCK;
  flags |= (uint32_t)(filters->cdef != 0) << RECORD_FLAG_CDEF;
  flags |= (uint32_t)(filters->restoration != 0) << RECORD_FLAG_RESTORATION;
  flags |= (uint32_t)(common->cur_frame->film_grain_params.apply_grain != 0)
           << RECORD_FLAG_FILM_GRAIN;
  flags |= (uint32_t)(common->features.coded_lossless != 0)
           << RECORD_FLAG_CODED_LOSSLESS;
  return flags;
}

// Starts a record of a length with a zeroed header and the parts every record shares, and notes the largest frame of the picture's
// sequence; returns NULL when memory runs out
static uint32_t *start_record(AV1Parser *parser, ParserPicture *picture,
                              uint32_t kind, size_t record_words) {
  const SequenceHeader *const sequence = parser->decoder->common.seq_params;
  picture->maximum_width = (uint32_t)sequence->max_frame_width;
  picture->maximum_height = (uint32_t)sequence->max_frame_height;
  WordBuffer *const record = &picture->record;
  record->count = 0;
  if (word_buffer_resize(record, record_words) != 0) return NULL;
  uint32_t *const header = record->words;
  header[RECORD_HEADER_MAGIC] = RECORD_MAGIC;
  header[RECORD_HEADER_VERSION] = RECORD_VERSION;
  header[RECORD_HEADER_KIND] = kind;
  header[RECORD_HEADER_PICTURE_INDEX] =
      (parser->picture_index + parser->picture_count) & PARSER_EVENT_INDEX_MASK;
  const uint32_t no_buffer_fields[] = {
    RECORD_HEADER_TARGET_BUFFER,      RECORD_HEADER_SCRATCH_BUFFER,
    RECORD_HEADER_FINAL_BUFFER,       RECORD_HEADER_OUTPUT_BUFFER,
    RECORD_HEADER_CDEF_SOURCE,        RECORD_HEADER_CDEF_TARGET,
    RECORD_HEADER_SUPERRES_SOURCE,    RECORD_HEADER_SUPERRES_TARGET,
    RECORD_HEADER_RESTORATION_SOURCE, RECORD_HEADER_RESTORATION_TARGET
  };
  for (size_t field = 0; field < sizeof(no_buffer_fields) / sizeof(*no_buffer_fields);
       ++field) {
    header[no_buffer_fields[field]] = RECORD_MISSING;
  }
  for (uint32_t reference = 0; reference < RECORD_REFERENCES; ++reference) {
    header[RECORD_HEADER_REFERENCES + reference * RECORD_REFERENCE_WORDS +
           RECORD_REFERENCE_BUFFER] = RECORD_MISSING;
  }
  // Empty sections sit at the header's end
  const uint32_t section_fields[] = {
    RECORD_HEADER_SUPERBLOCKS,   RECORD_HEADER_BLOCKS,
    RECORD_HEADER_INTRA_JOBS,    RECORD_HEADER_TRANSFORM_JOBS,
    RECORD_HEADER_COEFFICIENTS,  RECORD_HEADER_SIDE_DATA,
    RECORD_HEADER_RESTORATION_UNITS
  };
  for (size_t field = 0; field < sizeof(section_fields) / sizeof(*section_fields);
       ++field) {
    header[section_fields[field]] = RECORD_HEADER_WORDS;
  }
  header[RECORD_HEADER_RECORD_WORDS] = (uint32_t)record_words;
  return header;
}

// Copies a buffer's words into the record at an offset; returns the word after them
static uint32_t copy_words(uint32_t *record, uint32_t offset, const WordBuffer *buffer) {
  if (buffer->count > 0) {
    memcpy(record + offset, buffer->words, buffer->count * sizeof(uint32_t));
  }
  return offset + (uint32_t)buffer->count;
}

// Copies a section into the record after the ones before it; returns the word after it
static uint32_t place_section(uint32_t *record, uint32_t offset, const WordBuffer *section,
                              uint32_t offset_field, uint32_t count_field,
                              uint32_t words_per_entry) {
  record[offset_field] = offset;
  if (count_field != NO_COUNT_FIELD) {
    record[count_field] = (uint32_t)(section->count / words_per_entry);
  }
  return copy_words(record, offset, section);
}

// Copies the transform jobs into the record, those with a 64-point side last from RECORD_HEADER_TRANSFORM_LARGE_JOB on; returns
// the word after them
static uint32_t place_transform_jobs(uint32_t *record, uint32_t offset,
                                     const FrameSections *sections) {
  const uint32_t small_jobs =
      (uint32_t)(sections->transform_jobs.count / RECORD_TRANSFORM_JOB_WORDS);
  const uint32_t large_jobs =
      (uint32_t)(sections->large_transform_jobs.count / RECORD_TRANSFORM_JOB_WORDS);
  record[RECORD_HEADER_TRANSFORM_JOBS] = offset;
  record[RECORD_HEADER_TRANSFORM_JOB_COUNT] = small_jobs + large_jobs;
  record[RECORD_HEADER_TRANSFORM_LARGE_JOB] = small_jobs;
  offset = copy_words(record, offset, &sections->transform_jobs);
  return copy_words(record, offset, &sections->large_transform_jobs);
}

// Joins the frame's sections after the header, the largest last
static void place_sections(const FrameSections *sections, uint32_t *record) {
  uint32_t offset = RECORD_HEADER_WORDS;
  offset = place_section(record, offset, &sections->superblocks, RECORD_HEADER_SUPERBLOCKS,
                         NO_COUNT_FIELD, RECORD_SUPERBLOCK_WORDS);
  offset = place_section(record, offset, &sections->blocks, RECORD_HEADER_BLOCKS,
                         RECORD_HEADER_BLOCK_COUNT, RECORD_BLOCK_WORDS);
  offset = place_section(record, offset, &sections->intra_jobs, RECORD_HEADER_INTRA_JOBS,
                         RECORD_HEADER_INTRA_JOB_COUNT, RECORD_INTRA_JOB_WORDS);
  offset = place_transform_jobs(record, offset, sections);
  offset = place_section(record, offset, &sections->restoration_units,
                         RECORD_HEADER_RESTORATION_UNITS,
                         RECORD_HEADER_RESTORATION_UNIT_COUNT,
                         RECORD_RESTORATION_UNIT_WORDS);
  offset = place_section(record, offset, &sections->side_data, RECORD_HEADER_SIDE_DATA,
                         RECORD_HEADER_SIDE_DATA_WORDS, 1u);
  place_section(record, offset, &sections->coefficients, RECORD_HEADER_COEFFICIENTS,
                RECORD_HEADER_COEFFICIENT_WORDS, 1u);
}

void av1_record_build_frame(AV1Parser *parser, ParserPicture *picture) {
  AV1Decoder *const decoder = parser->decoder;
  AV1_COMMON *const common = &decoder->common;
  const SequenceHeader *const sequence = common->seq_params;
  FrameSections *const sections = &parser->sections;
  // A frame with no block hook still gets its sections
  start_sections(parser);
  flush_superblock(parser);
  const FrameFilters filters = get_frame_filters(common);
  write_superblock_cdef(parser, filters.cdef);
  if (filters.restoration) write_restoration_units(parser);
  uint32_t *const header =
      start_record(parser, picture, RECORD_KIND_DECODE, sections->record_words);
  if (header == NULL) {
    fail_frame(parser, ERROR_PARSER_MEMORY, to_kibibytes(sections->record_words));
  }

  header[RECORD_HEADER_FLAGS] =
      get_frame_flags(parser, &filters) |
      ((uint32_t)(sections->block_residuals != 0) << RECORD_FLAG_BLOCK_RESIDUALS);
  header[RECORD_HEADER_FRAME_TYPE] = (uint32_t)common->current_frame.frame_type;
  header[RECORD_HEADER_FRAME_WIDTH] = (uint32_t)common->width;
  header[RECORD_HEADER_FRAME_HEIGHT] = (uint32_t)common->height;
  header[RECORD_HEADER_UPSCALED_WIDTH] = (uint32_t)common->superres_upscaled_width;
  header[RECORD_HEADER_RENDER_WIDTH] = (uint32_t)common->render_width;
  header[RECORD_HEADER_RENDER_HEIGHT] = (uint32_t)common->render_height;
  header[RECORD_HEADER_BIT_DEPTH] = (uint32_t)sequence->bit_depth;
  header[RECORD_HEADER_SUBSAMPLING_X] = (uint32_t)sequence->subsampling_x;
  header[RECORD_HEADER_SUBSAMPLING_Y] = (uint32_t)sequence->subsampling_y;
  header[RECORD_HEADER_MI_COLUMNS] = (uint32_t)common->mi_params.mi_cols;
  header[RECORD_HEADER_MI_ROWS] = (uint32_t)common->mi_params.mi_rows;
  header[RECORD_HEADER_SUPERBLOCK_COLUMNS] = sections->superblock_columns;
  header[RECORD_HEADER_SUPERBLOCK_ROWS] = sections->superblock_rows;
  const uint32_t upscaled_width = (uint32_t)common->superres_upscaled_width;
  const uint32_t height = (uint32_t)common->height;
  if (upscaled_width > RECORD_MAXIMUM_WIDTH || height > RECORD_MAXIMUM_HEIGHT ||
      upscaled_width * height > RECORD_MAXIMUM_AREA) {
    fail_frame(parser, ERROR_PICTURE_SIZE,
               upscaled_width > RECORD_MAXIMUM_WIDTH ? upscaled_width : height);
  }

  // The frame decodes into the target buffer; each filter pass that runs moves it to the other one, where the final frame ends
  uint32_t free_mask = get_free_frame_buffers(parser);
  const uint32_t target_buffer = take_frame_buffer(&free_mask);
  const uint32_t scratch_buffer = take_frame_buffer(&free_mask);
  if (scratch_buffer == RECORD_FRAME_BUFFERS) {
    fail_frame(parser, ERROR_FRAME_BUFFERS, RECORD_FRAME_BUFFERS);
  }
  uint32_t current_buffer = target_buffer;
  uint32_t other_buffer = scratch_buffer;
  const uint32_t pass_enabled[] = { (uint32_t)filters.cdef, (uint32_t)filters.superres,
                                    (uint32_t)filters.restoration };
  const uint32_t pass_source_fields[] = { RECORD_HEADER_CDEF_SOURCE,
                                          RECORD_HEADER_SUPERRES_SOURCE,
                                          RECORD_HEADER_RESTORATION_SOURCE };
  const uint32_t pass_target_fields[] = { RECORD_HEADER_CDEF_TARGET,
                                          RECORD_HEADER_SUPERRES_TARGET,
                                          RECORD_HEADER_RESTORATION_TARGET };
  for (size_t pass = 0; pass < sizeof(pass_enabled) / sizeof(*pass_enabled);
       ++pass) {
    if (!pass_enabled[pass]) continue;
    header[pass_source_fields[pass]] = current_buffer;
    header[pass_target_fields[pass]] = other_buffer;
    const uint32_t previous_buffer = current_buffer;
    current_buffer = other_buffer;
    other_buffer = previous_buffer;
  }
  header[RECORD_HEADER_TARGET_BUFFER] = target_buffer;
  header[RECORD_HEADER_SCRATCH_BUFFER] = scratch_buffer;
  header[RECORD_HEADER_FINAL_BUFFER] = current_buffer;
  header[RECORD_HEADER_OUTPUT_BUFFER] = current_buffer;
  header[RECORD_HEADER_NEUTRAL_FILL_MASK] = parser->neutral_fill_mask;
  parser->neutral_fill_mask = 0;

  uint32_t lossless_mask = 0;
  for (uint32_t segment = 0; segment < MAX_SEGMENTS; ++segment) {
    lossless_mask |= (uint32_t)(decoder->dcb.xd.lossless[segment] != 0)
                     << segment;
  }
  header[RECORD_HEADER_SEGMENT_LOSSLESS_MASK] = lossless_mask;
  header[RECORD_HEADER_SUPERRES_DENOMINATOR] =
      (uint32_t)common->superres_scale_denominator;
  write_filters(parser, header, &filters);
  write_tiles(parser, header);
  header[RECORD_HEADER_WAVE_COUNT] = sections->wave_count;
  header[RECORD_HEADER_WAVE_SLOPE] = sections->wave_slope;
  write_references(parser, header);
  write_film_grain(header, &common->cur_frame->film_grain_params, sequence);
  memcpy(header + RECORD_HEADER_STATISTICS, parser->statistics,
         sizeof(parser->statistics));
  memset(parser->statistics, 0, sizeof(parser->statistics));
  place_sections(sections, header);

  picture->shown = common->show_frame != 0;
  parser->frame_parsed = 1;
  parser->parsed_pool_index =
      (uint32_t)(common->cur_frame - parser->pool->frame_bufs);
  parser->parsed_final_buffer = current_buffer;
}

int av1_record_build_show_existing(AV1Parser *parser, ParserPicture *picture,
                                   uint32_t frame_buffer) {
  const AV1_COMMON *const common = &parser->decoder->common;
  const RefCntBuffer *const shown = parser->decoder->output_frames[0];
  uint32_t *const header =
      start_record(parser, picture, RECORD_KIND_SHOW_EXISTING, RECORD_HEADER_WORDS);
  if (header == NULL) {
    parser->error_code = ERROR_PARSER_MEMORY;
    parser->error_value = RECORD_HEADER_WORDS;
    return -1;
  }
  header[RECORD_HEADER_FLAGS] =
      (1u << RECORD_FLAG_SHOW_FRAME) |
      ((uint32_t)(common->seq_params->monochrome != 0)
       << RECORD_FLAG_MONOCHROME) |
      ((uint32_t)(shown->film_grain_params.apply_grain != 0)
       << RECORD_FLAG_FILM_GRAIN);
  header[RECORD_HEADER_FRAME_TYPE] = (uint32_t)shown->frame_type;
  header[RECORD_HEADER_FRAME_WIDTH] = (uint32_t)shown->buf.y_crop_width;
  header[RECORD_HEADER_FRAME_HEIGHT] = (uint32_t)shown->buf.y_crop_height;
  header[RECORD_HEADER_UPSCALED_WIDTH] = (uint32_t)shown->buf.y_crop_width;
  header[RECORD_HEADER_RENDER_WIDTH] = (uint32_t)shown->buf.render_width;
  header[RECORD_HEADER_RENDER_HEIGHT] = (uint32_t)shown->buf.render_height;
  header[RECORD_HEADER_BIT_DEPTH] = (uint32_t)common->seq_params->bit_depth;
  header[RECORD_HEADER_SUBSAMPLING_X] =
      (uint32_t)common->seq_params->subsampling_x;
  header[RECORD_HEADER_SUBSAMPLING_Y] =
      (uint32_t)common->seq_params->subsampling_y;
  header[RECORD_HEADER_FINAL_BUFFER] = frame_buffer;
  header[RECORD_HEADER_OUTPUT_BUFFER] = frame_buffer;
  write_film_grain(header, &shown->film_grain_params, common->seq_params);
  picture->shown = 1;
  return 0;
}
