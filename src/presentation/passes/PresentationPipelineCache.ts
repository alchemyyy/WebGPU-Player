// Keeps presentation passes compiled on a device, so an executor built again for a pass it compiled before, for another plan of the same session,
// a seek's replan, or the next session on the same device, compiles nothing, and a variant planned ahead of the first frame is ready when it comes.
// A pass's pipeline depends only on its WGSL, its bind group layout, and its target format, which its key holds, and the cache keeps the most
// recently used passes up to a bound, so variants that come and go never grow it past that (see the engine book's Decisions, Presentation).

/** How many compiled passes a device keeps; a plan has a few, and a preset of large passes a few dozen. */
export const PRESENTATION_PIPELINE_CACHE_CAPACITY = 64;

export type PresentationPassPipeline =
    | { kind: 'compute'; pipeline: GPUComputePipeline }
    | { kind: 'render'; pipeline: GPURenderPipeline };

/** One pass compiled on a device: the bind group layout its bind groups take, and its pipeline. */
export type CompiledPresentationPass = Readonly<{
    bindGroupLayout: GPUBindGroupLayout
    pipeline: PresentationPassPipeline
}>;

// Each device's compiled passes, least recently used first; a compile in progress counts, so executors built at once share it
const compiledPassesByDevice = new WeakMap<GPUDevice, Map<string, Promise<CompiledPresentationPass>>>();

/**
 * Returns a pass compiled on a device: the one the device keeps under the key, or the one `compile` makes, which the device keeps from then on.
 * Each use makes a pass the most recently used, and a device that keeps more than PRESENTATION_PIPELINE_CACHE_CAPACITY passes drops the least
 * recently used; an executor that holds a dropped pass keeps it.
 * A compile that fails is dropped, so the next build compiles again.
 */
export function getCompiledPresentationPass(
    device: GPUDevice,
    key: string,
    compile: () => Promise<CompiledPresentationPass>
): Promise<CompiledPresentationPass> {
    let compiledPasses = compiledPassesByDevice.get(device);
    if (compiledPasses === undefined) {
        compiledPasses = new Map<string, Promise<CompiledPresentationPass>>();
        compiledPassesByDevice.set(device, compiledPasses);
    }
    const kept = compiledPasses.get(key);
    if (kept !== undefined) {
        compiledPasses.delete(key);
        compiledPasses.set(key, kept);
        return kept;
    }
    const compiled = compile();
    compiledPasses.set(key, compiled);
    for (const leastRecentlyUsedKey of compiledPasses.keys()) {
        if (compiledPasses.size <= PRESENTATION_PIPELINE_CACHE_CAPACITY) {
            break;
        }
        compiledPasses.delete(leastRecentlyUsedKey);
    }
    const passes = compiledPasses;
    compiled.catch((): void => {
        if (passes.get(key) === compiled) {
            passes.delete(key);
        }
    });
    return compiled;
}

/** Returns how many passes a device keeps compiled. */
export function getCompiledPresentationPassCount(device: GPUDevice): number {
    return compiledPassesByDevice.get(device)?.size ?? 0;
}
