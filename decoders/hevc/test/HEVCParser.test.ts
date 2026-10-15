// @vitest-environment node

import { beforeAll, describe, expect, it } from 'vitest';

import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { GPU_DECODER_MAXIMUM_REPEAT_COUNT, GPU_DECODER_OUTPUT_EVENT } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import GPUDecoderParserInstance, {
    getGPUDecoderParserModule,
    type GPUDecoderParserModule,
    type GPUDecoderParserOutput,
    type GPUDecoderParserPicture
} from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import { splitUnits } from 'webgpu-player/decode/video/gpu/GPUDecoderParserPipeline';
import { parseGPUDecoderVectorSet, type GPUDecoderVector } from 'webgpu-player/decode/video/gpu/GPUDecoderVectorSet';

import { loadDecoderProjectVideoPackage, readDecoderProjectVectors } from '../../../test/helpers/decoderPackages';

const PROJECT = 'hevc';
// Parse workers the split decode spreads each picture's units over
const PARSE_JOB_COUNT = 2;

let hevcParser: GPUDecoderParserModule;
let hevcVectors: ReadonlyMap<GPUDecoderOutputFormat, GPUDecoderVector>;

beforeAll(async () => {
    const decoderPackage = await loadDecoderProjectVideoPackage(PROJECT);
    hevcParser = getGPUDecoderParserModule(decoderPackage);
    hevcVectors = parseGPUDecoderVectorSet(readDecoderProjectVectors(PROJECT));
});

/** Returns the one picture an access unit decodes to, which every packet of the HEVC vectors holds. */
function requireOnlyPicture(output: GPUDecoderParserOutput): GPUDecoderParserPicture {
    if (output.pictures.length !== 1) {
        throw new Error(`An access unit decoded to ${output.pictures.length} pictures`);
    }
    return output.pictures[0];
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

async function createConfiguredInstance(vector: GPUDecoderVector): Promise<GPUDecoderParserInstance> {
    const instance = await GPUDecoderParserInstance.create(hevcParser);
    instance.configure(vector.codecPrivate);
    return instance;
}

describe('GPUDecoderParserInstance on the HEVC package\'s parser', () => {
    it('decodes every packet of each vector into one picture\'s GPU record, and outputs every picture exactly once', async () => {
        expect(hevcVectors.size).toBeGreaterThan(0);
        for (const [ format, vector ] of hevcVectors) {
            const instance = await createConfiguredInstance(vector);
            const eventsByPicture = new Map<number, number[]>();
            let pictureCount = 0;
            for (const packet of vector.packets) {
                const output = instance.decode(new Uint8Array(packet.data));
                const picture = requireOnlyPicture(output);
                expect(picture.record.byteLength, format).toBeGreaterThan(0);
                // The conformance window reaches the session through the record, so a picture reports no size of its own
                expect(picture.visibleSize, format).toBeNull();
                expect(picture.repeatCounts, format).toEqual([ GPU_DECODER_MAXIMUM_REPEAT_COUNT ]);
                expect(output.trailingEvents, format).toEqual(new Uint32Array(0));
                pictureCount += 1;
                for (const event of picture.events) {
                    const pictureIndex = event & GPU_DECODER_OUTPUT_EVENT.pictureIndexMask;
                    // A picture is output once decoded, and every picture of a vector is presented
                    expect(event & GPU_DECODER_OUTPUT_EVENT.reservedBit, format).toBe(0);
                    expect(event & GPU_DECODER_OUTPUT_EVENT.discardBit, format).toBe(0);
                    expect(pictureIndex, format).toBeLessThan(pictureCount);
                    eventsByPicture.set(pictureIndex, [ ...eventsByPicture.get(pictureIndex) ?? [], event ]);
                }
            }
            instance.destroy();

            expect(pictureCount, format).toBe(vector.packets.length);
            expect([ ...eventsByPicture.keys() ].sort((first: number, second: number): number => first - second), format)
                .toEqual(Array.from({ length: pictureCount }, (_value: unknown, pictureIndex: number): number => pictureIndex));
            expect([ ...eventsByPicture.values() ].every((events: number[]): boolean => events.length === 1), format).toBe(true);
        }
    });

    it('plans, parses on another instance, and finishes each picture into the record and events that decode makes', async () => {
        for (const [ format, vector ] of hevcVectors) {
            const decoder = await createConfiguredInstance(vector);
            const coordinator = await createConfiguredInstance(vector);
            // A parse worker's instance is never configured: a plan carries what its units need
            const parser = await GPUDecoderParserInstance.create(hevcParser);
            for (const packet of vector.packets) {
                const decoded = requireOnlyPicture(decoder.decode(new Uint8Array(packet.data)));
                const planned = coordinator.plan(new Uint8Array(packet.data));
                if (planned.kind !== 'picture') {
                    throw new Error(`${format} packet planned as ${planned.kind}`);
                }
                // An access unit holds one picture, so its plan is its last
                expect(planned.morePictures, format).toBe(false);
                const plan = new Uint8Array(planned.plan);
                const jobs = splitUnits(planned.unitCount, PARSE_JOB_COUNT)
                    .map(([ firstUnit, unitCount ]: [number, number]): ArrayBuffer => parser.parse(plan, firstUnit, unitCount));
                const finished: GPUDecoderParserPicture = coordinator.finish(concatenate(jobs));

                expect(new Uint8Array(finished.record), format).toEqual(new Uint8Array(decoded.record));
                expect([ ...planned.events, ...finished.events ], format).toEqual([ ...decoded.events ]);
                expect(coordinator.planNext(), format).toEqual({ events: new Uint32Array(0), kind: 'no-picture' });
            }
            for (const instance of [ decoder, coordinator, parser ]) {
                instance.destroy();
            }
        }
    });

    it('starts over after a reset, numbering pictures from zero again', async () => {
        const [ vector ] = hevcVectors.values();
        const instance = await createConfiguredInstance(vector);
        const firstPacket = new Uint8Array(vector.packets[0].data);
        const first = requireOnlyPicture(instance.decode(firstPacket));
        instance.decode(new Uint8Array(vector.packets[1].data));

        instance.reset();
        expect(instance.configure(vector.codecPrivate)).toBeNull();
        const restarted = requireOnlyPicture(instance.decode(firstPacket));
        instance.destroy();

        expect(new Uint8Array(restarted.record)).toEqual(new Uint8Array(first.record));
        expect(restarted.events).toEqual(first.events);
    });
});
