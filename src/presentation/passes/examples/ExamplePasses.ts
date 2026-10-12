// The example passes a host can offer its users: three user passes and the Catmull-Rom scaler.
import catmullRomScalerShader from '../builtin/CatmullRomScaler.wgsl';
import { parsePassManifest } from '../PassManifest';
import { SATURATION_COLOR_PASS } from './SaturationColorPass';
import { SHARPEN_KERNEL_PASS } from './SharpenKernelPass';
import { TEMPORAL_BLEND_KERNEL_PASS } from './TemporalBlendKernelPass';

/** One example: a stable id, the name its header declares, and its WGSL source with its `//!` header. */
export type ExamplePass = Readonly<{
    id: string
    name: string
    source: string
}>;

function createExamplePass(id: string, source: string): ExamplePass {
    return Object.freeze({ id, name: parsePassManifest(source).name, source });
}

/** The examples, in the order a host lists them. */
export const EXAMPLE_PASSES: readonly ExamplePass[] = Object.freeze([
    createExamplePass('saturation', SATURATION_COLOR_PASS),
    createExamplePass('sharpen', SHARPEN_KERNEL_PASS),
    createExamplePass('temporal-blend', TEMPORAL_BLEND_KERNEL_PASS),
    createExamplePass('catmull-rom', catmullRomScalerShader)
]);
