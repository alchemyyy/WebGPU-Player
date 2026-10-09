/**
 * Bounds one capability asset download, its retries included.
 * A probe downloads its assets before its decode timeout starts, so a slow link never reads as a decoder that cannot keep up.
 */
export const CAPABILITY_ASSET_NETWORK_TIMEOUT_MILLISECONDS = 30_000;

/** The waits before each retry of a failed download, so a download makes at most one more attempt than this list holds. */
export const CAPABILITY_ASSET_RETRY_DELAYS_MILLISECONDS: readonly number[] = Object.freeze([ 250, 1_000 ]);

const HTTP_REQUEST_TIMEOUT_STATUS = 408;
const HTTP_TOO_MANY_REQUESTS_STATUS = 429;
const HTTP_SERVER_ERROR_MINIMUM_STATUS = 500;
const HTTP_SERVER_ERROR_MAXIMUM_STATUS = 599;

type CapabilityAssetAttempt =
    | Readonly<{ bytes: ArrayBuffer, kind: 'downloaded' }>
    | Readonly<{ error: Error, kind: 'failed', retryable: boolean }>;

/** Returns whether a later attempt can pass a status: a timeout, a rate limit, or a server or proxy error. */
function isRetryableHTTPStatus(status: number): boolean {
    return status === HTTP_REQUEST_TIMEOUT_STATUS
        || status === HTTP_TOO_MANY_REQUESTS_STATUS
        || (status >= HTTP_SERVER_ERROR_MINIMUM_STATUS && status <= HTTP_SERVER_ERROR_MAXIMUM_STATUS);
}

async function attemptCapabilityAssetDownload(url: string, signal: AbortSignal): Promise<CapabilityAssetAttempt> {
    try {
        const response = await fetch(url, {
            cache: 'force-cache',
            credentials: 'same-origin',
            redirect: 'error',
            signal
        });
        if (!response.ok) {
            return {
                error: new Error(`The capability asset request failed with HTTP ${response.status}`),
                kind: 'failed',
                retryable: isRetryableHTTPStatus(response.status)
            };
        }
        return { bytes: await response.arrayBuffer(), kind: 'downloaded' };
    } catch (error) {
        // A dropped connection may pass on retry, but the shared deadline ending is final
        return {
            error: error instanceof Error ? error : new Error('The capability asset request failed'),
            kind: 'failed',
            retryable: !signal.aborted
        };
    }
}

/** Waits out a retry delay, or rejects as soon as the shared deadline ends. */
function waitBeforeRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject): void => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const abortHandler = (): void => {
            globalThis.clearTimeout(timeout);
            reject(signal.reason);
        };
        const timeout = globalThis.setTimeout((): void => {
            signal.removeEventListener('abort', abortHandler);
            resolve();
        }, milliseconds);
        signal.addEventListener('abort', abortHandler, { once: true });
    });
}

/**
 * Downloads a served capability asset, such as a qualification vector or a decoder binary.
 * A network error, 408, 429, or 5xx is retried after each delay in CAPABILITY_ASSET_RETRY_DELAYS_MILLISECONDS; any other failure is final.
 */
export async function fetchCapabilityAsset(url: string): Promise<ArrayBuffer> {
    // One deadline covers every attempt and the waits between them, so retries never extend the bound
    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated, and every WebGPU browser has AbortSignal.timeout
    const signal = AbortSignal.timeout(CAPABILITY_ASSET_NETWORK_TIMEOUT_MILLISECONDS);
    let attempt = await attemptCapabilityAssetDownload(url, signal);
    for (const retryDelay of CAPABILITY_ASSET_RETRY_DELAYS_MILLISECONDS) {
        if (attempt.kind === 'downloaded' || !attempt.retryable) {
            break;
        }
        await waitBeforeRetry(retryDelay, signal);
        attempt = await attemptCapabilityAssetDownload(url, signal);
    }
    if (attempt.kind === 'failed') {
        throw attempt.error;
    }
    return attempt.bytes;
}

/**
 * Downloads a worker script or decoder glue into the HTTP cache.
 * The worker that loads it later, inside its probe's timeout, then reads it from the cache.
 */
export async function warmCapabilityAsset(url: string): Promise<void> {
    await fetchCapabilityAsset(url);
}
