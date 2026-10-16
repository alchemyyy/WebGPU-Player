"""Converts an mpv or libplacebo user shader into a webgpu-player pass file.

Usage: python tools/convert_mpv_shader.py <input.glsl> <output.wgsl> [--name <name>] [--naga <executable>]

Every mpv pass becomes one pass per hook it fires on, in mpv's pipeline order.
naga translates each GLSL body into WGSL around stubs of the mpv shader API, and the converter binds the stubs to the pass API.
Every pass is validated with naga against the pass API before the file is written.
The report lists each place where the result differs from mpv, as a code and a terse detail.
"""

from __future__ import annotations

import argparse
import bisect
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Callable, Final


# Toolchain

NAGA_VERSION: Final = '30.0.1'
NAGA_INSTALL_COMMAND: Final = f'cargo install naga-cli --version {NAGA_VERSION} --locked'
NAGA_EXECUTABLE: Final = 'naga'
NAGA_GLSL_INPUT_KIND: Final = 'glsl'
NAGA_FRAGMENT_STAGE: Final = 'frag'
NAGA_COMPUTE_STAGE: Final = 'compute'
GLSL_FRAGMENT_FILE_NAME: Final = 'pass.frag'
GLSL_COMPUTE_FILE_NAME: Final = 'pass.comp'
WGSL_FILE_NAME: Final = 'pass.wgsl'
VALIDATION_FILE_NAME: Final = 'validation.wgsl'
ANSI_ESCAPE_PATTERN: Final = re.compile(r'\x1b\[[0-9;]*m')
NAGA_LOCATION_PATTERN: Final = re.compile(r'pass\.(?:frag|comp):(\d+):(\d+)')
NAGA_MESSAGE_PATTERN: Final = re.compile(r'^\s*(?:error|warning):\s*(.*)$', re.MULTILINE)
NAGA_NOTE_PREFIX: Final = '='
CONVERTER_PATH: Final = 'tools/convert_mpv_shader.py'

# Report

SEVERITY_ERROR: Final = 'error'
SEVERITY_WARNING: Final = 'warning'
SEVERITY_NOTE: Final = 'note'

CODE_BIND_BEFORE_STAGE: Final = 'bind-before-stage'
CODE_BIND_UNKNOWN: Final = 'bind-unknown'
CODE_BUFFER_UNSUPPORTED: Final = 'buffer-unsupported'
CODE_CONDITION_RUNTIME: Final = 'condition-runtime'
CODE_DIRECTIVE_INVALID: Final = 'directive-invalid'
CODE_DIRECTIVE_UNKNOWN: Final = 'directive-unknown'
CODE_EXPRESSION_INVALID: Final = 'expression-invalid'
CODE_EXPRESSION_NAME_UNKNOWN: Final = 'expression-name-unknown'
CODE_GLSL_DIRECTIVE_REMOVED: Final = 'glsl-directive-removed'
CODE_GLSL_REPAIRED: Final = 'glsl-repaired'
CODE_GLSL_TRANSLATION_FAILED: Final = 'glsl-translation-failed'
CODE_HEADERS_MISSING: Final = 'headers-missing'
CODE_HOOK_EMULATED: Final = 'hook-emulated'
CODE_HOOK_FUNCTION_MISSING: Final = 'hook-function-missing'
CODE_HOOK_NEVER_FIRES: Final = 'hook-never-fires'
CODE_HOOK_SKIPPED: Final = 'hook-skipped'
CODE_HOOK_UNKNOWN: Final = 'hook-unknown'
CODE_IMAGE_UNSUPPORTED: Final = 'image-unsupported'
CODE_LINEARIZE_APPROXIMATED: Final = 'linearize-approximated'
CODE_NAGA_UNAVAILABLE: Final = 'naga-unavailable'
CODE_NAME_TRUNCATED: Final = 'name-truncated'
CODE_OFFSET_IGNORED: Final = 'offset-ignored'
CODE_PARAMETER_BAKED: Final = 'parameter-baked'
CODE_PARAMETER_INLINED: Final = 'parameter-inlined'
CODE_PARAMETER_INVALID: Final = 'parameter-invalid'
CODE_PARAMETER_LIMIT: Final = 'parameter-limit'
CODE_PARAMETER_RENAMED: Final = 'parameter-renamed'
CODE_PARAMETER_UNBOUNDED: Final = 'parameter-unbounded'
CODE_PASS_UNHOOKED: Final = 'pass-unhooked'
CODE_RAW_SAMPLER_UNSUPPORTED: Final = 'raw-sampler-unsupported'
CODE_SAVE_RENAMED: Final = 'save-renamed'
CODE_STAGE_APPROXIMATED: Final = 'stage-approximated'
CODE_TEXTURE_EMULATED: Final = 'texture-emulated'
CODE_TEXTURE_INVALID: Final = 'texture-invalid'
CODE_TEXTURE_UNSUPPORTED: Final = 'texture-unsupported'
CODE_WGSL_INVALID: Final = 'wgsl-invalid'
CODE_WORKGROUP_LIMIT: Final = 'workgroup-limit'
CODE_WORKGROUP_STORAGE_LIMIT: Final = 'workgroup-storage-limit'

# mpv user shader format

HEADER_MAGIC: Final = '//!'
HOOKED_NAME: Final = 'HOOKED'
MAIN_NAME: Final = 'MAIN'
MAIN_ALIAS: Final = 'MAINPRESUB'
OUTPUT_NAME: Final = 'OUTPUT'
NATIVE_CROPPED_NAME: Final = 'NATIVE_CROPPED'
OFFSET_ALIGN: Final = 'ALIGN'
BLOCK_TEXTURE: Final = 'TEXTURE'
BLOCK_BUFFER: Final = 'BUFFER'
BLOCK_PARAMETER: Final = 'PARAM'
# In libplacebo's order, which matches each header by prefix
PASS_DIRECTIVES: Final = ('HOOK', 'BIND', 'SAVE', 'DESC', 'OFFSET', 'WIDTH', 'HEIGHT', 'WHEN', 'COMPONENTS', 'COMPUTE')
PARAMETER_DIRECTIVES: Final = ('PARAM', 'DESC', 'MINIMUM', 'MAXIMUM', 'TYPE')
TEXTURE_DIRECTIVES: Final = ('TEXTURE', 'SIZE', 'FORMAT', 'FILTER', 'BORDER', 'STORAGE')
PARAMETER_TYPE_ENUM: Final = 'ENUM'
PARAMETER_MODE_VARIABLE: Final = 'VARIABLE'
PARAMETER_MODE_DYNAMIC: Final = 'DYNAMIC'
PARAMETER_MODE_CONSTANT: Final = 'CONSTANT'
PARAMETER_MODE_DEFINE: Final = 'DEFINE'
PARAMETER_TYPE_FLOAT: Final = 'float'
PARAMETER_TYPE_INT: Final = 'int'
PARAMETER_TYPE_UINT: Final = 'uint'
PARAMETER_TYPES: Final = (PARAMETER_TYPE_FLOAT, PARAMETER_TYPE_INT, PARAMETER_TYPE_UINT)
FILTER_NEAREST: Final = 'NEAREST'
FILTER_LINEAR: Final = 'LINEAR'
BORDER_CLAMP: Final = 'CLAMP'
BORDER_REPEAT: Final = 'REPEAT'
BORDER_MIRROR: Final = 'MIRROR'
TEXTURE_FORMAT_PATTERN: Final = re.compile(r'^(r|rg|rgb|rgba)(8|16|32)(f|hf|i|u)?$')
FLOAT_SUFFIX: Final = 'f'
INTEGER_SUFFIXES: Final = ('i', 'u')
BITS_PER_BYTE: Final = 8
HALF_FLOAT_BITS: Final = 16
FLOAT32_BYTES: Final = 4
FLOAT16_BYTES: Final = 2
UNSIGNED_FORMATS: Final = {1: 'B', 2: 'H', 4: 'I'}
# Textures are emulated as constant arrays; D3D11's immediate constant buffer, which a D3D browser may place one in, holds 4096 vec4s
MAXIMUM_EMULATED_TEXELS: Final = 4_096
# A sample of a missing component, as GLSL and WGSL fill it
MISSING_COMPONENTS: Final = (0.0, 0.0, 0.0, 1.0)
INT32_MINIMUM: Final = -2_147_483_648
INT32_MAXIMUM: Final = 2_147_483_647
UINT32_MAXIMUM: Final = 4_294_967_295
FLOAT32_MAXIMUM: Final = 3.4028234663852886e38
FLOAT32_SIGNIFICANT_DIGITS: Final = 9

# RPN expressions

RPN_BINARY_OPERATORS: Final = '+-*/%><='
RPN_NOT_OPERATOR: Final = '!'
RPN_EQUALITY_OPERATOR: Final = '='
RPN_COMPARISON_OPERATORS: Final = '<>'
RPN_WIDTH_SUFFIXES: Final = ('.width', '.w')
RPN_HEIGHT_SUFFIXES: Final = ('.height', '.h')
AXIS_WIDTH: Final = 'width'
AXIS_HEIGHT: Final = 'height'
WGSL_AXES: Final = {AXIS_WIDTH: 'x', AXIS_HEIGHT: 'y'}
TOKEN_NUMBER: Final = 'number'
TOKEN_SIZE: Final = 'size'
TOKEN_VARIABLE: Final = 'variable'
TOKEN_FACT: Final = 'fact'
TOKEN_NOT: Final = 'not'
TOKEN_BINARY: Final = 'binary'
FACT_SOURCE_WIDTH: Final = 'source.width'
FACT_SOURCE_HEIGHT: Final = 'source.height'
FACT_OUTPUT_WIDTH: Final = 'output.width'
FACT_OUTPUT_HEIGHT: Final = 'output.height'
FACT_HDR_SOURCE: Final = 'hdr.source'
FACT_WGSL: Final = {
    FACT_SOURCE_WIDTH: 'presentation.sourceSize.x',
    FACT_SOURCE_HEIGHT: 'presentation.sourceSize.y',
    FACT_OUTPUT_WIDTH: 'presentation.outputSize.x',
    FACT_OUTPUT_HEIGHT: 'presentation.outputSize.y'
}
# libplacebo's tolerance for '=', relative to the larger operand
RPN_EQUALITY_TOLERANCE: Final = '0.000001'

# Pass API

ENGINE_STAGE_RGB: Final = 'RGB'
ENGINE_STAGE_PRESCALE: Final = 'PRESCALE'
ENGINE_STAGE_SCALE: Final = 'SCALE'
ENGINE_STAGE_OUTPUT: Final = 'OUTPUT'
ENGINE_STAGES: Final = (ENGINE_STAGE_RGB, ENGINE_STAGE_PRESCALE, ENGINE_STAGE_SCALE, ENGINE_STAGE_OUTPUT)
# The stages before the scaler, whose images keep the size the RGB stage leaves
PRESCALE_STAGES: Final = (ENGINE_STAGE_RGB, ENGINE_STAGE_PRESCALE)
DOMAIN_ANY: Final = 'any'
DOMAIN_SOURCE: Final = 'source'
DOMAIN_LINEAR: Final = 'linear'
DOMAIN_DISPLAY: Final = 'display'
SHAPE_KERNEL: Final = 'kernel'
SHAPE_COMPUTE: Final = 'compute'
TARGET_PREFIX: Final = 'TARGET'
ENGINE_RESERVED_TEXTURE_NAMES: Final = (HOOKED_NAME, TARGET_PREFIX, 'source', 'output', *ENGINE_STAGES)
HISTORY_SUFFIX_PATTERN: Final = re.compile(r'_history\d+$')
IDENTIFIER_PATTERN: Final = re.compile(r'^[A-Za-z_]\w*$')
INVALID_IDENTIFIER_CHARACTER_PATTERN: Final = re.compile(r'\W')
RESERVED_IDENTIFIER_PREFIX: Final = '__'
MAXIMUM_NAME_LENGTH: Final = 64
MAXIMUM_PARAMETER_COUNT: Final = 32
MAXIMUM_COMPONENTS: Final = 4
MAXIMUM_WORKGROUP_AXIS: Final = 256
MAXIMUM_WORKGROUP_INVOCATIONS: Final = 256
MAXIMUM_WORKGROUP_STORAGE_BYTES: Final = 16_384
INTERMEDIATE_FORMAT: Final = 'rgba16float'
# The formats a saved texture of fewer components takes, by shape; compute passes write core storage formats only
KERNEL_COMPONENT_FORMATS: Final = {1: 'r16float', 2: 'rg16float'}
COMPUTE_COMPONENT_FORMATS: Final = {1: 'r32float'}
ENGINE_PARAMETER_TYPES: Final = {PARAMETER_TYPE_FLOAT: 'f32', PARAMETER_TYPE_INT: 'i32', PARAMETER_TYPE_UINT: 'u32'}
PARAMETERS_VARIABLE: Final = 'parameters'
PRESENTATION_VARIABLE: Final = 'presentation'
KERNEL_ENTRY: Final = 'fn kernel(coordinate: vec2f) -> vec4f {'
COMPUTE_ENTRY: Final = 'fn compute(id: vec3u) {'
# Names the generated code reads from the prelude, which a body declaration of the same name would shadow
PRELUDE_NAMES: Final = (PARAMETERS_VARIABLE, PRESENTATION_VARIABLE, SHAPE_KERNEL, SHAPE_COMPUTE, 'TARGET_size', 'TARGET_store')
ACCESSOR_SUFFIXES: Final = ('_tex', '_texOff', '_pt', '_size', '_texture')
WGSL_RESERVED_WORDS: Final = frozenset((
    'alias', 'break', 'case', 'const', 'const_assert', 'continue', 'continuing', 'default', 'diagnostic', 'discard', 'else',
    'enable', 'false', 'fn', 'for', 'if', 'let', 'loop', 'override', 'requires', 'return', 'struct', 'switch', 'true', 'var',
    'while', 'NULL', 'Self', 'abstract', 'active', 'alignas', 'alignof', 'as', 'asm', 'asm_fragment', 'async', 'attribute',
    'auto', 'await', 'become', 'binding_array', 'cast', 'catch', 'class', 'co_await', 'co_return', 'co_yield', 'coherent',
    'column_major', 'common', 'compile', 'compile_fragment', 'concept', 'const_cast', 'consteval', 'constexpr', 'constinit',
    'crate', 'debugger', 'decltype', 'delete', 'demote', 'demote_to_helper', 'do', 'dynamic_cast', 'enum', 'explicit',
    'export', 'extends', 'extern', 'external', 'fallthrough', 'filter', 'final', 'finally', 'friend', 'from', 'fxgroup',
    'get', 'goto', 'groupshared', 'highp', 'impl', 'implements', 'import', 'inline', 'instanceof', 'interface', 'layout',
    'lowp', 'macro', 'macro_rules', 'match', 'mediump', 'meta', 'mod', 'module', 'move', 'mut', 'mutable', 'namespace',
    'new', 'nil', 'noexcept', 'noinline', 'nointerpolation', 'non_coherent', 'noncoherent', 'noperspective', 'null',
    'nullptr', 'of', 'operator', 'package', 'packoffset', 'partition', 'pass', 'patch', 'pixelfragment', 'precise',
    'precision', 'premerge', 'priv', 'protected', 'pub', 'public', 'readonly', 'ref', 'regardless', 'register',
    'reinterpret_cast', 'require', 'resource', 'restrict', 'self', 'set', 'shared', 'signed', 'sizeof', 'smooth', 'snorm',
    'static', 'static_assert', 'static_cast', 'std', 'subroutine', 'super', 'target', 'template', 'this', 'thread_local',
    'throw', 'trait', 'try', 'type', 'typedef', 'typeid', 'typename', 'typeof', 'union', 'unless', 'unorm', 'unsafe',
    'unsized', 'use', 'using', 'varying', 'virtual', 'volatile', 'wgsl', 'where', 'with', 'writeonly', 'yield'
))
RESERVED_PARAMETER_SUFFIX: Final = '_value'
SAVED_NAME_PREFIX: Final = 'mpv_'

# Hook points

PLANE_LUMA: Final = 'luma'
PLANE_CHROMA: Final = 'chroma'
PLANE_NATIVE: Final = 'native'
PLANE_ALPHA: Final = 'alpha'
LIGHT_LINEAR: Final = 'linear'
LIGHT_SIGMOID: Final = 'sigmoid'
# The planes plane hooks read and write through the RGB image
EMULATED_PLANES: Final = (PLANE_LUMA, PLANE_CHROMA, PLANE_NATIVE)
RGB_PLANE_HOOK: Final = 'RGB'
YUV_PLANE_HOOKS: Final = ('LUMA', 'CHROMA')
XYZ_HOOK: Final = 'XYZ'


@dataclass(frozen=True)
class HookMapping:
    """Where an mpv hook point runs in the engine: mpv's pipeline position, the stage and domain, and what is emulated."""

    order: int
    engine_stage: str
    domain: str
    plane: str | None = None
    light: str | None = None
    fires: bool = True
    resizable: bool = False


# mpv's hook points in pipeline order; MAINPRESUB reads as MAIN, as libplacebo handles it
HOOK_MAPPINGS: Final[dict[str, HookMapping]] = {
    RGB_PLANE_HOOK: HookMapping(0, ENGINE_STAGE_RGB, DOMAIN_SOURCE, resizable=True),
    'LUMA': HookMapping(1, ENGINE_STAGE_RGB, DOMAIN_SOURCE, plane=PLANE_LUMA, resizable=True),
    'CHROMA': HookMapping(2, ENGINE_STAGE_RGB, DOMAIN_SOURCE, plane=PLANE_CHROMA, resizable=True),
    'ALPHA': HookMapping(3, ENGINE_STAGE_RGB, DOMAIN_SOURCE, plane=PLANE_ALPHA, fires=False),
    XYZ_HOOK: HookMapping(4, ENGINE_STAGE_RGB, DOMAIN_SOURCE, fires=False),
    'CHROMA_SCALED': HookMapping(5, ENGINE_STAGE_RGB, DOMAIN_SOURCE, plane=PLANE_CHROMA),
    'ALPHA_SCALED': HookMapping(6, ENGINE_STAGE_RGB, DOMAIN_SOURCE, plane=PLANE_ALPHA, fires=False),
    'NATIVE': HookMapping(7, ENGINE_STAGE_RGB, DOMAIN_SOURCE, plane=PLANE_NATIVE, resizable=True),
    MAIN_NAME: HookMapping(8, ENGINE_STAGE_RGB, DOMAIN_SOURCE, resizable=True),
    'LINEAR': HookMapping(9, ENGINE_STAGE_PRESCALE, DOMAIN_LINEAR, light=LIGHT_LINEAR),
    'SIGMOID': HookMapping(10, ENGINE_STAGE_PRESCALE, DOMAIN_LINEAR, light=LIGHT_SIGMOID),
    'PREKERNEL': HookMapping(11, ENGINE_STAGE_PRESCALE, DOMAIN_ANY),
    'POSTKERNEL': HookMapping(12, ENGINE_STAGE_SCALE, DOMAIN_ANY),
    'SCALED': HookMapping(13, ENGINE_STAGE_SCALE, DOMAIN_ANY),
    'PREOUTPUT': HookMapping(14, ENGINE_STAGE_OUTPUT, DOMAIN_DISPLAY),
    OUTPUT_NAME: HookMapping(15, ENGINE_STAGE_OUTPUT, DOMAIN_DISPLAY)
}

# Color emulation

# BT.709 luma weights, which split the RGB image into the planes plane hooks read and join them back
LUMA_RED_WEIGHT: Final = 0.2126
LUMA_GREEN_WEIGHT: Final = 0.7152
LUMA_BLUE_WEIGHT: Final = 0.0722
CHROMA_BLUE_SCALE: Final = 2.0 * (1.0 - LUMA_BLUE_WEIGHT)
CHROMA_RED_SCALE: Final = 2.0 * (1.0 - LUMA_RED_WEIGHT)
# The neutral chroma value of a normalized chroma plane
CHROMA_OFFSET: Final = 0.5
# The engine's linear light is in nits; mpv's 1.0 is SDR white, the engine's default 100 nits, and BT.2408's 203 nits for HDR
SDR_LINEAR_SCALE_NITS: Final = 100.0
HDR_LINEAR_SCALE_NITS: Final = 203.0
HDR_VARIANT_SUFFIX: Final = ' (HDR)'
LINEAR_SCALE_CONSTANT: Final = 'MPV_LINEAR_SCALE'
# libplacebo's default sigmoid, center 0.75 and slope 6.5
SIGMOID_CENTER: Final = 0.75
SIGMOID_SLOPE: Final = 6.5
# The gamma linearize() and delinearize() stand in with, since passes do not see the source's transfer function
LINEARIZE_GAMMA: Final = 2.4

# GLSL rewriting

GLSL_VERSION_LINE: Final = '#version 450'
GLSL_REMOVED_DIRECTIVE_PATTERN: Final = re.compile(r'^[ \t]*#[ \t]*(version|extension)\b.*$', re.MULTILINE)
GLSL_STRUCT_PATTERN: Final = re.compile(r'\bstruct\s+([A-Za-z_]\w*)')
GLSL_TOKEN_PATTERN: Final = re.compile(r'//[^\n]*|/\*.*?\*/|[A-Za-z_]\w*|\d[\w.]*|\S', re.DOTALL)
GLSL_COMMENT_PREFIXES: Final = ('//', '/*')
GLSL_BUILTIN_TYPES: Final = frozenset((
    'bool', 'int', 'uint', 'float', 'double',
    *(f'{prefix}vec{size}' for prefix in ('', 'b', 'i', 'u', 'd') for size in (2, 3, 4)),
    *(f'{prefix}mat{columns}' for prefix in ('', 'd') for columns in (2, 3, 4)),
    *(f'{prefix}mat{columns}x{rows}' for prefix in ('', 'd') for columns in (2, 3, 4) for rows in (2, 3, 4))
))
GLSL_DECLARATION_ENDS: Final = (';', '{', ')')
SAMPLER_FUNCTIONS: Final = frozenset((
    'texture', 'textureLod', 'textureGrad', 'textureOffset', 'textureLodOffset', 'textureGradOffset', 'textureProj',
    'textureProjLod', 'texelFetch', 'texelFetchOffset', 'textureGather', 'textureGatherOffset', 'textureSize',
    'textureQueryLevels'
))
IMAGE_FUNCTIONS: Final = frozenset(('imageStore', 'imageLoad', 'imageSize'))
CALL_START_PATTERN: Final = re.compile(r'\b(' + '|'.join(sorted(SAMPLER_FUNCTIONS | IMAGE_FUNCTIONS)) + r')\s*\(')
OUTPUT_IMAGE_NAME: Final = 'out_image'
RAW_SUFFIX: Final = '_raw'
HOOK_FUNCTION_PATTERN: Final = re.compile(r'\bhook\s*\(')
FRAGMENT_OUTPUT_NAME: Final = 'mpv_fragment_output'
POSITION_NAME: Final = 'mpv_position'
FRAGMENT_COORDINATE_NAME: Final = 'mpv_fragment_coordinate'
GLOBAL_INVOCATION_NAME: Final = 'mpv_global_invocation_id'
LOCAL_INVOCATION_NAME: Final = 'mpv_local_invocation_id'
WORKGROUP_NAME: Final = 'mpv_workgroup_id'
WORKGROUP_COUNT_NAME: Final = 'mpv_workgroup_count'
LOCAL_INDEX_NAME: Final = 'mpv_local_invocation_index'
FRAGMENT_BUILTINS: Final = {'gl_FragCoord': FRAGMENT_COORDINATE_NAME}
COMPUTE_BUILTINS: Final = {
    'gl_GlobalInvocationID': GLOBAL_INVOCATION_NAME,
    'gl_LocalInvocationID': LOCAL_INVOCATION_NAME,
    'gl_WorkGroupID': WORKGROUP_NAME,
    'gl_NumWorkGroups': WORKGROUP_COUNT_NAME,
    'gl_LocalInvocationIndex': LOCAL_INDEX_NAME
}
WORKGROUP_SIZE_BUILTIN: Final = 'gl_WorkGroupSize'
WORKGROUP_SIZE_CONSTANT: Final = 'MPV_WORKGROUP_SIZE'
# Memory barriers alone have no WGSL counterpart; GLSL pairs them with barrier(), whose workgroupBarrier() orders memory too
MEMORY_BARRIER_FUNCTIONS: Final = (
    'memoryBarrier', 'memoryBarrierShared', 'memoryBarrierImage', 'memoryBarrierBuffer', 'memoryBarrierAtomicCounter',
    'groupMemoryBarrier'
)
# naga lowers barrier() to these besides workgroupBarrier(); subgroupBarrier() needs an extension WebGPU lacks by default
EXTRA_BARRIER_PATTERN: Final = re.compile(r'^[ \t]*(?:storageBarrier|subgroupBarrier|textureBarrier)\(\);[ \t]*\n', re.MULTILINE)
FOR_LOOP_PATTERN: Final = re.compile(r'\bfor\s*\(')
TYPE_CONSTRUCTOR_PATTERN: Final = re.compile(r'^\s*([A-Za-z_]\w*)\s*\(')

# naga translation repairs, each keyed by the naga message it answers

MAXIMUM_REPAIRS: Final = 32
INVALID_FUNCTION_PATTERN: Final = re.compile(r"Function \[\d+\] '(\w+)' is invalid")
MISSING_RETURN_MESSAGE: Final = 'The `return` expression None does not match'
SCALAR_DOT_MESSAGE: Final = 'BuiltinArgumentsInvalid("Dot")'
RUNTIME_CONSTANT_MESSAGE: Final = 'Unexpected runtime-expression'
GLOBAL_CONSTANT_PATTERN: Final = re.compile(r'^([ \t]*)const\s+[A-Za-z_]\w*\s+([A-Za-z_]\w*)\s*=')
INLINED_CONSTANT_PATTERN: Final = re.compile(r'^[ \t]*#define\s+([A-Za-z_]\w*)\s')
LINE_COMMENT_PATTERN: Final = re.compile(r'//.*$')
DOT_FUNCTION_PATTERN: Final = re.compile(r'(?<![\w.])dot\s*\(')
SCALAR_DOT_NAME: Final = 'mpv_dot'
# GLSL's dot() takes scalars, which WGSL's does not, so every dot() call goes through these overloads
SCALAR_DOT_SHIM: Final = (
    f'float {SCALAR_DOT_NAME}(float first, float second) {{ return first * second; }}',
    f'float {SCALAR_DOT_NAME}(vec2 first, vec2 second) {{ return dot(first, second); }}',
    f'float {SCALAR_DOT_NAME}(vec3 first, vec3 second) {{ return dot(first, second); }}',
    f'float {SCALAR_DOT_NAME}(vec4 first, vec4 second) {{ return dot(first, second); }}'
)
REPAIR_MISSING_RETURN: Final = 'missing-return'
REPAIR_SCALAR_DOT: Final = 'scalar-dot'

# WGSL post-processing

WGSL_DECLARATION_PATTERN: Final = re.compile(r'^((?:@\w+(?:\([^)]*\))?\s*)*)(fn|struct|const|var(?:<[^>]*>)?|alias|override)\s+(\w+)')
WGSL_CALL_PATTERN: Final = re.compile(r'\b([A-Za-z_]\w*)\s*\(')
WGSL_IDENTIFIER_PATTERN: Final = re.compile(r'(?<![\w.])[A-Za-z_]\w*')
WGSL_FUNCTION: Final = 'fn'
WGSL_STRUCT: Final = 'struct'
WGSL_PRIVATE_VARIABLE: Final = 'var<private>'
WGSL_WORKGROUP_VARIABLE: Final = 'var<workgroup>'
WGSL_DIRECTIVE: Final = 'directive'
ENTRY_ATTRIBUTES: Final = ('@fragment', '@compute', '@vertex')
ENTRY_FUNCTION_PREFIX: Final = 'main'
INPUT_OUTPUT_ATTRIBUTES: Final = ('@location(', '@builtin(')
STUB_PREFIX: Final = 'mpv_'
USER_RENAME_PREFIX: Final = 'mpv_user_'
WORKGROUP_VARIABLE_PATTERN: Final = re.compile(r'^var<workgroup>\s+\w+\s*:\s*(.+?)\s*;?\s*$', re.DOTALL)
WGSL_SCALAR_SIZES: Final = {'f32': 4, 'i32': 4, 'u32': 4, 'bool': 4, 'f16': 2}
WGSL_SHORTHAND_SCALARS: Final = {'f': 'f32', 'i': 'i32', 'u': 'u32', 'h': 'f16'}


@dataclass(frozen=True)
class Finding:
    """One report entry: its severity, code, and a terse detail of what differs or failed."""

    severity: str
    code: str
    detail: str


class ConversionError(Exception):
    """A failure that keeps a pass, or the file, from converting."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f'{code}: {detail}')
        self.code = code
        self.detail = detail


@dataclass
class Report:
    """The findings of one conversion, in the order they were found, each once."""

    findings: list[Finding] = field(default_factory=list)

    def add(self, severity: str, code: str, detail: str) -> None:
        finding = Finding(severity, code, detail)
        if finding not in self.findings:
            self.findings.append(finding)

    def has_errors(self) -> bool:
        return any(finding.severity == SEVERITY_ERROR for finding in self.findings)


# Parsing

@dataclass(frozen=True)
class HeaderLine:
    line_number: int
    text: str


@dataclass(frozen=True)
class SourceBlock:
    headers: list[HeaderLine]
    body: str
    body_line_number: int


@dataclass(frozen=True)
class RPNToken:
    """One token of an RPN expression; facts are the engine's plan-time facts, which only the converter introduces."""

    kind: str
    text: str = ''
    value: Decimal = Decimal(0)
    texture: str = ''
    axis: str = ''


@dataclass
class MPVPass:
    index: int
    line_number: int
    description: str | None = None
    hooks: list[str] = field(default_factory=list)
    binds: list[str] = field(default_factory=list)
    save: str | None = None
    width: list[RPNToken] | None = None
    height: list[RPNToken] | None = None
    condition: list[RPNToken] | None = None
    components: int | None = None
    offset: tuple[float, float] | None = None
    offset_align: bool = False
    block_size: tuple[int, int] | None = None
    thread_size: tuple[int, int] | None = None
    body: str = ''
    body_line_number: int = 0

    @property
    def is_compute(self) -> bool:
        return self.block_size is not None


@dataclass
class MPVParameter:
    name: str
    line_number: int
    mode: str
    type_name: str
    default_value: int | float
    minimum: int | float
    maximum: int | float
    enum_names: list[str] = field(default_factory=list)
    engine_name: str = ''

    @property
    def is_tunable(self) -> bool:
        return self.mode in (PARAMETER_MODE_VARIABLE, PARAMETER_MODE_DYNAMIC)


@dataclass
class MPVTexture:
    name: str
    line_number: int
    size: tuple[int, ...]
    format_name: str
    filter_mode: str
    border_mode: str
    values: list[tuple[float, float, float, float]]


@dataclass
class ParsedShader:
    passes: list[MPVPass] = field(default_factory=list)
    parameters: dict[str, MPVParameter] = field(default_factory=dict)
    textures: dict[str, MPVTexture] = field(default_factory=dict)
    # TEXTURE and BUFFER blocks that did not convert, by name, so a pass that binds one says why it fails
    unavailable_blocks: set[str] = field(default_factory=set)

    def find_parameter(self, name: str) -> tuple[MPVParameter, int | None] | None:
        """Returns the parameter a name refers to, with the value of an enum label, or None."""
        for parameter in self.parameters.values():
            if name in parameter.enum_names:
                return parameter, parameter.enum_names.index(name)
            if name == parameter.name:
                return parameter, None
        return None


class SourceLines:
    """Maps character offsets of a source to 1-based line numbers."""

    def __init__(self, text: str) -> None:
        self.line_starts: list[int] = [0]
        for index, character in enumerate(text):
            if character == '\n':
                self.line_starts.append(index + 1)

    def line_of(self, offset: int) -> int:
        return bisect.bisect_right(self.line_starts, offset)


def split_blocks(text: str) -> list[SourceBlock]:
    """Splits a shader into blocks as libplacebo does: a run of //! lines, then the body up to the next //!, anywhere."""
    lines = SourceLines(text)
    position = text.find(HEADER_MAGIC)
    if position < 0:
        raise ConversionError(CODE_HEADERS_MISSING, 'the file has no //! header')
    blocks: list[SourceBlock] = []
    while position < len(text):
        headers: list[HeaderLine] = []
        while position < len(text):
            line_end = text.find('\n', position)
            line_end = len(text) if line_end < 0 else line_end
            line = text[position:line_end].strip()
            if not line.startswith(HEADER_MAGIC):
                break
            headers.append(HeaderLine(lines.line_of(position), line[len(HEADER_MAGIC):]))
            position = min(line_end + 1, len(text))
        body_end = text.find(HEADER_MAGIC, position)
        body_end = len(text) if body_end < 0 else body_end
        blocks.append(SourceBlock(headers, text[position:body_end], lines.line_of(position)))
        position = body_end
    return blocks


def split_directive(header: HeaderLine, directives: tuple[str, ...]) -> tuple[str, str]:
    """Returns the directive a header starts with, matched by prefix in libplacebo's order, and its stripped argument."""
    for directive in directives:
        if header.text.startswith(directive):
            return directive, header.text[len(directive):].strip()
    raise ConversionError(CODE_DIRECTIVE_UNKNOWN, f'line {header.line_number}: {header.text}')


def parse_integer(text: str, line_number: int) -> int:
    try:
        return int(text)
    except ValueError:
        raise ConversionError(CODE_DIRECTIVE_INVALID, f'line {line_number}: {text!r} is not an integer') from None


def parse_float(text: str, line_number: int) -> float:
    try:
        value = float(text)
    except ValueError:
        raise ConversionError(CODE_DIRECTIVE_INVALID, f'line {line_number}: {text!r} is not a number') from None
    if value != value or abs(value) == float('inf'):
        raise ConversionError(CODE_DIRECTIVE_INVALID, f'line {line_number}: {text!r} is not finite')
    return value


def normalize_texture_name(name: str) -> str:
    """Returns MAIN for MAINPRESUB, which libplacebo treats as the same texture."""
    return MAIN_NAME if name == MAIN_ALIAS else name


def tokenize_RPN(text: str, line_number: int) -> list[RPNToken]:
    """Splits an RPN expression into tokens as libplacebo does: on single spaces, classified by suffix and first character."""
    tokens: list[RPNToken] = []
    for word in text.split(' '):
        if not word:
            continue
        width_suffix = next((suffix for suffix in RPN_WIDTH_SUFFIXES if word.endswith(suffix)), None)
        height_suffix = next((suffix for suffix in RPN_HEIGHT_SUFFIXES if word.endswith(suffix)), None)
        if width_suffix:
            tokens.append(RPNToken(TOKEN_SIZE, word, texture=normalize_texture_name(word[:-len(width_suffix)]), axis=AXIS_WIDTH))
        elif height_suffix:
            tokens.append(RPNToken(TOKEN_SIZE, word, texture=normalize_texture_name(word[:-len(height_suffix)]), axis=AXIS_HEIGHT))
        elif word[0] in RPN_BINARY_OPERATORS:
            tokens.append(RPNToken(TOKEN_BINARY, word[0]))
        elif word[0] == RPN_NOT_OPERATOR:
            tokens.append(RPNToken(TOKEN_NOT, word[0]))
        elif word[0].isdigit():
            try:
                tokens.append(RPNToken(TOKEN_NUMBER, word, value=Decimal(word)))
            except InvalidOperation:
                raise ConversionError(CODE_EXPRESSION_INVALID, f'line {line_number}: {word!r} is not a number') from None
        else:
            tokens.append(RPNToken(TOKEN_VARIABLE, word))
    return tokens


def parse_pass(block: SourceBlock, index: int) -> MPVPass:
    mpv_pass = MPVPass(index, block.headers[0].line_number, body=block.body, body_line_number=block.body_line_number)
    for header in block.headers:
        directive, argument = split_directive(header, PASS_DIRECTIVES)
        match directive:
            case 'HOOK':
                mpv_pass.hooks.append(normalize_texture_name(argument))
            case 'BIND':
                mpv_pass.binds.append(normalize_texture_name(argument))
            case 'SAVE':
                mpv_pass.save = None if argument == HOOKED_NAME else normalize_texture_name(argument)
            case 'DESC':
                mpv_pass.description = argument
            case 'OFFSET':
                if argument == OFFSET_ALIGN:
                    mpv_pass.offset_align = True
                    continue
                parts = argument.split()
                if len(parts) != 2:
                    raise ConversionError(CODE_DIRECTIVE_INVALID, f'line {header.line_number}: OFFSET {argument}')
                mpv_pass.offset = (parse_float(parts[0], header.line_number), parse_float(parts[1], header.line_number))
            case 'WIDTH':
                mpv_pass.width = tokenize_RPN(argument, header.line_number)
            case 'HEIGHT':
                mpv_pass.height = tokenize_RPN(argument, header.line_number)
            case 'WHEN':
                mpv_pass.condition = tokenize_RPN(argument, header.line_number)
            case 'COMPONENTS':
                mpv_pass.components = parse_integer(argument, header.line_number)
            case 'COMPUTE':
                sizes = [parse_integer(part, header.line_number) for part in argument.split()]
                if len(sizes) not in (2, 4) or min(sizes) < 1:
                    raise ConversionError(CODE_DIRECTIVE_INVALID, f'line {header.line_number}: COMPUTE {argument}')
                mpv_pass.block_size = (sizes[0], sizes[1])
                mpv_pass.thread_size = (sizes[2], sizes[3]) if len(sizes) == 4 else (sizes[0], sizes[1])
    return mpv_pass


def parse_parameter_value(text: str, type_name: str, line_number: int) -> int | float:
    if type_name == PARAMETER_TYPE_FLOAT:
        return parse_float(text, line_number)
    try:
        value = int(text)
    except ValueError:
        raise ConversionError(CODE_PARAMETER_INVALID, f'line {line_number}: {text!r} is not an integer') from None
    minimum, maximum = get_type_range(type_name)
    if value < minimum or value > maximum:
        raise ConversionError(CODE_PARAMETER_INVALID, f'line {line_number}: {value} is outside {type_name}')
    return value


def get_type_range(type_name: str) -> tuple[int | float, int | float]:
    """Returns a type's full range, which libplacebo uses for a missing bound, within what the pass header accepts."""
    match type_name:
        case 'float':
            return -FLOAT32_MAXIMUM, FLOAT32_MAXIMUM
        case 'uint':
            return 0, UINT32_MAXIMUM
        case _:
            return INT32_MINIMUM, INT32_MAXIMUM


def parse_parameter_type(argument: str, line_number: int) -> tuple[str, str, bool]:
    """Parses `TYPE [ENUM] <DEFINE | [DYNAMIC | CONSTANT] <type>>` into its mode, type, and whether it is an enum."""
    words = argument.split()
    is_enum = bool(words) and words[0] == PARAMETER_TYPE_ENUM
    words = words[1:] if is_enum else words
    mode = PARAMETER_MODE_VARIABLE
    if words and words[0] in (PARAMETER_MODE_DYNAMIC, PARAMETER_MODE_CONSTANT, PARAMETER_MODE_DEFINE):
        mode = words[0]
        words = words[1:]
    if mode == PARAMETER_MODE_DEFINE:
        if words:
            raise ConversionError(CODE_PARAMETER_INVALID, f'line {line_number}: TYPE DEFINE takes no type')
        return mode, PARAMETER_TYPE_INT, is_enum
    if len(words) != 1 or words[0] not in PARAMETER_TYPES:
        raise ConversionError(CODE_PARAMETER_INVALID, f'line {line_number}: TYPE {argument}')
    if is_enum and words[0] != PARAMETER_TYPE_INT:
        raise ConversionError(CODE_PARAMETER_INVALID, f'line {line_number}: ENUM needs int or DEFINE')
    return mode, words[0], is_enum


def parse_parameter(block: SourceBlock, report: Report) -> MPVParameter:
    """Parses a PARAM block as libplacebo does: the type, optional bounds, and the default value or enum names as its body."""
    name = ''
    type_parts: tuple[str, str, bool] | None = None
    minimum_text = ''
    maximum_text = ''
    line_number = block.headers[0].line_number
    for header in block.headers:
        directive, argument = split_directive(header, PARAMETER_DIRECTIVES)
        match directive:
            case 'PARAM':
                name = argument
            case 'MINIMUM':
                minimum_text = argument
            case 'MAXIMUM':
                maximum_text = argument
            case 'TYPE':
                type_parts = parse_parameter_type(argument, header.line_number)
    if not IDENTIFIER_PATTERN.match(name):
        raise ConversionError(CODE_PARAMETER_INVALID, f'line {line_number}: parameter name {name!r}')
    if type_parts is None:
        raise ConversionError(CODE_PARAMETER_INVALID, f'line {line_number}: {name} has no TYPE')
    mode, type_name, is_enum = type_parts
    initial = block.body.strip()
    if not initial:
        raise ConversionError(CODE_PARAMETER_INVALID, f'line {line_number}: {name} has no default value')
    if is_enum:
        enum_names = [line.strip() for line in initial.split('\n') if line.strip()]
        return MPVParameter(name, line_number, mode, type_name, 0, 0, len(enum_names) - 1, enum_names)
    default_value = parse_parameter_value(initial, type_name, block.body_line_number)
    type_minimum, type_maximum = get_type_range(type_name)
    minimum = parse_parameter_value(minimum_text, type_name, line_number) if minimum_text else type_minimum
    maximum = parse_parameter_value(maximum_text, type_name, line_number) if maximum_text else type_maximum
    if mode in (PARAMETER_MODE_VARIABLE, PARAMETER_MODE_DYNAMIC) and (not minimum_text or not maximum_text):
        report.add(SEVERITY_NOTE, CODE_PARAMETER_UNBOUNDED, f'{name}: a missing bound takes the {type_name} range')
    if default_value < minimum or default_value > maximum:
        raise ConversionError(CODE_PARAMETER_INVALID, f'line {line_number}: {name} default {initial} is outside its bounds')
    return MPVParameter(name, line_number, mode, type_name, default_value, minimum, maximum)


def decode_texture_values(data: bytes, format_name: str, texel_count: int, line_number: int) -> list[tuple[float, float, float, float]]:
    """Decodes a TEXTURE body into vec4 texels; float formats hold 32-bit floats as mpv's do, or halves for hf and short data."""
    format_match = TEXTURE_FORMAT_PATTERN.match(format_name)
    if not format_match:
        raise ConversionError(CODE_TEXTURE_UNSUPPORTED, f'line {line_number}: FORMAT {format_name}')
    component_count = len(format_match.group(1))
    bits = int(format_match.group(2))
    kind = format_match.group(3) or ''
    if kind in INTEGER_SUFFIXES:
        raise ConversionError(CODE_TEXTURE_UNSUPPORTED, f'line {line_number}: integer FORMAT {format_name}')
    sample_count = texel_count * component_count
    if not kind:
        byte_count = bits // BITS_PER_BYTE
        if len(data) != sample_count * byte_count:
            raise ConversionError(CODE_TEXTURE_INVALID, f'line {line_number}: {len(data)} bytes for {texel_count} {format_name} texels')
        maximum = float((1 << bits) - 1)
        components = [value / maximum for value in struct.unpack(f'<{sample_count}{UNSIGNED_FORMATS[byte_count]}', data)]
    elif kind == FLOAT_SUFFIX and len(data) == sample_count * FLOAT32_BYTES:
        components = list(struct.unpack(f'<{sample_count}f', data))
    elif bits == HALF_FLOAT_BITS and len(data) == sample_count * FLOAT16_BYTES:
        components = list(struct.unpack(f'<{sample_count}e', data))
    else:
        raise ConversionError(CODE_TEXTURE_INVALID, f'line {line_number}: {len(data)} bytes for {texel_count} {format_name} texels')
    texels: list[tuple[float, float, float, float]] = []
    for texel_index in range(texel_count):
        texel = list(MISSING_COMPONENTS)
        texel[:component_count] = components[texel_index * component_count:(texel_index + 1) * component_count]
        texels.append((texel[0], texel[1], texel[2], texel[3]))
    return texels


def parse_texture(block: SourceBlock) -> MPVTexture:
    name = ''
    size: tuple[int, ...] = ()
    format_name = ''
    filter_mode = FILTER_NEAREST
    border_mode = BORDER_CLAMP
    line_number = block.headers[0].line_number
    for header in block.headers:
        directive, argument = split_directive(header, TEXTURE_DIRECTIVES)
        match directive:
            case 'TEXTURE':
                name = argument
            case 'SIZE':
                size = tuple(parse_integer(part, header.line_number) for part in argument.split())
                if not 1 <= len(size) <= 3 or min(size) < 1:
                    raise ConversionError(CODE_TEXTURE_INVALID, f'line {header.line_number}: SIZE {argument}')
            case 'FORMAT':
                format_name = argument
            case 'FILTER':
                if argument not in (FILTER_NEAREST, FILTER_LINEAR):
                    raise ConversionError(CODE_TEXTURE_INVALID, f'line {header.line_number}: FILTER {argument}')
                filter_mode = argument
            case 'BORDER':
                if argument not in (BORDER_CLAMP, BORDER_REPEAT, BORDER_MIRROR):
                    raise ConversionError(CODE_TEXTURE_INVALID, f'line {header.line_number}: BORDER {argument}')
                border_mode = argument
            case 'STORAGE':
                raise ConversionError(CODE_TEXTURE_UNSUPPORTED, f'line {header.line_number}: {name} is a STORAGE texture')
    if not IDENTIFIER_PATTERN.match(name) or not size or not format_name:
        raise ConversionError(CODE_TEXTURE_INVALID, f'line {line_number}: TEXTURE {name!r} needs a SIZE and a FORMAT')
    texel_count = 1
    for extent in size:
        texel_count *= extent
    if texel_count > MAXIMUM_EMULATED_TEXELS:
        raise ConversionError(CODE_TEXTURE_UNSUPPORTED, f'line {line_number}: {name} has {texel_count} texels')
    try:
        data = bytes.fromhex(''.join(block.body.split()))
    except ValueError:
        raise ConversionError(CODE_TEXTURE_INVALID, f'line {line_number}: {name} body is not hexadecimal') from None
    values = decode_texture_values(data, format_name, texel_count, line_number)
    return MPVTexture(name, line_number, size, format_name, filter_mode, border_mode, values)


def parse_shader(text: str, report: Report) -> ParsedShader:
    """Parses a user shader's blocks; a block that cannot parse is reported, and the others still parse."""
    shader = ParsedShader()
    for block in split_blocks(text.replace('\r\n', '\n')):
        first_header = block.headers[0].text if block.headers else ''
        try:
            if first_header.startswith(BLOCK_TEXTURE):
                texture = parse_texture(block)
                shader.textures[texture.name] = texture
            elif first_header.startswith(BLOCK_BUFFER):
                raise ConversionError(CODE_BUFFER_UNSUPPORTED, f'line {block.headers[0].line_number}: {first_header}')
            elif first_header.startswith(BLOCK_PARAMETER):
                parameter = parse_parameter(block, report)
                shader.parameters[parameter.name] = parameter
            else:
                shader.passes.append(parse_pass(block, len(shader.passes)))
        except ConversionError as error:
            report.add(SEVERITY_ERROR, error.code, error.detail)
            for block_kind in (BLOCK_TEXTURE, BLOCK_BUFFER):
                if first_header.startswith(block_kind):
                    shader.unavailable_blocks.add(first_header[len(block_kind):].strip())
    for parameter in shader.parameters.values():
        # A WGSL reserved word would break the pass's parameters struct
        parameter.engine_name = parameter.name
        if parameter.name in WGSL_RESERVED_WORDS or parameter.name.startswith(RESERVED_IDENTIFIER_PREFIX):
            parameter.engine_name = parameter.name + RESERVED_PARAMETER_SUFFIX
            if parameter.is_tunable:
                report.add(SEVERITY_NOTE, CODE_PARAMETER_RENAMED, f'{parameter.name} -> {parameter.engine_name}')
    return shader


# Expressions

def format_decimal(value: Decimal) -> str:
    """Formats a number positionally, since pass expressions take no exponent."""
    text = format(value.normalize(), 'f')
    return '0' if text == '-0' else text


def number_token(value: int | float | Decimal) -> RPNToken:
    return RPNToken(TOKEN_NUMBER, value=Decimal(repr(value)) if isinstance(value, float) else Decimal(value))


def fact_token(fact: str) -> RPNToken:
    return RPNToken(TOKEN_FACT, fact)


def binary_token(operator: str) -> RPNToken:
    return RPNToken(TOKEN_BINARY, operator)


NOT_TOKEN: Final = RPNToken(TOKEN_NOT, RPN_NOT_OPERATOR)
SOURCE_SIZE: Final = ([fact_token(FACT_SOURCE_WIDTH)], [fact_token(FACT_SOURCE_HEIGHT)])
OUTPUT_SIZE: Final = ([fact_token(FACT_OUTPUT_WIDTH)], [fact_token(FACT_OUTPUT_HEIGHT)])


@dataclass(frozen=True)
class ExpressionSyntax:
    """How a rendered expression spells numbers and operators: the pass header's expressions, or WGSL f32 arithmetic."""

    is_WGSL: bool

    def number(self, value: Decimal) -> str:
        text = format_decimal(abs(value))
        if self.is_WGSL and '.' not in text:
            text += '.0'
        if value >= 0:
            return text
        return f'(-{text})' if self.is_WGSL else f'(0 - {text})'

    def binary(self, operator: str, left: str, right: str) -> str:
        if operator == RPN_EQUALITY_OPERATOR:
            comparison = f'abs({left} - {right}) <= {RPN_EQUALITY_TOLERANCE} * max({left}, {right})'
            return f'select(0.0, 1.0, {comparison})' if self.is_WGSL else f'({comparison})'
        if operator in RPN_COMPARISON_OPERATORS and self.is_WGSL:
            return f'select(0.0, 1.0, {left} {operator} {right})'
        return f'({left} {operator} {right})'

    def negate(self, operand: str) -> str:
        return f'select(0.0, 1.0, {operand} == 0.0)' if self.is_WGSL else f'!({operand})'


ENGINE_SYNTAX: Final = ExpressionSyntax(False)
WGSL_SYNTAX: Final = ExpressionSyntax(True)


def render_RPN(tokens: list[RPNToken], syntax: ExpressionSyntax, resolve_size: Callable[[RPNToken], str],
               resolve_variable: Callable[[str], str]) -> str:
    """Renders RPN tokens as an infix expression with a stack, as libplacebo evaluates them."""
    stack: list[str] = []
    for token in tokens:
        match token.kind:
            case 'number':
                stack.append(syntax.number(token.value))
            case 'fact':
                stack.append(FACT_WGSL.get(token.text, token.text) if syntax.is_WGSL else token.text)
            case 'size':
                stack.append(resolve_size(token))
            case 'variable':
                stack.append(resolve_variable(token.text))
            case 'not':
                if not stack:
                    raise ConversionError(CODE_EXPRESSION_INVALID, 'stack underflow at !')
                stack.append(syntax.negate(stack.pop()))
            case 'binary':
                if len(stack) < 2:
                    raise ConversionError(CODE_EXPRESSION_INVALID, f'stack underflow at {token.text}')
                right = stack.pop()
                left = stack.pop()
                stack.append(syntax.binary(token.text, left, right))
    if len(stack) != 1:
        raise ConversionError(CODE_EXPRESSION_INVALID, f'{len(stack)} values left on the stack')
    return stack[0]


def select_tokens(condition: list[RPNToken], when_true: list[RPNToken], when_false: list[RPNToken]) -> list[RPNToken]:
    """Returns RPN for condition ? when_true : when_false, with the condition read as nonzero, as WHEN reads it."""
    truth = [*condition, NOT_TOKEN, NOT_TOKEN]
    return [*when_true, *truth, binary_token('*'), *when_false, number_token(1), *truth, binary_token('-'),
            binary_token('*'), binary_token('+')]


# Pass expansion

@dataclass
class SavedTexture:
    engine_name: str
    width: list[RPNToken]
    height: list[RPNToken]


@dataclass
class PipelineState:
    """What earlier passes left behind, in pipeline order: saved textures and the RGB image's size, over plan-time facts."""

    saved_textures: dict[str, SavedTexture] = field(default_factory=dict)
    image_width: list[RPNToken] = field(default_factory=lambda: list(SOURCE_SIZE[0]))
    image_height: list[RPNToken] = field(default_factory=lambda: list(SOURCE_SIZE[1]))
    engine_save_names: dict[str, str] = field(default_factory=dict)


@dataclass
class PassInstance:
    """One engine pass to produce: an mpv pass on one of its hooks, possibly one of its SDR and HDR variants."""

    mpv_pass: MPVPass
    hook: str
    hook_position: int
    mapping: HookMapping
    name: str = ''
    variant_condition: list[RPNToken] = field(default_factory=list)
    linear_scale: float | None = None


def expand_passes(shader: ParsedShader, default_name: str, report: Report) -> list[PassInstance]:
    """Returns the engine passes in mpv's pipeline order, one per firing hook, with unique names of at most 64 characters."""
    instances: list[PassInstance] = []
    for mpv_pass in shader.passes:
        hooks = list(dict.fromkeys(mpv_pass.hooks))
        label = mpv_pass.description or f'{default_name} {mpv_pass.index + 1}'
        if not hooks:
            report.add(SEVERITY_NOTE, CODE_PASS_UNHOOKED, f'{label}: no HOOK, so libplacebo ignores it')
            continue
        firing_hooks: list[str] = []
        for hook in hooks:
            mapping = HOOK_MAPPINGS.get(hook)
            if mapping is None:
                report.add(SEVERITY_ERROR, CODE_HOOK_UNKNOWN, f'{label}: {hook}')
            elif not mapping.fires:
                report.add(SEVERITY_NOTE, CODE_HOOK_NEVER_FIRES, f'{label}: {hook} never fires on video')
            else:
                firing_hooks.append(hook)
        if RGB_PLANE_HOOK in firing_hooks and any(hook in firing_hooks for hook in YUV_PLANE_HOOKS):
            firing_hooks.remove(RGB_PLANE_HOOK)
            report.add(SEVERITY_NOTE, CODE_HOOK_SKIPPED, f'{label}: RGB fires on RGB sources only, and video is YUV')
        for hook_position, hook in enumerate(firing_hooks):
            mapping = HOOK_MAPPINGS[hook]
            hook_label = f'{label} ({hook})' if len(firing_hooks) > 1 else label
            if mapping.light is None:
                instances.append(PassInstance(mpv_pass, hook, hook_position, mapping, hook_label))
                continue
            instances.append(PassInstance(mpv_pass, hook, hook_position, mapping, hook_label,
                                          [fact_token(FACT_HDR_SOURCE), NOT_TOKEN], SDR_LINEAR_SCALE_NITS))
            instances.append(PassInstance(mpv_pass, hook, hook_position, mapping, hook_label + HDR_VARIANT_SUFFIX,
                                          [fact_token(FACT_HDR_SOURCE)], HDR_LINEAR_SCALE_NITS))
    instances.sort(key=lambda instance: (instance.mapping.order, instance.mpv_pass.index, instance.hook_position))
    assign_unique_names(instances, report)
    return instances


def assign_unique_names(instances: list[PassInstance], report: Report) -> None:
    taken: set[str] = set()
    for position, instance in enumerate(instances):
        name = ' '.join(instance.name.split())
        if len(name) > MAXIMUM_NAME_LENGTH:
            report.add(SEVERITY_NOTE, CODE_NAME_TRUNCATED, f'{name} -> {name[:MAXIMUM_NAME_LENGTH].rstrip()}')
            name = name[:MAXIMUM_NAME_LENGTH].rstrip()
        if name in taken:
            suffix = f' {position + 1}/{len(instances)}'
            name = name[:MAXIMUM_NAME_LENGTH - len(suffix)].rstrip() + suffix
        taken.add(name)
        instance.name = name


# Texture sources

@dataclass(frozen=True)
class TextureSource:
    """What an mpv texture name reads: a pass input with an emulated plane or light transform, or an emulated TEXTURE."""

    engine_input: str = ''
    transform: str | None = None
    texture_name: str = ''


def get_stage_input(stage: str, instance: PassInstance) -> str:
    """Returns the input that reads an engine stage's image: HOOKED within the stage, else the stage's final image."""
    return HOOKED_NAME if stage == instance.mapping.engine_stage else stage


def resolve_texture(name: str, instance: PassInstance, shader: ParsedShader, state: PipelineState, report: Report) -> TextureSource:
    """Resolves a bound mpv texture name in libplacebo's order: the hooked texture, TEXTURE blocks, saved textures, hook points."""
    name = normalize_texture_name(name)
    if name in (HOOKED_NAME, instance.hook):
        return TextureSource(HOOKED_NAME, instance.mapping.plane or instance.mapping.light)
    if name in shader.textures:
        return TextureSource(texture_name=name)
    if name in state.saved_textures:
        return TextureSource(state.saved_textures[name].engine_name)
    if name in shader.unavailable_blocks:
        raise ConversionError(CODE_TEXTURE_UNSUPPORTED, f'{instance.name}: binds {name}, whose block did not convert')
    target = HOOK_MAPPINGS.get(name)
    if target is None or name == XYZ_HOOK:
        raise ConversionError(CODE_BIND_UNKNOWN, f'{instance.name}: {name}')
    if target.order > instance.mapping.order:
        raise ConversionError(CODE_BIND_BEFORE_STAGE, f'{instance.name}: {name} at {instance.hook}')
    if target.engine_stage != instance.mapping.engine_stage:
        report.add(SEVERITY_NOTE, CODE_STAGE_APPROXIMATED, f'{instance.name}: {name} reads the final {target.engine_stage} image')
    return TextureSource(get_stage_input(target.engine_stage, instance), target.plane)


def get_visible_names(mpv_pass: MPVPass, hook: str) -> list[str]:
    """Returns the texture names a pass's macros define: each bound name, and for HOOKED, the hook's own name too."""
    names: list[str] = []
    for bind in mpv_pass.binds:
        aliases = [HOOKED_NAME, hook] if bind == HOOKED_NAME else [bind]
        for alias in aliases:
            names.extend([MAIN_NAME, MAIN_ALIAS] if alias == MAIN_NAME else [alias])
    return list(dict.fromkeys(names))


# Glue

@dataclass
class GlueFunction:
    """WGSL that replaces one stub of the GLSL wrapper, with what it reads."""

    text: str
    dependencies: tuple[str, ...] = ()
    engine_inputs: tuple[str, ...] = ()
    parameters: tuple[str, ...] = ()
    helpers: tuple[str, ...] = ()
    finding: Finding | None = None


@dataclass
class StateUpdate:
    """What a pass leaves for later passes, recorded whether or not its body converts so later passes still resolve."""

    save_name: str | None = None
    saved_texture: SavedTexture | None = None
    image_size: tuple[list[RPNToken], list[RPNToken]] | None = None


@dataclass
class PassContext:
    """Everything one engine pass's conversion builds up."""

    instance: PassInstance
    shader: ParsedShader
    state: PipelineState
    report: Report
    sources: list[TextureSource] = field(default_factory=list)
    visible: dict[str, int] = field(default_factory=dict)
    glue: dict[str, GlueFunction] = field(default_factory=dict)
    stubs: list[str] = field(default_factory=list)
    prelude_line_count: int = 0
    state_update: StateUpdate = field(default_factory=StateUpdate)

    @property
    def mpv_pass(self) -> MPVPass:
        return self.instance.mpv_pass

    @property
    def is_compute(self) -> bool:
        return self.instance.mpv_pass.is_compute

    @staticmethod
    def source_prefix(source_index: int) -> str:
        return f'mpv_texture{source_index}'

    def overwrites_hooked(self) -> bool:
        return self.mpv_pass.save in (None, HOOKED_NAME, self.instance.hook)

    def texture_dimensions(self, source_index: int) -> int:
        texture_name = self.sources[source_index].texture_name
        return len(self.shader.textures[texture_name].size) if texture_name else 2


def WGSL_float(value: float) -> str:
    text = repr(float(value))
    return text if any(character in text for character in '.e') else f'{text}.0'


def shortest_float32(value: float) -> str:
    """Returns the shortest WGSL literal that reads back as the same f32."""
    target = struct.pack('<f', value)
    text = repr(value)
    for digits in range(1, FLOAT32_SIGNIFICANT_DIGITS + 1):
        candidate = f'{value:.{digits}g}'
        if struct.pack('<f', float(candidate)) == target:
            text = candidate
            break
    if 'e' in text:
        mantissa, exponent = text.split('e')
        text = f'{mantissa}e{int(exponent)}'
    return text if any(character in text for character in '.e') else f'{text}.0'


HELPER_FUNCTIONS: Final[dict[str, str]] = {
    'mpv_luma_of': (
        f'const MPV_LUMA_WEIGHTS = vec3f({LUMA_RED_WEIGHT}, {LUMA_GREEN_WEIGHT}, {LUMA_BLUE_WEIGHT});\n\n'
        '// BT.709 luma, by which plane hooks read the RGB image as planes\n'
        'fn mpv_luma_of(color: vec3f) -> f32 {\n'
        '    return dot(color, MPV_LUMA_WEIGHTS);\n'
        '}'
    ),
    'mpv_ycbcr_of': (
        '// Full-range BT.709 YCbCr with chroma centered at 0.5, as a normalized chroma plane holds it\n'
        'fn mpv_ycbcr_of(color: vec3f) -> vec3f {\n'
        '    let luma = mpv_luma_of(color);\n'
        f'    let blueDifference = (color.b - luma) / {WGSL_float(CHROMA_BLUE_SCALE)} + {CHROMA_OFFSET};\n'
        f'    let redDifference = (color.r - luma) / {WGSL_float(CHROMA_RED_SCALE)} + {CHROMA_OFFSET};\n'
        '    return vec3f(luma, blueDifference, redDifference);\n'
        '}'
    ),
    'mpv_rgb_of': (
        'fn mpv_rgb_of(ycbcr: vec3f) -> vec3f {\n'
        f'    let red = ycbcr.x + {WGSL_float(CHROMA_RED_SCALE)} * (ycbcr.z - {CHROMA_OFFSET});\n'
        f'    let blue = ycbcr.x + {WGSL_float(CHROMA_BLUE_SCALE)} * (ycbcr.y - {CHROMA_OFFSET});\n'
        f'    return vec3f(red, (ycbcr.x - {LUMA_RED_WEIGHT} * red - {LUMA_BLUE_WEIGHT} * blue) / {LUMA_GREEN_WEIGHT}, blue);\n'
        '}'
    ),
    'mpv_replace_luma': (
        '// Moves every channel by the new luma\'s difference, which keeps the image\'s chroma exactly\n'
        'fn mpv_replace_luma(base: vec4f, luma: f32) -> vec4f {\n'
        '    return vec4f(base.rgb + vec3f(luma - mpv_luma_of(base.rgb)), base.a);\n'
        '}'
    ),
    'mpv_replace_chroma': (
        'fn mpv_replace_chroma(base: vec4f, chroma: vec2f) -> vec4f {\n'
        '    return vec4f(mpv_rgb_of(vec3f(mpv_luma_of(base.rgb), chroma)), base.a);\n'
        '}'
    ),
    'mpv_sigmoidize': (
        '// libplacebo\'s sigmoidization, center 0.75 and slope 6.5\n'
        f'const MPV_SIGMOID_OFFSET = 1.0 / (1.0 + exp({SIGMOID_SLOPE} * {SIGMOID_CENTER}));\n'
        f'const MPV_SIGMOID_SCALE = 1.0 / (1.0 + exp({SIGMOID_SLOPE} * ({SIGMOID_CENTER} - 1.0))) - MPV_SIGMOID_OFFSET;\n\n'
        'fn mpv_sigmoidize(color: vec3f) -> vec3f {\n'
        '    let sigmoid = clamp(color, vec3f(0.0), vec3f(1.0)) * MPV_SIGMOID_SCALE + vec3f(MPV_SIGMOID_OFFSET);\n'
        f'    return (log(sigmoid / (vec3f(1.0) - sigmoid)) - log(MPV_SIGMOID_OFFSET / (1.0 - MPV_SIGMOID_OFFSET))) / {SIGMOID_SLOPE};\n'
        '}\n\n'
        'fn mpv_unsigmoidize(color: vec3f) -> vec3f {\n'
        '    let bias = log(MPV_SIGMOID_OFFSET / (1.0 - MPV_SIGMOID_OFFSET));\n'
        f'    let curve = vec3f(1.0) / (vec3f(1.0) + exp(-(clamp(color, vec3f(0.0), vec3f(1.0)) * {SIGMOID_SLOPE} + vec3f(bias))));\n'
        '    return (curve - vec3f(1.0 / (1.0 + exp(-bias)))) / MPV_SIGMOID_SCALE;\n'
        '}'
    )
}
HELPER_DEPENDENCIES: Final[dict[str, tuple[str, ...]]] = {
    'mpv_ycbcr_of': ('mpv_luma_of',),
    'mpv_replace_luma': ('mpv_luma_of',),
    'mpv_replace_chroma': ('mpv_luma_of', 'mpv_rgb_of')
}


def get_transform_expression(transform: str | None, color: str) -> tuple[str, tuple[str, ...]]:
    """Returns WGSL that reads an RGB image sample as mpv's texture would hold it, with the helpers it needs."""
    match transform:
        case 'luma':
            return f'vec4f(mpv_luma_of({color}.rgb), 0.0, 0.0, 1.0)', ('mpv_luma_of',)
        case 'chroma':
            return f'vec4f(mpv_ycbcr_of({color}.rgb).yz, 0.0, 1.0)', ('mpv_ycbcr_of',)
        case 'native':
            return f'vec4f(mpv_ycbcr_of({color}.rgb), {color}.a)', ('mpv_ycbcr_of',)
        case 'alpha':
            return f'vec4f({color}.a, 0.0, 0.0, 1.0)', ()
        case 'linear':
            return f'vec4f({color}.rgb / {LINEAR_SCALE_CONSTANT}, {color}.a)', ()
        case 'sigmoid':
            return f'vec4f(mpv_sigmoidize({color}.rgb / {LINEAR_SCALE_CONSTANT}), {color}.a)', ('mpv_sigmoidize',)
    return color, ()


@dataclass(frozen=True)
class OutputExpression:
    """WGSL that turns a pass result into what the pass writes, with the helpers and inputs it reads."""

    text: str
    helpers: tuple[str, ...] = ()
    engine_inputs: tuple[str, ...] = ()


def get_output_expression(context: PassContext, result: str, coordinate: str) -> OutputExpression:
    """Returns WGSL that turns an overwriting pass's result back into the image: planes join it, linear light returns to nits."""
    mapping = context.instance.mapping
    if not context.overwrites_hooked():
        return OutputExpression(result)
    base = f'HOOKED_tex({coordinate})'
    match mapping.plane or mapping.light:
        case 'luma':
            return OutputExpression(f'mpv_replace_luma({base}, {result}.x)', ('mpv_replace_luma',), (HOOKED_NAME,))
        case 'chroma':
            return OutputExpression(f'mpv_replace_chroma({base}, {result}.xy)', ('mpv_replace_chroma',), (HOOKED_NAME,))
        case 'native':
            return OutputExpression(f'vec4f(mpv_rgb_of({result}.xyz), {result}.w)', ('mpv_rgb_of',))
        case 'linear':
            return OutputExpression(f'vec4f({result}.rgb * {LINEAR_SCALE_CONSTANT}, {result}.a)')
        case 'sigmoid':
            return OutputExpression(f'vec4f(mpv_unsigmoidize({result}.rgb) * {LINEAR_SCALE_CONSTANT}, {result}.a)', ('mpv_sigmoidize',))
    return OutputExpression(result)


def build_engine_glue(context: PassContext, source_index: int) -> dict[str, GlueFunction]:
    """Binds a source's stubs to a pass input, read through its plane or light transform."""
    source = context.sources[source_index]
    prefix = context.source_prefix(source_index)
    engine_input = source.engine_input
    sample, helpers = get_transform_expression(source.transform, 'color')
    finding = None
    if source.transform in EMULATED_PLANES:
        finding = Finding(SEVERITY_NOTE, CODE_HOOK_EMULATED, f'{context.instance.name}: the {source.transform} plane is read from the RGB image')
    return {
        f'{prefix}_sample': GlueFunction(
            f'fn {prefix}_sample(position: vec2f) -> vec4f {{\n'
            f'    let color = {engine_input}_tex(position);\n'
            f'    return {sample};\n'
            '}', engine_inputs=(engine_input,), helpers=helpers, finding=finding),
        f'{prefix}_size': GlueFunction(
            f'fn {prefix}_size() -> vec2f {{\n    return {engine_input}_size();\n}}', engine_inputs=(engine_input,)),
        f'{prefix}_fetch': GlueFunction(
            f'fn {prefix}_fetch(texel: vec2i) -> vec4f {{\n'
            f'    let size = {prefix}_size();\n'
            '    let clamped = clamp(texel, vec2i(0), vec2i(size) - vec2i(1));\n'
            f'    return {prefix}_sample((vec2f(clamped) + vec2f(0.5)) / size);\n'
            '}', dependencies=(f'{prefix}_sample', f'{prefix}_size')),
        f'{prefix}_gather': GlueFunction(
            '// The four texels textureGather reads, sampled at their centers, in its (0, 1), (1, 1), (1, 0), (0, 0) order\n'
            f'fn {prefix}_gather(position: vec2f, component: i32) -> vec4f {{\n'
            f'    let size = {prefix}_size();\n'
            '    let origin = floor(position * size - vec2f(0.5)) + vec2f(0.5);\n'
            f'    let lowerLeft = {prefix}_sample((origin + vec2f(0.0, 1.0)) / size);\n'
            f'    let lowerRight = {prefix}_sample((origin + vec2f(1.0, 1.0)) / size);\n'
            f'    let upperRight = {prefix}_sample((origin + vec2f(1.0, 0.0)) / size);\n'
            f'    let upperLeft = {prefix}_sample(origin / size);\n'
            '    return vec4f(lowerLeft[component], lowerRight[component], upperRight[component], upperLeft[component]);\n'
            '}', dependencies=(f'{prefix}_sample', f'{prefix}_size'))
    }


def get_texture_wrap(texture: MPVTexture, prefix: str, integer_type: str) -> str:
    """Returns WGSL that wraps a texel index into the texture by its BORDER, as a sampler's address mode does."""
    extent = f'{prefix}_extent'
    match texture.border_mode:
        case 'REPEAT':
            return f'((texel % {extent}) + {extent}) % {extent}'
        case 'MIRROR':
            period = f'(2 * {extent})'
            folded = f'(((texel % {period}) + {period}) % {period})'
            return f'select({folded}, {period} - {integer_type}(1) - {folded}, {folded} >= {extent})'
    return f'clamp(texel, {integer_type}(0), {extent} - {integer_type}(1))'


def build_texture_glue(context: PassContext, source_index: int) -> dict[str, GlueFunction]:
    """Emulates a TEXTURE block as a constant array, sampled with its FILTER and BORDER."""
    texture = context.shader.textures[context.sources[source_index].texture_name]
    prefix = context.source_prefix(source_index)
    dimensions = len(texture.size)
    float_type = {1: 'f32', 2: 'vec2f', 3: 'vec3f'}[dimensions]
    integer_type = {1: 'i32', 2: 'vec2i', 3: 'vec3i'}[dimensions]
    extent = f'{integer_type}({", ".join(str(size) for size in texture.size)})'
    values = ',\n    '.join(f'vec4f({", ".join(shortest_float32(component) for component in texel)})' for texel in texture.values)
    row_length = texture.size[0]
    plane_length = texture.size[0] * (texture.size[1] if dimensions > 1 else 1)
    index_expression = {1: 'wrapped', 2: f'wrapped.y * {row_length} + wrapped.x',
                        3: f'wrapped.z * {plane_length} + wrapped.y * {row_length} + wrapped.x'}[dimensions]
    if texture.filter_mode == FILTER_LINEAR:
        corners = [tuple((corner >> axis) & 1 for axis in range(dimensions)) for corner in range(1 << dimensions)]
        lines = [f'    let texel = position * {float_type}({prefix}_extent) - {float_type}(0.5);',
                 f'    let origin = {integer_type}(floor(texel));',
                 '    let fraction = fract(texel);']
        for corner in corners:
            offset = f'{integer_type}({", ".join(str(axis_offset) for axis_offset in corner)})' if dimensions > 1 else str(corner[0])
            lines.append(f'    let corner{"".join(str(axis_offset) for axis_offset in corner)} = {prefix}_texel(origin + {offset});')
        level = [f'corner{"".join(str(axis_offset) for axis_offset in corner)}' for corner in corners]
        axes = ['fraction'] if dimensions == 1 else ['fraction.x', 'fraction.y', 'fraction.z'][:dimensions]
        for axis in axes:
            level = [f'mix({level[index]}, {level[index + 1]}, {axis})' for index in range(0, len(level), 2)]
        lines.append(f'    return {level[0]};')
        sample_body = '\n'.join(lines)
    else:
        sample_body = f'    return {prefix}_texel({integer_type}(floor(position * {float_type}({prefix}_extent))));'
    texel_function = (
        f'const {prefix}_values = array<vec4f, {len(texture.values)}>(\n    {values}\n);\n'
        f'const {prefix}_extent = {extent};\n\n'
        f'fn {prefix}_texel(texel: {integer_type}) -> vec4f {{\n'
        f'    let wrapped = {get_texture_wrap(texture, prefix, integer_type)};\n'
        f'    return {prefix}_values[{index_expression}];\n'
        '}'
    )
    finding = Finding(SEVERITY_NOTE, CODE_TEXTURE_EMULATED, f'{texture.name}: {len(texture.values)} texels as a constant array')
    glue: dict[str, GlueFunction] = {
        f'{prefix}_texel': GlueFunction(texel_function, finding=finding),
        f'{prefix}_sample': GlueFunction(f'fn {prefix}_sample(position: {float_type}) -> vec4f {{\n{sample_body}\n}}',
                                         dependencies=(f'{prefix}_texel',)),
        f'{prefix}_size': GlueFunction(f'fn {prefix}_size() -> {float_type} {{\n    return {float_type}({prefix}_extent);\n}}',
                                       dependencies=(f'{prefix}_texel',)),
        f'{prefix}_fetch': GlueFunction(f'fn {prefix}_fetch(texel: {integer_type}) -> vec4f {{\n    return {prefix}_texel(texel);\n}}',
                                        dependencies=(f'{prefix}_texel',))
    }
    if dimensions == 2:
        glue[f'{prefix}_gather'] = GlueFunction(
            f'fn {prefix}_gather(position: vec2f, component: i32) -> vec4f {{\n'
            f'    let origin = vec2i(floor(position * vec2f({prefix}_extent) - vec2f(0.5)));\n'
            f'    return vec4f({prefix}_texel(origin + vec2i(0, 1))[component], {prefix}_texel(origin + vec2i(1, 1))[component],\n'
            f'        {prefix}_texel(origin + vec2i(1, 0))[component], {prefix}_texel(origin)[component]);\n'
            '}', dependencies=(f'{prefix}_texel',))
    return glue


def build_shared_glue(context: PassContext) -> dict[str, GlueFunction]:
    """Builds the glue of the global variables and functions every mpv pass sees."""
    linearize_finding = Finding(SEVERITY_WARNING, CODE_LINEARIZE_APPROXIMATED,
                                f'{context.instance.name}: linearize() and delinearize() use gamma {LINEARIZE_GAMMA}')
    glue: dict[str, GlueFunction] = {
        'mpv_frame': GlueFunction('fn mpv_frame() -> i32 {\n    return i32(presentation.frameIndex);\n}'),
        'mpv_random': GlueFunction(
            '// A PCG hash of the frame index, one value in [0, 1) per frame, as mpv\'s random is\n'
            'fn mpv_random() -> f32 {\n'
            '    let state = presentation.frameIndex * 747796405u + 2891336453u;\n'
            '    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;\n'
            '    return f32(((word >> 22u) ^ word) >> 8u) / 16777216.0;\n'
            '}'),
        'mpv_input_size': GlueFunction('fn mpv_input_size() -> vec2f {\n    return presentation.sourceSize;\n}'),
        'mpv_target_size': GlueFunction('fn mpv_target_size() -> vec2f {\n    return presentation.outputSize;\n}'),
        'mpv_linearize': GlueFunction(
            'fn mpv_linearize(color: vec4f) -> vec4f {\n'
            f'    return vec4f(pow(max(color.rgb, vec3f(0.0)), vec3f({LINEARIZE_GAMMA})), color.a);\n'
            '}', finding=linearize_finding),
        'mpv_delinearize': GlueFunction(
            'fn mpv_delinearize(color: vec4f) -> vec4f {\n'
            f'    return vec4f(pow(max(color.rgb, vec3f(0.0)), vec3f(1.0 / {LINEARIZE_GAMMA})), color.a);\n'
            '}', finding=linearize_finding)
    }
    if context.is_compute:
        output = get_output_expression(context, 'value', '(vec2f(texel) + vec2f(0.5)) / vec2f(TARGET_size())')
        glue['mpv_map'] = GlueFunction('fn mpv_map(texel: vec2f) -> vec2f {\n    return (texel + vec2f(0.5)) / vec2f(TARGET_size());\n}')
        glue['mpv_image_store'] = GlueFunction(
            '// A store outside the image is dropped\n'
            'fn mpv_image_store(texel: vec2i, value: vec4f) {\n'
            '    if (any(texel < vec2i(0)) || any(vec2u(texel) >= TARGET_size())) {\n'
            '        return;\n'
            '    }\n'
            f'    TARGET_store(vec2u(texel), {output.text});\n'
            '}', engine_inputs=output.engine_inputs, helpers=output.helpers)
        glue['mpv_image_size'] = GlueFunction('fn mpv_image_size() -> vec2i {\n    return vec2i(TARGET_size());\n}')
    for parameter in context.shader.parameters.values():
        if parameter.is_tunable:
            glue[f'mpv_parameter_{parameter.name}'] = GlueFunction(
                f'fn mpv_parameter_{parameter.name}() -> {ENGINE_PARAMETER_TYPES[parameter.type_name]} {{\n'
                f'    return {PARAMETERS_VARIABLE}.{parameter.engine_name};\n'
                '}', parameters=(parameter.name,))
    return glue


# GLSL wrapper

def GLSL_vector_type(dimensions: int, prefix: str = '') -> str:
    return {1: 'int' if prefix else 'float', 2: f'{prefix}vec2', 3: f'{prefix}vec3'}[dimensions]


def find_matching_parenthesis(text: str, open_index: int) -> int:
    depth = 0
    for index in range(open_index, len(text)):
        if text[index] == '(':
            depth += 1
        elif text[index] == ')':
            depth -= 1
            if depth == 0:
                return index
    return -1


def split_arguments(text: str) -> list[str]:
    """Splits call arguments at the commas outside parentheses and brackets."""
    arguments: list[str] = []
    depth = 0
    start = 0
    for index, character in enumerate(text):
        if character in '([':
            depth += 1
        elif character in ')]':
            depth -= 1
        elif character == ',' and depth == 0:
            arguments.append(text[start:index])
            start = index + 1
    arguments.append(text[start:])
    return arguments


def rewrite_texture_call(function: str, arguments: list[str], prefix: str, dimensions: int) -> str | None:
    """Rewrites a GLSL texture function on a known sampler into the stubs; returns None when it has no counterpart."""
    float_vector = GLSL_vector_type(dimensions)
    sample = f'{prefix}_sample'

    def offset_position(offset: str) -> str:
        return f'({arguments[1]}) + {float_vector}({offset}) / {prefix}_size()'

    match function, len(arguments):
        case ('texture', 2 | 3) | ('textureLod', 3) | ('textureGrad', 4):
            return f'{sample}({arguments[1]})'
        case ('textureOffset', 3 | 4):
            return f'{sample}({offset_position(arguments[2])})'
        case ('textureLodOffset', 4) | ('textureGradOffset', 5):
            return f'{sample}({offset_position(arguments[-1])})'
        case ('texelFetch', 3):
            return f'{prefix}_fetch({arguments[1]})'
        case ('texelFetchOffset', 4):
            return f'{prefix}_fetch(({arguments[1]}) + ({arguments[3]}))'
        case ('textureGather', 2 | 3) if dimensions == 2:
            component = arguments[2] if len(arguments) == 3 else '0'
            return f'{prefix}_gather({arguments[1]}, {component})'
        case ('textureGatherOffset', 3 | 4) if dimensions == 2:
            component = arguments[3] if len(arguments) == 4 else '0'
            return f'{prefix}_gather({offset_position(arguments[2])}, {component})'
        case ('textureSize', 2):
            return f'{GLSL_vector_type(dimensions, "i")}({prefix}_size())'
        case ('textureQueryLevels', 1):
            return '1'
    return None


def rewrite_calls(body: str, samplers: dict[str, tuple[str, int]], pass_name: str) -> str:
    """Rewrites texture calls on known samplers and image calls on out_image, innermost first, keeping every line break."""
    for match in reversed(list(CALL_START_PATTERN.finditer(body))):
        function = match.group(1)
        open_index = match.end() - 1
        close_index = find_matching_parenthesis(body, open_index)
        if close_index < 0:
            continue
        arguments = split_arguments(body[open_index + 1:close_index])
        target = arguments[0].strip()
        replacement: str | None = None
        if function in IMAGE_FUNCTIONS:
            if target != OUTPUT_IMAGE_NAME:
                continue
            match function, len(arguments):
                case ('imageStore', 3):
                    replacement = f'mpv_image_store({arguments[1]}, {arguments[2]})'
                case ('imageSize', 1):
                    replacement = 'mpv_image_size()'
            if replacement is None:
                raise ConversionError(CODE_IMAGE_UNSUPPORTED, f'{pass_name}: {function} on out_image')
        else:
            if target not in samplers:
                continue
            prefix, dimensions = samplers[target]
            replacement = rewrite_texture_call(function, arguments, prefix, dimensions)
            if replacement is None:
                raise ConversionError(CODE_RAW_SAMPLER_UNSUPPORTED, f'{pass_name}: {function} on {target}')
        body = body[:match.start()] + replacement + body[close_index + 1:]
    return body


def replace_identifiers(text: str, replacements: dict[str, str]) -> str:
    """Replaces whole identifiers, except member names after a dot."""
    if not replacements:
        return text
    pattern = re.compile(r'(?<![\w.])(' + '|'.join(re.escape(name) for name in replacements) + r')(?!\w)')
    return pattern.sub(lambda match: replacements[match.group(1)], text)


def find_bracket_groups(tokens: list[tuple[int, int, str]], start: int) -> list[tuple[int, int, int]]:
    """Returns the `[...]` groups that follow tokens[start - 1], each as its text span and the index after it."""
    groups: list[tuple[int, int, int]] = []
    index = start
    while index < len(tokens) and tokens[index][2] == '[':
        depth = 0
        closing = index
        while closing < len(tokens):
            depth += {'[': 1, ']': -1}.get(tokens[closing][2], 0)
            if depth == 0:
                break
            closing += 1
        if closing >= len(tokens):
            break
        groups.append((tokens[index][0], tokens[closing][1], closing + 1))
        index = closing + 1
    return groups


def reverse_array_dimensions(body: str) -> str:
    """Reverses adjacent array dimensions in declarations and constructors, which naga 30.0.1's GLSL frontend reverses."""
    type_names = GLSL_BUILTIN_TYPES | set(GLSL_STRUCT_PATTERN.findall(body))
    tokens = [(match.start(), match.end(), match.group(0)) for match in GLSL_TOKEN_PATTERN.finditer(body)
              if not match.group(0).startswith(GLSL_COMMENT_PREFIXES)]
    edits: list[tuple[int, int, str]] = []
    depth = 0
    expect_declarator = False
    declaration_depth: int | None = None
    index = 0
    while index < len(tokens):
        text = tokens[index][2]
        groups = find_bracket_groups(tokens, index + 1)
        is_type = text in type_names
        is_declarator = expect_declarator and IDENTIFIER_PATTERN.match(text) is not None and not is_type
        if (is_type or is_declarator) and len(groups) >= 2:
            pieces = [body[start:end] for start, end, _ in groups]
            edits.append((groups[0][0], groups[-1][1], ''.join(reversed(pieces))))
        next_index = groups[-1][2] if groups else index + 1
        if is_type:
            following = tokens[next_index][2] if next_index < len(tokens) else ''
            expect_declarator = following != '('
            if expect_declarator:
                declaration_depth = depth
        elif is_declarator:
            expect_declarator = False
        elif text == ',' and declaration_depth == depth:
            expect_declarator = True
        elif text in GLSL_DECLARATION_ENDS and declaration_depth is not None and depth <= declaration_depth:
            declaration_depth = None
            expect_declarator = False
        if text in '({':
            depth += 1
        elif text in ')}':
            depth -= 1
        index = next_index
    for start, end, replacement in reversed(edits):
        body = body[:start] + replacement + body[end:]
    return body


def GLSL_literal(value: int | float, type_name: str) -> str:
    match type_name:
        case 'float':
            return WGSL_float(float(value))
        case 'uint':
            return f'{value}u'
    return str(value)


def build_GLSL_wrapper(context: PassContext, body: str, extra_prelude: list[str]) -> str:
    """Builds the GLSL naga translates: stubs and macros of the mpv shader API, the pass body, and an entry point."""
    mpv_pass = context.mpv_pass
    context.stubs.clear()
    lines: list[str] = [GLSL_VERSION_LINE]
    if context.is_compute:
        assert mpv_pass.thread_size is not None
        lines.extend([
            f'layout(local_size_x = {mpv_pass.thread_size[0]}, local_size_y = {mpv_pass.thread_size[1]}, local_size_z = 1) in;',
            f'uvec3 {GLOBAL_INVOCATION_NAME};', f'uvec3 {LOCAL_INVOCATION_NAME};', f'uvec3 {WORKGROUP_NAME};',
            f'uvec3 {WORKGROUP_COUNT_NAME};', f'uint {LOCAL_INDEX_NAME};',
            'void mpv_image_store(ivec2 texel, vec4 value) { }',
            'ivec2 mpv_image_size() { return ivec2(1); }',
            'vec2 mpv_map(vec2 texel) { return texel; }'
        ])
        context.stubs.extend(['mpv_image_store', 'mpv_image_size', 'mpv_map'])
    else:
        lines.append(f'vec4 {FRAGMENT_COORDINATE_NAME};')
    lines.extend([
        f'vec2 {POSITION_NAME};',
        'int mpv_frame() { return 0; }',
        'float mpv_random() { return 0.0; }',
        'vec2 mpv_input_size() { return vec2(1.0); }',
        'vec2 mpv_target_size() { return vec2(1.0); }',
        'vec4 mpv_linearize(vec4 color) { return color; }',
        'vec4 mpv_delinearize(vec4 color) { return color; }',
        '#define frame mpv_frame()',
        '#define random mpv_random()',
        '#define input_size mpv_input_size()',
        '#define target_size mpv_target_size()',
        '#define tex_offset vec2(0.0)',
        '#define linearize mpv_linearize',
        '#define delinearize mpv_delinearize'
    ])
    context.stubs.extend(['mpv_frame', 'mpv_random', 'mpv_input_size', 'mpv_target_size', 'mpv_linearize', 'mpv_delinearize'])
    lines.extend(f'#define {function}()' for function in MEMORY_BARRIER_FUNCTIONS)
    for source_index in range(len(context.sources)):
        prefix = context.source_prefix(source_index)
        dimensions = context.texture_dimensions(source_index)
        position_type = GLSL_vector_type(dimensions)
        texel_type = GLSL_vector_type(dimensions, 'i')
        lines.extend([
            f'vec4 {prefix}_sample({position_type} position) {{ return vec4(0.0); }}',
            f'{position_type} {prefix}_size() {{ return {position_type}(1.0); }}',
            f'vec4 {prefix}_fetch({texel_type} texel) {{ return vec4(0.0); }}',
            f'vec4 {prefix}_gather({position_type} position, int component) {{ return vec4(0.0); }}'
        ])
        context.stubs.extend([f'{prefix}_sample', f'{prefix}_size', f'{prefix}_fetch', f'{prefix}_gather'])
    for name, source_index in context.visible.items():
        prefix = context.source_prefix(source_index)
        if context.sources[source_index].texture_name:
            # libplacebo gives a TEXTURE block only its sampler and NAME_tex
            lines.append(f'#define {name}_tex(pos) {prefix}_sample(pos)')
            continue
        lines.extend([
            f'#define {name}_pos {POSITION_NAME}',
            f'#define {name}_size {prefix}_size()',
            f'#define {name}_pt (vec2(1.0) / {prefix}_size())',
            f'#define {name}_mul 1.0',
            f'#define {name}_rot mat2(1.0, 0.0, 0.0, 1.0)',
            f'#define {name}_off vec2(0.0)',
            f'#define {name}_map(id) mpv_map(vec2(id))',
            f'#define {name}_tex(pos) {prefix}_sample(pos)',
            f'#define {name}_texOff(off) {prefix}_sample({POSITION_NAME} + (vec2(1.0) / {prefix}_size()) * vec2(off))',
            f'#define {name}_gather(pos, c) {prefix}_gather(pos, c)'
        ])
    for parameter in context.shader.parameters.values():
        lines.extend(f'#define {label} {value}' for value, label in enumerate(parameter.enum_names))
        literal = GLSL_literal(parameter.default_value, parameter.type_name)
        if parameter.is_tunable:
            stub = f'mpv_parameter_{parameter.name}'
            lines.extend([f'{parameter.type_name} {stub}() {{ return {literal}; }}', f'#define {parameter.name} {stub}()'])
            context.stubs.append(stub)
        elif parameter.mode == PARAMETER_MODE_DEFINE:
            lines.append(f'#define {parameter.name} {parameter.default_value}')
        else:
            lines.append(f'#define {parameter.name} ({parameter.type_name}({literal}))')
    lines.extend(extra_prelude)
    context.prelude_line_count = len(lines)
    lines.extend(body.split('\n'))
    if context.is_compute:
        lines.append('void main() { hook(); }')
    else:
        lines.extend([f'layout(location = 0) out vec4 {FRAGMENT_OUTPUT_NAME};', f'void main() {{ {FRAGMENT_OUTPUT_NAME} = hook(); }}'])
    return '\n'.join(lines) + '\n'


def prepare_GLSL_body(context: PassContext) -> str:
    """Rewrites what the stubs cannot cover: directives, raw samplers, out_image, built-in variables, and array dimensions."""
    mpv_pass = context.mpv_pass
    pass_name = context.instance.name

    def blank(match: re.Match[str]) -> str:
        context.report.add(SEVERITY_NOTE, CODE_GLSL_DIRECTIVE_REMOVED, f'{pass_name}: {match.group(0).strip()}')
        return ''

    body = GLSL_REMOVED_DIRECTIVE_PATTERN.sub(blank, mpv_pass.body)
    if not HOOK_FUNCTION_PATTERN.search(body):
        raise ConversionError(CODE_HOOK_FUNCTION_MISSING, f'{pass_name}: no hook()')
    samplers: dict[str, tuple[str, int]] = {}
    for name, source_index in context.visible.items():
        sampler_name = name if context.sources[source_index].texture_name else name + RAW_SUFFIX
        samplers[sampler_name] = (context.source_prefix(source_index), context.texture_dimensions(source_index))
    body = rewrite_calls(body, samplers, pass_name)
    for sampler_name in samplers:
        if re.search(rf'(?<!\w){re.escape(sampler_name)}(?!\w)', body) and sampler_name.endswith(RAW_SUFFIX):
            raise ConversionError(CODE_RAW_SAMPLER_UNSUPPORTED, f'{pass_name}: {sampler_name} outside a texture call')
    if re.search(rf'(?<!\w){OUTPUT_IMAGE_NAME}(?!\w)', body):
        raise ConversionError(CODE_IMAGE_UNSUPPORTED, f'{pass_name}: out_image outside imageStore or imageSize')
    replacements = dict(FRAGMENT_BUILTINS)
    if context.is_compute:
        assert mpv_pass.thread_size is not None
        replacements.update(COMPUTE_BUILTINS)
        replacements[WORKGROUP_SIZE_BUILTIN] = f'uvec3({mpv_pass.thread_size[0]}u, {mpv_pass.thread_size[1]}u, 1u)'
    if mpv_pass.offset is not None and any(mpv_pass.offset):
        context.report.add(SEVERITY_WARNING, CODE_OFFSET_IGNORED, f'{pass_name}: OFFSET {mpv_pass.offset[0]} {mpv_pass.offset[1]}')
    return wrap_for_conditions(reverse_array_dimensions(replace_identifiers(body, replacements)))


def wrap_for_conditions(body: str) -> str:
    """Parenthesizes for-loop conditions that open with a constructor, which naga's GLSL parser takes for a declaration."""
    for match in reversed(list(FOR_LOOP_PATTERN.finditer(body))):
        open_index = match.end() - 1
        close_index = find_matching_parenthesis(body, open_index)
        if close_index < 0:
            continue
        clauses = split_clauses(body[open_index + 1:close_index])
        if len(clauses) != 3:
            continue
        constructor = TYPE_CONSTRUCTOR_PATTERN.match(clauses[1])
        if constructor is None or constructor.group(1) not in GLSL_BUILTIN_TYPES:
            continue
        clauses[1] = f' ({clauses[1].strip()})'
        body = body[:open_index + 1] + ';'.join(clauses) + body[close_index:]
    return body


def split_clauses(text: str) -> list[str]:
    """Splits a for-loop header at the semicolons outside parentheses."""
    clauses: list[str] = []
    depth = 0
    start = 0
    for index, character in enumerate(text):
        if character in '([':
            depth += 1
        elif character in ')]':
            depth -= 1
        elif character == ';' and depth == 0:
            clauses.append(text[start:index])
            start = index + 1
    clauses.append(text[start:])
    return clauses


def find_matching_brace(text: str, open_index: int) -> int:
    depth = 0
    for index in range(open_index, len(text)):
        if text[index] == '{':
            depth += 1
        elif text[index] == '}':
            depth -= 1
            if depth == 0:
                return index
    return -1


def add_missing_return(body: str, function_name: str) -> str | None:
    """Ends a function that can fall off its end, which GLSL allows and WGSL does not, with a zero return."""
    declaration = re.search(rf'\b([A-Za-z_]\w*)\s+{re.escape(function_name)}\s*\(', body)
    if declaration is None or declaration.group(1) == 'void':
        return None
    parameters_end = find_matching_parenthesis(body, declaration.end() - 1)
    open_brace = body.find('{', parameters_end)
    close_brace = find_matching_brace(body, open_brace) if open_brace >= 0 else -1
    if close_brace < 0:
        return None
    return body[:close_brace] + f'return {declaration.group(1)}(0); ' + body[close_brace:]


def find_global_constants(body: str) -> dict[str, int]:
    """Returns the global const declarations of a body, by name, with the 0-based line each starts on."""
    constants: dict[str, int] = {}
    depth = 0
    for line_index, line in enumerate(body.split('\n')):
        declaration = GLOBAL_CONSTANT_PATTERN.match(line) if depth == 0 else None
        if declaration is not None:
            constants[declaration.group(2)] = line_index
        code = LINE_COMMENT_PATTERN.sub('', line)
        depth += code.count('{') - code.count('}')
    return constants


def inline_constant(body: str, line_index: int) -> str | None:
    """Turns the global const declared at a line into a macro of its initializer, keeping every line."""
    lines = body.split('\n')
    declaration = GLOBAL_CONSTANT_PATTERN.match(lines[line_index])
    if declaration is None:
        return None
    start = sum(len(line) + 1 for line in lines[:line_index])
    end = body.find(';', start)
    if end < 0:
        return None
    statement = body[start:end + 1]
    initializer = statement[statement.index('=') + 1:-1].strip()
    if '{' in initializer:
        return None
    macro = f'{declaration.group(1)}#define {declaration.group(2)} ({" ".join(initializer.split())})'
    return body[:start] + macro + '\n' * statement.count('\n') + body[end + 1:]


def inline_runtime_constants(body: str, body_line: int, inlined: set[str]) -> str | None:
    """Turns a global const that naga cannot evaluate, such as one set by a ternary, into a macro evaluated where it is read.

    Every global const that reads it turns too, since those stop being constant, and naga names the macro's line for their failures.
    """
    lines = body.split('\n')
    if not 0 <= body_line < len(lines):
        return None
    constants = find_global_constants(body)
    declaration = GLOBAL_CONSTANT_PATTERN.match(lines[body_line])
    macro = INLINED_CONSTANT_PATTERN.match(lines[body_line])
    if declaration is not None:
        pending = {declaration.group(2)}
    elif macro is not None and macro.group(1) in inlined:
        pending = {macro.group(1)}
    else:
        return None
    targets: set[str] = set()
    while pending:
        targets |= pending
        names = targets | inlined
        reads = re.compile(r'(?<![\w.])(' + '|'.join(re.escape(name) for name in names) + r')(?!\w)')
        pending = set()
        for name, line_index in constants.items():
            initializer = lines[line_index].split('=', 1)[-1]
            if name not in targets and reads.search(initializer):
                pending.add(name)
    targets -= inlined
    if not targets:
        return None
    for name in sorted(targets, key=lambda target: constants.get(target, -1), reverse=True):
        if name not in constants:
            continue
        repaired = inline_constant(body, constants[name])
        if repaired is None:
            return None
        body = repaired
    inlined |= targets
    return body


@dataclass
class GLSLRepairs:
    """The repairs applied so far to one pass's GLSL, so that none repeats."""

    applied: set[str] = field(default_factory=set)
    extra_prelude: list[str] = field(default_factory=list)
    inlined_constants: set[str] = field(default_factory=set)


def repair_GLSL(body: str, error: NagaTranslationError, repairs: GLSLRepairs, context: PassContext) -> str | None:
    """Repairs the construct a naga failure names, keeping every line; returns None when no repair applies."""
    invalid_function = INVALID_FUNCTION_PATTERN.search(error.output)
    missing_return = invalid_function.group(1) if invalid_function and MISSING_RETURN_MESSAGE in error.output else None
    if missing_return is not None and f'{REPAIR_MISSING_RETURN}:{missing_return}' not in repairs.applied:
        repairs.applied.add(f'{REPAIR_MISSING_RETURN}:{missing_return}')
        repaired = add_missing_return(body, missing_return)
        detail = f'{missing_return}() can end without a return, so it returns zero there'
    elif SCALAR_DOT_MESSAGE in error.output and REPAIR_SCALAR_DOT not in repairs.applied:
        repairs.applied.add(REPAIR_SCALAR_DOT)
        repairs.extra_prelude.extend(SCALAR_DOT_SHIM)
        repaired = DOT_FUNCTION_PATTERN.sub(f'{SCALAR_DOT_NAME}(', body)
        detail = 'dot() of scalars goes through overloads, since WGSL takes vectors only'
    elif RUNTIME_CONSTANT_MESSAGE in error.output and error.body_line is not None:
        before = set(repairs.inlined_constants)
        repaired = inline_runtime_constants(body, error.body_line, repairs.inlined_constants)
        detail = f'const {", ".join(sorted(repairs.inlined_constants - before))} evaluated where read, as naga cannot fold them'
    else:
        return None
    if repaired is not None:
        context.report.add(SEVERITY_NOTE, CODE_GLSL_REPAIRED, f'{context.instance.name}: {detail}')
    return repaired


# naga

def find_naga(executable: str) -> str:
    """Returns the naga executable after checking that it is the pinned version, whose output the converter expects."""
    path = shutil.which(executable)
    if path is None:
        raise ConversionError(CODE_NAGA_UNAVAILABLE, f'{executable} not found; install it with {NAGA_INSTALL_COMMAND}')
    result = subprocess.run([path, '--version'], capture_output=True, text=True, check=False)
    version = result.stdout.strip()
    if version != NAGA_VERSION:
        raise ConversionError(CODE_NAGA_UNAVAILABLE, f'naga {version or "of unknown version"}, expected {NAGA_VERSION}: {NAGA_INSTALL_COMMAND}')
    return path


def clean_naga_output(output: str) -> str:
    return ANSI_ESCAPE_PATTERN.sub('', output).strip()


def summarize_naga_message(output: str) -> str:
    """Returns naga's first message, with its first note."""
    cleaned = clean_naga_output(output)
    message_match = NAGA_MESSAGE_PATTERN.search(cleaned)
    message = message_match.group(1).strip() if message_match else cleaned.split('\n')[0]
    notes = [line.strip()[len(NAGA_NOTE_PREFIX):].strip() for line in cleaned.split('\n') if line.strip().startswith(NAGA_NOTE_PREFIX)]
    return f'{message} ({notes[0]})' if notes else message


class NagaTranslationError(ConversionError):
    """A naga GLSL failure, with its output and the 0-based body line it names, if any, for the repairs to read."""

    def __init__(self, detail: str, output: str, body_line: int | None) -> None:
        super().__init__(CODE_GLSL_TRANSLATION_FAILED, detail)
        self.output = output
        self.body_line = body_line


def translate_GLSL(naga: str, wrapper: str, context: PassContext, directory: Path) -> str:
    input_path = directory / (GLSL_COMPUTE_FILE_NAME if context.is_compute else GLSL_FRAGMENT_FILE_NAME)
    output_path = directory / WGSL_FILE_NAME
    input_path.write_text(wrapper, encoding='utf-8', newline='\n')
    stage = NAGA_COMPUTE_STAGE if context.is_compute else NAGA_FRAGMENT_STAGE
    command = [naga, '--input-kind', NAGA_GLSL_INPUT_KIND, '--shader-stage', stage, input_path.name, output_path.name]
    result = subprocess.run(command, capture_output=True, text=True, cwd=directory, check=False)
    if result.returncode == 0:
        return output_path.read_text(encoding='utf-8')
    output = clean_naga_output(result.stderr + result.stdout)
    location_match = NAGA_LOCATION_PATTERN.search(output)
    body_line = int(location_match.group(1)) - context.prelude_line_count - 1 if location_match else None
    if body_line is None:
        location = 'unknown line'
    elif body_line < 0:
        location = 'the converter prelude'
        body_line = None
    else:
        location = f'line {context.mpv_pass.body_line_number + body_line}'
    raise NagaTranslationError(f'{location}: {summarize_naga_message(output)}', output, body_line)


def validate_WGSL(naga: str, module: str, directory: Path) -> str | None:
    """Validates a WGSL module with naga; returns naga's message on failure."""
    path = directory / VALIDATION_FILE_NAME
    path.write_text(module, encoding='utf-8', newline='\n')
    result = subprocess.run([naga, path.name], capture_output=True, text=True, cwd=directory, check=False)
    return None if result.returncode == 0 else summarize_naga_message(result.stderr + result.stdout)


# WGSL post-processing

@dataclass
class WGSLItem:
    text: str
    kind: str
    name: str
    attributes: str


def split_WGSL_items(text: str) -> list[WGSLItem]:
    """Splits naga's WGSL into module-scope items: each ends at a ';' or a closing '}' at depth 0."""
    items: list[WGSLItem] = []
    position = 0
    while position < len(text):
        while position < len(text) and text[position].isspace():
            position += 1
        if position >= len(text):
            break
        start = position
        depth = 0
        while position < len(text):
            character = text[position]
            position += 1
            if character in '({[':
                depth += 1
            elif character in ')}]':
                depth -= 1
                if character == '}' and depth == 0:
                    break
            elif character == ';' and depth == 0:
                break
        item_text = text[start:position]
        declaration = WGSL_DECLARATION_PATTERN.match(item_text)
        if declaration is None:
            items.append(WGSLItem(item_text, WGSL_DIRECTIVE, '', ''))
            continue
        items.append(WGSLItem(item_text, declaration.group(2), declaration.group(3), declaration.group(1)))
    return items


def measure_WGSL_type(type_text: str) -> int | None:
    """Returns a WGSL type's byte size by WGSL's layout rules, innermost array first; None for a struct or unknown type."""
    text = re.sub(r'\s+', '', type_text)
    text = re.sub(r'vec([234])([fiuh])\b', lambda match: f'vec{match.group(1)}<{WGSL_SHORTHAND_SCALARS[match.group(2)]}>', text)
    text = re.sub(r'mat([234])x([234])([fh])\b',
                  lambda match: f'mat{match.group(1)}x{match.group(2)}<{WGSL_SHORTHAND_SCALARS[match.group(3)]}>', text)
    text = re.sub(r'atomic<(i32|u32)>', r'\1', text)

    def vector_layout(count: int, scalar: str) -> tuple[int, int]:
        size = WGSL_SCALAR_SIZES[scalar]
        return count * size, (2 if count == 2 else 4) * size

    def replace_matrix(match: re.Match[str]) -> str:
        column_size, alignment = vector_layout(int(match.group(2)), match.group(3))
        return f'#{int(match.group(1)) * -(-column_size // alignment) * alignment}:{alignment}'

    def replace_vector(match: re.Match[str]) -> str:
        size, alignment = vector_layout(int(match.group(1)), match.group(2))
        return f'#{size}:{alignment}'

    text = re.sub(r'mat([234])x([234])<(f32|f16)>', replace_matrix, text)
    text = re.sub(r'vec([234])<(f32|i32|u32|bool|f16)>', replace_vector, text)
    text = re.sub(r'\b(f32|i32|u32|bool|f16)\b', lambda match: f'#{WGSL_SCALAR_SIZES[match.group(1)]}:{WGSL_SCALAR_SIZES[match.group(1)]}', text)
    array_pattern = re.compile(r'array<#(\d+):(\d+),(\d+)u?>')
    array_match = array_pattern.search(text)
    while array_match is not None:
        size, alignment, count = (int(group) for group in array_match.groups())
        text = text[:array_match.start()] + f'#{-(-size // alignment) * alignment * count}:{alignment}' + text[array_match.end():]
        array_match = array_pattern.search(text)
    layout_match = re.fullmatch(r'#(\d+):\d+', text)
    return int(layout_match.group(1)) if layout_match else None


@dataclass
class TranslatedBody:
    """naga's WGSL without its entry point and stubs, with the glue the body calls, and what they read."""

    text: str
    engine_inputs: set[str]
    parameters: set[str]
    helpers: set[str]
    private_names: set[str]


def postprocess_WGSL(context: PassContext, WGSL: str) -> TranslatedBody:
    """Removes naga's entry point and stubs, binds the stubs the body calls to glue, and renames shadowing declarations."""
    items = split_WGSL_items(EXTRA_BARRIER_PATTERN.sub('', WGSL))
    entry_items = [item for item in items if any(attribute in item.attributes for attribute in ENTRY_ATTRIBUTES)]
    entry_calls: set[str] = set()
    for item in entry_items:
        entry_calls |= set(WGSL_CALL_PATTERN.findall(item.text))
    stub_names = set(context.stubs)
    body_items: list[WGSLItem] = []
    for item in items:
        is_entry = item in entry_items or (item.kind == WGSL_FUNCTION and item.name in entry_calls and item.name.startswith(ENTRY_FUNCTION_PREFIX))
        is_input_output = item.kind == WGSL_STRUCT and any(attribute in item.text for attribute in INPUT_OUTPUT_ATTRIBUTES)
        if is_entry or is_input_output or item.kind == WGSL_DIRECTIVE or item.name == FRAGMENT_OUTPUT_NAME or item.name in stub_names:
            continue
        body_items.append(item)
    called: set[str] = set()
    read_names: set[str] = set()
    for item in body_items:
        called |= set(WGSL_CALL_PATTERN.findall(item.text))
        if item.kind == WGSL_FUNCTION:
            read_names |= set(WGSL_IDENTIFIER_PATTERN.findall(item.text))
    pending = [name for name in context.stubs if name in called]
    included: list[str] = []
    while pending:
        name = pending.pop(0)
        if name in included or name not in context.glue:
            continue
        included.append(name)
        pending.extend(context.glue[name].dependencies)
    translated = TranslatedBody('', set(), set(), set(), set())
    for name in included:
        function = context.glue[name]
        translated.engine_inputs.update(function.engine_inputs)
        translated.parameters.update(function.parameters)
        translated.helpers.update(function.helpers)
        if function.finding is not None:
            context.report.add(function.finding.severity, function.finding.code, function.finding.detail)
    # The converter's own private globals stay only while the body reads them
    converter_privates = {item.name for item in body_items if item.kind == WGSL_PRIVATE_VARIABLE and item.name.startswith(STUB_PREFIX)}
    translated.private_names = converter_privates & read_names
    body_items = [item for item in body_items if item.name not in converter_privates - translated.private_names]
    reserved = set(PRELUDE_NAMES)
    for engine_input in (HOOKED_NAME, *ENGINE_STAGES, *(saved.engine_name for saved in context.state.saved_textures.values())):
        reserved |= {engine_input + suffix for suffix in ACCESSOR_SUFFIXES}
    rename_user_declarations(body_items, reserved)
    workgroup_bytes = 0
    for item in body_items:
        type_match = WORKGROUP_VARIABLE_PATTERN.match(item.text) if item.kind == WGSL_WORKGROUP_VARIABLE else None
        workgroup_bytes += (measure_WGSL_type(type_match.group(1)) or 0) if type_match else 0
    if workgroup_bytes > MAXIMUM_WORKGROUP_STORAGE_BYTES:
        raise ConversionError(CODE_WORKGROUP_STORAGE_LIMIT,
                              f'{context.instance.name}: {workgroup_bytes} bytes of shared memory; WebGPU allows {MAXIMUM_WORKGROUP_STORAGE_BYTES}')
    parts = [item.text.strip() for item in body_items] + [context.glue[name].text for name in included]
    translated.text = '\n\n'.join(parts)
    return translated


def rename_user_declarations(items: list[WGSLItem], reserved: set[str]) -> None:
    """Renames body declarations that would shadow names the generated code reads from the prelude."""
    renames = {item.name: USER_RENAME_PREFIX + item.name for item in items if item.name in reserved}
    if not renames:
        return
    for item in items:
        if item.kind == WGSL_STRUCT:
            continue
        item.text = replace_identifiers(item.text, renames)
        item.name = renames.get(item.name, item.name)


def collect_helpers(helpers: set[str]) -> list[str]:
    """Returns the helpers and the helpers they call, each after its dependencies."""
    ordered: list[str] = []
    pending = sorted(helpers)
    while pending:
        helper = pending.pop(0)
        if helper in ordered:
            continue
        missing = [dependency for dependency in HELPER_DEPENDENCIES.get(helper, ()) if dependency not in ordered]
        if missing:
            pending = [*missing, helper, *pending]
            continue
        ordered.append(helper)
    return ordered


# Expressions of a pass

def get_symbolic_size(name: str, axis: str, context: PassContext) -> list[RPNToken]:
    """Returns a texture's size as RPN over plan-time facts, as far as the passes before it determine it."""
    state = context.state
    image_size = (state.image_width, state.image_height)
    axis_index = 0 if axis == AXIS_WIDTH else 1
    name = normalize_texture_name(name)
    if name in (HOOKED_NAME, context.instance.hook):
        stage = context.instance.mapping.engine_stage
        return list((image_size if stage in PRESCALE_STAGES else OUTPUT_SIZE)[axis_index])
    if name == OUTPUT_NAME:
        return list(OUTPUT_SIZE[axis_index])
    if name == NATIVE_CROPPED_NAME:
        return list(SOURCE_SIZE[axis_index])
    if name in state.saved_textures:
        saved = state.saved_textures[name]
        return list(saved.width if axis_index == 0 else saved.height)
    if name in context.shader.textures:
        size = context.shader.textures[name].size
        return [number_token(size[axis_index] if axis_index < len(size) else 1)]
    mapping = HOOK_MAPPINGS.get(name)
    if mapping is not None:
        return list((image_size if mapping.engine_stage in PRESCALE_STAGES else OUTPUT_SIZE)[axis_index])
    raise ConversionError(CODE_EXPRESSION_NAME_UNKNOWN, f'{context.instance.name}: {name}')


def get_parameter_value(name: str, context: PassContext, used_at: str) -> Decimal:
    """Returns a parameter's default or an enum label's value, for expressions that plan before any value is set."""
    found = context.shader.find_parameter(name)
    if found is None:
        raise ConversionError(CODE_EXPRESSION_NAME_UNKNOWN, f'{context.instance.name}: {name} in {used_at}')
    parameter, enum_value = found
    if enum_value is not None:
        return Decimal(enum_value)
    if parameter.is_tunable:
        context.report.add(SEVERITY_WARNING, CODE_PARAMETER_INLINED, f'{context.instance.name}: {name} in {used_at} takes its default')
    return number_token(parameter.default_value).value


def expand_symbolic(tokens: list[RPNToken], context: PassContext, keep: Callable[[str], bool], used_at: str) -> list[RPNToken]:
    """Replaces size tokens the expression cannot read directly with symbolic sizes, and parameters with their defaults."""
    expanded: list[RPNToken] = []
    for token in tokens:
        if token.kind == TOKEN_SIZE and not keep(token.texture):
            expanded.extend(get_symbolic_size(token.texture, token.axis, context))
        elif token.kind == TOKEN_VARIABLE:
            expanded.append(number_token(get_parameter_value(token.text, context, used_at)))
        else:
            expanded.append(token)
    return expanded


def reject_size(token: RPNToken) -> str:
    raise ConversionError(CODE_EXPRESSION_INVALID, f'{token.text} has no symbolic size')


def reject_variable(name: str) -> str:
    raise ConversionError(CODE_EXPRESSION_INVALID, f'{name} was not inlined')


def render_plan_expression(tokens: list[RPNToken], context: PassContext) -> str:
    """Renders an expression over plan-time facts alone, as `when` reads them."""
    expanded = expand_symbolic(tokens, context, lambda name: False, 'WHEN')
    return render_RPN(expanded, ENGINE_SYNTAX, reject_size, reject_variable)


def get_size_input(name: str, context: PassContext, declared_inputs: set[str]) -> str | None:
    """Returns the input whose size a size token reads directly in `output`: HOOKED, or a declared input; else None."""
    name = normalize_texture_name(name)
    if name in (HOOKED_NAME, context.instance.hook):
        return HOOKED_NAME
    source_index = context.visible.get(name)
    if source_index is None:
        return None
    engine_input = context.sources[source_index].engine_input
    return engine_input if engine_input in declared_inputs else None


def render_size_expression(tokens: list[RPNToken], context: PassContext, declared_inputs: set[str]) -> str:
    """Renders WIDTH or HEIGHT for `output`, which reads HOOKED's and declared inputs' sizes, and plan-time facts."""
    def keep(name: str) -> bool:
        return get_size_input(name, context, declared_inputs) is not None

    def resolve_size(token: RPNToken) -> str:
        return f'{get_size_input(token.texture, context, declared_inputs)}.{token.axis}'

    expanded = expand_symbolic(tokens, context, keep, 'WIDTH or HEIGHT')
    return render_RPN(expanded, ENGINE_SYNTAX, resolve_size, reject_variable)


def render_size_WGSL(tokens: list[RPNToken] | None, axis: str, context: PassContext) -> str:
    """Renders WIDTH or HEIGHT in WGSL, which gl_FragCoord needs, since a kernel sees only its coordinate."""
    hooked_size = f'HOOKED_size().{WGSL_AXES[axis]}'
    if tokens is None:
        return hooked_size
    expanded = expand_symbolic(tokens, context, lambda name: normalize_texture_name(name) in (HOOKED_NAME, context.instance.hook), 'WIDTH or HEIGHT')
    return render_RPN(expanded, WGSL_SYNTAX, lambda token: f'HOOKED_size().{WGSL_AXES[token.axis]}', reject_variable)


def render_WGSL_condition(tokens: list[RPNToken], context: PassContext, used_parameters: set[str]) -> str:
    """Renders WHEN as WGSL that runs every frame and reads parameters live; sizes other than HOOKED's are symbolic."""
    sized: list[RPNToken] = []
    for token in tokens:
        if token.kind == TOKEN_SIZE and normalize_texture_name(token.texture) not in (HOOKED_NAME, context.instance.hook):
            sized.extend(get_symbolic_size(token.texture, token.axis, context))
        else:
            sized.append(token)

    def resolve_variable(name: str) -> str:
        found = context.shader.find_parameter(name)
        if found is None:
            raise ConversionError(CODE_EXPRESSION_NAME_UNKNOWN, f'{context.instance.name}: {name} in WHEN')
        parameter, enum_value = found
        if enum_value is not None:
            return WGSL_SYNTAX.number(Decimal(enum_value))
        if not parameter.is_tunable:
            return WGSL_SYNTAX.number(number_token(parameter.default_value).value)
        used_parameters.add(parameter.name)
        return f'f32({PARAMETERS_VARIABLE}.{parameter.engine_name})'

    return render_RPN(sized, WGSL_SYNTAX, lambda token: f'HOOKED_size().{WGSL_AXES[token.axis]}', resolve_variable)


def is_same_size(tokens: list[RPNToken] | None, axis: str, context: PassContext) -> bool:
    if tokens is None:
        return True
    return (len(tokens) == 1 and tokens[0].kind == TOKEN_SIZE and tokens[0].axis == axis
            and tokens[0].texture in (HOOKED_NAME, context.instance.hook))


def reads_tunable_parameters(tokens: list[RPNToken] | None, shader: ParsedShader) -> bool:
    if tokens is None:
        return False
    for token in tokens:
        found = shader.find_parameter(token.text) if token.kind == TOKEN_VARIABLE else None
        if found is not None and found[1] is None and found[0].is_tunable:
            return True
    return False


# Conversion

@dataclass
class ConvertedPass:
    name: str
    text: str


def resolve_sources(context: PassContext) -> None:
    """Assigns every visible texture name its source, one stub prefix per distinct source."""
    indices: dict[TextureSource, int] = {}
    for name in get_visible_names(context.mpv_pass, context.instance.hook):
        source = resolve_texture(name, context.instance, context.shader, context.state, context.report)
        if source not in indices:
            indices[source] = len(context.sources)
            context.sources.append(source)
        context.visible[name] = indices[source]


def get_engine_save_name(name: str, state: PipelineState, report: Report) -> str:
    """Returns the engine name a saved texture takes: its own, unless the pass API reserves it or another texture holds it."""
    if name in state.engine_save_names:
        return state.engine_save_names[name]
    engine_name = INVALID_IDENTIFIER_CHARACTER_PATTERN.sub('_', name)
    if (engine_name in ENGINE_RESERVED_TEXTURE_NAMES or engine_name in HOOK_MAPPINGS or not IDENTIFIER_PATTERN.match(engine_name)
            or HISTORY_SUFFIX_PATTERN.search(engine_name) or engine_name.startswith(RESERVED_IDENTIFIER_PREFIX)):
        engine_name = SAVED_NAME_PREFIX + engine_name
    taken = set(state.engine_save_names.values())
    candidate = engine_name
    suffix = 2
    while candidate in taken:
        candidate = f'{engine_name}_{suffix}'
        suffix += 1
    if candidate != name:
        report.add(SEVERITY_NOTE, CODE_SAVE_RENAMED, f'{name} -> {candidate}')
    state.engine_save_names[name] = candidate
    return candidate


def plan_state_update(context: PassContext, plan_condition: list[RPNToken]) -> StateUpdate:
    """Works out what the pass leaves for later passes: a saved texture's size, or the RGB image's new size."""
    mpv_pass = context.mpv_pass

    def symbolic(tokens: list[RPNToken] | None, axis: str) -> list[RPNToken]:
        if tokens is None:
            return get_symbolic_size(HOOKED_NAME, axis, context)
        return expand_symbolic(tokens, context, lambda name: False, 'WIDTH or HEIGHT')

    width = symbolic(mpv_pass.width, AXIS_WIDTH)
    height = symbolic(mpv_pass.height, AXIS_HEIGHT)
    if not context.overwrites_hooked():
        assert mpv_pass.save is not None
        save_name = get_engine_save_name(mpv_pass.save, context.state, context.report)
        return StateUpdate(save_name, SavedTexture(save_name, width, height))
    if not context.instance.mapping.resizable or (mpv_pass.width is None and mpv_pass.height is None):
        return StateUpdate()
    if not plan_condition:
        return StateUpdate(image_size=(width, height))
    # A pass that may not run leaves the image at either size, which only the condition decides
    condition = expand_symbolic(plan_condition, context, lambda name: False, 'WHEN')
    state = context.state
    return StateUpdate(image_size=(select_tokens(condition, width, state.image_width), select_tokens(condition, height, state.image_height)))


def apply_state_update(state: PipelineState, mpv_pass: MPVPass, update: StateUpdate) -> None:
    if update.saved_texture is not None and mpv_pass.save is not None:
        state.saved_textures[mpv_pass.save] = update.saved_texture
    if update.image_size is not None:
        state.image_width, state.image_height = update.image_size


def build_entry(context: PassContext, private_names: set[str], guard: str | None) -> tuple[str, OutputExpression]:
    """Builds the pass's entry point, which sets the mpv globals the body reads, then runs hook()."""
    mpv_pass = context.mpv_pass
    if not context.is_compute:
        lines = [KERNEL_ENTRY]
        if POSITION_NAME in private_names:
            lines.append(f'    {POSITION_NAME} = coordinate;')
        if FRAGMENT_COORDINATE_NAME in private_names:
            target_size = f'round(vec2f({render_size_WGSL(mpv_pass.width, AXIS_WIDTH, context)}, {render_size_WGSL(mpv_pass.height, AXIS_HEIGHT, context)}))'
            lines.append(f'    {FRAGMENT_COORDINATE_NAME} = vec4f(coordinate * {target_size}, 0.0, 1.0);')
        if guard is not None:
            lines.extend(['    // WHEN reads parameters, so it runs every frame: a skipped pass presents the hooked image unchanged',
                          f'    if ({guard} == 0.0) {{', '        return HOOKED_tex(coordinate);', '    }'])
        output = get_output_expression(context, 'result', 'coordinate')
        lines.extend(['    let result = hook();', f'    return {output.text};', '}'])
        inputs = (*output.engine_inputs, HOOKED_NAME) if guard is not None else output.engine_inputs
        return '\n'.join(lines), OutputExpression(output.text, output.helpers, inputs)
    assert mpv_pass.thread_size is not None and mpv_pass.block_size is not None
    thread_width, thread_height = mpv_pass.thread_size
    block_width, block_height = mpv_pass.block_size
    assignments = {
        GLOBAL_INVOCATION_NAME: 'id',
        LOCAL_INVOCATION_NAME: f'id % {WORKGROUP_SIZE_CONSTANT}',
        WORKGROUP_NAME: f'id / {WORKGROUP_SIZE_CONSTANT}',
        LOCAL_INDEX_NAME: f'(id.x % {thread_width}u) + (id.y % {thread_height}u) * {thread_width}u',
        WORKGROUP_COUNT_NAME: f'vec3u((TARGET_size() + vec2u({block_width - 1}u, {block_height - 1}u)) / vec2u({block_width}u, {block_height}u), 1u)',
        POSITION_NAME: '(vec2f(id.xy) + vec2f(0.5)) / vec2f(TARGET_size())'
    }
    lines = [f'const {WORKGROUP_SIZE_CONSTANT} = vec3u({thread_width}u, {thread_height}u, 1u);', '', COMPUTE_ENTRY]
    lines.extend(f'    {name} = {value};' for name, value in assignments.items() if name in private_names)
    helpers: tuple[str, ...] = ()
    inputs: tuple[str, ...] = ()
    if guard is not None:
        identity = get_output_expression(context, 'HOOKED_tex(position)', 'position')
        helpers = identity.helpers
        inputs = (*identity.engine_inputs, HOOKED_NAME)
        lines.extend([
            '    // WHEN reads parameters, so it runs every frame: a skipped pass stores its block of the hooked image unchanged',
            f'    if ({guard} == 0.0) {{',
            f'        let blockOrigin = (id.xy / {WORKGROUP_SIZE_CONSTANT}.xy) * vec2u({block_width}u, {block_height}u);',
            f'        for (var row = id.y % {thread_height}u; row < {block_height}u; row += {thread_height}u) {{',
            f'            for (var column = id.x % {thread_width}u; column < {block_width}u; column += {thread_width}u) {{',
            '                let texel = blockOrigin + vec2u(column, row);',
            '                if (all(texel < TARGET_size())) {',
            '                    let position = (vec2f(texel) + vec2f(0.5)) / vec2f(TARGET_size());',
            f'                    TARGET_store(texel, {identity.text});',
            '                }',
            '            }',
            '        }',
            '        return;',
            '    }'
        ])
    lines.extend(['    hook();', '}'])
    return '\n'.join(lines), OutputExpression('', helpers, inputs)


def build_validation_module(context: PassContext, body: str, inputs: list[str], parameters: list[MPVParameter], output_format: str) -> str:
    """Builds a module of the pass API's documented declarations around the body, which naga then validates."""
    lines = [
        'struct PresentationUniforms {',
        '    textureScale: vec2f,', '    textureOffset: vec2f,', '    sourceSize: vec2f,', '    outputSize: vec2f,',
        '    inputSize: vec2f,', '    timestampSeconds: f32,', '    frameIndex: u32,', '    historyValid: u32,',
        '    skippedFrames: u32,', '    fieldState: u32,', '    padding0: u32,', '}',
        '@group(0) @binding(0) var<uniform> presentation: PresentationUniforms;',
        '@group(0) @binding(1) var validationSampler: sampler;'
    ]
    binding = 2
    if parameters:
        lines.append('struct PassParameters {')
        lines.extend(f'    {parameter.engine_name}: {ENGINE_PARAMETER_TYPES[parameter.type_name]},' for parameter in parameters)
        lines.extend(['}', f'@group(0) @binding({binding}) var<uniform> parameters: PassParameters;'])
        binding += 1
    for engine_input in inputs or [HOOKED_NAME]:
        lines.extend([
            f'@group(0) @binding({binding}) var {engine_input}_texture: texture_2d<f32>;',
            f'fn {engine_input}_size() -> vec2f {{ return vec2f(textureDimensions({engine_input}_texture)); }}',
            f'fn {engine_input}_pt() -> vec2f {{ return 1.0 / {engine_input}_size(); }}',
            f'fn {engine_input}_tex(coordinate: vec2f) -> vec4f {{ return textureSampleLevel({engine_input}_texture, validationSampler, coordinate, 0.0); }}',
            f'fn {engine_input}_texOff(coordinate: vec2f, offsetInPixels: vec2f) -> vec4f {{ return {engine_input}_tex(coordinate + offsetInPixels * {engine_input}_pt()); }}'
        ])
        binding += 1
    if context.is_compute:
        assert context.mpv_pass.thread_size is not None
        thread_width, thread_height = context.mpv_pass.thread_size
        lines.extend([
            f'@group(0) @binding({binding}) var TARGET_texture: texture_storage_2d<{output_format}, write>;',
            'fn TARGET_size() -> vec2u { return textureDimensions(TARGET_texture); }',
            'fn TARGET_store(position: vec2u, value: vec4f) { textureStore(TARGET_texture, position, value); }',
            body,
            f'@compute @workgroup_size({thread_width}, {thread_height}, 1)',
            'fn validationCompute(@builtin(global_invocation_id) id: vec3u) { compute(id); }'
        ])
    else:
        lines.extend([body, '@fragment',
                      'fn validationFragment(@builtin(position) position: vec4f) -> @location(0) vec4f { return kernel(position.xy); }'])
    return '\n'.join(lines) + '\n'


def format_parameter_number(value: int | float, type_name: str) -> str:
    return repr(float(value)) if type_name == PARAMETER_TYPE_FLOAT else str(value)


def get_plan_condition(context: PassContext, in_place: bool) -> tuple[list[RPNToken], list[RPNToken] | None]:
    """Splits WHEN into the plan-time `when` and a condition that runs every frame.

    WHEN runs every frame when it reads parameters and the pass can be skipped by presenting its image unchanged.
    Otherwise the parameters' defaults stand in, and the SDR or HDR variant's condition joins it.
    """
    mpv_pass = context.mpv_pass
    instance = context.instance
    runtime: list[RPNToken] | None = None
    plan: list[RPNToken] = []
    if mpv_pass.condition is not None and reads_tunable_parameters(mpv_pass.condition, context.shader) and in_place:
        runtime = mpv_pass.condition
    elif mpv_pass.condition is not None:
        plan = list(mpv_pass.condition)
    if instance.variant_condition:
        plan = [*plan, *instance.variant_condition, binary_token('*')] if plan else list(instance.variant_condition)
    return plan, runtime


def translate_with_repairs(context: PassContext, naga: str, directory: Path) -> str:
    """Translates the pass's GLSL with naga, repairing each construct naga rejects that has a known repair, then retrying."""
    body = prepare_GLSL_body(context)
    repairs = GLSLRepairs()
    for attempt in range(MAXIMUM_REPAIRS):
        try:
            return translate_GLSL(naga, build_GLSL_wrapper(context, body, repairs.extra_prelude), context, directory)
        except NagaTranslationError as error:
            repaired = repair_GLSL(body, error, repairs, context)
            if repaired is None or attempt == MAXIMUM_REPAIRS - 1:
                raise
            body = repaired
    raise ConversionError(CODE_GLSL_TRANSLATION_FAILED, f'{context.instance.name}: no attempt ran')


def convert_instance(context: PassContext, naga: str, directory: Path) -> ConvertedPass:
    instance = context.instance
    mpv_pass = context.mpv_pass
    resolve_sources(context)
    in_place = (context.overwrites_hooked() and is_same_size(mpv_pass.width, AXIS_WIDTH, context)
                and is_same_size(mpv_pass.height, AXIS_HEIGHT, context))
    plan_condition, runtime_condition = get_plan_condition(context, in_place)
    context.state_update = plan_state_update(context, plan_condition)
    for source_index, source in enumerate(context.sources):
        context.glue.update(build_texture_glue(context, source_index) if source.texture_name else build_engine_glue(context, source_index))
    context.glue.update(build_shared_glue(context))
    if context.is_compute:
        assert mpv_pass.thread_size is not None
        thread_width, thread_height = mpv_pass.thread_size
        if max(thread_width, thread_height) > MAXIMUM_WORKGROUP_AXIS or thread_width * thread_height > MAXIMUM_WORKGROUP_INVOCATIONS:
            raise ConversionError(CODE_WORKGROUP_LIMIT,
                                  f'{instance.name}: {thread_width}x{thread_height} threads; WebGPU allows {MAXIMUM_WORKGROUP_INVOCATIONS}')
    translated = postprocess_WGSL(context, translate_with_repairs(context, naga, directory))
    used_parameters = set(translated.parameters)
    guard = None
    if runtime_condition is not None:
        guard = render_WGSL_condition(runtime_condition, context, used_parameters)
        context.report.add(SEVERITY_NOTE, CODE_CONDITION_RUNTIME, f'{instance.name}: WHEN reads parameters, so it runs every frame')
    entry, entry_output = build_entry(context, translated.private_names, guard)
    helpers = translated.helpers | set(entry_output.helpers)
    engine_inputs = translated.engine_inputs | set(entry_output.engine_inputs)
    if instance.mapping.plane in EMULATED_PLANES and context.overwrites_hooked():
        context.report.add(SEVERITY_NOTE, CODE_HOOK_EMULATED, f'{instance.name}: {instance.hook} joins the RGB image through BT.709')
    if instance.linear_scale is not None:
        context.report.add(SEVERITY_NOTE, CODE_HOOK_EMULATED, f'{instance.name}: {instance.hook} reads linear light over {instance.linear_scale} nits')

    ordered_inputs = [HOOKED_NAME] if HOOKED_NAME in engine_inputs else []
    for source in context.sources:
        if source.engine_input in engine_inputs and source.engine_input not in ordered_inputs:
            ordered_inputs.append(source.engine_input)
    declared_inputs = set(ordered_inputs)
    width = render_size_expression(mpv_pass.width, context, declared_inputs) if mpv_pass.width else f'{HOOKED_NAME}.{AXIS_WIDTH}'
    height = render_size_expression(mpv_pass.height, context, declared_inputs) if mpv_pass.height else f'{HOOKED_NAME}.{AXIS_HEIGHT}'
    saves = not context.overwrites_hooked()
    component_formats = COMPUTE_COMPONENT_FORMATS if context.is_compute else KERNEL_COMPONENT_FORMATS
    output_format = component_formats.get(mpv_pass.components or 0, INTERMEDIATE_FORMAT) if saves else INTERMEDIATE_FORMAT
    header_lines = [f'//! name: {instance.name}', f'//! shape: {SHAPE_COMPUTE if context.is_compute else SHAPE_KERNEL}',
                    f'//! hook: {instance.mapping.engine_stage}', f'//! domain: {instance.mapping.domain}']
    header_lines.extend(f'//! input: {engine_input}' for engine_input in ordered_inputs)
    if saves:
        header_lines.append(f'//! save: {context.state_update.save_name}')
    header_lines.append(f'//! output: {width}, {height}, {output_format}')
    if saves and mpv_pass.components:
        header_lines.append(f'//! components: {min(max(mpv_pass.components, 1), MAXIMUM_COMPONENTS)}')
    if plan_condition:
        header_lines.append(f'//! when: {render_plan_expression(plan_condition, context)}')
    if context.is_compute:
        assert mpv_pass.block_size is not None and mpv_pass.thread_size is not None
        header_lines.append(f'//! workgroup: {mpv_pass.thread_size[0]}, {mpv_pass.thread_size[1]}')
        header_lines.append(f'//! dispatch: ceil(round({width}) / {mpv_pass.block_size[0]}), ceil(round({height}) / {mpv_pass.block_size[1]})')
    declared_parameters = [parameter for parameter in context.shader.parameters.values() if parameter.name in used_parameters]
    if len(declared_parameters) > MAXIMUM_PARAMETER_COUNT:
        raise ConversionError(CODE_PARAMETER_LIMIT, f'{instance.name}: {len(declared_parameters)} parameters')
    for parameter in declared_parameters:
        values = [format_parameter_number(value, parameter.type_name) for value in (parameter.default_value, parameter.minimum, parameter.maximum)]
        header_lines.append(f'//! param {parameter.engine_name}: {ENGINE_PARAMETER_TYPES[parameter.type_name]} = {values[0]} in [{values[1]}, {values[2]}]')
    for parameter in context.shader.parameters.values():
        if not parameter.is_tunable and re.search(rf'(?<!\w){re.escape(parameter.name)}(?!\w)', mpv_pass.body):
            context.report.add(SEVERITY_NOTE, CODE_PARAMETER_BAKED, f'{instance.name}: {parameter.mode} {parameter.name} is {parameter.default_value}')
    parts: list[str] = []
    if instance.linear_scale is not None:
        parts.append(f'const {LINEAR_SCALE_CONSTANT} = {WGSL_float(instance.linear_scale)};')
    parts.extend(HELPER_FUNCTIONS[helper] for helper in collect_helpers(helpers))
    parts.extend([translated.text, entry])
    body = '\n\n'.join(part for part in parts if part)
    message = validate_WGSL(naga, build_validation_module(context, body, ordered_inputs, declared_parameters, output_format), directory)
    if message is not None:
        raise ConversionError(CODE_WGSL_INVALID, f'{instance.name}: {message}')
    return ConvertedPass(instance.name, '\n'.join(header_lines) + '\n\n' + body + '\n')


def convert_shader(text: str, default_name: str, naga: str, source_name: str, report: Report) -> str | None:
    """Converts a user shader into a pass file's text; returns None when any pass fails."""
    shader = parse_shader(text, report)
    instances = expand_passes(shader, default_name, report)
    state = PipelineState()
    converted: list[ConvertedPass] = []
    with tempfile.TemporaryDirectory(prefix='convert_mpv_shader_') as directory_name:
        directory = Path(directory_name)
        for instance in instances:
            context = PassContext(instance, shader, state, report)
            try:
                converted.append(convert_instance(context, naga, directory))
            except ConversionError as error:
                report.add(SEVERITY_ERROR, error.code, error.detail)
            finally:
                apply_state_update(state, instance.mpv_pass, context.state_update)
    if report.has_errors() or not converted:
        return None
    # Only blank lines may precede the first header, so the provenance opens the first pass's body
    provenance = f'// Converted from {source_name} by {CONVERTER_PATH} with naga {NAGA_VERSION}\n'
    first = converted[0].text
    header_end = first.index('\n\n') + 2
    texts = [first[:header_end] + provenance + '\n' + first[header_end:], *(converted_pass.text for converted_pass in converted[1:])]
    return '\n'.join(texts)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('input')
    parser.add_argument('output')
    parser.add_argument('--name', help='the name of passes without a DESC; defaults to the input file name')
    parser.add_argument('--naga', default=NAGA_EXECUTABLE, help=f'the naga {NAGA_VERSION} executable')
    arguments = parser.parse_args()
    input_path = Path(arguments.input)
    report = Report()
    result: str | None = None
    try:
        naga = find_naga(arguments.naga)
        result = convert_shader(input_path.read_text(encoding='utf-8'), arguments.name or input_path.stem, naga, input_path.name, report)
    except ConversionError as error:
        report.add(SEVERITY_ERROR, error.code, error.detail)
    for finding in report.findings:
        print(f'{finding.severity} {finding.code}: {finding.detail}')
    if result is None:
        print(f'{input_path.name}: not converted')
        return 1
    Path(arguments.output).write_text(result, encoding='utf-8', newline='\n')
    print(f'{input_path.name}: {result.count("//! name: ")} passes -> {arguments.output}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
