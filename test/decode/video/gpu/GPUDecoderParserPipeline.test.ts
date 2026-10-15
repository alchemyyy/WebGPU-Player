// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAXIMUM_GPU_DECODE_PACKET_PICTURES } from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import {
    GPUDecoderParserError,
    type GPUDecoderParserModule,
    type GPUDecoderParserOutput,
    type GPUDecoderParserPicture,
    type GPUDecoderPlannedPicture
} from 'webgpu-player/decode/video/gpu/GPUDecoderParser';
import GPUDecoderParserPipeline, { splitUnits, type GPUDecoderJobParser } from 'webgpu-player/decode/video/gpu/GPUDecoderParserPipeline';
import type { GPUDecoderPictureSize } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';

import { encodeWebAssemblyModule } from '../../../helpers/webAssemblyModuleEncoder';

/** What a scripted step does: return its outcome, or throw its error. */
type ScriptedOutcome<Outcome> = Error | Outcome;

// The pipeline's coordinator instance, which a real module cannot script: blocked plans, failed checks, traps, and finish events
const scripted = vi.hoisted(() => {
    /** What every coordinator's configure does: return its declared picture, or throw the failure */
    const settings: { configureFailure: Error | null; maximumPictureSize: GPUDecoderPictureSize | null } = { configureFailure: null, maximumPictureSize: null };

    /** A coordinator whose plans the test scripts per packet, by the packet's first byte, and whose planNext calls and finishes it scripts in order. */
    class ScriptedCoordinator {
        public static readonly instances: ScriptedCoordinator[] = [];
        /** Every plan, planNext, and finish, in call order, as `plan <packet>`, `plan_next`, and `finish <packet of its first job, or none>` */
        public readonly calls: string[] = [];
        public readonly configuredWith: Array<Uint8Array | null> = [];
        public destroyCount = 0;
        public readonly finishedJobs: number[][] = [];
        public readonly finishOutcomes: Array<ScriptedOutcome<GPUDecoderParserPicture>> = [];
        public readonly planNextOutcomes: Array<ScriptedOutcome<GPUDecoderPlannedPicture>> = [];
        public readonly planOutcomes = new Map<number, Array<ScriptedOutcome<GPUDecoderPlannedPicture>>>();

        public static create(): Promise<ScriptedCoordinator> {
            const coordinator = new ScriptedCoordinator();
            ScriptedCoordinator.instances.push(coordinator);
            return Promise.resolve(coordinator);
        }

        public configure(codecPrivate: Uint8Array | null): GPUDecoderPictureSize | null {
            this.configuredWith.push(codecPrivate);
            if (settings.configureFailure) {
                throw settings.configureFailure;
            }
            return settings.maximumPictureSize;
        }

        public plan(packet: Uint8Array): GPUDecoderPlannedPicture {
            const packetId = packet[0];
            this.calls.push(`plan ${packetId}`);
            return ScriptedCoordinator.take(this.planOutcomes.get(packetId), `plan of packet ${packetId}`);
        }

        public planNext(): GPUDecoderPlannedPicture {
            this.calls.push('plan_next');
            return ScriptedCoordinator.take(this.planNextOutcomes, 'plan_next');
        }

        public finish(jobs: Uint8Array): GPUDecoderParserPicture {
            this.finishedJobs.push([ ...jobs ]);
            this.calls.push(jobs.byteLength > 0 ? `finish ${jobs[0]}` : 'finish none');
            return ScriptedCoordinator.take(this.finishOutcomes, 'finish');
        }

        public destroy(): void {
            this.destroyCount += 1;
        }

        private static take<Outcome>(outcomes: Array<ScriptedOutcome<Outcome>> | undefined, subject: string): Outcome {
            const outcome = outcomes?.shift();
            if (outcome === undefined) {
                throw new Error(`No scripted ${subject}`);
            }
            if (outcome instanceof Error) {
                throw outcome;
            }
            return outcome;
        }
    }
    return { ScriptedCoordinator, settings };
});

vi.mock('webgpu-player/decode/video/gpu/GPUDecoderParser', async (importOriginal) => ({
    ...await importOriginal<typeof import('webgpu-player/decode/video/gpu/GPUDecoderParser')>(),
    default: scripted.ScriptedCoordinator
}));

type ScriptedCoordinator = InstanceType<typeof scripted.ScriptedCoordinator>;

const PARSER_MODULE: GPUDecoderParserModule = {
    errorNames: new Map([ [ 11, 'sliceData' ] ]),
    errorRecoveries: new Map(),
    memory: { initialPages: 1, maximumPages: 16 },
    module: new WebAssembly.Module(encodeWebAssemblyModule({})),
    repeatDirectiveCount: 0
};
const CODEC_PRIVATE = Uint8Array.of(1, 4, 2, 8);
const PARALLELISM = 2;
// Packets, by the id their first byte carries
const FIRST_PACKET = 1;
const SECOND_PACKET = 2;
const THIRD_PACKET = 3;
const THREE_UNITS = 3;
const ONE_UNIT = 1;
const NO_UNITS = 0;
const RECORD_BYTE_LENGTH = 64;
// Output event words: a picture presented, one dropped, and a later one presented
const PRESENT_FIRST_EVENT = 0;
const DROP_SECOND_EVENT = 0x8000_0001;
const PRESENT_THIRD_EVENT = 2;
// The events of a temporal unit's pictures: a hidden picture dropped, then the shown one presented
const DROP_HIDDEN_EVENT = 0x8000_0000;
const PRESENT_SHOWN_EVENT = 1;
const SLICE_DATA_ERROR_CODE = 11;
const SLICE_DATA_ERROR_VALUE = 7;
const PLAN_TRAP_MESSAGE = 'memory access out of bounds';
const FINISH_TRAP_MESSAGE = 'unreachable executed';
const CONFIGURE_TRAP_MESSAGE = 'integer divide by zero';
const PLAN_NEXT_TRAP_MESSAGE = 'call stack exhausted';
const PARSE_FAILURE_MESSAGE = 'parser parse: RangeError: offset out of bounds';
const BLOCKED_FAILURE_MESSAGE = 'parser plan: blocked with no earlier picture unfinished';
const BLOCKED_PLAN_NEXT_FAILURE_MESSAGE = 'parser plan_next: blocked with no earlier picture unfinished';
const DESTROYED_MESSAGE = 'parser pipeline destroyed';
// The largest picture a codec private data declares
const MAXIMUM_PICTURE_SIZE: GPUDecoderPictureSize = { height: 720, width: 1280 };
// A picture's own visible size, and its repeat counts
const PICTURE_SIZE: GPUDecoderPictureSize = { height: 288, width: 352 };
const REPEAT_COUNTS = [ 9, 0 ];
// Units split into at most a number of groups, as [first unit, unit count] pairs
const UNIT_SPLITS = [
    { groupCount: 3, groups: [ [ 0, 3 ], [ 3, 4 ], [ 7, 3 ] ], unitCount: 10 },
    { groupCount: 6, groups: [ [ 0, 1 ], [ 1, 1 ] ], unitCount: 2 },
    { groupCount: 1, groups: [ [ 0, 5 ] ], unitCount: 5 },
    { groupCount: 4, groups: [ [ 0, 0 ] ], unitCount: 0 },
    { groupCount: 0, groups: [ [ 0, 7 ] ], unitCount: 7 }
] as const;

/** A parse job the test answers: the packet its plan came from and its units. */
type PendingParse = {
    firstUnit: number
    packetId: number
    reject: (error: Error) => void
    resolve: () => void
    unitCount: number
};

/** A job's bytes: its packet id, first unit, and unit count, so a finish shows which jobs it read in which order. */
function encodeJob(packetId: number, firstUnit: number, unitCount: number): ArrayBuffer {
    return Uint8Array.of(packetId, firstUnit, unitCount).buffer;
}

/** A plan's bytes, which carry the packet id the jobs report. */
function encodePlan(packetId: number): ArrayBuffer {
    return Uint8Array.of(packetId).buffer;
}

function createPacket(packetId: number): Uint8Array {
    return Uint8Array.of(packetId);
}

function createPicture(packetId: number, unitCount: number, events: Uint32Array = new Uint32Array(0), morePictures: boolean = false): GPUDecoderPlannedPicture {
    return { events, kind: 'picture', morePictures, plan: encodePlan(packetId), unitCount };
}

function createFinished(events: Uint32Array = new Uint32Array(0)): GPUDecoderParserPicture {
    return { events, fields: null, format: null, maximumPictureSize: null, record: new ArrayBuffer(RECORD_BYTE_LENGTH), repeatCounts: [], visibleSize: null };
}

/** A packet's output of one picture, which the pipeline resolves with when the packet held only it. */
function createSinglePictureOutput(picture: GPUDecoderParserPicture): GPUDecoderParserOutput {
    return { pictures: [ picture ], trailingEvents: new Uint32Array(0) };
}

/** Parses every job at once. */
const parseImmediately: GPUDecoderJobParser = (plan: ArrayBuffer, firstUnit: number, unitCount: number): Promise<ArrayBuffer> =>
    Promise.resolve(encodeJob(new Uint8Array(plan)[0], firstUnit, unitCount));

/** Parses each job once the test answers it. */
function createControlledParser(): { parse: GPUDecoderJobParser; pending: PendingParse[] } {
    const pending: PendingParse[] = [];
    const parse: GPUDecoderJobParser = (plan: ArrayBuffer, firstUnit: number, unitCount: number): Promise<ArrayBuffer> => new Promise<ArrayBuffer>((resolve, reject) => {
        const packetId = new Uint8Array(plan)[0];
        pending.push({ firstUnit, packetId, reject, resolve: (): void => resolve(encodeJob(packetId, firstUnit, unitCount)), unitCount });
    });
    return { parse, pending };
}

async function createPipeline(parse: GPUDecoderJobParser = parseImmediately): Promise<{ coordinator: ScriptedCoordinator; pipeline: GPUDecoderParserPipeline }> {
    const pipeline = await GPUDecoderParserPipeline.create(PARSER_MODULE, CODEC_PRIVATE, parse, PARALLELISM);
    return { coordinator: scripted.ScriptedCoordinator.instances.at(-1) as ScriptedCoordinator, pipeline };
}

/** Settles a result to its output or its failure, so a rejection the test awaits later is never unhandled. */
function capture(result: Promise<GPUDecoderParserOutput>): Promise<GPUDecoderParserOutput | unknown> {
    return result.catch((error: unknown): unknown => error);
}

/** Lets every queued promise reaction run. */
async function flushReactions(): Promise<void> {
    await new Promise<void>((resolve): void => {
        setTimeout(resolve, 0);
    });
}

beforeEach(() => {
    scripted.ScriptedCoordinator.instances.length = 0;
    scripted.settings.configureFailure = null;
    scripted.settings.maximumPictureSize = null;
});

describe('splitUnits', () => {
    it.each(UNIT_SPLITS)('splits $unitCount units into $groups for $groupCount groups', ({ groupCount, groups, unitCount }) => {
        expect(splitUnits(unitCount, groupCount)).toEqual(groups);
    });
});

describe('GPUDecoderParserPipeline', () => {
    it('configures its coordinator with the track\'s codec private data, and keeps the largest picture it declares', async () => {
        scripted.settings.maximumPictureSize = MAXIMUM_PICTURE_SIZE;
        const { coordinator, pipeline } = await createPipeline();

        expect(coordinator.configuredWith).toEqual([ CODEC_PRIVATE ]);
        expect(pipeline.maximumPictureSize).toEqual(MAXIMUM_PICTURE_SIZE);
    });

    it('destroys its coordinator when configure fails, naming the step of a trap and passing a failed check on', async () => {
        scripted.settings.configureFailure = new RangeError(CONFIGURE_TRAP_MESSAGE);
        await expect(createPipeline()).rejects.toEqual(new Error(`parser configure: RangeError: ${CONFIGURE_TRAP_MESSAGE}`));
        const failedCheck = new GPUDecoderParserError(SLICE_DATA_ERROR_CODE, SLICE_DATA_ERROR_VALUE, PARSER_MODULE.errorNames);
        scripted.settings.configureFailure = failedCheck;
        await expect(createPipeline()).rejects.toBe(failedCheck);

        expect(scripted.ScriptedCoordinator.instances.map(coordinator => coordinator.destroyCount)).toEqual([ 1, 1 ]);
    });

    it('parses a picture\'s units in at most its parallelism of jobs, and finishes with the jobs in unit order', async () => {
        const parser = createControlledParser();
        const { coordinator, pipeline } = await createPipeline(parser.parse);
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, THREE_UNITS) ]);
        const picture = createFinished();
        coordinator.finishOutcomes.push(picture);

        const result = pipeline.submit(createPacket(FIRST_PACKET));
        await flushReactions();
        expect(parser.pending.map(job => [ job.firstUnit, job.unitCount ])).toEqual(splitUnits(THREE_UNITS, PARALLELISM));
        // The later units parse first, yet the finish reads the jobs in unit order
        parser.pending[1].resolve();
        parser.pending[0].resolve();

        await expect(result).resolves.toEqual(createSinglePictureOutput(picture));
        expect(coordinator.finishedJobs).toEqual([ [ FIRST_PACKET, 0, 2, FIRST_PACKET, 2, 1 ] ]);
    });

    it('finishes a plan without units from no jobs, without a parse call', async () => {
        const parser = createControlledParser();
        const { coordinator, pipeline } = await createPipeline(parser.parse);
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, NO_UNITS) ]);
        coordinator.finishOutcomes.push(createFinished());

        await pipeline.submit(createPacket(FIRST_PACKET));

        expect(parser.pending).toEqual([]);
        expect(coordinator.finishedJobs).toEqual([ [] ]);
    });

    it('plans in decode order and resolves in submission order, though a later picture\'s units parse first', async () => {
        const parser = createControlledParser();
        const { coordinator, pipeline } = await createPipeline(parser.parse);
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT) ]);
        coordinator.planOutcomes.set(SECOND_PACKET, [ createPicture(SECOND_PACKET, ONE_UNIT) ]);
        coordinator.finishOutcomes.push(createFinished(), createFinished());
        const settledPackets: number[] = [];

        const first = pipeline.submit(createPacket(FIRST_PACKET)).then((): void => {
            settledPackets.push(FIRST_PACKET);
        });
        const second = pipeline.submit(createPacket(SECOND_PACKET)).then((): void => {
            settledPackets.push(SECOND_PACKET);
        });
        await flushReactions();
        parser.pending[1].resolve();
        await flushReactions();
        expect(settledPackets).toEqual([]);
        parser.pending[0].resolve();
        await Promise.all([ first, second ]);

        expect(settledPackets).toEqual([ FIRST_PACKET, SECOND_PACKET ]);
        expect(coordinator.calls).toEqual([ `plan ${FIRST_PACKET}`, `plan ${SECOND_PACKET}`, `finish ${FIRST_PACKET}`, `finish ${SECOND_PACKET}` ]);
    });

    it('resolves a packet without a picture with its plan\'s events as trailing events, after the pictures before it', async () => {
        const parser = createControlledParser();
        const { coordinator, pipeline } = await createPipeline(parser.parse);
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT) ]);
        coordinator.planOutcomes.set(SECOND_PACKET, [ { events: Uint32Array.of(PRESENT_FIRST_EVENT), kind: 'no-picture' } ]);
        coordinator.finishOutcomes.push(createFinished());
        let secondSettled = false;

        const first = pipeline.submit(createPacket(FIRST_PACKET));
        const second = pipeline.submit(createPacket(SECOND_PACKET)).finally((): void => {
            secondSettled = true;
        });
        await flushReactions();
        expect(secondSettled).toBe(false);
        parser.pending[0].resolve();

        await first;
        await expect(second).resolves.toEqual({ pictures: [], trailingEvents: Uint32Array.of(PRESENT_FIRST_EVENT) });
    });

    it('reports a picture\'s plan events, then its finish events', async () => {
        const { coordinator, pipeline } = await createPipeline();
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT, Uint32Array.of(PRESENT_FIRST_EVENT, DROP_SECOND_EVENT)) ]);
        coordinator.planOutcomes.set(SECOND_PACKET, [ createPicture(SECOND_PACKET, ONE_UNIT) ]);
        coordinator.planOutcomes.set(THIRD_PACKET, [ createPicture(THIRD_PACKET, ONE_UNIT, Uint32Array.of(PRESENT_FIRST_EVENT)) ]);
        coordinator.finishOutcomes.push(
            createFinished(Uint32Array.of(PRESENT_THIRD_EVENT)),
            createFinished(Uint32Array.of(PRESENT_THIRD_EVENT)),
            createFinished()
        );

        const outputs = await Promise.all([ FIRST_PACKET, SECOND_PACKET, THIRD_PACKET ].map(packetId => pipeline.submit(createPacket(packetId))));

        expect(outputs.map(output => [ ...output.pictures[0].events ])).toEqual([
            [ PRESENT_FIRST_EVENT, DROP_SECOND_EVENT, PRESENT_THIRD_EVENT ],
            [ PRESENT_THIRD_EVENT ],
            [ PRESENT_FIRST_EVENT ]
        ]);
    });

    it('plans a packet\'s later pictures with plan_next until the last, each with its own jobs, events, size, and repeat counts', async () => {
        const parser = createControlledParser();
        const { coordinator, pipeline } = await createPipeline(parser.parse);
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT, Uint32Array.of(DROP_HIDDEN_EVENT), true) ]);
        coordinator.planNextOutcomes.push(createPicture(FIRST_PACKET, THREE_UNITS, Uint32Array.of(PRESENT_SHOWN_EVENT)));
        const hidden = createFinished();
        const shown: GPUDecoderParserPicture = { ...createFinished(), repeatCounts: REPEAT_COUNTS, visibleSize: PICTURE_SIZE };
        coordinator.finishOutcomes.push(hidden, shown);

        const result = pipeline.submit(createPacket(FIRST_PACKET));
        await flushReactions();
        // Both pictures parse at once: the second's plan came before the first finished
        expect(parser.pending.map(job => job.unitCount)).toEqual([ ONE_UNIT, 2, 1 ]);
        for (const job of parser.pending) {
            job.resolve();
        }
        const output = await result;

        expect(output.pictures.map(picture => [ ...picture.events ])).toEqual([ [ DROP_HIDDEN_EVENT ], [ PRESENT_SHOWN_EVENT ] ]);
        expect(output.pictures[1]).toMatchObject({ repeatCounts: REPEAT_COUNTS, visibleSize: PICTURE_SIZE });
        expect(output.trailingEvents).toEqual(new Uint32Array(0));
        expect(coordinator.calls).toEqual([ `plan ${FIRST_PACKET}`, 'plan_next', `finish ${FIRST_PACKET}`, `finish ${FIRST_PACKET}` ]);
    });

    it('takes the events of a plan_next that found no more pictures as the packet\'s trailing events, and plans the next packet only after it', async () => {
        const parser = createControlledParser();
        const { coordinator, pipeline } = await createPipeline(parser.parse);
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT, new Uint32Array(0), true) ]);
        coordinator.planNextOutcomes.push({ events: Uint32Array.of(PRESENT_FIRST_EVENT), kind: 'no-picture' });
        coordinator.planOutcomes.set(SECOND_PACKET, [ createPicture(SECOND_PACKET, ONE_UNIT) ]);
        coordinator.finishOutcomes.push(createFinished(), createFinished());

        const results = Promise.all([ pipeline.submit(createPacket(FIRST_PACKET)), pipeline.submit(createPacket(SECOND_PACKET)) ]);
        await flushReactions();
        expect(coordinator.calls).toEqual([ `plan ${FIRST_PACKET}`, 'plan_next', `plan ${SECOND_PACKET}` ]);
        for (const job of parser.pending) {
            job.resolve();
        }
        const [ first, second ] = await results;

        expect(first.pictures).toHaveLength(1);
        expect(first.trailingEvents).toEqual(Uint32Array.of(PRESENT_FIRST_EVENT));
        expect(second.pictures).toHaveLength(1);
    });

    it('calls a blocked plan_next again, keeping its place, once every earlier picture finished, the packet\'s own included', async () => {
        const parser = createControlledParser();
        const { coordinator, pipeline } = await createPipeline(parser.parse);
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT, new Uint32Array(0), true) ]);
        coordinator.planNextOutcomes.push({ kind: 'blocked' }, createPicture(FIRST_PACKET, ONE_UNIT));
        coordinator.finishOutcomes.push(createFinished(), createFinished());

        const result = pipeline.submit(createPacket(FIRST_PACKET));
        await flushReactions();
        expect(coordinator.calls).toEqual([ `plan ${FIRST_PACKET}`, 'plan_next' ]);
        parser.pending[0].resolve();
        await flushReactions();
        expect(coordinator.calls).toEqual([ `plan ${FIRST_PACKET}`, 'plan_next', `finish ${FIRST_PACKET}`, 'plan_next' ]);
        parser.pending[1].resolve();

        await expect(result).resolves.toMatchObject({ pictures: [ expect.any(Object), expect.any(Object) ] });
        expect(coordinator.calls).toEqual([ `plan ${FIRST_PACKET}`, 'plan_next', `finish ${FIRST_PACKET}`, 'plan_next', `finish ${FIRST_PACKET}` ]);
    });

    it('plans a blocked packet again once every earlier picture finished', async () => {
        const parser = createControlledParser();
        const { coordinator, pipeline } = await createPipeline(parser.parse);
        const secondPicture = createPicture(SECOND_PACKET, ONE_UNIT, Uint32Array.of(PRESENT_FIRST_EVENT));
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT) ]);
        coordinator.planOutcomes.set(SECOND_PACKET, [ { kind: 'blocked' }, secondPicture ]);
        coordinator.finishOutcomes.push(createFinished(), createFinished());

        const first = pipeline.submit(createPacket(FIRST_PACKET));
        const second = pipeline.submit(createPacket(SECOND_PACKET));
        await flushReactions();
        expect(coordinator.calls).toEqual([ `plan ${FIRST_PACKET}`, `plan ${SECOND_PACKET}` ]);
        parser.pending[0].resolve();
        await first;
        await flushReactions();
        parser.pending[1].resolve();

        await expect(second).resolves.toEqual({
            pictures: [ {
                events: Uint32Array.of(PRESENT_FIRST_EVENT),
                fields: null,
                format: null,
                maximumPictureSize: null,
                record: expect.any(ArrayBuffer),
                repeatCounts: [],
                visibleSize: null
            } ],
            trailingEvents: new Uint32Array(0)
        });
        expect(coordinator.calls).toEqual([ `plan ${FIRST_PACKET}`, `plan ${SECOND_PACKET}`, `finish ${FIRST_PACKET}`, `plan ${SECOND_PACKET}`, `finish ${SECOND_PACKET}` ]);
    });

    it('fails a packet blocked with no earlier picture unfinished, and every packet after it, planning no more', async () => {
        const { coordinator, pipeline } = await createPipeline();
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT) ]);
        coordinator.planOutcomes.set(SECOND_PACKET, [ { kind: 'blocked' } ]);
        coordinator.planOutcomes.set(THIRD_PACKET, [ createPicture(THIRD_PACKET, ONE_UNIT) ]);
        coordinator.finishOutcomes.push(createFinished());

        await pipeline.submit(createPacket(FIRST_PACKET));
        const blocked = capture(pipeline.submit(createPacket(SECOND_PACKET)));
        const later = capture(pipeline.submit(createPacket(THIRD_PACKET)));

        const failure = await blocked;
        expect(failure).toEqual(new Error(BLOCKED_FAILURE_MESSAGE));
        expect(await later).toBe(failure);
        expect(coordinator.calls).toEqual([ `plan ${FIRST_PACKET}`, `finish ${FIRST_PACKET}`, `plan ${SECOND_PACKET}` ]);
    });

    it('fails a plan_next blocked once every earlier picture finished', async () => {
        const { coordinator, pipeline } = await createPipeline();
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT, new Uint32Array(0), true) ]);
        coordinator.planNextOutcomes.push({ kind: 'blocked' }, { kind: 'blocked' });
        coordinator.finishOutcomes.push(createFinished());

        expect(await capture(pipeline.submit(createPacket(FIRST_PACKET)))).toEqual(new Error(BLOCKED_PLAN_NEXT_FAILURE_MESSAGE));
        expect(coordinator.calls).toEqual([ `plan ${FIRST_PACKET}`, 'plan_next', `finish ${FIRST_PACKET}`, 'plan_next' ]);
    });

    it('fails a packet past the most pictures one packet may hold, planning no picture beyond it', async () => {
        const { coordinator, pipeline } = await createPipeline();
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT, new Uint32Array(0), true) ]);
        for (let pictureIndex = 1; pictureIndex < MAXIMUM_GPU_DECODE_PACKET_PICTURES; pictureIndex += 1) {
            coordinator.planNextOutcomes.push(createPicture(FIRST_PACKET, ONE_UNIT, new Uint32Array(0), true));
        }
        for (let pictureIndex = 0; pictureIndex < MAXIMUM_GPU_DECODE_PACKET_PICTURES; pictureIndex += 1) {
            coordinator.finishOutcomes.push(createFinished());
        }

        const failure = await capture(pipeline.submit(createPacket(FIRST_PACKET)));

        expect(failure).toEqual(new RangeError(`parser pictures ${MAXIMUM_GPU_DECODE_PACKET_PICTURES + 1} > ${MAXIMUM_GPU_DECODE_PACKET_PICTURES} in one packet`));
        expect(coordinator.calls.filter(call => call === 'plan_next')).toHaveLength(MAXIMUM_GPU_DECODE_PACKET_PICTURES - 1);
    });

    it('rejects a failed check as itself, and latches it for every packet planned or submitted after it', async () => {
        const parser = createControlledParser();
        const { coordinator, pipeline } = await createPipeline(parser.parse);
        const failedCheck = new GPUDecoderParserError(SLICE_DATA_ERROR_CODE, SLICE_DATA_ERROR_VALUE, PARSER_MODULE.errorNames);
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT) ]);
        coordinator.planOutcomes.set(SECOND_PACKET, [ createPicture(SECOND_PACKET, ONE_UNIT) ]);
        coordinator.finishOutcomes.push(failedCheck, createFinished());

        const first = capture(pipeline.submit(createPacket(FIRST_PACKET)));
        const planned = capture(pipeline.submit(createPacket(SECOND_PACKET)));
        await flushReactions();
        for (const job of parser.pending) {
            job.resolve();
        }

        expect(await first).toBe(failedCheck);
        expect(await planned).toBe(failedCheck);
        expect(await capture(pipeline.submit(createPacket(THIRD_PACKET)))).toBe(failedCheck);
        expect(coordinator.calls).toEqual([ `plan ${FIRST_PACKET}`, `plan ${SECOND_PACKET}`, `finish ${FIRST_PACKET}` ]);
    });

    it('rejects a packet whose later picture failed to finish, though its first picture finished', async () => {
        const { coordinator, pipeline } = await createPipeline();
        const failedCheck = new GPUDecoderParserError(SLICE_DATA_ERROR_CODE, SLICE_DATA_ERROR_VALUE, PARSER_MODULE.errorNames);
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT, new Uint32Array(0), true) ]);
        coordinator.planNextOutcomes.push(createPicture(FIRST_PACKET, ONE_UNIT));
        coordinator.finishOutcomes.push(createFinished(), failedCheck);

        expect(await capture(pipeline.submit(createPacket(FIRST_PACKET)))).toBe(failedCheck);
        expect(await capture(pipeline.submit(createPacket(SECOND_PACKET)))).toBe(failedCheck);
    });

    it('names the coordinator step a trap came from', async () => {
        const planTrap = await createPipeline();
        planTrap.coordinator.planOutcomes.set(FIRST_PACKET, [ new RangeError(PLAN_TRAP_MESSAGE) ]);
        const finishTrap = await createPipeline();
        finishTrap.coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT) ]);
        finishTrap.coordinator.finishOutcomes.push(new TypeError(FINISH_TRAP_MESSAGE));
        const planNextTrap = await createPipeline();
        planNextTrap.coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT, new Uint32Array(0), true) ]);
        planNextTrap.coordinator.planNextOutcomes.push(new RangeError(PLAN_NEXT_TRAP_MESSAGE));
        planNextTrap.coordinator.finishOutcomes.push(createFinished());

        expect(await capture(planTrap.pipeline.submit(createPacket(FIRST_PACKET)))).toEqual(new Error(`parser plan: RangeError: ${PLAN_TRAP_MESSAGE}`));
        expect(await capture(finishTrap.pipeline.submit(createPacket(FIRST_PACKET)))).toEqual(new Error(`parser finish: TypeError: ${FINISH_TRAP_MESSAGE}`));
        expect(await capture(planNextTrap.pipeline.submit(createPacket(FIRST_PACKET)))).toEqual(new Error(`parser plan_next: RangeError: ${PLAN_NEXT_TRAP_MESSAGE}`));
    });

    it('rejects a picture whose units failed to parse with that failure, and every packet after it', async () => {
        const parser = createControlledParser();
        const { coordinator, pipeline } = await createPipeline(parser.parse);
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT) ]);
        const parseFailure = new Error(PARSE_FAILURE_MESSAGE);

        const first = capture(pipeline.submit(createPacket(FIRST_PACKET)));
        await flushReactions();
        parser.pending[0].reject(parseFailure);

        expect(await first).toBe(parseFailure);
        expect(await capture(pipeline.submit(createPacket(SECOND_PACKET)))).toBe(parseFailure);
        expect(coordinator.finishedJobs).toEqual([]);
    });

    it('rejects every packet once destroyed, and destroys its coordinator once', async () => {
        const parser = createControlledParser();
        const { coordinator, pipeline } = await createPipeline(parser.parse);
        coordinator.planOutcomes.set(FIRST_PACKET, [ createPicture(FIRST_PACKET, ONE_UNIT) ]);
        const first = capture(pipeline.submit(createPacket(FIRST_PACKET)));
        await flushReactions();

        pipeline.destroy();
        pipeline.destroy();
        parser.pending[0].resolve();

        expect(await first).toEqual(new Error(DESTROYED_MESSAGE));
        expect(await capture(pipeline.submit(createPacket(SECOND_PACKET)))).toEqual(new Error(DESTROYED_MESSAGE));
        expect(coordinator.destroyCount).toBe(1);
        expect(coordinator.finishedJobs).toEqual([]);
    });
});
