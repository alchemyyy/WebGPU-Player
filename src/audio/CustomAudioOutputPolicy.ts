import {
    CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
    type CustomAudioCodec,
    type CustomMediabunnyPCMAudioCodec
} from './CustomAudioCodec';
import {
    CUSTOM_AUDIO_OUTPUT_LAYOUTS,
    CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT,
    CUSTOM_FIVE_POINT_ZERO_INPUT_CHANNEL_COUNT,
    CUSTOM_MONO_INPUT_CHANNEL_COUNT,
    CUSTOM_STEREO_INPUT_CHANNEL_COUNT,
    CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT,
    CUSTOM_SEVEN_POINT_ONE_INPUT_CHANNEL_COUNT,
    CUSTOM_THREE_CHANNEL_INPUT_CHANNEL_COUNT,
    getCustomAudioOutputChannelCount,
    getCustomAudioOutputChannelLayout,
    type CustomAudioChannelLayout,
    type CustomAudioOutputLayout
} from './processing/CustomAudioChannelLayout';
import {
    DTS_SUPPORTED_INPUT_ROUTES,
    EAC3_SUPPORTED_INPUT_ROUTES,
    TRUEHD_SUPPORTED_INPUT_ROUTES,
    hasCustomAudioMetadataLayout,
    isSupportedTrueHDInputRoute
} from './CustomCompressedAudioRoute';
import { isSupportedCustomAudioSampleRate } from './CustomAudioSampleRate';

export const CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT = CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
export const CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE = 48_000;
export const CUSTOM_AUDIO_OUTPUT_CHANNEL_INTERPRETATION = 'speakers' as const;
/** The worklet ring holds this much output, shared by every in-flight audio credit */
export const CUSTOM_AUDIO_OUTPUT_BUFFERED_SECONDS = 2;
export const CUSTOM_SURROUND_INPUT_CHANNEL_COUNT = CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT;
export { CUSTOM_STEREO_INPUT_CHANNEL_COUNT };
/** The channel counts of the output layouts: stereo, 5.1, 7.1 and 5.1.2, 5.1.4 and 7.1.2, and 7.1.4 */
export const CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNTS: readonly number[] = Object.freeze([
    ...new Set(CUSTOM_AUDIO_OUTPUT_LAYOUTS.map(getCustomAudioOutputChannelCount))
]);
/** The codecs whose decoder packages may render object audio into the output layout: E-AC-3 with JOC and TrueHD with Atmos */
export const CUSTOM_OBJECT_AUDIO_CODECS: readonly CustomAudioCodec[] = Object.freeze([ 'eac3', 'truehd' ]);
/** The source layouts every decoded PCM route covers without multichannel evidence */
export const CUSTOM_NON_SURROUND_INPUT_CHANNEL_COUNTS: readonly number[] = Object.freeze([
    CUSTOM_MONO_INPUT_CHANNEL_COUNT,
    CUSTOM_STEREO_INPUT_CHANNEL_COUNT
]);

export const MEDIABUNNY_PCM_DECODER_CODECS = [
    'pcm-s16',
    'pcm-s16be',
    'pcm-s24',
    'pcm-s24be',
    'pcm-s32',
    'pcm-s32be',
    'pcm-f32',
    'pcm-f32be',
    'pcm-f64',
    'pcm-f64be',
    'pcm-u8',
    'pcm-s8',
    'ulaw',
    'alaw'
] as const;

export type MediabunnyPCMDecoderCodec = typeof MEDIABUNNY_PCM_DECODER_CODECS[number];

function getSortedChannelCounts(channelCounts: readonly number[]): readonly number[] {
    return [ ...new Set(channelCounts) ].sort((firstChannelCount, secondChannelCount) => firstChannelCount - secondChannelCount);
}

// Decoders without a speaker mask deliver three channels as 3.0, which the mixer places by name
const CUSTOM_SURROUND_INPUT_CHANNEL_COUNTS: readonly number[] = [
    CUSTOM_MONO_INPUT_CHANNEL_COUNT,
    CUSTOM_STEREO_INPUT_CHANNEL_COUNT,
    CUSTOM_THREE_CHANNEL_INPUT_CHANNEL_COUNT,
    CUSTOM_SURROUND_INPUT_CHANNEL_COUNT
];
// The WebCodecs surround decoders also decode 7.1 in WAVE order; eligibility asks the codec's 5.1 verdict for 6 channels and its 7.1 verdict for 8
const CUSTOM_WEBCODECS_SURROUND_INPUT_CHANNEL_COUNTS: readonly number[] = Object.freeze([
    ...CUSTOM_SURROUND_INPUT_CHANNEL_COUNTS,
    CUSTOM_SEVEN_POINT_ONE_INPUT_CHANNEL_COUNT
]);
// Three-channel AC-3 transcodes: 2/1 and 3/0 both reach Jellyfin as "3.0", which drops the "(back)" suffix, and no evidence covers either bed.
// Five channels play as 3/2, which the package reports as 5.0(side) and which may gain its LFE mid-stream, as the output stage rebinds to, or as 3/1 with
// an LFE, FFmpeg's 4.1; a 2/2 bed with an LFE reports a mask no layout has and fails its attempt.
const CUSTOM_AC3_INPUT_CHANNEL_COUNTS: readonly number[] = [
    CUSTOM_MONO_INPUT_CHANNEL_COUNT,
    CUSTOM_STEREO_INPUT_CHANNEL_COUNT,
    CUSTOM_FIVE_POINT_ZERO_INPUT_CHANNEL_COUNT,
    CUSTOM_SURROUND_INPUT_CHANNEL_COUNT
];
const CUSTOM_EAC3_INPUT_CHANNEL_COUNTS = getSortedChannelCounts(EAC3_SUPPORTED_INPUT_ROUTES.map(route => route.channelCount));
const CUSTOM_DTS_INPUT_CHANNEL_COUNTS = getSortedChannelCounts(DTS_SUPPORTED_INPUT_ROUTES.map(route => route.channelCount));
const CUSTOM_TRUEHD_INPUT_CHANNEL_COUNTS = getSortedChannelCounts(
    TRUEHD_SUPPORTED_INPUT_ROUTES
        .filter(route => route.codec === 'truehd')
        .map(route => route.channelCount)
);
const CUSTOM_MLP_INPUT_CHANNEL_COUNTS = getSortedChannelCounts(
    TRUEHD_SUPPORTED_INPUT_ROUTES
        .filter(route => route.codec === 'mlp')
        .map(route => route.channelCount)
);
// FFmpeg's WMA v1 and v2 decoder takes at most two channels, and its WMA Voice decoder one
const CUSTOM_WMA_INPUT_CHANNEL_COUNTS: readonly number[] = CUSTOM_NON_SURROUND_INPUT_CHANNEL_COUNTS;
const CUSTOM_WMA_VOICE_INPUT_CHANNEL_COUNTS: readonly number[] = Object.freeze([ CUSTOM_MONO_INPUT_CHANNEL_COUNT ]);
// WMA Pro and WMA Lossless declare their speaker mask, which a package reports: the beds the output stage lays out, without 6.1, which no route presents
const CUSTOM_WMA_PRO_INPUT_CHANNEL_COUNTS: readonly number[] = Object.freeze([
    CUSTOM_MONO_INPUT_CHANNEL_COUNT,
    CUSTOM_STEREO_INPUT_CHANNEL_COUNT,
    CUSTOM_THREE_CHANNEL_INPUT_CHANNEL_COUNT,
    CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT,
    CUSTOM_SEVEN_POINT_ONE_INPUT_CHANNEL_COUNT
]);
const CUSTOM_PCM_INPUT_CHANNEL_COUNTS: readonly number[] = CUSTOM_SURROUND_INPUT_CHANNEL_COUNTS;
const CUSTOM_THREE_CHANNEL_METADATA_LAYOUTS: readonly string[] = Object.freeze([ '3.0' ]);
const CUSTOM_MEDIABUNNY_PCM_AUDIO_CODEC_SET = new Set<string>(CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS);
const MEDIABUNNY_PCM_DECODER_CODEC_SET = new Set<string>(MEDIABUNNY_PCM_DECODER_CODECS);

/** Identifies Jellyfin metadata names backed by Mediabunny's PCM decoders. */
export function isCustomMediabunnyPCMAudioCodec(codec: string): codec is CustomMediabunnyPCMAudioCodec {
    return CUSTOM_MEDIABUNNY_PCM_AUDIO_CODEC_SET.has(codec);
}

/** Identifies the codec names returned by Mediabunny input tracks. */
export function isMediabunnyPCMDecoderCodec(codec: string): codec is MediabunnyPCMDecoderCodec {
    return MEDIABUNNY_PCM_DECODER_CODEC_SET.has(codec);
}

/** Returns the source layouts covered by the codec's decoded PCM route. */
export function getSupportedCustomAudioInputChannelCounts(codec: CustomAudioCodec): readonly number[] {
    if (isCustomMediabunnyPCMAudioCodec(codec)) {
        return CUSTOM_PCM_INPUT_CHANNEL_COUNTS;
    }
    switch (codec) {
        case 'aac':
        case 'flac':
        case 'opus':
        case 'vorbis':
            return CUSTOM_WEBCODECS_SURROUND_INPUT_CHANNEL_COUNTS;
        case 'ac3':
            return CUSTOM_AC3_INPUT_CHANNEL_COUNTS;
        case 'eac3':
            return CUSTOM_EAC3_INPUT_CHANNEL_COUNTS;
        case 'dts':
            return CUSTOM_DTS_INPUT_CHANNEL_COUNTS;
        case 'mlp':
            return CUSTOM_MLP_INPUT_CHANNEL_COUNTS;
        case 'truehd':
            return CUSTOM_TRUEHD_INPUT_CHANNEL_COUNTS;
        case 'mp3':
            return CUSTOM_NON_SURROUND_INPUT_CHANNEL_COUNTS;
        case 'wmav1':
        case 'wmav2':
            return CUSTOM_WMA_INPUT_CHANNEL_COUNTS;
        case 'wmapro':
        case 'wmalossless':
            return CUSTOM_WMA_PRO_INPUT_CHANNEL_COUNTS;
        case 'wmavoice':
            return CUSTOM_WMA_VOICE_INPUT_CHANNEL_COUNTS;
    }
}

/** Accepts source layouts with a complete decoded PCM presentation path. */
export function isSupportedCustomAudioInputLayout(
    codec: string,
    channelCount: unknown,
    sampleRate: unknown
): boolean {
    if (typeof channelCount !== 'number' || !isSupportedCustomAudioSampleRate(sampleRate)) {
        return false;
    }

    if (isCustomMediabunnyPCMAudioCodec(codec) || isMediabunnyPCMDecoderCodec(codec)) {
        return CUSTOM_PCM_INPUT_CHANNEL_COUNTS.includes(channelCount);
    }

    switch (codec) {
        case 'aac':
        case 'flac':
        case 'opus':
        case 'vorbis':
            return CUSTOM_WEBCODECS_SURROUND_INPUT_CHANNEL_COUNTS.includes(channelCount);
        case 'ac3':
            return CUSTOM_AC3_INPUT_CHANNEL_COUNTS.includes(channelCount);
        case 'eac3':
            return CUSTOM_EAC3_INPUT_CHANNEL_COUNTS.includes(channelCount);
        case 'dts':
            return CUSTOM_DTS_INPUT_CHANNEL_COUNTS.includes(channelCount);
        case 'mlp':
        case 'truehd':
            return isSupportedTrueHDInputRoute(codec, channelCount, sampleRate);
        case 'mp3':
            return CUSTOM_NON_SURROUND_INPUT_CHANNEL_COUNTS.includes(channelCount);
        case 'wmav1':
        case 'wmav2':
            return CUSTOM_WMA_INPUT_CHANNEL_COUNTS.includes(channelCount);
        case 'wmapro':
        case 'wmalossless':
            return CUSTOM_WMA_PRO_INPUT_CHANNEL_COUNTS.includes(channelCount);
        case 'wmavoice':
            return CUSTOM_WMA_VOICE_INPUT_CHANNEL_COUNTS.includes(channelCount);
        default:
            return false;
    }
}

/**
 * Adds Jellyfin ChannelLayout qualification for decoders that report no speaker mask: a three-channel source must be 3.0, the order they decode to.
 */
export function isSupportedCustomAudioInputMetadataLayout(
    codec: string,
    channelCount: unknown,
    sampleRate: unknown,
    channelLayout: unknown
): boolean {
    return isSupportedCustomAudioInputLayout(codec, channelCount, sampleRate)
        && (channelCount !== CUSTOM_THREE_CHANNEL_INPUT_CHANNEL_COUNT
            || hasCustomAudioMetadataLayout(channelLayout, CUSTOM_THREE_CHANNEL_METADATA_LAYOUTS));
}

/**
 * Accepts a decoded layout a package rendered object audio into: an E-AC-3 or TrueHD package renders into the output layout, heights included,
 * which the codec's input routes do not list.
 */
export function isSupportedCustomAudioRenderedLayout(codec: string, layout: CustomAudioChannelLayout, sampleRate: unknown): boolean {
    return CUSTOM_OBJECT_AUDIO_CODECS.includes(codec as CustomAudioCodec)
        && isSupportedCustomAudioSampleRate(sampleRate)
        && CUSTOM_AUDIO_OUTPUT_LAYOUTS.some(
            (outputLayout: CustomAudioOutputLayout): boolean => getCustomAudioOutputChannelLayout(outputLayout).id === layout.id
        );
}

/** Accepts the stereo, 5.1, 7.1, and height worklet layouts at 48 kHz: 2, 6, 8, 10, or 12 channels. */
export function isSupportedCustomAudioOutputLayout(channelCount: unknown, sampleRate: unknown): boolean {
    return typeof channelCount === 'number'
        && CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNTS.includes(channelCount)
        && sampleRate === CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE;
}

/** Rejects decoded output that exceeds the measured audio presentation route. */
export function assertSupportedCustomAudioOutputLayout(channelCount: unknown, sampleRate: unknown): void {
    if (!isSupportedCustomAudioOutputLayout(channelCount, sampleRate)) {
        throw new RangeError(`Custom audio output requires 2, 6, 8, 10, or 12 channels at ${CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE} Hz`);
    }
}
