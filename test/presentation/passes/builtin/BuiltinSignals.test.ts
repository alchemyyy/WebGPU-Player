import { describe, expect, it } from 'vitest';

import { createPQColorMetadata, createSDRColorMetadata } from 'webgpu-player/color/ColorMetadata';
import { CHROMA_LOCATIONS, type ChromaLocation } from 'webgpu-player/demux/VideoChromaFormat';
import {
    createExternalHDRSignal,
    createExternalIdentitySignal,
    createRawDolbyVisionSignal,
    createRawYUVSignal,
    DEFAULT_CHROMA_LOCATION,
    getChromaLumaShift,
    getChromaPlaneOffset,
    INTERLACED_SIGNAL_CONDITION
} from 'webgpu-player/presentation/passes/builtin/BuiltinSignals';
import { toWGSLFloat } from 'webgpu-player/presentation/passes/builtin/BuiltinWGSL';
import type { SignalPlanes } from 'webgpu-player/presentation/passes/PassTypes';

const HALF_LUMA_SAMPLE = 0.5;
const QUARTER_CHROMA_SAMPLE = 0.25;
// H.273's chroma sample locations, each site from its 4:2:0 texel's center in luma samples, positive left and up
const LOCATION_LUMA_SHIFTS: Readonly<Record<ChromaLocation, readonly [number, number]>> = {
    bottom: [ 0, -HALF_LUMA_SAMPLE ],
    'bottom-left': [ HALF_LUMA_SAMPLE, -HALF_LUMA_SAMPLE ],
    center: [ 0, 0 ],
    left: [ HALF_LUMA_SAMPLE, 0 ],
    top: [ 0, HALF_LUMA_SAMPLE ],
    'top-left': [ HALF_LUMA_SAMPLE, HALF_LUMA_SAMPLE ]
};
const DIVISORS_420: Pick<SignalPlanes, 'chromaHeightDivisor' | 'chromaWidthDivisor'> = { chromaHeightDivisor: 2, chromaWidthDivisor: 2 };
const DIVISORS_422: Pick<SignalPlanes, 'chromaHeightDivisor' | 'chromaWidthDivisor'> = { chromaHeightDivisor: 1, chromaWidthDivisor: 2 };
const DIVISORS_444: Pick<SignalPlanes, 'chromaHeightDivisor' | 'chromaWidthDivisor'> = { chromaHeightDivisor: 1, chromaWidthDivisor: 1 };
const DECLARED_CHROMA_LOCATION: ChromaLocation = 'top-left';
const DECLARED_CHROMA_SUBSAMPLING = '4:2:0';
const DOLBY_VISION_FORMAT = 'I420P10';
const SINGLE_LAYER_DOLBY_VISION_PROFILE = 8;
// The raw signals' chroma reads at the texel center, half a luma sample right, and half a sample right and down
const UNSHIFTED_COORDINATE = 'textureCoordinate';
const RIGHT_SHIFTED_COORDINATE = `textureCoordinate + vec2f(${toWGSLFloat(HALF_LUMA_SAMPLE)} / f32(textureDimensions(lumaTexture).x), 0.0)`;
const RIGHT_AND_DOWN_SHIFTED_COORDINATE = `textureCoordinate + vec2f(${toWGSLFloat(HALF_LUMA_SAMPLE)} / f32(textureDimensions(lumaTexture).x), `
    + `${toWGSLFloat(HALF_LUMA_SAMPLE)} / f32(textureDimensions(lumaTexture).y))`;
const UP_SHIFTED_COORDINATE = `textureCoordinate + vec2f(0.0, ${toWGSLFloat(-HALF_LUMA_SAMPLE)} / f32(textureDimensions(lumaTexture).y))`;

/** Returns a WGSL function's parameter list and body, which begin at its name. */
function extractFunction(code: string, functionName: string): string {
    const start = code.indexOf(`fn ${functionName}(`);
    if (start < 0) {
        throw new Error(`The code declares no function ${functionName}`);
    }
    return code.slice(start + `fn ${functionName}`.length, code.indexOf('\n}', start) + 2);
}

function requirePlanes(planes: SignalPlanes | null): SignalPlanes {
    if (planes === null) {
        throw new Error('The signal has no planes');
    }
    return planes;
}

describe('chroma siting', () => {
    it.each(CHROMA_LOCATIONS)('places 4:2:0 chroma at the %s location', (location: ChromaLocation) => {
        expect(getChromaLumaShift(location, DIVISORS_420)).toEqual(LOCATION_LUMA_SHIFTS[location]);
        const [ horizontalShift, verticalShift ] = LOCATION_LUMA_SHIFTS[location];
        expect(getChromaPlaneOffset(location, DIVISORS_420)).toEqual([ horizontalShift / 2, verticalShift / 2 ]);
    });

    it.each(CHROMA_LOCATIONS)('places 4:2:2 chroma on its left luma column and 4:4:4 chroma on its luma samples at the %s location', (location: ChromaLocation) => {
        expect(getChromaLumaShift(location, DIVISORS_422)).toEqual([ HALF_LUMA_SAMPLE, 0 ]);
        expect(getChromaPlaneOffset(location, DIVISORS_422)).toEqual([ QUARTER_CHROMA_SAMPLE, 0 ]);
        expect(getChromaLumaShift(location, DIVISORS_444)).toEqual([ 0, 0 ]);
        expect(getChromaPlaneOffset(location, DIVISORS_444)).toEqual([ 0, 0 ]);
    });

    it('places chroma left where the stream declares no location', () => {
        expect(DEFAULT_CHROMA_LOCATION).toBe('left');
        expect(getChromaLumaShift(null, DIVISORS_420)).toEqual(LOCATION_LUMA_SHIFTS.left);
        expect(getChromaPlaneOffset(null, DIVISORS_420)).toEqual([ QUARTER_CHROMA_SAMPLE, 0 ]);
    });
});

describe('raw signal chroma reads', () => {
    const metadata = createSDRColorMetadata();

    it('reads planar and semi-planar 4:2:0 chroma where the stream\'s location places it', () => {
        const sampleCases: readonly (readonly [ChromaLocation | null, string])[] = [
            [ null, RIGHT_SHIFTED_COORDINATE ],
            [ 'center', UNSHIFTED_COORDINATE ],
            [ 'top-left', RIGHT_AND_DOWN_SHIFTED_COORDINATE ],
            [ 'bottom', UP_SHIFTED_COORDINATE ]
        ];
        for (const [ location, coordinate ] of sampleCases) {
            expect(extractFunction(createRawYUVSignal('I420', metadata, false, location).code, 'sampleRawYUV')).toContain(`sampleChromaU(${coordinate})`);
            expect(extractFunction(createRawYUVSignal('NV12', metadata, false, location).code, 'sampleRawYUV')).toContain(`sampleChroma(${coordinate})`);
        }
    });

    it('reads 4:2:2 chroma on its left luma column and 4:4:4 chroma unshifted, whatever the stream declares', () => {
        expect(extractFunction(createRawYUVSignal('I422', metadata, false, DECLARED_CHROMA_LOCATION).code, 'sampleRawYUV'))
            .toContain(`sampleChromaU(${RIGHT_SHIFTED_COORDINATE})`);
        expect(extractFunction(createRawYUVSignal('I444', metadata, false, DECLARED_CHROMA_LOCATION).code, 'sampleRawYUV'))
            .toContain(`sampleChromaU(${UNSHIFTED_COORDINATE})`);
    });

    it('reads a field\'s chroma with the location\'s horizontal shift alone, and a progressive frame\'s with both', () => {
        const sampleYUV = extractFunction(createRawYUVSignal('I420', metadata, true, DECLARED_CHROMA_LOCATION).code, 'sampleRawYUV');
        const fieldRead = sampleYUV.slice(sampleYUV.indexOf(`if (${INTERLACED_SIGNAL_CONDITION}) {`), sampleYUV.indexOf('}'));

        expect(fieldRead).toContain(`sampleInterlacedChromaU(${RIGHT_SHIFTED_COORDINATE})`);
        expect(sampleYUV.slice(sampleYUV.indexOf('}'))).toContain(`sampleChromaU(${RIGHT_AND_DOWN_SHIFTED_COORDINATE})`);
    });

    it('offers planes sited where the signal reads chroma', () => {
        const planes = requirePlanes(createRawYUVSignal('I420', metadata, false, DECLARED_CHROMA_LOCATION).planes);

        expect(planes.chromaOffset).toEqual([ QUARTER_CHROMA_SAMPLE, QUARTER_CHROMA_SAMPLE ]);
        expect(extractFunction(planes.code, planes.sitedChromaEntryPoint)).toContain(`${planes.chromaEntryPoint}(${RIGHT_AND_DOWN_SHIFTED_COORDINATE})`);
    });

    it('reads a Dolby Vision base layer\'s 4:2:0 chroma at the stream\'s location', () => {
        const signal = createRawDolbyVisionSignal(DOLBY_VISION_FORMAT, SINGLE_LAYER_DOLBY_VISION_PROFILE, false, DECLARED_CHROMA_LOCATION);

        expect(extractFunction(signal.code, 'sampleRawYUV')).toContain(`sampleChromaU(${RIGHT_AND_DOWN_SHIFTED_COORDINATE})`);
    });
});

describe('derived plane chroma', () => {
    it('derives the external routes\' chroma at each chroma sample\'s site, as the stream\'s location places it', () => {
        const identityPlanes = requirePlanes(createExternalIdentitySignal(createSDRColorMetadata(), DECLARED_CHROMA_SUBSAMPLING, DECLARED_CHROMA_LOCATION).planes);
        const hdrPlanes = requirePlanes(createExternalHDRSignal(createPQColorMetadata(), DECLARED_CHROMA_SUBSAMPLING, DECLARED_CHROMA_LOCATION).planes);
        const siteCoordinate = `coordinate - vec2f(${toWGSLFloat(HALF_LUMA_SAMPLE)}, ${toWGSLFloat(HALF_LUMA_SAMPLE)}) / getPlaneImageSize()`;

        for (const planes of [ identityPlanes, hdrPlanes ]) {
            expect(planes.chromaOffset).toEqual([ QUARTER_CHROMA_SAMPLE, QUARTER_CHROMA_SAMPLE ]);
            expect(extractFunction(planes.imageCode, planes.chromaEntryPoint)).toContain(siteCoordinate);
        }
    });
});
