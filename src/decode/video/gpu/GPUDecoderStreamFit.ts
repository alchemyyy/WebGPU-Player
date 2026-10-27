// Whether a GPU decoder fits a stream on a device before a session exists: its header's stream conditions on the picture's size, its frame pool, its state and scratch buffers, and its packet ring.
// Eligibility skips an offer that does not fit, a session that a parser's declared maximum picture would size keeps the container's size unless the decoder fits that maximum,
// and a stream change's session takes the new sequence's requirement alone, or the pool before it grown to the picture. The engine book's decoder packages chapter describes them.
import { evaluatePassExpression } from '../../../presentation/passes/PassExpression';
import { BYTES_PER_WORD, INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE } from '../../../presentation/WebGPUConstants';
import type { GPUDecoderOutputFormat } from './GPUDecodeFormats';
import {
    GPU_DECODE_MAXIMUM_SCRATCH_BUFFER_BYTE_LENGTH,
    GPU_DECODE_PACKET_RING_PACKET_COUNT,
    GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT
} from './GPUDecodeLimits';
import { evaluateGPUDecoderByteLength, getGPUDecoderAcceptsFacts, getGPUDecoderFacts } from './GPUDecoderManifest';
import { alignTo, createGPUFramePoolLayout, getGPUFramePoolSlotCount } from './GPUFramePool';
import {
    GPUVideoDecodeError,
    type GPUDecoderHeader,
    type GPUDecoderPictureSize,
    type GPUDecodeStreamFacts,
    type GPUVideoDecodeFailure,
    type GPUVideoDecodeFailureCode
} from './GPUDecodeTypes';

// The state buffer may be empty, and every other buffer holds at least one byte
const EMPTY_STATE_BYTE_LENGTH = 0;
const MINIMUM_BUFFER_BYTE_LENGTH = 1;
// The check a decoder whose header conditions do not take the stream fails
const ACCEPTS_FAILURE_CODE: GPUVideoDecodeFailureCode = 'accepts';

/** The byte lengths of a decoder's state and scratch buffers for one stream and output format. */
export type GPUDecoderBufferSizes = Readonly<{
    bufferByteLengths: readonly number[]
    stateByteLength: number
}>;

/**
 * Evaluates a decoder's state and scratch buffer sizes for the stream and format, each a whole byte count within its bounds.
 * Throws the 'state-size' or 'buffer-size' GPUVideoDecodeError with the value that failed.
 */
export function evaluateGPUDecoderBufferSizes(manifest: GPUDecoderHeader, stream: GPUDecodeStreamFacts, format: GPUDecoderOutputFormat): GPUDecoderBufferSizes {
    const facts = getGPUDecoderFacts(stream, format);
    const state = evaluateGPUDecoderByteLength(manifest.stateByteLength, facts, EMPTY_STATE_BYTE_LENGTH, MAXIMUM_STORAGE_BUFFER_BINDING_SIZE);
    if (state.kind === 'invalid') {
        throw new GPUVideoDecodeError({ code: 'state-size', detail: state.detail });
    }
    const bufferByteLengths: number[] = [];
    for (const buffer of manifest.buffers) {
        const minimum = buffer.indirect ? INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH : MINIMUM_BUFFER_BYTE_LENGTH;
        const size = evaluateGPUDecoderByteLength(buffer.byteLength, facts, minimum, GPU_DECODE_MAXIMUM_SCRATCH_BUFFER_BYTE_LENGTH);
        if (size.kind === 'invalid') {
            throw new GPUVideoDecodeError({ code: 'buffer-size', detail: `${buffer.name} ${size.detail}` });
        }
        bufferByteLengths.push(size.byteLength);
    }
    return { bufferByteLengths, stateByteLength: state.byteLength };
}

/** Returns the byte length of a decoder's packet ring: its packets of the header's largest packet, each word aligned. */
export function getGPUDecoderPacketRingByteLength(manifest: GPUDecoderHeader): number {
    return alignTo(manifest.packetByteLength, BYTES_PER_WORD) * GPU_DECODE_PACKET_RING_PACKET_COUNT;
}

/**
 * Returns the first buffer a device cannot hold whole within its buffer limit, the smaller of its largest buffer and its largest storage binding:
 * the state as 'state-size', a scratch buffer as 'buffer-size', or the packet ring as 'packet-size'; null when every one fits.
 */
export function findGPUDecoderBufferLimitFailure(
    manifest: GPUDecoderHeader,
    sizes: GPUDecoderBufferSizes,
    maximumBufferByteLength: number
): GPUVideoDecodeFailure | null {
    const stateByteLength = alignTo(sizes.stateByteLength, BYTES_PER_WORD);
    if (stateByteLength > maximumBufferByteLength) {
        return { code: 'state-size', detail: `${stateByteLength} > ${maximumBufferByteLength}` };
    }
    for (const [ bufferIndex, buffer ] of manifest.buffers.entries()) {
        const byteLength = alignTo(sizes.bufferByteLengths[bufferIndex], BYTES_PER_WORD);
        if (byteLength > maximumBufferByteLength) {
            return { code: 'buffer-size', detail: `${buffer.name} ${byteLength} > ${maximumBufferByteLength}` };
        }
    }
    const ringByteLength = getGPUDecoderPacketRingByteLength(manifest);
    if (ringByteLength > maximumBufferByteLength) {
        return { code: 'packet-size', detail: `ring ${ringByteLength} > ${maximumBufferByteLength}` };
    }
    return null;
}

/** Returns the picture size a stream's facts describe: the extent of its visible rectangle, before the pool's rounding up to whole coding blocks. */
export function getGPUDecodeStreamPictureSize(stream: GPUDecodeStreamFacts): GPUDecoderPictureSize {
    const rectangle = stream.visibleRectangle;
    return { height: rectangle.y + rectangle.height, width: rectangle.x + rectangle.width };
}

/**
 * Returns whether a decoder's `accepts` conditions take a stream's pool and the pictures it must hold; a condition that cannot evaluate the facts takes nothing.
 * `stream.width` and `stream.height` read the pool's coded size, and `picture.width` and `picture.height` the picture size, the stream's visible extent unless one is given,
 * before the pool's rounding, so a decoder can bound its pictures as its codec's levels do.
 */
export function acceptsGPUDecodeStream(
    manifest: GPUDecoderHeader,
    stream: GPUDecodeStreamFacts,
    format: GPUDecoderOutputFormat,
    pictureSize: GPUDecoderPictureSize = getGPUDecodeStreamPictureSize(stream)
): boolean {
    const constraint = manifest.accepts.constraint;
    if (constraint === null) {
        return true;
    }
    try {
        return evaluatePassExpression(constraint, getGPUDecoderAcceptsFacts(stream, format, pictureSize)) !== 0;
    } catch {
        return false;
    }
}

/** Returns the 'accepts' failure of a pool and picture size the decoder's `accepts` conditions refuse at the stream's bit depth, or null when they take them. */
function findAcceptsFailure(
    manifest: GPUDecoderHeader,
    stream: GPUDecodeStreamFacts,
    format: GPUDecoderOutputFormat,
    pictureSize: GPUDecoderPictureSize
): GPUVideoDecodeFailure | null {
    if (acceptsGPUDecodeStream(manifest, stream, format, pictureSize)) {
        return null;
    }
    return {
        code: ACCEPTS_FAILURE_CODE,
        detail: `picture ${pictureSize.width}x${pictureSize.height} in pool ${stream.codedWidth}x${stream.codedHeight} at ${stream.bitDepth} bits`
    };
}

/** Returns `accepts: picture <width>x<height> in pool <width>x<height> at <depth> bits` when a decoder's `accepts` conditions refuse a stream and picture size, or null. */
export function findGPUDecoderAcceptsFailure(
    manifest: GPUDecoderHeader,
    stream: GPUDecodeStreamFacts,
    format: GPUDecoderOutputFormat,
    pictureSize: GPUDecoderPictureSize = getGPUDecodeStreamPictureSize(stream)
): string | null {
    const failure = findAcceptsFailure(manifest, stream, format, pictureSize);
    return failure ? `${failure.code}: ${failure.detail}` : null;
}

/**
 * Returns the first check a decoder fails for a stream: its `accepts` conditions on the picture size, then, on a device whose buffer limit is given,
 * its frame pool and its state, scratch buffers, and packet ring; a null limit judges `accepts` alone.
 */
function findStreamFitFailure(
    manifest: GPUDecoderHeader,
    stream: GPUDecodeStreamFacts,
    format: GPUDecoderOutputFormat,
    maximumBufferByteLength: number | null,
    pictureSize: GPUDecoderPictureSize
): GPUVideoDecodeFailure | null {
    const acceptsFailure = findAcceptsFailure(manifest, stream, format, pictureSize);
    if (acceptsFailure !== null || maximumBufferByteLength === null) {
        return acceptsFailure;
    }
    try {
        const layout = createGPUFramePoolLayout(format, stream.codedWidth, stream.codedHeight, getGPUFramePoolSlotCount(manifest.references, manifest.reorder));
        return layout.byteLength > maximumBufferByteLength ?
            { code: 'pool-size', detail: `${layout.byteLength} > ${maximumBufferByteLength}` } :
            findGPUDecoderBufferLimitFailure(manifest, evaluateGPUDecoderBufferSizes(manifest, stream, format), maximumBufferByteLength);
    } catch (error) {
        if (!(error instanceof GPUVideoDecodeError)) {
            throw error;
        }
        return error.failure;
    }
}

/**
 * Returns the first check a decoder fails for a stream and output format on a device that holds buffers of at most maximumBufferByteLength bytes,
 * as `<code>: <detail>`: its header conditions ('accepts') on the picture size, the stream's visible extent unless given,
 * its frame pool ('pool-size', or the pool layout's own failure), then its state, scratch buffers, and packet ring; null when it fits.
 */
export function findGPUDecoderStreamFitFailure(
    manifest: GPUDecoderHeader,
    stream: GPUDecodeStreamFacts,
    format: GPUDecoderOutputFormat,
    maximumBufferByteLength: number,
    pictureSize: GPUDecoderPictureSize = getGPUDecodeStreamPictureSize(stream)
): string | null {
    const failure = findStreamFitFailure(manifest, stream, format, maximumBufferByteLength, pictureSize);
    return failure ? `${failure.code}: ${failure.detail}` : null;
}

/** Returns the stream facts of a picture size's pool: the size rounded up to whole coding blocks, with the stream's visible rectangle clipped into it. */
function createPoolStream(stream: GPUDecodeStreamFacts, pictureSize: GPUDecoderPictureSize): GPUDecodeStreamFacts {
    const codedWidth = alignTo(pictureSize.width, GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT);
    const codedHeight = alignTo(pictureSize.height, GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT);
    const rectangle = stream.visibleRectangle;
    const x = Math.min(rectangle.x, codedWidth - 1);
    const y = Math.min(rectangle.y, codedHeight - 1);
    return {
        ...stream,
        codedHeight,
        codedWidth,
        visibleRectangle: { height: Math.min(rectangle.height, codedHeight - y), width: Math.min(rectangle.width, codedWidth - x), x, y }
    };
}

/** The pool a session takes, or the failure of a stream change whose every pool the decoder or the device refuses. */
export type GPUDecodeSessionStreamChoice =
    | Readonly<{ kind: 'stream'; stream: GPUDecodeStreamFacts }>
    | Readonly<{ failure: GPUVideoDecodeFailure; kind: 'refused' }>;

/**
 * Chooses the stream facts a session sizes its pool and its decoder's buffers by; a null buffer limit judges the decoder's `accepts` alone,
 * as the feed foresees a pool before its session exists.
 * A first session, without a fallback picture size, takes the larger of the stream's coded size and the largest picture the parser declared, when the decoder fits it, else the stream's.
 * A stream change's session decodes only the new sequence's pictures, so it takes the picture's requirement alone when the decoder fits it, else its fallback,
 * the pool before it grown to the picture; when the decoder fits neither, the change is refused with the fallback's failure.
 */
export function chooseGPUDecodeSessionStream(
    manifest: GPUDecoderHeader,
    format: GPUDecoderOutputFormat,
    stream: GPUDecodeStreamFacts,
    maximumPictureSize: GPUDecoderPictureSize | null,
    maximumBufferByteLength: number | null,
    fallbackPictureSize: GPUDecoderPictureSize | null
): GPUDecodeSessionStreamChoice {
    if (fallbackPictureSize === null) {
        if (maximumPictureSize === null) {
            return { kind: 'stream', stream };
        }
        // The pool holds the container's pictures and the declared largest one
        const containerPictureSize = getGPUDecodeStreamPictureSize(stream);
        const pictureSize: GPUDecoderPictureSize = {
            height: Math.max(containerPictureSize.height, maximumPictureSize.height),
            width: Math.max(containerPictureSize.width, maximumPictureSize.width)
        };
        const declaredStream = createPoolStream(stream, pictureSize);
        if (declaredStream.codedWidth === stream.codedWidth && declaredStream.codedHeight === stream.codedHeight) {
            return { kind: 'stream', stream };
        }
        const fits = findStreamFitFailure(manifest, declaredStream, format, maximumBufferByteLength, pictureSize) === null;
        return { kind: 'stream', stream: fits ? declaredStream : stream };
    }
    if (maximumPictureSize !== null) {
        const requiredStream = createPoolStream(stream, maximumPictureSize);
        if (findStreamFitFailure(manifest, requiredStream, format, maximumBufferByteLength, maximumPictureSize) === null) {
            return { kind: 'stream', stream: requiredStream };
        }
    }
    const fallbackStream = createPoolStream(stream, fallbackPictureSize);
    const failure = findStreamFitFailure(manifest, fallbackStream, format, maximumBufferByteLength, fallbackPictureSize);
    return failure === null ? { kind: 'stream', stream: fallbackStream } : { failure, kind: 'refused' };
}

/**
 * Returns the stream facts a session sizes its pool and its decoder's buffers by on a device with the given buffer limit, as chooseGPUDecodeSessionStream chooses them.
 * The visible rectangle stays the stream's, clipped into the pool, so frames that report no size of their own present as before.
 * Throws the GPUVideoDecodeError of a stream change the decoder or the device refuses.
 */
export function selectGPUDecodeSessionStream(
    manifest: GPUDecoderHeader,
    format: GPUDecoderOutputFormat,
    stream: GPUDecodeStreamFacts,
    maximumPictureSize: GPUDecoderPictureSize | null,
    maximumBufferByteLength: number,
    fallbackPictureSize: GPUDecoderPictureSize | null = null
): GPUDecodeStreamFacts {
    const choice = chooseGPUDecodeSessionStream(manifest, format, stream, maximumPictureSize, maximumBufferByteLength, fallbackPictureSize);
    if (choice.kind === 'refused') {
        throw new GPUVideoDecodeError(choice.failure);
    }
    return choice.stream;
}
