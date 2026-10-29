import {
    CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT,
    CUSTOM_FIVE_POINT_ZERO_INPUT_CHANNEL_COUNT,
    CUSTOM_SEVEN_POINT_ONE_INPUT_CHANNEL_COUNT,
    CUSTOM_SIX_POINT_ONE_INPUT_CHANNEL_COUNT,
    CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT,
    CUSTOM_THREE_CHANNEL_INPUT_CHANNEL_COUNT,
    getCustomAudioOutputChannelCount,
    getCustomAudioOutputFloorLayout,
    isCustomAudioOutputLayout,
    type CustomAudioOutputLayout
} from './processing/CustomAudioChannelLayout';

/** The host's speaker layout setting: `auto` follows the destination's channel count, and an explicit layout needs a destination that wide. */
export type CustomAudioSpeakerLayout = 'auto' | CustomAudioOutputLayout;

export const DEFAULT_CUSTOM_AUDIO_SPEAKER_LAYOUT: CustomAudioSpeakerLayout = 'auto';

// The layout `auto` takes for a destination of at least the channel count, widest first
const AUTOMATIC_SPEAKER_LAYOUTS: readonly CustomAudioOutputLayout[] = Object.freeze([ '7.1.4', '7.1.2', '7.1', '5.1', 'stereo' ]);

function getMaximumDestinationChannelCount(audioContext: AudioContext): number {
    try {
        const maximumChannelCount = audioContext.destination.maxChannelCount;
        return Number.isSafeInteger(maximumChannelCount) && maximumChannelCount > 0 ?
            maximumChannelCount :
            CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
    } catch {
        return CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
    }
}

/** Reports whether a value is a speaker layout setting. */
export function isCustomAudioSpeakerLayout(value: unknown): value is CustomAudioSpeakerLayout {
    return value === 'auto' || isCustomAudioOutputLayout(value);
}

/**
 * Resolves the speaker layout setting on a destination with the given channel count.
 * `auto` takes 7.1.4 from 12 channels, 7.1.2 from 10, 7.1 from 8, 5.1 from 6, and stereo below; 5.1.2 and 5.1.4 are explicit choices only.
 * An explicit layout wider than the destination resolves as `auto` does, and an unknown destination is stereo.
 */
export function selectCustomAudioSpeakerLayout(
    speakerLayout: CustomAudioSpeakerLayout,
    maximumChannelCount: number | null
): CustomAudioOutputLayout {
    if (maximumChannelCount === null) {
        return 'stereo';
    }
    if (speakerLayout !== 'auto' && getCustomAudioOutputChannelCount(speakerLayout) <= maximumChannelCount) {
        return speakerLayout;
    }
    return AUTOMATIC_SPEAKER_LAYOUTS.find(
        (layout: CustomAudioOutputLayout): boolean => getCustomAudioOutputChannelCount(layout) <= maximumChannelCount
    ) ?? 'stereo';
}

/**
 * Selects the output layout of a source within the chosen speaker layout.
 * A source a package renders as objects plays to the whole speaker layout.
 * Every other source plays within the speaker layout's floor: three-channel, 5.0, and 5.1 sources take 5.1, and 6.1 and 7.1 sources take 7.1 or fold into 5.1;
 * other sources, and floors too small for theirs, mix to stereo.
 */
export function selectCustomAudioOutputLayout(
    speakerLayout: CustomAudioOutputLayout,
    sourceChannelCount: number | null,
    rendersObjects: boolean
): CustomAudioOutputLayout {
    if (rendersObjects) {
        return speakerLayout;
    }
    const floor = getCustomAudioOutputFloorLayout(speakerLayout);
    switch (sourceChannelCount) {
        case CUSTOM_THREE_CHANNEL_INPUT_CHANNEL_COUNT:
        case CUSTOM_FIVE_POINT_ZERO_INPUT_CHANNEL_COUNT:
        case CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT:
            return floor === 'stereo' ? 'stereo' : '5.1';
        case CUSTOM_SIX_POINT_ONE_INPUT_CHANNEL_COUNT:
        case CUSTOM_SEVEN_POINT_ONE_INPUT_CHANNEL_COUNT:
            return floor;
        default:
            return 'stereo';
    }
}

/** Sets the hardware-facing AudioContext destination channel count and verifies that the browser applied it. */
export function configureCustomAudioDestination(audioContext: AudioContext, outputChannelCount: number): void {
    const maximumChannelCount = getMaximumDestinationChannelCount(audioContext);
    if (outputChannelCount > maximumChannelCount) {
        throw new RangeError(`Audio destination exposes ${maximumChannelCount} channels, not ${outputChannelCount}`);
    }

    audioContext.destination.channelCount = outputChannelCount;
    if (audioContext.destination.channelCount !== outputChannelCount) {
        throw new Error('The browser did not apply the requested audio destination channel count');
    }
}
