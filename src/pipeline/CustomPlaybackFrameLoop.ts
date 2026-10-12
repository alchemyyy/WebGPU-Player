// The loop that presents a custom playback's decoded frames: each animation frame takes the controller's current frame and submits it to the presenter, and a hidden page, which gets no animation frames, drains decoded video on a timer instead.
import type WebGPUPresenter from '../presentation/WebGPUPresenter';
import type { DecodedPresentationFrame } from '../presentation/WebGPUPresenter';
import type CustomPlaybackController from './CustomPlaybackController';

/** How often a hidden page drains decoded video. */
// NOTE: Two raw-plane credits at 60 fps need a drain at least every 33 ms
export const CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS = 25;

export type CustomPlaybackFrameLoopOptions = Readonly<{
    controller: CustomPlaybackController
    /** Whether the loop's playback is still current; a replaced playback's loop does nothing */
    isCurrent: () => boolean
    /** Receives a failure the host answers, such as with a fallback */
    onFailure: (error: unknown) => void
    presenter: WebGPUPresenter
    /** The presentation generation the first frames present in */
    presentationGeneration: number
}>;

type FramePresentation = 'failed' | 'no-frame' | 'presented' | 'temporarily-busy';

const ANIMATION_FRAMES_UNAVAILABLE_MESSAGE = 'requestAnimationFrame is unavailable';
const FRAME_NOT_SUBMITTED_MESSAGE = 'Decoded frame did not reach WebGPU submission';
const FRAME_RELEASE_UNACKNOWLEDGED_MESSAGE = 'Decoded frame GPU release could not be acknowledged';

export default class CustomPlaybackFrameLoop {
    private readonly controller: CustomPlaybackController;
    private readonly presenter: WebGPUPresenter;
    private readonly isCurrent: () => boolean;
    private readonly onFailure: (error: unknown) => void;
    private presentationGeneration: number;
    private frameCallback: number | null = null;
    private backgroundDrainTimer: ReturnType<typeof globalThis.setInterval> | null = null;

    constructor(options: CustomPlaybackFrameLoopOptions) {
        this.controller = options.controller;
        this.presenter = options.presenter;
        this.isCurrent = options.isCurrent;
        this.onFailure = options.onFailure;
        this.presentationGeneration = options.presentationGeneration;
    }

    /** The presentation generation frames present in; a seek or a paused refresh moves the playback to a new one. */
    getPresentationGeneration(): number {
        return this.presentationGeneration;
    }

    /** Presents later frames in a new generation, and drops a frame request of the old one. */
    setPresentationGeneration(generation: number): void {
        this.presentationGeneration = generation;
        this.cancel();
    }

    /**
     * Requests an animation frame that presents the current frame.
     * While playing, a continuing loop requests the next frame after each one; a paused playback polls until its first frame presents.
     */
    schedule(continueWhilePlaying: boolean): void {
        if (this.frameCallback !== null || !this.isCurrent()) {
            return;
        }
        if (typeof globalThis.requestAnimationFrame !== 'function') {
            this.onFailure(new Error(ANIMATION_FRAMES_UNAVAILABLE_MESSAGE));
            return;
        }
        const generation = this.presentationGeneration;
        this.frameCallback = globalThis.requestAnimationFrame((): void => {
            this.handleAnimationFrame(generation, continueWhilePlaying);
        });
    }

    /** Drops the pending frame request. */
    cancel(): void {
        const callback = this.frameCallback;
        this.frameCallback = null;
        if (callback !== null && typeof globalThis.cancelAnimationFrame === 'function') {
            globalThis.cancelAnimationFrame(callback);
        }
    }

    /**
     * Follows the page's visibility: a hidden page drains decoded video on a timer, and a returning page restarts the loop for any video resync.
     */
    synchronizePageVisibility(pageVisible: boolean): void {
        const videoResyncRequested = this.controller.setPageVisibility(pageVisible);
        if (!pageVisible) {
            this.startBackgroundDrain();
            return;
        }
        this.stopBackgroundDrain();
        switch (this.controller.playbackState) {
            case 'playing':
                this.schedule(true);
                break;
            case 'paused':
                // A paused resync needs the one-shot poll to display its first frame
                if (videoResyncRequested) {
                    this.schedule(false);
                }
                break;
            default:
                break;
        }
    }

    /** Stops presenting and draining. */
    destroy(): void {
        this.cancel();
        this.stopBackgroundDrain();
    }

    private handleAnimationFrame(generation: number, continueWhilePlaying: boolean): void {
        this.frameCallback = null;
        if (!this.isCurrent() || this.presentationGeneration !== generation) {
            return;
        }

        const decodedFrame = this.controller.takeCurrentFrame();
        const presentation: FramePresentation = decodedFrame ? this.presentFrame(generation, decodedFrame) : 'no-frame';
        if (presentation === 'failed') {
            return;
        }

        if (continueWhilePlaying && this.controller.playbackState === 'playing') {
            this.schedule(true);
            return;
        }
        if ((presentation === 'no-frame' || presentation === 'temporarily-busy') && this.controller.playbackState === 'paused') {
            // A paused seek still needs to wait for and display its first frame
            this.schedule(false);
        }
    }

    private presentFrame(generation: number, decodedFrame: DecodedPresentationFrame): 'failed' | 'presented' | 'temporarily-busy' {
        const videoFrameSubmissionCompleted = decodedFrame.outputMode === 'video-frame' ?
            (gpuWorkCompleted: boolean): void => {
                this.acknowledgeVideoFrameRelease(generation, decodedFrame, gpuWorkCompleted);
            } :
            undefined;
        const frameSubmitted = this.presenter.presentDecodedFrame(decodedFrame, generation, videoFrameSubmissionCompleted);
        if (!frameSubmitted) {
            const frameDiscarded = this.controller.notifyFrameDiscarded(decodedFrame);
            if (frameDiscarded && this.presenter.getTelemetry().state === 'initializing') {
                return 'temporarily-busy';
            }
            this.onFailure(new Error(FRAME_NOT_SUBMITTED_MESSAGE));
            return 'failed';
        }
        if (decodedFrame.outputMode === 'raw-planes' && !this.controller.notifyFramePresented(decodedFrame)) {
            this.onFailure(new Error(FRAME_NOT_SUBMITTED_MESSAGE));
            return 'failed';
        }
        return 'presented';
    }

    /** Returns a VideoFrame's credit once the GPU released it, presented or not. */
    private acknowledgeVideoFrameRelease(generation: number, decodedFrame: DecodedPresentationFrame, gpuWorkCompleted: boolean): void {
        let frameAcknowledged = false;
        try {
            frameAcknowledged = gpuWorkCompleted ?
                this.controller.notifyFramePresented(decodedFrame) :
                this.controller.notifyFrameDiscarded(decodedFrame);
        } catch {
            frameAcknowledged = false;
        }
        if (frameAcknowledged || !this.isCurrent() || this.presentationGeneration !== generation) {
            return;
        }
        this.onFailure(new Error(FRAME_RELEASE_UNACKNOWLEDGED_MESSAGE));
    }

    private startBackgroundDrain(): void {
        if (this.backgroundDrainTimer !== null) {
            return;
        }
        this.backgroundDrainTimer = globalThis.setInterval((): void => {
            if (!this.isCurrent()) {
                this.stopBackgroundDrain();
                return;
            }
            try {
                this.controller.drainBackgroundVideo();
            } catch (error) {
                this.stopBackgroundDrain();
                this.onFailure(error);
            }
        }, CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS);
    }

    private stopBackgroundDrain(): void {
        const timer = this.backgroundDrainTimer;
        this.backgroundDrainTimer = null;
        if (timer !== null) {
            globalThis.clearInterval(timer);
        }
    }
}
