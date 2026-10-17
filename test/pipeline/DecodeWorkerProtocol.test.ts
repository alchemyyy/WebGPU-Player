import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    millisecondsToMicroseconds,
    secondsToMicroseconds
} from 'webgpu-player/MediaTime';
import {
    getCustomDecodeHardwareAcceleration,
    getCustomDecodeRequestHardwareAcceleration,
    getDolbyVisionRawFrameLayerCount,
    getVideoCreditLimit,
    isDecodeWorkerRequest,
    isDecodeWorkerResponse,
    MAX_DECODED_AUDIO_CHANNELS,
    MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE,
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
    MAX_DECODED_FRAME_CREDITS,
    MAX_DECODED_RAW_FRAME_CREDITS,
    MAX_GPU_DECODE_PACKET_CREDITS,
    MAXIMUM_VIDEO_STARTUP_PROGRESS_PACKET_COUNT,
    type DecodeWorkerAudioOutputAttachment,
    type DecodeWorkerGPUVideoParser
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import { DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } from 'webgpu-player/decode/packages/DecoderPackageImports';
import {
    GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH,
    GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH,
    MAXIMUM_GPU_DECODE_OUTPUT_EVENTS
} from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import { CUSTOM_AUDIO_DOWNMIX_ALGORITHMS } from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import {
    DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION,
    MAXIMUM_DOLBY_VISION_FRAME_RPU_COUNT
} from 'webgpu-player/demux/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from 'webgpu-player/demux/dolby-vision/DolbyVisionRPUParser';
import { MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH } from 'webgpu-player/audio/native/NativeMediaAudioLimits';
import {
    type RawVideoPlaneDescriptor,
    type TransferableRawVideoFrame
} from 'webgpu-player/decode/video/RawVideoFrameCopy';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';
import { parseHEVCHDR10PlusMetadata } from 'webgpu-player/demux/hdr/HDR10PlusMetadata';

import { MAXIMUM_TIMING_TRACE_EVENTS_PER_MESSAGE } from 'webgpu-player/TimingTrace';

import { createHDR10PlusHEVCVector } from '../../src/capability/vectors/HDR10PlusVectors';
import { createParserStubModuleBinary, STUB_MODULE_MEMORY_PAGES } from '../helpers/decoderPackages';

const DOLBY_VISION_RPU_PARSER_WASM_URL = 'https://example.test/libraries/libdovi/dovi-rpu-parser.wasm';
// The CPU decoder backends decoder packages replaced, and a name no backend ever had
const REMOVED_VIDEO_DECODER_BACKENDS = [ 'bundled-hevc', 'ffmpeg-mpeg2-vc1', 'openjpeg', 'software' ] as const;
// A ready response's chroma format, and members no reader declares
const DECLARED_CHROMA_FORMAT = { location: 'top-left', subsampling: '4:2:0' } as const;
const UNKNOWN_CHROMA_LOCATION = 'middle';
const UNKNOWN_CHROMA_SUBSAMPLING = '4:1:1';
const MEDIA_FILE_NAME = 'video.mkv';
const MEDIA_URL = 'http://localhost/video.mkv';
const UNKNOWN_MEDIA_SOURCE_KIND = 'stream';
// Any positive epoch time; worker events carry the shared epoch clock
const TIMING_TRACE_EVENT_EPOCH_MILLISECONDS = 1_791_000_000_000;
// A 90-minute feature, and durations a server could not have reported: none, negative, fractional, and not a number
const SERVER_DURATION_MICROSECONDS = secondsToMicroseconds(5_400);
const INVALID_SERVER_DURATIONS = [ 0, -1, 1.5, '5400000000' ] as const;

const RAW_TEST_FRAME_CODED_WIDTH = 4;
const RAW_TEST_FRAME_CODED_HEIGHT = 2;
const RAW_TEST_FRAME_BYTES_PER_ROW = 256;
const RAW_TEST_FRAME_FORMATS = {
    I420: { bitDepth: 8, bytesPerComponent: 1, chromaHeightDivisor: 2, chromaWidthDivisor: 2 },
    I420P10: { bitDepth: 10, bytesPerComponent: 2, chromaHeightDivisor: 2, chromaWidthDivisor: 2 },
    I422P10: { bitDepth: 10, bytesPerComponent: 2, chromaHeightDivisor: 1, chromaWidthDivisor: 2 },
    I444P12: { bitDepth: 12, bytesPerComponent: 2, chromaHeightDivisor: 1, chromaWidthDivisor: 1 }
} as const;

type RawTestFrameFormat = keyof typeof RAW_TEST_FRAME_FORMATS;

const ULTRA_HD_8K_CODED_WIDTH = 7_680;
const ULTRA_HD_8K_CODED_HEIGHT = 4_320;
const ULTRA_HD_16K_CODED_WIDTH = 15_360;
const ULTRA_HD_16K_CODED_HEIGHT = 8_640;
// A row this wide has a byte length past the safe integer range, so no copy layout can describe it
const UNREPRESENTABLE_CODED_WIDTH = Number.MAX_SAFE_INTEGER;
const UNREPRESENTABLE_CODED_HEIGHT = 2;

// A frame's fields as the worker posts them, and malformed ones: an unknown scan, which a frame never carries, a missing or mistyped flag, and no record
const TOP_FIRST_FIELDS = { repeatFirstField: false, scan: 'top-first' } as const;
const SOFT_TELECINE_FIELDS = { repeatFirstField: true, scan: 'progressive' } as const;
const MALFORMED_FIELDS: readonly unknown[] = [
    { repeatFirstField: false, scan: 'unknown' },
    { scan: 'top-first' },
    { repeatFirstField: 0, scan: 'progressive' },
    { repeatFirstField: false, scan: 'field-sequential' },
    null,
    0x7
];

// Malformed rates; any positive integer rate is valid
const ZERO_SAMPLE_RATE = 0;
const NEGATIVE_SAMPLE_RATE = -1;
const FRACTIONAL_SAMPLE_RATE = 48_000.5;

// The producer's channel to a worklet of two seconds at 48 kHz
const AUDIO_OUTPUT_SAMPLE_RATE = 48_000;
const AUDIO_OUTPUT_MAXIMUM_BUFFERED_FRAME_COUNT = 96_000;
const AUDIO_OUTPUT_WORKLET_GENERATION = 5;
const AUDIO_PROGRESS_FRAME_COUNT = 1_024;
const AUDIO_PROGRESS_DURATION_MICROSECONDS = 21_333;

// Every channel a test opens, which closes once the test ends
const openedPorts: MessagePort[] = [];

afterEach(() => {
    for (const port of openedPorts.splice(0)) {
        port.close();
    }
});

/** Returns the producer's end of a new channel to a worklet of the layout. */
function createAudioOutputAttachment(channelCount: number, audioSampleCredits = MAX_DECODED_AUDIO_SAMPLE_CREDITS): DecodeWorkerAudioOutputAttachment {
    const channel = new MessageChannel();
    openedPorts.push(channel.port1, channel.port2);
    return {
        audioSampleCredits,
        channelCount,
        maximumBufferedFrameCount: AUDIO_OUTPUT_MAXIMUM_BUFFERED_FRAME_COUNT,
        port: channel.port2,
        sampleRate: AUDIO_OUTPUT_SAMPLE_RATE,
        workletGeneration: AUDIO_OUTPUT_WORKLET_GENERATION
    };
}

// HDR10+ profile A leaves the targeted display at 0, which a tone-mapping curve cannot adapt from
const UNTARGETED_DISPLAY_LUMINANCE_NITS = 0;

const STOPPED_RUN_GENERATION = 3;

// A 2160p HEVC Main 10 track on the frame-pool route, whose pool rounds 2160 up to whole 64-pixel blocks
const GPU_VIDEO_CODEC = 'hevc';
// A decoder package's parser as the start request carries it: its compiled module, memory, and error names, and the package's id and content hash
const GPU_PARSER_MODULE_BINARY = createParserStubModuleBinary();
const GPU_VIDEO_PARSER: DecodeWorkerGPUVideoParser = {
    packageVersion: { contentHash: '0f'.repeat(32), id: 'hevc' },
    parser: {
        errorNames: new Map([ [ 1, 'configuration' ] ]),
        errorRecoveries: new Map(),
        memory: { initialPages: STUB_MODULE_MEMORY_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES },
        module: new WebAssembly.Module(GPU_PARSER_MODULE_BINARY),
        repeatDirectiveCount: 1
    }
};
// A picture's own visible size and repeat counts, and the largest picture a parser read in the codec private data
const GPU_PICTURE_SIZE = { height: 1_080, width: 1_920 };
const GPU_PICTURE_REPEAT_COUNTS = [ 0, 0xFFFF_FFFF ];
const GPU_MAXIMUM_PICTURE_SIZE = { height: 4_320, width: 7_680 };
// The parser field's form before decoder packages: a codec name
const GPU_VIDEO_PARSER_NAME = 'hevc';
const GPU_VIDEO_GENERATION = 6;
const GPU_POOL_CODED_WIDTH = 3_840;
const GPU_POOL_CODED_HEIGHT = 2_176;
const GPU_PACKET_BYTE_LENGTH = 4_096;
const GPU_CODEC_PRIVATE_BYTE_LENGTH = 128;
const GPU_PACKET_DURATION_MICROSECONDS = 41_708;
const GPU_PACKET_TIMESTAMP_MICROSECONDS = -500_000;
// A parser's output events for a packet: an earlier picture dropped, then the packet's own presented
const GPU_PACKET_OUTPUT_EVENTS = Uint32Array.of(0x8000_0000, 1);

function createPackedRPUData(): ArrayBuffer {
    return createDolbyVisionAuthorizationRPUVector();
}

/** Creates a 4x2 frame whose planes start at an offset of its own buffer, as the worker lays them out. */
function createRawFrame(format: RawTestFrameFormat = 'I420', byteOffset = 0): TransferableRawVideoFrame {
    const formatDefinition = RAW_TEST_FRAME_FORMATS[format];
    const chromaWidth = RAW_TEST_FRAME_CODED_WIDTH / formatDefinition.chromaWidthDivisor;
    const chromaHeight = RAW_TEST_FRAME_CODED_HEIGHT / formatDefinition.chromaHeightDivisor;
    const planeGeometries = [
        { height: RAW_TEST_FRAME_CODED_HEIGHT, kind: 'y', width: RAW_TEST_FRAME_CODED_WIDTH },
        { height: chromaHeight, kind: 'u', width: chromaWidth },
        { height: chromaHeight, kind: 'v', width: chromaWidth }
    ] as const;
    const planes: RawVideoPlaneDescriptor[] = [];
    let planeByteOffset = byteOffset;
    for (const planeGeometry of planeGeometries) {
        const byteLength = RAW_TEST_FRAME_BYTES_PER_ROW * planeGeometry.height;
        planes.push({
            byteLength,
            byteOffset: planeByteOffset,
            bytesPerComponent: formatDefinition.bytesPerComponent,
            bytesPerRow: RAW_TEST_FRAME_BYTES_PER_ROW,
            componentsPerTexel: 1,
            height: planeGeometry.height,
            kind: planeGeometry.kind,
            rowByteLength: planeGeometry.width * formatDefinition.bytesPerComponent,
            width: planeGeometry.width
        });
        planeByteOffset += byteLength;
    }
    return {
        bitDepth: formatDefinition.bitDepth,
        codedHeight: RAW_TEST_FRAME_CODED_HEIGHT,
        codedWidth: RAW_TEST_FRAME_CODED_WIDTH,
        colorSpace: {
            fullRange: false,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'bt709'
        },
        data: new ArrayBuffer(planeByteOffset),
        displayHeight: RAW_TEST_FRAME_CODED_HEIGHT,
        displayWidth: RAW_TEST_FRAME_CODED_WIDTH,
        durationMicroseconds: millisecondsToMicroseconds(41.708),
        format,
        planes,
        timestampMicroseconds: secondsToMicroseconds(-0.5),
        visibleRectangle: {
            height: RAW_TEST_FRAME_CODED_HEIGHT,
            width: RAW_TEST_FRAME_CODED_WIDTH,
            x: 0,
            y: 0
        }
    };
}

/** Lays a BL in any format and an EL in one buffer, the EL at the next aligned offset. */
function createCompoundRawFrames(baseFormat: RawTestFrameFormat = 'I420', enhancementFormat: RawTestFrameFormat = 'I420P10'): {
    baseFrame: TransferableRawVideoFrame
    enhancementFrame: TransferableRawVideoFrame
} {
    const baseFrame = createRawFrame(baseFormat);
    const enhancementFrame = createRawFrame(enhancementFormat, baseFrame.data.byteLength);
    const data = enhancementFrame.data;
    baseFrame.data = data;
    return { baseFrame, enhancementFrame };
}

describe('DecodeWorkerProtocol', () => {
    it('accepts only generation-scoped validated live downmix settings', () => {
        const request = {
            audioDownmixSettings: {
                centerLevel: 0.75,
                outputGain: 1.25,
                surroundLevel: 0.5,
                version: 1
            },
            generation: 4,
            type: 'update-audio-downmix-settings'
        } as const;

        expect(isDecodeWorkerRequest(request)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...request,
            generation: 0
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...request,
            audioDownmixSettings: {
                ...request.audioDownmixSettings,
                outputGain: 11
            }
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...request,
            audioDownmixSettings: {
                ...request.audioDownmixSettings,
                version: 2
            }
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            generation: request.generation,
            type: request.type
        })).toBe(false);
    });

    it('selects no preference for raw planes of any codec and for the frame-pool route', () => {
        expect(getCustomDecodeHardwareAcceleration('raw-planes')).toBe('no-preference');
        expect(getCustomDecodeHardwareAcceleration('raw-planes', true)).toBe('no-preference');
        // The frame-pool route opens no WebCodecs decoder
        expect(getCustomDecodeHardwareAcceleration('frame-pool', true)).toBe('no-preference');
    });

    it('prefers hardware only for native VideoFrames whose opaque hardware output is presented', () => {
        // The SDR probes qualify with no preference, so a codec without a hardware decoder still plays
        expect(getCustomDecodeHardwareAcceleration('video-frame')).toBe('no-preference');
        expect(getCustomDecodeHardwareAcceleration('video-frame', true)).toBe('prefer-hardware');
    });

    it('prefers software only for raw AV1 and VP9 planes, whose hardware output is opaque', () => {
        expect(getCustomDecodeHardwareAcceleration('raw-planes', false, 'av1')).toBe('prefer-software');
        expect(getCustomDecodeHardwareAcceleration('raw-planes', true, 'av1')).toBe('prefer-software');
        expect(getCustomDecodeHardwareAcceleration('raw-planes', false, 'vp9')).toBe('prefer-software');
        // Chromium has no software HEVC decoder
        expect(getCustomDecodeHardwareAcceleration('raw-planes', false, 'hevc')).toBe('no-preference');
        expect(getCustomDecodeHardwareAcceleration('video-frame', false, 'av1')).toBe('no-preference');
        expect(getCustomDecodeHardwareAcceleration('video-frame', false, 'vp9')).toBe('no-preference');
        expect(getCustomDecodeHardwareAcceleration('video-frame', true, 'av1')).toBe('prefer-hardware');
    });

    it.each([
        {
            expected: 'no-preference',
            request: {
                dolbyVisionProfile: null,
                neutralizeHDRColorMetadata: false,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            },
            videoCodec: 'av1'
        },
        {
            expected: 'prefer-hardware',
            request: {
                dolbyVisionProfile: null,
                neutralizeHDRColorMetadata: true,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            },
            videoCodec: 'hevc'
        },
        {
            expected: 'prefer-hardware',
            request: {
                dolbyVisionProfile: 5,
                neutralizeHDRColorMetadata: false,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            },
            videoCodec: 'hevc'
        },
        {
            expected: 'no-preference',
            request: {
                dolbyVisionProfile: 8,
                neutralizeHDRColorMetadata: false,
                videoDecoderBackend: 'native',
                videoOutputMode: 'raw-planes'
            },
            videoCodec: 'hevc'
        },
        {
            expected: 'prefer-software',
            request: {
                dolbyVisionProfile: 8,
                neutralizeHDRColorMetadata: false,
                videoDecoderBackend: 'native',
                videoOutputMode: 'raw-planes'
            },
            videoCodec: 'av1'
        },
        {
            expected: 'prefer-software',
            request: {
                dolbyVisionProfile: null,
                neutralizeHDRColorMetadata: false,
                videoDecoderBackend: 'native',
                videoOutputMode: 'raw-planes'
            },
            videoCodec: 'vp9'
        },
        {
            expected: 'no-preference',
            request: {
                dolbyVisionProfile: null,
                neutralizeHDRColorMetadata: false,
                videoDecoderBackend: 'gpu',
                videoOutputMode: 'frame-pool'
            },
            videoCodec: null
        }
    ] as const)('selects $expected for a $videoCodec start request route', ({ expected, request, videoCodec }) => {
        expect(getCustomDecodeRequestHardwareAcceleration(request, videoCodec)).toBe(expected);
    });

    it('validates the server duration of a start request and the positive container duration report', () => {
        const request = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mkv' },
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;
        const readyResponse = {
            audio: null,
            codec: 'avc1.640028',
            codedHeight: 1_080,
            codedWidth: 1_920,
            containerDurationMicroseconds: 5_400_000_000,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 1,
            type: 'ready'
        } as const;

        expect(isDecodeWorkerRequest(request)).toBe(true);
        expect(isDecodeWorkerRequest({ ...request, durationMicroseconds: SERVER_DURATION_MICROSECONDS })).toBe(true);
        for (const durationMicroseconds of INVALID_SERVER_DURATIONS) {
            expect(isDecodeWorkerRequest({ ...request, durationMicroseconds })).toBe(false);
        }
        expect(isDecodeWorkerResponse(readyResponse)).toBe(true);
        expect(isDecodeWorkerResponse({ ...readyResponse, containerDurationMicroseconds: 0 })).toBe(false);
        expect(isDecodeWorkerResponse({ ...readyResponse, containerDurationMicroseconds: -1 })).toBe(false);
    });

    it('accepts a start request that reads a File or a non-empty URL', () => {
        const request = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            source: { file: new File([], MEDIA_FILE_NAME), kind: 'file' },
            startTimeMicroseconds: 0,
            type: 'start',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;

        expect(isDecodeWorkerRequest(request)).toBe(true);
        // A Blob that is not a File, an empty URL, an unknown kind, and a missing source
        expect(isDecodeWorkerRequest({ ...request, source: { file: new Blob(), kind: 'file' } })).toBe(false);
        expect(isDecodeWorkerRequest({ ...request, source: { kind: 'url', url: '' } })).toBe(false);
        expect(isDecodeWorkerRequest({ ...request, source: { kind: UNKNOWN_MEDIA_SOURCE_KIND, url: MEDIA_URL } })).toBe(false);
        expect(isDecodeWorkerRequest({ ...request, source: undefined })).toBe(false);
    });

    it('validates the timing trace request and its event batches', () => {
        const request = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            timingTrace: true,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mkv' },
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;
        const timingEvent = {
            epochMilliseconds: TIMING_TRACE_EVENT_EPOCH_MILLISECONDS,
            fields: { waitMilliseconds: 1 },
            kind: 'video-credit-wait'
        } as const;
        const timingResponse = { events: [ timingEvent ], generation: 1, type: 'timing-trace' } as const;

        expect(isDecodeWorkerRequest(request)).toBe(true);
        expect(isDecodeWorkerRequest({ ...request, timingTrace: 'yes' })).toBe(false);
        expect(isDecodeWorkerResponse(timingResponse)).toBe(true);
        expect(isDecodeWorkerResponse({ ...timingResponse, events: [] })).toBe(false);
        expect(isDecodeWorkerResponse({ ...timingResponse, events: [ { ...timingEvent, kind: 'unknown-kind' } ] })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...timingResponse,
            events: Array.from({ length: MAXIMUM_TIMING_TRACE_EVENTS_PER_MESSAGE + 1 }, () => timingEvent)
        })).toBe(false);
    });

    it.each(REMOVED_VIDEO_DECODER_BACKENDS)('refuses the %s video decoder backend, which only native and gpu replace', (videoDecoderBackend) => {
        const request = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mkv' },
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;

        expect(isDecodeWorkerRequest(request)).toBe(true);
        expect(isDecodeWorkerRequest({ ...request, videoDecoderBackend })).toBe(false);
    });

    it('accepts integer-microsecond start and frame messages', () => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: -1_000_000,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mp4' },
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        })).toBe(true);

        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            frame: { close: vi.fn() },
            generation: 1,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'video-frame',
            type: 'frame'
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            buffer: new ArrayBuffer(1_024),
            generation: 2,
            type: 'recycle-frame'
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            buffer: new ArrayBuffer(0),
            generation: 2,
            type: 'recycle-frame'
        })).toBe(false);
    });

    it('accepts bounded owned-video startup progress', () => {
        expect(isDecodeWorkerResponse({
            generation: 2,
            mediaTimeMicroseconds: 2_733_022_000,
            packetCount: 0,
            phase: 'video-key-packet-ready',
            type: 'progress'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            generation: 2,
            mediaTimeMicroseconds: 2_733_063_708,
            packetCount: 1,
            phase: 'video-packet-started',
            type: 'progress'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            generation: 2,
            mediaTimeMicroseconds: 0.5,
            packetCount: 1,
            phase: 'video-packet-decoded',
            type: 'progress'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            generation: 2,
            mediaTimeMicroseconds: null,
            packetCount: MAXIMUM_VIDEO_STARTUP_PROGRESS_PACKET_COUNT + 1,
            phase: 'video-packet-decoded',
            type: 'progress'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            generation: 2,
            mediaTimeMicroseconds: null,
            packetCount: 1,
            phase: 'video-demuxing',
            type: 'progress'
        })).toBe(false);
    });

    it('accepts only supported Dolby Vision profile values', () => {
        const baseRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 2,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mkv' },
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        } as const;
        // Profile 20 and the base-only profiles never reach the worker; they present as 5, 8, or null
        const supportedProfiles: readonly unknown[] = [ null, 4, 5, 7, 8 ];
        const unsupportedProfiles: readonly unknown[] = [ undefined, 0, 6, 9, 20, '7' ];

        for (const supportedProfile of supportedProfiles) {
            expect(isDecodeWorkerRequest({
                ...baseRequest,
                dolbyVisionProfile: supportedProfile
            })).toBe(true);
        }
        for (const unsupportedProfile of unsupportedProfiles) {
            expect(isDecodeWorkerRequest({
                ...baseRequest,
                dolbyVisionProfile: unsupportedProfile
            })).toBe(false);
        }
    });

    it.each([
        [ null, 1 ],
        [ 5, 1 ],
        [ 8, 1 ],
        [ 4, 2 ],
        [ 7, 2 ]
    ] as const)('budgets Dolby Vision profile %s at %i raw frame layers', (profile, layerCount) => {
        expect(getDolbyVisionRawFrameLayerCount(profile)).toBe(layerCount);
    });

    it('accepts one shared and bounded BL/EL raw-frame ownership unit', () => {
        const { baseFrame, enhancementFrame } = createCompoundRawFrames();

        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            enhancementFrame,
            frame: baseFrame,
            generation: 2,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(true);

        const baseOnlyFrames = createCompoundRawFrames();
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            enhancementFrame: null,
            frame: baseOnlyFrames.baseFrame,
            generation: 2,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(true);
    });

    it('rejects non-atomic or mistimed compound raw frames', () => {
        const separateFrames = createCompoundRawFrames();
        separateFrames.enhancementFrame.data = new ArrayBuffer(2_048);
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            enhancementFrame: separateFrames.enhancementFrame,
            frame: separateFrames.baseFrame,
            generation: 2,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(false);

        const mistimedFrames = createCompoundRawFrames();
        mistimedFrames.enhancementFrame.timestampMicroseconds = secondsToMicroseconds(-0.499998);
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            enhancementFrame: mistimedFrames.enhancementFrame,
            frame: mistimedFrames.baseFrame,
            generation: 2,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(false);

        const undeclaredCompoundFrames = createCompoundRawFrames();
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            frame: undeclaredCompoundFrames.baseFrame,
            generation: 2,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(false);
    });

    it.each([ 'I420', 'I420P10', 'I422P10', 'I444P12' ] as const)(
        'accepts a %s BL paired with the I420P10 EL every dual-layer route composes',
        baseFormat => {
            const { baseFrame, enhancementFrame } = createCompoundRawFrames(baseFormat);

            expect(isDecodeWorkerResponse({
                durationMicroseconds: 41_708,
                enhancementFrame,
                frame: baseFrame,
                generation: 2,
                mediaTimeMicroseconds: -500_000,
                outputMode: 'raw-planes',
                type: 'frame'
            })).toBe(true);
        }
    );

    it.each([
        [ 'I420', 'I420' ],
        [ 'I422P10', 'I422P10' ],
        [ 'I420P10', 'I444P12' ]
    ] as const)('rejects a %s BL paired with a %s EL', (baseFormat, enhancementFormat) => {
        const { baseFrame, enhancementFrame } = createCompoundRawFrames(baseFormat, enhancementFormat);

        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            enhancementFrame,
            frame: baseFrame,
            generation: 2,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(false);
    });

    it.each([
        {
            description: 'the AV1 Profile 10 RPU route',
            dolbyVisionProfile: 8,
            rawVideoFrameFormat: 'I420P10',
            videoDecoderBackend: 'native'
        },
        {
            description: 'a single-layer 8-bit range-extension BL',
            dolbyVisionProfile: 8,
            rawVideoFrameFormat: 'I420',
            videoDecoderBackend: 'native'
        },
        {
            description: 'a dual-layer range-extension BL',
            dolbyVisionProfile: 4,
            rawVideoFrameFormat: 'I444P12',
            videoDecoderBackend: 'native'
        },
        {
            description: 'native raw 10-bit SDR',
            dolbyVisionProfile: null,
            rawVideoFrameFormat: 'I420P10',
            videoDecoderBackend: 'native'
        }
    ] as const)('accepts $description at 4K', ({
        dolbyVisionProfile,
        rawVideoFrameFormat,
        videoDecoderBackend
    }) => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 2,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat,
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mkv' },
            videoDecoderBackend,
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        })).toBe(true);
    });

    it('accepts only versioned and bounded encoded Dolby Vision frame metadata', () => {
        const baseFrame = {
            durationMicroseconds: 41_708,
            frame: { close: vi.fn() },
            generation: 1,
            mediaTimeMicroseconds: 500_000,
            outputMode: 'video-frame',
            type: 'frame'
        } as const;
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerDisposition: 'discarded-mel',
                hasEnhancementLayerVCL: true,
                parsedRPUData: [
                    createDolbyVisionAuthorizationRPUVector(7, 'mel')
                ],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerDisposition: 'absent',
                hasEnhancementLayerVCL: false,
                parsedRPUData: [ createPackedRPUData() ],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerDisposition: 'absent',
                hasEnhancementLayerVCL: false,
                parsedRPUData: [],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerDisposition: 'absent',
                hasEnhancementLayerVCL: false,
                parsedRPUData: [ new ArrayBuffer(DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH) ],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerDisposition: 'absent',
                hasEnhancementLayerVCL: false,
                parsedRPUData: Array.from({ length: MAXIMUM_DOLBY_VISION_FRAME_RPU_COUNT + 1 }, createPackedRPUData),
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerDisposition: 'absent',
                hasEnhancementLayerVCL: true,
                parsedRPUData: [ createPackedRPUData() ],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(false);
    });

    it('accepts explicit bounded HDR10+ states and rejects malformed metadata', () => {
        const baseFrame = {
            durationMicroseconds: 41_708,
            frame: { close: vi.fn() },
            generation: 1,
            mediaTimeMicroseconds: 500_000,
            outputMode: 'video-frame',
            type: 'frame'
        } as const;
        const validMetadata = parseHEVCHDR10PlusMetadata(createHDR10PlusHEVCVector('valid'), { kind: 'annex-b' });
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            HDR10PlusMetadata: validMetadata
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            HDR10PlusMetadata: { metadata: null, status: 'conflicting' }
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            HDR10PlusMetadata: {
                metadata: {
                    ...validMetadata.metadata,
                    averageMaxRGBNits: Number.NaN
                },
                status: 'valid'
            }
        })).toBe(false);
        // A frame without valid metadata of its own carries its run's last metadata, but a conflicting or unsupported one ends it
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            HDR10PlusMetadata: { metadata: validMetadata.metadata, status: 'absent' }
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            HDR10PlusMetadata: { metadata: validMetadata.metadata, status: 'malformed' }
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            HDR10PlusMetadata: { metadata: validMetadata.metadata, status: 'conflicting' }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            HDR10PlusMetadata: parseHEVCHDR10PlusMetadata(createHDR10PlusHEVCVector('profile-a'), { kind: 'annex-b' })
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            HDR10PlusMetadata: {
                metadata: {
                    ...validMetadata.metadata,
                    targetedSystemDisplayMaximumLuminanceNits: UNTARGETED_DISPLAY_LUMINANCE_NITS
                },
                status: 'valid'
            }
        })).toBe(false);
    });

    it('requires a raw format that matches the selected output mode', () => {
        const baseRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 2,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mkv' },
            videoDecoderBackend: 'native',
            videoTrackIndex: 0
        } as const;
        const rawVideoFrameFormats = [
            'I420',
            'I420P10',
            'I420P12',
            'I422',
            'I422P10',
            'I422P12',
            'I444',
            'I444P10',
            'I444P12'
        ] as const;
        for (const rawVideoFrameFormat of rawVideoFrameFormats) {
            expect(isDecodeWorkerRequest({
                ...baseRequest,
                rawVideoFrameFormat,
                videoOutputMode: 'raw-planes'
            })).toBe(true);
        }
        expect(isDecodeWorkerRequest({
            ...baseRequest,
            rawVideoFrameFormat: 'NV12',
            videoOutputMode: 'raw-planes'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...baseRequest,
            rawVideoFrameFormat: null,
            videoOutputMode: 'raw-planes'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...baseRequest,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'video-frame'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...baseRequest,
            rawVideoFrameFormat: null,
            videoOutputMode: 'video-frame'
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            ...baseRequest,
            dolbyVisionRPUParserWASMURL: 'https://user:secret@example.test/parser.wasm',
            rawVideoFrameFormat: null,
            videoOutputMode: 'video-frame'
        })).toBe(false);
    });

    it('permits HDR metadata neutralization only for native non-Dolby video frames', () => {
        const nativeFrameRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 3,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mkv' },
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;

        expect(isDecodeWorkerRequest(nativeFrameRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            nativeHDRTransfer: null
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            nativeHDRTransfer: 'sdr'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: false
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            videoDecoderBackend: 'gpu'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            dolbyVisionProfile: 5
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            neutralizeHDRColorMetadata: 'true'
        })).toBe(false);
    });

    it('rejects floating-point timestamps and invalid frame credits', () => {
        const startRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mp4' },
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;

        expect(isDecodeWorkerRequest(startRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...startRequest,
            frameCredits: MAX_DECODED_FRAME_CREDITS + 1
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...startRequest,
            startTimeMicroseconds: 0.5
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            frame: { close: vi.fn() },
            generation: 1,
            mediaTimeMicroseconds: 0.25,
            outputMode: 'video-frame',
            type: 'frame'
        })).toBe(false);
    });

    it('requires exactly the two in-flight raw transfer credits', () => {
        expect(MAX_DECODED_RAW_FRAME_CREDITS).toBe(2);
        const rawStartRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 3,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mkv' },
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        } as const;

        expect(isDecodeWorkerRequest(rawStartRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...rawStartRequest,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS - 1
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...rawStartRequest,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS + 1
        })).toBe(false);

        const rawFrame = createRawFrame();
        rawFrame.planes[0].bytesPerRow = 4;
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            frame: rawFrame,
            generation: 3,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(false);
    });

    it('accepts raw geometry of any size whose copy layout is representable', () => {
        const rawStartRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: ULTRA_HD_8K_CODED_HEIGHT,
            maximumCodedWidth: ULTRA_HD_8K_CODED_WIDTH,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mkv' },
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        } as const;

        expect(isDecodeWorkerRequest(rawStartRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...rawStartRequest,
            maximumCodedHeight: ULTRA_HD_16K_CODED_HEIGHT,
            maximumCodedWidth: ULTRA_HD_16K_CODED_WIDTH
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            ...rawStartRequest,
            maximumCodedHeight: UNREPRESENTABLE_CODED_HEIGHT,
            maximumCodedWidth: UNREPRESENTABLE_CODED_WIDTH
        })).toBe(false);
    });

    it('accepts both 8K Profile 7 layers in one compound transfer', () => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: 7,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: ULTRA_HD_8K_CODED_HEIGHT,
            maximumCodedWidth: ULTRA_HD_8K_CODED_WIDTH,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mkv' },
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        })).toBe(true);
    });

    it('accepts a ready response\'s chroma format only with a known location and subsampling, each or both undeclared', () => {
        const readyResponse = {
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 2_160,
            codedWidth: 3_840,
            displayHeight: 2_160,
            displayWidth: 3_840,
            generation: 1,
            type: 'ready'
        } as const;

        expect(isDecodeWorkerResponse({ ...readyResponse, chromaFormat: DECLARED_CHROMA_FORMAT })).toBe(true);
        expect(isDecodeWorkerResponse({ ...readyResponse, chromaFormat: { ...DECLARED_CHROMA_FORMAT, location: null } })).toBe(true);
        expect(isDecodeWorkerResponse({ ...readyResponse, chromaFormat: { location: null, subsampling: null } })).toBe(true);
        expect(isDecodeWorkerResponse({ ...readyResponse, chromaFormat: { ...DECLARED_CHROMA_FORMAT, location: UNKNOWN_CHROMA_LOCATION } })).toBe(false);
        expect(isDecodeWorkerResponse({ ...readyResponse, chromaFormat: { ...DECLARED_CHROMA_FORMAT, subsampling: UNKNOWN_CHROMA_SUBSAMPLING } })).toBe(false);
        expect(isDecodeWorkerResponse({ ...readyResponse, chromaFormat: { subsampling: DECLARED_CHROMA_FORMAT.subsampling } })).toBe(false);
        expect(isDecodeWorkerResponse({ ...readyResponse, chromaFormat: null })).toBe(false);
    });

    it('rejects malformed generations, dimensions, and failures', () => {
        expect(isDecodeWorkerRequest({ generation: 0, type: 'stop' })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: null,
            codec: 'avc1.640028',
            codedHeight: 1080,
            codedWidth: 0,
            displayHeight: 1080,
            displayWidth: 1920,
            generation: 1,
            type: 'ready'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: Number.NaN,
            codedWidth: 7_680,
            displayHeight: 2_160,
            displayWidth: 3_840,
            generation: 1,
            type: 'ready'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 4_320,
            codedWidth: 7_680,
            displayHeight: 2_160,
            displayWidth: 3_840,
            generation: 1,
            type: 'ready'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            failureKind: 'unknown',
            generation: 1,
            message: 'failed',
            type: 'error'
        })).toBe(false);
    });

    it('accepts a stopped run by its generation', () => {
        expect(isDecodeWorkerResponse({ generation: STOPPED_RUN_GENERATION, type: 'stopped' })).toBe(true);
    });

    it('validates bounded optional static HDR metadata', () => {
        const staticHDRMetadata = {
            masteringDisplayMaximumLuminanceNits: 4_000,
            masteringDisplayMinimumLuminanceNits: 0.005,
            maximumContentLightLevelNits: 500,
            maximumFrameAverageLightLevelNits: 200
        };
        const readyResponse = {
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 2_160,
            codedWidth: 3_840,
            displayHeight: 2_160,
            displayWidth: 3_840,
            generation: 1,
            staticHDRMetadataScan: {
                accessUnitCount: 16,
                firstMetadataAccessUnitIndex: 1,
                metadata: staticHDRMetadata,
                status: 'valid'
            },
            type: 'ready'
        };
        expect(isDecodeWorkerResponse(readyResponse)).toBe(true);
        expect(isDecodeWorkerResponse({
            ...readyResponse,
            staticHDRMetadataScan: {
                ...readyResponse.staticHDRMetadataScan,
                metadata: {
                    ...staticHDRMetadata,
                    masteringDisplayMaximumLuminanceNits: 10_001
                }
            }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...readyResponse,
            staticHDRMetadataScan: {
                accessUnitCount: 16,
                firstMetadataAccessUnitIndex: null,
                metadata: staticHDRMetadata,
                status: 'malformed'
            }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...readyResponse,
            staticHDRMetadataScan: {
                accessUnitCount: 16,
                firstMetadataAccessUnitIndex: null,
                metadata: null,
                status: 'conflicting'
            }
        })).toBe(true);
    });

    it('validates bounded PCM progress and independent audio credits', () => {
        const decodedAudioStartRequest = {
            audioDownmixSettings: {
                centerLevel: 0.4,
                outputGain: 0.6,
                surroundLevel: 0.5,
                version: 1
            },
            audioSampleCredits: MAX_DECODED_AUDIO_SAMPLE_CREDITS,
            audioTrackIndex: 1,
            decodedAudioOutputChannelCount: 8,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: 1,
            generation: 2,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mkv' },
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;
        expect(isDecodeWorkerRequest(decodedAudioStartRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...decodedAudioStartRequest,
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            ...decodedAudioStartRequest,
            audioDownmixAlgorithm: 'unsupported'
        })).toBe(false);
        const nativeAudioStartRequest = {
            ...decodedAudioStartRequest,
            audioDownmixSettings: undefined,
            audioOutputMode: 'native-media',
            decodedAudioOutputChannelCount: undefined
        } as const;
        expect(isDecodeWorkerRequest(nativeAudioStartRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...nativeAudioStartRequest,
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...decodedAudioStartRequest,
            decodedAudioOutputChannelCount: 7
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...decodedAudioStartRequest,
            audioDownmixSettings: {
                ...decodedAudioStartRequest.audioDownmixSettings,
                outputGain: 10.01
            }
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...decodedAudioStartRequest,
            audioDownmixSettings: {
                ...decodedAudioStartRequest.audioDownmixSettings,
                version: 2
            }
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...decodedAudioStartRequest,
            audioOutputMode: 'native-media',
            decodedAudioOutputChannelCount: undefined
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 2,
            generation: 2,
            type: 'pull-audio'
        })).toBe(true);
        const progressResponse = {
            audioEpoch: 0,
            durationMicroseconds: AUDIO_PROGRESS_DURATION_MICROSECONDS,
            frameCount: AUDIO_PROGRESS_FRAME_COUNT,
            generation: 2,
            mediaTimeMicroseconds: -AUDIO_PROGRESS_DURATION_MICROSECONDS,
            sampleRate: AUDIO_OUTPUT_SAMPLE_RATE,
            type: 'audio-progress'
        } as const;
        expect(isDecodeWorkerResponse(progressResponse)).toBe(true);
        // The PCM itself never reaches the page
        expect(isDecodeWorkerResponse({ ...progressResponse, type: 'audio' })).toBe(false);

        const videoOnlyStartRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: 1,
            generation: 2,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mkv' },
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;
        expect(isDecodeWorkerRequest(videoOnlyStartRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...videoOnlyStartRequest,
            audioTrackIndex: 1
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            ...videoOnlyStartRequest,
            audioSampleCredits: 1
        })).toBe(false);
        expect(isDecodeWorkerResponse({ ...progressResponse, frameCount: 0 })).toBe(false);
        expect(isDecodeWorkerResponse({ ...progressResponse, frameCount: MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE + 1 })).toBe(false);
        expect(isDecodeWorkerResponse({ ...progressResponse, durationMicroseconds: -1 })).toBe(false);
        expect(isDecodeWorkerResponse({ ...progressResponse, sampleRate: ZERO_SAMPLE_RATE })).toBe(false);
        expect(isDecodeWorkerResponse({ ...progressResponse, sampleRate: FRACTIONAL_SAMPLE_RATE })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: {
                channelCount: 2,
                codec: 'opus',
                sampleRate: ZERO_SAMPLE_RATE
            },
            codec: 'avc1.640028',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 2,
            type: 'ready'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: {
                channelCount: 2,
                codec: 'opus',
                sampleRate: 48_000,
                sourceSampleRate: NEGATIVE_SAMPLE_RATE
            },
            codec: 'avc1.640028',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 2,
            type: 'ready'
        })).toBe(false);
    });

    it('validates exact native-media routes and transferred fMP4 segments', () => {
        const nativeStartRequest = {
            audioOutputMode: 'native-media',
            audioSampleCredits: 2,
            audioTrackIndex: 1,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: 1,
            generation: 4,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: 'http://localhost/video.mkv' },
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        };
        expect(isDecodeWorkerRequest(nativeStartRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...nativeStartRequest,
            decodedAudioOutputChannelCount: 6
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeStartRequest,
            audioTrackIndex: null
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeStartRequest,
            audioOutputMode: 'unknown'
        })).toBe(false);

        expect(isDecodeWorkerResponse({
            audio: {
                channelCount: 6,
                codec: 'ec-3',
                mimeType: 'audio/mp4; codecs="ec-3"',
                outputMode: 'native-media',
                sampleRate: 48_000
            },
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 4,
            type: 'ready'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            audio: {
                channelCount: 8,
                codec: 'ec-3',
                mimeType: 'audio/mp4; codecs="ec-3"',
                outputMode: 'native-media',
                sampleRate: 48_000
            },
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 4,
            type: 'ready'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            data: new ArrayBuffer(128),
            generation: 4,
            type: 'native-audio-init'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            data: new ArrayBuffer(128),
            endTimeMicroseconds: 1_500_000,
            generation: 4,
            startTimeMicroseconds: 1_000_000,
            type: 'native-audio-media'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            data: new ArrayBuffer(MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH + 1),
            endTimeMicroseconds: 1_500_000,
            generation: 4,
            startTimeMicroseconds: 1_000_000,
            type: 'native-audio-media'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            data: new ArrayBuffer(128),
            endTimeMicroseconds: 3_500_000,
            generation: 4,
            startTimeMicroseconds: 1_000_000,
            type: 'native-audio-media'
        })).toBe(false);
    });

    it('accepts video resync requests only with integer microsecond targets', () => {
        const resyncRequest = {
            generation: 3,
            targetTimeMicroseconds: 2_500_000,
            type: 'resync-video',
            videoEpoch: 1
        } as const;
        const invalidTargetTimes: readonly unknown[] = [
            0.5,
            Number.NaN,
            '2500000',
            null,
            undefined
        ];

        expect(isDecodeWorkerRequest(resyncRequest)).toBe(true);
        // Targets follow the signed start-time rule for negative leading timestamps
        expect(isDecodeWorkerRequest({
            ...resyncRequest,
            targetTimeMicroseconds: -500_000
        })).toBe(true);
        for (const invalidTargetTime of invalidTargetTimes) {
            expect(isDecodeWorkerRequest({
                ...resyncRequest,
                targetTimeMicroseconds: invalidTargetTime
            })).toBe(false);
        }
    });

    it('requires a live generation and an advanced epoch for video control requests', () => {
        const controlRequests = [
            {
                generation: 3,
                targetTimeMicroseconds: 2_500_000,
                type: 'resync-video'
            },
            {
                generation: 3,
                type: 'suspend-video'
            }
        ] as const;
        const validVideoEpochs: readonly unknown[] = [ 1, Number.MAX_SAFE_INTEGER ];
        const invalidVideoEpochs: readonly unknown[] = [
            0,
            -1,
            1.5,
            '1',
            null,
            undefined,
            Number.MAX_SAFE_INTEGER + 1
        ];

        for (const controlRequest of controlRequests) {
            expect(isDecodeWorkerRequest({
                ...controlRequest,
                generation: 0,
                videoEpoch: 1
            })).toBe(false);
            for (const validVideoEpoch of validVideoEpochs) {
                expect(isDecodeWorkerRequest({
                    ...controlRequest,
                    videoEpoch: validVideoEpoch
                })).toBe(true);
            }
            for (const invalidVideoEpoch of invalidVideoEpochs) {
                expect(isDecodeWorkerRequest({
                    ...controlRequest,
                    videoEpoch: invalidVideoEpoch
                })).toBe(false);
            }
        }
    });

    it('treats an omitted frame epoch as the initial attempt and rejects malformed epochs', () => {
        const videoFrameResponse = {
            durationMicroseconds: 41_708,
            frame: { close: vi.fn() },
            generation: 1,
            mediaTimeMicroseconds: 500_000,
            outputMode: 'video-frame',
            type: 'frame'
        } as const;
        const rawFrameResponse = {
            durationMicroseconds: 41_708,
            frame: createRawFrame(),
            generation: 1,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        } as const;
        const validVideoEpochs: readonly unknown[] = [ 0, 4, Number.MAX_SAFE_INTEGER ];
        const invalidVideoEpochs: readonly unknown[] = [ -1, 0.5, '1', null, Number.NaN ];

        for (const frameResponse of [ videoFrameResponse, rawFrameResponse ]) {
            expect(isDecodeWorkerResponse(frameResponse)).toBe(true);
            for (const validVideoEpoch of validVideoEpochs) {
                expect(isDecodeWorkerResponse({
                    ...frameResponse,
                    videoEpoch: validVideoEpoch
                })).toBe(true);
            }
            for (const invalidVideoEpoch of invalidVideoEpochs) {
                expect(isDecodeWorkerResponse({
                    ...frameResponse,
                    videoEpoch: invalidVideoEpoch
                })).toBe(false);
            }
        }
    });

    it('accepts a frame\'s fields only as a known scan and a repeat first field flag', () => {
        const rawFrame = createRawFrame();
        const videoFrameResponse = {
            durationMicroseconds: rawFrame.durationMicroseconds,
            frame: { close: vi.fn() },
            generation: 1,
            mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            outputMode: 'video-frame',
            type: 'frame'
        } as const;
        const rawFrameResponse = {
            durationMicroseconds: rawFrame.durationMicroseconds,
            frame: rawFrame,
            generation: 1,
            mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            outputMode: 'raw-planes',
            type: 'frame'
        } as const;

        for (const frameResponse of [ videoFrameResponse, rawFrameResponse ]) {
            expect(isDecodeWorkerResponse({ ...frameResponse, fields: TOP_FIRST_FIELDS })).toBe(true);
            expect(isDecodeWorkerResponse({ ...frameResponse, fields: SOFT_TELECINE_FIELDS })).toBe(true);
            for (const fields of MALFORMED_FIELDS) {
                expect(isDecodeWorkerResponse({ ...frameResponse, fields })).toBe(false);
            }
        }
    });

    it('accepts only decoder reclamation interruptions with a valid video epoch', () => {
        const interruptedResponse = {
            generation: 2,
            reason: 'decoder-reclaimed',
            type: 'video-interrupted',
            videoEpoch: 0
        } as const;
        const invalidReasons: readonly unknown[] = [
            'decode-failed',
            'suspended',
            null,
            undefined
        ];
        const invalidVideoEpochs: readonly unknown[] = [ -1, 1.5, '0', null, undefined ];

        expect(isDecodeWorkerResponse(interruptedResponse)).toBe(true);
        expect(isDecodeWorkerResponse({
            ...interruptedResponse,
            videoEpoch: 3
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...interruptedResponse,
            generation: 0
        })).toBe(false);
        for (const invalidReason of invalidReasons) {
            expect(isDecodeWorkerResponse({
                ...interruptedResponse,
                reason: invalidReason
            })).toBe(false);
        }
        for (const invalidVideoEpoch of invalidVideoEpochs) {
            expect(isDecodeWorkerResponse({
                ...interruptedResponse,
                videoEpoch: invalidVideoEpoch
            })).toBe(false);
        }
    });

    it('accepts a video track end only with a valid video epoch', () => {
        const videoEndedResponse = {
            generation: 2,
            type: 'video-ended',
            videoEpoch: 0
        } as const;
        const invalidVideoEpochs: readonly unknown[] = [ -1, 1.5, '0', null, undefined ];

        expect(isDecodeWorkerResponse(videoEndedResponse)).toBe(true);
        expect(isDecodeWorkerResponse({
            ...videoEndedResponse,
            videoEpoch: 3
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...videoEndedResponse,
            generation: 0
        })).toBe(false);
        for (const invalidVideoEpoch of invalidVideoEpochs) {
            expect(isDecodeWorkerResponse({
                ...videoEndedResponse,
                videoEpoch: invalidVideoEpoch
            })).toBe(false);
        }
    });

    it('accepts an audio track end only with a valid audio epoch', () => {
        const audioEndedResponse = {
            audioEpoch: 0,
            generation: 2,
            type: 'audio-ended'
        } as const;
        const invalidAudioEpochs: readonly unknown[] = [ -1, 1.5, '0', null, undefined ];

        expect(isDecodeWorkerResponse(audioEndedResponse)).toBe(true);
        expect(isDecodeWorkerResponse({
            ...audioEndedResponse,
            audioEpoch: 4
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...audioEndedResponse,
            generation: 0
        })).toBe(false);
        for (const invalidAudioEpoch of invalidAudioEpochs) {
            expect(isDecodeWorkerResponse({
                ...audioEndedResponse,
                audioEpoch: invalidAudioEpoch
            })).toBe(false);
        }
    });

    it('accepts a decoded audio source format only with a valid epoch, channel count, and rate', () => {
        const sourceFormatResponse = {
            audioEpoch: 0,
            channelCount: 8,
            generation: 2,
            sampleRate: 48_000,
            type: 'audio-source-format'
        } as const;
        const invalidAudioEpochs: readonly unknown[] = [ -1, 1.5, '0', null, undefined ];
        const invalidChannelCounts: readonly unknown[] = [
            0,
            -1,
            2.5,
            '2',
            null,
            undefined,
            MAX_DECODED_AUDIO_CHANNELS + 1
        ];
        const invalidSampleRates: readonly unknown[] = [
            ZERO_SAMPLE_RATE,
            NEGATIVE_SAMPLE_RATE,
            FRACTIONAL_SAMPLE_RATE,
            '48000',
            null,
            undefined
        ];

        expect(isDecodeWorkerResponse(sourceFormatResponse)).toBe(true);
        expect(isDecodeWorkerResponse({
            ...sourceFormatResponse,
            audioEpoch: 3,
            channelCount: 1,
            sampleRate: 22_050
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...sourceFormatResponse,
            channelCount: MAX_DECODED_AUDIO_CHANNELS
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...sourceFormatResponse,
            generation: 0
        })).toBe(false);
        for (const invalidAudioEpoch of invalidAudioEpochs) {
            expect(isDecodeWorkerResponse({
                ...sourceFormatResponse,
                audioEpoch: invalidAudioEpoch
            })).toBe(false);
        }
        for (const invalidChannelCount of invalidChannelCounts) {
            expect(isDecodeWorkerResponse({
                ...sourceFormatResponse,
                channelCount: invalidChannelCount
            })).toBe(false);
        }
        for (const invalidSampleRate of invalidSampleRates) {
            expect(isDecodeWorkerResponse({
                ...sourceFormatResponse,
                sampleRate: invalidSampleRate
            })).toBe(false);
        }
    });

    it('accepts audio resync requests only with an advanced epoch and a decoded output layout', () => {
        const resyncRequest = {
            audioEpoch: 1,
            audioOutput: createAudioOutputAttachment(6),
            decodedAudioOutputChannelCount: 6,
            generation: 3,
            targetTimeMicroseconds: 2_500_000,
            type: 'resync-audio'
        } as const;
        const validAudioEpochs: readonly unknown[] = [ 1, 2, Number.MAX_SAFE_INTEGER ];
        // Epoch zero names the initial attempt, which a resync always replaces
        const invalidAudioEpochs: readonly unknown[] = [
            0,
            -1,
            1.5,
            '1',
            null,
            undefined,
            Number.MAX_SAFE_INTEGER + 1
        ];
        const validChannelCounts: readonly number[] = [ 2, 6, 8 ];
        const invalidChannelCounts: readonly unknown[] = [
            0,
            1,
            4,
            7,
            32,
            6.5,
            '6',
            null,
            undefined
        ];

        expect(isDecodeWorkerRequest(resyncRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...resyncRequest,
            generation: 0
        })).toBe(false);
        for (const validAudioEpoch of validAudioEpochs) {
            expect(isDecodeWorkerRequest({
                ...resyncRequest,
                audioEpoch: validAudioEpoch
            })).toBe(true);
        }
        for (const invalidAudioEpoch of invalidAudioEpochs) {
            expect(isDecodeWorkerRequest({
                ...resyncRequest,
                audioEpoch: invalidAudioEpoch
            })).toBe(false);
        }
        for (const validChannelCount of validChannelCounts) {
            expect(isDecodeWorkerRequest({
                ...resyncRequest,
                audioOutput: { ...resyncRequest.audioOutput, channelCount: validChannelCount },
                decodedAudioOutputChannelCount: validChannelCount
            })).toBe(true);
        }
        for (const invalidChannelCount of invalidChannelCounts) {
            expect(isDecodeWorkerRequest({
                ...resyncRequest,
                audioOutput: { ...resyncRequest.audioOutput, channelCount: invalidChannelCount },
                decodedAudioOutputChannelCount: invalidChannelCount
            })).toBe(false);
        }
        // The new worklet must have the layout the resync asks for
        expect(isDecodeWorkerRequest({
            ...resyncRequest,
            decodedAudioOutputChannelCount: 8
        })).toBe(false);
    });

    it('accepts a worklet channel only with a port, a credit window, and the bounds of a decoded output', () => {
        const attachRequest = {
            audioEpoch: 0,
            audioOutput: createAudioOutputAttachment(2),
            generation: 3,
            type: 'attach-audio-output'
        } as const;
        const invalidAudioOutputs: readonly unknown[] = [
            { ...attachRequest.audioOutput, port: null },
            { ...attachRequest.audioOutput, port: { postMessage: vi.fn() } },
            { ...attachRequest.audioOutput, audioSampleCredits: 0 },
            { ...attachRequest.audioOutput, audioSampleCredits: MAX_DECODED_AUDIO_SAMPLE_CREDITS + 1 },
            { ...attachRequest.audioOutput, channelCount: 1 },
            { ...attachRequest.audioOutput, maximumBufferedFrameCount: 0 },
            { ...attachRequest.audioOutput, sampleRate: FRACTIONAL_SAMPLE_RATE },
            { ...attachRequest.audioOutput, workletGeneration: 0 },
            null
        ];

        expect(isDecodeWorkerRequest(attachRequest)).toBe(true);
        expect(isDecodeWorkerRequest({ ...attachRequest, audioEpoch: 3 })).toBe(true);
        expect(isDecodeWorkerRequest({ ...attachRequest, audioEpoch: -1 })).toBe(false);
        expect(isDecodeWorkerRequest({ ...attachRequest, audioEpoch: undefined })).toBe(false);
        for (const invalidAudioOutput of invalidAudioOutputs) {
            expect(isDecodeWorkerRequest({ ...attachRequest, audioOutput: invalidAudioOutput })).toBe(false);
        }
    });

    it('bounds the replacement audio credit window and the audio resync target', () => {
        const resyncRequest = {
            audioEpoch: 1,
            audioOutput: createAudioOutputAttachment(8, 3),
            decodedAudioOutputChannelCount: 8,
            generation: 3,
            targetTimeMicroseconds: 2_500_000,
            type: 'resync-audio'
        } as const;
        const validAudioSampleCredits: readonly unknown[] = [ 1, MAX_DECODED_AUDIO_SAMPLE_CREDITS ];
        // The replacement window must admit at least one sample, unlike a start without audio
        const invalidAudioSampleCredits: readonly unknown[] = [
            0,
            -1,
            MAX_DECODED_AUDIO_SAMPLE_CREDITS + 1,
            1.5,
            '2',
            null,
            undefined
        ];
        const invalidTargetTimes: readonly unknown[] = [
            0.5,
            Number.NaN,
            '2500000',
            null,
            undefined
        ];

        for (const validAudioSampleCredit of validAudioSampleCredits) {
            expect(isDecodeWorkerRequest({
                ...resyncRequest,
                audioOutput: { ...resyncRequest.audioOutput, audioSampleCredits: validAudioSampleCredit }
            })).toBe(true);
        }
        for (const invalidAudioSampleCredit of invalidAudioSampleCredits) {
            expect(isDecodeWorkerRequest({
                ...resyncRequest,
                audioOutput: { ...resyncRequest.audioOutput, audioSampleCredits: invalidAudioSampleCredit }
            })).toBe(false);
        }
        // The window comes with the new worklet's channel, never without one
        expect(isDecodeWorkerRequest({ ...resyncRequest, audioOutput: undefined })).toBe(false);
        // Targets follow the signed start-time rule for negative leading timestamps
        expect(isDecodeWorkerRequest({
            ...resyncRequest,
            targetTimeMicroseconds: -500_000
        })).toBe(true);
        for (const invalidTargetTime of invalidTargetTimes) {
            expect(isDecodeWorkerRequest({
                ...resyncRequest,
                targetTimeMicroseconds: invalidTargetTime
            })).toBe(false);
        }
    });

    it('accepts an audio resync downmix selection only when it is valid', () => {
        const resyncRequest = {
            audioEpoch: 2,
            audioOutput: createAudioOutputAttachment(2, 4),
            decodedAudioOutputChannelCount: 2,
            generation: 3,
            targetTimeMicroseconds: 2_500_000,
            type: 'resync-audio'
        } as const;
        const audioDownmixSettings = {
            centerLevel: 0.75,
            outputGain: 1.25,
            surroundLevel: 0.5,
            version: 1
        } as const;
        const invalidAudioDownmixAlgorithms: readonly unknown[] = [ 'unsupported', '', null, 1 ];
        const invalidAudioDownmixSettings: readonly unknown[] = [
            { ...audioDownmixSettings, outputGain: 10.01 },
            { ...audioDownmixSettings, centerLevel: -0.01 },
            { ...audioDownmixSettings, surroundLevel: Number.NaN },
            { ...audioDownmixSettings, version: 2 },
            null,
            'unity'
        ];

        for (const audioDownmixAlgorithm of Object.values(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS)) {
            expect(isDecodeWorkerRequest({
                ...resyncRequest,
                audioDownmixAlgorithm
            })).toBe(true);
        }
        expect(isDecodeWorkerRequest({
            ...resyncRequest,
            audioDownmixSettings
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            ...resyncRequest,
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            audioDownmixSettings
        })).toBe(true);
        for (const invalidAudioDownmixAlgorithm of invalidAudioDownmixAlgorithms) {
            expect(isDecodeWorkerRequest({
                ...resyncRequest,
                audioDownmixAlgorithm: invalidAudioDownmixAlgorithm
            })).toBe(false);
        }
        for (const invalidAudioDownmixSetting of invalidAudioDownmixSettings) {
            expect(isDecodeWorkerRequest({
                ...resyncRequest,
                audioDownmixSettings: invalidAudioDownmixSetting
            })).toBe(false);
        }
    });

    it('treats an omitted audio pull epoch as the initial attempt and rejects malformed epochs', () => {
        const pullRequest = {
            audioSampleCredits: 2,
            generation: 2,
            type: 'pull-audio'
        } as const;
        const validAudioEpochs: readonly unknown[] = [ 0, 3, Number.MAX_SAFE_INTEGER ];
        const invalidAudioEpochs: readonly unknown[] = [
            -1,
            0.5,
            '1',
            null,
            Number.NaN,
            Number.MAX_SAFE_INTEGER + 1
        ];

        expect(isDecodeWorkerRequest(pullRequest)).toBe(true);
        for (const validAudioEpoch of validAudioEpochs) {
            expect(isDecodeWorkerRequest({
                ...pullRequest,
                audioEpoch: validAudioEpoch
            })).toBe(true);
        }
        for (const invalidAudioEpoch of invalidAudioEpochs) {
            expect(isDecodeWorkerRequest({
                ...pullRequest,
                audioEpoch: invalidAudioEpoch
            })).toBe(false);
        }
        // An epoch tag does not relax the nonzero credit bound
        expect(isDecodeWorkerRequest({
            ...pullRequest,
            audioEpoch: 1,
            audioSampleCredits: 0
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...pullRequest,
            audioEpoch: 1,
            audioSampleCredits: MAX_DECODED_AUDIO_SAMPLE_CREDITS + 1
        })).toBe(false);
    });

    it('requires the audio epoch of every chunk progress', () => {
        const progressResponse = {
            audioEpoch: 0,
            durationMicroseconds: AUDIO_PROGRESS_DURATION_MICROSECONDS,
            frameCount: AUDIO_PROGRESS_FRAME_COUNT,
            generation: 2,
            mediaTimeMicroseconds: 5_000_000,
            sampleRate: AUDIO_OUTPUT_SAMPLE_RATE,
            type: 'audio-progress'
        } as const;
        const validAudioEpochs: readonly unknown[] = [ 0, 4, Number.MAX_SAFE_INTEGER ];
        const invalidAudioEpochs: readonly unknown[] = [ -1, 0.5, '1', null, undefined, Number.NaN ];

        for (const validAudioEpoch of validAudioEpochs) {
            expect(isDecodeWorkerResponse({
                ...progressResponse,
                audioEpoch: validAudioEpoch
            })).toBe(true);
        }
        for (const invalidAudioEpoch of invalidAudioEpochs) {
            expect(isDecodeWorkerResponse({
                ...progressResponse,
                audioEpoch: invalidAudioEpoch
            })).toBe(false);
        }
    });

    describe('frame-pool route', () => {
        const framePoolStartRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_GPU_DECODE_PACKET_CREDITS,
            generation: GPU_VIDEO_GENERATION,
            gpuVideoCodec: GPU_VIDEO_CODEC,
            maximumCodedHeight: GPU_POOL_CODED_HEIGHT,
            maximumCodedWidth: GPU_POOL_CODED_WIDTH,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: 0,
            type: 'start',
            source: { kind: 'url', url: MEDIA_URL },
            videoDecoderBackend: 'gpu',
            videoOutputMode: 'frame-pool',
            videoTrackIndex: 0
        } as const;
        const packetResponse = {
            data: new ArrayBuffer(GPU_PACKET_BYTE_LENGTH),
            durationMicroseconds: GPU_PACKET_DURATION_MICROSECONDS,
            generation: GPU_VIDEO_GENERATION,
            keyframe: true,
            timestampMicroseconds: GPU_PACKET_TIMESTAMP_MICROSECONDS,
            type: 'packet',
            videoEpoch: 0
        } as const;

        it('grants packets, not frames, as its video credits', () => {
            expect(getVideoCreditLimit('frame-pool')).toBe(MAX_GPU_DECODE_PACKET_CREDITS);
            expect(getVideoCreditLimit('raw-planes')).toBe(MAX_DECODED_RAW_FRAME_CREDITS);
            expect(getVideoCreditLimit('video-frame')).toBe(MAX_DECODED_FRAME_CREDITS);
            expect(isDecodeWorkerRequest({ frameCredits: MAX_GPU_DECODE_PACKET_CREDITS, generation: GPU_VIDEO_GENERATION, type: 'pull' })).toBe(true);
            expect(isDecodeWorkerRequest({ frameCredits: MAX_GPU_DECODE_PACKET_CREDITS + 1, generation: GPU_VIDEO_GENERATION, type: 'pull' })).toBe(false);
        });

        it('accepts a start with the GPU backend, the codec its decoder takes, a planar format, and the whole packet window', () => {
            expect(isDecodeWorkerRequest(framePoolStartRequest)).toBe(true);
            expect(isDecodeWorkerRequest({ ...framePoolStartRequest, gpuVideoCodec: undefined })).toBe(false);
            expect(isDecodeWorkerRequest({ ...framePoolStartRequest, gpuVideoCodec: '' })).toBe(false);
            expect(isDecodeWorkerRequest({ ...framePoolStartRequest, videoDecoderBackend: 'native' })).toBe(false);
            expect(isDecodeWorkerRequest({ ...framePoolStartRequest, rawVideoFrameFormat: null })).toBe(false);
            expect(isDecodeWorkerRequest({ ...framePoolStartRequest, rawVideoFrameFormat: 'NV12' })).toBe(false);
            expect(isDecodeWorkerRequest({ ...framePoolStartRequest, frameCredits: MAX_GPU_DECODE_PACKET_CREDITS - 1 })).toBe(false);
        });

        it('rejects a start that asks the frame pool for Dolby Vision or native color handling', () => {
            expect(isDecodeWorkerRequest({ ...framePoolStartRequest, dolbyVisionProfile: 8 })).toBe(false);
            expect(isDecodeWorkerRequest({ ...framePoolStartRequest, nativeHDRTransfer: 'pq', neutralizeHDRColorMetadata: true })).toBe(false);
        });

        it('keeps the GPU backend and its codec off every other route', () => {
            const rawPlaneStartRequest = {
                ...framePoolStartRequest,
                frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
                gpuVideoCodec: undefined,
                videoDecoderBackend: 'native',
                videoOutputMode: 'raw-planes'
            } as const;

            expect(isDecodeWorkerRequest(rawPlaneStartRequest)).toBe(true);
            expect(isDecodeWorkerRequest({ ...rawPlaneStartRequest, gpuVideoCodec: GPU_VIDEO_CODEC })).toBe(false);
            expect(isDecodeWorkerRequest({ ...rawPlaneStartRequest, videoDecoderBackend: 'gpu' })).toBe(false);
            expect(isDecodeWorkerRequest({ ...rawPlaneStartRequest, gpuVideoParser: GPU_VIDEO_PARSER })).toBe(false);
        });

        it('accepts a decoder package\'s parser: its compiled module, bounded memory, and error names, with the package\'s id and content hash', () => {
            expect(isDecodeWorkerRequest({ ...framePoolStartRequest, gpuVideoParser: GPU_VIDEO_PARSER })).toBe(true);
            expect(isDecodeWorkerRequest({
                ...framePoolStartRequest,
                gpuVideoParser: { ...GPU_VIDEO_PARSER, parser: { ...GPU_VIDEO_PARSER.parser, memory: null } }
            })).toBe(true);
        });

        it.each([
            { gpuVideoParser: GPU_VIDEO_PARSER_NAME, subject: 'a codec name' },
            { gpuVideoParser: null, subject: 'no parser' },
            { gpuVideoParser: { parser: GPU_VIDEO_PARSER.parser }, subject: 'a parser without its package version' },
            {
                gpuVideoParser: { ...GPU_VIDEO_PARSER, packageVersion: { id: GPU_VIDEO_PARSER.packageVersion.id } },
                subject: 'a package version without its content hash'
            },
            { gpuVideoParser: { ...GPU_VIDEO_PARSER, parser: { ...GPU_VIDEO_PARSER.parser, module: GPU_PARSER_MODULE_BINARY } }, subject: 'module bytes' },
            {
                gpuVideoParser: { ...GPU_VIDEO_PARSER, parser: { ...GPU_VIDEO_PARSER.parser, errorNames: { 1: 'configuration' } } },
                subject: 'error names as a plain object'
            },
            {
                gpuVideoParser: {
                    ...GPU_VIDEO_PARSER,
                    parser: { ...GPU_VIDEO_PARSER.parser, memory: { initialPages: STUB_MODULE_MEMORY_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES + 1 } }
                },
                subject: 'a memory past the engine\'s bound'
            },
            { gpuVideoParser: { ...GPU_VIDEO_PARSER, parser: { ...GPU_VIDEO_PARSER.parser, repeatDirectiveCount: undefined } }, subject: 'a parser without its header\'s repeat count' }
        ])('rejects $subject as the decoder\'s parser', ({ gpuVideoParser }) => {
            expect(isDecodeWorkerRequest({ ...framePoolStartRequest, gpuVideoParser })).toBe(false);
        });

        it('accepts a bounded compressed packet with integer-microsecond times', () => {
            expect(isDecodeWorkerResponse(packetResponse)).toBe(true);
            // An omitted epoch is the initial attempt
            expect(isDecodeWorkerResponse({ ...packetResponse, videoEpoch: undefined })).toBe(true);
            expect(isDecodeWorkerResponse({ ...packetResponse, data: new ArrayBuffer(0) })).toBe(false);
            expect(isDecodeWorkerResponse({ ...packetResponse, data: new ArrayBuffer(GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH + 1) })).toBe(false);
            expect(isDecodeWorkerResponse({ ...packetResponse, data: new Uint8Array(GPU_PACKET_BYTE_LENGTH) })).toBe(false);
            expect(isDecodeWorkerResponse({ ...packetResponse, timestampMicroseconds: 0.5 })).toBe(false);
            expect(isDecodeWorkerResponse({ ...packetResponse, durationMicroseconds: -1 })).toBe(false);
            expect(isDecodeWorkerResponse({ ...packetResponse, keyframe: 'true' })).toBe(false);
            expect(isDecodeWorkerResponse({ ...packetResponse, videoEpoch: -1 })).toBe(false);
        });

        it('accepts a packet\'s fields only when well formed, and none on a held packet, which carries no picture', () => {
            const heldPacketResponse = { ...packetResponse, data: new ArrayBuffer(0), hold: true } as const;

            expect(isDecodeWorkerResponse({ ...packetResponse, fields: TOP_FIRST_FIELDS })).toBe(true);
            expect(isDecodeWorkerResponse({ ...packetResponse, fields: SOFT_TELECINE_FIELDS })).toBe(true);
            for (const fields of MALFORMED_FIELDS) {
                expect(isDecodeWorkerResponse({ ...packetResponse, fields })).toBe(false);
            }
            expect(isDecodeWorkerResponse(heldPacketResponse)).toBe(true);
            expect(isDecodeWorkerResponse({ ...heldPacketResponse, fields: TOP_FIRST_FIELDS })).toBe(false);
        });

        it('accepts a packet\'s output events only as at most the bound of words', () => {
            expect(isDecodeWorkerResponse({ ...packetResponse, outputEvents: GPU_PACKET_OUTPUT_EVENTS })).toBe(true);
            expect(isDecodeWorkerResponse({ ...packetResponse, outputEvents: new Uint32Array(0) })).toBe(true);
            expect(isDecodeWorkerResponse({ ...packetResponse, outputEvents: new Uint32Array(MAXIMUM_GPU_DECODE_OUTPUT_EVENTS) })).toBe(true);
            expect(isDecodeWorkerResponse({ ...packetResponse, outputEvents: new Uint32Array(MAXIMUM_GPU_DECODE_OUTPUT_EVENTS + 1) })).toBe(false);
            expect(isDecodeWorkerResponse({ ...packetResponse, outputEvents: [ ...GPU_PACKET_OUTPUT_EVENTS ] })).toBe(false);
            expect(isDecodeWorkerResponse({ ...packetResponse, outputEvents: null })).toBe(false);
        });

        it('accepts a picture\'s own visible size as positive integers and its repeat counts as u32 values', () => {
            expect(isDecodeWorkerResponse({ ...packetResponse, repeatCounts: GPU_PICTURE_REPEAT_COUNTS, visibleSize: GPU_PICTURE_SIZE })).toBe(true);
            expect(isDecodeWorkerResponse({ ...packetResponse, repeatCounts: [] })).toBe(true);
            expect(isDecodeWorkerResponse({ ...packetResponse, visibleSize: { ...GPU_PICTURE_SIZE, width: 0 } })).toBe(false);
            expect(isDecodeWorkerResponse({ ...packetResponse, visibleSize: { ...GPU_PICTURE_SIZE, height: 0.5 } })).toBe(false);
            expect(isDecodeWorkerResponse({ ...packetResponse, visibleSize: null })).toBe(false);
            expect(isDecodeWorkerResponse({ ...packetResponse, repeatCounts: [ -1 ] })).toBe(false);
            expect(isDecodeWorkerResponse({ ...packetResponse, repeatCounts: [ 0x1_0000_0000 ] })).toBe(false);
            expect(isDecodeWorkerResponse({ ...packetResponse, repeatCounts: Uint32Array.of(1) })).toBe(false);
        });

        it('accepts a video end with the output events of its last packets, which had no picture to carry them, within the bound', () => {
            const videoEndedResponse = { generation: GPU_VIDEO_GENERATION, type: 'video-ended', videoEpoch: 0 } as const;

            expect(isDecodeWorkerResponse(videoEndedResponse)).toBe(true);
            expect(isDecodeWorkerResponse({ ...videoEndedResponse, outputEvents: GPU_PACKET_OUTPUT_EVENTS })).toBe(true);
            expect(isDecodeWorkerResponse({ ...videoEndedResponse, outputEvents: new Uint32Array(MAXIMUM_GPU_DECODE_OUTPUT_EVENTS + 1) })).toBe(false);
            expect(isDecodeWorkerResponse({ ...videoEndedResponse, outputEvents: [ ...GPU_PACKET_OUTPUT_EVENTS ] })).toBe(false);
        });

        it('accepts a packet\'s HDR10+ state only when it is well formed', () => {
            const HDR10PlusMetadata = parseHEVCHDR10PlusMetadata(createHDR10PlusHEVCVector('valid'), { kind: 'annex-b' });

            expect(isDecodeWorkerResponse({ ...packetResponse, HDR10PlusMetadata })).toBe(true);
            expect(isDecodeWorkerResponse({ ...packetResponse, HDR10PlusMetadata: { status: 'valid' } })).toBe(false);
        });

        it('accepts the track\'s codec private data on ready only within its bound', () => {
            const readyResponse = {
                audio: null,
                codec: 'hvc1.2.4.L153.B0',
                codecPrivate: new ArrayBuffer(GPU_CODEC_PRIVATE_BYTE_LENGTH),
                codedHeight: 2_160,
                codedWidth: GPU_POOL_CODED_WIDTH,
                displayHeight: 2_160,
                displayWidth: GPU_POOL_CODED_WIDTH,
                generation: GPU_VIDEO_GENERATION,
                type: 'ready'
            } as const;

            expect(isDecodeWorkerResponse(readyResponse)).toBe(true);
            expect(isDecodeWorkerResponse({ ...readyResponse, codecPrivate: undefined })).toBe(true);
            expect(isDecodeWorkerResponse({ ...readyResponse, codecPrivate: new ArrayBuffer(0) })).toBe(false);
            expect(isDecodeWorkerResponse({ ...readyResponse, codecPrivate: new ArrayBuffer(GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH + 1) })).toBe(false);
            expect(isDecodeWorkerResponse({ ...readyResponse, codecPrivate: new Uint8Array(GPU_CODEC_PRIVATE_BYTE_LENGTH) })).toBe(false);
            expect(isDecodeWorkerResponse({ ...readyResponse, maximumPictureSize: GPU_MAXIMUM_PICTURE_SIZE })).toBe(true);
            expect(isDecodeWorkerResponse({ ...readyResponse, maximumPictureSize: { ...GPU_MAXIMUM_PICTURE_SIZE, height: 0 } })).toBe(false);
            expect(isDecodeWorkerResponse({ ...readyResponse, maximumPictureSize: null })).toBe(false);
        });
    });
});
