import { millisecondsToMicroseconds, type Microseconds } from '../MediaTime';
import { addMicroseconds, requireMicroseconds } from '../TimeMath';

export type MonotonicTimeSource = () => Microseconds;

export type MediaClockSnapshot = {
    generation: number
    mediaTimeMicroseconds: Microseconds
    paused: boolean
    playbackRate: number
};

const INITIAL_GENERATION = 1;
const NO_START_HOLD_MICROSECONDS = requireMicroseconds(0);

function defaultMonotonicTimeSource(): Microseconds {
    return millisecondsToMicroseconds(performance.now());
}

/**
 * Tracks media time against a monotonic clock while invalidating asynchronous work whenever playback state changes.
 */
export default class MediaClock {
    private anchorMediaTimeMicroseconds: Microseconds;
    /** When media time starts advancing from the anchor; a start hold places it after the anchor was taken */
    private anchorMonotonicTimeMicroseconds: Microseconds;
    private anchorTakenMonotonicTimeMicroseconds: Microseconds;
    private currentGeneration = INITIAL_GENERATION;
    private paused = true;
    private playbackRate = 1;
    private readonly monotonicTimeSource: MonotonicTimeSource;

    public constructor(monotonicTimeSource: MonotonicTimeSource = defaultMonotonicTimeSource) {
        this.monotonicTimeSource = monotonicTimeSource;
        this.anchorMediaTimeMicroseconds = requireMicroseconds(0);
        this.anchorMonotonicTimeMicroseconds = this.readMonotonicTime();
        this.anchorTakenMonotonicTimeMicroseconds = this.anchorMonotonicTimeMicroseconds;
    }

    /** Returns the generation that decoder and renderer work should capture. */
    public get generation(): number {
        return this.currentGeneration;
    }

    /** Returns the current signed integer media timestamp. */
    public get mediaTimeMicroseconds(): Microseconds {
        return this.calculateMediaTime(this.readMonotonicTime());
    }

    public get isPaused(): boolean {
        return this.paused;
    }

    public get rate(): number {
        return this.playbackRate;
    }

    /** Captures all clock state from one monotonic-time sample. */
    public snapshot(): MediaClockSnapshot {
        const monotonicTimeMicroseconds = this.readMonotonicTime();
        return {
            generation: this.currentGeneration,
            mediaTimeMicroseconds: this.calculateMediaTime(monotonicTimeMicroseconds),
            paused: this.paused,
            playbackRate: this.playbackRate
        };
    }

    /** Pauses at the current media timestamp and invalidates outstanding work. */
    public pause(): number {
        const monotonicTimeMicroseconds = this.readMonotonicTime();
        this.setAnchor(this.calculateMediaTime(monotonicTimeMicroseconds), monotonicTimeMicroseconds);
        this.paused = true;
        return this.advanceGeneration();
    }

    /**
     * Resumes from the current media timestamp and invalidates outstanding work.
     * A start hold keeps the media timestamp where it is that much longer, as a starting audio output takes that long to be heard.
     */
    public resume(startHoldMicroseconds: Microseconds = NO_START_HOLD_MICROSECONDS): number {
        if (!Number.isSafeInteger(startHoldMicroseconds) || startHoldMicroseconds < 0) {
            throw new RangeError(`Start hold must be a non-negative integer of microseconds: ${startHoldMicroseconds}`);
        }
        const monotonicTimeMicroseconds = this.readMonotonicTime();
        this.setAnchor(this.calculateMediaTime(monotonicTimeMicroseconds), monotonicTimeMicroseconds, startHoldMicroseconds);
        this.paused = false;
        return this.advanceGeneration();
    }

    /** Seeks without changing the paused state. */
    public seek(mediaTimeMicroseconds: Microseconds): number {
        this.setAnchor(requireMicroseconds(mediaTimeMicroseconds), this.readMonotonicTime());
        return this.advanceGeneration();
    }

    /** Re-anchors to an external master clock without invalidating decoder work; it ends a start hold. */
    public synchronize(mediaTimeMicroseconds: Microseconds): void {
        this.setAnchor(requireMicroseconds(mediaTimeMicroseconds), this.readMonotonicTime());
    }

    /** Changes playback rate without introducing a timestamp discontinuity; a start hold keeps its end. */
    public setPlaybackRate(playbackRate: number): number {
        if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
            throw new RangeError('Playback rate must be finite and greater than zero');
        }

        const monotonicTimeMicroseconds = this.readMonotonicTime();
        if (!this.isHolding(monotonicTimeMicroseconds)) {
            this.setAnchor(this.calculateMediaTime(monotonicTimeMicroseconds), monotonicTimeMicroseconds);
        }
        this.playbackRate = playbackRate;
        return this.advanceGeneration();
    }

    /** Invalidates outstanding work without changing clock state. */
    public invalidate(): number {
        const monotonicTimeMicroseconds = this.readMonotonicTime();
        if (!this.isHolding(monotonicTimeMicroseconds)) {
            this.setAnchor(this.calculateMediaTime(monotonicTimeMicroseconds), monotonicTimeMicroseconds);
        }
        return this.advanceGeneration();
    }

    /** Resets to a paused timestamp and restores normal playback rate. */
    public reset(mediaTimeMicroseconds: Microseconds = requireMicroseconds(0)): number {
        this.setAnchor(requireMicroseconds(mediaTimeMicroseconds), this.readMonotonicTime());
        this.paused = true;
        this.playbackRate = 1;
        return this.advanceGeneration();
    }

    private readMonotonicTime(): Microseconds {
        return requireMicroseconds(this.monotonicTimeSource(), 'Monotonic time');
    }

    private setAnchor(
        mediaTimeMicroseconds: Microseconds,
        monotonicTimeMicroseconds: Microseconds,
        startHoldMicroseconds: Microseconds = NO_START_HOLD_MICROSECONDS
    ): void {
        this.anchorMediaTimeMicroseconds = mediaTimeMicroseconds;
        this.anchorTakenMonotonicTimeMicroseconds = monotonicTimeMicroseconds;
        this.anchorMonotonicTimeMicroseconds = addMicroseconds(monotonicTimeMicroseconds, startHoldMicroseconds);
    }

    /** Returns whether a running clock still holds its start. */
    private isHolding(monotonicTimeMicroseconds: Microseconds): boolean {
        return !this.paused && monotonicTimeMicroseconds < this.anchorMonotonicTimeMicroseconds;
    }

    private calculateMediaTime(monotonicTimeMicroseconds: Microseconds): Microseconds {
        if (this.paused) {
            return this.anchorMediaTimeMicroseconds;
        }
        if (monotonicTimeMicroseconds < this.anchorTakenMonotonicTimeMicroseconds) {
            throw new RangeError('Monotonic time moved backwards');
        }

        const elapsedMicroseconds = monotonicTimeMicroseconds - this.anchorMonotonicTimeMicroseconds;
        // A start hold keeps the anchor's media time until it ends
        if (elapsedMicroseconds <= 0) {
            return this.anchorMediaTimeMicroseconds;
        }

        const scaledElapsedMicroseconds = requireMicroseconds(
            Math.round(elapsedMicroseconds * this.playbackRate),
            'Scaled elapsed time'
        );
        return addMicroseconds(this.anchorMediaTimeMicroseconds, scaledElapsedMicroseconds);
    }

    private advanceGeneration(): number {
        if (this.currentGeneration === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Media clock generation exhausted');
        }

        this.currentGeneration += 1;
        return this.currentGeneration;
    }
}
