// @vitest-environment node

import { QUALIFICATION_VECTORS_DIRECTORY, WASM_OUTPUT_DIRECTORY } from '../../helpers/enginePaths';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { EncodedPacket, type VideoCodec, type VideoSample } from 'mediabunny';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
    HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS,
    type HEVCExactCapabilityVector,
    type HEVCExactCapabilityWorkerQualificationRequest
} from 'webgpu-player/capability/exact/HEVCExactCapabilityProtocol';
import { createHEVCExactCapabilityWorkerQualificationRequests } from 'webgpu-player/capability/vectors/HEVCExactCapabilityVectors';
import {
    createHEVCDecoderBackend,
    type HEVCDecoderBackend
} from 'webgpu-player/video/decoders/HEVCDecoderBackend';
import {
    HEVCVideoFrameWriter,
    prepareHEVCRawVideoFrame,
    type TransferringVideoFrameBufferInit
} from 'webgpu-player/video/decoders/HEVCFrameOutput';
import HEVCSoftwareVideoDecoder, {
    createOwnedHEVCSoftwareVideoDecoder,
    type HEVCSoftwareDecodedFrame,
    type HEVCSoftwareVideoDecoderDependencies
} from 'webgpu-player/video/decoders/HEVCSoftwareVideoDecoder';
import RawFrameBufferPool, {
    MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH
} from 'webgpu-player/video/RawFrameBufferPool';
import {
    copyVideoFrameToRawPlanes,
    createVideoSampleRawFrameSource,
    type PreparedRawVideoFrameSource,
    type RawVideoFrameGeometry,
    type TransferableRawVideoFrame
} from 'webgpu-player/video/RawVideoFrameCopy';

const HEVC_DECODER_DIRECTORY = resolve(WASM_OUTPUT_DIRECTORY, 'ffmpeg-hevc');
const HEVC_GLUE_PATH = resolve(HEVC_DECODER_DIRECTORY, 'ffmpeg-hevc.js');
const HEVC_WASM_PATH = resolve(HEVC_DECODER_DIRECTORY, 'ffmpeg-hevc.wasm');
// What the pinned native FFmpeg writes for the Main 10 key frame with -f rawvideo -pix_fmt yuv420p10le
const EXPECTED_PLANAR_FRAME_SHA256 = 'fa0c4d9ba5b220ecfc31556f485c6b6a82c2f9ba961efd9b294c141d9a93c217';
// The key frame's packet timing, which its sample carries
const KEY_FRAME_TIMESTAMP_SECONDS = 0;
const KEY_FRAME_DURATION_SECONDS = 1;

// One x265 Main10 640x360 IDR access unit with VPS, SPS, and PPS NAL units
const MAIN10_ANNEX_B_KEY_FRAME = Buffer.from(
    'AAAAAUABDAH//wIgAAADAJAAAAMAAAMA/5WYCQAAAAFCAQECIAAAAwCQAAADAAADAP+gBQIBaTZZWaSTK8BahIgEggAAAwACAAADAAIQAAAAAUQBwXGrEgAAAAEoAa8Fsx6qI8cNQBAMf4Gb///war4LzYFpPyp8FnwWfBZ8FnxHvEe8R7xHvEe8R7xHvEf0y1HI1qA11VWyKo0KPjI013cAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAACWgLcAAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAJ6AAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAABJQAAADAAADAAADAAADAAADAAADAAADAAADAAADAgYAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAWsA1me8AgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAABBw=',
    'base64'
);

// Regeneration recipe in PowerShell, with the FFmpeg git-862338fe31 and x265 of HEVCExactCapabilityVectors.ts:
// $params = 'bframes=0:repeat-headers=1:annexb=1:info=0:pools=1:frame-threads=1:wpp=0'
// ffmpeg -f lavfi -i "testsrc2=s=76x58:r=25" -frames:v 1 -pix_fmt yuv420p -c:v libx265 -profile:v main -preset ultrafast -x265-params $params -f hevc -y main-76x58.hevc
// and the same with -pix_fmt yuv420p10le -profile:v main10 for the Main 10 frame.
// x265 codes 80x64 and crops it to 76x58, so the decoder returns rows 80 and 40 samples apart, and the SPS describes no color
const CROPPED_MAIN_ANNEX_B_KEY_FRAME = Buffer.from(
    'AAAAAUABDAH//wFgAAADAJAAAAMAAAMAHroCQAAAAAFCAQEBYAAAAwCQAAADAAADAB6gKIEHcmW6SkwvAWgIAAADAAgAAAMAyEAAAAABRAHAc8CJAAABKAGsdqF9SOKa31ieFsSX+jMb9L6Yaf+FNRnLhpVqddhliRpSLAF3JnCAS1wlB3wgnLPKTe0oSJTFyPkMojc9Ulgu7pRWK/Fi/Z46gWZ//3luIlsiUG1mP4+oismGm6RXlHQSqoO0Z1+4+n3xmEQwvbvJiDqn/+35w7/MHPSAuTaytlmTm9rPpmfJYCWAdjgkbDmBE5THDVaXVgXDxa7JCgjGAM702y2BQVJOzE0m0T+POj/gciW+MR0DAuif3e0Yq9AroQpzqneEO422H/eb8XKonCOwHjsqeGGXAyCtpNbrC30R9/k034gtgtvCkEixs95xtWYXKY/39ieVmoebc7pm5HsyxKFcTulxKMjwmX9qVOgh3qAIQ9coVrLcq0VlOEXDvvWRXzAYx5CHjKEqA2avBwqJUqmvAwQZAJxioqxim5mNv4jepOCZmKnqnrFipxkS+B908LwMi6USOIKaaQhiPJl2aBK1O++Rz652T6U5kBB1YVciapscYs2/7pWhYNJlgOaXBFrmD28PL8EFtaoDbi6MwOFr9NewBitQ2/Rq7mAw+p/L/MOxSy7Jw0zzD2NbrhkIXJHRealIRFXR/yTuarCLLLAGxCRnT7eLAuOllsKJUxPuVJK6Oyyakj9FIAVjuoRT+xrkwshbf6KbXPetuBBOwxo0FCI7fJFRCP6VVqHN+0SDOcoqPFdx3M50TbFITKorq/rOeJurmDEgSnxP8C+4eoWlGMW+3QzXXldbRimYa1RueyUBO36fyHv1NfVAXGSIDzozvSKG//rL5MXgfb3Fi3eHREhdAlVOLCLNjMgf92NqET9eY6QgQdAJpsLar3N+Tcx7qMZQW2g5v2dcGmWFdur/ZTMCq3P0iu6JI4JjTZijTbTIcJ6fr0qMqPwRVsDKbfbrUhfQwsZliF+cOqGM6AjyoFVwIcbnZv47dIqD4DPBOnVqMGH8mouBObQTLGyC8xIrVtBrNvAqsjP/iSwNvbIHhDRfMaoxah8ViVIG9iO0OpvbBkhewQ/xZrTbP9FRQj85EeNeHxiltK12zTplCQ9d7jeHYwZalseoD9jRGS2wHwusyn0dKSOCfZkWaAxUOA87MEQWNToc7kSLKkc9kB+RhXeAoXevj4mHU37ysetlt1Ctyi6918JMTwBcreCAsbw=',
    'base64'
);
const CROPPED_MAIN10_ANNEX_B_KEY_FRAME = Buffer.from(
    'AAAAAUABDAH//wIgAAADAJAAAAMAAAMAHroCQAAAAAFCAQECIAAAAwCQAAADAAADAB6gKIEHcjZbpKTC8BaAgAAAAwCAAAAMhAAAAAFEAcBzwIkAAAEoAax2oX1I4prfWJ4WxJf6Mxv0vphp/4U1GcuGlWp12GWJGlIsAXcmcIBLXCUHfCCcs8pN7ShIlMXI+QyiNz1SWC7ulFYr8WL9njqBZn//eW4iWyJQbWY/j6iKyYabpFeUdBKqg7RnX7j6ffGYRDC9u8mIOqf/7fnDv8wc9IC5NrK2WZOb2s+mZ8lgJYB2OCRsOYETlMcNVpdWBcPFrskKCMYAzvTbLYFBUk7MTSbRP486P+ByJb4xHQMC+2/d7Rir0CuhCnOqd4Q7jbYf95vxcqicI7AeOyp4YZcDIK2k1usLfRH3+TTfiC2C28KQSLGz3nG1Zhcpj/f2J5Wah5tzumbkezK6VfCHN8jihFFBFl/HSmQYEy6WuUK1luVaKym8Xp5OQkt8wJ4PIQ8ZQlQGzV4OFP6KprwMEGQCcYqKsYpuZjb+I3h1malj37Gh/SMLWSJ95PVBm/XZ0okcQU00hDEeTLs0CVqd+9nntiyXsq8yRgxtn9PQJHL1FuT6StcTseHm80uCLT2uTXnjMm6BNa5+FdBHjVk17AGK1Db9GruYDD6n8v8w7FEt4rEZY1hyPV+gA3mIlon9Xvs48l+wtzpYRZSnI2ISM6gE1VGG4z5sy+hWS5VgrpNLJqSP0UgBWO6hFMPGuoauMHs2ZFrbXiviQUMZ/5Qi21yRS1OZNz/wciaNJnE4DGF+pNp7M/rEsEyqK4UJnPE3VzBiQJT4n+BfcPULSjGLfboZrryutoxTMNo3iOkPsWTmPi89/OSpaPmXil/Yrv7BOnUpjEf6yyLN9AvEpUO90CVU4q7s2M11V/i7vBEHBeYsOPcK0PZDBGaBh1QFalIaYNCBGidbM6vNMsK7ven9FCaVOyNUM0SRwTGmzEFiGkvfCWdiGGSKj8EVaSgvdrPBZEu4DIpckS78vRrsoIiSE1Z8V0BVj97S+GQQrDvbZke9wVgchW8AeCmwn1Ke8BFQrVsbrNvAqsjFIaE2fqpMWCKq4rKDbydFaxKmifShNo/QGurtJdcyL41Cec/mpcULR01wJ2XpICP3H7+6vrzkod+mfVTWEmcHOzTJPAIxog0NaFwq2z3oY2iznhlxrLhAgsCF2PZyIpqDyC6RGYwAEoJVJxDVujIUHq1toAw6q/eVj12tuodSNXRwZFYRphRP/bsGdW8=',
    'base64'
);
const CROPPED_CODED_WIDTH = 76;
const CROPPED_CODED_HEIGHT = 58;
const MAIN10_640X360_CODED_WIDTH = 640;
const MAIN10_640X360_CODED_HEIGHT = 360;
const MAIN_IN_BAND_CODEC = 'hev1.1.6.L120.B0';
const MAIN10_IN_BAND_CODEC = 'hev1.2.4.L120.B0';
const PQ_CONTAINER_COLOR_SPACE = {
    fullRange: false,
    matrix: 'bt2020-ncl',
    primaries: 'bt2020',
    transfer: 'pq'
} as unknown as VideoColorSpaceInit;
// Packet times of 1/24 s are not whole microseconds, so both paths must round them alike
const FRAME_DURATION_SECONDS = 1 / 24;
const MAIN10_4K_QUALIFICATION_BITSTREAM = Uint8Array.from(readFileSync(resolve(
    QUALIFICATION_VECTORS_DIRECTORY,
    'hevc', 'main10-4k-complex.hevc'
))).buffer;
// The 4K bitstream opens with an IDR frame, which decodes alone
const FIRST_ACCESS_UNIT_COUNT = 1;

type EmscriptenModuleFactory = (options: {
    locateFile?: (path: string, scriptDirectory: string) => string
    wasmBinary?: ArrayBuffer
}) => Promise<unknown>;

type MutableDecoderContract = {
    codec: VideoCodec
    config: VideoDecoderConfig
    onError: (error: unknown) => undefined
    onSample: (sample: VideoSample) => unknown
};

type FrameFormat = 'I420' | 'I420P10';

type HEVCVector = Readonly<{
    accessUnits: readonly Uint8Array[]
    codec: string
    codedHeight: number
    codedWidth: number
    colorSpace?: VideoColorSpaceInit
    format: FrameFormat
    label: string
}>;

/** What a VideoFrame reports, and the digest of its planes as compact rows of bytes. */
type RecordedVideoFrame = {
    codedHeight: number
    codedWidth: number
    colorSpace: {
        fullRange: boolean | null
        matrix: string | null
        primaries: string | null
        transfer: string | null
    }
    displayHeight: number
    displayWidth: number
    duration: number | null
    format: string
    planeDigest: string
    timestamp: number
    visibleRect: {
        height: number
        width: number
        x: number
        y: number
    }
};

/** Copies a buffer source's bytes into a fresh array, whatever its kind. */
function copyBufferSourceBytes(data: AllowSharedBufferSource): Uint8Array {
    return ArrayBuffer.isView(data) ?
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() :
        new Uint8Array(data).slice();
}

/** A VideoFrame of planar 4:2:0 data that records what the WebCodecs constructor would make of its init, and takes over transferred buffers. */
class RecordingVideoFrame {
    public readonly recorded: RecordedVideoFrame;
    public readonly close = vi.fn();
    public readonly codedHeight: number;
    public readonly codedWidth: number;
    public readonly displayHeight: number;
    public readonly displayWidth: number;
    public readonly duration: number | null;
    public readonly timestamp: number;

    public constructor(data: AllowSharedBufferSource, init: TransferringVideoFrameBufferInit) {
        const bytes = copyBufferSourceBytes(data);
        const bytesPerSample = init.format === 'I420' ? 1 : 2;
        const chromaWidth = Math.ceil(init.codedWidth / 2);
        const chromaHeight = Math.ceil(init.codedHeight / 2);
        const planeDimensions = [
            { height: init.codedHeight, width: init.codedWidth },
            { height: chromaHeight, width: chromaWidth },
            { height: chromaHeight, width: chromaWidth }
        ];
        const planeHash = createHash('sha256');
        planeDimensions.forEach((dimensions: { height: number, width: number }, planeIndex: number): void => {
            const layout = init.layout?.[planeIndex];
            if (!layout) {
                throw new TypeError('The recorded VideoFrame has no layout for a plane');
            }
            const rowByteLength = dimensions.width * bytesPerSample;
            for (let rowIndex = 0; rowIndex < dimensions.height; rowIndex += 1) {
                const rowOffset = layout.offset + (rowIndex * layout.stride);
                planeHash.update(bytes.subarray(rowOffset, rowOffset + rowByteLength));
            }
        });
        for (const transferredBuffer of init.transfer ?? []) {
            // The frame takes the buffer over, which detaches it
            // eslint-disable-next-line compat/compat -- Node runs this suite
            structuredClone(transferredBuffer, { transfer: [ transferredBuffer ] });
        }
        const visibleRect = {
            height: init.visibleRect?.height ?? init.codedHeight,
            width: init.visibleRect?.width ?? init.codedWidth,
            x: init.visibleRect?.x ?? 0,
            y: init.visibleRect?.y ?? 0
        };
        this.codedHeight = init.codedHeight;
        this.codedWidth = init.codedWidth;
        this.displayHeight = init.displayHeight ?? visibleRect.height;
        this.displayWidth = init.displayWidth ?? visibleRect.width;
        this.duration = init.duration ?? null;
        this.timestamp = init.timestamp;
        this.recorded = {
            codedHeight: this.codedHeight,
            codedWidth: this.codedWidth,
            colorSpace: {
                fullRange: init.colorSpace?.fullRange ?? null,
                matrix: init.colorSpace?.matrix ?? null,
                primaries: init.colorSpace?.primaries ?? null,
                transfer: init.colorSpace?.transfer ?? null
            },
            displayHeight: this.displayHeight,
            displayWidth: this.displayWidth,
            duration: this.duration,
            format: init.format,
            planeDigest: planeHash.digest('hex'),
            timestamp: this.timestamp,
            visibleRect
        };
    }
}

/** Loads the ffmpeg-hevc glue, a classic script that also exports its module factory to CommonJS. */
function loadActualModuleFactory(): EmscriptenModuleFactory {
    return createRequire(import.meta.url)(HEVC_GLUE_PATH) as EmscriptenModuleFactory;
}

function createDependencies(): HEVCSoftwareVideoDecoderDependencies {
    return {
        createDecoder: async (options): Promise<HEVCDecoderBackend> => (
            createHEVCDecoderBackend(options)
        ),
        loadDecoderGlue: (): void => undefined,
        resolveAssetURL: (path: string): string => (
            path.endsWith('.wasm') ? HEVC_WASM_PATH : HEVC_GLUE_PATH
        )
    };
}

function configureDecoder(
    decoder: HEVCSoftwareVideoDecoder,
    onSample: (sample: VideoSample) => unknown
): void {
    const mutableDecoder = decoder as unknown as MutableDecoderContract;
    mutableDecoder.codec = 'hevc';
    mutableDecoder.config = createVectorDecoderConfig({
        accessUnits: [],
        codec: MAIN10_IN_BAND_CODEC,
        codedHeight: MAIN10_640X360_CODED_HEIGHT,
        codedWidth: MAIN10_640X360_CODED_WIDTH,
        colorSpace: PQ_CONTAINER_COLOR_SPACE,
        format: 'I420P10',
        label: 'Main 10 640x360'
    });
    mutableDecoder.onError = (): undefined => undefined;
    mutableDecoder.onSample = onSample;
}

function createVectorDecoderConfig(vector: HEVCVector): VideoDecoderConfig {
    return {
        codec: vector.codec,
        codedHeight: vector.codedHeight,
        codedWidth: vector.codedWidth,
        ...(vector.colorSpace ? { colorSpace: vector.colorSpace } : {}),
        hardwareAcceleration: 'prefer-software'
    };
}

/** Returns the access units of a qualification vector, whose parameter sets travel in band. */
function createQualificationVector(
    vector: HEVCExactCapabilityVector,
    label: string,
    accessUnitCount?: number
): HEVCVector {
    const definition = HEVC_EXACT_CAPABILITY_VECTOR_DEFINITIONS[vector];
    const request = createHEVCExactCapabilityWorkerQualificationRequests(MAIN10_4K_QUALIFICATION_BITSTREAM).find(
        (qualificationRequest: HEVCExactCapabilityWorkerQualificationRequest): boolean => qualificationRequest.vector === vector
    );
    if (!request) {
        throw new Error(`The ${vector} qualification vector is unavailable`);
    }
    return {
        accessUnits: request.qualificationAccessUnits
            .slice(0, accessUnitCount)
            .map((accessUnit: ArrayBuffer): Uint8Array => new Uint8Array(accessUnit)),
        codec: definition.codecString.replace(/^hvc1/, 'hev1'),
        codedHeight: definition.codedHeight,
        codedWidth: definition.codedWidth,
        format: definition.format,
        label
    };
}

function createEncodedPacket(accessUnit: Uint8Array, frameIndex: number): EncodedPacket {
    return new EncodedPacket(
        new Uint8Array(accessUnit),
        'key',
        frameIndex * FRAME_DURATION_SECONDS,
        FRAME_DURATION_SECONDS,
        frameIndex
    );
}

/** Decodes a vector through the Mediabunny path, whose packed VideoSamples the playback worker copied until 10-09. */
async function decodeSamples(vector: HEVCVector): Promise<VideoSample[]> {
    const samples: VideoSample[] = [];
    const decoder = new HEVCSoftwareVideoDecoder(createDependencies());
    const mutableDecoder = decoder as unknown as MutableDecoderContract;
    mutableDecoder.codec = 'hevc';
    mutableDecoder.config = createVectorDecoderConfig(vector);
    mutableDecoder.onError = (): undefined => undefined;
    mutableDecoder.onSample = (sample: VideoSample): void => {
        samples.push(sample);
    };
    try {
        await decoder.init();
        vector.accessUnits.forEach((accessUnit: Uint8Array, frameIndex: number): void => {
            decoder.decode(createEncodedPacket(accessUnit, frameIndex));
        });
        decoder.flush();
    } finally {
        decoder.close();
    }
    return samples;
}

/**
 * Decodes a vector through the owned path, which hands each frame to the consumer while its planes are in WASM memory.
 * The consumer runs once for each decoder call with the frames that call drained.
 */
async function decodeOwnedFrames<Output>(
    vector: HEVCVector,
    writeFrame: (frame: HEVCSoftwareDecodedFrame) => Output,
    consumeDrainedOutputs: (outputs: Output[], firstFrameIndex: number) => void
): Promise<number> {
    const drainedOutputs: Output[] = [];
    let decoderError: unknown = null;
    const decoder = createOwnedHEVCSoftwareVideoDecoder(createVectorDecoderConfig(vector), {
        onError: (error: unknown): void => {
            decoderError = error;
        },
        onFrame: (frame: HEVCSoftwareDecodedFrame): void => {
            drainedOutputs.push(writeFrame(frame));
        }
    }, createDependencies());
    let consumedFrameCount = 0;
    const consumeOutputs = (): void => {
        const outputs = drainedOutputs.splice(0);
        consumeDrainedOutputs(outputs, consumedFrameCount);
        consumedFrameCount += outputs.length;
    };
    try {
        await decoder.init();
        vector.accessUnits.forEach((accessUnit: Uint8Array, frameIndex: number): void => {
            decoder.decode(createEncodedPacket(accessUnit, frameIndex));
            consumeOutputs();
        });
        decoder.flush();
        consumeOutputs();
    } finally {
        decoder.close();
    }
    expect(decoderError).toBeNull();
    return consumedFrameCount;
}

function getFrameGeometry(frame: TransferableRawVideoFrame): RawVideoFrameGeometry {
    return {
        codedHeight: frame.codedHeight,
        codedWidth: frame.codedWidth,
        displayHeight: frame.displayHeight,
        displayWidth: frame.displayWidth
    };
}

function getByteDigest(data: ArrayBuffer): string {
    return createHash('sha256').update(new Uint8Array(data)).digest('hex');
}

/** Requires two raw frames to match in every field and every byte, padding included. */
function expectSameRawFrame(actual: TransferableRawVideoFrame | null, expected: TransferableRawVideoFrame): void {
    expect(actual).not.toBeNull();
    const { data: actualData, ...actualMetadata } = actual as TransferableRawVideoFrame;
    const { data: expectedData, ...expectedMetadata } = expected;
    expect(actualMetadata).toEqual(expectedMetadata);
    expect(actualData.byteLength).toBe(expectedData.byteLength);
    expect(getByteDigest(actualData)).toBe(getByteDigest(expectedData));
}

const RAW_EXACTNESS_VECTORS: readonly HEVCVector[] = [
    {
        accessUnits: [ new Uint8Array(MAIN10_ANNEX_B_KEY_FRAME) ],
        codec: MAIN10_IN_BAND_CODEC,
        codedHeight: MAIN10_640X360_CODED_HEIGHT,
        codedWidth: MAIN10_640X360_CODED_WIDTH,
        colorSpace: PQ_CONTAINER_COLOR_SPACE,
        format: 'I420P10',
        label: 'a Main 10 640x360 IDR frame'
    },
    createQualificationVector('main-1080p', 'the Main 1080p qualification frames'),
    createQualificationVector('main10-1080p', 'the Main 10 1080p qualification frames'),
    createQualificationVector('main10-4k', 'the first Main 10 4K qualification frame', FIRST_ACCESS_UNIT_COUNT),
    {
        accessUnits: [ new Uint8Array(CROPPED_MAIN_ANNEX_B_KEY_FRAME) ],
        codec: MAIN_IN_BAND_CODEC,
        codedHeight: CROPPED_CODED_HEIGHT,
        codedWidth: CROPPED_CODED_WIDTH,
        format: 'I420',
        label: 'a cropped Main frame with padded rows'
    },
    {
        accessUnits: [ new Uint8Array(CROPPED_MAIN10_ANNEX_B_KEY_FRAME) ],
        codec: MAIN10_IN_BAND_CODEC,
        codedHeight: CROPPED_CODED_HEIGHT,
        codedWidth: CROPPED_CODED_WIDTH,
        format: 'I420P10',
        label: 'a cropped Main 10 frame with padded rows'
    }
];

const VIDEO_FRAME_EXACTNESS_VECTORS: readonly HEVCVector[] = RAW_EXACTNESS_VECTORS.filter(
    (vector: HEVCVector): boolean => vector.format === 'I420' || vector.codedWidth === CROPPED_CODED_WIDTH
);

let actualModuleFactory: EmscriptenModuleFactory;

beforeAll(() => {
    actualModuleFactory = loadActualModuleFactory();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('HEVC software decoder integration', () => {
    it('decodes a real Main 10 access unit through the ffmpeg-hevc kit', async () => {
        vi.stubGlobal('HEVCDecoderModule', actualModuleFactory);
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(createDependencies());
        configureDecoder(decoder, (sample: VideoSample): void => {
            samples.push(sample);
        });

        try {
            await decoder.init();
            decoder.decode(new EncodedPacket(
                new Uint8Array(MAIN10_ANNEX_B_KEY_FRAME),
                'key',
                KEY_FRAME_TIMESTAMP_SECONDS,
                KEY_FRAME_DURATION_SECONDS,
                0
            ));
            decoder.flush();

            expect(samples).toHaveLength(1);
            const sample = samples[0];
            expect(sample).toMatchObject({
                codedHeight: MAIN10_640X360_CODED_HEIGHT,
                codedWidth: MAIN10_640X360_CODED_WIDTH,
                duration: KEY_FRAME_DURATION_SECONDS,
                format: 'I420P10',
                timestamp: KEY_FRAME_TIMESTAMP_SECONDS
            });
            const planarFrame = new Uint8Array(sample.allocationSize());
            await sample.copyTo(planarFrame);
            expect(createHash('sha256').update(planarFrame).digest('hex')).toBe(
                EXPECTED_PLANAR_FRAME_SHA256
            );
        } finally {
            for (const sample of samples) {
                sample.close();
            }
            decoder.close();
        }
    });

    it.each(RAW_EXACTNESS_VECTORS)('prepares raw planes of $label byte for byte as the packed sample chain copies them', async (
        vector: HEVCVector
    ): Promise<void> => {
        vi.stubGlobal('HEVCDecoderModule', actualModuleFactory);
        const expectedFrames: TransferableRawVideoFrame[] = [];
        for (const sample of await decodeSamples(vector)) {
            expectedFrames.push(await copyVideoFrameToRawPlanes(createVideoSampleRawFrameSource(sample), {
                format: vector.format
            }));
        }
        // Each frame's buffer goes back to the pool once compared, so later frames are written over stale ones
        const bufferPool = new RawFrameBufferPool(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);
        const takenBuffers = new Set<ArrayBuffer>();

        const preparedFrameCount = await decodeOwnedFrames(
            vector,
            (frame: HEVCSoftwareDecodedFrame): PreparedRawVideoFrameSource => prepareHEVCRawVideoFrame(frame, bufferPool),
            (preparedFrames: PreparedRawVideoFrameSource[], firstFrameIndex: number): void => {
                preparedFrames.forEach((preparedFrame: PreparedRawVideoFrameSource, outputIndex: number): void => {
                    const expectedFrame = expectedFrames[firstFrameIndex + outputIndex];
                    const rawFrame = preparedFrame.takeRawFrame(vector.format, getFrameGeometry(expectedFrame));
                    expectSameRawFrame(rawFrame, expectedFrame);
                    takenBuffers.add(rawFrame?.data ?? new ArrayBuffer(0));
                    bufferPool.release(rawFrame?.data ?? new ArrayBuffer(0));
                });
            }
        );

        expect(preparedFrameCount).toBe(expectedFrames.length);
        expect(preparedFrameCount).toBe(vector.accessUnits.length);
        // Released buffers were written again, so a stream reuses its buffers
        expect(takenBuffers.size).toBeLessThanOrEqual(MAXIMUM_SPARE_RAW_FRAME_BUFFERS_PER_BYTE_LENGTH);
    });

    it.each(VIDEO_FRAME_EXACTNESS_VECTORS)('builds VideoFrames of $label as VideoSample.toVideoFrame does', async (
        vector: HEVCVector
    ): Promise<void> => {
        vi.stubGlobal('HEVCDecoderModule', actualModuleFactory);
        vi.stubGlobal('VideoFrame', RecordingVideoFrame);
        const expectedFrames: RecordedVideoFrame[] = [];
        for (const sample of await decodeSamples(vector)) {
            expectedFrames.push((sample.toVideoFrame() as unknown as RecordingVideoFrame).recorded);
            sample.close();
        }
        const writer = new HEVCVideoFrameWriter();

        const writtenFrameCount = await decodeOwnedFrames(
            vector,
            (frame: HEVCSoftwareDecodedFrame): VideoFrame => writer.write(frame),
            (videoFrames: VideoFrame[], firstFrameIndex: number): void => {
                videoFrames.forEach((videoFrame: VideoFrame, outputIndex: number): void => {
                    expect((videoFrame as unknown as RecordingVideoFrame).recorded).toEqual(
                        expectedFrames[firstFrameIndex + outputIndex]
                    );
                });
            }
        );

        expect(writtenFrameCount).toBe(expectedFrames.length);
        expect(writtenFrameCount).toBe(vector.accessUnits.length);
    });
});
