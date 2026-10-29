export const CUSTOM_WEB_CODECS_AUDIO_CODECS = [
    'aac',
    'opus',
    'flac',
    'mp3',
    'vorbis'
] as const;

export const CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS = [
    'pcm_s16le',
    'pcm_s16be',
    'pcm_s24le',
    'pcm_s24be',
    'pcm_s32le',
    'pcm_s32be',
    'pcm_f32le',
    'pcm_f32be',
    'pcm_f64le',
    'pcm_f64be',
    'pcm_u8',
    'pcm_s8',
    'pcm_mulaw',
    'pcm_alaw'
] as const;

/** The codecs the engine has no decoder of: the browser's media element plays them, or a host's decoder package decodes them to PCM. */
export const CUSTOM_PACKAGE_AUDIO_CODECS = [
    'ac3',
    'eac3',
    'dts',
    'mlp',
    'truehd',
    'wmav1',
    'wmav2',
    'wmapro',
    'wmalossless',
    'wmavoice'
] as const;

export const CUSTOM_AUDIO_CODECS = [
    ...CUSTOM_WEB_CODECS_AUDIO_CODECS,
    ...CUSTOM_PACKAGE_AUDIO_CODECS,
    ...CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS
] as const;

export type CustomAudioCodec = typeof CUSTOM_AUDIO_CODECS[number];
export type CustomWebCodecsAudioCodec = typeof CUSTOM_WEB_CODECS_AUDIO_CODECS[number];
export type CustomMediabunnyPCMAudioCodec = typeof CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS[number];
export type CustomPackageAudioCodec = typeof CUSTOM_PACKAGE_AUDIO_CODECS[number];
