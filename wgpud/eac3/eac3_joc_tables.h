/* The tables of ETSI TS 103 420 V1.2.1 Annex A.1 and clause 7.4 that eac3_joc_tables.c holds */
#ifndef EAC3_JOC_TABLES_H
#define EAC3_JOC_TABLES_H

#include <stdint.h>

#define EAC3_QMF_WINDOW_LENGTH 640

extern const int16_t eac3_joc_huffman_coarse_matrix[95][2];
extern const int16_t eac3_joc_huffman_fine_matrix[191][2];
extern const int16_t eac3_joc_huffman_coarse_vector[95][2];
extern const int16_t eac3_joc_huffman_fine_vector[191][2];
extern const int16_t eac3_joc_huffman_index_5[4][2];
extern const int16_t eac3_joc_huffman_index_7[6][2];
extern const float eac3_qmf_window[EAC3_QMF_WINDOW_LENGTH];

#endif
