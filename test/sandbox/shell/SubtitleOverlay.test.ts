import { describe, expect, it } from 'vitest';

import { type Microseconds, MICROSECONDS_PER_SECOND } from 'webgpu-player/MediaTime';

import type { SubtitleCue } from '../../../sandbox/src/contracts/SandboxContracts';
import { getActiveCueText } from '../../../sandbox/src/ui/panels/SubtitleOverlay';

const FIRST_CUE_TEXT = 'First line\nSecond line';
const OVERLAPPING_CUE_TEXT = 'Overlapping sign';
const LATER_CUE_TEXT = 'Later';
const FIRST_CUE_START = asMicroseconds(MICROSECONDS_PER_SECOND);
const FIRST_CUE_END = asMicroseconds(3 * MICROSECONDS_PER_SECOND);
const OVERLAP_START = asMicroseconds(2 * MICROSECONDS_PER_SECOND);
const OVERLAP_END = asMicroseconds(4 * MICROSECONDS_PER_SECOND);
const LATER_CUE_START = asMicroseconds(10 * MICROSECONDS_PER_SECOND);
const LATER_CUE_END = asMicroseconds(12 * MICROSECONDS_PER_SECOND);
const BEFORE_EVERY_CUE = asMicroseconds(0);
const INSIDE_FIRST_CUE_ONLY = asMicroseconds(1.5 * MICROSECONDS_PER_SECOND);
const INSIDE_BOTH_CUES = asMicroseconds(2.5 * MICROSECONDS_PER_SECOND);
const BETWEEN_CUES = asMicroseconds(5 * MICROSECONDS_PER_SECOND);

// Out of start order, as a subtitle file may list them
const CUES: readonly SubtitleCue[] = [
    { endMicroseconds: LATER_CUE_END, startMicroseconds: LATER_CUE_START, text: LATER_CUE_TEXT },
    { endMicroseconds: FIRST_CUE_END, startMicroseconds: FIRST_CUE_START, text: FIRST_CUE_TEXT },
    { endMicroseconds: OVERLAP_END, startMicroseconds: OVERLAP_START, text: OVERLAPPING_CUE_TEXT }
];

function asMicroseconds(value: number): Microseconds {
    return value as Microseconds;
}

describe('getActiveCueText', () => {
    it('shows a cue from its start up to, not including, its end', () => {
        expect(getActiveCueText(CUES, FIRST_CUE_START)).toBe(FIRST_CUE_TEXT);
        expect(getActiveCueText(CUES, INSIDE_FIRST_CUE_ONLY)).toBe(FIRST_CUE_TEXT);
        expect(getActiveCueText(CUES, LATER_CUE_START)).toBe(LATER_CUE_TEXT);
        expect(getActiveCueText(CUES, LATER_CUE_END)).toBe('');
    });

    it('stacks overlapping cues in cue order, one per line', () => {
        expect(getActiveCueText(CUES, INSIDE_BOTH_CUES)).toBe(`${FIRST_CUE_TEXT}\n${OVERLAPPING_CUE_TEXT}`);
        expect(getActiveCueText(CUES, FIRST_CUE_END)).toBe(OVERLAPPING_CUE_TEXT);
    });

    it('shows nothing outside every cue or without cues', () => {
        expect(getActiveCueText(CUES, BEFORE_EVERY_CUE)).toBe('');
        expect(getActiveCueText(CUES, BETWEEN_CUES)).toBe('');
        expect(getActiveCueText([], INSIDE_BOTH_CUES)).toBe('');
    });
});
