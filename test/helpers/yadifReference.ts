// A CPU reference of yadif, the deinterlacer the presentation pass implements, written from the algorithm FFmpeg's vf_yadif filter defines.
// Integer arithmetic floors every halving, as FFmpeg does on integer planes, so its output matches FFmpeg's bit for bit;
// float arithmetic rounds every operation to f32 in the order the WGSL pass runs them, so its output matches the pass.

/** How the reference computes: FFmpeg's integer planes, or the pass's f32 values. */
export type YadifArithmetic = 'float' | 'integer';

/** One plane of a YUV frame, or one channel of an RGB image, in rows. */
export type ReferencePlane = Readonly<{
    height: number
    /** Row-major samples: integers in integer arithmetic, f32 values in float arithmetic */
    samples: Float64Array
    width: number
}>;

/** One field's interpolation: which rows it keeps, which frames form its temporal pair, and yadif's options. */
export type YadifFieldOptions = Readonly<{
    arithmetic: YadifArithmetic
    /** Rows of this parity are interpolated; the other rows are the shown field, copied from the current frame */
    interpolatedParity: 0 | 1
    /** What the vertical spatial score gives away, so a diagonal must beat it by more: 1 on integer planes, as FFmpeg subtracts */
    scoreBias: number
    /** The field is its frame's second in time: its temporal pair is the current and next frames, else the previous and current */
    secondField: boolean
    /** yadif's spatial interlacing check (mode bit 1 clear), which rows 1 and height - 2 always skip */
    spatialCheck: boolean
}>;

/** One input frame of a sequence: its planes and the field facts a decoder reports with it. */
export type ReferenceFrame = Readonly<{
    interlaced: boolean
    planes: readonly ReferencePlane[]
    /** FFmpeg's repeat_pict is nonzero: the frame repeats a field or itself */
    repeatFirstField: boolean
    /** Integer microseconds */
    timestamp: number
    topFieldFirst: boolean
}>;

/** One output frame of a sequence: its planes, its time, and what made it. */
export type ReferenceOutputFrame = Readonly<{
    /** The input frame it shows */
    frameIndex: number
    /** 0 for a frame passed through, 1 or 2 for the field it shows */
    field: 0 | 1 | 2
    planes: readonly ReferencePlane[]
    /** Integer microseconds: the frame's own, and for a second field halfway to the next frame's, rounded down */
    timestamp: number
}>;

/** yadif's output rates: one frame per field (send_field) or one per frame (send_frame). */
export type YadifRate = 'double-rate' | 'single-rate';

export type YadifSequenceOptions = Readonly<{
    arithmetic: YadifArithmetic
    rate: YadifRate
    scoreBias: number
    spatialCheck: boolean
}>;

// The diagonal directions the edge-directed search tries, as offsets of the row above; the row below takes the opposite
const LEFT_DIRECTIONS: readonly number[] = [ -1, -2 ];
const RIGHT_DIRECTIONS: readonly number[] = [ 1, 2 ];
// The edge-directed search reads three columns to each side
const EDGE_DIRECTED_REACH = 3;
// Rows whose spatial check would read past the plane: the second row and the second to last
const SECOND_ROW = 1;
const SECOND_TO_LAST_ROW_FROM_END = 2;

/** The arithmetic of one reference run: f32 rounding and exact halving for floats, floor halving for integers. */
class YadifArithmeticRules {
    private readonly float: boolean;

    constructor(arithmetic: YadifArithmetic) {
        this.float = arithmetic === 'float';
    }

    add(first: number, second: number): number {
        return this.float ? Math.fround(first + second) : first + second;
    }

    subtract(first: number, second: number): number {
        return this.float ? Math.fround(first - second) : first - second;
    }

    /** Halves a value that is never negative: FFmpeg's shift right by one on integers, an exact multiply by one half on floats. */
    half(value: number): number {
        return this.float ? Math.fround(value * 0.5) : Math.floor(value / 2);
    }

    /** The mean of two samples, halved after their sum. */
    mean(first: number, second: number): number {
        return this.half(this.add(first, second));
    }

    absoluteDifference(first: number, second: number): number {
        return Math.abs(this.subtract(first, second));
    }
}

function readSample(plane: ReferencePlane, x: number, y: number): number {
    return plane.samples[y * plane.width + x];
}

function requireMatchingPlanes(previous: ReferencePlane, current: ReferencePlane, next: ReferencePlane): void {
    for (const plane of [ previous, next ]) {
        if (plane.width !== current.width || plane.height !== current.height) {
            throw new RangeError(`plane-size: ${plane.width}x${plane.height}, current ${current.width}x${current.height}`);
        }
    }
}

/**
 * Returns the edge-directed spatial prediction of a sample between the rows above and below: the vertical mean,
 * unless a diagonal through the sample matches better over three samples; a diagonal of two columns is tried only after one of one column won.
 */
function predictSpatially(
    rules: YadifArithmeticRules,
    current: ReferencePlane,
    x: number,
    aboveRow: number,
    belowRow: number,
    scoreBias: number,
    edgeDirected: boolean
): number {
    const above = (column: number): number => readSample(current, column, aboveRow);
    const below = (column: number): number => readSample(current, column, belowRow);
    let prediction = rules.mean(above(x), below(x));
    if (!edgeDirected) {
        return prediction;
    }
    const verticalScore = rules.add(
        rules.add(rules.absoluteDifference(above(x - 1), below(x - 1)), rules.absoluteDifference(above(x), below(x))),
        rules.absoluteDifference(above(x + 1), below(x + 1))
    );
    let bestScore = rules.subtract(verticalScore, scoreBias);
    for (const directions of [ LEFT_DIRECTIONS, RIGHT_DIRECTIONS ]) {
        for (const direction of directions) {
            const score = rules.add(
                rules.add(
                    rules.absoluteDifference(above(x - 1 + direction), below(x - 1 - direction)),
                    rules.absoluteDifference(above(x + direction), below(x - direction))
                ),
                rules.absoluteDifference(above(x + 1 + direction), below(x + 1 - direction))
            );
            // The wider diagonal of a side is tried only once the narrower one won
            if (score >= bestScore) {
                break;
            }
            bestScore = score;
            prediction = rules.mean(above(x + direction), below(x - direction));
        }
    }
    return prediction;
}

/**
 * Interpolates one sample of a missing row with yadif: the edge-directed spatial prediction, clamped around the temporal prediction
 * by how much the neighbourhood moves, so static areas keep the temporal mean and moving areas the spatial one.
 */
function interpolateSample(
    rules: YadifArithmeticRules,
    planes: Readonly<{ current: ReferencePlane; next: ReferencePlane; previous: ReferencePlane }>,
    x: number,
    y: number,
    options: YadifFieldOptions
): number {
    const { current, next, previous } = planes;
    const height = current.height;
    // Rows past an edge mirror inward, as FFmpeg's reference strides do
    const aboveRow = y > 0 ? y - 1 : y + 1;
    const belowRow = y + 1 < height ? y + 1 : y - 1;
    const temporalEarlier = options.secondField ? current : previous;
    const temporalLater = options.secondField ? next : current;

    const aboveSample = readSample(current, x, aboveRow);
    const belowSample = readSample(current, x, belowRow);
    const temporalEarlierSample = readSample(temporalEarlier, x, y);
    const temporalLaterSample = readSample(temporalLater, x, y);
    const temporalPrediction = rules.mean(temporalEarlierSample, temporalLaterSample);
    const temporalDifference = rules.absoluteDifference(temporalEarlierSample, temporalLaterSample);
    const previousDifference = rules.half(rules.add(
        rules.absoluteDifference(readSample(previous, x, aboveRow), aboveSample),
        rules.absoluteDifference(readSample(previous, x, belowRow), belowSample)
    ));
    const nextDifference = rules.half(rules.add(
        rules.absoluteDifference(readSample(next, x, aboveRow), aboveSample),
        rules.absoluteDifference(readSample(next, x, belowRow), belowSample)
    ));
    let allowedDifference = Math.max(Math.max(rules.half(temporalDifference), previousDifference), nextDifference);

    const edgeDirected = x >= EDGE_DIRECTED_REACH && x < current.width - EDGE_DIRECTED_REACH;
    const spatialPrediction = predictSpatially(rules, current, x, aboveRow, belowRow, options.scoreBias, edgeDirected);

    const spatialCheck = options.spatialCheck && y !== SECOND_ROW && y + SECOND_TO_LAST_ROW_FROM_END !== height;
    if (spatialCheck) {
        // Two rows away the temporal pair holds the shown field's parity again
        const twoAboveRow = y + 2 * (aboveRow - y);
        const twoBelowRow = y + 2 * (belowRow - y);
        const twoAbove = rules.mean(readSample(temporalEarlier, x, twoAboveRow), readSample(temporalLater, x, twoAboveRow));
        const twoBelow = rules.mean(readSample(temporalEarlier, x, twoBelowRow), readSample(temporalLater, x, twoBelowRow));
        const towardBelow = rules.subtract(temporalPrediction, belowSample);
        const towardAbove = rules.subtract(temporalPrediction, aboveSample);
        const aboveChange = rules.subtract(twoAbove, aboveSample);
        const belowChange = rules.subtract(twoBelow, belowSample);
        const maximum = Math.max(Math.max(towardBelow, towardAbove), Math.min(aboveChange, belowChange));
        const minimum = Math.min(Math.min(towardBelow, towardAbove), Math.max(aboveChange, belowChange));
        allowedDifference = Math.max(Math.max(allowedDifference, minimum), -maximum);
    }

    const upperBound = rules.add(temporalPrediction, allowedDifference);
    const lowerBound = rules.subtract(temporalPrediction, allowedDifference);
    if (spatialPrediction > upperBound) {
        return upperBound;
    }
    if (spatialPrediction < lowerBound) {
        return lowerBound;
    }
    return spatialPrediction;
}

/** Returns one deinterlaced field of a plane: the shown field's rows copied from the current frame, and the others interpolated. */
export function deinterlaceReferenceField(
    previous: ReferencePlane,
    current: ReferencePlane,
    next: ReferencePlane,
    options: YadifFieldOptions
): ReferencePlane {
    requireMatchingPlanes(previous, current, next);
    const rules = new YadifArithmeticRules(options.arithmetic);
    const samples = new Float64Array(current.width * current.height);
    for (let y = 0; y < current.height; y += 1) {
        const interpolated = (y & 1) === options.interpolatedParity;
        for (let x = 0; x < current.width; x += 1) {
            samples[y * current.width + x] = interpolated ?
                interpolateSample(rules, { current, next, previous }, x, y, options) :
                readSample(current, x, y);
        }
    }
    return { height: current.height, samples, width: current.width };
}

/** Returns whether yadif passes a frame through: a progressive frame, or one beside a progressive frame that repeats a field. */
export function isReferencePassthrough(previous: ReferenceFrame, current: ReferenceFrame, next: ReferenceFrame): boolean {
    return !current.interlaced
        || (!previous.interlaced && previous.repeatFirstField)
        || (!next.interlaced && next.repeatFirstField);
}

/** Returns a frame's first field in time: its own order when it is interlaced, the top field otherwise. */
function isTopFieldFirst(frame: ReferenceFrame): boolean {
    return frame.interlaced ? frame.topFieldFirst : true;
}

function deinterlaceReferenceFrame(
    previous: ReferenceFrame,
    current: ReferenceFrame,
    next: ReferenceFrame,
    field: 1 | 2,
    options: YadifSequenceOptions
): ReferencePlane[] {
    const topFieldFirst = isTopFieldFirst(current);
    // The first field shows the top rows of a top-first frame, so its odd rows are interpolated
    const showsTopField = topFieldFirst === (field === 1);
    const fieldOptions: YadifFieldOptions = {
        arithmetic: options.arithmetic,
        interpolatedParity: showsTopField ? 1 : 0,
        scoreBias: options.scoreBias,
        secondField: field === 2,
        spatialCheck: options.spatialCheck
    };
    return current.planes.map((plane: ReferencePlane, planeIndex: number): ReferencePlane => (
        deinterlaceReferenceField(previous.planes[planeIndex], plane, next.planes[planeIndex], fieldOptions)
    ));
}

/**
 * Runs yadif over a sequence as FFmpeg's filter frames it: the first frame is its own previous frame and the last its own next,
 * a passed-through frame shows once, and at double rate each deinterlaced frame shows its second field halfway to the next frame,
 * or, for the last frame, halfway past its own interval to the previous frame.
 */
export function runYadifReference(frames: readonly ReferenceFrame[], options: YadifSequenceOptions): ReferenceOutputFrame[] {
    const outputs: ReferenceOutputFrame[] = [];
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
        const current = frames[frameIndex];
        const previous = frames[Math.max(frameIndex - 1, 0)];
        const next = frames[Math.min(frameIndex + 1, frames.length - 1)];
        if (isReferencePassthrough(previous, current, next)) {
            outputs.push({ field: 0, frameIndex, planes: current.planes, timestamp: current.timestamp });
            continue;
        }
        outputs.push({ field: 1, frameIndex, planes: deinterlaceReferenceFrame(previous, current, next, 1, options), timestamp: current.timestamp });
        if (options.rate === 'single-rate') {
            continue;
        }
        // FFmpeg's end of stream repeats the last frame one interval later, which that interval takes from the previous frame
        const nextTimestamp = frameIndex + 1 < frames.length ?
            next.timestamp :
            current.timestamp + (current.timestamp - previous.timestamp);
        outputs.push({
            field: 2,
            frameIndex,
            planes: deinterlaceReferenceFrame(previous, current, next, 2, options),
            timestamp: current.timestamp + Math.floor((nextTimestamp - current.timestamp) / 2)
        });
    }
    return outputs;
}
