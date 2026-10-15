#!/usr/bin/env python3
"""Generate the MPEG-2 decoder package's self-test media: MPEG-2 streams that exercise every coding tool of ISO/IEC 13818-2.

No available encoder writes field pictures, dual prime, 16x8 motion, concealment motion vectors, or 4:4:4 together, so this script
encodes them itself: a syntax exerciser that makes pseudo-random but valid coding choices from a fixed seed, with integer arithmetic only,
so every machine writes the same bytes. Its pictures are open-loop: residuals are taken against the source frames, which decoders
never see, so pictures drift, but every choice keeps the stream valid: motion stays inside the reference pictures, and dequantized
coefficients stay within 12 bits. FFmpeg's decode of the result is the reference the vectors section hashes.

Each vector is a Matroska file in decoders/mpeg2/vectors/, one block per coded frame in decode order with presentation timestamps,
and the first sequence header and its extension as the track's CodecPrivate. --check regenerates every file and compares the bytes.
"""

from __future__ import annotations

import argparse
import struct
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final, Sequence

from engine_layout import DECODERS_DIRECTORY
from generated_output import GeneratedOutputError, write_or_check_output


VECTOR_DIRECTORY: Final = DECODERS_DIRECTORY / "mpeg2" / "vectors"

# Start codes, the byte after 00 00 01
PICTURE_START_CODE: Final = 0x00
SEQUENCE_HEADER_CODE: Final = 0xB3
EXTENSION_START_CODE: Final = 0xB5
SEQUENCE_END_CODE: Final = 0xB7
GROUP_START_CODE: Final = 0xB8
SEQUENCE_EXTENSION_ID: Final = 1
QUANT_MATRIX_EXTENSION_ID: Final = 3
PICTURE_CODING_EXTENSION_ID: Final = 8

PICTURE_TYPE_I: Final = 1
PICTURE_TYPE_P: Final = 2
PICTURE_TYPE_B: Final = 3
STRUCTURE_TOP_FIELD: Final = 1
STRUCTURE_BOTTOM_FIELD: Final = 2
STRUCTURE_FRAME: Final = 3
CHROMA_420: Final = 1
CHROMA_422: Final = 2
CHROMA_444: Final = 3

# Motion types, as FFmpeg's MV_TYPE_* names them, and the motion_type codes that select them
MOTION_FRAME: Final = 0
MOTION_FIELD: Final = 1
MOTION_16X8: Final = 2
MOTION_DUAL_PRIME: Final = 3
MOTION_TYPE_FIELD_CODE: Final = 1
MOTION_TYPE_FRAME_CODE: Final = 2
MOTION_TYPE_DUAL_PRIME_CODE: Final = 3

# Macroblock type flags
MB_INTRA: Final = 1
MB_QUANT: Final = 2
MB_FORWARD: Final = 4
MB_BACKWARD: Final = 8
MB_PATTERN: Final = 16
MB_ZERO_MOTION: Final = 32

# The largest magnitude a dequantized coefficient may take, ISO/IEC 13818-2's saturation bound
MAXIMUM_DEQUANTIZED: Final = 2047
# The largest magnitude of an exerciser coefficient, which no DCT produced; bounded so no block drives FFmpeg's IDCT past 16 bits,
# where its SIMD IDCT saturates and its C IDCT wraps, and the two would decode the vector differently
MAXIMUM_EXTRA_DEQUANTIZED: Final = 256
# An MPEG-2 escape level is a 12-bit signed value without -2048
MAXIMUM_ESCAPE_LEVEL: Final = 2047
FRAME_DURATION_MILLISECONDS: Final = 40
FRAME_DURATION_NANOSECONDS: Final = FRAME_DURATION_MILLISECONDS * 1_000_000
# frame_rate_code 3 is 25 frames per second
FRAME_RATE_CODE: Final = 3
SQUARE_SAMPLE_ASPECT_RATIO: Final = 1
MAXIMUM_BIT_RATE_VALUE: Final = 0x3FFFF
VBV_BUFFER_SIZE_VALUE: Final = 112
VBV_DELAY_VARIABLE: Final = 0xFFFF
MPEG1_F_CODE_FIELD: Final = 7
UNUSED_F_CODE: Final = 15

# B.1 macroblock_address_increment codes for increments 1 to 33, and the escape that adds 33
MACROBLOCK_ADDRESS_INCREMENT_CODES: Final = (
    (0x1, 1), (0x3, 3), (0x2, 3), (0x3, 4), (0x2, 4), (0x3, 5), (0x2, 5), (0x7, 7), (0x6, 7),
    (0xB, 8), (0xA, 8), (0x9, 8), (0x8, 8), (0x7, 8), (0x6, 8),
    (0x17, 10), (0x16, 10), (0x15, 10), (0x14, 10), (0x13, 10), (0x12, 10),
    (0x23, 11), (0x22, 11), (0x21, 11), (0x20, 11), (0x1F, 11), (0x1E, 11), (0x1D, 11), (0x1C, 11),
    (0x1B, 11), (0x1A, 11), (0x19, 11), (0x18, 11),
)
MACROBLOCK_ESCAPE_CODE: Final = (0x8, 11)
MACROBLOCK_ESCAPE_INCREMENT: Final = 33

# B.2 to B.4 macroblock_type codes by flags
I_MACROBLOCK_TYPE_CODES: Final = {MB_INTRA: (1, 1), MB_QUANT | MB_INTRA: (1, 2)}
P_MACROBLOCK_TYPE_CODES: Final = {
    MB_INTRA: (3, 5),
    MB_FORWARD | MB_PATTERN | MB_ZERO_MOTION: (1, 2),
    MB_FORWARD: (1, 3),
    MB_FORWARD | MB_PATTERN: (1, 1),
    MB_QUANT | MB_INTRA: (1, 6),
    MB_QUANT | MB_FORWARD | MB_PATTERN | MB_ZERO_MOTION: (1, 5),
    MB_QUANT | MB_FORWARD | MB_PATTERN: (2, 5),
}
B_MACROBLOCK_TYPE_CODES: Final = {
    MB_INTRA: (3, 5),
    MB_BACKWARD: (2, 3),
    MB_BACKWARD | MB_PATTERN: (3, 3),
    MB_FORWARD: (2, 4),
    MB_FORWARD | MB_PATTERN: (3, 4),
    MB_FORWARD | MB_BACKWARD: (2, 2),
    MB_FORWARD | MB_BACKWARD | MB_PATTERN: (3, 2),
    MB_QUANT | MB_INTRA: (1, 6),
    MB_QUANT | MB_BACKWARD | MB_PATTERN: (2, 6),
    MB_QUANT | MB_FORWARD | MB_PATTERN: (3, 6),
    MB_QUANT | MB_FORWARD | MB_BACKWARD | MB_PATTERN: (2, 5),
}

# B.9 coded_block_pattern_420 codes by pattern
CODED_BLOCK_PATTERN_CODES: Final = (
    (0x1, 9), (0xB, 5), (0x9, 5), (0xD, 6), (0xD, 4), (0x17, 7), (0x13, 7), (0x1F, 8),
    (0xC, 4), (0x16, 7), (0x12, 7), (0x1E, 8), (0x13, 5), (0x1B, 8), (0x17, 8), (0x13, 8),
    (0xB, 4), (0x15, 7), (0x11, 7), (0x1D, 8), (0x11, 5), (0x19, 8), (0x15, 8), (0x11, 8),
    (0xF, 6), (0xF, 8), (0xD, 8), (0x3, 9), (0xF, 5), (0xB, 8), (0x7, 8), (0x7, 9),
    (0xA, 4), (0x14, 7), (0x10, 7), (0x1C, 8), (0xE, 6), (0xE, 8), (0xC, 8), (0x2, 9),
    (0x10, 5), (0x18, 8), (0x14, 8), (0x10, 8), (0xE, 5), (0xA, 8), (0x6, 8), (0x6, 9),
    (0x12, 5), (0x1A, 8), (0x16, 8), (0x12, 8), (0xD, 5), (0x9, 8), (0x5, 8), (0x5, 9),
    (0xC, 5), (0x8, 8), (0x4, 8), (0x4, 9), (0x7, 3), (0xA, 5), (0x8, 5), (0xC, 6),
)

# B.10 motion_code magnitudes 0 to 16
MOTION_CODE_CODES: Final = (
    (0x1, 1), (0x1, 2), (0x1, 3), (0x1, 4), (0x3, 6), (0x5, 7), (0x4, 7), (0x3, 7),
    (0xB, 9), (0xA, 9), (0x9, 9), (0x11, 10), (0x10, 10), (0xF, 10), (0xE, 10), (0xD, 10), (0xC, 10),
)

# B.12 and B.13 dct_dc_size codes by size
DC_SIZE_LUMINANCE_CODES: Final = (
    (0x4, 3), (0x0, 2), (0x1, 2), (0x5, 3), (0x6, 3), (0xE, 4), (0x1E, 5), (0x3E, 6), (0x7E, 7), (0xFE, 8), (0x1FE, 9), (0x1FF, 9),
)
DC_SIZE_CHROMINANCE_CODES: Final = (
    (0x0, 2), (0x1, 2), (0x2, 2), (0x6, 3), (0xE, 4), (0x1E, 5), (0x3E, 6), (0x7E, 7), (0xFE, 8), (0x1FE, 9), (0x3FE, 10), (0x3FF, 10),
)

# B.14 and B.15 dct_coefficients codes, in the order of COEFFICIENT_RUNS and COEFFICIENT_LEVELS
B14_CODES: Final = (
    (0x3, 2), (0x4, 4), (0x5, 5), (0x6, 7), (0x26, 8), (0x21, 8), (0xA, 10), (0x1D, 12),
    (0x18, 12), (0x13, 12), (0x10, 12), (0x1A, 13), (0x19, 13), (0x18, 13), (0x17, 13), (0x1F, 14),
    (0x1E, 14), (0x1D, 14), (0x1C, 14), (0x1B, 14), (0x1A, 14), (0x19, 14), (0x18, 14), (0x17, 14),
    (0x16, 14), (0x15, 14), (0x14, 14), (0x13, 14), (0x12, 14), (0x11, 14), (0x10, 14), (0x18, 15),
    (0x17, 15), (0x16, 15), (0x15, 15), (0x14, 15), (0x13, 15), (0x12, 15), (0x11, 15), (0x10, 15),
    (0x3, 3), (0x6, 6), (0x25, 8), (0xC, 10), (0x1B, 12), (0x16, 13), (0x15, 13), (0x1F, 15),
    (0x1E, 15), (0x1D, 15), (0x1C, 15), (0x1B, 15), (0x1A, 15), (0x19, 15), (0x13, 16), (0x12, 16),
    (0x11, 16), (0x10, 16), (0x5, 4), (0x4, 7), (0xB, 10), (0x14, 12), (0x14, 13), (0x7, 5),
    (0x24, 8), (0x1C, 12), (0x13, 13), (0x6, 5), (0xF, 10), (0x12, 12), (0x7, 6), (0x9, 10),
    (0x12, 13), (0x5, 6), (0x1E, 12), (0x14, 16), (0x4, 6), (0x15, 12), (0x7, 7), (0x11, 12),
    (0x5, 7), (0x11, 13), (0x27, 8), (0x10, 13), (0x23, 8), (0x1A, 16), (0x22, 8), (0x19, 16),
    (0x20, 8), (0x18, 16), (0xE, 10), (0x17, 16), (0xD, 10), (0x16, 16), (0x8, 10), (0x15, 16),
    (0x1F, 12), (0x1A, 12), (0x19, 12), (0x17, 12), (0x16, 12), (0x1F, 13), (0x1E, 13), (0x1D, 13),
    (0x1C, 13), (0x1B, 13), (0x1F, 16), (0x1E, 16), (0x1D, 16), (0x1C, 16), (0x1B, 16),
)
B15_CODES: Final = (
    (0x02, 2), (0x06, 3), (0x07, 4), (0x1C, 5), (0x1D, 5), (0x05, 6), (0x04, 6), (0x7B, 7),
    (0x7C, 7), (0x23, 8), (0x22, 8), (0xFA, 8), (0xFB, 8), (0xFE, 8), (0xFF, 8), (0x1F, 14),
    (0x1E, 14), (0x1D, 14), (0x1C, 14), (0x1B, 14), (0x1A, 14), (0x19, 14), (0x18, 14), (0x17, 14),
    (0x16, 14), (0x15, 14), (0x14, 14), (0x13, 14), (0x12, 14), (0x11, 14), (0x10, 14), (0x18, 15),
    (0x17, 15), (0x16, 15), (0x15, 15), (0x14, 15), (0x13, 15), (0x12, 15), (0x11, 15), (0x10, 15),
    (0x02, 3), (0x06, 5), (0x79, 7), (0x27, 8), (0x20, 8), (0x16, 13), (0x15, 13), (0x1F, 15),
    (0x1E, 15), (0x1D, 15), (0x1C, 15), (0x1B, 15), (0x1A, 15), (0x19, 15), (0x13, 16), (0x12, 16),
    (0x11, 16), (0x10, 16), (0x05, 5), (0x07, 7), (0xFC, 8), (0x0C, 10), (0x14, 13), (0x07, 5),
    (0x26, 8), (0x1C, 12), (0x13, 13), (0x06, 6), (0xFD, 8), (0x12, 12), (0x07, 6), (0x04, 9),
    (0x12, 13), (0x06, 7), (0x1E, 12), (0x14, 16), (0x04, 7), (0x15, 12), (0x05, 7), (0x11, 12),
    (0x78, 7), (0x11, 13), (0x7A, 7), (0x10, 13), (0x21, 8), (0x1A, 16), (0x25, 8), (0x19, 16),
    (0x24, 8), (0x18, 16), (0x05, 9), (0x17, 16), (0x07, 9), (0x16, 16), (0x0D, 10), (0x15, 16),
    (0x1F, 12), (0x1A, 12), (0x19, 12), (0x17, 12), (0x16, 12), (0x1F, 13), (0x1E, 13), (0x1D, 13),
    (0x1C, 13), (0x1B, 13), (0x1F, 16), (0x1E, 16), (0x1D, 16), (0x1C, 16), (0x1B, 16),
)
COEFFICIENT_LEVELS: Final = (
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    33, 34, 35, 36, 37, 38, 39, 40,
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    1, 2, 3, 4, 5, 1, 2, 3, 4, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 1, 2,
    1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
)
COEFFICIENT_RUNS: Final = (
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    2, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 8, 8,
    9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16,
    17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
)
COEFFICIENT_ESCAPE_CODE: Final = (0x1, 6)
B14_END_OF_BLOCK: Final = (0x2, 2)
B15_END_OF_BLOCK: Final = (0x6, 4)
# A non-intra block's first coefficient of run 0 and magnitude 1 is 1s
FIRST_COEFFICIENT_CODE: Final = (0x1, 1)

ZIGZAG_SCAN: Final = (
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
)
ALTERNATE_VERTICAL_SCAN: Final = (
    0, 8, 16, 24, 1, 9, 2, 10, 17, 25, 32, 40, 48, 56, 57, 49, 41, 33, 26, 18, 3, 11, 4, 12, 19, 27, 34, 42, 50, 58, 35, 43,
    51, 59, 20, 28, 5, 13, 6, 14, 21, 29, 36, 44, 52, 60, 37, 45, 53, 61, 22, 30, 7, 15, 23, 31, 38, 46, 54, 62, 39, 47, 55, 63,
)
NON_LINEAR_QUANTIZER_SCALE: Final = (
    0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 96, 104, 112,
)
DEFAULT_INTRA_MATRIX: Final = (
    8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27, 29, 34, 34, 38, 22, 22, 26, 27, 29, 34, 37, 40,
    22, 26, 27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58, 26, 27, 29, 34, 38, 46, 56, 69, 27, 29, 35, 38, 46, 56, 69, 83,
)
DEFAULT_NON_INTRA_WEIGHT: Final = 16

# The forward DCT's basis, round(4096 * c(u) / 2 * cos((2x + 1) u pi / 16)), so the transform is integer arithmetic on every machine
DCT_BASIS: Final = (
    (1448, 1448, 1448, 1448, 1448, 1448, 1448, 1448),
    (2009, 1703, 1138, 400, -400, -1138, -1703, -2009),
    (1892, 784, -784, -1892, -1892, -784, 784, 1892),
    (1703, -400, -2009, -1138, 1138, 2009, 400, -1703),
    (1448, -1448, -1448, 1448, 1448, -1448, -1448, 1448),
    (1138, -2009, 400, 1703, -1703, -400, 2009, -1138),
    (784, -1892, 1892, -784, -784, 1892, -1892, 784),
    (400, -1138, 1703, -2009, 2009, -1703, 1138, -400),
)
DCT_BASIS_SHIFT: Final = 12


class VectorGenerationError(RuntimeError):
    """Reports a generated stream FFmpeg does not decode cleanly."""


class Random:
    """xorshift32, so the coding choices are the same on every machine and Python version."""

    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFFFFFF or 1

    def next(self) -> int:
        value = self.state
        value ^= (value << 13) & 0xFFFFFFFF
        value ^= value >> 17
        value ^= (value << 5) & 0xFFFFFFFF
        self.state = value
        return value

    def below(self, bound: int) -> int:
        return self.next() % bound

    def between(self, low: int, high: int) -> int:
        return low + self.below(high - low + 1)

    def chance(self, percent: int) -> bool:
        return self.below(100) < percent

    def choice_of(self, choices: Sequence[int]) -> int:
        return choices[self.below(len(choices))]


class BitWriter:
    """Writes bits most significant first; start codes are byte aligned behind zero stuffing."""

    def __init__(self) -> None:
        self.buffer = bytearray()
        self.accumulator = 0
        self.pending_bits = 0

    def write(self, value: int, count: int) -> None:
        if count == 0:
            return
        self.accumulator = (self.accumulator << count) | (value & ((1 << count) - 1))
        self.pending_bits += count
        while self.pending_bits >= 8:
            self.pending_bits -= 8
            self.buffer.append((self.accumulator >> self.pending_bits) & 0xFF)
        self.accumulator &= (1 << self.pending_bits) - 1

    def write_code(self, code: tuple[int, int]) -> None:
        self.write(code[0], code[1])

    def align(self) -> None:
        if self.pending_bits:
            self.write(0, 8 - self.pending_bits)

    def start_code(self, code: int) -> None:
        self.align()
        self.buffer += bytes((0, 0, 1, code))

    def take(self) -> bytes:
        self.align()
        data = bytes(self.buffer)
        self.buffer = bytearray()
        return data


def build_coefficient_codes(code_table: Sequence[tuple[int, int]]) -> dict[tuple[int, int], tuple[int, int]]:
    """Maps (run, magnitude) to the table's code, without its sign bit."""

    return {(COEFFICIENT_RUNS[index], COEFFICIENT_LEVELS[index]): code_table[index] for index in range(len(COEFFICIENT_RUNS))}


B14_COEFFICIENT_CODES: Final = build_coefficient_codes(B14_CODES)
B15_COEFFICIENT_CODES: Final = build_coefficient_codes(B15_CODES)


def sign_extend(value: int, bits: int) -> int:
    """FFmpeg's sign_extend."""

    value &= (1 << bits) - 1
    return value - (1 << bits) if value >> (bits - 1) else value


def truncating_half(value: int) -> int:
    """value / 2 as C divides, toward zero."""

    return -((-value) // 2) if value < 0 else value // 2


def forward_dct(samples: Sequence[int]) -> list[int]:
    """The 8x8 DCT of 64 samples in raster order, rounded to integers."""

    rows = []
    for row in range(8):
        line = samples[row * 8:row * 8 + 8]
        rows.append([sum(DCT_BASIS[frequency][x] * line[x] for x in range(8)) for frequency in range(8)])
    coefficients = [0] * 64
    rounding = 1 << (2 * DCT_BASIS_SHIFT - 1)
    for frequency_x in range(8):
        for frequency_y in range(8):
            total = sum(DCT_BASIS[frequency_y][row] * rows[row][frequency_x] for row in range(8))
            coefficients[frequency_y * 8 + frequency_x] = (total + rounding) >> (2 * DCT_BASIS_SHIFT) if total >= 0 else -((-total + rounding) >> (2 * DCT_BASIS_SHIFT))
    return coefficients


@dataclass
class SequenceParameters:
    """A sequence's parameters."""

    width: int
    height: int
    chroma_format: int
    profile_and_level: int
    intra_matrix: tuple[int, ...]
    non_intra_matrix: tuple[int, ...]
    load_intra: bool = True
    load_non_intra: bool = True

    @property
    def macroblock_width(self) -> int:
        return (self.width + 15) // 16

    @property
    def macroblock_height(self) -> int:
        # An interlaced sequence's frame holds whole macroblock rows of each field
        return (self.height + 31) // 32 * 2

    @property
    def chroma_width_shift(self) -> int:
        return 0 if self.chroma_format == CHROMA_444 else 1

    @property
    def chroma_height_shift(self) -> int:
        return 1 if self.chroma_format == CHROMA_420 else 0

    @property
    def blocks_per_macroblock(self) -> int:
        return {CHROMA_420: 6, CHROMA_422: 8, CHROMA_444: 12}[self.chroma_format]


@dataclass
class Matrices:
    """The quantizer matrices in force, in raster order."""

    intra: list[int]
    non_intra: list[int]
    chroma_intra: list[int]
    chroma_non_intra: list[int]


@dataclass
class PictureSpecification:
    """One coded picture: a frame picture or one field picture, and the tools it exercises."""

    picture_type: int
    structure: int
    temporal_reference: int
    intra_dc_precision: int
    q_scale_type: int
    intra_vlc_format: int
    alternate_scan: int
    frame_pred_frame_dct: int = 0
    concealment_motion_vectors: int = 0
    top_field_first: int = 1
    repeat_first_field: int = 0
    progressive_frame: int = 0
    forward_f_code: tuple[int, int] = (3, 3)
    backward_f_code: tuple[int, int] = (3, 3)
    # A quant_matrix_extension the picture carries: intra, non-intra, chroma intra, chroma non-intra, each optional
    matrix_extension: tuple[tuple[int, ...] | None, ...] | None = None
    # Percent chances of the macroblock choices
    intra_percent: int = 8
    skip_percent: int = 20
    zero_motion_percent: int = 10
    coded_percent: int = 70
    quantizer_change_percent: int = 15
    extra_coefficient_percent: int = 30
    escape_percent: int = 10


@dataclass
class FrameSpecification:
    """One coded frame, a packet: a frame picture or a pair of field pictures, its display index, and the headers before it."""

    display_index: int
    pictures: list[PictureSpecification]
    sequence_header: bool = False
    group_of_pictures: bool = False
    closed_gop: int = 0
    end_of_sequence: bool = False


@dataclass
class VectorSpecification:
    """One vector: its file, sequence, frames in decode order, and seed."""

    file_name: str
    sequence: SequenceParameters
    frames: list[FrameSpecification]
    seed: int


def ramp_matrix(first: int, step_x: int, step_y: int, intra: bool) -> tuple[int, ...]:
    """A matrix rising from first, its intra DC weight 8 as FFmpeg keeps it."""

    values = [min(255, max(1, first + x * step_x + y * step_y)) for y in range(8) for x in range(8)]
    if intra:
        values[0] = 8
    return tuple(values)


def source_sample(plane: int, x: int, y: int, frame: int, width: int, height: int) -> int:
    """A deterministic test picture: moving gradients, a bright moving square, and a fine checker region for high frequencies."""

    if plane == 0:
        value = 64 + ((x * 3 + y * 2 + frame * 6) % 128)
        square_x = (frame * 7) % max(width - 24, 1)
        square_y = (frame * 3) % max(height - 24, 1)
        if square_x <= x < square_x + 24 and square_y <= y < square_y + 24:
            value = 220 - ((x + y) % 16)
        if x * 3 < width and y * 2 > height and ((x >> 1) + (y >> 1) + frame) % 2 == 0:
            value = 40 + ((x * y + frame) % 32)
        return value
    if plane == 1:
        return 96 + ((x * 2 + frame * 3) % 64)
    return 160 - ((y * 2 + x + frame * 2) % 64)


@dataclass
class SourceFrame:
    """A frame's three planes at the coded size, rows of samples."""

    planes: list[list[list[int]]]


def make_source_frame(sequence: SequenceParameters, frame: int) -> SourceFrame:
    coded_width = sequence.macroblock_width * 16
    coded_height = sequence.macroblock_height * 16
    planes = []
    for plane in range(3):
        width = coded_width if plane == 0 else coded_width >> sequence.chroma_width_shift
        height = coded_height if plane == 0 else coded_height >> sequence.chroma_height_shift
        planes.append([[source_sample(plane, x, y, frame, width, height) for x in range(width)] for y in range(height)])
    return SourceFrame(planes)


def reference_sample(source: SourceFrame, plane: int, x: int, line: int, field: int | None) -> int:
    """A sample of a reference frame's plane at a frame line, or at a field's line when field is 0 or 1; clamped to the plane."""

    rows = source.planes[plane]
    frame_line = line if field is None else line * 2 + field
    frame_line = min(max(frame_line, 0), len(rows) - 1)
    row = rows[frame_line]
    return row[min(max(x, 0), len(row) - 1)]


def predict_sample(source: SourceFrame, plane: int, x: int, line: int, field: int | None, half_x: int, half_y: int) -> int:
    """A half-sample interpolated sample, rounded as MPEG-2 rounds it."""

    a = reference_sample(source, plane, x, line, field)
    if half_x and half_y:
        b = reference_sample(source, plane, x + 1, line, field)
        c = reference_sample(source, plane, x, line + 1, field)
        d = reference_sample(source, plane, x + 1, line + 1, field)
        return (a + b + c + d + 2) >> 2
    if half_x:
        return (a + reference_sample(source, plane, x + 1, line, field) + 1) >> 1
    if half_y:
        return (a + reference_sample(source, plane, x, line + 1, field) + 1) >> 1
    return a


@dataclass
class Operation:
    """One prediction: the reference, its field or None for the whole frame, the vector, the luma line its rows start at before the
    vector, the luma height of its rows, and the luma rows of the macroblock it predicts."""

    reference: SourceFrame
    field: int | None
    vector: tuple[int, int]
    luma_line_base: int
    luma_height: int
    vertical_edge: int


@dataclass
class MotionPlan:
    """An inter macroblock's motion, as FFmpeg's mv_dir, mv_type, mv, and field_select hold it."""

    forward: bool
    backward: bool
    motion_type: int
    vectors: dict[tuple[int, int], tuple[int, int]] = field(default_factory=dict)
    field_selects: dict[tuple[int, int], int] = field(default_factory=dict)
    dual_prime_differential: tuple[int, int] = (0, 0)
    dual_prime_base: tuple[int, int] = (0, 0)


class PictureEncoder:
    """Encodes one picture's slices, mirroring the decoder's prediction state so every vector and DC differential decodes as chosen."""

    def __init__(self, sequence: SequenceParameters, picture: PictureSpecification, matrices: Matrices, random: Random,
                 current: SourceFrame, forward: SourceFrame | None, backward: SourceFrame | None, first_field: bool) -> None:
        self.sequence = sequence
        self.picture = picture
        self.matrices = matrices
        self.random = random
        self.current = current
        self.forward = forward
        self.backward = backward
        self.first_field = first_field
        self.writer = BitWriter()
        self.field_picture = picture.structure != STRUCTURE_FRAME
        self.parity = (picture.structure - 1) & 1
        self.scan = ALTERNATE_VERTICAL_SCAN if picture.alternate_scan else ZIGZAG_SCAN
        rows = sequence.macroblock_height // 2 if self.field_picture else sequence.macroblock_height
        self.rows = rows
        self.horizontal_edge = sequence.macroblock_width * 16
        self.frame_edge = sequence.macroblock_height * 16
        self.field_edge = sequence.macroblock_height * 8

    # Prediction state, reset per slice as FFmpeg resets it
    def reset_slice_state(self, quantizer_code: int) -> None:
        self.quantizer_code = quantizer_code
        self.last_dc = [128 << self.picture.intra_dc_precision] * 3
        self.prediction = {0: [0, 0, 0, 0], 1: [0, 0, 0, 0]}
        self.previous_intra = False
        self.previous_motion: MotionPlan | None = None

    def quantizer_scale(self) -> int:
        if self.picture.q_scale_type:
            return NON_LINEAR_QUANTIZER_SCALE[self.quantizer_code]
        return self.quantizer_code << 1

    def encode(self) -> bytes:
        for row in range(self.rows):
            self.encode_row(row)
        return self.writer.take()

    def slice_starts(self, row: int) -> list[int]:
        width = self.sequence.macroblock_width
        starts = [0]
        if width >= 4 and self.random.chance(30):
            starts.append(self.random.between(1, width - 2))
        return starts

    def encode_row(self, row: int) -> None:
        starts = self.slice_starts(row)
        width = self.sequence.macroblock_width
        for index, start in enumerate(starts):
            end = starts[index + 1] if index + 1 < len(starts) else width
            self.encode_slice(row, start, end)

    def encode_slice(self, row: int, start: int, end: int) -> None:
        writer = self.writer
        writer.start_code(row + 1)
        quantizer_code = self.random.between(2, 18)
        writer.write(quantizer_code, 5)
        # extra_bit_slice, sometimes with a byte of extra_information_slice
        if self.random.chance(10):
            writer.write(1, 1)
            writer.write(self.random.below(256), 8)
        writer.write(0, 1)
        self.reset_slice_state(quantizer_code)
        skipped = 0
        # The first increment counts from the row start, whichever column the slice starts at
        previous_address = -1
        for column in range(start, end):
            first_or_last = column == start or column == end - 1
            if not first_or_last and self.try_skip(row, column):
                skipped += 1
                continue
            self.write_address_increment(column - previous_address)
            previous_address = column
            skipped = 0
            self.encode_macroblock(row, column)

    def write_address_increment(self, increment: int) -> None:
        while increment > MACROBLOCK_ESCAPE_INCREMENT:
            self.writer.write_code(MACROBLOCK_ESCAPE_CODE)
            increment -= MACROBLOCK_ESCAPE_INCREMENT
        self.writer.write_code(MACROBLOCK_ADDRESS_INCREMENT_CODES[increment - 1])

    # Geometry
    def macroblock_frame_row(self, row: int) -> int:
        """FFmpeg's mb_y of a picture row."""

        return row * 2 + self.parity if self.field_picture else row

    def operations(self, row: int, column: int, motion: MotionPlan, luma_row: int) -> list[Operation]:
        """The predictions of one luma row of the macroblock, as the decoder chooses them."""

        operations: list[Operation] = []
        if not self.field_picture:
            if motion.motion_type == MOTION_FRAME:
                base = row * 16
                for direction, used, reference in ((0, motion.forward, self.forward), (1, motion.backward, self.backward)):
                    if used:
                        operations.append(Operation(reference, None, motion.vectors[(direction, 0)], base, 16, self.frame_edge))
                return operations
            parity = luma_row & 1
            base = row * 8
            if motion.motion_type == MOTION_DUAL_PRIME:
                operations.append(Operation(self.forward, parity, motion.vectors[(0, parity)], base, 8, self.field_edge))
                operations.append(Operation(self.forward, 1 - parity, motion.vectors[(0, 2 + parity)], base, 8, self.field_edge))
                return operations
            for direction, used, reference in ((0, motion.forward, self.forward), (1, motion.backward, self.backward)):
                if used:
                    operations.append(Operation(reference, motion.field_selects[(direction, parity)], motion.vectors[(direction, parity)],
                                                base, 8, self.field_edge))
            return operations
        base = row * 16
        if motion.motion_type == MOTION_DUAL_PRIME:
            opposite = self.forward if self.first_field else self.current
            operations.append(Operation(self.forward, self.parity, motion.vectors[(0, 0)], base, 16, self.field_edge))
            operations.append(Operation(opposite, 1 - self.parity, motion.vectors[(0, 2)], base, 16, self.field_edge))
            return operations
        half = 0
        height = 16
        if motion.motion_type == MOTION_16X8:
            half = 1 if luma_row >= 8 else 0
            base += half * 8
            height = 8
        for direction, used in ((0, motion.forward), (1, motion.backward)):
            if not used:
                continue
            select = motion.field_selects[(direction, half)]
            reference = self.backward if direction else self.forward
            if direction == 0 and self.picture.picture_type != PICTURE_TYPE_B and not self.first_field and select != self.parity:
                reference = self.current
            operations.append(Operation(reference, select, motion.vectors[(direction, half)], base, height, self.field_edge))
        return operations

    def operation_valid(self, column: int, operation: Operation) -> bool:
        """FFmpeg's out-of-picture check, which skips a prediction the decoder must never skip."""

        vector_x, vector_y = operation.vector
        luma_x = column * 16 + (vector_x >> 1)
        luma_y = operation.luma_line_base + (vector_y >> 1)
        x_limit = max(self.horizontal_edge - (vector_x & 1) - 15, 0)
        y_limit = max(operation.vertical_edge - (vector_y & 1) - operation.luma_height + 1, 0)
        return 0 <= luma_x < x_limit and 0 <= luma_y < y_limit

    def motion_valid(self, row: int, column: int, motion: MotionPlan) -> bool:
        for luma_row in range(16):
            for operation in self.operations(row, column, motion, luma_row):
                if not self.operation_valid(column, operation):
                    return False
        return True

    def predicted_sample(self, row: int, column: int, motion: MotionPlan, plane: int, x: int, plane_row: int,
                         operations_by_row: dict[int, list[Operation]]) -> int:
        """The prediction of a macroblock sample, plane coordinates relative to the macroblock, as the decoder forms it."""

        chroma_420 = plane != 0 and self.sequence.chroma_format == CHROMA_420
        luma_row = plane_row * 2 if chroma_420 else plane_row
        operations = operations_by_row.get(luma_row)
        if operations is None:
            operations = self.operations(row, column, motion, luma_row)
            operations_by_row[luma_row] = operations
        if not self.field_picture and motion.motion_type != MOTION_FRAME:
            row_in_group = plane_row >> 1
        elif motion.motion_type == MOTION_16X8:
            plane_rows = 8 if chroma_420 else 16
            row_in_group = plane_row - (plane_rows // 2 if luma_row >= 8 else 0)
        else:
            row_in_group = plane_row
        values = []
        for operation in operations:
            vector_x, vector_y = operation.vector
            if plane == 0 or self.sequence.chroma_format == CHROMA_444:
                sample_x = column * 16 + x + (vector_x >> 1)
                line = operation.luma_line_base + (vector_y >> 1) + row_in_group
                values.append(predict_sample(operation.reference, plane, sample_x, line, operation.field, vector_x & 1, vector_y & 1))
                continue
            chroma_x = truncating_half(vector_x)
            sample_x = column * 8 + x + (chroma_x >> 1)
            if self.sequence.chroma_format == CHROMA_422:
                line = operation.luma_line_base + (vector_y >> 1) + row_in_group
                values.append(predict_sample(operation.reference, plane, sample_x, line, operation.field, chroma_x & 1, vector_y & 1))
                continue
            chroma_y = truncating_half(vector_y)
            line = (operation.luma_line_base >> 1) + (chroma_y >> 1) + row_in_group
            values.append(predict_sample(operation.reference, plane, sample_x, line, operation.field, chroma_x & 1, chroma_y & 1))
        if len(values) == 2:
            return (values[0] + values[1] + 1) >> 1
        return values[0]

    # Block geometry, the decoder's residualIndex inverted
    def block_positions(self, block: int, field_dct: bool) -> list[tuple[int, int, int]]:
        """The (plane, x, row) of a block's 64 samples in raster order, relative to the macroblock."""

        chroma_format = self.sequence.chroma_format
        if block < 4:
            plane, x_offset, vertical, field_ordered = 0, (block & 1) * 8, block >> 1, field_dct
        elif chroma_format == CHROMA_420:
            plane, x_offset, vertical, field_ordered = 1 + ((block - 4) & 1), 0, 0, False
        elif chroma_format == CHROMA_422:
            plane, x_offset, vertical, field_ordered = 1 + ((block - 4) & 1), 0, (block - 4) >> 1, field_dct
        else:
            index = (block - 4) >> 1
            plane, x_offset, vertical, field_ordered = 1 + ((block - 4) & 1), (index >> 1) * 8, index & 1, field_dct
        positions = []
        for block_row in range(8):
            plane_row = vertical + block_row * 2 if field_ordered else vertical * 8 + block_row
            for block_column in range(8):
                positions.append((plane, x_offset + block_column, plane_row))
        return positions

    def source_sample_of(self, row: int, column: int, plane: int, x: int, plane_row: int) -> int:
        """The current frame's sample of a macroblock position."""

        plane_width = 16 if plane == 0 or self.sequence.chroma_format == CHROMA_444 else 8
        plane_height = 8 if plane != 0 and self.sequence.chroma_format == CHROMA_420 else 16
        sample_x = column * plane_width + x
        if self.field_picture:
            frame_row = ((row * plane_height) + plane_row) * 2 + self.parity
        else:
            frame_row = row * plane_height + plane_row
        return self.current.planes[plane][frame_row][sample_x]

    # Coefficients
    def level_bound(self, weight: int, intra: bool, limit: int = MAXIMUM_DEQUANTIZED) -> int:
        """The largest level magnitude whose dequantization stays within limit: (L * s) >> 4 or ((2L + 1) * s) >> 5; at least 1."""

        step = self.quantizer_scale() * weight
        if intra:
            bound = (limit * 16 + 15) // step
        else:
            bound = ((limit * 32 + 31) // step - 1) // 2
        bound = min(bound, MAXIMUM_ESCAPE_LEVEL)
        return max(bound, 1)

    def matrix_of(self, block: int, intra: bool) -> list[int]:
        chroma = block >= 4
        if intra:
            return self.matrices.chroma_intra if chroma else self.matrices.intra
        return self.matrices.chroma_non_intra if chroma else self.matrices.non_intra

    def quantize_block(self, coefficients: list[int], block: int, intra: bool) -> list[int]:
        """Levels in scan order from DCT coefficients, plus exerciser coefficients, each within the dequantization bound."""

        matrix = self.matrix_of(block, intra)
        scale = self.quantizer_scale()
        levels = [0] * 64
        first = 1 if intra else 0
        for scan_index in range(first, 64):
            position = self.scan[scan_index]
            weight = matrix[position]
            value = coefficients[position]
            if intra:
                level = (abs(value) * 16 + scale * weight // 2) // (scale * weight)
            else:
                level = (abs(value) * 16) // (scale * weight)
            level = min(level, self.level_bound(weight, intra))
            levels[scan_index] = level if value >= 0 else -level
        if self.random.chance(self.picture.extra_coefficient_percent):
            for _ in range(self.random.between(1, 4)):
                scan_index = self.random.between(first, 63)
                weight = matrix[self.scan[scan_index]]
                bound = self.level_bound(weight, intra, MAXIMUM_EXTRA_DEQUANTIZED)
                magnitude = self.random.between(1, min(bound, 40 if self.random.chance(80) else bound))
                levels[scan_index] = magnitude if self.random.chance(50) else -magnitude
        return levels

    def write_coefficient(self, run: int, level: int, table: dict[tuple[int, int], tuple[int, int]], force_escape: bool) -> None:
        code = table.get((run, abs(level)))
        if code is None or force_escape:
            self.writer.write_code(COEFFICIENT_ESCAPE_CODE)
            self.writer.write(run, 6)
            self.writer.write(level & 0xFFF, 12)
            return
        self.writer.write_code(code)
        self.writer.write(1 if level < 0 else 0, 1)

    def write_non_intra_block(self, levels: list[int]) -> None:
        run = 0
        first = True
        for scan_index in range(64):
            level = levels[scan_index]
            if level == 0:
                run += 1
                continue
            if first and run == 0 and abs(level) == 1:
                self.writer.write_code(FIRST_COEFFICIENT_CODE)
                self.writer.write(1 if level < 0 else 0, 1)
            else:
                self.write_coefficient(run, level, B14_COEFFICIENT_CODES, self.random.chance(self.picture.escape_percent))
            first = False
            run = 0
        self.writer.write_code(B14_END_OF_BLOCK)

    def write_intra_block(self, block: int, levels: list[int], dc: int) -> None:
        component = 0 if block < 4 else 1 + ((block - 4) & 1)
        difference = dc - self.last_dc[component]
        self.last_dc[component] = dc
        size = abs(difference).bit_length()
        size_codes = DC_SIZE_LUMINANCE_CODES if component == 0 else DC_SIZE_CHROMINANCE_CODES
        self.writer.write_code(size_codes[size])
        if size:
            self.writer.write(difference if difference > 0 else difference + (1 << size) - 1, size)
        table = B15_COEFFICIENT_CODES if self.picture.intra_vlc_format else B14_COEFFICIENT_CODES
        run = 0
        for scan_index in range(1, 64):
            level = levels[scan_index]
            if level == 0:
                run += 1
                continue
            self.write_coefficient(run, level, table, self.random.chance(self.picture.escape_percent))
            run = 0
        self.writer.write_code(B15_END_OF_BLOCK if self.picture.intra_vlc_format else B14_END_OF_BLOCK)

    def intra_block(self, row: int, column: int, block: int, field_dct: bool) -> tuple[list[int], int]:
        samples = [self.source_sample_of(row, column, plane, x, plane_row) - 128 for plane, x, plane_row in self.block_positions(block, field_dct)]
        coefficients = forward_dct(samples)
        precision = self.picture.intra_dc_precision
        # The DC in the precision's units: 8 times the mean, divided by 8 >> precision, around the 128 offset
        dc = ((coefficients[0] + 1024) << precision) // 8
        dc = min(max(dc, 0), (256 << precision) - 1)
        return self.quantize_block(coefficients, block, True), dc

    def residual_block(self, row: int, column: int, block: int, field_dct: bool, motion: MotionPlan,
                       operations_by_row: dict[int, list[Operation]]) -> list[int]:
        samples = [
            self.source_sample_of(row, column, plane, x, plane_row)
            - self.predicted_sample(row, column, motion, plane, x, plane_row, operations_by_row)
            for plane, x, plane_row in self.block_positions(block, field_dct)
        ]
        return self.quantize_block(forward_dct(samples), block, False)

    # Motion vectors
    def write_motion_component(self, value: int, prediction: int, f_code: int) -> None:
        shift = f_code - 1
        delta = sign_extend(value - prediction, 5 + shift)
        if delta == 0:
            self.writer.write_code(MOTION_CODE_CODES[0])
            return
        magnitude = abs(delta) - 1
        code = (magnitude >> shift) + 1
        self.writer.write_code(MOTION_CODE_CODES[code])
        self.writer.write(1 if delta < 0 else 0, 1)
        if shift:
            self.writer.write(magnitude & ((1 << shift) - 1), shift)

    def f_code(self, direction: int) -> tuple[int, int]:
        return self.picture.backward_f_code if direction else self.picture.forward_f_code

    def vector_range(self, f_code: int) -> tuple[int, int]:
        return -(16 << (f_code - 1)), (16 << (f_code - 1)) - 1

    def random_vector(self, direction: int, limit: int) -> tuple[int, int]:
        f_x, f_y = self.f_code(direction)
        low_x, high_x = self.vector_range(f_x)
        low_y, high_y = self.vector_range(f_y)
        return (self.random.between(max(low_x, -limit), min(high_x, limit)), self.random.between(max(low_y, -limit), min(high_y, limit)))

    def dual_prime_vectors(self, base: tuple[int, int], differential: tuple[int, int]) -> dict[tuple[int, int], tuple[int, int]]:
        """FFmpeg's MT_DMV derivation of the opposite parity vectors."""

        x, y = base
        differential_x, differential_y = differential

        def scaled(value: int, scale: int, offset: int) -> int:
            return ((value * scale + (1 if value > 0 else 0)) >> 1) + offset

        vectors = {(0, 0): (x, y), (0, 1): (x, y)}
        if not self.field_picture:
            scale = 1 if self.picture.top_field_first else 3
            vectors[(0, 2)] = (scaled(x, scale, differential_x), scaled(y, scale, differential_y) - 1)
            vectors[(0, 3)] = (scaled(x, 4 - scale, differential_x), scaled(y, 4 - scale, differential_y) + 1)
        else:
            parity_offset = -1 if self.picture.structure == STRUCTURE_TOP_FIELD else 1
            vectors[(0, 2)] = (scaled(x, 1, differential_x), scaled(y, 1, differential_y) + parity_offset)
        return vectors

    def choose_motion(self, row: int, column: int, directions: tuple[bool, bool]) -> MotionPlan | None:
        """A random valid motion of the given directions, or None when no attempt keeps every prediction inside its reference."""

        forward, backward = directions
        allow_dual_prime = forward and not backward and self.picture.picture_type == PICTURE_TYPE_P
        for attempt in range(12):
            limit = 24 if attempt < 6 else 6
            if self.field_picture:
                motion_type = self.random.choice_of((MOTION_FIELD, MOTION_16X8, MOTION_DUAL_PRIME) if allow_dual_prime else (MOTION_FIELD, MOTION_16X8))
            elif self.picture.frame_pred_frame_dct:
                motion_type = MOTION_FRAME
            else:
                motion_type = self.random.choice_of((MOTION_FRAME, MOTION_FIELD, MOTION_DUAL_PRIME) if allow_dual_prime else (MOTION_FRAME, MOTION_FIELD))
            motion = MotionPlan(forward, backward, motion_type)
            if motion_type == MOTION_DUAL_PRIME:
                base = self.random_vector(0, min(limit, 8))
                differential = (self.random.between(-1, 1), self.random.between(-1, 1))
                motion.dual_prime_base = base
                motion.dual_prime_differential = differential
                motion.vectors = self.dual_prime_vectors(base, differential)
            else:
                count = 1 if motion_type == MOTION_FRAME or (self.field_picture and motion_type == MOTION_FIELD) else 2
                for direction, used in ((0, forward), (1, backward)):
                    if not used:
                        continue
                    for index in range(count):
                        motion.vectors[(direction, index)] = self.random_vector(direction, limit)
                        motion.field_selects[(direction, index)] = self.random.below(2)
                    if count == 1:
                        motion.vectors[(direction, 1)] = motion.vectors[(direction, 0)]
                        motion.field_selects[(direction, 1)] = motion.field_selects[(direction, 0)]
            if self.motion_valid(row, column, motion):
                return motion
        return None

    def write_motion(self, motion: MotionPlan, direction: int) -> None:
        """motion_vectors(s) for one direction, updating FFmpeg's last_mv as the decoder does."""

        prediction = self.prediction[direction]
        f_x, f_y = self.f_code(direction)
        if motion.motion_type == MOTION_DUAL_PRIME:
            vertical_shift = 0 if self.field_picture else 1
            x, y = motion.dual_prime_base
            differential_x, differential_y = motion.dual_prime_differential
            self.write_motion_component(x, prediction[0], f_x)
            self.write_dual_prime_differential(differential_x)
            self.write_motion_component(y, prediction[1] >> vertical_shift, f_y)
            self.write_dual_prime_differential(differential_y)
            frame_y = y * (1 << vertical_shift)
            self.prediction[direction] = [x, frame_y, x, frame_y]
            return
        if motion.motion_type == MOTION_FRAME or (self.field_picture and motion.motion_type == MOTION_FIELD):
            if self.field_picture:
                self.writer.write(motion.field_selects[(direction, 0)], 1)
            x, y = motion.vectors[(direction, 0)]
            self.write_motion_component(x, prediction[0], f_x)
            self.write_motion_component(y, prediction[1], f_y)
            self.prediction[direction] = [x, y, x, y]
            return
        if motion.motion_type == MOTION_16X8:
            for index in range(2):
                self.writer.write(motion.field_selects[(direction, index)], 1)
                x, y = motion.vectors[(direction, index)]
                self.write_motion_component(x, prediction[index * 2], f_x)
                self.write_motion_component(y, prediction[index * 2 + 1], f_y)
                prediction[index * 2] = x
                prediction[index * 2 + 1] = y
            return
        # Field motion in a frame picture: field vectors, whose vertical prediction is kept in frame units
        for index in range(2):
            self.writer.write(motion.field_selects[(direction, index)], 1)
            x, y = motion.vectors[(direction, index)]
            self.write_motion_component(x, prediction[index * 2], f_x)
            self.write_motion_component(y, prediction[index * 2 + 1] >> 1, f_y)
            prediction[index * 2] = x
            prediction[index * 2 + 1] = y * 2

    def write_dual_prime_differential(self, value: int) -> None:
        if value == 0:
            self.writer.write(0, 1)
        else:
            self.writer.write(1, 1)
            self.writer.write(0 if value > 0 else 1, 1)

    # Skipped macroblocks
    def skipped_motion(self) -> MotionPlan | None:
        """The motion a skipped macroblock takes: zero motion in P pictures, the previous macroblock's predictions in B pictures."""

        motion_type = MOTION_FIELD if self.field_picture else MOTION_FRAME
        if self.picture.picture_type == PICTURE_TYPE_P:
            motion = MotionPlan(True, False, motion_type)
            motion.vectors = {(0, 0): (0, 0), (0, 1): (0, 0)}
            motion.field_selects = {(0, 0): self.parity, (0, 1): self.parity}
            return motion
        previous = self.previous_motion
        if previous is None or self.previous_intra:
            return None
        motion = MotionPlan(previous.forward, previous.backward, motion_type)
        for direction in (0, 1):
            vector = (self.prediction[direction][0], self.prediction[direction][1])
            motion.vectors[(direction, 0)] = vector
            motion.vectors[(direction, 1)] = vector
            motion.field_selects[(direction, 0)] = self.parity
            motion.field_selects[(direction, 1)] = self.parity
        return motion

    def try_skip(self, row: int, column: int) -> bool:
        if self.picture.picture_type == PICTURE_TYPE_I or not self.random.chance(self.picture.skip_percent):
            return False
        motion = self.skipped_motion()
        if motion is None or not self.motion_valid(row, column, motion):
            return False
        if self.picture.picture_type == PICTURE_TYPE_P:
            self.prediction[0] = [0, 0, 0, 0]
        self.last_dc = [128 << self.picture.intra_dc_precision] * 3
        return True

    # Macroblocks
    def macroblock_type_code(self, flags: int) -> tuple[int, int]:
        tables = {PICTURE_TYPE_I: I_MACROBLOCK_TYPE_CODES, PICTURE_TYPE_P: P_MACROBLOCK_TYPE_CODES, PICTURE_TYPE_B: B_MACROBLOCK_TYPE_CODES}
        return tables[self.picture.picture_type][flags]

    def write_quantizer(self, flags: int) -> None:
        if flags & MB_QUANT:
            self.writer.write(self.quantizer_code, 5)

    def choose_quantizer(self) -> int:
        if self.random.chance(self.picture.quantizer_change_percent):
            self.quantizer_code = self.random.between(1, 31) if self.picture.q_scale_type else self.random.between(2, 20)
            return MB_QUANT
        return 0

    def encode_macroblock(self, row: int, column: int) -> None:
        picture_type = self.picture.picture_type
        if picture_type == PICTURE_TYPE_I or self.random.chance(self.picture.intra_percent):
            self.encode_intra_macroblock(row, column)
            return
        if picture_type == PICTURE_TYPE_P and self.random.chance(self.picture.zero_motion_percent):
            self.encode_zero_motion_macroblock(row, column)
            return
        if picture_type == PICTURE_TYPE_P:
            directions = (True, False)
        else:
            directions = ((True, False), (False, True), (True, True))[self.random.below(3)]
        motion = self.choose_motion(row, column, directions)
        if motion is None:
            if picture_type == PICTURE_TYPE_P:
                self.encode_zero_motion_macroblock(row, column)
            else:
                self.encode_intra_macroblock(row, column)
            return
        self.encode_inter_macroblock(row, column, motion)

    def field_dct_choice(self) -> bool:
        return not self.field_picture and not self.picture.frame_pred_frame_dct and self.random.chance(50)

    def encode_intra_macroblock(self, row: int, column: int) -> None:
        flags = MB_INTRA | self.choose_quantizer()
        self.writer.write_code(self.macroblock_type_code(flags))
        field_dct = self.field_dct_choice()
        if not self.field_picture and not self.picture.frame_pred_frame_dct:
            self.writer.write(1 if field_dct else 0, 1)
        self.write_quantizer(flags)
        if self.picture.concealment_motion_vectors:
            if self.field_picture:
                self.writer.write(self.random.below(2), 1)
            f_x, f_y = self.picture.forward_f_code
            low_x, high_x = self.vector_range(f_x)
            low_y, high_y = self.vector_range(f_y)
            x = self.random.between(low_x, high_x)
            y = self.random.between(low_y, high_y)
            self.write_motion_component(x, self.prediction[0][0], f_x)
            self.write_motion_component(y, self.prediction[0][1], f_y)
            self.prediction[0] = [x, y, x, y]
            self.writer.write(1, 1)
        else:
            self.prediction = {0: [0, 0, 0, 0], 1: [0, 0, 0, 0]}
        for block in range(self.sequence.blocks_per_macroblock):
            levels, dc = self.intra_block(row, column, block, field_dct)
            self.write_intra_block(block, levels, dc)
        self.previous_intra = True
        self.previous_motion = None

    def write_coded_blocks(self, blocks: list[list[int]]) -> None:
        count = self.sequence.blocks_per_macroblock
        pattern = 0
        for block in range(count):
            if any(blocks[block]):
                pattern |= 1 << (count - 1 - block)
        self.writer.write_code(CODED_BLOCK_PATTERN_CODES[pattern >> (count - 6)])
        if count > 6:
            self.writer.write(pattern & ((1 << (count - 6)) - 1), count - 6)
        for block in range(count):
            if any(blocks[block]):
                self.write_non_intra_block(blocks[block])

    def residual_blocks(self, row: int, column: int, motion: MotionPlan, field_dct: bool) -> list[list[int]]:
        """Coded residual blocks, some dropped to vary the pattern; at least one coded."""

        blocks = []
        operations_by_row: dict[int, list[Operation]] = {}
        for block in range(self.sequence.blocks_per_macroblock):
            levels = self.residual_block(row, column, block, field_dct, motion, operations_by_row)
            if self.random.chance(30):
                levels = [0] * 64
            blocks.append(levels)
        if not any(any(levels) for levels in blocks):
            block = self.random.below(self.sequence.blocks_per_macroblock)
            blocks[block][self.random.between(0, 20)] = 1 if self.random.chance(50) else -1
        return blocks

    def encode_zero_motion_macroblock(self, row: int, column: int) -> None:
        motion = MotionPlan(True, False, MOTION_FIELD if self.field_picture else MOTION_FRAME)
        motion.vectors = {(0, 0): (0, 0), (0, 1): (0, 0)}
        motion.field_selects = {(0, 0): self.parity, (0, 1): self.parity}
        flags = MB_FORWARD | MB_PATTERN | MB_ZERO_MOTION | self.choose_quantizer()
        self.writer.write_code(self.macroblock_type_code(flags))
        field_dct = self.field_dct_choice()
        if not self.field_picture and not self.picture.frame_pred_frame_dct:
            self.writer.write(1 if field_dct else 0, 1)
        self.write_quantizer(flags)
        self.prediction[0] = [0, 0, 0, 0]
        self.last_dc = [128 << self.picture.intra_dc_precision] * 3
        self.write_coded_blocks(self.residual_blocks(row, column, motion, field_dct))
        self.previous_intra = False
        self.previous_motion = motion

    def encode_inter_macroblock(self, row: int, column: int, motion: MotionPlan) -> None:
        coded = self.random.chance(self.picture.coded_percent)
        flags = (MB_FORWARD if motion.forward else 0) | (MB_BACKWARD if motion.backward else 0)
        if coded:
            flags |= MB_PATTERN | self.choose_quantizer()
        self.writer.write_code(self.macroblock_type_code(flags))
        field_dct = False
        if self.field_picture or not self.picture.frame_pred_frame_dct:
            code = {MOTION_FRAME: MOTION_TYPE_FRAME_CODE, MOTION_16X8: MOTION_TYPE_FRAME_CODE, MOTION_FIELD: MOTION_TYPE_FIELD_CODE,
                    MOTION_DUAL_PRIME: MOTION_TYPE_DUAL_PRIME_CODE}[motion.motion_type]
            self.writer.write(code, 2)
            if not self.field_picture and coded:
                field_dct = self.field_dct_choice()
                self.writer.write(1 if field_dct else 0, 1)
        self.write_quantizer(flags)
        for direction, used in ((0, motion.forward), (1, motion.backward)):
            if used:
                self.write_motion(motion, direction)
        self.last_dc = [128 << self.picture.intra_dc_precision] * 3
        if coded:
            self.write_coded_blocks(self.residual_blocks(row, column, motion, field_dct))
        self.previous_intra = False
        self.previous_motion = motion


def write_matrix(writer: BitWriter, matrix: Sequence[int]) -> None:
    """A matrix in zigzag order."""

    for scan_index in range(64):
        writer.write(matrix[ZIGZAG_SCAN[scan_index]], 8)


def sequence_header(sequence: SequenceParameters) -> bytes:
    writer = BitWriter()
    writer.start_code(SEQUENCE_HEADER_CODE)
    writer.write(sequence.width & 0xFFF, 12)
    writer.write(sequence.height & 0xFFF, 12)
    writer.write(SQUARE_SAMPLE_ASPECT_RATIO, 4)
    writer.write(FRAME_RATE_CODE, 4)
    writer.write(MAXIMUM_BIT_RATE_VALUE, 18)
    writer.write(1, 1)
    writer.write(VBV_BUFFER_SIZE_VALUE, 10)
    writer.write(0, 1)
    writer.write(1 if sequence.load_intra else 0, 1)
    if sequence.load_intra:
        write_matrix(writer, sequence.intra_matrix)
    writer.write(1 if sequence.load_non_intra else 0, 1)
    if sequence.load_non_intra:
        write_matrix(writer, sequence.non_intra_matrix)
    writer.start_code(EXTENSION_START_CODE)
    writer.write(SEQUENCE_EXTENSION_ID, 4)
    writer.write(sequence.profile_and_level, 8)
    writer.write(0, 1)
    writer.write(sequence.chroma_format, 2)
    writer.write(sequence.width >> 12, 2)
    writer.write(sequence.height >> 12, 2)
    writer.write(0, 12)
    writer.write(1, 1)
    writer.write(0, 8)
    writer.write(0, 1)
    writer.write(0, 2)
    writer.write(0, 5)
    return writer.take()


def group_of_pictures(closed_gop: int) -> bytes:
    writer = BitWriter()
    writer.start_code(GROUP_START_CODE)
    # time_code: zero hours, minutes, seconds, and pictures around its marker bit
    writer.write(0, 13)
    writer.write(1, 1)
    writer.write(0, 11)
    writer.write(closed_gop, 1)
    writer.write(0, 1)
    return writer.take()


def picture_headers(picture: PictureSpecification) -> bytes:
    writer = BitWriter()
    writer.start_code(PICTURE_START_CODE)
    writer.write(picture.temporal_reference & 0x3FF, 10)
    writer.write(picture.picture_type, 3)
    writer.write(VBV_DELAY_VARIABLE, 16)
    if picture.picture_type in (PICTURE_TYPE_P, PICTURE_TYPE_B):
        writer.write(0, 1)
        writer.write(MPEG1_F_CODE_FIELD, 3)
    if picture.picture_type == PICTURE_TYPE_B:
        writer.write(0, 1)
        writer.write(MPEG1_F_CODE_FIELD, 3)
    writer.write(0, 1)
    writer.start_code(EXTENSION_START_CODE)
    writer.write(PICTURE_CODING_EXTENSION_ID, 4)
    forward = picture.forward_f_code if picture.picture_type != PICTURE_TYPE_I else (UNUSED_F_CODE, UNUSED_F_CODE)
    if picture.picture_type == PICTURE_TYPE_I and picture.concealment_motion_vectors:
        forward = picture.forward_f_code
    backward = picture.backward_f_code if picture.picture_type == PICTURE_TYPE_B else (UNUSED_F_CODE, UNUSED_F_CODE)
    for value in (*forward, *backward):
        writer.write(value, 4)
    writer.write(picture.intra_dc_precision, 2)
    writer.write(picture.structure, 2)
    writer.write(picture.top_field_first, 1)
    writer.write(picture.frame_pred_frame_dct, 1)
    writer.write(picture.concealment_motion_vectors, 1)
    writer.write(picture.q_scale_type, 1)
    writer.write(picture.intra_vlc_format, 1)
    writer.write(picture.alternate_scan, 1)
    writer.write(picture.repeat_first_field, 1)
    writer.write(1 if picture.progressive_frame else 0, 1)
    writer.write(picture.progressive_frame, 1)
    writer.write(0, 1)
    if picture.matrix_extension is not None:
        writer.start_code(EXTENSION_START_CODE)
        writer.write(QUANT_MATRIX_EXTENSION_ID, 4)
        for matrix in picture.matrix_extension:
            writer.write(0 if matrix is None else 1, 1)
            if matrix is not None:
                write_matrix(writer, matrix)
    return writer.take()


def apply_matrix_extension(matrices: Matrices, extension: tuple[tuple[int, ...] | None, ...]) -> None:
    """FFmpeg's mpeg_decode_quant_matrix_extension: luma loads also load chroma."""

    intra, non_intra, chroma_intra, chroma_non_intra = extension
    if intra is not None:
        matrices.intra = list(intra)
        matrices.chroma_intra = list(intra)
    if non_intra is not None:
        matrices.non_intra = list(non_intra)
        matrices.chroma_non_intra = list(non_intra)
    if chroma_intra is not None:
        matrices.chroma_intra = list(chroma_intra)
    if chroma_non_intra is not None:
        matrices.chroma_non_intra = list(chroma_non_intra)


def sequence_matrices(sequence: SequenceParameters) -> Matrices:
    intra = list(sequence.intra_matrix) if sequence.load_intra else list(DEFAULT_INTRA_MATRIX)
    non_intra = list(sequence.non_intra_matrix) if sequence.load_non_intra else [DEFAULT_NON_INTRA_WEIGHT] * 64
    return Matrices(intra=intra, non_intra=non_intra, chroma_intra=list(intra), chroma_non_intra=list(non_intra))


@dataclass
class EncodedFrame:
    data: bytes
    display_index: int
    keyframe: bool


def encode_vector(specification: VectorSpecification) -> list[EncodedFrame]:
    """Encodes a vector's frames in decode order, each a packet."""

    sequence = specification.sequence
    random = Random(specification.seed)
    sources = {frame.display_index: make_source_frame(sequence, frame.display_index) for frame in specification.frames}
    matrices = sequence_matrices(sequence)
    # The display indices of the anchors, as the decoder's last and next pictures
    last_anchor: int | None = None
    next_anchor: int | None = None
    encoded = []
    for frame in specification.frames:
        packet = bytearray()
        if frame.sequence_header:
            packet += sequence_header(sequence)
            matrices = sequence_matrices(sequence)
        if frame.group_of_pictures:
            packet += group_of_pictures(frame.closed_gop)
        first_type = frame.pictures[0].picture_type
        if first_type != PICTURE_TYPE_B:
            last_anchor, next_anchor = next_anchor, frame.display_index
        current = sources[frame.display_index]
        for index, picture in enumerate(frame.pictures):
            packet += picture_headers(picture)
            if picture.matrix_extension is not None:
                apply_matrix_extension(matrices, picture.matrix_extension)
            if picture.picture_type == PICTURE_TYPE_B:
                forward, backward = sources[last_anchor], sources[next_anchor]
            else:
                forward = sources[last_anchor] if last_anchor is not None else None
                backward = None
            if picture.picture_type == PICTURE_TYPE_P and first_type != PICTURE_TYPE_B and forward is None:
                raise VectorGenerationError(f"{specification.file_name}: P picture without a reference")
            encoder = PictureEncoder(sequence, picture, matrices, random, current, forward, backward,
                                     first_field=picture.structure != STRUCTURE_FRAME and index == 0)
            packet += encoder.encode()
        if frame.end_of_sequence:
            writer = BitWriter()
            writer.start_code(SEQUENCE_END_CODE)
            packet += writer.take()
        encoded.append(EncodedFrame(bytes(packet), frame.display_index, first_type == PICTURE_TYPE_I))
    return encoded


# Matroska: EBML element IDs and the fixed values of the vectors' files
EBML_HEADER_ID: Final = 0x1A45DFA3
EBML_VERSION_ID: Final = 0x4286
EBML_READ_VERSION_ID: Final = 0x42F7
EBML_MAXIMUM_ID_LENGTH_ID: Final = 0x42F2
EBML_MAXIMUM_SIZE_LENGTH_ID: Final = 0x42F3
DOC_TYPE_ID: Final = 0x4282
DOC_TYPE_VERSION_ID: Final = 0x4287
DOC_TYPE_READ_VERSION_ID: Final = 0x4285
SEGMENT_ID: Final = 0x18538067
INFO_ID: Final = 0x1549A966
TIMESTAMP_SCALE_ID: Final = 0x2AD7B1
MUXING_APP_ID: Final = 0x4D80
WRITING_APP_ID: Final = 0x5741
DURATION_ID: Final = 0x4489
TRACKS_ID: Final = 0x1654AE6B
TRACK_ENTRY_ID: Final = 0xAE
TRACK_NUMBER_ID: Final = 0xD7
TRACK_UID_ID: Final = 0x73C5
TRACK_TYPE_ID: Final = 0x83
FLAG_LACING_ID: Final = 0x9C
CODEC_ID_ID: Final = 0x86
CODEC_PRIVATE_ID: Final = 0x63A2
DEFAULT_DURATION_ID: Final = 0x23E383
VIDEO_ID: Final = 0xE0
PIXEL_WIDTH_ID: Final = 0xB0
PIXEL_HEIGHT_ID: Final = 0xBA
CLUSTER_ID: Final = 0x1F43B675
CLUSTER_TIMESTAMP_ID: Final = 0xE7
SIMPLE_BLOCK_ID: Final = 0xA3
MATROSKA_DOC_TYPE: Final = b"matroska"
MATROSKA_DOC_TYPE_VERSION: Final = 4
MATROSKA_DOC_TYPE_READ_VERSION: Final = 2
NANOSECONDS_PER_MILLISECOND: Final = 1_000_000
VIDEO_TRACK_TYPE: Final = 1
TRACK_NUMBER: Final = 1
MPEG2_CODEC_ID: Final = b"V_MPEG2"
WRITING_APPLICATION: Final = b"generate_mpeg2_decoder_vectors.py"
KEYFRAME_BLOCK_FLAG: Final = 0x80
DOUBLE_BYTES: Final = 8


def ebml_identifier(identifier: int) -> bytes:
    return identifier.to_bytes((identifier.bit_length() + 7) // 8, "big")


def ebml_size(size: int) -> bytes:
    """A size in the shortest EBML varint that holds it, never the all-ones unknown size."""

    for length in range(1, 9):
        if size < (1 << (7 * length)) - 1:
            return ((1 << (7 * length)) | size).to_bytes(length, "big")
    raise VectorGenerationError(f"EBML size {size} too large")


def ebml_element(identifier: int, payload: bytes) -> bytes:
    return ebml_identifier(identifier) + ebml_size(len(payload)) + payload


def ebml_unsigned(identifier: int, value: int) -> bytes:
    return ebml_element(identifier, value.to_bytes(max(1, (value.bit_length() + 7) // 8), "big"))


def ebml_float(identifier: int, value: float) -> bytes:
    return ebml_element(identifier, struct.pack(">d", value))


def matroska_file(sequence: SequenceParameters, frames: Sequence[EncodedFrame], codec_private: bytes) -> bytes:
    """One video track of V_MPEG2 in one cluster, blocks in decode order at their presentation timestamps."""

    header = ebml_element(EBML_HEADER_ID, b"".join((
        ebml_unsigned(EBML_VERSION_ID, 1),
        ebml_unsigned(EBML_READ_VERSION_ID, 1),
        ebml_unsigned(EBML_MAXIMUM_ID_LENGTH_ID, 4),
        ebml_unsigned(EBML_MAXIMUM_SIZE_LENGTH_ID, 8),
        ebml_element(DOC_TYPE_ID, MATROSKA_DOC_TYPE),
        ebml_unsigned(DOC_TYPE_VERSION_ID, MATROSKA_DOC_TYPE_VERSION),
        ebml_unsigned(DOC_TYPE_READ_VERSION_ID, MATROSKA_DOC_TYPE_READ_VERSION),
    )))
    duration = len(frames) * FRAME_DURATION_MILLISECONDS
    info = ebml_element(INFO_ID, b"".join((
        ebml_unsigned(TIMESTAMP_SCALE_ID, NANOSECONDS_PER_MILLISECOND),
        ebml_element(MUXING_APP_ID, WRITING_APPLICATION),
        ebml_element(WRITING_APP_ID, WRITING_APPLICATION),
        ebml_float(DURATION_ID, float(duration)),
    )))
    track = ebml_element(TRACK_ENTRY_ID, b"".join((
        ebml_unsigned(TRACK_NUMBER_ID, TRACK_NUMBER),
        ebml_unsigned(TRACK_UID_ID, TRACK_NUMBER),
        ebml_unsigned(TRACK_TYPE_ID, VIDEO_TRACK_TYPE),
        ebml_unsigned(FLAG_LACING_ID, 0),
        ebml_element(CODEC_ID_ID, MPEG2_CODEC_ID),
        ebml_element(CODEC_PRIVATE_ID, codec_private),
        ebml_unsigned(DEFAULT_DURATION_ID, FRAME_DURATION_NANOSECONDS),
        ebml_element(VIDEO_ID, ebml_unsigned(PIXEL_WIDTH_ID, sequence.width) + ebml_unsigned(PIXEL_HEIGHT_ID, sequence.height)),
    )))
    tracks = ebml_element(TRACKS_ID, track)
    blocks = [ebml_unsigned(CLUSTER_TIMESTAMP_ID, 0)]
    for frame in frames:
        timestamp = frame.display_index * FRAME_DURATION_MILLISECONDS
        flags = KEYFRAME_BLOCK_FLAG if frame.keyframe else 0
        payload = bytes((0x80 | TRACK_NUMBER,)) + timestamp.to_bytes(2, "big", signed=True) + bytes((flags,)) + frame.data
        blocks.append(ebml_element(SIMPLE_BLOCK_ID, payload))
    cluster = ebml_element(CLUSTER_ID, b"".join(blocks))
    return header + ebml_element(SEGMENT_ID, info + tracks + cluster)


def vector_file(specification: VectorSpecification) -> bytes:
    frames = encode_vector(specification)
    return matroska_file(specification.sequence, frames, sequence_header(specification.sequence))


# The vectors: one per output format, each a GOP of frame and field pictures in decode order
def interlaced_vector(file_name: str, sequence: SequenceParameters, seed: int, chroma_matrices: bool) -> VectorSpecification:
    """Two GOPs: I P B B P B B, then a new sequence header, an I and P field pair, and two B frames that predict across it."""

    def picture(picture_type: int, structure: int, reference: int, **options: object) -> PictureSpecification:
        return PictureSpecification(picture_type=picture_type, structure=structure, temporal_reference=reference, **options)  # type: ignore[arg-type]

    extension_intra = ramp_matrix(10, 2, 3, True)
    extension_non_intra = ramp_matrix(20, 1, 2, False)
    chroma_intra = ramp_matrix(12, 3, 2, True) if chroma_matrices else None
    chroma_non_intra = ramp_matrix(18, 2, 1, False) if chroma_matrices else None
    frames = [
        # I frame picture: field and frame DCT, B.15, alternate scan, non-linear quantizer, 10-bit DC, concealment vectors
        FrameSpecification(0, [picture(PICTURE_TYPE_I, STRUCTURE_FRAME, 0, intra_dc_precision=2, q_scale_type=1, intra_vlc_format=1,
                                       alternate_scan=1, concealment_motion_vectors=1, forward_f_code=(4, 3))],
                           sequence_header=True, group_of_pictures=True, closed_gop=1),
        # P field pair: field motion, 16x8, dual prime, zero motion, skips; the second field predicts from the first
        FrameSpecification(3, [
            picture(PICTURE_TYPE_P, STRUCTURE_TOP_FIELD, 3, intra_dc_precision=1, q_scale_type=0, intra_vlc_format=0, alternate_scan=0,
                    top_field_first=0, forward_f_code=(3, 2)),
            picture(PICTURE_TYPE_P, STRUCTURE_BOTTOM_FIELD, 3, intra_dc_precision=1, q_scale_type=1, intra_vlc_format=1, alternate_scan=1,
                    top_field_first=0, forward_f_code=(2, 3), concealment_motion_vectors=1),
        ]),
        # B frame picture: frame and field motion in both directions, field DCT
        FrameSpecification(1, [picture(PICTURE_TYPE_B, STRUCTURE_FRAME, 1, intra_dc_precision=0, q_scale_type=1, intra_vlc_format=0,
                                       alternate_scan=1, forward_f_code=(3, 3), backward_f_code=(4, 2))]),
        # B field pair, bottom field first: 16x8 and field motion in both directions
        FrameSpecification(2, [
            picture(PICTURE_TYPE_B, STRUCTURE_BOTTOM_FIELD, 2, intra_dc_precision=3, q_scale_type=0, intra_vlc_format=1, alternate_scan=0,
                    top_field_first=0, forward_f_code=(3, 2), backward_f_code=(2, 2)),
            picture(PICTURE_TYPE_B, STRUCTURE_TOP_FIELD, 2, intra_dc_precision=3, q_scale_type=1, intra_vlc_format=0, alternate_scan=1,
                    top_field_first=0, forward_f_code=(3, 3), backward_f_code=(3, 2)),
        ]),
        # P frame picture, bottom field first: dual prime, a quant matrix extension, 11-bit DC
        FrameSpecification(6, [picture(PICTURE_TYPE_P, STRUCTURE_FRAME, 6, intra_dc_precision=3, q_scale_type=0, intra_vlc_format=1,
                                       alternate_scan=0, top_field_first=0, forward_f_code=(5, 4),
                                       matrix_extension=(extension_intra, extension_non_intra, chroma_intra, chroma_non_intra))]),
        # B frame picture: frame prediction only, a progressive frame repeating its first field
        FrameSpecification(4, [picture(PICTURE_TYPE_B, STRUCTURE_FRAME, 4, intra_dc_precision=1, q_scale_type=0, intra_vlc_format=1,
                                       alternate_scan=0, frame_pred_frame_dct=1, progressive_frame=1, repeat_first_field=1,
                                       forward_f_code=(3, 3), backward_f_code=(3, 3))]),
        # B frame picture with concealment vectors in its intra macroblocks
        FrameSpecification(5, [picture(PICTURE_TYPE_B, STRUCTURE_FRAME, 5, intra_dc_precision=2, q_scale_type=1, intra_vlc_format=0,
                                       alternate_scan=1, concealment_motion_vectors=1, intra_percent=20, forward_f_code=(4, 4),
                                       backward_f_code=(3, 3))]),
        # A repeated sequence header, whose matrices replace the quant matrix extension's, an open GOP, and an I and P field pair
        FrameSpecification(9, [
            picture(PICTURE_TYPE_I, STRUCTURE_TOP_FIELD, 2, intra_dc_precision=0, q_scale_type=0, intra_vlc_format=0, alternate_scan=0,
                    top_field_first=0),
            picture(PICTURE_TYPE_P, STRUCTURE_BOTTOM_FIELD, 2, intra_dc_precision=2, q_scale_type=1, intra_vlc_format=1, alternate_scan=0,
                    top_field_first=0, forward_f_code=(3, 3)),
        ], sequence_header=True, group_of_pictures=True, closed_gop=0),
        # B pictures across the GOP boundary: a frame picture, then a field pair
        FrameSpecification(7, [picture(PICTURE_TYPE_B, STRUCTURE_FRAME, 0, intra_dc_precision=0, q_scale_type=0, intra_vlc_format=0,
                                       alternate_scan=0, top_field_first=1, forward_f_code=(3, 3), backward_f_code=(3, 3))]),
        FrameSpecification(8, [
            picture(PICTURE_TYPE_B, STRUCTURE_TOP_FIELD, 1, intra_dc_precision=1, q_scale_type=1, intra_vlc_format=1, alternate_scan=1,
                    top_field_first=0, forward_f_code=(2, 2), backward_f_code=(3, 3)),
            picture(PICTURE_TYPE_B, STRUCTURE_BOTTOM_FIELD, 1, intra_dc_precision=1, q_scale_type=0, intra_vlc_format=0, alternate_scan=0,
                    top_field_first=0, forward_f_code=(3, 3), backward_f_code=(2, 3)),
        ], end_of_sequence=True),
    ]
    return VectorSpecification(file_name=file_name, sequence=sequence, frames=frames, seed=seed)


# profile_and_level_indication: Main profile at Main level, the 4:2:2 profile at Main level, and High profile at Main level
MAIN_PROFILE_MAIN_LEVEL: Final = 0x48
PROFILE_422_MAIN_LEVEL: Final = 0x85
HIGH_PROFILE_MAIN_LEVEL: Final = 0x18

VECTORS: Final = (
    interlaced_vector(
        "mpeg2-tools-420-200x118.mkv",
        SequenceParameters(width=200, height=118, chroma_format=CHROMA_420, profile_and_level=MAIN_PROFILE_MAIN_LEVEL,
                  intra_matrix=ramp_matrix(8, 2, 2, True), non_intra_matrix=ramp_matrix(16, 1, 1, False)),
        seed=0x4D504732,
        chroma_matrices=False,
    ),
    interlaced_vector(
        "mpeg2-tools-422-152x104.mkv",
        SequenceParameters(width=152, height=104, chroma_format=CHROMA_422, profile_and_level=PROFILE_422_MAIN_LEVEL,
                  intra_matrix=ramp_matrix(8, 1, 3, True), non_intra_matrix=ramp_matrix(14, 2, 1, False)),
        seed=0x34323220,
        chroma_matrices=True,
    ),
    interlaced_vector(
        "mpeg2-tools-444-136x72.mkv",
        SequenceParameters(width=136, height=72, chroma_format=CHROMA_444, profile_and_level=HIGH_PROFILE_MAIN_LEVEL,
                  intra_matrix=ramp_matrix(9, 2, 1, True), non_intra_matrix=ramp_matrix(15, 1, 2, False)),
        seed=0x34343420,
        chroma_matrices=True,
    ),
)

# What FFmpeg logs when a stream is not as valid as the vectors must be: damaged data, concealment, or skipped prediction
FFMPEG_PROBLEM_MARKERS: Final = (
    "damaged", "concealing", "out of boundary", "Invalid", "invalid", "mismatch", "overread", "Missing", "missing", "ignoring", "skipped MB",
)


def run_ffmpeg(arguments: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(["ffmpeg", "-hide_banner", *arguments], capture_output=True, check=False, stdin=subprocess.DEVNULL)
    except OSError as error:
        raise VectorGenerationError(f"ffmpeg failed: {error}") from error


def validate_with_ffmpeg(path: Path) -> None:
    """Decodes a vector with FFmpeg at debug level and fails on any message of a stream problem, then requires FFmpeg's simple IDCT
    to decode it the same with and without its SIMD versions, so the vector's hash is the same on every machine."""

    result = run_ffmpeg(["-loglevel", "debug", "-idct", "simple", "-i", str(path), "-f", "null", "-"])
    log = result.stderr.decode("utf-8", errors="replace")
    problems = [line for line in log.splitlines() if "mpeg2video" in line and any(marker in line for marker in FFMPEG_PROBLEM_MARKERS)]
    if result.returncode != 0 or problems:
        raise VectorGenerationError(f"FFmpeg does not decode {path.name} cleanly: " + "; ".join(problems[:20]))
    digests = []
    for cpu_options in ((), ("-cpuflags", "0")):
        decode = run_ffmpeg(["-loglevel", "error", *cpu_options, "-idct", "simple", "-i", str(path), "-f", "md5", "-"])
        if decode.returncode != 0:
            raise VectorGenerationError(f"FFmpeg failed on {path.name}: {decode.stderr.decode('utf-8', errors='replace')}")
        digests.append(decode.stdout.strip())
    if digests[0] != digests[1]:
        raise VectorGenerationError(f"FFmpeg's SIMD and C simple IDCTs decode {path.name} differently")


def generate_vectors(*, check: bool, validate: bool) -> int:
    for specification in VECTORS:
        path = VECTOR_DIRECTORY / specification.file_name
        write_or_check_output(path, vector_file(specification), check=check)
        if validate:
            validate_with_ffmpeg(path)
    return len(VECTORS)


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail unless every committed vector matches its regeneration; nothing is written")
    parser.add_argument("--no-validate", action="store_true", help="Skip decoding each vector with FFmpeg to confirm it is clean")
    return parser.parse_args(command_arguments)


def main(command_arguments: Sequence[str] | None = None) -> int:
    arguments = parse_arguments(command_arguments)
    try:
        count = generate_vectors(check=arguments.check, validate=not arguments.no_validate)
    except (VectorGenerationError, GeneratedOutputError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    action = "Verified" if arguments.check else "Generated"
    print(f"{action} {count} MPEG-2 decoder vectors in {VECTOR_DIRECTORY}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
