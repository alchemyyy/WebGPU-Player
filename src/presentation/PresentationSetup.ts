// How a playback presents: its presentation input, the authorizations that gate the eligibility's presentation routes, and the presenter's color pipeline for the route the eligibility chose.
// A host calls these around the engine's eligibility; they keep no state, so the host's play options, eligibility, and generations stay its own.
import {
    getDolbyVisionReconstructionRawFrameFormat,
    getGPUVideoDecodeTarget,
    getRawVideoPresentationRouteKey,
    type CustomPlaybackEligibility,
    type CustomPlaybackEligibilityOptions
} from '../capability/CustomPlaybackEligibility';
import { getHEVCRangeExtensionStreamDefinitionFromMetadata } from '../capability/HEVCRangeExtensionCapabilities';
import { createHLGColorMetadata, createPQColorMetadata, type InputColorMetadata } from '../color/ColorMetadata';
import type {
    CustomDecodeDolbyVisionProfile,
    CustomDecodeRawVideoFrameFormat,
    CustomDecodeVideoOutputMode
} from '../pipeline/DecodeWorkerProtocol';
import { getStaticHDRToneMappingPeakNits, type StaticHDRMetadata } from '../demux/hdr/StaticHDRMetadata';
import {
    getRawFormatBitDepth,
    isRawDolbyVisionVideoFrameFormat,
    type RawDolbyVisionVideoFrameFormat
} from '../decode/video/RawVideoFrameCopy';
import { getExternalHDRAuthorizationRouteKey, type ExternalHDRAuthorizationRouteKey } from '../validation/ExternalHDRPresentationAuthorization';
import { isPrewarmedRawAuthorizationRouteKey, type RawHDRAuthorizationRouteKey } from '../validation/RawHDRPresentationAuthorization';
import {
    getDolbyVisionBaseColorMetadata,
    getDolbyVisionPresentationDescriptor,
    getDolbyVisionProfile7HDR10BaseColorMetadata,
    getDolbyVisionProfile8HDR10BaseColorMetadata,
    getDolbyVisionProfile8HLGBaseColorMetadata,
    getPresentationInputColorMetadata,
    getPresentationVideoFields,
    getPresentationVideoTrackOrdinal,
    isDolbyVisionProfile7HDR10BaseLayerDescriptor,
    isDolbyVisionProfile8HDR10BaseLayerDescriptor,
    isDolbyVisionProfile8HLGBaseLayerDescriptor,
    isKnownSDRPresentationInput,
    type DolbyVisionPresentationDescriptor
} from './PresentationInput';
import type {
    GPUVideoDecodeHandle,
    GPUVideoDecodeSessionFactory,
    GPUVideoDecodeSessionRequest
} from '../decode/video/gpu/GPUVideoDecodeFeed';
import { isGPUDecoderOutputFormat } from '../decode/video/gpu/GPUDecodeFormats';
import type { VideoDecoderPackage } from '../decode/packages/DecoderPackage';
import { describeGPUDecoderErrorWord } from '../decode/video/gpu/GPUDecoderManifest';
import { selectGPUDecodeSessionStream } from '../decode/video/gpu/GPUDecoderStreamFit';
import { GPUVideoDecodeError } from '../decode/video/gpu/GPUDecodeTypes';
import { getGPUFramePoolByteLimit } from '../decode/video/gpu/GPUFramePool';
import { createGPUVideoDecoderOffer, type GPUVideoDecoderOffer } from '../decode/video/gpu/GPUVideoDecoderCatalog';
import GPUVideoDecodeSession from '../decode/video/gpu/GPUVideoDecodeSession';
import { createDefaultRenderSettings, type HDRToSDRRenderSettings, type RenderSettings } from './RenderSettings';
import type WebGPUPresenter from './WebGPUPresenter';
import type { DolbyVisionReconstructionTarget, PresentationColorPipelineConfiguration } from './WebGPUPresenter';

/** A playback's presentation input, read once from its play options. */
export type PresentationInput = Readonly<{
    /** The selected video track's color, or null for Dolby Vision and unrecognized descriptions */
    colorMetadata: InputColorMetadata | null
    /** A Dolby Vision stream's declared base layer, presented by the ordinary routes when no RPU route is used */
    dolbyVisionBaseColorMetadata: InputColorMetadata | null
    dolbyVisionDescriptor: DolbyVisionPresentationDescriptor | null
}>;

/** A host's HDR render configuration for an input peak: its settings, and whether the input peak follows the detected one. */
export type HDRRenderConfiguration = Readonly<{
    automaticInputPeakNits: boolean
    settings: HDRToSDRRenderSettings
}>;

/** Returns the host's HDR render configuration for a stream's detected input peak. */
export type HDRRenderConfigurationProvider = (detectedInputPeakNits: number) => HDRRenderConfiguration;

/** The eligibility options that only presentation authorizations decide. */
export type CustomPresentationEligibilityOptions = Pick<
    CustomPlaybackEligibilityOptions,
    | 'allowDolbyVision'
    | 'allowDolbyVisionProfile4'
    | 'allowDolbyVisionProfile7'
    | 'allowFramePoolHDR'
    | 'allowNativeDolbyVision'
    | 'allowNativeDolbyVisionProfile7HDR10Base'
    | 'allowNativeDolbyVisionProfile8HDR10Base'
    | 'allowNativeDolbyVisionProfile8HLGBase'
    | 'allowNativeHDR'
    | 'allowRawHDR'
    | 'allowRawSDR'
    | 'authorizedExternalHDRRouteKeys'
    | 'authorizedRawHDRRouteKeys'
>;

/** The raw Dolby Vision flags of the eligibility's options. */
export type RawDolbyVisionRouteFlags = Pick<
    CustomPlaybackEligibilityOptions,
    'allowDolbyVision' | 'allowDolbyVisionProfile4' | 'allowDolbyVisionProfile7'
>;

/** What the presentation authorizations need from the host. */
export type PresentationAuthorizationRequest = Readonly<{
    input: PresentationInput
    /** Whether the host lets HDR routes tone-map */
    isHDRToneMappingEnabled: () => Promise<boolean>
    /** Whether the playback that asked is still current; checked after every wait */
    isCurrent: () => boolean
    options: unknown
}>;

/** What the color pipeline needs from the host: the route, the eligibility that chose it, and the host's render configuration. */
export type ColorPipelineRequest = Readonly<{
    /** Called where an SDR input leaves no detected input peak */
    clearDetectedInputPeak: () => void
    createHDRRenderConfiguration: HDRRenderConfigurationProvider
    dolbyVisionProfile: CustomDecodeDolbyVisionProfile
    /** The eligibility that chose the route, or null when the browser's own video element plays */
    eligibility: CustomPlaybackEligibility | null
    generation: number
    input: PresentationInput
    options: unknown
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    videoOutputMode: CustomDecodeVideoOutputMode
}>;

/** What a static HDR metadata update needs from the host. */
export type StaticHDRRenderSettingsRequest = Readonly<{
    createHDRRenderConfiguration: HDRRenderConfigurationProvider
    currentSettings: RenderSettings
    eligibility: CustomPlaybackEligibility | null
    input: PresentationInput
    metadata: StaticHDRMetadata
    options: unknown
}>;

type CustomPresentationAuthorizations = {
    authorizedExternalHDRRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
    authorizedRawHDRRouteKeys: readonly RawHDRAuthorizationRouteKey[]
};

/** The presenter as a route's color configuration uses it, which adds the stream's fields to every configuration. */
type ColorPipelinePresenter = Pick<WebGPUPresenter, 'configureColorPipeline'>;

/** The presentation input of no playback: no color, no Dolby Vision. */
export const EMPTY_PRESENTATION_INPUT: PresentationInput = Object.freeze({
    colorMetadata: null,
    dolbyVisionBaseColorMetadata: null,
    dolbyVisionDescriptor: null
});

/** The base color an exact Profile 7 or 8.1 HDR10-compatible base declares. */
export const DOLBY_VISION_HDR10_BASE_COLOR_METADATA = Object.freeze(createPQColorMetadata());
/** The base color an exact Profile 8.4 HLG-compatible base declares. */
export const DOLBY_VISION_HLG_BASE_COLOR_METADATA = Object.freeze(createHLGColorMetadata());

/** The presentation options of a play method that custom playback never accepts. */
export const UNAUTHORIZED_PRESENTATION_ELIGIBILITY_OPTIONS: CustomPresentationEligibilityOptions = Object.freeze({
    allowDolbyVision: false,
    allowDolbyVisionProfile7: false,
    allowFramePoolHDR: false,
    allowNativeDolbyVision: false,
    allowNativeHDR: false,
    allowRawHDR: false,
    allowRawSDR: false,
    authorizedExternalHDRRouteKeys: [],
    authorizedRawHDRRouteKeys: []
});

// AV1 and VP9 present HDR only through raw planes, since the native external HDR route decodes HEVC Main 10 alone
const RAW_ONLY_HDR_VIDEO_CODECS = new Set<string>([ 'AV1', 'VP9' ]);
const HEVC_VIDEO_CODECS: readonly string[] = [ 'H265', 'HEVC' ];
const VIDEO_STREAM_TYPE = 'VIDEO';
/** The raw format Dolby Vision reconstruction falls back to when the stream does not name its own. */
export const DEFAULT_DOLBY_VISION_RAW_FRAME_FORMAT: RawDolbyVisionVideoFrameFormat = 'I420P10';
const RAW_SDR_ROUTE_KEY_SUFFIX = ':sdr';
// The nominal input peak a Dolby Vision presentation's render configuration starts from
const DOLBY_VISION_INPUT_PEAK_NITS = 4_000;
const DOLBY_VISION_PROFILE_5 = 5;
const DOLBY_VISION_PROFILE_4 = 4;
const DOLBY_VISION_PROFILE_7 = 7;
const DOLBY_VISION_PROFILE_8 = 8;
const HDR_BIT_DEPTHS: readonly number[] = [ 10, 12 ];

/** Reads a playback's presentation input from its play options. */
export function readPresentationInput(options: unknown): PresentationInput {
    return {
        colorMetadata: getPresentationInputColorMetadata(options),
        dolbyVisionBaseColorMetadata: getDolbyVisionBaseColorMetadata(options),
        dolbyVisionDescriptor: getDolbyVisionPresentationDescriptor(options)
    };
}

/** Returns whether WebGPU presents a playback: known SDR always, and HDR or Dolby Vision while custom decode is enabled. */
export function isWebGPUPresentationInput(options: unknown, input: PresentationInput, customDecodeEnabled: boolean): boolean {
    const customHDRPresentation = customDecodeEnabled
        && (input.dolbyVisionDescriptor !== null || (input.colorMetadata !== null && input.colorMetadata.transfer !== 'sdr'));
    return isKnownSDRPresentationInput(options) || customHDRPresentation;
}

/** Returns the input with its depth fixed by the raw plane format, since a source can omit the depth of a range extension. */
export function alignPresentationInputBitDepth(input: PresentationInput, rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null): PresentationInput {
    if (!rawVideoFrameFormat) {
        return input;
    }
    const bitDepth = getRawFormatBitDepth(rawVideoFrameFormat);
    return {
        ...input,
        colorMetadata: input.colorMetadata ? { ...input.colorMetadata, bitDepth } : null,
        dolbyVisionBaseColorMetadata: input.dolbyVisionBaseColorMetadata ? { ...input.dolbyVisionBaseColorMetadata, bitDepth } : null
    };
}

/**
 * Returns whether the presented stream's HDR presents only through raw planes.
 * AV1, VP9, and HEVC range extensions have no native external route, so an external authorization never covers them.
 */
export function isRawOnlyHDRPresentation(options: unknown): boolean {
    if (!options || typeof options !== 'object') {
        return false;
    }
    const mediaSource = (options as { mediaSource?: unknown }).mediaSource;
    if (!mediaSource || typeof mediaSource !== 'object') {
        return false;
    }
    const mediaStreams = (mediaSource as { MediaStreams?: unknown }).MediaStreams;
    const videoTrackOrdinal = getPresentationVideoTrackOrdinal(options);
    if (!Array.isArray(mediaStreams) || videoTrackOrdinal === null) {
        return false;
    }
    const videoStreams = mediaStreams.filter((stream: unknown): boolean => (
        stream !== null
        && typeof stream === 'object'
        && String((stream as { Type?: unknown }).Type ?? '').trim().toUpperCase() === VIDEO_STREAM_TYPE
    ));
    const videoStream: unknown = videoStreams[videoTrackOrdinal];
    if (!videoStream) {
        return false;
    }
    const codec = String((videoStream as { Codec?: unknown }).Codec ?? '').trim().toUpperCase();
    return RAW_ONLY_HDR_VIDEO_CODECS.has(codec)
        || (HEVC_VIDEO_CODECS.includes(codec) && getHEVCRangeExtensionStreamDefinitionFromMetadata(videoStream) !== null);
}

/** Returns the RPU route a Dolby Vision presentation authorizes, when the stream has one. */
export function getDolbyVisionReconstructionTarget(options: unknown): DolbyVisionReconstructionTarget | null {
    const descriptor = getDolbyVisionPresentationDescriptor(options);
    const rawFrameFormat = getDolbyVisionReconstructionRawFrameFormat(options);
    if (
        !descriptor
        || descriptor.reconstructionProfile === null
        || rawFrameFormat === null
        || !isRawDolbyVisionVideoFrameFormat(rawFrameFormat)
    ) {
        return null;
    }
    return { profile: descriptor.reconstructionProfile, rawFrameFormat };
}

/** Returns the raw format whose authorization gates single-layer reconstruction. */
export function getSingleLayerDolbyVisionRawFrameFormat(
    reconstructionTarget: DolbyVisionReconstructionTarget | null
): RawDolbyVisionVideoFrameFormat {
    return reconstructionTarget?.profile === DOLBY_VISION_PROFILE_5 || reconstructionTarget?.profile === DOLBY_VISION_PROFILE_8 ?
        reconstructionTarget.rawFrameFormat :
        DEFAULT_DOLBY_VISION_RAW_FRAME_FORMAT;
}

/** Returns the raw format whose authorizations gate dual-layer reconstruction. */
export function getDualLayerDolbyVisionRawFrameFormat(
    reconstructionTarget: DolbyVisionReconstructionTarget | null
): RawDolbyVisionVideoFrameFormat {
    return reconstructionTarget?.rawFrameFormat ?? DEFAULT_DOLBY_VISION_RAW_FRAME_FORMAT;
}

/** Returns whether a raw route key presents SDR; raw SDR keys share the raw HDR key list. */
export function isRawSDRRouteKey(routeKey: RawHDRAuthorizationRouteKey): boolean {
    return routeKey.endsWith(RAW_SDR_ROUTE_KEY_SUFFIX);
}

/** Returns whether the external HDR route of a Dolby Vision base's declared color is authorized. */
export function hasAuthorizedDolbyVisionBaseRoute(metadata: InputColorMetadata, routeKeys: readonly ExternalHDRAuthorizationRouteKey[]): boolean {
    const routeKey = getExternalHDRAuthorizationRouteKey(metadata);
    return routeKey !== null && routeKeys.includes(routeKey);
}

/** Returns the raw Dolby Vision flags of a stream's own RPU route; no other route's authorization counts. */
export function getRawDolbyVisionRouteFlags(
    presenter: WebGPUPresenter,
    descriptor: DolbyVisionPresentationDescriptor | null,
    reconstructionTarget: DolbyVisionReconstructionTarget | null
): RawDolbyVisionRouteFlags {
    const flags: RawDolbyVisionRouteFlags = {
        allowDolbyVision: false,
        allowDolbyVisionProfile4: false,
        allowDolbyVisionProfile7: false
    };
    switch (descriptor?.reconstructionProfile ?? null) {
        case DOLBY_VISION_PROFILE_4:
            flags.allowDolbyVisionProfile4 = presenter.isRawDolbyVisionProfile4PresentationAuthorized(
                getDualLayerDolbyVisionRawFrameFormat(reconstructionTarget)
            );
            break;
        case DOLBY_VISION_PROFILE_5:
        case DOLBY_VISION_PROFILE_8:
            flags.allowDolbyVision = presenter.isRawDolbyVisionPresentationAuthorized(
                getSingleLayerDolbyVisionRawFrameFormat(reconstructionTarget)
            );
            break;
        case DOLBY_VISION_PROFILE_7:
            flags.allowDolbyVisionProfile7 = presenter.isRawDolbyVisionProfile7PresentationAuthorized(
                getDualLayerDolbyVisionRawFrameFormat(reconstructionTarget)
            );
            break;
        default:
            break;
    }
    return flags;
}

/** Starts the probes a stream's routes need, and returns the route keys already authorized. */
function prepareCustomPresentationAuthorizations(
    presenter: WebGPUPresenter,
    rawHDRRequested: boolean,
    dolbyVisionRequested: boolean,
    dolbyVisionBaseRequested: boolean,
    reconstructionTarget: DolbyVisionReconstructionTarget | null
): CustomPresentationAuthorizations {
    const externalHDRRequested = rawHDRRequested || dolbyVisionBaseRequested;
    if (externalHDRRequested) {
        void presenter.prewarmExternalHDRPresentationAuthorization();
    }
    if (rawHDRRequested) {
        void presenter.prewarmRawHDRPresentationAuthorization();
    }
    if (dolbyVisionRequested) {
        void presenter.prewarmDolbyVisionPresentationAuthorization(reconstructionTarget);
    }
    return {
        authorizedExternalHDRRouteKeys: externalHDRRequested ? presenter.getAuthorizedExternalHDRRouteKeys() : [],
        authorizedRawHDRRouteKeys: rawHDRRequested ?
            presenter.getAuthorizedRawHDRRouteKeys().filter((routeKey: RawHDRAuthorizationRouteKey): boolean => !isRawSDRRouteKey(routeKey)) :
            []
    };
}

/** The presentation options of a stream without an HDR request, or of a host that does not tone-map HDR: the raw SDR routes alone. */
function createSDRPresentationOptions(
    authorizedRawSDRRouteKeys: readonly RawHDRAuthorizationRouteKey[],
    authorizedExternalHDRRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
): CustomPresentationEligibilityOptions {
    return {
        allowDolbyVision: false,
        allowDolbyVisionProfile7: false,
        allowFramePoolHDR: false,
        allowNativeDolbyVision: false,
        allowNativeHDR: false,
        allowRawHDR: false,
        allowRawSDR: authorizedRawSDRRouteKeys.length > 0,
        authorizedExternalHDRRouteKeys,
        authorizedRawHDRRouteKeys: authorizedRawSDRRouteKeys
    };
}

/** AV1, VP9, and HEVC range extensions present HDR only through raw planes, so their raw HDR probes settle first whatever the external result. */
function waitForRawOnlyHDRAuthorization(presenter: WebGPUPresenter, options: unknown, rawHDRRequested: boolean): Promise<void> {
    return rawHDRRequested && isRawOnlyHDRPresentation(options) ? presenter.waitForRawHDRAuthorizationPrewarm() : Promise.resolve();
}

/** Most RPU keys authorize on first use, and a prewarmed key probes again on a recreated GPU device; a settled probe resolves at once. */
function waitForDolbyVisionReconstructionAuthorization(presenter: WebGPUPresenter, target: DolbyVisionReconstructionTarget | null): Promise<void> {
    return target ? presenter.waitForDolbyVisionAuthorizationPrewarm(target) : Promise.resolve();
}

/**
 * Returns the raw SDR key of the presented stream's raw-plane route when it authorizes on first use, as every key outside BT.709 does, or null.
 * The prewarmed keys and the HDR keys have their own waits.
 */
export function getFirstUseRawSDRRouteKey(options: unknown): RawHDRAuthorizationRouteKey | null {
    const routeKey = getRawVideoPresentationRouteKey(options);
    return routeKey !== null && isRawSDRRouteKey(routeKey) && !isPrewarmedRawAuthorizationRouteKey(routeKey) ? routeKey : null;
}

/**
 * Returns the eligibility options the presentation authorizations decide for a playback, once the probes its routes wait on settle.
 * Resolves null when the playback stopped being current during a wait.
 */
export async function getCustomPresentationEligibilityOptions(
    presenter: WebGPUPresenter,
    request: PresentationAuthorizationRequest
): Promise<CustomPresentationEligibilityOptions | null> {
    const { input, options } = request;
    await presenter.waitForRawSDRAuthorizationPrewarm(getFirstUseRawSDRRouteKey(options));
    if (!request.isCurrent()) {
        return null;
    }
    const authorizedRawSDRRouteKeys = presenter.getAuthorizedRawHDRRouteKeys().filter(isRawSDRRouteKey);
    // A Dolby Vision stream without an RPU route presents its declared base through the same static routes
    const metadata = input.colorMetadata ?? input.dolbyVisionBaseColorMetadata;
    const rawHDRRequested = metadata !== null && metadata.transfer !== 'sdr' && HDR_BIT_DEPTHS.includes(metadata.bitDepth);
    const dolbyVisionRequested = input.dolbyVisionDescriptor !== null;
    const reconstructionTarget = getDolbyVisionReconstructionTarget(options);
    const profile7HDR10BaseRequested = getDolbyVisionProfile7HDR10BaseColorMetadata(options) !== null;
    const profile8HDR10BaseRequested = getDolbyVisionProfile8HDR10BaseColorMetadata(options) !== null;
    const profile8HLGBaseRequested = getDolbyVisionProfile8HLGBaseColorMetadata(options) !== null;
    const dolbyVisionBaseRequested = profile7HDR10BaseRequested || profile8HDR10BaseRequested || profile8HLGBaseRequested;
    if (!rawHDRRequested && !dolbyVisionRequested) {
        return createSDRPresentationOptions(authorizedRawSDRRouteKeys, presenter.getAuthorizedExternalHDRRouteKeys());
    }

    const hdrToneMappingEnabled = await request.isHDRToneMappingEnabled();
    if (!request.isCurrent()) {
        return null;
    }
    if (!hdrToneMappingEnabled) {
        return createSDRPresentationOptions(authorizedRawSDRRouteKeys, []);
    }
    // A single-layer RPU route is selected before the declared base it shares a raw capability with, so once that route is authorized no raw HDR key can change the selection
    const singleLayerReconstructionAuthorized =
        getRawDolbyVisionRouteFlags(presenter, input.dolbyVisionDescriptor, reconstructionTarget).allowDolbyVision === true;
    await Promise.all([
        waitForRawOnlyHDRAuthorization(presenter, options, rawHDRRequested && !singleLayerReconstructionAuthorized),
        waitForDolbyVisionReconstructionAuthorization(presenter, reconstructionTarget)
    ]);
    if (!request.isCurrent()) {
        return null;
    }
    const { authorizedExternalHDRRouteKeys, authorizedRawHDRRouteKeys } = prepareCustomPresentationAuthorizations(
        presenter,
        rawHDRRequested,
        dolbyVisionRequested,
        dolbyVisionBaseRequested,
        reconstructionTarget
    );
    return {
        ...getRawDolbyVisionRouteFlags(presenter, input.dolbyVisionDescriptor, reconstructionTarget),
        // A GPU decoder's vector stands in for authorization, so its static HDR needs only the host's tone mapping; its RPU reconstruction takes the RPU route's flags above
        allowFramePoolHDR: rawHDRRequested,
        allowNativeDolbyVision: dolbyVisionRequested && presenter.isExternalDolbyVisionPresentationAuthorized(),
        allowNativeDolbyVisionProfile7HDR10Base: profile7HDR10BaseRequested
            && hasAuthorizedDolbyVisionBaseRoute(DOLBY_VISION_HDR10_BASE_COLOR_METADATA, authorizedExternalHDRRouteKeys),
        allowNativeDolbyVisionProfile8HDR10Base: profile8HDR10BaseRequested
            && hasAuthorizedDolbyVisionBaseRoute(DOLBY_VISION_HDR10_BASE_COLOR_METADATA, authorizedExternalHDRRouteKeys),
        allowNativeDolbyVisionProfile8HLGBase: profile8HLGBaseRequested
            && hasAuthorizedDolbyVisionBaseRoute(DOLBY_VISION_HLG_BASE_COLOR_METADATA, authorizedExternalHDRRouteKeys),
        allowNativeHDR: (rawHDRRequested || dolbyVisionBaseRequested) && authorizedExternalHDRRouteKeys.length > 0,
        allowRawHDR: rawHDRRequested && authorizedRawHDRRouteKeys.length > 0,
        allowRawSDR: authorizedRawSDRRouteKeys.length > 0,
        authorizedExternalHDRRouteKeys,
        // A declared 10-bit SDR base presents through the raw SDR keys whatever the HDR request
        authorizedRawHDRRouteKeys: [
            ...authorizedRawSDRRouteKeys,
            ...authorizedRawHDRRouteKeys
        ]
    };
}

/** Returns the base color an exact native Profile 7 or 8 base declares, or null. */
function getNativeDolbyVisionBaseColorMetadata(options: unknown): InputColorMetadata | null {
    return getDolbyVisionProfile7HDR10BaseColorMetadata(options)
        ?? getDolbyVisionProfile8HDR10BaseColorMetadata(options)
        ?? getDolbyVisionProfile8HLGBaseColorMetadata(options);
}

/** Returns whether the eligibility presents an exact native Profile 7 or 8 base through external HDR, with its color metadata neutralized. */
function isNativeDolbyVisionBasePresentation(options: unknown, input: PresentationInput, eligibility: CustomPlaybackEligibility | null): boolean {
    const descriptor = input.dolbyVisionDescriptor;
    const colorMetadata = getNativeDolbyVisionBaseColorMetadata(options);
    return descriptor !== null
        && (
            isDolbyVisionProfile7HDR10BaseLayerDescriptor(descriptor)
            || isDolbyVisionProfile8HDR10BaseLayerDescriptor(descriptor)
            || isDolbyVisionProfile8HLGBaseLayerDescriptor(descriptor)
        )
        && colorMetadata !== null
        && eligibility?.eligible === true
        && eligibility.dolbyVisionProfile === null
        && eligibility.nativeHDRTransfer === colorMetadata.transfer
        && eligibility.neutralizeHDRColorMetadata;
}

/** Returns the base-layer color a Dolby Vision playback presents without its RPU, or null. */
function getActiveDolbyVisionBaseColorMetadata(options: unknown, input: PresentationInput, eligibility: CustomPlaybackEligibility | null): InputColorMetadata | null {
    if (input.dolbyVisionDescriptor === null || eligibility?.eligible !== true || eligibility.dolbyVisionProfile !== null) {
        return null;
    }
    return isNativeDolbyVisionBasePresentation(options, input, eligibility) ?
        getNativeDolbyVisionBaseColorMetadata(options) :
        input.dolbyVisionBaseColorMetadata;
}

function configureDolbyVisionColorPipeline(
    presenter: ColorPipelinePresenter,
    request: ColorPipelineRequest,
    dolbyVisionProfile: Exclude<CustomDecodeDolbyVisionProfile, null>
): Promise<boolean> {
    const { generation, rawVideoFrameFormat, videoOutputMode } = request;
    if (dolbyVisionProfile === DOLBY_VISION_PROFILE_5 && videoOutputMode === 'video-frame' && rawVideoFrameFormat === null) {
        return presenter.configureColorPipeline({
            ...request.createHDRRenderConfiguration(DOLBY_VISION_INPUT_PEAK_NITS),
            inputMode: 'external-dolby-vision',
            profile: DOLBY_VISION_PROFILE_5
        }, generation);
    }
    // A GPU decoder package's BL reconstructs from its frame pool
    if (videoOutputMode === 'frame-pool' && rawVideoFrameFormat !== null && isGPUDecoderOutputFormat(rawVideoFrameFormat)) {
        return presenter.configureColorPipeline({
            ...request.createHDRRenderConfiguration(DOLBY_VISION_INPUT_PEAK_NITS),
            format: rawVideoFrameFormat,
            inputMode: 'frame-pool-dolby-vision',
            profile: dolbyVisionProfile
        }, generation);
    }
    if (videoOutputMode !== 'raw-planes' || rawVideoFrameFormat === null || !isRawDolbyVisionVideoFrameFormat(rawVideoFrameFormat)) {
        return Promise.resolve(false);
    }
    return presenter.configureColorPipeline({
        ...request.createHDRRenderConfiguration(DOLBY_VISION_INPUT_PEAK_NITS),
        inputMode: 'raw-dolby-vision',
        profile: dolbyVisionProfile,
        rawFrameFormat: rawVideoFrameFormat
    }, generation);
}

/** Presents a GPU decoder's frame pool in its output format: SDR as decoded, HDR through the host's render configuration. */
function configureFramePoolColorPipeline(
    presenter: ColorPipelinePresenter,
    request: ColorPipelineRequest,
    metadata: InputColorMetadata
): Promise<boolean> {
    const format = request.rawVideoFrameFormat;
    if (format === null || !isGPUDecoderOutputFormat(format) || getRawFormatBitDepth(format) !== metadata.bitDepth) {
        return Promise.resolve(false);
    }
    if (metadata.transfer === 'sdr') {
        request.clearDetectedInputPeak();
        return presenter.configureColorPipeline({ format, inputMode: 'frame-pool', metadata, settings: createDefaultRenderSettings() }, request.generation);
    }
    return presenter.configureColorPipeline({
        ...request.createHDRRenderConfiguration(metadata.nominalPeakNits),
        format,
        inputMode: 'frame-pool',
        metadata
    }, request.generation);
}

function configureColorMetadataPipeline(
    presenter: ColorPipelinePresenter,
    request: ColorPipelineRequest,
    metadata: InputColorMetadata | null
): Promise<boolean> {
    const { generation, rawVideoFrameFormat, videoOutputMode } = request;
    if (!metadata) {
        return Promise.resolve(false);
    }
    if (videoOutputMode === 'frame-pool') {
        return configureFramePoolColorPipeline(presenter, request, metadata);
    }
    if (metadata.transfer === 'sdr') {
        request.clearDetectedInputPeak();
        if (videoOutputMode === 'video-frame' && rawVideoFrameFormat === null) {
            return presenter.configureColorPipeline({ metadata, settings: createDefaultRenderSettings() }, generation);
        }
        if (videoOutputMode !== 'raw-planes' || rawVideoFrameFormat === null) {
            return Promise.resolve(false);
        }
    }

    if (videoOutputMode === 'video-frame' && rawVideoFrameFormat === null) {
        return presenter.configureColorPipeline({
            ...request.createHDRRenderConfiguration(metadata.nominalPeakNits),
            inputMode: 'external-hdr',
            metadata
        }, generation);
    }

    if (videoOutputMode !== 'raw-planes' || rawVideoFrameFormat === null) {
        return Promise.resolve(false);
    }
    if (getRawFormatBitDepth(rawVideoFrameFormat) !== metadata.bitDepth) {
        return Promise.resolve(false);
    }

    if (metadata.transfer === 'sdr') {
        return presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: rawVideoFrameFormat,
            settings: createDefaultRenderSettings()
        }, generation);
    }

    return presenter.configureColorPipeline({
        ...request.createHDRRenderConfiguration(metadata.nominalPeakNits),
        inputMode: 'raw-yuv',
        metadata,
        rawFrameFormat: rawVideoFrameFormat
    }, generation);
}

/**
 * Presents a Dolby Vision base layer without its RPU: the exact native Profile 7 and 8 bases through external HDR, and any other declared base through the ordinary route the eligibility selected.
 */
function configureDolbyVisionBaseColorPipeline(
    presenter: ColorPipelinePresenter,
    request: ColorPipelineRequest,
    descriptor: DolbyVisionPresentationDescriptor
): Promise<boolean> {
    const { eligibility, generation, input, options, rawVideoFrameFormat, videoOutputMode } = request;
    if (isNativeDolbyVisionBasePresentation(options, input, eligibility)) {
        const colorMetadata = getNativeDolbyVisionBaseColorMetadata(options);
        const descriptorSupported =
            isDolbyVisionProfile7HDR10BaseLayerDescriptor(descriptor)
            || isDolbyVisionProfile8HDR10BaseLayerDescriptor(descriptor)
            || isDolbyVisionProfile8HLGBaseLayerDescriptor(descriptor);
        if (!descriptorSupported || colorMetadata === null || videoOutputMode !== 'video-frame' || rawVideoFrameFormat !== null) {
            return Promise.resolve(false);
        }
        return presenter.configureColorPipeline({
            ...request.createHDRRenderConfiguration(colorMetadata.nominalPeakNits),
            inputMode: 'external-hdr',
            metadata: colorMetadata
        }, generation);
    }
    return configureColorMetadataPipeline(presenter, request, input.dolbyVisionBaseColorMetadata);
}

/**
 * Configures the presenter's color pipeline for a route: Dolby Vision reconstruction, a Dolby Vision base layer, external HDR, raw YUV, or SDR.
 * Every route's configuration carries the stream's declared fields, so an interlaced stream's plan deinterlaces from its first frame.
 * Resolves false when the route cannot present the stream's input.
 */
export function configurePresentationColorPipeline(presenter: WebGPUPresenter, request: ColorPipelineRequest): Promise<boolean> {
    const videoFields = getPresentationVideoFields(request.options);
    const fieldsPresenter: ColorPipelinePresenter = {
        configureColorPipeline: (configuration: PresentationColorPipelineConfiguration, generation: number): Promise<boolean> => (
            presenter.configureColorPipeline({ ...configuration, videoFields }, generation)
        )
    };
    const descriptor = request.input.dolbyVisionDescriptor;
    if (!descriptor) {
        return configureColorMetadataPipeline(fieldsPresenter, request, request.input.colorMetadata);
    }
    if (request.dolbyVisionProfile === null) {
        return configureDolbyVisionBaseColorPipeline(fieldsPresenter, request, descriptor);
    }
    if (descriptor.reconstructionProfile !== request.dolbyVisionProfile) {
        return Promise.resolve(false);
    }
    return configureDolbyVisionColorPipeline(fieldsPresenter, request, request.dolbyVisionProfile);
}

/**
 * Returns the GPU decoders a playback of the options' video may choose on the presenter's device, the eligibility's gpuVideoDecoders option.
 * Only the packages that decode the stream's codec into its output format are offered, in the order the host lists them, so a host lists the ones it prefers first.
 * Nothing is verified here: a host that wants a package checked on the device calls verifyGPUDecoderPackage before it lists the package.
 * None when the stream has no GPU decode target or the device allows no frame pool.
 */
export async function getGPUVideoDecoderOffers(
    presenter: WebGPUPresenter,
    packages: readonly VideoDecoderPackage[],
    options: unknown
): Promise<readonly GPUVideoDecoderOffer[]> {
    const target = getGPUVideoDecodeTarget(options);
    if (target === null) {
        return [];
    }
    const candidates = packages.filter((decoderPackage: VideoDecoderPackage): boolean => decoderPackage.manifest.accepts.codecs.includes(target.codec)
        && decoderPackage.manifest.outputFormats.includes(target.format));
    if (candidates.length === 0) {
        return [];
    }
    // The device's largest whole storage binding bounds the frame pool and each of the decoder's buffers alike
    const maximumBufferByteLength = await presenter.getGPUFramePoolByteLimit();
    if (maximumBufferByteLength === null) {
        return [];
    }
    return candidates.map((decoderPackage: VideoDecoderPackage): GPUVideoDecoderOffer => createGPUVideoDecoderOffer(decoderPackage, target.format, maximumBufferByteLength));
}

/** How the GPU decode sessions of a factory submit their decode work. */
export type GPUVideoDecodeSessionFactoryOptions = Readonly<{
    /** Whether a large picture's decode work submits in slices, between which presentation's submits run, rather than whole */
    slicing: boolean
}>;

/**
 * Returns the factory a controller's frame-pool route creates its GPU decode sessions with: the selected package's decoder for the stream's format, compiled on the presenter's device.
 * The device keeps the compiled decoder under the package's id and output format, so a later session of the same package version and format compiles nothing.
 * A session takes the largest picture the decoder's parser declared, rounded up to whole coding blocks, when the decoder fits it on the device, and the container's size otherwise.
 */
export function createGPUVideoDecodeSessionFactory(presenter: WebGPUPresenter, options: GPUVideoDecodeSessionFactoryOptions): GPUVideoDecodeSessionFactory {
    return async (request: GPUVideoDecodeSessionRequest): Promise<GPUVideoDecodeHandle> => {
        const manifest = request.decoder.package.manifest;
        const device = await presenter.getGPUVideoDecodeDevice();
        if (!device) {
            throw new GPUVideoDecodeError({ code: 'device-unavailable', detail: 'the presenter has no device' });
        }
        const stream = selectGPUDecodeSessionStream(
            manifest,
            request.format,
            request.stream,
            request.maximumPictureSize,
            getGPUFramePoolByteLimit(device.limits),
            request.fallbackPictureSize ?? null
        );
        const session = await GPUVideoDecodeSession.create({
            codecPrivate: request.codecPrivate,
            decoderPackage: request.decoder.package,
            device,
            format: request.format,
            manifest,
            slicing: options.slicing,
            stream
        });
        return {
            describeDecoderError: (errorWord: number): string => describeGPUDecoderErrorWord(manifest.errors, errorWord),
            device,
            session
        };
    };
}

/**
 * Returns the render settings a stream's static HDR luminance metadata asks for, or null when they change nothing.
 * Only PQ input tone-maps from it, and only while the input peak follows the detected one.
 */
export function getStaticHDRRenderSettings(request: StaticHDRRenderSettingsRequest): HDRToSDRRenderSettings | null {
    const { currentSettings, eligibility, input, metadata, options } = request;
    const dolbyVisionBaseColorMetadata = getActiveDolbyVisionBaseColorMetadata(options, input, eligibility);
    if (input.colorMetadata?.transfer !== 'pq' && dolbyVisionBaseColorMetadata?.transfer !== 'pq') {
        return null;
    }
    const inputPeakNits = getStaticHDRToneMappingPeakNits(metadata);
    if (inputPeakNits === null) {
        return null;
    }
    const configuration = request.createHDRRenderConfiguration(inputPeakNits);
    if (!configuration.automaticInputPeakNits) {
        return null;
    }
    if (currentSettings.mode !== 'hdr-to-sdr' || currentSettings.toneMapping.inputPeakNits === configuration.settings.toneMapping.inputPeakNits) {
        return null;
    }
    return configuration.settings;
}
