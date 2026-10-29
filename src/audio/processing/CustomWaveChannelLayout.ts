import {
    CUSTOM_FIVE_POINT_ONE_BACK_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ONE_SIDE_POINT_TWO_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ZERO_BACK_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ZERO_CHANNEL_LAYOUT,
    CUSTOM_MONO_CHANNEL_LAYOUT,
    CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT,
    CUSTOM_SEVEN_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT,
    CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_STEREO_CHANNEL_LAYOUT,
    CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT,
    CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT,
    CUSTOM_TWO_POINT_ONE_CHANNEL_LAYOUT,
    type CustomAudioChannelLayout,
    type CustomAudioOutputLayout
} from './CustomAudioChannelLayout';

export const CUSTOM_WAVE_CHANNEL_MASK_MONO = 0x0004;
export const CUSTOM_WAVE_CHANNEL_MASK_STEREO = 0x0003;
export const CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO = 0x0007;
export const CUSTOM_WAVE_CHANNEL_MASK_TWO_POINT_ONE = 0x000b;
// FL, FR, and back center
export const CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO_BACK = 0x0103;
export const CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK = 0x003f;
// FFmpeg's 5.0(side), AV_CH_LAYOUT_5POINT0, which AC-3 and DTS 3/2 decode to, and 5.0(back)
export const CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ZERO_SIDE = 0x0607;
export const CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ZERO_BACK = 0x0037;
export const CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE = 0x060f;
export const CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE = 0x070f;
export const CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE = 0x063f;
// FFmpeg's height layouts: 5.1(back) or 7.1 with top front left (0x1000) and right (0x4000), and top back left (0x8000) and right (0x20000)
export const CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_TWO = 0x503f;
export const CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_FOUR = 0x2d03f;
export const CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_TWO = 0x563f;
export const CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR = 0x2d63f;
// 5.1(side) with the top front pair, which FFmpeg's E-AC-3 decoder reports for a dependent stream that adds the heights; a decoded layout only
export const CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE_POINT_TWO = 0x560f;

export type QualifiedCustomWaveChannelLayout = Readonly<{
    channelCount: 1 | 2 | 3 | 5 | 6 | 7 | 8 | 10 | 12
    layout: CustomAudioChannelLayout
}>;

const CUSTOM_WAVE_CHANNEL_LAYOUTS = new Map<number, QualifiedCustomWaveChannelLayout>([
    [
        CUSTOM_WAVE_CHANNEL_MASK_MONO,
        { channelCount: 1, layout: CUSTOM_MONO_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_STEREO,
        { channelCount: 2, layout: CUSTOM_STEREO_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO,
        { channelCount: 3, layout: CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_TWO_POINT_ONE,
        { channelCount: 3, layout: CUSTOM_TWO_POINT_ONE_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO_BACK,
        { channelCount: 3, layout: CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ZERO_SIDE,
        { channelCount: 5, layout: CUSTOM_FIVE_POINT_ZERO_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ZERO_BACK,
        { channelCount: 5, layout: CUSTOM_FIVE_POINT_ZERO_BACK_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK,
        { channelCount: 6, layout: CUSTOM_FIVE_POINT_ONE_BACK_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
        { channelCount: 6, layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE,
        { channelCount: 7, layout: CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
        { channelCount: 8, layout: CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_TWO,
        { channelCount: 8, layout: CUSTOM_FIVE_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE_POINT_TWO,
        { channelCount: 8, layout: CUSTOM_FIVE_POINT_ONE_SIDE_POINT_TWO_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_FOUR,
        { channelCount: 10, layout: CUSTOM_FIVE_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_TWO,
        { channelCount: 10, layout: CUSTOM_SEVEN_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR,
        { channelCount: 12, layout: CUSTOM_SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT }
    ]
]);

// The mask a package renders object audio into for each output layout; 5.1 is FFmpeg's 5.1, which E-AC-3 and TrueHD decode to
/* eslint-disable @typescript-eslint/naming-convention -- speaker layouts take FFmpeg's names */
const CUSTOM_AUDIO_OUTPUT_CHANNEL_MASKS: Readonly<Record<CustomAudioOutputLayout, number>> = Object.freeze({
    '5.1': CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
    '5.1.2': CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_TWO,
    '5.1.4': CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_FOUR,
    '7.1': CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    '7.1.2': CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_TWO,
    '7.1.4': CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR,
    stereo: CUSTOM_WAVE_CHANNEL_MASK_STEREO
});
/* eslint-enable @typescript-eslint/naming-convention */

/** Maps only exact native/WAVE masks covered by the shared PCM pipeline. */
export function getQualifiedCustomWaveChannelLayout(channelMask: number): QualifiedCustomWaveChannelLayout | null {
    if (!Number.isSafeInteger(channelMask) || channelMask <= 0) {
        return null;
    }
    return CUSTOM_WAVE_CHANNEL_LAYOUTS.get(channelMask) ?? null;
}

/** Returns the WAVE channel mask of an output layout, which a package's `renderChannelMask` option takes. */
export function getCustomAudioOutputChannelMask(outputLayout: CustomAudioOutputLayout): number {
    return CUSTOM_AUDIO_OUTPUT_CHANNEL_MASKS[outputLayout];
}
