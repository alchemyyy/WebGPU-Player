// OBU syntax from the AV1 specification, sections 5.3 and 5.8
export const AV1_OBU_TYPE_SEQUENCE_HEADER = 1;
export const AV1_OBU_TYPE_TEMPORAL_DELIMITER = 2;
export const AV1_OBU_TYPE_FRAME_HEADER = 3;
export const AV1_OBU_TYPE_TILE_GROUP = 4;
export const AV1_OBU_TYPE_METADATA = 5;
export const AV1_OBU_TYPE_FRAME = 6;
export const AV1_OBU_TYPE_REDUNDANT_FRAME_HEADER = 7;
export const AV1_OBU_TYPE_PADDING = 15;
export const AV1_METADATA_TYPE_HDR_CLL = 1;
export const AV1_METADATA_TYPE_HDR_MDCV = 2;
export const AV1_METADATA_TYPE_ITUT_T35 = 4;

// Four spatial layers of 4096 tile groups, the most tiles one frame can have
const MAXIMUM_OBU_COUNT = 16_384;
const MAXIMUM_LEB128_BYTE_LENGTH = 8;
const MAXIMUM_LEB128_VALUE = 0xFFFF_FFFF;
const LEB128_VALUE_BIT_COUNT = 7;
const LEB128_VALUE_MASK = 0x7F;
const LEB128_CONTINUATION_MASK = 0x80;
const OBU_HEADER_BYTE_LENGTH = 1;
const OBU_EXTENSION_HEADER_BYTE_LENGTH = 1;
const OBU_FORBIDDEN_BIT_MASK = 0x80;
const OBU_TYPE_SHIFT = 3;
const OBU_TYPE_MASK = 0x0F;
const OBU_EXTENSION_FLAG_MASK = 0x04;
const OBU_HAS_SIZE_FIELD_MASK = 0x02;
// trailing_bits() after a byte-aligned payload: the trailing one bit, then zero bits to the byte boundary
const TRAILING_ONE_BIT_BYTE = 0x80;

/** One OBU of a temporal unit, as views of the unit's bytes. */
export type AV1OBU = {
    /** The whole OBU, from its header to the end of its payload */
    data: Uint8Array
    /** The payload; an OBU without a size field runs to the end of its temporal unit */
    payload: Uint8Array
    type: number
};

/** The metadata of one metadata OBU, as a view of its temporal unit. */
export type AV1Metadata = {
    /** Everything after metadata_type, trailing bits included */
    body: Uint8Array
    metadataType: number
};

type LEB128Value = {
    byteLength: number
    value: number
};

/** Reports an AV1 temporal unit whose OBUs cannot be walked, so none of it is passed on. */
export class AV1OBUParseError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'AV1OBUParseError';
    }
}

function requireTemporalUnit(data: Uint8Array): void {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new AV1OBUParseError('The AV1 temporal unit is empty');
    }
}

/** Reads one leb128 value, which the specification bounds to eight bytes and to 2^32 - 1. */
function readLEB128(data: Uint8Array, offset: number, fieldName: string): LEB128Value {
    let value = 0;
    for (let byteIndex = 0; byteIndex < MAXIMUM_LEB128_BYTE_LENGTH; byteIndex += 1) {
        if (offset + byteIndex >= data.byteLength) {
            throw new AV1OBUParseError(`An AV1 ${fieldName} is truncated`);
        }
        const leb128Byte = data[offset + byteIndex];
        // Multiplication, because shifts wrap at 32 bits
        value += (leb128Byte & LEB128_VALUE_MASK) * (2 ** (LEB128_VALUE_BIT_COUNT * byteIndex));
        if ((leb128Byte & LEB128_CONTINUATION_MASK) === 0) {
            if (value > MAXIMUM_LEB128_VALUE) {
                throw new AV1OBUParseError(`An AV1 ${fieldName} exceeds 32 bits`);
            }
            return { byteLength: byteIndex + 1, value };
        }
    }
    throw new AV1OBUParseError(`An AV1 ${fieldName} is longer than eight bytes`);
}

/**
 * Walks the OBUs of one temporal unit in the low-overhead bitstream format without copying them.
 * Only the last OBU may omit its size field, so its payload is the rest of the unit.
 */
export function parseAV1OBUs(data: Uint8Array): AV1OBU[] {
    requireTemporalUnit(data);
    const obus: AV1OBU[] = [];
    let offset = 0;
    while (offset < data.byteLength) {
        if (obus.length >= MAXIMUM_OBU_COUNT) {
            throw new AV1OBUParseError('The AV1 temporal unit contains too many OBUs');
        }
        const header = data[offset];
        if ((header & OBU_FORBIDDEN_BIT_MASK) !== 0) {
            throw new AV1OBUParseError('An AV1 OBU header sets its forbidden bit');
        }
        let payloadOffset = offset + OBU_HEADER_BYTE_LENGTH;
        if ((header & OBU_EXTENSION_FLAG_MASK) !== 0) {
            payloadOffset += OBU_EXTENSION_HEADER_BYTE_LENGTH;
            if (payloadOffset > data.byteLength) {
                throw new AV1OBUParseError('An AV1 OBU extension header is truncated');
            }
        }
        let payloadEnd = data.byteLength;
        if ((header & OBU_HAS_SIZE_FIELD_MASK) !== 0) {
            const obuSize = readLEB128(data, payloadOffset, 'obu_size');
            payloadOffset += obuSize.byteLength;
            payloadEnd = payloadOffset + obuSize.value;
            if (payloadEnd > data.byteLength) {
                throw new AV1OBUParseError('An AV1 obu_size exceeds its temporal unit');
            }
        }
        obus.push({
            data: data.subarray(offset, payloadEnd),
            payload: data.subarray(payloadOffset, payloadEnd),
            type: (header >> OBU_TYPE_SHIFT) & OBU_TYPE_MASK
        });
        offset = payloadEnd;
    }
    return obus;
}

/**
 * Returns whether an OBU carries a frame header, so its temporal unit outputs its one shown frame.
 * A redundant frame header counts as well, because dav1d reads one as the frame header when the original was lost.
 */
export function hasAV1FrameHeader(obu: AV1OBU): boolean {
    switch (obu.type) {
        case AV1_OBU_TYPE_FRAME:
        case AV1_OBU_TYPE_FRAME_HEADER:
        case AV1_OBU_TYPE_REDUNDANT_FRAME_HEADER:
            return true;
        default:
            return false;
    }
}

/** Returns the metadata_type and the body of a metadata OBU, or null for any other OBU. */
export function getAV1Metadata(obu: AV1OBU): AV1Metadata | null {
    if (obu.type !== AV1_OBU_TYPE_METADATA) {
        return null;
    }
    const metadataType = readLEB128(obu.payload, 0, 'metadata_type');
    return {
        body: obu.payload.subarray(metadataType.byteLength),
        metadataType: metadataType.value
    };
}

/**
 * Returns the ITU-T T.35 message of a metadata OBU, or null for any other OBU.
 * The message runs from itu_t_t35_country_code to the end of the payload, trailing bits included.
 * A 0xFF country code is followed by an extension byte, so readers match a provider's whole header.
 */
export function getAV1ITUTT35Message(obu: AV1OBU): Uint8Array | null {
    const metadata = getAV1Metadata(obu);
    return metadata?.metadataType === AV1_METADATA_TYPE_ITUT_T35 ? metadata.body : null;
}

/**
 * Returns a byte-aligned OBU payload without its trailing_bits(), which dav1d finds by dropping the trailing zero bytes, then the byte that holds the trailing one bit.
 * Returns null when that byte is not 0x80, so the payload has no valid trailing one bit.
 */
export function stripAV1TrailingBits(payload: Uint8Array): Uint8Array | null {
    let payloadEnd = payload.byteLength;
    while (payloadEnd > 0 && payload[payloadEnd - 1] === 0) {
        payloadEnd -= 1;
    }
    if (payloadEnd === 0 || payload[payloadEnd - 1] !== TRAILING_ONE_BIT_BYTE) {
        return null;
    }
    return payload.subarray(0, payloadEnd - 1);
}
