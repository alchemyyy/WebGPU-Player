// @vitest-environment node

import { TEST_VECTORS_DIRECTORY, WASM_OUTPUT_DIRECTORY } from '../../helpers/enginePaths';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import DolbyVisionRPUParser, {
    decodeDolbyVisionRPUSnapshot,
    DOLBY_VISION_RPU_PARSER_REVISION_PREFIX,
    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
    DOLBY_VISION_RPU_SCHEMA_VERSION,
    DolbyVisionRPUParseError,
    MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH,
    MAXIMUM_DOLBY_VISION_RPU_PARSER_MEMORY_BYTE_LENGTH,
    resolveDolbyVisionRPUParserWASMURL,
    type DolbyVisionRPUParserDependencies,
    type DolbyVisionRPULayerMode
} from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParser';

const PARSER_WASM_PATH = resolve(WASM_OUTPUT_DIRECTORY, 'libdovi', 'dovi-rpu-parser.wasm');
const RPU_VECTOR_DIRECTORY = resolve(TEST_VECTORS_DIRECTORY, 'dolby-vision-rpu');
const PARSER_WASM_BYTES = new Uint8Array(readFileSync(PARSER_WASM_PATH));
const WASM_PAGE_BYTE_LENGTH = 64 * 1_024;
// After the start code, the 0x19 prefix, and the byte holding rpu_type; its top bit is rpu_format bit 8
const RPU_FORMAT_EXTENSION_BYTE_INDEX = 6;
const RPU_FORMAT_EXTENSION_BIT = 0x80;
const SNAPSHOT_PROFILE_BYTE_OFFSET = 20;

describe('Dolby Vision parser asset URL', () => {
    it('resolves the parser against the engine asset base', () => {
        vi.stubGlobal('location', { href: 'https://example.test/web/index.html#!/details' });
        try {
            expect(resolveDolbyVisionRPUParserWASMURL()).toBe(
                'https://example.test/web/libraries/libdovi/dovi-rpu-parser.wasm'
            );
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

type ParserVector = {
    componentMMRVectorCounts: readonly [number, number, number]
    componentPivotCounts: readonly [number, number, number]
    fileName: string
    layerMode: DolbyVisionRPULayerMode
    level1: readonly [number, number, number]
    profile: number
    sha256: string
    sourcePQ: readonly [number, number]
};

const PARSER_VECTORS: readonly ParserVector[] = [
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'profile5.bin',
        layerMode: 'single-layer',
        level1: [ 2, 3_383, 819 ],
        profile: 5,
        sha256: '0355f79fbbaac16fda35482f9eb734f4a5fd59fc90d0cbf91a7638c815060e13',
        sourcePQ: [ 62, 3_696 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 3, 2, 2 ],
        fileName: 'profile5-02.bin',
        layerMode: 'single-layer',
        level1: [ 0, 2_081, 819 ],
        profile: 5,
        sha256: '9166784ce6633ca16aa6da1fd875639d137d93cce8e9e871351a1e5edc4756b6',
        sourcePQ: [ 7, 3_079 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'profile8.bin',
        layerMode: 'single-layer',
        level1: [ 2, 3_383, 819 ],
        profile: 8,
        sha256: 'bb4d6b3923f489950010f02919d92b3880b7f527232544fc20445946cde3446b',
        sourcePQ: [ 62, 3_696 ]
    },
    {
        componentMMRVectorCounts: [ 0, 6, 6 ],
        componentPivotCounts: [ 9, 2, 2 ],
        fileName: 'profile84.bin',
        layerMode: 'single-layer',
        level1: [ 2, 3_383, 819 ],
        profile: 8,
        sha256: '499ac7b241f02c357d37d0ff918b20b34977e26d4dabc58313ca782ae602aff0',
        sourcePQ: [ 62, 3_696 ]
    },
    {
        componentMMRVectorCounts: [ 0, 6, 6 ],
        componentPivotCounts: [ 8, 2, 2 ],
        fileName: 'profile4.bin',
        layerMode: 'fel',
        level1: [ 0, 4_095, 1_024 ],
        profile: 4,
        sha256: 'cb960d4eaa336d1134ecb8bdf8e127595bd1a52c331f966342f8cd7b8d15c29c',
        sourcePQ: [ 62, 3_697 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'mel_rpu.bin',
        layerMode: 'mel',
        level1: [ 0, 2_081, 1_340 ],
        profile: 7,
        sha256: '08d55bfad4555c8f797d78710127dd4552a318c0bfef93f9f2ac614371641eb4',
        sourcePQ: [ 7, 3_079 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'mel_variable_l8_length13.bin',
        layerMode: 'mel',
        level1: [ 0, 3_100, 2_048 ],
        profile: 7,
        sha256: '71e59494eec47e7f15f01ce8bf77e6e74ebbe4449d1a0d8d25cac3f195634ed1',
        sourcePQ: [ 7, 3_079 ]
    },
    {
        componentMMRVectorCounts: [ 0, 6, 6 ],
        componentPivotCounts: [ 9, 2, 2 ],
        fileName: 'fel_rpu.bin',
        layerMode: 'fel',
        level1: [ 0, 2_873, 1_060 ],
        profile: 7,
        sha256: '8d85c1be0a59e9583526714ec07cf9e9b23a2418203f80c670395a0aab829c81',
        sourcePQ: [ 7, 3_079 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'trailing_bytes_rpu.bin',
        layerMode: 'fel',
        level1: [ 12, 2_452, 887 ],
        profile: 7,
        sha256: '3a8e16df1b283cc33c551383d678614b5e41dfcb954fc5d6f28c8850deaf76ea',
        sourcePQ: [ 62, 3_696 ]
    }
];

function readVector(fileName: string): Uint8Array {
    return new Uint8Array(readFileSync(resolve(RPU_VECTOR_DIRECTORY, fileName)));
}

async function instantiateParserModule(): Promise<WebAssembly.Instance> {
    const result = await WebAssembly.instantiate(PARSER_WASM_BYTES, {});
    return result.instance;
}

const ACTUAL_PARSER_DEPENDENCIES: DolbyVisionRPUParserDependencies = {
    loadInstance: instantiateParserModule
};

async function createActualParser(): Promise<DolbyVisionRPUParser> {
    return DolbyVisionRPUParser.create('local-parser.wasm', ACTUAL_PARSER_DEPENDENCIES);
}

describe('DolbyVisionRPUParser pinned WASM integration', () => {
    it.each(PARSER_VECTORS)(
        'packs $fileName into the stable shader schema',
        async vector => {
            const parser = await createActualParser();
            try {
                const snapshot = parser.parse(readVector(vector.fileName));
                expect(snapshot).toMatchObject({
                    layerMode: vector.layerMode,
                    level1AveragePQ: vector.level1[2],
                    level1MaximumPQ: vector.level1[1],
                    level1MinimumPQ: vector.level1[0],
                    parserRevisionPrefix: DOLBY_VISION_RPU_PARSER_REVISION_PREFIX,
                    profile: vector.profile,
                    schemaVersion: DOLBY_VISION_RPU_SCHEMA_VERSION,
                    sourceMaximumPQ: vector.sourcePQ[1],
                    sourceMinimumPQ: vector.sourcePQ[0]
                });
                expect(snapshot.packedData.byteLength).toBe(
                    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH
                );
                expect(snapshot.components.map(component => component.numPivots)).toEqual(
                    vector.componentPivotCounts
                );
                expect(snapshot.components.map(component => component.mmrVectorCount)).toEqual(
                    vector.componentMMRVectorCounts
                );
                expect(createHash('sha256')
                    .update(new Uint8Array(snapshot.packedData))
                    .digest('hex')).toBe(vector.sha256);
            } finally {
                parser.close();
            }
        }
    );

    it('divides Profile 4 display metadata offsets by 2^30 like FFmpeg', async () => {
        const parser = await createActualParser();
        try {
            // The vector carries 2^26 and 2^29, the same limited-range offsets Profile 8 codes in 2^28 units
            const profile4Snapshot = parser.parse(readVector('profile4.bin'));
            expect(profile4Snapshot.explicitColorMetadata).toBe(true);
            expect(profile4Snapshot.nonlinearOffset).toEqual([ 0.0625, 0.5, 0.5 ]);
            expect(profile4Snapshot.nlqActive).toBe(true);
            expect(parser.parse(readVector('profile8.bin')).nonlinearOffset).toEqual(
                profile4Snapshot.nonlinearOffset
            );
        } finally {
            parser.close();
        }
    });

    it('reports unsupported RPU syntax without poisoning the parser', async () => {
        const parser = await createActualParser();
        // FFmpeg rejects an rpu_format extension as unimplemented while reading the header, before any CRC
        const extendedFormatRPU = readVector('profile8.bin');
        extendedFormatRPU[RPU_FORMAT_EXTENSION_BYTE_INDEX] |= RPU_FORMAT_EXTENSION_BIT;
        try {
            let parseError: unknown;
            try {
                parser.parse(extendedFormatRPU);
            } catch (error) {
                parseError = error;
            }
            expect(parseError).toBeInstanceOf(DolbyVisionRPUParseError);
            expect(parseError).toMatchObject({
                message: 'Dolby Vision RPU format 0x112 is unsupported',
                statusCode: 4
            });
            expect(parser.parse(readVector('profile8.bin')).profile).toBe(8);
        } finally {
            parser.close();
        }
    });

    it('matches the pinned libplacebo Profile 8.4 cumulative pivots', async () => {
        const parser = await createActualParser();
        try {
            const pivots = parser.parse(readVector('profile84.bin')).components[0].pivots;
            const referencePivots = [
                0.0615835786,
                0.129032254,
                0.353861183,
                0.604105592,
                0.854349971,
                0.890518069,
                0.906158328,
                0.913978517,
                0.92082113
            ];
            expect(pivots).toHaveLength(referencePivots.length);
            for (let pivotIndex = 0; pivotIndex < pivots.length; pivotIndex += 1) {
                expect(pivots[pivotIndex]).toBeCloseTo(referencePivots[pivotIndex], 7);
            }
        } finally {
            parser.close();
        }
    });

    it('rejects a corrupt RPU and remains reusable', async () => {
        const parser = await createActualParser();
        const corruptRPU = readVector('profile8.bin');
        corruptRPU[corruptRPU.byteLength - 1] ^= 1;
        try {
            expect(() => parser.parse(corruptRPU)).toThrowError(
                expect.objectContaining({ statusCode: 3 })
            );
            expect(parser.parse(readVector('profile8.bin')).profile).toBe(8);
        } finally {
            parser.close();
        }
    });

    it('returns owned snapshots and enforces reset and close state', async () => {
        const parser = await createActualParser();
        const firstSnapshot = parser.parse(readVector('profile5.bin'));
        const firstHash = createHash('sha256')
            .update(new Uint8Array(firstSnapshot.packedData))
            .digest('hex');

        parser.parse(readVector('fel_rpu.bin'));
        parser.reset();
        expect(createHash('sha256')
            .update(new Uint8Array(firstSnapshot.packedData))
            .digest('hex')).toBe(firstHash);

        parser.close();
        parser.close();
        expect(() => parser.parse(readVector('profile5.bin'))).toThrow('parser is closed');
        expect(() => parser.reset()).toThrow('parser is closed');
    });

    it('has no imports and cannot exceed its fixed memory maximum', async () => {
        const module = await WebAssembly.compile(PARSER_WASM_BYTES);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = await WebAssembly.instantiate(module, {});
        const exportsValue = instance.exports as unknown as Record<string, unknown>;
        expect(exportsValue.dovi_parser_allocate).toBeTypeOf('function');
        const allocate = exportsValue.dovi_parser_allocate as (byteLength: number) => number;
        const memory = exportsValue.memory;
        expect(memory).toBeInstanceOf(WebAssembly.Memory);
        const parserMemory = memory as WebAssembly.Memory;
        const maximumPageCount = MAXIMUM_DOLBY_VISION_RPU_PARSER_MEMORY_BYTE_LENGTH
            / WASM_PAGE_BYTE_LENGTH;
        const initialPageCount = parserMemory.buffer.byteLength / WASM_PAGE_BYTE_LENGTH;

        expect(initialPageCount).toBeGreaterThanOrEqual(64);
        expect(allocate(MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH + 1)).toBe(0);
        parserMemory.grow(maximumPageCount - initialPageCount);
        expect(parserMemory.buffer.byteLength).toBe(
            MAXIMUM_DOLBY_VISION_RPU_PARSER_MEMORY_BYTE_LENGTH
        );
        expect(() => parserMemory.grow(1)).toThrow(RangeError);
    });
});

describe('decodeDolbyVisionRPUSnapshot validation', () => {
    it('rejects incompatible headers and non-finite shader data', async () => {
        const parser = await createActualParser();
        const validPackedData = parser.parse(readVector('profile8.bin')).packedData;
        parser.close();

        const corruptMagic = validPackedData.slice(0);
        new DataView(corruptMagic).setUint32(0, 0, true);
        expect(() => decodeDolbyVisionRPUSnapshot(corruptMagic)).toThrow(
            'snapshot header is incompatible'
        );

        const unknownFlags = validPackedData.slice(0);
        new DataView(unknownFlags).setUint32(12, 1 << 31, true);
        expect(() => decodeDolbyVisionRPUSnapshot(unknownFlags)).toThrow(
            'snapshot header is incompatible'
        );

        const nonFiniteMatrix = validPackedData.slice(0);
        new DataView(nonFiniteMatrix).setUint32(208, 0x7FC0_0000, true);
        expect(() => decodeDolbyVisionRPUSnapshot(nonFiniteMatrix)).toThrow(
            'is not finite'
        );
    });

    it('requires an enhancement layer exactly for Profiles 4 and 7', async () => {
        const parser = await createActualParser();
        const singleLayerPackedData = parser.parse(readVector('profile8.bin')).packedData;
        const dualLayerPackedData = parser.parse(readVector('profile4.bin')).packedData;
        parser.close();
        const withProfile = (packedData: ArrayBuffer, profile: number): ArrayBuffer => {
            const relabeledPackedData = packedData.slice(0);
            new DataView(relabeledPackedData).setUint32(SNAPSHOT_PROFILE_BYTE_OFFSET, profile, true);
            return relabeledPackedData;
        };

        expect(decodeDolbyVisionRPUSnapshot(dualLayerPackedData)).toMatchObject({
            layerMode: 'fel',
            profile: 4
        });
        expect(decodeDolbyVisionRPUSnapshot(withProfile(dualLayerPackedData, 7)).profile).toBe(7);
        expect(decodeDolbyVisionRPUSnapshot(withProfile(singleLayerPackedData, 5)).profile).toBe(5);
        const contradictions: ReadonlyArray<readonly [ArrayBuffer, number]> = [
            [ singleLayerPackedData, 4 ],
            [ singleLayerPackedData, 7 ],
            [ dualLayerPackedData, 5 ],
            [ dualLayerPackedData, 8 ]
        ];
        for (const [ packedData, profile ] of contradictions) {
            expect(() => decodeDolbyVisionRPUSnapshot(withProfile(packedData, profile))).toThrow(
                'contradict its profile'
            );
        }
        for (const profile of [ 0, 6, 9 ]) {
            expect(() => decodeDolbyVisionRPUSnapshot(withProfile(dualLayerPackedData, profile)))
                .toThrow('profile is invalid');
        }
    });

    it('releases the context and fixed buffers exactly once', async () => {
        const memory = new WebAssembly.Memory({ initial: 2 });
        let nextPointer = 1_024;
        const allocate = vi.fn((byteLength: number): number => {
            const pointer = nextPointer;
            nextPointer += byteLength;
            return pointer;
        });
        const deallocate = vi.fn();
        const destroy = vi.fn();
        /* eslint-disable @typescript-eslint/naming-convention -- Mirrors the external WASM ABI */
        const instance = {
            exports: {
                dovi_parser_allocate: allocate,
                dovi_parser_create: (): number => 512,
                dovi_parser_deallocate: deallocate,
                dovi_parser_destroy: destroy,
                dovi_parser_last_error_byte_length: (): number => 0,
                dovi_parser_last_error_pointer: (): number => 0,
                dovi_parser_maximum_buffer_byte_length: (): number => (
                    MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH
                ),
                dovi_parser_maximum_memory_byte_length: (): number => (
                    MAXIMUM_DOLBY_VISION_RPU_PARSER_MEMORY_BYTE_LENGTH
                ),
                dovi_parser_output_byte_length: (): number => (
                    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH
                ),
                dovi_parser_parse: (): number => 0,
                dovi_parser_reset: (): number => 0,
                dovi_parser_revision_prefix: (): number => (
                    DOLBY_VISION_RPU_PARSER_REVISION_PREFIX
                ),
                dovi_parser_schema_version: (): number => (
                    DOLBY_VISION_RPU_SCHEMA_VERSION
                ),
                memory
            }
        } as unknown as WebAssembly.Instance;
        /* eslint-enable @typescript-eslint/naming-convention */
        const parser = await DolbyVisionRPUParser.create('mock.wasm', {
            loadInstance: async (): Promise<WebAssembly.Instance> => instance
        });

        parser.close();
        parser.close();

        expect(allocate).toHaveBeenCalledTimes(2);
        expect(deallocate).toHaveBeenCalledTimes(2);
        expect(destroy).toHaveBeenCalledTimes(1);
    });
});
