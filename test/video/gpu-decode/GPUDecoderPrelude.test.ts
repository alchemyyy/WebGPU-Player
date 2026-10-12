import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    BYTES_PER_WORD,
    INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH,
    SHADER_F16_FEATURE,
    SUBGROUPS_FEATURE
} from 'webgpu-player/presentation/WebGPUConstants';
import { parseGPUDecoderManifest } from 'webgpu-player/video/gpu-decode/GPUDecoderManifest';
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
} from 'webgpu-player/video/gpu-decode/GPUDecoderPrelude';
import type { GPUDecoderManifest } from 'webgpu-player/video/gpu-decode/GPUDecodeTypes';

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
const BODY = `
@compute @workgroup_size(64)
fn copyPlanes(@builtin(global_invocation_id) id: vec3u) {
}`;

function createManifest(output: string, extraHeader: readonly string[] = []): GPUDecoderManifest {
    return parseGPUDecoderManifest([
        '//! name: Prelude test',
        '//! decoder: video',
        '//! accepts: codec in [V_UNCOMPRESSED]',
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

describe('createGPUDecoderPrelude', () => {
    let restoreGlobals: () => void = (): void => undefined;

    beforeEach(() => {
        restoreGlobals = installWebGPUGlobals();
    });

    afterEach(() => {
        restoreGlobals();
    });

    it('declares the engine bindings in binding order and the scratch buffers after them', () => {
        const prelude = createGPUDecoderPrelude(createManifest('I420', [
            `//! buffer: sliceDispatch, indirect, ${INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH}`,
            '//! buffer: coefficients, 4 KiB'
        ]));

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
        const prelude = createGPUDecoderPrelude(createManifest('I420'));

        expect(countStructWords(prelude, 'GPUDecodePacket') * BYTES_PER_WORD).toBe(GPU_DECODER_PACKET_UNIFORM_BYTE_LENGTH);
        expect(countStructWords(prelude, 'GPUDecodeStream') * BYTES_PER_WORD).toBe(GPU_DECODER_STREAM_UNIFORM_BYTE_LENGTH);
        expect(countStructWords(prelude, 'GPUDecodeStatus') * BYTES_PER_WORD).toBe(GPU_DECODER_STATUS_BYTE_LENGTH);
        expect(prelude).toMatch(/struct GPUDecodeStatus \{\s+errorCode: atomic<u32>,\s+freedSlotMask: atomic<u32>,/);
        expect(GPU_DECODER_STATUS_FREED_SLOT_MASK_BYTE_OFFSET).toBe(BYTES_PER_WORD);
    });

    it('writes only the sample helper of the output sample size', () => {
        const eightBitPrelude = createGPUDecoderPrelude(createManifest('I420'));
        const sixteenBitPrelude = createGPUDecoderPrelude(createManifest('I422P10'));

        expect(eightBitPrelude).toContain('fn writeOutputSamples8(plane: u32, x: u32, y: u32, samples: vec4u)');
        expect(eightBitPrelude).not.toContain('writeOutputSamples16');
        expect(eightBitPrelude).toContain('x * 1u;');
        expect(eightBitPrelude).toContain('& 0xFFu;\n}');
        expect(sixteenBitPrelude).toContain('fn writeOutputSamples16(plane: u32, x: u32, y: u32, samples: vec2u)');
        expect(sixteenBitPrelude).not.toContain('writeOutputSamples8');
        expect(sixteenBitPrelude).toContain('x * 2u;');
        expect(sixteenBitPrelude).toContain('& 0xFFFFu;\n}');
    });

    it('opens with the enable directives of the required features that have WGSL extensions', () => {
        const prelude = createGPUDecoderPrelude(createManifest('I420', [
            `//! requires: ${FEATURE_WITHOUT_EXTENSION}, ${SHADER_F16_FEATURE}, ${SUBGROUPS_FEATURE}`
        ]));

        expect(prelude.startsWith(EXPECTED_ENABLE_DIRECTIVES)).toBe(true);
        expect(prelude).not.toContain(FEATURE_WITHOUT_EXTENSION);
    });

    it('rejects a semi-planar output format', () => {
        const manifest: GPUDecoderManifest = { ...createManifest('I420'), outputFormat: 'NV12' };

        expect(() => createGPUDecoderPrelude(manifest)).toThrow('A GPU decoder cannot write NV12');
    });

    it('starts the body on the line the module reports', () => {
        const manifest = createManifest('I420');

        const decoderModule = createGPUDecoderModule(manifest);

        const moduleLines = decoderModule.code.split('\n');
        expect(moduleLines.slice(decoderModule.firstBodyLine - 1)).toEqual(manifest.body.split('\n'));
        expect(decoderModule.code.startsWith(createGPUDecoderPrelude(manifest))).toBe(true);
    });

    it('reserves the names the prelude declares', () => {
        for (const name of [ 'packetBytes', 'packet', 'config', 'stream', 'state', 'framePool', 'status', 'readPacketByte', 'GPUDecodeStream' ]) {
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
        expect(() => readGPUDecoderStatus(new Uint32Array(1))).toThrow('too short');
    });
});
