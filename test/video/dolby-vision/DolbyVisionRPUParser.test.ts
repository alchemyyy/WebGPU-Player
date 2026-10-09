// @vitest-environment node

import { createDolbyVisionAV1ITUTT35Payload } from '../../helpers/dolbyVisionAV1ITUTT35Payload';
import {
    createMixedDolbyVisionRPUVector,
    getPackedComponentFlagsByteOffset,
    getPackedSegmentByteOffset,
    MIXED_COMPONENT_INDEX
} from '../../helpers/dolbyVisionMixedRPUVector';
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
import {
    DOLBY_VISION_RPU_COMPONENT_FLAG_MMR,
    DOLBY_VISION_RPU_COMPONENT_FLAG_POLYNOMIAL,
    DOLBY_VISION_RPU_SEGMENT_MMR_ORDER_INDEX
} from 'webgpu-player/video/dolby-vision/DolbyVisionRPUDataLayout';

const PARSER_WASM_PATH = resolve(WASM_OUTPUT_DIRECTORY, 'libdovi', 'dovi-rpu-parser.wasm');
const RPU_VECTOR_DIRECTORY = resolve(TEST_VECTORS_DIRECTORY, 'dolby-vision-rpu');
const PARSER_WASM_BYTES = new Uint8Array(readFileSync(PARSER_WASM_PATH));
const WASM_PAGE_BYTE_LENGTH = 64 * 1_024;
// After the start code, the 0x19 prefix, and the byte holding rpu_type; its top bit is rpu_format bit 8
const RPU_FORMAT_EXTENSION_BYTE_INDEX = 6;
const RPU_FORMAT_EXTENSION_BIT = 0x80;
const SNAPSHOT_PROFILE_BYTE_OFFSET = 20;
// The AV1 trailing bits and zero padding that may end an OBU after its T.35 payload
const OBU_TRAILING_BYTES: readonly number[] = [ 0x80, 0x00, 0x00 ];
// The low byte of the provider code, after the country code
const ITU_T_T35_PROVIDER_CODE_LOW_BYTE_INDEX = 2;
const STATUS_PARSE_FAILED = 3;
const SEGMENT_MMR_ORDER_BYTE_OFFSET = DOLBY_VISION_RPU_SEGMENT_MMR_ORDER_INDEX * Float32Array.BYTES_PER_ELEMENT;

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
        sha256: '9e260db8a124fe237d238d6532cde1e4b82c198c9bde656cfb3ce5709ac19842',
        sourcePQ: [ 62, 3_696 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 3, 2, 2 ],
        fileName: 'profile5-02.bin',
        layerMode: 'single-layer',
        level1: [ 0, 2_081, 819 ],
        profile: 5,
        sha256: '0bb79ce7db2f3ae7447f15e979b632e0b4f4da474b03cb7fe1fa714090ec2122',
        sourcePQ: [ 7, 3_079 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'profile8.bin',
        layerMode: 'single-layer',
        level1: [ 2, 3_383, 819 ],
        profile: 8,
        sha256: '32c081a532a499ef9a9ffe2da1bf0f6db6cc81cfd2ad901d06a45a6c3e1fd9ce',
        sourcePQ: [ 62, 3_696 ]
    },
    {
        componentMMRVectorCounts: [ 0, 6, 6 ],
        componentPivotCounts: [ 9, 2, 2 ],
        fileName: 'profile84.bin',
        layerMode: 'single-layer',
        level1: [ 2, 3_383, 819 ],
        profile: 8,
        sha256: '9875addcf0384fc8193773ef089c19fa63c33a6bfdf8b7a0cbe41b34d49b5daa',
        sourcePQ: [ 62, 3_696 ]
    },
    {
        componentMMRVectorCounts: [ 0, 6, 6 ],
        componentPivotCounts: [ 8, 2, 2 ],
        fileName: 'profile4.bin',
        layerMode: 'fel',
        level1: [ 0, 4_095, 1_024 ],
        profile: 4,
        sha256: '28b4aff54a2eaa06e3e790f34315875ce766c963153a3eaca3bf318ae4d56b99',
        sourcePQ: [ 62, 3_697 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'mel_rpu.bin',
        layerMode: 'mel',
        level1: [ 0, 2_081, 1_340 ],
        profile: 7,
        sha256: '8f80d9e3b1e43a51120950ffc9e4de5330f98e52b3ebc87d84e263dcd2fddf32',
        sourcePQ: [ 7, 3_079 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'mel_variable_l8_length13.bin',
        layerMode: 'mel',
        level1: [ 0, 3_100, 2_048 ],
        profile: 7,
        sha256: '303d6d37a7105d609e6fb2bd0fd40e877dbd07bbebf7ab873bbad5d18d630970',
        sourcePQ: [ 7, 3_079 ]
    },
    {
        componentMMRVectorCounts: [ 0, 6, 6 ],
        componentPivotCounts: [ 9, 2, 2 ],
        fileName: 'fel_rpu.bin',
        layerMode: 'fel',
        level1: [ 0, 2_873, 1_060 ],
        profile: 7,
        sha256: 'ba5c6ec01d41e2286023ad2b5b46fecbeb0fcee96f9cbd2bf272e90f46be535c',
        sourcePQ: [ 7, 3_079 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'trailing_bytes_rpu.bin',
        layerMode: 'fel',
        level1: [ 12, 2_452, 887 ],
        profile: 7,
        sha256: 'a619491ac6a38b8f3bd1e590f3983fe4be165ac5531f4f87be206e552b430640',
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

describe('DolbyVisionRPUParser AV1 ITU-T T.35 payloads', () => {
    it.each(PARSER_VECTORS)(
        'packs $fileName from its AV1 T.35 payload as from its HEVC RPU',
        async vector => {
            const rpu = readVector(vector.fileName);
            const hevcParser = await createActualParser();
            const av1Parser = await createActualParser();
            try {
                const hevcPackedData = new Uint8Array(hevcParser.parse(rpu).packedData);
                // The parser accepts the payload with or without its country code
                for (const includeCountryCode of [ true, false ]) {
                    av1Parser.reset();
                    const snapshot = av1Parser.parseAV1ITUTT35(
                        createDolbyVisionAV1ITUTT35Payload(rpu, { includeCountryCode })
                    );
                    expect(snapshot.profile).toBe(vector.profile);
                    expect(new Uint8Array(snapshot.packedData)).toEqual(hevcPackedData);
                }
            } finally {
                hevcParser.close();
                av1Parser.close();
            }
        }
    );

    it('ignores the OBU trailing bits after the EMDF container', async () => {
        const parser = await createActualParser();
        try {
            const payload = createDolbyVisionAV1ITUTT35Payload(readVector('profile8.bin'));
            const expectedPackedData = new Uint8Array(parser.parseAV1ITUTT35(payload).packedData);
            parser.reset();

            const snapshot = parser.parseAV1ITUTT35(
                Uint8Array.from([ ...payload, ...OBU_TRAILING_BYTES ])
            );

            expect(new Uint8Array(snapshot.packedData)).toEqual(expectedPackedData);
        } finally {
            parser.close();
        }
    });

    it('rejects another T.35 provider without poisoning either entry point', async () => {
        const parser = await createActualParser();
        const payload = createDolbyVisionAV1ITUTT35Payload(readVector('profile8.bin'));
        const otherProviderPayload = payload.slice();
        otherProviderPayload[ITU_T_T35_PROVIDER_CODE_LOW_BYTE_INDEX] += 1;
        try {
            let parseError: unknown;
            try {
                parser.parseAV1ITUTT35(otherProviderPayload);
            } catch (error) {
                parseError = error;
            }
            expect(parseError).toBeInstanceOf(DolbyVisionRPUParseError);
            expect(parseError).toMatchObject({ statusCode: STATUS_PARSE_FAILED });
            expect((parseError as Error).message).toContain('Invalid AV1 RPU payload header');
            // Each entry point rejects the other's framing
            expect(() => parser.parse(payload)).toThrowError(
                expect.objectContaining({ statusCode: STATUS_PARSE_FAILED })
            );
            expect(() => parser.parseAV1ITUTT35(readVector('profile8.bin'))).toThrowError(
                expect.objectContaining({ statusCode: STATUS_PARSE_FAILED })
            );
            expect(parser.parseAV1ITUTT35(payload).profile).toBe(8);
            expect(parser.parse(readVector('profile8.bin')).profile).toBe(8);
        } finally {
            parser.close();
        }
    });

    it('bounds AV1 payloads like HEVC RPUs and refuses them once closed', async () => {
        const parser = await createActualParser();
        expect(() => parser.parseAV1ITUTT35(new Uint8Array(0))).toThrow(
            'input exceeds its byte bound'
        );
        expect(() => parser.parseAV1ITUTT35(
            new Uint8Array(MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH + 1)
        )).toThrow('input exceeds its byte bound');
        parser.close();
        expect(() => parser.parseAV1ITUTT35(
            createDolbyVisionAV1ITUTT35Payload(readVector('profile8.bin'))
        )).toThrow('parser is closed');
    });
});

describe('decodeDolbyVisionRPUSnapshot validation', () => {
    it('reports the mapping method of each component, including mixed pieces', () => {
        const snapshot = decodeDolbyVisionRPUSnapshot(createMixedDolbyVisionRPUVector());

        expect(snapshot.schemaVersion).toBe(DOLBY_VISION_RPU_SCHEMA_VERSION);
        expect(snapshot.components.map(component => component.mappingMethod)).toEqual([
            'polynomial',
            'mixed',
            'mmr'
        ]);
    });

    it.each([
        {
            corrupt: (view: DataView): void => {
                // The polynomial piece rewritten as a valid order-1 MMR piece leaves no polynomial segment
                const segmentByteOffset = getPackedSegmentByteOffset(MIXED_COMPONENT_INDEX, 1);
                view.setFloat32(segmentByteOffset + Float32Array.BYTES_PER_ELEMENT, 0, true);
                view.setFloat32(segmentByteOffset + SEGMENT_MMR_ORDER_BYTE_OFFSET, 1, true);
            },
            message: 'segment methods contradict their component flags',
            name: 'mixed flags over MMR segments only'
        },
        {
            corrupt: (view: DataView): void => {
                view.setUint32(
                    getPackedComponentFlagsByteOffset(MIXED_COMPONENT_INDEX),
                    DOLBY_VISION_RPU_COMPONENT_FLAG_POLYNOMIAL,
                    true
                );
            },
            message: 'segment methods contradict their component flags',
            name: 'polynomial flags over an MMR segment'
        },
        {
            corrupt: (view: DataView): void => {
                view.setUint32(
                    getPackedComponentFlagsByteOffset(MIXED_COMPONENT_INDEX),
                    DOLBY_VISION_RPU_COMPONENT_FLAG_MMR,
                    true
                );
            },
            message: 'segment methods contradict their component flags',
            name: 'MMR flags over a polynomial segment'
        },
        {
            corrupt: (view: DataView): void => {
                view.setFloat32(
                    getPackedSegmentByteOffset(MIXED_COMPONENT_INDEX, 1) + SEGMENT_MMR_ORDER_BYTE_OFFSET,
                    -1,
                    true
                );
            },
            message: 'segment method is invalid',
            name: 'a negative MMR order'
        },
        {
            corrupt: (view: DataView): void => {
                view.setFloat32(
                    getPackedSegmentByteOffset(MIXED_COMPONENT_INDEX, 0) + SEGMENT_MMR_ORDER_BYTE_OFFSET,
                    1.5,
                    true
                );
            },
            message: 'MMR segment references invalid packed data',
            name: 'a fractional MMR order'
        },
        {
            corrupt: (view: DataView): void => {
                // Order 3 from the third vector runs past the component's six vectors
                view.setFloat32(
                    getPackedSegmentByteOffset(MIXED_COMPONENT_INDEX, 0) + Float32Array.BYTES_PER_ELEMENT,
                    2,
                    true
                );
            },
            message: 'MMR segment references invalid packed data',
            name: 'MMR vectors past the packed count'
        },
        {
            corrupt: (view: DataView): void => {
                view.setUint32(getPackedComponentFlagsByteOffset(MIXED_COMPONENT_INDEX), 4, true);
            },
            message: 'packed component method is invalid',
            name: 'an unknown component flag'
        }
    ])('validates each segment by its own method: $name', ({ corrupt, message }) => {
        const packedData = createMixedDolbyVisionRPUVector();
        corrupt(new DataView(packedData));

        expect(() => decodeDolbyVisionRPUSnapshot(packedData)).toThrow(message);
    });

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
                dovi_parser_parse_av1_t35: (): number => 0,
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
