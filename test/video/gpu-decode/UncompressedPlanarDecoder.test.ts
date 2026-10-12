import { describe, expect, it } from 'vitest';

import { evaluatePassExpression } from 'webgpu-player/presentation/passes/PassExpression';
import type { PassExpression } from 'webgpu-player/presentation/passes/PassTypes';
import {
    createUncompressedPlanarDecoderSource,
    getUncompressedPlanarFrameByteLength,
    UNCOMPRESSED_PLANAR_CODEC_IDENTIFIER,
    UNCOMPRESSED_PLANAR_MAXIMUM_HEIGHT,
    UNCOMPRESSED_PLANAR_MAXIMUM_WIDTH,
    UNCOMPRESSED_PLANAR_PACKET_SIZE_ERROR
} from 'webgpu-player/video/gpu-decode/examples/UncompressedPlanarDecoder.wgsl';
import { getGPUDecoderFormatFacts, type GPUDecoderOutputFormat } from 'webgpu-player/video/gpu-decode/GPUDecodeFormats';
import { GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH } from 'webgpu-player/video/gpu-decode/GPUDecodeLimits';
import { parseGPUDecoderManifest } from 'webgpu-player/video/gpu-decode/GPUDecoderManifest';

const OUTPUT_FORMATS: readonly GPUDecoderOutputFormat[] = [
    'I420',
    'I420P10',
    'I420P12',
    'I422',
    'I422P10',
    'I422P12',
    'I444',
    'I444P10',
    'I444P12'
];

const COPY_ENTRY_POINT = 'copyPlanes';
const PLANE_COUNT = 3;
const FULL_HD_WIDTH = 1920;
const FULL_HD_HEIGHT = 1080;
const ODD_WIDTH = 37;
const ODD_HEIGHT = 23;
// Samples one 64-wide workgroup row copies: four 8-bit or two 16-bit samples per invocation
const EIGHT_BIT_SAMPLES_PER_WORKGROUP_ROW = 256;
const SIXTEEN_BIT_SAMPLES_PER_WORKGROUP_ROW = 128;
const EIGHT_BIT_DEPTH = 8;
const TEN_BIT_DEPTH = 10;

function createStreamFacts(width: number, height: number, bitDepth: number): ReadonlyMap<string, number> {
    return new Map([
        [ 'stream.width', width ],
        [ 'stream.height', height ],
        [ 'stream.bitDepth', bitDepth ]
    ]);
}

function requireConstraint(constraint: PassExpression | null): PassExpression {
    if (!constraint) {
        throw new Error('The decoder accepts every stream');
    }
    return constraint;
}

describe('the uncompressed planar proof decoder', () => {
    it.each(OUTPUT_FORMATS)('parses into a %s decoder without references, reordering, or a vector', (format: GPUDecoderOutputFormat) => {
        const manifest = parseGPUDecoderManifest(createUncompressedPlanarDecoderSource(format));

        expect(manifest.name).toBe(`Uncompressed planar ${format}`);
        expect(manifest.accepts.codecs).toEqual([ UNCOMPRESSED_PLANAR_CODEC_IDENTIFIER ]);
        expect(manifest.outputFormat).toBe(format);
        expect(manifest.references).toBe(0);
        expect(manifest.reorder).toBe(0);
        expect(manifest.vector).toBeNull();
        expect(manifest.buffers).toEqual([]);
        expect(manifest.dispatches.map(dispatch => dispatch.entryPoint)).toEqual([ COPY_ENTRY_POINT ]);
        expect(manifest.body).toContain(`reportDecodeError(${UNCOMPRESSED_PLANAR_PACKET_SIZE_ERROR}u)`);
    });

    it.each(OUTPUT_FORMATS)('sizes the %s packet ring for its largest frame within the packet limit', (format: GPUDecoderOutputFormat) => {
        const manifest = parseGPUDecoderManifest(createUncompressedPlanarDecoderSource(format));

        const largestFrameByteLength = getUncompressedPlanarFrameByteLength(format, UNCOMPRESSED_PLANAR_MAXIMUM_WIDTH, UNCOMPRESSED_PLANAR_MAXIMUM_HEIGHT);
        expect(manifest.packetByteLength).toBeGreaterThanOrEqual(largestFrameByteLength);
        expect(manifest.packetByteLength).toBeLessThanOrEqual(GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH);
    });

    it('accepts streams of its bit depth up to its largest size', () => {
        const constraint = requireConstraint(parseGPUDecoderManifest(createUncompressedPlanarDecoderSource('I420P10')).accepts.constraint);

        const accepts = (width: number, height: number, bitDepth: number): number => evaluatePassExpression(
            constraint,
            createStreamFacts(width, height, bitDepth)
        );
        expect(accepts(UNCOMPRESSED_PLANAR_MAXIMUM_WIDTH, UNCOMPRESSED_PLANAR_MAXIMUM_HEIGHT, TEN_BIT_DEPTH)).toBe(1);
        expect(accepts(UNCOMPRESSED_PLANAR_MAXIMUM_WIDTH + 1, FULL_HD_HEIGHT, TEN_BIT_DEPTH)).toBe(0);
        expect(accepts(FULL_HD_WIDTH, UNCOMPRESSED_PLANAR_MAXIMUM_HEIGHT + 1, TEN_BIT_DEPTH)).toBe(0);
        expect(accepts(FULL_HD_WIDTH, FULL_HD_HEIGHT, EIGHT_BIT_DEPTH)).toBe(0);
    });

    it.each([
        [ 'I420' as const, EIGHT_BIT_SAMPLES_PER_WORKGROUP_ROW ],
        [ 'I422P10' as const, SIXTEEN_BIT_SAMPLES_PER_WORKGROUP_ROW ]
    ])('dispatches %s as one invocation per output word, one workgroup row per row, and one plane per z', (
        format: GPUDecoderOutputFormat,
        samplesPerWorkgroupRow: number
    ) => {
        const manifest = parseGPUDecoderManifest(createUncompressedPlanarDecoderSource(format));
        const facts = createStreamFacts(FULL_HD_WIDTH, FULL_HD_HEIGHT, getGPUDecoderFormatFacts(format).bitDepth);

        const counts = (manifest.dispatches[0].workgroupCounts ?? []).map(count => evaluatePassExpression(count, facts));

        expect(counts).toEqual([ Math.ceil(FULL_HD_WIDTH / samplesPerWorkgroupRow), FULL_HD_HEIGHT, PLANE_COUNT ]);
    });

    it('sizes a frame as tightly packed planes with subsampled chroma rounded up', () => {
        const chromaWidth = Math.ceil(ODD_WIDTH / 2);
        const chromaHeight = Math.ceil(ODD_HEIGHT / 2);

        expect(getUncompressedPlanarFrameByteLength('I420', ODD_WIDTH, ODD_HEIGHT)).toBe(ODD_WIDTH * ODD_HEIGHT + 2 * chromaWidth * chromaHeight);
        expect(getUncompressedPlanarFrameByteLength('I422P10', ODD_WIDTH, ODD_HEIGHT)).toBe(2 * (ODD_WIDTH * ODD_HEIGHT + 2 * chromaWidth * ODD_HEIGHT));
        expect(getUncompressedPlanarFrameByteLength('I444P12', ODD_WIDTH, ODD_HEIGHT)).toBe(2 * PLANE_COUNT * ODD_WIDTH * ODD_HEIGHT);
    });
});
