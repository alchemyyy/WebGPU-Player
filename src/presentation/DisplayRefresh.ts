// Measures the display's refresh interval from the animation frames the frame loop runs in, whose times a browser takes at its display's refreshes.
// The interval is the slope of a least-squares line through each frame's time over its refresh, counted from the window's first frame,
// which averages out the coarsening browsers give page timers, up to 1 ms, and counts the refreshes a busy page skipped.

// The refreshes a measurement window spans at most: 4 s at 60 Hz
const WINDOW_REFRESH_COUNT = 240;
// The frames a window holds before its line counts as a measurement: half a second at 60 Hz
const MINIMUM_MEASURED_FRAME_COUNT = 30;
// The standard error of a measured interval, relative to the interval; a window measures on until its line is this precise
const MAXIMUM_RELATIVE_INTERVAL_ERROR = 0.0002;
// A gap between frames after which the refreshes between them no longer count reliably, as after a paused loop or a hidden page
const MAXIMUM_GAP_MILLISECONDS = 500;
// The frame-to-frame deltas whose lower quartile is the first estimate, which counts refreshes until the window's own line does;
// a refresh a busy page skips only lengthens a delta
const FIRST_ESTIMATE_DELTA_COUNT = 8;
const FIRST_ESTIMATE_QUANTILE = 0.25;
// How far a frame may land from the line's prediction, in intervals, before measuring starts over, as when the page moved to another display
const MAXIMUM_RESIDUAL_INTERVALS = 0.4;

/** A least-squares line through a window's frames: time = meanTime + slope * (refresh - meanRefresh). */
type RefreshLine = Readonly<{
    meanRefresh: number
    meanTime: number
    slope: number
}>;

/** Returns the lower quartile of the deltas between consecutive times. */
function getFirstIntervalEstimate(times: readonly number[]): number {
    const deltas = times.slice(1).map((time: number, index: number): number => time - times[index]);
    deltas.sort((first: number, second: number): number => first - second);
    return deltas[Math.floor(deltas.length * FIRST_ESTIMATE_QUANTILE)];
}

export default class DisplayRefresh {
    // The window's frames: each one's animation frame time in milliseconds, and its refresh, counted from the window's first frame
    private readonly refreshes: number[] = [];
    private readonly times: number[] = [];
    // The interval the window counts refreshes by, null until the first estimate
    private countingInterval: number | null = null;
    private line: RefreshLine | null = null;
    private measuredInterval: number | null = null;

    /** Records an animation frame's time, a DOMHighResTimeStamp in milliseconds; a time that does not follow the last frame's is ignored. */
    record(timeMilliseconds: number): void {
        const lastTime = this.times.at(-1);
        if (!Number.isFinite(timeMilliseconds) || (lastTime !== undefined && timeMilliseconds <= lastTime)) {
            return;
        }
        if (lastTime !== undefined && timeMilliseconds - lastTime > MAXIMUM_GAP_MILLISECONDS) {
            // The refreshes across a gap cannot be counted, so a new window starts, counting by the interval the last one reached
            this.clearWindow();
        }
        const countingInterval = this.countingInterval;
        if (countingInterval === null) {
            this.times.push(timeMilliseconds);
            if (this.times.length > FIRST_ESTIMATE_DELTA_COUNT) {
                this.countWindow(getFirstIntervalEstimate(this.times));
            }
            return;
        }
        const previousTime = this.times.at(-1);
        const previousRefresh = this.refreshes.at(-1);
        const refresh = previousTime === undefined || previousRefresh === undefined ?
            0 :
            previousRefresh + Math.max(Math.round((timeMilliseconds - previousTime) / countingInterval), 1);
        const line = this.line;
        if (line !== null && Math.abs(timeMilliseconds - line.meanTime - (line.slope * (refresh - line.meanRefresh))) > MAXIMUM_RESIDUAL_INTERVALS * countingInterval) {
            // The frame is off the line, so the display refreshes at another rate now; measuring starts over from this frame
            this.clearWindow();
            this.countingInterval = null;
            this.times.push(timeMilliseconds);
            return;
        }
        this.times.push(timeMilliseconds);
        this.refreshes.push(refresh);
        while (refresh - this.refreshes[0] > WINDOW_REFRESH_COUNT) {
            this.times.shift();
            this.refreshes.shift();
        }
        this.fitLine();
    }

    /** Returns the display's refresh interval in milliseconds: the last measurement precise enough to count, or null before one. */
    getIntervalMilliseconds(): number | null {
        return this.measuredInterval;
    }

    private clearWindow(): void {
        this.times.length = 0;
        this.refreshes.length = 0;
        this.line = null;
    }

    /** Counts the refreshes of the frames the first estimate came from, by that estimate, then fits their line. */
    private countWindow(firstEstimate: number): void {
        this.countingInterval = firstEstimate;
        this.refreshes.length = 0;
        this.refreshes.push(0);
        for (let index = 1; index < this.times.length; index += 1) {
            this.refreshes.push(this.refreshes[index - 1] + Math.max(Math.round((this.times[index] - this.times[index - 1]) / firstEstimate), 1));
        }
        this.fitLine();
    }

    /**
     * Fits the window's line, which predicts the next frame's time; once the window holds enough frames for the line to have a standard error,
     * a precise enough slope becomes the measurement.
     * After the first estimate's frames, the slope counts refreshes, since it is the closer of the two.
     */
    private fitLine(): void {
        const frameCount = this.times.length;
        let refreshSum = 0;
        let timeSum = 0;
        for (let index = 0; index < frameCount; index += 1) {
            refreshSum += this.refreshes[index];
            timeSum += this.times[index];
        }
        const meanRefresh = refreshSum / frameCount;
        const meanTime = timeSum / frameCount;
        let refreshSquares = 0;
        let crossProducts = 0;
        for (let index = 0; index < frameCount; index += 1) {
            const refreshDeviation = this.refreshes[index] - meanRefresh;
            refreshSquares += refreshDeviation * refreshDeviation;
            crossProducts += refreshDeviation * (this.times[index] - meanTime);
        }
        // A window of one frame has no line
        if (refreshSquares === 0) {
            this.line = null;
            return;
        }
        const slope = crossProducts / refreshSquares;
        this.line = { meanRefresh, meanTime, slope };
        if (frameCount > FIRST_ESTIMATE_DELTA_COUNT) {
            this.countingInterval = slope;
        }
        if (frameCount < MINIMUM_MEASURED_FRAME_COUNT) {
            return;
        }
        let residualSquares = 0;
        for (let index = 0; index < frameCount; index += 1) {
            const residual = this.times[index] - meanTime - (slope * (this.refreshes[index] - meanRefresh));
            residualSquares += residual * residual;
        }
        // The slope's standard error, from the residuals' variance over the line's two parameters
        const slopeError = Math.sqrt(residualSquares / (frameCount - 2) / refreshSquares);
        if (slopeError <= slope * MAXIMUM_RELATIVE_INTERVAL_ERROR) {
            this.measuredInterval = slope;
        }
    }
}
