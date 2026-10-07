/** Dolby Vision profiles whose base layer is composed with a second enhancement layer. */
export const DOLBY_VISION_DUAL_LAYER_PROFILES: ReadonlySet<number> = new Set([ 4, 7 ]);

/** Returns whether a Dolby Vision profile composes a second enhancement layer. */
export function isDolbyVisionDualLayerProfile(profile: number | null): profile is 4 | 7 {
    return profile !== null && DOLBY_VISION_DUAL_LAYER_PROFILES.has(profile);
}
