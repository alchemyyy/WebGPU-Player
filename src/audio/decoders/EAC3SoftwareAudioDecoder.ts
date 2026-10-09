import type { Microseconds } from '../../MediaTime';
import { createEmscriptenModuleLoader } from '../../DecoderWASMSource';
import { EAC3_DECODER_WASM_ASSET } from '../../EngineAssets';
import type { FFmpegEAC3Module } from '#wasm/ffmpeg-eac3/ffmpeg-eac3.mjs';
import type { CustomAudioChannelLayout } from '../processing/CustomAudioChannelLayout';
import { isSupportedCustomAudioSampleRate } from '../CustomAudioSampleRate';
import { requirePositiveSafeInteger } from '../SafeIntegerValidation';
import { getQualifiedCustomWaveChannelLayout } from '../processing/CustomWaveChannelLayout';
import {
    addMicroseconds,
    audioFramesToMicroseconds,
    requireMicroseconds
} from '../../TimeMath';

const EAC3_MAXIMUM_PACKET_SIZE = 2 * 1024 * 1024;
const EAC3_MAXIMUM_DECODED_FRAME_COUNT = 16_384;
const EAC3_STATUS_FATAL = -1;
const EAC3_STATUS_NO_OUTPUT = 0;
const EAC3_AV_SAMPLE_FORMAT_F32_PLANAR = 8;

export type EAC3DecodedAudioOutput = Readonly<{
    channelData: readonly Float32Array[]
    channelLayout: CustomAudioChannelLayout
    channelMask: number
    frameCount: number
    mediaTimeMicroseconds: Microseconds
    sampleRate: number
}>;

type FFmpegEAC3FunctionTable = {
    clear: (decoder: number) => void
    configurePacket: (decoder: number, size: number) => number
    create: () => number
    destroy: (decoder: number) => void
    getChannelCount: (decoder: number) => number
    getChannelMask: (decoder: number) => number
    getPlane: (decoder: number, plane: number) => number
    getPTS: (decoder: number) => number
    getSampleCount: (decoder: number) => number
    getSampleFormat: (decoder: number) => number
    getSampleRate: (decoder: number) => number
    getVersion: () => number
    receiveFrame: (decoder: number) => number
    sendPacket: (decoder: number, mediaTimeMicroseconds: number) => number
};

export type EAC3DecoderModuleFactory = () => Promise<FFmpegEAC3Module>;

/**
 * Instantiates FFmpeg's E-AC-3 decoder once per worker, when the first E-AC-3 decoder needs it.
 * It fetches the served binary unless the first caller passes bytes it already fetched.
 */
export const loadEAC3DecoderModule = createEmscriptenModuleLoader<FFmpegEAC3Module>(
    async () => (await import('#wasm/ffmpeg-eac3/ffmpeg-eac3.mjs')).default,
    EAC3_DECODER_WASM_ASSET
);

function requireFunction<FunctionType extends (...arguments_: never[]) => unknown>(
    module: FFmpegEAC3Module,
    name: string,
    argumentCount: number
): FunctionType {
    const argumentTypes: 'number'[] = [];
    for (let argumentIndex = 0; argumentIndex < argumentCount; argumentIndex += 1) {
        argumentTypes.push('number');
    }
    const functionValue = module.cwrap(name, 'number', argumentTypes);
    if (typeof functionValue !== 'function') {
        throw new Error(`FFmpeg E-AC-3 export ${name} is unavailable`);
    }
    return functionValue as unknown as FunctionType;
}

function createFunctionTable(module: FFmpegEAC3Module): FFmpegEAC3FunctionTable {
    return {
        clear: requireFunction(module, 'jellyfin_eac3_clear', 1),
        configurePacket: requireFunction(module, 'jellyfin_eac3_configure_packet', 2),
        create: requireFunction(module, 'jellyfin_eac3_create', 0),
        destroy: requireFunction(module, 'jellyfin_eac3_destroy', 1),
        getChannelCount: requireFunction(module, 'jellyfin_eac3_get_channel_count', 1),
        getChannelMask: requireFunction(module, 'jellyfin_eac3_get_channel_mask', 1),
        getPlane: requireFunction(module, 'jellyfin_eac3_get_plane', 2),
        getPTS: requireFunction(module, 'jellyfin_eac3_get_pts', 1),
        getSampleCount: requireFunction(module, 'jellyfin_eac3_get_sample_count', 1),
        getSampleFormat: requireFunction(module, 'jellyfin_eac3_get_sample_format', 1),
        getSampleRate: requireFunction(module, 'jellyfin_eac3_get_sample_rate', 1),
        getVersion: requireFunction(module, 'jellyfin_eac3_library_version', 0),
        receiveFrame: requireFunction(module, 'jellyfin_eac3_receive_frame', 1),
        sendPacket: requireFunction(module, 'jellyfin_eac3_send_packet', 2)
    };
}

/** Owns one bounded FFmpeg E-AC-3 decoder in the custom decode worker. */
export default class EAC3SoftwareAudioDecoder {
    public readonly libraryVersion: number;

    private closed = false;
    private readonly decoder: number;
    private readonly functions: FFmpegEAC3FunctionTable;
    private readonly module: FFmpegEAC3Module;

    private constructor(module: FFmpegEAC3Module) {
        this.module = module;
        this.functions = createFunctionTable(module);
        this.libraryVersion = requirePositiveSafeInteger(this.functions.getVersion(), 'FFmpeg libavcodec version');
        this.decoder = this.functions.create();
        if (!Number.isSafeInteger(this.decoder) || this.decoder <= 0) {
            throw new Error('Unable to create the bundled E-AC-3 decoder');
        }
    }

    /** Creates one decoder after lazy WebAssembly initialization. */
    public static async create(moduleFactory: EAC3DecoderModuleFactory = loadEAC3DecoderModule): Promise<EAC3SoftwareAudioDecoder> {
        const module = await moduleFactory();
        if (!(module.HEAPF32 instanceof Float32Array) || !(module.HEAPU8 instanceof Uint8Array)) {
            throw new Error('The bundled E-AC-3 decoder memory views are unavailable');
        }
        return new EAC3SoftwareAudioDecoder(module);
    }

    /** Decodes one Mediabunny-demuxed access unit into owned planar PCM blocks. */
    public decode(data: Uint8Array, mediaTimeMicroseconds: Microseconds): readonly EAC3DecodedAudioOutput[] {
        this.requireOpen();
        requireMicroseconds(mediaTimeMicroseconds, 'E-AC-3 packet timestamp');
        if (!(data instanceof Uint8Array) || data.byteLength <= 0 || data.byteLength > EAC3_MAXIMUM_PACKET_SIZE) {
            throw new RangeError('E-AC-3 packet size is outside the bounded decoder envelope');
        }

        const packetPointer = this.functions.configurePacket(this.decoder, data.byteLength);
        if (!Number.isSafeInteger(packetPointer)
            || packetPointer <= 0
            || packetPointer + data.byteLength > this.module.HEAPU8.length) {
            throw new Error('Unable to allocate the bounded E-AC-3 packet buffer');
        }
        this.module.HEAPU8.set(data, packetPointer);
        const sendStatus = this.functions.sendPacket(this.decoder, mediaTimeMicroseconds);
        if (sendStatus === EAC3_STATUS_NO_OUTPUT) {
            return [];
        }
        if (sendStatus <= EAC3_STATUS_FATAL) {
            throw new Error(`Bundled E-AC-3 packet submission failed with status ${sendStatus}`);
        }

        const outputs: EAC3DecodedAudioOutput[] = [];
        let emittedFrameCount = 0;
        while (true) {
            const receiveStatus = this.functions.receiveFrame(this.decoder);
            if (receiveStatus === EAC3_STATUS_NO_OUTPUT) {
                return outputs;
            }
            if (receiveStatus <= EAC3_STATUS_FATAL) {
                throw new Error(`Bundled E-AC-3 frame receive failed with status ${receiveStatus}`);
            }
            // A packet holds any number of syncframes, and each output consumes at least one of its bytes
            if (outputs.length >= data.byteLength) {
                throw new RangeError('Bundled E-AC-3 output exceeded the frames its packet can hold');
            }
            const output = this.copyCurrentOutput(mediaTimeMicroseconds, emittedFrameCount);
            outputs.push(output);
            emittedFrameCount += output.frameCount;
        }
    }

    /** Clears inter-frame state before a source change or seek. */
    public clear(): void {
        this.requireOpen();
        this.functions.clear(this.decoder);
    }

    /** Releases the decoder exactly once. */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.functions.destroy(this.decoder);
    }

    /**
     * Copies the received frame.
     * FFmpeg resets the packet timestamp after a partial consume, so a later frame of the same packet without one starts where the packet's earlier frames ended.
     */
    private copyCurrentOutput(packetMediaTimeMicroseconds: Microseconds, precedingPacketFrameCount: number): EAC3DecodedAudioOutput {
        const frameCount = this.functions.getSampleCount(this.decoder);
        if (!Number.isSafeInteger(frameCount) || frameCount <= 0 || frameCount > EAC3_MAXIMUM_DECODED_FRAME_COUNT) {
            throw new RangeError('Bundled E-AC-3 output frame count is invalid');
        }
        const sampleRate = this.functions.getSampleRate(this.decoder);
        if (!isSupportedCustomAudioSampleRate(sampleRate)) {
            throw new RangeError(`Bundled E-AC-3 output sample rate ${sampleRate} Hz is invalid`);
        }
        const sampleFormat = this.functions.getSampleFormat(this.decoder);
        if (sampleFormat !== EAC3_AV_SAMPLE_FORMAT_F32_PLANAR) {
            throw new RangeError(`Bundled E-AC-3 sample format ${sampleFormat} is unsupported`);
        }

        const channelCount = this.functions.getChannelCount(this.decoder);
        const channelMask = this.functions.getChannelMask(this.decoder) >>> 0;
        const qualifiedLayout = getQualifiedCustomWaveChannelLayout(channelMask);
        if (!qualifiedLayout || qualifiedLayout.channelCount !== channelCount) {
            throw new RangeError(`Bundled E-AC-3 channel mask 0x${channelMask.toString(16)} is unqualified`);
        }

        const channelData: Float32Array[] = [];
        const byteLength = frameCount * Float32Array.BYTES_PER_ELEMENT;
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            const planePointer = this.functions.getPlane(this.decoder, channelIndex);
            if (!Number.isSafeInteger(planePointer)
                || planePointer <= 0
                || planePointer + byteLength > this.module.HEAPU8.length
                || planePointer % Float32Array.BYTES_PER_ELEMENT !== 0) {
                throw new RangeError('Bundled E-AC-3 output is outside decoder memory');
            }
            const firstSampleIndex = planePointer / Float32Array.BYTES_PER_ELEMENT;
            channelData.push(this.module.HEAPF32.slice(firstSampleIndex, firstSampleIndex + frameCount));
        }

        const decodedPTS = this.functions.getPTS(this.decoder);
        const mediaTimeMicroseconds = Number.isSafeInteger(decodedPTS) && decodedPTS >= 0 ?
            requireMicroseconds(decodedPTS, 'Decoded E-AC-3 timestamp') :
            addMicroseconds(packetMediaTimeMicroseconds, audioFramesToMicroseconds(precedingPacketFrameCount, sampleRate));
        return {
            channelData,
            channelLayout: qualifiedLayout.layout,
            channelMask,
            frameCount,
            mediaTimeMicroseconds,
            sampleRate
        };
    }

    private requireOpen(): void {
        if (this.closed) {
            throw new Error('Bundled E-AC-3 decoder is closed');
        }
    }
}
