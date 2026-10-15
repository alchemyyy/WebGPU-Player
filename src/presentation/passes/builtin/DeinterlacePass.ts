// The built-in deinterlacing pass: yadif, written from the algorithm FFmpeg's vf_yadif filter defines, over the route's signal in 'source' RGB.
// It reads the signal's last three frames from history and shows one field of one of them, per the presentation uniform's fieldState.
// The test helper yadifReference.ts runs the same f32 operations in the same order on the CPU.
import { PRESENTATION_FIELD_STATE } from '../PassResources';

/** The core function the pass runs: `fn applyBuiltinDeinterlace(position: vec2f) -> vec4f`, at the target pixel's center. */
export const DEINTERLACE_ENTRY_POINT = 'applyBuiltinDeinterlace';

/** The accessor name of the signal the pass reads, whose history accessors are `deinterlaceSignal_history1` and `deinterlaceSignal_history2`. */
export const DEINTERLACE_SIGNAL_INPUT_NAME = 'deinterlaceSignal';

/** The frames the pass reads before the newest: the shown frame and the one before it, while the newest is the frame after it. */
export const DEINTERLACE_HISTORY_DEPTH = 2;

/** The bit depths whose code value sizes the spatial score's bias: a stream's own depth, 8 to 12 bits. */
export const DEINTERLACE_MINIMUM_BIT_DEPTH = 8;
export const DEINTERLACE_MAXIMUM_BIT_DEPTH = 12;

/**
 * Returns what the vertical spatial score gives away in 'source' RGB values, so a diagonal must beat it by more: one code value of the bit depth,
 * 2^-depth, which FFmpeg's integer planes give away as 1.
 */
export function getDeinterlaceScoreBias(bitDepth: number): number {
    if (!Number.isInteger(bitDepth) || bitDepth < DEINTERLACE_MINIMUM_BIT_DEPTH || bitDepth > DEINTERLACE_MAXIMUM_BIT_DEPTH) {
        throw new RangeError(`bit-depth: ${bitDepth} outside [${DEINTERLACE_MINIMUM_BIT_DEPTH}, ${DEINTERLACE_MAXIMUM_BIT_DEPTH}]`);
    }
    return 2 ** -bitDepth;
}

/** Formats a power of two as an exact WGSL hexadecimal f32 literal. */
function formatPowerOfTwoLiteral(value: number): string {
    const exponent = Math.log2(value);
    if (!Number.isInteger(exponent)) {
        throw new RangeError(`score-bias: ${value} is not a power of two`);
    }
    return `0x1p${exponent}f`;
}

/**
 * Returns the pass's WGSL: its field state constants, its frame loads, and its entry point.
 * It reads `presentation` and the three history accessors of DEINTERLACE_SIGNAL_INPUT_NAME, which the planner declares.
 */
export function createDeinterlaceWGSL(bitDepth: number): string {
    const newest = `${DEINTERLACE_SIGNAL_INPUT_NAME}_texture`;
    const previous = `${DEINTERLACE_SIGNAL_INPUT_NAME}_history1_texture`;
    const earliest = `${DEINTERLACE_SIGNAL_INPUT_NAME}_history2_texture`;
    return /* wgsl */ `
const DEINTERLACE_SCORE_BIAS: f32 = ${formatPowerOfTwoLiteral(getDeinterlaceScoreBias(bitDepth))};
const DEINTERLACE_FIELD_STATE_DEINTERLACE: u32 = ${PRESENTATION_FIELD_STATE.deinterlace}u;
const DEINTERLACE_FIELD_STATE_BOTTOM_FIELD_SHOWN: u32 = ${PRESENTATION_FIELD_STATE.bottomFieldShown}u;
const DEINTERLACE_FIELD_STATE_SECOND_FIELD: u32 = ${PRESENTATION_FIELD_STATE.secondField}u;
const DEINTERLACE_FIELD_STATE_CURRENT_IS_PREVIOUS: u32 = ${PRESENTATION_FIELD_STATE.currentIsPrevious}u;
// The frames a sample is read from, by their place in time around the shown one
const DEINTERLACE_PREVIOUS_FRAME: u32 = 0u;
const DEINTERLACE_CURRENT_FRAME: u32 = 1u;
const DEINTERLACE_NEXT_FRAME: u32 = 2u;
// The edge-directed search reads three columns to each side
const DEINTERLACE_EDGE_REACH: i32 = 3;

// Loads a sample of a frame: the shown frame is the newest or the one before it; the next is the newest, which is the shown one itself at the end;
// the previous is the one before the shown one, or the shown one itself while history lacks it
fn loadDeinterlaceFrame(frame: u32, position: vec2i) -> vec4f {
    let currentSlot = select(0u, 1u, (presentation.fieldState & DEINTERLACE_FIELD_STATE_CURRENT_IS_PREVIOUS) != 0u);
    var slot = 0u;
    switch (frame) {
        case DEINTERLACE_PREVIOUS_FRAME: {
            slot = select(currentSlot, currentSlot + 1u, presentation.historyValid > currentSlot);
        }
        case DEINTERLACE_CURRENT_FRAME: {
            slot = currentSlot;
        }
        default: {
            slot = 0u;
        }
    }
    switch (slot) {
        case 0u: {
            return textureLoad(${newest}, position, 0);
        }
        case 1u: {
            return textureLoad(${previous}, position, 0);
        }
        default: {
            return textureLoad(${earliest}, position, 0);
        }
    }
}

fn deinterlaceMean(first: vec4f, second: vec4f) -> vec4f {
    return (first + second) * 0.5;
}

// The three-sample score of a line through the sample, its row above offset by direction columns and its row below by the opposite
fn deinterlaceDirectionScore(aboveRow: i32, belowRow: i32, x: i32, direction: i32) -> vec4f {
    let first = abs(loadDeinterlaceFrame(DEINTERLACE_CURRENT_FRAME, vec2i(x - 1 + direction, aboveRow))
        - loadDeinterlaceFrame(DEINTERLACE_CURRENT_FRAME, vec2i(x - 1 - direction, belowRow)));
    let second = abs(loadDeinterlaceFrame(DEINTERLACE_CURRENT_FRAME, vec2i(x + direction, aboveRow))
        - loadDeinterlaceFrame(DEINTERLACE_CURRENT_FRAME, vec2i(x - direction, belowRow)));
    let third = abs(loadDeinterlaceFrame(DEINTERLACE_CURRENT_FRAME, vec2i(x + 1 + direction, aboveRow))
        - loadDeinterlaceFrame(DEINTERLACE_CURRENT_FRAME, vec2i(x + 1 - direction, belowRow)));
    return (first + second) + third;
}

fn deinterlaceDirectionMean(aboveRow: i32, belowRow: i32, x: i32, direction: i32) -> vec4f {
    return deinterlaceMean(
        loadDeinterlaceFrame(DEINTERLACE_CURRENT_FRAME, vec2i(x + direction, aboveRow)),
        loadDeinterlaceFrame(DEINTERLACE_CURRENT_FRAME, vec2i(x - direction, belowRow))
    );
}

// The edge-directed spatial prediction, per channel: the vertical mean unless a diagonal matches better than it by more than the bias;
// a side's two-column diagonal is tried only where its one-column diagonal won
fn predictDeinterlacedSpatially(aboveRow: i32, belowRow: i32, x: i32, edgeDirected: bool) -> vec4f {
    var prediction = deinterlaceDirectionMean(aboveRow, belowRow, x, 0);
    if (!edgeDirected) {
        return prediction;
    }
    var bestScore = deinterlaceDirectionScore(aboveRow, belowRow, x, 0) - DEINTERLACE_SCORE_BIAS;
    let leftNarrowScore = deinterlaceDirectionScore(aboveRow, belowRow, x, -1);
    let leftNarrowWins = leftNarrowScore < bestScore;
    bestScore = select(bestScore, leftNarrowScore, leftNarrowWins);
    prediction = select(prediction, deinterlaceDirectionMean(aboveRow, belowRow, x, -1), leftNarrowWins);
    let leftWideScore = deinterlaceDirectionScore(aboveRow, belowRow, x, -2);
    let leftWideWins = leftNarrowWins & (leftWideScore < bestScore);
    bestScore = select(bestScore, leftWideScore, leftWideWins);
    prediction = select(prediction, deinterlaceDirectionMean(aboveRow, belowRow, x, -2), leftWideWins);
    let rightNarrowScore = deinterlaceDirectionScore(aboveRow, belowRow, x, 1);
    let rightNarrowWins = rightNarrowScore < bestScore;
    bestScore = select(bestScore, rightNarrowScore, rightNarrowWins);
    prediction = select(prediction, deinterlaceDirectionMean(aboveRow, belowRow, x, 1), rightNarrowWins);
    let rightWideScore = deinterlaceDirectionScore(aboveRow, belowRow, x, 2);
    let rightWideWins = rightNarrowWins & (rightWideScore < bestScore);
    prediction = select(prediction, deinterlaceDirectionMean(aboveRow, belowRow, x, 2), rightWideWins);
    return prediction;
}

// yadif's interpolation of a missing row's sample: the spatial prediction, clamped around the temporal mean by how much the neighbourhood moves
fn interpolateDeinterlacedSample(position: vec2i, size: vec2i) -> vec4f {
    let x = position.x;
    let y = position.y;
    // Rows past an edge mirror inward
    let aboveRow = select(y + 1, y - 1, y > 0);
    let belowRow = select(y - 1, y + 1, y + 1 < size.y);
    let secondField = (presentation.fieldState & DEINTERLACE_FIELD_STATE_SECOND_FIELD) != 0u;
    let temporalEarlierFrame = select(DEINTERLACE_PREVIOUS_FRAME, DEINTERLACE_CURRENT_FRAME, secondField);
    let temporalLaterFrame = select(DEINTERLACE_CURRENT_FRAME, DEINTERLACE_NEXT_FRAME, secondField);

    let above = loadDeinterlaceFrame(DEINTERLACE_CURRENT_FRAME, vec2i(x, aboveRow));
    let below = loadDeinterlaceFrame(DEINTERLACE_CURRENT_FRAME, vec2i(x, belowRow));
    let temporalEarlier = loadDeinterlaceFrame(temporalEarlierFrame, position);
    let temporalLater = loadDeinterlaceFrame(temporalLaterFrame, position);
    let temporalPrediction = deinterlaceMean(temporalEarlier, temporalLater);
    let temporalDifference = abs(temporalEarlier - temporalLater);
    let previousDifference = (abs(loadDeinterlaceFrame(DEINTERLACE_PREVIOUS_FRAME, vec2i(x, aboveRow)) - above)
        + abs(loadDeinterlaceFrame(DEINTERLACE_PREVIOUS_FRAME, vec2i(x, belowRow)) - below)) * 0.5;
    let nextDifference = (abs(loadDeinterlaceFrame(DEINTERLACE_NEXT_FRAME, vec2i(x, aboveRow)) - above)
        + abs(loadDeinterlaceFrame(DEINTERLACE_NEXT_FRAME, vec2i(x, belowRow)) - below)) * 0.5;
    var allowedDifference = max(max(temporalDifference * 0.5, previousDifference), nextDifference);

    let edgeDirected = x >= DEINTERLACE_EDGE_REACH && x < size.x - DEINTERLACE_EDGE_REACH;
    let spatialPrediction = predictDeinterlacedSpatially(aboveRow, belowRow, x, edgeDirected);

    // The second row and the second to last would read past the frame two rows away
    if (y != 1 && y + 2 != size.y) {
        let twoAboveRow = y + 2 * (aboveRow - y);
        let twoBelowRow = y + 2 * (belowRow - y);
        let twoAbove = deinterlaceMean(
            loadDeinterlaceFrame(temporalEarlierFrame, vec2i(x, twoAboveRow)),
            loadDeinterlaceFrame(temporalLaterFrame, vec2i(x, twoAboveRow))
        );
        let twoBelow = deinterlaceMean(
            loadDeinterlaceFrame(temporalEarlierFrame, vec2i(x, twoBelowRow)),
            loadDeinterlaceFrame(temporalLaterFrame, vec2i(x, twoBelowRow))
        );
        let towardBelow = temporalPrediction - below;
        let towardAbove = temporalPrediction - above;
        let aboveChange = twoAbove - above;
        let belowChange = twoBelow - below;
        let maximum = max(max(towardBelow, towardAbove), min(aboveChange, belowChange));
        let minimum = min(min(towardBelow, towardAbove), max(aboveChange, belowChange));
        allowedDifference = max(max(allowedDifference, minimum), -maximum);
    }

    let upperBound = temporalPrediction + allowedDifference;
    let lowerBound = temporalPrediction - allowedDifference;
    return select(select(spatialPrediction, lowerBound, spatialPrediction < lowerBound), upperBound, spatialPrediction > upperBound);
}

fn ${DEINTERLACE_ENTRY_POINT}(fragmentPosition: vec2f) -> vec4f {
    let position = vec2i(floor(fragmentPosition));
    let size = vec2i(textureDimensions(${newest}));
    let fieldState = presentation.fieldState;
    let interpolatedParity = select(1, 0, (fieldState & DEINTERLACE_FIELD_STATE_BOTTOM_FIELD_SHOWN) != 0u);
    if ((fieldState & DEINTERLACE_FIELD_STATE_DEINTERLACE) == 0u || (position.y & 1) != interpolatedParity) {
        return loadDeinterlaceFrame(DEINTERLACE_CURRENT_FRAME, position);
    }
    return interpolateDeinterlacedSample(position, size);
}`;
}
