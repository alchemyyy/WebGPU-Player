"""Converts an Anime4K v3.2 Upscale(+Denoise) CNN x2 mpv GLSL shader into one fused webgpu-player compute pass.

The GLSL is a chain of 3x3 convolution passes (CReLU between layers) followed by a depth-to-space pass
that adds the bilinear-upscaled input. The WGSL evaluates the whole chain per 16x16 source tile in
workgroup memory, with a halo of one pixel per layer, and writes the 2x image.

Usage: generate_anime4k_wgsl.py <input.glsl> <output.wgsl> [--weights-json <path>] [--name <pass name>]
"""

import argparse
import json
import re
import sys
from dataclasses import dataclass, field

MAIN_NAME = 'MAIN'
TILE_SIZE = 16
WORKGROUP_INVOCATIONS = TILE_SIZE * TILE_SIZE
CHANNELS_PER_PART = 4
# Each hidden layer is stored as 8 f16 channels per pixel, packed into 4 u32
HIDDEN_PARTS = 2
U32_PER_HIDDEN_PIXEL = HIDDEN_PARTS * CHANNELS_PER_PART // 2
U32_PER_INPUT_PIXEL = 2
OUTPUT_PARTS = 3
# The default maxComputeWorkgroupStorageSize
WORKGROUP_STORAGE_LIMIT_BYTES = 16384
BYTES_PER_U32 = 4
NEIGHBOR_OFFSETS = [(column, row) for row in (-1, 0, 1) for column in (-1, 0, 1)]

DEFINE_PATTERN = re.compile(r'^#define (go_\d+)\(x_off, y_off\) \((.*)\)$')
RELU_POSITIVE_PATTERN = re.compile(r'^max\(\((\w+)_texOff\(vec2\(x_off, y_off\)\)\), 0\.0\)$')
RELU_NEGATIVE_PATTERN = re.compile(r'^max\(-\((\w+)_texOff\(vec2\(x_off, y_off\)\)\), 0\.0\)$')
PLAIN_PATTERN = re.compile(r'^(\w+)_texOff\(vec2\(x_off, y_off\)\)$')
TERM_PATTERN = re.compile(r'result \+?= mat4\(([^)]*)\) \* (go_\d+)\(([-\d.]+), ([-\d.]+)\);')
BIAS_PATTERN = re.compile(r'result \+= vec4\(([^)]*)\);')
FLOAT_PATTERN = re.compile(r'^-?\d+(\.\d*)?([eE][-+]?\d+)?$')


@dataclass
class Source:
    name: str
    # +1 for max(x, 0), -1 for max(-x, 0), 0 for x unchanged
    relu_sign: int


@dataclass
class Term:
    matrix: list
    source_index: int
    offset: tuple


@dataclass
class ConvolutionPass:
    save: str
    binds: list
    sources: list = field(default_factory=list)
    terms: list = field(default_factory=list)
    bias: list = field(default_factory=list)


def to_wgsl_float(literal: str) -> str:
    """Returns the literal as a WGSL f32 literal, keeping its digits."""
    literal = literal.strip()
    if not FLOAT_PATTERN.match(literal):
        raise ValueError(f'Not a float literal: {literal!r}')
    if '.' in literal or 'e' in literal or 'E' in literal:
        return literal
    return literal + '.0'


def parse_source(expression: str) -> Source:
    for pattern, sign in ((RELU_POSITIVE_PATTERN, 1), (RELU_NEGATIVE_PATTERN, -1), (PLAIN_PATTERN, 0)):
        match = pattern.match(expression)
        if match:
            return Source(match.group(1), sign)
    raise ValueError(f'Unknown go_ expression: {expression!r}')


def parse_passes(glsl: str):
    """Returns the convolution passes in file order and the depth-to-space pass's bound names."""
    blocks = glsl.replace('\r\n', '\n').split('//!DESC')[1:]
    convolutions = []
    depth_to_space_binds = None
    for block in blocks:
        lines = block.split('\n')
        binds = []
        save = None
        width = None
        defines = {}
        for line in lines:
            if line.startswith('//!BIND '):
                binds.append(line.split()[1])
            elif line.startswith('//!SAVE '):
                save = line.split()[1]
            elif line.startswith('//!WIDTH '):
                width = line[len('//!WIDTH '):].strip()
            else:
                match = DEFINE_PATTERN.match(line)
                if match:
                    defines[match.group(1)] = parse_source(match.group(2))
        if save == MAIN_NAME:
            if depth_to_space_binds is not None or not width.endswith('2 *'):
                raise ValueError('Expected one 2x depth-to-space pass')
            depth_to_space_binds = [name for name in binds if name != MAIN_NAME]
            continue
        convolution = ConvolutionPass(save, binds)
        define_names = sorted(defines, key=lambda name: int(name.split('_')[1]))
        convolution.sources = [defines[name] for name in define_names]
        for match in TERM_PATTERN.finditer(block):
            matrix = [to_wgsl_float(value) for value in match.group(1).split(',')]
            if len(matrix) != 16:
                raise ValueError(f'{save}: mat4 with {len(matrix)} values')
            source_index = define_names.index(match.group(2))
            offset = (int(float(match.group(3))), int(float(match.group(4))))
            convolution.terms.append(Term(matrix, source_index, offset))
        bias_matches = BIAS_PATTERN.findall(block)
        if len(bias_matches) != 1:
            raise ValueError(f'{save}: expected one bias')
        convolution.bias = [to_wgsl_float(value) for value in bias_matches[0].split(',')]
        convolutions.append(convolution)
    if depth_to_space_binds is None:
        raise ValueError('No depth-to-space pass')
    return convolutions, depth_to_space_binds


def group_layers(convolutions):
    """Groups passes into layers by dependency depth and checks the fused shader's assumptions."""
    depth_by_name = {MAIN_NAME: 0}
    layers = []
    for convolution in convolutions:
        depth = 1 + max(depth_by_name[source.name] for source in convolution.sources)
        depth_by_name[convolution.save] = depth
        while len(layers) < depth:
            layers.append([])
        layers[depth - 1].append(convolution)
    previous_names = [MAIN_NAME]
    for layer_index, layer in enumerate(layers):
        is_last = layer_index == len(layers) - 1
        expected_parts = OUTPUT_PARTS if is_last else HIDDEN_PARTS
        if len(layer) != expected_parts:
            raise ValueError(f'Layer {layer_index + 1} has {len(layer)} parts, expected {expected_parts}')
        for convolution in layer:
            for source in convolution.sources:
                if source.name not in previous_names:
                    raise ValueError(f'{convolution.save} reads {source.name}, not the previous layer')
                if (source.relu_sign == 0) != (source.name == MAIN_NAME):
                    raise ValueError(f'{convolution.save}: unexpected activation on {source.name}')
            offsets = {term.offset for term in convolution.terms}
            if not offsets <= set(NEIGHBOR_OFFSETS):
                raise ValueError(f'{convolution.save}: offsets beyond 3x3')
        previous_names = [convolution.save for convolution in layer]
    return layers


def region_size(halo: int) -> int:
    return TILE_SIZE + 2 * halo


def generate_layer_function(layer_index: int, layer, previous_names, is_first: bool, is_last: bool,
                            source_tile: str, destination_tile: str) -> str:
    function_name = f'evaluateLayer{layer_index + 1}'
    lines = []
    if is_last:
        lines.append(f'// Layer {layer_index + 1}: {", ".join(c.save for c in layer)}, returned for depth-to-space')
        lines.append(f'fn {function_name}(sourceIndices: array<i32, 9>) -> array<vec4f, {OUTPUT_PARTS}> {{')
    else:
        lines.append(f'// Layer {layer_index + 1}: {", ".join(c.save for c in layer)}')
        lines.append(f'fn {function_name}(sourceIndices: array<i32, 9>, destinationIndex: i32) {{')
    # Neighborhood values, read once and shared by every output part
    used_values = set()
    used_activations = set()
    for convolution in layer:
        for term in convolution.terms:
            source = convolution.sources[term.source_index]
            slot = NEIGHBOR_OFFSETS.index(term.offset)
            part = previous_names.index(source.name)
            used_values.add((part, slot))
            used_activations.add((part, source.relu_sign, slot))
    for part, slot in sorted(used_values):
        if is_first:
            lines.append(f'    let neighbor{slot} = readInputTile(sourceIndices[{slot}]);')
        else:
            lines.append(f'    let neighbor{part}_{slot} = readFeatures{source_tile}(sourceIndices[{slot}], {part});')
    if not is_first:
        for part, sign, slot in sorted(used_activations):
            suffix = 'positive' if sign > 0 else 'negative'
            argument = f'neighbor{part}_{slot}' if sign > 0 else f'-neighbor{part}_{slot}'
            lines.append(f'    let {suffix}{part}_{slot} = max({argument}, vec4f(0.0));')
    for part_index, convolution in enumerate(layer):
        # Terms then bias, in the GLSL's summation order
        for term_index, term in enumerate(convolution.terms):
            source = convolution.sources[term.source_index]
            slot = NEIGHBOR_OFFSETS.index(term.offset)
            if is_first:
                value = f'neighbor{slot}'
            else:
                part = previous_names.index(source.name)
                value = f'{"positive" if source.relu_sign > 0 else "negative"}{part}_{slot}'
            assignment = f'var result{part_index} =' if term_index == 0 else f'result{part_index} +='
            lines.append(f'    {assignment} mat4x4f({", ".join(term.matrix)}) * {value};')
        lines.append(f'    result{part_index} += vec4f({", ".join(convolution.bias)});')
    if is_last:
        results = ', '.join(f'result{index}' for index in range(len(layer)))
        lines.append(f'    return array<vec4f, {OUTPUT_PARTS}>({results});')
    else:
        for part_index in range(len(layer)):
            lines.append(f'    writeFeatures{destination_tile}(destinationIndex, {part_index}, result{part_index});')
    lines.append('}')
    return '\n'.join(lines)


def generate_wgsl(layers, depth_to_space_binds, pass_name: str, description: str) -> str:
    last_names = [convolution.save for convolution in layers[-1]]
    if depth_to_space_binds != last_names:
        raise ValueError(f'Depth-to-space reads {depth_to_space_binds}, expected {last_names}')
    layer_count = len(layers)
    input_halo = layer_count
    # Hidden layers alternate tiles: input -> A, layer 1 -> B, layer 2 -> A, ...
    tile_of_layer = ['B' if index % 2 == 0 else 'A' for index in range(layer_count - 1)]
    tile_a_u32 = region_size(input_halo) ** 2 * U32_PER_INPUT_PIXEL
    tile_b_u32 = 0
    for index, tile in enumerate(tile_of_layer):
        size = region_size(input_halo - 1 - index) ** 2 * U32_PER_HIDDEN_PIXEL
        if tile == 'A':
            tile_a_u32 = max(tile_a_u32, size)
        else:
            tile_b_u32 = max(tile_b_u32, size)
    storage_bytes = (tile_a_u32 + tile_b_u32) * BYTES_PER_U32
    if storage_bytes > WORKGROUP_STORAGE_LIMIT_BYTES:
        raise ValueError(f'Workgroup storage {storage_bytes} B exceeds {WORKGROUP_STORAGE_LIMIT_BYTES} B')

    header = f"""//! name: {pass_name}
//! shape: compute
//! hook: PRESCALE
//! domain: source
//! when: output.width / source.width > 1.2 && output.height / source.height > 1.2
//! output: HOOKED.width * 2, HOOKED.height * 2, rgba16float
//! workgroup: {TILE_SIZE}, {TILE_SIZE}
//! dispatch: ceil(HOOKED.width / {TILE_SIZE}), ceil(HOOKED.height / {TILE_SIZE})"""

    preamble = f"""
// {description}
// Generated by wgpup/anime4k/generate_anime4k_wgsl.py from the mpv GLSL; the weights are copied verbatim.
//
// Anime4K: MIT License, Copyright (c) 2019-2021 bloc97
//
// The GLSL runs {sum(len(layer) for layer in layers) + 1} passes through rgba16f textures at source size.
// This pass fuses them: each workgroup loads a {TILE_SIZE}x{TILE_SIZE} source tile with a {input_halo}-pixel halo,
// evaluates each 3x3 layer over a region one pixel smaller per side than the last, in workgroup memory,
// and writes the tile's 2x2 output blocks. Intermediates are packed to f16, as mpv's rgba16f textures hold them.
// Reads past the image edge clamp to it, matching the GLSL's clamp-to-edge texture reads at every layer.

const TILE_SIZE: i32 = {TILE_SIZE};
const WORKGROUP_INVOCATIONS: i32 = {WORKGROUP_INVOCATIONS};
const INPUT_HALO: i32 = {input_halo};

// Ping-pong tiles of packed f16 values ({storage_bytes} bytes; the default limit is {WORKGROUP_STORAGE_LIMIT_BYTES})
var<workgroup> tileA: array<u32, {tile_a_u32}>;
var<workgroup> tileB: array<u32, {tile_b_u32}>;

fn writeInputTile(index: i32, color: vec4f) {{
    tileA[index * 2] = pack2x16float(color.xy);
    tileA[index * 2 + 1] = pack2x16float(color.zw);
}}

fn readInputTile(index: i32) -> vec4f {{
    return vec4f(unpack2x16float(tileA[index * 2]), unpack2x16float(tileA[index * 2 + 1]));
}}

fn writeFeaturesA(index: i32, part: i32, features: vec4f) {{
    let base = index * {U32_PER_HIDDEN_PIXEL} + part * 2;
    tileA[base] = pack2x16float(features.xy);
    tileA[base + 1] = pack2x16float(features.zw);
}}

fn readFeaturesA(index: i32, part: i32) -> vec4f {{
    let base = index * {U32_PER_HIDDEN_PIXEL} + part * 2;
    return vec4f(unpack2x16float(tileA[base]), unpack2x16float(tileA[base + 1]));
}}

fn writeFeaturesB(index: i32, part: i32, features: vec4f) {{
    let base = index * {U32_PER_HIDDEN_PIXEL} + part * 2;
    tileB[base] = pack2x16float(features.xy);
    tileB[base + 1] = pack2x16float(features.zw);
}}

fn readFeaturesB(index: i32, part: i32) -> vec4f {{
    let base = index * {U32_PER_HIDDEN_PIXEL} + part * 2;
    return vec4f(unpack2x16float(tileB[base]), unpack2x16float(tileB[base + 1]));
}}

// Returns the tile indices of a pixel's 3x3 neighborhood in the previous layer's region, clamped to the image
fn gatherNeighbors(imagePosition: vec2i, imageSize: vec2i, tileOrigin: vec2i, sourceHalo: i32) -> array<i32, 9> {{
    let sourceRegionSize = TILE_SIZE + 2 * sourceHalo;
    var indices: array<i32, 9>;
    for (var row = -1; row <= 1; row += 1) {{
        for (var column = -1; column <= 1; column += 1) {{
            let neighbor = clamp(imagePosition + vec2i(column, row), vec2i(0), imageSize - vec2i(1)) - tileOrigin + vec2i(sourceHalo);
            indices[(row + 1) * 3 + column + 1] = neighbor.y * sourceRegionSize + neighbor.x;
        }}
    }}
    return indices;
}}

fn isInsideImage(imagePosition: vec2i, imageSize: vec2i) -> bool {{
    return all(imagePosition >= vec2i(0)) && all(imagePosition < imageSize);
}}
"""

    functions = []
    previous_names = [MAIN_NAME]
    for layer_index, layer in enumerate(layers):
        is_first = layer_index == 0
        is_last = layer_index == layer_count - 1
        source_tile = 'A' if is_first else tile_of_layer[layer_index - 1]
        destination_tile = None if is_last else tile_of_layer[layer_index]
        functions.append(generate_layer_function(layer_index, layer, previous_names, is_first, is_last,
                                                 source_tile, destination_tile))
        previous_names = [convolution.save for convolution in layer]

    hidden_loops = []
    for layer_index in range(layer_count - 1):
        halo = input_halo - 1 - layer_index
        hidden_loops.append(f"""
    // Layer {layer_index + 1} over the tile with a {halo}-pixel halo
    for (var index = localIndex; index < {region_size(halo) ** 2}; index += WORKGROUP_INVOCATIONS) {{
        let imagePosition = tileOrigin + vec2i(index % {region_size(halo)}, index / {region_size(halo)}) - vec2i({halo});
        // Positions past the edge are never read, since every read clamps to the image
        if (!isInsideImage(imagePosition, imageSize)) {{
            continue;
        }}
        evaluateLayer{layer_index + 1}(gatherNeighbors(imagePosition, imageSize, tileOrigin, {halo + 1}), index);
    }}
    workgroupBarrier();""")

    compute = f"""
fn compute(id: vec3u) {{
    let imageSize = vec2i(HOOKED_size());
    let localPosition = vec2i(id.xy % vec2u(u32(TILE_SIZE)));
    let localIndex = localPosition.y * TILE_SIZE + localPosition.x;
    let tileOrigin = vec2i(id.xy) - localPosition;

    // Source tile with the full halo, clamped to the image as a clamp-to-edge sampler reads it
    let inputRegionSize = TILE_SIZE + 2 * INPUT_HALO;
    for (var index = localIndex; index < inputRegionSize * inputRegionSize; index += WORKGROUP_INVOCATIONS) {{
        let tilePosition = vec2i(index % inputRegionSize, index / inputRegionSize);
        let imagePosition = clamp(tileOrigin + tilePosition - vec2i(INPUT_HALO), vec2i(0), imageSize - vec2i(1));
        writeInputTile(index, HOOKED_tex((vec2f(imagePosition) + vec2f(0.5)) * HOOKED_pt()));
    }}
    workgroupBarrier();
{''.join(hidden_loops)}

    // Last layer, then depth-to-space: channel (row * 2 + column) of each color is that subpixel's residual
    let imagePosition = tileOrigin + localPosition;
    if (!isInsideImage(imagePosition, imageSize)) {{
        return;
    }}
    let residuals = evaluateLayer{layer_count}(gatherNeighbors(imagePosition, imageSize, tileOrigin, 1));
    let outputSize = 2.0 * vec2f(imageSize);
    for (var row = 0; row < 2; row += 1) {{
        for (var column = 0; column < 2; column += 1) {{
            let outputPosition = imagePosition * 2 + vec2i(column, row);
            let channel = row * 2 + column;
            // The GLSL adds MAIN bilinearly sampled at the output pixel center
            let upscaled = HOOKED_tex((vec2f(outputPosition) + vec2f(0.5)) / outputSize);
            let residual = vec4f(residuals[0][channel], residuals[1][channel], residuals[2][channel], 0.0);
            TARGET_store(vec2u(outputPosition), upscaled + residual);
        }}
    }}
}}
"""
    return header + '\n' + preamble + '\n' + '\n\n'.join(functions) + '\n' + compute


def export_weights(layers) -> dict:
    """Returns the network as JSON for a reference implementation: per layer, per part, sources, terms, and bias."""
    exported = []
    for layer in layers:
        parts = []
        for convolution in layer:
            parts.append({
                'save': convolution.save,
                'sources': [{'name': source.name, 'reluSign': source.relu_sign} for source in convolution.sources],
                'terms': [{'matrix': [float(value) for value in term.matrix], 'source': term.source_index,
                           'offset': list(term.offset)} for term in convolution.terms],
                'bias': [float(value) for value in convolution.bias]
            })
        exported.append(parts)
    return {'layers': exported}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('input')
    parser.add_argument('output')
    parser.add_argument('--weights-json')
    parser.add_argument('--name', default='Anime4K Upscale Denoise CNN x2 L')
    arguments = parser.parse_args()
    with open(arguments.input, encoding='ascii') as file:
        glsl = file.read()
    description_match = re.search(r'//!DESC (\S+)', glsl)
    description = description_match.group(1).rsplit('-', 2)[0] if description_match else arguments.name
    convolutions, depth_to_space_binds = parse_passes(glsl)
    layers = group_layers(convolutions)
    wgsl = generate_wgsl(layers, depth_to_space_binds, arguments.name, description)
    with open(arguments.output, 'w', encoding='ascii', newline='\n') as file:
        file.write(wgsl)
    if arguments.weights_json:
        with open(arguments.weights_json, 'w', encoding='ascii') as file:
            json.dump(export_weights(layers), file)
    term_count = sum(len(convolution.terms) for convolution in convolutions)
    print(f'{len(layers)} layers, {len(convolutions)} convolution passes, {term_count} mat4 terms -> {arguments.output}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
