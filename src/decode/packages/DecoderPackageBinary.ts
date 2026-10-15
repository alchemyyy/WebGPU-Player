// Reads the parts of a WebAssembly binary that the JavaScript API does not reflect: a memory import's limits, and whether the module defines a memory of its own.
// The engine gives each instance of a decoder package the memory it imports, so it needs the declared limits to create one the module links against.

const MAGIC = Object.freeze([ 0x00, 0x61, 0x73, 0x6D ]);
const HEADER_BYTE_LENGTH = 8;
const IMPORT_SECTION_ID = 2;
const MEMORY_SECTION_ID = 5;
// Import kinds
const FUNCTION_IMPORT = 0x00;
const TABLE_IMPORT = 0x01;
const MEMORY_IMPORT = 0x02;
const GLOBAL_IMPORT = 0x03;
const TAG_IMPORT = 0x04;
// Limits flags: bit 0 a maximum follows, bit 1 shared, bit 2 64-bit addresses
const LIMITS_HAS_MAXIMUM = 0x01;
const LIMITS_SHARED = 0x02;
const LIMITS_64_BIT = 0x04;
const LEB128_PAYLOAD_MASK = 0x7F;
const LEB128_CONTINUATION = 0x80;
const LEB128_BITS_PER_BYTE = 7;
// A u32 needs at most five LEB128 bytes
const MAXIMUM_U32_LEB128_BYTES = 5;

/** The limits a module declares for one memory, in 64 KiB pages; a null maximum leaves growth to the host. */
export type WebAssemblyMemoryLimits = Readonly<{
    initialPages: number
    maximumPages: number | null
    shared: boolean
    wide: boolean
}>;

/** An import a module declares: its module and field name, and its kind. */
export type WebAssemblyImportDescriptor = Readonly<{
    kind: 'function' | 'global' | 'memory' | 'table' | 'tag'
    module: string
    name: string
}>;

/** What the engine needs of a module's binary beyond the JavaScript API's reflection. */
export type WebAssemblyBinaryFacts = Readonly<{
    /** Whether the module defines a memory of its own, which the engine cannot bound */
    definesMemory: boolean
    imports: readonly WebAssemblyImportDescriptor[]
    /** The limits of the module's memory import, or null when it imports none */
    memoryImport: WebAssemblyMemoryLimits | null
}>;

/** A binary the reader cannot follow: the detail names what was malformed. */
export class WebAssemblyBinaryError extends Error {
    constructor(detail: string) {
        super(detail);
        this.name = 'WebAssemblyBinaryError';
    }
}

/** A cursor over a binary's bytes that reads its LEB128 and name encodings. */
class BinaryCursor {
    position: number;
    private readonly bytes: Uint8Array;
    private readonly end: number;

    constructor(bytes: Uint8Array, start: number, end: number) {
        this.bytes = bytes;
        this.position = start;
        this.end = end;
    }

    get atEnd(): boolean {
        return this.position >= this.end;
    }

    readByte(): number {
        if (this.position >= this.end) {
            throw new WebAssemblyBinaryError(`byte ${this.position} past the end`);
        }
        const value = this.bytes[this.position];
        this.position += 1;
        return value;
    }

    readU32(): number {
        let value = 0;
        for (let byteIndex = 0; byteIndex < MAXIMUM_U32_LEB128_BYTES; byteIndex += 1) {
            const byte = this.readByte();
            value += (byte & LEB128_PAYLOAD_MASK) * (2 ** (byteIndex * LEB128_BITS_PER_BYTE));
            if ((byte & LEB128_CONTINUATION) === 0) {
                return value;
            }
        }
        throw new WebAssemblyBinaryError(`u32 at ${this.position} runs past five bytes`);
    }

    /** Skips an unsigned LEB128 of any width, as a 64-bit limit is; continuation bytes carry the rest of its value. */
    skipUnsigned(): void {
        let byte: number;
        do {
            byte = this.readByte();
        } while ((byte & LEB128_CONTINUATION) !== 0);
    }

    readName(): string {
        const byteLength = this.readU32();
        if (this.position + byteLength > this.end) {
            throw new WebAssemblyBinaryError(`name at ${this.position} runs past its section`);
        }
        // eslint-disable-next-line compat/compat -- Decoder packages load only in WebGPU browsers, which all have TextDecoder
        const name = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(this.position, this.position + byteLength));
        this.position += byteLength;
        return name;
    }

    skip(byteLength: number): void {
        this.position += byteLength;
    }
}

function readLimits(cursor: BinaryCursor): WebAssemblyMemoryLimits {
    const flags = cursor.readByte();
    const wide = (flags & LIMITS_64_BIT) !== 0;
    if (wide) {
        cursor.skipUnsigned();
        if ((flags & LIMITS_HAS_MAXIMUM) !== 0) {
            cursor.skipUnsigned();
        }
        return { initialPages: 0, maximumPages: null, shared: (flags & LIMITS_SHARED) !== 0, wide };
    }
    const initialPages = cursor.readU32();
    const maximumPages = (flags & LIMITS_HAS_MAXIMUM) === 0 ? null : cursor.readU32();
    return { initialPages, maximumPages, shared: (flags & LIMITS_SHARED) !== 0, wide };
}

/** Skips a value type, which a global import's type and a table's element type are; reference types may carry a heap type. */
function skipValueType(cursor: BinaryCursor): void {
    const typeByte = cursor.readByte();
    // 0x63 and 0x64 are the nullable and non-nullable reference type prefixes of the typed references proposal
    if (typeByte === 0x63 || typeByte === 0x64) {
        cursor.skipUnsigned();
    }
}

function readImportSection(cursor: BinaryCursor): { imports: WebAssemblyImportDescriptor[]; memoryImport: WebAssemblyMemoryLimits | null } {
    const imports: WebAssemblyImportDescriptor[] = [];
    let memoryImport: WebAssemblyMemoryLimits | null = null;
    const importCount = cursor.readU32();
    for (let importIndex = 0; importIndex < importCount; importIndex += 1) {
        const module = cursor.readName();
        const name = cursor.readName();
        const kindByte = cursor.readByte();
        switch (kindByte) {
            case FUNCTION_IMPORT:
                cursor.readU32();
                imports.push({ kind: 'function', module, name });
                break;
            case TABLE_IMPORT:
                skipValueType(cursor);
                readLimits(cursor);
                imports.push({ kind: 'table', module, name });
                break;
            case MEMORY_IMPORT:
                memoryImport = readLimits(cursor);
                imports.push({ kind: 'memory', module, name });
                break;
            case GLOBAL_IMPORT:
                skipValueType(cursor);
                cursor.readByte();
                imports.push({ kind: 'global', module, name });
                break;
            case TAG_IMPORT:
                cursor.readByte();
                cursor.readU32();
                imports.push({ kind: 'tag', module, name });
                break;
            default:
                throw new WebAssemblyBinaryError(`import ${module}.${name} has kind 0x${kindByte.toString(16)}`);
        }
    }
    return { imports, memoryImport };
}

/**
 * Reads a module binary's imports with their memory limits, and whether it defines a memory of its own.
 * Throws a WebAssemblyBinaryError for a binary it cannot follow; WebAssembly.compile has validated the rest.
 */
export function readWebAssemblyBinaryFacts(binary: ArrayBuffer): WebAssemblyBinaryFacts {
    const bytes = new Uint8Array(binary);
    if (bytes.byteLength < HEADER_BYTE_LENGTH || MAGIC.some((value: number, index: number): boolean => bytes[index] !== value)) {
        throw new WebAssemblyBinaryError('no WebAssembly magic');
    }
    const cursor = new BinaryCursor(bytes, HEADER_BYTE_LENGTH, bytes.byteLength);
    let imports: WebAssemblyImportDescriptor[] = [];
    let memoryImport: WebAssemblyMemoryLimits | null = null;
    let definesMemory = false;
    while (!cursor.atEnd) {
        const sectionId = cursor.readByte();
        const sectionByteLength = cursor.readU32();
        const sectionEnd = cursor.position + sectionByteLength;
        if (sectionEnd > bytes.byteLength) {
            throw new WebAssemblyBinaryError(`section ${sectionId} runs past the binary`);
        }
        switch (sectionId) {
            case IMPORT_SECTION_ID:
                ({ imports, memoryImport } = readImportSection(new BinaryCursor(bytes, cursor.position, sectionEnd)));
                break;
            case MEMORY_SECTION_ID:
                definesMemory = new BinaryCursor(bytes, cursor.position, sectionEnd).readU32() > 0;
                break;
            default:
                break;
        }
        cursor.skip(sectionByteLength);
    }
    return { definesMemory, imports, memoryImport };
}

