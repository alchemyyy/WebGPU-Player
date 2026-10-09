import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    clearTimingTrace,
    exportTimingTrace,
    ingestWorkerTimingEvents,
    isTimingTraceActive,
    isWorkerTimingTraceEvent,
    performanceTimeToEpochMilliseconds,
    recordTimingEvent,
    recordTimingWait,
    startTimingTrace,
    startTimingWait,
    startWorkerTimingTrace,
    stopTimingTrace,
    stopWorkerTimingTrace,
    TIMING_TRACE_SCHEMA_VERSION,
    TIMING_TRACE_WORKER_FLUSH_EVENT_COUNT,
    TIMING_TRACE_WORKER_FLUSH_INTERVAL_MILLISECONDS,
    type WorkerTimingTraceEvent
} from 'webgpu-player/TimingTrace';

// performance.now() readings, in milliseconds since the page's time origin
const TRACE_START_TIME = 1_000;
const WORKER_EVENT_TIME = 1_005;
const PAGE_EVENT_TIME = 1_010;
const WAIT_END_TIME = 1_012.5;
const WORKER_EVENT_OFFSET = 5;
const PAGE_EVENT_OFFSET = 10;
const WAIT_DURATION = 12.5;
const SMALL_CAPACITY = 2;
const OVERFLOW_EVENT_COUNT = 3;
const HOST_METADATA = Object.freeze({ itemId: 'item-1' });
const FRAME_MEDIA_TIME = 41_708;
const OVERSIZED_FIELD_COUNT = 17;
const OVERLONG_STRING = 'x'.repeat(65);

let currentTime = TRACE_START_TIME;

function createWorkerEvent(epochMilliseconds: number): WorkerTimingTraceEvent {
    return {
        epochMilliseconds,
        fields: { mediaTimeMicroseconds: FRAME_MEDIA_TIME, source: 'packet' },
        kind: 'video-read'
    };
}

beforeEach(() => {
    currentTime = TRACE_START_TIME;
    vi.spyOn(performance, 'now').mockImplementation((): number => currentTime);
});

afterEach(() => {
    stopWorkerTimingTrace();
    clearTimingTrace();
    vi.useRealTimers();
});

describe('TimingTrace', () => {
    it('records nothing until a trace starts', () => {
        expect(isTimingTraceActive()).toBe(false);
        recordTimingEvent('render-tick');
        expect(startTimingWait()).toBeNull();
        expect(exportTimingTrace()).toBeNull();
    });

    it('exports events in time order, measured from the trace start, with the host metadata', () => {
        startTimingTrace();
        currentTime = PAGE_EVENT_TIME;
        recordTimingEvent('render-tick', { state: 'playing' });
        // A worker batch arrives after the page event it preceded
        ingestWorkerTimingEvents([ createWorkerEvent(performanceTimeToEpochMilliseconds(WORKER_EVENT_TIME)) ]);

        const trace = exportTimingTrace(HOST_METADATA);

        expect(trace).toMatchObject({
            droppedEventCount: 0,
            metadata: HOST_METADATA,
            recording: true,
            schemaVersion: TIMING_TRACE_SCHEMA_VERSION
        });
        expect(trace?.events.map(event => [ event.realm, event.kind, event.timeMilliseconds ])).toEqual([
            [ 'worker', 'video-read', WORKER_EVENT_OFFSET ],
            [ 'page', 'render-tick', PAGE_EVENT_OFFSET ]
        ]);
    });

    it('overwrites the oldest events once the buffer is full, and counts them', () => {
        startTimingTrace(SMALL_CAPACITY);
        for (let eventIndex = 0; eventIndex < OVERFLOW_EVENT_COUNT; eventIndex += 1) {
            currentTime = TRACE_START_TIME + eventIndex;
            recordTimingEvent('render-tick', { eventIndex });
        }

        const trace = exportTimingTrace();

        expect(trace?.droppedEventCount).toBe(OVERFLOW_EVENT_COUNT - SMALL_CAPACITY);
        expect(trace?.events.map(event => event.fields.eventIndex)).toEqual([ 1, 2 ]);
    });

    it('keeps a stopped trace exportable until it is cleared', () => {
        startTimingTrace();
        recordTimingEvent('render-tick');
        stopTimingTrace();
        recordTimingEvent('render-tick');
        ingestWorkerTimingEvents([ createWorkerEvent(performanceTimeToEpochMilliseconds(WORKER_EVENT_TIME)) ]);

        expect(isTimingTraceActive()).toBe(false);
        expect(exportTimingTrace()).toMatchObject({ recording: false });
        expect(exportTimingTrace()?.events).toHaveLength(1);
        clearTimingTrace();
        expect(exportTimingTrace()).toBeNull();
    });

    it('measures a wait from its start', () => {
        startTimingTrace();
        const waitStartedAt = startTimingWait();
        currentTime = WAIT_END_TIME;
        recordTimingWait('video-read', waitStartedAt, { source: 'packet' });

        expect(exportTimingTrace()?.events[0].fields).toEqual({
            source: 'packet',
            waitMilliseconds: WAIT_DURATION
        });
    });

    it('rejects a capacity that holds no event', () => {
        expect(() => startTimingTrace(0)).toThrow(RangeError);
    });

    it('sends worker events in batches when a batch fills or the interval passes, and the rest on stop', () => {
        vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout' ] });
        const sentBatches: WorkerTimingTraceEvent[][] = [];
        startWorkerTimingTrace((events: WorkerTimingTraceEvent[]): void => {
            sentBatches.push(events);
        });

        for (let eventIndex = 0; eventIndex < TIMING_TRACE_WORKER_FLUSH_EVENT_COUNT; eventIndex += 1) {
            recordTimingEvent('video-frame-output');
        }
        expect(sentBatches.map(batch => batch.length)).toEqual([ TIMING_TRACE_WORKER_FLUSH_EVENT_COUNT ]);

        recordTimingEvent('video-credit-wait');
        expect(sentBatches).toHaveLength(1);
        vi.advanceTimersByTime(TIMING_TRACE_WORKER_FLUSH_INTERVAL_MILLISECONDS);
        expect(sentBatches.map(batch => batch.length)).toEqual([ TIMING_TRACE_WORKER_FLUSH_EVENT_COUNT, 1 ]);

        recordTimingEvent('fetch');
        stopWorkerTimingTrace();
        recordTimingEvent('fetch');
        expect(sentBatches.map(batch => batch.length)).toEqual([ TIMING_TRACE_WORKER_FLUSH_EVENT_COUNT, 1, 1 ]);
        expect(sentBatches[2][0].epochMilliseconds).toBe(performanceTimeToEpochMilliseconds(TRACE_START_TIME));
    });

    it('accepts only well-formed worker events', () => {
        const validEvent = createWorkerEvent(performanceTimeToEpochMilliseconds(WORKER_EVENT_TIME));
        const oversizedFields = Object.fromEntries(
            Array.from({ length: OVERSIZED_FIELD_COUNT }, (_: unknown, fieldIndex: number): [string, number] => [ `field${fieldIndex}`, fieldIndex ])
        );

        expect(isWorkerTimingTraceEvent(validEvent)).toBe(true);
        expect(isWorkerTimingTraceEvent({ ...validEvent, kind: 'unknown-kind' })).toBe(false);
        expect(isWorkerTimingTraceEvent({ ...validEvent, epochMilliseconds: Number.NaN })).toBe(false);
        expect(isWorkerTimingTraceEvent({ ...validEvent, epochMilliseconds: 0 })).toBe(false);
        expect(isWorkerTimingTraceEvent({ ...validEvent, fields: { nested: { value: 1 } } })).toBe(false);
        expect(isWorkerTimingTraceEvent({ ...validEvent, fields: { range: OVERLONG_STRING } })).toBe(false);
        expect(isWorkerTimingTraceEvent({ ...validEvent, fields: oversizedFields })).toBe(false);
        expect(isWorkerTimingTraceEvent({ ...validEvent, fields: [ 1 ] })).toBe(false);
    });
});
