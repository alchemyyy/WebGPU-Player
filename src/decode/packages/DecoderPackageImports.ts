// What a decoder package's module may import, and the engine's implementations of it: the memory the engine bounds, and inert system calls.
// A package carries no JavaScript, so these imports are everything its code can reach outside its own memory.
// Emscripten's standalone runtime and libc pull in the WASI calls; none of them reaches a file, a clock, or the network.
import type { WebAssemblyImportDescriptor, WebAssemblyMemoryLimits } from './DecoderPackageBinary';

/** The memory a package instance gets: the pages it declares at first, growing to the engine's bound at most. */
export type DecoderPackageMemoryLimits = Readonly<{
    initialPages: number
    maximumPages: number
}>;

/** The most memory one package instance may reach: 1 GiB, a fraction of the 4 GiB a wasm32 module addresses. */
export const DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES = 16_384;

const MEMORY_MODULE = 'env';
const MEMORY_NAME = 'memory';
const EMSCRIPTEN_MODULE = 'env';
const WASI_MODULE = 'wasi_snapshot_preview1';
// WASI errno values
const WASI_SUCCESS = 0;
const WASI_BAD_DESCRIPTOR = 8;
const WASI_INVALID_SEEK = 70;
// An iovec is a pointer and a length, both u32
const IOVEC_BYTE_LENGTH = 8;
const IOVEC_LENGTH_OFFSET = 4;
const LITTLE_ENDIAN = true;
// The export of a WASI reactor that runs its constructors
const REACTOR_INITIALIZE_EXPORT = '_initialize';

const EMSCRIPTEN_FUNCTIONS: readonly string[] = Object.freeze([ 'emscripten_notify_memory_growth' ]);
const WASI_FUNCTIONS: readonly string[] = Object.freeze([
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

/** A module's import that no package may declare: the detail names it. */
export function findForbiddenDecoderPackageImport(imports: readonly WebAssemblyImportDescriptor[]): string | null {
    let memoryImported = false;
    for (const descriptor of imports) {
        const name = `${descriptor.module}.${descriptor.name}`;
        switch (descriptor.kind) {
            case 'memory':
                if (descriptor.module !== MEMORY_MODULE || descriptor.name !== MEMORY_NAME) {
                    return `${name} memory`;
                }
                // The engine bounds one memory, and a second import's limits could refuse the memory it creates
                if (memoryImported) {
                    return `${name} memory repeated`;
                }
                memoryImported = true;
                break;
            case 'function':
                if (!(descriptor.module === EMSCRIPTEN_MODULE && EMSCRIPTEN_FUNCTIONS.includes(descriptor.name))
                    && !(descriptor.module === WASI_MODULE && WASI_FUNCTIONS.includes(descriptor.name))) {
                    return `${name} function`;
                }
                break;
            default:
                return `${name} ${descriptor.kind}`;
        }
    }
    return null;
}

/** The memory the engine gives a package's instances, or a terse detail of why it cannot bound the memory the module declares. */
export type DecoderPackageMemoryBound =
    | Readonly<{ kind: 'bounded'; limits: DecoderPackageMemoryLimits }>
    | Readonly<{ detail: string; kind: 'unbounded' }>;

function unboundedMemory(detail: string): DecoderPackageMemoryBound {
    return { detail, kind: 'unbounded' };
}

/** Bounds a module's declared memory; the engine's maximum replaces a larger declared one, which the module still links against. */
export function boundDecoderPackageMemory(limits: WebAssemblyMemoryLimits): DecoderPackageMemoryBound {
    if (limits.wide) {
        return unboundedMemory('memory64');
    }
    if (limits.shared) {
        return unboundedMemory('shared memory');
    }
    if (limits.initialPages > DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES) {
        return unboundedMemory(`${limits.initialPages} initial pages > ${DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES}`);
    }
    const maximumPages = Math.min(limits.maximumPages ?? DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES, DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES);
    return { kind: 'bounded', limits: { initialPages: limits.initialPages, maximumPages } };
}

/** Validates memory limits that crossed a worker boundary: whole page counts, the initial one within the maximum, and the maximum within the engine's bound. */
export function isDecoderPackageMemoryLimits(value: unknown): value is DecoderPackageMemoryLimits {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const { initialPages, maximumPages } = value as Record<string, unknown>;
    return Number.isSafeInteger(initialPages)
        && Number.isSafeInteger(maximumPages)
        && Number(initialPages) >= 0
        && Number(initialPages) <= Number(maximumPages)
        && Number(maximumPages) <= DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES;
}

/** Writes a u32 into the instance's memory, through a view taken now, since the memory may have grown. */
function writeU32(memory: WebAssembly.Memory, pointer: number, value: number): void {
    new DataView(memory.buffer).setUint32(pointer, value, LITTLE_ENDIAN);
}

/** Discards a write, as every descriptor is a sink, and reports every byte written. */
function writeDiscarded(memory: WebAssembly.Memory, iovecPointer: number, iovecCount: number, writtenPointer: number): number {
    const view = new DataView(memory.buffer);
    let byteLength = 0;
    for (let iovecIndex = 0; iovecIndex < iovecCount; iovecIndex += 1) {
        byteLength += view.getUint32(iovecPointer + iovecIndex * IOVEC_BYTE_LENGTH + IOVEC_LENGTH_OFFSET, LITTLE_ENDIAN);
    }
    view.setUint32(writtenPointer, byteLength, LITTLE_ENDIAN);
    return WASI_SUCCESS;
}

/**
 * Returns the import object of one package instance: its memory, when it imports one, and the inert system calls.
 * Output goes nowhere, input is empty, the clock reads zero, randomness is zero bytes, and exit traps the call.
 */
export function createDecoderPackageImports(memory: WebAssembly.Memory | null): WebAssembly.Imports {
    const requireMemory = (): WebAssembly.Memory => {
        if (!memory) {
            throw new RangeError('The decoder package called a system function without a memory');
        }
        return memory;
    };
    const writeZeroPair = (firstPointer: number, secondPointer: number): number => {
        const instanceMemory = requireMemory();
        writeU32(instanceMemory, firstPointer, 0);
        writeU32(instanceMemory, secondPointer, 0);
        return WASI_SUCCESS;
    };
    /* eslint-disable @typescript-eslint/naming-convention -- WASI and Emscripten name these imports */
    const wasi: Record<string, (...values: never[]) => number | undefined> = {
        args_get: (): number => WASI_SUCCESS,
        args_sizes_get: writeZeroPair,
        clock_time_get: (_clock: number, _precision: bigint, timePointer: number): number => {
            new DataView(requireMemory().buffer).setBigUint64(timePointer, BigInt(0), LITTLE_ENDIAN);
            return WASI_SUCCESS;
        },
        environ_get: (): number => WASI_SUCCESS,
        environ_sizes_get: writeZeroPair,
        fd_close: (): number => WASI_SUCCESS,
        fd_fdstat_get: (): number => WASI_BAD_DESCRIPTOR,
        fd_read: (): number => WASI_BAD_DESCRIPTOR,
        fd_seek: (): number => WASI_INVALID_SEEK,
        fd_write: (_descriptor: number, iovecPointer: number, iovecCount: number, writtenPointer: number): number =>
            writeDiscarded(requireMemory(), iovecPointer, iovecCount, writtenPointer),
        proc_exit: (code: number): never => {
            throw new Error(`decoder package exited with code ${code}`);
        },
        random_get: (pointer: number, byteLength: number): number => {
            new Uint8Array(requireMemory().buffer, pointer, byteLength).fill(0);
            return WASI_SUCCESS;
        }
    };
    const environment: Record<string, unknown> = {
        emscripten_notify_memory_growth: (): void => undefined
    };
    /* eslint-enable @typescript-eslint/naming-convention */
    if (memory) {
        environment[MEMORY_NAME] = memory;
    }
    return { [EMSCRIPTEN_MODULE]: environment, [WASI_MODULE]: wasi } as WebAssembly.Imports;
}

/** Creates the memory one package instance links against, or null for a module that imports none. */
export function createDecoderPackageMemory(limits: DecoderPackageMemoryLimits | null): WebAssembly.Memory | null {
    return limits ? new WebAssembly.Memory({ initial: limits.initialPages, maximum: limits.maximumPages }) : null;
}

/**
 * Instantiates a package's module with its own bounded memory and the inert system calls.
 * A WASI reactor's `_initialize` runs first, as it sets up the C runtime's heap before any other export.
 */
export async function instantiateDecoderPackage(
    module: WebAssembly.Module,
    memoryLimits: DecoderPackageMemoryLimits | null
): Promise<{ instance: WebAssembly.Instance; memory: WebAssembly.Memory | null }> {
    const memory = createDecoderPackageMemory(memoryLimits);
    const instance = await WebAssembly.instantiate(module, createDecoderPackageImports(memory));
    const initialize = instance.exports[REACTOR_INITIALIZE_EXPORT];
    if (typeof initialize === 'function') {
        (initialize as () => void)();
    }
    return { instance, memory };
}
