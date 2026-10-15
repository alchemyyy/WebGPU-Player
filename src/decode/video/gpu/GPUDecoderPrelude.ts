// Generates the WGSL prelude of a user video decoder: its bindings, the structs they hold, and helpers over the packet ring and the frame pool.
// A decoder writes `@compute @workgroup_size(...)` on its own entry points, so the prelude generates no entry wrappers.
// A dispatch directive counts workgroups, which leaves the workgroup size to the module alone.
// The engine book's decoder packages chapter describes the module format.
import type { FramePoolPlaneLayout } from '../../../presentation/passes/PassResources';
import { BYTES_PER_WORD, WGSL_FEATURE_EXTENSIONS } from '../../../presentation/WebGPUConstants';
import { PICTURE_FIELDS_WORD } from '../VideoFields';
import {
    getGPUDecoderFormatFacts,
    GPU_DECODER_OUTPUT_PLANE_COUNT,
    type GPUDecoderFormatFacts,
    type GPUDecoderOutputFormat
} from './GPUDecodeFormats';
import { GPU_DECODER_ERROR_CODE_SHIFT } from './GPUDecodeLimits';
import {
    GPU_DECODER_ERROR_RECOVERIES,
    type GPUDecoderErrorRecovery,
    type GPUDecoderManifest,
    type GPUDecodeStreamFacts
} from './GPUDecodeTypes';

const PLANE_UNIFORM_WORD_COUNT = 4;
const PLANE_ARRAY_WORD_COUNT = GPU_DECODER_OUTPUT_PLANE_COUNT * PLANE_UNIFORM_WORD_COUNT;

/** The group 0 binding of each engine-owned decoder binding; named scratch buffers follow in declaration order. */
export const GPU_DECODER_BINDINGS = {
    config: 2,
    framePool: 5,
    packet: 1,
    packetBytes: 0,
    state: 4,
    status: 6,
    stream: 3
} as const;

/** The binding of the first named scratch buffer. */
export const GPU_DECODER_FIRST_BUFFER_BINDING = 7;

/** The bytes of the per-packet uniform, which one buffer holds per packet at dynamic offsets. */
export const GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH = 32;

/** The bytes of the stream uniform. */
export const GPU_DECODER_STREAM_UNIFORM_BYTE_LENGTH = 80;

/** The bytes of the status buffer the engine reads back, after each packet. */
export const GPU_DECODER_STATUS_BYTE_LENGTH = 48;

/**
 * Word indices of GPUDecodeStatus: the fatal error and the header facts last until a reset clears the status;
 * the packet's block, from the freed slots on, holds one packet's reports, and the engine clears it after each packet's copy.
 */
export const GPU_DECODER_STATUS_WORDS = Object.freeze({
    errorCode: 0,
    freedSlotMask: 9,
    headerBitDepth: 4,
    headerHeight: 3,
    headerValid: 1,
    headerVisibleHeight: 8,
    headerVisibleWidth: 7,
    headerVisibleX: 5,
    headerVisibleY: 6,
    headerWidth: 2,
    pictureError: 10,
    pictureFields: 11
});

/** The byte offset of the packet's block in the status buffer: its freed slots, its picture's error, and its picture's fields. */
export const GPU_DECODER_STATUS_PACKET_BLOCK_BYTE_OFFSET = GPU_DECODER_STATUS_WORDS.freedSlotMask * BYTES_PER_WORD;

/** The bytes of the packet's block, which runs to the end of the status. */
export const GPU_DECODER_STATUS_PACKET_BLOCK_BYTE_LENGTH = GPU_DECODER_STATUS_BYTE_LENGTH - GPU_DECODER_STATUS_PACKET_BLOCK_BYTE_OFFSET;

/** The rank the prelude gives a fatal error; each recovery ranks its position in GPU_DECODER_ERROR_RECOVERIES plus one. */
const FATAL_RECOVERY_RANK = 0;

// Word indices of GPUDecodePacket
const PACKET_BYTE_OFFSET_WORD = 0;
const PACKET_BYTE_LENGTH_WORD = 1;
const PACKET_INDEX_WORD = 2;
const PACKET_KEYFRAME_WORD = 3;
const PACKET_RESET_WORD = 4;
const PACKET_OUTPUT_SLOT_WORD = 5;

// Word indices of GPUDecodeStream after its plane array
const STREAM_WIDTH_WORD = PLANE_ARRAY_WORD_COUNT;
const STREAM_HEIGHT_WORD = PLANE_ARRAY_WORD_COUNT + 1;
const STREAM_BIT_DEPTH_WORD = PLANE_ARRAY_WORD_COUNT + 2;
const STREAM_BYTES_PER_SAMPLE_WORD = PLANE_ARRAY_WORD_COUNT + 3;
const STREAM_PLANE_COUNT_WORD = PLANE_ARRAY_WORD_COUNT + 4;
const STREAM_SLOT_BYTE_LENGTH_WORD = PLANE_ARRAY_WORD_COUNT + 5;
const STREAM_SLOT_COUNT_WORD = PLANE_ARRAY_WORD_COUNT + 6;
const STREAM_CONFIG_BYTE_LENGTH_WORD = PLANE_ARRAY_WORD_COUNT + 7;

const PRELUDE_STRUCT_NAMES = [ 'GPUDecodePacket', 'GPUDecodePlane', 'GPUDecodeStatus', 'GPUDecodeStream' ] as const;
// The output format's facts, declared for the format a session decodes into, so one decoder source serves every format it lists
const PRELUDE_FORMAT_CONSTANT_NAMES = [ 'OUTPUT_BIT_DEPTH', 'OUTPUT_CHROMA_FORMAT', 'SAMPLE_BYTES', 'SAMPLES_PER_WORD', 'SAMPLE_MASK' ] as const;
// The status helpers' constants: the recovery ranks, fatal first, and the bits of the picture fields word
const RECOVERY_RANK_CONSTANT_NAMES: Readonly<Record<GPUDecoderErrorRecovery | 'fatal', string>> = Object.freeze({
    conceal: 'DECODE_ERROR_RECOVERY_CONCEAL',
    drop: 'DECODE_ERROR_RECOVERY_DROP',
    fatal: 'DECODE_ERROR_RECOVERY_FATAL',
    resync: 'DECODE_ERROR_RECOVERY_RESYNC'
});
const PICTURE_FIELDS_CONSTANT_NAMES = Object.freeze({
    interlacedBit: 'PICTURE_FIELDS_INTERLACED_BIT',
    repeatFirstFieldBit: 'PICTURE_FIELDS_REPEAT_FIRST_FIELD_BIT',
    reportedBit: 'PICTURE_FIELDS_REPORTED_BIT',
    topFieldFirstBit: 'PICTURE_FIELDS_TOP_FIELD_FIRST_BIT'
});
const PRELUDE_STATUS_CONSTANT_NAMES = [ ...Object.values(RECOVERY_RANK_CONSTANT_NAMES), ...Object.values(PICTURE_FIELDS_CONSTANT_NAMES) ];
// chroma_format_idc: 4:2:0, 4:2:2, and 4:4:4
const CHROMA_FORMAT_420 = 1;
const CHROMA_FORMAT_422 = 2;
const CHROMA_FORMAT_444 = 3;
const PRELUDE_HELPER_NAMES = [
    'getDecodeErrorRecovery',
    'getSampleByteAddress',
    'readConfigByte',
    'readOutputSample',
    'readPacketByte',
    'readPacketWord',
    'readReferenceSample',
    'readSlotSample',
    'releaseReferenceSlot',
    'reportDecodeError',
    'reportHeaderFacts',
    'reportPictureFields',
    'writeOutputSamples16',
    'writeOutputSamples8'
] as const;

/** Names the prelude declares, which a decoder's scratch buffers cannot take. */
export const GPU_DECODER_RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set<string>([
    ...Object.keys(GPU_DECODER_BINDINGS),
    ...PRELUDE_STRUCT_NAMES,
    ...PRELUDE_HELPER_NAMES,
    ...PRELUDE_FORMAT_CONSTANT_NAMES,
    ...PRELUDE_STATUS_CONSTANT_NAMES
]);

const PRELUDE_STRUCTS_WGSL = `struct GPUDecodePacket {
    byteOffset: u32,
    byteLength: u32,
    index: u32,
    keyframe: u32,
    reset: u32,
    outputSlot: u32,
    padding0: u32,
    padding1: u32,
}

struct GPUDecodePlane {
    byteOffset: u32,
    bytesPerRow: u32,
    width: u32,
    height: u32,
}

struct GPUDecodeStream {
    planes: array<GPUDecodePlane, ${GPU_DECODER_OUTPUT_PLANE_COUNT}>,
    width: u32,
    height: u32,
    bitDepth: u32,
    bytesPerSample: u32,
    planeCount: u32,
    slotByteLength: u32,
    slotCount: u32,
    configByteLength: u32,
}

struct GPUDecodeStatus {
    errorCode: atomic<u32>,
    headerValid: u32,
    headerWidth: u32,
    headerHeight: u32,
    headerBitDepth: u32,
    headerVisibleX: u32,
    headerVisibleY: u32,
    headerVisibleWidth: u32,
    headerVisibleHeight: u32,
    freedSlotMask: atomic<u32>,
    pictureError: atomic<u32>,
    pictureFields: u32,
}`;

const PACKET_HELPERS_WGSL = `// Reads one byte of the current packet
fn readPacketByte(byteIndex: u32) -> u32 {
    let byteAddress = packet.byteOffset + byteIndex;
    return (packetBytes[byteAddress >> 2u] >> ((byteAddress & 3u) * 8u)) & 0xFFu;
}

// Reads one little-endian word of the current packet, which starts on a word boundary
fn readPacketWord(wordIndex: u32) -> u32 {
    return packetBytes[(packet.byteOffset >> 2u) + wordIndex];
}

// Reads one byte of the codec private data from the container
fn readConfigByte(byteIndex: u32) -> u32 {
    return (config[byteIndex >> 2u] >> ((byteIndex & 3u) * 8u)) & 0xFFu;
}`;

const STATUS_FIXED_HELPERS_WGSL = `// Reports an error word, (code << ${GPU_DECODER_ERROR_CODE_SHIFT}) | value. A code the header declares recoverable marks the packet's picture,
// which keeps its most severe word, by recovery and then by word; any other ends the attempt once the engine reads the status back, the highest word winning
fn reportDecodeError(word: u32) {
    let errorWord = max(word, 1u);
    let recovery = getDecodeErrorRecovery(errorWord >> ${GPU_DECODER_ERROR_CODE_SHIFT}u);
    if (recovery == ${RECOVERY_RANK_CONSTANT_NAMES.fatal}) {
        atomicMax(&status.errorCode, errorWord);
        return;
    }
    var current = atomicLoad(&status.pictureError);
    loop {
        let currentRecovery = getDecodeErrorRecovery(current >> ${GPU_DECODER_ERROR_CODE_SHIFT}u);
        if (current != 0u && (currentRecovery > recovery || (currentRecovery == recovery && current >= errorWord))) {
            return;
        }
        let exchange = atomicCompareExchangeWeak(&status.pictureError, current, errorWord);
        if (exchange.exchanged) {
            return;
        }
        current = exchange.old_value;
    }
}

// Hands a reference slot back to the engine; a decoder with references holds every output slot until it releases it
fn releaseReferenceSlot(slot: u32) {
    atomicOr(&status.freedSlotMask, 1u << slot);
}

// Reports stream facts parsed from a frame header; call it from one invocation
fn reportHeaderFacts(width: u32, height: u32, bitDepth: u32, visibleRectangle: vec4u) {
    status.headerWidth = width;
    status.headerHeight = height;
    status.headerBitDepth = bitDepth;
    status.headerVisibleX = visibleRectangle.x;
    status.headerVisibleY = visibleRectangle.y;
    status.headerVisibleWidth = visibleRectangle.z;
    status.headerVisibleHeight = visibleRectangle.w;
    status.headerValid = 1u;
}

// Reports the packet's picture fields: whether its frame is interlaced, which field comes first, and whether a progressive frame repeats its
// first field; call it from one invocation; a packet that reports none keeps the fields its container or parser gave
fn reportPictureFields(interlaced: bool, topFieldFirst: bool, repeatFirstField: bool) {
    status.pictureFields = ${PICTURE_FIELDS_CONSTANT_NAMES.reportedBit}
        | select(0u, ${PICTURE_FIELDS_CONSTANT_NAMES.interlacedBit}, interlaced)
        | select(0u, ${PICTURE_FIELDS_CONSTANT_NAMES.topFieldFirstBit}, topFieldFirst)
        | select(0u, ${PICTURE_FIELDS_CONSTANT_NAMES.repeatFirstFieldBit}, repeatFirstField);
}`;

/** Returns a recovery's rank in the prelude: its position among the recoveries plus one, so a fatal error ranks lowest. */
export function getGPUDecoderErrorRecoveryRank(recovery: GPUDecoderErrorRecovery | null): number {
    return recovery === null ? FATAL_RECOVERY_RANK : GPU_DECODER_ERROR_RECOVERIES.indexOf(recovery) + 1;
}

/** Declares the recovery ranks and the picture fields bits the status helpers use. */
function createStatusConstantsWGSL(): string {
    const lines: string[] = [ '// The recovery of an error code, in rising severity, and the bits of the picture fields word' ];
    lines.push(`const ${RECOVERY_RANK_CONSTANT_NAMES.fatal}: u32 = ${FATAL_RECOVERY_RANK}u;`);
    for (const recovery of GPU_DECODER_ERROR_RECOVERIES) {
        lines.push(`const ${RECOVERY_RANK_CONSTANT_NAMES[recovery]}: u32 = ${getGPUDecoderErrorRecoveryRank(recovery)}u;`);
    }
    lines.push(`const ${PICTURE_FIELDS_CONSTANT_NAMES.reportedBit}: u32 = ${PICTURE_FIELDS_WORD.reportedBit}u;`);
    lines.push(`const ${PICTURE_FIELDS_CONSTANT_NAMES.interlacedBit}: u32 = ${PICTURE_FIELDS_WORD.interlacedBit}u;`);
    lines.push(`const ${PICTURE_FIELDS_CONSTANT_NAMES.topFieldFirstBit}: u32 = ${PICTURE_FIELDS_WORD.topFieldFirstBit}u;`);
    lines.push(`const ${PICTURE_FIELDS_CONSTANT_NAMES.repeatFirstFieldBit}: u32 = ${PICTURE_FIELDS_WORD.repeatFirstFieldBit}u;`);
    return lines.join('\n');
}

/** Generates getDecodeErrorRecovery from the header's error lines: each recovery's codes in one case, every other code fatal. */
function createErrorRecoveryWGSL(errorRecoveries: ReadonlyMap<number, GPUDecoderErrorRecovery>): string {
    const lines: string[] = [ '// The recovery the header declares for an error code; a code without one is fatal' ];
    lines.push('fn getDecodeErrorRecovery(code: u32) -> u32 {');
    lines.push('    switch (code) {');
    for (const recovery of GPU_DECODER_ERROR_RECOVERIES) {
        const selectors = [ ...errorRecoveries ]
            .filter(([ , codeRecovery ]: [ number, GPUDecoderErrorRecovery ]): boolean => codeRecovery === recovery)
            .map(([ code ]: [ number, GPUDecoderErrorRecovery ]): number => code)
            .sort((first: number, second: number): number => first - second)
            .map((code: number): string => String(code) + 'u');
        if (selectors.length > 0) {
            lines.push(`        case ${selectors.join(', ')}: {`);
            lines.push(`            return ${RECOVERY_RANK_CONSTANT_NAMES[recovery]};`);
            lines.push('        }');
        }
    }
    lines.push('        default: {');
    lines.push(`            return ${RECOVERY_RANK_CONSTANT_NAMES.fatal};`);
    lines.push('        }');
    lines.push('    }');
    lines.push('}');
    return lines.join('\n');
}

/** Returns the status helpers of a decoder: its constants, its generated recovery lookup, and the fixed helpers. */
function createStatusHelpersWGSL(manifest: GPUDecoderManifest): string {
    return [ createStatusConstantsWGSL(), createErrorRecoveryWGSL(manifest.errorRecoveries), STATUS_FIXED_HELPERS_WGSL ].join('\n\n');
}

/** The values of the per-packet uniform. */
export type GPUDecoderPacketUniformValues = {
    byteLength: number
    /** The packet's offset in the packet ring, a multiple of 4. */
    byteOffset: number
    /** Decode order since the session started, wrapping at 2^32. */
    index: number
    keyframe: boolean
    outputSlot: number
    reset: boolean
};

/** The values of the stream uniform. */
export type GPUDecoderStreamUniformValues = {
    bitDepth: number
    bytesPerSample: 1 | 2
    configByteLength: number
    height: number
    planes: readonly FramePoolPlaneLayout[]
    slotByteLength: number
    slotCount: number
    width: number
};

/** What one packet's status readback reports. */
export type GPUDecoderStatusValues = {
    /** The highest fatal error word since the last reset, 0 while the decoder reported none. */
    errorCode: number
    /** Bit n set means slot n left the decoder's references during the packet. */
    freedSlotMask: number
    /** Stream facts the decoder parsed from a header, or null when it reported none. */
    headerFacts: GPUDecodeStreamFacts | null
    /** The most severe recoverable error word the packet's picture reported, or 0. */
    pictureError: number
    /** The picture fields word the packet reported, 0 for none. */
    pictureFields: number
};

/** A generated decoder module and where the decoder's body starts in it. */
export type GPUDecoderModule = {
    code: string
    /** The 1-based line of the module where the decoder's body starts. */
    firstBodyLine: number
};

/** Returns the enable directives of the required features that have a WGSL extension, in requirement order. */
function createEnableDirectivesWGSL(requiredFeatures: readonly string[]): string[] {
    const directives: string[] = [];
    for (const feature of requiredFeatures) {
        const extension = WGSL_FEATURE_EXTENSIONS.get(feature);
        if (extension !== undefined) {
            directives.push(`enable ${extension};`);
        }
    }
    return directives;
}

function createBindingsWGSL(bufferNames: readonly string[]): string {
    const bindings: string[] = [];
    bindings.push(`@group(0) @binding(${GPU_DECODER_BINDINGS.packetBytes}) var<storage, read> packetBytes: array<u32>;`);
    bindings.push(`@group(0) @binding(${GPU_DECODER_BINDINGS.packet}) var<uniform> packet: GPUDecodePacket;`);
    bindings.push(`@group(0) @binding(${GPU_DECODER_BINDINGS.config}) var<storage, read> config: array<u32>;`);
    bindings.push(`@group(0) @binding(${GPU_DECODER_BINDINGS.stream}) var<uniform> stream: GPUDecodeStream;`);
    bindings.push(`@group(0) @binding(${GPU_DECODER_BINDINGS.state}) var<storage, read_write> state: array<u32>;`);
    bindings.push(`@group(0) @binding(${GPU_DECODER_BINDINGS.framePool}) var<storage, read_write> framePool: array<u32>;`);
    bindings.push(`@group(0) @binding(${GPU_DECODER_BINDINGS.status}) var<storage, read_write> status: GPUDecodeStatus;`);
    for (let bufferIndex = 0; bufferIndex < bufferNames.length; bufferIndex += 1) {
        const binding = GPU_DECODER_FIRST_BUFFER_BINDING + bufferIndex;
        bindings.push(`@group(0) @binding(${binding}) var<storage, read_write> ${bufferNames[bufferIndex]}: array<u32>;`);
    }
    return bindings.join('\n');
}

// Both sample writers are declared for every format, so one body serves every format it declares by branching on SAMPLE_BYTES;
// a body calls only the writer of the session's sample size
const SAMPLE_WRITE_HELPERS_WGSL = `// Writes four 8-bit samples of the output slot from x, a multiple of 4; one invocation owns each word
fn writeOutputSamples8(plane: u32, x: u32, y: u32, samples: vec4u) {
    let byteAddress = getSampleByteAddress(packet.outputSlot, plane, x & ~3u, y);
    framePool[byteAddress >> 2u] = (samples.x & 0xFFu)
        | ((samples.y & 0xFFu) << 8u)
        | ((samples.z & 0xFFu) << 16u)
        | ((samples.w & 0xFFu) << 24u);
}

// Writes two 16-bit samples of the output slot from x, a multiple of 2; one invocation owns each word
fn writeOutputSamples16(plane: u32, x: u32, y: u32, samples: vec2u) {
    let byteAddress = getSampleByteAddress(packet.outputSlot, plane, x & ~1u, y);
    framePool[byteAddress >> 2u] = (samples.x & 0xFFFFu) | ((samples.y & 0xFFFFu) << 16u);
}`;

const POOL_HELPERS_WGSL = `// The byte address of sample (x, y) of a plane in a pool slot
fn getSampleByteAddress(slot: u32, plane: u32, x: u32, y: u32) -> u32 {
    let planeLayout = stream.planes[plane];
    return slot * stream.slotByteLength + planeLayout.byteOffset + y * planeLayout.bytesPerRow + x * SAMPLE_BYTES;
}

fn readSlotSample(slot: u32, plane: u32, x: u32, y: u32) -> u32 {
    let byteAddress = getSampleByteAddress(slot, plane, x, y);
    return (framePool[byteAddress >> 2u] >> ((byteAddress & 3u) * 8u)) & SAMPLE_MASK;
}

// Reads a sample of a slot the decoder holds as a reference
fn readReferenceSample(slot: u32, plane: u32, x: u32, y: u32) -> u32 {
    return readSlotSample(slot, plane, x, y);
}

// Reads back a sample an earlier dispatch wrote into the output slot
fn readOutputSample(plane: u32, x: u32, y: u32) -> u32 {
    return readSlotSample(packet.outputSlot, plane, x, y);
}

${SAMPLE_WRITE_HELPERS_WGSL}`;

function getChromaFormat(formatFacts: GPUDecoderFormatFacts): number {
    if (formatFacts.chromaHeightDivisor === 2) {
        return CHROMA_FORMAT_420;
    }
    return formatFacts.chromaWidthDivisor === 2 ? CHROMA_FORMAT_422 : CHROMA_FORMAT_444;
}

/** Declares the output format's facts as constants: its bit depth, chroma_format_idc, and how its samples pack into words. */
function createFormatConstantsWGSL(formatFacts: GPUDecoderFormatFacts): string {
    const samplesPerWord = BYTES_PER_WORD / formatFacts.bytesPerSample;
    return [
        '// The output format of this session',
        `const OUTPUT_BIT_DEPTH: u32 = ${formatFacts.bitDepth}u;`,
        `const OUTPUT_CHROMA_FORMAT: u32 = ${getChromaFormat(formatFacts)}u;`,
        `const SAMPLE_BYTES: u32 = ${formatFacts.bytesPerSample}u;`,
        `const SAMPLES_PER_WORD: u32 = ${samplesPerWord}u;`,
        `const SAMPLE_MASK: u32 = ${formatFacts.bytesPerSample === 1 ? '0xFFu' : '0xFFFFu'};`
    ].join('\n');
}

/** Returns the prelude a decoder's body is compiled after for one output format: enable directives, format constants, structs, bindings, and helpers. */
export function createGPUDecoderPrelude(manifest: GPUDecoderManifest, format: GPUDecoderOutputFormat): string {
    const formatFacts = getGPUDecoderFormatFacts(format);
    const sections: string[] = [];
    const enableDirectives = createEnableDirectivesWGSL(manifest.requiredFeatures);
    if (enableDirectives.length > 0) {
        sections.push(enableDirectives.join('\n'));
    }
    sections.push('// Generated by the engine: the bindings and helpers of a GPU video decoder');
    sections.push(createFormatConstantsWGSL(formatFacts));
    sections.push(PRELUDE_STRUCTS_WGSL);
    sections.push(createBindingsWGSL(manifest.buffers.map(buffer => buffer.name)));
    sections.push(PACKET_HELPERS_WGSL);
    sections.push(POOL_HELPERS_WGSL);
    sections.push(createStatusHelpersWGSL(manifest));
    return sections.join('\n\n');
}

/** Returns the decoder's complete module for one of its output formats, its prelude followed by its body. */
export function createGPUDecoderModule(manifest: GPUDecoderManifest, format: GPUDecoderOutputFormat): GPUDecoderModule {
    const prelude = createGPUDecoderPrelude(manifest, format);
    const preludeLineCount = prelude.split('\n').length;
    return {
        code: `${prelude}\n${manifest.body}`,
        firstBodyLine: preludeLineCount + 1
    };
}

/** Returns the bind group layout entries of a decoder with bufferCount named scratch buffers, in binding order. */
export function createGPUDecoderBindGroupLayoutEntries(bufferCount: number): GPUBindGroupLayoutEntry[] {
    const visibility = GPUShaderStage.COMPUTE;
    const entries: GPUBindGroupLayoutEntry[] = [];
    entries.push({ binding: GPU_DECODER_BINDINGS.packetBytes, buffer: { type: 'read-only-storage' }, visibility });
    entries.push({
        binding: GPU_DECODER_BINDINGS.packet,
        buffer: { hasDynamicOffset: true, minBindingSize: GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH, type: 'uniform' },
        visibility
    });
    entries.push({ binding: GPU_DECODER_BINDINGS.config, buffer: { type: 'read-only-storage' }, visibility });
    entries.push({ binding: GPU_DECODER_BINDINGS.stream, buffer: { type: 'uniform' }, visibility });
    entries.push({ binding: GPU_DECODER_BINDINGS.state, buffer: { type: 'storage' }, visibility });
    entries.push({ binding: GPU_DECODER_BINDINGS.framePool, buffer: { type: 'storage' }, visibility });
    entries.push({ binding: GPU_DECODER_BINDINGS.status, buffer: { type: 'storage' }, visibility });
    for (let bufferIndex = 0; bufferIndex < bufferCount; bufferIndex += 1) {
        entries.push({ binding: GPU_DECODER_FIRST_BUFFER_BINDING + bufferIndex, buffer: { type: 'storage' }, visibility });
    }
    return entries;
}

/** Writes the per-packet uniform, in the field order of GPUDecodePacket. */
export function writeGPUDecoderPacketUniform(target: Uint32Array, values: GPUDecoderPacketUniformValues): void {
    target[PACKET_BYTE_OFFSET_WORD] = values.byteOffset;
    target[PACKET_BYTE_LENGTH_WORD] = values.byteLength;
    target[PACKET_INDEX_WORD] = values.index;
    target[PACKET_KEYFRAME_WORD] = values.keyframe ? 1 : 0;
    target[PACKET_RESET_WORD] = values.reset ? 1 : 0;
    target[PACKET_OUTPUT_SLOT_WORD] = values.outputSlot;
}

/** Writes the stream uniform, in the field order of GPUDecodeStream. */
export function writeGPUDecoderStreamUniform(target: Uint32Array, values: GPUDecoderStreamUniformValues): void {
    if (values.planes.length !== GPU_DECODER_OUTPUT_PLANE_COUNT) {
        throw new RangeError(`planes: ${values.planes.length}, expected ${GPU_DECODER_OUTPUT_PLANE_COUNT}`);
    }
    for (let planeIndex = 0; planeIndex < values.planes.length; planeIndex += 1) {
        const plane = values.planes[planeIndex];
        const firstWord = planeIndex * PLANE_UNIFORM_WORD_COUNT;
        target[firstWord] = plane.byteOffset;
        target[firstWord + 1] = plane.bytesPerRow;
        target[firstWord + 2] = plane.width;
        target[firstWord + 3] = plane.height;
    }
    target[STREAM_WIDTH_WORD] = values.width;
    target[STREAM_HEIGHT_WORD] = values.height;
    target[STREAM_BIT_DEPTH_WORD] = values.bitDepth;
    target[STREAM_BYTES_PER_SAMPLE_WORD] = values.bytesPerSample;
    target[STREAM_PLANE_COUNT_WORD] = values.planes.length;
    target[STREAM_SLOT_BYTE_LENGTH_WORD] = values.slotByteLength;
    target[STREAM_SLOT_COUNT_WORD] = values.slotCount;
    target[STREAM_CONFIG_BYTE_LENGTH_WORD] = values.configByteLength;
}

/** Reads one status readback, in the field order of GPUDecodeStatus. */
export function readGPUDecoderStatus(words: Uint32Array): GPUDecoderStatusValues {
    if (words.length * BYTES_PER_WORD < GPU_DECODER_STATUS_BYTE_LENGTH) {
        throw new RangeError(`status: ${words.length * BYTES_PER_WORD} < ${GPU_DECODER_STATUS_BYTE_LENGTH}`);
    }
    const headerFacts: GPUDecodeStreamFacts | null = words[GPU_DECODER_STATUS_WORDS.headerValid] === 0 ?
        null :
        {
            bitDepth: words[GPU_DECODER_STATUS_WORDS.headerBitDepth],
            codedHeight: words[GPU_DECODER_STATUS_WORDS.headerHeight],
            codedWidth: words[GPU_DECODER_STATUS_WORDS.headerWidth],
            visibleRectangle: {
                height: words[GPU_DECODER_STATUS_WORDS.headerVisibleHeight],
                width: words[GPU_DECODER_STATUS_WORDS.headerVisibleWidth],
                x: words[GPU_DECODER_STATUS_WORDS.headerVisibleX],
                y: words[GPU_DECODER_STATUS_WORDS.headerVisibleY]
            }
        };
    return {
        errorCode: words[GPU_DECODER_STATUS_WORDS.errorCode],
        freedSlotMask: words[GPU_DECODER_STATUS_WORDS.freedSlotMask],
        headerFacts,
        pictureError: words[GPU_DECODER_STATUS_WORDS.pictureError],
        pictureFields: words[GPU_DECODER_STATUS_WORDS.pictureFields]
    };
}
