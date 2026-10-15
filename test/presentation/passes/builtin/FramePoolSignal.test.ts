import { describe, expect, it } from 'vitest';

import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type InputColorMetadata
} from 'webgpu-player/color/ColorMetadata';
import { createRawYUVRangeWGSL, createRawYUVSignal, createSelectedBitDepthRawYUVRangeWGSL } from 'webgpu-player/presentation/passes/builtin/BuiltinSignals';
import { createEngineStructsWGSL } from 'webgpu-player/presentation/passes/PassResources';
import { createFramePoolSignal, FRAME_POOL_SIGNAL_ENTRY_POINT } from 'webgpu-player/presentation/passes/builtin/FramePoolSignal';
import { GPU_DECODER_OUTPUT_BIT_DEPTHS, type GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';

const TWELVE_BIT_DEPTH = 12;
const EIGHT_BIT_DEPTH = 8;
// createPQColorMetadata's default bit depth
const PQ_BIT_DEPTH = 10;
const SEMI_PLANAR_FORMAT = 'NV12';
const UNSUPPORTED_RANGE = 'studio';
const FRAME_POOL_SIGNAL_NAME = 'gpu-decode.signal.frame-pool.I420P10';
// The slot's bit depth, which the signal normalizes each frame's codes by
const SLOT_BIT_DEPTH_EXPRESSION = 'framePoolLayout.bitDepth';
const SIGNAL_RANGES = [ 'limited', 'full' ] as const;

type SignalCase = {
    format: GPUDecoderOutputFormat
    metadata: InputColorMetadata
};

const SIGNAL_CASES: readonly SignalCase[] = [
    { format: 'I420', metadata: createSDRColorMetadata() },
    { format: 'I420', metadata: createSDRColorMetadata({ matrix: 'smpte170m', primaries: 'smpte170m', range: 'full' }) },
    { format: 'I422', metadata: createSDRColorMetadata({ matrix: 'bt470bg', primaries: 'bt470bg' }) },
    { format: 'I420P10', metadata: createPQColorMetadata() },
    { format: 'I422P10', metadata: createHLGColorMetadata({ range: 'full' }) },
    { format: 'I444P12', metadata: createPQColorMetadata({ bitDepth: TWELVE_BIT_DEPTH }) },
    { format: 'I444', metadata: createSDRColorMetadata() }
];

/** Returns a WGSL function's parameter list and body, which begin at its name. */
function extractFunction(code: string, functionName: string): string {
    const start = code.indexOf(`fn ${functionName}(`);
    if (start < 0) {
        throw new Error(`The code declares no function ${functionName}`);
    }
    const end = code.indexOf('\n}', start);
    return code.slice(start + `fn ${functionName}`.length, end + 2);
}

/** Returns WGSL with each run of whitespace collapsed to one space, so code at different indentations compares equal. */
function collapseWhitespace(code: string): string {
    return code.replace(/\s+/g, ' ').trim();
}

/** Rewrites the raw YUV signal's luma sampler in terms of the frame pool's plane layout and sample loads. */
function rewriteRawLumaSamplerForPool(rawSampler: string): string {
    return rawSampler
        .replace('(textureCoordinate: vec2f) -> f32 {', '(planeIndex: u32, textureCoordinate: vec2f) -> f32 {\n    let plane = framePoolLayout.planes[planeIndex];')
        .replace('vec2f(textureDimensions(lumaTexture))', 'vec2f(f32(plane.width), f32(plane.height))')
        .replace('vec2i(textureDimensions(lumaTexture))', 'vec2i(i32(plane.width), i32(plane.height))')
        .replace(/f32\(textureLoad\(lumaTexture, (.+), 0\)\.r\)/g, 'framePoolLoadSample(planeIndex, $1)');
}

describe('createFramePoolSignal', () => {
    it('describes a frame pool signal that binds only the frame pool resource', () => {
        const signal = createFramePoolSignal('I420P10', createPQColorMetadata());

        expect(signal.entryPoint).toBe(FRAME_POOL_SIGNAL_ENTRY_POINT);
        expect(signal.name).toBe(FRAME_POOL_SIGNAL_NAME);
        expect(signal.sourceKind).toBe('frame-pool');
        expect(signal.resources).toEqual([ 'frame-pool' ]);
        expect(signal.bypassCondition).toBeNull();
        expect(signal.code).toContain(`fn ${FRAME_POOL_SIGNAL_ENTRY_POINT}(coordinate: vec2f) -> vec4f {`);
        expect(signal.code).not.toMatch(/@(group|binding)|texture_|textureLoad|textureDimensions/);
    });

    it('reads only fields of the layout uniform PassResources declares', () => {
        const layoutStruct = createEngineStructsWGSL([ 'frame-pool-layout' ]);
        const signal = createFramePoolSignal('I422P10', createPQColorMetadata());

        const layoutFields = [ ...signal.code.matchAll(/framePoolLayout\.(\w+)/g) ].map(match => match[1]);
        const planeFields = [ ...signal.code.matchAll(/plane\.(\w+)/g) ].map(match => match[1]);
        for (const field of [ ...layoutFields, ...planeFields ]) {
            expect(layoutStruct).toMatch(new RegExp(String.raw`\b${field}: `));
        }
        expect(signal.code).toMatch(/\bframePool\[/);
    });

    it.each(SIGNAL_CASES)('converts $format with the raw YUV signal\'s matrix and entry, and its range at the slot\'s bit depth', (signalCase: SignalCase) => {
        const rawSignal = createRawYUVSignal(signalCase.format, signalCase.metadata);
        const signal = createFramePoolSignal(signalCase.format, signalCase.metadata);

        expect(extractFunction(signal.code, 'normalizeRawYUV')).toBe(
            extractFunction(createSelectedBitDepthRawYUVRangeWGSL(signalCase.metadata, GPU_DECODER_OUTPUT_BIT_DEPTHS, SLOT_BIT_DEPTH_EXPRESSION), 'normalizeRawYUV')
        );
        expect(extractFunction(signal.code, 'convertRawYUVToEncodedRGB')).toBe(extractFunction(rawSignal.code, 'convertRawYUVToEncodedRGB'));
        expect(extractFunction(signal.code, signal.entryPoint).replace('framePoolSampleYUV(', 'sampleRawYUV(')).toBe(
            extractFunction(rawSignal.code, rawSignal.entryPoint)
        );
    });

    it.each(SIGNAL_CASES)('samples $format bilinearly as the raw YUV signal samples its luma', (signalCase: SignalCase) => {
        const rawSignal = createRawYUVSignal(signalCase.format, signalCase.metadata);
        const signal = createFramePoolSignal(signalCase.format, signalCase.metadata);

        expect(extractFunction(signal.code, 'framePoolSamplePlane')).toBe(
            rewriteRawLumaSamplerForPool(extractFunction(rawSignal.code, 'sampleLuma'))
        );
    });

    it('reads each frame\'s sample size, bit depth, and chroma subsampling from its slot, so every format of a range and matrix shares one signal', () => {
        const eightBit420 = createFramePoolSignal('I420', createSDRColorMetadata());
        const twelveBit444 = createFramePoolSignal('I444P12', createSDRColorMetadata({ bitDepth: TWELVE_BIT_DEPTH }));

        expect(twelveBit444.code).toBe(eightBit420.code);
        const load = extractFunction(eightBit420.code, 'framePoolLoadSample');
        expect(load).toContain('u32(position.x) * bytesPerSample');
        expect(load).toContain('select(0xFFFFu, 0xFFu, bytesPerSample == 1u)');
        expect(extractFunction(eightBit420.code, 'normalizeRawYUV')).toContain(SLOT_BIT_DEPTH_EXPRESSION);
        // Chroma subsampled across sits left, as the raw YUV signal sites 4:2:0 and 4:2:2, and full chroma is co-sited
        expect(extractFunction(eightBit420.code, 'framePoolSampleYUV')).toContain('framePoolLayout.planes[1].width < lumaWidth');
    });

    it.each(GPU_DECODER_OUTPUT_BIT_DEPTHS)('normalizes %i-bit codes with the arithmetic of a raw YUV signal compiled for that depth', (bitDepth: number) => {
        const lastBitDepth = GPU_DECODER_OUTPUT_BIT_DEPTHS[GPU_DECODER_OUTPUT_BIT_DEPTHS.length - 1];
        const selector = bitDepth === lastBitDepth ? 'default' : `case ${bitDepth}u`;
        for (const range of SIGNAL_RANGES) {
            const signal = createFramePoolSignal('I420', createSDRColorMetadata({ range }));
            const compiledFunction = extractFunction(createRawYUVRangeWGSL(createSDRColorMetadata({ bitDepth, range })), 'normalizeRawYUV');
            const compiledExpression = compiledFunction.slice(compiledFunction.indexOf('return '), compiledFunction.lastIndexOf(';') + 1);

            expect(collapseWhitespace(extractFunction(signal.code, 'normalizeRawYUV'))).toContain(`${selector}: { ${collapseWhitespace(compiledExpression)} }`);
        }
    });

    it('rejects a semi-planar format, a mismatched bit depth, and invalid metadata with the failing value', () => {
        expect(() => createFramePoolSignal(SEMI_PLANAR_FORMAT, createSDRColorMetadata())).toThrow(`format: unsupported '${SEMI_PLANAR_FORMAT}'`);
        expect(() => createFramePoolSignal('I420', createPQColorMetadata())).toThrow(`bitDepth: ${PQ_BIT_DEPTH}, expected ${EIGHT_BIT_DEPTH} for I420`);
        expect(() => createFramePoolSignal('I420', { ...createSDRColorMetadata(), range: UNSUPPORTED_RANGE as 'limited' })).toThrow(
            `range: unsupported '${UNSUPPORTED_RANGE}'`
        );
    });
});
