// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    isGPUDecoderCoordinatorRequest,
    isGPUDecoderCoordinatorResponse
} from 'webgpu-player/decode/video/gpu/GPUDecoderCoordinatorProtocol';

import { encodeWebAssemblyModule } from '../../../helpers/webAssemblyModuleEncoder';

const PARSER_WASM_MODULE = new WebAssembly.Module(encodeWebAssemblyModule({}));
const PARSER_MODULE = { errorNames: new Map([ [ 1, 'configuration' ] ]), memory: null, module: PARSER_WASM_MODULE, repeatDirectiveCount: 0 };
// The parser's package, by its id and the SHA-256 of its file
const PACKAGE_VERSION = { contentHash: 'ab'.repeat(32), id: 'jpeg2000' };
const PIPELINE_ID = 2;
const SEQUENCE = 5;
const CODEC_PRIVATE_BYTE_LENGTH = 23;
const PACKET_BYTE_LENGTH = 4_096;
const RECORD_BYTE_LENGTH = 512;
// A picture output, then one dropped, as output event words
const OUTPUT_EVENTS = Uint32Array.of(0, 0x8000_0001);
const FAILURE_MESSAGE = 'parser configuration: 4';
const FRACTIONAL_COUNT = 0.5;
const NEGATIVE_COUNT = -1;
const UNKNOWN_TYPE = 'flush';
// A picture's own visible size and repeat counts, the largest picture a codec private data declares, and a count past u32
const PICTURE_SIZE = { height: 288, width: 352 };
const MAXIMUM_PICTURE_SIZE = { height: 720, width: 1280 };
const REPEAT_COUNTS = [ 4, 0xFFFF_FFFF ];
const OVERSIZED_REPEAT_COUNT = 0x1_0000_0000;
// A picture's output format, and a format no frame pool holds
const PICTURE_FORMAT = 'I422P10';
const UNHELD_FORMAT = 'NV12';

const OPEN_REQUEST = {
    codecPrivate: new ArrayBuffer(CODEC_PRIVATE_BYTE_LENGTH),
    packageVersion: PACKAGE_VERSION,
    parser: PARSER_MODULE,
    pipelineId: PIPELINE_ID,
    type: 'open'
} as const;
const SUBMIT_REQUEST = { packet: new ArrayBuffer(PACKET_BYTE_LENGTH), pipelineId: PIPELINE_ID, sequence: SEQUENCE, type: 'submit' } as const;
const CLOSE_REQUEST = { pipelineId: PIPELINE_ID, type: 'close' } as const;
const PICTURE = {
    events: OUTPUT_EVENTS,
    format: PICTURE_FORMAT,
    maximumPictureSize: MAXIMUM_PICTURE_SIZE,
    record: new ArrayBuffer(RECORD_BYTE_LENGTH),
    repeatCounts: REPEAT_COUNTS,
    visibleSize: PICTURE_SIZE
} as const;
const RESULT_RESPONSE = { pictures: [ PICTURE ], pipelineId: PIPELINE_ID, sequence: SEQUENCE, trailingEvents: new Uint32Array(0), type: 'result' } as const;
const FAILED_RESPONSE = { message: FAILURE_MESSAGE, pipelineId: PIPELINE_ID, sequence: SEQUENCE, type: 'failed' } as const;
const OPENED_RESPONSE = { maximumPictureSize: MAXIMUM_PICTURE_SIZE, pipelineId: PIPELINE_ID, type: 'opened' } as const;

describe('isGPUDecoderCoordinatorRequest', () => {
    it('accepts an open with codec private data or none, a submit, and a close', () => {
        expect(isGPUDecoderCoordinatorRequest(OPEN_REQUEST)).toBe(true);
        expect(isGPUDecoderCoordinatorRequest({ ...OPEN_REQUEST, codecPrivate: null })).toBe(true);
        expect(isGPUDecoderCoordinatorRequest(SUBMIT_REQUEST)).toBe(true);
        expect(isGPUDecoderCoordinatorRequest(CLOSE_REQUEST)).toBe(true);
    });

    it.each([
        { subject: 'codec private data as a view', value: { ...OPEN_REQUEST, codecPrivate: new Uint8Array(CODEC_PRIVATE_BYTE_LENGTH) } },
        { subject: 'an open without a parser module', value: { ...OPEN_REQUEST, parser: { ...PARSER_MODULE, module: null } } },
        { subject: 'an open without a package version', value: { ...OPEN_REQUEST, packageVersion: undefined } },
        { subject: 'an open with a package id alone', value: { ...OPEN_REQUEST, packageVersion: PACKAGE_VERSION.id } },
        { subject: 'an open without the package\'s content hash', value: { ...OPEN_REQUEST, packageVersion: { id: PACKAGE_VERSION.id } } },
        { subject: 'a fractional pipeline id', value: { ...CLOSE_REQUEST, pipelineId: FRACTIONAL_COUNT } },
        { subject: 'a negative pipeline id', value: { ...SUBMIT_REQUEST, pipelineId: NEGATIVE_COUNT } },
        { subject: 'a packet as a view', value: { ...SUBMIT_REQUEST, packet: new Uint8Array(PACKET_BYTE_LENGTH) } },
        { subject: 'a submit without its sequence', value: { ...SUBMIT_REQUEST, sequence: undefined } },
        { subject: 'an unknown request', value: { ...CLOSE_REQUEST, type: UNKNOWN_TYPE } },
        { subject: 'no object', value: PIPELINE_ID }
    ])('refuses $subject', ({ value }) => {
        expect(isGPUDecoderCoordinatorRequest(value)).toBe(false);
    });
});

describe('isGPUDecoderCoordinatorResponse', () => {
    it('accepts an opened pipeline with a declared picture or none, a result of pictures or none, and a failed open or packet', () => {
        expect(isGPUDecoderCoordinatorResponse(OPENED_RESPONSE)).toBe(true);
        expect(isGPUDecoderCoordinatorResponse({ ...OPENED_RESPONSE, maximumPictureSize: null })).toBe(true);
        expect(isGPUDecoderCoordinatorResponse(RESULT_RESPONSE)).toBe(true);
        expect(isGPUDecoderCoordinatorResponse({
            ...RESULT_RESPONSE,
            pictures: [ PICTURE, { ...PICTURE, format: null, maximumPictureSize: null, repeatCounts: [], visibleSize: null } ]
        })).toBe(true);
        expect(isGPUDecoderCoordinatorResponse({ ...RESULT_RESPONSE, pictures: [], trailingEvents: OUTPUT_EVENTS })).toBe(true);
        expect(isGPUDecoderCoordinatorResponse(FAILED_RESPONSE)).toBe(true);
        expect(isGPUDecoderCoordinatorResponse({ ...FAILED_RESPONSE, sequence: null })).toBe(true);
    });

    it.each([
        { subject: 'an opened pipeline without its declared picture', value: { ...OPENED_RESPONSE, maximumPictureSize: undefined } },
        { subject: 'a declared picture without a height', value: { ...OPENED_RESPONSE, maximumPictureSize: { height: 0, width: MAXIMUM_PICTURE_SIZE.width } } },
        { subject: 'events as an array', value: { ...RESULT_RESPONSE, pictures: [ { ...PICTURE, events: [ ...OUTPUT_EVENTS ] } ] } },
        { subject: 'events as signed words', value: { ...RESULT_RESPONSE, pictures: [ { ...PICTURE, events: Int32Array.from(OUTPUT_EVENTS) } ] } },
        { subject: 'a record as a view', value: { ...RESULT_RESPONSE, pictures: [ { ...PICTURE, record: new Uint8Array(RECORD_BYTE_LENGTH) } ] } },
        { subject: 'a picture without a record', value: { ...RESULT_RESPONSE, pictures: [ { ...PICTURE, record: null } ] } },
        { subject: 'a fractional visible size', value: { ...RESULT_RESPONSE, pictures: [ { ...PICTURE, visibleSize: { height: FRACTIONAL_COUNT, width: PICTURE_SIZE.width } } ] } },
        { subject: 'a repeat count past u32', value: { ...RESULT_RESPONSE, pictures: [ { ...PICTURE, repeatCounts: [ OVERSIZED_REPEAT_COUNT ] } ] } },
        { subject: 'a picture without repeat counts', value: { ...RESULT_RESPONSE, pictures: [ { ...PICTURE, repeatCounts: undefined } ] } },
        { subject: 'a format no frame pool holds', value: { ...RESULT_RESPONSE, pictures: [ { ...PICTURE, format: UNHELD_FORMAT } ] } },
        { subject: 'a picture without its format', value: { ...RESULT_RESPONSE, pictures: [ { ...PICTURE, format: undefined } ] } },
        { subject: 'a sequence maximum without a width', value: { ...RESULT_RESPONSE, pictures: [ { ...PICTURE, maximumPictureSize: { height: MAXIMUM_PICTURE_SIZE.height, width: 0 } } ] } },
        { subject: 'pictures as one picture', value: { ...RESULT_RESPONSE, pictures: PICTURE } },
        { subject: 'trailing events as an array', value: { ...RESULT_RESPONSE, trailingEvents: [ ...OUTPUT_EVENTS ] } },
        { subject: 'a result without its sequence', value: { ...RESULT_RESPONSE, sequence: null } },
        { subject: 'a failure without its message', value: { ...FAILED_RESPONSE, message: null } },
        { subject: 'a failure of a negative sequence', value: { ...FAILED_RESPONSE, sequence: NEGATIVE_COUNT } },
        { subject: 'a response without its pipeline', value: { ...FAILED_RESPONSE, pipelineId: undefined } },
        { subject: 'an unknown response', value: { ...FAILED_RESPONSE, type: UNKNOWN_TYPE } }
    ])('refuses $subject', ({ value }) => {
        expect(isGPUDecoderCoordinatorResponse(value)).toBe(false);
    });
});
