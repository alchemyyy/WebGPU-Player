/*
 * The decoded audio output stage's resampler and lookahead limiter kernels for the WebGPU player engine.
 *
 * Each kernel reproduces its JavaScript reference bit for bit, StreamingAudioResampler and StreamingAudioLookaheadLimiter:
 * every value comes from the same IEEE operations in the same order, a tap sum runs in tap order in float64,
 * and each output rounds to float32 as a Float32Array store does.
 * SIMD lanes hold channels or neighboring frames, never neighboring taps, and -ffp-contract=off keeps every multiply and add separate.
 * The JavaScript side builds the filter table and computes the constants that come from Math.exp and Math.pow,
 * and the limiter reads Math.log10 through an import, so no libm result enters any value.
 */

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wasm_simd128.h>

// Raised whenever an export's meaning changes; the TypeScript wrapper refuses another version
#define AUDIO_OUTPUT_STAGE_ABI_VERSION 1

// Rings start at this many frames and double as needed; a power of two lets a frame index wrap with a mask
#define MINIMUM_RING_FRAME_COUNT 4096u
#define MAXIMUM_RING_FRAME_COUNT 0x80000000u

// Output frames whose tap sums run together, so four independent sums share the floating-point pipeline
#define RENDER_GROUP_FRAME_COUNT 4u

// Two channels fill the two float64 lanes of a vector; an odd layout carries one silent padding channel
#define CHANNELS_PER_VECTOR 2u

#define DECIBELS_PER_AMPLITUDE_DECADE 20.0
#define UNITY_GAIN 1.0
#define HALF 0.5

#define FLOAT_EXPONENT_MASK 0x7F800000u

enum AudioOutputStageStatus {
    AUDIO_OUTPUT_STAGE_OK = 0,
    AUDIO_OUTPUT_STAGE_ALLOCATION_FAILED = -1,
    AUDIO_OUTPUT_STAGE_INVALID_ARGUMENT = -2,
    AUDIO_OUTPUT_STAGE_NON_FINITE_SAMPLE = -3,
    AUDIO_OUTPUT_STAGE_UNAVAILABLE_LOOKAHEAD = -4,
    AUDIO_OUTPUT_STAGE_INCONSISTENT_HISTORY = -5
};

enum AudioLimiterTelemetryIndex {
    AUDIO_LIMITER_MAXIMUM_INPUT_PEAK = 0,
    AUDIO_LIMITER_MAXIMUM_OUTPUT_PEAK = 1,
    AUDIO_LIMITER_MINIMUM_APPLIED_GAIN = 2,
    AUDIO_LIMITER_LIMITED_FRAME_COUNT = 3,
    AUDIO_LIMITER_TELEMETRY_VALUE_COUNT = 4
};

// The engine's own Math.log10, so the attack length follows the reference exactly
__attribute__((import_module("math"), import_name("log10")))
extern double javascript_math_log10(double value);

/**
 * Emscripten's heap growth notifies its JavaScript runtime here; defining it keeps the module free of that import.
 * The wrapper has no runtime to notify, and it views the memory afresh after every call that can grow it.
 */
void emscripten_notify_memory_growth(size_t memory_index) {
    (void) memory_index;
}

typedef struct AudioResampler {
    uint32_t channel_count;
    // Samples per stored frame: the channel count rounded up to whole vectors
    uint32_t frame_stride;
    uint32_t filter_radius;
    uint32_t filter_tap_count;
    uint32_t phase_count;
    uint32_t maximum_output_frame_count;
    double source_sample_rate;
    double target_sample_rate;
    // (phase_count + 1) rows of filter_tap_count coefficients, written by the JavaScript side
    double *filter_table;
    // Interleaved source frames, each at its absolute frame index modulo the capacity
    float *ring;
    uint32_t ring_capacity;
    // Absolute index of the oldest retained source frame
    uint64_t history_start_frame;
    uint64_t source_frame_count;
    float *first_values;
    float *last_values;
    float *input;
    uint64_t input_capacity;
    float *output;
    // One window of taps for an output frame whose taps wrap the ring or reach past the source
    float *edge_window;
} AudioResampler;

typedef struct AudioLimiter {
    uint32_t channel_count;
    uint32_t frame_stride;
    uint32_t minimum_attack_frame_count;
    uint32_t maximum_attack_frame_count;
    uint32_t maximum_output_frame_count;
    double ceiling_gain;
    double release_coefficient;
    double limited_gain_threshold;
    double maximum_attack_attenuation;
    // Interleaved samples, linked peaks, and attack constraints, each at its absolute frame index modulo the capacity
    float *ring;
    float *peaks;
    float *constraints;
    uint32_t ring_capacity;
    // Absolute index of the next frame to render, which is also the oldest retained frame
    uint64_t output_frame_count;
    uint64_t source_frame_count;
    double current_gain;
    double telemetry[AUDIO_LIMITER_TELEMETRY_VALUE_COUNT];
    // One quintic attack curve per attack length, built when a peak first needs it
    double **ramp_tables;
    float *input;
    uint64_t input_capacity;
    float *output;
} AudioLimiter;

typedef struct FilterPosition {
    int64_t window_start_frame;
    uint32_t phase_index;
    int status;
} FilterPosition;

/** Allocates element_count elements, or returns NULL when the size overflows the 32-bit address space or memory cannot grow. */
static void *allocate_array(uint64_t element_count, uint64_t element_size) {
    const uint64_t byte_count = element_count * element_size;
    if (element_count == 0 || byte_count / element_count != element_size || byte_count > SIZE_MAX) {
        return NULL;
    }
    return malloc((size_t) byte_count);
}

/** Returns the ring capacity that holds frame_count frames, or 0 when no ring can. */
static uint32_t get_ring_capacity(uint64_t frame_count) {
    if (frame_count > MAXIMUM_RING_FRAME_COUNT) {
        return 0;
    }
    uint32_t capacity = MINIMUM_RING_FRAME_COUNT;
    while (capacity < frame_count) {
        capacity <<= 1;
    }
    return capacity;
}

/**
 * Copies the frames [first_frame, first_frame + frame_count) of a ring into a new ring, each at its own absolute slot.
 * Returns NULL when the new ring cannot be allocated, leaving the old one untouched.
 */
static float *reallocate_ring(
    const float *ring,
    uint32_t capacity,
    uint32_t new_capacity,
    uint32_t frame_stride,
    uint64_t first_frame,
    uint64_t frame_count
) {
    float *new_ring = allocate_array((uint64_t) new_capacity * frame_stride, sizeof(float));
    if (new_ring == NULL) {
        return NULL;
    }
    for (uint64_t frame = first_frame; frame < first_frame + frame_count; frame += 1) {
        memcpy(
            new_ring + (frame & (new_capacity - 1u)) * frame_stride,
            ring + (frame & (capacity - 1u)) * frame_stride,
            frame_stride * sizeof(float)
        );
    }
    return new_ring;
}

/** Grows a planar staging buffer to hold sample_count samples; its contents need not survive. */
static float *reserve_staging(float **staging, uint64_t *capacity, uint64_t sample_count) {
    if (sample_count <= *capacity) {
        return *staging;
    }
    free(*staging);
    *staging = allocate_array(sample_count, sizeof(float));
    *capacity = *staging == NULL ? 0 : sample_count;
    return *staging;
}

/** Math.round for a non-negative value: halves round up, and the subtraction is exact, so no double rounding occurs. */
static double round_half_up_non_negative(double value) {
    const double whole = __builtin_floor(value);
    return value - whole >= HALF ? whole + 1.0 : whole;
}

/** Stores a vector's two channel sums as float32, as a Float32Array store rounds them, skipping a padding channel. */
static void store_channel_pair(
    float *output,
    uint32_t plane_frame_count,
    uint32_t channel_count,
    uint32_t channel_index,
    uint32_t frame_offset,
    v128_t sums
) {
    const v128_t narrowed = wasm_f32x4_demote_f64x2_zero(sums);
    output[channel_index * plane_frame_count + frame_offset] = wasm_f32x4_extract_lane(narrowed, 0);
    if (channel_index + 1u < channel_count) {
        output[(channel_index + 1u) * plane_frame_count + frame_offset] = wasm_f32x4_extract_lane(narrowed, 1);
    }
}

/** Interleaves one planar input frame into a stored frame, zeroing the padding channel. */
static void store_input_frame(float *frame, const float *input, uint32_t input_frame_count, uint32_t frame_index, uint32_t channel_count, uint32_t frame_stride) {
    for (uint32_t channel_index = 0; channel_index < channel_count; channel_index += 1) {
        frame[channel_index] = input[(uint64_t) channel_index * input_frame_count + frame_index];
    }
    for (uint32_t channel_index = channel_count; channel_index < frame_stride; channel_index += 1) {
        frame[channel_index] = 0.0f;
    }
}

// Resampler

static void destroy_resampler(AudioResampler *resampler) {
    if (resampler == NULL) {
        return;
    }
    free(resampler->filter_table);
    free(resampler->ring);
    free(resampler->first_values);
    free(resampler->last_values);
    free(resampler->input);
    free(resampler->output);
    free(resampler->edge_window);
    free(resampler);
}

EMSCRIPTEN_KEEPALIVE
int audio_output_stage_abi_version(void) {
    return AUDIO_OUTPUT_STAGE_ABI_VERSION;
}

/**
 * Creates a resampler, or returns NULL when an argument is invalid or memory cannot grow.
 * The caller fills its filter table before the first render; a source already at the target rate passes through in JavaScript instead.
 */
EMSCRIPTEN_KEEPALIVE
AudioResampler *audio_resampler_create(
    uint32_t channel_count,
    double source_sample_rate,
    double target_sample_rate,
    uint32_t filter_radius,
    uint32_t phase_count,
    uint32_t maximum_output_frame_count
) {
    if (channel_count == 0
        || channel_count > UINT32_MAX - 1u
        || maximum_output_frame_count == 0
        || filter_radius == 0
        || filter_radius > UINT32_MAX / 2u
        || phase_count == 0) {
        return NULL;
    }
    AudioResampler *resampler = calloc(1, sizeof(*resampler));
    if (resampler == NULL) {
        return NULL;
    }
    resampler->channel_count = channel_count;
    resampler->frame_stride = (channel_count + 1u) & ~1u;
    resampler->filter_radius = filter_radius;
    resampler->filter_tap_count = filter_radius * 2u;
    resampler->phase_count = phase_count;
    resampler->maximum_output_frame_count = maximum_output_frame_count;
    resampler->source_sample_rate = source_sample_rate;
    resampler->target_sample_rate = target_sample_rate;
    resampler->ring_capacity = MINIMUM_RING_FRAME_COUNT;
    resampler->ring = allocate_array((uint64_t) MINIMUM_RING_FRAME_COUNT * resampler->frame_stride, sizeof(float));
    resampler->first_values = calloc(resampler->frame_stride, sizeof(float));
    resampler->last_values = calloc(resampler->frame_stride, sizeof(float));
    resampler->output = allocate_array((uint64_t) maximum_output_frame_count * channel_count, sizeof(float));
    resampler->filter_table = allocate_array(((uint64_t) phase_count + 1u) * resampler->filter_tap_count, sizeof(double));
    resampler->edge_window = allocate_array((uint64_t) resampler->filter_tap_count * resampler->frame_stride, sizeof(float));
    if (resampler->ring == NULL
        || resampler->first_values == NULL
        || resampler->last_values == NULL
        || resampler->output == NULL
        || resampler->filter_table == NULL
        || resampler->edge_window == NULL) {
        destroy_resampler(resampler);
        return NULL;
    }
    return resampler;
}

EMSCRIPTEN_KEEPALIVE
void audio_resampler_destroy(AudioResampler *resampler) {
    destroy_resampler(resampler);
}

/** The filter table the caller writes once: (phase_count + 1) rows of 2 * filter_radius coefficients. */
EMSCRIPTEN_KEEPALIVE
double *audio_resampler_filter_table(AudioResampler *resampler) {
    return resampler->filter_table;
}

/** Returns room for frame_count planar input frames, one channel after another, or NULL when memory cannot grow. */
EMSCRIPTEN_KEEPALIVE
float *audio_resampler_reserve_input(AudioResampler *resampler, uint32_t frame_count) {
    return reserve_staging(&resampler->input, &resampler->input_capacity, (uint64_t) frame_count * resampler->channel_count);
}

/** The planar output of the last render, one channel after another. */
EMSCRIPTEN_KEEPALIVE
float *audio_resampler_output(AudioResampler *resampler) {
    return resampler->output;
}

/** Appends frame_count staged input frames to the source history, growing the ring when it is full. */
EMSCRIPTEN_KEEPALIVE
int audio_resampler_append(AudioResampler *resampler, uint32_t frame_count) {
    if (frame_count == 0 || (uint64_t) frame_count * resampler->channel_count > resampler->input_capacity) {
        return AUDIO_OUTPUT_STAGE_INVALID_ARGUMENT;
    }
    const uint64_t retained_frame_count = resampler->source_frame_count - resampler->history_start_frame;
    const uint64_t required_frame_count = retained_frame_count + frame_count;
    if (required_frame_count > resampler->ring_capacity) {
        const uint32_t new_capacity = get_ring_capacity(required_frame_count);
        if (new_capacity == 0) {
            return AUDIO_OUTPUT_STAGE_ALLOCATION_FAILED;
        }
        float *new_ring = reallocate_ring(
            resampler->ring,
            resampler->ring_capacity,
            new_capacity,
            resampler->frame_stride,
            resampler->history_start_frame,
            retained_frame_count
        );
        if (new_ring == NULL) {
            return AUDIO_OUTPUT_STAGE_ALLOCATION_FAILED;
        }
        free(resampler->ring);
        resampler->ring = new_ring;
        resampler->ring_capacity = new_capacity;
    }

    const uint32_t frame_stride = resampler->frame_stride;
    const uint64_t ring_mask = resampler->ring_capacity - 1u;
    for (uint32_t frame_index = 0; frame_index < frame_count; frame_index += 1) {
        float *frame = resampler->ring + ((resampler->source_frame_count + frame_index) & ring_mask) * frame_stride;
        store_input_frame(frame, resampler->input, frame_count, frame_index, resampler->channel_count, frame_stride);
    }
    if (resampler->source_frame_count == 0) {
        store_input_frame(resampler->first_values, resampler->input, frame_count, 0, resampler->channel_count, frame_stride);
    }
    store_input_frame(resampler->last_values, resampler->input, frame_count, frame_count - 1u, resampler->channel_count, frame_stride);
    resampler->source_frame_count += frame_count;
    return AUDIO_OUTPUT_STAGE_OK;
}

/** Releases the source frames before source_frame, which no later output reads. */
EMSCRIPTEN_KEEPALIVE
int audio_resampler_discard_before(AudioResampler *resampler, double source_frame) {
    const uint64_t frame = (uint64_t) source_frame;
    if (frame < resampler->history_start_frame || frame > resampler->source_frame_count) {
        return AUDIO_OUTPUT_STAGE_INCONSISTENT_HISTORY;
    }
    resampler->history_start_frame = frame;
    return AUDIO_OUTPUT_STAGE_OK;
}

/**
 * Locates one output frame's taps and coefficient row with the reference's own double arithmetic:
 * the source position is the output frame times the source rate, its whole part over the target rate picks the window,
 * and the remainder picks the nearest of the table's phases.
 */
static FilterPosition get_filter_position(const AudioResampler *resampler, uint64_t output_frame) {
    const double source_position = (double) output_frame * resampler->source_sample_rate;
    const double source_frame = __builtin_floor(source_position / resampler->target_sample_rate);
    const double fractional_position = source_position - source_frame * resampler->target_sample_rate;
    const double phase = round_half_up_non_negative(
        (fractional_position * (double) resampler->phase_count) / resampler->target_sample_rate
    );
    FilterPosition position;
    position.window_start_frame = (int64_t) (source_frame - (double) resampler->filter_radius + 1.0);
    position.phase_index = 0;
    position.status = AUDIO_OUTPUT_STAGE_OK;
    // The phase leaves the table only for positions beyond 2^53, which no stream reaches
    if (!(phase >= 0.0 && phase <= (double) resampler->phase_count)) {
        position.status = AUDIO_OUTPUT_STAGE_INVALID_ARGUMENT;
        return position;
    }
    position.phase_index = (uint32_t) phase;
    return position;
}

/** Whether every tap of a window lies in the retained history without wrapping the ring. */
static int is_window_in_ring(const AudioResampler *resampler, int64_t window_start_frame) {
    if (window_start_frame < (int64_t) resampler->history_start_frame) {
        return 0;
    }
    const uint64_t start_frame = (uint64_t) window_start_frame;
    if (start_frame + resampler->filter_tap_count > resampler->source_frame_count) {
        return 0;
    }
    return (uint32_t) (start_frame & (resampler->ring_capacity - 1u)) + resampler->filter_tap_count <= resampler->ring_capacity;
}

/**
 * Copies one window's taps into the edge window, as the reference reads each tap:
 * a tap before the first source frame takes the first frame, one after the last takes the last frame while finalizing,
 * and any other tap must be retained.
 */
static int build_edge_window(const AudioResampler *resampler, int64_t window_start_frame, int finalizing) {
    const uint32_t frame_stride = resampler->frame_stride;
    const uint64_t ring_mask = resampler->ring_capacity - 1u;
    for (uint32_t tap_index = 0; tap_index < resampler->filter_tap_count; tap_index += 1) {
        const int64_t source_frame = window_start_frame + tap_index;
        const float *source;
        if (source_frame < 0) {
            source = resampler->first_values;
        } else if ((uint64_t) source_frame >= resampler->source_frame_count) {
            if (!finalizing) {
                return AUDIO_OUTPUT_STAGE_UNAVAILABLE_LOOKAHEAD;
            }
            source = resampler->last_values;
        } else if ((uint64_t) source_frame < resampler->history_start_frame) {
            return AUDIO_OUTPUT_STAGE_INCONSISTENT_HISTORY;
        } else {
            source = resampler->ring + ((uint64_t) source_frame & ring_mask) * frame_stride;
        }
        memcpy(resampler->edge_window + (uint64_t) tap_index * frame_stride, source, frame_stride * sizeof(float));
    }
    return AUDIO_OUTPUT_STAGE_OK;
}

/** Sums one output frame's taps for every channel, each channel pair in its own vector, in tap order from +0. */
static void render_frame(
    const AudioResampler *resampler,
    const float *window,
    const double *coefficients,
    uint32_t plane_frame_count,
    uint32_t frame_offset
) {
    const uint32_t frame_stride = resampler->frame_stride;
    const uint32_t tap_count = resampler->filter_tap_count;
    for (uint32_t channel_index = 0; channel_index < frame_stride; channel_index += CHANNELS_PER_VECTOR) {
        const float *samples = window + channel_index;
        v128_t sums = wasm_f64x2_splat(0.0);
        for (uint32_t tap_index = 0; tap_index < tap_count; tap_index += 1) {
            const v128_t values = wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(samples + (uint64_t) tap_index * frame_stride));
            sums = wasm_f64x2_add(sums, wasm_f64x2_mul(values, wasm_v128_load64_splat(coefficients + tap_index)));
        }
        store_channel_pair(resampler->output, plane_frame_count, resampler->channel_count, channel_index, frame_offset, sums);
    }
}

/** Sums four output frames' taps at once, one channel pair at a time; each frame keeps its own sum in tap order. */
static void render_frame_group(
    const AudioResampler *resampler,
    const float *const windows[RENDER_GROUP_FRAME_COUNT],
    const double *const coefficient_rows[RENDER_GROUP_FRAME_COUNT],
    uint32_t plane_frame_count,
    uint32_t frame_offset
) {
    const uint32_t frame_stride = resampler->frame_stride;
    const uint32_t tap_count = resampler->filter_tap_count;
    const double *coefficients_0 = coefficient_rows[0];
    const double *coefficients_1 = coefficient_rows[1];
    const double *coefficients_2 = coefficient_rows[2];
    const double *coefficients_3 = coefficient_rows[3];
    for (uint32_t channel_index = 0; channel_index < frame_stride; channel_index += CHANNELS_PER_VECTOR) {
        const float *samples_0 = windows[0] + channel_index;
        const float *samples_1 = windows[1] + channel_index;
        const float *samples_2 = windows[2] + channel_index;
        const float *samples_3 = windows[3] + channel_index;
        v128_t sums_0 = wasm_f64x2_splat(0.0);
        v128_t sums_1 = wasm_f64x2_splat(0.0);
        v128_t sums_2 = wasm_f64x2_splat(0.0);
        v128_t sums_3 = wasm_f64x2_splat(0.0);
        for (uint32_t tap_index = 0; tap_index < tap_count; tap_index += 1) {
            const uint64_t sample_offset = (uint64_t) tap_index * frame_stride;
            sums_0 = wasm_f64x2_add(sums_0, wasm_f64x2_mul(
                wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(samples_0 + sample_offset)),
                wasm_v128_load64_splat(coefficients_0 + tap_index)
            ));
            sums_1 = wasm_f64x2_add(sums_1, wasm_f64x2_mul(
                wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(samples_1 + sample_offset)),
                wasm_v128_load64_splat(coefficients_1 + tap_index)
            ));
            sums_2 = wasm_f64x2_add(sums_2, wasm_f64x2_mul(
                wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(samples_2 + sample_offset)),
                wasm_v128_load64_splat(coefficients_2 + tap_index)
            ));
            sums_3 = wasm_f64x2_add(sums_3, wasm_f64x2_mul(
                wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(samples_3 + sample_offset)),
                wasm_v128_load64_splat(coefficients_3 + tap_index)
            ));
        }
        const uint32_t channel_count = resampler->channel_count;
        store_channel_pair(resampler->output, plane_frame_count, channel_count, channel_index, frame_offset, sums_0);
        store_channel_pair(resampler->output, plane_frame_count, channel_count, channel_index, frame_offset + 1u, sums_1);
        store_channel_pair(resampler->output, plane_frame_count, channel_count, channel_index, frame_offset + 2u, sums_2);
        store_channel_pair(resampler->output, plane_frame_count, channel_count, channel_index, frame_offset + 3u, sums_3);
    }
}

/** Renders frame_count output frames, starting at first_output_frame, into the planar output. */
EMSCRIPTEN_KEEPALIVE
int audio_resampler_render(AudioResampler *resampler, double first_output_frame, uint32_t frame_count, int finalizing) {
    if (frame_count == 0 || frame_count > resampler->maximum_output_frame_count) {
        return AUDIO_OUTPUT_STAGE_INVALID_ARGUMENT;
    }
    const uint64_t first_frame = (uint64_t) first_output_frame;
    const uint32_t frame_stride = resampler->frame_stride;
    const uint32_t tap_count = resampler->filter_tap_count;
    const uint64_t ring_mask = resampler->ring_capacity - 1u;
    for (uint32_t group_offset = 0; group_offset < frame_count; group_offset += RENDER_GROUP_FRAME_COUNT) {
        const uint32_t remaining_frame_count = frame_count - group_offset;
        const uint32_t group_frame_count = remaining_frame_count < RENDER_GROUP_FRAME_COUNT ?
            remaining_frame_count :
            RENDER_GROUP_FRAME_COUNT;
        FilterPosition positions[RENDER_GROUP_FRAME_COUNT];
        int group_in_ring = group_frame_count == RENDER_GROUP_FRAME_COUNT;
        for (uint32_t group_index = 0; group_index < group_frame_count; group_index += 1) {
            positions[group_index] = get_filter_position(resampler, first_frame + group_offset + group_index);
            if (positions[group_index].status != AUDIO_OUTPUT_STAGE_OK) {
                return positions[group_index].status;
            }
            group_in_ring = group_in_ring && is_window_in_ring(resampler, positions[group_index].window_start_frame);
        }

        if (group_in_ring) {
            const float *windows[RENDER_GROUP_FRAME_COUNT];
            const double *coefficient_rows[RENDER_GROUP_FRAME_COUNT];
            for (uint32_t group_index = 0; group_index < RENDER_GROUP_FRAME_COUNT; group_index += 1) {
                windows[group_index] = resampler->ring
                    + ((uint64_t) positions[group_index].window_start_frame & ring_mask) * frame_stride;
                coefficient_rows[group_index] = resampler->filter_table
                    + (uint64_t) positions[group_index].phase_index * tap_count;
            }
            render_frame_group(resampler, windows, coefficient_rows, frame_count, group_offset);
            continue;
        }

        // At the stream's edges and where a window wraps the ring, frames render one at a time
        for (uint32_t group_index = 0; group_index < group_frame_count; group_index += 1) {
            const FilterPosition position = positions[group_index];
            const float *window = resampler->edge_window;
            if (is_window_in_ring(resampler, position.window_start_frame)) {
                window = resampler->ring + ((uint64_t) position.window_start_frame & ring_mask) * frame_stride;
            } else {
                const int status = build_edge_window(resampler, position.window_start_frame, finalizing);
                if (status != AUDIO_OUTPUT_STAGE_OK) {
                    return status;
                }
            }
            render_frame(
                resampler,
                window,
                resampler->filter_table + (uint64_t) position.phase_index * tap_count,
                frame_count,
                group_offset + group_index
            );
        }
    }
    return AUDIO_OUTPUT_STAGE_OK;
}

// Limiter

static void destroy_limiter(AudioLimiter *limiter) {
    if (limiter == NULL) {
        return;
    }
    if (limiter->ramp_tables != NULL) {
        const uint32_t table_count = limiter->maximum_attack_frame_count - limiter->minimum_attack_frame_count + 1u;
        for (uint32_t table_index = 0; table_index < table_count; table_index += 1) {
            free(limiter->ramp_tables[table_index]);
        }
    }
    free(limiter->ramp_tables);
    free(limiter->ring);
    free(limiter->peaks);
    free(limiter->constraints);
    free(limiter->input);
    free(limiter->output);
    free(limiter);
}

/**
 * Creates a limiter, or returns NULL when an argument is invalid or memory cannot grow.
 * The JavaScript side passes every constant that comes from Math.pow or Math.exp.
 */
EMSCRIPTEN_KEEPALIVE
AudioLimiter *audio_limiter_create(
    uint32_t channel_count,
    double ceiling_gain,
    double release_coefficient,
    uint32_t minimum_attack_frame_count,
    uint32_t maximum_attack_frame_count,
    double maximum_attack_attenuation,
    double limited_gain_threshold,
    uint32_t maximum_output_frame_count
) {
    if (channel_count == 0
        || channel_count > UINT32_MAX - 1u
        || minimum_attack_frame_count == 0
        || maximum_attack_frame_count < minimum_attack_frame_count
        || maximum_attack_frame_count == UINT32_MAX
        || maximum_output_frame_count == 0) {
        return NULL;
    }
    AudioLimiter *limiter = calloc(1, sizeof(*limiter));
    if (limiter == NULL) {
        return NULL;
    }
    limiter->channel_count = channel_count;
    limiter->frame_stride = (channel_count + 1u) & ~1u;
    limiter->minimum_attack_frame_count = minimum_attack_frame_count;
    limiter->maximum_attack_frame_count = maximum_attack_frame_count;
    limiter->maximum_output_frame_count = maximum_output_frame_count;
    limiter->ceiling_gain = ceiling_gain;
    limiter->release_coefficient = release_coefficient;
    limiter->limited_gain_threshold = limited_gain_threshold;
    limiter->maximum_attack_attenuation = maximum_attack_attenuation;
    limiter->current_gain = UNITY_GAIN;
    limiter->telemetry[AUDIO_LIMITER_MAXIMUM_INPUT_PEAK] = 0.0;
    limiter->telemetry[AUDIO_LIMITER_MAXIMUM_OUTPUT_PEAK] = 0.0;
    limiter->telemetry[AUDIO_LIMITER_MINIMUM_APPLIED_GAIN] = UNITY_GAIN;
    limiter->telemetry[AUDIO_LIMITER_LIMITED_FRAME_COUNT] = 0.0;
    limiter->ring_capacity = MINIMUM_RING_FRAME_COUNT;
    limiter->ring = allocate_array((uint64_t) MINIMUM_RING_FRAME_COUNT * limiter->frame_stride, sizeof(float));
    limiter->peaks = allocate_array(MINIMUM_RING_FRAME_COUNT, sizeof(float));
    limiter->constraints = allocate_array(MINIMUM_RING_FRAME_COUNT, sizeof(float));
    limiter->ramp_tables = calloc((size_t) maximum_attack_frame_count - minimum_attack_frame_count + 1u, sizeof(double *));
    limiter->output = allocate_array((uint64_t) maximum_output_frame_count * channel_count, sizeof(float));
    if (limiter->ring == NULL
        || limiter->peaks == NULL
        || limiter->constraints == NULL
        || limiter->ramp_tables == NULL
        || limiter->output == NULL) {
        destroy_limiter(limiter);
        return NULL;
    }
    return limiter;
}

EMSCRIPTEN_KEEPALIVE
void audio_limiter_destroy(AudioLimiter *limiter) {
    destroy_limiter(limiter);
}

/** Returns room for frame_count planar input frames, one channel after another, or NULL when memory cannot grow. */
EMSCRIPTEN_KEEPALIVE
float *audio_limiter_reserve_input(AudioLimiter *limiter, uint32_t frame_count) {
    return reserve_staging(&limiter->input, &limiter->input_capacity, (uint64_t) frame_count * limiter->channel_count);
}

/** The planar output of the last render, one channel after another. */
EMSCRIPTEN_KEEPALIVE
float *audio_limiter_output(AudioLimiter *limiter) {
    return limiter->output;
}

/** The maximum input peak, maximum output peak, minimum applied gain, and limited frame count, in that order. */
EMSCRIPTEN_KEEPALIVE
double *audio_limiter_telemetry(AudioLimiter *limiter) {
    return limiter->telemetry;
}

/** The reference's quintic smoothstep: zero first and second derivatives at both ends of the unit interval. */
static double quintic_smoothstep(double value) {
    double bounded_value = value < 1.0 ? value : 1.0;
    bounded_value = bounded_value > 0.0 ? bounded_value : 0.0;
    return bounded_value * bounded_value * bounded_value * (bounded_value * (bounded_value * 6.0 - 15.0) + 10.0);
}

/**
 * Returns the attack curve for one attack length, building it on first use.
 * Entry k is the smoothstep of the attack progress k frames after the attack starts, computed as the reference computes it from the distance to the peak.
 */
static const double *get_ramp_table(AudioLimiter *limiter, uint32_t attack_frame_count) {
    if (attack_frame_count < limiter->minimum_attack_frame_count || attack_frame_count > limiter->maximum_attack_frame_count) {
        return NULL;
    }
    double **table_slot = &limiter->ramp_tables[attack_frame_count - limiter->minimum_attack_frame_count];
    if (*table_slot != NULL) {
        return *table_slot;
    }
    double *table = allocate_array((uint64_t) attack_frame_count + 1u, sizeof(double));
    if (table == NULL) {
        return NULL;
    }
    for (uint32_t ramp_index = 0; ramp_index <= attack_frame_count; ramp_index += 1) {
        const double peak_distance = (double) (attack_frame_count - ramp_index);
        table[ramp_index] = quintic_smoothstep(1.0 - peak_distance / (double) attack_frame_count);
    }
    *table_slot = table;
    return table;
}

/** The reference's attack length: from the minimum toward the maximum as the required attenuation approaches its maximum. */
static uint32_t get_attack_frame_count(const AudioLimiter *limiter, double required_gain) {
    const double attenuation = -DECIBELS_PER_AMPLITUDE_DECADE * javascript_math_log10(required_gain);
    const double attenuation_ratio = attenuation / limiter->maximum_attack_attenuation;
    const double severity = attenuation_ratio < 1.0 ? attenuation_ratio : 1.0;
    const double minimum_frame_count = (double) limiter->minimum_attack_frame_count;
    const double maximum_frame_count = (double) limiter->maximum_attack_frame_count;
    return (uint32_t) round_half_up_non_negative(minimum_frame_count + (maximum_frame_count - minimum_frame_count) * severity);
}

/** Lowers contiguous constraints to an attack curve's gains, rounded to float32 as the reference's constraint array stores them. */
static void apply_ramp_segment(float *constraints, const double *ramp, uint32_t frame_count, double attenuation_range) {
    const v128_t ranges = wasm_f64x2_splat(attenuation_range);
    const v128_t unity_gains = wasm_f64x2_splat(UNITY_GAIN);
    uint32_t frame_index = 0;
    for (; frame_index + 4u <= frame_count; frame_index += 4u) {
        const v128_t low_gains = wasm_f64x2_sub(unity_gains, wasm_f64x2_mul(ranges, wasm_v128_load(ramp + frame_index)));
        const v128_t high_gains = wasm_f64x2_sub(unity_gains, wasm_f64x2_mul(ranges, wasm_v128_load(ramp + frame_index + 2u)));
        const v128_t gains = wasm_i32x4_shuffle(
            wasm_f32x4_demote_f64x2_zero(low_gains),
            wasm_f32x4_demote_f64x2_zero(high_gains),
            0, 1, 4, 5
        );
        wasm_v128_store(constraints + frame_index, wasm_f32x4_min(wasm_v128_load(constraints + frame_index), gains));
    }
    for (; frame_index < frame_count; frame_index += 1) {
        const float gain = (float) (UNITY_GAIN - attenuation_range * ramp[frame_index]);
        if (gain < constraints[frame_index]) {
            constraints[frame_index] = gain;
        }
    }
}

/**
 * Applies one peak's attack to the constraints of the frames before it.
 * Every frame still to render takes the minimum over all peaks whose attack reaches it, which is what the reference computes chunk by chunk,
 * because its analysis horizon always covers the longest attack.
 */
static int apply_attack(AudioLimiter *limiter, uint64_t peak_frame, double peak) {
    const double required_gain = limiter->ceiling_gain / peak;
    const uint32_t attack_frame_count = get_attack_frame_count(limiter, required_gain);
    const double *ramp = get_ramp_table(limiter, attack_frame_count);
    if (ramp == NULL) {
        return AUDIO_OUTPUT_STAGE_ALLOCATION_FAILED;
    }
    const double attenuation_range = UNITY_GAIN - required_gain;
    uint64_t first_frame = peak_frame >= attack_frame_count ? peak_frame - attack_frame_count : 0;
    if (first_frame < limiter->output_frame_count) {
        first_frame = limiter->output_frame_count;
    }
    const uint64_t ring_mask = limiter->ring_capacity - 1u;
    uint64_t frame = first_frame;
    while (frame <= peak_frame) {
        const uint32_t slot = (uint32_t) (frame & ring_mask);
        const uint64_t frames_to_ring_end = limiter->ring_capacity - slot;
        const uint64_t frames_to_peak = peak_frame - frame + 1u;
        const uint32_t segment_frame_count = (uint32_t) (frames_to_peak < frames_to_ring_end ? frames_to_peak : frames_to_ring_end);
        apply_ramp_segment(
            limiter->constraints + slot,
            ramp + (frame + attack_frame_count - peak_frame),
            segment_frame_count,
            attenuation_range
        );
        frame += segment_frame_count;
    }
    return AUDIO_OUTPUT_STAGE_OK;
}

static int is_finite_sample(float sample) {
    uint32_t bits;
    memcpy(&bits, &sample, sizeof(bits));
    return (bits & FLOAT_EXPONENT_MASK) != FLOAT_EXPONENT_MASK;
}

/**
 * Appends frame_count staged input frames: rejects a non-finite sample before any state changes,
 * records each frame's linked peak, and applies the attack of every peak above the ceiling.
 */
EMSCRIPTEN_KEEPALIVE
int audio_limiter_append(AudioLimiter *limiter, uint32_t frame_count) {
    const uint64_t sample_count = (uint64_t) frame_count * limiter->channel_count;
    if (frame_count == 0 || sample_count > limiter->input_capacity) {
        return AUDIO_OUTPUT_STAGE_INVALID_ARGUMENT;
    }
    for (uint64_t sample_index = 0; sample_index < sample_count; sample_index += 1) {
        if (!is_finite_sample(limiter->input[sample_index])) {
            return AUDIO_OUTPUT_STAGE_NON_FINITE_SAMPLE;
        }
    }

    const uint64_t retained_frame_count = limiter->source_frame_count - limiter->output_frame_count;
    const uint64_t required_frame_count = retained_frame_count + frame_count;
    if (required_frame_count > limiter->ring_capacity) {
        const uint32_t new_capacity = get_ring_capacity(required_frame_count);
        if (new_capacity == 0) {
            return AUDIO_OUTPUT_STAGE_ALLOCATION_FAILED;
        }
        const uint64_t first_frame = limiter->output_frame_count;
        float *new_ring = reallocate_ring(limiter->ring, limiter->ring_capacity, new_capacity, limiter->frame_stride, first_frame, retained_frame_count);
        float *new_peaks = reallocate_ring(limiter->peaks, limiter->ring_capacity, new_capacity, 1u, first_frame, retained_frame_count);
        float *new_constraints = reallocate_ring(limiter->constraints, limiter->ring_capacity, new_capacity, 1u, first_frame, retained_frame_count);
        if (new_ring == NULL || new_peaks == NULL || new_constraints == NULL) {
            free(new_ring);
            free(new_peaks);
            free(new_constraints);
            return AUDIO_OUTPUT_STAGE_ALLOCATION_FAILED;
        }
        free(limiter->ring);
        free(limiter->peaks);
        free(limiter->constraints);
        limiter->ring = new_ring;
        limiter->peaks = new_peaks;
        limiter->constraints = new_constraints;
        limiter->ring_capacity = new_capacity;
    }

    const uint32_t channel_count = limiter->channel_count;
    const uint32_t frame_stride = limiter->frame_stride;
    const uint64_t ring_mask = limiter->ring_capacity - 1u;
    const uint64_t first_new_frame = limiter->source_frame_count;
    float maximum_input_peak = (float) limiter->telemetry[AUDIO_LIMITER_MAXIMUM_INPUT_PEAK];
    for (uint32_t frame_index = 0; frame_index < frame_count; frame_index += 1) {
        const uint32_t slot = (uint32_t) ((first_new_frame + frame_index) & ring_mask);
        float *frame = limiter->ring + (uint64_t) slot * frame_stride;
        store_input_frame(frame, limiter->input, frame_count, frame_index, channel_count, frame_stride);
        float peak = 0.0f;
        for (uint32_t channel_index = 0; channel_index < channel_count; channel_index += 1) {
            const float magnitude = __builtin_fabsf(frame[channel_index]);
            peak = magnitude > peak ? magnitude : peak;
        }
        limiter->peaks[slot] = peak;
        limiter->constraints[slot] = (float) UNITY_GAIN;
        maximum_input_peak = peak > maximum_input_peak ? peak : maximum_input_peak;
    }
    limiter->telemetry[AUDIO_LIMITER_MAXIMUM_INPUT_PEAK] = (double) maximum_input_peak;
    limiter->source_frame_count += frame_count;

    for (uint32_t frame_index = 0; frame_index < frame_count; frame_index += 1) {
        const uint64_t peak_frame = first_new_frame + frame_index;
        const double peak = (double) limiter->peaks[peak_frame & ring_mask];
        if (peak <= limiter->ceiling_gain) {
            continue;
        }
        const int status = apply_attack(limiter, peak_frame, peak);
        if (status != AUDIO_OUTPUT_STAGE_OK) {
            return status;
        }
    }
    return AUDIO_OUTPUT_STAGE_OK;
}

/**
 * Renders frame_count frames into the planar output with the reference's gain recurrence:
 * each frame takes the least of unity, its safe gain, its attack constraint, and the released previous gain.
 */
EMSCRIPTEN_KEEPALIVE
int audio_limiter_render(AudioLimiter *limiter, uint32_t frame_count) {
    if (frame_count == 0
        || frame_count > limiter->maximum_output_frame_count
        || limiter->output_frame_count + frame_count > limiter->source_frame_count) {
        return AUDIO_OUTPUT_STAGE_INVALID_ARGUMENT;
    }
    const uint32_t channel_count = limiter->channel_count;
    const uint32_t frame_stride = limiter->frame_stride;
    const uint64_t ring_mask = limiter->ring_capacity - 1u;
    const double ceiling_gain = limiter->ceiling_gain;
    const double release_coefficient = limiter->release_coefficient;
    const double limited_gain_threshold = limiter->limited_gain_threshold;
    double current_gain = limiter->current_gain;
    double minimum_applied_gain = limiter->telemetry[AUDIO_LIMITER_MINIMUM_APPLIED_GAIN];
    double limited_frame_count = limiter->telemetry[AUDIO_LIMITER_LIMITED_FRAME_COUNT];
    v128_t output_peaks = wasm_f64x2_splat(limiter->telemetry[AUDIO_LIMITER_MAXIMUM_OUTPUT_PEAK]);
    for (uint32_t frame_offset = 0; frame_offset < frame_count; frame_offset += 1) {
        const uint32_t slot = (uint32_t) ((limiter->output_frame_count + frame_offset) & ring_mask);
        const double input_peak = (double) limiter->peaks[slot];
        const double safe_gain = input_peak > ceiling_gain ? ceiling_gain / input_peak : UNITY_GAIN;
        const double released_gain = UNITY_GAIN - (UNITY_GAIN - current_gain) * release_coefficient;
        const double attack_constraint = (double) limiter->constraints[slot];
        double applied_gain = UNITY_GAIN;
        applied_gain = safe_gain < applied_gain ? safe_gain : applied_gain;
        applied_gain = attack_constraint < applied_gain ? attack_constraint : applied_gain;
        applied_gain = released_gain < applied_gain ? released_gain : applied_gain;
        current_gain = applied_gain;
        minimum_applied_gain = applied_gain < minimum_applied_gain ? applied_gain : minimum_applied_gain;
        if (applied_gain < limited_gain_threshold) {
            limited_frame_count += 1.0;
        }

        const v128_t gains = wasm_f64x2_splat(applied_gain);
        const float *frame = limiter->ring + (uint64_t) slot * frame_stride;
        for (uint32_t channel_index = 0; channel_index < frame_stride; channel_index += CHANNELS_PER_VECTOR) {
            const v128_t values = wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(frame + channel_index));
            const v128_t outputs = wasm_f64x2_mul(values, gains);
            output_peaks = wasm_f64x2_max(output_peaks, wasm_f64x2_abs(outputs));
            store_channel_pair(limiter->output, frame_count, channel_count, channel_index, frame_offset, outputs);
        }
    }
    const double first_output_peak = wasm_f64x2_extract_lane(output_peaks, 0);
    const double second_output_peak = wasm_f64x2_extract_lane(output_peaks, 1);
    limiter->current_gain = current_gain;
    limiter->telemetry[AUDIO_LIMITER_MAXIMUM_OUTPUT_PEAK] = first_output_peak > second_output_peak ? first_output_peak : second_output_peak;
    limiter->telemetry[AUDIO_LIMITER_MINIMUM_APPLIED_GAIN] = minimum_applied_gain;
    limiter->telemetry[AUDIO_LIMITER_LIMITED_FRAME_COUNT] = limited_frame_count;
    limiter->output_frame_count += frame_count;
    return AUDIO_OUTPUT_STAGE_OK;
}
