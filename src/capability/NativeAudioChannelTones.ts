// Identifies the channel order of decoded multichannel audio from a vector whose source channels each carry one tone.

/** One source channel's tone, and the amplitude its decoded plane must keep: a lossy encoder may attenuate an LFE. */
export type NativeAudioChannelTone = Readonly<{
    frequency: number
    minimumAmplitude: number
}>;

/** The frames each plane is measured over, centered in the decoded stream, clear of encoder priming and end padding. */
export const NATIVE_AUDIO_CHANNEL_TONE_ANALYSIS_FRAME_COUNT = 2_048;
/** How many times stronger a plane's own tone must be than every other channel's tone in it, 20 dB. */
export const NATIVE_AUDIO_CHANNEL_TONE_MINIMUM_MARGIN = 10;

/** Measures a tone's amplitude in a Hann-windowed block with the Goertzel recurrence. */
function measureToneAmplitude(samples: Float32Array, frequency: number, sampleRate: number): number {
    const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
    const lastIndex = samples.length - 1;
    let windowSum = 0;
    let previous = 0;
    let beforePrevious = 0;
    for (let index = 0; index < samples.length; index += 1) {
        const windowGain = 0.5 - (0.5 * Math.cos((2 * Math.PI * index) / lastIndex));
        windowSum += windowGain;
        const current = (samples[index] * windowGain) + (coefficient * previous) - beforePrevious;
        beforePrevious = previous;
        previous = current;
    }
    const power = (previous * previous) + (beforePrevious * beforePrevious) - (coefficient * previous * beforePrevious);
    return (2 * Math.sqrt(Math.max(power, 0))) / windowSum;
}

/**
 * Returns whether decoded planes carry their source channels' tones in source order: one plane per tone, each plane's own tone at its minimum amplitude or more,
 * and at least the margin stronger than every other tone in that plane.
 * So a decoder that reorders channels, drops some, or outputs silence fails.
 */
export function matchesNativeAudioChannelTones(
    planes: readonly Float32Array[],
    sampleRate: number,
    tones: readonly NativeAudioChannelTone[]
): boolean {
    if (planes.length !== tones.length || planes.length === 0) {
        return false;
    }
    const frameCount = planes[0].length;
    if (frameCount < NATIVE_AUDIO_CHANNEL_TONE_ANALYSIS_FRAME_COUNT
        || planes.some((plane: Float32Array): boolean => plane.length !== frameCount)) {
        return false;
    }
    const analysisStart = Math.floor((frameCount - NATIVE_AUDIO_CHANNEL_TONE_ANALYSIS_FRAME_COUNT) / 2);
    return planes.every((plane: Float32Array, planeIndex: number): boolean => {
        const analyzed = plane.subarray(analysisStart, analysisStart + NATIVE_AUDIO_CHANNEL_TONE_ANALYSIS_FRAME_COUNT);
        if (analyzed.some((sample: number): boolean => !Number.isFinite(sample))) {
            return false;
        }
        const ownTone = tones[planeIndex];
        const ownAmplitude = measureToneAmplitude(analyzed, ownTone.frequency, sampleRate);
        if (ownAmplitude < ownTone.minimumAmplitude) {
            return false;
        }
        return tones.every((tone: NativeAudioChannelTone, toneIndex: number): boolean => (
            toneIndex === planeIndex
            || measureToneAmplitude(analyzed, tone.frequency, sampleRate) * NATIVE_AUDIO_CHANNEL_TONE_MINIMUM_MARGIN <= ownAmplitude
        ));
    });
}
