import { describe, expect, it } from 'vitest';

import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type InputColorMetadata
} from 'webgpu-player/color/ColorMetadata';
import { createRawYUVColorPipelineWGSL, type RawYUVVideoFrameFormat } from 'webgpu-player/color/ColorPipelineShader';
import { createEngineStructsWGSL } from 'webgpu-player/presentation/passes/PassResources';
import { createDefaultRenderSettings, createHDRToSDRRenderSettings } from 'webgpu-player/presentation/RenderSettings';
import { createFramePoolSignal, FRAME_POOL_SIGNAL_ENTRY_POINT } from 'webgpu-player/video/gpu-decode/FramePoolSignal';

const TWELVE_BIT_DEPTH = 12;

type SignalCase = {
    format: RawYUVVideoFrameFormat
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

function createRawPlaneShader(signalCase: SignalCase): string {
    const settings = signalCase.metadata.transfer === 'sdr' ? createDefaultRenderSettings() : createHDRToSDRRenderSettings();
    return createRawYUVColorPipelineWGSL(signalCase.metadata, settings, signalCase.format);
}

/** Rewrites the raw plane shader's luma sampler in terms of the frame pool's plane layout and sample loads. */
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

    it.each(SIGNAL_CASES)('normalizes and converts $format with the raw plane shader math', (signalCase: SignalCase) => {
        const rawShader = createRawPlaneShader(signalCase);
        const signal = createFramePoolSignal(signalCase.format, signalCase.metadata);

        expect(extractFunction(signal.code, 'framePoolNormalizeYUV')).toBe(extractFunction(rawShader, 'normalizeRawYUV'));
        expect(extractFunction(signal.code, 'framePoolConvertYUVToEncodedRGB')).toBe(
            extractFunction(rawShader, 'convertRawYUVToEncodedRGB')
        );
    });

    it.each(SIGNAL_CASES)('samples $format bilinearly with the raw plane shader chroma siting', (signalCase: SignalCase) => {
        const rawShader = createRawPlaneShader(signalCase);
        const signal = createFramePoolSignal(signalCase.format, signalCase.metadata);

        expect(extractFunction(signal.code, 'framePoolSamplePlane')).toBe(
            rewriteRawLumaSamplerForPool(extractFunction(rawShader, 'sampleLuma'))
        );
        const rawPlaneSampling = extractFunction(rawShader, 'sampleRawYUV')
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
