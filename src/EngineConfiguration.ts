/** Feature switches that the host application owns and the engine reads at runtime. */
export type EngineFeatureFlags = Readonly<{
    /** Resolves whether HDR tone mapping on the WebGPU presentation path is enabled. */
    isHDRToneMappingEnabled: () => Promise<boolean>
}>;

const DEFAULT_FEATURE_FLAGS: EngineFeatureFlags = {
    isHDRToneMappingEnabled: () => Promise.resolve(true)
};

let featureFlags: EngineFeatureFlags = DEFAULT_FEATURE_FLAGS;

/** Replaces the host feature switches; call before the first presenter is created. */
export function configureEngineFeatureFlags(flags: EngineFeatureFlags): void {
    featureFlags = flags;
}

/** Resolves whether HDR tone mapping is enabled, failing closed if the host lookup fails. */
export function isHDRToneMappingEnabled(): Promise<boolean> {
    return featureFlags.isHDRToneMappingEnabled().catch(() => false);
}
