/*
 * The EMDF container (ETSI TS 102 366 V1.4.1 Annex H) of an AC-3 or E-AC-3 syncframe, and the object audio payloads
 * ETSI TS 103 420 V1.2.1 clause 8.2 carries in it: object audio metadata (payload 11) and joint object coding (payload 14).
 */
#ifndef EAC3_EMDF_H
#define EAC3_EMDF_H

#include <stddef.h>
#include <stdint.h>

/* The largest payload a container in a syncframe holds: auxdatal counts at most 16383 bits */
#define EAC3_EMDF_MAX_PAYLOAD 2048

typedef struct EAC3AtmosPayloads {
    uint8_t has_joc;
    uint8_t has_oamd;
    uint16_t joc_size;
    uint16_t oamd_size;
    /* The OAMD payload's smploffst: the frame sample its timing counts from */
    uint16_t oamd_sample_offset;
    uint8_t joc[EAC3_EMDF_MAX_PAYLOAD];
    uint8_t oamd[EAC3_EMDF_MAX_PAYLOAD];
} EAC3AtmosPayloads;

/*
 * Finds the EMDF container that carries a JOC payload in one syncframe of frame_size bytes, and copies its JOC and
 * OAMD payloads out. Returns 1 when it found one, else 0.
 *
 * The container is either the frame-end auxiliary data, which auxdatal locates, or the skip field (skipfld) of an
 * audio block. Reaching a skip field exactly takes the whole audio block syntax up to it, so the search instead
 * takes an EMDF syncword whose preceding ten bits read as skiple set and a skipl long enough to hold the container,
 * and whose container parses completely within that length.
 */
int eac3_find_atmos_payloads(const uint8_t *frame, size_t frame_size, EAC3AtmosPayloads *payloads);

#endif
