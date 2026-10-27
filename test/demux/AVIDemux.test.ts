// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    ALL_FORMATS,
    AviInputFormat,
    BufferSource,
    Input,
    PacketCursor,
    type EncodedPacket,
    type InputTrack
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { hasIncompleteAVIIndex } from 'webgpu-player/demux/AVIIndexCoverage';
import { secondsToMicroseconds } from 'webgpu-player/MediaTime';

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';

// The FFmpeg-made vectors of scripts/codec_vector_assets/generate_AVI_demux_vectors.py
const AVI_VECTOR_DIRECTORY = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'avi');
const VIDEO_FRAME_COUNT = 12;
const VIDEO_FRAME_RATE = 24;
const KEY_FRAME_INTERVAL = 6;
const AUDIO_SAMPLE_RATE = 48_000;
const MP3_FRAME_SAMPLE_COUNT = 1_152;
const AC3_FRAME_SAMPLE_COUNT = 1_536;
const AAC_FRAME_SAMPLE_COUNT = 1_024;
const STEREO_CHANNEL_COUNT = 2;
const PCM_S16_BYTES_PER_SAMPLE = 2;
// 64 kb/s constant-bitrate MP3
const MP3_CONSTANT_BYTE_RATE = 8_000;
// FFmpeg drops the first frame of a B-frame-free x264 encode into an empty chunk, so its second packet starts a slot late
const DROPPED_FRAME_SLOT_COUNT = 1;
const FIVE_POINT_ONE_CHANNEL_COUNT = 6;
const PCM_S24_BYTES_PER_SAMPLE = 3;
const PCM_F32_BYTES_PER_SAMPLE = 4;
// FFmpeg's FLAC encoder codes 4608-sample frames at 48 kHz
const FLAC_FRAME_SAMPLE_COUNT = 4_608;
// 'fLaC', a metadata block header, and the 34-byte STREAMINFO
const FLAC_DESCRIPTION_BYTE_LENGTH = 42;
// Where the stream header of the first stream list keeps dwLength: after RIFF, hdrl, avih, the strl list, and strh's own header
const STREAM_HEADER_FOURCC = 'strh';
const STREAM_HEADER_LENGTH_OFFSET = 8 + 32;
// A declared length far past the indexed frames, as an OpenDML file's first RIFF list declares
const OPENDML_DECLARED_FRAME_COUNT = 10_000;
const ROUNDING_TOLERANCE_MICROSECONDS = 1;
// A Matroska vector, whose tracks the AVI index check leaves alone
const MATROSKA_VECTOR_PATH = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'hdr10plus-vp9', 'hdr10plus.mkv');

type AVIVectorExpectation = Readonly<{
    audioCodec: string
    audioDecoderCodec: string
    fileName: string
    videoCodec: string
    videoDecoderCodec: string
}>;

const AVI_VECTORS: readonly AVIVectorExpectation[] = [
    { audioCodec: 'mp3', audioDecoderCodec: 'mp3', fileName: 'h264-bframes-mp3-vbr.avi', videoCodec: 'avc', videoDecoderCodec: 'avc1.64000c' },
    { audioCodec: 'mp3', audioDecoderCodec: 'mp3', fileName: 'h264-mp3-cbr.avi', videoCodec: 'avc', videoDecoderCodec: 'avc1.64000c' },
    { audioCodec: 'pcm-s16', audioDecoderCodec: 'pcm-s16', fileName: 'vp8-pcm_s16le.avi', videoCodec: 'vp8', videoDecoderCodec: 'vp8' },
    { audioCodec: 'aac', audioDecoderCodec: 'mp4a.40.2', fileName: 'vp9-aac.avi', videoCodec: 'vp9', videoDecoderCodec: 'vp09.00.10.08.01.02.02.02.00' },
    { audioCodec: 'ac3', audioDecoderCodec: 'ac-3', fileName: 'av1-ac3.avi', videoCodec: 'av1', videoDecoderCodec: 'av01.0.00M.08' },
    { audioCodec: 'ac3', audioDecoderCodec: 'ac-3', fileName: 'hevc-ac3.avi', videoCodec: 'hevc', videoDecoderCodec: 'hev1.1.6.L60.90' },
    { audioCodec: 'mp3', audioDecoderCodec: 'mp3', fileName: 'mpeg4-mp3.avi', videoCodec: 'mpeg4', videoDecoderCodec: 'mp4v' },
    { audioCodec: 'pcm-s24', audioDecoderCodec: 'pcm-s24', fileName: 'vp9-pcm_s24le-5.1.avi', videoCodec: 'vp9', videoDecoderCodec: 'vp09.00.10.08.01.02.02.02.00' },
    { audioCodec: 'pcm-f32', audioDecoderCodec: 'pcm-f32', fileName: 'vp9-pcm_f32le-5.1.avi', videoCodec: 'vp9', videoDecoderCodec: 'vp09.00.10.08.01.02.02.02.00' },
    { audioCodec: 'flac', audioDecoderCodec: 'flac', fileName: 'vp9-flac-5.1.avi', videoCodec: 'vp9', videoDecoderCodec: 'vp09.00.10.08.01.02.02.02.00' },
    { audioCodec: 'flac', audioDecoderCodec: 'flac', fileName: 'vp9-flac.avi', videoCodec: 'vp9', videoDecoderCodec: 'vp09.00.10.08.01.02.02.02.00' },
    { audioCodec: 'vorbis', audioDecoderCodec: 'vorbis', fileName: 'vp9-vorbis.avi', videoCodec: 'vp9', videoDecoderCodec: 'vp09.00.10.08.01.02.02.02.00' }
];

function readAVIVector(fileName: string): Uint8Array {
    return new Uint8Array(readFileSync(join(AVI_VECTOR_DIRECTORY, fileName)));
}

function openAVI(bytes: Uint8Array): Input {
    return new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
}

async function readPackets(track: InputTrack): Promise<EncodedPacket[]> {
    const packets: EncodedPacket[] = [];
    for await (const packet of new PacketCursor(track)) {
        packets.push(packet);
    }
    return packets;
}

function toMicroseconds(seconds: number): number {
    return secondsToMicroseconds(seconds);
}

/** Requires each packet to start where the one before it ends, and to last its sample count at the vector's rate. */
function expectContiguousAudio(packets: readonly EncodedPacket[], getSampleCount: (packet: EncodedPacket) => number): void {
    // Counted in samples, so rounding never accumulates
    let samplesBefore = 0;
    for (const packet of packets) {
        const sampleCount = getSampleCount(packet);
        expect(Math.abs(toMicroseconds(packet.timestamp) - toMicroseconds(samplesBefore / AUDIO_SAMPLE_RATE)))
            .toBeLessThanOrEqual(ROUNDING_TOLERANCE_MICROSECONDS);
        expect(Math.abs(toMicroseconds(packet.duration) - toMicroseconds(sampleCount / AUDIO_SAMPLE_RATE)))
            .toBeLessThanOrEqual(ROUNDING_TOLERANCE_MICROSECONDS);
        expect(packet.type).toBe('key');
        samplesBefore += sampleCount;
    }
    expect(packets.length).toBeGreaterThan(0);
}

async function readTrackPair(fileName: string): Promise<{ audioPackets: EncodedPacket[], input: Input, videoPackets: EncodedPacket[] }> {
    const input = openAVI(readAVIVector(fileName));
    const [ videoTrack ] = await input.getVideoTracks();
    const [ audioTrack ] = await input.getAudioTracks();
    return { audioPackets: await readPackets(audioTrack), input, videoPackets: await readPackets(videoTrack) };
}

describe('AVI through the fork\'s demuxer', () => {
    it.each(AVI_VECTORS)('identifies the tracks of $fileName', async ({ audioCodec, audioDecoderCodec, fileName, videoCodec, videoDecoderCodec }) => {
        const input = openAVI(readAVIVector(fileName));
        try {
            expect(await input.getFormat()).toBeInstanceOf(AviInputFormat);
            const [ videoTrack ] = await input.getVideoTracks();
            const [ audioTrack ] = await input.getAudioTracks();
            expect(await videoTrack.getCodec()).toBe(videoCodec);
            expect((await videoTrack.getDecoderConfig())?.codec).toBe(videoDecoderCodec);
            expect(await audioTrack.getCodec()).toBe(audioCodec);
            expect((await audioTrack.getDecoderConfig())?.codec).toBe(audioDecoderCodec);
            expect(await hasIncompleteAVIIndex(input, videoTrack)).toBe(false);
        } finally {
            input.dispose();
        }
    });

    it('stamps video in decode order, one frame slot per chunk, with key frames from the idx1 flags', async () => {
        const { input, videoPackets } = await readTrackPair('h264-bframes-mp3-vbr.avi');
        try {
            expect(videoPackets).toHaveLength(VIDEO_FRAME_COUNT);
            videoPackets.forEach((packet: EncodedPacket, packetIndex: number): void => {
                expect(toMicroseconds(packet.timestamp)).toBe(toMicroseconds(packetIndex / VIDEO_FRAME_RATE));
                expect(packet.type).toBe(packetIndex % KEY_FRAME_INTERVAL === 0 ? 'key' : 'delta');
            });
        } finally {
            input.dispose();
        }
    });

    it('lets an empty video chunk take its frame slot', async () => {
        const { input, videoPackets } = await readTrackPair('h264-mp3-cbr.avi');
        try {
            expect(toMicroseconds(videoPackets[0].timestamp)).toBe(0);
            expect(toMicroseconds(videoPackets[1].timestamp)).toBe(toMicroseconds((1 + DROPPED_FRAME_SLOT_COUNT) / VIDEO_FRAME_RATE));
        } finally {
            input.dispose();
        }
    });

    it('times variable-bitrate MP3 per frame and constant-bitrate MP3 by bytes', async () => {
        const variable = await readTrackPair('h264-bframes-mp3-vbr.avi');
        const constant = await readTrackPair('h264-mp3-cbr.avi');
        try {
            expectContiguousAudio(variable.audioPackets, (): number => MP3_FRAME_SAMPLE_COUNT);
            expectContiguousAudio(constant.audioPackets, (packet: EncodedPacket): number => packet.byteLength * AUDIO_SAMPLE_RATE / MP3_CONSTANT_BYTE_RATE);
        } finally {
            variable.input.dispose();
            constant.input.dispose();
        }
    });

    it('times PCM by bytes, and AC-3 and AAC per frame', async () => {
        const pcm = await readTrackPair('vp8-pcm_s16le.avi');
        const ac3 = await readTrackPair('av1-ac3.avi');
        const aac = await readTrackPair('vp9-aac.avi');
        try {
            expectContiguousAudio(pcm.audioPackets, (packet: EncodedPacket): number => packet.byteLength / (STEREO_CHANNEL_COUNT * PCM_S16_BYTES_PER_SAMPLE));
            expectContiguousAudio(ac3.audioPackets, (): number => AC3_FRAME_SAMPLE_COUNT);
            expectContiguousAudio(aac.audioPackets, (): number => AAC_FRAME_SAMPLE_COUNT);
        } finally {
            pcm.input.dispose();
            ac3.input.dispose();
            aac.input.dispose();
        }
    });

    it('reads 5.1 WAVE_FORMAT_EXTENSIBLE PCM by bytes and FLAC per frame, with FLAC and Vorbis described', async () => {
        const pcmS24 = await readTrackPair('vp9-pcm_s24le-5.1.avi');
        const pcmF32 = await readTrackPair('vp9-pcm_f32le-5.1.avi');
        const flac = await readTrackPair('vp9-flac-5.1.avi');
        const vorbis = await readTrackPair('vp9-vorbis.avi');
        try {
            expectContiguousAudio(pcmS24.audioPackets, (packet: EncodedPacket): number => packet.byteLength / (FIVE_POINT_ONE_CHANNEL_COUNT * PCM_S24_BYTES_PER_SAMPLE));
            expectContiguousAudio(pcmF32.audioPackets, (packet: EncodedPacket): number => packet.byteLength / (FIVE_POINT_ONE_CHANNEL_COUNT * PCM_F32_BYTES_PER_SAMPLE));
            // The declared block alignment is no block size: each chunk holds one frame
            expectContiguousAudio(flac.audioPackets, (): number => FLAC_FRAME_SAMPLE_COUNT);
            const [ flacTrack ] = await flac.input.getAudioTracks();
            expect(await flacTrack.getNumberOfChannels()).toBe(FIVE_POINT_ONE_CHANNEL_COUNT);
            expect((await flacTrack.getDecoderConfig())?.description?.byteLength).toBe(FLAC_DESCRIPTION_BYTE_LENGTH);
            const [ vorbisTrack ] = await vorbis.input.getAudioTracks();
            expect((await vorbisTrack.getDecoderConfig())?.description?.byteLength).toBeGreaterThan(0);
        } finally {
            pcmS24.input.dispose();
            pcmF32.input.dispose();
            flac.input.dispose();
            vorbis.input.dispose();
        }
    });

    it('marks a video track whose declared length outruns its idx1 index, as an OpenDML file\'s does', async () => {
        const bytes = readAVIVector('vp8-pcm_s16le.avi');
        const streamHeaderOffset = Buffer.from(bytes).indexOf(STREAM_HEADER_FOURCC);
        new DataView(bytes.buffer, bytes.byteOffset).setUint32(streamHeaderOffset + STREAM_HEADER_LENGTH_OFFSET, OPENDML_DECLARED_FRAME_COUNT, true);

        const input = openAVI(bytes);
        try {
            const [ videoTrack ] = await input.getVideoTracks();
            expect(await hasIncompleteAVIIndex(input, videoTrack)).toBe(true);
        } finally {
            input.dispose();
        }
    });

    it('leaves the index check to AVI files', async () => {
        const input = openAVI(new Uint8Array(readFileSync(MATROSKA_VECTOR_PATH)));
        try {
            const [ videoTrack ] = await input.getVideoTracks();
            expect(await hasIncompleteAVIIndex(input, videoTrack)).toBe(false);
        } finally {
            input.dispose();
        }
    });
});
