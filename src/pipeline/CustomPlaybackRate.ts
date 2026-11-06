// The playback rates custom playback takes, and the range within which it plays audio, time-stretched with its pitch kept.

/** Chromium's media element range, so the HTML fallback takes every rate custom playback takes. */
export const MINIMUM_CUSTOM_PLAYBACK_RATE = 0.0625;
export const MAXIMUM_CUSTOM_PLAYBACK_RATE = 16;
/** Gecko's audible range; outside it, playback runs without audio. */
export const MINIMUM_AUDIBLE_CUSTOM_PLAYBACK_RATE = 0.25;
export const MAXIMUM_AUDIBLE_CUSTOM_PLAYBACK_RATE = 4;

/** Reports whether custom playback takes a rate: a finite number from MINIMUM_CUSTOM_PLAYBACK_RATE through MAXIMUM_CUSTOM_PLAYBACK_RATE. */
export function isCustomPlaybackRate(rate: number): boolean {
    return typeof rate === 'number'
        && Number.isFinite(rate)
        && rate >= MINIMUM_CUSTOM_PLAYBACK_RATE
        && rate <= MAXIMUM_CUSTOM_PLAYBACK_RATE;
}

/** Reports whether custom playback plays audio at a rate: one from MINIMUM_AUDIBLE_CUSTOM_PLAYBACK_RATE through MAXIMUM_AUDIBLE_CUSTOM_PLAYBACK_RATE. */
export function isAudibleCustomPlaybackRate(rate: number): boolean {
    return rate >= MINIMUM_AUDIBLE_CUSTOM_PLAYBACK_RATE && rate <= MAXIMUM_AUDIBLE_CUSTOM_PLAYBACK_RATE;
}
