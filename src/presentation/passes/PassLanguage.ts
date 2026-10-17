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

/** The accessor prefix of a compute pass's storage target, as in `TARGET_store`. */
export const TARGET_ACCESSOR_PREFIX = 'TARGET';

/**
 * The plan-time facts every expression may read; booleans are 1 or 0, and an unknown frame rate is 0.
 * The chroma size is the chroma plane's visible size, the source's where the route's planes are not subsampled.
 */
export const GLOBAL_FACTS = Object.freeze({
    chromaHeight: 'chroma.height',
    chromaWidth: 'chroma.width',
    frameRate: 'frame.rate',
    hdrOutput: 'hdr.output',
    hdrSource: 'hdr.source',
    outputHeight: 'output.height',
    outputWidth: 'output.width',
    sourceHeight: 'source.height',
    sourceWidth: 'source.width'
});

/** Every global fact name, sizes first. */
export const GLOBAL_FACT_NAMES: readonly string[] = Object.freeze([
    GLOBAL_FACTS.sourceWidth,
    GLOBAL_FACTS.sourceHeight,
    GLOBAL_FACTS.outputWidth,
    GLOBAL_FACTS.outputHeight,
    GLOBAL_FACTS.chromaWidth,
    GLOBAL_FACTS.chromaHeight,
    GLOBAL_FACTS.frameRate,
    GLOBAL_FACTS.hdrSource,
    GLOBAL_FACTS.hdrOutput
]);

/** The names of the global sizes; a texture named like one would shadow their facts. */
export const GLOBAL_SIZE_NAMES: readonly string[] = Object.freeze([ 'source', 'output', 'chroma' ]);

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
