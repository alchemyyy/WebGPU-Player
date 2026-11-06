import {
    microsecondsToMilliseconds,
    secondsToMicroseconds,
    type Microseconds
} from '../MediaTime';
import {
    createNativeMediaAudioProbeVector,
    type NativeMediaAudioProbeVectorChannelCount
} from './vectors/NativeMediaAudioCapabilityVectors';
import { CAPABILITY_PROBE_TIMEOUT } from './CapabilityProbeManager';
import { CapabilityProbeBlock, type default as CapabilityProbeSession, type RecordedCapabilityProbeQueue } from './CapabilityProbeSession';
import { describeAudioPlayback } from './CapabilityProbeSteps';
import { getDefaultCapabilityProbeSession } from './CustomDecodeCapabilities';

export const NATIVE_MEDIA_AUDIO_CODECS = [ 'ac3', 'eac3' ] as const;
export const NATIVE_MEDIA_AUDIO_SAMPLE_RATE = 48_000;
export const NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS = [ 2, 6 ] as const;
/** The probe the store records the native media audio playbacks under. */
export const NATIVE_MEDIA_AUDIO_PROBE = 'native-media-audio';

export type NativeMediaAudioCodec = typeof NATIVE_MEDIA_AUDIO_CODECS[number];
export type NativeMediaAudioChannelCount = typeof NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS[number];
export type NativeMediaAudioCapabilityStatus = 'supported' | 'unsupported' | 'unknown';
export type NativeMediaAudioCapabilityReason =
    | 'api-unavailable'
    | 'decoded-playback-advanced'
    | 'vector-append-failed'
    | 'mime-unsupported'
    | 'playback-failed'
    | 'playback-not-advanced'
    | 'probe-exception'
    | 'probe-timeout'
    // The playback never ran: a declared browser defect crashes it, or it stopped an earlier page alone
    | 'browser-defect'
    | 'stopped-page';

export type NativeMediaAudioRoute = {
    channelCount: NativeMediaAudioChannelCount
    codec: NativeMediaAudioCodec
    codecString: 'ac-3' | 'ec-3'
    mimeType: string
    sampleRate: typeof NATIVE_MEDIA_AUDIO_SAMPLE_RATE
};

export type NativeMediaAudioLayoutCapability = NativeMediaAudioRoute & {
    reason: NativeMediaAudioCapabilityReason
    status: NativeMediaAudioCapabilityStatus
};

export type NativeMediaAudioCodecCapability = {
    codec: NativeMediaAudioCodec
    codecString: NativeMediaAudioRoute['codecString']
    layouts: Readonly<Record<NativeMediaAudioChannelCount, NativeMediaAudioLayoutCapability>>
    mimeType: string
    status: NativeMediaAudioCapabilityStatus
};

export type NativeMediaAudioCapabilities = {
    audio: Readonly<Record<NativeMediaAudioCodec, NativeMediaAudioCodecCapability>>
    telemetry: Readonly<{
        probeCount: number
        supportedLayoutCount: number
        unknownLayoutCount: number
    }>
};

export type NativeMediaAudioExactProbeRequest = NativeMediaAudioRoute & {
    vector: Uint8Array
};

export type NativeMediaAudioExactProbeResult = {
    reason: NativeMediaAudioCapabilityReason
    supported: boolean
};

export type NativeMediaAudioCapabilityEnvironment = {
    exactPlaybackProbe?: (request: Readonly<NativeMediaAudioExactProbeRequest>) => Promise<NativeMediaAudioExactProbeResult>
    isTypeSupported?: ((mimeType: string) => boolean) | null
    /** The session whose manager runs each playback as a step of its own, beside the WebCodecs probes; the page's when absent */
    session?: CapabilityProbeSession
};

type NativeMediaAudioDefinition = {
    codec: NativeMediaAudioCodec
    codecString: NativeMediaAudioRoute['codecString']
    mimeType: string
};

const PROBE_TIMEOUT_MICROSECONDS = secondsToMicroseconds(3);
const REQUIRED_PLAYBACK_ADVANCE_MICROSECONDS = secondsToMicroseconds(0.05);
const MP4_AUDIO_MIME_TYPE = 'audio/mp4';
const DEFINITIONS: readonly NativeMediaAudioDefinition[] = [
    { codec: 'ac3', codecString: 'ac-3', mimeType: `${MP4_AUDIO_MIME_TYPE}; codecs="ac-3"` },
    { codec: 'eac3', codecString: 'ec-3', mimeType: `${MP4_AUDIO_MIME_TYPE}; codecs="ec-3"` }
];

// ISO/IEC 14496-12 boxes, from which a vector's decoded length is read
const BOX_HEADER_BYTE_LENGTH = 8;
const BOX_TYPE_OFFSET = 4;
const BOX_TYPE_BYTE_LENGTH = 4;
// A size of 1 moves the size to a 64-bit field after the type; a size of 0 runs the box to the end of its parent
const LARGE_BOX_SIZE_MARKER = 1;
const LARGE_BOX_HEADER_BYTE_LENGTH = 16;
const BOX_TO_END_MARKER = 0;
const UINT32_BYTE_LENGTH = 4;
const UINT64_BYTE_LENGTH = 8;
// A full box's payload opens with its version byte and 24 bits of flags
const FULL_BOX_HEADER_BYTE_LENGTH = 4;
const FULL_BOX_FLAGS_MASK = 0xFF_FFFF;
// mdhd (section 8.4.2): creation and modification times precede the timescale, 64-bit in version 1
const MDHD_VERSION_WITH_64_BIT_TIMES = 1;
// tfhd (section 8.8.7): the optional fields before default_sample_duration, in order
const TFHD_BASE_DATA_OFFSET_PRESENT = 0x00_0001;
const TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT = 0x00_0002;
const TFHD_DEFAULT_SAMPLE_DURATION_PRESENT = 0x00_0008;
// trex (section 8.8.3): track_ID and default_sample_description_index precede default_sample_duration
const TREX_DEFAULT_SAMPLE_DURATION_OFFSET = 2 * UINT32_BYTE_LENGTH;
// trun (section 8.8.8): the optional fields, in order
const TRUN_DATA_OFFSET_PRESENT = 0x00_0001;
const TRUN_FIRST_SAMPLE_FLAGS_PRESENT = 0x00_0004;
const TRUN_SAMPLE_DURATION_PRESENT = 0x00_0100;
const TRUN_SAMPLE_SIZE_PRESENT = 0x00_0200;
const TRUN_SAMPLE_FLAGS_PRESENT = 0x00_0400;
const TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT = 0x00_0800;

// A box's payload, after its header, within the vector
type ISOBox = Readonly<{ end: number, start: number, type: string }>;

function readChildBoxes(view: DataView, start: number, end: number): ISOBox[] {
    const boxes: ISOBox[] = [];
    let offset = start;
    while (offset < end) {
        if (offset + BOX_HEADER_BYTE_LENGTH > end) {
            throw new RangeError('An ISO box header is truncated');
        }
        const compactSize = view.getUint32(offset);
        const type = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset + BOX_TYPE_OFFSET, BOX_TYPE_BYTE_LENGTH));
        let headerByteLength = BOX_HEADER_BYTE_LENGTH;
        let size = compactSize;
        if (compactSize === LARGE_BOX_SIZE_MARKER) {
            headerByteLength = LARGE_BOX_HEADER_BYTE_LENGTH;
            size = Number(view.getBigUint64(offset + BOX_HEADER_BYTE_LENGTH));
        } else if (compactSize === BOX_TO_END_MARKER) {
            size = end - offset;
        }
        if (size < headerByteLength || offset + size > end) {
            throw new RangeError(`The ISO box ${type} overruns its parent`);
        }
        boxes.push({ end: offset + size, start: offset + headerByteLength, type });
        offset += size;
    }
    return boxes;
}

function findChildBoxes(view: DataView, parent: ISOBox, type: string): ISOBox[] {
    return readChildBoxes(view, parent.start, parent.end).filter((box: ISOBox): boolean => box.type === type);
}

function requireChildBox(view: DataView, parent: ISOBox, type: string): ISOBox {
    const [ box ] = findChildBoxes(view, parent, type);
    if (!box) {
        throw new RangeError(`The ISO box ${parent.type} has no ${type}`);
    }
    return box;
}

// Reads a track fragment's default sample duration, or null when tfhd leaves it to trex
function readTrackFragmentDefaultDuration(view: DataView, tfhd: ISOBox): number | null {
    const flags = view.getUint32(tfhd.start) & FULL_BOX_FLAGS_MASK;
    if ((flags & TFHD_DEFAULT_SAMPLE_DURATION_PRESENT) === 0) {
        return null;
    }
    // track_ID is always present
    let offset = tfhd.start + FULL_BOX_HEADER_BYTE_LENGTH + UINT32_BYTE_LENGTH;
    if ((flags & TFHD_BASE_DATA_OFFSET_PRESENT) !== 0) {
        offset += UINT64_BYTE_LENGTH;
    }
    if ((flags & TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT) !== 0) {
        offset += UINT32_BYTE_LENGTH;
    }
    return view.getUint32(offset);
}

// Sums a track run's sample durations, each its own or the fragment's default
function readTrackRunDuration(view: DataView, trun: ISOBox, defaultDuration: number): number {
    const flags = view.getUint32(trun.start) & FULL_BOX_FLAGS_MASK;
    const sampleCount = view.getUint32(trun.start + FULL_BOX_HEADER_BYTE_LENGTH);
    if ((flags & TRUN_SAMPLE_DURATION_PRESENT) === 0) {
        return sampleCount * defaultDuration;
    }
    let offset = trun.start + FULL_BOX_HEADER_BYTE_LENGTH + UINT32_BYTE_LENGTH;
    for (const optionalField of [ TRUN_DATA_OFFSET_PRESENT, TRUN_FIRST_SAMPLE_FLAGS_PRESENT ]) {
        if ((flags & optionalField) !== 0) {
            offset += UINT32_BYTE_LENGTH;
        }
    }
    const sampleFields = [
        TRUN_SAMPLE_DURATION_PRESENT,
        TRUN_SAMPLE_SIZE_PRESENT,
        TRUN_SAMPLE_FLAGS_PRESENT,
        TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT
    ].filter((field: number): boolean => (flags & field) !== 0);
    let duration = 0;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        // The duration is the first per-sample field
        duration += view.getUint32(offset);
        offset += sampleFields.length * UINT32_BYTE_LENGTH;
    }
    return duration;
}

/**
 * Reads the PCM frames a single-track fragmented MP4 audio vector decodes to: the durations of its fragments' samples, in its track's
 * timescale, at the sample rate. A playback buffers that much, so the probe manager counts it against the page's decoded bytes.
 */
function readFragmentedMP4FrameCount(vector: Uint8Array, sampleRate: number): number {
    const view = new DataView(vector.buffer, vector.byteOffset, vector.byteLength);
    const file: ISOBox = { end: view.byteLength, start: 0, type: 'file' };
    const moov = requireChildBox(view, file, 'moov');
    const mdhd = requireChildBox(view, requireChildBox(view, requireChildBox(view, moov, 'trak'), 'mdia'), 'mdhd');
    const timeByteLength = view.getUint8(mdhd.start) === MDHD_VERSION_WITH_64_BIT_TIMES ? UINT64_BYTE_LENGTH : UINT32_BYTE_LENGTH;
    const timescale = view.getUint32(mdhd.start + FULL_BOX_HEADER_BYTE_LENGTH + (2 * timeByteLength));
    const [ mvex ] = findChildBoxes(view, moov, 'mvex');
    const [ trex ] = mvex ? findChildBoxes(view, mvex, 'trex') : [];
    const trackDefaultDuration = trex ? view.getUint32(trex.start + FULL_BOX_HEADER_BYTE_LENGTH + TREX_DEFAULT_SAMPLE_DURATION_OFFSET) : 0;
    let duration = 0;
    for (const moof of findChildBoxes(view, file, 'moof')) {
        for (const traf of findChildBoxes(view, moof, 'traf')) {
            const defaultDuration = readTrackFragmentDefaultDuration(view, requireChildBox(view, traf, 'tfhd')) ?? trackDefaultDuration;
            for (const trun of findChildBoxes(view, traf, 'trun')) {
                duration += readTrackRunDuration(view, trun, defaultDuration);
            }
        }
    }
    if (timescale === 0) {
        throw new RangeError('The vector track has no timescale');
    }
    return Math.ceil(duration * sampleRate / timescale);
}

function getDefaultIsTypeSupported(): ((mimeType: string) => boolean) | null {
    if (typeof globalThis.MediaSource !== 'function' || typeof globalThis.MediaSource.isTypeSupported !== 'function') {
        return null;
    }
    // eslint-disable-next-line compat/compat -- Native MSE audio is capability-gated
    return (mimeType: string): boolean => globalThis.MediaSource.isTypeSupported(mimeType);
}

function waitForSourceOpen(mediaSource: MediaSource, timeoutMicroseconds: Microseconds): Promise<boolean> {
    if (mediaSource.readyState === 'open') {
        return Promise.resolve(true);
    }

    return new Promise<boolean>(resolve => {
        const timeout = globalThis.setTimeout((): void => {
            cleanup();
            resolve(false);
        }, microsecondsToMilliseconds(timeoutMicroseconds));
        const onSourceOpen = (): void => {
            cleanup();
            resolve(true);
        };
        const onSourceClose = (): void => {
            cleanup();
            resolve(false);
        };
        const cleanup = (): void => {
            globalThis.clearTimeout(timeout);
            mediaSource.removeEventListener('sourceopen', onSourceOpen);
            mediaSource.removeEventListener('sourceclose', onSourceClose);
        };
        mediaSource.addEventListener('sourceopen', onSourceOpen);
        mediaSource.addEventListener('sourceclose', onSourceClose);
    });
}

function appendVector(
    sourceBuffer: SourceBuffer,
    vector: Uint8Array,
    timeoutMicroseconds: Microseconds
): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        const timeout = globalThis.setTimeout((): void => {
            cleanup();
            resolve(false);
        }, microsecondsToMilliseconds(timeoutMicroseconds));
        const onUpdateEnd = (): void => {
            cleanup();
            resolve(true);
        };
        const onError = (): void => {
            cleanup();
            resolve(false);
        };
        const cleanup = (): void => {
            globalThis.clearTimeout(timeout);
            sourceBuffer.removeEventListener('updateend', onUpdateEnd);
            sourceBuffer.removeEventListener('error', onError);
        };
        sourceBuffer.addEventListener('updateend', onUpdateEnd);
        sourceBuffer.addEventListener('error', onError);
        try {
            const vectorCopy = vector.slice();
            sourceBuffer.appendBuffer(vectorCopy.buffer);
        } catch {
            cleanup();
            resolve(false);
        }
    });
}

function waitForPlaybackAdvance(audioElement: HTMLAudioElement, timeoutMicroseconds: Microseconds): Promise<boolean> {
    const startingTimeMicroseconds = secondsToMicroseconds(audioElement.currentTime);
    return new Promise<boolean>(resolve => {
        const timeout = globalThis.setTimeout((): void => {
            cleanup();
            resolve(false);
        }, microsecondsToMilliseconds(timeoutMicroseconds));
        const checkProgress = (): void => {
            const currentTimeMicroseconds = secondsToMicroseconds(audioElement.currentTime);
            if (currentTimeMicroseconds - startingTimeMicroseconds < REQUIRED_PLAYBACK_ADVANCE_MICROSECONDS) {
                return;
            }
            cleanup();
            resolve(true);
        };
        const onError = (): void => {
            cleanup();
            resolve(false);
        };
        const interval = globalThis.setInterval(checkProgress, 20);
        const cleanup = (): void => {
            globalThis.clearTimeout(timeout);
            globalThis.clearInterval(interval);
            audioElement.removeEventListener('timeupdate', checkProgress);
            audioElement.removeEventListener('ended', checkProgress);
            audioElement.removeEventListener('error', onError);
        };
        audioElement.addEventListener('timeupdate', checkProgress);
        audioElement.addEventListener('ended', checkProgress);
        audioElement.addEventListener('error', onError);
        checkProgress();
    });
}

async function runDefaultExactPlaybackProbe(
    request: Readonly<NativeMediaAudioExactProbeRequest>
): Promise<NativeMediaAudioExactProbeResult> {
    if (typeof globalThis.MediaSource !== 'function'
        || typeof globalThis.URL?.createObjectURL !== 'function'
        || typeof globalThis.URL?.revokeObjectURL !== 'function'
        || !globalThis.document?.body) {
        return { reason: 'api-unavailable', supported: false };
    }

    const audioElement = globalThis.document.createElement('audio');
    // eslint-disable-next-line compat/compat -- Native MSE audio is capability-gated
    const mediaSource = new MediaSource();
    const objectURL = globalThis.URL.createObjectURL(mediaSource);
    audioElement.autoplay = false;
    audioElement.controls = false;
    audioElement.muted = true;
    audioElement.preload = 'auto';
    audioElement.setAttribute('aria-hidden', 'true');
    audioElement.style.position = 'fixed';
    audioElement.style.width = '1px';
    audioElement.style.height = '1px';
    audioElement.style.opacity = '0';
    audioElement.style.pointerEvents = 'none';
    globalThis.document.body.appendChild(audioElement);
    audioElement.src = objectURL;

    try {
        const sourceOpened = await waitForSourceOpen(mediaSource, PROBE_TIMEOUT_MICROSECONDS);
        if (!sourceOpened || mediaSource.readyState !== 'open') {
            return { reason: 'probe-timeout', supported: false };
        }

        const sourceBuffer = mediaSource.addSourceBuffer(request.mimeType);
        const vectorAppended = await appendVector(sourceBuffer, request.vector, PROBE_TIMEOUT_MICROSECONDS);
        if (!vectorAppended) {
            return { reason: 'vector-append-failed', supported: false };
        }
        if (mediaSource.readyState === 'open') {
            mediaSource.endOfStream();
        }

        try {
            await audioElement.play();
        } catch {
            return { reason: 'playback-failed', supported: false };
        }
        const advanced = await waitForPlaybackAdvance(audioElement, PROBE_TIMEOUT_MICROSECONDS);
        return advanced ?
            { reason: 'decoded-playback-advanced', supported: true } :
            { reason: 'playback-not-advanced', supported: false };
    } catch {
        return { reason: 'vector-append-failed', supported: false };
    } finally {
        audioElement.pause();
        audioElement.removeAttribute('src');
        audioElement.load();
        audioElement.remove();
        globalThis.URL.revokeObjectURL(objectURL);
    }
}

function createUnavailableLayout(
    definition: NativeMediaAudioDefinition,
    channelCount: NativeMediaAudioChannelCount,
    reason: NativeMediaAudioCapabilityReason,
    status: NativeMediaAudioCapabilityStatus
): NativeMediaAudioLayoutCapability {
    return {
        ...definition,
        channelCount,
        reason,
        sampleRate: NATIVE_MEDIA_AUDIO_SAMPLE_RATE,
        status
    };
}

function getCodecStatus(
    layouts: Readonly<Record<NativeMediaAudioChannelCount, NativeMediaAudioLayoutCapability>>
): NativeMediaAudioCapabilityStatus {
    if (Object.values(layouts).some(layout => layout.status === 'supported')) {
        return 'supported';
    }
    if (Object.values(layouts).some(layout => layout.status === 'unknown')) {
        return 'unknown';
    }
    return 'unsupported';
}

type NativeMediaAudioLayoutProbeOutcome = {
    capability: NativeMediaAudioLayoutCapability
    probed: boolean
};

async function probeNativeMediaAudioLayout(
    definition: NativeMediaAudioDefinition,
    channelCount: NativeMediaAudioChannelCount,
    isTypeSupported: ((mimeType: string) => boolean) | null,
    exactPlaybackProbe: (probeInput: Readonly<NativeMediaAudioExactProbeRequest>) => Promise<NativeMediaAudioExactProbeResult>,
    queue: RecordedCapabilityProbeQueue
): Promise<NativeMediaAudioLayoutProbeOutcome> {
    if (!isTypeSupported) {
        return {
            capability: createUnavailableLayout(definition, channelCount, 'api-unavailable', 'unknown'),
            probed: false
        };
    }

    let mimeSupported = false;
    try {
        mimeSupported = isTypeSupported(definition.mimeType);
    } catch {
        return {
            capability: createUnavailableLayout(definition, channelCount, 'probe-exception', 'unknown'),
            probed: false
        };
    }
    if (!mimeSupported) {
        return {
            capability: createUnavailableLayout(definition, channelCount, 'mime-unsupported', 'unsupported'),
            probed: false
        };
    }

    const route: NativeMediaAudioRoute = {
        ...definition,
        channelCount,
        sampleRate: NATIVE_MEDIA_AUDIO_SAMPLE_RATE
    };
    try {
        const vector = createNativeMediaAudioProbeVector(definition.codec, channelCount as NativeMediaAudioProbeVectorChannelCount);
        const step = describeAudioPlayback(
            { codec: definition.codecString, numberOfChannels: channelCount, sampleRate: NATIVE_MEDIA_AUDIO_SAMPLE_RATE },
            readFragmentedMP4FrameCount(vector, NATIVE_MEDIA_AUDIO_SAMPLE_RATE)
        );
        // A playback bounds each of its stages itself, so the manager waits for it instead of timing it; a decoder pool may refuse
        // the playback's decoder only for the decoders of the calls beside it, so the manager confirms a failed playback alone
        const result = await queue.run(() => exactPlaybackProbe({ ...route, vector }), step, { confirm: (playback): boolean => !playback.supported });
        if (result === CAPABILITY_PROBE_TIMEOUT) {
            // The manager stopped the page's probing before the playback could start
            return {
                capability: createUnavailableLayout(definition, channelCount, 'probe-timeout', 'unknown'),
                probed: false
            };
        }
        if (result instanceof CapabilityProbeBlock) {
            return {
                capability: createUnavailableLayout(definition, channelCount, result.reason, 'unsupported'),
                probed: false
            };
        }
        return {
            capability: {
                ...route,
                reason: result.reason,
                status: result.supported ? 'supported' : 'unsupported'
            },
            probed: true
        };
    } catch {
        return {
            capability: createUnavailableLayout(definition, channelCount, 'probe-exception', 'unknown'),
            probed: true
        };
    }
}

/** Qualifies exact native MSE audio routes with append and clock-advance vectors. */
export async function probeNativeMediaAudioCapabilities(
    environment: NativeMediaAudioCapabilityEnvironment = {}
): Promise<NativeMediaAudioCapabilities> {
    const isTypeSupported = environment.isTypeSupported === undefined ?
        getDefaultIsTypeSupported() :
        environment.isTypeSupported;
    const exactPlaybackProbe = environment.exactPlaybackProbe ?? runDefaultExactPlaybackProbe;
    const session = environment.session ?? getDefaultCapabilityProbeSession();
    // A playback that stopped an earlier page alone never runs again, and the limits follow the quarantine
    await session.readQuarantine();
    const queue = session.record(session.manager.queue, NATIVE_MEDIA_AUDIO_PROBE);
    const capabilityPromises: Array<Promise<NativeMediaAudioCodecCapability>> = [];
    const probeOutcomes: NativeMediaAudioLayoutProbeOutcome[] = [];
    let probeCount = 0;
    let supportedLayoutCount = 0;
    let unknownLayoutCount = 0;

    for (const definition of DEFINITIONS) {
        capabilityPromises.push((async (): Promise<NativeMediaAudioCodecCapability> => {
            const layoutPromises: Array<Promise<NativeMediaAudioLayoutProbeOutcome>> = [];
            for (const channelCount of NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS) {
                layoutPromises.push(probeNativeMediaAudioLayout(definition, channelCount, isTypeSupported, exactPlaybackProbe, queue));
            }
            const outcomes = await Promise.all(layoutPromises);
            const layouts = {} as Record<NativeMediaAudioChannelCount, NativeMediaAudioLayoutCapability>;
            for (let layoutIndex = 0; layoutIndex < outcomes.length; layoutIndex += 1) {
                const outcome = outcomes[layoutIndex];
                layouts[NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS[layoutIndex]] = outcome.capability;
                probeOutcomes.push(outcome);
            }
            return {
                ...definition,
                layouts,
                status: getCodecStatus(layouts)
            };
        })());
    }

    const codecCapabilities = await Promise.all(capabilityPromises);
    const audio = {} as Record<NativeMediaAudioCodec, NativeMediaAudioCodecCapability>;
    for (const capability of codecCapabilities) {
        audio[capability.codec] = capability;
    }
    for (const outcome of probeOutcomes) {
        if (outcome.probed) {
            probeCount += 1;
        }
        if (outcome.capability.status === 'supported') {
            supportedLayoutCount += 1;
        } else if (outcome.capability.status === 'unknown') {
            unknownLayoutCount += 1;
        }
    }

    return {
        audio,
        telemetry: {
            probeCount,
            supportedLayoutCount,
            unknownLayoutCount
        }
    };
}

/** Probes the native MSE audio routes once and caches the result. */
export default class NativeMediaAudioCapabilityProbe {
    private cachedProbe: Promise<NativeMediaAudioCapabilities> | null = null;
    private readonly environment: NativeMediaAudioCapabilityEnvironment | null;

    public constructor(environment: NativeMediaAudioCapabilityEnvironment | null = null) {
        this.environment = environment;
    }

    /** Starts the probe on the first call; later calls share its result. */
    public probe(): Promise<NativeMediaAudioCapabilities> {
        if (!this.cachedProbe) {
            this.cachedProbe = probeNativeMediaAudioCapabilities(this.environment ?? {});
        }
        return this.cachedProbe;
    }
}

const defaultNativeMediaAudioCapabilityProbe = new NativeMediaAudioCapabilityProbe();

/** Probes the native MSE audio routes once per page. */
export function probeCachedNativeMediaAudioCapabilities(): Promise<NativeMediaAudioCapabilities> {
    return defaultNativeMediaAudioCapabilityProbe.probe();
}

/** Returns a route only when the probe passed for its codec, channel count, and sample rate. */
export function getSupportedNativeMediaAudioRoute(
    capabilities: NativeMediaAudioCapabilities,
    codec: NativeMediaAudioCodec,
    channelCount: number,
    sampleRate: number
): NativeMediaAudioRoute | null {
    if ((channelCount !== 2 && channelCount !== 6) || sampleRate !== NATIVE_MEDIA_AUDIO_SAMPLE_RATE) {
        return null;
    }
    const layout = capabilities.audio[codec].layouts[channelCount];
    if (layout.status !== 'supported') {
        return null;
    }
    return {
        channelCount,
        codec,
        codecString: layout.codecString,
        mimeType: layout.mimeType,
        sampleRate: NATIVE_MEDIA_AUDIO_SAMPLE_RATE
    };
}
