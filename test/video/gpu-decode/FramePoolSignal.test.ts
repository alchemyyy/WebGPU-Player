import { describe, expect, it } from 'vitest';

import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type InputColorMetadata
} from 'webgpu-player/color/ColorMetadata';
import { createRawYUVSignal } from 'webgpu-player/presentation/passes/builtin/BuiltinSignals';
import { createEngineStructsWGSL } from 'webgpu-player/presentation/passes/PassResources';
import { createFramePoolSignal, FRAME_POOL_SIGNAL_ENTRY_POINT } from 'webgpu-player/video/gpu-decode/FramePoolSignal';
import type { GPUDecoderOutputFormat } from 'webgpu-player/video/gpu-decode/GPUDecodeFormats';

const TWELVE_BIT_DEPTH = 12;
const FRAME_POOL_SIGNAL_NAME = 'gpu-decode.signal.frame-pool.I420P10';

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

    it.each(SIGNAL_CASES)('converts $format with the raw YUV signal\'s range, matrix, and entry', (signalCase: SignalCase) => {
        const rawSignal = createRawYUVSignal(signalCase.format, signalCase.metadata);
        const signal = createFramePoolSignal(signalCase.format, signalCase.metadata);

        expect(extractFunction(signal.code, 'normalizeRawYUV')).toBe(extractFunction(rawSignal.code, 'normalizeRawYUV'));
        expect(extractFunction(signal.code, 'convertRawYUVToEncodedRGB')).toBe(extractFunction(rawSignal.code, 'convertRawYUVToEncodedRGB'));
        expect(extractFunction(signal.code, signal.entryPoint).replace('framePoolSampleYUV(', 'sampleRawYUV(')).toBe(
            extractFunction(rawSignal.code, rawSignal.entryPoint)
        );
    });

    it.each(SIGNAL_CASES)('samples $format bilinearly with the raw YUV signal\'s chroma siting', (signalCase: SignalCase) => {
        const rawSignal = createRawYUVSignal(signalCase.format, signalCase.metadata);
        const signal = createFramePoolSignal(signalCase.format, signalCase.metadata);

        expect(extractFunction(signal.code, 'framePoolSamplePlane')).toBe(
            rewriteRawLumaSamplerForPool(extractFunction(rawSignal.code, 'sampleLuma'))
        );
        const rawPlaneSampling = extractFunction(rawSignal.code, 'sampleRawYUV')
            .replace('sampleLuma(', 'framePoolSamplePlane(0u, ')
            .replace(/sampleChromaU\(/g, 'framePoolSamplePlane(1u, ')
            .replace(/sampleChromaV\(/g, 'framePoolSamplePlane(2u, ')
            .replace(/f32\(textureDimensions\(lumaTexture\)\.x\)/g, 'f32(framePoolLayout.planes[0].width)');
        expect(extractFunction(signal.code, 'framePoolSampleYUV')).toBe(rawPlaneSampling);
    });

    it('loads 8-bit samples as bytes and high bit depths as 16-bit words', () => {
        const eightBitLoad = extractFunction(createFramePoolSignal('I420', createSDRColorMetadata()).code, 'framePoolLoadSample');
        const sixteenBitLoad = extractFunction(createFramePoolSignal('I420P10', createPQColorMetadata()).code, 'framePoolLoadSample');

        expect(eightBitLoad).toContain('u32(position.x) * 1u');
        expect(eightBitLoad).toContain('& 0xFFu');
        expect(sixteenBitLoad).toContain('u32(position.x) * 2u');
        expect(sixteenBitLoad).toContain('& 0xFFFFu');
    });

    it('rejects a semi-planar format, a mismatched bit depth, and invalid metadata', () => {
        expect(() => createFramePoolSignal('NV12', createSDRColorMetadata())).toThrow('A frame pool never holds NV12');
        expect(() => createFramePoolSignal('I420', createPQColorMetadata())).toThrow('bit depth does not match');
        expect(() => createFramePoolSignal('I420', { ...createSDRColorMetadata(), range: 'studio' as 'limited' })).toThrow(
            "range: unsupported 'studio'"
        );
    });
});
