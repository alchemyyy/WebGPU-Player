import { describe, expect, it } from 'vitest';

import { hasVP9ShownFrame, splitVP9Superframe } from 'webgpu-player/video/vp9/VP9FrameParser';

// First uncompressed_header() bytes: frame_marker 2, the profile bits, then show_existing_frame, frame_type, and show_frame
const PROFILE_0_SHOWN_KEY_FRAME = 0x82;
const PROFILE_0_SHOWN_INTER_FRAME = 0x86;
const PROFILE_0_HIDDEN_INTER_FRAME = 0x84;
const PROFILE_0_SHOW_EXISTING_FRAME = 0x88;
const PROFILE_1_HIDDEN_INTER_FRAME = 0xA4;
const PROFILE_2_SHOWN_INTER_FRAME = 0x96;
const PROFILE_2_HIDDEN_INTER_FRAME = 0x94;
// Profile 3 moves every flag one bit later, behind reserved_zero
const PROFILE_3_SHOWN_INTER_FRAME = 0xB3;
const PROFILE_3_HIDDEN_INTER_FRAME = 0xB2;
const PROFILE_3_SHOW_EXISTING_FRAME = 0xB4;
// frame_marker 0, which no VP9 frame has
const INVALID_FRAME_MARKER_HEADER = 0x02;
const FRAME_PAYLOAD = [ 0x5A, 0xA5 ];
const SUPERFRAME_MARKER = 0xC0;
const TWO_BYTE_FRAME_SIZE = 300;

function createFrame(headerByte: number, payloadByteLength: number = FRAME_PAYLOAD.length): Uint8Array {
    const frame = new Uint8Array(1 + payloadByteLength);
    frame[0] = headerByte;
    for (let byteIndex = 1; byteIndex < frame.byteLength; byteIndex += 1) {
        frame[byteIndex] = FRAME_PAYLOAD[byteIndex % FRAME_PAYLOAD.length];
    }
    return frame;
}

/** Appends a superframe index, whose marker byte opens and closes it, listing each frame's little-endian size. */
function createSuperframe(frames: readonly Uint8Array[], sizeByteLength: number): Uint8Array {
    const marker = SUPERFRAME_MARKER | ((sizeByteLength - 1) << 3) | (frames.length - 1);
    const bytes: number[] = [];
    for (const frame of frames) {
        bytes.push(...frame);
    }
    bytes.push(marker);
    for (const frame of frames) {
        for (let byteIndex = 0; byteIndex < sizeByteLength; byteIndex += 1) {
            bytes.push(Math.floor(frame.byteLength / (2 ** (8 * byteIndex))) % 256);
        }
    }
    bytes.push(marker);
    return new Uint8Array(bytes);
}

describe('splitVP9Superframe', () => {
    it('returns a packet without an index as its one frame', () => {
        const frame = createFrame(PROFILE_0_SHOWN_KEY_FRAME);

        const frames = splitVP9Superframe(frame);

        expect(frames).toHaveLength(1);
        expect(frames[0]).toBe(frame);
    });

    it('splits the frames a superframe index lists, with one- and two-byte sizes', () => {
        const hiddenFrame = createFrame(PROFILE_2_HIDDEN_INTER_FRAME, 4);
        const shownFrame = createFrame(PROFILE_2_SHOWN_INTER_FRAME, 1);
        const largeFrame = createFrame(PROFILE_0_SHOWN_INTER_FRAME, TWO_BYTE_FRAME_SIZE - 1);

        expect(splitVP9Superframe(createSuperframe([ hiddenFrame, shownFrame ], 1))).toEqual([ hiddenFrame, shownFrame ]);
        expect(splitVP9Superframe(createSuperframe([ hiddenFrame, largeFrame ], 2))).toEqual([ hiddenFrame, largeFrame ]);
    });

    it('keeps a packet whole when its index does not repeat its marker or overruns the data', () => {
        const superframe = createSuperframe([ createFrame(PROFILE_0_HIDDEN_INTER_FRAME), createFrame(PROFILE_0_SHOWN_INTER_FRAME) ], 1);
        const unmatchedMarker = superframe.slice();
        unmatchedMarker[superframe.byteLength - 4] ^= 0x01;
        const overrunningSizes = superframe.slice();
        overrunningSizes[superframe.byteLength - 3] = 0xFF;
        // A marker-like final byte whose index would start before the data
        const shortPacket = new Uint8Array([ SUPERFRAME_MARKER | 0x07 ]);

        for (const data of [ unmatchedMarker, overrunningSizes, shortPacket, new Uint8Array(0) ]) {
            const frames = splitVP9Superframe(data);
            expect(frames).toHaveLength(1);
            expect(frames[0]).toBe(data);
        }
    });
});

describe('hasVP9ShownFrame', () => {
    it.each([
        [ 'a shown key frame', PROFILE_0_SHOWN_KEY_FRAME ],
        [ 'a shown inter frame', PROFILE_0_SHOWN_INTER_FRAME ],
        [ 'a show_existing_frame header', PROFILE_0_SHOW_EXISTING_FRAME ],
        [ 'a shown Profile 2 frame', PROFILE_2_SHOWN_INTER_FRAME ],
        [ 'a shown Profile 3 frame', PROFILE_3_SHOWN_INTER_FRAME ],
        [ 'a Profile 3 show_existing_frame header', PROFILE_3_SHOW_EXISTING_FRAME ]
    ])('shows %s', (_description: string, headerByte: number) => {
        expect(hasVP9ShownFrame(createFrame(headerByte))).toBe(true);
    });

    it.each([
        [ 'Profile 0', PROFILE_0_HIDDEN_INTER_FRAME ],
        [ 'Profile 1', PROFILE_1_HIDDEN_INTER_FRAME ],
        [ 'Profile 2', PROFILE_2_HIDDEN_INTER_FRAME ],
        // Read without the reserved bit, this header would set show_frame
        [ 'Profile 3', PROFILE_3_HIDDEN_INTER_FRAME ]
    ])('hides a %s frame without show_frame', (_profile: string, headerByte: number) => {
        expect(hasVP9ShownFrame(createFrame(headerByte))).toBe(false);
    });

    it('shows a superframe whose hidden frames precede a shown one, and hides one of hidden frames only', () => {
        const hiddenFrame = createFrame(PROFILE_2_HIDDEN_INTER_FRAME);

        expect(hasVP9ShownFrame(createSuperframe([ hiddenFrame, createFrame(PROFILE_2_SHOWN_INTER_FRAME) ], 1))).toBe(true);
        expect(hasVP9ShownFrame(createSuperframe([ hiddenFrame, hiddenFrame ], 1))).toBe(false);
    });

    it('counts a frame it cannot read as shown, so the decoder reports it', () => {
        expect(hasVP9ShownFrame(createFrame(INVALID_FRAME_MARKER_HEADER))).toBe(true);
        expect(hasVP9ShownFrame(new Uint8Array(0))).toBe(true);
        expect(hasVP9ShownFrame(createSuperframe([ createFrame(PROFILE_0_HIDDEN_INTER_FRAME), new Uint8Array(0) ], 1))).toBe(true);
    });
});
