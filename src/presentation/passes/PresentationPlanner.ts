// Builds presentation plans: it arranges a route's built-in chain and the user passes on the spatial spine and the color track, then generates each pass's WGSL.
// overhual/planning.md, overhual/color.md, and overhual/temporal.md in the engine root describe the rules it implements.
import {
    FLOAT32_FILTERABLE_FEATURE,
    FLOAT32_TEXTURE_FORMATS,
    INTERMEDIATE_TEXTURE_FORMAT,
    MAXIMUM_WORKGROUP_COUNT,
    WORKGROUP_AXIS_NAMES
} from '../WebGPUConstants';
import { evaluatePassExpression, PassExpressionError } from './PassExpression';
import {
    collectTopLevelDeclarations,
    createComputeStageWGSL,
    createFragmentStageWGSL,
    createParametersWGSL,
    createStorageTargetWGSL,
    createTextureAccessorsWGSL,
    FRAGMENT_COORDINATE,
    FRAGMENT_POSITION,
    renameWGSLIdentifiers,
    ShaderModuleBuilder,
    VERTEX_STAGE_WGSL
} from './PassPrelude';
import {
    ENTRY_POINTS,
    getAccessorPrefix,
    GLOBAL_FACTS,
    HEIGHT_SUFFIX,
    HOOKED_INPUT_NAME,
    PARAMETERS_VARIABLE,
    STAGE_ORDER,
    TARGET_ACCESSOR_PREFIX,
    WIDTH_SUFFIX
} from './PassLanguage';
import {
    createEngineBindingWGSL,
    createEngineStructsWGSL,
    createPresentationBindingWGSL,
    expandEngineResource,
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
    PassRejection,
    PassRejectionReason,
    PassWorkgroup,
    PlanFacts,
    PlannedBinding,
    PlannedPass,
    PlannedTexture,
    PlanRequest,
    PresentationPlan,
    PresentationStage
} from './PassTypes';

const STAGE_NAMES: ReadonlySet<string> = new Set<string>(STAGE_ORDER);

const SIGNAL_TEXTURE_ID = 'signal';
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
const DEINTERLACE_LABEL = `${LABEL_PREFIX} deinterlace`;
const SCALE_LABEL = `${LABEL_PREFIX} scale`;
const COLOR_LABEL = `${LABEL_PREFIX} color`;
const OUTPUT_LABEL = `${LABEL_PREFIX} output`;

const PRESENTATION_BINDING = 0;

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
    source: InputSource
};

/**
 * What a pass computes before its color steps.
 * - 'deinterlace': the built-in deinterlacing pass over the signal's history, at the stream's bit depth.
 * - 'signal': the route's signal, read from the source at the pass's coordinate.
 * - 'sample': a bilinear read of the pass's one input texture.
 * - 'user': a user kernel, scaler, or compute body.
 */
type DraftCore =
    | { bitDepth: number; kind: 'deinterlace' }
    | { kind: 'sample' }
    | { kind: 'signal' }
    | { kind: 'user'; pass: ActivePass };

type DraftPass = {
    core: DraftCore
    coordinateMapping: PassCoordinateMapping
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
    & Partial<Pick<DraftPass, 'kind' | 'postSteps' | 'workgroupCounts'>>;

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

function compareStages(first: PresentationStage, second: PresentationStage): number {
    return STAGE_ORDER.indexOf(first) - STAGE_ORDER.indexOf(second);
}

function createEngineInput(textureId: string): DraftInput {
    return { accessorPrefix: ENGINE_INPUT_PREFIX, historyOffset: 0, source: { kind: 'texture', textureId } };
}

function createGlobalFacts(facts: PlanFacts): Map<string, number> {
    return new Map<string, number>([
        [ GLOBAL_FACTS.sourceWidth, facts.sourceWidth ],
        [ GLOBAL_FACTS.sourceHeight, facts.sourceHeight ],
        [ GLOBAL_FACTS.outputWidth, facts.outputWidth ],
        [ GLOBAL_FACTS.outputHeight, facts.outputHeight ],
        [ GLOBAL_FACTS.frameRate, facts.frameRate ?? 0 ],
        [ GLOBAL_FACTS.hdrSource, facts.hdrSource ? 1 : 0 ],
        [ GLOBAL_FACTS.hdrOutput, facts.hdrOutput ? 1 : 0 ]
    ]);
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
    private readonly savedTextures = new Map<string, string>();
    private readonly stageTextures = new Map<PresentationStage, string>();
    private readonly textures = new Map<string, DraftTexture>();
    private copyCount = 0;
    private deinterlace: DeinterlaceRequest | null = null;
    // The producer of the spine's current image; null while that image is the signal, which no pass has read yet
    private current: DraftPass | null = null;
    // Track entries before the cursor have run
    private cursor = 0;
    private namedStages: ReadonlySet<PresentationStage> = new Set<PresentationStage>();
    // Color steps on the signal before any pass reads it
    private signalSteps: ColorStep[] = [];
    private track: TrackEntry[] = [];

    constructor(request: PlanRequest) {
        this.request = request;
        this.facts = createGlobalFacts(request.facts);
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
        for (const stage of STAGE_ORDER) {
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
        if (manifest.when === null) {
            return true;
        }
        try {
            if (evaluatePassExpression(manifest.when, this.facts) !== 0) {
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
        const hookedTextureId = this.materializeCurrent();
        this.current = this.pushDraft({
            core: { kind: 'user', pass: scaler },
            coordinateMapping: 'object-fit',
            hookedTextureId,
            inputs: this.createInputs(scaler, 'SCALE', hookedTextureId),
            label: `${LABEL_PREFIX} pass '${scaler.manifest.name}'`,
            targetTextureId: null
        });
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
        const hookedTextureId = this.materializeCurrent();
        this.current = this.pushDraft({
            core: { kind: 'sample' },
            coordinateMapping: 'object-fit',
            hookedTextureId,
            inputs: [ createEngineInput(hookedTextureId) ],
            label: SCALE_LABEL,
            targetTextureId: null
        });
    }

    private placeColorPass(pass: ActivePass): void {
        this.advanceTo(this.findPlacementCursor(pass.manifest.domain, false));
        this.appendStep({ kind: 'user', pass });
    }

    /** Places a kernel or compute pass: it reads textures, so its hooked image is materialized with the color steps its domain needs. */
    private placeSpatialPass(pass: ActivePass, stage: PresentationStage): void {
        const manifest = pass.manifest;
        if (manifest.shape === 'compute' && manifest.inputs.some((input: PassInput): boolean => input.name === TARGET_ACCESSOR_PREFIX)) {
            throw new PassPlacementError('input-reserved', TARGET_ACCESSOR_PREFIX);
        }
        const targetCursor = this.findPlacementCursor(manifest.domain, this.current === null);
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
        // Every check has passed, so the plan changes from here
        this.advanceTo(targetCursor);
        const hookedTextureId = this.materializeCurrent();
        const textureId = `${PASS_TEXTURE_ID_PREFIX}${manifest.name}`;
        this.addTexture(textureId, size, output.format, manifest.shape === 'compute');
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
            return;
        }
        // The hooked image was read as it is, so it takes no further color steps
        this.savedTextures.set(manifest.save, textureId);
        this.sealCurrent();
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

    /** Points history reads of a stage at its final texture, and sizes every ring for its deepest read. */
    private resolveInputs(): void {
        for (const draft of this.drafts) {
            for (const input of draft.inputs) {
                if (input.source.kind === 'stage-history') {
                    input.source = { kind: 'texture', textureId: this.requireStageTexture(input.source.stage) };
                }
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
        this.addTexture(textureId, this.getTextureSize(sourceTextureId), INTERMEDIATE_TEXTURE_FORMAT, false);
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

    private addTexture(id: string, size: Size, format: GPUTextureFormat, storage: boolean): void {
        this.textures.set(id, { format, height: size.height, historyDepth: 0, id, storage, width: size.width });
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

    private requireStageTexture(stage: PresentationStage): string {
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

    /** Returns the size of what an input reads, or throws when the input names nothing an earlier pass or stage provides. */
    private getInputSize(input: PassInput, stage: PresentationStage): Size {
        if (input.name === HOOKED_INPUT_NAME) {
            return this.getCurrentImageSize();
        }
        if (isStage(input.name)) {
            const order = compareStages(input.name, stage);
            if (order > 0) {
                throw new PassPlacementError('input-after-hook', `${input.name} at ${stage}`);
            }
            return order === 0 ? this.getCurrentImageSize() : this.getTextureSize(this.requireStageTexture(input.name));
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
        setSizeFacts(facts, HOOKED_INPUT_NAME, this.getCurrentImageSize());
        for (const input of pass.manifest.inputs) {
            setSizeFacts(facts, input.name, this.getInputSize(input, stage));
        }
        return facts;
    }

    private createInputs(pass: ActivePass, stage: PresentationStage, hookedTextureId: string): DraftInput[] {
        return pass.manifest.inputs.map((input: PassInput): DraftInput => ({
            accessorPrefix: getAccessorPrefix(input),
            historyOffset: input.historyOffset,
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
    private readonly renames = new Map<ActivePass, ReadonlyMap<string, string>>();
    private readonly textures: ReadonlyMap<string, DraftTexture>;

    constructor(request: PlanRequest, textures: ReadonlyMap<string, DraftTexture>) {
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
        }
        for (const input of draft.inputs) {
            builder.appendEngineCode(this.bindTextureInput(input, bindingList));
        }
        if (draft.kind === 'compute') {
            builder.appendEngineCode(this.bindStorageTarget(draft, bindingList));
        }
        if (draft.core.kind === 'signal') {
            builder.appendEngineCode(this.chain.signal.code);
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

    /** Binds the engine resources the signal, the built-in steps, and the input samplers read; returns the bound resources. */
    private bindEngineResources(draft: DraftPass, bindingList: BindingList): EngineBindingResource[] {
        const resources: EngineResource[] = [];
        if (draft.core.kind === 'signal') {
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

    private bindTextureInput(input: DraftInput, bindingList: BindingList): string {
        const binding = bindingList.bindings.length;
        bindingList.bindings.push({
            access: 'sampled',
            binding,
            historyOffset: input.historyOffset,
            kind: 'texture',
            textureId: requireTextureSource(input)
        });
        return createTextureAccessorsWGSL(input.accessorPrefix, binding, this.isFilterable(input), SAMPLER_VARIABLE);
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
        const fragmentStage = createFragmentStageWGSL(this.getCoreExpression(core), bypassCondition, this.getStepEntryPoints(draft));
        return `${VERTEX_STAGE_WGSL}\n\n${fragmentStage}`;
    }

    private getCoreExpression(core: DraftCore): string {
        switch (core.kind) {
            case 'deinterlace':
                return `${DEINTERLACE_ENTRY_POINT}(${FRAGMENT_POSITION})`;
            case 'sample':
                return `${ENGINE_INPUT_PREFIX}_tex(${FRAGMENT_COORDINATE})`;
            case 'signal':
                return `${this.chain.signal.entryPoint}(${FRAGMENT_COORDINATE})`;
            case 'user':
                return `${core.pass.prefix}${ENTRY_POINTS[core.pass.manifest.shape]}(${FRAGMENT_COORDINATE})`;
        }
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
        this.renames.set(pass, renames);
        return renames;
    }

    private isFilterable(input: DraftInput): boolean {
        const format = requireTexture(this.textures, requireTextureSource(input)).format;
        return this.float32Filterable || !FLOAT32_TEXTURE_FORMATS.has(format);
    }
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
