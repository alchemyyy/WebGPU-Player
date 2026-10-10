// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { createHLGColorMetadata, createPQColorMetadata } from 'webgpu-player/color/ColorMetadata';
import type { Microseconds } from 'webgpu-player/MediaTime';
import {
    getHDR10PlusFrameRenderSettings,
    rawDolbyVisionEnhancementFrameDescriptorMatches,
    rawDolbyVisionEnhancementFrameRouteMatches,
    rawFrameDescriptorMatches,
    rawFrameLayoutMatches,
    rawFrameRouteMatches,
    type TimedRawPresentationFrame
} from 'webgpu-player/presentation/DecodedFramePresentation';
import { createHDRToSDRRenderSettings } from 'webgpu-player/presentation/RenderSettings';
import { parseHEVCHDR10PlusMetadata } from 'webgpu-player/video/hdr/HDR10PlusMetadata';
import type { TransferableRawVideoFrame } from 'webgpu-player/video/RawVideoFrameCopy';

import { createHDR10PlusHEVCVector } from '../../src/capability/vectors/HDR10PlusVectors';
import {
    RAW_FRAME_DURATION_MICROSECONDS,
    RAW_FRAME_TIMESTAMP_MICROSECONDS,
    copyRawFrame,
    copyRawFramePair
} from '../helpers/workerPresentationFakes';

const FRAME_WIDTH = 16;
const FRAME_HEIGHT = 8;
// A plane row stride the aligned upload layout never has
const MISALIGNED_BYTES_PER_ROW = 100;
// Further from the BL's time than the 1 µs an EL may differ by
const DISTANT_TIMESTAMP_OFFSET_MICROSECONDS = 2;
// The scene peak of the valid HDR10+ vector, which the automatic input peak adopts
const HDR10_PLUS_VECTOR_SCENE_PEAK_NITS = 834.75;
const MANUAL_INPUT_PEAK_NITS = 1_200;

function createTimedFrame(
    frame: TransferableRawVideoFrame,
    enhancementFrame?: TransferableRawVideoFrame | null
): TimedRawPresentationFrame {
    const timedFrame: TimedRawPresentationFrame = {
        durationMicroseconds: RAW_FRAME_DURATION_MICROSECONDS as Microseconds,
        frame,
        mediaTimeMicroseconds: RAW_FRAME_TIMESTAMP_MICROSECONDS as Microseconds
    };
    if (enhancementFrame !== undefined) {
        timedFrame.enhancementFrame = enhancementFrame;
    }
    return timedFrame;
}

function misalignPlanes(frame: TransferableRawVideoFrame): TransferableRawVideoFrame {
    return {
        ...frame,
        planes: frame.planes.map(plane => ({ ...plane, bytesPerRow: MISALIGNED_BYTES_PER_ROW }))
    };
}

describe('the decoded frame presentation rules', () => {
    it('checks a raw frame\'s route apart from its plane layout, which the descriptor check adds', async () => {
        const metadata = createPQColorMetadata();
        const frame = await copyRawFrame('I420P10', FRAME_WIDTH, FRAME_HEIGHT);

        expect(rawFrameRouteMatches(createTimedFrame(frame), metadata, 'I420P10')).toBe(true);
        expect(rawFrameDescriptorMatches(createTimedFrame(frame), metadata, 'I420P10')).toBe(true);

        const misalignedFrame = misalignPlanes(frame);
        expect(rawFrameRouteMatches(createTimedFrame(misalignedFrame), metadata, 'I420P10')).toBe(true);
        expect(rawFrameDescriptorMatches(createTimedFrame(misalignedFrame), metadata, 'I420P10')).toBe(false);
        expect(rawFrameLayoutMatches(createTimedFrame(misalignedFrame))).toBe(false);

        expect(rawFrameRouteMatches(createTimedFrame(frame), metadata, 'I420P12')).toBe(false);
        expect(rawFrameRouteMatches(createTimedFrame(frame), createHLGColorMetadata(), 'I420P10')).toBe(false);
        expect(rawFrameRouteMatches({
            ...createTimedFrame(frame),
            mediaTimeMicroseconds: (RAW_FRAME_TIMESTAMP_MICROSECONDS + DISTANT_TIMESTAMP_OFFSET_MICROSECONDS) as Microseconds
        }, metadata, 'I420P10')).toBe(false);
    });

    it('checks a Dolby Vision EL\'s route apart from its layout, which needs the EL in its BL\'s buffer', async () => {
        const { baseFrame, enhancementFrame } = await copyRawFramePair('I420P10', FRAME_WIDTH, FRAME_HEIGHT, true);
        if (!enhancementFrame) {
            throw new Error('The pair copy dropped its EL');
        }
        const pair = createTimedFrame(baseFrame, enhancementFrame);
        expect(rawDolbyVisionEnhancementFrameRouteMatches(pair)).toBe(true);
        expect(rawDolbyVisionEnhancementFrameDescriptorMatches(pair)).toBe(true);
        expect(rawFrameLayoutMatches(pair)).toBe(true);

        const separateEnhancementFrame: TransferableRawVideoFrame = {
            ...enhancementFrame,
            data: enhancementFrame.data.slice(0)
        };
        const separatePair = createTimedFrame(baseFrame, separateEnhancementFrame);
        expect(rawDolbyVisionEnhancementFrameRouteMatches(separatePair)).toBe(true);
        expect(rawDolbyVisionEnhancementFrameDescriptorMatches(separatePair)).toBe(false);
        expect(rawFrameLayoutMatches(separatePair)).toBe(false);

        const distantEnhancementFrame: TransferableRawVideoFrame = {
            ...enhancementFrame,
            timestampMicroseconds: (RAW_FRAME_TIMESTAMP_MICROSECONDS + DISTANT_TIMESTAMP_OFFSET_MICROSECONDS) as Microseconds
        };
        expect(rawDolbyVisionEnhancementFrameRouteMatches(createTimedFrame(baseFrame, distantEnhancementFrame))).toBe(false);
        // A pair whose EL did not decode, and a frame without an EL, have nothing to check
        expect(rawDolbyVisionEnhancementFrameRouteMatches(createTimedFrame(baseFrame, null))).toBe(true);
        expect(rawFrameLayoutMatches(createTimedFrame(baseFrame))).toBe(true);
    });

    it('drives a frame\'s tone mapping with its HDR10+ metadata only on a PQ route that applies HDR10+', () => {
        const settings = createHDRToSDRRenderSettings({ toneMapping: { inputPeakNits: MANUAL_INPUT_PEAK_NITS } });
        const frameMetadata = parseHEVCHDR10PlusMetadata(createHDR10PlusHEVCVector('valid'), { kind: 'annex-b' });
        const PQMetadata = createPQColorMetadata();

        const automaticSettings = getHDR10PlusFrameRenderSettings(frameMetadata, 'raw-yuv', PQMetadata, settings, true);
        expect(automaticSettings?.inputPeakNits).toBeCloseTo(HDR10_PLUS_VECTOR_SCENE_PEAK_NITS);
        expect(getHDR10PlusFrameRenderSettings(frameMetadata, 'external-hdr', PQMetadata, settings, false)?.inputPeakNits)
            .toBe(MANUAL_INPUT_PEAK_NITS);

        expect(getHDR10PlusFrameRenderSettings(frameMetadata, 'raw-yuv', createHLGColorMetadata(), settings, true)).toBeNull();
        expect(getHDR10PlusFrameRenderSettings(frameMetadata, 'raw-dolby-vision', PQMetadata, settings, true)).toBeNull();
        expect(getHDR10PlusFrameRenderSettings(undefined, 'raw-yuv', PQMetadata, settings, true)).toBeNull();
    });
});
