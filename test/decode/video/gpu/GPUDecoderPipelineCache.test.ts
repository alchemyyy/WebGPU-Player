import { describe, expect, it } from 'vitest';

import type { DecoderPackageVersion } from 'webgpu-player/decode/packages/DecoderPackageIdentity';
import { GPU_DECODER_OUTPUT_FORMATS, type GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { type GPUDecoderCompiledPipelines, getCompiledGPUDecoder } from 'webgpu-player/decode/video/gpu/GPUDecoderPipelineCache';

// One package in two versions, and another package
const PACKAGE: DecoderPackageVersion = { contentHash: 'a1'.repeat(32), id: 'hevc' };
const REBUILT_PACKAGE: DecoderPackageVersion = { contentHash: 'a2'.repeat(32), id: 'hevc' };
const OTHER_PACKAGE: DecoderPackageVersion = { contentHash: 'b2'.repeat(32), id: 'mpeg2' };
const FORMAT: GPUDecoderOutputFormat = 'I420';
const OTHER_FORMAT: GPUDecoderOutputFormat = 'I420P10';
// Enough package ids that any count limit would have dropped some of their decoders
const MANY_PACKAGE_COUNT = 12;
const COMPILE_FAILURE_MESSAGE = 'compile-error: line 3:7 unresolved identifier';

/** Counts the compiles a test's calls start, each making a distinct compiled decoder. */
type CompileCounter = {
    compile: () => Promise<GPUDecoderCompiledPipelines>
    count: () => number
};

/** A compile the test settles itself. */
type PendingCompile = {
    compile: () => Promise<GPUDecoderCompiledPipelines>
    reject: (error: Error) => void
};

function createDevice(): GPUDevice {
    return {} as GPUDevice;
}

function createCompiledPipelines(): GPUDecoderCompiledPipelines {
    return { bindGroupLayout: {} as GPUBindGroupLayout, pipelines: new Map<string, GPUComputePipeline>() };
}

function createCompileCounter(): CompileCounter {
    let compileCount = 0;
    return {
        compile: (): Promise<GPUDecoderCompiledPipelines> => {
            compileCount += 1;
            return Promise.resolve(createCompiledPipelines());
        },
        count: (): number => compileCount
    };
}

function createPendingCompile(): PendingCompile {
    let rejectCompile: (error: Error) => void = (): void => undefined;
    const compiled = new Promise<GPUDecoderCompiledPipelines>((_resolve, reject): void => {
        rejectCompile = reject;
    });
    return { compile: (): Promise<GPUDecoderCompiledPipelines> => compiled, reject: rejectCompile };
}

describe('getCompiledGPUDecoder', () => {
    it('keeps a compiled decoder per device, package id, and output format', async () => {
        const device = createDevice();
        const counter = createCompileCounter();

        const first = await getCompiledGPUDecoder(device, PACKAGE, FORMAT, counter.compile);
        const second = await getCompiledGPUDecoder(device, PACKAGE, FORMAT, counter.compile);
        expect(second).toBe(first);
        expect(counter.count()).toBe(1);

        await getCompiledGPUDecoder(device, PACKAGE, OTHER_FORMAT, counter.compile);
        await getCompiledGPUDecoder(device, OTHER_PACKAGE, FORMAT, counter.compile);
        await getCompiledGPUDecoder(createDevice(), PACKAGE, FORMAT, counter.compile);
        expect(counter.count()).toBe(4);
    });

    it('shares one compile between sessions created at once', async () => {
        const device = createDevice();
        const counter = createCompileCounter();

        const [ first, second ] = await Promise.all([
            getCompiledGPUDecoder(device, PACKAGE, FORMAT, counter.compile),
            getCompiledGPUDecoder(device, PACKAGE, FORMAT, counter.compile)
        ]);

        expect(second).toBe(first);
        expect(counter.count()).toBe(1);
    });

    it('keeps no failed compile, so the next session compiles again', async () => {
        const device = createDevice();
        const counter = createCompileCounter();
        const failingCompile = (): Promise<GPUDecoderCompiledPipelines> => Promise.reject(new Error(COMPILE_FAILURE_MESSAGE));

        await expect(getCompiledGPUDecoder(device, PACKAGE, FORMAT, failingCompile)).rejects.toThrow(COMPILE_FAILURE_MESSAGE);
        await getCompiledGPUDecoder(device, PACKAGE, FORMAT, counter.compile);

        expect(counter.count()).toBe(1);
    });

    it('replaces every decoder of a package\'s version with its new version\'s, and the old version compiles again', async () => {
        const device = createDevice();
        const counter = createCompileCounter();
        const firstVersion = await getCompiledGPUDecoder(device, PACKAGE, FORMAT, counter.compile);
        await getCompiledGPUDecoder(device, PACKAGE, OTHER_FORMAT, counter.compile);

        const rebuilt = await getCompiledGPUDecoder(device, REBUILT_PACKAGE, FORMAT, counter.compile);
        expect(rebuilt).not.toBe(firstVersion);
        expect(counter.count()).toBe(3);
        // The old version's other format left with it
        await getCompiledGPUDecoder(device, REBUILT_PACKAGE, OTHER_FORMAT, counter.compile);
        expect(counter.count()).toBe(4);
        await getCompiledGPUDecoder(device, REBUILT_PACKAGE, FORMAT, counter.compile);
        expect(counter.count()).toBe(4);

        await getCompiledGPUDecoder(device, PACKAGE, FORMAT, counter.compile);
        expect(counter.count()).toBe(5);
    });

    it('keeps a new version\'s decoder when a replaced version\'s compile fails afterwards', async () => {
        const device = createDevice();
        const counter = createCompileCounter();
        const pendingCompile = createPendingCompile();
        const replacedCompile = getCompiledGPUDecoder(device, PACKAGE, FORMAT, pendingCompile.compile);
        const rebuilt = await getCompiledGPUDecoder(device, REBUILT_PACKAGE, FORMAT, counter.compile);

        pendingCompile.reject(new Error(COMPILE_FAILURE_MESSAGE));
        await expect(replacedCompile).rejects.toThrow(COMPILE_FAILURE_MESSAGE);

        expect(await getCompiledGPUDecoder(device, REBUILT_PACKAGE, FORMAT, counter.compile)).toBe(rebuilt);
        expect(counter.count()).toBe(1);
    });

    it('keeps every package id and output format it compiled, with no count limit', async () => {
        const device = createDevice();
        const counter = createCompileCounter();
        const packages: DecoderPackageVersion[] = [];
        for (let packageIndex = 0; packageIndex < MANY_PACKAGE_COUNT; packageIndex += 1) {
            packages.push({ contentHash: PACKAGE.contentHash, id: `decoder-${packageIndex}` });
        }
        for (const decoderPackage of packages) {
            for (const format of GPU_DECODER_OUTPUT_FORMATS) {
                await getCompiledGPUDecoder(device, decoderPackage, format, counter.compile);
            }
        }
        const compileCount = counter.count();
        expect(compileCount).toBe(MANY_PACKAGE_COUNT * GPU_DECODER_OUTPUT_FORMATS.length);

        for (const decoderPackage of packages) {
            for (const format of GPU_DECODER_OUTPUT_FORMATS) {
                await getCompiledGPUDecoder(device, decoderPackage, format, counter.compile);
            }
        }
        expect(counter.count()).toBe(compileCount);
    });
});
