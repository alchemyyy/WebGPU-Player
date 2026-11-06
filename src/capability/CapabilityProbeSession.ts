// The page's capability probing: one manager for every probe's browser calls, whose limits follow the quarantine the store keeps,
// and the wrapper every call goes through. The wrapper blocks the steps a declared browser defect or an earlier page's crash names,
// runs the suspects of a crash alone, and records each admitted call while it is in flight, so a page that stops in it names it.

import { findKnownBrowserDefect, type BrowserIdentity } from './BrowserDefects';
import CapabilityProbeManager, {
    type CAPABILITY_PROBE_TIMEOUT,
    type CapabilityProbeLimits,
    type CapabilityProbeQueue,
    type CapabilityProbeStepOptions
} from './CapabilityProbeManager';
import type CapabilityProbeStore from './CapabilityProbeStore';
import type { CapabilityProbeQuarantine } from './CapabilityProbeStore';
import type { CapabilityProbeStep } from './CapabilityProbeSteps';

/** Why a step never runs: a declared browser defect crashes it, or it stopped an earlier page alone. */
export type CapabilityProbeBlockReason = 'browser-defect' | 'stopped-page';

/** What a step resolves when it is blocked; the probe reads it as unsupported, for its reason. */
export class CapabilityProbeBlock {
    public readonly reason: CapabilityProbeBlockReason;

    public constructor(reason: CapabilityProbeBlockReason) {
        this.reason = reason;
    }
}

const BLOCKED_BY_BROWSER_DEFECT = Object.freeze(new CapabilityProbeBlock('browser-defect'));
const BLOCKED_BY_STOPPED_PAGE = Object.freeze(new CapabilityProbeBlock('stopped-page'));

/** What a step resolves: its call's value, the timeout result, or the block that kept it from running. */
export type CapabilityProbeStepOutcome<Value> = Value | CapabilityProbeBlock | typeof CAPABILITY_PROBE_TIMEOUT;

/** Joins a step's call to the manager under the step's descriptor and options; see CapabilityProbeQueue for its timing, and CapabilityProbeStepOptions for its options. */
export type RecordedCapabilityProbeCall = <Value>(
    call: () => Promise<Value>,
    step: CapabilityProbeStep,
    options?: CapabilityProbeStepOptions<Value>
) => Promise<CapabilityProbeStepOutcome<Value>>;

/** A manager view whose steps a probe's session blocks, orders, and records, as `CapabilityProbeSession.record` describes. */
export type RecordedCapabilityProbeQueue = Readonly<{
    /** The fetch priority of the view's downloads */
    assetPriority: RequestPriority
    check: RecordedCapabilityProbeCall
    run: RecordedCapabilityProbeCall
    runTimed: RecordedCapabilityProbeCall
}>;

export type CapabilityProbeSessionOptions = Readonly<{
    /** The browser the declared defects are matched against */
    browserIdentity: BrowserIdentity
    /** The most the device and the probe definitions let calls hold at once, which a quarantine only lowers */
    limits: CapabilityProbeLimits
    /** The quarantine and run journal of the page; without one, only declared defects block steps */
    store: CapabilityProbeStore | null
    timeoutMilliseconds: number
}>;

const EMPTY_QUARANTINE: CapabilityProbeQuarantine = Object.freeze({
    blocked: new Set<string>(),
    ceiling: null,
    suspects: new Map<string, ReadonlySet<string>>()
});

/**
 * Runs a page's probe steps on one manager. Its limits are the device's and the definitions', lowered to the stored ceiling, and to one
 * decoder while suspects remain, so the serial round that retries them names the one that crashes; the last suspect to settle restores them.
 */
export default class CapabilityProbeSession {
    public readonly manager: CapabilityProbeManager;
    private readonly browserIdentity: BrowserIdentity;
    private readonly limits: CapabilityProbeLimits;
    private quarantine: CapabilityProbeQuarantine = EMPTY_QUARANTINE;
    private readonly store: CapabilityProbeStore | null;
    // The quarantine's suspects that no call of this page has settled yet
    private unresolvedSuspects = new Set<string>();

    public constructor(options: CapabilityProbeSessionOptions) {
        this.browserIdentity = options.browserIdentity;
        this.limits = options.limits;
        this.store = options.store;
        this.manager = new CapabilityProbeManager({ limits: options.limits, timeoutMilliseconds: options.timeoutMilliseconds });
    }

    /**
     * Reads the store's quarantine, which opens the page's run journal on its first read, and sets the manager's limits from it.
     * Call it before a probe's first step, so the step is blocked or recorded under the current quarantine.
     */
    public async readQuarantine(): Promise<CapabilityProbeQuarantine> {
        const quarantine = this.store ? await this.store.readQuarantine() : EMPTY_QUARANTINE;
        this.quarantine = quarantine;
        this.unresolvedSuspects = new Set(quarantine.suspects.keys());
        this.manager.setLimits(this.getLimits());
        return quarantine;
    }

    /** Whether a probe had a step in flight in the crash that left it a suspect, and that step has not settled on this page yet. */
    public holdsSuspectSteps(probe: string): boolean {
        for (const [ step, probes ] of this.quarantine.suspects) {
            if (this.unresolvedSuspects.has(step) && probes.has(probe)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Wraps a view of the manager for one probe. A step a declared browser defect crashes, or one that stopped an earlier page alone,
     * never runs and resolves its block. Other steps join with the caller's options; a suspect runs last and alone, and is cleared once
     * its call settles. Every call is recorded under the probe while it is in flight, a run the manager makes again to confirm a result
     * included, so a page that stops in it leaves the step behind; the wait for admission is not.
     */
    public record(queue: CapabilityProbeQueue, probe: string): RecordedCapabilityProbeQueue {
        const join = (enqueue: CapabilityProbeQueue['run']): RecordedCapabilityProbeCall => <Value>(
            call: () => Promise<Value>,
            step: CapabilityProbeStep,
            options?: CapabilityProbeStepOptions<Value>
        ): Promise<CapabilityProbeStepOutcome<Value>> => {
            const block = this.findBlock(step);
            if (block !== null) {
                return Promise.resolve(block);
            }
            // Running alone, a suspect never runs beside another call, so the manager never runs it again to confirm a result:
            // a confirming run is never a suspect's, and the settling of a suspect's one call clears it
            const suspect = this.unresolvedSuspects.has(step.label);
            return enqueue(async (): Promise<Value> => {
                const end = this.store ? await this.store.markRunning(probe, step.label, step.cost) : null;
                try {
                    return await call();
                } finally {
                    end?.();
                    if (suspect) {
                        this.resolveSuspect(step.label);
                    }
                }
            }, step, suspect ? { ...options, alone: true } : options);
        };
        return Object.freeze({
            get assetPriority(): RequestPriority {
                return queue.assetPriority;
            },
            check: join(queue.check),
            run: join(queue.run),
            runTimed: join(queue.runTimed)
        });
    }

    private findBlock(step: CapabilityProbeStep): CapabilityProbeBlock | null {
        if (findKnownBrowserDefect(step, this.browserIdentity) !== null) {
            return BLOCKED_BY_BROWSER_DEFECT;
        }
        return this.quarantine.blocked.has(step.label) ? BLOCKED_BY_STOPPED_PAGE : null;
    }

    private getLimits(): CapabilityProbeLimits {
        // While suspects remain, one call runs at a time, so a crash names its step
        const decoders = this.unresolvedSuspects.size > 0 ? 1 : this.limits.decoders;
        const ceiling = this.quarantine.ceiling;
        // A dimension the ceiling leaves uncapped keeps the device's and the definitions' limit
        return {
            bytes: Math.min(this.limits.bytes, ceiling?.bytes ?? Number.POSITIVE_INFINITY),
            decoders: Math.min(decoders, ceiling?.decoders ?? Number.POSITIVE_INFINITY)
        };
    }

    // A suspect that settled did not stop the page; once none is left, the store may have lowered the ceiling, so the limits follow a fresh read
    private resolveSuspect(step: string): void {
        this.store?.resolveSuspect(step);
        if (this.unresolvedSuspects.delete(step) && this.unresolvedSuspects.size === 0) {
            void this.readQuarantine();
        }
    }
}
