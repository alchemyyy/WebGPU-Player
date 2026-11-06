import { describe, expect, it } from 'vitest';

import { copyAudioDataPlanes } from '../../src/capability/AudioDataPlanes';

type FakeAudio = Readonly<{
    audioData: AudioData
    copyFormats: (AudioSampleFormat | undefined)[]
}>;

const BYTES_PER_SAMPLE: Readonly<Record<string, number>> = { f32: 4, s16: 2, s32: 4, u8: 1 };

function writeSample(view: DataView, byteOffset: number, base: string, value: number): void {
    if (base === 'f32') {
        view.setFloat32(byteOffset, value, true);
    } else if (base === 's16') {
        view.setInt16(byteOffset, value, true);
    } else if (base === 's32') {
        view.setInt32(byteOffset, value, true);
    } else {
        view.setUint8(byteOffset, value);
    }
}

// Stores raw sample values channels[channel][frame] in the given format, as the browser would hold them
function createFakeAudioData(format: AudioSampleFormat | null, channels: readonly (readonly number[])[]): FakeAudio {
    const copyFormats: (AudioSampleFormat | undefined)[] = [];
    const numberOfFrames = channels[0].length;
    const numberOfChannels = channels.length;
    const audioData = {
        copyTo: (destination: AllowSharedBufferSource, options: AudioDataCopyToOptions): void => {
            copyFormats.push(options.format);
            if (format === null || options.format !== format) {
                throw new DOMException('Unsupported conversion', 'NotSupportedError');
            }
            const base = format.replace('-planar', '');
            const bytesPerSample = BYTES_PER_SAMPLE[base];
            const planar = format.endsWith('-planar');
            const view = new DataView((destination as Uint8Array).buffer);
            for (let frame = 0; frame < numberOfFrames; frame += 1) {
                if (planar) {
                    writeSample(view, frame * bytesPerSample, base, channels[options.planeIndex][frame]);
                    continue;
                }
                for (let channel = 0; channel < numberOfChannels; channel += 1) {
                    writeSample(view, ((frame * numberOfChannels) + channel) * bytesPerSample, base, channels[channel][frame]);
                }
            }
        },
        format,
        numberOfChannels,
        numberOfFrames
    } as unknown as AudioData;
    return { audioData, copyFormats };
}

function createChannels(channelCount: number, sample: (channel: number, frame: number) => number): number[][] {
    return Array.from({ length: channelCount }, (_, channel) => Array.from({ length: 4 }, (_frameValue, frame) => sample(channel, frame)));
}

describe('copyAudioDataPlanes', () => {
    it.each([ 6, 8 ])('deinterleaves %i-channel f32 output with one copy in its own format', channelCount => {
        const channels = createChannels(channelCount, (channel, frame) => (channel + 1) / 16 + frame / 256);
        const { audioData, copyFormats } = createFakeAudioData('f32', channels);

        const planes = copyAudioDataPlanes(audioData);

        expect(copyFormats).toEqual([ 'f32' ]);
        expect(planes?.map(plane => Array.from(plane))).toEqual(channels);
    });

    it('copies each f32-planar plane in its own format', () => {
        const channels = createChannels(3, (channel, frame) => (channel - frame) / 8);
        const { audioData, copyFormats } = createFakeAudioData('f32-planar', channels);

        expect(copyAudioDataPlanes(audioData)?.map(plane => Array.from(plane))).toEqual(channels);
        expect(copyFormats).toEqual([ 'f32-planar', 'f32-planar', 'f32-planar' ]);
    });

    it('converts interleaved s16 by its full scale', () => {
        const { audioData, copyFormats } = createFakeAudioData('s16', [ [ -32_768, 16_384 ], [ 0, -16_384 ] ]);

        expect(copyAudioDataPlanes(audioData)?.map(plane => Array.from(plane))).toEqual([ [ -1, 0.5 ], [ 0, -0.5 ] ]);
        expect(copyFormats).toEqual([ 's16' ]);
    });

    it('converts planar u8 around its zero offset', () => {
        const { audioData, copyFormats } = createFakeAudioData('u8-planar', [ [ 0, 128 ], [ 192, 64 ] ]);

        expect(copyAudioDataPlanes(audioData)?.map(plane => Array.from(plane))).toEqual([ [ -1, 0 ], [ 0.5, -0.5 ] ]);
        expect(copyFormats).toEqual([ 'u8-planar', 'u8-planar' ]);
    });

    it.each([ 's32', 's32-planar' ] as const)('converts %s by its full scale', format => {
        const { audioData, copyFormats } = createFakeAudioData(format, [ [ -2_147_483_648, 1_073_741_824 ] ]);

        expect(copyAudioDataPlanes(audioData)?.map(plane => Array.from(plane))).toEqual([ [ -1, 0.5 ] ]);
        expect(copyFormats).toEqual([ format ]);
    });

    it.each([ null, 'f64' ])('returns null without copying for format %s', format => {
        const { audioData, copyFormats } = createFakeAudioData(format as AudioSampleFormat | null, [ [ 0 ] ]);

        expect(copyAudioDataPlanes(audioData)).toBeNull();
        expect(copyFormats).toEqual([]);
    });

    it('returns null when a copy throws', () => {
        const audioData = {
            copyTo: (): void => {
                throw new DOMException('Copy failed', 'OperationError');
            },
            format: 'f32-planar',
            numberOfChannels: 2,
            numberOfFrames: 4
        } as unknown as AudioData;

        expect(copyAudioDataPlanes(audioData)).toBeNull();
    });
});
