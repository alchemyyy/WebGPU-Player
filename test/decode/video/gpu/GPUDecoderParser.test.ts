// @vitest-environment node
// The parser interface on stub modules; the HEVC decoder project's tests run its own parser

import { describe, expect, it } from 'vitest';

import { DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } from 'webgpu-player/decode/packages/DecoderPackageImports';
import {
    GPU_DECODER_PARSER_ABI_VERSION,
    MAXIMUM_GPU_DECODE_OUTPUT_EVENTS,
    MAXIMUM_GPU_DECODE_PACKET_PICTURES
} from 'webgpu-player/decode/video/gpu/GPUDecodeLimits';
import { GPU_DECODER_MAXIMUM_REPEAT_COUNT, GPU_DECODER_OUTPUT_EVENT, GPU_DECODER_PICTURE_FORMAT } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';
import GPUDecoderParserInstance, {
    GPU_DECODER_PARSER_EXPORTS,
    GPU_DECODER_PARSER_STATUS,
    GPUDecoderParserError,
    type GPUDecoderParserModule
} from 'webgpu-player/decode/video/gpu/GPUDecoderParser';

import {
    createParserStubModuleBinary,
    PARSER_STUB_PLAN_UNIT_COUNT,
    STUB_MODULE_MEMORY_PAGES,
    type ParserStubOptions
} from '../../../helpers/decoderPackages';

const PAGE_BYTE_LENGTH = 65_536;
const STUB_MEMORY_BYTE_LENGTH = STUB_MODULE_MEMORY_PAGES * PAGE_BYTE_LENGTH;
// Where a stub module keeps its events and output, which its data segments write
const STUB_EVENTS_POINTER = 2_048;
const STUB_OUTPUT_POINTER = 4_096;
const STUB_EVENTS = Uint32Array.of(0, GPU_DECODER_OUTPUT_EVENT.discardBit | 1);
const STUB_OUTPUT = Uint8Array.of(9, 8, 7, 6, 5, 4, 3, 2, 1);
const STUB_PACKET = Uint8Array.of(1, 2, 3);
const STUB_PLAN_UNIT_COUNT = 5;
const PARAMETER_SET_MISSING_ERROR_CODE = 3;
const UNNAMED_ERROR_CODE = 200;
const FAILING_VALUE = 9;
const ERROR_NAMES: ReadonlyMap<number, string> = new Map([ [ PARAMETER_SET_MISSING_ERROR_CODE, 'parameterSetMissing' ] ]);
const OTHER_ABI_VERSION = GPU_DECODER_PARSER_ABI_VERSION + 1;
// Output spans that leave the stub's memory: one past its end, and one whose pointer reads as a negative i32
const OVERRUNNING_OUTPUT_POINTER = STUB_MEMORY_BYTE_LENGTH - 4;
const OVERRUNNING_OUTPUT_BYTE_LENGTH = 8;
const NEGATIVE_I32_POINTER = -16;
const UNSIGNED_NEGATIVE_I32_POINTER = NEGATIVE_I32_POINTER >>> 0;
// Events that start in the stub's last word and run past it, within the per-call event bound
const OVERRUNNING_EVENT_POINTER = STUB_MEMORY_BYTE_LENGTH - Uint32Array.BYTES_PER_ELEMENT;
const OVERRUNNING_EVENT_COUNT = 2;
const EXCESSIVE_EVENT_COUNT = MAXIMUM_GPU_DECODE_OUTPUT_EVENTS + 1;
// An input reservation whose packet would run past the stub's memory
const OVERRUNNING_INPUT_POINTER = STUB_MEMORY_BYTE_LENGTH - 1;
// A decoder header without repeats, and one with two whose per-picture counts the parser reports
const NO_REPEATS = 0;
const TWO_REPEATS = 2;
const FIRST_REPEAT_COUNT = 7;
const SECOND_REPEAT_COUNT = 0;
// Visible sizes a picture reports: one of its own, none, and a report missing its height
const PICTURE_WIDTH = 352;
const PICTURE_HEIGHT = 288;
const MISSING_HEIGHT = 0;
// The largest picture an AV1 sequence header in the codec private data declares
const MAXIMUM_PICTURE_WIDTH = 1280;
const MAXIMUM_PICTURE_HEIGHT = 720;
// Picture formats as `(chroma_format << 8) | bit_depth`: 4:4:4 at 12 bits, 4:0:0 at 10 bits, and codes no output format holds:
// a fifth chroma format, a 9-bit depth, a 16-bit depth, and bits above the chroma format's byte
const TWELVE_BIT_444_FORMAT_CODE = (3 << GPU_DECODER_PICTURE_FORMAT.chromaFormatShift) | 12;
const TEN_BIT_MONOCHROME_FORMAT_CODE = 10;
const UNHELD_FORMAT_CODES: readonly number[] = [
    (4 << GPU_DECODER_PICTURE_FORMAT.chromaFormatShift) | 8,
    (1 << GPU_DECODER_PICTURE_FORMAT.chromaFormatShift) | 9,
    (1 << GPU_DECODER_PICTURE_FORMAT.chromaFormatShift) | 16,
    0x1_0108
];
const CODEC_PRIVATE = Uint8Array.of(0x81, 0x00, 0x0C, 0x00);
// A status no call of the interface returns
const UNKNOWN_STATUS = 7;

/** Instantiates a stub module as a package of it would be: its memory as the loader bounds it, the test's error names, and the header's repeats. */
function createStubInstance(options: ParserStubOptions = {}, memory: GPUDecoderParserModule['memory'] = {
    initialPages: STUB_MODULE_MEMORY_PAGES,
    maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES
}, repeatDirectiveCount: number = NO_REPEATS): Promise<GPUDecoderParserInstance> {
    return GPUDecoderParserInstance.create({
        errorNames: ERROR_NAMES,
        memory,
        module: new WebAssembly.Module(createParserStubModuleBinary(options)),
        repeatDirectiveCount
    });
}

/** The stub's memory, as the loader bounds it for a package. */
const STUB_MEMORY: GPUDecoderParserModule['memory'] = { initialPages: STUB_MODULE_MEMORY_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES };

/** Stub data segments that hold its events and its output. */
const STUB_DATA_SEGMENTS: ParserStubOptions['dataSegments'] = [
    { bytes: new Uint8Array(STUB_EVENTS.buffer), offset: STUB_EVENTS_POINTER },
    { bytes: STUB_OUTPUT, offset: STUB_OUTPUT_POINTER }
];

/** A stub that reports the data segments' events and output. */
const STUB_OUTPUT_RESULTS: ParserStubOptions['results'] = {
    eventCount: STUB_EVENTS.length,
    eventPointer: STUB_EVENTS_POINTER,
    outputByteLength: STUB_OUTPUT.byteLength,
    outputPointer: STUB_OUTPUT_POINTER
};

describe('GPUDecoderParserInstance', () => {
    it('copies its output and events out of the module\'s memory, and reads a packet without a picture as its trailing events', async () => {
        const instance = await createStubInstance({ dataSegments: STUB_DATA_SEGMENTS, results: STUB_OUTPUT_RESULTS });
        const noPictureInstance = await createStubInstance({
            dataSegments: STUB_DATA_SEGMENTS,
            results: { ...STUB_OUTPUT_RESULTS, decode: GPU_DECODER_PARSER_STATUS.noPicture }
        });

        const output = instance.decode(STUB_PACKET);

        expect(output.pictures).toHaveLength(1);
        expect(output.pictures[0].events).toEqual(STUB_EVENTS);
        expect(new Uint8Array(output.pictures[0].record)).toEqual(STUB_OUTPUT);
        expect(output.pictures[0].visibleSize).toBeNull();
        expect(output.trailingEvents).toEqual(new Uint32Array(0));
        expect(noPictureInstance.decode(STUB_PACKET)).toEqual({ pictures: [], trailingEvents: STUB_EVENTS });
    });

    it('decodes each picture of a packet with decode_next until the last, then stops', async () => {
        const instance = await createStubInstance({
            dataSegments: STUB_DATA_SEGMENTS,
            results: STUB_OUTPUT_RESULTS,
            resultSequences: {
                decode: [ GPU_DECODER_PARSER_STATUS.morePictures ],
                decodeNext: [ GPU_DECODER_PARSER_STATUS.morePictures, GPU_DECODER_PARSER_STATUS.success ]
            }
        });

        const output = instance.decode(STUB_PACKET);

        expect(output.pictures.map(picture => [ ...picture.events ])).toEqual([ [ ...STUB_EVENTS ], [ ...STUB_EVENTS ], [ ...STUB_EVENTS ] ]);
        expect(output.pictures.map(picture => [ ...new Uint8Array(picture.record) ])).toEqual([ [ ...STUB_OUTPUT ], [ ...STUB_OUTPUT ], [ ...STUB_OUTPUT ] ]);
        expect(output.trailingEvents).toEqual(new Uint32Array(0));
    });

    it('keeps a packet\'s pictures and takes the events of the decode_next that found no more as its trailing events', async () => {
        const instance = await createStubInstance({
            dataSegments: STUB_DATA_SEGMENTS,
            results: STUB_OUTPUT_RESULTS,
            resultSequences: {
                decode: [ GPU_DECODER_PARSER_STATUS.morePictures ],
                decodeNext: [ GPU_DECODER_PARSER_STATUS.noPicture ]
            }
        });

        const output = instance.decode(STUB_PACKET);

        expect(output.pictures).toHaveLength(1);
        expect(output.trailingEvents).toEqual(STUB_EVENTS);
    });

    it('fails a blocked decode or decode_next, which every earlier picture finishing on this instance could never unblock', async () => {
        const blockedDecode = await createStubInstance({ results: { decode: GPU_DECODER_PARSER_STATUS.blocked } });
        const blockedNext = await createStubInstance({
            results: { decode: GPU_DECODER_PARSER_STATUS.morePictures, decodeNext: GPU_DECODER_PARSER_STATUS.blocked }
        });

        expect(() => blockedDecode.decode(STUB_PACKET)).toThrow(new Error('parser decode: blocked with no earlier picture unfinished'));
        expect(() => blockedNext.decode(STUB_PACKET)).toThrow(new Error('parser decode_next: blocked with no earlier picture unfinished'));
    });

    it('fails a call that returns a status the interface does not define for it, naming the call and the status', async () => {
        const unknownDecode = await createStubInstance({ results: { decode: UNKNOWN_STATUS } });
        const morePicturesFinish = await createStubInstance({ results: { finish: GPU_DECODER_PARSER_STATUS.morePictures } });
        const unknownPlanNext = await createStubInstance({ results: { planNext: UNKNOWN_STATUS } });

        expect(() => unknownDecode.decode(STUB_PACKET)).toThrow(new RangeError(`parser decode status ${UNKNOWN_STATUS}`));
        expect(() => morePicturesFinish.finish(STUB_PACKET)).toThrow(new RangeError(`parser finish status ${GPU_DECODER_PARSER_STATUS.morePictures}`));
        expect(() => unknownPlanNext.planNext()).toThrow(new RangeError(`parser plan_next status ${UNKNOWN_STATUS}`));
    });

    it('fails a packet past the most pictures one packet may hold', async () => {
        const endless = await createStubInstance({
            results: { decode: GPU_DECODER_PARSER_STATUS.morePictures, decodeNext: GPU_DECODER_PARSER_STATUS.morePictures }
        });

        expect(() => endless.decode(STUB_PACKET))
            .toThrow(new RangeError(`parser pictures ${MAXIMUM_GPU_DECODE_PACKET_PICTURES + 1} > ${MAXIMUM_GPU_DECODE_PACKET_PICTURES} in one packet`));
    });

    it('plans a picture with its units, a packet without a picture, or a blocked packet', async () => {
        const pictureResults = { ...STUB_OUTPUT_RESULTS, planUnitCount: STUB_PLAN_UNIT_COUNT };
        const picture = await createStubInstance({ dataSegments: STUB_DATA_SEGMENTS, results: pictureResults });
        const noPicture = await createStubInstance({ dataSegments: STUB_DATA_SEGMENTS, results: { ...pictureResults, plan: GPU_DECODER_PARSER_STATUS.noPicture } });
        const blocked = await createStubInstance({ dataSegments: STUB_DATA_SEGMENTS, results: { ...pictureResults, plan: GPU_DECODER_PARSER_STATUS.blocked } });

        const planned = picture.plan(STUB_PACKET);

        expect(planned).toMatchObject({ events: STUB_EVENTS, kind: 'picture', morePictures: false, unitCount: STUB_PLAN_UNIT_COUNT });
        expect(new Uint8Array(planned.kind === 'picture' ? planned.plan : new ArrayBuffer(0))).toEqual(STUB_OUTPUT);
        expect(noPicture.plan(STUB_PACKET)).toEqual({ events: STUB_EVENTS, kind: 'no-picture' });
        expect(blocked.plan(STUB_PACKET)).toEqual({ kind: 'blocked' });
    });

    it('plans a packet\'s later pictures with plan_next, which reads no input, until it reports the last or no more', async () => {
        const instance = await createStubInstance({
            dataSegments: STUB_DATA_SEGMENTS,
            results: STUB_OUTPUT_RESULTS,
            resultSequences: {
                plan: [ GPU_DECODER_PARSER_STATUS.morePictures ],
                planNext: [ GPU_DECODER_PARSER_STATUS.blocked, GPU_DECODER_PARSER_STATUS.morePictures, GPU_DECODER_PARSER_STATUS.success, GPU_DECODER_PARSER_STATUS.noPicture ]
            }
        });

        expect(instance.plan(STUB_PACKET)).toMatchObject({ kind: 'picture', morePictures: true });
        expect(instance.planNext()).toEqual({ kind: 'blocked' });
        expect(instance.planNext()).toMatchObject({ events: STUB_EVENTS, kind: 'picture', morePictures: true });
        expect(instance.planNext()).toMatchObject({ kind: 'picture', morePictures: false });
        expect(instance.planNext()).toEqual({ events: STUB_EVENTS, kind: 'no-picture' });
    });

    it('reads a picture\'s own visible size after its finish, or none when it reports zero by zero', async () => {
        const sized = await createStubInstance({ results: { pictureHeight: PICTURE_HEIGHT, pictureWidth: PICTURE_WIDTH } });
        const unsized = await createStubInstance();

        expect(sized.finish(STUB_PACKET).visibleSize).toEqual({ height: PICTURE_HEIGHT, width: PICTURE_WIDTH });
        expect(sized.decode(STUB_PACKET).pictures[0].visibleSize).toEqual({ height: PICTURE_HEIGHT, width: PICTURE_WIDTH });
        expect(unsized.finish(STUB_PACKET).visibleSize).toBeNull();
    });

    it('fails a visible size that gives only one of its sides', async () => {
        const halfSized = await createStubInstance({ results: { pictureHeight: MISSING_HEIGHT, pictureWidth: PICTURE_WIDTH } });

        expect(() => halfSized.finish(STUB_PACKET)).toThrow(new RangeError(`parser picture size ${PICTURE_WIDTH}x${MISSING_HEIGHT}`));
    });

    it('reads one repeat count per repeat of the header for each picture, the full count when the module gives no smaller one', async () => {
        const counted = await createStubInstance({ resultSequences: { pictureRepeatCount: [ FIRST_REPEAT_COUNT, SECOND_REPEAT_COUNT ] } }, STUB_MEMORY, TWO_REPEATS);
        const uncounted = await createStubInstance({}, STUB_MEMORY, TWO_REPEATS);
        const withoutRepeats = await createStubInstance();

        expect(counted.finish(STUB_PACKET).repeatCounts).toEqual([ FIRST_REPEAT_COUNT, SECOND_REPEAT_COUNT ]);
        expect(uncounted.finish(STUB_PACKET).repeatCounts).toEqual([ GPU_DECODER_MAXIMUM_REPEAT_COUNT, GPU_DECODER_MAXIMUM_REPEAT_COUNT ]);
        expect(withoutRepeats.finish(STUB_PACKET).repeatCounts).toEqual([]);
    });

    it('reads the output format a picture decodes into, a 4:0:0 picture taking 4:2:0, or none when it reports zero', async () => {
        const fullChroma = await createStubInstance({ results: { pictureFormat: TWELVE_BIT_444_FORMAT_CODE } });
        const monochrome = await createStubInstance({ results: { pictureFormat: TEN_BIT_MONOCHROME_FORMAT_CODE } });
        const unformatted = await createStubInstance();

        expect(fullChroma.finish(STUB_PACKET).format).toBe('I444P12');
        expect(fullChroma.decode(STUB_PACKET).pictures[0].format).toBe('I444P12');
        expect(monochrome.finish(STUB_PACKET).format).toBe('I420P10');
        expect(unformatted.finish(STUB_PACKET).format).toBeNull();
    });

    it.each(UNHELD_FORMAT_CODES)('fails a picture format no output format holds: 0x%s', async (code: number) => {
        const unheld = await createStubInstance({ results: { pictureFormat: code } });

        expect(() => unheld.finish(STUB_PACKET)).toThrow(new RangeError(`parser picture format 0x${code.toString(16)}`));
    });

    it('reads the largest picture of each picture\'s sequence after it, as after configure', async () => {
        const declaring = await createStubInstance({ results: { maximumPictureHeight: MAXIMUM_PICTURE_HEIGHT, maximumPictureWidth: MAXIMUM_PICTURE_WIDTH } });
        const silent = await createStubInstance();

        expect(declaring.finish(STUB_PACKET).maximumPictureSize).toEqual({ height: MAXIMUM_PICTURE_HEIGHT, width: MAXIMUM_PICTURE_WIDTH });
        expect(declaring.decode(STUB_PACKET).pictures[0].maximumPictureSize).toEqual({ height: MAXIMUM_PICTURE_HEIGHT, width: MAXIMUM_PICTURE_WIDTH });
        expect(silent.finish(STUB_PACKET).maximumPictureSize).toBeNull();
    });

    it('returns the largest picture the codec private data declares from configure, and none without codec private data', async () => {
        const declaring = await createStubInstance({ results: { maximumPictureHeight: MAXIMUM_PICTURE_HEIGHT, maximumPictureWidth: MAXIMUM_PICTURE_WIDTH } });
        const silent = await createStubInstance();

        expect(declaring.configure(CODEC_PRIVATE)).toEqual({ height: MAXIMUM_PICTURE_HEIGHT, width: MAXIMUM_PICTURE_WIDTH });
        expect(declaring.configure(null)).toBeNull();
        expect(silent.configure(CODEC_PRIVATE)).toBeNull();
    });

    it('reports a failed check by the decoder\'s name for its code, or by the code', async () => {
        const named = await createStubInstance({
            results: { configure: GPU_DECODER_PARSER_STATUS.failed, errorCode: PARAMETER_SET_MISSING_ERROR_CODE, errorValue: FAILING_VALUE }
        });
        const unnamed = await createStubInstance({
            results: { errorCode: UNNAMED_ERROR_CODE, errorValue: FAILING_VALUE, finish: GPU_DECODER_PARSER_STATUS.failed }
        });

        expect(() => named.configure(STUB_PACKET)).toThrow(new GPUDecoderParserError(PARAMETER_SET_MISSING_ERROR_CODE, FAILING_VALUE, ERROR_NAMES));
        expect(() => named.configure(STUB_PACKET)).toThrow(`parser parameterSetMissing: ${FAILING_VALUE}`);
        expect(() => unnamed.finish(STUB_PACKET)).toThrow(`parser code ${UNNAMED_ERROR_CODE}: ${FAILING_VALUE}`);
    });

    it('skips configure without codec private data', async () => {
        const instance = await createStubInstance({ results: { configure: GPU_DECODER_PARSER_STATUS.failed } });

        expect(() => instance.configure(null)).not.toThrow();
        expect(() => instance.configure(new Uint8Array(0))).not.toThrow();
    });

    it('refuses a module of another interface version, one that creates no instance, or one missing an export', async () => {
        await expect(createStubInstance({ results: { abiVersion: OTHER_ABI_VERSION } }))
            .rejects.toThrow(`parser interface ${OTHER_ABI_VERSION}, the engine drives ${GPU_DECODER_PARSER_ABI_VERSION}`);
        await expect(createStubInstance({ results: { create: 0 } })).rejects.toThrow('parser create returned no instance');
        await expect(createStubInstance({ omittedExports: [ 'finish' ] })).rejects.toThrow(`parser export ${GPU_DECODER_PARSER_EXPORTS.finish} is missing`);
    });

    it('refuses a module that imports no memory', async () => {
        await expect(createStubInstance({ importsMemory: false }, null)).rejects.toThrow('parser module imports no memory');
    });

    it('refuses an input the module reserves no room for, but not an empty one', async () => {
        const instance = await createStubInstance({ results: { reserveInput: 0 } });

        expect(() => instance.decode(STUB_PACKET)).toThrow(new RangeError(`parser reserve_input refused ${STUB_PACKET.byteLength} bytes`));
        expect(instance.decode(new Uint8Array(0))).toEqual({
            pictures: [ { events: new Uint32Array(0), format: null, maximumPictureSize: null, record: new ArrayBuffer(0), repeatCounts: [], visibleSize: null } ],
            trailingEvents: new Uint32Array(0)
        });
    });

    it('refuses an input reservation that leaves the module\'s memory, before writing any of it', async () => {
        const overrunning = await createStubInstance({ results: { reserveInput: OVERRUNNING_INPUT_POINTER } });
        const negative = await createStubInstance({ results: { reserveInput: NEGATIVE_I32_POINTER } });

        expect(() => overrunning.decode(STUB_PACKET))
            .toThrow(new RangeError(`parser reserve_input ${OVERRUNNING_INPUT_POINTER}+${STUB_PACKET.byteLength} outside ${STUB_MEMORY_BYTE_LENGTH} bytes`));
        expect(() => negative.decode(STUB_PACKET))
            .toThrow(new RangeError(`parser reserve_input ${UNSIGNED_NEGATIVE_I32_POINTER}+${STUB_PACKET.byteLength} outside ${STUB_MEMORY_BYTE_LENGTH} bytes`));
    });

    it.each([
        {
            detail: `parser output ${OVERRUNNING_OUTPUT_POINTER}+${OVERRUNNING_OUTPUT_BYTE_LENGTH} outside ${STUB_MEMORY_BYTE_LENGTH} bytes`,
            results: { outputByteLength: OVERRUNNING_OUTPUT_BYTE_LENGTH, outputPointer: OVERRUNNING_OUTPUT_POINTER },
            subject: 'an output past the end of its memory'
        },
        {
            detail: `parser output ${UNSIGNED_NEGATIVE_I32_POINTER}+${OVERRUNNING_OUTPUT_BYTE_LENGTH} outside ${STUB_MEMORY_BYTE_LENGTH} bytes`,
            results: { outputByteLength: OVERRUNNING_OUTPUT_BYTE_LENGTH, outputPointer: NEGATIVE_I32_POINTER },
            subject: 'an output pointer past 2 GiB'
        },
        {
            detail: `parser events ${OVERRUNNING_EVENT_POINTER}+${OVERRUNNING_EVENT_COUNT * Uint32Array.BYTES_PER_ELEMENT} outside ${STUB_MEMORY_BYTE_LENGTH} bytes`,
            results: { eventCount: OVERRUNNING_EVENT_COUNT, eventPointer: OVERRUNNING_EVENT_POINTER },
            subject: 'events past the end of its memory'
        },
        {
            detail: `parser events ${EXCESSIVE_EVENT_COUNT} > ${MAXIMUM_GPU_DECODE_OUTPUT_EVENTS}`,
            results: { eventCount: EXCESSIVE_EVENT_COUNT, eventPointer: STUB_EVENTS_POINTER },
            subject: 'more events than one packet may carry'
        }
    ])('refuses $subject', async ({ detail, results }) => {
        const instance = await createStubInstance({ results });

        expect(() => instance.decode(STUB_PACKET)).toThrow(new RangeError(detail));
    });

    it('reads a picture with the plan unit count the module reports', async () => {
        const instance = await createStubInstance();

        expect(instance.plan(STUB_PACKET)).toMatchObject({ kind: 'picture', unitCount: PARSER_STUB_PLAN_UNIT_COUNT });
    });
});
