// @vitest-environment node

import { UrlSource } from 'mediabunny';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MICROSECONDS_PER_SECOND, secondsToMicroseconds, type Microseconds } from 'webgpu-player/MediaTime';
import {
    getURLSourceBufferSizes,
    URL_SOURCE_RELEASE_DELAY_MILLISECONDS,
    URLSourceRetention
} from 'webgpu-player/demux/URLSourceRetention';

const BYTES_PER_MEBIBYTE = 1024 * 1024;
const BYTES_PER_SECOND_PER_MEGABIT = 125_000;
// A two-hour feature, whose read-ahead holds 5 seconds of it and whose cache holds 15
const FEATURE_DURATION_MICROSECONDS = secondsToMicroseconds(7_200);
const READ_AHEAD_MICROSECONDS = secondsToMicroseconds(5);
const CACHE_MICROSECONDS = secondsToMicroseconds(15);
const MINIMUM_READ_AHEAD_BYTES = 8 * BYTES_PER_MEBIBYTE;
const MAXIMUM_READ_AHEAD_BYTES = 64 * BYTES_PER_MEBIBYTE;
const MINIMUM_CACHE_BYTES = 32 * BYTES_PER_MEBIBYTE;
const MAXIMUM_CACHE_BYTES = 192 * BYTES_PER_MEBIBYTE;
// Average bitrates: a low-bitrate encode, a 1080p encode, an Ultra HD Blu-ray remux, and one past every bound
const LOW_BITRATE_MEGABITS = 2;
const HIGH_DEFINITION_MEGABITS = 20;
const ULTRA_HD_MEGABITS = 70;
const PEAK_ULTRA_HD_MEGABITS = 140;
const FIRST_MEDIA_URL = 'https://media.test/Videos/first/stream.mkv';
const SECOND_MEDIA_URL = 'https://media.test/Videos/second/stream.mkv';

/** The bytes a span of media takes at an average bitrate. */
function getSpanBytes(megabits: number, spanMicroseconds: Microseconds): number {
    return (megabits * BYTES_PER_SECOND_PER_MEGABIT * spanMicroseconds) / MICROSECONDS_PER_SECOND;
}

function getFeatureSizeBytes(megabits: number): number {
    return getSpanBytes(megabits, FEATURE_DURATION_MICROSECONDS);
}

function createFirstSource(): UrlSource {
    return new UrlSource(FIRST_MEDIA_URL);
}

function createSecondSource(): UrlSource {
    return new UrlSource(SECOND_MEDIA_URL);
}

/** Whether a source is still in use, which a disposed source no longer can be. */
function isLive(source: UrlSource): boolean {
    try {
        source.ref().free();
        return true;
    } catch {
        return false;
    }
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('getURLSourceBufferSizes', () => {
    it('sizes the read-ahead and the cache by the media\'s average bitrate', () => {
        expect(getURLSourceBufferSizes(getFeatureSizeBytes(HIGH_DEFINITION_MEGABITS), FEATURE_DURATION_MICROSECONDS)).toEqual({
            maximumCacheBytes: getSpanBytes(HIGH_DEFINITION_MEGABITS, CACHE_MICROSECONDS),
            readAheadBytes: getSpanBytes(HIGH_DEFINITION_MEGABITS, READ_AHEAD_MICROSECONDS)
        });
        expect(getURLSourceBufferSizes(getFeatureSizeBytes(ULTRA_HD_MEGABITS), FEATURE_DURATION_MICROSECONDS)).toEqual({
            maximumCacheBytes: getSpanBytes(ULTRA_HD_MEGABITS, CACHE_MICROSECONDS),
            readAheadBytes: getSpanBytes(ULTRA_HD_MEGABITS, READ_AHEAD_MICROSECONDS)
        });
    });

    it('keeps both within their bounds', () => {
        expect(getURLSourceBufferSizes(getFeatureSizeBytes(LOW_BITRATE_MEGABITS), FEATURE_DURATION_MICROSECONDS)).toEqual({
            maximumCacheBytes: MINIMUM_CACHE_BYTES,
            readAheadBytes: MINIMUM_READ_AHEAD_BYTES
        });
        expect(getURLSourceBufferSizes(getFeatureSizeBytes(PEAK_ULTRA_HD_MEGABITS), FEATURE_DURATION_MICROSECONDS)).toEqual({
            maximumCacheBytes: MAXIMUM_CACHE_BYTES,
            readAheadBytes: MAXIMUM_READ_AHEAD_BYTES
        });
    });
});

describe('URLSourceRetention', () => {
    it('hands the retained source to a run over the same media, and releases it for other media', () => {
        const retention = new URLSourceRetention();
        const firstSource = retention.acquire(FIRST_MEDIA_URL, createFirstSource);

        expect(retention.acquire(FIRST_MEDIA_URL, createFirstSource)).toBe(firstSource);

        const secondSource = retention.acquire(SECOND_MEDIA_URL, createSecondSource);

        expect(secondSource).not.toBe(firstSource);
        expect(isLive(firstSource)).toBe(false);
        expect(isLive(secondSource)).toBe(true);
        retention.release();
        expect(isLive(secondSource)).toBe(false);
    });

    it('keeps a stopped run\'s source for a run that acquires it within the delay, and releases it once none does', () => {
        vi.useFakeTimers();
        const retention = new URLSourceRetention();
        const source = retention.acquire(FIRST_MEDIA_URL, createFirstSource);

        retention.releaseLater();
        vi.advanceTimersByTime(URL_SOURCE_RELEASE_DELAY_MILLISECONDS - 1);
        expect(retention.acquire(FIRST_MEDIA_URL, createFirstSource)).toBe(source);
        // The acquisition canceled the release
        vi.advanceTimersByTime(URL_SOURCE_RELEASE_DELAY_MILLISECONDS);
        expect(isLive(source)).toBe(true);

        retention.releaseLater();
        vi.advanceTimersByTime(URL_SOURCE_RELEASE_DELAY_MILLISECONDS);
        expect(isLive(source)).toBe(false);
    });

    it('keeps a source an input still reads until the input lets go of it', () => {
        const retention = new URLSourceRetention();
        const source = retention.acquire(FIRST_MEDIA_URL, createFirstSource);
        // As an input holds its source
        const inputReference = source.ref();

        retention.release();
        expect(isLive(source)).toBe(true);
        inputReference.free();
        expect(isLive(source)).toBe(false);
    });

    it('pins and sizes the source once, after the first preparation over it', async () => {
        const retention = new URLSourceRetention();
        const source = retention.acquire(FIRST_MEDIA_URL, createFirstSource);
        const pinCache = vi.spyOn(source, 'pinCache');
        vi.spyOn(source, 'getSizeOrNull').mockResolvedValue(getFeatureSizeBytes(ULTRA_HD_MEGABITS));
        const setReadAhead = vi.spyOn(source, 'setReadAhead');
        const setMaxCacheSize = vi.spyOn(source, 'setMaxCacheSize');

        await retention.settle(source, FEATURE_DURATION_MICROSECONDS);
        await retention.settle(source, FEATURE_DURATION_MICROSECONDS);

        expect(pinCache).toHaveBeenCalledOnce();
        expect(setReadAhead).toHaveBeenCalledExactlyOnceWith(getSpanBytes(ULTRA_HD_MEGABITS, READ_AHEAD_MICROSECONDS));
        expect(setMaxCacheSize).toHaveBeenCalledExactlyOnceWith(getSpanBytes(ULTRA_HD_MEGABITS, CACHE_MICROSECONDS));
        retention.release();
    });

    it('keeps the sizes without a duration, and settles no source it does not retain', async () => {
        const retention = new URLSourceRetention();
        const source = retention.acquire(FIRST_MEDIA_URL, createFirstSource);
        const otherSource = createSecondSource();
        const pinCache = vi.spyOn(source, 'pinCache');
        const otherPinCache = vi.spyOn(otherSource, 'pinCache');
        vi.spyOn(source, 'getSizeOrNull').mockResolvedValue(getFeatureSizeBytes(ULTRA_HD_MEGABITS));
        const setReadAhead = vi.spyOn(source, 'setReadAhead');

        await retention.settle(otherSource, FEATURE_DURATION_MICROSECONDS);
        await retention.settle(source, null);

        expect(otherPinCache).not.toHaveBeenCalled();
        expect(pinCache).toHaveBeenCalledOnce();
        expect(setReadAhead).not.toHaveBeenCalled();
        retention.release();
    });
});
