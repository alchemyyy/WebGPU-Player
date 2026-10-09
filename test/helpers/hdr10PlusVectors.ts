// HDR10+ test inputs: the ITU-T T.35 messages of the deterministic HEVC vectors, and the known answers the HDR10+ vector generators write

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect } from 'vitest';

import {
    createHDR10PlusHEVCVector,
    type HDR10PlusVectorKind
} from 'webgpu-player/capability/vectors/HDR10PlusVectors';
import {
    HDR10_PLUS_METADATA_SCHEMA_VERSION,
    type HDR10PlusFrameMetadata,
    type HDR10PlusMetadata
} from 'webgpu-player/video/hdr/HDR10PlusMetadata';
import { parseHEVCSEIMessages } from 'webgpu-player/video/hevc/HEVCSEI';

import { CODEC_VECTOR_ASSETS_DIRECTORY } from './enginePaths';

const USER_DATA_REGISTERED_ITU_T_T35_PAYLOAD_TYPE = 4;
const EXPECTATIONS_FILE_NAME = 'expectations.json';
// ST 2094-40 codes luminance in 0.1-nit units, knee points in 1/4095, and Bezier anchors in 1/1023
const LINEAR_LUMINANCE_SCALE = 10;
const KNEE_POINT_SCALE = 4_095;
const BEZIER_ANCHOR_SCALE = 1_023;

/** One frame's ST 2094-40 values, coded as the bitstream codes them. */
export type HDR10PlusCodedMetadata = {
    applicationVersion: number
    averageMaxRGB: number
    bezierCurve: {
        anchors: readonly number[]
        kneePointX: number
        kneePointY: number
    } | null
    distributionMaxRGB: ReadonlyArray<{ percentage: number, percentile: number }>
    fractionBrightPixels: number
    maxSCL: readonly [number, number, number]
    targetedSystemDisplayMaximumLuminance: number
    windowCount: number
};

/** One frame of a generated HDR10+ vector, as its expectations.json records it. */
export type HDR10PlusVectorFrame = {
    HDR10Plus: HDR10PlusCodedMetadata | null
    /** The frame's ITU-T T.35 message in hex, from its country code to its last payload byte */
    ITUTT35Message: string | null
    keyFrame: boolean
};

/** The fields every HDR10+ vector generator writes into its expectations.json. */
export type HDR10PlusVectorExpectations<Frame extends HDR10PlusVectorFrame, Vector> = {
    frameCount: number
    frameRate: number
    frames: readonly Frame[]
    height: number
    vectors: readonly Vector[]
    width: number
};

/** Returns the ITU-T T.35 messages of a deterministic HDR10+ HEVC vector's SEI, each from its country code on. */
export function getHDR10PlusITUTT35Messages(kind: HDR10PlusVectorKind): Uint8Array[] {
    const messages: Uint8Array[] = [];
    for (const message of parseHEVCSEIMessages(createHDR10PlusHEVCVector(kind), { kind: 'annex-b' })) {
        if (message.payloadType === USER_DATA_REGISTERED_ITU_T_T35_PAYLOAD_TYPE) {
            messages.push(message.payload.slice());
        }
    }
    return messages;
}

/** Reads the expectations.json a generator wrote into its folder of bin/codec_vector_assets/. */
export function readHDR10PlusVectorExpectations<Expectations>(folderName: string): Expectations {
    return JSON.parse(
        readFileSync(resolve(CODEC_VECTOR_ASSETS_DIRECTORY, folderName, EXPECTATIONS_FILE_NAME), 'utf8')
    ) as Expectations;
}

export function readHDR10PlusVectorFile(folderName: string, fileName: string): Uint8Array {
    return new Uint8Array(readFileSync(resolve(CODEC_VECTOR_ASSETS_DIRECTORY, folderName, fileName)));
}

/** Returns the metadata the engine's parser reads from a frame's coded values. */
export function toHDR10PlusMetadata(codedMetadata: HDR10PlusCodedMetadata): HDR10PlusMetadata {
    const curve = codedMetadata.bezierCurve;
    return {
        applicationVersion: codedMetadata.applicationVersion,
        averageMaxRGBNits: codedMetadata.averageMaxRGB / LINEAR_LUMINANCE_SCALE,
        distributionMaxRGB: codedMetadata.distributionMaxRGB.map(entry => ({
            percentage: entry.percentage,
            percentileNits: entry.percentile / LINEAR_LUMINANCE_SCALE
        })),
        maximumSCLNits: [
            codedMetadata.maxSCL[0] / LINEAR_LUMINANCE_SCALE,
            codedMetadata.maxSCL[1] / LINEAR_LUMINANCE_SCALE,
            codedMetadata.maxSCL[2] / LINEAR_LUMINANCE_SCALE
        ],
        schemaVersion: HDR10_PLUS_METADATA_SCHEMA_VERSION,
        targetedSystemDisplayMaximumLuminanceNits: codedMetadata.targetedSystemDisplayMaximumLuminance,
        toneMapping: curve ?
            {
                bezierCurveAnchors: curve.anchors.map(anchor => anchor / BEZIER_ANCHOR_SCALE),
                kneePointX: curve.kneePointX / KNEE_POINT_SCALE,
                kneePointY: curve.kneePointY / KNEE_POINT_SCALE
            } :
            null
    };
}

/**
 * Requires a decoded frame to carry the HDR10+ result its generator wrote: valid with the frame's values, or absent.
 * An absent frame's metadata is not compared, because a frame without HDR10+ of its own takes the last metadata before it.
 */
export function requirePostedHDR10PlusResult(
    actual: HDR10PlusFrameMetadata | null | undefined,
    frame: HDR10PlusVectorFrame
): void {
    if (frame.HDR10Plus) {
        expect(actual).toEqual({
            metadata: toHDR10PlusMetadata(frame.HDR10Plus),
            status: 'valid'
        });
        return;
    }
    expect(actual?.status).toBe('absent');
}
