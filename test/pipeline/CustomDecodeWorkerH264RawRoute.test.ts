// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    BufferTarget,
    EncodedPacket,
    EncodedVideoPacketSource,
    MkvOutputFormat,
    Mp4OutputFormat,
    Output,
    type OutputFormat
} from 'mediabunny';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { H264_RAW_FORMAT_PROBE_DEFINITIONS } from 'webgpu-player/capability/H264RawFormatCapabilities';

import {
    FakeVideoDecoder,
    FakeVideoFrame,
    RAW_I420P10_ROUTE,
    createWorkerStartRequest,
    decodeToEnd,
    getFrameResponses,
    getReadyResponse,
    startDecodeWorker
} from '../helpers/decodeWorkerHarness';
import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';

const MATROSKA_FILE_NAME = 'high10.mkv';
const MP4_FILE_NAME = 'high10.mp4';
const HIGH_10 = H264_RAW_FORMAT_PROBE_DEFINITIONS['high420-10'];
const MICROSECONDS_PER_SECOND = 1_000_000;
// The vector's SPS lets one frame wait for a later one: x264's single B-frame
const REORDER_DEPTH = 1;

/**
 * A decoder that outputs in presentation order, as WebCodecs requires: it holds the stream's reorder depth of decoded frames and outputs the earliest
 * when one more arrives, then the rest on flush. The fake orders by the frames' timestamps, standing in for the order counts a real decoder reads.
 */
class PresentationOrderVideoDecoder extends FakeVideoDecoder {
    private readonly releaseHeldFrames: () => void;

    public constructor(init: VideoDecoderInit) {
        const heldFrames: VideoFrame[] = [];
        const releaseEarliest = (): void => {
            heldFrames.sort((left: VideoFrame, right: VideoFrame): number => left.timestamp - right.timestamp);
            const [ earliest ] = heldFrames.splice(0, 1);
            init.output(earliest);
        };
        super({
            ...init,
            output: (frame: VideoFrame): void => {
                heldFrames.push(frame);
                if (heldFrames.length > REORDER_DEPTH) {
                    releaseEarliest();
                }
            }
        });
        this.releaseHeldFrames = (): void => {
            while (heldFrames.length > 0) {
                releaseEarliest();
            }
        };
    }

    public override async flush(): Promise<void> {
        await super.flush();
        this.releaseHeldFrames();
    }
}

/** Muxes the committed High 10 vector's I, P, and B access units, Annex B with in-band parameter sets, each stamped with its presentation time. */
async function muxHigh10Vector(format: OutputFormat): Promise<Uint8Array> {
    const vectorBytes = new Uint8Array(readFileSync(resolve(CODEC_VECTOR_ASSETS_DIRECTORY, 'h264-raw-format', 'high420-10.h264')));
    const target = new BufferTarget();
    const output = new Output({ format, target });
    const source = new EncodedVideoPacketSource('avc');
    output.addVideoTrack(source);
    await output.start();
    let byteOffset = 0;
    for (const [ accessUnitIndex, accessUnit ] of HIGH_10.accessUnits.entries()) {
        const data = vectorBytes.slice(byteOffset, byteOffset + accessUnit.byteLength);
        byteOffset += accessUnit.byteLength;
        const packet = new EncodedPacket(data, accessUnit.type, accessUnit.timestamp / MICROSECONDS_PER_SECOND, 1);
        await source.add(packet, accessUnitIndex === 0 ?
            { decoderConfig: { codec: HIGH_10.config.codec, codedHeight: 192, codedWidth: 192 } } :
            undefined);
    }
    source.close();
    await output.finalize();
    if (!target.buffer) {
        throw new Error('Mediabunny did not finalize the H.264 vector');
    }
    return new Uint8Array(target.buffer);
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('CustomDecode.worker H.264 raw-format route', () => {
    it.each([
        [ MATROSKA_FILE_NAME, (): OutputFormat => new MkvOutputFormat() ],
        [ MP4_FILE_NAME, (): OutputFormat => new Mp4OutputFormat() ]
    ])('decodes High 10 from %s in software and posts its raw planes in presentation order', async (fileName, createFormat) => {
        const workerScope = await startDecodeWorker(new Map([ [ fileName, await muxHigh10Vector(createFormat()) ] ]));
        vi.stubGlobal('VideoDecoder', PresentationOrderVideoDecoder);
        vi.stubGlobal('VideoFrame', FakeVideoFrame);

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(fileName, RAW_I420P10_ROUTE));

        // Mediabunny writes the codec string's hexadecimal digits in lowercase
        expect(getReadyResponse(responses).codec).toBe(HIGH_10.config.codec.toLowerCase());
        expect(FakeVideoDecoder.instances).toHaveLength(1);
        const [ decoder ] = FakeVideoDecoder.instances;
        // Chromium reports High 10 unsupported with prefer-hardware, while its software decoder outputs copyable I420P10
        expect(decoder.configuration?.hardwareAcceleration).toBe('prefer-software');
        // Decode order: I, P, then the B that presents between them
        expect(decoder.chunks.map(chunk => chunk.timestamp)).toEqual([ 0, 2 * MICROSECONDS_PER_SECOND, MICROSECONDS_PER_SECOND ]);
        const frameResponses = getFrameResponses(responses);
        expect(frameResponses.map(response => response.outputMode)).toEqual([ 'raw-planes', 'raw-planes', 'raw-planes' ]);
        expect(frameResponses.map(response => response.mediaTimeMicroseconds)).toEqual([ 0, MICROSECONDS_PER_SECOND, 2 * MICROSECONDS_PER_SECOND ]);
    });
});
