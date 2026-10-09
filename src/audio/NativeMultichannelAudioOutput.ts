import {
    CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT,
    CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT,
    CUSTOM_SEVEN_POINT_ONE_INPUT_CHANNEL_COUNT,
    CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT,
    CUSTOM_SIX_POINT_ONE_INPUT_CHANNEL_COUNT,
    CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT,
    CUSTOM_THREE_CHANNEL_INPUT_CHANNEL_COUNT,
    type CustomAudioOutputChannelCount
} from './processing/CustomAudioChannelLayout';

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

/**
 * Selects the output layout for the source from the channel count the current AudioContext destination reports, as selectCustomAudioOutputChannelCountForMaximum does.
 */
export function selectCustomAudioOutputChannelCount(
    audioContext: AudioContext | null,
    sourceChannelCount: number | null
): CustomAudioOutputChannelCount {
    if (!audioContext) {
        return CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
    }
    return selectCustomAudioOutputChannelCountForMaximum(getMaximumDestinationChannelCount(audioContext), sourceChannelCount);
}

/**
 * Selects the speaker output for a source on a sink with the given channel count.
 * Three-channel and 5.1 sources use a 5.1 sink; 6.1 and 7.1 sources use a 7.1 sink or fold into a 5.1 one.
 * Other sources, unknown sinks, and sinks too small for those layouts mix to stereo.
 */
export function selectCustomAudioOutputChannelCountForMaximum(
    maximumChannelCount: number | null,
    sourceChannelCount: number | null
): CustomAudioOutputChannelCount {
    if (maximumChannelCount === null) {
        return CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
    }
    switch (sourceChannelCount) {
        case CUSTOM_THREE_CHANNEL_INPUT_CHANNEL_COUNT:
        case CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT:
            return maximumChannelCount >= CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT ?
                CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT :
                CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
        case CUSTOM_SIX_POINT_ONE_INPUT_CHANNEL_COUNT:
        case CUSTOM_SEVEN_POINT_ONE_INPUT_CHANNEL_COUNT:
            if (maximumChannelCount >= CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT) {
                return CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT;
            }
            return maximumChannelCount >= CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT ?
                CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT :
                CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
        default:
            return CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
    }
}

/** Sets the hardware-facing AudioContext destination channel count and verifies that the browser applied it. */
export function configureCustomAudioDestination(audioContext: AudioContext, outputChannelCount: CustomAudioOutputChannelCount): void {
    const maximumChannelCount = getMaximumDestinationChannelCount(audioContext);
    if (outputChannelCount > maximumChannelCount) {
        throw new RangeError(`Audio destination exposes ${maximumChannelCount} channels, not ${outputChannelCount}`);
    }

    audioContext.destination.channelCount = outputChannelCount;
    if (audioContext.destination.channelCount !== outputChannelCount) {
        throw new Error('The browser did not apply the requested audio destination channel count');
    }
}
