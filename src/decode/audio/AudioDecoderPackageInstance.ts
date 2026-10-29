// One decoder of an audio decoder package: the package's WebAssembly module decodes packets into planar 32-bit float PCM blocks.
// wgpud/include/audio_decoder_interface.h declares the interface for C modules, and the engine's book describes it.
import { getDecoderErrorName } from '../packages/DecoderHeader';
import { instantiateDecoderPackage, isDecoderPackageMemoryLimits, type DecoderPackageMemoryLimits } from '../packages/DecoderPackageImports';
import { AUDIO_DECODER_MAXIMUM_PACKET_BYTE_LENGTH, type AudioDecoderManifest } from './AudioDecoderManifest';

/** The version of the audio decoder interface the engine drives. */
export const AUDIO_DECODER_ABI_VERSION = 1;

/** The exports version 1 of the audio decoder interface requires; the module imports its memory as `env.memory`. */
export const AUDIO_DECODER_EXPORTS = Object.freeze({
    abiVersion: 'audio_decoder_abi_version',
    attribute: 'audio_decoder_attribute',
    channelCount: 'audio_decoder_channel_count',
    channelMask: 'audio_decoder_channel_mask',
    channelPointer: 'audio_decoder_channel_pointer',
    clear: 'audio_decoder_clear',
    configure: 'audio_decoder_configure',
    create: 'audio_decoder_create',
    destroy: 'audio_decoder_destroy',
    errorCode: 'audio_decoder_error_code',
    errorValue: 'audio_decoder_error_value',
    frameCount: 'audio_decoder_frame_count',
    receive: 'audio_decoder_receive',
    reserveInput: 'audio_decoder_reserve_input',
    sampleRate: 'audio_decoder_sample_rate',
    send: 'audio_decoder_send',
    setOption: 'audio_decoder_set_option',
    timestamp: 'audio_decoder_timestamp'
});

/** The export a module may add to version 1 of the interface, which the engine calls once at the end of a track. */
export const AUDIO_DECODER_OPTIONAL_EXPORTS = Object.freeze({
    drain: 'audio_decoder_drain'
});

/** What a send call reports. */
const SEND_STATUS = Object.freeze({
    accepted: 0,
    awaitingSync: 2,
    dropped: 1
});

/** What a receive call reports. */
const RECEIVE_STATUS = Object.freeze({
    none: 0,
    ready: 1
});

const SUCCESS_STATUS = 0;
// A decoded block holds at most this many frames, and a packet's blocks at most this many in all
const MAXIMUM_BLOCK_FRAME_COUNT = 1 << 16;
const MAXIMUM_CHANNEL_COUNT = 32;
// The blocks a drain may output: a decoder holds back a few frames, never a stream's worth
const MAXIMUM_DRAIN_BLOCK_COUNT = 64;

type WASMFunction = (...values: number[]) => number;

type AudioDecoderExports = Record<keyof typeof AUDIO_DECODER_EXPORTS, WASMFunction>;

/** The module, memory, and manifest an audio decoder instance needs, which the decode worker passes to its audio decode worker. */
export type AudioDecoderModuleSource = Readonly<{
    manifest: AudioDecoderManifest
    memory: DecoderPackageMemoryLimits | null
    module: WebAssembly.Module
}>;

/** One decoded block: planar PCM, its layout as a WAVE channel mask, and the codec-specific attributes the module reported, by name. */
export type AudioDecoderPackageBlock = Readonly<{
    attributes: ReadonlyMap<string, number>
    channelData: readonly Float32Array[]
    channelMask: number
    frameCount: number
    sampleRate: number
    /** The block's own timestamp in microseconds, or null to continue from the packet's timestamp */
    timestampMicroseconds: number | null
}>;

/** One packet's outcome: its blocks, or why it decoded to none. */
export type AudioDecoderPackageResult =
    | { blocks: readonly AudioDecoderPackageBlock[]; kind: 'decoded' }
    | { kind: 'awaiting-sync' }
    | { kind: 'dropped' };

/** A failed check of an audio decoder: its error code and failing value, named by its manifest. */
export class AudioDecoderPackageError extends Error {
    readonly code: number;
    readonly value: number;

    constructor(code: number, value: number, errorNames: ReadonlyMap<number, string>) {
        super(`audio decoder ${getDecoderErrorName(errorNames, code)}: ${value}`);
        this.name = 'AudioDecoderPackageError';
        this.code = code;
        this.value = value;
    }
}

/** Returns the names of the version 1 exports a module lacks, empty when it has every one. */
export function findMissingAudioDecoderExports(module: WebAssembly.Module): string[] {
    const exported = new Set(WebAssembly.Module.exports(module)
        .filter((descriptor: WebAssembly.ModuleExportDescriptor): boolean => descriptor.kind === 'function')
        .map((descriptor: WebAssembly.ModuleExportDescriptor): string => descriptor.name));
    return Object.values(AUDIO_DECODER_EXPORTS).filter((name: string): boolean => !exported.has(name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isNameMap(value: unknown): value is ReadonlyMap<number, string> {
    if (!(value instanceof Map)) {
        return false;
    }
    for (const [ key, name ] of value) {
        if (!Number.isSafeInteger(key) || typeof name !== 'string') {
            return false;
        }
    }
    return true;
}

function isAudioDecoderManifest(value: unknown): value is AudioDecoderManifest {
    return isRecord(value)
        && typeof value.name === 'string'
        && Array.isArray(value.codecs)
        && value.codecs.every((codec: unknown): boolean => typeof codec === 'string')
        && isNameMap(value.attributes)
        && isNameMap(value.errors)
        && isNameMap(value.options)
        && Number.isSafeInteger(value.packetByteLength)
        && Number(value.packetByteLength) > 0
        && Number(value.packetByteLength) <= AUDIO_DECODER_MAXIMUM_PACKET_BYTE_LENGTH;
}

/** Validates a module source that crossed a worker boundary: a compiled module, its memory limits or null, and a manifest's shape. */
export function isAudioDecoderModuleSource(value: unknown): value is AudioDecoderModuleSource {
    return isRecord(value)
        && value.module instanceof WebAssembly.Module
        && (value.memory === null || isDecoderPackageMemoryLimits(value.memory))
        && isAudioDecoderManifest(value.manifest);
}

/** A host's audio decoder package that decodes a track, and the codec of its manifest the track decodes as. */
export type AudioDecoderPackageSelection = Readonly<{
    codec: string
    source: AudioDecoderModuleSource
}>;

/** Validates a selection that crossed a worker boundary: it names one of its manifest's codecs. */
export function isAudioDecoderPackageSelection(value: unknown): value is AudioDecoderPackageSelection {
    return isRecord(value)
        && typeof value.codec === 'string'
        && isAudioDecoderModuleSource(value.source)
        && value.source.manifest.codecs.includes(value.codec);
}

/** Returns the key a manifest gives a name, or null when it names none. */
function findKey(names: ReadonlyMap<number, string>, name: string): number | null {
    for (const [ key, keyName ] of names) {
        if (keyName === name) {
            return key;
        }
    }
    return null;
}

function requireExports(instance: WebAssembly.Instance): AudioDecoderExports {
    const exportsValue = instance.exports as unknown as Record<string, unknown>;
    const functions: Partial<AudioDecoderExports> = {};
    for (const [ key, name ] of Object.entries(AUDIO_DECODER_EXPORTS) as Array<[keyof AudioDecoderExports, string]>) {
        const value = exportsValue[name];
        if (typeof value !== 'function') {
            throw new TypeError(`audio decoder export ${name} is missing`);
        }
        functions[key] = value as WASMFunction;
    }
    return functions as AudioDecoderExports;
}

/** One decoder of one codec on its own instance of an audio decoder package. */
export default class AudioDecoderPackageInstance {
    private closed = false;
    private readonly drainExport: WASMFunction | null;
    private readonly exports: AudioDecoderExports;
    private readonly handle: number;
    private readonly manifest: AudioDecoderManifest;
    private readonly memory: WebAssembly.Memory;

    private constructor(instance: WebAssembly.Instance, memory: WebAssembly.Memory, manifest: AudioDecoderManifest, codecIndex: number) {
        this.exports = requireExports(instance);
        const drainExport = (instance.exports as unknown as Record<string, unknown>)[AUDIO_DECODER_OPTIONAL_EXPORTS.drain];
        this.drainExport = typeof drainExport === 'function' ? drainExport as WASMFunction : null;
        this.memory = memory;
        this.manifest = manifest;
        const version = this.exports.abiVersion();
        if (version !== AUDIO_DECODER_ABI_VERSION) {
            throw new TypeError(`audio decoder interface ${version}, the engine drives ${AUDIO_DECODER_ABI_VERSION}`);
        }
        this.handle = this.exports.create(codecIndex);
        if (this.handle === 0) {
            throw new TypeError(`audio decoder create returned no decoder for ${manifest.codecs[codecIndex]}`);
        }
    }

    /** Instantiates the package on its own memory and creates a decoder of one of the codecs its manifest lists. */
    static async create(source: AudioDecoderModuleSource, codec: string): Promise<AudioDecoderPackageInstance> {
        const codecIndex = source.manifest.codecs.indexOf(codec);
        if (codecIndex < 0) {
            throw new RangeError(`audio decoder ${source.manifest.name} decodes no ${codec}`);
        }
        const { instance, memory } = await instantiateDecoderPackage(source.module, source.memory);
        if (!memory) {
            throw new TypeError('audio decoder module imports no memory');
        }
        return new AudioDecoderPackageInstance(instance, memory, source.manifest, codecIndex);
    }

    /** Hands the decoder the track's codec private data, when the track has any. */
    configure(codecPrivate: Uint8Array | null): void {
        this.requireOpen();
        if (!codecPrivate || codecPrivate.byteLength === 0) {
            return;
        }
        this.writeInput(codecPrivate);
        this.check(this.exports.configure(this.handle, codecPrivate.byteLength));
    }

    /** Sets a codec-specific option the manifest names, such as an exact qualification's `pcmFingerprint`. */
    setOption(name: string, value: number): void {
        this.requireOpen();
        const key = findKey(this.manifest.options, name);
        if (key === null) {
            throw new RangeError(`audio decoder ${this.manifest.name} has no option ${name}`);
        }
        this.check(this.exports.setOption(this.handle, key, value));
    }

    /** Reads an attribute the manifest names outside a block, such as its `libraryVersion`; null when the decoder reports none. */
    readAttribute(name: string): number | null {
        this.requireOpen();
        const key = findKey(this.manifest.attributes, name);
        if (key === null) {
            return null;
        }
        const value = this.exports.attribute(this.handle, key);
        return Number.isNaN(value) ? null : value;
    }

    /** Decodes one packet into its blocks, each copied out of the decoder's memory. */
    decode(packet: Uint8Array, timestampMicroseconds: number): AudioDecoderPackageResult {
        this.requireOpen();
        if (packet.byteLength === 0 || packet.byteLength > this.manifest.packetByteLength) {
            throw new RangeError(`audio packet of ${packet.byteLength} bytes outside [1, ${this.manifest.packetByteLength}]`);
        }
        this.writeInput(packet);
        const sendStatus = this.exports.send(this.handle, packet.byteLength, timestampMicroseconds);
        switch (sendStatus) {
            case SEND_STATUS.dropped:
                return { kind: 'dropped' };
            case SEND_STATUS.awaitingSync:
                return { kind: 'awaiting-sync' };
            case SEND_STATUS.accepted:
                break;
            default:
                this.check(sendStatus);
        }
        const blocks: AudioDecoderPackageBlock[] = [];
        let frameCount = 0;
        for (;;) {
            const block = this.receiveBlock();
            if (!block) {
                return { blocks, kind: 'decoded' };
            }
            frameCount += block.frameCount;
            // A packet's blocks each consume at least one of its bytes, and together stay within the frame bound
            if (blocks.length >= packet.byteLength || frameCount > MAXIMUM_BLOCK_FRAME_COUNT * packet.byteLength) {
                throw new RangeError(`audio decoder output exceeded what ${packet.byteLength} bytes hold`);
            }
            blocks.push(block);
        }
    }

    /**
     * Ends the track: a module with `audio_decoder_drain` outputs the frames its decoder held back, block by block, and a module without it none.
     * The decoder takes no packet after it until `clear`.
     */
    drain(): AudioDecoderPackageBlock[] {
        this.requireOpen();
        if (!this.drainExport) {
            return [];
        }
        this.check(this.drainExport(this.handle));
        const blocks: AudioDecoderPackageBlock[] = [];
        for (let block = this.receiveBlock(); block; block = this.receiveBlock()) {
            if (blocks.length >= MAXIMUM_DRAIN_BLOCK_COUNT) {
                throw new RangeError(`audio decoder drain output more than ${MAXIMUM_DRAIN_BLOCK_COUNT} blocks`);
            }
            blocks.push(block);
        }
        return blocks;
    }

    /** Clears inter-frame state before a seek or a source change. */
    clear(): void {
        this.requireOpen();
        this.exports.clear(this.handle);
    }

    /** Releases the decoder exactly once. */
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.exports.destroy(this.handle);
    }

    /** Receives the decoder's next block and copies it out, or returns null when it has none left. */
    private receiveBlock(): AudioDecoderPackageBlock | null {
        const receiveStatus = this.exports.receive(this.handle);
        if (receiveStatus === RECEIVE_STATUS.none) {
            return null;
        }
        if (receiveStatus !== RECEIVE_STATUS.ready) {
            this.check(receiveStatus);
        }
        return this.copyBlock();
    }

    private copyBlock(): AudioDecoderPackageBlock {
        const frameCount = this.exports.frameCount(this.handle);
        if (!Number.isSafeInteger(frameCount) || frameCount <= 0 || frameCount > MAXIMUM_BLOCK_FRAME_COUNT) {
            throw new RangeError(`audio decoder block of ${frameCount} frames`);
        }
        const sampleRate = this.exports.sampleRate(this.handle);
        if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
            throw new RangeError(`audio decoder sample rate ${sampleRate}`);
        }
        const channelCount = this.exports.channelCount(this.handle);
        if (!Number.isSafeInteger(channelCount) || channelCount <= 0 || channelCount > MAXIMUM_CHANNEL_COUNT) {
            throw new RangeError(`audio decoder channel count ${channelCount}`);
        }
        const channelData: Float32Array[] = [];
        const memoryByteLength = this.memory.buffer.byteLength;
        const planeByteLength = frameCount * Float32Array.BYTES_PER_ELEMENT;
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            const pointer = this.exports.channelPointer(this.handle, channelIndex) >>> 0;
            if (pointer === 0 || pointer % Float32Array.BYTES_PER_ELEMENT !== 0 || pointer + planeByteLength > memoryByteLength) {
                throw new RangeError(`audio decoder channel ${channelIndex} at ${pointer} outside its memory`);
            }
            channelData.push(new Float32Array(this.memory.buffer.slice(pointer, pointer + planeByteLength)));
        }
        const timestamp = this.exports.timestamp(this.handle);
        const attributes = new Map<string, number>();
        for (const [ key, name ] of this.manifest.attributes) {
            const value = this.exports.attribute(this.handle, key);
            if (!Number.isNaN(value)) {
                attributes.set(name, value);
            }
        }
        return {
            attributes,
            channelData,
            channelMask: this.exports.channelMask(this.handle) >>> 0,
            frameCount,
            sampleRate,
            timestampMicroseconds: Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null
        };
    }

    private writeInput(bytes: Uint8Array): void {
        const pointer = this.exports.reserveInput(this.handle, bytes.byteLength) >>> 0;
        if (pointer === 0) {
            throw new RangeError(`audio decoder reserve_input refused ${bytes.byteLength} bytes`);
        }
        new Uint8Array(this.memory.buffer, pointer, bytes.byteLength).set(bytes);
    }

    private check(status: number): void {
        if (status !== SUCCESS_STATUS) {
            throw new AudioDecoderPackageError(this.exports.errorCode(this.handle) >>> 0, this.exports.errorValue(this.handle) >>> 0, this.manifest.errors);
        }
    }

    private requireOpen(): void {
        if (this.closed) {
            throw new Error(`audio decoder ${this.manifest.name} is closed`);
        }
    }
}
