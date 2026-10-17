"""Converts the mpv port of NVIDIA Image Scaling, NVScaler.glsl, into a webgpu-player pass file at a block height WebGPU's default limits hold.

The port's compute pass writes 32x24 output pixels per workgroup, whose shared memory, 21776 bytes, exceeds the 16384 bytes WebGPU guarantees.
At 32x16 it takes 16208 bytes, and each of its 256 threads still writes two output pixels, so the pass is otherwise the port's own.
The upstream file stays unmodified in glsl/: this script changes its block height and COMPUTE directive in memory and converts the result with the mpv shader converter.

Usage: generate_nis_wgsl.py <NVScaler.glsl> <NVScaler.wgsl>
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Final

TOOLS_DIRECTORY: Final = Path(__file__).resolve().parents[2] / 'tools'
if str(TOOLS_DIRECTORY) not in sys.path:
    sys.path.append(str(TOOLS_DIRECTORY))

import convert_mpv_shader as converter  # noqa: E402

# The port's block height and COMPUTE directive, each with the line that replaces it
BLOCK_HEIGHT_DEFINITION: Final = '#define NIS_BLOCK_HEIGHT 24'
FITTING_BLOCK_HEIGHT_DEFINITION: Final = '#define NIS_BLOCK_HEIGHT 16'
COMPUTE_DIRECTIVE: Final = '//!COMPUTE 32 24 256 1'
FITTING_COMPUTE_DIRECTIVE: Final = '//!COMPUTE 32 16 256 1'
REPLACEMENTS: Final = ((BLOCK_HEIGHT_DEFINITION, FITTING_BLOCK_HEIGHT_DEFINITION), (COMPUTE_DIRECTIVE, FITTING_COMPUTE_DIRECTIVE))
DEFAULT_NAME: Final = 'NVScaler'


def fit_block_height(source: str) -> str:
    """Returns the port with a 32x16 block, failing when the port no longer holds exactly one of each line it changes."""
    for original, fitting in REPLACEMENTS:
        if source.count(original) != 1:
            raise ValueError(f'Expected one {original!r} in the port')
        source = source.replace(original, fitting)
    return source


def generate(source: str, source_name: str, naga: str, report: converter.Report) -> str | None:
    """Converts the port at the fitting block height; returns None when the conversion fails, with the report saying why."""
    return converter.convert_shader(fit_block_height(source), DEFAULT_NAME, naga, source_name, report)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('input')
    parser.add_argument('output')
    arguments = parser.parse_args()
    input_path = Path(arguments.input)
    report = converter.Report()
    try:
        result = generate(input_path.read_text(encoding='utf-8'), input_path.name, converter.find_naga(converter.NAGA_EXECUTABLE), report)
    except converter.ConversionError as error:
        report.add(converter.SEVERITY_ERROR, error.code, error.detail)
        result = None
    for finding in report.findings:
        print(f'{finding.severity} {finding.code}: {finding.detail}')
    if result is None:
        print(f'{input_path.name}: not converted')
        return 1
    Path(arguments.output).write_text(result, encoding='utf-8', newline='\n')
    print(f'{input_path.name}: {result.count("//! name: ")} passes at a 32x16 block -> {arguments.output}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
