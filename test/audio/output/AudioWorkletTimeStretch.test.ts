import { describe, expect, it } from 'vitest';

import { getCustomAudioWorkletSource } from 'webgpu-player/audio/output/AudioWorkletProcessorSource';

type WorkletMessageEvent = { data: unknown };

class MockProcessorPort {
    public onmessage: ((event: WorkletMessageEvent) => void) | null = null;
    public readonly postedMessages: unknown[] = [];

    public postMessage(message: unknown): void {
        this.postedMessages.push(message);
    }

    public close(): void {
        // The processor closes its port only on retirement
    }

    public deliver(message: unknown): void {
        this.onmessage?.({ data: message });
    }
}

class MockAudioWorkletProcessor {
    public readonly port = new MockProcessorPort();
}

type StretchProcessor = MockAudioWorkletProcessor & {
    playbackRate: number
    process: (inputs: readonly unknown[], outputs: readonly Float32Array[][]) => boolean
    stretcher: { active: boolean }
};

type ProcessorConstructor = new (options: {
    processorOptions: {
        channelCount: number
        maxBufferedFrames: number
        maxChunks: number
        telemetryIntervalFrames: number
    }
}) => StretchProcessor;

type WorkletModuleEvaluator = (
    processorBase: typeof MockAudioWorkletProcessor,
    registerProcessor: (name: string, constructor: ProcessorConstructor) => void,
    sampleRate: number,
    currentFrame: number
) => void;

type Telemetry = {
    consumedFrames: number
    mediaTimeMicroseconds: number
    playbackRate: number
    queuedFrames: number
    reason: string
    type: 'telemetry'
    underflowEvents: number
    underflowFrames: number
    outputFrames: number
};

const SAMPLE_RATE = 48_000;
const MICROSECONDS_PER_SECOND = 1_000_000;
const RENDER_QUANTUM_FRAMES = 128;
// The decode worker's shortest chunk, eight of them in flight as its credits allow
const CHUNK_FRAME_COUNT = 1_920;
const CHUNKS_IN_FLIGHT = 8;
const GENERATION = 2;
const CHANNEL_COUNT = 2;
const SINE_FREQUENCY = 440;
const SINE_AMPLITUDE = 0.5;
// The overlap-add window, 20 ms at 48 kHz
const WINDOW_FRAMES = 960;
const MEDIA_TIME_TOLERANCE_MICROSECONDS = 25_000;
// One second of output
const STRETCH_QUANTUM_COUNT = 375;
const SAMPLE_STEP_TOLERANCE = 1e-6;

function requireProcessorConstructor(constructor: ProcessorConstructor | null): ProcessorConstructor {
    if (!constructor) {
        throw new Error('Worklet processor was not registered');
    }
    return constructor;
}

function createProcessor(channelCount = CHANNEL_COUNT): StretchProcessor {
    let registeredConstructor: ProcessorConstructor | null = null;
    // eslint-disable-next-line sonarjs/code-eval -- Validates the generated standalone module
    const evaluateModule = Function(
        'AudioWorkletProcessor',
        'registerProcessor',
        'sampleRate',
        'currentFrame',
        getCustomAudioWorkletSource()
    ) as WorkletModuleEvaluator;
    evaluateModule(MockAudioWorkletProcessor, (_name, constructor): void => {
        registeredConstructor = constructor;
    }, SAMPLE_RATE, 0);
    const processor: StretchProcessor = Reflect.construct(requireProcessorConstructor(registeredConstructor), [ {
        processorOptions: {
            channelCount,
            maxBufferedFrames: SAMPLE_RATE * 2,
            maxChunks: 1_024,
            // One periodic report closes every render quantum
            telemetryIntervalFrames: RENDER_QUANTUM_FRAMES
        }
    } ]);
    processor.port.deliver({ generation: GENERATION, mediaTimeMicroseconds: 0, type: 'flush' });
    processor.port.deliver({ playing: true, type: 'playback' });
    return processor;
}

function getMessageType(message: unknown): unknown {
    return typeof message === 'object' && message !== null && 'type' in message ? message.type : undefined;
}

function isTelemetry(message: unknown): message is Telemetry {
    return getMessageType(message) === 'telemetry';
}

function setPlaybackRate(processor: StretchProcessor, playbackRate: unknown): void {
    processor.port.deliver({ playbackRate, type: 'rate' });
}

function getSineSample(channelIndex: number, frameIndex: number): number {
    return Math.fround(SINE_AMPLITUDE * Math.sin((2 * Math.PI * SINE_FREQUENCY * frameIndex) / SAMPLE_RATE + channelIndex));
}

/** Feeds a sine as the decode worker does: whole chunks, as many in flight as its credits allow. */
class SineFeeder {
    public fedFrames = 0;

    public constructor(
        private readonly processor: StretchProcessor,
        private readonly totalFrames: number,
        private readonly channelCount = CHANNEL_COUNT
    ) {}

    public get largestSampleStep(): number {
        return 2 * SINE_AMPLITUDE * Math.sin((Math.PI * SINE_FREQUENCY) / SAMPLE_RATE);
    }

    public fill(): void {
        while (this.fedFrames < this.totalFrames
            && this.fedFrames < this.getReleasedFrames() + CHUNKS_IN_FLIGHT * CHUNK_FRAME_COUNT) {
            const channelData: Float32Array[] = [];
            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                const channel = new Float32Array(CHUNK_FRAME_COUNT);
                for (let frameIndex = 0; frameIndex < CHUNK_FRAME_COUNT; frameIndex += 1) {
                    channel[frameIndex] = getSineSample(channelIndex, this.fedFrames + frameIndex);
                }
                channelData.push(channel);
            }
            this.processor.port.deliver({
                channelData,
                generation: GENERATION,
                sequence: 1,
                timestampMicroseconds: (this.fedFrames * MICROSECONDS_PER_SECOND) / SAMPLE_RATE,
                type: 'enqueue'
            });
            this.fedFrames += CHUNK_FRAME_COUNT;
        }
    }

    private getReleasedFrames(): number {
        const releasedChunkCount = this.processor.port.postedMessages
            .filter((message): boolean => getMessageType(message) === 'recycle')
            .length;
        return releasedChunkCount * CHUNK_FRAME_COUNT;
    }
}

type RenderedQuantum = {
    fedFrames: number
    samples: Float32Array
    telemetry: Telemetry
};

/** Renders one quantum after topping up the input, and returns its first channel and the report that closed it. */
function renderQuantum(processor: StretchProcessor, feeder: SineFeeder, channelCount = CHANNEL_COUNT): RenderedQuantum {
    feeder.fill();
    const outputChannels: Float32Array[] = [];
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        outputChannels.push(new Float32Array(RENDER_QUANTUM_FRAMES));
    }
    processor.process([], [ outputChannels ]);
    const telemetry = getTelemetry(processor).filter((message): boolean => message.reason === 'periodic').at(-1);
    if (!telemetry) {
        throw new Error('The quantum closed without a periodic report');
    }
    return { fedFrames: feeder.fedFrames, samples: outputChannels[0], telemetry };
}

function getTelemetry(processor: StretchProcessor): Telemetry[] {
    return processor.port.postedMessages.filter(isTelemetry);
}

/** The media time of the input the output has consumed: what was fed, less what has not been rendered. */
function getConsumedMediaTimeMicroseconds(quantum: RenderedQuantum): number {
    return ((quantum.fedFrames - quantum.telemetry.queuedFrames) * MICROSECONDS_PER_SECOND) / SAMPLE_RATE;
}

function getLargestStep(samples: Float32Array): number {
    let largestStep = 0;
    for (let frameIndex = 1; frameIndex < samples.length; frameIndex += 1) {
        largestStep = Math.max(largestStep, Math.abs(samples[frameIndex] - samples[frameIndex - 1]));
    }
    return largestStep;
}

function joinSamples(quanta: readonly RenderedQuantum[]): Float32Array {
    const samples = new Float32Array(quanta.length * RENDER_QUANTUM_FRAMES);
    quanta.forEach((quantum, quantumIndex): void => {
        samples.set(quantum.samples, quantumIndex * RENDER_QUANTUM_FRAMES);
    });
    return samples;
}

/** Estimates a tone's frequency from its zero crossings. */
function getZeroCrossingFrequency(samples: Float32Array): number {
    let crossingCount = 0;
    for (let frameIndex = 1; frameIndex < samples.length; frameIndex += 1) {
        if ((samples[frameIndex - 1] < 0) !== (samples[frameIndex] < 0)) {
            crossingCount += 1;
        }
    }
    return crossingCount / 2 / (samples.length / SAMPLE_RATE);
}

describe('AudioWorkletProcessorSource time-stretching', () => {
    it.each([ 0.5, 1.5, 2, 4 ])('stretches a sine at rate %s, keeping its pitch and level', playbackRate => {
        const processor = createProcessor();
        const feeder = new SineFeeder(processor, Number.POSITIVE_INFINITY);
        setPlaybackRate(processor, playbackRate);

        const quanta: RenderedQuantum[] = [];
        for (let quantumIndex = 0; quantumIndex < STRETCH_QUANTUM_COUNT; quantumIndex += 1) {
            quanta.push(renderQuantum(processor, feeder));
        }

        const lastQuantum = quanta[quanta.length - 1];
        const renderedFrameCount = STRETCH_QUANTUM_COUNT * RENDER_QUANTUM_FRAMES;
        const consumedFrameCount = lastQuantum.fedFrames - lastQuantum.telemetry.queuedFrames;
        expect(Math.abs(consumedFrameCount - renderedFrameCount * playbackRate)).toBeLessThanOrEqual(WINDOW_FRAMES);
        expect(lastQuantum.telemetry).toMatchObject({ playbackRate, underflowEvents: 0 });

        const samples = joinSamples(quanta);
        expect(samples.every((sample): boolean => Number.isFinite(sample))).toBe(true);
        const peak = samples.reduce((largest, sample): number => Math.max(largest, Math.abs(sample)), 0);
        expect(peak).toBeLessThanOrEqual(SINE_AMPLITUDE * 1.01);
        // The first window fades the stretcher in, so the pitch is measured after it
        const frequency = getZeroCrossingFrequency(samples.subarray(2 * WINDOW_FRAMES));
        expect(Math.abs(frequency - SINE_FREQUENCY)).toBeLessThanOrEqual(SINE_FREQUENCY * 0.01);
    });

    it('keeps media time on the stretched input across rate changes, without clicks, and returns to sample-exact output', () => {
        const processor = createProcessor();
        const feeder = new SineFeeder(processor, Number.POSITIVE_INFINITY);
        // Quantum indices at which the rate changes: 1, then 2, 0.5, and 1 again
        const rateChanges = new Map([ [ 100, 2 ], [ 300, 0.5 ], [ 500, 1 ] ]);
        const quanta: RenderedQuantum[] = [];
        for (let quantumIndex = 0; quantumIndex < 700; quantumIndex += 1) {
            const playbackRate = rateChanges.get(quantumIndex);
            if (playbackRate !== undefined) {
                setPlaybackRate(processor, playbackRate);
            }
            const quantum = renderQuantum(processor, feeder);
            quanta.push(quantum);
            if (quantumIndex > 0) {
                const previousTelemetry = quanta[quantumIndex - 1].telemetry;
                const nominalAdvance = (RENDER_QUANTUM_FRAMES * previousTelemetry.playbackRate * MICROSECONDS_PER_SECOND) / SAMPLE_RATE;
                const mediaAdvance = quantum.telemetry.mediaTimeMicroseconds - previousTelemetry.mediaTimeMicroseconds;
                expect(Math.abs(mediaAdvance - nominalAdvance)).toBeLessThanOrEqual(MEDIA_TIME_TOLERANCE_MICROSECONDS);
            }
            expect(Math.abs(quantum.telemetry.mediaTimeMicroseconds - getConsumedMediaTimeMicroseconds(quantum)))
                .toBeLessThanOrEqual(MEDIA_TIME_TOLERANCE_MICROSECONDS);
        }

        // Within each rate, media time advances by the rate times the output's duration
        for (const [ startQuantumIndex, endQuantumIndex, playbackRate ] of [ [ 110, 290, 2 ], [ 310, 490, 0.5 ] ]) {
            const startTelemetry = quanta[startQuantumIndex].telemetry;
            const endTelemetry = quanta[endQuantumIndex].telemetry;
            const outputMicroseconds = ((endQuantumIndex - startQuantumIndex) * RENDER_QUANTUM_FRAMES * MICROSECONDS_PER_SECOND) / SAMPLE_RATE;
            expect(Math.abs(endTelemetry.mediaTimeMicroseconds - startTelemetry.mediaTimeMicroseconds - playbackRate * outputMicroseconds))
                .toBeLessThanOrEqual(MEDIA_TIME_TOLERANCE_MICROSECONDS);
            expect(endTelemetry.playbackRate).toBe(playbackRate);
        }

        // Neither switch adds a step the sine does not have
        expect(getLargestStep(joinSamples(quanta))).toBeLessThanOrEqual(feeder.largestSampleStep + SAMPLE_STEP_TOLERANCE);
        expect(getTelemetry(processor).some((message): boolean => message.reason === 'underflow')).toBe(false);

        // Once the stretcher drains at rate 1, every frame is the input's own
        expect(processor.stretcher.active).toBe(false);
        const lastQuantum = quanta[quanta.length - 1];
        const endFrameIndex = Math.round((lastQuantum.telemetry.mediaTimeMicroseconds * SAMPLE_RATE) / MICROSECONDS_PER_SECOND);
        const expectedSamples = Array.from(
            { length: RENDER_QUANTUM_FRAMES },
            (_value, frameOffset): number => getSineSample(0, endFrameIndex - RENDER_QUANTUM_FRAMES + frameOffset)
        );
        expect(Array.from(lastQuantum.samples)).toEqual(expectedSamples);
        expect(lastQuantum.telemetry.playbackRate).toBe(1);
    });

    it('plays the stretcher\'s buffered input before it reports an underflow, and restarts stretching on new input', () => {
        const processor = createProcessor();
        const inputFrameCount = 5 * CHUNK_FRAME_COUNT;
        const feeder = new SineFeeder(processor, inputFrameCount);
        setPlaybackRate(processor, 2);

        let underflowTelemetry: Telemetry | undefined;
        for (let quantumIndex = 0; quantumIndex < 100 && !underflowTelemetry; quantumIndex += 1) {
            renderQuantum(processor, feeder);
            underflowTelemetry = getTelemetry(processor).find((message): boolean => message.reason === 'underflow');
        }

        // Every input frame played, the last of them raw, before the quantum underflowed
        if (!underflowTelemetry) {
            throw new Error('The processor never underflowed');
        }
        expect(underflowTelemetry).toMatchObject({
            consumedFrames: inputFrameCount,
            mediaTimeMicroseconds: (inputFrameCount * MICROSECONDS_PER_SECOND) / SAMPLE_RATE,
            playbackRate: 1,
            queuedFrames: 0
        });
        const renderedFrameCount = underflowTelemetry.outputFrames + RENDER_QUANTUM_FRAMES - underflowTelemetry.underflowFrames;
        expect(renderedFrameCount).toBeGreaterThan(inputFrameCount / 2);
        expect(renderedFrameCount).toBeLessThan(inputFrameCount);
        expect(processor.stretcher.active).toBe(false);

        const resumedFeeder = new SineFeeder(processor, Number.POSITIVE_INFINITY);
        resumedFeeder.fedFrames = inputFrameCount;
        const resumedQuanta: RenderedQuantum[] = [];
        for (let quantumIndex = 0; quantumIndex < 40; quantumIndex += 1) {
            resumedQuanta.push(renderQuantum(processor, resumedFeeder));
        }
        expect(getTelemetry(processor).some((message): boolean => message.reason === 'underflow-recovered')).toBe(true);
        const firstTelemetry = resumedQuanta[10].telemetry;
        const lastTelemetry = resumedQuanta[resumedQuanta.length - 1].telemetry;
        const outputMicroseconds = (29 * RENDER_QUANTUM_FRAMES * MICROSECONDS_PER_SECOND) / SAMPLE_RATE;
        expect(lastTelemetry.playbackRate).toBe(2);
        expect(Math.abs(lastTelemetry.mediaTimeMicroseconds - firstTelemetry.mediaTimeMicroseconds - 2 * outputMicroseconds))
            .toBeLessThanOrEqual(MEDIA_TIME_TOLERANCE_MICROSECONDS);
        expect(getLargestStep(joinSamples(resumedQuanta.slice(1)))).toBeLessThanOrEqual(
            resumedFeeder.largestSampleStep + SAMPLE_STEP_TOLERANCE
        );
    });

    it('renders a leading gap at rate 2 in half its media frames', () => {
        const processor = createProcessor(1);
        setPlaybackRate(processor, 2);
        // A 10 ms gap: 480 media frames, so 240 output frames at rate 2
        const gapMicroseconds = 10_000;
        processor.port.deliver({
            channelData: [ new Float32Array(4 * CHUNK_FRAME_COUNT).fill(0.25) ],
            generation: GENERATION,
            sequence: 1,
            timestampMicroseconds: gapMicroseconds,
            type: 'enqueue'
        });

        const samples: number[] = [];
        for (let quantumIndex = 0; quantumIndex < 3; quantumIndex += 1) {
            const outputChannel = new Float32Array(RENDER_QUANTUM_FRAMES);
            processor.process([], [ [ outputChannel ] ]);
            samples.push(...outputChannel);
        }

        expect(samples.findIndex((sample): boolean => sample !== 0)).toBe(240);
        // The first quantum's 128 silent frames cover 256 media frames
        expect(getTelemetry(processor).find((message): boolean => message.reason === 'periodic')).toMatchObject({
            mediaTimeMicroseconds: Math.round((2 * RENDER_QUANTUM_FRAMES * MICROSECONDS_PER_SECOND) / SAMPLE_RATE),
            playbackRate: 2
        });
        expect(samples.slice(240)).toEqual(Array.from({ length: samples.length - 240 }, (): number => 0.25));
    });

    it('takes a valid rate, which holds across flushes until the lease deactivates', () => {
        const processor = createProcessor();
        setPlaybackRate(processor, 2);
        for (const invalidPlaybackRate of [ 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2' ]) {
            setPlaybackRate(processor, invalidPlaybackRate);
        }
        expect(processor.playbackRate).toBe(2);

        processor.port.deliver({ generation: GENERATION + 1, mediaTimeMicroseconds: 0, type: 'flush' });
        expect(processor.playbackRate).toBe(2);

        processor.port.deliver({ generation: GENERATION + 2, leaseId: 1, type: 'deactivate' });
        expect(processor.playbackRate).toBe(1);
    });

    it('keeps media time and level past the rates its input span covers', () => {
        const processor = createProcessor();
        const feeder = new SineFeeder(processor, Number.POSITIVE_INFINITY);
        const playbackRate = 8;
        setPlaybackRate(processor, playbackRate);

        const quanta: RenderedQuantum[] = [];
        for (let quantumIndex = 0; quantumIndex < 100; quantumIndex += 1) {
            const quantum = renderQuantum(processor, feeder);
            quanta.push(quantum);
            expect(Math.abs(quantum.telemetry.mediaTimeMicroseconds - getConsumedMediaTimeMicroseconds(quantum)))
                .toBeLessThanOrEqual(MEDIA_TIME_TOLERANCE_MICROSECONDS);
        }

        const samples = joinSamples(quanta);
        expect(samples.every((sample): boolean => Number.isFinite(sample) && Math.abs(sample) <= SINE_AMPLITUDE * 1.01)).toBe(true);
        expect(quanta[quanta.length - 1].telemetry).toMatchObject({ playbackRate, underflowEvents: 0 });
    });
});
