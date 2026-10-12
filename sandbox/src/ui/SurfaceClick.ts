// Clicking the video, anywhere outside the panels, pauses it while it plays and resumes it while it is paused.
import type { PlaybackStatus } from '../contracts/SandboxContracts';

export type SurfaceClickAction = 'pause' | 'resume';

/** Returns what a click on the video does in a playback status, or null when there is nothing to pause or resume. */
export function getSurfaceClickAction(status: PlaybackStatus): SurfaceClickAction | null {
    switch (status) {
        case 'playing':
            return 'pause';
        case 'paused':
            return 'resume';
        case 'ended':
        case 'failed':
        case 'idle':
        case 'loading':
        case 'seeking':
            return null;
    }
}
