// Keeps the picked directory handle in IndexedDB, so the library can reopen the folder after a reload.
import type { AccessibleDirectoryHandle } from './FileSystemAccess';

const DATABASE_NAME = 'webgpu-player-sandbox';
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = 'library';
const DIRECTORY_KEY = 'directory';

/** Resolves with a request's result, or rejects with its error. */
function readRequest<Result>(request: IDBRequest<Result>): Promise<Result> {
    return new Promise<Result>((resolve: (result: Result) => void, reject: (error: unknown) => void): void => {
        request.addEventListener('success', (): void => {
            resolve(request.result);
        });
        request.addEventListener('error', (): void => {
            reject(request.error);
        });
    });
}

/** Resolves when a transaction commits, or rejects when it fails or aborts. */
function completeTransaction(transaction: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve: () => void, reject: (error: unknown) => void): void => {
        transaction.addEventListener('complete', (): void => {
            resolve();
        });
        transaction.addEventListener('error', (): void => {
            reject(transaction.error);
        });
        transaction.addEventListener('abort', (): void => {
            reject(transaction.error);
        });
    });
}

function openDatabase(): Promise<IDBDatabase> {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener('upgradeneeded', (): void => {
        request.result.createObjectStore(OBJECT_STORE_NAME);
    });
    return readRequest(request);
}

/** Returns the remembered directory handle, or null when none was remembered. */
export async function readRememberedDirectory(): Promise<AccessibleDirectoryHandle | null> {
    const database = await openDatabase();
    try {
        const transaction = database.transaction(OBJECT_STORE_NAME, 'readonly');
        const value: unknown = await readRequest(transaction.objectStore(OBJECT_STORE_NAME).get(DIRECTORY_KEY));
        if (value === undefined) {
            return null;
        }
        if (!(value instanceof FileSystemDirectoryHandle)) {
            throw new TypeError(`not-a-directory-handle ${typeof value}`);
        }
        return value as AccessibleDirectoryHandle;
    } finally {
        database.close();
    }
}

/** Remembers a directory handle in place of the previous one. */
export async function rememberDirectory(handle: AccessibleDirectoryHandle): Promise<void> {
    const database = await openDatabase();
    try {
        const transaction = database.transaction(OBJECT_STORE_NAME, 'readwrite');
        transaction.objectStore(OBJECT_STORE_NAME).put(handle, DIRECTORY_KEY);
        await completeTransaction(transaction);
    } finally {
        database.close();
    }
}
