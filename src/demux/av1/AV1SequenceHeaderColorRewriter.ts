import {
    AV1_OBU_TYPE_SEQUENCE_HEADER,
    AV1OBUParseError,
    type AV1OBU
} from './AV1OBUParser';
import {
    parseAV1SequenceHeaderLayout,
    type AV1SequenceHeader
} from './AV1SequenceHeaderParser';

// Sequence header syntax from the AV1 specification, section 5.5.2
const HIGH_PROFILE = 1;
const PROFESSIONAL_PROFILE = 2;
const COLOR_CODE_POINT_BIT_COUNT = 8;
const COLOR_DESCRIPTION_BIT_COUNT = 3 * COLOR_CODE_POINT_BIT_COUNT;
const COLOR_PRIMARIES_BT709 = 1;
const TRANSFER_CHARACTERISTICS_SRGB = 13;
const MATRIX_COEFFICIENTS_IDENTITY = 0;
const BITS_PER_BYTE = 8;
const LEB128_VALUE_BIT_COUNT = 7;
const LEB128_VALUE_MASK = 0x7F;
const LEB128_CONTINUATION_MASK = 0x80;
const OBU_EXTENSION_FLAG_MASK = 0x04;
const OBU_HAS_SIZE_FIELD_MASK = 0x02;

/** The color_config code points a rewrite writes: an explicit color description and the range. */
export type AV1ColorDescription = Readonly<{
    colorPrimaries: number
    fullRange: boolean
    matrixCoefficients: number
    transferCharacteristics: number
}>;

/** Checks a source sequence header before its color is rewritten, and throws to refuse it. */
export type AV1SequenceHeaderColorCheck = (sequenceHeader: AV1SequenceHeader) => void;

/** Appends bits most significant first, and closes a payload with trailing_bits(). */
class AV1BitWriter {
    private readonly bytes: number[] = [];
    private currentByte = 0;
    private currentBitCount = 0;

    public writeBits(value: number, bitCount: number): void {
        for (let bitIndex = bitCount - 1; bitIndex >= 0; bitIndex -= 1) {
            // Division, because shifts wrap at 32 bits
            this.writeBit(Math.floor(value / (2 ** bitIndex)) % 2);
        }
    }

    /** Copies the source's bits from startBitOffset up to endBitOffset. */
    public copyBits(source: Uint8Array, startBitOffset: number, endBitOffset: number): void {
        for (let bitOffset = startBitOffset; bitOffset < endBitOffset; bitOffset += 1) {
            const byteValue = source[Math.floor(bitOffset / BITS_PER_BYTE)];
            this.writeBit((byteValue >> (BITS_PER_BYTE - 1 - (bitOffset % BITS_PER_BYTE))) & 1);
        }
    }

    /** Writes trailing_bits(): one set bit, then zero bits to the byte boundary. */
    public finishWithTrailingBits(): Uint8Array {
        this.writeBit(1);
        while (this.currentBitCount !== 0) {
            this.writeBit(0);
        }
        return new Uint8Array(this.bytes);
    }

    private writeBit(bitValue: number): void {
        this.currentByte = (this.currentByte * 2) + bitValue;
        this.currentBitCount += 1;
        if (this.currentBitCount === BITS_PER_BYTE) {
            this.bytes.push(this.currentByte);
            this.currentByte = 0;
            this.currentBitCount = 0;
        }
    }
}

function isSRGBIdentityColor(primaries: number, transfer: number, matrix: number): boolean {
    return primaries === COLOR_PRIMARIES_BT709
        && transfer === TRANSFER_CHARACTERISTICS_SRGB
        && matrix === MATRIX_COEFFICIENTS_IDENTITY;
}

/** Returns the bit offset of color_description_present_flag: after high_bitdepth, twelve_bit, and mono_chrome, each where coded. */
function getColorDescriptionFlagBitOffset(sequenceHeader: AV1SequenceHeader, colorConfigBitOffset: number): number {
    const twelveBitCoded = sequenceHeader.profile === PROFESSIONAL_PROFILE && sequenceHeader.colorConfig.bitDepth > 8;
    const monochromeCoded = sequenceHeader.profile !== HIGH_PROFILE;
    return colorConfigBitOffset + 1 + Number(twelveBitCoded) + Number(monochromeCoded);
}

function requireCodePoint(value: number, fieldName: string): void {
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** COLOR_CODE_POINT_BIT_COUNT) {
        throw new RangeError(`The AV1 ${fieldName} ${value} is not an 8-bit code point`);
    }
}

/**
 * Rewrites the color description and color_range of one sequence header OBU payload, bit-exactly, and returns the new payload.
 * Every other field keeps its bits, timing info, decoder model, operating points, and reduced still picture fields included, and the payload ends with fresh trailing bits.
 * A header without a color description gains one, 24 bits longer.
 * The sRGB identity color codes no color_range or chroma format, so a header in it, or a rewrite to it, would change the syntax that follows and is refused.
 * The check sees the parsed source header first and throws to refuse it.
 */
export function rewriteAV1SequenceHeaderColorDescription(
    payload: Uint8Array,
    description: AV1ColorDescription,
    check: AV1SequenceHeaderColorCheck = (): void => undefined
): Uint8Array {
    requireCodePoint(description.colorPrimaries, 'color_primaries');
    requireCodePoint(description.transferCharacteristics, 'transfer_characteristics');
    requireCodePoint(description.matrixCoefficients, 'matrix_coefficients');
    const layout = parseAV1SequenceHeaderLayout(payload);
    const sequenceHeader = layout.sequenceHeader;
    const colorConfig = sequenceHeader.colorConfig;
    check(sequenceHeader);
    if (
        isSRGBIdentityColor(colorConfig.colorPrimaries, colorConfig.transferCharacteristics, colorConfig.matrixCoefficients)
        || isSRGBIdentityColor(description.colorPrimaries, description.transferCharacteristics, description.matrixCoefficients)
    ) {
        throw new AV1OBUParseError('The AV1 sRGB identity color codes no color_range, so its color_config cannot be rewritten in place');
    }

    const flagBitOffset = getColorDescriptionFlagBitOffset(sequenceHeader, layout.colorConfigBitOffset);
    // color_range directly follows the color description, in a monochrome header too
    const colorRangeBitOffset = flagBitOffset + 1 + (colorConfig.colorDescriptionPresent ? COLOR_DESCRIPTION_BIT_COUNT : 0);
    const writer = new AV1BitWriter();
    writer.copyBits(payload, 0, flagBitOffset);
    writer.writeBits(1, 1);
    writer.writeBits(description.colorPrimaries, COLOR_CODE_POINT_BIT_COUNT);
    writer.writeBits(description.transferCharacteristics, COLOR_CODE_POINT_BIT_COUNT);
    writer.writeBits(description.matrixCoefficients, COLOR_CODE_POINT_BIT_COUNT);
    writer.writeBits(description.fullRange ? 1 : 0, 1);
    writer.copyBits(payload, colorRangeBitOffset + 1, layout.trailingBitsBitOffset);
    return writer.finishWithTrailingBits();
}

function encodeLEB128(value: number): number[] {
    const bytes: number[] = [];
    let remainingValue = value;
    do {
        const byteValue = remainingValue % (LEB128_VALUE_MASK + 1);
        remainingValue = Math.floor(remainingValue / (2 ** LEB128_VALUE_BIT_COUNT));
        bytes.push(remainingValue > 0 ? byteValue | LEB128_CONTINUATION_MASK : byteValue);
    } while (remainingValue > 0);
    return bytes;
}

/** Returns one OBU with a new payload: its header as it was, and its obu_size as it was when the length holds, else rewritten in the fewest leb128 bytes. */
function rebuildOBU(obu: AV1OBU, payload: Uint8Array): Uint8Array {
    const headerByte = obu.data[0];
    const headerByteLength = (headerByte & OBU_EXTENSION_FLAG_MASK) === 0 ? 1 : 2;
    const sizeFieldEnd = obu.payload.byteOffset - obu.data.byteOffset;
    const prefix = (headerByte & OBU_HAS_SIZE_FIELD_MASK) === 0 || payload.byteLength === obu.payload.byteLength ?
        obu.data.subarray(0, sizeFieldEnd) :
        new Uint8Array([ ...obu.data.subarray(0, headerByteLength), ...encodeLEB128(payload.byteLength) ]);
    const rebuilt = new Uint8Array(prefix.byteLength + payload.byteLength);
    rebuilt.set(prefix);
    rebuilt.set(payload, prefix.byteLength);
    return rebuilt;
}

/**
 * Rewrites the color of every sequence header OBU of a temporal unit, or of an AV1CodecConfigurationRecord's configOBUs, whose OBUs the caller walked.
 * Every other OBU keeps its bytes and order.
 * Returns a new buffer, or null when the unit carries no sequence header.
 */
export function rewriteAV1SequenceHeaderOBUsColorDescription(
    obus: readonly AV1OBU[],
    description: AV1ColorDescription,
    check?: AV1SequenceHeaderColorCheck
): Uint8Array | null {
    const rewrittenOBUs: Uint8Array[] = [];
    let rewritten = false;
    let byteLength = 0;
    for (const obu of obus) {
        let obuData = obu.data;
        if (obu.type === AV1_OBU_TYPE_SEQUENCE_HEADER) {
            obuData = rebuildOBU(obu, rewriteAV1SequenceHeaderColorDescription(obu.payload, description, check));
            rewritten = true;
        }
        rewrittenOBUs.push(obuData);
        byteLength += obuData.byteLength;
    }
    if (!rewritten) {
        return null;
    }
    const output = new Uint8Array(byteLength);
    let outputOffset = 0;
    for (const obuData of rewrittenOBUs) {
        output.set(obuData, outputOffset);
        outputOffset += obuData.byteLength;
    }
    return output;
}
