import { describe, expect, it, vi } from 'vitest';

import {
    getCompiledPresentationPass,
    getCompiledPresentationPassCount,
    PRESENTATION_PIPELINE_CACHE_CAPACITY,
    type CompiledPresentationPass
} from 'webgpu-player/presentation/passes/PresentationPipelineCache';

function createDevice(): GPUDevice {
    return {} as GPUDevice;
}

function createCompiledPass(): CompiledPresentationPass {
    return { bindGroupLayout: {} as GPUBindGroupLayout, pipeline: { kind: 'render', pipeline: {} as GPURenderPipeline } };
}

function compileOnce(): () => Promise<CompiledPresentationPass> {
    return vi.fn((): Promise<CompiledPresentationPass> => Promise.resolve(createCompiledPass()));
}

describe('getCompiledPresentationPass', () => {
    it('compiles a pass once per device and key, sharing a compile in progress', async () => {
        const device = createDevice();
        const otherDevice = createDevice();
        const compile = compileOnce();

        const [ first, second ] = await Promise.all([
            getCompiledPresentationPass(device, 'pass', compile),
            getCompiledPresentationPass(device, 'pass', compile)
        ]);
        await getCompiledPresentationPass(otherDevice, 'pass', compile);

        expect(second).toBe(first);
        expect(compile).toHaveBeenCalledTimes(2);
    });

    it('keeps at most its capacity of passes, dropping the least recently used first', async () => {
        const device = createDevice();
        for (let index = 0; index < PRESENTATION_PIPELINE_CACHE_CAPACITY; index += 1) {
            await getCompiledPresentationPass(device, `pass ${index}`, compileOnce());
        }
        // A use makes the oldest pass the most recently used, so the next pass drops the second oldest
        await getCompiledPresentationPass(device, 'pass 0', compileOnce());
        await getCompiledPresentationPass(device, 'pass beyond capacity', compileOnce());

        expect(getCompiledPresentationPassCount(device)).toBe(PRESENTATION_PIPELINE_CACHE_CAPACITY);
        const keptCompile = compileOnce();
        await getCompiledPresentationPass(device, 'pass 0', keptCompile);
        expect(keptCompile).not.toHaveBeenCalled();
        const droppedCompile = compileOnce();
        await getCompiledPresentationPass(device, 'pass 1', droppedCompile);
        expect(droppedCompile).toHaveBeenCalledOnce();
    });

    it('drops a compile that fails, so the next build compiles again', async () => {
        const device = createDevice();
        const failure = new Error('compile failed');

        await expect(getCompiledPresentationPass(device, 'pass', () => Promise.reject(failure))).rejects.toBe(failure);
        const retry = compileOnce();
        await getCompiledPresentationPass(device, 'pass', retry);

        expect(retry).toHaveBeenCalledOnce();
    });
});
