// Encodes frames from a presentation plan: it owns the plan's GPU resources, takes each frame's source, and records the passes in plan order.
// The Presentation section of docs/src/architecture.md describes the design it implements.
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from '../../demux/dolby-vision/DolbyVisionRPUParser';
import {
    RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT,
    type RawVideoPlaneKind,
    type TransferableRawVideoFrame
} from '../../decode/video/RawVideoFrameCopy';
import type { TexturePresentationGeometry } from '../PresentationGeometry';
import { RENDER_SETTINGS_UNIFORM_BYTE_LENGTH } from '../RenderSettings';
import {
    BYTES_PER_WORD,
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
    FRAME_POOL_VISIBLE_RECTANGLE_BYTE_OFFSET,
    getEngineBindingLayout,
    getParameterByteOffset,
    getParametersByteLength,
    normalizePassParameterValue,
    PRESENTATION_UNIFORM_BYTE_LENGTH,
    type PresentationUniformValues,
    UNIFORM_SLOT_BYTE_LENGTH,
    writeFramePoolVisibleRectangle,
    writePresentationUniform
} from './PassResources';
import type {
    EngineBindingResource,
    FramePoolFrame,
    PassCoordinateMapping,
    PassLineMapping,
    PassParameter,
    PassTarget,
    PassTextureEdge,
    PlannedBinding,
    PlannedBuffer,
    PlannedOutput,
    PlannedPass,
    PlannedPassTexture,
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
import {
    getCompiledPresentationPass,
    type CompiledPresentationPass,
    type PresentationPassPipeline
} from './PresentationPipelineCache';

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
const PARAMETER_BYTE_LENGTH = BYTES_PER_WORD;
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
const PASS_SAMPLER_LABEL = 'Presentation texture block sampler';
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

type PassPipeline = PresentationPassPipeline;

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

/** What bind group layouts need of a plan: its textures and texture blocks by id, and whether the device filters 32-bit floats. */
type LayoutResources = {
    float32Filterable: boolean
    passTextures: ReadonlyMap<string, PlannedPassTexture>
    textures: ReadonlyMap<string, PlannedTexture>
};

// The address mode of each texture block edge mode
const PASS_TEXTURE_ADDRESS_MODES: Readonly<Record<PassTextureEdge, GPUAddressMode>> = {
    clamp: 'clamp-to-edge',
    mirror: 'mirror-repeat',
    repeat: 'repeat'
};
const EMPTY_PASS_TEXTURE_VIEWS: ReadonlyMap<string, GPUTextureView> = new Map<string, GPUTextureView>();

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

/** Returns the error messages of a pass's compiled module, each mapped back to the user pass line it came from. */
async function collectCompileErrors(pass: PlannedPass, shaderModule: GPUShaderModule): Promise<PresentationCompileMessage[]> {
    const compilationInfo = await shaderModule.getCompilationInfo();
    const messages: PresentationCompileMessage[] = [];
    for (const message of compilationInfo.messages) {
        if (message.type === 'error') {
            messages.push(mapCompileMessage(message, pass.lineMap));
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

function requirePlannedPassTexture(passTextures: ReadonlyMap<string, PlannedPassTexture>, textureId: string): PlannedPassTexture {
    const texture = passTextures.get(textureId);
    if (!texture) {
        throw new Error(`The plan has no texture block '${textureId}'`);
    }
    return texture;
}

/** Returns the sampler a texture block's filter and edge mode name, which every block of the two shares. */
function getPassSamplerKey(texture: PlannedPassTexture): string {
    return `${texture.filter}:${texture.edge}`;
}

function createBindGroupLayoutEntry(
    binding: PlannedBinding,
    visibility: GPUShaderStageFlags,
    resources: LayoutResources
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
            return createTextureLayoutEntry(binding, visibility, requirePlannedTexture(resources.textures, binding.textureId), resources.float32Filterable);
        case 'pass-texture': {
            const texture = requirePlannedPassTexture(resources.passTextures, binding.textureId);
            return {
                binding: binding.binding,
                texture: { sampleType: getSampleType(texture.format, resources.float32Filterable), viewDimension: texture.dimension },
                visibility
            };
        }
        case 'pass-sampler': {
            // The planner leaves out a linear filter on a format the device cannot filter, and a nearest read needs no filtering
            const texture = requirePlannedPassTexture(resources.passTextures, binding.textureId);
            return { binding: binding.binding, sampler: { type: texture.filter === 'linear' ? 'filtering' : 'non-filtering' }, visibility };
        }
    }
}

function createBindGroupLayoutEntries(pass: PlannedPass, resources: LayoutResources): GPUBindGroupLayoutEntry[] {
    const visibility = pass.kind === 'compute' ? GPUShaderStage.COMPUTE : GPUShaderStage.FRAGMENT;
    const entries: GPUBindGroupLayoutEntry[] = [];
    for (const binding of pass.bindings) {
        entries.push(createBindGroupLayoutEntry(binding, visibility, resources));
    }
    return entries;
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

/** What one pass's pipeline depends on: its WGSL and stage, its bind group layout, and a render pass's target format. */
type PassCompileRequest = Readonly<{
    layoutEntries: readonly GPUBindGroupLayoutEntry[]
    pass: PlannedPass
    targetFormat: GPUTextureFormat | null
}>;

function getPassCompileKey(request: PassCompileRequest): string {
    const { layoutEntries, pass, targetFormat } = request;
    return JSON.stringify([ pass.kind, pass.label, targetFormat, layoutEntries, pass.code ]);
}

async function createPassPipeline(
    device: GPUDevice,
    request: PassCompileRequest,
    shaderModule: GPUShaderModule,
    bindGroupLayout: GPUBindGroupLayout
): Promise<PassPipeline> {
    const { pass, targetFormat } = request;
    const layout = device.createPipelineLayout({ bindGroupLayouts: [ bindGroupLayout ], label: pass.label });
    if (pass.kind === 'compute' || targetFormat === null) {
        return {
            kind: 'compute',
            pipeline: await device.createComputePipelineAsync({
                compute: { entryPoint: COMPUTE_ENTRY_POINT, module: shaderModule },
                label: pass.label,
                layout
            })
        };
    }
    return {
        kind: 'render',
        pipeline: await device.createRenderPipelineAsync({
            fragment: {
                entryPoint: FRAGMENT_ENTRY_POINT,
                module: shaderModule,
                targets: [ { format: targetFormat } ]
            },
            label: pass.label,
            layout,
            primitive: { topology: 'triangle-list' },
            vertex: { entryPoint: VERTEX_ENTRY_POINT, module: shaderModule }
        })
    };
}

/** Compiles one pass; it rejects with a PresentationCompileError when the pass's WGSL does not compile. */
async function compilePass(device: GPUDevice, request: PassCompileRequest): Promise<CompiledPresentationPass> {
    const { layoutEntries, pass } = request;
    const bindGroupLayout = device.createBindGroupLayout({ entries: [ ...layoutEntries ], label: pass.label });
    const shaderModule = device.createShaderModule({ code: pass.code, label: pass.label });
    const compileErrors = await collectCompileErrors(pass, shaderModule);
    if (compileErrors.length > 0) {
        throw new PresentationCompileError(compileErrors);
    }
    return { bindGroupLayout, pipeline: await createPassPipeline(device, request, shaderModule, bindGroupLayout) };
}

/**
 * Returns every pass of a plan compiled on a device, from the device's pipeline cache where it kept them.
 * Compile errors of every failing pass reject together, in pass order, as one PresentationCompileError.
 */
async function compilePlanPasses(
    device: GPUDevice,
    plan: PresentationPlan,
    resources: LayoutResources
): Promise<CompiledPresentationPass[]> {
    const requests = plan.passes.map((pass: PlannedPass): PassCompileRequest => ({
        layoutEntries: createBindGroupLayoutEntries(pass, resources),
        pass,
        targetFormat: pass.kind === 'render' ? getRenderTargetFormat(pass, plan.output, resources.textures) : null
    }));
    const results = await Promise.allSettled(requests.map((request: PassCompileRequest): Promise<CompiledPresentationPass> => (
        getCompiledPresentationPass(device, getPassCompileKey(request), (): Promise<CompiledPresentationPass> => compilePass(device, request))
    )));
    const compileMessages: PresentationCompileMessage[] = [];
    const compiledPasses: CompiledPresentationPass[] = [];
    for (const result of results) {
        if (result.status === 'fulfilled') {
            compiledPasses.push(result.value);
        } else if (result.reason instanceof PresentationCompileError) {
            compileMessages.push(...result.reason.messages);
        }
    }
    if (compileMessages.length > 0) {
        throw new PresentationCompileError(compileMessages);
    }
    const failure = results.find((result: PromiseSettledResult<CompiledPresentationPass>): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) {
        throw failure.reason;
    }
    return compiledPasses;
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

function writeParameterValue(target: DataView, byteOffset: number, parameter: PassParameter, value: number): void {
    const normalizedValue = normalizePassParameterValue(parameter, value);
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
    // The visible rectangle last written into each layout uniform, so a frame whose rectangle its slot's uniform already holds writes nothing
    private readonly framePoolVisibleRectangles = new Map<GPUBuffer, string>();
    // The first pass a draw from history records; the passes before it keep their outputs from the last new frame
    private readonly historyDrawStart: number;
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
    private readonly passSamplers = new Map<string, GPUSampler>();
    private readonly passTextures = new Map<string, PlannedPassTexture>();
    private readonly passTextureViews: ReadonlyMap<string, GPUTextureView>;
    private readonly sampler: GPUSampler | null;
    private readonly sourceKind: PresentationSourceKind;
    private readonly uniformValues: PresentationUniformValues = {
        fieldState: 0,
        frameIndex: 0,
        historyValid: 0,
        inputHeight: 0,
        inputWidth: 0,
        outputHeight: 0,
        outputWidth: 0,
        refreshSeconds: 0,
        skippedFrames: 0,
        sourceHeight: 0,
        sourceWidth: 0,
        targetOffsetSeconds: 0,
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
        pipelines: readonly PassPipeline[],
        passTextureViews: ReadonlyMap<string, GPUTextureView>
    ) {
        this.device = device;
        this.passTextureViews = passTextureViews;
        this.sourceKind = plan.sourceKind;
        for (const texture of plan.passTextures) {
            this.passTextures.set(texture.id, texture);
        }
        this.historyDrawStart = plan.historyDrawStart;
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
            for (const texture of plan.passTextures) {
                const addressMode = PASS_TEXTURE_ADDRESS_MODES[texture.edge];
                const key = getPassSamplerKey(texture);
                if (!this.passSamplers.has(key)) {
                    this.passSamplers.set(key, device.createSampler({
                        addressModeU: addressMode,
                        addressModeV: addressMode,
                        addressModeW: addressMode,
                        label: `${PASS_SAMPLER_LABEL} ${key}`,
                        magFilter: texture.filter,
                        minFilter: texture.filter
                    }));
                }
            }
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
     * The plan's texture blocks bind the caller's uploads, by identity, which outlive the executor.
     */
    static async create(
        device: GPUDevice,
        plan: PresentationPlan,
        passTextureViews: ReadonlyMap<string, GPUTextureView> = EMPTY_PASS_TEXTURE_VIEWS
    ): Promise<PresentationExecutor> {
        if (plan.passes.length === 0) {
            throw new RangeError('A presentation plan needs at least one pass');
        }
        const missingTexture = plan.passTextures.find((texture: PlannedPassTexture): boolean => !passTextureViews.has(texture.id));
        if (missingTexture !== undefined) {
            throw new RangeError(`texture-upload: no upload of texture block ${missingTexture.id}`);
        }
        const textures = new Map<string, PlannedTexture>();
        for (const texture of plan.textures) {
            textures.set(texture.id, texture);
        }
        const passTextures = new Map<string, PlannedPassTexture>();
        for (const texture of plan.passTextures) {
            passTextures.set(texture.id, texture);
        }
        const layoutResources: LayoutResources = { float32Filterable: device.features.has(FLOAT32_FILTERABLE_FEATURE), passTextures, textures };
        const compiledPasses = await compilePlanPasses(device, plan, layoutResources);
        return new PresentationExecutor(
            device,
            plan,
            compiledPasses.map((compiledPass: CompiledPresentationPass): GPUBindGroupLayout => compiledPass.bindGroupLayout),
            compiledPasses.map((compiledPass: CompiledPresentationPass): PassPipeline => compiledPass.pipeline),
            passTextureViews
        );
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

    /** Writes every parameter's declared default, which a new executor starts from; it does nothing when the plan has no parameters. */
    writeDefaultParameters(): void {
        this.requireUsable();
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

    /** Restarts history: the next new frame writes the first ring slots and sees `historyValid` 0. */
    resetHistory(): void {
        this.historyFrameCount = 0;
    }

    /** Returns whether a frame can draw from history alone: every pass that reads the source writes history that later passes read, none the output. */
    canDrawFromHistory(): boolean {
        return this.passes.some((pass: ExecutorPass): boolean => pass.bindsSource)
            && this.passes.every((pass: ExecutorPass): boolean => !pass.bindsSource || pass.recording.kind !== 'render' || pass.recording.target.kind === 'ring');
    }

    /**
     * Records one frame into a command encoder that the caller submits.
     * A new frame advances history after recording; a redraw repeats the last new frame's ring slots and history state.
     * A frame without a source redraws the last new frame from history: it skips the passes that read the source, and every pass before
     * the plan's history draw start, whose outputs no draw of that frame changes.
     */
    encode(commandEncoder: GPUCommandEncoder, frame: PresentationFrameInput): void {
        this.requireUsable();
        this.requireFrameSource(frame);
        const source = frame.source;
        const historyFrameNumber = getRecordedFrameNumber(this.historyFrameCount, frame.newFrame);
        const externalTexture = source === null ? null : this.prepareSource(source, frame.newFrame);
        this.writePresentationUniforms(frame, historyFrameNumber);
        for (const pass of this.passes) {
            if (source === null && (pass.bindsSource || pass.index < this.historyDrawStart)) {
                continue;
            }
            this.recordPass(commandEncoder, pass, historyFrameNumber % pass.phaseCount, externalTexture, frame);
        }
        if (frame.newFrame) {
            this.frameCount += 1;
            this.historyFrameCount += 1;
        }
    }

    /** Throws unless the frame's source fits the plan: a source of the plan's kind, or none for a redraw from history the plan allows. */
    private requireFrameSource(frame: PresentationFrameInput): void {
        const source = frame.source;
        if (source !== null && source.kind !== this.sourceKind) {
            throw new Error(`The plan presents a ${this.sourceKind} source, not a ${source.kind} source`);
        }
        if (source === null && (frame.newFrame || !this.canDrawFromHistory())) {
            throw new Error(`history-draw: ${frame.newFrame ? 'a new frame needs its source' : 'a pass reads the source at the output'}`);
        }
    }

    /** Records one pass of a frame at its ring phase, binding the frame's external texture when the pass reads it. */
    private recordPass(
        commandEncoder: GPUCommandEncoder,
        pass: ExecutorPass,
        phase: number,
        externalTexture: GPUExternalTexture | null,
        frame: PresentationFrameInput
    ): void {
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
        this.framePoolVisibleRectangles.clear();
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
            case 'pass-texture': {
                const view = this.passTextureViews.get(binding.textureId);
                if (!view) {
                    throw new Error(`Pass '${pass.label}' binds texture block ${binding.textureId}, which has no upload`);
                }
                return view;
            }
            case 'pass-sampler': {
                const sampler = this.passSamplers.get(getPassSamplerKey(requirePlannedPassTexture(this.passTextures, binding.textureId)));
                if (!sampler) {
                    throw new Error(`Pass '${pass.label}' binds the sampler of texture block ${binding.textureId}, which the plan does not declare`);
                }
                return sampler;
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

    /**
     * Binds a frame pool slot and writes the frame's visible rectangle into the slot's layout uniform, to which the frame pool signal clamps its taps.
     * A slot's frames can differ in visible rectangle, as a decoder's header replaces the container's or a picture reports its own size, so each frame writes its own.
     */
    private prepareFramePool(frame: FramePoolFrame): void {
        if (frame.pool !== this.framePoolBuffer) {
            this.framePoolBindGroups.clear();
            this.framePoolVisibleRectangles.clear();
            this.framePoolBuffer = frame.pool;
            this.boundFramePoolLayout = null;
        }
        this.writeFramePoolVisibleRectangle(frame);
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

    private writeFramePoolVisibleRectangle(frame: FramePoolFrame): void {
        const rectangle = frame.visibleRectangle;
        const key = `${rectangle.x},${rectangle.y},${rectangle.width},${rectangle.height}`;
        if (this.framePoolVisibleRectangles.get(frame.layout) === key) {
            return;
        }
        const data = new ArrayBuffer(FRAME_POOL_LAYOUT_BYTE_LENGTH - FRAME_POOL_VISIBLE_RECTANGLE_BYTE_OFFSET);
        writeFramePoolVisibleRectangle(new DataView(data), rectangle);
        this.device.queue.writeBuffer(frame.layout, FRAME_POOL_VISIBLE_RECTANGLE_BYTE_OFFSET, data);
        this.framePoolVisibleRectangles.set(frame.layout, key);
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

    /** Writes every pass's `presentation` uniform in one buffer write; a draw from history keeps the last source's size. */
    private writePresentationUniforms(frame: PresentationFrameInput, historyFrameNumber: number): void {
        const values = this.uniformValues;
        const geometry = frame.geometry;
        if (frame.source !== null) {
            setSourceSize(values, frame.source);
        }
        values.fieldState = frame.fieldState;
        values.frameIndex = getRecordedFrameNumber(this.frameCount, frame.newFrame);
        values.historyValid = Math.min(historyFrameNumber, this.historySaturation);
        values.outputHeight = geometry.viewportHeight;
        values.outputWidth = geometry.viewportWidth;
        values.refreshSeconds = frame.refreshMicroseconds / MICROSECONDS_PER_SECOND;
        values.skippedFrames = frame.skippedFrameCount;
        // Subtracted in double precision: an f32 timestamp an hour into a stream resolves only 244 microseconds
        values.targetOffsetSeconds = (frame.targetTimeMicroseconds - frame.timestampMicroseconds) / MICROSECONDS_PER_SECOND;
        values.timestampSeconds = frame.timestampMicroseconds / MICROSECONDS_PER_SECOND;
        const visibleRegion = frame.source === null ? null : getVisibleRegion(frame.source);
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
