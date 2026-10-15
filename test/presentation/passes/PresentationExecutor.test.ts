import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    PRESENTATION_UNIFORM_BYTE_LENGTH,
    type PresentationUniformValues,
    UNIFORM_SLOT_BYTE_LENGTH
} from 'webgpu-player/presentation/passes/PassResources';
import type {
    FramePoolFrame,
    PassParameter,
    PlannedBinding,
    PlannedOutput,
    PlannedPass,
    PlannedTexture,
    PresentationFrameInput,
    PresentationFrameSource,
    PresentationPlan
} from 'webgpu-player/presentation/passes/PassTypes';
import {
    configurePresentationCanvas,
    PresentationCompileError,
    PresentationExecutor
} from 'webgpu-player/presentation/passes/PresentationExecutor';
import type { TexturePresentationGeometry } from 'webgpu-player/presentation/PresentationGeometry';
import { RENDER_SETTINGS_UNIFORM_BYTE_LENGTH } from 'webgpu-player/presentation/RenderSettings';
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from 'webgpu-player/demux/dolby-vision/DolbyVisionRPUParser';
import {
    copyVideoFramePairToRawPlanes,
    copyVideoFrameToRawPlanes,
    type RawVideoFrameRectangle,
    type RawVideoFrameSource,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from 'webgpu-player/decode/video/RawVideoFrameCopy';

type MockFunction = ReturnType<typeof vi.fn>;

type MockTexture = {
    createView: () => MockTextureView
    descriptor: GPUTextureDescriptor
    destroy: MockFunction
    label: string
};

type MockTextureView = {
    label: string
    texture: MockTexture
};

type MockBuffer = {
    descriptor: GPUBufferDescriptor
    destroy: MockFunction
    label: string
};

type MockDescribed<Descriptor> = { descriptor: Descriptor };

type BufferWrite = {
    buffer: MockBuffer
    bufferOffset: number
    bytes: ArrayBuffer
};

type TextureWrite = {
    data: unknown
    dataLayout: GPUTexelCopyBufferLayout
    destination: MockTexture
};

type RecordedRenderPass = {
    bindGroup: MockDescribed<GPUBindGroupDescriptor> | null
    descriptor: GPURenderPassDescriptor
    drawVertexCounts: number[]
    kind: 'render'
    pipeline: MockDescribed<GPURenderPipelineDescriptor> | null
    viewport: readonly number[] | null
};

type RecordedComputePass = {
    bindGroup: MockDescribed<GPUBindGroupDescriptor> | null
    directDispatches: (readonly number[])[]
    indirectDispatches: { buffer: MockBuffer; offset: number }[]
    kind: 'compute'
    pipeline: MockDescribed<GPUComputePipelineDescriptor> | null
};

type RecordedPass = RecordedComputePass | RecordedRenderPass;

type CommandEncoderHarness = {
    encoder: GPUCommandEncoder
    passes: RecordedPass[]
};

type DeviceHarness = {
    bindGroupLayouts: MockDescribed<GPUBindGroupLayoutDescriptor>[]
    bindGroups: MockDescribed<GPUBindGroupDescriptor>[]
    bufferWrites: BufferWrite[]
    buffers: MockBuffer[]
    compilationMessages: Map<string, GPUCompilationMessage[]>
    computePipelines: MockDescribed<GPUComputePipelineDescriptor>[]
    device: GPUDevice
    externalTextures: object[]
    importExternalTexture: MockFunction
    pipelineLayouts: MockDescribed<GPUPipelineLayoutDescriptor>[]
    renderPipelines: MockDescribed<GPURenderPipelineDescriptor>[]
    sampler: object
    textureWrites: TextureWrite[]
    textures: MockTexture[]
};

// WebGPU's flag values, which jsdom does not define
// eslint-disable-next-line @typescript-eslint/naming-convention
const GPU_BUFFER_USAGE = { COPY_DST: 8, INDIRECT: 256, STORAGE: 128, UNIFORM: 64 } as const;
// eslint-disable-next-line @typescript-eslint/naming-convention
const GPU_TEXTURE_USAGE = { COPY_DST: 2, RENDER_ATTACHMENT: 16, STORAGE_BINDING: 8, TEXTURE_BINDING: 4 } as const;
const GPU_SHADER_STAGE = { COMPUTE: 4, FRAGMENT: 2, VERTEX: 1 } as const;

// The executor's resource labels
const PRESENTATION_UNIFORMS_LABEL = 'Presentation uniforms';
const PARAMETERS_LABEL = 'Presentation parameters';
const RENDER_SETTINGS_LABEL = 'Presentation render settings';
const DOLBY_VISION_RPU_LABEL = 'Presentation Dolby Vision RPU';
const ENHANCEMENT_UNIFORM_LABEL = 'Presentation Dolby Vision enhancement uniforms';
const ENHANCEMENT_PLANE_LABEL_PREFIX = 'Raw Dolby Vision enhancement';
const BASE_PLANE_LABEL_PREFIX = 'Raw video';

const MAXIMUM_TEXTURE_DIMENSION = 8_192;
const RENDER_VERTEX_COUNT = 6;
const OUTPUT_FORMAT: GPUTextureFormat = 'bgra8unorm';
const OUTPUT: PlannedOutput = { colorSpace: 'srgb', format: OUTPUT_FORMAT, toneMapping: 'standard' };
const HDR_OUTPUT: PlannedOutput = { colorSpace: 'display-p3', format: 'rgba16float', toneMapping: 'extended' };
const OUTPUT_VIEW = { label: 'canvas view' } as unknown as GPUTextureView;

// An output rectangle letterboxed inside the canvas, with a cropped source
const GEOMETRY: TexturePresentationGeometry = {
    textureOffsetX: 0.125,
    textureOffsetY: 0.25,
    textureScaleX: 0.75,
    textureScaleY: 0.5,
    viewportHeight: 540,
    viewportWidth: 960,
    viewportX: 160,
    viewportY: 90
};

const SOURCE_WIDTH = 1_920;
const SOURCE_HEIGHT = 1_080;
const SCALED_WIDTH = 1_280;
const SCALED_HEIGHT = 720;
const TIMESTAMP_MICROSECONDS = 2_500_000;
const TIMESTAMP_SECONDS = 2.5;
const FRAME_DURATION_MICROSECONDS = 41_667;
const SKIPPED_FRAME_COUNT = 2;

// A coded raw frame whose visible rectangle is inset by chroma-aligned margins
const RAW_CODED_WIDTH = 64;
const RAW_CODED_HEIGHT = 40;
const RAW_VISIBLE_RECTANGLE: RawVideoFrameRectangle = { height: 36, width: 56, x: 4, y: 2 };
const RAW_FULL_RECTANGLE: RawVideoFrameRectangle = { height: RAW_CODED_HEIGHT, width: RAW_CODED_WIDTH, x: 0, y: 0 };
const RAW_VISIBLE_SCALE_X = RAW_VISIBLE_RECTANGLE.width / RAW_CODED_WIDTH;
const RAW_VISIBLE_SCALE_Y = RAW_VISIBLE_RECTANGLE.height / RAW_CODED_HEIGHT;
const RAW_VISIBLE_OFFSET_X = RAW_VISIBLE_RECTANGLE.x / RAW_CODED_WIDTH;
const RAW_VISIBLE_OFFSET_Y = RAW_VISIBLE_RECTANGLE.y / RAW_CODED_HEIGHT;

// A Dolby Vision BL and its quarter-size EL
const BASE_CODED_WIDTH = 160;
const BASE_CODED_HEIGHT = 4;
const ENHANCEMENT_CODED_WIDTH = 80;
const ENHANCEMENT_CODED_HEIGHT = 2;
const PLANAR_PLANE_COUNT = 3;

const LINE_MAP_FIRST_GENERATED_LINE = 40;
const LINE_MAP_FIRST_SOURCE_LINE = 8;
const LINE_MAP_LINE_COUNT = 10;
const USER_ERROR_GENERATED_LINE = 43;
const USER_ERROR_COLUMN = 5;
const ENGINE_ERROR_GENERATED_LINE = 12;
const ENGINE_ERROR_COLUMN = 3;
const USER_ERROR_MESSAGE = "unresolved identifier 'strenght'";
const ENGINE_ERROR_MESSAGE = 'type mismatch in the prelude';
const OTHER_PASS_ERROR_MESSAGE = 'missing entry point';
const WARNING_MESSAGE = 'unused variable';

const GRADE_PASS_NAME = 'Grade';
const GAIN_PASS_NAME = 'Gain';
const STRENGTH_PARAMETER: PassParameter = { defaultValue: 0.5, maximum: 1, minimum: 0, name: 'strength', type: 'f32' };
const RADIUS_PARAMETER: PassParameter = { defaultValue: -2, maximum: 4, minimum: -4, name: 'radius', type: 'i32' };
const TAPS_PARAMETER: PassParameter = { defaultValue: 3, maximum: 8, minimum: 1, name: 'taps', type: 'u32' };
const GAIN_PARAMETER: PassParameter = { defaultValue: 2, maximum: 4, minimum: 0, name: 'gain', type: 'f32' };
const UPDATED_STRENGTH = 0.25;
const RADIUS_ABOVE_MAXIMUM = 9;
const TAPS_BETWEEN_INTEGERS = 2.6;
const ROUNDED_TAPS = 3;
const UPDATED_GAIN = 0.5;
const PARAMETER_BYTE_LENGTH = 4;
const UNKNOWN_NAME = 'missing';

const WORKGROUP_COUNTS: readonly [number, number, number] = [ 4, 2, 1 ];
const INDIRECT_ARGUMENTS_BYTE_LENGTH = 12;
const STATE_BYTE_LENGTH = 64;
const STEADY_STATE_FRAME_COUNT = 5;
const HISTORY_DEPTH = 1;

// Byte offsets of the presentation uniform's fields, in PRESENTATION_UNIFORMS_WGSL order
const PRESENTATION_FIELD_OFFSETS = {
    frameIndex: 44,
    historyValid: 48,
    inputHeight: 36,
    inputWidth: 32,
    outputHeight: 28,
    outputWidth: 24,
    skippedFrames: 52,
    sourceHeight: 20,
    sourceWidth: 16,
    textureOffsetX: 8,
    textureOffsetY: 12,
    textureScaleX: 0,
    textureScaleY: 4,
    timestampSeconds: 40
} as const;

const FLOAT_PRECISION_DIGITS = 6;

const originalDescriptors = new Map<string, PropertyDescriptor | undefined>([
    [ 'GPUBufferUsage', Object.getOwnPropertyDescriptor(globalThis, 'GPUBufferUsage') ],
    [ 'GPUShaderStage', Object.getOwnPropertyDescriptor(globalThis, 'GPUShaderStage') ],
    [ 'GPUTextureUsage', Object.getOwnPropertyDescriptor(globalThis, 'GPUTextureUsage') ]
]);

function restoreProperty(target: object, propertyName: string, descriptor: PropertyDescriptor | undefined): void {
    if (descriptor) {
        Object.defineProperty(target, propertyName, descriptor);
    } else {
        Reflect.deleteProperty(target, propertyName);
    }
}

function createDeviceHarness(): DeviceHarness {
    const harness: Omit<DeviceHarness, 'device' | 'importExternalTexture'> = {
        bindGroupLayouts: [],
        bindGroups: [],
        bufferWrites: [],
        buffers: [],
        compilationMessages: new Map<string, GPUCompilationMessage[]>(),
        computePipelines: [],
        externalTextures: [],
        pipelineLayouts: [],
        renderPipelines: [],
        sampler: { label: 'sampler' },
        textureWrites: [],
        textures: []
    };
    const importExternalTexture = vi.fn((descriptor: GPUExternalTextureDescriptor) => {
        const externalTexture = { descriptor };
        harness.externalTextures.push(externalTexture);
        return externalTexture;
    });
    const device = {
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => {
            const bindGroup = { descriptor };
            harness.bindGroups.push(bindGroup);
            return bindGroup;
        }),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => {
            const layout = { descriptor };
            harness.bindGroupLayouts.push(layout);
            return layout;
        }),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const buffer: MockBuffer = { descriptor, destroy: vi.fn(), label: descriptor.label ?? '' };
            harness.buffers.push(buffer);
            return buffer;
        }),
        createComputePipelineAsync: vi.fn((descriptor: GPUComputePipelineDescriptor) => {
            const pipeline = { descriptor };
            harness.computePipelines.push(pipeline);
            return Promise.resolve(pipeline);
        }),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => {
            const layout = { descriptor };
            harness.pipelineLayouts.push(layout);
            return layout;
        }),
        createRenderPipelineAsync: vi.fn((descriptor: GPURenderPipelineDescriptor) => {
            const pipeline = { descriptor };
            harness.renderPipelines.push(pipeline);
            return Promise.resolve(pipeline);
        }),
        createSampler: vi.fn(() => harness.sampler),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => ({
            getCompilationInfo: (): Promise<{ messages: GPUCompilationMessage[] }> => Promise.resolve({
                messages: harness.compilationMessages.get(descriptor.code) ?? []
            })
        })),
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
            const label = descriptor.label ?? '';
            const texture: MockTexture = {
                createView: (): MockTextureView => ({ label, texture }),
                descriptor,
                destroy: vi.fn(),
                label
            };
            harness.textures.push(texture);
            return texture;
        }),
        features: new Set<string>(),
        importExternalTexture,
        limits: { maxTextureDimension2D: MAXIMUM_TEXTURE_DIMENSION },
        queue: {
            writeBuffer: vi.fn((buffer: MockBuffer, bufferOffset: number, data: ArrayBuffer, dataOffset = 0, size?: number) => {
                const byteLength = size ?? data.byteLength - dataOffset;
                harness.bufferWrites.push({ buffer, bufferOffset, bytes: data.slice(dataOffset, dataOffset + byteLength) });
            }),
            writeTexture: vi.fn((destination: { texture: MockTexture }, data: unknown, dataLayout: GPUTexelCopyBufferLayout) => {
                harness.textureWrites.push({ data, dataLayout, destination: destination.texture });
            })
        }
    } as unknown as GPUDevice;
    return { ...harness, device, importExternalTexture };
}

function createCommandEncoderHarness(): CommandEncoderHarness {
    const passes: RecordedPass[] = [];
    const encoder = {
        beginComputePass: () => {
            const record: RecordedComputePass = {
                bindGroup: null,
                directDispatches: [],
                indirectDispatches: [],
                kind: 'compute',
                pipeline: null
            };
            passes.push(record);
            return {
                dispatchWorkgroups: (workgroupCountX: number, workgroupCountY: number, workgroupCountZ: number): void => {
                    record.directDispatches.push([ workgroupCountX, workgroupCountY, workgroupCountZ ]);
                },
                dispatchWorkgroupsIndirect: (buffer: MockBuffer, offset: number): void => {
                    record.indirectDispatches.push({ buffer, offset });
                },
                end: vi.fn(),
                setBindGroup: (_index: number, bindGroup: MockDescribed<GPUBindGroupDescriptor>): void => {
                    record.bindGroup = bindGroup;
                },
                setPipeline: (pipeline: MockDescribed<GPUComputePipelineDescriptor>): void => {
                    record.pipeline = pipeline;
                }
            };
        },
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
            const record: RecordedRenderPass = {
                bindGroup: null,
                descriptor,
                drawVertexCounts: [],
                kind: 'render',
                pipeline: null,
                viewport: null
            };
            passes.push(record);
            return {
                draw: (vertexCount: number): void => {
                    record.drawVertexCounts.push(vertexCount);
                },
                end: vi.fn(),
                setBindGroup: (_index: number, bindGroup: MockDescribed<GPUBindGroupDescriptor>): void => {
                    record.bindGroup = bindGroup;
                },
                setPipeline: (pipeline: MockDescribed<GPURenderPipelineDescriptor>): void => {
                    record.pipeline = pipeline;
                },
                setViewport: (...viewport: number[]): void => {
                    record.viewport = viewport;
                }
            };
        }
    } as unknown as GPUCommandEncoder;
    return { encoder, passes };
}

function createCompilationMessage(type: GPUCompilationMessageType, lineNum: number, linePos: number, message: string): GPUCompilationMessage {
    return { length: 0, lineNum, linePos, message, offset: 0, type } as unknown as GPUCompilationMessage;
}

function createPlan(plan: Partial<PresentationPlan>): PresentationPlan {
    return {
        buffers: [],
        output: OUTPUT,
        parameterSets: [],
        passes: [],
        report: { activePasses: [], inactivePasses: [] },
        sourceKind: 'external',
        textures: [],
        usesRenderSettings: false,
        ...plan
    };
}

function createRenderPass(label: string, pass: Partial<PlannedPass>): PlannedPass {
    return {
        bindings: [],
        code: `// ${label}`,
        colorSteps: [],
        coordinateMapping: 'object-fit',
        indirectBufferId: null,
        inputTextureId: null,
        kind: 'render',
        label,
        lineMap: [],
        target: { kind: 'output' },
        workgroupCounts: null,
        ...pass
    };
}

function createComputePass(label: string, pass: Partial<PlannedPass>): PlannedPass {
    return createRenderPass(label, { kind: 'compute', target: null, workgroupCounts: WORKGROUP_COUNTS, ...pass });
}

function createTexture(id: string, texture: Partial<PlannedTexture>): PlannedTexture {
    return { format: 'rgba16float', height: SCALED_HEIGHT, historyDepth: 0, id, storage: false, width: SCALED_WIDTH, ...texture };
}

function createVideoFrame(): VideoFrame {
    return {
        displayHeight: SOURCE_HEIGHT,
        displayWidth: SOURCE_WIDTH,
        visibleRect: { height: SOURCE_HEIGHT, width: SOURCE_WIDTH, x: 0, y: 0 }
    } as unknown as VideoFrame;
}

function createFrameInput(source: PresentationFrameSource, newFrame = true): PresentationFrameInput {
    return {
        geometry: GEOMETRY,
        newFrame,
        skippedFrameCount: SKIPPED_FRAME_COUNT,
        source,
        target: OUTPUT_VIEW,
        timestampMicroseconds: TIMESTAMP_MICROSECONDS
    };
}

function createExternalFrameInput(newFrame = true): PresentationFrameInput {
    return createFrameInput({ kind: 'external', source: createVideoFrame() }, newFrame);
}

/** A decoded frame whose copy returns the requested layout, as a conforming decoder does. */
function createRawFrameSource(
    format: SupportedRawVideoFrameFormat,
    codedWidth: number,
    codedHeight: number,
    visibleRectangle: RawVideoFrameRectangle
): RawVideoFrameSource {
    return {
        close: vi.fn(),
        codedHeight,
        codedWidth,
        colorSpace: { fullRange: false, matrix: 'bt2020-ncl', primaries: 'bt2020', transfer: 'smpte2084' },
        copyTo: vi.fn(async (_destination: ArrayBuffer, options: VideoFrameCopyToOptions): Promise<PlaneLayout[]> => [
            ...(options.layout ?? [])
        ]),
        displayHeight: visibleRectangle.height,
        displayWidth: visibleRectangle.width,
        duration: FRAME_DURATION_MICROSECONDS,
        format,
        timestamp: TIMESTAMP_MICROSECONDS,
        visibleRect: visibleRectangle
    };
}

function copyRawFrame(format: SupportedRawVideoFrameFormat, visibleRectangle = RAW_FULL_RECTANGLE): Promise<TransferableRawVideoFrame> {
    return copyVideoFrameToRawPlanes(createRawFrameSource(format, RAW_CODED_WIDTH, RAW_CODED_HEIGHT, visibleRectangle));
}

async function copyDolbyVisionFramePair(includeEnhancementFrame: boolean): Promise<{
    baseFrame: TransferableRawVideoFrame
    enhancementFrame: TransferableRawVideoFrame | null
}> {
    const baseRectangle = { height: BASE_CODED_HEIGHT, width: BASE_CODED_WIDTH, x: 0, y: 0 };
    const enhancementRectangle = { height: ENHANCEMENT_CODED_HEIGHT, width: ENHANCEMENT_CODED_WIDTH, x: 0, y: 0 };
    return copyVideoFramePairToRawPlanes(
        createRawFrameSource('I420P10', BASE_CODED_WIDTH, BASE_CODED_HEIGHT, baseRectangle),
        includeEnhancementFrame ?
            createRawFrameSource('I420P10', ENHANCEMENT_CODED_WIDTH, ENHANCEMENT_CODED_HEIGHT, enhancementRectangle) :
            null,
        {
            enhancementExpectedGeometry: {
                codedHeight: ENHANCEMENT_CODED_HEIGHT,
                codedWidth: ENHANCEMENT_CODED_WIDTH,
                displayHeight: ENHANCEMENT_CODED_HEIGHT,
                displayWidth: ENHANCEMENT_CODED_WIDTH
            },
            format: 'I420P10'
        }
    );
}

function createPlanesInput(
    frame: TransferableRawVideoFrame,
    enhancementFrame: TransferableRawVideoFrame | null = null,
    newFrame = true
): PresentationFrameInput {
    return createFrameInput({ enhancementFrame, frame, kind: 'planes' }, newFrame);
}

function findBuffer(harness: DeviceHarness, label: string): MockBuffer {
    const buffer = harness.buffers.find((candidate: MockBuffer): boolean => candidate.label === label);
    if (!buffer) {
        throw new Error(`No buffer labeled '${label}'`);
    }
    return buffer;
}

function getBufferWrites(harness: DeviceHarness, label: string): BufferWrite[] {
    return harness.bufferWrites.filter((write: BufferWrite): boolean => write.buffer.label === label);
}

function readPresentationSlot(bytes: ArrayBuffer, passIndex: number): PresentationUniformValues {
    const view = new DataView(bytes, passIndex * UNIFORM_SLOT_BYTE_LENGTH, PRESENTATION_UNIFORM_BYTE_LENGTH);
    return {
        frameIndex: view.getUint32(PRESENTATION_FIELD_OFFSETS.frameIndex, true),
        historyValid: view.getUint32(PRESENTATION_FIELD_OFFSETS.historyValid, true),
        inputHeight: view.getFloat32(PRESENTATION_FIELD_OFFSETS.inputHeight, true),
        inputWidth: view.getFloat32(PRESENTATION_FIELD_OFFSETS.inputWidth, true),
        outputHeight: view.getFloat32(PRESENTATION_FIELD_OFFSETS.outputHeight, true),
        outputWidth: view.getFloat32(PRESENTATION_FIELD_OFFSETS.outputWidth, true),
        skippedFrames: view.getUint32(PRESENTATION_FIELD_OFFSETS.skippedFrames, true),
        sourceHeight: view.getFloat32(PRESENTATION_FIELD_OFFSETS.sourceHeight, true),
        sourceWidth: view.getFloat32(PRESENTATION_FIELD_OFFSETS.sourceWidth, true),
        textureOffsetX: view.getFloat32(PRESENTATION_FIELD_OFFSETS.textureOffsetX, true),
        textureOffsetY: view.getFloat32(PRESENTATION_FIELD_OFFSETS.textureOffsetY, true),
        textureScaleX: view.getFloat32(PRESENTATION_FIELD_OFFSETS.textureScaleX, true),
        textureScaleY: view.getFloat32(PRESENTATION_FIELD_OFFSETS.textureScaleY, true),
        timestampSeconds: view.getFloat32(PRESENTATION_FIELD_OFFSETS.timestampSeconds, true)
    };
}

function readLastPresentationSlot(harness: DeviceHarness, passIndex: number): PresentationUniformValues {
    const write = getBufferWrites(harness, PRESENTATION_UNIFORMS_LABEL).at(-1);
    if (!write) {
        throw new Error('No presentation uniform write');
    }
    return readPresentationSlot(write.bytes, passIndex);
}

function expectCoordinateMapping(
    slot: PresentationUniformValues,
    scaleX: number,
    scaleY: number,
    offsetX: number,
    offsetY: number
): void {
    expect(slot.textureScaleX).toBeCloseTo(scaleX, FLOAT_PRECISION_DIGITS);
    expect(slot.textureScaleY).toBeCloseTo(scaleY, FLOAT_PRECISION_DIGITS);
    expect(slot.textureOffsetX).toBeCloseTo(offsetX, FLOAT_PRECISION_DIGITS);
    expect(slot.textureOffsetY).toBeCloseTo(offsetY, FLOAT_PRECISION_DIGITS);
}

function getBoundResource(pass: RecordedPass, binding: number): unknown {
    const entries = Array.from(pass.bindGroup?.descriptor.entries ?? []);
    return entries.find((entry: GPUBindGroupEntry): boolean => entry.binding === binding)?.resource;
}

function getBoundLabel(pass: RecordedPass, binding: number): string | undefined {
    return (getBoundResource(pass, binding) as MockTextureView | undefined)?.label;
}

function getRenderPass(passes: readonly RecordedPass[], index: number): RecordedRenderPass {
    const pass = passes[index];
    if (pass?.kind !== 'render') {
        throw new Error(`Pass ${index} is not a render pass`);
    }
    return pass;
}

function getComputePass(passes: readonly RecordedPass[], index: number): RecordedComputePass {
    const pass = passes[index];
    if (pass?.kind !== 'compute') {
        throw new Error(`Pass ${index} is not a compute pass`);
    }
    return pass;
}

function getTargetLabel(pass: RecordedRenderPass): string | undefined {
    const attachment = Array.from(pass.descriptor.colorAttachments)[0];
    return (attachment?.view as MockTextureView | undefined)?.label;
}

function encodeFrame(executor: PresentationExecutor, frame: PresentationFrameInput): RecordedPass[] {
    const commandEncoder = createCommandEncoderHarness();
    executor.encode(commandEncoder.encoder, frame);
    return commandEncoder.passes;
}

const PLANE_BINDINGS: readonly PlannedBinding[] = [
    { binding: 0, kind: 'engine', resource: 'plane-luma' },
    { binding: 1, kind: 'engine', resource: 'plane-chroma-u' },
    { binding: 2, kind: 'engine', resource: 'plane-chroma-v' },
    { binding: 3, kind: 'presentation' }
];

describe('PresentationExecutor', () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, 'GPUBufferUsage', { configurable: true, value: GPU_BUFFER_USAGE });
        Object.defineProperty(globalThis, 'GPUShaderStage', { configurable: true, value: GPU_SHADER_STAGE });
        Object.defineProperty(globalThis, 'GPUTextureUsage', { configurable: true, value: GPU_TEXTURE_USAGE });
    });

    afterEach(() => {
        for (const [ propertyName, descriptor ] of originalDescriptors) {
            restoreProperty(globalThis, propertyName, descriptor);
        }
    });

    it('creates explicit layouts, pipelines, and bind group entries from the planned bindings', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({
            buffers: [ { byteLength: STATE_BYTE_LENGTH, id: 'statistics', indirect: false, persistent: false } ],
            parameterSets: [ { parameters: [ STRENGTH_PARAMETER ], passName: GRADE_PASS_NAME } ],
            passes: [
                createComputePass('Luma', {
                    bindings: [
                        { access: 'storage', binding: 0, historyOffset: 0, kind: 'texture', textureId: 'luma' },
                        { access: 'storage', binding: 1, bufferId: 'statistics', kind: 'buffer' },
                        { binding: 2, kind: 'presentation' }
                    ]
                }),
                createRenderPass('Output', {
                    bindings: [
                        { binding: 0, kind: 'engine', resource: 'sampler-linear' },
                        { binding: 1, kind: 'engine', resource: 'external-texture' },
                        { binding: 2, kind: 'presentation' },
                        { binding: 3, kind: 'parameters', passName: GRADE_PASS_NAME },
                        { binding: 4, kind: 'engine', resource: 'render-settings' },
                        { access: 'read-only-storage', binding: 5, bufferId: 'statistics', kind: 'buffer' },
                        { access: 'sampled', binding: 6, historyOffset: 0, kind: 'texture', textureId: 'luma' },
                        { access: 'sampled', binding: 7, historyOffset: 0, kind: 'texture', textureId: 'color' }
                    ]
                })
            ],
            textures: [
                createTexture('luma', { format: 'r32float', storage: true }),
                createTexture('color', { format: 'rgba16float' })
            ],
            usesRenderSettings: true
        });

        const executor = await PresentationExecutor.create(harness.device, plan);
        const passes = encodeFrame(executor, createExternalFrameInput());

        expect(harness.bindGroupLayouts.map(layout => layout.descriptor.entries)).toEqual([
            [
                { binding: 0, storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' }, visibility: GPU_SHADER_STAGE.COMPUTE },
                { binding: 1, buffer: { type: 'storage' }, visibility: GPU_SHADER_STAGE.COMPUTE },
                { binding: 2, buffer: { type: 'uniform' }, visibility: GPU_SHADER_STAGE.COMPUTE }
            ],
            [
                { binding: 0, sampler: { type: 'filtering' }, visibility: GPU_SHADER_STAGE.FRAGMENT },
                { binding: 1, externalTexture: {}, visibility: GPU_SHADER_STAGE.FRAGMENT },
                { binding: 2, buffer: { type: 'uniform' }, visibility: GPU_SHADER_STAGE.FRAGMENT },
                { binding: 3, buffer: { type: 'uniform' }, visibility: GPU_SHADER_STAGE.FRAGMENT },
                { binding: 4, buffer: { type: 'uniform' }, visibility: GPU_SHADER_STAGE.FRAGMENT },
                { binding: 5, buffer: { type: 'read-only-storage' }, visibility: GPU_SHADER_STAGE.FRAGMENT },
                // 32-bit floats do not filter without the float32-filterable feature
                { binding: 6, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' }, visibility: GPU_SHADER_STAGE.FRAGMENT },
                { binding: 7, texture: { sampleType: 'float', viewDimension: '2d' }, visibility: GPU_SHADER_STAGE.FRAGMENT }
            ]
        ]);
        expect(harness.pipelineLayouts.map(layout => layout.descriptor.bindGroupLayouts)).toEqual([
            [ harness.bindGroupLayouts[0] ],
            [ harness.bindGroupLayouts[1] ]
        ]);
        expect(harness.computePipelines[0].descriptor).toMatchObject({
            compute: { entryPoint: 'computeMain' },
            layout: harness.pipelineLayouts[0]
        });
        expect(harness.renderPipelines[0].descriptor).toMatchObject({
            fragment: { entryPoint: 'fragmentMain', targets: [ { format: OUTPUT_FORMAT } ] },
            layout: harness.pipelineLayouts[1],
            primitive: { topology: 'triangle-list' },
            vertex: { entryPoint: 'vertexMain' }
        });

        const presentationBuffer = findBuffer(harness, PRESENTATION_UNIFORMS_LABEL);
        const statisticsBuffer = findBuffer(harness, 'statistics');
        const lumaTexture = harness.textures.find(texture => texture.label === 'luma slot 0');
        expect(lumaTexture?.descriptor.usage).toBe(GPU_TEXTURE_USAGE.TEXTURE_BINDING | GPU_TEXTURE_USAGE.STORAGE_BINDING);
        expect(statisticsBuffer.descriptor.usage).toBe(GPU_BUFFER_USAGE.STORAGE);
        expect(presentationBuffer.descriptor.size).toBe(2 * UNIFORM_SLOT_BYTE_LENGTH);
        expect(findBuffer(harness, RENDER_SETTINGS_LABEL).descriptor.size).toBe(RENDER_SETTINGS_UNIFORM_BYTE_LENGTH);

        const computePass = getComputePass(passes, 0);
        expect(computePass.bindGroup?.descriptor.layout).toBe(harness.bindGroupLayouts[0]);
        expect(getBoundLabel(computePass, 0)).toBe('luma slot 0');
        expect(getBoundResource(computePass, 1)).toEqual({ buffer: statisticsBuffer });
        expect(getBoundResource(computePass, 2)).toEqual({ buffer: presentationBuffer, offset: 0, size: PRESENTATION_UNIFORM_BYTE_LENGTH });

        const renderPass = getRenderPass(passes, 1);
        expect(renderPass.bindGroup?.descriptor.layout).toBe(harness.bindGroupLayouts[1]);
        expect(getBoundResource(renderPass, 0)).toBe(harness.sampler);
        expect(getBoundResource(renderPass, 1)).toBe(harness.externalTextures[0]);
        expect(getBoundResource(renderPass, 2)).toEqual({
            buffer: presentationBuffer,
            offset: UNIFORM_SLOT_BYTE_LENGTH,
            size: PRESENTATION_UNIFORM_BYTE_LENGTH
        });
        expect(getBoundResource(renderPass, 3)).toEqual({ buffer: findBuffer(harness, PARAMETERS_LABEL), offset: 0, size: 16 });
        expect(getBoundResource(renderPass, 4)).toEqual({ buffer: findBuffer(harness, RENDER_SETTINGS_LABEL) });
        expect(getBoundResource(renderPass, 5)).toEqual({ buffer: statisticsBuffer });
        expect(getBoundLabel(renderPass, 6)).toBe('luma slot 0');
        expect(getBoundLabel(renderPass, 7)).toBe('color slot 0');
    });

    it('clears each render target and draws the output pass inside the output rectangle', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({
            passes: [
                createRenderPass('Prescale', {
                    bindings: [ { binding: 0, kind: 'engine', resource: 'external-texture' } ],
                    coordinateMapping: 'identity',
                    target: { kind: 'texture', textureId: 'scaled' }
                }),
                createRenderPass('Output', {
                    bindings: [ { access: 'sampled', binding: 0, historyOffset: 0, kind: 'texture', textureId: 'scaled' } ],
                    inputTextureId: 'scaled'
                })
            ],
            textures: [ createTexture('scaled', {}) ]
        });

        const executor = await PresentationExecutor.create(harness.device, plan);
        const passes = encodeFrame(executor, createExternalFrameInput());

        const prescalePass = getRenderPass(passes, 0);
        const outputPass = getRenderPass(passes, 1);
        expect(harness.textures[0].descriptor.usage).toBe(GPU_TEXTURE_USAGE.TEXTURE_BINDING | GPU_TEXTURE_USAGE.RENDER_ATTACHMENT);
        expect(harness.renderPipelines[0].descriptor.fragment?.targets).toEqual([ { format: 'rgba16float' } ]);
        expect(Array.from(prescalePass.descriptor.colorAttachments)).toEqual([ {
            clearValue: { a: 1, b: 0, g: 0, r: 0 },
            loadOp: 'clear',
            storeOp: 'store',
            view: harness.textures[0].createView()
        } ]);
        expect(prescalePass.viewport).toBeNull();
        expect(Array.from(outputPass.descriptor.colorAttachments)[0]?.view).toBe(OUTPUT_VIEW);
        expect(outputPass.viewport).toEqual([
            GEOMETRY.viewportX,
            GEOMETRY.viewportY,
            GEOMETRY.viewportWidth,
            GEOMETRY.viewportHeight,
            0,
            1
        ]);
        expect(prescalePass.drawVertexCounts).toEqual([ RENDER_VERTEX_COUNT ]);
        expect(outputPass.drawVertexCounts).toEqual([ RENDER_VERTEX_COUNT ]);
    });

    it('maps compile errors through each pass line map and creates nothing else', async () => {
        const harness = createDeviceHarness();
        const userPass = createRenderPass('Sharpen pass', {
            lineMap: [ {
                firstGeneratedLine: LINE_MAP_FIRST_GENERATED_LINE,
                firstSourceLine: LINE_MAP_FIRST_SOURCE_LINE,
                lineCount: LINE_MAP_LINE_COUNT,
                passName: 'Sharpen'
            } ]
        });
        const enginePass = createRenderPass('Output', {});
        harness.compilationMessages.set(userPass.code, [
            createCompilationMessage('error', USER_ERROR_GENERATED_LINE, USER_ERROR_COLUMN, USER_ERROR_MESSAGE),
            createCompilationMessage('warning', USER_ERROR_GENERATED_LINE, USER_ERROR_COLUMN, WARNING_MESSAGE),
            createCompilationMessage('error', ENGINE_ERROR_GENERATED_LINE, ENGINE_ERROR_COLUMN, ENGINE_ERROR_MESSAGE)
        ]);
        harness.compilationMessages.set(enginePass.code, [
            createCompilationMessage('error', 0, 0, OTHER_PASS_ERROR_MESSAGE)
        ]);

        const creation = PresentationExecutor.create(harness.device, createPlan({ passes: [ userPass, enginePass ] }));

        await expect(creation).rejects.toBeInstanceOf(PresentationCompileError);
        await expect(creation).rejects.toMatchObject({
            messages: [
                {
                    column: USER_ERROR_COLUMN,
                    line: LINE_MAP_FIRST_SOURCE_LINE + USER_ERROR_GENERATED_LINE - LINE_MAP_FIRST_GENERATED_LINE,
                    message: USER_ERROR_MESSAGE,
                    passName: 'Sharpen'
                },
                { column: ENGINE_ERROR_COLUMN, line: ENGINE_ERROR_GENERATED_LINE, message: ENGINE_ERROR_MESSAGE, passName: null },
                { column: 0, line: 0, message: OTHER_PASS_ERROR_MESSAGE, passName: null }
            ]
        });
        expect(harness.renderPipelines).toHaveLength(0);
        expect(harness.buffers).toHaveLength(0);
        expect(harness.textures).toHaveLength(0);
    });

    it('writes object-fit and identity uniform slots for every pass in one buffer write', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({
            passes: [
                createRenderPass('Prescale', {
                    bindings: [ { binding: 0, kind: 'engine', resource: 'external-texture' } ],
                    coordinateMapping: 'identity',
                    target: { kind: 'texture', textureId: 'scaled' }
                }),
                createRenderPass('Output', {
                    bindings: [ { access: 'sampled', binding: 0, historyOffset: 0, kind: 'texture', textureId: 'scaled' } ],
                    inputTextureId: 'scaled'
                })
            ],
            textures: [ createTexture('scaled', {}) ]
        });

        const executor = await PresentationExecutor.create(harness.device, plan);
        encodeFrame(executor, createExternalFrameInput());

        const presentationWrites = getBufferWrites(harness, PRESENTATION_UNIFORMS_LABEL);
        expect(presentationWrites).toHaveLength(1);
        expect(presentationWrites[0].bufferOffset).toBe(0);
        expect(presentationWrites[0].bytes.byteLength).toBe(UNIFORM_SLOT_BYTE_LENGTH + PRESENTATION_UNIFORM_BYTE_LENGTH);
        const prescaleSlot = readPresentationSlot(presentationWrites[0].bytes, 0);
        const outputSlot = readPresentationSlot(presentationWrites[0].bytes, 1);
        expectCoordinateMapping(prescaleSlot, 1, 1, 0, 0);
        expectCoordinateMapping(outputSlot, GEOMETRY.textureScaleX, GEOMETRY.textureScaleY, GEOMETRY.textureOffsetX, GEOMETRY.textureOffsetY);
        expect(prescaleSlot).toMatchObject({
            frameIndex: 0,
            historyValid: 0,
            inputHeight: SOURCE_HEIGHT,
            inputWidth: SOURCE_WIDTH,
            outputHeight: GEOMETRY.viewportHeight,
            outputWidth: GEOMETRY.viewportWidth,
            skippedFrames: SKIPPED_FRAME_COUNT,
            sourceHeight: SOURCE_HEIGHT,
            sourceWidth: SOURCE_WIDTH,
            timestampSeconds: TIMESTAMP_SECONDS
        });
        expect(outputSlot).toMatchObject({ inputHeight: SCALED_HEIGHT, inputWidth: SCALED_WIDTH, sourceWidth: SOURCE_WIDTH });

        const video = document.createElement('video');
        Object.defineProperty(video, 'videoWidth', { configurable: true, value: SCALED_WIDTH });
        Object.defineProperty(video, 'videoHeight', { configurable: true, value: SCALED_HEIGHT });
        encodeFrame(executor, createFrameInput({ kind: 'external', source: video }));

        expect(readLastPresentationSlot(harness, 0)).toMatchObject({ frameIndex: 1, sourceHeight: SCALED_HEIGHT, sourceWidth: SCALED_WIDTH });
    });

    it('maps passes that read raw planes onto the visible rectangle', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({
            passes: [
                createRenderPass('Convert', {
                    bindings: PLANE_BINDINGS,
                    coordinateMapping: 'identity',
                    target: { kind: 'texture', textureId: 'converted' }
                }),
                createRenderPass('Fused output', { bindings: PLANE_BINDINGS }),
                createRenderPass('Output', {
                    bindings: [ { access: 'sampled', binding: 0, historyOffset: 0, kind: 'texture', textureId: 'converted' } ],
                    inputTextureId: 'converted'
                })
            ],
            sourceKind: 'planes',
            textures: [ createTexture('converted', {}) ]
        });
        const frame = await copyRawFrame('I420', RAW_VISIBLE_RECTANGLE);

        const executor = await PresentationExecutor.create(harness.device, plan);
        encodeFrame(executor, createPlanesInput(frame));

        const convertSlot = readLastPresentationSlot(harness, 0);
        expectCoordinateMapping(convertSlot, RAW_VISIBLE_SCALE_X, RAW_VISIBLE_SCALE_Y, RAW_VISIBLE_OFFSET_X, RAW_VISIBLE_OFFSET_Y);
        expect(convertSlot).toMatchObject({
            inputHeight: RAW_VISIBLE_RECTANGLE.height,
            inputWidth: RAW_VISIBLE_RECTANGLE.width,
            sourceHeight: RAW_VISIBLE_RECTANGLE.height,
            sourceWidth: RAW_VISIBLE_RECTANGLE.width
        });
        expectCoordinateMapping(
            readLastPresentationSlot(harness, 1),
            GEOMETRY.textureScaleX * RAW_VISIBLE_SCALE_X,
            GEOMETRY.textureScaleY * RAW_VISIBLE_SCALE_Y,
            RAW_VISIBLE_OFFSET_X + (GEOMETRY.textureOffsetX * RAW_VISIBLE_SCALE_X),
            RAW_VISIBLE_OFFSET_Y + (GEOMETRY.textureOffsetY * RAW_VISIBLE_SCALE_Y)
        );
        expectCoordinateMapping(
            readLastPresentationSlot(harness, 2),
            GEOMETRY.textureScaleX,
            GEOMETRY.textureScaleY,
            GEOMETRY.textureOffsetX,
            GEOMETRY.textureOffsetY
        );
    });

    it('binds frame pool slots, applies their visible rectangle, and reuses bind groups per layout buffer', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({
            passes: [
                createRenderPass('Output', {
                    bindings: [
                        { binding: 0, kind: 'engine', resource: 'frame-pool' },
                        { binding: 1, kind: 'engine', resource: 'frame-pool-layout' },
                        { binding: 2, kind: 'presentation' }
                    ]
                })
            ],
            sourceKind: 'frame-pool'
        });
        const pool = { label: 'pool' } as unknown as GPUBuffer;
        const replacementPool = { label: 'replacement pool' } as unknown as GPUBuffer;
        const firstLayout = { label: 'first layout' } as unknown as GPUBuffer;
        const secondLayout = { label: 'second layout' } as unknown as GPUBuffer;
        const createFramePoolInput = (framePool: GPUBuffer, layout: GPUBuffer): PresentationFrameInput => {
            const frame: FramePoolFrame = {
                codedHeight: RAW_CODED_HEIGHT,
                codedWidth: RAW_CODED_WIDTH,
                layout,
                pool: framePool,
                visibleRectangle: RAW_VISIBLE_RECTANGLE
            };
            return createFrameInput({ frame, kind: 'frame-pool' });
        };

        const executor = await PresentationExecutor.create(harness.device, plan);
        const passes = encodeFrame(executor, createFramePoolInput(pool, firstLayout));

        expect(getBoundResource(passes[0], 0)).toEqual({ buffer: pool });
        expect(getBoundResource(passes[0], 1)).toEqual({ buffer: firstLayout, size: 64 });
        expectCoordinateMapping(
            readLastPresentationSlot(harness, 0),
            GEOMETRY.textureScaleX * RAW_VISIBLE_SCALE_X,
            GEOMETRY.textureScaleY * RAW_VISIBLE_SCALE_Y,
            RAW_VISIBLE_OFFSET_X + (GEOMETRY.textureOffsetX * RAW_VISIBLE_SCALE_X),
            RAW_VISIBLE_OFFSET_Y + (GEOMETRY.textureOffsetY * RAW_VISIBLE_SCALE_Y)
        );

        encodeFrame(executor, createFramePoolInput(pool, secondLayout));
        const alternatingPasses = encodeFrame(executor, createFramePoolInput(pool, firstLayout));
        expect(harness.bindGroups).toHaveLength(2);
        expect(alternatingPasses[0].bindGroup).toBe(passes[0].bindGroup);

        const replacementPasses = encodeFrame(executor, createFramePoolInput(replacementPool, firstLayout));
        expect(harness.bindGroups).toHaveLength(3);
        expect(getBoundResource(replacementPasses[0], 0)).toEqual({ buffer: replacementPool });
    });

    it('writes parameter defaults at creation and validates, rounds, and clamps parameter changes', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({
            parameterSets: [
                { parameters: [ STRENGTH_PARAMETER, RADIUS_PARAMETER, TAPS_PARAMETER ], passName: GRADE_PASS_NAME },
                { parameters: [ GAIN_PARAMETER ], passName: GAIN_PASS_NAME }
            ],
            passes: [
                createRenderPass('Output', {
                    bindings: [
                        { binding: 0, kind: 'engine', resource: 'external-texture' },
                        { binding: 1, kind: 'parameters', passName: GRADE_PASS_NAME },
                        { binding: 2, kind: 'parameters', passName: GAIN_PASS_NAME }
                    ]
                })
            ]
        });

        const executor = await PresentationExecutor.create(harness.device, plan);

        const parametersBuffer = findBuffer(harness, PARAMETERS_LABEL);
        expect(parametersBuffer.descriptor.size).toBe(2 * UNIFORM_SLOT_BYTE_LENGTH);
        expect(parametersBuffer.descriptor.usage).toBe(GPU_BUFFER_USAGE.COPY_DST | GPU_BUFFER_USAGE.UNIFORM);
        const defaultWrites = getBufferWrites(harness, PARAMETERS_LABEL);
        expect(defaultWrites).toHaveLength(1);
        const defaults = new DataView(defaultWrites[0].bytes);
        expect(defaults.getFloat32(0, true)).toBe(STRENGTH_PARAMETER.defaultValue);
        expect(defaults.getInt32(PARAMETER_BYTE_LENGTH, true)).toBe(RADIUS_PARAMETER.defaultValue);
        expect(defaults.getUint32(2 * PARAMETER_BYTE_LENGTH, true)).toBe(TAPS_PARAMETER.defaultValue);
        expect(defaults.getFloat32(UNIFORM_SLOT_BYTE_LENGTH, true)).toBe(GAIN_PARAMETER.defaultValue);

        executor.setParameter(GRADE_PASS_NAME, STRENGTH_PARAMETER.name, UPDATED_STRENGTH);
        executor.setParameter(GRADE_PASS_NAME, RADIUS_PARAMETER.name, RADIUS_ABOVE_MAXIMUM);
        executor.setParameter(GRADE_PASS_NAME, TAPS_PARAMETER.name, TAPS_BETWEEN_INTEGERS);
        executor.setParameter(GAIN_PASS_NAME, GAIN_PARAMETER.name, UPDATED_GAIN);

        const changeWrites = getBufferWrites(harness, PARAMETERS_LABEL).slice(1);
        expect(changeWrites.map(write => [ write.bufferOffset, write.bytes.byteLength ])).toEqual([
            [ 0, PARAMETER_BYTE_LENGTH ],
            [ PARAMETER_BYTE_LENGTH, PARAMETER_BYTE_LENGTH ],
            [ 2 * PARAMETER_BYTE_LENGTH, PARAMETER_BYTE_LENGTH ],
            [ UNIFORM_SLOT_BYTE_LENGTH, PARAMETER_BYTE_LENGTH ]
        ]);
        expect(new DataView(changeWrites[0].bytes).getFloat32(0, true)).toBe(UPDATED_STRENGTH);
        expect(new DataView(changeWrites[1].bytes).getInt32(0, true)).toBe(RADIUS_PARAMETER.maximum);
        expect(new DataView(changeWrites[2].bytes).getUint32(0, true)).toBe(ROUNDED_TAPS);
        expect(new DataView(changeWrites[3].bytes).getFloat32(0, true)).toBe(UPDATED_GAIN);

        expect(() => executor.setParameter(UNKNOWN_NAME, STRENGTH_PARAMETER.name, UPDATED_STRENGTH)).toThrow(RangeError);
        expect(() => executor.setParameter(GRADE_PASS_NAME, UNKNOWN_NAME, UPDATED_STRENGTH)).toThrow(RangeError);
        expect(() => executor.setParameter(GRADE_PASS_NAME, STRENGTH_PARAMETER.name, Number.NaN)).toThrow(RangeError);

        const passes = encodeFrame(executor, createExternalFrameInput());
        expect(getBoundResource(passes[0], 2)).toEqual({ buffer: parametersBuffer, offset: UNIFORM_SLOT_BYTE_LENGTH, size: 16 });
    });

    it('rotates history rings, saturates historyValid, redraws without advancing, and restarts after a reset', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({
            passes: [
                createRenderPass('Producer', {
                    bindings: [ { binding: 0, kind: 'engine', resource: 'external-texture' } ],
                    coordinateMapping: 'identity',
                    target: { kind: 'texture', textureId: 'history' }
                }),
                createRenderPass('Temporal', {
                    bindings: [
                        { access: 'sampled', binding: 0, historyOffset: 0, kind: 'texture', textureId: 'history' },
                        { access: 'sampled', binding: 1, historyOffset: -1, kind: 'texture', textureId: 'history' }
                    ],
                    inputTextureId: 'history'
                })
            ],
            textures: [ createTexture('history', { historyDepth: HISTORY_DEPTH }) ]
        });
        const executor = await PresentationExecutor.create(harness.device, plan);
        const recordFrame = (newFrame: boolean): [ string | undefined, string | undefined, string | undefined, number ] => {
            const passes = encodeFrame(executor, createExternalFrameInput(newFrame));
            return [
                getTargetLabel(getRenderPass(passes, 0)),
                getBoundLabel(passes[1], 0),
                getBoundLabel(passes[1], 1),
                readLastPresentationSlot(harness, 1).historyValid
            ];
        };

        expect(harness.textures.map(texture => texture.label)).toEqual([ 'history slot 0', 'history slot 1' ]);
        expect(recordFrame(true)).toEqual([ 'history slot 0', 'history slot 0', 'history slot 1', 0 ]);
        expect(recordFrame(true)).toEqual([ 'history slot 1', 'history slot 1', 'history slot 0', 1 ]);
        expect(recordFrame(false)).toEqual([ 'history slot 1', 'history slot 1', 'history slot 0', 1 ]);
        expect(recordFrame(true)).toEqual([ 'history slot 0', 'history slot 0', 'history slot 1', HISTORY_DEPTH ]);
        expect(readLastPresentationSlot(harness, 1).frameIndex).toBe(2);

        executor.resetHistory();

        expect(recordFrame(true)).toEqual([ 'history slot 0', 'history slot 0', 'history slot 1', 0 ]);
        expect(readLastPresentationSlot(harness, 1).frameIndex).toBe(3);
    });

    it('imports the external texture per frame and creates nothing else in steady state', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({
            passes: [
                createRenderPass('Output', {
                    bindings: [
                        { binding: 0, kind: 'engine', resource: 'sampler-linear' },
                        { binding: 1, kind: 'engine', resource: 'external-texture' },
                        { binding: 2, kind: 'presentation' }
                    ]
                })
            ]
        });

        const executor = await PresentationExecutor.create(harness.device, plan);
        const createdBuffers = harness.buffers.length;
        const createdTextures = harness.textures.length;
        for (let frameIndex = 0; frameIndex < STEADY_STATE_FRAME_COUNT; frameIndex += 1) {
            encodeFrame(executor, createExternalFrameInput());
        }

        expect(harness.importExternalTexture).toHaveBeenCalledTimes(STEADY_STATE_FRAME_COUNT);
        expect(harness.importExternalTexture).toHaveBeenLastCalledWith({ colorSpace: 'srgb', source: expect.anything() });
        expect(harness.bindGroups).toHaveLength(STEADY_STATE_FRAME_COUNT);
        expect(harness.buffers).toHaveLength(createdBuffers);
        expect(harness.textures).toHaveLength(createdTextures);
        expect(getBufferWrites(harness, PRESENTATION_UNIFORMS_LABEL)).toHaveLength(STEADY_STATE_FRAME_COUNT);
    });

    it('uploads planes, reuses their textures and bind groups, and recreates both on a format change', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({ passes: [ createRenderPass('Output', { bindings: PLANE_BINDINGS }) ], sourceKind: 'planes' });
        const tenBitFrame = await copyRawFrame('I420P10');
        const nextTenBitFrame = await copyRawFrame('I420P10');
        const eightBitFrame = await copyRawFrame('I420');

        const executor = await PresentationExecutor.create(harness.device, plan);
        const firstPasses = encodeFrame(executor, createPlanesInput(tenBitFrame));

        expect(harness.textures.map(texture => texture.descriptor.format)).toEqual([ 'r16uint', 'r16uint', 'r16uint' ]);
        expect(harness.textures.map(texture => texture.descriptor.usage)).toEqual(
            Array<number>(PLANAR_PLANE_COUNT).fill(GPU_TEXTURE_USAGE.COPY_DST | GPU_TEXTURE_USAGE.TEXTURE_BINDING)
        );
        expect(harness.textureWrites.map(write => write.dataLayout.offset)).toEqual(tenBitFrame.planes.map(plane => plane.byteOffset));
        expect(harness.textureWrites.every(write => write.data === tenBitFrame.data)).toBe(true);
        expect([ 0, 1, 2 ].map(binding => getBoundLabel(firstPasses[0], binding))).toEqual([
            `${BASE_PLANE_LABEL_PREFIX} Y plane`,
            `${BASE_PLANE_LABEL_PREFIX} U plane`,
            `${BASE_PLANE_LABEL_PREFIX} V plane`
        ]);
        expect(harness.bindGroups).toHaveLength(1);

        encodeFrame(executor, createPlanesInput(nextTenBitFrame));
        expect(harness.textures).toHaveLength(PLANAR_PLANE_COUNT);
        expect(harness.bindGroups).toHaveLength(1);
        expect(harness.textureWrites).toHaveLength(2 * PLANAR_PLANE_COUNT);

        // A redraw of the frame the textures hold skips the upload
        encodeFrame(executor, createPlanesInput(nextTenBitFrame, null, false));
        expect(harness.textureWrites).toHaveLength(2 * PLANAR_PLANE_COUNT);

        const formatChangePasses = encodeFrame(executor, createPlanesInput(eightBitFrame));
        expect(harness.textures.slice(PLANAR_PLANE_COUNT).map(texture => texture.descriptor.format)).toEqual([ 'r8uint', 'r8uint', 'r8uint' ]);
        expect(harness.textures.slice(0, PLANAR_PLANE_COUNT).every(texture => texture.destroy.mock.calls.length === 1)).toBe(true);
        expect(harness.bindGroups).toHaveLength(2);
        expect(formatChangePasses[0].bindGroup).toBe(harness.bindGroups[1]);
    });

    it('refuses a raw frame whose layout is invalid', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({ passes: [ createRenderPass('Output', { bindings: PLANE_BINDINGS }) ], sourceKind: 'planes' });
        const frame = await copyRawFrame('I420');
        const truncatedFrame: TransferableRawVideoFrame = { ...frame, data: new ArrayBuffer(UNIFORM_SLOT_BYTE_LENGTH) };

        const executor = await PresentationExecutor.create(harness.device, plan);

        expect(() => encodeFrame(executor, createPlanesInput(truncatedFrame))).toThrow(/^raw-layout: buffer-length: planes end at \d+, buffer holds 256$/);
        expect(() => encodeFrame(executor, createExternalFrameInput())).toThrow('The plan presents a planes source');
    });

    it('binds the Dolby Vision EL planes, or the BL planes without an EL, with the enhancement-present uniform', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({
            passes: [
                createRenderPass('Output', {
                    bindings: [
                        ...PLANE_BINDINGS,
                        { binding: 4, kind: 'engine', resource: 'enhancement-luma' },
                        { binding: 5, kind: 'engine', resource: 'enhancement-chroma-u' },
                        { binding: 6, kind: 'engine', resource: 'enhancement-chroma-v' },
                        { binding: 7, kind: 'engine', resource: 'enhancement-uniform' },
                        { binding: 8, kind: 'engine', resource: 'dolby-vision-rpu' }
                    ]
                })
            ],
            sourceKind: 'planes'
        });
        const pairWithEnhancement = await copyDolbyVisionFramePair(true);
        const pairWithoutEnhancement = await copyDolbyVisionFramePair(false);
        const readEnhancementLabels = (pass: RecordedPass): (string | undefined)[] => [ 4, 5, 6 ].map(binding => getBoundLabel(pass, binding));
        const readEnhancementPresent = (): number => {
            const write = getBufferWrites(harness, ENHANCEMENT_UNIFORM_LABEL).at(-1);
            return write ? new DataView(write.bytes).getUint32(0, true) : -1;
        };

        const executor = await PresentationExecutor.create(harness.device, plan);
        const enhancementPasses = encodeFrame(
            executor,
            createPlanesInput(pairWithEnhancement.baseFrame, pairWithEnhancement.enhancementFrame)
        );

        expect(harness.textures.map(texture => texture.descriptor.format)).toEqual(Array<string>(2 * PLANAR_PLANE_COUNT).fill('r16uint'));
        expect(harness.textureWrites.map(write => write.dataLayout.offset)).toEqual([
            ...pairWithEnhancement.baseFrame.planes.map(plane => plane.byteOffset),
            ...(pairWithEnhancement.enhancementFrame?.planes.map(plane => plane.byteOffset) ?? [])
        ]);
        expect(readEnhancementLabels(enhancementPasses[0])).toEqual([
            `${ENHANCEMENT_PLANE_LABEL_PREFIX} Y plane`,
            `${ENHANCEMENT_PLANE_LABEL_PREFIX} U plane`,
            `${ENHANCEMENT_PLANE_LABEL_PREFIX} V plane`
        ]);
        expect(getBoundResource(enhancementPasses[0], 7)).toEqual({ buffer: findBuffer(harness, ENHANCEMENT_UNIFORM_LABEL) });
        expect(getBoundResource(enhancementPasses[0], 8)).toEqual({ buffer: findBuffer(harness, DOLBY_VISION_RPU_LABEL) });
        expect(readEnhancementPresent()).toBe(1);

        const basePasses = encodeFrame(executor, createPlanesInput(pairWithoutEnhancement.baseFrame, null));

        expect(readEnhancementLabels(basePasses[0])).toEqual([
            `${BASE_PLANE_LABEL_PREFIX} Y plane`,
            `${BASE_PLANE_LABEL_PREFIX} U plane`,
            `${BASE_PLANE_LABEL_PREFIX} V plane`
        ]);
        expect(readEnhancementPresent()).toBe(0);
        expect(harness.textures).toHaveLength(2 * PLANAR_PLANE_COUNT);

        // Without a change in EL presence, the enhancement uniform is not written again
        encodeFrame(executor, createPlanesInput(pairWithoutEnhancement.baseFrame, null));
        expect(getBufferWrites(harness, ENHANCEMENT_UNIFORM_LABEL)).toHaveLength(2);
    });

    it('refuses an EL that is not I420P10 in the BL buffer', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({
            passes: [
                createRenderPass('Output', {
                    bindings: [ ...PLANE_BINDINGS, { binding: 4, kind: 'engine', resource: 'enhancement-luma' } ]
                })
            ],
            sourceKind: 'planes'
        });
        const pair = await copyDolbyVisionFramePair(true);
        const separateEnhancementFrame = await copyRawFrame('I420P10');

        const executor = await PresentationExecutor.create(harness.device, plan);

        expect(() => encodeFrame(executor, createPlanesInput(pair.baseFrame, separateEnhancementFrame))).toThrow(
            'enhancement-buffer: not the base layer\'s buffer'
        );
    });

    it('dispatches compute passes directly and indirectly', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({
            buffers: [
                { byteLength: INDIRECT_ARGUMENTS_BYTE_LENGTH, id: 'dispatch', indirect: true, persistent: false },
                { byteLength: STATE_BYTE_LENGTH, id: 'state', indirect: false, persistent: true }
            ],
            passes: [
                createComputePass('Count', {
                    bindings: [
                        { access: 'storage', binding: 0, bufferId: 'dispatch', kind: 'buffer' },
                        { access: 'storage', binding: 1, bufferId: 'state', kind: 'buffer' }
                    ]
                }),
                createComputePass('Reduce', {
                    bindings: [ { access: 'read-only-storage', binding: 0, bufferId: 'state', kind: 'buffer' } ],
                    indirectBufferId: 'dispatch',
                    workgroupCounts: null
                }),
                createRenderPass('Output', {
                    bindings: [
                        { binding: 0, kind: 'engine', resource: 'external-texture' },
                        { access: 'uniform', binding: 1, bufferId: 'state', kind: 'buffer' },
                        { binding: 2, kind: 'presentation' }
                    ]
                })
            ]
        });

        const executor = await PresentationExecutor.create(harness.device, plan);
        const passes = encodeFrame(executor, createExternalFrameInput());
        encodeFrame(executor, createExternalFrameInput());

        const dispatchBuffer = findBuffer(harness, 'dispatch');
        expect(dispatchBuffer.descriptor.usage).toBe(GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.INDIRECT);
        expect(findBuffer(harness, 'state').descriptor.usage).toBe(GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.UNIFORM);
        expect(getComputePass(passes, 0).directDispatches).toEqual([ WORKGROUP_COUNTS ]);
        expect(getComputePass(passes, 0).indirectDispatches).toEqual([]);
        expect(getComputePass(passes, 1).indirectDispatches).toEqual([ { buffer: dispatchBuffer, offset: 0 } ]);
        expect(getComputePass(passes, 1).directDispatches).toEqual([]);
        expect(getComputePass(passes, 1).pipeline).toBe(harness.computePipelines[1]);
        // A persistent buffer counts as one frame of history
        expect(readLastPresentationSlot(harness, 2).historyValid).toBe(1);
    });

    it('writes render settings and the RPU only when the plan binds them', async () => {
        const boundHarness = createDeviceHarness();
        const unboundHarness = createDeviceHarness();
        const boundPlan = createPlan({
            passes: [
                createRenderPass('Output', {
                    bindings: [
                        { binding: 0, kind: 'engine', resource: 'external-texture' },
                        { binding: 1, kind: 'engine', resource: 'render-settings' },
                        { binding: 2, kind: 'engine', resource: 'dolby-vision-rpu' }
                    ]
                })
            ],
            usesRenderSettings: true
        });
        const unboundPlan = createPlan({
            passes: [ createRenderPass('Output', { bindings: [ { binding: 0, kind: 'engine', resource: 'external-texture' } ] }) ]
        });
        const renderSettings = new ArrayBuffer(RENDER_SETTINGS_UNIFORM_BYTE_LENGTH);
        const rpu = new ArrayBuffer(DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH);

        const boundExecutor = await PresentationExecutor.create(boundHarness.device, boundPlan);
        const unboundExecutor = await PresentationExecutor.create(unboundHarness.device, unboundPlan);
        boundExecutor.writeRenderSettings(renderSettings);
        boundExecutor.writeDolbyVisionRPU(rpu);
        unboundExecutor.writeRenderSettings(renderSettings);
        unboundExecutor.writeDolbyVisionRPU(rpu);

        expect(getBufferWrites(boundHarness, RENDER_SETTINGS_LABEL).map(write => write.bytes.byteLength)).toEqual([ RENDER_SETTINGS_UNIFORM_BYTE_LENGTH ]);
        expect(getBufferWrites(boundHarness, DOLBY_VISION_RPU_LABEL).map(write => write.bytes.byteLength)).toEqual([ DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH ]);
        expect(findBuffer(boundHarness, DOLBY_VISION_RPU_LABEL).descriptor.usage).toBe(GPU_BUFFER_USAGE.COPY_DST | GPU_BUFFER_USAGE.STORAGE);
        expect(unboundHarness.bufferWrites).toHaveLength(0);
        expect(() => boundExecutor.writeRenderSettings(rpu)).toThrow(RangeError);
        expect(() => boundExecutor.writeDolbyVisionRPU(renderSettings)).toThrow(RangeError);
    });

    it('destroys its textures and buffers and refuses to encode afterwards', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({
            buffers: [ { byteLength: STATE_BYTE_LENGTH, id: 'state', indirect: false, persistent: true } ],
            passes: [
                createRenderPass('Convert', {
                    bindings: PLANE_BINDINGS,
                    target: { kind: 'texture', textureId: 'converted' }
                }),
                createRenderPass('Output', {
                    bindings: [
                        { access: 'sampled', binding: 0, historyOffset: 0, kind: 'texture', textureId: 'converted' },
                        { access: 'read-only-storage', binding: 1, bufferId: 'state', kind: 'buffer' }
                    ],
                    inputTextureId: 'converted'
                })
            ],
            sourceKind: 'planes',
            textures: [ createTexture('converted', { historyDepth: HISTORY_DEPTH }) ]
        });
        const frame = await copyRawFrame('I420');

        const executor = await PresentationExecutor.create(harness.device, plan);
        encodeFrame(executor, createPlanesInput(frame));
        executor.destroy();

        expect(harness.textures.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true);
        expect(harness.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
        expect(() => encodeFrame(executor, createPlanesInput(frame))).toThrow('The presentation executor is destroyed');
    });

    it('rejects plans with history reads deeper than their ring', async () => {
        const harness = createDeviceHarness();
        const plan = createPlan({
            passes: [
                createRenderPass('Output', {
                    bindings: [
                        { binding: 0, kind: 'engine', resource: 'external-texture' },
                        { access: 'sampled', binding: 1, historyOffset: -2, kind: 'texture', textureId: 'history' }
                    ]
                })
            ],
            textures: [ createTexture('history', { historyDepth: HISTORY_DEPTH }) ]
        });

        await expect(PresentationExecutor.create(harness.device, plan)).rejects.toThrow(RangeError);
        expect(harness.textures).toHaveLength(0);
    });
});

describe('configurePresentationCanvas', () => {
    it('configures an opaque canvas with the planned format, color space, and tone mapping', () => {
        const configure = vi.fn();
        const context = { configure } as unknown as GPUCanvasContext;
        const device = { label: 'device' } as unknown as GPUDevice;

        configurePresentationCanvas(context, device, HDR_OUTPUT);

        expect(configure).toHaveBeenCalledWith({
            alphaMode: 'opaque',
            colorSpace: HDR_OUTPUT.colorSpace,
            device,
            format: HDR_OUTPUT.format,
            toneMapping: { mode: HDR_OUTPUT.toneMapping }
        });
    });
});
