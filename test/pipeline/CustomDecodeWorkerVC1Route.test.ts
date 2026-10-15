// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    MAX_GPU_DECODE_PACKET_CREDITS,
    type DecodeWorkerResponse,
    type DecodeWorkerStartRequest
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';

import {
    createWorkerStartRequest,
    decodeToEnd,
    FakeVideoDecoder,
    getReadyResponse,
    startDecodeWorker
} from '../helpers/decodeWorkerHarness';
import {
    BITMAP_INFO_HEADER_BYTE_LENGTH,
    createDVC1Payload,
    createVC1AdvancedExtradata,
    createVC1AdvancedPicture,
    createVC1ISOBaseMedia,
    createVFWCodecPrivate,
    createVFWMatroska,
    createWMV3Picture,
    createWMV3SequenceHeader,
    type SyntheticVC1Packet,
    type WMV3SequenceFields
} from '../helpers/vc1Media';

const MATROSKA_FILE_NAME = 'vc1.mkv';
const ISO_BASE_MEDIA_FILE_NAME = 'vc1.mp4';
const CODED_WIDTH = 320;
const CODED_HEIGHT = 240;
// The WMV3 file's BITMAPINFOHEADER disagrees with its pixel size; the decoder must get the container's, as FFmpeg's does
const HEADER_WIDTH = 352;
const HEADER_HEIGHT = 288;
const MAIN_PROFILE = 1;
const WMV3_FIELDS: WMV3SequenceFields = { frameInterpolation: false, maximumBFrames: 1, profile: MAIN_PROFILE, rangeReduction: false };
const WVC1_SIZE_BYTE = 0x27;
const FRAME_MICROSECONDS = 40_000;
const MILLISECONDS_PER_FRAME = 40;
const WIDTH_OFFSET = 4;
const HEIGHT_OFFSET = 8;
const FOURCC_OFFSET = 16;
const FOURCC_BYTE_LENGTH = 4;
// The GPU decoder's frame-pool route, whose decoder package takes the codec
const FRAME_POOL_ROUTE: Partial<DecodeWorkerStartRequest> = {
    frameCredits: MAX_GPU_DECODE_PACKET_CREDITS,
    rawVideoFrameFormat: 'I420',
    videoDecoderBackend: 'gpu',
    videoOutputMode: 'frame-pool'
};

type PacketResponse = Extract<DecodeWorkerResponse, { type: 'packet' }>;

function getPacketResponses(responses: readonly DecodeWorkerResponse[]): PacketResponse[] {
    return responses.filter((response: DecodeWorkerResponse): response is PacketResponse => response.type === 'packet');
}

function getCodecPrivate(responses: readonly DecodeWorkerResponse[]): Uint8Array {
    return new Uint8Array(getReadyResponse(responses).codecPrivate ?? new ArrayBuffer(0));
}

/** A WMV3 Main profile track in decode order I0 P2 B1, each packet stamped with its decode time as FFmpeg's Matroska muxer stamps VfW tracks. */
function createWMV3Packets(): SyntheticVC1Packet[] {
    return [
        { data: createWMV3Picture('I', WMV3_FIELDS), keyframe: true, timestampMilliseconds: 0 },
        { data: createWMV3Picture('P', WMV3_FIELDS), keyframe: false, timestampMilliseconds: MILLISECONDS_PER_FRAME },
        { data: createWMV3Picture('B', WMV3_FIELDS), keyframe: false, timestampMilliseconds: 2 * MILLISECONDS_PER_FRAME }
    ];
}

/** An Advanced profile track in decode order I0 P2 B1 without start codes, as VfW tracks and ISO base media samples carry them. */
function createAdvancedPackets(timestampsMilliseconds: readonly number[]): SyntheticVC1Packet[] {
    const kinds = [ 'I', 'P', 'B' ] as const;
    return kinds.map((kind, packetIndex: number): SyntheticVC1Packet => ({
        data: createVC1AdvancedPicture({ kind, mode: 'progressive' }, false, null),
        keyframe: kind === 'I',
        timestampMilliseconds: timestampsMilliseconds[packetIndex]
    }));
}

async function startWorker(fileName: string, media: Uint8Array): Promise<Awaited<ReturnType<typeof startDecodeWorker>>> {
    return startDecodeWorker(new Map([ [ fileName, media ] ]));
}

beforeEach(() => {
    vi.resetModules();
    // Mediabunny warns that it maps no codec to a vc-1 sample entry, which only a decoder package decodes
    vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('CustomDecode.worker VC-1 and WMV3 frame-pool routes', () => {
    it('posts a Matroska WMV3 track\'s packets in presentation time with its STRUCT_C behind a header of the track\'s coded size', async () => {
        const structC = createWMV3SequenceHeader(WMV3_FIELDS);
        const codecPrivate = createVFWCodecPrivate('WMV3', HEADER_WIDTH, HEADER_HEIGHT, structC);
        const workerScope = await startWorker(MATROSKA_FILE_NAME, createVFWMatroska(codecPrivate, CODED_WIDTH, CODED_HEIGHT, createWMV3Packets()));

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, { ...FRAME_POOL_ROUTE, gpuVideoCodec: 'wmv3' }));

        const description = getCodecPrivate(responses);
        const header = new DataView(description.buffer, 0, BITMAP_INFO_HEADER_BYTE_LENGTH);
        expect(getReadyResponse(responses)).toMatchObject({ codec: 'wmv3', codedHeight: CODED_HEIGHT, codedWidth: CODED_WIDTH });
        expect(header.getInt32(WIDTH_OFFSET, true)).toBe(CODED_WIDTH);
        expect(header.getInt32(HEIGHT_OFFSET, true)).toBe(CODED_HEIGHT);
        expect(String.fromCharCode(...description.subarray(FOURCC_OFFSET, FOURCC_OFFSET + FOURCC_BYTE_LENGTH))).toBe('WMV3');
        expect(description.subarray(BITMAP_INFO_HEADER_BYTE_LENGTH)).toEqual(structC);
        // The anchors present when the next anchor or the end outputs them, the B picture at its own time
        expect(getPacketResponses(responses).map(packet => packet.timestampMicroseconds)).toEqual([ FRAME_MICROSECONDS, 3 * FRAME_MICROSECONDS, 2 * FRAME_MICROSECONDS ]);
        expect(FakeVideoDecoder.instances).toEqual([]);
    });

    it('posts a Matroska WVC1 track\'s packets in presentation time with the extradata after its header', async () => {
        const extradata = createVC1AdvancedExtradata(CODED_WIDTH, CODED_HEIGHT, false, WVC1_SIZE_BYTE);
        const codecPrivate = createVFWCodecPrivate('WVC1', CODED_WIDTH, CODED_HEIGHT, extradata);
        const packets = createAdvancedPackets([ 0, MILLISECONDS_PER_FRAME, 2 * MILLISECONDS_PER_FRAME ]);
        const workerScope = await startWorker(MATROSKA_FILE_NAME, createVFWMatroska(codecPrivate, CODED_WIDTH, CODED_HEIGHT, packets));

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, { ...FRAME_POOL_ROUTE, gpuVideoCodec: 'vc1' }));

        expect(getReadyResponse(responses)).toMatchObject({ codec: 'vc1' });
        expect(getCodecPrivate(responses)).toEqual(extradata);
        expect(getPacketResponses(responses).map(packet => packet.timestampMicroseconds)).toEqual([ FRAME_MICROSECONDS, 3 * FRAME_MICROSECONDS, 2 * FRAME_MICROSECONDS ]);
    });

    it('posts an ISO base media vc-1 track\'s samples at their presentation times with its dvc1 sequence header and entry point', async () => {
        const extradata = createVC1AdvancedExtradata(CODED_WIDTH, CODED_HEIGHT, false);
        // Presentation times I0 at 40 ms, P2 at 120 ms, B1 at 80 ms, each at or after its decode time
        const packets = createAdvancedPackets([ MILLISECONDS_PER_FRAME, 3 * MILLISECONDS_PER_FRAME, 2 * MILLISECONDS_PER_FRAME ]);
        const file = createVC1ISOBaseMedia(CODED_WIDTH, CODED_HEIGHT, createDVC1Payload(extradata), packets);
        const workerScope = await startWorker(ISO_BASE_MEDIA_FILE_NAME, file);

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(ISO_BASE_MEDIA_FILE_NAME, { ...FRAME_POOL_ROUTE, gpuVideoCodec: 'vc1' }));

        expect(getCodecPrivate(responses)).toEqual(extradata);
        expect(getPacketResponses(responses).map(packet => packet.timestampMicroseconds)).toEqual([ FRAME_MICROSECONDS, 3 * FRAME_MICROSECONDS, 2 * FRAME_MICROSECONDS ]);
        expect(getPacketResponses(responses).map(packet => new Uint8Array(packet.data))).toEqual(packets.map(packet => packet.data));
    });

    it.each([
        [
            'a WMV3 track on the VC-1 route',
            MATROSKA_FILE_NAME,
            createVFWMatroska(createVFWCodecPrivate('WMV3', CODED_WIDTH, CODED_HEIGHT, createWMV3SequenceHeader(WMV3_FIELDS)), CODED_WIDTH, CODED_HEIGHT, createWMV3Packets()),
            'vc1',
            'The selected VC-1 track has no decoder configuration: fourcc: WMV3'
        ],
        [
            'a vc-1 sample entry on the WMV3 route',
            ISO_BASE_MEDIA_FILE_NAME,
            createVC1ISOBaseMedia(CODED_WIDTH, CODED_HEIGHT, createDVC1Payload(createVC1AdvancedExtradata(CODED_WIDTH, CODED_HEIGHT, false)), createAdvancedPackets([ 0, 2 * MILLISECONDS_PER_FRAME, MILLISECONDS_PER_FRAME ])),
            'wmv3',
            'The selected video track does not match the negotiated WMV3 route: codec-id: vc-1'
        ],
        [
            'a vc-1 sample entry without a dvc1 box',
            ISO_BASE_MEDIA_FILE_NAME,
            createVC1ISOBaseMedia(CODED_WIDTH, CODED_HEIGHT, null, createAdvancedPackets([ 0, 2 * MILLISECONDS_PER_FRAME, MILLISECONDS_PER_FRAME ])),
            'vc1',
            'The selected VC-1 track has no decoder configuration: dvc1-missing'
        ]
    ])('refuses %s with the check that failed', async (_label: string, fileName: string, media: Uint8Array, gpuVideoCodec: string, message: string) => {
        const workerScope = await startWorker(fileName, media);
        const request = createWorkerStartRequest(fileName, { ...FRAME_POOL_ROUTE, gpuVideoCodec });

        workerScope.dispatchRequest(request);
        await workerScope.waitForStopped(request.generation);

        expect(workerScope.responses).toContainEqual({ failureKind: 'source-unsupported', generation: request.generation, message, type: 'error' });
        expect(getPacketResponses(workerScope.responses)).toEqual([]);
    });
});
