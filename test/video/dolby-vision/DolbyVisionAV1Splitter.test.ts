import { describe, expect, it } from 'vitest';

import {
    AV1_OBU_TYPE_FRAME,
    AV1_OBU_TYPE_FRAME_HEADER,
    AV1_OBU_TYPE_METADATA,
    AV1_OBU_TYPE_SEQUENCE_HEADER,
    AV1_OBU_TYPE_TEMPORAL_DELIMITER,
    AV1_OBU_TYPE_TILE_GROUP,
    AV1OBUParseError
} from 'webgpu-player/video/av1/AV1OBUParser';
import { splitDolbyVisionAV1TemporalUnit } from 'webgpu-player/video/dolby-vision/DolbyVisionAV1Splitter';
import { createNativeVideoCapabilityVector } from 'webgpu-player/capability/vectors/NativeVideoCapabilityVectors';

import { DOLBY_VISION_ITUT_T35_PAYLOAD_PREFIX } from '../../helpers/dolbyVisionAV1ITUTT35Payload';

const OBU_EXTENSION_FLAG = 0x04;
const OBU_HAS_SIZE_FIELD_FLAG = 0x02;
const METADATA_TYPE_HDR_CLL = 1;
const METADATA_TYPE_ITUT_T35 = 4;
// The Dolby Vision payload prefix, then two payload bytes the splitter does not read
const DOLBY_VISION_T35_MESSAGE = [ ...DOLBY_VISION_ITUT_T35_PAYLOAD_PREFIX, 0x19, 0x80 ];
// Country code, the HDR10+ provider code and oriented code, application identifier and version
const HDR10_PLUS_T35_MESSAGE = [ 0xB5, 0x00, 0x3C, 0x00, 0x01, 0x04, 0x01, 0x40, 0x80 ];

function createOBU(
    type: number,
    payload: readonly number[],
    extension: number | null = null,
    hasSizeField = true
): Uint8Array {
    if (payload.length > 127) {
        throw new RangeError('The test OBU helper writes one-byte sizes');
    }
    const header = (type << 3)
        | (extension === null ? 0 : OBU_EXTENSION_FLAG)
        | (hasSizeField ? OBU_HAS_SIZE_FIELD_FLAG : 0);
    return new Uint8Array([
        header,
        ...(extension === null ? [] : [ extension ]),
        ...(hasSizeField ? [ payload.length ] : []),
        ...payload
    ]);
}

function createDolbyVisionMetadataOBU(rpuByte: number, extension: number | null = null): Uint8Array {
    return createOBU(
        AV1_OBU_TYPE_METADATA,
        [ METADATA_TYPE_ITUT_T35, ...DOLBY_VISION_T35_MESSAGE, rpuByte, 0x80 ],
        extension
    );
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
    const output = new Uint8Array(parts.reduce(
        (byteLength: number, part: Uint8Array): number => byteLength + part.byteLength,
        0
    ));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

describe('DolbyVisionAV1Splitter', () => {
    it('removes the Dolby Vision metadata OBU after a temporal delimiter and returns its T.35 message', () => {
        const temporalDelimiter = createOBU(AV1_OBU_TYPE_TEMPORAL_DELIMITER, []);
        const sequenceHeader = createOBU(AV1_OBU_TYPE_SEQUENCE_HEADER, [ 1, 2, 3 ]);
        const frame = createOBU(AV1_OBU_TYPE_FRAME, [ 4, 5, 6 ]);

        const result = splitDolbyVisionAV1TemporalUnit(concatenate([
            temporalDelimiter,
            sequenceHeader,
            createDolbyVisionMetadataOBU(0x42),
            frame
        ]));

        expect(Array.from(result.decoderData)).toEqual(Array.from(concatenate([
            temporalDelimiter,
            sequenceHeader,
            frame
        ])));
        expect(result.hasFrame).toBe(true);
        expect(result.rpuPayloads.map(payload => Array.from(payload))).toEqual([
            [ ...DOLBY_VISION_T35_MESSAGE, 0x42, 0x80 ]
        ]);
    });

    it('keeps other metadata, including HDR10+ T.35, in order and untouched', () => {
        const hdr10PlusMetadata = createOBU(
            AV1_OBU_TYPE_METADATA,
            [ METADATA_TYPE_ITUT_T35, ...HDR10_PLUS_T35_MESSAGE ]
        );
        const contentLightMetadata = createOBU(
            AV1_OBU_TYPE_METADATA,
            [ METADATA_TYPE_HDR_CLL, 0x03, 0xE8, 0x01, 0x90, 0x80 ]
        );
        // A 0xFF country code is followed by its extension byte, so Dolby's code here is not a country code
        const extendedCountryMetadata = createOBU(
            AV1_OBU_TYPE_METADATA,
            [ METADATA_TYPE_ITUT_T35, 0xFF, ...DOLBY_VISION_T35_MESSAGE ]
        );
        const frameHeader = createOBU(AV1_OBU_TYPE_FRAME_HEADER, [ 7 ]);
        const tileGroup = createOBU(AV1_OBU_TYPE_TILE_GROUP, [ 8, 9 ]);

        const result = splitDolbyVisionAV1TemporalUnit(concatenate([
            hdr10PlusMetadata,
            createDolbyVisionMetadataOBU(0x11),
            contentLightMetadata,
            extendedCountryMetadata,
            frameHeader,
            tileGroup
        ]));

        expect(Array.from(result.decoderData)).toEqual(Array.from(concatenate([
            hdr10PlusMetadata,
            contentLightMetadata,
            extendedCountryMetadata,
            frameHeader,
            tileGroup
        ])));
        expect(result.hasFrame).toBe(true);
        expect(result.rpuPayloads).toHaveLength(1);
    });

    it('matches Dolby Vision metadata OBUs with extension headers and returns every one', () => {
        const frame = createOBU(AV1_OBU_TYPE_FRAME, [ 1 ], 0x10);

        const result = splitDolbyVisionAV1TemporalUnit(concatenate([
            createDolbyVisionMetadataOBU(0x21, 0x10),
            createDolbyVisionMetadataOBU(0x22),
            frame
        ]));

        expect(Array.from(result.decoderData)).toEqual(Array.from(frame));
        expect(result.rpuPayloads.map(payload => payload.at(-2))).toEqual([ 0x21, 0x22 ]);
    });

    it('takes the rest of the unit as the payload of a last OBU without a size field', () => {
        const frame = createOBU(AV1_OBU_TYPE_FRAME, [ 1, 2 ]);
        const lastMetadata = createOBU(
            AV1_OBU_TYPE_METADATA,
            [ METADATA_TYPE_ITUT_T35, ...DOLBY_VISION_T35_MESSAGE, 0x33, 0x80 ],
            null,
            false
        );
        const unsizedFrame = createOBU(AV1_OBU_TYPE_FRAME, [ 3, 4 ], null, false);

        const metadataResult = splitDolbyVisionAV1TemporalUnit(concatenate([ frame, lastMetadata ]));
        const frameResult = splitDolbyVisionAV1TemporalUnit(concatenate([
            createDolbyVisionMetadataOBU(0x34),
            unsizedFrame
        ]));

        expect(Array.from(metadataResult.decoderData)).toEqual(Array.from(frame));
        expect(Array.from(metadataResult.rpuPayloads[0])).toEqual([ ...DOLBY_VISION_T35_MESSAGE, 0x33, 0x80 ]);
        expect(Array.from(frameResult.decoderData)).toEqual(Array.from(unsizedFrame));
        expect(frameResult.hasFrame).toBe(true);
    });

    it('returns a unit without an RPU itself, without copying', () => {
        const temporalUnit = createNativeVideoCapabilityVector('av1').encodedKeyFrame;

        const result = splitDolbyVisionAV1TemporalUnit(temporalUnit);

        expect(result.decoderData).toBe(temporalUnit);
        expect(result.hasFrame).toBe(true);
        expect(result.rpuPayloads).toEqual([]);
    });

    it('returns owned RPU payloads and reports a unit without a frame', () => {
        const data = concatenate([
            createOBU(AV1_OBU_TYPE_SEQUENCE_HEADER, [ 1 ]),
            createDolbyVisionMetadataOBU(0x55)
        ]);

        const result = splitDolbyVisionAV1TemporalUnit(data);
        data.fill(0);

        expect(result.hasFrame).toBe(false);
        expect(Array.from(result.rpuPayloads[0])).toEqual([ ...DOLBY_VISION_T35_MESSAGE, 0x55, 0x80 ]);
    });

    it('fails with a typed error instead of passing a unit it cannot walk', () => {
        const frame = createOBU(AV1_OBU_TYPE_FRAME, [ 1, 2 ]);
        const truncatedUnit = concatenate([ createDolbyVisionMetadataOBU(0x66), frame ]).subarray(0, -1);
        const forbiddenBitUnit = concatenate([ frame, new Uint8Array([ 0x80 | 0x32, 0 ]) ]);
        const unreadableMetadataUnit = concatenate([
            createOBU(AV1_OBU_TYPE_METADATA, [ 0x80 ]),
            frame
        ]);

        expect(() => splitDolbyVisionAV1TemporalUnit(truncatedUnit)).toThrow(AV1OBUParseError);
        expect(() => splitDolbyVisionAV1TemporalUnit(forbiddenBitUnit)).toThrow(AV1OBUParseError);
        expect(() => splitDolbyVisionAV1TemporalUnit(unreadableMetadataUnit)).toThrow(AV1OBUParseError);
    });
});
