// When each field of a deinterlaced stream presents: the frames the deinterlacing pass holds in history, and which of them shows which field at a clock time.
// It follows FFmpeg's yadif filter: a frame shows its first field at its own time and, at double rate, its second halfway to the next frame;
// a progressive frame, or one beside a progressive frame that repeats a field, passes through once.
import type { VideoFrameFields } from '../decode/video/VideoFields';
import { PRESENTATION_FIELD_STATE } from './passes/PassResources';

/** How the deinterlacing pass presents interlaced frames: one frame per field, one per frame, or not at all, as woven frames. */
export type DeinterlaceMode = 'double-rate' | 'off' | 'single-rate';

/** The deinterlacing modes, which hosts' settings are checked against. */
export const DEINTERLACE_MODES: readonly DeinterlaceMode[] = Object.freeze([ 'double-rate', 'off', 'single-rate' ]);

/** The mode a presenter starts in: a frame per field, as broadcast interlaced video moves. */
export const DEFAULT_DEINTERLACE_MODE: DeinterlaceMode = 'double-rate';

/** A frame the deinterlacing pass wrote into history: its time, its duration, and its fields, or null when they are unknown and it presents as it is. */
export type DeinterlaceTimelineFrame = Readonly<{
    durationMicroseconds: number
    fields: VideoFrameFields | null
    timestampMicroseconds: number
}>;

/** What presents at a clock time: the PRESENTATION_FIELD_STATE bits of the shown field, and the time it presents at. */
export type DeinterlaceDraw = Readonly<{
    fieldState: number
    /** The shown frame's own time, or its second field's: halfway to the next frame, rounded down */
    timestampMicroseconds: number
}>;

// The frames history holds: the earliest, the shown frame or the one before it, and the newest
const HELD_FRAME_COUNT = 3;

function isInterlaced(frame: DeinterlaceTimelineFrame): boolean {
    return frame.fields !== null && frame.fields.scan !== 'progressive';
}

/** Returns whether a neighbour makes yadif pass a frame through: a progressive frame that repeats a field, as soft telecine marks it. */
function repeatsProgressiveField(frame: DeinterlaceTimelineFrame | null): boolean {
    return frame !== null && frame.fields !== null && frame.fields.scan === 'progressive' && frame.fields.repeatFirstField;
}

/** Returns whether an interlaced frame's first field in time is its top field: yadif takes the top field first for an order nobody named. */
function isTopFieldFirst(frame: DeinterlaceTimelineFrame): boolean {
    return frame.fields?.scan !== 'bottom-first';
}

/**
 * Mirrors the deinterlacing pass's history: the frames its signal holds, newest last, which must reset whenever the executor's history resets.
 * The frame shown is the one before the newest while the clock has not reached the newest, which the pass then reads as the next frame;
 * otherwise the newest is shown, without a next frame, as at the end of a stream or while decoding falls behind.
 */
export default class DeinterlaceTimeline {
    private readonly frames: DeinterlaceTimelineFrame[] = [];

    /** Starts over, as history does after a seek, a discontinuity, or a new plan. */
    reset(): void {
        this.frames.length = 0;
    }

    /** Records a new frame, which the signal writes into history. */
    push(frame: DeinterlaceTimelineFrame): void {
        this.frames.push(frame);
        if (this.frames.length > HELD_FRAME_COUNT) {
            this.frames.shift();
        }
    }

    getFrameCount(): number {
        return this.frames.length;
    }

    /** Returns whether the shown frame waits for its next frame, which deinterlacing reads: only the newest frame is held, and it is interlaced. */
    awaitsNextFrame(): boolean {
        return this.frames.length === 1 && isInterlaced(this.frames[0]);
    }

    /**
     * Returns how far ahead of the clock frames are taken: the newest frame's duration, so the frame after it arrives once the clock reaches it,
     * when it is the next frame of the frame shown; 0 while history holds nothing.
     */
    getLookaheadMicroseconds(): number {
        const newest = this.frames.at(-1);
        return newest === undefined ? 0 : Math.max(newest.durationMicroseconds, 0);
    }

    /** Returns what presents at a clock time, or null while history holds no frame. */
    getDraw(clockMicroseconds: number, mode: Exclude<DeinterlaceMode, 'off'>): DeinterlaceDraw | null {
        const frameCount = this.frames.length;
        if (frameCount === 0) {
            return null;
        }
        const newest = this.frames[frameCount - 1];
        const currentIsPrevious = frameCount > 1 && clockMicroseconds < newest.timestampMicroseconds;
        const currentIndex = currentIsPrevious ? frameCount - 2 : frameCount - 1;
        const current = this.frames[currentIndex];
        const next = currentIsPrevious ? newest : null;
        const previous = currentIndex > 0 ? this.frames[currentIndex - 1] : null;
        const shownFrameState = currentIsPrevious ? PRESENTATION_FIELD_STATE.currentIsPrevious : PRESENTATION_FIELD_STATE.none;
        if (!isInterlaced(current) || repeatsProgressiveField(previous) || repeatsProgressiveField(next)) {
            return { fieldState: shownFrameState, timestampMicroseconds: current.timestampMicroseconds };
        }
        // The second field presents halfway to the next frame, or through the shown frame's own duration without one
        const endMicroseconds = next === null ? current.timestampMicroseconds + current.durationMicroseconds : next.timestampMicroseconds;
        const secondFieldMicroseconds = current.timestampMicroseconds + Math.floor((endMicroseconds - current.timestampMicroseconds) / 2);
        const secondField = mode === 'double-rate'
            && endMicroseconds > current.timestampMicroseconds
            && clockMicroseconds >= secondFieldMicroseconds;
        const showsTopField = isTopFieldFirst(current) !== secondField;
        let fieldState = shownFrameState | PRESENTATION_FIELD_STATE.deinterlace;
        if (!showsTopField) {
            fieldState |= PRESENTATION_FIELD_STATE.bottomFieldShown;
        }
        if (secondField) {
            fieldState |= PRESENTATION_FIELD_STATE.secondField;
        }
        return { fieldState, timestampMicroseconds: secondField ? secondFieldMicroseconds : current.timestampMicroseconds };
    }
}
