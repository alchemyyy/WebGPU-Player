// @vitest-environment node

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DecoderWASMSource } from 'webgpu-player/DecoderWASMSource';
import { AUDIO_OUTPUT_STAGE_WASM_ASSET } from 'webgpu-player/EngineAssets';
import AudioOutputStageModule, {
    LIMITER_NON_FINITE_SAMPLE_MESSAGE
} from 'webgpu-player/audio/processing/AudioOutputStageModule';
import StreamingAudioResampler, {
    type StreamingAudioResamplerOptions
} from 'webgpu-player/audio/processing/StreamingAudioResampler';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

import { readDecoderWASMSource } from '../../helpers/libraryAssets';

type AudioOutputStageModuleExports = typeof import('webgpu-player/audio/processing/AudioOutputStageModule');

const SOURCE_SAMPLE_RATE = 44_100;
const TARGET_SAMPLE_RATE = 48_000;
const STEREO_CHANNEL_COUNT = 2;
const MINIMUM_OUTPUT_FRAME_COUNT = 1_920;
const MAXIMUM_OUTPUT_FRAME_COUNT = 12_000;
const TIMESTAMP_QUANTIZATION_MICROSECONDS = 1_000;
const FILTER_PHASE_COUNT = 2_048;
const FILTER_RADIUS = 32;
const LIMITER_CEILING_GAIN = 10 ** (-1 / 20);
const LIMITER_RELEASE_COEFFICIENT = Math.exp(-1 / 4_800);
const LIMITER_MINIMUM_ATTACK_FRAME_COUNT = 144;
const LIMITER_MAXIMUM_ATTACK_FRAME_COUNT = 480;
const LIMITER_MAXIMUM_ATTACK_ATTENUATION_DECIBELS = 12;
const LIMITER_GAIN_THRESHOLD = 1 - 1e-7;
const INPUT_FRAME_COUNT = 4_410;
const INPUT_AMPLITUDE = 0.25;
// A chunk too large for the 4 GiB address space, which no allocation can hold
const UNALLOCATABLE_OUTPUT_FRAME_COUNT = 2 ** 31;
const OVERSIZED_MODULE_BYTE_LENGTH = 1024 * 1024 + 1;
const NOT_FOUND_STATUS = 404;
const FALLBACK_WARNING = 'The WebAssembly audio output stage is unavailable; decoded audio uses the JavaScript output stage';
const RELEASED_RESAMPLER_MESSAGE = 'The audio output stage resampler kernel is released';
const RELEASED_LIMITER_MESSAGE = 'The audio output stage limiter kernel is released';
const SERVED_MODULE_URL = 'https://example.test/web/libraries/audio-output-stage/audio-output-stage.wasm';

let moduleBytes: ArrayBuffer;

beforeAll(async () => {
    const source = await readDecoderWASMSource(AUDIO_OUTPUT_STAGE_WASM_ASSET);
    if (source.kind !== 'bytes') {
        throw new Error('The test reads the output stage binary as bytes');
    }
    moduleBytes = source.bytes;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** Loads a fresh copy of the module file, so its per-worker cache and warning start empty. */
function importFreshModuleFile(): Promise<AudioOutputStageModuleExports> {
    vi.resetModules();
    return import('webgpu-player/audio/processing/AudioOutputStageModule');
}

function createResamplerOptions(maximumOutputFrameCount: number): StreamingAudioResamplerOptions {
    return {
        channelCount: STEREO_CHANNEL_COUNT,
        maximumOutputFrameCount,
        maximumTimestampQuantizationMicroseconds: TIMESTAMP_QUANTIZATION_MICROSECONDS,
        minimumOutputFrameCount: MINIMUM_OUTPUT_FRAME_COUNT,
        sourceSampleRate: SOURCE_SAMPLE_RATE,
        targetSampleRate: TARGET_SAMPLE_RATE
    };
}

function createInputChannels(): Float32Array[] {
    const channels: Float32Array[] = [];
    for (let channelIndex = 0; channelIndex < STEREO_CHANNEL_COUNT; channelIndex += 1) {
        const channel = new Float32Array(INPUT_FRAME_COUNT);
        for (let frameIndex = 0; frameIndex < INPUT_FRAME_COUNT; frameIndex += 1) {
            channel[frameIndex] = INPUT_AMPLITUDE * Math.sin(frameIndex / (channelIndex + 2));
        }
        channels.push(channel);
    }
    return channels;
}

function createLimiterKernelOptions(): Parameters<AudioOutputStageModule['createLimiterKernel']>[0] {
    return {
        ceilingGain: LIMITER_CEILING_GAIN,
        channelCount: STEREO_CHANNEL_COUNT,
        limitedGainThreshold: LIMITER_GAIN_THRESHOLD,
        maximumAttackAttenuationDecibels: LIMITER_MAXIMUM_ATTACK_ATTENUATION_DECIBELS,
        maximumAttackFrameCount: LIMITER_MAXIMUM_ATTACK_FRAME_COUNT,
        maximumOutputFrameCount: MAXIMUM_OUTPUT_FRAME_COUNT,
        minimumAttackFrameCount: LIMITER_MINIMUM_ATTACK_FRAME_COUNT,
        releaseCoefficient: LIMITER_RELEASE_COEFFICIENT
    };
}

describe('AudioOutputStageModule', () => {
    it.each([
        [ 'empty', new ArrayBuffer(0) ],
        [ 'oversized', new ArrayBuffer(OVERSIZED_MODULE_BYTE_LENGTH) ]
    ])('refuses %s bytes before compiling them', async (_name, bytes) => {
        await expect(AudioOutputStageModule.instantiate(bytes)).rejects.toThrow('outside its byte bound');
    });

    it('rejects bytes that are not a module', async () => {
        await expect(AudioOutputStageModule.instantiate(new Uint8Array([ 1, 2, 3, 4 ]).buffer)).rejects.toThrow();
    });

    it('instantiates once per worker and retries a load that failed', async () => {
        const { loadAudioOutputStageModule } = await importFreshModuleFile();
        const failedSource: DecoderWASMSource = { bytes: new Uint8Array([ 1, 2, 3, 4 ]).buffer, kind: 'bytes' };
        await expect(loadAudioOutputStageModule(failedSource)).rejects.toThrow();

        const loadedModule = await loadAudioOutputStageModule({ bytes: moduleBytes, kind: 'bytes' });
        expect(await loadAudioOutputStageModule(failedSource)).toBe(loadedModule);
    });

    it('fetches the served binary when no source is given', async () => {
        const { loadAudioOutputStageModule } = await importFreshModuleFile();
        const fetchModule = vi.fn(async (): Promise<Response> => new Response(moduleBytes, { status: 200 }));
        vi.stubGlobal('fetch', fetchModule);
        vi.stubGlobal('location', { href: 'https://example.test/web/libraries/webgpu-player/CustomDecode.worker.js' });
        vi.stubGlobal('importScripts', () => undefined);

        await loadAudioOutputStageModule();

        expect(fetchModule).toHaveBeenCalledExactlyOnceWith(SERVED_MODULE_URL);
    });

    it('falls back to the JavaScript output stage once, with one warning, when playback cannot load the module', async () => {
        const { loadPlaybackAudioOutputStageModule } = await importFreshModuleFile();
        const fetchModule = vi.fn(async (): Promise<Response> => new Response(null, { status: NOT_FOUND_STATUS }));
        vi.stubGlobal('fetch', fetchModule);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(await loadPlaybackAudioOutputStageModule()).toBeNull();
        expect(await loadPlaybackAudioOutputStageModule()).toBeNull();

        expect(fetchModule).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toBe(FALLBACK_WARNING);
    });

    it('renders through the JavaScript reference, with one warning, when the module cannot allocate a kernel', async () => {
        const moduleFile = await importFreshModuleFile();
        const freshModule = await moduleFile.default.instantiate(moduleBytes);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const createKernel = vi.spyOn(freshModule, 'createResamplerKernel');

        const options = { ...createResamplerOptions(UNALLOCATABLE_OUTPUT_FRAME_COUNT), outputStageModule: freshModule };
        const resamplers = [ new StreamingAudioResampler(options), new StreamingAudioResampler(options) ];
        const reference = new StreamingAudioResampler(createResamplerOptions(UNALLOCATABLE_OUTPUT_FRAME_COUNT));
        const input = { channelData: createInputChannels(), mediaTimeMicroseconds: requireMicroseconds(0) };
        const referenceOutput = [ ...reference.push(input), ...reference.finalize() ];

        expect(createKernel.mock.results.map(result => result.value)).toEqual([ null, null ]);
        expect(warn).toHaveBeenCalledOnce();
        for (const resampler of resamplers) {
            expect([ ...resampler.push(input), ...resampler.finalize() ]).toEqual(referenceOutput);
        }
    });

    it('refuses a filter table that does not match its phase and tap counts', async () => {
        const audioOutputStageModule = await AudioOutputStageModule.instantiate(moduleBytes);
        expect(() => audioOutputStageModule.createResamplerKernel({
            channelCount: STEREO_CHANNEL_COUNT,
            filterPhaseCount: FILTER_PHASE_COUNT,
            filterRadius: FILTER_RADIUS,
            filterTable: new Float64Array(FILTER_RADIUS),
            maximumOutputFrameCount: MAXIMUM_OUTPUT_FRAME_COUNT,
            sourceSampleRate: SOURCE_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        })).toThrow('does not match its phase and tap counts');
    });

    it('releases a resampler kernel once and refuses it afterwards', async () => {
        const audioOutputStageModule = await AudioOutputStageModule.instantiate(moduleBytes);
        const kernel = audioOutputStageModule.createResamplerKernel({
            channelCount: STEREO_CHANNEL_COUNT,
            filterPhaseCount: FILTER_PHASE_COUNT,
            filterRadius: FILTER_RADIUS,
            filterTable: new Float64Array((FILTER_PHASE_COUNT + 1) * FILTER_RADIUS * 2),
            maximumOutputFrameCount: MAXIMUM_OUTPUT_FRAME_COUNT,
            sourceSampleRate: SOURCE_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        if (!kernel) {
            throw new Error('The module could not allocate a resampler kernel');
        }

        kernel.release();
        kernel.release();

        expect(() => kernel.append(createInputChannels(), INPUT_FRAME_COUNT)).toThrow(RELEASED_RESAMPLER_MESSAGE);
    });

    it('keeps a limiter kernel\'s telemetry past its release, and rejects a non-finite sample before storing anything', async () => {
        const audioOutputStageModule = await AudioOutputStageModule.instantiate(moduleBytes);
        const kernel = audioOutputStageModule.createLimiterKernel(createLimiterKernelOptions());
        if (!kernel) {
            throw new Error('The module could not allocate a limiter kernel');
        }
        const channels = createInputChannels();
        kernel.append(channels, INPUT_FRAME_COUNT);
        const nonFiniteChannels = createInputChannels();
        nonFiniteChannels[1][INPUT_FRAME_COUNT - 1] = Number.NaN;

        expect(() => kernel.append(nonFiniteChannels, INPUT_FRAME_COUNT)).toThrow(LIMITER_NON_FINITE_SAMPLE_MESSAGE);
        kernel.render(INPUT_FRAME_COUNT);
        const telemetry = kernel.getTelemetry();
        kernel.release();

        expect(telemetry.maximumInputPeak).toBeGreaterThan(0);
        expect(telemetry.maximumInputPeak).toBeLessThanOrEqual(INPUT_AMPLITUDE);
        expect(kernel.getTelemetry()).toEqual(telemetry);
        expect(() => kernel.render(1)).toThrow(RELEASED_LIMITER_MESSAGE);
    });
});
