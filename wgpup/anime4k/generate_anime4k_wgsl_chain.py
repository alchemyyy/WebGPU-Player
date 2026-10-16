"""Converts an Anime4K v3.2 Upscale(+Denoise) CNN x2 mpv GLSL shader into a chain of webgpu-player compute passes.

Each network layer becomes one compute pass: one invocation per source pixel computes all of the layer's parts
(the GLSL runs one pass per 4 channels) and stores them side by side, part p at x + p * source width, in rgba16float.
The last layer also does the depth-to-space step and adds the bilinear-upscaled input, writing the 2x image.
The passes go into one file in order, as mpv's user shaders hold theirs, and the engine runs them in file order.

Usage: generate_anime4k_wgsl_chain.py <input.glsl> <output.wgsl> [--name <pass name prefix>]
"""

import argparse
import re
import sys
from dataclasses import dataclass, field

MAIN_NAME = 'MAIN'
HOOKED_NAME = 'HOOKED'
WORKGROUP_SIZE = 8
CHANNELS_PER_PART = 4
OUTPUT_PARTS = 3
NEIGHBOR_OFFSETS = [(column, row) for row in (-1, 0, 1) for column in (-1, 0, 1)]
CENTER_OFFSET = (0, 0)

GO_DEFINE_PATTERN = re.compile(r'^#define (go_\d+)\(x_off, y_off\) \((.*)\)$')
G_DEFINE_PATTERN = re.compile(r'^#define (g_\d+) \((.*)\)$')
RELU_PATTERN = re.compile(r'^max\((-?)\((\w+)_tex(?:Off)?\((?:vec2\(x_off, y_off\)|\2_pos)\)\), 0\.0\)$')
PLAIN_PATTERN = re.compile(r'^(\w+)_texOff\(vec2\(x_off, y_off\)\)$')
GO_TERM_PATTERN = re.compile(r'result \+?= mat4\(([^)]*)\) \* (go_\d+)\(([-\d.]+), ([-\d.]+)\);')
G_TERM_PATTERN = re.compile(r'result \+?= mat4\(([^)]*)\) \* (g_\d+);')
BIAS_PATTERN = re.compile(r'result \+= vec4\(([^)]*)\);')
FLOAT_PATTERN = re.compile(r'^-?\d+(\.\d*)?([eE][-+]?\d+)?$')
PART_SUFFIX_PATTERN = re.compile(r'_tf\d*$')


@dataclass
class Source:
    # A GLSL texture name, such as conv2d_1_tf2, or MAIN
    texture: str
    # +1 for max(x, 0), -1 for max(-x, 0), 0 for x unchanged
    relu_sign: int


@dataclass
class Term:
    matrix: list
    source: Source
    offset: tuple


@dataclass
class GLSLPass:
    save: str
    terms: list = field(default_factory=list)
    bias: list = field(default_factory=list)


@dataclass
class Layer:
    name: str
    parts: list


def to_wgsl_float(literal: str) -> str:
    """Returns the literal as a WGSL f32 literal, keeping its digits."""
    literal = literal.strip()
    if not FLOAT_PATTERN.match(literal):
        raise ValueError(f'Not a float literal: {literal!r}')
    if '.' in literal or 'e' in literal or 'E' in literal:
        return literal
    return literal + '.0'


def parse_source(expression: str) -> Source:
    match = RELU_PATTERN.match(expression)
    if match:
        return Source(match.group(2), -1 if match.group(1) == '-' else 1)
    match = PLAIN_PATTERN.match(expression)
    if match:
        return Source(match.group(1), 0)
    raise ValueError(f'Unknown source expression: {expression!r}')


def layer_name_of(texture: str) -> str:
    return MAIN_NAME if texture == MAIN_NAME else PART_SUFFIX_PATTERN.sub('', texture)


def parse_passes(glsl: str):
    """Returns the convolution passes in file order and the depth-to-space pass's bound names."""
    blocks = glsl.replace('\r\n', '\n').split('//!DESC')[1:]
    convolutions = []
    depth_to_space_binds = None
    for block in blocks:
        binds = []
        save = None
        width = None
        defines = {}
        for line in block.split('\n'):
            if line.startswith('//!BIND '):
                binds.append(line.split()[1])
            elif line.startswith('//!SAVE '):
                save = line.split()[1]
            elif line.startswith('//!WIDTH '):
                width = line[len('//!WIDTH '):].strip()
            else:
                match = GO_DEFINE_PATTERN.match(line) or G_DEFINE_PATTERN.match(line)
                if match:
                    defines[match.group(1)] = parse_source(match.group(2))
        if save == MAIN_NAME:
            if depth_to_space_binds is not None or not width.endswith('2 *'):
                raise ValueError('Expected one 2x depth-to-space pass')
            depth_to_space_binds = [name for name in binds if name != MAIN_NAME]
            continue
        convolution = GLSLPass(save)
        for match in GO_TERM_PATTERN.finditer(block):
            offset = (int(float(match.group(3))), int(float(match.group(4))))
            if offset not in NEIGHBOR_OFFSETS:
                raise ValueError(f'{save}: offset {offset} beyond 3x3')
            convolution.terms.append(Term(parse_matrix(match.group(1), save), defines[match.group(2)], offset))
        for match in G_TERM_PATTERN.finditer(block):
            convolution.terms.append(Term(parse_matrix(match.group(1), save), defines[match.group(2)], CENTER_OFFSET))
        bias_matches = BIAS_PATTERN.findall(block)
        if len(bias_matches) != 1 or not convolution.terms:
            raise ValueError(f'{save}: expected terms and one bias')
        convolution.bias = [to_wgsl_float(value) for value in bias_matches[0].split(',')]
        convolutions.append(convolution)
    if depth_to_space_binds is None:
        raise ValueError('No depth-to-space pass')
    return convolutions, depth_to_space_binds


def parse_matrix(text: str, save: str) -> list:
    matrix = [to_wgsl_float(value) for value in text.split(',')]
    if len(matrix) != 16:
        raise ValueError(f'{save}: mat4 with {len(matrix)} values')
    return matrix


def group_layers(convolutions, depth_to_space_binds):
    """Groups passes into layers by saved name, in file order; the last layer feeds depth-to-space."""
    layers = []
    for convolution in convolutions:
        name = layer_name_of(convolution.save)
        if not layers or layers[-1].name != name:
            if any(layer.name == name for layer in layers):
                raise ValueError(f'Layer {name} is not contiguous')
            layers.append(Layer(name, []))
        layers[-1].parts.append(convolution)
    textures = {MAIN_NAME}
    for layer in layers:
        for part in layer.parts:
            for term in part.terms:
                if term.source.texture not in textures:
                    raise ValueError(f'{part.save} reads {term.source.texture} before it exists')
        textures.update(part.save for part in layer.parts)
    if depth_to_space_binds != [part.save for part in layers[-1].parts] or len(layers[-1].parts) != OUTPUT_PARTS:
        raise ValueError(f'Depth-to-space reads {depth_to_space_binds}, not the last layer')
    return layers


def part_index_of(layers_by_name, texture: str) -> int:
    if texture == MAIN_NAME:
        return 0
    layer = layers_by_name[layer_name_of(texture)]
    return [part.save for part in layer.parts].index(texture)


def accessor_of(layer_name: str) -> str:
    return HOOKED_NAME if layer_name == MAIN_NAME else layer_name


def offset_suffix(offset) -> str:
    return f'{"m" if offset[0] < 0 else "p"}{abs(offset[0])}{"m" if offset[1] < 0 else "p"}{abs(offset[1])}'


def generate_layer_wgsl(layer_index: int, layer: Layer, layers_by_name, is_last: bool, name_prefix: str,
                        description: str, layer_count: int) -> str:
    input_layers = []
    for part in layer.parts:
        for term in part.terms:
            name = layer_name_of(term.source.texture)
            if name not in input_layers:
                input_layers.append(name)
    saved_inputs = [name for name in input_layers if name != MAIN_NAME]
    header_lines = [
        f'//! name: {name_prefix} {layer_index + 1}/{layer_count}',
        '//! shape: compute',
        '//! hook: PRESCALE',
        '//! domain: source',
        '//! when: output.width / source.width > 1.2 && output.height / source.height > 1.2'
    ]
    # Declared inputs replace the implicit HOOKED, whose size is the source size every layer indexes by
    if saved_inputs:
        header_lines.append(f'//! input: {HOOKED_NAME}')
        header_lines.extend(f'//! input: {name}' for name in saved_inputs)
    if is_last:
        header_lines.append('//! output: HOOKED.width * 2, HOOKED.height * 2, rgba16float')
    else:
        header_lines.append(f'//! save: {layer.name}')
        header_lines.append(f'//! output: HOOKED.width * {len(layer.parts)}, HOOKED.height, rgba16float')
    header_lines.append(f'//! workgroup: {WORKGROUP_SIZE}, {WORKGROUP_SIZE}')
    header_lines.append(f'//! dispatch: ceil(HOOKED.width / {WORKGROUP_SIZE}), ceil(HOOKED.height / {WORKGROUP_SIZE})')

    kernel_size = '1x1' if all(term.offset == CENTER_OFFSET for part in layer.parts for term in part.terms) else '3x3'
    channel_count = len(layer.parts) * CHANNELS_PER_PART
    lines = ['']
    # Only blank lines may precede a file's first header, so the file's notes open the first pass's body
    if layer_index == 0:
        lines.extend([
            f'// {description}, as one webgpu-player pass file of {layer_count} passes, which run in file order',
            '// Generated by wgpup/anime4k/generate_anime4k_wgsl_chain.py from the mpv GLSL; the weights are copied verbatim.',
            '//',
            '// Anime4K: MIT License, Copyright (c) 2019-2021 bloc97',
            '//',
            '// Layer textures hold their 4-channel parts side by side: part p of pixel (x, y) is at (x + p * source width, y).',
            '//'
        ])
    lines.append(f'// Layer {layer_index + 1} of {layer_count}: {layer.name}, {kernel_size}, {channel_count} channels')
    if is_last:
        lines.append('// This last layer also does depth-to-space and adds the bilinear-upscaled input, writing the 2x image.')
    lines.append('')
    for name in input_layers:
        accessor = accessor_of(name)
        lines.extend([
            f'// Reads a part of {name} at a pixel, clamped to the image as the GLSL\'s clamp-to-edge reads are',
            f'fn read_{name}(position: vec2i, part: i32) -> vec4f {{',
            '    let imageSize = vec2i(HOOKED_size());',
            '    let clamped = clamp(position, vec2i(0), imageSize - vec2i(1)) + vec2i(part * imageSize.x, 0);',
            f'    return {accessor}_tex((vec2f(clamped) + vec2f(0.5)) * {accessor}_pt());',
            '}',
            ''
        ])

    body = ['fn compute(id: vec3u) {',
            '    let position = vec2i(id.xy);',
            '    let imageSize = vec2i(HOOKED_size());',
            '    if (any(position >= imageSize)) {',
            '        return;',
            '    }']
    # Every neighborhood value and activation is read once and shared by all of the layer's parts
    reads = []
    activations = []
    for part in layer.parts:
        for term in part.terms:
            name = layer_name_of(term.source.texture)
            read = (name, part_index_of(layers_by_name, term.source.texture), term.offset)
            if read not in reads:
                reads.append(read)
            activation = (read, term.source.relu_sign)
            if activation not in activations:
                activations.append(activation)

    def read_variable(read) -> str:
        name, part_index, offset = read
        return f'{name}_{part_index}_{offset_suffix(offset)}'

    def activation_variable(activation) -> str:
        read, sign = activation
        if sign == 0:
            return read_variable(read)
        return f'{"positive" if sign > 0 else "negative"}_{read_variable(read)}'

    for read in reads:
        name, part_index, offset = read
        body.append(f'    let {read_variable(read)} = read_{name}(position + vec2i({offset[0]}, {offset[1]}), {part_index});')
    for activation in activations:
        read, sign = activation
        if sign != 0:
            argument = read_variable(read) if sign > 0 else f'-{read_variable(read)}'
            body.append(f'    let {activation_variable(activation)} = max({argument}, vec4f(0.0));')
    for part_index, part in enumerate(layer.parts):
        body.append(f'    // {part.save}')
        # Terms then bias, in the GLSL's summation order
        for term_index, term in enumerate(part.terms):
            read = (layer_name_of(term.source.texture), part_index_of(layers_by_name, term.source.texture), term.offset)
            assignment = f'var result{part_index} =' if term_index == 0 else f'result{part_index} +='
            body.append(f'    {assignment} mat4x4f({", ".join(term.matrix)}) * {activation_variable((read, term.source.relu_sign))};')
        body.append(f'    result{part_index} += vec4f({", ".join(part.bias)});')
    if is_last:
        body.extend([
            '',
            '    // Depth-to-space: channel (row * 2 + column) of each color is that subpixel\'s residual',
            '    let outputSize = 2.0 * vec2f(imageSize);',
            '    for (var row = 0; row < 2; row += 1) {',
            '        for (var column = 0; column < 2; column += 1) {',
            '            let outputPosition = position * 2 + vec2i(column, row);',
            '            let channel = row * 2 + column;',
            '            // The GLSL adds MAIN bilinearly sampled at the output pixel center',
            '            let upscaled = HOOKED_tex((vec2f(outputPosition) + vec2f(0.5)) / outputSize);',
            '            let residual = vec4f(result0[channel], result1[channel], result2[channel], 0.0);',
            '            TARGET_store(vec2u(outputPosition), upscaled + residual);',
            '        }',
            '    }'
        ])
    else:
        for part_index in range(len(layer.parts)):
            body.append(f'    TARGET_store(vec2u(position + vec2i({part_index} * imageSize.x, 0)), result{part_index});')
    body.append('}')
    return '\n'.join(header_lines) + '\n' + '\n'.join(lines) + '\n' + '\n'.join(body) + '\n'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('input')
    parser.add_argument('output')
    parser.add_argument('--name', default='Anime4K Upscale Denoise CNN x2 UL')
    arguments = parser.parse_args()
    with open(arguments.input, encoding='ascii') as file:
        glsl = file.read()
    description_match = re.search(r'//!DESC (\S+)', glsl)
    description = description_match.group(1).rsplit('-', 2)[0] if description_match else arguments.name
    convolutions, depth_to_space_binds = parse_passes(glsl)
    layers = group_layers(convolutions, depth_to_space_binds)
    layers_by_name = {layer.name: layer for layer in layers}
    passes = []
    for layer_index, layer in enumerate(layers):
        is_last = layer_index == len(layers) - 1
        passes.append(generate_layer_wgsl(layer_index, layer, layers_by_name, is_last, arguments.name, description, len(layers)))
    # Each pass ends with a line break, so the next pass's header starts its own line
    wgsl = '\n'.join(passes)
    with open(arguments.output, 'w', encoding='ascii', newline='\n') as file:
        file.write(wgsl)
    term_count = sum(len(convolution.terms) for convolution in convolutions)
    print(f'{len(layers)} passes from {len(convolutions)} GLSL convolution passes, {term_count} mat4 terms, '
          f'{len(wgsl)} characters -> {arguments.output}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
