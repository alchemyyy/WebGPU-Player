/*
 * The binaural stage: the virtual 7.1.4 speakers convolved with their head-related impulse responses (atmos_hrir.c) into two ears,
 * with the LFE added to both ears without them. Our own code.
 *
 * Convolution is uniformly partitioned overlap-save in the frequency domain: each HRIR splits into partitions of
 * ATMOS_BINAURAL_LATENCY taps, whose spectra of twice that length are computed once; every block of that many input samples is
 * transformed once per speaker, kept in a delay line of spectra, multiplied with the partitions' spectra and summed per ear, and one inverse
 * transform yields both ears. Two real signals share each complex transform (one as its real part, one as its imaginary part), so a block
 * costs six forward and one inverse 256-point transform. The output is one block late.
 */

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "atmos_internal.h"

#define BLOCK ATMOS_BINAURAL_LATENCY
#define FFT_SIZE (2 * BLOCK)
#define BINS (BLOCK + 1)
#define PARTITIONS ((ATMOS_HRIR_LENGTH + BLOCK - 1) / BLOCK)
#define PI 3.14159265358979323846

typedef struct Complex {
    float re;
    float im;
} Complex;

struct AtmosBinaural {
    /* Twiddle factors e^(-2 pi i k / N) and the bit-reversal permutation */
    Complex twiddles[FFT_SIZE / 2];
    uint16_t reversed[FFT_SIZE];
    /* Each partition's spectrum, per speaker and ear */
    Complex filters[PARTITIONS][ATMOS_HRIR_SPEAKER_COUNT][2][BINS];
    /* The spectra of the last PARTITIONS input blocks, per speaker; newest at delay_position */
    Complex delay_line[PARTITIONS][ATMOS_HRIR_SPEAKER_COUNT][BINS];
    uint32_t delay_position;
    /* Each speaker's previous and current input block, the overlap-save frame */
    float previous[ATMOS_HRIR_SPEAKER_COUNT][BLOCK];
    float current[ATMOS_HRIR_SPEAKER_COUNT][BLOCK];
    float lfe[BLOCK];
    /* The block being output while the next one fills, and the LFE delayed to match it */
    float output[2][BLOCK];
    float delayed_lfe[BLOCK];
    uint32_t fill;
    Complex work[FFT_SIZE];
};

/* In-place radix-2 transform of FFT_SIZE points, forward with e^(-i...) or inverse with e^(+i...), unnormalized */
static void transform(const AtmosBinaural *binaural, Complex *data, int inverse) {
    for (uint32_t index = 0; index < FFT_SIZE; index++) {
        const uint32_t target = binaural->reversed[index];
        if (target > index) {
            const Complex swap = data[index];
            data[index] = data[target];
            data[target] = swap;
        }
    }
    for (uint32_t size = 2; size <= FFT_SIZE; size <<= 1) {
        const uint32_t half = size >> 1;
        const uint32_t stride = FFT_SIZE / size;
        for (uint32_t start = 0; start < FFT_SIZE; start += size) {
            for (uint32_t index = 0; index < half; index++) {
                Complex twiddle = binaural->twiddles[index * stride];
                if (inverse) {
                    twiddle.im = -twiddle.im;
                }
                Complex *a = &data[start + index];
                Complex *b = &data[start + index + half];
                const float re = b->re * twiddle.re - b->im * twiddle.im;
                const float im = b->re * twiddle.im + b->im * twiddle.re;
                b->re = a->re - re;
                b->im = a->im - im;
                a->re += re;
                a->im += im;
            }
        }
    }
}

/* Splits the transform of a + i b, both real, into the half spectra of a and b */
static void split_spectra(const Complex *z, Complex *a, Complex *b) {
    for (uint32_t k = 0; k < BINS; k++) {
        const Complex zk = z[k];
        const Complex zn = z[(FFT_SIZE - k) % FFT_SIZE];
        /* A[k] = (Z[k] + conj Z[N-k]) / 2, B[k] = (Z[k] - conj Z[N-k]) / 2i */
        a[k].re = 0.5f * (zk.re + zn.re);
        a[k].im = 0.5f * (zk.im - zn.im);
        if (b != NULL) {
            b[k].re = 0.5f * (zk.im + zn.im);
            b[k].im = 0.5f * (zn.re - zk.re);
        }
    }
}

AtmosBinaural *atmos_binaural_create(void) {
    AtmosBinaural *binaural = calloc(1, sizeof(*binaural));
    if (binaural == NULL) {
        return NULL;
    }
    for (uint32_t index = 0; index < FFT_SIZE / 2; index++) {
        const double angle = -2.0 * PI * (double) index / FFT_SIZE;
        binaural->twiddles[index].re = (float) cos(angle);
        binaural->twiddles[index].im = (float) sin(angle);
    }
    uint32_t bits = 0;
    while ((1u << bits) < FFT_SIZE) {
        bits++;
    }
    for (uint32_t index = 0; index < FFT_SIZE; index++) {
        uint32_t reversed = 0;
        for (uint32_t bit = 0; bit < bits; bit++) {
            reversed |= ((index >> bit) & 1u) << (bits - 1 - bit);
        }
        binaural->reversed[index] = (uint16_t) reversed;
    }
    /* The partition spectra, both ears of a speaker in one transform; the inverse transform's 1/N is folded into them */
    for (uint32_t partition = 0; partition < PARTITIONS; partition++) {
        for (uint32_t speaker = 0; speaker < ATMOS_HRIR_SPEAKER_COUNT; speaker++) {
            memset(binaural->work, 0, sizeof(binaural->work));
            for (uint32_t tap = 0; tap < BLOCK; tap++) {
                const uint32_t source = partition * BLOCK + tap;
                if (source < ATMOS_HRIR_LENGTH) {
                    binaural->work[tap].re = atmos_hrir[speaker][0][source] / FFT_SIZE;
                    binaural->work[tap].im = atmos_hrir[speaker][1][source] / FFT_SIZE;
                }
            }
            transform(binaural, binaural->work, 0);
            split_spectra(binaural->work, binaural->filters[partition][speaker][0], binaural->filters[partition][speaker][1]);
        }
    }
    return binaural;
}

void atmos_binaural_destroy(AtmosBinaural *binaural) {
    free(binaural);
}

void atmos_binaural_reset(AtmosBinaural *binaural) {
    memset(binaural->delay_line, 0, sizeof(binaural->delay_line));
    memset(binaural->previous, 0, sizeof(binaural->previous));
    memset(binaural->current, 0, sizeof(binaural->current));
    memset(binaural->lfe, 0, sizeof(binaural->lfe));
    memset(binaural->output, 0, sizeof(binaural->output));
    memset(binaural->delayed_lfe, 0, sizeof(binaural->delayed_lfe));
    binaural->delay_position = 0;
    binaural->fill = 0;
}

/* Convolves the completed input block into the next output block */
static void process_block(AtmosBinaural *binaural) {
    binaural->delay_position = (binaural->delay_position + 1) % PARTITIONS;
    Complex (*newest)[BINS] = binaural->delay_line[binaural->delay_position];
    for (uint32_t speaker = 0; speaker < ATMOS_HRIR_SPEAKER_COUNT; speaker += 2) {
        const int pair = speaker + 1 < ATMOS_HRIR_SPEAKER_COUNT;
        Complex *work = binaural->work;
        for (uint32_t index = 0; index < BLOCK; index++) {
            work[index].re = binaural->previous[speaker][index];
            work[index].im = pair ? binaural->previous[speaker + 1][index] : 0.0f;
            work[BLOCK + index].re = binaural->current[speaker][index];
            work[BLOCK + index].im = pair ? binaural->current[speaker + 1][index] : 0.0f;
        }
        transform(binaural, work, 0);
        split_spectra(work, newest[speaker], pair ? newest[speaker + 1] : NULL);
    }
    Complex left[BINS];
    Complex right[BINS];
    memset(left, 0, sizeof(left));
    memset(right, 0, sizeof(right));
    for (uint32_t partition = 0; partition < PARTITIONS; partition++) {
        const Complex (*input)[BINS] = (const Complex (*)[BINS]) binaural->delay_line[(binaural->delay_position + PARTITIONS - partition) % PARTITIONS];
        for (uint32_t speaker = 0; speaker < ATMOS_HRIR_SPEAKER_COUNT; speaker++) {
            const Complex *x = input[speaker];
            const Complex *hl = binaural->filters[partition][speaker][0];
            const Complex *hr = binaural->filters[partition][speaker][1];
            for (uint32_t k = 0; k < BINS; k++) {
                left[k].re += x[k].re * hl[k].re - x[k].im * hl[k].im;
                left[k].im += x[k].re * hl[k].im + x[k].im * hl[k].re;
                right[k].re += x[k].re * hr[k].re - x[k].im * hr[k].im;
                right[k].im += x[k].re * hr[k].im + x[k].im * hr[k].re;
            }
        }
    }
    /* Z = L + i R over the full spectrum, from the Hermitian halves of the two real outputs */
    Complex *work = binaural->work;
    for (uint32_t k = 0; k < BINS; k++) {
        work[k].re = left[k].re - right[k].im;
        work[k].im = left[k].im + right[k].re;
        if (k > 0 && k < BLOCK) {
            work[FFT_SIZE - k].re = left[k].re + right[k].im;
            work[FFT_SIZE - k].im = right[k].re - left[k].im;
        }
    }
    transform(binaural, work, 1);
    for (uint32_t index = 0; index < BLOCK; index++) {
        binaural->output[0][index] = work[BLOCK + index].re;
        binaural->output[1][index] = work[BLOCK + index].im;
    }
    memcpy(binaural->previous, binaural->current, sizeof(binaural->previous));
    memcpy(binaural->delayed_lfe, binaural->lfe, sizeof(binaural->lfe));
}

void atmos_binaural_process(AtmosBinaural *binaural, float *const *virtual_planes, uint32_t frame_count, float *left, float *right) {
    uint32_t position = 0;
    while (position < frame_count) {
        const uint32_t fill = binaural->fill;
        const uint32_t count = BLOCK - fill < frame_count - position ? BLOCK - fill : frame_count - position;
        uint32_t speaker = 0;
        for (uint32_t channel = 0; channel < ATMOS_BINAURAL_VIRTUAL_CHANNELS; channel++) {
            if (channel == ATMOS_BINAURAL_LFE_CHANNEL) {
                memcpy(binaural->lfe + fill, virtual_planes[channel] + position, sizeof(float) * count);
            } else {
                memcpy(binaural->current[speaker++] + fill, virtual_planes[channel] + position, sizeof(float) * count);
            }
        }
        for (uint32_t index = 0; index < count; index++) {
            const float lfe = ATMOS_BINAURAL_LFE_GAIN * binaural->delayed_lfe[fill + index];
            left[position + index] = binaural->output[0][fill + index] + lfe;
            right[position + index] = binaural->output[1][fill + index] + lfe;
        }
        binaural->fill += count;
        position += count;
        if (binaural->fill == BLOCK) {
            process_block(binaural);
            binaural->fill = 0;
        }
    }
}
