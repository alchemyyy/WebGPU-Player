import {
    CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
    CUSTOM_VIDEO_CODECS,
    CUSTOM_WEB_CODECS_AUDIO_CODECS,
    isCustomPackageVideoCodec,
    type CustomAudioCodec,
    type CustomVideoCodec
} from './CustomDecodeCapabilities';

export type CustomContainerCodecRule = Readonly<{
    audioCodecs: readonly CustomAudioCodec[]
    containerAliases: readonly string[]
    profileContainers: readonly string[]
    videoCodecs: readonly CustomVideoCodec[]
}>;

const CUSTOM_COMPRESSED_AUDIO_CODECS: readonly CustomAudioCodec[] = Object.freeze([
    ...CUSTOM_WEB_CODECS_AUDIO_CODECS,
    'ac3',
    'eac3'
]);
// The worker maps the dtsc, dtsh, dtsl, and mlpa sample entries Mediabunny leaves without a codec
const CUSTOM_ISO_BASE_MEDIA_AUDIO_CODECS: readonly CustomAudioCodec[] = Object.freeze([
    ...CUSTOM_COMPRESSED_AUDIO_CODECS,
    'dts',
    'truehd'
]);
const CUSTOM_ISO_BASE_MEDIA_PCM_AUDIO_CODECS: readonly CustomAudioCodec[] = Object.freeze([
    'pcm_s16le',
    'pcm_s16be',
    'pcm_s24le',
    'pcm_s24be',
    'pcm_s32le',
    'pcm_s32be',
    'pcm_f32le',
    'pcm_f32be',
    'pcm_f64le',
    'pcm_f64be'
]);
const CUSTOM_MATROSKA_AUDIO_CODECS: readonly CustomAudioCodec[] = Object.freeze([
    ...CUSTOM_COMPRESSED_AUDIO_CODECS,
    'dts',
    'mlp',
    'truehd',
    'pcm_u8',
    'pcm_s16le',
    'pcm_s16be',
    'pcm_s24le',
    'pcm_s24be',
    'pcm_s32le',
    'pcm_s32be',
    'pcm_f32le',
    'pcm_f64le'
]);
const CUSTOM_NATIVE_VIDEO_CODECS: readonly CustomVideoCodec[] = Object.freeze(
    CUSTOM_VIDEO_CODECS.filter((codec: CustomVideoCodec): boolean => !isCustomPackageVideoCodec(codec))
);
// The worker reads VC-1 from vc-1 sample entries, as SMPTE RP 2025 binds it to ISO base media files, MPEG-4 Part 2 from mp4v sample entries, and
// H.263 from s263 and h263 sample entries
const CUSTOM_ISO_BASE_MEDIA_VIDEO_CODECS: readonly CustomVideoCodec[] = Object.freeze([
    ...CUSTOM_NATIVE_VIDEO_CODECS,
    'vc1',
    'mpeg4',
    'h263'
]);
// The worker reads MPEG-1 and MPEG-2 from their own tracks, VC-1 and WMV3 from Video for Windows tracks, and MPEG-4 Part 2, H.263, and MS-MPEG4
// from their own tracks and Video for Windows tracks
const CUSTOM_MATROSKA_VIDEO_CODECS: readonly CustomVideoCodec[] = Object.freeze([
    ...CUSTOM_NATIVE_VIDEO_CODECS,
    'mpeg1video',
    'mpeg2video',
    'vc1',
    'wmv3',
    'mpeg4',
    'h263',
    'msmpeg4v1',
    'msmpeg4v2',
    'msmpeg4v3'
]);
export const CUSTOM_MATROSKA_PROFILE_CONTAINER = 'mkv';
// The fork's AVI demuxer gives H.264 and HEVC packets presentation timestamps from their pictures' order counts, and the worker restamps MPEG-4
// Part 2 B-VOPs; H.263 and MS-MPEG4 code no B pictures
const CUSTOM_AVI_VIDEO_CODECS: readonly CustomVideoCodec[] = Object.freeze([
    'h264',
    'hevc',
    'vp8',
    'vp9',
    'av1',
    'mpeg4',
    'h263',
    'msmpeg4v1',
    'msmpeg4v2',
    'msmpeg4v3'
]);
// The audio Mediabunny maps from WAVEFORMATEX or a WAVE_FORMAT_EXTENSIBLE SubFormat, with FLAC and Vorbis described by their strf extradata
const CUSTOM_AVI_AUDIO_CODECS: readonly CustomAudioCodec[] = Object.freeze([
    'aac',
    'mp3',
    'ac3',
    'flac',
    'vorbis',
    'pcm_u8',
    'pcm_s16le',
    'pcm_s24le',
    'pcm_s32le',
    'pcm_f32le',
    'pcm_f64le',
    'pcm_mulaw',
    'pcm_alaw'
]);

/**
 * Defines container compatibility independently of the selected decoder backends.
 * Exact codec and layout probes decide whether each track is supported; these rules only decide whether the container can carry them.
 */
export const CUSTOM_CONTAINER_CODEC_RULES: readonly CustomContainerCodecRule[] = Object.freeze([
    Object.freeze({
        audioCodecs: CUSTOM_ISO_BASE_MEDIA_AUDIO_CODECS,
        containerAliases: Object.freeze([ '3gp', '3g2', 'mj2' ]),
        profileContainers: Object.freeze([ 'mp4', 'm4v', 'mov' ]),
        videoCodecs: CUSTOM_ISO_BASE_MEDIA_VIDEO_CODECS
    }),
    Object.freeze({
        audioCodecs: CUSTOM_ISO_BASE_MEDIA_PCM_AUDIO_CODECS,
        containerAliases: Object.freeze([]),
        profileContainers: Object.freeze([ 'mp4', 'm4v', 'mov' ]),
        videoCodecs: CUSTOM_ISO_BASE_MEDIA_VIDEO_CODECS
    }),
    Object.freeze({
        audioCodecs: CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
        containerAliases: Object.freeze([]),
        profileContainers: Object.freeze([ 'mov' ]),
        videoCodecs: CUSTOM_ISO_BASE_MEDIA_VIDEO_CODECS
    }),
    Object.freeze({
        audioCodecs: Object.freeze([
            ...CUSTOM_COMPRESSED_AUDIO_CODECS,
            ...CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS
        ] as const),
        containerAliases: Object.freeze([]),
        profileContainers: Object.freeze([ 'mov', 'mj2' ]),
        videoCodecs: Object.freeze([ 'jpeg2000' ] as const)
    }),
    Object.freeze({
        audioCodecs: CUSTOM_MATROSKA_AUDIO_CODECS,
        containerAliases: Object.freeze([ 'matroska' ]),
        profileContainers: Object.freeze([ CUSTOM_MATROSKA_PROFILE_CONTAINER ]),
        videoCodecs: CUSTOM_MATROSKA_VIDEO_CODECS
    }),
    Object.freeze({
        audioCodecs: CUSTOM_AVI_AUDIO_CODECS,
        containerAliases: Object.freeze([]),
        profileContainers: Object.freeze([ 'avi' ]),
        videoCodecs: CUSTOM_AVI_VIDEO_CODECS
    }),
    Object.freeze({
        audioCodecs: Object.freeze([ 'opus', 'vorbis' ] as const),
        containerAliases: Object.freeze([]),
        profileContainers: Object.freeze([ 'webm' ]),
        videoCodecs: Object.freeze([ 'vp8', 'vp9', 'av1' ] as const)
    }),
    Object.freeze({
        // The fork's demuxer reads DTS by its stream types and descriptors, a Blu-ray program's DTS-HD among them
        audioCodecs: Object.freeze([ 'aac', 'mp3', 'ac3', 'eac3', 'dts' ] as const),
        containerAliases: Object.freeze([]),
        profileContainers: Object.freeze([ 'ts', 'm2ts', 'mts' ]),
        // The fork's demuxer reads MPEG-1, MPEG-2, and VC-1 streams, which the worker gives their first sequence header's extradata
        videoCodecs: Object.freeze([ 'h264', 'hevc', 'mpeg1video', 'mpeg2video', 'vc1' ] as const)
    })
]);

const customProfileVideoContainers: string[] = [];
for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
    for (const container of rule.profileContainers) {
        if (!customProfileVideoContainers.includes(container)) {
            customProfileVideoContainers.push(container);
        }
    }
}

export const CUSTOM_PROFILE_VIDEO_CONTAINERS: readonly string[] = Object.freeze(customProfileVideoContainers);

function ruleContainsContainer(rule: CustomContainerCodecRule, normalizedContainer: string): boolean {
    return rule.profileContainers.some(container => container.toUpperCase() === normalizedContainer)
        || rule.containerAliases.some(container => container.toUpperCase() === normalizedContainer);
}

/** Returns whether any custom route owns the container token, ignoring case and surrounding whitespace. */
export function isCustomPlaybackContainer(container: string): boolean {
    const normalizedContainer: string = container.trim().toUpperCase();
    return CUSTOM_CONTAINER_CODEC_RULES.some(rule => ruleContainsContainer(rule, normalizedContainer));
}

/** Returns every profile container whose rules carry the audio codec, in rule order. */
export function getCustomAudioCodecProfileContainers(audioCodec: CustomAudioCodec): readonly string[] {
    const containers: string[] = [];
    for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
        if (!rule.audioCodecs.includes(audioCodec)) {
            continue;
        }
        for (const container of rule.profileContainers) {
            if (!containers.includes(container)) {
                containers.push(container);
            }
        }
    }
    return containers;
}

/** Composes independently supported tracks only when their container permits both. */
export function supportsCustomContainerCodecCombination(
    containers: readonly string[],
    videoCodec: CustomVideoCodec,
    audioCodec: CustomAudioCodec | null
): boolean {
    for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
        const containerSupported: boolean = containers.some(container => ruleContainsContainer(rule, container.trim().toUpperCase()));
        if (!containerSupported
            || !rule.videoCodecs.includes(videoCodec)
            || (audioCodec !== null && !rule.audioCodecs.includes(audioCodec))) {
            continue;
        }
        return true;
    }
    return false;
}
