import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// The vector check runs behind a mock, so each test decides the check's outcome and counts the checks
vi.mock('webgpu-player/decode/video/gpu/GPUDecoderVectorCheck', () => ({
    checkGPUDecoderVector: vi.fn()
}));

import type { VideoDecoderPackage } from 'webgpu-player/decode/packages/DecoderPackage';
import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { GPU_DECODER_PARSER_ABI_VERSION } from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import type { GPUDecoderParserOutput } from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import { parseGPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import { checkGPUDecoderVector, type GPUDecoderVectorCheckResult } from 'webgpu-player/decode/video/gpu/GPUDecoderVectorCheck';
import { encodeGPUDecoderVectorSet, type GPUDecoderVector } from 'webgpu-player/decode/video/gpu/GPUDecoderVectorSet';
import {
    getGPUDecoderVectorFormats,
    verifyGPUDecoderPackage,
    type GPUDecoderVectorParserRunner
} from 'webgpu-player/decode/video/gpu/GPUDecoderVerification';
import { createGPUDecodeStreamFacts } from 'webgpu-player/decode/video/gpu/GPUFramePool';

// The package's id, and the lowercase hexadecimal SHA-256 of its file
const PACKAGE_ID = 'verification-test';
const CONTENT_HASH = 'c0de'.repeat(16);
// The smallest WebAssembly module, the magic and version, as a package without code holds
const EMPTY_MODULE_BYTES = Uint8Array.of(0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00);
const VECTOR_FORMAT: GPUDecoderOutputFormat = 'I420';
const SECOND_VECTOR_FORMAT: GPUDecoderOutputFormat = 'I420P10';
// A format the decoder writes but carries no vector for
const UNVECTORED_FORMAT: GPUDecoderOutputFormat = 'I422';
const OUTPUT_FORMATS: readonly GPUDecoderOutputFormat[] = [ VECTOR_FORMAT, SECOND_VECTOR_FORMAT, UNVECTORED_FORMAT ];
const VECTOR_HASH = 'aa55'.repeat(16);
const VECTOR_WIDTH = 64;
const VECTOR_HEIGHT = 36;
const VECTOR_PACKET_BYTES = [ 0x00, 0x00, 0x01, 0x40, 0x01 ];
const FRAME_DURATION_MICROSECONDS = 40_000;
const CODEC_FAMILY = 'test';
const PASSED_RESULT: GPUDecoderVectorCheckResult = { code: 'passed', detail: VECTOR_HASH };
const PARSER_OUTPUTS: GPUDecoderParserOutput[] = [ {
    pictures: [ {
        events: Uint32Array.of(0),
        fields: null,
        format: null,
        maximumPictureSize: null,
        record: new ArrayBuffer(VECTOR_PACKET_BYTES.length),
        repeatCounts: [],
        visibleSize: null
    } ],
    trailingEvents: new Uint32Array(0)
} ];
const PARSER_ERROR_MESSAGE = 'parser sliceData: 7';
const UNUSED_PARSER_MESSAGE = 'The parser ran';
const PARSER_REJECTION_REASON = 'worker ended';

type PackageOptions = {
    parser?: boolean
    /** The formats the vectors section holds vectors of, or null for no section */
    vectorFormats?: readonly GPUDecoderOutputFormat[] | null
};

// The vector check only receives the device, so any object stands for one
const DEVICE = {} as unknown as GPUDevice;

function createVector(format: GPUDecoderOutputFormat): GPUDecoderVector {
    return {
        codecPrivate: null,
        firstFrame: 0,
        format,
        lastFrame: 0,
        packets: [ { data: Uint8Array.from(VECTOR_PACKET_BYTES).buffer, durationMicroseconds: FRAME_DURATION_MICROSECONDS, keyframe: true, timestampMicroseconds: 0 } ],
        sha256: VECTOR_HASH,
        stream: createGPUDecodeStreamFacts(VECTOR_WIDTH, VECTOR_HEIGHT, format)
    };
}

/** Returns a video package as loadDecoderPackage returns one, with the vectors section the options say. */
function createPackage(options: PackageOptions = {}): VideoDecoderPackage {
    const vectorFormats = options.vectorFormats === undefined ? [ VECTOR_FORMAT ] : options.vectorFormats;
    const header = [
        `//! id: ${PACKAGE_ID}`,
        '//! name: Verification test',
        '//! decoder: video',
        `//! accepts: codec in [${CODEC_FAMILY}]`,
        `//! output: ${OUTPUT_FORMATS.join(', ')}`,
        ...(options.parser ? [ `//! parser: ${GPU_DECODER_PARSER_ABI_VERSION}` ] : []),
        '//! packet: 4096',
        '//! dispatch: copyPlanes, 1'
    ];
    const manifest = parseGPUDecoderManifest(`${header.join('\n')}\n\n@compute @workgroup_size(1)\nfn copyPlanes() {\n}\n`);
    return {
        contentHash: CONTENT_HASH,
        id: manifest.id,
        kind: 'video',
        manifest,
        memory: null,
        module: new WebAssembly.Module(EMPTY_MODULE_BYTES),
        name: manifest.name,
        vectors: vectorFormats === null ? null : Uint8Array.from(encodeGPUDecoderVectorSet(vectorFormats.map(createVector))).buffer
    };
}

/** Returns a parser runner a test expects never to run, which fails if it does. */
function createUnusedParserRunner(): Mock<GPUDecoderVectorParserRunner> {
    return vi.fn<GPUDecoderVectorParserRunner>((): Promise<GPUDecoderParserOutput[]> => Promise.reject(new Error(UNUSED_PARSER_MESSAGE)));
}

describe('verifyGPUDecoderPackage', () => {
    const checkVector = vi.mocked(checkGPUDecoderVector);

    beforeEach(() => {
        checkVector.mockResolvedValue(PASSED_RESULT);
    });

    it('reports a format the package carries no vector for as unverified, without checking or running its parser', async () => {
        const runParser = createUnusedParserRunner();

        const result = await verifyGPUDecoderPackage(DEVICE, createPackage({ parser: true }), UNVECTORED_FORMAT, runParser);

        expect(result).toEqual({ code: 'unverified', detail: UNVECTORED_FORMAT });
        expect(checkVector).not.toHaveBeenCalled();
        expect(runParser).not.toHaveBeenCalled();
    });

    it('reports a package without a vectors section as unverified', async () => {
        const result = await verifyGPUDecoderPackage(DEVICE, createPackage({ vectorFormats: null }), VECTOR_FORMAT);

        expect(result).toEqual({ code: 'unverified', detail: VECTOR_FORMAT });
        expect(checkVector).not.toHaveBeenCalled();
    });

    it('checks the format\'s vector from the set, without parser outputs for a package without a parser', async () => {
        const decoderPackage = createPackage({ vectorFormats: [ VECTOR_FORMAT, SECOND_VECTOR_FORMAT ] });
        const runParser = createUnusedParserRunner();

        const result = await verifyGPUDecoderPackage(DEVICE, decoderPackage, SECOND_VECTOR_FORMAT, runParser);

        expect(result).toBe(PASSED_RESULT);
        expect(checkVector).toHaveBeenCalledTimes(1);
        const [ checkedDevice, checkedManifest, checkedVector, parserOutputs ] = checkVector.mock.calls[0];
        expect(checkedDevice).toBe(DEVICE);
        expect(checkedManifest).toBe(decoderPackage.manifest);
        expect(checkedVector).toMatchObject({ firstFrame: 0, format: SECOND_VECTOR_FORMAT, lastFrame: 0, sha256: VECTOR_HASH });
        expect(checkedVector.stream).toEqual(createGPUDecodeStreamFacts(VECTOR_WIDTH, VECTOR_HEIGHT, SECOND_VECTOR_FORMAT));
        expect(checkedVector.packets.map(packet => [ ...new Uint8Array(packet.data) ])).toEqual([ VECTOR_PACKET_BYTES ]);
        expect(parserOutputs).toBeNull();
        expect(runParser).not.toHaveBeenCalled();
    });

    it('runs a package\'s parser over the vector and checks the outputs it made', async () => {
        const decoderPackage = createPackage({ parser: true });
        const runParser = vi.fn<GPUDecoderVectorParserRunner>((): Promise<GPUDecoderParserOutput[]> => Promise.resolve(PARSER_OUTPUTS));

        const result = await verifyGPUDecoderPackage(DEVICE, decoderPackage, VECTOR_FORMAT, runParser);

        expect(result).toBe(PASSED_RESULT);
        expect(runParser).toHaveBeenCalledTimes(1);
        const [ parserPackage, parserVector ] = runParser.mock.calls[0];
        expect(parserPackage).toBe(decoderPackage);
        expect(parserVector.format).toBe(VECTOR_FORMAT);
        expect(checkVector.mock.calls[0][2]).toBe(parserVector);
        expect(checkVector.mock.calls[0][3]).toBe(PARSER_OUTPUTS);
    });

    it('reports a parser that fails on the vector as parser-failed with its message, without checking', async () => {
        const runParser = vi.fn<GPUDecoderVectorParserRunner>((): Promise<GPUDecoderParserOutput[]> => Promise.reject(new Error(PARSER_ERROR_MESSAGE)));

        const result = await verifyGPUDecoderPackage(DEVICE, createPackage({ parser: true }), VECTOR_FORMAT, runParser);

        expect(result).toEqual({ code: 'parser-failed', detail: PARSER_ERROR_MESSAGE });
        expect(checkVector).not.toHaveBeenCalled();
    });

    it('names a parser failure that is no Error by its text', async () => {
        const runParser = vi.fn<GPUDecoderVectorParserRunner>((): Promise<GPUDecoderParserOutput[]> => Promise.reject(PARSER_REJECTION_REASON));

        const result = await verifyGPUDecoderPackage(DEVICE, createPackage({ parser: true }), VECTOR_FORMAT, runParser);

        expect(result).toEqual({ code: 'parser-failed', detail: PARSER_REJECTION_REASON });
    });

    it('checks again on every call, since verification runs only when a host asks for it', async () => {
        const decoderPackage = createPackage();

        await verifyGPUDecoderPackage(DEVICE, decoderPackage, VECTOR_FORMAT);
        await verifyGPUDecoderPackage(DEVICE, decoderPackage, VECTOR_FORMAT);

        expect(checkVector).toHaveBeenCalledTimes(2);
    });
});

describe('getGPUDecoderVectorFormats', () => {
    it('lists the formats a package carries vectors for, in its output order', () => {
        expect(getGPUDecoderVectorFormats(createPackage({ vectorFormats: [ SECOND_VECTOR_FORMAT, VECTOR_FORMAT ] }))).toEqual([ VECTOR_FORMAT, SECOND_VECTOR_FORMAT ]);
        expect(getGPUDecoderVectorFormats(createPackage({ vectorFormats: null }))).toEqual([]);
    });
});
