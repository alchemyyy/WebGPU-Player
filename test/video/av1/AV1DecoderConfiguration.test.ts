// @vitest-environment node

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../../helpers/enginePaths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    ALL_FORMATS,
    BufferSource,
    BufferTarget,
    EncodedPacket,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    MkvOutputFormat,
    Output,
    type InputVideoTrack
} from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import { createAV1CodecParameterString } from 'webgpu-player/video/av1/AV1CodecParameterString';
import { assignAV1SequenceHeaderCodecString } from 'webgpu-player/video/av1/AV1DecoderConfiguration';
import {
    findAV1SequenceHeader,
    type AV1SequenceHeader
} from 'webgpu-player/video/av1/AV1SequenceHeaderParser';
import { assignISOBaseMediaDolbyVisionSampleEntryCodec } from 'webgpu-player/video/dolby-vision/ISOBaseMediaDolbyVisionSampleEntry';
import { createNativeVideoCapabilityVector } from 'webgpu-player/capability/vectors/NativeVideoCapabilityVectors';

type VectorCodecStrings = {
    bitstreamCodecString: string
    fileName: string
    mediabunnyCodecString: string
};

const VECTOR_DIRECTORY = resolve(CODEC_VECTOR_ASSETS_DIRECTORY, 'dolby-vision-av1');
const SUB_PROFILES = [ '10.0', '10.1', '10.2', '10.4' ] as const;
// What Mediabunny 1.52.2 reports for each vector, and what its sequence header declares
const VECTOR_CODEC_STRINGS: readonly VectorCodecStrings[] = [
    {
        bitstreamCodecString: 'av01.0.00M.10',
        fileName: 'profile10.0.mkv',
        mediabunnyCodecString: 'av01.0.00M.08.0.110.01.01.01.1'
    },
    {
        bitstreamCodecString: 'av01.0.00M.10',
        fileName: 'profile10.0.mp4',
        mediabunnyCodecString: 'av01.0.00M.10'
    },
    {
        bitstreamCodecString: 'av01.0.00M.10.0.110.09.16.09.0',
        fileName: 'profile10.1.mkv',
        mediabunnyCodecString: 'av01.0.00M.08.1.110.09.16.09.0'
    },
    {
        bitstreamCodecString: 'av01.0.00M.10.0.110.09.16.09.0',
        fileName: 'profile10.1.mp4',
        mediabunnyCodecString: 'av01.0.00M.10.0.110.09.16.09.0'
    },
    {
        bitstreamCodecString: 'av01.0.00M.10',
        fileName: 'profile10.2.mkv',
        mediabunnyCodecString: 'av01.0.00M.08'
    },
    {
        bitstreamCodecString: 'av01.0.00M.10',
        fileName: 'profile10.2.mp4',
        mediabunnyCodecString: 'av01.0.00M.10'
    },
    {
        bitstreamCodecString: 'av01.0.00M.10.0.110.09.18.09.0',
        fileName: 'profile10.4.mkv',
        mediabunnyCodecString: 'av01.0.00M.08.1.110.09.18.09.0'
    },
    {
        bitstreamCodecString: 'av01.0.00M.10.0.110.09.18.09.0',
        fileName: 'profile10.4.mp4',
        mediabunnyCodecString: 'av01.0.00M.10.0.110.09.18.09.0'
    }
];
const AV1_CONFIGURATION_RECORD_BOX_TYPE = [ 0x61, 0x76, 0x31, 0x43 ];
const BOX_HEADER_BYTE_LENGTH = 8;
const AV1_CONFIGURATION_RECORD_HEADER_BYTE_LENGTH = 4;

/** Opens a video track as the worker does, with Dolby Vision sample entries mapped to their codec. */
async function withVideoTrack(
    data: Uint8Array,
    inspect: (track: InputVideoTrack) => Promise<void>
): Promise<void> {
    // Mediabunny warns about the dav1 sample entry it leaves unmapped
    vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(data) });
    try {
        const videoTracks = await input.getVideoTracks();
        expect(videoTracks).toHaveLength(1);
        await assignISOBaseMediaDolbyVisionSampleEntryCodec(videoTracks[0]);
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
        const firstPacket = await new EncodedPacketSink(track).getFirstPacket();
        sequenceHeader = firstPacket && findAV1SequenceHeader(firstPacket.data);
    });
    return sequenceHeader;
}

/** Returns an MP4 file's av1C record: its four header bytes and its configOBUs. */
function readAV1ConfigurationRecord(fileBytes: Uint8Array): { configOBUs: Uint8Array, header: Uint8Array } {
    for (let typeOffset = 4; typeOffset + BOX_HEADER_BYTE_LENGTH <= fileBytes.byteLength; typeOffset += 1) {
        if (AV1_CONFIGURATION_RECORD_BOX_TYPE.every((value: number, index: number): boolean => (
            fileBytes[typeOffset + index] === value
        ))) {
            const boxOffset = typeOffset - 4;
            const boxByteLength = new DataView(fileBytes.buffer, fileBytes.byteOffset).getUint32(boxOffset);
            const recordOffset = boxOffset + BOX_HEADER_BYTE_LENGTH;
            return {
                configOBUs: fileBytes.subarray(
                    recordOffset + AV1_CONFIGURATION_RECORD_HEADER_BYTE_LENGTH,
                    boxOffset + boxByteLength
                ),
                header: fileBytes.subarray(recordOffset, recordOffset + AV1_CONFIGURATION_RECORD_HEADER_BYTE_LENGTH)
            };
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

async function readDecoderConfig(
    fileName: string,
    assignCodecString: boolean
): Promise<{ assigned: boolean, decoderConfig: VideoDecoderConfig | null }> {
    let assigned = false;
    let decoderConfig: VideoDecoderConfig | null = null;
    await withVideoTrack(readVector(fileName), async (track: InputVideoTrack): Promise<void> => {
        assigned = assignCodecString && await assignAV1SequenceHeaderCodecString(track);
        decoderConfig = await track.getDecoderConfig();
    });
    return { assigned, decoderConfig };
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

describe('AV1DecoderConfiguration', () => {
    it.each(SUB_PROFILES)(
        'reads the same Profile %s sequence header from Matroska and MP4, matching the MP4 av1C',
        async (subProfile: string) => {
            const matroskaSequenceHeader = await readFirstPacketSequenceHeader(`profile${subProfile}.mkv`);
            const isoBaseMediaSequenceHeader = await readFirstPacketSequenceHeader(`profile${subProfile}.mp4`);
            if (!matroskaSequenceHeader || !isoBaseMediaSequenceHeader) {
                throw new Error('A vector has no sequence header in its first packet');
            }

            expect(createAV1CodecParameterString(matroskaSequenceHeader))
                .toBe(createAV1CodecParameterString(isoBaseMediaSequenceHeader));
            const record = readAV1ConfigurationRecord(readVector(`profile${subProfile}.mp4`));
            const [ , profileAndLevel, colorFormat ] = record.header;
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
            expect(findAV1SequenceHeader(record.configOBUs)).toEqual(isoBaseMediaSequenceHeader);
        }
    );

    it.each(VECTOR_CODEC_STRINGS)(
        'replaces only a misread codec string: $fileName',
        async ({ bitstreamCodecString, fileName, mediabunnyCodecString }) => {
            const original = await readDecoderConfig(fileName, false);
            const corrected = await readDecoderConfig(fileName, true);

            expect(original.decoderConfig?.codec).toBe(mediabunnyCodecString);
            expect(corrected.decoderConfig?.codec).toBe(bitstreamCodecString);
            expect(corrected.assigned).toBe(mediabunnyCodecString !== bitstreamCodecString);
            // Every other field of Mediabunny's configuration is kept
            expect({ ...corrected.decoderConfig, codec: mediabunnyCodecString }).toEqual(original.decoderConfig);
        }
    );

    it('serves the corrected codec string to every later reader of the track', async () => {
        await withVideoTrack(readVector('profile10.4.mkv'), async (track: InputVideoTrack): Promise<void> => {
            expect(await assignAV1SequenceHeaderCodecString(track)).toBe(true);

            expect(await track.getCodecParameterString()).toBe('av01.0.00M.10.0.110.09.18.09.0');
            expect((await track.getDecoderConfig())?.codec).toBe('av01.0.00M.10.0.110.09.18.09.0');
        });
    });

    it('leaves a track untouched without a sequence header, an AV1 codec, or the expected backing', async () => {
        const matroskaWithoutSequenceHeader = await createMatroskaWithoutSequenceHeader();
        await withVideoTrack(matroskaWithoutSequenceHeader, async (track: InputVideoTrack): Promise<void> => {
            const firstPacket = await new EncodedPacketSink(track).getFirstPacket();
            expect(await track.getCodec()).toBe('av1');
            expect(firstPacket && findAV1SequenceHeader(firstPacket.data)).toBeNull();
            const decoderConfig = await track.getDecoderConfig();

            expect(await assignAV1SequenceHeaderCodecString(track)).toBe(false);
            expect(await track.getDecoderConfig()).toBe(decoderConfig);
        });

        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const unmappedInput = new Input({ formats: ALL_FORMATS, source: new BufferSource(readVector('profile10.0.mp4')) });
        try {
            const [ unmappedTrack ] = await unmappedInput.getVideoTracks();
            // Without the Dolby Vision sample entry mapping, Mediabunny gives a dav1 track no codec
            expect(await assignAV1SequenceHeaderCodecString(unmappedTrack)).toBe(false);
        } finally {
            unmappedInput.dispose();
        }

        await withVideoTrack(readVector('profile10.0.mkv'), async (track: InputVideoTrack): Promise<void> => {
            const backing = (track as unknown as { _backing: Record<string, unknown> })._backing;
            delete backing.decoderConfigPromise;

            expect(await assignAV1SequenceHeaderCodecString(track)).toBe(false);
            expect((await track.getDecoderConfig())?.codec).toBe('av01.0.00M.08.0.110.01.01.01.1');
        });
    });
});
