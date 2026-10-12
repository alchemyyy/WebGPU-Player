import type { SupportedRawVideoFrameFormat } from '../RawVideoFrameCopy';

/** The planar formats a GPU decoder writes into a frame pool slot; a pool never holds semi-planar NV12. */
export type GPUDecoderOutputFormat = Exclude<SupportedRawVideoFrameFormat, 'NV12'>;

/** How one output format lays out its samples. */
export type GPUDecoderFormatFacts = {
    bitDepth: 8 | 10 | 12
    /** 1 for 8-bit samples, 2 for little-endian 16-bit samples holding their code in the low bits, as I420P10 does. */
    bytesPerSample: 1 | 2
    chromaHeightDivisor: 1 | 2
    chromaWidthDivisor: 1 | 2
};

/** The planes of every output format: luma, then the two chroma planes. */
export const GPU_DECODER_OUTPUT_PLANE_COUNT = 3;

/** Returns whether a format is one a GPU decoder can write. */
export function isGPUDecoderOutputFormat(format: string): format is GPUDecoderOutputFormat {
    switch (format) {
        case 'I420':
        case 'I420P10':
        case 'I420P12':
        case 'I422':
        case 'I422P10':
        case 'I422P12':
        case 'I444':
        case 'I444P10':
        case 'I444P12':
            return true;
        default:
            return false;
    }
}

function getChromaDivisors(format: GPUDecoderOutputFormat): Pick<GPUDecoderFormatFacts, 'chromaHeightDivisor' | 'chromaWidthDivisor'> {
    switch (format) {
        case 'I420':
        case 'I420P10':
        case 'I420P12':
            return { chromaHeightDivisor: 2, chromaWidthDivisor: 2 };
        case 'I422':
        case 'I422P10':
        case 'I422P12':
            return { chromaHeightDivisor: 1, chromaWidthDivisor: 2 };
        case 'I444':
        case 'I444P10':
        case 'I444P12':
            return { chromaHeightDivisor: 1, chromaWidthDivisor: 1 };
    }
}

function getBitDepth(format: GPUDecoderOutputFormat): GPUDecoderFormatFacts['bitDepth'] {
    switch (format) {
        case 'I420':
        case 'I422':
        case 'I444':
            return 8;
        case 'I420P10':
        case 'I422P10':
        case 'I444P10':
            return 10;
        case 'I420P12':
        case 'I422P12':
        case 'I444P12':
            return 12;
    }
}

/** Returns the bit depth, sample size, and chroma subsampling of an output format. */
export function getGPUDecoderFormatFacts(format: GPUDecoderOutputFormat): GPUDecoderFormatFacts {
    const bitDepth = getBitDepth(format);
    return {
        bitDepth,
        bytesPerSample: bitDepth === 8 ? 1 : 2,
        ...getChromaDivisors(format)
    };
}
