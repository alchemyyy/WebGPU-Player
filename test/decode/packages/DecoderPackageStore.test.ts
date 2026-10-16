// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DecoderPackageError } from 'webgpu-player/decode/packages/DecoderPackage';
import DecoderPackageStore from 'webgpu-player/decode/packages/DecoderPackageStore';

import { assembleDecoderPackageFile, createVideoDecoderSource } from '../../helpers/decoderPackages';
import { FakeIndexedDB } from '../../helpers/fakeIndexedDB';

const DATABASE_NAME = 'decoder-package-store-test';
// The object store and key path the store keeps its files in, which a database an earlier engine left also has
const OBJECT_STORE_NAME = 'packages';
const KEY_PATH = 'id';
const EARLIER_SCHEMA_VERSION = 1;
const SCHEMA_VERSION = 2;
const HEVC_ID = 'hevc';
const MPEG2_ID = 'mpeg2';
const HEVC_NAME = 'HEVC';
const REBUILT_HEVC_NAME = 'HEVC rebuilt';
const MPEG2_NAME = 'MPEG-2';
const HEVC_FILE_NAME = 'hevc.wasm';
const REBUILT_HEVC_FILE_NAME = 'hevc-rebuilt.wasm';
const MPEG2_FILE_NAME = 'mpeg2.wasm';
const FIRST_ADD_MILLISECONDS = 1_000;
const SECOND_ADD_MILLISECONDS = 2_000;
const THIRD_ADD_MILLISECONDS = 3_000;
const UNKNOWN_ID = 'vc1';
// A file an earlier engine stored under its SHA-256, and a stored file the engine no longer loads
const EARLIER_SCHEMA_KEY = 'ab'.repeat(32);
const STALE_ID = 'stale';
const STALE_FILE_NAME = 'stale.wasm';
const NOT_A_MODULE = Uint8Array.of(1, 2, 3, 4);

let fakeIndexedDB: FakeIndexedDB;

/** Returns a package file of a test decoder with the id and name. */
function createPackageFile(id: string, name: string): Promise<ArrayBuffer> {
    return assembleDecoderPackageFile(null, createVideoDecoderSource({ id, name }));
}

/** Makes Date.now() return the times in order, one per call. */
function useClock(...times: number[]): void {
    const clock = vi.spyOn(Date, 'now');
    for (const time of times) {
        clock.mockReturnValueOnce(time);
    }
}

beforeEach(() => {
    fakeIndexedDB = new FakeIndexedDB();
    vi.stubGlobal('indexedDB', fakeIndexedDB);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('DecoderPackageStore', () => {
    it('stores a package under the id its header declares and loads it back', async () => {
        const store = new DecoderPackageStore(DATABASE_NAME);
        useClock(FIRST_ADD_MILLISECONDS);

        const added = await store.add(HEVC_FILE_NAME, await createPackageFile(HEVC_ID, HEVC_NAME));
        const stored = await store.loadAll();

        expect(added).toMatchObject({ addedAtMilliseconds: FIRST_ADD_MILLISECONDS, fileName: HEVC_FILE_NAME });
        expect(stored.failures).toEqual([]);
        expect(stored.packages.map(storedPackage => [ storedPackage.decoderPackage.id, storedPackage.fileName ])).toEqual([ [ HEVC_ID, HEVC_FILE_NAME ] ]);
        expect(fakeIndexedDB.readKeys(DATABASE_NAME, OBJECT_STORE_NAME)).toEqual([ HEVC_ID ]);
    });

    it('replaces a stored package with a new version of its id, which keeps the replaced one\'s place', async () => {
        const store = new DecoderPackageStore(DATABASE_NAME);
        useClock(FIRST_ADD_MILLISECONDS, SECOND_ADD_MILLISECONDS, THIRD_ADD_MILLISECONDS);
        const firstVersion = await store.add(HEVC_FILE_NAME, await createPackageFile(HEVC_ID, HEVC_NAME));
        await store.add(MPEG2_FILE_NAME, await createPackageFile(MPEG2_ID, MPEG2_NAME));

        const rebuilt = await store.add(REBUILT_HEVC_FILE_NAME, await createPackageFile(HEVC_ID, REBUILT_HEVC_NAME));
        const stored = await store.loadAll();

        expect(rebuilt.addedAtMilliseconds).toBe(FIRST_ADD_MILLISECONDS);
        expect(rebuilt.decoderPackage.contentHash).not.toBe(firstVersion.decoderPackage.contentHash);
        expect(stored.packages.map(storedPackage => [ storedPackage.decoderPackage.id, storedPackage.fileName ])).toEqual([
            [ HEVC_ID, REBUILT_HEVC_FILE_NAME ],
            [ MPEG2_ID, MPEG2_FILE_NAME ]
        ]);
        expect(stored.packages[0].decoderPackage.contentHash).toBe(rebuilt.decoderPackage.contentHash);
        expect(fakeIndexedDB.readKeys(DATABASE_NAME, OBJECT_STORE_NAME)).toEqual([ HEVC_ID, MPEG2_ID ]);
    });

    it('removes a package by its id, and an id it does not hold changes nothing', async () => {
        const store = new DecoderPackageStore(DATABASE_NAME);
        await store.add(HEVC_FILE_NAME, await createPackageFile(HEVC_ID, HEVC_NAME));
        await store.add(MPEG2_FILE_NAME, await createPackageFile(MPEG2_ID, MPEG2_NAME));

        await store.remove(UNKNOWN_ID);
        await store.remove(HEVC_ID);

        expect(fakeIndexedDB.readKeys(DATABASE_NAME, OBJECT_STORE_NAME)).toEqual([ MPEG2_ID ]);
    });

    it('stores nothing of a file the engine refuses, such as one without an id', async () => {
        const store = new DecoderPackageStore(DATABASE_NAME);
        const refusedFile = await assembleDecoderPackageFile(null, createVideoDecoderSource({ id: null }));

        await expect(store.add(HEVC_FILE_NAME, refusedFile)).rejects.toBeInstanceOf(DecoderPackageError);

        expect((await store.loadAll()).packages).toEqual([]);
    });

    it('opens a database of the earlier schema empty, dropping its files', async () => {
        fakeIndexedDB.seed(DATABASE_NAME, EARLIER_SCHEMA_VERSION, OBJECT_STORE_NAME, KEY_PATH, [
            { addedAtMilliseconds: FIRST_ADD_MILLISECONDS, bytes: await createPackageFile(HEVC_ID, HEVC_NAME), fileName: HEVC_FILE_NAME, id: EARLIER_SCHEMA_KEY }
        ]);
        const store = new DecoderPackageStore(DATABASE_NAME);

        expect(await store.loadAll()).toEqual({ failures: [], packages: [] });
        expect(fakeIndexedDB.readKeys(DATABASE_NAME, OBJECT_STORE_NAME)).toEqual([]);
    });

    it('loads one stored package by its id, and nothing for an id it does not hold', async () => {
        const store = new DecoderPackageStore(DATABASE_NAME);
        useClock(FIRST_ADD_MILLISECONDS, SECOND_ADD_MILLISECONDS);
        await store.add(HEVC_FILE_NAME, await createPackageFile(HEVC_ID, HEVC_NAME));
        const mpeg2 = await store.add(MPEG2_FILE_NAME, await createPackageFile(MPEG2_ID, MPEG2_NAME));

        const loaded = await store.load(MPEG2_ID);

        expect(loaded).toMatchObject({ addedAtMilliseconds: SECOND_ADD_MILLISECONDS, fileName: MPEG2_FILE_NAME });
        expect(loaded?.decoderPackage).toMatchObject({ contentHash: mpeg2.decoderPackage.contentHash, id: MPEG2_ID, name: MPEG2_NAME });
        expect(await store.load(UNKNOWN_ID)).toBeNull();
    });

    it('rejects loading a stored file that no longer loads, and keeps it stored', async () => {
        fakeIndexedDB.seed(DATABASE_NAME, SCHEMA_VERSION, OBJECT_STORE_NAME, KEY_PATH, [
            { addedAtMilliseconds: FIRST_ADD_MILLISECONDS, bytes: NOT_A_MODULE.buffer, fileName: STALE_FILE_NAME, id: STALE_ID }
        ]);
        const store = new DecoderPackageStore(DATABASE_NAME);

        await expect(store.load(STALE_ID)).rejects.toMatchObject({ code: 'package-invalid' });

        expect(fakeIndexedDB.readKeys(DATABASE_NAME, OBJECT_STORE_NAME)).toEqual([ STALE_ID ]);
    });

    it('reports a stored file that no longer loads with its id, and keeps it until removed', async () => {
        const store = new DecoderPackageStore(DATABASE_NAME);
        await store.add(HEVC_FILE_NAME, await createPackageFile(HEVC_ID, HEVC_NAME));
        fakeIndexedDB.writeRecord(DATABASE_NAME, OBJECT_STORE_NAME, {
            addedAtMilliseconds: SECOND_ADD_MILLISECONDS,
            bytes: NOT_A_MODULE.buffer,
            fileName: STALE_FILE_NAME,
            id: STALE_ID
        });

        const stored = await store.loadAll();
        await store.remove(STALE_ID);

        expect(stored.packages.map(storedPackage => storedPackage.decoderPackage.id)).toEqual([ HEVC_ID ]);
        expect(stored.failures).toEqual([ { detail: expect.stringMatching(/^package-invalid: /) as unknown, fileName: STALE_FILE_NAME, id: STALE_ID } ]);
        expect(fakeIndexedDB.readKeys(DATABASE_NAME, OBJECT_STORE_NAME)).toEqual([ HEVC_ID ]);
    });
});
