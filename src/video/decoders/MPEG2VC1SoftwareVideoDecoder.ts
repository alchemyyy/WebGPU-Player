import {
    type EncodedPacket,
    VideoSample
} from 'mediabunny';

import { resolveEngineAssetURL, type EngineAssetPath } from '../../EngineAssets';
import { microsecondsToSeconds, type Microseconds } from '../../MediaTime';
import { requireMicroseconds } from '../../TimeMath';

const MPEG2_VC1_DECODER_GLUE_ASSET: EngineAssetPath = 'ffmpeg-mpeg2-vc1/ffmpeg-mpeg2-vc1.js';
const MPEG2_VC1_DECODER_WASM_ASSET: EngineAssetPath = 'ffmpeg-mpeg2-vc1/ffmpeg-mpeg2-vc1.wasm';
const MAXIMUM_DECODER_DESCRIPTION_BYTE_LENGTH = 1024 * 1024;
const MAXIMUM_PENDING_PICTURE_COUNT = 64;
const AV_NOPTS_VALUE = BigInt('-9223372036854775808');
const AV_COLOR_RANGE_MPEG = 1;
const AV_COLOR_RANGE_JPEG = 2;
const MPEG2_VC1_CODEC_MPEG2VIDEO = 1;
const MPEG2_VC1_CODEC_VC1 = 2;

export type MPEG2VC1SoftwareVideoDecoderConfiguration = {
    codec: 'mpeg2video' | 'vc1'
    codedHeight: number
    codedWidth: number
    colorSpace?: VideoColorSpaceInit
    description?: Uint8Array
    displayHeight?: number
    displayWidth?: number
};

export type MPEG2VC1SoftwareVideoDecoderCallbacks = {
    onError: (error: unknown) => void
    onSample: (sample: VideoSample) => unknown
};

/* eslint-disable @typescript-eslint/naming-convention -- Mirrors the external WASM ABI */
export type MPEG2VC1DecoderModule = {
    HEAPU8: Uint8Array
    _mpeg2_vc1_decoder_close: (decoder: number) => void
    _mpeg2_vc1_decoder_configure_packet: (decoder: number, packetByteLength: number) => number
    _mpeg2_vc1_decoder_create: (
        codec: number,
        codedWidth: number,
        codedHeight: number,
        extradataByteLength: number
    ) => number
    _mpeg2_vc1_decoder_error_again: () => number
    _mpeg2_vc1_decoder_error_eof: () => number
    _mpeg2_vc1_decoder_frame_is_i420: (decoder: number) => number
    _mpeg2_vc1_decoder_get_color_matrix: (decoder: number) => number
    _mpeg2_vc1_decoder_get_color_primaries: (decoder: number) => number
    _mpeg2_vc1_decoder_get_color_range: (decoder: number) => number
    _mpeg2_vc1_decoder_get_color_transfer: (decoder: number) => number
    _mpeg2_vc1_decoder_get_crop_bottom: (decoder: number) => number
    _mpeg2_vc1_decoder_get_crop_left: (decoder: number) => number
    _mpeg2_vc1_decoder_get_crop_right: (decoder: number) => number
    _mpeg2_vc1_decoder_get_crop_top: (decoder: number) => number
    _mpeg2_vc1_decoder_get_duration: (decoder: number) => bigint
    _mpeg2_vc1_decoder_get_extradata: (decoder: number) => number
    _mpeg2_vc1_decoder_get_height: (decoder: number) => number
    _mpeg2_vc1_decoder_get_interlaced: (decoder: number) => number
    _mpeg2_vc1_decoder_get_plane: (decoder: number, plane: number) => number
    _mpeg2_vc1_decoder_get_repeat_picture: (decoder: number) => number
    _mpeg2_vc1_decoder_get_stride: (decoder: number, plane: number) => number
    _mpeg2_vc1_decoder_get_timestamp: (decoder: number) => bigint
    _mpeg2_vc1_decoder_get_top_field_first: (decoder: number) => number
    _mpeg2_vc1_decoder_get_width: (decoder: number) => number
    _mpeg2_vc1_decoder_open: (decoder: number) => number
    _mpeg2_vc1_decoder_receive_frame: (decoder: number) => number
    _mpeg2_vc1_decoder_send_packet: (
        decoder: number,
        presentationTimestamp: bigint,
        decodeTimestamp: bigint,
        duration: bigint,
        keyFrame: number
    ) => number
    _mpeg2_vc1_decoder_start_drain: (decoder: number) => number
};
/* eslint-enable @typescript-eslint/naming-convention */

type MPEG2VC1DecoderModuleFactory = (options: {
    locateFile: (path: string) => string
}) => Promise<MPEG2VC1DecoderModule>;

type MPEG2VC1DecoderWorkerGlobal = typeof globalThis & {
    MPEG2VC1DecoderModule?: MPEG2VC1DecoderModuleFactory
    importScripts?: (...urls: string[]) => void
    location?: { href?: unknown }
};

export type MPEG2VC1SoftwareVideoDecoderDependencies = {
    createModule: (wasmURL: string) => Promise<MPEG2VC1DecoderModule>
    loadDecoderGlue: (url: string) => void
    resolveAssetURL: (path: EngineAssetPath) => string
};

type PackedI420Frame = {
    codedHeight: number
    codedWidth: number
    data: Uint8Array
    layout: readonly [PlaneLayout, PlaneLayout, PlaneLayout]
};

export class MPEG2VC1InterlacedFrameError extends Error {
    public constructor(public readonly topFieldFirst: boolean, public readonly repeatPicture: number) {
        super('The MPEG-2/VC-1 software decoder output an interlaced frame');
        this.name = 'MPEG2VC1InterlacedFrameError';
    }
}

function isPositiveSafeInteger(value: number | undefined): value is number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0;
}

/** Reads a returned pointer as a heap address; past 2 GiB the WASM i32 result arrives negative. */
function toHeapAddress(pointer: number): number {
    return pointer >>> 0;
}

function loadDefaultDecoderGlue(url: string): void {
    const workerGlobal = globalThis as MPEG2VC1DecoderWorkerGlobal;
    if (typeof workerGlobal.MPEG2VC1DecoderModule === 'function') {
        return;
    }
    if (typeof workerGlobal.importScripts !== 'function') {
        throw new Error('The MPEG-2/VC-1 software decoder requires a classic Web Worker');
    }
    workerGlobal.importScripts(url);
    if (typeof workerGlobal.MPEG2VC1DecoderModule !== 'function') {
        throw new Error('The MPEG-2/VC-1 software decoder glue did not expose its module factory');
    }
}

async function createDefaultModule(wasmURL: string): Promise<MPEG2VC1DecoderModule> {
    const workerGlobal = globalThis as MPEG2VC1DecoderWorkerGlobal;
    const moduleFactory = workerGlobal.MPEG2VC1DecoderModule;
    if (typeof moduleFactory !== 'function') {
        throw new Error('The MPEG-2/VC-1 software decoder module factory is unavailable');
    }
    return moduleFactory({ locateFile: (): string => wasmURL });
}

const DEFAULT_DEPENDENCIES: MPEG2VC1SoftwareVideoDecoderDependencies = {
    createModule: createDefaultModule,
    loadDecoderGlue: loadDefaultDecoderGlue,
    resolveAssetURL: resolveEngineAssetURL
};

function getColorPrimaries(value: number): VideoColorPrimaries | undefined {
    switch (value) {
        case 1:
            return 'bt709';
        case 5:
            return 'bt470bg';
        case 6:
            return 'smpte170m';
        default:
            return undefined;
    }
}

function getColorTransfer(value: number): VideoTransferCharacteristics | undefined {
    switch (value) {
        case 1:
            return 'bt709';
        case 6:
            return 'smpte170m';
        case 13:
            return 'iec61966-2-1';
        default:
            return undefined;
    }
}

function getColorMatrix(value: number): VideoMatrixCoefficients | undefined {
    switch (value) {
        case 0:
            return 'rgb';
        case 1:
            return 'bt709';
        case 5:
            return 'bt470bg';
        case 6:
            return 'smpte170m';
        default:
            return undefined;
    }
}

function getFullRange(value: number, configuredValue: boolean | null | undefined): boolean | null | undefined {
    switch (value) {
        case AV_COLOR_RANGE_MPEG:
            return false;
        case AV_COLOR_RANGE_JPEG:
            return true;
        default:
            return configuredValue;
    }
}

function copyPlane(
    module: MPEG2VC1DecoderModule,
    sourcePointer: number,
    sourceStride: number,
    planeWidth: number,
    planeHeight: number,
    destination: Uint8Array,
    destinationOffset: number
): void {
    if (!Number.isSafeInteger(sourcePointer) || sourcePointer <= 0 || sourceStride === 0) {
        throw new TypeError('The MPEG-2/VC-1 software decoder returned an invalid plane');
    }
    for (let rowIndex = 0; rowIndex < planeHeight; rowIndex += 1) {
        const sourceOffset = sourcePointer + (rowIndex * sourceStride);
        if (sourceOffset < 0 || sourceOffset + planeWidth > module.HEAPU8.byteLength) {
            throw new RangeError('The MPEG-2/VC-1 software decoder plane exceeds WASM memory');
        }
        const destinationRowOffset = destinationOffset + (rowIndex * planeWidth);
        destination.set(module.HEAPU8.subarray(sourceOffset, sourceOffset + planeWidth), destinationRowOffset);
    }
}

/** Decodes progressive MPEG-2 Video and VC-1 with an FFmpeg WASM build that contains only those two decoders. */
export default class MPEG2VC1SoftwareVideoDecoder {
    private closed = false;
    private decoder = 0;
    private readonly durationsByTimestamp = new Map<Microseconds, Microseconds>();
    private module: MPEG2VC1DecoderModule | null = null;

    public constructor(
        private readonly configuration: MPEG2VC1SoftwareVideoDecoderConfiguration,
        private readonly callbacks: MPEG2VC1SoftwareVideoDecoderCallbacks,
        private readonly dependencies: MPEG2VC1SoftwareVideoDecoderDependencies = DEFAULT_DEPENDENCIES
    ) {}

    /** Loads the WASM decoder and opens its codec context. It throws when the decoder is already initialized or closed. */
    public async init(): Promise<void> {
        if (this.closed || this.module || this.decoder !== 0) {
            throw new Error('The MPEG-2/VC-1 software decoder cannot be initialized in its current state');
        }
        this.validateConfiguration();

        const decoderGlueURL = this.dependencies.resolveAssetURL(MPEG2_VC1_DECODER_GLUE_ASSET);
        const decoderWASMURL = this.dependencies.resolveAssetURL(MPEG2_VC1_DECODER_WASM_ASSET);
        this.dependencies.loadDecoderGlue(decoderGlueURL);
        const module = await this.dependencies.createModule(decoderWASMURL);
        if (this.closed) {
            return;
        }

        const decoderDescription = this.configuration.description;
        const decoder = toHeapAddress(module._mpeg2_vc1_decoder_create(
            this.configuration.codec === 'vc1' ? MPEG2_VC1_CODEC_VC1 : MPEG2_VC1_CODEC_MPEG2VIDEO,
            this.configuration.codedWidth,
            this.configuration.codedHeight,
            decoderDescription?.byteLength ?? 0
        ));
        if (decoder === 0) {
            throw new Error('The MPEG-2/VC-1 software decoder context could not be created');
        }

        try {
            if (decoderDescription) {
                const descriptionPointer = toHeapAddress(module._mpeg2_vc1_decoder_get_extradata(decoder));
                if (descriptionPointer === 0 || descriptionPointer + decoderDescription.byteLength > module.HEAPU8.byteLength) {
                    throw new Error('The MPEG-2/VC-1 software decoder description allocation is invalid');
                }
                module.HEAPU8.set(decoderDescription, descriptionPointer);
            }
            const openResult = module._mpeg2_vc1_decoder_open(decoder);
            if (openResult < 0) {
                throw new Error(`The MPEG-2/VC-1 software decoder open failed: ${openResult}`);
            }
        } catch (error) {
            module._mpeg2_vc1_decoder_close(decoder);
            throw error;
        }

        this.module = module;
        this.decoder = decoder;
    }

    /** Decodes one Mediabunny packet and emits all frames made displayable by it. */
    public decode(packet: EncodedPacket): void {
        const { decoder, module } = this.requireDecoder();
        if (packet.isMetadataOnly) {
            throw new TypeError('The MPEG-2/VC-1 software decoder cannot decode metadata-only packets');
        }
        if (packet.data.byteLength <= 0) {
            throw new RangeError('The MPEG-2/VC-1 compressed packet is empty');
        }

        const timestampMicroseconds = requireMicroseconds(packet.microsecondTimestamp, 'MPEG-2/VC-1 packet timestamp');
        const durationMicroseconds = requireMicroseconds(packet.microsecondDuration, 'MPEG-2/VC-1 packet duration');
        if (durationMicroseconds < 0) {
            throw new RangeError('The MPEG-2/VC-1 packet duration must not be negative');
        }
        if (
            !this.durationsByTimestamp.has(timestampMicroseconds)
            && this.durationsByTimestamp.size >= MAXIMUM_PENDING_PICTURE_COUNT
        ) {
            throw new RangeError('The MPEG-2/VC-1 decoder reorder window is invalid');
        }
        // VFW VC-1 can replace a zero-duration timing placeholder before output
        this.durationsByTimestamp.set(timestampMicroseconds, durationMicroseconds);

        const packetPointer = toHeapAddress(module._mpeg2_vc1_decoder_configure_packet(decoder, packet.data.byteLength));
        if (packetPointer === 0) {
            throw new Error('The MPEG-2/VC-1 software decoder packet allocation failed');
        }
        module.HEAPU8.set(packet.data, packetPointer);
        const sendResult = module._mpeg2_vc1_decoder_send_packet(
            decoder,
            BigInt(timestampMicroseconds),
            BigInt(timestampMicroseconds),
            BigInt(durationMicroseconds),
            packet.type === 'key' ? 1 : 0
        );
        if (sendResult < 0) {
            throw new Error(`The MPEG-2/VC-1 software decoder rejected a packet: ${sendResult}`);
        }
        this.emitAvailableFrames(module, decoder, false);
    }

    /** Drains every delayed picture and fails if any packet produced no output. */
    public flush(): void {
        const { decoder, module } = this.requireDecoder();
        const drainResult = module._mpeg2_vc1_decoder_start_drain(decoder);
        if (drainResult < 0 && drainResult !== module._mpeg2_vc1_decoder_error_eof()) {
            throw new Error(`The MPEG-2/VC-1 software decoder drain failed: ${drainResult}`);
        }
        this.emitAvailableFrames(module, decoder, true);
        if (this.durationsByTimestamp.size > 0) {
            throw new Error('The MPEG-2/VC-1 software decoder ended before every packet was output');
        }
    }

    /** Releases the codec context and queued packet timing. Later calls do nothing. */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.durationsByTimestamp.clear();
        if (this.module && this.decoder !== 0) {
            this.module._mpeg2_vc1_decoder_close(this.decoder);
        }
        this.decoder = 0;
        this.module = null;
    }

    private validateConfiguration(): void {
        if (
            (this.configuration.codec !== 'mpeg2video'
                && this.configuration.codec !== 'vc1')
            || !isPositiveSafeInteger(this.configuration.codedWidth)
            || !isPositiveSafeInteger(this.configuration.codedHeight)
        ) {
            throw new TypeError('The MPEG-2/VC-1 software decoder configuration is unsupported');
        }
        const description = this.configuration.description;
        if (
            (this.configuration.codec === 'mpeg2video' && description !== undefined)
            || (this.configuration.codec === 'vc1'
                && (!(description instanceof Uint8Array)
                    || description.byteLength === 0
                    || description.byteLength > MAXIMUM_DECODER_DESCRIPTION_BYTE_LENGTH))
        ) {
            throw new TypeError('The MPEG-2/VC-1 software decoder description is unsupported');
        }
        if (
            (this.configuration.displayWidth !== undefined
                || this.configuration.displayHeight !== undefined)
            && (!isPositiveSafeInteger(this.configuration.displayWidth)
                || !isPositiveSafeInteger(this.configuration.displayHeight))
        ) {
            throw new TypeError('The MPEG-2/VC-1 software decoder display dimensions are invalid');
        }
    }

    private requireDecoder(): {
        decoder: number
        module: MPEG2VC1DecoderModule
    } {
        if (this.closed) {
            throw new Error('The MPEG-2/VC-1 software decoder is closed');
        }
        if (!this.module || this.decoder === 0) {
            throw new Error('The MPEG-2/VC-1 software decoder is not initialized');
        }
        return { decoder: this.decoder, module: this.module };
    }

    private emitAvailableFrames(module: MPEG2VC1DecoderModule, decoder: number, draining: boolean): void {
        const againError = module._mpeg2_vc1_decoder_error_again();
        const eofError = module._mpeg2_vc1_decoder_error_eof();
        while (true) {
            const receiveResult = module._mpeg2_vc1_decoder_receive_frame(decoder);
            if (receiveResult === againError || receiveResult === eofError) {
                if (draining && receiveResult === againError) {
                    throw new Error('The MPEG-2/VC-1 software decoder drain ended before EOF');
                }
                return;
            }
            if (receiveResult < 0) {
                throw new Error(`The MPEG-2/VC-1 software decoder receive failed: ${receiveResult}`);
            }
            this.emitCurrentFrame(module, decoder);
        }
    }

    private emitCurrentFrame(module: MPEG2VC1DecoderModule, decoder: number): void {
        if (module._mpeg2_vc1_decoder_get_interlaced(decoder) !== 0) {
            throw new MPEG2VC1InterlacedFrameError(
                module._mpeg2_vc1_decoder_get_top_field_first(decoder) !== 0,
                module._mpeg2_vc1_decoder_get_repeat_picture(decoder)
            );
        }
        if (module._mpeg2_vc1_decoder_frame_is_i420(decoder) === 0) {
            throw new TypeError('The MPEG-2/VC-1 software decoder output is not 8-bit I420');
        }

        const timestampValue = module._mpeg2_vc1_decoder_get_timestamp(decoder);
        if (timestampValue === AV_NOPTS_VALUE) {
            throw new TypeError('The MPEG-2/VC-1 software decoder output has no timestamp');
        }
        const timestampMicroseconds = requireMicroseconds(Number(timestampValue), 'MPEG-2/VC-1 decoded frame timestamp');
        const queuedDuration = this.durationsByTimestamp.get(timestampMicroseconds);
        const decodedDuration = requireMicroseconds(
            Number(module._mpeg2_vc1_decoder_get_duration(decoder)),
            'MPEG-2/VC-1 decoded frame duration'
        );
        const durationMicroseconds = decodedDuration > 0 ? decodedDuration : queuedDuration;
        if (durationMicroseconds === undefined) {
            throw new Error('The MPEG-2/VC-1 software decoder output has no matching packet timing');
        }
        this.durationsByTimestamp.delete(timestampMicroseconds);

        const packedFrame = this.copyCurrentFrame(module, decoder);
        const visibleRectangle = this.getVisibleRectangle(module, decoder, packedFrame);
        const outputColorSpace = this.getOutputColorSpace(module, decoder);
        const sample = new VideoSample(packedFrame.data.buffer, {
            codedHeight: packedFrame.codedHeight,
            codedWidth: packedFrame.codedWidth,
            colorSpace: outputColorSpace,
            displayHeight: this.configuration.displayHeight,
            displayWidth: this.configuration.displayWidth,
            duration: microsecondsToSeconds(durationMicroseconds),
            format: 'I420',
            layout: [ ...packedFrame.layout ],
            timestamp: microsecondsToSeconds(timestampMicroseconds),
            visibleRect: visibleRectangle
        });
        try {
            this.callbacks.onSample(sample);
        } catch (error) {
            sample.close();
            throw error;
        }
    }

    private copyCurrentFrame(module: MPEG2VC1DecoderModule, decoder: number): PackedI420Frame {
        const codedWidth = module._mpeg2_vc1_decoder_get_width(decoder);
        const codedHeight = module._mpeg2_vc1_decoder_get_height(decoder);
        if (
            !isPositiveSafeInteger(codedWidth)
            || !isPositiveSafeInteger(codedHeight)
            || codedWidth > this.configuration.codedWidth
            || codedHeight > this.configuration.codedHeight
        ) {
            throw new TypeError('The MPEG-2/VC-1 decoded dimensions exceed the configuration');
        }
        const chromaWidth = Math.ceil(codedWidth / 2);
        const chromaHeight = Math.ceil(codedHeight / 2);
        const lumaByteLength = codedWidth * codedHeight;
        const chromaByteLength = chromaWidth * chromaHeight;
        const frameByteLength = lumaByteLength + (2 * chromaByteLength);
        if (!Number.isSafeInteger(frameByteLength) || frameByteLength <= 0) {
            throw new RangeError('The MPEG-2/VC-1 decoded frame size is not representable');
        }

        const data = new Uint8Array(frameByteLength);
        const planeDimensions = [
            { height: codedHeight, offset: 0, width: codedWidth },
            { height: chromaHeight, offset: lumaByteLength, width: chromaWidth },
            { height: chromaHeight, offset: lumaByteLength + chromaByteLength, width: chromaWidth }
        ] as const;
        for (let planeIndex = 0; planeIndex < planeDimensions.length; planeIndex += 1) {
            const dimensions = planeDimensions[planeIndex];
            copyPlane(
                module,
                toHeapAddress(module._mpeg2_vc1_decoder_get_plane(decoder, planeIndex)),
                module._mpeg2_vc1_decoder_get_stride(decoder, planeIndex),
                dimensions.width,
                dimensions.height,
                data,
                dimensions.offset
            );
        }
        return {
            codedHeight,
            codedWidth,
            data,
            layout: [
                { offset: 0, stride: codedWidth },
                { offset: lumaByteLength, stride: chromaWidth },
                { offset: lumaByteLength + chromaByteLength, stride: chromaWidth }
            ]
        };
    }

    private getVisibleRectangle(
        module: MPEG2VC1DecoderModule,
        decoder: number,
        frame: PackedI420Frame
    ): { height: number; left: number; top: number; width: number } {
        const left = module._mpeg2_vc1_decoder_get_crop_left(decoder);
        const top = module._mpeg2_vc1_decoder_get_crop_top(decoder);
        const right = module._mpeg2_vc1_decoder_get_crop_right(decoder);
        const bottom = module._mpeg2_vc1_decoder_get_crop_bottom(decoder);
        const width = frame.codedWidth - left - right;
        const height = frame.codedHeight - top - bottom;
        if (
            left < 0
            || top < 0
            || right < 0
            || bottom < 0
            || !isPositiveSafeInteger(width)
            || !isPositiveSafeInteger(height)
        ) {
            throw new TypeError('The MPEG-2/VC-1 decoded frame has invalid crop metadata');
        }
        return { height, left, top, width };
    }

    private getOutputColorSpace(module: MPEG2VC1DecoderModule, decoder: number): VideoColorSpaceInit {
        const configuredColorSpace = this.configuration.colorSpace;
        const colorRange = module._mpeg2_vc1_decoder_get_color_range(decoder);
        return {
            fullRange: getFullRange(colorRange, configuredColorSpace?.fullRange),
            matrix: getColorMatrix(module._mpeg2_vc1_decoder_get_color_matrix(decoder)) ?? configuredColorSpace?.matrix,
            primaries: getColorPrimaries(module._mpeg2_vc1_decoder_get_color_primaries(decoder)) ?? configuredColorSpace?.primaries,
            transfer: getColorTransfer(module._mpeg2_vc1_decoder_get_color_transfer(decoder)) ?? configuredColorSpace?.transfer
        };
    }
}
