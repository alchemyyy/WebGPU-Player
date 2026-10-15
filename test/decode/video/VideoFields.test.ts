import { describe, expect, it } from 'vitest';

import {
    createPictureFieldsWord,
    decodePictureFieldsWord,
    getScanFrameFields,
    isPictureFieldsWord,
    isVideoFrameFields,
    isVideoScan,
    PICTURE_FIELDS_WORD,
    VIDEO_SCANS,
    type VideoFrameFields,
    type VideoScan
} from 'webgpu-player/decode/video/VideoFields';

// The WGSL constants GPU decoders and parsers share: bit 0 reported, bit 1 interlaced, bit 2 top field first, bit 3 repeat first field
const REPORTED_PROGRESSIVE_WORD = 0x1;
const TOP_FIRST_WORD = 0x7;
const BOTTOM_FIRST_WORD = 0x3;
const REPEAT_FIRST_FIELD_WORD = 0x9;
const UNDEFINED_BIT = 0x10;
const NEGATIVE_WORD = -1;
const FRACTIONAL_WORD = 1.5;
const UNREPORTED_WORDS = [ 0x2, 0x4, 0x6, 0x8, 0xE ] as const;
const PROGRESSIVE_FIELDS: VideoFrameFields = { repeatFirstField: false, scan: 'progressive' };
const TOP_FIRST_FIELDS: VideoFrameFields = { repeatFirstField: false, scan: 'top-first' };
const BOTTOM_FIRST_FIELDS: VideoFrameFields = { repeatFirstField: false, scan: 'bottom-first' };
const UNKNOWN_SCAN_VALUE = 'field-sequential';

describe('picture fields words', () => {
    it('creates the word of every report', () => {
        expect(createPictureFieldsWord(false, false, false)).toBe(REPORTED_PROGRESSIVE_WORD);
        expect(createPictureFieldsWord(true, true, false)).toBe(TOP_FIRST_WORD);
        expect(createPictureFieldsWord(true, false, false)).toBe(BOTTOM_FIRST_WORD);
        expect(createPictureFieldsWord(false, false, true)).toBe(REPEAT_FIRST_FIELD_WORD);
    });

    it('decodes each report, and none for a word without the reported bit', () => {
        expect(decodePictureFieldsWord(PICTURE_FIELDS_WORD.none)).toBeNull();
        expect(decodePictureFieldsWord(REPORTED_PROGRESSIVE_WORD)).toEqual(PROGRESSIVE_FIELDS);
        expect(decodePictureFieldsWord(TOP_FIRST_WORD)).toEqual(TOP_FIRST_FIELDS);
        expect(decodePictureFieldsWord(BOTTOM_FIRST_WORD)).toEqual(BOTTOM_FIRST_FIELDS);
        expect(decodePictureFieldsWord(REPEAT_FIRST_FIELD_WORD)).toEqual({ repeatFirstField: true, scan: 'progressive' });
        for (const word of UNREPORTED_WORDS) {
            expect(decodePictureFieldsWord(word)).toBeNull();
        }
    });

    it('drops repeat first field from an interlaced report, which only a progressive frame carries', () => {
        expect(decodePictureFieldsWord(createPictureFieldsWord(true, true, true))).toEqual(TOP_FIRST_FIELDS);
    });

    it('round-trips every created word', () => {
        for (const interlaced of [ false, true ]) {
            for (const topFieldFirst of [ false, true ]) {
                const interlacedScan: VideoScan = topFieldFirst ? 'top-first' : 'bottom-first';
                for (const repeatFirstField of [ false, true ]) {
                    const word = createPictureFieldsWord(interlaced, topFieldFirst, repeatFirstField);
                    expect(isPictureFieldsWord(word)).toBe(true);
                    expect(decodePictureFieldsWord(word)?.scan).toBe(interlaced ? interlacedScan : 'progressive');
                }
            }
        }
    });

    it('accepts none and reports, and rejects words with undefined bits, unreported bits, or no integer value', () => {
        expect(isPictureFieldsWord(PICTURE_FIELDS_WORD.none)).toBe(true);
        expect(isPictureFieldsWord(TOP_FIRST_WORD)).toBe(true);
        expect(isPictureFieldsWord(TOP_FIRST_WORD | UNDEFINED_BIT)).toBe(false);
        expect(isPictureFieldsWord(NEGATIVE_WORD)).toBe(false);
        expect(isPictureFieldsWord(FRACTIONAL_WORD)).toBe(false);
        for (const word of UNREPORTED_WORDS) {
            expect(isPictureFieldsWord(word)).toBe(false);
        }
    });
});

describe('scans and frame fields', () => {
    it('gives a frame its stream\'s scan, and none for an unknown scan', () => {
        expect(getScanFrameFields('unknown')).toBeNull();
        for (const scan of VIDEO_SCANS.filter((candidate: VideoScan): boolean => candidate !== 'unknown')) {
            expect(getScanFrameFields(scan)).toEqual({ repeatFirstField: false, scan });
        }
    });

    it('checks scans and frame fields crossing a worker boundary', () => {
        for (const scan of VIDEO_SCANS) {
            expect(isVideoScan(scan)).toBe(true);
        }
        expect(isVideoScan(UNKNOWN_SCAN_VALUE)).toBe(false);
        expect(isVideoScan(null)).toBe(false);
        expect(isVideoFrameFields(TOP_FIRST_FIELDS)).toBe(true);
        expect(isVideoFrameFields({ repeatFirstField: true, scan: 'progressive' })).toBe(true);
        // A frame reports a scan it knows, or carries no fields
        expect(isVideoFrameFields({ repeatFirstField: false, scan: 'unknown' })).toBe(false);
        expect(isVideoFrameFields({ repeatFirstField: 1, scan: 'progressive' })).toBe(false);
        expect(isVideoFrameFields({ repeatFirstField: false, scan: UNKNOWN_SCAN_VALUE })).toBe(false);
        expect(isVideoFrameFields({ scan: 'top-first' })).toBe(false);
        expect(isVideoFrameFields(null)).toBe(false);
        expect(isVideoFrameFields(TOP_FIRST_WORD)).toBe(false);
    });
});
