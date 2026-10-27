// @vitest-environment node

import { ALL_FORMATS, BufferSource, Input, PacketCursor, type InputVideoTrack } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import {
    ISO_BASE_MEDIA_VC1_SAMPLE_ENTRY,
    readISOBaseMediaVC1DecoderDescription
} from 'webgpu-player/demux/vc1/ISOBaseMediaVC1Configuration';

import {
    createDVC1Payload,
    createVC1AdvancedExtradata,
    createVC1AdvancedPicture,
    createVC1ISOBaseMedia,
    type SyntheticVC1Packet
} from '../../helpers/vc1Media';

const CODED_WIDTH = 640;
const CODED_HEIGHT = 480;
// SMPTE RP 2025 profiles: 4 is Main, which FFmpeg does not read a configuration of
const MAIN_PROFILE = 4;
const FRAME_DURATION_MILLISECONDS = 40;
const SAMPLES: readonly SyntheticVC1Packet[] = [
    { data: createVC1AdvancedPicture({ kind: 'I', mode: 'progressive' }, false, null), keyframe: true, timestampMilliseconds: FRAME_DURATION_MILLISECONDS },
    { data: createVC1AdvancedPicture({ kind: 'P', mode: 'progressive' }, false, null), keyframe: false, timestampMilliseconds: 3 * FRAME_DURATION_MILLISECONDS },
    { data: createVC1AdvancedPicture({ kind: 'B', mode: 'progressive' }, false, null), keyframe: false, timestampMilliseconds: 2 * FRAME_DURATION_MILLISECONDS }
];
const MILLISECONDS_PER_SECOND = 1_000;

async function withISOBaseMediaTrack<Result>(file: Uint8Array, read: (track: InputVideoTrack) => Promise<Result>): Promise<Result> {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(file) });
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) {
            throw new Error('The synthetic file has no video track');
        }
        return await read(track);
    } finally {
        input.dispose();
    }
}

describe('readISOBaseMediaVC1DecoderDescription', () => {
    it('reads the sequence header and entry point after the dvc1 box\'s VC1DecSpecStruc, which the fork hands on as a vc1 track\'s description', async () => {
        const extradata = createVC1AdvancedExtradata(CODED_WIDTH, CODED_HEIGHT, false);
        const file = createVC1ISOBaseMedia(CODED_WIDTH, CODED_HEIGHT, createDVC1Payload(extradata), SAMPLES);

        await withISOBaseMediaTrack(file, async (track: InputVideoTrack): Promise<void> => {
            expect(await track.getCodec()).toBe('vc1');
            expect(await track.getInternalCodecId()).toBe(ISO_BASE_MEDIA_VC1_SAMPLE_ENTRY);
            expect(await readISOBaseMediaVC1DecoderDescription(track)).toEqual({ description: extradata, status: 'read' });
        });
    });

    it('leaves the samples Mediabunny reads, in decode order with their presentation times', async () => {
        const file = createVC1ISOBaseMedia(CODED_WIDTH, CODED_HEIGHT, createDVC1Payload(createVC1AdvancedExtradata(CODED_WIDTH, CODED_HEIGHT, false)), SAMPLES);

        await withISOBaseMediaTrack(file, async (track: InputVideoTrack): Promise<void> => {
            await readISOBaseMediaVC1DecoderDescription(track);
            const samples: Array<{ data: Uint8Array, timestampMilliseconds: number }> = [];
            for await (const packet of new PacketCursor(track)) {
                samples.push({ data: packet.data, timestampMilliseconds: Math.round(packet.timestamp * MILLISECONDS_PER_SECOND) });
            }

            expect(samples).toEqual(SAMPLES.map(sample => ({ data: sample.data, timestampMilliseconds: sample.timestampMilliseconds })));
        });
    });

    it.each([
        [ 'a dvc1 box of another profile, as FFmpeg reads none', createDVC1Payload(createVC1AdvancedExtradata(CODED_WIDTH, CODED_HEIGHT, false), MAIN_PROFILE), 'dvc1-missing' ],
        [ 'a vc-1 sample entry without a dvc1 box', null, 'dvc1-missing' ],
        [ 'a dvc1 box with no extradata after its VC1DecSpecStruc', createDVC1Payload(new Uint8Array()), 'dvc1-size: 0' ]
    ])('refuses %s', async (_label: string, dvc1Payload: Uint8Array | null, failure: string) => {
        const file = createVC1ISOBaseMedia(CODED_WIDTH, CODED_HEIGHT, dvc1Payload, SAMPLES);

        await withISOBaseMediaTrack(file, async (track: InputVideoTrack): Promise<void> => {
            expect(await readISOBaseMediaVC1DecoderDescription(track)).toEqual({ failure, status: 'failed' });
        });
    });
});
