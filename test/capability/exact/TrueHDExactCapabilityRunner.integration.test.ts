import { describe, expect, it } from 'vitest';

import { TRUEHD_DECODER_WASM_ASSET } from 'webgpu-player/EngineAssets';
import {
    TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK,
    TRUEHD_QUALIFICATION_CODEC_MASK,
    TRUEHD_QUALIFICATION_VECTOR_COUNT,
    TRUEHD_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR,
    TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK
} from 'webgpu-player/capability/exact/TrueHDExactCapabilityProtocol';
import {
    createTrueHDExactCapabilityRunnerEnvironment,
    runTrueHDExactCapabilityQualification
} from 'webgpu-player/capability/exact/TrueHDExactCapabilityRunner';

import { readDecoderWASMSource } from '../../helpers/libraryAssets';

describe('runTrueHDExactCapabilityQualification integration', () => {
    it('verifies exact PCM, major-sync recovery, and real-time throughput', async () => {
        const result = await runTrueHDExactCapabilityQualification(
            createTrueHDExactCapabilityRunnerEnvironment(await readDecoderWASMSource(TRUEHD_DECODER_WASM_ASSET))
        );

        expect(result).toMatchObject({
            majorSyncRecoveryVerified: true,
            reason: 'decode-output-verified',
            supported: true,
            verifiedChannelCountMask: TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK,
            verifiedCodecMask: TRUEHD_QUALIFICATION_CODEC_MASK,
            verifiedVectorCount: TRUEHD_QUALIFICATION_VECTOR_COUNT,
            verifiedSampleRateMask: TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK
        });
        expect(result.libraryVersion).toBeGreaterThan(0);
        expect(result.decodeMilliseconds).toBeGreaterThan(0);
        expect(result.measuredRealTimeFactor).toBeGreaterThanOrEqual(TRUEHD_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR);
    }, 30_000);
});
