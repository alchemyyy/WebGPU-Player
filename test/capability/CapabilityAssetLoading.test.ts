// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CAPABILITY_ASSET_NETWORK_TIMEOUT_MILLISECONDS,
    CAPABILITY_ASSET_RETRY_DELAYS_MILLISECONDS,
    fetchCapabilityAsset
} from 'webgpu-player/capability/CapabilityAssetLoading';

const ASSET_URL = 'https://example.test/web/libraries/ffmpeg-hevc/main10-4k-qualification.bin';
const ASSET_BYTES = Object.freeze([ 1, 2, 3, 4 ]);
const FIRST_RETRY_DELAY_MILLISECONDS = 250;
const SECOND_RETRY_DELAY_MILLISECONDS = 1_000;

type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

function createAssetResponse(): Response {
    return new Response(new Uint8Array(ASSET_BYTES), { status: 200 });
}

function createStatusResponse(status: number): Response {
    return new Response(null, { status });
}

function createNetworkError(): TypeError {
    return new TypeError('fetch failed');
}

describe('capability asset loading', () => {
    let deadline: AbortController;
    let fetchMock: FetchMock;

    beforeEach(() => {
        vi.useFakeTimers();
        // The test ends the shared deadline itself instead of waiting 30 s
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        deadline = new AbortController();
        vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
        fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('waits 250 ms and then 1 s between attempts', () => {
        expect(CAPABILITY_ASSET_RETRY_DELAYS_MILLISECONDS).toEqual([
            FIRST_RETRY_DELAY_MILLISECONDS,
            SECOND_RETRY_DELAY_MILLISECONDS
        ]);
    });

    it('downloads once under the shared deadline', async () => {
        fetchMock.mockResolvedValueOnce(createAssetResponse());

        const bytes = await fetchCapabilityAsset(ASSET_URL);

        expect([ ...new Uint8Array(bytes) ]).toEqual(ASSET_BYTES);
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        expect(AbortSignal.timeout).toHaveBeenCalledExactlyOnceWith(CAPABILITY_ASSET_NETWORK_TIMEOUT_MILLISECONDS);
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(ASSET_URL, {
            cache: 'force-cache',
            credentials: 'same-origin',
            redirect: 'error',
            signal: deadline.signal
        });
    });

    it('retries a dropped connection after the first delay', async () => {
        fetchMock
            .mockRejectedValueOnce(createNetworkError())
            .mockResolvedValueOnce(createAssetResponse());

        const download = fetchCapabilityAsset(ASSET_URL);
        await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MILLISECONDS - 1);
        expect(fetchMock).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);

        expect([ ...new Uint8Array(await download) ]).toEqual(ASSET_BYTES);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([ 408, 429, 500, 502, 503, 504, 522 ])('retries HTTP %i', async (status: number) => {
        fetchMock
            .mockResolvedValueOnce(createStatusResponse(status))
            .mockResolvedValueOnce(createStatusResponse(status))
            .mockResolvedValueOnce(createAssetResponse());

        const download = fetchCapabilityAsset(ASSET_URL);
        await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MILLISECONDS + SECOND_RETRY_DELAY_MILLISECONDS);

        expect([ ...new Uint8Array(await download) ]).toEqual(ASSET_BYTES);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('fails with the last error once every retry is spent', async () => {
        fetchMock.mockResolvedValue(createStatusResponse(503));

        const download = fetchCapabilityAsset(ASSET_URL);
        const failure = expect(download).rejects.toThrow('HTTP 503');
        await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MILLISECONDS + SECOND_RETRY_DELAY_MILLISECONDS);

        await failure;
        expect(fetchMock).toHaveBeenCalledTimes(CAPABILITY_ASSET_RETRY_DELAYS_MILLISECONDS.length + 1);
    });

    it.each([ 403, 404, 410 ])('does not retry HTTP %i', async (status: number) => {
        fetchMock.mockResolvedValue(createStatusResponse(status));

        await expect(fetchCapabilityAsset(ASSET_URL)).rejects.toThrow(`HTTP ${status}`);
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('does not retry once the shared deadline ends', async () => {
        const timeoutReason = new DOMException('The capability asset download timed out', 'TimeoutError');
        fetchMock.mockImplementationOnce(async (): Promise<Response> => {
            deadline.abort(timeoutReason);
            throw timeoutReason;
        });

        await expect(fetchCapabilityAsset(ASSET_URL)).rejects.toBe(timeoutReason);
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('stops waiting to retry when the shared deadline ends', async () => {
        const timeoutReason = new DOMException('The capability asset download timed out', 'TimeoutError');
        fetchMock.mockRejectedValueOnce(createNetworkError());

        const download = fetchCapabilityAsset(ASSET_URL);
        const failure = expect(download).rejects.toBe(timeoutReason);
        await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MILLISECONDS / 2);
        deadline.abort(timeoutReason);

        await failure;
        await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MILLISECONDS);
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});
