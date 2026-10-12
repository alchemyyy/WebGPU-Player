// Runs one user WGSL video decoder on the presenter's device: the packet ring, the dispatch sequence, pacing, presentation order, and slot release.
// The compressed packet is the only CPU to GPU transfer; decoded planes stay in the frame pool, which the signal step reads in place.
// overhual/decoders.md in the engine root describes the route.
import { evaluatePassExpression, PassExpressionError } from '../../presentation/passes/PassExpression';
import type { FramePoolFrame, PassExpression } from '../../presentation/passes/PassTypes';
import {
    BYTES_PER_WORD,
    INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH,
    U32_VALUE_COUNT,
    UNIFORM_BUFFER_OFFSET_ALIGNMENT,
    WORKGROUP_AXIS_NAMES
} from '../../presentation/WebGPUConstants';
import { getGPUDecoderFormatFacts, type GPUDecoderOutputFormat } from './GPUDecodeFormats';
import { GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH, GPU_DECODE_PACKET_RING_PACKET_COUNT } from './GPUDecodeLimits';
import {
    createGPUDecoderBindGroupLayoutEntries,
    createGPUDecoderModule,
    GPU_DECODER_BINDINGS,
    GPU_DECODER_FIRST_BUFFER_BINDING,
    GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH,
    GPU_DECODER_STATUS_BYTE_LENGTH,
    GPU_DECODER_STATUS_FREED_SLOT_MASK_BYTE_OFFSET,
    GPU_DECODER_STREAM_UNIFORM_BYTE_LENGTH,
    readGPUDecoderStatus,
    writeGPUDecoderPacketUniform,
    writeGPUDecoderStreamUniform
} from './GPUDecoderPrelude';
import { GPU_DECODER_STREAM_FACTS } from './GPUDecoderManifest';
import GPUFramePool, {
    alignTo,
    createGPUFramePoolLayout,
    getGPUFramePoolSlotCount,
    requireGPUFramePoolCodedSize
} from './GPUFramePool';
import {
    type GPUDecodePacket,
    type GPUDecoderCompileMessage,
    type GPUDecoderManifest,
    type GPUDecodeStreamFacts,
    GPUVideoDecodeError,
    type GPUVideoDecodeFailure
} from './GPUDecodeTypes';

// Each packet's uniform takes the next slot of one buffer at a dynamic offset, so a packet never creates a bind group
const PACKET_UNIFORM_SLOT_COUNT = 8;
// Packet uniforms sit one offset alignment apart, so every device accepts the dynamic offsets
const PACKET_UNIFORM_STRIDE = UNIFORM_BUFFER_OFFSET_ALIGNMENT;
// Readbacks in flight at once; a packet submitted while all are mapping skips its readback, so nothing waits on one
const STATUS_READBACK_COUNT = 3;

/** What a session decodes and where. */
export type GPUVideoDecodeSessionOptions = {
    /** The codec private data from the container, such as a Matroska CodecPrivate, or null. */
    codecPrivate: Uint8Array | null
    /** The presenter's device, so decoded frames never leave GPU memory. */
    device: GPUDevice
    manifest: GPUDecoderManifest
    stream: GPUDecodeStreamFacts
};

/** A decoded frame taken for presentation; it holds its slot until releaseFrame(). */
export type GPUDecodedFrame = {
    /** Due frames dropped when this frame was taken, for a temporal pass's soft reset. */
    droppedFrameCount: number
    durationMicroseconds: number
    frame: FramePoolFrame
    slot: number
    timestampMicroseconds: number
};

type DecodedFrameEntry = {
    durationMicroseconds: number
    slot: number
    timestampMicroseconds: number
};

type PreparedDispatch =
    | { kind: 'direct'; pipeline: GPUComputePipeline; workgroupCounts: readonly [number, number, number] }
    | { indirectMirror: GPUBuffer; indirectSource: GPUBuffer; kind: 'indirect'; pipeline: GPUComputePipeline };

type DispatchPlan =
    | { entryPoint: string; kind: 'direct'; workgroupCounts: readonly [number, number, number] }
    | { bufferIndex: number; entryPoint: string; kind: 'indirect' };

type StatusReadback = {
    buffer: GPUBuffer
    /** The reset epoch the readback was taken in; a readback of an earlier epoch is stale. */
    epoch: number
};

type SessionResources = {
    bindGroupLayout: GPUBindGroupLayout
    dispatchPlans: readonly DispatchPlan[]
    pipelines: ReadonlyMap<string, GPUComputePipeline>
};

function getStreamFacts(stream: GPUDecodeStreamFacts): ReadonlyMap<string, number> {
    return new Map<string, number>([
        [ GPU_DECODER_STREAM_FACTS.width, stream.codedWidth ],
        [ GPU_DECODER_STREAM_FACTS.height, stream.codedHeight ],
        [ GPU_DECODER_STREAM_FACTS.bitDepth, stream.bitDepth ]
    ]);
}

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

/** Evaluates every direct dispatch's workgroup counts once, from the stream facts; nothing is evaluated per packet. */
function planDispatches(manifest: GPUDecoderManifest, stream: GPUDecodeStreamFacts, maximumCount: number): DispatchPlan[] {
    const facts = getStreamFacts(stream);
    const plans: DispatchPlan[] = [];
    for (const dispatch of manifest.dispatches) {
        // The manifest parser guarantees one of the two dispatch forms and a declared indirect buffer
        if (dispatch.indirectBuffer !== null) {
            const bufferIndex = manifest.buffers.findIndex(buffer => buffer.name === dispatch.indirectBuffer && buffer.indirect);
            if (bufferIndex < 0) {
                throw new RangeError(`dispatch: '${dispatch.entryPoint}' reads undeclared indirect buffer '${dispatch.indirectBuffer}'`);
            }
            plans.push({ bufferIndex, entryPoint: dispatch.entryPoint, kind: 'indirect' });
            continue;
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
        plans.push({ entryPoint: dispatch.entryPoint, kind: 'direct', workgroupCounts: [ counts[0], counts[1], counts[2] ] });
    }
    return plans;
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

/** Requires the decoder's features, and a device that binds every storage buffer of the decoder's bind group layout. */
function requireDeviceSupport(device: GPUDevice, manifest: GPUDecoderManifest, layoutEntries: readonly GPUBindGroupLayoutEntry[]): void {
    const missingFeatures = manifest.requiredFeatures.filter(feature => !device.features.has(feature));
    if (missingFeatures.length > 0) {
        throw new GPUVideoDecodeError({ code: 'feature-missing', detail: missingFeatures.join(', ') });
    }
    const storageBufferCount = layoutEntries.filter(entry => entry.buffer !== undefined && entry.buffer.type !== 'uniform').length;
    const storageBufferLimit = device.limits.maxStorageBuffersPerShaderStage;
    if (storageBufferCount > storageBufferLimit) {
        throw new GPUVideoDecodeError({ code: 'storage-buffer-count', detail: `${storageBufferCount} > ${storageBufferLimit}` });
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

async function createPipelines(
    device: GPUDevice,
    manifest: GPUDecoderManifest,
    shaderModule: GPUShaderModule,
    pipelineLayout: GPUPipelineLayout
): Promise<Map<string, GPUComputePipeline>> {
    const entryPoints = [ ...new Set(manifest.dispatches.map(dispatch => dispatch.entryPoint)) ];
    const pipelines = await Promise.all(entryPoints.map(async (entryPoint): Promise<GPUComputePipeline> => {
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
 * Decodes compressed packets into frame pool slots on the presenter's device.
 * Packets queue in decode order; submitPendingDecodeWork() encodes one packet's dispatches at a time, as far ahead as free slots allow.
 * Decoded frames leave in timestamp order once the declared reorder depth is filled, and each holds its slot until presentation releases it.
 */
export default class GPUVideoDecodeSession {
    readonly manifest: GPUDecoderManifest;
    readonly pool: GPUFramePool;
    private readonly bindGroup: GPUBindGroup;
    private readonly device: GPUDevice;
    private readonly dispatches: readonly PreparedDispatch[];
    private droppedFrameCount = 0;
    private destroyed = false;
    private endOfStreamPending = false;
    private epoch = 0;
    private failure: GPUVideoDecodeFailure | null = null;
    private readonly freeReadbacks: StatusReadback[] = [];
    private headerFacts: GPUDecodeStreamFacts | null = null;
    private readonly inFlightReadbacks = new Set<Promise<void>>();
    private lastReleasedTimestampMicroseconds = Number.NEGATIVE_INFINITY;
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
    private readonly reorderFrames: DecodedFrameEntry[] = [];
    private resetPending = true;
    private ringByteOffset = 0;
    private readonly stateBuffer: GPUBuffer;
    private readonly statusBuffer: GPUBuffer;
    // Set while the status holds reports of a packet that skipped its readback, which no readback has captured since
    private statusCaptureOwed = false;
    private readonly takenFrames = new Set<GPUDecodedFrame>();

    private constructor(options: GPUVideoDecodeSessionOptions, outputFormat: GPUDecoderOutputFormat, resources: SessionResources) {
        const { device, manifest, stream } = options;
        this.device = device;
        this.manifest = manifest;
        // The pool goes first: it is the one allocation a device's limits can refuse
        this.pool = new GPUFramePool(
            device,
            createGPUFramePoolLayout(
                outputFormat,
                stream.codedWidth,
                stream.codedHeight,
                getGPUFramePoolSlotCount(manifest.references, manifest.reorder)
            ),
            stream.visibleRectangle
        );
        try {
            this.packetRingByteLength = alignTo(manifest.packetByteLength, BYTES_PER_WORD) * GPU_DECODE_PACKET_RING_PACKET_COUNT;
            this.packetRing = this.createBuffer('packet ring', this.packetRingByteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
            this.packetUniforms = this.createBuffer(
                'packet uniforms',
                PACKET_UNIFORM_STRIDE * PACKET_UNIFORM_SLOT_COUNT,
                GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            );
            const configBuffer = this.createConfigBuffer(options.codecPrivate);
            const streamBuffer = this.createStreamBuffer(stream, outputFormat, options.codecPrivate?.byteLength ?? 0);
            this.stateBuffer = this.createBuffer(
                'state',
                Math.max(BYTES_PER_WORD, alignTo(manifest.stateByteLength, BYTES_PER_WORD)),
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            );
            this.statusBuffer = this.createBuffer(
                'status',
                GPU_DECODER_STATUS_BYTE_LENGTH,
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
            );
            const scratchBuffers = manifest.buffers.map(buffer => this.createBuffer(
                `buffer ${buffer.name}`,
                alignTo(buffer.byteLength, BYTES_PER_WORD),
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
            ));
            for (let readbackIndex = 0; readbackIndex < STATUS_READBACK_COUNT; readbackIndex += 1) {
                this.freeReadbacks.push({
                    buffer: this.createBuffer(`status readback ${readbackIndex}`, GPU_DECODER_STATUS_BYTE_LENGTH, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
                    epoch: 0
                });
            }
            this.dispatches = this.prepareDispatches(resources, scratchBuffers);
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
     * Compiles a decoder on a device and allocates its pool and buffers.
     * Rejects with a GPUVideoDecodeError whose failure names the check: 'codec-private-size', 'coded-size', 'visible-rectangle', 'feature-missing', 'storage-buffer-count', 'dispatch-count', 'compile-error', 'pipeline-error', 'slot-count', or 'pool-size'.
     * A 'compile-error' carries every compile message, with lines that point into the decoder's source.
     */
    static async create(options: GPUVideoDecodeSessionOptions): Promise<GPUVideoDecodeSession> {
        const { device, manifest, stream } = options;
        const codecPrivateByteLength = options.codecPrivate?.byteLength ?? 0;
        if (codecPrivateByteLength > GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH) {
            throw new GPUVideoDecodeError({
                code: 'codec-private-size',
                detail: `${codecPrivateByteLength} > ${GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH}`
            });
        }
        requireGPUFramePoolCodedSize(stream.codedWidth, stream.codedHeight);
        requireVisibleRectangle(stream);
        const layoutEntries = createGPUDecoderBindGroupLayoutEntries(manifest.buffers.length);
        requireDeviceSupport(device, manifest, layoutEntries);
        const dispatchPlans = planDispatches(manifest, stream, device.limits.maxComputeWorkgroupsPerDimension);

        const decoderModule = createGPUDecoderModule(manifest);
        const shaderModule = device.createShaderModule({ code: decoderModule.code, label: `GPU decoder ${manifest.name}` });
        const compilationInfo = await shaderModule.getCompilationInfo();
        const errors = mapCompilationMessages(compilationInfo.messages, decoderModule.firstBodyLine, manifest.bodyFirstLine);
        if (errors.length > 0) {
            throw new GPUVideoDecodeError({ code: 'compile-error', detail: describeCompileMessage(errors[0]) }, errors);
        }
        const bindGroupLayout = device.createBindGroupLayout({ entries: layoutEntries, label: `GPU decoder ${manifest.name}` });
        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [ bindGroupLayout ], label: `GPU decoder ${manifest.name}` });
        const pipelines = await createPipelines(device, manifest, shaderModule, pipelineLayout);
        const session = new GPUVideoDecodeSession(options, manifest.outputFormat, { bindGroupLayout, dispatchPlans, pipelines });
        session.observeDeviceLoss();
        return session;
    }

    /** Queues a compressed packet in decode order; it waits for submitPendingDecodeWork() and a free slot. */
    queuePacket(packet: GPUDecodePacket): void {
        if (this.destroyed || this.failure) {
            return;
        }
        if (packet.data.byteLength > this.manifest.packetByteLength) {
            this.fail({ code: 'packet-size', detail: `${packet.data.byteLength} > ${this.manifest.packetByteLength}` });
            return;
        }
        this.pendingPackets.push(packet);
    }

    /**
     * Encodes and submits at most one packet's decode work, when a packet waits and a slot is free.
     * The presenter calls it right after a presentation submit, so presentation never queues behind more than one frame of decode work.
     * Without a packet to submit, it reads back the status a skipped readback left uncaptured, since slots it frees may be what the next packet waits for.
     */
    submitPendingDecodeWork(): void {
        if (this.destroyed || this.failure) {
            return;
        }
        if (!this.submitNextPacket()) {
            this.submitOwedStatusReadback();
        }
        this.flushEndOfStreamIfDecoded();
    }

    /**
     * Returns the newest decoded frame due at the target time, and releases older due frames as dropped.
     * The frame holds its slot until releaseFrame(); null when no frame is due or the session failed.
     */
    takeFrame(targetTimeMicroseconds: number): GPUDecodedFrame | null {
        if (this.destroyed || this.failure) {
            return null;
        }
        let selectedIndex = -1;
        for (let frameIndex = 0; frameIndex < this.presentableFrames.length; frameIndex += 1) {
            if (this.presentableFrames[frameIndex].timestampMicroseconds > targetTimeMicroseconds) {
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

    /** Returns the earliest decoded frame regardless of time, as a conformance check reads every frame. */
    takeNextFrame(): GPUDecodedFrame | null {
        if (this.destroyed || this.failure) {
            return null;
        }
        const nextFrame = this.presentableFrames.shift();
        return nextFrame ? this.createTakenFrame(nextFrame, 0) : null;
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
     * Drops queued packets and decoded frames that were not taken, and every decoder reference, for a seek or a new video epoch.
     * The next packet decodes as a reset, which clears the state and status buffers, whether or not it carries the flag.
     */
    reset(): void {
        if (this.destroyed) {
            return;
        }
        this.beginDecoderEpoch();
        this.pendingPackets.length = 0;
        for (const entry of [ ...this.reorderFrames, ...this.presentableFrames ]) {
            this.pool.releaseOutput(entry.slot);
        }
        this.reorderFrames.length = 0;
        this.presentableFrames.length = 0;
        this.endOfStreamPending = false;
        this.lastReleasedTimestampMicroseconds = Number.NEGATIVE_INFINITY;
        this.resetPending = true;
    }

    /** Releases the frames the reorder depth holds back once every queued packet has decoded, since no earlier frame can follow. */
    endOfStream(): void {
        this.endOfStreamPending = true;
        this.flushEndOfStreamIfDecoded();
    }

    /** Resolves once every status readback in flight has been applied. */
    async waitForStatusReadbacks(): Promise<void> {
        while (this.inFlightReadbacks.size > 0) {
            await Promise.all([ ...this.inFlightReadbacks ]);
        }
    }

    /**
     * Resolves once the status of every submitted packet has been read back and applied, including reports a skipped readback left uncaptured.
     * A conformance check calls it after the last packet, so a decoder error that packet reports is never missed.
     */
    async flushStatusReadbacks(): Promise<void> {
        await this.waitForStatusReadbacks();
        if (this.destroyed || this.failure) {
            return;
        }
        this.submitOwedStatusReadback();
        await this.waitForStatusReadbacks();
    }

    getDroppedFrameCount(): number {
        return this.droppedFrameCount;
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

    /** Returns the decoded frames waiting for presentation, including those the reorder depth holds back. */
    getQueuedFrameCount(): number {
        return this.reorderFrames.length + this.presentableFrames.length;
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.pendingPackets.length = 0;
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
        this.statusCaptureOwed = false;
        this.pool.releaseAllReferences();
    }

    /** A lost device takes the decoder with it; recovery rebuilds without the decoder. */
    private observeDeviceLoss(): void {
        void this.device.lost.then((info: GPUDeviceLostInfo): void => {
            this.fail({ code: 'device-lost', detail: info.message.length > 0 ? `${info.reason}: ${info.message}` : info.reason });
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

    /** Resolves each dispatch's pipeline, and gives each indirect dispatch an indirect arguments buffer that no bind group holds. */
    private prepareDispatches(resources: SessionResources, scratchBuffers: readonly GPUBuffer[]): PreparedDispatch[] {
        return resources.dispatchPlans.map((plan, dispatchIndex): PreparedDispatch => {
            const pipeline = resources.pipelines.get(plan.entryPoint);
            if (!pipeline) {
                throw new RangeError(`The entry point '${plan.entryPoint}' has no pipeline`);
            }
            if (plan.kind === 'direct') {
                return { kind: 'direct', pipeline, workgroupCounts: plan.workgroupCounts };
            }
            // A buffer bound for writing cannot serve as indirect arguments in the same dispatch, so a copy carries the counts
            return {
                indirectMirror: this.createBuffer(
                    `indirect arguments ${dispatchIndex}`,
                    INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH,
                    GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
                ),
                indirectSource: scratchBuffers[plan.bufferIndex],
                kind: 'indirect',
                pipeline
            };
        });
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

    /** Submits the first queued packet into a free slot and queues its frame; returns false when no packet waits or no slot is free. */
    private submitNextPacket(): boolean {
        const packet = this.pendingPackets.at(0);
        if (!packet) {
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
        this.submitPacket(packet, slot);
        this.receiveDecodedFrame({ durationMicroseconds: packet.durationMicroseconds, slot, timestampMicroseconds: packet.timestampMicroseconds });
        return true;
    }

    private submitPacket(packet: GPUDecodePacket, slot: number): void {
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

        const encoder = this.device.createCommandEncoder({ label: `GPU decoder ${this.manifest.name} packet ${this.packetIndex}` });
        if (reset) {
            encoder.clearBuffer(this.stateBuffer);
            encoder.clearBuffer(this.statusBuffer);
        }
        this.encodeDispatches(encoder, uniformOffset);
        const readback = this.encodeStatusReadback(encoder);
        this.device.queue.submit([ encoder.finish() ]);
        this.packetIndex = (this.packetIndex + 1) % U32_VALUE_COUNT;
        // The status accumulates until a readback captures it, so a later capture covers this packet's reports
        this.statusCaptureOwed = readback === null;
        if (readback) {
            this.mapStatusReadback(readback);
        }
    }

    /** Submits a readback of its own for the status a skipped readback left uncaptured, once a readback buffer is free. */
    private submitOwedStatusReadback(): void {
        const readback = this.statusCaptureOwed ? this.freeReadbacks.pop() : undefined;
        if (!readback) {
            return;
        }
        const encoder = this.device.createCommandEncoder({ label: `GPU decoder ${this.manifest.name} status` });
        this.encodeStatusCopy(encoder, readback);
        this.device.queue.submit([ encoder.finish() ]);
        this.statusCaptureOwed = false;
        this.mapStatusReadback(readback);
    }

    private beginComputePass(encoder: GPUCommandEncoder, uniformOffset: number): GPUComputePassEncoder {
        const pass = encoder.beginComputePass({ label: `GPU decoder ${this.manifest.name}` });
        pass.setBindGroup(0, this.bindGroup, [ uniformOffset ]);
        return pass;
    }

    /** Encodes the dispatch sequence; an indirect dispatch ends the pass to copy its counts, since copies run between passes. */
    private encodeDispatches(encoder: GPUCommandEncoder, uniformOffset: number): void {
        let pass = this.beginComputePass(encoder, uniformOffset);
        for (const dispatch of this.dispatches) {
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

    /** Encodes a status copy into a free readback buffer; returns null while every readback is mapping. */
    private encodeStatusReadback(encoder: GPUCommandEncoder): StatusReadback | null {
        const readback = this.freeReadbacks.pop();
        if (!readback) {
            return null;
        }
        this.encodeStatusCopy(encoder, readback);
        return readback;
    }

    /** Copies the status into a readback buffer and clears the freed-slot mask it captured, so each freed slot is reported once. */
    private encodeStatusCopy(encoder: GPUCommandEncoder, readback: StatusReadback): void {
        readback.epoch = this.epoch;
        encoder.copyBufferToBuffer(this.statusBuffer, 0, readback.buffer, 0, GPU_DECODER_STATUS_BYTE_LENGTH);
        encoder.clearBuffer(this.statusBuffer, GPU_DECODER_STATUS_FREED_SLOT_MASK_BYTE_OFFSET, BYTES_PER_WORD);
    }

    private mapStatusReadback(readback: StatusReadback): void {
        const readbackPromise = readback.buffer.mapAsync(GPUMapMode.READ).then(
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

    private applyStatusReadback(readback: StatusReadback): void {
        if (this.destroyed) {
            return;
        }
        const words = new Uint32Array(readback.buffer.getMappedRange(0, GPU_DECODER_STATUS_BYTE_LENGTH).slice(0));
        readback.buffer.unmap();
        this.freeReadbacks.push(readback);
        if (this.failure) {
            return;
        }
        const status = readGPUDecoderStatus(words);
        this.headerFacts ??= status.headerFacts;
        // An error ends the attempt whichever epoch reported it
        if (status.errorCode !== 0) {
            this.fail({ code: 'decoder-error', detail: String(status.errorCode) });
            return;
        }
        if (readback.epoch !== this.epoch) {
            return;
        }
        for (let slot = 0; slot < this.pool.layout.slotCount; slot += 1) {
            // Unsigned shift, since slot 31 sets the sign bit
            if (((status.freedSlotMask >>> slot) & 1) === 1) {
                this.pool.releaseReference(slot);
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

    /** Queues a frame for presentation; a frame earlier than one already released means the stream reorders deeper than declared, so it is dropped. */
    private releaseToPresentation(entry: DecodedFrameEntry): void {
        if (entry.timestampMicroseconds < this.lastReleasedTimestampMicroseconds) {
            this.pool.releaseOutput(entry.slot);
            this.droppedFrameCount += 1;
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
        for (const entry of this.reorderFrames.splice(0)) {
            this.releaseToPresentation(entry);
        }
    }

    private createTakenFrame(entry: DecodedFrameEntry, droppedFrameCount: number): GPUDecodedFrame {
        const frame: GPUDecodedFrame = {
            droppedFrameCount,
            durationMicroseconds: entry.durationMicroseconds,
            frame: this.pool.getFrame(entry.slot),
            slot: entry.slot,
            timestampMicroseconds: entry.timestampMicroseconds
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
    }
}
