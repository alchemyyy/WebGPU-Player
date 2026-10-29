// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { createTrueHDExactCapabilityVectors, type TrueHDExactCapabilityVector } from '#codec_vector_assets/truehd/TrueHDExactCapabilityVectors';
import AudioDecoderPackageInstance, {
    findMissingAudioDecoderExports,
    isAudioDecoderModuleSource,
    type AudioDecoderModuleSource,
    type AudioDecoderPackageBlock
} from 'webgpu-player/decode/audio/AudioDecoderPackageInstance';
import PackageSoftwareAudioDecoder from 'webgpu-player/decode/audio/PackageSoftwareAudioDecoder';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

import { requireDecodedBlocks } from '../../../test/helpers/audioDecoderPackageResults';
import { loadDecoderProjectAudioSource } from '../../../test/helpers/decoderPackages';
import { DECODERS_DIRECTORY } from '../../../test/helpers/enginePaths';

const PROJECT = 'truehd';
// The codecs the package decodes, by the names its manifest gives them
const MLP_CODEC = 'mlp';
const TRUEHD_CODEC = 'truehd';
const DECODER_NAME = 'TrueHD';
const LIBRARY_VERSION_ATTRIBUTE = 'libraryVersion';
const BITS_PER_SAMPLE_ATTRIBUTE = 'bitsPerSample';
const PCM_FINGERPRINT_ATTRIBUTE = 'pcmFingerprint';
const PCM_FINGERPRINT_OPTION = 'pcmFingerprint';
const OPTION_ENABLED = 1;
const SAMPLE_RATE = 48_000;
const STEREO_CHANNEL_COUNT = 2;
const STEREO_LAYOUT_ID = 'stereo';
const TWENTY_FOUR_BITS_PER_SAMPLE = 24;
const CODEC_PRIVATE_BYTES = Uint8Array.of(1, 2, 3, 4);
// Object rendering: the options and attribute the manifest declares, and the WAVE masks of the targets
const RENDER_CHANNEL_MASK_OPTION = 'renderChannelMask';
const RENDER_BINAURAL_OPTION = 'renderBinaural';
const OBJECT_COUNT_ATTRIBUTE = 'objectCount';
const STEREO_MASK = 0x3;
const FIVE_POINT_ONE_BACK_MASK = 0x3F;
const FIVE_POINT_ONE_SIDE_MASK = 0x60F;
const SEVEN_POINT_ONE_MASK = 0x63F;
const FIVE_POINT_ONE_POINT_TWO_MASK = 0x503F;
const FIVE_POINT_ONE_POINT_FOUR_MASK = 0x2D03F;
const SEVEN_POINT_ONE_POINT_TWO_MASK = 0x563F;
const SEVEN_POINT_ONE_POINT_FOUR_MASK = 0x2D63F;
const SPEAKER_TARGET_MASKS = [
    STEREO_MASK,
    FIVE_POINT_ONE_BACK_MASK,
    FIVE_POINT_ONE_SIDE_MASK,
    SEVEN_POINT_ONE_MASK,
    FIVE_POINT_ONE_POINT_TWO_MASK,
    FIVE_POINT_ONE_POINT_FOUR_MASK,
    SEVEN_POINT_ONE_POINT_TWO_MASK,
    SEVEN_POINT_ONE_POINT_FOUR_MASK
];
const SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT = 12;
const BINAURAL_LATENCY_FRAME_COUNT = 128;
// The Dolby Atmos streams of the truehdd project (vectors/PROVENANCE.txt): an object presentation of an LFE bed and 15 dynamic objects,
// and a 16-channel bed without object metadata; both decode to 7.1 in stock FFmpeg, and carry a major sync in access units 0 and 128
const VECTOR_DIRECTORY = join(DECODERS_DIRECTORY, PROJECT, 'vectors');
const OBJECT_VECTOR_FILE = 'fba_atmos_obj.mlp';
const CHANNEL_BED_VECTOR_FILE = 'fba_atmos_cbi.mlp';
const OBJECT_VECTOR_DYNAMIC_OBJECT_COUNT = 15;
const OBJECT_VECTOR_FRAME_COUNT = 5_600;
const CHANNEL_BED_VECTOR_FRAME_COUNT = 5_440;
// truehdd's decode of the channel bed's L channel, the only one with signal, as 24-bit samples in little-endian int32
const CHANNEL_BED_LEFT_SHA256 = '8cf3194810d7d8a623ace8b788c32a9b5c5814d4955967850ca6cc5839f709d5';
const TWENTY_FOUR_BIT_FULL_SCALE = 2 ** 23;
const SECOND_MAJOR_SYNC_ACCESS_UNIT = 128;
// Six 40-sample access units per packet: 5 ms, a whole number of microseconds
const ACCESS_UNITS_PER_PACKET = 6;
const ACCESS_UNIT_FRAME_COUNT = 40;
const MICROSECONDS_PER_SECOND = 1_000_000;
// Our 5.1(side) stream in one substream (vectors/PROVENANCE.txt), which FFmpeg's decoder refuses, and the SHA-256 of the 24-bit samples
// it encodes, interleaved FL FR FC LFE SL SR as little-endian int32: one tone per channel, 300 access units of 40 frames
const SINGLE_SUBSTREAM_VECTOR_FILE = 'single-substream-5.1.thd';
const SINGLE_SUBSTREAM_FRAME_COUNT = 12_000;
const SINGLE_SUBSTREAM_CHANNEL_COUNT = 6;
const SINGLE_SUBSTREAM_SAMPLES_SHA256 = '7896a57596a8b4cc4bf79bdc98c4e32daa26baf2f94913e884fd49a4efdb628e';

type AtmosPacket = Readonly<{
    data: Uint8Array
    firstAccessUnit: number
    timestampMicroseconds: number
}>;

/** Splits a raw TrueHD stream into its access units, by the length each one's header states. */
function readAccessUnits(fileName: string): Uint8Array[] {
    const stream = new Uint8Array(readFileSync(join(VECTOR_DIRECTORY, fileName)));
    const accessUnits: Uint8Array[] = [];
    for (let offset = 0; offset + 4 <= stream.length;) {
        const length = (((stream[offset] << 8) | stream[offset + 1]) & 0xFFF) * 2;
        accessUnits.push(stream.subarray(offset, offset + length));
        offset += length;
    }
    return accessUnits;
}

/** Joins byte arrays into one. */
function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
    const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        joined.set(part, offset);
        offset += part.length;
    }
    return joined;
}

/** Groups access units into packets of ACCESS_UNITS_PER_PACKET, timed from the first. */
function groupAccessUnits(accessUnits: readonly Uint8Array[]): readonly AtmosPacket[] {
    const packets: AtmosPacket[] = [];
    for (let firstAccessUnit = 0; firstAccessUnit < accessUnits.length; firstAccessUnit += ACCESS_UNITS_PER_PACKET) {
        packets.push({
            data: joinBytes(accessUnits.slice(firstAccessUnit, firstAccessUnit + ACCESS_UNITS_PER_PACKET)),
            firstAccessUnit,
            timestampMicroseconds: firstAccessUnit * ACCESS_UNIT_FRAME_COUNT * MICROSECONDS_PER_SECOND / SAMPLE_RATE
        });
    }
    return packets;
}

/** Groups a raw TrueHD stream's access units into packets. */
function readAtmosPackets(fileName: string): readonly AtmosPacket[] {
    return groupAccessUnits(readAccessUnits(fileName));
}

/** Appends count bits of value to bits, most significant first. */
function writeBits(bits: number[], value: number, count: number): void {
    for (let bit = count - 1; bit >= 0; bit -= 1) {
        bits.push(Math.floor(value / 2 ** bit) % 2);
    }
}

/** Packs bits into bytes, padding the last one with zeros. */
function packBits(bits: readonly number[]): Uint8Array {
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    bits.forEach((bit, index) => {
        bytes[index >> 3] |= bit << (7 - (index & 7));
    });
    return bytes;
}

/**
 * Writes an access unit's length into its header and the check nibble that makes the parity of its header and substream directory hold,
 * the bytes from headerSize on, directorySize of them.
 */
function sealAccessUnit(accessUnit: Uint8Array, headerSize: number, directorySize: number): Uint8Array {
    const words = accessUnit.length / 2;
    accessUnit[0] = (words >> 8) & 0x0F;
    accessUnit[1] = words & 0xFF;
    let parity = 0;
    for (const byte of [ ...accessUnit.subarray(0, 4), ...accessUnit.subarray(headerSize, headerSize + directorySize) ]) {
        parity ^= byte;
    }
    accessUnit[0] |= ((0xF ^ (parity >> 4) ^ parity) & 0xF) << 4;
    return accessUnit;
}

/** Replaces the extra data of an access unit that starts with a major sync, after its four substreams, with other bytes of an even length. */
function replaceExtraData(accessUnit: Uint8Array, extraData: Uint8Array): Uint8Array {
    // The major sync after the 4-byte header is 28 bytes, and its extra channel meaning adds 2 bytes per word it declares and 2 more
    const majorSyncSize = 28 + ((accessUnit[4 + 25] & 1) ? 2 + (accessUnit[4 + 26] >> 4) * 2 : 0);
    const headerSize = 4 + majorSyncSize;
    let directorySize = 0;
    let substreamEnd = 0;
    for (let substream = 0; substream < 4; substream += 1) {
        const entry = headerSize + directorySize;
        substreamEnd = (((accessUnit[entry] << 8) | accessUnit[entry + 1]) & 0xFFF) * 2;
        directorySize += (accessUnit[entry] & 0x80) ? 4 : 2;
    }
    const crafted = joinBytes([ accessUnit.subarray(0, headerSize + directorySize + substreamEnd), extraData ]);
    return sealAccessUnit(crafted, headerSize, directorySize);
}

/**
 * Extra data whose Evolution frame holds a one-byte object audio metadata payload, then one whose variable_bits length is 0xFFFFFFFF,
 * which wraps a 32-bit position check and a 32-bit sum with the bytes already kept.
 */
function createWrappingEvolutionFrame(): Uint8Array {
    const frame: number[] = [];
    writeBits(frame, 0, 2); // evo_version
    writeBits(frame, 0, 3); // key_id
    writeBits(frame, 11, 5); // object audio metadata
    writeBits(frame, 0b00001, 5); // no offset, duration, group, or codec data; discard_unknown_payload
    writeBits(frame, 0x01, 8); // one byte
    writeBits(frame, 0, 1);
    writeBits(frame, 0, 8);
    writeBits(frame, 11, 5);
    writeBits(frame, 0b00001, 5);
    // variable_bits(8) groups 0xFE, 0xFE, 0xFE, 0xFF: ((((0xFE + 1) << 8) + 0xFE + 1) << 8) + 0xFE + 1) << 8) + 0xFF
    for (const group of [ 0xFE, 0xFE, 0xFE ]) {
        writeBits(frame, group, 8);
        writeBits(frame, 1, 1);
    }
    writeBits(frame, 0xFF, 8);
    writeBits(frame, 0, 1);
    writeBits(frame, 0, 64);
    writeBits(frame, 0, 5); // the end of the payloads
    const frameBytes = packBits(frame);
    // Extra data: its length word, the frame's length word, the frame, and a parity byte, to an even length
    const extraLength = 2 + frameBytes.length + 1 + ((frameBytes.length + 1) % 2);
    const extraData = new Uint8Array(2 + extraLength);
    extraData[0] = (extraLength / 2) >> 8;
    extraData[1] = (extraLength / 2) & 0xFF;
    extraData[2] = frameBytes.length >> 8;
    extraData[3] = frameBytes.length & 0xFF;
    extraData.set(frameBytes, 4);
    return extraData;
}

/** Creates a TrueHD decoder with a render target: a WAVE mask, and binaural on or off. */
async function createRenderingDecoder(channelMask: number, binaural: boolean): Promise<AudioDecoderPackageInstance> {
    const instance = await AudioDecoderPackageInstance.create(source, TRUEHD_CODEC);
    instance.setOption(RENDER_CHANNEL_MASK_OPTION, channelMask);
    instance.setOption(RENDER_BINAURAL_OPTION, binaural ? 1 : 0);
    return instance;
}

function decodeAtmosPackets(instance: AudioDecoderPackageInstance, packets: readonly AtmosPacket[]): AudioDecoderPackageBlock[] {
    return packets.flatMap(packet => [ ...requireDecodedBlocks(instance.decode(packet.data, packet.timestampMicroseconds)) ]);
}

function sumFrameCounts(blocks: readonly AudioDecoderPackageBlock[]): number {
    return blocks.reduce((frameCount, block) => frameCount + block.frameCount, 0);
}

let source: AudioDecoderModuleSource;
let vector: TrueHDExactCapabilityVector;

beforeAll(async () => {
    source = await loadDecoderProjectAudioSource(PROJECT);
    const stereoVector = createTrueHDExactCapabilityVectors().find(candidate => (
        candidate.codec === TRUEHD_CODEC && candidate.sampleRate === SAMPLE_RATE && candidate.channelCount === STEREO_CHANNEL_COUNT
    ));
    if (!stereoVector) {
        throw new Error('The TrueHD vectors have no 48 kHz stereo stream');
    }
    vector = stereoVector;
});

describe('the TrueHD package on AudioDecoderPackageInstance', () => {
    it('has every export of the interface, and a source the engine accepts', () => {
        expect(findMissingAudioDecoderExports(source.module)).toEqual([]);
        expect(isAudioDecoderModuleSource(source)).toBe(true);
    });

    it.each([ MLP_CODEC, TRUEHD_CODEC ])('creates a %s decoder that reports its library version', async (codec) => {
        const instance = await AudioDecoderPackageInstance.create(source, codec);

        expect(Number.isSafeInteger(instance.readAttribute(LIBRARY_VERSION_ATTRIBUTE))).toBe(true);
        expect(instance.readAttribute(LIBRARY_VERSION_ATTRIBUTE)).toBeGreaterThan(0);
        instance.close();
    });

    it('sets an option by its manifest name, and reports what it enables as an attribute of each block', async () => {
        const fingerprinting = await AudioDecoderPackageInstance.create(source, TRUEHD_CODEC);
        const playing = await AudioDecoderPackageInstance.create(source, TRUEHD_CODEC);
        fingerprinting.setOption(PCM_FINGERPRINT_OPTION, OPTION_ENABLED);

        for (const [ accessUnitIndex, accessUnit ] of vector.accessUnits.entries()) {
            const expected = vector.expectedOutputs[accessUnitIndex];
            const [ fingerprintedBlock ] = requireDecodedBlocks(fingerprinting.decode(accessUnit, expected.mediaTimeMicroseconds));
            const [ playedBlock ] = requireDecodedBlocks(playing.decode(accessUnit, expected.mediaTimeMicroseconds));

            expect(fingerprintedBlock.attributes.get(PCM_FINGERPRINT_ATTRIBUTE)).toBe(expected.pcmFingerprint);
            expect(fingerprintedBlock.attributes.get(BITS_PER_SAMPLE_ATTRIBUTE)).toBe(TWENTY_FOUR_BITS_PER_SAMPLE);
            expect(fingerprintedBlock).toMatchObject({ frameCount: expected.frameCount, timestampMicroseconds: expected.mediaTimeMicroseconds });
            expect(playedBlock.attributes.has(PCM_FINGERPRINT_ATTRIBUTE)).toBe(false);
            expect(playedBlock.channelData).toEqual(fingerprintedBlock.channelData);
        }
        // Outside a block, an attribute reads the decoder's latest value
        expect(fingerprinting.readAttribute(PCM_FINGERPRINT_ATTRIBUTE)).toBe(vector.expectedOutputs.at(-1)?.pcmFingerprint);
        expect(playing.readAttribute(PCM_FINGERPRINT_ATTRIBUTE)).toBeNull();
        fingerprinting.close();
        playing.close();
    });

    it('reports a dropped packet, and one a decoder accepts without output, as distinct outcomes', async () => {
        const mlp = await AudioDecoderPackageInstance.create(source, MLP_CODEC);
        const trueHD = await AudioDecoderPackageInstance.create(source, TRUEHD_CODEC);
        const dependentAccessUnit = vector.accessUnits[vector.majorSyncRecoveryStartIndex];

        // The MLP decoder refuses TrueHD's major sync
        expect(mlp.decode(vector.accessUnits[0], 0)).toEqual({ kind: 'dropped' });
        // A dependent access unit before any major sync decodes to nothing
        expect(trueHD.decode(dependentAccessUnit, 0)).toEqual({ blocks: [], kind: 'decoded' });
        mlp.close();
        trueHD.close();
    });

    it('decodes from a clean state after clear, and refuses every call once closed', async () => {
        const instance = await AudioDecoderPackageInstance.create(source, TRUEHD_CODEC);
        const [ firstAccessUnit ] = vector.accessUnits;
        const [ firstExpected ] = vector.expectedOutputs;
        instance.decode(firstAccessUnit, firstExpected.mediaTimeMicroseconds);

        instance.clear();
        expect(requireDecodedBlocks(instance.decode(firstAccessUnit, firstExpected.mediaTimeMicroseconds))).toHaveLength(1);
        instance.close();
        instance.close();

        const closedError = new Error(`audio decoder ${DECODER_NAME} is closed`);
        expect(() => instance.clear()).toThrow(closedError);
        expect(() => instance.configure(CODEC_PRIVATE_BYTES)).toThrow(closedError);
        expect(() => instance.decode(firstAccessUnit, firstExpected.mediaTimeMicroseconds)).toThrow(closedError);
        expect(() => instance.readAttribute(LIBRARY_VERSION_ATTRIBUTE)).toThrow(closedError);
        expect(() => instance.setOption(PCM_FINGERPRINT_OPTION, OPTION_ENABLED)).toThrow(closedError);
    });
});

describe('the TrueHD package on PackageSoftwareAudioDecoder', () => {
    it('decodes TrueHD access units at the timestamps native FFmpeg gives them', async () => {
        const decoder = await PackageSoftwareAudioDecoder.create(source, TRUEHD_CODEC, null);

        const outputs = vector.accessUnits.flatMap((data: Uint8Array, accessUnitIndex: number) => [
            ...decoder.decode(data, vector.expectedOutputs[accessUnitIndex].mediaTimeMicroseconds)
        ]);

        expect(outputs.map(({ frameCount, mediaTimeMicroseconds }) => ({ frameCount, mediaTimeMicroseconds })))
            .toEqual(vector.expectedOutputs.map(({ frameCount, mediaTimeMicroseconds }) => ({ frameCount, mediaTimeMicroseconds })));
        expect(outputs.every(output => output.channelLayout.id === STEREO_LAYOUT_ID && output.sampleRate === vector.sampleRate)).toBe(true);
        decoder.close();
    });
});

describe('Dolby Atmos in the TrueHD package', () => {
    it('renders the objects of a TrueHD Atmos stream into a 7.1.4 target, one block per packet, and reports their count', async () => {
        const packets = readAtmosPackets(OBJECT_VECTOR_FILE);
        const instance = await createRenderingDecoder(SEVEN_POINT_ONE_POINT_FOUR_MASK, false);

        const blocks = decodeAtmosPackets(instance, packets);

        expect(blocks.map(block => block.timestampMicroseconds)).toEqual(packets.map(packet => packet.timestampMicroseconds));
        expect(sumFrameCounts(blocks)).toBe(OBJECT_VECTOR_FRAME_COUNT);
        for (const block of blocks) {
            expect(block.channelMask).toBe(SEVEN_POINT_ONE_POINT_FOUR_MASK);
            expect(block.channelData).toHaveLength(SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT);
            expect(block.attributes.get(OBJECT_COUNT_ATTRIBUTE)).toBe(OBJECT_VECTOR_DYNAMIC_OBJECT_COUNT);
        }
        instance.close();
    });

    it.each([ STEREO_MASK, FIVE_POINT_ONE_BACK_MASK, FIVE_POINT_ONE_SIDE_MASK, SEVEN_POINT_ONE_MASK ])(
        'plays the stock 7.1 presentation of a TrueHD Atmos stream at target %i with binaural off',
        async (channelMask) => {
            const packets = readAtmosPackets(OBJECT_VECTOR_FILE);
            const stock = await AudioDecoderPackageInstance.create(source, TRUEHD_CODEC);
            const instance = await createRenderingDecoder(channelMask, false);

            const stockBlocks = decodeAtmosPackets(stock, packets);
            const blocks = decodeAtmosPackets(instance, packets);

            expect(blocks).toEqual(stockBlocks);
            expect(blocks.every(block => block.channelMask === SEVEN_POINT_ONE_MASK && block.attributes.get(OBJECT_COUNT_ATTRIBUTE) === 0)).toBe(true);
            stock.close();
            instance.close();
        }
    );

    it('renders binaural stereo when binaural is on, and drains the delay of its convolution after the last packet', async () => {
        const instance = await createRenderingDecoder(STEREO_MASK, true);

        const blocks = decodeAtmosPackets(instance, readAtmosPackets(OBJECT_VECTOR_FILE));
        const drained = instance.drain();

        expect(sumFrameCounts(blocks)).toBe(OBJECT_VECTOR_FRAME_COUNT);
        expect(sumFrameCounts(drained)).toBe(BINAURAL_LATENCY_FRAME_COUNT);
        for (const block of [ ...blocks, ...drained ]) {
            expect(block.channelMask).toBe(STEREO_MASK);
            expect(block.channelData).toHaveLength(STEREO_CHANNEL_COUNT);
            expect(block.attributes.get(OBJECT_COUNT_ATTRIBUTE)).toBe(OBJECT_VECTOR_DYNAMIC_OBJECT_COUNT);
        }
        expect(drained.every(block => block.timestampMicroseconds === null)).toBe(true);
        instance.close();
    });

    it('renders a 16-channel bed without object metadata from the speakers its channels name, sample for sample as truehdd decodes it', async () => {
        const instance = await createRenderingDecoder(SEVEN_POINT_ONE_POINT_FOUR_MASK, false);

        const blocks = decodeAtmosPackets(instance, readAtmosPackets(CHANNEL_BED_VECTOR_FILE));

        expect(blocks.every(block => block.channelMask === SEVEN_POINT_ONE_POINT_FOUR_MASK && block.attributes.get(OBJECT_COUNT_ATTRIBUTE) === 0)).toBe(true);
        const joinChannel = (channel: number): Float32Array => Float32Array.from(blocks.flatMap(block => [ ...block.channelData[channel] ]));
        // The bed's L and Lw both fold onto FL at sqrt(1/2); a float rendering error far below half a 24-bit step leaves L's integers recoverable
        const frontLeft = Int32Array.from(joinChannel(0), sample => Math.round(sample / Math.SQRT1_2 * TWENTY_FOUR_BIT_FULL_SCALE));
        expect(frontLeft).toHaveLength(CHANNEL_BED_VECTOR_FRAME_COUNT);
        expect(createHash('sha256').update(new Uint8Array(frontLeft.buffer)).digest('hex')).toBe(CHANNEL_BED_LEFT_SHA256);
        for (let channel = 1; channel < SEVEN_POINT_ONE_POINT_FOUR_CHANNEL_COUNT; channel += 1) {
            expect(joinChannel(channel).every(sample => sample === 0)).toBe(true);
        }
        instance.close();
    });

    it('starts rendering at the first major sync after the target needs objects, and stops at once when it no longer does', async () => {
        // The stream twice over, as one stream: the second pass starts with the major sync of access unit 0
        const pass = readAtmosPackets(CHANNEL_BED_VECTOR_FILE);
        const passDurationMicroseconds = pass.length * ACCESS_UNITS_PER_PACKET * ACCESS_UNIT_FRAME_COUNT * MICROSECONDS_PER_SECOND / SAMPLE_RATE;
        const packets = [ ...pass, ...pass.map(packet => ({ ...packet, timestampMicroseconds: packet.timestampMicroseconds + passDurationMicroseconds })) ];
        const instance = await createRenderingDecoder(SEVEN_POINT_ONE_MASK, false);
        // Both in a pass's first 128 access units, so rendering starts at the first pass's second major sync
        const switchPacket = 10;
        const returnPacket = pass.length + 10;

        const masks = packets.map((packet, packetIndex) => {
            if (packetIndex === switchPacket) {
                instance.setOption(RENDER_CHANNEL_MASK_OPTION, SEVEN_POINT_ONE_POINT_FOUR_MASK);
            }
            if (packetIndex === returnPacket) {
                instance.setOption(RENDER_CHANNEL_MASK_OPTION, SEVEN_POINT_ONE_MASK);
            }
            return requireDecodedBlocks(instance.decode(packet.data, packet.timestampMicroseconds)).map(block => block.channelMask);
        });

        const firstRenderedPacket = pass.findIndex(packet => packet.firstAccessUnit >= SECOND_MAJOR_SYNC_ACCESS_UNIT);
        const expectedMasks = packets.map((_, packetIndex) => (
            packetIndex >= firstRenderedPacket && packetIndex < returnPacket ? SEVEN_POINT_ONE_POINT_FOUR_MASK : SEVEN_POINT_ONE_MASK
        ));
        expect(masks.map(packetMasks => [ ...new Set(packetMasks) ])).toEqual(expectedMasks.map(mask => [ mask ]));
        instance.close();
    });

    it('decodes non-Atmos TrueHD and MLP exactly as stock FFmpeg does at every target', async () => {
        const targets = [ ...SPEAKER_TARGET_MASKS.map(channelMask => ({ binaural: false, channelMask })), { binaural: true, channelMask: STEREO_MASK } ];
        for (const exactVector of createTrueHDExactCapabilityVectors()) {
            for (const { binaural, channelMask } of targets) {
                const instance = await AudioDecoderPackageInstance.create(source, exactVector.codec);
                instance.setOption(PCM_FINGERPRINT_OPTION, OPTION_ENABLED);
                instance.setOption(RENDER_CHANNEL_MASK_OPTION, channelMask);
                instance.setOption(RENDER_BINAURAL_OPTION, binaural ? 1 : 0);

                for (const [ accessUnitIndex, accessUnit ] of exactVector.accessUnits.entries()) {
                    const expected = exactVector.expectedOutputs[accessUnitIndex];
                    const [ block ] = requireDecodedBlocks(instance.decode(accessUnit, expected.mediaTimeMicroseconds));

                    expect(block.attributes.get(PCM_FINGERPRINT_ATTRIBUTE)).toBe(expected.pcmFingerprint);
                    expect(block.attributes.get(OBJECT_COUNT_ATTRIBUTE)).toBe(0);
                    expect(block.channelMask).toBe(exactVector.channelMask);
                }
                instance.close();
            }
        }
    });

    it('reports the rendered layout and object count through PackageSoftwareAudioDecoder', async () => {
        const decoder = await PackageSoftwareAudioDecoder.create(source, TRUEHD_CODEC, null);
        decoder.setRenderTarget({ binaural: false, channelMask: SEVEN_POINT_ONE_POINT_FOUR_MASK });

        const outputs = readAtmosPackets(OBJECT_VECTOR_FILE).flatMap(packet => [
            ...decoder.decode(packet.data, requireMicroseconds(packet.timestampMicroseconds, 'packet timestamp'))
        ]);

        expect(outputs.every(output => (
            output.channelMask === SEVEN_POINT_ONE_POINT_FOUR_MASK && output.objectCount === OBJECT_VECTOR_DYNAMIC_OBJECT_COUNT
        ))).toBe(true);
        decoder.close();
    });
});

describe('the TrueHD package on hand-made access units', () => {
    const masksOf = (blocks: readonly AudioDecoderPackageBlock[]): number[] => [ ...new Set(blocks.map(block => block.channelMask)) ];

    it('skips an Evolution payload whose length runs past its frame, and renders again from the next object metadata', async () => {
        const accessUnits = readAccessUnits(OBJECT_VECTOR_FILE);
        const packets = groupAccessUnits([ replaceExtraData(accessUnits[0], createWrappingEvolutionFrame()), ...accessUnits.slice(1) ]);
        const instance = await createRenderingDecoder(SEVEN_POINT_ONE_POINT_FOUR_MASK, false);

        const masks = packets.map(packet => masksOf(requireDecodedBlocks(instance.decode(packet.data, packet.timestampMicroseconds))));

        // The first access unit lost its metadata, so the stock decode plays until the next metadata, in access unit 38
        expect(masks[0]).toEqual([ SEVEN_POINT_ONE_MASK ]);
        expect(masks.at(-1)).toEqual([ SEVEN_POINT_ONE_POINT_FOUR_MASK ]);
        instance.close();
    });

    it('refuses an access unit whose last substream directory entry carries an extra word past its end', async () => {
        const [ majorSyncAccessUnit ] = readAccessUnits(OBJECT_VECTOR_FILE);
        // Four entries of a non-restart access unit with no substream data; the last one's extra word ends 2 bytes past the 12-byte access unit
        const shortAccessUnit = sealAccessUnit(Uint8Array.of(0, 0, 0, 0, 0x40, 0, 0x40, 0, 0x40, 0, 0xC0, 0), 4, 8);
        const instance = await createRenderingDecoder(SEVEN_POINT_ONE_POINT_FOUR_MASK, false);

        const blocks = requireDecodedBlocks(instance.decode(joinBytes([ majorSyncAccessUnit, shortAccessUnit, Uint8Array.of(0, 0) ]), 0));

        expect(blocks).toHaveLength(1);
        expect(masksOf(blocks)).toEqual([ SEVEN_POINT_ONE_MASK ]);
        instance.close();
    });

    it('plays the stock decode of a packet whose rendered block would pass the engine\'s block bound', async () => {
        // 420 access units of 40 frames in one packet: 16,800 frames
        const accessUnits = readAccessUnits(OBJECT_VECTOR_FILE);
        const decoder = await PackageSoftwareAudioDecoder.create(source, TRUEHD_CODEC, null);
        decoder.setRenderTarget({ binaural: false, channelMask: SEVEN_POINT_ONE_POINT_FOUR_MASK });

        const outputs = decoder.decode(joinBytes([ ...accessUnits, ...accessUnits, ...accessUnits ]), requireMicroseconds(0, 'packet timestamp'));

        expect(outputs.reduce((frameCount, output) => frameCount + output.frameCount, 0)).toBe(3 * OBJECT_VECTOR_FRAME_COUNT);
        expect(outputs.every(output => output.channelMask === SEVEN_POINT_ONE_MASK && output.objectCount === 0)).toBe(true);
        decoder.close();
    });

    it('renders again only from the next major sync after FFmpeg drops a packet', async () => {
        const packets = readAtmosPackets(CHANNEL_BED_VECTOR_FILE);
        const droppedPacket = 5;
        // An access unit of a header and nothing else, which FFmpeg refuses, leads the packet, so FFmpeg drops the packet's real access units too
        const emptyAccessUnit = Uint8Array.of(0x00, 0x02, 0x00, 0x00);
        const instance = await createRenderingDecoder(SEVEN_POINT_ONE_POINT_FOUR_MASK, false);

        const results = packets.map((packet, packetIndex) => instance.decode(
            packetIndex === droppedPacket ? joinBytes([ emptyAccessUnit, packet.data ]) : packet.data,
            packet.timestampMicroseconds
        ));

        expect(results[droppedPacket]).toEqual({ kind: 'dropped' });
        packets.forEach((packet, packetIndex) => {
            if (packetIndex === droppedPacket) {
                return;
            }
            const masks = masksOf(requireDecodedBlocks(results[packetIndex]));
            if (packetIndex < droppedPacket || packet.firstAccessUnit >= SECOND_MAJOR_SYNC_ACCESS_UNIT) {
                expect(masks).toEqual([ SEVEN_POINT_ONE_POINT_FOUR_MASK ]);
            } else {
                expect(masks).not.toContain(SEVEN_POINT_ONE_POINT_FOUR_MASK);
            }
        });
        instance.close();
    });
});

describe('single-substream TrueHD in the TrueHD package', () => {
    /** Joins blocks' planar float samples back into interleaved 24-bit integers, which a lossless decode reproduces exactly. */
    function interleaveSamples(blocks: readonly AudioDecoderPackageBlock[], channelCount: number): Int32Array {
        const frameCount = sumFrameCounts(blocks);
        const samples = new Int32Array(frameCount * channelCount);
        let firstFrame = 0;
        for (const block of blocks) {
            for (let frame = 0; frame < block.frameCount; frame += 1) {
                for (let channel = 0; channel < channelCount; channel += 1) {
                    samples[(firstFrame + frame) * channelCount + channel] = block.channelData[channel][frame] * TWENTY_FOUR_BIT_FULL_SCALE;
                }
            }
            firstFrame += block.frameCount;
        }
        return samples;
    }

    it('decodes 5.1 that one substream carries, which FFmpeg refuses, sample for sample as encoded, in WAVE order', async () => {
        const packets = readAtmosPackets(SINGLE_SUBSTREAM_VECTOR_FILE);
        const instance = await AudioDecoderPackageInstance.create(source, TRUEHD_CODEC);

        const blocks = decodeAtmosPackets(instance, packets);

        expect(blocks.map(block => block.timestampMicroseconds)).toEqual(packets.map(packet => packet.timestampMicroseconds));
        expect(sumFrameCounts(blocks)).toBe(SINGLE_SUBSTREAM_FRAME_COUNT);
        expect(blocks.every(block => (
            block.channelMask === FIVE_POINT_ONE_SIDE_MASK
            && block.channelData.length === SINGLE_SUBSTREAM_CHANNEL_COUNT
            && block.attributes.get(BITS_PER_SAMPLE_ATTRIBUTE) === TWENTY_FOUR_BITS_PER_SAMPLE
        ))).toBe(true);
        const samples = interleaveSamples(blocks, SINGLE_SUBSTREAM_CHANNEL_COUNT);
        expect(createHash('sha256').update(new Uint8Array(samples.buffer)).digest('hex')).toBe(SINGLE_SUBSTREAM_SAMPLES_SHA256);
        instance.close();
    });

    it('awaits the next major sync after clear, then decodes from it', async () => {
        const accessUnits = readAccessUnits(SINGLE_SUBSTREAM_VECTOR_FILE);
        const instance = await AudioDecoderPackageInstance.create(source, TRUEHD_CODEC);
        const [ majorSyncAccessUnit, dependentAccessUnit ] = accessUnits;
        requireDecodedBlocks(instance.decode(majorSyncAccessUnit, 0));

        instance.clear();

        // The decode is still the single-substream one, which has no major sync to start from
        expect(instance.decode(dependentAccessUnit, 0)).toEqual({ kind: 'awaiting-sync' });
        expect(requireDecodedBlocks(instance.decode(majorSyncAccessUnit, 0))).toHaveLength(1);
        instance.close();
    });

    it('decodes a stream FFmpeg decodes with FFmpeg again from the first major sync that describes it', async () => {
        const [ singleSubstreamAccessUnit ] = readAccessUnits(SINGLE_SUBSTREAM_VECTOR_FILE);
        const atmosPackets = readAtmosPackets(CHANNEL_BED_VECTOR_FILE);
        const instance = await AudioDecoderPackageInstance.create(source, TRUEHD_CODEC);

        const [ singleSubstreamBlock ] = requireDecodedBlocks(instance.decode(singleSubstreamAccessUnit, 0));
        const atmosBlocks = decodeAtmosPackets(instance, atmosPackets);

        expect(singleSubstreamBlock.channelMask).toBe(FIVE_POINT_ONE_SIDE_MASK);
        // FFmpeg's stock decode of the Atmos stream is its 7.1 presentation
        expect(atmosBlocks.every(block => block.channelMask === SEVEN_POINT_ONE_MASK)).toBe(true);
        expect(sumFrameCounts(atmosBlocks)).toBe(CHANNEL_BED_VECTOR_FRAME_COUNT);
        instance.close();
    });
});
