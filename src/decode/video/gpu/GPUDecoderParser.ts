// One instance of a video decoder package's parser: the WebAssembly module that turns the track's packets into what the package's WGSL reads.
// A coordinator instance plans each packet's pictures in decode order and finishes them; parse instances parse planned units, so pictures parse in parallel.
// decode() runs all three steps on one instance, picture by picture. The engine book's decoder packages chapter describes the interface.
import { getDecoderErrorName } from '../../packages/DecoderHeader';
import type { VideoDecoderPackage } from '../../packages/DecoderPackage';
import { instantiateDecoderPackage, type DecoderPackageMemoryLimits } from '../../packages/DecoderPackageImports';
import { decodePictureFieldsWord, isPictureFieldsWord, type VideoFrameFields } from '../VideoFields';
import { findGPUDecoderOutputFormat, type GPUDecoderOutputFormat } from './GPUDecodeFormats';
import { GPU_DECODER_PARSER_ABI_VERSION, MAXIMUM_GPU_DECODE_OUTPUT_EVENTS, MAXIMUM_GPU_DECODE_PACKET_PICTURES } from './GPUDecodeLimits';
import {
    GPU_DECODER_PICTURE_FORMAT,
    type GPUDecoderErrorRecovery,
    type GPUDecoderPictureSize,
    type GPUVideoDecodeRecovery
} from './GPUDecodeTypes';

/** The exports version 2 of the parser interface requires; the module imports its memory as `env.memory`. */
export const GPU_DECODER_PARSER_EXPORTS = Object.freeze({
    abiVersion: 'parser_abi_version',
    configure: 'parser_configure',
    create: 'parser_create',
    decode: 'parser_decode',
    decodeNext: 'parser_decode_next',
    destroy: 'parser_destroy',
    errorCode: 'parser_error_code',
    errorValue: 'parser_error_value',
    eventCount: 'parser_event_count',
    eventPointer: 'parser_event_pointer',
    finish: 'parser_finish',
    maximumPictureHeight: 'parser_maximum_picture_height',
    maximumPictureWidth: 'parser_maximum_picture_width',
    outputByteLength: 'parser_output_byte_length',
    outputPointer: 'parser_output_pointer',
    parse: 'parser_parse',
    pictureFormat: 'parser_picture_format',
    pictureHeight: 'parser_picture_height',
    pictureRepeatCount: 'parser_picture_repeat_count',
    pictureWidth: 'parser_picture_width',
    plan: 'parser_plan',
    planNext: 'parser_plan_next',
    planUnitCount: 'parser_plan_unit_count',
    reserveInput: 'parser_reserve_input',
    reset: 'parser_reset'
});

/**
 * The exports a parser may leave out, each for facts some codecs lack.
 * - pictureFields: `parser_picture_fields(handle) -> u32`, the picture fields word (VideoFields.ts PICTURE_FIELDS_WORD) of the picture the last call output;
 *   without it, pictures report no fields and take their container's scan.
 */
export const GPU_DECODER_PARSER_OPTIONAL_EXPORTS = Object.freeze({
    pictureFields: 'parser_picture_fields'
});

/**
 * Status values of the module's calls.
 * A plan, planNext, decode, or decodeNext returns success for the packet's last picture, morePictures for a picture the packet follows with more,
 * noPicture when it holds no more, or blocked for a plan or planNext that must wait for every earlier picture to finish.
 */
export const GPU_DECODER_PARSER_STATUS = Object.freeze({
    blocked: 2,
    failed: -1,
    morePictures: 3,
    noPicture: 1,
    success: 0
});

/** The failure of a blocked call with no earlier picture left to finish, which could wait forever. */
export const GPU_DECODER_PARSER_BLOCKED_DETAIL = 'blocked with no earlier picture unfinished';

type WASMFunction = (...values: number[]) => number;

type ParserExports = Record<keyof typeof GPU_DECODER_PARSER_EXPORTS, WASMFunction>;

/** A failed check of a parser: the decoder's error code and the failing value, named by its manifest's error names. */
export class GPUDecoderParserError extends Error {
    readonly code: number;
    readonly value: number;

    constructor(code: number, value: number, errorNames: ReadonlyMap<number, string>) {
        super(`parser ${getDecoderErrorName(errorNames, code)}: ${value}`);
        this.name = 'GPUDecoderParserError';
        this.code = code;
        this.value = value;
    }
}

/**
 * A plan or planNext call's result: a picture, with its serialized plan, the units parse calls may split, and whether the packet holds more pictures;
 * no (more) picture, whose events still apply; or blocked, which waits for every earlier picture to finish.
 */
export type GPUDecoderPlannedPicture =
    | { kind: 'blocked' }
    | { events: Uint32Array; kind: 'no-picture' }
    | { events: Uint32Array; kind: 'picture'; morePictures: boolean; plan: ArrayBuffer; unitCount: number };

/**
 * One picture a parser output: its GPU record, the output events its calls decided, its visible size, how many times its record runs each repeat,
 * and the stream it needs: its output format and its sequence's largest picture, which a session that cannot hold them is replaced for.
 */
export type GPUDecoderParserPicture = {
    events: Uint32Array
    /** The picture's fields, from the optional `parser_picture_fields`; null when the parser reports none */
    fields: VideoFrameFields | null
    /** Null for a picture that keeps the session's output format */
    format: GPUDecoderOutputFormat | null
    /** The largest picture of the picture's sequence, or null for none reported */
    maximumPictureSize: GPUDecoderPictureSize | null
    record: ArrayBuffer
    /** One count per `repeat:` directive of the decoder's header, in header order; the session runs at most the directive's own count */
    repeatCounts: readonly number[]
    /** Null for a picture that keeps the stream's visible rectangle */
    visibleSize: GPUDecoderPictureSize | null
};

/**
 * One packet's output: its pictures in decode order, and the output events of its calls that planned no picture,
 * which wait for the next picture or for the end of the track.
 */
export type GPUDecoderParserOutput = {
    pictures: GPUDecoderParserPicture[]
    trailingEvents: Uint32Array
};

/** Returns the names of the version 2 exports a module lacks, empty when it has every one. */
export function findMissingGPUDecoderParserExports(module: WebAssembly.Module): string[] {
    const exported = new Set(WebAssembly.Module.exports(module)
        .filter((descriptor: WebAssembly.ModuleExportDescriptor): boolean => descriptor.kind === 'function')
        .map((descriptor: WebAssembly.ModuleExportDescriptor): string => descriptor.name));
    return Object.values(GPU_DECODER_PARSER_EXPORTS).filter((name: string): boolean => !exported.has(name));
}

/** Reads a size the module reported as two u32 results: null for none, both zero; a report must give both. */
function readPictureSize(widthResult: number, heightResult: number, subject: string): GPUDecoderPictureSize | null {
    const width = widthResult >>> 0;
    const height = heightResult >>> 0;
    if (width === 0 && height === 0) {
        return null;
    }
    if (width === 0 || height === 0) {
        throw new RangeError(`parser ${subject} ${width}x${height}`);
    }
    return { height, width };
}

/** Reads the output format a picture reported as `(chroma_format << 8) | bit_depth`: null for none; a code no output format holds fails. */
function readPictureFormat(result: number): GPUDecoderOutputFormat | null {
    const code = result >>> 0;
    if (code === GPU_DECODER_PICTURE_FORMAT.none) {
        return null;
    }
    const chromaFormat = code >>> GPU_DECODER_PICTURE_FORMAT.chromaFormatShift;
    const format = chromaFormat <= GPU_DECODER_PICTURE_FORMAT.chromaFormatMask ?
        findGPUDecoderOutputFormat(chromaFormat, code & GPU_DECODER_PICTURE_FORMAT.bitDepthMask) :
        null;
    if (format === null) {
        throw new RangeError(`parser picture format 0x${code.toString(16)}`);
    }
    return format;
}

/** Reads the fields word a picture reported: null for none; a word with an undefined bit, or bits without the reported bit, fails. */
function readPictureFields(result: number): VideoFrameFields | null {
    const word = result >>> 0;
    if (!isPictureFieldsWord(word)) {
        throw new RangeError(`parser picture fields 0x${word.toString(16)}`);
    }
    return decodePictureFieldsWord(word);
}

/** Returns an optional export of the module, or null when it leaves the export out. */
function findOptionalExport(instance: WebAssembly.Instance, name: string): WASMFunction | null {
    const value = (instance.exports as unknown as Record<string, unknown>)[name];
    return typeof value === 'function' ? value as WASMFunction : null;
}

function requireExports(instance: WebAssembly.Instance): ParserExports {
    const exportsValue = instance.exports as unknown as Record<string, unknown>;
    const functions: Partial<ParserExports> = {};
    for (const [ key, name ] of Object.entries(GPU_DECODER_PARSER_EXPORTS) as Array<[keyof ParserExports, string]>) {
        const value = exportsValue[name];
        if (typeof value !== 'function') {
            throw new TypeError(`parser export ${name} is missing`);
        }
        functions[key] = value as WASMFunction;
    }
    return functions as ParserExports;
}

/** The module and memory a parser instance needs, which the decode worker passes on to its parse workers, and what it reads of the package's header. */
export type GPUDecoderParserModule = Readonly<{
    errorNames: ReadonlyMap<number, string>
    /** The recovery of each error code whose header line declares one: a parser failure with such a code restarts the parser at the next key packet */
    errorRecoveries: ReadonlyMap<number, GPUDecoderErrorRecovery>
    memory: DecoderPackageMemoryLimits | null
    module: WebAssembly.Module
    /** The `repeat:` directives of the package's header, whose count each picture reports */
    repeatDirectiveCount: number
}>;

/**
 * Returns what a video package's parser instances need: its module, its memory limits, and its header's error names, error recoveries,
 * and repeat directive count.
 */
export function getGPUDecoderParserModule(decoderPackage: VideoDecoderPackage): GPUDecoderParserModule {
    const manifest = decoderPackage.manifest;
    return {
        errorNames: manifest.errors,
        errorRecoveries: manifest.errorRecoveries,
        memory: decoderPackage.memory,
        module: decoderPackage.module,
        repeatDirectiveCount: manifest.repeats.length
    };
}

/**
 * Returns the recovery a parser's failure takes: one whose code the header declares recoverable restarts the parser at the next key packet,
 * since the failed call made no picture and left the instance unusable; any other failure, the parser's own checks without one included, ends the attempt.
 */
export function getGPUDecoderParserFailureRecovery(parser: GPUDecoderParserModule, error: unknown): GPUVideoDecodeRecovery | null {
    if (!(error instanceof GPUDecoderParserError) || !parser.errorRecoveries.has(error.code)) {
        return null;
    }
    return { code: 'resynced', errorName: `parser ${getDecoderErrorName(parser.errorNames, error.code)}`, value: error.value };
}

/** One instance of a parser module, with its own bounded memory. */
export default class GPUDecoderParserInstance {
    private destroyed = false;
    private readonly errorNames: ReadonlyMap<number, string>;
    private readonly exports: ParserExports;
    private readonly handle: number;
    private readonly memory: WebAssembly.Memory;
    private readonly pictureFields: WASMFunction | null;
    private readonly repeatDirectiveCount: number;

    private constructor(instance: WebAssembly.Instance, memory: WebAssembly.Memory, parser: GPUDecoderParserModule) {
        this.exports = requireExports(instance);
        this.pictureFields = findOptionalExport(instance, GPU_DECODER_PARSER_OPTIONAL_EXPORTS.pictureFields);
        this.memory = memory;
        this.errorNames = parser.errorNames;
        this.repeatDirectiveCount = parser.repeatDirectiveCount;
        const version = this.exports.abiVersion();
        if (version !== GPU_DECODER_PARSER_ABI_VERSION) {
            throw new TypeError(`parser interface ${version}, the engine drives ${GPU_DECODER_PARSER_ABI_VERSION}`);
        }
        this.handle = this.exports.create();
        if (this.handle === 0) {
            throw new TypeError('parser create returned no instance');
        }
    }

    /** Instantiates a parser module with the memory its package declares. */
    static async create(parser: GPUDecoderParserModule): Promise<GPUDecoderParserInstance> {
        const { instance, memory } = await instantiateDecoderPackage(parser.module, parser.memory);
        if (!memory) {
            throw new TypeError('parser module imports no memory');
        }
        return new GPUDecoderParserInstance(instance, memory, parser);
    }

    /**
     * Hands the module the track's codec private data, such as an hvcC; null leaves parameter sets to the packets.
     * Returns the largest picture the data declares, such as an AV1 sequence header's maximum frame size, or null when it declares none.
     */
    configure(codecPrivate: Uint8Array | null): GPUDecoderPictureSize | null {
        if (!codecPrivate || codecPrivate.byteLength === 0) {
            return null;
        }
        this.writeInput(codecPrivate);
        this.check(this.exports.configure(this.handle, codecPrivate.byteLength), 'configure');
        return readPictureSize(this.exports.maximumPictureWidth(this.handle), this.exports.maximumPictureHeight(this.handle), 'maximum picture size');
    }

    /** Drops every picture and parameter set, for a seek or a new video epoch; configure() must run again. */
    reset(): void {
        this.exports.reset(this.handle);
    }

    /**
     * Plans, parses, and finishes one packet's pictures on this instance, one after another; returns them in decode order,
     * with the output events of the call that found no more, which wait for the next picture.
     */
    decode(packet: Uint8Array): GPUDecoderParserOutput {
        this.writeInput(packet);
        const pictures: GPUDecoderParserPicture[] = [];
        let call = 'decode';
        let status = this.exports.decode(this.handle, packet.byteLength);
        while (status === GPU_DECODER_PARSER_STATUS.morePictures) {
            this.addPicture(pictures);
            call = 'decode_next';
            status = this.exports.decodeNext(this.handle);
        }
        switch (status) {
            case GPU_DECODER_PARSER_STATUS.success:
                this.addPicture(pictures);
                return { pictures, trailingEvents: new Uint32Array(0) };
            case GPU_DECODER_PARSER_STATUS.noPicture:
                return { pictures, trailingEvents: this.takeEvents() };
            case GPU_DECODER_PARSER_STATUS.blocked:
                // Every earlier picture finished on this instance, so a blocked decode would wait forever
                throw new Error(`parser ${call}: ${GPU_DECODER_PARSER_BLOCKED_DETAIL}`);
            default:
                throw this.createStatusFailure(status, call);
        }
    }

    /**
     * Plans a packet's first picture in decode order: its plan, a packet without a picture, or blocked.
     * A blocked packet kept no state; the caller plans it again once every earlier picture has finished.
     * A picture with more after it is followed by planNext() calls until one reports the last picture or no more.
     */
    plan(packet: Uint8Array): GPUDecoderPlannedPicture {
        this.writeInput(packet);
        return this.readPlannedPicture(this.exports.plan(this.handle, packet.byteLength), 'plan');
    }

    /**
     * Plans the packet's next picture after a plan or planNext that reported more; it reads no input.
     * A blocked call kept its place; the caller calls again once every earlier picture has finished.
     */
    planNext(): GPUDecoderPlannedPicture {
        return this.readPlannedPicture(this.exports.planNext(this.handle), 'plan_next');
    }

    /** Parses units of a plan; returns the serialized job. */
    parse(plan: Uint8Array, firstUnit: number, unitCount: number): ArrayBuffer {
        this.writeInput(plan);
        this.check(this.exports.parse(this.handle, plan.byteLength, firstUnit, unitCount), 'parse');
        return this.takeOutput();
    }

    /** Finishes the oldest planned picture from its jobs, concatenated in unit order; returns its GPU record, the call's output events, and its visible size. */
    finish(jobs: Uint8Array): GPUDecoderParserPicture {
        this.writeInput(jobs);
        this.check(this.exports.finish(this.handle, jobs.byteLength), 'finish');
        return this.takePicture();
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.exports.destroy(this.handle);
    }

    private writeInput(bytes: Uint8Array): void {
        const pointer = this.exports.reserveInput(this.handle, bytes.byteLength) >>> 0;
        if (pointer === 0 && bytes.byteLength > 0) {
            throw new RangeError(`parser reserve_input refused ${bytes.byteLength} bytes`);
        }
        // The reservation may grow memory, so the bound and the view are taken after it
        const memoryByteLength = this.memory.buffer.byteLength;
        if (pointer + bytes.byteLength > memoryByteLength) {
            throw new RangeError(`parser reserve_input ${pointer}+${bytes.byteLength} outside ${memoryByteLength} bytes`);
        }
        new Uint8Array(this.memory.buffer, pointer, bytes.byteLength).set(bytes);
    }

    /** Copies a pointer and byte length the module reported out of its memory, checking that they lie inside it. */
    private copyOut(pointer: number, byteLength: number, subject: string): ArrayBuffer {
        const memoryByteLength = this.memory.buffer.byteLength;
        if (pointer < 0 || byteLength < 0 || pointer + byteLength > memoryByteLength) {
            throw new RangeError(`parser ${subject} ${pointer}+${byteLength} outside ${memoryByteLength} bytes`);
        }
        return this.memory.buffer.slice(pointer, pointer + byteLength);
    }

    private takeOutput(): ArrayBuffer {
        return this.copyOut(this.exports.outputPointer(this.handle) >>> 0, this.exports.outputByteLength(this.handle) >>> 0, 'output');
    }

    private takeEvents(): Uint32Array {
        const eventCount = this.exports.eventCount(this.handle) >>> 0;
        if (eventCount === 0) {
            return new Uint32Array(0);
        }
        if (eventCount > MAXIMUM_GPU_DECODE_OUTPUT_EVENTS) {
            throw new RangeError(`parser events ${eventCount} > ${MAXIMUM_GPU_DECODE_OUTPUT_EVENTS}`);
        }
        return new Uint32Array(this.copyOut(this.exports.eventPointer(this.handle) >>> 0, eventCount * Uint32Array.BYTES_PER_ELEMENT, 'events'));
    }

    /** Reads how many times the picture the last call output runs each repeat of the header. */
    private takeRepeatCounts(): number[] {
        const repeatCounts: number[] = [];
        for (let repeatIndex = 0; repeatIndex < this.repeatDirectiveCount; repeatIndex += 1) {
            repeatCounts.push(this.exports.pictureRepeatCount(this.handle, repeatIndex) >>> 0);
        }
        return repeatCounts;
    }

    /** Copies out the picture the last finish, decode, or decodeNext output, with the stream it needs. */
    private takePicture(): GPUDecoderParserPicture {
        return {
            events: this.takeEvents(),
            fields: this.pictureFields === null ? null : readPictureFields(this.pictureFields(this.handle)),
            format: readPictureFormat(this.exports.pictureFormat(this.handle)),
            maximumPictureSize: readPictureSize(this.exports.maximumPictureWidth(this.handle), this.exports.maximumPictureHeight(this.handle), 'maximum picture size'),
            record: this.takeOutput(),
            repeatCounts: this.takeRepeatCounts(),
            visibleSize: readPictureSize(this.exports.pictureWidth(this.handle), this.exports.pictureHeight(this.handle), 'picture size')
        };
    }

    /** Adds the picture a decode or decodeNext output to a packet's pictures, which stay within the bound of one packet. */
    private addPicture(pictures: GPUDecoderParserPicture[]): void {
        if (pictures.length >= MAXIMUM_GPU_DECODE_PACKET_PICTURES) {
            throw new RangeError(`parser pictures ${pictures.length + 1} > ${MAXIMUM_GPU_DECODE_PACKET_PICTURES} in one packet`);
        }
        pictures.push(this.takePicture());
    }

    /** Reads a plan or planNext call's result. */
    private readPlannedPicture(status: number, call: string): GPUDecoderPlannedPicture {
        switch (status) {
            case GPU_DECODER_PARSER_STATUS.blocked:
                return { kind: 'blocked' };
            case GPU_DECODER_PARSER_STATUS.noPicture:
                return { events: this.takeEvents(), kind: 'no-picture' };
            case GPU_DECODER_PARSER_STATUS.success:
            case GPU_DECODER_PARSER_STATUS.morePictures:
                return {
                    events: this.takeEvents(),
                    kind: 'picture',
                    morePictures: status === GPU_DECODER_PARSER_STATUS.morePictures,
                    plan: this.takeOutput(),
                    unitCount: this.exports.planUnitCount(this.handle) >>> 0
                };
            default:
                throw this.createStatusFailure(status, call);
        }
    }

    /** Returns the failure of a call that reported a status other than its successes: the module's failed check, or the status it may not return. */
    private createStatusFailure(status: number, call: string): Error {
        if (status === GPU_DECODER_PARSER_STATUS.failed) {
            return new GPUDecoderParserError(this.exports.errorCode(this.handle) >>> 0, this.exports.errorValue(this.handle) >>> 0, this.errorNames);
        }
        return new RangeError(`parser ${call} status ${status}`);
    }

    /** Requires a configure, parse, or finish call's success. */
    private check(status: number, call: string): void {
        if (status !== GPU_DECODER_PARSER_STATUS.success) {
            throw this.createStatusFailure(status, call);
        }
    }
}
