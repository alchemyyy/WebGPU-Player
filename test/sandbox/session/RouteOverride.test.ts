import { describe, expect, it } from 'vitest';

import type { CustomDecodeCapabilities } from 'webgpu-player/capability/CustomDecodeCapabilities';
import { UNAUTHORIZED_PRESENTATION_ELIGIBILITY_OPTIONS, type CustomPresentationEligibilityOptions } from 'webgpu-player/presentation/PresentationSetup';

import {
    allowsGPUVideoDecoders,
    describeUnmetRouteOverride,
    narrowCapabilitiesForDecoder,
    narrowPresentationOptionsForTransport
} from '../../../sandbox/src/session/RouteOverride';

const NATIVE_CAPABILITY = { codec: 'hevc', codecString: 'hvc1.1.6.L153.B0', reason: 'decode-output-verified', status: 'supported' };
const RAW_CAPABILITY = { codec: 'hevc', codecString: 'hvc1.2.4.L153.B0', reason: 'output-copy-supported', status: 'supported' };
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

/** Capabilities with WebCodecs H.264 and HEVC routes, raw HEVC and AV1 planes, and native HDR HEVC. */
function createCapabilities(): CustomDecodeCapabilities {
    return {
        nativeHDRHEVC: { ...NATIVE_CAPABILITY, bitDepth: 10 },
        rawHDRVideo: { av1: { ...RAW_CAPABILITY, codec: 'av1' }, hevc: RAW_CAPABILITY },
        video: { h264: { ...NATIVE_CAPABILITY, codec: 'h264' }, hevc: NATIVE_CAPABILITY }
    } as unknown as CustomDecodeCapabilities;
}

describe('RouteOverride', () => {
    it('keeps the capabilities as probed without a decoder override and under the native one', () => {
        const capabilities = createCapabilities();

        expect(narrowCapabilitiesForDecoder(capabilities, 'auto')).toBe(capabilities);
        expect(narrowCapabilitiesForDecoder(capabilities, 'native')).toBe(capabilities);
    });

    it('drops every WebCodecs route for the GPU decoder', () => {
        const narrowed = narrowCapabilitiesForDecoder(createCapabilities(), 'gpu');

        expect(narrowed.nativeHDRHEVC).toBeUndefined();
        expect(narrowed.h264Profiles).toBeUndefined();
        expect(narrowed.video.h264.status).toBe('unsupported');
        expect(narrowed.video.hevc.status).toBe('unsupported');
        expect(narrowed.rawHDRVideo.hevc.status).toBe('unsupported');
        expect(narrowed.rawHDRVideo.av1.status).toBe('unsupported');
    });

    it('offers the GPU decoder packages under Auto and the GPU override, and none under Native', () => {
        expect(allowsGPUVideoDecoders('auto')).toBe(true);
        expect(allowsGPUVideoDecoders('gpu')).toBe(true);
        expect(allowsGPUVideoDecoders('native')).toBe(false);
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
        expect(describeUnmetRouteOverride({ decoder: 'gpu', transport: 'raw-planes' }, nativeVideoFrameRoute)).toBe(
            'route-override-unmet: transport raw-planes, chose video-frame; decoder gpu, chose native'
        );
    });

    it('meets the GPU override only on the frame-pool route, which no other decoder override meets', () => {
        const framePoolRoute = { videoDecoderBackend: 'gpu', videoOutputMode: 'frame-pool' } as const;

        expect(describeUnmetRouteOverride({ decoder: 'gpu', transport: 'auto' }, framePoolRoute)).toBeNull();
        expect(describeUnmetRouteOverride({ decoder: 'native', transport: 'raw-planes' }, framePoolRoute)).toBe(
            'route-override-unmet: transport raw-planes, chose frame-pool; decoder native, chose gpu'
        );
    });
});
