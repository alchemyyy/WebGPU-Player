// Describes each browser call a capability probe makes: a label that names the exact call, so a crash blocks that call
// and no other, and the cost the call holds at once, so the probe manager can run calls side by side within the device's limits.

import type { CustomDecodeRawVideoFrameFormat } from '../pipeline/DecodeWorkerProtocol';
import { getVideoFrameFormatByteLength } from './VideoFrameFormatSupport';

/** What one browser call holds at once: decoded bytes, and decoders open. */
export type CapabilityProbeStepCost = Readonly<{ bytes: number, decoders: number }>;
/** A configuration support check, a decode of real samples, or a media element's playback of a real vector. */
export type CapabilityProbeStepKind = 'check' | 'decode' | 'play';
/** One video decoder call of a probe. */
export type VideoCapabilityProbeStep = Readonly<{
    media: 'video'
    kind: CapabilityProbeStepKind
    codec: string
    codedWidth: number
    codedHeight: number
    hardwareAcceleration: HardwareAcceleration
    copyFormat: CustomDecodeRawVideoFrameFormat | null
    label: string
    cost: CapabilityProbeStepCost
}>;
/** One audio decoder call of a probe. */
export type AudioCapabilityProbeStep = Readonly<{
    media: 'audio'
    kind: CapabilityProbeStepKind
    codec: string
    numberOfChannels: number
    sampleRate: number
    label: string
    cost: CapabilityProbeStepCost
}>;
/** One browser call of a probe, video or audio. */
export type CapabilityProbeStep = VideoCapabilityProbeStep | AudioCapabilityProbeStep;

/** The longest step label the Jellyfin plugin server accepts in a report. */
export const CAPABILITY_PROBE_STEP_LABEL_MAXIMUM_LENGTH = 96;
// Printable ASCII only, so a label survives storage, logs, and the server's report validation unchanged
const PRINTABLE_ASCII_LABEL = /^[\x20-\x7E]+$/u;

/** H.264 (ITU-T H.264 Annex A.3.1, max_dec_frame_buffering): a DPB holds at most 16 frames. */
export const H264_MAXIMUM_REFERENCE_FRAMES = 16;
/** HEVC (ITU-T H.265 Annex A.4.2, MaxDpbSize): a DPB holds at most 16 pictures. */
export const HEVC_MAXIMUM_REFERENCE_FRAMES = 16;
/** VP9 (VP9 Bitstream Specification section 10.5, REF_FRAMES): 8 reference slots. */
export const VP9_MAXIMUM_REFERENCE_FRAMES = 8;
/** AV1 (AV1 Bitstream Specification section 3, NUM_REF_FRAMES): 8 reference slots. */
export const AV1_MAXIMUM_REFERENCE_FRAMES = 8;
/** VP8 (RFC 6386 section 9.7): the last, golden, and altref frames. */
export const VP8_MAXIMUM_REFERENCE_FRAMES = 3;

const MAXIMUM_REFERENCE_FRAMES_BY_CODEC_FAMILY: Readonly<Partial<Record<string, number>>> = {
    av01: AV1_MAXIMUM_REFERENCE_FRAMES,
    avc1: H264_MAXIMUM_REFERENCE_FRAMES,
    avc3: H264_MAXIMUM_REFERENCE_FRAMES,
    hev1: HEVC_MAXIMUM_REFERENCE_FRAMES,
    hvc1: HEVC_MAXIMUM_REFERENCE_FRAMES,
    vp09: VP9_MAXIMUM_REFERENCE_FRAMES,
    vp8: VP8_MAXIMUM_REFERENCE_FRAMES
};
// An unknown family may hold as many references as any known one, so it is costed as the largest
const UNKNOWN_CODEC_MAXIMUM_REFERENCE_FRAMES = Math.max(
    H264_MAXIMUM_REFERENCE_FRAMES,
    HEVC_MAXIMUM_REFERENCE_FRAMES,
    VP9_MAXIMUM_REFERENCE_FRAMES,
    AV1_MAXIMUM_REFERENCE_FRAMES,
    VP8_MAXIMUM_REFERENCE_FRAMES
);
// The frame a decoder hands out sits beside the references it keeps
const DECODER_OUTPUT_FRAME_COUNT = 1;
// Decoded audio is held as f32 samples
const DECODED_AUDIO_SAMPLE_BYTES = Float32Array.BYTES_PER_ELEMENT;
const NO_PREFERENCE: HardwareAcceleration = 'no-preference';
const CHECK_COST: CapabilityProbeStepCost = Object.freeze({ bytes: 0, decoders: 1 });

/** Returns the most reference frames a decoder of the codec string's family keeps; an unknown family takes the largest known. */
export function getMaximumReferenceFrames(codec: string): number {
    const family = codec.split('.', 1)[0] ?? codec;
    return Object.hasOwn(MAXIMUM_REFERENCE_FRAMES_BY_CODEC_FAMILY, family) ?
        MAXIMUM_REFERENCE_FRAMES_BY_CODEC_FAMILY[family] ?? UNKNOWN_CODEC_MAXIMUM_REFERENCE_FRAMES :
        UNKNOWN_CODEC_MAXIMUM_REFERENCE_FRAMES;
}

function assertLabel(label: string): string {
    if (label.length > CAPABILITY_PROBE_STEP_LABEL_MAXIMUM_LENGTH || !PRINTABLE_ASCII_LABEL.test(label)) {
        throw new RangeError(`Capability probe step label must be printable ASCII of at most ${String(CAPABILITY_PROBE_STEP_LABEL_MAXIMUM_LENGTH)} characters: ${JSON.stringify(label)}`);
    }
    return label;
}

function assertPositiveSize(value: number | undefined, name: string): number {
    if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`Capability probe video step needs a positive integer ${name}, got ${String(value)}`);
    }
    return value;
}

function assertNonNegativeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`Capability probe audio step needs a non-negative integer ${name}, got ${String(value)}`);
    }
    return value;
}

function describeVideoStep(
    kind: CapabilityProbeStepKind,
    config: VideoDecoderConfig,
    copyFormat: CustomDecodeRawVideoFrameFormat | null,
    cost: (codedWidth: number, codedHeight: number) => CapabilityProbeStepCost
): VideoCapabilityProbeStep {
    const codedWidth = assertPositiveSize(config.codedWidth, 'codedWidth');
    const codedHeight = assertPositiveSize(config.codedHeight, 'codedHeight');
    const hardwareAcceleration = config.hardwareAcceleration ?? NO_PREFERENCE;
    let label = `${kind} ${config.codec} ${String(codedWidth)}x${String(codedHeight)}`;
    if (hardwareAcceleration !== NO_PREFERENCE) {
        label += ` ${hardwareAcceleration}`;
    }
    if (copyFormat !== null) {
        label += ` ${copyFormat}`;
    }
    return {
        codec: config.codec,
        codedHeight,
        codedWidth,
        copyFormat,
        cost: cost(codedWidth, codedHeight),
        hardwareAcceleration,
        kind,
        label: assertLabel(label),
        media: 'video'
    };
}

function describeAudioStep(kind: CapabilityProbeStepKind, config: AudioDecoderConfig, cost: CapabilityProbeStepCost): AudioCapabilityProbeStep {
    const numberOfChannels = assertNonNegativeInteger(config.numberOfChannels, 'numberOfChannels');
    const sampleRate = config.sampleRate;
    return {
        codec: config.codec,
        cost,
        kind,
        label: assertLabel(`${kind} ${config.codec} ${String(numberOfChannels)}ch ${String(sampleRate)}Hz`),
        media: 'audio',
        numberOfChannels,
        sampleRate
    };
}

/** Describes `VideoDecoder.isConfigSupported` of a config: one decoder, no decoded bytes. */
export function describeVideoConfigCheck(config: VideoDecoderConfig): VideoCapabilityProbeStep {
    return describeVideoStep('check', config, null, () => CHECK_COST);
}

/**
 * Describes a decode of a config whose frames come out in `frameFormat`: the decoder holds its maximum references plus
 * the frame it outputs, and a copy into `copyFormat` holds one more frame of that format.
 */
export function describeVideoDecode(
    config: VideoDecoderConfig,
    frameFormat: CustomDecodeRawVideoFrameFormat,
    copyFormat: CustomDecodeRawVideoFrameFormat | null = null
): VideoCapabilityProbeStep {
    return describeVideoStep('decode', config, copyFormat, (codedWidth, codedHeight) => {
        const heldFrames = getMaximumReferenceFrames(config.codec) + DECODER_OUTPUT_FRAME_COUNT;
        const decodedBytes = getVideoFrameFormatByteLength(frameFormat, codedWidth, codedHeight) * heldFrames;
        const copyBytes = copyFormat === null ? 0 : getVideoFrameFormatByteLength(copyFormat, codedWidth, codedHeight);
        return { bytes: decodedBytes + copyBytes, decoders: 1 };
    });
}

function getDecodedAudioCost(config: AudioDecoderConfig, frameCount: number): CapabilityProbeStepCost {
    const frames = assertNonNegativeInteger(frameCount, 'decodedFrameCount');
    const numberOfChannels = assertNonNegativeInteger(config.numberOfChannels, 'numberOfChannels');
    return { bytes: frames * numberOfChannels * DECODED_AUDIO_SAMPLE_BYTES, decoders: 1 };
}

/** Describes `AudioDecoder.isConfigSupported` of a config: one decoder, no decoded bytes. */
export function describeAudioConfigCheck(config: AudioDecoderConfig): AudioCapabilityProbeStep {
    return describeAudioStep('check', config, CHECK_COST);
}

/** Describes a decode of a config that yields `decodedFrameCount` frames of every channel, held as f32. */
export function describeAudioDecode(config: AudioDecoderConfig, decodedFrameCount: number): AudioCapabilityProbeStep {
    return describeAudioStep('decode', config, getDecodedAudioCost(config, decodedFrameCount));
}

/**
 * Describes a media element's playback of a vector in the config's codec and layout, which decodes it to `bufferedFrameCount` frames
 * of every channel: one decoder, and the PCM it buffers, held as f32.
 */
export function describeAudioPlayback(config: AudioDecoderConfig, bufferedFrameCount: number): AudioCapabilityProbeStep {
    return describeAudioStep('play', config, getDecodedAudioCost(config, bufferedFrameCount));
}

/** Returns the largest bytes and the most decoders any one of the steps holds, each on its own; zero for no steps. */
export function getLargestCapabilityProbeStepCost(steps: Iterable<CapabilityProbeStep>): CapabilityProbeStepCost {
    let bytes = 0;
    let decoders = 0;
    for (const { cost } of steps) {
        bytes = Math.max(bytes, cost.bytes);
        decoders = Math.max(decoders, cost.decoders);
    }
    return { bytes, decoders };
}
