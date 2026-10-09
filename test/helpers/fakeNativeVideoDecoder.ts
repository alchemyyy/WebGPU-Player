// A WebCodecs VideoDecoder stand-in shared by the owned native video decoder tests

import { vi } from 'vitest';

import type { NativeVideoDecoderPort } from 'webgpu-player/video/decoders/OwnedNativeVideoDecoder';

// Mirrors Chromium: close() on a closed codec throws, and an error callback arrives after the codec closed itself
export class FakeNativeVideoDecoder implements NativeVideoDecoderPort {
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
