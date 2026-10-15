import { describe, expect, it, vi } from 'vitest';

const registerMediabunnyPCMBuiltinDecoderAvailability = vi.hoisted(() => vi.fn());

vi.mock('webgpu-player/decode/audio/MediabunnyPCMBuiltinDecoderAvailability', () => ({
    registerMediabunnyPCMBuiltinDecoderAvailability
}));

import { registerRequiredCustomAudioDecoder } from 'webgpu-player/decode/audio/CustomAudioDecoderRegistration';

const UNREGISTERED_CODECS = [ 'aac', 'ac3', 'eac3', 'flac', 'mp3', 'opus', 'vorbis' ];
const G711_CODECS = [ 'ulaw', 'alaw' ];

describe('registerRequiredCustomAudioDecoder', () => {
    it.each(UNREGISTERED_CODECS)('registers nothing for %s', (codec: string) => {
        registerMediabunnyPCMBuiltinDecoderAvailability.mockClear();

        registerRequiredCustomAudioDecoder(codec);

        expect(registerMediabunnyPCMBuiltinDecoderAvailability).not.toHaveBeenCalled();
    });

    it.each(G711_CODECS)('enables Mediabunny built-in %s decoding', (codec: string) => {
        registerMediabunnyPCMBuiltinDecoderAvailability.mockClear();

        registerRequiredCustomAudioDecoder(codec);

        expect(registerMediabunnyPCMBuiltinDecoderAvailability).toHaveBeenCalledOnce();
    });
});
