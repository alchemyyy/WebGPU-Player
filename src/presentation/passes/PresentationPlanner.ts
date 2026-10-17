// Builds presentation plans: it arranges a route's built-in chain and the user passes on the spatial spine and the color track, then generates each pass's WGSL.
// The Presentation section of docs/src/architecture.md and docs/src/new-pass.md describe the rules it implements.
import {
    DEFAULT_MAXIMUM_TEXTURE_DIMENSION_3D,
    FLOAT32_FILTERABLE_FEATURE,
    FLOAT32_TEXTURE_FORMATS,
    INTERMEDIATE_TEXTURE_FORMAT,
    MAXIMUM_WORKGROUP_COUNT,
    WORKGROUP_AXIS_NAMES
} from '../WebGPUConstants';
import { toWGSLFloat } from './builtin/BuiltinWGSL';
import { evaluatePassExpression, PassExpressionError } from './PassExpression';
import {
    collectTopLevelDeclarations,
    collectUndeclaredReferences,
    createComputeStageWGSL,
    createConstantsWGSL,
    createFragmentStageWGSL,
    createLinearLightPreludeWGSL,
    createPlaneTransformPreludeWGSL,
    createParametersWGSL,
    createPassTextureAccessorsWGSL,
    createStorageTargetWGSL,
    createTextureAccessorsWGSL,
    FRAGMENT_COORDINATE,
    FRAGMENT_POSITION,
    FRAGMENT_TARGET_COORDINATE,
    renameWGSLIdentifiers,
    ShaderModuleBuilder,
    VERTEX_STAGE_WGSL
} from './PassPrelude';
import {
    CHROMA_STAGE,
    ENTRY_POINTS,
    getAccessorPrefix,
    GLOBAL_FACTS,
    HEIGHT_SUFFIX,
    HOOKED_INPUT_NAME,
    IMAGE_STAGES,
    LINEAR_LIGHT_PRELUDE_FUNCTIONS,
    LUMA_STAGE,
    NATIVE_STAGE,
    PARAMETERS_VARIABLE,
    PASS_TEXTURE_ACCESSOR_SUFFIXES,
    PLANE_STAGES,
    PLANE_TRANSFORM_PRELUDE_FUNCTIONS,
    TEXTURE_AXIS_NAMES,
    STAGE_ORDER,
    TARGET_ACCESSOR_PREFIX,
    WIDTH_SUFFIX
} from './PassLanguage';
import {
    createEngineBindingWGSL,
    createEngineStructsWGSL,
    createPresentationBindingWGSL,
    expandEngineResource,
    normalizePassParameterValue,
    PRESENTATION_UNIFORMS_WGSL
} from './PassResources';
import {
    createDeinterlaceWGSL,
    DEINTERLACE_ENTRY_POINT,
    DEINTERLACE_HISTORY_DEPTH,
    DEINTERLACE_SIGNAL_INPUT_NAME
} from './builtin/DeinterlacePass';
import type {
    BuiltinChain,
    BuiltinColorFunction,
    ColorDomain,
    ColorState,
    DeinterlaceRequest,
    EngineBindingResource,
    EngineResource,
    PassCoordinateMapping,
    PassExpression,
    PassExpressionFacts,
    PassInput,
    PassManifest,
    PassOutput,
    PassParameter,
    PassTexture,
    PassRejection,
    PassRejectionReason,
    PassWorkgroup,
    PlanDevice,
    PlanFacts,
    PlannedBinding,
    PlannedPass,
    PlannedPassTexture,
    PlannedTexture,
    PlanRequest,
    PresentationPlan,
    PresentationStage,
    SignalPlanes
} from './PassTypes';

const STAGE_NAMES: ReadonlySet<string> = new Set<string>(STAGE_ORDER);
const PLANE_STAGE_NAMES: ReadonlySet<string> = new Set<string>(PLANE_STAGES);

const SIGNAL_TEXTURE_ID = 'signal';
// The plane images a signal's planes are read apart into, and the image its merge converts them into
const LUMA_PLANE_TEXTURE_ID = 'plane:luma';
const CHROMA_PLANE_TEXTURE_ID = 'plane:chroma';
const NATIVE_PLANE_TEXTURE_ID = 'plane:native';
const MERGE_TEXTURE_ID = 'merge';
// The accessors of the plane images a merge reads, and of the RGB image planes derive from in a deinterlacing plan
const LUMA_INPUT_PREFIX = 'planeLuma';
const CHROMA_INPUT_PREFIX = 'planeChroma';
const NATIVE_INPUT_PREFIX = 'planeNative';
const PLANE_IMAGE_INPUT_PREFIX = 'planeImage';
// The merge function a plane merge pass generates around the signal's plane functions
const MERGE_ENTRY_POINT = 'mergeSignalPlanes';
const ZERO_OFFSET: Offset = Object.freeze([ 0, 0 ]);
const UNIT_SCALE: Offset = Object.freeze([ 1, 1 ]);
// The subsampling divisor of chroma at luma's size, as a signal without planes has
const FULL_RESOLUTION_DIVISOR = 1;
const DEINTERLACE_TEXTURE_ID = 'deinterlace';
const SCALE_TEXTURE_ID = 'scale';
const PASS_TEXTURE_ID_PREFIX = 'pass:';
const COPY_TEXTURE_ID_PREFIX = 'copy:';
const USER_IDENTIFIER_PREFIX = 'user';
// The accessors of the one texture a built-in pass reads
const ENGINE_INPUT_PREFIX = 'engineInput';
// PassResources declares the linear sampler under this name
const SAMPLER_VARIABLE = 'videoSampler';

const LABEL_PREFIX = 'Presentation';
const SIGNAL_LABEL = `${LABEL_PREFIX} signal`;
const LUMA_PLANE_LABEL = `${LABEL_PREFIX} luma plane`;
const CHROMA_PLANE_LABEL = `${LABEL_PREFIX} chroma plane`;
const NATIVE_LABEL = `${LABEL_PREFIX} native`;
const MERGE_LABEL = `${LABEL_PREFIX} merge`;
const DEINTERLACE_LABEL = `${LABEL_PREFIX} deinterlace`;
const SCALE_LABEL = `${LABEL_PREFIX} scale`;
const COLOR_LABEL = `${LABEL_PREFIX} color`;
const OUTPUT_LABEL = `${LABEL_PREFIX} output`;

const PRESENTATION_BINDING = 0;

// A texture block of three dimensions, which the device's 3D limit bounds
const THREE_DIMENSIONS = 3;

/** A user pass that survived its condition, with the prefix that keeps its identifiers apart from other code in a module. */
type ActivePass = {
    manifest: PassManifest
    prefix: string
};

type ColorStep =
    | { colorFunction: BuiltinColorFunction; kind: 'builtin' }
    | { kind: 'user'; pass: ActivePass };

/** One position of the color track: the step that runs there and the color state it leaves. */
type TrackEntry = {
    name: string
    outputState: ColorState
    pinnedToOutput: boolean
    step: ColorStep
};

type InputSource =
    | { kind: 'stage-history'; stage: PresentationStage }
    | { kind: 'texture'; textureId: string };

type DraftInput = {
    accessorPrefix: string
    historyOffset: number
    /** The offset of the texture it reads, in that texture's pixels; known once the input resolves to a texture */
    offset: Offset
    source: InputSource
};

/** An offset in an image's own pixels, or a shift in normalized coordinates, x then y. */
type Offset = readonly [number, number];

/**
 * Where plane reads read the planes: the signal's own reads of the source, or, in a deinterlacing plan, the deinterlaced RGB image,
 * which the signal's transform turns back into planes.
 */
type PlaneSource = 'image' | 'signal';

/** Where a plane merge reads each component: an input's accessor prefix, or null for the signal's own plane read from the source. */
type PlaneMerge = {
    chromaPrefix: string | null
    /** The chroma image's extent over its size: the scale from the reference grid to its normalized coordinates */
    chromaScale: Offset
    /** The chroma image's offset over its size: the shift from the reference grid to its normalized coordinates */
    chromaShift: Offset
    /** The merged grid's offset over its size: the shift from the reference grid to its normalized coordinates */
    gridShift: Offset
    lumaPrefix: string | null
    /** The NATIVE image's accessor prefix; when set, it holds every component */
    nativePrefix: string | null
    /** Whether the merge writes NATIVE's normalized Y, Cb, and Cr rather than converting them to 'source' RGB */
    writesNative: boolean
};

/**
 * What a pass computes before its color steps.
 * - 'deinterlace': the built-in deinterlacing pass over the signal's history, at the stream's bit depth.
 * - 'signal': the route's signal, read from the source at the pass's coordinate.
 * - 'plane-read': one of the signal's planes, read on its own grid as normalized codes, its target coordinate scaled onto the reference grid's extent.
 * - 'plane-merge': the signal's planes, from plane images or their source, merged on one grid and converted as the signal converts.
 * - 'sample': a bilinear read of the pass's one input texture.
 * - 'user': a user kernel, scaler, or compute body.
 */
type DraftCore =
    | { bitDepth: number; kind: 'deinterlace' }
    | { kind: 'plane-merge'; merge: PlaneMerge; source: PlaneSource }
    | { kind: 'plane-read'; plane: 'chroma' | 'luma'; scale: Offset; source: PlaneSource }
    | { kind: 'sample' }
    | { kind: 'signal' }
    | { kind: 'user'; pass: ActivePass };

/**
 * A plane stage's image: its size, offset, and extent on the reference grid, the texture that holds it once one does, and whether a pass replaced
 * the signal's own plane, which the merge then reads from the texture rather than from the source.
 */
type PlaneImage = {
    extent: Offset
    offset: Offset
    replaced: boolean
    size: Size
    textureId: string | null
};

/**
 * The size, offset, and extent of the image a pass hooks: the reference grid maps onto the image's pixels as offset + coordinate * extent,
 * as libplacebo's texture rects place them; the extent is the size but for chroma, whose rect is luma's over the subsampling divisor.
 */
type HookedImage = {
    extent: Offset
    offset: Offset
    size: Size
};

type DraftPass = {
    core: DraftCore
    coordinateMapping: PassCoordinateMapping
    /** A normalized shift of the coordinate the core reads at: a scaler's correction of its image's offset */
    coordinateShift: Offset
    /** The texture that fills `presentation.inputSize`, or null when the pass reads the source. */
    hookedTextureId: string | null
    inputs: DraftInput[]
    kind: 'compute' | 'render'
    label: string
    postSteps: ColorStep[]
    /** A pass read this output as it was, so a later color step runs in a pass of its own. */
    sealed: boolean
    /** The texture it writes; null while a render pass's target is open, and once it writes the output. */
    targetTextureId: string | null
    workgroupCounts: readonly [number, number, number] | null
    writesOutput: boolean
};

type DraftPassOptions = Pick<DraftPass, 'core' | 'coordinateMapping' | 'hookedTextureId' | 'inputs' | 'label' | 'targetTextureId'>
    & Partial<Pick<DraftPass, 'coordinateShift' | 'kind' | 'postSteps' | 'workgroupCounts'>>;

type Size = { height: number; width: number };

/** A planned texture while the plan is built, whose history depth grows with the reads that resolve to it. */
type DraftTexture = { -readonly [Key in keyof PlannedTexture]: PlannedTexture[Key] };

/** The check a pass failed, with a terse detail; the planner reports it and plans without the pass. */
class PassPlacementError extends Error {
    readonly detail: string;
    readonly reason: PassRejectionReason;

    constructor(reason: PassRejectionReason, detail: string) {
        super(`${reason}: ${detail}`);
        this.name = 'PassPlacementError';
        this.detail = detail;
        this.reason = reason;
    }
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isStage(name: string): name is PresentationStage {
    return STAGE_NAMES.has(name);
}

function isPlaneStage(name: string | null): name is PresentationStage {
    return name !== null && PLANE_STAGE_NAMES.has(name);
}

function compareStages(first: PresentationStage, second: PresentationStage): number {
    return STAGE_ORDER.indexOf(first) - STAGE_ORDER.indexOf(second);
}

function createEngineInput(textureId: string, accessorPrefix: string = ENGINE_INPUT_PREFIX): DraftInput {
    return { accessorPrefix, historyOffset: 0, offset: ZERO_OFFSET, source: { kind: 'texture', textureId } };
}

/** Returns the luma plane's size: the frame's visible size in samples. */
function getLumaSize(facts: PlanFacts): Size {
    return { height: facts.sampleHeight, width: facts.sampleWidth };
}

/**
 * Returns the chroma plane's extent: luma's over the signal's subsampling divisors, or luma's without planes.
 * As libplacebo sizes a subsampled plane's rect, an odd luma size leaves the extent half a chroma pixel short of the plane, which keeps chroma's scale exact.
 */
function getChromaExtent(facts: PlanFacts, planes: SignalPlanes | null): Offset {
    return [
        facts.sampleWidth / (planes?.chromaWidthDivisor ?? FULL_RESOLUTION_DIVISOR),
        facts.sampleHeight / (planes?.chromaHeightDivisor ?? FULL_RESOLUTION_DIVISOR)
    ];
}

/** Returns the chroma plane's size: its extent rounded up to whole pixels. */
function getChromaSize(facts: PlanFacts, planes: SignalPlanes | null): Size {
    const extent = getChromaExtent(facts, planes);
    return { height: Math.ceil(extent[1]), width: Math.ceil(extent[0]) };
}

/** Returns the extent of an image whose size is its rect's, as every image but chroma's is. */
function getSizeExtent(size: Size): Offset {
    return [ size.width, size.height ];
}

/** Returns an offset over a size: the normalized shift from the reference grid to an image's normalized coordinates. */
function getNormalizedShift(offset: Offset, size: Size): Offset {
    return [ offset[0] / size.width, offset[1] / size.height ];
}

/** Returns an extent over a size: the scale from the reference grid's normalized coordinates to an image's. */
function getNormalizedScale(extent: Offset, size: Size): Offset {
    return [ extent[0] / size.width, extent[1] / size.height ];
}

function isUnitScale(scale: Offset): boolean {
    return scale[0] === 1 && scale[1] === 1;
}

function isZeroOffset(offset: Offset): boolean {
    return offset[0] === 0 && offset[1] === 0;
}

/** Returns the WGSL vec2f of an offset or shift. */
function toWGSLVector(offset: Offset): string {
    return `vec2f(${toWGSLFloat(offset[0])}, ${toWGSLFloat(offset[1])})`;
}

/**
 * Returns the offset of a pass's output, as libplacebo places an mpv pass's output rect:
 * the hooked image's offset scaled by the output's size over the hooked image's, plus the declared offset, or the reference grid's origin under align.
 */
function getOutputOffset(manifest: PassManifest, hooked: HookedImage, size: Size): Offset {
    const declared = manifest.offset;
    if (declared?.kind === 'align') {
        return ZERO_OFFSET;
    }
    const declaredX = declared?.kind === 'pixels' ? declared.x : 0;
    const declaredY = declared?.kind === 'pixels' ? declared.y : 0;
    return [
        (size.width / hooked.size.width) * hooked.offset[0] + declaredX,
        (size.height / hooked.size.height) * hooked.offset[1] + declaredY
    ];
}

/**
 * Returns the extent of a pass's output, as libplacebo scales an mpv pass's output rect: the hooked image's extent scaled by the output's size over the hooked image's.
 * An aligned output moves its rect, not its extent.
 */
function getOutputExtent(hooked: HookedImage, size: Size): Offset {
    return [ (size.width / hooked.size.width) * hooked.extent[0], (size.height / hooked.size.height) * hooked.extent[1] ];
}

function createGlobalFacts(facts: PlanFacts, planes: SignalPlanes | null): Map<string, number> {
    const chromaSize = getChromaSize(facts, planes);
    return new Map<string, number>([
        [ GLOBAL_FACTS.sourceWidth, facts.sourceWidth ],
        [ GLOBAL_FACTS.sourceHeight, facts.sourceHeight ],
        [ GLOBAL_FACTS.outputWidth, facts.outputWidth ],
        [ GLOBAL_FACTS.outputHeight, facts.outputHeight ],
        [ GLOBAL_FACTS.lumaWidth, facts.sampleWidth ],
        [ GLOBAL_FACTS.lumaHeight, facts.sampleHeight ],
        [ GLOBAL_FACTS.chromaWidth, chromaSize.width ],
        [ GLOBAL_FACTS.chromaHeight, chromaSize.height ],
        [ GLOBAL_FACTS.frameRate, facts.frameRate ?? 0 ],
        [ GLOBAL_FACTS.hdrSource, facts.hdrSource ? 1 : 0 ],
        [ GLOBAL_FACTS.hdrOutput, facts.hdrOutput ? 1 : 0 ],
        [ GLOBAL_FACTS.rgbSource, planes?.rgb === true ? 1 : 0 ]
    ]);
}

/**
 * Returns the device check a texture block fails, or null: an extent beyond the device's largest texture of the block's dimensions ('texture-size'),
 * or a 32-bit float format that a linear filter needs filterable where the device cannot filter it ('texture-format').
 */
function getPassTextureFailure(texture: PassTexture, device: PlanDevice): Omit<PassRejection, 'name'> | null {
    const maximumDimension = texture.dimensions === THREE_DIMENSIONS ?
        device.maximumTextureDimension3D ?? DEFAULT_MAXIMUM_TEXTURE_DIMENSION_3D :
        device.maximumTextureDimension;
    for (let axisIndex = 0; axisIndex < texture.dimensions; axisIndex += 1) {
        const extent = texture.size[axisIndex];
        if (extent > maximumDimension) {
            return { detail: `'${texture.name}' ${TEXTURE_AXIS_NAMES[axisIndex]} ${extent} outside [1, ${maximumDimension}]`, reason: 'texture-size' };
        }
    }
    if (texture.filter === 'linear' && FLOAT32_TEXTURE_FORMATS.has(texture.format) && !device.features.has(FLOAT32_FILTERABLE_FEATURE)) {
        return { detail: `'${texture.name}' ${texture.format} is not filterable without ${FLOAT32_FILTERABLE_FEATURE}`, reason: 'texture-format' };
    }
    return null;
}

/** Returns a parameter's current value in its type and range, as the uniform holds it: the request's value, else its default. */
function getParameterValue(request: PlanRequest, passName: string, parameter: PassParameter): number {
    const value = normalizePassParameterValue(parameter, request.parameterValues?.get(passName)?.get(parameter.name) ?? parameter.defaultValue);
    return parameter.type === 'f32' ? Math.fround(value) : value;
}

function setSizeFacts(facts: Map<string, number>, name: string, size: Size): void {
    facts.set(name + WIDTH_SUFFIX, size.width);
    facts.set(name + HEIGHT_SUFFIX, size.height);
}

/** Evaluates an expression; an evaluation failure fails the check that needed the value. */
function evaluateExpression(expression: PassExpression, facts: PassExpressionFacts, reason: PassRejectionReason): number {
    try {
        return evaluatePassExpression(expression, facts);
    } catch (error) {
        if (error instanceof PassExpressionError) {
            throw new PassPlacementError(reason, error.message);
        }
        throw error;
    }
}

function evaluateDimension(expression: PassExpression, facts: PassExpressionFacts, maximumDimension: number, axis: string): number {
    const value = Math.round(evaluateExpression(expression, facts, 'output-size'));
    if (value < 1 || value > maximumDimension) {
        throw new PassPlacementError('output-size', `${axis} ${value} outside [1, ${maximumDimension}]`);
    }
    return value;
}

function evaluateWorkgroupCounts(workgroup: PassWorkgroup, facts: PassExpressionFacts): readonly [number, number, number] {
    const counts = workgroup.dispatch.map((expression: PassExpression, axisIndex: number): number => {
        const count = Math.ceil(evaluateExpression(expression, facts, 'workgroup-count'));
        if (count < 1 || count > MAXIMUM_WORKGROUP_COUNT) {
            throw new PassPlacementError('workgroup-count', `${WORKGROUP_AXIS_NAMES[axisIndex]} ${count} outside [1, ${MAXIMUM_WORKGROUP_COUNT}]`);
        }
        return count;
    });
    return [ counts[0], counts[1], counts[2] ];
}

function requireTexture(textures: ReadonlyMap<string, DraftTexture>, textureId: string): DraftTexture {
    const texture = textures.get(textureId);
    if (!texture) {
        throw new Error(`The plan has no texture '${textureId}'`);
    }
    return texture;
}

function requireOutput(manifest: PassManifest): PassOutput {
    if (!manifest.output) {
        throw new PassPlacementError('output-missing', manifest.shape);
    }
    return manifest.output;
}

/** Rejects a compute pass that names its own storage target's prefix as an input. */
function requireUnreservedInputs(manifest: PassManifest): void {
    if (manifest.shape === 'compute' && manifest.inputs.some((input: PassInput): boolean => input.name === TARGET_ACCESSOR_PREFIX)) {
        throw new PassPlacementError('input-reserved', TARGET_ACCESSOR_PREFIX);
    }
}

function createBuiltinTrackEntry(colorFunction: BuiltinColorFunction): TrackEntry {
    return {
        name: colorFunction.name,
        outputState: colorFunction.outputState,
        pinnedToOutput: colorFunction.pinnedToOutput,
        step: { colorFunction, kind: 'builtin' }
    };
}

/** Returns the stages that passes read by name, whose final images must therefore exist as textures. */
function collectNamedStages(passes: readonly ActivePass[]): Set<PresentationStage> {
    const stages = new Set<PresentationStage>();
    for (const pass of passes) {
        for (const input of pass.manifest.inputs) {
            if (isStage(input.name)) {
                stages.add(input.name);
            }
        }
    }
    return stages;
}

/** Walks the spine and the color track for one request and records the passes, textures, and report of its plan. */
class PresentationPlanBuilder {
    private readonly activePasses = new Set<ActivePass>();
    private readonly drafts: DraftPass[] = [];
    private readonly facts: Map<string, number>;
    private readonly inactivePasses: PassRejection[] = [];
    private readonly initialState: ColorState;
    private readonly request: PlanRequest;
    // Each plane stage's image as it is when the stage ends, which later passes read by the stage's name
    private readonly finalPlaneImages = new Map<PresentationStage, PlaneImage>();
    private readonly planeImages = new Map<PresentationStage, PlaneImage>();
    private readonly savedTextures = new Map<string, string>();
    private readonly stageTextures = new Map<PresentationStage, string>();
    // Every planned texture's offset in its own pixels
    private readonly textureOffsets = new Map<string, Offset>();
    private readonly textures = new Map<string, DraftTexture>();
    private copyCount = 0;
    private deinterlace: DeinterlaceRequest | null = null;
    // The producer of the spine's current image; null while that image is the signal, which no pass has read yet
    private current: DraftPass | null = null;
    // The offset of the spine's current image in its own pixels
    private currentOffset: Offset = ZERO_OFFSET;
    // Why plane stages cannot run, or null while they can
    private planesUnavailable: string | null = null;
    // Track entries before the cursor have run
    private cursor = 0;
    private namedStages: ReadonlySet<PresentationStage> = new Set<PresentationStage>();
    // Color steps on the signal before any pass reads it
    private signalSteps: ColorStep[] = [];
    private track: TrackEntry[] = [];

    constructor(request: PlanRequest) {
        this.request = request;
        this.facts = createGlobalFacts(request.facts, request.chain.signal.planes);
        this.initialState = request.chain.sourceIsDisplay ? 'display' : 'source';
    }

    build(): PresentationPlan {
        const candidates = this.selectPasses();
        const walkedPasses = this.createTrack(candidates);
        this.namedStages = collectNamedStages(walkedPasses);
        const deinterlace = this.request.deinterlace ?? null;
        // A signal with a bypass skips the color track in the pass that reads it, which a deinterlaced signal never reaches
        if (deinterlace !== null && this.request.chain.signal.bypassCondition === null) {
            this.placeDeinterlace(deinterlace);
            this.deinterlace = deinterlace;
        }
        this.placePlanes(walkedPasses);
        for (const stage of IMAGE_STAGES) {
            this.placeStage(stage, walkedPasses);
        }
        this.placeOutput();
        this.resolveInputs();
        return this.createPlan(candidates);
    }

    private reject(name: string, reason: PassRejectionReason, detail: string): void {
        this.inactivePasses.push({ detail, name, reason });
    }

    /** Returns the passes whose conditions hold, rejecting duplicate names and SDR passes on an HDR output. */
    private selectPasses(): ActivePass[] {
        const names = new Set<string>();
        const candidates: ActivePass[] = [];
        for (let index = 0; index < this.request.passes.length; index += 1) {
            const manifest = this.request.passes[index];
            if (names.has(manifest.name)) {
                this.reject(manifest.name, 'duplicate-name', `position ${index + 1}`);
                continue;
            }
            names.add(manifest.name);
            if (this.isSelectable(manifest)) {
                candidates.push({ manifest, prefix: `${USER_IDENTIFIER_PREFIX}${index}_` });
            }
        }
        return candidates;
    }

    private isSelectable(manifest: PassManifest): boolean {
        if (manifest.domain === 'sdr' && this.request.facts.hdrOutput) {
            this.reject(manifest.name, 'sdr-on-hdr-output', manifest.domain);
            return false;
        }
        // The prelude's plane transform and linear light come from the chain, which may lack them
        const signal = this.request.chain.signal;
        if (signal.planes === null && collectUndeclaredReferences(manifest.body, PLANE_TRANSFORM_PRELUDE_FUNCTIONS).size > 0) {
            this.reject(manifest.name, 'planes-unavailable', signal.name);
            return false;
        }
        if (this.request.chain.linearLight === null && collectUndeclaredReferences(manifest.body, LINEAR_LIGHT_PRELUDE_FUNCTIONS).size > 0) {
            this.reject(manifest.name, 'linear-light-unavailable', signal.name);
            return false;
        }
        for (const texture of manifest.textures) {
            const failure = getPassTextureFailure(texture, this.request.device);
            if (failure !== null) {
                this.reject(manifest.name, failure.reason, failure.detail);
                return false;
            }
        }
        if (manifest.when === null) {
            return true;
        }
        // The condition reads the pass's own parameters and constants beside the global facts
        const conditionFacts = new Map<string, number>(this.facts);
        for (const parameter of [ ...manifest.parameters, ...manifest.constants ]) {
            conditionFacts.set(parameter.name, getParameterValue(this.request, manifest.name, parameter));
        }
        try {
            if (evaluatePassExpression(manifest.when, conditionFacts) !== 0) {
                return true;
            }
            this.reject(manifest.name, 'condition-false', '');
        } catch (error) {
            this.reject(manifest.name, 'condition-invalid', getErrorMessage(error));
        }
        return false;
    }

    /** Builds the color track from the chain's functions with replacements in place; returns the passes the spine walk places. */
    private createTrack(candidates: readonly ActivePass[]): ActivePass[] {
        this.track = this.request.chain.colorFunctions.map(createBuiltinTrackEntry);
        // The pass that replaced each built-in function
        const replacingPasses = new Map<string, string>();
        const walkedPasses: ActivePass[] = [];
        for (const pass of candidates) {
            const replacedName = pass.manifest.replaces;
            if (replacedName === null) {
                walkedPasses.push(pass);
                continue;
            }
            const entryIndex = this.track.findIndex((entry: TrackEntry): boolean => entry.name === replacedName);
            const replacingPass = replacingPasses.get(replacedName);
            if (entryIndex < 0) {
                this.reject(pass.manifest.name, 'replaced-function-missing', replacedName);
            } else if (replacingPass !== undefined) {
                this.reject(pass.manifest.name, 'replaced-function-taken', `${replacedName} by '${replacingPass}'`);
            } else {
                replacingPasses.set(replacedName, pass.manifest.name);
                this.track[entryIndex] = { ...this.track[entryIndex], step: { kind: 'user', pass } };
                this.activePasses.add(pass);
            }
        }
        return walkedPasses;
    }

    /**
     * Places the deinterlacing pass before every stage: the signal becomes a ring of the frame's visible size, which the pass reads at the history
     * depth it needs, and its output at that size is the spine's current image, which user passes, the scaler, and the color track take from there.
     */
    private placeDeinterlace(deinterlace: DeinterlaceRequest): void {
        const maximumDimension = this.request.device.maximumTextureDimension;
        const frameSize: Size = { height: deinterlace.frameHeight, width: deinterlace.frameWidth };
        for (const [ axis, value ] of [ [ 'width', frameSize.width ], [ 'height', frameSize.height ] ] as const) {
            if (!Number.isSafeInteger(value) || value < 1 || value > maximumDimension) {
                throw new RangeError(`deinterlace-size: frame ${axis} ${value} outside [1, ${maximumDimension}]`);
            }
        }
        this.addTexture(SIGNAL_TEXTURE_ID, frameSize, INTERMEDIATE_TEXTURE_FORMAT, false);
        this.pushDraft({
            core: { kind: 'signal' },
            coordinateMapping: 'identity',
            hookedTextureId: null,
            inputs: [],
            label: SIGNAL_LABEL,
            postSteps: this.signalSteps,
            targetTextureId: SIGNAL_TEXTURE_ID
        });
        this.signalSteps = [];
        const inputs: DraftInput[] = [];
        for (let historyOffset = 0; historyOffset >= -DEINTERLACE_HISTORY_DEPTH; historyOffset -= 1) {
            inputs.push({
                accessorPrefix: getAccessorPrefix({ historyOffset, name: DEINTERLACE_SIGNAL_INPUT_NAME }),
                historyOffset,
                offset: ZERO_OFFSET,
                source: { kind: 'texture', textureId: SIGNAL_TEXTURE_ID }
            });
        }
        this.addTexture(DEINTERLACE_TEXTURE_ID, frameSize, INTERMEDIATE_TEXTURE_FORMAT, false);
        this.current = this.pushDraft({
            core: { bitDepth: deinterlace.bitDepth, kind: 'deinterlace' },
            coordinateMapping: 'identity',
            hookedTextureId: SIGNAL_TEXTURE_ID,
            inputs,
            label: DEINTERLACE_LABEL,
            targetTextureId: DEINTERLACE_TEXTURE_ID
        });
    }

    /**
     * Places the plane stages before the image stages, when a pass hooks or reads one.
     * A plane is read apart from its source only when a pass reads it, and when a pass replaced a plane, the merge converts the planes into the
     * spine's first image, reading each plane a pass left untouched from its source, so it converts exactly as the signal does.
     * The source is the signal's own reads, or in a deinterlacing plan the deinterlaced image, whose planes the signal's transform derives.
     */
    private placePlanes(passes: readonly ActivePass[]): void {
        const planePasses = passes.filter((pass: ActivePass): boolean => isPlaneStage(pass.manifest.hook));
        const readsPlanes = PLANE_STAGES.some((stage: PresentationStage): boolean => this.namedStages.has(stage));
        if (planePasses.length === 0 && !readsPlanes) {
            return;
        }
        const planes = this.request.chain.signal.planes;
        if (planes === null) {
            // A signal without planes, as Dolby Vision reconstruction is, names itself
            this.planesUnavailable = this.request.chain.signal.name;
            for (const pass of planePasses) {
                this.reject(pass.manifest.name, 'planes-unavailable', this.planesUnavailable);
            }
            return;
        }
        const lumaSize = getLumaSize(this.request.facts);
        this.planeImages.set(LUMA_STAGE, { extent: getSizeExtent(lumaSize), offset: ZERO_OFFSET, replaced: false, size: lumaSize, textureId: null });
        this.planeImages.set(CHROMA_STAGE, {
            extent: getChromaExtent(this.request.facts, planes),
            offset: planes.chromaOffset,
            replaced: false,
            size: getChromaSize(this.request.facts, planes),
            textureId: null
        });
        for (const stage of PLANE_STAGES) {
            const stagePasses = planePasses.filter((pass: ActivePass): boolean => pass.manifest.hook === stage);
            if (stage === NATIVE_STAGE && (stagePasses.length > 0 || this.namedStages.has(stage))) {
                this.placeNative(planes);
            }
            for (const pass of stagePasses) {
                this.tryPlace(pass, (): void => this.placePlanePass(pass, stage));
            }
            // A later read makes the stage's final image a texture, so a reader the plan leaves out reads no plane apart
            const finalImage = this.planeImages.get(stage);
            if (finalImage !== undefined) {
                this.finalPlaneImages.set(stage, finalImage);
            }
        }
        this.placeMerge();
    }

    /** Returns where plane reads read the planes: the deinterlaced image in a deinterlacing plan, else the signal's own reads of the source. */
    private getPlaneSource(): PlaneSource {
        return this.deinterlace === null ? 'signal' : 'image';
    }

    /** Returns the inputs and hooked texture of a pass that reads the planes' source: the deinterlaced image, or the source itself, which binds no input. */
    private getPlaneSourceBinding(): { hookedTextureId: string | null; inputs: DraftInput[] } {
        if (this.getPlaneSource() === 'signal') {
            return { hookedTextureId: null, inputs: [] };
        }
        return { hookedTextureId: DEINTERLACE_TEXTURE_ID, inputs: [ createEngineInput(DEINTERLACE_TEXTURE_ID, PLANE_IMAGE_INPUT_PREFIX) ] };
    }

    /** Returns a plane stage's image; the plane stages hold one each once placePlanes starts. */
    private requirePlaneImage(stage: PresentationStage): PlaneImage {
        const image = this.planeImages.get(stage);
        if (image === undefined) {
            throw new Error(`The ${stage} stage has no image`);
        }
        return image;
    }

    /** Places a kernel or compute pass on a plane stage: it reads and writes planes, so it runs before the color track and takes no domain. */
    private placePlanePass(pass: ActivePass, stage: PresentationStage): void {
        const manifest = pass.manifest;
        requireUnreservedInputs(manifest);
        if (manifest.domain !== 'any') {
            throw new PassPlacementError('domain-unreachable', `${manifest.domain} at ${stage}`);
        }
        const hooked = this.getHookedImage(stage);
        const { output, size, workgroupCounts } = this.evaluateOutput(pass, stage);
        // Every check has passed, so the plan changes from here
        const hookedTextureId = this.materializePlane(stage);
        const textureId = `${PASS_TEXTURE_ID_PREFIX}${manifest.name}`;
        const offset = getOutputOffset(manifest, hooked, size);
        this.addTexture(textureId, size, output.format, manifest.shape === 'compute', offset);
        this.pushDraft({
            core: { kind: 'user', pass },
            coordinateMapping: 'identity',
            hookedTextureId,
            inputs: this.createInputs(pass, stage, hookedTextureId),
            kind: manifest.shape === 'compute' ? 'compute' : 'render',
            label: `${LABEL_PREFIX} pass '${manifest.name}'`,
            targetTextureId: textureId,
            workgroupCounts
        });
        if (manifest.save !== null) {
            this.savedTextures.set(manifest.save, textureId);
            return;
        }
        this.planeImages.set(stage, { extent: getOutputExtent(hooked, size), offset, replaced: true, size, textureId });
    }

    /** Makes a plane stage's current image a texture and returns it: a plane no pass replaced is read apart from its source at its own size. */
    private materializePlane(stage: PresentationStage): string {
        return this.materializePlaneImage(stage, this.requirePlaneImage(stage));
    }

    private materializePlaneImage(stage: PresentationStage, image: PlaneImage): string {
        if (image.textureId !== null) {
            return image.textureId;
        }
        const planes = this.requirePlanes();
        const isLuma = stage === LUMA_STAGE;
        const textureId = isLuma ? LUMA_PLANE_TEXTURE_ID : CHROMA_PLANE_TEXTURE_ID;
        this.addTexture(textureId, image.size, isLuma ? planes.lumaFormat : planes.chromaFormat, false, image.offset);
        this.pushDraft({
            // The plane covers its extent of the reference grid, so a target coordinate scales by its size over its extent
            core: {
                kind: 'plane-read',
                plane: isLuma ? 'luma' : 'chroma',
                scale: getNormalizedScale(getSizeExtent(image.size), { height: image.extent[1], width: image.extent[0] }),
                source: this.getPlaneSource()
            },
            coordinateMapping: 'identity',
            ...this.getPlaneSourceBinding(),
            label: isLuma ? LUMA_PLANE_LABEL : CHROMA_PLANE_LABEL,
            targetTextureId: textureId
        });
        image.textureId = textureId;
        return textureId;
    }

    private requirePlanes(): SignalPlanes {
        const planes = this.request.chain.signal.planes;
        if (planes === null) {
            throw new Error(`Signal '${this.request.chain.signal.name}' has no planes`);
        }
        return planes;
    }

    /** Merges the luma and chroma images into NATIVE's normalized Y, Cb, and Cr, on luma's grid. */
    private placeNative(planes: SignalPlanes): void {
        const grid = this.getMergeGrid();
        this.createMergeDraft(NATIVE_PLANE_TEXTURE_ID, planes.nativeFormat, true, NATIVE_LABEL);
        this.planeImages.set(NATIVE_STAGE, { ...grid, replaced: false, textureId: NATIVE_PLANE_TEXTURE_ID });
    }

    /**
     * Converts the planes into the spine's first image when a pass replaced one, as the signal converts them: from NATIVE when a pass replaced it,
     * else from luma's grid, with chroma resampled onto it through both images' offsets and extents.
     * The image keeps the grid's offset, which the scaler corrects.
     */
    private placeMerge(): void {
        const native = this.planeImages.get(NATIVE_STAGE);
        const replaced = PLANE_STAGES.some((stage: PresentationStage): boolean => this.planeImages.get(stage)?.replaced === true);
        if (!replaced) {
            return;
        }
        this.current = this.createMergeDraft(MERGE_TEXTURE_ID, INTERMEDIATE_TEXTURE_FORMAT, false, MERGE_LABEL);
        this.current.postSteps.push(...this.signalSteps);
        this.signalSteps = [];
        this.currentOffset = native?.replaced === true ? native.offset : this.getMergeGrid().offset;
    }

    /** Returns the grid the planes merge onto: luma's image once a pass replaced it, else the frame's own luma. */
    private getMergeGrid(): HookedImage {
        const luma = this.requirePlaneImage(LUMA_STAGE);
        if (luma.replaced) {
            return { extent: luma.extent, offset: luma.offset, size: luma.size };
        }
        const lumaSize = getLumaSize(this.request.facts);
        return { extent: getSizeExtent(lumaSize), offset: ZERO_OFFSET, size: lumaSize };
    }

    /** Pushes a pass that merges the plane images it needs, and the signal's planes for the rest, into a texture on the merge grid. */
    private createMergeDraft(textureId: string, format: GPUTextureFormat, writesNative: boolean, label: string): DraftPass {
        const native = this.planeImages.get(NATIVE_STAGE);
        const planeSource = this.getPlaneSourceBinding();
        const inputs: DraftInput[] = [ ...planeSource.inputs ];
        let grid: HookedImage;
        let merge: PlaneMerge;
        if (!writesNative && native?.replaced === true && native.textureId !== null) {
            grid = { extent: native.extent, offset: native.offset, size: native.size };
            inputs.push(createEngineInput(native.textureId, NATIVE_INPUT_PREFIX));
            merge = {
                chromaPrefix: null,
                chromaScale: UNIT_SCALE,
                chromaShift: ZERO_OFFSET,
                gridShift: getNormalizedShift(grid.offset, grid.size),
                lumaPrefix: null,
                nativePrefix: NATIVE_INPUT_PREFIX,
                writesNative
            };
        } else {
            grid = this.getMergeGrid();
            const luma = this.requirePlaneImage(LUMA_STAGE);
            const chroma = this.requirePlaneImage(CHROMA_STAGE);
            const lumaTextureId = luma.replaced ? luma.textureId : null;
            const chromaTextureId = chroma.replaced ? chroma.textureId : null;
            if (lumaTextureId !== null) {
                inputs.push(createEngineInput(lumaTextureId, LUMA_INPUT_PREFIX));
            }
            if (chromaTextureId !== null) {
                inputs.push(createEngineInput(chromaTextureId, CHROMA_INPUT_PREFIX));
            }
            merge = {
                chromaPrefix: chromaTextureId === null ? null : CHROMA_INPUT_PREFIX,
                chromaScale: getNormalizedScale(chroma.extent, chroma.size),
                chromaShift: getNormalizedShift(chroma.offset, chroma.size),
                gridShift: getNormalizedShift(grid.offset, grid.size),
                lumaPrefix: lumaTextureId === null ? null : LUMA_INPUT_PREFIX,
                nativePrefix: null,
                writesNative
            };
        }
        this.addTexture(textureId, grid.size, format, false, grid.offset);
        return this.pushDraft({
            core: { kind: 'plane-merge', merge, source: this.getPlaneSource() },
            coordinateMapping: 'identity',
            hookedTextureId: planeSource.hookedTextureId,
            inputs,
            label,
            targetTextureId: textureId
        });
    }

    private placeStage(stage: PresentationStage, passes: readonly ActivePass[]): void {
        const stagePasses = passes.filter((pass: ActivePass): boolean => pass.manifest.hook === stage);
        if (stage === 'SCALE') {
            this.placeScaler(stagePasses.filter((pass: ActivePass): boolean => pass.manifest.shape === 'scaler'));
        }
        for (const pass of stagePasses) {
            switch (pass.manifest.shape) {
                case 'color':
                    this.tryPlace(pass, (): void => this.placeColorPass(pass));
                    break;
                case 'compute':
                case 'kernel':
                    this.tryPlace(pass, (): void => this.placeSpatialPass(pass, stage));
                    break;
                case 'scaler':
                    break;
            }
        }
        this.finishStage(stage);
    }

    /** Places a pass, or reports why it cannot run; returns whether it was placed. */
    private tryPlace(pass: ActivePass, place: () => void): boolean {
        try {
            place();
        } catch (error) {
            if (!(error instanceof PassPlacementError)) {
                throw error;
            }
            this.reject(pass.manifest.name, error.reason, error.detail);
            return false;
        }
        this.activePasses.add(pass);
        return true;
    }

    /** Places the first user scaler that can run, or the built-in bilinear scaler. */
    private placeScaler(scalers: readonly ActivePass[]): void {
        let placedScaler: ActivePass | null = null;
        for (const scaler of scalers) {
            if (placedScaler !== null) {
                this.reject(scaler.manifest.name, 'extra-scaler', `'${placedScaler.manifest.name}' runs`);
            } else if (this.tryPlace(scaler, (): void => this.placeUserScaler(scaler))) {
                placedScaler = scaler;
            }
        }
        if (placedScaler === null) {
            this.placeBuiltinScaler();
        }
    }

    private placeUserScaler(scaler: ActivePass): void {
        const targetCursor = this.findPlacementCursor(scaler.manifest.domain, this.current === null);
        this.createInputFacts(scaler, 'SCALE');
        this.advanceTo(targetCursor);
        const coordinateShift = this.getScalerShift();
        const hookedTextureId = this.materializeCurrent();
        this.current = this.pushDraft({
            core: { kind: 'user', pass: scaler },
            coordinateMapping: 'object-fit',
            coordinateShift,
            hookedTextureId,
            inputs: this.createInputs(scaler, 'SCALE', hookedTextureId),
            label: `${LABEL_PREFIX} pass '${scaler.manifest.name}'`,
            targetTextureId: null
        });
        this.currentOffset = ZERO_OFFSET;
    }

    /** Returns the shift by which a scaler corrects its image's offset, so the image lands on the reference grid that object-fit maps. */
    private getScalerShift(): Offset {
        return getNormalizedShift(this.currentOffset, this.getCurrentImageSize());
    }

    /** The built-in scaler is a bilinear read; over the signal, it fuses into the pass that reads the source. */
    private placeBuiltinScaler(): void {
        if (this.current === null) {
            this.current = this.pushDraft({
                core: { kind: 'signal' },
                coordinateMapping: 'object-fit',
                hookedTextureId: null,
                inputs: [],
                label: SCALE_LABEL,
                postSteps: this.signalSteps,
                targetTextureId: null
            });
            this.signalSteps = [];
            return;
        }
        const coordinateShift = this.getScalerShift();
        const hookedTextureId = this.materializeCurrent();
        this.current = this.pushDraft({
            core: { kind: 'sample' },
            coordinateMapping: 'object-fit',
            coordinateShift,
            hookedTextureId,
            inputs: [ createEngineInput(hookedTextureId) ],
            label: SCALE_LABEL,
            targetTextureId: null
        });
        this.currentOffset = ZERO_OFFSET;
    }

    private placeColorPass(pass: ActivePass): void {
        this.advanceTo(this.findPlacementCursor(pass.manifest.domain, false));
        this.appendStep({ kind: 'user', pass });
    }

    /** Places a kernel or compute pass: it reads textures, so its hooked image is materialized with the color steps its domain needs. */
    private placeSpatialPass(pass: ActivePass, stage: PresentationStage): void {
        const manifest = pass.manifest;
        requireUnreservedInputs(manifest);
        const targetCursor = this.findPlacementCursor(manifest.domain, this.current === null);
        const { output, size, workgroupCounts } = this.evaluateOutput(pass, stage);
        // Every check has passed, so the plan changes from here
        this.advanceTo(targetCursor);
        const hooked = this.getHookedImage(stage);
        const hookedTextureId = this.materializeCurrent();
        const textureId = `${PASS_TEXTURE_ID_PREFIX}${manifest.name}`;
        const offset = getOutputOffset(manifest, hooked, size);
        this.addTexture(textureId, size, output.format, manifest.shape === 'compute', offset);
        const draft = this.pushDraft({
            core: { kind: 'user', pass },
            coordinateMapping: 'identity',
            hookedTextureId,
            inputs: this.createInputs(pass, stage, hookedTextureId),
            kind: manifest.shape === 'compute' ? 'compute' : 'render',
            label: `${LABEL_PREFIX} pass '${manifest.name}'`,
            targetTextureId: textureId,
            workgroupCounts
        });
        if (manifest.save === null) {
            this.current = draft;
            this.currentOffset = offset;
            return;
        }
        // The hooked image was read as it is, so it takes no further color steps
        this.savedTextures.set(manifest.save, textureId);
        this.sealCurrent();
    }

    /** Checks a kernel or compute pass's inputs and evaluates its output size and workgroup counts, before the plan changes. */
    private evaluateOutput(
        pass: ActivePass,
        stage: PresentationStage
    ): { output: PassOutput; size: Size; workgroupCounts: readonly [number, number, number] | null } {
        const manifest = pass.manifest;
        const output = requireOutput(manifest);
        const inputFacts = this.createInputFacts(pass, stage);
        const maximumDimension = this.request.device.maximumTextureDimension;
        const size: Size = {
            height: evaluateDimension(output.height, inputFacts, maximumDimension, 'height'),
            width: evaluateDimension(output.width, inputFacts, maximumDimension, 'width')
        };
        const workgroupCounts = manifest.workgroup ? evaluateWorkgroupCounts(manifest.workgroup, inputFacts) : null;
        if (manifest.shape === 'compute' && workgroupCounts === null) {
            throw new PassPlacementError('workgroup-missing', manifest.shape);
        }
        return { output, size, workgroupCounts };
    }

    /** At a stage that passes read by name, the stage's final image becomes a texture. */
    private finishStage(stage: PresentationStage): void {
        if (!this.namedStages.has(stage)) {
            return;
        }
        this.stageTextures.set(stage, this.materializeCurrent());
        this.sealCurrent();
    }

    /** Ends the spine at the output: the current producer writes the canvas when it can, and takes the rest of the color track. */
    private placeOutput(): void {
        let outputPass = this.requireCurrent();
        if (this.canWriteOutput(outputPass)) {
            if (outputPass.targetTextureId !== null) {
                this.textures.delete(outputPass.targetTextureId);
            }
        } else {
            const sourceTextureId = this.materializeCurrent();
            outputPass = this.pushDraft({
                core: { kind: 'sample' },
                coordinateMapping: 'identity',
                hookedTextureId: sourceTextureId,
                inputs: [ createEngineInput(sourceTextureId) ],
                label: OUTPUT_LABEL,
                targetTextureId: null
            });
        }
        outputPass.targetTextureId = null;
        outputPass.writesOutput = true;
        for (; this.cursor < this.track.length; this.cursor += 1) {
            outputPass.postSteps.push(this.track[this.cursor].step);
        }
    }

    private canWriteOutput(draft: DraftPass): boolean {
        if (draft.kind !== 'render' || draft.sealed) {
            return false;
        }
        if (draft.targetTextureId === null) {
            return true;
        }
        const size = this.getTextureSize(draft.targetTextureId);
        return size.width === this.request.facts.outputWidth
            && size.height === this.request.facts.outputHeight
            && !this.isTextureRead(draft.targetTextureId);
    }

    private isTextureRead(textureId: string): boolean {
        for (const draft of this.drafts) {
            if (draft.inputs.some((input: DraftInput): boolean => input.source.kind === 'texture' && input.source.textureId === textureId)) {
                return true;
            }
        }
        return [ ...this.stageTextures.values() ].includes(textureId) || [ ...this.savedTextures.values() ].includes(textureId);
    }

    /** Points history reads of a stage at its final texture, sizes every ring for its deepest read, and gives each input its texture's offset. */
    private resolveInputs(): void {
        for (const draft of this.drafts) {
            for (const input of draft.inputs) {
                if (input.source.kind === 'stage-history') {
                    input.source = { kind: 'texture', textureId: this.requireStageTexture(input.source.stage) };
                }
                input.offset = this.textureOffsets.get(input.source.textureId) ?? ZERO_OFFSET;
                if (input.historyOffset < 0) {
                    const texture = requireTexture(this.textures, input.source.textureId);
                    texture.historyDepth = Math.max(texture.historyDepth, -input.historyOffset);
                }
            }
        }
    }

    private createPlan(candidates: readonly ActivePass[]): PresentationPlan {
        const generator = new PassCodeGenerator(this.request, this.textures);
        const passes = this.drafts.map((draft: DraftPass): PlannedPass => generator.generate(draft));
        const includedPasses = candidates.filter((pass: ActivePass): boolean => this.activePasses.has(pass));
        return {
            buffers: [],
            deinterlace: this.deinterlace === null ? null : { ...this.deinterlace },
            output: this.request.output,
            parameterSets: includedPasses
                .filter((pass: ActivePass): boolean => pass.manifest.parameters.length > 0)
                .map((pass: ActivePass) => ({ parameters: pass.manifest.parameters, passName: pass.manifest.name })),
            passTextures: generator.getPassTextures(),
            passes,
            report: {
                activePasses: includedPasses.map((pass: ActivePass): string => pass.manifest.name),
                inactivePasses: this.inactivePasses
            },
            sourceKind: this.request.chain.signal.sourceKind,
            textures: [ ...this.textures.values() ],
            usesRenderSettings: passes.some((pass: PlannedPass): boolean => pass.bindings.some(
                (binding: PlannedBinding): boolean => binding.kind === 'engine' && binding.resource === 'render-settings'
            ))
        };
    }

    private getStateAt(cursor: number): ColorState {
        return cursor === 0 ? this.initialState : this.track[cursor - 1].outputState;
    }

    private satisfies(cursor: number, domain: ColorDomain): boolean {
        const state = this.getStateAt(cursor);
        switch (domain) {
            case 'any':
                return true;
            case 'display':
            case 'sdr':
                return state === 'display';
            case 'linear':
                return state === 'linear';
            case 'source':
                // Before any step, the values are the source's own, which identity SDR also calls display values
                return cursor === 0;
        }
    }

    /** Returns the first cursor from startCursor where the domain holds, without crossing a step pinned to the output. */
    private findCursor(domain: ColorDomain, startCursor: number): number | null {
        let cursor = startCursor;
        while (!this.satisfies(cursor, domain)) {
            const entry = this.track.at(cursor);
            if (entry === undefined || entry.pinnedToOutput) {
                return null;
            }
            cursor += 1;
        }
        return cursor;
    }

    /**
     * Returns the cursor a pass's input must reach, or throws when its domain cannot be reached.
     * A signal with a bypass skips every color step in the pass that reads it, so a pass that materializes it first completes the track to display there.
     */
    private findPlacementCursor(domain: ColorDomain, materializesSignal: boolean): number {
        let startCursor = this.cursor;
        if (materializesSignal && this.request.chain.signal.bypassCondition !== null) {
            startCursor = this.findCursor('display', this.cursor) ?? this.cursor;
        }
        const cursor = this.findCursor(domain, startCursor);
        if (cursor === null) {
            throw new PassPlacementError('domain-unreachable', `${domain} from ${this.getStateAt(startCursor)}`);
        }
        return cursor;
    }

    private advanceTo(targetCursor: number): void {
        for (; this.cursor < targetCursor; this.cursor += 1) {
            this.appendStep(this.track[this.cursor].step);
        }
    }

    /** Adds a color step to the current image; a sealed image first gets a pass of its own to carry it. */
    private appendStep(step: ColorStep): void {
        if (this.current === null) {
            this.signalSteps.push(step);
            return;
        }
        if (this.current.sealed) {
            this.current = this.createCopyPass();
        }
        this.current.postSteps.push(step);
    }

    private createCopyPass(): DraftPass {
        const sourceTextureId = this.materializeCurrent();
        const textureId = `${COPY_TEXTURE_ID_PREFIX}${this.copyCount}`;
        this.copyCount += 1;
        this.addTexture(textureId, this.getTextureSize(sourceTextureId), INTERMEDIATE_TEXTURE_FORMAT, false, this.currentOffset);
        return this.pushDraft({
            core: { kind: 'sample' },
            coordinateMapping: 'identity',
            hookedTextureId: sourceTextureId,
            inputs: [ createEngineInput(sourceTextureId) ],
            label: COLOR_LABEL,
            targetTextureId: textureId
        });
    }

    /** Makes the current image a texture and returns it: the signal gets a pass at source size, and an open scale pass a target at output size. */
    private materializeCurrent(): string {
        if (this.current === null) {
            this.addTexture(SIGNAL_TEXTURE_ID, this.getSourceSize(), INTERMEDIATE_TEXTURE_FORMAT, false);
            this.current = this.pushDraft({
                core: { kind: 'signal' },
                coordinateMapping: 'identity',
                hookedTextureId: null,
                inputs: [],
                label: SIGNAL_LABEL,
                postSteps: this.signalSteps,
                targetTextureId: SIGNAL_TEXTURE_ID
            });
            this.signalSteps = [];
            return SIGNAL_TEXTURE_ID;
        }
        if (this.current.targetTextureId === null) {
            this.addTexture(SCALE_TEXTURE_ID, this.getOutputSize(), INTERMEDIATE_TEXTURE_FORMAT, false);
            this.current.targetTextureId = SCALE_TEXTURE_ID;
        }
        return this.current.targetTextureId;
    }

    private sealCurrent(): void {
        if (this.current !== null) {
            this.current.sealed = true;
        }
    }

    private requireCurrent(): DraftPass {
        if (this.current === null) {
            throw new Error('The spine has no pass after its scaler');
        }
        return this.current;
    }

    private pushDraft(options: DraftPassOptions): DraftPass {
        const draft: DraftPass = {
            core: options.core,
            coordinateMapping: options.coordinateMapping,
            coordinateShift: options.coordinateShift ?? ZERO_OFFSET,
            hookedTextureId: options.hookedTextureId,
            inputs: options.inputs,
            kind: options.kind ?? 'render',
            label: options.label,
            postSteps: options.postSteps ?? [],
            sealed: false,
            targetTextureId: options.targetTextureId,
            workgroupCounts: options.workgroupCounts ?? null,
            writesOutput: false
        };
        this.drafts.push(draft);
        return draft;
    }

    private addTexture(id: string, size: Size, format: GPUTextureFormat, storage: boolean, offset: Offset = ZERO_OFFSET): void {
        this.textures.set(id, { format, height: size.height, historyDepth: 0, id, storage, width: size.width });
        this.textureOffsets.set(id, offset);
    }

    private getTextureSize(textureId: string): Size {
        const texture = requireTexture(this.textures, textureId);
        return { height: texture.height, width: texture.width };
    }

    private getSourceSize(): Size {
        return { height: this.request.facts.sourceHeight, width: this.request.facts.sourceWidth };
    }

    private getOutputSize(): Size {
        return { height: this.request.facts.outputHeight, width: this.request.facts.outputWidth };
    }

    /** Returns a stage's final texture; a plane stage's final image becomes one on its first read. */
    private requireStageTexture(stage: PresentationStage): string {
        const finalPlaneImage = this.finalPlaneImages.get(stage);
        if (finalPlaneImage !== undefined) {
            return this.materializePlaneImage(stage, finalPlaneImage);
        }
        const textureId = this.stageTextures.get(stage);
        if (textureId === undefined) {
            throw new Error(`The ${stage} stage has no texture`);
        }
        return textureId;
    }

    /** Returns the size of the spine's current image: the source, an open scale pass's output, or the current texture. */
    private getCurrentImageSize(): Size {
        if (this.current === null) {
            return this.getSourceSize();
        }
        if (this.current.targetTextureId === null) {
            return this.getOutputSize();
        }
        return this.getTextureSize(this.current.targetTextureId);
    }

    /** Returns the size and offset of the image a pass on a stage hooks: a plane stage's image, or the spine's current image. */
    private getHookedImage(stage: PresentationStage): HookedImage {
        if (isPlaneStage(stage)) {
            const image = this.requirePlaneImage(stage);
            return { extent: image.extent, offset: image.offset, size: image.size };
        }
        const size = this.getCurrentImageSize();
        return { extent: getSizeExtent(size), offset: this.currentOffset, size };
    }

    /** Returns the size of what an input reads, or throws when the input names nothing an earlier pass or stage provides. */
    private getInputSize(input: PassInput, stage: PresentationStage): Size {
        if (input.name === HOOKED_INPUT_NAME) {
            return this.getHookedImage(stage).size;
        }
        if (isStage(input.name)) {
            const order = compareStages(input.name, stage);
            if (order > 0) {
                throw new PassPlacementError('input-after-hook', `${input.name} at ${stage}`);
            }
            if (isPlaneStage(input.name) && this.planesUnavailable !== null) {
                throw new PassPlacementError('planes-unavailable', this.planesUnavailable);
            }
            if (order === 0) {
                return this.getHookedImage(stage).size;
            }
            const finalPlaneImage = this.finalPlaneImages.get(input.name);
            return finalPlaneImage === undefined ? this.getTextureSize(this.requireStageTexture(input.name)) : finalPlaneImage.size;
        }
        const savedTextureId = this.savedTextures.get(input.name);
        if (savedTextureId === undefined) {
            throw new PassPlacementError('input-unknown', `'${input.name}'`);
        }
        return this.getTextureSize(savedTextureId);
    }

    /** Returns the global facts plus `<input>.width` and `<input>.height` for HOOKED and each input. */
    private createInputFacts(pass: ActivePass, stage: PresentationStage): Map<string, number> {
        const facts = new Map<string, number>(this.facts);
        setSizeFacts(facts, HOOKED_INPUT_NAME, this.getHookedImage(stage).size);
        for (const input of pass.manifest.inputs) {
            setSizeFacts(facts, input.name, this.getInputSize(input, stage));
        }
        return facts;
    }

    private createInputs(pass: ActivePass, stage: PresentationStage, hookedTextureId: string): DraftInput[] {
        return pass.manifest.inputs.map((input: PassInput): DraftInput => ({
            accessorPrefix: getAccessorPrefix(input),
            historyOffset: input.historyOffset,
            offset: ZERO_OFFSET,
            source: this.getInputSource(input, stage, hookedTextureId)
        }));
    }

    private getInputSource(input: PassInput, stage: PresentationStage, hookedTextureId: string): InputSource {
        if (input.name === HOOKED_INPUT_NAME) {
            return { kind: 'texture', textureId: hookedTextureId };
        }
        if (!isStage(input.name)) {
            return { kind: 'texture', textureId: this.savedTextures.get(input.name) ?? hookedTextureId };
        }
        if (input.name !== stage) {
            return { kind: 'texture', textureId: this.requireStageTexture(input.name) };
        }
        // The hooked stage's history is its final image, which is known once the stage ends
        return input.historyOffset === 0 ? { kind: 'texture', textureId: hookedTextureId } : { kind: 'stage-history', stage };
    }
}

type BindingList = {
    bindings: PlannedBinding[]
    declarations: string[]
};

/** Generates each planned pass's WGSL module and bindings from its draft. */
class PassCodeGenerator {
    private readonly chain: BuiltinChain;
    private readonly float32Filterable: boolean;
    private readonly passTextures = new Map<string, PlannedPassTexture>();
    private readonly renames = new Map<ActivePass, ReadonlyMap<string, string>>();
    private readonly request: PlanRequest;
    private readonly textures: ReadonlyMap<string, DraftTexture>;

    constructor(request: PlanRequest, textures: ReadonlyMap<string, DraftTexture>) {
        this.request = request;
        this.chain = request.chain;
        this.float32Filterable = request.device.features.has(FLOAT32_FILTERABLE_FEATURE);
        this.textures = textures;
    }

    generate(draft: DraftPass): PlannedPass {
        const bindingList: BindingList = {
            bindings: [ { binding: PRESENTATION_BINDING, kind: 'presentation' } ],
            declarations: [ createPresentationBindingWGSL(PRESENTATION_BINDING) ]
        };
        const engineBindings = this.bindEngineResources(draft, bindingList);
        const userPasses = getUserPasses(draft);
        const builder = new ShaderModuleBuilder();
        builder.appendEngineCode(PRESENTATION_UNIFORMS_WGSL);
        builder.appendEngineCode(createEngineStructsWGSL(engineBindings));
        builder.appendEngineCode(bindingList.declarations.join('\n'));
        for (const pass of userPasses) {
            builder.appendEngineCode(this.bindParameters(pass, bindingList));
            builder.appendEngineCode(this.createConstants(pass));
            for (const texture of pass.manifest.textures) {
                builder.appendEngineCode(this.bindPassTexture(pass, texture, bindingList));
            }
        }
        for (const input of draft.inputs) {
            builder.appendEngineCode(this.bindTextureInput(input, bindingList));
        }
        if (draft.kind === 'compute') {
            builder.appendEngineCode(this.bindStorageTarget(draft, bindingList));
        }
        if (readsSignal(draft.core)) {
            builder.appendEngineCode(this.chain.signal.code);
        }
        const planeCore = draft.core.kind === 'plane-read' || draft.core.kind === 'plane-merge';
        if (draft.core.kind === 'plane-read' || draft.core.kind === 'plane-merge') {
            const planes = this.requirePlanes();
            builder.appendEngineCode(planes.transformCode);
            if (draft.core.source === 'image') {
                builder.appendEngineCode(createPlaneImageReadWGSL(planes));
            }
            builder.appendEngineCode(draft.core.source === 'image' ? planes.imageCode : planes.code);
        }
        this.appendPreludeFunctions(builder, userPasses, planeCore);
        if (draft.core.kind === 'plane-merge') {
            builder.appendEngineCode(createPlaneMergeWGSL(draft.core.merge, this.requirePlanes()));
        }
        if (draft.core.kind === 'deinterlace') {
            builder.appendEngineCode(createDeinterlaceWGSL(draft.core.bitDepth));
        }
        for (const colorFunction of getBuiltinFunctions(draft)) {
            builder.appendEngineCode(colorFunction.code);
        }
        for (const pass of userPasses) {
            builder.appendUserBody(pass.manifest.name, pass.manifest.bodyFirstLine, renameWGSLIdentifiers(pass.manifest.body, this.getRenames(pass)));
        }
        builder.appendEngineCode(this.createStage(draft));
        const module = builder.build();
        return {
            bindings: bindingList.bindings,
            code: module.code,
            colorSteps: draft.postSteps.map((step: ColorStep): string => (
                step.kind === 'builtin' ? step.colorFunction.name : step.pass.manifest.name
            )),
            coordinateMapping: draft.coordinateMapping,
            indirectBufferId: null,
            inputTextureId: draft.hookedTextureId,
            kind: draft.kind,
            label: draft.label,
            lineMap: module.lineMap,
            target: getPassTarget(draft),
            workgroupCounts: draft.workgroupCounts
        };
    }

    /**
     * Appends the prelude functions the module's user bodies call: the plane transform, whose code a plane core already holds, and linear light.
     * The planner left out every pass that calls one its chain lacks.
     */
    private appendPreludeFunctions(builder: ShaderModuleBuilder, userPasses: readonly ActivePass[], holdsPlaneTransform: boolean): void {
        let callsPlaneTransform = false;
        let callsLinearLight = false;
        for (const pass of userPasses) {
            callsPlaneTransform ||= collectUndeclaredReferences(pass.manifest.body, PLANE_TRANSFORM_PRELUDE_FUNCTIONS).size > 0;
            callsLinearLight ||= collectUndeclaredReferences(pass.manifest.body, LINEAR_LIGHT_PRELUDE_FUNCTIONS).size > 0;
        }
        if (callsPlaneTransform) {
            const planes = this.requirePlanes();
            if (!holdsPlaneTransform) {
                builder.appendEngineCode(planes.transformCode);
            }
            builder.appendEngineCode(createPlaneTransformPreludeWGSL(planes));
        }
        const linearLight = this.chain.linearLight;
        if (callsLinearLight && linearLight !== null) {
            builder.appendEngineCode(linearLight.code);
            builder.appendEngineCode(createLinearLightPreludeWGSL(linearLight));
        }
    }

    /** Binds the engine resources the signal, the built-in steps, and the input samplers read; returns the bound resources. */
    private bindEngineResources(draft: DraftPass, bindingList: BindingList): EngineBindingResource[] {
        const resources: EngineResource[] = [];
        if (readsSignal(draft.core)) {
            resources.push(...this.chain.signal.resources);
        }
        for (const colorFunction of getBuiltinFunctions(draft)) {
            resources.push(...colorFunction.resources);
        }
        if (draft.inputs.some((input: DraftInput): boolean => this.isFilterable(input))) {
            resources.push('sampler-linear');
        }
        const engineBindings: EngineBindingResource[] = [];
        for (const resource of resources) {
            for (const bindingResource of expandEngineResource(resource)) {
                if (engineBindings.includes(bindingResource)) {
                    continue;
                }
                const binding = bindingList.bindings.length;
                engineBindings.push(bindingResource);
                bindingList.bindings.push({ binding, kind: 'engine', resource: bindingResource });
                bindingList.declarations.push(createEngineBindingWGSL(bindingResource, binding));
            }
        }
        return engineBindings;
    }

    private bindParameters(pass: ActivePass, bindingList: BindingList): string {
        if (pass.manifest.parameters.length === 0) {
            return '';
        }
        const binding = bindingList.bindings.length;
        bindingList.bindings.push({ binding, kind: 'parameters', passName: pass.manifest.name });
        return createParametersWGSL(`${pass.prefix}Parameters`, `${pass.prefix}${PARAMETERS_VARIABLE}`, pass.manifest.parameters, binding);
    }

    /** Binds a texture block a pass reads, and its sampler, under the pass's own names; the plan takes the block once by its identity. */
    private bindPassTexture(pass: ActivePass, texture: PassTexture, bindingList: BindingList): string {
        this.passTextures.set(texture.identity, {
            dimension: texture.dimensions === THREE_DIMENSIONS ? '3d' : '2d',
            edge: texture.edge,
            filter: texture.filter,
            format: texture.format,
            id: texture.identity,
            size: texture.size
        });
        const textureBinding = bindingList.bindings.length;
        bindingList.bindings.push({ binding: textureBinding, kind: 'pass-texture', textureId: texture.identity });
        const samplerBinding = bindingList.bindings.length;
        bindingList.bindings.push({ binding: samplerBinding, kind: 'pass-sampler', textureId: texture.identity });
        return createPassTextureAccessorsWGSL(`${pass.prefix}${texture.name}`, texture, textureBinding, samplerBinding);
    }

    /** Returns the texture blocks the generated passes bind, each once. */
    getPassTextures(): PlannedPassTexture[] {
        return [ ...this.passTextures.values() ];
    }

    /** Returns a pass's constants at their current values, which a change compiles into a new plan. */
    private createConstants(pass: ActivePass): string {
        const constants = pass.manifest.constants;
        const values = constants.map((constant: PassParameter): number => getParameterValue(this.request, pass.manifest.name, constant));
        return createConstantsWGSL(this.getRenames(pass), constants, values);
    }

    private bindTextureInput(input: DraftInput, bindingList: BindingList): string {
        const binding = bindingList.bindings.length;
        bindingList.bindings.push({
            access: 'sampled',
            binding,
            historyOffset: input.historyOffset,
            kind: 'texture',
            textureId: requireTextureSource(input)
        });
        return createTextureAccessorsWGSL(input.accessorPrefix, binding, this.isFilterable(input), SAMPLER_VARIABLE, input.offset);
    }

    private bindStorageTarget(draft: DraftPass, bindingList: BindingList): string {
        const textureId = requireTargetTexture(draft);
        const binding = bindingList.bindings.length;
        bindingList.bindings.push({ access: 'storage', binding, historyOffset: 0, kind: 'texture', textureId });
        return createStorageTargetWGSL(binding, requireTexture(this.textures, textureId).format, this.getStepEntryPoints(draft));
    }

    private createStage(draft: DraftPass): string {
        const core = draft.core;
        if (draft.kind === 'compute') {
            if (core.kind !== 'user' || !core.pass.manifest.workgroup) {
                throw new Error(`Compute pass '${draft.label}' has no user workgroup`);
            }
            return createComputeStageWGSL(core.pass.manifest.workgroup.size, `${core.pass.prefix}${ENTRY_POINTS.compute}`);
        }
        const bypassCondition = core.kind === 'signal' ? this.chain.signal.bypassCondition : null;
        const fragmentStage = createFragmentStageWGSL(this.getCoreExpression(draft), bypassCondition, this.getStepEntryPoints(draft));
        return `${VERTEX_STAGE_WGSL}\n\n${fragmentStage}`;
    }

    private getCoreExpression(draft: DraftPass): string {
        const core = draft.core;
        // A scaler shifts its coordinate onto its image's offset; every other pass reads at its own coordinate
        const coordinate = isZeroOffset(draft.coordinateShift) ?
            FRAGMENT_COORDINATE :
            `(${FRAGMENT_COORDINATE} + ${toWGSLVector(draft.coordinateShift)})`;
        switch (core.kind) {
            case 'deinterlace':
                return `${DEINTERLACE_ENTRY_POINT}(${FRAGMENT_POSITION})`;
            case 'plane-merge':
                return `${MERGE_ENTRY_POINT}(${coordinate}, ${FRAGMENT_TARGET_COORDINATE})`;
            case 'plane-read':
                return createPlaneReadWGSL(core.plane, this.requirePlanes(), isUnitScale(core.scale) ?
                    coordinate :
                    `(${FRAGMENT_TARGET_COORDINATE} * ${toWGSLVector(core.scale)} * presentation.textureScale + presentation.textureOffset)`);
            case 'sample':
                return `${ENGINE_INPUT_PREFIX}_tex(${coordinate})`;
            case 'signal':
                return `${this.chain.signal.entryPoint}(${coordinate})`;
            case 'user':
                return `${core.pass.prefix}${ENTRY_POINTS[core.pass.manifest.shape]}(${coordinate})`;
        }
    }

    private requirePlanes(): SignalPlanes {
        const planes = this.chain.signal.planes;
        if (planes === null) {
            throw new Error(`Signal '${this.chain.signal.name}' has no planes`);
        }
        return planes;
    }

    private getStepEntryPoints(draft: DraftPass): string[] {
        return draft.postSteps.map((step: ColorStep): string => (
            step.kind === 'builtin' ? step.colorFunction.entryPoint : `${step.pass.prefix}${ENTRY_POINTS.color}`
        ));
    }

    /** Returns the renames that keep a user body apart: its entry point, its parameters, and every name it declares at module scope. */
    private getRenames(pass: ActivePass): ReadonlyMap<string, string> {
        const cachedRenames = this.renames.get(pass);
        if (cachedRenames) {
            return cachedRenames;
        }
        const renames = new Map<string, string>();
        for (const name of collectTopLevelDeclarations(pass.manifest.body)) {
            renames.set(name, `${pass.prefix}${name}`);
        }
        const entryPoint = ENTRY_POINTS[pass.manifest.shape];
        renames.set(entryPoint, `${pass.prefix}${entryPoint}`);
        if (pass.manifest.parameters.length > 0) {
            renames.set(PARAMETERS_VARIABLE, `${pass.prefix}${PARAMETERS_VARIABLE}`);
        }
        for (const constant of pass.manifest.constants) {
            renames.set(constant.name, `${pass.prefix}${constant.name}`);
        }
        for (const texture of pass.manifest.textures) {
            for (const suffix of PASS_TEXTURE_ACCESSOR_SUFFIXES) {
                renames.set(`${texture.name}${suffix}`, `${pass.prefix}${texture.name}${suffix}`);
            }
        }
        this.renames.set(pass, renames);
        return renames;
    }

    private isFilterable(input: DraftInput): boolean {
        const format = requireTexture(this.textures, requireTextureSource(input)).format;
        return this.float32Filterable || !FLOAT32_TEXTURE_FORMATS.has(format);
    }
}

/** Returns whether a core runs the route's signal code, whose resources its pass binds: the signal's, and a plane core's that reads the source. */
function readsSignal(core: DraftCore): boolean {
    switch (core.kind) {
        case 'signal':
            return true;
        case 'plane-merge':
        case 'plane-read':
            return core.source === 'signal';
        case 'deinterlace':
        case 'sample':
        case 'user':
            return false;
    }
}

/** Returns the reads of the RGB image planes derive from in a deinterlacing plan: the deinterlaced image, which the pass binds as an input. */
function createPlaneImageReadWGSL(planes: SignalPlanes): string {
    return `fn ${planes.imageReadEntryPoint}(coordinate: vec2f) -> vec3f {
    return ${PLANE_IMAGE_INPUT_PREFIX}_tex(coordinate).rgb;
}

fn ${planes.imageSizeEntryPoint}() -> vec2f {
    return ${PLANE_IMAGE_INPUT_PREFIX}_size();
}`;
}

/** Returns the expression of a plane read: the plane's codes at the coordinate over the code scale, in the components mpv's plane has. */
function createPlaneReadWGSL(plane: 'chroma' | 'luma', planes: SignalPlanes, coordinate: string): string {
    const scale = `${planes.codeScaleEntryPoint}()`;
    return plane === 'luma' ?
        `vec4f(${planes.lumaEntryPoint}(${coordinate}) / ${scale}, 0.0, 0.0, 1.0)` :
        `vec4f(${planes.chromaEntryPoint}(${coordinate}) / ${scale}, 0.0, 1.0)`;
}

/**
 * Returns the merge function of a plane merge pass: `fn mergeSignalPlanes(sourceCoordinate: vec2f, imageCoordinate: vec2f) -> vec4f`.
 * The image coordinate is normalized over the merged grid, and the source coordinate is the same point mapped onto the coded frame.
 * Each plane comes from its image, scaled back to codes, or from the signal's own read; chroma lands on the grid through both images' offsets.
 */
function createPlaneMergeWGSL(merge: PlaneMerge, planes: SignalPlanes): string {
    const statements: string[] = [ `    let scale = ${planes.codeScaleEntryPoint}();` ];
    // Chroma's extent differs from its size only where an odd luma size leaves its last pixel half outside
    const chromaCoordinate = isUnitScale(merge.chromaScale) ? 'referenceCoordinate' : `referenceCoordinate * ${toWGSLVector(merge.chromaScale)}`;
    if (merge.nativePrefix !== null) {
        statements.push(`    let codes = ${merge.nativePrefix}_tex(imageCoordinate).xyz * scale;`);
    } else {
        // The reference grid's coordinate, normalized over the merged image and mapped onto the coded frame
        statements.push(
            `    let referenceCoordinate = imageCoordinate - ${toWGSLVector(merge.gridShift)};`,
            `    let referenceSourceCoordinate = sourceCoordinate - ${toWGSLVector(merge.gridShift)} * presentation.textureScale;`,
            merge.lumaPrefix === null ?
                `    let luma = ${planes.lumaEntryPoint}(sourceCoordinate);` :
                `    let luma = ${merge.lumaPrefix}_tex(imageCoordinate).x * scale;`,
            merge.chromaPrefix === null ?
                `    let chroma = ${planes.sitedChromaEntryPoint}(referenceSourceCoordinate);` :
                `    let chroma = ${merge.chromaPrefix}_tex(${chromaCoordinate} + ${toWGSLVector(merge.chromaShift)}).xy * scale;`,
            '    let codes = vec3f(luma, chroma);'
        );
    }
    statements.push(merge.writesNative ? '    return vec4f(codes / scale, 1.0);' : `    return ${planes.conversionEntryPoint}(codes);`);
    return `fn ${MERGE_ENTRY_POINT}(sourceCoordinate: vec2f, imageCoordinate: vec2f) -> vec4f {
${statements.join('\n')}
}`;
}

function requireTextureSource(input: DraftInput): string {
    if (input.source.kind !== 'texture') {
        throw new Error(`Input '${input.accessorPrefix}' was never resolved to a texture`);
    }
    return input.source.textureId;
}

function requireTargetTexture(draft: DraftPass): string {
    if (draft.targetTextureId === null) {
        throw new Error(`Pass '${draft.label}' has no target texture`);
    }
    return draft.targetTextureId;
}

function getPassTarget(draft: DraftPass): PlannedPass['target'] {
    if (draft.kind === 'compute') {
        return null;
    }
    return draft.writesOutput ? { kind: 'output' } : { kind: 'texture', textureId: requireTargetTexture(draft) };
}

/** Returns the user bodies a pass's module holds: its core, then its user color steps. */
function getUserPasses(draft: DraftPass): ActivePass[] {
    const passes: ActivePass[] = [];
    if (draft.core.kind === 'user') {
        passes.push(draft.core.pass);
    }
    for (const step of draft.postSteps) {
        if (step.kind === 'user') {
            passes.push(step.pass);
        }
    }
    return passes;
}

function getBuiltinFunctions(draft: DraftPass): BuiltinColorFunction[] {
    const colorFunctions: BuiltinColorFunction[] = [];
    for (const step of draft.postSteps) {
        if (step.kind === 'builtin') {
            colorFunctions.push(step.colorFunction);
        }
    }
    return colorFunctions;
}

/**
 * Builds an immutable presentation plan from a route's built-in chain, the user passes, and the plan-time facts.
 * A pass that cannot run as written is left out with its reason in the report; the rest of the plan is built without it.
 * Without user passes, every route plans one pass that reads the source and writes the output, as the legacy fused shaders did.
 */
export function planPresentation(request: PlanRequest): PresentationPlan {
    return new PresentationPlanBuilder(request).build();
}
