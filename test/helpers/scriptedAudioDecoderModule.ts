// A module of the audio decoder interface scripted in JavaScript, for tests of the engine's decoders over an audio decoder package:
// each packet decodes to the outcome its test scripts, and each block's planes sit in a real memory that the package instance copies them from.
// A test file mocks instantiateDecoderPackage with instantiateScriptedAudioDecoderModule, so the engine's own package instance drives these exports.
import type { AudioDecoderManifest } from 'webgpu-player/decode/audio/AudioDecoderManifest';
import { AUDIO_DECODER_EXPORTS, AUDIO_DECODER_OPTIONAL_EXPORTS, type AudioDecoderModuleSource } from 'webgpu-player/decode/audio/AudioDecoderPackageInstance';
import { DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } from 'webgpu-player/decode/packages/DecoderPackageImports';

import { encodeWebAssemblyModule } from './webAssemblyModuleEncoder';

/** One block a scripted packet decodes to: its planes, layout, and rate, its own timestamp or none, and its attributes by manifest name. */
export type ScriptedAudioBlock = Readonly<{
    attributes?: Readonly<Record<string, number>>
    channelData: readonly (readonly number[])[]
    channelMask: number
    sampleRate: number
    /** Null, or left out, continues from the packet's timestamp */
    timestampMicroseconds?: number | null
}>;

/** A failed call, with the error code and value the decoder reports. */
export type ScriptedAudioFailure = Readonly<{
    code: number
    value: number
}>;

/**
 * What one packet decodes to: its blocks, no output, or a failed send.
 * A receive failure fails the receive after the packet's blocks, as a decoder that rejects a decoded frame's format does.
 */
export type ScriptedAudioPacket =
    | Readonly<{ blocks: readonly ScriptedAudioBlock[]; kind: 'decoded'; receiveFailure?: ScriptedAudioFailure }>
    | Readonly<{ kind: 'awaiting-sync' }>
    | Readonly<{ kind: 'dropped' }>
    | Readonly<{ failure: ScriptedAudioFailure; kind: 'failed' }>;

export type ScriptedAudioDecoderScript = Readonly<{
    /** Attributes outside any block, by manifest name, such as `libraryVersion` */
    attributes?: Readonly<Record<string, number>>
    /** The failure its configure call reports, or none when it accepts any codec private data */
    configureFailure?: ScriptedAudioFailure
    /** The blocks its `audio_decoder_drain` export outputs at the end of a track; without them the module has no such export */
    drainedBlocks?: readonly ScriptedAudioBlock[]
    manifest: AudioDecoderManifest
    /** What each packet decodes to, in order; a packet past the list decodes to the last one */
    packets: readonly ScriptedAudioPacket[]
}>;

/** A packet as the decoder received it. */
export type ScriptedSentPacket = Readonly<{
    bytes: Uint8Array
    timestampMicroseconds: number
}>;

/** Codec private data as a decoder received it, and how many packets its package had been sent by then. */
export type ScriptedConfiguration = Readonly<{
    bytes: Uint8Array
    sentPacketCount: number
}>;

/** An option as a decoder received it, by manifest name, and how many packets its package had been sent by then. */
export type ScriptedOption = Readonly<{
    name: string
    sentPacketCount: number
    value: number
}>;

type ScriptedExportKey = keyof typeof AUDIO_DECODER_EXPORTS;
type ScriptedExport = (...values: number[]) => number;

/** The handle every scripted decoder's create returns, nonzero as a live decoder's is. */
export const SCRIPTED_AUDIO_DECODER_HANDLE = 64;

const ABI_VERSION = 1;
const SUCCESS_STATUS = 0;
const FAILED_STATUS = -1;
const SEND_STATUS = Object.freeze({ accepted: 0, awaitingSync: 2, dropped: 1 });
const RECEIVE_STATUS = Object.freeze({ none: 0, ready: 1 });
// The timestamp of a block without its own, as the interface reports it
const NO_TIMESTAMP = -1;
const WASM_PAGE_BYTE_LENGTH = 65_536;
// Where the scripted decoder keeps its input, and the planes of its current block after it
const INPUT_POINTER = 1_024;
const INITIAL_MEMORY_PAGES = 1;

// The custom section that names a module's script, which survives the structured clone a worker boundary makes of the module
const SCRIPT_SECTION_NAME = 'scripted-audio-decoder';
const SCRIPT_ID_BYTE_LENGTH = Uint32Array.BYTES_PER_ELEMENT;

const scriptedModules = new Map<number, ScriptedAudioDecoderModule>();
let nextScriptID = 1;

/** One scripted decoder package: what it decodes, and what its decoders were asked to do. */
export class ScriptedAudioDecoderModule {
    public readonly clearedHandles: number[] = [];
    /** The codec private data its decoders were configured with, in order */
    public readonly configurations: ScriptedConfiguration[] = [];
    public readonly createdCodecIndices: number[] = [];
    public readonly destroyedHandles: number[] = [];
    /** The options set on its decoders, in order */
    public readonly options: ScriptedOption[] = [];
    /** How many times its decoders were drained */
    public drainCount = 0;
    public receiveCount = 0;
    public readonly sentPackets: ScriptedSentPacket[] = [];
    public readonly source: AudioDecoderModuleSource;

    private readonly script: ScriptedAudioDecoderScript;

    public constructor(script: ScriptedAudioDecoderScript) {
        this.script = script;
        // A module of its own, whose section the mocked instantiation finds this script by
        const scriptID = nextScriptID;
        nextScriptID += 1;
        const module = new WebAssembly.Module(encodeWebAssemblyModule({
            customSections: [ { name: SCRIPT_SECTION_NAME, payload: new Uint8Array(Uint32Array.of(scriptID).buffer) } ]
        }));
        this.source = {
            manifest: script.manifest,
            memory: { initialPages: INITIAL_MEMORY_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES },
            module
        };
        scriptedModules.set(scriptID, this);
    }

    /** The module factory the engine's decoders take. */
    public readonly moduleFactory = (): Promise<AudioDecoderModuleSource> => Promise.resolve(this.source);

    /** Instantiates the script: a memory of its own, and exports that play its packets back in order. */
    public instantiate(): { instance: WebAssembly.Instance; memory: WebAssembly.Memory } {
        const memory = new WebAssembly.Memory({ initial: INITIAL_MEMORY_PAGES, maximum: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES });
        const { attributes, configureFailure, manifest, packets } = this.script;
        let packetIndex = 0;
        let reservedByteLength = 0;
        let pendingBlocks: ScriptedAudioBlock[] = [];
        let pendingReceiveFailure: ScriptedAudioFailure | null = null;
        let currentBlock: ScriptedAudioBlock | null = null;
        let error: ScriptedAudioFailure = { code: 0, value: 0 };
        const fail = (failure: ScriptedAudioFailure): number => {
            error = failure;
            return FAILED_STATUS;
        };
        const readInput = (byteLength: number): Uint8Array => new Uint8Array(memory.buffer.slice(INPUT_POINTER, INPUT_POINTER + byteLength));
        const ensureByteLength = (byteLength: number): void => {
            const missingByteLength = byteLength - memory.buffer.byteLength;
            if (missingByteLength > 0) {
                memory.grow(Math.ceil(missingByteLength / WASM_PAGE_BYTE_LENGTH));
            }
        };
        const getPlaneByteLength = (block: ScriptedAudioBlock): number => (block.channelData[0]?.length ?? 0) * Float32Array.BYTES_PER_ELEMENT;
        // The planes follow the largest input this decoder reserved, as a decoder's buffers would
        const getPlanesPointer = (): number => INPUT_POINTER + Math.ceil(reservedByteLength / Float32Array.BYTES_PER_ELEMENT) * Float32Array.BYTES_PER_ELEMENT;
        const writeBlock = (block: ScriptedAudioBlock): void => {
            const planeByteLength = getPlaneByteLength(block);
            ensureByteLength(getPlanesPointer() + planeByteLength * block.channelData.length);
            for (const [ channelIndex, plane ] of block.channelData.entries()) {
                new Float32Array(memory.buffer, getPlanesPointer() + channelIndex * planeByteLength, plane.length).set(plane);
            }
        };
        const send = (_handle: number, byteLength: number, timestampMicroseconds: number): number => {
            this.sentPackets.push({ bytes: readInput(byteLength), timestampMicroseconds });
            const packet = packets[Math.min(packetIndex, packets.length - 1)];
            packetIndex += 1;
            switch (packet.kind) {
                case 'decoded':
                    pendingBlocks = [ ...packet.blocks ];
                    pendingReceiveFailure = packet.receiveFailure ?? null;
                    return SEND_STATUS.accepted;
                case 'awaiting-sync':
                    return SEND_STATUS.awaitingSync;
                case 'dropped':
                    return SEND_STATUS.dropped;
                case 'failed':
                    return fail(packet.failure);
            }
        };
        const receive = (): number => {
            this.receiveCount += 1;
            const block = pendingBlocks.shift();
            if (!block) {
                const receiveFailure = pendingReceiveFailure;
                pendingReceiveFailure = null;
                return receiveFailure ? fail(receiveFailure) : RECEIVE_STATUS.none;
            }
            writeBlock(block);
            currentBlock = block;
            return RECEIVE_STATUS.ready;
        };
        const readAttribute = (_handle: number, key: number): number => {
            const name = manifest.attributes.get(key) ?? '';
            return currentBlock?.attributes?.[name] ?? attributes?.[name] ?? Number.NaN;
        };
        const implementations: Record<ScriptedExportKey, ScriptedExport> = {
            abiVersion: (): number => ABI_VERSION,
            attribute: readAttribute,
            channelCount: (): number => currentBlock?.channelData.length ?? 0,
            channelMask: (): number => currentBlock?.channelMask ?? 0,
            channelPointer: (_handle: number, channelIndex: number): number => (
                currentBlock ? getPlanesPointer() + channelIndex * getPlaneByteLength(currentBlock) : 0
            ),
            clear: (handle: number): number => {
                this.clearedHandles.push(handle);
                pendingBlocks = [];
                pendingReceiveFailure = null;
                return SUCCESS_STATUS;
            },
            configure: (_handle: number, byteLength: number): number => {
                this.configurations.push({ bytes: readInput(byteLength), sentPacketCount: this.sentPackets.length });
                return configureFailure ? fail(configureFailure) : SUCCESS_STATUS;
            },
            create: (codecIndex: number): number => {
                this.createdCodecIndices.push(codecIndex);
                return SCRIPTED_AUDIO_DECODER_HANDLE;
            },
            destroy: (handle: number): number => {
                this.destroyedHandles.push(handle);
                return SUCCESS_STATUS;
            },
            errorCode: (): number => error.code,
            errorValue: (): number => error.value,
            frameCount: (): number => currentBlock?.channelData[0]?.length ?? 0,
            receive,
            reserveInput: (_handle: number, byteLength: number): number => {
                reservedByteLength = Math.max(reservedByteLength, byteLength);
                ensureByteLength(INPUT_POINTER + byteLength);
                return INPUT_POINTER;
            },
            sampleRate: (): number => currentBlock?.sampleRate ?? 0,
            send,
            setOption: (_handle: number, key: number, value: number): number => {
                this.options.push({ name: manifest.options.get(key) ?? '', sentPacketCount: this.sentPackets.length, value });
                return SUCCESS_STATUS;
            },
            timestamp: (): number => currentBlock?.timestampMicroseconds ?? NO_TIMESTAMP
        };
        const exports: Record<string, ScriptedExport> = {};
        for (const [ key, name ] of Object.entries(AUDIO_DECODER_EXPORTS) as [ ScriptedExportKey, string ][]) {
            exports[name] = implementations[key];
        }
        if (this.script.drainedBlocks) {
            const drainedBlocks = this.script.drainedBlocks;
            exports[AUDIO_DECODER_OPTIONAL_EXPORTS.drain] = (): number => {
                this.drainCount += 1;
                pendingBlocks = [ ...drainedBlocks ];
                return SUCCESS_STATUS;
            };
        }
        return { instance: { exports } as unknown as WebAssembly.Instance, memory };
    }
}

/** Instantiates the scripted module a source carries, or its structured clone, in place of the engine's instantiation of a package module. */
export function instantiateScriptedAudioDecoderModule(module: WebAssembly.Module): Promise<{ instance: WebAssembly.Instance; memory: WebAssembly.Memory }> {
    const [ section ] = WebAssembly.Module.customSections(module, SCRIPT_SECTION_NAME);
    const scriptedModule = section?.byteLength === SCRIPT_ID_BYTE_LENGTH ?
        scriptedModules.get(new DataView(section).getUint32(0, true)) :
        undefined;
    if (!scriptedModule) {
        return Promise.reject(new Error('The module is no scripted audio decoder module'));
    }
    return Promise.resolve(scriptedModule.instantiate());
}
