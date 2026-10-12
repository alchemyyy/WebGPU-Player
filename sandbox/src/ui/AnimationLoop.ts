// A requestAnimationFrame loop that a panel runs while it has something to animate, such as the playhead or the active subtitle cue.

export type AnimationLoop = Readonly<{
    /** Calls the frame callback every animation frame until stop; starting a running loop changes nothing */
    start: () => void
    /** Cancels the next frame; stopping a stopped loop changes nothing */
    stop: () => void
}>;

/**
 * Creates a stopped loop around a frame callback.
 * A callback that throws ends the loop until the next start, rather than repeating its error every frame.
 */
export function createAnimationLoop(onFrame: () => void): AnimationLoop {
    let running = false;
    let frameRequest: number | null = null;
    const runFrame = (): void => {
        frameRequest = null;
        onFrame();
        // The callback may have stopped the loop, or stopped and started it, which already requested the next frame
        if (running && frameRequest === null) {
            frameRequest = requestAnimationFrame(runFrame);
        }
    };
    return {
        start: (): void => {
            running = true;
            if (frameRequest === null) {
                frameRequest = requestAnimationFrame(runFrame);
            }
        },
        stop: (): void => {
            running = false;
            if (frameRequest === null) {
                return;
            }
            cancelAnimationFrame(frameRequest);
            frameRequest = null;
        }
    };
}
