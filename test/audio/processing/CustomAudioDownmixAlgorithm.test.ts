import { describe, expect, it } from 'vitest';

import {
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS,
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    isCustomAudioDownmixAlgorithm,
    normalizeCustomAudioDownmixAlgorithm
} from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';

describe('CustomAudioDownmixAlgorithm', () => {
    it.each(Object.values(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS))(
        'accepts the supported %s algorithm',
        algorithm => {
            expect(isCustomAudioDownmixAlgorithm(algorithm)).toBe(true);
            expect(normalizeCustomAudioDownmixAlgorithm(algorithm)).toBe(algorithm);
        }
    );

    it('rejects unknown values and restores the default', () => {
        expect(isCustomAudioDownmixAlgorithm('unsupported')).toBe(false);
        expect(isCustomAudioDownmixAlgorithm(null)).toBe(false);
        expect(normalizeCustomAudioDownmixAlgorithm('unsupported'))
            .toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
    });
});
