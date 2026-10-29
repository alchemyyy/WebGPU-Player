import { describe, expect, it } from 'vitest';

import {
    rewriteHEVCAccessUnitColorDescriptionToBT709,
    rewriteHEVCAccessUnitSPS,
    type HEVCNALFormat
} from 'webgpu-player/demux/dolby-vision/DolbyVisionHEVCSplitter';
import { parseHEVCDecoderConfiguration } from 'webgpu-player/demux/hevc/HEVCDecoderConfiguration';
import { parseHEVCSPS, repairHEVCSPSDefaultDisplayWindow, rewriteHEVCSPSColorDescriptionToBT709 } from 'webgpu-player/demux/hevc/HEVCSPSParser';
import {
    neutralizeNativeHDRHEVCDecoderConfigWithValidation,
    repairHEVCDecoderConfigDefaultDisplayWindow
} from 'webgpu-player/decode/video/native/NativeHDRHEVCColorNeutralizer';

import { createBytesFromHex } from '../../../helpers/byteArrays';

const MAIN10_PQ_SPS = createBytesFromHex(
    '4201010220000003009000000300000300ffa005020169365959a4932bc05a848804820000030002000003000210'
);
// A Main10 SPS whose VUI signals BT.2020 primaries and matrix with the BT.2020 10-bit transfer, as HLG-compatible streams do
const MAIN10_BT2020_10_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05a848704820000030002000003003010'
);
// MAIN10_PQ_SPS with its default_display_window_flag, a 0 after frame_field_info_present_flag, removed, as old x265 builds wrote the VUI
const MAIN10_PQ_SPS_WITHOUT_DEFAULT_DISPLAY_WINDOW_FLAG = createBytesFromHex(
    '4201010220000003009000000300000300ffa005020169365959a4932bc05a848804840000030004000003000420'
);
// An old x265 build's Main 10 SDR SPS without the flag, and the SPS FFmpeg's reading of it implies
const X265_MISSING_DEFAULT_DISPLAY_WINDOW_SPS = createBytesFromHex(
    '420101022000000300900000030000030096a001e0200649f4d96666924c2e02000007d20000bb8010'
);
const X265_REPAIRED_DEFAULT_DISPLAY_WINDOW_SPS = createBytesFromHex(
    '420101022000000300900000030000030096a001e0200649f4d96666924c2e0100000303e900005dc008'
);
const HLG_PREFERRED_TRANSFER_CHARACTERISTICS = 18;
const PQ_PREFERRED_TRANSFER_CHARACTERISTICS = 16;
const NEUTRAL_COLOR_SPACE = {
    fullRange: false,
    matrix: 'bt709',
    primaries: 'bt709',
    transfer: 'bt709'
};
const VPS = new Uint8Array([ 64, 1, 1 ]);
const PPS = new Uint8Array([ 68, 1, 2 ]);
const IDR = new Uint8Array([ 38, 1, 3 ]);

function appendNALUnitArray(
    descriptionBytes: number[],
    nalUnitType: number,
    nalUnits: readonly Uint8Array[]
): void {
    descriptionBytes.push(
        0x80 | nalUnitType,
        Math.floor(nalUnits.length / 256),
        nalUnits.length % 256
    );
    for (const nalUnit of nalUnits) {
        descriptionBytes.push(
            Math.floor(nalUnit.byteLength / 256),
            nalUnit.byteLength % 256
        );
        for (const byteValue of nalUnit) {
            descriptionBytes.push(byteValue);
        }
    }
}

function createHVCCDescriptionWithSPS(sequenceParameterSets: readonly Uint8Array[]): Uint8Array {
    const descriptionBytes: number[] = new Array<number>(23).fill(0);
    descriptionBytes[0] = 1;
    descriptionBytes[1] = 2;
    descriptionBytes[16] = 1;
    descriptionBytes[17] = 2;
    descriptionBytes[18] = 2;
    descriptionBytes[21] = 3;
    descriptionBytes[22] = sequenceParameterSets.length > 0 ? 3 : 2;
    appendNALUnitArray(descriptionBytes, 32, [ VPS ]);
    if (sequenceParameterSets.length > 0) {
        appendNALUnitArray(descriptionBytes, 33, sequenceParameterSets);
    }
    appendNALUnitArray(descriptionBytes, 34, [ PPS ]);
    return new Uint8Array(descriptionBytes);
}

function createHVCCDescription(includeSPS = true, spsCount = 1): Uint8Array {
    return createHVCCDescriptionWithSPS(
        includeSPS ? new Array<Uint8Array>(spsCount).fill(MAIN10_PQ_SPS) : []
    );
}

function createDecoderConfig(description: Uint8Array): VideoDecoderConfig {
    return {
        codec: 'hvc1.2.4.L120.B0',
        codedHeight: 1_080,
        codedWidth: 1_920,
        description,
        hardwareAcceleration: 'prefer-hardware'
    };
}

function encodeAccessUnit(
    nalUnits: readonly Uint8Array[],
    format: HEVCNALFormat
): Uint8Array {
    const prefixByteLength = format.kind === 'annex-b' ? 4 : format.lengthSize;
    let byteLength = 0;
    for (const nalUnit of nalUnits) {
        byteLength += prefixByteLength + nalUnit.byteLength;
    }
    const output = new Uint8Array(byteLength);
    let outputOffset = 0;
    for (const nalUnit of nalUnits) {
        if (format.kind === 'annex-b') {
            output.set([ 0, 0, 0, 1 ], outputOffset);
        } else {
            let remainingLength = nalUnit.byteLength;
            for (let byteIndex = format.lengthSize - 1; byteIndex >= 0; byteIndex -= 1) {
                output[outputOffset + byteIndex] = remainingLength % 256;
                remainingLength = Math.floor(remainingLength / 256);
            }
        }
        outputOffset += prefixByteLength;
        output.set(nalUnit, outputOffset);
        outputOffset += nalUnit.byteLength;
    }
    return output;
}

function getFirstNALUnit(accessUnit: Uint8Array, format: HEVCNALFormat): Uint8Array {
    if (format.kind === 'length-prefixed') {
        let nalUnitByteLength = 0;
        for (let byteIndex = 0; byteIndex < format.lengthSize; byteIndex += 1) {
            nalUnitByteLength = (nalUnitByteLength * 256) + accessUnit[byteIndex];
        }
        return accessUnit.subarray(
            format.lengthSize,
            format.lengthSize + nalUnitByteLength
        );
    }
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

describe('NativeHDRHEVCColorNeutralizer', () => {
    it('rebuilds HVCC while preserving non-SPS arrays and configuration fields', () => {
        const description = createHVCCDescription(true, 2);
        const neutralized = neutralizeNativeHDRHEVCDecoderConfigWithValidation(
            createDecoderConfig(description),
            'pq'
        );
        const rewritten = neutralized.configuration.description as Uint8Array;
        const originalConfiguration = parseHEVCDecoderConfiguration(description);
        const rewrittenConfiguration = parseHEVCDecoderConfiguration(rewritten);

        expect(neutralized.decoderDescriptionValidated).toBe(true);
        expect(description).not.toEqual(rewritten);
        expect(rewrittenConfiguration).toMatchObject({
            bitDepth: originalConfiguration.bitDepth,
            chromaFormat: originalConfiguration.chromaFormat,
            lengthSize: originalConfiguration.lengthSize,
            profileIDC: originalConfiguration.profileIDC
        });
        expect(rewrittenConfiguration.sequenceParameterSets).toHaveLength(2);
        for (const sequenceParameterSet of rewrittenConfiguration.sequenceParameterSets) {
            expect(parseHEVCSPS(sequenceParameterSet).colorSpace).toEqual({
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            });
        }
        expect(() => neutralizeNativeHDRHEVCDecoderConfigWithValidation(
            createDecoderConfig(rewritten),
            'pq'
        )).toThrow('expected limited-range BT.2020 HDR route');
        expect(() => neutralizeNativeHDRHEVCDecoderConfigWithValidation(
            createDecoderConfig(description),
            'hlg'
        )).toThrow('expected limited-range BT.2020 HDR route');
    });

    it('neutralizes config color metadata and an owned decoder description', () => {
        const description = createHVCCDescription();
        const neutralized = neutralizeNativeHDRHEVCDecoderConfigWithValidation(
            createDecoderConfig(description),
            'pq'
        );
        const configuration = neutralized.configuration;

        expect(neutralized.decoderDescriptionValidated).toBe(true);
        expect(configuration).toMatchObject({
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            hardwareAcceleration: 'prefer-hardware'
        });
        expect(configuration.description).not.toBe(description);
    });

    it('rewrites only base-layer HVCC SPS units and passes other layers through', () => {
        // An SPS with nuh_layer_id 1, such as an alpha layer's, whose payload is no base-layer SPS
        const otherLayerSPS = new Uint8Array([ 33 << 1, (1 << 3) | 1, 0xFF, 0xFF ]);
        const neutralized = neutralizeNativeHDRHEVCDecoderConfigWithValidation(
            createDecoderConfig(createHVCCDescriptionWithSPS([ otherLayerSPS, MAIN10_PQ_SPS ])),
            'pq'
        );
        const rewritten = neutralized.configuration.description as Uint8Array;
        const rewrittenConfiguration = parseHEVCDecoderConfiguration(rewritten);
        const firstSPSOffset = 36;

        expect(neutralized.decoderDescriptionValidated).toBe(true);
        expect(Array.from(rewritten.subarray(firstSPSOffset, firstSPSOffset + otherLayerSPS.byteLength)))
            .toEqual(Array.from(otherLayerSPS));
        expect(rewrittenConfiguration.sequenceParameterSets).toHaveLength(1);
        expect(parseHEVCSPS(rewrittenConfiguration.sequenceParameterSets[0]).colorSpace).toEqual({
            fullRange: false,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'bt709'
        });
        expect(neutralizeNativeHDRHEVCDecoderConfigWithValidation(
            createDecoderConfig(createHVCCDescriptionWithSPS([ otherLayerSPS ])),
            'pq'
        ).decoderDescriptionValidated).toBe(false);
    });

    it('rewrites Annex B and length-prefixed in-band SPS units', () => {
        const formats: readonly HEVCNALFormat[] = [
            { kind: 'annex-b' },
            { kind: 'length-prefixed', lengthSize: 4 }
        ];
        for (const format of formats) {
            const accessUnit = encodeAccessUnit([ MAIN10_PQ_SPS, IDR ], format);
            const rewritten = rewriteHEVCAccessUnitColorDescriptionToBT709(
                accessUnit,
                format
            );

            expect(rewritten).not.toBeNull();
            expect(parseHEVCSPS(getFirstNALUnit(rewritten as Uint8Array, format)).colorSpace)
                .toEqual({
                    fullRange: false,
                    matrix: 'bt709',
                    primaries: 'bt709',
                    transfer: 'bt709'
                });
        }
    });

    it('restores a missing default_display_window_flag before neutralizing, in HVCC and in band', () => {
        const neutralizedSPS = rewriteHEVCSPSColorDescriptionToBT709(MAIN10_PQ_SPS, 'pq');
        const neutralized = neutralizeNativeHDRHEVCDecoderConfigWithValidation(
            createDecoderConfig(createHVCCDescriptionWithSPS([ MAIN10_PQ_SPS_WITHOUT_DEFAULT_DISPLAY_WINDOW_FLAG ])),
            'pq'
        );
        expect(neutralized.decoderDescriptionValidated).toBe(true);
        expect(parseHEVCDecoderConfiguration(neutralized.configuration.description as Uint8Array).sequenceParameterSets).toEqual([ neutralizedSPS ]);

        const format = { kind: 'length-prefixed', lengthSize: 4 } as const;
        const rewritten = rewriteHEVCAccessUnitColorDescriptionToBT709(
            encodeAccessUnit([ MAIN10_PQ_SPS_WITHOUT_DEFAULT_DISPLAY_WINDOW_FLAG, IDR ], format),
            format,
            'pq'
        );
        expect(rewritten).toEqual(encodeAccessUnit([ neutralizedSPS, IDR ], format));
    });

    it('repairs an HVCC SPS without default_display_window_flag on any route, and keeps a configuration that needs no repair', () => {
        const configuration = createDecoderConfig(createHVCCDescriptionWithSPS([ X265_MISSING_DEFAULT_DISPLAY_WINDOW_SPS ]));
        const repaired = repairHEVCDecoderConfigDefaultDisplayWindow(configuration);
        expect(repaired).toEqual({
            ...configuration,
            description: createHVCCDescriptionWithSPS([ X265_REPAIRED_DEFAULT_DISPLAY_WINDOW_SPS ])
        });
        // The description's other bytes and the source configuration stay as they were
        expect(configuration.description).toEqual(createHVCCDescriptionWithSPS([ X265_MISSING_DEFAULT_DISPLAY_WINDOW_SPS ]));

        const unchanged = createDecoderConfig(createHVCCDescription());
        expect(repairHEVCDecoderConfigDefaultDisplayWindow(unchanged)).toBe(unchanged);
        const withoutDescription: VideoDecoderConfig = { codec: 'hvc1.2.4.L120.B0' };
        expect(repairHEVCDecoderConfigDefaultDisplayWindow(withoutDescription)).toBe(withoutDescription);
    });

    it('rewrites an access unit\'s SPS only where the transform replaces one', () => {
        const format = { kind: 'annex-b' } as const;
        expect(rewriteHEVCAccessUnitSPS(encodeAccessUnit([ VPS, X265_MISSING_DEFAULT_DISPLAY_WINDOW_SPS, PPS, IDR ], format), format, repairHEVCSPSDefaultDisplayWindow))
            .toEqual(encodeAccessUnit([ VPS, X265_REPAIRED_DEFAULT_DISPLAY_WINDOW_SPS, PPS, IDR ], format));
        expect(rewriteHEVCAccessUnitSPS(encodeAccessUnit([ VPS, MAIN10_PQ_SPS, PPS, IDR ], format), format, repairHEVCSPSDefaultDisplayWindow))
            .toBeNull();
        expect(rewriteHEVCAccessUnitSPS(encodeAccessUnit([ IDR ], format), format, repairHEVCSPSDefaultDisplayWindow)).toBeNull();
    });

    it('accepts an HLG-compatible hvcC SPS on the HLG route unless an SEI value names another transfer', () => {
        const configuration = createDecoderConfig(
            createHVCCDescriptionWithSPS([ MAIN10_BT2020_10_SPS ])
        );
        const neutralized = neutralizeNativeHDRHEVCDecoderConfigWithValidation(configuration, 'hlg');
        const rewrittenConfiguration = parseHEVCDecoderConfiguration(
            neutralized.configuration.description as Uint8Array
        );

        expect(neutralized.decoderDescriptionValidated).toBe(true);
        expect(parseHEVCSPS(rewrittenConfiguration.sequenceParameterSets[0]).colorSpace)
            .toEqual(NEUTRAL_COLOR_SPACE);
        expect(() => neutralizeNativeHDRHEVCDecoderConfigWithValidation(
            configuration,
            'hlg',
            PQ_PREFERRED_TRANSFER_CHARACTERISTICS
        )).toThrow('expected limited-range BT.2020 HDR route');
        expect(() => neutralizeNativeHDRHEVCDecoderConfigWithValidation(configuration, 'pq'))
            .toThrow('expected limited-range BT.2020 HDR route');
        expect(neutralizeNativeHDRHEVCDecoderConfigWithValidation(
            configuration,
            'pq',
            PQ_PREFERRED_TRANSFER_CHARACTERISTICS
        ).decoderDescriptionValidated).toBe(true);
    });

    it('checks an in-band HLG-compatible SPS against its access unit SEI value', () => {
        const format: HEVCNALFormat = { kind: 'annex-b' };
        const accessUnit = encodeAccessUnit([ MAIN10_BT2020_10_SPS, IDR ], format);

        for (const preferredTransferCharacteristics of [ null, HLG_PREFERRED_TRANSFER_CHARACTERISTICS ]) {
            const rewritten = rewriteHEVCAccessUnitColorDescriptionToBT709(
                accessUnit,
                format,
                'hlg',
                preferredTransferCharacteristics
            );
            expect(parseHEVCSPS(getFirstNALUnit(rewritten as Uint8Array, format)).colorSpace)
                .toEqual(NEUTRAL_COLOR_SPACE);
        }
        expect(() => rewriteHEVCAccessUnitColorDescriptionToBT709(
            accessUnit,
            format,
            'hlg',
            PQ_PREFERRED_TRANSFER_CHARACTERISTICS
        )).toThrow('expected limited-range BT.2020 HDR route');
    });

    it('reports absent SPS records and access units without rewriting unrelated data', () => {
        expect(neutralizeNativeHDRHEVCDecoderConfigWithValidation(
            createDecoderConfig(createHVCCDescription(false)),
            'pq'
        ).decoderDescriptionValidated).toBe(false);
        expect(rewriteHEVCAccessUnitColorDescriptionToBT709(
            encodeAccessUnit([ IDR ], { kind: 'annex-b' }),
            { kind: 'annex-b' }
        )).toBeNull();
    });

    it('rejects malformed HVCC and length-prefixed NAL boundaries', () => {
        const trailingHVCC = new Uint8Array(createHVCCDescription().byteLength + 1);
        trailingHVCC.set(createHVCCDescription());
        expect(() => neutralizeNativeHDRHEVCDecoderConfigWithValidation(
            createDecoderConfig(trailingHVCC),
            'pq'
        )).toThrow('trailing data');

        const truncatedHVCC = createHVCCDescription();
        const firstSPSLengthOffset = 34;
        truncatedHVCC[firstSPSLengthOffset] = 0xFF;
        truncatedHVCC[firstSPSLengthOffset + 1] = 0xFF;
        expect(() => neutralizeNativeHDRHEVCDecoderConfigWithValidation(
            createDecoderConfig(truncatedHVCC),
            'pq'
        )).toThrow('invalid NAL unit');

        expect(() => rewriteHEVCAccessUnitColorDescriptionToBT709(
            new Uint8Array([ 0, 0, 0, 8, 66, 1 ]),
            { kind: 'length-prefixed', lengthSize: 4 }
        )).toThrow('invalid NAL unit length');
        expect(() => rewriteHEVCAccessUnitColorDescriptionToBT709(
            new Uint8Array([ 0, 0, 0, 1 ]),
            { kind: 'annex-b' }
        )).toThrow('missing its two-byte header');
    });
});
