// @vitest-environment node

import {
    CODEC_VECTOR_ASSETS_DIRECTORY,
    QUALIFICATION_VECTORS_DIRECTORY,
    WASM_OUTPUT_DIRECTORY
} from '../../helpers/enginePaths';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacketSink,
    Input,
    type VideoSample
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import MPEG2VC1SoftwareVideoDecoder, {
    type MPEG2VC1SoftwareVideoDecoderDependencies,
    type MPEG2VC1DecoderModule
} from 'webgpu-player/video/decoders/MPEG2VC1SoftwareVideoDecoder';
import { getMatroskaVC1DecoderDescription } from 'webgpu-player/video/MatroskaVFWVideoConfiguration';
import {
    MPEG2_VC1_QUALIFICATION_CODED_HEIGHT,
    MPEG2_VC1_QUALIFICATION_CODED_WIDTH,
    MPEG2_VC1_QUALIFICATION_FRAME_COUNT,
    MPEG2_VC1_QUALIFICATION_TOTAL_BYTE_LENGTH,
    MPEG2_VIDEO_QUALIFICATION_FINGERPRINT
} from 'webgpu-player/capability/exact/MPEG2VC1ExactCapabilityProtocol';

const DECODER_DIRECTORY = resolve(WASM_OUTPUT_DIRECTORY, 'ffmpeg-mpeg2-vc1');
const DECODER_GLUE_PATH = resolve(DECODER_DIRECTORY, 'ffmpeg-mpeg2-vc1.js');
const DECODER_WASM_PATH = resolve(DECODER_DIRECTORY, 'ffmpeg-mpeg2-vc1.wasm');
const VECTOR_PATH = resolve(
    CODEC_VECTOR_ASSETS_DIRECTORY,
    'mpeg2', 'mpeg2-progressive-1920x1080.mkv'
);
const VC1_VECTOR_PATH = resolve(
    QUALIFICATION_VECTORS_DIRECTORY,
    'vc1', 'vc1-advanced-progressive-1920x1080.mkv'
);
const VC1_QUALIFICATION_FINGERPRINT = 182_587_665;
const FNV_OFFSET_BASIS = 2_166_136_261;
const FNV_PRIME = 16_777_619;

type ActualMPEG2VC1DecoderModuleFactory = (options: {
    wasmBinary: Uint8Array
}) => Promise<MPEG2VC1DecoderModule>;

async function fingerprintSamples(samples: readonly VideoSample[]): Promise<{
    byteLength: number
    fingerprint: number
}> {
    let byteLength = 0;
    let fingerprint = FNV_OFFSET_BASIS;
    for (const sample of samples) {
        const output = new Uint8Array(sample.allocationSize());
        await sample.copyTo(output);
        byteLength += output.byteLength;
        for (const byte of output) {
            fingerprint ^= byte;
            fingerprint = Math.imul(fingerprint, FNV_PRIME) >>> 0;
        }
    }
    return { byteLength, fingerprint };
}

describe('MPEG-2/VC-1 decoder integration', () => {
    it('demuxes and exactly decodes reordered progressive MPEG-2 through WASM', async () => {
        const requireFunction = createRequire(import.meta.url);
        const createModule = requireFunction(
            DECODER_GLUE_PATH
        ) as ActualMPEG2VC1DecoderModuleFactory;
        const wasmBinary = new Uint8Array(readFileSync(DECODER_WASM_PATH));
        const dependencies: MPEG2VC1SoftwareVideoDecoderDependencies = {
            createModule: async (): Promise<MPEG2VC1DecoderModule> => (
                createModule({ wasmBinary })
            ),
            loadDecoderGlue: (): void => undefined,
            resolveAssetURL: (path: string): string => path
        };
        const input = new Input({
            formats: ALL_FORMATS,
            source: new BufferSource(new Uint8Array(readFileSync(VECTOR_PATH)))
        });
        const samples: VideoSample[] = [];
        const decoder = new MPEG2VC1SoftwareVideoDecoder({
            codec: 'mpeg2video',
            codedHeight: MPEG2_VC1_QUALIFICATION_CODED_HEIGHT,
            codedWidth: MPEG2_VC1_QUALIFICATION_CODED_WIDTH,
            displayHeight: MPEG2_VC1_QUALIFICATION_CODED_HEIGHT,
            displayWidth: MPEG2_VC1_QUALIFICATION_CODED_WIDTH
        }, {
            onError: (error: unknown): never => {
                throw error;
            },
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            }
        }, dependencies);

        try {
            const tracks = await input.getVideoTracks();
            expect(tracks).toHaveLength(1);
            expect(await tracks[0].getCodec()).toBeNull();
            expect(await tracks[0].getInternalCodecId()).toBe('V_MPEG2');
            await decoder.init();
            const packetSink = new EncodedPacketSink(tracks[0]);
            const firstKeyPacket = await packetSink.getFirstKeyPacket({
                verifyKeyPackets: true
            });
            const seekKeyPacket = await packetSink.getKeyPacket(0.25, {
                verifyKeyPackets: true
            });
            expect(firstKeyPacket?.type).toBe('key');
            expect(seekKeyPacket?.type).toBe('key');
            expect(seekKeyPacket?.timestamp).toBeLessThanOrEqual(0.25);
            for await (const packet of packetSink.packets()) {
                decoder.decode(packet);
            }
            decoder.flush();

            expect(samples).toHaveLength(MPEG2_VC1_QUALIFICATION_FRAME_COUNT);
            expect(samples.every((sample: VideoSample): boolean => (
                sample.format === 'I420'
                    && sample.codedWidth === MPEG2_VC1_QUALIFICATION_CODED_WIDTH
                    && sample.codedHeight === MPEG2_VC1_QUALIFICATION_CODED_HEIGHT
            ))).toBe(true);
            const output = await fingerprintSamples(samples);
            expect(output.byteLength).toBe(MPEG2_VC1_QUALIFICATION_TOTAL_BYTE_LENGTH);
            expect(output.fingerprint).toBe(MPEG2_VIDEO_QUALIFICATION_FINGERPRINT);
        } finally {
            for (const sample of samples) {
                sample.close();
            }
            decoder.close();
            input.dispose();
        }
    });

    it('demuxes and exactly decodes progressive Advanced VC-1 through WASM', async () => {
        const requireFunction = createRequire(import.meta.url);
        const createModule = requireFunction(
            DECODER_GLUE_PATH
        ) as ActualMPEG2VC1DecoderModuleFactory;
        const wasmBinary = new Uint8Array(readFileSync(DECODER_WASM_PATH));
        const dependencies: MPEG2VC1SoftwareVideoDecoderDependencies = {
            createModule: async (): Promise<MPEG2VC1DecoderModule> => (
                createModule({ wasmBinary })
            ),
            loadDecoderGlue: (): void => undefined,
            resolveAssetURL: (path: string): string => path
        };
        const input = new Input({
            formats: ALL_FORMATS,
            source: new BufferSource(new Uint8Array(readFileSync(VC1_VECTOR_PATH)))
        });
        const samples: VideoSample[] = [];
        let decoder: MPEG2VC1SoftwareVideoDecoder | null = null;

        try {
            const tracks = await input.getVideoTracks();
            expect(tracks).toHaveLength(1);
            const track = tracks[0];
            expect(await track.getCodec()).toBeNull();
            expect(await track.getInternalCodecId()).toBe('V_MS/VFW/FOURCC');
            const codedHeight = await track.getCodedHeight();
            const codedWidth = await track.getCodedWidth();
            const description = getMatroskaVC1DecoderDescription(
                track,
                codedWidth,
                codedHeight
            );
            expect(description).not.toBeNull();
            decoder = new MPEG2VC1SoftwareVideoDecoder({
                codec: 'vc1',
                codedHeight,
                codedWidth,
                description: description ?? undefined,
                displayHeight: codedHeight,
                displayWidth: codedWidth
            }, {
                onError: (error: unknown): never => {
                    throw error;
                },
                onSample: (sample: VideoSample): void => {
                    samples.push(sample);
                }
            }, dependencies);
            await decoder.init();
            const packetSink = new EncodedPacketSink(track);
            const firstKeyPacket = await packetSink.getFirstKeyPacket({
                verifyKeyPackets: true
            });
            const seekKeyPacket = await packetSink.getKeyPacket(0.25, {
                verifyKeyPackets: true
            });
            expect(firstKeyPacket?.type).toBe('key');
            expect(seekKeyPacket?.type).toBe('key');
            expect(seekKeyPacket?.timestamp).toBeLessThanOrEqual(0.25);
            for await (const packet of packetSink.packets()) {
                decoder.decode(packet);
            }
            decoder.flush();

            expect(samples).toHaveLength(MPEG2_VC1_QUALIFICATION_FRAME_COUNT);
            expect(samples.every((sample: VideoSample): boolean => (
                sample.format === 'I420'
                    && sample.codedWidth === MPEG2_VC1_QUALIFICATION_CODED_WIDTH
                    && sample.codedHeight === MPEG2_VC1_QUALIFICATION_CODED_HEIGHT
            ))).toBe(true);
            const output = await fingerprintSamples(samples);
            expect(output.byteLength).toBe(MPEG2_VC1_QUALIFICATION_TOTAL_BYTE_LENGTH);
            expect(output.fingerprint).toBe(VC1_QUALIFICATION_FINGERPRINT);
        } finally {
            for (const sample of samples) {
                sample.close();
            }
            decoder?.close();
            input.dispose();
        }
    });
});
