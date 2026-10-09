import { describe, expect, it } from 'vitest';

import {
    AUDIO_DOWNMIX_SETTING_RANGES,
    createDefaultAudioDownmixSettings,
    downmixFivePointOneToStereo,
    downmixSixPointOneToStereo,
    downmixSevenPointOneToStereo,
    downmixThreeChannelToStereo,
    getStereoChannelDataFingerprint,
    type AudioDownmixSettings,
    type ThreeChannelDownmixSharedChannel
} from 'webgpu-player/audio/processing/CustomAudioDownmix';
import {
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS,
    type CustomAudioDownmixAlgorithm
} from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import type { AudioDownmixSettingsRamp } from 'webgpu-player/audio/processing/StreamingAudioDownmixSettings';

// Standard Lo/Ro gains shared by the 5.1 and 7.1 matrices
const STANDARD_DIRECT_GAIN = 1;
const STANDARD_MIXED_GAIN = Math.SQRT1_2;
// Published 5.1 gains that the three-channel weights derive from
const DAVE750_DIRECT_GAIN = 0.707;
const DAVE750_CENTER_GAIN = 0.5;
const DAVE750_LFE_GAIN = 0.5;
const DAVE750_SURROUND_GAIN = 0.707;
const NIGHT_MODE_DIRECT_GAIN = 0.3;
const NIGHT_MODE_CENTER_GAIN = 1;
const NIGHT_MODE_SURROUND_GAIN = 0.3;
const RFC7845_DIRECT_GAIN = 0.529067;
const RFC7845_CENTER_GAIN = 0.374107;
const RFC7845_LFE_GAIN = 0.374107;
const RFC7845_SURROUND_GAIN = 0.458186;
const RFC7845_OPPOSITE_SURROUND_GAIN = 0.264534;
// A back center reaches each output as both surrounds at sqrt(1/2)
const BACK_CENTER_SPLIT_GAIN = Math.SQRT1_2;
const FRONT_LEFT_CHANNEL_INDEX = 0;
const FRONT_RIGHT_CHANNEL_INDEX = 1;
const SHARED_CHANNEL_INDEX = 2;
const THREE_CHANNEL_COUNT = 3;
const THREE_CHANNEL_SHARED_CHANNELS: readonly ThreeChannelDownmixSharedChannel[] = [
    'front-center',
    'low-frequency-effects',
    'back-center'
];

type ThreeChannelWeights = Readonly<{
    direct: number
    shared: number
}>;

/** Scales the weights so the direct and shared weights sum to one. */
function normalizeWeights(direct: number, shared: number): ThreeChannelWeights {
    const weightSum = direct + shared;
    return { direct: direct / weightSum, shared: shared / weightSum };
}

const PEAK_NORMALIZED_FRONT_CENTER_WEIGHTS = normalizeWeights(
    STANDARD_DIRECT_GAIN,
    STANDARD_MIXED_GAIN
);
const PEAK_NORMALIZED_BACK_CENTER_WEIGHTS = normalizeWeights(
    STANDARD_DIRECT_GAIN,
    STANDARD_MIXED_GAIN * BACK_CENTER_SPLIT_GAIN
);
const RFC7845_FRONT_CENTER_WEIGHTS = normalizeWeights(RFC7845_DIRECT_GAIN, RFC7845_CENTER_GAIN);
const RFC7845_LFE_WEIGHTS = normalizeWeights(RFC7845_DIRECT_GAIN, RFC7845_LFE_GAIN);
const RFC7845_BACK_CENTER_WEIGHTS = normalizeWeights(
    RFC7845_DIRECT_GAIN,
    (RFC7845_SURROUND_GAIN + RFC7845_OPPOSITE_SURROUND_GAIN) * BACK_CENTER_SPLIT_GAIN
);

// Left-output weights of FL and the shared channel; the right output mirrors them with FR
const THREE_CHANNEL_WEIGHT_CASES: ReadonlyArray<Readonly<{
    algorithm: CustomAudioDownmixAlgorithm
    sharedChannel: ThreeChannelDownmixSharedChannel
    weights: ThreeChannelWeights
}>> = [
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO,
        sharedChannel: 'front-center',
        weights: { direct: STANDARD_DIRECT_GAIN, shared: STANDARD_MIXED_GAIN }
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO,
        sharedChannel: 'low-frequency-effects',
        weights: { direct: STANDARD_DIRECT_GAIN, shared: 0 }
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO,
        sharedChannel: 'back-center',
        weights: { direct: STANDARD_DIRECT_GAIN, shared: 0.5 }
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4,
        sharedChannel: 'front-center',
        weights: { direct: STANDARD_DIRECT_GAIN, shared: STANDARD_MIXED_GAIN }
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4,
        sharedChannel: 'low-frequency-effects',
        weights: { direct: STANDARD_DIRECT_GAIN, shared: 0 }
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4,
        sharedChannel: 'back-center',
        weights: { direct: STANDARD_DIRECT_GAIN, shared: 0.5 }
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750,
        sharedChannel: 'front-center',
        weights: { direct: DAVE750_DIRECT_GAIN, shared: DAVE750_CENTER_GAIN }
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750,
        sharedChannel: 'low-frequency-effects',
        weights: { direct: DAVE750_DIRECT_GAIN, shared: DAVE750_LFE_GAIN }
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750,
        sharedChannel: 'back-center',
        weights: {
            direct: DAVE750_DIRECT_GAIN,
            shared: DAVE750_SURROUND_GAIN * BACK_CENTER_SPLIT_GAIN
        }
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue,
        sharedChannel: 'front-center',
        weights: { direct: NIGHT_MODE_DIRECT_GAIN, shared: NIGHT_MODE_CENTER_GAIN }
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue,
        sharedChannel: 'low-frequency-effects',
        weights: { direct: NIGHT_MODE_DIRECT_GAIN, shared: 0 }
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue,
        sharedChannel: 'back-center',
        weights: {
            direct: NIGHT_MODE_DIRECT_GAIN,
            shared: NIGHT_MODE_SURROUND_GAIN * BACK_CENTER_SPLIT_GAIN
        }
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO,
        sharedChannel: 'front-center',
        weights: PEAK_NORMALIZED_FRONT_CENTER_WEIGHTS
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO,
        sharedChannel: 'low-frequency-effects',
        weights: { direct: 1, shared: 0 }
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO,
        sharedChannel: 'back-center',
        weights: PEAK_NORMALIZED_BACK_CENTER_WEIGHTS
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
        sharedChannel: 'front-center',
        weights: RFC7845_FRONT_CENTER_WEIGHTS
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
        sharedChannel: 'low-frequency-effects',
        weights: RFC7845_LFE_WEIGHTS
    },
    {
        algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
        sharedChannel: 'back-center',
        weights: RFC7845_BACK_CENTER_WEIGHTS
    }
];

function createConstantChannel(value: number, frameCount = 3): Float32Array {
    const channel = new Float32Array(frameCount);
    channel.fill(value);
    return channel;
}

/** Gives each channel one frame, holding one in the impulse channel and zero elsewhere. */
function createImpulseChannels(channelCount: number, impulseChannelIndex: number): Float32Array[] {
    const channelData: Float32Array[] = [];
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        channelData.push(createConstantChannel(channelIndex === impulseChannelIndex ? 1 : 0, 1));
    }
    return channelData;
}

/** Fills each channel with a distinct bounded pattern of sixteenths. */
function createPatternedChannels(channelCount: number, frameCount: number): Float32Array[] {
    const channelData: Float32Array[] = [];
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const channel = new Float32Array(frameCount);
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
            channel[frameIndex] = (((frameIndex + 1) * (channelIndex + 3)) % 31 - 15) / 16;
        }
        channelData.push(channel);
    }
    return channelData;
}

describe('downmixThreeChannelToStereo', () => {
    it.each(THREE_CHANNEL_WEIGHT_CASES)(
        'weights a $sharedChannel bed with the $algorithm matrix',
        ({ algorithm, sharedChannel, weights }) => {
            const [ frontLeftToLeft, frontLeftToRight ] = downmixThreeChannelToStereo(
                createImpulseChannels(THREE_CHANNEL_COUNT, FRONT_LEFT_CHANNEL_INDEX),
                sharedChannel,
                algorithm
            );
            const [ frontRightToLeft, frontRightToRight ] = downmixThreeChannelToStereo(
                createImpulseChannels(THREE_CHANNEL_COUNT, FRONT_RIGHT_CHANNEL_INDEX),
                sharedChannel,
                algorithm
            );
            const [ sharedToLeft, sharedToRight ] = downmixThreeChannelToStereo(
                createImpulseChannels(THREE_CHANNEL_COUNT, SHARED_CHANNEL_INDEX),
                sharedChannel,
                algorithm
            );

            expect(frontLeftToLeft[0]).toBeCloseTo(weights.direct, 6);
            expect(frontLeftToRight[0]).toBe(0);
            expect(frontRightToLeft[0]).toBe(0);
            expect(frontRightToRight[0]).toBeCloseTo(weights.direct, 6);
            expect(sharedToLeft[0]).toBeCloseTo(weights.shared, 6);
            expect(sharedToRight[0]).toBeCloseTo(weights.shared, 6);
        }
    );

    it.each([
        // opusfile mixes 3.0 to stereo with these same weights
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            direct: 0.5858,
            shared: 0.4142,
            sharedChannel: 'front-center'
        },
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            direct: 0.5858,
            shared: 0.4142,
            sharedChannel: 'low-frequency-effects'
        },
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            direct: 0.5087,
            shared: 0.4913,
            sharedChannel: 'back-center'
        },
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO,
            direct: 0.5858,
            shared: 0.4142,
            sharedChannel: 'front-center'
        },
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO,
            direct: 1,
            shared: 0,
            sharedChannel: 'low-frequency-effects'
        },
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO,
            direct: 0.6667,
            shared: 0.3333,
            sharedChannel: 'back-center'
        }
    ] as const)(
        'normalizes a $sharedChannel bed to $direct and $shared with the $algorithm matrix',
        ({ algorithm, direct, shared, sharedChannel }) => {
            const [ frontLeftToLeft ] = downmixThreeChannelToStereo(
                createImpulseChannels(THREE_CHANNEL_COUNT, FRONT_LEFT_CHANNEL_INDEX),
                sharedChannel,
                algorithm
            );
            const [ sharedToLeft ] = downmixThreeChannelToStereo(
                createImpulseChannels(THREE_CHANNEL_COUNT, SHARED_CHANNEL_INDEX),
                sharedChannel,
                algorithm
            );

            expect(frontLeftToLeft[0]).toBeCloseTo(direct, 4);
            expect(sharedToLeft[0]).toBeCloseTo(shared, 4);
        }
    );

    it.each([
        CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO,
        CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845
    ].flatMap(algorithm => THREE_CHANNEL_SHARED_CHANNELS.map(sharedChannel => ({
        algorithm,
        sharedChannel
    }))))(
        'keeps a correlated full-scale $sharedChannel bed at full scale with the $algorithm matrix',
        ({ algorithm, sharedChannel }) => {
            const [ outputLeft, outputRight ] = downmixThreeChannelToStereo(
                [ 1, 1, 1 ].map(value => createConstantChannel(value, 1)),
                sharedChannel,
                algorithm
            );

            expect(outputLeft[0]).toBeCloseTo(1, 6);
            expect(outputRight[0]).toBeCloseTo(1, 6);
        }
    );

    it.each([
        { sharedChannel: 'front-center', sharedLevel: 1.5, weights: RFC7845_FRONT_CENTER_WEIGHTS },
        { sharedChannel: 'back-center', sharedLevel: 0.5, weights: RFC7845_BACK_CENTER_WEIGHTS },
        // LFE follows neither level, as in the 5.1 matrices
        { sharedChannel: 'low-frequency-effects', sharedLevel: 1, weights: RFC7845_LFE_WEIGHTS }
    ] as const)(
        'scales a $sharedChannel shared channel by $sharedLevel when center is 1.5 and surround is 0.5',
        ({ sharedChannel, sharedLevel, weights }) => {
            const settings: AudioDownmixSettings = {
                centerLevel: 1.5,
                outputGain: 2,
                surroundLevel: 0.5,
                version: 1
            };

            const [ outputLeft, outputRight ] = downmixThreeChannelToStereo(
                [ 0.25, -0.5, 0.75 ].map(value => createConstantChannel(value, 1)),
                sharedChannel,
                CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
                settings
            );

            expect(outputLeft[0]).toBeCloseTo(
                (0.25 * weights.direct + 0.75 * weights.shared * sharedLevel) * settings.outputGain,
                6
            );
            expect(outputRight[0]).toBeCloseTo(
                (-0.5 * weights.direct + 0.75 * weights.shared * sharedLevel) * settings.outputGain,
                6
            );
        }
    );

    it.each([
        {
            expectedLevels: [ 0.25, 0.5, 0.75, 1, 1, 1 ],
            sharedChannel: 'front-center',
            weights: RFC7845_FRONT_CENTER_WEIGHTS
        },
        {
            expectedLevels: [ 1.25, 1, 0.75, 0.5, 0.5, 0.5 ],
            sharedChannel: 'back-center',
            weights: RFC7845_BACK_CENTER_WEIGHTS
        },
        {
            expectedLevels: [ 1, 1, 1, 1, 1, 1 ],
            sharedChannel: 'low-frequency-effects',
            weights: RFC7845_LFE_WEIGHTS
        }
    ] as const)(
        'ramps a $sharedChannel shared channel per frame onto the settings',
        ({ expectedLevels, sharedChannel, weights }) => {
            const settings: AudioDownmixSettings = {
                centerLevel: 1,
                outputGain: 2,
                surroundLevel: 0.5,
                version: 1
            };
            const settingsRamp: AudioDownmixSettingsRamp = {
                centerLevelStep: 0.25,
                frameCount: 4,
                initialCenterLevel: 0,
                initialOutputGain: 1,
                initialSurroundLevel: 1.5,
                outputGainStep: 0.25,
                surroundLevelStep: -0.25
            };
            // Ramp frames step from the initial gains, the last lands on the settings, and later frames hold them
            const expectedOutputGains = [ 1.25, 1.5, 1.75, 2, 2, 2 ];
            const frameCount = expectedOutputGains.length;

            const [ outputLeft, outputRight ] = downmixThreeChannelToStereo(
                [ 0, 0, 1 ].map(value => createConstantChannel(value, frameCount)),
                sharedChannel,
                CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
                settings,
                settingsRamp
            );

            for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
                const expectedSample = weights.shared * expectedLevels[frameIndex] * expectedOutputGains[frameIndex];
                expect(outputLeft[frameIndex]).toBeCloseTo(expectedSample, 6);
                expect(outputRight[frameIndex]).toBeCloseTo(expectedSample, 6);
            }
        }
    );

    it.each([
        CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO,
        CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4,
        CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750,
        CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue
    ])('keeps the exact %s output of 3.0 and 2.1 through the 5.1 matrix with silent channels', algorithm => {
        const frameCount = 64;
        const [ frontLeft, frontRight, shared ] = createPatternedChannels(
            THREE_CHANNEL_COUNT,
            frameCount
        );
        const silence = new Float32Array(frameCount);
        const settings: AudioDownmixSettings = {
            centerLevel: 1.25,
            outputGain: 0.8,
            surroundLevel: 1.5,
            version: 1
        };
        const settingsRamp: AudioDownmixSettingsRamp = {
            centerLevelStep: 0.046875,
            frameCount: 16,
            initialCenterLevel: 0.5,
            initialOutputGain: 1,
            initialSurroundLevel: 1,
            outputGainStep: -0.0125,
            surroundLevelStep: 0.03125
        };
        const threePointZero = [ frontLeft, frontRight, shared ];
        const threePointZeroAsFivePointOne = [ frontLeft, frontRight, shared, silence, silence, silence ];
        const twoPointOneAsFivePointOne = [ frontLeft, frontRight, silence, shared, silence, silence ];

        expect(downmixThreeChannelToStereo(threePointZero, 'front-center', algorithm)).toEqual(
            downmixFivePointOneToStereo(threePointZeroAsFivePointOne, algorithm)
        );
        expect(downmixThreeChannelToStereo(threePointZero, 'low-frequency-effects', algorithm)).toEqual(
            downmixFivePointOneToStereo(twoPointOneAsFivePointOne, algorithm)
        );
        expect(downmixThreeChannelToStereo(
            threePointZero,
            'front-center',
            algorithm,
            settings,
            settingsRamp
        )).toEqual(downmixFivePointOneToStereo(
            threePointZeroAsFivePointOne,
            algorithm,
            settings,
            settingsRamp
        ));
        expect(downmixThreeChannelToStereo(
            threePointZero,
            'low-frequency-effects',
            algorithm,
            settings,
            settingsRamp
        )).toEqual(downmixFivePointOneToStereo(
            twoPointOneAsFivePointOne,
            algorithm,
            settings,
            settingsRamp
        ));
    });

    it('rejects malformed planar input and out-of-range settings', () => {
        expect(() => downmixThreeChannelToStereo(
            [ createConstantChannel(0) ],
            'front-center'
        )).toThrow('Three-channel downmix requires exactly 3 input channels');
        expect(() => downmixThreeChannelToStereo(
            [ createConstantChannel(0), createConstantChannel(0), createConstantChannel(0, 2) ],
            'back-center'
        )).toThrow('Three-channel downmix requires equal-length input channels');
        expect(() => downmixThreeChannelToStereo(
            [ 0, 0, 0 ].map(value => createConstantChannel(value)),
            'back-center',
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO,
            {
                centerLevel: 1,
                outputGain: 1,
                surroundLevel: 2.01,
                version: 1
            }
        )).toThrow('Audio downmix surround level must be between zero and two');
    });
});

describe('downmixFivePointOneToStereo', () => {
    it('omits LFE and leaves correlated peaks for the streaming limiter', () => {
        const channelData = [
            createConstantChannel(1, 1),
            createConstantChannel(1, 1),
            createConstantChannel(1, 1),
            createConstantChannel(100, 1),
            createConstantChannel(1, 1),
            createConstantChannel(1, 1)
        ];

        const [ outputLeft, outputRight ] = downmixFivePointOneToStereo(channelData);

        const correlatedPeak = STANDARD_DIRECT_GAIN + 2 * STANDARD_MIXED_GAIN;
        expect(outputLeft[0]).toBeCloseTo(correlatedPeak, 6);
        expect(outputRight[0]).toBeCloseTo(correlatedPeak, 6);
        expect(Math.abs(outputLeft[0])).toBeGreaterThan(2);
        expect(Math.abs(outputRight[0])).toBeGreaterThan(2);
    });

    it('provides a bounded fixed-headroom Lo/Ro alternative', () => {
        const channelData = [ 1, 1, 1, 100, 1, 1 ].map(value => (
            createConstantChannel(value, 1)
        ));

        const [ outputLeft, outputRight ] = downmixFivePointOneToStereo(
            channelData,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO
        );

        expect(outputLeft[0]).toBeCloseTo(1, 6);
        expect(outputRight[0]).toBeCloseTo(1, 6);
    });

    it.each([
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4,
            expectedLeft: 1 + 3 * Math.SQRT1_2 + 5 * Math.SQRT1_2,
            expectedRight: 2 + 3 * Math.SQRT1_2 + 6 * Math.SQRT1_2
        },
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750,
            expectedLeft: 1 * 0.707 + 3 * 0.5 + 4 * 0.5 + 5 * 0.707,
            expectedRight: 2 * 0.707 + 3 * 0.5 + 4 * 0.5 + 6 * 0.707
        },
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue,
            expectedLeft: 1 * 0.3 + 3 + 5 * 0.3,
            expectedRight: 2 * 0.3 + 3 + 6 * 0.3
        },
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            expectedLeft: 1 * 0.529067 + 3 * 0.374107 + 4 * 0.374107
                + 5 * 0.458186 + 6 * 0.264534,
            expectedRight: 2 * 0.529067 + 3 * 0.374107 + 4 * 0.374107
                + 6 * 0.458186 + 5 * 0.264534
        }
    ])('applies the $algorithm 5.1 matrix', ({
        algorithm,
        expectedLeft,
        expectedRight
    }) => {
        const channelData = [ 1, 2, 3, 4, 5, 6 ].map(value => (
            createConstantChannel(value, 1)
        ));

        const [ outputLeft, outputRight ] = downmixFivePointOneToStereo(
            channelData,
            algorithm
        );

        expect(outputLeft[0]).toBeCloseTo(expectedLeft, 6);
        expect(outputRight[0]).toBeCloseTo(expectedRight, 6);
    });

    it('does not mutate input planes', () => {
        const channelData = [ 1, 2, 3, 4, 5, 6 ].map(value => (
            createConstantChannel(value)
        ));
        const snapshots = channelData.map(channel => new Float32Array(channel));

        downmixFivePointOneToStereo(channelData);

        for (let channelIndex = 0; channelIndex < channelData.length; channelIndex += 1) {
            expect(channelData[channelIndex]).toEqual(snapshots[channelIndex]);
        }
    });

    it('rejects invalid planar input', () => {
        expect(() => downmixFivePointOneToStereo([
            createConstantChannel(0)
        ])).toThrow('5.1 downmix requires exactly 6 input channels');
        expect(() => downmixFivePointOneToStereo([
            createConstantChannel(0),
            createConstantChannel(0),
            createConstantChannel(0),
            createConstantChannel(0),
            createConstantChannel(0),
            createConstantChannel(0, 2)
        ])).toThrow('5.1 downmix requires equal-length input channels');
    });
});

describe('downmixSixPointOneToStereo', () => {
    it('rejects malformed planar input', () => {
        expect(() => downmixSixPointOneToStereo([
            createConstantChannel(0)
        ])).toThrow('6.1 downmix requires exactly 7 input channels');
    });
});

describe('downmixSevenPointOneToStereo', () => {
    it('exposes bounded boost ranges for user controls', () => {
        expect(AUDIO_DOWNMIX_SETTING_RANGES).toMatchObject({
            centerLevel: { maximum: 2, minimum: 0, step: 0.01 },
            outputGain: { maximum: 10, minimum: 0, step: 0.01 },
            surroundLevel: { maximum: 2, minimum: 0, step: 0.01 }
        });
    });

    it('omits LFE and leaves correlated peaks for the streaming limiter', () => {
        const channelData: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < 8; channelIndex += 1) {
            channelData.push(createConstantChannel(channelIndex === 3 ? 100 : 1, 1));
        }

        const [ outputLeft, outputRight ] = downmixSevenPointOneToStereo(channelData);

        const correlatedPeak = STANDARD_DIRECT_GAIN + 3 * STANDARD_MIXED_GAIN;
        expect(outputLeft[0]).toBeCloseTo(correlatedPeak, 6);
        expect(outputRight[0]).toBeCloseTo(correlatedPeak, 6);
        expect(Math.abs(outputLeft[0])).toBeGreaterThan(3);
        expect(Math.abs(outputRight[0])).toBeGreaterThan(3);
        expect(Number.isFinite(outputLeft[0])).toBe(true);
        expect(Number.isFinite(outputRight[0])).toBe(true);
    });

    it('maps isolated WAVE-order impulses to the default mpv coefficients', () => {
        const expectedLeft = [
            STANDARD_DIRECT_GAIN,
            0,
            STANDARD_MIXED_GAIN,
            0,
            STANDARD_MIXED_GAIN,
            0,
            STANDARD_MIXED_GAIN,
            0
        ];
        const expectedRight = [
            0,
            STANDARD_DIRECT_GAIN,
            STANDARD_MIXED_GAIN,
            0,
            0,
            STANDARD_MIXED_GAIN,
            0,
            STANDARD_MIXED_GAIN
        ];
        for (let inputChannelIndex = 0; inputChannelIndex < 8; inputChannelIndex += 1) {
            const channelData: Float32Array[] = [];
            for (let channelIndex = 0; channelIndex < 8; channelIndex += 1) {
                channelData.push(createConstantChannel(
                    channelIndex === inputChannelIndex ? 1 : 0,
                    1
                ));
            }

            const [ outputLeft, outputRight ] = downmixSevenPointOneToStereo(channelData);

            expect(outputLeft[0]).toBeCloseTo(expectedLeft[inputChannelIndex], 7);
            expect(outputRight[0]).toBeCloseTo(expectedRight[inputChannelIndex], 7);
        }
    });

    it.each([
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4,
            expectedLeft: 1 + 3 * Math.SQRT1_2 + 5 * 0.5 + 7 * 0.5,
            expectedRight: 2 + 3 * Math.SQRT1_2 + 6 * 0.5 + 8 * 0.5
        },
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750,
            expectedLeft: 1 * 0.707 + 3 * 0.5 + 4 * 0.5 + 5 * 0.5 + 7 * 0.5,
            expectedRight: 2 * 0.707 + 3 * 0.5 + 4 * 0.5 + 6 * 0.5 + 8 * 0.5
        },
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue,
            expectedLeft: 1 * 0.3 + 3 + 5 * 0.3 * Math.SQRT1_2
                + 7 * 0.3 * Math.SQRT1_2,
            expectedRight: 2 * 0.3 + 3 + 6 * 0.3 * Math.SQRT1_2
                + 8 * 0.3 * Math.SQRT1_2
        },
        {
            algorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            expectedLeft: 1 * 0.388631 + 3 * 0.274804 + 4 * 0.274804
                + 5 * 0.336565 + 6 * 0.194316
                + 7 * 0.336565 + 8 * 0.194316,
            expectedRight: 2 * 0.388631 + 3 * 0.274804 + 4 * 0.274804
                + 6 * 0.336565 + 5 * 0.194316
                + 8 * 0.336565 + 7 * 0.194316
        }
    ])('applies the $algorithm 7.1 matrix', ({
        algorithm,
        expectedLeft,
        expectedRight
    }) => {
        const channelData = [ 1, 2, 3, 4, 5, 6, 7, 8 ].map(value => (
            createConstantChannel(value, 1)
        ));

        const [ outputLeft, outputRight ] = downmixSevenPointOneToStereo(
            channelData,
            algorithm
        );

        expect(outputLeft[0]).toBeCloseTo(expectedLeft, 6);
        expect(outputRight[0]).toBeCloseTo(expectedRight, 6);
    });

    it('preserves the exact qualified output with explicit defaults', () => {
        const channelData = [ 1, 2, 3, 40, 5, 6, 7, 8 ].map(value => (
            createConstantChannel(value, 4)
        ));

        expect(downmixSevenPointOneToStereo(
            channelData,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO,
            createDefaultAudioDownmixSettings()
        )).toEqual(downmixSevenPointOneToStereo(channelData));
    });

    it('applies independent center, surround, and output amplification', () => {
        const channelData = [ 1, 0, 1, 100, 1, 0, 1, 0 ].map(value => (
            createConstantChannel(value, 1)
        ));
        const [ outputLeft ] = downmixSevenPointOneToStereo(
            channelData,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO,
            {
                centerLevel: 1.5,
                outputGain: 3,
                surroundLevel: 2,
                version: 1
            }
        );

        expect(outputLeft[0]).toBeCloseTo((
            STANDARD_DIRECT_GAIN
            + 1.5 * STANDARD_MIXED_GAIN
            + 4 * STANDARD_MIXED_GAIN
        ) * 3, 6);
        expect(outputLeft[0]).toBeGreaterThan(1);
    });

    it('rejects settings above the supported boost ranges', () => {
        const channelData = Array.from({ length: 8 }, (): Float32Array => (
            createConstantChannel(0, 1)
        ));

        expect(() => downmixSevenPointOneToStereo(
            channelData,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO,
            {
                centerLevel: 1,
                outputGain: 10.01,
                surroundLevel: 1,
                version: 1
            }
        )).toThrow('Audio downmix output gain must be between zero and ten');
        expect(() => downmixSevenPointOneToStereo(
            channelData,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO,
            {
                centerLevel: 2.01,
                outputGain: 1,
                surroundLevel: 1,
                version: 1
            }
        )).toThrow('Audio downmix center level must be between zero and two');
        expect(() => downmixSevenPointOneToStereo(
            channelData,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO,
            {
                centerLevel: 1,
                outputGain: 1,
                surroundLevel: 2.01,
                version: 1
            }
        )).toThrow('Audio downmix surround level must be between zero and two');
    });

    it('is sample-exact across arbitrary input chunk boundaries', () => {
        const frameCount = 257;
        const channelData: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < 8; channelIndex += 1) {
            const channel = new Float32Array(frameCount);
            for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
                channel[frameIndex] = (
                    ((frameIndex + 1) * (channelIndex + 3)) % 31 - 15
                ) / 16;
            }
            channelData.push(channel);
        }
        const contiguous = downmixSevenPointOneToStereo(channelData);
        const splitLeft = new Float32Array(frameCount);
        const splitRight = new Float32Array(frameCount);
        const chunkFrameCounts = [ 1, 17, 3, 64, 5, 91, 76 ];
        let frameOffset = 0;
        for (const chunkFrameCount of chunkFrameCounts) {
            const chunkChannels: Float32Array[] = [];
            for (const channel of channelData) {
                chunkChannels.push(channel.slice(
                    frameOffset,
                    frameOffset + chunkFrameCount
                ));
            }
            const chunkOutput = downmixSevenPointOneToStereo(chunkChannels);
            splitLeft.set(chunkOutput[0], frameOffset);
            splitRight.set(chunkOutput[1], frameOffset);
            frameOffset += chunkFrameCount;
        }

        expect(frameOffset).toBe(frameCount);
        expect(splitLeft).toEqual(contiguous[0]);
        expect(splitRight).toEqual(contiguous[1]);
        expect(getStereoChannelDataFingerprint([ splitLeft, splitRight ])).toBe(
            getStereoChannelDataFingerprint(contiguous)
        );
    });

    it('rejects malformed planar input', () => {
        expect(() => downmixSevenPointOneToStereo([
            createConstantChannel(0)
        ])).toThrow('7.1 downmix requires exactly 8 input channels');
        const unequalChannels = [ 1, 2, 3, 4, 5, 6, 7 ].map(value => (
            createConstantChannel(value)
        ));
        unequalChannels.push(createConstantChannel(8, 2));
        expect(() => downmixSevenPointOneToStereo(unequalChannels)).toThrow(
            '7.1 downmix requires equal-length input channels'
        );
    });
});
