import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    BYTES_PER_WORD,
    INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH,
    SHADER_F16_FEATURE,
    SUBGROUPS_FEATURE
} from 'webgpu-player/presentation/WebGPUConstants';
import { GPU_DECODER_OUTPUT_FORMATS, type GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { parseGPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import {
    createGPUDecoderBindGroupLayoutEntries,
    createGPUDecoderModule,
    createGPUDecoderPrelude,
    GPU_DECODER_BINDINGS,
    GPU_DECODER_FIRST_BUFFER_BINDING,
    GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH,
    GPU_DECODER_RESERVED_IDENTIFIERS,
    GPU_DECODER_STATUS_BYTE_LENGTH,
    GPU_DECODER_STATUS_FREED_SLOT_MASK_BYTE_OFFSET,
    GPU_DECODER_STREAM_UNIFORM_BYTE_LENGTH,
    readGPUDecoderStatus,
    writeGPUDecoderPacketUniform,
    writeGPUDecoderStreamUniform
} from 'webgpu-player/decode/video/gpu/GPUDecoderPrelude';
import type { GPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';

import { installWebGPUGlobals } from './webGPUGlobals';

const COMPUTE_STAGE = 4;
const PACKET_BYTE_OFFSET = 1024;
const PACKET_BYTE_LENGTH = 777;
const PACKET_INDEX = 41;
const OUTPUT_SLOT = 3;
const STREAM_WIDTH = 1920;
const STREAM_HEIGHT = 1080;
const CHROMA_WIDTH = 960;
const CHROMA_HEIGHT = 540;
const LUMA_BYTES_PER_ROW = 2048;
const CHROMA_BYTES_PER_ROW = 1024;
const CHROMA_U_BYTE_OFFSET = LUMA_BYTES_PER_ROW * STREAM_HEIGHT;
const CHROMA_V_BYTE_OFFSET = CHROMA_U_BYTE_OFFSET + CHROMA_BYTES_PER_ROW * CHROMA_HEIGHT;
const SLOT_BYTE_LENGTH = CHROMA_V_BYTE_OFFSET + CHROMA_BYTES_PER_ROW * CHROMA_HEIGHT;
const SLOT_COUNT = 5;
const CONFIG_BYTE_LENGTH = 38;
const EIGHT_BIT_DEPTH = 8;
const ERROR_CODE = 7;
const FREED_SLOT_MASK = 0b1010;
const HEADER_WIDTH = 1920;
const HEADER_HEIGHT = 1088;
const HEADER_BIT_DEPTH = 10;
const HEADER_VISIBLE_HEIGHT = 1080;
// A feature without a WGSL extension, which opens no enable directive
const FEATURE_WITHOUT_EXTENSION = 'timestamp-query';
const EXPECTED_ENABLE_DIRECTIVES = 'enable f16;\nenable subgroups;\n';
const CODEC_FAMILY = 'uncompressed';
const EIGHT_BIT_FORMAT: GPUDecoderOutputFormat = 'I420';
const SIXTEEN_BIT_FORMAT: GPUDecoderOutputFormat = 'I422P10';
// Every format, so one manifest's prelude can be generated for each
const ALL_FORMATS_OUTPUT = GPU_DECODER_OUTPUT_FORMATS.join(', ');
const BODY = `
@compute @workgroup_size(64)
fn copyPlanes(@builtin(global_invocation_id) id: vec3u) {
}`;

// chroma_format_idc of 4:2:0, 4:2:2, and 4:4:4
const CHROMA_FORMAT_420 = 1;
const CHROMA_FORMAT_422 = 2;
const CHROMA_FORMAT_444 = 3;
const EIGHT_BIT_SAMPLE_MASK = '0xFFu';
const SIXTEEN_BIT_SAMPLE_MASK = '0xFFFFu';
const FORMAT_CONSTANT_NAMES = [ 'OUTPUT_BIT_DEPTH', 'OUTPUT_CHROMA_FORMAT', 'SAMPLE_BYTES', 'SAMPLES_PER_WORD', 'SAMPLE_MASK' ];
const EIGHT_BIT_WRITER_DECLARATION = 'fn writeOutputSamples8(plane: u32, x: u32, y: u32, samples: vec4u)';
const SIXTEEN_BIT_WRITER_DECLARATION = 'fn writeOutputSamples16(plane: u32, x: u32, y: u32, samples: vec2u)';

/** One output format's constants as the prelude declares them: bit depth, chroma_format_idc, bytes per sample, samples per word, and the sample mask. */
type FormatConstantsCase = readonly [GPUDecoderOutputFormat, number, number, number, number, string];

const FORMAT_CONSTANTS_CASES: readonly FormatConstantsCase[] = [
    [ 'I420', 8, CHROMA_FORMAT_420, 1, 4, EIGHT_BIT_SAMPLE_MASK ],
    [ 'I420P10', 10, CHROMA_FORMAT_420, 2, 2, SIXTEEN_BIT_SAMPLE_MASK ],
    [ 'I420P12', 12, CHROMA_FORMAT_420, 2, 2, SIXTEEN_BIT_SAMPLE_MASK ],
    [ 'I422', 8, CHROMA_FORMAT_422, 1, 4, EIGHT_BIT_SAMPLE_MASK ],
    [ 'I422P10', 10, CHROMA_FORMAT_422, 2, 2, SIXTEEN_BIT_SAMPLE_MASK ],
    [ 'I422P12', 12, CHROMA_FORMAT_422, 2, 2, SIXTEEN_BIT_SAMPLE_MASK ],
    [ 'I444', 8, CHROMA_FORMAT_444, 1, 4, EIGHT_BIT_SAMPLE_MASK ],
    [ 'I444P10', 10, CHROMA_FORMAT_444, 2, 2, SIXTEEN_BIT_SAMPLE_MASK ],
    [ 'I444P12', 12, CHROMA_FORMAT_444, 2, 2, SIXTEEN_BIT_SAMPLE_MASK ]
];

/** A module whose body line is checked: a description, the session's format, and header lines beyond the minimal ones. */
type ModuleLineCase = readonly [string, GPUDecoderOutputFormat, readonly string[]];

const MODULE_LINE_CASES: readonly ModuleLineCase[] = [
    [ 'an 8-bit format', EIGHT_BIT_FORMAT, [] ],
    [ 'a 16-bit format', SIXTEEN_BIT_FORMAT, [] ],
    [ 'a format after enable directives', SIXTEEN_BIT_FORMAT, [ `//! requires: ${SHADER_F16_FEATURE}, ${SUBGROUPS_FEATURE}` ] ]
];

function createManifest(output: string, extraHeader: readonly string[] = []): GPUDecoderManifest {
    return parseGPUDecoderManifest([
        '//! id: prelude-test',
        '//! name: Prelude test',
        '//! decoder: video',
        `//! accepts: codec in [${CODEC_FAMILY}]`,
        `//! output: ${output}`,
        '//! packet: 1 MiB',
        '//! dispatch: copyPlanes, 1',
        ...extraHeader,
        BODY
    ].join('\n'));
}

/** Counts the members of a WGSL struct, every one of which is a 4-byte scalar or an array of 16-byte plane structs. */
function countStructWords(prelude: string, structName: string): number {
    const structMatch = new RegExp(String.raw`struct ${structName} \{([^}]*)\}`).exec(prelude);
    if (!structMatch) {
        throw new Error(`The prelude declares no struct ${structName}`);
    }
    let wordCount = 0;
    // One member per line; an array's type holds a comma of its own
    for (const member of structMatch[1].split('\n').map(text => text.trim()).filter(text => text.length > 0)) {
        const arrayMatch = /array<GPUDecodePlane, (\d+)>/.exec(member);
        wordCount += arrayMatch ? Number(arrayMatch[1]) * BYTES_PER_WORD : 1;
    }
    return wordCount;
}

/** Returns the prelude's lines without its format constants' declarations. */
function removeFormatConstants(prelude: string): string[] {
    return prelude.split('\n').filter(line => !FORMAT_CONSTANT_NAMES.some(name => line.startsWith(`const ${name}:`)));
}

describe('createGPUDecoderPrelude', () => {
    let restoreGlobals: () => void = (): void => undefined;

    beforeEach(() => {
        restoreGlobals = installWebGPUGlobals();
    });

    afterEach(() => {
        restoreGlobals();
    });

    it('declares the engine bindings in binding order and the scratch buffers after them', () => {
        const prelude = createGPUDecoderPrelude(createManifest(EIGHT_BIT_FORMAT, [
            `//! buffer: sliceDispatch, indirect, ${INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH}`,
            '//! buffer: coefficients, 4 KiB'
        ]), EIGHT_BIT_FORMAT);

        const bindings = [ ...prelude.matchAll(/@group\(0\) @binding\((\d+)\) var(<[^>]+>)? (\w+)/g) ].map(
            match => [ Number(match[1]), match[3] ]
        );
        expect(bindings).toEqual([
            [ GPU_DECODER_BINDINGS.packetBytes, 'packetBytes' ],
            [ GPU_DECODER_BINDINGS.packet, 'packet' ],
            [ GPU_DECODER_BINDINGS.config, 'config' ],
            [ GPU_DECODER_BINDINGS.stream, 'stream' ],
            [ GPU_DECODER_BINDINGS.state, 'state' ],
            [ GPU_DECODER_BINDINGS.framePool, 'framePool' ],
            [ GPU_DECODER_BINDINGS.status, 'status' ],
            [ GPU_DECODER_FIRST_BUFFER_BINDING, 'sliceDispatch' ],
            [ GPU_DECODER_FIRST_BUFFER_BINDING + 1, 'coefficients' ]
        ]);
        expect(prelude).toContain('var<storage, read> packetBytes: array<u32>;');
        expect(prelude).toContain('var<storage, read_write> framePool: array<u32>;');
    });

    it('sizes its uniform and status structs to the byte lengths the engine writes and reads', () => {
        const prelude = createGPUDecoderPrelude(createManifest(EIGHT_BIT_FORMAT), EIGHT_BIT_FORMAT);

        expect(countStructWords(prelude, 'GPUDecodePacket') * BYTES_PER_WORD).toBe(GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH);
        expect(countStructWords(prelude, 'GPUDecodeStream') * BYTES_PER_WORD).toBe(GPU_DECODER_STREAM_UNIFORM_BYTE_LENGTH);
        expect(countStructWords(prelude, 'GPUDecodeStatus') * BYTES_PER_WORD).toBe(GPU_DECODER_STATUS_BYTE_LENGTH);
        expect(prelude).toMatch(/struct GPUDecodeStatus \{\s+errorCode: atomic<u32>,\s+freedSlotMask: atomic<u32>,/);
        expect(GPU_DECODER_STATUS_FREED_SLOT_MASK_BYTE_OFFSET).toBe(BYTES_PER_WORD);
    });

    it.each(FORMAT_CONSTANTS_CASES)('declares the %s session\'s format constants once each', (
        format: GPUDecoderOutputFormat,
        bitDepth: number,
        chromaFormat: number,
        sampleBytes: number,
        samplesPerWord: number,
        sampleMask: string
    ) => {
        const prelude = createGPUDecoderPrelude(createManifest(ALL_FORMATS_OUTPUT), format);

        const declarations = prelude.split('\n').filter(line => FORMAT_CONSTANT_NAMES.some(name => line.startsWith(`const ${name}:`)));
        expect(declarations).toEqual([
            `const OUTPUT_BIT_DEPTH: u32 = ${bitDepth}u;`,
            `const OUTPUT_CHROMA_FORMAT: u32 = ${chromaFormat}u;`,
            `const SAMPLE_BYTES: u32 = ${sampleBytes}u;`,
            `const SAMPLES_PER_WORD: u32 = ${samplesPerWord}u;`,
            `const SAMPLE_MASK: u32 = ${sampleMask};`
        ]);
    });

    it.each(GPU_DECODER_OUTPUT_FORMATS)('declares both sample writers for %s, so a body branching on SAMPLE_BYTES serves every format', (format: GPUDecoderOutputFormat) => {
        const prelude = createGPUDecoderPrelude(createManifest(ALL_FORMATS_OUTPUT), format);

        expect(prelude).toContain(EIGHT_BIT_WRITER_DECLARATION);
        expect(prelude).toContain(SIXTEEN_BIT_WRITER_DECLARATION);
    });

    it('addresses and masks pool samples by the format constants', () => {
        const prelude = createGPUDecoderPrelude(createManifest(EIGHT_BIT_FORMAT), EIGHT_BIT_FORMAT);

        expect(prelude).toContain('x * SAMPLE_BYTES;');
        expect(prelude).toContain('& SAMPLE_MASK;');
    });

    it('differs between the formats of one decoder only in the format constants', () => {
        const manifest = createManifest(ALL_FORMATS_OUTPUT);
        const eightBitLines = removeFormatConstants(createGPUDecoderPrelude(manifest, EIGHT_BIT_FORMAT));

        for (const format of GPU_DECODER_OUTPUT_FORMATS) {
            expect(removeFormatConstants(createGPUDecoderPrelude(manifest, format))).toEqual(eightBitLines);
        }
    });

    it('opens with the enable directives of the required features that have WGSL extensions', () => {
        const prelude = createGPUDecoderPrelude(createManifest(EIGHT_BIT_FORMAT, [
            `//! requires: ${FEATURE_WITHOUT_EXTENSION}, ${SHADER_F16_FEATURE}, ${SUBGROUPS_FEATURE}`
        ]), EIGHT_BIT_FORMAT);

        expect(prelude.startsWith(EXPECTED_ENABLE_DIRECTIVES)).toBe(true);
        expect(prelude).not.toContain(FEATURE_WITHOUT_EXTENSION);
    });

    it.each(MODULE_LINE_CASES)('starts the body of %s on the line the module reports', (
        _description: string,
        format: GPUDecoderOutputFormat,
        extraHeader: readonly string[]
    ) => {
        const manifest = createManifest(ALL_FORMATS_OUTPUT, extraHeader);

        const decoderModule = createGPUDecoderModule(manifest, format);

        const prelude = createGPUDecoderPrelude(manifest, format);
        const moduleLines = decoderModule.code.split('\n');
        expect(decoderModule.firstBodyLine).toBe(prelude.split('\n').length + 1);
        expect(moduleLines.slice(decoderModule.firstBodyLine - 1)).toEqual(manifest.body.split('\n'));
        expect(decoderModule.code.startsWith(`${prelude}\n`)).toBe(true);
    });

    it('reserves the names the prelude declares, its format constants and both sample writers included', () => {
        const preludeNames = [
            'packetBytes',
            'packet',
            'config',
            'stream',
            'state',
            'framePool',
            'status',
            'readPacketByte',
            'GPUDecodeStream',
            'writeOutputSamples8',
            'writeOutputSamples16',
            ...FORMAT_CONSTANT_NAMES
        ];

        for (const name of preludeNames) {
            expect(GPU_DECODER_RESERVED_IDENTIFIERS.has(name)).toBe(true);
        }
    });

    it('lays out one compute-visible bind group whose packet uniform takes a dynamic offset', () => {
        const scratchBufferCount = 2;

        const entries = createGPUDecoderBindGroupLayoutEntries(scratchBufferCount);

        expect(entries.map(entry => entry.binding)).toEqual([ 0, 1, 2, 3, 4, 5, 6, 7, 8 ]);
        expect(entries.every(entry => entry.visibility === COMPUTE_STAGE)).toBe(true);
        expect(entries.map(entry => entry.buffer?.type)).toEqual([
            'read-only-storage',
            'uniform',
            'read-only-storage',
            'uniform',
            'storage',
            'storage',
            'storage',
            'storage',
            'storage'
        ]);
        expect(entries[GPU_DECODER_BINDINGS.packet].buffer).toEqual({
            hasDynamicOffset: true,
            minBindingSize: GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH,
            type: 'uniform'
        });
    });
});

describe('decoder uniform and status layouts', () => {
    it('writes the packet uniform in struct order', () => {
        const words = new Uint32Array(GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH / BYTES_PER_WORD);

        writeGPUDecoderPacketUniform(words, {
            byteLength: PACKET_BYTE_LENGTH,
            byteOffset: PACKET_BYTE_OFFSET,
            index: PACKET_INDEX,
            keyframe: true,
            outputSlot: OUTPUT_SLOT,
            reset: false
        });

        expect([ ...words ]).toEqual([ PACKET_BYTE_OFFSET, PACKET_BYTE_LENGTH, PACKET_INDEX, 1, 0, OUTPUT_SLOT, 0, 0 ]);
    });

    it('writes the stream uniform in struct order', () => {
        const words = new Uint32Array(GPU_DECODER_STREAM_UNIFORM_BYTE_LENGTH / BYTES_PER_WORD);

        writeGPUDecoderStreamUniform(words, {
            bitDepth: EIGHT_BIT_DEPTH,
            bytesPerSample: 1,
            configByteLength: CONFIG_BYTE_LENGTH,
            height: STREAM_HEIGHT,
            planes: [
                { byteOffset: 0, bytesPerRow: LUMA_BYTES_PER_ROW, height: STREAM_HEIGHT, width: STREAM_WIDTH },
                { byteOffset: CHROMA_U_BYTE_OFFSET, bytesPerRow: CHROMA_BYTES_PER_ROW, height: CHROMA_HEIGHT, width: CHROMA_WIDTH },
                { byteOffset: CHROMA_V_BYTE_OFFSET, bytesPerRow: CHROMA_BYTES_PER_ROW, height: CHROMA_HEIGHT, width: CHROMA_WIDTH }
            ],
            slotByteLength: SLOT_BYTE_LENGTH,
            slotCount: SLOT_COUNT,
            width: STREAM_WIDTH
        });

        expect([ ...words ]).toEqual([
            0, LUMA_BYTES_PER_ROW, STREAM_WIDTH, STREAM_HEIGHT,
            CHROMA_U_BYTE_OFFSET, CHROMA_BYTES_PER_ROW, CHROMA_WIDTH, CHROMA_HEIGHT,
            CHROMA_V_BYTE_OFFSET, CHROMA_BYTES_PER_ROW, CHROMA_WIDTH, CHROMA_HEIGHT,
            STREAM_WIDTH, STREAM_HEIGHT, EIGHT_BIT_DEPTH, 1, 3, SLOT_BYTE_LENGTH, SLOT_COUNT, CONFIG_BYTE_LENGTH
        ]);
    });

    it('reads the error code, the freed slots, and reported header facts', () => {
        const words = new Uint32Array(GPU_DECODER_STATUS_BYTE_LENGTH / BYTES_PER_WORD);
        words.set([ ERROR_CODE, FREED_SLOT_MASK, 1, HEADER_WIDTH, HEADER_HEIGHT, HEADER_BIT_DEPTH, 0, 0, HEADER_WIDTH, HEADER_VISIBLE_HEIGHT ]);

        expect(readGPUDecoderStatus(words)).toEqual({
            errorCode: ERROR_CODE,
            freedSlotMask: FREED_SLOT_MASK,
            headerFacts: {
                bitDepth: HEADER_BIT_DEPTH,
                codedHeight: HEADER_HEIGHT,
                codedWidth: HEADER_WIDTH,
                visibleRectangle: { height: HEADER_VISIBLE_HEIGHT, width: HEADER_WIDTH, x: 0, y: 0 }
            }
        });
    });

    it('reports no header facts until the decoder marks them valid', () => {
        const words = new Uint32Array(GPU_DECODER_STATUS_BYTE_LENGTH / BYTES_PER_WORD);
        words[3] = HEADER_WIDTH;

        expect(readGPUDecoderStatus(words).headerFacts).toBeNull();
        expect(() => readGPUDecoderStatus(new Uint32Array(1))).toThrow(`status: ${BYTES_PER_WORD} < ${GPU_DECODER_STATUS_BYTE_LENGTH}`);
    });
});
