// Decides the black bars presentation crops, from the statistics the black bar analysis pass writes for each row and column of the frames it presents.
// Bars are symmetric on each axis, cropped at once where a frame looks like a letterbox or a pillarbox, else only once frames of different shots
// agree on them, and given up at once for any picture that reaches into them. The Black bars section of docs/src/architecture.md describes the rules.
import {
    BLACK_BAR_SAMPLES_PER_LINE,
    BLACK_BAR_WHITE_LEVEL,
    getBlackBarBrightSampleCount,
    getBlackBarLevelSum,
    getBlackBarLitSampleCount
} from './passes/builtin/BlackBarAnalysisPass';

/** Black bars a presentation crops, in the presented frame's visible samples: rows cut from the top and the bottom, columns from the left and the right. */
export type BlackBarCrop = Readonly<{ bottom: number; left: number; right: number; top: number }>;

/** One analyzed frame: the words the analysis pass wrote for each of its rows and each of its columns, and the frame's timestamp. */
export type BlackBarFrameStatistics = Readonly<{
    columns: Uint32Array
    rows: Uint32Array
    timestampMicroseconds: number
}>;

/** No bars: the whole frame presents. */
export const NO_BLACK_BAR_CROP: BlackBarCrop = Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 });

// A line holds picture when its mean luma passes this, about 0.1 nits in SDR and in PQ, as FFmpeg's cropdetect reads a line: the ringing a coder
// leaves in bars beside a bright edge swings around black and averages out below it, under 0.03 past the line beside the edge in the H.264, HEVC,
// and AV1 encodes measured
const PICTURE_MEAN_LUMA = 0.06;
const PICTURE_LEVEL_SUM = PICTURE_MEAN_LUMA * BLACK_BAR_WHITE_LEVEL * BLACK_BAR_SAMPLES_PER_LINE;
// A line also holds picture where at least this many of its samples are bright, as a subtitle in a bar or a small bright object makes them; one alone
// is noise
const PICTURE_BRIGHT_SAMPLE_COUNT = 2;
// A route that upsamples chroma across the picture's edge and clamps R, G, and B lights the line beside the edge with chroma alone, which can pass the
// picture mean: that line holds no bright sample and less than this share of the edge line's level, as the picture's own outermost line does not
const BLEED_LEVEL_FRACTION = 0.5;
// An edge is sharp when a line at it is lit across at least this share of the picture's known extent, as a picture's own edge is and a dark
// scene's fade into black is not
const SHARP_EDGE_FILL = 0.5;
// The lines from an edge within which its sharp line must lie, so a soft edge of a line or two still counts: 3 at 1080 lines, more at higher resolutions
const EDGE_WINDOW_LINES_PER_LINE = 1 / 360;
const MINIMUM_EDGE_WINDOW_LINES = 3;
// Bars that would leave less of the frame than this are no bars, but darkness around a bright object
const MINIMUM_PICTURE_FRACTION = 0.3;
// Bars within this share of the frame's lines of each other, at least 2 lines, are the same bars: a picture's edge line varies between frames as it codes
const BAR_TOLERANCE_PER_LINE = 0.004;
const MINIMUM_BAR_TOLERANCE_LINES = 2;
// Once an axis cropped, it crops more only for bars no picture reached into for this much playback, so a film that changes its aspect ratio between
// shots, such as one with IMAX scenes, shows each scene whole rather than zooming at every change
const RECROP_HOLD_MICROSECONDS = 30_000_000;
// Two frames are different shots when the mean levels of their rows and of their columns moved by more than this on average, of the 255 a level
// reaches: cuts between moving test patterns moved them by 11 to 52, and motion within a shot by 3.3 at most
const SHOT_CHANGE_LEVEL = 8;
// The longest time between two analyzed frames that counts as playback; a longer gap is a seek or a stall
const MAXIMUM_TIME_STEP_MICROSECONDS = 250_000;

/**
 * Bars that confident frames agree on, refuted by any frame with picture inside them: when they were first seen, and the shot of the latest of them,
 * since a confident frame of another shot completes the evidence.
 */
type BarCandidate = {
    bar: number
    shot: number
    sinceMicroseconds: number
};

/** What one axis crops, and the evidence for cropping more. */
type AxisState = {
    /** The bars cropped at each end of the axis, in lines */
    bar: number
    candidate: BarCandidate | null
    /** Whether the axis cropped bars since the detector started over; until it has, a frame that looks like a letterbox or a pillarbox crops at once */
    cropped: boolean
};

/** The first and the last line of a frame that hold picture. */
type PictureExtent = Readonly<{ first: number; last: number }>;

/** What one frame shows of an axis's bars. */
type AxisMeasurement = Readonly<{
    /** The bars at both ends that the frame's picture leaves black: the smaller of its two ends */
    bar: number
    /** Whether the end that sets the bar is a sharp edge, so the bar is the picture's own edge rather than a dark part of it */
    confident: boolean
    endBar: number
    startBar: number
    /** Whether both ends are sharp edges at the same distance from the frame's edges, as a letterbox's or a pillarbox's are */
    symmetric: boolean
}>;

function createAxisState(): AxisState {
    return { bar: 0, candidate: null, cropped: false };
}

function getBarTolerance(lineCount: number): number {
    return Math.max(MINIMUM_BAR_TOLERANCE_LINES, Math.round(lineCount * BAR_TOLERANCE_PER_LINE));
}

/** Returns whether a line holds picture: by its mean luma, or by bright samples where little of it is bright. */
function holdsPicture(word: number): boolean {
    return getBlackBarLevelSum(word) > PICTURE_LEVEL_SUM || getBlackBarBrightSampleCount(word) >= PICTURE_BRIGHT_SAMPLE_COUNT;
}

/** Returns whether the line at an end of a picture's extent is chroma bled beside the edge line next to it, rather than picture. */
function isBleedLine(word: number, edgeWord: number): boolean {
    return getBlackBarBrightSampleCount(word) === 0 && getBlackBarLevelSum(word) < BLEED_LEVEL_FRACTION * getBlackBarLevelSum(edgeWord);
}

/** Returns the first and the last line that hold picture, or null when none does. */
function findPictureExtent(lines: Uint32Array): PictureExtent | null {
    let first = 0;
    while (first < lines.length && !holdsPicture(lines[first])) {
        first += 1;
    }
    if (first === lines.length) {
        return null;
    }
    let last = lines.length - 1;
    while (!holdsPicture(lines[last])) {
        last -= 1;
    }
    // Chroma bleeds one line past each edge
    if (first < last && isBleedLine(lines[first], lines[first + 1])) {
        first += 1;
    }
    if (last > first && isBleedLine(lines[last], lines[last - 1])) {
        last -= 1;
    }
    return { first, last };
}

/** Returns whether a line from start up to end is lit across at least sharpCount samples. */
function hasSharpLine(lines: Uint32Array, start: number, end: number, sharpCount: number): boolean {
    for (let line = start; line < end; line += 1) {
        if (getBlackBarLitSampleCount(lines[line]) >= sharpCount) {
            return true;
        }
    }
    return false;
}

/**
 * Measures an axis's bars in a frame. A line runs across the other axis, whose cropped bars no picture fills, so a sharp edge is lit across half of
 * the samples within the other axis's picture.
 */
function measureAxis(lines: Uint32Array, extent: PictureExtent, crossPictureFraction: number): AxisMeasurement {
    const lineCount = lines.length;
    const startBar = extent.first;
    const endBar = lineCount - 1 - extent.last;
    const bar = Math.min(startBar, endBar);
    const sharpCount = Math.ceil(SHARP_EDGE_FILL * BLACK_BAR_SAMPLES_PER_LINE * crossPictureFraction);
    const window = Math.max(MINIMUM_EDGE_WINDOW_LINES, Math.round(lineCount * EDGE_WINDOW_LINES_PER_LINE));
    const startSharp = hasSharpLine(lines, extent.first, Math.min(extent.first + window, extent.last + 1), sharpCount);
    const endSharp = hasSharpLine(lines, Math.max(extent.last + 1 - window, extent.first), extent.last + 1, sharpCount);
    const plausible = lineCount - 2 * bar >= MINIMUM_PICTURE_FRACTION * lineCount;
    return {
        bar,
        confident: plausible && ((startBar === bar && startSharp) || (endBar === bar && endSharp)),
        endBar,
        startBar,
        symmetric: plausible && startSharp && endSharp && Math.abs(startBar - endBar) <= getBarTolerance(lineCount)
    };
}

/** Returns whether a frame's picture reaches both edges of an axis, within the axis's tolerance, as a letterbox's picture spans the frame's width. */
function spansAxis(measurement: AxisMeasurement, lineCount: number): boolean {
    const tolerance = getBarTolerance(lineCount);
    return measurement.startBar <= tolerance && measurement.endBar <= tolerance;
}

/** Returns how far each line's mean level moved from another frame's line on average, in levels. */
function getMeanLevelChange(lines: Uint32Array, previousLines: Uint32Array): number {
    let difference = 0;
    for (let line = 0; line < lines.length; line += 1) {
        difference += Math.abs(getBlackBarLevelSum(lines[line]) - getBlackBarLevelSum(previousLines[line]));
    }
    return difference / (lines.length * BLACK_BAR_SAMPLES_PER_LINE);
}

/**
 * Decides, frame by frame, the black bars presentation crops.
 * Each axis crops symmetric bars, the smaller of its two ends, so the picture stays centered and a dark region at one end never crops the other.
 * - Bars crop at once where a frame looks like a letterbox or a pillarbox: sharp edges at both ends of one axis, at the same distance from the frame's
 *   edges, and a picture that spans the other axis. That holds on the first bright frame of most letterboxed films.
 * - Otherwise bars crop once confident frames of two different shots agree on them and no frame since showed picture inside them; a frame is confident
 *   when its picture ends in a sharp edge where the bars end, which a dark scene fading into black does not.
 * - Any frame whose picture reaches into the cropped bars crops less at once, so no picture is cut. Once an axis cropped, it crops more only for bars
 *   that agreeing shots support and that no picture reached into for RECROP_HOLD_MICROSECONDS of playback, at the start of a shot.
 * - A frame of another size starts over.
 */
export class BlackBarDetector {
    private columnCount = 0;
    private rowCount = 0;
    private horizontal = createAxisState();
    private vertical = createAxisState();
    private elapsedMicroseconds = 0;
    private lastTimestampMicroseconds: number | null = null;
    // The previous picture's words, whose level sums a new shot moves from; invalid after a black frame, after which any picture starts a shot
    private previousRows = new Uint32Array(0);
    private previousColumns = new Uint32Array(0);
    private previousLinesValid = false;
    private shot = 0;

    /** Starts over: nothing cropped, no evidence, and no frame size. */
    reset(): void {
        this.columnCount = 0;
        this.rowCount = 0;
        this.horizontal = createAxisState();
        this.vertical = createAxisState();
        this.elapsedMicroseconds = 0;
        this.lastTimestampMicroseconds = null;
        this.previousLinesValid = false;
        this.shot = 0;
    }

    /** Returns the bars to crop, in lines of the analyzed frames. */
    getCrop(): BlackBarCrop {
        if (this.vertical.bar === 0 && this.horizontal.bar === 0) {
            return NO_BLACK_BAR_CROP;
        }
        return { bottom: this.vertical.bar, left: this.horizontal.bar, right: this.horizontal.bar, top: this.vertical.bar };
    }

    /** Returns the size of the frames the crop is in: their analyzed rows and columns, 0 before the first frame. */
    getLineCounts(): Readonly<{ columns: number; rows: number }> {
        return { columns: this.columnCount, rows: this.rowCount };
    }

    /** Takes one analyzed frame's statistics; returns whether the crop changed. */
    analyze(statistics: BlackBarFrameStatistics): boolean {
        const { columns, rows } = statistics;
        let changed = false;
        if (rows.length !== this.rowCount || columns.length !== this.columnCount) {
            changed = this.getCrop() !== NO_BLACK_BAR_CROP;
            this.reset();
            this.rowCount = rows.length;
            this.columnCount = columns.length;
            this.previousRows = new Uint32Array(rows.length);
            this.previousColumns = new Uint32Array(columns.length);
        }
        this.advanceTime(statistics.timestampMicroseconds);
        const rowExtent = findPictureExtent(rows);
        const columnExtent = findPictureExtent(columns);
        if (rowExtent === null || columnExtent === null) {
            // A black frame shows no bars, and the picture after it starts a shot
            this.previousLinesValid = false;
            return changed;
        }
        if (this.isNewShot(rows, columns)) {
            this.shot += 1;
        }
        this.previousRows.set(rows);
        this.previousColumns.set(columns);
        this.previousLinesValid = true;
        // A line runs across the other axis, whose cropped bars hold no picture, so its sharp edge is measured within the other axis's picture
        const vertical = measureAxis(rows, rowExtent, (columns.length - 2 * this.horizontal.bar) / columns.length);
        const horizontal = measureAxis(columns, columnExtent, (rows.length - 2 * this.vertical.bar) / rows.length);
        changed = this.updateAxis(this.vertical, vertical, rows.length, spansAxis(horizontal, columns.length)) || changed;
        changed = this.updateAxis(this.horizontal, horizontal, columns.length, spansAxis(vertical, rows.length)) || changed;
        return changed;
    }

    /** Counts the time since the previous analyzed frame as playback, from none for a step back to MAXIMUM_TIME_STEP_MICROSECONDS for a seek ahead. */
    private advanceTime(timestampMicroseconds: number): void {
        const previous = this.lastTimestampMicroseconds;
        if (previous !== null) {
            this.elapsedMicroseconds += Math.min(Math.max(timestampMicroseconds - previous, 0), MAXIMUM_TIME_STEP_MICROSECONDS);
        }
        this.lastTimestampMicroseconds = timestampMicroseconds;
    }

    /** Returns whether a frame starts a shot: the first picture, the first after a black frame, or one whose lines' mean levels moved past SHOT_CHANGE_LEVEL. */
    private isNewShot(rows: Uint32Array, columns: Uint32Array): boolean {
        if (!this.previousLinesValid) {
            return true;
        }
        return (getMeanLevelChange(rows, this.previousRows) + getMeanLevelChange(columns, this.previousColumns)) / 2 > SHOT_CHANGE_LEVEL;
    }

    /** Takes a frame's measurement of one axis; returns whether the axis's bars changed. */
    private updateAxis(axis: AxisState, measurement: AxisMeasurement, lineCount: number, spansOtherAxis: boolean): boolean {
        const tolerance = getBarTolerance(lineCount);
        if (measurement.bar < axis.bar) {
            // Picture inside the cropped bars shows at once
            axis.bar = measurement.bar;
            axis.candidate = null;
            return true;
        }
        if (axis.candidate !== null && measurement.bar + tolerance < axis.candidate.bar) {
            axis.candidate = null;
        }
        if (!measurement.confident || measurement.bar <= axis.bar + tolerance) {
            return false;
        }
        if (!axis.cropped && measurement.symmetric && spansOtherAxis) {
            return this.crop(axis, measurement.bar);
        }
        const candidate = axis.candidate;
        // A candidate's evidence is its own bars; confident larger bars, of a later frame, replace it rather than support it
        if (candidate === null || measurement.bar - candidate.bar > tolerance) {
            axis.candidate = { bar: measurement.bar, shot: this.shot, sinceMicroseconds: this.elapsedMicroseconds };
            return false;
        }
        candidate.bar = Math.min(candidate.bar, measurement.bar);
        // A frame of the candidate's own shot adds nothing; one of another shot completes the evidence, and once the axis cropped, the candidate
        // must also have held for RECROP_HOLD_MICROSECONDS, so the crop lands at the start of a shot
        const held = !axis.cropped || this.elapsedMicroseconds - candidate.sinceMicroseconds >= RECROP_HOLD_MICROSECONDS;
        if (candidate.shot === this.shot || !held) {
            candidate.shot = this.shot;
            return false;
        }
        return this.crop(axis, candidate.bar);
    }

    private crop(axis: AxisState, bar: number): boolean {
        axis.bar = bar;
        axis.candidate = null;
        axis.cropped = true;
        return true;
    }
}
