import { describe, expect, it } from 'vitest';

import type { VideoFrameFields } from 'webgpu-player/decode/video/VideoFields';
import DeinterlaceTimeline, { type DeinterlaceDraw, type DeinterlaceTimelineFrame } from 'webgpu-player/presentation/DeinterlaceTimeline';
import { PRESENTATION_FIELD_STATE } from 'webgpu-player/presentation/passes/PassResources';

import { type ReferenceFrame, runYadifReference, type YadifRate } from '../helpers/yadifReference';

// 25 fps PAL frames, and 30000/1001 fps NTSC frames, whose odd duration makes the second field's time round down
const PAL_FRAME_DURATION_MICROSECONDS = 40_000;
const NTSC_FRAME_DURATION_MICROSECONDS = 33_367;
const NTSC_SECOND_FIELD_OFFSET_MICROSECONDS = 16_683;
const FIRST_TIMESTAMP_MICROSECONDS = 1_000_000;
// The frame loop's simulated tick, finer than any field
const TICK_MICROSECONDS = 1_000;
const INTEGER_SCORE_BIAS = 1;

const TOP_FIRST: VideoFrameFields = { repeatFirstField: false, scan: 'top-first' };
const BOTTOM_FIRST: VideoFrameFields = { repeatFirstField: false, scan: 'bottom-first' };
const PROGRESSIVE: VideoFrameFields = { repeatFirstField: false, scan: 'progressive' };
const PROGRESSIVE_REPEAT: VideoFrameFields = { repeatFirstField: true, scan: 'progressive' };
const ORDER_UNKNOWN: VideoFrameFields = { repeatFirstField: false, scan: 'interlaced' };

const DEINTERLACE = PRESENTATION_FIELD_STATE.deinterlace;
const BOTTOM_FIELD = PRESENTATION_FIELD_STATE.bottomFieldShown;
const SECOND_FIELD = PRESENTATION_FIELD_STATE.secondField;
const CURRENT_IS_PREVIOUS = PRESENTATION_FIELD_STATE.currentIsPrevious;

function createFrame(index: number, fields: VideoFrameFields | null, durationMicroseconds = PAL_FRAME_DURATION_MICROSECONDS): DeinterlaceTimelineFrame {
    return { durationMicroseconds, fields, timestampMicroseconds: FIRST_TIMESTAMP_MICROSECONDS + index * durationMicroseconds };
}

function requireDraw(draw: DeinterlaceDraw | null): DeinterlaceDraw {
    if (draw === null) {
        throw new Error('no draw');
    }
    return draw;
}

/** One output of a sequence: the frame shown, 0 for a frame passed through or the field shown, and its time. */
type SequenceOutput = Readonly<{ field: 0 | 1 | 2; frameIndex: number; timestamp: number }>;

/**
 * Plays frames through the timeline as the frame loop does: every tick takes the newest due frame a lookahead ahead of the clock,
 * and each distinct draw is an output; draws of one field of one frame at one time collapse into one.
 */
function playThroughTimeline(frames: readonly DeinterlaceTimelineFrame[], rate: YadifRate): SequenceOutput[] {
    const timeline = new DeinterlaceTimeline();
    const outputs: SequenceOutput[] = [];
    let nextFrameIndex = 0;
    let newestPushedIndex = -1;
    const lastFrame = frames[frames.length - 1];
    const endMicroseconds = lastFrame.timestampMicroseconds + lastFrame.durationMicroseconds;
    for (let clock = frames[0].timestampMicroseconds; clock < endMicroseconds; clock += TICK_MICROSECONDS) {
        const dueMicroseconds = clock + timeline.getLookaheadMicroseconds();
        // The session takes the newest due frame; ticks finer than a frame make that the next one
        if (nextFrameIndex < frames.length && frames[nextFrameIndex].timestampMicroseconds <= dueMicroseconds) {
            timeline.push(frames[nextFrameIndex]);
            newestPushedIndex = nextFrameIndex;
            nextFrameIndex += 1;
        }
        const draw = requireDraw(timeline.getDraw(clock, rate));
        const frameIndex = newestPushedIndex - ((draw.fieldState & CURRENT_IS_PREVIOUS) !== 0 ? 1 : 0);
        let field: SequenceOutput['field'] = 0;
        if ((draw.fieldState & DEINTERLACE) !== 0) {
            field = (draw.fieldState & SECOND_FIELD) !== 0 ? 2 : 1;
        }
        const output: SequenceOutput = { field, frameIndex, timestamp: draw.timestampMicroseconds };
        const previous = outputs.at(-1);
        if (!previous || previous.field !== output.field || previous.frameIndex !== output.frameIndex || previous.timestamp !== output.timestamp) {
            outputs.push(output);
        }
    }
    return outputs;
}

/** The reference's outputs for the same frames, which carry no planes: only the frame logic runs. */
function runReferenceSequence(frames: readonly DeinterlaceTimelineFrame[], rate: YadifRate): SequenceOutput[] {
    const referenceFrames: ReferenceFrame[] = frames.map((frame: DeinterlaceTimelineFrame): ReferenceFrame => ({
        interlaced: frame.fields !== null && frame.fields.scan !== 'progressive',
        planes: [],
        repeatFirstField: frame.fields?.repeatFirstField ?? false,
        timestamp: frame.timestampMicroseconds,
        topFieldFirst: frame.fields?.scan !== 'bottom-first'
    }));
    return runYadifReference(referenceFrames, { arithmetic: 'integer', rate, scoreBias: INTEGER_SCORE_BIAS, spatialCheck: true })
        .map(output => ({ field: output.field, frameIndex: output.frameIndex, timestamp: output.timestamp }));
}

describe('DeinterlaceTimeline', () => {
    it('shows a top-first frame\'s top field, then its bottom field halfway to the next frame', () => {
        const timeline = new DeinterlaceTimeline();
        timeline.push(createFrame(0, TOP_FIRST));
        timeline.push(createFrame(1, TOP_FIRST));
        const firstTimestamp = createFrame(0, TOP_FIRST).timestampMicroseconds;
        const secondFieldTimestamp = firstTimestamp + PAL_FRAME_DURATION_MICROSECONDS / 2;

        expect(timeline.getDraw(firstTimestamp, 'double-rate')).toEqual({ fieldState: DEINTERLACE | CURRENT_IS_PREVIOUS, timestampMicroseconds: firstTimestamp });
        expect(timeline.getDraw(secondFieldTimestamp - 1, 'double-rate')?.fieldState).toBe(DEINTERLACE | CURRENT_IS_PREVIOUS);
        expect(timeline.getDraw(secondFieldTimestamp, 'double-rate')).toEqual({
            fieldState: DEINTERLACE | CURRENT_IS_PREVIOUS | BOTTOM_FIELD | SECOND_FIELD,
            timestampMicroseconds: secondFieldTimestamp
        });
    });

    it('shows a bottom-first frame\'s bottom field first, and takes a frame of unknown order as top-first', () => {
        const timeline = new DeinterlaceTimeline();
        timeline.push(createFrame(0, BOTTOM_FIRST));
        timeline.push(createFrame(1, ORDER_UNKNOWN));
        const firstTimestamp = createFrame(0, BOTTOM_FIRST).timestampMicroseconds;
        const secondTimestamp = createFrame(1, ORDER_UNKNOWN).timestampMicroseconds;

        expect(timeline.getDraw(firstTimestamp, 'double-rate')?.fieldState).toBe(DEINTERLACE | CURRENT_IS_PREVIOUS | BOTTOM_FIELD);
        expect(timeline.getDraw(firstTimestamp + PAL_FRAME_DURATION_MICROSECONDS / 2, 'double-rate')?.fieldState)
            .toBe(DEINTERLACE | CURRENT_IS_PREVIOUS | SECOND_FIELD);
        expect(timeline.getDraw(secondTimestamp, 'double-rate')?.fieldState).toBe(DEINTERLACE);
    });

    it('times a second field in whole microseconds, rounded down, and never shows one at single rate', () => {
        const timeline = new DeinterlaceTimeline();
        timeline.push(createFrame(0, TOP_FIRST, NTSC_FRAME_DURATION_MICROSECONDS));
        timeline.push(createFrame(1, TOP_FIRST, NTSC_FRAME_DURATION_MICROSECONDS));
        const firstTimestamp = FIRST_TIMESTAMP_MICROSECONDS;
        const secondFieldTimestamp = firstTimestamp + NTSC_SECOND_FIELD_OFFSET_MICROSECONDS;

        expect(timeline.getDraw(secondFieldTimestamp, 'double-rate')?.timestampMicroseconds).toBe(secondFieldTimestamp);
        expect(timeline.getDraw(secondFieldTimestamp - 1, 'double-rate')?.timestampMicroseconds).toBe(firstTimestamp);
        expect(Number.isSafeInteger(timeline.getDraw(secondFieldTimestamp, 'double-rate')?.timestampMicroseconds)).toBe(true);
        expect(timeline.getDraw(secondFieldTimestamp, 'single-rate')).toEqual({ fieldState: DEINTERLACE | CURRENT_IS_PREVIOUS, timestampMicroseconds: firstTimestamp });
    });

    it('passes progressive frames and frames without fields through, once', () => {
        const timeline = new DeinterlaceTimeline();
        timeline.push(createFrame(0, PROGRESSIVE));
        timeline.push(createFrame(1, null));
        const firstTimestamp = FIRST_TIMESTAMP_MICROSECONDS;

        expect(timeline.getDraw(firstTimestamp + PAL_FRAME_DURATION_MICROSECONDS / 2, 'double-rate'))
            .toEqual({ fieldState: CURRENT_IS_PREVIOUS, timestampMicroseconds: firstTimestamp });
        expect(timeline.getDraw(firstTimestamp + PAL_FRAME_DURATION_MICROSECONDS, 'double-rate')?.fieldState).toBe(PRESENTATION_FIELD_STATE.none);
    });

    it('passes an interlaced frame through beside a progressive frame that repeats a field, as soft telecine marks it', () => {
        const timeline = new DeinterlaceTimeline();
        timeline.push(createFrame(0, PROGRESSIVE_REPEAT));
        timeline.push(createFrame(1, TOP_FIRST));
        timeline.push(createFrame(2, PROGRESSIVE));
        const secondTimestamp = createFrame(1, TOP_FIRST).timestampMicroseconds;

        expect(timeline.getDraw(secondTimestamp, 'double-rate')?.fieldState).toBe(CURRENT_IS_PREVIOUS);
    });

    it('takes frames one frame ahead once it holds one, and waits for the next frame of an interlaced first frame', () => {
        const timeline = new DeinterlaceTimeline();
        expect(timeline.getLookaheadMicroseconds()).toBe(0);
        expect(timeline.getDraw(FIRST_TIMESTAMP_MICROSECONDS, 'double-rate')).toBeNull();

        timeline.push(createFrame(0, TOP_FIRST, NTSC_FRAME_DURATION_MICROSECONDS));
        expect(timeline.getLookaheadMicroseconds()).toBe(NTSC_FRAME_DURATION_MICROSECONDS);
        expect(timeline.awaitsNextFrame()).toBe(true);
        timeline.push(createFrame(1, TOP_FIRST, NTSC_FRAME_DURATION_MICROSECONDS));
        expect(timeline.awaitsNextFrame()).toBe(false);

        timeline.reset();
        expect(timeline.getFrameCount()).toBe(0);
        timeline.push(createFrame(0, PROGRESSIVE));
        expect(timeline.awaitsNextFrame()).toBe(false);
    });

    it('shows the newest frame once the clock reaches it without a frame after it, its second field through its own duration', () => {
        const timeline = new DeinterlaceTimeline();
        timeline.push(createFrame(0, TOP_FIRST));
        timeline.push(createFrame(1, BOTTOM_FIRST));
        const lastTimestamp = createFrame(1, BOTTOM_FIRST).timestampMicroseconds;

        expect(timeline.getDraw(lastTimestamp, 'double-rate')).toEqual({ fieldState: DEINTERLACE | BOTTOM_FIELD, timestampMicroseconds: lastTimestamp });
        expect(timeline.getDraw(lastTimestamp + PAL_FRAME_DURATION_MICROSECONDS / 2, 'double-rate')).toEqual({
            fieldState: DEINTERLACE | SECOND_FIELD,
            timestampMicroseconds: lastTimestamp + PAL_FRAME_DURATION_MICROSECONDS / 2
        });
    });

    it('holds three frames, the earliest leaving first', () => {
        const timeline = new DeinterlaceTimeline();
        for (let frameIndex = 0; frameIndex < 5; frameIndex += 1) {
            timeline.push(createFrame(frameIndex, TOP_FIRST));
        }
        expect(timeline.getFrameCount()).toBe(3);
    });

    for (const rate of [ 'double-rate', 'single-rate' ] as const) {
        it(`presents a mixed sequence's frames and fields, at their times, as FFmpeg's yadif outputs them (${rate})`, () => {
            const fields: readonly (VideoFrameFields | null)[] = [
                TOP_FIRST, TOP_FIRST, BOTTOM_FIRST, PROGRESSIVE, TOP_FIRST, PROGRESSIVE_REPEAT, TOP_FIRST, TOP_FIRST, null, ORDER_UNKNOWN, PROGRESSIVE, TOP_FIRST
            ];
            const frames = fields.map((frameFields: VideoFrameFields | null, index: number): DeinterlaceTimelineFrame => (
                createFrame(index, frameFields, NTSC_FRAME_DURATION_MICROSECONDS)
            ));

            expect(playThroughTimeline(frames, rate)).toEqual(runReferenceSequence(frames, rate));
        });
    }
});
