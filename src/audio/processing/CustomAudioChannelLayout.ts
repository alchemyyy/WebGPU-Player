import {
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    type CustomAudioDownmixAlgorithm
} from './CustomAudioDownmixAlgorithm';
import {
    createDefaultAudioDownmixSettings,
    downmixFivePointOneToStereo,
    downmixSixPointOneToStereo,
    downmixSevenPointOneToStereo,
    downmixThreeChannelToStereo,
    type AudioDownmixSettings
} from './CustomAudioDownmix';
import type { AudioDownmixSettingsRamp } from './StreamingAudioDownmixSettings';

export const CUSTOM_MONO_INPUT_CHANNEL_COUNT = 1;
export const CUSTOM_STEREO_INPUT_CHANNEL_COUNT = 2;
export const CUSTOM_THREE_CHANNEL_INPUT_CHANNEL_COUNT = 3;
export const CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT = 6;
export const CUSTOM_SIX_POINT_ONE_INPUT_CHANNEL_COUNT = 7;
export const CUSTOM_SEVEN_POINT_ONE_INPUT_CHANNEL_COUNT = 8;
export const CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT = 2;
export const CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT = 6;
export const CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT = 8;

export type CustomAudioOutputChannelCount =
    | typeof CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT
    | typeof CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT
    | typeof CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT;

type CustomAudioSurroundOutputChannelCount =
    | typeof CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT
    | typeof CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT;

export type CustomAudioChannel =
    | 'front-center'
    | 'front-left'
    | 'front-right'
    | 'back-left'
    | 'back-right'
    | 'back-center'
    | 'low-frequency-effects'
    | 'side-left'
    | 'side-right';

export type CustomAudioChannelLayout = {
    channels: readonly CustomAudioChannel[]
    id: '2.1' | '3.0' | '3.0-back' | '5.1-back' | '5.1-side' | '6.1' | '7.1' | 'mono' | 'stereo'
};

export const CUSTOM_MONO_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([ 'front-center' ] as const),
    id: 'mono'
});

export const CUSTOM_STEREO_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([ 'front-left', 'front-right' ] as const),
    id: 'stereo'
});

export const CUSTOM_TWO_POINT_ONE_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'low-frequency-effects'
    ] as const),
    id: '2.1'
});

export const CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center'
    ] as const),
    id: '3.0'
});

// FFmpeg's 3.0(back), which DTS-HD MA 2/1 decodes to
export const CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'back-center'
    ] as const),
    id: '3.0-back'
});

export const CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'side-left',
        'side-right'
    ] as const),
    id: '5.1-side'
});

export const CUSTOM_FIVE_POINT_ONE_BACK_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'back-left',
        'back-right'
    ] as const),
    id: '5.1-back'
});

export const CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'back-left',
        'back-right',
        'side-left',
        'side-right'
    ] as const),
    id: '7.1'
});

export const CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'back-center',
        'side-left',
        'side-right'
    ] as const),
    id: '6.1'
});

export type StereoChannelData = [ Float32Array, Float32Array ];
export type CustomAudioOutputChannelData = readonly Float32Array[];

type CustomAudioPairedChannel = Exclude<CustomAudioChannel, 'back-center'>;

// Output slots in Web Audio 5.1 order, where sides and backs share the surround pair
const FIVE_POINT_ONE_OUTPUT_CHANNEL_INDEX: Readonly<Record<CustomAudioPairedChannel, number>> =
    Object.freeze({
        'back-left': 4,
        'back-right': 5,
        'front-center': 2,
        'front-left': 0,
        'front-right': 1,
        'low-frequency-effects': 3,
        'side-left': 4,
        'side-right': 5
    });
// Output slots in the WAVE 7.1 order the worklet passes through
const SEVEN_POINT_ONE_OUTPUT_CHANNEL_INDEX: Readonly<Record<CustomAudioPairedChannel, number>> =
    Object.freeze({
        'back-left': 4,
        'back-right': 5,
        'front-center': 2,
        'front-left': 0,
        'front-right': 1,
        'low-frequency-effects': 3,
        'side-left': 6,
        'side-right': 7
    });
const SURROUND_PAIR_CHANNELS: ReadonlySet<CustomAudioChannel> = new Set<CustomAudioChannel>([
    'back-left',
    'back-right',
    'side-left',
    'side-right'
]);
const DIRECT_CHANNEL_GAIN = 1;
// Two channels folded into one speaker, or one channel split across two, keep their power
const FOLDED_CHANNEL_GAIN = Math.SQRT1_2;

type CustomAudioOutputChannelRoute = Readonly<{
    gain: number
    outputChannelIndex: number
}>;

/**
 * Maps a decoded channel count to its layout when the decoder reports no speaker mask.
 * Three channels are 3.0 (FL, FR, FC), the order AAC, FLAC, Opus, and Vorbis decode to.
 * 2.1 and 3.0(back) beds come only from a decoder's speaker mask.
 */
export function getCustomAudioChannelLayout(channelCount: number): CustomAudioChannelLayout | null {
    switch (channelCount) {
        case CUSTOM_MONO_INPUT_CHANNEL_COUNT:
            return CUSTOM_MONO_CHANNEL_LAYOUT;
        case CUSTOM_STEREO_INPUT_CHANNEL_COUNT:
            return CUSTOM_STEREO_CHANNEL_LAYOUT;
        case CUSTOM_THREE_CHANNEL_INPUT_CHANNEL_COUNT:
            return CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT;
        case CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT:
            return CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT;
        case CUSTOM_SIX_POINT_ONE_INPUT_CHANNEL_COUNT:
            return CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT;
        case CUSTOM_SEVEN_POINT_ONE_INPUT_CHANNEL_COUNT:
            return CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT;
        default:
            return null;
    }
}

/**
 * Reports whether converting the layout to the output sums channels, which can exceed full scale, so the output stage must run its peak limiter.
 */
export function requiresCustomAudioFoldDown(
    layout: CustomAudioChannelLayout,
    outputChannelCount: CustomAudioOutputChannelCount
): boolean {
    return layout.channels.length > outputChannelCount;
}

function requireLayoutChannelData(channelData: readonly Float32Array[], layout: CustomAudioChannelLayout): number {
    if (channelData.length !== layout.channels.length) {
        throw new RangeError(`${layout.id} audio requires exactly ${layout.channels.length} input channels`);
    }
    const frameCount = channelData[0]?.length ?? 0;
    if (frameCount <= 0) {
        throw new RangeError('Audio channel data must contain at least one frame');
    }
    for (const channel of channelData) {
        if (channel.length !== frameCount) {
            throw new RangeError('Audio channel data must have equal frame counts');
        }
    }
    return frameCount;
}

/** Mixes a decoded layout to stereo: mono is duplicated, stereo passes through, and every larger bed uses its downmix. */
export function mixCustomAudioToStereo(
    channelData: readonly Float32Array[],
    layout: CustomAudioChannelLayout,
    downmixAlgorithm: CustomAudioDownmixAlgorithm = DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    downmixSettings: AudioDownmixSettings = createDefaultAudioDownmixSettings(),
    downmixSettingsRamp: AudioDownmixSettingsRamp | null = null
): StereoChannelData {
    const frameCount = requireLayoutChannelData(channelData, layout);
    switch (layout.id) {
        case 'mono': {
            const mono = channelData[0];
            const left = new Float32Array(frameCount);
            const right = new Float32Array(frameCount);
            left.set(mono);
            right.set(mono);
            return [ left, right ];
        }
        case 'stereo':
            // NOTE: The caller's buffers pass through uncopied, so callers must treat the result as read-only
            return [ channelData[0], channelData[1] ];
        case '2.1':
            return downmixThreeChannelToStereo(
                channelData,
                'low-frequency-effects',
                downmixAlgorithm,
                downmixSettings,
                downmixSettingsRamp
            );
        case '3.0':
            return downmixThreeChannelToStereo(
                channelData,
                'front-center',
                downmixAlgorithm,
                downmixSettings,
                downmixSettingsRamp
            );
        case '3.0-back':
            return downmixThreeChannelToStereo(
                channelData,
                'back-center',
                downmixAlgorithm,
                downmixSettings,
                downmixSettingsRamp
            );
        case '5.1-back':
        case '5.1-side':
            return downmixFivePointOneToStereo(
                channelData,
                downmixAlgorithm,
                downmixSettings,
                downmixSettingsRamp
            );
        case '6.1':
            return downmixSixPointOneToStereo(
                channelData,
                downmixSettings,
                downmixSettingsRamp
            );
        case '7.1':
            return downmixSevenPointOneToStereo(
                channelData,
                downmixAlgorithm,
                downmixSettings,
                downmixSettingsRamp
            );
    }
}

function isNativeSurroundLayout(
    layout: CustomAudioChannelLayout,
    outputChannelCount: CustomAudioSurroundOutputChannelCount
): boolean {
    switch (outputChannelCount) {
        case CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT:
            return layout.id === '5.1-back' || layout.id === '5.1-side';
        case CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT:
            return layout.id === '7.1';
    }
}

/** Returns the speakers one decoded channel feeds in a 5.1 or 7.1 output. */
function getSurroundOutputChannelRoutes(
    channel: CustomAudioChannel,
    layout: CustomAudioChannelLayout,
    outputChannelCount: CustomAudioSurroundOutputChannelCount
): readonly CustomAudioOutputChannelRoute[] {
    const outputChannelIndices = outputChannelCount === CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT ?
        SEVEN_POINT_ONE_OUTPUT_CHANNEL_INDEX :
        FIVE_POINT_ONE_OUTPUT_CHANNEL_INDEX;
    if (channel === 'back-center') {
        // A 6.1 or 3.0(back) back center splits across the back pair, or the 5.1 surround pair
        return [
            {
                gain: FOLDED_CHANNEL_GAIN,
                outputChannelIndex: outputChannelIndices['back-left']
            },
            {
                gain: FOLDED_CHANNEL_GAIN,
                outputChannelIndex: outputChannelIndices['back-right']
            }
        ];
    }

    // A 7.1 bed folds its side and back pairs into the one 5.1 surround pair
    const foldsSurroundPairs = outputChannelCount === CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT
        && layout.channels.includes('side-left')
        && layout.channels.includes('back-left');
    return [ {
        gain: foldsSurroundPairs && SURROUND_PAIR_CHANNELS.has(channel) ?
            FOLDED_CHANNEL_GAIN :
            DIRECT_CHANNEL_GAIN,
        outputChannelIndex: outputChannelIndices[channel]
    } ];
}

/**
 * Maps each decoded channel by name into a 5.1 or 7.1 output.
 * Missing speakers stay silent; 7.1 sides and backs fold into the 5.1 surrounds, and a back center splits across the back or surround pair, each at sqrt(1/2).
 */
function mapCustomAudioToSurround(
    channelData: readonly Float32Array[],
    layout: CustomAudioChannelLayout,
    outputChannelCount: CustomAudioSurroundOutputChannelCount
): CustomAudioOutputChannelData {
    const frameCount = requireLayoutChannelData(channelData, layout);
    if (isNativeSurroundLayout(layout, outputChannelCount)) {
        return channelData;
    }

    const outputChannelData: Float32Array[] = [];
    for (let outputChannelIndex = 0; outputChannelIndex < outputChannelCount; outputChannelIndex += 1) {
        outputChannelData.push(new Float32Array(frameCount));
    }
    for (let inputChannelIndex = 0; inputChannelIndex < layout.channels.length; inputChannelIndex += 1) {
        const inputChannel = channelData[inputChannelIndex];
        const routes = getSurroundOutputChannelRoutes(layout.channels[inputChannelIndex], layout, outputChannelCount);
        for (const route of routes) {
            const outputChannel = outputChannelData[route.outputChannelIndex];
            for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
                outputChannel[frameIndex] += inputChannel[frameIndex] * route.gain;
            }
        }
    }
    return outputChannelData;
}

/**
 * Converts any decoded layout to the output layout by channel name: an exact 5.1 or 7.1 bed passes through, and stereo output uses the selected downmix.
 */
export function prepareCustomAudioOutputChannelData(
    channelData: readonly Float32Array[],
    layout: CustomAudioChannelLayout,
    outputChannelCount: CustomAudioOutputChannelCount,
    downmixAlgorithm: CustomAudioDownmixAlgorithm = DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    downmixSettings: AudioDownmixSettings = createDefaultAudioDownmixSettings(),
    downmixSettingsRamp: AudioDownmixSettingsRamp | null = null
): CustomAudioOutputChannelData {
    switch (outputChannelCount) {
        case CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT:
            return mixCustomAudioToStereo(
                channelData,
                layout,
                downmixAlgorithm,
                downmixSettings,
                downmixSettingsRamp
            );
        case CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT:
        case CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT:
            return mapCustomAudioToSurround(channelData, layout, outputChannelCount);
    }
}
