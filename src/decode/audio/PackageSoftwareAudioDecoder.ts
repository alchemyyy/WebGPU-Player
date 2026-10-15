// Decodes a track with a host's audio decoder package: each block must report a qualified speaker layout and rate.
import type { Microseconds } from '../../MediaTime';
import {
    addMicroseconds,
    audioFramesToMicroseconds,
    requireMicroseconds
} from '../../TimeMath';
import { isSupportedCustomAudioSampleRate } from '../../audio/CustomAudioSampleRate';
import type { CustomAudioChannelLayout } from '../../audio/processing/CustomAudioChannelLayout';
import { getQualifiedCustomWaveChannelLayout } from '../../audio/processing/CustomWaveChannelLayout';
import AudioDecoderPackageInstance, { type AudioDecoderModuleSource, type AudioDecoderPackageBlock } from './AudioDecoderPackageInstance';

/** The most frames one block of a package may hold. */
export const PACKAGE_AUDIO_MAXIMUM_BLOCK_FRAME_COUNT = 16_384;

/** One checked block: planar PCM in a qualified speaker layout, at its media time. */
export type PackageDecodedAudioOutput = Readonly<{
    channelData: readonly Float32Array[]
    channelLayout: CustomAudioChannelLayout
    channelMask: number
    frameCount: number
    mediaTimeMicroseconds: Microseconds
    sampleRate: number
}>;

/**
 * Checks one block and gives it a timestamp; subject names the decoder in failures.
 * A block without a timestamp of its own starts where its packet's earlier blocks ended.
 */
export function createPackageAudioOutput(
    block: AudioDecoderPackageBlock,
    packetMediaTimeMicroseconds: Microseconds,
    precedingPacketFrameCount: number,
    subject: string
): PackageDecodedAudioOutput {
    const { channelData, channelMask, frameCount, sampleRate } = block;
    if (frameCount > PACKAGE_AUDIO_MAXIMUM_BLOCK_FRAME_COUNT) {
        throw new RangeError(`${subject} output frame count is invalid`);
    }
    if (!isSupportedCustomAudioSampleRate(sampleRate)) {
        throw new RangeError(`${subject} output sample rate ${sampleRate} Hz is invalid`);
    }
    const qualifiedLayout = getQualifiedCustomWaveChannelLayout(channelMask);
    if (!qualifiedLayout || qualifiedLayout.channelCount !== channelData.length) {
        throw new RangeError(`${subject} channel mask 0x${channelMask.toString(16)} is unqualified`);
    }
    const mediaTimeMicroseconds = block.timestampMicroseconds !== null ?
        requireMicroseconds(block.timestampMicroseconds, `${subject} decoded timestamp`) :
        addMicroseconds(packetMediaTimeMicroseconds, audioFramesToMicroseconds(precedingPacketFrameCount, sampleRate));
    return {
        channelData,
        channelLayout: qualifiedLayout.layout,
        channelMask,
        frameCount,
        mediaTimeMicroseconds,
        sampleRate
    };
}

/** Owns one decoder of an audio decoder package in the audio decode worker. */
export default class PackageSoftwareAudioDecoder {
    private readonly decoder: AudioDecoderPackageInstance;
    private readonly subject: string;

    private constructor(decoder: AudioDecoderPackageInstance, subject: string) {
        this.decoder = decoder;
        this.subject = subject;
    }

    /** Creates a decoder of one of the package's codecs on its own instance of the package. */
    public static async create(source: AudioDecoderModuleSource, codec: string): Promise<PackageSoftwareAudioDecoder> {
        const decoder = await AudioDecoderPackageInstance.create(source, codec);
        return new PackageSoftwareAudioDecoder(decoder, `Audio decoder ${source.manifest.name}`);
    }

    /** Decodes one packet into its checked blocks; a packet the decoder dropped, or one before a sync point, decodes to none. */
    public decode(data: Uint8Array, mediaTimeMicroseconds: Microseconds): readonly PackageDecodedAudioOutput[] {
        requireMicroseconds(mediaTimeMicroseconds, `${this.subject} packet timestamp`);
        const result = this.decoder.decode(data, mediaTimeMicroseconds);
        if (result.kind !== 'decoded') {
            return [];
        }
        const outputs: PackageDecodedAudioOutput[] = [];
        let emittedFrameCount = 0;
        for (const block of result.blocks) {
            const output = createPackageAudioOutput(block, mediaTimeMicroseconds, emittedFrameCount, this.subject);
            outputs.push(output);
            emittedFrameCount += output.frameCount;
        }
        return outputs;
    }

    /** Clears inter-frame state before a seek or a source change. */
    public clear(): void {
        this.decoder.clear();
    }

    /** Releases the decoder exactly once. */
    public close(): void {
        this.decoder.close();
    }
}
