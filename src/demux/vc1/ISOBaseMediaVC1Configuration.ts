import type { InputVideoTrack } from 'mediabunny';

import type { VC1DecoderDescriptionResult } from './MatroskaVFWVideoConfiguration';

/** The sample entry type of a VC-1 track, as SMPTE RP 2025 binds VC-1 to ISO base media files, which Mediabunny reports as its codec ID. */
export const ISO_BASE_MEDIA_VC1_SAMPLE_ENTRY = 'vc-1';

function copyDescription(description: AllowSharedBufferSource): Uint8Array {
    return ArrayBuffer.isView(description) ?
        new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice() :
        new Uint8Array(description).slice();
}

/**
 * Reads the extradata FFmpeg's vc1 decoder gets from an ISO base media track of a vc-1 sample entry: the dvc1 box's sequence header and entry point after its 7-byte VC1DecSpecStruc.
 * The Mediabunny fork hands them on as the track's description, and, as FFmpeg, only for the Advanced profile, so a track without one fails as `dvc1-missing`.
 */
export async function readISOBaseMediaVC1DecoderDescription(track: InputVideoTrack): Promise<VC1DecoderDescriptionResult> {
    const description = (await track.getDecoderConfig())?.description;
    if (description === undefined) {
        return { failure: 'dvc1-missing', status: 'failed' };
    }
    if (description.byteLength === 0) {
        return { failure: 'dvc1-size: 0', status: 'failed' };
    }
    return { description: copyDescription(description), status: 'read' };
}
