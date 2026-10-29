// @vitest-environment node
// The output checks on constructed blocks; each audio decoder project's tests decode with its own package

import { describe, expect, it } from 'vitest';

import type { AudioDecoderPackageBlock } from 'webgpu-player/decode/audio/AudioDecoderPackageInstance';
import {
    createPackageAudioOutput,
    PACKAGE_AUDIO_MAXIMUM_BLOCK_FRAME_COUNT
} from 'webgpu-player/decode/audio/PackageSoftwareAudioDecoder';
import {
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_STEREO
} from 'webgpu-player/audio/processing/CustomWaveChannelLayout';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

const SUBJECT = 'Audio decoder Test';
const SAMPLE_RATE = 48_000;
const CD_SAMPLE_RATE = 44_100;
const FRACTIONAL_SAMPLE_RATE = 44_100.5;
const NEGATIVE_SAMPLE_RATE = -SAMPLE_RATE;
const ZERO_SAMPLE_RATE = 0;
const STEREO_CHANNEL_COUNT = 2;
const SEVEN_POINT_ONE_CHANNEL_COUNT = 8;
const FRAME_COUNT = 4;
const PACKET_TIME_MICROSECONDS = requireMicroseconds(1_000_000);
const BLOCK_TIME_MICROSECONDS = 2_000_000;
const FRACTIONAL_TIMESTAMP_MICROSECONDS = 0.5;
// Earlier frames of a packet, and where a block after them starts: 48 frames at 48 kHz last 1 ms, and 40 last 833.3 us
const PRECEDING_FRAME_COUNTS_AND_OFFSETS: readonly (readonly [ number, number, number ])[] = [
    [ 0, SAMPLE_RATE, 0 ],
    [ 48, SAMPLE_RATE, 1_000 ],
    [ 40, SAMPLE_RATE, 833 ],
    [ 441, CD_SAMPLE_RATE, 10_000 ]
];
// The 7.1 wide mask, which no output route qualifies
const SEVEN_POINT_ONE_WIDE_CHANNEL_MASK = 0x06cf;
const NO_CHANNEL_MASK = 0;
const STEREO_LAYOUT_ID = 'stereo';

function createPlanes(channelCount: number, frameCount: number = FRAME_COUNT): Float32Array[] {
    return Array.from({ length: channelCount }, (): Float32Array => new Float32Array(frameCount));
}

function createBlock(overrides: Partial<AudioDecoderPackageBlock> = {}): AudioDecoderPackageBlock {
    const channelData = overrides.channelData ?? createPlanes(STEREO_CHANNEL_COUNT);
    return {
        attributes: new Map(),
        channelData,
        channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO,
        frameCount: channelData[0]?.length ?? 0,
        sampleRate: SAMPLE_RATE,
        timestampMicroseconds: null,
        ...overrides
    };
}

describe('createPackageAudioOutput', () => {
    it('keeps a block\'s object count within the bound the page\'s messages take, and fails the block past it', () => {
        const objectCounts = [ 0, 10, 1_024 ];
        for (const objectCount of objectCounts) {
            const block = createBlock({ attributes: new Map([ [ 'objectCount', objectCount ] ]) });
            expect(createPackageAudioOutput(block, PACKET_TIME_MICROSECONDS, 0, SUBJECT).objectCount).toBe(objectCount);
        }
        expect(createPackageAudioOutput(createBlock(), PACKET_TIME_MICROSECONDS, 0, SUBJECT).objectCount).toBeNull();
        for (const objectCount of [ 1_025, 2_000, -1, 1.5 ]) {
            const block = createBlock({ attributes: new Map([ [ 'objectCount', objectCount ] ]) });
            expect(() => createPackageAudioOutput(block, PACKET_TIME_MICROSECONDS, 0, SUBJECT), String(objectCount))
                .toThrow(`${SUBJECT} object count ${objectCount} is invalid`);
        }
    });

    it('keeps a block\'s planes and its own timestamp, in the layout its mask qualifies', () => {
        const block = createBlock({ timestampMicroseconds: BLOCK_TIME_MICROSECONDS });

        const output = createPackageAudioOutput(block, PACKET_TIME_MICROSECONDS, FRAME_COUNT, SUBJECT);

        expect(output).toMatchObject({
            channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO,
            frameCount: FRAME_COUNT,
            mediaTimeMicroseconds: BLOCK_TIME_MICROSECONDS,
            sampleRate: SAMPLE_RATE
        });
        expect(output.channelLayout.id).toBe(STEREO_LAYOUT_ID);
        expect(output.channelData).toBe(block.channelData);
    });

    it.each(PRECEDING_FRAME_COUNTS_AND_OFFSETS)(
        'starts a block without a timestamp after %i earlier frames of its packet at %i Hz, %i us after the packet',
        (precedingFrameCount, sampleRate, offsetMicroseconds) => {
            const output = createPackageAudioOutput(createBlock({ sampleRate }), PACKET_TIME_MICROSECONDS, precedingFrameCount, SUBJECT);

            expect(output.mediaTimeMicroseconds).toBe(PACKET_TIME_MICROSECONDS + offsetMicroseconds);
        }
    );

    it('accepts the most frames a block holds, and refuses one more', () => {
        const largestBlock = createBlock({ channelData: createPlanes(STEREO_CHANNEL_COUNT, PACKAGE_AUDIO_MAXIMUM_BLOCK_FRAME_COUNT) });
        const oversizedBlock = createBlock({ channelData: createPlanes(STEREO_CHANNEL_COUNT, PACKAGE_AUDIO_MAXIMUM_BLOCK_FRAME_COUNT + 1) });

        expect(createPackageAudioOutput(largestBlock, PACKET_TIME_MICROSECONDS, 0, SUBJECT).frameCount).toBe(PACKAGE_AUDIO_MAXIMUM_BLOCK_FRAME_COUNT);
        expect(() => createPackageAudioOutput(oversizedBlock, PACKET_TIME_MICROSECONDS, 0, SUBJECT))
            .toThrow(new RangeError(`${SUBJECT} output frame count is invalid`));
    });

    it.each([ ZERO_SAMPLE_RATE, FRACTIONAL_SAMPLE_RATE, NEGATIVE_SAMPLE_RATE ])('refuses the rate %d', (sampleRate) => {
        expect(() => createPackageAudioOutput(createBlock({ sampleRate }), PACKET_TIME_MICROSECONDS, 0, SUBJECT))
            .toThrow(new RangeError(`${SUBJECT} output sample rate ${sampleRate} Hz is invalid`));
    });

    it.each([
        [ SEVEN_POINT_ONE_WIDE_CHANNEL_MASK, SEVEN_POINT_ONE_CHANNEL_COUNT, '6cf' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE, STEREO_CHANNEL_COUNT, '63f' ],
        [ NO_CHANNEL_MASK, STEREO_CHANNEL_COUNT, '0' ]
    ])('refuses the mask %d over %i planes, which no output route qualifies for them', (channelMask, channelCount, hexadecimalMask) => {
        const block = createBlock({ channelData: createPlanes(channelCount), channelMask });

        expect(() => createPackageAudioOutput(block, PACKET_TIME_MICROSECONDS, 0, SUBJECT))
            .toThrow(new RangeError(`${SUBJECT} channel mask 0x${hexadecimalMask} is unqualified`));
    });

    it('refuses a block timestamp that is no whole microsecond', () => {
        const block = createBlock({ timestampMicroseconds: FRACTIONAL_TIMESTAMP_MICROSECONDS });

        expect(() => createPackageAudioOutput(block, PACKET_TIME_MICROSECONDS, 0, SUBJECT))
            .toThrow(new RangeError(`${SUBJECT} decoded timestamp must be a safe integer number of microseconds`));
    });
});
