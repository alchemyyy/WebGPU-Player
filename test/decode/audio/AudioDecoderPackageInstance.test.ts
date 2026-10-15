// @vitest-environment node
// The interface checks on stub modules; each audio decoder project's tests run its own package

import { describe, expect, it } from 'vitest';

import { parseAudioDecoderManifest } from 'webgpu-player/decode/audio/AudioDecoderManifest';
import AudioDecoderPackageInstance, {
    AUDIO_DECODER_ABI_VERSION,
    AUDIO_DECODER_EXPORTS,
    AudioDecoderPackageError,
    findMissingAudioDecoderExports,
    isAudioDecoderModuleSource,
    isAudioDecoderPackageSelection,
    type AudioDecoderModuleSource
} from 'webgpu-player/decode/audio/AudioDecoderPackageInstance';
import { CUSTOM_WAVE_CHANNEL_MASK_MONO } from 'webgpu-player/audio/processing/CustomWaveChannelLayout';
import { DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } from 'webgpu-player/decode/packages/DecoderPackageImports';

import { catchFailure } from '../../helpers/audioDecoderPackageResults';
import { PACKAGE_MEMORY_IMPORT_MODULE, PACKAGE_MEMORY_IMPORT_NAME } from '../../helpers/decoderPackages';
import {
    encodeI32Const,
    encodeWebAssemblyModule,
    type WebAssemblyFunctionDefinition,
    type WebAssemblyImportDefinition
} from '../../helpers/webAssemblyModuleEncoder';

type AudioDecoderExportKey = keyof typeof AUDIO_DECODER_EXPORTS;

const PCM_FINGERPRINT_OPTION = 'pcmFingerprint';
const OPTION_ENABLED = 1;
const OPTION_ERROR = 'option';
const SAMPLE_RATE = 48_000;
const SINGLE_BYTE_PACKET = Uint8Array.of(1);
const CODEC_PRIVATE_BYTES = Uint8Array.of(1, 2, 3, 4);
// Stub modules: a memory of one page, a live handle, and where they say their input and planes sit
const STUB_MEMORY_PAGES = 1;
const STUB_MEMORY_BYTE_LENGTH = 65_536;
const STUB_HANDLE = 16;
const STUB_INPUT_POINTER = 1_024;
const STUB_PLANE_POINTER = 2_048;
const STUB_CODEC = 'eac3';
const STUB_OTHER_CODEC = 'dts';
const STUB_DECODER_NAME = 'Stub';
const STUB_SEND_ERROR_CODE = 2;
const STUB_SEND_ERROR_NAME = 'send';
const STUB_UNNAMED_ERROR_CODE = 9;
const STUB_ERROR_VALUE = 22;
const STUB_MANIFEST_SOURCE = [
    '//! id: stub-decoder',
    `//! name: ${STUB_DECODER_NAME}`,
    '//! decoder: audio',
    `//! accepts: codec in [${STUB_CODEC}]`,
    `//! option: 1, ${PCM_FINGERPRINT_OPTION}`,
    `//! error: ${STUB_SEND_ERROR_CODE}, ${STUB_SEND_ERROR_NAME}`
].join('\n');
// Interface statuses a stub returns
const SUCCESS_STATUS = 0;
const FAILED_STATUS = -1;
const RECEIVE_NONE = 0;
const RECEIVE_READY = 1;
// Statuses the interface does not define, which the instance treats as failures
const UNDEFINED_SEND_STATUS = 3;
const UNDEFINED_RECEIVE_STATUS = 2;
const NO_TIMESTAMP = -1;
const OTHER_ABI_VERSION = AUDIO_DECODER_ABI_VERSION + 1;
// One past the most frames and channels a block holds
const OVERSIZED_FRAME_COUNT = 65_537;
const OVERSIZED_CHANNEL_COUNT = 33;
// Plane pointers outside a stub's memory: none, unaligned, past its end, and one that reads as a negative i32
const MISALIGNED_PLANE_POINTER = STUB_PLANE_POINTER + 2;
const OVERRUNNING_PLANE_POINTER = STUB_MEMORY_BYTE_LENGTH - 2;
const NEGATIVE_I32_PLANE_POINTER = -4;
const OMITTED_EXPORTS: readonly AudioDecoderExportKey[] = [ 'clear', 'timestamp' ];
// Malformed module sources, as a worker boundary could deliver them
const OVERSIZED_PACKET_BYTE_LENGTH = 16 * 1_024 * 1_024 + 1;
const FRACTIONAL_KEY = 1.5;
const INVERTED_MEMORY_LIMITS = { initialPages: 2, maximumPages: 1 };
const UNBOUNDED_MEMORY_LIMITS = { initialPages: 1, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES + 1 };

const STUB_RESULTS: Readonly<Record<AudioDecoderExportKey, number>> = Object.freeze({
    abiVersion: AUDIO_DECODER_ABI_VERSION,
    attribute: 0,
    channelCount: 1,
    channelMask: CUSTOM_WAVE_CHANNEL_MASK_MONO,
    channelPointer: STUB_PLANE_POINTER,
    clear: SUCCESS_STATUS,
    configure: SUCCESS_STATUS,
    create: STUB_HANDLE,
    destroy: SUCCESS_STATUS,
    errorCode: STUB_SEND_ERROR_CODE,
    errorValue: STUB_ERROR_VALUE,
    frameCount: 1,
    receive: RECEIVE_NONE,
    reserveInput: STUB_INPUT_POINTER,
    sampleRate: SAMPLE_RATE,
    send: SUCCESS_STATUS,
    setOption: SUCCESS_STATUS,
    timestamp: NO_TIMESTAMP
});

const STUB_MEMORY_IMPORT: WebAssemblyImportDefinition = {
    kind: 'memory',
    limits: { initialPages: STUB_MEMORY_PAGES },
    module: PACKAGE_MEMORY_IMPORT_MODULE,
    name: PACKAGE_MEMORY_IMPORT_NAME
};

/** A module of the audio decoder interface whose exports return constants: the stub defaults, as overridden, less the omitted exports. */
function createStubModule(
    results: Partial<Record<AudioDecoderExportKey, number>> = {},
    omittedExports: readonly AudioDecoderExportKey[] = [],
    importsMemory: boolean = true
): WebAssembly.Module {
    const functions: WebAssemblyFunctionDefinition[] = [];
    for (const [ key, name ] of Object.entries(AUDIO_DECODER_EXPORTS) as [ AudioDecoderExportKey, string ][]) {
        if (!omittedExports.includes(key)) {
            functions.push({ body: encodeI32Const(results[key] ?? STUB_RESULTS[key]), name, results: [ 'i32' ] });
        }
    }
    return new WebAssembly.Module(encodeWebAssemblyModule({ functions, imports: importsMemory ? [ STUB_MEMORY_IMPORT ] : [] }));
}

function createStubSource(results: Partial<Record<AudioDecoderExportKey, number>> = {}): AudioDecoderModuleSource {
    return {
        manifest: parseAudioDecoderManifest(STUB_MANIFEST_SOURCE),
        memory: { initialPages: STUB_MEMORY_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES },
        module: createStubModule(results)
    };
}

function createStubInstance(results: Partial<Record<AudioDecoderExportKey, number>> = {}): Promise<AudioDecoderPackageInstance> {
    return AudioDecoderPackageInstance.create(createStubSource(results), STUB_CODEC);
}

describe('AudioDecoderPackageInstance on a module that breaks the interface', () => {
    it('lists the exports a module lacks, in the interface\'s order', () => {
        expect(findMissingAudioDecoderExports(createStubModule())).toEqual([]);
        expect(findMissingAudioDecoderExports(createStubModule({}, OMITTED_EXPORTS)))
            .toEqual(OMITTED_EXPORTS.map(key => AUDIO_DECODER_EXPORTS[key]));
    });

    it('refuses a codec its manifest does not list', async () => {
        await expect(AudioDecoderPackageInstance.create(createStubSource(), STUB_OTHER_CODEC))
            .rejects.toThrow(new RangeError(`audio decoder ${STUB_DECODER_NAME} decodes no ${STUB_OTHER_CODEC}`));
    });

    it('refuses a module of another interface version, without an export, or without a decoder', async () => {
        await expect(createStubInstance({ abiVersion: OTHER_ABI_VERSION }))
            .rejects.toThrow(new TypeError(`audio decoder interface ${OTHER_ABI_VERSION}, the engine drives ${AUDIO_DECODER_ABI_VERSION}`));
        await expect(AudioDecoderPackageInstance.create({ ...createStubSource(), module: createStubModule({}, OMITTED_EXPORTS) }, STUB_CODEC))
            .rejects.toThrow(new TypeError(`audio decoder export ${AUDIO_DECODER_EXPORTS.clear} is missing`));
        await expect(createStubInstance({ create: 0 }))
            .rejects.toThrow(new TypeError(`audio decoder create returned no decoder for ${STUB_CODEC}`));
    });

    it('refuses a source whose module imports no memory', async () => {
        const source: AudioDecoderModuleSource = { ...createStubSource(), memory: null, module: createStubModule({}, [], false) };

        await expect(AudioDecoderPackageInstance.create(source, STUB_CODEC)).rejects.toThrow(new TypeError('audio decoder module imports no memory'));
    });

    it('refuses input the module declines to reserve', async () => {
        const instance = await createStubInstance({ reserveInput: 0 });

        expect(() => instance.decode(SINGLE_BYTE_PACKET, 0)).toThrow(new RangeError(`audio decoder reserve_input refused ${SINGLE_BYTE_PACKET.byteLength} bytes`));
        expect(() => instance.configure(CODEC_PRIVATE_BYTES))
            .toThrow(new RangeError(`audio decoder reserve_input refused ${CODEC_PRIVATE_BYTES.byteLength} bytes`));
    });

    it.each([
        [ 'a failed send', { send: FAILED_STATUS } ],
        [ 'a send status the interface does not define', { send: UNDEFINED_SEND_STATUS } ],
        [ 'a failed receive', { receive: FAILED_STATUS } ],
        [ 'a receive status the interface does not define', { receive: UNDEFINED_RECEIVE_STATUS } ]
    ])('reports %s by the error the module names', async (_description, results) => {
        const instance = await createStubInstance(results);

        const failure = catchFailure(() => instance.decode(SINGLE_BYTE_PACKET, 0));

        expect(failure).toBeInstanceOf(AudioDecoderPackageError);
        expect(failure).toMatchObject({
            code: STUB_SEND_ERROR_CODE,
            message: `audio decoder ${STUB_SEND_ERROR_NAME}: ${STUB_ERROR_VALUE}`,
            value: STUB_ERROR_VALUE
        });
    });

    it('reports a failed configure or option, and names an error code the manifest does not', async () => {
        const instance = await createStubInstance({ configure: FAILED_STATUS, errorCode: STUB_UNNAMED_ERROR_CODE, setOption: FAILED_STATUS });
        const unnamedError = new AudioDecoderPackageError(STUB_UNNAMED_ERROR_CODE, STUB_ERROR_VALUE, new Map());

        expect(unnamedError.message).toBe(`audio decoder code ${STUB_UNNAMED_ERROR_CODE}: ${STUB_ERROR_VALUE}`);
        expect(() => instance.configure(CODEC_PRIVATE_BYTES)).toThrow(unnamedError);
        expect(() => instance.setOption(PCM_FINGERPRINT_OPTION, OPTION_ENABLED)).toThrow(unnamedError);
    });

    it('stops a module that hands over more blocks than its packet has bytes', async () => {
        const instance = await createStubInstance({ receive: RECEIVE_READY });

        expect(() => instance.decode(SINGLE_BYTE_PACKET, 0)).toThrow(new RangeError(`audio decoder output exceeded what ${SINGLE_BYTE_PACKET.byteLength} bytes hold`));
    });

    it.each([
        [ { frameCount: 0 }, 'audio decoder block of 0 frames' ],
        [ { frameCount: OVERSIZED_FRAME_COUNT }, `audio decoder block of ${OVERSIZED_FRAME_COUNT} frames` ],
        [ { sampleRate: 0 }, 'audio decoder sample rate 0' ],
        [ { channelCount: 0 }, 'audio decoder channel count 0' ],
        [ { channelCount: OVERSIZED_CHANNEL_COUNT }, `audio decoder channel count ${OVERSIZED_CHANNEL_COUNT}` ],
        [ { channelPointer: 0 }, 'audio decoder channel 0 at 0 outside its memory' ],
        [ { channelPointer: MISALIGNED_PLANE_POINTER }, `audio decoder channel 0 at ${MISALIGNED_PLANE_POINTER} outside its memory` ],
        [ { channelPointer: OVERRUNNING_PLANE_POINTER }, `audio decoder channel 0 at ${OVERRUNNING_PLANE_POINTER} outside its memory` ],
        [ { channelPointer: NEGATIVE_I32_PLANE_POINTER }, `audio decoder channel 0 at ${NEGATIVE_I32_PLANE_POINTER >>> 0} outside its memory` ]
    ])('refuses a block the module describes out of bounds %#', async (results, message) => {
        const instance = await createStubInstance({ ...results, receive: RECEIVE_READY });

        expect(() => instance.decode(SINGLE_BYTE_PACKET, 0)).toThrow(new RangeError(message));
    });
});

describe('audio decoder module source validation', () => {
    it('accepts a stub source, and one whose module imports no memory', () => {
        const source = createStubSource();

        expect(isAudioDecoderModuleSource(source)).toBe(true);
        expect(isAudioDecoderModuleSource({ ...source, memory: null })).toBe(true);
    });

    it('rejects a source without a compiled module, bounded memory, or a manifest\'s shape', () => {
        const source = createStubSource();
        const { manifest } = source;
        const malformedSources: readonly unknown[] = [
            null,
            { ...source, module: new ArrayBuffer(1) },
            { ...source, memory: INVERTED_MEMORY_LIMITS },
            { ...source, memory: UNBOUNDED_MEMORY_LIMITS },
            { ...source, manifest: null },
            { ...source, manifest: { ...manifest, name: null } },
            { ...source, manifest: { ...manifest, codecs: [ STUB_CODEC, 1 ] } },
            { ...source, manifest: { ...manifest, attributes: Object.fromEntries(manifest.attributes) } },
            { ...source, manifest: { ...manifest, errors: new Map([ [ FRACTIONAL_KEY, OPTION_ERROR ] ]) } },
            { ...source, manifest: { ...manifest, options: undefined } },
            { ...source, manifest: { ...manifest, packetByteLength: 0 } },
            { ...source, manifest: { ...manifest, packetByteLength: OVERSIZED_PACKET_BYTE_LENGTH } }
        ];

        for (const [ sourceIndex, malformedSource ] of malformedSources.entries()) {
            expect(isAudioDecoderModuleSource(malformedSource), `source ${sourceIndex}`).toBe(false);
        }
    });

    it('accepts a selection of a codec its manifest lists, and no other', () => {
        const source = createStubSource();

        expect(isAudioDecoderPackageSelection({ codec: STUB_CODEC, source })).toBe(true);
        expect(isAudioDecoderPackageSelection({ codec: STUB_OTHER_CODEC, source })).toBe(false);
        expect(isAudioDecoderPackageSelection({ codec: null, source })).toBe(false);
        expect(isAudioDecoderPackageSelection({ codec: STUB_CODEC, source: { ...source, module: null } })).toBe(false);
        expect(isAudioDecoderPackageSelection(null)).toBe(false);
    });
});
