// The WebGPU values the presentation pipeline shares: canvas configuration, texture formats, features, and default limits.
// Modules import these instead of restating the strings and numbers.

/** Every canvas presents in sRGB; an HDR canvas takes extended-range sRGB values, where 1.0 is SDR white. */
export const CANVAS_COLOR_SPACE: PredefinedColorSpace = 'srgb';

/** Presentation canvases are opaque, so the compositor never blends video with the page. */
export const CANVAS_ALPHA_MODE: GPUCanvasAlphaMode = 'opaque';

/** An SDR canvas clamps to the standard range. */
export const SDR_TONE_MAPPING_MODE: GPUCanvasToneMappingMode = 'standard';

/** An HDR canvas passes values above 1.0 to the display. */
export const HDR_TONE_MAPPING_MODE: GPUCanvasToneMappingMode = 'extended';

/** The canvas format of HDR output, the one that carries extended-range values. */
export const HDR_CANVAS_FORMAT: GPUTextureFormat = 'rgba16float';

/** The color space frames import in: the browser's plain conversion, which the fixed signal step inverts where it must. */
export const EXTERNAL_TEXTURE_COLOR_SPACE: PredefinedColorSpace = 'srgb';

/** The format of intermediates the engine plans, which holds linear light and HDR values without clipping. */
export const INTERMEDIATE_TEXTURE_FORMAT: GPUTextureFormat = 'rgba16float';

/** The device feature that makes 32-bit float textures filterable. */
export const FLOAT32_FILTERABLE_FEATURE: GPUFeatureName = 'float32-filterable';

/** The 32-bit float formats, which filter only with FLOAT32_FILTERABLE_FEATURE. */
export const FLOAT32_TEXTURE_FORMATS: ReadonlySet<GPUTextureFormat> = new Set<GPUTextureFormat>([ 'r32float', 'rg32float', 'rgba32float' ]);

/** The formats a fragment pass may render a user pass's output in. */
export const RENDER_OUTPUT_FORMATS: readonly GPUTextureFormat[] = [
    'rgba16float',
    'rg16float',
    'r16float',
    'rgba32float',
    'r32float',
    'rgb10a2unorm',
    'rgba8unorm'
];

/** The core WebGPU storage formats among the output formats, the only ones a compute pass can write. */
export const STORAGE_OUTPUT_FORMATS: readonly GPUTextureFormat[] = [ 'rgba16float', 'rgba32float', 'r32float', 'rgba8unorm' ];

/** The canvas formats authorization renders into and reads back. */
export const READBACK_CANVAS_FORMATS: readonly GPUTextureFormat[] = [ 'bgra8unorm', 'rgba8unorm' ];

/** WebGPU's default maxComputeWorkgroupSizeX, Y, and Z. */
export const MAXIMUM_WORKGROUP_SIZE: readonly [number, number, number] = [ 256, 256, 64 ];

/** WebGPU's default maxComputeInvocationsPerWorkgroup. */
export const MAXIMUM_WORKGROUP_INVOCATIONS = 256;

/** WebGPU's default maxComputeWorkgroupsPerDimension. */
export const MAXIMUM_WORKGROUP_COUNT = 65_535;
