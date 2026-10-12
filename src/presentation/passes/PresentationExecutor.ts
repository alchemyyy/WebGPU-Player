// Encodes frames from a presentation plan: it owns the plan's GPU resources, takes each frame's source, and records the passes in plan order.
// overhual/planning.md and overhual/temporal.md in the engine root describe the design it implements.
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from '../../video/dolby-vision/DolbyVisionRPUParser';
import {
    RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT,
    type RawVideoPlaneKind,
    type TransferableRawVideoFrame
} from '../../video/RawVideoFrameCopy';
import type { TexturePresentationGeometry } from '../PresentationGeometry';
import { RENDER_SETTINGS_UNIFORM_BYTE_LENGTH } from '../RenderSettings';
import {
    CANVAS_ALPHA_MODE,
    CANVAS_COLOR_SPACE,
    EXTERNAL_TEXTURE_COLOR_SPACE,
    FLOAT32_FILTERABLE_FEATURE,
    FLOAT32_TEXTURE_FORMATS,
    HDR_CANVAS_FORMAT,
    HDR_TONE_MAPPING_MODE,
    SDR_TONE_MAPPING_MODE
} from '../WebGPUConstants';
import {
    ENHANCEMENT_UNIFORM_BYTE_LENGTH,
    FRAME_POOL_LAYOUT_BYTE_LENGTH,
    getEngineBindingLayout,
    getParameterByteOffset,
    getParametersByteLength,
    PRESENTATION_UNIFORM_BYTE_LENGTH,
    type PresentationUniformValues,
    UNIFORM_SLOT_BYTE_LENGTH,
    writePresentationUniform
} from './PassResources';
import type {
    EngineBindingResource,
    FramePoolFrame,
    PassCoordinateMapping,
    PassLineMapping,
    PassParameter,
    PassTarget,
    PlannedBinding,
    PlannedBuffer,
    PlannedOutput,
    PlannedPass,
    PlannedTexture,
    PresentationCompileMessage,
    PresentationFrameInput,
    PresentationFrameSource,
    PresentationPlan,
    PresentationSourceKind
} from './PassTypes';
import {
    createPlaneTextureSet,
    destroyPlaneTextureSet,
    getRawPlaneLayoutFailure,
    isPlaneTextureSetCompatible,
    type PlaneTextureSet,
    uploadPlanes
} from './PlaneTextureSource';

const VERTEX_ENTRY_POINT = 'vertexMain';
const FRAGMENT_ENTRY_POINT = 'fragmentMain';
const COMPUTE_ENTRY_POINT = 'computeMain';
// Every binding of a pass is in group 0
const BIND_GROUP_INDEX = 0;
// Two triangles that cover the target, as the generated vertex stage emits them
const RENDER_VERTEX_COUNT = 6;
const CLEAR_COLOR: GPUColorDict = { a: 1, b: 0, g: 0, r: 0 };
const VIEWPORT_MINIMUM_DEPTH = 0;
const VIEWPORT_MAXIMUM_DEPTH = 1;
const INDIRECT_DISPATCH_BYTE_OFFSET = 0;
const MICROSECONDS_PER_SECOND = 1_000_000;
// Every parameter is one 32-bit scalar
const PARAMETER_BYTE_LENGTH = 4;
const ENHANCEMENT_ABSENT = 0;
const ENHANCEMENT_PRESENT = 1;
// Names engine-generated code in a compile error summary, where a user pass would be named
const ENGINE_CODE_NAME = 'engine';

const PRESENTATION_UNIFORMS_LABEL = 'Presentation uniforms';
const PARAMETERS_LABEL = 'Presentation parameters';
const RENDER_SETTINGS_LABEL = 'Presentation render settings';
const DOLBY_VISION_RPU_LABEL = 'Presentation Dolby Vision RPU';
const ENHANCEMENT_UNIFORM_LABEL = 'Presentation Dolby Vision enhancement uniforms';
const SAMPLER_LABEL = 'Presentation linear sampler';
const BASE_PLANES_LABEL = 'Raw video';
const ENHANCEMENT_PLANES_LABEL = 'Raw Dolby Vision enhancement';

// The engine bindings whose resources come from the frame's source rather than from the plan
const SOURCE_RESOURCE_KINDS: Readonly<Partial<Record<EngineBindingResource, PresentationSourceKind>>> = {
    'enhancement-chroma-u': 'planes',
    'enhancement-chroma-v': 'planes',
    'enhancement-luma': 'planes',
    'external-texture': 'external',
    'frame-pool': 'frame-pool',
    'frame-pool-layout': 'frame-pool',
    'plane-chroma': 'planes',
    'plane-chroma-u': 'planes',
    'plane-chroma-v': 'planes',
    'plane-luma': 'planes'
};

const BASE_PLANE_RESOURCES: Readonly<Record<RawVideoPlaneKind, EngineBindingResource>> = {
    u: 'plane-chroma-u',
    uv: 'plane-chroma',
    v: 'plane-chroma-v',
    y: 'plane-luma'
};

const ENHANCEMENT_PLANE_RESOURCES: Readonly<Partial<Record<RawVideoPlaneKind, EngineBindingResource>>> = {
    u: 'enhancement-chroma-u',
    v: 'enhancement-chroma-v',
    y: 'enhancement-luma'
};

const ENHANCEMENT_PLANE_BINDINGS: readonly EngineBindingResource[] = [ 'enhancement-luma', 'enhancement-chroma-u', 'enhancement-chroma-v' ];

type TextureBinding = Extract<PlannedBinding, { kind: 'texture' }>;

/** A planned texture's ring of historyDepth + 1 owned textures; a texture without history is a ring of one. */
type HistoryRing = {
    planned: PlannedTexture
    views: readonly GPUTextureView[]
};

type RenderTarget = { kind: 'output' } | { kind: 'ring'; ring: HistoryRing };

type ComputeDispatch =
    | { indirectBuffer: GPUBuffer; kind: 'indirect' }
    | { kind: 'direct'; workgroupCounts: readonly [number, number, number] };

type ComputeRecording = { dispatch: ComputeDispatch; kind: 'compute'; pipeline: GPUComputePipeline };

type RenderRecording = { kind: 'render'; pipeline: GPURenderPipeline; target: RenderTarget };

type PassPipeline =
    | { kind: 'compute'; pipeline: GPUComputePipeline }
    | { kind: 'render'; pipeline: GPURenderPipeline };

type ExecutorPass = {
    bindGroupLayout: GPUBindGroupLayout
    /** Bind groups per ring phase; a pass that binds the source gets them from the source, and an external source creates them per frame. */
    bindGroups: readonly GPUBindGroup[]
    bindings: readonly PlannedBinding[]
    bindsSource: boolean
    coordinateMapping: PassCoordinateMapping
    index: number
    /** The texture the pass reads, or null when it reads the source. */
    inputTexture: PlannedTexture | null
    label: string
    /** The ring phases its bindings and target cycle through: the least common multiple of their ring lengths. */
    phaseCount: number
    recording: ComputeRecording | RenderRecording
};

type ParameterSlot = {
    byteOffset: number
    parameters: readonly PassParameter[]
};

/** Engine binding resources that a frame's source provides. */
type SourceResources = Partial<Record<EngineBindingResource, GPUBindingResource>>;

/** A coded frame and its visible rectangle, which raw planes and frame pool slots both describe. */
type VisibleRegion = {
    codedHeight: number
    codedWidth: number
    visibleRectangle: { height: number; width: number; x: number; y: number }
};

/** Shader compile errors of a plan, each message mapped back to the user pass line it came from. */
export class PresentationCompileError extends Error {
    readonly messages: readonly PresentationCompileMessage[];

    constructor(messages: readonly PresentationCompileMessage[]) {
        super(`Presentation shaders failed to compile\n${messages.map(formatCompileMessage).join('\n')}`);
        this.name = 'PresentationCompileError';
        this.messages = messages;
    }
}

function formatCompileMessage(message: PresentationCompileMessage): string {
    return `${message.passName ?? ENGINE_CODE_NAME}:${message.line}:${message.column}: ${message.message}`;
}

/** Maps a message's generated line through a pass's line map; lines outside every user range belong to engine code. */
function mapCompileMessage(message: GPUCompilationMessage, lineMap: readonly PassLineMapping[]): PresentationCompileMessage {
    const mapping = lineMap.find((candidate: PassLineMapping): boolean => (
        message.lineNum >= candidate.firstGeneratedLine
        && message.lineNum < candidate.firstGeneratedLine + candidate.lineCount
    ));
    if (!mapping) {
        return { column: message.linePos, line: message.lineNum, message: message.message, passName: null };
    }
    return {
        column: message.linePos,
        line: mapping.firstSourceLine + message.lineNum - mapping.firstGeneratedLine,
        message: message.message,
        passName: mapping.passName
    };
}

async function collectCompileErrors(
    passes: readonly PlannedPass[],
    shaderModules: readonly GPUShaderModule[]
): Promise<PresentationCompileMessage[]> {
    const compilationInfos = await Promise.all(shaderModules.map(
        (shaderModule: GPUShaderModule): Promise<GPUCompilationInfo> => shaderModule.getCompilationInfo()
    ));
    const messages: PresentationCompileMessage[] = [];
    for (let passIndex = 0; passIndex < passes.length; passIndex += 1) {
        for (const message of compilationInfos[passIndex].messages) {
            if (message.type === 'error') {
                messages.push(mapCompileMessage(message, passes[passIndex].lineMap));
            }
        }
    }
    return messages;
}

function requirePlannedTexture(textures: ReadonlyMap<string, PlannedTexture>, textureId: string): PlannedTexture {
    const texture = textures.get(textureId);
    if (!texture) {
        throw new Error(`The plan has no texture '${textureId}'`);
    }
    return texture;
}

function requireRenderTarget(pass: PlannedPass): PassTarget {
    if (!pass.target) {
        throw new Error(`Render pass '${pass.label}' has no target`);
    }
    return pass.target;
}

function getSampleType(format: GPUTextureFormat, float32Filterable: boolean): GPUTextureSampleType {
    return FLOAT32_TEXTURE_FORMATS.has(format) && !float32Filterable ? 'unfilterable-float' : 'float';
}

function createTextureLayoutEntry(
    binding: TextureBinding,
    visibility: GPUShaderStageFlags,
    texture: PlannedTexture,
    float32Filterable: boolean
): GPUBindGroupLayoutEntry {
    // A reader further back than the ring's depth would read the slot its producer is writing
    if (Math.abs(binding.historyOffset) > texture.historyDepth) {
        throw new RangeError(`Texture '${texture.id}' keeps ${texture.historyDepth} frames of history, not ${Math.abs(binding.historyOffset)}`);
    }
    switch (binding.access) {
        case 'sampled':
            return {
                binding: binding.binding,
                texture: { sampleType: getSampleType(texture.format, float32Filterable), viewDimension: '2d' },
                visibility
            };
        case 'storage':
            if (!texture.storage) {
                throw new Error(`Texture '${texture.id}' is bound for storage but not planned with storage usage`);
            }
            return {
                binding: binding.binding,
                storageTexture: { access: 'write-only', format: texture.format, viewDimension: '2d' },
                visibility
            };
    }
}

function createBindGroupLayoutEntry(
    binding: PlannedBinding,
    visibility: GPUShaderStageFlags,
    textures: ReadonlyMap<string, PlannedTexture>,
    float32Filterable: boolean
): GPUBindGroupLayoutEntry {
    switch (binding.kind) {
        case 'buffer':
            return { binding: binding.binding, buffer: { type: binding.access }, visibility };
        case 'engine':
            return { ...getEngineBindingLayout(binding.resource), binding: binding.binding, visibility };
        case 'parameters':
        case 'presentation':
            return { binding: binding.binding, buffer: { type: 'uniform' }, visibility };
        case 'texture':
            return createTextureLayoutEntry(binding, visibility, requirePlannedTexture(textures, binding.textureId), float32Filterable);
    }
}

function createBindGroupLayout(
    device: GPUDevice,
    pass: PlannedPass,
    textures: ReadonlyMap<string, PlannedTexture>
): GPUBindGroupLayout {
    const visibility = pass.kind === 'compute' ? GPUShaderStage.COMPUTE : GPUShaderStage.FRAGMENT;
    const float32Filterable = device.features.has(FLOAT32_FILTERABLE_FEATURE);
    const entries: GPUBindGroupLayoutEntry[] = [];
    for (const binding of pass.bindings) {
        entries.push(createBindGroupLayoutEntry(binding, visibility, textures, float32Filterable));
    }
    return device.createBindGroupLayout({ entries, label: pass.label });
}

function getRenderTargetFormat(
    pass: PlannedPass,
    output: PlannedOutput,
    textures: ReadonlyMap<string, PlannedTexture>
): GPUTextureFormat {
    const target = requireRenderTarget(pass);
    switch (target.kind) {
        case 'output':
            return output.format;
        case 'texture':
            return requirePlannedTexture(textures, target.textureId).format;
    }
}

async function createPassPipeline(
    device: GPUDevice,
    output: PlannedOutput,
    pass: PlannedPass,
    shaderModule: GPUShaderModule,
    bindGroupLayout: GPUBindGroupLayout,
    textures: ReadonlyMap<string, PlannedTexture>
): Promise<PassPipeline> {
    const layout = device.createPipelineLayout({ bindGroupLayouts: [ bindGroupLayout ], label: pass.label });
    switch (pass.kind) {
        case 'compute':
            return {
                kind: 'compute',
                pipeline: await device.createComputePipelineAsync({
                    compute: { entryPoint: COMPUTE_ENTRY_POINT, module: shaderModule },
                    label: pass.label,
                    layout
                })
            };
        case 'render':
            return {
                kind: 'render',
                pipeline: await device.createRenderPipelineAsync({
                    fragment: {
                        entryPoint: FRAGMENT_ENTRY_POINT,
                        module: shaderModule,
                        targets: [ { format: getRenderTargetFormat(pass, output, textures) } ]
                    },
                    label: pass.label,
                    layout,
                    primitive: { topology: 'triangle-list' },
                    vertex: { entryPoint: VERTEX_ENTRY_POINT, module: shaderModule }
                })
            };
    }
}

function collectEngineResources(passes: readonly PlannedPass[]): Set<EngineBindingResource> {
    const resources = new Set<EngineBindingResource>();
    for (const pass of passes) {
        for (const binding of pass.bindings) {
            if (binding.kind === 'engine') {
                resources.add(binding.resource);
            }
        }
    }
    return resources;
}

/** Returns the deepest history the plan keeps, where a persistent buffer counts as one frame, which bounds `historyValid`. */
function getHistorySaturation(plan: PresentationPlan): number {
    let saturation = plan.buffers.some((buffer: PlannedBuffer): boolean => buffer.persistent) ? 1 : 0;
    for (const texture of plan.textures) {
        saturation = Math.max(saturation, texture.historyDepth);
    }
    return saturation;
}

/** Returns whether a pass binds resources from the frame's source, which must be the plan's source kind. */
function bindsSourceResource(pass: PlannedPass, sourceKind: PresentationSourceKind): boolean {
    let bindsSource = false;
    for (const binding of pass.bindings) {
        const resourceSourceKind = binding.kind === 'engine' ? SOURCE_RESOURCE_KINDS[binding.resource] : undefined;
        if (resourceSourceKind === undefined) {
            continue;
        }
        if (resourceSourceKind !== sourceKind) {
            throw new Error(`Pass '${pass.label}' binds a ${resourceSourceKind} resource, which a ${sourceKind} source does not provide`);
        }
        bindsSource = true;
    }
    return bindsSource;
}

function getGreatestCommonDivisor(first: number, second: number): number {
    let dividend = first;
    let divisor = second;
    while (divisor !== 0) {
        const remainder = dividend % divisor;
        dividend = divisor;
        divisor = remainder;
    }
    return dividend;
}

function getLeastCommonMultiple(first: number, second: number): number {
    return (first / getGreatestCommonDivisor(first, second)) * second;
}

/** Returns the ring slot a binding reads in a phase: the producer writes slot phase, and a history read goes back from it. */
function getRingSlot(phase: number, ringLength: number, historyOffset: number): number {
    const slot = (phase - Math.abs(historyOffset)) % ringLength;
    return slot < 0 ? slot + ringLength : slot;
}

/** Returns the frame number a recording uses: a new frame takes the next number, and a redraw repeats the last one. */
function getRecordedFrameNumber(newFrameCount: number, newFrame: boolean): number {
    return newFrame ? newFrameCount : Math.max(newFrameCount - 1, 0);
}

function alignToUniformSlot(byteLength: number): number {
    return Math.ceil(byteLength / UNIFORM_SLOT_BYTE_LENGTH) * UNIFORM_SLOT_BYTE_LENGTH;
}

function requireByteLength(data: ArrayBuffer, byteLength: number, name: string): void {
    if (data.byteLength !== byteLength) {
        throw new RangeError(`${name} must be ${byteLength} bytes, not ${data.byteLength}`);
    }
}

/** Returns a parameter value in its type and range: integers round, and values outside the range clamp to it. */
function normalizeParameterValue(parameter: PassParameter, value: number): number {
    if (!Number.isFinite(value)) {
        throw new RangeError(`Parameter '${parameter.name}' must be a finite number`);
    }
    const typedValue = parameter.type === 'f32' ? value : Math.round(value);
    return Math.min(Math.max(typedValue, parameter.minimum), parameter.maximum);
}

function writeParameterValue(target: DataView, byteOffset: number, parameter: PassParameter, value: number): void {
    const normalizedValue = normalizeParameterValue(parameter, value);
    switch (parameter.type) {
        case 'f32':
            target.setFloat32(byteOffset, normalizedValue, true);
            break;
        case 'i32':
            target.setInt32(byteOffset, normalizedValue, true);
            break;
        case 'u32':
            target.setUint32(byteOffset, normalizedValue, true);
            break;
    }
}

function setSourceSize(values: PresentationUniformValues, source: PresentationFrameSource): void {
    switch (source.kind) {
        case 'external': {
            const externalSource = source.source;
            if ('videoWidth' in externalSource) {
                values.sourceHeight = externalSource.videoHeight;
                values.sourceWidth = externalSource.videoWidth;
                return;
            }
            const visibleRectangle = externalSource.visibleRect;
            values.sourceHeight = visibleRectangle ? visibleRectangle.height : externalSource.displayHeight;
            values.sourceWidth = visibleRectangle ? visibleRectangle.width : externalSource.displayWidth;
            return;
        }
        case 'frame-pool':
        case 'planes':
            values.sourceHeight = source.frame.visibleRectangle.height;
            values.sourceWidth = source.frame.visibleRectangle.width;
            return;
    }
}

function getVisibleRegion(source: PresentationFrameSource): VisibleRegion | null {
    switch (source.kind) {
        case 'external':
            return null;
        case 'frame-pool':
        case 'planes':
            return source.frame;
    }
}

function setCoordinateMapping(
    values: PresentationUniformValues,
    pass: ExecutorPass,
    geometry: TexturePresentationGeometry,
    visibleRegion: VisibleRegion | null
): void {
    switch (pass.coordinateMapping) {
        case 'identity':
            values.textureOffsetX = 0;
            values.textureOffsetY = 0;
            values.textureScaleX = 1;
            values.textureScaleY = 1;
            break;
        case 'object-fit':
            values.textureOffsetX = geometry.textureOffsetX;
            values.textureOffsetY = geometry.textureOffsetY;
            values.textureScaleX = geometry.textureScaleX;
            values.textureScaleY = geometry.textureScaleY;
            break;
    }
    // Raw coordinates span the coded frame, so a pass that reads the source maps onto its visible rectangle
    if (!visibleRegion || pass.inputTexture) {
        return;
    }
    const rectangle = visibleRegion.visibleRectangle;
    const visibleScaleX = rectangle.width / visibleRegion.codedWidth;
    const visibleScaleY = rectangle.height / visibleRegion.codedHeight;
    values.textureOffsetX = (rectangle.x / visibleRegion.codedWidth) + values.textureOffsetX * visibleScaleX;
    values.textureOffsetY = (rectangle.y / visibleRegion.codedHeight) + values.textureOffsetY * visibleScaleY;
    values.textureScaleX *= visibleScaleX;
    values.textureScaleY *= visibleScaleY;
}

function getTargetView(target: RenderTarget, phase: number, outputView: GPUTextureView): GPUTextureView {
    switch (target.kind) {
        case 'output':
            return outputView;
        case 'ring':
            return target.ring.views[phase % target.ring.views.length];
    }
}

function recordRenderPass(
    commandEncoder: GPUCommandEncoder,
    pass: ExecutorPass,
    recording: RenderRecording,
    bindGroup: GPUBindGroup,
    phase: number,
    frame: PresentationFrameInput
): void {
    const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [ {
            clearValue: CLEAR_COLOR,
            loadOp: 'clear',
            storeOp: 'store',
            view: getTargetView(recording.target, phase, frame.target)
        } ],
        label: pass.label
    });
    renderPass.setPipeline(recording.pipeline);
    renderPass.setBindGroup(BIND_GROUP_INDEX, bindGroup);
    // The output pass draws inside the output rectangle and leaves the cleared letterbox black
    if (recording.target.kind === 'output') {
        const geometry = frame.geometry;
        renderPass.setViewport(
            geometry.viewportX,
            geometry.viewportY,
            geometry.viewportWidth,
            geometry.viewportHeight,
            VIEWPORT_MINIMUM_DEPTH,
            VIEWPORT_MAXIMUM_DEPTH
        );
    }
    renderPass.draw(RENDER_VERTEX_COUNT);
    renderPass.end();
}

function recordComputePass(
    commandEncoder: GPUCommandEncoder,
    pass: ExecutorPass,
    recording: ComputeRecording,
    bindGroup: GPUBindGroup
): void {
    const computePass = commandEncoder.beginComputePass({ label: pass.label });
    computePass.setPipeline(recording.pipeline);
    computePass.setBindGroup(BIND_GROUP_INDEX, bindGroup);
    const dispatch = recording.dispatch;
    switch (dispatch.kind) {
        case 'direct':
            computePass.dispatchWorkgroups(dispatch.workgroupCounts[0], dispatch.workgroupCounts[1], dispatch.workgroupCounts[2]);
            break;
        case 'indirect':
            computePass.dispatchWorkgroupsIndirect(dispatch.indirectBuffer, INDIRECT_DISPATCH_BYTE_OFFSET);
            break;
    }
    computePass.end();
}

function createPlaneSourceResources(planeTextures: PlaneTextureSet, enhancementTextures: PlaneTextureSet | null): SourceResources {
    const resources: SourceResources = {};
    for (const plane of planeTextures.planes) {
        resources[BASE_PLANE_RESOURCES[plane.kind]] = plane.view;
    }
    for (const plane of enhancementTextures?.planes ?? []) {
        const resource = ENHANCEMENT_PLANE_RESOURCES[plane.kind];
        if (resource) {
            resources[resource] = plane.view;
        }
    }
    return resources;
}

/**
 * Encodes frames from one presentation plan on one device.
 * It creates every pipeline, texture, buffer, and bind group with the plan, so a frame costs one uniform write, the source's import or upload, and one encode per pass.
 * Only a bind group that references an external texture is created per frame, as WebGPU requires.
 */
export class PresentationExecutor {
    private readonly bindsEnhancementPlanes: boolean;
    private readonly device: GPUDevice;
    private readonly dolbyVisionRPUBuffer: GPUBuffer | null;
    private readonly enhancementBuffer: GPUBuffer | null;
    private readonly enhancementView: DataView<ArrayBuffer> = new DataView(new ArrayBuffer(ENHANCEMENT_UNIFORM_BYTE_LENGTH));
    // Frame pool bind groups per layout uniform, so a pool that names each slot with its own layout buffer never creates them per frame
    private readonly framePoolBindGroups = new Map<GPUBuffer, readonly (readonly GPUBindGroup[])[]>();
    private readonly historySaturation: number;
    private readonly ownedBuffers: GPUBuffer[] = [];
    private readonly ownedTextures: GPUTexture[] = [];
    private readonly parameterSlots = new Map<string, ParameterSlot>();
    private readonly parameterView: DataView<ArrayBuffer>;
    private readonly parametersBuffer: GPUBuffer | null;
    private readonly passes: readonly ExecutorPass[];
    private readonly plannedBuffers = new Map<string, GPUBuffer>();
    private readonly presentationBuffer: GPUBuffer;
    private readonly presentationView: DataView<ArrayBuffer>;
    private readonly presentationWriteByteLength: number;
    private readonly renderSettingsBuffer: GPUBuffer | null;
    private readonly rings = new Map<string, HistoryRing>();
    private readonly sampler: GPUSampler | null;
    private readonly sourceKind: PresentationSourceKind;
    private readonly uniformValues: PresentationUniformValues = {
        frameIndex: 0,
        historyValid: 0,
        inputHeight: 0,
        inputWidth: 0,
        outputHeight: 0,
        outputWidth: 0,
        skippedFrames: 0,
        sourceHeight: 0,
        sourceWidth: 0,
        textureOffsetX: 0,
        textureOffsetY: 0,
        textureScaleX: 1,
        textureScaleY: 1,
        timestampSeconds: 0
    };

    private boundEnhancementTextures: PlaneTextureSet | null = null;
    private boundFramePoolLayout: GPUBuffer | null = null;
    private boundPlaneTextures: PlaneTextureSet | null = null;
    private destroyed = false;
    private enhancementTextures: PlaneTextureSet | null = null;
    private framePoolBuffer: GPUBuffer | null = null;
    // New frames since creation, and since the last history reset
    private frameCount = 0;
    private historyFrameCount = 0;
    private planeTextures: PlaneTextureSet | null = null;
    // The frames in the plane textures, so a redraw of the same frame skips its upload
    private uploadedEnhancementFrame: TransferableRawVideoFrame | null = null;
    private uploadedFrame: TransferableRawVideoFrame | null = null;
    private writtenEnhancementPresent: number | null = null;

    private constructor(
        device: GPUDevice,
        plan: PresentationPlan,
        bindGroupLayouts: readonly GPUBindGroupLayout[],
        pipelines: readonly PassPipeline[]
    ) {
        this.device = device;
        this.sourceKind = plan.sourceKind;
        this.historySaturation = getHistorySaturation(plan);
        this.presentationView = new DataView(new ArrayBuffer(plan.passes.length * UNIFORM_SLOT_BYTE_LENGTH));
        // The write stops where the last slot's uniform ends
        this.presentationWriteByteLength = this.presentationView.byteLength - UNIFORM_SLOT_BYTE_LENGTH + PRESENTATION_UNIFORM_BYTE_LENGTH;
        let parameterByteLength = 0;
        for (const parameterSet of plan.parameterSets) {
            this.parameterSlots.set(parameterSet.passName, { byteOffset: parameterByteLength, parameters: parameterSet.parameters });
            parameterByteLength += alignToUniformSlot(getParametersByteLength(parameterSet.parameters.length));
        }
        this.parameterView = new DataView(new ArrayBuffer(parameterByteLength));
        const engineResources = collectEngineResources(plan.passes);
        this.bindsEnhancementPlanes = ENHANCEMENT_PLANE_BINDINGS.some((resource: EngineBindingResource): boolean => engineResources.has(resource));
        try {
            const uniformUsage = GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM;
            this.presentationBuffer = this.createOwnedBuffer(PRESENTATION_UNIFORMS_LABEL, this.presentationView.byteLength, uniformUsage);
            this.parametersBuffer = this.createOptionalBuffer(parameterByteLength > 0, PARAMETERS_LABEL, parameterByteLength, uniformUsage);
            this.renderSettingsBuffer = this.createOptionalBuffer(
                plan.usesRenderSettings,
                RENDER_SETTINGS_LABEL,
                RENDER_SETTINGS_UNIFORM_BYTE_LENGTH,
                uniformUsage
            );
            this.enhancementBuffer = this.createOptionalBuffer(
                engineResources.has('enhancement-uniform'),
                ENHANCEMENT_UNIFORM_LABEL,
                ENHANCEMENT_UNIFORM_BYTE_LENGTH,
                uniformUsage
            );
            this.dolbyVisionRPUBuffer = this.createOptionalBuffer(
                engineResources.has('dolby-vision-rpu'),
                DOLBY_VISION_RPU_LABEL,
                DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
                GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
            );
            this.sampler = engineResources.has('sampler-linear') ?
                device.createSampler({ label: SAMPLER_LABEL, magFilter: 'linear', minFilter: 'linear' }) :
                null;
            this.createRings(plan);
            this.createPlannedBuffers(plan);
            this.writeDefaultParameters();
            this.passes = plan.passes.map((pass: PlannedPass, index: number): ExecutorPass => (
                this.createExecutorPass(pass, index, bindGroupLayouts[index], pipelines[index])
            ));
            for (const pass of this.passes) {
                if (!pass.bindsSource) {
                    pass.bindGroups = this.createPassBindGroups(pass, null);
                }
            }
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    /**
     * Compiles a plan and allocates its resources; it rejects with a PresentationCompileError when a pass's WGSL does not compile.
     * Compile messages carry the user pass and source line, through each pass's line map, whose lines are 1-based like the browser's.
     */
    static async create(device: GPUDevice, plan: PresentationPlan): Promise<PresentationExecutor> {
        if (plan.passes.length === 0) {
            throw new RangeError('A presentation plan needs at least one pass');
        }
        const textures = new Map<string, PlannedTexture>();
        for (const texture of plan.textures) {
            textures.set(texture.id, texture);
        }
        const bindGroupLayouts = plan.passes.map((pass: PlannedPass): GPUBindGroupLayout => createBindGroupLayout(device, pass, textures));
        const shaderModules = plan.passes.map((pass: PlannedPass): GPUShaderModule => (
            device.createShaderModule({ code: pass.code, label: pass.label })
        ));
        const compileErrors = await collectCompileErrors(plan.passes, shaderModules);
        if (compileErrors.length > 0) {
            throw new PresentationCompileError(compileErrors);
        }
        const pipelines = await Promise.all(plan.passes.map((pass: PlannedPass, index: number): Promise<PassPipeline> => (
            createPassPipeline(device, plan.output, pass, shaderModules[index], bindGroupLayouts[index], textures)
        )));
        return new PresentationExecutor(device, plan, bindGroupLayouts, pipelines);
    }

    /** Writes the render settings uniform; it does nothing when the plan does not bind render settings. */
    writeRenderSettings(data: ArrayBuffer): void {
        this.requireUsable();
        requireByteLength(data, RENDER_SETTINGS_UNIFORM_BYTE_LENGTH, 'Render settings data');
        if (this.renderSettingsBuffer) {
            this.device.queue.writeBuffer(this.renderSettingsBuffer, 0, data);
        }
    }

    /** Writes the packed Dolby Vision RPU; it does nothing when no pass binds the RPU. */
    writeDolbyVisionRPU(data: ArrayBuffer): void {
        this.requireUsable();
        requireByteLength(data, DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH, 'Dolby Vision RPU data');
        if (this.dolbyVisionRPUBuffer) {
            this.device.queue.writeBuffer(this.dolbyVisionRPUBuffer, 0, data);
        }
    }

    /**
     * Writes one parameter of a pass, which takes effect from the next submitted frame.
     * Integer parameters round, values outside the declared range clamp to it, and an unknown name or a non-finite value throws a RangeError.
     */
    setParameter(passName: string, parameterName: string, value: number): void {
        this.requireUsable();
        const slot = this.parameterSlots.get(passName);
        if (!slot || !this.parametersBuffer) {
            throw new RangeError(`The plan has no parameters for pass '${passName}'`);
        }
        const parameterIndex = slot.parameters.findIndex((parameter: PassParameter): boolean => parameter.name === parameterName);
        if (parameterIndex < 0) {
            throw new RangeError(`Pass '${passName}' has no parameter '${parameterName}'`);
        }
        const byteOffset = slot.byteOffset + getParameterByteOffset(parameterIndex);
        writeParameterValue(this.parameterView, byteOffset, slot.parameters[parameterIndex], value);
        this.device.queue.writeBuffer(this.parametersBuffer, byteOffset, this.parameterView.buffer, byteOffset, PARAMETER_BYTE_LENGTH);
    }

    /** Restarts history: the next new frame writes the first ring slots and sees `historyValid` 0. */
    resetHistory(): void {
        this.historyFrameCount = 0;
    }

    /**
     * Records one frame into a command encoder that the caller submits.
     * A new frame advances history after recording; a redraw repeats the last new frame's ring slots and history state.
     */
    encode(commandEncoder: GPUCommandEncoder, frame: PresentationFrameInput): void {
        this.requireUsable();
        const source = frame.source;
        if (source.kind !== this.sourceKind) {
            throw new Error(`The plan presents a ${this.sourceKind} source, not a ${source.kind} source`);
        }
        const historyFrameNumber = getRecordedFrameNumber(this.historyFrameCount, frame.newFrame);
        const externalTexture = this.prepareSource(source, frame.newFrame);
        this.writePresentationUniforms(frame, historyFrameNumber);
        for (const pass of this.passes) {
            const phase = historyFrameNumber % pass.phaseCount;
            const bindGroup = externalTexture && pass.bindsSource ?
                this.createPassBindGroup(pass, phase, { 'external-texture': externalTexture }) :
                pass.bindGroups[phase];
            const recording = pass.recording;
            switch (recording.kind) {
                case 'compute':
                    recordComputePass(commandEncoder, pass, recording, bindGroup);
                    break;
                case 'render':
                    recordRenderPass(commandEncoder, pass, recording, bindGroup, phase, frame);
                    break;
            }
        }
        if (frame.newFrame) {
            this.frameCount += 1;
            this.historyFrameCount += 1;
        }
    }

    /** Destroys every texture and buffer the executor owns; frame pool buffers belong to the GPU decode route. */
    destroy(): void {
        this.destroyed = true;
        for (const texture of this.ownedTextures) {
            texture.destroy();
        }
        for (const buffer of this.ownedBuffers) {
            buffer.destroy();
        }
        this.ownedTextures.length = 0;
        this.ownedBuffers.length = 0;
        destroyPlaneTextureSet(this.planeTextures);
        destroyPlaneTextureSet(this.enhancementTextures);
        this.planeTextures = null;
        this.enhancementTextures = null;
        this.boundPlaneTextures = null;
        this.boundEnhancementTextures = null;
        this.uploadedFrame = null;
        this.uploadedEnhancementFrame = null;
        this.framePoolBindGroups.clear();
        this.framePoolBuffer = null;
        this.boundFramePoolLayout = null;
    }

    private requireUsable(): void {
        if (this.destroyed) {
            throw new Error('The presentation executor is destroyed');
        }
    }

    private createOwnedBuffer(label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
        const buffer = this.device.createBuffer({ label, size, usage });
        this.ownedBuffers.push(buffer);
        return buffer;
    }

    private createOptionalBuffer(required: boolean, label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer | null {
        return required ? this.createOwnedBuffer(label, size, usage) : null;
    }

    private createRings(plan: PresentationPlan): void {
        const renderTargetIds = new Set<string>();
        for (const pass of plan.passes) {
            if (pass.kind === 'render' && pass.target?.kind === 'texture') {
                renderTargetIds.add(pass.target.textureId);
            }
        }
        for (const texture of plan.textures) {
            const usage = GPUTextureUsage.TEXTURE_BINDING
                | (renderTargetIds.has(texture.id) ? GPUTextureUsage.RENDER_ATTACHMENT : 0)
                | (texture.storage ? GPUTextureUsage.STORAGE_BINDING : 0);
            const views: GPUTextureView[] = [];
            for (let slot = 0; slot <= texture.historyDepth; slot += 1) {
                const ringTexture = this.device.createTexture({
                    format: texture.format,
                    label: `${texture.id} slot ${slot}`,
                    size: { height: texture.height, width: texture.width },
                    usage
                });
                this.ownedTextures.push(ringTexture);
                views.push(ringTexture.createView());
            }
            this.rings.set(texture.id, { planned: texture, views });
        }
    }

    private createPlannedBuffers(plan: PresentationPlan): void {
        const uniformBufferIds = new Set<string>();
        for (const pass of plan.passes) {
            for (const binding of pass.bindings) {
                if (binding.kind === 'buffer' && binding.access === 'uniform') {
                    uniformBufferIds.add(binding.bufferId);
                }
            }
        }
        for (const buffer of plan.buffers) {
            const usage = GPUBufferUsage.STORAGE
                | (uniformBufferIds.has(buffer.id) ? GPUBufferUsage.UNIFORM : 0)
                | (buffer.indirect ? GPUBufferUsage.INDIRECT : 0);
            this.plannedBuffers.set(buffer.id, this.createOwnedBuffer(buffer.id, buffer.byteLength, usage));
        }
    }

    private writeDefaultParameters(): void {
        if (!this.parametersBuffer) {
            return;
        }
        for (const slot of this.parameterSlots.values()) {
            for (let parameterIndex = 0; parameterIndex < slot.parameters.length; parameterIndex += 1) {
                const parameter = slot.parameters[parameterIndex];
                writeParameterValue(this.parameterView, slot.byteOffset + getParameterByteOffset(parameterIndex), parameter, parameter.defaultValue);
            }
        }
        this.device.queue.writeBuffer(this.parametersBuffer, 0, this.parameterView.buffer);
    }

    private requireRing(textureId: string): HistoryRing {
        const ring = this.rings.get(textureId);
        if (!ring) {
            throw new Error(`The plan has no texture '${textureId}'`);
        }
        return ring;
    }

    private requireBuffer(bufferId: string): GPUBuffer {
        const buffer = this.plannedBuffers.get(bufferId);
        if (!buffer) {
            throw new Error(`The plan has no buffer '${bufferId}'`);
        }
        return buffer;
    }

    private createExecutorPass(
        pass: PlannedPass,
        index: number,
        bindGroupLayout: GPUBindGroupLayout,
        pipeline: PassPipeline
    ): ExecutorPass {
        return {
            bindGroupLayout,
            bindGroups: [],
            bindings: pass.bindings,
            bindsSource: bindsSourceResource(pass, this.sourceKind),
            coordinateMapping: pass.coordinateMapping,
            index,
            inputTexture: pass.inputTextureId === null ? null : this.requireRing(pass.inputTextureId).planned,
            label: pass.label,
            phaseCount: this.getPhaseCount(pass),
            recording: this.createPassRecording(pass, pipeline)
        };
    }

    private createPassRecording(pass: PlannedPass, pipeline: PassPipeline): ComputeRecording | RenderRecording {
        switch (pipeline.kind) {
            case 'compute':
                return { dispatch: this.createComputeDispatch(pass), kind: 'compute', pipeline: pipeline.pipeline };
            case 'render':
                return { kind: 'render', pipeline: pipeline.pipeline, target: this.createRenderTarget(pass) };
        }
    }

    private createComputeDispatch(pass: PlannedPass): ComputeDispatch {
        if (pass.indirectBufferId !== null) {
            return { indirectBuffer: this.requireBuffer(pass.indirectBufferId), kind: 'indirect' };
        }
        if (!pass.workgroupCounts) {
            throw new Error(`Compute pass '${pass.label}' has neither workgroup counts nor an indirect buffer`);
        }
        return { kind: 'direct', workgroupCounts: pass.workgroupCounts };
    }

    private createRenderTarget(pass: PlannedPass): RenderTarget {
        const target = requireRenderTarget(pass);
        switch (target.kind) {
            case 'output':
                return { kind: 'output' };
            case 'texture':
                return { kind: 'ring', ring: this.requireRing(target.textureId) };
        }
    }

    private getPhaseCount(pass: PlannedPass): number {
        let phaseCount = 1;
        for (const binding of pass.bindings) {
            if (binding.kind === 'texture') {
                phaseCount = getLeastCommonMultiple(phaseCount, this.requireRing(binding.textureId).views.length);
            }
        }
        if (pass.target?.kind === 'texture') {
            phaseCount = getLeastCommonMultiple(phaseCount, this.requireRing(pass.target.textureId).views.length);
        }
        return phaseCount;
    }

    private createPassBindGroups(pass: ExecutorPass, source: SourceResources | null): GPUBindGroup[] {
        const bindGroups: GPUBindGroup[] = [];
        for (let phase = 0; phase < pass.phaseCount; phase += 1) {
            bindGroups.push(this.createPassBindGroup(pass, phase, source));
        }
        return bindGroups;
    }

    private createPassBindGroup(pass: ExecutorPass, phase: number, source: SourceResources | null): GPUBindGroup {
        const entries: GPUBindGroupEntry[] = [];
        for (const binding of pass.bindings) {
            entries.push({ binding: binding.binding, resource: this.resolveBinding(pass, binding, phase, source) });
        }
        return this.device.createBindGroup({ entries, label: pass.label, layout: pass.bindGroupLayout });
    }

    private resolveBinding(
        pass: ExecutorPass,
        binding: PlannedBinding,
        phase: number,
        source: SourceResources | null
    ): GPUBindingResource {
        switch (binding.kind) {
            case 'buffer':
                return { buffer: this.requireBuffer(binding.bufferId) };
            case 'engine':
                return this.resolveEngineResource(pass, binding.resource, source);
            case 'parameters':
                return this.resolveParameters(pass, binding.passName);
            case 'presentation':
                return {
                    buffer: this.presentationBuffer,
                    offset: pass.index * UNIFORM_SLOT_BYTE_LENGTH,
                    size: PRESENTATION_UNIFORM_BYTE_LENGTH
                };
            case 'texture': {
                const ring = this.requireRing(binding.textureId);
                return ring.views[getRingSlot(phase, ring.views.length, binding.historyOffset)];
            }
        }
    }

    private resolveParameters(pass: ExecutorPass, passName: string): GPUBufferBinding {
        const slot = this.parameterSlots.get(passName);
        if (!slot || !this.parametersBuffer) {
            throw new Error(`Pass '${pass.label}' binds parameters of '${passName}', which the plan does not declare`);
        }
        return { buffer: this.parametersBuffer, offset: slot.byteOffset, size: getParametersByteLength(slot.parameters.length) };
    }

    private resolveEngineResource(
        pass: ExecutorPass,
        resource: EngineBindingResource,
        source: SourceResources | null
    ): GPUBindingResource {
        const bindingResource = this.getPlanEngineResource(resource) ?? source?.[resource];
        if (!bindingResource) {
            throw new Error(`Pass '${pass.label}' binds ${resource}, which this plan or frame does not provide`);
        }
        return bindingResource;
    }

    /** Returns an engine resource the executor owns, or null for one that comes from the frame's source. */
    private getPlanEngineResource(resource: EngineBindingResource): GPUBindingResource | null {
        switch (resource) {
            case 'dolby-vision-rpu':
                return this.dolbyVisionRPUBuffer && { buffer: this.dolbyVisionRPUBuffer };
            case 'enhancement-uniform':
                return this.enhancementBuffer && { buffer: this.enhancementBuffer };
            case 'render-settings':
                return this.renderSettingsBuffer && { buffer: this.renderSettingsBuffer };
            case 'sampler-linear':
                return this.sampler;
            default:
                return null;
        }
    }

    /** Imports or uploads the frame's source and readies the bind groups that reference it; returns the imported external texture. */
    private prepareSource(source: PresentationFrameSource, newFrame: boolean): GPUExternalTexture | null {
        switch (source.kind) {
            case 'external':
                return this.device.importExternalTexture({ colorSpace: EXTERNAL_TEXTURE_COLOR_SPACE, source: source.source });
            case 'frame-pool':
                this.prepareFramePool(source.frame);
                return null;
            case 'planes':
                this.preparePlanes(source.frame, source.enhancementFrame, newFrame);
                return null;
        }
    }

    private prepareFramePool(frame: FramePoolFrame): void {
        if (frame.pool !== this.framePoolBuffer) {
            this.framePoolBindGroups.clear();
            this.framePoolBuffer = frame.pool;
            this.boundFramePoolLayout = null;
        }
        if (frame.layout === this.boundFramePoolLayout) {
            return;
        }
        let bindGroups = this.framePoolBindGroups.get(frame.layout);
        if (!bindGroups) {
            const sourceResources: SourceResources = {
                'frame-pool': { buffer: frame.pool },
                'frame-pool-layout': { buffer: frame.layout, size: FRAME_POOL_LAYOUT_BYTE_LENGTH }
            };
            bindGroups = this.passes.map((pass: ExecutorPass): GPUBindGroup[] => (
                pass.bindsSource ? this.createPassBindGroups(pass, sourceResources) : []
            ));
            this.framePoolBindGroups.set(frame.layout, bindGroups);
        }
        for (const pass of this.passes) {
            if (pass.bindsSource) {
                pass.bindGroups = bindGroups[pass.index];
            }
        }
        this.boundFramePoolLayout = frame.layout;
    }

    private preparePlanes(
        frame: TransferableRawVideoFrame,
        enhancementFrame: TransferableRawVideoFrame | null,
        newFrame: boolean
    ): void {
        // A redraw of the frame the textures already hold needs no upload
        if (!newFrame && frame === this.uploadedFrame && enhancementFrame === this.uploadedEnhancementFrame) {
            return;
        }
        const layoutFailure = getRawPlaneLayoutFailure(frame);
        if (layoutFailure !== null) {
            throw new RangeError(`raw-layout: ${layoutFailure}`);
        }
        this.uploadedFrame = null;
        let planeTextures = this.planeTextures;
        if (!isPlaneTextureSetCompatible(planeTextures, frame)) {
            planeTextures = createPlaneTextureSet(this.device, frame, BASE_PLANES_LABEL);
            destroyPlaneTextureSet(this.planeTextures);
            this.planeTextures = planeTextures;
        }
        uploadPlanes(this.device, planeTextures, frame);
        const enhancementTextures = this.prepareEnhancementPlanes(frame, enhancementFrame);
        this.writeEnhancementPresent(enhancementTextures !== null);
        // Without an EL, the unsampled EL bindings take the BL planes, whose integer textures fit them in any format
        this.bindPlaneTextures(planeTextures, this.bindsEnhancementPlanes ? enhancementTextures ?? planeTextures : null);
        this.uploadedFrame = frame;
        this.uploadedEnhancementFrame = enhancementFrame;
    }

    /** Rebuilds the bind groups of passes that bind planes, only when the textures they reference change. */
    private bindPlaneTextures(planeTextures: PlaneTextureSet, enhancementTextures: PlaneTextureSet | null): void {
        if (planeTextures === this.boundPlaneTextures && enhancementTextures === this.boundEnhancementTextures) {
            return;
        }
        const sourceResources = createPlaneSourceResources(planeTextures, enhancementTextures);
        for (const pass of this.passes) {
            if (pass.bindsSource) {
                pass.bindGroups = this.createPassBindGroups(pass, sourceResources);
            }
        }
        this.boundPlaneTextures = planeTextures;
        this.boundEnhancementTextures = enhancementTextures;
    }

    /** Uploads the frame's EL when a pass binds one; returns its textures, or null without an uploaded EL. */
    private prepareEnhancementPlanes(
        frame: TransferableRawVideoFrame,
        enhancementFrame: TransferableRawVideoFrame | null
    ): PlaneTextureSet | null {
        if (!enhancementFrame || !this.bindsEnhancementPlanes) {
            return null;
        }
        // The EL bindings read 10-bit 4:2:0 planes whatever the BL format, from the BL's compound buffer
        if (enhancementFrame.format !== RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT) {
            throw new RangeError(`enhancement-format: ${enhancementFrame.format}, expected ${RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT}`);
        }
        if (enhancementFrame.data !== frame.data) {
            throw new RangeError('enhancement-buffer: not the base layer\'s buffer');
        }
        const layoutFailure = getRawPlaneLayoutFailure(enhancementFrame);
        if (layoutFailure !== null) {
            throw new RangeError(`enhancement-layout: ${layoutFailure}`);
        }
        let enhancementTextures = this.enhancementTextures;
        if (!isPlaneTextureSetCompatible(enhancementTextures, enhancementFrame)) {
            enhancementTextures = createPlaneTextureSet(this.device, enhancementFrame, ENHANCEMENT_PLANES_LABEL);
            destroyPlaneTextureSet(this.enhancementTextures);
            this.enhancementTextures = enhancementTextures;
        }
        uploadPlanes(this.device, enhancementTextures, enhancementFrame);
        return enhancementTextures;
    }

    private writeEnhancementPresent(present: boolean): void {
        const value = present ? ENHANCEMENT_PRESENT : ENHANCEMENT_ABSENT;
        if (!this.enhancementBuffer || value === this.writtenEnhancementPresent) {
            return;
        }
        this.enhancementView.setUint32(0, value, true);
        this.device.queue.writeBuffer(this.enhancementBuffer, 0, this.enhancementView.buffer);
        this.writtenEnhancementPresent = value;
    }

    /** Writes every pass's `presentation` uniform in one buffer write. */
    private writePresentationUniforms(frame: PresentationFrameInput, historyFrameNumber: number): void {
        const values = this.uniformValues;
        const geometry = frame.geometry;
        setSourceSize(values, frame.source);
        values.frameIndex = getRecordedFrameNumber(this.frameCount, frame.newFrame);
        values.historyValid = Math.min(historyFrameNumber, this.historySaturation);
        values.outputHeight = geometry.viewportHeight;
        values.outputWidth = geometry.viewportWidth;
        values.skippedFrames = frame.skippedFrameCount;
        values.timestampSeconds = frame.timestampMicroseconds / MICROSECONDS_PER_SECOND;
        const visibleRegion = getVisibleRegion(frame.source);
        for (const pass of this.passes) {
            values.inputHeight = pass.inputTexture ? pass.inputTexture.height : values.sourceHeight;
            values.inputWidth = pass.inputTexture ? pass.inputTexture.width : values.sourceWidth;
            setCoordinateMapping(values, pass, geometry, visibleRegion);
            writePresentationUniform(this.presentationView, pass.index * UNIFORM_SLOT_BYTE_LENGTH, values);
        }
        this.device.queue.writeBuffer(this.presentationBuffer, 0, this.presentationView.buffer, 0, this.presentationWriteByteLength);
    }
}

/** Configures the canvas for a plan's output: its format, color space, and tone mapping mode, opaque. */
export function configurePresentationCanvas(context: GPUCanvasContext, device: GPUDevice, output: PlannedOutput): void {
    context.configure({
        alphaMode: CANVAS_ALPHA_MODE,
        colorSpace: output.colorSpace,
        device,
        format: output.format,
        toneMapping: { mode: output.toneMapping }
    });
}

/** Returns the canvas configuration a plan renders for: the HDR canvas, or an SDR canvas in sdrCanvasFormat. */
export function createPlannedOutput(hdrOutput: boolean, sdrCanvasFormat: GPUTextureFormat): PlannedOutput {
    return hdrOutput ?
        { colorSpace: CANVAS_COLOR_SPACE, format: HDR_CANVAS_FORMAT, toneMapping: HDR_TONE_MAPPING_MODE } :
        { colorSpace: CANVAS_COLOR_SPACE, format: sdrCanvasFormat, toneMapping: SDR_TONE_MAPPING_MODE };
}
