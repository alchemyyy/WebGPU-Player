// The film and television aspect ratios a black bar crop rounds to, and the rounding, which presents a picture a hair from a standard ratio at exactly
// that ratio. The table is Detect Aspect Ratio's (https://github.com/alchemyyy/jellyfin-plugin-detect-aspect-ratio), each ratio that names a fraction at
// the fraction's value, and Academy at its defined 1.375. The Black bars section of docs/src/architecture.md describes the rounding.
import type { BlackBarCrop } from './BlackBarDetector';
import type { BlackBarLineCounts } from './passes/builtin/BlackBarAnalysisPass';
import type { SourceRectangle } from './PresentationGeometry';

/** A standard aspect ratio: a picture's width over its height, and the ratio's common name. */
export type StandardAspectRatio = Readonly<{ name: string; ratio: number }>;

/** A black bar crop as it presents: the part of the source its picture takes, and the standard ratio the picture was rounded to, null for none. */
export type StandardAspectRatioCrop = Readonly<{ sourceCrop: SourceRectangle; standard: StandardAspectRatio | null }>;

/** The standard aspect ratios, narrowest first. */
export const STANDARD_ASPECT_RATIOS: readonly StandardAspectRatio[] = Object.freeze([
    { name: '1:1 Square', ratio: 1 },
    { name: 'Movietone', ratio: 1.19 },
    { name: '4:3 Standard TV', ratio: 4 / 3 },
    { name: 'Academy Ratio', ratio: 1.375 },
    { name: 'IMAX GT', ratio: 1.43 },
    { name: 'VistaVision (3:2)', ratio: 3 / 2 },
    { name: '14:9 Transition Broadcast', ratio: 14 / 9 },
    { name: 'European Widescreen', ratio: 1.66 },
    { name: '7:4 Widescreen', ratio: 7 / 4 },
    { name: '16:9 HDTV', ratio: 16 / 9 },
    { name: 'US Widescreen (Flat)', ratio: 1.85 },
    { name: 'IMAX Digital', ratio: 1.9 },
    { name: 'Univisium', ratio: 2 },
    { name: '18.5:9 Digital/Smartphone', ratio: 18.5 / 9 },
    { name: '19:9 Smartphone / ARRI Alexa 65', ratio: 19 / 9 },
    { name: '70mm Standard', ratio: 2.2 },
    { name: '20:9 Ultrawide Smartphone', ratio: 20 / 9 },
    { name: '21:9 Ultrawide Monitor', ratio: 21 / 9 },
    { name: 'Early Anamorphic Scope', ratio: 2.35 },
    { name: 'Modern Anamorphic Scope', ratio: 2.39 },
    { name: 'Blu-ray Scope', ratio: 2.4 },
    { name: 'Early CinemaScope', ratio: 2.55 },
    { name: 'Original 1953 CinemaScope', ratio: 2.66 },
    { name: 'Ultra Panavision 70', ratio: 2.76 }
]);

// A crop rounds by cutting at most this share of its picture along the axis whose bars it moves, 2 lines at each end of a 2.40:1 picture in 1080 lines,
const MAXIMUM_ROUNDING_CUT = 0.005;
// or by growing the picture by at most this many lines, half a line at each end: a coded picture rounds its standard ratio to whole lines, such as 872
// of 2.20:1's 872.7 in 1920 columns, and growing further would bring a sliver of bar back
const MAXIMUM_ROUNDING_GROWTH_LINES = 1;

/** Returns whether a picture's size along an axis may round to another: smaller by MAXIMUM_ROUNDING_CUT, or larger by MAXIMUM_ROUNDING_GROWTH_LINES. */
function canRound(size: number, rounded: number): boolean {
    return rounded >= size * (1 - MAXIMUM_ROUNDING_CUT) && rounded <= size + MAXIMUM_ROUNDING_GROWTH_LINES;
}

/**
 * Rounds a black bar crop, in the analyzed frame's lines, to the standard aspect ratio nearest its picture's that moving the bars of an axis it crops
 * reaches, cutting picture rather than showing bar where both axes could; the picture keeps its center. The display size gives the frame's shape,
 * its pixel aspect ratio included. A picture near no standard ratio presents as measured.
 */
export function roundBlackBarCrop(crop: BlackBarCrop, lines: BlackBarLineCounts, displayWidth: number, displayHeight: number): StandardAspectRatioCrop {
    const rows = lines.rows - crop.top - crop.bottom;
    const columns = lines.columns - crop.left - crop.right;
    const ratio = (displayWidth * columns * lines.rows) / (displayHeight * rows * lines.columns);
    let standard: StandardAspectRatio | null = null;
    let distance = Number.POSITIVE_INFINITY;
    let roundedRows = rows;
    let roundedColumns = columns;
    for (const candidate of STANDARD_ASPECT_RATIOS) {
        const candidateDistance = Math.abs(Math.log(candidate.ratio / ratio));
        // The rows the candidate's ratio needs at the picture's columns, and the columns it needs at its rows
        const candidateRows = rows * ratio / candidate.ratio;
        const candidateColumns = columns * candidate.ratio / ratio;
        const byRows = crop.top + crop.bottom > 0 && canRound(rows, candidateRows);
        const byColumns = crop.left + crop.right > 0 && canRound(columns, candidateColumns);
        if (candidateDistance >= distance || !(byRows || byColumns)) {
            continue;
        }
        standard = candidate;
        distance = candidateDistance;
        // A wider ratio cuts rows and a narrower one columns, so of both axes the one that cuts moves
        const cutsRows = byRows && (!byColumns || candidateRows <= rows);
        roundedRows = cutsRows ? candidateRows : rows;
        roundedColumns = cutsRows ? columns : candidateColumns;
    }
    return {
        sourceCrop: {
            height: roundedRows / lines.rows,
            width: roundedColumns / lines.columns,
            x: (crop.left + ((columns - roundedColumns) / 2)) / lines.columns,
            y: (crop.top + ((rows - roundedRows) / 2)) / lines.rows
        },
        standard
    };
}
