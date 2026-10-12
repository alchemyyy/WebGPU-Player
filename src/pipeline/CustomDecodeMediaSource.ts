/**
 * The media a playback reads: a URL that Mediabunny's UrlSource fetches in byte ranges, or a local file that its BlobSource reads.
 * A file crosses to the decode worker by structured clone, which shares its bytes instead of copying them.
 */
export type CustomDecodeMediaSource =
    | { file: File, kind: 'file' }
    | { kind: 'url', url: string };

/** Validates a media source received across a module or worker boundary: a File, or a non-empty URL. */
export function isCustomDecodeMediaSource(value: unknown): value is CustomDecodeMediaSource {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const source = value as Record<string, unknown>;
    switch (source.kind) {
        case 'file':
            return typeof File === 'function' && source.file instanceof File;
        case 'url':
            return typeof source.url === 'string' && source.url.length > 0;
        default:
            return false;
    }
}
