/*
 * Joint object coding of ETSI TS 103 420 V1.2.1 clause 6: the payload syntax of clause 6.2, the Huffman decoding,
 * differential decoding, and dequantization of clause 6.6.2 to 6.6.4, the interpolation of clause 6.6.5, and the
 * reconstruction of clause 6.6.6 in the filter bank domain of clause 7.
 *
 * Choices where the clause's text leaves room:
 * - Steep interpolation maps subbands to parameter bands as smooth interpolation does; pseudocode 6 indexes the
 *   dequantized matrix by subband there, which is out of its range.
 * - Sparse coding follows pseudocode 2 literally: the band's channel adds the coded indices of this band and the one
 *   before, and the channels it does not select keep the offset value of 50 or 100.
 * - The 90-degree phase-shifted downmixes (configurations 3 and 4) feed the decoded channels unchanged, as the others.
 * - An object without side information in a frame, and every object of a frame lost to damage, keeps its last matrix.
 * - A sequence count of 0, a count that does not follow the last one, or a change of channel or object count starts
 *   from zero matrices and empty synthesis histories, as at the start of a stream.
 * - The clip gain is read and not applied; clause 6.6 applies none.
 */

#include <string.h>

#include "eac3_joc.h"
#include "eac3_joc_tables.h"

#define MAX_HUFFMAN_DEPTH 32

/* Table 48 */
static const uint8_t channel_counts[] = { 5, 7, 7, 5, 7 };
/* Table 50 */
static const uint8_t band_counts[] = { 1, 3, 5, 7, 9, 12, 15, 23 };

/*
 * Table 54: the first subband of each parameter band, per band count, ending at 64.
 * Subband s belongs to parameter band p when band_starts[p] <= s < band_starts[p + 1].
 */
static const uint8_t band_starts_23[] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 23, 26, 30, 35, 41, 48, 64 };
static const uint8_t band_starts_15[] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 14, 18, 23, 35, 64 };
static const uint8_t band_starts_12[] = { 0, 1, 2, 3, 4, 6, 8, 11, 14, 18, 23, 35, 64 };
static const uint8_t band_starts_9[] = { 0, 1, 2, 3, 5, 7, 9, 14, 23, 64 };
static const uint8_t band_starts_7[] = { 0, 1, 2, 4, 8, 14, 23, 64 };
static const uint8_t band_starts_5[] = { 0, 1, 3, 9, 23, 64 };
static const uint8_t band_starts_3[] = { 0, 3, 14, 64 };
static const uint8_t band_starts_1[] = { 0, 64 };

static const uint8_t *band_starts(int band_count) {
    switch (band_count) {
        case 23: return band_starts_23;
        case 15: return band_starts_15;
        case 12: return band_starts_12;
        case 9: return band_starts_9;
        case 7: return band_starts_7;
        case 5: return band_starts_5;
        case 3: return band_starts_3;
        default: return band_starts_1;
    }
}

/* Table 53, extended by table 47 for the downmixes with top front channels in the places of the back ones */
enum EAC3JOCChannel eac3_joc_input_channel(int downmix, int index) {
    if (index >= 5 && (downmix == EAC3_JOC_DOWNMIX_5_2 || downmix == EAC3_JOC_DOWNMIX_5_2_PHASE_SHIFTED)) {
        return index == 5 ? EAC3_JOC_TOP_FRONT_LEFT : EAC3_JOC_TOP_FRONT_RIGHT;
    }
    return (enum EAC3JOCChannel) index;
}

typedef struct BitReader {
    const uint8_t *data;
    size_t size_bits;
    size_t position;
    int overrun;
} BitReader;

static uint32_t read_bits(BitReader *reader, int count) {
    if (reader->overrun || count > (int) (reader->size_bits - reader->position)) {
        reader->overrun = 1;
        return 0;
    }
    uint32_t value = 0;
    for (int i = 0; i < count; i++) {
        const size_t bit = reader->position++;
        value = (value << 1) | ((reader->data[bit >> 3] >> (7 - (bit & 7))) & 1u);
    }
    return value;
}

/* Pseudocode 4; -1 for a truncated or invalid code */
static int read_huffman(BitReader *reader, const int16_t (*tree)[2], int node_count) {
    int node = 0;
    for (int depth = 0; depth < MAX_HUFFMAN_DEPTH; depth++) {
        const int next = tree[node][read_bits(reader, 1)];
        if (reader->overrun) {
            return -1;
        }
        if (next <= 0) {
            return -next - 1;
        }
        if (next >= node_count) {
            return -1;
        }
        node = next;
    }
    return -1;
}

static float dequantize(int quantized, int fine) {
    const int steps = fine ? 192 : 96;
    return (float) ((double) (quantized - steps / 2) * 820.0 / (4096.0 * (1 + fine)));
}

/* Clause 6.6.2 to 6.6.4 for one data point of one object */
static int parse_matrix(BitReader *reader, int channel_count, int band_count, int sparse, int fine,
        float (*matrix)[EAC3_JOC_MAX_BANDS]) {
    const int steps = fine ? 192 : 96;
    const int16_t (*matrix_tree)[2] = fine ? eac3_joc_huffman_fine_matrix : eac3_joc_huffman_coarse_matrix;
    const int16_t (*vector_tree)[2] = fine ? eac3_joc_huffman_fine_vector : eac3_joc_huffman_coarse_vector;
    const int tree_size = fine ? 191 : 95;
    int quantized[EAC3_JOC_MAX_CHANNELS][EAC3_JOC_MAX_BANDS];
    if (sparse) {
        // Pseudocode 2
        int channel_codes[EAC3_JOC_MAX_BANDS];
        int vector[EAC3_JOC_MAX_BANDS];
        channel_codes[0] = (int) read_bits(reader, 3);
        if (channel_codes[0] >= channel_count) {
            return -1;
        }
        for (int band = 1; band < band_count; band++) {
            channel_codes[band] = channel_count == 5
                ? read_huffman(reader, eac3_joc_huffman_index_5, 4)
                : read_huffman(reader, eac3_joc_huffman_index_7, 6);
            if (channel_codes[band] < 0) {
                return -1;
            }
        }
        for (int band = 0; band < band_count; band++) {
            vector[band] = read_huffman(reader, vector_tree, tree_size);
            if (vector[band] < 0) {
                return -1;
            }
        }
        const int offset = fine ? 100 : 50;
        for (int band = 0; band < band_count; band++) {
            const int selected = band == 0 ? channel_codes[0] : (channel_codes[band - 1] + channel_codes[band]) % channel_count;
            for (int channel = 0; channel < channel_count; channel++) {
                if (channel != selected) {
                    quantized[channel][band] = offset;
                } else if (band == 0) {
                    quantized[channel][band] = (offset + vector[band]) % steps;
                } else {
                    quantized[channel][band] = (quantized[channel][band - 1] + vector[band]) % steps;
                }
            }
        }
    } else {
        // Pseudocode 3
        const int offset = fine ? 96 : 48;
        for (int channel = 0; channel < channel_count; channel++) {
            int value = offset;
            for (int band = 0; band < band_count; band++) {
                const int code = read_huffman(reader, matrix_tree, tree_size);
                if (code < 0) {
                    return -1;
                }
                value = (value + code) % steps;
                quantized[channel][band] = value;
            }
        }
    }
    // Pseudocode 5
    for (int channel = 0; channel < channel_count; channel++) {
        for (int band = 0; band < band_count; band++) {
            matrix[channel][band] = dequantize(quantized[channel][band], fine);
        }
    }
    return 0;
}

int eac3_joc_parse(EAC3JOCFrame *frame, const uint8_t *payload, size_t size) {
    BitReader reader = { payload, size * 8, 0, 0 };
    // joc_header()
    frame->downmix = (uint8_t) read_bits(&reader, 3);
    if (frame->downmix > EAC3_JOC_DOWNMIX_5_2_PHASE_SHIFTED) {
        return -1;
    }
    frame->channel_count = channel_counts[frame->downmix];
    frame->object_count = (uint8_t) (read_bits(&reader, 6) + 1);
    if (frame->object_count > EAC3_JOC_MAX_OBJECTS) {
        return -1;
    }
    // joc_ext_config_idx; its extension data, after joc_data(), is reserved and left unread
    read_bits(&reader, 3);
    // joc_info(): the clip gain, then the sequence count
    read_bits(&reader, 8);
    frame->sequence_count = (uint16_t) read_bits(&reader, 10);
    uint8_t sparse[EAC3_JOC_MAX_OBJECTS] = { 0 };
    uint8_t fine[EAC3_JOC_MAX_OBJECTS] = { 0 };
    for (int index = 0; index < frame->object_count; index++) {
        EAC3JOCObject *object = &frame->objects[index];
        object->present = (uint8_t) read_bits(&reader, 1);
        if (!object->present) {
            continue;
        }
        object->band_count = band_counts[read_bits(&reader, 3)];
        sparse[index] = (uint8_t) read_bits(&reader, 1);
        fine[index] = (uint8_t) read_bits(&reader, 1);
        // joc_data_point_info()
        object->steep = (uint8_t) read_bits(&reader, 1);
        object->data_point_count = (uint8_t) (read_bits(&reader, 1) + 1);
        for (int point = 0; point < object->data_point_count; point++) {
            object->data_point_timeslot[point] = object->steep ? (uint8_t) (read_bits(&reader, 5) + 1) : 0;
        }
    }
    if (reader.overrun) {
        return -1;
    }
    // joc_data()
    for (int index = 0; index < frame->object_count; index++) {
        EAC3JOCObject *object = &frame->objects[index];
        for (int point = 0; object->present && point < object->data_point_count; point++) {
            if (parse_matrix(&reader, frame->channel_count, object->band_count, sparse[index], fine[index],
                    object->matrix[point]) < 0) {
                return -1;
            }
        }
    }
    return reader.overrun ? -1 : 0;
}

void eac3_joc_decoder_reset(EAC3JOCDecoder *decoder) {
    eac3_qmf_init();
    decoder->configured = 0;
    memset(decoder->previous, 0, sizeof(decoder->previous));
    for (int channel = 0; channel < EAC3_JOC_MAX_CHANNELS; channel++) {
        eac3_qmf_analysis_reset(&decoder->analysis[channel]);
    }
    for (int object = 0; object < EAC3_JOC_MAX_OBJECTS; object++) {
        eac3_qmf_synthesis_reset(&decoder->synthesis[object]);
    }
}

/* Takes a frame's configuration, restarting the matrices and synthesis at a splice or a configuration change */
static void begin_frame(EAC3JOCDecoder *decoder, const EAC3JOCFrame *frame) {
    const uint16_t expected = decoder->sequence_count == 1023 ? 1 : (uint16_t) (decoder->sequence_count + 1);
    if (decoder->configured && frame->channel_count == decoder->channel_count && frame->object_count == decoder->object_count
            && frame->sequence_count != 0 && frame->sequence_count == expected) {
        decoder->sequence_count = frame->sequence_count;
        return;
    }
    if (decoder->configured && frame->channel_count != decoder->channel_count) {
        for (int channel = 0; channel < EAC3_JOC_MAX_CHANNELS; channel++) {
            eac3_qmf_analysis_reset(&decoder->analysis[channel]);
        }
    }
    memset(decoder->previous, 0, sizeof(decoder->previous));
    for (int object = 0; object < EAC3_JOC_MAX_OBJECTS; object++) {
        eac3_qmf_synthesis_reset(&decoder->synthesis[object]);
    }
    decoder->configured = 1;
    decoder->channel_count = frame->channel_count;
    decoder->object_count = frame->object_count;
    decoder->sequence_count = frame->sequence_count;
}

/* Clause 6.6.5's weights of the previous matrix and of the two data points at one timeslot */
static void interpolation_weights(const EAC3JOCObject *object, int timeslot, int timeslots, float *weights) {
    weights[0] = 0.0f;
    weights[1] = 0.0f;
    weights[2] = 0.0f;
    if (object == NULL || !object->present) {
        weights[0] = 1.0f;
    } else if (object->steep) {
        if (timeslot < object->data_point_timeslot[0]) {
            weights[0] = 1.0f;
        } else if (object->data_point_count == 1 || timeslot < object->data_point_timeslot[1]) {
            weights[1] = 1.0f;
        } else {
            weights[2] = 1.0f;
        }
    } else if (object->data_point_count == 1) {
        const float fraction = (float) (timeslot + 1) / (float) timeslots;
        weights[0] = 1.0f - fraction;
        weights[1] = fraction;
    } else {
        const int middle = timeslots / 2;
        if (timeslot < middle) {
            const float fraction = (float) (timeslot + 1) / (float) middle;
            weights[0] = 1.0f - fraction;
            weights[1] = fraction;
        } else {
            const float fraction = (float) (timeslot - middle + 1) / (float) (timeslots - middle);
            weights[1] = 1.0f - fraction;
            weights[2] = fraction;
        }
    }
}

int eac3_joc_decode(EAC3JOCDecoder *decoder, const EAC3JOCFrame *frame, const float *const *channels, int timeslots,
        float *const *objects) {
    if (timeslots <= 0 || timeslots > EAC3_JOC_MAX_TIMESLOTS) {
        return 0;
    }
    if (frame != NULL) {
        begin_frame(decoder, frame);
    } else if (!decoder->configured) {
        return 0;
    } else {
        // A lost frame counts in the sequence, so the next one continues from the kept matrices instead of restarting
        decoder->sequence_count = decoder->sequence_count == 1023 ? 1 : (uint16_t) (decoder->sequence_count + 1);
    }
    const int channel_count = decoder->channel_count;
    for (int channel = 0; channel < channel_count; channel++) {
        for (int timeslot = 0; timeslot < timeslots; timeslot++) {
            eac3_qmf_analyze(&decoder->analysis[channel], channels[channel] + EAC3_QMF_BANDS * timeslot,
                decoder->input_real[channel][timeslot], decoder->input_imaginary[channel][timeslot]);
        }
    }
    for (int index = 0; index < decoder->object_count; index++) {
        const EAC3JOCObject *object = frame != NULL ? &frame->objects[index] : NULL;
        const int present = object != NULL && object->present;
        // The data points' matrices per subband
        float points[EAC3_JOC_MAX_DATA_POINTS][EAC3_JOC_MAX_CHANNELS][EAC3_QMF_BANDS];
        if (present) {
            const uint8_t *starts = band_starts(object->band_count);
            for (int point = 0; point < object->data_point_count; point++) {
                for (int channel = 0; channel < channel_count; channel++) {
                    for (int band = 0; band < object->band_count; band++) {
                        for (int subband = starts[band]; subband < starts[band + 1]; subband++) {
                            points[point][channel][subband] = object->matrix[point][channel][band];
                        }
                    }
                }
            }
        }
        float (*previous)[EAC3_QMF_BANDS] = decoder->previous[index];
        for (int timeslot = 0; timeslot < timeslots; timeslot++) {
            float weights[3];
            interpolation_weights(object, timeslot, timeslots, weights);
            float real[EAC3_QMF_BANDS] = { 0.0f };
            float imaginary[EAC3_QMF_BANDS] = { 0.0f };
            for (int channel = 0; channel < channel_count; channel++) {
                const float *input_real = decoder->input_real[channel][timeslot];
                const float *input_imaginary = decoder->input_imaginary[channel][timeslot];
                const float *first = present ? points[0][channel] : previous[channel];
                const float *second = present && object->data_point_count == 2 ? points[1][channel] : first;
                for (int subband = 0; subband < EAC3_QMF_BANDS; subband++) {
                    const float coefficient = weights[0] * previous[channel][subband] + weights[1] * first[subband]
                        + weights[2] * second[subband];
                    real[subband] += coefficient * input_real[subband];
                    imaginary[subband] += coefficient * input_imaginary[subband];
                }
            }
            eac3_qmf_synthesize(&decoder->synthesis[index], real, imaginary, objects[index] + EAC3_QMF_BANDS * timeslot);
        }
        if (present) {
            memcpy(previous, points[object->data_point_count - 1], sizeof(float) * EAC3_QMF_BANDS * (size_t) channel_count);
        }
    }
    return decoder->object_count;
}
