import { EncodedPacket } from 'mediabunny';

import { requireMicroseconds } from '../../TimeMath';
import {
    DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION,
    MAXIMUM_DOLBY_VISION_FRAME_RPU_COUNT,
    MAXIMUM_DOLBY_VISION_RPU_BYTE_LENGTH,
    MAXIMUM_DOLBY_VISION_RPU_FRAME_BYTE_LENGTH,
    type DolbyVisionEncodedFrameMetadata
} from './DolbyVisionEncodedMetadataProtocol';
import {
    decodeDolbyVisionRPUSnapshot,
    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH
} from './DolbyVisionRPUParser';
import {
    splitDolbyVisionHEVCAccessUnit,
    type DolbyVisionHEVCSplitResult,
    type HEVCNALFormat
} from './DolbyVisionHEVCSplitter';
import { splitDolbyVisionAV1TemporalUnit } from './DolbyVisionAV1Splitter';
import { parseHEVCDecoderConfiguration } from '../decoders/HEVCSoftwareVideoDecoder';

export const MAXIMUM_DOLBY_VISION_PENDING_FRAME_COUNT = 64;
export const MAXIMUM_DOLBY_VISION_PENDING_METADATA_BYTE_LENGTH = 64 * 1_024 * 1_024;
const DOLBY_VISION_PACKET_PAIR_TOLERANCE_MICROSECONDS = 1;
// Profile 10 is single-layer, so one RPU describes a temporal unit's one shown frame
const MAXIMUM_DOLBY_VISION_AV1_TEMPORAL_UNIT_RPU_COUNT = 1;

export type ProcessedDolbyVisionHEVCPacket = {
    baseLayerPacket: EncodedPacket | null
    enhancementLayerPacket: EncodedPacket | null
    hasBaseLayerVCL: boolean
    hasEnhancementLayerVCL: boolean
};

export type ProcessedDolbyVisionAV1TemporalUnit = {
    /** The temporal unit without its Dolby Vision metadata OBUs; the input packet when it carried none */
    decoderPacket: EncodedPacket
    /** Whether the decoder outputs a frame, which takes the unit's metadata entry */
    hasFrame: boolean
};

export type DolbyVisionRPUDataParser = {
    parse: (rpuNALUnit: Uint8Array) => Promise<ArrayBuffer>
};

export type DolbyVisionAV1RPUDataParser = {
    parseAV1ITUTT35: (payload: Uint8Array) => Promise<ArrayBuffer>
};

type DolbyVisionCodecName = 'AV1' | 'HEVC';

type PendingFrameMetadata = {
    byteLength: number
    metadata: DolbyVisionEncodedFrameMetadata | null
};

function toUint8Array(data: AllowSharedBufferSource): Uint8Array {
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    throw new TypeError('The HEVC decoder description is not a buffer source');
}

/** Resolves whether encoded HEVC access units use HVCC lengths or Annex B. */
export function getHEVCNALFormat(decoderConfig: VideoDecoderConfig): HEVCNALFormat {
    if (decoderConfig.description === undefined) {
        return { kind: 'annex-b' };
    }

    const decoderConfiguration = parseHEVCDecoderConfiguration(
        toUint8Array(decoderConfig.description)
    );
    return {
        kind: 'length-prefixed',
        lengthSize: decoderConfiguration.lengthSize
    };
}

function getMetadataByteLength(
    encodedRPUs: readonly Uint8Array[],
    parsedRPUData: readonly ArrayBuffer[]
): number {
    if (encodedRPUs.length > MAXIMUM_DOLBY_VISION_FRAME_RPU_COUNT) {
        throw new TypeError('A Dolby Vision frame contains too many RPUs');
    }

    let rpuByteLength = 0;
    for (const encodedRPU of encodedRPUs) {
        if (
            encodedRPU.byteLength === 0
            || encodedRPU.byteLength > MAXIMUM_DOLBY_VISION_RPU_BYTE_LENGTH
        ) {
            throw new TypeError('A Dolby Vision RPU exceeds its size bound');
        }
        rpuByteLength += encodedRPU.byteLength;
    }
    if (rpuByteLength > MAXIMUM_DOLBY_VISION_RPU_FRAME_BYTE_LENGTH) {
        throw new TypeError('Dolby Vision RPU data exceeds its per-frame size bound');
    }
    if (parsedRPUData.length !== encodedRPUs.length
        || parsedRPUData.some(data => data.byteLength !== DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH)) {
        throw new TypeError('Parsed Dolby Vision RPU data does not match its encoded frame');
    }

    return rpuByteLength
        + (parsedRPUData.length * DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH);
}

/**
 * Returns whether a frame's only RPU is single-layer. Such an RPU presents no EL, so EL data in its frame, as
 * from a malformed Profile 5 or 8 stream that sets the EL flag or carries NAL 63, is discarded.
 */
function hasOnlySingleLayerRPU(parsedRPUData: readonly ArrayBuffer[]): boolean {
    return parsedRPUData.length === 1
        && decodeDolbyVisionRPUSnapshot(parsedRPUData[0]).layerMode === 'single-layer';
}

function discardEnhancementLayer(splitResult: DolbyVisionHEVCSplitResult): DolbyVisionHEVCSplitResult {
    return {
        ...splitResult,
        enhancementLayerData: null,
        hasEnhancementLayerVCL: false,
        hasRequiredEnhancementLayerParameterSets: false
    };
}

function getEnhancementLayerDisposition(
    enhancementLayerData: Uint8Array | null,
    parsedRPUData: readonly ArrayBuffer[]
): DolbyVisionEncodedFrameMetadata['enhancementLayerDisposition'] {
    if (!enhancementLayerData) {
        return 'absent';
    }
    if (parsedRPUData.length !== 1) {
        throw new TypeError('A Dolby Vision enhancement access unit requires one exact RPU');
    }

    const snapshot = decodeDolbyVisionRPUSnapshot(parsedRPUData[0]);
    switch (snapshot.layerMode) {
        case 'fel':
            return 'discarded-fel';
        case 'mel':
            return 'discarded-mel';
        case 'single-layer':
            // Callers discard the EL data of a single-layer frame before classifying it
            throw new TypeError('A single-layer Dolby Vision RPU contains enhancement data');
    }
}

/**
 * Holds each frame's packet metadata until the decoder emits the frame, keyed by presentation timestamp.
 * Entries that share a timestamp keep their decode order, and the window bounds the frames and bytes it holds.
 */
class DolbyVisionFrameMetadataWindow {
    private pendingByteLength = 0;
    private pendingFrameCount = 0;
    private readonly pendingFrames = new Map<number, PendingFrameMetadata[]>();

    public constructor(private readonly codecName: DolbyVisionCodecName) {}

    public enqueue(
        timestampMicroseconds: number,
        pendingFrame: PendingFrameMetadata
    ): void {
        if (this.pendingFrameCount >= MAXIMUM_DOLBY_VISION_PENDING_FRAME_COUNT) {
            throw new Error('The Dolby Vision metadata frame window exceeded its bound');
        }
        if (
            this.pendingByteLength + pendingFrame.byteLength
            > MAXIMUM_DOLBY_VISION_PENDING_METADATA_BYTE_LENGTH
        ) {
            throw new Error('The Dolby Vision metadata byte window exceeded its bound');
        }

        const frames = this.pendingFrames.get(timestampMicroseconds) ?? [];
        if (!this.pendingFrames.has(timestampMicroseconds)) {
            this.pendingFrames.set(timestampMicroseconds, frames);
        }
        frames.push(pendingFrame);
        this.pendingFrameCount += 1;
        this.pendingByteLength += pendingFrame.byteLength;
    }

    /** Takes the oldest entry recorded for one decoded frame's timestamp. */
    public take(timestampMicrosecondsValue: number): DolbyVisionEncodedFrameMetadata | null {
        const timestampMicroseconds = requireMicroseconds(
            timestampMicrosecondsValue,
            `Decoded ${this.codecName} frame timestamp`
        );
        const frames = this.pendingFrames.get(timestampMicroseconds);
        if (!frames || frames.length === 0) {
            throw new Error(`A decoded ${this.codecName} frame has no matching encoded packet metadata`);
        }

        const pendingFrame = frames.shift() as PendingFrameMetadata;
        if (frames.length === 0) {
            this.pendingFrames.delete(timestampMicroseconds);
        }
        this.pendingFrameCount -= 1;
        this.pendingByteLength -= pendingFrame.byteLength;
        return pendingFrame.metadata;
    }

    /** Rejects decoder packet loss instead of attaching stale RPU data later. */
    public requireDrained(): void {
        if (this.pendingFrameCount !== 0 || this.pendingByteLength !== 0) {
            throw new Error(`The ${this.codecName} decoder ended before every metadata entry was matched`);
        }
    }

    public clear(): void {
        this.pendingFrames.clear();
        this.pendingFrameCount = 0;
        this.pendingByteLength = 0;
    }
}

/** Owns split HEVC metadata until the decoder emits the matching frame PTS. */
export default class DolbyVisionEncodedMetadataQueue {
    private readonly frameMetadataWindow = new DolbyVisionFrameMetadataWindow('HEVC');

    public constructor(
        private readonly inputFormat: HEVCNALFormat,
        private readonly rpuParser: DolbyVisionRPUDataParser,
        private readonly enhancementOutputFormat: HEVCNALFormat = inputFormat,
        private readonly retainDolbyVisionMetadata = true
    ) {}

    /**
     * Removes DV NAL units from one packet and records bounded frame metadata. The EL data of a frame whose only
     * RPU is single-layer is discarded, so its metadata and result report no EL.
     */
    public async processPacket(packet: EncodedPacket): Promise<ProcessedDolbyVisionHEVCPacket> {
        const timestampMicroseconds = requireMicroseconds(
            packet.microsecondTimestamp,
            'Encoded HEVC packet timestamp'
        );
        const splitResult = splitDolbyVisionHEVCAccessUnit(
            packet.data,
            this.inputFormat,
            this.enhancementOutputFormat
        );
        const hasDolbyVisionFrameData = splitResult.rpuNALUnits.length > 0
            || splitResult.hasEnhancementLayerVCL;
        if (hasDolbyVisionFrameData && !splitResult.hasBaseLayerVCL) {
            throw new TypeError('Dolby Vision metadata is not paired with a base-layer picture');
        }

        const parsedRPUData = await this.parseRPUData(splitResult.rpuNALUnits);
        const discardsEnhancementLayer = splitResult.enhancementLayerData !== null
            && hasOnlySingleLayerRPU(parsedRPUData);
        const presentedSplit = discardsEnhancementLayer ?
            discardEnhancementLayer(splitResult) :
            splitResult;

        if (presentedSplit.hasBaseLayerVCL) {
            this.frameMetadataWindow.enqueue(
                timestampMicroseconds,
                this.createPendingFrameMetadata(
                    presentedSplit,
                    parsedRPUData,
                    hasDolbyVisionFrameData
                )
            );
        }

        return {
            baseLayerPacket: presentedSplit.baseLayerData ?
                packet.clone({ data: presentedSplit.baseLayerData }) :
                null,
            enhancementLayerPacket: presentedSplit.enhancementLayerData ?
                packet.clone({ data: presentedSplit.enhancementLayerData }) :
                null,
            hasBaseLayerVCL: presentedSplit.hasBaseLayerVCL,
            hasEnhancementLayerVCL: presentedSplit.hasEnhancementLayerVCL
        };
    }

    /**
     * Associates an ordinary HEVC BL packet with one separate-track EL packet. The EL picture is discarded when
     * the frame's only RPU is single-layer.
     */
    public async processSeparatePackets(
        baseLayerPacket: EncodedPacket,
        enhancementLayerPacket: EncodedPacket,
        enhancementInputFormat: HEVCNALFormat
    ): Promise<ProcessedDolbyVisionHEVCPacket> {
        const baseTimestampMicroseconds = requireMicroseconds(
            baseLayerPacket.microsecondTimestamp,
            'Encoded HEVC base-layer packet timestamp'
        );
        const enhancementTimestampMicroseconds = requireMicroseconds(
            enhancementLayerPacket.microsecondTimestamp,
            'Encoded HEVC enhancement-layer packet timestamp'
        );
        if (Math.abs(enhancementTimestampMicroseconds - baseTimestampMicroseconds)
            > DOLBY_VISION_PACKET_PAIR_TOLERANCE_MICROSECONDS) {
            throw new TypeError('Separate Dolby Vision packets have mismatched timestamps');
        }

        const baseSplit = splitDolbyVisionHEVCAccessUnit(
            baseLayerPacket.data,
            this.inputFormat,
            this.inputFormat
        );
        const enhancementSplit = splitDolbyVisionHEVCAccessUnit(
            enhancementLayerPacket.data,
            enhancementInputFormat,
            enhancementInputFormat
        );
        if (
            !baseSplit.hasBaseLayerVCL
            || !enhancementSplit.hasBaseLayerVCL
            || baseSplit.hasEnhancementLayerVCL
            || enhancementSplit.hasEnhancementLayerVCL
        ) {
            throw new TypeError('Separate Dolby Vision packets do not contain one BL and one EL picture');
        }

        const rpuNALUnits = [
            ...baseSplit.rpuNALUnits,
            ...enhancementSplit.rpuNALUnits
        ];
        const parsedRPUData = await this.parseRPUData(rpuNALUnits);
        const enhancementLayerData = hasOnlySingleLayerRPU(parsedRPUData) ?
            null :
            enhancementSplit.baseLayerData;
        const hasEnhancementLayerVCL = enhancementLayerData !== null;
        const metadataByteLength = this.retainDolbyVisionMetadata ?
            getMetadataByteLength(rpuNALUnits, parsedRPUData) :
            0;
        const enhancementLayerDisposition = this.retainDolbyVisionMetadata ?
            getEnhancementLayerDisposition(enhancementLayerData, parsedRPUData) :
            'absent';
        const processedPacket: ProcessedDolbyVisionHEVCPacket = {
            baseLayerPacket: baseSplit.baseLayerData ?
                baseLayerPacket.clone({ data: baseSplit.baseLayerData }) :
                null,
            enhancementLayerPacket: enhancementLayerData ?
                enhancementLayerPacket.clone({ data: enhancementLayerData }) :
                null,
            hasBaseLayerVCL: true,
            hasEnhancementLayerVCL
        };
        this.frameMetadataWindow.enqueue(baseTimestampMicroseconds, {
            byteLength: metadataByteLength,
            metadata: this.retainDolbyVisionMetadata ? {
                encodedRPUs: rpuNALUnits,
                enhancementLayerDisposition,
                hasEnhancementLayerVCL,
                parsedRPUData,
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            } : null
        });
        return processedPacket;
    }

    /** Takes the unique metadata entry associated with one decoded frame. */
    public takeFrameMetadata(
        timestampMicrosecondsValue: number
    ): DolbyVisionEncodedFrameMetadata | null {
        return this.frameMetadataWindow.take(timestampMicrosecondsValue);
    }

    /** Rejects decoder packet loss instead of attaching stale RPU data later. */
    public requireDrained(): void {
        this.frameMetadataWindow.requireDrained();
    }

    /** Discards all generation-owned encoded metadata. */
    public clear(): void {
        this.frameMetadataWindow.clear();
    }

    private async parseRPUData(rpuNALUnits: readonly Uint8Array[]): Promise<ArrayBuffer[]> {
        const parsedRPUData: ArrayBuffer[] = [];
        if (!this.retainDolbyVisionMetadata) {
            return parsedRPUData;
        }
        for (const rpuNALUnit of rpuNALUnits) {
            parsedRPUData.push(await this.rpuParser.parse(rpuNALUnit));
        }
        return parsedRPUData;
    }

    private createPendingFrameMetadata(
        splitResult: ReturnType<typeof splitDolbyVisionHEVCAccessUnit>,
        parsedRPUData: readonly ArrayBuffer[],
        hasDolbyVisionFrameData: boolean
    ): PendingFrameMetadata {
        if (!this.retainDolbyVisionMetadata) {
            return { byteLength: 0, metadata: null };
        }
        const enhancementLayerDisposition = splitResult.hasEnhancementLayerVCL ?
            getEnhancementLayerDisposition(
                splitResult.enhancementLayerData,
                parsedRPUData
            ) :
            'absent';
        return {
            byteLength: getMetadataByteLength(splitResult.rpuNALUnits, parsedRPUData),
            metadata: hasDolbyVisionFrameData ? {
                encodedRPUs: splitResult.rpuNALUnits,
                enhancementLayerDisposition,
                hasEnhancementLayerVCL: splitResult.hasEnhancementLayerVCL,
                parsedRPUData,
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            } : null
        };
    }
}

/**
 * Owns AV1 Dolby Vision metadata until the decoder emits the frame of its temporal unit.
 * Each unit has exactly one shown frame, whose timestamp is the unit's, so the unit's timestamp keys its entry.
 */
export class DolbyVisionAV1EncodedMetadataQueue {
    private readonly frameMetadataWindow = new DolbyVisionFrameMetadataWindow('AV1');

    public constructor(private readonly rpuParser: DolbyVisionAV1RPUDataParser) {}

    /**
     * Removes the Dolby Vision metadata OBUs of one temporal unit and parses its RPU in decode order.
     * It records the entry the unit's frame takes.
     * Profile 10 is single-layer: there is never an EL, and a unit carries at most one RPU, beside its frame.
     */
    public async processTemporalUnit(packet: EncodedPacket): Promise<ProcessedDolbyVisionAV1TemporalUnit> {
        const timestampMicroseconds = requireMicroseconds(
            packet.microsecondTimestamp,
            'Encoded AV1 packet timestamp'
        );
        const splitResult = splitDolbyVisionAV1TemporalUnit(packet.data);
        if (splitResult.rpuPayloads.length > MAXIMUM_DOLBY_VISION_AV1_TEMPORAL_UNIT_RPU_COUNT) {
            throw new TypeError('An AV1 temporal unit carries more than one Dolby Vision RPU');
        }
        if (splitResult.rpuPayloads.length > 0 && !splitResult.hasFrame) {
            throw new TypeError('Dolby Vision metadata is not paired with an AV1 frame');
        }

        const parsedRPUData: ArrayBuffer[] = [];
        for (const rpuPayload of splitResult.rpuPayloads) {
            parsedRPUData.push(await this.rpuParser.parseAV1ITUTT35(rpuPayload));
        }
        if (splitResult.hasFrame) {
            this.frameMetadataWindow.enqueue(timestampMicroseconds, {
                byteLength: getMetadataByteLength(splitResult.rpuPayloads, parsedRPUData),
                metadata: parsedRPUData.length > 0 ? {
                    encodedRPUs: splitResult.rpuPayloads,
                    enhancementLayerDisposition: 'absent',
                    hasEnhancementLayerVCL: false,
                    parsedRPUData,
                    schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
                } : null
            });
        }

        return {
            decoderPacket: splitResult.decoderData === packet.data ?
                packet :
                packet.clone({ data: splitResult.decoderData }),
            hasFrame: splitResult.hasFrame
        };
    }

    /** Takes the unique metadata entry associated with one decoded frame. */
    public takeFrameMetadata(
        timestampMicrosecondsValue: number
    ): DolbyVisionEncodedFrameMetadata | null {
        return this.frameMetadataWindow.take(timestampMicrosecondsValue);
    }

    /** Rejects decoder frame loss instead of attaching stale RPU data later. */
    public requireDrained(): void {
        this.frameMetadataWindow.requireDrained();
    }

    /** Discards all generation-owned encoded metadata. */
    public clear(): void {
        this.frameMetadataWindow.clear();
    }
}
