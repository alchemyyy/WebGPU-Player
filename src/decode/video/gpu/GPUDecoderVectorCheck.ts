// The self-test of a decoder package: decode one of its vectors on a device, read back the checked frames' planes, and compare their SHA-256 with the vector's.
// The vector's packets come from the package's vectors section; a package with a parser hands over its parser's outputs instead.
// The engine book's decoder packages chapter describes verification.
import type { GPUDecoderParserOutput } from './GPUDecoderParser';
import type { GPUDecoderVector } from './GPUDecoderVectorSet';
import { getGPUDecoderFormatFacts } from './GPUDecodeFormats';
import type { GPUFramePoolLayout } from './GPUFramePool';
import {
    type GPUDecodePacket,
    type GPUDecoderManifest,
    type GPUDecodeStreamFacts,
    GPUVideoDecodeError,
    type GPUVideoDecodeFailureCode
} from './GPUDecodeTypes';
import GPUVideoDecodeSession, { type GPUDecodedFrame } from './GPUVideoDecodeSession';

/**
 * The outcome of a vector check: 'passed' or the check that failed.
 * - 'unverified': the package carries no vector for the format, so there was nothing to check.
 * - 'parser-failed': the package's parser failed on the vector's packets.
 * - 'frames-dropped': the decoder reordered deeper than it declared, so frames left presentation order.
 * - 'frames-missing': fewer frames came out than the vector checks.
 * - 'slots-exhausted': the pool stayed full, as when a decoder never frees its references.
 * - 'hash-mismatch': the checked frames decoded to other planes.
 * - A session failure code, when the session could not be created or failed while decoding the vector.
 */
export type GPUDecoderVectorCheckCode =
    | 'frames-dropped'
    | 'frames-missing'
    | 'hash-mismatch'
    | 'parser-failed'
    | 'passed'
    | 'slots-exhausted'
    | 'unverified'
    | GPUVideoDecodeFailureCode;

/** A vector check's code and a terse detail with the failing value, such as `frames-missing: 2 < 3`; a passed check's detail is the hash. */
export type GPUDecoderVectorCheckResult = {
    code: GPUDecoderVectorCheckCode
    detail: string
};

/** What a vector's session decodes: its packets, and the output events its last packets decided without a picture to carry them. */
type VectorStream = Readonly<{
    packets: readonly GPUDecodePacket[]
    trailingEvents: Uint32Array | null
}>;

/**
 * Returns the packets a vector's session decodes: its own, or for a package with a parser, one record per picture its parser made of them,
 * each with its packet's timestamp, duration, and keyframe flag.
 * A call that planned no picture posts nothing, and its output events wait for the next picture, or for the end, as the decode worker does.
 */
function createVectorStream(vector: GPUDecoderVector, parserOutputs: readonly GPUDecoderParserOutput[] | null): VectorStream {
    const packets: GPUDecodePacket[] = [];
    let carriedEvents: number[] = [];
    for (const [ packetIndex, packet ] of vector.packets.entries()) {
        const output = parserOutputs ? parserOutputs[packetIndex] : null;
        if (!output) {
            packets.push({
                data: packet.data,
                durationMicroseconds: packet.durationMicroseconds,
                keyframe: packet.keyframe,
                outputEvents: null,
                repeatCounts: null,
                reset: packets.length === 0,
                timestampMicroseconds: packet.timestampMicroseconds,
                visibleSize: null
            });
            continue;
        }
        for (const picture of output.pictures) {
            packets.push({
                data: picture.record,
                durationMicroseconds: packet.durationMicroseconds,
                keyframe: packet.keyframe,
                outputEvents: Uint32Array.from([ ...carriedEvents, ...picture.events ]),
                repeatCounts: picture.repeatCounts,
                reset: packets.length === 0,
                timestampMicroseconds: packet.timestampMicroseconds,
                visibleSize: picture.visibleSize
            });
            carriedEvents = [];
        }
        carriedEvents.push(...output.trailingEvents);
    }
    return { packets, trailingEvents: carriedEvents.length > 0 ? Uint32Array.from(carriedEvents) : null };
}

const HASH_ALGORITHM = 'SHA-256';
const HEXADECIMAL_RADIX = 16;
const BYTE_HEXADECIMAL_DIGIT_COUNT = 2;
const VECTOR_READBACK_LABEL = 'GPU decoder vector readback';
// Rounds of waiting for the GPU and the status readbacks with nothing decoded or presented, after which the pool counts as exhausted
const MAXIMUM_IDLE_ROUND_COUNT = 2;

/** Returns the lowercase hexadecimal SHA-256 of bytes. */
async function computeSHA256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    // eslint-disable-next-line compat/compat -- WebGPU and WebCrypto both need a secure context, so every device the check runs on has crypto.subtle
    const digest = new Uint8Array(await crypto.subtle.digest(HASH_ALGORITHM, bytes));
    let hexadecimal = '';
    for (const byte of digest) {
        hexadecimal += byte.toString(HEXADECIMAL_RADIX).padStart(BYTE_HEXADECIMAL_DIGIT_COUNT, '0');
    }
    return hexadecimal;
}

type VisibleRectangle = GPUDecodeStreamFacts['visibleRectangle'];

/** The part of one slot plane the vector hash reads: its visible rows, each from its first visible sample. */
type HashedPlaneRegion = {
    byteOffset: number
    bytesPerRow: number
    rowByteLength: number
    rowCount: number
};

/**
 * Returns each plane's visible region, luma first.
 * A chroma region is the visible rectangle divided by the format's subsampling, with sizes rounded up as FFmpeg sizes chroma planes.
 */
function getHashedPlaneRegions(layout: GPUFramePoolLayout, visibleRectangle: VisibleRectangle): HashedPlaneRegion[] {
    const formatFacts = getGPUDecoderFormatFacts(layout.format);
    return layout.planes.map((plane, planeIndex: number): HashedPlaneRegion => {
        const widthDivisor = planeIndex === 0 ? 1 : formatFacts.chromaWidthDivisor;
        const heightDivisor = planeIndex === 0 ? 1 : formatFacts.chromaHeightDivisor;
        const firstColumn = Math.floor(visibleRectangle.x / widthDivisor);
        const firstRow = Math.floor(visibleRectangle.y / heightDivisor);
        return {
            byteOffset: plane.byteOffset + firstRow * plane.bytesPerRow + firstColumn * layout.bytesPerSample,
            bytesPerRow: plane.bytesPerRow,
            rowByteLength: Math.ceil(visibleRectangle.width / widthDivisor) * layout.bytesPerSample,
            rowCount: Math.ceil(visibleRectangle.height / heightDivisor)
        };
    });
}

/** Returns the bytes one frame contributes to the vector hash: every plane's visible region, rows tightly packed. */
export function getGPUDecoderVectorFrameByteLength(layout: GPUFramePoolLayout, visibleRectangle: VisibleRectangle): number {
    let byteLength = 0;
    for (const region of getHashedPlaneRegions(layout, visibleRectangle)) {
        byteLength += region.rowByteLength * region.rowCount;
    }
    return byteLength;
}

/** Writes a slot's visible planes into target at targetOffset as the vector hash reads them: luma then chroma, each row without padding. */
export function packGPUDecoderVectorFrame(
    layout: GPUFramePoolLayout,
    visibleRectangle: VisibleRectangle,
    slotBytes: Uint8Array,
    target: Uint8Array,
    targetOffset: number
): void {
    let writeOffset = targetOffset;
    for (const region of getHashedPlaneRegions(layout, visibleRectangle)) {
        for (let row = 0; row < region.rowCount; row += 1) {
            const rowStart = region.byteOffset + row * region.bytesPerRow;
            target.set(slotBytes.subarray(rowStart, rowStart + region.rowByteLength), writeOffset);
            writeOffset += region.rowByteLength;
        }
    }
}

/** Returns an error's name and message, the detail of a failure the browser raised. */
function describeError(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Copies a slot into a mappable buffer behind the work queued so far, so the slot may take a new frame once the copy is submitted. */
function readSlot(device: GPUDevice, session: GPUVideoDecodeSession, slot: number): Promise<Uint8Array> {
    const slotByteLength = session.pool.layout.slotByteLength;
    const buffer = device.createBuffer({ label: VECTOR_READBACK_LABEL, size: slotByteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder({ label: VECTOR_READBACK_LABEL });
    encoder.copyBufferToBuffer(session.pool.buffer, session.pool.getSlotByteOffset(slot), buffer, 0, slotByteLength);
    device.queue.submit([ encoder.finish() ]);
    return buffer.mapAsync(GPUMapMode.READ).then(
        (): Uint8Array => {
            const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
            buffer.unmap();
            buffer.destroy();
            return bytes;
        },
        (error: unknown): never => {
            buffer.destroy();
            throw error;
        }
    );
}

/** A checked frame's slot copy, as it reads back, and the rectangle the hash covers of it. */
type CheckedFrameReadback = Readonly<{
    slotBytes: Promise<Uint8Array>
    visibleRectangle: VisibleRectangle
}>;

/** Returns the rectangle the hash covers of a frame: the visible size its picture reported, else the vector's visible rectangle. */
function getHashedRectangle(decoded: GPUDecodedFrame, vector: GPUDecoderVector): VisibleRectangle {
    const visibleSize = decoded.visibleSize;
    return visibleSize ? { height: visibleSize.height, width: visibleSize.width, x: 0, y: 0 } : vector.stream.visibleRectangle;
}

/** Takes every presentable frame in presentation order, reading back the checked ones into readbacks; returns the frames presented so far. */
function presentVectorFrames(
    device: GPUDevice,
    session: GPUVideoDecodeSession,
    vector: GPUDecoderVector,
    presentedFrameCount: number,
    readbacks: CheckedFrameReadback[]
): number {
    let frameCount = presentedFrameCount;
    for (let decoded = session.takeNextFrame(); decoded !== null; decoded = session.takeNextFrame()) {
        if (frameCount >= vector.firstFrame && frameCount <= vector.lastFrame) {
            readbacks.push({ slotBytes: readSlot(device, session, decoded.slot), visibleRectangle: getHashedRectangle(decoded, vector) });
        }
        session.releaseFrame(decoded);
        frameCount += 1;
    }
    return frameCount;
}

/** Returns the check a finished decode failed: a failure the last packets reported, a dropped frame, or a missing frame; null when none. */
async function getFinishedDecodeFailure(
    device: GPUDevice,
    session: GPUVideoDecodeSession,
    vector: GPUDecoderVector,
    presentedFrameCount: number
): Promise<GPUDecoderVectorCheckResult | null> {
    // A decoder error the last packets report fails the check even when their frames came out
    await device.queue.onSubmittedWorkDone();
    await session.flushStatusReadbacks();
    const failure = session.getFailure();
    if (failure) {
        return { ...failure };
    }
    const droppedFrameCount = session.getDroppedFrameCount();
    if (droppedFrameCount > 0) {
        return { code: 'frames-dropped', detail: String(droppedFrameCount) };
    }
    if (presentedFrameCount <= vector.lastFrame) {
        return { code: 'frames-missing', detail: `${presentedFrameCount} < ${vector.lastFrame + 1}` };
    }
    return null;
}

/**
 * Decodes the vector's packets and presents every frame in order, reading back the checked ones into readbacks.
 * Returns the failed check, or null once every checked frame is read back and no failure, drop, or missing frame occurred.
 */
async function decodeVectorFrames(
    device: GPUDevice,
    session: GPUVideoDecodeSession,
    vector: GPUDecoderVector,
    stream: VectorStream,
    readbacks: CheckedFrameReadback[]
): Promise<GPUDecoderVectorCheckResult | null> {
    for (const packet of stream.packets) {
        session.queuePacket(packet);
    }
    session.endOfStream(stream.trailingEvents);
    let presentedFrameCount = 0;
    let idleRoundCount = 0;
    while (presentedFrameCount <= vector.lastFrame && (session.getPendingPacketCount() > 0 || session.getQueuedFrameCount() > 0)) {
        const pendingPacketCount = session.getPendingPacketCount();
        const frameCountBefore = presentedFrameCount;
        session.submitPendingDecodeWork();
        presentedFrameCount = presentVectorFrames(device, session, vector, presentedFrameCount, readbacks);
        const failure = session.getFailure();
        if (failure) {
            return { ...failure };
        }
        if (session.getPendingPacketCount() < pendingPacketCount || presentedFrameCount > frameCountBefore) {
            idleRoundCount = 0;
            continue;
        }
        idleRoundCount += 1;
        if (idleRoundCount > MAXIMUM_IDLE_ROUND_COUNT) {
            return { code: 'slots-exhausted', detail: `${session.getPendingPacketCount()} packets, ${session.getFreeSlotCount()} free slots` };
        }
        // Reference slots free only through status readbacks, which arrive as the GPU progresses
        await device.queue.onSubmittedWorkDone();
        await session.waitForStatusReadbacks();
    }
    return getFinishedDecodeFailure(device, session, vector, presentedFrameCount);
}

/** Decodes the vector in a created session and compares the hash of its checked frames with the vector's. */
async function decodeAndHashVector(
    device: GPUDevice,
    session: GPUVideoDecodeSession,
    vector: GPUDecoderVector,
    stream: VectorStream
): Promise<GPUDecoderVectorCheckResult> {
    const readbacks: CheckedFrameReadback[] = [];
    try {
        const decodeFailure = await decodeVectorFrames(device, session, vector, stream, readbacks);
        if (decodeFailure) {
            return decodeFailure;
        }
        let slotCopies: Uint8Array[];
        try {
            slotCopies = await Promise.all(readbacks.map((readback: CheckedFrameReadback): Promise<Uint8Array> => readback.slotBytes));
        } catch (error) {
            return { code: 'readback-failed', detail: describeError(error) };
        }
        const layout = session.pool.layout;
        // Each frame contributes its own visible rectangle, which a picture of its own size changes
        const frameByteLengths = readbacks.map((readback: CheckedFrameReadback): number => getGPUDecoderVectorFrameByteLength(layout, readback.visibleRectangle));
        const checkedPlanes = new Uint8Array(frameByteLengths.reduce((total: number, byteLength: number): number => total + byteLength, 0));
        let frameOffset = 0;
        for (let frameIndex = 0; frameIndex < slotCopies.length; frameIndex += 1) {
            packGPUDecoderVectorFrame(layout, readbacks[frameIndex].visibleRectangle, slotCopies[frameIndex], checkedPlanes, frameOffset);
            frameOffset += frameByteLengths[frameIndex];
        }
        const sha256 = await computeSHA256(checkedPlanes);
        return sha256 === vector.sha256 ? { code: 'passed', detail: sha256 } : { code: 'hash-mismatch', detail: `${sha256} != ${vector.sha256}` };
    } finally {
        // No readback outlives the check, whichever way it ended
        await Promise.allSettled(readbacks.map((readback: CheckedFrameReadback): Promise<Uint8Array> => readback.slotBytes));
    }
}

/**
 * Decodes a vector with a decoder on a device and compares the SHA-256 of frames firstFrame through lastFrame, in presentation order, with the vector's hash.
 * parserOutputs holds the parser's output for each of the vector's packets, for a package with a parser, and null otherwise.
 * Every failed check is a coded result; it rejects only on an unexpected error.
 */
export async function checkGPUDecoderVector(
    device: GPUDevice,
    manifest: GPUDecoderManifest,
    vector: GPUDecoderVector,
    parserOutputs: readonly GPUDecoderParserOutput[] | null
): Promise<GPUDecoderVectorCheckResult> {
    let session: GPUVideoDecodeSession;
    try {
        session = await GPUVideoDecodeSession.create({ codecPrivate: vector.codecPrivate, device, format: vector.format, manifest, stream: vector.stream });
    } catch (error) {
        if (error instanceof GPUVideoDecodeError) {
            return { ...error.failure };
        }
        throw error;
    }
    try {
        return await decodeAndHashVector(device, session, vector, createVectorStream(vector, parserOutputs));
    } finally {
        session.destroy();
    }
}
