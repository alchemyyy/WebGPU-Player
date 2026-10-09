import type { HEVCFrame, HEVCStreamInfo } from '@hevcjs/core';
import {
    CustomVideoDecoder,
    EncodedPacket,
    type VideoCodec,
    type VideoSample
} from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import type {
    HEVCDecodedFrameHandler,
    HEVCDecoderBackend
} from 'webgpu-player/video/decoders/HEVCDecoderBackend';
import HEVCSoftwareVideoDecoder, {
    convertHVCCPacketToAnnexB,
    hasRequiredHEVCParameterSets,
    inspectAnnexBPacket,
    MAXIMUM_HEVC_PENDING_PICTURE_COUNT,
    MediabunnyHEVCSoftwareVideoDecoder,
    parseHEVCDecoderConfiguration,
    type HEVCSoftwareVideoDecoderDependencies,
    waitForHEVCSoftwareVideoDecoderShutdown
} from 'webgpu-player/video/decoders/HEVCSoftwareVideoDecoder';

type MutableDecoderContract = {
    codec: VideoCodec
    config: VideoDecoderConfig
    onError: (error: unknown) => undefined
    onSample: (sample: VideoSample) => unknown
};

type FakeBackendOptions = {
    drainBatches?: HEVCFrame[][]
    flushFrames?: HEVCFrame[]
    info?: HEVCStreamInfo | null
};

function emitBackendFrames(
    frames: readonly HEVCFrame[],
    frameHandler: HEVCDecodedFrameHandler
): number {
    for (const frame of frames) {
        frameHandler(frame);
    }
    return frames.length;
}

class FakeHEVCDecoderBackend implements HEVCDecoderBackend {
    public readonly destroy = vi.fn<() => void>();
    public readonly drain = vi.fn<(frameHandler: HEVCDecodedFrameHandler) => number>();
    public readonly feed = vi.fn<(data: Uint8Array) => void>();
    public readonly flush = vi.fn<(frameHandler: HEVCDecodedFrameHandler) => number>();
    public info: HEVCStreamInfo | null;

    public constructor(options: FakeBackendOptions = {}) {
        const drainBatches = options.drainBatches ?? [];
        this.info = options.info ?? null;
        this.drain.mockImplementation((frameHandler: HEVCDecodedFrameHandler): number => (
            emitBackendFrames(drainBatches.shift() ?? [], frameHandler)
        ));
        this.flush.mockImplementation((frameHandler: HEVCDecodedFrameHandler): number => (
            emitBackendFrames(options.flushFrames ?? [], frameHandler)
        ));
    }
}

function createNALUnit(nalUnitType: number, payload: readonly number[] = []): Uint8Array {
    return new Uint8Array([ nalUnitType << 1, 1, ...payload ]);
}

function createBytesFromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
        bytes[byteIndex] = Number.parseInt(hex.slice(byteIndex * 2, (byteIndex * 2) + 2), 16);
    }
    return bytes;
}

const MAIN_SPS = createBytesFromHex(
    '42010101600000030090000003000003001ea020810596566924caf016a020202080000003008000000c04'
);
const MAIN10_SPS = createBytesFromHex(
    '4201010220000003009000000300000300ffa005020169365959a4932bc05a848804820000030002000003000210'
);
const CROPPED_1080P_MAIN10_SPS = createBytesFromHex(
    '420101022000000300900000030000030078a003c0801107cad96e92930bc05a848804db0800001f480002ee0040'
);
const UHD_CODED_WIDTH = 3_840;
const UHD_CODED_HEIGHT = 2_160;
const DCI_4K_CODED_WIDTH = 4_096;
const DCI_4K_CODED_HEIGHT = 2_160;
const LEVEL_5_CODEC_STRING = 'hvc1.2.4.L150.B0';
const LEVEL_5_1_IN_BAND_CODEC_STRING = 'hev1.2.4.L153.B0';
const LEVEL_6_IN_BAND_CODEC_STRING = 'hev1.2.4.L180.B0';
const DPB_ABOVE_LEVEL_ERROR = 'decoded picture buffer exceeds';
const IN_BAND_PACKET_TIMESTAMP_SECONDS = 0;
const IN_BAND_PACKET_DURATION_SECONDS = 0.04;
const IN_BAND_PACKET_SEQUENCE_NUMBER = 0;
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

function createHVCCDescription(
    profileIDC = 2,
    bitDepth = 10,
    lengthSize: 1 | 2 | 3 | 4 = 4,
    nalUnits?: readonly Uint8Array[]
): Uint8Array {
    const resolvedNALUnits = nalUnits ?? [
        createNALUnit(32, [ 1 ]),
        bitDepth === 8 ? MAIN_SPS : MAIN10_SPS,
        createNALUnit(34, [ 3 ])
    ];
    const descriptionBytes: number[] = new Array<number>(23).fill(0);
    descriptionBytes[0] = 1;
    descriptionBytes[1] = profileIDC;
    descriptionBytes[16] = 1;
    descriptionBytes[17] = bitDepth - 8;
    descriptionBytes[18] = bitDepth - 8;
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

function createLengthPrefixedPacket(
    nalUnit: Uint8Array,
    lengthSize: 1 | 2 | 3 | 4 = 4
): Uint8Array {
    const packet = new Uint8Array(lengthSize + nalUnit.byteLength);
    let remainingLength = nalUnit.byteLength;
    for (let byteIndex = lengthSize - 1; byteIndex >= 0; byteIndex -= 1) {
        packet[byteIndex] = remainingLength & 0xFF;
        remainingLength = Math.floor(remainingLength / 256);
    }
    packet.set(nalUnit, lengthSize);
    return packet;
}

function createAnnexBPacket(nalUnits: readonly Uint8Array[]): Uint8Array {
    const byteLength = nalUnits.reduce(
        (totalByteLength: number, nalUnit: Uint8Array): number => (
            totalByteLength + 4 + nalUnit.byteLength
        ),
        0
    );
    const packet = new Uint8Array(byteLength);
    let offset = 0;
    for (const nalUnit of nalUnits) {
        packet.set([ 0, 0, 0, 1 ], offset);
        offset += 4;
        packet.set(nalUnit, offset);
        offset += nalUnit.byteLength;
    }
    return packet;
}

function createStreamInfo(bitDepth: 8 | 10): HEVCStreamInfo {
    return {
        bitDepth,
        chromaFormat: 1,
        height: bitDepth === 8 ? 64 : 360,
        // @hevcjs/core 1.3.2 currently reports zero for these parsed fields
        level: 0,
        profile: 0,
        width: bitDepth === 8 ? 64 : 640
    };
}

function createFrame(bitDepth: 8 | 10 = 10, poc = 0): HEVCFrame {
    const width = bitDepth === 8 ? 64 : 640;
    const height = bitDepth === 8 ? 64 : 360;
    const chromaWidth = width / 2;
    const chromaHeight = height / 2;
    const luma = new Uint16Array(width * height);
    const chromaBlue = new Uint16Array(chromaWidth * chromaHeight);
    const chromaRed = new Uint16Array(chromaWidth * chromaHeight);
    luma.set([ 1, 2, 3, 4, 9, 10, 11, 12 ]);
    chromaBlue.set([ 5, 6 ]);
    chromaRed.set([ 7, 8 ]);
    return {
        bitDepth,
        cb: chromaBlue,
        chromaHeight,
        chromaWidth,
        cr: chromaRed,
        height,
        poc,
        width,
        y: luma
    };
}

function createDependencies(backend: HEVCDecoderBackend): {
    createDecoder: ReturnType<typeof vi.fn>
    dependencies: HEVCSoftwareVideoDecoderDependencies
    loadDecoderGlue: ReturnType<typeof vi.fn>
    resolveAssetURL: ReturnType<typeof vi.fn>
} {
    const createDecoder = vi.fn(
        async (): Promise<HEVCDecoderBackend> => backend
    );
    const loadDecoderGlue = vi.fn<(url: string) => void>();
    const resolveAssetURL = vi.fn((path: string): string => `https://example.test/web/libraries/${path}`);
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
        bitDepth?: 8 | 10
        /** Replaces the configured container color */
        colorSpace?: Record<string, unknown>
        onError?: (error: unknown) => undefined
        onSample?: (sample: VideoSample) => unknown
        /** Replaces the Main10 HVCC SPS */
        sequenceParameterSet?: Uint8Array
    } = {}
): void {
    const bitDepth = options.bitDepth ?? 10;
    const mutableDecoder = decoder as unknown as MutableDecoderContract;
    const profileIDC = bitDepth === 8 ? 1 : 2;
    const defaultColorSpace = bitDepth === 8 ?
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
        codec: bitDepth === 8 ? 'hvc1.1.6.L120.B0' : 'hvc1.2.4.L120.B0',
        codedHeight: bitDepth === 8 ? 64 : 360,
        codedWidth: bitDepth === 8 ? 64 : 640,
        colorSpace: (options.colorSpace ?? defaultColorSpace) as unknown as VideoColorSpaceInit,
        description: options.sequenceParameterSet ?
            createHVCCDescription(2, 10, 4, [
                createNALUnit(32, [ 1 ]),
                options.sequenceParameterSet,
                createNALUnit(34, [ 3 ])
            ]) :
            createHVCCDescription(profileIDC, bitDepth),
        displayAspectHeight: 9,
        displayAspectWidth: 16,
        hardwareAcceleration: 'prefer-software'
    };
    mutableDecoder.onError = options.onError ?? ((): undefined => undefined);
    mutableDecoder.onSample = options.onSample ?? ((sample: VideoSample): void => sample.close());
}

function createEncodedPacket(
    timestamp: number,
    duration: number,
    sequenceNumber: number
): EncodedPacket {
    return new EncodedPacket(
        createLengthPrefixedPacket(createNALUnit(19, [ sequenceNumber & 0xFF ])),
        'key',
        timestamp,
        duration,
        sequenceNumber
    );
}

/** Initializes an hev1 UHD Main 10 decoder, which takes its parameter sets in band. */
async function createInBandUHDDecoder(
    backend: HEVCDecoderBackend,
    codec: string
): Promise<HEVCSoftwareVideoDecoder> {
    const decoder = new HEVCSoftwareVideoDecoder(createDependencies(backend).dependencies);
    const mutableDecoder = decoder as unknown as MutableDecoderContract;
    mutableDecoder.codec = 'hevc';
    mutableDecoder.config = {
        codec,
        codedHeight: UHD_CODED_HEIGHT,
        codedWidth: UHD_CODED_WIDTH,
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
    await decoder.init();
    return decoder;
}

/** Creates a key packet that carries an SPS in band ahead of its picture. */
function createInBandSPSPacket(sequenceParameterSet: Uint8Array): EncodedPacket {
    return new EncodedPacket(
        createAnnexBPacket([ sequenceParameterSet, createNALUnit(19, [ 1 ]) ]),
        'key',
        IN_BAND_PACKET_TIMESTAMP_SECONDS,
        IN_BAND_PACKET_DURATION_SECONDS,
        IN_BAND_PACKET_SEQUENCE_NUMBER
    );
}

describe('HEVC bitstream conversion', () => {
    it('parses HVCC parameter sets and converts each to Annex B', () => {
        const description = createHVCCDescription(2, 10, 2);

        const configuration = parseHEVCDecoderConfiguration(description);

        expect(configuration).toMatchObject({
            bitDepth: 10,
            chromaFormat: 1,
            lengthSize: 2,
            profileIDC: 2
        });
        expect(Array.from(configuration.parameterSetsAnnexB.subarray(0, 7))).toEqual([
            0, 0, 0, 1, 64, 1, 1
        ]);
        expect(configuration.sequenceParameterSets).toHaveLength(1);
        expect(configuration.sequenceParameterSets[0]).toEqual(MAIN10_SPS);
        expect(hasRequiredHEVCParameterSets(description)).toBe(true);
    });

    it('reads only base-layer HVCC parameter sets', () => {
        // FFmpeg keeps an alpha layer's parameter sets, with nuh_layer_id 1, in HVCC
        const alphaLayerSPS = new Uint8Array([ 33 << 1, (1 << 3) | 1, 0xFF, 0xFF ]);
        const baseLayerVPS = createNALUnit(32, [ 1 ]);
        const baseLayerPPS = createNALUnit(34, [ 3 ]);
        const description = createHVCCDescription(2, 10, 4, [
            baseLayerVPS,
            alphaLayerSPS,
            MAIN10_SPS,
            baseLayerPPS
        ]);

        const configuration = parseHEVCDecoderConfiguration(description);

        expect(configuration.sequenceParameterSets).toEqual([ MAIN10_SPS ]);
        expect(configuration.parameterSetsAnnexB).toEqual(
            createAnnexBPacket([ baseLayerVPS, MAIN10_SPS, baseLayerPPS ])
        );
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 360,
            codedWidth: 640,
            description
        })).toBe(true);
        expect(hasRequiredHEVCParameterSets(createHVCCDescription(2, 10, 4, [
            baseLayerVPS,
            alphaLayerSPS,
            baseLayerPPS
        ]))).toBe(false);
    });

    it('converts all HVCC packet NAL units and detects coded picture data', () => {
        const prefixOnly = createLengthPrefixedPacket(createNALUnit(39, [ 1 ]), 2);
        const picture = createLengthPrefixedPacket(createNALUnit(19, [ 2, 3 ]), 2);
        const packet = new Uint8Array(prefixOnly.byteLength + picture.byteLength);
        packet.set(prefixOnly, 0);
        packet.set(picture, prefixOnly.byteLength);

        const converted = convertHVCCPacketToAnnexB(packet, 2);

        expect(converted.hasVCLNALUnit).toBe(true);
        expect(Array.from(converted.data)).toEqual([
            0, 0, 0, 1, 78, 1, 1,
            0, 0, 0, 1, 38, 1, 2, 3
        ]);
        expect(inspectAnnexBPacket(converted.data)).toEqual(converted);
    });

    it('rejects truncated configuration records and packet lengths', () => {
        const description = createHVCCDescription();
        expect(() => parseHEVCDecoderConfiguration(description.subarray(0, -1))).toThrow(
            'invalid NAL unit'
        );
        expect(() => convertHVCCPacketToAnnexB(
            new Uint8Array([ 0, 0, 0, 8, 38, 1 ]),
            4
        )).toThrow('invalid NAL unit length');
        expect(() => inspectAnnexBPacket(new Uint8Array([ 38, 1 ]))).toThrow(
            'neither Annex B nor HVCC'
        );

        const mismatchedPlaneDepths = createHVCCDescription();
        mismatchedPlaneDepths[18] = 0;
        expect(() => parseHEVCDecoderConfiguration(mismatchedPlaneDepths)).toThrow(
            'mismatched plane bit depths'
        );
    });
});

describe('HEVCSoftwareVideoDecoder', () => {
    it('accepts Main and Main10 software configurations but never hardware-forced sinks', () => {
        const mainDescription = createHVCCDescription(1, 8);
        const main10Description = createHVCCDescription(2, 10);

        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hvc1.1.6.L120.B0',
            codedHeight: 64,
            codedWidth: 64,
            description: mainDescription
        })).toBe(true);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 360,
            codedWidth: 640,
            description: main10Description
        })).toBe(true);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hev1.2.4.L120.90',
            codedHeight: 1_080,
            codedWidth: 1_920,
            description: createHVCCDescription(2, 10, 4, [
                createNALUnit(32, [ 1 ]),
                CROPPED_1080P_MAIN10_SPS,
                createNALUnit(34, [ 3 ])
            ])
        })).toBe(true);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 360,
            codedWidth: 640,
            description: main10Description,
            hardwareAcceleration: 'prefer-hardware'
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hvc1.3.4.L120.B0',
            codedHeight: 360,
            codedWidth: 640,
            description: createHVCCDescription(3, 10)
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hvc1.1.6.L120.B0',
            codedHeight: 360,
            codedWidth: 640,
            description: main10Description
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 360,
            codedWidth: 640,
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            description: main10Description
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            description: main10Description
        })).toBe(false);
        // Any frame size decodes once the configuration and SPS agree on it
        const DCI4KDescription = createHVCCDescription(2, 10, 4, [
            createNALUnit(32, [ 1 ]),
            DCI_4K_MAIN10_SPS,
            createNALUnit(34, [ 3 ])
        ]);
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
            codec: 'avc1.640028',
            codedHeight: 360,
            codedWidth: 640
        })).toBe(false);
    });

    it('requires out-of-band VPS, SPS, and PPS data for hvc1 but permits hev1 in-band data', () => {
        const incompleteDescription = createHVCCDescription(2, 10, 4, [
            createNALUnit(32, [ 1 ]),
            createNALUnit(33, [ 2 ])
        ]);
        const inBandParameterSetDescription = createHVCCDescription(2, 10, 4, [
            createNALUnit(32, [ 1 ]),
            createNALUnit(34, [ 3 ])
        ]);

        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 360,
            codedWidth: 640
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 360,
            codedWidth: 640,
            description: incompleteDescription
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hev1.2.4.L120.B0',
            codedHeight: 360,
            codedWidth: 640
        })).toBe(true);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hev1.2.4.L120.B0',
            codedHeight: 360,
            codedWidth: 640,
            description: incompleteDescription
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 360,
            codedWidth: 640,
            description: inBandParameterSetDescription
        })).toBe(false);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hev1.2.4.L120.B0',
            codedHeight: 360,
            codedWidth: 640,
            description: inBandParameterSetDescription
        })).toBe(true);
        expect(HEVCSoftwareVideoDecoder.supports('hevc', {
            codec: 'hev1.2.4.L120.B0',
            codedHeight: 360,
            codedWidth: 640,
            description: createHVCCDescription(2, 10)
        })).toBe(true);
    });

    it('implements Mediabunny runtime inheritance without invoking its native base constructor', () => {
        const backend = new FakeHEVCDecoderBackend();
        const dependencyHarness = createDependencies(backend);

        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        const mediabunnyDecoder = new MediabunnyHEVCSoftwareVideoDecoder(
            dependencyHarness.dependencies
        );

        expect(decoder).toBeInstanceOf(CustomVideoDecoder);
        expect(mediabunnyDecoder).toBeInstanceOf(CustomVideoDecoder);
        expect(Object.getPrototypeOf(HEVCSoftwareVideoDecoder.prototype)).toBe(
            CustomVideoDecoder.prototype
        );
        expect(Object.getPrototypeOf(MediabunnyHEVCSoftwareVideoDecoder.prototype)).toBe(
            CustomVideoDecoder.prototype
        );
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
            resolveAssetURL: vi.fn((path: string): string => `https://example.test/web/libraries/${path}`)
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
        backend.feed.mockImplementation((): never => {
            throw decodeError;
        });
        backend.destroy.mockImplementation((): never => {
            throw destroyError;
        });
        const onError = vi.fn((): undefined => undefined);
        const decoder = new MediabunnyHEVCSoftwareVideoDecoder(
            createDependencies(backend).dependencies
        );
        configureDecoder(decoder, { onError });
        let serializedCalls = Promise.resolve();

        serializedCalls = serializedCalls.then((): Promise<void> => decoder.init());
        serializedCalls = serializedCalls.then((): void => {
            decoder.decode(createEncodedPacket(0, 0.04, 0));
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
        const firstDecoder = new HEVCSoftwareVideoDecoder(
            createDependencies(firstBackend).dependencies
        );
        const secondDecoder = new HEVCSoftwareVideoDecoder(
            createDependencies(secondBackend).dependencies
        );
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

    it('rejects in-band SPS dimensions before feeding the WASM decoder', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const dependencyHarness = createDependencies(backend);
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        const mutableDecoder = decoder as unknown as MutableDecoderContract;
        mutableDecoder.codec = 'hevc';
        mutableDecoder.config = {
            codec: 'hev1.2.4.L120.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            hardwareAcceleration: 'prefer-software'
        };
        mutableDecoder.onError = (): undefined => undefined;
        mutableDecoder.onSample = (sample: VideoSample): void => sample.close();
        await decoder.init();
        const packet = new EncodedPacket(
            createAnnexBPacket([ MAIN10_SPS, createNALUnit(19, [ 1 ]) ]),
            'key',
            0,
            0.04,
            0
        );

        expect(() => decoder.decode(packet)).toThrow('dimensions contradict');
        expect(backend.feed).not.toHaveBeenCalled();
        decoder.close();
    });

    it('rejects an in-band DPB above its level before feeding the WASM decoder', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const decoder = await createInBandUHDDecoder(backend, LEVEL_5_1_IN_BAND_CODEC_STRING);

        expect(() => decoder.decode(createInBandSPSPacket(LEVEL_5_1_DPB_7_UHD_MAIN10_SPS)))
            .toThrow(DPB_ABOVE_LEVEL_ERROR);
        expect(backend.feed).not.toHaveBeenCalled();
        decoder.close();
    });

    it('feeds an in-band DPB its level allows at any picture size', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const decoder = await createInBandUHDDecoder(backend, LEVEL_6_IN_BAND_CODEC_STRING);

        decoder.decode(createInBandSPSPacket(LEVEL_6_DPB_7_UHD_MAIN10_SPS));

        expect(backend.feed).toHaveBeenCalledOnce();
        decoder.close();
    });

    it('loads copied assets and passes the absolute WASM URL to the package', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const dependencyHarness = createDependencies(backend);
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        configureDecoder(decoder);

        await decoder.init();

        expect(dependencyHarness.loadDecoderGlue).toHaveBeenCalledWith(
            'https://example.test/web/libraries/hevcjs/hevc-decode.js'
        );
        expect(dependencyHarness.createDecoder).toHaveBeenCalledWith({
            wasmBinaryUrl: 'https://example.test/web/libraries/hevcjs/hevc-decode.wasm'
        });
        decoder.close();
    });

    it('prepends HVCC parameter sets and creates an exact copyable I420P10 sample', async () => {
        const backend = new FakeHEVCDecoderBackend({
            drainBatches: [ [ createFrame(10) ] ]
        });
        const dependencyHarness = createDependencies(backend);
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        configureDecoder(decoder, {
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            }
        });
        await decoder.init();

        decoder.decode(createEncodedPacket(1.25, 1 / 24, 7));

        expect(backend.feed).toHaveBeenCalledTimes(2);
        expect(Array.from(backend.feed.mock.calls[0][0])).toContain(64);
        expect(Array.from(backend.feed.mock.calls[1][0]).slice(0, 6)).toEqual([
            0, 0, 0, 1, 38, 1
        ]);
        expect(samples).toHaveLength(1);
        const sample = samples[0];
        expect(sample).toMatchObject({
            codedHeight: 360,
            codedWidth: 640,
            displayHeight: 9,
            displayWidth: 16,
            duration: 0.041666,
            format: 'I420P10',
            timestamp: 1.25
        });
        expect(sample.colorSpace.toJSON()).toEqual({
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'pq'
        });
        const destination = new Uint8Array(sample.allocationSize());
        const layouts = await sample.copyTo(destination);
        expect(layouts).toEqual([
            { offset: 0, stride: 1_280 },
            { offset: 460_800, stride: 640 },
            { offset: 576_000, stride: 640 }
        ]);
        const planarSamples = new Uint16Array(destination.buffer);
        expect(Array.from(planarSamples.subarray(0, 8))).toEqual([
            1, 2, 3, 4, 9, 10, 11, 12
        ]);
        expect(Array.from(planarSamples.subarray(230_400, 230_402))).toEqual([ 5, 6 ]);
        expect(Array.from(planarSamples.subarray(288_000, 288_002))).toEqual([ 7, 8 ]);
        sample.close();
        decoder.close();
    });

    it('keeps a container HLG transfer over an SPS that signals the BT.2020 10-bit transfer', async () => {
        const backend = new FakeHEVCDecoderBackend({
            drainBatches: [ [ createFrame(10) ] ]
        });
        const dependencyHarness = createDependencies(backend);
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
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

        decoder.decode(createEncodedPacket(0, 0.04, 0));

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
        const backend = new FakeHEVCDecoderBackend({
            drainBatches: [ [ createFrame(10) ] ]
        });
        const dependencyHarness = createDependencies(backend);
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
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

        decoder.decode(createEncodedPacket(0, 0.04, 0));

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
        const decoder = new HEVCSoftwareVideoDecoder(
            createDependencies(new FakeHEVCDecoderBackend()).dependencies
        );
        configureDecoder(decoder, {
            colorSpace: { fullRange: false, ...containerColor },
            sequenceParameterSet: MAIN10_SMPTE170M_SPS
        });

        expect(HEVCSoftwareVideoDecoder.supports(
            'hevc',
            (decoder as unknown as MutableDecoderContract).config
        )).toBe(false);
        decoder.close();
    });

    it('constructs I420 output for Main profile frames', async () => {
        const backend = new FakeHEVCDecoderBackend({
            drainBatches: [ [ createFrame(8) ] ],
            info: createStreamInfo(8)
        });
        const dependencyHarness = createDependencies(backend);
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        configureDecoder(decoder, {
            bitDepth: 8,
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            }
        });
        await decoder.init();

        decoder.decode(createEncodedPacket(0, 0.04, 0));

        expect(samples[0].format).toBe('I420');
        const destination = new Uint8Array(samples[0].allocationSize());
        await samples[0].copyTo(destination);
        expect(Array.from(destination.subarray(0, 8))).toEqual([
            1, 2, 3, 4, 9, 10, 11, 12
        ]);
        expect(Array.from(destination.subarray(4_096, 4_098))).toEqual([ 5, 6 ]);
        expect(Array.from(destination.subarray(5_120, 5_122))).toEqual([ 7, 8 ]);
        samples[0].close();
        decoder.close();
    });

    it('maps decoder display order to sorted packet timestamps and their durations', async () => {
        const backend = new FakeHEVCDecoderBackend({
            drainBatches: [ [], [ createFrame(10, 0), createFrame(10, 1) ] ]
        });
        const dependencyHarness = createDependencies(backend);
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        configureDecoder(decoder, {
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            }
        });
        await decoder.init();

        decoder.decode(createEncodedPacket(2, 0.05, 10));
        decoder.decode(createEncodedPacket(1, 0.04, 11));

        expect(samples.map((sample: VideoSample): number => sample.timestamp)).toEqual([ 1, 2 ]);
        expect(samples.map((sample: VideoSample): number => sample.duration)).toEqual([ 0.04, 0.05 ]);
        for (const sample of samples) {
            sample.close();
        }
        decoder.close();
    });

    it('emits DPB frames on flush and primes parameter sets for a later decode group', async () => {
        const backend = new FakeHEVCDecoderBackend({
            drainBatches: [ [], [] ],
            flushFrames: [ createFrame(10) ]
        });
        const dependencyHarness = createDependencies(backend);
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        configureDecoder(decoder, {
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            }
        });
        await decoder.init();

        decoder.decode(createEncodedPacket(0, 0.04, 0));
        backend.flush.mockImplementationOnce((frameHandler: HEVCDecodedFrameHandler): number => {
            backend.info = null;
            return emitBackendFrames([ createFrame(10) ], frameHandler);
        });
        decoder.flush();
        backend.flush.mockImplementationOnce((frameHandler: HEVCDecodedFrameHandler): number => (
            emitBackendFrames([ createFrame(10, 1) ], frameHandler)
        ));
        decoder.decode(createEncodedPacket(1, 0.04, 1));
        decoder.flush();

        expect(backend.feed).toHaveBeenCalledTimes(4);
        expect(samples.map((sample: VideoSample): number => sample.timestamp)).toEqual([ 0, 1 ]);
        for (const sample of samples) {
            sample.close();
        }
        decoder.close();
    });

    it('bounds pending reorder metadata and rejects frames without timing', async () => {
        const backend = new FakeHEVCDecoderBackend();
        const dependencyHarness = createDependencies(backend);
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        configureDecoder(decoder);
        await decoder.init();

        for (
            let packetIndex = 0;
            packetIndex < MAXIMUM_HEVC_PENDING_PICTURE_COUNT;
            packetIndex += 1
        ) {
            decoder.decode(createEncodedPacket(packetIndex, 0.04, packetIndex));
        }
        expect(() => decoder.decode(createEncodedPacket(65, 0.04, 65))).toThrow(
            'reorder window exceeded'
        );
        expect(() => decoder.flush()).toThrow('ended before every picture was output');
        decoder.close();

        const extraFrameBackend = new FakeHEVCDecoderBackend({
            drainBatches: [ [ createFrame(10), createFrame(10, 1) ] ]
        });
        const secondDependencyHarness = createDependencies(extraFrameBackend);
        const secondDecoder = new HEVCSoftwareVideoDecoder(secondDependencyHarness.dependencies);
        configureDecoder(secondDecoder);
        await secondDecoder.init();
        expect(() => secondDecoder.decode(createEncodedPacket(0, 0.04, 0))).toThrow(
            'without packet timing'
        );
        secondDecoder.close();
    });

    it('rejects decoded frame and stream dimensions that contradict the active SPS', async () => {
        const mismatchedFrame = createFrame(10);
        mismatchedFrame.width -= 2;
        const backend = new FakeHEVCDecoderBackend({
            drainBatches: [ [ mismatchedFrame ] ],
            info: {
                ...createStreamInfo(10),
                height: 1_080,
                width: 1_920
            }
        });
        const dependencyHarness = createDependencies(backend);
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        configureDecoder(decoder);
        await decoder.init();

        expect(() => decoder.decode(createEncodedPacket(0, 0.04, 0))).toThrow(
            'contradicts the active SPS'
        );
        decoder.close();
    });

    it('closes a rejected sample and destroys backend resources exactly once', async () => {
        const backend = new FakeHEVCDecoderBackend({
            drainBatches: [ [ createFrame(10) ] ]
        });
        const dependencyHarness = createDependencies(backend);
        let rejectedSample: VideoSample | null = null;
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        configureDecoder(decoder, {
            onSample: (sample: VideoSample): never => {
                rejectedSample = sample;
                throw new Error('consumer failed');
            }
        });
        await decoder.init();

        expect(() => decoder.decode(createEncodedPacket(0, 0.04, 0))).toThrow('consumer failed');
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
        const dependencyHarness = createDependencies(backend);
        const onError = vi.fn((): undefined => undefined);
        const decoder = new HEVCSoftwareVideoDecoder(dependencyHarness.dependencies);
        configureDecoder(decoder, { onError });
        await decoder.init();

        decoder.close();

        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'destroy failed' }));
    });
});
