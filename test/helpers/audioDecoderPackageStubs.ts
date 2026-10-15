// The smallest audio decoder package parts the loader accepts: a header, and a module of the audio decoder interface whose exports return zero.
// The decoder package tests use them to tell package kinds apart, and route tests pass packages built from them along; they follow the audio decoder interface, so a change to that interface changes them.
import { createHash } from 'node:crypto';

import { parseAudioDecoderManifest } from 'webgpu-player/decode/audio/AudioDecoderManifest';
import { AUDIO_DECODER_EXPORTS } from 'webgpu-player/decode/audio/AudioDecoderPackageInstance';
import { DECODER_PACKAGE_SECTIONS, type AudioDecoderPackage } from 'webgpu-player/decode/packages/DecoderPackage';
import { DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } from 'webgpu-player/decode/packages/DecoderPackageImports';

import { createConstantFunctions, createMemoryImport, STUB_MODULE_MEMORY_PAGES } from './decoderPackages';
import { encodeWebAssemblyModule, type WebAssemblyModuleDefinition } from './webAssemblyModuleEncoder';

const TEST_AUDIO_DECODER_CODECS: readonly string[] = [ 'eac3' ];

/** The package id a test audio decoder header declares unless its caller names another. */
export const TEST_AUDIO_DECODER_ID = 'test-audio-decoder';

/** Returns the smallest audio decoder header the engine reads, accepting the codecs, with the package id; a null id leaves its directive out. */
export function createAudioDecoderSource(name: string, codecs: readonly string[] = TEST_AUDIO_DECODER_CODECS, id: string | null = TEST_AUDIO_DECODER_ID): string {
    return [
        ...(id === null ? [] : [ `//! id: ${id}` ]),
        `//! name: ${name}`,
        '//! decoder: audio',
        `//! accepts: codec in [${codecs.join(', ')}]`
    ].join('\n');
}

function createAudioDecoderStubDefinition(importsMemory: boolean): WebAssemblyModuleDefinition {
    const exportedResults = new Map<string, number>(Object.values(AUDIO_DECODER_EXPORTS).map((name: string): [ string, number ] => [ name, 0 ]));
    return {
        functions: createConstantFunctions(exportedResults),
        imports: importsMemory ? [ createMemoryImport() ] : []
    };
}

/** Returns an audio decoder module whose every export returns zero, with its memory import unless left out. */
export function createAudioDecoderStubModuleBinary(importsMemory: boolean = true): Uint8Array<ArrayBuffer> {
    return encodeWebAssemblyModule(createAudioDecoderStubDefinition(importsMemory));
}

/**
 * Returns the audio decoder package that a file of the stub module and a header accepting the codecs loads as, built in memory for code that only passes a package along.
 * Its id is the one its header declares, and its content hash the SHA-256 of that file, as the loader computes it.
 */
export function createAudioDecoderPackageForTest(name: string, codecs: readonly string[], id: string = TEST_AUDIO_DECODER_ID): AudioDecoderPackage {
    const source = createAudioDecoderSource(name, codecs, id);
    const bytes = encodeWebAssemblyModule({
        ...createAudioDecoderStubDefinition(true),
        customSections: [ { name: DECODER_PACKAGE_SECTIONS.decoder, payload: new TextEncoder().encode(source) } ]
    });
    return {
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        id,
        kind: 'audio',
        manifest: parseAudioDecoderManifest(source),
        memory: { initialPages: STUB_MODULE_MEMORY_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES },
        module: new WebAssembly.Module(bytes),
        name
    };
}
