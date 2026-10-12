import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type CustomPlaybackController from 'webgpu-player/pipeline/CustomPlaybackController';
import CustomPlaybackFrameLoop, { CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS } from 'webgpu-player/pipeline/CustomPlaybackFrameLoop';
import type WebGPUPresenter from 'webgpu-player/presentation/WebGPUPresenter';
import type { DecodedPresentationFrame } from 'webgpu-player/presentation/WebGPUPresenter';

const FIRST_GENERATION = 3;
const NEXT_GENERATION = 4;
const RAW_PLANES_FRAME = { outputMode: 'raw-planes' } as unknown as DecodedPresentationFrame;
const VIDEO_FRAME = { outputMode: 'video-frame' } as unknown as DecodedPresentationFrame;
const DRAIN_FAILURE = new Error('drain-failed: worker closed');
const NOT_SUBMITTED_MESSAGE = 'Decoded frame did not reach WebGPU submission';
const RELEASE_UNACKNOWLEDGED_MESSAGE = 'Decoded frame GPU release could not be acknowledged';
const ANIMATION_FRAMES_UNAVAILABLE_MESSAGE = 'requestAnimationFrame is unavailable';

type FakeController = {
    drainBackgroundVideo: Mock
    notifyFrameDiscarded: Mock
    notifyFramePresented: Mock
    playbackState: string
    setPageVisibility: Mock
    takeCurrentFrame: Mock
};

type FakePresenter = {
    getTelemetry: Mock
    presentDecodedFrame: Mock
};

type LoopHarness = Readonly<{
    controller: FakeController
    current: { value: boolean }
    failures: unknown[]
    loop: CustomPlaybackFrameLoop
    presenter: FakePresenter
}>;

const animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrame = 1;

/** Runs the pending animation frames once, as one display refresh does. */
function runAnimationFrames(): void {
    const callbacks = [ ...animationFrames.values() ];
    animationFrames.clear();
    for (const callback of callbacks) {
        callback(0);
    }
}

function createHarness(): LoopHarness {
    const controller: FakeController = {
        drainBackgroundVideo: vi.fn(),
        notifyFrameDiscarded: vi.fn(() => true),
        notifyFramePresented: vi.fn(() => true),
        playbackState: 'playing',
        setPageVisibility: vi.fn(() => false),
        takeCurrentFrame: vi.fn(() => RAW_PLANES_FRAME)
    };
    const presenter: FakePresenter = {
        getTelemetry: vi.fn(() => ({ state: 'presenting' })),
        presentDecodedFrame: vi.fn(() => true)
    };
    const current = { value: true };
    const failures: unknown[] = [];
    const loop = new CustomPlaybackFrameLoop({
        controller: controller as unknown as CustomPlaybackController,
        isCurrent: (): boolean => current.value,
        onFailure: (error: unknown): void => {
            failures.push(error);
        },
        presenter: presenter as unknown as WebGPUPresenter,
        presentationGeneration: FIRST_GENERATION
    });
    return { controller, current, failures, loop, presenter };
}

/** Fakes the drain timer only; the suite's own animation frame stub stays in place. */
function useFakeTimers(): void {
    vi.useFakeTimers({ toFake: [ 'setInterval', 'clearInterval' ] });
}

function getFailureMessages(failures: readonly unknown[]): string[] {
    return failures.map((failure: unknown): string => (failure instanceof Error ? failure.message : String(failure)));
}

describe('CustomPlaybackFrameLoop', () => {
    beforeEach(() => {
        animationFrames.clear();
        nextAnimationFrame = 1;
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback): number => {
            const identifier = nextAnimationFrame;
            nextAnimationFrame += 1;
            animationFrames.set(identifier, callback);
            return identifier;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn((identifier: number): void => {
            animationFrames.delete(identifier);
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('presents the current frame every animation frame while playing, in the current generation', () => {
        const { controller, loop, presenter } = createHarness();

        loop.schedule(true);
        loop.schedule(true);
        expect(animationFrames.size).toBe(1);
        runAnimationFrames();
        runAnimationFrames();

        expect(presenter.presentDecodedFrame).toHaveBeenCalledTimes(2);
        expect(presenter.presentDecodedFrame).toHaveBeenLastCalledWith(RAW_PLANES_FRAME, FIRST_GENERATION, undefined);
        expect(controller.notifyFramePresented).toHaveBeenCalledTimes(2);
        expect(animationFrames.size).toBe(1);
    });

    it('polls while paused until a frame presents, then stops', () => {
        const { controller, loop, presenter } = createHarness();
        controller.playbackState = 'paused';
        controller.takeCurrentFrame.mockReturnValueOnce(null);

        loop.schedule(false);
        runAnimationFrames();
        expect(presenter.presentDecodedFrame).not.toHaveBeenCalled();
        runAnimationFrames();

        expect(presenter.presentDecodedFrame).toHaveBeenCalledTimes(1);
        expect(animationFrames.size).toBe(0);
    });

    it('acknowledges a VideoFrame once the GPU releases it, presented or discarded', () => {
        const { controller, failures, loop, presenter } = createHarness();
        controller.takeCurrentFrame.mockReturnValue(VIDEO_FRAME);

        loop.schedule(false);
        runAnimationFrames();
        const [ , , releaseFrame ] = presenter.presentDecodedFrame.mock.calls[0] as [ unknown, number, (gpuWorkCompleted: boolean) => void ];
        expect(controller.notifyFramePresented).not.toHaveBeenCalled();
        releaseFrame(true);
        releaseFrame(false);

        expect(controller.notifyFramePresented).toHaveBeenCalledWith(VIDEO_FRAME);
        expect(controller.notifyFrameDiscarded).toHaveBeenCalledWith(VIDEO_FRAME);
        expect(failures).toEqual([]);
    });

    it('reports a VideoFrame release the controller cannot acknowledge, but not one of an earlier generation', () => {
        const { controller, failures, loop, presenter } = createHarness();
        controller.takeCurrentFrame.mockReturnValue(VIDEO_FRAME);
        controller.notifyFramePresented.mockReturnValue(false);

        loop.schedule(false);
        runAnimationFrames();
        const [ , , releaseFrame ] = presenter.presentDecodedFrame.mock.calls[0] as [ unknown, number, (gpuWorkCompleted: boolean) => void ];
        releaseFrame(true);
        loop.setPresentationGeneration(NEXT_GENERATION);
        releaseFrame(true);

        expect(getFailureMessages(failures)).toEqual([ RELEASE_UNACKNOWLEDGED_MESSAGE ]);
    });

    it('reports a frame that never reaches the presenter, and waits while the presenter initializes', () => {
        const { controller, failures, loop, presenter } = createHarness();
        controller.playbackState = 'paused';
        presenter.presentDecodedFrame.mockReturnValue(false);
        presenter.getTelemetry.mockReturnValue({ state: 'initializing' });

        loop.schedule(false);
        runAnimationFrames();
        expect(failures).toEqual([]);
        expect(animationFrames.size).toBe(1);

        presenter.getTelemetry.mockReturnValue({ state: 'presenting' });
        runAnimationFrames();

        expect(getFailureMessages(failures)).toEqual([ NOT_SUBMITTED_MESSAGE ]);
        expect(controller.notifyFrameDiscarded).toHaveBeenCalledTimes(2);
    });

    it('drops a frame request of an earlier generation, and presents later frames in the new one', () => {
        const { loop, presenter } = createHarness();

        loop.schedule(true);
        loop.setPresentationGeneration(NEXT_GENERATION);
        expect(animationFrames.size).toBe(0);
        loop.schedule(true);
        runAnimationFrames();

        expect(loop.getPresentationGeneration()).toBe(NEXT_GENERATION);
        expect(presenter.presentDecodedFrame).toHaveBeenCalledWith(RAW_PLANES_FRAME, NEXT_GENERATION, undefined);
    });

    it('does nothing for a playback that is no longer current', () => {
        const { controller, current, loop } = createHarness();

        loop.schedule(true);
        current.value = false;
        runAnimationFrames();
        loop.schedule(true);

        expect(controller.takeCurrentFrame).not.toHaveBeenCalled();
        expect(animationFrames.size).toBe(0);
    });

    it('drains decoded video on a timer while the page is hidden, and presents again when it returns', () => {
        useFakeTimers();
        const { controller, loop } = createHarness();

        loop.synchronizePageVisibility(false);
        vi.advanceTimersByTime(CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS * 2);
        expect(controller.setPageVisibility).toHaveBeenLastCalledWith(false);
        expect(controller.drainBackgroundVideo).toHaveBeenCalledTimes(2);

        loop.synchronizePageVisibility(true);
        vi.advanceTimersByTime(CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS * 2);

        expect(controller.drainBackgroundVideo).toHaveBeenCalledTimes(2);
        expect(animationFrames.size).toBe(1);
    });

    it('polls for a paused resync when the page returns', () => {
        const { controller, loop } = createHarness();
        controller.playbackState = 'paused';
        controller.setPageVisibility.mockReturnValue(true);

        loop.synchronizePageVisibility(true);

        expect(animationFrames.size).toBe(1);
    });

    it('reports a drain failure and stops draining', () => {
        useFakeTimers();
        const { controller, failures, loop } = createHarness();
        controller.drainBackgroundVideo.mockImplementation((): void => {
            throw DRAIN_FAILURE;
        });

        loop.synchronizePageVisibility(false);
        vi.advanceTimersByTime(CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS * 3);

        expect(failures).toEqual([ DRAIN_FAILURE ]);
        expect(controller.drainBackgroundVideo).toHaveBeenCalledTimes(1);
    });

    it('stops presenting and draining once destroyed', () => {
        useFakeTimers();
        const { controller, loop } = createHarness();

        loop.schedule(true);
        loop.synchronizePageVisibility(false);
        loop.destroy();
        vi.advanceTimersByTime(CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS * 2);

        expect(animationFrames.size).toBe(0);
        expect(controller.drainBackgroundVideo).not.toHaveBeenCalled();
    });

    it('reports a page without animation frames', () => {
        vi.stubGlobal('requestAnimationFrame', undefined);
        const { failures, loop } = createHarness();

        loop.schedule(true);

        expect(getFailureMessages(failures)).toEqual([ ANIMATION_FRAMES_UNAVAILABLE_MESSAGE ]);
    });
});
