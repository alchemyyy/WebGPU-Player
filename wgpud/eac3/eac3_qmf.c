/*
 * The complex quadrature mirror filter bank of ETSI TS 103 420 V1.2.1 clause 7, computed through a 128-point FFT.
 *
 * Analysis (clause 7.2): Q[k] = sum over j < 128 of u[j] e^(i pi (k + 1/2)(j - 1/2) / 64), which is
 * e^(-i pi (2k + 1) / 256) times the inverse DFT of u[j] e^(i pi j / 128).
 * Synthesis (clause 7.3) follows the matrix equation N[j,k] = e^(i pi (k + 1/2)(j - 2n + 1/2) / n) / n, which is
 * e^(i pi (2j - 255) / 256) times the inverse DFT of Q[k] e^(-i pi 255 k / 128) / 64. The clause's pseudocode 14 writes
 * the exponent as (2j - 2n - 1) instead; only the equation's form reconstructs the input, delayed by 577 samples.
 */

#include <math.h>
#include <string.h>

#include "eac3_joc_tables.h"
#include "eac3_qmf.h"

#define FFT_LENGTH 128
#define ANALYSIS_LENGTH 640
#define SYNTHESIS_LENGTH 1280

static struct {
    int ready;
    uint8_t bit_reverse[FFT_LENGTH];
    float twiddle_real[FFT_LENGTH / 2];
    float twiddle_imaginary[FFT_LENGTH / 2];
    float analysis_pre_real[FFT_LENGTH];
    float analysis_pre_imaginary[FFT_LENGTH];
    float analysis_post_real[EAC3_QMF_BANDS];
    float analysis_post_imaginary[EAC3_QMF_BANDS];
    float synthesis_pre_real[EAC3_QMF_BANDS];
    float synthesis_pre_imaginary[EAC3_QMF_BANDS];
    float synthesis_post_real[FFT_LENGTH];
    float synthesis_post_imaginary[FFT_LENGTH];
} tables;

void eac3_qmf_init(void) {
    if (tables.ready) {
        return;
    }
    const double pi = 3.14159265358979323846;
    for (int i = 0; i < FFT_LENGTH; i++) {
        int reversed = 0;
        for (int bit = 0; bit < 7; bit++) {
            reversed |= ((i >> bit) & 1) << (6 - bit);
        }
        tables.bit_reverse[i] = (uint8_t) reversed;
        tables.analysis_pre_real[i] = (float) cos(pi * i / 128.0);
        tables.analysis_pre_imaginary[i] = (float) sin(pi * i / 128.0);
        tables.synthesis_post_real[i] = (float) cos(pi * (2 * i - 255) / 256.0);
        tables.synthesis_post_imaginary[i] = (float) sin(pi * (2 * i - 255) / 256.0);
    }
    for (int i = 0; i < FFT_LENGTH / 2; i++) {
        tables.twiddle_real[i] = (float) cos(2.0 * pi * i / FFT_LENGTH);
        tables.twiddle_imaginary[i] = (float) sin(2.0 * pi * i / FFT_LENGTH);
    }
    for (int k = 0; k < EAC3_QMF_BANDS; k++) {
        tables.analysis_post_real[k] = (float) cos(-pi * (2 * k + 1) / 256.0);
        tables.analysis_post_imaginary[k] = (float) sin(-pi * (2 * k + 1) / 256.0);
        // The synthesis scale of 1/64 rides on its pre-twiddle
        tables.synthesis_pre_real[k] = (float) (cos(-pi * 255.0 * k / 128.0) / 64.0);
        tables.synthesis_pre_imaginary[k] = (float) (sin(-pi * 255.0 * k / 128.0) / 64.0);
    }
    tables.ready = 1;
}

/* In place, unscaled, with the positive exponent e^(+i 2 pi k j / 128); the input is in bit-reversed order */
static void inverse_fft(float *real, float *imaginary) {
    for (int size = 2; size <= FFT_LENGTH; size <<= 1) {
        const int half = size >> 1;
        const int stride = FFT_LENGTH / size;
        for (int start = 0; start < FFT_LENGTH; start += size) {
            for (int i = 0; i < half; i++) {
                const float wr = tables.twiddle_real[i * stride];
                const float wi = tables.twiddle_imaginary[i * stride];
                const int a = start + i;
                const int b = a + half;
                const float br = real[b] * wr - imaginary[b] * wi;
                const float bi = real[b] * wi + imaginary[b] * wr;
                real[b] = real[a] - br;
                imaginary[b] = imaginary[a] - bi;
                real[a] += br;
                imaginary[a] += bi;
            }
        }
    }
}

void eac3_qmf_analysis_reset(EAC3QMFAnalysis *analysis) {
    memset(analysis, 0, sizeof(*analysis));
}

void eac3_qmf_synthesis_reset(EAC3QMFSynthesis *synthesis) {
    memset(synthesis, 0, sizeof(*synthesis));
}

void eac3_qmf_analyze(EAC3QMFAnalysis *analysis, const float *samples, float *real, float *imaginary) {
    // Pseudocode 8 and 9: the newest samples, latest first, lead the history
    analysis->position = (analysis->position + ANALYSIS_LENGTH - EAC3_QMF_BANDS) % ANALYSIS_LENGTH;
    float *history = analysis->history + analysis->position;
    for (int j = 0; j < EAC3_QMF_BANDS; j++) {
        history[j] = samples[EAC3_QMF_BANDS - 1 - j];
        history[j + ANALYSIS_LENGTH] = history[j];
    }
    // Pseudocode 10 and 11: the windowed history folded into 128 samples, pre-twiddled into bit-reversed order
    float fft_real[FFT_LENGTH];
    float fft_imaginary[FFT_LENGTH];
    for (int j = 0; j < FFT_LENGTH; j++) {
        float u = 0.0f;
        for (int fold = 0; fold < ANALYSIS_LENGTH; fold += FFT_LENGTH) {
            u += history[j + fold] * eac3_qmf_window[j + fold];
        }
        const int index = tables.bit_reverse[j];
        fft_real[index] = u * tables.analysis_pre_real[j];
        fft_imaginary[index] = u * tables.analysis_pre_imaginary[j];
    }
    // Pseudocode 12
    inverse_fft(fft_real, fft_imaginary);
    for (int k = 0; k < EAC3_QMF_BANDS; k++) {
        real[k] = fft_real[k] * tables.analysis_post_real[k] - fft_imaginary[k] * tables.analysis_post_imaginary[k];
        imaginary[k] = fft_real[k] * tables.analysis_post_imaginary[k] + fft_imaginary[k] * tables.analysis_post_real[k];
    }
}

void eac3_qmf_synthesize(EAC3QMFSynthesis *synthesis, const float *real, const float *imaginary, float *samples) {
    // Pseudocode 13 and 14: 128 new samples lead the history
    float fft_real[FFT_LENGTH] = { 0.0f };
    float fft_imaginary[FFT_LENGTH] = { 0.0f };
    for (int k = 0; k < EAC3_QMF_BANDS; k++) {
        const int index = tables.bit_reverse[k];
        fft_real[index] = real[k] * tables.synthesis_pre_real[k] - imaginary[k] * tables.synthesis_pre_imaginary[k];
        fft_imaginary[index] = real[k] * tables.synthesis_pre_imaginary[k] + imaginary[k] * tables.synthesis_pre_real[k];
    }
    inverse_fft(fft_real, fft_imaginary);
    synthesis->position = (synthesis->position + SYNTHESIS_LENGTH - FFT_LENGTH) % SYNTHESIS_LENGTH;
    float *history = synthesis->history + synthesis->position;
    for (int j = 0; j < FFT_LENGTH; j++) {
        history[j] = fft_real[j] * tables.synthesis_post_real[j] - fft_imaginary[j] * tables.synthesis_post_imaginary[j];
        history[j + SYNTHESIS_LENGTH] = history[j];
    }
    // Pseudocode 15 to 17: the window over every other half of each 256-sample group, summed per output sample
    for (int t = 0; t < EAC3_QMF_BANDS; t++) {
        float sample = 0.0f;
        for (int group = 0; group < ANALYSIS_LENGTH / FFT_LENGTH; group++) {
            sample += history[256 * group + t] * eac3_qmf_window[128 * group + t]
                + history[256 * group + 192 + t] * eac3_qmf_window[128 * group + 64 + t];
        }
        samples[t] = sample;
    }
}
