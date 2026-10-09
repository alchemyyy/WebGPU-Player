import { EncodedPacket } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import HEVCDynamicHDRMetadataQueue from 'webgpu-player/video/hdr/HEVCDynamicHDRMetadataQueue';
import { MAXIMUM_PENDING_DYNAMIC_HDR_FRAME_COUNT } from 'webgpu-player/video/hdr/HDR10PlusFrameMetadataQueue';
import {
    parseHEVCNALUnits,
    type HEVCNALUnit
} from 'webgpu-player/video/dolby-vision/DolbyVisionHEVCSplitter';

import { createHDR10PlusHEVCVector } from '../../../src/capability/vectors/HDR10PlusVectors';

type HDR10PlusVectorKind = Parameters<typeof createHDR10PlusHEVCVector>[0];

function createPacket(
    kind: HDR10PlusVectorKind,
    index: number
): EncodedPacket {
    return new EncodedPacket(
        createHDR10PlusHEVCVector(kind),
        index === 0 ? 'key' : 'delta',
        index / 24,
        1 / 24,
        index
    );
}

function createSecondViewAccessUnit(kind: HDR10PlusVectorKind): Uint8Array {
    const accessUnit = createHDR10PlusHEVCVector(kind);
    const nalUnits: HEVCNALUnit[] = parseHEVCNALUnits(accessUnit, { kind: 'annex-b' });
    for (const nalUnit of nalUnits) {
        // nuh_layer_id 1 sets the lowest of the top five bits of the second header byte
        nalUnit.data[1] = (1 << 3) | (nalUnit.data[1] & 0x07);
    }
    return accessUnit;
}

function createMultiviewPacket(
    baseViewKind: HDR10PlusVectorKind | null,
    secondViewKind: HDR10PlusVectorKind
): EncodedPacket {
    const baseView = baseViewKind ? createHDR10PlusHEVCVector(baseViewKind) : new Uint8Array();
    const secondView = createSecondViewAccessUnit(secondViewKind);
    const data = new Uint8Array(baseView.byteLength + secondView.byteLength);
    data.set(baseView);
    data.set(secondView, baseView.byteLength);
    return new EncodedPacket(data, 'key', 0, 1 / 24, 0);
}

describe('HEVCDynamicHDRMetadataQueue', () => {
    it('matches valid, absent, and malformed states to reordered decoded timestamps', () => {
        const queue = new HEVCDynamicHDRMetadataQueue({ kind: 'annex-b' });
        const validPacket = createPacket('valid', 0);
        const absentPacket = createPacket('absent', 1);
        const malformedPacket = createPacket('malformed', 2);
        queue.processPacket(validPacket);
        queue.processPacket(absentPacket);
        queue.processPacket(malformedPacket);

        expect(queue.takeFrameMetadata(absentPacket.microsecondTimestamp).status)
            .toBe('absent');
        expect(queue.takeFrameMetadata(validPacket.microsecondTimestamp).status)
            .toBe('valid');
        expect(queue.takeFrameMetadata(malformedPacket.microsecondTimestamp).status)
            .toBe('malformed');
        expect(() => queue.requireDrained()).not.toThrow();
    });

    it('clears generation-owned states so a seek cannot reuse stale metadata', () => {
        const queue = new HEVCDynamicHDRMetadataQueue({ kind: 'annex-b' });
        queue.processPacket(createPacket('valid', 0));
        queue.clear();
        queue.processPacket(createPacket('absent', 0));

        expect(queue.takeFrameMetadata(0)).toEqual({
            metadata: null,
            status: 'absent'
        });
        expect(() => queue.requireDrained()).not.toThrow();
    });

    it('reads only the base view of an MV-HEVC access unit', () => {
        const queue = new HEVCDynamicHDRMetadataQueue({ kind: 'annex-b' });

        expect(queue.processPacket(createMultiviewPacket('absent', 'valid'))).toBe(true);
        expect(queue.takeFrameMetadata(0)).toEqual({ metadata: null, status: 'absent' });
        expect(queue.processPacket(createMultiviewPacket('valid', 'malformed'))).toBe(true);
        expect(queue.takeFrameMetadata(0).status).toBe('valid');
        expect(() => queue.requireDrained()).not.toThrow();
    });

    it('queues no frame for an access unit without a base-layer picture', () => {
        const queue = new HEVCDynamicHDRMetadataQueue({ kind: 'annex-b' });

        expect(queue.processPacket(createMultiviewPacket(null, 'valid'))).toBe(false);
        expect(() => queue.requireDrained()).not.toThrow();
        expect(() => queue.takeFrameMetadata(0)).toThrow('no matching');
    });

    it('bounds pending metadata and detects unmatched decoder output', () => {
        const queue = new HEVCDynamicHDRMetadataQueue({ kind: 'annex-b' });
        for (let frameIndex = 0; frameIndex < MAXIMUM_PENDING_DYNAMIC_HDR_FRAME_COUNT;
            frameIndex += 1) {
            queue.processPacket(createPacket('absent', frameIndex));
        }
        expect(() => queue.processPacket(createPacket(
            'absent',
            MAXIMUM_PENDING_DYNAMIC_HDR_FRAME_COUNT
        ))).toThrow('exceeded its bound');
        expect(() => queue.requireDrained()).toThrow('before dynamic HDR metadata was matched');
        expect(() => queue.takeFrameMetadata(10_000_000)).toThrow('no matching');
    });
});
