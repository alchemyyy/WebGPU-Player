import type { InputTrack } from 'mediabunny';

/**
 * Returns the first feature Mediabunny reports it cannot honor while reading a track, or null when it reports none.
 * Mediabunny reports MP4 and MOV edit lists it only partly applies, `multiple_edits` and `non_unit_playback_rate`, and then times the
 * packets as if the rest of the edit list were absent, so such a track would play at the wrong times.
 */
export async function findUnsupportedTrackFeature(track: InputTrack): Promise<string | null> {
    const features = await track.getUnsupportedFeatures();
    return features[0] ?? null;
}
