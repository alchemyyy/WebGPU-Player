// The route override: it narrows what the engine's eligibility may choose from, so the eligibility still validates every route it picks.
// The transport narrows the presentation authorizations; the decoder narrows the probed capabilities to one backend, which can only choose among what the probes qualified.
import type { CustomDecodeCapabilities } from 'webgpu-player/capability/CustomDecodeCapabilities';
import type { EligibleCustomPlayback } from 'webgpu-player/capability/CustomPlaybackEligibility';
import type { CustomPresentationEligibilityOptions } from 'webgpu-player/presentation/PresentationSetup';

import type { DecoderOverride, FrameTransportOverride, RouteOverride } from '../contracts/SandboxContracts';

// A capability the bundled decoder qualified, rather than the browser's WebCodecs decoder
const BUNDLED_DECODER_REASON = 'bundled-software-decoder';
const UNSUPPORTED_STATUS = 'unsupported';
const SUPPORTED_STATUS = 'supported';
const NATIVE_DECODER_BACKEND = 'native';
const ROUTE_OVERRIDE_UNMET = 'route-override-unmet';

type CapabilityStatus = Readonly<{ reason: string; status: string }>;

/** Returns a capability marked unsupported when the decoder override excludes its backend. */
function narrowCapability<Capability extends CapabilityStatus>(capability: Capability, decoder: DecoderOverride): Capability {
    const bundled = capability.reason === BUNDLED_DECODER_REASON;
    const excluded = decoder === 'native' ? bundled : !bundled;
    return excluded && capability.status === SUPPORTED_STATUS ? { ...capability, status: UNSUPPORTED_STATUS } : capability;
}

function narrowCapabilityRecord<Key extends string, Capability extends CapabilityStatus>(
    record: Readonly<Record<Key, Capability>>,
    decoder: DecoderOverride
): Readonly<Record<Key, Capability>> {
    const entries: Array<[string, Capability]> = [];
    for (const [ key, capability ] of Object.entries<Capability>(record)) {
        entries.push([ key, narrowCapability(capability, decoder) ]);
    }
    return Object.fromEntries(entries) as Record<Key, Capability>;
}

/**
 * Returns the capabilities with the video decoders a decoder override excludes marked unsupported.
 * Native keeps the WebCodecs routes and drops the bundled decoders; software keeps the bundled decoders and drops every WebCodecs route.
 */
export function narrowCapabilitiesForDecoder(capabilities: CustomDecodeCapabilities, decoder: DecoderOverride): CustomDecodeCapabilities {
    switch (decoder) {
        case 'auto':
            return capabilities;
        case 'native':
            return {
                ...capabilities,
                bundledHEVC: undefined,
                bundledJPEG2000: undefined,
                bundledMPEG2: undefined,
                bundledVC1: undefined,
                rawHDRVideo: narrowCapabilityRecord(capabilities.rawHDRVideo, decoder),
                video: narrowCapabilityRecord(capabilities.video, decoder)
            };
        case 'software':
            return {
                ...capabilities,
                nativeDolbyVisionHEVC: capabilities.nativeDolbyVisionHEVC && narrowCapability(capabilities.nativeDolbyVisionHEVC, decoder),
                nativeHDRHEVC: capabilities.nativeHDRHEVC && narrowCapability(capabilities.nativeHDRHEVC, decoder),
                nativeUltraHDVideo: capabilities.nativeUltraHDVideo && narrowCapabilityRecord(capabilities.nativeUltraHDVideo, decoder),
                rawHDRVideo: narrowCapabilityRecord(capabilities.rawHDRVideo, decoder),
                video: narrowCapabilityRecord(capabilities.video, decoder)
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

/** Returns what the chosen route left unmet of an override, as `route-override-unmet: <detail>`, or null when it met it. */
export function describeUnmetRouteOverride(override: RouteOverride, route: Pick<EligibleCustomPlayback, 'videoDecoderBackend' | 'videoOutputMode'>): string | null {
    const unmet: string[] = [];
    if (override.transport !== 'auto' && override.transport !== route.videoOutputMode) {
        unmet.push(`transport ${override.transport}, chose ${route.videoOutputMode}`);
    }
    const nativeDecoder = route.videoDecoderBackend === NATIVE_DECODER_BACKEND;
    if ((override.decoder === 'native' && !nativeDecoder) || (override.decoder === 'software' && nativeDecoder)) {
        unmet.push(`decoder ${override.decoder}, chose ${route.videoDecoderBackend}`);
    }
    return unmet.length === 0 ? null : `${ROUTE_OVERRIDE_UNMET}: ${unmet.join('; ')}`;
}
