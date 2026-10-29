// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { AudioDecoderManifest } from 'webgpu-player/decode/audio/AudioDecoderManifest';
import AudioDecoderPackageInstance, {
    AudioDecoderPackageError,
    findMissingAudioDecoderExports,
    isAudioDecoderModuleSource,
    isAudioDecoderPackageSelection,
    type AudioDecoderModuleSource,
    type AudioDecoderPackageBlock
} from 'webgpu-player/decode/audio/AudioDecoderPackageInstance';
import PackageSoftwareAudioDecoder from 'webgpu-player/decode/audio/PackageSoftwareAudioDecoder';
import {
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_FOUR,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_TWO,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_TWO,
    CUSTOM_WAVE_CHANNEL_MASK_STEREO
} from 'webgpu-player/audio/processing/CustomWaveChannelLayout';
import { createNativeMediaAudioProbeVector } from 'webgpu-player/capability/vectors/NativeMediaAudioCapabilityVectors';
import type { Microseconds } from 'webgpu-player/MediaTime';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

import {
    catchFailure,
    getAudioDecoderErrorCode,
    readContainerAudioPackets,
    requireDecodedBlocks,
    type EncodedAudioPacket
} from '../../../test/helpers/audioDecoderPackageResults';
import { loadDecoderProjectAudioSource } from '../../../test/helpers/decoderPackages';
import { DECODERS_DIRECTORY } from '../../../test/helpers/enginePaths';

const PROJECT = 'eac3';
// The codecs the package decodes, by the names its manifest gives them, and one it does not
const EAC3_CODEC = 'eac3';
const AC3_CODEC = 'ac3';
const OTHER_CODEC = 'dts';
const DECODER_NAME = 'E-AC-3';
const LIBRARY_VERSION_ATTRIBUTE = 'libraryVersion';
const UNDECLARED_NAME = 'dialogueNormalization';
const UNDECLARED_OPTION = 'pcmFingerprint';
const OPTION_ENABLED = 1;
const OPTION_ERROR = 'option';
// A key the bridge declares no option for, which it refuses with its option error
const UNDECLARED_OPTION_KEY = 3;
const SAMPLE_RATE = 48_000;
// A syncframe of six 256-frame blocks
const SYNCFRAME_FRAME_COUNT = 1_536;
const STEREO_CHANNEL_COUNT = 2;
const FIVE_POINT_ONE_CHANNEL_COUNT = 6;
const STEREO_LAYOUT_ID = 'stereo';
const CODEC_PRIVATE_BYTES = Uint8Array.of(1, 2, 3, 4);
const EMPTY_BYTES = new Uint8Array();
const PACKET_TIME_MICROSECONDS = requireMicroseconds(1_000_000);
const FRACTIONAL_TIMESTAMP_MICROSECONDS = 0.5;
const PACKAGE_SUBJECT = `Audio decoder ${DECODER_NAME}`;
const CLOSED_ERROR = `audio decoder ${DECODER_NAME} is closed`;
// The render target options and the attribute of object audio
const RENDER_CHANNEL_MASK_OPTION = 'renderChannelMask';
const RENDER_BINAURAL_OPTION = 'renderBinaural';
const OBJECT_COUNT_ATTRIBUTE = 'objectCount';
// The Dolby Atmos vectors and FFmpeg's known answers for them, which scripts/codec_vector_assets/generate_eac3_joc_vectors.py writes
const VECTOR_DIRECTORY = join(DECODERS_DIRECTORY, PROJECT, 'vectors');
const KNOWN_ANSWERS_FILE_NAME = 'known-answers.json';
// A Dolby encode: a 5.1 core, 15 JOC objects, OAMD of a 5.1 bed and 10 dynamic objects
const JOC_FILE = 'joc-5.1.mkv';
const JOC_DYNAMIC_OBJECT_COUNT = 10;
// A synthetic encode: 5.1 with the top front pair in a dependent substream, 15 JOC objects, OAMD of the LFE and 15 dynamic objects
const DEPENDENT_JOC_FILE = 'joc-5.1.2-dependent.mkv';
const DEPENDENT_JOC_DYNAMIC_OBJECT_COUNT = 15;
// The layout of a 5.1 core with the top front pair, as FFmpeg decodes it
const FIVE_POINT_ONE_POINT_TWO_SIDE_MASK = 0x560F;
// The targets the engine sets, and the WAVE channel bits of the height speakers
const TARGET_MASKS = [
    CUSTOM_WAVE_CHANNEL_MASK_STEREO,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_TWO,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_FOUR,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_TWO,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR
];
const TOP_CHANNEL_BITS = [ 0x1000, 0x4000, 0x8000, 0x20000 ];
const SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT = 12;
// The energy of the difference a JOC matrix held over one lost frame leaves in the two frames after it, relative to the signal's
const MAXIMUM_HELD_MATRIX_ERROR = 0.01;

/** FFmpeg's decode of a vector: its layout, and the frame count and SHA-256 of its interleaved 32-bit float PCM. */
type KnownAnswer = Readonly<{ channelCount: number, channelMask: number, file: string, frameCount: number, pcmSHA256: string }>;

let source: AudioDecoderModuleSource;
let eac3Packets: EncodedAudioPacket[];
let ac3Packets: EncodedAudioPacket[];
let jocPackets: EncodedAudioPacket[];
let dependentJocPackets: EncodedAudioPacket[];
let knownAnswers: KnownAnswer[];

beforeAll(async () => {
    source = await loadDecoderProjectAudioSource(PROJECT);
    eac3Packets = await readContainerAudioPackets(createNativeMediaAudioProbeVector(EAC3_CODEC, STEREO_CHANNEL_COUNT));
    ac3Packets = await readContainerAudioPackets(createNativeMediaAudioProbeVector(AC3_CODEC, FIVE_POINT_ONE_CHANNEL_COUNT));
    jocPackets = await readContainerAudioPackets(new Uint8Array(readFileSync(join(VECTOR_DIRECTORY, JOC_FILE))));
    dependentJocPackets = await readContainerAudioPackets(new Uint8Array(readFileSync(join(VECTOR_DIRECTORY, DEPENDENT_JOC_FILE))));
    const document: unknown = JSON.parse(readFileSync(join(VECTOR_DIRECTORY, KNOWN_ANSWERS_FILE_NAME), 'utf8'));
    knownAnswers = typeof document === 'object' && document !== null && 'vectors' in document ? document.vectors as KnownAnswer[] : [];
});

/** A decode of every packet of a stream on a fresh instance with options set before the first: each packet's blocks, and the drain's. */
type TargetDecode = Readonly<{ drained: AudioDecoderPackageBlock[], packetBlocks: AudioDecoderPackageBlock[][] }>;

async function decodeAtTarget(codec: string, packets: readonly EncodedAudioPacket[], options: Readonly<Record<string, number>>): Promise<TargetDecode> {
    const instance = await AudioDecoderPackageInstance.create(source, codec);
    for (const [ name, value ] of Object.entries(options)) {
        instance.setOption(name, value);
    }
    const packetBlocks = packets.map(packet => [ ...requireDecodedBlocks(instance.decode(packet.data, packet.timestampMicroseconds)) ]);
    const drained = instance.drain();
    instance.close();
    return { drained, packetBlocks };
}

function allBlocks(decode: TargetDecode): AudioDecoderPackageBlock[] {
    return [ ...decode.packetBlocks.flat(), ...decode.drained ];
}

/** The SHA-256 of blocks' planes interleaved, as FFmpeg writes f32le. */
function hashInterleaved(blocks: readonly AudioDecoderPackageBlock[]): string {
    const hash = createHash('sha256');
    for (const block of blocks) {
        const channelCount = block.channelData.length;
        const samples = new Float32Array(block.frameCount * channelCount);
        for (let frameIndex = 0; frameIndex < block.frameCount; frameIndex += 1) {
            for (let channel = 0; channel < channelCount; channel += 1) {
                samples[frameIndex * channelCount + channel] = block.channelData[channel][frameIndex];
            }
        }
        hash.update(new Uint8Array(samples.buffer));
    }
    return hash.digest('hex');
}

/** The energy of the plane of one WAVE channel bit across blocks of one layout. */
function channelEnergy(blocks: readonly AudioDecoderPackageBlock[], channelBit: number): number {
    let energy = 0;
    for (const block of blocks) {
        const plane = block.channelData[countBitsBelow(block.channelMask, channelBit)];
        for (const sample of plane) {
            energy += sample * sample;
        }
    }
    return energy;
}

/** A channel's plane index: its block's channels are in WAVE mask bit order */
function countBitsBelow(mask: number, channelBit: number): number {
    let count = 0;
    for (let bit = 1; bit < channelBit; bit *= 2) {
        count += (mask & bit) !== 0 ? 1 : 0;
    }
    return count;
}

function requireKnownAnswer(file: string): KnownAnswer {
    const answer = knownAnswers.find(candidate => candidate.file === file);
    if (!answer) {
        throw new Error(`No known answer for ${file}`);
    }
    return answer;
}

/** The bits of bytes, most significant first, as a string of 0 and 1. */
function toBits(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(2).padStart(8, '0')).join('');
}

function fromBits(bits: string): Uint8Array {
    return Uint8Array.from({ length: bits.length / 8 }, (_, index) => Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2));
}

/** The CRC of AC-3 syncframes: polynomial 0x8005, most significant bit first, from zero; a syncframe's bytes after its syncword check to zero */
function computeCRC16(bytes: Uint8Array): number {
    let crc = 0;
    for (const byte of bytes) {
        crc ^= byte << 8;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x8005) & 0xFFFF : (crc << 1) & 0xFFFF;
        }
    }
    return crc;
}

/** Returns a copy of a packet in which the syncframe holding a bit pattern carries a replacement of it, and a crc2 that checks again. */
function patchSyncframe(packet: Uint8Array, pattern: string, replacement: string): Uint8Array {
    const patched = packet.slice();
    for (let offset = 0; offset < packet.byteLength;) {
        // frmsiz: the syncframe's 16-bit words, minus one
        const size = ((((packet[offset + 2] & 0x7) << 8) | packet[offset + 3]) + 1) * 2;
        const frame = packet.subarray(offset, offset + size);
        const bits = toBits(frame);
        const position = bits.indexOf(pattern);
        if (position >= 0) {
            const patchedFrame = fromBits(bits.slice(0, position) + replacement + bits.slice(position + replacement.length));
            // A synthetic syncframe whose crc2 did not check keeps it, so FFmpeg treats both alike
            if (computeCRC16(frame.subarray(2)) === 0) {
                const crc = computeCRC16(patchedFrame.subarray(2, size - 2));
                patchedFrame[size - 2] = crc >> 8;
                patchedFrame[size - 1] = crc & 0xFF;
            }
            patched.set(patchedFrame, offset);
            return patched;
        }
        offset += size;
    }
    throw new Error('No syncframe holds the pattern');
}

/** The energy of the difference between two decodes over a range of blocks of one layout, relative to the reference's energy. */
function differenceRatio(blocks: readonly AudioDecoderPackageBlock[], reference: readonly AudioDecoderPackageBlock[], first: number, end: number): number {
    let difference = 0;
    let energy = 0;
    for (let index = first; index < end; index += 1) {
        for (const [ channel, plane ] of reference[index].channelData.entries()) {
            for (const [ frameIndex, sample ] of plane.entries()) {
                difference += (blocks[index].channelData[channel][frameIndex] - sample) ** 2;
                energy += sample ** 2;
            }
        }
    }
    return difference / energy;
}

describe('the E-AC-3 package on AudioDecoderPackageInstance', () => {
    it('has every export of the interface, and a source and selections the engine accepts', () => {
        expect(findMissingAudioDecoderExports(source.module)).toEqual([]);
        expect(isAudioDecoderModuleSource(source)).toBe(true);
        expect(isAudioDecoderPackageSelection({ codec: AC3_CODEC, source })).toBe(true);
        expect(isAudioDecoderPackageSelection({ codec: OTHER_CODEC, source })).toBe(false);
    });

    it.each([ EAC3_CODEC, AC3_CODEC ])('creates a %s decoder that reports its library version', async (codec) => {
        const instance = await AudioDecoderPackageInstance.create(source, codec);

        expect(Number.isSafeInteger(instance.readAttribute(LIBRARY_VERSION_ATTRIBUTE))).toBe(true);
        expect(instance.readAttribute(LIBRARY_VERSION_ATTRIBUTE)).toBeGreaterThan(0);
        instance.close();
    });

    it('refuses a codec its manifest does not list', async () => {
        await expect(AudioDecoderPackageInstance.create(source, OTHER_CODEC))
            .rejects.toThrow(new RangeError(`audio decoder ${DECODER_NAME} decodes no ${OTHER_CODEC}`));
    });

    it('decodes the stereo E-AC-3 vector into blocks that carry their packets\' timestamps', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, EAC3_CODEC);

        for (const packet of eac3Packets) {
            const blocks = requireDecodedBlocks(instance.decode(packet.data, packet.timestampMicroseconds));

            expect(blocks).toHaveLength(1);
            expect(blocks[0]).toMatchObject({
                channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO,
                frameCount: SYNCFRAME_FRAME_COUNT,
                sampleRate: SAMPLE_RATE,
                // The vector's edit list starts its first packet before zero, and a block reports no negative time, so it continues from its packet's
                timestampMicroseconds: packet.timestampMicroseconds < 0 ? null : packet.timestampMicroseconds
            });
            expect(blocks[0].channelData.map(plane => plane.length)).toEqual([ SYNCFRAME_FRAME_COUNT, SYNCFRAME_FRAME_COUNT ]);
            expect(blocks[0].attributes.get(LIBRARY_VERSION_ATTRIBUTE)).toBe(instance.readAttribute(LIBRARY_VERSION_ATTRIBUTE));
        }
        expect(eac3Packets.length).toBeGreaterThan(0);
        instance.close();
    });

    it('decodes the 5.1 AC-3 vector with the AC-3 decoder of the same package', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, AC3_CODEC);

        const blocks = ac3Packets.flatMap(packet => requireDecodedBlocks(instance.decode(packet.data, packet.timestampMicroseconds)));

        expect(blocks).toHaveLength(ac3Packets.length);
        expect(blocks.every(block => (
            block.channelMask === CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE
            && block.channelData.length === FIVE_POINT_ONE_CHANNEL_COUNT
        ))).toBe(true);
        instance.close();
    });

    it('refuses an option or reads no attribute its manifest does not name', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, EAC3_CODEC);

        expect(() => instance.setOption(UNDECLARED_OPTION, OPTION_ENABLED))
            .toThrow(new RangeError(`audio decoder ${DECODER_NAME} has no option ${UNDECLARED_OPTION}`));
        expect(instance.readAttribute(UNDECLARED_NAME)).toBeNull();
        instance.close();
    });

    it('reports an option the module refuses by the manifest\'s name of its error', async () => {
        // A manifest that names an option the bridge does not declare
        const manifest: AudioDecoderManifest = {
            ...source.manifest,
            options: new Map([ [ UNDECLARED_OPTION_KEY, UNDECLARED_NAME ] ])
        };
        const instance = await AudioDecoderPackageInstance.create({ ...source, manifest }, EAC3_CODEC);

        const failure = catchFailure(() => instance.setOption(UNDECLARED_NAME, OPTION_ENABLED));

        expect(failure).toBeInstanceOf(AudioDecoderPackageError);
        expect(failure).toMatchObject({
            code: getAudioDecoderErrorCode(manifest, OPTION_ERROR),
            message: `audio decoder ${OPTION_ERROR}: ${UNDECLARED_OPTION_KEY}`,
            value: UNDECLARED_OPTION_KEY
        });
        instance.close();
    });

    it('drops the largest packet the manifest allows when it holds no syncframe', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, EAC3_CODEC);

        expect(instance.decode(new Uint8Array(source.manifest.packetByteLength), 0)).toEqual({ kind: 'dropped' });
        instance.close();
    });

    it('hands codec private data to the module, and skips none', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, EAC3_CODEC);

        expect(() => {
            instance.configure(null);
            instance.configure(EMPTY_BYTES);
            instance.configure(CODEC_PRIVATE_BYTES);
        }).not.toThrow();
        instance.close();
    });

    it('returns planes of its own, which later packets leave unchanged', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, EAC3_CODEC);
        const [ firstPacket, ...laterPackets ] = eac3Packets;
        const [ firstBlock ] = requireDecodedBlocks(instance.decode(firstPacket.data, firstPacket.timestampMicroseconds));
        const firstPlanes = firstBlock.channelData.map(plane => plane.slice());

        for (const packet of laterPackets) {
            instance.decode(packet.data, packet.timestampMicroseconds);
        }

        expect(firstBlock.channelData).toEqual(firstPlanes);
        expect(firstBlock.channelData.every(plane => plane.buffer.byteLength === plane.byteLength)).toBe(true);
        instance.close();
    });
});

describe('the E-AC-3 package on PackageSoftwareAudioDecoder', () => {
    it('decodes the stereo E-AC-3 vector at its packets\' timestamps', async () => {
        const decoder = await PackageSoftwareAudioDecoder.create(source, EAC3_CODEC, null);

        const outputs = eac3Packets.flatMap(packet => [ ...decoder.decode(packet.data, packet.timestampMicroseconds) ]);

        expect(outputs).toHaveLength(eac3Packets.length);
        expect(outputs.map(output => output.mediaTimeMicroseconds)).toEqual(eac3Packets.map(packet => packet.timestampMicroseconds));
        expect(outputs.every(output => output.channelLayout.id === STEREO_LAYOUT_ID && output.frameCount === SYNCFRAME_FRAME_COUNT)).toBe(true);
        decoder.close();
    });

    it('returns no output for a packet its decoder drops', async () => {
        const decoder = await PackageSoftwareAudioDecoder.create(source, EAC3_CODEC, null);

        expect(decoder.decode(new Uint8Array(source.manifest.packetByteLength), PACKET_TIME_MICROSECONDS)).toEqual([]);
        decoder.close();
    });

    it('refuses a codec its package does not decode', async () => {
        await expect(PackageSoftwareAudioDecoder.create(source, OTHER_CODEC, null))
            .rejects.toThrow(new RangeError(`audio decoder ${DECODER_NAME} decodes no ${OTHER_CODEC}`));
    });

    it('names its package when it refuses a packet timestamp, and refuses every call once closed', async () => {
        const decoder = await PackageSoftwareAudioDecoder.create(source, EAC3_CODEC, null);
        const [ firstPacket ] = eac3Packets;

        expect(() => decoder.decode(firstPacket.data, FRACTIONAL_TIMESTAMP_MICROSECONDS as Microseconds))
            .toThrow(new RangeError(`${PACKAGE_SUBJECT} packet timestamp must be a safe integer number of microseconds`));
        decoder.clear();
        decoder.close();
        decoder.close();
        expect(() => decoder.clear()).toThrow(new Error(CLOSED_ERROR));
        expect(() => decoder.decode(firstPacket.data, firstPacket.timestampMicroseconds)).toThrow(new Error(CLOSED_ERROR));
    });
});

describe('Dolby Atmos objects in the E-AC-3 package', () => {
    it('decodes the JOC vectors\' cores as FFmpeg does without a render target', async () => {
        for (const [ file, packets ] of [ [ JOC_FILE, jocPackets ], [ DEPENDENT_JOC_FILE, dependentJocPackets ] ] as const) {
            const blocks = allBlocks(await decodeAtTarget(EAC3_CODEC, packets, {}));
            const answer = requireKnownAnswer(file);

            expect(blocks.every(block => block.channelMask === answer.channelMask && block.attributes.get(OBJECT_COUNT_ATTRIBUTE) === 0)).toBe(true);
            expect(blocks.reduce((sum, block) => sum + block.frameCount, 0)).toBe(answer.frameCount);
            expect(hashInterleaved(blocks)).toBe(answer.pcmSHA256);
        }
    });

    it('renders the objects into 7.1.4, holding each block until the filter bank delay is filled, at its packet\'s timestamp', async () => {
        const decode = await decodeAtTarget(EAC3_CODEC, jocPackets, { [RENDER_CHANNEL_MASK_OPTION]: CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR });
        const blocks = allBlocks(decode);

        // The first packet's block leaves with the second packet, and the last one with the drain
        expect(decode.packetBlocks.map(packetBlocks => packetBlocks.length)).toEqual(jocPackets.map((_, index) => index === 0 ? 0 : 1));
        expect(decode.drained).toHaveLength(1);
        expect(blocks.map(block => block.timestampMicroseconds)).toEqual(jocPackets.map(packet => packet.timestampMicroseconds));
        expect(blocks.every(block => (
            block.channelMask === CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR
            && block.channelData.length === SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT
            && block.frameCount === SYNCFRAME_FRAME_COUNT
            && block.attributes.get(OBJECT_COUNT_ATTRIBUTE) === JOC_DYNAMIC_OBJECT_COUNT
        ))).toBe(true);
        expect(TOP_CHANNEL_BITS.some(bit => channelEnergy(blocks, bit) > 0)).toBe(true);
    });

    it.each([
        CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
        CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_TWO,
        CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_FOUR,
        CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_TWO
    ])('renders the objects into every layout with a speaker the 5.1 core lacks: 0x%s', async (mask) => {
        const blocks = allBlocks(await decodeAtTarget(EAC3_CODEC, jocPackets, { [RENDER_CHANNEL_MASK_OPTION]: mask }));

        expect(blocks).toHaveLength(jocPackets.length);
        expect(blocks.every(block => block.channelMask === mask && block.attributes.get(OBJECT_COUNT_ATTRIBUTE) === JOC_DYNAMIC_OBJECT_COUNT)).toBe(true);
    });

    it.each([ CUSTOM_WAVE_CHANNEL_MASK_STEREO, CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE ])(
        'outputs the stock decode at a target the core holds, with binaural rendering off: 0x%s',
        async (mask) => {
            const stock = await decodeAtTarget(EAC3_CODEC, jocPackets, {});
            const decode = await decodeAtTarget(EAC3_CODEC, jocPackets, { [RENDER_CHANNEL_MASK_OPTION]: mask, [RENDER_BINAURAL_OPTION]: 0 });

            expect(decode.packetBlocks.map(packetBlocks => packetBlocks.length)).toEqual(jocPackets.map(() => 1));
            expect(hashInterleaved(allBlocks(decode))).toBe(hashInterleaved(allBlocks(stock)));
            expect(allBlocks(decode).every(block => (
                block.channelMask === CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE && block.attributes.get(OBJECT_COUNT_ATTRIBUTE) === 0
            ))).toBe(true);
        }
    );

    it('renders the objects binaurally into stereo', async () => {
        const decode = await decodeAtTarget(EAC3_CODEC, jocPackets, {
            [RENDER_CHANNEL_MASK_OPTION]: CUSTOM_WAVE_CHANNEL_MASK_STEREO,
            [RENDER_BINAURAL_OPTION]: OPTION_ENABLED
        });
        const blocks = allBlocks(decode);

        expect(blocks.map(block => block.timestampMicroseconds)).toEqual(jocPackets.map(packet => packet.timestampMicroseconds));
        expect(blocks.every(block => (
            block.channelMask === CUSTOM_WAVE_CHANNEL_MASK_STEREO
            && block.channelData.length === STEREO_CHANNEL_COUNT
            && block.attributes.get(OBJECT_COUNT_ATTRIBUTE) === JOC_DYNAMIC_OBJECT_COUNT
        ))).toBe(true);
        expect(channelEnergy(blocks, 0x1)).toBeGreaterThan(0);
        expect(channelEnergy(blocks, 0x2)).toBeGreaterThan(0);
    });

    it('rebuilds objects from a core whose top front pair is in a dependent substream', async () => {
        const stock = allBlocks(await decodeAtTarget(EAC3_CODEC, dependentJocPackets, {}));
        const blocks = allBlocks(await decodeAtTarget(EAC3_CODEC, dependentJocPackets, {
            [RENDER_CHANNEL_MASK_OPTION]: CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR
        }));

        expect(stock.every(block => block.channelMask === FIVE_POINT_ONE_POINT_TWO_SIDE_MASK)).toBe(true);
        expect(blocks.map(block => block.timestampMicroseconds)).toEqual(dependentJocPackets.map(packet => packet.timestampMicroseconds));
        expect(blocks.every(block => (
            block.channelMask === CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR
            && block.attributes.get(OBJECT_COUNT_ATTRIBUTE) === DEPENDENT_JOC_DYNAMIC_OBJECT_COUNT
        ))).toBe(true);
    });

    it.each([
        [ 'stereo E-AC-3', EAC3_CODEC, () => eac3Packets ],
        [ '5.1 AC-3', AC3_CODEC, () => ac3Packets ]
    ] as const)('outputs a stream without objects, %s, unchanged at every target', async (_, codec, packets) => {
        const stock = hashInterleaved(allBlocks(await decodeAtTarget(codec, packets(), {})));

        for (const mask of TARGET_MASKS) {
            for (const binaural of [ 0, OPTION_ENABLED ]) {
                const blocks = allBlocks(await decodeAtTarget(codec, packets(), {
                    [RENDER_CHANNEL_MASK_OPTION]: mask,
                    [RENDER_BINAURAL_OPTION]: binaural
                }));

                expect(hashInterleaved(blocks)).toBe(stock);
                expect(blocks.every(block => block.attributes.get(OBJECT_COUNT_ATTRIBUTE) === 0)).toBe(true);
            }
        }
    });

    it('switches between objects and the stock decode between packets without losing or repeating a frame', async () => {
        const decoder = await PackageSoftwareAudioDecoder.create(source, EAC3_CODEC, null);
        const switchIndex = jocPackets.length / 2;
        const outputs = jocPackets.flatMap((packet, index) => {
            if (index === 0 || index === switchIndex) {
                decoder.setRenderTarget({
                    binaural: false,
                    channelMask: index === 0 ? CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR : CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE
                });
            }
            return [ ...decoder.decode(packet.data, packet.timestampMicroseconds) ];
        });
        outputs.push(...decoder.drain());
        decoder.close();

        expect(outputs.map(output => output.mediaTimeMicroseconds)).toEqual(jocPackets.map(packet => packet.timestampMicroseconds));
        expect(outputs.map(output => output.channelMask)).toEqual(jocPackets.map((_, index) => (
            index < switchIndex ? CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR : CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE
        )));
        expect(outputs.map(output => output.objectCount)).toEqual(jocPackets.map((_, index) => index < switchIndex ? JOC_DYNAMIC_OBJECT_COUNT : 0));
    });

    it('plays the stock decode at a target that needs objects when the renderer refuses the OAMD scene', async () => {
        // The vector's OAMD payload, 16 objects of which the dynamic ones follow an LFE, and one of its length with 4 ISF objects and 12 dynamic
        // ones, which the renderer refuses; both sit in the dependent syncframe's auxiliary data, which FFmpeg's decode skips
        const original = toBits(Uint8Array.of(0x1F, 0x84, 0x54, 0x00, 0x06, 0xAA, 0xAA, 0xAA, 0xA8));
        const isf = toBits(Uint8Array.of(0x1E, 0x60, 0xB0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00));
        const packets = dependentJocPackets.map(packet => ({ ...packet, data: patchSyncframe(packet.data, original, isf) }));

        const blocks = allBlocks(await decodeAtTarget(EAC3_CODEC, packets, {
            [RENDER_CHANNEL_MASK_OPTION]: CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR
        }));

        expect(blocks.map(block => block.timestampMicroseconds)).toEqual(packets.map(packet => packet.timestampMicroseconds));
        expect(blocks.every(block => block.channelMask === FIVE_POINT_ONE_POINT_TWO_SIDE_MASK && block.attributes.get(OBJECT_COUNT_ATTRIBUTE) === 0)).toBe(true);
        expect(hashInterleaved(blocks)).toBe(requireKnownAnswer(DEPENDENT_JOC_FILE).pcmSHA256);
    });

    it('keeps the last matrices through a frame whose JOC payload is lost, and continues from them', async () => {
        // Every JOC payload of the vector starts with downmix configuration 0, 15 objects, no extension, its clip gain, and a sequence count
        // that counts packets; the reserved downmix configuration 7 makes one payload unreadable
        const damagedIndex = 8;
        const header = '00000111000010010111';
        const sequence = damagedIndex.toString(2).padStart(10, '0');
        const packets = jocPackets.map((packet, index) => index !== damagedIndex ? packet : {
            ...packet,
            data: patchSyncframe(packet.data, header + sequence, `111${header.slice(3)}${sequence}`)
        });
        const options = { [RENDER_CHANNEL_MASK_OPTION]: CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR };
        const reference = allBlocks(await decodeAtTarget(EAC3_CODEC, jocPackets, options));

        const blocks = allBlocks(await decodeAtTarget(EAC3_CODEC, packets, options));

        expect(blocks).toHaveLength(jocPackets.length);
        expect(blocks.every(block => block.attributes.get(OBJECT_COUNT_ATTRIBUTE) === JOC_DYNAMIC_OBJECT_COUNT)).toBe(true);
        // Up to the frame before the lost one's filter bank delay, nothing changed; the frames after it differ only by the matrix held over one frame,
        // where a restart from zero matrices and empty synthesis histories would silence the objects at first
        expect(hashInterleaved(blocks.slice(0, damagedIndex - 1))).toBe(hashInterleaved(reference.slice(0, damagedIndex - 1)));
        expect(differenceRatio(blocks, reference, damagedIndex + 1, damagedIndex + 3)).toBeLessThan(MAXIMUM_HELD_MATRIX_ERROR);
    });

    it('finishes the held block in the old layout and restarts at a new one when the target changes between object layouts', async () => {
        const decoder = await PackageSoftwareAudioDecoder.create(source, EAC3_CODEC, null);
        const switchIndex = jocPackets.length / 2;
        const outputs = jocPackets.flatMap((packet, index) => {
            if (index === 0 || index === switchIndex) {
                decoder.setRenderTarget({
                    binaural: false,
                    channelMask: index === 0 ? CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR : CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_FOUR
                });
            }
            return [ ...decoder.decode(packet.data, packet.timestampMicroseconds) ];
        });
        outputs.push(...decoder.drain());
        decoder.close();

        expect(outputs.map(output => output.mediaTimeMicroseconds)).toEqual(jocPackets.map(packet => packet.timestampMicroseconds));
        expect(outputs.map(output => output.channelMask)).toEqual(jocPackets.map((_, index) => (
            index < switchIndex ? CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR : CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_POINT_FOUR
        )));
        expect(outputs.every(output => output.channelData.length === output.channelMask.toString(2).replaceAll('0', '').length)).toBe(true);
    });

    it('times the later frames of a packet by their access units after a switch outputs a held object block', async () => {
        const decoder = await PackageSoftwareAudioDecoder.create(source, EAC3_CODEC, null);
        const [ firstPacket, secondPacket, thirdPacket ] = jocPackets;
        decoder.setRenderTarget({ binaural: false, channelMask: CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR });
        const outputs = [ ...decoder.decode(firstPacket.data, firstPacket.timestampMicroseconds) ];
        decoder.setRenderTarget({ binaural: false, channelMask: CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE });
        // Two access units in one packet: the held object block, then both stock blocks
        const pairedPacket = new Uint8Array([ ...secondPacket.data, ...thirdPacket.data ]);
        outputs.push(...decoder.decode(pairedPacket, secondPacket.timestampMicroseconds));
        decoder.close();

        expect(outputs.map(output => output.mediaTimeMicroseconds))
            .toEqual([ firstPacket, secondPacket, thirdPacket ].map(packet => packet.timestampMicroseconds));
        expect(outputs.map(output => output.objectCount)).toEqual([ JOC_DYNAMIC_OBJECT_COUNT, 0, 0 ]);
    });

    it('decodes objects after a clear that followed stock blocks', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, EAC3_CODEC);
        const [ firstPacket, secondPacket ] = jocPackets;
        requireDecodedBlocks(instance.decode(firstPacket.data, firstPacket.timestampMicroseconds));
        requireDecodedBlocks(instance.decode(secondPacket.data, secondPacket.timestampMicroseconds));
        instance.clear();
        instance.setOption(RENDER_CHANNEL_MASK_OPTION, CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR);

        const blocks = [
            ...jocPackets.flatMap(packet => requireDecodedBlocks(instance.decode(packet.data, packet.timestampMicroseconds))),
            ...instance.drain()
        ];
        instance.close();

        // FFmpeg's flush keeps its dither generator, so the samples differ from a fresh decoder's; the blocks are the object blocks
        expect(blocks.map(block => block.timestampMicroseconds)).toEqual(jocPackets.map(packet => packet.timestampMicroseconds));
        expect(blocks.every(block => (
            block.channelMask === CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR
            && block.channelData.length === SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT
            && block.attributes.get(OBJECT_COUNT_ATTRIBUTE) === JOC_DYNAMIC_OBJECT_COUNT
        ))).toBe(true);
    });

    it('starts over after a clear, and refuses option values outside its range', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, EAC3_CODEC);
        instance.setOption(RENDER_CHANNEL_MASK_OPTION, CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE_POINT_FOUR);
        const [ firstPacket, secondPacket ] = jocPackets;

        expect(requireDecodedBlocks(instance.decode(firstPacket.data, firstPacket.timestampMicroseconds))).toEqual([]);
        instance.clear();
        expect(requireDecodedBlocks(instance.decode(secondPacket.data, secondPacket.timestampMicroseconds))).toEqual([]);
        expect(instance.drain().map(block => block.timestampMicroseconds)).toEqual([ secondPacket.timestampMicroseconds ]);
        for (const [ name, value ] of [ [ RENDER_CHANNEL_MASK_OPTION, -1 ], [ RENDER_CHANNEL_MASK_OPTION, 0.5 ], [ RENDER_BINAURAL_OPTION, 2 ] ] as const) {
            expect(catchFailure(() => instance.setOption(name, value))).toMatchObject({ code: getAudioDecoderErrorCode(source.manifest, OPTION_ERROR) });
        }
        instance.close();
    });
});
