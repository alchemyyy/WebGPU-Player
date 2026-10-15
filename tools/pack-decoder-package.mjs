#!/usr/bin/env node
// Packs a decoder package: a decoder source, the WebAssembly module of its code, and its self-test vectors, as the one .wasm file a host loads.
// The engine's own loader then checks the package, so a package this writes loads wherever the engine runs.
// Usage: node tools/pack-decoder-package.mjs --decoder <source> [--module <module.wasm>] [--vectors <vectors>] --output <package.wasm>
//   --decoder  the manifest and, for a video decoder, its WGSL
//   --module   the module of a video decoder's parser or of an audio decoder; a video decoder without one gets an empty module
//   --vectors  a video decoder's self-test vectors, as scripts/codec_vector_assets/generate_decoder_package_vectors.py writes them
//   --output   where the package is written
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { assembleDecoderPackage, checkDecoderPackage } from './decoder-package-format.mjs';

const USAGE = 'Usage: node tools/pack-decoder-package.mjs --decoder <source> [--module <module.wasm>] [--vectors <vectors>] --output <package.wasm>';

function readArguments() {
    const { values } = parseArgs({
        options: {
            decoder: { type: 'string' },
            module: { type: 'string' },
            output: { type: 'string' },
            vectors: { type: 'string' }
        },
        strict: true
    });
    if (!values.decoder || !values.output) {
        throw new Error(USAGE);
    }
    return values;
}

async function main() {
    const options = readArguments();
    const source = readFileSync(resolve(options.decoder), 'utf8');
    const moduleBinary = options.module ? new Uint8Array(readFileSync(resolve(options.module))) : null;
    const vectorsSection = options.vectors ? new Uint8Array(readFileSync(resolve(options.vectors))) : null;
    const packageBytes = assembleDecoderPackage(moduleBinary, source, vectorsSection);
    const decoderPackage = await checkDecoderPackage(packageBytes);
    const outputPath = resolve(options.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, packageBytes);
    console.log(`Packed ${decoderPackage.kind} decoder '${decoderPackage.name}' into ${outputPath} (${packageBytes.byteLength} bytes, id ${decoderPackage.id})`);
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
