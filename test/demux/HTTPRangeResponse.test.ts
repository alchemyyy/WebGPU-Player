import { describe, expect, it } from 'vitest';

import {
    requireValidByteRangeResponse,
    UnsupportedRangeResponseError
} from 'webgpu-player/demux/HTTPRangeResponse';

type RangeCase = {
    contentLength?: string | null
    contentRange: string | null
    range: string
    status?: number
    type?: ResponseType
    url?: string
};

// A host's stream endpoint whose cross-origin 206 responses hide Content-Range, the path pattern the host sets for it, and a URL it names
const HIDDEN_CONTENT_RANGE_PATH_PATTERN = /\/Videos\/[^/]+\/stream(?:\.[^/]+)?$/i;
const STREAM_URL = 'https://media.example/server/Videos/item-id/stream.mkv';
const CORS_HIDDEN_RANGE = 'bytes=100-199';
const CORS_HIDDEN_CONTENT_LENGTH = '100';

function createResponse(
    status: number,
    contentRange: string | null,
    onCancel?: () => void,
    contentLength: string | null = null,
    type: ResponseType = 'basic',
    url = STREAM_URL
): Response {
    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
    const headers = new Headers();
    if (contentRange !== null) {
        headers.set('Content-Range', contentRange);
    }
    if (contentLength !== null) {
        headers.set('Content-Length', contentLength);
    }
    const body = onCancel ? {
        cancel: (): Promise<void> => {
            onCancel();
            return Promise.resolve();
        }
    } as ReadableStream<Uint8Array> : null;

    return {
        body,
        headers,
        status,
        type,
        url
    } as unknown as Response;
}

describe('requireValidByteRangeResponse', () => {
    it.each<RangeCase>([
        { contentRange: 'bytes 100-199/1000', range: 'bytes=100-199' },
        { contentRange: 'bytes 900-999/1000', range: 'bytes=900-1200' },
        { contentRange: 'bytes 100-199/*', range: 'bytes=100-199' },
        { contentRange: 'bytes 100-999/1000', range: 'bytes=100-' },
        { contentRange: 'bytes 100-199/*', range: 'bytes=100-' },
        { contentRange: 'bytes 500-999/1000', range: 'bytes=-500' },
        { contentRange: 'bytes 0-199/200', range: 'bytes=-500' }
    ])('accepts $range matched by $contentRange', ({ contentRange, range }) => {
        let bodyCancelled = false;
        const response = createResponse(206, contentRange, () => {
            bodyCancelled = true;
        });

        requireValidByteRangeResponse(range, response, HIDDEN_CONTENT_RANGE_PATH_PATTERN);

        expect(bodyCancelled).toBe(false);
    });

    it.each<RangeCase>([
        {
            contentLength: '69007285982',
            contentRange: null,
            range: 'bytes=0-',
            type: 'cors'
        },
        {
            contentLength: '69007285882',
            contentRange: null,
            range: 'bytes=100-',
            type: 'cors'
        },
        {
            contentLength: '100',
            contentRange: null,
            range: 'bytes=100-199',
            type: 'cors'
        },
        {
            contentLength: '50',
            contentRange: null,
            range: 'bytes=950-1200',
            type: 'cors'
        },
        {
            contentLength: '500',
            contentRange: null,
            range: 'bytes=-500',
            type: 'cors'
        }
    ])(
        'accepts CORS-hidden Content-Range for $range with length $contentLength',
        ({ contentLength = null, contentRange, range, type = 'basic' }) => {
            let bodyCancelled = false;
            const response = createResponse(206, contentRange, () => {
                bodyCancelled = true;
            }, contentLength, type);

            requireValidByteRangeResponse(range, response, HIDDEN_CONTENT_RANGE_PATH_PATTERN);

            expect(bodyCancelled).toBe(false);
        }
    );

    it('rejects a CORS-hidden Content-Range when the source names no path pattern, as a host that knows no such endpoint leaves it', () => {
        let bodyCancelled = false;
        const response = createResponse(206, null, () => {
            bodyCancelled = true;
        }, CORS_HIDDEN_CONTENT_LENGTH, 'cors');

        expect(() => requireValidByteRangeResponse(CORS_HIDDEN_RANGE, response, null)).toThrow(UnsupportedRangeResponseError);
        expect(bodyCancelled).toBe(true);
    });

    it.each<RangeCase>([
        { contentRange: 'bytes 100-199/1000', range: 'bytes=100-199', status: 200 },
        {
            contentLength: '69007285982',
            contentRange: null,
            range: 'bytes=0-',
            status: 200,
            type: 'cors'
        },
        { contentRange: null, range: 'bytes=100-199' },
        { contentRange: '100-199/1000', range: 'bytes=100-199' },
        { contentRange: 'bytes 101-199/1000', range: 'bytes=100-199' },
        { contentRange: 'bytes 100-150/1000', range: 'bytes=100-199' },
        { contentRange: 'bytes 100-250/1000', range: 'bytes=100-199' },
        { contentRange: 'bytes 900-950/1000', range: 'bytes=900-1200' },
        { contentRange: 'bytes 100-199/150', range: 'bytes=100-199' },
        { contentRange: 'bytes 500-999/*', range: 'bytes=-500' },
        { contentRange: 'bytes 501-999/1000', range: 'bytes=-500' },
        { contentRange: 'bytes 100-998/1000', range: 'bytes=100-' },
        { contentRange: 'bytes 100-199/1000', range: 'bytes=100-199,300-399' },
        { contentRange: 'bytes 100-199/1000', range: 'bytes=199-100' },
        {
            contentRange: 'bytes 0-1/2',
            range: 'bytes=9007199254740992-9007199254740992'
        },
        { contentLength: '100', contentRange: null, range: 'bytes=0-', type: 'basic' },
        { contentLength: null, contentRange: null, range: 'bytes=0-', type: 'cors' },
        { contentLength: '0', contentRange: null, range: 'bytes=0-', type: 'cors' },
        { contentLength: '-1', contentRange: null, range: 'bytes=0-', type: 'cors' },
        { contentLength: '101', contentRange: null, range: 'bytes=100-199', type: 'cors' },
        { contentLength: '501', contentRange: null, range: 'bytes=-500', type: 'cors' },
        {
            contentLength: '2',
            contentRange: null,
            range: 'bytes=9007199254740990-',
            type: 'cors'
        },
        {
            contentLength: '100',
            contentRange: 'malformed',
            range: 'bytes=0-',
            type: 'cors'
        },
        {
            contentLength: '100',
            contentRange: null,
            range: 'bytes=0-99',
            type: 'cors',
            url: 'https://media.example/external/video.mkv'
        }
    ])('rejects $range with $contentRange', ({
        contentLength = null,
        contentRange,
        range,
        status = 206,
        type = 'basic',
        url
    }) => {
        let bodyCancelled = false;
        const response = createResponse(status, contentRange, () => {
            bodyCancelled = true;
        }, contentLength, type, url);

        expect(() => requireValidByteRangeResponse(range, response, HIDDEN_CONTENT_RANGE_PATH_PATTERN)).toThrow(UnsupportedRangeResponseError);
        expect(bodyCancelled).toBe(true);
    });

    it('does not apply range validation to a request without a Range header', () => {
        let bodyCancelled = false;
        const response = createResponse(200, null, () => {
            bodyCancelled = true;
        });

        requireValidByteRangeResponse(null, response, HIDDEN_CONTENT_RANGE_PATH_PATTERN);

        expect(bodyCancelled).toBe(false);
    });
});
