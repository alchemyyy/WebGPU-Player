// The sandbox's playback session: it probes media, chooses the route through the engine's eligibility, and drives the engine.
import type { SandboxSessionCommands } from '../contracts/SandboxContracts';
import type { SandboxStore } from '../ui/Panel';

export type SandboxSessionOptions = Readonly<{
    store: SandboxStore
    /** The full-window element the presenter's surface fills */
    surfaceContainer: HTMLDivElement
}>;

/* eslint-disable @typescript-eslint/no-unused-vars -- A placeholder that the session work replaces */
export function createSandboxSession(options: SandboxSessionOptions): SandboxSessionCommands {
    const notImplemented = (): never => {
        throw new Error('not-implemented: session');
    };
    return {
        addExampleShaderPass: notImplemented,
        addShaderPasses: notImplemented,
        getCurrentTimeMicroseconds: notImplemented,
        getExampleShaderPasses: notImplemented,
        moveShaderPass: notImplemented,
        openMedia: notImplemented,
        pause: notImplemented,
        play: notImplemented,
        removeShaderPass: notImplemented,
        seek: notImplemented,
        selectAudioTrack: notImplemented,
        selectSubtitle: notImplemented,
        setHDROutputEnabled: notImplemented,
        setMuted: notImplemented,
        setRenderSettings: notImplemented,
        setRouteOverride: notImplemented,
        setShaderParameter: notImplemented,
        setVolume: notImplemented
    };
}
/* eslint-enable @typescript-eslint/no-unused-vars */
