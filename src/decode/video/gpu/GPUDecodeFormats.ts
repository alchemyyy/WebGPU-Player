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

/** Every format a GPU decoder can write, 4:2:0 first, then by bit depth. */
export const GPU_DECODER_OUTPUT_FORMATS: readonly GPUDecoderOutputFormat[] = Object.freeze([
    'I420',
    'I420P10',
    'I420P12',
    'I422',
    'I422P10',
    'I422P12',
    'I444',
    'I444P10',
    'I444P12'
]);

/** How an output format holds a stream's pixel format: the format, and the depth of the pixel format's own samples, which a decoder shifts up to the format's. */
export type GPUDecoderPixelFormatHolding = Readonly<{
    format: GPUDecoderOutputFormat
    sampleBitDepth: number
}>;

function holdPixelFormat(format: GPUDecoderOutputFormat, sampleBitDepth: number): GPUDecoderPixelFormatHolding {
    return Object.freeze({ format, sampleBitDepth });
}

// FFmpeg's monochrome pixel formats, as stream metadata names them: a 4:0:0 stream takes the 4:2:0 format of its depth,
// whose chroma planes a decoder fills with the neutral value
const GPU_DECODER_MONOCHROME_PIXEL_FORMAT_HOLDINGS: ReadonlyArray<readonly [ string, GPUDecoderPixelFormatHolding ]> = [
    [ 'gray', holdPixelFormat('I420', 8) ],
    [ 'gray9le', holdPixelFormat('I420P10', 9) ],
    [ 'gray9be', holdPixelFormat('I420P10', 9) ],
    [ 'gray10le', holdPixelFormat('I420P10', 10) ],
    [ 'gray10be', holdPixelFormat('I420P10', 10) ],
    [ 'gray12le', holdPixelFormat('I420P12', 12) ],
    [ 'gray12be', holdPixelFormat('I420P12', 12) ]
];
const GPU_DECODER_MONOCHROME_PIXEL_FORMATS: ReadonlySet<string> = new Set<string>(
    GPU_DECODER_MONOCHROME_PIXEL_FORMAT_HOLDINGS.map(([ pixelFormat ]: readonly [ string, GPUDecoderPixelFormatHolding ]): string => pixelFormat)
);

// FFmpeg's planar YUV and monochrome pixel formats by how an output format holds them;
// a yuvj format differs only in its range, and 9-bit samples take the 10-bit format, shifted up as FFmpeg's converter shifts them
const GPU_DECODER_PIXEL_FORMAT_HOLDINGS: ReadonlyMap<string, GPUDecoderPixelFormatHolding> = new Map<string, GPUDecoderPixelFormatHolding>([
    ...GPU_DECODER_MONOCHROME_PIXEL_FORMAT_HOLDINGS,
    [ 'yuv420p', holdPixelFormat('I420', 8) ],
    [ 'yuvj420p', holdPixelFormat('I420', 8) ],
    [ 'yuv420p9le', holdPixelFormat('I420P10', 9) ],
    [ 'yuv420p9be', holdPixelFormat('I420P10', 9) ],
    [ 'yuv420p10le', holdPixelFormat('I420P10', 10) ],
    [ 'yuv420p10be', holdPixelFormat('I420P10', 10) ],
    [ 'yuv420p12le', holdPixelFormat('I420P12', 12) ],
    [ 'yuv420p12be', holdPixelFormat('I420P12', 12) ],
    [ 'yuv422p', holdPixelFormat('I422', 8) ],
    [ 'yuvj422p', holdPixelFormat('I422', 8) ],
    [ 'yuv422p9le', holdPixelFormat('I422P10', 9) ],
    [ 'yuv422p9be', holdPixelFormat('I422P10', 9) ],
    [ 'yuv422p10le', holdPixelFormat('I422P10', 10) ],
    [ 'yuv422p10be', holdPixelFormat('I422P10', 10) ],
    [ 'yuv422p12le', holdPixelFormat('I422P12', 12) ],
    [ 'yuv422p12be', holdPixelFormat('I422P12', 12) ],
    [ 'yuv444p', holdPixelFormat('I444', 8) ],
    [ 'yuvj444p', holdPixelFormat('I444', 8) ],
    [ 'yuv444p9le', holdPixelFormat('I444P10', 9) ],
    [ 'yuv444p9be', holdPixelFormat('I444P10', 9) ],
    [ 'yuv444p10le', holdPixelFormat('I444P10', 10) ],
    [ 'yuv444p10be', holdPixelFormat('I444P10', 10) ],
    [ 'yuv444p12le', holdPixelFormat('I444P12', 12) ],
    [ 'yuv444p12be', holdPixelFormat('I444P12', 12) ]
]);

/** Returns how an output format holds a stream's FFmpeg pixel format, such as I422 for yuv422p, or null for one no output format holds. */
export function getGPUDecoderPixelFormatHolding(pixelFormat: string): GPUDecoderPixelFormatHolding | null {
    return GPU_DECODER_PIXEL_FORMAT_HOLDINGS.get(pixelFormat.trim().toLowerCase()) ?? null;
}

/** Returns whether an FFmpeg pixel format is a monochrome one an output format holds, such as gray10le in I420P10. */
export function isGPUDecoderMonochromePixelFormat(pixelFormat: string): boolean {
    return GPU_DECODER_MONOCHROME_PIXEL_FORMATS.has(pixelFormat.trim().toLowerCase());
}

// The chroma formats as chroma_format_idc counts them, and the output formats of each at 8, 10, and 12 bits; 4:0:0 decodes into 4:2:0
const MONOCHROME_CHROMA_FORMAT = 0;
const OUTPUT_FORMATS_BY_CHROMA_FORMAT: ReadonlyMap<number, readonly GPUDecoderOutputFormat[]> = new Map<number, readonly GPUDecoderOutputFormat[]>([
    [ MONOCHROME_CHROMA_FORMAT, [ 'I420', 'I420P10', 'I420P12' ] ],
    [ 1, [ 'I420', 'I420P10', 'I420P12' ] ],
    [ 2, [ 'I422', 'I422P10', 'I422P12' ] ],
    [ 3, [ 'I444', 'I444P10', 'I444P12' ] ]
]);
/** The bit depths of the output formats, in the order each chroma format's formats list them. */
export const GPU_DECODER_OUTPUT_BIT_DEPTHS: readonly number[] = Object.freeze([ 8, 10, 12 ]);

/**
 * Returns the output format of a chroma format, as chroma_format_idc counts it, 0 for 4:0:0, which decodes into 4:2:0, and a bit depth;
 * null for one no output format holds.
 */
export function findGPUDecoderOutputFormat(chromaFormat: number, bitDepth: number): GPUDecoderOutputFormat | null {
    const formats = OUTPUT_FORMATS_BY_CHROMA_FORMAT.get(chromaFormat);
    const depthIndex = GPU_DECODER_OUTPUT_BIT_DEPTHS.indexOf(bitDepth);
    return formats && depthIndex >= 0 ? formats[depthIndex] : null;
}

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
