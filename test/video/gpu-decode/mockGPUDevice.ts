// A WebGPU device whose buffers hold real bytes and whose queue runs copies, clears, and dispatches in submission order.
// A dispatch runs no WGSL; a test plays the decoder's part through the device's dispatch handler.

const DEFAULT_LIMITS = {
    maxBufferSize: 256 * 1024 * 1024,
    maxComputeWorkgroupsPerDimension: 65_535,
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
    maxStorageBuffersPerShaderStage: 8,
    minStorageBufferOffsetAlignment: 256,
    minUniformBufferOffsetAlignment: 256
};

export type MockGPULimits = typeof DEFAULT_LIMITS;

export type MockCompilationMessage = {
    lineNum: number
    linePos: number
    message: string
    type: 'error' | 'info' | 'warning'
};

export type MockBindGroupEntry = {
    binding: number
    resource: { buffer: MockGPUBuffer; offset?: number; size?: number }
};

export type MockBindGroup = {
    entries: readonly MockBindGroupEntry[]
    label: string
};

export type MockComputePipeline = {
    entryPoint: string
    label: string
};

/** One dispatch as the queue ran it, with what was bound. */
export type MockDispatch = {
    bindGroup: MockBindGroup
    dynamicOffsets: readonly number[]
    entryPoint: string
    indirectBuffer: MockGPUBuffer | null
    /** The workgroup counts, read from the indirect buffer when the dispatch is indirect. */
    workgroupCounts: readonly [number, number, number]
};

type MockCommand =
    | { kind: 'clear'; buffer: MockGPUBuffer; offset: number; size: number }
    | { kind: 'copy'; destination: MockGPUBuffer; destinationOffset: number; size: number; source: MockGPUBuffer; sourceOffset: number }
    | {
        bindGroup: MockBindGroup
        dynamicOffsets: readonly number[]
        indirectBuffer: MockGPUBuffer | null
        indirectOffset: number
        kind: 'dispatch'
        pipeline: MockComputePipeline
        workgroupCounts: readonly [number, number, number] | null
    };

export type MockCommandBuffer = {
    commands: readonly MockCommand[]
};

export type MockDispatchHandler = (dispatch: MockDispatch, device: MockGPUDevice) => void;

/** A buffer whose bytes the queue reads and writes. */
export class MockGPUBuffer {
    readonly data: Uint8Array;
    destroyed = false;
    readonly label: string;
    mapState: 'mapped' | 'pending' | 'unmapped' = 'unmapped';
    readonly size: number;
    readonly usage: number;
    private readonly device: MockGPUDevice;

    constructor(device: MockGPUDevice, descriptor: GPUBufferDescriptor) {
        this.device = device;
        this.data = new Uint8Array(descriptor.size);
        this.label = descriptor.label ?? '';
        this.size = descriptor.size;
        this.usage = descriptor.usage;
    }

    destroy(): void {
        this.destroyed = true;
        this.device.rejectPendingMap(this);
    }

    getMappedRange(offset = 0, size: number = this.size - offset): ArrayBuffer {
        if (this.mapState !== 'mapped') {
            throw new Error(`Buffer ${this.label} is not mapped`);
        }
        return this.data.slice(offset, offset + size).buffer;
    }

    mapAsync(): Promise<void> {
        if (this.mapState !== 'unmapped' || this.destroyed) {
            return Promise.reject(new Error(`Buffer ${this.label} cannot be mapped`));
        }
        this.mapState = 'pending';
        return this.device.scheduleMap(this);
    }

    unmap(): void {
        this.mapState = 'unmapped';
    }

    /** Reads little-endian 32-bit words from a byte offset. */
    readWords(byteOffset: number, wordCount: number): Uint32Array {
        return new Uint32Array(this.data.slice(byteOffset, byteOffset + wordCount * 4).buffer);
    }

    /** Writes little-endian 32-bit words at a byte offset, as a dispatch would. */
    writeWords(byteOffset: number, words: readonly number[]): void {
        const view = new DataView(this.data.buffer);
        for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
            view.setUint32(byteOffset + wordIndex * 4, words[wordIndex] >>> 0, true);
        }
    }
}

class MockComputePassEncoder {
    private bindGroup: MockBindGroup | null = null;
    private readonly commands: MockCommand[];
    private dynamicOffsets: readonly number[] = [];
    private pipeline: MockComputePipeline | null = null;

    constructor(commands: MockCommand[]) {
        this.commands = commands;
    }

    dispatchWorkgroups(workgroupCountX: number, workgroupCountY = 1, workgroupCountZ = 1): void {
        this.pushDispatch([ workgroupCountX, workgroupCountY, workgroupCountZ ], null, 0);
    }

    dispatchWorkgroupsIndirect(indirectBuffer: MockGPUBuffer, indirectOffset: number): void {
        this.pushDispatch(null, indirectBuffer, indirectOffset);
    }

    end(): void {
        this.pipeline = null;
    }

    setBindGroup(index: number, bindGroup: MockBindGroup, dynamicOffsets: readonly number[] = []): void {
        if (index !== 0) {
            throw new Error('Decoder bind groups live in group 0');
        }
        this.bindGroup = bindGroup;
        this.dynamicOffsets = [ ...dynamicOffsets ];
    }

    setPipeline(pipeline: MockComputePipeline): void {
        this.pipeline = pipeline;
    }

    private pushDispatch(
        workgroupCounts: readonly [number, number, number] | null,
        indirectBuffer: MockGPUBuffer | null,
        indirectOffset: number
    ): void {
        if (!this.pipeline || !this.bindGroup) {
            throw new Error('A dispatch needs a pipeline and a bind group');
        }
        this.commands.push({
            bindGroup: this.bindGroup,
            dynamicOffsets: this.dynamicOffsets,
            indirectBuffer,
            indirectOffset,
            kind: 'dispatch',
            pipeline: this.pipeline,
            workgroupCounts
        });
    }
}

class MockCommandEncoder {
    private readonly commands: MockCommand[] = [];

    beginComputePass(): MockComputePassEncoder {
        return new MockComputePassEncoder(this.commands);
    }

    clearBuffer(buffer: MockGPUBuffer, offset = 0, size: number = buffer.size - offset): void {
        this.commands.push({ buffer, kind: 'clear', offset, size });
    }

    copyBufferToBuffer(
        source: MockGPUBuffer,
        sourceOffset: number,
        destination: MockGPUBuffer,
        destinationOffset: number,
        size: number
    ): void {
        this.commands.push({ destination, destinationOffset, kind: 'copy', size, source, sourceOffset });
    }

    finish(): MockCommandBuffer {
        return { commands: [ ...this.commands ] };
    }
}

type PendingMap = {
    buffer: MockGPUBuffer
    reject: (error: Error) => void
    resolve: () => void
};

/** The device, its queue, and a record of what ran on it. */
export class MockGPUDevice {
    readonly bindGroupLayouts: GPUBindGroupLayoutDescriptor[] = [];
    readonly bindGroups: MockBindGroup[] = [];
    readonly buffers: MockGPUBuffer[] = [];
    compilationMessages: MockCompilationMessage[] = [];
    readonly dispatches: MockDispatch[] = [];
    dispatchHandler: MockDispatchHandler = (): void => undefined;
    readonly features: Set<string>;
    readonly limits: MockGPULimits;
    readonly lost: Promise<GPUDeviceLostInfo>;
    /** When true, mapAsync settles only through settlePendingMaps(). */
    manualMaps = false;
    readonly pipelines: MockComputePipeline[] = [];
    readonly queue = {
        onSubmittedWorkDone: (): Promise<void> => Promise.resolve(),
        submit: (commandBuffers: readonly MockCommandBuffer[]): void => {
            this.submitCount += 1;
            for (const commandBuffer of commandBuffers) {
                for (const command of commandBuffer.commands) {
                    this.runCommand(command);
                }
            }
        },
        writeBuffer: (buffer: MockGPUBuffer, bufferOffset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number): void => {
            this.writeBufferCount += 1;
            const bytes = data instanceof ArrayBuffer ?
                new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset) :
                new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            if (bufferOffset % 4 !== 0 || bytes.byteLength % 4 !== 0) {
                throw new Error('writeBuffer offsets and sizes must be multiples of 4');
            }
            buffer.data.set(bytes, bufferOffset);
        }
    };
    readonly shaderModuleCodes: string[] = [];
    submitCount = 0;
    writeBufferCount = 0;
    private readonly pendingMaps: PendingMap[] = [];
    private resolveLost: (info: GPUDeviceLostInfo) => void = (): void => undefined;

    constructor(features: readonly string[] = [], limits: Partial<MockGPULimits> = {}) {
        this.features = new Set(features);
        this.limits = { ...DEFAULT_LIMITS, ...limits };
        this.lost = new Promise<GPUDeviceLostInfo>(resolve => {
            this.resolveLost = resolve;
        });
    }

    asDevice(): GPUDevice {
        return this as unknown as GPUDevice;
    }

    createBindGroup(descriptor: { entries: readonly MockBindGroupEntry[]; label?: string }): MockBindGroup {
        const bindGroup: MockBindGroup = { entries: descriptor.entries, label: descriptor.label ?? '' };
        this.bindGroups.push(bindGroup);
        return bindGroup;
    }

    createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayoutDescriptor {
        this.bindGroupLayouts.push(descriptor);
        return descriptor;
    }

    createBuffer(descriptor: GPUBufferDescriptor): MockGPUBuffer {
        const buffer = new MockGPUBuffer(this, descriptor);
        this.buffers.push(buffer);
        return buffer;
    }

    createCommandEncoder(): MockCommandEncoder {
        return new MockCommandEncoder();
    }

    createComputePipelineAsync(descriptor: { compute: { entryPoint?: string }; label?: string }): Promise<MockComputePipeline> {
        const pipeline: MockComputePipeline = { entryPoint: descriptor.compute.entryPoint ?? '', label: descriptor.label ?? '' };
        this.pipelines.push(pipeline);
        return Promise.resolve(pipeline);
    }

    createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayoutDescriptor {
        return descriptor;
    }

    createShaderModule(descriptor: { code: string }): { getCompilationInfo: () => Promise<{ messages: MockCompilationMessage[] }> } {
        this.shaderModuleCodes.push(descriptor.code);
        const messages = [ ...this.compilationMessages ];
        return { getCompilationInfo: (): Promise<{ messages: MockCompilationMessage[] }> => Promise.resolve({ messages }) };
    }

    /** Returns the buffers whose label contains the text. */
    findBuffers(labelText: string): MockGPUBuffer[] {
        return this.buffers.filter(buffer => buffer.label.includes(labelText));
    }

    /** Returns the one buffer with exactly this label. */
    findBuffer(label: string): MockGPUBuffer {
        const matches = this.buffers.filter(buffer => buffer.label === label);
        if (matches.length !== 1) {
            throw new Error(`Expected one buffer labeled ${label}, found ${matches.length}`);
        }
        return matches[0];
    }

    loseDevice(message: string): void {
        this.resolveLost({ message, reason: 'unknown' } as GPUDeviceLostInfo);
    }

    rejectPendingMap(buffer: MockGPUBuffer): void {
        const pendingIndex = this.pendingMaps.findIndex(pending => pending.buffer === buffer);
        if (pendingIndex >= 0) {
            const [ pending ] = this.pendingMaps.splice(pendingIndex, 1);
            buffer.mapState = 'unmapped';
            pending.reject(new Error('The buffer was destroyed while mapping'));
        }
    }

    scheduleMap(buffer: MockGPUBuffer): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const pending: PendingMap = { buffer, reject, resolve };
            if (this.manualMaps) {
                this.pendingMaps.push(pending);
                return;
            }
            void Promise.resolve().then((): void => {
                this.settleMap(pending);
            });
        });
    }

    /** Settles every map waiting under manualMaps. */
    settlePendingMaps(): void {
        for (const pending of this.pendingMaps.splice(0)) {
            this.settleMap(pending);
        }
    }

    getPendingMapCount(): number {
        return this.pendingMaps.length;
    }

    private settleMap(pending: PendingMap): void {
        if (pending.buffer.destroyed) {
            pending.buffer.mapState = 'unmapped';
            pending.reject(new Error('The buffer was destroyed while mapping'));
            return;
        }
        pending.buffer.mapState = 'mapped';
        pending.resolve();
    }

    private runCommand(command: MockCommand): void {
        switch (command.kind) {
            case 'clear':
                command.buffer.data.fill(0, command.offset, command.offset + command.size);
                return;
            case 'copy':
                command.destination.data.set(
                    command.source.data.subarray(command.sourceOffset, command.sourceOffset + command.size),
                    command.destinationOffset
                );
                return;
            case 'dispatch': {
                const workgroupCounts = command.workgroupCounts ?? readIndirectCounts(command.indirectBuffer, command.indirectOffset);
                const dispatch: MockDispatch = {
                    bindGroup: command.bindGroup,
                    dynamicOffsets: command.dynamicOffsets,
                    entryPoint: command.pipeline.entryPoint,
                    indirectBuffer: command.indirectBuffer,
                    workgroupCounts
                };
                this.dispatches.push(dispatch);
                this.dispatchHandler(dispatch, this);
            }
        }
    }
}

function readIndirectCounts(buffer: MockGPUBuffer | null, offset: number): readonly [number, number, number] {
    if (!buffer) {
        throw new Error('An indirect dispatch needs its buffer');
    }
    const words = buffer.readWords(offset, 3);
    return [ words[0], words[1], words[2] ];
}

/** Returns the buffer a dispatch bound at a binding. */
export function getBoundBuffer(dispatch: MockDispatch, binding: number): MockGPUBuffer {
    const entry = dispatch.bindGroup.entries.find(candidate => candidate.binding === binding);
    if (!entry) {
        throw new Error(`The dispatch bound nothing at binding ${binding}`);
    }
    return entry.resource.buffer;
}
