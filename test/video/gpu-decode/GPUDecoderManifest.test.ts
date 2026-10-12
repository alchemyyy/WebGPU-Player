import { describe, expect, it } from 'vitest';

import { evaluatePassExpression } from 'webgpu-player/presentation/passes/PassExpression';
import type { PassExpression } from 'webgpu-player/presentation/passes/PassTypes';
import {
    INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH,
    SHADER_F16_FEATURE,
    SUBGROUPS_FEATURE
} from 'webgpu-player/presentation/WebGPUConstants';
import { KIBIBYTE, MEBIBYTE } from 'webgpu-player/video/gpu-decode/GPUDecodeLimits';
import {
    GPU_DECODER_STREAM_FACTS,
    GPUDecoderManifestError,
    parseGPUDecoderManifest
} from 'webgpu-player/video/gpu-decode/GPUDecoderManifest';

const DECODER_NAME = 'ProRes 422';
const PACKET_MEBIBYTES = 16;
const STATE_KIBIBYTES = 64;
const SLICE_DISPATCH_BYTE_LENGTH = INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH;
const COEFFICIENT_MEBIBYTES = 2;
const REFERENCES = 2;
const REORDER = 1;
const VECTOR_FILE = 'prores-422-hq.mov';
const VECTOR_FIRST_FRAME = 0;
const VECTOR_LAST_FRAME = 2;
const VECTOR_HASH = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90';
const MAXIMUM_WIDTH = 8192;
const MAXIMUM_HEIGHT = 4320;
const UHD_WIDTH = 3840;
const UHD_HEIGHT = 2160;
const OVERSIZED_WIDTH = 10_240;
const TEN_BIT_DEPTH = 10;
const BLOCK_SIZE = 16;
const BODY = `
@compute @workgroup_size(1)
fn parseFrameHeader() {
}

@compute @workgroup_size(64)
fn decodeSlices(@builtin(global_invocation_id) id: vec3u) {
}

@compute @workgroup_size(8, 8)
fn inverseTransform(@builtin(global_invocation_id) id: vec3u) {
}`;
const COMPLETE_HEADER: readonly string[] = [
    `//! name: ${DECODER_NAME}`,
    '//! decoder: video',
    `//! accepts: codec in [apch, apcn, "raw "], stream.width <= ${MAXIMUM_WIDTH}, stream.height <= ${MAXIMUM_HEIGHT}`,
    '//! output: I422P10',
    `//! references: ${REFERENCES}`,
    `//! reorder: ${REORDER}`,
    `//! packet: ${PACKET_MEBIBYTES} MiB`,
    `//! state: ${STATE_KIBIBYTES} KiB`,
    `//! buffer: sliceDispatch, indirect, ${SLICE_DISPATCH_BYTE_LENGTH}`,
    `//! buffer: coefficients, ${COEFFICIENT_MEBIBYTES} MiB`,
    `//! requires: ${SUBGROUPS_FEATURE}, ${SHADER_F16_FEATURE}`,
    '//! dispatch: parseFrameHeader, 1',
    '//! dispatch: decodeSlices, indirect sliceDispatch',
    `//! dispatch: inverseTransform, ceil(stream.width / ${BLOCK_SIZE}), max(stream.height / ${BLOCK_SIZE}, 1)`,
    `//! vector: ${VECTOR_FILE}, frames ${VECTOR_FIRST_FRAME}-${VECTOR_LAST_FRAME}, sha256 ${VECTOR_HASH}`
];
const MINIMAL_HEADER: readonly string[] = [
    '//! name: Minimal',
    '//! decoder: video',
    '//! accepts: codec in [V_UNCOMPRESSED]',
    '//! output: I420',
    '//! packet: 4096',
    '//! dispatch: parseFrameHeader, 1'
];

function createSource(header: readonly string[], body: string = BODY): string {
    return `${header.join('\n')}\n${body}`;
}

function createStreamFacts(width: number, height: number, bitDepth: number): ReadonlyMap<string, number> {
    return new Map([
        [ GPU_DECODER_STREAM_FACTS.width, width ],
        [ GPU_DECODER_STREAM_FACTS.height, height ],
        [ GPU_DECODER_STREAM_FACTS.bitDepth, bitDepth ]
    ]);
}

function replaceHeaderLine(header: readonly string[], directive: string, replacement: string): string[] {
    return header.map(line => (line.startsWith(`//! ${directive}:`) ? replacement : line));
}

function getParseError(source: string): GPUDecoderManifestError {
    try {
        parseGPUDecoderManifest(source);
    } catch (error) {
        if (error instanceof GPUDecoderManifestError) {
            return error;
        }
        throw error;
    }
    throw new Error('The source parsed without an error');
}

describe('parseGPUDecoderManifest', () => {
    it('parses every directive of a complete header', () => {
        const manifest = parseGPUDecoderManifest(createSource(COMPLETE_HEADER));

        expect(manifest.name).toBe(DECODER_NAME);
        expect(manifest.accepts.codecs).toEqual([ 'apch', 'apcn', 'raw ' ]);
        expect(manifest.outputFormat).toBe('I422P10');
        expect(manifest.references).toBe(REFERENCES);
        expect(manifest.reorder).toBe(REORDER);
        expect(manifest.packetByteLength).toBe(PACKET_MEBIBYTES * MEBIBYTE);
        expect(manifest.stateByteLength).toBe(STATE_KIBIBYTES * KIBIBYTE);
        expect(manifest.buffers).toEqual([
            { byteLength: SLICE_DISPATCH_BYTE_LENGTH, indirect: true, name: 'sliceDispatch' },
            { byteLength: COEFFICIENT_MEBIBYTES * MEBIBYTE, indirect: false, name: 'coefficients' }
        ]);
        expect(manifest.requiredFeatures).toEqual([ SUBGROUPS_FEATURE, SHADER_F16_FEATURE ]);
        expect(manifest.dispatches.map(dispatch => dispatch.entryPoint)).toEqual([
            'parseFrameHeader',
            'decodeSlices',
            'inverseTransform'
        ]);
        expect(manifest.dispatches[1]).toEqual({ entryPoint: 'decodeSlices', indirectBuffer: 'sliceDispatch', workgroupCounts: null });
        expect(manifest.vector).toEqual({
            file: VECTOR_FILE,
            firstFrame: VECTOR_FIRST_FRAME,
            lastFrame: VECTOR_LAST_FRAME,
            sha256: VECTOR_HASH.toLowerCase()
        });
        expect(manifest.bodyFirstLine).toBe(COMPLETE_HEADER.length + 1);
        expect(manifest.body).toBe(BODY);
    });

    it('fills omitted workgroup counts with 1 and keeps function calls whole', () => {
        const manifest = parseGPUDecoderManifest(createSource(COMPLETE_HEADER));
        const facts = createStreamFacts(UHD_WIDTH, UHD_HEIGHT, TEN_BIT_DEPTH);

        const evaluateCounts = (counts: readonly PassExpression[] | null): number[] => (counts ?? []).map(
            count => evaluatePassExpression(count, facts)
        );
        expect(evaluateCounts(manifest.dispatches[0].workgroupCounts)).toEqual([ 1, 1, 1 ]);
        expect(evaluateCounts(manifest.dispatches[2].workgroupCounts)).toEqual([
            UHD_WIDTH / BLOCK_SIZE,
            Math.ceil(UHD_HEIGHT / BLOCK_SIZE),
            1
        ]);
    });

    it('joins several accepts conditions so that all of them must hold', () => {
        const constraint = parseGPUDecoderManifest(createSource(COMPLETE_HEADER)).accepts.constraint;
        if (!constraint) {
            throw new Error('The accepts constraint is missing');
        }

        expect(evaluatePassExpression(constraint, createStreamFacts(UHD_WIDTH, UHD_HEIGHT, TEN_BIT_DEPTH))).toBe(1);
        expect(evaluatePassExpression(constraint, createStreamFacts(OVERSIZED_WIDTH, UHD_HEIGHT, TEN_BIT_DEPTH))).toBe(0);
    });

    it('defaults the optional directives', () => {
        const manifest = parseGPUDecoderManifest(createSource(MINIMAL_HEADER));

        expect(manifest.accepts).toEqual({ codecs: [ 'V_UNCOMPRESSED' ], constraint: null });
        expect(manifest.references).toBe(0);
        expect(manifest.reorder).toBe(0);
        expect(manifest.stateByteLength).toBe(0);
        expect(manifest.buffers).toEqual([]);
        expect(manifest.requiredFeatures).toEqual([]);
        expect(manifest.vector).toBeNull();
    });

    it('accepts an indirect flag after the buffer size and skips blank header lines', () => {
        const header = [
            ...MINIMAL_HEADER,
            '//!',
            `//! buffer: sliceDispatch, ${SLICE_DISPATCH_BYTE_LENGTH} B, indirect`
        ];

        expect(parseGPUDecoderManifest(createSource(header)).buffers).toEqual([
            { byteLength: SLICE_DISPATCH_BYTE_LENGTH, indirect: true, name: 'sliceDispatch' }
        ]);
    });

    it.each([
        [ 'an unknown directive', [ ...MINIMAL_HEADER, '//! workgroup: 64' ], MINIMAL_HEADER.length + 1, "Unknown directive 'workgroup'" ],
        [ 'a repeated single directive', [ ...MINIMAL_HEADER, '//! output: I444' ], MINIMAL_HEADER.length + 1, "The directive 'output' appears twice" ],
        [ 'a malformed header line', [ ...MINIMAL_HEADER, '//! output I444' ], MINIMAL_HEADER.length + 1, 'A header line must read' ],
        [ 'an audio decoder', replaceHeaderLine(MINIMAL_HEADER, 'decoder', '//! decoder: audio'), 2, "decoder must be 'video'" ],
        [ 'semi-planar output', replaceHeaderLine(MINIMAL_HEADER, 'output', '//! output: NV12'), 4, "'NV12' is not a planar output format" ],
        [ 'a size with an unknown unit', replaceHeaderLine(MINIMAL_HEADER, 'packet', '//! packet: 4 GB'), 5, 'must be a byte count' ],
        [ 'an oversized packet', replaceHeaderLine(MINIMAL_HEADER, 'packet', '//! packet: 65 MiB'), 5, 'exceeds the 67108864-byte limit' ],
        [ 'too many references', [ ...MINIMAL_HEADER, '//! references: 17' ], MINIMAL_HEADER.length + 1, 'references of 17 exceeds the limit of 16' ],
        [ 'a negative reorder depth', [ ...MINIMAL_HEADER, '//! reorder: -1' ], MINIMAL_HEADER.length + 1, 'reorder must be a non-negative integer' ],
        [ 'accepts without a codec list', replaceHeaderLine(MINIMAL_HEADER, 'accepts', '//! accepts: stream.width <= 4096'), 3, 'accepts must read' ],
        [ 'an accepts condition on another fact', replaceHeaderLine(MINIMAL_HEADER, 'accepts', '//! accepts: codec in [apch], output.width > 0'), 3, "reads 'output.width'" ],
        [ 'a malformed accepts condition', replaceHeaderLine(MINIMAL_HEADER, 'accepts', '//! accepts: codec in [apch], stream.width <'), 3, 'is malformed' ],
        [ 'an empty codec identifier', replaceHeaderLine(MINIMAL_HEADER, 'accepts', '//! accepts: codec in [apch, ]'), 3, 'empty identifier' ],
        [ 'a repeated codec identifier', replaceHeaderLine(MINIMAL_HEADER, 'accepts', '//! accepts: codec in [apch, apch]'), 3, "names 'apch' twice" ],
        [ 'a buffer named after a prelude binding', [ ...MINIMAL_HEADER, '//! buffer: state, 64' ], MINIMAL_HEADER.length + 1, "'state' is reserved" ],
        [ 'a repeated buffer', [ ...MINIMAL_HEADER, '//! buffer: scratch, 64', '//! buffer: scratch, 64' ], MINIMAL_HEADER.length + 2, "'scratch' is declared twice" ],
        [ 'a buffer without a size', [ ...MINIMAL_HEADER, '//! buffer: scratch, indirect' ], MINIMAL_HEADER.length + 1, 'buffer must read' ],
        [ 'a short indirect buffer', [ ...MINIMAL_HEADER, '//! buffer: scratch, indirect, 8' ], MINIMAL_HEADER.length + 1, 'needs at least 12 bytes' ],
        [ 'a malformed feature', [ ...MINIMAL_HEADER, '//! requires: Shader F16' ], MINIMAL_HEADER.length + 1, 'is not a device feature name' ],
        [ 'four workgroup counts', replaceHeaderLine(MINIMAL_HEADER, 'dispatch', '//! dispatch: parseFrameHeader, 1, 1, 1, 1'), 6, 'dispatch must read' ],
        [ 'an indirect dispatch of an undeclared buffer', replaceHeaderLine(MINIMAL_HEADER, 'dispatch', '//! dispatch: parseFrameHeader, indirect missing'), 6, "undeclared buffer 'missing'" ],
        [ 'an indirect dispatch of a plain buffer', [ ...replaceHeaderLine(MINIMAL_HEADER, 'dispatch', '//! dispatch: parseFrameHeader, indirect scratch'), '//! buffer: scratch, 64' ], 6, "'scratch' is not declared indirect" ],
        [ 'a dispatch of a missing entry point', replaceHeaderLine(MINIMAL_HEADER, 'dispatch', '//! dispatch: missingEntry, 1'), 6, "no entry point 'fn missingEntry('" ],
        [ 'a malformed vector', [ ...MINIMAL_HEADER, '//! vector: clip.mkv, frames 0-2' ], MINIMAL_HEADER.length + 1, 'vector must read' ],
        [ 'a vector whose frames run backwards', [ ...MINIMAL_HEADER, `//! vector: clip.mkv, frames 2-1, sha256 ${VECTOR_HASH}` ], MINIMAL_HEADER.length + 1, 'precedes its first frame' ]
    ])('rejects %s on its line', (_description: string, header: readonly string[], line: number, message: string) => {
        const error = getParseError(createSource(header));

        expect(error.line).toBe(line);
        expect(error.message).toContain(message);
    });

    it.each([ 'name', 'decoder', 'accepts', 'output', 'packet', 'dispatch' ])('requires the %s directive', (directive: string) => {
        const header = MINIMAL_HEADER.filter(line => !line.startsWith(`//! ${directive}:`));

        expect(getParseError(createSource(header)).message).toContain(`no '${directive}' directive`);
    });

    it('rejects a source without a header', () => {
        expect(getParseError(BODY.trimStart()).line).toBe(1);
    });

    it('rejects an entry point declared without @compute', () => {
        const body = '\nfn parseFrameHeader() {\n}';

        const error = getParseError(createSource(MINIMAL_HEADER, body));

        expect(error.line).toBe(MINIMAL_HEADER.length);
        expect(error.message).toContain('is not declared with @compute');
    });

    it('rejects bindings and enable directives in the body on their body lines', () => {
        const bindingBody = `${BODY}\n@group(0) @binding(9) var<storage, read_write> extra: array<u32>;`;
        const enableBody = `\nenable f16;${BODY}`;
        const bodyFirstLine = MINIMAL_HEADER.length + 1;

        const bindingError = getParseError(createSource(MINIMAL_HEADER, bindingBody));
        const enableError = getParseError(createSource(MINIMAL_HEADER, enableBody));

        expect(bindingError.message).toContain('The prelude owns every binding');
        expect(bindingError.line).toBe(bodyFirstLine + BODY.split('\n').length);
        expect(enableError.message).toContain('requires directive');
        expect(enableError.line).toBe(bodyFirstLine + 1);
    });
});
