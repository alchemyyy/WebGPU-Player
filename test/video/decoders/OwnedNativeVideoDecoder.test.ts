import { EncodedPacket } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import OwnedNativeVideoDecoder, {
    type NativeVideoDecoderPort,
    type OwnedNativeVideoDecoderDependencies
} from 'webgpu-player/video/decoders/OwnedNativeVideoDecoder';
import type {
    OwnedDecodedVideoSource,
    OwnedVideoDecoderCallbacks
} from 'webgpu-player/video/decoders/OwnedVideoDecodeStream';

const AV1_CONFIG: VideoDecoderConfig = {
    codec: 'av01.0.08M.10',
    hardwareAcceleration: 'prefer-software',
    optimizeForLatency: true
};

class FakeVideoFrame {
    public readonly close = vi.fn();
    public readonly codedHeight = 2_160;
    public readonly codedWidth = 3_840;
    public readonly displayHeight = 2_160;
    public readonly displayWidth = 3_840;
}

// Mirrors Chromium: close() on a closed codec throws, and an error callback arrives after the codec closed itself
class FakeNativeVideoDecoder implements NativeVideoDecoderPort {
    public state: CodecState = 'unconfigured';
    public readonly close = vi.fn((): void => {
        if (this.state === 'closed') {
            throw new DOMException('Cannot call \'close\' on a closed codec.', 'InvalidStateError');
        }
        this.state = 'closed';
    });
    public readonly configure = vi.fn((): void => {
        this.state = 'configured';
    });
    public readonly decode = vi.fn();
    public decodeQueueSize = 0;
    public readonly flush = vi.fn(async (): Promise<void> => undefined);
    public ondequeue: ((event: Event) => unknown) | null = null;
}

type DecoderHarness = {
    callbacks: OwnedVideoDecoderCallbacks & {
        onError: ReturnType<typeof vi.fn>
        onOutput: ReturnType<typeof vi.fn>
        onProgress: ReturnType<typeof vi.fn>
    }
    decoder: OwnedNativeVideoDecoder
    dependencies: OwnedNativeVideoDecoderDependencies
    init: VideoDecoderInit | null
    nativeDecoder: FakeNativeVideoDecoder
    packets: EncodedPacket[]
};

function createHarness(): DecoderHarness {
    const harness = {
        callbacks: {
            onError: vi.fn(),
            onOutput: vi.fn(),
            onProgress: vi.fn()
        },
        init: null,
        nativeDecoder: new FakeNativeVideoDecoder(),
        packets: []
    } as unknown as DecoderHarness;
    harness.dependencies = {
        createDecoder: (init: VideoDecoderInit): NativeVideoDecoderPort => {
            harness.init = init;
            return harness.nativeDecoder;
        },
        createEncodedVideoChunk: (packet: EncodedPacket): EncodedVideoChunk => {
            harness.packets.push(packet);
            return { packet } as unknown as EncodedVideoChunk;
        }
    };
    harness.decoder = new OwnedNativeVideoDecoder(AV1_CONFIG, harness.callbacks, harness.dependencies);
    return harness;
}

function createPacket(sequenceNumber: number): EncodedPacket {
    return new EncodedPacket(new Uint8Array([ 0x32, 1, 0 ]), 'key', sequenceNumber / 24, 1 / 24, sequenceNumber);
}

describe('OwnedNativeVideoDecoder', () => {
    it('configures one decoder, passes packets unchanged, and reports dequeue progress', async () => {
        const harness = createHarness();

        await harness.decoder.init();
        const packet = createPacket(0);
        expect(harness.decoder.decode(packet)).toBe(true);
        harness.nativeDecoder.decodeQueueSize = 3;
        harness.nativeDecoder.ondequeue?.(new Event('dequeue'));
        await harness.decoder.flush();

        expect(harness.nativeDecoder.configure).toHaveBeenCalledExactlyOnceWith(AV1_CONFIG);
        expect(harness.packets).toEqual([ packet ]);
        expect(harness.packets[0]).toBe(packet);
        expect(harness.decoder.getDecodeQueueSize()).toBe(3);
        expect(harness.callbacks.onProgress).toHaveBeenCalledOnce();
        expect(harness.nativeDecoder.flush).toHaveBeenCalledOnce();
        await expect(harness.decoder.init()).rejects.toThrow('already initialized');
        harness.decoder.close();
        harness.decoder.close();
        expect(harness.nativeDecoder.close).toHaveBeenCalledOnce();
        await expect(harness.decoder.init()).rejects.toThrow('is closed');
    });

    it('hands each frame to its stream with its geometry and closes later outputs', async () => {
        const harness = createHarness();
        await harness.decoder.init();
        const frame = new FakeVideoFrame();

        harness.init?.output(frame as unknown as VideoFrame);
        harness.decoder.close();
        const lateFrame = new FakeVideoFrame();
        harness.init?.output(lateFrame as unknown as VideoFrame);

        expect(harness.callbacks.onOutput).toHaveBeenCalledOnce();
        const source = harness.callbacks.onOutput.mock.calls[0][0] as OwnedDecodedVideoSource;
        expect(source).toEqual({
            frame,
            geometry: {
                codedHeight: 2_160,
                codedWidth: 3_840,
                displayHeight: 2_160,
                displayWidth: 3_840
            },
            kind: 'native-frame'
        });
        expect(frame.close).not.toHaveBeenCalled();
        expect(harness.callbacks.onProgress).toHaveBeenCalledOnce();
        expect(lateFrame.close).toHaveBeenCalledOnce();
    });

    it('reports a refused frame without closing what its stream now owns', async () => {
        const harness = createHarness();
        const outputError = new Error('frame refused');
        harness.callbacks.onOutput.mockImplementation((): never => {
            throw outputError;
        });
        await harness.decoder.init();
        const frame = new FakeVideoFrame();

        harness.init?.output(frame as unknown as VideoFrame);

        expect(harness.callbacks.onError).toHaveBeenCalledExactlyOnceWith(outputError);
        expect(harness.callbacks.onProgress).toHaveBeenCalledOnce();
        expect(frame.close).not.toHaveBeenCalled();
        harness.decoder.close();
    });

    it.each([
        new DOMException('Decoding error.', 'EncodingError'),
        new DOMException('Codec reclaimed due to inactivity.', 'QuotaExceededError')
    ])('surfaces codec error $name and never closes a codec WebCodecs already closed', async codecError => {
        const harness = createHarness();
        await harness.decoder.init();
        harness.nativeDecoder.state = 'closed';

        harness.init?.error(codecError);

        expect(harness.callbacks.onError).toHaveBeenCalledExactlyOnceWith(codecError);
        let thrownError: unknown = null;
        try {
            harness.decoder.decode(createPacket(1));
        } catch (error) {
            thrownError = error;
        }
        // The worker recognizes reclamation by the error's name, so the codec's own error must surface
        expect(thrownError).toBe(codecError);
        await expect(harness.decoder.flush()).rejects.toBe(codecError);
        expect(harness.nativeDecoder.decode).not.toHaveBeenCalled();
        expect(() => harness.decoder.close()).not.toThrow();
        expect(harness.nativeDecoder.close).not.toHaveBeenCalled();
    });

    it('closes a decoder whose configuration fails', async () => {
        const harness = createHarness();
        const configurationError = new Error('configuration failed');
        harness.nativeDecoder.configure.mockImplementation((): never => {
            throw configurationError;
        });

        await expect(harness.decoder.init()).rejects.toBe(configurationError);
        expect(harness.nativeDecoder.ondequeue).toBeNull();
        expect(harness.nativeDecoder.close).toHaveBeenCalledOnce();
        expect(() => harness.decoder.decode(createPacket(0))).toThrow('not initialized');
    });
});
