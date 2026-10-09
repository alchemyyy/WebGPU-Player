// The HDR10+ AV1 test vectors, the known answers their generator wrote, and the static HDR metadata the engine reads from them

import type { StaticHDRMetadata } from 'webgpu-player/video/hdr/StaticHDRMetadata';

import {
    readHDR10PlusVectorExpectations,
    readHDR10PlusVectorFile,
    type HDR10PlusVectorExpectations,
    type HDR10PlusVectorFrame
} from './hdr10PlusVectors';

const AV1_HDR10_PLUS_VECTOR_FOLDER_NAME = 'hdr10plus-av1';
// metadata_hdr_mdcv() codes luminance_max in 24.8 and luminance_min in 18.14 fixed point
const MASTERING_MAXIMUM_LUMINANCE_SCALE = 2 ** 8;
const MASTERING_MINIMUM_LUMINANCE_SCALE = 2 ** 14;

export type AV1HDR10PlusVectorFrame = HDR10PlusVectorFrame & {
    /** Whether the frame's temporal unit carries the MDCV and CLL metadata OBUs */
    staticHDRMetadata: boolean
};

export type AV1HDR10PlusVector = {
    container: 'matroska' | 'mp4'
    fileName: string
    sampleEntry: 'av01' | null
};

export type AV1HDR10PlusExpectations = HDR10PlusVectorExpectations<AV1HDR10PlusVectorFrame, AV1HDR10PlusVector> & {
    contentLightLevel: {
        maximumContentLightLevel: number
        maximumFrameAverageLightLevel: number
    }
    masteringDisplay: {
        luminanceMax: number
        luminanceMin: number
    }
};

// Written by scripts/codec_vector_assets/generate_HDR10_plus_AV1_vectors.py
export const AV1_HDR10_PLUS_EXPECTATIONS = readHDR10PlusVectorExpectations<AV1HDR10PlusExpectations>(AV1_HDR10_PLUS_VECTOR_FOLDER_NAME);

// The engine reads it from the MDCV and CLL metadata OBUs of the key frames' units
export const AV1_HDR10_PLUS_STATIC_HDR_METADATA: StaticHDRMetadata = {
    masteringDisplayMaximumLuminanceNits: AV1_HDR10_PLUS_EXPECTATIONS.masteringDisplay.luminanceMax / MASTERING_MAXIMUM_LUMINANCE_SCALE,
    masteringDisplayMinimumLuminanceNits: AV1_HDR10_PLUS_EXPECTATIONS.masteringDisplay.luminanceMin / MASTERING_MINIMUM_LUMINANCE_SCALE,
    maximumContentLightLevelNits: AV1_HDR10_PLUS_EXPECTATIONS.contentLightLevel.maximumContentLightLevel,
    maximumFrameAverageLightLevelNits: AV1_HDR10_PLUS_EXPECTATIONS.contentLightLevel.maximumFrameAverageLightLevel
};

export function readAV1HDR10PlusVector(fileName: string): Uint8Array {
    return readHDR10PlusVectorFile(AV1_HDR10_PLUS_VECTOR_FOLDER_NAME, fileName);
}
