// Wraps HEVC Dolby Vision RPUs in the ITU-T T.35 payload of an AV1 metadata OBU.
// The dolby_vision crate's convert_regular_rpu_to_av1_payload and FFmpeg's ff_dovi_rpu_generate write the same layout

const RPU_PREFIX = 0x19;
const RPU_TERMINATOR = 0x80;
const HEVC_UNSPEC62_NAL_HEADER: readonly number[] = [ 0x7C, 0x01 ];
const ANNEX_B_START_CODES: readonly (readonly number[])[] = [
    [ 0x00, 0x00, 0x00, 0x01 ],
    [ 0x00, 0x00, 0x01 ]
];
const EMULATION_PREVENTION_BYTE = 0x03;

const ITU_T_T35_COUNTRY_CODE_UNITED_STATES = 0xB5;
const ITU_T_T35_PROVIDER_CODE_DOLBY = 0x003B;
const ITU_T_T35_PROVIDER_CODE_BIT_LENGTH = 16;
const ITU_T_T35_PROVIDER_ORIENTED_CODE_DOLBY = 0x0000_0800;
const ITU_T_T35_PROVIDER_ORIENTED_CODE_BIT_LENGTH = 32;
// emdf_version 0, key_id 6, emdf_payload_id 31, emdf_payload_id_ext 225, four clear flags, and discard_unknown_payload, which FFmpeg reads as one fixed value
const EMDF_HEADER = 0x01BE_6841;
const EMDF_HEADER_BIT_LENGTH = 27;
// The terminating emdf_payload_id 0 and the emdf_protection fields
const EMDF_FOOTER = 0x400;
const EMDF_FOOTER_BIT_LENGTH = 17;
const EMDF_VARIABLE_BITS_CHUNK_BIT_LENGTH = 8;
const BITS_PER_BYTE = 8;

export type DolbyVisionAV1ITUTT35PayloadOptions = {
    includeCountryCode?: boolean
};

/** Writes bits most significant first. */
class BitWriter {
    public readonly bytes: number[] = [];
    private bitLength = 0;

    public writeBits(value: number, bitCount: number): void {
        for (let bitIndex = bitCount - 1; bitIndex >= 0; bitIndex -= 1) {
            if (this.bitLength % BITS_PER_BYTE === 0) {
                this.bytes.push(0);
            }
            if (Math.floor(value / (2 ** bitIndex)) % 2 === 1) {
                this.bytes[this.bytes.length - 1] |= 0x80 >> (this.bitLength % BITS_PER_BYTE);
            }
            this.bitLength += 1;
        }
    }

    /** Fills the current byte with 1 bits, as both writers pad the payload. */
    public padWithOnes(): void {
        while (this.bitLength % BITS_PER_BYTE !== 0) {
            this.writeBits(1, 1);
        }
    }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
    return prefix.every((value, index) => bytes[index] === value);
}

/** Returns the RPU from its 0x19 prefix, after any start code and HEVC NAL unit header. */
function skipRPUFraming(rpu: Uint8Array): Uint8Array {
    let framedRPU = rpu;
    const startCode = ANNEX_B_START_CODES.find(code => startsWith(framedRPU, code));
    if (startCode) {
        framedRPU = framedRPU.subarray(startCode.length);
    }
    if (startsWith(framedRPU, HEVC_UNSPEC62_NAL_HEADER)) {
        framedRPU = framedRPU.subarray(HEVC_UNSPEC62_NAL_HEADER.length);
    }
    if (framedRPU[0] !== RPU_PREFIX) {
        throw new TypeError('The Dolby Vision RPU does not start with its 0x19 prefix');
    }
    return framedRPU;
}

/** Removes HEVC emulation prevention bytes, the 0x03 after every two zero bytes. */
function removeEmulationPrevention(escapedRPU: Uint8Array): number[] {
    const rpu: number[] = [];
    let zeroCount = 0;
    for (const value of escapedRPU) {
        if (zeroCount >= 2 && value === EMULATION_PREVENTION_BYTE) {
            zeroCount = 0;
            continue;
        }
        rpu.push(value);
        zeroCount = value === 0 ? zeroCount + 1 : 0;
    }
    return rpu;
}

/** Codes a value as EMDF variable_bits, where each chunk after the first adds one before shifting. */
function writeVariableBits(writer: BitWriter, value: number): void {
    const chunkLimit = 2 ** EMDF_VARIABLE_BITS_CHUNK_BIT_LENGTH;
    const chunks = [ value % chunkLimit ];
    let remainingValue = Math.floor(value / chunkLimit);
    while (remainingValue > 0) {
        remainingValue -= 1;
        chunks.unshift(remainingValue % chunkLimit);
        remainingValue = Math.floor(remainingValue / chunkLimit);
    }
    chunks.forEach((chunk, chunkIndex) => {
        writer.writeBits(chunk, EMDF_VARIABLE_BITS_CHUNK_BIT_LENGTH);
        // read_more
        writer.writeBits(chunkIndex < chunks.length - 1 ? 1 : 0, 1);
    });
}

/** Writes the country code, when included, then Dolby's provider code and provider-oriented code. */
function writeDolbyVisionITUTT35Header(writer: BitWriter, includeCountryCode: boolean): void {
    if (includeCountryCode) {
        writer.writeBits(ITU_T_T35_COUNTRY_CODE_UNITED_STATES, BITS_PER_BYTE);
    }
    writer.writeBits(ITU_T_T35_PROVIDER_CODE_DOLBY, ITU_T_T35_PROVIDER_CODE_BIT_LENGTH);
    writer.writeBits(ITU_T_T35_PROVIDER_ORIENTED_CODE_DOLBY, ITU_T_T35_PROVIDER_ORIENTED_CODE_BIT_LENGTH);
}

function createDolbyVisionITUTT35Header(): number[] {
    const writer = new BitWriter();
    writeDolbyVisionITUTT35Header(writer, true);
    return writer.bytes;
}

function createDolbyVisionITUTT35PayloadPrefix(): number[] {
    const writer = new BitWriter();
    writeDolbyVisionITUTT35Header(writer, true);
    // The EMDF header bits that fill whole bytes; the rest share a byte with the payload size
    const partialByteBitLength = EMDF_HEADER_BIT_LENGTH % BITS_PER_BYTE;
    writer.writeBits(Math.floor(EMDF_HEADER / 2 ** partialByteBitLength), EMDF_HEADER_BIT_LENGTH - partialByteBitLength);
    return writer.bytes;
}

/** The ITU-T T.35 header of a Dolby Vision metadata OBU payload: the United States country code, then Dolby's provider code and provider-oriented code. */
export const DOLBY_VISION_ITUT_T35_HEADER: readonly number[] = createDolbyVisionITUTT35Header();

/** The bytes every Dolby Vision T.35 payload starts with: the T.35 header, then the EMDF header bits that fill whole bytes. */
export const DOLBY_VISION_ITUT_T35_PAYLOAD_PREFIX: readonly number[] = createDolbyVisionITUTT35PayloadPrefix();

/**
 * Wraps one HEVC RPU in the ITU-T T.35 payload of an AV1 Dolby Vision metadata OBU, by default from its country code.
 * The RPU may be framed as an Annex B or UNSPEC62 NAL unit, or start at its 0x19 prefix.
 */
export function createDolbyVisionAV1ITUTT35Payload(
    hevcRPU: Uint8Array,
    options: DolbyVisionAV1ITUTT35PayloadOptions = {}
): Uint8Array {
    const rpu = removeEmulationPrevention(skipRPUFraming(hevcRPU));
    // The EMDF payload is the RPU after its prefix, through the terminator but no trailing zero bytes
    let rpuEnd = rpu.length;
    while (rpuEnd > 0 && rpu[rpuEnd - 1] === 0) {
        rpuEnd -= 1;
    }
    if (rpu[rpuEnd - 1] !== RPU_TERMINATOR) {
        throw new TypeError('The Dolby Vision RPU does not end with its 0x80 terminator');
    }
    const emdfPayload = rpu.slice(1, rpuEnd);

    const writer = new BitWriter();
    writeDolbyVisionITUTT35Header(writer, options.includeCountryCode ?? true);
    writer.writeBits(EMDF_HEADER, EMDF_HEADER_BIT_LENGTH);
    writeVariableBits(writer, emdfPayload.length);
    for (const value of emdfPayload) {
        writer.writeBits(value, BITS_PER_BYTE);
    }
    writer.writeBits(EMDF_FOOTER, EMDF_FOOTER_BIT_LENGTH);
    writer.padWithOnes();
    return Uint8Array.from(writer.bytes);
}
