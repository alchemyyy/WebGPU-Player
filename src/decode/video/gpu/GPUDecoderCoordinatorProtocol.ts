// Messages between the decode worker and its parser coordinator worker, which runs a video decoder package's parser coordinator and parse workers.
import { isDecoderPackageVersion, type DecoderPackageVersion } from '../../packages/DecoderPackageIdentity';
import { isVideoFrameFields } from '../VideoFields';
import { isGPUDecoderOutputFormat } from './GPUDecodeFormats';
import type { GPUDecoderParserModule, GPUDecoderParserPicture } from './GPUDecoderParser';
import { isGPUDecoderParserModule } from './GPUDecoderParseProtocol';
import { isGPUDecoderPictureSize, isGPUDecoderRepeatCounts, type GPUDecoderPictureSize } from './GPUDecodeTypes';

/** Opens a pipeline for one attempt; it replaces the worker's previous one, and its parse workers stay while the package version does. */
export type GPUDecoderCoordinatorOpenRequest = Readonly<{
    codecPrivate: ArrayBuffer | null
    /** The parser's package, by its id and content hash, so parse workers started for one package version serve its later attempts */
    packageVersion: DecoderPackageVersion
    parser: GPUDecoderParserModule
    pipelineId: number
    type: 'open'
}>;

/** Hands the pipeline its next packet in decode order. */
export type GPUDecoderCoordinatorSubmitRequest = Readonly<{
    packet: ArrayBuffer
    pipelineId: number
    sequence: number
    type: 'submit'
}>;

/** Ends a pipeline, as an attempt ends. */
export type GPUDecoderCoordinatorCloseRequest = Readonly<{
    pipelineId: number
    type: 'close'
}>;

export type GPUDecoderCoordinatorRequest = GPUDecoderCoordinatorCloseRequest | GPUDecoderCoordinatorOpenRequest | GPUDecoderCoordinatorSubmitRequest;

/** An opened pipeline, with the largest picture its codec private data declares, or null. */
export type GPUDecoderCoordinatorOpenedResponse = Readonly<{
    maximumPictureSize: GPUDecoderPictureSize | null
    pipelineId: number
    type: 'opened'
}>;

/** One packet's output: its pictures' GPU records with the output events their steps decided, and the events of a call that planned no picture. */
export type GPUDecoderCoordinatorResultResponse = Readonly<{
    pictures: readonly GPUDecoderParserPicture[]
    pipelineId: number
    sequence: number
    trailingEvents: Uint32Array
    type: 'result'
}>;

/**
 * A failed open, with a null sequence, or a failed packet, after which every later packet fails too:
 * the decoder error code and value of a parser's failed check, which decide its recovery, or code 0 with the error's message.
 */
export type GPUDecoderCoordinatorFailedResponse = Readonly<{
    code: number
    message: string
    pipelineId: number
    sequence: number | null
    type: 'failed'
    value: number
}>;

export type GPUDecoderCoordinatorResponse = GPUDecoderCoordinatorFailedResponse | GPUDecoderCoordinatorOpenedResponse | GPUDecoderCoordinatorResultResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isParserPicture(value: unknown): value is GPUDecoderParserPicture {
    return isRecord(value)
        && value.events instanceof Uint32Array
        && (value.fields === null || isVideoFrameFields(value.fields))
        && (value.format === null || (typeof value.format === 'string' && isGPUDecoderOutputFormat(value.format)))
        && (value.maximumPictureSize === null || isGPUDecoderPictureSize(value.maximumPictureSize))
        && value.record instanceof ArrayBuffer
        && isGPUDecoderRepeatCounts(value.repeatCounts)
        && (value.visibleSize === null || isGPUDecoderPictureSize(value.visibleSize));
}

export function isGPUDecoderCoordinatorRequest(value: unknown): value is GPUDecoderCoordinatorRequest {
    if (!isRecord(value) || !isCount(value.pipelineId)) {
        return false;
    }
    switch (value.type) {
        case 'open':
            return (value.codecPrivate === null || value.codecPrivate instanceof ArrayBuffer)
                && isGPUDecoderParserModule(value.parser)
                && isDecoderPackageVersion(value.packageVersion);
        case 'submit':
            return value.packet instanceof ArrayBuffer && isCount(value.sequence);
        case 'close':
            return true;
        default:
            return false;
    }
}

export function isGPUDecoderCoordinatorResponse(value: unknown): value is GPUDecoderCoordinatorResponse {
    if (!isRecord(value) || !isCount(value.pipelineId)) {
        return false;
    }
    switch (value.type) {
        case 'opened':
            return value.maximumPictureSize === null || isGPUDecoderPictureSize(value.maximumPictureSize);
        case 'result':
            return isCount(value.sequence)
                && Array.isArray(value.pictures)
                && value.pictures.every(isParserPicture)
                && value.trailingEvents instanceof Uint32Array;
        case 'failed':
            return typeof value.message === 'string'
                && (value.sequence === null || isCount(value.sequence))
                && isCount(value.code)
                && isCount(value.value);
        default:
            return false;
    }
}
