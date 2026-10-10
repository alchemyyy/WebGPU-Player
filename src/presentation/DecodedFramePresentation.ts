// The per-frame rules the page presenter and the decode worker's renderer share: the color and layout a decoded frame must carry for the configured route, the Dolby Vision RPU and layers each frame presents, and the HDR10+ settings it tone-maps with

import type { InputColorMetadata } from '../color/ColorMetadata';
import { getRawFormatBitDepth, isRawDolbyVisionVideoFrameFormat } from '../color/ColorPipelineShader';
import type { Microseconds } from '../MediaTime';
import {
    isTransferableDolbyVisionEncodedFrameMetadata,
    type TransferableDolbyVisionEncodedFrameMetadata
} from '../video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import { decodeDolbyVisionRPUSnapshot } from '../video/dolby-vision/DolbyVisionRPUParser';
import {
    getHDR10PlusSceneLuminance,
    isHDR10PlusFrameMetadata,
    type HDR10PlusFrameMetadata
} from '../video/hdr/HDR10PlusMetadata';
import {
    RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT,
    type RawVideoFrameColorSpace,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from '../video/RawVideoFrameCopy';
import { hasValidRawVideoFrameLayout } from './RawYUVGPURenderer';
import type { HDR10PlusFrameRenderSettings, HDRToSDRRenderSettings } from './RenderSettings';
import type {
    WorkerPresentationDolbyVisionDualLayerMode,
    WorkerPresentationInputMode
} from './WorkerPresentationProtocol';

// An EL timestamp may differ from its BL's by the rounding of one microsecond
const MAXIMUM_ENHANCEMENT_LAYER_TIMESTAMP_DIFFERENCE_MICROSECONDS = 1;

/** A raw frame with the timing its decoder reported, and, on a Dolby Vision pair route, its EL or null when the EL did not decode. */
export type TimedRawPresentationFrame = {
    durationMicroseconds: Microseconds
    enhancementFrame?: TransferableRawVideoFrame | null
    frame: TransferableRawVideoFrame
    mediaTimeMicroseconds: Microseconds
};

/** The one RPU of a Profile 4 or 7 frame, with what it says of the frame's EL. */
export type DualLayerDolbyVisionRPUData = {
    enhancementLayerBitDepth: number
    layerMode: 'fel' | 'mel'
    packedRPUData: ArrayBuffer
};

/** Returns whether a decoded VideoFrame's colorSpace is exactly the configured metadata. */
export function decodedFrameColorMatches(frame: VideoFrame, metadata: InputColorMetadata): boolean {
    const colorSpace = frame.colorSpace;
    return String(colorSpace.transfer) === metadata.transfer
        && String(colorSpace.primaries) === metadata.primaries
        && String(colorSpace.matrix) === metadata.matrix
        && colorSpace.fullRange === (metadata.range === 'full');
}

/** Returns whether a decoded VideoFrame carries the neutral limited BT.709 color that the external HDR and Dolby Vision routes rewrite their streams to. */
export function decodedNeutralBT709FrameColorMatches(frame: VideoFrame): boolean {
    const colorSpace = frame.colorSpace;
    return colorSpace.fullRange === false
        && String(colorSpace.matrix) === 'bt709'
        && String(colorSpace.primaries) === 'bt709'
        && String(colorSpace.transfer) === 'bt709';
}

/** Returns whether a route's pipeline takes its frames as external textures. */
export function isExternalInputMode(inputMode: WorkerPresentationInputMode): boolean {
    return inputMode === 'external-texture'
        || inputMode === 'external-hdr'
        || inputMode === 'external-dolby-vision';
}

/** Returns whether a route reconstructs Dolby Vision from each frame's RPU. */
export function isDolbyVisionInputMode(inputMode: WorkerPresentationInputMode): boolean {
    return inputMode === 'raw-dolby-vision' || inputMode === 'external-dolby-vision';
}

/** Returns whether a raw frame's transfer agrees with the metadata; a null transfer is unspecified. */
function rawFrameTransferMatches(colorSpace: RawVideoFrameColorSpace, metadata: InputColorMetadata): boolean {
    const transfer = colorSpace.transfer;
    if (transfer === null) {
        return true;
    }
    switch (metadata.transfer) {
        case 'hlg':
            // NOTE: An HLG-compatible VUI signals a BT.2020 transfer, which uses the BT.709 curve.
            // A decoder may report that transfer as bt709 instead of null
            return transfer === 'arib-std-b67'
                || transfer === 'hlg'
                || (transfer === 'bt709' && colorSpace.primaries === 'bt2020');
        case 'pq':
            return transfer === 'pq' || transfer === 'smpte2084';
        case 'sdr':
            // SMPTE 170M uses the BT.709 OETF
            return transfer === 'bt709' || transfer === 'smpte170m';
    }
}

/** Returns whether a raw frame color member agrees with the metadata; a null member is unspecified. */
function rawFrameColorMemberMatches(frameValue: string | null, metadataValue: string): boolean {
    return frameValue === null || frameValue === metadataValue;
}

function rawFrameColorMatches(frame: TransferableRawVideoFrame, metadata: InputColorMetadata): boolean {
    const colorSpace = frame.colorSpace;
    return frame.bitDepth === metadata.bitDepth
        && (colorSpace.fullRange === null || colorSpace.fullRange === (metadata.range === 'full'))
        && rawFrameColorMemberMatches(colorSpace.matrix, metadata.matrix)
        && rawFrameColorMemberMatches(colorSpace.primaries, metadata.primaries)
        && rawFrameTransferMatches(colorSpace, metadata);
}

function rawFrameTimingMatches(decodedFrame: TimedRawPresentationFrame): boolean {
    const frame = decodedFrame.frame;
    return frame.timestampMicroseconds === decodedFrame.mediaTimeMicroseconds
        && (frame.durationMicroseconds === null
            || frame.durationMicroseconds === decodedFrame.durationMicroseconds);
}

/**
 * Returns whether a raw frame takes the raw YUV route in format with the metadata, apart from its plane layout.
 * The worker renderer checked that layout when it uploaded the planes.
 */
export function rawFrameRouteMatches(
    decodedFrame: TimedRawPresentationFrame,
    metadata: InputColorMetadata,
    format: SupportedRawVideoFrameFormat
): boolean {
    return decodedFrame.frame.format === format
        && rawFrameTimingMatches(decodedFrame)
        && rawFrameColorMatches(decodedFrame.frame, metadata);
}

/** Returns whether a raw frame takes the raw YUV route in format with the metadata, plane layout included. */
export function rawFrameDescriptorMatches(
    decodedFrame: TimedRawPresentationFrame,
    metadata: InputColorMetadata,
    format: SupportedRawVideoFrameFormat
): boolean {
    return rawFrameRouteMatches(decodedFrame, metadata, format)
        && hasValidRawVideoFrameLayout(decodedFrame.frame);
}

/** Returns whether a raw Dolby Vision BL takes the route in format, apart from its plane layout. */
export function rawDolbyVisionFrameRouteMatches(
    decodedFrame: TimedRawPresentationFrame,
    format: SupportedRawVideoFrameFormat
): boolean {
    const frame = decodedFrame.frame;
    return isRawDolbyVisionVideoFrameFormat(format)
        && frame.format === format
        && frame.bitDepth === getRawFormatBitDepth(format)
        && rawFrameTimingMatches(decodedFrame);
}

/** Returns whether a raw Dolby Vision BL takes the route in format, plane layout included. */
export function rawDolbyVisionFrameDescriptorMatches(
    decodedFrame: TimedRawPresentationFrame,
    format: SupportedRawVideoFrameFormat
): boolean {
    return rawDolbyVisionFrameRouteMatches(decodedFrame, format)
        && hasValidRawVideoFrameLayout(decodedFrame.frame);
}

/**
 * Returns whether a frame's EL, if any, is the 10-bit 4:2:0 layer at its BL's time and at the BL's size or half of it, apart from its plane layout.
 * A frame without an EL matches.
 */
export function rawDolbyVisionEnhancementFrameRouteMatches(decodedFrame: TimedRawPresentationFrame): boolean {
    const enhancementFrame = decodedFrame.enhancementFrame;
    if (!enhancementFrame) {
        return true;
    }
    const baseFrame = decodedFrame.frame;
    const hasCompatibleDimensions = (
        enhancementFrame.codedWidth === baseFrame.codedWidth
        && enhancementFrame.codedHeight === baseFrame.codedHeight
    ) || (
        enhancementFrame.codedWidth * 2 === baseFrame.codedWidth
        && enhancementFrame.codedHeight * 2 === baseFrame.codedHeight
    );
    return enhancementFrame.format === RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT
        && enhancementFrame.bitDepth === getRawFormatBitDepth(RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT)
        && hasCompatibleDimensions
        && Math.abs(enhancementFrame.timestampMicroseconds - decodedFrame.mediaTimeMicroseconds)
            <= MAXIMUM_ENHANCEMENT_LAYER_TIMESTAMP_DIFFERENCE_MICROSECONDS;
}

/** Returns whether a frame's EL, if any, takes the route, its planes in the BL's buffer with the exact upload layout included. */
export function rawDolbyVisionEnhancementFrameDescriptorMatches(decodedFrame: TimedRawPresentationFrame): boolean {
    const enhancementFrame = decodedFrame.enhancementFrame;
    if (!enhancementFrame) {
        return true;
    }
    return enhancementFrame.data === decodedFrame.frame.data
        && rawDolbyVisionEnhancementFrameRouteMatches(decodedFrame)
        && hasValidRawVideoFrameLayout(enhancementFrame);
}

/** Returns whether a raw frame's planes, and the EL planes a Dolby Vision pair keeps in the same buffer, have the exact aligned layout the GPU upload reads. */
export function rawFrameLayoutMatches(decodedFrame: TimedRawPresentationFrame): boolean {
    const enhancementFrame = decodedFrame.enhancementFrame;
    return hasValidRawVideoFrameLayout(decodedFrame.frame)
        && (!enhancementFrame || (
            enhancementFrame.data === decodedFrame.frame.data
            && hasValidRawVideoFrameLayout(enhancementFrame)
        ));
}

/**
 * Returns the one single-layer RPU of a frame.
 * Profile 5 and 8 RPUs reconstruct through the same RPU-driven transform, so either is accepted whatever the container profile says (Profile 20 base views carry either).
 */
export function getSingleLayerDolbyVisionRPUData(
    metadata: TransferableDolbyVisionEncodedFrameMetadata | undefined,
    expectedBaseLayerBitDepth: number
): ArrayBuffer | null {
    if (
        !isTransferableDolbyVisionEncodedFrameMetadata(metadata)
        || metadata.hasEnhancementLayerVCL
        || metadata.enhancementLayerDisposition !== 'absent'
        || metadata.parsedRPUData.length !== 1
    ) {
        return null;
    }
    try {
        const packedRPUData = metadata.parsedRPUData[0];
        const snapshot = decodeDolbyVisionRPUSnapshot(packedRPUData);
        return (snapshot.profile === 5 || snapshot.profile === 8)
            && snapshot.layerMode === 'single-layer'
            && snapshot.baseLayerBitDepth === expectedBaseLayerBitDepth
            && snapshot.disableResidual
            && !snapshot.nlqActive ?
            packedRPUData :
            null;
    } catch {
        return null;
    }
}

/** Returns the EL disposition a dual-layer frame must report for its EL state. */
function getExpectedDualLayerDisposition(
    layerMode: 'fel' | 'mel',
    hasEnhancementLayerVCL: boolean,
    hasDecodedEnhancementFrame: boolean
): TransferableDolbyVisionEncodedFrameMetadata['enhancementLayerDisposition'] {
    if (!hasEnhancementLayerVCL) {
        return 'absent';
    }
    if (hasDecodedEnhancementFrame) {
        return layerMode === 'fel' ? 'decoded-fel' : 'decoded-mel';
    }
    return layerMode === 'fel' ? 'discarded-fel' : 'discarded-mel';
}

/**
 * Returns the one dual-layer RPU of a Profile 4 or 7 frame.
 * A frame whose EL is absent from the stream is accepted: MEL reconstructs exactly from the BL, and FEL presents its compatible base.
 */
export function getDualLayerDolbyVisionRPUData(
    metadata: TransferableDolbyVisionEncodedFrameMetadata | undefined,
    expectedProfile: 4 | 7,
    expectedBaseLayerBitDepth: number,
    hasDecodedEnhancementFrame: boolean
): DualLayerDolbyVisionRPUData | null {
    if (
        !isTransferableDolbyVisionEncodedFrameMetadata(metadata)
        || metadata.parsedRPUData.length !== 1
        || (hasDecodedEnhancementFrame && !metadata.hasEnhancementLayerVCL)
    ) {
        return null;
    }
    try {
        const packedRPUData = metadata.parsedRPUData[0];
        const snapshot = decodeDolbyVisionRPUSnapshot(packedRPUData);
        if (
            snapshot.profile !== expectedProfile
            || snapshot.baseLayerBitDepth !== expectedBaseLayerBitDepth
            || snapshot.disableResidual
            || snapshot.layerMode === 'single-layer'
            // MEL carries no active residual and FEL always does
            || snapshot.nlqActive !== (snapshot.layerMode === 'fel')
            || metadata.enhancementLayerDisposition !== getExpectedDualLayerDisposition(
                snapshot.layerMode,
                metadata.hasEnhancementLayerVCL,
                hasDecodedEnhancementFrame
            )
        ) {
            return null;
        }
        return {
            enhancementLayerBitDepth: snapshot.enhancementLayerBitDepth,
            layerMode: snapshot.layerMode,
            packedRPUData
        };
    } catch {
        return null;
    }
}

/**
 * Returns the EL a frame composes, if any.
 * The EL texture holds the EL decoder's 10-bit codes, so an RPU that scales its residual by another depth presents its base instead, as a frame whose EL failed to decode does.
 */
export function getComposedEnhancementFrame(
    rpuData: DualLayerDolbyVisionRPUData | null,
    reconstructsFEL: boolean,
    enhancementFrame: TransferableRawVideoFrame | null | undefined
): TransferableRawVideoFrame | null {
    if (
        !reconstructsFEL
        || !enhancementFrame
        || rpuData?.enhancementLayerBitDepth !== getRawFormatBitDepth(RAW_VIDEO_DOLBY_VISION_ENHANCEMENT_FRAME_FORMAT)
    ) {
        return null;
    }
    return enhancementFrame;
}

/** Returns which layers a Profile 4 or 7 frame presents. */
export function getDualLayerPresentation(
    rpuData: DualLayerDolbyVisionRPUData,
    composedEnhancementFrame: TransferableRawVideoFrame | null
): WorkerPresentationDolbyVisionDualLayerMode {
    if (rpuData.layerMode === 'mel') {
        return 'mel';
    }
    return composedEnhancementFrame ? 'fel' : 'fel-base-fallback';
}

/**
 * Returns the tone mapping a frame's HDR10+ metadata drives, or null when the frame tone-maps with the static settings.
 * Only a PQ route of the external HDR or raw YUV pipelines applies HDR10+.
 * An absent or malformed frame may carry its run's last metadata, which applies as a valid frame's own does.
 */
export function getHDR10PlusFrameRenderSettings(
    frameMetadata: HDR10PlusFrameMetadata | undefined,
    inputMode: WorkerPresentationInputMode,
    inputColorMetadata: InputColorMetadata | null,
    settings: HDRToSDRRenderSettings,
    automaticInputPeakNits: boolean
): HDR10PlusFrameRenderSettings | null {
    const supportsHDR10Plus = (inputMode === 'external-hdr' || inputMode === 'raw-yuv')
        && inputColorMetadata?.transfer === 'pq';
    if (!supportsHDR10Plus || !isHDR10PlusFrameMetadata(frameMetadata) || !frameMetadata.metadata) {
        return null;
    }
    const sceneLuminance = getHDR10PlusSceneLuminance(frameMetadata.metadata);
    const inputPeakNits = automaticInputPeakNits ?
        Math.max(
            settings.toneMapping.paperWhiteNits,
            sceneLuminance.peakNits ?? settings.toneMapping.inputPeakNits
        ) :
        settings.toneMapping.inputPeakNits;
    const averageNits = Math.min(inputPeakNits, Math.max(0, sceneLuminance.averageNits ?? 0));
    return {
        averageNits,
        inputPeakNits,
        targetedSystemDisplayMaximumLuminanceNits: frameMetadata.metadata.targetedSystemDisplayMaximumLuminanceNits,
        toneMapping: frameMetadata.metadata.toneMapping
    };
}
