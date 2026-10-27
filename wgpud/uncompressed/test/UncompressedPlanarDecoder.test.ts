import { describe, expect, it } from 'vitest';

import { evaluatePassExpression } from 'webgpu-player/presentation/passes/PassExpression';
import type { PassExpression } from 'webgpu-player/presentation/passes/PassTypes';
import { getGPUDecoderFormatFacts, GPU_DECODER_OUTPUT_FORMATS, type GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH } from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import { getGPUDecoderFacts, GPU_DECODER_STREAM_FACTS, parseGPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import { createGPUDecoderModule } from 'webgpu-player/decode/video/gpu/GPUDecoderPrelude';

import { readDecoderProjectSource, requireFixedPacketByteLength } from '../../../test/helpers/decoderPackages';

const PROJECT = 'uncompressed';
const DECODER_NAME = 'Uncompressed planar';
const CODEC_FAMILY = 'uncompressed';
// The largest frame the decoder accepts
const MAXIMUM_WIDTH = 4096;
const MAXIMUM_HEIGHT = 2304;
const PACKET_SIZE_ERROR_CODE = 1;
const PACKET_SIZE_ERROR_NAME = 'packetSize';
const COPY_ENTRY_POINT = 'copyPlanes';
const PLANE_COUNT = 3;
const FULL_HD_WIDTH = 1920;
const FULL_HD_HEIGHT = 1080;
// Samples one 64-wide workgroup row copies: four 8-bit or two 16-bit samples per invocation
const EIGHT_BIT_SAMPLES_PER_WORKGROUP_ROW = 256;
const SIXTEEN_BIT_SAMPLES_PER_WORKGROUP_ROW = 128;
const EIGHT_BIT_DEPTH = 8;
const TEN_BIT_DEPTH = 10;
const TWELVE_BIT_DEPTH = 12;
const EIGHT_BIT_WRITER_CALL = 'writeOutputSamples8(';
const SIXTEEN_BIT_WRITER_CALL = 'writeOutputSamples16(';
const EIGHT_BIT_WRITER_DECLARATION = 'fn writeOutputSamples8(';
const SIXTEEN_BIT_WRITER_DECLARATION = 'fn writeOutputSamples16(';
// The sample size the body branches on, which only the prelude declares
const SAMPLE_BYTES_BRANCH = 'if (SAMPLE_BYTES == 1u)';

function createStreamFacts(width: number, height: number, bitDepth: number): ReadonlyMap<string, number> {
    return new Map([
        [ GPU_DECODER_STREAM_FACTS.width, width ],
        [ GPU_DECODER_STREAM_FACTS.height, height ],
        [ GPU_DECODER_STREAM_FACTS.bitDepth, bitDepth ]
    ]);
}

function requireConstraint(constraint: PassExpression | null): PassExpression {
    if (!constraint) {
        throw new Error('The decoder accepts every stream');
    }
    return constraint;
}

/** Returns one frame's byte length: its planes tightly packed, with subsampled chroma rounded up, as FFmpeg's rawvideo stores them. */
function getFrameByteLength(format: GPUDecoderOutputFormat, width: number, height: number): number {
    const facts = getGPUDecoderFormatFacts(format);
    const chromaSampleCount = Math.ceil(width / facts.chromaWidthDivisor) * Math.ceil(height / facts.chromaHeightDivisor);
    return (width * height + 2 * chromaSampleCount) * facts.bytesPerSample;
}

describe('the uncompressed planar proof decoder', () => {
    const manifest = parseGPUDecoderManifest(readDecoderProjectSource(PROJECT));

    it('parses into one decoder of every planar format without a parser, references, or reordering', () => {
        expect(manifest.name).toBe(DECODER_NAME);
        expect(manifest.accepts.codecs).toEqual([ CODEC_FAMILY ]);
        expect(manifest.outputFormats).toEqual(GPU_DECODER_OUTPUT_FORMATS);
        expect(manifest.parser).toBeNull();
        expect(manifest.references).toBe(0);
        expect(manifest.reorder).toBe(0);
        expect(manifest.buffers).toEqual([]);
        expect(manifest.errors).toEqual(new Map([ [ PACKET_SIZE_ERROR_CODE, PACKET_SIZE_ERROR_NAME ] ]));
        expect(manifest.dispatches.map(dispatch => dispatch.entryPoint)).toEqual([ COPY_ENTRY_POINT ]);
    });

    it.each(GPU_DECODER_OUTPUT_FORMATS)('sizes the packet ring for the largest %s frame within the packet limit', (format: GPUDecoderOutputFormat) => {
        expect(requireFixedPacketByteLength(manifest)).toBeGreaterThanOrEqual(getFrameByteLength(format, MAXIMUM_WIDTH, MAXIMUM_HEIGHT));
        expect(requireFixedPacketByteLength(manifest)).toBeLessThanOrEqual(GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH);
    });

    it('accepts streams of any bit depth up to its largest size', () => {
        const constraint = requireConstraint(manifest.accepts.constraint);

        const accepts = (width: number, height: number, bitDepth: number): number => evaluatePassExpression(
            constraint,
            createStreamFacts(width, height, bitDepth)
        );
        expect(accepts(MAXIMUM_WIDTH, MAXIMUM_HEIGHT, TEN_BIT_DEPTH)).toBe(1);
        expect(accepts(FULL_HD_WIDTH, FULL_HD_HEIGHT, EIGHT_BIT_DEPTH)).toBe(1);
        expect(accepts(FULL_HD_WIDTH, FULL_HD_HEIGHT, TWELVE_BIT_DEPTH)).toBe(1);
        expect(accepts(MAXIMUM_WIDTH + 1, FULL_HD_HEIGHT, TEN_BIT_DEPTH)).toBe(0);
        expect(accepts(FULL_HD_WIDTH, MAXIMUM_HEIGHT + 1, TEN_BIT_DEPTH)).toBe(0);
    });

    it.each([
        [ 'I420' as const, EIGHT_BIT_SAMPLES_PER_WORKGROUP_ROW ],
        [ 'I444' as const, EIGHT_BIT_SAMPLES_PER_WORKGROUP_ROW ],
        [ 'I422P10' as const, SIXTEEN_BIT_SAMPLES_PER_WORKGROUP_ROW ],
        [ 'I420P12' as const, SIXTEEN_BIT_SAMPLES_PER_WORKGROUP_ROW ]
    ])('dispatches %s as one invocation per output word, one workgroup row per row, and one plane per z', (
        format: GPUDecoderOutputFormat,
        samplesPerWorkgroupRow: number
    ) => {
        const stream = { bitDepth: getGPUDecoderFormatFacts(format).bitDepth, codedHeight: FULL_HD_HEIGHT, codedWidth: FULL_HD_WIDTH };

        const counts = (manifest.dispatches[0].workgroupCounts ?? []).map(count => evaluatePassExpression(count, getGPUDecoderFacts(stream, format)));

        expect(counts).toEqual([ Math.ceil(FULL_HD_WIDTH / samplesPerWorkgroupRow), FULL_HD_HEIGHT, PLANE_COUNT ]);
    });

    it.each(GPU_DECODER_OUTPUT_FORMATS)('compiles its one body for %s behind a prelude that declares the sample size and both sample writers', (format: GPUDecoderOutputFormat) => {
        const decoderModule = createGPUDecoderModule(manifest, format);

        expect(decoderModule.code).toContain(`const SAMPLE_BYTES: u32 = ${getGPUDecoderFormatFacts(format).bytesPerSample}u;`);
        expect(decoderModule.code).toContain(EIGHT_BIT_WRITER_DECLARATION);
        expect(decoderModule.code).toContain(SIXTEEN_BIT_WRITER_DECLARATION);
    });

    it('branches on the prelude\'s sample size to the writer of each sample size, declaring neither itself', () => {
        expect(manifest.body).toContain(SAMPLE_BYTES_BRANCH);
        expect(manifest.body).toContain(EIGHT_BIT_WRITER_CALL);
        expect(manifest.body).toContain(SIXTEEN_BIT_WRITER_CALL);
        expect(manifest.body).not.toContain(EIGHT_BIT_WRITER_DECLARATION);
        expect(manifest.body).not.toContain(SIXTEEN_BIT_WRITER_DECLARATION);
        expect(manifest.body).not.toContain('const SAMPLE_BYTES');
    });
});
