import { describe, expect, it } from 'vitest';

import { isCustomDecodeMediaSource } from 'webgpu-player/demux/CustomDecodeMediaSource';

const STREAM_URL = 'https://media.example/server/Videos/item-id/stream.mkv';
const LOCAL_FILE_NAME = 'movie.mkv';
// A host's path pattern for responses that hide Content-Range, and the same pattern with a flag that makes RegExp.test keep state
const HIDDEN_CONTENT_RANGE_PATH_PATTERN = /\/Videos\/[^/]+\/stream(?:\.[^/]+)?$/i;
const GLOBAL_PATH_PATTERN = /\/Videos\/[^/]+\/stream(?:\.[^/]+)?$/gi;
const STICKY_PATH_PATTERN = /\/Videos\/[^/]+\/stream(?:\.[^/]+)?$/iy;
const PATTERN_SOURCE_TEXT = '/Videos/[^/]+/stream$';

describe('isCustomDecodeMediaSource', () => {
    it('takes a URL source with or without a stateless path pattern, and a file source', () => {
        expect(isCustomDecodeMediaSource({ kind: 'url', url: STREAM_URL })).toBe(true);
        expect(isCustomDecodeMediaSource({ hiddenContentRangePathPattern: HIDDEN_CONTENT_RANGE_PATH_PATTERN, kind: 'url', url: STREAM_URL })).toBe(true);
        expect(isCustomDecodeMediaSource({ file: new File([], LOCAL_FILE_NAME), kind: 'file' })).toBe(true);
    });

    it('refuses a path pattern that is no RegExp, or one whose test keeps state between calls', () => {
        expect(isCustomDecodeMediaSource({ hiddenContentRangePathPattern: PATTERN_SOURCE_TEXT, kind: 'url', url: STREAM_URL })).toBe(false);
        expect(isCustomDecodeMediaSource({ hiddenContentRangePathPattern: GLOBAL_PATH_PATTERN, kind: 'url', url: STREAM_URL })).toBe(false);
        expect(isCustomDecodeMediaSource({ hiddenContentRangePathPattern: STICKY_PATH_PATTERN, kind: 'url', url: STREAM_URL })).toBe(false);
        expect(isCustomDecodeMediaSource({ hiddenContentRangePathPattern: null, kind: 'url', url: STREAM_URL })).toBe(false);
    });

    it('refuses an empty URL and an unknown kind', () => {
        expect(isCustomDecodeMediaSource({ kind: 'url', url: '' })).toBe(false);
        expect(isCustomDecodeMediaSource({ kind: 'stream', url: STREAM_URL })).toBe(false);
        expect(isCustomDecodeMediaSource(null)).toBe(false);
    });

    it('keeps a path pattern through structured clone, as the source crosses to the decode worker', () => {
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated, and its worker receives the source by structured clone
        const source = structuredClone({ hiddenContentRangePathPattern: HIDDEN_CONTENT_RANGE_PATH_PATTERN, kind: 'url', url: STREAM_URL });

        expect(isCustomDecodeMediaSource(source)).toBe(true);
        expect(source.hiddenContentRangePathPattern.test(new URL(STREAM_URL).pathname)).toBe(true);
    });
});
