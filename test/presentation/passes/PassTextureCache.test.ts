import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectPassTextures, PassTextureCache } from 'webgpu-player/presentation/passes/PassTextureCache';
import type { PassTexture, PresentationPlan } from 'webgpu-player/presentation/passes/PassTypes';

// WebGPU's flag values, which jsdom does not define
// eslint-disable-next-line @typescript-eslint/naming-convention
const GPU_TEXTURE_USAGE = { COPY_DST: 2, TEXTURE_BINDING: 4 } as const;
const LUT_SIZE = 4;
const RGBA8_BYTES_PER_TEXEL = 4;
const TABLE_WIDTH = 5;
const TABLE_HEIGHT = 3;

type MockTexture = { createView: ReturnType<typeof vi.fn>; descriptor: GPUTextureDescriptor; destroy: ReturnType<typeof vi.fn> };

function createTexture(name: string, identity: string, size: readonly [number, number, number], dimensions: PassTexture['dimensions']): PassTexture {
    return {
        data: new Uint8Array(size[0] * size[1] * size[2] * RGBA8_BYTES_PER_TEXEL),
        dimensions,
        edge: 'clamp',
        filter: 'linear',
        format: 'rgba8unorm',
        identity,
        name,
        size
    };
}

const LUT = createTexture('LUT', 'lut', [ LUT_SIZE, LUT_SIZE, LUT_SIZE ], 3);
const TABLE = createTexture('table', 'table', [ TABLE_WIDTH, TABLE_HEIGHT, 1 ], 2);

function createPlan(textures: readonly PassTexture[]): PresentationPlan {
    return {
        passTextures: textures.map((texture: PassTexture) => ({
            dimension: texture.dimensions === 3 ? '3d' as const : '2d' as const,
            edge: texture.edge,
            filter: texture.filter,
            format: texture.format,
            id: texture.identity,
            size: texture.size
        }))
    } as unknown as PresentationPlan;
}

function createDevice(): { device: GPUDevice; textures: MockTexture[]; writeTexture: ReturnType<typeof vi.fn> } {
    const textures: MockTexture[] = [];
    const writeTexture = vi.fn();
    const device = {
        createTexture: vi.fn((descriptor: GPUTextureDescriptor): MockTexture => {
            const texture = { createView: vi.fn(() => ({ descriptor })), descriptor, destroy: vi.fn() };
            textures.push(texture);
            return texture;
        }),
        queue: { writeTexture }
    } as unknown as GPUDevice;
    return { device, textures, writeTexture };
}

describe('PassTextureCache', () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, 'GPUTextureUsage', { configurable: true, value: GPU_TEXTURE_USAGE });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, 'GPUTextureUsage');
    });

    it('uploads each block once, the first time a plan binds it, in its dimension, with tightly packed rows and images', () => {
        const { device, textures, writeTexture } = createDevice();
        const cache = new PassTextureCache(device);
        const sources = collectPassTextures([ { textures: [ LUT, TABLE ] } ]);

        const firstViews = cache.acquire(createPlan([ LUT ]), sources);
        const secondViews = cache.acquire(createPlan([ LUT, TABLE ]), sources);

        expect(textures.map(texture => texture.descriptor)).toEqual([
            expect.objectContaining({ dimension: '3d', format: 'rgba8unorm', size: { depthOrArrayLayers: LUT_SIZE, height: LUT_SIZE, width: LUT_SIZE } }),
            expect.objectContaining({ dimension: '2d', size: { depthOrArrayLayers: 1, height: TABLE_HEIGHT, width: TABLE_WIDTH } })
        ]);
        expect(writeTexture.mock.calls[0][2]).toEqual({ bytesPerRow: LUT_SIZE * RGBA8_BYTES_PER_TEXEL, rowsPerImage: LUT_SIZE });
        expect(secondViews.get('lut')).toBe(firstViews.get('lut'));
        expect(() => cache.acquire(createPlan([ LUT ]), new Map())).not.toThrow();
        expect(() => cache.acquire(createPlan([ TABLE ]), new Map())).not.toThrow();
    });

    it('releases the uploads a new preset no longer holds, and refuses a planned block no pass holds', () => {
        const { device, textures } = createDevice();
        const cache = new PassTextureCache(device);
        cache.acquire(createPlan([ LUT, TABLE ]), collectPassTextures([ { textures: [ LUT, TABLE ] } ]));

        cache.retain(new Set([ 'table' ]));

        expect(textures[0].destroy).toHaveBeenCalledOnce();
        expect(textures[1].destroy).not.toHaveBeenCalled();
        expect(() => cache.acquire(createPlan([ LUT ]), new Map())).toThrow('texture-upload: no pass holds texture block lut');
    });
});
