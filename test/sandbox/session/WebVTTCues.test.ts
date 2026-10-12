import { describe, expect, it } from 'vitest';

import { parseWebVTTCues } from '../../../sandbox/src/session/WebVTTCues';

// Cue times as WebVTT writes them, and the integer microseconds they hold
const FIRST_START_TEXT = '00:00:01.500';
const FIRST_START_MICROSECONDS = 1_500_000;
const FIRST_END_TEXT = '00:00:03.250';
const FIRST_END_MICROSECONDS = 3_250_000;
// Without hours, as WebVTT allows below an hour
const SECOND_START_TEXT = '01:02.003';
const SECOND_START_MICROSECONDS = 62_003_000;
const SECOND_END_TEXT = '01:04.000';
const SECOND_END_MICROSECONDS = 64_000_000;
// Past a day, which an hour count of more than two digits writes
const LATE_START_TEXT = '100:00:00.000';
const LATE_START_MICROSECONDS = 360_000_000_000;
const LATE_END_TEXT = '100:00:01.000';
const LATE_END_MICROSECONDS = 360_001_000_000;

const FIRST_TEXT = 'Hello there.';
const SECOND_LINES = [ 'Two lines,', 'one cue.' ];

/** Joins WebVTT lines as ffmpeg writes them. */
function createWebVTT(lines: readonly string[]): string {
    return [ 'WEBVTT', '', ...lines, '' ].join('\n');
}

describe('WebVTTCues', () => {
    it('reads cue times exactly, with and without hours, and keeps every text line', () => {
        const cues = parseWebVTTCues(createWebVTT([
            `${FIRST_START_TEXT} --> ${FIRST_END_TEXT}`,
            FIRST_TEXT,
            '',
            `${SECOND_START_TEXT} --> ${SECOND_END_TEXT}`,
            ...SECOND_LINES,
            '',
            `${LATE_START_TEXT} --> ${LATE_END_TEXT}`,
            FIRST_TEXT
        ]));

        expect(cues).toEqual([
            { endMicroseconds: FIRST_END_MICROSECONDS, startMicroseconds: FIRST_START_MICROSECONDS, text: FIRST_TEXT },
            { endMicroseconds: SECOND_END_MICROSECONDS, startMicroseconds: SECOND_START_MICROSECONDS, text: SECOND_LINES.join('\n') },
            { endMicroseconds: LATE_END_MICROSECONDS, startMicroseconds: LATE_START_MICROSECONDS, text: FIRST_TEXT }
        ]);
    });

    it('removes markup and decodes entities, keeping escaped entities literal', () => {
        const [ cue ] = parseWebVTTCues(createWebVTT([
            `${FIRST_START_TEXT} --> ${FIRST_END_TEXT} position:10% align:start`,
            '<i>Tom</i> &amp; <c.yellow>Jerry</c> &lt;3 &amp;lt; <00:00:02.000>later'
        ]));

        expect(cue.text).toBe('Tom & Jerry <3 &lt; later');
    });

    it('accepts carriage returns and cue identifiers, and orders cues by start', () => {
        const text = [
            'WEBVTT',
            '',
            'second',
            `${SECOND_START_TEXT} --> ${SECOND_END_TEXT}`,
            SECOND_LINES[0],
            '',
            'first',
            `${FIRST_START_TEXT} --> ${FIRST_END_TEXT}`,
            FIRST_TEXT,
            ''
        ].join('\r\n');

        expect(parseWebVTTCues(text).map(cue => cue.startMicroseconds)).toEqual([ FIRST_START_MICROSECONDS, SECOND_START_MICROSECONDS ]);
    });

    it('skips cues with malformed times, an end before the start, or no text', () => {
        const cues = parseWebVTTCues(createWebVTT([
            `1.5 --> ${FIRST_END_TEXT}`,
            FIRST_TEXT,
            '',
            `${FIRST_END_TEXT} --> ${FIRST_START_TEXT}`,
            FIRST_TEXT,
            '',
            `${FIRST_START_TEXT} --> ${FIRST_END_TEXT}`,
            '<b></b>',
            '',
            `${FIRST_START_TEXT} --> ${FIRST_END_TEXT}`,
            FIRST_TEXT
        ]));

        expect(cues).toEqual([ { endMicroseconds: FIRST_END_MICROSECONDS, startMicroseconds: FIRST_START_MICROSECONDS, text: FIRST_TEXT } ]);
    });
});
