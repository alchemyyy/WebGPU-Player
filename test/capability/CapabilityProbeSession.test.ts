import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CapabilityProbeBlock, type RecordedCapabilityProbeQueue } from 'webgpu-player/capability/CapabilityProbeSession';
import { describeAudioDecode, describeVideoDecode, type CapabilityProbeStep } from 'webgpu-player/capability/CapabilityProbeSteps';

import {
    createCapabilityProbeSession,
    createRecordedQueue,
    createRecordingStore,
    UNBOUNDED_LIMITS
} from '../helpers/capabilityProbeSession';

const PROBE = 'native-sdr:vp8';
const DECODES: readonly CapabilityProbeStep[] = [ 'vp8', 'vp09.00.10.08', 'av01.0.08M.08', 'hvc1.1.6.L120.B0' ].map(codec => (
    describeVideoDecode({ codec, codedHeight: 1_080, codedWidth: 1_920 }, 'I420')
));
const SURROUND_AAC_DECODE = describeAudioDecode({ codec: 'mp4a.40.2', numberOfChannels: 6, sampleRate: 48_000 }, 1_024);

type PendingCall = Readonly<{
    call: () => Promise<boolean>
    settle: () => void
    started: () => boolean
}>;

// A browser call that settles when the test says, and tells whether it started
function createPendingCall(): PendingCall {
    let started = false;
    let settle = (): void => undefined;
    return {
        call: (): Promise<boolean> => new Promise<boolean>((resolve) => {
            started = true;
            settle = (): void => resolve(true);
        }),
        settle: (): void => settle(),
        started: (): boolean => started
    };
}

function startAll(queue: RecordedCapabilityProbeQueue, steps: readonly CapabilityProbeStep[]): PendingCall[] {
    return steps.map((step: CapabilityProbeStep): PendingCall => {
        const pending = createPendingCall();
        void queue.runTimed(pending.call, step);
        return pending;
    });
}

describe('CapabilityProbeSession', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('never runs a step a declared defect crashes on the browser it affects', async () => {
        const call = vi.fn(async (): Promise<boolean> => true);
        const affected = await createRecordedQueue(createCapabilityProbeSession({ browserIdentity: { engine: 'webkit', majorVersion: 26 } }), PROBE);
        const unaffected = await createRecordedQueue(createCapabilityProbeSession(), PROBE);

        const outcome = await affected.runTimed(call, SURROUND_AAC_DECODE);

        expect(outcome).toBeInstanceOf(CapabilityProbeBlock);
        expect(outcome).toMatchObject({ reason: 'browser-defect' });
        expect(call).not.toHaveBeenCalled();
        await expect(unaffected.runTimed(call, SURROUND_AAC_DECODE)).resolves.toBe(true);
    });

    it('never runs or records a step that stopped an earlier page alone', async () => {
        const recordingStore = createRecordingStore({ blocked: new Set([ DECODES[0].label ]) });
        const queue = await createRecordedQueue(createCapabilityProbeSession({ store: recordingStore.store }), PROBE);
        const call = vi.fn(async (): Promise<boolean> => true);

        const outcome = await queue.check(call, DECODES[0]);

        expect(outcome).toMatchObject({ reason: 'stopped-page' });
        expect(call).not.toHaveBeenCalled();
        expect(recordingStore.markRunning).not.toHaveBeenCalled();
    });

    it('records each call once admitted, while it runs, and not while it waits', async () => {
        const recordingStore = createRecordingStore();
        const session = createCapabilityProbeSession({ limits: { bytes: UNBOUNDED_LIMITS.bytes, decoders: 1 }, store: recordingStore.store });
        const queue = await createRecordedQueue(session, PROBE);

        const [ first, second ] = startAll(queue, DECODES.slice(0, 2));

        await vi.waitFor(() => {
            expect(first.started()).toBe(true);
        });
        expect(recordingStore.inFlight()).toEqual([ DECODES[0].label ]);
        expect(recordingStore.markRunning).toHaveBeenCalledExactlyOnceWith(PROBE, DECODES[0].label, DECODES[0].cost);
        first.settle();
        await vi.waitFor(() => {
            expect(second.started()).toBe(true);
        });
        expect(recordingStore.inFlight()).toEqual([ DECODES[1].label ]);
        second.settle();
    });

    it('runs a suspect alone after the others, one decoder at a time, then clears it and restores the limits', async () => {
        const [ suspectStep, ...otherSteps ] = DECODES;
        const recordingStore = createRecordingStore({ suspects: new Map([ [ suspectStep.label, new Set([ PROBE ]) ] ]) });
        const session = createCapabilityProbeSession({ store: recordingStore.store });
        const queue = await createRecordedQueue(session, PROBE);
        expect(session.holdsSuspectSteps(PROBE)).toBe(true);

        const others = startAll(queue, otherSteps.slice(0, 2));
        const [ suspect ] = startAll(queue, [ suspectStep ]);
        // One decoder while the suspect remains: the others run one after another, and the suspect, waiting with them, after both
        for (const other of others) {
            await vi.waitFor(() => {
                expect(other.started()).toBe(true);
            });
            expect(recordingStore.inFlight()).toHaveLength(1);
            expect(suspect.started()).toBe(false);
            other.settle();
        }
        await vi.waitFor(() => {
            expect(suspect.started()).toBe(true);
        });
        expect(recordingStore.inFlight()).toEqual([ suspectStep.label ]);
        suspect.settle();
        await vi.waitFor(() => {
            expect(recordingStore.resolveSuspect).toHaveBeenCalledExactlyOnceWith(suspectStep.label);
        });
        expect(session.holdsSuspectSteps(PROBE)).toBe(false);

        // The limits come back without another read by a probe
        const afterwards = startAll(queue, otherSteps);
        await vi.waitFor(() => {
            expect(afterwards.every(pending => pending.started())).toBe(true);
        });
        expect(recordingStore.inFlight()).toHaveLength(otherSteps.length);
        for (const pending of afterwards) {
            pending.settle();
        }
    });

    it('forwards the caller\'s options: a suspect still runs alone, and a refusal beside another call runs again, recorded, and no suspect', async () => {
        const [ suspectStep, otherStep, refusedStep ] = DECODES;
        const recordingStore = createRecordingStore({ suspects: new Map([ [ suspectStep.label, new Set([ PROBE ]) ] ]) });
        const queue = await createRecordedQueue(createCapabilityProbeSession({ store: recordingStore.store }), PROBE);
        const confirmRefusal = { confirm: (decoded: boolean): boolean => !decoded };

        // The suspect ran alone, so its refusal is the answer
        const suspectCall = vi.fn(async (): Promise<boolean> => false);
        await expect(queue.runTimed(suspectCall, suspectStep, confirmRefusal)).resolves.toBe(false);
        expect(suspectCall).toHaveBeenCalledOnce();
        expect(recordingStore.resolveSuspect).toHaveBeenCalledExactlyOnceWith(suspectStep.label);
        // The limits come back once the last suspect settles
        await vi.advanceTimersByTimeAsync(0);

        const [ other ] = startAll(queue, [ otherStep ]);
        const refusedCall = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const refused = queue.runTimed(refusedCall, refusedStep, confirmRefusal);
        await vi.waitFor(() => {
            expect(refusedCall).toHaveBeenCalledOnce();
        });
        // The run again waits for the call that ran beside the refusal
        expect(recordingStore.inFlight()).toEqual([ otherStep.label ]);
        other.settle();

        await expect(refused).resolves.toBe(true);
        expect(refusedCall).toHaveBeenCalledTimes(2);
        expect(recordingStore.markRunning.mock.calls.filter(([ , step ]) => step === refusedStep.label)).toHaveLength(2);
        expect(recordingStore.resolveSuspect).toHaveBeenCalledOnce();
    });

    it('holds each limit at the stored ceiling', async () => {
        const decodeBytes = DECODES[0].cost.bytes;
        const recordingStore = createRecordingStore({ ceiling: { bytes: decodeBytes, decoders: UNBOUNDED_LIMITS.decoders } });
        const queue = await createRecordedQueue(createCapabilityProbeSession({ store: recordingStore.store }), PROBE);

        // Two calls of the same cost, which together hold more than the ceiling
        const [ first, second ] = startAll(queue, [ DECODES[0], DECODES[0] ]);

        await vi.waitFor(() => {
            expect(first.started()).toBe(true);
        });
        expect(second.started()).toBe(false);
        first.settle();
        await vi.waitFor(() => {
            expect(second.started()).toBe(true);
        });
        second.settle();
    });

    it.each([
        // A crash of checks alone held no bytes, which stay uncapped rather than letting one call run at a time
        { ceiling: { bytes: null, decoders: 2 }, deviceDecoders: UNBOUNDED_LIMITS.decoders, inFlight: 2 },
        // A cap above the device's keeps the device's
        { ceiling: { bytes: null, decoders: 2 }, deviceDecoders: 1, inFlight: 1 },
        { ceiling: { bytes: DECODES[0].cost.bytes, decoders: null }, deviceDecoders: UNBOUNDED_LIMITS.decoders, inFlight: 1 }
    ])('holds the calls in flight together at the lower of the device limit and a ceiling of $ceiling.bytes bytes and $ceiling.decoders decoders', async ({ ceiling, deviceDecoders, inFlight }) => {
        const recordingStore = createRecordingStore({ ceiling });
        const session = createCapabilityProbeSession({ limits: { bytes: UNBOUNDED_LIMITS.bytes, decoders: deviceDecoders }, store: recordingStore.store });
        const queue = await createRecordedQueue(session, PROBE);
        const calls = startAll(queue, [ DECODES[0], DECODES[0], DECODES[0] ]);

        await vi.waitFor(() => {
            expect(recordingStore.inFlight()).toHaveLength(inFlight);
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(calls.filter(pending => pending.started())).toHaveLength(inFlight);
        for (const pending of calls) {
            await vi.waitFor(() => {
                expect(pending.started()).toBe(true);
            });
            pending.settle();
        }
    });
});
