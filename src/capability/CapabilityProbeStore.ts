// The capability probe verdicts a page keeps across page loads and browser restarts, in one localStorage entry.
// A verdict counts only for the host build, adapter, and browser that measured it, which the entry's fingerprint names.

/** The storage key of the single entry, which a schema or fingerprint change overwrites rather than adds beside. */
export const CAPABILITY_PROBE_STORE_KEY = 'webgpu-player-capability-probe-verdicts';
/** The entry's layout version; an entry of another version is a miss. */
export const CAPABILITY_PROBE_STORE_SCHEMA_VERSION = 1;
// Bounds the adapter and client hint reads, so a stuck adapter request only disables the store for the page
const FINGERPRINT_READ_TIMEOUT_MILLISECONDS = 2_000;
const HIGH_ENTROPY_HINTS = [ 'fullVersionList', 'platformVersion' ] as const;

type FingerprintValue = boolean | number | string | null | readonly FingerprintValue[] | { readonly [key: string]: FingerprintValue };

/** What a verdict was measured on: the host build, the WebGPU adapter, and the browser with its full version and OS version. */
export type CapabilityProbeFingerprint = Readonly<{
    adapter: Readonly<{
        features: readonly string[]
        info: Readonly<Record<string, FingerprintValue>>
        limits: Readonly<Record<string, number>>
    }> | null
    buildKey: string
    userAgent: string
    userAgentData: Readonly<Record<string, FingerprintValue>> | null
}>;

/** The stored entry as a host shows it: its fingerprint, when it was last written, and which probes it holds. */
export type CapabilityProbeStoreState = Readonly<{
    ageMilliseconds: number
    fingerprint: CapabilityProbeFingerprint
    probes: readonly string[]
    writtenAtMilliseconds: number
}>;

/** The part of the Web Storage API the store uses. */
export type CapabilityProbeStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

export type CapabilityProbeStoreOptions = Readonly<{
    now?: () => number
    /** Resolves the current fingerprint, or null when it cannot be read, which disables the store */
    readFingerprint: () => Promise<CapabilityProbeFingerprint | null>
    storage: () => CapabilityProbeStorage | null
}>;

type StoredEntry = Readonly<{
    fingerprint: string
    schema: number
    verdicts: Readonly<Record<string, unknown>>
    writtenAt: number
}>;

type NavigatorUAData = Readonly<{
    getHighEntropyValues: (hints: readonly string[]) => Promise<Record<string, unknown>>
}>;

type FingerprintNavigator = Readonly<{
    gpu?: Pick<GPU, 'requestAdapter'>
    userAgent?: string
    userAgentData?: NavigatorUAData
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Orders strings by code unit, as the canonical form needs, independent of any locale. */
function compareCodeUnits(left: string, right: string): number {
    if (left === right) {
        return 0;
    }
    return left < right ? -1 : 1;
}

/** Serializes a value with every object's keys sorted, so equal fingerprints compare equal as strings. */
function toCanonicalJSON(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(toCanonicalJSON).join(',')}]`;
    }
    if (isRecord(value)) {
        const entries = Object.keys(value).sort(compareCodeUnits).map((key: string): string => (
            `${JSON.stringify(key)}:${toCanonicalJSON(value[key])}`
        ));
        return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

type ProbeResultStatus = Readonly<{ reason: unknown, status: unknown }>;

/** Collects the status and reason of every object in a probe result that carries a status. */
function collectStatuses(value: unknown, statuses: ProbeResultStatus[] = []): ProbeResultStatus[] {
    if (Array.isArray(value)) {
        for (const element of value) {
            collectStatuses(element, statuses);
        }
    } else if (isRecord(value)) {
        if ('status' in value) {
            statuses.push({ reason: value.reason, status: value.status });
        }
        for (const child of Object.values(value)) {
            collectStatuses(child, statuses);
        }
    }
    return statuses;
}

/**
 * Returns whether every status in a probe result is a verdict, supported or unsupported, never unknown or not probed.
 * A result without any status is no verdict either.
 */
export function isDefinitiveCapabilityProbeResult(result: unknown): boolean {
    const statuses = collectStatuses(result);
    return statuses.length > 0 && statuses.every(({ status }: ProbeResultStatus): boolean => (
        status === 'supported' || status === 'unsupported'
    ));
}

/** Returns whether any part of a probe result ran out of time. */
export function hasCapabilityProbeTimeout(result: unknown): boolean {
    return collectStatuses(result).some(({ reason }: ProbeResultStatus): boolean => reason === 'probe-timeout');
}

function deepFreeze(value: unknown): unknown {
    if (Array.isArray(value) || isRecord(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

/** Copies the own and inherited enumerable primitive attributes of a WebIDL object, such as GPUAdapterInfo or GPUSupportedLimits. */
function readAttributes<Value extends boolean | number | string>(
    source: object,
    accepts: (value: unknown) => value is Value
): Record<string, Value> {
    const attributes: Record<string, Value> = {};
    // WebIDL attributes are enumerable getters on the prototype, which only for-in reaches
    for (const key in source) {
        const value: unknown = (source as Record<string, unknown>)[key];
        if (accepts(value)) {
            attributes[key] = value;
        }
    }
    return attributes;
}

function isPrimitiveAttribute(value: unknown): value is boolean | number | string {
    return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}

function isNumberAttribute(value: unknown): value is number {
    return typeof value === 'number';
}

async function readAdapterFingerprint(gpu: Pick<GPU, 'requestAdapter'> | undefined): Promise<CapabilityProbeFingerprint['adapter']> {
    // The presenter requests its adapter with the same default options
    const adapter = await gpu?.requestAdapter();
    if (!adapter) {
        return null;
    }
    return {
        features: [ ...adapter.features ].sort(compareCodeUnits),
        info: adapter.info ? readAttributes(adapter.info, isPrimitiveAttribute) : {},
        limits: readAttributes(adapter.limits, isNumberAttribute)
    };
}

async function readUserAgentData(userAgentData: NavigatorUAData | undefined): Promise<Record<string, FingerprintValue> | null> {
    if (!userAgentData || typeof userAgentData.getHighEntropyValues !== 'function') {
        return null;
    }
    const values = await userAgentData.getHighEntropyValues(HIGH_ENTROPY_HINTS);
    // A round trip through JSON keeps only the plain data the hints return
    return JSON.parse(JSON.stringify(values)) as Record<string, FingerprintValue>;
}

function withTimeout<Value>(promise: Promise<Value>, milliseconds: number): Promise<Value | null> {
    return new Promise<Value | null>((resolve, reject) => {
        const timeout = globalThis.setTimeout(() => resolve(null), milliseconds);
        promise.then((value: Value): void => {
            globalThis.clearTimeout(timeout);
            resolve(value);
        }, (error: unknown): void => {
            globalThis.clearTimeout(timeout);
            reject(error);
        });
    });
}

/**
 * Reads the fingerprint of this browser for a host build: the adapter's info, sorted features, and limits, the user agent, and Chromium's full version list and platform version.
 * Resolves null when the adapter or the client hints cannot be read in time.
 */
export async function readCapabilityProbeFingerprint(
    buildKey: string,
    browser: FingerprintNavigator | undefined = globalThis.navigator as FingerprintNavigator | undefined
): Promise<CapabilityProbeFingerprint | null> {
    try {
        const parts = await withTimeout(Promise.all([
            readAdapterFingerprint(browser?.gpu),
            readUserAgentData(browser?.userAgentData)
        ]), FINGERPRINT_READ_TIMEOUT_MILLISECONDS);
        if (!parts) {
            return null;
        }
        const [ adapter, userAgentData ] = parts;
        return { adapter, buildKey, userAgent: browser?.userAgent ?? '', userAgentData };
    } catch {
        return null;
    }
}

function parseEntry(text: string | null): StoredEntry | null {
    if (text === null) {
        return null;
    }
    try {
        const entry: unknown = JSON.parse(text);
        if (!isRecord(entry)
            || entry.schema !== CAPABILITY_PROBE_STORE_SCHEMA_VERSION
            || typeof entry.fingerprint !== 'string'
            || typeof entry.writtenAt !== 'number'
            || !isRecord(entry.verdicts)) {
            return null;
        }
        return entry as StoredEntry;
    } catch {
        return null;
    }
}

/**
 * Keeps each capability probe's verdict by its probe name for one fingerprint.
 * Only verdicts are kept: a result with any unknown or not-probed status is never written.
 */
export default class CapabilityProbeStore {
    private fingerprint: Promise<string | null> | null = null;
    private readonly clearListeners = new Set<() => void>();
    private readonly now: () => number;
    private readonly readFingerprint: CapabilityProbeStoreOptions['readFingerprint'];
    private servedVerdict = false;
    private readonly storage: CapabilityProbeStoreOptions['storage'];

    public constructor(options: CapabilityProbeStoreOptions) {
        this.now = options.now ?? Date.now;
        this.readFingerprint = options.readFingerprint;
        this.storage = options.storage;
    }

    /** Returns a probe's stored verdict when the entry matches this schema and fingerprint, else null. */
    public async read(probe: string): Promise<unknown> {
        const fingerprint = await this.getFingerprint();
        if (fingerprint === null) {
            return null;
        }
        const entry = this.readEntry();
        if (entry?.fingerprint !== fingerprint || !Object.hasOwn(entry.verdicts, probe)) {
            return null;
        }
        const verdict = entry.verdicts[probe];
        return isDefinitiveCapabilityProbeResult(verdict) ? deepFreeze(verdict) : null;
    }

    /**
     * Merges a probe's verdict into the entry, replacing an entry of another schema or fingerprint.
     * A result that is not a verdict throughout is ignored.
     */
    public async write(probe: string, result: unknown): Promise<void> {
        if (!isDefinitiveCapabilityProbeResult(result)) {
            return;
        }
        const fingerprint = await this.getFingerprint();
        const storage = this.getStorage();
        if (fingerprint === null || !storage) {
            return;
        }
        const entry = this.readEntry();
        const verdicts = entry?.fingerprint === fingerprint ? { ...entry.verdicts } : {};
        verdicts[probe] = result;
        const nextEntry: StoredEntry = {
            fingerprint,
            schema: CAPABILITY_PROBE_STORE_SCHEMA_VERSION,
            verdicts,
            writtenAt: this.now()
        };
        try {
            storage.setItem(CAPABILITY_PROBE_STORE_KEY, JSON.stringify(nextEntry));
        } catch {
            // A full or denied storage leaves the page probing as before
        }
    }

    /** Records that a negotiation used a stored verdict, so a failed start can clear them. */
    public recordServedVerdict(): void {
        this.servedVerdict = true;
    }

    /** Removes the entry and tells every listener, so stored verdicts held in memory are dropped too. */
    public clear(): void {
        this.servedVerdict = false;
        try {
            this.getStorage()?.removeItem(CAPABILITY_PROBE_STORE_KEY);
        } catch {
            // Nothing stored can be read either
        }
        for (const listener of this.clearListeners) {
            listener();
        }
    }

    /**
     * Clears the entry after a route failed to configure or to output its first frame, if the page used a stored verdict.
     * A changed driver, OS codec pack, hardware acceleration setting, or Chrome's software fallback changes no fingerprint.
     * Returns whether it cleared.
     */
    public clearAfterStartFailure(): boolean {
        if (!this.servedVerdict) {
            return false;
        }
        this.clear();
        return true;
    }

    public onClear(listener: () => void): () => void {
        this.clearListeners.add(listener);
        return (): void => {
            this.clearListeners.delete(listener);
        };
    }

    /** Returns the stored entry's fingerprint, write time, age, and probes, whatever fingerprint is current, or null without an entry. */
    public readState(): CapabilityProbeStoreState | null {
        const entry = this.readEntry();
        if (!entry) {
            return null;
        }
        try {
            return {
                ageMilliseconds: Math.max(0, this.now() - entry.writtenAt),
                fingerprint: JSON.parse(entry.fingerprint) as CapabilityProbeFingerprint,
                probes: Object.keys(entry.verdicts).sort(compareCodeUnits),
                writtenAtMilliseconds: entry.writtenAt
            };
        } catch {
            return null;
        }
    }

    /** Forgets the page's fingerprint, so the next read measures it again. */
    public resetFingerprint(): void {
        this.fingerprint = null;
    }

    private getFingerprint(): Promise<string | null> {
        this.fingerprint ??= this.readFingerprint().then(
            (fingerprint: CapabilityProbeFingerprint | null): string | null => (fingerprint ? toCanonicalJSON(fingerprint) : null),
            (): null => null
        );
        return this.fingerprint;
    }

    private getStorage(): CapabilityProbeStorage | null {
        try {
            return this.storage();
        } catch {
            return null;
        }
    }

    private readEntry(): StoredEntry | null {
        try {
            return parseEntry(this.getStorage()?.getItem(CAPABILITY_PROBE_STORE_KEY) ?? null);
        } catch {
            return null;
        }
    }
}

let configuredBuildKey: string | null = null;

function readPageStorage(): CapabilityProbeStorage | null {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

const defaultStore = new CapabilityProbeStore({
    readFingerprint: (): Promise<CapabilityProbeFingerprint | null> => (
        configuredBuildKey === null ? Promise.resolve(null) : readCapabilityProbeFingerprint(configuredBuildKey)
    ),
    // Until a host names its build, verdicts are neither read nor written
    storage: (): CapabilityProbeStorage | null => (configuredBuildKey === null ? null : readPageStorage())
});

export type CapabilityProbeStoreConfiguration = Readonly<{
    /**
     * Changes with every host build: the engine asset key plus what else the host compiles into its probe code.
     * Without one the page keeps no verdicts.
     */
    buildKey: string
}>;

/** Names the host build whose verdicts the page keeps. Call it before the first probe, as with configureEngineAssets. */
export function configureCapabilityProbeStore(configuration: CapabilityProbeStoreConfiguration): void {
    configuredBuildKey = configuration.buildKey.length > 0 ? configuration.buildKey : null;
    defaultStore.resetFingerprint();
}

/** The store the page's default capability probe reads and writes. */
export function getDefaultCapabilityProbeStore(): CapabilityProbeStore {
    return defaultStore;
}

/** Clears the stored verdicts, so the next negotiation probes again. */
export function clearStoredCapabilityProbeVerdicts(): void {
    defaultStore.clear();
}

/** Returns the stored verdicts' fingerprint and age, or null when none are stored. */
export function readStoredCapabilityProbeVerdictState(): CapabilityProbeStoreState | null {
    return defaultStore.readState();
}
