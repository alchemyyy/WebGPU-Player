// @vitest-environment node

import { ALL_FORMATS, BufferSource, Input, PacketCursor, type InputVideoTrack } from 'mediabunny';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => {
    // Mediabunny warns that it maps no codec to a vc-1 sample entry, which only a decoder package decodes
    vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
});

describe('readISOBaseMediaVC1DecoderDescription', () => {
    it('reads the sequence header and entry point after the dvc1 box\'s VC1DecSpecStruc from a vc-1 track Mediabunny 1.52.2 demuxes', async () => {
        const extradata = createVC1AdvancedExtradata(CODED_WIDTH, CODED_HEIGHT, false);
        const file = createVC1ISOBaseMedia(CODED_WIDTH, CODED_HEIGHT, createDVC1Payload(extradata), SAMPLES);

        await withISOBaseMediaTrack(file, async (track: InputVideoTrack): Promise<void> => {
            expect(await track.getCodec()).toBeNull();
            expect(await track.getInternalCodecId()).toBe(ISO_BASE_MEDIA_VC1_SAMPLE_ENTRY);
            expect(readISOBaseMediaVC1DecoderDescription(track)).toEqual({ description: extradata, status: 'read' });
        });
    });

    it('leaves the samples Mediabunny reads, in decode order with their presentation times', async () => {
        const file = createVC1ISOBaseMedia(CODED_WIDTH, CODED_HEIGHT, createDVC1Payload(createVC1AdvancedExtradata(CODED_WIDTH, CODED_HEIGHT, false)), SAMPLES);

        await withISOBaseMediaTrack(file, async (track: InputVideoTrack): Promise<void> => {
            readISOBaseMediaVC1DecoderDescription(track);
            const samples: Array<{ data: Uint8Array, timestampMilliseconds: number }> = [];
            for await (const packet of new PacketCursor(track)) {
                samples.push({ data: packet.data, timestampMilliseconds: Math.round(packet.timestamp * MILLISECONDS_PER_SECOND) });
            }

            expect(samples).toEqual(SAMPLES.map(sample => ({ data: sample.data, timestampMilliseconds: sample.timestampMilliseconds })));
        });
    });

    it('refuses a dvc1 box of another profile, as FFmpeg reads none', async () => {
        const file = createVC1ISOBaseMedia(CODED_WIDTH, CODED_HEIGHT, createDVC1Payload(createVC1AdvancedExtradata(CODED_WIDTH, CODED_HEIGHT, false), MAIN_PROFILE), SAMPLES);

        await withISOBaseMediaTrack(file, (track: InputVideoTrack): Promise<void> => {
            expect(readISOBaseMediaVC1DecoderDescription(track)).toEqual({ failure: `dvc1-profile: ${MAIN_PROFILE}`, status: 'failed' });
            return Promise.resolve();
        });
    });

    it('refuses a vc-1 sample entry without a dvc1 box', async () => {
        const file = createVC1ISOBaseMedia(CODED_WIDTH, CODED_HEIGHT, null, SAMPLES);

        await withISOBaseMediaTrack(file, (track: InputVideoTrack): Promise<void> => {
            expect(readISOBaseMediaVC1DecoderDescription(track)).toEqual({ failure: 'dvc1-missing', status: 'failed' });
            return Promise.resolve();
        });
    });

    it('refuses a dvc1 box with no extradata after its VC1DecSpecStruc', async () => {
        const file = createVC1ISOBaseMedia(CODED_WIDTH, CODED_HEIGHT, createDVC1Payload(new Uint8Array()), SAMPLES);

        await withISOBaseMediaTrack(file, (track: InputVideoTrack): Promise<void> => {
            expect(readISOBaseMediaVC1DecoderDescription(track)).toEqual({ failure: 'dvc1-size: 7', status: 'failed' });
            return Promise.resolve();
        });
    });

    it('refuses a track of another container, whose demuxer retains no moov', () => {
        const track = { _backing: { internalTrack: { codecPrivate: new Uint8Array() } } } as unknown as InputVideoTrack;

        expect(readISOBaseMediaVC1DecoderDescription(track)).toEqual({ failure: 'sample-table-unavailable: no ISO base media track', status: 'failed' });
    });
});
