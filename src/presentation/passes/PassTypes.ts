// The contracts shared by the pass manifest, the built-in passes, the planner, the executor, and the GPU decode route.
// The Presentation section of docs/src/architecture.md and docs/src/new-pass.md describe them.
import type { InputColorMetadata } from '../../color/ColorMetadata';
import type { ChromaLocation, ChromaSubsampling } from '../../demux/VideoChromaFormat';
import type {
    RawDolbyVisionVideoFrameFormat,
    SupportedRawVideoFrameFormat,
    TransferableRawVideoFrame
} from '../../decode/video/RawVideoFrameCopy';
import type { GPUDecoderOutputFormat } from '../../decode/video/gpu/GPUDecodeFormats';
import type { DolbyVisionReconstructionProfile } from '../PresentationInput';
import type { TexturePresentationGeometry } from '../PresentationGeometry';
import type { HDRToSDRRenderSettings, RenderSettings } from '../RenderSettings';

/**
 * A stage of the spatial spine that user passes hook.
 * The plane stages, 'LUMA', 'CHROMA', and 'NATIVE', hold the signal's planes before it converts them; the fixed signal step converts them into 'RGB'.
 */
export type PresentationStage = 'CHROMA' | 'LUMA' | 'NATIVE' | 'OUTPUT' | 'PRESCALE' | 'RGB' | 'SCALE';

/**
 * A state on the color track.
 * - 'source': encoded RGB in the source's primaries and transfer function, which the fixed signal step produces.
 * - 'linear': linear light in nits, in the source's primaries.
 * - 'display-linear': linear light in nits, mapped to the display's range and primaries.
 * - 'display': values encoded for the output target, ready for the canvas.
 */
export type ColorState = 'display' | 'display-linear' | 'linear' | 'source';

/** The color domain a pass requires on input; 'sdr' is satisfied by 'display' while the output is SDR. */
export type ColorDomain = 'any' | 'display' | 'linear' | 'sdr' | 'source';

/**
 * - 'color': `fn apply(color: vec4f, position: vec2f) -> vec4f`, per pixel, always fused into a neighboring pass.
 * - 'kernel': `fn kernel(coordinate: vec2f) -> vec4f`, reading neighboring pixels of its inputs.
 * - 'scaler': `fn scale(coordinate: vec2f) -> vec4f`, the one pass that writes exactly the output rectangle.
 * - 'compute': `fn compute(id: vec3u)`, dispatched over its declared workgroups.
 * A coordinate is a normalized position in the hooked input; a position is the target pixel center in pixels.
 */
export type PassShape = 'color' | 'compute' | 'kernel' | 'scaler';

export type PassExpressionBinaryOperator =
    | '!='
    | '%'
    | '&&'
    | '*'
    | '+'
    | '-'
    | '/'
    | '<'
    | '<='
    | '=='
    | '>'
    | '>='
    | '||';

export type PassExpressionFunction = 'abs' | 'ceil' | 'floor' | 'max' | 'min' | 'round';

/** A parsed size or condition expression of a pass or decoder header. */
export type PassExpression =
    | { kind: 'binary'; left: PassExpression; operator: PassExpressionBinaryOperator; right: PassExpression }
    | { arguments: readonly PassExpression[]; kind: 'call'; name: PassExpressionFunction }
    | { kind: 'identifier'; name: string }
    | { kind: 'number'; value: number }
    | { kind: 'unary'; operand: PassExpression; operator: '!' | '-' };

/**
 * Identifier values for expressions; booleans are 1 or 0.
 * The planner provides `source.width`, `source.height`, `output.width`, `output.height`, `frame.rate` (0 when unknown), `hdr.source`, and `hdr.output`, plus `<input>.width` and `<input>.height` for each input of a pass, `HOOKED` included.
 */
export type PassExpressionFacts = ReadonlyMap<string, number>;

export type PassInput = {
    /** 0 reads the current frame, -1 the previous frame, and so on. */
    historyOffset: number
    /** 'HOOKED', a stage name, or a name an earlier pass saved. */
    name: string
};

export type PassParameterType = 'f32' | 'i32' | 'u32';

export type PassParameter = {
    defaultValue: number
    maximum: number
    minimum: number
    name: string
    type: PassParameterType
};

export type PassOutput = {
    format: GPUTextureFormat
    height: PassExpression
    width: PassExpression
};

/**
 * Where a pass's output sits on the reference grid, as mpv's `OFFSET` says.
 * - 'pixels': the output's offset is the hooked image's, scaled by the output's size over the hooked image's, plus x and y output pixels.
 * - 'align': the output's offset is the reference grid's own, 0.
 */
export type PassOffset = { kind: 'align' } | { kind: 'pixels'; x: number; y: number };

export type PassWorkgroup = {
    dispatch: readonly [PassExpression, PassExpression, PassExpression]
    size: readonly [number, number, number]
};

export type PassTextureFilter = 'linear' | 'nearest';

/** How a texture block's coordinates wrap: clamped to its edge texels, repeated, or mirrored. */
export type PassTextureEdge = 'clamp' | 'mirror' | 'repeat';

/** A texture block of a pass file, which its passes bind by name, such as a 3D LUT or a table of weights. */
export type PassTexture = {
    /** The texels in little-endian order, x fastest, then y, then z, packed tightly in the format */
    data: Uint8Array<ArrayBuffer>
    dimensions: 1 | 2 | 3
    edge: PassTextureEdge
    filter: PassTextureFilter
    format: GPUTextureFormat
    /** The content identity of the block's size, format, and data (`ContentIdentity.ts`), which keys its upload */
    identity: string
    name: string
    /** Width, height, and depth, 1 on the axes past its dimensions */
    size: readonly [number, number, number]
};

/** A parsed user pass: its `//!` header and its WGSL body. */
export type PassManifest = {
    /** The WGSL after the header. */
    body: string
    /** The 1-based source line of the body's first line, for compile error mapping. */
    bodyFirstLine: number
    components: 1 | 2 | 3 | 4 | null
    /** Parameters declared with `const`: WGSL constants the body reads by name, whose values the plan compiles in, so a change builds a new plan. */
    constants: readonly PassParameter[]
    /** 'any' for a color pass with `replaces`, which takes the replaced function's color states. */
    domain: ColorDomain
    /** Null for a color pass with `replaces`, which runs in the replaced function's place. */
    hook: PresentationStage | null
    inputs: readonly PassInput[]
    name: string
    /** Null for the default, the hooked image's offset scaled by the output's size */
    offset: PassOffset | null
    output: PassOutput | null
    /** Parameters declared with `param`: the `parameters` uniform's members, which a change writes without a new plan. */
    parameters: readonly PassParameter[]
    /** The built-in color function a color pass replaces, such as 'builtin.tone-map'; a scaler always replaces the built-in scaler. */
    replaces: string | null
    save: string | null
    shape: PassShape
    /** The file's texture blocks the pass binds with `bind`, in header order */
    textures: readonly PassTexture[]
    when: PassExpression | null
    workgroup: PassWorkgroup | null
};

/** A group of engine-owned bindings that built-in code reads; PassResources expands each into its bindings. */
export type EngineResource =
    | 'dolby-vision-enhancement'
    | 'dolby-vision-rpu'
    | 'external-texture'
    | 'frame-pool'
    | 'planes-nv12'
    | 'planes-yuv'
    | 'render-settings'
    | 'sampler-linear';

/** One engine-owned binding, with a fixed WGSL variable name in PassResources. */
export type EngineBindingResource =
    | 'dolby-vision-rpu'
    | 'enhancement-chroma-u'
    | 'enhancement-chroma-v'
    | 'enhancement-luma'
    | 'enhancement-uniform'
    | 'external-texture'
    | 'frame-pool'
    | 'frame-pool-layout'
    | 'plane-chroma'
    | 'plane-chroma-u'
    | 'plane-chroma-v'
    | 'plane-luma'
    | 'render-settings'
    | 'sampler-linear';

export type PresentationSourceKind = 'external' | 'frame-pool' | 'planes';

/** A built-in per-pixel step of the color track. */
export type BuiltinColorFunction = {
    /** WGSL definitions, including the entry point; built-in names never collide. */
    code: string
    /** `fn <entryPoint>(color: vec4f, position: vec2f) -> vec4f`, where position is the output pixel center. */
    entryPoint: string
    inputState: ColorState
    name: string
    outputState: ColorState
    /** Runs only in the last pass, at output resolution, such as dither. */
    pinnedToOutput: boolean
    resources: readonly EngineResource[]
};

/**
 * How a signal reads its planes apart and converts them, which plane passes run between; its code calls functions of the signal's code.
 * A plane holds codes divided by the code scale, as mpv's planes hold normalized values, so a value of 1 is the largest code.
 */
export type SignalPlanes = {
    /** `fn <entryPoint>(coordinate: vec2f) -> vec2f`: Cb and Cr codes at a normalized coordinate of the chroma plane, without siting. */
    chromaEntryPoint: string
    chromaFormat: GPUTextureFormat
    chromaHeightDivisor: 1 | 2
    /** The chroma plane's offset in its own pixels: where the signal reads it on the luma grid. */
    chromaOffset: readonly [number, number]
    chromaWidthDivisor: 1 | 2
    /** `fn <entryPoint>() -> f32`: the code a plane value of 1 stands for. */
    codeScaleEntryPoint: string
    code: string
    /** `fn <entryPoint>(codes: vec3f) -> vec4f`: Y, Cb, and Cr codes to 'source' RGB, as the signal converts them. */
    conversionEntryPoint: string
    /** `fn <entryPoint>(coordinate: vec2f) -> f32`: the luma code at a normalized coordinate. */
    lumaEntryPoint: string
    lumaFormat: GPUTextureFormat
    /** The format of NATIVE, the planes merged into normalized Y, Cb, and Cr on luma's grid. */
    nativeFormat: GPUTextureFormat
    /** Whether the source codes R, G, and B planes rather than Y, Cb, and Cr, which the `rgb.source` fact tells passes, as mpv fires its RGB hook on them. */
    rgb: boolean
    /** `fn <entryPoint>(coordinate: vec2f) -> vec2f`: Cb and Cr codes at a normalized coordinate of the luma grid, sited as the signal reads them. */
    sitedChromaEntryPoint: string
    /**
     * WGSL of the same plane functions, derived from an image of the signal's 'source' RGB through the transform, as a deinterlacing plan derives its planes
     * from its deinterlaced image; the plan defines the image's reads, `fn <imageReadEntryPoint>(coordinate: vec2f) -> vec3f` and `fn <imageSizeEntryPoint>() -> vec2f`.
     */
    imageCode: string
    imageReadEntryPoint: string
    imageSizeEntryPoint: string
    /** `fn <entryPoint>(planes: vec3f) -> vec3f`: normalized Y, Cb, and Cr plane values to 'source' RGB, the exact inverse of rgbToPlanesEntryPoint. */
    planesToRGBEntryPoint: string
    /** `fn <entryPoint>(color: vec3f) -> vec3f`: 'source' RGB to normalized Y, Cb, and Cr plane values, through the matrix and range that produced the RGB. */
    rgbToPlanesEntryPoint: string
    /** Self-contained WGSL of the two transform functions, which code and imageCode call and passes reach through the prelude. */
    transformCode: string
};

/** The fixed, decode-equivalent step of a route: it reads the source and produces 'source' RGB. */
export type SignalDefinition = {
    /**
     * A WGSL bool expression; while it holds, the frame skips every color function (Dolby Vision Profile 4 FEL without its EL).
     * It may call functions of the signal's code, so only the pass that reads the signal evaluates it.
     * A pass that materializes such a signal for user passes therefore completes the color track to display first.
     */
    bypassCondition: string | null
    code: string
    /** `fn <entryPoint>(coordinate: vec2f) -> vec4f`, bilinear at a normalized source coordinate, returning 'source' RGB. */
    entryPoint: string
    name: string
    /** The planes plane passes read, or null when the signal has none to offer, as Dolby Vision reconstruction does. */
    planes: SignalPlanes | null
    resources: readonly EngineResource[]
    sourceKind: PresentationSourceKind
};

/** The source's transfer function, which the prelude's linearize and delinearize compile from, in the scale of mpv's linear light. */
export type SignalLinearLight = {
    /**
     * Self-contained WGSL of `fn <decodeEntryPoint>(color: vec3f) -> vec3f`, encoded values to linear nits as the built-in transfer decode computes them,
     * and `fn <encodeEntryPoint>(nits: vec3f) -> vec3f`, its inverse.
     */
    code: string
    decodeEntryPoint: string
    encodeEntryPoint: string
    /** The nits of mpv's linear 1.0: the configured SDR white for an SDR source, the HDR reference white for HDR. */
    referenceWhiteNits: number
};

/** A route's built-in chain; its scaler is the implicit bilinear read of the signal. */
export type BuiltinChain = {
    /** The default color functions, in color-track order. */
    colorFunctions: readonly BuiltinColorFunction[]
    /** The source's transfer function, or null while the route does not know it, as the identity route before its stream's color is configured. */
    linearLight: SignalLinearLight | null
    signal: SignalDefinition
    /** True when 'source' values are already display values (identity SDR), so the chain may be empty. */
    sourceIsDisplay: boolean
};

/** The Dolby Vision base layer formats RPU reconstruction samples. */
export type RawDolbyVisionFrameFormat = RawDolbyVisionVideoFrameFormat;

/**
 * A route the built-in library builds a chain for.
 * `hdrOutput` selects the extended-range output encode in place of the SDR encode, display controls, and dither.
 * `chromaLocation` is where the stream's 4:2:0 chroma lies, which the planar signals read chroma at and the external routes derive their planes' chroma at;
 * null or absent is the left siting H.264 and HEVC default to.
 * The frame pool route's signal reads the GPU decoder's slots of its output format, and its color functions are the library's.
 */
export type BuiltinChainConfiguration =
    | {
        chromaLocation?: ChromaLocation | null
        felReconstruction: boolean
        format: RawDolbyVisionFrameFormat
        hdrOutput: boolean
        profile: DolbyVisionReconstructionProfile
        route: 'raw-dolby-vision'
        settings: HDRToSDRRenderSettings
    }
    | {
        chromaLocation?: ChromaLocation | null
        format: SupportedRawVideoFrameFormat
        hdrOutput: boolean
        /** The signal reads 4:2:0 chroma within each field of a frame the presentation uniform marks interlaced, as a deinterlacing plan's does */
        interlacedChroma?: boolean
        metadata: InputColorMetadata
        route: 'raw-yuv'
        settings: RenderSettings
    }
    | {
        chromaLocation?: ChromaLocation | null
        /** The stream's chroma subsampling, at which the planes derived from the browser's RGB hold chroma; null for chroma at the image's size */
        chromaSubsampling?: ChromaSubsampling | null
        hdrOutput: boolean
        metadata: InputColorMetadata
        route: 'external-hdr'
        settings: HDRToSDRRenderSettings
    }
    | {
        chromaLocation?: ChromaLocation | null
        /** The format of the stream's first frames, whose bit depth the metadata holds; each slot's own layout decides how its samples read */
        format: GPUDecoderOutputFormat
        hdrOutput: boolean
        /** The signal reads a slot's 4:2:0 chroma within each field of a frame the presentation uniform marks interlaced, as a deinterlacing plan's does */
        interlacedChroma?: boolean
        metadata: InputColorMetadata
        route: 'frame-pool'
        settings: RenderSettings
    }
    | {
        chromaLocation?: ChromaLocation | null
        /** The format of the BL slots, which every frame of the route holds */
        format: GPUDecoderOutputFormat
        hdrOutput: boolean
        profile: DolbyVisionReconstructionProfile
        route: 'frame-pool-dolby-vision'
        settings: HDRToSDRRenderSettings
    }
    | { hdrOutput: boolean; route: 'external-dolby-vision'; settings: HDRToSDRRenderSettings }
    | {
        chromaLocation?: ChromaLocation | null
        /** The stream's chroma subsampling, at which the planes derived from the browser's RGB hold chroma; null for chroma at the image's size */
        chromaSubsampling?: ChromaSubsampling | null
        /** The stream's color, whose matrix and range the browser converted with; null when unknown, which leaves the route without planes */
        metadata: InputColorMetadata | null
        route: 'external-identity'
    };

/** The canvas configuration a plan renders for. */
export type PlannedOutput = {
    colorSpace: PredefinedColorSpace
    format: GPUTextureFormat
    toneMapping: GPUCanvasToneMappingMode
};

export type PlanFacts = {
    frameRate: number | null
    hdrOutput: boolean
    hdrSource: boolean
    /** The output rectangle in device pixels, letterboxing excluded. */
    outputHeight: number
    outputWidth: number
    /** The frame's visible size in samples, which the planes hold; an anamorphic stream's differs from the source size. */
    sampleHeight: number
    sampleWidth: number
    /** The visible source size in pixels. */
    sourceHeight: number
    sourceWidth: number
};

export type PlanDevice = {
    features: ReadonlySet<string>
    /** The device's maxTextureDimension2D, which bounds planned textures and the two-dimensional and one-dimensional texture blocks */
    maximumTextureDimension: number
    /** The device's maxTextureDimension3D, which bounds three-dimensional texture blocks; WebGPU's default when absent */
    maximumTextureDimension3D?: number
};

/**
 * The deinterlacing pass a plan places first on the spine, over the route's signal in 'source' RGB.
 * It runs at the decoded frame's visible size in samples, never the display size, so each row of the frame stays one row of one field.
 */
export type DeinterlaceRequest = {
    /** The stream's bit depth, whose code value is what the spatial score gives away */
    bitDepth: number
    frameHeight: number
    frameWidth: number
};

export type PlanRequest = {
    chain: BuiltinChain
    /** The deinterlacing pass, or absent or null for none; a signal with a bypass condition never takes one */
    deinterlace?: DeinterlaceRequest | null
    device: PlanDevice
    facts: PlanFacts
    output: PlannedOutput
    /**
     * The current values of the passes' parameters and constants, by pass name and parameter name, which `when` reads and constants compile in;
     * a parameter without one takes its default, and every value takes its type and range.
     */
    parameterValues?: ReadonlyMap<string, ReadonlyMap<string, number>>
    /** User passes in preset order. */
    passes: readonly PassManifest[]
};

export type PlannedTexture = {
    format: GPUTextureFormat
    height: number
    /** A ring holds historyDepth + 1 textures; 0 is a texture without history. */
    historyDepth: number
    id: string
    /** Written by a compute pass, so it needs storage usage. */
    storage: boolean
    width: number
};

export type PlannedBuffer = {
    byteLength: number
    id: string
    indirect: boolean
    /** Kept across frames, such as a state buffer; otherwise it may be reused within a frame. */
    persistent: boolean
};

/**
 * How a render pass maps its target pixels to coordinates in its input; the executor computes the mapping each frame.
 * - 'object-fit': the output rectangle from the source through the CSS object-fit mapping, and a raw frame's visible rectangle.
 * - 'identity': target pixels map 1:1 onto the whole input.
 */
export type PassCoordinateMapping = 'identity' | 'object-fit';

export type PlannedBinding =
    | { binding: number; kind: 'engine'; resource: EngineBindingResource }
    | { access: 'read-only-storage' | 'storage' | 'uniform'; binding: number; bufferId: string; kind: 'buffer' }
    /** The pass's `presentation` uniform: its coordinate mapping and the frame globals. */
    | { binding: number; kind: 'presentation' }
    /** The pass's `parameters` uniform, holding its declared parameters. */
    | { binding: number; kind: 'parameters'; passName: string }
    | { access: 'sampled' | 'storage'; binding: number; historyOffset: number; kind: 'texture'; textureId: string }
    /** A pass file's texture block, by its identity, and the sampler of its filter and edge mode. */
    | { binding: number; kind: 'pass-texture'; textureId: string }
    | { binding: number; kind: 'pass-sampler'; textureId: string };

/** A pass file's texture block the plan binds, by its content identity; the executor uploads its data once, through the caller's cache. */
export type PlannedPassTexture = {
    /** WebGPU's dimension: a one-dimensional block is a two-dimensional texture one texel high, which every pass shape can sample */
    dimension: '2d' | '3d'
    edge: PassTextureEdge
    filter: PassTextureFilter
    format: GPUTextureFormat
    id: string
    size: readonly [number, number, number]
};

export type PassTarget = { kind: 'output' } | { kind: 'texture'; textureId: string };

/** Generated lines that came from one user pass's body; lines are 1-based, like the browser's compile messages. */
export type PassLineMapping = {
    firstGeneratedLine: number
    firstSourceLine: number
    lineCount: number
    passName: string
};

/** One GPU pass of a plan; every binding is in group 0. */
export type PlannedPass = {
    bindings: readonly PlannedBinding[]
    /** A complete WGSL module: `vertexMain` and `fragmentMain` for a render pass, `computeMain` for a compute pass. */
    code: string
    /** The color steps the pass runs after its core, in order: built-in function names such as 'builtin.tone-map', and user pass names. */
    colorSteps: readonly string[]
    coordinateMapping: PassCoordinateMapping
    indirectBufferId: string | null
    /** The texture whose size fills `presentation.inputSize`, or null when the pass reads the source. */
    inputTextureId: string | null
    kind: 'compute' | 'render'
    label: string
    lineMap: readonly PassLineMapping[]
    /** Render passes only; the 'output' target is drawn inside the output rectangle after clearing the target. */
    target: PassTarget | null
    /** Compute passes without an indirect buffer only. */
    workgroupCounts: readonly [number, number, number] | null
};

/**
 * The check that kept a user pass out of a plan; every reason but 'condition-false' is a failure.
 * The presenter adds 'header-invalid', 'compile-error', and the parameter checks, since it parses headers, applies preset values, and compiles plans.
 * It also reports 'duplicate-name' itself, by preset position, so the planner never receives two passes of one name.
 */
export type PassRejectionReason =
    | 'compile-error'
    | 'condition-false'
    | 'condition-invalid'
    | 'domain-unreachable'
    | 'duplicate-name'
    | 'extra-scaler'
    | 'header-invalid'
    | 'input-after-hook'
    | 'input-reserved'
    | 'input-unknown'
    | 'linear-light-unavailable'
    | 'output-missing'
    | 'output-size'
    | 'parameter-invalid'
    | 'parameter-unknown'
    | 'planes-unavailable'
    | 'replaced-function-missing'
    | 'replaced-function-taken'
    | 'sdr-on-hdr-output'
    | 'texture-format'
    | 'texture-size'
    | 'workgroup-count'
    | 'workgroup-missing';

/** A user pass left out of a plan: the failed check and a terse detail with the failing values. */
export type PassRejection = {
    detail: string
    name: string
    reason: PassRejectionReason
};

export type PlanReport = {
    activePasses: readonly string[]
    inactivePasses: readonly PassRejection[]
};

/** One user pass's parameters; its `parameters` uniform holds them as PassResources lays them out. */
export type PlannedParameterSet = {
    parameters: readonly PassParameter[]
    passName: string
};

/** An immutable plan: passes in execution order and the resources they use. */
export type PresentationPlan = {
    buffers: readonly PlannedBuffer[]
    /** The deinterlacing pass the plan placed, or null for none */
    deinterlace: DeinterlaceRequest | null
    output: PlannedOutput
    parameterSets: readonly PlannedParameterSet[]
    /** The texture blocks the passes bind, each once by identity */
    passTextures: readonly PlannedPassTexture[]
    passes: readonly PlannedPass[]
    report: PlanReport
    sourceKind: PresentationSourceKind
    textures: readonly PlannedTexture[]
    /** Whether the plan binds the render settings uniform. */
    usesRenderSettings: boolean
};

/** A shader compile message, mapped back to the user pass it came from. */
export type PresentationCompileMessage = {
    column: number
    /** The line in the user pass's source, or in the generated module when passName is null. */
    line: number
    message: string
    /** The user pass the line belongs to, or null for engine-generated code. */
    passName: string | null
};

/** Where the plane data of a frame in the GPU decode route's frame pool lives. */
export type FramePoolFrame = {
    codedHeight: number
    codedWidth: number
    /** The pool's layout uniform, which names the frame's slot. */
    layout: GPUBuffer
    pool: GPUBuffer
    visibleRectangle: { height: number; width: number; x: number; y: number }
};

export type PresentationFrameSource =
    | { frame: FramePoolFrame; kind: 'frame-pool' }
    | { enhancementFrame: TransferableRawVideoFrame | null; frame: TransferableRawVideoFrame; kind: 'planes' }
    | { kind: 'external'; source: HTMLVideoElement | VideoFrame };

/** What the executor needs to record one frame. */
export type PresentationFrameInput = {
    /** PRESENTATION_FIELD_STATE bits: which field of which held frame presents, and whether the signal's frame is interlaced. */
    fieldState: number
    geometry: TexturePresentationGeometry
    /** True advances history; false redraws the same frame. */
    newFrame: boolean
    /** Frames dropped since the previous new frame. */
    skippedFrameCount: number
    /**
     * The frame's source, or null to draw from history alone, as a deinterlaced frame's second field does once its source was released.
     * A draw from history skips the passes that read the source, so it needs a plan whose source passes write only history, and it redraws the last new frame.
     */
    source: PresentationFrameSource | null
    target: GPUTextureView
    timestampMicroseconds: number
};
