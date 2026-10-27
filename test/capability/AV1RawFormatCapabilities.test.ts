import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    AV1_RAW_FORMAT_PROBE_DEFINITIONS,
    AV1_RAW_FORMAT_VARIANTS,
    getAV1RawFormatStreamDefinition,
    getAV1RawFormatStreamDefinitionFromMetadata,
    type AV1RawFormatVariant
} from 'webgpu-player/capability/AV1RawFormatCapabilities';
import {
    AV1_OBU_TYPE_FRAME,
    AV1_OBU_TYPE_SEQUENCE_HEADER,
    AV1_OBU_TYPE_TEMPORAL_DELIMITER,
    parseAV1OBUs,
    type AV1OBU
} from 'webgpu-player/demux/av1/AV1OBUParser';
import { findAV1SequenceHeader } from 'webgpu-player/demux/av1/AV1SequenceHeaderParser';

type ExpectedVariant = Readonly<{
    bitDepth: 8 | 10 | 12
    chromaFormat: '420' | '422' | '444'
    codecString: string
    format: string
    jellyfinProfile: string
    pixelFormat: string
    sequenceProfile: 0 | 1 | 2
    subsampling: readonly [ 0 | 1, 0 | 1 ]
}>;

const EXPECTED_VARIANTS: Readonly<Record<AV1RawFormatVariant, ExpectedVariant>> = {
    'main420-8': {
        bitDepth: 8,
        chromaFormat: '420',
        codecString: 'av01.0.00M.08.0.110',
        format: 'I420',
        jellyfinProfile: 'Main',
        pixelFormat: 'yuv420p',
        sequenceProfile: 0,
        subsampling: [ 1, 1 ]
    },
    'high444-8': {
        bitDepth: 8,
        chromaFormat: '444',
        codecString: 'av01.1.00M.08.0.000',
        format: 'I444',
        jellyfinProfile: 'High',
        pixelFormat: 'yuv444p',
        sequenceProfile: 1,
        subsampling: [ 0, 0 ]
    },
    'high444-10': {
        bitDepth: 10,
        chromaFormat: '444',
        codecString: 'av01.1.00M.10.0.000',
        format: 'I444P10',
        jellyfinProfile: 'High',
        pixelFormat: 'yuv444p10le',
        sequenceProfile: 1,
        subsampling: [ 0, 0 ]
    },
    'professional422-8': {
        bitDepth: 8,
        chromaFormat: '422',
        codecString: 'av01.2.00M.08.0.100',
        format: 'I422',
        jellyfinProfile: 'Professional',
        pixelFormat: 'yuv422p',
        sequenceProfile: 2,
        subsampling: [ 1, 0 ]
    },
    'professional422-10': {
        bitDepth: 10,
        chromaFormat: '422',
        codecString: 'av01.2.00M.10.0.100',
        format: 'I422P10',
        jellyfinProfile: 'Professional',
        pixelFormat: 'yuv422p10le',
        sequenceProfile: 2,
        subsampling: [ 1, 0 ]
    },
    'professional420-12': {
        bitDepth: 12,
        chromaFormat: '420',
        codecString: 'av01.2.00M.12.0.110',
        format: 'I420P12',
        jellyfinProfile: 'Professional',
        pixelFormat: 'yuv420p12le',
        sequenceProfile: 2,
        subsampling: [ 1, 1 ]
    },
    'professional422-12': {
        bitDepth: 12,
        chromaFormat: '422',
        codecString: 'av01.2.00M.12.0.100',
        format: 'I422P12',
        jellyfinProfile: 'Professional',
        pixelFormat: 'yuv422p12le',
        sequenceProfile: 2,
        subsampling: [ 1, 0 ]
    },
    'professional444-12': {
        bitDepth: 12,
        chromaFormat: '444',
        codecString: 'av01.2.00M.12.0.000',
        format: 'I444P12',
        jellyfinProfile: 'Professional',
        pixelFormat: 'yuv444p12le',
        sequenceProfile: 2,
        subsampling: [ 0, 0 ]
    }
};

const KEY_FRAME_TYPE = 0;
const INTER_FRAME_TYPE = 1;

/** Returns the frame_type each temporal unit's frame shows, which needs a header without reduced still picture headers. */
function getShownFrameType(units: readonly AV1OBU[]): number {
    const frames = units.filter(unit => unit.type === AV1_OBU_TYPE_FRAME);
    expect(frames).toHaveLength(1);
    const firstHeaderByte = frames[0].payload[0];
    // show_existing_frame, then frame_type, then show_frame
    expect(firstHeaderByte & 0x80).toBe(0);
    expect(firstHeaderByte & 0x10).toBe(0x10);
    return (firstHeaderByte >> 5) & 0x03;
}

function readVector(variant: AV1RawFormatVariant): Uint8Array {
    return new Uint8Array(readFileSync(resolve(CODEC_VECTOR_ASSETS_DIRECTORY, 'av1-raw-format', `${variant}.obu`)));
}

describe('AV1RawFormatCapabilities', () => {
    it('defines the eight raw formats outside Main 10', () => {
        expect(AV1_RAW_FORMAT_VARIANTS).toEqual([
            'main420-8',
            'high444-8',
            'high444-10',
            'professional422-8',
            'professional422-10',
            'professional420-12',
            'professional422-12',
            'professional444-12'
        ]);
        expect(Object.isFrozen(AV1_RAW_FORMAT_PROBE_DEFINITIONS)).toBe(true);

        for (const variant of AV1_RAW_FORMAT_VARIANTS) {
            const definition = AV1_RAW_FORMAT_PROBE_DEFINITIONS[variant];
            const expected = EXPECTED_VARIANTS[variant];
            expect(definition).toMatchObject({
                assetPath: `webgpu-player/av1-raw/${variant}.bin`,
                bitDepth: expected.bitDepth,
                chromaFormat: expected.chromaFormat,
                format: expected.format,
                jellyfinProfile: expected.jellyfinProfile,
                pixelFormat: expected.pixelFormat,
                variant
            });
            expect(definition.config).toEqual({
                codec: expected.codecString,
                codedHeight: 192,
                codedWidth: 192,
                hardwareAcceleration: 'prefer-software',
                optimizeForLatency: true
            });
            expect(Object.isFrozen(definition)).toBe(true);
            expect(Object.isFrozen(definition.accessUnits)).toBe(true);
        }
    });

    it.each(AV1_RAW_FORMAT_VARIANTS)('matches the committed %s vector: one key, then one inter temporal unit', variant => {
        const definition = AV1_RAW_FORMAT_PROBE_DEFINITIONS[variant];
        const expected = EXPECTED_VARIANTS[variant];
        const vectorBytes = readVector(variant);

        expect(definition.accessUnits.map(accessUnit => accessUnit.type)).toEqual([ 'key', 'delta' ]);
        expect(definition.accessUnits.map(accessUnit => accessUnit.timestamp)).toEqual([ 0, 1_000_000 ]);
        expect(definition.accessUnits.reduce(
            (totalByteLength: number, accessUnit): number => totalByteLength + accessUnit.byteLength,
            0
        )).toBe(vectorBytes.byteLength);

        const keyByteLength = definition.accessUnits[0].byteLength;
        const keyTemporalUnit = vectorBytes.subarray(0, keyByteLength);
        const interTemporalUnit = vectorBytes.subarray(keyByteLength);
        const keyUnits = parseAV1OBUs(keyTemporalUnit);
        const interUnits = parseAV1OBUs(interTemporalUnit);
        // Each temporal unit starts at its temporal delimiter, and only the key unit carries the sequence header
        expect(keyUnits.map(unit => unit.type)).toEqual([
            AV1_OBU_TYPE_TEMPORAL_DELIMITER,
            AV1_OBU_TYPE_SEQUENCE_HEADER,
            AV1_OBU_TYPE_FRAME
        ]);
        expect(interUnits.map(unit => unit.type)).toEqual([ AV1_OBU_TYPE_TEMPORAL_DELIMITER, AV1_OBU_TYPE_FRAME ]);
        expect(getShownFrameType(keyUnits)).toBe(KEY_FRAME_TYPE);
        expect(getShownFrameType(interUnits)).toBe(INTER_FRAME_TYPE);

        const sequenceHeader = findAV1SequenceHeader(keyTemporalUnit);
        expect(sequenceHeader?.profile).toBe(expected.sequenceProfile);
        expect(sequenceHeader?.colorConfig).toMatchObject({
            bitDepth: expected.bitDepth,
            monochrome: false,
            subsamplingX: expected.subsampling[0],
            subsamplingY: expected.subsampling[1]
        });
        // The codec string's profile and depth agree with the sequence header
        expect(expected.codecString.split('.').slice(1, 4)).toEqual([
            String(expected.sequenceProfile),
            '00M',
            String(expected.bitDepth).padStart(2, '0')
        ]);
    });

    it.each(AV1_RAW_FORMAT_VARIANTS)('matches %s by its profile, pixel format, and depth', variant => {
        const definition = AV1_RAW_FORMAT_PROBE_DEFINITIONS[variant];

        expect(getAV1RawFormatStreamDefinition(definition.jellyfinProfile, definition.pixelFormat, definition.bitDepth))
            .toBe(definition);
        // Jellyfin can omit BitDepth when FFprobe exposes only PixelFormat
        expect(getAV1RawFormatStreamDefinition(definition.jellyfinProfile, definition.pixelFormat, null))
            .toBe(definition);
        expect(getAV1RawFormatStreamDefinitionFromMetadata({
            BitDepth: definition.bitDepth,
            PixelFormat: definition.pixelFormat,
            Profile: definition.jellyfinProfile
        })).toBe(definition);
    });

    it.each([
        [ 'main', 'yuv420p', 'main420-8' ],
        [ 'MAIN', 'yuv420p', 'main420-8' ],
        [ ' high ', 'yuv444p10le', 'high444-10' ],
        [ 'HIGH', 'yuv444p', 'high444-8' ],
        [ 'professional', 'yuv422p', 'professional422-8' ],
        [ ' Professional ', 'yuv444p12le', 'professional444-12' ]
    ])('accepts profile %j with %s as %s', (profile, pixelFormat, variant) => {
        expect(getAV1RawFormatStreamDefinition(profile, pixelFormat, null)?.variant).toBe(variant);
    });

    it.each([
        // Main 10 stays on the raw AV1 HDR probe
        [ 'Main', 'yuv420p10le' ],
        // Each profile admits only its own chroma formats
        [ 'Main', 'yuv444p' ],
        [ 'High', 'yuv420p' ],
        [ 'High', 'yuv422p' ],
        [ 'Professional', 'yuv420p' ],
        [ 'Professional', 'yuv444p' ],
        // Pixel formats outside the table, including full-range and unsuffixed aliases
        [ 'Main', 'yuvj420p' ],
        [ 'Professional', 'yuv422p10' ],
        [ 'Professional', 'yuv444p16le' ],
        [ 'High', 'gbrp' ],
        [ 'Main', 'nv12' ],
        [ 'Main', 'gray' ],
        [ 'Main', '' ]
    ])('rejects profile %s with pixel format %j', (profile, pixelFormat) => {
        expect(getAV1RawFormatStreamDefinition(profile, pixelFormat, null)).toBeNull();
    });

    it.each([ 'Main 10', 'Baseline', 'Rext', 'High 4:4:4', '', null, undefined ])(
        'rejects the unknown profile %j',
        profile => {
            expect(getAV1RawFormatStreamDefinition(profile, 'yuv420p', 8)).toBeNull();
        }
    );

    it('rejects a BitDepth that disagrees with PixelFormat', () => {
        expect(getAV1RawFormatStreamDefinition('Professional', 'yuv422p12le', 10)).toBeNull();
        expect(getAV1RawFormatStreamDefinition('High', 'yuv444p', 10)).toBeNull();
        expect(getAV1RawFormatStreamDefinitionFromMetadata({
            BitDepth: 10,
            PixelFormat: 'yuv422p12le',
            Profile: 'Professional'
        })).toBeNull();
        expect(getAV1RawFormatStreamDefinitionFromMetadata({
            BitDepth: '8',
            PixelFormat: 'yuv420p12le',
            Profile: 'Professional'
        })).toBeNull();
    });

    it.each([ null, undefined, Number.NaN, '', '12' ])('reads BitDepth %j as omitted or agreeing', bitDepth => {
        expect(getAV1RawFormatStreamDefinitionFromMetadata({
            BitDepth: bitDepth,
            PixelFormat: 'yuv422p12le',
            Profile: 'Professional'
        })?.variant).toBe('professional422-12');
    });

    it('returns null for Main 10 and malformed metadata', () => {
        expect(getAV1RawFormatStreamDefinitionFromMetadata({
            BitDepth: 10,
            PixelFormat: 'yuv420p10le',
            Profile: 'Main'
        })).toBeNull();
        expect(getAV1RawFormatStreamDefinitionFromMetadata(null)).toBeNull();
        expect(getAV1RawFormatStreamDefinitionFromMetadata('Main')).toBeNull();
        expect(getAV1RawFormatStreamDefinitionFromMetadata({
            PixelFormat: 'yuv420p',
            Profile: 8
        })).toBeNull();
    });
});
