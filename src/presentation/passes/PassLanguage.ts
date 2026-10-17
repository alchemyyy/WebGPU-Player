// The names of the pass language that headers, the prelude, and the planner share; docs/src/new-pass.md documents them.
import type { PassInput, PassShape, PresentationStage } from './PassTypes';

/** The plane stages, which hold the signal's planes before it converts them, in mpv's order. */
export const LUMA_STAGE: PresentationStage = 'LUMA';
export const CHROMA_STAGE: PresentationStage = 'CHROMA';
export const NATIVE_STAGE: PresentationStage = 'NATIVE';
export const PLANE_STAGES: readonly PresentationStage[] = [ LUMA_STAGE, CHROMA_STAGE, NATIVE_STAGE ];

/** The image stages, from the signal step's RGB on, in pipeline order. */
export const IMAGE_STAGES: readonly PresentationStage[] = [ 'RGB', 'PRESCALE', 'SCALE', 'OUTPUT' ];

/** The spatial spine, in pipeline order: the plane stages, then the image stages. */
export const STAGE_ORDER: readonly PresentationStage[] = [ ...PLANE_STAGES, ...IMAGE_STAGES ];

/** The stage every scaler hooks. */
export const SCALER_STAGE: PresentationStage = 'SCALE';

/** The stages after the scaler, whose images sit on the output's grid, so no pass there declares an offset. */
export const SCALED_STAGES: readonly PresentationStage[] = [ SCALER_STAGE, 'OUTPUT' ];

/** The `offset` value that aligns a pass's output with the reference grid. */
export const OFFSET_ALIGN = 'align';

/** The input that names the image at a pass's hook. */
export const HOOKED_INPUT_NAME = 'HOOKED';

/** The deepest history an input can read, as in `RGB[-8]`. */
export const MAXIMUM_HISTORY_DEPTH = 8;

/** History N back of an input has the accessors of `<name>_history<N>`. */
export const HISTORY_ACCESSOR_INFIX = '_history';

/** The entry point user code defines for each shape. */
export const ENTRY_POINTS: Readonly<Record<PassShape, string>> = Object.freeze({
    color: 'apply',
    compute: 'compute',
    kernel: 'kernel',
    scaler: 'scale'
});

/** The parameters a pass declares at most. */
export const MAXIMUM_PARAMETER_COUNT = 32;

/** The file extension of a pass source, as file pickers filter by it. */
export const PASS_FILE_EXTENSION = '.wgsl';

/** The variable user code reads its declared parameters through. */
export const PARAMETERS_VARIABLE = 'parameters';

/** The axes of a texture block's size, in order, which name an axis in its errors. */
export const TEXTURE_AXIS_NAMES: readonly string[] = Object.freeze([ 'width', 'height', 'depth' ]);

/** The accessor suffixes of a texture block a pass binds, as in `LUT_tex`. */
export const PASS_TEXTURE_ACCESSOR_SUFFIXES: readonly string[] = Object.freeze([ '_tex', '_size', '_load' ]);

/** The accessor prefix of a compute pass's storage target, as in `TARGET_store`. */
export const TARGET_ACCESSOR_PREFIX = 'TARGET';

/**
 * The functions the prelude defines for a body that calls them without declaring them itself.
 * - linearize, delinearize: the source's transfer function, in mpv's scale of linear light, where 1.0 is referenceWhiteNits() nits.
 * - referenceWhiteNits: the nits of mpv's linear 1.0, the configured SDR white for an SDR source and BT.2408's HDR reference white for HDR.
 * - rgbToPlanes, planesToRGB: 'source' RGB to the normalized Y, Cb, and Cr plane values of the source's matrix and range, and back.
 */
export const PRELUDE_FUNCTIONS = Object.freeze({
    delinearize: 'delinearize',
    linearize: 'linearize',
    planesToRGB: 'planesToRGB',
    referenceWhiteNits: 'referenceWhiteNits',
    rgbToPlanes: 'rgbToPlanes'
});

/** The prelude functions that read the source's transfer function, and those that read its planes' transform. */
export const LINEAR_LIGHT_PRELUDE_FUNCTIONS: readonly string[] = Object.freeze([
    PRELUDE_FUNCTIONS.linearize,
    PRELUDE_FUNCTIONS.delinearize,
    PRELUDE_FUNCTIONS.referenceWhiteNits
]);
export const PLANE_TRANSFORM_PRELUDE_FUNCTIONS: readonly string[] = Object.freeze([ PRELUDE_FUNCTIONS.rgbToPlanes, PRELUDE_FUNCTIONS.planesToRGB ]);

/**
 * The plan-time facts every expression may read; booleans are 1 or 0, and an unknown frame rate is 0.
 * The luma size is the frame's visible size in samples, and the chroma size the chroma plane's, the luma size over the route's subsampling, rounded up.
 * rgb.source is 1 when the source codes R, G, and B planes, on which mpv fires its RGB hook rather than LUMA and CHROMA.
 */
export const GLOBAL_FACTS = Object.freeze({
    chromaHeight: 'chroma.height',
    chromaWidth: 'chroma.width',
    frameRate: 'frame.rate',
    hdrOutput: 'hdr.output',
    hdrSource: 'hdr.source',
    lumaHeight: 'luma.height',
    lumaWidth: 'luma.width',
    outputHeight: 'output.height',
    outputWidth: 'output.width',
    rgbSource: 'rgb.source',
    sourceHeight: 'source.height',
    sourceWidth: 'source.width'
});

/** Every global fact name, sizes first. */
export const GLOBAL_FACT_NAMES: readonly string[] = Object.freeze([
    GLOBAL_FACTS.sourceWidth,
    GLOBAL_FACTS.sourceHeight,
    GLOBAL_FACTS.outputWidth,
    GLOBAL_FACTS.outputHeight,
    GLOBAL_FACTS.lumaWidth,
    GLOBAL_FACTS.lumaHeight,
    GLOBAL_FACTS.chromaWidth,
    GLOBAL_FACTS.chromaHeight,
    GLOBAL_FACTS.frameRate,
    GLOBAL_FACTS.hdrSource,
    GLOBAL_FACTS.hdrOutput,
    GLOBAL_FACTS.rgbSource
]);

/** The names of the global sizes; a texture named like one would shadow their facts. */
export const GLOBAL_SIZE_NAMES: readonly string[] = Object.freeze([ 'source', 'output', 'luma', 'chroma' ]);

/** The suffixes of an input's size facts, and of the `<name>.size` shorthand in an output size. */
export const WIDTH_SUFFIX = '.width';
export const HEIGHT_SUFFIX = '.height';
export const SIZE_SUFFIX = '.size';

/** Joins a preset file's position and a pass's place in the file, as in 3.2. */
export const PASS_POSITION_SEPARATOR = '.';

/** Returns a pass's preset position, counted from 1, by which reports name an unnamed pass: its file's, with its place in a file of several passes. */
export function getPresetPassPosition(fileIndex: number, passIndex: number, passCount: number): string {
    const filePosition = String(fileIndex + 1);
    return passCount === 1 ? filePosition : `${filePosition}${PASS_POSITION_SEPARATOR}${passIndex + 1}`;
}

/** Returns the accessor prefix of an input: its name, with `_history<N>` for the frame N back. */
export function getAccessorPrefix(input: PassInput): string {
    return input.historyOffset === 0 ? input.name : `${input.name}${HISTORY_ACCESSOR_INFIX}${-input.historyOffset}`;
}
