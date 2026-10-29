import { EncodedPacket } from 'mediabunny';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import OwnedNativeHEVCVideoDecoder, {
    type OwnedNativeHEVCVideoDecoderDependencies
} from 'webgpu-player/decode/video/native/OwnedNativeHEVCVideoDecoder';
import type { NativeVideoDecoderPort } from 'webgpu-player/decode/video/native/OwnedNativeVideoDecoder';
import { parseHEVCNALUnits } from 'webgpu-player/demux/dolby-vision/DolbyVisionHEVCSplitter';
import { parseHEVCSPS } from 'webgpu-player/demux/hevc/HEVCSPSParser';

import { createBytesFromHex } from '../../../helpers/byteArrays';
import { FakeNativeVideoDecoder } from '../../../helpers/fakeNativeVideoDecoder';
import { createNALUnit, encodeAnnexBNALUnits } from '../../../helpers/hevcNALUnits';

const MAIN10_PQ_SPS = createBytesFromHex(
    '4201010220000003009000000300000300ffa005020169365959a4932bc05a848804820000030002000003000210'
);
// A Main10 SPS whose VUI signals BT.2020 primaries and matrix with the BT.2020 10-bit transfer, as HLG-compatible streams do
const MAIN10_BT2020_10_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05a848704820000030002000003003010'
);
// A Main10 PQ SPS that sets video_full_range_flag
const MAIN10_FULL_RANGE_PQ_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05b848804820000030002000003003010'
);
// An old x265 build's Main 10 SDR SPS without default_display_window_flag, and the SPS FFmpeg's reading of it implies
const X265_MISSING_DEFAULT_DISPLAY_WINDOW_SPS = createBytesFromHex(
    '420101022000000300900000030000030096a001e0200649f4d96666924c2e02000007d20000bb8010'
);
const X265_REPAIRED_DEFAULT_DISPLAY_WINDOW_SPS = createBytesFromHex(
    '420101022000000300900000030000030096a001e0200649f4d96666924c2e0100000303e900005dc008'
);
const ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE = 147;
const HLG_TRANSFER_CHARACTERISTICS = 18;
const PQ_TRANSFER_CHARACTERISTICS = 16;
const NEUTRAL_COLOR_SPACE = {
    fullRange: false,
    matrix: 'bt709',
    primaries: 'bt709',
    transfer: 'bt709'
};

/** Creates a prefix SEI NAL unit with one alternative transfer characteristics message. */
function createAlternativeTransferSEI(preferredTransferCharacteristics: number): Uint8Array {
    return createNALUnit(39, [
        ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE,
        1,
        preferredTransferCharacteristics,
        0x80
    ]);
}

function createNeutralizingDecoder(
    harness: DecoderHarness,
    nativeHDRTransfer: 'hlg' | 'pq'
): OwnedNativeHEVCVideoDecoder {
    return new OwnedNativeHEVCVideoDecoder(
        { codec: 'hvc1.2.4.L120.B0', codedHeight: 1_080, codedWidth: 1_920 },
        { kind: 'annex-b' },
        { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
        harness.dependencies,
        { nativeHDRTransfer, neutralizeHDRColorMetadata: true }
    );
}

function encodeLengthPrefixedNALUnits(nalUnits: readonly Uint8Array[]): Uint8Array {
    const lengthByteLength = 4;
    const byteLength = nalUnits.reduce(
        (totalByteLength: number, nalUnit: Uint8Array): number => (
            totalByteLength + lengthByteLength + nalUnit.byteLength
        ),
        0
    );
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const nalUnit of nalUnits) {
        let remainingLength = nalUnit.byteLength;
        for (let byteIndex = lengthByteLength - 1; byteIndex >= 0; byteIndex -= 1) {
            output[offset + byteIndex] = remainingLength % 256;
            remainingLength = Math.floor(remainingLength / 256);
        }
        offset += lengthByteLength;
        output.set(nalUnit, offset);
        offset += nalUnit.byteLength;
    }
    return output;
}

function getFirstAnnexBNALUnit(accessUnit: Uint8Array): Uint8Array {
    for (let offset = 4; offset + 4 <= accessUnit.byteLength; offset += 1) {
        if (
            accessUnit[offset] === 0
            && accessUnit[offset + 1] === 0
            && accessUnit[offset + 2] === 0
            && accessUnit[offset + 3] === 1
        ) {
            return accessUnit.subarray(4, offset);
        }
    }
    throw new TypeError('The test access unit has no second Annex B start code');
}

function getFirstLengthPrefixedNALUnit(accessUnit: Uint8Array): Uint8Array {
    const lengthByteLength = 4;
    let nalUnitByteLength = 0;
    for (let byteIndex = 0; byteIndex < lengthByteLength; byteIndex += 1) {
        nalUnitByteLength = (nalUnitByteLength * 256) + accessUnit[byteIndex];
    }
    return accessUnit.subarray(
        lengthByteLength,
        lengthByteLength + nalUnitByteLength
    );
}

function createPacket(data: Uint8Array, sequenceNumber: number): EncodedPacket {
    return new EncodedPacket(data, 'key', sequenceNumber / 24, 1 / 24, sequenceNumber);
}

function createSPSFreeHVCCDescription(): Uint8Array {
    const description = new Uint8Array(23);
    description[0] = 1;
    description[21] = 3;
    return description;
}

class FakeVideoFrame {
    public readonly codedHeight = 1_080;
    public readonly codedWidth = 1_920;
    public readonly colorSpace = {
        fullRange: false,
        matrix: 'bt2020-ncl',
        primaries: 'bt2020',
        transfer: 'pq'
    };
    public readonly displayHeight = 1_080;
    public readonly displayWidth = 1_920;
    public readonly duration = 41_667;
    public readonly format = 'I420P10';
    public readonly timestamp = 1_000_000;
    public readonly visibleRect = { height: 1_080, width: 1_920, x: 0, y: 0 };
    public readonly close = vi.fn();
}

type DecoderHarness = {
    decoder: FakeNativeVideoDecoder
    dependencies: OwnedNativeHEVCVideoDecoderDependencies
    init: VideoDecoderInit | null
    packets: EncodedPacket[]
    transferableData: boolean[]
};

function createHarness(): DecoderHarness {
    const harness: DecoderHarness = {
        decoder: new FakeNativeVideoDecoder(),
        dependencies: null as unknown as OwnedNativeHEVCVideoDecoderDependencies,
        init: null,
        packets: [],
        transferableData: []
    };
    harness.dependencies = {
        createDecoder: (init: VideoDecoderInit): NativeVideoDecoderPort => {
            harness.init = init;
            return harness.decoder;
        },
        createEncodedVideoChunk: (packet: EncodedPacket, transferableData: boolean): EncodedVideoChunk => {
            harness.packets.push(packet);
            harness.transferableData.push(transferableData);
            return { packet } as unknown as EncodedVideoChunk;
        }
    };
    return harness;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('OwnedNativeHEVCVideoDecoder', () => {
    it('configures one owned decoder and reports dequeue progress', async () => {
        const harness = createHarness();
        const onProgress = vi.fn();
        const config: VideoDecoderConfig = { codec: 'hvc1.2.4.L153.B0' };
        const decoder = new OwnedNativeHEVCVideoDecoder(
            config,
            { kind: 'annex-b' },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress },
            harness.dependencies
        );

        await decoder.init();
        expect(harness.decoder.configure).toHaveBeenCalledWith(config);
        harness.decoder.decodeQueueSize = 3;
        expect(decoder.getDecodeQueueSize()).toBe(3);
        harness.decoder.ondequeue?.(new Event('dequeue'));
        expect(onProgress).toHaveBeenCalledOnce();
        decoder.close();
        decoder.close();
        expect(harness.decoder.close).toHaveBeenCalledOnce();
    });

    it('surfaces a codec error and never closes a codec WebCodecs already closed', async () => {
        const harness = createHarness();
        const onError = vi.fn();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            { onError, onFrame: vi.fn(), onProgress: vi.fn() },
            harness.dependencies
        );
        await decoder.init();
        const codecError = new DOMException('Decoding error.', 'EncodingError');
        harness.decoder.state = 'closed';
        harness.init?.error(codecError);

        expect(onError).toHaveBeenCalledWith(codecError);
        let thrownError: unknown = null;
        try {
            decoder.decode(createPacket(new Uint8Array([0, 0, 1, 0x26, 0x01]), 0));
        } catch (error) {
            thrownError = error;
        }
        expect(thrownError).toBe(codecError);
        expect(harness.decoder.decode).not.toHaveBeenCalled();
        await expect(decoder.flush()).rejects.toBe(codecError);
        expect(() => decoder.close()).not.toThrow();
        expect(harness.decoder.close).not.toHaveBeenCalled();
    });

    it('keeps codec reclamation identifiable by its error name', async () => {
        const harness = createHarness();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            harness.dependencies
        );
        await decoder.init();
        harness.decoder.state = 'closed';
        harness.init?.error(new DOMException('Codec reclaimed due to inactivity.', 'QuotaExceededError'));

        let thrownError: unknown = null;
        try {
            decoder.decode(createPacket(new Uint8Array([0, 0, 1, 0x26, 0x01]), 0));
        } catch (error) {
            thrownError = error;
        }
        expect((thrownError as DOMException).name).toBe('QuotaExceededError');
    });

    it('sanitizes the first access unit and drops leading RASL pictures', async () => {
        const harness = createHarness();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            harness.dependencies
        );
        await decoder.init();
        const picture = createNALUnit(19, [ 1 ]);
        const lateParameterSet = createNALUnit(32, [ 2 ]);

        expect(decoder.decode(createPacket(
            encodeAnnexBNALUnits([ picture, lateParameterSet ]),
            0
        ))).toBe(true);
        expect(decoder.decode(createPacket(
            encodeAnnexBNALUnits([ createNALUnit(8, [ 3 ]) ]),
            1
        ))).toBe(false);
        expect(decoder.decode(createPacket(
            encodeAnnexBNALUnits([ createNALUnit(1, [ 4 ]) ]),
            2
        ))).toBe(true);

        expect(harness.packets).toHaveLength(2);
        expect(harness.packets[0].data).toEqual(encodeAnnexBNALUnits([ picture ]));
        expect(harness.packets[1].sequenceNumber).toBe(2);
        decoder.close();
    });

    it('transfers the data it rewrites, and unchanged data only as its caller allows', async () => {
        const harness = createHarness();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            harness.dependencies
        );
        await decoder.init();
        const picture = createNALUnit(19, [ 1 ]);
        const lateParameterSet = createNALUnit(32, [ 2 ]);
        const unchangedPacket = createPacket(encodeAnnexBNALUnits([ createNALUnit(1, [ 3 ]) ]), 1);

        // The first access unit is sanitized into a new buffer
        decoder.decode(createPacket(encodeAnnexBNALUnits([ picture, lateParameterSet ]), 0), false);
        decoder.decode(unchangedPacket, false);
        decoder.decode(unchangedPacket, true);

        expect(harness.transferableData).toEqual([ true, false, true ]);
        expect(harness.packets[1]).toBe(unchangedPacket);
        decoder.close();
    });

    it('restores a missing default_display_window_flag in the HVCC and in band without HDR neutralization', async () => {
        const harness = createHarness();
        const createDescription = (sequenceParameterSet: Uint8Array): Uint8Array => {
            const description = createSPSFreeHVCCDescription();
            return Uint8Array.from([
                ...description.subarray(0, 22),
                1,
                0x80 | 33,
                0,
                1,
                0,
                sequenceParameterSet.byteLength,
                ...sequenceParameterSet
            ]);
        };
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L150.B0', description: createDescription(X265_MISSING_DEFAULT_DISPLAY_WINDOW_SPS) },
            { kind: 'annex-b' },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            harness.dependencies
        );
        await decoder.init();
        expect(harness.decoder.configure).toHaveBeenCalledWith({
            codec: 'hvc1.2.4.L150.B0',
            description: createDescription(X265_REPAIRED_DEFAULT_DISPLAY_WINDOW_SPS)
        });

        const picture = createNALUnit(19, [ 1 ]);
        expect(decoder.decode(createPacket(encodeAnnexBNALUnits([ X265_MISSING_DEFAULT_DISPLAY_WINDOW_SPS, picture ]), 0))).toBe(true);
        const packetWithIntactSPS = createPacket(encodeAnnexBNALUnits([ MAIN10_PQ_SPS, createNALUnit(21, [ 2 ]) ]), 1);
        expect(decoder.decode(packetWithIntactSPS)).toBe(true);
        expect(harness.packets[0].data).toEqual(encodeAnnexBNALUnits([ X265_REPAIRED_DEFAULT_DISPLAY_WINDOW_SPS, picture ]));
        expect(harness.packets[1]).toBe(packetWithIntactSPS);
        decoder.close();
    });

    it('neutralizes decoder and in-band HDR color metadata when requested', async () => {
        const harness = createHarness();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L120.B0', codedHeight: 1_080, codedWidth: 1_920 },
            { kind: 'annex-b' },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            harness.dependencies,
            { nativeHDRTransfer: 'pq', neutralizeHDRColorMetadata: true }
        );
        await decoder.init();

        expect(harness.decoder.configure).toHaveBeenCalledWith(expect.objectContaining({
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            }
        }));

        const originalData = encodeAnnexBNALUnits([
            MAIN10_PQ_SPS,
            createNALUnit(19, [ 1 ])
        ]);
        expect(decoder.decode(createPacket(originalData, 0))).toBe(true);
        expect(harness.packets).toHaveLength(1);
        expect(harness.packets[0].data).not.toBe(originalData);
        expect(parseHEVCSPS(getFirstAnnexBNALUnit(harness.packets[0].data)).colorSpace)
            .toEqual({
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            });
        decoder.close();
    });

    it('defers SPS validation from an SPS-free HVCC record to the first key packet', async () => {
        const harness = createHarness();
        const description = createSPSFreeHVCCDescription();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            {
                codec: 'hvc1.2.4.L120.B0',
                codedHeight: 1_080,
                codedWidth: 1_920,
                description
            },
            { kind: 'length-prefixed', lengthSize: 4 },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            harness.dependencies,
            { nativeHDRTransfer: 'pq', neutralizeHDRColorMetadata: true }
        );
        await decoder.init();

        expect(harness.decoder.configure).toHaveBeenCalledWith(expect.objectContaining({
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            description: expect.any(Uint8Array)
        }));
        const originalData = encodeLengthPrefixedNALUnits([
            MAIN10_PQ_SPS,
            createNALUnit(19, [ 1 ])
        ]);
        expect(decoder.decode(createPacket(originalData, 0))).toBe(true);
        expect(parseHEVCSPS(getFirstLengthPrefixedNALUnit(harness.packets[0].data)).colorSpace)
            .toEqual({
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            });
        decoder.close();
    });

    it('neutralizes length-prefixed key SPS and preserves a key packet without SPS', async () => {
        const harness = createHarness();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L120.B0', codedHeight: 1_080, codedWidth: 1_920 },
            { kind: 'length-prefixed', lengthSize: 4 },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            harness.dependencies,
            { nativeHDRTransfer: 'pq', neutralizeHDRColorMetadata: true }
        );
        await decoder.init();

        const packetWithSPS = createPacket(encodeLengthPrefixedNALUnits([
            MAIN10_PQ_SPS,
            createNALUnit(19, [ 1 ])
        ]), 0);
        const packetWithoutSPS = createPacket(
            encodeLengthPrefixedNALUnits([ createNALUnit(19, [ 2 ]) ]),
            1
        );
        expect(decoder.decode(packetWithSPS)).toBe(true);
        expect(decoder.decode(packetWithoutSPS)).toBe(true);

        expect(parseHEVCSPS(getFirstLengthPrefixedNALUnit(harness.packets[0].data)).colorSpace)
            .toEqual({
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            });
        expect(harness.packets[1]).toBe(packetWithoutSPS);
        decoder.close();
    });

    it('neutralizes the SPS of a delta packet and passes a delta packet without one unchanged', async () => {
        const harness = createHarness();
        const decoder = createNeutralizingDecoder(harness, 'pq');
        await decoder.init();
        expect(decoder.decode(createPacket(encodeAnnexBNALUnits([ MAIN10_PQ_SPS, createNALUnit(19, [ 1 ]) ]), 0))).toBe(true);

        // A CRA with its parameter sets that the container's sync-sample table does not list
        const deltaPacketWithSPS = new EncodedPacket(
            encodeAnnexBNALUnits([ createNALUnit(32, [ 1 ]), MAIN10_PQ_SPS, createNALUnit(21, [ 2 ]) ]),
            'delta',
            1 / 24,
            1 / 24,
            1
        );
        const deltaPacketWithoutSPS = new EncodedPacket(encodeAnnexBNALUnits([ createNALUnit(1, [ 3 ]) ]), 'delta', 2 / 24, 1 / 24, 2);
        expect(decoder.decode(deltaPacketWithSPS)).toBe(true);
        expect(decoder.decode(deltaPacketWithoutSPS)).toBe(true);

        expect(harness.packets).toHaveLength(3);
        expect(harness.packets[1].type).toBe('delta');
        expect(harness.packets[1].data).not.toBe(deltaPacketWithSPS.data);
        const rewrittenSPS = parseHEVCNALUnits(harness.packets[1].data, { kind: 'annex-b' })
            .find(nalUnit => nalUnit.type === 33);
        expect(rewrittenSPS && parseHEVCSPS(rewrittenSPS.data).colorSpace).toEqual(NEUTRAL_COLOR_SPACE);
        expect(harness.packets[2]).toBe(deltaPacketWithoutSPS);
        decoder.close();
    });

    it('refuses a delta packet whose SPS does not prove the route', async () => {
        const harness = createHarness();
        const decoder = createNeutralizingDecoder(harness, 'pq');
        await decoder.init();
        expect(decoder.decode(createPacket(encodeAnnexBNALUnits([ MAIN10_PQ_SPS, createNALUnit(19, [ 1 ]) ]), 0))).toBe(true);
        expect(() => decoder.decode(new EncodedPacket(
            encodeAnnexBNALUnits([ MAIN10_BT2020_10_SPS, createNALUnit(21, [ 2 ]) ]),
            'delta',
            1 / 24,
            1 / 24,
            1
        ))).toThrow('expected BT.2020 HDR route');
        expect(harness.packets).toHaveLength(1);
        decoder.close();
    });

    it('decodes a full-range PQ SPS on the PQ route, neutralized at its own range', async () => {
        const harness = createHarness();
        const decoder = createNeutralizingDecoder(harness, 'pq');
        await decoder.init();
        expect(decoder.decode(createPacket(encodeAnnexBNALUnits([ MAIN10_FULL_RANGE_PQ_SPS, createNALUnit(19, [ 1 ]) ]), 0))).toBe(true);
        expect(parseHEVCSPS(getFirstAnnexBNALUnit(harness.packets[0].data)).colorSpace).toEqual({ ...NEUTRAL_COLOR_SPACE, fullRange: true });
        decoder.close();
    });

    it('rejects native HDR packets before an exact SPS proves the route', async () => {
        const missingSPSHarness = createHarness();
        const missingSPSDecoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L120.B0', codedHeight: 1_080, codedWidth: 1_920 },
            { kind: 'annex-b' },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            missingSPSHarness.dependencies,
            { nativeHDRTransfer: 'pq', neutralizeHDRColorMetadata: true }
        );
        await missingSPSDecoder.init();
        expect(() => missingSPSDecoder.decode(createPacket(
            encodeAnnexBNALUnits([ createNALUnit(19, [ 1 ]) ]),
            0
        ))).toThrow('validated HEVC SPS');
        expect(missingSPSHarness.packets).toHaveLength(0);
        missingSPSDecoder.close();

        const mismatchedTransferHarness = createHarness();
        const mismatchedTransferDecoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L120.B0', codedHeight: 1_080, codedWidth: 1_920 },
            { kind: 'annex-b' },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            mismatchedTransferHarness.dependencies,
            { nativeHDRTransfer: 'hlg', neutralizeHDRColorMetadata: true }
        );
        await mismatchedTransferDecoder.init();
        expect(() => mismatchedTransferDecoder.decode(createPacket(
            encodeAnnexBNALUnits([ MAIN10_PQ_SPS, createNALUnit(19, [ 1 ]) ]),
            0
        ))).toThrow('expected BT.2020 HDR route');
        expect(mismatchedTransferHarness.packets).toHaveLength(0);
        mismatchedTransferDecoder.close();
    });

    it('proves an HLG-compatible key SPS on the HLG route with or without its SEI', async () => {
        const accessUnits = [
            encodeAnnexBNALUnits([
                MAIN10_BT2020_10_SPS,
                createAlternativeTransferSEI(HLG_TRANSFER_CHARACTERISTICS),
                createNALUnit(19, [ 1 ])
            ]),
            encodeAnnexBNALUnits([ MAIN10_BT2020_10_SPS, createNALUnit(19, [ 1 ]) ])
        ];
        for (const accessUnit of accessUnits) {
            const harness = createHarness();
            const decoder = createNeutralizingDecoder(harness, 'hlg');
            await decoder.init();

            expect(decoder.decode(createPacket(accessUnit, 0))).toBe(true);
            expect(parseHEVCSPS(getFirstAnnexBNALUnit(harness.packets[0].data)).colorSpace)
                .toEqual(NEUTRAL_COLOR_SPACE);
            decoder.close();
        }
    });

    it('routes an HLG-compatible key SPS by the transfer its SEI names', async () => {
        const accessUnit = encodeAnnexBNALUnits([
            MAIN10_BT2020_10_SPS,
            createAlternativeTransferSEI(PQ_TRANSFER_CHARACTERISTICS),
            createNALUnit(19, [ 1 ])
        ]);
        const hlgHarness = createHarness();
        const hlgDecoder = createNeutralizingDecoder(hlgHarness, 'hlg');
        await hlgDecoder.init();
        const pqHarness = createHarness();
        const pqDecoder = createNeutralizingDecoder(pqHarness, 'pq');
        await pqDecoder.init();

        expect(() => hlgDecoder.decode(createPacket(accessUnit, 0)))
            .toThrow('expected BT.2020 HDR route');
        expect(hlgHarness.packets).toHaveLength(0);
        expect(pqDecoder.decode(createPacket(accessUnit, 0))).toBe(true);
        expect(pqHarness.packets).toHaveLength(1);
        hlgDecoder.close();
        pqDecoder.close();
    });

    it('treats a malformed key SEI as absent, so the SPS VUI alone must prove the route', async () => {
        // The message declares a one-byte payload that the NAL unit does not carry
        const malformedSEI = createNALUnit(39, [ ALTERNATIVE_TRANSFER_CHARACTERISTICS_PAYLOAD_TYPE, 1 ]);
        const accessUnit = encodeAnnexBNALUnits([
            MAIN10_BT2020_10_SPS,
            malformedSEI,
            createNALUnit(19, [ 1 ])
        ]);
        const hlgHarness = createHarness();
        const hlgDecoder = createNeutralizingDecoder(hlgHarness, 'hlg');
        await hlgDecoder.init();
        const pqHarness = createHarness();
        const pqDecoder = createNeutralizingDecoder(pqHarness, 'pq');
        await pqDecoder.init();

        expect(hlgDecoder.decode(createPacket(accessUnit, 0))).toBe(true);
        expect(() => pqDecoder.decode(createPacket(accessUnit, 0)))
            .toThrow('expected BT.2020 HDR route');
        hlgDecoder.close();
        pqDecoder.close();
    });

    it('transfers native frame ownership directly and closes stale callbacks', async () => {
        vi.stubGlobal('VideoFrame', FakeVideoFrame);
        const harness = createHarness();
        const frames: VideoFrame[] = [];
        const onProgress = vi.fn();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            {
                onError: vi.fn(),
                onFrame: (frame: VideoFrame): void => {
                    frames.push(frame);
                },
                onProgress
            },
            harness.dependencies
        );
        await decoder.init();
        const firstFrame = new FakeVideoFrame();

        harness.init?.output(firstFrame as unknown as VideoFrame);
        expect(frames).toEqual([ firstFrame ]);
        frames[0].close();
        expect(firstFrame.close).toHaveBeenCalledOnce();
        expect(onProgress).toHaveBeenCalledOnce();

        decoder.close();
        const staleFrame = new FakeVideoFrame();
        harness.init?.output(staleFrame as unknown as VideoFrame);
        expect(staleFrame.close).toHaveBeenCalledOnce();
        expect(frames).toHaveLength(1);
    });

    it('closes failed output ownership when the frame callback rejects it', async () => {
        vi.stubGlobal('VideoFrame', FakeVideoFrame);
        const harness = createHarness();
        const outputError = new Error('frame rejected');
        const onError = vi.fn();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            {
                onError,
                onFrame: (): never => {
                    throw outputError;
                },
                onProgress: vi.fn()
            },
            harness.dependencies
        );
        await decoder.init();
        const frame = new FakeVideoFrame();

        harness.init?.output(frame as unknown as VideoFrame);

        expect(frame.close).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(outputError);
        decoder.close();
    });

    it('closes a decoder whose initial configuration fails', async () => {
        const harness = createHarness();
        const configurationError = new Error('configuration failed');
        harness.decoder.configure.mockImplementation((): never => {
            throw configurationError;
        });
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            harness.dependencies
        );

        await expect(decoder.init()).rejects.toBe(configurationError);
        expect(harness.decoder.ondequeue).toBeNull();
        expect(harness.decoder.close).toHaveBeenCalledOnce();
        decoder.close();
        expect(harness.decoder.close).toHaveBeenCalledOnce();
    });

    it('resets packet sanitization and RASL state after flush', async () => {
        const harness = createHarness();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            harness.dependencies
        );
        await decoder.init();
        const picture = createNALUnit(19, [ 1 ]);
        const lateParameterSet = createNALUnit(32, [ 2 ]);
        const firstPacket = createPacket(
            encodeAnnexBNALUnits([ picture, lateParameterSet ]),
            0
        );

        expect(decoder.decode(firstPacket)).toBe(true);
        expect(decoder.decode(createPacket(
            encodeAnnexBNALUnits([ createNALUnit(8, [ 3 ]) ]),
            1
        ))).toBe(false);
        await decoder.flush();
        expect(decoder.decode(firstPacket)).toBe(true);

        expect(harness.decoder.flush).toHaveBeenCalledOnce();
        expect(harness.packets).toHaveLength(2);
        expect(harness.packets[0].data).toEqual(encodeAnnexBNALUnits([ picture ]));
        expect(harness.packets[1].data).toEqual(encodeAnnexBNALUnits([ picture ]));
        decoder.close();
    });
});
