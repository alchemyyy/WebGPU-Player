// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { WebAssemblyImportDescriptor } from 'webgpu-player/decode/packages/DecoderPackageBinary';
import {
    boundDecoderPackageMemory,
    createDecoderPackageImports,
    createDecoderPackageMemory,
    DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES,
    findForbiddenDecoderPackageImport,
    instantiateDecoderPackage,
    isDecoderPackageMemoryLimits
} from 'webgpu-player/decode/packages/DecoderPackageImports';

import { createMemoryImport, PACKAGE_MEMORY_IMPORT_MODULE, PACKAGE_MEMORY_IMPORT_NAME } from '../../helpers/decoderPackages';
import {
    encodeI32Const,
    encodeI32Store,
    encodeWebAssemblyModule,
    type WebAssemblyImportDefinition
} from '../../helpers/webAssemblyModuleEncoder';

const EMSCRIPTEN_MODULE = 'env';
const EMSCRIPTEN_GROWTH_FUNCTION = 'emscripten_notify_memory_growth';
const WASI_MODULE = 'wasi_snapshot_preview1';
// The system calls Emscripten's standalone runtime and libc pull in, which the whitelist names
const WHITELISTED_WASI_FUNCTIONS = Object.freeze([
    'args_get',
    'args_sizes_get',
    'clock_time_get',
    'environ_get',
    'environ_sizes_get',
    'fd_close',
    'fd_fdstat_get',
    'fd_read',
    'fd_seek',
    'fd_write',
    'proc_exit',
    'random_get'
]);
// System calls outside the whitelist, the older WASI module, and imports of kinds no package may import
const FILE_OPEN_FUNCTION = 'path_open';
const OLDER_WASI_MODULE = 'wasi_unstable';
const ABORT_FUNCTION = 'abort';
const OTHER_MEMORY_NAME = 'heap';
const JAVASCRIPT_MODULE = 'js';
const TABLE_NAME = '__indirect_function_table';
const GLOBAL_NAME = '__stack_pointer';
const TAG_NAME = '__cpp_exception';
// WASI errno values the stubs return
const WASI_SUCCESS = 0;
const WASI_BAD_DESCRIPTOR = 8;
const WASI_INVALID_SEEK = 70;
const STANDARD_OUTPUT_DESCRIPTOR = 1;
const STANDARD_INPUT_DESCRIPTOR = 0;
const EXIT_CODE = 3;
const PAGE_BYTE_LENGTH = 65_536;
const INITIAL_PAGES = 2;
const DECLARED_MAXIMUM_PAGES = 256;
const OVERSIZED_MAXIMUM_PAGES = DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES * 2;
const NEGATIVE_PAGES = -1;
const FRACTIONAL_PAGES = 1.5;
const LITTLE_ENDIAN = true;
// Pointers the system calls write through, which start out filled so a written zero shows
const FIRST_POINTER = 64;
const SECOND_POINTER = 128;
const FILLED_BYTE = 0xFF;
const FILLED_WORD = 0xFFFF_FFFF;
const RANDOM_BYTE_LENGTH = 16;
// Two iovecs of an fd_write: their pointers, and the lengths they report
const IOVEC_POINTER = 256;
const IOVEC_BYTE_LENGTH = 8;
const IOVEC_LENGTH_OFFSET = 4;
const FIRST_IOVEC_LENGTH = 5;
const SECOND_IOVEC_LENGTH = 11;
const WRITTEN_POINTER = 512;
const WIDE_TIME_BYTE_LENGTH = 8;
const CLOCK_MONOTONIC = 1;
const CLOCK_PRECISION = BigInt(1000);
// A value a module's reactor initializer stores, and where
const INITIALIZER_MARKER = 0x5EED;
const INITIALIZER_ADDRESS = 32;
const REACTOR_INITIALIZE_EXPORT = '_initialize';
const MISSING_MEMORY_MESSAGE = 'The decoder package called a system function without a memory';

type SystemFunction = (...values: unknown[]) => number | undefined;

function getSystemFunctions(memory: WebAssembly.Memory | null): Record<string, SystemFunction> {
    return createDecoderPackageImports(memory)[WASI_MODULE] as unknown as Record<string, SystemFunction>;
}

function createFilledMemory(): WebAssembly.Memory {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: INITIAL_PAGES });
    new Uint8Array(memory.buffer).fill(FILLED_BYTE);
    return memory;
}

function describeImport(module: string, name: string, kind: WebAssemblyImportDescriptor['kind']): WebAssemblyImportDescriptor {
    return { kind, module, name };
}

describe('findForbiddenDecoderPackageImport', () => {
    it('allows the engine\'s memory, the memory growth notice, and every whitelisted system call', () => {
        const imports = [
            describeImport(PACKAGE_MEMORY_IMPORT_MODULE, PACKAGE_MEMORY_IMPORT_NAME, 'memory'),
            describeImport(EMSCRIPTEN_MODULE, EMSCRIPTEN_GROWTH_FUNCTION, 'function'),
            ...WHITELISTED_WASI_FUNCTIONS.map((name: string): WebAssemblyImportDescriptor => describeImport(WASI_MODULE, name, 'function'))
        ];

        expect(findForbiddenDecoderPackageImport(imports)).toBeNull();
        expect(findForbiddenDecoderPackageImport([])).toBeNull();
    });

    it.each([
        { descriptor: describeImport(WASI_MODULE, FILE_OPEN_FUNCTION, 'function'), detail: `${WASI_MODULE}.${FILE_OPEN_FUNCTION} function` },
        { descriptor: describeImport(OLDER_WASI_MODULE, WHITELISTED_WASI_FUNCTIONS[0], 'function'), detail: `${OLDER_WASI_MODULE}.${WHITELISTED_WASI_FUNCTIONS[0]} function` },
        { descriptor: describeImport(EMSCRIPTEN_MODULE, ABORT_FUNCTION, 'function'), detail: `${EMSCRIPTEN_MODULE}.${ABORT_FUNCTION} function` },
        { descriptor: describeImport(WASI_MODULE, EMSCRIPTEN_GROWTH_FUNCTION, 'function'), detail: `${WASI_MODULE}.${EMSCRIPTEN_GROWTH_FUNCTION} function` },
        { descriptor: describeImport(PACKAGE_MEMORY_IMPORT_MODULE, OTHER_MEMORY_NAME, 'memory'), detail: `${PACKAGE_MEMORY_IMPORT_MODULE}.${OTHER_MEMORY_NAME} memory` },
        { descriptor: describeImport(JAVASCRIPT_MODULE, PACKAGE_MEMORY_IMPORT_NAME, 'memory'), detail: `${JAVASCRIPT_MODULE}.${PACKAGE_MEMORY_IMPORT_NAME} memory` },
        { descriptor: describeImport(EMSCRIPTEN_MODULE, TABLE_NAME, 'table'), detail: `${EMSCRIPTEN_MODULE}.${TABLE_NAME} table` },
        { descriptor: describeImport(EMSCRIPTEN_MODULE, GLOBAL_NAME, 'global'), detail: `${EMSCRIPTEN_MODULE}.${GLOBAL_NAME} global` },
        { descriptor: describeImport(EMSCRIPTEN_MODULE, TAG_NAME, 'tag'), detail: `${EMSCRIPTEN_MODULE}.${TAG_NAME} tag` }
    ])('forbids $detail', ({ descriptor, detail }) => {
        expect(findForbiddenDecoderPackageImport([ describeImport(PACKAGE_MEMORY_IMPORT_MODULE, PACKAGE_MEMORY_IMPORT_NAME, 'memory'), descriptor ]))
            .toBe(detail);
    });

    it('names the first forbidden import', () => {
        expect(findForbiddenDecoderPackageImport([
            describeImport(EMSCRIPTEN_MODULE, ABORT_FUNCTION, 'function'),
            describeImport(EMSCRIPTEN_MODULE, TABLE_NAME, 'table')
        ])).toBe(`${EMSCRIPTEN_MODULE}.${ABORT_FUNCTION} function`);
    });

    it('refuses the engine\'s memory imported twice', () => {
        const memoryImport = describeImport(PACKAGE_MEMORY_IMPORT_MODULE, PACKAGE_MEMORY_IMPORT_NAME, 'memory');

        expect(findForbiddenDecoderPackageImport([ memoryImport, memoryImport ]))
            .toBe(`${PACKAGE_MEMORY_IMPORT_MODULE}.${PACKAGE_MEMORY_IMPORT_NAME} memory repeated`);
    });
});

describe('boundDecoderPackageMemory', () => {
    it('keeps a declared maximum within the bound, and bounds a larger or missing one', () => {
        expect(boundDecoderPackageMemory({ initialPages: INITIAL_PAGES, maximumPages: DECLARED_MAXIMUM_PAGES, shared: false, wide: false }))
            .toEqual({ kind: 'bounded', limits: { initialPages: INITIAL_PAGES, maximumPages: DECLARED_MAXIMUM_PAGES } });
        expect(boundDecoderPackageMemory({ initialPages: INITIAL_PAGES, maximumPages: OVERSIZED_MAXIMUM_PAGES, shared: false, wide: false }))
            .toEqual({ kind: 'bounded', limits: { initialPages: INITIAL_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } });
        expect(boundDecoderPackageMemory({ initialPages: INITIAL_PAGES, maximumPages: null, shared: false, wide: false }))
            .toEqual({ kind: 'bounded', limits: { initialPages: INITIAL_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } });
    });

    it('allows a memory that starts at the bound, and refuses one that starts past it', () => {
        expect(boundDecoderPackageMemory({ initialPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES, maximumPages: null, shared: false, wide: false }))
            .toEqual({ kind: 'bounded', limits: { initialPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } });
        expect(boundDecoderPackageMemory({ initialPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES + 1, maximumPages: null, shared: false, wide: false }))
            .toEqual({ detail: `${DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES + 1} initial pages > ${DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES}`, kind: 'unbounded' });
    });

    it('refuses a 64-bit memory and a shared one, which it cannot bound', () => {
        expect(boundDecoderPackageMemory({ initialPages: 0, maximumPages: null, shared: false, wide: true })).toEqual({ detail: 'memory64', kind: 'unbounded' });
        expect(boundDecoderPackageMemory({ initialPages: 0, maximumPages: null, shared: true, wide: true })).toEqual({ detail: 'memory64', kind: 'unbounded' });
        expect(boundDecoderPackageMemory({ initialPages: INITIAL_PAGES, maximumPages: DECLARED_MAXIMUM_PAGES, shared: true, wide: false }))
            .toEqual({ detail: 'shared memory', kind: 'unbounded' });
    });
});

describe('isDecoderPackageMemoryLimits', () => {
    it('accepts whole page counts that start within a maximum the engine allows', () => {
        expect(isDecoderPackageMemoryLimits({ initialPages: INITIAL_PAGES, maximumPages: DECLARED_MAXIMUM_PAGES })).toBe(true);
        expect(isDecoderPackageMemoryLimits({ initialPages: 0, maximumPages: 0 })).toBe(true);
        expect(isDecoderPackageMemoryLimits({ initialPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES })).toBe(true);
    });

    it.each([
        { subject: 'a maximum past the engine\'s bound', value: { initialPages: INITIAL_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES + 1 } },
        { subject: 'a start past the maximum', value: { initialPages: DECLARED_MAXIMUM_PAGES, maximumPages: INITIAL_PAGES } },
        { subject: 'negative pages', value: { initialPages: NEGATIVE_PAGES, maximumPages: DECLARED_MAXIMUM_PAGES } },
        { subject: 'fractional pages', value: { initialPages: FRACTIONAL_PAGES, maximumPages: DECLARED_MAXIMUM_PAGES } },
        { subject: 'pages as text', value: { initialPages: String(INITIAL_PAGES), maximumPages: DECLARED_MAXIMUM_PAGES } },
        { subject: 'a missing maximum', value: { initialPages: INITIAL_PAGES } },
        { subject: 'no limits', value: null }
    ])('refuses $subject', ({ value }) => {
        expect(isDecoderPackageMemoryLimits(value)).toBe(false);
    });
});

describe('createDecoderPackageMemory', () => {
    it('creates a memory of the initial pages that grows to the maximum and no further', () => {
        const memory = createDecoderPackageMemory({ initialPages: 1, maximumPages: INITIAL_PAGES });

        expect(memory?.buffer.byteLength).toBe(PAGE_BYTE_LENGTH);
        memory?.grow(INITIAL_PAGES - 1);
        expect(memory?.buffer.byteLength).toBe(INITIAL_PAGES * PAGE_BYTE_LENGTH);
        expect(() => memory?.grow(1)).toThrow(RangeError);
    });

    it('creates no memory for a module that imports none', () => {
        expect(createDecoderPackageMemory(null)).toBeNull();
    });
});

describe('createDecoderPackageImports', () => {
    it('hands over the memory only to a module that imports one, and notices growth without acting', () => {
        const memory = createFilledMemory();
        const environment = createDecoderPackageImports(memory)[EMSCRIPTEN_MODULE] as Record<string, unknown>;
        const environmentWithoutMemory = createDecoderPackageImports(null)[EMSCRIPTEN_MODULE] as Record<string, unknown>;

        expect(environment[PACKAGE_MEMORY_IMPORT_NAME]).toBe(memory);
        expect(environmentWithoutMemory).not.toHaveProperty(PACKAGE_MEMORY_IMPORT_NAME);
        expect((environment[EMSCRIPTEN_GROWTH_FUNCTION] as () => unknown)()).toBeUndefined();
    });

    it('provides every whitelisted system call', () => {
        expect(new Set(Object.keys(getSystemFunctions(null)))).toEqual(new Set(WHITELISTED_WASI_FUNCTIONS));
    });

    it('reports empty arguments and environment, writing zero counts and sizes', () => {
        const memory = createFilledMemory();
        const systemFunctions = getSystemFunctions(memory);
        const view = new DataView(memory.buffer);

        expect(systemFunctions.args_sizes_get(FIRST_POINTER, SECOND_POINTER)).toBe(WASI_SUCCESS);
        expect([ view.getUint32(FIRST_POINTER, LITTLE_ENDIAN), view.getUint32(SECOND_POINTER, LITTLE_ENDIAN) ]).toEqual([ 0, 0 ]);
        new Uint8Array(memory.buffer).fill(FILLED_BYTE);
        expect(systemFunctions.environ_sizes_get(FIRST_POINTER, SECOND_POINTER)).toBe(WASI_SUCCESS);
        expect([ view.getUint32(FIRST_POINTER, LITTLE_ENDIAN), view.getUint32(SECOND_POINTER, LITTLE_ENDIAN) ]).toEqual([ 0, 0 ]);
        expect(systemFunctions.args_get(FIRST_POINTER, SECOND_POINTER)).toBe(WASI_SUCCESS);
        expect(systemFunctions.environ_get(FIRST_POINTER, SECOND_POINTER)).toBe(WASI_SUCCESS);
    });

    it('reads the clock as zero and randomness as zero bytes', () => {
        const memory = createFilledMemory();
        const systemFunctions = getSystemFunctions(memory);

        expect(systemFunctions.clock_time_get(CLOCK_MONOTONIC, CLOCK_PRECISION, FIRST_POINTER)).toBe(WASI_SUCCESS);
        expect(new DataView(memory.buffer).getBigUint64(FIRST_POINTER, LITTLE_ENDIAN)).toBe(BigInt(0));
        expect(new Uint8Array(memory.buffer, FIRST_POINTER + WIDE_TIME_BYTE_LENGTH, 1)[0]).toBe(FILLED_BYTE);
        expect(systemFunctions.random_get(SECOND_POINTER, RANDOM_BYTE_LENGTH)).toBe(WASI_SUCCESS);
        expect([ ...new Uint8Array(memory.buffer, SECOND_POINTER, RANDOM_BYTE_LENGTH) ]).toEqual(new Array(RANDOM_BYTE_LENGTH).fill(0));
        expect(new Uint8Array(memory.buffer, SECOND_POINTER + RANDOM_BYTE_LENGTH, 1)[0]).toBe(FILLED_BYTE);
    });

    it('sinks every write, reporting each byte written, through the memory as it has grown', () => {
        const memory = createFilledMemory();
        const systemFunctions = getSystemFunctions(memory);
        memory.grow(1);
        // The iovecs and the written count lie in the page the memory grew by
        const iovecPointer = PAGE_BYTE_LENGTH + IOVEC_POINTER;
        const writtenPointer = PAGE_BYTE_LENGTH + WRITTEN_POINTER;
        const view = new DataView(memory.buffer);
        view.setUint32(iovecPointer + IOVEC_LENGTH_OFFSET, FIRST_IOVEC_LENGTH, LITTLE_ENDIAN);
        view.setUint32(iovecPointer + IOVEC_BYTE_LENGTH + IOVEC_LENGTH_OFFSET, SECOND_IOVEC_LENGTH, LITTLE_ENDIAN);
        view.setUint32(writtenPointer, FILLED_WORD, LITTLE_ENDIAN);

        expect(systemFunctions.fd_write(STANDARD_OUTPUT_DESCRIPTOR, iovecPointer, 2, writtenPointer)).toBe(WASI_SUCCESS);
        expect(new DataView(memory.buffer).getUint32(writtenPointer, LITTLE_ENDIAN)).toBe(FIRST_IOVEC_LENGTH + SECOND_IOVEC_LENGTH);
    });

    it('has no descriptor to read, seek, or describe, and closes any', () => {
        const systemFunctions = getSystemFunctions(createFilledMemory());

        expect(systemFunctions.fd_read(STANDARD_INPUT_DESCRIPTOR, IOVEC_POINTER, 1, WRITTEN_POINTER)).toBe(WASI_BAD_DESCRIPTOR);
        expect(systemFunctions.fd_seek(STANDARD_OUTPUT_DESCRIPTOR, BigInt(0), 0, WRITTEN_POINTER)).toBe(WASI_INVALID_SEEK);
        expect(systemFunctions.fd_fdstat_get(STANDARD_OUTPUT_DESCRIPTOR, WRITTEN_POINTER)).toBe(WASI_BAD_DESCRIPTOR);
        expect(systemFunctions.fd_close(STANDARD_OUTPUT_DESCRIPTOR)).toBe(WASI_SUCCESS);
    });

    it('traps an exit with its code', () => {
        expect(() => getSystemFunctions(createFilledMemory()).proc_exit(EXIT_CODE)).toThrow(`decoder package exited with code ${EXIT_CODE}`);
    });

    it('refuses a system call that writes memory from a module that imports none', () => {
        const systemFunctions = getSystemFunctions(null);

        expect(() => systemFunctions.args_sizes_get(FIRST_POINTER, SECOND_POINTER)).toThrow(new RangeError(MISSING_MEMORY_MESSAGE));
        expect(() => systemFunctions.fd_write(STANDARD_OUTPUT_DESCRIPTOR, IOVEC_POINTER, 1, WRITTEN_POINTER)).toThrow(MISSING_MEMORY_MESSAGE);
        expect(() => systemFunctions.random_get(FIRST_POINTER, RANDOM_BYTE_LENGTH)).toThrow(MISSING_MEMORY_MESSAGE);
        expect(() => systemFunctions.clock_time_get(CLOCK_MONOTONIC, CLOCK_PRECISION, FIRST_POINTER)).toThrow(MISSING_MEMORY_MESSAGE);
    });
});

describe('instantiateDecoderPackage', () => {
    it('links a module that imports every allowed import', async () => {
        const imports: WebAssemblyImportDefinition[] = [
            createMemoryImport(),
            { kind: 'function', module: EMSCRIPTEN_MODULE, name: EMSCRIPTEN_GROWTH_FUNCTION, parameters: [ 'i32' ] },
            ...WHITELISTED_WASI_FUNCTIONS.map((name: string): WebAssemblyImportDefinition => ({ kind: 'function', module: WASI_MODULE, name, results: [ 'i32' ] }))
        ];
        const module = new WebAssembly.Module(encodeWebAssemblyModule({ imports }));

        const { memory } = await instantiateDecoderPackage(module, { initialPages: 1, maximumPages: INITIAL_PAGES });

        expect(memory?.buffer.byteLength).toBe(PAGE_BYTE_LENGTH);
    });

    it('runs a reactor\'s initializer first, against the memory it creates for the instance', async () => {
        const module = new WebAssembly.Module(encodeWebAssemblyModule({
            functions: [ { body: [ ...encodeI32Const(INITIALIZER_ADDRESS), ...encodeI32Const(INITIALIZER_MARKER), ...encodeI32Store() ], name: REACTOR_INITIALIZE_EXPORT } ],
            imports: [ createMemoryImport() ]
        }));

        const first = await instantiateDecoderPackage(module, { initialPages: 1, maximumPages: INITIAL_PAGES });
        const second = await instantiateDecoderPackage(module, { initialPages: 1, maximumPages: INITIAL_PAGES });

        expect(second.memory).not.toBe(first.memory);
        for (const { memory } of [ first, second ]) {
            expect(new DataView((memory as WebAssembly.Memory).buffer).getUint32(INITIALIZER_ADDRESS, LITTLE_ENDIAN)).toBe(INITIALIZER_MARKER);
        }
    });

    it('instantiates a module without a memory, as a package without code has', async () => {
        const { instance, memory } = await instantiateDecoderPackage(new WebAssembly.Module(encodeWebAssemblyModule({})), null);

        expect(memory).toBeNull();
        expect(Object.keys(instance.exports)).toEqual([]);
    });
});
