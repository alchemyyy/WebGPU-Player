// An in-memory IndexedDB of the parts the engine's stores use: versioned opens with upgrades, object stores keyed by a key path,
// and readonly or readwrite transactions whose requests run in order, later ones queued from earlier ones' success callbacks included.
// A transaction's writes apply when it completes, so a failed request aborts it without a trace.

type StoredRecords = Map<IDBValidKey, unknown>;

type FakeDatabaseState = {
    stores: Map<string, { keyPath: string; records: StoredRecords }>
    version: number
};

/** A request's outcome, as the engine reads it: its result or error, and the callbacks it fires. */
class FakeRequest {
    error: DOMException | null = null;
    onerror: (() => void) | null = null;
    onsuccess: (() => void) | null = null;
    result: unknown = undefined;
}

const VERSION_ERROR_NAME = 'VersionError';
const DATA_ERROR_NAME = 'DataError';
const NOT_FOUND_ERROR_NAME = 'NotFoundError';

function compareKeys(first: IDBValidKey, second: IDBValidKey): number {
    return String(first).localeCompare(String(second));
}

/** Copies a stored record's fields, as IndexedDB stores a copy; the stores' records hold no nested objects but their bytes, which no test changes. */
function copyRecord(record: unknown): unknown {
    return { ...(record as Record<string, unknown>) };
}

/** One transaction over one object store: its requests run in order on a copy of the records, which replaces the store's when every request succeeded. */
class FakeTransaction {
    error: DOMException | null = null;
    oncomplete: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private readonly operations: (() => boolean)[] = [];
    private readonly records: StoredRecords;
    private scheduled = false;
    private readonly storeName: string;
    private readonly storeState: { keyPath: string; records: StoredRecords };

    constructor(storeName: string, storeState: { keyPath: string; records: StoredRecords }) {
        this.storeName = storeName;
        this.storeState = storeState;
        this.records = new Map(storeState.records);
    }

    objectStore(name: string): IDBObjectStore {
        if (name !== this.storeName) {
            throw new DOMException(name, NOT_FOUND_ERROR_NAME);
        }
        const store = {
            delete: (key: IDBValidKey): FakeRequest => this.enqueue((): unknown => {
                this.records.delete(key);
                return undefined;
            }),
            get: (key: IDBValidKey): FakeRequest => this.enqueue((): unknown => this.records.get(key)),
            getAll: (): FakeRequest => this.enqueue((): unknown => [ ...this.records.entries() ]
                .sort(([ firstKey ], [ secondKey ]) => compareKeys(firstKey, secondKey))
                .map(([ , value ]) => value)),
            put: (value: unknown): FakeRequest => this.enqueue((): unknown => {
                const key = (value as Record<string, unknown>)[this.storeState.keyPath];
                if (typeof key !== 'string' && typeof key !== 'number') {
                    throw new DOMException(`no ${this.storeState.keyPath} key`, DATA_ERROR_NAME);
                }
                this.records.set(key, copyRecord(value));
                return key;
            })
        };
        return store as unknown as IDBObjectStore;
    }

    /** Queues a request, which runs after every request queued before it; returns whether it succeeded when it runs. */
    private enqueue(operation: () => unknown): FakeRequest {
        const request = new FakeRequest();
        this.operations.push((): boolean => {
            try {
                request.result = operation();
            } catch (error) {
                request.error = error instanceof DOMException ? error : new DOMException(String(error));
                request.onerror?.();
                this.abort(request.error);
                return false;
            }
            request.onsuccess?.();
            return true;
        });
        if (!this.scheduled) {
            this.scheduled = true;
            setTimeout((): void => {
                this.run();
            }, 0);
        }
        return request;
    }

    private run(): void {
        for (let operation = this.operations.shift(); operation !== undefined; operation = this.operations.shift()) {
            if (!operation()) {
                return;
            }
        }
        this.storeState.records.clear();
        for (const [ key, value ] of this.records) {
            this.storeState.records.set(key, value);
        }
        this.oncomplete?.();
    }

    private abort(error: DOMException): void {
        this.error = error;
        this.operations.length = 0;
        this.onabort?.();
    }
}

/** A database connection over its shared state. */
class FakeDatabase {
    onversionchange: (() => void) | null = null;
    private readonly state: FakeDatabaseState;

    constructor(state: FakeDatabaseState) {
        this.state = state;
    }

    get objectStoreNames(): { contains: (name: string) => boolean } {
        return { contains: (name: string): boolean => this.state.stores.has(name) };
    }

    get version(): number {
        return this.state.version;
    }

    close(): void {
        // A closed connection keeps the state, which later opens reach
    }

    createObjectStore(name: string, options: { keyPath: string }): void {
        this.state.stores.set(name, { keyPath: options.keyPath, records: new Map<IDBValidKey, unknown>() });
    }

    deleteObjectStore(name: string): void {
        this.state.stores.delete(name);
    }

    transaction(name: string): FakeTransaction {
        const storeState = this.state.stores.get(name);
        if (!storeState) {
            throw new DOMException(name, NOT_FOUND_ERROR_NAME);
        }
        return new FakeTransaction(name, storeState);
    }
}

/** The fake factory: databases by name, which tests may seed or read directly. */
export class FakeIndexedDB {
    private readonly databases = new Map<string, FakeDatabaseState>();

    /** Seeds a database at a version with one object store and its records, as an earlier engine would have left it. */
    seed(name: string, version: number, storeName: string, keyPath: string, records: readonly unknown[]): void {
        const storedRecords = new Map<IDBValidKey, unknown>();
        for (const record of records) {
            storedRecords.set((record as Record<string, IDBValidKey>)[keyPath], copyRecord(record));
        }
        this.databases.set(name, { stores: new Map([ [ storeName, { keyPath, records: storedRecords } ] ]), version });
    }

    /** Writes a record straight into an existing database's object store, as a file an earlier engine stored would sit there. */
    writeRecord(name: string, storeName: string, record: unknown): void {
        const storeState = this.databases.get(name)?.stores.get(storeName);
        if (!storeState) {
            throw new Error(`no object store ${storeName} in ${name}`);
        }
        storeState.records.set((record as Record<string, IDBValidKey>)[storeState.keyPath], copyRecord(record));
    }

    /** Returns the keys a database's object store holds, in key order. */
    readKeys(name: string, storeName: string): IDBValidKey[] {
        const records = this.databases.get(name)?.stores.get(storeName)?.records;
        return records ? [ ...records.keys() ].sort(compareKeys) : [];
    }

    open(name: string, version: number): IDBOpenDBRequest {
        const request = new FakeRequest() as FakeRequest & { onupgradeneeded: (() => void) | null };
        request.onupgradeneeded = null;
        setTimeout((): void => {
            let state = this.databases.get(name);
            if (state && state.version > version) {
                request.error = new DOMException(`${state.version} > ${version}`, VERSION_ERROR_NAME);
                request.onerror?.();
                return;
            }
            const upgrading = !state || state.version < version;
            state ??= { stores: new Map(), version };
            state.version = version;
            this.databases.set(name, state);
            request.result = new FakeDatabase(state);
            if (upgrading) {
                request.onupgradeneeded?.();
            }
            request.onsuccess?.();
        }, 0);
        return request as unknown as IDBOpenDBRequest;
    }
}
