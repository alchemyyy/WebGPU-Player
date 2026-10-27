import { afterEach, describe, expect, it, vi } from 'vitest';

import CapabilityProbeStore, {
    CAPABILITY_PROBE_STORE_KEY,
    CAPABILITY_PROBE_STORE_SCHEMA_VERSION,
    clearStoredCapabilityProbeVerdicts,
    configureCapabilityProbeStore,
    getDefaultCapabilityProbeStore,
    readCapabilityProbeFingerprint,
    readStoredCapabilityProbeVerdictState,
    type CapabilityProbeFingerprint,
    type CapabilityProbeStorage
} from 'webgpu-player/capability/CapabilityProbeStore';

const SUPPORTED_AAC = Object.freeze({ codec: 'aac', codecString: 'mp4a.40.2', reason: 'decode-output-verified', status: 'supported' });
const UNSUPPORTED_OPUS = Object.freeze({ codec: 'opus', codecString: 'opus', reason: 'config-unsupported', status: 'unsupported' });
const TIMED_OUT_FLAC = Object.freeze({ codec: 'flac', codecString: 'flac', reason: 'probe-timeout', status: 'unknown' });
const SUPPORTED_HEVC = Object.freeze({ codec: 'hevc', codecString: 'hvc1.1.6.L120.90', reason: 'decode-output-verified', status: 'supported' });
const WRITE_TIME_MILLISECONDS = 1_000_000;

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
            fingerprint: createFingerprint('build-1'),
            probes: [ 'native-sdr:hevc' ],
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
});
