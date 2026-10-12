// The conformance check of a user decoder: decode its vector on a device, read back the checked frames' planes, and compare their SHA-256 with the declared hash.
// The caller demuxes the vector file and hands over its packets; overhual/decoders.md in the engine root describes verification.
import type { GPUFramePoolLayout } from './GPUFramePool';
import {
    type GPUDecodePacket,
    type GPUDecoderManifest,
    type GPUDecoderVector,
    type GPUDecodeStreamFacts,
    GPUVideoDecodeError,
    type GPUVideoDecodeFailureCode
} from './GPUDecodeTypes';
import GPUVideoDecodeSession from './GPUVideoDecodeSession';

/**
 * The outcome of a vector check: 'passed' or the check that failed.
 * - 'unverified': the decoder declares no vector, so it runs only when the user forces it.
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
    | 'passed'
    | 'slots-exhausted'
    | 'unverified'
    | GPUVideoDecodeFailureCode;

/** A vector check's code and a terse detail with the failing value, such as `frames-missing: 2 < 3`; a passed check's detail is the hash. */
export type GPUDecoderVectorCheckResult = {
    code: GPUDecoderVectorCheckCode
    detail: string
};

/** What the check decodes: the vector file's packets in decode order and its stream facts, as the demuxer reads them. */
export type GPUDecoderVectorInput = {
    codecPrivate: Uint8Array | null
    packets: readonly GPUDecodePacket[]
    stream: GPUDecodeStreamFacts
};

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

/** Returns the lowercase hexadecimal SHA-256 of a decoder's source, which keys its cached vector results. */
export function hashGPUDecoderSource(source: string): Promise<string> {
    return computeSHA256(new TextEncoder().encode(source));
}

/** Returns the bytes one frame contributes to the vector hash: every plane at its size, rows tightly packed. */
export function getGPUDecoderVectorFrameByteLength(layout: GPUFramePoolLayout): number {
    let byteLength = 0;
    for (const plane of layout.planes) {
        byteLength += plane.width * plane.height * layout.bytesPerSample;
    }
    return byteLength;
}

/** Writes a slot's planes into target at targetOffset as the vector hash reads them: luma then chroma, each row without its padding. */
export function packGPUDecoderVectorFrame(layout: GPUFramePoolLayout, slotBytes: Uint8Array, target: Uint8Array, targetOffset: number): void {
    let writeOffset = targetOffset;
    for (const plane of layout.planes) {
        const rowByteLength = plane.width * layout.bytesPerSample;
        for (let row = 0; row < plane.height; row += 1) {
            const rowStart = plane.byteOffset + row * plane.bytesPerRow;
            target.set(slotBytes.subarray(rowStart, rowStart + rowByteLength), writeOffset);
            writeOffset += rowByteLength;
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

/** Takes every presentable frame in presentation order, reading back the checked ones into readbacks; returns the frames presented so far. */
function presentVectorFrames(
    device: GPUDevice,
    session: GPUVideoDecodeSession,
    vector: GPUDecoderVector,
    presentedFrameCount: number,
    readbacks: Promise<Uint8Array>[]
): number {
    let frameCount = presentedFrameCount;
    for (let decoded = session.takeNextFrame(); decoded !== null; decoded = session.takeNextFrame()) {
        if (frameCount >= vector.firstFrame && frameCount <= vector.lastFrame) {
            readbacks.push(readSlot(device, session, decoded.slot));
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
    packets: readonly GPUDecodePacket[],
    readbacks: Promise<Uint8Array>[]
): Promise<GPUDecoderVectorCheckResult | null> {
    for (const packet of packets) {
        session.queuePacket(packet);
    }
    session.endOfStream();
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

/** Decodes the vector in a created session and compares the hash of its checked frames with the declared one. */
async function decodeAndHashVector(
    device: GPUDevice,
    session: GPUVideoDecodeSession,
    vector: GPUDecoderVector,
    packets: readonly GPUDecodePacket[]
): Promise<GPUDecoderVectorCheckResult> {
    const readbacks: Promise<Uint8Array>[] = [];
    try {
        const decodeFailure = await decodeVectorFrames(device, session, vector, packets, readbacks);
        if (decodeFailure) {
            return decodeFailure;
        }
        let slotCopies: Uint8Array[];
        try {
            slotCopies = await Promise.all(readbacks);
        } catch (error) {
            return { code: 'readback-failed', detail: describeError(error) };
        }
        const layout = session.pool.layout;
        const frameByteLength = getGPUDecoderVectorFrameByteLength(layout);
        const checkedPlanes = new Uint8Array(slotCopies.length * frameByteLength);
        for (let frameIndex = 0; frameIndex < slotCopies.length; frameIndex += 1) {
            packGPUDecoderVectorFrame(layout, slotCopies[frameIndex], checkedPlanes, frameIndex * frameByteLength);
        }
        const sha256 = await computeSHA256(checkedPlanes);
        return sha256 === vector.sha256 ? { code: 'passed', detail: sha256 } : { code: 'hash-mismatch', detail: `${sha256} != ${vector.sha256}` };
    } finally {
        // No readback outlives the check, whichever way it ended
        await Promise.allSettled(readbacks);
    }
}

/**
 * Decodes a decoder's vector on a device and compares the SHA-256 of frames firstFrame through lastFrame, in presentation order, with the declared hash.
 * Every failed check is a coded result; it rejects only on an unexpected error.
 */
export async function checkGPUDecoderVector(
    device: GPUDevice,
    manifest: GPUDecoderManifest,
    input: GPUDecoderVectorInput
): Promise<GPUDecoderVectorCheckResult> {
    const vector = manifest.vector;
    if (!vector) {
        return { code: 'unverified', detail: '' };
    }
    let session: GPUVideoDecodeSession;
    try {
        session = await GPUVideoDecodeSession.create({ codecPrivate: input.codecPrivate, device, manifest, stream: input.stream });
    } catch (error) {
        if (error instanceof GPUVideoDecodeError) {
            return { ...error.failure };
        }
        throw error;
    }
    try {
        return await decodeAndHashVector(device, session, vector, input.packets);
    } finally {
        session.destroy();
    }
}

/** Caches vector results per device and decoder source hash; a device recreated after a loss starts with none, so its decoders are checked again. */
export class GPUDecoderVectorCheckCache {
    private readonly results = new WeakMap<GPUDevice, Map<string, Promise<GPUDecoderVectorCheckResult>>>();

    /** Returns the decoder's result on the device, checking its vector the first time; an unexpected error is not cached, so a later call checks again. */
    check(device: GPUDevice, decoderHash: string, manifest: GPUDecoderManifest, input: GPUDecoderVectorInput): Promise<GPUDecoderVectorCheckResult> {
        let deviceResults = this.results.get(device);
        if (!deviceResults) {
            deviceResults = new Map<string, Promise<GPUDecoderVectorCheckResult>>();
            this.results.set(device, deviceResults);
        }
        const cachedResult = deviceResults.get(decoderHash);
        if (cachedResult) {
            return cachedResult;
        }
        const result = checkGPUDecoderVector(device, manifest, input);
        const resultsOfDevice = deviceResults;
        resultsOfDevice.set(decoderHash, result);
        // The caller still receives the rejection through result
        void result.catch((): void => {
            resultsOfDevice.delete(decoderHash);
        });
        return result;
    }
}
