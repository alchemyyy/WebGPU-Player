import { createDecoderWASMURLSource, type DecoderWASMSource } from '../../DecoderWASMSource';
import { AUDIO_OUTPUT_STAGE_WASM_ASSET } from '../../EngineAssets';
import type PCMChannelPool from './PCMChannelPool';

// The kernel interface this wrapper reads; a module built for another one is refused
const AUDIO_OUTPUT_STAGE_ABI_VERSION = 1;
// Bounds the bytes a worker instantiates; the module is a few kilobytes
const MAXIMUM_AUDIO_OUTPUT_STAGE_WASM_BYTE_LENGTH = 1024 * 1024;

// The kernels' status codes
const STATUS_OK = 0;
const STATUS_ALLOCATION_FAILED = -1;
const STATUS_NON_FINITE_SAMPLE = -3;
const STATUS_UNAVAILABLE_LOOKAHEAD = -4;
const STATUS_INCONSISTENT_HISTORY = -5;

// The limiter's telemetry block, in the kernel's order
const LIMITER_MAXIMUM_INPUT_PEAK_INDEX = 0;
const LIMITER_MAXIMUM_OUTPUT_PEAK_INDEX = 1;
const LIMITER_MINIMUM_APPLIED_GAIN_INDEX = 2;
const LIMITER_LIMITED_FRAME_COUNT_INDEX = 3;
const LIMITER_TELEMETRY_VALUE_COUNT = 4;

const ALLOCATION_FAILED_MESSAGE = 'The audio output stage could not allocate memory';
const FALLBACK_WARNING = 'The WebAssembly audio output stage is unavailable; decoded audio uses the JavaScript output stage';

// Shared with the JavaScript reference, so a failure reads the same on either path
export const LIMITER_NON_FINITE_SAMPLE_MESSAGE = 'Limiter input samples must be finite';
export const RESAMPLER_UNAVAILABLE_LOOKAHEAD_MESSAGE = 'Resampler attempted to read unavailable lookahead';
export const RESAMPLER_INCONSISTENT_HISTORY_MESSAGE = 'Resampler history accounting is inconsistent';

type WASMFunction = (...argumentsList: number[]) => number;

type AudioOutputStageExports = Readonly<{
    getABIVersion: WASMFunction
    limiterAppend: WASMFunction
    limiterCreate: WASMFunction
    limiterDestroy: WASMFunction
    limiterOutput: WASMFunction
    limiterRender: WASMFunction
    limiterReserveInput: WASMFunction
    limiterTelemetry: WASMFunction
    memory: WebAssembly.Memory
    resamplerAppend: WASMFunction
    resamplerCreate: WASMFunction
    resamplerDestroy: WASMFunction
    resamplerDiscardBefore: WASMFunction
    resamplerFilterTable: WASMFunction
    resamplerOutput: WASMFunction
    resamplerRender: WASMFunction
    resamplerReserveInput: WASMFunction
}>;

export type AudioOutputStageResamplerKernelOptions = Readonly<{
    channelCount: number
    /** Lends the output channels' buffers; without it, every chunk gets new buffers */
    channelPool?: PCMChannelPool | null
    filterPhaseCount: number
    filterRadius: number
    /** The reference's coefficient table, which the module copies */
    filterTable: Float64Array
    maximumOutputFrameCount: number
    sourceSampleRate: number
    targetSampleRate: number
}>;

export type AudioOutputStageLimiterKernelOptions = Readonly<{
    ceilingGain: number
    channelCount: number
    /** Lends the output channels' buffers; without it, every chunk gets new buffers */
    channelPool?: PCMChannelPool | null
    /** A frame whose applied gain is below this counts as limited */
    limitedGainThreshold: number
    /** The attenuation in decibels at which the attack reaches its maximum length */
    maximumAttackAttenuationDecibels: number
    maximumAttackFrameCount: number
    maximumOutputFrameCount: number
    minimumAttackFrameCount: number
    releaseCoefficient: number
}>;

export type AudioOutputStageLimiterKernelTelemetry = Readonly<{
    limitedFrameCount: number
    maximumInputPeak: number
    maximumOutputPeak: number
    minimumAppliedGain: number
}>;

// Frees a kernel whose owner was collected unfinalized, such as an audio attempt that a resync replaced
const abandonedKernelRegistry = typeof FinalizationRegistry === 'function' ?
    new FinalizationRegistry<() => void>((release): void => {
        release();
    }) :
    null;

let fallbackWarned = false;

/** Warns once per worker that decoded audio renders through the JavaScript reference instead of the module. */
function warnAudioOutputStageFallback(reason: unknown): void {
    if (fallbackWarned) {
        return;
    }
    fallbackWarned = true;
    console.warn(FALLBACK_WARNING, reason);
}

function getExportedFunction(exportsValue: WebAssembly.Exports, name: string): WASMFunction {
    const value = exportsValue[name];
    if (typeof value !== 'function') {
        throw new TypeError(`Audio output stage export ${name} is missing`);
    }
    return value as WASMFunction;
}

function requireExports(instance: WebAssembly.Instance): AudioOutputStageExports {
    const exportsValue = instance.exports;
    const memory = exportsValue.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
        throw new TypeError('Audio output stage memory export is missing');
    }
    return {
        getABIVersion: getExportedFunction(exportsValue, 'audio_output_stage_abi_version'),
        limiterAppend: getExportedFunction(exportsValue, 'audio_limiter_append'),
        limiterCreate: getExportedFunction(exportsValue, 'audio_limiter_create'),
        limiterDestroy: getExportedFunction(exportsValue, 'audio_limiter_destroy'),
        limiterOutput: getExportedFunction(exportsValue, 'audio_limiter_output'),
        limiterRender: getExportedFunction(exportsValue, 'audio_limiter_render'),
        limiterReserveInput: getExportedFunction(exportsValue, 'audio_limiter_reserve_input'),
        limiterTelemetry: getExportedFunction(exportsValue, 'audio_limiter_telemetry'),
        memory,
        resamplerAppend: getExportedFunction(exportsValue, 'audio_resampler_append'),
        resamplerCreate: getExportedFunction(exportsValue, 'audio_resampler_create'),
        resamplerDestroy: getExportedFunction(exportsValue, 'audio_resampler_destroy'),
        resamplerDiscardBefore: getExportedFunction(exportsValue, 'audio_resampler_discard_before'),
        resamplerFilterTable: getExportedFunction(exportsValue, 'audio_resampler_filter_table'),
        resamplerOutput: getExportedFunction(exportsValue, 'audio_resampler_output'),
        resamplerRender: getExportedFunction(exportsValue, 'audio_resampler_render'),
        resamplerReserveInput: getExportedFunction(exportsValue, 'audio_resampler_reserve_input')
    };
}

function throwOnStatus(status: number): void {
    switch (status) {
        case STATUS_OK:
            return;
        case STATUS_ALLOCATION_FAILED:
            throw new RangeError(ALLOCATION_FAILED_MESSAGE);
        case STATUS_NON_FINITE_SAMPLE:
            throw new RangeError(LIMITER_NON_FINITE_SAMPLE_MESSAGE);
        case STATUS_UNAVAILABLE_LOOKAHEAD:
            throw new RangeError(RESAMPLER_UNAVAILABLE_LOOKAHEAD_MESSAGE);
        case STATUS_INCONSISTENT_HISTORY:
            throw new RangeError(RESAMPLER_INCONSISTENT_HISTORY_MESSAGE);
        default:
            throw new Error(`The audio output stage rejected a call with status ${status}`);
    }
}

/** Reads a returned pointer, which a 4 GiB memory can place above 2 GiB, where it arrives negative. */
function toPointer(value: number): number {
    return value >>> 0;
}

function requireAllocation(value: number): number {
    const pointer = toPointer(value);
    if (pointer === 0) {
        throw new RangeError(ALLOCATION_FAILED_MESSAGE);
    }
    return pointer;
}

/** Copies planar channels into the module's staging buffer, one channel after another. */
function writePlanarInput(
    memory: WebAssembly.Memory,
    pointer: number,
    channelData: readonly Float32Array[],
    frameCount: number
): void {
    const staging = new Float32Array(memory.buffer, pointer, channelData.length * frameCount);
    for (let channelIndex = 0; channelIndex < channelData.length; channelIndex += 1) {
        const channel = channelData[channelIndex];
        if (channel.length !== frameCount) {
            throw new RangeError('Audio output stage input channels must hold the stated frame count');
        }
        staging.set(channel, channelIndex * frameCount);
    }
}

/**
 * Copies planar output out of the module into owned, transferable channels.
 * A pool lends recycled buffers, so steady output allocates nothing; without one, each channel gets a new buffer.
 */
function readPlanarOutput(
    memory: WebAssembly.Memory,
    pointer: number,
    channelCount: number,
    frameCount: number,
    channelPool: PCMChannelPool | null
): Float32Array[] {
    const output = new Float32Array(memory.buffer, pointer, channelCount * frameCount);
    const channelData: Float32Array[] = [];
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const firstSampleIndex = channelIndex * frameCount;
        if (!channelPool) {
            channelData.push(output.slice(firstSampleIndex, firstSampleIndex + frameCount));
            continue;
        }
        const channel = channelPool.take(frameCount);
        channel.set(output.subarray(firstSampleIndex, firstSampleIndex + frameCount));
        channelData.push(channel);
    }
    return channelData;
}

/**
 * One resampler's source history and windowed-sinc rendering in the module's memory.
 * The history is a ring, so a push copies only its own frames; timeline reconciliation, timestamps, and chunking stay with the caller.
 */
export class AudioOutputStageResamplerKernel {
    private readonly channelCount: number;
    private readonly channelPool: PCMChannelPool | null;
    private readonly exports: AudioOutputStageExports;
    private handle: number;
    private readonly outputPointer: number;

    public constructor(exports: AudioOutputStageExports, handle: number, channelCount: number, channelPool: PCMChannelPool | null) {
        this.exports = exports;
        this.handle = handle;
        this.channelCount = channelCount;
        this.channelPool = channelPool;
        this.outputPointer = requireAllocation(exports.resamplerOutput(handle));
        abandonedKernelRegistry?.register(this, (): void => {
            exports.resamplerDestroy(handle);
        }, this);
    }

    /** Appends equal-length planar source frames to the history. */
    public append(channelData: readonly Float32Array[], frameCount: number): void {
        const handle = this.requireHandle();
        const inputPointer = requireAllocation(this.exports.resamplerReserveInput(handle, frameCount));
        writePlanarInput(this.exports.memory, inputPointer, channelData, frameCount);
        throwOnStatus(this.exports.resamplerAppend(handle, frameCount));
    }

    /** Renders output frames from the history; finalizing extends the last source frame past the end, as the reference does. */
    public render(firstOutputFrame: number, frameCount: number, finalizing: boolean): Float32Array[] {
        const handle = this.requireHandle();
        throwOnStatus(this.exports.resamplerRender(handle, firstOutputFrame, frameCount, finalizing ? 1 : 0));
        return readPlanarOutput(this.exports.memory, this.outputPointer, this.channelCount, frameCount, this.channelPool);
    }

    /** Releases the history before a source frame, which no later output reads. */
    public discardBefore(sourceFrame: number): void {
        throwOnStatus(this.exports.resamplerDiscardBefore(this.requireHandle(), sourceFrame));
    }

    /** Frees the kernel's memory exactly once. */
    public release(): void {
        if (this.handle === 0) {
            return;
        }
        abandonedKernelRegistry?.unregister(this);
        this.exports.resamplerDestroy(this.handle);
        this.handle = 0;
    }

    private requireHandle(): number {
        if (this.handle === 0) {
            throw new Error('The audio output stage resampler kernel is released');
        }
        return this.handle;
    }
}

/**
 * One lookahead limiter's history, attack envelope, and gain in the module's memory.
 * Each appended peak above the ceiling lowers the attack constraints of the frames before it once, and a render applies the gain recurrence.
 */
export class AudioOutputStageLimiterKernel {
    private readonly channelCount: number;
    private readonly channelPool: PCMChannelPool | null;
    private readonly exports: AudioOutputStageExports;
    private handle: number;
    private readonly outputPointer: number;
    private releasedTelemetry: AudioOutputStageLimiterKernelTelemetry | null = null;
    private readonly telemetryPointer: number;

    public constructor(exports: AudioOutputStageExports, handle: number, channelCount: number, channelPool: PCMChannelPool | null) {
        this.exports = exports;
        this.handle = handle;
        this.channelCount = channelCount;
        this.channelPool = channelPool;
        this.outputPointer = requireAllocation(exports.limiterOutput(handle));
        this.telemetryPointer = requireAllocation(exports.limiterTelemetry(handle));
        abandonedKernelRegistry?.register(this, (): void => {
            exports.limiterDestroy(handle);
        }, this);
    }

    /** Appends equal-length planar frames; a non-finite sample is rejected before anything is stored. */
    public append(channelData: readonly Float32Array[], frameCount: number): void {
        const handle = this.requireHandle();
        const inputPointer = requireAllocation(this.exports.limiterReserveInput(handle, frameCount));
        writePlanarInput(this.exports.memory, inputPointer, channelData, frameCount);
        throwOnStatus(this.exports.limiterAppend(handle, frameCount));
    }

    /** Renders the next frames in order; the caller renders only frames whose analysis horizon is complete, or the tail. */
    public render(frameCount: number): Float32Array[] {
        const handle = this.requireHandle();
        throwOnStatus(this.exports.limiterRender(handle, frameCount));
        return readPlanarOutput(this.exports.memory, this.outputPointer, this.channelCount, frameCount, this.channelPool);
    }

    /** Returns the peak and gain measurements, which survive the release. */
    public getTelemetry(): AudioOutputStageLimiterKernelTelemetry {
        if (this.handle === 0) {
            if (!this.releasedTelemetry) {
                throw new Error('The audio output stage limiter kernel is released');
            }
            return this.releasedTelemetry;
        }
        const telemetry = new Float64Array(this.exports.memory.buffer, this.telemetryPointer, LIMITER_TELEMETRY_VALUE_COUNT);
        return {
            limitedFrameCount: telemetry[LIMITER_LIMITED_FRAME_COUNT_INDEX],
            maximumInputPeak: telemetry[LIMITER_MAXIMUM_INPUT_PEAK_INDEX],
            maximumOutputPeak: telemetry[LIMITER_MAXIMUM_OUTPUT_PEAK_INDEX],
            minimumAppliedGain: telemetry[LIMITER_MINIMUM_APPLIED_GAIN_INDEX]
        };
    }

    /** Frees the kernel's memory exactly once, keeping its final telemetry. */
    public release(): void {
        if (this.handle === 0) {
            return;
        }
        this.releasedTelemetry = this.getTelemetry();
        abandonedKernelRegistry?.unregister(this);
        this.exports.limiterDestroy(this.handle);
        this.handle = 0;
    }

    private requireHandle(): number {
        if (this.handle === 0) {
            throw new Error('The audio output stage limiter kernel is released');
        }
        return this.handle;
    }
}

/**
 * The decoded audio output stage's WebAssembly kernels: the resampler and the lookahead limiter, which reproduce the JavaScript reference bit for bit.
 * One instance serves every output stage of a worker, and its kernels share the module's memory.
 */
export default class AudioOutputStageModule {
    private readonly exports: AudioOutputStageExports;

    private constructor(exports: AudioOutputStageExports) {
        this.exports = exports;
    }

    /** Instantiates the module from its bytes; the engine's own Math.log10 is its one import. */
    public static async instantiate(bytes: ArrayBuffer): Promise<AudioOutputStageModule> {
        if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_AUDIO_OUTPUT_STAGE_WASM_BYTE_LENGTH) {
            throw new RangeError('The audio output stage module is outside its byte bound');
        }
        const { instance } = await WebAssembly.instantiate(bytes, { math: { log10: Math.log10 } });
        // The module is a WASI reactor: its initializer runs the static constructors, which set up the allocator, before any other export
        const initialize = getExportedFunction(instance.exports, '_initialize');
        initialize();
        const exports = requireExports(instance);
        const abiVersion = exports.getABIVersion();
        if (abiVersion !== AUDIO_OUTPUT_STAGE_ABI_VERSION) {
            throw new Error(`The audio output stage module speaks version ${abiVersion}, not ${AUDIO_OUTPUT_STAGE_ABI_VERSION}`);
        }
        return new AudioOutputStageModule(exports);
    }

    /**
     * Creates a resampler kernel and copies the filter table into it.
     * Returns null, after one warning per worker, when the module cannot allocate it, and the caller renders through the reference instead.
     */
    public createResamplerKernel(options: AudioOutputStageResamplerKernelOptions): AudioOutputStageResamplerKernel | null {
        const filterTable = options.filterTable;
        if (filterTable.length !== (options.filterPhaseCount + 1) * options.filterRadius * 2) {
            throw new RangeError('The resampler filter table does not match its phase and tap counts');
        }
        const handle = toPointer(this.exports.resamplerCreate(
            options.channelCount,
            options.sourceSampleRate,
            options.targetSampleRate,
            options.filterRadius,
            options.filterPhaseCount,
            options.maximumOutputFrameCount
        ));
        if (handle === 0) {
            warnAudioOutputStageFallback(new RangeError(ALLOCATION_FAILED_MESSAGE));
            return null;
        }
        const tablePointer = toPointer(this.exports.resamplerFilterTable(handle));
        new Float64Array(this.exports.memory.buffer, tablePointer, filterTable.length).set(filterTable);
        return new AudioOutputStageResamplerKernel(this.exports, handle, options.channelCount, options.channelPool ?? null);
    }

    /**
     * Creates a limiter kernel with the reference's constants.
     * Returns null, after one warning per worker, when the module cannot allocate it, and the caller renders through the reference instead.
     */
    public createLimiterKernel(options: AudioOutputStageLimiterKernelOptions): AudioOutputStageLimiterKernel | null {
        const handle = toPointer(this.exports.limiterCreate(
            options.channelCount,
            options.ceilingGain,
            options.releaseCoefficient,
            options.minimumAttackFrameCount,
            options.maximumAttackFrameCount,
            options.maximumAttackAttenuationDecibels,
            options.limitedGainThreshold,
            options.maximumOutputFrameCount
        ));
        if (handle === 0) {
            warnAudioOutputStageFallback(new RangeError(ALLOCATION_FAILED_MESSAGE));
            return null;
        }
        return new AudioOutputStageLimiterKernel(this.exports, handle, options.channelCount, options.channelPool ?? null);
    }
}

async function readModuleBytes(source: DecoderWASMSource): Promise<ArrayBuffer> {
    switch (source.kind) {
        case 'bytes':
            return source.bytes;
        case 'url': {
            const response = await fetch(source.url);
            if (!response.ok) {
                throw new Error(`The audio output stage request failed with HTTP ${response.status}`);
            }
            return response.arrayBuffer();
        }
    }
}

let modulePromise: Promise<AudioOutputStageModule> | null = null;
let playbackModulePromise: Promise<AudioOutputStageModule | null> | null = null;

/**
 * Instantiates the module once per worker, when the first output stage needs it.
 * It fetches the served binary unless the first caller passes another source, and a failed load is forgotten so that a later call retries it.
 */
export function loadAudioOutputStageModule(source?: DecoderWASMSource): Promise<AudioOutputStageModule> {
    modulePromise ??= readModuleBytes(source ?? createDecoderWASMURLSource(AUDIO_OUTPUT_STAGE_WASM_ASSET))
        .then(bytes => AudioOutputStageModule.instantiate(bytes))
        .catch((error: unknown) => {
            modulePromise = null;
            throw error;
        });
    return modulePromise;
}

/**
 * Loads the module for playback, once per worker.
 * A failure never fails playback: it warns once and resolves null, so every output stage of the worker renders through the JavaScript reference.
 */
export function loadPlaybackAudioOutputStageModule(): Promise<AudioOutputStageModule | null> {
    playbackModulePromise ??= loadAudioOutputStageModule().catch((error: unknown) => {
        warnAudioOutputStageFallback(error);
        return null;
    });
    return playbackModulePromise;
}
