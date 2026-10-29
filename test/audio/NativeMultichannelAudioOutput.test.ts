import { describe, expect, it } from 'vitest';

import {
    configureCustomAudioDestination,
    isCustomAudioSpeakerLayout,
    selectCustomAudioOutputLayout,
    selectCustomAudioSpeakerLayout
} from 'webgpu-player/audio/NativeMultichannelAudioOutput';
import type { CustomAudioOutputLayout } from 'webgpu-player/audio/processing/CustomAudioChannelLayout';

type FakeDestination = {
    channelCount: number
    maxChannelCount: number
};

function createAudioContext(maxChannelCount: number): AudioContext {
    return {
        destination: {
            channelCount: 2,
            maxChannelCount
        } as AudioDestinationNode
    } as AudioContext;
}

/** The output a source takes on a destination of a channel count with the `auto` speaker layout, as the floor rule chooses it. */
function selectAutomaticFloorOutput(maximumChannelCount: number | null, sourceChannelCount: number | null): CustomAudioOutputLayout {
    return selectCustomAudioOutputLayout(selectCustomAudioSpeakerLayout('auto', maximumChannelCount), sourceChannelCount, false);
}

describe('native multichannel audio output', () => {
    it.each([
        { expected: 'stereo', maximum: null },
        { expected: 'stereo', maximum: 1 },
        { expected: 'stereo', maximum: 5 },
        { expected: '5.1', maximum: 6 },
        { expected: '5.1', maximum: 7 },
        { expected: '7.1', maximum: 8 },
        { expected: '7.1', maximum: 9 },
        { expected: '7.1.2', maximum: 10 },
        { expected: '7.1.2', maximum: 11 },
        { expected: '7.1.4', maximum: 12 },
        { expected: '7.1.4', maximum: 32 }
    ] as const)('resolves the auto speaker layout to $expected on a destination of $maximum channels', ({ expected, maximum }) => {
        expect(selectCustomAudioSpeakerLayout('auto', maximum)).toBe(expected);
    });

    it.each([
        // An explicit layout plays when the destination has its channels, which 5.1.2 and 5.1.4 need to be chosen at all
        { expected: '5.1.2', maximum: 8, speakerLayout: '5.1.2' },
        { expected: '5.1.4', maximum: 12, speakerLayout: '5.1.4' },
        { expected: 'stereo', maximum: 12, speakerLayout: 'stereo' },
        { expected: '5.1', maximum: 12, speakerLayout: '5.1' },
        { expected: '7.1.2', maximum: 12, speakerLayout: '7.1.2' },
        // A destination too small for it resolves as auto does
        { expected: '7.1', maximum: 8, speakerLayout: '7.1.4' },
        { expected: '7.1', maximum: 8, speakerLayout: '5.1.4' },
        { expected: '5.1', maximum: 6, speakerLayout: '5.1.2' },
        { expected: 'stereo', maximum: 2, speakerLayout: '7.1' },
        { expected: 'stereo', maximum: null, speakerLayout: '5.1' }
    ] as const)('resolves the $speakerLayout speaker layout to $expected on a destination of $maximum channels', ({
        expected,
        maximum,
        speakerLayout
    }) => {
        expect(selectCustomAudioSpeakerLayout(speakerLayout, maximum)).toBe(expected);
    });

    it('recognizes the speaker layout settings', () => {
        for (const speakerLayout of [ 'auto', 'stereo', '5.1', '7.1', '5.1.2', '5.1.4', '7.1.2', '7.1.4' ]) {
            expect(isCustomAudioSpeakerLayout(speakerLayout), speakerLayout).toBe(true);
        }
        for (const speakerLayout of [ '6.1', '9.1.6', 'Auto', 8, null, undefined ]) {
            expect(isCustomAudioSpeakerLayout(speakerLayout), String(speakerLayout)).toBe(false);
        }
    });

    it.each([
        // An unknown sink mixes every source to stereo
        { expected: 'stereo', maximum: null, source: 3 },
        { expected: 'stereo', maximum: null, source: 6 },
        { expected: 'stereo', maximum: null, source: 7 },
        { expected: 'stereo', maximum: null, source: 8 },
        // Three-channel, 5.0, and 5.1 sources use a 5.1 sink
        { expected: 'stereo', maximum: 2, source: 3 },
        { expected: 'stereo', maximum: 5, source: 3 },
        { expected: '5.1', maximum: 6, source: 3 },
        { expected: '5.1', maximum: 8, source: 3 },
        { expected: 'stereo', maximum: 5, source: 5 },
        { expected: '5.1', maximum: 6, source: 5 },
        { expected: '5.1', maximum: 8, source: 5 },
        { expected: 'stereo', maximum: 5, source: 6 },
        { expected: '5.1', maximum: 6, source: 6 },
        { expected: '5.1', maximum: 8, source: 6 },
        { expected: '5.1', maximum: 12, source: 6 },
        // 6.1 and 7.1 sources use a 7.1 sink or fold into a 5.1 one, and stay on the floor of a height destination
        { expected: 'stereo', maximum: 5, source: 7 },
        { expected: '5.1', maximum: 6, source: 7 },
        { expected: '5.1', maximum: 7, source: 7 },
        { expected: '7.1', maximum: 8, source: 7 },
        { expected: 'stereo', maximum: 2, source: 8 },
        { expected: 'stereo', maximum: 5, source: 8 },
        { expected: '5.1', maximum: 6, source: 8 },
        { expected: '5.1', maximum: 7, source: 8 },
        { expected: '7.1', maximum: 8, source: 8 },
        { expected: '7.1', maximum: 10, source: 8 },
        { expected: '7.1', maximum: 32, source: 8 },
        // Every other source mixes to stereo
        { expected: 'stereo', maximum: 8, source: 1 },
        { expected: 'stereo', maximum: 8, source: 2 },
        { expected: 'stereo', maximum: 8, source: 4 },
        { expected: 'stereo', maximum: 12, source: 12 },
        { expected: 'stereo', maximum: 8, source: null }
    ] as const)('plays a $source-channel source on a $maximum-channel destination to $expected', ({
        expected,
        maximum,
        source
    }) => {
        expect(selectAutomaticFloorOutput(maximum, source)).toBe(expected);
    });

    it.each([
        { expected: '5.1', source: 6, speakerLayout: '7.1.4' },
        { expected: '5.1', source: 8, speakerLayout: '5.1.4' },
        { expected: '5.1', source: 8, speakerLayout: '5.1.2' },
        { expected: '7.1', source: 8, speakerLayout: '7.1.2' }
    ] as const)('keeps a $source-channel source within the floor of a $speakerLayout layout', ({ expected, source, speakerLayout }) => {
        expect(selectCustomAudioOutputLayout(speakerLayout, source, false)).toBe(expected);
    });

    it.each([ 'stereo', '5.1', '7.1', '5.1.2', '5.1.4', '7.1.2', '7.1.4' ] as const)(
        'plays a source a package renders as objects to the whole %s layout',
        speakerLayout => {
            for (const source of [ 6, 8, null ]) {
                expect(selectCustomAudioOutputLayout(speakerLayout, source, true)).toBe(speakerLayout);
            }
        }
    );

    it.each([ 8, 10, 12 ])('configures an exact %i-channel destination', channelCount => {
        const audioContext = createAudioContext(12);

        configureCustomAudioDestination(audioContext, channelCount);

        expect(audioContext.destination.channelCount).toBe(channelCount);
    });

    it('rejects a requested layout larger than the physical destination', () => {
        expect(() => configureCustomAudioDestination(
            createAudioContext(6),
            8
        )).toThrow('Audio destination exposes 6 channels, not 8');
    });

    it('rejects a destination that ignores channel-count configuration', () => {
        const destination: FakeDestination = {
            channelCount: 2,
            maxChannelCount: 6
        };
        Object.defineProperty(destination, 'channelCount', {
            configurable: true,
            get: (): number => 2,
            set: (): void => undefined
        });
        const audioContext = { destination } as unknown as AudioContext;

        expect(() => configureCustomAudioDestination(
            audioContext,
            6
        )).toThrow('The browser did not apply the requested audio destination channel count');
    });
});
