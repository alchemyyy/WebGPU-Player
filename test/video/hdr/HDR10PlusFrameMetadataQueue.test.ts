import { describe, expect, it } from 'vitest';

import HDR10PlusFrameMetadataQueue from 'webgpu-player/video/hdr/HDR10PlusFrameMetadataQueue';
import {
    parseHEVCHDR10PlusMetadata,
    type HDR10PlusFrameMetadata,
    type HDR10PlusMetadata
} from 'webgpu-player/video/hdr/HDR10PlusMetadata';

import { createHDR10PlusHEVCVector } from '../../../src/capability/vectors/HDR10PlusVectors';

type HDR10PlusVectorKind = Parameters<typeof createHDR10PlusHEVCVector>[0];

const FRAME_DURATION_MICROSECONDS = 40_000;

function parseVector(kind: HDR10PlusVectorKind): HDR10PlusFrameMetadata {
    return parseHEVCHDR10PlusMetadata(createHDR10PlusHEVCVector(kind), { kind: 'annex-b' });
}

function getVectorMetadata(kind: HDR10PlusVectorKind): HDR10PlusMetadata {
    const metadata = parseVector(kind).metadata;
    if (!metadata) {
        throw new Error(`The ${kind} HDR10+ vector has no metadata`);
    }
    return metadata;
}

/** Enqueues one packet per kind in decode order, each at its own frame time, and takes the frames back in that order. */
function carryInDecodeOrder(
    queue: HDR10PlusFrameMetadataQueue,
    kinds: readonly HDR10PlusVectorKind[]
): HDR10PlusFrameMetadata[] {
    for (let frameIndex = 0; frameIndex < kinds.length; frameIndex += 1) {
        queue.enqueue(frameIndex * FRAME_DURATION_MICROSECONDS, parseVector(kinds[frameIndex]));
    }
    const frames: HDR10PlusFrameMetadata[] = [];
    for (let frameIndex = 0; frameIndex < kinds.length; frameIndex += 1) {
        frames.push(queue.takeFrameMetadata(frameIndex * FRAME_DURATION_MICROSECONDS));
    }
    queue.requireDrained();
    return frames;
}

describe('HDR10PlusFrameMetadataQueue', () => {
    it('carries the last valid metadata to absent and malformed frames, keeping their status', () => {
        const validMetadata = getVectorMetadata('valid');
        const profileAMetadata = getVectorMetadata('profile-a');

        expect(carryInDecodeOrder(
            new HDR10PlusFrameMetadataQueue('HEVC'),
            [ 'valid', 'absent', 'malformed', 'profile-a', 'absent' ]
        )).toEqual([
            { metadata: validMetadata, status: 'valid' },
            { metadata: validMetadata, status: 'absent' },
            { metadata: validMetadata, status: 'malformed' },
            { metadata: profileAMetadata, status: 'valid' },
            { metadata: profileAMetadata, status: 'absent' }
        ]);
    });

    it.each([ 'conflicting', 'unsupported' ] as const)(
        'ends the carried metadata at a %s frame until the next valid one',
        (status) => {
            const validMetadata = getVectorMetadata('valid');

            expect(carryInDecodeOrder(
                new HDR10PlusFrameMetadataQueue('HEVC'),
                [ 'valid', status, 'absent', 'malformed', 'valid', 'absent' ]
            )).toEqual([
                { metadata: validMetadata, status: 'valid' },
                { metadata: null, status },
                { metadata: null, status: 'absent' },
                { metadata: null, status: 'malformed' },
                { metadata: validMetadata, status: 'valid' },
                { metadata: validMetadata, status: 'absent' }
            ]);
        }
    );

    it('carries in decode order, not in the reordered presentation order', () => {
        const queue = new HDR10PlusFrameMetadataQueue('HEVC');
        const validMetadata = getVectorMetadata('valid');
        // The later picture decodes first, as a P picture decodes before the B pictures shown ahead of it
        queue.enqueue(FRAME_DURATION_MICROSECONDS, parseVector('valid'));
        queue.enqueue(0, parseVector('absent'));

        expect(queue.takeFrameMetadata(0)).toEqual({ metadata: validMetadata, status: 'absent' });
        expect(queue.takeFrameMetadata(FRAME_DURATION_MICROSECONDS)).toEqual({ metadata: validMetadata, status: 'valid' });
    });

    it('starts each queue, and each clear, without carried metadata', () => {
        expect(carryInDecodeOrder(
            new HDR10PlusFrameMetadataQueue('AV1'),
            [ 'absent', 'malformed' ]
        )).toEqual([
            { metadata: null, status: 'absent' },
            { metadata: null, status: 'malformed' }
        ]);

        const queue = new HDR10PlusFrameMetadataQueue('VP9');
        queue.enqueue(0, parseVector('valid'));
        queue.clear();
        expect(carryInDecodeOrder(queue, [ 'absent' ])).toEqual([ { metadata: null, status: 'absent' } ]);
    });
});
