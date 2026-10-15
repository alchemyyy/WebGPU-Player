// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES } from 'webgpu-player/decode/packages/DecoderPackageImports';
import {
    isGPUDecoderParserModule,
    isGPUDecoderParseRequest,
    isGPUDecoderParseResponse
} from 'webgpu-player/decode/video/gpu/GPUDecoderParseProtocol';

import { encodeWebAssemblyModule } from '../../../helpers/webAssemblyModuleEncoder';

const MODULE_BINARY = encodeWebAssemblyModule({});
const PARSER_WASM_MODULE = new WebAssembly.Module(MODULE_BINARY);
const SLICE_DATA_ERROR_CODE = 11;
const SLICE_DATA_ERROR_VALUE = 7;
const ERROR_NAMES: ReadonlyMap<number, string> = new Map([ [ SLICE_DATA_ERROR_CODE, 'sliceData' ] ]);
// The header's recovery of slice data errors, and a recovery no header names
const ERROR_RECOVERIES = new Map([ [ SLICE_DATA_ERROR_CODE, 'resync' ] ]);
const UNKNOWN_RECOVERY = 'skip';
const INITIAL_PAGES = 4;
const MAXIMUM_PAGES = 64;
// The repeat directives of the package's header, whose counts each picture reports
const REPEAT_DIRECTIVE_COUNT = 1;
const PARSER_MODULE = {
    errorNames: ERROR_NAMES,
    errorRecoveries: ERROR_RECOVERIES,
    memory: { initialPages: INITIAL_PAGES, maximumPages: MAXIMUM_PAGES },
    module: PARSER_WASM_MODULE,
    repeatDirectiveCount: REPEAT_DIRECTIVE_COUNT
};
const JOB_ID = 3;
const FIRST_UNIT = 2;
const UNIT_COUNT = 4;
const PLAN_BYTE_LENGTH = 32;
const JOB_BYTE_LENGTH = 48;
const FAILURE_MESSAGE = 'parser sliceData: 7';
const FRACTIONAL_COUNT = 1.5;
const NEGATIVE_COUNT = -1;
const UNKNOWN_TYPE = 'flush';

const START_REQUEST = { parser: PARSER_MODULE, type: 'start' } as const;
const PARSE_REQUEST = { firstUnit: FIRST_UNIT, id: JOB_ID, plan: new ArrayBuffer(PLAN_BYTE_LENGTH), type: 'parse', unitCount: UNIT_COUNT } as const;
const PARSED_RESPONSE = { id: JOB_ID, job: new ArrayBuffer(JOB_BYTE_LENGTH), type: 'parsed' } as const;
const FAILED_RESPONSE = { code: SLICE_DATA_ERROR_CODE, id: JOB_ID, message: FAILURE_MESSAGE, type: 'failed', value: SLICE_DATA_ERROR_VALUE } as const;

describe('isGPUDecoderParserModule', () => {
    it('accepts a compiled module with its error names and recoveries, and bounded memory, or no memory', () => {
        expect(isGPUDecoderParserModule(PARSER_MODULE)).toBe(true);
        expect(isGPUDecoderParserModule({ ...PARSER_MODULE, errorRecoveries: new Map() })).toBe(true);
        expect(isGPUDecoderParserModule({ ...PARSER_MODULE, memory: null })).toBe(true);
        expect(isGPUDecoderParserModule({ ...PARSER_MODULE, memory: { initialPages: MAXIMUM_PAGES, maximumPages: MAXIMUM_PAGES } })).toBe(true);
    });

    it.each([
        { subject: 'module bytes in place of a compiled module', value: { ...PARSER_MODULE, module: MODULE_BINARY } },
        { subject: 'error names as a plain object', value: { ...PARSER_MODULE, errorNames: Object.fromEntries(ERROR_NAMES) } },
        { subject: 'missing error recoveries', value: { ...PARSER_MODULE, errorRecoveries: undefined } },
        { subject: 'a recovery no header names', value: { ...PARSER_MODULE, errorRecoveries: new Map([ [ SLICE_DATA_ERROR_CODE, UNKNOWN_RECOVERY ] ]) } },
        { subject: 'a recovery of a fractional code', value: { ...PARSER_MODULE, errorRecoveries: new Map([ [ FRACTIONAL_COUNT, 'drop' ] ]) } },
        { subject: 'a memory that starts past its maximum', value: { ...PARSER_MODULE, memory: { initialPages: MAXIMUM_PAGES, maximumPages: INITIAL_PAGES } } },
        {
            subject: 'a memory that may grow past the engine\'s bound',
            value: { ...PARSER_MODULE, memory: { initialPages: INITIAL_PAGES, maximumPages: DECODER_PACKAGE_MAXIMUM_MEMORY_PAGES + 1 } }
        },
        { subject: 'fractional pages', value: { ...PARSER_MODULE, memory: { initialPages: FRACTIONAL_COUNT, maximumPages: MAXIMUM_PAGES } } },
        { subject: 'negative pages', value: { ...PARSER_MODULE, memory: { initialPages: NEGATIVE_COUNT, maximumPages: MAXIMUM_PAGES } } },
        {
            subject: 'a missing memory',
            value: { errorNames: ERROR_NAMES, errorRecoveries: ERROR_RECOVERIES, module: PARSER_WASM_MODULE, repeatDirectiveCount: REPEAT_DIRECTIVE_COUNT }
        },
        { subject: 'a missing repeat directive count', value: { ...PARSER_MODULE, repeatDirectiveCount: undefined } },
        { subject: 'a fractional repeat directive count', value: { ...PARSER_MODULE, repeatDirectiveCount: FRACTIONAL_COUNT } },
        { subject: 'no object', value: PARSER_WASM_MODULE }
    ])('refuses $subject', ({ value }) => {
        expect(isGPUDecoderParserModule(value)).toBe(false);
    });
});

describe('isGPUDecoderParseRequest', () => {
    it('accepts a start on a parser module and a parse of a plan\'s units', () => {
        expect(isGPUDecoderParseRequest(START_REQUEST)).toBe(true);
        expect(isGPUDecoderParseRequest(PARSE_REQUEST)).toBe(true);
        expect(isGPUDecoderParseRequest({ ...PARSE_REQUEST, firstUnit: 0, unitCount: 0 })).toBe(true);
    });

    it.each([
        { subject: 'a start without a parser module', value: { ...START_REQUEST, parser: { ...PARSER_MODULE, module: null } } },
        { subject: 'a plan as a view', value: { ...PARSE_REQUEST, plan: new Uint8Array(PLAN_BYTE_LENGTH) } },
        { subject: 'a negative job id', value: { ...PARSE_REQUEST, id: NEGATIVE_COUNT } },
        { subject: 'a fractional unit count', value: { ...PARSE_REQUEST, unitCount: FRACTIONAL_COUNT } },
        { subject: 'a missing first unit', value: { ...PARSE_REQUEST, firstUnit: undefined } },
        { subject: 'an unknown request', value: { ...PARSE_REQUEST, type: UNKNOWN_TYPE } },
        { subject: 'no object', value: null }
    ])('refuses $subject', ({ value }) => {
        expect(isGPUDecoderParseRequest(value)).toBe(false);
    });
});

describe('isGPUDecoderParseResponse', () => {
    it('accepts a parsed job and a failed one, with a decoder error code or code 0', () => {
        expect(isGPUDecoderParseResponse(PARSED_RESPONSE)).toBe(true);
        expect(isGPUDecoderParseResponse(FAILED_RESPONSE)).toBe(true);
        expect(isGPUDecoderParseResponse({ ...FAILED_RESPONSE, code: 0, value: 0 })).toBe(true);
    });

    it.each([
        { subject: 'a job as a view', value: { ...PARSED_RESPONSE, job: new Uint8Array(JOB_BYTE_LENGTH) } },
        { subject: 'a missing job id', value: { ...PARSED_RESPONSE, id: undefined } },
        { subject: 'a negative error code', value: { ...FAILED_RESPONSE, code: NEGATIVE_COUNT } },
        { subject: 'a fractional failing value', value: { ...FAILED_RESPONSE, value: FRACTIONAL_COUNT } },
        { subject: 'a failure without its message', value: { ...FAILED_RESPONSE, message: undefined } },
        { subject: 'an unknown response', value: { ...PARSED_RESPONSE, type: UNKNOWN_TYPE } }
    ])('refuses $subject', ({ value }) => {
        expect(isGPUDecoderParseResponse(value)).toBe(false);
    });
});
