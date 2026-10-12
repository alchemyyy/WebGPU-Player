// The names of the pass language that headers, the prelude, and the planner share; overhual/passes.md documents them.
import type { PassInput, PassShape, PresentationStage } from './PassTypes';

/** The spatial spine after the fixed signal step, in pipeline order. */
export const STAGE_ORDER: readonly PresentationStage[] = [ 'RGB', 'PRESCALE', 'SCALE', 'OUTPUT' ];

/** The stage every scaler hooks. */
export const SCALER_STAGE: PresentationStage = 'SCALE';

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

/** The variable user code reads its declared parameters through. */
export const PARAMETERS_VARIABLE = 'parameters';

/** The accessor prefix of a compute pass's storage target, as in `TARGET_store`. */
export const TARGET_ACCESSOR_PREFIX = 'TARGET';

/** The plan-time facts every expression may read; booleans are 1 or 0, and an unknown frame rate is 0. */
export const GLOBAL_FACTS = Object.freeze({
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
    GLOBAL_FACTS.frameRate,
    GLOBAL_FACTS.hdrSource,
    GLOBAL_FACTS.hdrOutput
]);

/** The names of the global sizes; a texture named like one would shadow their facts. */
export const GLOBAL_SIZE_NAMES: readonly string[] = Object.freeze([ 'source', 'output' ]);

/** The suffixes of an input's size facts, and of the `<name>.size` shorthand in an output size. */
export const WIDTH_SUFFIX = '.width';
export const HEIGHT_SUFFIX = '.height';
export const SIZE_SUFFIX = '.size';

/** Returns the accessor prefix of an input: its name, with `_history<N>` for the frame N back. */
export function getAccessorPrefix(input: PassInput): string {
    return input.historyOffset === 0 ? input.name : `${input.name}${HISTORY_ACCESSOR_INFIX}${-input.historyOffset}`;
}
