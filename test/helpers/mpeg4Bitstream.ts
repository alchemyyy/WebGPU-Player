// Synthetic MPEG-4 Part 2 headers, as ISO/IEC 14496-2 lays them out and FFmpeg's decode_vol_header and decode_vop_header read them

const START_CODE_PREFIX = Object.freeze([ 0x00, 0x00, 0x01 ]);
const VISUAL_OBJECT_SEQUENCE_START_CODE = 0xB0;
const VIDEO_OBJECT_START_CODE = 0x00;
const VIDEO_OBJECT_LAYER_START_CODE = 0x20;
const VOP_START_CODE = 0xB6;
// Advanced Simple Profile at level 5, and its video object type
const ADVANCED_SIMPLE_PROFILE_LEVEL = 0xF5;
const ADVANCED_SIMPLE_OBJECT_TYPE = 17;
const EXTENDED_ASPECT_RATIO = 15;
const SQUARE_ASPECT_RATIO = 1;
const CHROMA_FORMAT_420 = 1;
const VBV_PARAMETERS_BIT_COUNT = 79;
const RECTANGULAR_SHAPE = 0;
const VOP_CODING_TYPES = Object.freeze({ B: 2, I: 0, P: 1, S: 3 });
// Bytes after a header's last field, so a reader past them reads stuffing, not the end of the packet
const TRAILING_BYTES = Object.freeze([ 0x7F, 0xFF, 0xFF, 0xFF ]);

export type MPEG4VOPType = keyof typeof VOP_CODING_TYPES;

/** The video object layer fields the restamping reads, and the optional fields before them that move them. */
export type MPEG4VideoObjectLayerFields = Readonly<{
    /** vol_control_parameters' low_delay, or null for a layer without vol_control_parameters */
    lowDelay: boolean | null
    timeIncrementResolution: number
    extendedAspectRatio?: boolean
    objectLayerIdentifier?: boolean
    vbvParameters?: boolean
}>;

/** Writes bits most significant first into bytes. */
class BitWriter {
    private readonly bits: number[] = [];

    public write(value: number, count: number): this {
        for (let bitIndex = count - 1; bitIndex >= 0; bitIndex -= 1) {
            this.bits.push(Math.floor(value / 2 ** bitIndex) % 2);
        }
        return this;
    }

    /** Pads with a zero and ones to the next byte, as MPEG-4's next_start_code stuffing does. */
    public toBytes(): number[] {
        const bits = [ ...this.bits, 0 ];
        while (bits.length % 8 !== 0) {
            bits.push(1);
        }
        const bytes: number[] = [];
        for (let offset = 0; offset < bits.length; offset += 8) {
            bytes.push(bits.slice(offset, offset + 8).reduce((byte: number, bit: number): number => (byte << 1) | bit, 0));
        }
        return bytes;
    }
}

function startCode(type: number): number[] {
    return [ ...START_CODE_PREFIX, type ];
}

/** A video object layer header after its start code, up to fixed_vop_rate, then stuffing. */
export function createMPEG4VideoObjectLayer(fields: MPEG4VideoObjectLayerFields): Uint8Array {
    const writer = new BitWriter()
        .write(0, 1)
        .write(ADVANCED_SIMPLE_OBJECT_TYPE, 8)
        .write(fields.objectLayerIdentifier ? 1 : 0, 1);
    if (fields.objectLayerIdentifier) {
        writer.write(2, 4).write(1, 3);
    }
    writer.write(fields.extendedAspectRatio ? EXTENDED_ASPECT_RATIO : SQUARE_ASPECT_RATIO, 4);
    if (fields.extendedAspectRatio) {
        writer.write(0xFFFF, 16);
    }
    writer.write(fields.lowDelay === null ? 0 : 1, 1);
    if (fields.lowDelay !== null) {
        writer.write(CHROMA_FORMAT_420, 2).write(fields.lowDelay ? 1 : 0, 1).write(fields.vbvParameters ? 1 : 0, 1);
        if (fields.vbvParameters) {
            writer.write(0, VBV_PARAMETERS_BIT_COUNT);
        }
    }
    writer.write(RECTANGULAR_SHAPE, 2).write(1, 1).write(fields.timeIncrementResolution, 16).write(1, 1).write(0, 1);
    return new Uint8Array([ ...startCode(VIDEO_OBJECT_LAYER_START_CODE), ...writer.toBytes(), ...TRAILING_BYTES ]);
}

/** The extradata an encoder writes: a visual object sequence of Advanced Simple Profile, a video object, then its layer. */
export function createMPEG4Extradata(fields: MPEG4VideoObjectLayerFields): Uint8Array {
    return new Uint8Array([
        ...startCode(VISUAL_OBJECT_SEQUENCE_START_CODE),
        ADVANCED_SIMPLE_PROFILE_LEVEL,
        ...startCode(VIDEO_OBJECT_START_CODE),
        ...createMPEG4VideoObjectLayer(fields)
    ]);
}

/**
 * A VOP header after its start code, up to vop_coded, then stuffing: a VOP of a type, coded or not, whose time increment takes a bit count,
 * after a modulo_time_base of some seconds.
 */
export function createMPEG4VOP(type: MPEG4VOPType, coded: boolean, timeIncrementBitCount: number, moduloSeconds = 0): Uint8Array {
    const writer = new BitWriter().write(VOP_CODING_TYPES[type], 2);
    for (let second = 0; second < moduloSeconds; second += 1) {
        writer.write(1, 1);
    }
    writer.write(0, 1).write(1, 1).write(0, timeIncrementBitCount).write(1, 1).write(coded ? 1 : 0, 1);
    return new Uint8Array([ ...startCode(VOP_START_CODE), ...writer.toBytes(), ...TRAILING_BYTES ]);
}
