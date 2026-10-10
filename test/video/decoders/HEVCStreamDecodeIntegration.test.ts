// @vitest-environment node

import { TEST_VECTORS_DIRECTORY, WASM_OUTPUT_DIRECTORY } from '../../helpers/enginePaths';
import { encodeAnnexBNALUnits } from '../../helpers/hevcNALUnits';
import { createHash, type Hash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { EncodedPacket, type PacketType } from 'mediabunny';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { secondsToMicroseconds } from 'webgpu-player/MediaTime';
import {
    createHEVCDecoderBackend,
    createHEVCDecoderModule,
    type HEVCDecodedFrame,
    type HEVCDecoderBackend,
    type HEVCFramePlane,
    type HEVCFramePlanes
} from 'webgpu-player/video/decoders/HEVCDecoderBackend';
import {
    createOwnedHEVCSoftwareVideoDecoder,
    type HEVCSoftwareDecodedFrame,
    type HEVCSoftwareVideoDecoderDependencies
} from 'webgpu-player/video/decoders/HEVCSoftwareVideoDecoder';
import { parseHEVCNALUnits, type HEVCNALUnit } from 'webgpu-player/video/dolby-vision/DolbyVisionHEVCSplitter';

const HEVC_DECODER_DIRECTORY = resolve(WASM_OUTPUT_DIRECTORY, 'ffmpeg-hevc');
const HEVC_GLUE_PATH = resolve(HEVC_DECODER_DIRECTORY, 'ffmpeg-hevc.js');
const HEVC_WASM_PATH = resolve(HEVC_DECODER_DIRECTORY, 'ffmpeg-hevc.wasm');
const ANNEX_B_FORMAT = { kind: 'annex-b' } as const;

// NAL unit types of H.265 Table 7-1
const HEVC_TRAIL_N_NAL_UNIT_TYPE = 0;
const HEVC_TRAIL_R_NAL_UNIT_TYPE = 1;
const HEVC_RASL_N_NAL_UNIT_TYPE = 8;
const HEVC_RASL_R_NAL_UNIT_TYPE = 9;
const HEVC_FIRST_IRAP_NAL_UNIT_TYPE = 16;
const HEVC_IDR_N_LP_NAL_UNIT_TYPE = 20;
const HEVC_CRA_NAL_UNIT_TYPE = 21;
const HEVC_LAST_IRAP_NAL_UNIT_TYPE = 23;
const HEVC_MAXIMUM_VCL_NAL_UNIT_TYPE = 31;
const HEVC_VPS_NAL_UNIT_TYPE = 32;
const HEVC_AUD_NAL_UNIT_TYPE = 35;
const HEVC_PREFIX_SEI_NAL_UNIT_TYPE = 39;
const HEVC_FIRST_RESERVED_PREFIX_NAL_UNIT_TYPE = 41;
const HEVC_LAST_RESERVED_PREFIX_NAL_UNIT_TYPE = 44;
const HEVC_FIRST_UNSPECIFIED_PREFIX_NAL_UNIT_TYPE = 48;
const HEVC_LAST_UNSPECIFIED_PREFIX_NAL_UNIT_TYPE = 55;
// first_slice_segment_in_pic_flag is the first bit after the two-byte NAL unit header
const NAL_UNIT_HEADER_BYTE_LENGTH = 2;
const FIRST_SLICE_SEGMENT_IN_PICTURE_MASK = 0x80;
const MAIN_BIT_DEPTH = 8;

// The JCT-VC HEVC_v1 conformance stream TILES_B_Cisco_1, with 5x5 non-uniform tiles in every picture, and the MD5s its suite publishes
const TILES_VECTOR_PATH = resolve(TEST_VECTORS_DIRECTORY, 'hevc-tiles', 'TILES_B_Cisco_1.bin');
const TILES_BITSTREAM_MD5 = '326c3da824513dad14c7577633d55200';
// The MD5 of the decoded YUV file: every frame's planes as compact rows, luma then blue and red chroma, in output order
const TILES_DECODED_YUV_MD5 = '3382291f2b19ee2d760647d4cc756e95';
const TILES_FRAME_COUNT = 100;
const TILES_CODED_WIDTH = 1920;
const TILES_CODED_HEIGHT = 1080;
// The suite specifies 60 frames per second; the stream carries no timing of its own
const TILES_FRAME_DURATION_SECONDS = 1 / 60;
// Decoding a hundred 1080p pictures in one WASM thread can outlast the default bound of a test on a slow machine
const TILES_DECODE_TIMEOUT_MILLISECONDS = 30_000;

// Regeneration recipe in PowerShell, with the FFmpeg git-862338fe31 and x265 4.1+225-1b48507eb of HEVCExactCapabilityVectors.ts:
// $params = 'keyint=6:min-keyint=6:bframes=2:crf=40:scenecut=0:b-adapt=0:open-gop=1:repeat-headers=1:annexb=1:info=0:pools=none:frame-threads=1:wpp=0:log-level=error'
// ffmpeg -f lavfi -i "testsrc2=s=64x64:r=24" -frames:v 10 -pix_fmt yuv420p -c:v libx265 -preset ultrafast -x265-params $params -f hevc -y open-gop.hevc
// In decode order: an IDR picture and three trailing pictures, then a CRA picture with its parameter sets repeated, a RASL_R and a RASL_N picture that reference the IDR picture's GOP, and three trailing pictures
const OPEN_GOP_ANNEX_B_STREAM = Buffer.from(
    'AAAAAUABDAH//wFgAAADAJAAAAMAAAMAHpWQCQAAAAFCAQEBYAAAAwCQAAADAAADAB6gIIEFllZEpMLwFoCAAAADAIAAAAwEAAAAAUQBwHPAiQAAASgBrBNgvDQiA7OiXzZggCRhc8JmOQTCvBRNfjzfvouzjhDh//H90LVh1oaN2usmhJTtEpn8eqlpqYgGDaaHJ1NHwLvePcfXZ+7WgjKQ1VDB5QKqGSOQpNMFNdHxli7mmum0dJE7NODPV+/93Ds+mc7/HMXAroV+KbIu5WHEkC7Tva9wrozA0kqKCl6qgcjw/chCju/Xwz28eiPLXm+Gd3sBAwKDM/NUsgJ+n82bYYwBzDUzC/g8zXXaRKVm/wmBNjZJfydQJRt+i/PsF8L5dt3M8jKuMo0pJvj56zvaIpXS5LTW3hatEKpQuIMHV4y7bpYBQcd9Qq+dxpxiM/QGB/i5cNFdxhuHgrh9YJFuU4Mvt2fMSDM3/VfS+1txfMIiZYvdudYycPXFmINsqjjFvVzftd5dPuIQ4vQrUnussMWxPt8flmVT9DfCHvlzQsc9rR6A0dSYPasWl8TXzI4Rle2tC15jwQzZ64lbmsp0btJtYDhdZXQF5d2Cz2j9ROmWyK01IL3fbIJHqxFzP77D6FQKGCOBudP/hQACTQyWH8NdJ8KUFeJg2+ZZC3Ezj/gimpt0IWb7QSmFd1kNNL500xU2bKkBBhaixhjN8SOidgKw9rcolkWfT/In7shbY9SAAAAAAQIB0BleICZAPbwf/SmDFAECVViH7Yx///zY8Tu9+MKfMeZ2OKw7tYDf/IWQy/7gGPEKZV51ZePPIkHba9EkTIBnHAFiwAAAAAECAeBEl4IChCEgAAAAAQAB4CT/6JAWYCjgAAAAAUABDAH//wFgAAADAJAAAAMAAAMAHpWQCQAAAAFCAQEBYAAAAwCQAAADAAADAB6gIIEFllZEpMLwFoCAAAADAIAAAAwEAAAAAUQBwHPAiQAAASoBrBhLSQSYuFZf+Ue/Dw9+jXL2TdND+0SbjMB1A0btKtec+BlAuILT79Z1N/7/0b6Ni3DUJQJDCU4W8x7A9nE8hOw83yNT9UYyQRc2+j96U96YJjSWIkZyVL0PdaKgvRJNfpVEeIDhH7hn33X7/+hltVd3+9I/cjlwL/9eau2qIYIsrBgbhoxlAuD7P2YPgMKx+nRP5Kw+oUwg6s1Iw6UzRQrAu8++Y7EDVMy6sE8skoO891EsW3lt6lrbGturqOGBMHAYrLHgXADNLLBdlDyz1V8M+xet7hIIpXmuC2hjZXC0rMRCr1wvN9czyU2fL0cV7wEkHLekrvGkbIgI5S1Xefexx7oGW8pXQ6Hw5LmmsHypyQz/rtMNhf1R2f5xVAK+pbAec525PEKbADGthsKfgx7Q9Y0ijq7DtQjP3fVmHvDe3PE3s7vAJ5JbfM2iG1A9U/wsRanoOm9bD7cWH5uEiXQSwjQxSpa5iUs1owL3RKuTUfdODXZjKIDwERYKhdqwqzV9AoE2wtpat/GvaCE4mVFxkJie+3ukNOyMod0yEjGLJAC7Bm1KXRP2Z2jl0flrQUss6uvroyY5trYOwEEbwRDclWGFUI8xIqLI5zkL7Du9V/k9DiDdaaRtTPD7v6LTLt6FdGxhTJzsB/CO9K2ls+yXPpq3lAK0dnPtWmXgOAAAAAESAeCiJdeCAoQhIAAAAAEQAeCG//okBZgo4AAAAAECAdBJXiAmwD2PsdwGBlEPYzMdz1FcuivzDkX/te+gNMhiAOz2Z0yOvlHGWNMAAAABAgHhBJeCAoQhIAAAAAEAAeDk/+iQFiAo4A==',
    'base64'
);
const OPEN_GOP_PICTURE_NAL_UNIT_TYPES: readonly number[] = [
    HEVC_IDR_N_LP_NAL_UNIT_TYPE,
    HEVC_TRAIL_R_NAL_UNIT_TYPE,
    HEVC_TRAIL_R_NAL_UNIT_TYPE,
    HEVC_TRAIL_N_NAL_UNIT_TYPE,
    HEVC_CRA_NAL_UNIT_TYPE,
    HEVC_RASL_R_NAL_UNIT_TYPE,
    HEVC_RASL_N_NAL_UNIT_TYPE,
    HEVC_TRAIL_R_NAL_UNIT_TYPE,
    HEVC_TRAIL_R_NAL_UNIT_TYPE,
    HEVC_TRAIL_N_NAL_UNIT_TYPE
];
// Each access unit's place in display order, in decode order, as FFprobe orders the frames
const OPEN_GOP_DISPLAY_INDEXES: readonly number[] = [ 0, 3, 2, 1, 6, 5, 4, 9, 8, 7 ];
const OPEN_GOP_ACCESS_UNIT_COUNT = OPEN_GOP_PICTURE_NAL_UNIT_TYPES.length;
const OPEN_GOP_CRA_ACCESS_UNIT_INDEX = OPEN_GOP_PICTURE_NAL_UNIT_TYPES.indexOf(HEVC_CRA_NAL_UNIT_TYPE);
const OPEN_GOP_CRA_DISPLAY_INDEX = OPEN_GOP_DISPLAY_INDEXES[OPEN_GOP_CRA_ACCESS_UNIT_INDEX];
// Main profile, compatible with Main and Main 10, Main tier, Level 1, progressive and frame-only, as its SPS signals
const OPEN_GOP_CODEC = 'hev1.1.6.L30.90';
const OPEN_GOP_CODED_WIDTH = 64;
const OPEN_GOP_CODED_HEIGHT = 64;
const OPEN_GOP_FRAME_DURATION_SECONDS = 1 / 24;
const OPEN_GOP_DECODER_CONFIG: VideoDecoderConfig = {
    codec: OPEN_GOP_CODEC,
    codedHeight: OPEN_GOP_CODED_HEIGHT,
    codedWidth: OPEN_GOP_CODED_WIDTH,
    hardwareAcceleration: 'prefer-software'
};
// What ffmpeg -i open-gop.hevc -f framemd5 - writes, in display order
const OPEN_GOP_FRAME_MD5S: readonly string[] = [
    'ee906501360f74c41b3141ebbdbe7401',
    '47b095a8ba79b4864129d2e3420b634b',
    'f284e1951642fb68df6302baa3ea9cd1',
    '0a179616b5278b88f6724ed22ed82f7f',
    'fc9dba7d424509e587a27da3cc3e1514',
    'ca4575fc345612b225647026fe6e3971',
    '87d0b201e11a7e3ab95f50d8772305b3',
    'bb54892407fea5f0d9cd35be6a3e5708',
    'dd6adea5f0ec5e0ac2ecca4bb0f4417a',
    'eaf7ad2fa4d9cc0fc39f41ab54edfdea'
];
// The IDR picture's GOP, its first four access units, displays first
const OPEN_GOP_IDR_GOP_FRAME_MD5S = OPEN_GOP_FRAME_MD5S.slice(0, OPEN_GOP_CRA_ACCESS_UNIT_INDEX);
// The CRA picture and its trailing pictures, all FFmpeg writes for the stream cut at the CRA access unit
const OPEN_GOP_CRA_GOP_FRAME_MD5S = OPEN_GOP_FRAME_MD5S.slice(OPEN_GOP_CRA_DISPLAY_INDEX);

/** The factory the ffmpeg-hevc glue exports, which createHEVCDecoderBackend takes from the global scope. */
type EmscriptenModuleFactory = (options: {
    locateFile?: (path: string, scriptDirectory: string) => string
    wasmBinary?: ArrayBuffer
}) => Promise<unknown>;

/** One access unit of a stream, in Annex B, and the NAL unit type of its picture. */
type AccessUnit = Readonly<{
    data: Uint8Array
    pictureNALUnitType: number
}>;

/** The timing a packet went into the decoder with, or a frame came out with. */
type FrameTiming = Readonly<{
    durationMicroseconds: number
    timestampMicroseconds: number
}>;

/** A decoded frame's geometry and timing, and the MD5 of its compact planes. */
type DecodedFrameRecord = Readonly<{
    codedHeight: number
    codedWidth: number
    format: HEVCSoftwareDecodedFrame['format']
    planeMD5: string
    timing: FrameTiming
}>;

/** What decoding gave: each decode call's result, every frame in output order, and the timing of each packet the decoder took. */
type StreamDecodeResult = Readonly<{
    decodeResults: readonly boolean[]
    frames: readonly DecodedFrameRecord[]
    /** The MD5 of every frame's compact planes in output order, as a planar YUV file holds them */
    outputMD5: string
    takenPacketTimings: readonly FrameTiming[]
}>;

type CompactPlane = Readonly<{
    height: number
    plane: HEVCFramePlane
    width: number
}>;

/** A decoded 4:2:0 frame's planes and their dimensions, as the backend and the owned path both describe them. */
type PlanarFrame = Readonly<{
    chromaHeight: number
    chromaWidth: number
    height: number
    planes: HEVCFramePlanes
    width: number
}>;

type OpenGOPDecodeCase = Readonly<{
    expectedDecodeResults: readonly boolean[]
    /** Each frame's MD5, in output order */
    expectedFrameMD5s: readonly string[]
    label: string
    /** The access units each run decodes before the flush that ends it, as start and end indexes */
    runs: ReadonlyArray<readonly [number, number]>
}>;

const OPEN_GOP_DECODE_CASES: readonly OpenGOPDecodeCase[] = [
    {
        // Decoding passed the GOP the RASL pictures reference, so they decode
        expectedDecodeResults: [ true, true, true, true, true, true, true, true, true, true ],
        expectedFrameMD5s: OPEN_GOP_FRAME_MD5S,
        label: 'the whole stream, whose RASL pictures follow the GOP they reference',
        runs: [ [ 0, OPEN_GOP_ACCESS_UNIT_COUNT ] ]
    },
    {
        // The RASL pictures reference pictures before the random-access point decoding starts at, so the decoder drops them
        expectedDecodeResults: [ true, false, false, true, true, true ],
        expectedFrameMD5s: OPEN_GOP_CRA_GOP_FRAME_MD5S,
        label: 'the stream from its CRA picture, dropping the leading RASL pictures',
        runs: [ [ OPEN_GOP_CRA_ACCESS_UNIT_INDEX, OPEN_GOP_ACCESS_UNIT_COUNT ] ]
    },
    {
        // A flush ends the first run, as a seek does, so decoding starts again at the CRA picture
        expectedDecodeResults: [ true, true, true, true, true, false, false, true, true, true ],
        expectedFrameMD5s: [ ...OPEN_GOP_IDR_GOP_FRAME_MD5S, ...OPEN_GOP_CRA_GOP_FRAME_MD5S ],
        label: 'the first GOP, then after a flush the stream from its CRA picture',
        runs: [
            [ 0, OPEN_GOP_CRA_ACCESS_UNIT_INDEX ],
            [ OPEN_GOP_CRA_ACCESS_UNIT_INDEX, OPEN_GOP_ACCESS_UNIT_COUNT ]
        ]
    }
];

/** Loads the ffmpeg-hevc glue, a classic script that also exports its module factory to CommonJS. */
function loadActualModuleFactory(): EmscriptenModuleFactory {
    return createRequire(import.meta.url)(HEVC_GLUE_PATH) as EmscriptenModuleFactory;
}

function createDependencies(): HEVCSoftwareVideoDecoderDependencies {
    return {
        createDecoder: async (options): Promise<HEVCDecoderBackend> => (
            createHEVCDecoderBackend(options)
        ),
        loadDecoderGlue: (): void => undefined,
        resolveAssetURL: (path: string): string => (
            path.endsWith('.wasm') ? HEVC_WASM_PATH : HEVC_GLUE_PATH
        )
    };
}

function readTilesVector(): Uint8Array {
    return new Uint8Array(readFileSync(TILES_VECTOR_PATH));
}

function isVCLNALUnit(nalUnit: HEVCNALUnit): boolean {
    return nalUnit.type <= HEVC_MAXIMUM_VCL_NAL_UNIT_TYPE;
}

/** Returns whether a NAL unit starts an access unit once a picture's VCL NAL units have passed (H.265 7.4.2.4.4). */
function startsAccessUnit(nalUnit: HEVCNALUnit): boolean {
    if (isVCLNALUnit(nalUnit)) {
        return (nalUnit.data[NAL_UNIT_HEADER_BYTE_LENGTH] & FIRST_SLICE_SEGMENT_IN_PICTURE_MASK) !== 0;
    }
    return (nalUnit.type >= HEVC_VPS_NAL_UNIT_TYPE && nalUnit.type <= HEVC_AUD_NAL_UNIT_TYPE)
        || nalUnit.type === HEVC_PREFIX_SEI_NAL_UNIT_TYPE
        || (nalUnit.type >= HEVC_FIRST_RESERVED_PREFIX_NAL_UNIT_TYPE && nalUnit.type <= HEVC_LAST_RESERVED_PREFIX_NAL_UNIT_TYPE)
        || (nalUnit.type >= HEVC_FIRST_UNSPECIFIED_PREFIX_NAL_UNIT_TYPE && nalUnit.type <= HEVC_LAST_UNSPECIFIED_PREFIX_NAL_UNIT_TYPE);
}

function createAccessUnit(nalUnits: readonly HEVCNALUnit[]): AccessUnit {
    const pictureNALUnit = nalUnits.find(isVCLNALUnit);
    if (!pictureNALUnit) {
        throw new Error('An HEVC vector access unit has no picture');
    }
    return {
        data: encodeAnnexBNALUnits(nalUnits.map((nalUnit: HEVCNALUnit): Uint8Array => nalUnit.data)),
        pictureNALUnitType: pictureNALUnit.type
    };
}

/** Splits a single-layer Annex B stream into its access units, in decode order. */
function splitAccessUnits(stream: Uint8Array): AccessUnit[] {
    const accessUnits: AccessUnit[] = [];
    let nalUnits: HEVCNALUnit[] = [];
    let hasPicture = false;
    for (const nalUnit of parseHEVCNALUnits(stream, ANNEX_B_FORMAT)) {
        if (hasPicture && startsAccessUnit(nalUnit)) {
            accessUnits.push(createAccessUnit(nalUnits));
            nalUnits = [];
            hasPicture = false;
        }
        nalUnits.push(nalUnit);
        hasPicture ||= isVCLNALUnit(nalUnit);
    }
    accessUnits.push(createAccessUnit(nalUnits));
    return accessUnits;
}

/** Wraps an access unit in a packet that presents it at its place in display order, a key packet for an IRAP picture. */
function createPacket(
    accessUnit: AccessUnit,
    displayIndex: number,
    frameDurationSeconds: number,
    sequenceNumber: number
): EncodedPacket {
    const isIRAPPicture = accessUnit.pictureNALUnitType >= HEVC_FIRST_IRAP_NAL_UNIT_TYPE
        && accessUnit.pictureNALUnitType <= HEVC_LAST_IRAP_NAL_UNIT_TYPE;
    const type: PacketType = isIRAPPicture ? 'key' : 'delta';
    return new EncodedPacket(
        accessUnit.data,
        type,
        displayIndex * frameDurationSeconds,
        frameDurationSeconds,
        sequenceNumber
    );
}

/** Creates an MD5 hash, the digest that the conformance suite and FFmpeg's framemd5 publish their known answers in. */
function createMD5Hash(): Hash {
    // eslint-disable-next-line sonarjs/hashing -- The digest only compares outputs with published known answers
    return createHash('md5');
}

/** Feeds a frame's planes to the hashes as compact rows, luma then blue and red chroma, as a planar YUV file stores them. */
function hashCompactPlanes(frame: PlanarFrame, hashes: readonly Hash[]): void {
    const compactPlanes: CompactPlane[] = [];
    compactPlanes.push({ height: frame.height, plane: frame.planes.luma, width: frame.width });
    compactPlanes.push({ height: frame.chromaHeight, plane: frame.planes.chromaBlue, width: frame.chromaWidth });
    compactPlanes.push({ height: frame.chromaHeight, plane: frame.planes.chromaRed, width: frame.chromaWidth });
    for (const { height, plane, width } of compactPlanes) {
        for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
            const rowOffset = rowIndex * plane.stride;
            const row = plane.samples.subarray(rowOffset, rowOffset + width);
            for (const hash of hashes) {
                hash.update(row);
            }
        }
    }
}

/**
 * Decodes runs of packets through one owned decoder, flushing after each run as a seek does.
 * Each frame is hashed while its planes are in WASM memory.
 */
async function decodePacketRuns(
    config: VideoDecoderConfig,
    packetRuns: ReadonlyArray<readonly EncodedPacket[]>
): Promise<StreamDecodeResult> {
    const decodeResults: boolean[] = [];
    const frames: DecodedFrameRecord[] = [];
    const takenPacketTimings: FrameTiming[] = [];
    const outputHash = createMD5Hash();
    let decoderError: unknown = null;
    const decoder = createOwnedHEVCSoftwareVideoDecoder(config, {
        onError: (error: unknown): void => {
            decoderError = error;
        },
        onFrame: (frame: HEVCSoftwareDecodedFrame): void => {
            const frameHash = createMD5Hash();
            hashCompactPlanes({
                chromaHeight: frame.chromaHeight,
                chromaWidth: frame.chromaWidth,
                height: frame.codedHeight,
                planes: frame.planes,
                width: frame.codedWidth
            }, [ frameHash, outputHash ]);
            frames.push({
                codedHeight: frame.codedHeight,
                codedWidth: frame.codedWidth,
                format: frame.format,
                planeMD5: frameHash.digest('hex'),
                timing: {
                    durationMicroseconds: frame.durationMicroseconds,
                    timestampMicroseconds: frame.timestampMicroseconds
                }
            });
        }
    }, createDependencies());
    try {
        await decoder.init();
        for (const packets of packetRuns) {
            for (const packet of packets) {
                const decoded = decoder.decode(packet);
                decodeResults.push(decoded);
                if (!decoded) {
                    continue;
                }
                takenPacketTimings.push({
                    durationMicroseconds: packet.microsecondDuration,
                    timestampMicroseconds: packet.microsecondTimestamp
                });
            }
            decoder.flush();
        }
    } finally {
        decoder.close();
    }
    expect(decoderError).toBeNull();
    return {
        decodeResults,
        frames,
        outputMD5: outputHash.digest('hex'),
        takenPacketTimings
    };
}

function compareTimestamps(first: FrameTiming, second: FrameTiming): number {
    return first.timestampMicroseconds - second.timestampMicroseconds;
}

function getFrameTiming(frame: DecodedFrameRecord): FrameTiming {
    return frame.timing;
}

let actualModuleFactory: EmscriptenModuleFactory;

beforeAll(() => {
    actualModuleFactory = loadActualModuleFactory();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('HEVC stream decode integration', () => {
    describe('the TILES_B_Cisco_1 conformance vector', () => {
        it('is the conformance suite\'s bitstream', () => {
            expect(createMD5Hash().update(readTilesVector()).digest('hex')).toBe(TILES_BITSTREAM_MD5);
        });

        // The owned path refuses this stream before decoding: its SPS leaves the scan type unspecified, and the bundled route takes progressive video only
        it('decodes every tiled picture to the conformance MD5 through the WASM decoder', async () => {
            vi.stubGlobal('HEVCDecoderModule', actualModuleFactory);
            const accessUnits = splitAccessUnits(readTilesVector());
            expect(accessUnits).toHaveLength(TILES_FRAME_COUNT);
            const decoderModule = await createHEVCDecoderModule({
                wasmBinary: Uint8Array.from(readFileSync(HEVC_WASM_PATH)).buffer
            });
            const decoder = decoderModule.createDecoder(null);
            const outputHash = createMD5Hash();
            const frameTimings: FrameTiming[] = [];
            const packetTimings: FrameTiming[] = [];
            const handleFrame = (frame: HEVCDecodedFrame): void => {
                expect(frame).toMatchObject({
                    bitDepth: MAIN_BIT_DEPTH,
                    height: TILES_CODED_HEIGHT,
                    width: TILES_CODED_WIDTH
                });
                hashCompactPlanes(frame, [ outputHash ]);
                frameTimings.push({
                    durationMicroseconds: frame.durationMicroseconds,
                    timestampMicroseconds: frame.timestampMicroseconds
                });
            };

            try {
                // Every picture is intra or forward predicted, so the stream displays in decode order
                accessUnits.forEach((accessUnit: AccessUnit, accessUnitIndex: number): void => {
                    const timestampMicroseconds = secondsToMicroseconds(accessUnitIndex * TILES_FRAME_DURATION_SECONDS);
                    const durationMicroseconds = secondsToMicroseconds(TILES_FRAME_DURATION_SECONDS);
                    packetTimings.push({ durationMicroseconds, timestampMicroseconds });
                    decoder.decode(accessUnit.data, timestampMicroseconds, durationMicroseconds, handleFrame);
                });
                decoder.flush(handleFrame);
            } finally {
                decoder.destroy();
            }

            expect(frameTimings).toHaveLength(TILES_FRAME_COUNT);
            expect(outputHash.digest('hex')).toBe(TILES_DECODED_YUV_MD5);
            // Each frame comes out with the timestamp and duration its packet went in with, in the order they went in
            expect(frameTimings).toEqual(packetTimings);
        }, TILES_DECODE_TIMEOUT_MILLISECONDS);
    });

    describe('an open-GOP stream', () => {
        it('holds a CRA picture whose leading RASL pictures reference the GOP before it', () => {
            const accessUnits = splitAccessUnits(new Uint8Array(OPEN_GOP_ANNEX_B_STREAM));

            expect(accessUnits.map((accessUnit: AccessUnit): number => accessUnit.pictureNALUnitType)).toEqual(
                OPEN_GOP_PICTURE_NAL_UNIT_TYPES
            );
        });

        it.each(OPEN_GOP_DECODE_CASES)('decodes $label as native FFmpeg does', async (
            decodeCase: OpenGOPDecodeCase
        ): Promise<void> => {
            vi.stubGlobal('HEVCDecoderModule', actualModuleFactory);
            const packets = splitAccessUnits(new Uint8Array(OPEN_GOP_ANNEX_B_STREAM)).map((
                accessUnit: AccessUnit,
                accessUnitIndex: number
            ): EncodedPacket => createPacket(
                accessUnit,
                OPEN_GOP_DISPLAY_INDEXES[accessUnitIndex],
                OPEN_GOP_FRAME_DURATION_SECONDS,
                accessUnitIndex
            ));
            const packetRuns = decodeCase.runs.map(([ startIndex, endIndex ]: readonly [number, number]): EncodedPacket[] => (
                packets.slice(startIndex, endIndex)
            ));

            const result = await decodePacketRuns(OPEN_GOP_DECODER_CONFIG, packetRuns);

            expect(result.decodeResults).toEqual(decodeCase.expectedDecodeResults);
            expect(result.frames.map((frame: DecodedFrameRecord): string => frame.planeMD5)).toEqual(
                decodeCase.expectedFrameMD5s
            );
            // Frames come out in display order, the order of their packets' timestamps, with the timing their packets went in with
            expect(result.frames.map(getFrameTiming)).toEqual([ ...result.takenPacketTimings ].sort(compareTimestamps));
        });
    });
});
