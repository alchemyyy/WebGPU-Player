// Encodes small WebAssembly modules for tests, without a toolchain: imports of every kind, a memory of the module's own, data segments,
// exported functions whose instructions the test writes, and custom sections.
// Imported functions take the first function indices, in import order, and the module's own functions follow.

/** A value type of a function signature. */
export type WebAssemblyValueType = 'i32' | 'i64';

/** A memory's limits in 64 KiB pages; a shared memory needs a maximum, and a wide one addresses 64 bits. */
export type WebAssemblyLimitsDefinition = Readonly<{
    initialPages: number
    maximumPages?: number
    shared?: boolean
    wide?: boolean
}>;

/** A memory import, with the limits the module declares for it. */
export type WebAssemblyMemoryImportDefinition = Readonly<{ kind: 'memory'; limits: WebAssemblyLimitsDefinition; module: string; name: string }>;

/** An import a test module declares; a table holds funcref, a global is an immutable i32, and a tag takes no values. */
export type WebAssemblyImportDefinition =
    | Readonly<{ kind: 'function'; module: string; name: string; parameters?: readonly WebAssemblyValueType[]; results?: readonly WebAssemblyValueType[] }>
    | Readonly<{ kind: 'global'; module: string; name: string }>
    | WebAssemblyMemoryImportDefinition
    | Readonly<{ kind: 'table'; module: string; name: string }>
    | Readonly<{ kind: 'tag'; module: string; name: string }>;

/** A function the module defines and exports under its name: its signature, and its body's instructions without the final end. */
export type WebAssemblyFunctionDefinition = Readonly<{
    body: readonly number[]
    name: string
    parameters?: readonly WebAssemblyValueType[]
    results?: readonly WebAssemblyValueType[]
}>;

/** Bytes an active data segment writes into memory 0 at instantiation. */
export type WebAssemblyDataSegmentDefinition = Readonly<{
    bytes: Uint8Array
    offset: number
}>;

/** A custom section, which follows every other section. */
export type WebAssemblyCustomSectionDefinition = Readonly<{
    name: string
    payload: Uint8Array
}>;

export type WebAssemblyModuleDefinition = Readonly<{
    customSections?: readonly WebAssemblyCustomSectionDefinition[]
    dataSegments?: readonly WebAssemblyDataSegmentDefinition[]
    functions?: readonly WebAssemblyFunctionDefinition[]
    imports?: readonly WebAssemblyImportDefinition[]
    memory?: WebAssemblyLimitsDefinition
}>;

const MAGIC = Object.freeze([ 0x00, 0x61, 0x73, 0x6D ]);
const VERSION = Object.freeze([ 0x01, 0x00, 0x00, 0x00 ]);
// Section ids, in the order a module lists them
const CUSTOM_SECTION_ID = 0;
const TYPE_SECTION_ID = 1;
const IMPORT_SECTION_ID = 2;
const FUNCTION_SECTION_ID = 3;
const MEMORY_SECTION_ID = 5;
const EXPORT_SECTION_ID = 7;
const CODE_SECTION_ID = 10;
const DATA_SECTION_ID = 11;
const FUNCTION_TYPE_FORM = 0x60;
const I32_TYPE = 0x7F;
const I64_TYPE = 0x7E;
const FUNCREF_TYPE = 0x70;
// Import and export descriptor kinds
const FUNCTION_KIND = 0x00;
const TABLE_KIND = 0x01;
const MEMORY_KIND = 0x02;
const GLOBAL_KIND = 0x03;
const TAG_KIND = 0x04;
const IMMUTABLE_GLOBAL = 0x00;
const EXCEPTION_TAG_ATTRIBUTE = 0x00;
// Limits flags: a maximum follows, the memory is shared, and its addresses are 64-bit
const LIMITS_HAS_MAXIMUM = 0x01;
const LIMITS_SHARED = 0x02;
const LIMITS_64_BIT = 0x04;
const ACTIVE_DATA_SEGMENT = 0x00;
const NO_LOCALS = 0x00;
// Instructions
const IF = 0x04;
const END = 0x0B;
const CALL = 0x10;
const LOCAL_GET = 0x20;
const I32_LOAD = 0x28;
const I32_STORE = 0x36;
const I32_CONST = 0x41;
const I32_LESS_THAN_UNSIGNED = 0x49;
const I32_ADD = 0x6A;
// The block type of a block that leaves no value
const EMPTY_BLOCK_TYPE = 0x40;
// i32.load's and i32.store's natural alignment, as the log2 of their four bytes
const I32_STORE_ALIGNMENT = 2;
const I32_LOAD_ALIGNMENT = 2;
const LEB128_PAYLOAD_MASK = 0x7F;
const LEB128_CONTINUATION = 0x80;
const LEB128_SIGN_BIT = 0x40;
const LEB128_BITS_PER_BYTE = 7;
const LEB128_RADIX = 2 ** LEB128_BITS_PER_BYTE;

/** Encodes an unsigned LEB128 of any safe integer, as limits and lengths are. */
export function encodeUnsignedLEB128(value: number): number[] {
    const bytes: number[] = [];
    let remaining = value;
    do {
        let byte = remaining % LEB128_RADIX;
        remaining = Math.floor(remaining / LEB128_RADIX);
        if (remaining > 0) {
            byte |= LEB128_CONTINUATION;
        }
        bytes.push(byte);
    } while (remaining > 0);
    return bytes;
}

/** Encodes a signed LEB128 of a 32-bit value; an unsigned word above 2^31 encodes as its two's complement. */
function encodeSignedLEB128(value: number): number[] {
    const bytes: number[] = [];
    let remaining = value | 0;
    for (;;) {
        const byte = remaining & LEB128_PAYLOAD_MASK;
        remaining >>= LEB128_BITS_PER_BYTE;
        const signBitSet = (byte & LEB128_SIGN_BIT) !== 0;
        if ((remaining === 0 && !signBitSet) || (remaining === -1 && signBitSet)) {
            bytes.push(byte);
            return bytes;
        }
        bytes.push(byte | LEB128_CONTINUATION);
    }
}

/** `i32.const value` */
export function encodeI32Const(value: number): number[] {
    return [ I32_CONST, ...encodeSignedLEB128(value) ];
}

/** `i32.store` at a constant offset from the address operand */
export function encodeI32Store(offset: number = 0): number[] {
    return [ I32_STORE, I32_STORE_ALIGNMENT, ...encodeUnsignedLEB128(offset) ];
}

/** `i32.load` at a constant offset from the address operand */
export function encodeI32Load(offset: number = 0): number[] {
    return [ I32_LOAD, I32_LOAD_ALIGNMENT, ...encodeUnsignedLEB128(offset) ];
}

/**
 * A body that returns the i32 a cursor word at cursorAddress points to, then moves the cursor to the next word while it points before lastValueAddress,
 * so successive calls return successive words, and every call past the last returns the last one.
 */
export function encodeI32SequenceBody(cursorAddress: number, lastValueAddress: number): number[] {
    return [
        // The current value stays on the stack, under the block that moves the cursor
        ...encodeI32Const(cursorAddress),
        ...encodeI32Load(),
        ...encodeI32Load(),
        ...encodeI32Const(cursorAddress),
        ...encodeI32Load(),
        ...encodeI32Const(lastValueAddress),
        I32_LESS_THAN_UNSIGNED,
        IF,
        EMPTY_BLOCK_TYPE,
        ...encodeI32Const(cursorAddress),
        ...encodeI32Const(cursorAddress),
        ...encodeI32Load(),
        ...encodeI32Const(Uint32Array.BYTES_PER_ELEMENT),
        I32_ADD,
        ...encodeI32Store(),
        END
    ];
}

/** `local.get index`, which reads a parameter */
export function encodeLocalGet(index: number): number[] {
    return [ LOCAL_GET, ...encodeUnsignedLEB128(index) ];
}

/** `call index`, where imported functions take the first indices */
export function encodeCall(functionIndex: number): number[] {
    return [ CALL, ...encodeUnsignedLEB128(functionIndex) ];
}

function encodeName(name: string): number[] {
    const bytes = new TextEncoder().encode(name);
    return [ ...encodeUnsignedLEB128(bytes.byteLength), ...bytes ];
}

function encodeVector(items: readonly (readonly number[])[]): number[] {
    return [ ...encodeUnsignedLEB128(items.length), ...items.flat() ];
}

function encodeSection(id: number, content: readonly number[]): number[] {
    return [ id, ...encodeUnsignedLEB128(content.length), ...content ];
}

function encodeValueType(valueType: WebAssemblyValueType): number {
    switch (valueType) {
        case 'i32':
            return I32_TYPE;
        case 'i64':
            return I64_TYPE;
    }
}

function encodeFunctionType(parameters: readonly WebAssemblyValueType[], results: readonly WebAssemblyValueType[]): number[] {
    return [
        FUNCTION_TYPE_FORM,
        ...encodeUnsignedLEB128(parameters.length),
        ...parameters.map(encodeValueType),
        ...encodeUnsignedLEB128(results.length),
        ...results.map(encodeValueType)
    ];
}

/** Encodes limits: their flags, the initial pages, then the maximum when one is set. */
export function encodeLimits(limits: WebAssemblyLimitsDefinition): number[] {
    let flags = 0;
    if (limits.maximumPages !== undefined) {
        flags |= LIMITS_HAS_MAXIMUM;
    }
    if (limits.shared) {
        flags |= LIMITS_SHARED;
    }
    if (limits.wide) {
        flags |= LIMITS_64_BIT;
    }
    const maximum = limits.maximumPages === undefined ? [] : encodeUnsignedLEB128(limits.maximumPages);
    return [ flags, ...encodeUnsignedLEB128(limits.initialPages), ...maximum ];
}

/** Encodes one import, adding the function type a function or tag import refers to. */
function encodeImport(definition: WebAssemblyImportDefinition, types: number[][]): number[] {
    const prefix = [ ...encodeName(definition.module), ...encodeName(definition.name) ];
    switch (definition.kind) {
        case 'function':
            types.push(encodeFunctionType(definition.parameters ?? [], definition.results ?? []));
            return [ ...prefix, FUNCTION_KIND, ...encodeUnsignedLEB128(types.length - 1) ];
        case 'table':
            return [ ...prefix, TABLE_KIND, FUNCREF_TYPE, ...encodeLimits({ initialPages: 0 }) ];
        case 'memory':
            return [ ...prefix, MEMORY_KIND, ...encodeLimits(definition.limits) ];
        case 'global':
            return [ ...prefix, GLOBAL_KIND, I32_TYPE, IMMUTABLE_GLOBAL ];
        case 'tag':
            types.push(encodeFunctionType([], []));
            return [ ...prefix, TAG_KIND, EXCEPTION_TAG_ATTRIBUTE, ...encodeUnsignedLEB128(types.length - 1) ];
    }
}

function encodeDataSegment(segment: WebAssemblyDataSegmentDefinition): number[] {
    return [ ACTIVE_DATA_SEGMENT, ...encodeI32Const(segment.offset), END, ...encodeUnsignedLEB128(segment.bytes.byteLength), ...segment.bytes ];
}

/** Returns a custom section: id 0, its byte length, its name, and its payload. */
export function encodeCustomSection(section: WebAssemblyCustomSectionDefinition): number[] {
    return encodeSection(CUSTOM_SECTION_ID, [ ...encodeName(section.name), ...section.payload ]);
}

/** Encodes a module binary from its definition, leaving out the sections it has nothing for. */
export function encodeWebAssemblyModule(definition: WebAssemblyModuleDefinition): Uint8Array<ArrayBuffer> {
    const types: number[][] = [];
    const imports = (definition.imports ?? []).map((importDefinition: WebAssemblyImportDefinition): number[] => encodeImport(importDefinition, types));
    const functions = definition.functions ?? [];
    const importedFunctionCount = (definition.imports ?? []).filter((importDefinition: WebAssemblyImportDefinition): boolean => importDefinition.kind === 'function').length;
    const functionTypeIndices: number[][] = [];
    const exports: number[][] = [];
    const bodies: number[][] = [];
    for (const [ functionIndex, functionDefinition ] of functions.entries()) {
        types.push(encodeFunctionType(functionDefinition.parameters ?? [], functionDefinition.results ?? []));
        functionTypeIndices.push(encodeUnsignedLEB128(types.length - 1));
        exports.push([ ...encodeName(functionDefinition.name), FUNCTION_KIND, ...encodeUnsignedLEB128(importedFunctionCount + functionIndex) ]);
        const code = [ NO_LOCALS, ...functionDefinition.body, END ];
        bodies.push([ ...encodeUnsignedLEB128(code.length), ...code ]);
    }
    // Sections stay separate arrays until the end, since a custom section may carry a whole decoder source
    const sections: number[][] = [ [ ...MAGIC, ...VERSION ] ];
    if (types.length > 0) {
        sections.push(encodeSection(TYPE_SECTION_ID, encodeVector(types)));
    }
    if (imports.length > 0) {
        sections.push(encodeSection(IMPORT_SECTION_ID, encodeVector(imports)));
    }
    if (functions.length > 0) {
        sections.push(encodeSection(FUNCTION_SECTION_ID, encodeVector(functionTypeIndices)));
    }
    if (definition.memory) {
        sections.push(encodeSection(MEMORY_SECTION_ID, encodeVector([ encodeLimits(definition.memory) ])));
    }
    if (functions.length > 0) {
        sections.push(encodeSection(EXPORT_SECTION_ID, encodeVector(exports)), encodeSection(CODE_SECTION_ID, encodeVector(bodies)));
    }
    const dataSegments = definition.dataSegments ?? [];
    if (dataSegments.length > 0) {
        sections.push(encodeSection(DATA_SECTION_ID, encodeVector(dataSegments.map(encodeDataSegment))));
    }
    for (const customSection of definition.customSections ?? []) {
        sections.push(encodeCustomSection(customSection));
    }
    const binary = new Uint8Array(sections.reduce((byteLength: number, section: readonly number[]): number => byteLength + section.length, 0));
    let offset = 0;
    for (const section of sections) {
        binary.set(section, offset);
        offset += section.length;
    }
    return binary;
}

/** Returns the bytes of an encoded module in an ArrayBuffer of their own, as a fetched package file arrives. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer;
}
