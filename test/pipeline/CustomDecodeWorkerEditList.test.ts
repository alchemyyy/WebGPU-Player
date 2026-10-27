// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    ALL_FORMATS,
    BufferSource,
    BufferTarget,
    EncodedPacket,
    EncodedVideoPacketSource,
    Input,
    Mp4OutputFormat,
    Output,
    PacketReader
} from 'mediabunny';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { findUnsupportedTrackFeature } from 'webgpu-player/demux/UnsupportedTrackFeatures';

import { CODEC_VECTOR_ASSETS_DIRECTORY } from '../helpers/enginePaths';
import { createWorkerStartRequest, getFrameResponses, startDecodeWorker } from '../helpers/decodeWorkerHarness';

const SOURCE_VECTOR_PATH = join(CODEC_VECTOR_ASSETS_DIRECTORY, 'hdr10plus-vp9', 'hdr10plus.mkv');
const MULTIPLE_EDITS_FILE_NAME = 'multiple-edits.mp4';
const HALF_RATE_FILE_NAME = 'half-rate.mp4';
const EMPTY_THEN_MEDIA_FILE_NAME = 'empty-then-media.mp4';
const BOX_HEADER_BYTE_LENGTH = 8;
const EDIT_LIST_HEADER_BYTE_LENGTH = 8;
const EDIT_ENTRY_BYTE_LENGTH = 12;
const EDIT_SEGMENT_DURATION = 1_000;
const FIXED_POINT_ONE = 0x1_0000;
const EMPTY_EDIT_MEDIA_TIME = -1;
const FULL_RATE = 1;
const HALF_RATE = 0.5;
const PACKET_DURATION_SECONDS = 1;
const MULTIPLE_EDITS_FEATURE = 'multiple_edits';
const NON_UNIT_RATE_FEATURE = 'non_unit_playback_rate';

type Edit = Readonly<{ mediaTime: number, rate: number }>;

function createBox(name: string, contents: Uint8Array): Uint8Array {
    const box = new Uint8Array(BOX_HEADER_BYTE_LENGTH + contents.byteLength);
    new DataView(box.buffer).setUint32(0, box.byteLength);
    box.set(new TextEncoder().encode(name), 4);
    box.set(contents, BOX_HEADER_BYTE_LENGTH);
    return box;
}

/** A version 0 edit list box in its edts box. */
function createEditBox(edits: readonly Edit[]): Uint8Array {
    const contents = new Uint8Array(EDIT_LIST_HEADER_BYTE_LENGTH + edits.length * EDIT_ENTRY_BYTE_LENGTH);
    const view = new DataView(contents.buffer);
    view.setUint32(4, edits.length);
    edits.forEach((edit: Edit, editIndex: number): void => {
        const entryOffset = EDIT_LIST_HEADER_BYTE_LENGTH + editIndex * EDIT_ENTRY_BYTE_LENGTH;
        view.setUint32(entryOffset, EDIT_SEGMENT_DURATION);
        view.setInt32(entryOffset + 4, edit.mediaTime);
        view.setInt32(entryOffset + 8, edit.rate * FIXED_POINT_ONE);
    });
    return createBox('edts', createBox('elst', contents));
}

/** Appends the edit list to every trak box; the moov box follows mdat, so no sample offset moves. */
function insertEditList(bytes: Uint8Array, edits: readonly Edit[]): Uint8Array {
    const boxes: Uint8Array[] = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let position = 0; position < bytes.byteLength;) {
        const size = view.getUint32(position);
        const name = Buffer.from(bytes.subarray(position + 4, position + BOX_HEADER_BYTE_LENGTH)).toString('latin1');
        const contents = bytes.subarray(position + BOX_HEADER_BYTE_LENGTH, position + size);
        if (name === 'moov') {
            boxes.push(createBox(name, insertEditList(contents, edits)));
        } else if (name === 'trak') {
            boxes.push(createBox(name, Uint8Array.from([ ...contents, ...createEditBox(edits) ])));
        } else {
            boxes.push(bytes.subarray(position, position + size));
        }
        position += size;
    }
    return Uint8Array.from(boxes.flatMap(box => [ ...box ]));
}

/** One VP9 key frame from the HDR10+ vector, in an MP4 with the given edit list. */
async function createEditedMP4(edits: readonly Edit[]): Promise<Uint8Array> {
    const sourceInput = new Input({ formats: ALL_FORMATS, source: new BufferSource(readFileSync(SOURCE_VECTOR_PATH)) });
    try {
        const [ sourceTrack ] = await sourceInput.getVideoTracks();
        const firstPacket = await new PacketReader(sourceTrack).getFirst();
        const decoderConfig = await sourceTrack.getDecoderConfig();
        if (!firstPacket || !decoderConfig) {
            throw new Error('The HDR10+ VP9 vector has no first packet');
        }
        const target = new BufferTarget();
        const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
        const videoSource = new EncodedVideoPacketSource('vp9');
        output.addVideoTrack(videoSource);
        await output.start();
        await videoSource.add(new EncodedPacket(firstPacket.data, 'key', 0, PACKET_DURATION_SECONDS), { decoderConfig });
        await output.finalize();
        if (!target.buffer) {
            throw new Error('Mediabunny wrote no MP4');
        }
        return insertEditList(new Uint8Array(target.buffer), edits);
    } finally {
        sourceInput.dispose();
    }
}

let mediaFiles: Map<string, Uint8Array>;

beforeAll(async () => {
    mediaFiles = new Map<string, Uint8Array>([
        [ MULTIPLE_EDITS_FILE_NAME, await createEditedMP4([ { mediaTime: 0, rate: FULL_RATE }, { mediaTime: 0, rate: FULL_RATE } ]) ],
        [ HALF_RATE_FILE_NAME, await createEditedMP4([ { mediaTime: 0, rate: HALF_RATE } ]) ],
        [ EMPTY_THEN_MEDIA_FILE_NAME, await createEditedMP4([ { mediaTime: EMPTY_EDIT_MEDIA_TIME, rate: FULL_RATE }, { mediaTime: 0, rate: FULL_RATE } ]) ]
    ]);
});

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('edit lists Mediabunny cannot honor', () => {
    it.each([
        [ MULTIPLE_EDITS_FILE_NAME, MULTIPLE_EDITS_FEATURE ],
        [ HALF_RATE_FILE_NAME, NON_UNIT_RATE_FEATURE ],
        [ EMPTY_THEN_MEDIA_FILE_NAME, null ]
    ])('reports %s as %s', async (fileName: string, feature: string | null) => {
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(mediaFiles.get(fileName) as Uint8Array) });
        try {
            const [ videoTrack ] = await input.getVideoTracks();
            expect(await findUnsupportedTrackFeature(videoTrack)).toBe(feature);
        } finally {
            input.dispose();
        }
    });

    it.each([
        [ MULTIPLE_EDITS_FILE_NAME, MULTIPLE_EDITS_FEATURE ],
        [ HALF_RATE_FILE_NAME, NON_UNIT_RATE_FEATURE ]
    ])('refuses %s in the playback worker instead of playing it at the wrong times', async (fileName: string, feature: string) => {
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const workerScope = await startDecodeWorker(mediaFiles);
        const request = createWorkerStartRequest(fileName);

        workerScope.dispatchRequest(request);
        await workerScope.waitForStopped(request.generation);

        expect(workerScope.responses).toContainEqual({
            failureKind: 'source-unsupported',
            generation: request.generation,
            message: `The selected video track has an edit list Mediabunny cannot honor: ${feature}`,
            type: 'error'
        });
        expect(getFrameResponses(workerScope.responses)).toEqual([]);
    });
});
