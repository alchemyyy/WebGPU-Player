import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { getContentIdentity } from 'webgpu-player/presentation/passes/ContentIdentity';

// Lengths around SHA-256's 64-byte block and its 56-byte padding boundary, and a multi-block message
const MESSAGE_LENGTHS: readonly number[] = [ 0, 1, 55, 56, 63, 64, 65, 1_000 ];
const BYTE_PATTERN_MULTIPLIER = 31;
const BYTE_PATTERN_OFFSET = 7;
const BYTE_RANGE = 256;
const ABC_MESSAGE = 'abc';
// FIPS 180-4's example digest of "abc"
const ABC_DIGEST = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function createMessage(length: number): Uint8Array {
    return Uint8Array.from({ length }, (_value: unknown, index: number): number => ((index * BYTE_PATTERN_MULTIPLIER) + BYTE_PATTERN_OFFSET) % BYTE_RANGE);
}

describe('getContentIdentity', () => {
    it('returns FIPS 180-4\'s digest of "abc"', () => {
        expect(getContentIdentity(new TextEncoder().encode(ABC_MESSAGE))).toBe(ABC_DIGEST);
    });

    it.each(MESSAGE_LENGTHS)('matches Node\'s SHA-256 for %i bytes', length => {
        const message = createMessage(length);

        expect(getContentIdentity(message)).toBe(createHash('sha256').update(message).digest('hex'));
    });
});
