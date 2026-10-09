import { EncodedPacket } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import type { Microseconds } from 'webgpu-player/MediaTime';
import type { RawVideoFrameGeometry } from 'webgpu-player/video/RawVideoFrameCopy';
import {
    OwnedVideoStreamState,
    type OwnedDecodedVideoOutput,
    type OwnedDecodedVideoSource,
    type OwnedVideoDecoderPort,
    type OwnedVideoFrameMetadataSource,
    type OwnedVideoStreamRun
} from 'webgpu-player/video/decoders/OwnedVideoDecodeStream';

const FRAME_DURATION_MICROSECONDS = 31_250;
const FRAME_GEOMETRY: RawVideoFrameGeometry = {
    codedHeight: 1_080,
    codedWidth: 1_920,
    displayHeight: 1_080,
    displayWidth: 1_920
};
// EL dimensions that differ from the stream's first EL
const MISMATCHED_ENHANCEMENT_CODED_WIDTH = 960;
const MISMATCHED_ENHANCEMENT_DISPLAY_HEIGHT = 540;

class FakeVideoFrame {
    public readonly close = vi.fn();
    public readonly duration = FRAME_DURATION_MICROSECONDS;

    public constructor(
        public readonly timestamp: number,
        // The DOM VideoPixelFormat type has no high-bit-depth formats
        public readonly format: string | null
    ) {}
}

type StateHarness = {
    frameMetadata: OwnedVideoFrameMetadataSource & {
        requireDrained: ReturnType<typeof vi.fn>
        takeFrameMetadata: ReturnType<typeof vi.fn>
    }
    postedPairs: Array<[OwnedDecodedVideoOutput, OwnedDecodedVideoOutput | null]>
    state: OwnedVideoStreamState
};

function createHarness(hasEnhancementLayer: boolean): StateHarness {
    const postedPairs: Array<[OwnedDecodedVideoOutput, OwnedDecodedVideoOutput | null]> = [];
    const stream: OwnedVideoStreamRun = {
        isStopped: (): boolean => false,
        notifyDecoderProgress: vi.fn(),
        postFrame: async (
            output: OwnedDecodedVideoOutput,
            enhancementOutput: OwnedDecodedVideoOutput | null
        ): Promise<void> => {
            postedPairs.push([ output, enhancementOutput ]);
        },
        postStartupProgress: vi.fn(),
        waitForDecoderProgress: async (): Promise<void> => undefined,
        waitForFrameCredit: async (): Promise<boolean> => true
    };
    const frameMetadata = {
        clear: vi.fn(),
        requireDrained: vi.fn(),
        takeFrameMetadata: vi.fn((): { encodedDolbyVisionMetadata: null } => ({
            encodedDolbyVisionMetadata: null
        }))
    };
    return {
        frameMetadata,
        postedPairs,
        state: new OwnedVideoStreamState(
            stream,
            frameMetadata,
            0 as Microseconds,
            hasEnhancementLayer ? FRAME_GEOMETRY : null
        )
    };
}

function createFrameSource(
    timestampMicroseconds: number,
    format: string | null = 'I420P10',
    geometry: RawVideoFrameGeometry = FRAME_GEOMETRY
): OwnedDecodedVideoSource {
    return {
        frame: new FakeVideoFrame(timestampMicroseconds, format) as unknown as VideoFrame,
        geometry,
        kind: 'native-frame'
    };
}

function getFrame(output: OwnedDecodedVideoOutput | OwnedDecodedVideoSource | null): FakeVideoFrame | null {
    const source = output && 'source' in output ? output.source : output;
    return source?.kind === 'native-frame' ? source.frame as unknown as FakeVideoFrame : null;
}

function createDecoder(packetAccepted: boolean): OwnedVideoDecoderPort & { decode: ReturnType<typeof vi.fn> } {
    return {
        close: vi.fn(),
        decode: vi.fn((): boolean => packetAccepted),
        flush: vi.fn(async (): Promise<void> => undefined),
        getDecodeQueueSize: (): number => 0,
        init: vi.fn(async (): Promise<void> => undefined)
    };
}

function createPacket(timestampMicroseconds: number): EncodedPacket {
    return new EncodedPacket(new Uint8Array([ 1 ]), 'key', timestampMicroseconds / 1_000_000, 0);
}

describe('OwnedVideoStreamState', () => {
    it('gives back the metadata of a frame its decoder drops', () => {
        const harness = createHarness(false);
        const packet = createPacket(FRAME_DURATION_MICROSECONDS);

        harness.state.decodeBasePacket(packet, packet, true, createDecoder(true));
        harness.state.decodeBasePacket(packet, packet, false, createDecoder(false));
        expect(harness.frameMetadata.takeFrameMetadata).not.toHaveBeenCalled();
        harness.state.decodeBasePacket(packet, packet, true, createDecoder(false));
        expect(harness.frameMetadata.takeFrameMetadata).toHaveBeenCalledExactlyOnceWith(
            FRAME_DURATION_MICROSECONDS
        );

        const decoder = createDecoder(true);
        harness.state.decodeBasePacket(packet, null, true, decoder);
        expect(decoder.decode).not.toHaveBeenCalled();
    });

    it('posts each BL frame with the EL frame of its timestamp', async () => {
        const harness = createHarness(true);
        const baseSource = createFrameSource(0);
        const enhancementSource = createFrameSource(0);

        harness.state.enqueueEnhancementDecodedOutput(enhancementSource);
        harness.state.enqueueDecodedOutput(baseSource);

        expect(await harness.state.postNextOutput()).toBe('posted');
        expect(harness.postedPairs).toHaveLength(1);
        expect(getFrame(harness.postedPairs[0][0])).toBe(getFrame(baseSource));
        expect(getFrame(harness.postedPairs[0][1])).toBe(getFrame(enhancementSource));
        expect(harness.frameMetadata.takeFrameMetadata).toHaveBeenCalledExactlyOnceWith(0);
    });

    it('releases a BL frame waiting for its EL when the track ends', async () => {
        const harness = createHarness(true);
        const baseSource = createFrameSource(0);
        harness.state.enqueueDecodedOutput(baseSource);

        expect(await harness.state.postNextOutput()).toBe('none');
        await harness.state.finishPackets(createDecoder(true), createDecoder(true));
        expect(await harness.state.postNextOutput()).toBe('posted');

        expect(harness.postedPairs[0][1]).toBeNull();
        expect(harness.frameMetadata.requireDrained).toHaveBeenCalledOnce();
        expect(harness.state.packetsEnded).toBe(true);
    });

    it('leaves the stream to its BL once the EL decoder refuses a picture', async () => {
        const harness = createHarness(true);
        const enhancementPacket = createPacket(0);

        harness.state.decodeEnhancementPacket(enhancementPacket, true, createDecoder(false));
        expect(harness.state.canDecodeEnhancement()).toBe(false);
        harness.state.enqueueDecodedOutput(createFrameSource(0));
        const lateEnhancementSource = createFrameSource(0);
        harness.state.enqueueEnhancementDecodedOutput(lateEnhancementSource);

        expect(await harness.state.postNextOutput()).toBe('posted');
        expect(harness.postedPairs[0][1]).toBeNull();
        expect(getFrame(lateEnhancementSource)?.close).toHaveBeenCalledOnce();
    });

    it.each([
        { format: 'I420', geometry: FRAME_GEOMETRY, label: 'an 8-bit format' },
        {
            format: null,
            geometry: { ...FRAME_GEOMETRY, codedWidth: MISMATCHED_ENHANCEMENT_CODED_WIDTH },
            label: 'another coded width'
        },
        {
            format: 'I420P10',
            geometry: { ...FRAME_GEOMETRY, displayHeight: MISMATCHED_ENHANCEMENT_DISPLAY_HEIGHT },
            label: 'another display height'
        }
    ] as const)('leaves the stream to its BL once an EL arrives in $label', async ({ format, geometry }) => {
        const harness = createHarness(true);
        const enhancementSource = createFrameSource(0, format, geometry);

        harness.state.enqueueEnhancementDecodedOutput(enhancementSource);
        harness.state.enqueueDecodedOutput(createFrameSource(0));

        // The compound copy would refuse such an EL, so it is closed here and every later frame posts without one
        expect(getFrame(enhancementSource)?.close).toHaveBeenCalledOnce();
        expect(harness.state.canDecodeEnhancement()).toBe(false);
        expect(await harness.state.postNextOutput()).toBe('posted');
        expect(harness.postedPairs[0][1]).toBeNull();
    });

    it('pairs an EL whose decoder reports no format', async () => {
        const harness = createHarness(true);
        const enhancementSource = createFrameSource(0, null);

        harness.state.enqueueEnhancementDecodedOutput(enhancementSource);
        harness.state.enqueueDecodedOutput(createFrameSource(0));

        // An opaque format leaves the requested copy format to decide, as it does for the BL
        expect(await harness.state.postNextOutput()).toBe('posted');
        expect(getFrame(harness.postedPairs[0][1])).toBe(getFrame(enhancementSource));
    });

    it('surfaces a recorded decoder failure before posting another frame', async () => {
        const harness = createHarness(false);
        const decoderFailure = new Error('decoder failed');
        harness.state.enqueueDecodedOutput(createFrameSource(0));

        harness.state.recordDecoderFailure(decoderFailure);
        harness.state.recordDecoderFailure(new Error('later failure'));

        await expect(harness.state.postNextOutput()).rejects.toBe(decoderFailure);
        expect(harness.postedPairs).toHaveLength(0);
        harness.state.close();
        expect(harness.frameMetadata.clear).toHaveBeenCalledOnce();
    });
});
