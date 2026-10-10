import { describe, expect, it, vi } from 'vitest';

import WorkerWASMInstanceCache, { isWASMTrap } from 'webgpu-player/video/decoders/WorkerWASMInstanceCache';

type FakeInstance = {
    name: string
};

const FIRST_SOURCE = 'https://example.test/first.wasm';
const SECOND_SOURCE = 'https://example.test/second.wasm';
const WASM_TRAP_MESSAGE = 'unreachable';

function createInstantiation(): ReturnType<typeof vi.fn<() => Promise<FakeInstance>>> {
    let instanceCount = 0;
    return vi.fn(async (): Promise<FakeInstance> => {
        instanceCount += 1;
        return { name: `instance ${instanceCount}` };
    });
}

describe('WorkerWASMInstanceCache', () => {
    it('instantiates once per source, also for concurrent loads', async () => {
        const cache = new WorkerWASMInstanceCache<FakeInstance>();
        const instantiate = createInstantiation();

        const concurrentInstances = await Promise.all([
            cache.load(FIRST_SOURCE, instantiate),
            cache.load(FIRST_SOURCE, instantiate)
        ]);
        const laterInstance = await cache.load(FIRST_SOURCE, instantiate);

        expect(instantiate).toHaveBeenCalledOnce();
        expect(concurrentInstances[1]).toBe(concurrentInstances[0]);
        expect(laterInstance).toBe(concurrentInstances[0]);
    });

    it('replaces the instance for another source', async () => {
        const cache = new WorkerWASMInstanceCache<FakeInstance>();
        const instantiate = createInstantiation();

        const firstInstance = await cache.load(FIRST_SOURCE, instantiate);
        const secondInstance = await cache.load(SECOND_SOURCE, instantiate);

        expect(secondInstance).not.toBe(firstInstance);
        expect(instantiate).toHaveBeenCalledTimes(2);
    });

    it('forgets a failed instantiation so the next load retries it', async () => {
        const cache = new WorkerWASMInstanceCache<FakeInstance>();
        const instantiationError = new Error('instantiation failed');
        const instantiate = createInstantiation();
        instantiate.mockRejectedValueOnce(instantiationError);

        await expect(cache.load(FIRST_SOURCE, instantiate)).rejects.toBe(instantiationError);
        await expect(cache.load(FIRST_SOURCE, instantiate)).resolves.toEqual({ name: 'instance 1' });
        expect(instantiate).toHaveBeenCalledTimes(2);
    });

    it('discards only the cached instance', async () => {
        const cache = new WorkerWASMInstanceCache<FakeInstance>();
        const instantiate = createInstantiation();
        const cachedInstance = await cache.load(FIRST_SOURCE, instantiate);

        cache.discard({ name: 'an instance it never made' });
        expect(await cache.load(FIRST_SOURCE, instantiate)).toBe(cachedInstance);
        cache.discard(cachedInstance);
        const freshInstance = await cache.load(FIRST_SOURCE, instantiate);

        expect(freshInstance).not.toBe(cachedInstance);
        expect(instantiate).toHaveBeenCalledTimes(2);
    });
});

describe('isWASMTrap', () => {
    it('recognizes a WebAssembly runtime error only', () => {
        expect(isWASMTrap(new WebAssembly.RuntimeError(WASM_TRAP_MESSAGE))).toBe(true);
        expect(isWASMTrap(new Error(WASM_TRAP_MESSAGE))).toBe(false);
        expect(isWASMTrap(WASM_TRAP_MESSAGE)).toBe(false);
    });
});
