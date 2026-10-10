// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import WorkerFrameStore, {
    MAXIMUM_SPARE_WORKER_TEXTURE_SLOT_COUNT,
    type KeptWorkerRawFrame,
    type WorkerFrameDescription
} from 'webgpu-player/presentation/WorkerFrameStore';
import type { TransferableRawVideoFrame } from 'webgpu-player/video/RawVideoFrameCopy';

import {
    PQ_FRAME_COLOR_SPACE,
    RAW_FRAME_DURATION_MICROSECONDS,
    RAW_FRAME_TIMESTAMP_MICROSECONDS,
    copyRawFrame,
    copyRawFramePair,
    createFakeDevice,
    createFakeVideoFrame,
    installWebGPUConstants
} from '../helpers/workerPresentationFakes';

const FIRST_GENERATION = 3;
const SECOND_GENERATION = 4;
const FRAME_WIDTH = 16;
const FRAME_HEIGHT = 8;
// I420P10 has a luma and two chroma planes
const PLANE_COUNT = 3;
// A Dolby Vision pair uploads the BL's planes and then the EL's
const PAIR_PLANE_COUNT = PLANE_COUNT * 2;
const UNKNOWN_FRAME_ID = 1_000;
// A texture limit below the frame's size, which the upload refuses
const SMALL_MAXIMUM_TEXTURE_DIMENSION = 4;
// A plane row stride the aligned upload layout never has
const MISALIGNED_BYTES_PER_ROW = 100;

function createDescription(generation: number): WorkerFrameDescription {
    return {
        durationMicroseconds: RAW_FRAME_DURATION_MICROSECONDS as Microseconds,
        encodedDolbyVisionMetadata: null,
        generation,
        HDR10PlusMetadata: null,
        mediaTimeMicroseconds: RAW_FRAME_TIMESTAMP_MICROSECONDS as Microseconds
    };
}

function requireRawFrame(store: WorkerFrameStore, generation: number, frameId: number): KeptWorkerRawFrame {
    const keptFrame = store.getFrame(generation, frameId);
    if (keptFrame?.outputMode !== 'raw-planes') {
        throw new Error('The store keeps no raw frame of that ID');
    }
    return keptFrame;
}

function copyI420P10Frame(): Promise<TransferableRawVideoFrame> {
    return copyRawFrame('I420P10', FRAME_WIDTH, FRAME_HEIGHT, PQ_FRAME_COLOR_SPACE);
}

beforeEach(() => {
    installWebGPUConstants();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('WorkerFrameStore', () => {
    it('keeps VideoFrames under IDs unique for the worker\'s life and closes each once released', () => {
        const store = new WorkerFrameStore();
        const firstFrame = createFakeVideoFrame(PQ_FRAME_COLOR_SPACE);
        const secondFrame = createFakeVideoFrame(PQ_FRAME_COLOR_SPACE);

        const firstFrameId = store.keepVideoFrame(createDescription(FIRST_GENERATION), firstFrame);
        const secondFrameId = store.keepVideoFrame(createDescription(SECOND_GENERATION), secondFrame);

        expect(secondFrameId).not.toBe(firstFrameId);
        expect(store.getFrame(FIRST_GENERATION, firstFrameId)?.outputMode).toBe('video-frame');
        // A frame is kept for its own generation only
        expect(store.getFrame(SECOND_GENERATION, firstFrameId)).toBeNull();
        expect(store.getFrameCount(FIRST_GENERATION)).toBe(1);

        expect(store.release(FIRST_GENERATION, [ firstFrameId, UNKNOWN_FRAME_ID, secondFrameId ])).toBe(1);
        expect(firstFrame.close).toHaveBeenCalledOnce();
        expect(secondFrame.close).not.toHaveBeenCalled();
        expect(store.getFrame(FIRST_GENERATION, firstFrameId)).toBeNull();
        // A second release of the same frame frees nothing more
        expect(store.release(FIRST_GENERATION, [ firstFrameId ])).toBe(0);
        expect(firstFrame.close).toHaveBeenCalledOnce();
    });

    it('takes a kept VideoFrame once for its presentation, which closes it, and keeps the frame until its release', () => {
        const store = new WorkerFrameStore();
        const frame = createFakeVideoFrame(PQ_FRAME_COLOR_SPACE);
        const frameId = store.keepVideoFrame(createDescription(FIRST_GENERATION), frame);
        const keptFrame = store.getFrame(FIRST_GENERATION, frameId);
        if (keptFrame?.outputMode !== 'video-frame') {
            throw new Error('The store keeps no VideoFrame');
        }

        expect(store.takeVideoFrame(keptFrame)).toBe(frame);
        expect(store.takeVideoFrame(keptFrame)).toBeNull();
        expect(store.release(FIRST_GENERATION, [ frameId ])).toBe(1);
        // The presentation that took the frame closes it, so the release does not close it again
        expect(frame.close).not.toHaveBeenCalled();
    });

    it('uploads a raw frame\'s planes as it keeps it, so the frame\'s buffer can serve the next frame at once', async () => {
        const deviceHarness = createFakeDevice();
        const store = new WorkerFrameStore();
        store.setDevice(deviceHarness.device);
        const rawFrame = await copyI420P10Frame();

        const frameId = store.keepRawFrame(createDescription(FIRST_GENERATION), rawFrame, undefined);

        const keptFrame = requireRawFrame(store, FIRST_GENERATION, frameId);
        expect(keptFrame.uploadState).toBe('uploaded');
        expect(keptFrame.textureSlot?.textureSet?.device).toBe(deviceHarness.device);
        expect(keptFrame.textureSlot?.enhancementTextureSet).toBeNull();
        expect(Object.prototype.hasOwnProperty.call(keptFrame, 'enhancementFrame')).toBe(false);
        expect(deviceHarness.createTexture).toHaveBeenCalledTimes(PLANE_COUNT);
        expect(deviceHarness.queueWriteTexture).toHaveBeenCalledTimes(PLANE_COUNT);
        expect(deviceHarness.queueWriteTexture.mock.calls.every((call: unknown[]) => call[1] === rawFrame.data)).toBe(true);
    });

    it('uploads a Dolby Vision pair\'s EL beside its BL, and keeps a pair whose EL did not decode as such', async () => {
        const deviceHarness = createFakeDevice();
        const store = new WorkerFrameStore();
        store.setDevice(deviceHarness.device);
        const framePair = await copyRawFramePair('I420P10', FRAME_WIDTH, FRAME_HEIGHT, true);
        const baseOnlyFramePair = await copyRawFramePair('I420P10', FRAME_WIDTH, FRAME_HEIGHT, false);

        const pairFrameId = store.keepRawFrame(
            createDescription(FIRST_GENERATION),
            framePair.baseFrame,
            framePair.enhancementFrame
        );
        const baseOnlyFrameId = store.keepRawFrame(
            createDescription(FIRST_GENERATION),
            baseOnlyFramePair.baseFrame,
            baseOnlyFramePair.enhancementFrame
        );

        const keptPair = requireRawFrame(store, FIRST_GENERATION, pairFrameId);
        expect(keptPair.enhancementFrame).toBe(framePair.enhancementFrame);
        expect(keptPair.textureSlot?.enhancementTextureSet?.format).toBe('I420P10');
        const keptBaseOnlyPair = requireRawFrame(store, FIRST_GENERATION, baseOnlyFrameId);
        expect(keptBaseOnlyPair.enhancementFrame).toBeNull();
        expect(keptBaseOnlyPair.textureSlot?.enhancementTextureSet).toBeNull();
        expect(deviceHarness.queueWriteTexture).toHaveBeenCalledTimes(PAIR_PLANE_COUNT + PLANE_COUNT);
    });

    it('reuses a released frame\'s texture slot, keeping as many spare slots as a raw run\'s credits', async () => {
        const deviceHarness = createFakeDevice();
        const store = new WorkerFrameStore();
        store.setDevice(deviceHarness.device);
        const keptFrameCount = MAXIMUM_SPARE_WORKER_TEXTURE_SLOT_COUNT + 1;
        const frameIds: number[] = [];
        for (let frameIndex = 0; frameIndex < keptFrameCount; frameIndex += 1) {
            frameIds.push(store.keepRawFrame(createDescription(FIRST_GENERATION), await copyI420P10Frame(), undefined));
        }
        expect(deviceHarness.createTexture).toHaveBeenCalledTimes(keptFrameCount * PLANE_COUNT);

        expect(store.release(FIRST_GENERATION, frameIds)).toBe(keptFrameCount);
        // The slot past the spare bound is destroyed
        expect(deviceHarness.textureDestroy).toHaveBeenCalledTimes(PLANE_COUNT);

        for (let frameIndex = 0; frameIndex < MAXIMUM_SPARE_WORKER_TEXTURE_SLOT_COUNT; frameIndex += 1) {
            store.keepRawFrame(createDescription(SECOND_GENERATION), await copyI420P10Frame(), undefined);
        }
        expect(deviceHarness.createTexture).toHaveBeenCalledTimes(keptFrameCount * PLANE_COUNT);
    });

    it('keeps a raw frame without planes while there is no device, and loses uploaded planes with their device', async () => {
        const firstDeviceHarness = createFakeDevice();
        const secondDeviceHarness = createFakeDevice();
        const store = new WorkerFrameStore();

        const unuploadedFrameId = store.keepRawFrame(createDescription(FIRST_GENERATION), await copyI420P10Frame(), undefined);
        expect(requireRawFrame(store, FIRST_GENERATION, unuploadedFrameId).uploadState).toBe('lost');

        store.setDevice(firstDeviceHarness.device);
        const uploadedFrameId = store.keepRawFrame(createDescription(FIRST_GENERATION), await copyI420P10Frame(), undefined);
        expect(requireRawFrame(store, FIRST_GENERATION, uploadedFrameId).uploadState).toBe('uploaded');

        store.setDevice(secondDeviceHarness.device);

        const lostFrame = requireRawFrame(store, FIRST_GENERATION, uploadedFrameId);
        expect(lostFrame.uploadState).toBe('lost');
        expect(lostFrame.textureSlot).toBeNull();
        expect(firstDeviceHarness.textureDestroy).toHaveBeenCalledTimes(PLANE_COUNT);
        const reuploadedFrameId = store.keepRawFrame(createDescription(FIRST_GENERATION), await copyI420P10Frame(), undefined);
        expect(requireRawFrame(store, FIRST_GENERATION, reuploadedFrameId).textureSlot?.textureSet?.device)
            .toBe(secondDeviceHarness.device);
    });

    it('refuses a raw frame whose layout the upload cannot read, and records an upload that failed', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const store = new WorkerFrameStore();
        const deviceHarness = createFakeDevice(SMALL_MAXIMUM_TEXTURE_DIMENSION);
        store.setDevice(deviceHarness.device);
        const rawFrame = await copyI420P10Frame();
        const misalignedFrame: TransferableRawVideoFrame = {
            ...rawFrame,
            planes: rawFrame.planes.map(plane => ({ ...plane, bytesPerRow: MISALIGNED_BYTES_PER_ROW }))
        };

        const misalignedFrameId = store.keepRawFrame(createDescription(FIRST_GENERATION), misalignedFrame, undefined);
        const oversizedFrameId = store.keepRawFrame(createDescription(FIRST_GENERATION), rawFrame, undefined);

        expect(requireRawFrame(store, FIRST_GENERATION, misalignedFrameId).uploadState).toBe('invalid-layout');
        expect(requireRawFrame(store, FIRST_GENERATION, oversizedFrameId).uploadState).toBe('upload-failed');
        expect(deviceHarness.queueWriteTexture).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledOnce();
    });

    it('frees one generation\'s frames at a stop, the others at a new run, and every frame at a detach', () => {
        const store = new WorkerFrameStore();
        const firstGenerationFrame = createFakeVideoFrame(PQ_FRAME_COLOR_SPACE);
        const secondGenerationFrame = createFakeVideoFrame(PQ_FRAME_COLOR_SPACE);
        store.keepVideoFrame(createDescription(FIRST_GENERATION), firstGenerationFrame);
        store.keepVideoFrame(createDescription(SECOND_GENERATION), secondGenerationFrame);

        store.releaseOtherGenerations(SECOND_GENERATION);
        expect(firstGenerationFrame.close).toHaveBeenCalledOnce();
        expect(store.getFrameCount(SECOND_GENERATION)).toBe(1);

        store.releaseGeneration(SECOND_GENERATION);
        expect(secondGenerationFrame.close).toHaveBeenCalledOnce();

        const remainingFrame = createFakeVideoFrame(PQ_FRAME_COLOR_SPACE);
        store.keepVideoFrame(createDescription(SECOND_GENERATION), remainingFrame);
        store.releaseAll();
        expect(remainingFrame.close).toHaveBeenCalledOnce();
        expect(store.getFrameCount(SECOND_GENERATION)).toBe(0);
    });
});
