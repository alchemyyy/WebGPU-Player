import { describe, expect, it } from 'vitest';

import {
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_FOUR,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_TWO,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE_POINT_TWO,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ZERO_BACK,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ZERO_SIDE,
    CUSTOM_WAVE_CHANNEL_MASK_FOUR_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_MONO,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_TWO,
    CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_STEREO,
    CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO,
    CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO_BACK,
    CUSTOM_WAVE_CHANNEL_MASK_TWO_POINT_ONE,
    getCustomAudioOutputChannelMask,
    getQualifiedCustomWaveChannelLayout
} from 'webgpu-player/audio/processing/CustomWaveChannelLayout';
import { CUSTOM_AUDIO_OUTPUT_LAYOUTS, getCustomAudioOutputChannelLayout } from 'webgpu-player/audio/processing/CustomAudioChannelLayout';

// FL, FR, FC, and back center: the 4.0 bed, which has no implemented layout
const WAVE_CHANNEL_MASK_FOUR_POINT_ZERO = 0x0107;

describe('getQualifiedCustomWaveChannelLayout', () => {
    it.each([
        [ CUSTOM_WAVE_CHANNEL_MASK_MONO, 1, 'mono' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_STEREO, 2, 'stereo' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO, 3, '3.0' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_TWO_POINT_ONE, 3, '2.1' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO_BACK, 3, '3.0-back' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_FOUR_POINT_ONE, 5, '4.1' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ZERO_SIDE, 5, '5.0-side' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ZERO_BACK, 5, '5.0-back' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK, 6, '5.1-back' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE, 6, '5.1-side' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE, 7, '6.1' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE, 8, '7.1' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_TWO, 8, '5.1.2' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE_POINT_TWO, 8, '5.1.2-side' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_FOUR, 10, '5.1.4' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_TWO, 10, '7.1.2' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR, 12, '7.1.4' ]
    ] as const)(
        'maps exact mask %# to %s',
        (channelMask, channelCount, layoutID) => {
            const result = getQualifiedCustomWaveChannelLayout(channelMask);

            expect(result?.channelCount).toBe(channelCount);
            expect(result?.layout.id).toBe(layoutID);
            expect(result?.layout.channels).toHaveLength(channelCount);
        }
    );

    it('orders the three-channel beds by ascending speaker bit', () => {
        expect(getQualifiedCustomWaveChannelLayout(
            CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO
        )?.layout.channels).toEqual([ 'front-left', 'front-right', 'front-center' ]);
        expect(getQualifiedCustomWaveChannelLayout(
            CUSTOM_WAVE_CHANNEL_MASK_TWO_POINT_ONE
        )?.layout.channels).toEqual([ 'front-left', 'front-right', 'low-frequency-effects' ]);
        expect(getQualifiedCustomWaveChannelLayout(
            CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO_BACK
        )?.layout.channels).toEqual([ 'front-left', 'front-right', 'back-center' ]);
    });

    it('orders the 5.0 beds by ascending speaker bit', () => {
        expect(getQualifiedCustomWaveChannelLayout(CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ZERO_SIDE)?.layout.channels)
            .toEqual([ 'front-left', 'front-right', 'front-center', 'side-left', 'side-right' ]);
        expect(getQualifiedCustomWaveChannelLayout(CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ZERO_BACK)?.layout.channels)
            .toEqual([ 'front-left', 'front-right', 'front-center', 'back-left', 'back-right' ]);
    });

    it('qualifies FFmpeg\'s height layouts by their masks, in ascending speaker bit order', () => {
        expect([
            CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_TWO,
            CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_FOUR,
            CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_TWO,
            CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR
        ]).toEqual([ 0x503f, 0x2d03f, 0x563f, 0x2d63f ]);
        expect(getQualifiedCustomWaveChannelLayout(CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR)?.layout.channels.slice(8)).toEqual([
            'top-front-left',
            'top-front-right',
            'top-back-left',
            'top-back-right'
        ]);
    });

    it('gives every output layout the mask of its own speakers, which a package renders into', () => {
        for (const outputLayout of CUSTOM_AUDIO_OUTPUT_LAYOUTS) {
            const qualifiedLayout = getQualifiedCustomWaveChannelLayout(getCustomAudioOutputChannelMask(outputLayout));
            expect(qualifiedLayout?.layout, outputLayout).toBe(getCustomAudioOutputChannelLayout(outputLayout));
        }
        expect(getCustomAudioOutputChannelMask('5.1')).toBe(CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE);
    });

    it.each([
        0,
        -1,
        // 5.1(back) with only the top front left
        0x003f | 0x1000,
        WAVE_CHANNEL_MASK_FOUR_POINT_ZERO,
        0x003f | 0x0800,
        1.5,
        Number.NaN
    ])(
        'rejects ambiguous or unsupported mask %s',
        channelMask => {
            expect(getQualifiedCustomWaveChannelLayout(channelMask)).toBeNull();
        }
    );
});
