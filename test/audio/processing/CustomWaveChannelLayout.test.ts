import { describe, expect, it } from 'vitest';

import {
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
    CUSTOM_WAVE_CHANNEL_MASK_MONO,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_STEREO,
    CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO,
    CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO_BACK,
    CUSTOM_WAVE_CHANNEL_MASK_TWO_POINT_ONE,
    getQualifiedCustomWaveChannelLayout
} from 'webgpu-player/audio/processing/CustomWaveChannelLayout';

// FL, FR, FC, and back center: the 4.0 bed, which has no implemented layout
const WAVE_CHANNEL_MASK_FOUR_POINT_ZERO = 0x0107;

describe('getQualifiedCustomWaveChannelLayout', () => {
    it.each([
        [ CUSTOM_WAVE_CHANNEL_MASK_MONO, 1, 'mono' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_STEREO, 2, 'stereo' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO, 3, '3.0' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_TWO_POINT_ONE, 3, '2.1' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO_BACK, 3, '3.0-back' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK, 6, '5.1-back' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE, 6, '5.1-side' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE, 7, '6.1' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE, 8, '7.1' ]
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

    it.each([
        0,
        -1,
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
