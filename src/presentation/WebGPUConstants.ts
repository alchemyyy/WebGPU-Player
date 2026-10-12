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

/** The integer formats raw planes upload into: one or two 8-bit or 16-bit components per texel, read with textureLoad. */
export const PLANE_R8_FORMAT: GPUTextureFormat = 'r8uint';
export const PLANE_RG8_FORMAT: GPUTextureFormat = 'rg8uint';
export const PLANE_R16_FORMAT: GPUTextureFormat = 'r16uint';
export const PLANE_RG16_FORMAT: GPUTextureFormat = 'rg16uint';

/** The canvas formats authorization renders into and reads back. */
export const READBACK_CANVAS_FORMATS: readonly GPUTextureFormat[] = [ 'bgra8unorm', 'rgba8unorm' ];

/** WebGPU's default maxComputeWorkgroupSizeX, Y, and Z. */
export const MAXIMUM_WORKGROUP_SIZE: readonly [number, number, number] = [ 256, 256, 64 ];

/** WebGPU's default maxComputeInvocationsPerWorkgroup. */
export const MAXIMUM_WORKGROUP_INVOCATIONS = 256;

/** WebGPU's default maxComputeWorkgroupsPerDimension. */
export const MAXIMUM_WORKGROUP_COUNT = 65_535;

/** The workgroup axes in dispatch order, which name an axis in a failure detail. */
export const WORKGROUP_AXIS_NAMES: readonly string[] = Object.freeze([ 'x', 'y', 'z' ]);

/** The bytes of a WGSL 32-bit scalar; buffer copies, clears, and writes take sizes and offsets in multiples of it. */
export const BYTES_PER_WORD = 4;

/** The values a WGSL u32 holds: u32 arithmetic wraps at it, and a buffer that WGSL addresses in u32 bytes stays within it. */
export const U32_VALUE_COUNT = 2 ** 32;

/** The bytes `dispatchWorkgroupsIndirect` reads: one u32 workgroup count per axis. */
export const INDIRECT_DISPATCH_ARGUMENTS_BYTE_LENGTH = WORKGROUP_AXIS_NAMES.length * BYTES_PER_WORD;

/** WebGPU's default minUniformBufferOffsetAlignment, the coarsest a device may require, so dynamic offsets in its multiples bind on every device. */
export const UNIFORM_BUFFER_OFFSET_ALIGNMENT = 256;

/** WebGPU's default minStorageBufferOffsetAlignment, the coarsest a device may require. */
export const STORAGE_BUFFER_OFFSET_ALIGNMENT = 256;

/** The bytesPerRow alignment of copies between buffers and textures. */
export const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

/** WebGPU's default maxStorageBufferBindingSize, 128 MiB. */
export const MAXIMUM_STORAGE_BUFFER_BINDING_SIZE = 134_217_728;

/** The error scope filter of validation errors, such as invalid WGSL. */
export const VALIDATION_ERROR_FILTER: GPUErrorFilter = 'validation';

/** The error scope filter of allocations the device refuses. */
export const OUT_OF_MEMORY_ERROR_FILTER: GPUErrorFilter = 'out-of-memory';

/** The device feature that enables the WGSL `f16` extension. */
export const SHADER_F16_FEATURE: GPUFeatureName = 'shader-f16';

/** The device feature that enables the WGSL `subgroups` extension. */
export const SUBGROUPS_FEATURE: GPUFeatureName = 'subgroups';

/** The WGSL extension each device feature enables, which a module names in an `enable` directive before using it. */
export const WGSL_FEATURE_EXTENSIONS: ReadonlyMap<string, string> = new Map<string, string>([
    [ SHADER_F16_FEATURE, 'f16' ],
    [ SUBGROUPS_FEATURE, 'subgroups' ]
]);
