import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FRAME_POOL_LAYOUT_BYTE_LENGTH } from 'webgpu-player/presentation/passes/PassResources';
import { GPU_FRAME_POOL_MAXIMUM_SLOT_COUNT } from 'webgpu-player/video/gpu-decode/GPUDecodeLimits';
import GPUFramePool, {
    createGPUFramePoolLayout,
    getGPUFramePoolSlotCount,
    GPU_FRAME_POOL_ALIGNMENT,
    GPU_FRAME_POOL_PRESENTATION_SLOT_COUNT,
    GPU_FRAME_POOL_STATUS_SPARE_SLOT_COUNT,
    isGPUFramePoolWithinLimits
} from 'webgpu-player/video/gpu-decode/GPUFramePool';

import { MockGPUDevice } from './mockGPUDevice';
import { installWebGPUGlobals } from './webGPUGlobals';

const FULL_HD_WIDTH = 1920;
const FULL_HD_HEIGHT = 1080;
const FULL_HD_LUMA_BYTES_PER_ROW = 2048;
const FULL_HD_CHROMA_BYTES_PER_ROW = 1024;
const ODD_WIDTH = 1921;
const ODD_HEIGHT = 1081;
const HD_WIDTH = 1280;
const HD_HEIGHT = 720;
const UHD_WIDTH = 3840;
const UHD_HEIGHT = 2160;
const SIXTEEN_BIT_UHD_BYTES_PER_ROW = 7680;
const REFERENCES = 4;
const REORDER = 2;
const SLOT_COUNT = 3;
const ADDRESS_SPACE_BYTE_LENGTH = 2 ** 32;
const VISIBLE_RECTANGLE = { height: FULL_HD_HEIGHT, width: FULL_HD_WIDTH, x: 0, y: 0 };
const POOL_USAGE = 128 | 4 | 8;
const LAYOUT_USAGE = 64 | 8;
const SLOT_BYTE_OFFSET_WORD = 12;
const BYTES_PER_COMPONENT_WORD = 13;
const PLANE_COUNT_WORD = 14;

describe('frame pool layout', () => {
    it('counts references, reorder depth, presentation slots, and spares only for references', () => {
        expect(getGPUFramePoolSlotCount(0, 0)).toBe(GPU_FRAME_POOL_PRESENTATION_SLOT_COUNT);
        expect(getGPUFramePoolSlotCount(0, REORDER)).toBe(REORDER + GPU_FRAME_POOL_PRESENTATION_SLOT_COUNT);
        expect(getGPUFramePoolSlotCount(REFERENCES, REORDER)).toBe(
            REFERENCES + REORDER + GPU_FRAME_POOL_PRESENTATION_SLOT_COUNT + GPU_FRAME_POOL_STATUS_SPARE_SLOT_COUNT
        );
    });

    it('aligns every row and plane of an 8-bit 4:2:0 slot to 256 bytes', () => {
        const layout = createGPUFramePoolLayout('I420', FULL_HD_WIDTH, FULL_HD_HEIGHT, SLOT_COUNT);

        const lumaByteLength = FULL_HD_LUMA_BYTES_PER_ROW * FULL_HD_HEIGHT;
        const chromaByteLength = FULL_HD_CHROMA_BYTES_PER_ROW * (FULL_HD_HEIGHT / 2);
        expect(layout.planes).toEqual([
            { byteOffset: 0, bytesPerRow: FULL_HD_LUMA_BYTES_PER_ROW, height: FULL_HD_HEIGHT, width: FULL_HD_WIDTH },
            { byteOffset: lumaByteLength, bytesPerRow: FULL_HD_CHROMA_BYTES_PER_ROW, height: FULL_HD_HEIGHT / 2, width: FULL_HD_WIDTH / 2 },
            {
                byteOffset: lumaByteLength + chromaByteLength,
                bytesPerRow: FULL_HD_CHROMA_BYTES_PER_ROW,
                height: FULL_HD_HEIGHT / 2,
                width: FULL_HD_WIDTH / 2
            }
        ]);
        expect(layout.slotByteLength).toBe(lumaByteLength + 2 * chromaByteLength);
        expect(layout.slotByteLength % GPU_FRAME_POOL_ALIGNMENT).toBe(0);
        expect(layout.byteLength).toBe(layout.slotByteLength * SLOT_COUNT);
        expect(layout.bytesPerSample).toBe(1);
    });

    it('rounds subsampled chroma of odd sizes up, as the raw plane route does', () => {
        const layout = createGPUFramePoolLayout('I420', ODD_WIDTH, ODD_HEIGHT, SLOT_COUNT);

        expect(layout.planes.map(plane => [ plane.width, plane.height ])).toEqual([
            [ ODD_WIDTH, ODD_HEIGHT ],
            [ Math.ceil(ODD_WIDTH / 2), Math.ceil(ODD_HEIGHT / 2) ],
            [ Math.ceil(ODD_WIDTH / 2), Math.ceil(ODD_HEIGHT / 2) ]
        ]);
        for (const plane of layout.planes) {
            expect(plane.bytesPerRow % GPU_FRAME_POOL_ALIGNMENT).toBe(0);
            expect(plane.byteOffset % GPU_FRAME_POOL_ALIGNMENT).toBe(0);
            expect(plane.bytesPerRow).toBeGreaterThanOrEqual(plane.width);
        }
    });

    it('stores 16-bit samples for high bit depths and keeps 4:2:2 chroma at full height', () => {
        const layout = createGPUFramePoolLayout('I422P10', HD_WIDTH, HD_HEIGHT, SLOT_COUNT);
        const uhdLayout = createGPUFramePoolLayout('I444P12', UHD_WIDTH, UHD_HEIGHT, 1);

        expect(layout.bytesPerSample).toBe(2);
        expect(layout.planes.map(plane => [ plane.width, plane.height, plane.bytesPerRow ])).toEqual([
            [ HD_WIDTH, HD_HEIGHT, HD_WIDTH * 2 ],
            [ HD_WIDTH / 2, HD_HEIGHT, HD_WIDTH ],
            [ HD_WIDTH / 2, HD_HEIGHT, HD_WIDTH ]
        ]);
        expect(uhdLayout.slotByteLength).toBe(3 * SIXTEEN_BIT_UHD_BYTES_PER_ROW * UHD_HEIGHT);
    });

    it.each([
        [ 'an empty size', 0, FULL_HD_HEIGHT, SLOT_COUNT, 'positive integer coded size' ],
        [ 'a fractional size', FULL_HD_WIDTH + 0.5, FULL_HD_HEIGHT, SLOT_COUNT, 'positive integer coded size' ],
        [ 'no slots', FULL_HD_WIDTH, FULL_HD_HEIGHT, 0, 'holds 1 to 32 slots' ],
        [ 'more slots than a freed-slot mask names', FULL_HD_WIDTH, FULL_HD_HEIGHT, GPU_FRAME_POOL_MAXIMUM_SLOT_COUNT + 1, 'holds 1 to 32 slots' ],
        [ 'more bytes than WGSL addresses', 16_384, 16_384, GPU_FRAME_POOL_MAXIMUM_SLOT_COUNT, 'exceeds what WGSL addresses' ]
    ])('rejects %s', (_description: string, width: number, height: number, slotCount: number, message: string) => {
        expect(() => createGPUFramePoolLayout('I420', width, height, slotCount)).toThrow(message);
    });

    it('checks a pool against both storage buffer limits', () => {
        const layout = createGPUFramePoolLayout('I420P10', UHD_WIDTH, UHD_HEIGHT, SLOT_COUNT);

        expect(layout.byteLength).toBeLessThan(ADDRESS_SPACE_BYTE_LENGTH);
        expect(isGPUFramePoolWithinLimits(layout, { maxBufferSize: layout.byteLength, maxStorageBufferBindingSize: layout.byteLength })).toBe(true);
        expect(isGPUFramePoolWithinLimits(layout, { maxBufferSize: layout.byteLength - 1, maxStorageBufferBindingSize: layout.byteLength })).toBe(false);
        expect(isGPUFramePoolWithinLimits(layout, { maxBufferSize: layout.byteLength, maxStorageBufferBindingSize: layout.byteLength - 1 })).toBe(false);
    });
});

describe('GPUFramePool', () => {
    let restoreGlobals: () => void = (): void => undefined;

    beforeEach(() => {
        restoreGlobals = installWebGPUGlobals();
    });

    afterEach(() => {
        restoreGlobals();
    });

    function createPool(device: MockGPUDevice, slotCount: number = SLOT_COUNT): GPUFramePool {
        return new GPUFramePool(device.asDevice(), createGPUFramePoolLayout('I420', FULL_HD_WIDTH, FULL_HD_HEIGHT, slotCount), VISIBLE_RECTANGLE);
    }

    it('creates one pool buffer and a layout uniform per slot that names the slot', () => {
        const device = new MockGPUDevice();

        const pool = createPool(device);

        const poolBuffer = device.findBuffer('GPU decode frame pool');
        expect(poolBuffer.size).toBe(pool.layout.byteLength);
        expect(poolBuffer.usage).toBe(POOL_USAGE);
        for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
            const frame = pool.getFrame(slot);
            const layoutBuffer = device.findBuffer(`GPU decode frame pool slot ${slot} layout`);
            const words = layoutBuffer.readWords(0, FRAME_POOL_LAYOUT_BYTE_LENGTH / 4);
            expect(frame.layout).toBe(layoutBuffer);
            expect(frame.pool).toBe(poolBuffer);
            expect(layoutBuffer.usage).toBe(LAYOUT_USAGE);
            expect(words[SLOT_BYTE_OFFSET_WORD]).toBe(slot * pool.layout.slotByteLength);
            expect(words[BYTES_PER_COMPONENT_WORD]).toBe(1);
            expect(words[PLANE_COUNT_WORD]).toBe(3);
            expect([ ...words.slice(0, 4) ]).toEqual([ 0, FULL_HD_LUMA_BYTES_PER_ROW, FULL_HD_WIDTH, FULL_HD_HEIGHT ]);
            expect(pool.getSlotByteOffset(slot)).toBe(slot * pool.layout.slotByteLength);
        }
        expect(pool.getFrame(0)).toEqual({
            codedHeight: FULL_HD_HEIGHT,
            codedWidth: FULL_HD_WIDTH,
            layout: device.findBuffer('GPU decode frame pool slot 0 layout'),
            pool: poolBuffer,
            visibleRectangle: VISIBLE_RECTANGLE
        });
    });

    it('refuses a pool beyond the device limits', () => {
        const layout = createGPUFramePoolLayout('I420', FULL_HD_WIDTH, FULL_HD_HEIGHT, SLOT_COUNT);
        const device = new MockGPUDevice([], { maxStorageBufferBindingSize: layout.byteLength - 1 });

        expect(() => new GPUFramePool(device.asDevice(), layout, VISIBLE_RECTANGLE)).toThrow("beyond the device's storage buffer limits");
    });

    it('frees an output slot of a decoder without references when presentation releases it', () => {
        const pool = createPool(new MockGPUDevice());

        const slots = [ pool.acquireSlot(false), pool.acquireSlot(false), pool.acquireSlot(false) ];

        expect(slots).toEqual([ 0, 1, 2 ]);
        expect(pool.acquireSlot(false)).toBeNull();
        expect(pool.releaseOutput(1)).toBe(true);
        expect(pool.releaseOutput(1)).toBe(false);
        expect(pool.getFreeSlotCount()).toBe(1);
        expect(pool.acquireSlot(false)).toBe(1);
    });

    it('keeps a reference slot until both presentation and the decoder release it', () => {
        const pool = createPool(new MockGPUDevice());
        const slot = pool.acquireSlot(true);
        if (slot === null) {
            throw new Error('No slot was free');
        }

        pool.releaseOutput(slot);
        const freeAfterPresentation = pool.getFreeSlotCount();
        const referenceReleased = pool.releaseReference(slot);

        expect(freeAfterPresentation).toBe(SLOT_COUNT - 1);
        expect(referenceReleased).toBe(true);
        expect(pool.getFreeSlotCount()).toBe(SLOT_COUNT);
    });

    it('drops every reference at once, as a reset does', () => {
        const pool = createPool(new MockGPUDevice());
        const firstSlot = pool.acquireSlot(true);
        const secondSlot = pool.acquireSlot(true);
        if (firstSlot === null || secondSlot === null) {
            throw new Error('No slot was free');
        }
        pool.releaseOutput(firstSlot);
        pool.releaseOutput(secondSlot);

        pool.releaseAllReferences();

        expect(pool.isReferenceHeld(firstSlot)).toBe(false);
        expect(pool.getFreeSlotCount()).toBe(SLOT_COUNT);
    });

    it('rejects a slot outside the pool', () => {
        const pool = createPool(new MockGPUDevice());

        expect(() => pool.releaseOutput(SLOT_COUNT)).toThrow(`Frame pool slot ${SLOT_COUNT} does not exist`);
        expect(() => pool.getFrame(-1)).toThrow('does not exist');
    });

    it('destroys its buffers', () => {
        const device = new MockGPUDevice();
        const pool = createPool(device);

        pool.destroy();

        expect(device.buffers.every(buffer => buffer.destroyed)).toBe(true);
    });
});
