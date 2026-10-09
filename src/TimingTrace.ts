// Opt-in timing trace for diagnosing playback cadence
// Nothing is recorded or allocated until a host starts it, so every hook costs one null check otherwise
// The page records into a ring buffer; the decode worker buffers its events and sends them to the page in batches

export const TIMING_TRACE_SCHEMA_VERSION = 1;
export const DEFAULT_TIMING_TRACE_CAPACITY = 200_000;
export const TIMING_TRACE_WORKER_FLUSH_EVENT_COUNT = 128;
export const TIMING_TRACE_WORKER_FLUSH_INTERVAL_MILLISECONDS = 250;
export const MAXIMUM_TIMING_TRACE_EVENTS_PER_MESSAGE = 1_024;
const MAXIMUM_TIMING_TRACE_FIELD_COUNT = 16;
const MAXIMUM_TIMING_TRACE_STRING_LENGTH = 64;
// Times keep microsecond precision, which is finer than any browser timer exposes
const TIMING_TRACE_TIME_PRECISION = 1_000;
const LONG_TASK_ENTRY_TYPE = 'longtask';

export const TIMING_TRACE_EVENT_KINDS = Object.freeze([
    // Page: one audio worklet report mapped to the physical output clock
    'audio-clock',
    // Page: the media clock re-anchored to an external time
    'clock-sync',
    // Worker: one network range request, timed to its response headers
    'fetch',
    // Page: a decoded frame reached the presentation queue
    'frame-arrived',
    // Page: the controller discarded a frame the clock had left behind
    'frame-discarded',
    // Page: the session skipped an older due frame for a newer one
    'frame-dropped',
    // Page: the GPU finished the work that presented a decoded frame
    'gpu-work-done',
    // Page: a main-thread task of 50 ms or more
    'long-task',
    // Page: playback started or stopped waiting for audio or video
    'playback-wait',
    // Page: one render-loop frame request and the frame it took, if any
    'render-tick',
    // Worker: the video decode loop waited for a frame credit
    'video-credit-wait',
    // Worker: a decoded frame left the worker
    'video-frame-output',
    // Worker: the video decode loop waited for its next packet or sample
    'video-read'
] as const);

export type TimingTraceEventKind = typeof TIMING_TRACE_EVENT_KINDS[number];
export type TimingTraceRealm = 'page' | 'worker';
export type TimingTraceValue = boolean | number | string | null;
export type TimingTraceFields = Readonly<Record<string, TimingTraceValue>>;

/** One event; `timeMilliseconds` counts from the trace start on the page's clock. */
export type TimingTraceEvent = Readonly<{
    fields: TimingTraceFields
    kind: TimingTraceEventKind
    realm: TimingTraceRealm
    timeMilliseconds: number
}>;

/** One worker event, stamped on the shared epoch clock so the page can align it. */
export type WorkerTimingTraceEvent = Readonly<{
    epochMilliseconds: number
    fields: TimingTraceFields
    kind: TimingTraceEventKind
}>;

export type TimingTraceExport = Readonly<{
    capacity: number
    /** Events overwritten after the ring buffer filled */
    droppedEventCount: number
    events: readonly TimingTraceEvent[]
    exportedAtEpochMilliseconds: number
    metadata: Readonly<Record<string, unknown>>
    recording: boolean
    schemaVersion: number
    startedAtEpochMilliseconds: number
}>;

type TimingTraceSink = {
    record: (kind: TimingTraceEventKind, fields: TimingTraceFields, epochMilliseconds: number) => void
};

const EMPTY_FIELDS: TimingTraceFields = Object.freeze({});
const timingTraceEventKindSet: ReadonlySet<string> = new Set<string>(TIMING_TRACE_EVENT_KINDS);

/** Rounds a millisecond time or duration to the trace precision. */
export function roundTimingMilliseconds(milliseconds: number): number {
    return Math.round(milliseconds * TIMING_TRACE_TIME_PRECISION) / TIMING_TRACE_TIME_PRECISION;
}

/** Converts a `performance.now()` time of this realm to the epoch clock the page and its workers share. */
export function performanceTimeToEpochMilliseconds(performanceTimeMilliseconds: number): number {
    // eslint-disable-next-line compat/compat -- Timing traces run only where WebGPU playback runs
    return performance.timeOrigin + performanceTimeMilliseconds;
}

function readEpochMilliseconds(): number {
    return performanceTimeToEpochMilliseconds(performance.now());
}

class PageTimingTraceRecorder implements TimingTraceSink {
    public droppedEventCount = 0;
    public readonly startedAtEpochMilliseconds: number;
    private readonly events: Array<TimingTraceEvent | undefined>;
    private nextIndex = 0;
    private storedEventCount = 0;

    public constructor(public readonly capacity: number) {
        this.startedAtEpochMilliseconds = readEpochMilliseconds();
        this.events = new Array<TimingTraceEvent | undefined>(capacity);
    }

    public record(kind: TimingTraceEventKind, fields: TimingTraceFields, epochMilliseconds: number): void {
        this.add({
            fields,
            kind,
            realm: 'page',
            timeMilliseconds: roundTimingMilliseconds(epochMilliseconds - this.startedAtEpochMilliseconds)
        });
    }

    public ingest(events: readonly WorkerTimingTraceEvent[]): void {
        for (const event of events) {
            this.add({
                fields: event.fields,
                kind: event.kind,
                realm: 'worker',
                timeMilliseconds: roundTimingMilliseconds(event.epochMilliseconds - this.startedAtEpochMilliseconds)
            });
        }
    }

    /** Returns the stored events in time order; worker batches arrive late, so the ring itself is not ordered. */
    public getEvents(): TimingTraceEvent[] {
        const orderedEvents: TimingTraceEvent[] = [];
        const firstIndex = this.storedEventCount < this.capacity ? 0 : this.nextIndex;
        for (let offset = 0; offset < this.storedEventCount; offset += 1) {
            const event = this.events[(firstIndex + offset) % this.capacity];
            if (event) {
                orderedEvents.push(event);
            }
        }
        orderedEvents.sort((first: TimingTraceEvent, second: TimingTraceEvent): number => (
            first.timeMilliseconds - second.timeMilliseconds
        ));
        return orderedEvents;
    }

    private add(event: TimingTraceEvent): void {
        if (this.storedEventCount === this.capacity) {
            this.droppedEventCount += 1;
        } else {
            this.storedEventCount += 1;
        }
        this.events[this.nextIndex] = event;
        this.nextIndex = (this.nextIndex + 1) % this.capacity;
    }
}

class WorkerTimingTraceBuffer implements TimingTraceSink {
    private events: WorkerTimingTraceEvent[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    public constructor(private readonly send: (events: WorkerTimingTraceEvent[]) => void) {}

    public record(kind: TimingTraceEventKind, fields: TimingTraceFields, epochMilliseconds: number): void {
        this.events.push({ epochMilliseconds, fields, kind });
        if (this.events.length >= TIMING_TRACE_WORKER_FLUSH_EVENT_COUNT) {
            this.flush();
            return;
        }
        this.flushTimer ??= setTimeout((): void => {
            this.flushTimer = null;
            this.flush();
        }, TIMING_TRACE_WORKER_FLUSH_INTERVAL_MILLISECONDS);
    }

    public flush(): void {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        while (this.events.length > 0) {
            const batch = this.events.splice(0, MAXIMUM_TIMING_TRACE_EVENTS_PER_MESSAGE);
            try {
                this.send(batch);
            } catch {
                // A trace never interrupts playback
            }
        }
    }
}

let activeSink: TimingTraceSink | null = null;
let pageRecorder: PageTimingTraceRecorder | null = null;
let workerBuffer: WorkerTimingTraceBuffer | null = null;
let longTaskObserver: PerformanceObserver | null = null;

/** Reports whether this realm records timing events. */
export function isTimingTraceActive(): boolean {
    return activeSink !== null;
}

/** Records one event at the current time when this realm records; otherwise does nothing. */
export function recordTimingEvent(kind: TimingTraceEventKind, fields: TimingTraceFields = EMPTY_FIELDS): void {
    activeSink?.record(kind, fields, readEpochMilliseconds());
}

/** Returns the start of a wait that recordTimingWait closes, or null when this realm does not record. */
export function startTimingWait(): number | null {
    return activeSink ? readEpochMilliseconds() : null;
}

/** Records a wait that began at startTimingWait, with its duration as `waitMilliseconds`. */
export function recordTimingWait(
    kind: TimingTraceEventKind,
    startedAtEpochMilliseconds: number | null,
    fields: TimingTraceFields = EMPTY_FIELDS
): void {
    const sink = activeSink;
    if (!sink || startedAtEpochMilliseconds === null) {
        return;
    }
    const epochMilliseconds = readEpochMilliseconds();
    sink.record(kind, {
        ...fields,
        waitMilliseconds: roundTimingMilliseconds(epochMilliseconds - startedAtEpochMilliseconds)
    }, epochMilliseconds);
}

function observeLongTasks(): void {
    if (typeof PerformanceObserver !== 'function'
        || !PerformanceObserver.supportedEntryTypes?.includes(LONG_TASK_ENTRY_TYPE)) {
        return;
    }
    // eslint-disable-next-line compat/compat -- Feature-detected above
    longTaskObserver = new PerformanceObserver((entries: PerformanceObserverEntryList): void => {
        for (const entry of entries.getEntries()) {
            activeSink?.record(
                'long-task',
                { durationMilliseconds: roundTimingMilliseconds(entry.duration) },
                performanceTimeToEpochMilliseconds(entry.startTime)
            );
        }
    });
    longTaskObserver.observe({ type: LONG_TASK_ENTRY_TYPE });
}

/** Starts a page trace with a fresh buffer; a trace that is already recording continues. */
export function startTimingTrace(capacity: number = DEFAULT_TIMING_TRACE_CAPACITY): void {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
        throw new RangeError('The timing trace capacity must be a positive integer');
    }
    if (pageRecorder && activeSink === pageRecorder) {
        return;
    }
    pageRecorder = new PageTimingTraceRecorder(capacity);
    activeSink = pageRecorder;
    observeLongTasks();
}

/** Stops recording on the page; the recorded events stay exportable until the next start or clear. */
export function stopTimingTrace(): void {
    if (activeSink === pageRecorder) {
        activeSink = null;
    }
    longTaskObserver?.disconnect();
    longTaskObserver = null;
}

/** Discards the page trace and its events. */
export function clearTimingTrace(): void {
    stopTimingTrace();
    pageRecorder = null;
}

/** Merges a batch of worker events into the page trace while it records. */
export function ingestWorkerTimingEvents(events: readonly WorkerTimingTraceEvent[]): void {
    if (pageRecorder && activeSink === pageRecorder) {
        pageRecorder.ingest(events);
    }
}

/** Returns the page trace with the host's metadata, or null when no trace was started. */
export function exportTimingTrace(metadata: Readonly<Record<string, unknown>> = {}): TimingTraceExport | null {
    const recorder = pageRecorder;
    if (!recorder) {
        return null;
    }
    return {
        capacity: recorder.capacity,
        droppedEventCount: recorder.droppedEventCount,
        events: recorder.getEvents(),
        exportedAtEpochMilliseconds: readEpochMilliseconds(),
        metadata,
        recording: activeSink === recorder,
        schemaVersion: TIMING_TRACE_SCHEMA_VERSION,
        startedAtEpochMilliseconds: recorder.startedAtEpochMilliseconds
    };
}

/** Starts buffering this worker's events; `send` posts each batch to the page. */
export function startWorkerTimingTrace(send: (events: WorkerTimingTraceEvent[]) => void): void {
    workerBuffer?.flush();
    workerBuffer = new WorkerTimingTraceBuffer(send);
    activeSink = workerBuffer;
}

/** Sends this worker's remaining events and stops buffering. */
export function stopWorkerTimingTrace(): void {
    const buffer = workerBuffer;
    workerBuffer = null;
    if (activeSink === buffer) {
        activeSink = null;
    }
    buffer?.flush();
}

function isTimingTraceValue(value: unknown): value is TimingTraceValue {
    switch (typeof value) {
        case 'boolean':
            return true;
        case 'number':
            return Number.isFinite(value);
        case 'string':
            return value.length <= MAXIMUM_TIMING_TRACE_STRING_LENGTH;
        default:
            return value === null;
    }
}

function isTimingTraceFields(value: unknown): value is TimingTraceFields {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const fieldValues: unknown[] = Object.values(value);
    return fieldValues.length <= MAXIMUM_TIMING_TRACE_FIELD_COUNT && fieldValues.every(isTimingTraceValue);
}

/** Validates one worker event before the page merges it. */
export function isWorkerTimingTraceEvent(value: unknown): value is WorkerTimingTraceEvent {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const event = value as Record<string, unknown>;
    return typeof event.kind === 'string'
        && timingTraceEventKindSet.has(event.kind)
        && typeof event.epochMilliseconds === 'number'
        && Number.isFinite(event.epochMilliseconds)
        && event.epochMilliseconds > 0
        && isTimingTraceFields(event.fields);
}
