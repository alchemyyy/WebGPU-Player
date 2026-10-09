import type { AudioCodec } from 'mediabunny';

import type { TrueHDDecoderCodec } from './decoders/TrueHDSoftwareAudioDecoder';
import { isSupportedCustomAudioSampleRate } from './CustomAudioSampleRate';

const MICROSECONDS_PER_SECOND = 1_000_000;
// ISO BMFF audio sample entries store their rate as 16.16 fixed point
const ISO_BASE_MEDIA_SAMPLE_RATE_SCALE = 0x1_0000;
// The DTS core always runs at 48 kHz, whatever rate its extensions reach
const DTS_CORE_SAMPLE_RATE = 48_000;
const ISO_BASE_MEDIA_TRUEHD_SAMPLE_ENTRY = 'mlpa';

export type BundledAudioDecoderCodec = 'dts' | TrueHDDecoderCodec;

// DTS core, DTS-HD with a core, and DTS-HD lossless; not dtse (LBR) or dtsx (DTS-UHD), which libdcadec cannot decode
const ISO_BASE_MEDIA_DTS_SAMPLE_ENTRIES: ReadonlySet<unknown> = new Set<unknown>([
    // QuickTime muxers write the DTS core entry with a trailing space
    'DTS ',
    'dtsc',
    'dtsh',
    'dtsl'
]);

/** Matroska codec IDs and ISO BMFF sample entries that Mediabunny leaves without a codec */
const BUNDLED_AUDIO_DECODER_CODECS: ReadonlyMap<unknown, BundledAudioDecoderCodec> = new Map<unknown, BundledAudioDecoderCodec>([
    [ 'A_DTS', 'dts' ],
    ...[ ...ISO_BASE_MEDIA_DTS_SAMPLE_ENTRIES ].map((sampleEntry): [ unknown, BundledAudioDecoderCodec ] => [ sampleEntry, 'dts' ]),
    [ 'A_MLP', 'mlp' ],
    [ 'A_TRUEHD', 'truehd' ],
    [ ISO_BASE_MEDIA_TRUEHD_SAMPLE_ENTRY, 'truehd' ]
]);

/** Identifies a track the bundled DTS or TrueHD decoders own, since Mediabunny maps neither codec. */
export function getBundledAudioDecoderCodec(codec: AudioCodec | null, internalCodecID: unknown): BundledAudioDecoderCodec | null {
    if (codec !== null) {
        return null;
    }
    return BUNDLED_AUDIO_DECODER_CODECS.get(internalCodecID) ?? null;
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
