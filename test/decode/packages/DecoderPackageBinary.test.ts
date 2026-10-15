import { describe, expect, it } from 'vitest';

import { readWebAssemblyBinaryFacts, WebAssemblyBinaryError } from 'webgpu-player/decode/packages/DecoderPackageBinary';

import {
    encodeLimits,
    encodeUnsignedLEB128,
    encodeWebAssemblyModule,
    toArrayBuffer,
    type WebAssemblyImportDefinition
} from '../../helpers/webAssemblyModuleEncoder';

const MEMORY_MODULE = 'env';
const MEMORY_NAME = 'memory';
const WASI_MODULE = 'wasi_snapshot_preview1';
const WASI_WRITE_FUNCTION = 'fd_write';
const TABLE_NAME = 'table';
const GLOBAL_NAME = 'stackPointer';
const TAG_NAME = 'exception';
const INITIAL_PAGES = 4;
const MAXIMUM_PAGES = 64;
// A 64-bit memory's limits, whose values the reader skips; the maximum needs more than five LEB128 bytes
const WIDE_INITIAL_PAGES = 1;
const WIDE_MAXIMUM_PAGES = 2 ** 40;
const MODULE_HEADER = Object.freeze([ 0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00 ]);
const MODULE_HEADER_BYTE_LENGTH = MODULE_HEADER.length;
const IMPORT_SECTION_ID = 2;
const MEMORY_SECTION_ID = 5;
const MEMORY_IMPORT_KIND = 0x02;
const GLOBAL_IMPORT_KIND = 0x03;
const TABLE_IMPORT_KIND = 0x01;
// A kind past the tag, the last one the reader knows
const UNKNOWN_IMPORT_KIND = 0x05;
// Typed reference types: a non-nullable and a nullable reference to the func heap type
const NON_NULLABLE_REFERENCE_TYPE = 0x64;
const NULLABLE_REFERENCE_TYPE = 0x63;
const FUNC_HEAP_TYPE = 0x70;
const IMMUTABLE_GLOBAL = 0x00;
const EMPTY_TABLE_LIMITS = Object.freeze([ 0x00, 0x00 ]);
// A section size whose LEB128 never ends within five bytes
const OVERLONG_U32 = Object.freeze([ 0x80, 0x80, 0x80, 0x80, 0x80 ]);
// A section that declares more bytes than the binary has
const OVERSIZED_SECTION_BYTE_LENGTH = 16;
// A name that declares more bytes than its section has
const OVERSIZED_NAME_BYTE_LENGTH = 5;
const NOT_WEBASSEMBLY = Object.freeze([ 0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01, 0x01, 0x00 ]);
const TRUNCATED_MAGIC = Object.freeze([ 0x00, 0x61, 0x73 ]);

function encodeName(name: string): number[] {
    const bytes = new TextEncoder().encode(name);
    return [ ...encodeUnsignedLEB128(bytes.byteLength), ...bytes ];
}

/** Returns a binary of the module header and the given section bytes, which may be malformed. */
function createBinary(sectionBytes: readonly number[]): ArrayBuffer {
    return Uint8Array.from([ ...MODULE_HEADER, ...sectionBytes ]).buffer;
}

/** Returns an import section of raw import entries. */
function createImportSection(entries: readonly (readonly number[])[]): number[] {
    const content = [ ...encodeUnsignedLEB128(entries.length), ...entries.flat() ];
    return [ IMPORT_SECTION_ID, ...encodeUnsignedLEB128(content.length), ...content ];
}

function readFacts(imports: readonly WebAssemblyImportDefinition[]): ReturnType<typeof readWebAssemblyBinaryFacts> {
    return readWebAssemblyBinaryFacts(toArrayBuffer(encodeWebAssemblyModule({ imports })));
}

function captureBinaryError(binary: ArrayBuffer): unknown {
    try {
        readWebAssemblyBinaryFacts(binary);
    } catch (error) {
        return error;
    }
    return null;
}

describe('readWebAssemblyBinaryFacts', () => {
    it('reads every import with its kind, and the memory import\'s limits', () => {
        const facts = readFacts([
            { kind: 'function', module: WASI_MODULE, name: WASI_WRITE_FUNCTION, parameters: [ 'i32', 'i32', 'i32', 'i32' ], results: [ 'i32' ] },
            { kind: 'table', module: MEMORY_MODULE, name: TABLE_NAME },
            { kind: 'memory', limits: { initialPages: INITIAL_PAGES, maximumPages: MAXIMUM_PAGES }, module: MEMORY_MODULE, name: MEMORY_NAME },
            { kind: 'global', module: MEMORY_MODULE, name: GLOBAL_NAME },
            { kind: 'tag', module: MEMORY_MODULE, name: TAG_NAME }
        ]);

        expect(facts).toEqual({
            definesMemory: false,
            imports: [
                { kind: 'function', module: WASI_MODULE, name: WASI_WRITE_FUNCTION },
                { kind: 'table', module: MEMORY_MODULE, name: TABLE_NAME },
                { kind: 'memory', module: MEMORY_MODULE, name: MEMORY_NAME },
                { kind: 'global', module: MEMORY_MODULE, name: GLOBAL_NAME },
                { kind: 'tag', module: MEMORY_MODULE, name: TAG_NAME }
            ],
            memoryImport: { initialPages: INITIAL_PAGES, maximumPages: MAXIMUM_PAGES, shared: false, wide: false }
        });
    });

    it('reads a memory import without a maximum, and a shared one', () => {
        expect(readFacts([ { kind: 'memory', limits: { initialPages: INITIAL_PAGES }, module: MEMORY_MODULE, name: MEMORY_NAME } ]).memoryImport)
            .toEqual({ initialPages: INITIAL_PAGES, maximumPages: null, shared: false, wide: false });
        expect(readFacts([
            { kind: 'memory', limits: { initialPages: INITIAL_PAGES, maximumPages: MAXIMUM_PAGES, shared: true }, module: MEMORY_MODULE, name: MEMORY_NAME }
        ]).memoryImport).toEqual({ initialPages: INITIAL_PAGES, maximumPages: MAXIMUM_PAGES, shared: true, wide: false });
    });

    it('flags a 64-bit memory import without reading its limits, and reads the imports after it', () => {
        const facts = readFacts([
            { kind: 'memory', limits: { initialPages: WIDE_INITIAL_PAGES, maximumPages: WIDE_MAXIMUM_PAGES, wide: true }, module: MEMORY_MODULE, name: MEMORY_NAME },
            { kind: 'function', module: WASI_MODULE, name: WASI_WRITE_FUNCTION }
        ]);

        expect(facts.memoryImport).toEqual({ initialPages: 0, maximumPages: null, shared: false, wide: true });
        expect(facts.imports.at(-1)).toEqual({ kind: 'function', module: WASI_MODULE, name: WASI_WRITE_FUNCTION });
    });

    it('skips the heap type of a typed reference global or table, and reads the imports after them', () => {
        const binary = createBinary(createImportSection([
            [ ...encodeName(MEMORY_MODULE), ...encodeName(GLOBAL_NAME), GLOBAL_IMPORT_KIND, NON_NULLABLE_REFERENCE_TYPE, FUNC_HEAP_TYPE, IMMUTABLE_GLOBAL ],
            [ ...encodeName(MEMORY_MODULE), ...encodeName(TABLE_NAME), TABLE_IMPORT_KIND, NULLABLE_REFERENCE_TYPE, FUNC_HEAP_TYPE, ...EMPTY_TABLE_LIMITS ],
            [ ...encodeName(MEMORY_MODULE), ...encodeName(MEMORY_NAME), MEMORY_IMPORT_KIND, ...encodeLimits({ initialPages: INITIAL_PAGES }) ]
        ]));

        expect(readWebAssemblyBinaryFacts(binary)).toEqual({
            definesMemory: false,
            imports: [
                { kind: 'global', module: MEMORY_MODULE, name: GLOBAL_NAME },
                { kind: 'table', module: MEMORY_MODULE, name: TABLE_NAME },
                { kind: 'memory', module: MEMORY_MODULE, name: MEMORY_NAME }
            ],
            memoryImport: { initialPages: INITIAL_PAGES, maximumPages: null, shared: false, wide: false }
        });
    });

    it('tells a module that defines a memory from one with an empty memory section and one without imports', () => {
        expect(readWebAssemblyBinaryFacts(toArrayBuffer(encodeWebAssemblyModule({ memory: { initialPages: INITIAL_PAGES } })))).toEqual({
            definesMemory: true,
            imports: [],
            memoryImport: null
        });
        expect(readWebAssemblyBinaryFacts(createBinary([ MEMORY_SECTION_ID, 1, 0 ])).definesMemory).toBe(false);
        expect(readWebAssemblyBinaryFacts(createBinary([]))).toEqual({ definesMemory: false, imports: [], memoryImport: null });
    });

    it.each([
        { binary: Uint8Array.from(NOT_WEBASSEMBLY).buffer, detail: 'no WebAssembly magic', subject: 'another format' },
        { binary: Uint8Array.from(TRUNCATED_MAGIC).buffer, detail: 'no WebAssembly magic', subject: 'a truncated header' },
        {
            binary: createBinary([ IMPORT_SECTION_ID, OVERSIZED_SECTION_BYTE_LENGTH ]),
            detail: `section ${IMPORT_SECTION_ID} runs past the binary`,
            subject: 'a section longer than the binary'
        },
        {
            binary: createBinary([ IMPORT_SECTION_ID, ...OVERLONG_U32 ]),
            detail: `u32 at ${MODULE_HEADER_BYTE_LENGTH + 1 + OVERLONG_U32.length} runs past five bytes`,
            subject: 'a section size past five LEB128 bytes'
        },
        {
            binary: createBinary([ IMPORT_SECTION_ID ]),
            detail: `byte ${MODULE_HEADER_BYTE_LENGTH + 1} past the end`,
            subject: 'a section without its size'
        },
        {
            binary: createBinary([ IMPORT_SECTION_ID, 3, 1, OVERSIZED_NAME_BYTE_LENGTH, 0x65 ]),
            detail: `name at ${MODULE_HEADER_BYTE_LENGTH + 4} runs past its section`,
            subject: 'an import name longer than its section'
        },
        {
            binary: createBinary(createImportSection([ [ ...encodeName(MEMORY_MODULE), ...encodeName(MEMORY_NAME), UNKNOWN_IMPORT_KIND ] ])),
            detail: `import ${MEMORY_MODULE}.${MEMORY_NAME} has kind 0x${UNKNOWN_IMPORT_KIND.toString(16)}`,
            subject: 'an import of an unknown kind'
        }
    ])('refuses $subject, naming what was malformed', ({ binary, detail }) => {
        const error = captureBinaryError(binary);

        expect(error).toBeInstanceOf(WebAssemblyBinaryError);
        expect(error).toMatchObject({ message: detail, name: 'WebAssemblyBinaryError' });
    });
});
