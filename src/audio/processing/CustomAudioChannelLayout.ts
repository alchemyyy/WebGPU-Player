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
export const CUSTOM_FIVE_POINT_ZERO_INPUT_CHANNEL_COUNT = 5;
export const CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT = 6;
export const CUSTOM_SIX_POINT_ONE_INPUT_CHANNEL_COUNT = 7;
export const CUSTOM_SEVEN_POINT_ONE_INPUT_CHANNEL_COUNT = 8;
export const CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT = 2;
export const CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT = 6;
export const CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT = 8;
/** The widest output layout, 7.1.4 */
export const CUSTOM_MAXIMUM_OUTPUT_CHANNEL_COUNT = 12;

export type CustomAudioChannel =
    | 'front-center'
    | 'front-left'
    | 'front-right'
    | 'back-left'
    | 'back-right'
    | 'back-center'
    | 'low-frequency-effects'
    | 'side-left'
    | 'side-right'
    | 'top-front-left'
    | 'top-front-right'
    | 'top-back-left'
    | 'top-back-right';

export type CustomAudioChannelLayout = {
    channels: readonly CustomAudioChannel[]
    id: '2.1' | '3.0' | '3.0-back' | '4.1' | '5.0-back' | '5.0-side' | '5.1-back' | '5.1-side' | '5.1.2' | '5.1.2-side' | '5.1.4' | '6.1' | '7.1' | '7.1.2'
        | '7.1.4' | 'mono' | 'stereo'
};

/**
 * The speaker layouts decoded audio plays to: a destination of the layout's channel count takes its channels in WAVE order, except 5.1, which takes Web Audio's 5.1 order.
 * The height layouts are FFmpeg's 5.1.2, 5.1.4, 7.1.2, and 7.1.4, whose 5.1 floors use the back pair.
 */
export type CustomAudioOutputLayout = '5.1' | '5.1.2' | '5.1.4' | '7.1' | '7.1.2' | '7.1.4' | 'stereo';

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

// FFmpeg's 4.1, FL FR FC LFE and a back center, which DTS-HD Master Audio 3/1 with LFE decodes to
export const CUSTOM_FOUR_POINT_ONE_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'back-center'
    ] as const),
    id: '4.1'
});

// FFmpeg's 5.0(side), the 3/2 bed of AC-3 and DTS without their LFE
export const CUSTOM_FIVE_POINT_ZERO_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'side-left',
        'side-right'
    ] as const),
    id: '5.0-side'
});

export const CUSTOM_FIVE_POINT_ZERO_BACK_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'back-left',
        'back-right'
    ] as const),
    id: '5.0-back'
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

// FFmpeg's 5.1.2(back): 5.1(back) and the top front pair
export const CUSTOM_FIVE_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'back-left',
        'back-right',
        'top-front-left',
        'top-front-right'
    ] as const),
    id: '5.1.2'
});

// 5.1(side) and the top front pair, which FFmpeg's E-AC-3 decoder reports for a dependent stream that adds the heights
export const CUSTOM_FIVE_POINT_ONE_SIDE_POINT_TWO_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'side-left',
        'side-right',
        'top-front-left',
        'top-front-right'
    ] as const),
    id: '5.1.2-side'
});

// FFmpeg's 5.1.4(back): 5.1(back) and the top front and top back pairs
export const CUSTOM_FIVE_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'back-left',
        'back-right',
        'top-front-left',
        'top-front-right',
        'top-back-left',
        'top-back-right'
    ] as const),
    id: '5.1.4'
});

export const CUSTOM_SEVEN_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'back-left',
        'back-right',
        'side-left',
        'side-right',
        'top-front-left',
        'top-front-right'
    ] as const),
    id: '7.1.2'
});

export const CUSTOM_SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'back-left',
        'back-right',
        'side-left',
        'side-right',
        'top-front-left',
        'top-front-right',
        'top-back-left',
        'top-back-right'
    ] as const),
    id: '7.1.4'
});

export type StereoChannelData = [ Float32Array, Float32Array ];
export type CustomAudioOutputChannelData = readonly Float32Array[];

type CustomAudioFloorOutputLayout = Extract<CustomAudioOutputLayout, '5.1' | '7.1' | 'stereo'>;

type CustomAudioOutputLayoutDefinition = Readonly<{
    /** The output's speakers in the order its destination takes them */
    channelLayout: CustomAudioChannelLayout
    /** The layout without its heights, which every source that is not rendered as objects plays within */
    floor: CustomAudioFloorOutputLayout
}>;

// The 5.1 output keeps Web Audio's 5.1 order, whose surround pair takes sides and backs alike
const CUSTOM_FIVE_POINT_ONE_OUTPUT_LAYOUT = CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT;

/* eslint-disable @typescript-eslint/naming-convention -- speaker layouts take FFmpeg's names */
const CUSTOM_AUDIO_OUTPUT_LAYOUT_DEFINITIONS: Readonly<Record<CustomAudioOutputLayout, CustomAudioOutputLayoutDefinition>> = Object.freeze({
    '5.1': Object.freeze({ channelLayout: CUSTOM_FIVE_POINT_ONE_OUTPUT_LAYOUT, floor: '5.1' }),
    '5.1.2': Object.freeze({ channelLayout: CUSTOM_FIVE_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT, floor: '5.1' }),
    '5.1.4': Object.freeze({ channelLayout: CUSTOM_FIVE_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT, floor: '5.1' }),
    '7.1': Object.freeze({ channelLayout: CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT, floor: '7.1' }),
    '7.1.2': Object.freeze({ channelLayout: CUSTOM_SEVEN_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT, floor: '7.1' }),
    '7.1.4': Object.freeze({ channelLayout: CUSTOM_SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT, floor: '7.1' }),
    stereo: Object.freeze({ channelLayout: CUSTOM_STEREO_CHANNEL_LAYOUT, floor: 'stereo' })
});
/* eslint-enable @typescript-eslint/naming-convention */

/** Every output layout, smallest first. */
export const CUSTOM_AUDIO_OUTPUT_LAYOUTS: readonly CustomAudioOutputLayout[] = Object.freeze([
    'stereo',
    '5.1',
    '7.1',
    '5.1.2',
    '5.1.4',
    '7.1.2',
    '7.1.4'
]);

// A pair the output lacks folds into the pair this names, and a channel without a pair splits across it
const FOLD_TARGETS: Readonly<Partial<Record<CustomAudioChannel, readonly CustomAudioChannel[]>>> = Object.freeze({
    // Sides and backs share the one surround pair of a 5.1 floor
    'back-left': Object.freeze([ 'side-left' ] as const),
    'back-right': Object.freeze([ 'side-right' ] as const),
    'side-left': Object.freeze([ 'back-left' ] as const),
    'side-right': Object.freeze([ 'back-right' ] as const),
    // Heights fold to the floor pair beneath them
    'top-back-left': Object.freeze([ 'back-left' ] as const),
    'top-back-right': Object.freeze([ 'back-right' ] as const),
    'top-front-left': Object.freeze([ 'front-left' ] as const),
    'top-front-right': Object.freeze([ 'front-right' ] as const)
});
const DIRECT_CHANNEL_GAIN = 1;
// One channel split across two speakers keeps its power
const SPLIT_CHANNEL_GAIN = Math.SQRT1_2;

type CustomAudioOutputChannelRoute = Readonly<{
    gain: number
    inputChannelIndex: number
    outputChannelIndex: number
}>;

type CustomAudioOutputRouting = Readonly<{
    /** Every input channel lands unscaled in the output slot of its own index */
    passthrough: boolean
    routes: readonly CustomAudioOutputChannelRoute[]
    /** Some output slot sums more than one route, which can exceed full scale */
    sums: boolean
}>;

const outputRoutingCache = new Map<string, CustomAudioOutputRouting>();

/** Reports whether a value names an output layout. */
export function isCustomAudioOutputLayout(value: unknown): value is CustomAudioOutputLayout {
    return typeof value === 'string' && Object.hasOwn(CUSTOM_AUDIO_OUTPUT_LAYOUT_DEFINITIONS, value);
}

/** Returns the speakers an output layout's destination takes, in its order. */
export function getCustomAudioOutputChannelLayout(outputLayout: CustomAudioOutputLayout): CustomAudioChannelLayout {
    return CUSTOM_AUDIO_OUTPUT_LAYOUT_DEFINITIONS[outputLayout].channelLayout;
}

/** Returns how many channels an output layout's destination takes. */
export function getCustomAudioOutputChannelCount(outputLayout: CustomAudioOutputLayout): number {
    return CUSTOM_AUDIO_OUTPUT_LAYOUT_DEFINITIONS[outputLayout].channelLayout.channels.length;
}

/** Returns an output layout without its heights: stereo, 5.1, or 7.1. */
export function getCustomAudioOutputFloorLayout(outputLayout: CustomAudioOutputLayout): CustomAudioFloorOutputLayout {
    return CUSTOM_AUDIO_OUTPUT_LAYOUT_DEFINITIONS[outputLayout].floor;
}

/** Reports whether an output layout has height speakers. */
export function hasCustomAudioOutputHeights(outputLayout: CustomAudioOutputLayout): boolean {
    return getCustomAudioOutputFloorLayout(outputLayout) !== outputLayout;
}

/**
 * Maps a decoded channel count to its layout when the decoder reports no speaker mask.
 * Three channels are 3.0 (FL, FR, FC), the order AAC, FLAC, Opus, and Vorbis decode to, and five and six are FFmpeg's 5.0 and 5.1, whose surrounds are sides.
 * 2.1, 3.0(back), 5.0(back), and the height layouts come only from a decoder's speaker mask.
 */
export function getCustomAudioChannelLayout(channelCount: number): CustomAudioChannelLayout | null {
    switch (channelCount) {
        case CUSTOM_MONO_INPUT_CHANNEL_COUNT:
            return CUSTOM_MONO_CHANNEL_LAYOUT;
        case CUSTOM_STEREO_INPUT_CHANNEL_COUNT:
            return CUSTOM_STEREO_CHANNEL_LAYOUT;
        case CUSTOM_THREE_CHANNEL_INPUT_CHANNEL_COUNT:
            return CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT;
        case CUSTOM_FIVE_POINT_ZERO_INPUT_CHANNEL_COUNT:
            return CUSTOM_FIVE_POINT_ZERO_CHANNEL_LAYOUT;
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
 * Resolves the output speakers one decoded channel feeds: its own, else the pair its fold target names, else, for a back center, the back pair split.
 * Each step resolves by the same rule, so a top back channel of a 5.1 output reaches the surround pair through the back pair.
 */
function resolveOutputChannels(channel: CustomAudioChannel, outputChannels: readonly CustomAudioChannel[]): readonly CustomAudioChannel[] {
    if (outputChannels.includes(channel)) {
        return [ channel ];
    }
    if (channel === 'back-center') {
        return [
            ...resolveOutputChannels('back-left', outputChannels),
            ...resolveOutputChannels('back-right', outputChannels)
        ];
    }
    for (const target of FOLD_TARGETS[channel] ?? []) {
        if (outputChannels.includes(target)) {
            return [ target ];
        }
        // Only a height continues to its floor pair's own fold: every output has a side or a back pair
        if (channel.startsWith('top-')) {
            return resolveOutputChannels(target, outputChannels);
        }
    }
    return [];
}

/**
 * Routes each decoded channel by name into a surround output layout.
 * A channel the output has passes through; one it lacks folds into the pair beneath it: sides and backs into the 5.1 surround pair, heights into the floor pair below them.
 * Every channel that folds into a speaker, and every one already there, takes 1/sqrt(n) of the n channels the speaker sums, which keeps the power of content common to them, sqrt(1/2) for a pair.
 * A back center splits across the back or surround pair at sqrt(1/2) each.
 */
function getSurroundOutputRouting(layout: CustomAudioChannelLayout, outputLayout: CustomAudioOutputLayout): CustomAudioOutputRouting {
    const cacheKey = `${layout.id}>${outputLayout}`;
    const cachedRouting = outputRoutingCache.get(cacheKey);
    if (cachedRouting) {
        return cachedRouting;
    }

    const outputChannels = getCustomAudioOutputChannelLayout(outputLayout).channels;
    const wholeChannelCounts = new Array<number>(outputChannels.length).fill(0);
    const routeCounts = new Array<number>(outputChannels.length).fill(0);
    const resolvedRoutes: Array<{ inputChannelIndex: number, outputChannelIndices: number[] }> = [];
    for (let inputChannelIndex = 0; inputChannelIndex < layout.channels.length; inputChannelIndex += 1) {
        const outputChannelIndices = resolveOutputChannels(layout.channels[inputChannelIndex], outputChannels)
            .map((channel: CustomAudioChannel): number => outputChannels.indexOf(channel));
        if (outputChannelIndices.length === 1) {
            wholeChannelCounts[outputChannelIndices[0]] += 1;
        }
        for (const outputChannelIndex of outputChannelIndices) {
            routeCounts[outputChannelIndex] += 1;
        }
        resolvedRoutes.push({ inputChannelIndex, outputChannelIndices });
    }

    const routes: CustomAudioOutputChannelRoute[] = [];
    let passthrough = layout.channels.length === outputChannels.length;
    for (const { inputChannelIndex, outputChannelIndices } of resolvedRoutes) {
        for (const outputChannelIndex of outputChannelIndices) {
            // sqrt(1/2) for a folded pair matches Math.SQRT1_2 bit for bit, and a lone channel keeps unit gain
            const gain = outputChannelIndices.length > 1 ?
                SPLIT_CHANNEL_GAIN :
                Math.sqrt(1 / wholeChannelCounts[outputChannelIndex]);
            routes.push({ gain, inputChannelIndex, outputChannelIndex });
            passthrough &&= gain === DIRECT_CHANNEL_GAIN && outputChannelIndex === inputChannelIndex;
        }
        passthrough &&= outputChannelIndices.length === 1;
    }
    const routing: CustomAudioOutputRouting = Object.freeze({
        passthrough,
        routes: Object.freeze(routes),
        sums: routeCounts.some((routeCount: number): boolean => routeCount > 1)
    });
    outputRoutingCache.set(cacheKey, routing);
    return routing;
}

/**
 * Reports whether converting the layout to the output sums channels, which can exceed full scale, so the output stage must run its peak limiter.
 */
export function requiresCustomAudioFoldDown(
    layout: CustomAudioChannelLayout,
    outputLayout: CustomAudioOutputLayout
): boolean {
    if (outputLayout === 'stereo') {
        return layout.channels.length > CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
    }
    return getSurroundOutputRouting(layout, outputLayout).sums;
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

/** Maps each decoded channel by name into a surround output layout; an input already in the output's order passes through uncopied. */
function mapCustomAudioToSurround(
    channelData: readonly Float32Array[],
    layout: CustomAudioChannelLayout,
    outputLayout: Exclude<CustomAudioOutputLayout, 'stereo'>
): CustomAudioOutputChannelData {
    const frameCount = requireLayoutChannelData(channelData, layout);
    const routing = getSurroundOutputRouting(layout, outputLayout);
    if (routing.passthrough) {
        return channelData;
    }

    const outputChannelData: Float32Array[] = [];
    const outputChannelCount = getCustomAudioOutputChannelCount(outputLayout);
    for (let outputChannelIndex = 0; outputChannelIndex < outputChannelCount; outputChannelIndex += 1) {
        outputChannelData.push(new Float32Array(frameCount));
    }
    for (const route of routing.routes) {
        const inputChannel = channelData[route.inputChannelIndex];
        const outputChannel = outputChannelData[route.outputChannelIndex];
        const gain = route.gain;
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
            outputChannel[frameIndex] += inputChannel[frameIndex] * gain;
        }
    }
    return outputChannelData;
}

/**
 * Mixes a decoded layout to stereo: mono is duplicated, stereo passes through, and every larger bed uses its downmix.
 * A 4.1 or 5.0 bed maps to 5.1, and a height layout first folds its heights into its 5.1 or 7.1 floor, which the floor's downmix then mixes.
 */
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
        case '4.1':
        case '5.0-back':
        case '5.0-side':
        case '5.1.2':
        case '5.1.2-side':
        case '5.1.4':
            return downmixFivePointOneToStereo(
                mapCustomAudioToSurround(channelData, layout, '5.1'),
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
        case '7.1.2':
        case '7.1.4':
            return downmixSevenPointOneToStereo(
                mapCustomAudioToSurround(channelData, layout, '7.1'),
                downmixAlgorithm,
                downmixSettings,
                downmixSettingsRamp
            );
    }
}

/**
 * Converts any decoded layout to the output layout by channel name: a bed already in the output's order passes through, a surround output maps and folds by name,
 * and stereo output uses the selected downmix.
 */
export function prepareCustomAudioOutputChannelData(
    channelData: readonly Float32Array[],
    layout: CustomAudioChannelLayout,
    outputLayout: CustomAudioOutputLayout,
    downmixAlgorithm: CustomAudioDownmixAlgorithm = DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    downmixSettings: AudioDownmixSettings = createDefaultAudioDownmixSettings(),
    downmixSettingsRamp: AudioDownmixSettingsRamp | null = null
): CustomAudioOutputChannelData {
    if (outputLayout === 'stereo') {
        return mixCustomAudioToStereo(
            channelData,
            layout,
            downmixAlgorithm,
            downmixSettings,
            downmixSettingsRamp
        );
    }
    return mapCustomAudioToSurround(channelData, layout, outputLayout);
}
