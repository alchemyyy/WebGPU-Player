// @vitest-environment node

import { CODEC_VECTOR_ASSETS_DIRECTORY, TEST_VECTORS_DIRECTORY } from '../helpers/enginePaths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    ALL_FORMATS,
    BufferSource,
    Input,
    PacketCursor,
    type AudioCodec
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { getContainerAudioCodec } from 'webgpu-player/demux/CustomAudioTrackMetadata';

const MATROSKA_VECTOR_PATH = resolve(TEST_VECTORS_DIRECTORY, 'dts', 'core_51_24_48_768_0.mka');
// The same frames remuxed into M2TS by scripts/codec_vector_assets/generate_transport_stream_demux_vectors.py
const M2TS_VECTOR_PATH = resolve(CODEC_VECTOR_ASSETS_DIRECTORY, 'mpeg-ts', 'dts-core.m2ts');
const MATROSKA_DTS_CODEC_ID = 'A_DTS';
// Mediabunny reports a transport stream track's stream type as its internal codec ID
const TRANSPORT_STREAM_DTS_STREAM_TYPE = 0x82;
const DTS_CODEC = 'dts';
const DTS_CORE_CODEC_STRING = 'dtsc';
const DTS_CHANNEL_COUNT = 6;
const DTS_SAMPLE_RATE = 48_000;

type DemuxedDTSTrack = Readonly<{
    channelCount: number
    codec: AudioCodec | null
    codecString: string | undefined
    internalCodecID: unknown
    packets: readonly Uint8Array[]
    sampleRate: number
}>;

/** Demuxes a file's one audio track and every packet of it. */
async function demuxAudioTrack(path: string): Promise<DemuxedDTSTrack> {
    const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(new Uint8Array(readFileSync(path)))
    });
    try {
        const tracks = await input.getAudioTracks();
        expect(tracks).toHaveLength(1);
        const track = tracks[0];
        const packets: Uint8Array[] = [];
        for await (const packet of new PacketCursor(track)) {
            packets.push(packet.data.slice());
        }
        return {
            channelCount: await track.getNumberOfChannels(),
            codec: await track.getCodec(),
            codecString: (await track.getDecoderConfig())?.codec,
            internalCodecID: await track.getInternalCodecId(),
            packets,
            sampleRate: await track.getSampleRate()
        };
    } finally {
        await input.dispose();
    }
}

describe('Mediabunny DTS demux integration', () => {
    it('maps Matroska A_DTS tracks to dts itself, so the engine needs no codec ID of its own', async () => {
        const input = new Input({
            formats: ALL_FORMATS,
            source: new BufferSource(new Uint8Array(readFileSync(MATROSKA_VECTOR_PATH)))
        });

        try {
            const tracks = await input.getAudioTracks();
            expect(tracks).toHaveLength(1);
            const track = tracks[0];
            const codec = await track.getCodec();
            const internalCodecID = await track.getInternalCodecId();
            expect(codec).toBe(DTS_CODEC);
            expect((await track.getDecoderConfig())?.codec).toBe(DTS_CORE_CODEC_STRING);
            expect(internalCodecID).toBe(MATROSKA_DTS_CODEC_ID);
            expect(getContainerAudioCodec(codec, internalCodecID)).toBeNull();
            expect(await track.getNumberOfChannels()).toBe(DTS_CHANNEL_COUNT);
            expect(await track.getSampleRate()).toBe(DTS_SAMPLE_RATE);

            let packetCount = 0;
            let positiveDurationPacketCount = 0;
            for await (const packet of new PacketCursor(track)) {
                expect(packet.data.byteLength).toBeGreaterThan(0);
                expect(packet.microsecondDuration).toBeGreaterThanOrEqual(0);
                if (packet.microsecondDuration > 0) {
                    positiveDurationPacketCount += 1;
                }
                packetCount += 1;
            }
            expect(packetCount).toBeGreaterThan(0);
            expect(positiveDurationPacketCount).toBeGreaterThan(0);
        } finally {
            await input.dispose();
        }
    });

    it('maps a Blu-ray program\'s DTS stream to dts, with the frames Matroska carries', async () => {
        const matroskaTrack = await demuxAudioTrack(MATROSKA_VECTOR_PATH);
        const transportStreamTrack = await demuxAudioTrack(M2TS_VECTOR_PATH);

        expect(transportStreamTrack).toMatchObject({
            channelCount: DTS_CHANNEL_COUNT,
            codec: DTS_CODEC,
            codecString: DTS_CORE_CODEC_STRING,
            internalCodecID: TRANSPORT_STREAM_DTS_STREAM_TYPE,
            sampleRate: DTS_SAMPLE_RATE
        });
        expect(getContainerAudioCodec(transportStreamTrack.codec, transportStreamTrack.internalCodecID)).toBeNull();
        expect(transportStreamTrack.packets.length).toBeGreaterThan(0);
        expect(transportStreamTrack.packets).toEqual(matroskaTrack.packets);
    });
});
