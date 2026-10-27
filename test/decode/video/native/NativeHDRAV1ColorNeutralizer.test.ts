import { describe, expect, it } from 'vitest';

import {
    NativeHDRAV1TemporalUnitNeutralizer,
    neutralizeAV1CodecStringColor,
    neutralizeNativeHDRAV1DecoderConfig
} from 'webgpu-player/decode/video/native/NativeHDRAV1ColorNeutralizer';
import { AV1OBUParseError, parseAV1OBUs } from 'webgpu-player/demux/av1/AV1OBUParser';
import { findAV1SequenceHeader } from 'webgpu-player/demux/av1/AV1SequenceHeaderParser';

// Sequence header OBUs the pinned FFmpeg's libaom wrote for 10-bit 4:2:0 streams
const PQ_SEQUENCE_HEADER_OBU = '0a0e0000002d4cffb3ccaf9509100904';
const HLG_SEQUENCE_HEADER_OBU = '0a0e0000002d4cffb3ccaf9509120904';
// FFmpeg's default when the frames carry no color: unspecified primaries and transfer with the BT.2020 matrix
const UNSPECIFIED_SEQUENCE_HEADER_OBU = '0a0e0000002d4cffb3ccaf9502020904';
// Full range and no color description, as Dolby Vision Profile 10.0 signals its base
const FULL_RANGE_SEQUENCE_HEADER_OBU = '0a0b0000002d4cffb3ccaf9484';
const TEMPORAL_DELIMITER_OBU = Uint8Array.of(0x12, 0x00);
// A frame OBU whose payload no rewrite reads
const FRAME_OBU = Uint8Array.of(0x32, 0x03, 0x10, 0x20, 0x30);
// av1C: marker and version, seq_profile and seq_level_idx_0, tier and chroma flags, no initial presentation delay
const AV1C_HEADER = Uint8Array.of(0x81, 0x05, 0x4C, 0x00);

function decodeHex(hex: string): Uint8Array {
    return Uint8Array.from(hex.match(/../gu) ?? [], (byteHex: string): number => Number.parseInt(byteHex, 16));
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
    const output = new Uint8Array(parts.reduce((byteLength: number, part: Uint8Array): number => byteLength + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

function createKeyUnit(sequenceHeaderHex: string): Uint8Array {
    return concatenate(TEMPORAL_DELIMITER_OBU, decodeHex(sequenceHeaderHex), FRAME_OBU);
}

function createConfiguration(description?: Uint8Array): VideoDecoderConfig {
    return {
        codec: 'av01.0.05M.10.0.110.09.16.09.0',
        codedHeight: 720,
        codedWidth: 1_280,
        ...(description ? { description } : {})
    };
}

describe('neutralizeAV1CodecStringColor', () => {
    it('rewrites the color fields of a long codecs string and keeps the rest', () => {
        expect(neutralizeAV1CodecStringColor('av01.0.13M.10.0.112.09.16.09.0')).toBe('av01.0.13M.10.0.112.01.01.01.0');
        expect(neutralizeAV1CodecStringColor('av01.0.13M.10.0.110.09.18.09.1')).toBe('av01.0.13M.10.0.110.01.01.01.0');
    });

    it('keeps a short codecs string, which already implies limited BT.709', () => {
        expect(neutralizeAV1CodecStringColor('av01.0.13M.10')).toBe('av01.0.13M.10');
    });
});

describe('neutralizeNativeHDRAV1DecoderConfig', () => {
    it('neutralizes the colorSpace and codecs string of a configuration without a description', () => {
        const neutralized = neutralizeNativeHDRAV1DecoderConfig(createConfiguration(), 'pq');

        expect(neutralized).toEqual({
            configuration: {
                codec: 'av01.0.05M.10.0.110.01.01.01.0',
                codedHeight: 720,
                codedWidth: 1_280,
                colorSpace: { fullRange: false, matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' }
            },
            decoderDescriptionValidated: false
        });
    });

    it('rewrites and validates the sequence header of an av1C description', () => {
        const description = concatenate(AV1C_HEADER, decodeHex(PQ_SEQUENCE_HEADER_OBU));

        const neutralized = neutralizeNativeHDRAV1DecoderConfig(createConfiguration(description), 'pq');
        const rewrittenDescription = neutralized.configuration.description as Uint8Array;

        expect(neutralized.decoderDescriptionValidated).toBe(true);
        expect(rewrittenDescription.subarray(0, AV1C_HEADER.byteLength)).toEqual(AV1C_HEADER);
        expect(findAV1SequenceHeader(rewrittenDescription.subarray(AV1C_HEADER.byteLength))?.colorConfig).toMatchObject({
            colorPrimaries: 1,
            fullRange: false,
            matrixCoefficients: 1,
            transferCharacteristics: 1
        });
        expect(description).toEqual(concatenate(AV1C_HEADER, decodeHex(PQ_SEQUENCE_HEADER_OBU)));
    });

    it('keeps an av1C description without configOBUs and leaves the in-band header to prove the route', () => {
        const neutralized = neutralizeNativeHDRAV1DecoderConfig(createConfiguration(AV1C_HEADER), 'pq');

        expect(neutralized.decoderDescriptionValidated).toBe(false);
        expect(neutralized.configuration.description).toEqual(AV1C_HEADER);
    });

    it('refuses a description whose sequence header is not the route\'s, or that is no av1C record', () => {
        expect(() => neutralizeNativeHDRAV1DecoderConfig(createConfiguration(concatenate(AV1C_HEADER, decodeHex(PQ_SEQUENCE_HEADER_OBU))), 'hlg'))
            .toThrow(TypeError);
        expect(() => neutralizeNativeHDRAV1DecoderConfig(createConfiguration(Uint8Array.of(0x01, 0x05, 0x4C, 0x00)), 'pq'))
            .toThrow('not a supported av1C record');
    });
});

describe('NativeHDRAV1TemporalUnitNeutralizer', () => {
    it.each([
        [ 'pq', PQ_SEQUENCE_HEADER_OBU ],
        [ 'hlg', HLG_SEQUENCE_HEADER_OBU ]
    ] as const)('neutralizes a %s key unit into a buffer of its own whose OBUs are views of it', (transfer, sequenceHeaderHex) => {
        const unit = createKeyUnit(sequenceHeaderHex);
        const neutralizer = new NativeHDRAV1TemporalUnitNeutralizer(transfer, false);

        const neutralized = neutralizer.neutralize(unit, parseAV1OBUs(unit));

        expect(neutralized.data).not.toBe(unit);
        expect(neutralized.data.byteLength).toBe(unit.byteLength);
        expect(neutralized.obus.map(obu => obu.data.buffer)).toEqual([ neutralized.data.buffer, neutralized.data.buffer, neutralized.data.buffer ]);
        expect(neutralized.obus.map(obu => obu.type)).toEqual([ 2, 1, 6 ]);
        expect(neutralized.obus[2].data).toEqual(FRAME_OBU);
        expect(findAV1SequenceHeader(neutralized.data)?.colorConfig).toMatchObject({
            colorPrimaries: 1,
            fullRange: false,
            matrixCoefficients: 1,
            transferCharacteristics: 1
        });
        expect(unit).toEqual(createKeyUnit(sequenceHeaderHex));
    });

    it('passes a unit without a sequence header through once a header proved the route', () => {
        const deltaUnit = concatenate(TEMPORAL_DELIMITER_OBU, FRAME_OBU);
        const deltaOBUs = parseAV1OBUs(deltaUnit);
        const neutralizer = new NativeHDRAV1TemporalUnitNeutralizer('pq', false);

        expect(() => neutralizer.neutralize(deltaUnit, deltaOBUs)).toThrow(AV1OBUParseError);
        const keyUnit = createKeyUnit(PQ_SEQUENCE_HEADER_OBU);
        neutralizer.neutralize(keyUnit, parseAV1OBUs(keyUnit));
        const passed = neutralizer.neutralize(deltaUnit, deltaOBUs);

        expect(passed.data).toBe(deltaUnit);
        expect(passed.obus).toBe(deltaOBUs);
        // A description that proved the route lets the first unit come without a header
        expect(new NativeHDRAV1TemporalUnitNeutralizer('pq', true).neutralize(deltaUnit, deltaOBUs).data).toBe(deltaUnit);
    });

    it.each([
        [ 'an HLG header on the PQ route', 'pq', HLG_SEQUENCE_HEADER_OBU ],
        [ 'a PQ header on the HLG route', 'hlg', PQ_SEQUENCE_HEADER_OBU ],
        [ 'unspecified primaries and transfer', 'pq', UNSPECIFIED_SEQUENCE_HEADER_OBU ],
        [ 'a full-range header without a color description', 'pq', FULL_RANGE_SEQUENCE_HEADER_OBU ]
    ] as const)('refuses %s', (_name, transfer, sequenceHeaderHex) => {
        const unit = createKeyUnit(sequenceHeaderHex);

        expect(() => new NativeHDRAV1TemporalUnitNeutralizer(transfer, true).neutralize(unit, parseAV1OBUs(unit)))
            .toThrow('does not match the expected limited-range BT.2020 HDR route');
    });
});
