import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePassFile, parsePassManifest } from 'webgpu-player/presentation/passes/PassManifest';
import type { PassInput, PassManifest, PassShape } from 'webgpu-player/presentation/passes/PassTypes';

import { PASSES_DIRECTORY } from '../../helpers/enginePaths';
import { readPostprocessingPass, readPostprocessingPasses, type PostprocessingPassFile } from '../../helpers/postprocessingPasses';

const ENTRY_POINTS: Readonly<Record<PassShape, string>> = {
    color: 'fn apply(color: vec4f, position: vec2f) -> vec4f {',
    compute: 'fn compute(id: vec3u) {',
    kernel: 'fn kernel(coordinate: vec2f) -> vec4f {',
    scaler: 'fn scale(coordinate: vec2f) -> vec4f {'
};
const PARAMETER_REFERENCE_PATTERN = /\bparameters\.(\w+)/g;
const PRESENTATION_REFERENCE_PATTERN = /\bpresentation\.(\w+)/g;
const ENGINE_ACCESS_PATTERN = /@group|@binding|renderSettings|textureSample|textureLoad/;
// History N of an input has the accessors of <NAME>_history<N>, such as RGB_history1_tex for RGB[-1]
const HISTORY_ACCESSOR_INFIX = '_history';
// An input's accessors: its samples, and its size and texel size, which a compute pass may read alone
const INPUT_ACCESSOR_SUFFIX_PATTERN = '_(tex|texOff|size|pt)\\(';
// The fields of PassResources' presentation uniform that passes read: history, and the output size NIS's port reads as mpv's target_size
const PRESENTATION_FIELDS: readonly string[] = [ 'historyValid', 'outputSize' ];
// The header ends with a blank line, so the body starts with a line break
const BODY_START = '\n';
// The pass projects every engine build carries
const EXPECTED_PROJECTS: readonly string[] = [ 'anime4k', 'catmull-rom', 'nis', 'saturation', 'sharpen', 'temporal-blend' ];

const TEMPORAL_BLEND_PROJECT = 'temporal-blend';
const TEMPORAL_BLEND_FILE = 'temporal-blend.wgsl';
const TEMPORAL_HOOK = 'RGB';
const TEMPORAL_INPUTS: readonly PassInput[] = [
    { historyOffset: 0, name: 'HOOKED' },
    { historyOffset: -1, name: 'RGB' }
];
const HISTORY_VALID_READ = 'presentation.historyValid';

// The upstream files the Anime4K and NIS projects copy unmodified, with their SHA-256, as their PROVENANCE.txt files list them
const UPSTREAM_SOURCE_DIGESTS: ReadonlyArray<readonly [path: string, digest: string]> = [
    [ 'anime4k/glsl/Anime4K_Upscale_Denoise_CNN_x2_L.glsl', '6cc4604c9544fd4fd9e3a75fd797511bf5fe1e626e9e1dbcee03302823a63207' ],
    [ 'anime4k/glsl/Anime4K_Upscale_Denoise_CNN_x2_UL.glsl', '38bd11e7e92ff1a615a274be912d6f2cfe67f5b43771f0383a91c6ab3d0f8cb6' ],
    [ 'licenses/Anime4K-LICENSE', '5bad448b737378e3d0c977ad0d0521fa37ad279a7e76ea9a31d9257eeb6953f5' ],
    [ 'nis/glsl/NVScaler.glsl', 'bac778ec0108d272e4dad97794a3c257e65bbebd52aa762f95bce930cbd6b73c' ],
    [ 'nis/glsl/NVSharpen.glsl', '3d51ac2a9da18284c1f77e46a019e783eac0c609924e6b32e8011889f54f9a12' ],
    [ 'licenses/NIS-LICENSE', '62207f1c0fae72800ea7d28ee108e7dbeb852dde20b00c70fc7b0d235e19e46d' ]
];

const PASS_FILES: readonly PostprocessingPassFile[] = readPostprocessingPasses();

function sortNames(names: Iterable<string>): string[] {
    return [ ...names ].sort((first: string, second: string): number => first.localeCompare(second));
}

/** Returns the prefix of an input's accessors: its name, or <NAME>_history<N> for history N. */
function getAccessorPrefix(input: PassInput): string {
    return input.historyOffset === 0 ? input.name : `${input.name}${HISTORY_ACCESSOR_INFIX}${-input.historyOffset}`;
}

/** Returns a file's passes, failing on the first header that does not parse. */
function requireManifests(passFile: PostprocessingPassFile): PassManifest[] {
    return parsePassFile(passFile.source).map(entry => {
        if (entry.error) {
            throw entry.error;
        }
        return entry.manifest;
    });
}

describe('the pass projects', () => {
    it('hold the bundled projects', () => {
        expect(sortNames(new Set(PASS_FILES.map(passFile => passFile.project)))).toEqual(EXPECTED_PROJECTS);
    });

    it('name each pass file once, as the build copies them into one folder', () => {
        const fileNames = PASS_FILES.map(passFile => passFile.fileName);

        expect(new Set(fileNames).size).toBe(fileNames.length);
    });
});

describe.each(PASS_FILES)('the pass file $project/$fileName', passFile => {
    it('parses every pass of the file', () => {
        expect(parsePassFile(passFile.source).every(entry => entry.error === null)).toBe(true);
    });

    it.each(requireManifests(passFile).map(manifest => [ manifest.name, manifest ] as const))('%s follows the pass rules', (_name, manifest) => {
        expect(manifest.body.startsWith(BODY_START)).toBe(true);
        expect(manifest.body).toContain(ENTRY_POINTS[manifest.shape]);

        const readParameterNames = new Set([ ...manifest.body.matchAll(PARAMETER_REFERENCE_PATTERN) ].map(match => match[1]));
        expect(sortNames(readParameterNames)).toEqual(sortNames(manifest.parameters.map(parameter => parameter.name)));

        for (const input of manifest.inputs) {
            expect(manifest.body).toMatch(new RegExp(String.raw`\b${getAccessorPrefix(input)}${INPUT_ACCESSOR_SUFFIX_PATTERN}`));
        }
        for (const match of manifest.body.matchAll(PRESENTATION_REFERENCE_PATTERN)) {
            expect(PRESENTATION_FIELDS).toContain(match[1]);
        }
        expect(manifest.body).not.toMatch(ENGINE_ACCESS_PATTERN);
    });
});

describe('the temporal blend kernel', () => {
    it('reads the previous frame of the RGB stage it hooks', () => {
        const manifest = parsePassManifest(readPostprocessingPass(TEMPORAL_BLEND_PROJECT, TEMPORAL_BLEND_FILE));

        expect(manifest.hook).toBe(TEMPORAL_HOOK);
        expect(manifest.inputs).toEqual(TEMPORAL_INPUTS);
        expect(manifest.body).toContain(HISTORY_VALID_READ);
    });
});

describe('the projects that copy upstream shaders', () => {
    it.each(UPSTREAM_SOURCE_DIGESTS)('keep %s as upstream wrote it', (path, digest) => {
        expect(createHash('sha256').update(new Uint8Array(readFileSync(join(PASSES_DIRECTORY, path)))).digest('hex')).toBe(digest);
    });
});
