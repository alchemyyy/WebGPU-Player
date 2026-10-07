import type { InputVideoTrack } from 'mediabunny';

// The shortest records Mediabunny derives a codec string from: the fixed HVCC header and the AVCC profile bytes
const MINIMUM_HEVC_CONFIGURATION_BYTE_LENGTH = 23;
const MINIMUM_AVC_CONFIGURATION_BYTE_LENGTH = 4;

type DolbyVisionSampleEntryCodec =
    | { avcType: 1 | 3, codec: 'avc' }
    | { codec: 'av1' }
    | { codec: 'hevc' };

type ISOBaseMediaVideoTrackInfo = {
    avcType: 1 | 3 | null
    codec: DolbyVisionSampleEntryCodec['codec'] | null
    codecDescription: Uint8Array | null
    type: 'video'
};

/** Returns the codec Mediabunny assigns to the base sample entry that a Dolby Vision sample entry wraps. */
function getDolbyVisionSampleEntryCodec(sampleEntryType: string): DolbyVisionSampleEntryCodec | null {
    switch (sampleEntryType) {
        case 'dvh1':
        case 'dvhe':
            return { codec: 'hevc' };
        case 'dva1':
            return { avcType: 1, codec: 'avc' };
        case 'dvav':
            return { avcType: 3, codec: 'avc' };
        case 'dav1':
            return { codec: 'av1' };
        default:
            return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function getUnmappedVideoTrackInfo(track: InputVideoTrack): ISOBaseMediaVideoTrackInfo | null {
    // Mediabunny 1.52.2 parses a Dolby Vision sample entry's hvcC, avcC, av1C, and colr children but maps only
    // the base sample entry types to codecs, so contain the write to its internal track info here
    const backing = (track as unknown as { _backing?: unknown })._backing;
    if (!isRecord(backing) || !isRecord(backing.internalTrack)) {
        return null;
    }
    const info = backing.internalTrack.info;
    if (
        !isRecord(info)
        || info.type !== 'video'
        || info.codec !== null
        || info.avcType !== null
        || (info.codecDescription !== null && !(info.codecDescription instanceof Uint8Array))
    ) {
        return null;
    }
    return info as unknown as ISOBaseMediaVideoTrackInfo;
}

function hasRequiredCodecDescription(
    trackInfo: ISOBaseMediaVideoTrackInfo,
    sampleEntryCodec: DolbyVisionSampleEntryCodec
): boolean {
    const descriptionByteLength = trackInfo.codecDescription?.byteLength ?? 0;
    switch (sampleEntryCodec.codec) {
        case 'avc':
            return descriptionByteLength >= MINIMUM_AVC_CONFIGURATION_BYTE_LENGTH;
        case 'hevc':
            return descriptionByteLength >= MINIMUM_HEVC_CONFIGURATION_BYTE_LENGTH;
        case 'av1':
            // Without av1C, Mediabunny reads the sequence header from the first packet
            return true;
    }
}

/**
 * Assigns the codec Mediabunny assigns to the matching base sample entry when a track uses a Dolby Vision
 * sample entry: dvh1 and dvhe read as HEVC, dva1 and dvav as AVC (avc1 and avc3), and dav1 as AV1. Any other
 * track, or one whose internal shape or decoder configuration record does not match, is left unchanged. Call
 * it before the track's first getDecoderConfig(), whose result Mediabunny caches. Returns whether the codec
 * was assigned.
 */
export async function assignISOBaseMediaDolbyVisionSampleEntryCodec(
    track: InputVideoTrack
): Promise<boolean> {
    const internalCodecID = await track.getInternalCodecId();
    if (typeof internalCodecID !== 'string') {
        return false;
    }
    // Mediabunny compares sample entry types in lowercase
    const sampleEntryCodec = getDolbyVisionSampleEntryCodec(internalCodecID.toLowerCase());
    if (!sampleEntryCodec) {
        return false;
    }
    const trackInfo = getUnmappedVideoTrackInfo(track);
    if (!trackInfo || !hasRequiredCodecDescription(trackInfo, sampleEntryCodec)) {
        return false;
    }

    if (sampleEntryCodec.codec === 'avc') {
        trackInfo.avcType = sampleEntryCodec.avcType;
    }
    trackInfo.codec = sampleEntryCodec.codec;
    return true;
}
