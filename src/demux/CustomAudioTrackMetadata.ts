import type { AudioCodec } from 'mediabunny';

import { MICROSECONDS_PER_SECOND } from '../MediaTime';
import { isSupportedCustomAudioSampleRate } from '../audio/CustomAudioSampleRate';

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
