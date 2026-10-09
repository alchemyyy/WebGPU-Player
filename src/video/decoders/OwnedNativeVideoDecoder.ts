import type { EncodedPacket } from 'mediabunny';

import type {
    OwnedVideoDecoderCallbacks,
    OwnedVideoDecoderPort
} from './OwnedVideoDecodeStream';

/** The part of a WebCodecs VideoDecoder the engine's own decoders use, so tests can stand in for it. */
export type NativeVideoDecoderPort = {
    close: () => void
    configure: (config: VideoDecoderConfig) => void
    decode: (chunk: EncodedVideoChunk) => void
    readonly decodeQueueSize: number
    flush: () => Promise<void>
    ondequeue: ((event: Event) => unknown) | null
    readonly state: CodecState
};

export type OwnedNativeVideoDecoderDependencies = {
    createDecoder: (init: VideoDecoderInit) => NativeVideoDecoderPort
    createEncodedVideoChunk: (packet: EncodedPacket) => EncodedVideoChunk
};

export const DEFAULT_NATIVE_VIDEO_DECODER_DEPENDENCIES: OwnedNativeVideoDecoderDependencies = {
    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
    createDecoder: (init: VideoDecoderInit): NativeVideoDecoderPort => new VideoDecoder(init),
    createEncodedVideoChunk: (packet: EncodedPacket): EncodedVideoChunk => (
        packet.toEncodedVideoChunk()
    )
};

/** Closes a codec unless WebCodecs already closed it after an error or reclamation. */
export function closeCodec(decoder: NativeVideoDecoderPort): void {
    decoder.ondequeue = null;
    // NOTE: close() throws InvalidStateError on a closed codec, which would hide the codec's own error
    if (decoder.state !== 'closed') {
        decoder.close();
    }
}

/**
 * Owns one native WebCodecs VideoDecoder for a codec whose packets decode unchanged, such as AV1.
 * It hands each decoded frame to its stream.
 */
export default class OwnedNativeVideoDecoder implements OwnedVideoDecoderPort {
    private closed = false;
    private codecError: unknown = null;
    private decoder: NativeVideoDecoderPort | null = null;

    public constructor(
        private readonly config: VideoDecoderConfig,
        private readonly callbacks: OwnedVideoDecoderCallbacks,
        private readonly dependencies: OwnedNativeVideoDecoderDependencies = DEFAULT_NATIVE_VIDEO_DECODER_DEPENDENCIES
    ) {}

    /** Creates and configures the native decoder. A second call, or a call after close(), throws. */
    public async init(): Promise<void> {
        if (this.closed) {
            throw new Error('The owned native video decoder is closed');
        }
        if (this.decoder) {
            throw new Error('The owned native video decoder is already initialized');
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
            decoder.configure(this.config);
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

    /** Queues one packet; a native decoder never drops a picture on its own. */
    public decode(packet: EncodedPacket): boolean {
        this.requireDecoder().decode(this.dependencies.createEncodedVideoChunk(packet));
        return true;
    }

    /** Waits until every queued packet has produced its frame. */
    public async flush(): Promise<void> {
        await this.requireDecoder().flush();
    }

    public getDecodeQueueSize(): number {
        return this.decoder?.decodeQueueSize ?? 0;
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

        try {
            // The stream owns the frame from here on, and closes it itself when it refuses it
            this.callbacks.onOutput({
                frame,
                geometry: {
                    codedHeight: frame.codedHeight,
                    codedWidth: frame.codedWidth,
                    displayHeight: frame.displayHeight,
                    displayWidth: frame.displayWidth
                },
                kind: 'native-frame'
            });
        } catch (error) {
            this.callbacks.onError(error);
        } finally {
            this.callbacks.onProgress();
        }
    }

    private requireDecoder(): NativeVideoDecoderPort {
        if (this.closed) {
            throw new Error('The owned native video decoder is closed');
        }
        // Surface the codec's own error, so reclamation (QuotaExceededError) stays recoverable
        if (this.codecError !== null) {
            throw this.codecError;
        }
        if (!this.decoder) {
            throw new Error('The owned native video decoder is not initialized');
        }
        return this.decoder;
    }
}
