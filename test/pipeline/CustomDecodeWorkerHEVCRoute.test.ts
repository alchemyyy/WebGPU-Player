// @vitest-environment node

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createDolbyVisionAuthorizationRPUVector } from 'webgpu-player/capability/vectors/DolbyVisionAuthorizationVector';
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
import { createHEVCMatroska, createSeparateDolbyVisionEnhancementTrackMatroska } from '../helpers/hevcMatroskaVector';
import { createNALUnit } from '../helpers/hevcNALUnits';

const MATROSKA_FILE_NAME = 'hevc-main10.mkv';
const DUAL_TRACK_MATROSKA_FILE_NAME = 'dolby-vision-p7-dual-track.mkv';
const DOLBY_VISION_RPU_PROFILE = 8;
const DOLBY_VISION_DUAL_LAYER_PROFILE = 7;
const HEVC_UNSPEC62_NAL_UNIT_TYPE = 62;

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

    it('reads a separate EL track\'s RPUs, finding the track by its container track number rather than its position', async () => {
        const createSession = await spyOnRPUParserSessions();
        const session = {
            close: vi.fn(),
            parse: vi.fn().mockResolvedValue(createDolbyVisionAuthorizationRPUVector(DOLBY_VISION_DUAL_LAYER_PROFILE, 'mel'))
        };
        createSession.mockReturnValue(session as unknown as DolbyVisionRPUParserSession);
        const rpu = createNALUnit(HEVC_UNSPEC62_NAL_UNIT_TYPE, [ 25, 8, 9 ]);
        // TrackNumbers 5 and 9, where the tracks' positions are 1 and 2
        const workerScope = await startDecodeWorker(new Map([ [
            DUAL_TRACK_MATROSKA_FILE_NAME,
            createSeparateDolbyVisionEnhancementTrackMatroska({ base: 5, enhancement: 9 }, rpu)
        ] ]));

        const responses = await decodeToEnd(workerScope, createWorkerStartRequest(DUAL_TRACK_MATROSKA_FILE_NAME, {
            ...RAW_I420P10_ROUTE,
            dolbyVisionProfile: DOLBY_VISION_DUAL_LAYER_PROFILE
        }));

        // The BL packet carries no RPU, so the one parsed came from the EL track's packet
        expect(session.parse).toHaveBeenCalledOnce();
        expect(session.parse.mock.calls[0][0]).toEqual(rpu);
        expect(getFrameResponses(responses)).toHaveLength(1);
    });
});
