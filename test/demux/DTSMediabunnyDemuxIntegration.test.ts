// @vitest-environment node

import { TEST_VECTORS_DIRECTORY } from '../helpers/enginePaths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacketSink,
    Input
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { getContainerAudioCodec } from 'webgpu-player/demux/CustomAudioTrackMetadata';

const MATROSKA_VECTOR_PATH = resolve(TEST_VECTORS_DIRECTORY, 'dts', 'core_51_24_48_768_0.mka');
const MATROSKA_DTS_CODEC_ID = 'A_DTS';
const DTS_CODEC = 'dts';
const DTS_CHANNEL_COUNT = 6;
const DTS_SAMPLE_RATE = 48_000;

describe('Mediabunny DTS demux integration', () => {
    it('surfaces Matroska A_DTS packets, which the engine identifies by their codec ID', async () => {
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
            expect(codec).toBeNull();
            expect(await track.getDecoderConfig()).toBeNull();
            expect(internalCodecID).toBe(MATROSKA_DTS_CODEC_ID);
            expect(getContainerAudioCodec(codec, internalCodecID)).toBe(DTS_CODEC);
            expect(await track.getNumberOfChannels()).toBe(DTS_CHANNEL_COUNT);
            expect(await track.getSampleRate()).toBe(DTS_SAMPLE_RATE);

            const packetSink = new EncodedPacketSink(track);
            let packetCount = 0;
            let positiveDurationPacketCount = 0;
            for await (const packet of packetSink.packets()) {
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
});
