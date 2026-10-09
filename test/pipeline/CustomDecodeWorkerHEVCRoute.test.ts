// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    BufferTarget,
    EncodedPacket,
    EncodedVideoPacketSource,
    MkvOutputFormat,
    Output
} from 'mediabunny';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { parseHEVCNALUnits, type HEVCNALUnit } from 'webgpu-player/video/dolby-vision/DolbyVisionHEVCSplitter';
import type DolbyVisionRPUParserSession from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParserSession';
import { parseHEVCSPS } from 'webgpu-player/video/hevc/HEVCSPSParser';

import {
    DOLBY_VISION_RPU_PARSER_WASM_URL,
    RAW_I420P10_ROUTE,
    createWorkerStartRequest,
    decodeToEnd,
    getFrameResponses,
    spyOnRPUParserSessions,
    startDecodeWorker
} from '../helpers/decodeWorkerHarness';
import { TEST_VECTORS_DIRECTORY } from '../helpers/enginePaths';
import { encodeAnnexBNALUnits } from '../helpers/hevcNALUnits';

const MATROSKA_FILE_NAME = 'hevc-main10.mkv';
// hdr10plus_tool's x265 sample opens each access unit with a delimiter, and its first is an IDR picture with its parameter sets
const X265_SAMPLE_PATH = resolve(TEST_VECTORS_DIRECTORY, 'hdr10plus-tool', 'dhdr10-opt.hevc');
const HEVC_SPS_NAL_UNIT_TYPE = 33;
const HEVC_AUD_NAL_UNIT_TYPE = 35;
const HEVC_MAIN_10_CODEC = 'hvc1.2.4.L93.B0';
const FRAME_DURATION_SECONDS = 1 / 25;
const DOLBY_VISION_RPU_PROFILE = 8;

/** Muxes the x265 sample's first access unit as a one-frame Matroska HEVC Main 10 track without Dolby Vision. */
async function createHEVCMatroska(): Promise<Uint8Array> {
    const nalUnits = parseHEVCNALUnits(new Uint8Array(readFileSync(X265_SAMPLE_PATH)), { kind: 'annex-b' });
    const secondDelimiterIndex = nalUnits.findIndex(
        (nalUnit: HEVCNALUnit, nalUnitIndex: number): boolean => nalUnitIndex > 0 && nalUnit.type === HEVC_AUD_NAL_UNIT_TYPE
    );
    const firstAccessUnit = nalUnits.slice(0, secondDelimiterIndex);
    const sequenceParameterSet = firstAccessUnit.find((nalUnit: HEVCNALUnit): boolean => nalUnit.type === HEVC_SPS_NAL_UNIT_TYPE);
    if (!sequenceParameterSet) {
        throw new Error('The x265 sample\'s first access unit has no SPS');
    }
    const { codedHeight, codedWidth } = parseHEVCSPS(sequenceParameterSet.data);

    const target = new BufferTarget();
    const output = new Output({ format: new MkvOutputFormat(), target });
    const source = new EncodedVideoPacketSource('hevc');
    output.addVideoTrack(source);
    await output.start();
    const accessUnitData = encodeAnnexBNALUnits(firstAccessUnit.map((nalUnit: HEVCNALUnit): Uint8Array => nalUnit.data));
    await source.add(new EncodedPacket(accessUnitData, 'key', 0, FRAME_DURATION_SECONDS), {
        decoderConfig: { codec: HEVC_MAIN_10_CODEC, codedHeight, codedWidth }
    });
    source.close();
    await output.finalize();
    if (!target.buffer) {
        throw new Error('Mediabunny did not finalize the Matroska vector');
    }
    return new Uint8Array(target.buffer);
}

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
