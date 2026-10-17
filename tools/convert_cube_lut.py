"""Turns a .cube 3D LUT into a pass file: a color pass that grades each pixel through the LUT, which the file holds as a texture block.

Usage: python tools/convert_cube_lut.py <input.cube> <output.wgsl> [--name <name>] [--hook <stage>] [--domain <domain>]

The pass samples the LUT trilinearly, at texel centers, over the .cube's input domain.
By default it grades the source's encoded RGB, which a LUT made for Rec. 709 video expects of an SDR source; --hook and --domain place it elsewhere,
such as OUTPUT and sdr for a LUT made for the display.
"""

from __future__ import annotations

import argparse
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from pass_texture_block import format_texture_block



class Keyword:
    """The .cube keywords this tool reads; any other line that starts with a letter is a keyword it does not need, and numbers are table rows."""

    TITLE: Final = 'TITLE'
    SIZE_3D: Final = 'LUT_3D_SIZE'
    SIZE_1D: Final = 'LUT_1D_SIZE'
    DOMAIN_MINIMUM: Final = 'DOMAIN_MIN'
    DOMAIN_MAXIMUM: Final = 'DOMAIN_MAX'


COMMENT_PREFIX: Final = '#'
COMPONENT_COUNT: Final = 3
DEFAULT_DOMAIN_MINIMUM: Final = (0.0, 0.0, 0.0)
DEFAULT_DOMAIN_MAXIMUM: Final = (1.0, 1.0, 1.0)
# The sizes the .cube specification allows
MINIMUM_3D_SIZE: Final = 2
MAXIMUM_3D_SIZE: Final = 256

# The pass: a color pass, where it grades by default, and the texture block that holds the LUT
TEXTURE_NAME: Final = 'LUT'
TEXTURE_FORMAT: Final = 'rgba16float'
TEXTURE_FILTER: Final = 'linear'
TEXTURE_EDGE: Final = 'clamp'
# The table's red, green, and blue, with alpha 1, as half floats, which filter on every device
HALF_TEXEL_FORMAT: Final = '<4e'
OPAQUE_ALPHA: Final = 1.0
DEFAULT_HOOK: Final = 'RGB'
DEFAULT_DOMAIN: Final = 'source'
HOOKS: Final = ('RGB', 'PRESCALE', 'SCALE', 'OUTPUT')
DOMAINS: Final = ('source', 'linear', 'display', 'sdr')
MAXIMUM_NAME_LENGTH: Final = 64
FLOAT_DIGITS: Final = 9
PASS_TEMPLATE: Final = '''//! name: {name}
//! shape: color
//! hook: {hook}
//! domain: {domain}
//! bind: {texture}

// Generated from {source} by tools/convert_cube_lut.py
const LUT_DOMAIN_MINIMUM = vec3f({minimum});
const LUT_DOMAIN_MAXIMUM = vec3f({maximum});

fn apply(color: vec4f, position: vec2f) -> vec4f {{
    let size = {texture}_size();
    // A LUT of n entries holds its domain's ends at its first and last texel centers
    let normalized = clamp((color.rgb - LUT_DOMAIN_MINIMUM) / (LUT_DOMAIN_MAXIMUM - LUT_DOMAIN_MINIMUM), vec3f(0.0), vec3f(1.0));
    return vec4f({texture}_tex(normalized * (size - vec3f(1.0)) / size + vec3f(0.5) / size).rgb, color.a);
}}
'''


class CubeError(Exception):
    """A .cube file this tool cannot read, with a code and a terse detail."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f'{code}: {detail}')
        self.code = code
        self.detail = detail


CODE_SIZE_MISSING: Final = 'size-missing'
CODE_SIZE_INVALID: Final = 'size-invalid'
CODE_ONE_DIMENSIONAL: Final = 'one-dimensional'
CODE_ROW_INVALID: Final = 'row-invalid'
CODE_ROW_COUNT: Final = 'row-count'
CODE_DOMAIN_INVALID: Final = 'domain-invalid'


@dataclass(frozen=True)
class CubeLUT:
    """A 3D LUT: its title, its input domain, and its rows, red fastest, then green, then blue."""

    title: str | None
    size: int
    domain_minimum: tuple[float, float, float]
    domain_maximum: tuple[float, float, float]
    rows: list[tuple[float, float, float]]


def parse_triple(words: list[str], line_number: int, code: str) -> tuple[float, float, float]:
    if len(words) != COMPONENT_COUNT:
        raise CubeError(code, f'line {line_number}: expected 3 numbers')
    try:
        first, second, third = (float(word) for word in words)
    except ValueError:
        raise CubeError(code, f'line {line_number}: {" ".join(words)} is not 3 numbers') from None
    return first, second, third


def parse_cube(text: str) -> CubeLUT:
    """Parses a .cube file of a 3D LUT; a 1D LUT, a missing or malformed size, or a table of the wrong length fails."""
    title: str | None = None
    size: int | None = None
    domain_minimum = DEFAULT_DOMAIN_MINIMUM
    domain_maximum = DEFAULT_DOMAIN_MAXIMUM
    rows: list[tuple[float, float, float]] = []
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith(COMMENT_PREFIX):
            continue
        keyword, _, argument = line.partition(' ')
        match keyword:
            case Keyword.TITLE:
                title = argument.strip().strip('"')
            case Keyword.SIZE_3D:
                try:
                    size = int(argument)
                except ValueError:
                    raise CubeError(CODE_SIZE_INVALID, f'line {line_number}: {argument}') from None
                if not MINIMUM_3D_SIZE <= size <= MAXIMUM_3D_SIZE:
                    raise CubeError(CODE_SIZE_INVALID, f'line {line_number}: {size} outside [{MINIMUM_3D_SIZE}, {MAXIMUM_3D_SIZE}]')
            case Keyword.SIZE_1D:
                raise CubeError(CODE_ONE_DIMENSIONAL, f'line {line_number}: a 1D LUT, which this tool does not convert')
            case Keyword.DOMAIN_MINIMUM:
                domain_minimum = parse_triple(argument.split(), line_number, CODE_DOMAIN_INVALID)
            case Keyword.DOMAIN_MAXIMUM:
                domain_maximum = parse_triple(argument.split(), line_number, CODE_DOMAIN_INVALID)
            case _ if keyword[0].isalpha():
                continue
            case _:
                rows.append(parse_triple(line.split(), line_number, CODE_ROW_INVALID))
    if size is None:
        raise CubeError(CODE_SIZE_MISSING, f'no {Keyword.SIZE_3D}')
    if len(rows) != size ** COMPONENT_COUNT:
        raise CubeError(CODE_ROW_COUNT, f'{len(rows)} rows; LUT_3D_SIZE {size} needs {size ** COMPONENT_COUNT}')
    if any(maximum <= minimum for minimum, maximum in zip(domain_minimum, domain_maximum)):
        raise CubeError(CODE_DOMAIN_INVALID, f'DOMAIN_MIN {domain_minimum} is not below DOMAIN_MAX {domain_maximum}')
    return CubeLUT(title, size, domain_minimum, domain_maximum, rows)


def format_vector(values: tuple[float, float, float]) -> str:
    return ', '.join(f'{value:.{FLOAT_DIGITS}f}' for value in values)


def create_pass_file(lut: CubeLUT, name: str, hook: str, domain: str, source_name: str) -> str:
    """Returns the pass file: the grading color pass, then the LUT's texture block, red along x, green along y, and blue along z."""
    try:
        data = b''.join(struct.pack(HALF_TEXEL_FORMAT, *row, OPAQUE_ALPHA) for row in lut.rows)
    except OverflowError:
        raise CubeError(CODE_ROW_INVALID, 'a value exceeds a half float') from None
    pass_text = PASS_TEMPLATE.format(
        name=name[:MAXIMUM_NAME_LENGTH],
        hook=hook,
        domain=domain,
        texture=TEXTURE_NAME,
        source=source_name,
        minimum=format_vector(lut.domain_minimum),
        maximum=format_vector(lut.domain_maximum)
    )
    texture_block = format_texture_block(TEXTURE_NAME, (lut.size, lut.size, lut.size), TEXTURE_FORMAT, TEXTURE_FILTER, TEXTURE_EDGE, data)
    return f'{pass_text}\n{texture_block}'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('input')
    parser.add_argument('output')
    parser.add_argument('--name', help='the pass name; defaults to the .cube TITLE, else the file name')
    parser.add_argument('--hook', choices=HOOKS, default=DEFAULT_HOOK, help=f'the stage the pass grades at; defaults to {DEFAULT_HOOK}')
    parser.add_argument('--domain', choices=DOMAINS, default=DEFAULT_DOMAIN, help=f'the color domain the LUT expects; defaults to {DEFAULT_DOMAIN}')
    arguments = parser.parse_args()
    input_path = Path(arguments.input)
    try:
        lut = parse_cube(input_path.read_text(encoding='utf-8'))
        pass_file = create_pass_file(lut, arguments.name or lut.title or input_path.stem, arguments.hook, arguments.domain, input_path.name)
    except CubeError as error:
        print(f'error {error.code}: {error.detail}')
        print(f'{input_path.name}: not converted')
        return 1
    Path(arguments.output).write_text(pass_file, encoding='utf-8', newline='\n')
    print(f'{input_path.name}: {lut.size}^3 LUT -> {arguments.output}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
