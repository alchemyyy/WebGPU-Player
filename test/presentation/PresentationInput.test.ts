import { describe, expect, it } from 'vitest';

import {
    getDolbyVisionBaseColorMetadata,
    getDolbyVisionDeclaredBaseTransfer,
    getDolbyVisionPresentationDescriptor,
    getDolbyVisionPresentationSelection,
    getDolbyVisionProfile7HDR10BaseColorMetadata,
    getDolbyVisionProfile8HDR10BaseColorMetadata,
    getDolbyVisionProfile8HLGBaseColorMetadata,
    getPresentationInputColorMetadata,
    isDolbyVisionDualLayerProfile,
    isDolbyVisionProfile7HDR10BaseLayerDescriptor,
    isDolbyVisionProfile8HDR10BaseLayerDescriptor,
    isDolbyVisionProfile8HLGBaseLayerDescriptor,
    isKnownSDRPresentationInput,
    parseVideoStreamColorMetadata,
    type DolbyVisionPresentationDescriptor
} from 'webgpu-player/presentation/PresentationInput';

// dv_bl_signal_compatibility_id is a 4-bit field, and every value is supported
const EVERY_COMPATIBILITY_ID = Array.from({ length: 16 }, (_value, compatibilityID) => compatibilityID);

function createSeparateProfile7Streams(
    baseLayerOverrides: Record<string, unknown> = {},
    enhancementLayerOverrides: Record<string, unknown> = {}
): Array<Record<string, unknown>> {
    return [
        {
            AverageFrameRate: 23.976025,
            BitDepth: 10,
            Codec: 'hevc',
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            Height: 2_160,
            IsInterlaced: false,
            RealFrameRate: 23.976025,
            Type: 'Video',
            VideoRange: 'HDR',
            VideoRangeType: 'HDR10',
            Width: 3_840,
            ...baseLayerOverrides
        },
        {
            AverageFrameRate: 23.976025,
            BitDepth: 10,
            BlPresentFlag: 0,
            Codec: 'hevc',
            DvBlSignalCompatibilityId: 6,
            DvProfile: 7,
            ElPresentFlag: 1,
            Height: 1_080,
            IsInterlaced: false,
            RealFrameRate: 23.976025,
            RpuPresentFlag: 1,
            Type: 'Video',
            VideoRange: 'HDR',
            VideoRangeType: 'DOVIWithEL',
            Width: 1_920,
            ...enhancementLayerOverrides
        }
    ];
}

describe('getDolbyVisionPresentationDescriptor', () => {
    it('accepts exact single-layer Profile 5 metadata', () => {
        expect(getDolbyVisionPresentationDescriptor({
            mediaSource: {
                MediaStreams: [{
                    BitDepth: 10,
                    BlPresentFlag: true,
                    DvBlSignalCompatibilityId: 0,
                    DvProfile: 5,
                    ElPresentFlag: false,
                    RpuPresentFlag: true,
                    Type: 'Video'
                }]
            }
        })).toEqual({
            baseLayerBitDepth: 10,
            baseLayerSignalCompatibilityID: 0,
            enhancementLayerPresent: false,
            profile: 5,
            reconstructionProfile: 5
        });
    });

    it.each([ ...EVERY_COMPATIBILITY_ID, null ])('accepts Profile 8 compatibility ID %s', compatibilityID => {
        const descriptor = getDolbyVisionPresentationDescriptor({
            mediaSource: {
                MediaStreams: [{
                    BitDepth: 10,
                    BlPresentFlag: '1',
                    DvBlSignalCompatibilityId: compatibilityID,
                    DvProfile: '8',
                    RpuPresentFlag: 1,
                    Type: 'Video'
                }]
            }
        });
        expect(descriptor).toMatchObject({
            baseLayerSignalCompatibilityID: compatibilityID,
            enhancementLayerPresent: false,
            profile: 8
        });
        expect(descriptor).not.toBeNull();
        if (descriptor) {
            // Only IDs that declare an HDR10 (1), Ultra HD Blu-ray (6), or HLG (4) base allow a native base route
            expect(isDolbyVisionProfile8HDR10BaseLayerDescriptor(descriptor)).toBe(
                compatibilityID === 1 || compatibilityID === 6
            );
            expect(isDolbyVisionProfile8HLGBaseLayerDescriptor(descriptor)).toBe(
                compatibilityID === 4
            );
        }
    });

    it.each([ ...EVERY_COMPATIBILITY_ID, null ])('accepts Profile 7 compatibility ID %s', compatibilityID => {
        const descriptor = getDolbyVisionPresentationDescriptor({
            mediaSource: {
                MediaStreams: [{
                    BitDepth: 10,
                    BlPresentFlag: true,
                    DvBlSignalCompatibilityId: compatibilityID,
                    DvProfile: 7,
                    ElPresentFlag: true,
                    RpuPresentFlag: true,
                    Type: 'Video'
                }]
            }
        });
        expect(descriptor).toEqual({
            baseLayerBitDepth: 10,
            baseLayerSignalCompatibilityID: compatibilityID,
            enhancementLayerPresent: true,
            profile: 7,
            reconstructionProfile: 7
        });
        if (descriptor) {
            expect(isDolbyVisionProfile7HDR10BaseLayerDescriptor(descriptor)).toBe(
                compatibilityID === 1 || compatibilityID === 6
            );
        }
    });

    it.each([ ...EVERY_COMPATIBILITY_ID, null ])('accepts Profile 5 compatibility ID %s', compatibilityID => {
        expect(getDolbyVisionPresentationDescriptor({
            mediaSource: {
                MediaStreams: [{
                    BitDepth: 10,
                    BlPresentFlag: true,
                    DvBlSignalCompatibilityId: compatibilityID,
                    DvProfile: 5,
                    ElPresentFlag: false,
                    RpuPresentFlag: true,
                    Type: 'Video'
                }]
            }
        })).toEqual({
            baseLayerBitDepth: 10,
            baseLayerSignalCompatibilityID: compatibilityID,
            enhancementLayerPresent: false,
            profile: 5,
            reconstructionProfile: 5
        });
    });

    it('accepts exact dual-layer Profile 7 metadata', () => {
        const descriptor = getDolbyVisionPresentationDescriptor({
            mediaSource: {
                MediaStreams: [{
                    BitDepth: 10,
                    BlPresentFlag: true,
                    DvBlSignalCompatibilityId: 6,
                    DvProfile: 7,
                    ElPresentFlag: true,
                    RpuPresentFlag: true,
                    Type: 'Video'
                }]
            }
        });
        expect(descriptor).toEqual({
            baseLayerBitDepth: 10,
            baseLayerSignalCompatibilityID: 6,
            enhancementLayerPresent: true,
            profile: 7,
            reconstructionProfile: 7
        });
        expect(descriptor).not.toBeNull();
        if (descriptor) {
            expect(isDolbyVisionProfile7HDR10BaseLayerDescriptor(descriptor)).toBe(true);
        }
    });

    it.each([ 0, 1 ])(
        'accepts Jellyfin separate-track Profile 7 metadata with enhancement BL flag %i',
        baseLayerPresentFlag => {
            const mediaStreams = createSeparateProfile7Streams(
                {},
                { BlPresentFlag: baseLayerPresentFlag }
            );
            const expectedDescriptor = {
                baseLayerBitDepth: 10,
                baseLayerSignalCompatibilityID: 6,
                enhancementLayerPresent: true,
                profile: 7,
                reconstructionProfile: 7
            };

            expect(getDolbyVisionPresentationDescriptor({
                mediaSource: { MediaStreams: mediaStreams }
            })).toEqual(expectedDescriptor);
            expect(getDolbyVisionPresentationSelection({
                mediaSource: { MediaStreams: mediaStreams }
            })).toEqual({
                baseLayerVideoTrackOrdinal: 0,
                descriptor: expectedDescriptor
            });
        }
    );

    it('accepts the HDR10 range label Jellyfin assigns to an MPEG-TS enhancement stream', () => {
        const mediaStreams = createSeparateProfile7Streams({}, {
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            VideoRangeType: 'HDR10'
        });

        expect(getDolbyVisionPresentationSelection({
            mediaSource: { MediaStreams: mediaStreams }
        })).toMatchObject({
            baseLayerVideoTrackOrdinal: 0,
            descriptor: {
                enhancementLayerPresent: true,
                profile: 7
            }
        });
    });

    it.each([ ...EVERY_COMPATIBILITY_ID, undefined ])(
        'accepts separate-track Profile 7 with enhancement compatibility ID %s',
        compatibilityID => {
            const mediaStreams = createSeparateProfile7Streams({}, {
                DvBlSignalCompatibilityId: compatibilityID
            });

            // The standalone base track is proven PQ, so it stays the HDR10-compatible base
            expect(getDolbyVisionPresentationDescriptor({
                mediaSource: { MediaStreams: mediaStreams }
            })).toEqual({
                baseLayerBitDepth: 10,
                baseLayerSignalCompatibilityID: 6,
                enhancementLayerPresent: true,
                profile: 7,
                reconstructionProfile: 7
            });
        }
    );

    it('selects a reversed separate Profile 7 base-layer ordinal', () => {
        const mediaStreams = createSeparateProfile7Streams().reverse();

        expect(getDolbyVisionPresentationSelection({
            mediaSource: { MediaStreams: mediaStreams }
        })).toMatchObject({
            baseLayerVideoTrackOrdinal: 1,
            descriptor: { profile: 7 }
        });
    });

    it.each([
        [ 'non-HEVC base', { Codec: 'h264' }, {} ],
        [ 'non-PQ base', { ColorTransfer: 'bt709', VideoRange: 'SDR', VideoRangeType: 'SDR' }, {} ],
        [ 'mismatched average frame rate', {}, { AverageFrameRate: 24 } ],
        [ 'mismatched real frame rate', {}, { RealFrameRate: 24 } ],
        [ 'mismatched geometry', {}, { Width: 1_918 } ],
        [ 'missing enhancement BL flag', {}, { BlPresentFlag: undefined } ],
        [ 'non-HDR enhancement', {}, {
            ColorTransfer: 'bt709',
            VideoRange: 'SDR',
            VideoRangeType: 'SDR'
        } ],
        [ 'invalid enhancement compatibility ID', {}, { DvBlSignalCompatibilityId: 16 } ]
    ])('rejects ambiguous separate-track Profile 7 metadata: %s', (
        _label,
        baseLayerOverrides,
        enhancementLayerOverrides
    ) => {
        expect(getDolbyVisionPresentationDescriptor({
            mediaSource: {
                MediaStreams: createSeparateProfile7Streams(
                    baseLayerOverrides,
                    enhancementLayerOverrides
                )
            }
        })).toBeNull();
    });

    it.each([
        // Profile 7 without its EL reconstructs MEL exactly and presents an FEL frame's compatible base
        [ { DvBlSignalCompatibilityId: 6, DvProfile: 7, ElPresentFlag: false }, 7, 10 ],
        // Single-layer profiles ignore a signaled EL
        [ { DvProfile: 5, ElPresentFlag: true }, 5, 10 ],
        [ { DvBlSignalCompatibilityId: 1, DvProfile: 8, ElPresentFlag: true }, 8, 10 ],
        // Without an RPU only a declared base layer can present the stream
        [ { DvProfile: 8, RpuPresentFlag: false }, null, 10 ],
        // Any base-layer bit depth is accepted; route selection decides whether it can be presented
        [ { BitDepth: 12, DvProfile: 5 }, 5, 12 ],
        [ { BitDepth: 8, DvBlSignalCompatibilityId: 2, DvProfile: 8 }, 8, 8 ]
    ])('accepts formerly rejected Dolby Vision metadata: %o', (
        metadata,
        reconstructionProfile,
        baseLayerBitDepth
    ) => {
        expect(getDolbyVisionPresentationDescriptor({
            mediaSource: {
                MediaStreams: [{
                    BitDepth: 10,
                    BlPresentFlag: true,
                    ElPresentFlag: false,
                    RpuPresentFlag: true,
                    Type: 'Video',
                    ...metadata
                }]
            }
        })).toMatchObject({ baseLayerBitDepth, reconstructionProfile });
    });

    it.each([
        [ 4, null, 4 ],
        [ 5, 0, 5 ],
        [ 7, 6, 7 ],
        [ 8, 1, 8 ],
        // Profile 20 is stereo MV-HEVC; its base view reconstructs like Profile 5 or 8
        [ 20, null, 5 ],
        [ 20, 0, 5 ],
        [ 20, 1, 8 ],
        [ 20, 2, 8 ],
        [ 20, 4, 8 ],
        // AVC Profile 9, AV1 Profile 10, and the retired profiles have no RPU route
        [ 9, 2, null ],
        [ 10, 1, null ],
        [ 0, null, null ],
        [ 3, null, null ],
        [ 6, 1, null ]
    ])('maps Profile %i with compatibility ID %s to RPU route %s', (
        profile,
        compatibilityID,
        reconstructionProfile
    ) => {
        expect(getDolbyVisionPresentationDescriptor({
            mediaSource: {
                MediaStreams: [{
                    BitDepth: 10,
                    BlPresentFlag: true,
                    ...(compatibilityID === null ? {} : {
                        DvBlSignalCompatibilityId: compatibilityID
                    }),
                    DvProfile: profile,
                    ElPresentFlag: profile === 4 || profile === 7,
                    RpuPresentFlag: true,
                    Type: 'Video'
                }]
            }
        })).toMatchObject({ profile, reconstructionProfile });
    });

    it.each([
        [ 9, 8 ],
        [ 2, 8 ],
        [ 8, 10 ],
        [ 20, 10 ]
    ])('defaults Profile %i without a bit depth to its %i-bit base layer', (profile, bitDepth) => {
        expect(getDolbyVisionPresentationDescriptor({
            mediaSource: {
                MediaStreams: [{
                    BlPresentFlag: true,
                    DvProfile: profile,
                    RpuPresentFlag: true,
                    Type: 'Video'
                }]
            }
        })?.baseLayerBitDepth).toBe(bitDepth);
    });

    it.each([
        { BlPresentFlag: false, DvProfile: 5 },
        { BitDepth: 7, DvProfile: 8 },
        { BitDepth: 17, DvProfile: 8 },
        { DvProfile: undefined, RpuPresentFlag: true },
        // A compatibility ID that is not a 4-bit integer is invalid metadata
        { DvBlSignalCompatibilityId: 'invalid', DvProfile: 5 },
        { DvBlSignalCompatibilityId: 16, DvProfile: 8 },
        { DvBlSignalCompatibilityId: -1, DvProfile: 8 },
        { DvBlSignalCompatibilityId: 1.5, DvProfile: 8 }
    ])('rejects an unsupported Dolby Vision descriptor: %o', metadata => {
        expect(getDolbyVisionPresentationDescriptor({
            mediaSource: {
                MediaStreams: [{
                    BitDepth: 10,
                    BlPresentFlag: true,
                    ElPresentFlag: false,
                    RpuPresentFlag: true,
                    Type: 'Video',
                    ...metadata
                }]
            }
        })).toBeNull();
    });
});

describe('getDolbyVisionProfile7HDR10BaseColorMetadata', () => {
    const createProfile7Options = (
        overrides: Record<string, unknown> = {}
    ): Record<string, unknown> => ({
        mediaSource: {
            MediaStreams: [{
                BitDepth: 10,
                BlPresentFlag: true,
                Codec: 'hevc',
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'smpte2084',
                DvBlSignalCompatibilityId: 6,
                DvProfile: 7,
                ElPresentFlag: true,
                RpuPresentFlag: true,
                Type: 'Video',
                VideoRange: 'HDR',
                VideoRangeType: 'DOVIWithEL',
                ...overrides
            }]
        }
    });

    it('keeps the HDR10 base of a Profile 7 stream without its EL', () => {
        expect(getDolbyVisionProfile7HDR10BaseColorMetadata(
            createProfile7Options({ ElPresentFlag: false })
        )).toMatchObject({ transfer: 'pq' });
    });

    it.each([ 6, 1 ])(
        'derives the exact limited BT.2020 PQ base-layer contract for compatibility ID %i',
        compatibilityID => {
            expect(getDolbyVisionProfile7HDR10BaseColorMetadata(
                createProfile7Options({ DvBlSignalCompatibilityId: compatibilityID })
            )).toMatchObject({
                bitDepth: 10,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                range: 'limited',
                transfer: 'pq'
            });
        }
    );

    it.each([
        { ColorPrimaries: 'bt709' },
        { ColorRange: 'full' },
        { ColorSpace: 'bt709' },
        { ColorTransfer: 'hlg' },
        // These IDs declare no HDR10-compatible base, so RPU reconstruction presents the stream
        { DvBlSignalCompatibilityId: 0 },
        { DvBlSignalCompatibilityId: 2 },
        { DvBlSignalCompatibilityId: 4 },
        { DvBlSignalCompatibilityId: 15 },
        { DvBlSignalCompatibilityId: undefined },
        { VideoRange: 'SDR' }
    ])('rejects an inexact Profile 7 HDR10 base contract: %o', overrides => {
        expect(getDolbyVisionProfile7HDR10BaseColorMetadata(
            createProfile7Options(overrides)
        )).toBeNull();
    });
});

describe('getDolbyVisionProfile8HDR10BaseColorMetadata', () => {
    const createProfile8Options = (
        overrides: Record<string, unknown> = {}
    ): Record<string, unknown> => ({
        mediaSource: {
            MediaStreams: [{
                BitDepth: 10,
                BlPresentFlag: true,
                Codec: 'hevc',
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'smpte2084',
                DvBlSignalCompatibilityId: 1,
                DvProfile: 8,
                ElPresentFlag: false,
                RpuPresentFlag: true,
                Type: 'Video',
                VideoRange: 'HDR',
                VideoRangeType: 'DOVIWithHDR10',
                ...overrides
            }]
        }
    });

    it('derives the exact limited BT.2020 PQ Profile 8.1 base contract', () => {
        expect(getDolbyVisionProfile8HDR10BaseColorMetadata(
            createProfile8Options()
        )).toMatchObject({
            bitDepth: 10,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            range: 'limited',
            transfer: 'pq'
        });
    });

    it('ignores a signaled EL, which a single-layer profile never decodes', () => {
        expect(getDolbyVisionProfile8HDR10BaseColorMetadata(
            createProfile8Options({ ElPresentFlag: true })
        )).toMatchObject({ transfer: 'pq' });
    });

    it.each([
        { ColorPrimaries: 'bt709' },
        { ColorRange: 'full' },
        { ColorSpace: 'bt709' },
        { ColorTransfer: 'hlg' },
        { DvBlSignalCompatibilityId: 4 },
        { VideoRange: 'SDR' }
    ])('rejects an inexact Profile 8.1 HDR10 base contract: %o', overrides => {
        expect(getDolbyVisionProfile8HDR10BaseColorMetadata(
            createProfile8Options(overrides)
        )).toBeNull();
    });
});

describe('getDolbyVisionProfile8HLGBaseColorMetadata', () => {
    const createProfile8Options = (
        overrides: Record<string, unknown> = {}
    ): Record<string, unknown> => ({
        mediaSource: {
            MediaStreams: [{
                BitDepth: 10,
                BlPresentFlag: true,
                Codec: 'hevc',
                ColorPrimaries: 'bt2020',
                ColorRange: 'limited',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'hlg',
                DvBlSignalCompatibilityId: 4,
                DvProfile: 8,
                ElPresentFlag: false,
                RpuPresentFlag: true,
                Type: 'Video',
                VideoRange: 'HDR',
                VideoRangeType: 'DOVIWithHLG',
                ...overrides
            }]
        }
    });

    it('derives the exact limited BT.2020 HLG Profile 8.4 base contract', () => {
        expect(getDolbyVisionProfile8HLGBaseColorMetadata(
            createProfile8Options()
        )).toMatchObject({
            bitDepth: 10,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            range: 'limited',
            transfer: 'hlg'
        });
    });

    it.each([
        { ElPresentFlag: undefined },
        { ElPresentFlag: true }
    ])('ignores the EL flag of a single-layer Profile 8.4 base: %o', overrides => {
        expect(getDolbyVisionProfile8HLGBaseColorMetadata(
            createProfile8Options(overrides)
        )).toMatchObject({ transfer: 'hlg' });
    });

    it.each([
        { BitDepth: undefined },
        { BitDepth: 8 },
        { ColorPrimaries: 'bt709' },
        { ColorRange: undefined },
        { ColorRange: 'full' },
        { ColorSpace: 'bt2020c' },
        { ColorTransfer: 'smpte2084' },
        { DvBlSignalCompatibilityId: 1 },
        { VideoRange: 'SDR' }
    ])('rejects an inexact Profile 8.4 HLG base contract: %o', overrides => {
        expect(getDolbyVisionProfile8HLGBaseColorMetadata(
            createProfile8Options(overrides)
        )).toBeNull();
    });
});

describe('getDolbyVisionDeclaredBaseTransfer', () => {
    const createDescriptor = (
        profile: number,
        compatibilityID: number | null,
        reconstructionProfile: DolbyVisionPresentationDescriptor['reconstructionProfile']
    ): DolbyVisionPresentationDescriptor => ({
        baseLayerBitDepth: 10,
        baseLayerSignalCompatibilityID: compatibilityID,
        enhancementLayerPresent: false,
        profile,
        reconstructionProfile
    });

    it.each([
        [ 1, 'pq' ],
        [ 6, 'pq' ],
        [ 4, 'hlg' ],
        [ 2, 'sdr' ],
        [ 0, null ],
        [ 3, null ],
        [ 15, null ],
        [ null, null ]
    ])('declares compatibility ID %s as a %s base', (compatibilityID, transfer) => {
        expect(getDolbyVisionDeclaredBaseTransfer(
            createDescriptor(8, compatibilityID, 8)
        )).toBe(transfer);
    });

    it.each([
        createDescriptor(5, 1, 5),
        createDescriptor(5, 2, null),
        createDescriptor(20, null, 5)
    ])('never declares the IPT base layer of a Profile 5 style stream: %o', descriptor => {
        expect(getDolbyVisionDeclaredBaseTransfer(descriptor)).toBeNull();
    });
});

describe('getDolbyVisionBaseColorMetadata', () => {
    const createOptions = (stream: Record<string, unknown>): Record<string, unknown> => ({
        mediaSource: {
            MediaStreams: [{
                BlPresentFlag: true,
                RpuPresentFlag: true,
                Type: 'Video',
                ...stream
            }]
        }
    });

    it('presents a Profile 9 AVC base as 8-bit SDR', () => {
        expect(getDolbyVisionBaseColorMetadata(createOptions({
            BitDepth: 8,
            Codec: 'h264',
            ColorTransfer: 'bt709',
            DvBlSignalCompatibilityId: 2,
            DvProfile: 9,
            VideoRangeType: 'SDR'
        }))).toMatchObject({
            bitDepth: 8,
            matrix: 'bt709',
            primaries: 'bt709',
            range: 'limited',
            transfer: 'sdr'
        });
    });

    it('presents a Profile 4 base as 10-bit SDR', () => {
        expect(getDolbyVisionBaseColorMetadata(createOptions({
            BitDepth: 10,
            Codec: 'hevc',
            DvBlSignalCompatibilityId: 2,
            DvProfile: 4,
            ElPresentFlag: true
        }))).toMatchObject({ bitDepth: 10, transfer: 'sdr' });
    });

    it('trusts the compatibility ID and transfer over a mislabeled Profile 20 range', () => {
        expect(getDolbyVisionBaseColorMetadata(createOptions({
            BitDepth: 10,
            Codec: 'hevc',
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            DvBlSignalCompatibilityId: 1,
            DvProfile: 20,
            VideoRange: 'SDR',
            VideoRangeType: 'SDR'
        }))).toMatchObject({
            bitDepth: 10,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'pq'
        });
    });

    it('presents a declared 12-bit HDR10 base at its own depth', () => {
        expect(getDolbyVisionBaseColorMetadata(createOptions({
            BitDepth: 12,
            Codec: 'hevc',
            ColorTransfer: 'smpte2084',
            DvBlSignalCompatibilityId: 1,
            DvProfile: 8,
            PixelFormat: 'yuv420p12le',
            Profile: 'Main 12'
        }))).toMatchObject({ bitDepth: 12, transfer: 'pq' });
    });

    it('presents the proven PQ base track of a separate Profile 7 pair', () => {
        expect(getDolbyVisionBaseColorMetadata({
            mediaSource: { MediaStreams: createSeparateProfile7Streams() }
        })).toMatchObject({ transfer: 'pq' });
    });

    it('treats an unknown ColorTransfer as absent, so the compatibility ID declares the base', () => {
        expect(getDolbyVisionBaseColorMetadata(createOptions({
            BitDepth: 10,
            ColorTransfer: 'unknown',
            DvBlSignalCompatibilityId: 1,
            DvProfile: 8
        }))).toMatchObject({
            bitDepth: 10,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            range: 'limited',
            transfer: 'pq'
        });
    });

    it.each([
        { BitDepth: 10, ColorTransfer: 'smpte2084', DvBlSignalCompatibilityId: 2, DvProfile: 8 },
        { BitDepth: 10, ColorTransfer: 'arib-std-b67', DvBlSignalCompatibilityId: 1, DvProfile: 8 },
        { BitDepth: 8, DvBlSignalCompatibilityId: 1, DvProfile: 8 },
        { BitDepth: 10, DvBlSignalCompatibilityId: 0, DvProfile: 8 },
        { BitDepth: 10, DvBlSignalCompatibilityId: 1, DvProfile: 5 },
        { BitDepth: 10, DvBlSignalCompatibilityId: 4, DvProfile: 8, Hdr10PlusPresentFlag: true }
    ])('declares no presentable base for %o', stream => {
        expect(getDolbyVisionBaseColorMetadata(createOptions(stream))).toBeNull();
    });
});

describe('isDolbyVisionDualLayerProfile', () => {
    it.each([
        [ 4, true ],
        [ 7, true ],
        [ 5, false ],
        [ 8, false ],
        [ null, false ]
    ] as const)('classifies Profile %s as dual-layer %s', (profile, dualLayer) => {
        expect(isDolbyVisionDualLayerProfile(profile)).toBe(dualLayer);
    });
});

describe('isKnownSDRPresentationInput', () => {
    it('accepts explicitly identified SDR video input', () => {
        expect(isKnownSDRPresentationInput({
            mediaSource: {
                MediaStreams: [
                    { Type: 'Audio' },
                    { Type: 'Video', VideoRangeType: 'SDR' }
                ]
            }
        })).toBe(true);
    });

    it('accepts the legacy SDR video range field', () => {
        expect(isKnownSDRPresentationInput({
            mediaSource: {
                MediaStreams: [
                    { Type: 'video', VideoRange: 'sdr' }
                ]
            }
        })).toBe(true);
    });

    it('uses Jellyfin\'s first independent video track for SDR presentation', () => {
        expect(isKnownSDRPresentationInput({
            mediaSource: {
                MediaStreams: [
                    { Type: 'Video', VideoRangeType: 'SDR' },
                    { Type: 'Video', VideoRangeType: 'HDR10' }
                ]
            }
        })).toBe(true);
    });

    it.each([
        undefined,
        {},
        { mediaSource: {} },
        { mediaSource: { MediaStreams: [] } },
        { mediaSource: { MediaStreams: [{ Type: 'Video' }] } }
    ])('rejects input without positive SDR metadata', options => {
        expect(isKnownSDRPresentationInput(options)).toBe(false);
    });

    it.each([
        { VideoRangeType: 'HDR10' },
        { VideoRangeType: 'DOVIWithSDR' },
        { VideoRange: 'HLG' },
        { VideoRangeType: 'HDR10', VideoRange: 'SDR' },
        { VideoRangeType: 'SDR', ColorTransfer: 'SMPTE2084' },
        { VideoRange: 'SDR', ColorTransfer: 'ARIB-STD-B67' },
        { VideoRangeType: 'SDR', Hdr10PlusPresentFlag: true },
        { VideoRangeType: 'SDR', Hdr10PlusPresentFlag: 1 },
        { VideoRangeType: 'SDR', DvProfile: 8 },
        { VideoRangeType: 'SDR', DvVersionMajor: 1 },
        { VideoRangeType: 'SDR', DvVersionMinor: 0 },
        { VideoRangeType: 'SDR', DvLevel: 6 },
        { VideoRangeType: 'SDR', DvBlSignalCompatibilityId: 1 },
        { VideoRangeType: 'SDR', VideoDoViTitle: 'Dolby Vision' },
        { VideoRangeType: 'SDR', BlPresentFlag: true },
        { VideoRangeType: 'SDR', ElPresentFlag: true },
        { VideoRangeType: 'SDR', RpuPresentFlag: '1' }
    ])('rejects non-SDR or contradictory video metadata: %o', videoMetadata => {
        expect(isKnownSDRPresentationInput({
            mediaSource: {
                MediaStreams: [{ Type: 'Video', ...videoMetadata }]
            }
        })).toBe(false);
    });

    it('does not substitute a later SDR track for the first HDR track', () => {
        expect(isKnownSDRPresentationInput({
            mediaSource: {
                MediaStreams: [
                    { Type: 'Video', VideoRangeType: 'HDR10' },
                    { Type: 'Video', VideoRangeType: 'SDR' }
                ]
            }
        })).toBe(false);
    });
});

describe('parseVideoStreamColorMetadata', () => {
    it('creates default BT.709 metadata for an explicit SDR stream', () => {
        expect(parseVideoStreamColorMetadata({
            Type: 'Video',
            VideoRangeType: 'SDR'
        })).toMatchObject({
            bitDepth: 8,
            matrix: 'bt709',
            nominalPeakNits: 100,
            primaries: 'bt709',
            range: 'limited',
            transfer: 'sdr'
        });
    });

    it('maps Jellyfin HDR10 metadata into an explicit PQ input description', () => {
        expect(parseVideoStreamColorMetadata({
            BitDepth: 12,
            ColorPrimaries: 'bt2020',
            ColorRange: 'tv',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            Type: 'Video',
            VideoRange: 'HDR',
            VideoRangeType: 'HDR10'
        })).toEqual({
            bitDepth: 12,
            matrix: 'bt2020-ncl',
            nominalPeakNits: 1_000,
            primaries: 'bt2020',
            range: 'limited',
            sdrReferenceWhiteNits: 100,
            transfer: 'pq',
            version: 1
        });
    });

    it('maps HLG aliases and full range without inventing floating timestamps', () => {
        expect(parseVideoStreamColorMetadata({
            ColorRange: 'pc',
            ColorTransfer: 'ARIB-STD-B67',
            Type: 'Video',
            VideoRangeType: 'HLG'
        })).toMatchObject({
            bitDepth: 10,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            range: 'full',
            transfer: 'hlg'
        });
    });

    it.each([
        { Hdr10PlusPresentFlag: true, VideoRangeType: 'HDR10' },
        { VideoRangeType: 'HDR10Plus' }
    ])('accepts a PQ-compatible HDR10+ base for dynamic metadata: %o', stream => {
        expect(parseVideoStreamColorMetadata({
            ...stream,
            Type: 'Video'
        })).toMatchObject({
            bitDepth: 10,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            range: 'limited',
            transfer: 'pq'
        });
    });

    it.each([
        { Type: 'Video' },
        { Type: 'Video', VideoRange: 'HDR' },
        { Type: 'Video', VideoRangeType: 'Unknown' },
        { Type: 'Video', VideoRangeType: 'DOVIWithHDR10' },
        { DvProfile: 8, Type: 'Video', VideoRangeType: 'HDR10' },
        { RpuPresentFlag: 1, Type: 'Video', VideoRangeType: 'HDR10' },
        { Type: 'Video', VideoRange: 'SDR', VideoRangeType: 'HDR10' },
        { ColorTransfer: 'smpte2084', Type: 'Video', VideoRangeType: 'HLG' },
        { BitDepth: 8, Type: 'Video', VideoRangeType: 'HDR10' },
        { ColorSpace: 'smpte240m', Type: 'Video', VideoRangeType: 'SDR' },
        { ColorPrimaries: 'display-p3', Type: 'Video', VideoRangeType: 'SDR' },
        { ColorRange: 'studio', Type: 'Video', VideoRangeType: 'SDR' },
        { ColorTransfer: 'bt470bg', Type: 'Video', VideoRangeType: 'SDR' },
        { Hdr10PlusPresentFlag: true, Type: 'Video', VideoRangeType: 'SDR' }
    ])('rejects unknown, Dolby Vision, or contradictory metadata: %o', stream => {
        expect(parseVideoStreamColorMetadata(stream)).toBeNull();
    });

    it.each([
        {
            expected: { bitDepth: 8, matrix: 'smpte170m', primaries: 'smpte170m', transfer: 'sdr' },
            stream: {
                BitDepth: 8,
                ColorPrimaries: 'smpte170m',
                ColorSpace: 'smpte170m',
                ColorTransfer: 'bt709',
                Type: 'Video',
                VideoRange: 'SDR',
                VideoRangeType: 'SDR'
            }
        },
        {
            expected: { bitDepth: 8, matrix: 'smpte170m', primaries: 'smpte170m', transfer: 'sdr' },
            stream: {
                BitDepth: 8,
                ColorPrimaries: 'smpte170m',
                ColorSpace: 'smpte170m',
                ColorTransfer: 'smpte170m',
                Type: 'Video',
                VideoRange: 'SDR',
                VideoRangeType: 'SDR'
            }
        },
        {
            expected: { bitDepth: 10, matrix: 'smpte170m', primaries: 'smpte170m', transfer: 'sdr' },
            stream: {
                BitDepth: 10,
                ColorPrimaries: 'smpte170m',
                ColorSpace: 'smpte170m',
                ColorTransfer: 'smpte170m',
                Type: 'Video',
                VideoRange: 'SDR',
                VideoRangeType: 'SDR'
            }
        },
        {
            expected: { bitDepth: 10, matrix: 'bt2020-ncl', primaries: 'bt2020', transfer: 'sdr' },
            stream: {
                BitDepth: 10,
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'bt2020-10',
                Type: 'Video',
                VideoRange: 'SDR',
                VideoRangeType: 'SDR'
            }
        },
        {
            expected: { bitDepth: 12, matrix: 'bt2020-ncl', primaries: 'bt2020', transfer: 'sdr' },
            stream: {
                BitDepth: 12,
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'bt2020-12',
                Type: 'Video',
                VideoRangeType: 'SDR'
            }
        },
        {
            expected: { bitDepth: 8, matrix: 'bt470bg', primaries: 'bt470bg', transfer: 'sdr' },
            stream: {
                ColorPrimaries: 'bt470bg',
                ColorSpace: 'bt470bg',
                ColorTransfer: 'bt709',
                Type: 'Video',
                VideoRangeType: 'SDR'
            }
        },
        {
            // SMPTE 240M primaries share the SMPTE 170M chromaticities
            expected: { bitDepth: 8, matrix: 'smpte170m', primaries: 'smpte170m', transfer: 'sdr' },
            stream: {
                ColorPrimaries: 'smpte240m',
                ColorSpace: 'smpte170m',
                Type: 'Video',
                VideoRangeType: 'SDR'
            }
        }
    ])('accepts BT.601 and BT.2020 SDR color: $stream', ({ expected, stream }) => {
        expect(parseVideoStreamColorMetadata(stream)).toMatchObject({
            ...expected,
            range: 'limited'
        });
    });

    it('defaults the primaries of an SDR stream that names only a BT.601 matrix', () => {
        expect(parseVideoStreamColorMetadata({
            ColorSpace: 'smpte170m',
            Type: 'Video',
            VideoRangeType: 'SDR'
        })).toMatchObject({
            matrix: 'smpte170m',
            primaries: 'bt709',
            transfer: 'sdr'
        });
    });

    it.each([ 'unknown', 'reserved', 'unspecified' ])(
        'treats a %s color field as absent so the SDR defaults apply',
        absentValue => {
            expect(parseVideoStreamColorMetadata({
                ColorPrimaries: absentValue,
                ColorRange: absentValue,
                ColorSpace: absentValue,
                ColorTransfer: absentValue,
                Type: 'Video',
                VideoRangeType: 'SDR'
            })).toMatchObject({
                bitDepth: 8,
                matrix: 'bt709',
                primaries: 'bt709',
                range: 'limited',
                transfer: 'sdr'
            });
        }
    );
});

describe('getPresentationInputColorMetadata', () => {
    it('extracts the only video stream while ignoring audio streams', () => {
        expect(getPresentationInputColorMetadata({
            mediaSource: {
                MediaStreams: [
                    { Type: 'Audio' },
                    { Type: 'Video', VideoRangeType: 'SDR' }
                ]
            }
        })?.transfer).toBe('sdr');
    });

    it('rejects missing video streams', () => {
        expect(getPresentationInputColorMetadata({ mediaSource: { MediaStreams: [] } }))
            .toBeNull();
    });

    it('extracts metadata from Jellyfin\'s first independent video track', () => {
        expect(getPresentationInputColorMetadata({
            mediaSource: {
                MediaStreams: [
                    {
                        BitDepth: 10,
                        ColorPrimaries: 'bt2020',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        Height: 2_160,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'HDR10',
                        Width: 3_840
                    },
                    {
                        Height: 1_080,
                        Type: 'Video',
                        VideoRangeType: 'SDR',
                        Width: 1_920
                    }
                ]
            }
        })).toMatchObject({
            bitDepth: 10,
            transfer: 'pq'
        });
    });

    it('rejects unrecognized multi-track Dolby Vision topology', () => {
        expect(getPresentationInputColorMetadata({
            mediaSource: {
                MediaStreams: createSeparateProfile7Streams({}, { Width: 1_918 })
            }
        })).toBeNull();
    });
});
