// Generates the WGSL around pass code: input accessors, entry points, and the renaming that keeps each user body's identifiers apart.
// docs/src/new-pass.md describes the generated code a user pass sees.
import { toWGSLFloat } from './builtin/BuiltinWGSL';
import { PRELUDE_FUNCTIONS, TARGET_ACCESSOR_PREFIX } from './PassLanguage';
import type { PassLineMapping, PassParameter, PassTexture, SignalLinearLight, SignalPlanes } from './PassTypes';

/** The vertex stage of every render pass: two triangles over the target, with normalized target coordinates. */
export const VERTEX_STAGE_WGSL = /* wgsl */ `struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) textureCoordinate: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    let positions = array<vec2f, 6>(
        vec2f(-1.0, 1.0),
        vec2f(1.0, 1.0),
        vec2f(-1.0, -1.0),
        vec2f(-1.0, -1.0),
        vec2f(1.0, 1.0),
        vec2f(1.0, -1.0),
    );
    let textureCoordinates = array<vec2f, 6>(
        vec2f(0.0, 0.0),
        vec2f(1.0, 0.0),
        vec2f(0.0, 1.0),
        vec2f(0.0, 1.0),
        vec2f(1.0, 0.0),
        vec2f(1.0, 1.0),
    );

    var output: VertexOutput;
    output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
    output.textureCoordinate = textureCoordinates[vertexIndex];
    return output;
}`;

/** The fragment stage's normalized coordinate in the pass's input, after the pass's coordinate mapping. */
export const FRAGMENT_COORDINATE = 'textureCoordinate';

/** The fragment stage's normalized coordinate in its target, before the coordinate mapping. */
export const FRAGMENT_TARGET_COORDINATE = 'input.textureCoordinate';

/** The fragment stage's target pixel center, which color steps receive as their position. */
export const FRAGMENT_POSITION = 'input.position.xy';

/** The color a fragment or a compute store carries through its color steps. */
export const STEP_COLOR = 'color';

const LINE_COMMENT_START = '//';
const BLOCK_COMMENT_START = '/*';
const BLOCK_COMMENT_END = '*/';
const COMMENT_MARKER_LENGTH = 2;
const NEWLINE = '\n';
const BLANK = ' ';
const TEMPLATE_OPEN = '<';
const TEMPLATE_CLOSE = '>';
const BRACE_OPEN = '{';
const BRACE_CLOSE = '}';
const MEMBER_ACCESS = '.';

// Numbers match first, so a letter inside a literal such as 1e5 or 0x1Fu is never taken for an identifier
const WORD_PATTERN = /\d[\w.]*|[A-Za-z_]\w*/g;
const DECLARATION_TOKEN_PATTERN = /\d[\w.]*|[A-Za-z_]\w*|[{}<>]/g;
const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/;
const WHITESPACE_PATTERN = /\s/;

// The keywords that declare a module-scope name
const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set<string>([ 'alias', 'const', 'fn', 'override', 'struct', 'var' ]);

type CommentState = { blockDepth: number; inLineComment: boolean };

/** Advances the comment state over the character at index; returns how many characters the transition consumed. */
function advanceCommentState(source: string, index: number, state: CommentState): number {
    const pair = source.slice(index, index + COMMENT_MARKER_LENGTH);
    if (state.inLineComment) {
        state.inLineComment = source[index] !== NEWLINE;
        return 1;
    }
    if (pair === BLOCK_COMMENT_START) {
        state.blockDepth += 1;
        return COMMENT_MARKER_LENGTH;
    }
    if (state.blockDepth > 0 && pair === BLOCK_COMMENT_END) {
        state.blockDepth -= 1;
        return -COMMENT_MARKER_LENGTH;
    }
    if (state.blockDepth === 0 && pair === LINE_COMMENT_START) {
        state.inLineComment = true;
    }
    return 1;
}

/** Replaces comments with spaces, keeping every newline and offset, so a scan sees only code; block comments nest as in WGSL. */
export function blankWGSLComments(source: string): string {
    const characters = source.split('');
    const state: CommentState = { blockDepth: 0, inLineComment: false };
    let index = 0;
    while (index < characters.length) {
        const consumed = advanceCommentState(source, index, state);
        // A marker belongs to the comment it opens or closes, so it is blanked whichever way the depth moved
        const markerLength = Math.abs(consumed);
        const inComment = consumed !== 1 || state.inLineComment || state.blockDepth > 0;
        for (let offset = 0; offset < markerLength; offset += 1) {
            if (inComment && characters[index + offset] !== NEWLINE) {
                characters[index + offset] = BLANK;
            }
        }
        index += markerLength;
    }
    return characters.join('');
}

/** Returns the name a declaration keyword at tokens[keywordIndex] declares, skipping a `var<...>` address space. */
function readDeclaredName(tokens: readonly string[], keywordIndex: number): string | null {
    let index = keywordIndex + 1;
    if (tokens[index] === TEMPLATE_OPEN) {
        let templateDepth = 0;
        for (; index < tokens.length; index += 1) {
            templateDepth += tokens[index] === TEMPLATE_OPEN ? 1 : 0;
            templateDepth -= tokens[index] === TEMPLATE_CLOSE ? 1 : 0;
            if (templateDepth === 0) {
                break;
            }
        }
        index += 1;
    }
    const name = tokens.at(index);
    return name !== undefined && IDENTIFIER_PATTERN.test(name) ? name : null;
}

/** Returns the names a WGSL body declares at module scope: its functions, structs, constants, overrides, aliases, and variables. */
export function collectTopLevelDeclarations(body: string): string[] {
    const tokens = blankWGSLComments(body).match(DECLARATION_TOKEN_PATTERN) ?? [];
    const names: string[] = [];
    let braceDepth = 0;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        switch (token) {
            case BRACE_OPEN:
                braceDepth += 1;
                break;
            case BRACE_CLOSE:
                braceDepth -= 1;
                break;
            default: {
                if (braceDepth !== 0 || !DECLARATION_KEYWORDS.has(token)) {
                    break;
                }
                const name = readDeclaredName(tokens, index);
                if (name !== null && !names.includes(name)) {
                    names.push(name);
                }
            }
        }
    }
    return names;
}

/** Returns whether the word at offset follows a member access dot, as a struct member or a swizzle does. */
function isMemberName(source: string, offset: number): boolean {
    let index = offset - 1;
    while (index >= 0 && WHITESPACE_PATTERN.test(source[index])) {
        index -= 1;
    }
    return index >= 0 && source[index] === MEMBER_ACCESS;
}

/** Returns which of the given names a WGSL body reads without declaring them at module scope, as the prelude's functions are read; comments and member names do not count. */
export function collectUndeclaredReferences(body: string, names: readonly string[]): Set<string> {
    const declared = new Set<string>(collectTopLevelDeclarations(body));
    const code = blankWGSLComments(body);
    const references = new Set<string>();
    for (const match of code.matchAll(WORD_PATTERN)) {
        const word = match[0];
        if (names.includes(word) && !declared.has(word) && !isMemberName(code, match.index)) {
            references.add(word);
        }
    }
    return references;
}

/**
 * Renames whole identifiers in WGSL source, except member names after a dot; the line structure is unchanged.
 * It is lexical, so a user struct member that shares a renamed module-scope name is renamed where declared but not where accessed.
 */
export function renameWGSLIdentifiers(source: string, renames: ReadonlyMap<string, string>): string {
    if (renames.size === 0) {
        return source;
    }
    return source.replace(WORD_PATTERN, (word: string, offset: number): string => {
        const replacement = renames.get(word);
        return replacement === undefined || isMemberName(source, offset) ? word : replacement;
    });
}

/**
 * Returns the declarations of a texture input and its accessors `<prefix>_tex`, `_texOff`, `_pt`, `_size`, and `_offset`.
 * The offset is the texture's plan-time offset in its own pixels: the texture pixel the reference grid's origin falls on.
 */
export function createTextureAccessorsWGSL(
    prefix: string,
    binding: number,
    filterable: boolean,
    samplerName: string,
    offset: readonly [number, number]
): string {
    const textureName = `${prefix}_texture`;
    // An unfilterable texture is read with four loads and a manual blend, which is what a linear sampler does
    const sampleWGSL = filterable ?
        `    return textureSampleLevel(${textureName}, ${samplerName}, coordinate, 0.0);` :
        `    let dimensions = vec2i(textureDimensions(${textureName}));
    let samplePosition = coordinate * vec2f(dimensions) - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = dimensions - vec2i(1);
    let topLeft = textureLoad(${textureName}, clamp(basePosition, vec2i(0), maximumPosition), 0);
    let topRight = textureLoad(${textureName}, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition), 0);
    let bottomLeft = textureLoad(${textureName}, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition), 0);
    let bottomRight = textureLoad(${textureName}, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition), 0);
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);`;
    return `@group(0) @binding(${binding}) var ${textureName}: texture_2d<f32>;

fn ${prefix}_size() -> vec2f {
    return vec2f(textureDimensions(${textureName}));
}

fn ${prefix}_pt() -> vec2f {
    return 1.0 / ${prefix}_size();
}

fn ${prefix}_offset() -> vec2f {
    return vec2f(${toWGSLFloat(offset[0])}, ${toWGSLFloat(offset[1])});
}

fn ${prefix}_tex(coordinate: vec2f) -> vec4f {
${sampleWGSL}
}

fn ${prefix}_texOff(coordinate: vec2f, offsetInPixels: vec2f) -> vec4f {
    return ${prefix}_tex(coordinate + offsetInPixels * ${prefix}_pt());
}`;
}

/** Returns the prelude's linearize, delinearize, and referenceWhiteNits over the source's transfer function, whose code the module holds beside them. */
export function createLinearLightPreludeWGSL(linearLight: SignalLinearLight): string {
    return `fn ${PRELUDE_FUNCTIONS.referenceWhiteNits}() -> f32 {
    return ${toWGSLFloat(linearLight.referenceWhiteNits)};
}

fn ${PRELUDE_FUNCTIONS.linearize}(color: vec4f) -> vec4f {
    return vec4f(${linearLight.decodeEntryPoint}(color.rgb) / ${PRELUDE_FUNCTIONS.referenceWhiteNits}(), color.a);
}

fn ${PRELUDE_FUNCTIONS.delinearize}(color: vec4f) -> vec4f {
    return vec4f(${linearLight.encodeEntryPoint}(color.rgb * ${PRELUDE_FUNCTIONS.referenceWhiteNits}()), color.a);
}`;
}

/** Returns the prelude's rgbToPlanes and planesToRGB over the signal's plane transform, whose code the module holds beside them. */
export function createPlaneTransformPreludeWGSL(planes: SignalPlanes): string {
    return `fn ${PRELUDE_FUNCTIONS.rgbToPlanes}(color: vec3f) -> vec3f {
    return ${planes.rgbToPlanesEntryPoint}(color);
}

fn ${PRELUDE_FUNCTIONS.planesToRGB}(planes: vec3f) -> vec3f {
    return ${planes.planesToRGBEntryPoint}(planes);
}`;
}

// A texture block's coordinate, size, and texel types by its dimensions; a one-dimensional block is a texture one texel high
const PASS_TEXTURE_COORDINATE_TYPES: Readonly<Record<PassTexture['dimensions'], string>> = { 1: 'f32', 2: 'vec2f', 3: 'vec3f' };
const PASS_TEXTURE_TEXEL_TYPES: Readonly<Record<PassTexture['dimensions'], string>> = { 1: 'i32', 2: 'vec2i', 3: 'vec3i' };
// The row a one-dimensional block's reads take, the center of its one texel high
const ONE_DIMENSIONAL_ROW = 0.5;

/**
 * Returns the declarations of a texture block a pass binds and its accessors `<base>_tex(coordinate)`, a read through the block's filter and edge mode
 * at a normalized coordinate, `<base>_size()`, and `<base>_load(texel)`, one texel clamped to the block; coordinates and texels have the block's dimensions.
 */
export function createPassTextureAccessorsWGSL(base: string, texture: PassTexture, textureBinding: number, samplerBinding: number): string {
    const textureName = `${base}_texture`;
    const samplerName = `${base}_sampler`;
    const coordinateType = PASS_TEXTURE_COORDINATE_TYPES[texture.dimensions];
    const texelType = PASS_TEXTURE_TEXEL_TYPES[texture.dimensions];
    const textureType = texture.dimensions === 3 ? 'texture_3d<f32>' : 'texture_2d<f32>';
    let sampleCoordinate = 'coordinate';
    let sizeExpression = `vec3f(textureDimensions(${textureName}))`;
    let loadTexel = `clamp(texel, vec3i(0), vec3i(textureDimensions(${textureName})) - vec3i(1))`;
    switch (texture.dimensions) {
        case 1:
            sampleCoordinate = `vec2f(coordinate, ${toWGSLFloat(ONE_DIMENSIONAL_ROW)})`;
            sizeExpression = `f32(textureDimensions(${textureName}).x)`;
            loadTexel = `vec2i(clamp(texel, 0, i32(textureDimensions(${textureName}).x) - 1), 0)`;
            break;
        case 2:
            sizeExpression = `vec2f(textureDimensions(${textureName}))`;
            loadTexel = `clamp(texel, vec2i(0), vec2i(textureDimensions(${textureName})) - vec2i(1))`;
            break;
        case 3:
            break;
    }
    return `@group(0) @binding(${textureBinding}) var ${textureName}: ${textureType};
@group(0) @binding(${samplerBinding}) var ${samplerName}: sampler;

fn ${base}_size() -> ${coordinateType} {
    return ${sizeExpression};
}

fn ${base}_tex(coordinate: ${coordinateType}) -> vec4f {
    return textureSampleLevel(${textureName}, ${samplerName}, ${sampleCoordinate}, 0.0);
}

fn ${base}_load(texel: ${texelType}) -> vec4f {
    return textureLoad(${textureName}, ${loadTexel}, 0);
}`;
}

/** Returns the color step calls of a body, which reassign `color`, given the expression of the step's position. */
function createStepStatements(stepEntryPoints: readonly string[], positionExpression: string, indentation: string): string[] {
    return stepEntryPoints.map((entryPoint: string): string => (
        `${indentation}${STEP_COLOR} = ${entryPoint}(${STEP_COLOR}, ${positionExpression});`
    ));
}

/**
 * Returns a compute pass's storage target and its accessors `TARGET_size` and `TARGET_store`.
 * The color steps fused after the pass run inside `TARGET_store`, at the stored pixel's center.
 */
export function createStorageTargetWGSL(binding: number, format: GPUTextureFormat, stepEntryPoints: readonly string[]): string {
    const textureName = `${TARGET_ACCESSOR_PREFIX}_texture`;
    const declaration = stepEntryPoints.length > 0 ? 'var' : 'let';
    const statements = [
        `    ${declaration} ${STEP_COLOR} = value;`,
        ...createStepStatements(stepEntryPoints, 'vec2f(position) + vec2f(0.5)', '    '),
        `    textureStore(${textureName}, position, ${STEP_COLOR});`
    ];
    return `@group(0) @binding(${binding}) var ${textureName}: texture_storage_2d<${format}, write>;

fn ${TARGET_ACCESSOR_PREFIX}_size() -> vec2u {
    return textureDimensions(${textureName});
}

fn ${TARGET_ACCESSOR_PREFIX}_store(position: vec2u, value: vec4f) {
${statements.join(NEWLINE)}
}`;
}

/**
 * Returns a pass's constants as WGSL constants of their types, under the names the pass's renaming gives them.
 * Each value prints as the shortest decimal that reads back as itself, which WGSL converts to the constant's type exactly.
 */
export function createConstantsWGSL(names: ReadonlyMap<string, string>, constants: readonly PassParameter[], values: readonly number[]): string {
    return constants.map((constant: PassParameter, index: number): string => (
        `const ${names.get(constant.name) ?? constant.name}: ${constant.type} = ${String(values[index])};`
    )).join(NEWLINE);
}

/** Returns a pass's parameters struct and its uniform; each declared parameter is one 32-bit scalar, in order. */
export function createParametersWGSL(structName: string, variableName: string, parameters: readonly PassParameter[], binding: number): string {
    const members = parameters.map((parameter: PassParameter): string => `    ${parameter.name}: ${parameter.type},`);
    return `struct ${structName} {
${members.join(NEWLINE)}
}

@group(0) @binding(${binding}) var<uniform> ${variableName}: ${structName};`;
}

/**
 * Returns a render pass's fragment stage: it maps the target coordinate into the input, evaluates the core, then the color steps.
 * While the bypass condition holds, the frame presents its core value without any step, as a Dolby Vision Profile 4 base does.
 */
export function createFragmentStageWGSL(coreExpression: string, bypassCondition: string | null, stepEntryPoints: readonly string[]): string {
    const declaration = stepEntryPoints.length > 0 ? 'var' : 'let';
    const statements = [
        `    let ${FRAGMENT_COORDINATE} = input.textureCoordinate * presentation.textureScale`,
        '        + presentation.textureOffset;',
        `    ${declaration} ${STEP_COLOR} = ${coreExpression};`
    ];
    if (bypassCondition !== null && stepEntryPoints.length > 0) {
        statements.push(`    if (${bypassCondition}) {`, `        return ${STEP_COLOR};`, '    }');
    }
    statements.push(...createStepStatements(stepEntryPoints, FRAGMENT_POSITION, '    '), `    return ${STEP_COLOR};`);
    return `@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
${statements.join(NEWLINE)}
}`;
}

/** Returns a compute pass's entry point, which calls the user's `compute` once per invocation. */
export function createComputeStageWGSL(workgroupSize: readonly [number, number, number], computeEntryPoint: string): string {
    return `@compute @workgroup_size(${workgroupSize[0]}, ${workgroupSize[1]}, ${workgroupSize[2]})
fn computeMain(@builtin(global_invocation_id) id: vec3u) {
    ${computeEntryPoint}(id);
}`;
}

/** Assembles one pass's WGSL module from blocks, recording where each user body's lines land for compile error mapping. */
export class ShaderModuleBuilder {
    private readonly lineMap: PassLineMapping[] = [];
    private readonly lines: string[] = [];

    /** Appends engine-generated code and a blank line; empty code appends nothing. */
    appendEngineCode(code: string): void {
        const trimmedCode = code.trim();
        if (trimmedCode === '') {
            return;
        }
        this.lines.push(...trimmedCode.split(NEWLINE), '');
    }

    /** Appends a user pass's body line for line, and maps its lines back to the pass's source, whose body starts at firstSourceLine. */
    appendUserBody(passName: string, firstSourceLine: number, body: string): void {
        const bodyLines = body.split(NEWLINE);
        this.lineMap.push({
            firstGeneratedLine: this.lines.length + 1,
            firstSourceLine,
            lineCount: bodyLines.length,
            passName
        });
        this.lines.push(...bodyLines, '');
    }

    /** Returns the module's code and its 1-based line map. */
    build(): { code: string; lineMap: readonly PassLineMapping[] } {
        return { code: this.lines.join(NEWLINE), lineMap: this.lineMap };
    }
}
