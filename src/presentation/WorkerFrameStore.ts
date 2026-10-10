// The frames a decode worker keeps for its renderer
// A worker-mode run keeps each decoded frame here and posts only its descriptor; the renderer draws a frame by its ID once the page selected it
// A frame outlives its run until the page releases it, except that a stopped or failed run, the next run's start, and the renderer's detach free frames too

import type { Microseconds } from '../MediaTime';
import type { TransferableDolbyVisionEncodedFrameMetadata } from '../video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import type { HDR10PlusFrameMetadata } from '../video/hdr/HDR10PlusMetadata';
import {
    MAXIMUM_OUTSTANDING_RAW_FRAME_TRANSFER_COUNT,
    type TransferableRawVideoFrame
} from '../video/RawVideoFrameCopy';
import { rawFrameLayoutMatches } from './DecodedFramePresentation';
import {
    destroyRawPlaneTextureSet,
    uploadRawYUVFrame,
    type RawPlaneTextureSet
} from './RawYUVGPURenderer';

// As many texture slots as a raw run's frame credits keep in use; a 4K 10-bit slot holds about 25 MB of textures
export const MAXIMUM_SPARE_WORKER_TEXTURE_SLOT_COUNT = MAXIMUM_OUTSTANDING_RAW_FRAME_TRANSFER_COUNT;

/** The timing and metadata a kept frame presents with; both stay in the worker with it. */
export type WorkerFrameDescription = {
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata: TransferableDolbyVisionEncodedFrameMetadata | null
    /** The decode generation whose run keeps the frame */
    generation: number
    HDR10PlusMetadata: HDR10PlusFrameMetadata | null
    mediaTimeMicroseconds: Microseconds
};

/**
 * Where a kept raw frame's planes are.
 * Uploaded planes are in textures of the renderer's device, and planes that were uploaded to a lost device, or kept without a device, are lost.
 * A frame whose layout the upload refused, or whose upload failed, has no planes either.
 */
export type WorkerRawFrameUploadState = 'invalid-layout' | 'lost' | 'upload-failed' | 'uploaded';

/** The textures one kept raw frame's planes were uploaded into: its BL, and the EL of a Dolby Vision pair. */
export type WorkerRawFrameTextureSlot = {
    enhancementTextureSet: RawPlaneTextureSet | null
    textureSet: RawPlaneTextureSet | null
};

type KeptWorkerFrameBase = {
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata?: TransferableDolbyVisionEncodedFrameMetadata
    frameId: number
    generation: number
    HDR10PlusMetadata?: HDR10PlusFrameMetadata
    mediaTimeMicroseconds: Microseconds
};

/** A kept VideoFrame, which the renderer imports as an external texture. */
export type KeptWorkerVideoFrame = KeptWorkerFrameBase & {
    /** Null once its presentation closed it */
    frame: VideoFrame | null
    outputMode: 'video-frame'
};

/** A kept raw frame: the descriptor of its planes, whose buffer already serves later frames, and the textures the planes were uploaded into. */
export type KeptWorkerRawFrame = KeptWorkerFrameBase & {
    /** Absent off a Dolby Vision pair route, and null for a pair whose EL did not decode */
    enhancementFrame?: TransferableRawVideoFrame | null
    frame: TransferableRawVideoFrame
    outputMode: 'raw-planes'
    /** The textures holding the planes; null unless they are uploaded */
    textureSlot: WorkerRawFrameTextureSlot | null
    uploadState: WorkerRawFrameUploadState
};

export type KeptWorkerFrame = KeptWorkerRawFrame | KeptWorkerVideoFrame;

function createKeptFrameBase(description: WorkerFrameDescription, frameId: number): KeptWorkerFrameBase {
    const keptFrameBase: KeptWorkerFrameBase = {
        durationMicroseconds: description.durationMicroseconds,
        frameId,
        generation: description.generation,
        mediaTimeMicroseconds: description.mediaTimeMicroseconds
    };
    if (description.encodedDolbyVisionMetadata) {
        keptFrameBase.encodedDolbyVisionMetadata = description.encodedDolbyVisionMetadata;
    }
    if (description.HDR10PlusMetadata) {
        keptFrameBase.HDR10PlusMetadata = description.HDR10PlusMetadata;
    }
    return keptFrameBase;
}

function destroyTextureSlot(textureSlot: WorkerRawFrameTextureSlot): void {
    try {
        destroyRawPlaneTextureSet(textureSlot.textureSet);
        destroyRawPlaneTextureSet(textureSlot.enhancementTextureSet);
    } catch (error) {
        console.warn('Unable to destroy a worker frame texture slot', error);
    }
    textureSlot.textureSet = null;
    textureSlot.enhancementTextureSet = null;
}

function closeVideoFrame(frame: VideoFrame): void {
    try {
        frame.close();
    } catch (error) {
        console.warn('Unable to close a kept VideoFrame', error);
    }
}

/**
 * Keeps the frames of worker-mode runs by an ID unique for the worker's life.
 * Raw planes are uploaded into reusable texture slots as they are kept, so their buffers return to the decoders at once.
 */
export default class WorkerFrameStore {
    private device: GPUDevice | null = null;
    private readonly keptFrames = new Map<number, KeptWorkerFrame>();
    private nextFrameId = 0;
    private readonly spareTextureSlots: WorkerRawFrameTextureSlot[] = [];

    /**
     * Uploads later raw frames to a device, or keeps them without planes when there is none.
     * Planes uploaded to another device are lost, so their frames present as not presented, and spare slots are destroyed.
     */
    public setDevice(device: GPUDevice | null): void {
        if (device === this.device) {
            return;
        }
        this.device = device;
        for (const textureSlot of this.spareTextureSlots.splice(0)) {
            destroyTextureSlot(textureSlot);
        }
        for (const keptFrame of this.keptFrames.values()) {
            if (keptFrame.outputMode === 'raw-planes' && keptFrame.textureSlot) {
                destroyTextureSlot(keptFrame.textureSlot);
                keptFrame.textureSlot = null;
                keptFrame.uploadState = 'lost';
            }
        }
    }

    /** Keeps a decoded VideoFrame until its release, and returns its ID. */
    public keepVideoFrame(description: WorkerFrameDescription, frame: VideoFrame): number {
        const frameId = this.takeFrameId();
        this.keptFrames.set(frameId, {
            ...createKeptFrameBase(description, frameId),
            frame,
            outputMode: 'video-frame'
        });
        return frameId;
    }

    /**
     * Uploads a raw frame's planes, and a Dolby Vision pair's EL, into a texture slot, keeps the frame's descriptor until its release, and returns its ID.
     * The upload copies the planes, so the frame's buffer can serve the next frame as soon as this returns.
     */
    public keepRawFrame(
        description: WorkerFrameDescription,
        frame: TransferableRawVideoFrame,
        enhancementFrame: TransferableRawVideoFrame | null | undefined
    ): number {
        const frameId = this.takeFrameId();
        const keptFrame: KeptWorkerRawFrame = {
            ...createKeptFrameBase(description, frameId),
            frame,
            outputMode: 'raw-planes',
            textureSlot: null,
            uploadState: 'lost'
        };
        if (enhancementFrame !== undefined) {
            keptFrame.enhancementFrame = enhancementFrame;
        }
        this.uploadRawFrame(keptFrame);
        this.keptFrames.set(frameId, keptFrame);
        return frameId;
    }

    /** Returns a frame a generation keeps, or null when the generation keeps no frame of that ID. */
    public getFrame(generation: number, frameId: number): KeptWorkerFrame | null {
        const keptFrame = this.keptFrames.get(frameId);
        return keptFrame?.generation === generation ? keptFrame : null;
    }

    /** Takes a kept VideoFrame for its one presentation; the frame stays kept without it until its release. */
    public takeVideoFrame(keptFrame: KeptWorkerVideoFrame): VideoFrame | null {
        const frame = keptFrame.frame;
        keptFrame.frame = null;
        return frame;
    }

    /** Frees the frames of a generation that the page released, and returns how many of them the store still kept. */
    public release(generation: number, frameIds: readonly number[]): number {
        let releasedFrameCount = 0;
        for (const frameId of frameIds) {
            const keptFrame = this.getFrame(generation, frameId);
            if (keptFrame) {
                this.free(keptFrame);
                releasedFrameCount += 1;
            }
        }
        return releasedFrameCount;
    }

    /** Frees every frame a generation keeps, as its run stops or fails. */
    public releaseGeneration(generation: number): void {
        for (const keptFrame of [ ...this.keptFrames.values() ]) {
            if (keptFrame.generation === generation) {
                this.free(keptFrame);
            }
        }
    }

    /** Frees the frames of every other generation, which earlier runs that ended on their own left, as a run starts. */
    public releaseOtherGenerations(generation: number): void {
        for (const keptFrame of [ ...this.keptFrames.values() ]) {
            if (keptFrame.generation !== generation) {
                this.free(keptFrame);
            }
        }
    }

    /** Frees every kept frame, as the renderer that would present them goes. */
    public releaseAll(): void {
        for (const keptFrame of [ ...this.keptFrames.values() ]) {
            this.free(keptFrame);
        }
    }

    /** Returns how many frames a generation keeps. */
    public getFrameCount(generation: number): number {
        let frameCount = 0;
        for (const keptFrame of this.keptFrames.values()) {
            if (keptFrame.generation === generation) {
                frameCount += 1;
            }
        }
        return frameCount;
    }

    private takeFrameId(): number {
        const frameId = this.nextFrameId;
        this.nextFrameId += 1;
        return frameId;
    }

    private uploadRawFrame(keptFrame: KeptWorkerRawFrame): void {
        if (!rawFrameLayoutMatches(keptFrame)) {
            keptFrame.uploadState = 'invalid-layout';
            return;
        }
        const device = this.device;
        if (!device) {
            keptFrame.uploadState = 'lost';
            return;
        }

        const textureSlot = this.spareTextureSlots.pop() ?? { enhancementTextureSet: null, textureSet: null };
        try {
            const uploadResult = uploadRawYUVFrame({
                device,
                enhancementFrame: keptFrame.enhancementFrame ?? null,
                enhancementTextureSet: textureSlot.enhancementTextureSet,
                frame: keptFrame.frame,
                textureSet: textureSlot.textureSet
            });
            textureSlot.textureSet = uploadResult.textureSet;
            textureSlot.enhancementTextureSet = uploadResult.enhancementTextureSet;
            keptFrame.textureSlot = textureSlot;
            keptFrame.uploadState = 'uploaded';
        } catch (error) {
            console.warn('Unable to upload a kept raw frame', error);
            // A failed upload may have replaced or destroyed the slot's textures, so the slot goes with it
            destroyTextureSlot(textureSlot);
            keptFrame.uploadState = 'upload-failed';
        }
    }

    private free(keptFrame: KeptWorkerFrame): void {
        this.keptFrames.delete(keptFrame.frameId);
        switch (keptFrame.outputMode) {
            case 'video-frame': {
                const frame = this.takeVideoFrame(keptFrame);
                if (frame) {
                    closeVideoFrame(frame);
                }
                return;
            }
            case 'raw-planes': {
                const textureSlot = keptFrame.textureSlot;
                keptFrame.textureSlot = null;
                keptFrame.uploadState = 'lost';
                if (textureSlot) {
                    this.recycleTextureSlot(textureSlot);
                }
                return;
            }
        }
    }

    private recycleTextureSlot(textureSlot: WorkerRawFrameTextureSlot): void {
        const slotDevice = textureSlot.textureSet?.device ?? null;
        if (
            this.spareTextureSlots.length >= MAXIMUM_SPARE_WORKER_TEXTURE_SLOT_COUNT
            || slotDevice === null
            || slotDevice !== this.device
        ) {
            destroyTextureSlot(textureSlot);
            return;
        }
        this.spareTextureSlots.push(textureSlot);
    }
}
