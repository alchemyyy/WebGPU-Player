import { EncodedPacket } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import DolbyVisionEncodedMetadataQueue, {
    DolbyVisionAV1EncodedMetadataQueue,
    MAXIMUM_DOLBY_VISION_PENDING_FRAME_COUNT
} from 'webgpu-player/video/dolby-vision/DolbyVisionEncodedMetadata';
import {
    isTransferableDolbyVisionEncodedFrameMetadata,
    takeTransferableDolbyVisionEncodedFrameMetadata
} from 'webgpu-player/video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import { AV1OBUParseError } from 'webgpu-player/video/av1/AV1OBUParser';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';

import { DOLBY_VISION_ITUT_T35_PAYLOAD_PREFIX } from '../../helpers/dolbyVisionAV1ITUTT35Payload';

function createRPUParser(
    packedRPUData: ArrayBuffer = createDolbyVisionAuthorizationRPUVector()
): {
        parse: ReturnType<typeof vi.fn>
    } {
    return {
        parse: vi.fn(async (): Promise<ArrayBuffer> => (
            packedRPUData.slice(0)
        ))
    };
}

function createNALUnit(type: number, payload: readonly number[]): Uint8Array {
    return new Uint8Array([ (type & 0x3F) << 1, 1, ...payload ]);
}

function encodeAnnexBNALUnits(nalUnits: readonly Uint8Array[]): Uint8Array {
    const startCode = new Uint8Array([ 0, 0, 0, 1 ]);
    const byteLength = nalUnits.reduce(
        (totalByteLength: number, nalUnit: Uint8Array): number => (
            totalByteLength + startCode.byteLength + nalUnit.byteLength
        ),
        0
    );
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const nalUnit of nalUnits) {
        output.set(startCode, offset);
        offset += startCode.byteLength;
        output.set(nalUnit, offset);
        offset += nalUnit.byteLength;
    }
    return output;
}

function getAnnexBNALUnitTypes(data: Uint8Array): number[] {
    const types: number[] = [];
    for (let offset = 0; offset < data.byteLength;) {
        expect(Array.from(data.subarray(offset, offset + 4))).toEqual([ 0, 0, 0, 1 ]);
        const nalUnitOffset = offset + 4;
        types.push((data[nalUnitOffset] >> 1) & 0x3F);
        let nextOffset = nalUnitOffset + 2;
        while (
            nextOffset + 4 <= data.byteLength
            && !(data[nextOffset] === 0
                && data[nextOffset + 1] === 0
                && data[nextOffset + 2] === 0
                && data[nextOffset + 3] === 1)
        ) {
            nextOffset += 1;
        }
        offset = nextOffset + 4 <= data.byteLength ? nextOffset : data.byteLength;
    }
    return types;
}

function createPacket(
    data: Uint8Array,
    timestampSeconds: number,
    sequenceNumber = 1
): EncodedPacket {
    return new EncodedPacket(data, 'key', timestampSeconds, 1 / 24, sequenceNumber);
}

describe('DolbyVisionEncodedMetadataQueue', () => {
    it('strips RPU and EL NAL units while retaining owned metadata by integer PTS', async () => {
        const basePicture = createNALUnit(19, [ 1, 2, 3 ]);
        const rpu = createNALUnit(62, [ 25, 8, 9, 10 ]);
        const enhancementPicture = createNALUnit(1, [ 4, 5, 6 ]);
        const enhancementWrapper = createNALUnit(63, Array.from(enhancementPicture));
        const packetData = encodeAnnexBNALUnits([
            rpu,
            basePicture,
            enhancementWrapper
        ]);
        const rpuParser = createRPUParser(
            createDolbyVisionAuthorizationRPUVector(7, 'mel')
        );
        const queue = new DolbyVisionEncodedMetadataQueue({ kind: 'annex-b' }, rpuParser);

        const processedPacket = await queue.processPacket(createPacket(packetData, 1.25, 7));
        packetData.fill(0);

        expect(processedPacket.hasBaseLayerVCL).toBe(true);
        expect(processedPacket.baseLayerPacket?.sequenceNumber).toBe(7);
        expect(getAnnexBNALUnitTypes(
            processedPacket.baseLayerPacket?.data ?? new Uint8Array()
        )).toEqual([ 19 ]);
        expect(getAnnexBNALUnitTypes(
            processedPacket.enhancementLayerPacket?.data ?? new Uint8Array()
        )).toEqual([ 1 ]);
        const metadata = queue.takeFrameMetadata(1_250_000);
        expect(metadata?.encodedRPUs).toEqual([ rpu ]);
        expect(metadata?.parsedRPUData).toHaveLength(1);
        expect(rpuParser.parse).toHaveBeenCalledWith(rpu);
        expect(metadata?.enhancementLayerDisposition).toBe('discarded-mel');
        expect(metadata?.hasEnhancementLayerVCL).toBe(true);
        queue.requireDrained();
    });

    it('strips Profile 7 metadata without parsing it for HDR10-base playback', async () => {
        const basePicture = createNALUnit(19, [ 1, 2, 3 ]);
        const rpu = createNALUnit(62, [ 4, 5, 6 ]);
        const enhancementPicture = createNALUnit(1, [ 7, 8, 9 ]);
        const enhancementWrapper = createNALUnit(63, Array.from(enhancementPicture));
        const rpuParser = createRPUParser();
        rpuParser.parse.mockRejectedValue(new Error('must not parse discarded RPU data'));
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            rpuParser,
            { kind: 'annex-b' },
            false
        );

        const processedPacket = await queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ rpu, basePicture, enhancementWrapper ]),
            1.375
        ));

        expect(getAnnexBNALUnitTypes(
            processedPacket.baseLayerPacket?.data ?? new Uint8Array()
        )).toEqual([ 19 ]);
        expect(processedPacket.hasEnhancementLayerVCL).toBe(true);
        expect(rpuParser.parse).not.toHaveBeenCalled();
        expect(queue.takeFrameMetadata(1_375_000)).toBeNull();
        queue.requireDrained();
    });

    it('classifies FEL from parsed RPU state without transferring compressed EL bytes', async () => {
        const basePicture = createNALUnit(19, [ 1 ]);
        const rpu = createNALUnit(62, [ 2 ]);
        const enhancementPicture = createNALUnit(1, [ 3 ]);
        const enhancementWrapper = createNALUnit(63, Array.from(enhancementPicture));
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            createRPUParser(createDolbyVisionAuthorizationRPUVector(7, 'fel'))
        );

        const processedPacket = await queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ rpu, basePicture, enhancementWrapper ]),
            1.5
        ));
        const metadata = queue.takeFrameMetadata(1_500_000);

        expect(processedPacket.enhancementLayerPacket).not.toBeNull();
        expect(metadata).toMatchObject({
            enhancementLayerDisposition: 'discarded-fel',
            hasEnhancementLayerVCL: true
        });
        expect(metadata).not.toHaveProperty('enhancementLayerData');
        queue.requireDrained();
    });

    it('associates an RPU carried by a separate enhancement track with the base picture', async () => {
        const basePicture = createNALUnit(19, [ 1, 2 ]);
        const enhancementPicture = createNALUnit(19, [ 3, 4 ]);
        const rpu = createNALUnit(62, [ 5, 6 ]);
        const rpuParser = createRPUParser(
            createDolbyVisionAuthorizationRPUVector(7, 'fel')
        );
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            rpuParser
        );

        const processedPacket = await queue.processSeparatePackets(
            createPacket(encodeAnnexBNALUnits([ basePicture ]), 1.75),
            createPacket(encodeAnnexBNALUnits([ rpu, enhancementPicture ]), 1.75),
            { kind: 'annex-b' }
        );
        const metadata = queue.takeFrameMetadata(1_750_000);

        expect(getAnnexBNALUnitTypes(
            processedPacket.baseLayerPacket?.data ?? new Uint8Array()
        )).toEqual([ 19 ]);
        expect(getAnnexBNALUnitTypes(
            processedPacket.enhancementLayerPacket?.data ?? new Uint8Array()
        )).toEqual([ 19 ]);
        expect(metadata).toMatchObject({
            encodedRPUs: [ rpu ],
            enhancementLayerDisposition: 'discarded-fel',
            hasEnhancementLayerVCL: true
        });
        expect(rpuParser.parse).toHaveBeenCalledWith(rpu);
        queue.requireDrained();
    });

    it('rejects separate packets outside the one-microsecond timestamp tolerance', async () => {
        const basePicture = createNALUnit(19, [ 1 ]);
        const enhancementPicture = createNALUnit(19, [ 2 ]);
        const rpu = createNALUnit(62, [ 3 ]);
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            createRPUParser(createDolbyVisionAuthorizationRPUVector(7, 'mel'))
        );

        await expect(queue.processSeparatePackets(
            createPacket(encodeAnnexBNALUnits([ basePicture ]), 2),
            createPacket(encodeAnnexBNALUnits([ rpu, enhancementPicture ]), 2.000_002),
            { kind: 'annex-b' }
        )).rejects.toThrow('mismatched timestamps');
        queue.requireDrained();
    });

    it.each([ 5, 8 ] as const)(
        'discards enhancement data paired with a single-layer Profile %i RPU',
        async (profile: 5 | 8): Promise<void> => {
            const basePicture = createNALUnit(19, [ 1 ]);
            const rpu = createNALUnit(62, [ 2 ]);
            const enhancementPicture = createNALUnit(1, [ 3 ]);
            const enhancementWrapper = createNALUnit(63, Array.from(enhancementPicture));
            const queue = new DolbyVisionEncodedMetadataQueue(
                { kind: 'annex-b' },
                createRPUParser(createDolbyVisionAuthorizationRPUVector(profile))
            );

            const processedPacket = await queue.processPacket(createPacket(
                encodeAnnexBNALUnits([ rpu, basePicture, enhancementWrapper ]),
                1.75,
                9
            ));
            const metadata = queue.takeFrameMetadata(1_750_000);

            expect(processedPacket).toMatchObject({
                enhancementLayerPacket: null,
                hasBaseLayerVCL: true,
                hasEnhancementLayerVCL: false
            });
            expect(processedPacket.baseLayerPacket?.sequenceNumber).toBe(9);
            expect(getAnnexBNALUnitTypes(
                processedPacket.baseLayerPacket?.data ?? new Uint8Array()
            )).toEqual([ 19 ]);
            expect(metadata).toMatchObject({
                encodedRPUs: [ rpu ],
                enhancementLayerDisposition: 'absent',
                hasEnhancementLayerVCL: false
            });
            expect(metadata?.parsedRPUData).toHaveLength(1);
            expect(isTransferableDolbyVisionEncodedFrameMetadata(
                takeTransferableDolbyVisionEncodedFrameMetadata(metadata)
            )).toBe(true);
            queue.requireDrained();
        }
    );

    it('discards standalone EL parameter sets in a single-layer frame', async () => {
        const basePicture = createNALUnit(19, [ 1 ]);
        const rpu = createNALUnit(62, [ 2 ]);
        const enhancementWrappers = [ 32, 33, 34 ].map((nalUnitType: number): Uint8Array => (
            createNALUnit(63, Array.from(createNALUnit(nalUnitType, [ 3 ])))
        ));
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            createRPUParser()
        );

        const processedPacket = await queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ ...enhancementWrappers, rpu, basePicture ]),
            1.875
        ));

        expect(processedPacket.enhancementLayerPacket).toBeNull();
        expect(processedPacket.hasEnhancementLayerVCL).toBe(false);
        expect(queue.takeFrameMetadata(1_875_000)).toMatchObject({
            enhancementLayerDisposition: 'absent',
            hasEnhancementLayerVCL: false
        });
        queue.requireDrained();
    });

    it('keeps standalone EL parameter sets in a dual-layer frame', async () => {
        const basePicture = createNALUnit(19, [ 1 ]);
        const rpu = createNALUnit(62, [ 2 ]);
        const enhancementWrapper = createNALUnit(63, Array.from(createNALUnit(33, [ 3 ])));
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            createRPUParser(createDolbyVisionAuthorizationRPUVector(7, 'mel'))
        );

        const processedPacket = await queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ enhancementWrapper, rpu, basePicture ]),
            1.9
        ));

        expect(getAnnexBNALUnitTypes(
            processedPacket.enhancementLayerPacket?.data ?? new Uint8Array()
        )).toEqual([ 33 ]);
        expect(processedPacket.hasEnhancementLayerVCL).toBe(false);
        expect(queue.takeFrameMetadata(1_900_000)).toMatchObject({
            enhancementLayerDisposition: 'absent',
            hasEnhancementLayerVCL: false
        });
        queue.requireDrained();
    });

    it('discards a separate EL picture whose frame RPU is single-layer', async () => {
        const basePicture = createNALUnit(19, [ 1, 2 ]);
        const enhancementPicture = createNALUnit(19, [ 3, 4 ]);
        const rpu = createNALUnit(62, [ 5, 6 ]);
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            createRPUParser()
        );

        const processedPacket = await queue.processSeparatePackets(
            createPacket(encodeAnnexBNALUnits([ basePicture ]), 1.95),
            createPacket(encodeAnnexBNALUnits([ rpu, enhancementPicture ]), 1.95),
            { kind: 'annex-b' }
        );
        const metadata = queue.takeFrameMetadata(1_950_000);

        expect(getAnnexBNALUnitTypes(
            processedPacket.baseLayerPacket?.data ?? new Uint8Array()
        )).toEqual([ 19 ]);
        expect(processedPacket.enhancementLayerPacket).toBeNull();
        expect(processedPacket.hasEnhancementLayerVCL).toBe(false);
        expect(metadata).toMatchObject({
            encodedRPUs: [ rpu ],
            enhancementLayerDisposition: 'absent',
            hasEnhancementLayerVCL: false
        });
        expect(isTransferableDolbyVisionEncodedFrameMetadata(
            takeTransferableDolbyVisionEncodedFrameMetadata(metadata)
        )).toBe(true);
        queue.requireDrained();
    });

    it('still requires exactly one RPU to classify EL picture data', async () => {
        const basePicture = createNALUnit(19, [ 1 ]);
        const enhancementWrapper = createNALUnit(63, Array.from(createNALUnit(1, [ 2 ])));
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            createRPUParser()
        );

        await expect(queue.processPacket(createPacket(
            encodeAnnexBNALUnits([
                createNALUnit(62, [ 3 ]),
                createNALUnit(62, [ 4 ]),
                basePicture,
                enhancementWrapper
            ]),
            1.96
        ))).rejects.toThrow('requires one exact RPU');
        await expect(queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ basePicture, enhancementWrapper ]),
            1.97
        ))).rejects.toThrow('requires one exact RPU');
        queue.requireDrained();
    });

    it('tracks ordinary HEVC pictures without manufacturing Dolby Vision data', async () => {
        const rpuParser = createRPUParser();
        const queue = new DolbyVisionEncodedMetadataQueue({ kind: 'annex-b' }, rpuParser);
        const basePicture = createNALUnit(1, [ 1 ]);

        await queue.processPacket(createPacket(encodeAnnexBNALUnits([ basePicture ]), 2));

        expect(queue.takeFrameMetadata(2_000_000)).toBeNull();
        expect(rpuParser.parse).not.toHaveBeenCalled();
        queue.requireDrained();
    });

    it('forwards standalone enhancement parameter sets without inventing frame metadata', async () => {
        const rpuParser = createRPUParser();
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            rpuParser,
            { kind: 'annex-b' }
        );
        const enhancementVPS = createNALUnit(32, [ 1, 2, 3 ]);
        const enhancementWrapper = createNALUnit(63, Array.from(enhancementVPS));

        const processedPacket = await queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ enhancementWrapper ]),
            2.5
        ));

        expect(processedPacket.baseLayerPacket).toBeNull();
        expect(processedPacket.hasBaseLayerVCL).toBe(false);
        expect(processedPacket.hasEnhancementLayerVCL).toBe(false);
        expect(getAnnexBNALUnitTypes(
            processedPacket.enhancementLayerPacket?.data ?? new Uint8Array()
        )).toEqual([ 32 ]);
        expect(rpuParser.parse).not.toHaveBeenCalled();
        queue.requireDrained();
    });

    it('preserves decode-order entries that share a presentation timestamp', async () => {
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            createRPUParser()
        );
        const firstRPU = createNALUnit(62, [ 1 ]);
        const secondRPU = createNALUnit(62, [ 2 ]);
        const basePicture = createNALUnit(1, [ 3 ]);

        await queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ firstRPU, basePicture ]),
            3,
            1
        ));
        await queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ secondRPU, basePicture ]),
            3,
            2
        ));

        expect(queue.takeFrameMetadata(3_000_000)?.encodedRPUs).toEqual([ firstRPU ]);
        expect(queue.takeFrameMetadata(3_000_000)?.encodedRPUs).toEqual([ secondRPU ]);
        queue.requireDrained();
    });

    it('rejects unpaired metadata and mismatched decoder output', async () => {
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            createRPUParser()
        );
        const rpu = createNALUnit(62, [ 1 ]);

        await expect(queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ rpu ]),
            4
        ))).rejects.toThrow('not paired with a base-layer picture');
        expect(() => queue.takeFrameMetadata(4_000_000)).toThrow(
            'no matching encoded packet metadata'
        );
    });

    it('does not enqueue a frame when RPU parsing fails', async () => {
        const parseFailure = new Error('RPU parse failed');
        const rpuParser = createRPUParser();
        rpuParser.parse.mockRejectedValue(parseFailure);
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            rpuParser
        );
        const rpu = createNALUnit(62, [ 1 ]);
        const basePicture = createNALUnit(1, [ 2 ]);

        await expect(queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ rpu, basePicture ]),
            5
        ))).rejects.toBe(parseFailure);
        expect(() => queue.takeFrameMetadata(5_000_000)).toThrow(
            'no matching encoded packet metadata'
        );
        queue.requireDrained();
    });

    it('bounds pending metadata even when access units contain no DV bytes', async () => {
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            createRPUParser()
        );
        const basePicture = createNALUnit(1, [ 1 ]);
        const packetData = encodeAnnexBNALUnits([ basePicture ]);
        for (
            let packetIndex = 0;
            packetIndex < MAXIMUM_DOLBY_VISION_PENDING_FRAME_COUNT;
            packetIndex += 1
        ) {
            await queue.processPacket(createPacket(
                packetData,
                packetIndex / 24,
                packetIndex
            ));
        }

        await expect(queue.processPacket(createPacket(packetData, 10, 100))).rejects.toThrow(
            'frame window exceeded its bound'
        );
        queue.clear();
        queue.requireDrained();
    });
});

const AV1_OBU_HAS_SIZE_FIELD_FLAG = 0x02;
const AV1_OBU_TYPE_SEQUENCE_HEADER = 1;
const AV1_OBU_TYPE_TEMPORAL_DELIMITER = 2;
const AV1_OBU_TYPE_METADATA = 5;
const AV1_OBU_TYPE_FRAME = 6;
const AV1_METADATA_TYPE_ITUT_T35 = 4;

function createAV1OBU(type: number, payload: readonly number[]): Uint8Array {
    return new Uint8Array([
        (type << 3) | AV1_OBU_HAS_SIZE_FIELD_FLAG,
        payload.length,
        ...payload
    ]);
}

function createAV1DolbyVisionT35Message(rpuByte: number): number[] {
    return [ ...DOLBY_VISION_ITUT_T35_PAYLOAD_PREFIX, rpuByte, 0x80 ];
}

function createAV1DolbyVisionMetadataOBU(rpuByte: number): Uint8Array {
    return createAV1OBU(AV1_OBU_TYPE_METADATA, [
        AV1_METADATA_TYPE_ITUT_T35,
        ...createAV1DolbyVisionT35Message(rpuByte)
    ]);
}

function concatenateAV1OBUs(obus: readonly Uint8Array[]): Uint8Array {
    const output = new Uint8Array(obus.reduce(
        (byteLength: number, obu: Uint8Array): number => byteLength + obu.byteLength,
        0
    ));
    let offset = 0;
    for (const obu of obus) {
        output.set(obu, offset);
        offset += obu.byteLength;
    }
    return output;
}

function createAV1RPUParser(
    packedRPUData: ArrayBuffer = createDolbyVisionAuthorizationRPUVector(8)
): {
        parseAV1ITUTT35: ReturnType<typeof vi.fn>
    } {
    return {
        parseAV1ITUTT35: vi.fn(async (): Promise<ArrayBuffer> => (
            packedRPUData.slice(0)
        ))
    };
}

describe('DolbyVisionAV1EncodedMetadataQueue', () => {
    it('strips the RPU OBU and keys its parsed metadata by the unit timestamp', async () => {
        const temporalDelimiter = createAV1OBU(AV1_OBU_TYPE_TEMPORAL_DELIMITER, []);
        const frame = createAV1OBU(AV1_OBU_TYPE_FRAME, [ 1, 2, 3 ]);
        const rpuParser = createAV1RPUParser();
        const queue = new DolbyVisionAV1EncodedMetadataQueue(rpuParser);

        const processedUnit = await queue.processTemporalUnit(createPacket(
            concatenateAV1OBUs([ temporalDelimiter, createAV1DolbyVisionMetadataOBU(0x42), frame ]),
            1.25,
            7
        ));
        const metadata = queue.takeFrameMetadata(1_250_000);

        expect(processedUnit.hasFrame).toBe(true);
        expect(processedUnit.decoderPacket).toMatchObject({
            microsecondTimestamp: 1_250_000,
            sequenceNumber: 7,
            type: 'key'
        });
        expect(Array.from(processedUnit.decoderPacket.data)).toEqual(Array.from(concatenateAV1OBUs([
            temporalDelimiter,
            frame
        ])));
        expect(rpuParser.parseAV1ITUTT35).toHaveBeenCalledOnce();
        expect(Array.from(rpuParser.parseAV1ITUTT35.mock.calls[0][0] as Uint8Array)).toEqual(
            createAV1DolbyVisionT35Message(0x42)
        );
        expect(metadata).toMatchObject({
            enhancementLayerDisposition: 'absent',
            hasEnhancementLayerVCL: false
        });
        expect(metadata?.parsedRPUData).toHaveLength(1);
        expect(isTransferableDolbyVisionEncodedFrameMetadata(
            takeTransferableDolbyVisionEncodedFrameMetadata(metadata)
        )).toBe(true);
        queue.requireDrained();
    });

    it('passes a unit without an RPU through as the same packet', async () => {
        const rpuParser = createAV1RPUParser();
        const queue = new DolbyVisionAV1EncodedMetadataQueue(rpuParser);
        const packet = createPacket(createAV1OBU(AV1_OBU_TYPE_FRAME, [ 1 ]), 2);

        const processedUnit = await queue.processTemporalUnit(packet);

        expect(processedUnit.decoderPacket).toBe(packet);
        expect(processedUnit.hasFrame).toBe(true);
        expect(queue.takeFrameMetadata(2_000_000)).toBeNull();
        expect(rpuParser.parseAV1ITUTT35).not.toHaveBeenCalled();
        queue.requireDrained();
    });

    it('records no frame for a unit without a frame header', async () => {
        const queue = new DolbyVisionAV1EncodedMetadataQueue(createAV1RPUParser());

        const processedUnit = await queue.processTemporalUnit(createPacket(concatenateAV1OBUs([
            createAV1OBU(AV1_OBU_TYPE_TEMPORAL_DELIMITER, []),
            createAV1OBU(AV1_OBU_TYPE_SEQUENCE_HEADER, [ 1 ])
        ]), 2.5));

        expect(processedUnit.hasFrame).toBe(false);
        queue.requireDrained();
        expect(() => queue.takeFrameMetadata(2_500_000)).toThrow(
            'A decoded AV1 frame has no matching encoded packet metadata'
        );
    });

    it('rejects two RPUs in one temporal unit before parsing either', async () => {
        const rpuParser = createAV1RPUParser();
        const queue = new DolbyVisionAV1EncodedMetadataQueue(rpuParser);

        await expect(queue.processTemporalUnit(createPacket(concatenateAV1OBUs([
            createAV1DolbyVisionMetadataOBU(1),
            createAV1DolbyVisionMetadataOBU(2),
            createAV1OBU(AV1_OBU_TYPE_FRAME, [ 3 ])
        ]), 3))).rejects.toThrow('more than one Dolby Vision RPU');
        expect(rpuParser.parseAV1ITUTT35).not.toHaveBeenCalled();
        queue.requireDrained();
    });

    it('rejects an RPU in a temporal unit without a frame', async () => {
        const queue = new DolbyVisionAV1EncodedMetadataQueue(createAV1RPUParser());

        await expect(queue.processTemporalUnit(createPacket(concatenateAV1OBUs([
            createAV1OBU(AV1_OBU_TYPE_SEQUENCE_HEADER, [ 1 ]),
            createAV1DolbyVisionMetadataOBU(2)
        ]), 3.5))).rejects.toThrow('not paired with an AV1 frame');
        queue.requireDrained();
    });

    it('rejects a malformed temporal unit and a failed RPU parse without recording a frame', async () => {
        const parseFailure = new Error('RPU parse failed');
        const rpuParser = createAV1RPUParser();
        rpuParser.parseAV1ITUTT35.mockRejectedValue(parseFailure);
        const queue = new DolbyVisionAV1EncodedMetadataQueue(rpuParser);

        await expect(queue.processTemporalUnit(createPacket(
            new Uint8Array([ (AV1_OBU_TYPE_FRAME << 3) | AV1_OBU_HAS_SIZE_FIELD_FLAG, 9, 1 ]),
            4
        ))).rejects.toThrow(AV1OBUParseError);
        await expect(queue.processTemporalUnit(createPacket(concatenateAV1OBUs([
            createAV1DolbyVisionMetadataOBU(1),
            createAV1OBU(AV1_OBU_TYPE_FRAME, [ 2 ])
        ]), 4.5))).rejects.toBe(parseFailure);
        queue.requireDrained();
    });

    it('rejects a decoder that loses a frame and bounds the pending frames', async () => {
        const queue = new DolbyVisionAV1EncodedMetadataQueue(createAV1RPUParser());
        const packetData = createAV1OBU(AV1_OBU_TYPE_FRAME, [ 1 ]);
        await queue.processTemporalUnit(createPacket(packetData, 5));

        expect(() => queue.requireDrained()).toThrow(
            'The AV1 decoder ended before every metadata entry was matched'
        );
        for (
            let packetIndex = 1;
            packetIndex < MAXIMUM_DOLBY_VISION_PENDING_FRAME_COUNT;
            packetIndex += 1
        ) {
            await queue.processTemporalUnit(createPacket(packetData, 5 + (packetIndex / 24), packetIndex));
        }
        await expect(queue.processTemporalUnit(createPacket(packetData, 10, 100))).rejects.toThrow(
            'frame window exceeded its bound'
        );
        queue.clear();
        queue.requireDrained();
    });
});
