import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { type PassFileEntry, parsePassFile, parsePassManifest } from 'webgpu-player/presentation/passes/PassManifest';
import type { PassTexture } from 'webgpu-player/presentation/passes/PassTypes';

const LF = '\n';
const LUT_NAME = 'LUT';
const WEIGHTS_NAME = 'weights';
// A 2x2x2 RGBA 8-bit cube and a 3x1 table of 16-bit float pairs
const LUT_SIZE = 2;
const RGBA8_BYTES_PER_TEXEL = 4;
const LUT_BYTES = Uint8Array.from({ length: LUT_SIZE ** 3 * RGBA8_BYTES_PER_TEXEL }, (_value: unknown, index: number): number => index);
const WEIGHT_COUNT = 3;
const RG16FLOAT_BYTES_PER_TEXEL = 4;
const WEIGHT_BYTES = new Uint8Array(WEIGHT_COUNT * RG16FLOAT_BYTES_PER_TEXEL).fill(1);
// base64 splits across lines, which the parser joins
const BASE64_LINE_LENGTH = 12;

const COLOR_PASS_LINES: readonly string[] = [
    '//! name: Grade',
    '//! shape: color',
    '//! hook: OUTPUT',
    `//! bind: ${LUT_NAME}`,
    '',
    'fn apply(color: vec4f, position: vec2f) -> vec4f {',
    `    return ${LUT_NAME}_tex(color.rgb);`,
    '}'
];

function encodeBase64Lines(bytes: Uint8Array): string[] {
    const text = Buffer.from(bytes).toString('base64');
    const lines: string[] = [];
    for (let offset = 0; offset < text.length; offset += BASE64_LINE_LENGTH) {
        lines.push(text.slice(offset, offset + BASE64_LINE_LENGTH));
    }
    return lines;
}

function createTextureBlock(headerLines: readonly string[], bytes: Uint8Array): string[] {
    return [ ...headerLines, '', ...encodeBase64Lines(bytes) ];
}

const LUT_BLOCK = createTextureBlock([
    `//! texture: ${LUT_NAME}`,
    `//! size: ${LUT_SIZE}, ${LUT_SIZE}, ${LUT_SIZE}`,
    '//! format: rgba8unorm',
    '//! filter: linear',
    '//! edge: clamp'
], LUT_BYTES);

// The LUT block's header lines; its body, which a data error names, starts after them
const LUT_BLOCK_HEADER_LENGTH = 5;

function getExpectedIdentity(size: readonly number[], format: string, bytes: Uint8Array): string {
    return createHash('sha256').update(`${[ ...size, format ].join(LF)}${LF}`).update(bytes).digest('hex');
}

function requireError(entries: readonly PassFileEntry[], index: number): string {
    const error = entries[index].error;
    if (error === null) {
        throw new Error(`Entry ${index} parsed`);
    }
    return `line ${error.line}: ${error.message}`;
}

describe('pass file texture blocks', () => {
    it('reads a texture block anywhere in the file into the passes that bind it, keyed by its content identity', () => {
        const manifest = parsePassManifest([ ...COLOR_PASS_LINES, ...LUT_BLOCK ].join(LF));

        expect(manifest.textures).toHaveLength(1);
        expect(manifest.textures[0]).toEqual({
            data: LUT_BYTES,
            dimensions: 3,
            edge: 'clamp',
            filter: 'linear',
            format: 'rgba8unorm',
            identity: getExpectedIdentity([ LUT_SIZE, LUT_SIZE, LUT_SIZE ], 'rgba8unorm', LUT_BYTES),
            name: LUT_NAME,
            size: [ LUT_SIZE, LUT_SIZE, LUT_SIZE ]
        } satisfies PassTexture);
    });

    it('takes mpv\'s nearest filter and clamped edge by default, and 1 on the axes past the size', () => {
        const weights = createTextureBlock([ `//! texture: ${WEIGHTS_NAME}`, `//! size: ${WEIGHT_COUNT}`, '//! format: rg16float' ], WEIGHT_BYTES);
        const pass = COLOR_PASS_LINES.map((line: string): string => line.replaceAll(LUT_NAME, WEIGHTS_NAME));
        const [ texture ] = parsePassManifest([ ...weights, ...pass ].join(LF)).textures;

        expect(texture).toMatchObject({ dimensions: 1, edge: 'clamp', filter: 'nearest', size: [ WEIGHT_COUNT, 1, 1 ] });
    });

    it('is no entry of its own, and a file of texture blocks alone has no pass', () => {
        const entries = parsePassFile([ ...LUT_BLOCK, ...COLOR_PASS_LINES ].join(LF));

        expect(entries).toHaveLength(1);
        expect(entries[0].manifest?.name).toBe('Grade');
        expect(requireError(parsePassFile(LUT_BLOCK.join(LF)), 0)).toBe('line 1: The file holds texture blocks but no pass');
    });

    it('fails a pass that binds a texture the file lacks, a block that does not parse, or a name an input takes', () => {
        const shortBlock = createTextureBlock(LUT_BLOCK.slice(0, LUT_BLOCK_HEADER_LENGTH), LUT_BYTES.slice(1));
        const inputPass = [ '//! name: Reader', '//! shape: kernel', '//! hook: OUTPUT', `//! input: ${LUT_NAME}`, `//! bind: ${LUT_NAME}`, '' ];
        const sourceLength = COLOR_PASS_LINES.length;

        expect(requireError(parsePassFile(COLOR_PASS_LINES.join(LF)), 0)).toBe(
            `line 4: Unknown texture '${LUT_NAME}'; the file has no texture block of that name`
        );
        expect(requireError(parsePassFile([ ...COLOR_PASS_LINES, ...shortBlock ].join(LF)), 0)).toBe(
            `line 4: Texture '${LUT_NAME}' does not parse: line ${sourceLength + LUT_BLOCK_HEADER_LENGTH + 1}: The texture data holds ${LUT_BYTES.byteLength - 1} bytes; 2x2x2 rgba8unorm needs ${LUT_BYTES.byteLength}`
        );
        expect(requireError(parsePassFile([ ...inputPass, ...LUT_BLOCK ].join(LF)), 0)).toBe(`line 5: '${LUT_NAME}' names both an input and a texture`);
    });

    it('rejects a texture block\'s malformed header, format, size, or data', () => {
        const cases: readonly { block: string[]; message: string }[] = [
            { block: createTextureBlock([ `//! texture: ${LUT_NAME}`, '//! format: rgba8unorm' ], LUT_BYTES), message: "Missing required directive 'size'" },
            { block: createTextureBlock([ `//! texture: ${LUT_NAME}`, '//! size: 2, 0', '//! format: rgba8unorm' ], LUT_BYTES), message: "Expected 'size: <width>[, <height>[, <depth>]]' positive integers" },
            { block: createTextureBlock([ `//! texture: ${LUT_NAME}`, '//! size: 8', '//! format: rgb9e5ufloat' ], LUT_BYTES), message: "Unknown texture format 'rgb9e5ufloat'" },
            { block: [ `//! texture: ${LUT_NAME}`, '//! size: 8', '//! format: rgba8unorm', '', '!!!' ], message: 'The texture data is not base64' },
            { block: createTextureBlock([ `//! texture: ${LUT_NAME}`, '//! size: 8', '//! format: rgba8unorm', '//! shape: kernel' ], LUT_BYTES), message: 'Expected a texture directive' }
        ];
        for (const { block, message } of cases) {
            expect(requireError(parsePassFile([ ...COLOR_PASS_LINES, ...block ].join(LF)), 0)).toContain(message);
        }
    });
});
