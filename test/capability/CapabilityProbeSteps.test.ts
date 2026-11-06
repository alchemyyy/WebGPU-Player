import { describe, expect, it } from 'vitest';

import {
    CAPABILITY_PROBE_STEP_LABEL_MAXIMUM_LENGTH,
    describeAudioConfigCheck,
    describeAudioDecode,
    describeVideoConfigCheck,
    describeVideoDecode,
    getLargestCapabilityProbeStepCost,
    getMaximumReferenceFrames
} from 'webgpu-player/capability/CapabilityProbeSteps';

const HEVC_MAIN_10 = 'hvc1.2.4.L153.B0';
const HEVC_MAIN = 'hvc1.1.6.L153.B0';
const AVC_HIGH = 'avc1.640033';

function videoConfig(overrides: Partial<VideoDecoderConfig> = {}): VideoDecoderConfig {
    return { codec: AVC_HIGH, codedHeight: 1080, codedWidth: 1920, ...overrides };
}

function audioConfig(overrides: Partial<AudioDecoderConfig> = {}): AudioDecoderConfig {
    return { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48_000, ...overrides };
}

describe('video step labels', () => {
    it('match for equal calls', () => {
        expect(describeVideoDecode(videoConfig(), 'I420', 'I420P10').label).toBe(describeVideoDecode(videoConfig(), 'I420', 'I420P10').label);
        expect(describeVideoConfigCheck(videoConfig()).label).toBe(describeVideoConfigCheck(videoConfig()).label);
    });

    it('differ whenever the codec, size, acceleration hint, copy format, or kind differ', () => {
        const labels = [
            describeVideoDecode(videoConfig(), 'I420').label,
            describeVideoDecode(videoConfig({ codec: 'avc1.64002a' }), 'I420').label,
            describeVideoDecode(videoConfig({ codedWidth: 1280 }), 'I420').label,
            describeVideoDecode(videoConfig({ codedHeight: 720 }), 'I420').label,
            describeVideoDecode(videoConfig({ hardwareAcceleration: 'prefer-hardware' }), 'I420').label,
            describeVideoDecode(videoConfig({ hardwareAcceleration: 'prefer-software' }), 'I420').label,
            describeVideoDecode(videoConfig(), 'I420', 'I420P10').label,
            describeVideoDecode(videoConfig(), 'I420', 'I444').label,
            describeVideoConfigCheck(videoConfig()).label
        ];
        expect(new Set(labels).size).toBe(labels.length);
    });

    it('add nothing for no-preference', () => {
        expect(describeVideoDecode(videoConfig({ hardwareAcceleration: 'no-preference' }), 'I420').label)
            .toBe(describeVideoDecode(videoConfig(), 'I420').label);
        expect(describeVideoDecode(videoConfig({ hardwareAcceleration: 'no-preference' }), 'I420').hardwareAcceleration).toBe('no-preference');
    });

    it('are printable ASCII of bounded length, and refuse otherwise', () => {
        const label = describeVideoDecode(videoConfig({ codec: HEVC_MAIN_10, hardwareAcceleration: 'prefer-software' }), 'I420P10', 'I420P10').label;
        expect(label).toMatch(/^[\x20-\x7E]+$/u);
        expect(label.length).toBeLessThanOrEqual(CAPABILITY_PROBE_STEP_LABEL_MAXIMUM_LENGTH);
        expect(() => describeVideoConfigCheck(videoConfig({ codec: 'a'.repeat(CAPABILITY_PROBE_STEP_LABEL_MAXIMUM_LENGTH) }))).toThrow(RangeError);
        expect(() => describeVideoConfigCheck(videoConfig({ codec: 'avc1.\u00e9' }))).toThrow(RangeError);
        expect(() => describeAudioConfigCheck(audioConfig({ codec: 'opus\n' }))).toThrow(RangeError);
    });

    it('refuse a decode without a coded size', () => {
        expect(() => describeVideoDecode({ codec: AVC_HIGH }, 'I420')).toThrow(RangeError);
    });
});

describe('audio step labels', () => {
    it('match for equal calls and differ whenever the codec, channels, sample rate, or kind differ', () => {
        expect(describeAudioDecode(audioConfig(), 1024).label).toBe(describeAudioDecode(audioConfig(), 2048).label);
        const labels = [
            describeAudioDecode(audioConfig(), 1024).label,
            describeAudioDecode(audioConfig({ codec: 'opus' }), 1024).label,
            describeAudioDecode(audioConfig({ numberOfChannels: 6 }), 1024).label,
            describeAudioDecode(audioConfig({ sampleRate: 44_100 }), 1024).label,
            describeAudioConfigCheck(audioConfig()).label
        ];
        expect(new Set(labels).size).toBe(labels.length);
    });
});

describe('step costs', () => {
    it('charge a check one decoder and no bytes', () => {
        expect(describeVideoConfigCheck(videoConfig({ codedHeight: 2160, codedWidth: 3840 })).cost).toEqual({ bytes: 0, decoders: 1 });
        expect(describeAudioConfigCheck(audioConfig({ numberOfChannels: 8 })).cost).toEqual({ bytes: 0, decoders: 1 });
    });

    it('charge a decode one decoder', () => {
        expect(describeVideoDecode(videoConfig(), 'I420').cost.decoders).toBe(1);
        expect(describeAudioDecode(audioConfig(), 1024).cost.decoders).toBe(1);
    });

    it('grow video decode bytes with size, bit depth, chroma, and copying', () => {
        const bytes = (config: VideoDecoderConfig, format: Parameters<typeof describeVideoDecode>[1], copy: Parameters<typeof describeVideoDecode>[2] = null): number =>
            describeVideoDecode(config, format, copy).cost.bytes;
        const base = bytes(videoConfig(), 'I420');
        expect(bytes(videoConfig({ codedWidth: 3840 }), 'I420')).toBeGreaterThan(base);
        expect(bytes(videoConfig(), 'I420P10')).toBeGreaterThan(base);
        expect(bytes(videoConfig(), 'I420P12')).toBeGreaterThanOrEqual(bytes(videoConfig(), 'I420P10'));
        expect(bytes(videoConfig(), 'I422')).toBeGreaterThan(base);
        expect(bytes(videoConfig(), 'I444')).toBeGreaterThan(bytes(videoConfig(), 'I422'));
        expect(bytes(videoConfig(), 'I420', 'I420')).toBeGreaterThan(base);
        expect(bytes(videoConfig(), 'I420', 'I444P10')).toBeGreaterThan(bytes(videoConfig(), 'I420', 'I420'));
    });

    it('rank 4K 10-bit HEVC with a copy above 4K 8-bit, 1080p, and 64x64', () => {
        const uhd = { codedHeight: 2160, codedWidth: 3840 };
        const ranked = [
            describeVideoDecode(videoConfig({ codec: HEVC_MAIN_10, ...uhd }), 'I420P10', 'I420P10'),
            describeVideoDecode(videoConfig({ codec: HEVC_MAIN, ...uhd }), 'I420'),
            describeVideoDecode(videoConfig({ codec: HEVC_MAIN }), 'I420'),
            describeVideoDecode(videoConfig({ codec: HEVC_MAIN, codedHeight: 64, codedWidth: 64 }), 'I420')
        ].map((step) => step.cost.bytes);
        expect(ranked).toEqual([ ...ranked ].sort((left, right) => right - left));
        expect(new Set(ranked).size).toBe(ranked.length);
    });

    it('grow with the codec family reference frames, unknown families taking the most', () => {
        expect(describeVideoDecode(videoConfig({ codec: AVC_HIGH }), 'I420').cost.bytes)
            .toBeGreaterThan(describeVideoDecode(videoConfig({ codec: 'vp8' }), 'I420').cost.bytes);
        const known = [ 'avc1.640033', 'avc3.640033', 'hvc1.1.6.L153.B0', 'hev1.1.6.L153.B0', 'vp09.00.10.08', 'av01.0.08M.08', 'vp8' ];
        const most = Math.max(...known.map((codec) => getMaximumReferenceFrames(codec)));
        expect(getMaximumReferenceFrames('mystery.1')).toBe(most);
        expect(describeVideoDecode(videoConfig({ codec: 'mystery.1' }), 'I420').cost.bytes)
            .toBe(Math.max(...known.map((codec) => describeVideoDecode(videoConfig({ codec }), 'I420').cost.bytes)));
    });

    it('scale audio decode bytes with frames and channels', () => {
        const base = describeAudioDecode(audioConfig(), 1024).cost.bytes;
        expect(base).toBeGreaterThan(0);
        expect(describeAudioDecode(audioConfig(), 2048).cost.bytes).toBe(base * 2);
        expect(describeAudioDecode(audioConfig({ numberOfChannels: 6 }), 1024).cost.bytes).toBe(base * 3);
        expect(describeAudioDecode(audioConfig(), 0).cost.bytes).toBe(0);
    });

    it('find the largest bytes and decoders among steps', () => {
        const steps = [
            describeVideoConfigCheck(videoConfig()),
            describeVideoDecode(videoConfig(), 'I420'),
            describeAudioDecode(audioConfig(), 1024)
        ];
        expect(getLargestCapabilityProbeStepCost(steps)).toEqual({ bytes: steps[1].cost.bytes, decoders: 1 });
        expect(getLargestCapabilityProbeStepCost([])).toEqual({ bytes: 0, decoders: 0 });
    });
});
