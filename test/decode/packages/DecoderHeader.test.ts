import { describe, expect, it } from 'vitest';

import { DecoderHeaderError, readDecoderHeader, readDecoderKind } from 'webgpu-player/decode/packages/DecoderHeader';

const DECODER_NAME = 'ProRes 422';
const VIDEO_KIND = 'video';
const AUDIO_KIND = 'audio';
const ACCEPTS_VALUE = 'codec in [prores], stream.width <= 8192';
// A directive whose name has a hyphen, and a value that holds colons of its own
const HYPHENATED_DIRECTIVE_NAME = 'frame-rate';
const HYPHENATED_DIRECTIVE_VALUE = '1';
const VECTOR_VALUE = 'I420, frames 0-1, sha256 ab:cd';
const BODY_LINE = 'fn decodePicture() {}';
// Lines that start like a directive and are none: a name with a digit, and a missing colon
const NUMBERED_DIRECTIVE_LINE = '//! h264: yes';
const COLONLESS_DIRECTIVE_LINE = '//! name ProRes';
// The 1-based line of the malformed directive in the sources below
const MALFORMED_DIRECTIVE_LINE = 2;

describe('readDecoderHeader', () => {
    it('reads each directive with its 1-based line and trimmed value, and where the body starts', () => {
        const lines = [
            `//! name: ${DECODER_NAME}`,
            `//!   decoder  :  ${VIDEO_KIND}  `,
            `//! accepts: ${ACCEPTS_VALUE}`,
            `//! ${HYPHENATED_DIRECTIVE_NAME}: ${HYPHENATED_DIRECTIVE_VALUE}`,
            `//! vector: ${VECTOR_VALUE}`,
            '',
            BODY_LINE
        ];

        expect(readDecoderHeader(lines)).toEqual({
            bodyFirstLine: 6,
            directives: [
                { line: 1, name: 'name', value: DECODER_NAME },
                { line: 2, name: 'decoder', value: VIDEO_KIND },
                { line: 3, name: 'accepts', value: ACCEPTS_VALUE },
                { line: 4, name: HYPHENATED_DIRECTIVE_NAME, value: HYPHENATED_DIRECTIVE_VALUE },
                { line: 5, name: 'vector', value: VECTOR_VALUE }
            ]
        });
    });

    it('skips a blank directive line and an indented one, and ends the header at the first other line', () => {
        const lines = [
            `//! name: ${DECODER_NAME}`,
            '//!',
            `   //! decoder: ${VIDEO_KIND}`,
            BODY_LINE,
            `//! accepts: ${ACCEPTS_VALUE}`
        ];

        expect(readDecoderHeader(lines)).toEqual({
            bodyFirstLine: 4,
            directives: [
                { line: 1, name: 'name', value: DECODER_NAME },
                { line: 3, name: 'decoder', value: VIDEO_KIND }
            ]
        });
    });

    it('reads a source that is all header, and one without any', () => {
        expect(readDecoderHeader([ `//! name: ${DECODER_NAME}` ]).bodyFirstLine).toBe(2);
        expect(readDecoderHeader([ BODY_LINE ])).toEqual({ bodyFirstLine: 1, directives: [] });
    });

    it.each([ NUMBERED_DIRECTIVE_LINE, COLONLESS_DIRECTIVE_LINE ])('refuses the header line %s, quoting it at its line', (malformedLine: string) => {
        let caught: unknown = null;
        try {
            readDecoderHeader([ `//! name: ${DECODER_NAME}`, malformedLine ]);
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(DecoderHeaderError);
        expect(caught).toMatchObject({ detail: `'${malformedLine}'`, line: MALFORMED_DIRECTIVE_LINE, name: 'DecoderHeaderError' });
    });
});

describe('readDecoderKind', () => {
    it('reads the kind the decoder directive names, across either line ending', () => {
        expect(readDecoderKind(`//! name: ${DECODER_NAME}\n//! decoder: ${VIDEO_KIND}\n${BODY_LINE}`)).toBe(VIDEO_KIND);
        expect(readDecoderKind(`//! name: ${DECODER_NAME}\r\n//! decoder: ${AUDIO_KIND}\r\n`)).toBe(AUDIO_KIND);
    });

    it('takes the first decoder directive of a header that repeats it', () => {
        expect(readDecoderKind(`//! decoder: ${AUDIO_KIND}\n//! decoder: ${VIDEO_KIND}`)).toBe(AUDIO_KIND);
    });

    it('names no kind for a header without a decoder directive, a malformed header, or a decoder directive after the header', () => {
        expect(readDecoderKind(`//! name: ${DECODER_NAME}`)).toBeNull();
        expect(readDecoderKind(`${NUMBERED_DIRECTIVE_LINE}\n//! decoder: ${VIDEO_KIND}`)).toBeNull();
        expect(readDecoderKind(`${BODY_LINE}\n//! decoder: ${VIDEO_KIND}`)).toBeNull();
        expect(readDecoderKind('')).toBeNull();
    });
});
