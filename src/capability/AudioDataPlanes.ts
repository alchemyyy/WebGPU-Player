// WebCodecs AudioSampleFormat definitions: https://w3c.github.io/webcodecs/#audio-buffer-arrangement
type AudioSampleDefinition = Readonly<{
    bytesPerSample: number
    planar: boolean
    // Converts one stored sample to the f32 range [-1, 1] as the spec's sample format definitions state
    read: (view: DataView, byteOffset: number) => number
}>;

/** The u8 format stores 128 as zero; 128 steps reach full scale either way. */
const U8_ZERO_OFFSET = 128;
const U8_FULL_SCALE = 128;
/** The s16 full-scale magnitude, 2^15. */
const S16_FULL_SCALE = 32_768;
/** The s32 full-scale magnitude, 2^31. */
const S32_FULL_SCALE = 2_147_483_648;

const readU8 = (view: DataView, byteOffset: number): number => (view.getUint8(byteOffset) - U8_ZERO_OFFSET) / U8_FULL_SCALE;
const readS16 = (view: DataView, byteOffset: number): number => view.getInt16(byteOffset, true) / S16_FULL_SCALE;
const readS32 = (view: DataView, byteOffset: number): number => view.getInt32(byteOffset, true) / S32_FULL_SCALE;
const readF32 = (view: DataView, byteOffset: number): number => view.getFloat32(byteOffset, true);

const AUDIO_SAMPLE_DEFINITIONS: Readonly<Record<AudioSampleFormat, AudioSampleDefinition>> = {
    'f32': { bytesPerSample: Float32Array.BYTES_PER_ELEMENT, planar: false, read: readF32 },
    'f32-planar': { bytesPerSample: Float32Array.BYTES_PER_ELEMENT, planar: true, read: readF32 },
    's16': { bytesPerSample: Int16Array.BYTES_PER_ELEMENT, planar: false, read: readS16 },
    's16-planar': { bytesPerSample: Int16Array.BYTES_PER_ELEMENT, planar: true, read: readS16 },
    's32': { bytesPerSample: Int32Array.BYTES_PER_ELEMENT, planar: false, read: readS32 },
    's32-planar': { bytesPerSample: Int32Array.BYTES_PER_ELEMENT, planar: true, read: readS32 },
    'u8': { bytesPerSample: Uint8Array.BYTES_PER_ELEMENT, planar: false, read: readU8 },
    'u8-planar': { bytesPerSample: Uint8Array.BYTES_PER_ELEMENT, planar: true, read: readU8 }
};

/**
 * Copies every channel of an AudioData as f32 samples, one Float32Array per channel in source order.
 * Copies only in the AudioData's own format and converts in JS: Safari 26.0-26.3 kills the page when asked to
 * convert interleaved multi-channel output to f32-planar (WebKit bug 302521), as Mediabunny's
 * doAudioDataCopyToWebKitWorkaround also avoids. Returns null for a missing or unknown format or a copy that throws.
 */
export function copyAudioDataPlanes(audioData: AudioData): Float32Array[] | null {
    const format = audioData.format;
    if (format === null || !Object.hasOwn(AUDIO_SAMPLE_DEFINITIONS, format)) {
        return null;
    }
    const definition = AUDIO_SAMPLE_DEFINITIONS[format];
    const channelCount = audioData.numberOfChannels;
    const frameCount = audioData.numberOfFrames;
    const planes: Float32Array[] = [];
    try {
        if (definition.planar) {
            const bytes = new Uint8Array(frameCount * definition.bytesPerSample);
            const view = new DataView(bytes.buffer);
            for (let planeIndex = 0; planeIndex < channelCount; planeIndex += 1) {
                audioData.copyTo(bytes, { format, planeIndex });
                const plane = new Float32Array(frameCount);
                for (let frame = 0; frame < frameCount; frame += 1) {
                    plane[frame] = definition.read(view, frame * definition.bytesPerSample);
                }
                planes.push(plane);
            }
            return planes;
        }
        const bytes = new Uint8Array(frameCount * channelCount * definition.bytesPerSample);
        audioData.copyTo(bytes, { format, planeIndex: 0 });
        const view = new DataView(bytes.buffer);
        for (let channel = 0; channel < channelCount; channel += 1) {
            const plane = new Float32Array(frameCount);
            for (let frame = 0; frame < frameCount; frame += 1) {
                plane[frame] = definition.read(view, ((frame * channelCount) + channel) * definition.bytesPerSample);
            }
            planes.push(plane);
        }
        return planes;
    } catch {
        return null;
    }
}
