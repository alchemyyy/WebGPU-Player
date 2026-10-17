// Computes a content identity: a compact hash of a byte sequence, which names a pass file's texture block in plans and in the upload cache.
// It is cyrb53, a 53-bit non-cryptographic hash that a synchronous parse affords for any block; two of a preset's few blocks collide with a chance of
// about one in 2^53, and an identity is only a cache key, never a check of untrusted data.

// cyrb53's seeds of its two 32-bit lanes, and its mixing multipliers
const FIRST_LANE_SEED = 0xDEADBEEF;
const SECOND_LANE_SEED = 0x41C6CE57;
const FIRST_LANE_MULTIPLIER = 2654435761;
const SECOND_LANE_MULTIPLIER = 1597334677;
const FINAL_MULTIPLIER = 2246822507;
const FINAL_CROSS_MULTIPLIER = 3266489909;
// The final mix shifts each lane by these before multiplying
const FINAL_SHIFT = 16;
const FINAL_CROSS_SHIFT = 13;
// The second lane gives the low 21 bits it keeps above the first lane's 32, for 53 bits in all
const SECOND_LANE_KEPT_BITS = 0x1FFFFF;
const UINT32_RANGE = 2 ** 32;
const HEXADECIMAL_RADIX = 16;
// 53 bits print as at most 14 hexadecimal digits
const IDENTITY_HEXADECIMAL_DIGITS = 14;

/** Returns a byte sequence's content identity: its cyrb53 hash, as 14 lowercase hexadecimal digits. */
export function getContentIdentity(bytes: Uint8Array): string {
    let first = FIRST_LANE_SEED;
    let second = SECOND_LANE_SEED;
    for (const byte of bytes) {
        first = Math.imul(first ^ byte, FIRST_LANE_MULTIPLIER);
        second = Math.imul(second ^ byte, SECOND_LANE_MULTIPLIER);
    }
    first = Math.imul(first ^ (first >>> FINAL_SHIFT), FINAL_MULTIPLIER) ^ Math.imul(second ^ (second >>> FINAL_CROSS_SHIFT), FINAL_CROSS_MULTIPLIER);
    second = Math.imul(second ^ (second >>> FINAL_SHIFT), FINAL_MULTIPLIER) ^ Math.imul(first ^ (first >>> FINAL_CROSS_SHIFT), FINAL_CROSS_MULTIPLIER);
    const hash = (UINT32_RANGE * (second & SECOND_LANE_KEPT_BITS)) + (first >>> 0);
    return hash.toString(HEXADECIMAL_RADIX).padStart(IDENTITY_HEXADECIMAL_DIGITS, '0');
}
