import { MICROSECONDS_PER_SECOND, type Microseconds } from '../../MediaTime';
import type { DecoderWASMSource } from '../../DecoderWASMSource';
import { getStereoChannelDataFingerprint } from '../../audio/processing/CustomAudioDownmix';
import { mixCustomAudioToStereo } from '../../audio/processing/CustomAudioChannelLayout';
import { createDTSExactCapabilityVectors } from '#codec_vector_assets/dts/DTSExactCapabilityVectors';
import {
    DTS_EXACT_CAPABILITY_REQUEST_ID,
    DTS_QUALIFICATION_VECTOR_COUNT,
    DTS_QUALIFICATION_MEASURED_CYCLE_COUNT,
    DTS_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR,
    DTS_QUALIFICATION_PROFILE_MASK,
    DTS_QUALIFICATION_WARMUP_CYCLE_COUNT,
    type DTSExactCapabilityWorkerResponse
} from './DTSExactCapabilityProtocol';
import DTSSoftwareAudioDecoder, {
    DTS_PROFILE_HD_MASTER_AUDIO,
    type DTSDecodedAudioOutput,
    getDTSDecodedAudioFingerprint,
    loadDTSDecoderModule
} from '../../audio/decoders/DTSSoftwareAudioDecoder';

export type DTSExactCapabilityRunnerEnvironment = Readonly<{
    createDecoder: () => Promise<DTSSoftwareAudioDecoder>
    now: () => number
}>;

function createFailureResponse(
    reason: DTSExactCapabilityWorkerResponse['reason'],
    libraryVersion: number | null,
    verifiedVectorCount: number,
    verifiedProfileMask: number,
    decodeMilliseconds: number | null = null,
    measuredRealTimeFactor: number | null = null
): DTSExactCapabilityWorkerResponse {
    return {
        decodeMilliseconds,
        libraryVersion,
        measuredRealTimeFactor,
        reason,
        requestID: DTS_EXACT_CAPABILITY_REQUEST_ID,
        supported: false,
        type: 'result',
        verifiedVectorCount,
        verifiedProfileMask
    };
}

function outputMatchesVector(
    output: DTSDecodedAudioOutput,
    vector: ReturnType<typeof createDTSExactCapabilityVectors>[number]
): boolean {
    const outputMatches = output.bitsPerSample === vector.bitsPerSample
        && output.channelMask === vector.channelMask
        && output.frameCount === vector.frameCount
        && output.profile === vector.profile
        && output.sampleRate === vector.sampleRate
        && output.parseStatus === 0
        && output.filterStatus === 0
        && (output.profile !== DTS_PROFILE_HD_MASTER_AUDIO || output.lossless)
        && getDTSDecodedAudioFingerprint(output) === vector.expectedFingerprint;
    if (!outputMatches || vector.expectedStereoFingerprint === null) {
        return outputMatches;
    }
    const stereo = mixCustomAudioToStereo(output.channelData, output.channelLayout);
    return getStereoChannelDataFingerprint(stereo) === vector.expectedStereoFingerprint;
}

function decodeVector(
    decoder: DTSSoftwareAudioDecoder,
    accessUnits: readonly Uint8Array[]
): Readonly<{ frameCount: number, output: DTSDecodedAudioOutput }> {
    decoder.clear();
    let frameCount = 0;
    let output: DTSDecodedAudioOutput | null = null;
    for (const accessUnit of accessUnits) {
        output = decoder.decode(accessUnit, 0 as Microseconds);
        frameCount += output.frameCount;
    }
    if (!output) {
        throw new Error('DTS qualification vector has no access units');
    }
    return { frameCount, output };
}

/** The probe worker's environment: decoders from the requested libdcadec binary, timed by the worker's clock. */
export function createDTSExactCapabilityRunnerEnvironment(decoderWASM: DecoderWASMSource): DTSExactCapabilityRunnerEnvironment {
    return {
        createDecoder: () => DTSSoftwareAudioDecoder.create(() => loadDTSDecoderModule(decoderWASM)),
        now: () => performance.now()
    };
}

/** Runs exact decode/downmix checks followed by a bounded DTS-HD MA throughput test. */
export async function runDTSExactCapabilityQualification(
    environment: DTSExactCapabilityRunnerEnvironment
): Promise<DTSExactCapabilityWorkerResponse> {
    let decoder: DTSSoftwareAudioDecoder | null = null;
    let libraryVersion: number | null = null;
    let verifiedVectorCount = 0;
    let verifiedProfileMask = 0;
    try {
        decoder = await environment.createDecoder();
        libraryVersion = decoder.libraryVersion;
        const vectors = createDTSExactCapabilityVectors();
        for (const vector of vectors) {
            const { output } = decodeVector(decoder, vector.accessUnits);
            if (!outputMatchesVector(output, vector)) {
                return createFailureResponse('output-mismatch', libraryVersion, verifiedVectorCount, verifiedProfileMask);
            }
            verifiedVectorCount += 1;
            verifiedProfileMask |= output.profile;
        }
        if (verifiedVectorCount !== DTS_QUALIFICATION_VECTOR_COUNT || verifiedProfileMask !== DTS_QUALIFICATION_PROFILE_MASK) {
            return createFailureResponse('output-mismatch', libraryVersion, verifiedVectorCount, verifiedProfileMask);
        }

        const throughputVector = vectors.find(vector => (
            vector.profile === DTS_PROFILE_HD_MASTER_AUDIO
            && vector.sampleRate === 192_000
        ));
        if (!throughputVector) {
            return createFailureResponse('output-mismatch', libraryVersion, verifiedVectorCount, verifiedProfileMask);
        }
        for (let cycleIndex = 0; cycleIndex < DTS_QUALIFICATION_WARMUP_CYCLE_COUNT; cycleIndex += 1) {
            decodeVector(decoder, throughputVector.accessUnits);
        }

        let decodedFrameCount = 0;
        const startMilliseconds = environment.now();
        for (let cycleIndex = 0; cycleIndex < DTS_QUALIFICATION_MEASURED_CYCLE_COUNT; cycleIndex += 1) {
            decodedFrameCount += decodeVector(decoder, throughputVector.accessUnits).frameCount;
        }
        const decodeMilliseconds = environment.now() - startMilliseconds;
        if (!Number.isFinite(decodeMilliseconds) || decodeMilliseconds <= 0) {
            return createFailureResponse('throughput-insufficient', libraryVersion, verifiedVectorCount, verifiedProfileMask);
        }
        const decodedDurationMilliseconds = decodedFrameCount * (MICROSECONDS_PER_SECOND / 1_000) / throughputVector.sampleRate;
        const measuredRealTimeFactor = decodedDurationMilliseconds / decodeMilliseconds;
        if (!Number.isFinite(measuredRealTimeFactor) || measuredRealTimeFactor < DTS_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR) {
            return createFailureResponse(
                'throughput-insufficient',
                libraryVersion,
                verifiedVectorCount,
                verifiedProfileMask,
                decodeMilliseconds,
                Number.isFinite(measuredRealTimeFactor) ? measuredRealTimeFactor : null
            );
        }
        return {
            decodeMilliseconds,
            libraryVersion,
            measuredRealTimeFactor,
            reason: 'decode-output-verified',
            requestID: DTS_EXACT_CAPABILITY_REQUEST_ID,
            supported: true,
            type: 'result',
            verifiedVectorCount,
            verifiedProfileMask
        };
    } catch {
        return createFailureResponse('decode-error', libraryVersion, verifiedVectorCount, verifiedProfileMask);
    } finally {
        decoder?.close();
    }
}
