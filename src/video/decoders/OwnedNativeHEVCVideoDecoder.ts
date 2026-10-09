import type { EncodedPacket } from 'mediabunny';

import {
    hasHEVCRASLPicture,
    rewriteHEVCAccessUnitColorDescriptionToBT709,
    sanitizeHEVCAccessUnitForChromium,
    type HEVCNALFormat
} from '../dolby-vision/DolbyVisionHEVCSplitter';
import { findHEVCPreferredTransferCharacteristics } from '../hevc/HEVCSEI';
import {
    neutralizeNativeHDRHEVCDecoderConfigWithValidation
} from '../hevc/NativeHDRHEVCColorNeutralizer';
import type { HEVCHDRTransfer } from '../hevc/HEVCSPSParser';
import {
    closeCodec,
    DEFAULT_NATIVE_VIDEO_DECODER_DEPENDENCIES,
    type NativeVideoDecoderPort,
    type OwnedNativeVideoDecoderDependencies
} from './OwnedNativeVideoDecoder';

export type OwnedNativeHEVCVideoDecoderCallbacks = {
    onError: (error: unknown) => void
    onFrame: (frame: VideoFrame) => unknown
    onProgress: () => void
};

export type OwnedNativeHEVCVideoDecoderDependencies = OwnedNativeVideoDecoderDependencies;

export type OwnedNativeHEVCVideoDecoderOptions = {
    nativeHDRTransfer?: HEVCHDRTransfer
    neutralizeHDRColorMetadata?: boolean
};

/**
 * Returns a key access unit's alternative transfer characteristics SEI value.
 * As in FFmpeg, SEI errors are not fatal: a malformed SEI counts as absent, so the SPS VUI alone must prove the route.
 */
function findKeyPacketPreferredTransferCharacteristics(accessUnit: Uint8Array, format: HEVCNALFormat): number | null {
    try {
        return findHEVCPreferredTransferCharacteristics(accessUnit, format);
    } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
            return null;
        }
        throw error;
    }
}

/** Owns one native HEVC VideoDecoder and its packet-to-frame lifecycle. */
export default class OwnedNativeHEVCVideoDecoder {
    private closed = false;
    private codecError: unknown = null;
    private currentPacketIndex = 0;
    private decoder: NativeVideoDecoderPort | null = null;
    private nativeHDRColorDescriptionValidated = false;
    private raslSkipped = false;

    public constructor(
        private readonly config: VideoDecoderConfig,
        private readonly inputFormat: HEVCNALFormat,
        private readonly callbacks: OwnedNativeHEVCVideoDecoderCallbacks,
        private readonly dependencies: OwnedNativeHEVCVideoDecoderDependencies = DEFAULT_NATIVE_VIDEO_DECODER_DEPENDENCIES,
        private readonly options: OwnedNativeHEVCVideoDecoderOptions = {}
    ) {}

    /** Creates and configures the native decoder. A second call, or a call after close(), throws. */
    public async init(): Promise<void> {
        if (this.closed) {
            throw new Error('The owned native HEVC decoder is closed');
        }
        if (this.decoder) {
            throw new Error('The owned native HEVC decoder is already initialized');
        }

        const decoder = this.dependencies.createDecoder({
            error: (error: DOMException): void => {
                // WebCodecs has already closed the codec when it reports an error
                this.codecError ??= error;
                this.callbacks.onError(error);
            },
            output: (frame: VideoFrame): void => this.handleOutput(frame)
        });
        decoder.ondequeue = (): void => this.callbacks.onProgress();
        try {
            const neutralizeHDRColorMetadata = this.options.neutralizeHDRColorMetadata === true;
            if (neutralizeHDRColorMetadata) {
                const neutralizedConfiguration = neutralizeNativeHDRHEVCDecoderConfigWithValidation(
                    this.config,
                    this.requireNativeHDRTransfer()
                );
                decoder.configure(neutralizedConfiguration.configuration);
                this.nativeHDRColorDescriptionValidated = neutralizedConfiguration.decoderDescriptionValidated;
            } else {
                decoder.configure(this.config);
                this.nativeHDRColorDescriptionValidated = false;
            }
        } catch (error) {
            closeCodec(decoder);
            throw error;
        }
        if (this.closed) {
            closeCodec(decoder);
            return;
        }
        this.decoder = decoder;
    }

    /** Queues one cleaned base-layer packet, or drops a leading RASL picture and returns false. */
    public decode(packet: EncodedPacket): boolean {
        const decoder = this.requireDecoder();
        if (this.currentPacketIndex > 0 && !this.raslSkipped) {
            if (hasHEVCRASLPicture(packet.data, this.inputFormat)) {
                return false;
            }
            this.raslSkipped = true;
        }

        let decodedPacketData = packet.data;
        if (this.currentPacketIndex === 0) {
            const sanitizedData = sanitizeHEVCAccessUnitForChromium(decodedPacketData, this.inputFormat);
            if (sanitizedData?.byteLength === 0) {
                return false;
            }
            if (sanitizedData) {
                decodedPacketData = sanitizedData;
            }
        }

        decodedPacketData = this.neutralizeHDRPacketData(packet, decodedPacketData);

        const decodedPacket = decodedPacketData === packet.data ? packet : packet.clone({ data: decodedPacketData });

        decoder.decode(this.dependencies.createEncodedVideoChunk(decodedPacket));
        this.currentPacketIndex += 1;
        return true;
    }

    /** Flushes all native output and resets random-access packet state. */
    public async flush(): Promise<void> {
        await this.requireDecoder().flush();
        this.currentPacketIndex = 0;
        this.raslSkipped = false;
    }

    public getDecodeQueueSize(): number {
        return this.decoder?.decodeQueueSize ?? 0;
    }

    private requireNativeHDRTransfer(): HEVCHDRTransfer {
        const transfer = this.options.nativeHDRTransfer;
        if (transfer !== 'hlg' && transfer !== 'pq') {
            throw new TypeError('Native HDR color neutralization requires an exact HDR transfer');
        }
        return transfer;
    }

    private neutralizeHDRPacketData(packet: EncodedPacket, packetData: Uint8Array): Uint8Array {
        if (this.options.neutralizeHDRColorMetadata !== true) {
            return packetData;
        }
        if (packet.type === 'key') {
            // The SEI that names an HLG-compatible stream's transfer travels in the access unit of its SPS
            const neutralizedData = rewriteHEVCAccessUnitColorDescriptionToBT709(
                packetData,
                this.inputFormat,
                this.requireNativeHDRTransfer(),
                findKeyPacketPreferredTransferCharacteristics(packetData, this.inputFormat)
            );
            if (neutralizedData) {
                this.nativeHDRColorDescriptionValidated = true;
                return neutralizedData;
            }
        }
        if (!this.nativeHDRColorDescriptionValidated) {
            throw new TypeError('Native HDR color neutralization requires a validated HEVC SPS');
        }
        return packetData;
    }

    /** Closes the decoder and any frame it outputs afterwards. Later calls do nothing. */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const decoder = this.decoder;
        this.decoder = null;
        if (!decoder) {
            return;
        }
        closeCodec(decoder);
    }

    private handleOutput(frame: VideoFrame): void {
        if (this.closed) {
            frame.close();
            return;
        }

        let ownedFrame: VideoFrame | null = frame;
        try {
            this.callbacks.onFrame(ownedFrame);
            ownedFrame = null;
        } catch (error) {
            ownedFrame?.close();
            this.callbacks.onError(error);
        } finally {
            this.callbacks.onProgress();
        }
    }

    private requireDecoder(): NativeVideoDecoderPort {
        if (this.closed) {
            throw new Error('The owned native HEVC decoder is closed');
        }
        // Surface the codec's own error, so reclamation (QuotaExceededError) stays recoverable
        if (this.codecError !== null) {
            throw this.codecError;
        }
        if (!this.decoder) {
            throw new Error('The owned native HEVC decoder is not initialized');
        }
        return this.decoder;
    }
}
