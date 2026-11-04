import { describe, expect, it } from 'vitest';

import type { BlackBarCrop } from 'webgpu-player/presentation/BlackBarDetector';
import type { SourceRectangle } from 'webgpu-player/presentation/PresentationGeometry';
import { roundBlackBarCrop, type StandardAspectRatioCrop } from 'webgpu-player/presentation/StandardAspectRatios';

const HD_LINES = Object.freeze({ columns: 1_920, rows: 1_080 });
// A 16:9 DVD frame: 720x480 samples displayed 854 wide
const DVD_LINES = Object.freeze({ columns: 720, rows: 480 });
const DVD_DISPLAY_WIDTH = 854;
const PRECISION_DIGITS = 9;

function createLetterbox(bar: number): BlackBarCrop {
    return { bottom: bar, left: 0, right: 0, top: bar };
}

/** Rounds a crop of a 1920x1080 frame of square samples. */
function roundHD(crop: BlackBarCrop): StandardAspectRatioCrop {
    return roundBlackBarCrop(crop, HD_LINES, HD_LINES.columns, HD_LINES.rows);
}

/** Expects a source crop as rows and columns of a frame: the picture's top row, its rows, its left column, and its columns. */
function expectSourceCrop(actual: SourceRectangle, lines: Readonly<{ columns: number; rows: number }>, picture: Readonly<{ columns: number; left: number; rows: number; top: number }>): void {
    expect(actual.height * lines.rows).toBeCloseTo(picture.rows, PRECISION_DIGITS);
    expect(actual.width * lines.columns).toBeCloseTo(picture.columns, PRECISION_DIGITS);
    expect(actual.x * lines.columns).toBeCloseTo(picture.left, PRECISION_DIGITS);
    expect(actual.y * lines.rows).toBeCloseTo(picture.top, PRECISION_DIGITS);
}

describe('roundBlackBarCrop', () => {
    it('presents a picture at a standard ratio as measured, and names the ratio', () => {
        const rounded = roundHD(createLetterbox(140));

        expect(rounded.standard?.name).toBe('Blu-ray Scope');
        expectSourceCrop(rounded.sourceCrop, HD_LINES, { columns: 1_920, left: 0, rows: 800, top: 140 });
    });

    it('cuts a picture up to half a percent taller than a standard ratio down to it, about its center', () => {
        // 802 lines are 2.394:1, a line and a third short of 2.39:1 and 2 lines over 2.40:1
        const rounded = roundHD(createLetterbox(139));

        expect(rounded.standard?.name).toBe('Blu-ray Scope');
        expectSourceCrop(rounded.sourceCrop, HD_LINES, { columns: 1_920, left: 0, rows: 800, top: 140 });
    });

    it('grows a picture by a line at most to reach a standard ratio, and never through an axis the crop leaves whole', () => {
        // 872 lines are 2.20:1 at 872.73 lines
        const grown = roundHD(createLetterbox(104));
        // 816 lines are 2.35:1 at 817.02 lines, or at 1917.6 columns of a picture whose columns no bars crop
        const measured = roundHD(createLetterbox(132));

        expect(grown.standard?.name).toBe('70mm Standard');
        expectSourceCrop(grown.sourceCrop, HD_LINES, { columns: 1_920, left: 0, rows: 1_920 / 2.2, top: (1_080 - (1_920 / 2.2)) / 2 });
        expect(measured.standard).toBeNull();
        expectSourceCrop(measured.sourceCrop, HD_LINES, { columns: 1_920, left: 0, rows: 816, top: 132 });
    });

    it('narrows a pillarbox\'s picture to a standard ratio through its columns', () => {
        const rounded = roundHD({ bottom: 0, left: 239, right: 239, top: 0 });

        expect(rounded.standard?.name).toBe('4:3 Standard TV');
        expectSourceCrop(rounded.sourceCrop, HD_LINES, { columns: 1_440, left: 240, rows: 1_080, top: 0 });
    });

    it('cuts picture rather than showing bar where either axis could round', () => {
        // 1438x1078 is 1.334:1: 4:3 at 1437.33 columns, or at 1078.5 lines
        const rounded = roundHD({ bottom: 1, left: 241, right: 241, top: 1 });

        expect(rounded.standard?.name).toBe('4:3 Standard TV');
        expectSourceCrop(rounded.sourceCrop, HD_LINES, { columns: 1_078 * 4 / 3, left: 960 - (1_078 * 2 / 3), rows: 1_078, top: 1 });
    });

    it('rounds the picture\'s displayed shape, which an anamorphic frame\'s pixel aspect ratio widens', () => {
        // 364 of 480 lines display at 2.346:1, though their samples are 1.98:1
        const rounded = roundBlackBarCrop(createLetterbox(58), DVD_LINES, DVD_DISPLAY_WIDTH, DVD_LINES.rows);

        expect(rounded.standard?.name).toBe('Early Anamorphic Scope');
        expectSourceCrop(rounded.sourceCrop, DVD_LINES, { columns: 720, left: 0, rows: 364 * (854 / 364) / 2.35, top: 240 - (854 / 4.7) });
    });

    it('presents a picture near no standard ratio as measured', () => {
        // The picture with a subtitle in its bottom bar, at 1.95:1
        const rounded = roundHD(createLetterbox(48));

        expect(rounded.standard).toBeNull();
        expectSourceCrop(rounded.sourceCrop, HD_LINES, { columns: 1_920, left: 0, rows: 984, top: 48 });
    });
});
