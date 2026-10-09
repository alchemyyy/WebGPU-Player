import type { EncodedPacket } from 'mediabunny';

import type {
    OwnedDecodedVideoSource,
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

/** The one decoded source kind a native decoder outputs */
export type OwnedNativeFrameSource = Extract<OwnedDecodedVideoSource, { kind: 'native-frame' }>;

/** The stream callbacks of a native decoder, whose output is always a native frame */
export type OwnedNativeVideoDecoderCallbacks = {
    onError: (error: unknown) => void
    /** Owns the frame from the call on, even when it throws. */
    onOutput: (output: OwnedNativeFrameSource) => void
    onProgress: () => void
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
 * Owns one native WebCodecs VideoDecoder and hands each decoded frame to its stream.
 * Packets decode unchanged, as AV1 needs; OwnedNativeHEVCVideoDecoder rewrites HEVC packets before they reach this owner.
 */
export default class OwnedNativeVideoDecoder implements OwnedVideoDecoderPort {
    // Names the decoder in its lifecycle errors
    protected readonly decoderName: string = 'video decoder';
    private closed = false;
    private codecError: unknown = null;
    private decoder: NativeVideoDecoderPort | null = null;

    public constructor(
        protected readonly config: VideoDecoderConfig,
        private readonly callbacks: OwnedNativeVideoDecoderCallbacks,
        private readonly dependencies: OwnedNativeVideoDecoderDependencies = DEFAULT_NATIVE_VIDEO_DECODER_DEPENDENCIES
    ) {}

    /** Creates and configures the native decoder. A second call, or a call after close(), throws. */
    public async init(): Promise<void> {
        if (this.closed) {
            throw new Error(`The owned native ${this.decoderName} is closed`);
        }
        if (this.decoder) {
            throw new Error(`The owned native ${this.decoderName} is already initialized`);
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
            this.configureDecoder(decoder);
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

    /** Configures a new codec; a subclass may configure it differently. */
    protected configureDecoder(decoder: NativeVideoDecoderPort): void {
        decoder.configure(this.config);
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

    protected requireDecoder(): NativeVideoDecoderPort {
        if (this.closed) {
            throw new Error(`The owned native ${this.decoderName} is closed`);
        }
        // Surface the codec's own error, so reclamation (QuotaExceededError) stays recoverable
        if (this.codecError !== null) {
            throw this.codecError;
        }
        if (!this.decoder) {
            throw new Error(`The owned native ${this.decoderName} is not initialized`);
        }
        return this.decoder;
    }
}
