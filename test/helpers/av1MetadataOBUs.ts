// AV1 OBUs, metadata OBUs included, that the AV1 tests build their temporal units from

const OBU_TYPE_SHIFT = 3;
const OBU_HAS_SIZE_FIELD_FLAG = 0x02;
const OBU_TYPE_METADATA = 5;
const LEB128_VALUE_BIT_COUNT = 7;
const LEB128_VALUE_MODULUS = 2 ** LEB128_VALUE_BIT_COUNT;
const LEB128_CONTINUATION_FLAG = 0x80;
// trailing_bits() after a byte-aligned payload: the trailing one bit, then zero bits to the byte boundary
export const AV1_TRAILING_BITS_BYTE = 0x80;

function encodeLEB128(value: number): number[] {
    const bytes: number[] = [];
    let remainingValue = value;
    do {
        const valueBits = remainingValue % LEB128_VALUE_MODULUS;
        remainingValue = Math.floor(remainingValue / LEB128_VALUE_MODULUS);
        bytes.push(remainingValue > 0 ? valueBits | LEB128_CONTINUATION_FLAG : valueBits);
    } while (remainingValue > 0);
    return bytes;
}

/** Creates one OBU with a size field and no extension header. */
export function createAV1OBU(type: number, payload: ArrayLike<number>): Uint8Array {
    const payloadBytes = Array.from(payload);
    return new Uint8Array([
        (type << OBU_TYPE_SHIFT) | OBU_HAS_SIZE_FIELD_FLAG,
        ...encodeLEB128(payloadBytes.length),
        ...payloadBytes
    ]);
}

/** Creates a metadata OBU: metadata_type, the metadata, then its trailing bits, one 0x80 byte unless given. */
export function createAV1MetadataOBU(
    metadataType: number,
    metadata: ArrayLike<number>,
    trailingBits: readonly number[] = [ AV1_TRAILING_BITS_BYTE ]
): Uint8Array {
    return createAV1OBU(OBU_TYPE_METADATA, [ ...encodeLEB128(metadataType), ...Array.from(metadata), ...trailingBits ]);
}
