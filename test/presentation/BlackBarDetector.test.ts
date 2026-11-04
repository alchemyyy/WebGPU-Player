import { describe, expect, it } from 'vitest';

import {
    BlackBarDetector,
    NO_BLACK_BAR_CROP,
    type BlackBarCrop,
    type BlackBarFrameStatistics
} from 'webgpu-player/presentation/BlackBarDetector';
import { BLACK_BAR_SAMPLES_PER_LINE } from 'webgpu-player/presentation/passes/builtin/BlackBarAnalysisPass';

const ROW_COUNT = 1_080;
const COLUMN_COUNT = 1_920;
// A 2.40:1 picture letterboxed in 1920x1080, and a 4:3 one pillarboxed
const LETTERBOX_BAR = 140;
const PILLARBOX_BAR = 240;
const FRAME_MICROSECONDS = 41_708;
// Shots of different brightness, whose rows' mean levels differ by far more than a shot change needs
const FIRST_SHOT_LEVEL = 80;
const SECOND_SHOT_LEVEL = 200;
// Long enough after the picture last reached into the bars that they crop again, and too short
const RECROP_MICROSECONDS = 32_000_000;
const EARLY_RECROP_MICROSECONDS = 20_000_000;
// Letterboxed playback between two IMAX shots, or around a seek
const INTERLUDE_MICROSECONDS = 10_000_000;
// The frames of one shot that playShots plays, a second at 24 fps
const SHOT_FRAME_COUNT = 24;
// A line's word holds its lit sample count, its bright sample count above this bit, and its samples' levels above the next, each stored above
// LEVEL_OFFSET, as BlackBarAnalysisPass packs them; a sample is lit above LIT_LEVEL and bright above BRIGHT_LEVEL
const BRIGHT_COUNT_SHIFT = 7;
const LEVEL_SUM_SHIFT = 14;
const LEVEL_OFFSET = 64;
const LIT_LEVEL = 25.5;
const BRIGHT_LEVEL = 76.5;
// A dark picture's edge: for this many lines from where the picture starts, only a few samples are lit, which leaves the lines holding picture but
// fills too little of them for a sharp edge
const FADING_EDGE_LINES = 120;
const FADING_EDGE_SAMPLES = 8;
// The ringing a coder leaves in bars beside a bright edge: half the samples of each of these lines lit as a dim picture is, and half as far below black
const RINGING_LINES = 12;
const RINGING_LEVEL = 40;
// The chroma a route bleeds onto the line beside an edge and clamps: every sample lit, none bright, the line's mean above the picture mean
const BLEED_LEVEL = 26;

/** The picture of a frame: its rows from top up to bottom, its columns from left up to right, and its level. */
type Picture = Readonly<{
    bottom: number
    left: number
    level: number
    right: number
    top: number
}>;

/** How a line reads where it crosses the picture: a function of its index giving the share of its picture samples that are lit. */
type LineFill = (line: number) => number;

const FULL_FILL: LineFill = (): number => 1;

/** Returns a line's word: count samples at a level, and the rest at another, black unless given, as the analysis pass packs them. */
function packLine(count: number, level: number, otherLevel = 0): number {
    const others = BLACK_BAR_SAMPLES_PER_LINE - count;
    const countAbove = (threshold: number): number => (level > threshold ? count : 0) + (otherLevel > threshold ? others : 0);
    const levelSum = (count * level) + (others * otherLevel) + (LEVEL_OFFSET * BLACK_BAR_SAMPLES_PER_LINE);
    return countAbove(LIT_LEVEL) | (countAbove(BRIGHT_LEVEL) << BRIGHT_COUNT_SHIFT) | (levelSum << LEVEL_SUM_SHIFT);
}

const BLACK_LINE = packLine(0, 0);

/** Returns a picture's rectangle inset by bars at each end of the rows and of the columns. */
function createPicture(rowBar: number, columnBar: number, level: number): Picture {
    return { bottom: ROW_COUNT - rowBar, left: columnBar, level, right: COLUMN_COUNT - columnBar, top: rowBar };
}

/**
 * Returns a frame's statistics as the analysis pass writes them: each row and each column samples the frame evenly, and its samples within the picture
 * are bright as the line's fill says; every other sample is black.
 */
function createFrame(picture: Picture, timestampMicroseconds: number, rowFill: LineFill = FULL_FILL): BlackBarFrameStatistics {
    const rows = new Uint32Array(ROW_COUNT).fill(BLACK_LINE);
    const columns = new Uint32Array(COLUMN_COUNT).fill(BLACK_LINE);
    const pictureColumnSamples = BLACK_BAR_SAMPLES_PER_LINE * (picture.right - picture.left) / COLUMN_COUNT;
    const pictureRowSamples = BLACK_BAR_SAMPLES_PER_LINE * (picture.bottom - picture.top) / ROW_COUNT;
    for (let row = picture.top; row < picture.bottom; row += 1) {
        rows[row] = packLine(Math.round(pictureColumnSamples * rowFill(row)), picture.level);
    }
    for (let column = picture.left; column < picture.right; column += 1) {
        columns[column] = packLine(Math.round(pictureRowSamples), picture.level);
    }
    return { columns, rows, timestampMicroseconds };
}

/** Returns a row fill whose picture fades into black over FADING_EDGE_LINES at its top and at its bottom, as a dark scene's does. */
function createFadingEdgeFill(picture: Picture): LineFill {
    const fadingFill = FADING_EDGE_SAMPLES / BLACK_BAR_SAMPLES_PER_LINE;
    return (row: number): number => (
        row < picture.top + FADING_EDGE_LINES || row >= picture.bottom - FADING_EDGE_LINES ? fadingFill : 1
    );
}

function createBlackFrame(timestampMicroseconds: number): BlackBarFrameStatistics {
    return { columns: new Uint32Array(COLUMN_COUNT).fill(BLACK_LINE), rows: new Uint32Array(ROW_COUNT).fill(BLACK_LINE), timestampMicroseconds };
}

function createCrop(rowBar: number, columnBar: number): BlackBarCrop {
    return { bottom: rowBar, left: columnBar, right: columnBar, top: rowBar };
}

/** Analyzes frames of one picture a frame duration apart from a time; returns whether any changed the crop. */
function analyzeShot(detector: BlackBarDetector, picture: Picture, startMicroseconds: number, frameCount: number, rowFill?: LineFill): boolean {
    let changed = false;
    for (let index = 0; index < frameCount; index += 1) {
        changed = detector.analyze(createFrame(picture, startMicroseconds + (index * FRAME_MICROSECONDS), rowFill)) || changed;
    }
    return changed;
}

/** Plays shots of a picture a second long each, alternating in brightness, a frame duration apart, from a time up to an end; returns the time after the last frame. */
function playShots(detector: BlackBarDetector, rowBar: number, startMicroseconds: number, endMicroseconds: number): number {
    let timestamp = startMicroseconds;
    let frame = 0;
    while (timestamp < endMicroseconds) {
        const level = Math.floor(frame / SHOT_FRAME_COUNT) % 2 === 0 ? FIRST_SHOT_LEVEL : SECOND_SHOT_LEVEL;
        detector.analyze(createFrame(createPicture(rowBar, 0, level), timestamp));
        timestamp += FRAME_MICROSECONDS;
        frame += 1;
    }
    return timestamp;
}

describe('BlackBarDetector', () => {
    it('crops a letterbox on its first frame, and keeps the crop through dark and black frames', () => {
        const detector = new BlackBarDetector();

        expect(detector.analyze(createFrame(createPicture(LETTERBOX_BAR, 0, FIRST_SHOT_LEVEL), 0))).toBe(true);
        expect(detector.getCrop()).toEqual(createCrop(LETTERBOX_BAR, 0));
        expect(detector.getLineCounts()).toEqual({ columns: COLUMN_COUNT, rows: ROW_COUNT });

        // A dark lower half and a black frame leave the bars as they are
        const darkLowerHalf: Picture = { ...createPicture(LETTERBOX_BAR, 0, FIRST_SHOT_LEVEL), bottom: ROW_COUNT / 2 };
        expect(analyzeShot(detector, darkLowerHalf, FRAME_MICROSECONDS, 3)).toBe(false);
        expect(detector.analyze(createBlackFrame(4 * FRAME_MICROSECONDS))).toBe(false);
        expect(detector.getCrop()).toEqual(createCrop(LETTERBOX_BAR, 0));
    });

    it('crops a pillarbox on its first frame', () => {
        const detector = new BlackBarDetector();

        expect(detector.analyze(createFrame(createPicture(0, PILLARBOX_BAR, FIRST_SHOT_LEVEL), 0))).toBe(true);
        expect(detector.getCrop()).toEqual(createCrop(0, PILLARBOX_BAR));
    });

    it('reads ringing beside the picture\'s edges and a smear of an edge down a bar as black, and leaves out chroma bled onto the line beside each edge', () => {
        const detector = new BlackBarDetector();
        const frame = createFrame(createPicture(LETTERBOX_BAR, 0, SECOND_SHOT_LEVEL), 0);
        // Ringing swings as far below black as above it; a smear leaves a few samples of each line above black
        const ringing = packLine(BLACK_BAR_SAMPLES_PER_LINE / 2, RINGING_LEVEL, -RINGING_LEVEL);
        frame.rows.fill(ringing, LETTERBOX_BAR - RINGING_LINES, LETTERBOX_BAR);
        frame.rows.fill(ringing, ROW_COUNT - LETTERBOX_BAR, ROW_COUNT - LETTERBOX_BAR + RINGING_LINES);
        frame.rows.fill(packLine(2, RINGING_LEVEL), ROW_COUNT - LETTERBOX_BAR + RINGING_LINES);
        // Bled chroma lights the whole line beside each edge above the picture mean, though far dimmer than the edge
        frame.rows[LETTERBOX_BAR - 1] = packLine(BLACK_BAR_SAMPLES_PER_LINE, BLEED_LEVEL);
        frame.rows[ROW_COUNT - LETTERBOX_BAR] = packLine(BLACK_BAR_SAMPLES_PER_LINE, BLEED_LEVEL);

        expect(detector.analyze(frame)).toBe(true);
        expect(detector.getCrop()).toEqual(createCrop(LETTERBOX_BAR, 0));
    });

    it('leaves a dark scene whose picture fades into black uncropped, over any number of shots', () => {
        const detector = new BlackBarDetector();
        let timestamp = 0;
        for (const level of [ FIRST_SHOT_LEVEL, SECOND_SHOT_LEVEL, FIRST_SHOT_LEVEL ]) {
            const picture = createPicture(LETTERBOX_BAR, 0, level);
            expect(analyzeShot(detector, picture, timestamp, 24, createFadingEdgeFill(picture))).toBe(false);
            timestamp += 24 * FRAME_MICROSECONDS;
        }

        expect(detector.getCrop()).toBe(NO_BLACK_BAR_CROP);
    });

    it('crops bars that one sharp edge shows once a frame of another shot agrees, unless picture showed inside them in between', () => {
        // The first shot's bottom and the second's top fade into black, so each shows the bars by one sharp edge
        const fadingBottom: LineFill = (row: number): number => (row >= ROW_COUNT - LETTERBOX_BAR - FADING_EDGE_LINES ? FADING_EDGE_SAMPLES / BLACK_BAR_SAMPLES_PER_LINE : 1);
        const fadingTop: LineFill = (row: number): number => (row < LETTERBOX_BAR + FADING_EDGE_LINES ? FADING_EDGE_SAMPLES / BLACK_BAR_SAMPLES_PER_LINE : 1);
        const firstShot = createPicture(LETTERBOX_BAR, 0, FIRST_SHOT_LEVEL);
        const secondShot = createPicture(LETTERBOX_BAR, 0, SECOND_SHOT_LEVEL);
        const detector = new BlackBarDetector();

        expect(analyzeShot(detector, firstShot, 0, 24, fadingBottom)).toBe(false);
        expect(detector.analyze(createFrame(secondShot, 24 * FRAME_MICROSECONDS, fadingTop))).toBe(true);
        expect(detector.getCrop()).toEqual(createCrop(LETTERBOX_BAR, 0));

        // A title over the top bar refutes the first shot's bars, so the second shot alone does not crop them
        const refutedDetector = new BlackBarDetector();
        const title: Picture = { ...firstShot, top: LETTERBOX_BAR / 2 };
        expect(analyzeShot(refutedDetector, firstShot, 0, 12, fadingBottom)).toBe(false);
        expect(analyzeShot(refutedDetector, title, 12 * FRAME_MICROSECONDS, 12, fadingBottom)).toBe(false);
        expect(refutedDetector.analyze(createFrame(secondShot, 24 * FRAME_MICROSECONDS, fadingTop))).toBe(false);
        expect(refutedDetector.getCrop()).toBe(NO_BLACK_BAR_CROP);
    });

    it('shows a picture that grows into the bars at once, and crops them again only after the hold, at the start of a shot', () => {
        const detector = new BlackBarDetector();
        expect(detector.analyze(createFrame(createPicture(LETTERBOX_BAR, 0, FIRST_SHOT_LEVEL), 0))).toBe(true);

        // An IMAX scene fills the frame
        expect(detector.analyze(createFrame(createPicture(0, 0, SECOND_SHOT_LEVEL), FRAME_MICROSECONDS))).toBe(true);
        expect(detector.getCrop()).toBe(NO_BLACK_BAR_CROP);

        // Letterboxed shots crop no bars until they held for the hold, and then at a shot's start
        const afterEarlyShots = playShots(detector, LETTERBOX_BAR, 2 * FRAME_MICROSECONDS, EARLY_RECROP_MICROSECONDS);
        expect(detector.getCrop()).toBe(NO_BLACK_BAR_CROP);
        playShots(detector, LETTERBOX_BAR, afterEarlyShots, RECROP_MICROSECONDS + FRAME_MICROSECONDS);
        expect(detector.getCrop()).toEqual(createCrop(LETTERBOX_BAR, 0));
    });

    it('holds back cropping again while the picture keeps reaching into the bars, and takes a seek ahead as no playback', () => {
        const detector = new BlackBarDetector();
        detector.analyze(createFrame(createPicture(LETTERBOX_BAR, 0, FIRST_SHOT_LEVEL), 0));
        detector.analyze(createFrame(createPicture(0, 0, SECOND_SHOT_LEVEL), FRAME_MICROSECONDS));

        // An IMAX shot after every few letterboxed ones starts the hold over
        let timestamp = 2 * FRAME_MICROSECONDS;
        while (timestamp < 2 * RECROP_MICROSECONDS) {
            timestamp = playShots(detector, LETTERBOX_BAR, timestamp, timestamp + INTERLUDE_MICROSECONDS);
            detector.analyze(createFrame(createPicture(0, 0, SECOND_SHOT_LEVEL), timestamp));
            timestamp += FRAME_MICROSECONDS;
        }
        expect(detector.getCrop()).toBe(NO_BLACK_BAR_CROP);

        // Letterboxed shots on both sides of a seek far ahead hold for less than the hold
        const seekMicroseconds = playShots(detector, LETTERBOX_BAR, timestamp, timestamp + INTERLUDE_MICROSECONDS);
        playShots(detector, LETTERBOX_BAR, seekMicroseconds + RECROP_MICROSECONDS, seekMicroseconds + RECROP_MICROSECONDS + INTERLUDE_MICROSECONDS);
        expect(detector.getCrop()).toBe(NO_BLACK_BAR_CROP);
    });

    it('needs agreeing shots to crop a windowbox, whose picture spans neither axis', () => {
        const detector = new BlackBarDetector();

        expect(analyzeShot(detector, createPicture(LETTERBOX_BAR, PILLARBOX_BAR, FIRST_SHOT_LEVEL), 0, 24)).toBe(false);
        expect(detector.analyze(createFrame(createPicture(LETTERBOX_BAR, PILLARBOX_BAR, SECOND_SHOT_LEVEL), 24 * FRAME_MICROSECONDS))).toBe(true);
        expect(detector.getCrop()).toEqual(createCrop(LETTERBOX_BAR, PILLARBOX_BAR));
    });

    it('takes a cut that moves only the columns\' levels as another shot, as between shots of the same brightness', () => {
        // Each windowboxed shot lights most of every picture row, at its left in the first and at its right in the second, so the rows read the same
        const litSamples = 40;
        const pictureSamples = BLACK_BAR_SAMPLES_PER_LINE * (COLUMN_COUNT - 2 * PILLARBOX_BAR) / COLUMN_COUNT;
        const litColumns = Math.round((COLUMN_COUNT - 2 * PILLARBOX_BAR) * litSamples / pictureSamples);
        const createShotFrame = (firstLitColumn: number, timestampMicroseconds: number): BlackBarFrameStatistics => {
            const frame = createBlackFrame(timestampMicroseconds);
            frame.rows.fill(packLine(litSamples, SECOND_SHOT_LEVEL), LETTERBOX_BAR, ROW_COUNT - LETTERBOX_BAR);
            frame.columns.fill(
                packLine(Math.round(BLACK_BAR_SAMPLES_PER_LINE * (ROW_COUNT - 2 * LETTERBOX_BAR) / ROW_COUNT), SECOND_SHOT_LEVEL),
                firstLitColumn,
                firstLitColumn + litColumns
            );
            return frame;
        };
        const detector = new BlackBarDetector();

        for (let index = 0; index < SHOT_FRAME_COUNT; index += 1) {
            expect(detector.analyze(createShotFrame(PILLARBOX_BAR, index * FRAME_MICROSECONDS))).toBe(false);
        }
        expect(detector.analyze(createShotFrame(COLUMN_COUNT - PILLARBOX_BAR - litColumns, SHOT_FRAME_COUNT * FRAME_MICROSECONDS))).toBe(true);
        expect(detector.getCrop()).toEqual(createCrop(LETTERBOX_BAR, PILLARBOX_BAR));
    });

    it('takes a single bright sample in a bar as noise, and a subtitle\'s few bright samples per line in a bar as picture, which uncrops both ends', () => {
        const detector = new BlackBarDetector();
        const noisyFrame = createFrame(createPicture(LETTERBOX_BAR, 0, FIRST_SHOT_LEVEL), 0);
        noisyFrame.rows[LETTERBOX_BAR / 2] = packLine(1, FIRST_SHOT_LEVEL);

        expect(detector.analyze(noisyFrame)).toBe(true);
        expect(detector.getCrop()).toEqual(createCrop(LETTERBOX_BAR, 0));

        const subtitleTop = ROW_COUNT - LETTERBOX_BAR + 40;
        const subtitleBottom = subtitleTop + 50;
        const subtitledFrame = createFrame(createPicture(LETTERBOX_BAR, 0, FIRST_SHOT_LEVEL), FRAME_MICROSECONDS);
        // Two bright samples leave each line's mean luma near black
        subtitledFrame.rows.fill(packLine(2, SECOND_SHOT_LEVEL), subtitleTop, subtitleBottom);
        expect(detector.analyze(subtitledFrame)).toBe(true);
        expect(detector.getCrop()).toEqual(createCrop(ROW_COUNT - subtitleBottom, 0));
    });

    it('starts over for a frame of another size', () => {
        const detector = new BlackBarDetector();
        detector.analyze(createFrame(createPicture(LETTERBOX_BAR, 0, FIRST_SHOT_LEVEL), 0));

        const smallerFrame: BlackBarFrameStatistics = { columns: new Uint32Array(1_280), rows: new Uint32Array(720), timestampMicroseconds: FRAME_MICROSECONDS };
        expect(detector.analyze(smallerFrame)).toBe(true);
        expect(detector.getCrop()).toBe(NO_BLACK_BAR_CROP);
        expect(detector.getLineCounts()).toEqual({ columns: 1_280, rows: 720 });
    });
});
