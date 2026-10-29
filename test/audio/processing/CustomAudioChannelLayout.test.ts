import { describe, expect, it } from 'vitest';

import { CUSTOM_AUDIO_DOWNMIX_ALGORITHMS } from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import {
    CUSTOM_FIVE_POINT_ONE_BACK_CHANNEL_LAYOUT,
    CUSTOM_AUDIO_OUTPUT_LAYOUTS,
    CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ONE_SIDE_POINT_TWO_CHANNEL_LAYOUT,
    CUSTOM_MONO_CHANNEL_LAYOUT,
    CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT,
    CUSTOM_SEVEN_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT,
    CUSTOM_STEREO_CHANNEL_LAYOUT,
    CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT,
    CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT,
    CUSTOM_TWO_POINT_ONE_CHANNEL_LAYOUT,
    getCustomAudioChannelLayout,
    getCustomAudioOutputChannelCount,
    getCustomAudioOutputChannelLayout,
    getCustomAudioOutputFloorLayout,
    mixCustomAudioToStereo,
    prepareCustomAudioOutputChannelData,
    requiresCustomAudioFoldDown,
    type CustomAudioChannelLayout,
    type CustomAudioOutputLayout
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
            'stereo',
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue
        );
        const nativeOutput = prepareCustomAudioOutputChannelData(
            channels,
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
            '5.1',
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
        { channelCount: 6, layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT, outputLayout: '5.1' },
        { channelCount: 6, layout: CUSTOM_FIVE_POINT_ONE_BACK_CHANNEL_LAYOUT, outputLayout: '5.1' },
        { channelCount: 8, layout: CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT, outputLayout: '7.1' },
        { channelCount: 8, layout: CUSTOM_FIVE_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT, outputLayout: '5.1.2' },
        { channelCount: 10, layout: CUSTOM_FIVE_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT, outputLayout: '5.1.4' },
        { channelCount: 10, layout: CUSTOM_SEVEN_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT, outputLayout: '7.1.2' },
        { channelCount: 12, layout: CUSTOM_SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT, outputLayout: '7.1.4' }
    ] as const)('passes $layout.id speaker data to a $outputLayout destination without another copy', ({
        channelCount,
        layout,
        outputLayout
    }) => {
        const channels: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            channels.push(new Float32Array([ channelIndex + 1 ]));
        }

        const output = prepareCustomAudioOutputChannelData(
            channels,
            layout,
            outputLayout
        );

        expect(output).toBe(channels);
        expect(requiresCustomAudioFoldDown(layout, outputLayout)).toBe(false);
    });

    it.each([
        // 5.1 sides fill the 7.1 sides and backs fill the 7.1 backs; the other pair stays silent
        {
            expectedFrames: [ 1, 2, 3, 4, 0, 0, 5, 6 ],
            layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
            outputLayout: '7.1'
        },
        {
            expectedFrames: [ 1, 2, 3, 4, 5, 6, 0, 0 ],
            layout: CUSTOM_FIVE_POINT_ONE_BACK_CHANNEL_LAYOUT,
            outputLayout: '7.1'
        },
        // The 6.1 back center splits across the back pair at sqrt(1/2)
        {
            expectedFrames: [ 1, 2, 3, 4, 5 * FOLDED_GAIN, 5 * FOLDED_GAIN, 6, 7 ],
            layout: CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT,
            outputLayout: '7.1'
        },
        {
            expectedFrames: [ 0, 0, 1, 0, 0, 0 ],
            layout: CUSTOM_MONO_CHANNEL_LAYOUT,
            outputLayout: '5.1'
        },
        {
            expectedFrames: [ 0, 0, 1, 0, 0, 0, 0, 0 ],
            layout: CUSTOM_MONO_CHANNEL_LAYOUT,
            outputLayout: '7.1'
        },
        {
            expectedFrames: [ 1, 2, 0, 0, 0, 0 ],
            layout: CUSTOM_STEREO_CHANNEL_LAYOUT,
            outputLayout: '5.1'
        },
        {
            expectedFrames: [ 1, 2, 0, 3, 0, 0 ],
            layout: CUSTOM_TWO_POINT_ONE_CHANNEL_LAYOUT,
            outputLayout: '5.1'
        },
        {
            expectedFrames: [ 1, 2, 3, 0, 0, 0 ],
            layout: CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT,
            outputLayout: '5.1'
        },
        {
            expectedFrames: [ 1, 2, 3, 0, 0, 0, 0, 0 ],
            layout: CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT,
            outputLayout: '7.1'
        },
        // The 3.0(back) back center splits across the 5.1 surround pair or the 7.1 back pair
        {
            expectedFrames: [ 1, 2, 0, 0, 3 * FOLDED_GAIN, 3 * FOLDED_GAIN ],
            layout: CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT,
            outputLayout: '5.1'
        },
        {
            expectedFrames: [ 1, 2, 0, 0, 3 * FOLDED_GAIN, 3 * FOLDED_GAIN, 0, 0 ],
            layout: CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT,
            outputLayout: '7.1'
        }
    ] as const)(
        'maps the $layout.id layout to $outputLayout speakers by channel name',
        ({ expectedFrames, layout, outputLayout }) => {
            const channels = createNumberedChannels(layout.channels.length);

            const output = prepareCustomAudioOutputChannelData(
                channels,
                layout,
                outputLayout
            );

            expect(output).toHaveLength(getCustomAudioOutputChannelCount(outputLayout));
            expect(output).toHaveLength(expectedFrames.length);
            const outputFrames = getFirstFrames(output);
            for (let channelIndex = 0; channelIndex < expectedFrames.length; channelIndex += 1) {
                expect(outputFrames[channelIndex]).toBeCloseTo(expectedFrames[channelIndex], 6);
            }
        }
    );

    it('folds 7.1 and 6.1 surrounds into the 5.1 surround pair at sqrt(1/2)', () => {
        const sevenPointOneOutput = prepareCustomAudioOutputChannelData(
            createNumberedChannels(8),
            CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
            '5.1'
        );
        const sixPointOneOutput = prepareCustomAudioOutputChannelData(
            createNumberedChannels(7),
            CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT,
            '5.1'
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
        { foldsDown: false, layout: CUSTOM_MONO_CHANNEL_LAYOUT, outputLayout: 'stereo' },
        { foldsDown: false, layout: CUSTOM_STEREO_CHANNEL_LAYOUT, outputLayout: 'stereo' },
        { foldsDown: true, layout: CUSTOM_TWO_POINT_ONE_CHANNEL_LAYOUT, outputLayout: 'stereo' },
        { foldsDown: true, layout: CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT, outputLayout: 'stereo' },
        { foldsDown: false, layout: CUSTOM_THREE_POINT_ZERO_CHANNEL_LAYOUT, outputLayout: '5.1' },
        { foldsDown: true, layout: CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT, outputLayout: 'stereo' },
        { foldsDown: false, layout: CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT, outputLayout: '5.1' },
        { foldsDown: false, layout: CUSTOM_THREE_POINT_ZERO_BACK_CHANNEL_LAYOUT, outputLayout: '7.1' },
        { foldsDown: true, layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT, outputLayout: 'stereo' },
        { foldsDown: false, layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT, outputLayout: '5.1' },
        { foldsDown: false, layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT, outputLayout: '7.1' },
        { foldsDown: true, layout: CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT, outputLayout: '5.1' },
        { foldsDown: false, layout: CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT, outputLayout: '7.1' },
        { foldsDown: true, layout: CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT, outputLayout: '5.1' },
        { foldsDown: false, layout: CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT, outputLayout: '7.1' }
    ] satisfies ReadonlyArray<{
        foldsDown: boolean
        layout: CustomAudioChannelLayout
        outputLayout: CustomAudioOutputLayout
    }>)(
        'reports whether $layout.id to $outputLayout speakers folds down',
        ({ foldsDown, layout, outputLayout }) => {
            expect(requiresCustomAudioFoldDown(layout, outputLayout)).toBe(foldsDown);
        }
    );

    it('still validates the decoded channel count against its layout', () => {
        expect(() => prepareCustomAudioOutputChannelData(
            createNumberedChannels(6),
            CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
            '5.1'
        )).toThrow('7.1 audio requires exactly 8 input channels');
    });
});

const HEIGHT_LAYOUTS: readonly CustomAudioChannelLayout[] = [
    CUSTOM_FIVE_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ONE_SIDE_POINT_TWO_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT,
    CUSTOM_SEVEN_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT,
    CUSTOM_SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT
];
const SURROUND_OUTPUT_LAYOUTS: readonly CustomAudioOutputLayout[] = CUSTOM_AUDIO_OUTPUT_LAYOUTS.filter(layout => layout !== 'stereo');
// The pairs of a height layout and every other surround output, each of which drops or moves some channel
const HEIGHT_FOLD_CASES = HEIGHT_LAYOUTS.flatMap(layout => SURROUND_OUTPUT_LAYOUTS
    .filter(outputLayout => getCustomAudioOutputChannelLayout(outputLayout).id !== layout.id)
    .map(outputLayout => ({ layout, outputLayout })));

function getPower(channels: readonly Float32Array[]): number {
    return channels.reduce((power, channel) => power + channel[0] * channel[0], 0);
}

describe('CustomAudioChannelLayout heights', () => {
    it.each([
        { channelCount: 2, channels: [ 'front-left', 'front-right' ], floor: 'stereo', outputLayout: 'stereo' },
        { channelCount: 6, channels: [ 'front-left', 'front-right', 'front-center', 'low-frequency-effects', 'side-left', 'side-right' ], floor: '5.1', outputLayout: '5.1' },
        { channelCount: 8, channels: CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT.channels, floor: '7.1', outputLayout: '7.1' },
        {
            channelCount: 8,
            channels: [ 'front-left', 'front-right', 'front-center', 'low-frequency-effects', 'back-left', 'back-right', 'top-front-left', 'top-front-right' ],
            floor: '5.1',
            outputLayout: '5.1.2'
        },
        {
            channelCount: 10,
            channels: [
                'front-left', 'front-right', 'front-center', 'low-frequency-effects', 'back-left', 'back-right',
                'top-front-left', 'top-front-right', 'top-back-left', 'top-back-right'
            ],
            floor: '5.1',
            outputLayout: '5.1.4'
        },
        {
            channelCount: 10,
            channels: [
                'front-left', 'front-right', 'front-center', 'low-frequency-effects', 'back-left', 'back-right', 'side-left', 'side-right',
                'top-front-left', 'top-front-right'
            ],
            floor: '7.1',
            outputLayout: '7.1.2'
        },
        {
            channelCount: 12,
            channels: [
                'front-left', 'front-right', 'front-center', 'low-frequency-effects', 'back-left', 'back-right', 'side-left', 'side-right',
                'top-front-left', 'top-front-right', 'top-back-left', 'top-back-right'
            ],
            floor: '7.1',
            outputLayout: '7.1.4'
        }
    ] as const)('lays the $outputLayout output out in WAVE order over $channelCount channels', ({ channelCount, channels, floor, outputLayout }) => {
        expect(getCustomAudioOutputChannelLayout(outputLayout).channels).toEqual(channels);
        expect(getCustomAudioOutputChannelCount(outputLayout)).toBe(channelCount);
        expect(getCustomAudioOutputFloorLayout(outputLayout)).toBe(floor);
    });

    it.each([
        // Heights fold into the front and back pairs beneath them, each speaker at sqrt(1/2) of the pair it sums
        {
            expectedFrames: [ FOLDED_GAIN * (1 + 9), FOLDED_GAIN * (2 + 10), 3, 4, FOLDED_GAIN * (5 + 11), FOLDED_GAIN * (6 + 12), 7, 8 ],
            layout: CUSTOM_SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT,
            outputLayout: '7.1'
        },
        {
            expectedFrames: [ 1, 2, 3, 4, FOLDED_GAIN * (5 + 11), FOLDED_GAIN * (6 + 12), 7, 8, 9, 10 ],
            layout: CUSTOM_SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT,
            outputLayout: '7.1.2'
        },
        {
            expectedFrames: [ FOLDED_GAIN * (1 + 7), FOLDED_GAIN * (2 + 8), 3, 4, 5, 6 ],
            layout: CUSTOM_FIVE_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT,
            outputLayout: '5.1'
        },
        // A 5.1 surround sums the side, back, and top back channels at sqrt(1/3) each
        {
            expectedFrames: [
                FOLDED_GAIN * (1 + 9),
                FOLDED_GAIN * (2 + 10),
                3,
                4,
                Math.sqrt(1 / 3) * (5 + 7 + 11),
                Math.sqrt(1 / 3) * (6 + 8 + 12)
            ],
            layout: CUSTOM_SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT,
            outputLayout: '5.1'
        },
        // The top back pair of 5.1.4 folds into the 7.1.2 back pair, and the 7.1.2 sides stay silent
        {
            expectedFrames: [ 1, 2, 3, 4, FOLDED_GAIN * (5 + 9), FOLDED_GAIN * (6 + 10), 0, 0, 7, 8 ],
            layout: CUSTOM_FIVE_POINT_ONE_POINT_FOUR_CHANNEL_LAYOUT,
            outputLayout: '7.1.2'
        },
        // FFmpeg's E-AC-3 5.1(side) with heights folds its heights into the front pair of a 5.1 output, and lands on the 5.1.2 back pair and heights
        {
            expectedFrames: [ FOLDED_GAIN * (1 + 7), FOLDED_GAIN * (2 + 8), 3, 4, 5, 6 ],
            layout: CUSTOM_FIVE_POINT_ONE_SIDE_POINT_TWO_CHANNEL_LAYOUT,
            outputLayout: '5.1'
        },
        {
            expectedFrames: [ 1, 2, 3, 4, 5, 6, 7, 8 ],
            layout: CUSTOM_FIVE_POINT_ONE_SIDE_POINT_TWO_CHANNEL_LAYOUT,
            outputLayout: '5.1.2'
        },
        // A smaller layout plays to a height output on its own speakers, and the heights stay silent
        {
            expectedFrames: [ 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0 ],
            layout: CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
            outputLayout: '7.1.4'
        },
        {
            expectedFrames: [ 1, 2, 3, 4, 5, 6, 0, 0, 0, 0 ],
            layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
            outputLayout: '5.1.4'
        },
        {
            expectedFrames: [ 1, 2, 3, 4, 5, 6, 0, 0, 7, 8, 0, 0 ],
            layout: CUSTOM_FIVE_POINT_ONE_POINT_TWO_CHANNEL_LAYOUT,
            outputLayout: '7.1.4'
        }
    ] as const)('maps $layout.id to $outputLayout by channel name', ({ expectedFrames, layout, outputLayout }) => {
        const output = prepareCustomAudioOutputChannelData(createNumberedChannels(layout.channels.length), layout, outputLayout);

        expect(output).toHaveLength(expectedFrames.length);
        const outputFrames = getFirstFrames(output);
        for (let channelIndex = 0; channelIndex < expectedFrames.length; channelIndex += 1) {
            expect(outputFrames[channelIndex], `channel ${channelIndex}`).toBeCloseTo(expectedFrames[channelIndex], 5);
        }
    });

    it.each(HEIGHT_FOLD_CASES)('keeps the power of a signal common to every $layout.id channel on a $outputLayout output', ({ layout, outputLayout }) => {
        const channels = layout.channels.map(() => new Float32Array([ 0.25 ]));

        const output = prepareCustomAudioOutputChannelData(channels, layout, outputLayout);

        expect(output).toHaveLength(getCustomAudioOutputChannelCount(outputLayout));
        expect(getPower(output)).toBeCloseTo(getPower(channels), 6);
    });

    it.each(HEIGHT_FOLD_CASES)('limits $layout.id on a $outputLayout output only when a speaker sums channels', ({ layout, outputLayout }) => {
        const outputChannels = getCustomAudioOutputChannelLayout(outputLayout).channels;
        // A height without its speaker folds onto a floor speaker, and side and back pairs share a 5.1 floor's surround pair; a lone side pair takes a back pair alone
        const foldsHeight = layout.channels.some(channel => channel.startsWith('top-') && !outputChannels.includes(channel));
        const foldsSurroundPairs = layout.channels.includes('side-left')
            && layout.channels.includes('back-left')
            && !(outputChannels.includes('side-left') && outputChannels.includes('back-left'));

        expect(requiresCustomAudioFoldDown(layout, outputLayout)).toBe(foldsHeight || foldsSurroundPairs);
    });

    it.each(HEIGHT_LAYOUTS)('mixes $id to stereo as its folded floor through the selected matrix', layout => {
        const channels = createNumberedChannels(layout.channels.length);
        const floorOutput = layout.id.startsWith('7.1') ? '7.1' : '5.1';
        const floorLayout = getCustomAudioOutputChannelLayout(floorOutput);

        for (const algorithm of Object.values(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS)) {
            const stereo = prepareCustomAudioOutputChannelData(channels, layout, 'stereo', algorithm);
            const folded = prepareCustomAudioOutputChannelData(channels, layout, floorOutput);
            const expected = prepareCustomAudioOutputChannelData(folded, floorLayout, 'stereo', algorithm);

            expect(stereo, algorithm).toEqual(expected);
        }
        expect(requiresCustomAudioFoldDown(layout, 'stereo')).toBe(true);
    });
});
