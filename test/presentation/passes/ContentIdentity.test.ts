import { describe, expect, it } from 'vitest';

import { getContentIdentity } from 'webgpu-player/presentation/passes/ContentIdentity';

// cyrb53 of the bytes of "abc" and of no bytes, from its reference implementation over the same bytes
const ABC_MESSAGE = 'abc';
const ABC_IDENTITY = '11f9f91ac18c8d';
const EMPTY_IDENTITY = '0bdcb81aee8d83';
const IDENTITY_PATTERN = /^[0-9a-f]{14}$/;
// A block of texels large enough to stand for a lookup table
const BLOCK_BYTE_LENGTH = 4_096;
const BYTE_PATTERN_MULTIPLIER = 31;
const BYTE_PATTERN_OFFSET = 7;
const BYTE_RANGE = 256;
const CHANGED_BYTE_INDEX = 2_048;

function createBlock(): Uint8Array {
    return Uint8Array.from({ length: BLOCK_BYTE_LENGTH }, (_value: unknown, index: number): number => ((index * BYTE_PATTERN_MULTIPLIER) + BYTE_PATTERN_OFFSET) % BYTE_RANGE);
}

describe('getContentIdentity', () => {
    it('returns cyrb53 as 14 hexadecimal digits', () => {
        expect(getContentIdentity(new TextEncoder().encode(ABC_MESSAGE))).toBe(ABC_IDENTITY);
        expect(getContentIdentity(new Uint8Array(0))).toBe(EMPTY_IDENTITY);
        expect(getContentIdentity(createBlock())).toMatch(IDENTITY_PATTERN);
    });

    it('names the same bytes alike and changed bytes apart', () => {
        const changed = createBlock();
        changed[CHANGED_BYTE_INDEX] ^= 1;

        expect(getContentIdentity(createBlock())).toBe(getContentIdentity(createBlock()));
        expect(getContentIdentity(changed)).not.toBe(getContentIdentity(createBlock()));
        expect(getContentIdentity(createBlock().subarray(1))).not.toBe(getContentIdentity(createBlock()));
    });
});
