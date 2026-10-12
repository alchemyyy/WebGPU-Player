// WebVTT text, as ffmpeg converts every subtitle source, read into plain-text cues in integer microseconds.
import { type Microseconds, MICROSECONDS_PER_MILLISECOND, MICROSECONDS_PER_SECOND } from 'webgpu-player/MediaTime';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

import type { SubtitleCue } from '../contracts/SandboxContracts';

const LINE_BREAK_PATTERN = /\r\n|\r|\n/;
const TIMING_SEPARATOR = '-->';
// [hours:]minutes:seconds.milliseconds, as WebVTT timestamps are written
const TIMESTAMP_PATTERN = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/;
const WHITESPACE_PATTERN = /\s+/;
// Cue text markup: tags such as <i>, <c.yellow>, and <00:01.000>, and the entities WebVTT escapes
const TAG_START = '<';
const TAG_END = '>';
const ENTITY_REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
    [ /&lt;/g, '<' ],
    [ /&gt;/g, '>' ],
    [ /&nbsp;/g, ' ' ],
    [ /&lrm;|&rlm;/g, '' ],
    // Last, so an escaped entity such as &amp;lt; stays literal
    [ /&amp;/g, '&' ]
];
const CUE_LINE_SEPARATOR = '\n';
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** Parses a WebVTT timestamp into integer microseconds, or null when it is malformed. */
function parseTimestamp(text: string): Microseconds | null {
    const match = TIMESTAMP_PATTERN.exec(text);
    if (match === null) {
        return null;
    }
    const hours = Number(match[1] ?? 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const milliseconds = Number(match[4]);
    const totalSeconds = (hours * MINUTES_PER_HOUR + minutes) * SECONDS_PER_MINUTE + seconds;
    return requireMicroseconds(totalSeconds * MICROSECONDS_PER_SECOND + milliseconds * MICROSECONDS_PER_MILLISECOND, 'WebVTT timestamp');
}

/** Removes cue markup tags; an unclosed tag runs to the end of the line. */
function removeTags(text: string): string {
    const characters: string[] = [];
    let insideTag = false;
    for (const character of text) {
        if (character === TAG_START) {
            insideTag = true;
        } else if (insideTag) {
            insideTag = character !== TAG_END;
        } else {
            characters.push(character);
        }
    }
    return characters.join('');
}

/** Removes cue markup, leaving the text a viewer reads. */
function toPlainText(text: string): string {
    let plainText = removeTags(text);
    for (const [ pattern, replacement ] of ENTITY_REPLACEMENTS) {
        plainText = plainText.replace(pattern, replacement);
    }
    return plainText;
}

/**
 * Parses WebVTT into cues in start order.
 * A block counts as a cue when a line holds its timing; text lines follow until a blank line, and a cue without text or with an end before its start is skipped.
 */
export function parseWebVTTCues(text: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    const lines = text.split(LINE_BREAK_PATTERN);
    let lineIndex = 0;
    while (lineIndex < lines.length) {
        const line = lines[lineIndex];
        lineIndex += 1;
        if (!line.includes(TIMING_SEPARATOR)) {
            continue;
        }
        const [ startText, endAndSettings ] = line.split(TIMING_SEPARATOR);
        const startMicroseconds = parseTimestamp(startText.trim());
        // Cue settings, such as position:10%, follow the end time
        const endMicroseconds = parseTimestamp(endAndSettings.trim().split(WHITESPACE_PATTERN)[0]);
        const textLines: string[] = [];
        while (lineIndex < lines.length && lines[lineIndex].trim() !== '') {
            textLines.push(toPlainText(lines[lineIndex]));
            lineIndex += 1;
        }
        const cueText = textLines.join(CUE_LINE_SEPARATOR).trim();
        if (startMicroseconds === null || endMicroseconds === null || endMicroseconds < startMicroseconds || cueText === '') {
            continue;
        }
        cues.push({ endMicroseconds, startMicroseconds, text: cueText });
    }
    return cues.sort((first: SubtitleCue, second: SubtitleCue): number => first.startMicroseconds - second.startMicroseconds);
}
