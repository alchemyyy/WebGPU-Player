// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { verifyGPUDecoderPackage } from 'webgpu-player/decode/video/gpu/GPUDecoderVerification';

import type { SandboxDecoderPackage } from '../../../sandbox/src/contracts/SandboxContracts';
import { createSandboxDecoderPackages } from '../../../sandbox/src/session/DecoderPackages';
import { assembleDecoderPackageFile, createVideoDecoderSource } from '../../helpers/decoderPackages';
import { FakeIndexedDB } from '../../helpers/fakeIndexedDB';

// Every package's vector check passes for its one vector format, so a test needs no device
const VECTOR_FORMAT: GPUDecoderOutputFormat = 'I420';
const PASSED_CODE = 'passed';
const PASSED_DETAIL = 'sha256 matches';

vi.mock('webgpu-player/decode/video/gpu/GPUDecoderVerification', () => ({
    getGPUDecoderVectorFormats: vi.fn(() => [ VECTOR_FORMAT ]),
    verifyGPUDecoderPackage: vi.fn(() => Promise.resolve({ code: PASSED_CODE, detail: PASSED_DETAIL }))
}));

const PACKAGE_ID = 'hevc';
const PACKAGE_NAME = 'HEVC';
const REBUILT_PACKAGE_NAME = 'HEVC rebuilt';
const FILE_NAME = 'hevc.wasm';
const REBUILT_FILE_NAME = 'hevc-rebuilt.wasm';
const DEVICE = {} as GPUDevice;

let fakeIndexedDB: FakeIndexedDB;

async function createPackageFile(name: string, fileName: string): Promise<File> {
    const bytes = await assembleDecoderPackageFile(null, createVideoDecoderSource({ id: PACKAGE_ID, name }));
    return new File([ bytes ], fileName);
}

beforeEach(() => {
    fakeIndexedDB = new FakeIndexedDB();
    vi.stubGlobal('indexedDB', fakeIndexedDB);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('createSandboxDecoderPackages', () => {
    it('replaces a package with a rebuilt one of its id, dropping the replaced version\'s vector checks', async () => {
        const published: (readonly SandboxDecoderPackage[])[] = [];
        const failures: string[] = [];
        const packages = createSandboxDecoderPackages({
            publish: (list: readonly SandboxDecoderPackage[]): void => {
                published.push(list);
            },
            recordFailure: (code: string, detail: string): void => {
                failures.push(`${code}: ${detail}`);
            }
        });

        await packages.add([ await createPackageFile(PACKAGE_NAME, FILE_NAME) ]);
        await packages.verify(PACKAGE_ID, DEVICE);
        const verified = published.at(-1) ?? [];
        await packages.add([ await createPackageFile(REBUILT_PACKAGE_NAME, REBUILT_FILE_NAME) ]);
        const replaced = published.at(-1) ?? [];

        expect(failures).toEqual([]);
        expect(vi.mocked(verifyGPUDecoderPackage)).toHaveBeenCalledOnce();
        expect(verified).toEqual([ expect.objectContaining({
            fileName: FILE_NAME,
            id: PACKAGE_ID,
            verifications: [ { code: PASSED_CODE, detail: PASSED_DETAIL, format: VECTOR_FORMAT } ]
        }) ]);
        expect(replaced).toHaveLength(1);
        expect(replaced[0]).toMatchObject({ fileName: REBUILT_FILE_NAME, id: PACKAGE_ID, name: REBUILT_PACKAGE_NAME, verifications: [] });
        expect(replaced[0].contentHash).not.toBe(verified[0].contentHash);
        expect(packages.getVideoDecoders().map(decoderPackage => decoderPackage.contentHash)).toEqual([ replaced[0].contentHash ]);
    });

    it('removes a package by its id', async () => {
        const published: (readonly SandboxDecoderPackage[])[] = [];
        const packages = createSandboxDecoderPackages({
            publish: (list: readonly SandboxDecoderPackage[]): void => {
                published.push(list);
            },
            recordFailure: (): void => undefined
        });
        await packages.add([ await createPackageFile(PACKAGE_NAME, FILE_NAME) ]);

        await packages.remove(PACKAGE_ID);

        expect(published.at(-1)).toEqual([]);
        expect(packages.getVideoDecoders()).toEqual([]);
    });
});
