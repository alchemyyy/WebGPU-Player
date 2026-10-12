import { describe, expect, it } from 'vitest';

import type { PlaybackStatus } from '../../../sandbox/src/contracts/SandboxContracts';
import { getSurfaceClickAction } from '../../../sandbox/src/ui/SurfaceClick';

// Statuses with nothing to pause or resume
const UNTOGGLED_STATUSES: readonly PlaybackStatus[] = [ 'ended', 'failed', 'idle', 'loading', 'seeking' ];

describe('getSurfaceClickAction', () => {
    it('pauses a playing video and resumes a paused one', () => {
        expect(getSurfaceClickAction('playing')).toBe('pause');
        expect(getSurfaceClickAction('paused')).toBe('resume');
    });

    it('does nothing while there is nothing to pause or resume', () => {
        for (const status of UNTOGGLED_STATUSES) {
            expect(getSurfaceClickAction(status)).toBeNull();
        }
    });
});
