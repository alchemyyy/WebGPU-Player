import {
    CustomVideoDecoder,
    EncodedPacket,
    type VideoCodec,
    type VideoSample
} from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import { secondsToMicroseconds, type Microseconds } from 'webgpu-player/MediaTime';
import type {
    HEVCDecodedFrame,
    HEVCDecodedFrameHandler,
    HEVCDecoderBackend,
    HEVCDecoderBackendOptions,
    HEVCFrameBitDepth,
    HEVCFramePlane
} from 'webgpu-player/video/decoders/HEVCDecoderBackend';
import HEVCSoftwareVideoDecoder, {
    createOwnedHEVCSoftwareVideoDecoder,
    hasRequiredHEVCParameterSets,
    MediabunnyHEVCSoftwareVideoDecoder,
    parseHEVCDecoderConfiguration,
    type HEVCSoftwareDecodedFrame,
    type HEVCSoftwareVideoDecoderDependencies,
    waitForHEVCSoftwareVideoDecoderShutdown
} from 'webgpu-player/video/decoders/HEVCSoftwareVideoDecoder';

import { createBytesFromHex } from '../../helpers/byteArrays';
import { createNALUnit, encodeAnnexBNALUnits } from '../../helpers/hevcNALUnits';

type MutableDecoderContract = {
    codec: VideoCodec
    config: VideoDecoderConfig
    onError: (error: unknown) => undefined
    onSample: (sample: VideoSample) => unknown
};

/** The timing a packet goes into the decoder with, which FFmpeg returns on the frame it codes. */
type FrameTiming = Readonly<{
    durationMicroseconds: Microseconds
    timestampMicroseconds: Microseconds
}>;

/** Makes the frames one decode call of the fake backend outputs, from the timing of the packet that call sent. */
type FakeDecodeOutput = (packetTiming: FrameTiming) => HEVCDecodedFrame[];

type FakeBackendOptions = {
    decodeOutputs?: FakeDecodeOutput[]
    flushFrames?: HEVCDecodedFrame[]
};

/** A stream whose owned frames the sample path describes too: its depth, container color, and SPS. */
type OwnedFrameVariant = Readonly<{
    bitDepth: HEVCFrameBitDepth
    colorSpace?: Record<string, unknown>
    label: string
    sequenceParameterSet?: Uint8Array
}>;

// NAL unit types of H.265 Table 7-1
const TRAIL_R_NAL_UNIT_TYPE = 1;
const RASL_N_NAL_UNIT_TYPE = 8;
const RASL_R_NAL_UNIT_TYPE = 9;
const IDR_W_RADL_NAL_UNIT_TYPE = 19;
const CRA_NAL_UNIT_TYPE = 21;
const VPS_NAL_UNIT_TYPE = 32;
const SPS_NAL_UNIT_TYPE = 33;
const PPS_NAL_UNIT_TYPE = 34;
const PREFIX_SEI_NAL_UNIT_TYPE = 39;
// nuh_layer_id 1 and nuh_temporal_id_plus1 1, in the second byte of a NAL unit header
const SECOND_LAYER_HEADER_BYTE = (1 << 3) | 1;

const MAIN_PROFILE_IDC = 1;
const MAIN10_PROFILE_IDC = 2;
const MAIN_STILL_PICTURE_PROFILE_IDC = 3;
const MAIN_BIT_DEPTH = 8;
const MAIN10_BIT_DEPTH = 10;
const DEFAULT_LENGTH_SIZE = 4;
const SHORT_LENGTH_SIZE = 2;
const MAIN_CODED_WIDTH = 64;
const MAIN_CODED_HEIGHT = 64;
const MAIN10_CODED_WIDTH = 640;
const MAIN10_CODED_HEIGHT = 360;
const FULL_HD_CODED_WIDTH = 1_920;
const FULL_HD_CODED_HEIGHT = 1_080;
const UHD_CODED_WIDTH = 3_840;
const UHD_CODED_HEIGHT = 2_160;
const DCI_4K_CODED_WIDTH = 4_096;
const DCI_4K_CODED_HEIGHT = 2_160;
const DISPLAY_ASPECT_WIDTH = 16;
const DISPLAY_ASPECT_HEIGHT = 9;
const MAIN_CODEC_STRING = 'hvc1.1.6.L120.B0';
const MAIN10_CODEC_STRING = 'hvc1.2.4.L120.B0';
const MAIN10_IN_BAND_CODEC_STRING = 'hev1.2.4.L120.B0';
const MAIN10_IN_BAND_PROGRESSIVE_CODEC_STRING = 'hev1.2.4.L120.90';
const MAIN_STILL_PICTURE_CODEC_STRING = 'hvc1.3.4.L120.B0';
const AVC_CODEC_STRING = 'avc1.640028';
const LEVEL_5_CODEC_STRING = 'hvc1.2.4.L150.B0';
const LEVEL_5_1_IN_BAND_CODEC_STRING = 'hev1.2.4.L153.B0';
const LEVEL_6_IN_BAND_CODEC_STRING = 'hev1.2.4.L180.B0';
const ASSET_BASE_URL = 'https://example.test/web/libraries/';
const DECODER_GLUE_URL = `${ASSET_BASE_URL}ffmpeg-hevc/ffmpeg-hevc.js`;
const DECODER_WASM_URL = `${ASSET_BASE_URL}ffmpeg-hevc/ffmpeg-hevc.wasm`;

const MAIN_SPS = createBytesFromHex(
    '42010101600000030090000003000003001ea020810596566924caf016a020202080000003008000000c04'
);
const MAIN10_SPS = createBytesFromHex(
    '4201010220000003009000000300000300ffa005020169365959a4932bc05a848804820000030002000003000210'
);
const CROPPED_1080P_MAIN10_SPS = createBytesFromHex(
    '420101022000000300900000030000030078a003c0801107cad96e92930bc05a848804db0800001f480002ee0040'
);
// A DCI 4K Main 10 SPS, larger than UHD
const DCI_4K_MAIN10_SPS = createBytesFromHex(
    '420101022000000300900000030000030096a00080080087136595952930bc05a84880482000000300200000030301'
);
// UHD Main 10 SPSs declaring seven DPB pictures, which level 6 allows at UHD and level 5.1 does not
const LEVEL_6_DPB_7_UHD_MAIN10_SPS = createBytesFromHex(
    '4201010200000000800000000000b4a001e020021c4d967ff089a848804800'
);
const LEVEL_5_1_DPB_7_UHD_MAIN10_SPS = createBytesFromHex(
    '420101020000000080000000000099a001e020021c4d967ff089a848804800'
);
// MAIN10_SPS with its VUI color description replaced by BT.2020 primaries and matrix with the BT.2020 10-bit transfer
const MAIN10_BT2020_10_SPS = createBytesFromHex(
    '4201010220000003009000000300000300ffa005020169365959a4932bc05a848704820000030002000003000210'
);
// MAIN10_SPS with SMPTE 170M primaries, transfer, and matrix
const MAIN10_SMPTE170M_SPS = createBytesFromHex(
    '4201010220000003009000000300000300ffa005020169365959a4932bc05a830303020000030002000003000210'
);
// An SPS of another layer, as an alpha layer's that FFmpeg keeps in HVCC, whose payload is no valid SPS
const SECOND_LAYER_SPS = new Uint8Array([ SPS_NAL_UNIT_TYPE << 1, SECOND_LAYER_HEADER_BYTE, 0xFF, 0xFF ]);
const VPS_NAL_UNIT = createNALUnit(VPS_NAL_UNIT_TYPE, [ 1 ]);
const PPS_NAL_UNIT = createNALUnit(PPS_NAL_UNIT_TYPE, [ 3 ]);
// A length-prefixed packet whose four-byte length runs past its end
const TRUNCATED_LENGTH_PREFIXED_PACKET = new Uint8Array([ 0, 0, 0, 8, IDR_W_RADL_NAL_UNIT_TYPE << 1, 1 ]);

// The first samples of each plane of a decoded frame; the rest are zero
const LUMA_SAMPLES = [ 1, 2, 3, 4, 9, 10, 11, 12 ];
const CHROMA_BLUE_SAMPLES = [ 5, 6 ];
const CHROMA_RED_SAMPLES = [ 7, 8 ];
// A decoder pads each row by these many samples, as FFmpeg does for its aligned rows
const PADDED_ROW_SAMPLE_COUNT = 8;
const MAIN_PADDING_SAMPLE = 0xFF;
const MAIN10_PADDING_SAMPLE = 0xFFFF;
// The Main 10 sample's compact layout: luma rows of 640 16-bit words, then two 320-word chroma planes
const MAIN10_SAMPLE_LAYOUTS = [
    { offset: 0, stride: 1_280 },
    { offset: 460_800, stride: 640 },
    { offset: 576_000, stride: 640 }
];
const MAIN10_CHROMA_BLUE_SAMPLE_OFFSET = 230_400;
const MAIN10_CHROMA_RED_SAMPLE_OFFSET = 288_000;
const MAIN_CHROMA_BLUE_BYTE_OFFSET = 4_096;
const MAIN_CHROMA_RED_BYTE_OFFSET = 5_120;

const OWNED_PACKET_TIMESTAMP_SECONDS = 1.25;
const OWNED_PACKET_DURATION_SECONDS = 1 / 24;
const OWNED_PACKET_SEQUENCE_NUMBER = 7;
// Mediabunny truncates a packet's duration to whole microseconds
const OWNED_PACKET_SAMPLE_DURATION_SECONDS = 0.041666;
const PACKET_TIMESTAMP_SECONDS = 0;
const PACKET_DURATION_SECONDS = 0.04;
const LATER_PACKET_TIMESTAMP_SECONDS = 1;
const LATEST_PACKET_TIMESTAMP_SECONDS = 2;
const LONGER_PACKET_DURATION_SECONDS = 0.05;
const NEGATIVE_PACKET_DURATION_MICROSECONDS = -40_000;

const DIMENSIONS_CONTRADICT_ERROR = 'dimensions contradict';
const DPB_ABOVE_LEVEL_ERROR = 'decoded picture buffer exceeds';
const SPS_CONTRADICTION_ERROR = 'contradicts the active SPS';
const PLANE_LENGTH_ERROR = 'plane lengths';
const PLANE_BIT_DEPTH_ERROR = 'do not match their bit depth';
const MISSING_SPS_ERROR = 'coded data before a supported SPS VUI';
const NEGATIVE_DURATION_ERROR = 'must not be negative';
const TRUNCATED_PACKET_ERROR = 'invalid NAL unit length';
const MISSING_START_CODE_ERROR = 'no Annex B start code';
const TRUNCATED_DESCRIPTION_ERROR = 'invalid NAL unit';
const MISMATCHED_PLANE_DEPTHS_ERROR = 'mismatched plane bit depths';

function emitBackendFrames(frames: readonly HEVCDecodedFrame[], frameHandler: HEVCDecodedFrameHandler): number {
    for (const frame of frames) {
        frameHandler(frame);
    }
    return frames.length;
}

/** A WASM backend that records what it was sent and outputs scripted frames, a decode call's frames made from its packet's timing. */
class FakeHEVCDecoderBackend implements HEVCDecoderBackend {
    public readonly decode = vi.fn<(
        data: Uint8Array,
        timestampMicroseconds: Microseconds,
        durationMicroseconds: Microseconds,
        frameHandler: HEVCDecodedFrameHandler
    ) => number>();
    public readonly destroy = vi.fn<() => void>();
    public readonly flush = vi.fn<(frameHandler: HEVCDecodedFrameHandler) => number>();

    public constructor(options: FakeBackendOptions = {}) {
        const decodeOutputs = options.decodeOutputs ?? [];
        this.decode.mockImplementation((
            data: Uint8Array,
            timestampMicroseconds: Microseconds,
            durationMicroseconds: Microseconds,
            frameHandler: HEVCDecodedFrameHandler
        ): number => {
            const createFrames = decodeOutputs.shift();
            return emitBackendFrames(
                createFrames ? createFrames({ durationMicroseconds, timestampMicroseconds }) : [],
                frameHandler
            );
        });
        this.flush.mockImplementation((frameHandler: HEVCDecodedFrameHandler): number => (
            emitBackendFrames(options.flushFrames ?? [], frameHandler)
        ));
    }
}

function createTiming(timestampSeconds: number, durationSeconds: number): FrameTiming {
    return {
        durationMicroseconds: secondsToMicroseconds(durationSeconds),
        timestampMicroseconds: secondsToMicroseconds(timestampSeconds)
    };
}

function getCodedWidth(bitDepth: HEVCFrameBitDepth): number {
    return bitDepth === MAIN_BIT_DEPTH ? MAIN_CODED_WIDTH : MAIN10_CODED_WIDTH;
}

function getCodedHeight(bitDepth: HEVCFrameBitDepth): number {
    return bitDepth === MAIN_BIT_DEPTH ? MAIN_CODED_HEIGHT : MAIN10_CODED_HEIGHT;
}

/** Creates a plane of samples as FFmpeg returns them: bytes at 8 bits and 16-bit words at 10. */
function createPlaneSamples(bitDepth: HEVCFrameBitDepth, sampleCount: number): Uint8Array | Uint16Array {
    return bitDepth === MAIN_BIT_DEPTH ? new Uint8Array(sampleCount) : new Uint16Array(sampleCount);
}

/** Creates a plane whose rows are a stride apart, from compact samples, filling the padding with a marker. */
function createPlane(
    bitDepth: HEVCFrameBitDepth,
    initialSamples: readonly number[],
    width: number,
    height: number,
    paddedRowSampleCount: number
): HEVCFramePlane {
    const compactSamples = createPlaneSamples(bitDepth, width * height);
    compactSamples.set(initialSamples);
    const stride = width + paddedRowSampleCount;
    const samples = createPlaneSamples(bitDepth, ((height - 1) * stride) + width);
    samples.fill(bitDepth === MAIN_BIT_DEPTH ? MAIN_PADDING_SAMPLE : MAIN10_PADDING_SAMPLE);
    for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
        samples.set(compactSamples.subarray(rowIndex * width, (rowIndex + 1) * width), rowIndex * stride);
    }
    return { samples, stride };
}

/** Creates a decoded frame of the test stream's size, whose planes are compact or padded as a decoder returns them. */
function createFrame(
    bitDepth: HEVCFrameBitDepth,
    timing: FrameTiming,
    paddedRowSampleCount = 0
): HEVCDecodedFrame {
    const width = getCodedWidth(bitDepth);
    const height = getCodedHeight(bitDepth);
    const chromaWidth = width / 2;
    const chromaHeight = height / 2;
    return {
        bitDepth,
        chromaHeight,
        chromaWidth,
        durationMicroseconds: timing.durationMicroseconds,
        height,
        planes: {
            chromaBlue: createPlane(bitDepth, CHROMA_BLUE_SAMPLES, chromaWidth, chromaHeight, paddedRowSampleCount),
            chromaRed: createPlane(bitDepth, CHROMA_RED_SAMPLES, chromaWidth, chromaHeight, paddedRowSampleCount),
            luma: createPlane(bitDepth, LUMA_SAMPLES, width, height, paddedRowSampleCount)
        },
        timestampMicroseconds: timing.timestampMicroseconds,
        width
    };
}

/** Outputs one frame with the timing of the packet that decode call sent. */
function outputFrame(bitDepth: HEVCFrameBitDepth = MAIN10_BIT_DEPTH, paddedRowSampleCount = 0): FakeDecodeOutput {
    return (packetTiming: FrameTiming): HEVCDecodedFrame[] => [ createFrame(bitDepth, packetTiming, paddedRowSampleCount) ];
}

/** Outputs frames that do not depend on the packet, as a decoder releasing reordered pictures does. */
function outputFrames(frames: readonly HEVCDecodedFrame[]): FakeDecodeOutput {
    return (): HEVCDecodedFrame[] => [ ...frames ];
}

/** Copies a plane's rows out compactly, as a VideoSample holds them. */
function compactPlane(plane: HEVCFramePlane, width: number, height: number): number[] {
    const samples: number[] = [];
    for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
        samples.push(...plane.samples.subarray(rowIndex * plane.stride, (rowIndex * plane.stride) + width));
    }
    return samples;
}

function createHVCCDescription(
    profileIDC = MAIN10_PROFILE_IDC,
    bitDepth: number = MAIN10_BIT_DEPTH,
    lengthSize: 1 | 2 | 3 | 4 = DEFAULT_LENGTH_SIZE,
    nalUnits?: readonly Uint8Array[]
): Uint8Array {
    const resolvedNALUnits = nalUnits ?? [
        VPS_NAL_UNIT,
        bitDepth === MAIN_BIT_DEPTH ? MAIN_SPS : MAIN10_SPS,
        PPS_NAL_UNIT
    ];
    const descriptionBytes: number[] = new Array<number>(23).fill(0);
    descriptionBytes[0] = 1;
    descriptionBytes[1] = profileIDC;
    descriptionBytes[16] = 1;
    descriptionBytes[17] = bitDepth - MAIN_BIT_DEPTH;
    descriptionBytes[18] = bitDepth - MAIN_BIT_DEPTH;
    descriptionBytes[21] = lengthSize - 1;
    descriptionBytes[22] = resolvedNALUnits.length;
    for (const nalUnit of resolvedNALUnits) {
        const nalUnitType = (nalUnit[0] >> 1) & 0x3F;
        descriptionBytes.push(0x80 | nalUnitType, 0, 1);
        descriptionBytes.push((nalUnit.byteLength >> 8) & 0xFF, nalUnit.byteLength & 0xFF);
        descriptionBytes.push(...nalUnit);
    }
    return new Uint8Array(descriptionBytes);
}

/** Creates an HVCC description of the Main 10 stream around another SPS. */
function createMain10DescriptionWithSPS(sequenceParameterSet: Uint8Array): Uint8Array {
    return createHVCCDescription(MAIN10_PROFILE_IDC, MAIN10_BIT_DEPTH, DEFAULT_LENGTH_SIZE, [
        VPS_NAL_UNIT,
        sequenceParameterSet,
        PPS_NAL_UNIT
    ]);
}

function createLengthPrefixedPacket(
    nalUnits: readonly Uint8Array[],
    lengthSize: 1 | 2 | 3 | 4 = DEFAULT_LENGTH_SIZE
): Uint8Array {
    const byteLength = nalUnits.reduce(
        (totalByteLength: number, nalUnit: Uint8Array): number => totalByteLength + lengthSize + nalUnit.byteLength,
        0
    );
    const packet = new Uint8Array(byteLength);
    let offset = 0;
    for (const nalUnit of nalUnits) {
        let remainingLength = nalUnit.byteLength;
        for (let byteIndex = lengthSize - 1; byteIndex >= 0; byteIndex -= 1) {
            packet[offset + byteIndex] = remainingLength & 0xFF;
            remainingLength = Math.floor(remainingLength / 256);
        }
        packet.set(nalUnit, offset + lengthSize);
        offset += lengthSize + nalUnit.byteLength;
    }
    return packet;
}

function createDependencies(backend: HEVCDecoderBackend): {
    createDecoder: ReturnType<typeof vi.fn>
    dependencies: HEVCSoftwareVideoDecoderDependencies
    loadDecoderGlue: ReturnType<typeof vi.fn>
    resolveAssetURL: ReturnType<typeof vi.fn>
} {
    const createDecoder = vi.fn(async (): Promise<HEVCDecoderBackend> => backend);
    const loadDecoderGlue = vi.fn<(url: string) => void>();
    const resolveAssetURL = vi.fn((path: string): string => `${ASSET_BASE_URL}${path}`);
    return {
        createDecoder,
        dependencies: { createDecoder, loadDecoderGlue, resolveAssetURL },
        loadDecoderGlue,
        resolveAssetURL
    };
}

function configureDecoder(
    decoder: HEVCSoftwareVideoDecoder | MediabunnyHEVCSoftwareVideoDecoder,
    options: {
        bitDepth?: HEVCFrameBitDepth
        /** Replaces the configured container color */
        colorSpace?: Record<string, unknown>
        onError?: (error: unknown) => undefined
        onSample?: (sample: VideoSample) => unknown
        /** Replaces the Main10 HVCC SPS */
        sequenceParameterSet?: Uint8Array
    } = {}
): void {
    const bitDepth = options.bitDepth ?? MAIN10_BIT_DEPTH;
    const mutableDecoder = decoder as unknown as MutableDecoderContract;
    const profileIDC = bitDepth === MAIN_BIT_DEPTH ? MAIN_PROFILE_IDC : MAIN10_PROFILE_IDC;
    const defaultColorSpace = bitDepth === MAIN_BIT_DEPTH ?
        {
            fullRange: false,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'bt709'
        } :
        {
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'pq'
        };
    mutableDecoder.codec = 'hevc';
    mutableDecoder.config = {
        codec: bitDepth === MAIN_BIT_DEPTH ? MAIN_CODEC_STRING : MAIN10_CODEC_STRING,
        codedHeight: getCodedHeight(bitDepth),
        codedWidth: getCodedWidth(bitDepth),
        colorSpace: (options.colorSpace ?? defaultColorSpace) as unknown as VideoColorSpaceInit,
        description: options.sequenceParameterSet ?
            createMain10DescriptionWithSPS(options.sequenceParameterSet) :
            createHVCCDescription(profileIDC, bitDepth),
        displayAspectHeight: DISPLAY_ASPECT_HEIGHT,
        displayAspectWidth: DISPLAY_ASPECT_WIDTH,
        hardwareAcceleration: 'prefer-software'
    };
    mutableDecoder.onError = options.onError ?? ((): undefined => undefined);
    mutableDecoder.onSample = options.onSample ?? ((sample: VideoSample): void => sample.close());
}

/** Configures an hev1 Main 10 decoder, whose packets are Annex B and carry their parameter sets in band. */
function configureInBandDecoder(
    decoder: HEVCSoftwareVideoDecoder,
    codec: string,
    codedWidth: number,
    codedHeight: number
): void {
    const mutableDecoder = decoder as unknown as MutableDecoderContract;
    mutableDecoder.codec = 'hevc';
    mutableDecoder.config = {
        codec,
        codedHeight,
        codedWidth,
        colorSpace: {
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'pq'
        } as unknown as VideoColorSpaceInit,
        hardwareAcceleration: 'prefer-software'
    };
    mutableDecoder.onError = (): undefined => undefined;
    mutableDecoder.onSample = (sample: VideoSample): void => sample.close();
}

/** Initializes an hev1 UHD Main 10 decoder, which takes its parameter sets in band. */
async function createInBandUHDDecoder(backend: HEVCDecoderBackend, codec: string): Promise<HEVCSoftwareVideoDecoder> {
    const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
    configureInBandDecoder(decoder, codec, UHD_CODED_WIDTH, UHD_CODED_HEIGHT);
    await decoder.init();
    return decoder;
}

/** Creates a length-prefixed packet holding one picture of a NAL unit type. */
function createPicturePacket(
    nalUnitType: number,
    timestampSeconds: number,
    durationSeconds: number,
    sequenceNumber: number
): EncodedPacket {
    return new EncodedPacket(
        createLengthPrefixedPacket([ createNALUnit(nalUnitType, [ sequenceNumber & 0xFF ]) ]),
        nalUnitType === CRA_NAL_UNIT_TYPE || nalUnitType === IDR_W_RADL_NAL_UNIT_TYPE ? 'key' : 'delta',
        timestampSeconds,
        durationSeconds,
        sequenceNumber
    );
}

function createEncodedPacket(timestampSeconds: number, durationSeconds: number, sequenceNumber: number): EncodedPacket {
    return createPicturePacket(IDR_W_RADL_NAL_UNIT_TYPE, timestampSeconds, durationSeconds, sequenceNumber);
}

/** Creates a key packet that carries an SPS in band ahead of its picture. */
function createInBandSPSPacket(sequenceParameterSet: Uint8Array): EncodedPacket {
    return new EncodedPacket(
        encodeAnnexBNALUnits([ sequenceParameterSet, createNALUnit(IDR_W_RADL_NAL_UNIT_TYPE, [ 1 ]) ]),
        'key',
        PACKET_TIMESTAMP_SECONDS,
        PACKET_DURATION_SECONDS,
        0
    );
}

describe('HEVC decoder configuration', () => {
    it('parses an HVCC record and its parameter sets', () => {
        const description = createHVCCDescription(MAIN10_PROFILE_IDC, MAIN10_BIT_DEPTH, SHORT_LENGTH_SIZE);

        const configuration = parseHEVCDecoderConfiguration(description);

        expect(configuration).toMatchObject({
            bitDepth: MAIN10_BIT_DEPTH,
            chromaFormat: 1,
            lengthSize: SHORT_LENGTH_SIZE,
            profileIDC: MAIN10_PROFILE_IDC
        });
        expect(configuration.sequenceParameterSets).toEqual([ MAIN10_SPS ]);
        expect(hasRequiredHEVCParameterSets(description)).toBe(true);
    });

    it('reads only base-layer HVCC parameter sets', () => {
        const description = createHVCCDescription(MAIN10_PROFILE_IDC, MAIN10_BIT_DEPTH, DEFAULT_LENGTH_SIZE, [
            VPS_NAL_UNIT,
            SECOND_LAYER_SPS,
            MAIN10_SPS,
            PPS_NAL_UNIT
        ]);

        const configuration = parseHEVCDecoderConfiguration(description);

        expect(configuration.sequenceParameterSets).toEqual([ MAIN10_SPS ]);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN10_CODEC_STRING,
            codedHeight: MAIN10_CODED_HEIGHT,
            codedWidth: MAIN10_CODED_WIDTH,
            description
        })).toBe(true);
        expect(hasRequiredHEVCParameterSets(createHVCCDescription(MAIN10_PROFILE_IDC, MAIN10_BIT_DEPTH, DEFAULT_LENGTH_SIZE, [
            VPS_NAL_UNIT,
            SECOND_LAYER_SPS,
            PPS_NAL_UNIT
        ]))).toBe(false);
    });

    it('rejects truncated configuration records and mismatched plane depths', () => {
        const description = createHVCCDescription();
        expect(() => parseHEVCDecoderConfiguration(description.subarray(0, -1))).toThrow(TRUNCATED_DESCRIPTION_ERROR);

        const mismatchedPlaneDepths = createHVCCDescription();
        mismatchedPlaneDepths[18] = 0;
        expect(() => parseHEVCDecoderConfiguration(mismatchedPlaneDepths)).toThrow(MISMATCHED_PLANE_DEPTHS_ERROR);
    });
});

describe('HEVCSoftwareVideoDecoder', () => {
    it('accepts Main and Main10 software configurations but never hardware-forced sinks', () => {
        const mainDescription = createHVCCDescription(MAIN_PROFILE_IDC, MAIN_BIT_DEPTH);
        const main10Description = createHVCCDescription(MAIN10_PROFILE_IDC, MAIN10_BIT_DEPTH);

        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN_CODEC_STRING,
            codedHeight: MAIN_CODED_HEIGHT,
            codedWidth: MAIN_CODED_WIDTH,
            description: mainDescription
        })).toBe(true);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN10_CODEC_STRING,
            codedHeight: MAIN10_CODED_HEIGHT,
            codedWidth: MAIN10_CODED_WIDTH,
            description: main10Description
        })).toBe(true);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN10_IN_BAND_PROGRESSIVE_CODEC_STRING,
            codedHeight: FULL_HD_CODED_HEIGHT,
            codedWidth: FULL_HD_CODED_WIDTH,
            description: createMain10DescriptionWithSPS(CROPPED_1080P_MAIN10_SPS)
        })).toBe(true);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN10_CODEC_STRING,
            codedHeight: MAIN10_CODED_HEIGHT,
            codedWidth: MAIN10_CODED_WIDTH,
            description: main10Description,
            hardwareAcceleration: 'prefer-hardware'
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN_STILL_PICTURE_CODEC_STRING,
            codedHeight: MAIN10_CODED_HEIGHT,
            codedWidth: MAIN10_CODED_WIDTH,
            description: createHVCCDescription(MAIN_STILL_PICTURE_PROFILE_IDC, MAIN10_BIT_DEPTH)
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN_CODEC_STRING,
            codedHeight: MAIN10_CODED_HEIGHT,
            codedWidth: MAIN10_CODED_WIDTH,
            description: main10Description
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN10_CODEC_STRING,
            codedHeight: MAIN10_CODED_HEIGHT,
            codedWidth: MAIN10_CODED_WIDTH,
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            description: main10Description
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN10_CODEC_STRING,
            codedHeight: FULL_HD_CODED_HEIGHT,
            codedWidth: FULL_HD_CODED_WIDTH,
            description: main10Description
        })).toBe(false);
        // Any frame size decodes once the configuration and SPS agree on it
        const DCI4KDescription = createMain10DescriptionWithSPS(DCI_4K_MAIN10_SPS);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: LEVEL_5_CODEC_STRING,
            codedHeight: DCI_4K_CODED_HEIGHT,
            codedWidth: DCI_4K_CODED_WIDTH,
            description: DCI4KDescription
        })).toBe(true);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: LEVEL_5_CODEC_STRING,
            codedHeight: UHD_CODED_HEIGHT,
            codedWidth: UHD_CODED_WIDTH,
            description: DCI4KDescription
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('avc', {
            codec: AVC_CODEC_STRING,
            codedHeight: MAIN10_CODED_HEIGHT,
            codedWidth: MAIN10_CODED_WIDTH
        })).toBe(false);
    });

    it('requires out-of-band VPS, SPS, and PPS data for hvc1 but permits hev1 in-band data', () => {
        const incompleteDescription = createHVCCDescription(MAIN10_PROFILE_IDC, MAIN10_BIT_DEPTH, DEFAULT_LENGTH_SIZE, [
            VPS_NAL_UNIT,
            createNALUnit(SPS_NAL_UNIT_TYPE, [ 2 ])
        ]);
        const inBandParameterSetDescription = createHVCCDescription(MAIN10_PROFILE_IDC, MAIN10_BIT_DEPTH, DEFAULT_LENGTH_SIZE, [
            VPS_NAL_UNIT,
            PPS_NAL_UNIT
        ]);
        const main10Dimensions = { codedHeight: MAIN10_CODED_HEIGHT, codedWidth: MAIN10_CODED_WIDTH };

        expect(HEVCSoftwareVideoDecoder.supports('hevc', { codec: MAIN10_CODEC_STRING, ...main10Dimensions })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN10_CODEC_STRING,
            ...main10Dimensions,
            description: incompleteDescription
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', { codec: MAIN10_IN_BAND_CODEC_STRING, ...main10Dimensions })).toBe(true);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN10_IN_BAND_CODEC_STRING,
            ...main10Dimensions,
            description: incompleteDescription
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN10_CODEC_STRING,
            ...main10Dimensions,
            description: inBandParameterSetDescription
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN10_IN_BAND_CODEC_STRING,
            ...main10Dimensions,
            description: inBandParameterSetDescription
        })).toBe(true);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: MAIN10_IN_BAND_CODEC_STRING,
            ...main10Dimensions,
            description: createHVCCDescription()
        })).toBe(true);
    });

    it('implements Mediabunny runtime inheritance without invoking its native base constructor', () => {
        const backend = new FakeHEVCDecoderBackend();
        const dependencyHarness = createDependencies(backend);

        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        const mediabunnyDecoder = new MediabunnyHEVCSoftwareVideoDecoder(dependencyHarness.dependencies);

        expect(decoder).toBeInstanceOf(CustomVideoDecoder);
        expect(mediabunnyDecoder).toBeInstanceOf(CustomVideoDecoder);
        expect(Object.getPrototypeOf(HEVCSoftwareVideoDecoder.prototype)).toBe(CustomVideoDecoder.prototype);
        expect(Object.getPrototypeOf(MediabunnyHEVCSoftwareVideoDecoder.prototype)).toBe(CustomVideoDecoder.prototype);
        decoder.close();
        mediabunnyDecoder.close();
    });

    it('keeps serialized close reachable after adapter initialization fails', async () => {
        const initializationError = new Error('initialization failed');
        const callbackError = new Error('error callback failed');
        const dependencies: HEVCSoftwareVideoDecoderDependencies = {
            createDecoder: vi.fn(async (): Promise<HEVCDecoderBackend> => {
                throw initializationError;
            }),
            loadDecoderGlue: vi.fn<(url: string) => void>(),
            resolveAssetURL: vi.fn((path: string): string => `${ASSET_BASE_URL}${path}`)
        };
        const onError = vi.fn((): never => {
            throw callbackError;
        });
        const decoder = new MediabunnyHEVCSoftwareVideoDecoder(dependencies);
        configureDecoder(decoder, { onError });
        let serializedCalls = Promise.resolve();

        serializedCalls = serializedCalls.then((): Promise<void> => decoder.init());
        serializedCalls = serializedCalls.then((): void => decoder.close());

        await expect(serializedCalls).resolves.toBeUndefined();
        await expect(waitForHEVCSoftwareVideoDecoderShutdown()).resolves.toBeUndefined();
        expect(onError).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(initializationError);
    });

    it('keeps serialized close reachable and reports one fatal adapter decode error', async () => {
        const decodeError = new Error('decode failed');
        const destroyError = new Error('destroy failed after decode');
        const backend = new FakeHEVCDecoderBackend();
        backend.decode.mockImplementation((): never => {
            throw decodeError;
        });
        backend.destroy.mockImplementation((): never => {
            throw destroyError;
        });
        const onError = vi.fn((): undefined => undefined);
        const decoder = new MediabunnyHEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder, { onError });
        let serializedCalls = Promise.resolve();

        serializedCalls = serializedCalls.then((): Promise<void> => decoder.init());
        serializedCalls = serializedCalls.then((): void => {
            decoder.decode(createEncodedPacket(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 0));
        });
        serializedCalls = serializedCalls.then((): void => decoder.flush());
        serializedCalls = serializedCalls.then((): void => decoder.close());

        await expect(serializedCalls).resolves.toBeUndefined();
        await expect(waitForHEVCSoftwareVideoDecoderShutdown()).resolves.toBeUndefined();
        expect(backend.destroy).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(decodeError);
    });

    it('waits for every live adapter to complete backend destruction', async () => {
        const firstBackend = new FakeHEVCDecoderBackend();
        const secondBackend = new FakeHEVCDecoderBackend();
        const firstDecoder = new HEVCSoftwareVideoDecoder(createDependencies(firstBackend).dependencies);
        const secondDecoder = new HEVCSoftwareVideoDecoder(createDependencies(secondBackend).dependencies);
        configureDecoder(firstDecoder);
        configureDecoder(secondDecoder);
        await firstDecoder.init();
        await secondDecoder.init();
        let shutdownCompleted = false;
        const shutdownPromise = waitForHEVCSoftwareVideoDecoderShutdown().then((): void => {
            shutdownCompleted = true;
        });

        await Promise.resolve();
        expect(shutdownCompleted).toBe(false);
        firstDecoder.close();
        await Promise.resolve();
        expect(firstBackend.destroy).toHaveBeenCalledOnce();
        expect(shutdownCompleted).toBe(false);

        secondDecoder.close();
        await shutdownPromise;
        expect(secondBackend.destroy).toHaveBeenCalledOnce();
        expect(shutdownCompleted).toBe(true);
    });

    it('completes shutdown tracking when the destroy error callback throws', async () => {
        const backend = new FakeHEVCDecoderBackend();
        backend.destroy.mockImplementation((): never => {
            throw new Error('destroy failed');
        });
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder, {
            onError: (): never => {
                throw new Error('error callback failed');
            }
        });
        await decoder.init();
        const shutdownPromise = waitForHEVCSoftwareVideoDecoderShutdown();

        expect(() => decoder.close()).toThrow('error callback failed');
        await expect(shutdownPromise).resolves.toBeUndefined();
    });

    it('rejects in-band SPS dimensions before sending the packet to the WASM decoder', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureInBandDecoder(decoder, MAIN10_IN_BAND_CODEC_STRING, FULL_HD_CODED_WIDTH, FULL_HD_CODED_HEIGHT);
        await decoder.init();

        expect(() => decoder.decode(createInBandSPSPacket(MAIN10_SPS))).toThrow(DIMENSIONS_CONTRADICT_ERROR);
        expect(backend.decode).not.toHaveBeenCalled();
        decoder.close();
    });

    it('rejects an in-band DPB above its level before sending the packet to the WASM decoder', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const decoder = await createInBandUHDDecoder(backend, LEVEL_5_1_IN_BAND_CODEC_STRING);

        expect(() => decoder.decode(createInBandSPSPacket(LEVEL_5_1_DPB_7_UHD_MAIN10_SPS)))
            .toThrow(DPB_ABOVE_LEVEL_ERROR);
        expect(backend.decode).not.toHaveBeenCalled();
        decoder.close();
    });

    it('sends an in-band DPB its level allows at any picture size', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const decoder = await createInBandUHDDecoder(backend, LEVEL_6_IN_BAND_CODEC_STRING);

        expect(decoder.decode(createInBandSPSPacket(LEVEL_6_DPB_7_UHD_MAIN10_SPS))).toBe(true);

        expect(backend.decode).toHaveBeenCalledOnce();
        decoder.close();
    });

    it('requires an SPS before coded data in an Annex B stream', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureInBandDecoder(decoder, MAIN10_IN_BAND_CODEC_STRING, MAIN10_CODED_WIDTH, MAIN10_CODED_HEIGHT);
        await decoder.init();
        const packet = new EncodedPacket(
            encodeAnnexBNALUnits([ createNALUnit(IDR_W_RADL_NAL_UNIT_TYPE, [ 1 ]) ]),
            'key',
            PACKET_TIMESTAMP_SECONDS,
            PACKET_DURATION_SECONDS,
            0
        );

        expect(() => decoder.decode(packet)).toThrow(MISSING_SPS_ERROR);
        expect(backend.decode).not.toHaveBeenCalled();
        decoder.close();
    });

    it('loads the FFmpeg assets and opens the decoder with the HVCC record and the WASM URL', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const dependencyHarness = createDependencies(backend);
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        configureDecoder(decoder);
        const description = (decoder as unknown as MutableDecoderContract).config.description as Uint8Array;

        await decoder.init();

        expect(dependencyHarness.loadDecoderGlue).toHaveBeenCalledWith(DECODER_GLUE_URL);
        expect(dependencyHarness.createDecoder).toHaveBeenCalledOnce();
        const options = dependencyHarness.createDecoder.mock.calls[0][0] as HEVCDecoderBackendOptions;
        expect(options.wasmURL).toBe(DECODER_WASM_URL);
        expect(options.description).toEqual(description);
        decoder.close();
    });

    it('opens an Annex B stream without a description', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const dependencyHarness = createDependencies(backend);
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        configureInBandDecoder(decoder, MAIN10_IN_BAND_CODEC_STRING, MAIN10_CODED_WIDTH, MAIN10_CODED_HEIGHT);

        await decoder.init();

        expect(dependencyHarness.createDecoder).toHaveBeenCalledWith({
            description: null,
            wasmURL: DECODER_WASM_URL
        });
        decoder.close();
    });

    it('sends each HVCC packet unconverted and creates an exact copyable I420P10 sample', async () => {
        const backend = new FakeHEVCDecoderBackend({ decodeOutputs: [ outputFrame() ] });
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder, {
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            }
        });
        await decoder.init();
        const packet = createEncodedPacket(OWNED_PACKET_TIMESTAMP_SECONDS, OWNED_PACKET_DURATION_SECONDS, OWNED_PACKET_SEQUENCE_NUMBER);

        expect(decoder.decode(packet)).toBe(true);

        // FFmpeg reads the NAL unit lengths the HVCC record declares, so the packet goes in as the container stores it
        expect(backend.decode).toHaveBeenCalledOnce();
        const [ sentData, sentTimestamp, sentDuration ] = backend.decode.mock.calls[0];
        expect(sentData).toBe(packet.data);
        expect(sentTimestamp).toBe(packet.microsecondTimestamp);
        expect(sentDuration).toBe(packet.microsecondDuration);
        expect(samples).toHaveLength(1);
        const sample = samples[0];
        expect(sample).toMatchObject({
            codedHeight: MAIN10_CODED_HEIGHT,
            codedWidth: MAIN10_CODED_WIDTH,
            displayHeight: DISPLAY_ASPECT_HEIGHT,
            displayWidth: DISPLAY_ASPECT_WIDTH,
            duration: OWNED_PACKET_SAMPLE_DURATION_SECONDS,
            format: 'I420P10',
            timestamp: OWNED_PACKET_TIMESTAMP_SECONDS
        });
        expect(sample.colorSpace.toJSON()).toEqual({
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'pq'
        });
        const destination = new Uint8Array(sample.allocationSize());
        const layouts = await sample.copyTo(destination);
        expect(layouts).toEqual(MAIN10_SAMPLE_LAYOUTS);
        const planarSamples = new Uint16Array(destination.buffer);
        expect(Array.from(planarSamples.subarray(0, LUMA_SAMPLES.length))).toEqual(LUMA_SAMPLES);
        expect(Array.from(planarSamples.subarray(
            MAIN10_CHROMA_BLUE_SAMPLE_OFFSET,
            MAIN10_CHROMA_BLUE_SAMPLE_OFFSET + CHROMA_BLUE_SAMPLES.length
        ))).toEqual(CHROMA_BLUE_SAMPLES);
        expect(Array.from(planarSamples.subarray(
            MAIN10_CHROMA_RED_SAMPLE_OFFSET,
            MAIN10_CHROMA_RED_SAMPLE_OFFSET + CHROMA_RED_SAMPLES.length
        ))).toEqual(CHROMA_RED_SAMPLES);
        sample.close();
        decoder.close();
    });

    it('keeps a container HLG transfer over an SPS that signals the BT.2020 10-bit transfer', async () => {
        const backend = new FakeHEVCDecoderBackend({ decodeOutputs: [ outputFrame() ] });
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder, {
            colorSpace: {
                fullRange: false,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: 'hlg'
            },
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            },
            sequenceParameterSet: MAIN10_BT2020_10_SPS
        });
        const configuration = (decoder as unknown as MutableDecoderContract).config;
        await decoder.init();

        decoder.decode(createEncodedPacket(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 0));

        expect(HEVCSoftwareVideoDecoder.supports('hevc', configuration)).toBe(true);
        expect(samples).toHaveLength(1);
        expect(samples[0].colorSpace.toJSON()).toEqual({
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'hlg'
        });
        samples[0].close();
        decoder.close();
    });

    it('treats BT.470 BG and SMPTE 170M as one BT.601 matrix and keeps the SPS names', async () => {
        const backend = new FakeHEVCDecoderBackend({ decodeOutputs: [ outputFrame() ] });
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        // SMPTE 170M uses the BT.709 transfer curve, so a container bt709 transfer agrees with it too
        configureDecoder(decoder, {
            colorSpace: {
                fullRange: false,
                matrix: 'bt470bg',
                primaries: 'smpte170m',
                transfer: 'bt709'
            },
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            },
            sequenceParameterSet: MAIN10_SMPTE170M_SPS
        });
        const configuration = (decoder as unknown as MutableDecoderContract).config;
        await decoder.init();

        decoder.decode(createEncodedPacket(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 0));

        expect(HEVCSoftwareVideoDecoder.supports('hevc', configuration)).toBe(true);
        expect(samples[0].colorSpace.toJSON()).toEqual({
            fullRange: false,
            matrix: 'smpte170m',
            primaries: 'smpte170m',
            transfer: 'smpte170m'
        });
        samples[0].close();
        decoder.close();
    });

    it.each([
        { matrix: 'bt470bg', primaries: 'bt470bg', transfer: 'smpte170m' },
        { matrix: 'bt709', primaries: 'smpte170m', transfer: 'smpte170m' },
        { matrix: 'smpte170m', primaries: 'smpte170m', transfer: 'pq' }
    ])('rejects a container color that contradicts a SMPTE 170M SPS: %o', containerColor => {
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(new FakeHEVCDecoderBackend()).dependencies);
        configureDecoder(decoder, {
            colorSpace: { fullRange: false, ...containerColor },
            sequenceParameterSet: MAIN10_SMPTE170M_SPS
        });

        expect(HEVCSoftwareVideoDecoder.supports('hevc', (decoder as unknown as MutableDecoderContract).config)).toBe(false);
        decoder.close();
    });

    it('constructs I420 output from the byte planes of Main profile frames', async () => {
        const backend = new FakeHEVCDecoderBackend({ decodeOutputs: [ outputFrame(MAIN_BIT_DEPTH) ] });
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder, {
            bitDepth: MAIN_BIT_DEPTH,
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            }
        });
        await decoder.init();

        decoder.decode(createEncodedPacket(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 0));

        expect(samples[0].format).toBe('I420');
        const destination = new Uint8Array(samples[0].allocationSize());
        await samples[0].copyTo(destination);
        expect(Array.from(destination.subarray(0, LUMA_SAMPLES.length))).toEqual(LUMA_SAMPLES);
        expect(Array.from(destination.subarray(
            MAIN_CHROMA_BLUE_BYTE_OFFSET,
            MAIN_CHROMA_BLUE_BYTE_OFFSET + CHROMA_BLUE_SAMPLES.length
        ))).toEqual(CHROMA_BLUE_SAMPLES);
        expect(Array.from(destination.subarray(
            MAIN_CHROMA_RED_BYTE_OFFSET,
            MAIN_CHROMA_RED_BYTE_OFFSET + CHROMA_RED_SAMPLES.length
        ))).toEqual(CHROMA_RED_SAMPLES);
        samples[0].close();
        decoder.close();
    });

    it('presents each frame with the timing its packet went in with, in output order', async () => {
        const earlierTiming = createTiming(LATER_PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS);
        const laterTiming = createTiming(LATEST_PACKET_TIMESTAMP_SECONDS, LONGER_PACKET_DURATION_SECONDS);
        // The second packet codes the earlier picture, so the decoder releases both after it
        const backend = new FakeHEVCDecoderBackend({
            decodeOutputs: [
                outputFrames([]),
                outputFrames([ createFrame(MAIN10_BIT_DEPTH, earlierTiming), createFrame(MAIN10_BIT_DEPTH, laterTiming) ])
            ]
        });
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder, {
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            }
        });
        await decoder.init();

        decoder.decode(createEncodedPacket(LATEST_PACKET_TIMESTAMP_SECONDS, LONGER_PACKET_DURATION_SECONDS, 0));
        decoder.decode(createPicturePacket(TRAIL_R_NAL_UNIT_TYPE, LATER_PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 1));

        expect(samples.map((sample: VideoSample): number => sample.timestamp)).toEqual([
            LATER_PACKET_TIMESTAMP_SECONDS,
            LATEST_PACKET_TIMESTAMP_SECONDS
        ]);
        expect(samples.map((sample: VideoSample): number => sample.duration)).toEqual([
            PACKET_DURATION_SECONDS,
            LONGER_PACKET_DURATION_SECONDS
        ]);
        for (const sample of samples) {
            sample.close();
        }
        decoder.close();
    });

    it('emits held frames on flush and keeps decoding after it', async () => {
        const firstTiming = createTiming(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS);
        const secondTiming = createTiming(LATER_PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS);
        const backend = new FakeHEVCDecoderBackend({ decodeOutputs: [ outputFrames([]), outputFrames([]) ] });
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder, {
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            }
        });
        await decoder.init();

        decoder.decode(createEncodedPacket(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 0));
        backend.flush.mockImplementationOnce((frameHandler: HEVCDecodedFrameHandler): number => (
            emitBackendFrames([ createFrame(MAIN10_BIT_DEPTH, firstTiming) ], frameHandler)
        ));
        decoder.flush();
        backend.flush.mockImplementationOnce((frameHandler: HEVCDecodedFrameHandler): number => (
            emitBackendFrames([ createFrame(MAIN10_BIT_DEPTH, secondTiming) ], frameHandler)
        ));
        decoder.decode(createEncodedPacket(LATER_PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 1));
        decoder.flush();

        // FFmpeg keeps the record's parameter sets across a flush, so nothing is sent again
        expect(backend.decode).toHaveBeenCalledTimes(2);
        expect(backend.flush).toHaveBeenCalledTimes(2);
        expect(samples.map((sample: VideoSample): number => sample.timestamp)).toEqual([
            PACKET_TIMESTAMP_SECONDS,
            LATER_PACKET_TIMESTAMP_SECONDS
        ]);
        for (const sample of samples) {
            sample.close();
        }
        decoder.close();
    });

    it('drops the leading RASL pictures after a random-access point, and only until another picture', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder);
        await decoder.init();
        const packets = [
            createPicturePacket(CRA_NAL_UNIT_TYPE, PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 0),
            createPicturePacket(RASL_N_NAL_UNIT_TYPE, PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 1),
            createPicturePacket(RASL_R_NAL_UNIT_TYPE, PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 2),
            createPicturePacket(TRAIL_R_NAL_UNIT_TYPE, PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 3),
            // A RASL picture after the first other picture decodes, since every picture it references was decoded
            createPicturePacket(RASL_N_NAL_UNIT_TYPE, PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 4)
        ];

        const results = packets.map((packet: EncodedPacket): boolean => decoder.decode(packet));
        decoder.flush();
        // A flush ends the random-access run, so the next one drops its leading RASL pictures again
        const resultsAfterFlush = [ packets[0], packets[1] ].map((packet: EncodedPacket): boolean => decoder.decode(packet));

        expect(results).toEqual([ true, false, false, true, true ]);
        expect(resultsAfterFlush).toEqual([ true, false ]);
        expect(backend.decode.mock.calls.map((call): Uint8Array => call[0])).toEqual([
            packets[0].data,
            packets[3].data,
            packets[4].data,
            packets[0].data
        ]);
        decoder.close();
    });

    it('reports a dropped leading picture through the Mediabunny adapter as no sample at all', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const onError = vi.fn((): undefined => undefined);
        const decoder = new MediabunnyHEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder, { onError });
        await decoder.init();

        decoder.decode(createPicturePacket(CRA_NAL_UNIT_TYPE, PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 0));
        decoder.decode(createPicturePacket(RASL_N_NAL_UNIT_TYPE, PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 1));

        expect(backend.decode).toHaveBeenCalledOnce();
        expect(onError).not.toHaveBeenCalled();
        decoder.close();
    });

    it('reads the NAL units of each packet in its stream\'s format before sending it', async () => {
        const lengthPrefixedBackend = new FakeHEVCDecoderBackend();
        const lengthPrefixedDecoder = new HEVCSoftwareVideoDecoder(createDependencies(lengthPrefixedBackend).dependencies);
        configureDecoder(lengthPrefixedDecoder);
        await lengthPrefixedDecoder.init();
        const annexBBackend = new FakeHEVCDecoderBackend();
        const annexBDecoder = new HEVCSoftwareVideoDecoder(createDependencies(annexBBackend).dependencies);
        configureInBandDecoder(annexBDecoder, MAIN10_IN_BAND_CODEC_STRING, MAIN10_CODED_WIDTH, MAIN10_CODED_HEIGHT);
        await annexBDecoder.init();

        expect(() => lengthPrefixedDecoder.decode(new EncodedPacket(
            TRUNCATED_LENGTH_PREFIXED_PACKET,
            'key',
            PACKET_TIMESTAMP_SECONDS,
            PACKET_DURATION_SECONDS,
            0
        ))).toThrow(TRUNCATED_PACKET_ERROR);
        expect(() => annexBDecoder.decode(new EncodedPacket(
            createLengthPrefixedPacket([ createNALUnit(IDR_W_RADL_NAL_UNIT_TYPE, [ 1 ]) ]),
            'key',
            PACKET_TIMESTAMP_SECONDS,
            PACKET_DURATION_SECONDS,
            0
        ))).toThrow(MISSING_START_CODE_ERROR);
        expect(annexBDecoder.decode(createInBandSPSPacket(MAIN10_SPS))).toBe(true);

        expect(lengthPrefixedBackend.decode).not.toHaveBeenCalled();
        expect(annexBBackend.decode).toHaveBeenCalledOnce();
        lengthPrefixedDecoder.close();
        annexBDecoder.close();
    });

    it('ignores the NAL units of other layers', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder);
        await decoder.init();
        // Another layer's SPS would not parse, and a prefix SEI is no picture
        const packet = new EncodedPacket(
            createLengthPrefixedPacket([
                createNALUnit(PREFIX_SEI_NAL_UNIT_TYPE, [ 1 ]),
                SECOND_LAYER_SPS,
                createNALUnit(IDR_W_RADL_NAL_UNIT_TYPE, [ 1 ])
            ]),
            'key',
            PACKET_TIMESTAMP_SECONDS,
            PACKET_DURATION_SECONDS,
            0
        );

        expect(decoder.decode(packet)).toBe(true);

        expect(backend.decode).toHaveBeenCalledOnce();
        decoder.close();
    });

    it('rejects a negative packet duration', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder);
        await decoder.init();
        const packet = createEncodedPacket(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 0);
        // Mediabunny's packets refuse a negative duration themselves, so a packet-shaped stand-in carries one
        const negativeDurationPacket = {
            data: packet.data,
            isMetadataOnly: false,
            microsecondDuration: NEGATIVE_PACKET_DURATION_MICROSECONDS,
            microsecondTimestamp: packet.microsecondTimestamp
        } as unknown as EncodedPacket;

        expect(() => decoder.decode(negativeDurationPacket)).toThrow(NEGATIVE_DURATION_ERROR);
        expect(backend.decode).not.toHaveBeenCalled();
        decoder.close();
    });

    it('rejects decoded frames whose dimensions or bit depth contradict the active SPS', async () => {
        const packetTiming = createTiming(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS);
        const narrowFrame = createFrame(MAIN10_BIT_DEPTH, packetTiming);
        const narrowBackend = new FakeHEVCDecoderBackend({
            decodeOutputs: [ outputFrames([ { ...narrowFrame, width: narrowFrame.width - 2 } ]) ]
        });
        const narrowDecoder = new HEVCSoftwareVideoDecoder(createDependencies(narrowBackend).dependencies);
        configureDecoder(narrowDecoder);
        await narrowDecoder.init();
        const shallowBackend = new FakeHEVCDecoderBackend({
            decodeOutputs: [ outputFrames([ { ...createFrame(MAIN10_BIT_DEPTH, packetTiming), bitDepth: MAIN_BIT_DEPTH } ]) ]
        });
        const shallowDecoder = new HEVCSoftwareVideoDecoder(createDependencies(shallowBackend).dependencies);
        configureDecoder(shallowDecoder);
        await shallowDecoder.init();

        expect(() => narrowDecoder.decode(createEncodedPacket(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 0)))
            .toThrow(SPS_CONTRADICTION_ERROR);
        expect(() => shallowDecoder.decode(createEncodedPacket(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 0)))
            .toThrow(SPS_CONTRADICTION_ERROR);
        narrowDecoder.close();
        shallowDecoder.close();
    });

    it('rejects a frame whose planes hold samples of another bit depth', async () => {
        const main10Frame = createFrame(MAIN10_BIT_DEPTH, createTiming(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS));
        // Byte planes of the Main 10 frame's size, as an 8-bit decoder would return them
        const byteFrame: HEVCDecodedFrame = {
            ...main10Frame,
            planes: {
                chromaBlue: createPlane(MAIN_BIT_DEPTH, CHROMA_BLUE_SAMPLES, main10Frame.chromaWidth, main10Frame.chromaHeight, 0),
                chromaRed: createPlane(MAIN_BIT_DEPTH, CHROMA_RED_SAMPLES, main10Frame.chromaWidth, main10Frame.chromaHeight, 0),
                luma: createPlane(MAIN_BIT_DEPTH, LUMA_SAMPLES, main10Frame.width, main10Frame.height, 0)
            }
        };
        const backend = new FakeHEVCDecoderBackend({ decodeOutputs: [ outputFrames([ byteFrame ]) ] });
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder);
        decoder.onFrame = vi.fn();
        await decoder.init();

        expect(() => decoder.decode(createEncodedPacket(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 0)))
            .toThrow(PLANE_BIT_DEPTH_ERROR);
        expect(decoder.onFrame).not.toHaveBeenCalled();
        decoder.close();
    });

    it('closes a rejected sample and destroys backend resources exactly once', async () => {
        const backend = new FakeHEVCDecoderBackend({ decodeOutputs: [ outputFrame() ] });
        let rejectedSample: VideoSample | null = null;
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder, {
            onSample: (sample: VideoSample): never => {
                rejectedSample = sample;
                throw new Error('consumer failed');
            }
        });
        await decoder.init();

        expect(() => decoder.decode(createEncodedPacket(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS, 0)))
            .toThrow('consumer failed');
        expect(rejectedSample).not.toBeNull();
        expect(() => rejectedSample?.allocationSize()).toThrow('closed');
        decoder.close();
        decoder.close();
        expect(backend.destroy).toHaveBeenCalledOnce();
    });

    it('surfaces destroy errors through the out-of-band error callback', async () => {
        const backend = new FakeHEVCDecoderBackend();
        backend.destroy.mockImplementation((): never => {
            throw new Error('destroy failed');
        });
        const onError = vi.fn((): undefined => undefined);
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder, { onError });
        await decoder.init();

        decoder.close();

        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'destroy failed' }));
    });

    it.each<OwnedFrameVariant>([
        { bitDepth: MAIN10_BIT_DEPTH, label: 'a PQ Main 10 stream' },
        { bitDepth: MAIN_BIT_DEPTH, label: 'a BT.709 Main stream' },
        {
            bitDepth: MAIN10_BIT_DEPTH,
            colorSpace: { fullRange: false, matrix: 'bt2020-ncl', primaries: 'bt2020', transfer: 'hlg' },
            label: 'a container HLG over a BT.2020 10-bit SPS',
            sequenceParameterSet: MAIN10_BT2020_10_SPS
        },
        {
            bitDepth: MAIN10_BIT_DEPTH,
            colorSpace: { fullRange: false, matrix: 'bt470bg', primaries: 'smpte170m', transfer: 'bt709' },
            label: 'a SMPTE 170M SPS',
            sequenceParameterSet: MAIN10_SMPTE170M_SPS
        }
    ])('describes an owned frame of $label with its sample\'s metadata and planes', async (
        variant: OwnedFrameVariant
    ): Promise<void> => {
        const sampleBackend = new FakeHEVCDecoderBackend({ decodeOutputs: [ outputFrame(variant.bitDepth) ] });
        const ownedBackend = new FakeHEVCDecoderBackend({
            decodeOutputs: [ outputFrame(variant.bitDepth, PADDED_ROW_SAMPLE_COUNT) ]
        });
        const samples: VideoSample[] = [];
        const ownedFrames: Array<{ frame: HEVCSoftwareDecodedFrame, planeSamples: number[][] }> = [];
        const sampleDecoder = new HEVCSoftwareVideoDecoder(createDependencies(sampleBackend).dependencies);
        const ownedDecoder = new HEVCSoftwareVideoDecoder(createDependencies(ownedBackend).dependencies);
        const ownedSampleHandler = vi.fn();
        configureDecoder(sampleDecoder, {
            ...variant,
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            }
        });
        configureDecoder(ownedDecoder, { ...variant, onSample: ownedSampleHandler });
        ownedDecoder.onFrame = (frame: HEVCSoftwareDecodedFrame): void => {
            // The planes are read while the decoder still holds them
            ownedFrames.push({
                frame,
                planeSamples: [
                    compactPlane(frame.planes.luma, frame.codedWidth, frame.codedHeight),
                    compactPlane(frame.planes.chromaBlue, frame.chromaWidth, frame.chromaHeight),
                    compactPlane(frame.planes.chromaRed, frame.chromaWidth, frame.chromaHeight)
                ]
            });
        };
        await sampleDecoder.init();
        await ownedDecoder.init();

        const packet = createEncodedPacket(OWNED_PACKET_TIMESTAMP_SECONDS, OWNED_PACKET_DURATION_SECONDS, OWNED_PACKET_SEQUENCE_NUMBER);
        sampleDecoder.decode(packet);
        ownedDecoder.decode(packet);

        expect(ownedSampleHandler).not.toHaveBeenCalled();
        expect(ownedFrames).toHaveLength(1);
        const [ sample ] = samples;
        const { frame, planeSamples } = ownedFrames[0];
        expect({
            codedHeight: frame.codedHeight,
            codedWidth: frame.codedWidth,
            colorSpace: frame.colorSpace.toJSON(),
            displayHeight: frame.displayHeight,
            displayWidth: frame.displayWidth,
            durationMicroseconds: frame.durationMicroseconds,
            format: frame.format,
            timestampMicroseconds: frame.timestampMicroseconds
        }).toEqual({
            codedHeight: sample.codedHeight,
            codedWidth: sample.codedWidth,
            colorSpace: sample.colorSpace.toJSON(),
            displayHeight: sample.squarePixelHeight,
            displayWidth: sample.squarePixelWidth,
            durationMicroseconds: sample.microsecondDuration,
            format: sample.format,
            timestampMicroseconds: sample.microsecondTimestamp
        });
        expect(frame.timestampMicroseconds).toBe(packet.microsecondTimestamp);
        const sampleBytes = new Uint8Array(sample.allocationSize());
        await sample.copyTo(sampleBytes);
        const packedSamples = variant.bitDepth === MAIN_BIT_DEPTH ? sampleBytes : new Uint16Array(sampleBytes.buffer);
        expect(planeSamples.flat()).toEqual(Array.from(packedSamples));
        sample.close();
        sampleDecoder.close();
        ownedDecoder.close();
    });

    it('creates an owned decoder whose frames and errors reach its callbacks', async () => {
        const backend = new FakeHEVCDecoderBackend({
            decodeOutputs: [ outputFrame(MAIN10_BIT_DEPTH, PADDED_ROW_SAMPLE_COUNT) ]
        });
        const onError = vi.fn();
        const onFrame = vi.fn();
        const decoder = createOwnedHEVCSoftwareVideoDecoder({
            codec: MAIN10_CODEC_STRING,
            codedHeight: MAIN10_CODED_HEIGHT,
            codedWidth: MAIN10_CODED_WIDTH,
            description: createHVCCDescription()
        }, { onError, onFrame }, createDependencies(backend).dependencies);
        backend.destroy.mockImplementation((): never => {
            throw new Error('destroy failed');
        });
        await decoder.init();

        decoder.decode(createEncodedPacket(PACKET_TIMESTAMP_SECONDS, OWNED_PACKET_DURATION_SECONDS, 0));
        decoder.close();

        expect(onFrame).toHaveBeenCalledOnce();
        expect(onFrame.mock.calls[0][0]).toMatchObject({
            codedHeight: MAIN10_CODED_HEIGHT,
            codedWidth: MAIN10_CODED_WIDTH,
            format: 'I420P10'
        });
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'destroy failed' }));
    });

    it('rejects an owned frame whose padded plane does not hold its rows', async () => {
        const paddedFrame = createFrame(
            MAIN10_BIT_DEPTH,
            createTiming(PACKET_TIMESTAMP_SECONDS, PACKET_DURATION_SECONDS),
            PADDED_ROW_SAMPLE_COUNT
        );
        const chromaRed = paddedFrame.planes.chromaRed;
        // The red chroma plane lacks its first sample, so it no longer holds its rows
        const truncatedFrame: HEVCDecodedFrame = {
            ...paddedFrame,
            planes: {
                ...paddedFrame.planes,
                chromaRed: { samples: chromaRed.samples.subarray(1), stride: chromaRed.stride }
            }
        };
        const backend = new FakeHEVCDecoderBackend({ decodeOutputs: [ outputFrames([ truncatedFrame ]) ] });
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
        configureDecoder(decoder);
        decoder.onFrame = vi.fn();
        await decoder.init();

        expect(() => decoder.decode(createEncodedPacket(PACKET_TIMESTAMP_SECONDS, OWNED_PACKET_DURATION_SECONDS, 0)))
            .toThrow(PLANE_LENGTH_ERROR);
        expect(decoder.onFrame).not.toHaveBeenCalled();
        decoder.close();
    });
});
