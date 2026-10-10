import { describe, expect, it } from 'vitest';

import { createPQColorMetadata, createSDRColorMetadata } from 'webgpu-player/color/ColorMetadata';
import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings
} from 'webgpu-player/presentation/RenderSettings';
import {
    isWorkerPresentationRequest,
    isWorkerPresentationResponse,
    MAXIMUM_WORKER_PRESENTATION_SHADER_CODE_LENGTH,
    type WorkerPresentationConfigureRequest
} from 'webgpu-player/presentation/WorkerPresentationProtocol';

const SHADER_CODE = '@vertex fn main() {}';
const FIRST_REVISION = 1;
const DECODE_GENERATION = 7;
const FRAME_ID = 3;
const BACKING_WIDTH = 1_920;
const BACKING_HEIGHT = 1_080;
const HDR10_PLUS_INPUT_PEAK_NITS = 834.75;
// Malformed values the validators must reject
const ZERO_REVISION = 0;
const FRACTIONAL_FRAME_ID = 1.5;
const NEGATIVE_FRAME_ID = -1;
const UNKNOWN_FALLBACK_REASON = 'renderer-tired';
const UNKNOWN_INPUT_MODE = 'external-yuv';
const NEGATIVE_INPUT_PEAK_NITS = -1;

const PRESENTATION_GEOMETRY = {
    textureOffsetX: 0,
    textureOffsetY: 0,
    textureScaleX: 1,
    textureScaleY: 1,
    viewportHeight: BACKING_HEIGHT,
    viewportWidth: BACKING_WIDTH,
    viewportX: 0,
    viewportY: 0
};

function createExternalTextureConfigure(): WorkerPresentationConfigureRequest {
    return {
        automaticInputPeakNits: true,
        dolbyVisionFELReconstruction: false,
        dolbyVisionProfile: null,
        inputColorMetadata: createSDRColorMetadata(),
        inputMode: 'external-texture',
        rawFrameFormat: null,
        revision: FIRST_REVISION,
        settings: createDefaultRenderSettings(),
        shaderCode: SHADER_CODE,
        type: 'configure'
    };
}

function createRawDolbyVisionConfigure(): WorkerPresentationConfigureRequest {
    return {
        automaticInputPeakNits: true,
        dolbyVisionFELReconstruction: true,
        dolbyVisionProfile: 7,
        inputColorMetadata: null,
        inputMode: 'raw-dolby-vision',
        rawFrameFormat: 'I420P10',
        revision: FIRST_REVISION,
        settings: createHDRToSDRRenderSettings(),
        shaderCode: SHADER_CODE,
        type: 'configure'
    };
}

describe('WorkerPresentationProtocol', () => {
    it('accepts a configure only with a route the presenter prepares', () => {
        expect(isWorkerPresentationRequest(createExternalTextureConfigure())).toBe(true);
        expect(isWorkerPresentationRequest(createRawDolbyVisionConfigure())).toBe(true);
        expect(isWorkerPresentationRequest({
            ...createExternalTextureConfigure(),
            inputColorMetadata: createPQColorMetadata(),
            inputMode: 'raw-yuv',
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        })).toBe(true);

        // Each route names exactly its own parameters
        expect(isWorkerPresentationRequest({ ...createExternalTextureConfigure(), rawFrameFormat: 'I420' })).toBe(false);
        expect(isWorkerPresentationRequest({ ...createExternalTextureConfigure(), inputMode: 'raw-yuv' })).toBe(false);
        expect(isWorkerPresentationRequest({ ...createExternalTextureConfigure(), inputMode: 'external-hdr' })).toBe(false);
        expect(isWorkerPresentationRequest({ ...createRawDolbyVisionConfigure(), rawFrameFormat: 'NV12' })).toBe(false);
        expect(isWorkerPresentationRequest({ ...createRawDolbyVisionConfigure(), dolbyVisionProfile: 8 })).toBe(false);
        expect(isWorkerPresentationRequest({ ...createRawDolbyVisionConfigure(), settings: createDefaultRenderSettings() })).toBe(false);
        expect(isWorkerPresentationRequest({
            ...createExternalTextureConfigure(),
            dolbyVisionProfile: 5,
            inputMode: 'external-dolby-vision'
        })).toBe(false);

        expect(isWorkerPresentationRequest({ ...createExternalTextureConfigure(), inputMode: UNKNOWN_INPUT_MODE })).toBe(false);
        expect(isWorkerPresentationRequest({ ...createExternalTextureConfigure(), revision: ZERO_REVISION })).toBe(false);
        expect(isWorkerPresentationRequest({ ...createExternalTextureConfigure(), shaderCode: '' })).toBe(false);
        expect(isWorkerPresentationRequest({
            ...createExternalTextureConfigure(),
            shaderCode: ' '.repeat(MAXIMUM_WORKER_PRESENTATION_SHADER_CODE_LENGTH + 1)
        })).toBe(false);
        expect(isWorkerPresentationRequest({
            ...createExternalTextureConfigure(),
            settings: { ...createDefaultRenderSettings(), mode: 'unknown' }
        })).toBe(false);
    });

    it('accepts live settings only for an HDR-to-SDR configure', () => {
        expect(isWorkerPresentationRequest({
            automaticInputPeakNits: false,
            revision: FIRST_REVISION,
            settings: createHDRToSDRRenderSettings(),
            type: 'settings'
        })).toBe(true);
        expect(isWorkerPresentationRequest({
            automaticInputPeakNits: false,
            revision: FIRST_REVISION,
            settings: createDefaultRenderSettings(),
            type: 'settings'
        })).toBe(false);
        expect(isWorkerPresentationRequest({
            automaticInputPeakNits: 'yes',
            revision: FIRST_REVISION,
            settings: createHDRToSDRRenderSettings(),
            type: 'settings'
        })).toBe(false);
    });

    it('accepts layouts with a positive backing store and viewport', () => {
        const layout = {
            backingHeight: BACKING_HEIGHT,
            backingWidth: BACKING_WIDTH,
            presentation: PRESENTATION_GEOMETRY,
            revision: FIRST_REVISION,
            type: 'layout'
        };
        expect(isWorkerPresentationRequest(layout)).toBe(true);
        expect(isWorkerPresentationRequest({ ...layout, backingWidth: 0 })).toBe(false);
        expect(isWorkerPresentationRequest({ ...layout, presentation: { ...PRESENTATION_GEOMETRY, viewportWidth: 0 } })).toBe(false);
        expect(isWorkerPresentationRequest({
            ...layout,
            presentation: { ...PRESENTATION_GEOMETRY, textureScaleX: Number.NaN }
        })).toBe(false);
    });

    it('accepts presents of a frame ID in a decode generation, and the bare detach', () => {
        const present = {
            frameId: FRAME_ID,
            generation: DECODE_GENERATION,
            layoutRevision: FIRST_REVISION,
            type: 'present'
        };
        expect(isWorkerPresentationRequest(present)).toBe(true);
        expect(isWorkerPresentationRequest({ ...present, frameId: 0 })).toBe(true);
        expect(isWorkerPresentationRequest({ ...present, frameId: NEGATIVE_FRAME_ID })).toBe(false);
        expect(isWorkerPresentationRequest({ ...present, frameId: FRACTIONAL_FRAME_ID })).toBe(false);
        expect(isWorkerPresentationRequest({ ...present, generation: 0 })).toBe(false);
        expect(isWorkerPresentationRequest({ ...present, layoutRevision: ZERO_REVISION })).toBe(false);
        expect(isWorkerPresentationRequest({ type: 'detach' })).toBe(true);
        expect(isWorkerPresentationRequest({ type: 'release' })).toBe(false);
        expect(isWorkerPresentationRequest(null)).toBe(false);
    });

    it('requires a fallback reason exactly when the renderer is unavailable or refuses', () => {
        expect(isWorkerPresentationResponse({ reason: null, state: 'ready', type: 'status' })).toBe(true);
        expect(isWorkerPresentationResponse({ reason: 'gpu-unavailable', state: 'unavailable', type: 'status' })).toBe(true);
        expect(isWorkerPresentationResponse({ reason: 'gpu-unavailable', state: 'ready', type: 'status' })).toBe(false);
        expect(isWorkerPresentationResponse({ reason: null, state: 'unavailable', type: 'status' })).toBe(false);
        expect(isWorkerPresentationResponse({ reason: UNKNOWN_FALLBACK_REASON, state: 'unavailable', type: 'status' })).toBe(false);

        expect(isWorkerPresentationResponse({ ok: true, reason: null, revision: FIRST_REVISION, type: 'configured' })).toBe(true);
        expect(isWorkerPresentationResponse({
            ok: false,
            reason: 'pipeline-creation-failed',
            revision: FIRST_REVISION,
            type: 'configured'
        })).toBe(true);
        expect(isWorkerPresentationResponse({ ok: false, reason: null, revision: FIRST_REVISION, type: 'configured' })).toBe(false);
        expect(isWorkerPresentationResponse({ ok: true, reason: null, revision: ZERO_REVISION, type: 'configured' })).toBe(false);

        expect(isWorkerPresentationResponse({ reason: 'device-recovery-failed', type: 'failed' })).toBe(true);
        expect(isWorkerPresentationResponse({ reason: UNKNOWN_FALLBACK_REASON, type: 'failed' })).toBe(false);
    });

    it('accepts a presented frame only with consistent completion and per-frame facts', () => {
        const presented = {
            dolbyVisionDualLayerMode: null,
            frameId: FRAME_ID,
            generation: DECODE_GENERATION,
            gpuWorkCompleted: true,
            HDR10PlusResult: null,
            ok: true,
            type: 'presented'
        };
        expect(isWorkerPresentationResponse(presented)).toBe(true);
        expect(isWorkerPresentationResponse({ ...presented, gpuWorkCompleted: false })).toBe(true);
        expect(isWorkerPresentationResponse({ ...presented, gpuWorkCompleted: false, ok: false })).toBe(true);
        // A frame that did not present has no GPU work to complete
        expect(isWorkerPresentationResponse({ ...presented, ok: false })).toBe(false);
        expect(isWorkerPresentationResponse({ ...presented, dolbyVisionDualLayerMode: 'fel' })).toBe(true);
        expect(isWorkerPresentationResponse({ ...presented, dolbyVisionDualLayerMode: 'bl' })).toBe(false);
        expect(isWorkerPresentationResponse({
            ...presented,
            HDR10PlusResult: { inputPeakNits: HDR10_PLUS_INPUT_PEAK_NITS, metadataStatus: 'valid' }
        })).toBe(true);
        expect(isWorkerPresentationResponse({
            ...presented,
            HDR10PlusResult: { inputPeakNits: null, metadataStatus: 'absent' }
        })).toBe(true);
        expect(isWorkerPresentationResponse({
            ...presented,
            HDR10PlusResult: { inputPeakNits: NEGATIVE_INPUT_PEAK_NITS, metadataStatus: 'valid' }
        })).toBe(false);
        expect(isWorkerPresentationResponse({
            ...presented,
            HDR10PlusResult: { inputPeakNits: null, metadataStatus: 'unknown' }
        })).toBe(false);
        expect(isWorkerPresentationResponse({ ...presented, frameId: NEGATIVE_FRAME_ID })).toBe(false);
        expect(isWorkerPresentationResponse({ type: 'stopped' })).toBe(false);
    });
});
