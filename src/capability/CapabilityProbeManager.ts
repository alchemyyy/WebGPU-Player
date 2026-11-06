// Runs the browser calls of the page's capability probes: a negotiation's side by side, as many at once as the limits on decoded bytes and
// open decoders allow, and the background's one at a time, so a crash in the background names its call, while a negotiation's may join it.
// A call holds its reservation until it settles, however long after its timeout that is, so work the browser still does keeps counting
// against the limits; a call that does not settle within one more timeout after its own stops every later call on the page.
// A hardware decoder pool may refuse a decoder only because the calls beside it hold theirs, so a negative result of a call that ran
// beside another can be confirmed by running the call again alone before its caller sees it.

import type { CapabilityProbeStep, CapabilityProbeStepCost } from './CapabilityProbeSteps';

/** What a step resolves when it ran out of time, or never ran because the manager stopped, or a background step after the background halted. */
export const CAPABILITY_PROBE_TIMEOUT = Symbol('capability-probe-timeout');

/** The most decoded bytes and open decoders the page's probe calls hold at once; a call within both maxima may join the running ones. */
export type CapabilityProbeLimits = Readonly<{ bytes: number, decoders: number }>;

/**
 * One background run of a probe, which a negotiation promotes when it needs the same probe.
 * Until then each of its runs waits for the run's turn before it joins, and its steps run one at a time, after the negotiations' steps.
 */
export type CapabilityProbeBackgroundRun = {
    readonly promoted: boolean
    /** Resolves once the run is promoted, so its waiting steps join the negotiations' admission at once */
    readonly promotion: Promise<void>
    /** Whether a step of the run timed out, or was refused, while the run was in the background */
    timedOut: boolean
    waitForTurn(): Promise<void>
};

/** How a step runs among the others. */
export type CapabilityProbeStepOptions<Value> = Readonly<{
    /**
     * Runs the step by itself, with none joining it, so what happens during it is its own doing, as a crash's suspect needs.
     * It starts once no other step runs and none waits ahead of it: a negotiation's other steps go ahead of it, and it goes ahead of
     * the background's, unless it is a background step itself, when it goes last.
     */
    alone?: boolean
    /**
     * Whether a value is a negative result worth confirming. A call that ran beside another and settles with such a value runs again alone,
     * timed anew when the step is timed, and its caller gets that run's outcome; a call that ran alone answers at once.
     * A timeout or an error is never confirmed.
     */
    confirm?: (value: Value) => boolean
}>;

/**
 * A view of the manager for one negotiation or background run.
 * `check` and `runTimed` resolve `CAPABILITY_PROBE_TIMEOUT` once their call runs longer than the manager's timeout, counted from when it starts;
 * `run` waits for its call, which bounds itself. A call that throws rejects with its error.
 */
export type CapabilityProbeQueue = Readonly<{
    /** The fetch priority of the view's downloads: low for a background run until it is promoted */
    assetPriority: RequestPriority
    check: <Value>(call: () => Promise<Value>, step: CapabilityProbeStep, options?: CapabilityProbeStepOptions<Value>) => Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT>
    run: <Value>(call: () => Promise<Value>, step: CapabilityProbeStep, options?: CapabilityProbeStepOptions<Value>) => Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT>
    runTimed: <Value>(call: () => Promise<Value>, step: CapabilityProbeStep, options?: CapabilityProbeStepOptions<Value>) => Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT>
}>;

export type CapabilityProbeManagerOptions = Readonly<{
    limits: CapabilityProbeLimits
    /** How long a timed call may run, from its start; a call still running as long again after its timeout stops the manager */
    timeoutMilliseconds: number
}>;

// A step that has joined the manager, waiting or running
type Operation = {
    readonly alone: boolean
    // Calls the step and answers its caller with the outcome, unless the caller has its answer or the step runs again alone to confirm it;
    // resolves once the call settles, and never rejects
    readonly call: () => Promise<void>
    readonly cost: CapabilityProbeStepCost
    // Whether another step's call ran at some time between this one's admission and its settling
    overlapped: boolean
    // The background run the step belongs to; null for a negotiation's step
    readonly run: CapabilityProbeBackgroundRun | null
    readonly timed: boolean
    // Answers the caller with the timeout result unless it has its answer; returns whether it answered
    readonly timeOut: () => boolean
};

// The run a step belongs to while the run is in the background; null for a negotiation's step, and for a promoted run's, which has its priority
function getBackgroundRun(operation: Operation): CapabilityProbeBackgroundRun | null {
    return operation.run !== null && !operation.run.promoted ? operation.run : null;
}

/**
 * Admits the browser calls of capability probes, holding each call's reservation until the call settles.
 * Negotiation steps, and a promoted run's, run side by side while their costs fit the limits, in the order they joined, and a step that
 * does not fit never holds back a later one that does; a step larger than the limits runs once nothing else does, so none waits forever.
 * A step of a background run starts only once nothing runs and no negotiation step waits, and never joins another, so the background
 * runs one call at a time and a crash in it names its call; a negotiation step may join it, so playback never waits on the warm-up.
 * A step that runs alone, a confirming run included, starts once nothing runs and no step ahead of it waits.
 */
export default class CapabilityProbeManager {
    /** The view at negotiation priority, whose steps join at once */
    public readonly queue: CapabilityProbeQueue;
    /** How long a timed step's call may run from its start; a call that bounds its own work stays within it, so the manager never drops its answer */
    public readonly timeoutMilliseconds: number;
    private backgroundHalted = false;
    private limits: CapabilityProbeLimits;
    private readonly running = new Set<Operation>();
    private runningBytes = 0;
    private runningDecoders = 0;
    // Set once a call outlives its timeout by another timeout: the browser may be stuck, so no further call is made on this page
    private stopped = false;
    // In the order the steps joined
    private waiting: Operation[] = [];

    public constructor(options: CapabilityProbeManagerOptions) {
        this.limits = options.limits;
        this.timeoutMilliseconds = options.timeoutMilliseconds;
        this.queue = this.createView(null, null);
    }

    /** Whether no background step runs on this page any more: one timed out in the background, or the manager stopped. */
    public get isBackgroundHalted(): boolean {
        return this.backgroundHalted || this.stopped;
    }

    /** Replaces the limits for every admission from now on; calls already running keep their reservations. */
    public setLimits(limits: CapabilityProbeLimits): void {
        this.limits = limits;
        this.admit();
    }

    /** Returns a view at negotiation priority whose `run` and `runTimed` steps join only once the gate settles, however it settles; `check` joins at once. */
    public after(gate: Promise<unknown>): CapabilityProbeQueue {
        const settledGate: Promise<void> = gate.then((): void => undefined, (): void => undefined);
        return this.createView(() => settledGate, null);
    }

    /**
     * Returns a view for a background run: its `run` and `runTimed` steps join only once the run's turn comes, so the wait never counts
     * against a timeout, and `check` joins at once. Its steps run one at a time, after the negotiations' steps, and its downloads have
     * low priority, until the run is promoted. A step that times out while the run is in the background marks the run and halts the background.
     */
    public background(run: CapabilityProbeBackgroundRun): CapabilityProbeQueue {
        // A promotion lets the run's waiting steps join the running ones at once, not when a running call settles
        void run.promotion.then((): void => {
            this.admit();
        });
        return this.createView(() => run.waitForTurn(), run);
    }

    private createView(waitToJoin: (() => Promise<void>) | null, run: CapabilityProbeBackgroundRun | null): CapabilityProbeQueue {
        const join = (timed: boolean): CapabilityProbeQueue['run'] => <Value>(
            call: () => Promise<Value>,
            step: CapabilityProbeStep,
            options?: CapabilityProbeStepOptions<Value>
        ): Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT> => (waitToJoin === null ?
            this.enqueue(call, step, options, timed, run) :
            waitToJoin().then(() => this.enqueue(call, step, options, timed, run)));
        return Object.freeze({
            get assetPriority(): RequestPriority {
                return run !== null && !run.promoted ? 'low' : 'auto';
            },
            check: <Value>(
                call: () => Promise<Value>,
                step: CapabilityProbeStep,
                options?: CapabilityProbeStepOptions<Value>
            ): Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT> => this.enqueue(call, step, options, true, run),
            run: join(false),
            runTimed: join(true)
        });
    }

    private enqueue<Value>(
        call: () => Promise<Value>,
        step: CapabilityProbeStep,
        options: CapabilityProbeStepOptions<Value> | undefined,
        timed: boolean,
        run: CapabilityProbeBackgroundRun | null
    ): Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT> {
        return new Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT>((resolve, reject) => {
            // Whether the caller has its answer; a promise settles once, so the outcome of a call that timed out goes nowhere
            let answered = false;
            const timeOut = (): boolean => {
                if (answered) {
                    return false;
                }
                answered = true;
                resolve(CAPABILITY_PROBE_TIMEOUT);
                return true;
            };
            // Joins a run of the call; a confirming run goes alone, so nothing beside it leaves its outcome in question
            const join = (alone: boolean, confirm: ((value: Value) => boolean) | undefined): void => {
                const operation: Operation = {
                    alone,
                    // Awaiting inside the function also turns a call that throws before it returns a promise into a rejection
                    call: async (): Promise<void> => {
                        try {
                            const value = await call();
                            if (answered) {
                                return;
                            }
                            if (operation.overlapped && confirm !== undefined && confirm(value)) {
                                // Waits like any step, so the release of this call admits it once nothing else runs or waits
                                join(true, undefined);
                                return;
                            }
                            answered = true;
                            resolve(value);
                        } catch (error: unknown) {
                            answered = true;
                            reject(error);
                        }
                    },
                    cost: step.cost,
                    overlapped: false,
                    run,
                    timed,
                    timeOut
                };
                this.waiting.push(operation);
            };
            join(options?.alone === true, options?.confirm);
            this.admit();
        });
    }

    // Starts every waiting step the limits admit; the steps are chosen and reserved before any is called, so a call that joins another step sees them
    private admit(): void {
        for (const operation of this.selectAdmissions()) {
            this.start(operation);
        }
    }

    private selectAdmissions(): Operation[] {
        this.refuseWaiting();
        // A step that runs alone has the browser to itself, so a crash during it names it, and a refusal is no other call's doing
        if ([ ...this.running ].some((operation: Operation): boolean => operation.alone)) {
            return [];
        }
        // The priority of a background run is read now, so a run promoted while its steps wait gives them a negotiation's admission
        const negotiation = this.waiting.filter((operation: Operation): boolean => getBackgroundRun(operation) === null);
        const background = this.waiting.filter((operation: Operation): boolean => getBackgroundRun(operation) !== null);
        const admitted: Operation[] = [];
        // A negotiation's steps join every running step their costs fit beside, a background step's included
        for (const operation of negotiation) {
            if (!operation.alone && this.fits(operation.cost)) {
                this.reserve(operation);
                admitted.push(operation);
            }
        }
        // With nothing running every negotiation step fits, so only ones that run alone still wait; the next step then runs by itself:
        // a negotiation's, else a background step, and last a background step that runs alone
        if (this.running.size === 0) {
            const next = negotiation.find((operation: Operation): boolean => operation.alone)
                ?? background.find((operation: Operation): boolean => !operation.alone)
                ?? background.find((operation: Operation): boolean => operation.alone);
            if (next !== undefined) {
                this.reserve(next);
                admitted.push(next);
            }
        }
        this.waiting = this.waiting.filter((operation: Operation): boolean => !admitted.includes(operation));
        return admitted;
    }

    // Answers the timeout result, without a call, to every waiting step that may no longer run: all once the manager stopped, and a background step once the background halted
    private refuseWaiting(): void {
        const refused = this.waiting.filter((operation: Operation): boolean => (
            this.stopped || (this.backgroundHalted && getBackgroundRun(operation) !== null)
        ));
        if (refused.length === 0) {
            return;
        }
        this.waiting = this.waiting.filter((operation: Operation): boolean => !refused.includes(operation));
        for (const operation of refused) {
            const backgroundRun = getBackgroundRun(operation);
            if (backgroundRun !== null) {
                backgroundRun.timedOut = true;
            }
            operation.timeOut();
        }
    }

    // A step larger than the limits still fits once nothing runs, so no step waits forever
    private fits(cost: CapabilityProbeStepCost): boolean {
        return this.running.size === 0
            || (this.runningDecoders + cost.decoders <= this.limits.decoders && this.runningBytes + cost.bytes <= this.limits.bytes);
    }

    private reserve(operation: Operation): void {
        // Every call already holding a reservation runs beside this one, a call that timed out but has not settled included
        for (const other of this.running) {
            other.overlapped = true;
            operation.overlapped = true;
        }
        this.running.add(operation);
        this.runningBytes += operation.cost.bytes;
        this.runningDecoders += operation.cost.decoders;
    }

    private release(operation: Operation): void {
        this.running.delete(operation);
        this.runningBytes -= operation.cost.bytes;
        this.runningDecoders -= operation.cost.decoders;
        this.admit();
    }

    private start(operation: Operation): void {
        const settled = operation.call();
        if (!operation.timed) {
            void settled.then((): void => {
                this.release(operation);
            });
            return;
        }
        let unwindTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;
        const timeout = globalThis.setTimeout((): void => {
            if (!operation.timeOut()) {
                return;
            }
            // The reservation stays until the call settles; a background timeout keeps further background steps from joining the work it left
            const backgroundRun = getBackgroundRun(operation);
            if (backgroundRun !== null) {
                backgroundRun.timedOut = true;
                this.backgroundHalted = true;
            }
            unwindTimeout = globalThis.setTimeout((): void => {
                this.stop();
            }, this.timeoutMilliseconds);
            this.admit();
        }, this.timeoutMilliseconds);
        void settled.then((): void => {
            globalThis.clearTimeout(timeout);
            if (unwindTimeout !== null) {
                globalThis.clearTimeout(unwindTimeout);
            }
            this.release(operation);
        });
    }

    private stop(): void {
        this.stopped = true;
        this.admit();
    }
}
