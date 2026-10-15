import { registerMediabunnyPCMBuiltinDecoderAvailability } from './MediabunnyPCMBuiltinDecoderAvailability';

/** Registers what Mediabunny needs before it can decode the selected track's codec. */
export function registerRequiredCustomAudioDecoder(codec: string): void {
    switch (codec) {
        case 'ulaw':
        case 'alaw':
            registerMediabunnyPCMBuiltinDecoderAvailability();
            return;
        default:
            return;
    }
}
