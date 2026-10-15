// @vitest-environment node

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type DolbyVisionRPUParserSession from 'webgpu-player/demux/dolby-vision/DolbyVisionRPUParserSession';

import {
    DOLBY_VISION_RPU_PARSER_WASM_URL,
    RAW_I420P10_ROUTE,
    createWorkerStartRequest,
    decodeToEnd,
    getFrameResponses,
    spyOnRPUParserSessions,
    startDecodeWorker
} from '../helpers/decodeWorkerHarness';
import { createHEVCMatroska } from '../helpers/hevcMatroskaVector';

const MATROSKA_FILE_NAME = 'hevc-main10.mkv';
const DOLBY_VISION_RPU_PROFILE = 8;

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('CustomDecode.worker HEVC route', () => {
    it('never loads the RPU parser on a route without Dolby Vision', async () => {
        const createSession = await spyOnRPUParserSessions();
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, await createHEVCMatroska() ] ]));

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME));

        expect(createSession).not.toHaveBeenCalled();
        expect(getFrameResponses(responses)).toHaveLength(1);
    });

    it('loads the RPU parser once on a Dolby Vision route', async () => {
        const createSession = await spyOnRPUParserSessions();
        const session = { close: vi.fn(), parse: vi.fn() };
        createSession.mockReturnValue(session as unknown as DolbyVisionRPUParserSession);
        const workerScope = await startDecodeWorker(new Map([ [ MATROSKA_FILE_NAME, await createHEVCMatroska() ] ]));

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(MATROSKA_FILE_NAME, {
            ...RAW_I420P10_ROUTE,
            dolbyVisionProfile: DOLBY_VISION_RPU_PROFILE
        }));

        expect(createSession).toHaveBeenCalledOnce();
        expect(createSession.mock.calls[0][0]).toBe(DOLBY_VISION_RPU_PARSER_WASM_URL);
        // The sample carries no RPU, so the session is never asked to parse
        expect(session.parse).not.toHaveBeenCalled();
        expect(session.close).toHaveBeenCalledOnce();
        expect(getFrameResponses(responses)).toHaveLength(1);
    });
});
