import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CapabilityProbeManager, {
    CAPABILITY_PROBE_TIMEOUT,
    type CapabilityProbeBackgroundRun,
    type CapabilityProbeLimits,
    type CapabilityProbeQueue,
    type CapabilityProbeStepOptions
} from 'webgpu-player/capability/CapabilityProbeManager';
import type { CapabilityProbeStep, CapabilityProbeStepCost } from 'webgpu-player/capability/CapabilityProbeSteps';

const TIMEOUT_MILLISECONDS = 2_000;
// A limit no test reaches, so only the other one binds
const UNBOUNDED = Number.MAX_SAFE_INTEGER;
// The value of a call that a decoder pool refused, which a step's confirm accepts
const REFUSED = 'refused';
const CONFIRM_REFUSAL: CapabilityProbeStepOptions<string> = Object.freeze({ confirm: (value: string): boolean => value === REFUSED });

type RunningCall = Readonly<{
    cost: CapabilityProbeStepCost
    reject: (error: unknown) => void
    resolve: (value: string) => void
}>;

/** Browser calls the test settles by hand; each records its start, and the calls record the most bytes and decoders they held at once. */
class ManualCalls {
    public peakBytes = 0;
    public peakDecoders = 0;
    public readonly started: string[] = [];
    private readonly running = new Map<string, RunningCall>();

    /** The calls started and not yet settled, in the order they started */
    public get runningNames(): string[] {
        return [ ...this.running.keys() ];
    }

    /** Joins a step through a queue method, with a call that resolves the step's name once the test finishes it. */
    public submit(
        method: CapabilityProbeQueue['run'],
        name: string,
        step: CapabilityProbeStep,
        options?: CapabilityProbeStepOptions<string>
    ): Promise<string | typeof CAPABILITY_PROBE_TIMEOUT> {
        return method(() => new Promise<string>((resolve, reject) => {
            this.started.push(name);
            this.running.set(name, { cost: step.cost, reject, resolve });
            const held = [ ...this.running.values() ];
            this.peakBytes = Math.max(this.peakBytes, held.reduce((sum: number, { cost }: RunningCall): number => sum + cost.bytes, 0));
            this.peakDecoders = Math.max(this.peakDecoders, held.reduce((sum: number, { cost }: RunningCall): number => sum + cost.decoders, 0));
        }), step, options);
    }

    /** Settles a running call with its name, or with the value given. */
    public finish(name: string, value: string = name): void {
        this.take(name).resolve(value);
    }

    public fail(name: string, error: unknown): void {
        this.take(name).reject(error);
    }

    private take(name: string): RunningCall {
        const call = this.running.get(name);
        if (call === undefined) {
            throw new Error(`${name} is not running`);
        }
        this.running.delete(name);
        return call;
    }
}

/** A background run whose turn the test opens by hand; a promotion opens it too. */
class ManualBackgroundRun implements CapabilityProbeBackgroundRun {
    public promoted = false;
    public readonly promotion: Promise<void>;
    public timedOut = false;
    private resolvePromotion: () => void = (): void => undefined;
    private turnOpen: boolean;
    private readonly turnWaiters: Array<() => void> = [];

    public constructor(turnOpen = true) {
        this.turnOpen = turnOpen;
        this.promotion = new Promise<void>((resolve) => {
            this.resolvePromotion = resolve;
        });
    }

    public waitForTurn(): Promise<void> {
        if (this.turnOpen) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.turnWaiters.push(resolve);
        });
    }

    public openTurn(): void {
        this.turnOpen = true;
        for (const resolve of this.turnWaiters.splice(0)) {
            resolve();
        }
    }

    public promote(): void {
        this.promoted = true;
        this.resolvePromotion();
        this.openTurn();
    }
}

function createManager(limits: Partial<CapabilityProbeLimits>): CapabilityProbeManager {
    return new CapabilityProbeManager({
        limits: { bytes: UNBOUNDED, decoders: UNBOUNDED, ...limits },
        timeoutMilliseconds: TIMEOUT_MILLISECONDS
    });
}

function createStep(cost: Partial<CapabilityProbeStepCost> = {}): CapabilityProbeStep {
    return {
        codec: 'opus',
        cost: { bytes: 0, decoders: 1, ...cost },
        kind: 'decode',
        label: 'decode opus 2ch 48000Hz',
        media: 'audio',
        numberOfChannels: 2,
        sampleRate: 48_000
    };
}

/** Lets every settled promise run its callbacks, without moving the clock. */
async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
}

describe('capability probe manager', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('admission', () => {
        it('runs steps side by side up to the decoder limit, and never beyond', async () => {
            const manager = createManager({ decoders: 3 });
            const calls = new ManualCalls();
            const names = [ 'a', 'b', 'c', 'd', 'e' ];
            const results = names.map((name: string) => calls.submit(manager.queue.runTimed, name, createStep({ decoders: 1 })));
            await flush();
            expect(calls.runningNames).toEqual([ 'a', 'b', 'c' ]);

            calls.finish('b');
            await flush();
            expect(calls.runningNames).toEqual([ 'a', 'c', 'd' ]);

            calls.finish('a');
            calls.finish('c');
            await flush();
            expect(calls.runningNames).toEqual([ 'd', 'e' ]);

            calls.finish('d');
            calls.finish('e');
            await expect(Promise.all(results)).resolves.toEqual(names);
            expect(calls.peakDecoders).toBe(3);
        });

        it('admits a step that fills the byte limit exactly, and holds one that would pass it', async () => {
            const manager = createManager({ bytes: 100 });
            const calls = new ManualCalls();
            void calls.submit(manager.queue.run, 'a', createStep({ bytes: 50 }));
            void calls.submit(manager.queue.run, 'b', createStep({ bytes: 50 }));
            void calls.submit(manager.queue.run, 'c', createStep({ bytes: 1 }));
            await flush();
            expect(calls.runningNames).toEqual([ 'a', 'b' ]);

            calls.finish('a');
            await flush();
            expect(calls.runningNames).toEqual([ 'b', 'c' ]);
            expect(calls.peakBytes).toBe(100);
        });

        it('runs a step larger than the limits once nothing else runs, and alone', async () => {
            const manager = createManager({ bytes: 100, decoders: 2 });
            const calls = new ManualCalls();
            void calls.submit(manager.queue.run, 'small', createStep({ bytes: 10 }));
            const large = calls.submit(manager.queue.run, 'large', createStep({ bytes: 1_000, decoders: 4 }));
            await flush();
            expect(calls.runningNames).toEqual([ 'small' ]);

            calls.finish('small');
            await flush();
            expect(calls.runningNames).toEqual([ 'large' ]);

            void calls.submit(manager.queue.run, 'later', createStep({ bytes: 10 }));
            await flush();
            expect(calls.runningNames).toEqual([ 'large' ]);

            calls.finish('large');
            await expect(large).resolves.toBe('large');
            await flush();
            expect(calls.runningNames).toEqual([ 'later' ]);
        });

        it('starts a later step that fits ahead of an earlier one that does not', async () => {
            const manager = createManager({ bytes: 100 });
            const calls = new ManualCalls();
            void calls.submit(manager.queue.run, 'a', createStep({ bytes: 60 }));
            void calls.submit(manager.queue.run, 'b', createStep({ bytes: 60 }));
            void calls.submit(manager.queue.run, 'c', createStep({ bytes: 30 }));
            await flush();
            expect(calls.runningNames).toEqual([ 'a', 'c' ]);

            calls.finish('a');
            await flush();
            expect(calls.runningNames).toEqual([ 'c', 'b' ]);
        });

        it('starts negotiation steps before background steps that joined earlier', async () => {
            const manager = createManager({ decoders: 1 });
            const calls = new ManualCalls();
            const background = manager.background(new ManualBackgroundRun());
            void calls.submit(manager.queue.run, 'first', createStep());
            await flush();
            void calls.submit(background.check, 'background check', createStep());
            void calls.submit(background.run, 'background run', createStep());
            await flush();
            void calls.submit(manager.after(Promise.resolve()).runTimed, 'negotiation', createStep());
            await flush();

            for (const name of [ 'first', 'negotiation', 'background check' ]) {
                expect(calls.runningNames).toEqual([ name ]);
                calls.finish(name);
                await flush();
            }
            expect(calls.runningNames).toEqual([ 'background run' ]);
        });

        it('gives a run promoted while its step waits negotiation priority, and its downloads the default priority', async () => {
            const manager = createManager({ decoders: 1 });
            const calls = new ManualCalls();
            const promotedRun = new ManualBackgroundRun();
            const promotedView = manager.background(promotedRun);
            void calls.submit(manager.queue.run, 'first', createStep());
            await flush();
            void calls.submit(manager.background(new ManualBackgroundRun()).run, 'background', createStep());
            await flush();
            void calls.submit(promotedView.run, 'promoted', createStep());
            await flush();
            void calls.submit(manager.queue.run, 'negotiation', createStep());
            await flush();
            expect(promotedView.assetPriority).toBe('low');

            promotedRun.promote();
            expect(promotedView.assetPriority).toBe('auto');
            expect(manager.queue.assetPriority).toBe('auto');
            expect(manager.after(Promise.resolve()).assetPriority).toBe('auto');

            for (const name of [ 'first', 'promoted', 'negotiation' ]) {
                expect(calls.runningNames).toEqual([ name ]);
                calls.finish(name);
                await flush();
            }
            expect(calls.runningNames).toEqual([ 'background' ]);
        });

        it('runs a step alone, once no other step runs or waits', async () => {
            const manager = createManager({ decoders: 4 });
            const calls = new ManualCalls();
            void calls.submit(manager.queue.run, 'a', createStep());
            void calls.submit(manager.queue.run, 'b', createStep());
            void calls.submit(manager.queue.run, 'first alone', createStep(), { alone: true });
            void calls.submit(manager.queue.check, 'c', createStep());
            await flush();
            expect(calls.runningNames).toEqual([ 'a', 'b', 'c' ]);

            calls.finish('a');
            calls.finish('b');
            await flush();
            expect(calls.runningNames).toEqual([ 'c' ]);

            calls.finish('c');
            await flush();
            expect(calls.runningNames).toEqual([ 'first alone' ]);

            // Neither another step nor another step that runs alone joins a running one; the other step goes first
            void calls.submit(manager.queue.run, 'second alone', createStep(), { alone: true });
            void calls.submit(manager.queue.run, 'd', createStep());
            await flush();
            expect(calls.runningNames).toEqual([ 'first alone' ]);

            calls.finish('first alone');
            await flush();
            expect(calls.runningNames).toEqual([ 'd' ]);

            calls.finish('d');
            await flush();
            expect(calls.runningNames).toEqual([ 'second alone' ]);
        });

        it('applies new limits to the next admissions, and starts the steps they admit at once', async () => {
            const manager = createManager({ decoders: 1 });
            const calls = new ManualCalls();
            for (const name of [ 'a', 'b', 'c' ]) {
                void calls.submit(manager.queue.run, name, createStep());
            }
            await flush();
            expect(calls.runningNames).toEqual([ 'a' ]);

            manager.setLimits({ bytes: UNBOUNDED, decoders: 3 });
            await flush();
            expect(calls.runningNames).toEqual([ 'a', 'b', 'c' ]);

            // Lower limits leave running calls alone, and admit nothing until the running ones fit them
            manager.setLimits({ bytes: UNBOUNDED, decoders: 1 });
            void calls.submit(manager.queue.run, 'd', createStep());
            await flush();
            calls.finish('a');
            calls.finish('b');
            await flush();
            expect(calls.runningNames).toEqual([ 'c' ]);

            calls.finish('c');
            await flush();
            expect(calls.runningNames).toEqual([ 'd' ]);
        });
    });

    describe('background', () => {
        it('runs background steps one at a time, checks included, whatever the limits allow', async () => {
            const manager = createManager({});
            const calls = new ManualCalls();
            const first = manager.background(new ManualBackgroundRun());
            const second = manager.background(new ManualBackgroundRun());
            const names = [ 'first run', 'second check', 'first check', 'second run timed' ];
            void calls.submit(first.run, names[0], createStep());
            void calls.submit(second.check, names[1], createStep());
            void calls.submit(first.check, names[2], createStep());
            void calls.submit(second.runTimed, names[3], createStep());
            await flush();

            const order: string[] = [];
            while (calls.runningNames.length > 0) {
                expect(calls.runningNames).toHaveLength(1);
                const [ name ] = calls.runningNames;
                order.push(name);
                calls.finish(name);
                await flush();
            }
            expect(new Set(order)).toEqual(new Set(names));
            expect(calls.peakDecoders).toBe(1);
        });

        it('lets a negotiation step join a running background step, which no background step joins', async () => {
            const manager = createManager({});
            const calls = new ManualCalls();
            const background = manager.background(new ManualBackgroundRun());
            void calls.submit(background.runTimed, 'background', createStep());
            await flush();
            void calls.submit(manager.queue.runTimed, 'negotiation', createStep());
            void calls.submit(background.run, 'later background', createStep());
            await flush();
            expect(calls.runningNames).toEqual([ 'background', 'negotiation' ]);

            // The negotiation step still runs, so the next background step waits for it too
            calls.finish('background');
            await flush();
            expect(calls.runningNames).toEqual([ 'negotiation' ]);

            calls.finish('negotiation');
            await flush();
            expect(calls.runningNames).toEqual([ 'later background' ]);
        });

        it('holds a waiting background step while a negotiation step waits, one that runs alone included', async () => {
            const manager = createManager({ decoders: 2 });
            const calls = new ManualCalls();
            const background = manager.background(new ManualBackgroundRun());
            void calls.submit(manager.queue.run, 'running', createStep({ decoders: 1 }));
            await flush();
            // The background step would fit beside the running one, and the negotiation step that joined after it would not
            void calls.submit(background.check, 'background', createStep({ decoders: 1 }));
            void calls.submit(manager.queue.run, 'large', createStep({ decoders: 2 }));
            void calls.submit(manager.queue.run, 'alone', createStep({ decoders: 1 }), { alone: true });
            await flush();
            expect(calls.runningNames).toEqual([ 'running' ]);

            for (const name of [ 'running', 'large', 'alone' ]) {
                expect(calls.runningNames).toEqual([ name ]);
                calls.finish(name);
                await flush();
            }
            expect(calls.runningNames).toEqual([ 'background' ]);
        });

        it('runs the waiting steps of a run promoted while one of its steps runs beside that step at once', async () => {
            const manager = createManager({ decoders: 3 });
            const calls = new ManualCalls();
            const run = new ManualBackgroundRun();
            const view = manager.background(run);
            for (const name of [ 'a', 'b', 'c', 'd' ]) {
                void calls.submit(view.runTimed, name, createStep());
            }
            await flush();
            expect(calls.runningNames).toEqual([ 'a' ]);

            run.promote();
            await flush();
            // The promoted steps keep the limits, and no call settled to admit them
            expect(calls.runningNames).toEqual([ 'a', 'b', 'c' ]);
            expect(calls.peakDecoders).toBe(3);
        });
    });

    describe('timeouts', () => {
        it('hold a timed-out call\'s reservation until the call settles, and stop nothing when it settles within one more timeout', async () => {
            const manager = createManager({ decoders: 1 });
            const calls = new ManualCalls();
            const slow = calls.submit(manager.queue.runTimed, 'slow', createStep());
            const next = calls.submit(manager.queue.check, 'next', createStep());

            await vi.advanceTimersByTimeAsync(TIMEOUT_MILLISECONDS);
            await expect(slow).resolves.toBe(CAPABILITY_PROBE_TIMEOUT);
            expect(calls.runningNames).toEqual([ 'slow' ]);

            await vi.advanceTimersByTimeAsync(TIMEOUT_MILLISECONDS - 1);
            expect(calls.runningNames).toEqual([ 'slow' ]);

            calls.finish('slow');
            await flush();
            expect(calls.runningNames).toEqual([ 'next' ]);
            calls.finish('next');
            await expect(next).resolves.toBe('next');

            // The call settled before its unwind deadline, so passing that deadline stops nothing: later steps still run
            await vi.advanceTimersByTimeAsync(TIMEOUT_MILLISECONDS);
            const later = calls.submit(manager.queue.runTimed, 'later', createStep());
            await flush();
            expect(calls.runningNames).toEqual([ 'later' ]);
            calls.finish('later');
            await expect(later).resolves.toBe('later');

            // A negotiation's timeout leaves the background running
            expect(manager.isBackgroundHalted).toBe(false);
            const backgroundRun = new ManualBackgroundRun();
            const background = calls.submit(manager.background(backgroundRun).runTimed, 'background', createStep());
            await flush();
            calls.finish('background');
            await expect(background).resolves.toBe('background');
            expect(backgroundRun.timedOut).toBe(false);
        });

        it('stop every waiting and later step once a call outlives its timeout by another timeout', async () => {
            const manager = createManager({ decoders: 2 });
            const calls = new ManualCalls();
            const stuck = calls.submit(manager.queue.check, 'stuck', createStep());
            const bounded = calls.submit(manager.queue.run, 'bounded', createStep());
            const waiting = calls.submit(manager.queue.runTimed, 'waiting', createStep());

            await vi.advanceTimersByTimeAsync(TIMEOUT_MILLISECONDS);
            await expect(stuck).resolves.toBe(CAPABILITY_PROBE_TIMEOUT);
            expect(calls.runningNames).toEqual([ 'stuck', 'bounded' ]);

            await vi.advanceTimersByTimeAsync(TIMEOUT_MILLISECONDS);
            await expect(waiting).resolves.toBe(CAPABILITY_PROBE_TIMEOUT);

            // A call already running keeps its own result
            calls.finish('bounded');
            await expect(bounded).resolves.toBe('bounded');

            const backgroundRun = new ManualBackgroundRun();
            await expect(calls.submit(manager.queue.check, 'later check', createStep())).resolves.toBe(CAPABILITY_PROBE_TIMEOUT);
            await expect(calls.submit(manager.after(Promise.resolve()).run, 'later run', createStep())).resolves.toBe(CAPABILITY_PROBE_TIMEOUT);
            await expect(calls.submit(manager.background(backgroundRun).runTimed, 'later background', createStep()))
                .resolves.toBe(CAPABILITY_PROBE_TIMEOUT);
            expect(calls.started).toEqual([ 'stuck', 'bounded' ]);
            expect(backgroundRun.timedOut).toBe(true);
            expect(manager.isBackgroundHalted).toBe(true);
        });

        it('halt the background after a background timeout, while negotiations and promoted runs go on', async () => {
            const manager = createManager({ decoders: 2 });
            const calls = new ManualCalls();
            const timedOutRun = new ManualBackgroundRun();
            const waitingRun = new ManualBackgroundRun();
            const stuck = calls.submit(manager.background(timedOutRun).runTimed, 'stuck', createStep());
            await flush();
            const waiting = calls.submit(manager.background(waitingRun).check, 'waiting', createStep({ decoders: 2 }));
            await flush();
            expect(calls.runningNames).toEqual([ 'stuck' ]);

            await vi.advanceTimersByTimeAsync(TIMEOUT_MILLISECONDS);
            await expect(stuck).resolves.toBe(CAPABILITY_PROBE_TIMEOUT);
            await expect(waiting).resolves.toBe(CAPABILITY_PROBE_TIMEOUT);
            expect(timedOutRun.timedOut).toBe(true);
            expect(waitingRun.timedOut).toBe(true);
            expect(manager.isBackgroundHalted).toBe(true);

            // The halt outlasts the call that caused it
            calls.finish('stuck');
            await flush();
            const laterRun = new ManualBackgroundRun();
            await expect(calls.submit(manager.background(laterRun).run, 'later', createStep())).resolves.toBe(CAPABILITY_PROBE_TIMEOUT);
            expect(laterRun.timedOut).toBe(true);

            const promotedRun = new ManualBackgroundRun();
            promotedRun.promote();
            const promoted = calls.submit(manager.background(promotedRun).runTimed, 'promoted', createStep());
            const negotiation = calls.submit(manager.queue.runTimed, 'negotiation', createStep());
            await flush();
            calls.finish('promoted');
            calls.finish('negotiation');
            await expect(promoted).resolves.toBe('promoted');
            await expect(negotiation).resolves.toBe('negotiation');
            expect(promotedRun.timedOut).toBe(false);
            // Neither refused step ever called the browser
            expect(new Set(calls.started)).toEqual(new Set([ 'stuck', 'promoted', 'negotiation' ]));
        });

        it('count from a step\'s start, not from when it joined, and leave run untimed', async () => {
            const manager = createManager({ decoders: 1 });
            const calls = new ManualCalls();
            const long = calls.submit(manager.queue.run, 'long', createStep());
            const timed = calls.submit(manager.queue.runTimed, 'timed', createStep());

            await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MILLISECONDS);
            expect(calls.runningNames).toEqual([ 'long' ]);
            calls.finish('long');
            await expect(long).resolves.toBe('long');
            await flush();
            expect(calls.runningNames).toEqual([ 'timed' ]);

            await vi.advanceTimersByTimeAsync(TIMEOUT_MILLISECONDS - 1);
            calls.finish('timed');
            await expect(timed).resolves.toBe('timed');
        });
    });

    describe('gates and turns', () => {
        it('hold run and runTimed until the gate settles, however it settles, but not check', async () => {
            const manager = createManager({});
            const calls = new ManualCalls();
            let rejectGate: (reason: unknown) => void = (reason: unknown): void => {
                throw new Error(`Missing gate rejecter for ${String(reason)}`);
            };
            const view = manager.after(new Promise<void>((_resolve, reject) => {
                rejectGate = reject;
            }));
            void calls.submit(view.run, 'run', createStep());
            const timed = calls.submit(view.runTimed, 'run timed', createStep());
            const check = calls.submit(view.check, 'check', createStep());
            await flush();
            expect(calls.runningNames).toEqual([ 'check' ]);
            calls.finish('check');
            await expect(check).resolves.toBe('check');

            // The wait for the gate never counts against a timeout
            await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MILLISECONDS);
            expect(calls.started).toEqual([ 'check' ]);

            rejectGate(new Error('the audio probes failed'));
            await flush();
            expect(calls.runningNames).toEqual([ 'run', 'run timed' ]);

            await vi.advanceTimersByTimeAsync(TIMEOUT_MILLISECONDS - 1);
            calls.finish('run timed');
            await expect(timed).resolves.toBe('run timed');
        });

        it('hold a background run\'s run and runTimed until its turn, but not check', async () => {
            const manager = createManager({});
            const calls = new ManualCalls();
            const backgroundRun = new ManualBackgroundRun(false);
            const view = manager.background(backgroundRun);
            void calls.submit(view.run, 'run', createStep());
            const timed = calls.submit(view.runTimed, 'run timed', createStep());
            const check = calls.submit(view.check, 'check', createStep());
            await flush();
            expect(calls.runningNames).toEqual([ 'check' ]);
            calls.finish('check');
            await expect(check).resolves.toBe('check');

            // The wait for the turn never counts against a timeout
            await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MILLISECONDS);
            expect(calls.started).toEqual([ 'check' ]);

            backgroundRun.openTurn();
            await flush();
            // Background steps run one at a time, and the wait for the other step never counts against a timeout either
            expect(calls.runningNames).toEqual([ 'run' ]);
            await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MILLISECONDS);
            calls.finish('run');
            await flush();
            expect(calls.runningNames).toEqual([ 'run timed' ]);

            await vi.advanceTimersByTimeAsync(TIMEOUT_MILLISECONDS - 1);
            calls.finish('run timed');
            await expect(timed).resolves.toBe('run timed');
            expect(backgroundRun.timedOut).toBe(false);
        });
    });

    describe('errors', () => {
        it('reject with the call\'s error and release its reservation', async () => {
            const manager = createManager({ decoders: 1 });
            const calls = new ManualCalls();
            const error = new Error('the decoder closed');
            const failing = calls.submit(manager.queue.runTimed, 'failing', createStep());
            void calls.submit(manager.queue.run, 'next', createStep());
            await flush();
            calls.fail('failing', error);
            await expect(failing).rejects.toBe(error);
            await flush();
            expect(calls.runningNames).toEqual([ 'next' ]);
            calls.finish('next');
            await flush();

            // A call that throws before it returns a promise rejects the same way
            const thrown = manager.queue.check<string>(() => {
                throw error;
            }, createStep());
            void calls.submit(manager.queue.run, 'after throw', createStep());
            await expect(thrown).rejects.toBe(error);
            await flush();
            expect(calls.runningNames).toEqual([ 'after throw' ]);
        });

        it('of a call that already timed out release its reservation, with the caller keeping the timeout', async () => {
            const manager = createManager({ decoders: 1 });
            const calls = new ManualCalls();
            const late = calls.submit(manager.queue.runTimed, 'late', createStep());
            void calls.submit(manager.queue.run, 'next', createStep());
            await vi.advanceTimersByTimeAsync(TIMEOUT_MILLISECONDS);
            await expect(late).resolves.toBe(CAPABILITY_PROBE_TIMEOUT);

            calls.fail('late', new Error('the decoder closed'));
            await flush();
            expect(calls.runningNames).toEqual([ 'next' ]);
        });
    });

    describe('confirmation', () => {
        it('runs a negative result of a call that ran beside another again alone, and answers with that run\'s result', async () => {
            const manager = createManager({});
            const calls = new ManualCalls();
            const first = calls.submit(manager.queue.runTimed, 'first', createStep(), CONFIRM_REFUSAL);
            const second = calls.submit(manager.queue.check, 'second', createStep(), CONFIRM_REFUSAL);
            void calls.submit(manager.queue.run, 'other', createStep());
            await flush();
            const firstAnswer = vi.fn();
            const secondAnswer = vi.fn();
            void first.then(firstAnswer);
            void second.then(secondAnswer);

            calls.finish('first', REFUSED);
            calls.finish('second', REFUSED);
            await flush();
            // The runs again wait until nothing else runs or waits, so a step that joins meanwhile goes first
            void calls.submit(manager.queue.run, 'joined', createStep());
            await flush();
            expect(calls.runningNames).toEqual([ 'other', 'joined' ]);
            expect(firstAnswer).not.toHaveBeenCalled();
            expect(secondAnswer).not.toHaveBeenCalled();

            calls.finish('other');
            calls.finish('joined');
            await flush();
            expect(calls.runningNames).toEqual([ 'first' ]);
            calls.finish('first');
            await expect(first).resolves.toBe('first');

            // A refusal from a run alone is the answer
            await flush();
            expect(calls.runningNames).toEqual([ 'second' ]);
            calls.finish('second', REFUSED);
            await expect(second).resolves.toBe(REFUSED);
            expect(calls.started).toEqual([ 'first', 'second', 'other', 'joined', 'first', 'second' ]);
        });

        it('keeps a positive result of a call that ran beside another', async () => {
            const manager = createManager({});
            const calls = new ManualCalls();
            const confirmed = calls.submit(manager.queue.runTimed, 'confirmed', createStep(), CONFIRM_REFUSAL);
            void calls.submit(manager.queue.run, 'other', createStep());
            await flush();

            calls.finish('confirmed');
            await expect(confirmed).resolves.toBe('confirmed');
            expect(calls.started).toEqual([ 'confirmed', 'other' ]);
        });

        it('answers at once with a negative result of a call that ran alone, and counts a step that joined later as beside it', async () => {
            const manager = createManager({});
            const calls = new ManualCalls();
            const lone = calls.submit(manager.queue.runTimed, 'lone', createStep(), CONFIRM_REFUSAL);
            await flush();
            calls.finish('lone', REFUSED);
            await expect(lone).resolves.toBe(REFUSED);

            // A background call that no negotiation step joined ran alone too
            const background = calls.submit(manager.background(new ManualBackgroundRun()).runTimed, 'background', createStep(), CONFIRM_REFUSAL);
            await flush();
            calls.finish('background', REFUSED);
            await expect(background).resolves.toBe(REFUSED);

            // A step that joins a running call and settles first still ran beside it
            const joined = calls.submit(manager.queue.runTimed, 'joined', createStep(), CONFIRM_REFUSAL);
            await flush();
            void calls.submit(manager.queue.check, 'later', createStep());
            await flush();
            calls.finish('later');
            await flush();
            calls.finish('joined', REFUSED);
            await flush();
            expect(calls.runningNames).toEqual([ 'joined' ]);
            calls.finish('joined', REFUSED);
            await expect(joined).resolves.toBe(REFUSED);
            expect(calls.started).toEqual([ 'lone', 'background', 'joined', 'later', 'joined' ]);
        });

        it('never confirms a timeout or a rejection', async () => {
            const manager = createManager({});
            const calls = new ManualCalls();
            const confirmEverything: CapabilityProbeStepOptions<string> = { confirm: (): boolean => true };
            const slow = calls.submit(manager.queue.runTimed, 'slow', createStep(), confirmEverything);
            const failing = calls.submit(manager.queue.check, 'failing', createStep(), confirmEverything);
            await flush();

            const error = new Error('the decoder closed');
            calls.fail('failing', error);
            await expect(failing).rejects.toBe(error);
            await vi.advanceTimersByTimeAsync(TIMEOUT_MILLISECONDS);
            await expect(slow).resolves.toBe(CAPABILITY_PROBE_TIMEOUT);

            calls.finish('slow', REFUSED);
            await flush();
            expect(calls.runningNames).toEqual([]);
            expect(calls.started).toEqual([ 'slow', 'failing' ]);
        });

        it('times the run again from its own admission', async () => {
            const manager = createManager({});
            const calls = new ManualCalls();
            const refused = calls.submit(manager.queue.runTimed, 'refused', createStep(), CONFIRM_REFUSAL);
            void calls.submit(manager.queue.run, 'long', createStep());
            const answer = vi.fn();
            void refused.then(answer);
            await vi.advanceTimersByTimeAsync(TIMEOUT_MILLISECONDS - 1);
            calls.finish('refused', REFUSED);

            // Neither the first run's time nor the wait for the long step counts against the run again
            await vi.advanceTimersByTimeAsync(3 * TIMEOUT_MILLISECONDS);
            expect(calls.runningNames).toEqual([ 'long' ]);
            calls.finish('long');
            await flush();
            expect(calls.runningNames).toEqual([ 'refused' ]);

            await vi.advanceTimersByTimeAsync(TIMEOUT_MILLISECONDS - 1);
            expect(answer).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(answer).toHaveBeenCalledExactlyOnceWith(CAPABILITY_PROBE_TIMEOUT);
        });
    });
});
