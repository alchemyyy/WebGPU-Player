// Computes a content identity, the SHA-256 of a byte sequence, synchronously, as a pass file's parse needs it for the texture blocks whose uploads it keys.
// crypto.subtle digests asynchronously, which a synchronous parse cannot wait for.

// FIPS 180-4's first 32 bits of the fractional parts of the cube roots of the first 64 primes
const ROUND_CONSTANTS = new Uint32Array([
    0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
    0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
    0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
    0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
    0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
    0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
    0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
    0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2
]);
// The first 32 bits of the fractional parts of the square roots of the first 8 primes
const INITIAL_HASH: readonly number[] = [ 0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19 ];
const BLOCK_BYTE_LENGTH = 64;
const SCHEDULE_WORD_COUNT = 64;
const BLOCK_WORD_COUNT = 16;
// The padding's end marker and the 64-bit message length in bits that closes the last block
const PADDING_MARKER = 0x80;
const LENGTH_FIELD_BYTE_LENGTH = 8;
const BITS_PER_BYTE = 8;
const WORD_BYTE_LENGTH = 4;
const HEXADECIMAL_RADIX = 16;
const WORD_HEXADECIMAL_DIGITS = 8;
const UINT32_RANGE = 2 ** 32;

function rotateRight(value: number, distance: number): number {
    return (value >>> distance) | (value << (32 - distance));
}

/** Returns the message padded to whole blocks: the marker byte, zeros, and the message's length in bits, big-endian. */
function padMessage(bytes: Uint8Array): Uint8Array {
    const paddedLength = Math.ceil((bytes.byteLength + 1 + LENGTH_FIELD_BYTE_LENGTH) / BLOCK_BYTE_LENGTH) * BLOCK_BYTE_LENGTH;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.byteLength] = PADDING_MARKER;
    const view = new DataView(padded.buffer);
    const bitLength = bytes.byteLength * BITS_PER_BYTE;
    view.setUint32(paddedLength - LENGTH_FIELD_BYTE_LENGTH, Math.floor(bitLength / UINT32_RANGE));
    view.setUint32(paddedLength - WORD_BYTE_LENGTH, bitLength >>> 0);
    return padded;
}

/** Returns the lowercase hexadecimal SHA-256 of bytes. */
export function getContentIdentity(bytes: Uint8Array): string {
    const padded = padMessage(bytes);
    const view = new DataView(padded.buffer);
    const hash = new Uint32Array(INITIAL_HASH);
    const schedule = new Uint32Array(SCHEDULE_WORD_COUNT);
    for (let blockOffset = 0; blockOffset < padded.byteLength; blockOffset += BLOCK_BYTE_LENGTH) {
        for (let index = 0; index < BLOCK_WORD_COUNT; index += 1) {
            schedule[index] = view.getUint32(blockOffset + (index * WORD_BYTE_LENGTH));
        }
        for (let index = BLOCK_WORD_COUNT; index < SCHEDULE_WORD_COUNT; index += 1) {
            const earlier = schedule[index - 15];
            const later = schedule[index - 2];
            const sigma0 = rotateRight(earlier, 7) ^ rotateRight(earlier, 18) ^ (earlier >>> 3);
            const sigma1 = rotateRight(later, 17) ^ rotateRight(later, 19) ^ (later >>> 10);
            schedule[index] = schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1;
        }
        let [ first, second, third, fourth, fifth, sixth, seventh, eighth ] = hash;
        for (let index = 0; index < SCHEDULE_WORD_COUNT; index += 1) {
            const sum1 = rotateRight(fifth, 6) ^ rotateRight(fifth, 11) ^ rotateRight(fifth, 25);
            const choice = (fifth & sixth) ^ (~fifth & seventh);
            const temporary1 = (eighth + sum1 + choice + ROUND_CONSTANTS[index] + schedule[index]) >>> 0;
            const sum0 = rotateRight(first, 2) ^ rotateRight(first, 13) ^ rotateRight(first, 22);
            const majority = (first & second) ^ (first & third) ^ (second & third);
            const temporary2 = (sum0 + majority) >>> 0;
            eighth = seventh;
            seventh = sixth;
            sixth = fifth;
            fifth = (fourth + temporary1) >>> 0;
            fourth = third;
            third = second;
            second = first;
            first = (temporary1 + temporary2) >>> 0;
        }
        const results = [ first, second, third, fourth, fifth, sixth, seventh, eighth ];
        for (let index = 0; index < hash.length; index += 1) {
            hash[index] += results[index];
        }
    }
    return [ ...hash ].map((word: number): string => word.toString(HEXADECIMAL_RADIX).padStart(WORD_HEXADECIMAL_DIGITS, '0')).join('');
}
