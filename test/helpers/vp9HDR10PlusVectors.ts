// The HDR10+ VP9 test vectors and the known answers their generator wrote

import {
    readHDR10PlusVectorExpectations,
    readHDR10PlusVectorFile,
    type HDR10PlusVectorExpectations,
    type HDR10PlusVectorFrame
} from './hdr10PlusVectors';

const VP9_HDR10_PLUS_VECTOR_FOLDER_NAME = 'hdr10plus-vp9';

export type VP9HDR10PlusVector = {
    blockAdditionMapping: boolean
    container: 'matroska' | 'webm'
    fileName: string
};

export type VP9HDR10PlusExpectations = HDR10PlusVectorExpectations<HDR10PlusVectorFrame, VP9HDR10PlusVector> & {
    /** The BlockAddID of every BlockAdditional, whose bytes are the frame's ITU-T T.35 message */
    blockAdditionID: number
};

// Written by scripts/codec_vector_assets/generate_HDR10_plus_VP9_vectors.py
export const VP9_HDR10_PLUS_EXPECTATIONS = readHDR10PlusVectorExpectations<VP9HDR10PlusExpectations>(VP9_HDR10_PLUS_VECTOR_FOLDER_NAME);

export function readVP9HDR10PlusVector(fileName: string): Uint8Array {
    return readHDR10PlusVectorFile(VP9_HDR10_PLUS_VECTOR_FOLDER_NAME, fileName);
}
