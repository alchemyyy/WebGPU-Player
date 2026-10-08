import { describe, expect, it } from 'vitest';

import { CUSTOM_AUDIO_DOWNMIX_ALGORITHMS } from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import {
    CUSTOM_FIVE_POINT_ONE_BACK_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_MONO_CHANNEL_LAYOUT,
    CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_STEREO_CHANNEL_LAYOUT,
    CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT,
    CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT,
    CUSTOM_TWO_POINT_ONE_CHANNEL_LAYOUT,
    getCustomAudioChannelLayout,
    mixCustomAudioToStereo,
    prepareCustomAudioOutputChannelData,
    requiresCustomAudioFoldDown,
    type CustomAudioChannelLayout,
    type CustomAudioOutputChannelCount
} from 'webgpu-player/audio/processing/CustomAudioChannelLayout';

// Standard Lo/Ro gains shared by the 5.1 and 7.1 matrices
const STANDARD_DIRECT_GAIN = 1;
const STANDARD_MIXED_GAIN = Math.SQRT1_2;
const FOLDED_GAIN = Math.SQRT1_2;

/** Gives each channel one frame holding its one-based position. */
function createNumberedChannels(channelCount: number): Float32Array[] {
    const channels: Float32Array[] = [];
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        channels.push(new Float32Array([ channelIndex + 1 ]));
    }
    return channels;
}

function getFirstFrames(channels: readonly Float32Array[]): number[] {
    return channels.map(channel => channel[0]);
}

describe('CustomAudioChannelLayout', () => {
    it('maps decoded channel counts to their default layouts', () => {
        expect(getCustomAudioChannelLayout(1)).toBe(CUSTOM_MONO_CHANNEL_LAYOUT);
        expect(getCustomAudioChannelLayout(2)).toBe(CUSTOM_STEREO_CHANNEL_LAYOUT);
        expect(getCustomAudioChannelLayout(3)).toBe(CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT);
        expect(getCustomAudioChannelLayout(6)).toBe(CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT);
        expect(getCustomAudioChannelLayout(7)).toBe(CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT);
        expect(getCustomAudioChannelLayout(8)).toBe(CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT);
        expect(getCustomAudioChannelLayout(0)).toBeNull();
        expect(getCustomAudioChannelLayout(4)).toBeNull();
        expect(getCustomAudioChannelLayout(5)).toBeNull();
    });

    it('uses the shared 6.1 matrix in explicit WAVE channel order', () => {
        const channels: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < 7; channelIndex += 1) {
            channels.push(new Float32Array([ channelIndex + 1 ]));
        }

        const output = mixCustomAudioToStereo(
            channels,
            CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT
        );
        const directGain = 1 / (1 + 3 / Math.SQRT2);
        const mixedGain = directGain / Math.SQRT2;
        expect(output[0][0]).toBeCloseTo(
            1 * directGain + (3 + 5 + 6) * mixedGain,
            6
        );
        expect(output[1][0]).toBeCloseTo(
            2 * directGain + (3 + 5 + 7) * mixedGain,
            6
        );
    });

    it('duplicates mono without changing its level', () => {
        const mono = new Float32Array([ -1, -0.25, 0.5, 1 ]);
        const output = mixCustomAudioToStereo([ mono ], CUSTOM_MONO_CHANNEL_LAYOUT);

        expect(output[0]).toEqual(mono);
        expect(output[1]).toEqual(mono);
        expect(output[0]).not.toBe(mono);
        expect(output[1]).not.toBe(mono);
    });

    it('keeps stereo buffers without another copy', () => {
        const left = new Float32Array([ 0.25, 0.5 ]);
        const right = new Float32Array([ -0.25, -0.5 ]);
        const output = mixCustomAudioToStereo(
            [ left, right ],
            CUSTOM_STEREO_CHANNEL_LAYOUT
        );

        expect(output).toEqual([ left, right ]);
        expect(output[0]).toBe(left);
        expect(output[1]).toBe(right);
    });

    it('uses the shared 5.1 matrix and validates the declared layout', () => {
        const channels: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < 6; channelIndex += 1) {
            channels.push(new Float32Array([ channelIndex + 1 ]));
        }

        const output = mixCustomAudioToStereo(
            channels,
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT
        );
        expect(output[0][0]).toBeCloseTo(
            STANDARD_DIRECT_GAIN
                + 3 * STANDARD_MIXED_GAIN
                + 5 * STANDARD_MIXED_GAIN,
            6
        );
        expect(output[1][0]).toBeCloseTo(
            2 * STANDARD_DIRECT_GAIN
                + 3 * STANDARD_MIXED_GAIN
                + 6 * STANDARD_MIXED_GAIN,
            6
        );
        expect(() => mixCustomAudioToStereo(
            channels.slice(0, 2),
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT
        )).toThrow('5.1-side audio requires exactly 6 input channels');
    });

    it('applies the selected matrix only when stereo conversion is required', () => {
        const channels = [ 1, 2, 3, 4, 5, 6 ].map(value => (
            new Float32Array([ value ])
        ));

        const stereoOutput = prepareCustomAudioOutputChannelData(
            channels,
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
            2,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue
        );
        const nativeOutput = prepareCustomAudioOutputChannelData(
            channels,
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
            6,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue
        );

        expect(stereoOutput[0][0]).toBeCloseTo(1 * 0.3 + 3 + 5 * 0.3, 6);
        expect(stereoOutput[1][0]).toBeCloseTo(2 * 0.3 + 3 + 6 * 0.3, 6);
        expect(nativeOutput).toBe(channels);
    });

    it('uses the shared 7.1 matrix in explicit WAVE channel order', () => {
        const channels: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < 8; channelIndex += 1) {
            channels.push(new Float32Array([ channelIndex + 1 ]));
        }

        const output = mixCustomAudioToStereo(
            channels,
            CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT
        );
        expect(output[0][0]).toBeCloseTo(
            1 * STANDARD_DIRECT_GAIN + (3 + 5 + 7) * STANDARD_MIXED_GAIN,
            6
        );
        expect(output[1][0]).toBeCloseTo(
            2 * STANDARD_DIRECT_GAIN + (3 + 6 + 8) * STANDARD_MIXED_GAIN,
            6
        );
        expect(() => mixCustomAudioToStereo(
            channels.slice(0, 6),
            CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT
        )).toThrow('7.1 audio requires exactly 8 input channels');
    });

    it.each([
        { channelCount: 6 as const, layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT },
        { channelCount: 8 as const, layout: CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT }
    ])('preserves exact $channelCount-channel speaker data without another copy', ({
        channelCount,
        layout
    }) => {
        const channels: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            channels.push(new Float32Array([ channelIndex + 1 ]));
        }

        const output = prepareCustomAudioOutputChannelData(
            channels,
            layout,
            channelCount
        );

        expect(output).toBe(channels);
    });

    it.each([
        // 5.1 sides fill the 7.1 sides and backs fill the 7.1 backs; the other pair stays silent
        {
            expectedFrames: [ 1, 2, 3, 4, 0, 0, 5, 6 ],
            layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
            outputChannelCount: 8
        },
        {
            expectedFrames: [ 1, 2, 3, 4, 5, 6, 0, 0 ],
            layout: CUSTOM_FIVE_POINT_ONE_BACK_CHANNEL_LAYOUT,
            outputChannelCount: 8
        },
        // The 6.1 back center splits across the back pair at sqrt(1/2)
        {
            expectedFrames: [ 1, 2, 3, 4, 5 * FOLDED_GAIN, 5 * FOLDED_GAIN, 6, 7 ],
            layout: CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT,
            outputChannelCount: 8
        },
        {
            expectedFrames: [ 0, 0, 1, 0, 0, 0 ],
            layout: CUSTOM_MONO_CHANNEL_LAYOUT,
            outputChannelCount: 6
        },
        {
            expectedFrames: [ 0, 0, 1, 0, 0, 0, 0, 0 ],
            layout: CUSTOM_MONO_CHANNEL_LAYOUT,
            outputChannelCount: 8
        },
        {
            expectedFrames: [ 1, 2, 0, 0, 0, 0 ],
            layout: CUSTOM_STEREO_CHANNEL_LAYOUT,
            outputChannelCount: 6
        },
        {
            expectedFrames: [ 1, 2, 0, 3, 0, 0 ],
            layout: CUSTOM_TWO_POINT_ONE_CHANNEL_LAYOUT,
            outputChannelCount: 6
        },
        {
            expectedFrames: [ 1, 2, 3, 0, 0, 0 ],
            layout: CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT,
            outputChannelCount: 6
        },
        {
            expectedFrames: [ 1, 2, 3, 0, 0, 0, 0, 0 ],
            layout: CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT,
            outputChannelCount: 8
        },
        // The 3.0(back) back center splits across the 5.1 surround pair or the 7.1 back pair
        {
            expectedFrames: [ 1, 2, 0, 0, 3 * FOLDED_GAIN, 3 * FOLDED_GAIN ],
            layout: CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT,
            outputChannelCount: 6
        },
        {
            expectedFrames: [ 1, 2, 0, 0, 3 * FOLDED_GAIN, 3 * FOLDED_GAIN, 0, 0 ],
            layout: CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT,
            outputChannelCount: 8
        }
    ] as const)(
        'maps the $layout.id layout to $outputChannelCount speakers by channel name',
        ({ expectedFrames, layout, outputChannelCount }) => {
            const channels = createNumberedChannels(layout.channels.length);

            const output = prepareCustomAudioOutputChannelData(
                channels,
                layout,
                outputChannelCount
            );

            expect(output).toHaveLength(outputChannelCount);
            const outputFrames = getFirstFrames(output);
            for (let channelIndex = 0; channelIndex < outputChannelCount; channelIndex += 1) {
                expect(outputFrames[channelIndex]).toBeCloseTo(expectedFrames[channelIndex], 6);
            }
        }
    );

    it('folds 7.1 and 6.1 surrounds into the 5.1 surround pair at sqrt(1/2)', () => {
        const sevenPointOneOutput = prepareCustomAudioOutputChannelData(
            createNumberedChannels(8),
            CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
            6
        );
        const sixPointOneOutput = prepareCustomAudioOutputChannelData(
            createNumberedChannels(7),
            CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT,
            6
        );

        // Ls = sqrt(1/2)(SL + BL) and Rs = sqrt(1/2)(SR + BR) from FL FR FC LFE BL BR SL SR
        const sevenPointOneFrames = getFirstFrames(sevenPointOneOutput);
        expect(sevenPointOneFrames.slice(0, 4)).toEqual([ 1, 2, 3, 4 ]);
        expect(sevenPointOneFrames[4]).toBeCloseTo(FOLDED_GAIN * (7 + 5), 6);
        expect(sevenPointOneFrames[5]).toBeCloseTo(FOLDED_GAIN * (8 + 6), 6);
        // Ls = SL + sqrt(1/2) BC and Rs = SR + sqrt(1/2) BC from FL FR FC LFE BC SL SR
        const sixPointOneFrames = getFirstFrames(sixPointOneOutput);
        expect(sixPointOneFrames.slice(0, 4)).toEqual([ 1, 2, 3, 4 ]);
        expect(sixPointOneFrames[4]).toBeCloseTo(6 + FOLDED_GAIN * 5, 6);
        expect(sixPointOneFrames[5]).toBeCloseTo(7 + FOLDED_GAIN * 5, 6);
    });

    it('mixes three-channel beds to stereo with their third channel in both outputs', () => {
        const threePointZeroOutput = mixCustomAudioToStereo(
            createNumberedChannels(3),
            CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT
        );
        const twoPointOneOutput = mixCustomAudioToStereo(
            createNumberedChannels(3),
            CUSTOM_TWO_POINT_ONE_CHANNEL_LAYOUT
        );
        const dave750Output = mixCustomAudioToStereo(
            createNumberedChannels(3),
            CUSTOM_TWO_POINT_ONE_CHANNEL_LAYOUT,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750
        );
        const threePointZeroBackOutput = mixCustomAudioToStereo(
            createNumberedChannels(3),
            CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT
        );

        expect(threePointZeroOutput[0][0]).toBeCloseTo(1 + 3 * STANDARD_MIXED_GAIN, 6);
        expect(threePointZeroOutput[1][0]).toBeCloseTo(2 + 3 * STANDARD_MIXED_GAIN, 6);
        // Standard Lo/Ro omits LFE, while Dave750 keeps it at 0.5
        expect(getFirstFrames(twoPointOneOutput)).toEqual([ 1, 2 ]);
        expect(dave750Output[0][0]).toBeCloseTo(1 * 0.707 + 3 * 0.5, 6);
        expect(dave750Output[1][0]).toBeCloseTo(2 * 0.707 + 3 * 0.5, 6);
        // The back center reaches each output as both surrounds at sqrt(1/2)
        expect(threePointZeroBackOutput[0][0]).toBeCloseTo(1 + 3 * 0.5, 6);
        expect(threePointZeroBackOutput[1][0]).toBeCloseTo(2 + 3 * 0.5, 6);
    });

    it.each([
        CUSTOM_TWO_POINT_ONE_CHANNEL_LAYOUT,
        CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT,
        CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT
    ])('keeps a correlated full-scale $id bed at full scale with the peak-normalized matrix', layout => {
        const fullScaleChannels = [ 1, 1, 1 ].map(value => new Float32Array([ value ]));

        const output = mixCustomAudioToStereo(
            fullScaleChannels,
            layout,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO
        );

        expect(output[0][0]).toBeCloseTo(1, 6);
        expect(output[1][0]).toBeCloseTo(1, 6);
    });

    it.each([
        { foldsDown: false, layout: CUSTOM_MONO_CHANNEL_LAYOUT, outputChannelCount: 2 },
        { foldsDown: false, layout: CUSTOM_STEREO_CHANNEL_LAYOUT, outputChannelCount: 2 },
        { foldsDown: true, layout: CUSTOM_TWO_POINT_ONE_CHANNEL_LAYOUT, outputChannelCount: 2 },
        { foldsDown: true, layout: CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT, outputChannelCount: 2 },
        { foldsDown: false, layout: CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT, outputChannelCount: 6 },
        { foldsDown: true, layout: CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT, outputChannelCount: 2 },
        { foldsDown: false, layout: CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT, outputChannelCount: 6 },
        { foldsDown: false, layout: CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT, outputChannelCount: 8 },
        { foldsDown: true, layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT, outputChannelCount: 2 },
        { foldsDown: false, layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT, outputChannelCount: 6 },
        { foldsDown: false, layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT, outputChannelCount: 8 },
        { foldsDown: true, layout: CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT, outputChannelCount: 6 },
        { foldsDown: false, layout: CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT, outputChannelCount: 8 },
        { foldsDown: true, layout: CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT, outputChannelCount: 6 },
        { foldsDown: false, layout: CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT, outputChannelCount: 8 }
    ] satisfies ReadonlyArray<{
        foldsDown: boolean
        layout: CustomAudioChannelLayout
        outputChannelCount: CustomAudioOutputChannelCount
    }>)(
        'reports whether $layout.id to $outputChannelCount speakers folds down',
        ({ foldsDown, layout, outputChannelCount }) => {
            expect(requiresCustomAudioFoldDown(layout, outputChannelCount)).toBe(foldsDown);
        }
    );

    it('still validates the decoded channel count against its layout', () => {
        expect(() => prepareCustomAudioOutputChannelData(
            createNumberedChannels(6),
            CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
            6
        )).toThrow('7.1 audio requires exactly 8 input channels');
    });
});
