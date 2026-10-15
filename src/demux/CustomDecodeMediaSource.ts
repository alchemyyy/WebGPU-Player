/**
 * The media a playback reads: a URL that Mediabunny's UrlSource fetches in byte ranges, or a local file that its BlobSource reads.
 * A file crosses to the decode worker by structured clone, which shares its bytes instead of copying them.
 */
export type CustomDecodeMediaSource =
    | { file: File, kind: 'file' }
    | {
        /**
         * The URL paths of a cross-origin endpoint whose 206 responses hide Content-Range, as a media server's stream endpoint may.
         * Such a response passes on its status and a Content-Length within the requested range; without a pattern, every 206 must show its Content-Range.
         * The host that knows the endpoint sets it; it crosses to the decode worker by structured clone.
         */
        hiddenContentRangePathPattern?: RegExp
        kind: 'url'
        url: string
    };

// Flags that make RegExp.test read and write lastIndex, so one pattern would match a path only every other time
const STATEFUL_REGEXP_FLAGS: readonly string[] = [ 'g', 'y' ];

/** Returns whether a value is a pattern whose test keeps no state between calls: a RegExp without the global or sticky flag. */
function isStatelessPattern(value: unknown): value is RegExp {
    return value instanceof RegExp && !STATEFUL_REGEXP_FLAGS.some((flag: string): boolean => value.flags.includes(flag));
}

/** Validates a media source received across a module or worker boundary: a File, or a non-empty URL with an optional stateless path pattern. */
export function isCustomDecodeMediaSource(value: unknown): value is CustomDecodeMediaSource {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const source = value as Record<string, unknown>;
    switch (source.kind) {
        case 'file':
            return typeof File === 'function' && source.file instanceof File;
        case 'url':
            return typeof source.url === 'string'
                && source.url.length > 0
                && (source.hiddenContentRangePathPattern === undefined || isStatelessPattern(source.hiddenContentRangePathPattern));
        default:
            return false;
    }
}
