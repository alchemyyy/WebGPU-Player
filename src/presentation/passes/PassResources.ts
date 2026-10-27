// The engine-owned bindings of every pass: their WGSL declarations, their bind group layout entries, and the byte layouts of the uniforms the engine writes.
// Built-in code reads these bindings by the variable names declared here, and the planner assigns their binding numbers.
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from '../../demux/dolby-vision/DolbyVisionRPUParser';
import { BYTES_PER_WORD, UNIFORM_BUFFER_OFFSET_ALIGNMENT } from '../WebGPUConstants';
import type { EngineBindingResource, EngineResource, PassParameter } from './PassTypes';

/** The bytes of one pass's `presentation` uniform. */
export const PRESENTATION_UNIFORM_BYTE_LENGTH = 72;

/** The stride of per-pass uniform slots in one buffer, the minimum uniform buffer offset alignment WebGPU guarantees. */
export const UNIFORM_SLOT_BYTE_LENGTH = UNIFORM_BUFFER_OFFSET_ALIGNMENT;

/** The bytes of the Dolby Vision enhancement uniform. */
export const ENHANCEMENT_UNIFORM_BYTE_LENGTH = 16;

/** The bytes of the frame pool layout uniform: the slot's layout, then the visible rectangle of the frame that presents it. */
export const FRAME_POOL_LAYOUT_BYTE_LENGTH = 80;

/** Where the frame pool layout uniform holds the presented frame's visible rectangle, which the executor writes as it binds the frame. */
export const FRAME_POOL_VISIBLE_RECTANGLE_BYTE_OFFSET = 64;

/** The planes a frame pool slot holds at most. */
export const FRAME_POOL_MAXIMUM_PLANE_COUNT = 3;

const DOLBY_VISION_RPU_WORD_COUNT = DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH / BYTES_PER_WORD;

type EngineStruct =
    | 'DolbyVisionEnhancementUniforms'
    | 'DolbyVisionRPUData'
    | 'FramePoolLayoutUniforms'
    | 'RenderSettingsUniforms';

const ENGINE_STRUCTS: Readonly<Record<EngineStruct, string>> = {
    DolbyVisionEnhancementUniforms: `struct DolbyVisionEnhancementUniforms {
    enhancementPresent: u32,
    padding0: u32,
    padding1: u32,
    padding2: u32,
}`,
    DolbyVisionRPUData: `struct DolbyVisionRPUData {
    words: array<u32, ${DOLBY_VISION_RPU_WORD_COUNT}>,
}`,
    FramePoolLayoutUniforms: `struct FramePoolPlane {
    byteOffset: u32,
    bytesPerRow: u32,
    width: u32,
    height: u32,
}

struct FramePoolLayoutUniforms {
    planes: array<FramePoolPlane, ${FRAME_POOL_MAXIMUM_PLANE_COUNT}>,
    slotByteOffset: u32,
    bytesPerComponent: u32,
    planeCount: u32,
    bitDepth: u32,
    visibleOrigin: vec2u,
    visibleSize: vec2u,
}`,
    RenderSettingsUniforms: `struct RenderSettingsUniforms {
    version: u32,
    toneMapOperator: u32,
    outputTransfer: u32,
    dynamicHDRMode: u32,
    desaturationStrength: f32,
    exposure: f32,
    inputPeakNits: f32,
    outputPeakNits: f32,
    paperWhiteNits: f32,
    brightness: f32,
    contrast: f32,
    saturation: f32,
    dynamicSceneAverageNits: f32,
    dynamicTargetPeakNits: f32,
    dynamicKneeX: f32,
    dynamicKneeY: f32,
    dynamicBezierAnchorCount: u32,
    dynamicReserved0: u32,
    dynamicReserved1: u32,
    dynamicReserved2: u32,
    dynamicBezierAnchors0: vec4f,
    dynamicBezierAnchors1: vec4f,
    dynamicBezierAnchors2: vec4f,
    dynamicBezierAnchors3: vec4f,
}`
};

type EngineBindingDeclaration = {
    /** The binding's WGSL `var` declaration after its attributes. */
    declaration: string
    layout: Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'>
    structs: readonly EngineStruct[]
};

const UNSIGNED_PLANE_LAYOUT: Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'> = {
    texture: { sampleType: 'uint', viewDimension: '2d' }
};

const ENGINE_BINDINGS: Readonly<Record<EngineBindingResource, EngineBindingDeclaration>> = {
    'dolby-vision-rpu': {
        declaration: 'var<storage, read> dolbyVisionRPU: DolbyVisionRPUData;',
        layout: { buffer: { type: 'read-only-storage' } },
        structs: [ 'DolbyVisionRPUData' ]
    },
    'enhancement-chroma-u': {
        declaration: 'var enhancementChromaUTexture: texture_2d<u32>;',
        layout: UNSIGNED_PLANE_LAYOUT,
        structs: []
    },
    'enhancement-chroma-v': {
        declaration: 'var enhancementChromaVTexture: texture_2d<u32>;',
        layout: UNSIGNED_PLANE_LAYOUT,
        structs: []
    },
    'enhancement-luma': {
        declaration: 'var enhancementLumaTexture: texture_2d<u32>;',
        layout: UNSIGNED_PLANE_LAYOUT,
        structs: []
    },
    'enhancement-uniform': {
        declaration: 'var<uniform> enhancement: DolbyVisionEnhancementUniforms;',
        layout: { buffer: { type: 'uniform' } },
        structs: [ 'DolbyVisionEnhancementUniforms' ]
    },
    'external-texture': {
        declaration: 'var videoTexture: texture_external;',
        layout: { externalTexture: {} },
        structs: []
    },
    'frame-pool': {
        declaration: 'var<storage, read> framePool: array<u32>;',
        layout: { buffer: { type: 'read-only-storage' } },
        structs: []
    },
    'frame-pool-layout': {
        declaration: 'var<uniform> framePoolLayout: FramePoolLayoutUniforms;',
        layout: { buffer: { type: 'uniform' } },
        structs: [ 'FramePoolLayoutUniforms' ]
    },
    'plane-chroma': {
        declaration: 'var chromaTexture: texture_2d<u32>;',
        layout: UNSIGNED_PLANE_LAYOUT,
        structs: []
    },
    'plane-chroma-u': {
        declaration: 'var chromaUTexture: texture_2d<u32>;',
        layout: UNSIGNED_PLANE_LAYOUT,
        structs: []
    },
    'plane-chroma-v': {
        declaration: 'var chromaVTexture: texture_2d<u32>;',
        layout: UNSIGNED_PLANE_LAYOUT,
        structs: []
    },
    'plane-luma': {
        declaration: 'var lumaTexture: texture_2d<u32>;',
        layout: UNSIGNED_PLANE_LAYOUT,
        structs: []
    },
    'render-settings': {
        declaration: 'var<uniform> renderSettings: RenderSettingsUniforms;',
        layout: { buffer: { type: 'uniform' } },
        structs: [ 'RenderSettingsUniforms' ]
    },
    'sampler-linear': {
        declaration: 'var videoSampler: sampler;',
        layout: { sampler: { type: 'filtering' } },
        structs: []
    }
};

const ENGINE_RESOURCE_BINDINGS: Readonly<Record<EngineResource, readonly EngineBindingResource[]>> = {
    'dolby-vision-enhancement': [ 'enhancement-luma', 'enhancement-chroma-u', 'enhancement-chroma-v', 'enhancement-uniform' ],
    'dolby-vision-rpu': [ 'dolby-vision-rpu' ],
    'external-texture': [ 'external-texture' ],
    'frame-pool': [ 'frame-pool', 'frame-pool-layout' ],
    'planes-nv12': [ 'plane-luma', 'plane-chroma' ],
    'planes-yuv': [ 'plane-luma', 'plane-chroma-u', 'plane-chroma-v' ],
    'render-settings': [ 'render-settings' ],
    'sampler-linear': [ 'sampler-linear' ]
};

/**
 * The bits of the `presentation` uniform's `fieldState`, which say how an interlaced frame presents now; 0 presents a frame as it is.
 * - deinterlace: the shown frame is interlaced and its missing rows are interpolated.
 * - bottomFieldShown: the shown field is the bottom one, the frame's odd rows; otherwise the top one.
 * - secondField: the shown field is its frame's second in time.
 * - currentIsPrevious: the shown frame is the one before the newest in history, and the newest is the frame after it; otherwise the newest is shown and has none after it.
 * - interlacedSignal: the frame the signal reads now is interlaced, so 4:2:0 chroma is sampled within each field.
 */
export const PRESENTATION_FIELD_STATE = Object.freeze({
    bottomFieldShown: 0x2,
    currentIsPrevious: 0x8,
    deinterlace: 0x1,
    interlacedSignal: 0x10,
    none: 0,
    secondField: 0x4
});

/**
 * The `presentation` uniform every pass binds: its coordinate mapping and the frame globals.
 * `historyValid` counts the earlier frames history holds: 0 after a reset, rising by one per new frame to the plan's deepest history.
 * `fieldState` holds PRESENTATION_FIELD_STATE bits.
 * `refreshSeconds` is the media time one display refresh covers, 0 while the display is unmeasured or the clock stands still, and `targetOffsetSeconds`
 * the clock time the draw presents at, after `timestampSeconds`; the engine subtracts the two in double precision, so the offset keeps its precision late in a long stream.
 */
export const PRESENTATION_UNIFORMS_WGSL = `struct PresentationUniforms {
    textureScale: vec2f,
    textureOffset: vec2f,
    sourceSize: vec2f,
    outputSize: vec2f,
    inputSize: vec2f,
    timestampSeconds: f32,
    frameIndex: u32,
    historyValid: u32,
    skippedFrames: u32,
    fieldState: u32,
    refreshSeconds: f32,
    targetOffsetSeconds: f32,
    padding0: u32,
}`;

/** The values of one pass's `presentation` uniform. */
export type PresentationUniformValues = {
    /** PRESENTATION_FIELD_STATE bits */
    fieldState: number
    frameIndex: number
    historyValid: number
    inputHeight: number
    inputWidth: number
    outputHeight: number
    outputWidth: number
    refreshSeconds: number
    skippedFrames: number
    sourceHeight: number
    sourceWidth: number
    targetOffsetSeconds: number
    textureOffsetX: number
    textureOffsetY: number
    textureScaleX: number
    textureScaleY: number
    timestampSeconds: number
};

/** The layout of one plane in a frame pool slot, in bytes from the slot's start. */
export type FramePoolPlaneLayout = {
    byteOffset: number
    bytesPerRow: number
    height: number
    width: number
};

/** A slot's layout: its planes, where it starts in the pool, and its output format's sample size and bit depth, which the frame pool signal reads per frame. */
export type FramePoolLayoutValues = {
    bitDepth: number
    bytesPerComponent: 1 | 2
    planes: readonly FramePoolPlaneLayout[]
    slotByteOffset: number
};

/** A frame's visible rectangle in luma samples of its coded frame. */
export type FramePoolVisibleRectangle = { height: number; width: number; x: number; y: number };

/** Returns a parameter's byte offset in its pass's `parameters` uniform: declared scalars in order, 4 bytes apart. */
/** Returns a parameter value in its type and range: integers round, and values outside the range clamp to it; a value that is not finite throws a RangeError. */
export function normalizePassParameterValue(parameter: PassParameter, value: number): number {
    if (!Number.isFinite(value)) {
        throw new RangeError(`Parameter '${parameter.name}' must be a finite number`);
    }
    const typedValue = parameter.type === 'f32' ? value : Math.round(value);
    return Math.min(Math.max(typedValue, parameter.minimum), parameter.maximum);
}

export function getParameterByteOffset(parameterIndex: number): number {
    return parameterIndex * BYTES_PER_WORD;
}

/** Returns the byte length of a `parameters` uniform holding parameterCount scalars, rounded up to 16 bytes. */
export function getParametersByteLength(parameterCount: number): number {
    const minimumByteLength = 16;
    return Math.max(minimumByteLength, Math.ceil((parameterCount * BYTES_PER_WORD) / minimumByteLength) * minimumByteLength);
}

/** Returns the bindings an engine resource group expands into, in binding order. */
export function expandEngineResource(resource: EngineResource): readonly EngineBindingResource[] {
    return ENGINE_RESOURCE_BINDINGS[resource];
}

/** Returns an engine binding's declaration with its group 0 binding number. */
export function createEngineBindingWGSL(resource: EngineBindingResource, binding: number): string {
    return `@group(0) @binding(${binding}) ${ENGINE_BINDINGS[resource].declaration}`;
}

/** Returns the struct declarations engine bindings need, each once, in a stable order. */
export function createEngineStructsWGSL(resources: Iterable<EngineBindingResource>): string {
    const structNames = new Set<EngineStruct>();
    for (const resource of resources) {
        for (const structName of ENGINE_BINDINGS[resource].structs) {
            structNames.add(structName);
        }
    }
    return [ ...structNames ]
        .sort((first: EngineStruct, second: EngineStruct): number => first.localeCompare(second))
        .map((structName: EngineStruct): string => ENGINE_STRUCTS[structName])
        .join('\n\n');
}

/** Returns the `presentation` uniform declaration with its group 0 binding number; PRESENTATION_UNIFORMS_WGSL declares its struct. */
export function createPresentationBindingWGSL(binding: number): string {
    return `@group(0) @binding(${binding}) var<uniform> presentation: PresentationUniforms;`;
}

/** Returns an engine binding's bind group layout entry without its binding number and visibility. */
export function getEngineBindingLayout(resource: EngineBindingResource): Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'> {
    return ENGINE_BINDINGS[resource].layout;
}

/** Writes one pass's `presentation` uniform at byteOffset, in the field order of PRESENTATION_UNIFORMS_WGSL. */
export function writePresentationUniform(target: DataView, byteOffset: number, values: PresentationUniformValues): void {
    target.setFloat32(byteOffset, values.textureScaleX, true);
    target.setFloat32(byteOffset + 4, values.textureScaleY, true);
    target.setFloat32(byteOffset + 8, values.textureOffsetX, true);
    target.setFloat32(byteOffset + 12, values.textureOffsetY, true);
    target.setFloat32(byteOffset + 16, values.sourceWidth, true);
    target.setFloat32(byteOffset + 20, values.sourceHeight, true);
    target.setFloat32(byteOffset + 24, values.outputWidth, true);
    target.setFloat32(byteOffset + 28, values.outputHeight, true);
    target.setFloat32(byteOffset + 32, values.inputWidth, true);
    target.setFloat32(byteOffset + 36, values.inputHeight, true);
    target.setFloat32(byteOffset + 40, values.timestampSeconds, true);
    target.setUint32(byteOffset + 44, values.frameIndex, true);
    target.setUint32(byteOffset + 48, values.historyValid, true);
    target.setUint32(byteOffset + 52, values.skippedFrames, true);
    target.setUint32(byteOffset + 56, values.fieldState, true);
    target.setFloat32(byteOffset + 60, values.refreshSeconds, true);
    target.setFloat32(byteOffset + 64, values.targetOffsetSeconds, true);
}

/** Writes the frame pool layout uniform, in the field order of FramePoolLayoutUniforms. */
export function writeFramePoolLayout(target: DataView, values: FramePoolLayoutValues): void {
    if (values.planes.length === 0 || values.planes.length > FRAME_POOL_MAXIMUM_PLANE_COUNT) {
        throw new RangeError(`A frame pool slot holds 1 to ${FRAME_POOL_MAXIMUM_PLANE_COUNT} planes`);
    }
    for (let planeIndex = 0; planeIndex < values.planes.length; planeIndex += 1) {
        const plane = values.planes[planeIndex];
        const planeByteOffset = planeIndex * 16;
        target.setUint32(planeByteOffset, plane.byteOffset, true);
        target.setUint32(planeByteOffset + 4, plane.bytesPerRow, true);
        target.setUint32(planeByteOffset + 8, plane.width, true);
        target.setUint32(planeByteOffset + 12, plane.height, true);
    }
    target.setUint32(48, values.slotByteOffset, true);
    target.setUint32(52, values.bytesPerComponent, true);
    target.setUint32(56, values.planes.length, true);
    target.setUint32(60, values.bitDepth, true);
}

/** Writes the visible rectangle of the frame that presents a slot into its frame pool layout uniform, in luma samples of the coded frame. */
export function writeFramePoolVisibleRectangle(target: DataView, rectangle: FramePoolVisibleRectangle): void {
    target.setUint32(0, rectangle.x, true);
    target.setUint32(4, rectangle.y, true);
    target.setUint32(8, rectangle.width, true);
    target.setUint32(12, rectangle.height, true);
}
