// Builds a Matroska file at test time from the committed VP9 HDR10+ vector's video packets and a synthetic stereo PCM tone

import {
    ALL_FORMATS,
    BufferSource,
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacket,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    MkvOutputFormat,
    Output
} from 'mediabunny';

import { readVP9HDR10PlusVector, VP9_HDR10_PLUS_EXPECTATIONS } from './vp9HDR10PlusVectors';

export const DECODED_AUDIO_MEDIA_FILE_NAME = 'decoded-audio.mkv';
// PCM is the one audio codec Mediabunny decodes without WebCodecs, so Node runs the decoded audio path on it
export const DECODED_AUDIO_MEDIA_CODEC = 'pcm-s16';
export const DECODED_AUDIO_MEDIA_SAMPLE_RATE = 48_000;
export const DECODED_AUDIO_MEDIA_CHANNEL_COUNT = 2;
// The tone outlasts the video, so audio ends last
export const DECODED_AUDIO_MEDIA_DURATION_SECONDS = 1;
// 20 ms packets
export const DECODED_AUDIO_MEDIA_PACKET_FRAME_COUNT = 960;
export const DECODED_AUDIO_MEDIA_FRAME_COUNT = DECODED_AUDIO_MEDIA_SAMPLE_RATE * DECODED_AUDIO_MEDIA_DURATION_SECONDS;
const DECODED_AUDIO_MEDIA_PACKET_COUNT = DECODED_AUDIO_MEDIA_FRAME_COUNT / DECODED_AUDIO_MEDIA_PACKET_FRAME_COUNT;
const [ VIDEO_VECTOR ] = VP9_HDR10_PLUS_EXPECTATIONS.vectors;
const INT16_FULL_SCALE = 32_768;
const INT16_MAXIMUM = 32_767;
const BYTES_PER_SAMPLE = Int16Array.BYTES_PER_ELEMENT;
const TONE_FREQUENCY_HERTZ = 750;
const TONE_AMPLITUDE = 0.25;
// Each channel starts the tone a quarter turn later, so a swapped channel shows
const TONE_CHANNEL_PHASE_RADIANS = Math.PI / 2;

function getToneSampleValue(frameIndex: number, channelIndex: number): number {
    const radians = ((2 * Math.PI * TONE_FREQUENCY_HERTZ * frameIndex) / DECODED_AUDIO_MEDIA_SAMPLE_RATE)
        + (channelIndex * TONE_CHANNEL_PHASE_RADIANS);
    const sampleValue = Math.round(Math.sin(radians) * TONE_AMPLITUDE * INT16_MAXIMUM);
    // A 16-bit sample has no negative zero
    return sampleValue === 0 ? 0 : sampleValue;
}

/** Returns the decoded sample of the tone at a frame, as the PCM decoder scales its 16-bit value. */
export function getDecodedAudioMediaSample(frameIndex: number, channelIndex: number): number {
    return Math.fround(getToneSampleValue(frameIndex, channelIndex) / INT16_FULL_SCALE);
}

function createTonePacketData(firstFrameIndex: number): Uint8Array {
    const data = new Uint8Array(DECODED_AUDIO_MEDIA_PACKET_FRAME_COUNT * DECODED_AUDIO_MEDIA_CHANNEL_COUNT * BYTES_PER_SAMPLE);
    const view = new DataView(data.buffer);
    for (let frameIndex = 0; frameIndex < DECODED_AUDIO_MEDIA_PACKET_FRAME_COUNT; frameIndex += 1) {
        for (let channelIndex = 0; channelIndex < DECODED_AUDIO_MEDIA_CHANNEL_COUNT; channelIndex += 1) {
            const byteOffset = ((frameIndex * DECODED_AUDIO_MEDIA_CHANNEL_COUNT) + channelIndex) * BYTES_PER_SAMPLE;
            view.setInt16(byteOffset, getToneSampleValue(firstFrameIndex + frameIndex, channelIndex), true);
        }
    }
    return data;
}

/** Muxes the VP9 vector's video and the stereo tone into one Matroska file. */
export async function createDecodedAudioMedia(): Promise<Uint8Array> {
    const videoInput = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(readVP9HDR10PlusVector(VIDEO_VECTOR.fileName))
    });
    const videoTrack = await videoInput.getPrimaryVideoTrack();
    const videoDecoderConfig = await videoTrack?.getDecoderConfig();
    if (!videoTrack || !videoDecoderConfig || await videoTrack.getCodec() !== 'vp9') {
        throw new Error('The VP9 vector has no decodable video track');
    }

    const target = new BufferTarget();
    const output = new Output({ format: new MkvOutputFormat(), target });
    const videoSource = new EncodedVideoPacketSource('vp9');
    const audioSource = new EncodedAudioPacketSource(DECODED_AUDIO_MEDIA_CODEC);
    output.addVideoTrack(videoSource);
    output.addAudioTrack(audioSource);
    await output.start();

    let firstVideoPacket = true;
    for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
        await videoSource.add(packet, firstVideoPacket ? { decoderConfig: videoDecoderConfig } : undefined);
        firstVideoPacket = false;
    }
    const packetDurationSeconds = DECODED_AUDIO_MEDIA_PACKET_FRAME_COUNT / DECODED_AUDIO_MEDIA_SAMPLE_RATE;
    for (let packetIndex = 0; packetIndex < DECODED_AUDIO_MEDIA_PACKET_COUNT; packetIndex += 1) {
        const firstFrameIndex = packetIndex * DECODED_AUDIO_MEDIA_PACKET_FRAME_COUNT;
        const packet = new EncodedPacket(
            createTonePacketData(firstFrameIndex),
            'key',
            firstFrameIndex / DECODED_AUDIO_MEDIA_SAMPLE_RATE,
            packetDurationSeconds
        );
        await audioSource.add(packet, packetIndex === 0 ? {
            decoderConfig: {
                codec: DECODED_AUDIO_MEDIA_CODEC,
                numberOfChannels: DECODED_AUDIO_MEDIA_CHANNEL_COUNT,
                sampleRate: DECODED_AUDIO_MEDIA_SAMPLE_RATE
            }
        } : undefined);
    }
    await output.finalize();
    if (!target.buffer) {
        throw new Error('The muxer wrote no file');
    }
    return new Uint8Array(target.buffer);
}
