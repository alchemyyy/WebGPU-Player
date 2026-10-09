import {
    DOLBY_VISION_RPU_COMPONENT_FLAG_MMR,
    DOLBY_VISION_RPU_COMPONENT_FLAG_POLYNOMIAL,
    DOLBY_VISION_RPU_COMPONENT_WORD_OFFSET,
    DOLBY_VISION_RPU_COMPONENT_WORD_STRIDE,
    DOLBY_VISION_RPU_PACKED_COMPONENT_PIVOT_OFFSET,
    DOLBY_VISION_RPU_PACKED_COMPONENT_SEGMENT_OFFSET
} from 'webgpu-player/video/dolby-vision/DolbyVisionRPUDataLayout';
import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';

const BYTES_PER_PACKED_WORD = Uint32Array.BYTES_PER_ELEMENT;
const PACKED_SEGMENT_BYTE_LENGTH = 4 * Float32Array.BYTES_PER_ELEMENT;
const COMPONENT_FLAGS_BYTE_OFFSET = 2 * BYTES_PER_PACKED_WORD;

// The authorization vector's Cb component, split at its middle pivot into its MMR piece and a polynomial piece
export const MIXED_COMPONENT_INDEX = 1;
export const MIXED_COMPONENT_PIVOTS: readonly number[] = [ 0, 0.5, 1 ];
export const MIXED_COMPONENT_POLYNOMIAL: readonly number[] = [ 0.1, 0.5, 0.25 ];

export function getPackedComponentByteOffset(componentIndex: number): number {
    return (DOLBY_VISION_RPU_COMPONENT_WORD_OFFSET
        + (componentIndex * DOLBY_VISION_RPU_COMPONENT_WORD_STRIDE)) * BYTES_PER_PACKED_WORD;
}

/** Byte offset of one packed segment: [c0, c1, c2, 0] or [MMR constant, first vector, 0, MMR order]. */
export function getPackedSegmentByteOffset(componentIndex: number, segmentIndex: number): number {
    return getPackedComponentByteOffset(componentIndex)
        + DOLBY_VISION_RPU_PACKED_COMPONENT_SEGMENT_OFFSET
        + (segmentIndex * PACKED_SEGMENT_BYTE_LENGTH);
}

/** Byte offset of one component's flags word, one bit per mapping method its pieces use. */
export function getPackedComponentFlagsByteOffset(componentIndex: number): number {
    return getPackedComponentByteOffset(componentIndex) + COMPONENT_FLAGS_BYTE_OFFSET;
}

/** Builds a schema-valid snapshot whose Cb component mixes an MMR piece and a polynomial piece. */
export function createMixedDolbyVisionRPUVector(): ArrayBuffer {
    const packedData = createDolbyVisionAuthorizationRPUVector();
    const view = new DataView(packedData);
    const componentByteOffset = getPackedComponentByteOffset(MIXED_COMPONENT_INDEX);
    view.setUint32(componentByteOffset, MIXED_COMPONENT_PIVOTS.length, true);
    view.setUint32(
        getPackedComponentFlagsByteOffset(MIXED_COMPONENT_INDEX),
        DOLBY_VISION_RPU_COMPONENT_FLAG_POLYNOMIAL | DOLBY_VISION_RPU_COMPONENT_FLAG_MMR,
        true
    );
    MIXED_COMPONENT_PIVOTS.forEach((pivot, pivotIndex) => {
        view.setFloat32(
            componentByteOffset
                + DOLBY_VISION_RPU_PACKED_COMPONENT_PIVOT_OFFSET
                + (pivotIndex * Float32Array.BYTES_PER_ELEMENT),
            pivot,
            true
        );
    });
    // The first segment keeps the vector's order-3 MMR piece; the second leaves its order zero
    const polynomialSegmentByteOffset = getPackedSegmentByteOffset(MIXED_COMPONENT_INDEX, 1);
    MIXED_COMPONENT_POLYNOMIAL.forEach((coefficient, coefficientIndex) => {
        view.setFloat32(
            polynomialSegmentByteOffset + (coefficientIndex * Float32Array.BYTES_PER_ELEMENT),
            coefficient,
            true
        );
    });
    return packedData;
}
