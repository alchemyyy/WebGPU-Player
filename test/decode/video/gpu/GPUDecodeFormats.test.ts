import { describe, expect, it } from 'vitest';

import {
    getGPUDecoderFormatFacts,
    getGPUDecoderPixelFormatHolding,
    GPU_DECODER_OUTPUT_FORMATS,
    isGPUDecoderOutputFormat,
    type GPUDecoderOutputFormat
} from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';

// FFmpeg's planar YUV and monochrome pixel formats, the output format holding each, and the depth of its own samples, both byte orders of the deeper ones included;
// a 4:0:0 stream takes the 4:2:0 format of its depth
const PIXEL_FORMAT_HOLDINGS: ReadonlyArray<readonly [ string, GPUDecoderOutputFormat, number ]> = [
    [ 'gray', 'I420', 8 ],
    [ 'gray9le', 'I420P10', 9 ],
    [ 'gray10le', 'I420P10', 10 ],
    [ 'gray10be', 'I420P10', 10 ],
    [ 'gray12le', 'I420P12', 12 ],
    [ 'yuv420p', 'I420', 8 ],
    [ 'yuvj420p', 'I420', 8 ],
    [ 'yuv420p9le', 'I420P10', 9 ],
    [ 'yuv420p10le', 'I420P10', 10 ],
    [ 'yuv420p10be', 'I420P10', 10 ],
    [ 'yuv420p12le', 'I420P12', 12 ],
    [ 'yuv422p', 'I422', 8 ],
    [ 'yuvj422p', 'I422', 8 ],
    [ 'yuv422p9be', 'I422P10', 9 ],
    [ 'yuv422p10le', 'I422P10', 10 ],
    [ 'yuv422p12le', 'I422P12', 12 ],
    [ 'yuv444p', 'I444', 8 ],
    [ 'yuvj444p', 'I444', 8 ],
    [ 'yuv444p9le', 'I444P10', 9 ],
    [ 'yuv444p10le', 'I444P10', 10 ],
    [ 'yuv444p12be', 'I444P12', 12 ]
];
// Pixel formats no frame pool holds: RGB, monochrome with alpha, 4:1:1, 4:4:0, and depths no output format has
const UNHELD_PIXEL_FORMATS: readonly string[] = [ 'rgb24', 'gbrp', 'ya8', 'yuv411p', 'yuv440p', 'yuv420p16le', 'gray16le', '' ];
const PADDED_PIXEL_FORMAT = ' YUV422P ';

describe('GPUDecodeFormats', () => {
    it.each(PIXEL_FORMAT_HOLDINGS)('holds pixel format %s in %s, its samples %i bits', (pixelFormat: string, format: GPUDecoderOutputFormat, sampleBitDepth: number) => {
        expect(getGPUDecoderPixelFormatHolding(pixelFormat)).toEqual({ format, sampleBitDepth });
    });

    it('reads a pixel format whatever its case and surrounding space', () => {
        expect(getGPUDecoderPixelFormatHolding(PADDED_PIXEL_FORMAT)?.format).toBe('I422');
    });

    it.each(UNHELD_PIXEL_FORMATS)('holds no %s', (pixelFormat: string) => {
        expect(getGPUDecoderPixelFormatHolding(pixelFormat)).toBeNull();
    });

    it('knows the facts of every output format it lists', () => {
        for (const format of GPU_DECODER_OUTPUT_FORMATS) {
            expect(isGPUDecoderOutputFormat(format)).toBe(true);
            expect(getGPUDecoderFormatFacts(format).bytesPerSample).toBe(getGPUDecoderFormatFacts(format).bitDepth === 8 ? 1 : 2);
        }
        expect(isGPUDecoderOutputFormat('NV12')).toBe(false);
    });
});
