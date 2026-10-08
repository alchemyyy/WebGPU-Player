import { describe, expect, it } from 'vitest';

import type { FFmpegEAC3Module } from '#wasm/ffmpeg-eac3/ffmpeg-eac3.mjs';
import {
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
    CUSTOM_WAVE_CHANNEL_MASK_MONO,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_STEREO,
    CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO
} from 'webgpu-player/audio/processing/CustomWaveChannelLayout';
import EAC3SoftwareAudioDecoder, {
    type EAC3DecoderModuleFactory
} from 'webgpu-player/audio/decoders/EAC3SoftwareAudioDecoder';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

const DECODER_POINTER = 64;
const PACKET_POINTER = 128;
const FIRST_PLANE_POINTER = 1_024;
const PLANE_BYTE_STRIDE = 256;
const LIBAVCODEC_VERSION = 4_064_612;
const EAC3_AV_SAMPLE_FORMAT_F32_PLANAR = 8;
const EAC3_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_WIDE = 0x06cf;
// AV_NOPTS_VALUE as the bridge returns it, a double far outside the safe integer range
const FFMPEG_NO_PRESENTATION_TIMESTAMP = -(2 ** 63);
const DEFAULT_PRESENTATION_TIMESTAMP = 1_250_000;

type FakeDecoderOptions = Readonly<{
    channelCount?: number
    channelMask?: number
    presentationTimestamps?: readonly number[]
    receiveStatuses?: readonly number[]
    sampleCount?: number
    sampleFormat?: number
    sampleRate?: number
    sendStatus?: number
}>;

type FakeEAC3Decoder = Readonly<{
    clearCalls: number[]
    destroyCalls: number[]
    moduleFactory: EAC3DecoderModuleFactory
}>;

function createFakeEAC3Decoder(
    options: FakeDecoderOptions = {}
): FakeEAC3Decoder {
    const memory = new ArrayBuffer(65_536);
    const heapF32 = new Float32Array(memory);
    const heapU8 = new Uint8Array(memory);
    const clearCalls: number[] = [];
    const destroyCalls: number[] = [];
    const channelCount = options.channelCount ?? 8;
    const receiveStatuses = [ ...(options.receiveStatuses ?? [ 1, 0 ]) ];
    const presentationTimestamps = [ ...(options.presentationTimestamps ?? []) ];
    const functions = new Map<string, (...arguments_: number[]) => number | void>([
        [ 'jellyfin_eac3_clear', (decoder: number): void => {
            clearCalls.push(decoder);
        } ],
        [ 'jellyfin_eac3_configure_packet', (): number => PACKET_POINTER ],
        [ 'jellyfin_eac3_create', (): number => DECODER_POINTER ],
        [ 'jellyfin_eac3_destroy', (decoder: number): void => {
            destroyCalls.push(decoder);
        } ],
        [ 'jellyfin_eac3_get_channel_count', (): number => channelCount ],
        [ 'jellyfin_eac3_get_channel_mask', (): number =>
            options.channelMask ?? CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE ],
        [ 'jellyfin_eac3_get_plane', (_decoder: number, channelIndex: number): number =>
            FIRST_PLANE_POINTER + channelIndex * PLANE_BYTE_STRIDE ],
        [ 'jellyfin_eac3_get_pts', (): number =>
            presentationTimestamps.shift() ?? DEFAULT_PRESENTATION_TIMESTAMP ],
        [ 'jellyfin_eac3_get_sample_count', (): number => options.sampleCount ?? 2 ],
        [ 'jellyfin_eac3_get_sample_format', (): number =>
            options.sampleFormat ?? EAC3_AV_SAMPLE_FORMAT_F32_PLANAR ],
        [ 'jellyfin_eac3_get_sample_rate', (): number => options.sampleRate ?? 48_000 ],
        [ 'jellyfin_eac3_library_version', (): number => LIBAVCODEC_VERSION ],
        [ 'jellyfin_eac3_receive_frame', (): number => receiveStatuses.shift() ?? 0 ],
        [ 'jellyfin_eac3_send_packet', (): number => options.sendStatus ?? 1 ]
    ]);
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const firstSampleIndex = (
            FIRST_PLANE_POINTER + channelIndex * PLANE_BYTE_STRIDE
        ) / Float32Array.BYTES_PER_ELEMENT;
        heapF32.set([ channelIndex + 0.25, -(channelIndex + 0.5) ], firstSampleIndex);
    }
    const module: FFmpegEAC3Module = {
        HEAPF32: heapF32,
        HEAPU8: heapU8,
        cwrap: (name: string) => {
            const functionValue = functions.get(name);
            if (!functionValue) {
                throw new Error(`Unexpected export ${name}`);
            }
            return functionValue;
        }
    };
    return {
        clearCalls,
        destroyCalls,
        moduleFactory: async (): Promise<FFmpegEAC3Module> => module
    };
}

describe('EAC3SoftwareAudioDecoder', () => {
    it('preserves standard 7.1 FFmpeg plane order using its native channel mask', async () => {
        const fakeDecoder = createFakeEAC3Decoder();
        const decoder = await EAC3SoftwareAudioDecoder.create(fakeDecoder.moduleFactory);
        const packet = new Uint8Array([ 1, 2, 3, 4 ]);

        const outputs = decoder.decode(
            packet,
            requireMicroseconds(1_000_000, 'Test packet timestamp')
        );

        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatchObject({
            channelMask: CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
            frameCount: 2,
            mediaTimeMicroseconds: 1_250_000,
            sampleRate: 48_000
        });
        expect(outputs[0].channelLayout.channels).toEqual([
            'front-left',
            'front-right',
            'front-center',
            'low-frequency-effects',
            'back-left',
            'back-right',
            'side-left',
            'side-right'
        ]);
        expect(outputs[0].channelData.map(channel => Array.from(channel))).toEqual([
            [ 0.25, -0.5 ],
            [ 1.25, -1.5 ],
            [ 2.25, -2.5 ],
            [ 3.25, -3.5 ],
            [ 4.25, -4.5 ],
            [ 5.25, -5.5 ],
            [ 6.25, -6.5 ],
            [ 7.25, -7.5 ]
        ]);
        packet.fill(0);
        expect(Array.from(outputs[0].channelData[7])).toEqual([ 7.25, -7.5 ]);
    });

    it('stamps later outputs of one packet after the frames that packet already produced', async () => {
        // FFmpeg resets the packet timestamp after the first partial consume
        const fakeDecoder = createFakeEAC3Decoder({
            channelCount: 2,
            channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO,
            presentationTimestamps: [
                5_000_000,
                FFMPEG_NO_PRESENTATION_TIMESTAMP,
                FFMPEG_NO_PRESENTATION_TIMESTAMP
            ],
            receiveStatuses: [ 1, 1, 1, 0 ],
            sampleCount: 48
        });
        const decoder = await EAC3SoftwareAudioDecoder.create(fakeDecoder.moduleFactory);

        const outputs = decoder.decode(
            new Uint8Array([ 1 ]),
            requireMicroseconds(5_000_000, 'Test packet timestamp')
        );

        expect(outputs.map(output => output.mediaTimeMicroseconds)).toEqual([
            5_000_000,
            5_001_000,
            5_002_000
        ]);
    });

    it.each([
        [ 1, CUSTOM_WAVE_CHANNEL_MASK_MONO ],
        [ 2, CUSTOM_WAVE_CHANNEL_MASK_STEREO ],
        [ 3, CUSTOM_WAVE_CHANNEL_MASK_THREE_POINT_ZERO ],
        [ 6, CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK ],
        [ 6, CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE ],
        [ 8, CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE ]
    ] as const)(
        'accepts qualified %i-channel mask %#s',
        async (channelCount, channelMask) => {
            const fakeDecoder = createFakeEAC3Decoder({ channelCount, channelMask });
            const decoder = await EAC3SoftwareAudioDecoder.create(
                fakeDecoder.moduleFactory
            );

            const outputs = decoder.decode(
                new Uint8Array([ 1 ]),
                requireMicroseconds(0, 'Test packet timestamp')
            );

            expect(outputs[0].channelData).toHaveLength(channelCount);
            expect(outputs[0].channelMask).toBe(channelMask);
        }
    );

    it.each([
        [
            { channelCount: 8, channelMask: EAC3_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_WIDE },
            'channel mask 0x6cf is unqualified'
        ],
        [
            { channelCount: 8, channelMask: CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE },
            'channel mask 0x60f is unqualified'
        ],
        [
            { sampleFormat: 3 },
            'sample format 3 is unsupported'
        ],
        [
            { sampleRate: 192_001 },
            'sample rate 192001 Hz is outside the supported range'
        ]
    ] as const)(
        'rejects ambiguous or unsupported decoded output %#',
        async (options, message) => {
            const fakeDecoder = createFakeEAC3Decoder(options);
            const decoder = await EAC3SoftwareAudioDecoder.create(
                fakeDecoder.moduleFactory
            );

            expect(() => decoder.decode(
                new Uint8Array([ 1 ]),
                requireMicroseconds(0, 'Test packet timestamp')
            )).toThrow(message);
        }
    );

    it('returns no output for a rejected packet without reading PCM', async () => {
        const fakeDecoder = createFakeEAC3Decoder({ sendStatus: 0 });
        const decoder = await EAC3SoftwareAudioDecoder.create(fakeDecoder.moduleFactory);

        expect(decoder.decode(
            new Uint8Array([ 1 ]),
            requireMicroseconds(0, 'Test packet timestamp')
        )).toEqual([]);
    });

    it('clears decoder state and destroys exactly once', async () => {
        const fakeDecoder = createFakeEAC3Decoder();
        const decoder = await EAC3SoftwareAudioDecoder.create(fakeDecoder.moduleFactory);

        decoder.clear();
        decoder.close();
        decoder.close();

        expect(fakeDecoder.clearCalls).toEqual([ DECODER_POINTER ]);
        expect(fakeDecoder.destroyCalls).toEqual([ DECODER_POINTER ]);
        expect(() => decoder.clear()).toThrow('Bundled E-AC-3 decoder is closed');
    });
});
