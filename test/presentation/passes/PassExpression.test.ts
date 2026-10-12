import { describe, expect, it } from 'vitest';

import {
    collectPassExpressionIdentifiers,
    evaluatePassExpression,
    parsePassExpression,
    PassExpressionError
} from 'webgpu-player/presentation/passes/PassExpression';

const SOURCE_WIDTH = 1920;
const SOURCE_HEIGHT = 1080;
const OUTPUT_WIDTH = 3840;
const OUTPUT_HEIGHT = 2160;
const HOOKED_WIDTH = 960;

const FACTS: ReadonlyMap<string, number> = new Map([
    [ 'source.width', SOURCE_WIDTH ],
    [ 'source.height', SOURCE_HEIGHT ],
    [ 'output.width', OUTPUT_WIDTH ],
    [ 'output.height', OUTPUT_HEIGHT ],
    [ 'HOOKED.width', HOOKED_WIDTH ],
    [ 'hdr.source', 1 ]
]);

function evaluate(text: string): number {
    return evaluatePassExpression(parsePassExpression(text), FACTS);
}

describe('pass expressions', () => {
    it('evaluates arithmetic with operator precedence and left associativity', () => {
        expect(evaluate('2 + 3 * 4')).toBe(14);
        expect(evaluate('(2 + 3) * 4')).toBe(20);
        expect(evaluate('16 / 4 / 2')).toBe(2);
        expect(evaluate('10 - 4 - 3')).toBe(3);
        expect(evaluate('7 % 4')).toBe(3);
    });

    it('reads dotted identifiers from the facts', () => {
        expect(evaluate('HOOKED.width * 2')).toBe(HOOKED_WIDTH * 2);
        expect(evaluate('output.width / source.width')).toBe(OUTPUT_WIDTH / SOURCE_WIDTH);
    });

    it('evaluates comparisons and logic to 1 or 0', () => {
        expect(evaluate('output.width >= source.width * 1.5')).toBe(1);
        expect(evaluate('output.width < source.width')).toBe(0);
        expect(evaluate('hdr.source == 1 && output.height > 2000')).toBe(1);
        expect(evaluate('!hdr.source || 0')).toBe(0);
    });

    it('applies unary operators before binary ones', () => {
        expect(evaluate('-2 * 3')).toBe(-6);
        expect(evaluate('2 * -3')).toBe(-6);
        expect(evaluate('- -4')).toBe(4);
    });

    it('evaluates the whitelisted functions with their arities', () => {
        expect(evaluate('min(source.width, 1000)')).toBe(1000);
        expect(evaluate('max(1, 2) + floor(2.7) + ceil(2.1) + round(2.5) + abs(-3)')).toBe(2 + 2 + 3 + 3 + 3);
        expect(evaluate('ceil(output.width / 16)')).toBe(OUTPUT_WIDTH / 16);
    });

    it('collects identifiers in first-use order', () => {
        const expression = parsePassExpression('max(output.width, source.width) + output.width');
        expect(collectPassExpressionIdentifiers(expression)).toEqual([ 'output.width', 'source.width' ]);
    });

    it.each([
        [ '', 'Empty expression' ],
        [ '2 +', 'Expression ends with an operator' ],
        [ '(2 + 3', 'Unbalanced parenthesis' ],
        [ '2 + 3)', 'Unbalanced parenthesis' ],
        [ 'sqrt(4)', "Unknown function 'sqrt'" ],
        [ 'min(1)', 'min takes 2 arguments, not 1' ],
        [ 'floor()', 'floor takes 1 arguments, not 0' ],
        [ '1, 2', 'Comma outside a function call' ],
        [ '2 $ 3', "Unexpected character '$'" ],
        [ '2 3', 'Unexpected number' ],
        [ '* 2', "Unexpected operator '*'" ]
    ])('rejects the malformed expression %j', (text: string, message: string) => {
        expect(() => parsePassExpression(text)).toThrow(PassExpressionError);
        expect(() => parsePassExpression(text)).toThrow(message);
    });

    it('rejects unknown identifiers and division by zero when evaluating', () => {
        expect(() => evaluate('stream.width + 1')).toThrow("Unknown identifier 'stream.width'");
        expect(() => evaluate('source.width / 0')).toThrow('Division by zero');
    });
});
