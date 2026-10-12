// Generates the WGSL prelude of a user video decoder: its bindings, the structs they hold, and helpers over the packet ring and the frame pool.
// A decoder writes `@compute @workgroup_size(...)` on its own entry points, so the prelude generates no entry wrappers.
// A dispatch directive counts workgroups, which leaves the workgroup size to the module alone.
// overhual/decoders.md in the engine root describes the module format.
import type { FramePoolPlaneLayout } from '../../presentation/passes/PassResources';
import {
    getGPUDecoderFormatFacts,
    GPU_DECODER_OUTPUT_PLANE_COUNT,
    isGPUDecoderOutputFormat,
    type GPUDecoderFormatFacts
} from './GPUDecodeFormats';
import type { GPUDecoderManifest, GPUDecodeStreamFacts } from './GPUDecodeTypes';

const BYTES_PER_WORD = 4;
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

/** The bytes of the status buffer the engine reads back. */
export const GPU_DECODER_STATUS_BYTE_LENGTH = 48;

/** The byte offset of the freed-slot mask in the status buffer, which the engine clears after each readback copy. */
export const GPU_DECODER_STATUS_FREED_SLOT_MASK_BYTE_OFFSET = 4;

// Word indices of GPUDecodeStatus
const STATUS_ERROR_CODE_WORD = 0;
const STATUS_FREED_SLOT_MASK_WORD = 1;
const STATUS_HEADER_VALID_WORD = 2;
const STATUS_HEADER_WIDTH_WORD = 3;
const STATUS_HEADER_HEIGHT_WORD = 4;
const STATUS_HEADER_BIT_DEPTH_WORD = 5;
const STATUS_HEADER_VISIBLE_X_WORD = 6;
const STATUS_HEADER_VISIBLE_Y_WORD = 7;
const STATUS_HEADER_VISIBLE_WIDTH_WORD = 8;
const STATUS_HEADER_VISIBLE_HEIGHT_WORD = 9;

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
const PRELUDE_HELPER_NAMES = [
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
    'writeOutputSamples16',
    'writeOutputSamples8'
] as const;

/** Names the prelude declares, which a decoder's scratch buffers cannot take. */
export const GPU_DECODER_RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set<string>([
    ...Object.keys(GPU_DECODER_BINDINGS),
    ...PRELUDE_STRUCT_NAMES,
    ...PRELUDE_HELPER_NAMES
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
    freedSlotMask: atomic<u32>,
    headerValid: u32,
    headerWidth: u32,
    headerHeight: u32,
    headerBitDepth: u32,
    headerVisibleX: u32,
    headerVisibleY: u32,
    headerVisibleWidth: u32,
    headerVisibleHeight: u32,
    padding0: u32,
    padding1: u32,
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

const STATUS_HELPERS_WGSL = `// Ends the attempt once the engine reads the status back; the highest code reported wins
fn reportDecodeError(code: u32) {
    atomicMax(&status.errorCode, max(code, 1u));
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
}`;

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

/** What one status readback reports. */
export type GPUDecoderStatusValues = {
    /** 0 while the decoder reported no error. */
    errorCode: number
    /** Bit n set means slot n left the decoder's references since the previous readback. */
    freedSlotMask: number
    /** Stream facts the decoder parsed from a header, or null when it reported none. */
    headerFacts: GPUDecodeStreamFacts | null
};

/** A generated decoder module and where the decoder's body starts in it. */
export type GPUDecoderModule = {
    code: string
    /** The 1-based line of the module where the decoder's body starts. */
    firstBodyLine: number
};

/** Returns the WGSL extension a required device feature enables, or null when the feature has none. */
function getFeatureExtension(feature: string): string | null {
    switch (feature) {
        case 'shader-f16':
            return 'f16';
        case 'subgroups':
            return 'subgroups';
        default:
            return null;
    }
}

function createEnableDirectivesWGSL(requiredFeatures: readonly string[]): string[] {
    const directives: string[] = [];
    for (const feature of requiredFeatures) {
        const extension = getFeatureExtension(feature);
        if (extension) {
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

function createSampleWriteHelperWGSL(bytesPerSample: GPUDecoderFormatFacts['bytesPerSample']): string {
    switch (bytesPerSample) {
        case 1:
            return `// Writes four 8-bit samples of the output slot from x, a multiple of 4; one invocation owns each word
fn writeOutputSamples8(plane: u32, x: u32, y: u32, samples: vec4u) {
    let byteAddress = getSampleByteAddress(packet.outputSlot, plane, x & ~3u, y);
    framePool[byteAddress >> 2u] = (samples.x & 0xFFu)
        | ((samples.y & 0xFFu) << 8u)
        | ((samples.z & 0xFFu) << 16u)
        | ((samples.w & 0xFFu) << 24u);
}`;
        case 2:
            return `// Writes two 16-bit samples of the output slot from x, a multiple of 2; one invocation owns each word
fn writeOutputSamples16(plane: u32, x: u32, y: u32, samples: vec2u) {
    let byteAddress = getSampleByteAddress(packet.outputSlot, plane, x & ~1u, y);
    framePool[byteAddress >> 2u] = (samples.x & 0xFFFFu) | ((samples.y & 0xFFFFu) << 16u);
}`;
    }
}

function createPoolHelpersWGSL(formatFacts: GPUDecoderFormatFacts): string {
    const sampleMask = formatFacts.bytesPerSample === 1 ? '0xFFu' : '0xFFFFu';
    return `// The byte address of sample (x, y) of a plane in a pool slot
fn getSampleByteAddress(slot: u32, plane: u32, x: u32, y: u32) -> u32 {
    let planeLayout = stream.planes[plane];
    return slot * stream.slotByteLength + planeLayout.byteOffset + y * planeLayout.bytesPerRow + x * ${formatFacts.bytesPerSample}u;
}

fn readSlotSample(slot: u32, plane: u32, x: u32, y: u32) -> u32 {
    let byteAddress = getSampleByteAddress(slot, plane, x, y);
    return (framePool[byteAddress >> 2u] >> ((byteAddress & 3u) * 8u)) & ${sampleMask};
}

// Reads a sample of a slot the decoder holds as a reference
fn readReferenceSample(slot: u32, plane: u32, x: u32, y: u32) -> u32 {
    return readSlotSample(slot, plane, x, y);
}

// Reads back a sample an earlier dispatch wrote into the output slot
fn readOutputSample(plane: u32, x: u32, y: u32) -> u32 {
    return readSlotSample(packet.outputSlot, plane, x, y);
}

${createSampleWriteHelperWGSL(formatFacts.bytesPerSample)}`;
}

/** Returns the prelude a decoder's body is compiled after: enable directives, structs, bindings, and helpers. */
export function createGPUDecoderPrelude(manifest: GPUDecoderManifest): string {
    if (!isGPUDecoderOutputFormat(manifest.outputFormat)) {
        throw new RangeError(`A GPU decoder cannot write ${manifest.outputFormat}`);
    }
    const sections: string[] = [];
    const enableDirectives = createEnableDirectivesWGSL(manifest.requiredFeatures);
    if (enableDirectives.length > 0) {
        sections.push(enableDirectives.join('\n'));
    }
    sections.push('// Generated by the engine: the bindings and helpers of a GPU video decoder');
    sections.push(PRELUDE_STRUCTS_WGSL);
    sections.push(createBindingsWGSL(manifest.buffers.map(buffer => buffer.name)));
    sections.push(PACKET_HELPERS_WGSL);
    sections.push(createPoolHelpersWGSL(getGPUDecoderFormatFacts(manifest.outputFormat)));
    sections.push(STATUS_HELPERS_WGSL);
    return sections.join('\n\n');
}

/** Returns the decoder's complete module, its prelude followed by its body. */
export function createGPUDecoderModule(manifest: GPUDecoderManifest): GPUDecoderModule {
    const prelude = createGPUDecoderPrelude(manifest);
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
        throw new RangeError(`A GPU decoder slot holds ${GPU_DECODER_OUTPUT_PLANE_COUNT} planes`);
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
        throw new RangeError('A GPU decoder status readback is too short');
    }
    const headerFacts: GPUDecodeStreamFacts | null = words[STATUS_HEADER_VALID_WORD] === 0 ?
        null :
        {
            bitDepth: words[STATUS_HEADER_BIT_DEPTH_WORD],
            codedHeight: words[STATUS_HEADER_HEIGHT_WORD],
            codedWidth: words[STATUS_HEADER_WIDTH_WORD],
            visibleRectangle: {
                height: words[STATUS_HEADER_VISIBLE_HEIGHT_WORD],
                width: words[STATUS_HEADER_VISIBLE_WIDTH_WORD],
                x: words[STATUS_HEADER_VISIBLE_X_WORD],
                y: words[STATUS_HEADER_VISIBLE_Y_WORD]
            }
        };
    return {
        errorCode: words[STATUS_ERROR_CODE_WORD],
        freedSlotMask: words[STATUS_FREED_SLOT_MASK_WORD],
        headerFacts
    };
}
