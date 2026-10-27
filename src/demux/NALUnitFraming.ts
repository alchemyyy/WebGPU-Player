// The two framings of H.264 and HEVC NAL units: Annex B, each unit behind a three or four-byte start code, and the length prefixes of an avcC or hvcC track.

// The most NAL units one access unit may hold
const MAXIMUM_NAL_UNIT_COUNT = 4_096;

/** The byte length of each NAL unit's length prefix, which an avcC or hvcC declares. */
export type NALUnitLengthSize = 1 | 2 | 3 | 4;

type AnnexBStartCode = {
    byteLength: 3 | 4
    offset: number
};

function findAnnexBStartCode(data: Uint8Array, startOffset: number): AnnexBStartCode | null {
    for (let offset = startOffset; offset + 3 <= data.byteLength; offset += 1) {
        if (data[offset] !== 0 || data[offset + 1] !== 0) {
            continue;
        }
        if (data[offset + 2] === 1) {
            return { byteLength: 3, offset };
        }
        if (offset + 4 <= data.byteLength && data[offset + 2] === 0 && data[offset + 3] === 1) {
            return { byteLength: 4, offset };
        }
    }
    return null;
}

/**
 * Splits Annex B data at its start codes into NAL units with their headers, without copying them.
 * Only zero bytes may precede the first start code; a failure names its subject, such as `HEVC access unit`.
 */
export function splitAnnexBNALUnits(data: Uint8Array, subject: string): Uint8Array[] {
    const nalUnits: Uint8Array[] = [];
    let startCode = findAnnexBStartCode(data, 0);
    if (!startCode) {
        throw new TypeError(`The ${subject} has no Annex B start code`);
    }
    for (let prefixIndex = 0; prefixIndex < startCode.offset; prefixIndex += 1) {
        if (data[prefixIndex] !== 0) {
            throw new TypeError(`The ${subject} has data before its first start code`);
        }
    }

    while (startCode) {
        if (nalUnits.length >= MAXIMUM_NAL_UNIT_COUNT) {
            throw new TypeError(`The ${subject} contains too many NAL units`);
        }
        const nalUnitOffset = startCode.offset + startCode.byteLength;
        const nextStartCode = findAnnexBStartCode(data, nalUnitOffset);
        const nalUnitEnd = nextStartCode?.offset ?? data.byteLength;
        nalUnits.push(data.subarray(nalUnitOffset, nalUnitEnd));
        startCode = nextStartCode;
    }
    return nalUnits;
}

/**
 * Splits data framed by big-endian length prefixes of one to four bytes into NAL units with their headers, without copying them.
 * An empty unit or a length past the data's end fails; a failure names its subject, such as `HEVC access unit`.
 */
export function splitLengthPrefixedNALUnits(data: Uint8Array, lengthSize: NALUnitLengthSize, subject: string): Uint8Array[] {
    const nalUnits: Uint8Array[] = [];
    let offset = 0;
    while (offset < data.byteLength) {
        if (nalUnits.length >= MAXIMUM_NAL_UNIT_COUNT) {
            throw new TypeError(`The ${subject} contains too many NAL units`);
        }
        if (offset + lengthSize > data.byteLength) {
            throw new TypeError(`The ${subject} ends inside a NAL unit length`);
        }
        let nalUnitByteLength = 0;
        for (let byteIndex = 0; byteIndex < lengthSize; byteIndex += 1) {
            nalUnitByteLength = (nalUnitByteLength * 256) + data[offset + byteIndex];
        }
        offset += lengthSize;
        if (nalUnitByteLength === 0 || offset + nalUnitByteLength > data.byteLength) {
            throw new TypeError(`The ${subject} contains an invalid NAL unit length`);
        }
        nalUnits.push(data.subarray(offset, offset + nalUnitByteLength));
        offset += nalUnitByteLength;
    }
    return nalUnits;
}
