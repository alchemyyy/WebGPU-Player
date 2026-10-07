import {
    ALL_FORMATS,
    BufferSource,
    BufferTarget,
    EncodedPacket,
    EncodedVideoPacketSource,
    Input,
    Mp4OutputFormat,
    Output,
    type InputVideoTrack,
    type VideoCodec
} from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import {
    assignISOBaseMediaDolbyVisionSampleEntryCodec
} from 'webgpu-player/video/dolby-vision/ISOBaseMediaDolbyVisionSampleEntry';

type FakeVideoTrackInfo = {
    avcType: 1 | 3 | null
    codec: string | null
    codecDescription: unknown
    type: string
};

type FakeVideoTrack = {
    info: FakeVideoTrackInfo
    track: InputVideoTrack
};

// Main 10, Main tier, level 5.1, four-byte NAL lengths, and no parameter-set arrays
const HEVC_CONFIGURATION = new Uint8Array([
    1, 0x02, 0x20, 0x00, 0x00, 0x00, 0xB0, 0, 0, 0, 0, 0, 153,
    0xF0, 0x00, 0xFC, 0xFD, 0xFA, 0xFA, 0x00, 0x00, 0x0F, 0x00
]);
// High profile, level 4.0, four-byte NAL lengths, and no parameter sets
const AVC_CONFIGURATION = new Uint8Array([ 1, 0x64, 0x00, 0x28, 0xFF, 0xE0, 0x00 ]);
// The DOM library predates the BT.2020 and PQ color space values that WebCodecs and Mediabunny accept
const BT2020_PQ_COLOR_SPACE = {
    fullRange: false,
    matrix: 'bt2020-ncl',
    primaries: 'bt2020',
    transfer: 'pq'
} as unknown as VideoColorSpaceInit;
const PACKET_DATA = new Uint8Array([ 0, 0, 0, 3, 19 << 1, 1, 0xAF ]);
// The stsd type is followed by its version and flags, its entry count, and the entry's size
const SAMPLE_ENTRY_TYPE_OFFSET_FROM_STSD_TYPE = 16;

function createFakeTrack(
    internalCodecID: unknown,
    infoOverrides: Partial<FakeVideoTrackInfo> = {}
): FakeVideoTrack {
    const info: FakeVideoTrackInfo = {
        avcType: null,
        codec: null,
        codecDescription: HEVC_CONFIGURATION.slice(),
        type: 'video',
        ...infoOverrides
    };
    const track = {
        _backing: {
            internalTrack: {
                info,
                internalCodecId: internalCodecID
            }
        },
        getInternalCodecId: async (): Promise<unknown> => internalCodecID
    } as unknown as InputVideoTrack;
    return { info, track };
}

function encodeFourCC(value: string): Uint8Array {
    return new Uint8Array(Array.from(value, (character: string): number => character.charCodeAt(0)));
}

function findFourCC(data: Uint8Array, value: string): number {
    const fourCC = encodeFourCC(value);
    for (let offset = 0; offset + fourCC.byteLength <= data.byteLength; offset += 1) {
        if (fourCC.every((byteValue: number, index: number): boolean => data[offset + index] === byteValue)) {
            return offset;
        }
    }
    throw new Error(`The MP4 vector has no ${value} box`);
}

async function createMP4(
    codec: VideoCodec,
    decoderConfig: VideoDecoderConfig
): Promise<Uint8Array> {
    const target = new BufferTarget();
    const output = new Output({
        format: new Mp4OutputFormat(),
        target
    });
    const source = new EncodedVideoPacketSource(codec);
    output.addVideoTrack(source);
    await output.start();
    await source.add(new EncodedPacket(PACKET_DATA, 'key', 0, 1 / 24), { decoderConfig });
    source.close();
    await output.finalize();
    if (!target.buffer) {
        throw new Error('Mediabunny did not finalize the MP4 vector');
    }
    return new Uint8Array(target.buffer);
}

/** Rewrites the only sample entry type, as a Dolby Vision muxer writes it. */
async function createDolbyVisionMP4(
    codec: VideoCodec,
    decoderConfig: VideoDecoderConfig,
    baseSampleEntryType: string,
    dolbyVisionSampleEntryType: string
): Promise<Uint8Array> {
    const data = await createMP4(codec, decoderConfig);
    const sampleEntryTypeOffset = findFourCC(data, 'stsd') + SAMPLE_ENTRY_TYPE_OFFSET_FROM_STSD_TYPE;
    expect(Array.from(data.subarray(sampleEntryTypeOffset, sampleEntryTypeOffset + 4)))
        .toEqual(Array.from(encodeFourCC(baseSampleEntryType)));
    data.set(encodeFourCC(dolbyVisionSampleEntryType), sampleEntryTypeOffset);
    return data;
}

async function withPrimaryVideoTrack(
    data: Uint8Array,
    inspect: (track: InputVideoTrack) => Promise<void>
): Promise<void> {
    const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(data)
    });
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) {
            throw new Error('The MP4 vector has no video track');
        }
        await inspect(track);
    } finally {
        input.dispose();
    }
}

/** Opens a Dolby Vision vector and proves that Mediabunny itself leaves its sample entry unmapped. */
async function withDolbyVisionVideoTrack(
    data: Uint8Array,
    sampleEntryType: string,
    inspect: (track: InputVideoTrack) => Promise<void>
): Promise<void> {
    const consoleWarning = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
    await withPrimaryVideoTrack(data, async (track: InputVideoTrack): Promise<void> => {
        expect(consoleWarning).toHaveBeenCalledWith(
            `Unsupported video codec (sample entry type '${sampleEntryType}').`
        );
        expect(await track.getInternalCodecId()).toBe(sampleEntryType);
        expect(await track.getCodec()).toBeNull();
        expect(await track.getDecoderConfig()).toBeNull();
        await inspect(track);
    });
}

function toBytes(description: AllowSharedBufferSource | undefined): number[] {
    if (!ArrayBuffer.isView(description)) {
        throw new TypeError('The decoder configuration has no description view');
    }
    return Array.from(new Uint8Array(
        description.buffer,
        description.byteOffset,
        description.byteLength
    ));
}

describe('assignISOBaseMediaDolbyVisionSampleEntryCodec', () => {
    it.each([
        { avcType: null, codec: 'hevc', sampleEntryType: 'dvh1' },
        { avcType: null, codec: 'hevc', sampleEntryType: 'dvhe' },
        { avcType: 1, codec: 'avc', sampleEntryType: 'dva1' },
        { avcType: 3, codec: 'avc', sampleEntryType: 'dvav' },
        { avcType: null, codec: 'av1', sampleEntryType: 'dav1' }
    ])('reads a $sampleEntryType sample entry as $codec', async ({ avcType, codec, sampleEntryType }) => {
        const { info, track } = createFakeTrack(sampleEntryType);

        await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(track)).resolves.toBe(true);

        expect(info.codec).toBe(codec);
        expect(info.avcType).toBe(avcType);
    });

    it('compares sample entry types in lowercase like Mediabunny', async () => {
        const { info, track } = createFakeTrack('DVHE');

        await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(track)).resolves.toBe(true);
        expect(info.codec).toBe('hevc');
    });

    it.each([ 'hvc1', 'encv', 'mp4v', 'V_MPEGH/ISO/HEVC', 36, null ])(
        'leaves a track with internal codec ID %s unchanged',
        async (internalCodecID: unknown) => {
            const { info, track } = createFakeTrack(internalCodecID);

            await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(track)).resolves.toBe(false);
            expect(info.codec).toBeNull();
        }
    );

    it('leaves a track whose codec Mediabunny already assigned unchanged', async () => {
        const { info, track } = createFakeTrack('dvh1', { codec: 'vp9' });

        await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(track)).resolves.toBe(false);
        expect(info.codec).toBe('vp9');
    });

    it.each([
        { codecDescription: null, sampleEntryType: 'dvh1' },
        { codecDescription: HEVC_CONFIGURATION.slice(0, 22), sampleEntryType: 'dvhe' },
        { codecDescription: null, sampleEntryType: 'dva1' },
        { codecDescription: AVC_CONFIGURATION.slice(0, 3), sampleEntryType: 'dvav' },
        { codecDescription: HEVC_CONFIGURATION.buffer.slice(0), sampleEntryType: 'dvh1' }
    ])(
        'requires a complete decoder configuration record for $sampleEntryType',
        async ({ codecDescription, sampleEntryType }) => {
            const { info, track } = createFakeTrack(sampleEntryType, { codecDescription });

            await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(track)).resolves.toBe(false);
            expect(info.codec).toBeNull();
            expect(info.avcType).toBeNull();
        }
    );

    it('accepts the shortest AVC and HEVC records Mediabunny reads', async () => {
        const avcTrack = createFakeTrack('dva1', { codecDescription: AVC_CONFIGURATION.slice(0, 4) });
        const hevcTrack = createFakeTrack('dvh1', { codecDescription: HEVC_CONFIGURATION.slice(0, 23) });

        await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(avcTrack.track)).resolves.toBe(true);
        await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(hevcTrack.track)).resolves.toBe(true);
    });

    it('maps an AV1 sample entry without av1C, which Mediabunny reads from the first packet', async () => {
        const { info, track } = createFakeTrack('dav1', { codecDescription: null });

        await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(track)).resolves.toBe(true);
        expect(info.codec).toBe('av1');
    });

    it('leaves an unexpected Mediabunny backing shape unchanged', async () => {
        const audioTrack = createFakeTrack('dvh1', { type: 'audio' });
        const typedAVCTrack = createFakeTrack('dvh1', { avcType: 1 });
        const missingBacking = {
            getInternalCodecId: async (): Promise<string> => 'dvh1'
        } as unknown as InputVideoTrack;
        const missingInternalTrack = {
            _backing: {},
            getInternalCodecId: async (): Promise<string> => 'dvh1'
        } as unknown as InputVideoTrack;

        await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(audioTrack.track))
            .resolves.toBe(false);
        await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(typedAVCTrack.track))
            .resolves.toBe(false);
        await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(missingBacking))
            .resolves.toBe(false);
        await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(missingInternalTrack))
            .resolves.toBe(false);
        expect(audioTrack.info.codec).toBeNull();
        expect(typedAVCTrack.info.codec).toBeNull();
    });
});

describe('assignISOBaseMediaDolbyVisionSampleEntryCodec with Mediabunny MP4 demux', () => {
    it.each([ 'dvh1', 'dvhe' ])(
        'gives a %s track its HVCC decoder configuration and colr color space',
        async (sampleEntryType: string) => {
            const data = await createDolbyVisionMP4('hevc', {
                codec: 'hvc1.2.4.L153.B0',
                codedHeight: 2_160,
                codedWidth: 3_840,
                colorSpace: BT2020_PQ_COLOR_SPACE,
                description: HEVC_CONFIGURATION
            }, 'hvc1', sampleEntryType);

            await withDolbyVisionVideoTrack(data, sampleEntryType, async (
                track: InputVideoTrack
            ): Promise<void> => {
                await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(track)).resolves.toBe(true);

                expect(await track.getCodec()).toBe('hevc');
                const decoderConfig = await track.getDecoderConfig();
                expect(decoderConfig).toMatchObject({
                    codec: 'hev1.2.4.L153.B0',
                    codedHeight: 2_160,
                    codedWidth: 3_840,
                    colorSpace: BT2020_PQ_COLOR_SPACE
                });
                expect(toBytes(decoderConfig?.description)).toEqual(Array.from(HEVC_CONFIGURATION));
            });
        }
    );

    it.each([
        { expectedCodec: 'avc1.640028', sampleEntryType: 'dva1' },
        { expectedCodec: 'avc3.640028', sampleEntryType: 'dvav' }
    ])(
        'gives a $sampleEntryType track its AVCC decoder configuration',
        async ({ expectedCodec, sampleEntryType }) => {
            const data = await createDolbyVisionMP4('avc', {
                codec: 'avc1.640028',
                codedHeight: 1_080,
                codedWidth: 1_920,
                description: AVC_CONFIGURATION
            }, 'avc1', sampleEntryType);

            await withDolbyVisionVideoTrack(data, sampleEntryType, async (
                track: InputVideoTrack
            ): Promise<void> => {
                await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(track)).resolves.toBe(true);

                expect(await track.getCodec()).toBe('avc');
                const decoderConfig = await track.getDecoderConfig();
                expect(decoderConfig?.codec).toBe(expectedCodec);
                expect(toBytes(decoderConfig?.description)).toEqual(Array.from(AVC_CONFIGURATION));
            });
        }
    );

    it('gives a dav1 track its av1C decoder configuration and colr color space', async () => {
        const data = await createDolbyVisionMP4('av1', {
            codec: 'av01.0.08M.10',
            codedHeight: 1_080,
            codedWidth: 1_920,
            colorSpace: BT2020_PQ_COLOR_SPACE
        }, 'av01', 'dav1');

        await withDolbyVisionVideoTrack(data, 'dav1', async (track: InputVideoTrack): Promise<void> => {
            await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(track)).resolves.toBe(true);

            expect(await track.getCodec()).toBe('av1');
            expect(await track.getDecoderConfig()).toMatchObject({
                codec: 'av01.0.08M.10.0.110.09.16.09.0',
                codedHeight: 1_080,
                codedWidth: 1_920,
                colorSpace: BT2020_PQ_COLOR_SPACE
            });
        });
    });

    it('leaves a track Mediabunny already reads unchanged', async () => {
        const data = await createMP4('hevc', {
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 2_160,
            codedWidth: 3_840,
            description: HEVC_CONFIGURATION
        });

        await withPrimaryVideoTrack(data, async (track: InputVideoTrack): Promise<void> => {
            await expect(assignISOBaseMediaDolbyVisionSampleEntryCodec(track)).resolves.toBe(false);
            expect(await track.getCodec()).toBe('hevc');
        });
    });
});
