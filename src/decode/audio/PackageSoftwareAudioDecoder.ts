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
import {
    AUDIO_DECODER_OBJECT_COUNT_ATTRIBUTE,
    AUDIO_DECODER_RENDER_BINAURAL_OPTION,
    AUDIO_DECODER_RENDER_CHANNEL_MASK_OPTION,
    declaresAudioDecoderOption,
    isAudioDecoderObjectCount
} from './AudioDecoderManifest';
import AudioDecoderPackageInstance, {
    AudioDecoderPackageError,
    type AudioDecoderModuleSource,
    type AudioDecoderPackageBlock
} from './AudioDecoderPackageInstance';

/** The most frames one block of a package may hold. */
export const PACKAGE_AUDIO_MAXIMUM_BLOCK_FRAME_COUNT = 16_384;
/**
 * The media time a package may drop packets across, since its last output, before the attempt fails: a stream it cannot decode,
 * whose every packet it drops, fails as a decode failure within about 2 s of media rather than waiting on the page's startup bound.
 */
export const PACKAGE_AUDIO_MAXIMUM_DROPPED_MEDIA_MICROSECONDS = 2_000_000;
// No package reported the failure, so it names none of the package's error codes
const DROPPED_PACKETS_ERROR_CODE = 0;

/** One checked block: planar PCM in a qualified speaker layout, at its media time. */
export type PackageDecodedAudioOutput = Readonly<{
    channelData: readonly Float32Array[]
    channelLayout: CustomAudioChannelLayout
    channelMask: number
    frameCount: number
    mediaTimeMicroseconds: Microseconds
    /** How many dynamic objects the package rendered into the block, or null for a package that reports no `objectCount` */
    objectCount: number | null
    sampleRate: number
}>;

/** The output an object audio package renders into: the output layout's WAVE mask, and binaural headphone rendering of a stereo output. */
export type PackageAudioRenderTarget = Readonly<{
    binaural: boolean
    channelMask: number
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
    const objectCount = block.attributes.get(AUDIO_DECODER_OBJECT_COUNT_ATTRIBUTE);
    // A count past the bound the page's messages take fails this attempt, not the audio decode worker
    if (objectCount !== undefined && !isAudioDecoderObjectCount(objectCount)) {
        throw new RangeError(`${subject} object count ${objectCount} is invalid`);
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
        objectCount: objectCount ?? null,
        sampleRate
    };
}

/** Owns one decoder of an audio decoder package in the audio decode worker. */
export default class PackageSoftwareAudioDecoder {
    private readonly decoder: AudioDecoderPackageInstance;
    /** The timestamp of the first packet the package dropped since its last output, or null while it drops none */
    private firstDroppedPacketMicroseconds: Microseconds | null = null;
    /** The packets the package dropped since its last output */
    private droppedPacketCount = 0;
    /** The timestamp of the last packet sent, which drained blocks without a timestamp start at when no block was output before them */
    private lastPacketMicroseconds: Microseconds | null = null;
    /** Where the last output ended, which a drained block without a timestamp of its own continues from; null before any output */
    private outputEndMicroseconds: Microseconds | null = null;
    private readonly rendersBinaural: boolean;
    private readonly rendersObjects: boolean;
    private renderTarget: PackageAudioRenderTarget | null = null;
    private readonly subject: string;

    private constructor(decoder: AudioDecoderPackageInstance, source: AudioDecoderModuleSource) {
        this.decoder = decoder;
        this.rendersObjects = declaresAudioDecoderOption(source.manifest, AUDIO_DECODER_RENDER_CHANNEL_MASK_OPTION);
        this.rendersBinaural = declaresAudioDecoderOption(source.manifest, AUDIO_DECODER_RENDER_BINAURAL_OPTION);
        this.subject = `Audio decoder ${source.manifest.name}`;
    }

    /**
     * Creates a decoder of one of the package's codecs on its own instance of the package, configured with the track's codec private data, if any,
     * before its first packet.
     */
    public static async create(source: AudioDecoderModuleSource, codec: string, codecPrivate: Uint8Array | null): Promise<PackageSoftwareAudioDecoder> {
        const decoder = await AudioDecoderPackageInstance.create(source, codec);
        try {
            decoder.configure(codecPrivate);
        } catch (error) {
            decoder.close();
            throw error;
        }
        return new PackageSoftwareAudioDecoder(decoder, source);
    }

    /**
     * Sets the output an object audio package renders into, before the next packet: `renderChannelMask` and `renderBinaural` on a package that declares them.
     * A package that declares neither is untouched, and an unchanged option is not set again.
     */
    public setRenderTarget(renderTarget: PackageAudioRenderTarget): void {
        const previousTarget = this.renderTarget;
        this.renderTarget = renderTarget;
        if (this.rendersObjects && previousTarget?.channelMask !== renderTarget.channelMask) {
            this.decoder.setOption(AUDIO_DECODER_RENDER_CHANNEL_MASK_OPTION, renderTarget.channelMask);
        }
        if (this.rendersBinaural && previousTarget?.binaural !== renderTarget.binaural) {
            this.decoder.setOption(AUDIO_DECODER_RENDER_BINAURAL_OPTION, renderTarget.binaural ? 1 : 0);
        }
    }

    /**
     * Decodes one packet into its checked blocks; a packet the decoder dropped, or one before a sync point, decodes to none.
     * Packets dropped across the dropped-packet bound of media time with no output between them fail the decoder, while packets before a sync point never do.
     */
    public decode(data: Uint8Array, mediaTimeMicroseconds: Microseconds): readonly PackageDecodedAudioOutput[] {
        requireMicroseconds(mediaTimeMicroseconds, `${this.subject} packet timestamp`);
        this.lastPacketMicroseconds = mediaTimeMicroseconds;
        const result = this.decoder.decode(data, mediaTimeMicroseconds);
        if (result.kind === 'dropped') {
            this.requireDecodableAfterDrop(mediaTimeMicroseconds);
            return [];
        }
        if (result.kind !== 'decoded') {
            return [];
        }
        const outputs = this.createOutputs(result.blocks, mediaTimeMicroseconds);
        if (outputs.length > 0) {
            this.firstDroppedPacketMicroseconds = null;
            this.droppedPacketCount = 0;
        }
        return outputs;
    }

    /** Counts a dropped packet, and fails once the packets dropped since the last output span the dropped-packet bound of media time. */
    private requireDecodableAfterDrop(mediaTimeMicroseconds: Microseconds): void {
        this.firstDroppedPacketMicroseconds ??= mediaTimeMicroseconds;
        this.droppedPacketCount += 1;
        if (mediaTimeMicroseconds - this.firstDroppedPacketMicroseconds < PACKAGE_AUDIO_MAXIMUM_DROPPED_MEDIA_MICROSECONDS) {
            return;
        }
        throw new AudioDecoderPackageError(
            DROPPED_PACKETS_ERROR_CODE,
            this.droppedPacketCount,
            new Map(),
            `${this.subject} dropped all ${this.droppedPacketCount} packets across ${PACKAGE_AUDIO_MAXIMUM_DROPPED_MEDIA_MICROSECONDS / 1_000_000} s of media without an output`
        );
    }

    /**
     * Ends the track: decodes the frames the package's decoder held back, when its module drains, as checked blocks after the last output.
     * Without an earlier output, as after a seek onto a track's last packet, a drained block without a timestamp starts at the last packet's time;
     * without a packet either, the drain outputs nothing. The decoder takes no packet after it until `clear`.
     */
    public drain(): readonly PackageDecodedAudioOutput[] {
        const blocks = this.decoder.drain();
        if (blocks.length === 0) {
            return [];
        }
        const firstTimestamp = blocks[0].timestampMicroseconds;
        const startMicroseconds = this.outputEndMicroseconds
            ?? (firstTimestamp === null ? this.lastPacketMicroseconds : requireMicroseconds(firstTimestamp, `${this.subject} drained timestamp`));
        return startMicroseconds === null ? [] : this.createOutputs(blocks, startMicroseconds);
    }

    /** Clears inter-frame state before a seek or a source change. */
    public clear(): void {
        this.decoder.clear();
        this.firstDroppedPacketMicroseconds = null;
        this.droppedPacketCount = 0;
        this.lastPacketMicroseconds = null;
        this.outputEndMicroseconds = null;
    }

    /** Checks a packet's or a drain's blocks, which start at a media time unless they carry their own, and notes where the last one ends. */
    private createOutputs(blocks: readonly AudioDecoderPackageBlock[], mediaTimeMicroseconds: Microseconds): PackageDecodedAudioOutput[] {
        const outputs: PackageDecodedAudioOutput[] = [];
        let emittedFrameCount = 0;
        for (const block of blocks) {
            const output = createPackageAudioOutput(block, mediaTimeMicroseconds, emittedFrameCount, this.subject);
            outputs.push(output);
            emittedFrameCount += output.frameCount;
            this.outputEndMicroseconds = addMicroseconds(output.mediaTimeMicroseconds, audioFramesToMicroseconds(output.frameCount, output.sampleRate));
        }
        return outputs;
    }

    /** Releases the decoder exactly once. */
    public close(): void {
        this.decoder.close();
    }
}
