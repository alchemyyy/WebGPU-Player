import type { AudioCodec } from 'mediabunny';

import { MICROSECONDS_PER_SECOND } from '../MediaTime';
import { isSupportedCustomAudioSampleRate } from '../audio/CustomAudioSampleRate';
import { getCustomAudioChannelLayout, type CustomAudioChannelLayout } from '../audio/processing/CustomAudioChannelLayout';
import { getQualifiedCustomWaveChannelLayout } from '../audio/processing/CustomWaveChannelLayout';
import type { CustomDecodeAudioMetadataLayout } from '../pipeline/DecodeWorkerProtocol';

// ISO BMFF audio sample entries store their rate as 16.16 fixed point
const ISO_BASE_MEDIA_SAMPLE_RATE_SCALE = 0x1_0000;
// The DTS core always runs at 48 kHz, whatever rate its extensions reach
const DTS_CORE_SAMPLE_RATE = 48_000;
const ISO_BASE_MEDIA_TRUEHD_SAMPLE_ENTRY = 'mlpa';

/** The codecs of a Meridian Lossless Packing track: MLP, or Dolby TrueHD. */
export type TrueHDAudioCodec = 'mlp' | 'truehd';

/** The audio codecs the engine reads from a track's container codec ID, because Mediabunny does not map them. */
export type ContainerAudioCodec = 'dts' | TrueHDAudioCodec;

// QuickTime muxers write the DTS core entry with a trailing space, which Mediabunny does not map
const QUICKTIME_DTS_SAMPLE_ENTRY = 'DTS ';
// DTS core, DTS-HD with a core, and DTS-HD lossless; not dtse (LBR) or dtsx (DTS-UHD)
const ISO_BASE_MEDIA_DTS_SAMPLE_ENTRIES: ReadonlySet<unknown> = new Set<unknown>([
    QUICKTIME_DTS_SAMPLE_ENTRY,
    'dtsc',
    'dtsh',
    'dtsl'
]);
// The decoder configuration codec Mediabunny gives DTS Express (LBR), a DTS variant no decoder package decodes
const DTS_EXPRESS_CODEC_STRING = 'dtse';

/** Matroska codec IDs and ISO BMFF sample entries that Mediabunny leaves without a codec */
const CONTAINER_AUDIO_CODECS: ReadonlyMap<unknown, ContainerAudioCodec> = new Map<unknown, ContainerAudioCodec>([
    [ QUICKTIME_DTS_SAMPLE_ENTRY, 'dts' ],
    [ 'A_MLP', 'mlp' ],
    [ 'A_TRUEHD', 'truehd' ],
    [ ISO_BASE_MEDIA_TRUEHD_SAMPLE_ENTRY, 'truehd' ]
]);

/**
 * Identifies a codec-less track by its container codec ID: TrueHD and MLP, which Mediabunny does not map, and the QuickTime DTS core entry; null for any other track.
 * Mediabunny maps every other DTS track itself.
 */
export function getContainerAudioCodec(codec: AudioCodec | null, internalCodecID: unknown): ContainerAudioCodec | null {
    if (codec !== null) {
        return null;
    }
    return CONTAINER_AUDIO_CODECS.get(internalCodecID) ?? null;
}

/** Returns whether a track is DTS Express, which Mediabunny maps to `dts` though no decoder package decodes it. */
export function isDTSExpressTrack(codec: AudioCodec | null, decoderConfig: AudioDecoderConfig | null): boolean {
    return codec === 'dts' && decoderConfig?.codec === DTS_EXPRESS_CODEC_STRING;
}

/**
 * Returns a track's declared rate, recovering the ISO BMFF sample entries whose rate field Mediabunny cannot read.
 * The decoder's own rate stays authoritative.
 */
export function getDeclaredAudioSampleRate(internalCodecID: unknown, sampleRate: number): number {
    if (isSupportedCustomAudioSampleRate(sampleRate)) {
        return sampleRate;
    }
    if (internalCodecID === ISO_BASE_MEDIA_TRUEHD_SAMPLE_ENTRY) {
        // Dolby TrueHD writes the whole field as an integer rate, which reads back as 16.16
        return sampleRate * ISO_BASE_MEDIA_SAMPLE_RATE_SCALE;
    }
    if (ISO_BASE_MEDIA_DTS_SAMPLE_ENTRIES.has(internalCodecID) && sampleRate === 0) {
        // The 16-bit integer part cannot hold 96 or 192 kHz, so muxers write zero
        return DTS_CORE_SAMPLE_RATE;
    }
    return sampleRate;
}

/** The channel count a track is screened with, the WAVE mask that lays its channels out or null to lay them out by count, and their layout. */
export type DeclaredAudioChannelLayout = Readonly<{
    channelCount: number
    channelMask: number | null
    layout: CustomAudioChannelLayout
}>;

/**
 * Resolves the layout a track is screened with from its container's channel count and mask and the host's media metadata.
 * A mask the container declares decides, and must name as many speakers as the track has channels, else the track is refused rather than played in the wrong
 * speakers.
 * Without one, the metadata's mask lays the channels out when it names the container's count: a decoder without a mask cannot tell a 2.1 FLAC from 3.0.
 * Otherwise the container's count lays them out, or the metadata's count when the container's has no layout, as a Matroska header that declares its first
 * frame's channels can; the decoded layout stays authoritative at runtime.
 */
export function resolveDeclaredAudioChannelLayout(
    channelCount: number,
    containerChannelMask: number | null,
    metadataLayout: CustomDecodeAudioMetadataLayout | null
): Readonly<{ status: 'failed', failure: string }> | (DeclaredAudioChannelLayout & Readonly<{ status: 'resolved' }>) {
    // A zero mask declares no speaker positions
    if (containerChannelMask !== null && containerChannelMask !== 0) {
        const qualifiedLayout = getQualifiedCustomWaveChannelLayout(containerChannelMask);
        return qualifiedLayout?.channelCount === channelCount ?
            { channelCount, channelMask: containerChannelMask, layout: qualifiedLayout.layout, status: 'resolved' } :
            { failure: `The selected audio channel mask is unqualified: 0x${containerChannelMask.toString(16)}`, status: 'failed' };
    }
    const metadataMask = metadataLayout?.channelMask;
    const metadataMaskLayout = metadataMask === undefined ? null : getQualifiedCustomWaveChannelLayout(metadataMask);
    if (metadataMask !== undefined && metadataMaskLayout?.channelCount === channelCount) {
        return { channelCount, channelMask: metadataMask, layout: metadataMaskLayout.layout, status: 'resolved' };
    }
    const countLayout = getCustomAudioChannelLayout(channelCount);
    if (countLayout) {
        return { channelCount, channelMask: null, layout: countLayout, status: 'resolved' };
    }
    const metadataCountLayout = metadataLayout ? getCustomAudioChannelLayout(metadataLayout.channelCount) : null;
    return metadataLayout && metadataCountLayout ?
        { channelCount: metadataLayout.channelCount, channelMask: null, layout: metadataCountLayout, status: 'resolved' } :
        { failure: 'The selected audio channel layout is unavailable', status: 'failed' };
}

// The beds the native media route's probes qualify: stereo and 5.1
const NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS: ReadonlySet<number> = new Set([ 2, 6 ]);

/**
 * Returns the bed the native media route plays an AC-3 or E-AC-3 track at: its declared one when the route's probes qualify it, else the metadata's.
 * The browser's decoder reads each syncframe's own bed, so a track whose container declares the 3/2 of its first syncframes plays at the 5.1 Jellyfin
 * probed; null when neither is a qualified bed.
 */
export function getNativeMediaAudioChannelCount(declaredChannelCount: number, metadataChannelCount: number | null): number | null {
    if (NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS.has(declaredChannelCount)) {
        return declaredChannelCount;
    }
    return metadataChannelCount !== null && NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS.has(metadataChannelCount) ? metadataChannelCount : null;
}

/**
 * Returns the timestamp jitter an audio route absorbs before one source sample: the larger of the codec floor and one container timestamp tick, plus an allowance for access units that decode to no PCM.
 */
export function getAudioTimestampToleranceMicroseconds(
    timeResolution: number,
    codecFloorMicroseconds: number,
    accessUnitAllowanceMicroseconds: number
): number {
    const timestampTickMicroseconds = Number.isFinite(timeResolution) && timeResolution > 0 ?
        Math.ceil(MICROSECONDS_PER_SECOND / timeResolution) :
        0;
    return Math.max(codecFloorMicroseconds, timestampTickMicroseconds) + accessUnitAllowanceMicroseconds;
}
