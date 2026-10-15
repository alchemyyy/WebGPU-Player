import type { InputVideoTrack } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { readMatroskaMPEGVideoDecoderDescription } from 'webgpu-player/demux/mpeg/MatroskaMPEGVideoConfiguration';

// A sequence header's start code and a few of its bytes
const SEQUENCE_HEADER_CODEC_PRIVATE = new Uint8Array([ 0x00, 0x00, 0x01, 0xB3, 0x2D, 0x02, 0x40, 0x33 ]);

function createTrack(codecPrivate: unknown): InputVideoTrack {
    return { _backing: { internalTrack: { codecPrivate } } } as unknown as InputVideoTrack;
}

describe('readMatroskaMPEGVideoDecoderDescription', () => {
    it('returns its own copy of the CodecPrivate', () => {
        const codecPrivate = SEQUENCE_HEADER_CODEC_PRIVATE.slice();

        const description = readMatroskaMPEGVideoDecoderDescription(createTrack(codecPrivate));
        codecPrivate.fill(0);

        expect(description).toEqual(SEQUENCE_HEADER_CODEC_PRIVATE);
    });

    it.each([
        [ 'no CodecPrivate', undefined ],
        [ 'an empty CodecPrivate', new Uint8Array() ],
        [ 'a CodecPrivate of another type', [ 0x00, 0x00, 0x01, 0xB3 ] ]
    ])('returns null for a track with %s, whose packets carry the sequence headers', (_label: string, codecPrivate: unknown) => {
        expect(readMatroskaMPEGVideoDecoderDescription(createTrack(codecPrivate))).toBeNull();
    });

    it('returns null for a track without a Matroska backing', () => {
        expect(readMatroskaMPEGVideoDecoderDescription({} as InputVideoTrack)).toBeNull();
    });
});
