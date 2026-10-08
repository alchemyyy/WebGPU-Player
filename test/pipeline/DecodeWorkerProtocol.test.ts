import { describe, expect, it, vi } from 'vitest';

import {
    millisecondsToMicroseconds,
    secondsToMicroseconds
} from 'webgpu-player/MediaTime';
import {
    getCustomDecodeHardwareAcceleration,
    getCustomDecodeRequestHardwareAcceleration,
    getDolbyVisionRawFrameLayerCount,
    isDecodeWorkerRequest,
    isDecodeWorkerResponse,
    MAX_DECODED_AUDIO_CHANNELS,
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
    MAX_DECODED_FRAME_CREDITS,
    MAX_DECODED_RAW_FRAME_CREDITS,
    MAXIMUM_VIDEO_STARTUP_PROGRESS_PACKET_COUNT
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import { CUSTOM_AUDIO_DOWNMIX_ALGORITHMS } from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import {
    MAXIMUM_CUSTOM_AUDIO_SAMPLE_RATE,
    MINIMUM_CUSTOM_AUDIO_SAMPLE_RATE
} from 'webgpu-player/audio/CustomAudioSampleRate';
import {
    DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION,
    MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_COUNT
} from 'webgpu-player/video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import {
    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH
} from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParser';
import { MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH } from 'webgpu-player/audio/native/NativeMediaAudioLimits';
import {
    MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH,
    type TransferableRawVideoFrame
} from 'webgpu-player/video/RawVideoFrameCopy';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';
import { parseHEVCHDR10PlusMetadata } from 'webgpu-player/video/hdr/HDR10PlusMetadata';

import { createHDR10PlusHEVCVector } from '../../src/capability/vectors/HDR10PlusVectors';

const DOLBY_VISION_RPU_PARSER_WASM_URL =
    'https://example.test/libraries/libdovi/dovi-rpu-parser.wasm';

function createPackedRPUData(): ArrayBuffer {
    return createDolbyVisionAuthorizationRPUVector();
}

function createRawFrame(): TransferableRawVideoFrame {
    return {
        bitDepth: 8,
        codedHeight: 2,
        codedWidth: 4,
        colorSpace: {
            fullRange: false,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'bt709'
        },
        data: new ArrayBuffer(1_024),
        displayHeight: 2,
        displayWidth: 4,
        durationMicroseconds: millisecondsToMicroseconds(41.708),
        format: 'I420',
        planes: [
            {
                byteLength: 512,
                byteOffset: 0,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 2,
                kind: 'y',
                rowByteLength: 4,
                width: 4
            },
            {
                byteLength: 256,
                byteOffset: 512,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 1,
                kind: 'u',
                rowByteLength: 2,
                width: 2
            },
            {
                byteLength: 256,
                byteOffset: 768,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 1,
                kind: 'v',
                rowByteLength: 2,
                width: 2
            }
        ],
        timestampMicroseconds: secondsToMicroseconds(-0.5),
        visibleRectangle: { height: 2, width: 4, x: 0, y: 0 }
    };
}

function createCompoundRawFrames(): {
    baseFrame: TransferableRawVideoFrame
    enhancementFrame: TransferableRawVideoFrame
} {
    const baseFrame = createRawFrame();
    const enhancementFrame = createRawFrame();
    const data = new ArrayBuffer(2_048);
    baseFrame.data = data;
    enhancementFrame.data = data;
    enhancementFrame.planes = enhancementFrame.planes.map(plane => ({
        ...plane,
        byteOffset: plane.byteOffset + 1_024
    }));
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

    it('selects acceleration for native raw output and the bundled HEVC backend', () => {
        expect(getCustomDecodeHardwareAcceleration('raw-planes')).toBe('no-preference');
        expect(getCustomDecodeHardwareAcceleration('raw-planes', 'native', true)).toBe('no-preference');
        expect(getCustomDecodeHardwareAcceleration('video-frame', 'bundled-hevc'))
            .toBe('prefer-software');
        expect(getCustomDecodeHardwareAcceleration('video-frame', 'openjpeg'))
            .toBe('prefer-software');
        expect(getCustomDecodeHardwareAcceleration('video-frame', 'ffmpeg-mpeg2-vc1'))
            .toBe('prefer-software');
    });

    it('prefers hardware only for native VideoFrames whose opaque hardware output is presented', () => {
        // The SDR probes qualify with no preference, so a codec without a hardware decoder still plays
        expect(getCustomDecodeHardwareAcceleration('video-frame')).toBe('no-preference');
        expect(getCustomDecodeHardwareAcceleration('video-frame', 'native', true)).toBe('prefer-hardware');
    });

    it.each([
        {
            expected: 'no-preference',
            request: {
                dolbyVisionProfile: null,
                neutralizeHDRColorMetadata: false,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            }
        },
        {
            expected: 'prefer-hardware',
            request: {
                dolbyVisionProfile: null,
                neutralizeHDRColorMetadata: true,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            }
        },
        {
            expected: 'prefer-hardware',
            request: {
                dolbyVisionProfile: 5,
                neutralizeHDRColorMetadata: false,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            }
        },
        {
            expected: 'no-preference',
            request: {
                dolbyVisionProfile: 8,
                neutralizeHDRColorMetadata: false,
                videoDecoderBackend: 'native',
                videoOutputMode: 'raw-planes'
            }
        },
        {
            expected: 'prefer-software',
            request: {
                dolbyVisionProfile: 7,
                neutralizeHDRColorMetadata: false,
                videoDecoderBackend: 'bundled-hevc',
                videoOutputMode: 'raw-planes'
            }
        }
    ] as const)('selects $expected for a start request route', ({ expected, request }) => {
        expect(getCustomDecodeRequestHardwareAcceleration(request)).toBe(expected);
    });

    it('validates the container duration request and its positive report', () => {
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
            reportContainerDuration: true,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
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
        expect(isDecodeWorkerRequest({ ...request, reportContainerDuration: 'yes' })).toBe(false);
        expect(isDecodeWorkerResponse(readyResponse)).toBe(true);
        expect(isDecodeWorkerResponse({ ...readyResponse, containerDurationMicroseconds: 0 })).toBe(false);
        expect(isDecodeWorkerResponse({ ...readyResponse, containerDurationMicroseconds: -1 })).toBe(false);
    });

    it('accepts only the SDR VideoFrame shape for FFmpeg MPEG-2/VC-1 video', () => {
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
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'ffmpeg-mpeg2-vc1',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;

        expect(isDecodeWorkerRequest(request)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...request,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...request,
            dolbyVisionProfile: 8
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...request,
            nativeHDRTransfer: 'pq'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...request,
            neutralizeHDRColorMetadata: true
        })).toBe(false);
    });

    it('accepts only the SDR VideoFrame shape for OpenJPEG', () => {
        const request = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 540,
            maximumCodedWidth: 960,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mj2',
            videoDecoderBackend: 'openjpeg',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;

        expect(isDecodeWorkerRequest(request)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...request,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...request,
            dolbyVisionProfile: 8
        })).toBe(false);
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
            url: 'http://localhost/video.mp4',
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
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'bundled-hevc',
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
                parsedRPUData: Array.from(
                    { length: MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_COUNT + 1 },
                    createPackedRPUData
                ),
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
        const validMetadata = parseHEVCHDR10PlusMetadata(
            createHDR10PlusHEVCVector('valid'),
            { kind: 'annex-b' }
        );
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
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            HDR10PlusMetadata: { metadata: validMetadata.metadata, status: 'absent' }
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
            url: 'http://localhost/video.mkv',
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
            url: 'http://localhost/video.mkv',
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
            videoDecoderBackend: 'bundled-hevc'
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
            url: 'http://localhost/video.mp4',
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

    it('requires two in-flight raw transfer credits independently of each transfer byte bound', () => {
        expect(MAX_DECODED_RAW_FRAME_CREDITS).toBe(2);
        expect(MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH).toBe(128 * 1_024 * 1_024);
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
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'bundled-hevc',
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

    it('accepts 8K raw geometry within one transfer budget and rejects an oversized transfer', () => {
        const rawStartRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 4_320,
            maximumCodedWidth: 7_680,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        } as const;

        expect(isDecodeWorkerRequest(rawStartRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...rawStartRequest,
            maximumCodedHeight: 8_640,
            maximumCodedWidth: 15_360
        })).toBe(false);
    });

    it('charges both Profile 7 layers to each compound transfer budget', () => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: 7,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 4_320,
            maximumCodedWidth: 7_680,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        })).toBe(false);
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

    it('validates bounded planar PCM and independent audio credits', () => {
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
            url: 'http://localhost/video.mkv',
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
        expect(isDecodeWorkerResponse({
            channelCount: 2,
            channelData: [ new Float32Array(1_024), new Float32Array(1_024) ],
            durationMicroseconds: 21_333,
            frameCount: 1_024,
            generation: 2,
            mediaTimeMicroseconds: -21_333,
            sampleRate: 48_000,
            type: 'audio'
        })).toBe(true);

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
            url: 'http://localhost/video.mkv',
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
        expect(isDecodeWorkerResponse({
            channelCount: 2,
            channelData: [ new Float32Array(1_024), new Float32Array(512) ],
            durationMicroseconds: 21_333,
            frameCount: 1_024,
            generation: 2,
            mediaTimeMicroseconds: 0,
            sampleRate: 48_000,
            type: 'audio'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            channelCount: 2,
            channelData: [ new Float32Array(1_024), new Float32Array(1_024) ],
            durationMicroseconds: 5_333,
            frameCount: 1_024,
            generation: 2,
            mediaTimeMicroseconds: 0,
            sampleRate: MAXIMUM_CUSTOM_AUDIO_SAMPLE_RATE + 1,
            type: 'audio'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            channelCount: 2,
            channelData: [ new Float32Array(1_024), new Float32Array(1_024) ],
            durationMicroseconds: 5_333,
            frameCount: 1_024,
            generation: 2,
            mediaTimeMicroseconds: 0,
            sampleRate: MINIMUM_CUSTOM_AUDIO_SAMPLE_RATE - 1,
            type: 'audio'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: {
                channelCount: 2,
                codec: 'opus',
                sampleRate: MAXIMUM_CUSTOM_AUDIO_SAMPLE_RATE + 1
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
                sourceSampleRate: MINIMUM_CUSTOM_AUDIO_SAMPLE_RATE - 1
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
            url: 'http://localhost/video.mkv',
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
            MINIMUM_CUSTOM_AUDIO_SAMPLE_RATE - 1,
            MAXIMUM_CUSTOM_AUDIO_SAMPLE_RATE + 1,
            48_000.5,
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
            audioSampleCredits: MAX_DECODED_AUDIO_SAMPLE_CREDITS,
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
        const validChannelCounts: readonly unknown[] = [ 2, 6, 8 ];
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
                decodedAudioOutputChannelCount: validChannelCount
            })).toBe(true);
        }
        for (const invalidChannelCount of invalidChannelCounts) {
            expect(isDecodeWorkerRequest({
                ...resyncRequest,
                decodedAudioOutputChannelCount: invalidChannelCount
            })).toBe(false);
        }
    });

    it('bounds the replacement audio credit window and the audio resync target', () => {
        const resyncRequest = {
            audioEpoch: 1,
            audioSampleCredits: 3,
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
                audioSampleCredits: validAudioSampleCredit
            })).toBe(true);
        }
        for (const invalidAudioSampleCredit of invalidAudioSampleCredits) {
            expect(isDecodeWorkerRequest({
                ...resyncRequest,
                audioSampleCredits: invalidAudioSampleCredit
            })).toBe(false);
        }
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
            audioSampleCredits: 4,
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

    it('treats an omitted PCM sample epoch as the initial attempt and rejects malformed epochs', () => {
        const audioResponse = {
            channelCount: 6,
            channelData: Array.from(
                { length: 6 },
                (): Float32Array => new Float32Array(1_024)
            ),
            durationMicroseconds: 21_333,
            frameCount: 1_024,
            generation: 2,
            mediaTimeMicroseconds: 5_000_000,
            sampleRate: 48_000,
            type: 'audio'
        } as const;
        const validAudioEpochs: readonly unknown[] = [ 0, 4, Number.MAX_SAFE_INTEGER ];
        const invalidAudioEpochs: readonly unknown[] = [ -1, 0.5, '1', null, Number.NaN ];

        expect(isDecodeWorkerResponse(audioResponse)).toBe(true);
        for (const validAudioEpoch of validAudioEpochs) {
            expect(isDecodeWorkerResponse({
                ...audioResponse,
                audioEpoch: validAudioEpoch
            })).toBe(true);
        }
        for (const invalidAudioEpoch of invalidAudioEpochs) {
            expect(isDecodeWorkerResponse({
                ...audioResponse,
                audioEpoch: invalidAudioEpoch
            })).toBe(false);
        }
    });
});
