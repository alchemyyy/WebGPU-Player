// @vitest-environment node

import { createHash } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { GPU_DECODER_OUTPUT_EVENT } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import GPUDecoderParserInstance, {
    getGPUDecoderParserModule,
    GPUDecoderParserError,
    type GPUDecoderParserModule,
    type GPUDecoderParserOutput,
    type GPUDecoderParserPicture
} from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import { splitUnits } from 'webgpu-player/decode/video/gpu/GPUDecoderParserPipeline';
import { parseGPUDecoderVectorSet, type GPUDecoderVector } from 'webgpu-player/decode/video/gpu/GPUDecoderVectorSet';

import { loadDecoderProjectVideoPackage, readDecoderProjectVectors } from '../../../test/helpers/decoderPackages';

const PROJECT = 'vc1';
const OUTPUT_FORMAT: GPUDecoderOutputFormat = 'I420';
// Parse workers the split decode spreads each picture's units over
const PARSE_JOB_COUNT = 2;
// The vector: an Advanced profile progressive 1080p stream of an I picture and P pictures, coded at its visible size
const VECTOR_WIDTH = 1920;
const VECTOR_HEIGHT = 1080;
const PROGRESSIVE_FIELDS = { repeatFirstField: false, scan: 'progressive' };
// Words of the record header the parser and vc1.wgsl share: its magic, 'VC1R' little-endian, and its version
const RECORD_MAGIC = 0x5231_4356;
const RECORD_VERSION = 1;
const RECORD_MAGIC_WORD = 0;
const RECORD_VERSION_WORD = 1;
// A WMV3 STRUCT_C alone, without the Video for Windows header that sizes its frames, which the configuration refuses
const BARE_STRUCT_C = Uint8Array.of(0x4e, 0xd9, 0x1a, 0x01);
const CONFIGURATION_ERROR_NAME = 'configuration';
const FRAME_SIZE_MISSING_VALUE = 0xff_ffff;
// Damage: every packet but the first cut to a fraction of its bytes, and the same packets with bytes flipped from their middle on
const TRUNCATED_FRACTION = 0.3;
const FLIPPED_BYTE_STRIDE = 97;
const FLIP_MASK = 0x5a;
const RESYNC_ERROR_NAMES = new Set([ 'pictureHeader', 'bitplane', 'startCodes', 'macroblockLayer', 'bitsExhausted', 'pictureTooShort' ]);
const RECORD_DIGEST = 'sha256';

let vc1Parser: GPUDecoderParserModule;
let vc1Vector: GPUDecoderVector;

beforeAll(async () => {
    const decoderPackage = await loadDecoderProjectVideoPackage(PROJECT);
    vc1Parser = getGPUDecoderParserModule(decoderPackage);
    const vector = parseGPUDecoderVectorSet(readDecoderProjectVectors(PROJECT)).get(OUTPUT_FORMAT);
    if (!vector) {
        throw new Error(`The ${PROJECT} package carries no ${OUTPUT_FORMAT} vector`);
    }
    vc1Vector = vector;
});

/** Returns the one picture a packet decodes to, which every packet of the vector holds. */
function requireOnlyPicture(output: GPUDecoderParserOutput): GPUDecoderParserPicture {
    if (output.pictures.length !== 1) {
        throw new Error(`A packet decoded to ${output.pictures.length} pictures`);
    }
    return output.pictures[0];
}

/** A record's digest: records run to megabytes, which a deep equality walks byte by byte. */
function digestRecord(record: ArrayBuffer): string {
    return createHash(RECORD_DIGEST).update(new Uint8Array(record)).digest('hex');
}

function concatenate(buffers: readonly ArrayBuffer[]): Uint8Array {
    const bytes = new Uint8Array(buffers.reduce((byteLength: number, buffer: ArrayBuffer): number => byteLength + buffer.byteLength, 0));
    let offset = 0;
    for (const buffer of buffers) {
        bytes.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
    }
    return bytes;
}

async function createConfiguredInstance(): Promise<GPUDecoderParserInstance> {
    const instance = await GPUDecoderParserInstance.create(vc1Parser);
    instance.configure(vc1Vector.codecPrivate);
    return instance;
}

/** Damages a packet: cut short, or bytes flipped from its middle on. */
function damagePacket(data: ArrayBuffer, truncate: boolean): Uint8Array {
    const bytes = new Uint8Array(data).slice();
    if (truncate) {
        return bytes.subarray(0, Math.floor(bytes.byteLength * TRUNCATED_FRACTION));
    }
    for (let byteIndex = bytes.byteLength >> 1; byteIndex < bytes.byteLength; byteIndex += FLIPPED_BYTE_STRIDE) {
        bytes[byteIndex] ^= FLIP_MASK;
    }
    return bytes;
}

describe('GPUDecoderParserInstance on the VC-1 package\'s parser', () => {
    it('decodes every packet into one picture\'s GPU record at the stream\'s size, each anchor presenting the one before it', async () => {
        const instance = await createConfiguredInstance();
        const presentedPictures: number[] = [];
        for (const [ packetIndex, packet ] of vc1Vector.packets.entries()) {
            const picture = requireOnlyPicture(instance.decode(new Uint8Array(packet.data)));
            const header = new Uint32Array(picture.record, 0, RECORD_VERSION_WORD + 1);
            expect(header[RECORD_MAGIC_WORD]).toBe(RECORD_MAGIC);
            expect(header[RECORD_VERSION_WORD]).toBe(RECORD_VERSION);
            expect(picture.visibleSize).toEqual({ height: VECTOR_HEIGHT, width: VECTOR_WIDTH });
            expect(picture.maximumPictureSize).toEqual({ height: VECTOR_HEIGHT, width: VECTOR_WIDTH });
            expect(picture.format).toBe(OUTPUT_FORMAT);
            expect(picture.fields).toEqual(PROGRESSIVE_FIELDS);
            expect(picture.repeatCounts).toEqual([]);
            for (const event of picture.events) {
                expect(event & GPU_DECODER_OUTPUT_EVENT.discardBit).toBe(0);
                expect(event & GPU_DECODER_OUTPUT_EVENT.reservedBit).toBe(0);
                presentedPictures.push(event & GPU_DECODER_OUTPUT_EVENT.pictureIndexMask);
            }
            // FFmpeg's vc1 decoder outputs an anchor once the next anchor decodes
            expect(presentedPictures.at(-1) ?? -1).toBe(packetIndex - 1);
        }
        instance.destroy();

        // The last anchor waits for the end of the track
        expect(presentedPictures).toEqual(Array.from({ length: vc1Vector.packets.length - 1 }, (_value: unknown, pictureIndex: number): number => pictureIndex));
    });

    it('plans, parses on other instances, and finishes each picture into the record and events that decode makes', async () => {
        const decoder = await createConfiguredInstance();
        const coordinator = await createConfiguredInstance();
        // A parse worker's instance is never configured: a plan carries what its units need
        const parsers = [ await GPUDecoderParserInstance.create(vc1Parser), await GPUDecoderParserInstance.create(vc1Parser) ];
        for (const packet of vc1Vector.packets) {
            const decoded = requireOnlyPicture(decoder.decode(new Uint8Array(packet.data)));
            const planned = coordinator.plan(new Uint8Array(packet.data));
            if (planned.kind !== 'picture') {
                throw new Error(`A packet planned as ${planned.kind}`);
            }
            // A packet holds one picture, so its plan is its last
            expect(planned.morePictures).toBe(false);
            const plan = new Uint8Array(planned.plan);
            const jobs = splitUnits(planned.unitCount, PARSE_JOB_COUNT)
                .map(([ firstUnit, unitCount ]: [number, number], jobIndex: number): ArrayBuffer => parsers[jobIndex % parsers.length].parse(plan, firstUnit, unitCount));
            const finished = coordinator.finish(concatenate(jobs));

            expect(digestRecord(finished.record)).toBe(digestRecord(decoded.record));
            expect([ ...planned.events, ...finished.events ]).toEqual([ ...decoded.events ]);
            expect(coordinator.planNext()).toEqual({ events: new Uint32Array(0), kind: 'no-picture' });
        }
        for (const instance of [ decoder, coordinator, ...parsers ]) {
            instance.destroy();
        }
    });

    it('starts over after a reset, numbering pictures from zero again', async () => {
        const instance = await createConfiguredInstance();
        const firstPacket = new Uint8Array(vc1Vector.packets[0].data);
        const first = requireOnlyPicture(instance.decode(firstPacket));
        instance.decode(new Uint8Array(vc1Vector.packets[1].data));

        instance.reset();
        instance.configure(vc1Vector.codecPrivate);
        const restarted = requireOnlyPicture(instance.decode(firstPacket));
        instance.destroy();

        expect(digestRecord(restarted.record)).toBe(digestRecord(first.record));
        expect(restarted.events).toEqual(first.events);
    });

    it('refuses a bare STRUCT_C, which sizes no frame, with a configuration failure', async () => {
        const instance = await GPUDecoderParserInstance.create(vc1Parser);

        expect(() => instance.configure(BARE_STRUCT_C)).toThrow(new GPUDecoderParserError(
            [ ...vc1Parser.errorNames ].find(([ , name ]) => name === CONFIGURATION_ERROR_NAME)?.[0] ?? 0,
            FRAME_SIZE_MISSING_VALUE,
            vc1Parser.errorNames
        ));
        instance.destroy();
    });

    it.each([ true, false ])('fails a damaged packet only with an error its header resyncs from, truncated: %s', async (truncate: boolean) => {
        for (const [ packetIndex, packet ] of vc1Vector.packets.entries()) {
            if (packetIndex === 0) {
                continue;
            }
            const instance = await createConfiguredInstance();
            instance.decode(new Uint8Array(vc1Vector.packets[0].data));
            try {
                instance.decode(damagePacket(packet.data, truncate));
            } catch (error: unknown) {
                // A trap or any other throw is no decoder error
                expect(error).toBeInstanceOf(GPUDecoderParserError);
                const name = vc1Parser.errorNames.get((error as GPUDecoderParserError).code) ?? '';
                expect(RESYNC_ERROR_NAMES.has(name), name).toBe(true);
            }
            instance.destroy();
        }
    });
});
