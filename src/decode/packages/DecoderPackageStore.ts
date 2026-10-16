// A host's store of the decoder packages its users add: each package file's bytes in IndexedDB, under the id its header declares.
// The engine itself stores nothing; a host names its own database, adds the files a user picks, and loads them all for each playback.
// A file of a stored id is a new version of that package, which replaces the stored one.
import { DecoderPackageError, loadDecoderPackage, type DecoderPackage } from './DecoderPackage';

// Version 2 keys files by the header's id; a database of another version opens empty, since its files are not kept
const DATABASE_VERSION = 2;
const PACKAGE_STORE_NAME = 'packages';
const PACKAGE_KEY_PATH = 'id';
const MISSING_ERROR_DETAIL = 'no error';

/** The step of a package store operation that failed. */
export type DecoderPackageStoreFailure =
    | 'package-add-failed'
    | 'package-delete-failed'
    | 'package-read-failed'
    | 'store-open-failed'
    | 'store-unavailable';

/** A failed package store operation: its code, then a terse detail of what failed. */
export class DecoderPackageStoreError extends Error {
    readonly code: DecoderPackageStoreFailure;

    constructor(code: DecoderPackageStoreFailure, detail: string) {
        super(`${code}: ${detail}`);
        this.name = 'DecoderPackageStoreError';
        this.code = code;
    }
}

/** One stored package file, as the store keeps it. */
export type StoredDecoderPackageFile = Readonly<{
    /** Date.now() when the user first added the package's id, which orders the packages; a new version keeps it */
    addedAtMilliseconds: number
    bytes: ArrayBuffer
    /** The name of the file the user added */
    fileName: string
    /** The id the package's header declares, which keys the file */
    id: string
}>;

/** A stored package that no longer loads, as when an engine update tightened a check: its file, and the failed check. */
export type StoredDecoderPackageFailure = Readonly<{
    detail: string
    fileName: string
    id: string
}>;

/** A stored package that loads, with the file it came from. */
export type StoredDecoderPackage = Readonly<{
    addedAtMilliseconds: number
    decoderPackage: DecoderPackage
    fileName: string
}>;

/** Every stored package, oldest first: the ones that load, and a failure for each one that does not. */
export type StoredDecoderPackages = Readonly<{
    failures: readonly StoredDecoderPackageFailure[]
    packages: readonly StoredDecoderPackage[]
}>;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function describeDOMException(error: DOMException | null): string {
    return error ? `${error.name}: ${error.message}` : MISSING_ERROR_DETAIL;
}

function describeLoadFailure(error: unknown): string {
    return error instanceof DecoderPackageError ? error.message : getErrorMessage(error);
}

function isStoredFile(value: unknown): value is StoredDecoderPackageFile {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const file = value as Record<string, unknown>;
    return typeof file.id === 'string'
        && typeof file.fileName === 'string'
        && typeof file.addedAtMilliseconds === 'number'
        && file.bytes instanceof ArrayBuffer;
}

/** One host's package database; the connection opens with the first operation and opens again after a failed open. */
export default class DecoderPackageStore {
    private databasePromise: Promise<IDBDatabase> | null = null;
    private readonly databaseName: string;

    constructor(databaseName: string) {
        this.databaseName = databaseName;
    }

    /**
     * Loads a package file with the engine's checks and stores it under its header's id.
     * A stored file of the same id is a version of the same package: the new file replaces it and keeps its place in the order.
     * Rejects with the DecoderPackageError of a file the engine refuses, which is not stored.
     */
    async add(fileName: string, bytes: ArrayBuffer): Promise<StoredDecoderPackage> {
        const decoderPackage = await loadDecoderPackage(bytes);
        let file: StoredDecoderPackageFile = { addedAtMilliseconds: Date.now(), bytes, fileName, id: decoderPackage.id };
        await this.runTransaction(
            'readwrite',
            'package-add-failed',
            (store: IDBObjectStore): readonly IDBRequest[] => {
                const replacedRequest = store.get(decoderPackage.id);
                // The put joins the transaction from the read's success, so a failed read or write aborts both
                replacedRequest.onsuccess = (): void => {
                    const replaced: unknown = replacedRequest.result;
                    if (isStoredFile(replaced)) {
                        file = { ...file, addedAtMilliseconds: replaced.addedAtMilliseconds };
                    }
                    store.put(file);
                };
                return [ replacedRequest ];
            },
            (): void => undefined
        );
        return { addedAtMilliseconds: file.addedAtMilliseconds, decoderPackage, fileName };
    }

    /** Deletes a stored package; an id the store does not hold changes nothing. */
    async remove(id: string): Promise<void> {
        await this.runTransaction('readwrite', 'package-delete-failed', (store: IDBObjectStore): readonly IDBRequest[] => [ store.delete(id) ], (): void => undefined);
    }

    /**
     * Loads the stored package of one id with the engine's checks, or resolves null when the store holds none.
     * Rejects with the DecoderPackageError of a stored file that no longer loads, which stays stored until removed or replaced.
     */
    async load(id: string): Promise<StoredDecoderPackage | null> {
        const file = await this.runTransaction(
            'readonly',
            'package-read-failed',
            (store: IDBObjectStore): readonly IDBRequest[] => [ store.get(id) ],
            (requests: readonly IDBRequest[]): StoredDecoderPackageFile | null => {
                const value: unknown = requests[0].result;
                return isStoredFile(value) ? value : null;
            }
        );
        if (!file) {
            return null;
        }
        return { addedAtMilliseconds: file.addedAtMilliseconds, decoderPackage: await loadDecoderPackage(file.bytes), fileName: file.fileName };
    }

    /** Loads every stored package with the engine's checks, oldest first; a file that no longer loads is reported, and stays stored until removed. */
    async loadAll(): Promise<StoredDecoderPackages> {
        const files = await this.readFiles();
        const outcomes = await Promise.allSettled(files.map((file: StoredDecoderPackageFile): Promise<DecoderPackage> => loadDecoderPackage(file.bytes)));
        const packages: StoredDecoderPackage[] = [];
        const failures: StoredDecoderPackageFailure[] = [];
        for (const [ fileIndex, outcome ] of outcomes.entries()) {
            const file = files[fileIndex];
            if (outcome.status === 'fulfilled') {
                packages.push({ addedAtMilliseconds: file.addedAtMilliseconds, decoderPackage: outcome.value, fileName: file.fileName });
            } else {
                failures.push({ detail: describeLoadFailure(outcome.reason), fileName: file.fileName, id: file.id });
            }
        }
        return { failures, packages };
    }

    private async readFiles(): Promise<StoredDecoderPackageFile[]> {
        const files = await this.runTransaction(
            'readonly',
            'package-read-failed',
            (store: IDBObjectStore): readonly IDBRequest[] => [ store.getAll() ],
            (requests: readonly IDBRequest[]): StoredDecoderPackageFile[] => {
                const values: unknown = requests[0].result;
                return Array.isArray(values) ? values.filter(isStoredFile) : [];
            }
        );
        return files.sort((first: StoredDecoderPackageFile, second: StoredDecoderPackageFile): number => first.addedAtMilliseconds - second.addedAtMilliseconds);
    }

    private requestDatabase(): Promise<IDBDatabase> {
        return new Promise<IDBDatabase>((resolve: (database: IDBDatabase) => void, reject: (error: DecoderPackageStoreError) => void): void => {
            if (typeof indexedDB === 'undefined') {
                reject(new DecoderPackageStoreError('store-unavailable', 'indexedDB is undefined'));
                return;
            }
            let request: IDBOpenDBRequest;
            try {
                request = indexedDB.open(this.databaseName, DATABASE_VERSION);
            } catch (error) {
                // Opening throws where the browser blocks storage for the page
                reject(new DecoderPackageStoreError('store-open-failed', getErrorMessage(error)));
                return;
            }
            request.onupgradeneeded = (): void => {
                const database = request.result;
                // Files of an earlier version, keyed otherwise, are dropped rather than converted
                if (database.objectStoreNames.contains(PACKAGE_STORE_NAME)) {
                    database.deleteObjectStore(PACKAGE_STORE_NAME);
                }
                database.createObjectStore(PACKAGE_STORE_NAME, { keyPath: PACKAGE_KEY_PATH });
            };
            request.onsuccess = (): void => {
                const database = request.result;
                // A newer version opened in another tab asks this connection to close; the next operation opens it again
                database.onversionchange = (): void => {
                    database.close();
                    this.databasePromise = null;
                };
                resolve(database);
            };
            request.onerror = (): void => {
                reject(new DecoderPackageStoreError('store-open-failed', describeDOMException(request.error)));
            };
        });
    }

    /** Returns the store's connection, opening it once; a failed open is tried again by the next operation. */
    private openDatabase(): Promise<IDBDatabase> {
        if (this.databasePromise === null) {
            const opening = this.requestDatabase();
            this.databasePromise = opening;
            opening.catch((): void => {
                if (this.databasePromise === opening) {
                    this.databasePromise = null;
                }
            });
        }
        return this.databasePromise;
    }

    /** Runs requests in one transaction of the package store, and resolves with their reading once it commits; a failed request aborts it. */
    private async runTransaction<Result>(
        mode: IDBTransactionMode,
        failure: DecoderPackageStoreFailure,
        createRequests: (store: IDBObjectStore) => readonly IDBRequest[],
        readResults: (requests: readonly IDBRequest[]) => Result
    ): Promise<Result> {
        const database = await this.openDatabase();
        return new Promise<Result>((resolve: (result: Result) => void, reject: (error: DecoderPackageStoreError) => void): void => {
            try {
                const transaction = database.transaction(PACKAGE_STORE_NAME, mode);
                const requests = createRequests(transaction.objectStore(PACKAGE_STORE_NAME));
                transaction.oncomplete = (): void => {
                    try {
                        resolve(readResults(requests));
                    } catch (error) {
                        reject(new DecoderPackageStoreError(failure, getErrorMessage(error)));
                    }
                };
                transaction.onabort = (): void => {
                    reject(new DecoderPackageStoreError(failure, describeDOMException(transaction.error)));
                };
            } catch (error) {
                // A closed connection throws when a transaction starts
                reject(new DecoderPackageStoreError(failure, getErrorMessage(error)));
            }
        });
    }
}
