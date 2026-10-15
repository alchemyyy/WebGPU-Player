// Turns a track's packets into a parser's output in decode order: each picture's GPU record and the output events its steps decided.
// A coordinator instance plans each packet as it arrives, picture after picture; each picture's units parse in parallel, split into up to `parallelism` jobs;
// pictures then finish one after another, since a finish may read earlier pictures, as motion derivation does.
// A plan or planNext that reports blocked waits until every earlier picture finished, then calls again, as a codec whose parsing reads earlier pictures needs.
import { MAXIMUM_GPU_DECODE_PACKET_PICTURES } from './GPUDecodeLimits';
import type { GPUDecoderPictureSize } from './GPUDecodeTypes';
import GPUDecoderParserInstance, {
    GPU_DECODER_PARSER_BLOCKED_DETAIL,
    GPUDecoderParserError,
    type GPUDecoderParserModule,
    type GPUDecoderParserOutput,
    type GPUDecoderParserPicture,
    type GPUDecoderPlannedPicture
} from './GPUDecoderParser';

/** Parses units of a serialized plan into a serialized job: on a parse worker, or inline. */
export type GPUDecoderJobParser = (plan: ArrayBuffer, firstUnit: number, unitCount: number) => Promise<ArrayBuffer>;

/** The coordinator calls that plan a packet: plan for its first picture, then planNext for each one after it. */
type PlanStep = 'plan' | 'plan_next';

/** A planned picture, ready for its parse jobs and its finish. */
type PlannedPicture = Extract<GPUDecoderPlannedPicture, { kind: 'picture' }>;

/** A plan step's outcome once it is not blocked: what it planned, or why the packet plans no further. */
type PlanAttempt =
    | Readonly<{ kind: 'planned'; planned: Exclude<GPUDecoderPlannedPicture, { kind: 'blocked' }> }>
    | Readonly<{ kind: 'destroyed' }>
    | Readonly<{ kind: 'failed'; failure: Error }>
    | Readonly<{ kind: 'latched' }>;

const DESTROYED_MESSAGE = 'parser pipeline destroyed';

/** Splits unitCount units into at most groupCount contiguous groups of nearly equal size, as [first unit, unit count] pairs. */
export function splitUnits(unitCount: number, groupCount: number): Array<[number, number]> {
    const groups: Array<[number, number]> = [];
    const count = Math.max(1, Math.min(unitCount, groupCount));
    let first = 0;
    for (let group = 0; group < count; group += 1) {
        const end = Math.round(((group + 1) * unitCount) / count);
        groups.push([ first, end - first ]);
        first = end;
    }
    return groups;
}

function concatenate(buffers: readonly ArrayBuffer[]): Uint8Array {
    if (buffers.length === 1) {
        return new Uint8Array(buffers[0]);
    }
    const total = buffers.reduce((sum: number, buffer: ArrayBuffer): number => sum + buffer.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const buffer of buffers) {
        bytes.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
    }
    return bytes;
}

function concatenateEvents(first: Uint32Array, second: Uint32Array): Uint32Array {
    if (second.length === 0) {
        return first;
    }
    if (first.length === 0) {
        return second;
    }
    const events = new Uint32Array(first.length + second.length);
    events.set(first, 0);
    events.set(second, first.length);
    return events;
}

function ignoreRejection(): void {
    // The picture's step reports the failure to its caller once the steps before it have settled
}

/** Names the coordinator step a trap came from; a failed check names itself. */
function describeStepFailure(step: string, error: unknown): Error {
    if (error instanceof GPUDecoderParserError) {
        return error;
    }
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return new Error(`parser ${step}: ${detail}`);
}

type Settlement = {
    reject: (error: Error) => void
    resolve: (output: GPUDecoderParserOutput) => void
};

export default class GPUDecoderParserPipeline {
    private destroyed = false;
    // Set once a step failed: the chain rejects every later packet, and the coordinator, which a trap may have left mid-operation, plans no more
    private failed = false;
    private finishChain: Promise<unknown> = Promise.resolve();
    private planChain: Promise<void> = Promise.resolve();
    // Pictures planned and not yet finished, which a blocked plan or planNext waits for
    private unfinishedPictureCount = 0;

    private constructor(
        private readonly coordinator: GPUDecoderParserInstance,
        private readonly parseJob: GPUDecoderJobParser,
        private readonly parallelism: number,
        /** The largest picture the track's codec private data declares, or null */
        readonly maximumPictureSize: GPUDecoderPictureSize | null
    ) {}

    /** Creates a pipeline on a fresh coordinator instance configured with the track's codec private data. */
    static async create(
        parser: GPUDecoderParserModule,
        codecPrivate: Uint8Array | null,
        parseJob: GPUDecoderJobParser,
        parallelism: number
    ): Promise<GPUDecoderParserPipeline> {
        const coordinator = await GPUDecoderParserInstance.create(parser);
        let maximumPictureSize: GPUDecoderPictureSize | null;
        try {
            maximumPictureSize = coordinator.configure(codecPrivate);
        } catch (error) {
            coordinator.destroy();
            throw describeStepFailure('configure', error);
        }
        return new GPUDecoderParserPipeline(coordinator, parseJob, Math.max(1, parallelism), maximumPictureSize);
    }

    /**
     * Takes the next packet in decode order and resolves with its pictures' GPU records and the output events their steps decided,
     * and the events of a call that planned no picture, which wait for the next picture.
     * Results resolve in submission order; after a failure, every later packet rejects with it. The pipeline reads the packet's bytes until its plan ran.
     */
    submit(packet: Uint8Array): Promise<GPUDecoderParserOutput> {
        if (this.destroyed) {
            return Promise.reject(new Error(DESTROYED_MESSAGE));
        }
        const result = new Promise<GPUDecoderParserOutput>((resolve, reject): void => {
            this.planChain = this.planChain.then((): Promise<void> => this.planPacket(packet, { reject, resolve }));
        });
        result.catch(ignoreRejection);
        return result;
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.coordinator.destroy();
    }

    /**
     * Plans a packet's pictures in decode order, plan then planNext until the packet holds no more, appending each picture's finish to the chain,
     * then the packet's result; it never rejects, its settlement carries any failure.
     */
    private async planPacket(packet: Uint8Array, settlement: Settlement): Promise<void> {
        const pictures: Array<Promise<GPUDecoderParserPicture>> = [];
        let trailingEvents: Uint32Array = new Uint32Array(0);
        let step: PlanStep = 'plan';
        let morePictures = true;
        while (morePictures) {
            const attempt = await this.planUnblocked(step, packet);
            switch (attempt.kind) {
                case 'destroyed':
                    settlement.reject(new Error(DESTROYED_MESSAGE));
                    return;
                case 'latched':
                    // The chain rejects with the earlier failure
                    this.enqueue((): GPUDecoderParserOutput => ({ pictures: [], trailingEvents })).then(settlement.resolve, settlement.reject);
                    return;
                case 'failed':
                    this.failWith(attempt.failure, settlement);
                    return;
                case 'planned':
                    break;
            }
            const planned = attempt.planned;
            if (planned.kind === 'no-picture') {
                trailingEvents = planned.events;
                break;
            }
            if (planned.morePictures && pictures.length + 1 >= MAXIMUM_GPU_DECODE_PACKET_PICTURES) {
                this.failWith(new RangeError(`parser pictures ${pictures.length + 2} > ${MAXIMUM_GPU_DECODE_PACKET_PICTURES} in one packet`), settlement);
                return;
            }
            pictures.push(this.enqueuePicture(planned));
            morePictures = planned.morePictures;
            step = 'plan_next';
        }
        // Every picture's finish runs before this step, so the packet settles with them in submission order
        this.enqueue(async (): Promise<GPUDecoderParserOutput> => ({ pictures: await Promise.all(pictures), trailingEvents })).then(settlement.resolve, settlement.reject);
    }

    /**
     * Calls plan, or planNext, until it is not blocked; between calls every earlier picture finishes.
     * A blocked plan kept no state and plans the packet again, and a blocked planNext kept its place.
     */
    private async planUnblocked(step: PlanStep, packet: Uint8Array): Promise<PlanAttempt> {
        for (;;) {
            if (this.destroyed) {
                return { kind: 'destroyed' };
            }
            if (this.failed) {
                return { kind: 'latched' };
            }
            let planned: GPUDecoderPlannedPicture;
            try {
                planned = step === 'plan' ? this.coordinator.plan(packet) : this.coordinator.planNext();
            } catch (error) {
                return { failure: describeStepFailure(step, error), kind: 'failed' };
            }
            if (planned.kind !== 'blocked') {
                return { kind: 'planned', planned };
            }
            if (this.unfinishedPictureCount === 0) {
                return { failure: new Error(`parser ${step}: ${GPU_DECODER_PARSER_BLOCKED_DETAIL}`), kind: 'failed' };
            }
            await this.finishChain.catch(ignoreRejection);
        }
    }

    /**
     * Parses a planned picture's units in parallel and appends its finish to the chain; resolves with the finished picture, its plan's events first.
     * A plan without units parses nothing, so its finish reads no jobs.
     */
    private enqueuePicture(planned: PlannedPicture): Promise<GPUDecoderParserPicture> {
        const { events: planEvents, plan, unitCount } = planned;
        this.unfinishedPictureCount += 1;
        const jobs = unitCount === 0 ?
            Promise.resolve<ArrayBuffer[]>([]) :
            Promise.all(splitUnits(unitCount, this.parallelism).map(([ first, count ]) => this.parseJob(plan, first, count)));
        jobs.catch(ignoreRejection);
        return this.enqueue(async (): Promise<GPUDecoderParserPicture> => {
            try {
                const parsedJobs = await jobs;
                if (this.destroyed) {
                    throw new Error(DESTROYED_MESSAGE);
                }
                let picture: GPUDecoderParserPicture;
                try {
                    picture = this.coordinator.finish(concatenate(parsedJobs));
                } catch (error) {
                    this.failed = true;
                    throw describeStepFailure('finish', error);
                }
                return { ...picture, events: concatenateEvents(planEvents, picture.events) };
            } finally {
                this.unfinishedPictureCount -= 1;
            }
        });
    }

    private failWith(failure: Error, settlement: Settlement): void {
        this.failed = true;
        this.enqueue((): never => {
            throw failure;
        }).then(settlement.resolve, settlement.reject);
    }

    /** Appends a step that runs once every earlier step succeeded, so results settle in submission order and a failure rejects every later one. */
    private enqueue<Result>(step: () => Result | Promise<Result>): Promise<Result> {
        const result = this.finishChain.then(step);
        this.finishChain = result;
        result.catch((): void => {
            this.failed = true;
        });
        return result;
    }
}
