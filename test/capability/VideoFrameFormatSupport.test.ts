import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as VideoFrameFormatSupport from '../../src/capability/VideoFrameFormatSupport';
import type { CustomDecodeRawVideoFrameFormat } from '../../src/pipeline/DecodeWorkerProtocol';

const FORMATS: readonly CustomDecodeRawVideoFrameFormat[] = [
    'I420', 'I420P10', 'I420P12', 'I422', 'I422P10', 'I422P12', 'I444', 'I444P10', 'I444P12'
];

type Module = typeof VideoFrameFormatSupport;

async function loadModule(): Promise<Module> {
    vi.resetModules();
    return import('../../src/capability/VideoFrameFormatSupport');
}

function stubVideoFrame(onConstruct: (data: BufferSource, init: VideoFrameBufferInit) => void) {
    const close = vi.fn();
    const construct = vi.fn(function (this: { close: () => void }, data: BufferSource, init: VideoFrameBufferInit) {
        onConstruct(data, init);
        this.close = close;
    });
    vi.stubGlobal('VideoFrame', construct);
    return { close, construct };
}

describe('canHoldVideoFrameFormat', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('reads unsupported when the format enum lacks the value', async () => {
        stubVideoFrame(() => {
            throw new TypeError('bad enum');
        });
        const { canHoldVideoFrameFormat } = await loadModule();
        expect(canHoldVideoFrameFormat('I420P10')).toBe(false);
    });

    it.each([
        new DOMException('nope', 'NotSupportedError'),
        new RangeError('range')
    ])('stays inconclusive (supported) on %s', async (error) => {
        stubVideoFrame(() => {
            throw error;
        });
        const { canHoldVideoFrameFormat } = await loadModule();
        expect(canHoldVideoFrameFormat('I420P10')).toBe(true);
    });

    it('closes the frame it constructs and reads supported', async () => {
        const { close, construct } = stubVideoFrame(() => undefined);
        const { canHoldVideoFrameFormat } = await loadModule();
        expect(canHoldVideoFrameFormat('I444P12')).toBe(true);
        expect(construct).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('passes at least the format\'s bytes at the probe size', async () => {
        const seen: { byteLength: number, init: VideoFrameBufferInit }[] = [];
        stubVideoFrame((data, init) => {
            seen.push({ byteLength: data.byteLength, init });
        });
        const { canHoldVideoFrameFormat, getVideoFrameFormatByteLength } = await loadModule();
        for (const format of FORMATS) {
            expect(canHoldVideoFrameFormat(format)).toBe(true);
        }
        expect(seen).toHaveLength(FORMATS.length);
        seen.forEach(({ byteLength, init }, index) => {
            const format = FORMATS[index];
            expect(init.format).toBe(format);
            const width = init.codedWidth;
            const height = init.codedHeight;
            const bytesPerComponent = format.includes('P1') ? 2 : 1;
            const chromaWidth = format.startsWith('I444') ? width : Math.ceil(width / 2);
            const chromaHeight = format.startsWith('I420') ? Math.ceil(height / 2) : height;
            const expected = (width * height + 2 * chromaWidth * chromaHeight) * bytesPerComponent;
            expect(byteLength).toBeGreaterThanOrEqual(expected);
            expect(getVideoFrameFormatByteLength(format, width, height)).toBe(expected);
        });
    });

    it('constructs once per format', async () => {
        const { construct } = stubVideoFrame(() => {
            throw new TypeError('bad enum');
        });
        const { canHoldVideoFrameFormat } = await loadModule();
        expect(canHoldVideoFrameFormat('I420P10')).toBe(false);
        expect(canHoldVideoFrameFormat('I420P10')).toBe(false);
        expect(canHoldVideoFrameFormat('I420P12')).toBe(false);
        expect(construct).toHaveBeenCalledTimes(2);
    });

    it('reads unsupported without VideoFrame', async () => {
        vi.stubGlobal('VideoFrame', undefined);
        const { canHoldVideoFrameFormat } = await loadModule();
        expect(canHoldVideoFrameFormat('I420')).toBe(false);
    });
});
