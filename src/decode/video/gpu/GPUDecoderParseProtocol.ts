// Messages between a parser's coordinator and its parse workers, which parse planned pictures' units on their own parser instances.
import { isDecoderPackageMemoryLimits } from '../../packages/DecoderPackageImports';
import type { GPUDecoderParserModule } from './GPUDecoderParser';
import { isGPUDecoderErrorRecovery } from './GPUDecodeTypes';

/** Starts the worker on a package's parser module. */
export type GPUDecoderParseStartRequest = Readonly<{
    parser: GPUDecoderParserModule
    type: 'start'
}>;

/** Parses units firstUnit to firstUnit + unitCount of a serialized plan. */
export type GPUDecoderParseJobRequest = Readonly<{
    firstUnit: number
    id: number
    plan: ArrayBuffer
    type: 'parse'
    unitCount: number
}>;

export type GPUDecoderParseRequest = GPUDecoderParseJobRequest | GPUDecoderParseStartRequest;

/** A parsed job, serialized for the coordinator's finish. */
export type GPUDecoderParseJobResponse = Readonly<{
    id: number
    job: ArrayBuffer
    type: 'parsed'
}>;

/** A job that failed: the decoder error code and value of a failed check, or code 0 with the error's message. */
export type GPUDecoderParseFailureResponse = Readonly<{
    code: number
    id: number
    message: string
    type: 'failed'
    value: number
}>;

export type GPUDecoderParseResponse = GPUDecoderParseFailureResponse | GPUDecoderParseJobResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Returns whether a value is error recoveries: each a code's recovery the header declared. */
function isErrorRecoveries(value: unknown): boolean {
    if (!(value instanceof Map)) {
        return false;
    }
    for (const [ code, recovery ] of value) {
        if (!isCount(code) || typeof recovery !== 'string' || !isGPUDecoderErrorRecovery(recovery)) {
            return false;
        }
    }
    return true;
}

/**
 * Returns whether a value is a parser module message: a compiled module, its memory limits or null, its error names and recoveries,
 * and its header's repeat count.
 */
export function isGPUDecoderParserModule(value: unknown): value is GPUDecoderParserModule {
    if (
        !isRecord(value)
        || !(value.module instanceof WebAssembly.Module)
        || !(value.errorNames instanceof Map)
        || !isErrorRecoveries(value.errorRecoveries)
        || !isCount(value.repeatDirectiveCount)
    ) {
        return false;
    }
    return value.memory === null || isDecoderPackageMemoryLimits(value.memory);
}

export function isGPUDecoderParseRequest(value: unknown): value is GPUDecoderParseRequest {
    if (!isRecord(value)) {
        return false;
    }
    switch (value.type) {
        case 'start':
            return isGPUDecoderParserModule(value.parser);
        case 'parse':
            return isCount(value.id) && value.plan instanceof ArrayBuffer && isCount(value.firstUnit) && isCount(value.unitCount);
        default:
            return false;
    }
}

export function isGPUDecoderParseResponse(value: unknown): value is GPUDecoderParseResponse {
    if (!isRecord(value) || !isCount(value.id)) {
        return false;
    }
    switch (value.type) {
        case 'parsed':
            return value.job instanceof ArrayBuffer;
        case 'failed':
            return isCount(value.code) && isCount(value.value) && typeof value.message === 'string';
        default:
            return false;
    }
}
