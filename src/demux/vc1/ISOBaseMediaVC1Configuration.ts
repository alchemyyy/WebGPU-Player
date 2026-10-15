import type { InputVideoTrack } from 'mediabunny';

import { readISOBaseMediaSampleEntryChildBox } from '../ISOBaseMediaSampleEntryChildBox';
import type { VC1DecoderDescriptionResult } from './MatroskaVFWVideoConfiguration';

/** The sample entry type of a VC-1 track, as SMPTE RP 2025 binds VC-1 to ISO base media files, which Mediabunny reports as its codec ID. */
export const ISO_BASE_MEDIA_VC1_SAMPLE_ENTRY = 'vc-1';

const VC1_SAMPLE_ENTRIES: readonly string[] = Object.freeze([ ISO_BASE_MEDIA_VC1_SAMPLE_ENTRY ]);
const VC1_CONFIGURATION_BOX = 'dvc1';
// VC1DecSpecStruc: the profile in the high 4 bits of its first byte, then 6 bytes of level, flags, and frame rate, then the sequence header and entry point
const DVC1_HEADER_BYTE_LENGTH = 7;
const DVC1_PROFILE_SHIFT = 4;
// The Advanced profile, the only one whose configuration carries a sequence header that FFmpeg reads
const DVC1_ADVANCED_PROFILE = 12;

function fail(failure: string): Readonly<{ failure: string, status: 'failed' }> {
    return { failure, status: 'failed' };
}

/**
 * Reads the extradata FFmpeg's vc1 decoder gets from an ISO base media track of its first sample entry, a vc-1 entry: the dvc1 box's sequence header and entry point after its 7-byte VC1DecSpecStruc.
 * Mediabunny 1.52.2 reads a VC-1 track's samples but skips its dvc1 box, which `readISOBaseMediaSampleEntryChildBox` reads from the moov bytes Mediabunny keeps.
 * As FFmpeg does, only the Advanced profile's dvc1 is read.
 */
export function readISOBaseMediaVC1DecoderDescription(track: InputVideoTrack): VC1DecoderDescriptionResult {
    const configuration = readISOBaseMediaSampleEntryChildBox(track, VC1_SAMPLE_ENTRIES, VC1_CONFIGURATION_BOX);
    switch (configuration.status) {
        case 'failed':
            return configuration;
        case 'missing':
            return fail(`${VC1_CONFIGURATION_BOX}-missing`);
        case 'read':
            break;
    }
    const payload = configuration.payload;
    if (payload.byteLength <= DVC1_HEADER_BYTE_LENGTH) {
        return fail(`dvc1-size: ${payload.byteLength}`);
    }
    const profile = payload[0] >> DVC1_PROFILE_SHIFT;
    if (profile !== DVC1_ADVANCED_PROFILE) {
        return fail(`dvc1-profile: ${profile}`);
    }
    return { description: payload.slice(DVC1_HEADER_BYTE_LENGTH), status: 'read' };
}
