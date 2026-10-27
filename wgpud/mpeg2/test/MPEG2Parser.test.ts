// @vitest-environment node

import { beforeAll, describe, expect, it } from 'vitest';

import type { VideoDecoderPackage } from 'webgpu-player/decode/packages/DecoderPackage';
import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import GPUDecoderParserInstance, {
    getGPUDecoderParserModule,
    type GPUDecoderParserModule,
    type GPUDecoderParserPicture
} from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import type { GPUDecoderPictureSize } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import { parseGPUDecoderVectorSet, type GPUDecoderVector } from 'webgpu-player/decode/video/gpu/GPUDecoderVectorSet';
import { createGPUDecodeStreamFacts } from 'webgpu-player/decode/video/gpu/GPUFramePool';
import { getGPUVideoDecodeStreamChange, type GPUVideoDecodeSessionRequest } from 'webgpu-player/decode/video/gpu/GPUVideoDecodeFeed';

import { loadDecoderProjectVideoPackage, readDecoderProjectVectors } from '../../../test/helpers/decoderPackages';
import { createMPEGIntraPacket, createMPEGPictureHeader, createMPEGSequenceHeaders, type MPEGSequence } from '../../../test/helpers/mpegVideoHeaders';

const PROJECT = 'mpeg2';
const OUTPUT_FORMATS: readonly GPUDecoderOutputFormat[] = [ 'I420', 'I422', 'I444' ];
// A broadcast stream that switches from standard to high definition: 576 lines at 4:2:0, then 1080 at 4:2:2
const STANDARD_SEQUENCE: MPEGSequence = { chromaFormat: 1, height: 576, width: 720 };
const HIGH_SEQUENCE: MPEGSequence = { chromaFormat: 2, height: 1080, width: 1920 };
// The same high definition at 4:2:0
const HIGH_420_SEQUENCE: MPEGSequence = { chromaFormat: 1, height: 1080, width: 1920 };
// A sequence whose sides carry the sequence extension's size bits above horizontal_size and vertical_size
const EXTENDED_SEQUENCE: MPEGSequence = { chromaFormat: 1, height: 4320, width: 7680 };
// Sequences of MPEG-1, which has no sequence extension and is always 4:2:0
const CIF_SEQUENCE: MPEGSequence = { chromaFormat: null, height: 288, width: 352 };
const VGA_SEQUENCE: MPEGSequence = { chromaFormat: null, height: 480, width: 640 };
// A sequence of 736 columns, whose pool a 720-column one shares: both round up to 768
const WIDER_STANDARD_SEQUENCE: MPEGSequence = { chromaFormat: 1, height: 576, width: 736 };
const CODEC = 'mpeg2video';

let decoderPackage: VideoDecoderPackage;
let parser: GPUDecoderParserModule;
let vectors: ReadonlyMap<GPUDecoderOutputFormat, GPUDecoderVector>;

beforeAll(async () => {
    decoderPackage = await loadDecoderProjectVideoPackage(PROJECT);
    parser = getGPUDecoderParserModule(decoderPackage);
    vectors = parseGPUDecoderVectorSet(readDecoderProjectVectors(PROJECT));
});

function requireVector(format: GPUDecoderOutputFormat): GPUDecoderVector {
    const vector = vectors.get(format);
    if (!vector) {
        throw new Error(`The ${PROJECT} package carries no ${format} vector`);
    }
    return vector;
}

/** Returns the one picture a packet decodes to, which every packet is. */
function decodeOnlyPicture(instance: GPUDecoderParserInstance, packet: Uint8Array): GPUDecoderParserPicture {
    const output = instance.decode(packet);
    if (output.pictures.length !== 1) {
        throw new Error(`A packet decoded to ${output.pictures.length} pictures`);
    }
    expect(output.trailingEvents).toEqual(new Uint32Array(0));
    return output.pictures[0];
}

function getSize(sequence: MPEGSequence): GPUDecoderPictureSize {
    return { height: sequence.height, width: sequence.width };
}

function getFormat(sequence: MPEGSequence): GPUDecoderOutputFormat {
    return OUTPUT_FORMATS[(sequence.chromaFormat ?? 1) - 1];
}

/** The facts a picture of a sequence reports. */
function getSequencePicture(sequence: MPEGSequence): Pick<GPUDecoderParserPicture, 'format' | 'maximumPictureSize' | 'visibleSize'> {
    return { format: getFormat(sequence), maximumPictureSize: getSize(sequence), visibleSize: getSize(sequence) };
}

/** A first session's request for a stream that starts with a sequence, its pool sized by that sequence as the container's and the codec private data's size. */
function createFirstRequest(sequence: MPEGSequence): GPUVideoDecodeSessionRequest {
    const format = getFormat(sequence);
    return {
        codecPrivate: createMPEGSequenceHeaders(sequence),
        decoder: { codec: CODEC, decoderId: decoderPackage.id, package: decoderPackage },
        format,
        maximumPictureSize: getSize(sequence),
        stream: createGPUDecodeStreamFacts(sequence.width, sequence.height, format)
    };
}

/** The pool a request's session takes: its stream's coded size, the requested picture rounded up to 64. */
function getRequestPool(request: GPUVideoDecodeSessionRequest): GPUDecoderPictureSize {
    const size = request.maximumPictureSize ?? { height: request.stream.visibleRectangle.height, width: request.stream.visibleRectangle.width };
    const stream = createGPUDecodeStreamFacts(size.width, size.height, request.format);
    return { height: stream.codedHeight, width: stream.codedWidth };
}

describe('GPUDecoderParserInstance on the MPEG-2 package\'s parser', () => {
    it.each(OUTPUT_FORMATS)('hands every packet of the %s vector on unchanged as its picture\'s record, at the vector\'s size and format', async (format: GPUDecoderOutputFormat) => {
        const vector = requireVector(format);
        const visible = vector.stream.visibleRectangle;
        const size = { height: visible.height, width: visible.width };
        const instance = await GPUDecoderParserInstance.create(parser);

        expect(instance.configure(vector.codecPrivate)).toEqual(size);
        for (const packet of vector.packets) {
            const picture = decodeOnlyPicture(instance, new Uint8Array(packet.data));

            expect(new Uint8Array(picture.record)).toEqual(new Uint8Array(packet.data));
            // Frames present in timestamp order, as without a parser, and the WGSL reports their fields
            expect(picture.events).toEqual(new Uint32Array(0));
            expect(picture.fields).toBeNull();
            expect(picture.repeatCounts).toEqual([]);
            expect(picture).toMatchObject({ format, maximumPictureSize: size, visibleSize: size });
        }
        instance.destroy();
    });

    it('plans each packet as one picture without parse units, which finishes into the record decode makes', async () => {
        const vector = requireVector('I420');
        const decoder = await GPUDecoderParserInstance.create(parser);
        const coordinator = await GPUDecoderParserInstance.create(parser);
        decoder.configure(vector.codecPrivate);
        coordinator.configure(vector.codecPrivate);
        // The coordinator plans ahead of its finishes, as the decode worker does
        const planned = vector.packets.map(packet => coordinator.plan(new Uint8Array(packet.data)));
        for (const [ packetIndex, packet ] of vector.packets.entries()) {
            const decoded = decodeOnlyPicture(decoder, new Uint8Array(packet.data));

            expect(planned[packetIndex]).toMatchObject({ events: new Uint32Array(0), kind: 'picture', morePictures: false, unitCount: 0 });
            const finished = coordinator.finish(new Uint8Array(0));
            expect(finished).toEqual(decoded);
        }
        expect(coordinator.planNext()).toEqual({ events: new Uint32Array(0), kind: 'no-picture' });
        decoder.destroy();
        coordinator.destroy();
    });

    it('declares each sequence\'s size and chroma format from its picture on, up and down, the size extensions included', async () => {
        const instance = await GPUDecoderParserInstance.create(parser);
        instance.configure(createMPEGSequenceHeaders(STANDARD_SEQUENCE));
        const sequences = [ STANDARD_SEQUENCE, HIGH_SEQUENCE, STANDARD_SEQUENCE, EXTENDED_SEQUENCE ];

        for (const sequence of sequences) {
            expect(decodeOnlyPicture(instance, createMPEGIntraPacket(sequence))).toMatchObject(getSequencePicture(sequence));
            // A packet without a sequence header keeps its sequence's facts
            expect(decodeOnlyPicture(instance, createMPEGIntraPacket(null))).toMatchObject(getSequencePicture(sequence));
        }
        instance.destroy();
    });

    it('declares MPEG-1 sequences at 4:2:0, which code no sequence extension', async () => {
        const instance = await GPUDecoderParserInstance.create(parser);

        expect(instance.configure(createMPEGSequenceHeaders(CIF_SEQUENCE))).toEqual(getSize(CIF_SEQUENCE));
        for (const sequence of [ CIF_SEQUENCE, VGA_SEQUENCE, CIF_SEQUENCE ]) {
            expect(decodeOnlyPicture(instance, createMPEGIntraPacket(sequence))).toMatchObject({ ...getSequencePicture(sequence), format: 'I420' });
        }
        instance.destroy();
    });

    it('reports no size before a sequence header, and none after a reset until one comes again', async () => {
        const instance = await GPUDecoderParserInstance.create(parser);
        const none = { format: null, maximumPictureSize: null, visibleSize: null };

        expect(instance.configure(null)).toBeNull();
        expect(decodeOnlyPicture(instance, createMPEGPictureHeader())).toMatchObject(none);
        expect(decodeOnlyPicture(instance, createMPEGIntraPacket(HIGH_SEQUENCE))).toMatchObject(getSequencePicture(HIGH_SEQUENCE));
        instance.reset();
        expect(decodeOnlyPicture(instance, createMPEGIntraPacket(null))).toMatchObject(none);
        instance.destroy();
    });

    it('takes no sequence header that follows a picture start code in its packet, as the WGSL decodes the picture at the size before it', async () => {
        const instance = await GPUDecoderParserInstance.create(parser);
        instance.configure(createMPEGSequenceHeaders(STANDARD_SEQUENCE));
        const packet = new Uint8Array([ ...createMPEGPictureHeader(), ...createMPEGSequenceHeaders(HIGH_SEQUENCE) ]);

        expect(decodeOnlyPicture(instance, packet)).toMatchObject(getSequencePicture(STANDARD_SEQUENCE));
        instance.destroy();
    });

    it('moves a larger sequence and one of another chroma format to a session of its own, and keeps a smaller one in the session whose pool holds it', async () => {
        const instance = await GPUDecoderParserInstance.create(parser);
        instance.configure(createMPEGSequenceHeaders(STANDARD_SEQUENCE));
        let request = createFirstRequest(STANDARD_SEQUENCE);
        const changes: Array<GPUVideoDecodeSessionRequest | null> = [];
        for (const sequence of [ STANDARD_SEQUENCE, WIDER_STANDARD_SEQUENCE, HIGH_420_SEQUENCE, STANDARD_SEQUENCE, HIGH_SEQUENCE ]) {
            const picture = decodeOnlyPicture(instance, createMPEGIntraPacket(sequence));
            const change = getGPUVideoDecodeStreamChange(request, getRequestPool(request), picture);
            changes.push(change);
            request = change ?? request;
        }
        instance.destroy();

        expect(changes.map(change => change && { format: change.format, maximumPictureSize: change.maximumPictureSize })).toEqual([
            null,
            // 736 and 720 columns both take a pool of 768, so the WGSL follows the change within its session
            null,
            { format: 'I420', maximumPictureSize: getSize(HIGH_420_SEQUENCE) },
            // The 1080 pool holds 576 lines, so the WGSL follows the change within its session too
            null,
            { format: 'I422', maximumPictureSize: getSize(HIGH_SEQUENCE) }
        ]);
    });
});
