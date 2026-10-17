"""Writes a pass file's texture block, which the tools that generate pass files share.

A texture block is a header of `//! texture`, `size`, `format`, `filter`, and `edge` lines, then the texels in base64, as docs/src/new-pass.md describes it.
"""

from __future__ import annotations

import base64
from typing import Final

# The block's base64 lines, broken for readability; the engine joins them
BASE64_LINE_LENGTH: Final = 120


def format_texture_block(name: str, size: tuple[int, ...], texture_format: str, texture_filter: str, edge: str, data: bytes) -> str:
    """Returns a texture block: its header, a blank line, and its data, which packs the texels little-endian, x fastest, then y, then z."""
    encoded = base64.b64encode(data).decode('ascii')
    lines = [
        f'//! texture: {name}',
        f'//! size: {", ".join(str(extent) for extent in size)}',
        f'//! format: {texture_format}',
        f'//! filter: {texture_filter}',
        f'//! edge: {edge}',
        ''
    ]
    lines.extend(encoded[offset:offset + BASE64_LINE_LENGTH] for offset in range(0, len(encoded), BASE64_LINE_LENGTH))
    return '\n'.join(lines) + '\n'
