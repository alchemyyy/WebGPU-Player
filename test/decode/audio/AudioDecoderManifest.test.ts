// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    AUDIO_DECODER_DEFAULT_PACKET_BYTE_LENGTH,
    AUDIO_DECODER_MAXIMUM_PACKET_BYTE_LENGTH,
    AudioDecoderManifestError,
    parseAudioDecoderManifest,
    type AudioDecoderManifestErrorCode
} from 'webgpu-player/decode/audio/AudioDecoderManifest';
import { DECODER_PACKAGE_ID_MAXIMUM_LENGTH } from 'webgpu-player/decode/packages/DecoderPackageIdentity';

const DECODER_NAME = 'Test decoder';
const DECODER_ID = 'test-eac3';
const NAME_LINE = `//! name: ${DECODER_NAME}`;
const DECODER_LINE = '//! decoder: audio';
const ACCEPTS_LINE = '//! accepts: codec in [eac3, ac3]';
const ID_LINE = `//! id: ${DECODER_ID}`;
// The id line comes last, so the other required lines keep their line numbers in every case
const REQUIRED_LINES_WITHOUT_ID: readonly string[] = [ NAME_LINE, DECODER_LINE, ACCEPTS_LINE ];
const REQUIRED_LINES: readonly string[] = [ ...REQUIRED_LINES_WITHOUT_ID, ID_LINE ];
const ID_LINE_NUMBER = REQUIRED_LINES.length;
const ACCEPTED_CODECS: readonly string[] = [ 'eac3', 'ac3' ];
// An id of the longest allowed length plus one character
const OVERLONG_ID = 'a'.repeat(DECODER_PACKAGE_ID_MAXIMUM_LENGTH + 1);
// The 1-based line after the required ones, where a test's own directive sits
const FIRST_EXTRA_LINE = REQUIRED_LINES.length + 1;
const MINIMUM_KEY = 1;
const MAXIMUM_KEY = 255;
const KIBIBYTE = 1_024;
const SMALL_PACKET_BYTE_LENGTH = 512;
const PACKET_KIBIBYTE_COUNT = 64;
const MAXIMUM_PACKET_MEBIBYTE_COUNT = AUDIO_DECODER_MAXIMUM_PACKET_BYTE_LENGTH / (KIBIBYTE * KIBIBYTE);
// Key and name pairs, the way a bridge declares its keys and codes
const ATTRIBUTE_KEY = 1;
const ATTRIBUTE_NAME = 'bitsPerSample';
const OPTION_KEY = 1;
const OPTION_NAME = 'pcmFingerprint';
const ERROR_KEY = 2;
const ERROR_NAME = 'send';
const BODY_TEXT = 'The manifest of a test decoder, which no header line follows';
const CRLF = '\r\n';
const BLANK_HEADER_LINE = '//!';
// Every check a header can fail; the record's type makes the compiler require each one
const ALL_ERROR_CODES: Readonly<Record<AudioDecoderManifestErrorCode, true>> = {
    'accepts-syntax': true,
    'attribute-duplicate': true,
    'attribute-syntax': true,
    'codec-duplicate': true,
    'codec-syntax': true,
    'decoder-kind': true,
    'directive-missing': true,
    'directive-repeated': true,
    'directive-unknown': true,
    'error-duplicate': true,
    'error-syntax': true,
    'header-missing': true,
    'header-syntax': true,
    'id-length': true,
    'id-syntax': true,
    'name-empty': true,
    'option-duplicate': true,
    'option-syntax': true,
    'packet-size': true,
    'packet-syntax': true
};

type ManifestFailureCase = readonly [ description: string, lines: readonly string[], code: AudioDecoderManifestErrorCode, detail: string, line: number ];

function createSource(lines: readonly string[]): string {
    return lines.join('\n');
}

function createSourceWith(...extraLines: string[]): string {
    return createSource([ ...REQUIRED_LINES, ...extraLines ]);
}

/** Parses a source that must fail, returning the failure. */
function parseFailure(source: string): AudioDecoderManifestError {
    try {
        parseAudioDecoderManifest(source);
    } catch (error) {
        if (error instanceof AudioDecoderManifestError) {
            return error;
        }
        throw error;
    }
    throw new Error('The manifest parsed');
}

const FAILURE_CASES: readonly ManifestFailureCase[] = [
    [ 'a source without a header', [ BODY_TEXT ], 'header-missing', `'${BODY_TEXT}'`, 1 ],
    [ 'an empty source', [ '' ], 'header-missing', '\'\'', 1 ],
    [ 'a header line that is no directive', [ NAME_LINE, '//! decoder audio' ], 'header-syntax', '\'//! decoder audio\'', 2 ],
    [ 'a repeated name', [ ...REQUIRED_LINES, '//! name: Other' ], 'directive-repeated', '\'name\'', FIRST_EXTRA_LINE ],
    [ 'a repeated packet bound', [ ...REQUIRED_LINES, '//! packet: 1 KiB', '//! packet: 2 KiB' ], 'directive-repeated', '\'packet\'', FIRST_EXTRA_LINE + 1 ],
    [ 'a header without an id', REQUIRED_LINES_WITHOUT_ID, 'directive-missing', '\'id\'', 1 ],
    [ 'a header without a name', [ DECODER_LINE, ACCEPTS_LINE, ID_LINE ], 'directive-missing', '\'name\'', 1 ],
    [ 'a header without a kind', [ NAME_LINE, ACCEPTS_LINE, ID_LINE ], 'directive-missing', '\'decoder\'', 1 ],
    [ 'a header without its codecs', [ NAME_LINE, DECODER_LINE, ID_LINE ], 'directive-missing', '\'accepts\'', 1 ],
    [ 'a repeated id', [ ...REQUIRED_LINES, ID_LINE ], 'directive-repeated', '\'id\'', FIRST_EXTRA_LINE ],
    [ 'an uppercase id', [ ...REQUIRED_LINES_WITHOUT_ID, '//! id: E-AC-3' ], 'id-syntax', '\'E-AC-3\'', ID_LINE_NUMBER ],
    [ 'an empty id', [ ...REQUIRED_LINES_WITHOUT_ID, '//! id:' ], 'id-syntax', '\'\'', ID_LINE_NUMBER ],
    [ 'an id with an underscore', [ ...REQUIRED_LINES_WITHOUT_ID, '//! id: e_ac3' ], 'id-syntax', '\'e_ac3\'', ID_LINE_NUMBER ],
    [ 'an id past the longest', [ ...REQUIRED_LINES_WITHOUT_ID, `//! id: ${OVERLONG_ID}` ], 'id-length', `${OVERLONG_ID.length} > ${DECODER_PACKAGE_ID_MAXIMUM_LENGTH}`, ID_LINE_NUMBER ],
    [ 'a video decoder directive', [ ...REQUIRED_LINES, '//! output: I420' ], 'directive-unknown', '\'output\'', FIRST_EXTRA_LINE ],
    [ 'an empty name', [ '//! name:', DECODER_LINE, ACCEPTS_LINE, ID_LINE ], 'name-empty', '\'\'', 1 ],
    [ 'a video kind', [ NAME_LINE, '//! decoder: video', ACCEPTS_LINE, ID_LINE ], 'decoder-kind', '\'video\'', 2 ],
    [ 'codecs without the codec list', [ NAME_LINE, DECODER_LINE, '//! accepts: eac3', ID_LINE ], 'accepts-syntax', '\'eac3\'', 3 ],
    [ 'codecs without brackets', [ NAME_LINE, DECODER_LINE, '//! accepts: codec in eac3', ID_LINE ], 'accepts-syntax', '\'codec in eac3\'', 3 ],
    [ 'an uppercase codec', [ NAME_LINE, DECODER_LINE, '//! accepts: codec in [E-AC-3]', ID_LINE ], 'codec-syntax', '\'E-AC-3\'', 3 ],
    [ 'a codec with an underscore', [ NAME_LINE, DECODER_LINE, '//! accepts: codec in [pcm_s16le]', ID_LINE ], 'codec-syntax', '\'pcm_s16le\'', 3 ],
    [ 'an empty codec list', [ NAME_LINE, DECODER_LINE, '//! accepts: codec in []', ID_LINE ], 'codec-syntax', '\'\'', 3 ],
    [ 'a trailing comma', [ NAME_LINE, DECODER_LINE, '//! accepts: codec in [eac3,]', ID_LINE ], 'codec-syntax', '\'\'', 3 ],
    [ 'a codec listed twice', [ NAME_LINE, DECODER_LINE, '//! accepts: codec in [eac3, ac3, eac3]', ID_LINE ], 'codec-duplicate', '\'eac3\'', 3 ],
    [ 'a packet bound in an unknown unit', [ ...REQUIRED_LINES, '//! packet: 2 GiB' ], 'packet-syntax', '\'2 GiB\'', FIRST_EXTRA_LINE ],
    [ 'a fractional packet bound', [ ...REQUIRED_LINES, '//! packet: 1.5 MiB' ], 'packet-syntax', '\'1.5 MiB\'', FIRST_EXTRA_LINE ],
    [ 'a packet bound without a count', [ ...REQUIRED_LINES, '//! packet: MiB' ], 'packet-syntax', '\'MiB\'', FIRST_EXTRA_LINE ],
    [ 'an empty packet bound', [ ...REQUIRED_LINES, '//! packet: 0' ], 'packet-size', `0 outside [1, ${AUDIO_DECODER_MAXIMUM_PACKET_BYTE_LENGTH}]`, FIRST_EXTRA_LINE ],
    [
        'a packet bound past the engine\'s',
        [ ...REQUIRED_LINES, `//! packet: ${MAXIMUM_PACKET_MEBIBYTE_COUNT + 1} MiB` ],
        'packet-size',
        `${AUDIO_DECODER_MAXIMUM_PACKET_BYTE_LENGTH + KIBIBYTE * KIBIBYTE} outside [1, ${AUDIO_DECODER_MAXIMUM_PACKET_BYTE_LENGTH}]`,
        FIRST_EXTRA_LINE
    ],
    [ 'an attribute without a key', [ ...REQUIRED_LINES, `//! attribute: ${ATTRIBUTE_NAME}` ], 'attribute-syntax', `'${ATTRIBUTE_NAME}'`, FIRST_EXTRA_LINE ],
    [ 'an attribute of three parts', [ ...REQUIRED_LINES, '//! attribute: 1, depth, bits' ], 'attribute-syntax', '\'1, depth, bits\'', FIRST_EXTRA_LINE ],
    [ 'an attribute named by no identifier', [ ...REQUIRED_LINES, '//! attribute: 1, bits-per-sample' ], 'attribute-syntax', '\'1, bits-per-sample\'', FIRST_EXTRA_LINE ],
    [ 'an attribute name that starts with a digit', [ ...REQUIRED_LINES, '//! attribute: 1, 24bits' ], 'attribute-syntax', '\'1, 24bits\'', FIRST_EXTRA_LINE ],
    [ 'an attribute key that is no count', [ ...REQUIRED_LINES, '//! attribute: -1, bits' ], 'attribute-syntax', '\'-1, bits\'', FIRST_EXTRA_LINE ],
    [ 'an attribute key below the range', [ ...REQUIRED_LINES, '//! attribute: 0, bits' ], 'attribute-syntax', `0 outside [${MINIMUM_KEY}, ${MAXIMUM_KEY}]`, FIRST_EXTRA_LINE ],
    [ 'an attribute key above the range', [ ...REQUIRED_LINES, '//! attribute: 256, bits' ], 'attribute-syntax', `256 outside [${MINIMUM_KEY}, ${MAXIMUM_KEY}]`, FIRST_EXTRA_LINE ],
    [ 'an attribute key named twice', [ ...REQUIRED_LINES, '//! attribute: 1, bits', '//! attribute: 1, depth' ], 'attribute-duplicate', '\'1, depth\'', FIRST_EXTRA_LINE + 1 ],
    [ 'an attribute name given two keys', [ ...REQUIRED_LINES, '//! attribute: 1, bits', '//! attribute: 2, bits' ], 'attribute-duplicate', '\'2, bits\'', FIRST_EXTRA_LINE + 1 ],
    [ 'an option without a key', [ ...REQUIRED_LINES, `//! option: ${OPTION_NAME}` ], 'option-syntax', `'${OPTION_NAME}'`, FIRST_EXTRA_LINE ],
    [ 'an option named by no identifier', [ ...REQUIRED_LINES, '//! option: 1, pcm fingerprint' ], 'option-syntax', '\'1, pcm fingerprint\'', FIRST_EXTRA_LINE ],
    [ 'an option key above the range', [ ...REQUIRED_LINES, '//! option: 256, fingerprint' ], 'option-syntax', `256 outside [${MINIMUM_KEY}, ${MAXIMUM_KEY}]`, FIRST_EXTRA_LINE ],
    [ 'an option key named twice', [ ...REQUIRED_LINES, '//! option: 1, fingerprint', '//! option: 1, dialogue' ], 'option-duplicate', '\'1, dialogue\'', FIRST_EXTRA_LINE + 1 ],
    [ 'an option name given two keys', [ ...REQUIRED_LINES, '//! option: 1, fingerprint', '//! option: 2, fingerprint' ], 'option-duplicate', '\'2, fingerprint\'', FIRST_EXTRA_LINE + 1 ],
    [ 'an error without a key', [ ...REQUIRED_LINES, `//! error: ${ERROR_NAME}` ], 'error-syntax', `'${ERROR_NAME}'`, FIRST_EXTRA_LINE ],
    [ 'an error key below the range', [ ...REQUIRED_LINES, '//! error: 0, input' ], 'error-syntax', `0 outside [${MINIMUM_KEY}, ${MAXIMUM_KEY}]`, FIRST_EXTRA_LINE ],
    [ 'an error code named twice', [ ...REQUIRED_LINES, '//! error: 1, input', '//! error: 1, send' ], 'error-duplicate', '\'1, send\'', FIRST_EXTRA_LINE + 1 ],
    [ 'an error name given two codes', [ ...REQUIRED_LINES, '//! error: 1, input', '//! error: 2, input' ], 'error-duplicate', '\'2, input\'', FIRST_EXTRA_LINE + 1 ]
];

describe('parseAudioDecoderManifest', () => {
    it('parses the required directives, with the default packet bound and no keys', () => {
        expect(parseAudioDecoderManifest(createSource(REQUIRED_LINES))).toEqual({
            attributes: new Map(),
            codecs: ACCEPTED_CODECS,
            errors: new Map(),
            id: DECODER_ID,
            name: DECODER_NAME,
            options: new Map(),
            packetByteLength: AUDIO_DECODER_DEFAULT_PACKET_BYTE_LENGTH
        });
    });

    it('names attribute, option, and error keys in maps of their own, so one key and name may appear in each', () => {
        const manifest = parseAudioDecoderManifest(createSourceWith(
            `//! attribute: ${ATTRIBUTE_KEY}, ${ATTRIBUTE_NAME}`,
            `//! attribute: ${MAXIMUM_KEY}, ${OPTION_NAME}`,
            `//! option: ${OPTION_KEY}, ${OPTION_NAME}`,
            `//! error: ${MINIMUM_KEY}, ${OPTION_NAME}`,
            `//! error: ${ERROR_KEY}, ${ERROR_NAME}`
        ));

        expect(manifest.attributes).toEqual(new Map([ [ ATTRIBUTE_KEY, ATTRIBUTE_NAME ], [ MAXIMUM_KEY, OPTION_NAME ] ]));
        expect(manifest.options).toEqual(new Map([ [ OPTION_KEY, OPTION_NAME ] ]));
        expect(manifest.errors).toEqual(new Map([ [ MINIMUM_KEY, OPTION_NAME ], [ ERROR_KEY, ERROR_NAME ] ]));
    });

    it.each([
        [ '1', 1 ],
        [ `${SMALL_PACKET_BYTE_LENGTH}`, SMALL_PACKET_BYTE_LENGTH ],
        [ `${SMALL_PACKET_BYTE_LENGTH} B`, SMALL_PACKET_BYTE_LENGTH ],
        [ `${PACKET_KIBIBYTE_COUNT} KiB`, PACKET_KIBIBYTE_COUNT * KIBIBYTE ],
        [ `${PACKET_KIBIBYTE_COUNT}KiB`, PACKET_KIBIBYTE_COUNT * KIBIBYTE ],
        [ `${MAXIMUM_PACKET_MEBIBYTE_COUNT} MiB`, AUDIO_DECODER_MAXIMUM_PACKET_BYTE_LENGTH ]
    ])('reads the packet bound %s as %i bytes', (value, byteLength) => {
        expect(parseAudioDecoderManifest(createSourceWith(`//! packet: ${value}`)).packetByteLength).toBe(byteLength);
    });

    it('reads CRLF lines and blank header lines, and ignores what follows the header', () => {
        const source = [ NAME_LINE, BLANK_HEADER_LINE, DECODER_LINE, ACCEPTS_LINE, ID_LINE, '', BODY_TEXT, '//! name: Ignored' ].join(CRLF);

        expect(parseAudioDecoderManifest(source)).toMatchObject({ codecs: ACCEPTED_CODECS, id: DECODER_ID, name: DECODER_NAME });
    });

    it.each(FAILURE_CASES)('refuses %s', (_description, lines, code, detail, line) => {
        const failure = parseFailure(createSource(lines));

        expect(failure).toMatchObject({ code, detail, line, message: `${code}: ${detail}`, name: 'AudioDecoderManifestError' });
    });

    it('checks every error code a header can fail', () => {
        const checkedCodes = new Set(FAILURE_CASES.map(([ , , code ]) => code));

        expect(new Set(checkedCodes)).toEqual(new Set(Object.keys(ALL_ERROR_CODES)));
    });
});
