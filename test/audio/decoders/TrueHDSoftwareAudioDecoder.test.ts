import { describe, expect, it } from 'vitest';

import type { FFmpegTrueHDModule } from '#wasm/ffmpeg-truehd/ffmpeg-truehd.mjs';
import {
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
    CUSTOM_WAVE_CHANNEL_MASK_MONO,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_STEREO
} from 'webgpu-player/audio/processing/CustomWaveChannelLayout';
import { requireMicroseconds } from 'webgpu-player/TimeMath';
import TrueHDSoftwareAudioDecoder, {
    TRUEHD_CODEC_MLP,
    TRUEHD_CODEC_TRUEHD,
    type TrueHDDecoderModuleFactory
} from 'webgpu-player/audio/decoders/TrueHDSoftwareAudioDecoder';

const DECODER_POINTER = 64;
const PACKET_POINTER = 128;
const OUTPUT_POINTER = 512;
const LIBAVCODEC_VERSION = 4_064_612;
const TRUEHD_ATMOS_PROFILE = 30;
// AV_NOPTS_VALUE as the bridge returns it, a double far outside the safe integer range
const FFMPEG_NO_PRESENTATION_TIMESTAMP = -(2 ** 63);
const DEFAULT_PRESENTATION_TIMESTAMP = 1_250_000;
// A malformed decoded rate; any positive integer rate is valid
const ZERO_SAMPLE_RATE = 0;
const INVALID_SAMPLE_RATE_ERROR = `sample rate ${ZERO_SAMPLE_RATE} Hz is invalid`;
const FAKE_FRAME_RECEIVED = 1;
const FAKE_NO_OUTPUT = 0;
// Every decoded access unit consumes at least one packet byte
const PACKET_FRAMES_EXCEEDED_ERROR = 'exceeded the frames its packet can hold';
const SINGLE_FRAME_PACKET_BYTE_LENGTH = 1;
const THREE_FRAME_PACKET_BYTE_LENGTH = 3;
// Many access units in one packet, as an MPEG-TS PES of TrueHD carries
const PES_ACCESS_UNIT_COUNT = 24;
// One 1/1200 s access unit at 48 kHz
const TRUEHD_ACCESS_UNIT_FRAME_COUNT = 40;
// The FNV-1a hash of the default fake S32 output's packed bytes
const DEFAULT_S32_PCM_FINGERPRINT = 3_726_882_277;
const S16_SAMPLE_FORMAT = 1;
const S16_FULL_SCALE = 2 ** 15;
const S32_FULL_SCALE = 2 ** 31;
// Interleaved stereo frames at both ends of each packed format's range, and the smallest steps beside zero
const S16_EXTREME_SAMPLES: readonly number[] = [ -32_768, 32_767, -1, 1 ];
const S32_EXTREME_SAMPLES: readonly number[] = [ -2_147_483_648, 2_147_483_647, -1, 1 ];

type FakeDecoderOptions = Readonly<{
    bitsPerSample?: number
    channelCount?: number
    channelMask?: number
    presentationTimestamps?: readonly number[]
    receiveStatuses?: readonly number[]
    sampleCount?: number
    sampleFormat?: number
    sampleRate?: number
    /** Interleaved packed samples at the output pointer, replacing the default four */
    samples?: readonly number[]
    sendStatus?: number
}>;

type FakeTrueHDDecoder = Readonly<{
    clearCalls: number[]
    createCodecIDs: number[]
    destroyCalls: number[]
    moduleFactory: TrueHDDecoderModuleFactory
}>;

function createFakeTrueHDDecoder(
    options: FakeDecoderOptions = {}
): FakeTrueHDDecoder {
    const memory = new ArrayBuffer(16_384);
    const heap16 = new Int16Array(memory);
    const heap32 = new Int32Array(memory);
    const heapU8 = new Uint8Array(memory);
    const clearCalls: number[] = [];
    const createCodecIDs: number[] = [];
    const destroyCalls: number[] = [];
    const receiveStatuses = [ ...(options.receiveStatuses ?? [ 1, 0 ]) ];
    const presentationTimestamps = [ ...(options.presentationTimestamps ?? []) ];
    const functions = new Map<string, (...arguments_: number[]) => number | void>([
        [ 'jellyfin_truehd_clear', (decoder: number): void => {
            clearCalls.push(decoder);
        } ],
        [ 'jellyfin_truehd_configure_packet', (): number => PACKET_POINTER ],
        [ 'jellyfin_truehd_create', (codec: number): number => {
            createCodecIDs.push(codec);
            return DECODER_POINTER;
        } ],
        [ 'jellyfin_truehd_destroy', (decoder: number): void => {
            destroyCalls.push(decoder);
        } ],
        [ 'jellyfin_truehd_get_bits_per_raw_sample', (): number =>
            options.bitsPerSample ?? 24 ],
        [ 'jellyfin_truehd_get_bytes_per_sample', (): number =>
            (options.sampleFormat ?? 2) === 1 ? 2 : 4 ],
        [ 'jellyfin_truehd_get_channel_count', (): number =>
            options.channelCount ?? 2 ],
        [ 'jellyfin_truehd_get_channel_mask', (): number =>
            options.channelMask ?? CUSTOM_WAVE_CHANNEL_MASK_STEREO ],
        [ 'jellyfin_truehd_get_interleaved_data', (): number => OUTPUT_POINTER ],
        [ 'jellyfin_truehd_get_profile', (): number => TRUEHD_ATMOS_PROFILE ],
        [ 'jellyfin_truehd_get_pts', (): number =>
            presentationTimestamps.shift() ?? DEFAULT_PRESENTATION_TIMESTAMP ],
        [ 'jellyfin_truehd_get_sample_count', (): number => options.sampleCount ?? 2 ],
        [ 'jellyfin_truehd_get_sample_format', (): number => options.sampleFormat ?? 2 ],
        [ 'jellyfin_truehd_get_sample_rate', (): number => options.sampleRate ?? 48_000 ],
        [ 'jellyfin_truehd_library_version', (): number => LIBAVCODEC_VERSION ],
        [ 'jellyfin_truehd_receive_frame', (): number => receiveStatuses.shift() ?? 0 ],
        [ 'jellyfin_truehd_send_packet', (): number => options.sendStatus ?? 1 ]
    ]);
    if ((options.sampleFormat ?? 2) === 1) {
        heap16.set(options.samples ?? [ 0, 16_384, -16_384, 8_192 ], OUTPUT_POINTER / 2);
    } else {
        heap32.set(
            options.samples ?? [ 0, 1_073_741_824, -1_073_741_824, 536_870_912 ],
            OUTPUT_POINTER / 4
        );
    }
    const module: FFmpegTrueHDModule = {
        HEAP16: heap16,
        HEAP32: heap32,
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
        createCodecIDs,
        destroyCalls,
        moduleFactory: async (): Promise<FFmpegTrueHDModule> => module
    };
}

describe('TrueHDSoftwareAudioDecoder', () => {
    it('copies exact packed S32 channel-bed PCM into owned planar floats', async () => {
        const fakeDecoder = createFakeTrueHDDecoder();
        const decoder = await TrueHDSoftwareAudioDecoder.create(
            'truehd',
            fakeDecoder.moduleFactory,
            { pcmFingerprint: true }
        );
        const packet = new Uint8Array([ 1, 2, 3, 4 ]);

        const outputs = decoder.decode(
            packet,
            requireMicroseconds(1_000_000, 'Test packet timestamp')
        );

        expect(fakeDecoder.createCodecIDs).toEqual([ TRUEHD_CODEC_TRUEHD ]);
        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatchObject({
            bitsPerSample: 24,
            channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO,
            codec: 'truehd',
            containsAtmosMetadata: true,
            frameCount: 2,
            losslessChannelBed: true,
            mediaTimeMicroseconds: 1_250_000,
            objectAudioRendered: false,
            sampleRate: 48_000
        });
        expect(Array.from(outputs[0].channelData[0])).toEqual([ 0, -0.5 ]);
        expect(Array.from(outputs[0].channelData[1])).toEqual([ 0.5, 0.25 ]);
        expect(outputs[0].pcmFingerprint).toBe(DEFAULT_S32_PCM_FINGERPRINT);
        packet.fill(0);
        expect(Array.from(outputs[0].channelData[1])).toEqual([ 0.5, 0.25 ]);
    });

    it('skips the PCM fingerprint unless the decoder was created to compute it', async () => {
        const fakeDecoder = createFakeTrueHDDecoder();
        const decoder = await TrueHDSoftwareAudioDecoder.create('truehd', fakeDecoder.moduleFactory);

        const outputs = decoder.decode(
            new Uint8Array([ 1 ]),
            requireMicroseconds(0, 'Test packet timestamp')
        );

        expect(outputs[0].pcmFingerprint).toBeNull();
        expect(Array.from(outputs[0].channelData[0])).toEqual([ 0, -0.5 ]);
        expect(Array.from(outputs[0].channelData[1])).toEqual([ 0.5, 0.25 ]);
    });

    it.each([
        [ 'S16', S16_SAMPLE_FORMAT, 16, S16_EXTREME_SAMPLES, S16_FULL_SCALE ],
        [ 'S32', undefined, 24, S32_EXTREME_SAMPLES, S32_FULL_SCALE ]
    ] as const)(
        'scales %s samples at the ends of their range exactly as dividing by full scale does',
        async (_formatName, sampleFormat, bitsPerSample, samples, fullScale) => {
            const fakeDecoder = createFakeTrueHDDecoder({ bitsPerSample, sampleFormat, samples });
            const decoder = await TrueHDSoftwareAudioDecoder.create('truehd', fakeDecoder.moduleFactory);

            const outputs = decoder.decode(
                new Uint8Array([ 1 ]),
                requireMicroseconds(0, 'Test packet timestamp')
            );

            expect(outputs[0].channelData[0]).toEqual(new Float32Array([ samples[0] / fullScale, samples[2] / fullScale ]));
            expect(outputs[0].channelData[1]).toEqual(new Float32Array([ samples[1] / fullScale, samples[3] / fullScale ]));
        }
    );

    it('supports packed S16 output without changing its PCM scale', async () => {
        const fakeDecoder = createFakeTrueHDDecoder({
            bitsPerSample: 16,
            sampleFormat: 1
        });
        const decoder = await TrueHDSoftwareAudioDecoder.create(
            'truehd',
            fakeDecoder.moduleFactory
        );

        const outputs = decoder.decode(
            new Uint8Array([ 1 ]),
            requireMicroseconds(0, 'Test packet timestamp')
        );

        expect(Array.from(outputs[0].channelData[0])).toEqual([ 0, -0.5 ]);
        expect(Array.from(outputs[0].channelData[1])).toEqual([ 0.5, 0.25 ]);
    });

    it('stamps later access units of one packet after the frames that packet already produced', async () => {
        // FFmpeg resets the packet timestamp after the first partial consume
        const fakeDecoder = createFakeTrueHDDecoder({
            presentationTimestamps: [
                3_000_000,
                FFMPEG_NO_PRESENTATION_TIMESTAMP,
                FFMPEG_NO_PRESENTATION_TIMESTAMP
            ],
            receiveStatuses: [ 1, 1, 1, 0 ],
            sampleCount: TRUEHD_ACCESS_UNIT_FRAME_COUNT
        });
        const decoder = await TrueHDSoftwareAudioDecoder.create(
            'truehd',
            fakeDecoder.moduleFactory
        );

        const outputs = decoder.decode(
            new Uint8Array(THREE_FRAME_PACKET_BYTE_LENGTH),
            requireMicroseconds(3_000_000, 'Test packet timestamp')
        );

        expect(outputs.map(output => output.mediaTimeMicroseconds)).toEqual([
            3_000_000,
            3_000_833,
            3_001_667
        ]);
    });

    it('decodes every access unit of a packet that holds many', async () => {
        const fakeDecoder = createFakeTrueHDDecoder({
            receiveStatuses: [
                ...new Array<number>(PES_ACCESS_UNIT_COUNT).fill(FAKE_FRAME_RECEIVED),
                FAKE_NO_OUTPUT
            ],
            sampleCount: TRUEHD_ACCESS_UNIT_FRAME_COUNT
        });
        const decoder = await TrueHDSoftwareAudioDecoder.create('truehd', fakeDecoder.moduleFactory);

        expect(decoder.decode(
            new Uint8Array(PES_ACCESS_UNIT_COUNT),
            requireMicroseconds(0, 'Test packet timestamp')
        )).toHaveLength(PES_ACCESS_UNIT_COUNT);
    });

    it('refuses more access units than its packet has bytes to hold', async () => {
        const fakeDecoder = createFakeTrueHDDecoder({
            receiveStatuses: [ FAKE_FRAME_RECEIVED, FAKE_FRAME_RECEIVED, FAKE_NO_OUTPUT ]
        });
        const decoder = await TrueHDSoftwareAudioDecoder.create('truehd', fakeDecoder.moduleFactory);

        expect(() => decoder.decode(
            new Uint8Array(SINGLE_FRAME_PACKET_BYTE_LENGTH),
            requireMicroseconds(0, 'Test packet timestamp')
        )).toThrow(PACKET_FRAMES_EXCEEDED_ERROR);
    });

    it.each([
        [ 1, CUSTOM_WAVE_CHANNEL_MASK_MONO, 48_000 ],
        [ 2, CUSTOM_WAVE_CHANNEL_MASK_STEREO, 48_000 ],
        [ 2, CUSTOM_WAVE_CHANNEL_MASK_STEREO, 44_100 ],
        [ 6, CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE, 96_000 ],
        [ 8, CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE, 192_000 ]
    ] as const)(
        'accepts qualified %i-channel %i Hz output',
        async (channelCount, channelMask, sampleRate) => {
            const fakeDecoder = createFakeTrueHDDecoder({
                channelCount,
                channelMask,
                sampleRate
            });
            const decoder = await TrueHDSoftwareAudioDecoder.create(
                'truehd',
                fakeDecoder.moduleFactory
            );

            const outputs = decoder.decode(
                new Uint8Array([ 1 ]),
                requireMicroseconds(0, 'Test packet timestamp')
            );

            expect(outputs[0].channelData).toHaveLength(channelCount);
            expect(outputs[0].sampleRate).toBe(sampleRate);
        }
    );

    it('returns no output while FFmpeg searches for the next major sync', async () => {
        const fakeDecoder = createFakeTrueHDDecoder({ sendStatus: 0 });
        const decoder = await TrueHDSoftwareAudioDecoder.create(
            'truehd',
            fakeDecoder.moduleFactory
        );

        expect(decoder.decode(
            new Uint8Array([ 1 ]),
            requireMicroseconds(0, 'Test packet timestamp')
        )).toEqual([]);
    });

    it('selects the separate MLP decoder without relabeling output as TrueHD', async () => {
        const fakeDecoder = createFakeTrueHDDecoder();
        const decoder = await TrueHDSoftwareAudioDecoder.create(
            'mlp',
            fakeDecoder.moduleFactory
        );

        const outputs = decoder.decode(
            new Uint8Array([ 1 ]),
            requireMicroseconds(0, 'Test packet timestamp')
        );

        expect(fakeDecoder.createCodecIDs).toEqual([ TRUEHD_CODEC_MLP ]);
        expect(outputs[0].codec).toBe('mlp');
    });

    it.each([
        [ { sampleRate: ZERO_SAMPLE_RATE }, INVALID_SAMPLE_RATE_ERROR ],
        [ { bitsPerSample: 32 }, 'output depth 32 is unsupported' ],
        [ { channelCount: 6, channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO },
            'channel mask 0x3 is unqualified' ],
        [ { sampleFormat: 3 }, 'sample format 3 is unsupported' ]
    ] as const)('rejects output outside the qualified envelope', async (options, message) => {
        const fakeDecoder = createFakeTrueHDDecoder(options);
        const decoder = await TrueHDSoftwareAudioDecoder.create(
            'truehd',
            fakeDecoder.moduleFactory
        );

        expect(() => decoder.decode(
            new Uint8Array([ 1 ]),
            requireMicroseconds(0, 'Test packet timestamp')
        )).toThrow(message);
    });

    it('clears prediction state and destroys exactly once', async () => {
        const fakeDecoder = createFakeTrueHDDecoder();
        const decoder = await TrueHDSoftwareAudioDecoder.create(
            'truehd',
            fakeDecoder.moduleFactory
        );

        decoder.clear();
        decoder.close();
        decoder.close();

        expect(fakeDecoder.clearCalls).toEqual([ DECODER_POINTER ]);
        expect(fakeDecoder.destroyCalls).toEqual([ DECODER_POINTER ]);
        expect(() => decoder.clear()).toThrow('Bundled TrueHD decoder is closed');
        expect(() => decoder.decode(
            new Uint8Array([ 1 ]),
            requireMicroseconds(0, 'Test packet timestamp')
        )).toThrow(
            'Bundled TrueHD decoder is closed'
        );
    });
});
