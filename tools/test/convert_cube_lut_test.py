"""Tests the .cube LUT tool: its parse of the format, and the pass file it writes."""

from __future__ import annotations

import base64
import struct
import sys
import unittest
from pathlib import Path


TOOLS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS_DIRECTORY))

import convert_cube_lut as tool  # noqa: E402

SOURCE_NAME = 'grade.cube'
PASS_NAME = 'Warm grade'
LUT_SIZE = 2
# A 2^3 identity LUT, red fastest, after a title, a comment, a keyword the tool skips, and a domain
IDENTITY_CUBE = '''# exported by a grading tool
TITLE "Identity"
LUT_3D_SIZE 2
LUT_3D_INPUT_RANGE 0.0 1.0
DOMAIN_MIN 0.0 0.0 0.0
DOMAIN_MAX 1.0 1.0 1.0
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
'''
IDENTITY_ROWS = [(float(red), float(green), float(blue)) for blue in (0, 1) for green in (0, 1) for red in (0, 1)]
ONE_DIMENSIONAL_CUBE = 'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n'
SHORT_CUBE = 'LUT_3D_SIZE 2\n0 0 0\n'
INVERTED_DOMAIN_CUBE = IDENTITY_CUBE.replace('DOMAIN_MAX 1.0 1.0 1.0', 'DOMAIN_MAX 0.0 1.0 1.0')
PASS_LINES = ['//! name: Warm grade', '//! shape: color', '//! hook: OUTPUT', '//! domain: sdr', '//! bind: LUT', '//! texture: LUT',
              '//! size: 2, 2, 2', '//! format: rgba16float', '//! filter: linear', '//! edge: clamp']
HALF_TEXEL_FORMAT = '<4e'
OPAQUE_ALPHA = 1.0


class CubeParsingTest(unittest.TestCase):
    def test_reads_a_3D_LUT_with_its_title_and_domain(self) -> None:
        lut = tool.parse_cube(IDENTITY_CUBE)

        self.assertEqual((lut.title, lut.size), ('Identity', LUT_SIZE))
        self.assertEqual((lut.domain_minimum, lut.domain_maximum), ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)))
        self.assertEqual(lut.rows, IDENTITY_ROWS)

    def test_rejects_what_does_not_convert(self) -> None:
        cases = ((ONE_DIMENSIONAL_CUBE, tool.CODE_ONE_DIMENSIONAL), (SHORT_CUBE, tool.CODE_ROW_COUNT), (INVERTED_DOMAIN_CUBE, tool.CODE_DOMAIN_INVALID),
                 ('0 0 0\n', tool.CODE_SIZE_MISSING))
        for text, code in cases:
            with self.subTest(code=code), self.assertRaises(tool.CubeError) as raised:
                tool.parse_cube(text)
            self.assertEqual(raised.exception.code, code)


class PassFileTest(unittest.TestCase):
    def test_writes_a_color_pass_that_binds_the_LUT_as_a_3D_texture_block(self) -> None:
        pass_file = tool.create_pass_file(tool.parse_cube(IDENTITY_CUBE), PASS_NAME, 'OUTPUT', 'sdr', SOURCE_NAME)

        for line in PASS_LINES:
            self.assertIn(line, pass_file.split('\n'))
        self.assertLess(pass_file.index('//! bind: LUT'), pass_file.index('//! texture: LUT'))
        self.assertIn('LUT_tex(normalized * (size - vec3f(1.0)) / size + vec3f(0.5) / size)', pass_file)

    def test_holds_the_rows_as_opaque_half_texels_red_fastest(self) -> None:
        pass_file = tool.create_pass_file(tool.parse_cube(IDENTITY_CUBE), PASS_NAME, 'RGB', 'source', SOURCE_NAME)
        encoded = ''.join(pass_file[pass_file.index('//! edge: clamp'):].split('\n')[2:])
        expected = b''.join(struct.pack(HALF_TEXEL_FORMAT, *row, OPAQUE_ALPHA) for row in IDENTITY_ROWS)

        self.assertEqual(base64.b64decode(encoded), expected)


if __name__ == '__main__':
    unittest.main()
