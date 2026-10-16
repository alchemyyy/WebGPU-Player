// @vitest-environment node

import { beforeAll, describe, expect, it } from 'vitest';

import type { AudioDecoderManifest } from 'webgpu-player/decode/audio/AudioDecoderManifest';
import AudioDecoderPackageInstance, {
    AudioDecoderPackageError,
    findMissingAudioDecoderExports,
    isAudioDecoderModuleSource,
    isAudioDecoderPackageSelection,
    type AudioDecoderModuleSource
} from 'webgpu-player/decode/audio/AudioDecoderPackageInstance';
import PackageSoftwareAudioDecoder from 'webgpu-player/decode/audio/PackageSoftwareAudioDecoder';
import {
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
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
const UNDECLARED_OPTION_KEY = 1;
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

let source: AudioDecoderModuleSource;
let eac3Packets: EncodedAudioPacket[];
let ac3Packets: EncodedAudioPacket[];

beforeAll(async () => {
    source = await loadDecoderProjectAudioSource(PROJECT);
    eac3Packets = await readContainerAudioPackets(createNativeMediaAudioProbeVector(EAC3_CODEC, STEREO_CHANNEL_COUNT));
    ac3Packets = await readContainerAudioPackets(createNativeMediaAudioProbeVector(AC3_CODEC, FIVE_POINT_ONE_CHANNEL_COUNT));
});

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
        const decoder = await PackageSoftwareAudioDecoder.create(source, EAC3_CODEC);

        const outputs = eac3Packets.flatMap(packet => [ ...decoder.decode(packet.data, packet.timestampMicroseconds) ]);

        expect(outputs).toHaveLength(eac3Packets.length);
        expect(outputs.map(output => output.mediaTimeMicroseconds)).toEqual(eac3Packets.map(packet => packet.timestampMicroseconds));
        expect(outputs.every(output => output.channelLayout.id === STEREO_LAYOUT_ID && output.frameCount === SYNCFRAME_FRAME_COUNT)).toBe(true);
        decoder.close();
    });

    it('returns no output for a packet its decoder drops', async () => {
        const decoder = await PackageSoftwareAudioDecoder.create(source, EAC3_CODEC);

        expect(decoder.decode(new Uint8Array(source.manifest.packetByteLength), PACKET_TIME_MICROSECONDS)).toEqual([]);
        decoder.close();
    });

    it('refuses a codec its package does not decode', async () => {
        await expect(PackageSoftwareAudioDecoder.create(source, OTHER_CODEC))
            .rejects.toThrow(new RangeError(`audio decoder ${DECODER_NAME} decodes no ${OTHER_CODEC}`));
    });

    it('names its package when it refuses a packet timestamp, and refuses every call once closed', async () => {
        const decoder = await PackageSoftwareAudioDecoder.create(source, EAC3_CODEC);
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
