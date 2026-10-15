// The GPU decode route's frame pool: one storage buffer of slots that a decoder writes and the signal step reads in place.
// The engine book's decoder packages chapter describes the route.
import {
    FRAME_POOL_LAYOUT_BYTE_LENGTH,
    writeFramePoolLayout,
    type FramePoolPlaneLayout
} from '../../../presentation/passes/PassResources';
import type { FramePoolFrame } from '../../../presentation/passes/PassTypes';
import {
    COPY_BYTES_PER_ROW_ALIGNMENT,
    STORAGE_BUFFER_OFFSET_ALIGNMENT,
    U32_VALUE_COUNT
} from '../../../presentation/WebGPUConstants';
import { getGPUDecoderFormatFacts, type GPUDecoderOutputFormat } from './GPUDecodeFormats';
import { GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT, GPU_FRAME_POOL_MAXIMUM_SLOT_COUNT } from './GPUDecodeLimits';
import { type GPUDecodeStreamFacts, GPUVideoDecodeError } from './GPUDecodeTypes';

/** The alignment of every row pitch, plane offset, and slot stride in the pool, so a slot can be bound as a storage buffer or copied to a texture on its own. */
export const GPU_FRAME_POOL_ALIGNMENT = Math.max(STORAGE_BUFFER_OFFSET_ALIGNMENT, COPY_BYTES_PER_ROW_ALIGNMENT);

/** Slots presentation needs: the frame on screen, the frame replacing it, and one frame decoded ahead. */
export const GPU_FRAME_POOL_PRESENTATION_SLOT_COUNT = 3;

/** Spare slots of a decoder with references, which cover the frames its freed slots take to read back asynchronously. */
export const GPU_FRAME_POOL_STATUS_SPARE_SLOT_COUNT = 2;

/** Where one slot's planes live, the same in every slot of a pool. */
export type GPUFramePoolLayout = {
    byteLength: number
    bytesPerSample: 1 | 2
    codedHeight: number
    codedWidth: number
    format: GPUDecoderOutputFormat
    /** Luma, then the two chroma planes, at byte offsets from the start of a slot. */
    planes: readonly FramePoolPlaneLayout[]
    slotByteLength: number
    slotCount: number
};

export type GPUFramePoolLimits = Pick<GPUSupportedLimits, 'maxBufferSize' | 'maxStorageBufferBindingSize'>;

/** Rounds value up to a multiple of alignment. */
export function alignTo(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

/**
 * Returns the stream facts a decoder receives for a track the container sizes width x height, decoded to format.
 * The pool takes that size padded to whole coding blocks, and the decoder's header refines the visible rectangle.
 * Playback and the vector checks both size a decoder's session this way.
 */
export function createGPUDecodeStreamFacts(width: number, height: number, format: GPUDecoderOutputFormat): GPUDecodeStreamFacts {
    return {
        bitDepth: getGPUDecoderFormatFacts(format).bitDepth,
        codedHeight: alignTo(height, GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT),
        codedWidth: alignTo(width, GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT),
        visibleRectangle: { height, width, x: 0, y: 0 }
    };
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

/** Returns the slots a decoder needs: its references, its reorder depth, presentation's slots, and spares when references free late. */
export function getGPUFramePoolSlotCount(references: number, reorder: number): number {
    const spareSlotCount = references > 0 ? GPU_FRAME_POOL_STATUS_SPARE_SLOT_COUNT : 0;
    return references + reorder + GPU_FRAME_POOL_PRESENTATION_SLOT_COUNT + spareSlotCount;
}

/** Throws the 'coded-size' failure unless the coded size is a positive integer size. */
export function requireGPUFramePoolCodedSize(codedWidth: number, codedHeight: number): void {
    if (!isPositiveSafeInteger(codedWidth) || !isPositiveSafeInteger(codedHeight)) {
        throw new GPUVideoDecodeError({ code: 'coded-size', detail: `${codedWidth}x${codedHeight}` });
    }
}

/**
 * Lays out a pool of slotCount slots of one coded size, with rows and planes aligned to GPU_FRAME_POOL_ALIGNMENT.
 * Throws a GPUVideoDecodeError: 'coded-size', 'slot-count', or 'pool-size' when WGSL cannot address the pool.
 */
export function createGPUFramePoolLayout(
    format: GPUDecoderOutputFormat,
    codedWidth: number,
    codedHeight: number,
    slotCount: number
): GPUFramePoolLayout {
    requireGPUFramePoolCodedSize(codedWidth, codedHeight);
    if (!Number.isSafeInteger(slotCount) || slotCount < 1 || slotCount > GPU_FRAME_POOL_MAXIMUM_SLOT_COUNT) {
        throw new GPUVideoDecodeError({ code: 'slot-count', detail: `${slotCount} outside [1, ${GPU_FRAME_POOL_MAXIMUM_SLOT_COUNT}]` });
    }
    const formatFacts = getGPUDecoderFormatFacts(format);
    const chromaWidth = Math.ceil(codedWidth / formatFacts.chromaWidthDivisor);
    const chromaHeight = Math.ceil(codedHeight / formatFacts.chromaHeightDivisor);
    const planeSizes = [
        { height: codedHeight, width: codedWidth },
        { height: chromaHeight, width: chromaWidth },
        { height: chromaHeight, width: chromaWidth }
    ];
    const planes: FramePoolPlaneLayout[] = [];
    let slotByteLength = 0;
    for (const planeSize of planeSizes) {
        const bytesPerRow = alignTo(planeSize.width * formatFacts.bytesPerSample, GPU_FRAME_POOL_ALIGNMENT);
        planes.push({ byteOffset: slotByteLength, bytesPerRow, height: planeSize.height, width: planeSize.width });
        slotByteLength += bytesPerRow * planeSize.height;
    }
    const byteLength = slotByteLength * slotCount;
    // WGSL addresses pool bytes in u32 arithmetic
    if (byteLength > U32_VALUE_COUNT) {
        throw new GPUVideoDecodeError({ code: 'pool-size', detail: `${byteLength} > ${U32_VALUE_COUNT}` });
    }
    return {
        byteLength,
        bytesPerSample: formatFacts.bytesPerSample,
        codedHeight,
        codedWidth,
        format,
        planes,
        slotByteLength,
        slotCount
    };
}

/** Returns the largest pool a device's limits allow, which must fit one buffer and one storage binding. */
export function getGPUFramePoolByteLimit(limits: GPUFramePoolLimits): number {
    return Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
}

/** Returns whether a device's limits allow the pool's buffer; a stream whose pool they do not allow is not eligible for the decoder. */
export function isGPUFramePoolWithinLimits(layout: GPUFramePoolLayout, limits: GPUFramePoolLimits): boolean {
    return layout.byteLength <= getGPUFramePoolByteLimit(limits);
}

/**
 * The pool buffer and its slots' lifetimes.
 * A slot holds an output, from decode through presentation until presentation releases it, and, for a decoder with references, a reference until the decoder reports it freed.
 * A slot is free when it holds neither.
 */
export default class GPUFramePool {
    readonly buffer: GPUBuffer;
    readonly layout: GPUFramePoolLayout;
    private readonly frames: readonly FramePoolFrame[];
    private readonly layoutBuffers: readonly GPUBuffer[];
    private readonly outputHeld: boolean[];
    private readonly referenceHeld: boolean[];

    /**
     * Creates the pool buffer and one layout uniform per slot, which naming a slot's frame needs no per-frame write.
     * Throws the 'pool-size' GPUVideoDecodeError when the device's limits do not allow the pool.
     */
    constructor(device: GPUDevice, layout: GPUFramePoolLayout, visibleRectangle: FramePoolFrame['visibleRectangle']) {
        if (!isGPUFramePoolWithinLimits(layout, device.limits)) {
            throw new GPUVideoDecodeError({ code: 'pool-size', detail: `${layout.byteLength} > ${getGPUFramePoolByteLimit(device.limits)}` });
        }
        this.layout = layout;
        this.buffer = device.createBuffer({
            label: 'GPU decode frame pool',
            size: layout.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        });
        const frames: FramePoolFrame[] = [];
        const layoutBuffers: GPUBuffer[] = [];
        for (let slot = 0; slot < layout.slotCount; slot += 1) {
            const layoutBuffer = device.createBuffer({
                label: `GPU decode frame pool slot ${slot} layout`,
                size: FRAME_POOL_LAYOUT_BYTE_LENGTH,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            });
            const layoutData = new ArrayBuffer(FRAME_POOL_LAYOUT_BYTE_LENGTH);
            writeFramePoolLayout(new DataView(layoutData), {
                bitDepth: getGPUDecoderFormatFacts(layout.format).bitDepth,
                bytesPerComponent: layout.bytesPerSample,
                planes: layout.planes,
                slotByteOffset: slot * layout.slotByteLength
            });
            device.queue.writeBuffer(layoutBuffer, 0, layoutData);
            layoutBuffers.push(layoutBuffer);
            frames.push({
                codedHeight: layout.codedHeight,
                codedWidth: layout.codedWidth,
                layout: layoutBuffer,
                pool: this.buffer,
                visibleRectangle: { ...visibleRectangle }
            });
        }
        this.frames = frames;
        this.layoutBuffers = layoutBuffers;
        this.outputHeld = new Array<boolean>(layout.slotCount).fill(false);
        this.referenceHeld = new Array<boolean>(layout.slotCount).fill(false);
    }

    /** Takes the lowest free slot for a decode's output, also held as a reference when the decoder keeps references; null when none is free. */
    acquireSlot(heldAsReference: boolean): number | null {
        for (let slot = 0; slot < this.layout.slotCount; slot += 1) {
            if (!this.outputHeld[slot] && !this.referenceHeld[slot]) {
                this.outputHeld[slot] = true;
                this.referenceHeld[slot] = heldAsReference;
                return slot;
            }
        }
        return null;
    }

    /** Ends a slot's output hold; returns false when it held none. */
    releaseOutput(slot: number): boolean {
        this.requireSlot(slot);
        const held = this.outputHeld[slot];
        this.outputHeld[slot] = false;
        return held;
    }

    /** Ends a slot's reference hold; returns false when it held none. */
    releaseReference(slot: number): boolean {
        this.requireSlot(slot);
        const held = this.referenceHeld[slot];
        this.referenceHeld[slot] = false;
        return held;
    }

    /** Ends every reference hold, as a decoder reset drops its references. */
    releaseAllReferences(): void {
        this.referenceHeld.fill(false);
    }

    /** Returns whether a slot is held as a reference. */
    isReferenceHeld(slot: number): boolean {
        this.requireSlot(slot);
        return this.referenceHeld[slot];
    }

    getFreeSlotCount(): number {
        let freeSlotCount = 0;
        for (let slot = 0; slot < this.layout.slotCount; slot += 1) {
            if (!this.outputHeld[slot] && !this.referenceHeld[slot]) {
                freeSlotCount += 1;
            }
        }
        return freeSlotCount;
    }

    /**
     * Gives every slot's frame the visible rectangle a decoder's header reported, which replaces the container's.
     * Returns false, changing nothing, when the rectangle is not a nonempty integer rectangle inside the coded frame.
     */
    setVisibleRectangle(visibleRectangle: FramePoolFrame['visibleRectangle']): boolean {
        const values = [ visibleRectangle.x, visibleRectangle.y, visibleRectangle.width, visibleRectangle.height ];
        const withinCodedFrame = values.every((value: number): boolean => Number.isSafeInteger(value) && value >= 0)
            && visibleRectangle.width > 0
            && visibleRectangle.height > 0
            && visibleRectangle.x + visibleRectangle.width <= this.layout.codedWidth
            && visibleRectangle.y + visibleRectangle.height <= this.layout.codedHeight;
        if (!withinCodedFrame) {
            return false;
        }
        for (const frame of this.frames) {
            frame.visibleRectangle = { ...visibleRectangle };
        }
        return true;
    }

    /** Returns the frame that presents a slot, whose layout uniform names the slot. */
    getFrame(slot: number): FramePoolFrame {
        this.requireSlot(slot);
        return this.frames[slot];
    }

    /** Returns the byte offset of a slot in the pool buffer. */
    getSlotByteOffset(slot: number): number {
        this.requireSlot(slot);
        return slot * this.layout.slotByteLength;
    }

    destroy(): void {
        this.buffer.destroy();
        for (const layoutBuffer of this.layoutBuffers) {
            layoutBuffer.destroy();
        }
    }

    private requireSlot(slot: number): void {
        if (!Number.isSafeInteger(slot) || slot < 0 || slot >= this.layout.slotCount) {
            throw new RangeError(`slot: ${slot} outside [0, ${this.layout.slotCount - 1}]`);
        }
    }
}
