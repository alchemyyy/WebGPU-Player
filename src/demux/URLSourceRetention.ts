import type { SourceRef, UrlSource } from 'mediabunny';

import { secondsToMicroseconds, type Microseconds } from '../MediaTime';

/** A URL source's read-ahead and maximum cache size, in bytes. */
export type URLSourceBufferSizes = Readonly<{
    maximumCacheBytes: number
    readAheadBytes: number
}>;

type RetainedURLSource = {
    readonly key: string
    readonly reference: SourceRef<UrlSource>
    // Whether a run completed its preparation over the source, which pinned the container's header and index and sized the buffers
    settled: boolean
};

// How long a stopped run's source waits for the next run over the same media, which a seek starts within milliseconds
export const URL_SOURCE_RELEASE_DELAY_MILLISECONDS = 5_000;

const BYTES_PER_MEBIBYTE = 1024 * 1024;
// The read-ahead holds a few seconds of media, which rides out a network dip, and the cache three times that, so a short seek back stays cached
const READ_AHEAD_MICROSECONDS = secondsToMicroseconds(5);
const CACHE_MICROSECONDS = secondsToMicroseconds(15);
const MINIMUM_READ_AHEAD_BYTES = 8 * BYTES_PER_MEBIBYTE;
const MAXIMUM_READ_AHEAD_BYTES = 64 * BYTES_PER_MEBIBYTE;
const MINIMUM_CACHE_BYTES = 32 * BYTES_PER_MEBIBYTE;
const MAXIMUM_CACHE_BYTES = 192 * BYTES_PER_MEBIBYTE;

/** Returns the bytes a span of media takes at the media's average bitrate, its byte size over its duration, within bounds. */
function getMediaSpanBytes(
    sizeBytes: number,
    durationMicroseconds: Microseconds,
    spanMicroseconds: Microseconds,
    minimumBytes: number,
    maximumBytes: number
): number {
    return Math.min(maximumBytes, Math.max(minimumBytes, Math.round((sizeBytes * spanMicroseconds) / durationMicroseconds)));
}

/** Sizes a URL source's read-ahead and cache by the media's average bitrate. */
export function getURLSourceBufferSizes(sizeBytes: number, durationMicroseconds: Microseconds): URLSourceBufferSizes {
    return {
        maximumCacheBytes: getMediaSpanBytes(sizeBytes, durationMicroseconds, CACHE_MICROSECONDS, MINIMUM_CACHE_BYTES, MAXIMUM_CACHE_BYTES),
        readAheadBytes: getMediaSpanBytes(sizeBytes, durationMicroseconds, READ_AHEAD_MICROSECONDS, MINIMUM_READ_AHEAD_BYTES, MAXIMUM_READ_AHEAD_BYTES)
    };
}

/**
 * Keeps the last run's URL source, with its cache, its file size, and its open responses, for the next run over the same media.
 * A seek starts a new run, which then reads the container's header and index from the cache and reads on near where the last run stopped.
 * Runs overlap, a stopped run unwinding beside the next, so the run that acquired the source last decides its release.
 */
export class URLSourceRetention {
    // The run that acquired the retained source last
    private holder: object | null = null;
    private releaseTimer: ReturnType<typeof setTimeout> | null = null;
    private retained: RetainedURLSource | null = null;

    /** Returns the retained source to a run when it reads the same media, else releases it and retains a new one. */
    public acquire(key: string, createSource: () => UrlSource, holder: object): UrlSource {
        this.cancelRelease();
        if (this.retained?.key !== key) {
            this.release();
            this.retained = { key, reference: createSource().ref(), settled: false };
        }
        this.holder = holder;
        return this.retained.reference.source;
    }

    /**
     * Once a run first completed its preparation over the retained source, pins what the source cached, the container's header and index among it,
     * and sizes its read-ahead and cache by the media's average bitrate; without a duration they keep their sizes.
     */
    public async settle(source: UrlSource, durationMicroseconds: Microseconds | null): Promise<void> {
        const retained = this.retained;
        if (retained?.reference.source !== source || retained.settled) {
            return;
        }
        retained.settled = true;
        source.pinCache();
        const sizeBytes = await source.getSizeOrNull();
        if (sizeBytes === null || durationMicroseconds === null || durationMicroseconds <= 0) {
            return;
        }
        const bufferSizes = getURLSourceBufferSizes(sizeBytes, durationMicroseconds);
        source.setReadAhead(bufferSizes.readAheadBytes);
        source.setMaxCacheSize(bufferSizes.maximumCacheBytes);
    }

    /**
     * Releases the retained source after a run over it ended: at once when the run failed, since the source may hold the failure, else unless a run
     * acquires it within the release delay. A run another run acquired the source after leaves it to that run.
     */
    public releaseAfterRun(holder: object, failed: boolean): void {
        if (holder !== this.holder) {
            return;
        }
        if (failed) {
            this.release();
            return;
        }
        if (!this.retained || this.releaseTimer !== null) {
            return;
        }
        this.releaseTimer = setTimeout((): void => {
            this.releaseTimer = null;
            this.release();
        }, URL_SOURCE_RELEASE_DELAY_MILLISECONDS);
    }

    /** Releases the retained source at once; Mediabunny disposes it once no input reads it. */
    public release(): void {
        this.cancelRelease();
        const retained = this.retained;
        this.retained = null;
        this.holder = null;
        retained?.reference.free();
    }

    private cancelRelease(): void {
        if (this.releaseTimer !== null) {
            clearTimeout(this.releaseTimer);
            this.releaseTimer = null;
        }
    }
}
