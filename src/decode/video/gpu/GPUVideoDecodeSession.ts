// Runs one user WGSL video decoder on the presenter's device: the packet ring, the dispatch sequence, pacing, presentation order, slot release,
// and the recoveries from errors its header declares recoverable.
// The compressed packet is the only CPU to GPU transfer; decoded planes stay in the frame pool, which the signal step reads in place.
// The engine book's decoder packages chapter describes the route.
import { getDecoderErrorName } from '../../packages/DecoderHeader';
import type { DecoderPackageVersion } from '../../packages/DecoderPackageIdentity';
import { waitForGPUCompletion } from '../../../GPUCompletion';
import { evaluatePassExpression, PassExpressionError } from '../../../presentation/passes/PassExpression';
import type { FramePoolFrame, PassExpression } from '../../../presentation/passes/PassTypes';
import {
    BYTES_PER_WORD,
    INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH,
    OUT_OF_MEMORY_ERROR_FILTER,
    U32_VALUE_COUNT,
    UNIFORM_BUFFER_OFFSET_ALIGNMENT,
    VALIDATION_ERROR_FILTER,
    WORKGROUP_AXIS_NAMES
} from '../../../presentation/WebGPUConstants';
import { decodePictureFieldsWord, type VideoFrameFields } from '../VideoFields';
import { getGPUDecoderFormatFacts, type GPUDecoderOutputFormat } from './GPUDecodeFormats';
import {
    GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH,
    GPU_DECODE_SLICE_DISPATCH_COUNT,
    GPU_DECODER_ERROR_CODE_SHIFT,
    GPU_DECODER_MAXIMUM_DISPATCHES
} from './GPUDecodeLimits';
import {
    createGPUDecoderBindGroupLayoutEntries,
    createGPUDecoderModule,
    GPU_DECODER_BINDINGS,
    GPU_DECODER_FIRST_BUFFER_BINDING,
    GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH,
    GPU_DECODER_STATUS_BYTE_LENGTH,
    GPU_DECODER_STATUS_PACKET_BLOCK_BYTE_LENGTH,
    GPU_DECODER_STATUS_PACKET_BLOCK_BYTE_OFFSET,
    GPU_DECODER_STREAM_UNIFORM_BYTE_LENGTH,
    readGPUDecoderStatus,
    writeGPUDecoderPacketUniform,
    writeGPUDecoderStreamUniform
} from './GPUDecoderPrelude';
import { splitGPUDecoderModule } from './GPUDecoderEntryPointModules';
import { getGPUDecoderFacts } from './GPUDecoderManifest';
import { type GPUDecoderCompiledPipelines, getCompiledGPUDecoder } from './GPUDecoderPipelineCache';
import {
    evaluateGPUDecoderBufferSizes,
    findGPUDecoderBufferLimitFailure,
    getGPUDecoderPacketRingByteLength,
    type GPUDecoderBufferSizes
} from './GPUDecoderStreamFit';
import GPUFramePool, {
    alignTo,
    createGPUFramePoolLayout,
    getGPUFramePoolByteLimit,
    getGPUFramePoolSlotCount,
    requireGPUFramePoolCodedSize
} from './GPUFramePool';
import {
    GPU_DECODER_OUTPUT_EVENT,
    GPU_VIDEO_DECODE_RECOVERY_CODES,
    type GPUDecodePacket,
    type GPUDecoderCompileMessage,
    type GPUDecoderDispatch,
    type GPUDecoderDispatchRepeat,
    type GPUDecoderManifest,
    type GPUDecoderPictureSize,
    type GPUDecodeStreamFacts,
    GPUVideoDecodeError,
    type GPUVideoDecodeFailure,
    type GPUVideoDecodeRecovery
} from './GPUDecodeTypes';

// Each packet's uniform takes the next slot of one buffer at a dynamic offset, so a packet never creates a bind group
const PACKET_UNIFORM_SLOT_COUNT = 8;
// Packet uniforms sit one offset alignment apart, so every device accepts the dynamic offsets
const PACKET_UNIFORM_STRIDE = UNIFORM_BUFFER_OFFSET_ALIGNMENT;
// Readbacks in flight at once; every packet's status is read back, so a packet waits for a free one as it waits for a free slot
const STATUS_READBACK_COUNT = 3;
// The value bits of an error word, below its code
const ERROR_VALUE_MASK = (1 << GPU_DECODER_ERROR_CODE_SHIFT) - 1;
// A picture index the parser names at most half the index range behind the newest picture is an earlier one, which may have left already
const PICTURE_INDEX_HALF_RANGE = GPU_DECODER_OUTPUT_EVENT.pictureIndexModulus / 2;
// The live sessions of each device, which its loss fails
const liveSessionsByDevice = new WeakMap<GPUDevice, Set<GPUVideoDecodeSession>>();

/** What a session decodes and where. */
export type GPUVideoDecodeSessionOptions = {
    /** The codec private data from the container, such as a Matroska CodecPrivate, or null. */
    codecPrivate: Uint8Array | null
    /** The presenter's device, so decoded frames never leave GPU memory. */
    device: GPUDevice
    /** The package whose manifest this is, by its id and content hash, under which the device keeps the compiled decoder for later sessions; without one the session compiles its own. */
    decoderPackage?: DecoderPackageVersion
    /** The output format, one of those the decoder lists. */
    format: GPUDecoderOutputFormat
    manifest: GPUDecoderManifest
    stream: GPUDecodeStreamFacts
};

/** A decoded frame taken for presentation; it holds its slot until releaseFrame(). */
export type GPUDecodedFrame = {
    /** Due frames dropped when this frame was taken, for a temporal pass's soft reset. */
    droppedFrameCount: number
    durationMicroseconds: number
    /** The frame's fields: the decoder's own report, else what its packet carried, or null when nobody reported them. */
    fields: VideoFrameFields | null
    /** The slot's planes, with the frame's visible rectangle: its picture's own size, or the stream's. */
    frame: FramePoolFrame
    slot: number
    timestampMicroseconds: number
    /** The visible size the frame's picture reported, or null for one that keeps the stream's visible rectangle. */
    visibleSize: GPUDecoderPictureSize | null
};

type DecodedFrameEntry = {
    /** Set once its packet's status readback applied, or at once for a repeat; only confirmed frames present */
    confirmed: boolean
    durationMicroseconds: number
    fields: VideoFrameFields | null
    /** A repeat of the last good frame during a resync, which shares that frame's slot */
    held: boolean
    /** The packet's serial in submission order, counted since the session started, from which a resync replaces frames */
    packetSerial: number
    /** The picture's index in decode order, which a parser's output events name. */
    pictureIndex: number
    slot: number
    timestampMicroseconds: number
    visibleSize: GPUDecoderPictureSize | null
};

/** The last good frame a resync holds: the slot its repeats present, which the resync keeps an output hold on, and the frame's facts. */
type HeldFrame = Readonly<{
    fields: VideoFrameFields | null
    slot: number
    visibleSize: GPUDecoderPictureSize | null
}>;

/** A resync in progress, which ends at the next packet that decodes, a key packet, from a reset; null holds nothing, when no frame was left. */
type ResyncState = {
    heldFrame: HeldFrame | null
};

type PreparedDispatch =
    | { kind: 'direct'; pipeline: GPUComputePipeline; workgroupCounts: readonly [number, number, number] }
    | { indirectMirror: GPUBuffer; indirectSource: GPUBuffer; kind: 'indirect'; pipeline: GPUComputePipeline };

type DispatchPlan =
    | { entryPoint: string; kind: 'direct'; workgroupCounts: readonly [number, number, number] }
    | { bufferIndex: number; entryPoint: string; kind: 'indirect' };

/**
 * A run of the dispatch sequence: one dispatch, or the dispatches of a `repeat:` directive, which run its count for the stream,
 * or a picture's own count for the directive when that is smaller.
 */
type DispatchRun<Dispatch> = {
    count: number
    dispatches: readonly Dispatch[]
    /** The directive's position among the header's `repeat:` directives, or null for a dispatch outside any */
    repeatIndex: number | null
};

type StatusReadback = {
    buffer: GPUBuffer
    /** The frame of the packet whose status the readback captures, until the readback applies */
    entry: DecodedFrameEntry | null
    /** The reset epoch the packet began in; a readback of an earlier epoch is stale. */
    epoch: number
};

/** A packet whose decode work submits a slice at a time: its first slice clears the decoder at a reset, and its last copies its status into its readback. */
type SlicedPacket = {
    /** The packet's dispatches in order, repeats expanded */
    readonly dispatches: readonly PreparedDispatch[]
    readonly label: string
    /** The first dispatch of the next slice */
    nextDispatchIndex: number
    readonly readback: StatusReadback
    readonly reset: boolean
    readonly sliceDispatchCount: number
    readonly uniformOffset: number
};

type SessionResources = {
    bindGroupLayout: GPUBindGroupLayout
    dispatchRuns: readonly DispatchRun<DispatchPlan>[]
    pipelines: ReadonlyMap<string, GPUComputePipeline>
    sizes: GPUDecoderBufferSizes
};

/** Evaluates one workgroup count, which must be an integer the device dispatches; `<entry point> <axis>` prefixes its failure detail. */
function evaluateWorkgroupCount(
    count: PassExpression,
    facts: ReadonlyMap<string, number>,
    subject: string,
    maximum: number
): number {
    let value: number;
    try {
        value = evaluatePassExpression(count, facts);
    } catch (error) {
        if (error instanceof PassExpressionError) {
            throw new GPUVideoDecodeError({ code: 'dispatch-count', detail: `${subject} ${error.message}` });
        }
        throw error;
    }
    if (!Number.isInteger(value) || value < 0 || value > maximum) {
        throw new GPUVideoDecodeError({ code: 'dispatch-count', detail: `${subject} ${value} outside integers [0, ${maximum}]` });
    }
    return value;
}

/** Plans one dispatch for the stream, or null for a direct dispatch without workgroups for it, which encodes nothing. */
function planDispatch(manifest: GPUDecoderManifest, dispatch: GPUDecoderDispatch, facts: ReadonlyMap<string, number>, maximumCount: number): DispatchPlan | null {
    // The manifest parser guarantees one of the two dispatch forms and a declared indirect buffer
    if (dispatch.indirectBuffer !== null) {
        const bufferIndex = manifest.buffers.findIndex(buffer => buffer.name === dispatch.indirectBuffer && buffer.indirect);
        if (bufferIndex < 0) {
            throw new RangeError(`dispatch: '${dispatch.entryPoint}' reads undeclared indirect buffer '${dispatch.indirectBuffer}'`);
        }
        return { bufferIndex, entryPoint: dispatch.entryPoint, kind: 'indirect' };
    }
    if (!dispatch.workgroupCounts) {
        throw new RangeError(`dispatch: '${dispatch.entryPoint}' has no workgroup counts`);
    }
    const counts = dispatch.workgroupCounts.map((count, axisIndex): number => evaluateWorkgroupCount(
        count,
        facts,
        `${dispatch.entryPoint} ${WORKGROUP_AXIS_NAMES[axisIndex]}`,
        maximumCount
    ));
    if (counts.some((count: number): boolean => count === 0)) {
        return null;
    }
    return { entryPoint: dispatch.entryPoint, kind: 'direct', workgroupCounts: [ counts[0], counts[1], counts[2] ] };
}

/**
 * Evaluates every dispatch's workgroup counts and every repeat's count once, from the stream and output format facts; nothing is evaluated per packet.
 * The sequence becomes runs: each dispatch outside a repeat once, and each repeat's dispatches its count of times, all within GPU_DECODER_MAXIMUM_DISPATCHES.
 */
function planDispatches(
    manifest: GPUDecoderManifest,
    stream: GPUDecodeStreamFacts,
    format: GPUDecoderOutputFormat,
    maximumCount: number
): DispatchRun<DispatchPlan>[] {
    const facts = getGPUDecoderFacts(stream, format);
    const dispatchPlans = manifest.dispatches.map((dispatch: GPUDecoderDispatch): DispatchPlan | null => planDispatch(manifest, dispatch, facts, maximumCount));
    const repeatIndicesByFirstDispatch = new Map(manifest.repeats.map(
        (repeat: GPUDecoderDispatchRepeat, repeatIndex: number): [ number, number ] => [ repeat.firstDispatch, repeatIndex ]
    ));
    const runs: DispatchRun<DispatchPlan>[] = [];
    let plannedDispatchCount = 0;
    let dispatchIndex = 0;
    while (dispatchIndex < dispatchPlans.length) {
        const repeatIndex = repeatIndicesByFirstDispatch.get(dispatchIndex) ?? null;
        const repeat = repeatIndex === null ? null : manifest.repeats[repeatIndex];
        const runLength = repeat?.dispatchCount ?? 1;
        const runPlans = dispatchPlans.slice(dispatchIndex, dispatchIndex + runLength)
            .filter((plan: DispatchPlan | null): plan is DispatchPlan => plan !== null);
        const runCount = repeat ? evaluateWorkgroupCount(repeat.count, facts, `repeat at dispatch ${dispatchIndex}`, GPU_DECODER_MAXIMUM_DISPATCHES) : 1;
        plannedDispatchCount += runCount * runPlans.length;
        if (plannedDispatchCount > GPU_DECODER_MAXIMUM_DISPATCHES) {
            throw new GPUVideoDecodeError({ code: 'dispatch-count', detail: `${plannedDispatchCount} dispatches > ${GPU_DECODER_MAXIMUM_DISPATCHES}` });
        }
        if (runCount > 0 && runPlans.length > 0) {
            runs.push({ count: runCount, dispatches: runPlans, repeatIndex });
        }
        dispatchIndex += runLength;
    }
    return runs;
}

/** Returns how many times a packet runs a run of the sequence: its count, or a picture's own smaller count for the run's repeat. */
function getRunIterationCount(run: DispatchRun<PreparedDispatch>, repeatCounts: readonly number[] | null): number {
    if (run.repeatIndex === null || repeatCounts === null) {
        return run.count;
    }
    return Math.min(run.count, repeatCounts[run.repeatIndex]);
}

/** Returns whether a picture's visible size is whole, nonempty, and within a coded size. */
function isPictureSizeWithin(visibleSize: GPUDecoderPictureSize, codedWidth: number, codedHeight: number): boolean {
    return Number.isSafeInteger(visibleSize.width)
        && Number.isSafeInteger(visibleSize.height)
        && visibleSize.width > 0
        && visibleSize.height > 0
        && visibleSize.width <= codedWidth
        && visibleSize.height <= codedHeight;
}

/** Requires a visible rectangle of whole pixels inside the coded frame, which the executor maps presentation onto. */
function requireVisibleRectangle(stream: GPUDecodeStreamFacts): void {
    const rectangle = stream.visibleRectangle;
    const description = `${rectangle.x},${rectangle.y} ${rectangle.width}x${rectangle.height}`;
    const values = [ rectangle.x, rectangle.y, rectangle.width, rectangle.height ];
    if (!values.every(value => Number.isSafeInteger(value) && value >= 0) || rectangle.width === 0 || rectangle.height === 0) {
        throw new GPUVideoDecodeError({ code: 'visible-rectangle', detail: `${description} is not a nonempty integer rectangle` });
    }
    if (rectangle.x + rectangle.width > stream.codedWidth || rectangle.y + rectangle.height > stream.codedHeight) {
        throw new GPUVideoDecodeError({ code: 'visible-rectangle', detail: `${description} exceeds ${stream.codedWidth}x${stream.codedHeight}` });
    }
}

/**
 * Requires the decoder's features, a device that binds every storage buffer of the decoder's bind group layout,
 * and buffer and binding limits that hold the state, each scratch buffer, and the packet ring whole.
 */
function requireDeviceSupport(
    device: GPUDevice,
    manifest: GPUDecoderManifest,
    sizes: GPUDecoderBufferSizes,
    layoutEntries: readonly GPUBindGroupLayoutEntry[]
): void {
    const missingFeatures = manifest.requiredFeatures.filter(feature => !device.features.has(feature));
    if (missingFeatures.length > 0) {
        throw new GPUVideoDecodeError({ code: 'feature-missing', detail: missingFeatures.join(', ') });
    }
    const storageBufferCount = layoutEntries.filter(entry => entry.buffer !== undefined && entry.buffer.type !== 'uniform').length;
    const storageBufferLimit = device.limits.maxStorageBuffersPerShaderStage;
    if (storageBufferCount > storageBufferLimit) {
        throw new GPUVideoDecodeError({ code: 'storage-buffer-count', detail: `${storageBufferCount} > ${storageBufferLimit}` });
    }
    const failure = findGPUDecoderBufferLimitFailure(manifest, sizes, getGPUFramePoolByteLimit(device.limits));
    if (failure) {
        throw new GPUVideoDecodeError(failure);
    }
}

/** Returns an error's name and message, the detail of a failure the browser raised. */
function describeError(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Maps compile messages past the prelude to the decoder's own source lines. */
function mapCompilationMessages(
    messages: readonly GPUCompilationMessage[],
    firstBodyLine: number,
    sourceBodyFirstLine: number
): GPUDecoderCompileMessage[] {
    return messages
        .filter(message => message.type === 'error')
        .map((message): GPUDecoderCompileMessage => (message.lineNum >= firstBodyLine ?
            {
                column: message.linePos,
                line: message.lineNum - firstBodyLine + sourceBodyFirstLine,
                message: message.message,
                source: 'decoder'
            } :
            { column: message.linePos, line: message.lineNum, message: message.message, source: 'prelude' }));
}

/** Returns `line <line>:<column> <message>`, with `prelude` before a line of the generated prelude. */
function describeCompileMessage(message: GPUDecoderCompileMessage): string {
    const location = `line ${message.line}:${message.column}`;
    return message.source === 'decoder' ? `${location} ${message.message}` : `prelude ${location} ${message.message}`;
}

/** A compiled shader module, the errors its compile reported, mapped to the decoder's source, and the validation error it raised. */
type CompiledShaderModule = Readonly<{
    errors: readonly GPUDecoderCompileMessage[]
    module: GPUShaderModule
    validationError: GPUError | null
}>;

/** Compiles one module whose lines are the decoder module's, so its messages map to the decoder's source as the whole module's do. */
async function compileShaderModule(
    device: GPUDevice,
    code: string,
    label: string,
    firstBodyLine: number,
    sourceBodyFirstLine: number
): Promise<CompiledShaderModule> {
    // Invalid WGSL also raises a validation error, which the scope captures; each scope opens and closes synchronously, so it nests inside any other
    device.pushErrorScope(VALIDATION_ERROR_FILTER);
    const shaderModule = device.createShaderModule({ code, label });
    const shaderModuleError = device.popErrorScope();
    const compilationInfo = await shaderModule.getCompilationInfo();
    const validationError = await shaderModuleError;
    return { errors: mapCompilationMessages(compilationInfo.messages, firstBodyLine, sourceBodyFirstLine), module: shaderModule, validationError };
}

function isCleanCompile(compiled: CompiledShaderModule): boolean {
    return compiled.errors.length === 0 && compiled.validationError === null;
}

/** Returns a compiled module, or rejects as 'compile-error' with every message mapped to the decoder's source. */
function requireCleanCompile(compiled: CompiledShaderModule): GPUShaderModule {
    if (compiled.errors.length > 0) {
        throw new GPUVideoDecodeError({ code: 'compile-error', detail: describeCompileMessage(compiled.errors[0]) }, compiled.errors);
    }
    if (compiled.validationError) {
        throw new GPUVideoDecodeError({ code: 'compile-error', detail: compiled.validationError.message });
    }
    return compiled.module;
}

/**
 * Compiles each entry point's own module, the declarations it reaches, and returns every entry point's module.
 * When the split does not understand the module, or any entry point's module fails, the whole module compiles instead:
 * its errors are the decoder's, reported as WGSL defines them, and a whole module that compiles serves every entry point.
 */
async function compileEntryPointModules(device: GPUDevice, manifest: GPUDecoderManifest, format: GPUDecoderOutputFormat): Promise<ReadonlyMap<string, GPUShaderModule>> {
    const decoderModule = createGPUDecoderModule(manifest, format);
    const entryPoints = getEntryPoints(manifest);
    const entryPointCodes = splitGPUDecoderModule(decoderModule.code, entryPoints);
    if (entryPointCodes !== null) {
        const compiled = await Promise.all(entryPoints.map((entryPoint: string): Promise<CompiledShaderModule> => compileShaderModule(
            device,
            entryPointCodes.get(entryPoint) ?? decoderModule.code,
            `GPU decoder ${manifest.name}: ${entryPoint}`,
            decoderModule.firstBodyLine,
            manifest.bodyFirstLine
        )));
        if (compiled.every(isCleanCompile)) {
            return new Map(entryPoints.map((entryPoint: string, entryPointIndex: number): [ string, GPUShaderModule ] => [ entryPoint, compiled[entryPointIndex].module ]));
        }
    }
    const wholeModule = requireCleanCompile(await compileShaderModule(
        device,
        decoderModule.code,
        `GPU decoder ${manifest.name}`,
        decoderModule.firstBodyLine,
        manifest.bodyFirstLine
    ));
    return new Map(entryPoints.map((entryPoint: string): [ string, GPUShaderModule ] => [ entryPoint, wholeModule ]));
}

/** Returns the decoder's entry points, each once, in dispatch order. */
function getEntryPoints(manifest: GPUDecoderManifest): string[] {
    return [ ...new Set(manifest.dispatches.map(dispatch => dispatch.entryPoint)) ];
}

async function createPipelines(
    device: GPUDevice,
    manifest: GPUDecoderManifest,
    shaderModules: ReadonlyMap<string, GPUShaderModule>,
    pipelineLayout: GPUPipelineLayout
): Promise<Map<string, GPUComputePipeline>> {
    const entryPoints = getEntryPoints(manifest);
    const pipelines = await Promise.all(entryPoints.map(async (entryPoint): Promise<GPUComputePipeline> => {
        const shaderModule = shaderModules.get(entryPoint);
        if (!shaderModule) {
            throw new GPUVideoDecodeError({ code: 'pipeline-error', detail: `${entryPoint} has no module` });
        }
        try {
            return await device.createComputePipelineAsync({
                compute: { entryPoint, module: shaderModule },
                label: `GPU decoder ${manifest.name}: ${entryPoint}`,
                layout: pipelineLayout
            });
        } catch (error) {
            throw new GPUVideoDecodeError({ code: 'pipeline-error', detail: `${entryPoint} ${describeError(error)}` });
        }
    }));
    return new Map(entryPoints.map((entryPoint, index) => [ entryPoint, pipelines[index] ]));
}

/**
 * Compiles a decoder for an output format on a device: a module for each entry point, the bind group layout of its bindings, and a pipeline for each entry point.
 * Invalid WGSL rejects as 'compile-error', with every message mapped to the decoder's source, and a pipeline the device refuses as 'pipeline-error'.
 */
async function compileDecoder(
    device: GPUDevice,
    manifest: GPUDecoderManifest,
    format: GPUDecoderOutputFormat,
    layoutEntries: readonly GPUBindGroupLayoutEntry[]
): Promise<GPUDecoderCompiledPipelines> {
    const shaderModules = await compileEntryPointModules(device, manifest, format);
    const bindGroupLayout = device.createBindGroupLayout({ entries: layoutEntries, label: `GPU decoder ${manifest.name}` });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [ bindGroupLayout ], label: `GPU decoder ${manifest.name}` });
    const pipelines = await createPipelines(device, manifest, shaderModules, pipelineLayout);
    return { bindGroupLayout, pipelines };
}

/**
 * Decodes compressed packets into frame pool slots on the presenter's device.
 * Packets queue in decode order; submitPendingDecodeWork() encodes one packet's dispatches at a time, as far ahead as free slots and readbacks allow.
 * Every packet's status is read back, and its frame presents only once that readback applied: a fatal error ends the attempt,
 * and a recoverable one presents the concealed picture, drops it, or resyncs at the next key packet while the last good frame holds.
 * A decoder without a parser releases its frames in timestamp order once its declared reorder depth is filled;
 * a decoder with one releases or drops each frame when its parser's output events say so.
 * Each frame holds its slot until presentation releases it.
 */
export default class GPUVideoDecodeSession {
    readonly format: GPUDecoderOutputFormat;
    readonly manifest: GPUDecoderManifest;
    readonly pool: GPUFramePool;
    private readonly bindGroup: GPUBindGroup;
    private readonly device: GPUDevice;
    private readonly dispatchRuns: readonly DispatchRun<PreparedDispatch>[];
    private droppedFrameCount = 0;
    private destroyed = false;
    // A parser's events that came with the end of the stream, for its last packets without a picture
    private endOfStreamEvents: Uint32Array | null = null;
    private endOfStreamPending = false;
    private epoch = 0;
    private failure: GPUVideoDecodeFailure | null = null;
    private readonly freeReadbacks: StatusReadback[] = [];
    // Frames whose output a parser has not decided yet, in decode order
    private readonly parserFrames: DecodedFrameEntry[] = [];
    private readonly parserOutput: boolean;
    private headerFacts: GPUDecodeStreamFacts | null = null;
    private readonly inFlightReadbacks = new Set<Promise<void>>();
    // The completion of each submitted slice whose work may still run
    private readonly inFlightSlices = new Set<Promise<void>>();
    private lastReleasedTimestampMicroseconds = Number.NEGATIVE_INFINITY;
    // The serial the next consumed packet takes, counted in submission order since the session started
    private nextPacketSerial = 0;
    // The index the next submitted picture takes, counted in decode order since the last reset
    private nextPictureIndex = 0;
    private readonly ownedBuffers: GPUBuffer[] = [];
    private packetIndex = 0;
    private readonly packetRing: GPUBuffer;
    private readonly packetRingByteLength: number;
    private readonly packetTail = new Uint8Array(BYTES_PER_WORD);
    private readonly packetUniformValues = new Uint32Array(GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH / BYTES_PER_WORD);
    private packetUniformSlot = 0;
    private readonly packetUniforms: GPUBuffer;
    private readonly pendingPackets: GPUDecodePacket[] = [];
    private readonly presentableFrames: DecodedFrameEntry[] = [];
    // Recoveries since takeRecoveries() last took them
    private readonly recoveries: GPUVideoDecodeRecovery[] = [];
    private readonly reorderFrames: DecodedFrameEntry[] = [];
    private resetPending = true;
    private resync: ResyncState | null = null;
    private ringByteOffset = 0;
    // The packet whose decode work is submitting, a slice at a time
    private slicedPacket: SlicedPacket | null = null;
    private readonly stateBuffer: GPUBuffer;
    private readonly statusBuffer: GPUBuffer;
    private readonly takenFrames = new Set<GPUDecodedFrame>();

    private constructor(options: GPUVideoDecodeSessionOptions, resources: SessionResources) {
        const { device, format, manifest, stream } = options;
        this.device = device;
        this.format = format;
        this.manifest = manifest;
        this.parserOutput = manifest.parser !== null;
        // The pool goes first: it is the one allocation a device's limits can refuse
        this.pool = new GPUFramePool(
            device,
            createGPUFramePoolLayout(
                format,
                stream.codedWidth,
                stream.codedHeight,
                getGPUFramePoolSlotCount(manifest.references, manifest.reorder)
            ),
            stream.visibleRectangle
        );
        try {
            this.packetRingByteLength = getGPUDecoderPacketRingByteLength(manifest);
            this.packetRing = this.createBuffer('packet ring', this.packetRingByteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
            this.packetUniforms = this.createBuffer(
                'packet uniforms',
                PACKET_UNIFORM_STRIDE * PACKET_UNIFORM_SLOT_COUNT,
                GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            );
            const configBuffer = this.createConfigBuffer(options.codecPrivate);
            const streamBuffer = this.createStreamBuffer(stream, format, options.codecPrivate?.byteLength ?? 0);
            this.stateBuffer = this.createBuffer(
                'state',
                Math.max(BYTES_PER_WORD, alignTo(resources.sizes.stateByteLength, BYTES_PER_WORD)),
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            );
            this.statusBuffer = this.createBuffer(
                'status',
                GPU_DECODER_STATUS_BYTE_LENGTH,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
            );
            const scratchBuffers = manifest.buffers.map((buffer, bufferIndex) => this.createBuffer(
                `buffer ${buffer.name}`,
                alignTo(resources.sizes.bufferByteLengths[bufferIndex], BYTES_PER_WORD),
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
            ));
            for (let readbackIndex = 0; readbackIndex < STATUS_READBACK_COUNT; readbackIndex += 1) {
                this.freeReadbacks.push({
                    buffer: this.createBuffer(`status readback ${readbackIndex}`, GPU_DECODER_STATUS_BYTE_LENGTH, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
                    entry: null,
                    epoch: 0
                });
            }
            this.dispatchRuns = this.prepareDispatchRuns(resources, scratchBuffers);
            const entries: GPUBindGroupEntry[] = [];
            entries.push(
                { binding: GPU_DECODER_BINDINGS.packetBytes, resource: { buffer: this.packetRing } },
                { binding: GPU_DECODER_BINDINGS.packet, resource: { buffer: this.packetUniforms, size: GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH } },
                { binding: GPU_DECODER_BINDINGS.config, resource: { buffer: configBuffer } },
                { binding: GPU_DECODER_BINDINGS.stream, resource: { buffer: streamBuffer } },
                { binding: GPU_DECODER_BINDINGS.state, resource: { buffer: this.stateBuffer } },
                { binding: GPU_DECODER_BINDINGS.framePool, resource: { buffer: this.pool.buffer } },
                { binding: GPU_DECODER_BINDINGS.status, resource: { buffer: this.statusBuffer } }
            );
            for (let bufferIndex = 0; bufferIndex < scratchBuffers.length; bufferIndex += 1) {
                entries.push({ binding: GPU_DECODER_FIRST_BUFFER_BINDING + bufferIndex, resource: { buffer: scratchBuffers[bufferIndex] } });
            }
            this.bindGroup = device.createBindGroup({ entries, label: `GPU decoder ${manifest.name}`, layout: resources.bindGroupLayout });
        } catch (error) {
            // A session that never existed leaves no buffers behind; the error still reaches the caller
            this.destroy();
            throw error;
        }
    }

    /**
     * Compiles a decoder for one of its output formats on a device and allocates its pool and buffers.
     * With its package, the device keeps the compiled decoder, so a later session of the same package version and format compiles nothing.
     * Rejects with a GPUVideoDecodeError whose failure names the check: 'format-unsupported', 'codec-private-size', 'coded-size', 'visible-rectangle', 'state-size', 'buffer-size', 'feature-missing', 'storage-buffer-count', 'packet-size' for a packet ring the device cannot bind, 'dispatch-count', 'compile-error', 'pipeline-error', 'slot-count', 'pool-size', 'out-of-memory', or 'validation-error'.
     * A 'compile-error' carries every compile message, with lines that point into the decoder's source.
     * The decoder shares the presenter's device, so error scopes keep its compile and allocation errors from presentation's uncaptured error handler.
     */
    static async create(options: GPUVideoDecodeSessionOptions): Promise<GPUVideoDecodeSession> {
        const { device, format, manifest, stream } = options;
        if (!manifest.outputFormats.includes(format)) {
            throw new GPUVideoDecodeError({ code: 'format-unsupported', detail: `${format} not in ${manifest.outputFormats.join(', ')}` });
        }
        const codecPrivateByteLength = options.codecPrivate?.byteLength ?? 0;
        if (codecPrivateByteLength > GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH) {
            throw new GPUVideoDecodeError({
                code: 'codec-private-size',
                detail: `${codecPrivateByteLength} > ${GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH}`
            });
        }
        requireGPUFramePoolCodedSize(stream.codedWidth, stream.codedHeight);
        requireVisibleRectangle(stream);
        const sizes = evaluateGPUDecoderBufferSizes(manifest, stream, format);
        const layoutEntries = createGPUDecoderBindGroupLayoutEntries(manifest.buffers.length);
        requireDeviceSupport(device, manifest, sizes, layoutEntries);
        const dispatchRuns = planDispatches(manifest, stream, format, device.limits.maxComputeWorkgroupsPerDimension);

        const decoderPackage = options.decoderPackage;
        const compile = (): Promise<GPUDecoderCompiledPipelines> => compileDecoder(device, manifest, format, layoutEntries);
        const { bindGroupLayout, pipelines } = await (decoderPackage === undefined ? compile() : getCompiledGPUDecoder(device, decoderPackage, format, compile));
        const session = await GPUVideoDecodeSession.allocate(options, { bindGroupLayout, dispatchRuns, pipelines, sizes });
        session.observeDeviceLoss();
        return session;
    }

    /** Constructs a session inside out-of-memory and validation scopes, so a refused allocation fails the session instead of presentation. */
    private static async allocate(options: GPUVideoDecodeSessionOptions, resources: SessionResources): Promise<GPUVideoDecodeSession> {
        const device = options.device;
        device.pushErrorScope(OUT_OF_MEMORY_ERROR_FILTER);
        device.pushErrorScope(VALIDATION_ERROR_FILTER);
        let session: GPUVideoDecodeSession | null = null;
        let constructionError: unknown = null;
        try {
            session = new GPUVideoDecodeSession(options, resources);
        } catch (error) {
            constructionError = error;
        }
        const validationScope = device.popErrorScope();
        const memoryScope = device.popErrorScope();
        const [ validationError, memoryError ] = await Promise.all([ validationScope, memoryScope ]);
        // A constructor that threw destroyed what it built
        if (session === null) {
            throw constructionError;
        }
        if (memoryError) {
            session.destroy();
            throw new GPUVideoDecodeError({ code: 'out-of-memory', detail: memoryError.message });
        }
        if (validationError) {
            session.destroy();
            throw new GPUVideoDecodeError({ code: 'validation-error', detail: validationError.message });
        }
        return session;
    }

    /**
     * Queues a compressed packet, or one picture's record, in decode order; it waits for submitPendingDecodeWork() and a free slot.
     * A picture's own visible size must lie within the pool's coded size, and its repeat counts name every repeat of the header.
     */
    queuePacket(packet: GPUDecodePacket): void {
        if (this.destroyed || this.failure) {
            return;
        }
        if (packet.data.byteLength > this.manifest.packetByteLength) {
            this.fail({ code: 'packet-size', detail: `${packet.data.byteLength} > ${this.manifest.packetByteLength}` });
            return;
        }
        if (packet.repeatCounts !== null && packet.repeatCounts.length !== this.manifest.repeats.length) {
            this.fail({ code: 'dispatch-count', detail: `picture repeat counts ${packet.repeatCounts.length}, header repeats ${this.manifest.repeats.length}` });
            return;
        }
        const visibleSize = packet.visibleSize;
        const layout = this.pool.layout;
        if (visibleSize && !isPictureSizeWithin(visibleSize, layout.codedWidth, layout.codedHeight)) {
            this.fail({ code: 'visible-rectangle', detail: `picture ${visibleSize.width}x${visibleSize.height} exceeds ${layout.codedWidth}x${layout.codedHeight}` });
            return;
        }
        this.pendingPackets.push(packet);
    }

    /**
     * Submits one slice of decode work: the next of the packet in progress, else the first of the next queued packet once a slot and a readback are free;
     * or consumes a held packet, which decodes nothing. Returns whether it submitted or consumed anything.
     * The caller paces the calls by getInFlightSliceCount(), which bounds the decode work a presentation submit queues behind.
     */
    submitPendingDecodeWork(): boolean {
        if (this.destroyed || this.failure) {
            return false;
        }
        const submitted = this.slicedPacket ? this.submitNextSlice(this.slicedPacket) : this.startNextPacket();
        this.flushEndOfStreamIfDecoded();
        return submitted;
    }

    /**
     * Returns the newest decoded frame due at the target time, and releases older due frames as dropped.
     * Frames leave in presentation order, and only once their packet's status confirmed them.
     * The frame holds its slot until releaseFrame(); null when no frame is due or the session failed.
     */
    takeFrame(targetTimeMicroseconds: number): GPUDecodedFrame | null {
        if (this.destroyed || this.failure) {
            return null;
        }
        let selectedIndex = -1;
        for (let frameIndex = 0; frameIndex < this.presentableFrames.length; frameIndex += 1) {
            const entry = this.presentableFrames[frameIndex];
            if (!entry.confirmed || entry.timestampMicroseconds > targetTimeMicroseconds) {
                break;
            }
            selectedIndex = frameIndex;
        }
        if (selectedIndex < 0) {
            return null;
        }
        const consumedFrames = this.presentableFrames.splice(0, selectedIndex + 1);
        const selectedFrame = consumedFrames[consumedFrames.length - 1];
        for (let droppedIndex = 0; droppedIndex < consumedFrames.length - 1; droppedIndex += 1) {
            this.pool.releaseOutput(consumedFrames[droppedIndex].slot);
        }
        this.droppedFrameCount += consumedFrames.length - 1;
        return this.createTakenFrame(selectedFrame, consumedFrames.length - 1);
    }

    /** Returns the earliest decoded frame regardless of time, as a conformance check reads every frame, once its packet's status confirmed it. */
    takeNextFrame(): GPUDecodedFrame | null {
        if (this.destroyed || this.failure) {
            return null;
        }
        const nextFrame = this.presentableFrames.at(0);
        if (!nextFrame || !nextFrame.confirmed) {
            return null;
        }
        this.presentableFrames.shift();
        return this.createTakenFrame(nextFrame, 0);
    }

    /** Ends presentation's hold on a taken frame's slot; the slot is free once the decoder holds no reference to it. */
    releaseFrame(frame: GPUDecodedFrame): boolean {
        if (!this.takenFrames.delete(frame)) {
            return false;
        }
        if (!this.destroyed) {
            this.pool.releaseOutput(frame.slot);
        }
        return true;
    }

    /**
     * Drops queued packets, the rest of the packet in progress, and decoded frames that were not taken, and every decoder reference, for a seek or a new video epoch.
     * The next packet decodes as a reset, which clears the state and status buffers, whether or not it carries the flag.
     */
    reset(): void {
        if (this.destroyed) {
            return;
        }
        this.beginDecoderEpoch();
        this.pendingPackets.length = 0;
        for (const entry of [ ...this.parserFrames, ...this.reorderFrames, ...this.presentableFrames ]) {
            this.pool.releaseOutput(entry.slot);
        }
        this.parserFrames.length = 0;
        this.reorderFrames.length = 0;
        this.presentableFrames.length = 0;
        this.abandonSlicedPacket();
        this.releaseHeldFrame();
        this.endOfStreamPending = false;
        this.endOfStreamEvents = null;
        this.lastReleasedTimestampMicroseconds = Number.NEGATIVE_INFINITY;
        this.nextPictureIndex = 0;
        this.resetPending = true;
    }

    /**
     * Numbers the next picture with the parser's index for it, for a session that takes over a parser's pictures at a stream change.
     * Call it before the session's first packet, which must not carry `reset`, since a reset restarts the numbering; a new session clears its state on its first packet anyway.
     */
    continuePictureNumbering(nextPictureIndex: number): void {
        this.nextPictureIndex = nextPictureIndex % GPU_DECODER_OUTPUT_EVENT.pictureIndexModulus;
    }

    /**
     * Releases the frames the reorder depth or the parser still holds once every queued packet has decoded, since no earlier frame can follow.
     * outputEvents are a parser's events for the last packets, which had no picture to carry them; they apply first,
     * and the frames still undecided then present in timestamp order, as a parser's output process does at the end of a stream.
     */
    endOfStream(outputEvents: Uint32Array | null = null): void {
        this.endOfStreamPending = true;
        this.endOfStreamEvents = outputEvents;
        this.flushEndOfStreamIfDecoded();
    }

    /** Resolves once every status readback in flight has been applied. */
    async waitForStatusReadbacks(): Promise<void> {
        while (this.inFlightReadbacks.size > 0) {
            await Promise.all([ ...this.inFlightReadbacks ]);
        }
    }

    /**
     * Resolves once the next submitted slice's work completed, which lets the next slice go, or the next status readback applied,
     * which frees its readback, may free slots, and confirms its frame; at once when neither is in flight.
     */
    async waitForDecodeProgress(): Promise<void> {
        if (this.inFlightSlices.size > 0 || this.inFlightReadbacks.size > 0) {
            await Promise.race([ ...this.inFlightSlices, ...this.inFlightReadbacks ]);
        }
    }

    /** Returns how many packets' decode has not finished: the packet in progress, and each submitted packet whose status readback has not applied yet. */
    getInFlightPacketCount(): number {
        return this.inFlightReadbacks.size + (this.slicedPacket ? 1 : 0);
    }

    /** Returns how many submitted slices' work may still run. */
    getInFlightSliceCount(): number {
        return this.inFlightSlices.size;
    }

    /**
     * Submits the rest of the packet in progress, then resolves once the status of every submitted packet has been read back and applied;
     * each packet's status is captured with its last slice.
     * A conformance check calls it after the last packet, so a decoder error that packet reports is never missed.
     */
    async flushStatusReadbacks(): Promise<void> {
        for (let sliced = this.slicedPacket; sliced !== null && !this.destroyed && !this.failure; sliced = this.slicedPacket) {
            this.submitNextSlice(sliced);
        }
        await this.waitForStatusReadbacks();
    }

    getDroppedFrameCount(): number {
        return this.droppedFrameCount;
    }

    /** Returns the recoveries since the previous call, in the order they happened: each recoverable error the decoder or its parser reported. */
    takeRecoveries(): GPUVideoDecodeRecovery[] {
        return this.recoveries.splice(0);
    }

    getFailure(): GPUVideoDecodeFailure | null {
        return this.failure;
    }

    getFreeSlotCount(): number {
        return this.pool.getFreeSlotCount();
    }

    /** Returns the stream facts the decoder parsed from a header, from the first readback that reported them. */
    getHeaderFacts(): GPUDecodeStreamFacts | null {
        return this.headerFacts;
    }

    getPendingPacketCount(): number {
        return this.pendingPackets.length;
    }

    /** Returns the decoded frames waiting for presentation, including those the reorder depth or the parser holds back. */
    getQueuedFrameCount(): number {
        return this.parserFrames.length + this.reorderFrames.length + this.presentableFrames.length;
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        liveSessionsByDevice.get(this.device)?.delete(this);
        this.slicedPacket = null;
        this.pendingPackets.length = 0;
        this.parserFrames.length = 0;
        this.reorderFrames.length = 0;
        this.presentableFrames.length = 0;
        this.takenFrames.clear();
        for (const buffer of this.ownedBuffers) {
            buffer.destroy();
        }
        this.pool.destroy();
    }

    /**
     * Drops every decoder reference, as a reset clears the decoder's state, and makes the status readbacks taken before it stale.
     * A stale readback frees no slots, because the slots it reports freed may already be references of the new epoch; its error still ends the attempt.
     */
    private beginDecoderEpoch(): void {
        this.epoch += 1;
        this.pool.releaseAllReferences();
    }

    /** A lost device takes the decoder with it; recovery rebuilds without the decoder. */
    /**
     * Fails the session when its device is lost.
     * The device's lost promise holds only the set of its live sessions, which destroy() leaves, so a destroyed session and its pipelines are collected while the device lives on.
     */
    private observeDeviceLoss(): void {
        const liveSessions = liveSessionsByDevice.get(this.device);
        if (liveSessions) {
            liveSessions.add(this);
            return;
        }
        const deviceSessions = new Set<GPUVideoDecodeSession>([ this ]);
        liveSessionsByDevice.set(this.device, deviceSessions);
        void this.device.lost.then((info: GPUDeviceLostInfo): void => {
            const detail = info.message.length > 0 ? `${info.reason}: ${info.message}` : info.reason;
            for (const session of deviceSessions) {
                session.fail({ code: 'device-lost', detail });
            }
        });
    }

    private createBuffer(name: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
        const buffer = this.device.createBuffer({ label: `GPU decoder ${this.manifest.name} ${name}`, size, usage });
        this.ownedBuffers.push(buffer);
        return buffer;
    }

    private createConfigBuffer(codecPrivate: Uint8Array | null): GPUBuffer {
        const byteLength = Math.max(BYTES_PER_WORD, alignTo(codecPrivate?.byteLength ?? 0, BYTES_PER_WORD));
        const buffer = this.createBuffer('config', byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
        if (codecPrivate && codecPrivate.byteLength > 0) {
            const paddedConfig = new Uint8Array(byteLength);
            paddedConfig.set(codecPrivate);
            this.device.queue.writeBuffer(buffer, 0, paddedConfig);
        }
        return buffer;
    }

    private createStreamBuffer(stream: GPUDecodeStreamFacts, outputFormat: GPUDecoderOutputFormat, configByteLength: number): GPUBuffer {
        const buffer = this.createBuffer('stream', GPU_DECODER_STREAM_UNIFORM_BYTE_LENGTH, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        const values = new Uint32Array(GPU_DECODER_STREAM_UNIFORM_BYTE_LENGTH / BYTES_PER_WORD);
        const layout = this.pool.layout;
        writeGPUDecoderStreamUniform(values, {
            bitDepth: stream.bitDepth,
            bytesPerSample: getGPUDecoderFormatFacts(outputFormat).bytesPerSample,
            configByteLength,
            height: stream.codedHeight,
            planes: layout.planes,
            slotByteLength: layout.slotByteLength,
            slotCount: layout.slotCount,
            width: stream.codedWidth
        });
        this.device.queue.writeBuffer(buffer, 0, values);
        return buffer;
    }

    /**
     * Resolves each run's dispatches to their pipelines, and gives each indirect dispatch an indirect arguments buffer that no bind group holds.
     * A repeated indirect dispatch reuses its buffer, since each iteration copies the counts again right before it dispatches.
     */
    private prepareDispatchRuns(resources: SessionResources, scratchBuffers: readonly GPUBuffer[]): DispatchRun<PreparedDispatch>[] {
        let indirectDispatchCount = 0;
        return resources.dispatchRuns.map((run: DispatchRun<DispatchPlan>): DispatchRun<PreparedDispatch> => ({
            count: run.count,
            dispatches: run.dispatches.map((plan: DispatchPlan): PreparedDispatch => {
                const pipeline = resources.pipelines.get(plan.entryPoint);
                if (!pipeline) {
                    throw new RangeError(`The entry point '${plan.entryPoint}' has no pipeline`);
                }
                if (plan.kind === 'direct') {
                    return { kind: 'direct', pipeline, workgroupCounts: plan.workgroupCounts };
                }
                indirectDispatchCount += 1;
                // A buffer bound for writing cannot serve as indirect arguments in the same dispatch, so a copy carries the counts
                return {
                    indirectMirror: this.createBuffer(
                        `indirect arguments ${indirectDispatchCount}`,
                        INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH,
                        GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
                    ),
                    indirectSource: scratchBuffers[plan.bufferIndex],
                    kind: 'indirect',
                    pipeline
                };
            }),
            repeatIndex: run.repeatIndex
        }));
    }

    /** Writes a packet into the ring at a word-aligned offset; its last partial word goes through a zero-padded word. */
    private writePacketBytes(data: ArrayBuffer, byteOffset: number): void {
        const wholeWordByteLength = data.byteLength - (data.byteLength % BYTES_PER_WORD);
        if (wholeWordByteLength > 0) {
            this.device.queue.writeBuffer(this.packetRing, byteOffset, data, 0, wholeWordByteLength);
        }
        if (wholeWordByteLength < data.byteLength) {
            this.packetTail.fill(0);
            this.packetTail.set(new Uint8Array(data, wholeWordByteLength));
            this.device.queue.writeBuffer(this.packetRing, byteOffset + wholeWordByteLength, this.packetTail);
        }
    }

    /**
     * Consumes the first queued packet: it begins its decode work in a free slot, with a free readback for its status, submits the work's first slice,
     * and queues its frame, or holds the last good frame for a packet that decodes nothing; returns false when no packet waits, or no slot or readback is free.
     */
    private startNextPacket(): boolean {
        const packet = this.pendingPackets.at(0);
        if (!packet) {
            return false;
        }
        // A packet whose picture is lost, or one a resync passes over on its way to a key packet, decodes nothing
        if (packet.hold || (this.resync !== null && !packet.keyframe && !packet.reset)) {
            this.pendingPackets.shift();
            this.holdPacket(packet);
            return true;
        }
        const readback = this.freeReadbacks.at(-1);
        if (!readback) {
            return false;
        }
        // A packet that resets the decoder drops its references before taking a slot, which may be one of them
        if (packet.reset && !this.resetPending) {
            this.beginDecoderEpoch();
            this.resetPending = true;
        }
        const slot = this.pool.acquireSlot(this.manifest.references > 0);
        if (slot === null) {
            return false;
        }
        this.pendingPackets.shift();
        this.freeReadbacks.pop();
        if (packet.reset) {
            this.restartPictureNumbering();
        }
        // The packet that decodes after a resync is its key packet, which decodes from the reset the resync made pending
        this.endResync();
        const entry: DecodedFrameEntry = {
            confirmed: false,
            durationMicroseconds: packet.durationMicroseconds,
            fields: packet.fields,
            held: false,
            packetSerial: this.takePacketSerial(),
            pictureIndex: this.takePictureIndex(),
            slot,
            timestampMicroseconds: packet.timestampMicroseconds,
            visibleSize: packet.visibleSize
        };
        const sliced = this.beginPacket(packet, slot, readback, entry);
        this.slicedPacket = sliced;
        this.submitNextSlice(sliced);
        if (this.parserOutput) {
            this.receiveParserFrame(entry, packet.outputEvents);
        } else {
            this.receiveDecodedFrame(entry);
        }
        return true;
    }

    private takePacketSerial(): number {
        const packetSerial = this.nextPacketSerial;
        this.nextPacketSerial += 1;
        return packetSerial;
    }

    private takePictureIndex(): number {
        const pictureIndex = this.nextPictureIndex;
        this.nextPictureIndex = (pictureIndex + 1) % GPU_DECODER_OUTPUT_EVENT.pictureIndexModulus;
        return pictureIndex;
    }

    /**
     * Consumes a packet that decodes nothing: a held packet, whose picture its parser lost, or one a resync passes over.
     * Its frame repeats the last good frame at its own time; a parser's picture still applies its output events, which decide earlier pictures.
     * A held packet that finds no resync begins one, since its parser restarted, and counts the recovery it carries.
     */
    private holdPacket(packet: GPUDecodePacket): void {
        if (packet.recovery !== null) {
            this.recoveries.push(packet.recovery);
        }
        if (packet.hold && this.resync === null) {
            this.beginResync(null);
        }
        const packetSerial = this.takePacketSerial();
        const pictureIndex = this.takePictureIndex();
        if (this.parserOutput && !packet.hold) {
            for (const event of packet.outputEvents ?? []) {
                if (!this.applyOutputEvent(event)) {
                    return;
                }
            }
        }
        const heldFrame = this.resync?.heldFrame ?? null;
        if (heldFrame === null || !this.pool.holdOutput(heldFrame.slot)) {
            return;
        }
        this.receiveDecodedFrame({
            confirmed: true,
            durationMicroseconds: packet.durationMicroseconds,
            fields: heldFrame.fields,
            held: true,
            packetSerial,
            pictureIndex,
            slot: heldFrame.slot,
            timestampMicroseconds: packet.timestampMicroseconds,
            visibleSize: heldFrame.visibleSize
        });
    }

    /**
     * Begins a resync, the last good frame holding until the next key packet decodes from a reset.
     * The frames of packets from firstDroppedSerial on decoded from a broken state, so each becomes a repeat of the last good frame, or drops when none is left;
     * null replaces none, as when a parser restarted, whose undecided frames present first in timestamp order, since no event will decide them.
     * The last good frame is the one of an earlier packet with the latest timestamp that the session or presentation still holds.
     */
    private beginResync(firstDroppedSerial: number | null): void {
        if (firstDroppedSerial === null && this.parserOutput) {
            const undecidedFrames = this.parserFrames.splice(0);
            undecidedFrames.sort((first: DecodedFrameEntry, second: DecodedFrameEntry): number => first.timestampMicroseconds - second.timestampMicroseconds);
            for (const entry of undecidedFrames) {
                this.releaseToPresentation(entry);
            }
        }
        this.releaseHeldFrame();
        const source = this.findLastGoodFrame(firstDroppedSerial);
        const heldFrame = source !== null && this.pool.holdOutput(source.slot) ? source : null;
        this.resync = { heldFrame };
        if (firstDroppedSerial !== null) {
            for (const frames of [ this.parserFrames, this.reorderFrames, this.presentableFrames ]) {
                this.replaceBrokenFrames(frames, firstDroppedSerial, heldFrame);
            }
        }
        // The packet in progress decodes from the broken references, so the rest of its work is wasted
        this.abandonSlicedPacket();
        // The decoder's references are broken, and the next packet it decodes, the key packet, decodes from a reset
        this.beginDecoderEpoch();
        this.resetPending = true;
    }

    /** Returns the frame with the latest timestamp that the session or presentation holds of a packet before firstDroppedSerial, any packet's for null. */
    private findLastGoodFrame(firstDroppedSerial: number | null): HeldFrame | null {
        let source: HeldFrame | null = null;
        let sourceTimestampMicroseconds = Number.NEGATIVE_INFINITY;
        for (const entry of [ ...this.parserFrames, ...this.reorderFrames, ...this.presentableFrames ]) {
            const good = firstDroppedSerial === null || entry.packetSerial < firstDroppedSerial;
            if (good && entry.timestampMicroseconds > sourceTimestampMicroseconds) {
                source = { fields: entry.fields, slot: entry.slot, visibleSize: entry.visibleSize };
                sourceTimestampMicroseconds = entry.timestampMicroseconds;
            }
        }
        for (const frame of this.takenFrames) {
            if (frame.timestampMicroseconds > sourceTimestampMicroseconds) {
                source = { fields: frame.fields, slot: frame.slot, visibleSize: frame.visibleSize };
                sourceTimestampMicroseconds = frame.timestampMicroseconds;
            }
        }
        return source;
    }

    /** Replaces each frame of a packet from firstDroppedSerial on with a repeat of the held frame, in place, or drops it when there is none. */
    private replaceBrokenFrames(frames: DecodedFrameEntry[], firstDroppedSerial: number, heldFrame: HeldFrame | null): void {
        for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
            const entry = frames[frameIndex];
            if (entry.held || entry.packetSerial < firstDroppedSerial) {
                continue;
            }
            this.pool.releaseOutput(entry.slot);
            if (heldFrame === null || !this.pool.holdOutput(heldFrame.slot)) {
                frames.splice(frameIndex, 1);
                continue;
            }
            entry.confirmed = true;
            entry.fields = heldFrame.fields;
            entry.held = true;
            entry.slot = heldFrame.slot;
            entry.visibleSize = heldFrame.visibleSize;
        }
    }

    /**
     * Ends a resync at the packet that decodes after it: a parser session's repeats, which wait behind the reorder depth outside its parser's decisions,
     * present in timestamp order, and the resync's own hold on the last good frame ends.
     */
    private endResync(): void {
        if (this.resync === null) {
            return;
        }
        if (this.parserOutput) {
            for (const entry of this.reorderFrames.splice(0)) {
                this.releaseToPresentation(entry);
            }
        }
        this.releaseHeldFrame();
    }

    /** Ends the resync's own hold on the last good frame, if a resync holds one, and the resync. */
    private releaseHeldFrame(): void {
        const heldFrame = this.resync?.heldFrame ?? null;
        this.resync = null;
        if (heldFrame !== null) {
            this.pool.releaseOutput(heldFrame.slot);
        }
    }

    /**
     * Starts the picture indices of a reset packet's stream again, as its parser numbers its pictures from a reset.
     * A parser's frames still undecided belong to the stream before the reset, whose events will not come, so they drop.
     */
    private restartPictureNumbering(): void {
        for (const entry of this.parserFrames.splice(0)) {
            this.pool.releaseOutput(entry.slot);
        }
        this.nextPictureIndex = 0;
    }

    /**
     * Holds a parser's frame until an output event presents or drops it, then applies the packet's events, which may name it.
     * A parser that leaves more frames undecided than the decoder's reorder depth has its earliest one presented, so its pool never fills.
     */
    private receiveParserFrame(entry: DecodedFrameEntry, outputEvents: Uint32Array | null): void {
        this.parserFrames.push(entry);
        for (const event of outputEvents ?? []) {
            if (!this.applyOutputEvent(event)) {
                return;
            }
        }
        while (this.parserFrames.length > this.manifest.reorder) {
            let earliestIndex = 0;
            for (let frameIndex = 1; frameIndex < this.parserFrames.length; frameIndex += 1) {
                if (this.parserFrames[frameIndex].timestampMicroseconds < this.parserFrames[earliestIndex].timestampMicroseconds) {
                    earliestIndex = frameIndex;
                }
            }
            const [ earliestFrame ] = this.parserFrames.splice(earliestIndex, 1);
            this.releaseToPresentation(earliestFrame);
        }
    }

    /**
     * Presents or drops the undecided frame an output event names; returns false once the session failed.
     * An event for an earlier picture that already left, as a frame the reorder bound presented, changes nothing; one for a picture not yet decoded fails the session.
     */
    private applyOutputEvent(event: number): boolean {
        if ((event & GPU_DECODER_OUTPUT_EVENT.reservedBit) !== 0) {
            this.fail({ code: 'output-event', detail: `0x${(event >>> 0).toString(16)} sets the reserved bit` });
            return false;
        }
        const pictureIndex = event & GPU_DECODER_OUTPUT_EVENT.pictureIndexMask;
        const frameIndex = this.parserFrames.findIndex((entry: DecodedFrameEntry): boolean => entry.pictureIndex === pictureIndex);
        if (frameIndex < 0) {
            const newestPictureIndex = (this.nextPictureIndex + GPU_DECODER_OUTPUT_EVENT.pictureIndexModulus - 1) % GPU_DECODER_OUTPUT_EVENT.pictureIndexModulus;
            const distance = (newestPictureIndex - pictureIndex + GPU_DECODER_OUTPUT_EVENT.pictureIndexModulus) % GPU_DECODER_OUTPUT_EVENT.pictureIndexModulus;
            if (distance >= PICTURE_INDEX_HALF_RANGE) {
                this.fail({ code: 'output-event', detail: `picture ${pictureIndex} after ${newestPictureIndex}` });
                return false;
            }
            return true;
        }
        const [ entry ] = this.parserFrames.splice(frameIndex, 1);
        if ((event & GPU_DECODER_OUTPUT_EVENT.discardBit) !== 0) {
            this.pool.releaseOutput(entry.slot);
            return true;
        }
        this.releaseToPresentation(entry);
        return true;
    }

    /**
     * Writes a packet into the ring and its uniform into the next uniform slot, and lays its decode work out in slices of about equal length,
     * its readback taking its status in the epoch the packet begins in, so a reset or a resync while it submits makes that status stale.
     */
    private beginPacket(packet: GPUDecodePacket, slot: number, readback: StatusReadback, entry: DecodedFrameEntry): SlicedPacket {
        const alignedByteLength = alignTo(packet.data.byteLength, BYTES_PER_WORD);
        const byteOffset = this.ringByteOffset + alignedByteLength > this.packetRingByteLength ? 0 : this.ringByteOffset;
        this.ringByteOffset = byteOffset + alignedByteLength;
        this.writePacketBytes(packet.data, byteOffset);

        const reset = this.resetPending;
        this.resetPending = false;
        writeGPUDecoderPacketUniform(this.packetUniformValues, {
            byteLength: packet.data.byteLength,
            byteOffset,
            index: this.packetIndex,
            keyframe: packet.keyframe,
            outputSlot: slot,
            reset
        });
        const uniformOffset = this.packetUniformSlot * PACKET_UNIFORM_STRIDE;
        this.packetUniformSlot = (this.packetUniformSlot + 1) % PACKET_UNIFORM_SLOT_COUNT;
        this.device.queue.writeBuffer(this.packetUniforms, uniformOffset, this.packetUniformValues);
        const label = `GPU decoder ${this.manifest.name} packet ${this.packetIndex}`;
        this.packetIndex = (this.packetIndex + 1) % U32_VALUE_COUNT;

        readback.epoch = this.epoch;
        readback.entry = entry;
        const dispatches = this.listDispatches(packet.repeatCounts);
        const sliceCount = Math.max(1, Math.ceil(dispatches.length / GPU_DECODE_SLICE_DISPATCH_COUNT));
        return {
            dispatches,
            label,
            nextDispatchIndex: 0,
            readback,
            reset,
            sliceDispatchCount: Math.ceil(dispatches.length / sliceCount),
            uniformOffset
        };
    }

    /** Lists a packet's dispatches in order, each run's its iteration count of times: a repeat's count, or the picture's own smaller count. */
    private listDispatches(repeatCounts: readonly number[] | null): PreparedDispatch[] {
        const dispatches: PreparedDispatch[] = [];
        for (const run of this.dispatchRuns) {
            const iterationCount = getRunIterationCount(run, repeatCounts);
            for (let iteration = 0; iteration < iterationCount; iteration += 1) {
                dispatches.push(...run.dispatches);
            }
        }
        return dispatches;
    }

    /**
     * Submits a packet's next slice: its first clears the state and status buffers at a reset, and its last ends with the copy of the packet's status
     * into its readback, which ends the packet's turn in progress; returns true.
     */
    private submitNextSlice(sliced: SlicedPacket): boolean {
        const firstDispatchIndex = sliced.nextDispatchIndex;
        const endDispatchIndex = Math.min(firstDispatchIndex + sliced.sliceDispatchCount, sliced.dispatches.length);
        const lastSlice = endDispatchIndex === sliced.dispatches.length;
        const encoder = this.device.createCommandEncoder({ label: sliced.label });
        if (firstDispatchIndex === 0 && sliced.reset) {
            encoder.clearBuffer(this.stateBuffer);
            encoder.clearBuffer(this.statusBuffer);
        }
        this.encodeDispatches(encoder, sliced.uniformOffset, sliced.dispatches.slice(firstDispatchIndex, endDispatchIndex));
        if (lastSlice) {
            this.encodeStatusCopy(encoder, sliced.readback);
        }
        this.device.queue.submit([ encoder.finish() ]);
        sliced.nextDispatchIndex = endDispatchIndex;
        this.trackSliceCompletion();
        if (lastSlice) {
            this.slicedPacket = null;
            this.mapStatusReadback(sliced.readback);
        }
        return true;
    }

    /** Keeps the just submitted slice in flight until its work completed; a lost device fails the session through its own promise instead. */
    private trackSliceCompletion(): void {
        const completion = waitForGPUCompletion(this.device, this.device.queue.onSubmittedWorkDone()).then(
            (): void => undefined,
            (): void => undefined
        ).finally((): void => {
            this.inFlightSlices.delete(completion);
        });
        this.inFlightSlices.add(completion);
    }

    /**
     * Submits no more of the packet in progress, whose remaining work a reset or a resync made useless; slices already submitted still run.
     * Its readback is free again, never having been copied into, and its frame, unless a resync already replaced it, drops, since no status will confirm it.
     */
    private abandonSlicedPacket(): void {
        const sliced = this.slicedPacket;
        if (sliced === null) {
            return;
        }
        this.slicedPacket = null;
        const entry = sliced.readback.entry;
        sliced.readback.entry = null;
        this.freeReadbacks.push(sliced.readback);
        if (entry !== null && !entry.confirmed) {
            this.dropFrame(entry);
        }
    }

    private beginComputePass(encoder: GPUCommandEncoder, uniformOffset: number): GPUComputePassEncoder {
        const pass = encoder.beginComputePass({ label: `GPU decoder ${this.manifest.name}` });
        pass.setBindGroup(0, this.bindGroup, [ uniformOffset ]);
        return pass;
    }

    /** Encodes dispatches in order; an indirect dispatch ends the pass to copy its counts, since copies run between passes. */
    private encodeDispatches(encoder: GPUCommandEncoder, uniformOffset: number, dispatches: readonly PreparedDispatch[]): void {
        let pass = this.beginComputePass(encoder, uniformOffset);
        for (const dispatch of dispatches) {
            switch (dispatch.kind) {
                case 'direct':
                    pass.setPipeline(dispatch.pipeline);
                    pass.dispatchWorkgroups(dispatch.workgroupCounts[0], dispatch.workgroupCounts[1], dispatch.workgroupCounts[2]);
                    break;
                case 'indirect':
                    pass.end();
                    encoder.copyBufferToBuffer(dispatch.indirectSource, 0, dispatch.indirectMirror, 0, INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH);
                    pass = this.beginComputePass(encoder, uniformOffset);
                    pass.setPipeline(dispatch.pipeline);
                    pass.dispatchWorkgroupsIndirect(dispatch.indirectMirror, 0);
                    break;
            }
        }
        pass.end();
    }

    /**
     * Copies the status into the packet's readback and clears the packet's block, so each freed slot is reported once
     * and the next packet's picture reports start from none.
     */
    private encodeStatusCopy(encoder: GPUCommandEncoder, readback: StatusReadback): void {
        encoder.copyBufferToBuffer(this.statusBuffer, 0, readback.buffer, 0, GPU_DECODER_STATUS_BYTE_LENGTH);
        encoder.clearBuffer(this.statusBuffer, GPU_DECODER_STATUS_PACKET_BLOCK_BYTE_OFFSET, GPU_DECODER_STATUS_PACKET_BLOCK_BYTE_LENGTH);
    }

    private mapStatusReadback(readback: StatusReadback): void {
        const readbackPromise = waitForGPUCompletion(this.device, readback.buffer.mapAsync(GPUMapMode.READ)).then(
            (): void => {
                this.applyStatusReadback(readback);
            },
            (error: unknown): void => {
                // Destroying the session aborts its maps, which is no failure
                if (!this.destroyed) {
                    this.fail({ code: 'readback-failed', detail: describeError(error) });
                }
            }
        ).finally((): void => {
            this.inFlightReadbacks.delete(readbackPromise);
        });
        this.inFlightReadbacks.add(readbackPromise);
    }

    /**
     * Applies one packet's status: a fatal error ends the attempt in any epoch; in the current epoch the freed slots leave the references,
     * the decoder's fields replace the frame's, the frame is confirmed for presentation, and a recoverable error applies its recovery.
     * A readback taken before a reset or a resync applies nothing else, since its frame already left.
     */
    private applyStatusReadback(readback: StatusReadback): void {
        if (this.destroyed) {
            return;
        }
        const words = new Uint32Array(readback.buffer.getMappedRange(0, GPU_DECODER_STATUS_BYTE_LENGTH).slice(0));
        readback.buffer.unmap();
        const entry = readback.entry;
        readback.entry = null;
        this.freeReadbacks.push(readback);
        if (this.failure) {
            return;
        }
        const status = readGPUDecoderStatus(words);
        const firstHeaderFacts = this.headerFacts === null ? status.headerFacts : null;
        this.headerFacts ??= status.headerFacts;
        // A fatal error ends the attempt whichever epoch reported it
        if (status.errorCode !== 0) {
            this.fail({ code: 'decoder-error', detail: String(status.errorCode) });
            return;
        }
        // The header's visible rectangle, such as a conformance window, replaces the container's from the next presented frame on
        if (firstHeaderFacts && !this.pool.setVisibleRectangle(firstHeaderFacts.visibleRectangle)) {
            const rectangle = firstHeaderFacts.visibleRectangle;
            const layout = this.pool.layout;
            this.fail({
                code: 'visible-rectangle',
                detail: `header ${rectangle.x},${rectangle.y} ${rectangle.width}x${rectangle.height} exceeds ${layout.codedWidth}x${layout.codedHeight}`
            });
            return;
        }
        if (readback.epoch !== this.epoch || entry === null) {
            return;
        }
        for (let slot = 0; slot < this.pool.layout.slotCount; slot += 1) {
            // Unsigned shift, since slot 31 sets the sign bit
            if (((status.freedSlotMask >>> slot) & 1) === 1) {
                this.pool.releaseReference(slot);
            }
        }
        entry.fields = decodePictureFieldsWord(status.pictureFields) ?? entry.fields;
        entry.confirmed = true;
        if (status.pictureError !== 0) {
            this.applyPictureError(entry, status.pictureError);
        }
    }

    /**
     * Applies the recovery the header declares for a recoverable error the packet's picture reported, and counts it:
     * the concealed picture presents, the picture drops, or a resync begins at it.
     */
    private applyPictureError(entry: DecodedFrameEntry, errorWord: number): void {
        const code = errorWord >>> GPU_DECODER_ERROR_CODE_SHIFT;
        const recovery = this.manifest.errorRecoveries.get(code);
        // The prelude reports only recoverable codes in the picture's word, so another code ends the attempt as a fatal one does
        if (recovery === undefined) {
            this.fail({ code: 'decoder-error', detail: String(errorWord) });
            return;
        }
        this.recoveries.push({
            code: GPU_VIDEO_DECODE_RECOVERY_CODES[recovery],
            errorName: getDecoderErrorName(this.manifest.errors, code),
            value: errorWord & ERROR_VALUE_MASK
        });
        switch (recovery) {
            case 'conceal':
                return;
            case 'drop':
                this.dropFrame(entry);
                return;
            case 'resync':
                this.beginResync(entry.packetSerial);
                return;
        }
    }

    /** Drops a frame wherever it waits, freeing its output hold; a frame that already left changes nothing. */
    private dropFrame(entry: DecodedFrameEntry): void {
        for (const frames of [ this.parserFrames, this.reorderFrames, this.presentableFrames ]) {
            const frameIndex = frames.indexOf(entry);
            if (frameIndex >= 0) {
                frames.splice(frameIndex, 1);
                this.pool.releaseOutput(entry.slot);
                return;
            }
        }
    }

    /** Holds a decoded frame back until the reorder depth is filled, then releases the earliest to presentation. */
    private receiveDecodedFrame(entry: DecodedFrameEntry): void {
        let insertionIndex = this.reorderFrames.length;
        while (insertionIndex > 0 && this.reorderFrames[insertionIndex - 1].timestampMicroseconds > entry.timestampMicroseconds) {
            insertionIndex -= 1;
        }
        this.reorderFrames.splice(insertionIndex, 0, entry);
        const releasedFrameCount = Math.max(this.reorderFrames.length - this.manifest.reorder, 0);
        for (const releasedFrame of this.reorderFrames.splice(0, releasedFrameCount)) {
            this.releaseToPresentation(releasedFrame);
        }
    }

    /**
     * Queues a frame for presentation; a frame earlier than one already released means the stream reorders deeper than declared, so it is dropped,
     * and counted unless it repeats a held frame.
     */
    private releaseToPresentation(entry: DecodedFrameEntry): void {
        if (entry.timestampMicroseconds < this.lastReleasedTimestampMicroseconds) {
            this.pool.releaseOutput(entry.slot);
            if (!entry.held) {
                this.droppedFrameCount += 1;
            }
            return;
        }
        this.lastReleasedTimestampMicroseconds = entry.timestampMicroseconds;
        this.presentableFrames.push(entry);
    }

    private flushEndOfStreamIfDecoded(): void {
        if (!this.endOfStreamPending || this.pendingPackets.length > 0) {
            return;
        }
        this.endOfStreamPending = false;
        const outputEvents = this.endOfStreamEvents;
        this.endOfStreamEvents = null;
        for (const event of this.parserOutput ? outputEvents ?? [] : []) {
            if (!this.applyOutputEvent(event)) {
                return;
            }
        }
        const undecidedFrames = this.parserFrames.splice(0);
        undecidedFrames.sort((first: DecodedFrameEntry, second: DecodedFrameEntry): number => first.timestampMicroseconds - second.timestampMicroseconds);
        for (const entry of [ ...undecidedFrames, ...this.reorderFrames.splice(0) ]) {
            this.releaseToPresentation(entry);
        }
        // No key packet follows the end, so a resync in progress ends with it
        this.releaseHeldFrame();
    }

    /** Returns a frame taken for presentation; a picture that reported its own visible size presents its top-left samples of that size. */
    private createTakenFrame(entry: DecodedFrameEntry, droppedFrameCount: number): GPUDecodedFrame {
        const poolFrame = this.pool.getFrame(entry.slot);
        const visibleSize = entry.visibleSize;
        const frame: GPUDecodedFrame = {
            droppedFrameCount,
            durationMicroseconds: entry.durationMicroseconds,
            fields: entry.fields,
            frame: visibleSize ? { ...poolFrame, visibleRectangle: { height: visibleSize.height, width: visibleSize.width, x: 0, y: 0 } } : poolFrame,
            slot: entry.slot,
            timestampMicroseconds: entry.timestampMicroseconds,
            visibleSize
        };
        this.takenFrames.add(frame);
        return frame;
    }

    private fail(failure: GPUVideoDecodeFailure): void {
        if (this.destroyed || this.failure) {
            return;
        }
        this.failure = failure;
        this.pendingPackets.length = 0;
        this.abandonSlicedPacket();
    }
}
