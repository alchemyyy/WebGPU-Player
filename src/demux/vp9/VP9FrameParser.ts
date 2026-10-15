// VP9 Bitstream Specification 6.2, uncompressed_header(): bit positions from the most significant bit of the first byte
const FRAME_MARKER = 2;
const FRAME_MARKER_SHIFT = 6;
const PROFILE_LOW_BIT_POSITION = 2;
const PROFILE_HIGH_BIT_POSITION = 3;
const SHOW_EXISTING_FRAME_BIT_POSITION = 4;
// frame_type sits between show_existing_frame and show_frame
const SHOW_FRAME_BIT_POSITION = 6;
// Profile 3 has a reserved_zero bit before show_existing_frame
const PROFILE_WITH_RESERVED_BIT = 3;
// Annex B: a superframe index starts and ends with a marker byte 0b110xxxxx
const SUPERFRAME_MARKER_MASK = 0xE0;
const SUPERFRAME_MARKER = 0xC0;
const SUPERFRAME_FRAME_COUNT_MASK = 0x07;
const SUPERFRAME_SIZE_BYTE_LENGTH_SHIFT = 3;
const SUPERFRAME_SIZE_BYTE_LENGTH_MASK = 0x03;
// The marker byte at each end of the index
const SUPERFRAME_INDEX_MARKER_BYTE_COUNT = 2;
const BITS_PER_BYTE = 8;

function readBit(byteValue: number, bitPosition: number): number {
    return (byteValue >> (BITS_PER_BYTE - 1 - bitPosition)) & 1;
}

/**
 * Splits a VP9 packet into its frames: the frames its superframe index lists, or the packet itself.
 * As in libvpx, a final marker byte begins an index only when the index's first byte repeats it.
 * A packet whose index does not fit its data is returned whole, for the decoder to reject.
 */
export function splitVP9Superframe(data: Uint8Array): Uint8Array[] {
    if (data.byteLength === 0) {
        return [ data ];
    }
    const marker = data[data.byteLength - 1];
    if ((marker & SUPERFRAME_MARKER_MASK) !== SUPERFRAME_MARKER) {
        return [ data ];
    }
    const frameCount = (marker & SUPERFRAME_FRAME_COUNT_MASK) + 1;
    const sizeByteLength = ((marker >> SUPERFRAME_SIZE_BYTE_LENGTH_SHIFT) & SUPERFRAME_SIZE_BYTE_LENGTH_MASK) + 1;
    const indexOffset = data.byteLength - (SUPERFRAME_INDEX_MARKER_BYTE_COUNT + (sizeByteLength * frameCount));
    if (indexOffset < 0 || data[indexOffset] !== marker) {
        return [ data ];
    }

    const frames: Uint8Array[] = [];
    let frameOffset = 0;
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        // Each frame size is little-endian
        let frameByteLength = 0;
        for (let byteIndex = 0; byteIndex < sizeByteLength; byteIndex += 1) {
            frameByteLength += data[indexOffset + 1 + (frameIndex * sizeByteLength) + byteIndex] * (2 ** (BITS_PER_BYTE * byteIndex));
        }
        if (frameOffset + frameByteLength > indexOffset) {
            return [ data ];
        }
        frames.push(data.subarray(frameOffset, frameOffset + frameByteLength));
        frameOffset += frameByteLength;
    }
    return frames;
}

/** Returns whether a frame's uncompressed header hides it, setting neither show_existing_frame nor show_frame; an unreadable header does not. */
function isHiddenVP9Frame(frame: Uint8Array): boolean {
    if (frame.byteLength === 0 || frame[0] >> FRAME_MARKER_SHIFT !== FRAME_MARKER) {
        return false;
    }
    const headerByte = frame[0];
    const profile = (readBit(headerByte, PROFILE_HIGH_BIT_POSITION) << 1) | readBit(headerByte, PROFILE_LOW_BIT_POSITION);
    const reservedBitCount = profile === PROFILE_WITH_RESERVED_BIT ? 1 : 0;
    return readBit(headerByte, SHOW_EXISTING_FRAME_BIT_POSITION + reservedBitCount) === 0
        && readBit(headerByte, SHOW_FRAME_BIT_POSITION + reservedBitCount) === 0;
}

/**
 * Returns whether a VP9 packet shows a frame, so the decoder outputs one for it.
 * WebM and MP4 require one shown frame per packet, a superframe holding any hidden frames before it, and a show_existing_frame header shows a frame too.
 * A packet of hidden frames alone, which those containers forbid but some streams carry, outputs none.
 * A frame whose header cannot be read counts as shown, so the decoder reports the error.
 */
export function hasVP9ShownFrame(data: Uint8Array): boolean {
    return !splitVP9Superframe(data).every(isHiddenVP9Frame);
}
