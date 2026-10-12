import { describe, expect, it } from 'vitest';

import {
    blankWGSLComments,
    collectTopLevelDeclarations,
    createFragmentStageWGSL,
    renameWGSLIdentifiers,
    ShaderModuleBuilder
} from 'webgpu-player/presentation/passes/PassPrelude';

const COMMENTED_SOURCE = `fn kept() {} // fn lineComment() {}
/* fn blockComment() {} /* nested */ still comment */ const keptConstant = 1.0;
/* spans
lines */ fn alsoKept() {}`;

const DECLARING_BODY = `
alias Weights = vec4f;
const strength = 0.5;
override quality: u32 = 2u;
var<private> scratch: vec4f;
struct Sample {
    weight: f32,
}

fn helper(value: f32) -> f32 {
    let local = value * strength;
    var counter = 0;
    return local;
}

// fn commented() {}
fn kernel(coordinate: vec2f) -> vec4f {
    return vec4f(helper(coordinate.x));
}
`;
const DECLARED_NAMES: readonly string[] = [ 'Weights', 'strength', 'quality', 'scratch', 'Sample', 'helper', 'kernel' ];

const BYPASS_CONDITION = 'isBypassed()';
const STEP_ENTRY_POINTS: readonly string[] = [ 'firstStep', 'secondStep' ];
const ENGINE_CODE = 'struct Engine {\n    value: f32,\n}';
const USER_BODY = '\nfn apply(color: vec4f, position: vec2f) -> vec4f {\n    return color;\n}';
const USER_BODY_FIRST_SOURCE_LINE = 5;

describe('blankWGSLComments', () => {
    it('blanks line, block, and nested block comments, keeping every offset and newline', () => {
        const blanked = blankWGSLComments(COMMENTED_SOURCE);

        expect(blanked).toHaveLength(COMMENTED_SOURCE.length);
        expect(blanked.split('\n')).toHaveLength(COMMENTED_SOURCE.split('\n').length);
        expect(blanked).toContain('fn kept() {}');
        expect(blanked).toContain('const keptConstant = 1.0;');
        expect(blanked).toContain('fn alsoKept() {}');
        expect(blanked).not.toContain('lineComment');
        expect(blanked).not.toContain('blockComment');
        expect(blanked).not.toContain('nested');
        expect(blanked).not.toContain('still comment');
        expect(blanked).not.toContain('spans');
    });
});

describe('collectTopLevelDeclarations', () => {
    it('returns every module-scope name, and no locals, members, or commented declarations', () => {
        expect(collectTopLevelDeclarations(DECLARING_BODY)).toEqual(DECLARED_NAMES);
    });
});

describe('renameWGSLIdentifiers', () => {
    it('renames whole identifiers but not member names, swizzles, or letters inside numbers', () => {
        const renames = new Map<string, string>([ [ 'rgb', 'user0_rgb' ], [ 'e5', 'user0_e5' ], [ 'weight', 'user0_weight' ] ]);
        const source = 'let rgb = color.rgb + sample . weight * 1e5 + weight;';

        expect(renameWGSLIdentifiers(source, renames)).toBe('let user0_rgb = color.rgb + sample . weight * 1e5 + user0_weight;');
    });

    it('keeps identifiers that only contain a renamed name', () => {
        const renames = new Map<string, string>([ [ 'apply', 'user0_apply' ] ]);

        expect(renameWGSLIdentifiers('fn apply() {} fn applyMore() {} fn reapply() {}', renames))
            .toBe('fn user0_apply() {} fn applyMore() {} fn reapply() {}');
    });
});

describe('createFragmentStageWGSL', () => {
    it('evaluates the core, returns it while the bypass holds, then runs the steps in order', () => {
        const stage = createFragmentStageWGSL('core(textureCoordinate)', BYPASS_CONDITION, STEP_ENTRY_POINTS);

        expect(stage).toContain('var color = core(textureCoordinate);');
        expect(stage).toContain(`    if (${BYPASS_CONDITION}) {\n        return color;\n    }\n    color = firstStep(color, input.position.xy);\n    color = secondStep(color, input.position.xy);`);
    });

    it('declares the color immutable and drops the bypass without steps', () => {
        const stage = createFragmentStageWGSL('core(textureCoordinate)', BYPASS_CONDITION, []);

        expect(stage).toContain('let color = core(textureCoordinate);');
        expect(stage).not.toContain(BYPASS_CONDITION);
    });
});

describe('ShaderModuleBuilder', () => {
    it('maps a user body\'s 1-based generated lines to its source lines', () => {
        const builder = new ShaderModuleBuilder();
        builder.appendEngineCode(ENGINE_CODE);
        builder.appendUserBody('Pass', USER_BODY_FIRST_SOURCE_LINE, USER_BODY);
        builder.appendEngineCode('');
        const module = builder.build();
        const lines = module.code.split('\n');
        const [ mapping ] = module.lineMap;

        expect(module.lineMap).toEqual([ { firstGeneratedLine: 5, firstSourceLine: USER_BODY_FIRST_SOURCE_LINE, lineCount: 4, passName: 'Pass' } ]);
        expect(lines[mapping.firstGeneratedLine]).toBe('fn apply(color: vec4f, position: vec2f) -> vec4f {');
    });
});
