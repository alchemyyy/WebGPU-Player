const MAX_RANGE_HEADER_LENGTH = 128;
const BYTE_RANGE_REQUEST_PATTERN = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/i;
const BYTE_CONTENT_RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i;

type RequestedByteRange = {
    firstByte: number
    kind: 'bounded'
    lastByte: number
} | {
    firstByte: number
    kind: 'open-ended'
} | {
    kind: 'suffix'
    length: number
};

type ByteContentRange = {
    firstByte: number
    lastByte: number
    totalLength: number | null
};

/** Indicates that a media endpoint did not honor a byte-range request. */
export class UnsupportedRangeResponseError extends Error {
    public constructor() {
        super('The media endpoint did not honor a byte-range request');
        this.name = 'UnsupportedRangeResponseError';
    }
}

function parseSafeInteger(value: string): number | null {
    const parsedValue = Number(value);
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) {
        return null;
    }

    return parsedValue;
}

function parseRequestedByteRange(value: string): RequestedByteRange | null {
    const trimmedValue = value.trim();
    if (trimmedValue.length === 0 || trimmedValue.length > MAX_RANGE_HEADER_LENGTH) {
        return null;
    }

    const match = BYTE_RANGE_REQUEST_PATTERN.exec(trimmedValue);
    if (!match) {
        return null;
    }

    const suffixLengthText = match[3];
    if (suffixLengthText) {
        const suffixLength = parseSafeInteger(suffixLengthText);
        if (suffixLength === null || suffixLength === 0) {
            return null;
        }

        return {
            kind: 'suffix',
            length: suffixLength
        };
    }

    const firstByteText = match[1];
    if (!firstByteText) {
        return null;
    }
    const firstByte = parseSafeInteger(firstByteText);
    if (firstByte === null) {
        return null;
    }

    const lastByteText = match[2];
    if (!lastByteText) {
        return {
            firstByte,
            kind: 'open-ended'
        };
    }

    const lastByte = parseSafeInteger(lastByteText);
    if (lastByte === null || lastByte < firstByte) {
        return null;
    }

    return {
        firstByte,
        kind: 'bounded',
        lastByte
    };
}

function parseByteContentRange(value: string | null): ByteContentRange | null {
    if (!value) {
        return null;
    }

    const trimmedValue = value.trim();
    if (trimmedValue.length === 0 || trimmedValue.length > MAX_RANGE_HEADER_LENGTH) {
        return null;
    }

    const match = BYTE_CONTENT_RANGE_PATTERN.exec(trimmedValue);
    if (!match) {
        return null;
    }

    const firstByte = parseSafeInteger(match[1] ?? '');
    const lastByte = parseSafeInteger(match[2] ?? '');
    if (firstByte === null || lastByte === null || lastByte < firstByte) {
        return null;
    }

    const totalLengthText = match[3];
    let totalLength: number | null;
    if (totalLengthText === '*') {
        totalLength = null;
    } else {
        totalLength = parseSafeInteger(totalLengthText ?? '');
        if (totalLength === null) {
            return null;
        }
    }
    if (totalLength !== null && (totalLength === 0 || lastByte >= totalLength)) {
        return null;
    }

    return {
        firstByte,
        lastByte,
        totalLength
    };
}

function parseByteContentLength(value: string | null): number | null {
    if (!value) {
        return null;
    }

    const trimmedValue = value.trim();
    if (!/^\d+$/.test(trimmedValue)) {
        return null;
    }

    const contentLength = parseSafeInteger(trimmedValue);
    return contentLength !== null && contentLength > 0 ? contentLength : null;
}

function isMatchingByteRange(requestedRange: RequestedByteRange, contentRange: ByteContentRange): boolean {
    switch (requestedRange.kind) {
        case 'bounded': {
            if (contentRange.firstByte !== requestedRange.firstByte) {
                return false;
            }
            const expectedLastByte = contentRange.totalLength === null ?
                requestedRange.lastByte :
                Math.min(requestedRange.lastByte, contentRange.totalLength - 1);
            return contentRange.lastByte === expectedLastByte;
        }
        case 'open-ended':
            if (contentRange.firstByte !== requestedRange.firstByte) {
                return false;
            }
            return contentRange.totalLength === null || contentRange.lastByte === contentRange.totalLength - 1;
        case 'suffix': {
            if (contentRange.totalLength === null) {
                return false;
            }
            const expectedFirstByte = Math.max(0, contentRange.totalLength - requestedRange.length);
            return contentRange.firstByte === expectedFirstByte && contentRange.lastByte === contentRange.totalLength - 1;
        }
    }
}

function isSafeCORSByteRangeResponse(requestedRange: RequestedByteRange, response: Response, hiddenContentRangePathPattern: RegExp | null): boolean {
    // Content-Range is not CORS-safelisted.
    // A media server may return a valid 206 without exposing that header to a cross-origin web client, on the paths the host names.
    // There, status 206 plus the safelisted Content-Length is the browser-visible proof that the server did not return an unbounded 200 response
    if (
        response.status !== 206
        || response.type !== 'cors'
        || hiddenContentRangePathPattern === null
        || !isHiddenContentRangeResponse(response.url, hiddenContentRangePathPattern)
    ) {
        return false;
    }

    const contentLength = parseByteContentLength(response.headers.get('Content-Length'));
    if (contentLength === null) {
        return false;
    }

    switch (requestedRange.kind) {
        case 'bounded': {
            const maximumLength = requestedRange.lastByte - requestedRange.firstByte + 1;
            return contentLength <= maximumLength;
        }
        case 'open-ended':
            return Number.isSafeInteger(requestedRange.firstByte + contentLength);
        case 'suffix':
            return contentLength <= requestedRange.length;
    }
}

/** Returns whether a response came from an http(s) URL whose path the host's pattern names as one that hides Content-Range. */
function isHiddenContentRangeResponse(responseURL: string, hiddenContentRangePathPattern: RegExp): boolean {
    try {
        const parsedURL = new URL(responseURL);
        return (parsedURL.protocol === 'http:' || parsedURL.protocol === 'https:')
            && hiddenContentRangePathPattern.test(parsedURL.pathname);
    } catch {
        return false;
    }
}

function rejectRangeResponse(response: Response): never {
    if (response.body) {
        void response.body.cancel().catch(() => undefined);
    }
    throw new UnsupportedRangeResponseError();
}

/**
 * Requires a partial response to describe exactly the requested byte interval.
 * A cross-origin 206 without a visible Content-Range passes only from a path the media source's hiddenContentRangePathPattern names, on a Content-Length within the range.
 */
export function requireValidByteRangeResponse(requestedRangeHeader: string | null, response: Response, hiddenContentRangePathPattern: RegExp | null): void {
    if (requestedRangeHeader === null) {
        return;
    }

    const requestedRange = parseRequestedByteRange(requestedRangeHeader);
    const contentRange = response.status === 206 ? parseByteContentRange(response.headers.get('Content-Range')) : null;
    if (requestedRange) {
        if (contentRange && isMatchingByteRange(requestedRange, contentRange)) {
            return;
        }
        if (!response.headers.has('Content-Range') && isSafeCORSByteRangeResponse(requestedRange, response, hiddenContentRangePathPattern)) {
            return;
        }
    }

    rejectRangeResponse(response);
}
