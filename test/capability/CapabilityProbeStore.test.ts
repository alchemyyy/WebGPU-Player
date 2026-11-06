import { afterEach, describe, expect, it, vi } from 'vitest';

import CapabilityProbeStore, {
    CAPABILITY_PROBE_RUNS_KEY,
    CAPABILITY_PROBE_STORE_KEY,
    CAPABILITY_PROBE_STORE_SCHEMA_VERSION,
    clearStoredCapabilityProbeVerdicts,
    configureCapabilityProbeStore,
    getDefaultCapabilityProbeStore,
    onCapabilityProbeCrash,
    readCapabilityProbeFingerprint,
    readStoredCapabilityProbeVerdictState,
    type CapabilityProbeFingerprint,
    type CapabilityProbeQuarantine,
    type CapabilityProbeStorage,
    type CrashedCapabilityProbe
} from 'webgpu-player/capability/CapabilityProbeStore';
import type { CapabilityProbeStepCost } from 'webgpu-player/capability/CapabilityProbeSteps';

import { createFakeWebLocks, type FakeWebLocks } from '../helpers/fakeWebLocks';

const SUPPORTED_AAC = Object.freeze({ codec: 'aac', codecString: 'mp4a.40.2', reason: 'decode-output-verified', status: 'supported' });
const UNSUPPORTED_OPUS = Object.freeze({ codec: 'opus', codecString: 'opus', reason: 'config-unsupported', status: 'unsupported' });
const TIMED_OUT_FLAC = Object.freeze({ codec: 'flac', codecString: 'flac', reason: 'probe-timeout', status: 'unknown' });
const SUPPORTED_HEVC = Object.freeze({ codec: 'hevc', codecString: 'hvc1.1.6.L120.90', reason: 'decode-output-verified', status: 'supported' });
const WRITE_TIME_MILLISECONDS = 1_000_000;
// A configuration check opens a decoder and holds no decoded bytes
const CHECK_COST: CapabilityProbeStepCost = Object.freeze({ bytes: 0, decoders: 1 });
const EMPTY_QUARANTINE: CapabilityProbeQuarantine = Object.freeze({ blocked: new Set<string>(), ceiling: null, suspects: new Map<string, ReadonlySet<string>>() });

/** A browser call a page has open: its probe, its step label, and what it holds, a check's by default. */
type OpenCall = Readonly<{ cost?: CapabilityProbeStepCost, probe: string, step: string }>;

function createFingerprint(buildKey: string): CapabilityProbeFingerprint {
    return {
        adapter: { features: [ 'shader-f16' ], info: { architecture: 'blackwell', vendor: 'nvidia' }, limits: { maxTextureDimension2D: 16_384 } },
        buildKey,
        userAgent: 'Mozilla/5.0 Chrome/150.0.0.0',
        userAgentData: { platformVersion: '19.0.0' }
    };
}

function createMemoryStorage(): CapabilityProbeStorage & { entries: Map<string, string> } {
    const entries = new Map<string, string>();
    return {
        entries,
        getItem: (key: string): string | null => entries.get(key) ?? null,
        removeItem: (key: string): void => {
            entries.delete(key);
        },
        setItem: (key: string, value: string): void => {
            entries.set(key, value);
        }
    };
}

function createStore(
    storage: CapabilityProbeStorage,
    fingerprint: CapabilityProbeFingerprint | null = createFingerprint('build-1'),
    now: () => number = (): number => WRITE_TIME_MILLISECONDS
): CapabilityProbeStore {
    return new CapabilityProbeStore({ now, readFingerprint: () => Promise.resolve(fingerprint), storage: () => storage });
}

type PageOptions = Readonly<{
    fingerprint?: CapabilityProbeFingerprint
    locks: FakeWebLocks
    pageId: string
    storage: CapabilityProbeStorage
    /** Receives the page's visibility listener */
    watchPage?: (listener: (visible: boolean) => void) => boolean
}>;

/** Creates the store of one page that records its runs, sharing the storage and the Web Locks with the test's other pages. */
function createPageStore(options: PageOptions): CapabilityProbeStore {
    return new CapabilityProbeStore({
        locks: () => options.locks.forPage(options.pageId),
        now: (): number => WRITE_TIME_MILLISECONDS,
        pageId: options.pageId,
        readFingerprint: () => Promise.resolve(options.fingerprint ?? createFingerprint('build-1')),
        storage: () => options.storage,
        ...(options.watchPage ? { watchPage: options.watchPage } : {})
    });
}

describe('CapabilityProbeStore', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('reads back a verdict for the fingerprint that wrote it', async () => {
        const store = createStore(createMemoryStorage());

        await store.write('native-audio', [ SUPPORTED_AAC, UNSUPPORTED_OPUS ]);

        expect(await store.read('native-audio')).toEqual([ SUPPORTED_AAC, UNSUPPORTED_OPUS ]);
        expect(await store.read('native-surround-audio')).toBeNull();
    });

    it('misses on another fingerprint, and a write there replaces the entry', async () => {
        const storage = createMemoryStorage();
        await createStore(storage).write('native-audio', [ SUPPORTED_AAC ]);
        const updatedStore = createStore(storage, createFingerprint('build-2'));

        expect(await updatedStore.read('native-audio')).toBeNull();
        await updatedStore.write('native-sdr:hevc', SUPPORTED_HEVC);

        // The old build's verdicts leave with its fingerprint rather than staying beside the new ones
        expect(storage.entries.size).toBe(1);
        expect(await createStore(storage).read('native-audio')).toBeNull();
        expect(updatedStore.readState()?.probes).toEqual([ 'native-sdr:hevc' ]);
    });

    it('takes fingerprints that differ only in key order as the same', async () => {
        const storage = createMemoryStorage();
        const fingerprint = createFingerprint('build-1');
        await createStore(storage, fingerprint).write('native-sdr:hevc', SUPPORTED_HEVC);
        const reordered: CapabilityProbeFingerprint = {
            userAgentData: fingerprint.userAgentData,
            userAgent: fingerprint.userAgent,
            buildKey: fingerprint.buildKey,
            adapter: fingerprint.adapter
        };

        expect(await createStore(storage, reordered).read('native-sdr:hevc')).toEqual(SUPPORTED_HEVC);
    });

    it('misses on another schema version and overwrites that entry', async () => {
        const storage = createMemoryStorage();
        const store = createStore(storage);
        await store.write('native-sdr:hevc', SUPPORTED_HEVC);
        const entry = JSON.parse(storage.getItem(CAPABILITY_PROBE_STORE_KEY) ?? '{}') as Record<string, unknown>;
        storage.setItem(CAPABILITY_PROBE_STORE_KEY, JSON.stringify({ ...entry, schema: CAPABILITY_PROBE_STORE_SCHEMA_VERSION + 1 }));

        expect(await store.read('native-sdr:hevc')).toBeNull();
        await store.write('native-audio', [ SUPPORTED_AAC ]);

        expect(store.readState()?.probes).toEqual([ 'native-audio' ]);
    });

    it('misses on an unreadable entry', async () => {
        const storage = createMemoryStorage();
        storage.setItem(CAPABILITY_PROBE_STORE_KEY, '{not json');

        expect(await createStore(storage).read('native-audio')).toBeNull();
    });

    it('merges the verdicts of probes written one after another', async () => {
        const storage = createMemoryStorage();
        await createStore(storage).write('native-sdr:hevc', SUPPORTED_HEVC);
        await createStore(storage).write('native-sdr:vp8', { ...SUPPORTED_HEVC, codec: 'vp8', codecString: 'vp8' });

        const store = createStore(storage);
        expect(await store.read('native-sdr:hevc')).toEqual(SUPPORTED_HEVC);
        expect(await store.read('native-sdr:vp8')).toMatchObject({ codec: 'vp8' });
    });

    it('never stores an unknown or not-probed result', async () => {
        const storage = createMemoryStorage();
        const store = createStore(storage);

        await store.write('native-audio', [ SUPPORTED_AAC, TIMED_OUT_FLAC ]);
        await store.write('native-sdr:hevc', { ...SUPPORTED_HEVC, reason: 'probe-exception', status: 'unknown' });
        await store.write('native-sdr:vp8', { ...SUPPORTED_HEVC, reason: 'not-probed', status: 'not-probed' });
        await store.write('h264-profiles', null);

        expect(storage.entries.size).toBe(0);
    });

    it('ignores a stored entry whose verdict was altered to unknown', async () => {
        const storage = createMemoryStorage();
        const store = createStore(storage);
        await store.write('native-sdr:hevc', SUPPORTED_HEVC);
        const entry = JSON.parse(storage.getItem(CAPABILITY_PROBE_STORE_KEY) ?? '{}') as { verdicts: Record<string, unknown> };
        entry.verdicts['native-sdr:hevc'] = { ...SUPPORTED_HEVC, status: 'unknown' };
        storage.setItem(CAPABILITY_PROBE_STORE_KEY, JSON.stringify(entry));

        expect(await store.read('native-sdr:hevc')).toBeNull();
    });

    it('keeps nothing without a fingerprint', async () => {
        const storage = createMemoryStorage();
        const store = createStore(storage, null);

        await store.write('native-sdr:hevc', SUPPORTED_HEVC);

        expect(storage.entries.size).toBe(0);
        expect(await store.read('native-sdr:hevc')).toBeNull();
    });

    it('reports the stored fingerprint and the age of the last write', async () => {
        let nowMilliseconds = WRITE_TIME_MILLISECONDS;
        const store = createStore(createMemoryStorage(), createFingerprint('build-1'), (): number => nowMilliseconds);
        expect(store.readState()).toBeNull();

        await store.write('native-sdr:hevc', SUPPORTED_HEVC);
        nowMilliseconds += 5_000;

        expect(store.readState()).toEqual({
            ageMilliseconds: 5_000,
            blockedSteps: [],
            ceiling: null,
            crashedProbes: [],
            fingerprint: createFingerprint('build-1'),
            probes: [ 'native-sdr:hevc' ],
            suspectSteps: [],
            writtenAtMilliseconds: WRITE_TIME_MILLISECONDS
        });
    });

    it('clears after a failed start only when the page used a stored verdict', async () => {
        const storage = createMemoryStorage();
        const store = createStore(storage);
        const clearListener = vi.fn();
        store.onClear(clearListener);
        await store.write('native-sdr:hevc', SUPPORTED_HEVC);

        expect(store.clearAfterStartFailure()).toBe(false);
        expect(storage.entries.size).toBe(1);

        store.recordServedVerdict();
        expect(store.clearAfterStartFailure()).toBe(true);

        expect(storage.entries.size).toBe(0);
        expect(clearListener).toHaveBeenCalledOnce();
        // The clear also forgets the served verdict, so a second failure has nothing to clear
        expect(store.clearAfterStartFailure()).toBe(false);
    });

    it('keeps working when storage refuses a write', async () => {
        const storage = createMemoryStorage();
        storage.setItem = (): void => {
            throw new DOMException('Quota exceeded', 'QuotaExceededError');
        };
        const store = createStore(storage);

        await expect(store.write('native-sdr:hevc', SUPPORTED_HEVC)).resolves.toBeUndefined();
        expect(await store.read('native-sdr:hevc')).toBeNull();
    });
});

describe('the run journal', () => {
    /** Reads the probes each page's record holds, with their steps, by page. */
    function readRunRecords(storage: CapabilityProbeStorage): Record<string, readonly CrashedCapabilityProbe[]> {
        return Object.fromEntries(Object.entries(readRawRunRecords(storage)).map(([ pageId, runs ]) => [ pageId, runs.probes ]));
    }

    /** Reads what each page's record says its open calls hold together, by page. */
    function readRunTotals(storage: CapabilityProbeStorage): Record<string, CapabilityProbeStepCost> {
        return Object.fromEntries(Object.entries(readRawRunRecords(storage)).map(([ pageId, runs ]) => [ pageId, runs.inFlight ]));
    }

    function readRawRunRecords(storage: CapabilityProbeStorage): Record<string, { inFlight: CapabilityProbeStepCost, probes: readonly CrashedCapabilityProbe[] }> {
        const text = storage.getItem(CAPABILITY_PROBE_RUNS_KEY);
        if (text === null) {
            return {};
        }
        // The store wrote the entry in this layout
        const entry = JSON.parse(text) as { pages: Record<string, { inFlight: CapabilityProbeStepCost, probes: readonly CrashedCapabilityProbe[] }> };
        return entry.pages;
    }

    /** Opens a page's run journal, opens its calls, and stops the page in them, as a crash does. */
    async function stopPageInCalls(options: PageOptions, calls: readonly OpenCall[]): Promise<void> {
        const page = createPageStore(options);
        await page.readQuarantine();
        for (const { cost = CHECK_COST, probe, step } of calls) {
            await page.markRunning(probe, step, cost);
        }
        // Nothing ends the calls, so the page's record stays
        options.locks.stopPage(options.pageId);
    }

    const HEVC_DECODE_COST: CapabilityProbeStepCost = Object.freeze({ bytes: 3_000, decoders: 1 });
    const AAC_DECODE_COST: CapabilityProbeStepCost = Object.freeze({ bytes: 1_000, decoders: 1 });
    // Two configuration checks and two decodes, in flight together on one page
    const CONCURRENT_CALLS: readonly OpenCall[] = [
        { probe: 'native-audio', step: 'check mp4a.40.2 2ch 48000Hz' },
        { probe: 'native-audio', step: 'check opus 2ch 48000Hz' },
        { cost: AAC_DECODE_COST, probe: 'native-audio', step: 'decode mp4a.40.2 2ch 48000Hz' },
        { cost: HEVC_DECODE_COST, probe: 'native-sdr:hevc', step: 'decode hvc1.1.6.L120.90 1920x1080' }
    ];
    const CONCURRENT_TOTALS: CapabilityProbeStepCost = {
        bytes: AAC_DECODE_COST.bytes + HEVC_DECODE_COST.bytes,
        decoders: CONCURRENT_CALLS.length
    };

    it('blocks the one step a stopped page had in flight, and drops the verdicts of its probe', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        const stoppedPage = createPageStore({ locks, pageId: 'page-1', storage });
        await stoppedPage.write('native-sdr:hevc', SUPPORTED_HEVC);
        await stoppedPage.write('native-audio', [ SUPPORTED_AAC ]);
        expect(await stoppedPage.readQuarantine()).toEqual(EMPTY_QUARANTINE);
        // Two calls of one step are still one step
        await stoppedPage.markRunning('native-sdr:hevc', 'decode hevc', HEVC_DECODE_COST);
        await stoppedPage.markRunning('native-sdr:hevc', 'decode hevc', HEVC_DECODE_COST);
        locks.stopPage('page-1');

        const laterPage = createPageStore({ locks, pageId: 'page-2', storage });

        expect(await laterPage.readQuarantine()).toEqual({ blocked: new Set([ 'decode hevc' ]), ceiling: null, suspects: new Map() });
        expect(await laterPage.read('native-sdr:hevc')).toBeNull();
        expect(laterPage.readState()).toMatchObject({
            blockedSteps: [ 'decode hevc' ],
            ceiling: null,
            crashedProbes: [ { probe: 'native-sdr:hevc', steps: [ 'decode hevc' ] } ],
            probes: [ 'native-audio' ],
            suspectSteps: []
        });
        expect(readRunRecords(storage)).toEqual({});
    });

    it('makes suspects of the steps a stopped page had in flight together, and drops the verdicts of their probes', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        const writer = createStore(storage);
        await writer.write('native-audio', [ SUPPORTED_AAC ]);
        await writer.write('native-sdr:hevc', SUPPORTED_HEVC);
        await writer.write('native-sdr:vp8', { ...SUPPORTED_HEVC, codec: 'vp8', codecString: 'vp8' });
        await stopPageInCalls({ locks, pageId: 'page-1', storage }, CONCURRENT_CALLS);
        const laterPage = createPageStore({ locks, pageId: 'page-2', storage });
        const listener = vi.fn();
        laterPage.onCrash(listener);

        expect(await laterPage.readQuarantine()).toEqual({
            blocked: new Set(),
            ceiling: null,
            suspects: new Map([
                [ 'check mp4a.40.2 2ch 48000Hz', new Set([ 'native-audio' ]) ],
                [ 'check opus 2ch 48000Hz', new Set([ 'native-audio' ]) ],
                [ 'decode hvc1.1.6.L120.90 1920x1080', new Set([ 'native-sdr:hevc' ]) ],
                [ 'decode mp4a.40.2 2ch 48000Hz', new Set([ 'native-audio' ]) ]
            ])
        });
        expect(listener).toHaveBeenCalledExactlyOnceWith([
            { probe: 'native-audio', steps: [ 'check mp4a.40.2 2ch 48000Hz', 'check opus 2ch 48000Hz', 'decode mp4a.40.2 2ch 48000Hz' ] },
            { probe: 'native-sdr:hevc', steps: [ 'decode hvc1.1.6.L120.90 1920x1080' ] }
        ]);
        expect(laterPage.readState()).toMatchObject({
            blockedSteps: [],
            crashedProbes: [
                { probe: 'native-audio', steps: [ 'check mp4a.40.2 2ch 48000Hz', 'check opus 2ch 48000Hz', 'decode mp4a.40.2 2ch 48000Hz' ] },
                { probe: 'native-sdr:hevc', steps: [ 'decode hvc1.1.6.L120.90 1920x1080' ] }
            ],
            probes: [ 'native-sdr:vp8' ],
            suspectSteps: [ 'check mp4a.40.2 2ch 48000Hz', 'check opus 2ch 48000Hz', 'decode hvc1.1.6.L120.90 1920x1080', 'decode mp4a.40.2 2ch 48000Hz' ]
        });
    });

    it('sets the ceiling below what a crash\'s calls held once all its suspects pass alone, keeping the lower of each limit', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        await stopPageInCalls({ locks, pageId: 'page-1', storage }, CONCURRENT_CALLS);
        const bisectingPage = createPageStore({ locks, pageId: 'page-2', storage });
        const { suspects } = await bisectingPage.readQuarantine();

        // A step that is no suspect changes nothing
        bisectingPage.resolveSuspect('check vp8 640x360');
        // The ceiling waits for the last suspect
        for (const step of suspects.keys()) {
            expect((await bisectingPage.readQuarantine()).ceiling).toBeNull();
            bisectingPage.resolveSuspect(step);
        }

        const firstCeiling = { bytes: CONCURRENT_TOTALS.bytes - 1, decoders: CONCURRENT_TOTALS.decoders - 1 };
        expect(await createPageStore({ locks, pageId: 'page-3', storage }).readQuarantine()).toEqual({ blocked: new Set(), ceiling: firstCeiling, suspects: new Map() });
        expect(bisectingPage.readState()).toMatchObject({ blockedSteps: [], ceiling: firstCeiling, crashedProbes: [], suspectSteps: [] });

        // A later concurrency crash with fewer bytes but more decoders in flight lowers only the bytes
        const fewerBytesCost: CapabilityProbeStepCost = { bytes: 10, decoders: 1 };
        await stopPageInCalls({ locks, pageId: 'page-4', storage }, [
            ...CONCURRENT_CALLS.map((call: OpenCall): OpenCall => ({ ...call, cost: fewerBytesCost })),
            { cost: fewerBytesCost, probe: 'native-sdr:vp8', step: 'decode vp8 640x360' }
        ]);
        const secondBisectingPage = createPageStore({ locks, pageId: 'page-5', storage });
        for (const step of (await secondBisectingPage.readQuarantine()).suspects.keys()) {
            secondBisectingPage.resolveSuspect(step);
        }

        expect((await createPageStore({ locks, pageId: 'page-6', storage }).readQuarantine()).ceiling).toEqual({
            bytes: fewerBytesCost.bytes * (CONCURRENT_CALLS.length + 1) - 1,
            decoders: firstCeiling.decoders
        });
    });

    /** Stops a page in calls together, then lets a later page pass every suspect alone, and resolves the ceiling that leaves. */
    async function passConcurrencyCrash(storage: CapabilityProbeStorage, locks: FakeWebLocks, pageIds: readonly [ string, string ], calls: readonly OpenCall[]): Promise<CapabilityProbeQuarantine['ceiling']> {
        const [ stoppedPageId, bisectingPageId ] = pageIds;
        await stopPageInCalls({ locks, pageId: stoppedPageId, storage }, calls);
        const bisectingPage = createPageStore({ locks, pageId: bisectingPageId, storage });
        for (const step of (await bisectingPage.readQuarantine()).suspects.keys()) {
            bisectingPage.resolveSuspect(step);
        }
        return (await bisectingPage.readQuarantine()).ceiling;
    }

    it('caps only the dimensions a concurrency crash held some of, and a later crash only lowers each cap', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        const checks = CONCURRENT_CALLS.slice(0, 2);

        // Checks hold no decoded bytes, so their crash says nothing of bytes
        const checksCeiling = await passConcurrencyCrash(storage, locks, [ 'page-1', 'page-2' ], checks);
        expect(checksCeiling).toEqual({ bytes: null, decoders: checks.length - 1 });
        expect(createPageStore({ locks, pageId: 'page-3', storage }).readState()?.ceiling).toEqual(checksCeiling);

        // A crash that held bytes caps them strictly below its total, and keeps the lower decoder cap
        const decodesCeiling = await passConcurrencyCrash(storage, locks, [ 'page-4', 'page-5' ], CONCURRENT_CALLS);
        expect(decodesCeiling).toEqual({ bytes: CONCURRENT_TOTALS.bytes - 1, decoders: checksCeiling?.decoders });

        // A later crash of no bytes keeps the bytes cap
        expect(await passConcurrencyCrash(storage, locks, [ 'page-6', 'page-7' ], checks)).toEqual(decodesCeiling);
    });

    it('reads a stored ceiling of two amounts as both capped', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        await passConcurrencyCrash(storage, locks, [ 'page-1', 'page-2' ], CONCURRENT_CALLS);
        const entry = JSON.parse(storage.getItem(CAPABILITY_PROBE_STORE_KEY) ?? '{}') as { quarantine: Record<string, unknown> };
        const amounts = { bytes: 1_024, decoders: 2 };
        storage.setItem(CAPABILITY_PROBE_STORE_KEY, JSON.stringify({ ...entry, quarantine: { ...entry.quarantine, ceiling: amounts } }));

        expect((await createPageStore({ locks, pageId: 'page-3', storage }).readQuarantine()).ceiling).toEqual(amounts);
    });

    it('keeps the bisect open when a step that was no suspect stops a page alone', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        await stopPageInCalls({ locks, pageId: 'page-1', storage }, CONCURRENT_CALLS);
        const unrelated: OpenCall = { cost: HEVC_DECODE_COST, probe: 'native-sdr:vp8', step: 'decode vp8 640x360' };
        await stopPageInCalls({ locks, pageId: 'page-2', storage }, [ unrelated ]);
        const bisectingPage = createPageStore({ locks, pageId: 'page-3', storage });
        const quarantine = await bisectingPage.readQuarantine();

        expect(quarantine.blocked).toEqual(new Set([ unrelated.step ]));
        expect(quarantine.suspects.size).toBe(CONCURRENT_CALLS.length);
        for (const step of quarantine.suspects.keys()) {
            bisectingPage.resolveSuspect(step);
        }

        // Every suspect passed alone, so the first crash came from running them together
        expect(await bisectingPage.readQuarantine()).toEqual({
            blocked: new Set([ unrelated.step ]),
            ceiling: { bytes: CONCURRENT_TOTALS.bytes - 1, decoders: CONCURRENT_TOTALS.decoders - 1 },
            suspects: new Map()
        });
    });

    it('keeps the bisect open when a blocked step stops a page alone again, and adds the probe to it', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        const blockedStep = 'decode vp8 640x360';
        await stopPageInCalls({ locks, pageId: 'page-1', storage }, [ { cost: HEVC_DECODE_COST, probe: 'native-sdr:vp8', step: blockedStep } ]);
        await stopPageInCalls({ locks, pageId: 'page-2', storage }, CONCURRENT_CALLS);
        await stopPageInCalls({ locks, pageId: 'page-3', storage }, [ { cost: HEVC_DECODE_COST, probe: 'native-sdr:vp8-alpha', step: blockedStep } ]);
        const bisectingPage = createPageStore({ locks, pageId: 'page-4', storage });
        for (const step of (await bisectingPage.readQuarantine()).suspects.keys()) {
            bisectingPage.resolveSuspect(step);
        }

        expect((await bisectingPage.readQuarantine()).ceiling).toEqual({ bytes: CONCURRENT_TOTALS.bytes - 1, decoders: CONCURRENT_TOTALS.decoders - 1 });
        expect(bisectingPage.readState()?.crashedProbes).toEqual([
            { probe: 'native-sdr:vp8', steps: [ blockedStep ] },
            { probe: 'native-sdr:vp8-alpha', steps: [ blockedStep ] }
        ]);
    });

    it('blocks a suspect that stops a page again alone, and leaves no ceiling once the others pass', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        await stopPageInCalls({ locks, pageId: 'page-1', storage }, CONCURRENT_CALLS);
        const culprit = 'decode hvc1.1.6.L120.90 1920x1080';
        await stopPageInCalls({ locks, pageId: 'page-2', storage }, [ { cost: HEVC_DECODE_COST, probe: 'native-sdr:hevc', step: culprit } ]);
        const laterPage = createPageStore({ locks, pageId: 'page-3', storage });
        const quarantine = await laterPage.readQuarantine();

        expect(quarantine.blocked).toEqual(new Set([ culprit ]));
        expect([ ...quarantine.suspects.keys() ]).not.toContain(culprit);
        for (const step of quarantine.suspects.keys()) {
            laterPage.resolveSuspect(step);
        }
        expect(await laterPage.readQuarantine()).toEqual({ blocked: new Set([ culprit ]), ceiling: null, suspects: new Map() });

        // The culprit ended that bisect: a later concurrency crash, all of whose suspects pass, sets the ceiling
        await stopPageInCalls({ locks, pageId: 'page-4', storage }, CONCURRENT_CALLS.slice(0, 2));
        const nextBisectingPage = createPageStore({ locks, pageId: 'page-5', storage });
        for (const step of (await nextBisectingPage.readQuarantine()).suspects.keys()) {
            nextBisectingPage.resolveSuspect(step);
        }
        expect((await nextBisectingPage.readQuarantine()).ceiling).toEqual({ bytes: null, decoders: 1 });
    });

    it('makes no suspect again of a blocked step in flight with others', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        const blockedCall: OpenCall = { probe: 'native-audio', step: 'check mp4a.40.2 2ch 48000Hz' };
        const otherCall: OpenCall = { probe: 'native-sdr:hevc', step: 'check hvc1.1.6.L120.90 1920x1080' };
        await stopPageInCalls({ locks, pageId: 'page-1', storage }, [ blockedCall ]);
        await stopPageInCalls({ locks, pageId: 'page-2', storage }, [ blockedCall, otherCall ]);

        expect(await createPageStore({ locks, pageId: 'page-3', storage }).readQuarantine()).toEqual({
            blocked: new Set([ blockedCall.step ]),
            ceiling: null,
            suspects: new Map([ [ otherCall.step, new Set([ otherCall.probe ]) ] ])
        });
    });

    it('keeps every step a probe has in flight with what the calls hold, and tells each finder only of the crashes it found', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        const firstStoppedPage = createPageStore({ locks, pageId: 'page-1', storage });
        await firstStoppedPage.readQuarantine();
        await firstStoppedPage.markRunning('native-audio', 'check opus', CHECK_COST);
        await firstStoppedPage.markRunning('native-audio', 'check mp4a.40.2', CHECK_COST);
        await firstStoppedPage.markRunning('native-sdr:hevc', 'decode hevc', HEVC_DECODE_COST);
        const secondStoppedPage = createPageStore({ locks, pageId: 'page-3', storage });
        await secondStoppedPage.readQuarantine();
        await secondStoppedPage.markRunning('native-audio', 'decode aac', AAC_DECODE_COST);

        expect(readRunRecords(storage)).toEqual({
            'page-1': [
                { probe: 'native-audio', steps: [ 'check mp4a.40.2', 'check opus' ] },
                { probe: 'native-sdr:hevc', steps: [ 'decode hevc' ] }
            ],
            'page-3': [ { probe: 'native-audio', steps: [ 'decode aac' ] } ]
        });
        expect(readRunTotals(storage)).toEqual({
            'page-1': { bytes: HEVC_DECODE_COST.bytes, decoders: 3 },
            'page-3': AAC_DECODE_COST
        });

        locks.stopPage('page-1');
        const firstFinder = createPageStore({ locks, pageId: 'page-2', storage });
        const firstFinderListener = vi.fn();
        firstFinder.onCrash(firstFinderListener);
        await firstFinder.readQuarantine();

        expect(firstFinderListener).toHaveBeenCalledExactlyOnceWith([
            { probe: 'native-audio', steps: [ 'check mp4a.40.2', 'check opus' ] },
            { probe: 'native-sdr:hevc', steps: [ 'decode hevc' ] }
        ]);

        locks.stopPage('page-3');
        const secondFinder = createPageStore({ locks, pageId: 'page-4', storage });
        const secondFinderListener = vi.fn();
        secondFinder.onCrash(secondFinderListener);
        await secondFinder.readQuarantine();

        // The listener hears only the crash its page found, while the entry joins its steps with those stored before
        expect(secondFinderListener).toHaveBeenCalledExactlyOnceWith([ { probe: 'native-audio', steps: [ 'decode aac' ] } ]);
        expect(secondFinder.readState()).toMatchObject({
            blockedSteps: [ 'decode aac' ],
            crashedProbes: [
                { probe: 'native-audio', steps: [ 'check mp4a.40.2', 'check opus', 'decode aac' ] },
                { probe: 'native-sdr:hevc', steps: [ 'decode hevc' ] }
            ],
            suspectSteps: [ 'check mp4a.40.2', 'check opus', 'decode hevc' ]
        });
        // The first finder reads no crash again once its journal is open
        await firstFinder.readQuarantine();
        expect(firstFinderListener).toHaveBeenCalledOnce();
    });

    it('tells no crash listener on a page that finds no stopped page', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        const runningPage = createPageStore({ locks, pageId: 'page-1', storage });
        await runningPage.readQuarantine();
        await runningPage.markRunning('native-audio', 'check mp4a.40.2', CHECK_COST);
        const laterPage = createPageStore({ locks, pageId: 'page-2', storage });
        const listener = vi.fn();
        laterPage.onCrash(listener);

        expect(await laterPage.readQuarantine()).toEqual(EMPTY_QUARANTINE);
        expect(listener).not.toHaveBeenCalled();
    });

    it('records the crash and tells every other listener when a crash listener throws', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        await stopPageInCalls({ locks, pageId: 'page-1', storage }, [ { cost: AAC_DECODE_COST, probe: 'native-audio', step: 'decode aac' } ]);
        const laterPage = createPageStore({ locks, pageId: 'page-2', storage });
        const throwingListener = vi.fn((): void => {
            throw new Error('Listener failed');
        });
        const listener = vi.fn();
        laterPage.onCrash(throwingListener);
        laterPage.onCrash(listener);

        expect((await laterPage.readQuarantine()).blocked).toEqual(new Set([ 'decode aac' ]));
        expect(throwingListener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledExactlyOnceWith([ { probe: 'native-audio', steps: [ 'decode aac' ] } ]);
        expect(laterPage.readState()?.crashedProbes).toEqual([ { probe: 'native-audio', steps: [ 'decode aac' ] } ]);
    });

    it('leaves the record of a page that still runs, which drops each step once its last call ends, and the record with the last step', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        const runningPage = createPageStore({ locks, pageId: 'page-1', storage });
        await runningPage.readQuarantine();
        const endFirstCall = await runningPage.markRunning('native-audio', 'decode mp4a.40.2', AAC_DECODE_COST);
        const endSecondCall = await runningPage.markRunning('native-audio', 'decode mp4a.40.2', AAC_DECODE_COST);
        const endThirdCall = await runningPage.markRunning('native-audio', 'check opus', CHECK_COST);

        expect(await createPageStore({ locks, pageId: 'page-2', storage }).readQuarantine()).toEqual(EMPTY_QUARANTINE);
        expect(readRunRecords(storage)).toEqual({ 'page-1': [ { probe: 'native-audio', steps: [ 'check opus', 'decode mp4a.40.2' ] } ] });
        expect(readRunTotals(storage)).toEqual({ 'page-1': { bytes: 2 * AAC_DECODE_COST.bytes, decoders: 3 } });

        // Each end counts once, so the record keeps the step for the call still open, and holds what that call holds
        endFirstCall();
        endFirstCall();
        await vi.waitFor(() => expect(readRunTotals(storage)).toEqual({ 'page-1': { bytes: AAC_DECODE_COST.bytes, decoders: 2 } }));
        expect(readRunRecords(storage)).toEqual({ 'page-1': [ { probe: 'native-audio', steps: [ 'check opus', 'decode mp4a.40.2' ] } ] });
        endSecondCall();
        await vi.waitFor(() => expect(readRunRecords(storage)).toEqual({ 'page-1': [ { probe: 'native-audio', steps: [ 'check opus' ] } ] }));
        expect(readRunTotals(storage)).toEqual({ 'page-1': CHECK_COST });
        endThirdCall();
        expect(readRunRecords(storage)).toEqual({});
    });

    it('drops the page\'s record while it hides, writes it again as it shows, and takes no crash from a page that ended hidden', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        const visibilityListeners: Array<(visible: boolean) => void> = [];
        const setVisible = (visible: boolean): void => {
            for (const listener of visibilityListeners) {
                listener(visible);
            }
        };
        const page = createPageStore({
            locks,
            pageId: 'page-1',
            storage,
            watchPage: (listener: (visible: boolean) => void): boolean => {
                visibilityListeners.push(listener);
                return true;
            }
        });
        await page.readQuarantine();
        await page.markRunning('native-audio', 'check mp4a.40.2', CHECK_COST);

        setVisible(false);
        await page.markRunning('native-surround-audio', 'check ec-3', CHECK_COST);
        expect(readRunRecords(storage)).toEqual({});
        setVisible(true);
        // Showing again writes the record once the page holds its lock
        await vi.waitFor(() => expect(readRunRecords(storage)).toEqual({
            'page-1': [ { probe: 'native-audio', steps: [ 'check mp4a.40.2' ] }, { probe: 'native-surround-audio', steps: [ 'check ec-3' ] } ]
        }));

        // A hidden page's browser may end it, and a page that unloads hides first
        setVisible(false);
        locks.stopPage('page-1');

        expect(await createPageStore({ locks, pageId: 'page-2', storage }).readQuarantine()).toEqual(EMPTY_QUARANTINE);
    });

    it('takes no crash from a stopped page of another fingerprint, and drops its record', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        await stopPageInCalls({ fingerprint: createFingerprint('build-1'), locks, pageId: 'page-1', storage }, [ { probe: 'native-audio', step: 'check mp4a.40.2' } ]);
        const laterBuildPage = createPageStore({ fingerprint: createFingerprint('build-2'), locks, pageId: 'page-2', storage });
        await laterBuildPage.write('native-audio', [ SUPPORTED_AAC ]);
        const listener = vi.fn();
        laterBuildPage.onCrash(listener);

        expect(await laterBuildPage.readQuarantine()).toEqual(EMPTY_QUARANTINE);
        expect(listener).not.toHaveBeenCalled();
        expect(await laterBuildPage.read('native-audio')).toEqual([ SUPPORTED_AAC ]);
        expect(readRunRecords(storage)).toEqual({});
    });

    it('keeps the quarantine through later verdicts, until a clear removes it all', async () => {
        const storage = createMemoryStorage();
        const locks = createFakeWebLocks();
        // A ceiling, then a blocked step, then suspects
        await stopPageInCalls({ locks, pageId: 'page-1', storage }, CONCURRENT_CALLS.slice(0, 2));
        const bisectingPage = createPageStore({ locks, pageId: 'page-2', storage });
        for (const step of (await bisectingPage.readQuarantine()).suspects.keys()) {
            bisectingPage.resolveSuspect(step);
        }
        await stopPageInCalls({ locks, pageId: 'page-3', storage }, [ { cost: AAC_DECODE_COST, probe: 'native-audio', step: 'decode aac' } ]);
        await stopPageInCalls({ locks, pageId: 'page-4', storage }, CONCURRENT_CALLS.slice(2));
        const laterPage = createPageStore({ locks, pageId: 'page-5', storage });
        const quarantine = await laterPage.readQuarantine();
        expect(quarantine.blocked.size).toBe(1);
        expect(quarantine.suspects.size).toBe(2);
        expect(quarantine.ceiling).not.toBeNull();

        await laterPage.write('native-sdr:hevc', SUPPORTED_HEVC);
        expect(await laterPage.readQuarantine()).toEqual(quarantine);

        laterPage.clear();
        expect(await laterPage.readQuarantine()).toEqual(EMPTY_QUARANTINE);
        expect(laterPage.readState()).toBeNull();
    });

    it('records no run without Web Locks, which tell a stopped page from one that runs', async () => {
        const storage = createMemoryStorage();
        const store = createStore(storage);

        expect(await store.readQuarantine()).toEqual(EMPTY_QUARANTINE);
        await store.markRunning('native-audio', 'check mp4a.40.2', CHECK_COST);

        expect(storage.entries.size).toBe(0);
    });
});

describe('readCapabilityProbeFingerprint', () => {
    class FakeAdapterInfo {
        get architecture(): string {
            return 'blackwell';
        }

        get vendor(): string {
            return 'nvidia';
        }
    }

    class FakeSupportedLimits {
        get maxBufferSize(): number {
            return 4_294_967_296;
        }

        get maxTextureDimension2D(): number {
            return 16_384;
        }
    }

    // WebIDL attributes are enumerable getters on the prototype, which class getters are not
    for (const prototype of [ FakeAdapterInfo.prototype, FakeSupportedLimits.prototype ]) {
        for (const key of Object.getOwnPropertyNames(prototype)) {
            if (key !== 'constructor') {
                Object.defineProperty(prototype, key, { ...Object.getOwnPropertyDescriptor(prototype, key), enumerable: true });
            }
        }
    }

    it('reads the adapter info, sorted features, limits, and the full browser and OS versions', async () => {
        const getHighEntropyValues = vi.fn(async () => ({
            brands: [ { brand: 'Chromium', version: '150' } ],
            fullVersionList: [ { brand: 'Chromium', version: '150.0.7000.12' } ],
            platform: 'Windows',
            platformVersion: '19.0.0'
        }));
        const fingerprint = await readCapabilityProbeFingerprint('build-1', {
            gpu: {
                requestAdapter: async () => ({
                    features: new Set([ 'timestamp-query', 'shader-f16', 'float32-filterable' ]),
                    info: new FakeAdapterInfo(),
                    limits: new FakeSupportedLimits()
                }) as unknown as GPUAdapter
            },
            userAgent: 'Mozilla/5.0 Chrome/150.0.0.0',
            userAgentData: { getHighEntropyValues }
        });

        expect(getHighEntropyValues).toHaveBeenCalledWith([ 'fullVersionList', 'platformVersion' ]);
        expect(fingerprint).toEqual({
            adapter: {
                features: [ 'float32-filterable', 'shader-f16', 'timestamp-query' ],
                info: { architecture: 'blackwell', vendor: 'nvidia' },
                limits: { maxBufferSize: 4_294_967_296, maxTextureDimension2D: 16_384 }
            },
            buildKey: 'build-1',
            userAgent: 'Mozilla/5.0 Chrome/150.0.0.0',
            userAgentData: {
                brands: [ { brand: 'Chromium', version: '150' } ],
                fullVersionList: [ { brand: 'Chromium', version: '150.0.7000.12' } ],
                platform: 'Windows',
                platformVersion: '19.0.0'
            }
        });
    });

    it('fingerprints a browser without WebGPU or client hints by its user agent alone', async () => {
        expect(await readCapabilityProbeFingerprint('build-1', { userAgent: 'Mozilla/5.0 Firefox/150.0' })).toEqual({
            adapter: null,
            buildKey: 'build-1',
            userAgent: 'Mozilla/5.0 Firefox/150.0',
            userAgentData: null
        });
    });

    it('reads no fingerprint when the adapter request fails', async () => {
        const fingerprint = await readCapabilityProbeFingerprint('build-1', {
            gpu: { requestAdapter: () => Promise.reject(new Error('GPU process lost')) },
            userAgent: 'Mozilla/5.0'
        });

        expect(fingerprint).toBeNull();
    });
});

describe('the page store', () => {
    afterEach(() => {
        clearStoredCapabilityProbeVerdicts();
        configureCapabilityProbeStore({ buildKey: '' });
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('keeps nothing until the host names its build', async () => {
        await getDefaultCapabilityProbeStore().write('native-sdr:hevc', SUPPORTED_HEVC);

        expect(globalThis.localStorage.getItem(CAPABILITY_PROBE_STORE_KEY)).toBeNull();
    });

    it('stores in localStorage under the host build, and clears it', async () => {
        configureCapabilityProbeStore({ buildKey: 'asset-key-webpack-hash' });
        await getDefaultCapabilityProbeStore().write('native-sdr:hevc', SUPPORTED_HEVC);

        expect(readStoredCapabilityProbeVerdictState()).toMatchObject({
            fingerprint: { buildKey: 'asset-key-webpack-hash' },
            probes: [ 'native-sdr:hevc' ]
        });

        clearStoredCapabilityProbeVerdicts();
        expect(globalThis.localStorage.getItem(CAPABILITY_PROBE_STORE_KEY)).toBeNull();
        expect(readStoredCapabilityProbeVerdictState()).toBeNull();
    });

    it('drops the page\'s record as the page unloads, even when a later visibility change still reads visible, until the page shows again', async () => {
        vi.useFakeTimers();
        const locks = createFakeWebLocks();
        vi.stubGlobal('navigator', { locks: locks.forPage('the-page'), userAgent: 'Mozilla/5.0' });
        configureCapabilityProbeStore({ buildKey: 'asset-key-webpack-hash' });
        const store = getDefaultCapabilityProbeStore();
        await store.readQuarantine();
        const endCall = await store.markRunning('native-audio', 'check mp4a.40.2', CHECK_COST);
        expect(globalThis.localStorage.getItem(CAPABILITY_PROBE_RUNS_KEY)).not.toBeNull();

        globalThis.dispatchEvent(new Event('pagehide'));
        document.dispatchEvent(new Event('visibilitychange'));
        // A write the visibility change started would land once the page took its lock again
        await vi.runAllTimersAsync();
        expect(globalThis.localStorage.getItem(CAPABILITY_PROBE_RUNS_KEY)).toBeNull();

        // A page the back-forward cache restores has its open calls again
        globalThis.dispatchEvent(new Event('pageshow'));
        await vi.runAllTimersAsync();
        expect(globalThis.localStorage.getItem(CAPABILITY_PROBE_RUNS_KEY)).not.toBeNull();
        endCall();
        expect(globalThis.localStorage.getItem(CAPABILITY_PROBE_RUNS_KEY)).toBeNull();
    });

    it('tells the page\'s crash listeners of the crashes its default store finds', async () => {
        vi.useFakeTimers();
        const locks = createFakeWebLocks();
        vi.stubGlobal('navigator', { locks: locks.forPage('the-page'), userAgent: 'Mozilla/5.0' });
        configureCapabilityProbeStore({ buildKey: 'asset-key-webpack-hash' });
        const stoppedPage = new CapabilityProbeStore({
            locks: () => locks.forPage('stopped-page'),
            pageId: 'stopped-page',
            readFingerprint: () => readCapabilityProbeFingerprint('asset-key-webpack-hash'),
            storage: () => globalThis.localStorage
        });
        await stoppedPage.readQuarantine();
        await stoppedPage.markRunning('native-audio', 'decode aac', CHECK_COST);
        locks.stopPage('stopped-page');
        const listener = vi.fn();
        const removeListener = onCapabilityProbeCrash(listener);

        expect((await getDefaultCapabilityProbeStore().readQuarantine()).blocked).toEqual(new Set([ 'decode aac' ]));
        removeListener();

        expect(listener).toHaveBeenCalledExactlyOnceWith([ { probe: 'native-audio', steps: [ 'decode aac' ] } ]);
        expect(readStoredCapabilityProbeVerdictState()?.crashedProbes).toEqual([ { probe: 'native-audio', steps: [ 'decode aac' ] } ]);
    });
});
