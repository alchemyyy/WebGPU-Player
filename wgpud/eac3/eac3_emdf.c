/*
 * Locates and parses the EMDF container of a syncframe (ETSI TS 102 366 V1.4.1 Annex H) and extracts the object audio
 * payloads of ETSI TS 103 420 V1.2.1 clause 8.2. Every read is bounded by the container's declared length.
 */

#include <string.h>

#include "eac3_emdf.h"

#define EMDF_SYNCWORD 0x5838
#define PAYLOAD_OAMD 11
#define PAYLOAD_JOC 14
/* variable_bits groups beyond these bound no field of a valid container */
#define MAX_VARIABLE_GROUPS 4

typedef struct BitReader {
    const uint8_t *data;
    size_t position;
    size_t end;
    int overrun;
} BitReader;

static uint32_t read_bits(BitReader *reader, int count) {
    if (reader->overrun || reader->position > reader->end || (size_t) count > reader->end - reader->position) {
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

/* TS 102 366 clause H.2.1.2.1 */
static uint32_t read_variable_bits(BitReader *reader, int count) {
    uint32_t value = 0;
    for (int group = 0; group < MAX_VARIABLE_GROUPS; group++) {
        value += read_bits(reader, count);
        if (!read_bits(reader, 1)) {
            return value;
        }
        value = (value << count) + (1u << count);
    }
    reader->overrun = 1;
    return 0;
}

static void copy_bits(BitReader *reader, uint8_t *destination, uint32_t byte_count) {
    for (uint32_t i = 0; i < byte_count; i++) {
        destination[i] = (uint8_t) read_bits(reader, 8);
    }
}

/*
 * Parses an emdf_container() that starts at bit `start` with its syncword, within bits [start, region_end).
 * Returns 1 when the whole container parsed and carried a JOC payload, which it copied out with any OAMD payload.
 */
static int parse_container(const uint8_t *data, size_t start, size_t region_end, EAC3AtmosPayloads *payloads) {
    BitReader reader = { data, start, region_end, 0 };
    if (read_bits(&reader, 16) != EMDF_SYNCWORD) {
        return 0;
    }
    const uint32_t length = read_bits(&reader, 16);
    if (reader.overrun || length == 0 || (size_t) length * 8 > region_end - reader.position) {
        return 0;
    }
    reader.end = reader.position + (size_t) length * 8;
    uint32_t version = read_bits(&reader, 2);
    if (version == 3) {
        version += read_variable_bits(&reader, 2);
    }
    // Annex H defines version 0 only
    if (version != 0) {
        return 0;
    }
    if (read_bits(&reader, 3) == 7) {
        read_variable_bits(&reader, 3);
    }
    payloads->has_joc = 0;
    payloads->has_oamd = 0;
    for (;;) {
        uint32_t id = read_bits(&reader, 5);
        if (id == 0x1F) {
            id += read_variable_bits(&reader, 5);
        }
        if (reader.overrun) {
            return 0;
        }
        if (id == 0) {
            break;
        }
        // emdf_payload_config()
        uint32_t sample_offset = 0;
        const uint32_t sample_offset_exists = read_bits(&reader, 1);
        if (sample_offset_exists) {
            sample_offset = read_bits(&reader, 11);
            read_bits(&reader, 1);
        }
        if (read_bits(&reader, 1)) {
            read_variable_bits(&reader, 11);
        }
        if (read_bits(&reader, 1)) {
            read_variable_bits(&reader, 2);
        }
        if (read_bits(&reader, 1)) {
            read_bits(&reader, 8);
        }
        if (!read_bits(&reader, 1)) {
            uint32_t frame_aligned = 0;
            if (!sample_offset_exists) {
                frame_aligned = read_bits(&reader, 1);
                if (frame_aligned) {
                    read_bits(&reader, 2);
                }
            }
            if (sample_offset_exists || frame_aligned) {
                read_bits(&reader, 7);
            }
        }
        const uint32_t size = read_variable_bits(&reader, 8);
        if (reader.overrun || (size_t) size * 8 > reader.end - reader.position) {
            return 0;
        }
        if (id == PAYLOAD_JOC && size <= EAC3_EMDF_MAX_PAYLOAD) {
            copy_bits(&reader, payloads->joc, size);
            payloads->joc_size = (uint16_t) size;
            payloads->has_joc = 1;
        } else if (id == PAYLOAD_OAMD && size <= EAC3_EMDF_MAX_PAYLOAD) {
            copy_bits(&reader, payloads->oamd, size);
            payloads->oamd_size = (uint16_t) size;
            payloads->oamd_sample_offset = (uint16_t) sample_offset;
            payloads->has_oamd = 1;
        } else {
            reader.position += (size_t) size * 8;
        }
    }
    // emdf_protection(): a primary length of 0 is reserved
    static const int protection_bits[] = { 0, 8, 32, 128 };
    const uint32_t primary = read_bits(&reader, 2);
    const uint32_t secondary = read_bits(&reader, 2);
    if (reader.overrun || primary == 0
            || (size_t) (protection_bits[primary] + protection_bits[secondary]) > reader.end - reader.position) {
        payloads->has_joc = 0;
        payloads->has_oamd = 0;
        return 0;
    }
    return payloads->has_joc;
}

static uint32_t bits_at(const uint8_t *data, size_t position, int count) {
    BitReader reader = { data, position, position + (size_t) count, 0 };
    return read_bits(&reader, count);
}

int eac3_find_atmos_payloads(const uint8_t *frame, size_t frame_size, EAC3AtmosPayloads *payloads) {
    // A syncframe ends with auxdatal (14 bits), auxdatae, crcrsv, and crc2 (16 bits)
    if (frame_size < 16) {
        return 0;
    }
    const size_t frame_bits = frame_size * 8;
    const size_t auxiliary_end = frame_bits - 32;
    if (bits_at(frame, frame_bits - 18, 1)) {
        const size_t auxiliary_bits = bits_at(frame, auxiliary_end, 14);
        // The auxiliary data, auxdatal bits long, ends where auxdatal starts
        if (auxiliary_bits <= auxiliary_end - 16 && parse_container(frame, auxiliary_end - auxiliary_bits, auxiliary_end, payloads)) {
            return 1;
        }
    }
    // A skip field: skiple (1), skipl (9), then skipl bytes; past the syncframe's 16-bit syncword and before its end.
    // A 32-bit window over each byte finds the syncword at any bit offset
    for (size_t byte = 3; (byte + 4) * 8 <= auxiliary_end; byte++) {
        const uint32_t window = (uint32_t) frame[byte] << 24 | (uint32_t) frame[byte + 1] << 16 | (uint32_t) frame[byte + 2] << 8 | frame[byte + 3];
        for (int shift = 0; shift < 8; shift++) {
            if (((window >> (16 - shift)) & 0xFFFFu) != EMDF_SYNCWORD) {
                continue;
            }
            const size_t position = byte * 8 + (size_t) shift;
            if (position + 32 > auxiliary_end || !bits_at(frame, position - 10, 1)) {
                continue;
            }
            const size_t skip_bits = (size_t) bits_at(frame, position - 9, 9) * 8;
            if (skip_bits < 32 || skip_bits > auxiliary_end - position) {
                continue;
            }
            if (parse_container(frame, position, position + skip_bits, payloads)) {
                return 1;
            }
        }
    }
    return 0;
}
