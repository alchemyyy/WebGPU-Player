// @vitest-environment node

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../../helpers/enginePaths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    ALL_FORMATS,
    BufferSource,
    BufferTarget,
    EncodedPacket,
    EncodedVideoPacketSource,
    Input,
    MkvOutputFormat,
    Output,
    PacketReader,
    type InputVideoTrack
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import {
    findAV1SequenceHeader,
    type AV1SequenceHeader
} from 'webgpu-player/demux/av1/AV1SequenceHeaderParser';
import { createNativeVideoCapabilityVector } from 'webgpu-player/capability/vectors/NativeVideoCapabilityVectors';

type VectorCodecString = {
    codecString: string
    fileName: string
};

const VECTOR_DIRECTORY = resolve(CODEC_VECTOR_ASSETS_DIRECTORY, 'dolby-vision-av1');
const SUB_PROFILES = [ '10.0', '10.1', '10.2', '10.4' ] as const;
// The codec string each vector's sequence header declares under the AV1 ISOBMFF binding: Profile 10.0's header codes full range without a color description
const VECTOR_CODEC_STRINGS: readonly VectorCodecString[] = [
    { codecString: 'av01.0.00M.10.0.110.01.01.01.1', fileName: 'profile10.0.mkv' },
    { codecString: 'av01.0.00M.10.0.110.01.01.01.1', fileName: 'profile10.0.mp4' },
    { codecString: 'av01.0.00M.10.0.110.09.16.09.0', fileName: 'profile10.1.mkv' },
    { codecString: 'av01.0.00M.10.0.110.09.16.09.0', fileName: 'profile10.1.mp4' },
    { codecString: 'av01.0.00M.10', fileName: 'profile10.2.mkv' },
    { codecString: 'av01.0.00M.10', fileName: 'profile10.2.mp4' },
    { codecString: 'av01.0.00M.10.0.110.09.18.09.0', fileName: 'profile10.4.mkv' },
    { codecString: 'av01.0.00M.10.0.110.09.18.09.0', fileName: 'profile10.4.mp4' }
];
const AV1_CONFIGURATION_RECORD_BOX_TYPE = [ 0x61, 0x76, 0x31, 0x43 ];
const BOX_HEADER_BYTE_LENGTH = 8;
const AV1_CONFIGURATION_RECORD_HEADER_BYTE_LENGTH = 4;
// An av1C opens with its marker bit and version 1
const AV1_CONFIGURATION_RECORD_MARKER_AND_VERSION = 0x81;

/** Opens a file's only video track. */
async function withVideoTrack(
    data: Uint8Array,
    inspect: (track: InputVideoTrack) => Promise<void>
): Promise<void> {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(data) });
    try {
        const videoTracks = await input.getVideoTracks();
        expect(videoTracks).toHaveLength(1);
        await inspect(videoTracks[0]);
    } finally {
        input.dispose();
    }
}

function readVector(fileName: string): Uint8Array {
    return new Uint8Array(readFileSync(resolve(VECTOR_DIRECTORY, fileName)));
}

async function readFirstPacketSequenceHeader(fileName: string): Promise<AV1SequenceHeader | null> {
    let sequenceHeader: AV1SequenceHeader | null = null;
    await withVideoTrack(readVector(fileName), async (track: InputVideoTrack): Promise<void> => {
        const firstPacket = await new PacketReader(track).getFirst();
        sequenceHeader = firstPacket && findAV1SequenceHeader(firstPacket.data);
    });
    return sequenceHeader;
}

async function readDecoderConfig(data: Uint8Array): Promise<VideoDecoderConfig | null> {
    let decoderConfig: VideoDecoderConfig | null = null;
    await withVideoTrack(data, async (track: InputVideoTrack): Promise<void> => {
        decoderConfig = await track.getDecoderConfig();
    });
    return decoderConfig;
}

function toBytes(source: AllowSharedBufferSource | undefined): Uint8Array | undefined {
    if (source === undefined) {
        return undefined;
    }
    return ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
}

/** Returns an MP4 file's av1C record: its four header bytes, then its configOBUs. */
function readAV1ConfigurationRecord(fileBytes: Uint8Array): Uint8Array {
    for (let typeOffset = 4; typeOffset + BOX_HEADER_BYTE_LENGTH <= fileBytes.byteLength; typeOffset += 1) {
        if (AV1_CONFIGURATION_RECORD_BOX_TYPE.every((value: number, index: number): boolean => (
            fileBytes[typeOffset + index] === value
        ))) {
            const boxOffset = typeOffset - 4;
            const boxByteLength = new DataView(fileBytes.buffer, fileBytes.byteOffset).getUint32(boxOffset);
            return fileBytes.subarray(boxOffset + BOX_HEADER_BYTE_LENGTH, boxOffset + boxByteLength);
        }
    }
    throw new Error('The MP4 vector has no av1C record');
}

function getConfigurationRecordBitDepth(colorFormat: number): number {
    if (((colorFormat >> 5) & 1) === 1) {
        return 12;
    }
    return ((colorFormat >> 6) & 1) === 1 ? 10 : 8;
}

/** Muxes a Matroska AV1 track whose first packet carries a frame but no sequence header. */
async function createMatroskaWithoutSequenceHeader(): Promise<Uint8Array> {
    const keyFrame = createNativeVideoCapabilityVector('av1').encodedKeyFrame;
    // The engine vector is a temporal delimiter (2 bytes), a sequence header (8 bytes), then the frame
    const frameOBU = keyFrame.subarray(10);
    const target = new BufferTarget();
    const output = new Output({ format: new MkvOutputFormat(), target });
    const source = new EncodedVideoPacketSource('av1');
    output.addVideoTrack(source);
    await output.start();
    await source.add(new EncodedPacket(frameOBU, 'key', 0, 1 / 24), {
        decoderConfig: { codec: 'av01.0.00M.08', codedHeight: 64, codedWidth: 64 }
    });
    await output.finalize();
    return new Uint8Array(target.buffer as ArrayBuffer);
}

describe('AV1 decoder configuration', () => {
    it.each(SUB_PROFILES)(
        'reads the same Profile %s sequence header from Matroska and MP4, matching the MP4 av1C',
        async (subProfile: string) => {
            const matroskaSequenceHeader = await readFirstPacketSequenceHeader(`profile${subProfile}.mkv`);
            const isoBaseMediaSequenceHeader = await readFirstPacketSequenceHeader(`profile${subProfile}.mp4`);
            if (!matroskaSequenceHeader || !isoBaseMediaSequenceHeader) {
                throw new Error('A vector has no sequence header in its first packet');
            }

            expect(matroskaSequenceHeader).toEqual(isoBaseMediaSequenceHeader);
            const record = readAV1ConfigurationRecord(readVector(`profile${subProfile}.mp4`));
            const [ , profileAndLevel, colorFormat ] = record;
            const colorConfig = isoBaseMediaSequenceHeader.colorConfig;
            expect(isoBaseMediaSequenceHeader.profile).toBe(profileAndLevel >> 5);
            expect(isoBaseMediaSequenceHeader.operatingPoints[0]).toMatchObject({
                levelIndex: profileAndLevel & 0x1F,
                tier: colorFormat >> 7
            });
            expect(colorConfig.bitDepth).toBe(getConfigurationRecordBitDepth(colorFormat));
            expect(colorConfig.monochrome ? 1 : 0).toBe((colorFormat >> 4) & 1);
            expect(colorConfig.subsamplingX).toBe((colorFormat >> 3) & 1);
            expect(colorConfig.subsamplingY).toBe((colorFormat >> 2) & 1);
            expect(colorConfig.chromaSamplePosition).toBe(colorFormat & 0b11);
            // The record's configOBUs repeat the sequence header the first packet carries
            expect(findAV1SequenceHeader(record.subarray(AV1_CONFIGURATION_RECORD_HEADER_BYTE_LENGTH))).toEqual(isoBaseMediaSequenceHeader);
        }
    );

    it.each(VECTOR_CODEC_STRINGS)(
        'takes the codec string its sequence header declares and the AV1CodecConfigurationRecord as the description: $fileName',
        async ({ codecString, fileName }) => {
            const decoderConfig = await readDecoderConfig(readVector(fileName));
            const subProfileVector = fileName.replace(/\.mkv$/, '.mp4');

            expect(decoderConfig?.codec).toBe(codecString);
            // The Matroska CodecPrivate and the MP4 av1C of one stream are the same record
            expect(toBytes(decoderConfig?.description)).toEqual(readAV1ConfigurationRecord(readVector(subProfileVector)));
        }
    );

    it('reads the codec string of a Matroska track without a sequence header in its first packet from its CodecPrivate', async () => {
        const matroskaWithoutSequenceHeader = await createMatroskaWithoutSequenceHeader();
        await withVideoTrack(matroskaWithoutSequenceHeader, async (track: InputVideoTrack): Promise<void> => {
            const firstPacket = await new PacketReader(track).getFirst();
            expect(firstPacket && findAV1SequenceHeader(firstPacket.data)).toBeNull();

            const decoderConfig = await track.getDecoderConfig();
            expect(decoderConfig?.codec).toBe('av01.0.00M.08');
            expect(toBytes(decoderConfig?.description)?.[0]).toBe(AV1_CONFIGURATION_RECORD_MARKER_AND_VERSION);
        });
    });
});
