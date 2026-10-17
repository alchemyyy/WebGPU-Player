"""Tests the mpv user shader converter: its parsing of libplacebo's format, its expressions and hook mapping, its GLSL rewrites, and whole conversions through naga."""

from __future__ import annotations

import base64
import shutil
import struct
import subprocess
import sys
import unittest
from pathlib import Path


TOOLS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS_DIRECTORY))

import convert_mpv_shader as converter  # noqa: E402
from constants import PASSES_DIRECTORY  # noqa: E402


def find_pinned_naga() -> str | None:
    """Returns naga when the pinned version is installed, which the conversion tests need."""
    path = shutil.which(converter.NAGA_EXECUTABLE)
    if path is None:
        return None
    version = subprocess.run([path, '--version'], capture_output=True, text=True, check=False).stdout.strip()
    return path if version == converter.NAGA_VERSION else None


NAGA = find_pinned_naga()
NAGA_MISSING_REASON = f'naga {converter.NAGA_VERSION} is not installed: {converter.NAGA_INSTALL_COMMAND}'
SOURCE_NAME = 'test.glsl'
DEFAULT_NAME = 'test'

# Headers that libplacebo strips before matching, and a body that ends at the next //!, wherever it is
INDENTED_HEADER_SHADER = '// comment before the first header\n  //!HOOK MAIN\n//!BIND HOOKED\nvec4 hook() { return HOOKED_tex(HOOKED_pos); } //!HOOK OUTPUT\n//!BIND HOOKED\nvec4 hook() { return HOOKED_texOff(0); }\n'
FIRST_HEADER_LINE = 2
SECOND_PASS_HOOK = 'OUTPUT'

UPSCALE_CONDITION = 'OUTPUT.w HOOKED.w 1.200 * >'
UPSCALE_CONDITION_RENDERED = '(OUTPUT.width > (HOOKED.width * 1.2))'
EQUALITY_EXPRESSION = 'HOOKED.w OUTPUT.w = !'
EQUALITY_RENDERED = '!((abs(HOOKED.width - OUTPUT.width) <= 0.000001 * max(HOOKED.width, OUTPUT.width)))'
MODULO_EXPRESSION = 'HOOKED.w 2 * 3 %'
MODULO_WGSL = '((size.x * 2.0) % 3.0)'
UNDERFLOW_EXPRESSION = 'HOOKED.w *'
LEFTOVER_EXPRESSION = 'HOOKED.w HOOKED.h'

FLOAT_PARAMETER_SHADER = '//!PARAM strength\n//!DESC Sharpening strength\n//!TYPE float\n//!MINIMUM 0.0\n//!MAXIMUM 2.0\n0.5\n'
UNBOUNDED_PARAMETER_SHADER = '//!PARAM offset\n//!TYPE DYNAMIC float\n0.25\n'
ENUM_PARAMETER_SHADER = '//!PARAM mode\n//!TYPE ENUM int\nSOFT\nHARD\nEXTREME\n'
DEFINE_PARAMETER_SHADER = '//!PARAM taps\n//!TYPE DEFINE\n//!MINIMUM 0\n//!MAXIMUM 5\n2\n'
OUT_OF_BOUNDS_PARAMETER_SHADER = '//!PARAM strength\n//!TYPE float\n//!MINIMUM 0.0\n//!MAXIMUM 1.0\n2.0\n'
ENUM_LABELS = ['SOFT', 'HARD', 'EXTREME']
DEFINE_DEFAULT = 2

# One texel each: an mpv rgba16f texture holds 32-bit floats, a libplacebo rgba16hf one holds halves
FLOAT_TEXTURE_SHADER = '//!TEXTURE weights\n//!SIZE 1 1\n//!FORMAT rgba16f\n0000803f000000400000404000008040\n'
HALF_TEXTURE_SHADER = '//!TEXTURE weights\n//!SIZE 1 1\n//!FORMAT rgba16hf\n003c004000420044\n'
SHORT_TEXTURE_SHADER = '//!TEXTURE weights\n//!SIZE 2 1\n//!FORMAT rgba32f\n0000803f000000400000404000008040\n'
STORAGE_TEXTURE_SHADER = '//!TEXTURE state\n//!SIZE 1 1\n//!FORMAT rgba32f\n//!STORAGE\n'
TEXEL_VALUES = (1.0, 2.0, 3.0, 4.0)
# Both hold halves in the pass file, as mpv's GPU texture of either format does
HALF_TEXEL_BYTES = struct.pack('<4e', *TEXEL_VALUES)
# Three 8-bit components take four, alpha opaque, and 16-bit unorm takes 32-bit floats, which the pass file has in their place
RGB8_TEXTURE_SHADER = '//!TEXTURE colors\n//!SIZE 1 1\n//!FORMAT rgb8\n10ff80\n'
RGB8_TEXEL_BYTES = bytes([0x10, 0xFF, 0x80, 0xFF])
R16_TEXTURE_SHADER = '//!TEXTURE table\n//!SIZE 2\n//!FORMAT r16\n0000ffff\n'
R16_TEXEL_BYTES = struct.pack('<2f', 0.0, 1.0)

# A MAIN pass before a LUMA pass in the file runs after it, as mpv's pipeline orders them
OUT_OF_ORDER_SHADER = '//!HOOK MAIN\n//!BIND HOOKED\n//!DESC main pass\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n//!HOOK LUMA\n//!BIND HOOKED\n//!DESC luma pass\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n'
ORDERED_NAMES = ['luma pass', 'main pass']
MULTIPLE_HOOK_SHADER = '//!HOOK LUMA\n//!HOOK RGB\n//!HOOK ALPHA\n//!BIND HOOKED\n//!DESC invert\nvec4 hook() { return vec4(1.0) - HOOKED_texOff(0); }\n'
# mpv fires RGB on RGB sources and LUMA on YUV ones, which the engine's rgb.source fact tells apart
SOURCE_HOOK_CONDITIONS = [('RGB', ['rgb.source']), ('LUMA', ['!rgb.source'])]
LINEAR_SHADER = '//!HOOK LINEAR\n//!BIND HOOKED\n//!DESC linear pass\nvec4 hook() { return linearize(delinearize(HOOKED_tex(HOOKED_pos))); }\n'
LINEAR_NAMES = ['linear pass']
# Linear light in mpv's scale, which the engine's reference white gives, and the source's own transfer function
LINEAR_READ = 'return vec4f(color.rgb / referenceWhiteNits(), color.a);'
LINEAR_WRITE = 'return vec4f(result.rgb * referenceWhiteNits(), result.a);'
LINEARIZE_GLUE = 'return linearize(color);'
# A DEFINE over values 1 to 20, past the variant limit
WIDE_DEFINE_SHADER = '//!PARAM taps\n//!TYPE DEFINE\n//!MINIMUM 1\n//!MAXIMUM 20\n4\n\n//!HOOK MAIN\n//!BIND HOOKED\n//!DESC wide\nvec4 hook() { return HOOKED_tex(HOOKED_pos) * float(taps); }\n'
LONG_DESCRIPTION = 'x' * 80
DUPLICATE_DESCRIPTION_SHADER = '//!HOOK MAIN\n//!BIND HOOKED\n//!DESC same\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n//!HOOK MAIN\n//!BIND HOOKED\n//!DESC same\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n'
DUPLICATE_NAMES = ['same', 'same 2/2']

ARRAY_DECLARATIONS = 'shared float inp[isize.y][isize.x];\nfloat a[2][3], b[4][5];\nvoid f(float p[2][3]) { x = q[1][2]; return float[2][3](float[3](1,2,3), float[3](4,5,6)); }\nfloat c[2];'
ARRAY_DECLARATIONS_REVERSED = 'shared float inp[isize.x][isize.y];\nfloat a[3][2], b[5][4];\nvoid f(float p[3][2]) { x = q[1][2]; return float[3][2](float[3](1,2,3), float[3](4,5,6)); }\nfloat c[2];'
FOR_LOOPS = 'for (int i=2; float(i)<kernel_size; i++) {}\nfor (int j = 0; j < 4; j++) {}'
FOR_LOOPS_WRAPPED = 'for (int i=2; (float(i)<kernel_size); i++) {}\nfor (int j = 0; j < 4; j++) {}'
SAMPLER_CALLS = 'vec4 a = texture(HOOKED_raw, pos) + texelFetch(HOOKED_raw, ivec2(1, 2), 0);\nivec2 s = textureSize(HOOKED_raw, 0);\nimageStore(out_image, ivec2(id), a);\nvec4 u = texture(other, pos);'
SAMPLER_CALLS_REWRITTEN = 'vec4 a = mpv_texture0_sample( pos) + mpv_texture0_fetch( ivec2(1, 2));\nivec2 s = ivec2(mpv_texture0_size());\nmpv_image_store( ivec2(id),  a);\nvec4 u = texture(other, pos);'
SAMPLERS = {'HOOKED_raw': ('mpv_texture0', 2)}
PROJECTED_CALL = 'vec4 a = textureProj(HOOKED_raw, vec3(pos, 1.0));'

NESTED_ARRAY_TYPE = 'array<array<f32, 48>, 72>'
NESTED_ARRAY_BYTES = 48 * 72 * 4
VECTOR_ARRAY_TYPE = 'array<vec3<f32>, 4>'
# A vec3 takes a vec4's stride in an array
VECTOR_ARRAY_BYTES = 4 * 16
STRUCT_TYPE = 'array<Weights, 4>'

MISSING_RETURN_BODY = 'vec4 pick(float n) {\n    for (int i = 0; i < 4; i++) {\n        if (float(i) > n) { return vec4(1.0); }\n    }\n}\n'
MISSING_RETURN_REPAIRED = 'vec4 pick(float n) {\n    for (int i = 0; i < 4; i++) {\n        if (float(i) > n) { return vec4(1.0); }\n    }\nreturn vec4(0); }\n'
TERNARY_CONSTANTS = 'const float slider = 0.25;\nconst float scale = (slider >= 0.0) ? 1.25 : 1.75;\nconst float strength = 0.4 + slider * scale;\nconst float other = 1.0;\nvec4 hook() { return vec4(strength); }'
TERNARY_CONSTANTS_INLINED = 'const float slider = 0.25;\n#define scale ((slider >= 0.0) ? 1.25 : 1.75)\n#define strength (0.4 + slider * scale)\nconst float other = 1.0;\nvec4 hook() { return vec4(strength); }'
TERNARY_LINE = 1
# GLSL 4.20 swizzles scalars, as the Chroma from Luma shaders do; only the failing line is rewritten
SCALAR_SWIZZLES = 'float start = 1.0;\nint count = 2;\nvec2 pos = vec2(0.0);\nfor (float x = start.x; x <= pos.x + vec2(count.xx).y; x++) {}'
SCALAR_SWIZZLES_EXPANDED = 'float start = 1.0;\nint count = 2;\nvec2 pos = vec2(0.0);\nfor (float x = start; x <= pos.x + vec2(ivec2(count)).y; x++) {}'
SCALAR_SWIZZLE_LINE = 3

FRAGMENT_SHADER = '''//!PARAM strength
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 1.0
0.5

//!PARAM mode
//!TYPE ENUM int
SOFT
HARD

//!PARAM taps
//!TYPE DEFINE
//!MINIMUM 1
//!MAXIMUM 3
2

//!HOOK MAIN
//!BIND HOOKED
//!DESC fragment features
const float weights[2][3] = { { 0.1, 0.2, 0.3 }, { 0.4, 0.5, 0.6 } };

vec4 hook() {
    vec4 color = texture(HOOKED_raw, HOOKED_pos) * HOOKED_mul;
    for (int i = 0; i < taps; i++) {
        color += weights[1][i] * HOOKED_texOff(vec2(i, 0));
    }
    if (mode == HARD) {
        color *= 2.0;
    }
    float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + float(frame)) * 43758.5453) * random;
    return mix(HOOKED_tex(HOOKED_pos), color, strength) + vec4(grain * 0.0);
}
'''
FRAGMENT_PARAMETER_LINES = ['//! param strength: f32 = 0.5 in [0.0, 1.0]', '//! param mode: i32 = 0 in [0, 1]', '//! param taps: i32 = 2 in [1, 3]']
# The DEFINE taps splits the pass in one per value, which `when` picks
FRAGMENT_NAMES = ['fragment features (taps=1)', 'fragment features (taps=2)', 'fragment features (taps=3)']
FRAGMENT_VARIANT_CONDITION = '//! when: taps == 3'
NESTED_ARRAY_WGSL = 'array<array<f32, 3>, 2>'

LUMA_DOUBLER_SHADER = '''//!HOOK LUMA
//!BIND HOOKED
//!SAVE DETAIL
//!DESC luma detail
vec4 hook() { return HOOKED_texOff(1) - HOOKED_texOff(-1); }

//!HOOK LUMA
//!BIND HOOKED
//!BIND DETAIL
//!WIDTH LUMA.w 2 *
//!HEIGHT LUMA.h 2 *
//!WHEN OUTPUT.w LUMA.w 1.300 * >
//!DESC luma doubler
vec4 hook() { return HOOKED_tex(HOOKED_pos) + 0.1 * DETAIL_tex(DETAIL_pos); }
'''
LUMA_DOUBLER_OUTPUT = '//! output: (HOOKED.width * 2), (HOOKED.height * 2), rgba16float'
LUMA_DOUBLER_CONDITION = '//! when: (output.width > (luma.width * 1.3))'
LUMA_DOUBLER_INPUTS = ['//! input: HOOKED', '//! input: DETAIL']
# A luma pass writes the luma plane itself, which the engine merges with chroma as the signal converts
LUMA_PASS_HEADER_LINES = ['//! hook: LUMA', '//! domain: any']
LUMA_RESULT = 'return result;'

# A chroma upscaler as KrigBilateral's passes are: luma read at chroma's size, then chroma at luma's size, aligned with the reference grid
CHROMA_UPSCALER_SHADER = '''//!HOOK CHROMA
//!BIND LUMA
//!BIND HOOKED
//!SAVE LOWRES_Y
//!WIDTH LUMA.w
//!WHEN CHROMA.w LUMA.w <
//!DESC chroma downscale
vec4 hook() { return LUMA_tex(LUMA_pos); }

//!HOOK CHROMA
//!BIND HOOKED
//!BIND LUMA
//!BIND LOWRES_Y
//!WIDTH LUMA.w
//!HEIGHT LUMA.h
//!WHEN CHROMA.w LUMA.w <
//!OFFSET ALIGN
//!DESC chroma upscale
vec4 hook() {
    vec2 pos = CHROMA_pos * HOOKED_size - vec2(0.5) + HOOKED_off * 0.0;
    return CHROMA_tex(CHROMA_pt * (round(pos) + vec2(0.5))) * LUMA_texOff(0).x + LOWRES_Y_tex(LOWRES_Y_pos);
}
'''
CHROMA_DOWNSCALE_LINES = ['//! hook: CHROMA', '//! save: LOWRES_Y', '//! output: LUMA.width, HOOKED.height, rgba16float',
                          '//! when: (chroma.width < luma.width)']
CHROMA_UPSCALE_LINES = ['//! output: LUMA.width, LUMA.height, rgba16float', '//! offset: align', '//! when: (chroma.width < luma.width)']
ALIGNED_POSITION_ASSIGNMENT = 'mpv_aligned_position = coordinate + HOOKED_offset() * HOOKED_pt();'
HOOKED_OFFSET_GLUE = 'return HOOKED_offset();'

OFFSET_SHADER = '''//!HOOK LUMA
//!BIND HOOKED
//!WIDTH HOOKED.w 2 *
//!OFFSET -0.500000 0.000000
//!DESC offset doubler
vec4 hook() { return HOOKED_tex(HOOKED_pos); }

//!HOOK POSTKERNEL
//!BIND HOOKED
//!OFFSET 0.5 0.5
//!DESC scaled offset
vec4 hook() { return HOOKED_tex(HOOKED_pos); }
'''
OFFSET_LINE = '//! offset: -0.5, 0'
SCALED_OFFSET_DETAIL = 'scaled offset: OFFSET 0.5 0.5 at POSTKERNEL'

# A condition that reads chroma's size and a parameter, both of which `when` reads
CHROMA_FACT_CONDITION_SHADER = '''//!PARAM strength
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 1.0
0.5

//!HOOK LUMA
//!BIND HOOKED
//!WHEN CHROMA.w LUMA.w < strength *
//!DESC chroma aware
vec4 hook() { return HOOKED_tex(HOOKED_pos) * strength; }
'''
CHROMA_FACT_CONDITION = '//! when: ((chroma.width < luma.width) * strength)'
STRENGTH_PARAMETER_LINE = '//! param strength: f32 = 0.5 in [0.0, 1.0]'

# libplacebo's own example: a 41x41 average over shared memory, at 32x32 threads, then at 16x16
COMPUTE_TEMPLATE = '''//!HOOK LUMA
//!BIND HOOKED
//!COMPUTE {size} {size}
//!DESC avg convolution

const ivec2 ksize = ivec2(9, 9);
const ivec2 offset = ksize / 2;
const ivec2 isize = ivec2(gl_WorkGroupSize) + ksize - 1;
shared float inp[isize.y][isize.x];

void hook()
{{
    ivec2 base = ivec2(gl_WorkGroupID) * ivec2(gl_WorkGroupSize);
    for (uint y = gl_LocalInvocationID.y; y < isize.y; y += gl_WorkGroupSize.y) {{
        for (uint x = gl_LocalInvocationID.x; x < isize.x; x += gl_WorkGroupSize.x)
            inp[y][x] = texelFetch(HOOKED_raw, base + ivec2(x,y) - offset, 0).x;
    }}
    barrier();
    float sum;
    for (uint y = 0; y < ksize.y; y++) {{
        for (uint x = 0; x < ksize.x; x++)
            sum += inp[gl_LocalInvocationID.y+y][gl_LocalInvocationID.x+x];
    }}
    vec4 color = vec4(HOOKED_mul * sum / (ksize.x * ksize.y), 0, 0, 1);
    imageStore(out_image, ivec2(gl_GlobalInvocationID), color);
}}
'''
OVERSIZED_WORKGROUP = 32
FITTING_WORKGROUP = 16
COMPUTE_HEADER_LINES = ['//! shape: compute', '//! workgroup: 16, 16', '//! dispatch: ceil(round(HOOKED.width) / 16), ceil(round(HOOKED.height) / 16)']

PARAMETER_CONDITION_SHADER = '''//!PARAM intensity
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 1.0
0.1

//!HOOK MAIN
//!BIND HOOKED
//!WHEN intensity 0 >
//!DESC grain
vec4 hook() { return HOOKED_tex(HOOKED_pos) + vec4(intensity * random); }
'''
PARAMETER_CONDITION = '//! when: (intensity > 0)'

# A CONSTANT the code reads in arithmetic, which the engine compiles at its value, and one that sizes an array, which naga folds
CONSTANT_SHADER = '''//!PARAM gain
//!TYPE CONSTANT float
//!MINIMUM 1.0
//!MAXIMUM 4.0
2.0

//!PARAM taps
//!TYPE CONSTANT int
//!MINIMUM 1
//!MAXIMUM 4
2

//!HOOK MAIN
//!BIND HOOKED
//!DESC constants
vec4 hook() {
    float weights[taps];
    weights[0] = gain / 255.0;
    return HOOKED_tex(HOOKED_pos) * weights[0];
}
'''
CONSTANT_LINE = '//! const gain: f32 = 2.0 in [1.0, 4.0]'
FOLDED_TAPS_DETAIL = 'constants: naga folds taps into constant expressions, so it takes its default 2'

# A 2x1 linear table the pass samples, fetches, and sizes
TEXTURE_PASS_SHADER = '''//!TEXTURE weights
//!SIZE 2 1
//!FORMAT rgba16f
//!FILTER LINEAR
//!BORDER REPEAT
0000803f0000004000004040000080400000a0400000c0400000e04000000041

//!HOOK MAIN
//!BIND HOOKED
//!BIND weights
//!DESC table
vec4 hook() {
    vec2 size = vec2(textureSize(weights, 0));
    return HOOKED_tex(HOOKED_pos) * texture(weights, vec2(0.25, 0.5)) + texelFetch(weights, ivec2(1, 0), 0) / size.x;
}
'''
TEXTURE_PASS_LINES = ['//! bind: weights', '//! texture: weights', '//! size: 2, 1', '//! format: rgba16float', '//! filter: linear', '//! edge: repeat']
TEXTURE_ACCESSOR_CALLS = ['return weights_tex(position);', 'return weights_load(texel);', 'return weights_size();']
TEXTURE_BLOCK_DATA = base64.b64encode(struct.pack('<8e', 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0)).decode('ascii')

# CHROMA_SCALED reads chroma through the source's own matrix and range, and joins new chroma back through them
CHROMA_SCALED_SHADER = '''//!HOOK CHROMA_SCALED
//!BIND HOOKED
//!DESC chroma scaled
vec4 hook() { return HOOKED_tex(HOOKED_pos) * 0.5; }
'''
CHROMA_SCALED_CALLS = ['rgbToPlanes(color.rgb).yz', 'planesToRGB(vec3f(rgbToPlanes(base.rgb).x, chroma))']

REPAIRED_SHADER = '''//!HOOK MAIN
//!BIND HOOKED
//!DESC repairs
#define sqr(x) dot(x, x)
const float slider = 0.25;
const float scale = (slider >= 0.0) ? 1.25 : 1.75;
vec4 pick(float n) {
    for (int i = 0; i < 4; i++) {
        if (float(i) > n) { return vec4(1.0); }
    }
}
vec4 hook() {
    float spread = sqr(HOOKED_tex(HOOKED_pos).x - 0.5);
    for (int i = 0; float(i) < scale; i++) { spread += 0.0; }
    return pick(spread) * scale;
}
'''
REPAIR_COUNT = 3

ANIME4K_PASS_COUNTS = {'Anime4K_Upscale_Denoise_CNN_x2_L.glsl': 10, 'Anime4K_Upscale_Denoise_CNN_x2_UL.glsl': 25}
ANIME4K_GLSL_DIRECTORY = PASSES_DIRECTORY / 'anime4k' / 'glsl'


def convert(text: str) -> tuple[str | None, converter.Report]:
    assert NAGA is not None
    report = converter.Report()
    return converter.convert_shader(text, DEFAULT_NAME, NAGA, SOURCE_NAME, report), report


def get_codes(report: converter.Report, severity: str) -> list[str]:
    return [finding.code for finding in report.findings if finding.severity == severity]


def get_pass_names(shader_text: str) -> list[str]:
    report = converter.Report()
    shader = converter.parse_shader(shader_text, report)
    return [instance.name for instance in converter.expand_passes(shader, DEFAULT_NAME, report)]


class ParsingTest(unittest.TestCase):
    def test_splits_blocks_as_libplacebo_does(self) -> None:
        blocks = converter.split_blocks(INDENTED_HEADER_SHADER)

        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[0].headers[0].line_number, FIRST_HEADER_LINE)
        self.assertEqual(blocks[1].headers[0].text, f'HOOK {SECOND_PASS_HOOK}')
        self.assertTrue(blocks[0].body.rstrip().endswith('}'))

    def test_rejects_a_file_without_headers(self) -> None:
        with self.assertRaises(converter.ConversionError) as raised:
            converter.split_blocks('vec4 hook() { return vec4(0.0); }')
        self.assertEqual(raised.exception.code, converter.CODE_HEADERS_MISSING)

    def test_parses_a_bounded_float_parameter(self) -> None:
        shader = converter.parse_shader(FLOAT_PARAMETER_SHADER, converter.Report())
        parameter = shader.parameters['strength']

        self.assertEqual((parameter.default_value, parameter.minimum, parameter.maximum), (0.5, 0.0, 2.0))
        self.assertTrue(parameter.is_tunable)

    def test_gives_a_missing_bound_the_type_range(self) -> None:
        report = converter.Report()
        parameter = converter.parse_shader(UNBOUNDED_PARAMETER_SHADER, report).parameters['offset']

        self.assertEqual((parameter.minimum, parameter.maximum), (-converter.FLOAT32_MAXIMUM, converter.FLOAT32_MAXIMUM))
        self.assertIn(converter.CODE_PARAMETER_UNBOUNDED, get_codes(report, converter.SEVERITY_NOTE))

    def test_parses_enum_and_define_parameters(self) -> None:
        enum_parameter = converter.parse_shader(ENUM_PARAMETER_SHADER, converter.Report()).parameters['mode']
        define_parameter = converter.parse_shader(DEFINE_PARAMETER_SHADER, converter.Report()).parameters['taps']

        self.assertEqual(enum_parameter.enum_names, ENUM_LABELS)
        self.assertEqual((enum_parameter.minimum, enum_parameter.maximum), (0, len(ENUM_LABELS) - 1))
        self.assertEqual(define_parameter.default_value, DEFINE_DEFAULT)
        self.assertFalse(define_parameter.is_tunable)

    def test_reports_a_default_outside_its_bounds(self) -> None:
        report = converter.Report()
        converter.parse_shader(OUT_OF_BOUNDS_PARAMETER_SHADER, report)

        self.assertIn(converter.CODE_PARAMETER_INVALID, get_codes(report, converter.SEVERITY_ERROR))

    def test_decodes_float_and_half_textures_into_halves(self) -> None:
        for shader_text in (FLOAT_TEXTURE_SHADER, HALF_TEXTURE_SHADER):
            with self.subTest(shader=shader_text.split('\n')[2]):
                texture = converter.parse_shader(shader_text, converter.Report()).textures['weights']
                self.assertEqual((texture.engine_format, texture.engine_data), ('rgba16float', HALF_TEXEL_BYTES))

    def test_maps_formats_the_pass_file_lacks_and_reports_them(self) -> None:
        cases = ((RGB8_TEXTURE_SHADER, 'colors', 'rgba8unorm', RGB8_TEXEL_BYTES), (R16_TEXTURE_SHADER, 'table', 'r32float', R16_TEXEL_BYTES))
        for shader_text, name, engine_format, data in cases:
            with self.subTest(format=engine_format):
                report = converter.Report()
                texture = converter.parse_shader(shader_text, report).textures[name]
                self.assertEqual((texture.engine_format, texture.engine_data), (engine_format, data))
                self.assertIn(converter.CODE_TEXTURE_FORMAT_MAPPED, get_codes(report, converter.SEVERITY_NOTE))

    def test_reports_unusable_textures(self) -> None:
        cases = ((SHORT_TEXTURE_SHADER, converter.CODE_TEXTURE_INVALID), (STORAGE_TEXTURE_SHADER, converter.CODE_TEXTURE_UNSUPPORTED))
        for shader_text, code in cases:
            with self.subTest(code=code):
                report = converter.Report()
                shader = converter.parse_shader(shader_text, report)
                self.assertIn(code, get_codes(report, converter.SEVERITY_ERROR))
                self.assertTrue(shader.unavailable_blocks)


class ExpressionTest(unittest.TestCase):
    def render(self, expression: str, syntax: converter.ExpressionSyntax) -> str:
        tokens = converter.tokenize_RPN(expression, 1)
        return converter.render_RPN(tokens, syntax, lambda token: f'{token.texture}.{token.axis}', lambda name: name)

    def test_renders_RPN_as_infix(self) -> None:
        self.assertEqual(self.render(UPSCALE_CONDITION, converter.ENGINE_SYNTAX), UPSCALE_CONDITION_RENDERED)
        self.assertEqual(self.render(EQUALITY_EXPRESSION, converter.ENGINE_SYNTAX), EQUALITY_RENDERED)

    def test_renders_RPN_as_WGSL(self) -> None:
        tokens = converter.tokenize_RPN(MODULO_EXPRESSION, 1)
        rendered = converter.render_RPN(tokens, converter.WGSL_SYNTAX, lambda token: 'size.x', lambda name: name)

        self.assertEqual(rendered, MODULO_WGSL)

    def test_reports_a_malformed_stack(self) -> None:
        for expression in (UNDERFLOW_EXPRESSION, LEFTOVER_EXPRESSION):
            with self.subTest(expression=expression), self.assertRaises(converter.ConversionError) as raised:
                self.render(expression, converter.ENGINE_SYNTAX)
            self.assertEqual(raised.exception.code, converter.CODE_EXPRESSION_INVALID)


class PassExpansionTest(unittest.TestCase):
    def test_orders_passes_by_mpv_pipeline(self) -> None:
        self.assertEqual(get_pass_names(OUT_OF_ORDER_SHADER), ORDERED_NAMES)

    def test_keeps_RGB_beside_a_plane_hook_by_the_source_and_skips_hooks_that_never_fire(self) -> None:
        report = converter.Report()
        shader = converter.parse_shader(MULTIPLE_HOOK_SHADER, report)
        instances = converter.expand_passes(shader, DEFAULT_NAME, report)

        self.assertEqual([(instance.hook, instance.variant_conditions) for instance in instances], SOURCE_HOOK_CONDITIONS)
        self.assertIn(converter.CODE_HOOK_BY_SOURCE, get_codes(report, converter.SEVERITY_NOTE))
        self.assertIn(converter.CODE_HOOK_NEVER_FIRES, get_codes(report, converter.SEVERITY_NOTE))

    def test_keeps_one_linear_light_pass(self) -> None:
        self.assertEqual(get_pass_names(LINEAR_SHADER), LINEAR_NAMES)

    def test_splits_a_pass_over_its_DEFINE_values_up_to_the_limit(self) -> None:
        report = converter.Report()
        wide = converter.expand_passes(converter.parse_shader(WIDE_DEFINE_SHADER, report), DEFAULT_NAME, report)

        self.assertEqual(get_pass_names(FRAGMENT_SHADER), FRAGMENT_NAMES)
        self.assertEqual([instance.define_values for instance in wide], [{}])
        self.assertIn(converter.CODE_DEFINE_VARIANT_LIMIT, get_codes(report, converter.SEVERITY_WARNING))

    def test_keeps_names_unique_and_short(self) -> None:
        long_shader = OUT_OF_ORDER_SHADER.replace('main pass', LONG_DESCRIPTION)

        self.assertEqual(get_pass_names(DUPLICATE_DESCRIPTION_SHADER), DUPLICATE_NAMES)
        self.assertTrue(all(len(name) <= converter.MAXIMUM_NAME_LENGTH for name in get_pass_names(long_shader)))

    def test_renames_saved_textures_the_pass_API_reserves(self) -> None:
        state = converter.PipelineState()
        report = converter.Report()

        self.assertEqual(converter.get_engine_save_name('RGB', state, report), 'mpv_RGB')
        self.assertEqual(converter.get_engine_save_name('output', state, report), 'mpv_output')
        self.assertEqual(converter.get_engine_save_name('chroma', state, report), 'mpv_chroma')
        self.assertEqual(converter.get_engine_save_name('LOWRES', state, report), 'LOWRES')
        self.assertEqual(converter.get_engine_save_name('LOWRES', state, report), 'LOWRES')


class GLSLRewriteTest(unittest.TestCase):
    def test_reverses_adjacent_array_dimensions(self) -> None:
        self.assertEqual(converter.reverse_array_dimensions(ARRAY_DECLARATIONS), ARRAY_DECLARATIONS_REVERSED)

    def test_parenthesizes_constructor_conditions(self) -> None:
        self.assertEqual(converter.wrap_for_conditions(FOR_LOOPS), FOR_LOOPS_WRAPPED)

    def test_rewrites_sampler_and_image_calls(self) -> None:
        self.assertEqual(converter.rewrite_calls(SAMPLER_CALLS, SAMPLERS, DEFAULT_NAME), SAMPLER_CALLS_REWRITTEN)

    def test_reports_a_sampler_call_without_a_counterpart(self) -> None:
        with self.assertRaises(converter.ConversionError) as raised:
            converter.rewrite_calls(PROJECTED_CALL, SAMPLERS, DEFAULT_NAME)
        self.assertEqual(raised.exception.code, converter.CODE_RAW_SAMPLER_UNSUPPORTED)

    def test_ends_a_function_that_can_fall_off_its_end(self) -> None:
        self.assertEqual(converter.add_missing_return(MISSING_RETURN_BODY, 'pick'), MISSING_RETURN_REPAIRED)

    def test_inlines_a_ternary_constant_with_its_readers(self) -> None:
        inlined: set[str] = set()

        self.assertEqual(converter.inline_runtime_constants(TERNARY_CONSTANTS, TERNARY_LINE, inlined), TERNARY_CONSTANTS_INLINED)
        self.assertEqual(inlined, {'scale', 'strength'})

    def test_expands_scalar_swizzles_on_the_failing_line(self) -> None:
        repaired, names = converter.expand_scalar_swizzles(SCALAR_SWIZZLES, SCALAR_SWIZZLE_LINE)

        self.assertEqual(repaired, SCALAR_SWIZZLES_EXPANDED)
        self.assertEqual(names, ['start', 'count'])
        self.assertEqual(converter.expand_scalar_swizzles(SCALAR_SWIZZLES, 0), (None, []))

    def test_measures_workgroup_types(self) -> None:
        self.assertEqual(converter.measure_WGSL_type(NESTED_ARRAY_TYPE), NESTED_ARRAY_BYTES)
        self.assertEqual(converter.measure_WGSL_type(VECTOR_ARRAY_TYPE), VECTOR_ARRAY_BYTES)
        self.assertIsNone(converter.measure_WGSL_type(STRUCT_TYPE))


@unittest.skipIf(NAGA is None, NAGA_MISSING_REASON)
class ConversionTest(unittest.TestCase):
    def test_converts_a_fragment_pass(self) -> None:
        result, report = convert(FRAGMENT_SHADER)

        self.assertIsNotNone(result, report.findings)
        assert result is not None
        for line in FRAGMENT_PARAMETER_LINES:
            self.assertIn(line, result)
        self.assertIn(converter.KERNEL_ENTRY, result)
        self.assertIn(converter.FRAGMENT_COORDINATE_NAME, result)
        self.assertIn(FRAGMENT_VARIANT_CONDITION, result)
        self.assertIn(converter.CODE_DEFINE_VARIANTS, get_codes(report, converter.SEVERITY_NOTE))
        self.assertNotIn(converter.CODE_PARAMETER_BAKED, get_codes(report, converter.SEVERITY_NOTE))

    def test_keeps_naga_dimension_reversal_in_check(self) -> None:
        # naga 30.0.1 reverses adjacent GLSL array dimensions; the converter reverses them first, so the type comes out right
        result, report = convert(FRAGMENT_SHADER)

        self.assertIsNotNone(result, report.findings)
        assert result is not None
        self.assertIn(NESTED_ARRAY_WGSL, result)

    def test_writes_a_resized_luma_plane_itself(self) -> None:
        result, report = convert(LUMA_DOUBLER_SHADER)

        self.assertIsNotNone(result, report.findings)
        assert result is not None
        doubler = result[result.index('//! name: luma doubler'):]
        for line in [LUMA_DOUBLER_OUTPUT, LUMA_DOUBLER_CONDITION, *LUMA_DOUBLER_INPUTS, *LUMA_PASS_HEADER_LINES]:
            self.assertIn(line, doubler)
        self.assertIn(LUMA_RESULT, doubler)
        self.assertNotIn(converter.CODE_HOOK_EMULATED, get_codes(report, converter.SEVERITY_NOTE))

    def test_converts_a_chroma_upscaler_on_native_planes(self) -> None:
        result, report = convert(CHROMA_UPSCALER_SHADER)

        self.assertIsNotNone(result, report.findings)
        assert result is not None
        downscale = result[result.index('//! name: chroma downscale'):result.index('//! name: chroma upscale')]
        upscale = result[result.index('//! name: chroma upscale'):]
        for line in CHROMA_DOWNSCALE_LINES:
            self.assertIn(line, downscale)
        for line in CHROMA_UPSCALE_LINES:
            self.assertIn(line, upscale)
        self.assertIn(ALIGNED_POSITION_ASSIGNMENT, upscale)
        self.assertIn(HOOKED_OFFSET_GLUE, upscale)
        self.assertNotIn(ALIGNED_POSITION_ASSIGNMENT, downscale)
        self.assertEqual(get_codes(report, converter.SEVERITY_WARNING), [])

    def test_maps_offsets_before_the_scaler_and_reports_them_after_it(self) -> None:
        result, report = convert(OFFSET_SHADER)

        self.assertIsNotNone(result, report.findings)
        assert result is not None
        self.assertIn(OFFSET_LINE, result[:result.index('//! name: scaled offset')])
        self.assertNotIn('//! offset:', result[result.index('//! name: scaled offset'):])
        self.assertIn(converter.Finding(converter.SEVERITY_WARNING, converter.CODE_OFFSET_IGNORED, SCALED_OFFSET_DETAIL), report.findings)

    def test_plans_a_condition_on_the_chroma_size_and_a_parameter_it_declares(self) -> None:
        result, report = convert(CHROMA_FACT_CONDITION_SHADER)

        self.assertIsNotNone(result, report.findings)
        assert result is not None
        self.assertIn(CHROMA_FACT_CONDITION, result)
        self.assertIn(STRENGTH_PARAMETER_LINE, result)
        self.assertNotIn(converter.CODE_PARAMETER_INLINED, get_codes(report, converter.SEVERITY_WARNING))

    def test_converts_a_compute_pass_within_the_workgroup_limits(self) -> None:
        oversized, oversized_report = convert(COMPUTE_TEMPLATE.format(size=OVERSIZED_WORKGROUP))
        fitting, fitting_report = convert(COMPUTE_TEMPLATE.format(size=FITTING_WORKGROUP))

        self.assertIsNone(oversized)
        self.assertIn(converter.CODE_WORKGROUP_LIMIT, get_codes(oversized_report, converter.SEVERITY_ERROR))
        self.assertIsNotNone(fitting, fitting_report.findings)
        assert fitting is not None
        for line in COMPUTE_HEADER_LINES:
            self.assertIn(line, fitting)
        self.assertNotIn('subgroupBarrier', fitting)
        self.assertIn('workgroupBarrier();', fitting)

    def test_plans_a_condition_on_a_parameter_by_its_name(self) -> None:
        result, report = convert(PARAMETER_CONDITION_SHADER)

        self.assertIsNotNone(result, report.findings)
        assert result is not None
        self.assertIn(PARAMETER_CONDITION, result)
        self.assertIn('//! param intensity: f32 = 0.1 in [0.0, 1.0]', result)

    def test_compiles_a_constant_by_name_and_keeps_a_folded_one_at_its_default(self) -> None:
        result, report = convert(CONSTANT_SHADER)

        self.assertIsNotNone(result, report.findings)
        assert result is not None
        self.assertIn(CONSTANT_LINE, result)
        self.assertNotIn('//! const taps', result)
        self.assertNotIn('gain: f32 = 2f', result)
        self.assertIn(converter.Finding(converter.SEVERITY_WARNING, converter.CODE_CONSTANT_FOLDED, FOLDED_TAPS_DETAIL), report.findings)

    def test_binds_a_TEXTURE_as_a_texture_block_of_the_file(self) -> None:
        result, report = convert(TEXTURE_PASS_SHADER)

        self.assertIsNotNone(result, report.findings)
        assert result is not None
        for line in [*TEXTURE_PASS_LINES, *TEXTURE_ACCESSOR_CALLS, TEXTURE_BLOCK_DATA]:
            self.assertIn(line, result)
        self.assertLess(result.index('//! bind: weights'), result.index('//! texture: weights'))

    def test_reads_linear_light_in_mpv_scale_through_the_engine(self) -> None:
        result, report = convert(LINEAR_SHADER)

        self.assertIsNotNone(result, report.findings)
        assert result is not None
        for line in (LINEAR_READ, LINEAR_WRITE, LINEARIZE_GLUE):
            self.assertIn(line, result)
        self.assertEqual(get_codes(report, converter.SEVERITY_WARNING), [])

    def test_reads_scaled_chroma_through_the_source_matrix(self) -> None:
        result, report = convert(CHROMA_SCALED_SHADER)

        self.assertIsNotNone(result, report.findings)
        assert result is not None
        for call in CHROMA_SCALED_CALLS:
            self.assertIn(call, result)

    def test_repairs_what_naga_rejects(self) -> None:
        result, report = convert(REPAIRED_SHADER)

        self.assertIsNotNone(result, report.findings)
        self.assertEqual(get_codes(report, converter.SEVERITY_NOTE).count(converter.CODE_GLSL_REPAIRED), REPAIR_COUNT)

    def test_converts_the_Anime4K_shaders(self) -> None:
        for file_name, pass_count in ANIME4K_PASS_COUNTS.items():
            with self.subTest(file=file_name):
                result, report = convert((ANIME4K_GLSL_DIRECTORY / file_name).read_text(encoding='utf-8'))
                self.assertIsNotNone(result, report.findings)
                assert result is not None
                self.assertEqual(result.count('//! name: '), pass_count)


if __name__ == '__main__':
    unittest.main()
