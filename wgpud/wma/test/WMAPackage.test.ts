// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { beforeAll, describe, expect, it } from 'vitest';

import AudioDecoderPackageInstance, {
    AudioDecoderPackageError,
    findMissingAudioDecoderExports,
    isAudioDecoderModuleSource,
    isAudioDecoderPackageSelection,
    type AudioDecoderModuleSource,
    type AudioDecoderPackageBlock
} from 'webgpu-player/decode/audio/AudioDecoderPackageInstance';
import PackageSoftwareAudioDecoder from 'webgpu-player/decode/audio/PackageSoftwareAudioDecoder';
import { readWaveFormatAudioTrack } from 'webgpu-player/demux/WaveFormatAudioConfiguration';

import {
    catchFailure,
    getAudioDecoderErrorCode,
    readContainerAudioPackets,
    requireDecodedBlocks,
    type EncodedAudioPacket
} from '../../../test/helpers/audioDecoderPackageResults';
import { loadDecoderProjectAudioSource } from '../../../test/helpers/decoderPackages';
import { DECODERS_DIRECTORY } from '../../../test/helpers/enginePaths';

const PROJECT = 'wma';
// The codecs the package decodes, by the names its manifest gives them, and one it does not
const CODECS = [ 'wmav1', 'wmav2', 'wmapro', 'wmalossless', 'wmavoice' ];
const OTHER_CODEC = 'aac';
const DECODER_NAME = 'WMA';
const LIBRARY_VERSION_ATTRIBUTE = 'libraryVersion';
// The vectors and FFmpeg's known answers for them, which scripts/codec_vector_assets/generate_wma_decoder_vectors.py writes
const VECTOR_DIRECTORY = join(DECODERS_DIRECTORY, PROJECT, 'vectors');
const KNOWN_ANSWERS_FILE_NAME = 'known-answers.json';
const WMAV1_MATROSKA_FILE = 'wmav1.mkv';
const WMAV1_AVI_FILE = 'wmav1.avi';
const WMAV2_MATROSKA_FILE = 'wmav2.mkv';
const WMAV2_AVI_FILE = 'wmav2.avi';
const WMAPRO_FILE = 'wmapro-5.1.mkv';
const WMALOSSLESS_FILE = 'wmalossless-24.mkv';
// The bridge's error names
const UNCONFIGURED_ERROR = 'unconfigured';
const WAVE_FORMAT_ERROR = 'waveFormat';
const FORMAT_TAG_ERROR = 'formatTag';
const OPEN_ERROR = 'open';
// The WAVEFORMATEX fields the refusals rewrite, little endian
const WAVE_FORMAT_HEADER_BYTE_LENGTH = 18;
const BLOCK_ALIGN_OFFSET = 12;
const EXTENSION_SIZE_OFFSET = 16;
const WAVE_FORMAT_EXTENSIBLE_TAG = 0xFFFE;
const WAVE_FORMAT_EXTENSIBLE_BYTE_LENGTH = 22;
const WMAV2_FORMAT_TAG = 0x0161;
const WMAPRO_FORMAT_TAG = 0x0162;
const FLOAT_BYTE_LENGTH = 4;

/** FFmpeg's decode of a vector: its layout, and the frame count and SHA-256 of its interleaved 32-bit float PCM. */
type KnownAnswer = Readonly<{
    channelCount: number
    channelMask: number
    codec: string
    file: string
    frameCount: number
    pcmSHA256: string
    sampleRate: number
}>;

/** A vector's packets and the WAVEFORMATEX the engine reads from its track. */
type WMAVector = Readonly<{ codec: string, packets: EncodedAudioPacket[], waveFormat: Uint8Array }>;

let source: AudioDecoderModuleSource;
let knownAnswers: KnownAnswer[];
const vectors = new Map<string, WMAVector>();

/** Reads a vector's WAVEFORMATEX as the engine does, through readWaveFormatAudioTrack, and its packets. */
async function readVector(file: string): Promise<WMAVector> {
    const bytes = new Uint8Array(readFileSync(join(VECTOR_DIRECTORY, file)));
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
    try {
        const [ track ] = await input.getAudioTracks();
        const result = readWaveFormatAudioTrack(track);
        if (result?.status !== 'read') {
            throw new Error(`${file} has no WAVEFORMATEX the engine reads: ${JSON.stringify(result)}`);
        }
        return { codec: result.codec, packets: await readContainerAudioPackets(bytes), waveFormat: result.waveFormat };
    } finally {
        input.dispose();
    }
}

function requireVector(file: string): WMAVector {
    const vector = vectors.get(file);
    if (!vector) {
        throw new Error(`No vector ${file}`);
    }
    return vector;
}

/** Returns blocks' planes interleaved, as FFmpeg writes f32le. */
function interleaveBlocks(blocks: readonly AudioDecoderPackageBlock[]): Float32Array {
    const samples = new Float32Array(blocks.reduce((sum, block) => sum + block.frameCount * block.channelData.length, 0));
    let offset = 0;
    for (const block of blocks) {
        const channelCount = block.channelData.length;
        for (let frameIndex = 0; frameIndex < block.frameCount; frameIndex += 1) {
            for (let channel = 0; channel < channelCount; channel += 1) {
                samples[offset + frameIndex * channelCount + channel] = block.channelData[channel][frameIndex];
            }
        }
        offset += block.frameCount * channelCount;
    }
    return samples;
}

/** Decodes every packet of a vector on a configured decoder of its codec. */
async function decodeVector(vector: WMAVector): Promise<AudioDecoderPackageBlock[]> {
    const instance = await AudioDecoderPackageInstance.create(source, vector.codec);
    try {
        instance.configure(vector.waveFormat);
        const blocks = vector.packets.flatMap(packet => requireDecodedBlocks(instance.decode(packet.data, packet.timestampMicroseconds)));
        return [ ...blocks, ...instance.drain() ];
    } finally {
        instance.close();
    }
}

/** Returns a copy of a WAVEFORMATEX with one 16-bit field rewritten. */
function rewriteField(waveFormat: Uint8Array, offset: number, value: number): Uint8Array {
    const rewritten = waveFormat.slice();
    new DataView(rewritten.buffer).setUint16(offset, value, true);
    return rewritten;
}

/** Returns what configuring a new decoder of a codec with a WAVEFORMATEX throws. */
async function catchConfigureFailure(codec: string, waveFormat: Uint8Array): Promise<unknown> {
    const instance = await AudioDecoderPackageInstance.create(source, codec);
    try {
        return catchFailure(() => instance.configure(waveFormat));
    } finally {
        instance.close();
    }
}

function expectPackageError(failure: unknown, name: string, value: number): void {
    expect(failure).toBeInstanceOf(AudioDecoderPackageError);
    expect(failure).toMatchObject({
        code: getAudioDecoderErrorCode(source.manifest, name),
        message: `audio decoder ${name}: ${value}`,
        value
    });
}

/** Reads the known answers file, requiring each answer's fields. */
function readKnownAnswers(): KnownAnswer[] {
    const document: unknown = JSON.parse(readFileSync(join(VECTOR_DIRECTORY, KNOWN_ANSWERS_FILE_NAME), 'utf8'));
    const answers: unknown = typeof document === 'object' && document !== null && 'vectors' in document ? document.vectors : null;
    if (!Array.isArray(answers) || !answers.every(isKnownAnswer)) {
        throw new Error(`${KNOWN_ANSWERS_FILE_NAME} holds no known answers`);
    }
    return answers;
}

function isKnownAnswer(value: unknown): value is KnownAnswer {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const fields = new Map(Object.entries(value));
    return [ 'codec', 'file', 'pcmSHA256' ].every(name => typeof fields.get(name) === 'string')
        && [ 'channelCount', 'channelMask', 'frameCount', 'sampleRate' ].every(name => Number.isSafeInteger(fields.get(name)));
}

beforeAll(async () => {
    source = await loadDecoderProjectAudioSource(PROJECT);
    knownAnswers = readKnownAnswers();
    for (const answer of knownAnswers) {
        vectors.set(answer.file, await readVector(answer.file));
    }
});

describe('the WMA package on AudioDecoderPackageInstance', () => {
    it('has every export of the interface, and a source and selections the engine accepts', () => {
        expect(findMissingAudioDecoderExports(source.module)).toEqual([]);
        expect(isAudioDecoderModuleSource(source)).toBe(true);
        expect(source.manifest.codecs).toEqual(CODECS);
        expect(CODECS.every(codec => isAudioDecoderPackageSelection({ codec, source }))).toBe(true);
        expect(isAudioDecoderPackageSelection({ codec: OTHER_CODEC, source })).toBe(false);
    });

    it.each(CODECS)('creates a %s decoder that reports its library version', async (codec) => {
        const instance = await AudioDecoderPackageInstance.create(source, codec);

        expect(Number.isSafeInteger(instance.readAttribute(LIBRARY_VERSION_ATTRIBUTE))).toBe(true);
        expect(instance.readAttribute(LIBRARY_VERSION_ATTRIBUTE)).toBeGreaterThan(0);
        instance.close();
    });

    it('refuses a codec its manifest does not list', async () => {
        await expect(AudioDecoderPackageInstance.create(source, OTHER_CODEC))
            .rejects.toThrow(new RangeError(`audio decoder ${DECODER_NAME} decodes no ${OTHER_CODEC}`));
    });

    it('has a known answer for every codec', () => {
        expect(new Set(knownAnswers.map(answer => answer.codec))).toEqual(new Set(CODECS));
    });

    // FFmpeg's C code decodes each vector to the same bytes, the frames its decoder drains at the end of the stream included
    it.each([ 'wmav1.avi', 'wmav1.mkv', 'wmav2.avi', 'wmav2.mkv', 'wmapro-5.1.mkv', 'wmalossless-16.mkv', 'wmalossless-24.mkv', 'wmavoice.mkv' ])(
        'decodes %s to FFmpeg\'s known answer',
        async (file) => {
            const answer = knownAnswers.find(candidate => candidate.file === file);
            const vector = requireVector(file);

            const blocks = await decodeVector(vector);
            const samples = interleaveBlocks(blocks);

            expect(vector.codec).toBe(answer?.codec);
            expect(blocks.every(block => (
                block.sampleRate === answer?.sampleRate
                && block.channelData.length === answer.channelCount
                && block.channelMask === answer.channelMask
            ))).toBe(true);
            expect(samples.length / (answer?.channelCount ?? 1)).toBe(answer?.frameCount);
            expect(createHash('sha256').update(new Uint8Array(samples.buffer, 0, samples.length * FLOAT_BYTE_LENGTH)).digest('hex'))
                .toBe(answer?.pcmSHA256);
        }
    );

    it.each([
        [ WMAV1_MATROSKA_FILE, WMAV1_AVI_FILE ],
        [ WMAV2_MATROSKA_FILE, WMAV2_AVI_FILE ]
    ])('decodes %s and %s, the same packets in Matroska and AVI, identically', async (matroskaFile, aviFile) => {
        const matroskaVector = requireVector(matroskaFile);
        const aviVector = requireVector(aviFile);

        const matroskaBlocks = await decodeVector(matroskaVector);
        const aviBlocks = await decodeVector(aviVector);

        expect(aviVector.packets.map(packet => packet.data)).toEqual(matroskaVector.packets.map(packet => packet.data));
        expect(aviBlocks.map(block => block.channelData)).toEqual(matroskaBlocks.map(block => block.channelData));
    });

    it('refuses a packet before a configure, and after a configure that failed', async () => {
        const vector = requireVector(WMAV2_MATROSKA_FILE);
        const [ firstPacket ] = vector.packets;
        const instance = await AudioDecoderPackageInstance.create(source, vector.codec);

        expectPackageError(catchFailure(() => instance.decode(firstPacket.data, firstPacket.timestampMicroseconds)), UNCONFIGURED_ERROR, firstPacket.data.byteLength);
        expect(() => instance.configure(vector.waveFormat.subarray(0, WAVE_FORMAT_HEADER_BYTE_LENGTH - 1))).toThrow(AudioDecoderPackageError);
        expectPackageError(catchFailure(() => instance.decode(firstPacket.data, firstPacket.timestampMicroseconds)), UNCONFIGURED_ERROR, firstPacket.data.byteLength);
        instance.close();
    });

    it('refuses a WAVEFORMATEX shorter than its header or than its cbSize, and an extensible one without its fields', async () => {
        const wmav2 = requireVector(WMAV2_MATROSKA_FILE);
        const wmapro = requireVector(WMAPRO_FILE);
        const shortHeader = wmav2.waveFormat.subarray(0, WAVE_FORMAT_HEADER_BYTE_LENGTH - 1);
        const shortExtension = wmav2.waveFormat.subarray(0, wmav2.waveFormat.byteLength - 1);
        const shortExtensible = rewriteField(wmapro.waveFormat, EXTENSION_SIZE_OFFSET, WAVE_FORMAT_EXTENSIBLE_BYTE_LENGTH - 1);

        expect(new DataView(wmapro.waveFormat.buffer, wmapro.waveFormat.byteOffset).getUint16(0, true)).toBe(WAVE_FORMAT_EXTENSIBLE_TAG);
        expectPackageError(await catchConfigureFailure(wmav2.codec, shortHeader), WAVE_FORMAT_ERROR, shortHeader.byteLength);
        expectPackageError(await catchConfigureFailure(wmav2.codec, shortExtension), WAVE_FORMAT_ERROR, shortExtension.byteLength);
        expectPackageError(await catchConfigureFailure(wmapro.codec, shortExtensible), WAVE_FORMAT_ERROR, shortExtensible.byteLength);
    });

    it('refuses a format tag, or an extensible SubFormat\'s, of another codec', async () => {
        expectPackageError(await catchConfigureFailure('wmav1', requireVector(WMAV2_MATROSKA_FILE).waveFormat), FORMAT_TAG_ERROR, WMAV2_FORMAT_TAG);
        expectPackageError(await catchConfigureFailure('wmalossless', requireVector(WMAPRO_FILE).waveFormat), FORMAT_TAG_ERROR, WMAPRO_FORMAT_TAG);
    });

    it('reports a header the decoder fails to open with, and opens a fresh decoder on the next configure', async () => {
        const vector = requireVector(WMAV2_MATROSKA_FILE);
        const answer = knownAnswers.find(candidate => candidate.file === WMAV2_MATROSKA_FILE);
        // FFmpeg's WMA decoders refuse a block alignment of 0
        const unalignedHeader = rewriteField(vector.waveFormat, BLOCK_ALIGN_OFFSET, 0);
        const instance = await AudioDecoderPackageInstance.create(source, vector.codec);

        const failure = catchFailure(() => instance.configure(unalignedHeader));
        instance.configure(vector.waveFormat);
        const blocks = [
            ...vector.packets.flatMap(packet => requireDecodedBlocks(instance.decode(packet.data, packet.timestampMicroseconds))),
            ...instance.drain()
        ];
        const samples = interleaveBlocks(blocks);

        expect(failure).toBeInstanceOf(AudioDecoderPackageError);
        expect(failure).toMatchObject({ code: getAudioDecoderErrorCode(source.manifest, OPEN_ERROR) });
        expect(failure instanceof AudioDecoderPackageError && failure.value > 0).toBe(true);
        expect(createHash('sha256').update(new Uint8Array(samples.buffer)).digest('hex')).toBe(answer?.pcmSHA256);
        instance.close();
    });

    it('drains the frames its decoder held back once, and decodes again after clear', async () => {
        const vector = requireVector(WMALOSSLESS_FILE);
        const answer = knownAnswers.find(candidate => candidate.file === WMALOSSLESS_FILE);
        const instance = await AudioDecoderPackageInstance.create(source, vector.codec);
        instance.clear();
        instance.configure(vector.waveFormat);

        const decodedBlocks = vector.packets.flatMap(packet => requireDecodedBlocks(instance.decode(packet.data, packet.timestampMicroseconds)));
        const drainedBlocks = instance.drain();
        const secondDrain = instance.drain();
        instance.clear();
        const blocksAfterClear = vector.packets.flatMap(packet => requireDecodedBlocks(instance.decode(packet.data, packet.timestampMicroseconds)));

        // WMA Lossless holds frames back until the end of the stream
        expect(drainedBlocks.length).toBeGreaterThan(0);
        expect([ ...decodedBlocks, ...drainedBlocks ].reduce((sum, block) => sum + block.frameCount, 0)).toBe(answer?.frameCount);
        expect(secondDrain).toEqual([]);
        expect(blocksAfterClear.length).toBeGreaterThan(0);
        instance.close();
    });

    it('refuses a drain before a configure', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, 'wmav2');

        expectPackageError(catchFailure(() => instance.drain()), UNCONFIGURED_ERROR, 0);
        instance.close();
    });
});

describe('the WMA package on PackageSoftwareAudioDecoder', () => {
    it('decodes the 5.1 WMA Pro vector with the WAVEFORMATEX it is created with', async () => {
        const vector = requireVector(WMAPRO_FILE);
        const answer = knownAnswers.find(candidate => candidate.file === WMAPRO_FILE);
        const decoder = await PackageSoftwareAudioDecoder.create(source, vector.codec, vector.waveFormat);

        const outputs = [
            ...vector.packets.flatMap(packet => [ ...decoder.decode(packet.data, packet.timestampMicroseconds) ]),
            ...decoder.drain()
        ];

        expect(outputs.reduce((sum, output) => sum + output.frameCount, 0)).toBe(answer?.frameCount);
        expect(outputs.every(output => output.channelMask === answer?.channelMask && output.channelData.length === answer.channelCount)).toBe(true);
        decoder.close();
    });

    it('drains WMA Lossless\'s held-back frames after its last output', async () => {
        const vector = requireVector(WMALOSSLESS_FILE);
        const answer = knownAnswers.find(candidate => candidate.file === WMALOSSLESS_FILE);
        const decoder = await PackageSoftwareAudioDecoder.create(source, vector.codec, vector.waveFormat);

        const decoded = vector.packets.flatMap(packet => [ ...decoder.decode(packet.data, packet.timestampMicroseconds) ]);
        const drained = decoder.drain();
        const lastDecoded = decoded.at(-1);

        expect(drained.length).toBeGreaterThan(0);
        expect([ ...decoded, ...drained ].reduce((sum, output) => sum + output.frameCount, 0)).toBe(answer?.frameCount);
        expect(lastDecoded && drained[0].mediaTimeMicroseconds >= lastDecoded.mediaTimeMicroseconds).toBe(true);
        decoder.close();
    });

    it('refuses to create a decoder whose WAVEFORMATEX fails to configure', async () => {
        const failure = await PackageSoftwareAudioDecoder.create(source, 'wmav1', requireVector(WMAV2_MATROSKA_FILE).waveFormat)
            .then(() => null, (error: unknown) => error);

        expectPackageError(failure, FORMAT_TAG_ERROR, WMAV2_FORMAT_TAG);
    });

    it('refuses a codec its package does not decode', async () => {
        await expect(PackageSoftwareAudioDecoder.create(source, OTHER_CODEC, null))
            .rejects.toThrow(new RangeError(`audio decoder ${DECODER_NAME} decodes no ${OTHER_CODEC}`));
    });
});
