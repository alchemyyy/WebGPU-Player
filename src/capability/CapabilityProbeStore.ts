// The capability probe verdicts a page keeps across page loads and browser restarts, in one localStorage entry,
// and the probes each page has in a browser call, with the steps each has in flight, in another,
// so a page that stops in one, as a crash stops it, tells the next page which probe and which step that was.
// A verdict counts only for the host build, adapter, and browser that measured it, which the entry's fingerprint names.

/** The storage key of the single entry, which a schema or fingerprint change overwrites rather than adds beside. */
export const CAPABILITY_PROBE_STORE_KEY = 'webgpu-player-capability-probe-verdicts';
/** The storage key of the probes each page has in a browser call, with their steps, by page; a page that stops in one leaves its record behind. */
export const CAPABILITY_PROBE_RUNS_KEY = 'webgpu-player-capability-probe-runs';
/** The entries' layout version; an entry of another version is a miss. */
export const CAPABILITY_PROBE_STORE_SCHEMA_VERSION = 1;
// Bounds the adapter and client hint reads, so a stuck adapter request only disables the store for the page
const FINGERPRINT_READ_TIMEOUT_MILLISECONDS = 2_000;
// Bounds each wait on the lock manager, looking at the other pages' locks and taking the page's own, so a stuck lock manager only leaves runs unrecorded
const LOCK_WAIT_TIMEOUT_MILLISECONDS = 2_000;
// A page holds a lock of its own name while it has a record; the browser frees a page's locks when the page ends, however it ends
const PAGE_LOCK_NAME_PREFIX = 'webgpu-player-capability-probe-page:';
const PAGE_ID_BYTE_LENGTH = 16;
const HEXADECIMAL_RADIX = 16;
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

/** A probe that was in a browser call when a page of the fingerprint stopped, with the calls it had in flight. */
export type CrashedCapabilityProbe = Readonly<{
    probe: string
    /** Labels of the browser calls the probe had in flight, sorted and unique, such as `check mp4a.40.2` or `decode aac`; empty when the record named none */
    steps: readonly string[]
}>;

/** The stored entry as a host shows it: its fingerprint, when it was last written, which probes it holds, and which probes stopped a page. */
export type CapabilityProbeStoreState = Readonly<{
    ageMilliseconds: number
    /** The probes that were in a browser call when a page of the fingerprint stopped, sorted by probe, which no page of it runs again */
    crashedProbes: readonly CrashedCapabilityProbe[]
    fingerprint: CapabilityProbeFingerprint
    probes: readonly string[]
    writtenAtMilliseconds: number
}>;

/** The part of the Web Storage API the store uses. */
export type CapabilityProbeStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

/** The part of the Web Locks API the store uses. */
export type CapabilityProbeLocks = Pick<LockManager, 'request'>;

export type CapabilityProbeStoreOptions = Readonly<{
    /** The Web Locks that tell a page that still runs from one that stopped; without them the store records no run and reads no probe as crashed */
    locks?: () => CapabilityProbeLocks | null
    now?: () => number
    /** Names this page among the pages that share the storage; a random name by default */
    pageId?: string
    /** Resolves the current fingerprint, or null when it cannot be read, which disables the store */
    readFingerprint: () => Promise<CapabilityProbeFingerprint | null>
    storage: () => CapabilityProbeStorage | null
    /**
     * Calls the listener whenever the page shows or hides, and with a hide as it unloads, and returns whether it shows now.
     * A hidden page records no run, since a browser may end it at any time without a crash.
     */
    watchPage?: (listener: (visible: boolean) => void) => boolean
}>;

type StoredEntry = Readonly<{
    // The probes that were in a browser call when a page of this fingerprint stopped, with the steps they had in flight
    crashed?: readonly CrashedCapabilityProbe[]
    fingerprint: string
    schema: number
    verdicts: Readonly<Record<string, unknown>>
    writtenAt: number
}>;

// The probes one page has in a browser call, each with the steps it has in flight, under the fingerprint it runs them for
type StoredPageRuns = Readonly<{
    fingerprint: string
    probes: readonly CrashedCapabilityProbe[]
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

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((element: unknown): boolean => typeof element === 'string');
}

/** Joins the entries of each probe, with its steps sorted and unique, and sorts them by probe. */
function joinProbeSteps(entries: Iterable<CrashedCapabilityProbe>): CrashedCapabilityProbe[] {
    const stepsByProbe = new Map<string, Set<string>>();
    for (const { probe, steps } of entries) {
        const probeSteps = stepsByProbe.get(probe) ?? new Set<string>();
        for (const step of steps) {
            probeSteps.add(step);
        }
        stepsByProbe.set(probe, probeSteps);
    }
    return [ ...stepsByProbe ]
        .sort(([ left ]: [ string, Set<string> ], [ right ]: [ string, Set<string> ]): number => compareCodeUnits(left, right))
        .map(([ probe, steps ]: [ string, Set<string> ]): CrashedCapabilityProbe => ({ probe, steps: [ ...steps ].sort(compareCodeUnits) }));
}

/**
 * Reads a stored list of probes with their steps, joined by probe; null when any element is unreadable.
 * A probe name alone, as the previous release stored a crash or a page record, reads as a probe with no steps.
 */
function parseProbeSteps(value: unknown): CrashedCapabilityProbe[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const entries: CrashedCapabilityProbe[] = [];
    for (const element of value as readonly unknown[]) {
        if (typeof element === 'string') {
            entries.push({ probe: element, steps: [] });
        } else if (isRecord(element) && typeof element.probe === 'string' && isStringArray(element.steps)) {
            entries.push({ probe: element.probe, steps: element.steps });
        } else {
            return null;
        }
    }
    return joinProbeSteps(entries);
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
        const crashed = entry.crashed === undefined ? undefined : parseProbeSteps(entry.crashed);
        if (crashed === null) {
            return null;
        }
        return {
            ...(crashed ? { crashed } : {}),
            fingerprint: entry.fingerprint,
            schema: CAPABILITY_PROBE_STORE_SCHEMA_VERSION,
            verdicts: entry.verdicts,
            writtenAt: entry.writtenAt
        };
    } catch {
        return null;
    }
}

/** Reads the runs entry's records by page; an unreadable entry, or one of another schema, holds none. */
function parseRuns(text: string | null): Record<string, StoredPageRuns> {
    const pages: Record<string, StoredPageRuns> = {};
    if (text === null) {
        return pages;
    }
    try {
        const entry: unknown = JSON.parse(text);
        if (!isRecord(entry) || entry.schema !== CAPABILITY_PROBE_STORE_SCHEMA_VERSION || !isRecord(entry.pages)) {
            return pages;
        }
        for (const [ pageId, runs ] of Object.entries(entry.pages)) {
            const probes = isRecord(runs) ? parseProbeSteps(runs.probes) : null;
            if (isRecord(runs) && typeof runs.fingerprint === 'string' && probes !== null) {
                pages[pageId] = { fingerprint: runs.fingerprint, probes };
            }
        }
    } catch {
        // An unreadable entry records no page
    }
    return pages;
}

/** Returns a random name for a page, which no other page shares. */
function createPageId(): string {
    // eslint-disable-next-line compat/compat -- Only a page that records runs names itself, and every browser with the Web Locks that recording needs has Web Crypto
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(PAGE_ID_BYTE_LENGTH));
    return Array.from(bytes, (byte: number): string => byte.toString(HEXADECIMAL_RADIX).padStart(2, '0')).join('');
}

/** The page's own lock: held once `held` resolves true, and let go by `release`, which also lets go of a lock not yet held. */
type PageLock = Readonly<{
    held: Promise<boolean>
    release: () => void
}>;

/** Requests the page's own lock, which the page keeps until it releases it, or until the page ends, however it ends. */
function requestPageLock(locks: CapabilityProbeLocks, pageId: string): PageLock {
    let release: () => void = (): void => undefined;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    const held = new Promise<boolean>((resolve) => {
        // A request the lock manager refuses, or one that throws, holds nothing
        void Promise.resolve().then(() => locks.request(`${PAGE_LOCK_NAME_PREFIX}${pageId}`, (): Promise<void> => {
            resolve(true);
            // A lock is held until its callback's promise settles
            return released;
        })).catch((): void => {
            resolve(false);
        });
    });
    return { held, release };
}

/**
 * Calls the listener as the page shows or hides, and with a hide as it unloads or enters the back-forward cache; returns whether it shows now.
 * From that hide until the page shows again it reads as hidden, since a visibility change during an unload may still read visible.
 */
function watchPageVisibility(listener: (visible: boolean) => void): boolean {
    const page = globalThis.document as Document | undefined;
    if (!page) {
        return true;
    }
    let pageHidden = false;
    const isVisible = (): boolean => !pageHidden && page.visibilityState !== 'hidden';
    page.addEventListener('visibilitychange', (): void => listener(isVisible()));
    globalThis.addEventListener('pagehide', (): void => {
        pageHidden = true;
        listener(false);
    });
    globalThis.addEventListener('pageshow', (): void => {
        pageHidden = false;
        listener(isVisible());
    });
    return isVisible();
}

/**
 * Keeps each capability probe's verdict by its probe name for one fingerprint.
 * Only verdicts are kept: a result with any unknown or not-probed status is never written.
 * It also keeps the probes each page has in a browser call, with the steps each has in flight: a page that stops in one leaves its record,
 * and the next page of the fingerprint reads those probes as crashed, with those steps, so no page runs a probe again that stopped one.
 * A page holds a lock of its own only while it has a record, which tells a page that still runs from one that stopped, and keeps no lock while idle.
 */
export default class CapabilityProbeStore {
    private fingerprint: Promise<string | null> | null = null;
    private readonly clearListeners = new Set<() => void>();
    private readonly crashListeners = new Set<(crashes: readonly CrashedCapabilityProbe[]) => void>();
    // The fingerprint the page's run journal opened under, which its records name; null until it opens, or while it cannot
    private journalFingerprint: string | null = null;
    private readonly locks: () => CapabilityProbeLocks | null;
    private readonly now: () => number;
    // Taken before the page writes its record, and let go after it drops it
    private pageLock: PageLock | null = null;
    // The page's name among the pages that share the storage, made up once the page records runs
    private pageIdValue: string | null;
    private pageVisible = true;
    private pageWatched = false;
    private readonly readFingerprint: CapabilityProbeStoreOptions['readFingerprint'];
    // How many of the page's browser calls each probe has open, by the step each call is
    private readonly runCounts = new Map<string, Map<string, number>>();
    private runJournal: Promise<string | null> | null = null;
    private servedVerdict = false;
    private readonly storage: CapabilityProbeStoreOptions['storage'];
    private readonly watchPage: NonNullable<CapabilityProbeStoreOptions['watchPage']>;

    public constructor(options: CapabilityProbeStoreOptions) {
        this.locks = options.locks ?? ((): null => null);
        this.now = options.now ?? Date.now;
        this.pageIdValue = options.pageId ?? null;
        this.readFingerprint = options.readFingerprint;
        this.storage = options.storage;
        this.watchPage = options.watchPage ?? ((): boolean => true);
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
        if (fingerprint === null) {
            return;
        }
        const entry = this.readEntry();
        const current = entry?.fingerprint === fingerprint ? entry : null;
        this.writeEntry({
            ...(current?.crashed ? { crashed: current.crashed } : {}),
            fingerprint,
            schema: CAPABILITY_PROBE_STORE_SCHEMA_VERSION,
            verdicts: { ...current?.verdicts, [probe]: result },
            writtenAt: this.now()
        });
    }

    /**
     * Resolves the probes that were in a browser call when a page of the current fingerprint stopped, which no page of it runs again.
     * Its first call on a page opens the page's run journal: it records as crashed the probes of every other page whose record has no lock held,
     * as the record of a page that ended has none, and drops those records. Without a fingerprint, storage, or Web Locks it resolves none.
     */
    public async readCrashedProbes(): Promise<ReadonlySet<string>> {
        const fingerprint = await this.openRunJournal();
        if (fingerprint === null) {
            return new Set();
        }
        const entry = this.readEntry();
        return new Set(entry?.fingerprint === fingerprint ? entry.crashed?.map(({ probe }: CrashedCapabilityProbe): string => probe) : []);
    }

    /**
     * Records that the page has a browser call of a probe open, the step the label names, so a page that stops before the call ends
     * leaves the probe and its open steps for the next page to read. A probe may have several calls open, of one step or of several.
     * Resolves once the record is written, under the page's lock, with the function that ends the call, which counts only once.
     * Records nothing before readCrashedProbes has resolved on the page, nor while the page hides.
     */
    public async markRunning(probe: string, step: string): Promise<() => void> {
        const stepCounts = this.runCounts.get(probe) ?? new Map<string, number>();
        stepCounts.set(step, (stepCounts.get(step) ?? 0) + 1);
        this.runCounts.set(probe, stepCounts);
        await this.updatePageRecord();
        let ended = false;
        return (): void => {
            if (ended) {
                return;
            }
            ended = true;
            const remaining = (stepCounts.get(step) ?? 1) - 1;
            if (remaining > 0) {
                stepCounts.set(step, remaining);
                return;
            }
            stepCounts.delete(step);
            if (stepCounts.size === 0) {
                this.runCounts.delete(probe);
            }
            void this.updatePageRecord();
        };
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

    /**
     * Calls the listener on the page that finds crashed probes, once per finding, after the entry records them,
     * with only the crashes of the current fingerprint it just recorded; returns the function that removes the listener.
     */
    public onCrash(listener: (crashes: readonly CrashedCapabilityProbe[]) => void): () => void {
        this.crashListeners.add(listener);
        return (): void => {
            this.crashListeners.delete(listener);
        };
    }

    /** Returns the stored entry's fingerprint, write time, age, probes, and crashed probes, whatever fingerprint is current, or null without an entry. */
    public readState(): CapabilityProbeStoreState | null {
        const entry = this.readEntry();
        if (!entry) {
            return null;
        }
        try {
            return {
                ageMilliseconds: Math.max(0, this.now() - entry.writtenAt),
                crashedProbes: joinProbeSteps(entry.crashed ?? []),
                fingerprint: JSON.parse(entry.fingerprint) as CapabilityProbeFingerprint,
                probes: Object.keys(entry.verdicts).sort(compareCodeUnits),
                writtenAtMilliseconds: entry.writtenAt
            };
        } catch {
            return null;
        }
    }

    /** Forgets the page's fingerprint, so the next read measures it again and the run journal opens again under it. */
    public resetFingerprint(): void {
        this.fingerprint = null;
        this.journalFingerprint = null;
        this.runJournal = null;
        this.dropPageRecord();
    }

    private getFingerprint(): Promise<string | null> {
        this.fingerprint ??= this.readFingerprint().then(
            (fingerprint: CapabilityProbeFingerprint | null): string | null => (fingerprint ? toCanonicalJSON(fingerprint) : null),
            (): null => null
        );
        return this.fingerprint;
    }

    private getLocks(): CapabilityProbeLocks | null {
        try {
            return this.locks();
        } catch {
            return null;
        }
    }

    private getStorage(): CapabilityProbeStorage | null {
        try {
            return this.storage();
        } catch {
            return null;
        }
    }

    private get pageId(): string {
        this.pageIdValue ??= createPageId();
        return this.pageIdValue;
    }

    private openRunJournal(): Promise<string | null> {
        this.runJournal ??= this.startRunJournal();
        return this.runJournal;
    }

    /** Opens the page's run journal under the current fingerprint; resolves that fingerprint, or null when the page cannot record its runs. */
    private async startRunJournal(): Promise<string | null> {
        const fingerprint = await this.getFingerprint();
        const locks = this.getLocks();
        if (fingerprint === null || !locks || !this.getStorage()) {
            return null;
        }
        const opened = await withTimeout(this.recordStoppedPages(locks, fingerprint), LOCK_WAIT_TIMEOUT_MILLISECONDS).catch((): null => null);
        if (opened !== true) {
            return null;
        }
        this.journalFingerprint = fingerprint;
        if (!this.pageWatched) {
            this.pageWatched = true;
            this.pageVisible = this.watchPage((visible: boolean): void => {
                this.pageVisible = visible;
                void this.updatePageRecord();
            });
        }
        void this.updatePageRecord();
        return fingerprint;
    }

    /**
     * Takes the record of every other page whose lock is free, and records as crashed the probes such a page had in a browser call for this fingerprint,
     * with the steps it had in flight, then tells the crash listeners; resolves true once done.
     * A running page holds its lock while it has a record, so a record whose lock is free is a stopped page's,
     * and the record is taken while this page holds that lock, when no page of that id can write one.
     */
    private async recordStoppedPages(locks: CapabilityProbeLocks, fingerprint: string): Promise<boolean> {
        const stoppedRuns: CrashedCapabilityProbe[] = [];
        const otherPageIds = Object.keys(this.readRuns()).filter((pageId: string): boolean => pageId !== this.pageIdValue);
        await Promise.all(otherPageIds.map((pageId: string): Promise<void> => (
            locks.request(`${PAGE_LOCK_NAME_PREFIX}${pageId}`, { ifAvailable: true }, (lock: Lock | null): void => {
                if (lock === null) {
                    return;
                }
                const pages = this.readRuns();
                const runs = pages[pageId];
                if (!runs) {
                    return;
                }
                delete pages[pageId];
                this.writeRuns(pages);
                if (runs.fingerprint === fingerprint) {
                    stoppedRuns.push(...runs.probes);
                }
            })
        )));
        if (stoppedRuns.length > 0) {
            const crashes = joinProbeSteps(stoppedRuns);
            this.recordCrashedProbes(fingerprint, crashes);
            this.notifyCrash(crashes);
        }
        return true;
    }

    /** Records probes as crashed for a fingerprint, joining their steps with those already stored, and drops their verdicts, which no longer count. */
    private recordCrashedProbes(fingerprint: string, crashes: readonly CrashedCapabilityProbe[]): void {
        const entry = this.readEntry();
        const current = entry?.fingerprint === fingerprint ? entry : null;
        const crashedProbes = new Set(crashes.map(({ probe }: CrashedCapabilityProbe): string => probe));
        this.writeEntry({
            crashed: joinProbeSteps([ ...(current?.crashed ?? []), ...crashes ]),
            fingerprint,
            schema: CAPABILITY_PROBE_STORE_SCHEMA_VERSION,
            verdicts: Object.fromEntries(Object.entries(current?.verdicts ?? {}).filter(([ probe ]: [ string, unknown ]): boolean => !crashedProbes.has(probe))),
            writtenAt: this.now()
        });
    }

    /** Calls every crash listener with the crashes the page just recorded; a listener that throws stops neither the others nor the recording. */
    private notifyCrash(crashes: readonly CrashedCapabilityProbe[]): void {
        for (const listener of this.crashListeners) {
            try {
                listener(crashes);
            } catch {
                // The crashes stay recorded, and the other listeners still hear of them
            }
        }
    }

    /**
     * Brings the page's record in line with its open calls and visibility: drops it at once when the page should keep none,
     * else writes it once the page holds its lock, which comes first, so no page reads the record of a running page without its lock.
     */
    private async updatePageRecord(): Promise<void> {
        const locks = this.getLocks();
        if (!this.shouldKeepPageRecord() || !locks) {
            this.dropPageRecord();
            return;
        }
        this.pageLock ??= requestPageLock(locks, this.pageId);
        const lock = this.pageLock;
        const held = await withTimeout(lock.held, LOCK_WAIT_TIMEOUT_MILLISECONDS) === true;
        if (lock !== this.pageLock) {
            // The page dropped its record, and let go of this lock, while it waited
            return;
        }
        const fingerprint = this.journalFingerprint;
        if (!held || fingerprint === null || !this.shouldKeepPageRecord()) {
            this.dropPageRecord();
            return;
        }
        const pages = this.readRuns();
        pages[this.pageId] = {
            fingerprint,
            probes: joinProbeSteps(Array.from(this.runCounts, ([ probe, stepCounts ]: [ string, ReadonlyMap<string, number> ]): CrashedCapabilityProbe => ({
                probe,
                steps: [ ...stepCounts.keys() ]
            })))
        };
        this.writeRuns(pages);
    }

    private shouldKeepPageRecord(): boolean {
        return this.journalFingerprint !== null && this.pageVisible && this.runCounts.size > 0;
    }

    /** Drops the page's record, then lets go of its lock, in that order, so no page reads the record of a running page without its lock. */
    private dropPageRecord(): void {
        if (this.pageIdValue !== null) {
            const pages = this.readRuns();
            if (Object.hasOwn(pages, this.pageIdValue)) {
                delete pages[this.pageIdValue];
                this.writeRuns(pages);
            }
        }
        this.pageLock?.release();
        this.pageLock = null;
    }

    private readEntry(): StoredEntry | null {
        try {
            return parseEntry(this.getStorage()?.getItem(CAPABILITY_PROBE_STORE_KEY) ?? null);
        } catch {
            return null;
        }
    }

    private writeEntry(entry: StoredEntry): void {
        try {
            this.getStorage()?.setItem(CAPABILITY_PROBE_STORE_KEY, JSON.stringify(entry));
        } catch {
            // A full or denied storage leaves the page probing as before
        }
    }

    private readRuns(): Record<string, StoredPageRuns> {
        try {
            return parseRuns(this.getStorage()?.getItem(CAPABILITY_PROBE_RUNS_KEY) ?? null);
        } catch {
            return {};
        }
    }

    /** Writes every page's record, and removes the entry once no page has one. */
    private writeRuns(pages: Readonly<Record<string, StoredPageRuns>>): void {
        try {
            const storage = this.getStorage();
            if (Object.keys(pages).length === 0) {
                storage?.removeItem(CAPABILITY_PROBE_RUNS_KEY);
            } else {
                storage?.setItem(CAPABILITY_PROBE_RUNS_KEY, JSON.stringify({ pages, schema: CAPABILITY_PROBE_STORE_SCHEMA_VERSION }));
            }
        } catch {
            // A full or denied storage leaves the page's runs unrecorded
        }
    }
}

let configuredBuildKey: string | null = null;

function readPageStorage(): CapabilityProbeStorage | null {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

/** Returns the page's Web Locks, which an insecure context and an older browser lack. */
function readPageLocks(): CapabilityProbeLocks | null {
    return (globalThis.navigator as Partial<Pick<Navigator, 'locks'>> | undefined)?.locks ?? null;
}

const defaultStore = new CapabilityProbeStore({
    locks: readPageLocks,
    readFingerprint: (): Promise<CapabilityProbeFingerprint | null> => (
        configuredBuildKey === null ? Promise.resolve(null) : readCapabilityProbeFingerprint(configuredBuildKey)
    ),
    // Until a host names its build, verdicts are neither read nor written, and no run is recorded
    storage: (): CapabilityProbeStorage | null => (configuredBuildKey === null ? null : readPageStorage()),
    watchPage: watchPageVisibility
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

/** Clears the stored verdicts and crashed probes, so the next negotiation probes again. */
export function clearStoredCapabilityProbeVerdicts(): void {
    defaultStore.clear();
}

/** Returns the stored verdicts' fingerprint and age, with the probes that stopped a page and their steps, or null when none are stored. */
export function readStoredCapabilityProbeVerdictState(): CapabilityProbeStoreState | null {
    return defaultStore.readState();
}

/** Calls the listener on the page that finds crashed probes, once per finding, with only the crashes it just recorded; returns the function that removes the listener. */
export function onCapabilityProbeCrash(listener: (crashes: readonly CrashedCapabilityProbe[]) => void): () => void {
    return defaultStore.onCrash(listener);
}
