import { describe, expect, it } from 'vitest';

import { createRawHDRCapabilityVector } from 'webgpu-player/capability/vectors/RawHDRCapabilityVectors';
import {
    AV1OBUParseError,
    parseAV1OBUs,
    type AV1OBU
} from 'webgpu-player/demux/av1/AV1OBUParser';
import {
    rewriteAV1SequenceHeaderColorDescription,
    rewriteAV1SequenceHeaderOBUsColorDescription,
    type AV1ColorDescription
} from 'webgpu-player/demux/av1/AV1SequenceHeaderColorRewriter';
import {
    parseAV1SequenceHeader,
    type AV1SequenceHeader
} from 'webgpu-player/demux/av1/AV1SequenceHeaderParser';

const BITS_PER_BYTE = 8;
const OBU_TYPE_TEMPORAL_DELIMITER = 2;
const OBU_TYPE_PADDING = 15;

const NEUTRAL_BT709: AV1ColorDescription = {
    colorPrimaries: 1,
    fullRange: false,
    matrixCoefficients: 1,
    transferCharacteristics: 1
};

// Sequence header OBUs of 10-bit BT.2020 streams the pinned FFmpeg encoded, each a whole OBU with its size field
const REAL_SEQUENCE_HEADER_OBUS = {
    'libaom HDR10': '0a0e0000002d4cffb3ccaf9509100904',
    'libaom HDR10 decoder model': '0a21040000000400000061780000000a530000075f915f90bcc4ff6736be5424402410',
    'libaom HDR10 reduced still picture': '0a0a186627fb3b5424402410',
    'libaom HDR10 timing info': '0a17040000000400000063400001bcc4ff6736be5424402410',
    'libaom HLG': '0a0e0000002d4cffb3ccaf9509120904',
    'SVT-AV1 HDR10': '0a0e0000002d4cffb3c4af9509100904',
    'SVT-AV1 HLG': '0a0e0000002d4cffb3c4af9509120904'
} as const;

function decodeHex(hex: string): Uint8Array {
    return Uint8Array.from(hex.match(/../gu) ?? [], (byteHex: string): number => Number.parseInt(byteHex, 16));
}

function parseSingleOBU(data: Uint8Array): AV1OBU {
    const obus = parseAV1OBUs(data);
    expect(obus).toHaveLength(1);
    return obus[0];
}

/** Returns a header with its color description and range blanked, the fields a rewrite changes. */
function withoutRewrittenColor(sequenceHeader: AV1SequenceHeader): unknown {
    return {
        ...sequenceHeader,
        colorConfig: {
            ...sequenceHeader.colorConfig,
            colorDescriptionPresent: null,
            colorPrimaries: null,
            fullRange: null,
            matrixCoefficients: null,
            transferCharacteristics: null
        }
    };
}

/** Writes a reduced still picture sequence header, the shortest syntax that reaches every color_config branch. */
function createReducedStillPictureHeader(
    profile: number,
    writeColorConfig: (writeBits: (value: number, bitCount: number) => void) => void
): Uint8Array {
    const bits: number[] = [];
    const writeBits = (value: number, bitCount: number): void => {
        for (let bitIndex = bitCount - 1; bitIndex >= 0; bitIndex -= 1) {
            bits.push(Math.floor(value / (2 ** bitIndex)) % 2);
        }
    };
    // seq_profile, still_picture, reduced_still_picture_header, seq_level_idx
    writeBits(profile, 3);
    writeBits(1, 1);
    writeBits(1, 1);
    writeBits(8, 5);
    // frame size bit counts and 64x64 maximum frame size
    writeBits(5, 4);
    writeBits(5, 4);
    writeBits(63, 6);
    writeBits(63, 6);
    // use_128x128_superblock through enable_restoration
    writeBits(0b010_110, 6);
    writeColorConfig(writeBits);
    // film_grain_params_present, then trailing_bits()
    writeBits(0, 1);
    bits.push(1);
    while (bits.length % BITS_PER_BYTE !== 0) {
        bits.push(0);
    }
    const payload = new Uint8Array(bits.length / BITS_PER_BYTE);
    bits.forEach((bitValue: number, bitIndex: number): void => {
        payload[Math.floor(bitIndex / BITS_PER_BYTE)] |= bitValue << (BITS_PER_BYTE - 1 - (bitIndex % BITS_PER_BYTE));
    });
    return payload;
}

describe('rewriteAV1SequenceHeaderColorDescription', () => {
    it.each(Object.entries(REAL_SEQUENCE_HEADER_OBUS))('neutralizes the %s sequence header without touching another field', (_name: string, hex: string) => {
        const obu = parseSingleOBU(decodeHex(hex));
        const source = parseAV1SequenceHeader(obu.payload);
        expect(source.colorConfig).toMatchObject({ colorDescriptionPresent: true, colorPrimaries: 9, fullRange: false, matrixCoefficients: 9 });

        const rewrittenPayload = rewriteAV1SequenceHeaderColorDescription(obu.payload, NEUTRAL_BT709);
        const rewritten = parseAV1SequenceHeader(rewrittenPayload);

        expect(rewrittenPayload.byteLength).toBe(obu.payload.byteLength);
        expect(rewritten.colorConfig).toMatchObject({
            colorDescriptionPresent: true,
            colorPrimaries: 1,
            fullRange: false,
            matrixCoefficients: 1,
            transferCharacteristics: 1
        });
        expect(withoutRewrittenColor(rewritten)).toEqual(withoutRewrittenColor(source));
    });

    it.each(Object.entries(REAL_SEQUENCE_HEADER_OBUS))('restores the %s sequence header bit for bit', (_name: string, hex: string) => {
        const obu = parseSingleOBU(decodeHex(hex));
        const source = parseAV1SequenceHeader(obu.payload).colorConfig;
        const neutralized = rewriteAV1SequenceHeaderColorDescription(obu.payload, NEUTRAL_BT709);

        const restored = rewriteAV1SequenceHeaderColorDescription(neutralized, {
            colorPrimaries: source.colorPrimaries,
            fullRange: source.fullRange,
            matrixCoefficients: source.matrixCoefficients,
            transferCharacteristics: source.transferCharacteristics
        });

        expect(restored).toEqual(obu.payload);
    });

    it('adds a color description to a header without one, 24 bits longer', () => {
        // The raw 4K vector's libaom header declares no color description
        const obu = parseAV1OBUs(createRawHDRCapabilityVector('av1').encodedKeyFrame)
            .find((candidate: AV1OBU): boolean => candidate.type === 1);
        if (!obu) {
            throw new Error('The raw AV1 vector has no sequence header');
        }
        const source = parseAV1SequenceHeader(obu.payload);
        expect(source.colorConfig.colorDescriptionPresent).toBe(false);

        const rewrittenPayload = rewriteAV1SequenceHeaderColorDescription(obu.payload, {
            colorPrimaries: 9,
            fullRange: false,
            matrixCoefficients: 9,
            transferCharacteristics: 16
        });
        const rewritten = parseAV1SequenceHeader(rewrittenPayload);

        expect(rewrittenPayload.byteLength).toBe(obu.payload.byteLength + 3);
        expect(rewritten.colorConfig).toMatchObject({ colorDescriptionPresent: true, colorPrimaries: 9, transferCharacteristics: 16 });
        expect(withoutRewrittenColor(rewritten)).toEqual(withoutRewrittenColor(source));
    });

    it('rewrites the range a full-range header codes', () => {
        const payload = createReducedStillPictureHeader(0, (writeBits) => {
            // high_bitdepth, mono_chrome, a BT.2020 PQ description, color_range full, chroma_sample_position 1, separate_uv_delta_q
            writeBits(1, 1);
            writeBits(0, 1);
            writeBits(1, 1);
            writeBits(9, 8);
            writeBits(16, 8);
            writeBits(9, 8);
            writeBits(1, 1);
            writeBits(1, 2);
            writeBits(1, 1);
        });

        const rewritten = parseAV1SequenceHeader(rewriteAV1SequenceHeaderColorDescription(payload, NEUTRAL_BT709)).colorConfig;

        expect(rewritten).toMatchObject({ chromaSamplePosition: 1, fullRange: false, separateUVDeltaQ: true, transferCharacteristics: 1 });
    });

    it('finds the description after the High profile, which codes no mono_chrome', () => {
        const payload = createReducedStillPictureHeader(1, (writeBits) => {
            // high_bitdepth, a description, color_range, separate_uv_delta_q
            writeBits(1, 1);
            writeBits(1, 1);
            writeBits(9, 8);
            writeBits(18, 8);
            writeBits(9, 8);
            writeBits(0, 1);
            writeBits(1, 1);
        });

        const rewritten = parseAV1SequenceHeader(rewriteAV1SequenceHeaderColorDescription(payload, NEUTRAL_BT709)).colorConfig;

        expect(rewritten).toMatchObject({ bitDepth: 10, colorPrimaries: 1, separateUVDeltaQ: true, subsamplingX: 0, subsamplingY: 0 });
    });

    it('finds the description after the Professional profile\'s twelve_bit and keeps its chroma format', () => {
        const payload = createReducedStillPictureHeader(2, (writeBits) => {
            // high_bitdepth, twelve_bit, mono_chrome, a description, color_range, 4:2:0, chroma_sample_position 2, separate_uv_delta_q
            writeBits(1, 1);
            writeBits(1, 1);
            writeBits(0, 1);
            writeBits(1, 1);
            writeBits(9, 8);
            writeBits(16, 8);
            writeBits(9, 8);
            writeBits(0, 1);
            writeBits(1, 1);
            writeBits(1, 1);
            writeBits(2, 2);
            writeBits(0, 1);
        });

        const rewritten = parseAV1SequenceHeader(rewriteAV1SequenceHeaderColorDescription(payload, NEUTRAL_BT709)).colorConfig;

        expect(rewritten).toMatchObject({ bitDepth: 12, chromaSamplePosition: 2, colorPrimaries: 1, subsamplingX: 1, subsamplingY: 1 });
    });

    it('keeps a monochrome header monochrome', () => {
        const payload = createReducedStillPictureHeader(0, (writeBits) => {
            // high_bitdepth, mono_chrome, a description, color_range
            writeBits(1, 1);
            writeBits(1, 1);
            writeBits(1, 1);
            writeBits(9, 8);
            writeBits(16, 8);
            writeBits(9, 8);
            writeBits(0, 1);
        });

        const rewritten = parseAV1SequenceHeader(rewriteAV1SequenceHeaderColorDescription(payload, NEUTRAL_BT709)).colorConfig;

        expect(rewritten).toMatchObject({ colorPrimaries: 1, monochrome: true, transferCharacteristics: 1 });
    });

    it('refuses the sRGB identity color, which codes no color_range', () => {
        const srgbPayload = createReducedStillPictureHeader(1, (writeBits) => {
            // high_bitdepth, BT.709 primaries, sRGB, identity, separate_uv_delta_q
            writeBits(0, 1);
            writeBits(1, 1);
            writeBits(1, 8);
            writeBits(13, 8);
            writeBits(0, 8);
            writeBits(0, 1);
        });
        const hdrPayload = parseSingleOBU(decodeHex(REAL_SEQUENCE_HEADER_OBUS['libaom HDR10'])).payload;

        expect(() => rewriteAV1SequenceHeaderColorDescription(srgbPayload, NEUTRAL_BT709)).toThrow(AV1OBUParseError);
        expect(() => rewriteAV1SequenceHeaderColorDescription(hdrPayload, {
            colorPrimaries: 1,
            fullRange: true,
            matrixCoefficients: 0,
            transferCharacteristics: 13
        })).toThrow(AV1OBUParseError);
    });

    it('refuses a code point outside 8 bits, a malformed header, and a header its check refuses', () => {
        const payload = parseSingleOBU(decodeHex(REAL_SEQUENCE_HEADER_OBUS['libaom HDR10'])).payload;

        expect(() => rewriteAV1SequenceHeaderColorDescription(payload, { ...NEUTRAL_BT709, colorPrimaries: 256 })).toThrow(RangeError);
        expect(() => rewriteAV1SequenceHeaderColorDescription(payload.subarray(0, 8), NEUTRAL_BT709)).toThrow(AV1OBUParseError);
        expect(() => rewriteAV1SequenceHeaderColorDescription(payload, NEUTRAL_BT709, (): void => {
            throw new TypeError('refused');
        })).toThrow('refused');
    });
});

describe('rewriteAV1SequenceHeaderOBUsColorDescription', () => {
    const SEQUENCE_HEADER_OBU = decodeHex(REAL_SEQUENCE_HEADER_OBUS['SVT-AV1 HDR10']);
    const TEMPORAL_DELIMITER_OBU = Uint8Array.of(OBU_TYPE_TEMPORAL_DELIMITER << 3 | 0x02, 0);
    // A padding OBU with an extension header and no size field, which runs to the end of its unit
    const TRAILING_PADDING_OBU = Uint8Array.of(OBU_TYPE_PADDING << 3 | 0x04, 0x08, 0xAA, 0xBB);

    function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
        const output = new Uint8Array(parts.reduce((byteLength: number, part: Uint8Array): number => byteLength + part.byteLength, 0));
        let offset = 0;
        for (const part of parts) {
            output.set(part, offset);
            offset += part.byteLength;
        }
        return output;
    }

    it('rewrites every sequence header of a unit and keeps the other OBUs byte for byte', () => {
        const unit = concatenate(TEMPORAL_DELIMITER_OBU, SEQUENCE_HEADER_OBU, SEQUENCE_HEADER_OBU, TRAILING_PADDING_OBU);

        const rewritten = rewriteAV1SequenceHeaderOBUsColorDescription(parseAV1OBUs(unit), NEUTRAL_BT709);
        if (!rewritten) {
            throw new Error('The unit was not rewritten');
        }
        const rewrittenOBUs = parseAV1OBUs(rewritten);

        expect(rewritten.byteLength).toBe(unit.byteLength);
        expect(rewrittenOBUs.map((obu: AV1OBU): number => obu.type)).toEqual([ 2, 1, 1, 15 ]);
        expect(rewrittenOBUs[0].data).toEqual(TEMPORAL_DELIMITER_OBU);
        expect(rewrittenOBUs[3].data).toEqual(TRAILING_PADDING_OBU);
        for (const obu of rewrittenOBUs.slice(1, 3)) {
            expect(parseAV1SequenceHeader(obu.payload).colorConfig).toMatchObject({ colorPrimaries: 1, matrixCoefficients: 1, transferCharacteristics: 1 });
        }
        expect(unit).toEqual(concatenate(TEMPORAL_DELIMITER_OBU, SEQUENCE_HEADER_OBU, SEQUENCE_HEADER_OBU, TRAILING_PADDING_OBU));
    });

    it('returns null for a unit without a sequence header', () => {
        expect(rewriteAV1SequenceHeaderOBUsColorDescription(parseAV1OBUs(TEMPORAL_DELIMITER_OBU), NEUTRAL_BT709)).toBeNull();
    });

    it('keeps an obu_size coded in more bytes than it needs when the payload length holds', () => {
        const payload = SEQUENCE_HEADER_OBU.subarray(2);
        const paddedSizeOBU = concatenate(Uint8Array.of(SEQUENCE_HEADER_OBU[0], 0x80 | payload.byteLength, 0x80, 0x00), payload);

        const rewritten = rewriteAV1SequenceHeaderOBUsColorDescription(parseAV1OBUs(paddedSizeOBU), NEUTRAL_BT709);

        expect(rewritten?.subarray(0, 4)).toEqual(paddedSizeOBU.subarray(0, 4));
        expect(rewritten?.byteLength).toBe(paddedSizeOBU.byteLength);
    });

    it('recodes obu_size, and an extension header stays, when a header gains its color description', () => {
        const source = parseAV1OBUs(createRawHDRCapabilityVector('av1').encodedKeyFrame).find((obu: AV1OBU): boolean => obu.type === 1);
        if (!source) {
            throw new Error('The raw AV1 vector has no sequence header');
        }
        const extendedOBU = concatenate(Uint8Array.of(source.data[0] | 0x04, 0x00, source.payload.byteLength), source.payload);
        const lastOBUWithoutSize = concatenate(Uint8Array.of(source.data[0] & ~0x02), source.payload);

        const rewritten = rewriteAV1SequenceHeaderOBUsColorDescription(
            parseAV1OBUs(concatenate(extendedOBU, lastOBUWithoutSize)),
            { ...NEUTRAL_BT709, transferCharacteristics: 16 }
        );
        const rewrittenOBUs = parseAV1OBUs(rewritten ?? new Uint8Array());

        expect(rewrittenOBUs).toHaveLength(2);
        expect(rewrittenOBUs[0].data.subarray(0, 3)).toEqual(Uint8Array.of(source.data[0] | 0x04, 0x00, source.payload.byteLength + 3));
        expect(rewrittenOBUs[1].data[0]).toBe(source.data[0] & ~0x02);
        for (const obu of rewrittenOBUs) {
            expect(parseAV1SequenceHeader(obu.payload).colorConfig).toMatchObject({ colorDescriptionPresent: true, transferCharacteristics: 16 });
        }
    });
});
