// The route override: it narrows what the engine's eligibility may choose from, so the eligibility still validates every route it picks.
// The transport narrows the presentation authorizations; the decoder narrows the probed capabilities and decides whether the eligibility is offered the GPU decoder packages.
import type { CustomDecodeCapabilities } from 'webgpu-player/capability/CustomDecodeCapabilities';
import type { EligibleCustomPlayback } from 'webgpu-player/capability/CustomPlaybackEligibility';
import type { CustomPresentationEligibilityOptions } from 'webgpu-player/presentation/PresentationSetup';

import type { DecoderOverride, FrameTransportOverride, RouteOverride } from '../contracts/SandboxContracts';

const UNSUPPORTED_STATUS = 'unsupported';
const SUPPORTED_STATUS = 'supported';
const NATIVE_DECODER_BACKEND = 'native';
const GPU_DECODER_BACKEND = 'gpu';
const ROUTE_OVERRIDE_UNMET = 'route-override-unmet';

type CapabilityStatus = Readonly<{ status: string }>;

/** Returns the record with every supported capability marked unsupported. */
function withdrawCapabilityRecord<Key extends string, Capability extends CapabilityStatus>(
    record: Readonly<Record<Key, Capability>>
): Readonly<Record<Key, Capability>> {
    const entries: Array<[string, Capability]> = [];
    for (const [ key, capability ] of Object.entries<Capability>(record)) {
        entries.push([ key, capability.status === SUPPORTED_STATUS ? { ...capability, status: UNSUPPORTED_STATUS } : capability ]);
    }
    return Object.fromEntries(entries) as Record<Key, Capability>;
}

/**
 * Returns the capabilities with the video decoders a decoder override excludes withdrawn.
 * The GPU override withdraws every WebCodecs route, so only a GPU decoder package remains; the others keep them all.
 */
export function narrowCapabilitiesForDecoder(capabilities: CustomDecodeCapabilities, decoder: DecoderOverride): CustomDecodeCapabilities {
    switch (decoder) {
        case 'auto':
        case 'native':
            return capabilities;
        case 'gpu':
            return {
                ...capabilities,
                h264Profiles: undefined,
                hevcRangeExtensions: undefined,
                nativeDolbyVisionHEVC: undefined,
                nativeHDRHEVC: undefined,
                nativeUltraHDVideo: undefined,
                rawHDRVideo: withdrawCapabilityRecord(capabilities.rawHDRVideo),
                video: withdrawCapabilityRecord(capabilities.video)
            };
    }
}

/**
 * Returns the presentation options with the routes a transport override excludes withdrawn.
 * VideoFrames withdraw every raw-plane route; raw planes withdraw the external HDR and Dolby Vision routes, while an SDR VideoFrame route needs no authorization and stays.
 */
export function narrowPresentationOptionsForTransport(
    options: CustomPresentationEligibilityOptions,
    transport: FrameTransportOverride
): CustomPresentationEligibilityOptions {
    switch (transport) {
        case 'auto':
            return options;
        case 'video-frame':
            return {
                ...options,
                allowDolbyVision: false,
                allowDolbyVisionProfile4: false,
                allowDolbyVisionProfile7: false,
                allowRawHDR: false,
                allowRawSDR: false,
                authorizedRawHDRRouteKeys: []
            };
        case 'raw-planes':
            return {
                ...options,
                allowNativeDolbyVision: false,
                allowNativeDolbyVisionProfile7HDR10Base: false,
                allowNativeDolbyVisionProfile8HDR10Base: false,
                allowNativeDolbyVisionProfile8HLGBase: false,
                allowNativeHDR: false,
                authorizedExternalHDRRouteKeys: []
            };
    }
}

/** Returns whether an override lets the eligibility choose a GPU decoder package: every override but Native, which keeps to WebCodecs. */
export function allowsGPUVideoDecoders(decoder: DecoderOverride): boolean {
    switch (decoder) {
        case 'auto':
        case 'gpu':
            return true;
        case 'native':
            return false;
    }
}

/** Returns whether a route's decoder backend is the one a decoder override asks for. */
function meetsDecoderOverride(decoder: DecoderOverride, videoDecoderBackend: EligibleCustomPlayback['videoDecoderBackend']): boolean {
    switch (decoder) {
        case 'auto':
            return true;
        case 'gpu':
            return videoDecoderBackend === GPU_DECODER_BACKEND;
        case 'native':
            return videoDecoderBackend === NATIVE_DECODER_BACKEND;
    }
}

/** Returns what the chosen route left unmet of an override, as `route-override-unmet: <detail>`, or null when it met it. */
export function describeUnmetRouteOverride(override: RouteOverride, route: Pick<EligibleCustomPlayback, 'videoDecoderBackend' | 'videoOutputMode'>): string | null {
    const unmet: string[] = [];
    if (override.transport !== 'auto' && override.transport !== route.videoOutputMode) {
        unmet.push(`transport ${override.transport}, chose ${route.videoOutputMode}`);
    }
    if (!meetsDecoderOverride(override.decoder, route.videoDecoderBackend)) {
        unmet.push(`decoder ${override.decoder}, chose ${route.videoDecoderBackend}`);
    }
    return unmet.length === 0 ? null : `${ROUTE_OVERRIDE_UNMET}: ${unmet.join('; ')}`;
}
