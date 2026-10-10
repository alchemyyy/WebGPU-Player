import { describe, expect, it } from 'vitest';

import {
    CUSTOM_AUDIO_WORKLET_PROCESSOR_NAME,
    getCustomAudioWorkletSource
} from 'webgpu-player/audio/output/AudioWorkletProcessorSource';

type WorkletMessageEvent = { data: unknown };

class MockProcessorPort {
    public closeCount = 0;
    public onmessage: ((event: WorkletMessageEvent) => void) | null = null;
    public readonly postedMessages: unknown[] = [];
    public readonly postedTransfers: Transferable[][] = [];

    public postMessage(message: unknown, transfer: Transferable[] = []): void {
        this.postedMessages.push(message);
        this.postedTransfers.push([ ...transfer ]);
    }

    public close(): void {
        this.closeCount += 1;
    }

    public deliver(message: unknown): void {
        this.onmessage?.({ data: message });
    }
}

class MockAudioWorkletProcessor {
    public readonly port = new MockProcessorPort();
}

type ProcessorHarness = MockAudioWorkletProcessor & {
    process: (inputs: readonly unknown[], outputs: readonly Float32Array[][]) => boolean
};

type ProcessorStateHarness = ProcessorHarness & {
    channelCount: number
    chunkCount: number
    chunks: readonly unknown[]
    consumedFrames: number
    droppedFrames: number
    framesSinceTelemetry: number
    generation: number
    headChunkIndex: number
    leadingGapFrames: number
    leadingGapPending: boolean
    leadingGapRenderedFrames: number
    leadingGapStartMicroseconds: number
    mediaTimeContextTimeMicroseconds: number | null
    mediaTimeMicroseconds: number
    muted: boolean
    outputFrames: number
    overflowEvents: number
    overflowFrames: number
    playing: boolean
    queuedFrames: number
    staleChunks: number
    tailChunkIndex: number
    underflowActive: boolean
    underflowEvents: number
    underflowFrames: number
    volume: number
};

type ProcessorConstructor = new (options: {
    processorOptions: {
        channelCount: number
        maxBufferedFrames: number
        maxChunks: number
        telemetryIntervalFrames: number
    }
}) => ProcessorHarness;

type WorkletModuleEvaluator = (
    processorBase: typeof MockAudioWorkletProcessor,
    registerProcessor: (name: string, constructor: ProcessorConstructor) => void,
    sampleRate: number,
    currentFrame: number
) => void;

function evaluateWorkletModule(
    registerProcessor: (name: string, constructor: ProcessorConstructor) => void,
    sampleRate: number,
    currentFrame: number
): void {
    // eslint-disable-next-line sonarjs/code-eval -- Validates the generated standalone module
    const evaluateModule = Function(
        'AudioWorkletProcessor',
        'registerProcessor',
        'sampleRate',
        'currentFrame',
        getCustomAudioWorkletSource()
    ) as WorkletModuleEvaluator;
    evaluateModule(MockAudioWorkletProcessor, registerProcessor, sampleRate, currentFrame);
}

function requireProcessorConstructor(
    constructor: ProcessorConstructor | null
): ProcessorConstructor {
    if (!constructor) {
        throw new Error('Worklet processor was not registered');
    }
    return constructor;
}

type ProcessorOptions = ConstructorParameters<ProcessorConstructor>[0]['processorOptions'];

// At 1 kHz one frame is one millisecond
const LEADING_GAP_SAMPLE_RATE = 1_000;
const LEADING_GAP_CURRENT_FRAME = 40_000;
const LEADING_GAP_RENDER_FRAME_COUNT = 4;
// The processor only echoes enqueue sequences in telemetry
const LEADING_GAP_CHUNK_SEQUENCE = 1;
const LEADING_GAP_PROCESSOR_OPTIONS: ProcessorOptions = {
    channelCount: 1,
    maxBufferedFrames: 8,
    maxChunks: 2,
    // One periodic telemetry message closes every render quantum
    telemetryIntervalFrames: LEADING_GAP_RENDER_FRAME_COUNT
};

function createLeadingGapProcessor(
    processorOptions: ProcessorOptions = LEADING_GAP_PROCESSOR_OPTIONS
): ProcessorStateHarness {
    let registeredConstructor: ProcessorConstructor | null = null;
    evaluateWorkletModule((_name, constructor): void => {
        registeredConstructor = constructor;
    }, LEADING_GAP_SAMPLE_RATE, LEADING_GAP_CURRENT_FRAME);
    const processorConstructor = requireProcessorConstructor(registeredConstructor);
    return Reflect.construct(processorConstructor, [ { processorOptions } ]) as ProcessorStateHarness;
}

function deliverFlush(
    processor: ProcessorHarness,
    generation: number,
    mediaTimeMicroseconds: number
): void {
    processor.port.deliver({ generation, mediaTimeMicroseconds, type: 'flush' });
}

function deliverChunk(
    processor: ProcessorHarness,
    generation: number,
    timestampMicroseconds: number,
    ...channelSamples: number[][]
): void {
    processor.port.deliver({
        channelData: channelSamples.map(samples => new Float32Array(samples)),
        generation,
        sequence: LEADING_GAP_CHUNK_SEQUENCE,
        timestampMicroseconds,
        type: 'enqueue'
    });
}

function setPlaying(processor: ProcessorHarness, playing: boolean): void {
    processor.port.deliver({ playing, type: 'playback' });
}

// A producer's chunks carry their own sequences, which the releases echo
const FIRST_PRODUCER_SEQUENCE = 1;
const SECOND_PRODUCER_SEQUENCE = 2;
const THIRD_PRODUCER_SEQUENCE = 3;
const PRODUCER_GENERATION = 2;
const NEXT_PRODUCER_GENERATION = 3;
const PRODUCER_LEASE_ID = 4;

/** Hands the processor a producer's end of its channel, as the page's attach-producer message does. */
function attachProducer(processor: ProcessorHarness, generation: number): MockProcessorPort {
    const producerPort = new MockProcessorPort();
    processor.port.deliver({ generation, port: producerPort, type: 'attach-producer' });
    return producerPort;
}

function deliverProducerChunk(
    producerPort: MockProcessorPort,
    generation: number,
    sequence: number,
    timestampMicroseconds: number,
    ...channelSamples: number[][]
): Float32Array[] {
    const channelData = channelSamples.map(samples => new Float32Array(samples));
    producerPort.deliver({ channelData, generation, sequence, timestampMicroseconds, type: 'enqueue' });
    return channelData;
}

function getPostedMessageTypes(port: MockProcessorPort): unknown[] {
    return port.postedMessages.map(message => (message as { type?: unknown }).type);
}

/** Renders one quantum on every processor channel and returns the samples. */
function renderQuantum(processor: ProcessorStateHarness): number[][] {
    const outputChannels: Float32Array[] = [];
    for (let channelIndex = 0; channelIndex < processor.channelCount; channelIndex += 1) {
        outputChannels.push(new Float32Array(LEADING_GAP_RENDER_FRAME_COUNT));
    }
    processor.process([], [ outputChannels ]);
    return outputChannels.map(outputChannel => Array.from(outputChannel));
}

describe('AudioWorkletProcessorSource', () => {
    it('executes bounded enqueue, render, overflow, flush, and underflow paths', () => {
        let registeredName = '';
        let Processor: ProcessorConstructor | null = null;
        const registerProcessor = (name: string, constructor: ProcessorConstructor): void => {
            registeredName = name;
            Processor = constructor;
        };
        evaluateWorkletModule(registerProcessor, 1_000, 10_000);

        expect(registeredName).toBe(CUSTOM_AUDIO_WORKLET_PROCESSOR_NAME);
        expect(getCustomAudioWorkletSource()).not.toContain('SharedArrayBuffer');
        const ProcessorConstructor = requireProcessorConstructor(Processor);
        const processor = Reflect.construct(ProcessorConstructor, [ {
            processorOptions: {
                channelCount: 2,
                maxBufferedFrames: 4,
                maxChunks: 2,
                telemetryIntervalFrames: 4
            }
        } ]) as ProcessorHarness;
        const acceptedChannelData = [
            new Float32Array([ 1, 2, 3, 4 ]),
            new Float32Array([ 5, 6, 7, 8 ])
        ];
        processor.port.deliver({
            channelData: acceptedChannelData,
            generation: 1,
            sequence: 1,
            timestampMicroseconds: -1_000_000,
            type: 'enqueue'
        });
        processor.port.deliver({
            channelData: [ new Float32Array([ 9 ]), new Float32Array([ 10 ]) ],
            generation: 1,
            sequence: 2,
            timestampMicroseconds: 0,
            type: 'enqueue'
        });
        processor.port.deliver({ playing: true, type: 'playback' });

        const firstOutput = [ new Float32Array(4), new Float32Array(4) ];
        expect(processor.process([], [ firstOutput ])).toBe(true);
        expect(Array.from(firstOutput[0])).toEqual([ 1, 2, 3, 4 ]);
        expect(Array.from(firstOutput[1])).toEqual([ 5, 6, 7, 8 ]);
        expect(processor.port.postedMessages).toContainEqual({
            channelBuffers: acceptedChannelData.map(channel => channel.buffer),
            type: 'recycle'
        });
        expect(processor.port.postedTransfers).toContainEqual(
            acceptedChannelData.map(channel => channel.buffer)
        );
        expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
            reason: 'periodic',
            signal: {
                analyzedFrameCount: 4,
                analyzedSampleCount: 8,
                clippedSampleCount: 7,
                nonFiniteSampleCount: 0,
                samplePeak: 8,
                sampleSquareSum: 204
            }
        }));
        expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
            hasPhysicalOutputTimeCorrelation: false,
            mediaTimeContextTimeMicroseconds: null,
            overflowEvents: 1,
            overflowFrames: 1,
            reason: 'overflow',
            sequence: 2
        }));

        const underflowOutput = [ new Float32Array(4).fill(12), new Float32Array(4).fill(12) ];
        processor.process([], [ underflowOutput ]);
        expect(Array.from(underflowOutput[0])).toEqual([ 0, 0, 0, 0 ]);
        expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
            hasPhysicalOutputTimeCorrelation: false,
            mediaTimeContextTimeMicroseconds: 10_004_000,
            mediaTimeMicroseconds: -996_000,
            reason: 'underflow',
            underflowEvents: 1,
            underflowFrames: 4
        }));

        processor.port.deliver({
            channelData: [ new Float32Array([ 9, 10, 11, 12 ]), new Float32Array([ 13, 14, 15, 16 ]) ],
            generation: 1,
            sequence: 3,
            timestampMicroseconds: 2_000_000,
            type: 'enqueue'
        });
        const recoveredOutput = [ new Float32Array(4), new Float32Array(4) ];
        processor.process([], [ recoveredOutput ]);
        expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
            mediaTimeMicroseconds: 2_004_000,
            queuedFrames: 0,
            reason: 'underflow-recovered'
        }));

        processor.port.deliver({
            generation: 2,
            mediaTimeMicroseconds: -5_000_000,
            type: 'flush'
        });
        expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
            generation: 2,
            hasPhysicalOutputTimeCorrelation: false,
            mediaTimeContextTimeMicroseconds: null,
            mediaTimeMicroseconds: -5_000_000,
            queuedFrames: 0,
            reason: 'flush',
            signal: {
                analyzedFrameCount: 0,
                analyzedSampleCount: 0,
                clippedSampleCount: 0,
                nonFiniteSampleCount: 0,
                samplePeak: 0,
                sampleSquareSum: 0
            }
        }));
    });

    it('measures the post-gain signal without counting underflow silence', () => {
        let Processor: ProcessorConstructor | null = null;
        evaluateWorkletModule((_name, constructor): void => {
            Processor = constructor;
        }, 1_000, 20_000);
        const ProcessorConstructor = requireProcessorConstructor(Processor);
        const processor = Reflect.construct(ProcessorConstructor, [ {
            processorOptions: {
                channelCount: 1,
                maxBufferedFrames: 4,
                maxChunks: 2,
                telemetryIntervalFrames: 2
            }
        } ]) as ProcessorHarness;
        processor.port.deliver({ muted: false, type: 'gain', volume: 2 });
        processor.port.deliver({
            channelData: [ new Float32Array([ 0.25, -0.25 ]) ],
            generation: 1,
            sequence: 1,
            timestampMicroseconds: 0,
            type: 'enqueue'
        });
        processor.port.deliver({ playing: true, type: 'playback' });

        const output = [ new Float32Array(4) ];
        processor.process([], [ output ]);

        expect(Array.from(output[0])).toEqual([ 0.5, -0.5, 0, 0 ]);
        expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
            reason: 'underflow',
            signal: {
                analyzedFrameCount: 2,
                analyzedSampleCount: 2,
                clippedSampleCount: 0,
                nonFiniteSampleCount: 0,
                samplePeak: 0.5,
                sampleSquareSum: 0.5
            },
            underflowFrames: 2
        }));
    });

    it('correlates media time to the exact sample before a partial underflow', () => {
        let Processor: ProcessorConstructor | null = null;
        evaluateWorkletModule((_name, constructor): void => {
            Processor = constructor;
        }, 1_000, 20_000);
        const ProcessorConstructor = requireProcessorConstructor(Processor);
        const processor = Reflect.construct(ProcessorConstructor, [ {
            processorOptions: {
                channelCount: 1,
                maxBufferedFrames: 4,
                maxChunks: 2,
                telemetryIntervalFrames: 4
            }
        } ]) as ProcessorHarness;
        processor.port.deliver({
            channelData: [ new Float32Array([ 1, 2 ]) ],
            generation: 1,
            sequence: 1,
            timestampMicroseconds: 3_000_000,
            type: 'enqueue'
        });
        processor.port.deliver({ playing: true, type: 'playback' });

        processor.process([], [ [ new Float32Array(4) ] ]);

        expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
            hasPhysicalOutputTimeCorrelation: false,
            mediaTimeContextTimeMicroseconds: 20_002_000,
            mediaTimeMicroseconds: 3_002_000,
            reason: 'underflow',
            underflowFrames: 2
        }));
    });

    it('deactivates one lease while keeping a reset processor alive', () => {
        let Processor: ProcessorConstructor | null = null;
        evaluateWorkletModule((_name, constructor): void => {
            Processor = constructor;
        }, 1_000, 30_000);
        const ProcessorConstructor = requireProcessorConstructor(Processor);
        const processor = Reflect.construct(ProcessorConstructor, [ {
            processorOptions: {
                channelCount: 1,
                maxBufferedFrames: 8,
                maxChunks: 2,
                telemetryIntervalFrames: 4
            }
        } ]) as ProcessorStateHarness;
        processor.port.deliver({
            channelData: [ new Float32Array([ 1, 2, 3, 4 ]) ],
            generation: 1,
            sequence: 1,
            timestampMicroseconds: 1_000_000,
            type: 'enqueue'
        });
        processor.port.deliver({ muted: true, type: 'gain', volume: 0.25 });
        processor.port.deliver({ playing: true, type: 'playback' });
        processor.process([], [ [ new Float32Array(4) ] ]);
        processor.port.deliver({
            channelData: [ new Float32Array([ 9, 10 ]) ],
            generation: 1,
            sequence: 99,
            timestampMicroseconds: 1_004_000,
            type: 'enqueue'
        });

        processor.port.deliver({ generation: 2, leaseId: 0, type: 'deactivate' });
        processor.port.deliver({ generation: 1, leaseId: 18, type: 'deactivate' });
        expect(processor.chunkCount).toBe(1);
        expect(processor.playing).toBe(true);
        expect(processor.port.postedMessages).not.toContainEqual(expect.objectContaining({
            type: 'deactivated'
        }));

        processor.port.deliver({ generation: 2, leaseId: 17, type: 'deactivate' });
        expect(processor.port.postedMessages).toContainEqual({
            leaseId: 17,
            type: 'deactivated'
        });
        expect(processor).toMatchObject({
            chunkCount: 0,
            consumedFrames: 0,
            droppedFrames: 0,
            framesSinceTelemetry: 0,
            generation: 2,
            headChunkIndex: 0,
            mediaTimeContextTimeMicroseconds: null,
            mediaTimeMicroseconds: 0,
            muted: false,
            outputFrames: 0,
            overflowEvents: 0,
            overflowFrames: 0,
            playing: false,
            queuedFrames: 0,
            staleChunks: 0,
            tailChunkIndex: 0,
            underflowActive: false,
            underflowEvents: 0,
            underflowFrames: 0,
            volume: 1
        });
        expect(processor.chunks.every((chunk): boolean => chunk === undefined)).toBe(true);
        expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
            type: 'recycle'
        }));
        const idleOutput = [ new Float32Array(4).fill(12) ];
        expect(processor.process([], [ idleOutput ])).toBe(true);
        expect(Array.from(idleOutput[0])).toEqual([ 0, 0, 0, 0 ]);

        processor.port.deliver({
            channelData: [ new Float32Array([ 5, 6, 7, 8 ]) ],
            generation: 2,
            sequence: 2,
            timestampMicroseconds: 2_000_000,
            type: 'enqueue'
        });
        processor.port.deliver({ playing: true, type: 'playback' });
        const resumedOutput = [ new Float32Array(4) ];
        expect(processor.process([], [ resumedOutput ])).toBe(true);
        expect(Array.from(resumedOutput[0])).toEqual([ 5, 6, 7, 8 ]);
        expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
            consumedFrames: 4,
            droppedFrames: 0,
            mediaTimeMicroseconds: 2_004_000,
            muted: false,
            outputFrames: 4,
            overflowEvents: 0,
            reason: 'periodic',
            staleChunks: 0,
            underflowEvents: 0,
            volume: 1
        }));
    });

    it('acknowledges retirement from the final render quantum', () => {
        let Processor: ProcessorConstructor | null = null;
        evaluateWorkletModule((_name, constructor): void => {
            Processor = constructor;
        }, 48_000, 0);
        const ProcessorConstructor = requireProcessorConstructor(Processor);
        const processor = Reflect.construct(ProcessorConstructor, [ {
            processorOptions: {
                channelCount: 2,
                maxBufferedFrames: 8,
                maxChunks: 2,
                telemetryIntervalFrames: 4
            }
        } ]) as ProcessorHarness;

        processor.port.deliver({ type: 'destroy' });
        expect(processor.port.postedMessages).not.toContainEqual({ type: 'retired' });

        expect(processor.process([], [
            [ new Float32Array(4), new Float32Array(4) ]
        ])).toBe(false);
        expect(processor.port.postedMessages).toContainEqual({ type: 'retired' });
        expect(processor.port.closeCount).toBe(1);
    });

    describe('leading gap', () => {
        it('renders silence from the flush position to the first chunk timestamp', () => {
            const processor = createLeadingGapProcessor();
            deliverFlush(processor, 2, 0);
            deliverChunk(processor, 2, 6_000, [ 1, 2, 3, 4 ]);
            deliverChunk(processor, 2, 10_000, [ 5, 6 ]);
            setPlaying(processor, true);

            expect(renderQuantum(processor)).toEqual([ [ 0, 0, 0, 0 ] ]);
            expect(processor.port.postedMessages.at(-1)).toMatchObject({
                consumedFrames: 0,
                mediaTimeContextTimeMicroseconds: 40_004_000,
                mediaTimeMicroseconds: 4_000,
                queuedFrames: 6,
                reason: 'periodic',
                underflowEvents: 0,
                underflowFrames: 0
            });

            expect(renderQuantum(processor)).toEqual([ [ 0, 0, 1, 2 ] ]);
            expect(processor.port.postedMessages.at(-1)).toMatchObject({
                consumedFrames: 2,
                mediaTimeContextTimeMicroseconds: 40_004_000,
                mediaTimeMicroseconds: 8_000,
                queuedFrames: 4,
                reason: 'periodic',
                underflowFrames: 0
            });

            // The contiguous second chunk follows without a gap of its own
            expect(renderQuantum(processor)).toEqual([ [ 3, 4, 5, 6 ] ]);
            expect(processor.port.postedMessages.at(-1)).toMatchObject({
                consumedFrames: 6,
                mediaTimeMicroseconds: 12_000,
                queuedFrames: 0,
                reason: 'periodic',
                underflowFrames: 0
            });
            expect(processor.port.postedMessages).not.toContainEqual(expect.objectContaining({
                reason: 'underflow'
            }));
        });

        it('holds the leading gap while playback is paused', () => {
            const processor = createLeadingGapProcessor();
            deliverFlush(processor, 2, 0);
            deliverChunk(processor, 2, 6_000, [ 1, 2, 3, 4 ]);
            setPlaying(processor, true);
            expect(renderQuantum(processor)).toEqual([ [ 0, 0, 0, 0 ] ]);

            setPlaying(processor, false);
            expect(renderQuantum(processor)).toEqual([ [ 0, 0, 0, 0 ] ]);
            expect(processor).toMatchObject({
                consumedFrames: 0,
                leadingGapFrames: 2,
                leadingGapRenderedFrames: 4,
                mediaTimeMicroseconds: 4_000,
                outputFrames: 4
            });

            setPlaying(processor, true);
            expect(renderQuantum(processor)).toEqual([ [ 0, 0, 1, 2 ] ]);
            expect(processor.port.postedMessages.at(-1)).toMatchObject({
                consumedFrames: 2,
                mediaTimeMicroseconds: 8_000,
                outputFrames: 8,
                reason: 'periodic'
            });
        });

        it('plays a first chunk at or before the flush position without a gap', () => {
            const processor = createLeadingGapProcessor();
            setPlaying(processor, true);

            deliverFlush(processor, 2, 6_000);
            deliverChunk(processor, 2, 5_000, [ 1, 2, 3, 4 ]);
            expect(renderQuantum(processor)).toEqual([ [ 1, 2, 3, 4 ] ]);
            expect(processor.port.postedMessages.at(-1)).toMatchObject({
                consumedFrames: 4,
                mediaTimeMicroseconds: 9_000,
                reason: 'periodic'
            });

            deliverFlush(processor, 3, 20_000);
            deliverChunk(processor, 3, 20_000, [ 5, 6, 7, 8 ]);
            expect(renderQuantum(processor)).toEqual([ [ 5, 6, 7, 8 ] ]);
            expect(processor.port.postedMessages.at(-1)).toMatchObject({
                consumedFrames: 8,
                mediaTimeMicroseconds: 24_000,
                reason: 'periodic'
            });

            // Less than half a frame after the flush position rounds to no gap
            deliverFlush(processor, 4, 30_000);
            deliverChunk(processor, 4, 30_400, [ 9, 10, 11, 12 ]);
            expect(renderQuantum(processor)).toEqual([ [ 9, 10, 11, 12 ] ]);
            expect(processor.port.postedMessages).not.toContainEqual(expect.objectContaining({
                reason: 'underflow'
            }));
        });

        it('discards an unfinished leading gap on the next flush', () => {
            const processor = createLeadingGapProcessor();
            deliverFlush(processor, 2, 0);
            deliverChunk(processor, 2, 6_000, [ 1, 2, 3, 4 ]);
            setPlaying(processor, true);
            expect(renderQuantum(processor)).toEqual([ [ 0, 0, 0, 0 ] ]);

            deliverFlush(processor, 3, 10_000);
            expect(processor).toMatchObject({
                chunkCount: 0,
                leadingGapFrames: 0,
                leadingGapPending: true,
                leadingGapRenderedFrames: 0,
                leadingGapStartMicroseconds: 10_000,
                mediaTimeMicroseconds: 10_000
            });

            // The new gap is measured from the new flush position
            deliverChunk(processor, 3, 12_000, [ 5, 6, 7, 8 ]);
            expect(renderQuantum(processor)).toEqual([ [ 0, 0, 5, 6 ] ]);
            expect(processor.port.postedMessages.at(-1)).toMatchObject({
                consumedFrames: 2,
                mediaTimeMicroseconds: 14_000,
                reason: 'periodic'
            });
        });

        it('clears an active or pending leading gap on deactivate', () => {
            const processor = createLeadingGapProcessor();
            deliverFlush(processor, 2, 0);
            deliverChunk(processor, 2, 6_000, [ 1, 2, 3, 4 ]);
            setPlaying(processor, true);
            expect(renderQuantum(processor)).toEqual([ [ 0, 0, 0, 0 ] ]);

            processor.port.deliver({ generation: 3, leaseId: 1, type: 'deactivate' });
            expect(processor).toMatchObject({
                leadingGapFrames: 0,
                leadingGapPending: false,
                leadingGapRenderedFrames: 0,
                leadingGapStartMicroseconds: 0
            });

            deliverFlush(processor, 4, 0);
            processor.port.deliver({ generation: 5, leaseId: 2, type: 'deactivate' });
            expect(processor.leadingGapPending).toBe(false);

            deliverChunk(processor, 5, 50_000, [ 5, 6, 7, 8 ]);
            setPlaying(processor, true);
            expect(renderQuantum(processor)).toEqual([ [ 5, 6, 7, 8 ] ]);
            expect(processor.port.postedMessages.at(-1)).toMatchObject({
                consumedFrames: 4,
                mediaTimeMicroseconds: 54_000,
                reason: 'periodic'
            });
        });

        it('excludes the silent prefix from signal statistics', () => {
            const processor = createLeadingGapProcessor({
                ...LEADING_GAP_PROCESSOR_OPTIONS,
                channelCount: 2
            });
            deliverFlush(processor, 2, 0);
            deliverChunk(processor, 2, 6_000, [ 0.5, -0.25 ], [ 0.75, 0.125 ]);
            setPlaying(processor, true);

            expect(renderQuantum(processor)).toEqual([ [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ] ]);
            expect(processor.port.postedMessages.at(-1)).toMatchObject({
                reason: 'periodic',
                signal: {
                    analyzedFrameCount: 0,
                    analyzedSampleCount: 0,
                    clippedSampleCount: 0,
                    nonFiniteSampleCount: 0,
                    samplePeak: 0,
                    sampleSquareSum: 0
                }
            });

            expect(renderQuantum(processor)).toEqual([ [ 0, 0, 0.5, -0.25 ], [ 0, 0, 0.75, 0.125 ] ]);
            expect(processor.port.postedMessages.at(-1)).toMatchObject({
                reason: 'periodic',
                signal: {
                    analyzedFrameCount: 2,
                    analyzedSampleCount: 4,
                    clippedSampleCount: 0,
                    nonFiniteSampleCount: 0,
                    samplePeak: 0.75,
                    sampleSquareSum: 0.890625
                },
                underflowFrames: 0
            });
        });
    });

    describe('producer channel', () => {
        it('plays a producer chunk and returns it to the producer with its buffers once played', () => {
            const processor = createLeadingGapProcessor();
            deliverFlush(processor, PRODUCER_GENERATION, 0);
            const producerPort = attachProducer(processor, PRODUCER_GENERATION);
            const channelData = deliverProducerChunk(producerPort, PRODUCER_GENERATION, FIRST_PRODUCER_SEQUENCE, 0, [ 1, 2, 3, 4 ]);
            setPlaying(processor, true);

            expect(renderQuantum(processor)).toEqual([ [ 1, 2, 3, 4 ] ]);

            expect(producerPort.postedMessages).toEqual([ {
                channelBuffers: [ channelData[0].buffer ],
                reason: 'consumed',
                sequence: FIRST_PRODUCER_SEQUENCE,
                type: 'released'
            } ]);
            expect(producerPort.postedTransfers).toEqual([ [ channelData[0].buffer ] ]);
            // The page keeps its telemetry and gets no PCM back
            expect(getPostedMessageTypes(processor.port)).not.toContain('recycle');
            expect(processor.port.postedMessages.at(-1)).toMatchObject({
                consumedFrames: 4,
                generation: PRODUCER_GENERATION,
                reason: 'periodic'
            });
        });

        it('returns a rejected producer chunk at once with the reason it was dropped', () => {
            const processor = createLeadingGapProcessor();
            deliverFlush(processor, PRODUCER_GENERATION, 0);
            const producerPort = attachProducer(processor, PRODUCER_GENERATION);

            deliverProducerChunk(producerPort, PRODUCER_GENERATION, FIRST_PRODUCER_SEQUENCE, 0, [ 1, 2, 3, 4, 5, 6, 7, 8 ]);
            // The queue holds eight frames, so one more overflows it
            deliverProducerChunk(producerPort, PRODUCER_GENERATION, SECOND_PRODUCER_SEQUENCE, 8_000, [ 9 ]);
            deliverProducerChunk(producerPort, PRODUCER_GENERATION, THIRD_PRODUCER_SEQUENCE, 8_000, [ 9 ], [ 10 ]);

            expect(producerPort.postedMessages).toEqual([
                expect.objectContaining({ reason: 'overflow', sequence: SECOND_PRODUCER_SEQUENCE, type: 'released' }),
                expect.objectContaining({ reason: 'invalid', sequence: THIRD_PRODUCER_SEQUENCE, type: 'released' })
            ]);
            expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
                generation: PRODUCER_GENERATION,
                reason: 'overflow',
                sequence: SECOND_PRODUCER_SEQUENCE
            }));
        });

        it('returns a producer chunk of another generation as stale', () => {
            const processor = createLeadingGapProcessor();
            deliverFlush(processor, PRODUCER_GENERATION, 0);
            const producerPort = attachProducer(processor, PRODUCER_GENERATION);

            deliverProducerChunk(producerPort, NEXT_PRODUCER_GENERATION, FIRST_PRODUCER_SEQUENCE, 0, [ 1 ]);

            expect(producerPort.postedMessages).toEqual([
                expect.objectContaining({ reason: 'stale-generation', sequence: FIRST_PRODUCER_SEQUENCE, type: 'released' })
            ]);
            expect(processor).toMatchObject({ chunkCount: 0, staleChunks: 1 });
        });

        it('detaches the producer on flush and drops its queued and later chunks', () => {
            const processor = createLeadingGapProcessor();
            deliverFlush(processor, PRODUCER_GENERATION, 0);
            const producerPort = attachProducer(processor, PRODUCER_GENERATION);
            deliverProducerChunk(producerPort, PRODUCER_GENERATION, FIRST_PRODUCER_SEQUENCE, 0, [ 1, 2, 3, 4 ]);

            deliverFlush(processor, NEXT_PRODUCER_GENERATION, 0);

            expect(producerPort.closeCount).toBe(1);
            expect(producerPort.onmessage).toBeNull();
            // The queued chunk belonged to the replaced generation, whose producer is gone
            expect(producerPort.postedMessages).toEqual([]);
            expect(getPostedMessageTypes(processor.port)).not.toContain('recycle');
            deliverProducerChunk(producerPort, NEXT_PRODUCER_GENERATION, SECOND_PRODUCER_SEQUENCE, 0, [ 5, 6, 7, 8 ]);
            expect(processor).toMatchObject({ chunkCount: 0, queuedFrames: 0 });
        });

        it('closes an attachment that a later flush overtook and takes the current one', () => {
            const processor = createLeadingGapProcessor();
            deliverFlush(processor, PRODUCER_GENERATION, 0);
            deliverFlush(processor, NEXT_PRODUCER_GENERATION, 0);

            const staleProducerPort = attachProducer(processor, PRODUCER_GENERATION);
            expect(staleProducerPort.closeCount).toBe(1);
            expect(staleProducerPort.onmessage).toBeNull();

            const currentProducerPort = attachProducer(processor, NEXT_PRODUCER_GENERATION);
            deliverProducerChunk(currentProducerPort, NEXT_PRODUCER_GENERATION, FIRST_PRODUCER_SEQUENCE, 0, [ 1, 2, 3, 4 ]);
            expect(processor).toMatchObject({ chunkCount: 1, queuedFrames: 4 });
        });

        it('replaces an attached producer with the next attachment of the generation', () => {
            const processor = createLeadingGapProcessor();
            deliverFlush(processor, PRODUCER_GENERATION, 0);
            const firstProducerPort = attachProducer(processor, PRODUCER_GENERATION);
            const secondProducerPort = attachProducer(processor, PRODUCER_GENERATION);

            expect(firstProducerPort.closeCount).toBe(1);
            deliverProducerChunk(firstProducerPort, PRODUCER_GENERATION, FIRST_PRODUCER_SEQUENCE, 0, [ 1 ]);
            deliverProducerChunk(secondProducerPort, PRODUCER_GENERATION, FIRST_PRODUCER_SEQUENCE, 0, [ 2 ]);
            expect(processor).toMatchObject({ chunkCount: 1, queuedFrames: 1 });
        });

        it('ignores an attachment without a port and detaches the producer on deactivate and destroy', () => {
            const processor = createLeadingGapProcessor();
            deliverFlush(processor, PRODUCER_GENERATION, 0);
            processor.port.deliver({ generation: PRODUCER_GENERATION, port: {}, type: 'attach-producer' });
            expect(processor.port.postedMessages.at(-1)).toMatchObject({ reason: 'flush' });

            const deactivatedProducerPort = attachProducer(processor, PRODUCER_GENERATION);
            processor.port.deliver({ generation: NEXT_PRODUCER_GENERATION, leaseId: PRODUCER_LEASE_ID, type: 'deactivate' });
            expect(deactivatedProducerPort.closeCount).toBe(1);

            const destroyedProducerPort = attachProducer(processor, NEXT_PRODUCER_GENERATION);
            processor.port.deliver({ type: 'destroy' });
            expect(destroyedProducerPort.closeCount).toBe(1);
            expect(destroyedProducerPort.onmessage).toBeNull();
        });
    });
});
