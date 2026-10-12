import { describe, expect, it } from 'vitest';

import catmullRomScalerShader from 'webgpu-player/presentation/passes/builtin/CatmullRomScaler.wgsl';
import { evaluatePassExpression, parsePassExpression } from 'webgpu-player/presentation/passes/PassExpression';

const EXPECTED_HEADER: readonly string[] = [
    '//! name: Catmull-Rom',
    '//! shape: scaler',
    '//! hook: SCALE',
    '//! input: HOOKED',
    '//! domain: any'
];
const SCALER_ENTRY_POINT = 'fn scale(coordinate: vec2f) -> vec4f {';
const WEIGHTS_FUNCTION = 'fn getCatmullRomWeights(fraction: f32) -> vec4f {';
const WEIGHT_COUNT = 4;
const TAP_LOOP_COUNT = 'row < 4u';
const SAMPLED_FRACTIONS: readonly number[] = [ 0, 0.125, 0.25, 0.5, 0.75, 0.9 ];
const WEIGHT_PRECISION = 12;
// Catmull-Rom halfway between two texels: the cubic convolution kernel with a = -0.5 at distances 1.5, 0.5, 0.5, and 1.5
const HALFWAY_WEIGHTS: readonly number[] = [ -0.0625, 0.5625, 0.5625, -0.0625 ];
const ORIGIN_WEIGHTS: readonly number[] = [ 0, 1, 0, 0 ];

/** Evaluates the four weight expressions of the scaler's WGSL with the pass expression evaluator, which reads the same arithmetic. */
function evaluateWeights(fraction: number): number[] {
    const weightsFunction = catmullRomScalerShader.slice(catmullRomScalerShader.indexOf(WEIGHTS_FUNCTION));
    const weightsVector = weightsFunction.slice(weightsFunction.indexOf('return vec4f(') + 'return vec4f('.length, weightsFunction.indexOf(');'));
    const expressions = weightsVector.split(',').map((expression: string): string => expression.trim());
    if (expressions.length !== WEIGHT_COUNT) {
        throw new Error('The scaler does not weight four taps');
    }
    const facts = new Map([
        [ 'fraction', fraction ],
        [ 'squared', fraction * fraction ],
        [ 'cubed', fraction * fraction * fraction ]
    ]);
    return expressions.map((expression: string): number => evaluatePassExpression(parsePassExpression(expression), facts));
}

describe('the Catmull-Rom scaler', () => {
    it('declares a scaler on the SCALE hook in the pass header format', () => {
        const lines = catmullRomScalerShader.split('\n');

        expect(lines.slice(0, EXPECTED_HEADER.length)).toEqual(EXPECTED_HEADER);
        expect(lines[EXPECTED_HEADER.length]).toBe('');
        expect(catmullRomScalerShader).toContain(SCALER_ENTRY_POINT);
    });

    it('reads its input only through the HOOKED accessors, over 4x4 taps', () => {
        const body = catmullRomScalerShader.slice(catmullRomScalerShader.indexOf(SCALER_ENTRY_POINT));

        expect(body).toContain('HOOKED_size()');
        expect(body).toContain('HOOKED_pt()');
        expect(body).toContain('HOOKED_texOff(originCoordinate, offsetInPixels)');
        expect(body).toContain(TAP_LOOP_COUNT);
        expect(catmullRomScalerShader).not.toMatch(/@group|@binding|textureSample|textureLoad/);
    });

    it.each(SAMPLED_FRACTIONS)('weights its taps to sum to 1 at fraction %f', fraction => {
        const weights = evaluateWeights(fraction);

        expect(weights.reduce((sum: number, weight: number): number => sum + weight, 0)).toBeCloseTo(1, WEIGHT_PRECISION);
    });

    it('interpolates: the origin texel alone at fraction 0, symmetric halfway', () => {
        evaluateWeights(0).forEach((weight: number, tapIndex: number): void => {
            expect(weight).toBeCloseTo(ORIGIN_WEIGHTS[tapIndex], WEIGHT_PRECISION);
        });
        evaluateWeights(0.5).forEach((weight: number, tapIndex: number): void => {
            expect(weight).toBeCloseTo(HALFWAY_WEIGHTS[tapIndex], WEIGHT_PRECISION);
        });
    });
});
