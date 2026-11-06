// Probe sessions for tests: a browser no declared defect affects, as jsdom's navigator reads as WebKit of unknown version,
// and a store double that records each call's step and hands out a fixed quarantine.
import { vi, type Mock } from 'vitest';

import type { BrowserIdentity } from 'webgpu-player/capability/BrowserDefects';
import type { CapabilityProbeLimits } from 'webgpu-player/capability/CapabilityProbeManager';
import CapabilityProbeSession, {
    type CapabilityProbeSessionOptions,
    type RecordedCapabilityProbeQueue
} from 'webgpu-player/capability/CapabilityProbeSession';
import type CapabilityProbeStore from 'webgpu-player/capability/CapabilityProbeStore';
import type { CapabilityProbeQuarantine } from 'webgpu-player/capability/CapabilityProbeStore';
import type { CapabilityProbeStepCost } from 'webgpu-player/capability/CapabilityProbeSteps';

/** The timeout the engine's probes use, which the manager counts from a call's admission. */
export const CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 2_000;

/** A browser no declared defect affects. */
export const UNAFFECTED_BROWSER: BrowserIdentity = Object.freeze({ engine: 'other', majorVersion: null });

/** Limits that admit every call of a probe at once. */
export const UNBOUNDED_LIMITS: CapabilityProbeLimits = Object.freeze({ bytes: Number.MAX_SAFE_INTEGER, decoders: Number.MAX_SAFE_INTEGER });

export type RecordingStore = Readonly<{
    /** The steps of the calls in flight, by label, as the session records them */
    inFlight: () => string[]
    markRunning: Mock<(probe: string, step: string, cost: CapabilityProbeStepCost) => Promise<() => void>>
    resolveSuspect: Mock<(step: string) => void>
    store: CapabilityProbeStore
}>;

/**
 * Creates a store double that keeps no verdicts, records the step of each call the session marks running,
 * and hands out the quarantine, from which a resolved suspect drops as from the real store.
 */
export function createRecordingStore(quarantine: Partial<CapabilityProbeQuarantine> = {}): RecordingStore {
    const inFlight: string[] = [];
    const blocked = new Set(quarantine.blocked);
    const suspects = new Map(quarantine.suspects);
    const ceiling = quarantine.ceiling ?? null;
    const markRunning = vi.fn(async (_probe: string, step: string): Promise<() => void> => {
        inFlight.push(step);
        return (): void => {
            inFlight.splice(inFlight.indexOf(step), 1);
        };
    });
    const resolveSuspect = vi.fn((step: string): void => {
        suspects.delete(step);
    });
    const store = {
        markRunning,
        onClear: (): (() => void) => (): void => undefined,
        read: async (): Promise<null> => null,
        readQuarantine: async (): Promise<CapabilityProbeQuarantine> => ({ blocked: new Set(blocked), ceiling, suspects: new Map(suspects) }),
        recordServedVerdict: (): void => undefined,
        resolveSuspect,
        write: async (): Promise<void> => undefined
    } as unknown as CapabilityProbeStore;
    return { inFlight: () => [ ...inFlight ], markRunning, resolveSuspect, store };
}

/** Creates a session for an unaffected browser, with no store and unbounded limits unless given. */
export function createCapabilityProbeSession(options: Partial<CapabilityProbeSessionOptions> = {}): CapabilityProbeSession {
    return new CapabilityProbeSession({
        browserIdentity: UNAFFECTED_BROWSER,
        limits: UNBOUNDED_LIMITS,
        store: null,
        timeoutMilliseconds: CAPABILITY_PROBE_TIMEOUT_MILLISECONDS,
        ...options
    });
}

/** Returns a session's negotiation queue for one probe, once its quarantine is read. */
export async function createRecordedQueue(session: CapabilityProbeSession, probe: string): Promise<RecordedCapabilityProbeQueue> {
    await session.readQuarantine();
    return session.record(session.manager.queue, probe);
}
