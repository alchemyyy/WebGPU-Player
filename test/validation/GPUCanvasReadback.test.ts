import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ColorTriplet } from 'webgpu-player/color/ColorPipeline';
import { GPUCanvasPixelReader, type GPUCanvasPixelSample } from 'webgpu-player/validation/GPUCanvasReadback';

import {
    createDeferred,
    createWebGPUDeviceHarness,
    installErrorScopeStack,
    installWebGPUGlobals,
    type MockGPUTexture,
    type ScopedCommandBuffer
} from '../helpers/webGPUDeviceHarness';

const HEALTHY_FORMAT: GPUTextureFormat = 'bgra8unorm';
// The texture whose copies the scope stack rejects, while the reader copying the HEALTHY_FORMAT texture beside it is valid
const FAULTY_FORMAT: GPUTextureFormat = 'rgba8unorm';
const SAMPLES: readonly GPUCanvasPixelSample[] = [ { sampleX: 0, sampleY: 0 } ];
// Exact in 8 bits, so the decoded texel equals it
const TEXEL_COLOR: ColorTriplet = [ 1, 0, 1 ];
const TEXTURE_SIZE = 1;
const CONCURRENT_READBACK_COUNT = 2;
const SIMULATED_COPY_ERROR = 'invalid copy source';

let restoreWebGPUGlobals: () => void = (): void => undefined;

function copiesFormat(commandBuffers: readonly ScopedCommandBuffer[], format: GPUTextureFormat): boolean {
    return commandBuffers.some((commandBuffer: ScopedCommandBuffer): boolean => commandBuffer.copiedTextures.some(
        (texture: MockGPUTexture): boolean => texture.format === format
    ));
}

describe('GPUCanvasPixelReader', () => {
    beforeEach(() => {
        restoreWebGPUGlobals = installWebGPUGlobals();
    });

    afterEach(() => {
        restoreWebGPUGlobals();
    });

    it('gives concurrent readbacks each their own validation scope, failing a faulty copy and reading a healthy one', async () => {
        // No mapping settles before both copies are submitted, so a scope held across that wait would be open across the other reader's submission
        const allSubmitted = createDeferred<undefined>();
        let mappingCount = 0;
        const harness = createWebGPUDeviceHarness({
            mapAsync: (): Promise<void> => {
                mappingCount += 1;
                if (mappingCount === CONCURRENT_READBACK_COUNT) {
                    allSubmitted.resolve(undefined);
                }
                return allSubmitted.promise;
            },
            readPixel: (): ColorTriplet => TEXEL_COLOR
        });
        const scopes = installErrorScopeStack(harness, (commandBuffers: readonly ScopedCommandBuffer[]): string | null => (
            copiesFormat(commandBuffers, FAULTY_FORMAT) ? SIMULATED_COPY_ERROR : null
        ));
        const createSource = (format: GPUTextureFormat): GPUTexture => harness.device.createTexture({
            format,
            size: { height: TEXTURE_SIZE, width: TEXTURE_SIZE },
            usage: GPUTextureUsage.COPY_SRC
        });
        const faultyReader = new GPUCanvasPixelReader({ device: harness.device, format: FAULTY_FORMAT, maximumReadbacks: SAMPLES.length });
        const healthyReader = new GPUCanvasPixelReader({ device: harness.device, format: HEALTHY_FORMAT, maximumReadbacks: SAMPLES.length });

        const [ faultyReadback, healthyReadback ] = await Promise.all([
            faultyReader.readPixels(SAMPLES, createSource(FAULTY_FORMAT)),
            healthyReader.readPixels(SAMPLES, createSource(HEALTHY_FORMAT))
        ]);

        expect(faultyReadback).toEqual({ failure: { code: 'validation-error', message: SIMULATED_COPY_ERROR }, linearRGB: null });
        expect(healthyReadback).toEqual({ failure: null, linearRGB: [ TEXEL_COLOR ] });
        expect(mappingCount).toBe(CONCURRENT_READBACK_COUNT);
        expect(scopes.openScopeCount).toBe(0);
    });
});
