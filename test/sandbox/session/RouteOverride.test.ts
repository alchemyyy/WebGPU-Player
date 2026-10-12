import { describe, expect, it } from 'vitest';

import type { CustomDecodeCapabilities } from 'webgpu-player/capability/CustomDecodeCapabilities';
import { UNAUTHORIZED_PRESENTATION_ELIGIBILITY_OPTIONS, type CustomPresentationEligibilityOptions } from 'webgpu-player/presentation/PresentationSetup';

import {
    describeUnmetRouteOverride,
    narrowCapabilitiesForDecoder,
    narrowPresentationOptionsForTransport
} from '../../../sandbox/src/session/RouteOverride';

const NATIVE_CAPABILITY = { codec: 'hevc', codecString: 'hvc1.1.6.L153.B0', reason: 'decode-output-verified', status: 'supported' };
const BUNDLED_CAPABILITY = { codec: 'hevc', codecString: 'hvc1.2.4.L153.B0', reason: 'bundled-software-decoder', status: 'supported' };
const BUNDLED_HEVC = { status: 'supported' };
const RAW_PQ_ROUTE_KEY = 'I420P10:bt2020-ncl:bt2020:limited:pq';
const EXTERNAL_PQ_ROUTE_KEY = 'external-hevc-main10-bt709-limited:pq-v1';

// Every route authorized, which an override can only narrow
const AUTHORIZED_OPTIONS: CustomPresentationEligibilityOptions = {
    allowDolbyVision: true,
    allowDolbyVisionProfile4: true,
    allowDolbyVisionProfile7: true,
    allowNativeDolbyVision: true,
    allowNativeDolbyVisionProfile7HDR10Base: true,
    allowNativeDolbyVisionProfile8HDR10Base: true,
    allowNativeDolbyVisionProfile8HLGBase: true,
    allowNativeHDR: true,
    allowRawHDR: true,
    allowRawSDR: true,
    authorizedExternalHDRRouteKeys: [ EXTERNAL_PQ_ROUTE_KEY ],
    authorizedRawHDRRouteKeys: [ RAW_PQ_ROUTE_KEY ]
};

/** Capabilities with a WebCodecs H.264 route, an HEVC route the bundled decoder qualified, and native HDR HEVC. */
function createCapabilities(): CustomDecodeCapabilities {
    return {
        bundledHEVC: BUNDLED_HEVC,
        nativeHDRHEVC: { ...NATIVE_CAPABILITY, bitDepth: 10 },
        rawHDRVideo: { av1: { ...NATIVE_CAPABILITY, codec: 'av1' }, hevc: BUNDLED_CAPABILITY },
        video: { h264: { ...NATIVE_CAPABILITY, codec: 'h264' }, hevc: BUNDLED_CAPABILITY }
    } as unknown as CustomDecodeCapabilities;
}

describe('RouteOverride', () => {
    it('keeps the capabilities as probed without a decoder override', () => {
        const capabilities = createCapabilities();

        expect(narrowCapabilitiesForDecoder(capabilities, 'auto')).toBe(capabilities);
    });

    it('drops the bundled decoders for the native decoder', () => {
        const narrowed = narrowCapabilitiesForDecoder(createCapabilities(), 'native');

        expect(narrowed.bundledHEVC).toBeUndefined();
        expect(narrowed.video.hevc.status).toBe('unsupported');
        expect(narrowed.rawHDRVideo.hevc.status).toBe('unsupported');
        expect(narrowed.video.h264.status).toBe('supported');
        expect(narrowed.nativeHDRHEVC?.status).toBe('supported');
    });

    it('drops every WebCodecs route for the software decoder', () => {
        const narrowed = narrowCapabilitiesForDecoder(createCapabilities(), 'software');

        expect(narrowed.bundledHEVC).toBe(BUNDLED_HEVC);
        expect(narrowed.video.hevc.status).toBe('supported');
        expect(narrowed.rawHDRVideo.hevc.status).toBe('supported');
        expect(narrowed.video.h264.status).toBe('unsupported');
        expect(narrowed.rawHDRVideo.av1.status).toBe('unsupported');
        expect(narrowed.nativeHDRHEVC?.status).toBe('unsupported');
    });

    it('withdraws the raw-plane routes for VideoFrames, and the external routes for raw planes', () => {
        expect(narrowPresentationOptionsForTransport(AUTHORIZED_OPTIONS, 'auto')).toBe(AUTHORIZED_OPTIONS);
        expect(narrowPresentationOptionsForTransport(AUTHORIZED_OPTIONS, 'video-frame')).toMatchObject({
            allowDolbyVision: false,
            allowNativeHDR: true,
            allowRawHDR: false,
            allowRawSDR: false,
            authorizedExternalHDRRouteKeys: [ EXTERNAL_PQ_ROUTE_KEY ],
            authorizedRawHDRRouteKeys: []
        });
        expect(narrowPresentationOptionsForTransport(AUTHORIZED_OPTIONS, 'raw-planes')).toMatchObject({
            allowDolbyVision: true,
            allowNativeDolbyVision: false,
            allowNativeHDR: false,
            allowRawHDR: true,
            authorizedExternalHDRRouteKeys: [],
            authorizedRawHDRRouteKeys: [ RAW_PQ_ROUTE_KEY ]
        });
        expect(narrowPresentationOptionsForTransport(UNAUTHORIZED_PRESENTATION_ELIGIBILITY_OPTIONS, 'raw-planes').allowRawHDR).toBe(false);
    });

    it('reports each part of an override the chosen route left unmet', () => {
        const nativeVideoFrameRoute = { videoDecoderBackend: 'native', videoOutputMode: 'video-frame' } as const;

        expect(describeUnmetRouteOverride({ decoder: 'auto', transport: 'auto' }, nativeVideoFrameRoute)).toBeNull();
        expect(describeUnmetRouteOverride({ decoder: 'native', transport: 'video-frame' }, nativeVideoFrameRoute)).toBeNull();
        expect(describeUnmetRouteOverride({ decoder: 'software', transport: 'raw-planes' }, nativeVideoFrameRoute)).toBe(
            'route-override-unmet: transport raw-planes, chose video-frame; decoder software, chose native'
        );
        expect(describeUnmetRouteOverride({ decoder: 'native', transport: 'auto' }, { videoDecoderBackend: 'bundled-hevc', videoOutputMode: 'raw-planes' })).toBe(
            'route-override-unmet: decoder native, chose bundled-hevc'
        );
    });
});
