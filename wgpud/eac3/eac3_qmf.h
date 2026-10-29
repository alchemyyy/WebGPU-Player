/*
 * The complex quadrature mirror filter bank of ETSI TS 103 420 V1.2.1 clause 7: 64 subbands, a 640-coefficient window,
 * one complex timeslot per 64 samples. eac3_qmf.c computes it with a 128-point FFT.
 */
#ifndef EAC3_QMF_H
#define EAC3_QMF_H

/* Subbands, and samples per timeslot */
#define EAC3_QMF_BANDS 64
/* Samples from a sample entering analysis to the same sample leaving synthesis */
#define EAC3_QMF_DELAY 577

/* The analysis history of one channel: two copies of the 640 latest samples, so every window reads contiguously */
typedef struct EAC3QMFAnalysis {
    float history[2 * 640];
    int position;
} EAC3QMFAnalysis;

/* The synthesis history of one channel: two copies of its 1280 latest transformed samples */
typedef struct EAC3QMFSynthesis {
    float history[2 * 1280];
    int position;
} EAC3QMFSynthesis;

/* Builds the transform tables once; every other call needs them */
void eac3_qmf_init(void);

void eac3_qmf_analysis_reset(EAC3QMFAnalysis *analysis);
void eac3_qmf_synthesis_reset(EAC3QMFSynthesis *synthesis);

/* Clause 7.2: 64 samples into one timeslot of 64 complex subband samples */
void eac3_qmf_analyze(EAC3QMFAnalysis *analysis, const float *samples, float *real, float *imaginary);

/* Clause 7.3: one timeslot of 64 complex subband samples into 64 samples */
void eac3_qmf_synthesize(EAC3QMFSynthesis *synthesis, const float *real, const float *imaginary, float *samples);

#endif
