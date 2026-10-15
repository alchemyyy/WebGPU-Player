// @vitest-environment node

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { readDecoderKind } from 'webgpu-player/decode/packages/DecoderHeader';
import { splitGPUDecoderModule } from 'webgpu-player/decode/video/gpu/GPUDecoderEntryPointModules';
import { parseGPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import { createGPUDecoderModule } from 'webgpu-player/decode/video/gpu/GPUDecoderPrelude';

import { loadDecoderPackageFormatTool, readDecoderProjectSourceFiles, type DecoderPackageFormatTool } from '../../../helpers/decoderPackages';
import { DECODERS_DIRECTORY } from '../../../helpers/enginePaths';

const MAIN_ENTRY_POINT = 'main';
const OTHER_ENTRY_POINT = 'other';
const PROJECT_FILE_NAME = 'decoder.json';
const VIDEO_KIND = 'video';
const LINE_BREAK = '\n';
const CRLF = '\r\n';

// A module of every module-scope form: directives, an assertion, attributes with arguments, overrides, aliases, structs, bindings,
// workgroup and private variables, and functions, with comments and numbers that hold braces, semicolons, and identifier-like text
const MODULE_CODE = [
    'enable f16;',
    'diagnostic(off, derivative_uniformity);',
    'const ASSERTED: u32 = 4u;',
    'const_assert ASSERTED > 2u;',
    '/* A block comment { with ; braces /* nested } */ and still a comment ; */',
    '@id(7) override WORKGROUP_SIZE: u32 = 64u;',
    'alias Word = u32;',
    'struct Pair { first: Word, second: Word }',
    '@group(0) @binding(0) var<storage, read_write> output: array<Pair>;',
    '@group(0) @binding(1) var<storage, read> unusedInput: array<u32>;',
    'var<workgroup> shared: array<u32, 64>;',
    'var<private> counter: u32 = 0x1Fu;',
    'const SCALE: f32 = 1.5e-3f; const OFFSET: f32 = .5;',
    'const HEXADECIMAL_FLOAT: f32 = 0x1p-3f;',
    '// A comment naming unreachedHelper { ; keeps nothing',
    'fn helper(value: Word) -> Word {',
    '    // Shadowing a module-scope name keeps that declaration too',
    '    let counter = value * 2u;',
    '    return counter + u32(SCALE * 0.0) + u32(OFFSET * 0.0) + u32(HEXADECIMAL_FLOAT * 0.0);',
    '}',
    'fn unreachedHelper() -> u32 { return 3u; }',
    '@compute @workgroup_size(WORKGROUP_SIZE)',
    'fn main(@builtin(global_invocation_id) id: vec3u) {',
    '    shared[id.x] = helper(id.x);',
    '    output[id.x] = Pair(shared[id.x], 1u);',
    '}',
    '@compute @workgroup_size(1)',
    'fn other() {',
    '    counter = unreachedHelper();',
    '}'
].join(LINE_BREAK);

/** A module the split refuses, and why. */
type RefusalCase = readonly [ description: string, code: string, entryPoints: readonly string[] ];

const REFUSAL_CASES: readonly RefusalCase[] = [
    [ 'a block comment left open', `${MODULE_CODE}\n/* open`, [ MAIN_ENTRY_POINT ] ],
    [ 'a brace left open', 'fn main() {\n', [ MAIN_ENTRY_POINT ] ],
    [ 'a closing brace without an opening one', 'fn main() {}\n}', [ MAIN_ENTRY_POINT ] ],
    [ 'mismatched brackets', 'fn main() { let values = array<u32, 2>(1u, 2u]; }', [ MAIN_ENTRY_POINT ] ],
    [ 'a statement at module scope', 'fn main() {}\nlet loose = 1u;', [ MAIN_ENTRY_POINT ] ],
    [ 'a declaration without its semicolon', 'const VALUE: u32 = 1u\nfn main() {}', [ MAIN_ENTRY_POINT ] ],
    [ 'attributes without a declaration', 'fn main() {}\n@compute', [ MAIN_ENTRY_POINT ] ],
    [ 'a name declared twice', 'const VALUE: u32 = 1u;\nconst VALUE: u32 = 2u;\nfn main() {}', [ MAIN_ENTRY_POINT ] ],
    [ 'an entry point no declaration names', 'fn main() {}', [ OTHER_ENTRY_POINT ] ],
    [ 'an entry point that is no function', 'const main: u32 = 1u;', [ MAIN_ENTRY_POINT ] ]
];

/** Returns the module the split makes for an entry point, failing the test when it makes none. */
function requireModule(code: string, entryPoint: string, entryPoints: readonly string[] = [ MAIN_ENTRY_POINT, OTHER_ENTRY_POINT ]): string {
    const module = splitGPUDecoderModule(code, entryPoints)?.get(entryPoint);
    if (module === undefined) {
        throw new Error(`No module for ${entryPoint}`);
    }
    return module;
}

/** Returns the 0-based line and column of a text's first occurrence in code whose lines end with the line break. */
function locate(code: string, text: string, lineBreak: string = LINE_BREAK): readonly [ number, number ] {
    const index = code.indexOf(text);
    const before = code.slice(0, index);
    const lineStart = before.lastIndexOf(lineBreak) < 0 ? 0 : before.lastIndexOf(lineBreak) + lineBreak.length;
    return [ before.split(lineBreak).length - 1, index - lineStart ];
}

describe('splitGPUDecoderModule', () => {
    it('keeps what an entry point reaches, through attributes, types, and calls, with every module\'s directives and assertions', () => {
        const module = requireModule(MODULE_CODE, MAIN_ENTRY_POINT);

        for (const kept of [
            'enable f16;',
            'diagnostic(off, derivative_uniformity);',
            'const ASSERTED: u32 = 4u;',
            'const_assert ASSERTED > 2u;',
            '@id(7) override WORKGROUP_SIZE: u32 = 64u;',
            'alias Word = u32;',
            'struct Pair { first: Word, second: Word }',
            '@group(0) @binding(0) var<storage, read_write> output: array<Pair>;',
            'var<workgroup> shared: array<u32, 64>;',
            'var<private> counter: u32 = 0x1Fu;',
            'const SCALE: f32 = 1.5e-3f; const OFFSET: f32 = .5;',
            'const HEXADECIMAL_FLOAT: f32 = 0x1p-3f;',
            'fn helper(value: Word) -> Word {',
            '@compute @workgroup_size(WORKGROUP_SIZE)'
        ]) {
            expect(module).toContain(kept);
        }
        for (const dropped of [ 'unusedInput', 'fn unreachedHelper', 'fn other', '/* A block comment', '// A comment naming' ]) {
            expect(module).not.toContain(dropped);
        }
    });

    it('keeps the other entry point\'s own reach, and not the first one\'s', () => {
        const module = requireModule(MODULE_CODE, OTHER_ENTRY_POINT);

        expect(module).toContain('fn unreachedHelper() -> u32 { return 3u; }');
        expect(module).toContain('var<private> counter: u32 = 0x1Fu;');
        expect(module).toContain('const_assert ASSERTED > 2u;');
        expect(module).not.toContain('fn main');
        expect(module).not.toContain('fn helper');
        expect(module).not.toContain('struct Pair');
    });

    it('keeps every kept character at its line and column, and the code\'s line count', () => {
        const module = requireModule(MODULE_CODE, MAIN_ENTRY_POINT);

        expect(module.split(LINE_BREAK)).toHaveLength(MODULE_CODE.split(LINE_BREAK).length);
        for (const kept of [ 'struct Pair', 'const OFFSET', 'fn main', 'output[id.x]', 'const_assert' ]) {
            expect(locate(module, kept)).toEqual(locate(MODULE_CODE, kept));
        }
    });

    it('keeps CRLF line breaks', () => {
        const crlfCode = MODULE_CODE.split(LINE_BREAK).join(CRLF);

        const module = requireModule(crlfCode, MAIN_ENTRY_POINT);

        expect(module.split(CRLF)).toHaveLength(crlfCode.split(CRLF).length);
        expect(locate(module, 'fn main', CRLF)).toEqual(locate(crlfCode, 'fn main', CRLF));
    });

    it('reads identifiers that follow numbers without a space as identifiers of their own', () => {
        const code = 'const xFF: u32 = 1u;\nconst e3: u32 = 2u;\nfn main() { let value = 0x1F+xFF + 1+e3; }';

        const module = requireModule(code, MAIN_ENTRY_POINT, [ MAIN_ENTRY_POINT ]);

        expect(module).toContain('const xFF');
        expect(module).toContain('const e3');
    });

    it.each(REFUSAL_CASES)('refuses %s', (_description, code, entryPoints) => {
        expect(splitGPUDecoderModule(code, entryPoints)).toBeNull();
    });
});

// A module-scope declaration's name, as an independent line by line reading finds it in the decoder projects' WGSL, whose declarations each start a line
const ATTRIBUTE_PREFIX_PATTERN = /^(?:@\w+(?:\([^)]*\))?\s*)+/;
const DECLARATION_NAME_PATTERN = /^(?:fn|struct|const|override|alias|var(?:<[^>]*>)?)\s+([A-Za-z_]\w*)/;
const LINE_COMMENT_PATTERN = /\/\/[^\n]*/g;
const WORD_PATTERN = /\b[A-Za-z_]\w*\b/g;

function findDeclarationNames(code: string): Set<string> {
    const names = new Set<string>();
    for (const line of code.split(LINE_BREAK)) {
        const name = DECLARATION_NAME_PATTERN.exec(line.replace(ATTRIBUTE_PREFIX_PATTERN, ''))?.[1];
        if (name !== undefined) {
            names.add(name);
        }
    }
    return names;
}

/** Returns the names a module uses that the whole module declares and the module does not, which a closed module has none of. */
function findUndeclaredNames(module: string, wholeModuleNames: ReadonlySet<string>): string[] {
    const declaredNames = findDeclarationNames(module);
    const usedWords = new Set(module.replace(LINE_COMMENT_PATTERN, '').match(WORD_PATTERN) ?? []);
    return [ ...usedWords ].filter((word: string): boolean => wholeModuleNames.has(word) && !declaredNames.has(word));
}

/** Every video decoder project in decoders/, by name. */
function listVideoDecoderProjects(): string[] {
    return readdirSync(DECODERS_DIRECTORY, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(join(DECODERS_DIRECTORY, entry.name, PROJECT_FILE_NAME)))
        .map(entry => entry.name)
        .filter((project: string): boolean => readDecoderKind(readDecoderProjectSourceFiles(project)[0].text) === VIDEO_KIND)
        .sort((first: string, second: string): number => first.localeCompare(second));
}

describe('splitGPUDecoderModule on the decoder projects', () => {
    let tool: DecoderPackageFormatTool;

    beforeAll(async () => {
        tool = await loadDecoderPackageFormatTool();
    });

    it.each(listVideoDecoderProjects())('splits every output format of %s into closed modules, one per entry point', (project: string) => {
        const manifest = parseGPUDecoderManifest(tool.joinDecoderSources(readDecoderProjectSourceFiles(project)));
        const entryPoints = [ ...new Set(manifest.dispatches.map(dispatch => dispatch.entryPoint)) ];

        for (const format of manifest.outputFormats) {
            const wholeCode = createGPUDecoderModule(manifest, format).code;
            const wholeModuleNames = findDeclarationNames(wholeCode);
            const modules = splitGPUDecoderModule(wholeCode, entryPoints);

            expect(modules, `${project} ${format}`).not.toBeNull();
            for (const entryPoint of entryPoints) {
                const module = modules?.get(entryPoint) ?? '';
                expect(module.split(LINE_BREAK), `${project} ${format} ${entryPoint}`).toHaveLength(wholeCode.split(LINE_BREAK).length);
                expect(findDeclarationNames(module).has(entryPoint), `${project} ${format} ${entryPoint}`).toBe(true);
                expect(findUndeclaredNames(module, wholeModuleNames), `${project} ${format} ${entryPoint}`).toEqual([]);
            }
        }
    });
});
