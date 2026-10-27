// Estimates the media time between a stream's frames, frame by frame, from the new frames the presenter draws: the slope of a least-squares
// line through the window's timestamps over their frame counts, counted from the window's first frame.
// The line evens out timestamps a container rounds to the millisecond, as Matroska's 41 and 42 ms frames of 24 fps video, to inside 0.1% within
// a third of a second and 0.02% within a second, where a mean of 16 frames' own durations strayed 0.2% on such a stream.
// It counts the frames the frame loop skipped between two it drew by the last frame's own duration, else by the line, so a stream that halves
// its frame rate is not taken for a loop that skips every other frame.

// The frames the line spans at most: a second of 24 fps video
const WINDOW_FRAME_COUNT = 24;
// How far a frame may land from the line's prediction, in frames, before the window starts over, as after a change of frame rate
const MAXIMUM_RESIDUAL_FRAMES = 0.4;

/** A least-squares line through a window's frames: timestamp = meanTimestamp + slope * (count - meanCount). */
type FrameLine = Readonly<{
    meanCount: number
    meanTimestamp: number
    slope: number
}>;

export default class FrameInterval {
    // The window's frames: each one's count from the window's first frame, and its timestamp in microseconds
    private readonly counts: number[] = [];
    private readonly timestamps: number[] = [];
    private intervalMicroseconds = 0;
    // The last frame's own duration, or 0 when it has none
    private lastDurationMicroseconds = 0;
    private line: FrameLine | null = null;

    /**
     * Records a new frame by its timestamp and its own duration, both in microseconds.
     * The duration counts the frames up to the next one, and times the window's first frame until a frame after it puts the line through both; a
     * frame whose timestamp does not follow the last frame's starts the window over.
     */
    record(timestampMicroseconds: number, durationMicroseconds: number | null): void {
        const lastIndex = this.timestamps.length - 1;
        const elapsedMicroseconds = lastIndex < 0 ? 0 : timestampMicroseconds - this.timestamps[lastIndex];
        const stepMicroseconds = this.lastDurationMicroseconds > 0 ? this.lastDurationMicroseconds : this.intervalMicroseconds;
        this.lastDurationMicroseconds = durationMicroseconds !== null && durationMicroseconds > 0 ? durationMicroseconds : 0;
        if (!Number.isFinite(elapsedMicroseconds) || elapsedMicroseconds <= 0) {
            this.startWindow(timestampMicroseconds, this.lastDurationMicroseconds);
            return;
        }
        // The frames since the last one: a frame the loop skipped makes two
        const frames = stepMicroseconds > 0 ? Math.max(Math.round(elapsedMicroseconds / stepMicroseconds), 1) : 1;
        const count = this.counts[lastIndex] + frames;
        const line = this.line;
        if (line !== null && Math.abs(line.meanTimestamp + (line.slope * (count - line.meanCount)) - timestampMicroseconds) > MAXIMUM_RESIDUAL_FRAMES * line.slope) {
            // Off the line, as after a change of frame rate: the window starts over from the last frame
            this.startWindow(this.timestamps[lastIndex], elapsedMicroseconds);
            this.counts.push(1);
            this.timestamps.push(timestampMicroseconds);
            this.fitLine();
            return;
        }
        this.counts.push(count);
        this.timestamps.push(timestampMicroseconds);
        if (this.counts.length > WINDOW_FRAME_COUNT) {
            this.counts.shift();
            this.timestamps.shift();
        }
        this.fitLine();
    }

    /** Starts over, as after a seek, so the frames before it no longer count. */
    reset(): void {
        this.counts.length = 0;
        this.timestamps.length = 0;
        this.intervalMicroseconds = 0;
        this.lastDurationMicroseconds = 0;
        this.line = null;
    }

    /** Returns the media time between frames in microseconds, or 0 before a frame's time is known. */
    getIntervalMicroseconds(): number {
        return this.intervalMicroseconds;
    }

    /** Starts a window with one frame, timed by the given interval until a frame after it; 0 leaves the interval unknown. */
    private startWindow(timestampMicroseconds: number, intervalMicroseconds: number): void {
        this.counts.length = 0;
        this.timestamps.length = 0;
        this.counts.push(0);
        this.timestamps.push(timestampMicroseconds);
        this.intervalMicroseconds = intervalMicroseconds;
        this.line = null;
    }

    /** Fits the window's line, whose slope becomes the interval. */
    private fitLine(): void {
        const frameCount = this.counts.length;
        const meanCount = this.counts.reduce((sum: number, count: number): number => sum + count, 0) / frameCount;
        const meanTimestamp = this.timestamps.reduce((sum: number, timestamp: number): number => sum + timestamp, 0) / frameCount;
        let covariance = 0;
        let variance = 0;
        for (let index = 0; index < frameCount; index += 1) {
            const countOffset = this.counts[index] - meanCount;
            covariance += countOffset * (this.timestamps[index] - meanTimestamp);
            variance += countOffset * countOffset;
        }
        const slope = covariance / variance;
        this.line = { meanCount, meanTimestamp, slope };
        this.intervalMicroseconds = slope;
    }
}
