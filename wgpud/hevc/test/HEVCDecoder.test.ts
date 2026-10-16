import { describe, expect, it } from 'vitest';

import { evaluatePassExpression } from 'webgpu-player/presentation/passes/PassExpression';
import type { PassExpression } from 'webgpu-player/presentation/passes/PassTypes';
import { MAXIMUM_STORAGE_BUFFER_BINDING_SIZE } from 'webgpu-player/presentation/WebGPUConstants';
import { getGPUDecoderFormatFacts, GPU_DECODER_OUTPUT_FORMATS, type GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import {
    GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH,
    GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT,
    GPU_DECODER_ERROR_CODE_SHIFT,
    GPU_DECODER_PARSER_ABI_VERSION,
    GPU_DECODER_MAXIMUM_ERROR_CODE
} from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import {
    describeGPUDecoderErrorWord,
    evaluateGPUDecoderByteLength,
    getGPUDecoderFacts,
    GPU_DECODER_STREAM_FACTS,
    parseGPUDecoderManifest
} from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import { createGPUDecoderModule } from 'webgpu-player/decode/video/gpu/GPUDecoderPrelude';
import type { GPUDecodeStreamFacts } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';

import { readDecoderProjectSource } from '../../../test/helpers/decoderPackages';

const PROJECT = 'hevc';
const DECODER_NAME = 'HEVC';
const CODEC_FAMILY = 'hevc';
// The DPB's pictures and the reorder depth the decoder declares
const REFERENCE_SLOT_COUNT = 16;
const REORDER_DEPTH = 8;
const MEBIBYTE = 1024 * 1024;
const MAXIMUM_PACKET_BYTE_LENGTH = 64 * MEBIBYTE;
// Level 6.2's limits, the largest picture the decoder takes
const MAXIMUM_WIDTH = 8192;
const MAXIMUM_HEIGHT = 4320;
const MAXIMUM_LUMA_PICTURE_SIZE = 8_912_896;
const ULTRA_HD_WIDTH = 3840;
const ULTRA_HD_HEIGHT = 2160;
const DCI_4K_WIDTH = 4096;
const DCI_4K_HEIGHT = 2176;
const FULL_HD_WIDTH = 1920;
const FULL_HD_HEIGHT = 1080;
// 1080 rows padded to whole 64-row blocks, as the pool sizes a 1080p stream
const FULL_HD_CODED_HEIGHT = 1088;
const EIGHT_K_WIDTH = 7680;
const EIGHT_K_HEIGHT = 4320;
const TEN_BIT_DEPTH = 10;
const EIGHT_BIT_DEPTH = 8;
const TWELVE_BIT_DEPTH = 12;
const PLANE_COUNT = 3;
const SCRATCH_BUFFER_NAMES = [ 'pictureState', 'blockData', 'residualData' ];
const RESIDUAL_BUFFER_NAME = 'residualData';
const MINIMUM_BYTE_LENGTH = 1;
const EMPTY_STATE_BYTE_LENGTH = 0;
const RESIDUAL_BYTES_PER_SAMPLE = 4;
const PREDICT_INTER_ENTRY_POINT = 'predictInter';
// predictInter's workgroups cover 8 words across, 32 bytes: 32 8-bit or 16 16-bit samples
const WORD_PASS_WORKGROUP_BYTE_WIDTH = 32;
// The prelude's format constants, which the body must leave to the prelude
const PRELUDE_FORMAT_CONSTANT_NAMES = [ 'OUTPUT_BIT_DEPTH', 'OUTPUT_CHROMA_FORMAT', 'SAMPLE_BYTES', 'SAMPLES_PER_WORD', 'SAMPLE_MASK' ];

// The passes ahead of the intra wavefront, the wavefront's even and odd waves, both of one entry point, and the passes after it, in dispatch order
const LEADING_ENTRY_POINTS = [ 'beginPicture', 'clearPicture', 'expandRecords', 'writePcmSamples', 'inverseTransform', 'predictInter' ];
const INTRA_ENTRY_POINT = 'predictIntra';
const INTRA_ENTRY_POINTS = [ INTRA_ENTRY_POINT, INTRA_ENTRY_POINT ];
// The odd wave's dispatch has one workgroup column more than the even one's, by which the entry point tells them apart
const ODD_WAVE_EXTRA_COLUMN_COUNT = 1;
const TRAILING_ENTRY_POINTS = [ 'deblockVertical', 'deblockHorizontal', 'copySaoSource', 'applySao' ];
// The wavefront's waves run over 64-sample strips and the rows of 16x16 CTBs, each row two strips behind the one above
const INTRA_STRIP_WIDTH = 64;
const INTRA_CTB_SIZE = 16;
const INTRA_WAVES_PER_REPEAT = 2;

// The transform matrix the body declares, and rows of it as FFmpeg's libavcodec/hevc/dsp.c lists them
const TRANSFORM_MATRIX_PATTERN = /const TRANSFORM_MATRIX = array<i32, 1024>\(([^)]*)\);/u;
const TRANSFORM_SIZE = 32;
const TRANSFORM_ROW_1 = [
    90, 90, 88, 85, 82, 78, 73, 67, 61, 54, 46, 38, 31, 22, 13, 4,
    -4, -13, -22, -31, -38, -46, -54, -61, -67, -73, -78, -82, -85, -88, -90, -90
];
const TRANSFORM_ROW_8 = [
    83, 36, -36, -83, -83, -36, 36, 83, 83, 36, -36, -83, -83, -36, 36, 83,
    83, 36, -36, -83, -83, -36, 36, 83, 83, 36, -36, -83, -83, -36, 36, 83
];
const TRANSFORM_ROW_17 = [
    61, -73, -46, 82, 31, -88, -13, 90, -4, -90, 22, 85, -38, -78, 54, 67,
    -67, -54, 78, 38, -85, -22, 90, 4, -90, 13, 88, -31, -82, 46, 73, -61
];
const TRANSFORM_ROW_31 = [
    4, -13, 22, -31, 38, -46, 54, -61, 67, -73, 78, -82, 85, -88, 90, -90,
    90, -90, 88, -85, 82, -78, 73, -67, 61, -54, 46, -38, 31, -22, 13, -4
];
const DC_COEFFICIENT = 64;

// A status error word: sliceData with failing value 13
const SLICE_DATA_ERROR_NAME = 'sliceData';
const SLICE_DATA_FAILURE_VALUE = 13;

/** One output format's residual samples per luma sample over its three planes: 1.5 at 4:2:0, 2 at 4:2:2, 3 at 4:4:4. */
type ResidualCase = readonly [GPUDecoderOutputFormat, number];

const RESIDUAL_CASES: readonly ResidualCase[] = [
    [ 'I420', 1.5 ],
    [ 'I422P10', 2 ],
    [ 'I444P12', 3 ]
];

function createStreamFacts(width: number, height: number, bitDepth: number): ReadonlyMap<string, number> {
    return new Map([
        [ GPU_DECODER_STREAM_FACTS.width, width ],
        [ GPU_DECODER_STREAM_FACTS.height, height ],
        [ GPU_DECODER_STREAM_FACTS.bitDepth, bitDepth ]
    ]);
}

function createCodedStream(width: number, height: number, format: GPUDecoderOutputFormat): Pick<GPUDecodeStreamFacts, 'bitDepth' | 'codedHeight' | 'codedWidth'> {
    return { bitDepth: getGPUDecoderFormatFacts(format).bitDepth, codedHeight: height, codedWidth: width };
}

function requireConstraint(constraint: PassExpression | null): PassExpression {
    if (!constraint) {
        throw new Error('The decoder accepts every stream');
    }
    return constraint;
}

function requireWorkgroupCount(counts: readonly PassExpression[] | null, axis: number): PassExpression {
    if (!counts) {
        throw new Error('The dispatch is indirect');
    }
    return counts[axis];
}

/** Returns the widest pool coded size of each pool height the decoder accepts: whole 64-sample blocks within its width, height, and picture size. */
function getLargestAcceptedCodedSizes(): Array<readonly [number, number]> {
    const sizes: Array<readonly [number, number]> = [];
    for (let height = GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT; height <= MAXIMUM_HEIGHT; height += GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT) {
        const widestBlocks = Math.floor(MAXIMUM_LUMA_PICTURE_SIZE / height / GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT);
        sizes.push([ Math.min(MAXIMUM_WIDTH, widestBlocks * GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT), height ]);
    }
    return sizes;
}

/** Returns the waves the intra wavefront needs: one per diagonal of strips over CTB rows, each row two strips behind the one above. */
function getIntraWaveCount(width: number, height: number): number {
    return Math.ceil(width / INTRA_STRIP_WIDTH) + 2 * Math.ceil(height / INTRA_CTB_SIZE) - 2;
}

/** Reads the transform matrix the body declares. */
function readTransformMatrix(source: string): number[] {
    const declaration = TRANSFORM_MATRIX_PATTERN.exec(source);
    if (!declaration) {
        throw new Error('The body declares no TRANSFORM_MATRIX');
    }
    return declaration[1].split(',').map((value: string): number => Number.parseInt(value.trim(), 10));
}

function getTransformRow(matrix: readonly number[], row: number): number[] {
    return matrix.slice(row * TRANSFORM_SIZE, (row + 1) * TRANSFORM_SIZE);
}

describe('the WGSL HEVC decoder', () => {
    const source = readDecoderProjectSource(PROJECT);
    const manifest = parseGPUDecoderManifest(source);

    it('parses into one decoder of every planar format, driven by its parser, with DPB references and reordering', () => {
        expect(manifest.name).toBe(DECODER_NAME);
        expect(manifest.accepts.codecs).toEqual([ CODEC_FAMILY ]);
        expect(manifest.outputFormats).toEqual(GPU_DECODER_OUTPUT_FORMATS);
        expect(manifest.parser).toBe(GPU_DECODER_PARSER_ABI_VERSION);
        expect(manifest.references).toBe(REFERENCE_SLOT_COUNT);
        expect(manifest.reorder).toBe(REORDER_DEPTH);
        expect(manifest.packetByteLength).toBe(MAXIMUM_PACKET_BYTE_LENGTH);
        expect(manifest.packetByteLength).toBeLessThanOrEqual(GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH);
    });

    it('names its error codes within a status word\'s high byte, and describes an error word by its name and failing value', () => {
        expect(manifest.errors.size).toBeGreaterThan(0);
        expect(new Set(manifest.errors.values()).size).toBe(manifest.errors.size);
        for (const code of manifest.errors.keys()) {
            expect(code).toBeGreaterThanOrEqual(1);
            expect(code).toBeLessThanOrEqual(GPU_DECODER_MAXIMUM_ERROR_CODE);
        }
        const sliceDataCode = [ ...manifest.errors ].find(([ , name ]) => name === SLICE_DATA_ERROR_NAME)?.[0] ?? 0;
        const errorWord = ((sliceDataCode << GPU_DECODER_ERROR_CODE_SHIFT) | SLICE_DATA_FAILURE_VALUE) >>> 0;

        expect(describeGPUDecoderErrorWord(manifest.errors, errorWord)).toBe(`${SLICE_DATA_ERROR_NAME}: ${SLICE_DATA_FAILURE_VALUE}`);
    });

    it('keeps the state and every scratch buffer within one default storage binding for every format at every accepted size', () => {
        const constraint = requireConstraint(manifest.accepts.constraint);
        const failures: string[] = [];

        expect(manifest.buffers.map(buffer => buffer.name)).toEqual(SCRATCH_BUFFER_NAMES);
        expect(manifest.buffers.filter(buffer => buffer.indirect)).toEqual([]);
        for (const [ width, height ] of getLargestAcceptedCodedSizes()) {
            for (const format of GPU_DECODER_OUTPUT_FORMATS) {
                const stream = createCodedStream(width, height, format);
                const facts = getGPUDecoderFacts(stream, format);
                expect(evaluatePassExpression(constraint, facts)).toBe(1);
                const stateByteLength = evaluateGPUDecoderByteLength(manifest.stateByteLength, facts, EMPTY_STATE_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE);
                if (stateByteLength.kind === 'invalid') {
                    failures.push(`${format} ${width}x${height} state ${stateByteLength.detail}`);
                }
                for (const buffer of manifest.buffers) {
                    const byteLength = evaluateGPUDecoderByteLength(buffer.byteLength, facts, MINIMUM_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE);
                    if (byteLength.kind === 'invalid') {
                        failures.push(`${format} ${width}x${height} ${buffer.name} ${byteLength.detail}`);
                    }
                }
            }
        }

        expect(failures).toEqual([]);
    });

    it.each(RESIDUAL_CASES)('sizes the %s residual buffer as one i32 per sample of its three planes', (format: GPUDecoderOutputFormat, samplesPerLumaSample: number) => {
        const residualBuffer = manifest.buffers.find(buffer => buffer.name === RESIDUAL_BUFFER_NAME);
        if (!residualBuffer) {
            throw new Error(`No ${RESIDUAL_BUFFER_NAME} buffer`);
        }
        const facts = getGPUDecoderFacts(createCodedStream(FULL_HD_WIDTH, FULL_HD_CODED_HEIGHT, format), format);

        expect(evaluatePassExpression(residualBuffer.byteLength, facts)).toBe(RESIDUAL_BYTES_PER_SAMPLE * FULL_HD_WIDTH * FULL_HD_CODED_HEIGHT * samplesPerLumaSample);
    });

    it('sets up the picture from its record, expands the records, reconstructs, then filters, with direct dispatches only', () => {
        expect(manifest.dispatches.map(dispatch => dispatch.entryPoint)).toEqual([ ...LEADING_ENTRY_POINTS, ...INTRA_ENTRY_POINTS, ...TRAILING_ENTRY_POINTS ]);
        expect(manifest.dispatches.every(dispatch => dispatch.indirectBuffer === null)).toBe(true);
    });

    it('repeats an even and an odd intra wave as many times as the stream\'s waves need, over the CTB rows, the odd one a column more, and three planes', () => {
        const facts = getGPUDecoderFacts(createCodedStream(FULL_HD_WIDTH, FULL_HD_HEIGHT, 'I420'), 'I420');

        expect(manifest.repeats).toHaveLength(1);
        const [ repeat ] = manifest.repeats;
        expect(repeat.firstDispatch).toBe(LEADING_ENTRY_POINTS.length);
        expect(repeat.dispatchCount).toBe(INTRA_WAVES_PER_REPEAT);
        expect(evaluatePassExpression(repeat.count, facts)).toBe(Math.ceil(getIntraWaveCount(FULL_HD_WIDTH, FULL_HD_HEIGHT) / INTRA_WAVES_PER_REPEAT));
        const [ evenWave, oddWave ] = manifest.dispatches.slice(repeat.firstDispatch, repeat.firstDispatch + repeat.dispatchCount);
        const rowCount = Math.ceil(FULL_HD_HEIGHT / INTRA_CTB_SIZE);
        expect(evaluatePassExpression(requireWorkgroupCount(evenWave.workgroupCounts, 0), facts)).toBe(rowCount);
        expect(evaluatePassExpression(requireWorkgroupCount(oddWave.workgroupCounts, 0), facts)).toBe(rowCount + ODD_WAVE_EXTRA_COLUMN_COUNT);
        for (const wave of [ evenWave, oddWave ]) {
            expect(wave.entryPoint).toBe(INTRA_ENTRY_POINT);
            expect(evaluatePassExpression(requireWorkgroupCount(wave.workgroupCounts, 2), facts)).toBe(PLANE_COUNT);
        }
    });

    it('covers a row with twice the per-word workgroups when the output format\'s samples take two bytes', () => {
        const predictInter = manifest.dispatches.find(dispatch => dispatch.entryPoint === PREDICT_INTER_ENTRY_POINT);
        if (!predictInter) {
            throw new Error(`No ${PREDICT_INTER_ENTRY_POINT} dispatch`);
        }

        const countColumns = (format: GPUDecoderOutputFormat): number => evaluatePassExpression(
            requireWorkgroupCount(predictInter.workgroupCounts, 0),
            getGPUDecoderFacts(createCodedStream(FULL_HD_WIDTH, FULL_HD_CODED_HEIGHT, format), format)
        );

        expect(countColumns('I420')).toBe(FULL_HD_WIDTH / WORD_PASS_WORKGROUP_BYTE_WIDTH);
        expect(countColumns('I420P10')).toBe(2 * FULL_HD_WIDTH / WORD_PASS_WORKGROUP_BYTE_WIDTH);
    });

    it('accepts pictures of any bit depth up to the level 6.2 picture size', () => {
        const constraint = requireConstraint(manifest.accepts.constraint);

        const accepts = (width: number, height: number, bitDepth: number): number => evaluatePassExpression(
            constraint,
            createStreamFacts(width, height, bitDepth)
        );
        expect(accepts(ULTRA_HD_WIDTH, ULTRA_HD_HEIGHT, TEN_BIT_DEPTH)).toBe(1);
        expect(accepts(DCI_4K_WIDTH, DCI_4K_HEIGHT, TWELVE_BIT_DEPTH)).toBe(1);
        expect(accepts(FULL_HD_WIDTH, FULL_HD_HEIGHT, EIGHT_BIT_DEPTH)).toBe(1);
        expect(accepts(EIGHT_K_WIDTH, EIGHT_K_HEIGHT, TEN_BIT_DEPTH)).toBe(0);
        expect(accepts(MAXIMUM_WIDTH + 1, FULL_HD_HEIGHT / 2, TEN_BIT_DEPTH)).toBe(0);
    });

    it.each(GPU_DECODER_OUTPUT_FORMATS)('compiles its one body for %s behind the prelude\'s format constants', (format: GPUDecoderOutputFormat) => {
        const facts = getGPUDecoderFormatFacts(format);

        const decoderModule = createGPUDecoderModule(manifest, format);

        expect(decoderModule.code).toContain(`const OUTPUT_BIT_DEPTH: u32 = ${facts.bitDepth}u;`);
        expect(decoderModule.code).toContain(`const SAMPLE_BYTES: u32 = ${facts.bytesPerSample}u;`);
    });

    it('leaves the output format\'s constants to the prelude', () => {
        for (const name of PRELUDE_FORMAT_CONSTANT_NAMES) {
            expect(manifest.body).not.toMatch(new RegExp(String.raw`\bconst ${name}\b`));
        }
    });

    it('declares the transform matrix as the specification rows FFmpeg lists', () => {
        const matrix = readTransformMatrix(source);

        expect(matrix).toHaveLength(TRANSFORM_SIZE * TRANSFORM_SIZE);
        expect(getTransformRow(matrix, 0)).toEqual(new Array<number>(TRANSFORM_SIZE).fill(DC_COEFFICIENT));
        expect(getTransformRow(matrix, 1)).toEqual(TRANSFORM_ROW_1);
        expect(getTransformRow(matrix, 8)).toEqual(TRANSFORM_ROW_8);
        expect(getTransformRow(matrix, 17)).toEqual(TRANSFORM_ROW_17);
        expect(getTransformRow(matrix, 31)).toEqual(TRANSFORM_ROW_31);
    });
});
