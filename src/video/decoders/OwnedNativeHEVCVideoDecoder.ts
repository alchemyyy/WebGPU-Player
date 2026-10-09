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
import OwnedNativeVideoDecoder, {
    DEFAULT_NATIVE_VIDEO_DECODER_DEPENDENCIES,
    type NativeVideoDecoderPort,
    type OwnedNativeFrameSource,
    type OwnedNativeVideoDecoderCallbacks,
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

/** Hands each decoded frame to onFrame, and closes a frame that onFrame refuses. */
function createNativeFrameCallbacks(callbacks: OwnedNativeHEVCVideoDecoderCallbacks): OwnedNativeVideoDecoderCallbacks {
    return {
        onError: (error: unknown): void => callbacks.onError(error),
        onOutput: (output: OwnedNativeFrameSource): void => {
            try {
                callbacks.onFrame(output.frame);
            } catch (error) {
                output.frame.close();
                throw error;
            }
        },
        onProgress: (): void => callbacks.onProgress()
    };
}

/**
 * Owns one native HEVC VideoDecoder.
 * It drops leading RASL pictures, sanitizes the first access unit for Chromium, and neutralizes HDR color metadata when asked; the generic owner does the rest.
 */
export default class OwnedNativeHEVCVideoDecoder extends OwnedNativeVideoDecoder {
    protected override readonly decoderName: string = 'HEVC decoder';
    private currentPacketIndex = 0;
    private nativeHDRColorDescriptionValidated = false;
    private raslSkipped = false;

    public constructor(
        config: VideoDecoderConfig,
        private readonly inputFormat: HEVCNALFormat,
        callbacks: OwnedNativeHEVCVideoDecoderCallbacks,
        dependencies: OwnedNativeHEVCVideoDecoderDependencies = DEFAULT_NATIVE_VIDEO_DECODER_DEPENDENCIES,
        private readonly options: OwnedNativeHEVCVideoDecoderOptions = {}
    ) {
        super(config, createNativeFrameCallbacks(callbacks), dependencies);
    }

    /** Queues one cleaned base-layer packet, or drops a leading RASL picture and returns false. */
    public override decode(packet: EncodedPacket): boolean {
        // A closed or failed decoder throws before the packet state below changes
        this.requireDecoder();
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

        super.decode(decodedPacket);
        this.currentPacketIndex += 1;
        return true;
    }

    /** Flushes all native output and resets random-access packet state. */
    public override async flush(): Promise<void> {
        await super.flush();
        this.currentPacketIndex = 0;
        this.raslSkipped = false;
    }

    protected override configureDecoder(decoder: NativeVideoDecoderPort): void {
        if (this.options.neutralizeHDRColorMetadata !== true) {
            super.configureDecoder(decoder);
            this.nativeHDRColorDescriptionValidated = false;
            return;
        }
        const neutralizedConfiguration = neutralizeNativeHDRHEVCDecoderConfigWithValidation(
            this.config,
            this.requireNativeHDRTransfer()
        );
        decoder.configure(neutralizedConfiguration.configuration);
        this.nativeHDRColorDescriptionValidated = neutralizedConfiguration.decoderDescriptionValidated;
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
}
