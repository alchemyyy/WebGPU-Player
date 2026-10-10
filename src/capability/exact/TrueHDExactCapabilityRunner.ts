import { MICROSECONDS_PER_SECOND } from '../../MediaTime';
import type { DecoderWASMSource } from '../../DecoderWASMSource';
import {
    createTrueHDExactCapabilityVectors,
    type TrueHDExactCapabilityVector
} from '#codec_vector_assets/truehd/TrueHDExactCapabilityVectors';
import {
    TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
    TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK,
    TRUEHD_QUALIFICATION_CODEC_MASK,
    TRUEHD_QUALIFICATION_VECTOR_COUNT,
    TRUEHD_QUALIFICATION_MEASURED_CYCLE_COUNT,
    TRUEHD_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR,
    TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK,
    TRUEHD_QUALIFICATION_WARMUP_CYCLE_COUNT,
    type TrueHDExactCapabilityWorkerResponse
} from './TrueHDExactCapabilityProtocol';
import TrueHDSoftwareAudioDecoder, {
    loadTrueHDDecoderModule,
    type TrueHDDecodedAudioOutput,
    type TrueHDDecoderCodec
} from '../../audio/decoders/TrueHDSoftwareAudioDecoder';

const TRUEHD_CODEC_MASK = 0x01;
const MLP_CODEC_MASK = 0x02;
const SAMPLE_RATE_48_KHZ_MASK = 0x01;
const SAMPLE_RATE_96_KHZ_MASK = 0x02;
const SAMPLE_RATE_192_KHZ_MASK = 0x04;

export type TrueHDExactCapabilityRunnerEnvironment = Readonly<{
    createDecoder: (codec: TrueHDDecoderCodec) => Promise<TrueHDSoftwareAudioDecoder>
    now: () => number
}>;

type TrueHDQualificationEvidence = {
    decodeMilliseconds: number | null
    libraryVersion: number | null
    majorSyncRecoveryVerified: boolean
    measuredRealTimeFactor: number | null
    verifiedChannelCountMask: number
    verifiedCodecMask: number
    verifiedVectorCount: number
    verifiedSampleRateMask: number
};

function createFailureResponse(
    reason: TrueHDExactCapabilityWorkerResponse['reason'],
    evidence: Readonly<TrueHDQualificationEvidence>
): TrueHDExactCapabilityWorkerResponse {
    return {
        ...evidence,
        reason,
        requestID: TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
        supported: false,
        type: 'result'
    };
}

function getCodecMask(codec: TrueHDDecoderCodec): number {
    switch (codec) {
        case 'truehd':
            return TRUEHD_CODEC_MASK;
        case 'mlp':
            return MLP_CODEC_MASK;
    }
}

function getSampleRateMask(sampleRate: number): number {
    switch (sampleRate) {
        case 48_000:
            return SAMPLE_RATE_48_KHZ_MASK;
        case 96_000:
            return SAMPLE_RATE_96_KHZ_MASK;
        case 192_000:
            return SAMPLE_RATE_192_KHZ_MASK;
        default:
            return 0;
    }
}

function outputMatchesExpected(
    output: TrueHDDecodedAudioOutput,
    vector: TrueHDExactCapabilityVector,
    expectedOutput: TrueHDExactCapabilityVector['expectedOutputs'][number]
): boolean {
    return output.bitsPerSample === vector.bitsPerSample
        && output.channelData.length === vector.channelCount
        && output.channelMask === vector.channelMask
        && output.codec === vector.codec
        && output.frameCount === expectedOutput.frameCount
        && output.losslessChannelBed
        && output.mediaTimeMicroseconds === expectedOutput.mediaTimeMicroseconds
        && !output.objectAudioRendered
        && output.pcmFingerprint === expectedOutput.pcmFingerprint
        && output.sampleRate === vector.sampleRate;
}

function decodeVector(decoder: TrueHDSoftwareAudioDecoder, vector: TrueHDExactCapabilityVector): number {
    decoder.clear();
    let decodedFrameCount = 0;
    let decodedOutputCount = 0;
    for (let accessUnitIndex = 0; accessUnitIndex < vector.accessUnits.length; accessUnitIndex += 1) {
        const expectedOutput = vector.expectedOutputs[accessUnitIndex];
        const outputs = decoder.decode(vector.accessUnits[accessUnitIndex], expectedOutput.mediaTimeMicroseconds);
        if (outputs.length !== 1 || !outputMatchesExpected(outputs[0], vector, expectedOutput)) {
            throw new Error('TrueHD exact qualification output mismatch');
        }
        decodedFrameCount += outputs[0].frameCount;
        decodedOutputCount += 1;
    }
    if (decodedOutputCount !== vector.expectedOutputs.length) {
        throw new Error('TrueHD exact qualification output count mismatch');
    }
    return decodedFrameCount;
}

function verifyMajorSyncRecovery(decoder: TrueHDSoftwareAudioDecoder, vector: TrueHDExactCapabilityVector): boolean {
    decoder.clear();
    let firstOutput: TrueHDDecodedAudioOutput | null = null;
    for (let accessUnitIndex = vector.majorSyncRecoveryStartIndex; accessUnitIndex < vector.accessUnits.length; accessUnitIndex += 1) {
        const expectedOutput = vector.expectedOutputs[accessUnitIndex];
        const outputs = decoder.decode(vector.accessUnits[accessUnitIndex], expectedOutput.mediaTimeMicroseconds);
        for (const output of outputs) {
            if (!outputMatchesExpected(output, vector, expectedOutput)) {
                return false;
            }
            firstOutput ??= output;
        }
    }
    return firstOutput !== null
        && firstOutput.mediaTimeMicroseconds > vector.expectedOutputs[vector.majorSyncRecoveryStartIndex].mediaTimeMicroseconds;
}

function measureThroughput(
    decoder: TrueHDSoftwareAudioDecoder,
    vector: TrueHDExactCapabilityVector,
    now: () => number
): Pick<TrueHDQualificationEvidence, 'decodeMilliseconds' | 'measuredRealTimeFactor'> {
    for (let cycleIndex = 0; cycleIndex < TRUEHD_QUALIFICATION_WARMUP_CYCLE_COUNT; cycleIndex += 1) {
        decodeVector(decoder, vector);
    }

    let decodedFrameCount = 0;
    const startMilliseconds = now();
    for (let cycleIndex = 0; cycleIndex < TRUEHD_QUALIFICATION_MEASURED_CYCLE_COUNT; cycleIndex += 1) {
        decodedFrameCount += decodeVector(decoder, vector);
    }
    const decodeMilliseconds = now() - startMilliseconds;
    if (!Number.isFinite(decodeMilliseconds) || decodeMilliseconds <= 0) {
        return { decodeMilliseconds: null, measuredRealTimeFactor: null };
    }
    const decodedDurationMilliseconds = decodedFrameCount * (MICROSECONDS_PER_SECOND / 1_000) / vector.sampleRate;
    const measuredRealTimeFactor = decodedDurationMilliseconds / decodeMilliseconds;
    return {
        decodeMilliseconds,
        measuredRealTimeFactor: Number.isFinite(measuredRealTimeFactor) ? measuredRealTimeFactor : null
    };
}

/**
 * The probe worker's environment: decoders from the requested FFmpeg TrueHD binary, timed by the worker's clock.
 * Its decoders fingerprint their PCM, which the exact comparison reads; playback decoders skip that work.
 */
export function createTrueHDExactCapabilityRunnerEnvironment(decoderWASM: DecoderWASMSource): TrueHDExactCapabilityRunnerEnvironment {
    return {
        createDecoder: codec => TrueHDSoftwareAudioDecoder.create(
            codec,
            () => loadTrueHDDecoderModule(decoderWASM),
            { pcmFingerprint: true }
        ),
        now: () => performance.now()
    };
}

/** Qualifies exact PCM, post-seek major-sync recovery, and real-time throughput. */
export async function runTrueHDExactCapabilityQualification(
    environment: TrueHDExactCapabilityRunnerEnvironment
): Promise<TrueHDExactCapabilityWorkerResponse> {
    const evidence: TrueHDQualificationEvidence = {
        decodeMilliseconds: null,
        libraryVersion: null,
        majorSyncRecoveryVerified: false,
        measuredRealTimeFactor: null,
        verifiedChannelCountMask: 0,
        verifiedCodecMask: 0,
        verifiedVectorCount: 0,
        verifiedSampleRateMask: 0
    };
    const decoders = new Map<TrueHDDecoderCodec, TrueHDSoftwareAudioDecoder>();
    try {
        const vectors = createTrueHDExactCapabilityVectors();
        for (const vector of vectors) {
            let decoder = decoders.get(vector.codec);
            if (!decoder) {
                decoder = await environment.createDecoder(vector.codec);
                decoders.set(vector.codec, decoder);
            }
            evidence.libraryVersion ??= decoder.libraryVersion;
            if (decoder.libraryVersion !== evidence.libraryVersion) {
                throw new Error('TrueHD decoders reported inconsistent library versions');
            }
            decodeVector(decoder, vector);
            evidence.verifiedVectorCount += 1;
            evidence.verifiedCodecMask |= getCodecMask(vector.codec);
            evidence.verifiedChannelCountMask |= 1 << vector.channelCount;
            evidence.verifiedSampleRateMask |= getSampleRateMask(vector.sampleRate);
        }
        if (evidence.verifiedVectorCount !== TRUEHD_QUALIFICATION_VECTOR_COUNT
            || evidence.verifiedCodecMask !== TRUEHD_QUALIFICATION_CODEC_MASK
            || evidence.verifiedChannelCountMask !== TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK
            || evidence.verifiedSampleRateMask !== TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK) {
            return createFailureResponse('output-mismatch', evidence);
        }

        const recoveryVector = vectors.find(vector => (vector.codec === 'truehd' && vector.sampleRate === 48_000));
        const trueHDDecoder = decoders.get('truehd');
        if (!recoveryVector || !trueHDDecoder || !verifyMajorSyncRecovery(trueHDDecoder, recoveryVector)) {
            return createFailureResponse('major-sync-recovery-failed', evidence);
        }
        evidence.majorSyncRecoveryVerified = true;

        const throughputVector = vectors.find(vector => (
            vector.codec === 'truehd'
            && vector.channelCount === 6
            && vector.sampleRate === 192_000
        ));
        if (!throughputVector) {
            throw new Error('TrueHD throughput vector is unavailable');
        }
        const throughput = measureThroughput(trueHDDecoder, throughputVector, environment.now);
        evidence.decodeMilliseconds = throughput.decodeMilliseconds;
        evidence.measuredRealTimeFactor = throughput.measuredRealTimeFactor;
        if (evidence.measuredRealTimeFactor === null
            || evidence.measuredRealTimeFactor < TRUEHD_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR) {
            return createFailureResponse('throughput-insufficient', evidence);
        }
        return {
            ...evidence,
            reason: 'decode-output-verified',
            requestID: TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
            supported: true,
            type: 'result'
        };
    } catch {
        return createFailureResponse('decode-error', evidence);
    } finally {
        for (const decoder of decoders.values()) {
            decoder.close();
        }
    }
}
