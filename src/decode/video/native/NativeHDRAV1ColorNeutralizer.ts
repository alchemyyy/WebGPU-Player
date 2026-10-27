import {
    AV1OBUParseError,
    parseAV1OBUs,
    type AV1OBU
} from '../../../demux/av1/AV1OBUParser';
import {
    rewriteAV1SequenceHeaderOBUsColorDescription,
    type AV1ColorDescription
} from '../../../demux/av1/AV1SequenceHeaderColorRewriter';
import type { AV1SequenceHeader } from '../../../demux/av1/AV1SequenceHeaderParser';

export type AV1HDRTransfer = 'hlg' | 'pq';

// H.273 code points
const BT2020_COLOR_PRIMARIES = 9;
const BT2020_NCL_MATRIX_COEFFICIENTS = 9;
const PQ_TRANSFER_CHARACTERISTICS = 16;
const HLG_TRANSFER_CHARACTERISTICS = 18;
const BT709_CODE_POINT = 1;
// av1C: marker and version, then profile, level, tier, and chroma bytes, then the configOBUs (AV1 ISOBMFF binding, section 2.3)
const AV1_CODEC_CONFIGURATION_HEADER_BYTE_LENGTH = 4;
const AV1_CODEC_CONFIGURATION_MARKER_AND_VERSION = 0x81;
const MAXIMUM_AV1_CODEC_CONFIGURATION_BYTE_LENGTH = 1024 * 1024;
// av01.P.LLT.DD.M.CCC.cp.tc.mc.F, whose last three fields are the color code points and the range
const AV1_LONG_CODEC_STRING_FIELD_COUNT = 10;
const AV1_CODEC_STRING_COLOR_PRIMARIES_FIELD = 6;
const AV1_NEUTRAL_CODEC_STRING_COLOR_FIELDS: readonly string[] = [ '01', '01', '01', '0' ];

/** The limited-range BT.709 color the native external route decodes as, so Chrome converts without tone-mapping. */
const NEUTRAL_BT709_COLOR_DESCRIPTION: AV1ColorDescription = Object.freeze({
    colorPrimaries: BT709_CODE_POINT,
    fullRange: false,
    matrixCoefficients: BT709_CODE_POINT,
    transferCharacteristics: BT709_CODE_POINT
});

export type NeutralizedNativeHDRAV1DecoderConfig = {
    configuration: VideoDecoderConfig
    /** Whether an av1C description carried a sequence header that proved the route */
    decoderDescriptionValidated: boolean
};

/** A temporal unit after neutralization: its bytes, and its OBUs as views of them. */
export type NeutralizedAV1TemporalUnit = {
    data: Uint8Array
    obus: readonly AV1OBU[]
};

function toUint8Array(data: AllowSharedBufferSource): Uint8Array {
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new TypeError('The AV1 decoder description is not a buffer source');
}

/**
 * The color a neutralized route expects of each sequence header: an HDR transfer, or any color on the Dolby Vision route, whose RPU, not the header, describes the picture.
 */
export type AV1NeutralizedRouteColor = AV1HDRTransfer | 'dolby-vision';

/**
 * Returns the check a sequence header must pass before its color is neutralized: on an HDR route, an explicit limited-range BT.2020 description with the non-constant-luminance matrix and the route's transfer.
 * AV1 has no alternative transfer characteristics message, so only the HLG code point proves HLG.
 * The Dolby Vision route checks nothing.
 */
function createRouteColorCheck(routeColor: AV1NeutralizedRouteColor): (sequenceHeader: AV1SequenceHeader) => void {
    if (routeColor === 'dolby-vision') {
        return (): void => undefined;
    }
    const expectedTransferCharacteristics = routeColor === 'pq' ? PQ_TRANSFER_CHARACTERISTICS : HLG_TRANSFER_CHARACTERISTICS;
    return (sequenceHeader: AV1SequenceHeader): void => {
        const colorConfig = sequenceHeader.colorConfig;
        if (
            !colorConfig.colorDescriptionPresent
            || colorConfig.fullRange
            || colorConfig.colorPrimaries !== BT2020_COLOR_PRIMARIES
            || colorConfig.matrixCoefficients !== BT2020_NCL_MATRIX_COEFFICIENTS
            || colorConfig.transferCharacteristics !== expectedTransferCharacteristics
        ) {
            throw new TypeError(
                'The AV1 sequence header does not match the expected limited-range BT.2020 HDR route: '
                + `${colorConfig.colorPrimaries}/${colorConfig.transferCharacteristics}/${colorConfig.matrixCoefficients}`
                + `${colorConfig.fullRange ? ' full' : ' limited'}${colorConfig.colorDescriptionPresent ? '' : ', no color description'}`
            );
        }
    };
}

/** Rewrites the color fields of a long AV1 codecs string to limited BT.709; a short string already implies them. */
export function neutralizeAV1CodecStringColor(codec: string): string {
    const fields = codec.split('.');
    if (fields.length !== AV1_LONG_CODEC_STRING_FIELD_COUNT) {
        return codec;
    }
    fields.splice(AV1_CODEC_STRING_COLOR_PRIMARIES_FIELD, AV1_NEUTRAL_CODEC_STRING_COLOR_FIELDS.length, ...AV1_NEUTRAL_CODEC_STRING_COLOR_FIELDS);
    return fields.join('.');
}

/**
 * Rewrites every sequence header of one temporal unit to the neutral limited BT.709 color, whatever color it declares, as the external HDR authorization does to its vector.
 * Returns null when the unit carries no sequence header.
 */
export function rewriteAV1TemporalUnitColorToBT709(data: Uint8Array): Uint8Array | null {
    return rewriteAV1SequenceHeaderOBUsColorDescription(parseAV1OBUs(data), NEUTRAL_BT709_COLOR_DESCRIPTION);
}

type RewrittenAV1DecoderDescription = {
    description: Uint8Array
    sequenceHeaderRewritten: boolean
};

function rewriteAV1DecoderDescription(descriptionSource: AllowSharedBufferSource, transfer: AV1NeutralizedRouteColor): RewrittenAV1DecoderDescription {
    const description = toUint8Array(descriptionSource);
    if (
        description.byteLength < AV1_CODEC_CONFIGURATION_HEADER_BYTE_LENGTH
        || description.byteLength > MAXIMUM_AV1_CODEC_CONFIGURATION_BYTE_LENGTH
        || description[0] !== AV1_CODEC_CONFIGURATION_MARKER_AND_VERSION
    ) {
        throw new TypeError('The AV1 decoder description is not a supported av1C record');
    }
    const header = description.subarray(0, AV1_CODEC_CONFIGURATION_HEADER_BYTE_LENGTH);
    const configOBUs = description.subarray(AV1_CODEC_CONFIGURATION_HEADER_BYTE_LENGTH);
    const rewrittenConfigOBUs = configOBUs.byteLength === 0 ?
        null :
        rewriteAV1SequenceHeaderOBUsColorDescription(parseAV1OBUs(configOBUs), NEUTRAL_BT709_COLOR_DESCRIPTION, createRouteColorCheck(transfer));
    if (!rewrittenConfigOBUs) {
        return { description: description.slice(), sequenceHeaderRewritten: false };
    }
    const rewrittenDescription = new Uint8Array(header.byteLength + rewrittenConfigOBUs.byteLength);
    rewrittenDescription.set(header);
    rewrittenDescription.set(rewrittenConfigOBUs, header.byteLength);
    return { description: rewrittenDescription, sequenceHeaderRewritten: true };
}

/**
 * Neutralizes an AV1 decoder configuration to limited BT.709 for a native external route: its colorSpace, the color fields of its codecs string, and the sequence header of an av1C description.
 * Reports whether the description's sequence header proved the route; without one, the first temporal unit's in-band sequence header must.
 */
export function neutralizeNativeHDRAV1DecoderConfig(
    configuration: VideoDecoderConfig,
    transfer: AV1NeutralizedRouteColor
): NeutralizedNativeHDRAV1DecoderConfig {
    const rewrittenDescription = configuration.description === undefined ?
        null :
        rewriteAV1DecoderDescription(configuration.description, transfer);
    return {
        configuration: {
            ...configuration,
            codec: neutralizeAV1CodecStringColor(configuration.codec),
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            ...(rewrittenDescription === null ? {} : { description: rewrittenDescription.description })
        },
        decoderDescriptionValidated: rewrittenDescription?.sequenceHeaderRewritten === true
    };
}

/**
 * Neutralizes the in-band sequence headers of one decode attempt's temporal units, in decode order.
 * Every sequence header must prove the route, and a unit decodes only after a sequence header, in band or in the configuration's description, proved it.
 */
export class NativeHDRAV1TemporalUnitNeutralizer {
    private readonly routeColorCheck: (sequenceHeader: AV1SequenceHeader) => void;

    public constructor(transfer: AV1NeutralizedRouteColor, private validated: boolean) {
        this.routeColorCheck = createRouteColorCheck(transfer);
    }

    /** Returns the unit with each sequence header rewritten, in a new buffer whose OBUs are walked again, or the unit itself when it carries none. */
    public neutralize(data: Uint8Array, obus: readonly AV1OBU[]): NeutralizedAV1TemporalUnit {
        const rewrittenData = rewriteAV1SequenceHeaderOBUsColorDescription(obus, NEUTRAL_BT709_COLOR_DESCRIPTION, this.routeColorCheck);
        if (rewrittenData) {
            this.validated = true;
            return { data: rewrittenData, obus: parseAV1OBUs(rewrittenData) };
        }
        if (!this.validated) {
            throw new AV1OBUParseError('Native HDR color neutralization requires a validated AV1 sequence header');
        }
        return { data, obus };
    }
}
