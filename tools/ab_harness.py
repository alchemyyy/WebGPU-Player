"""Shared helpers for the WebGPU fixture generators."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


class HarnessError(RuntimeError):
    """Reports one actionable tool failure without a shell traceback."""


def write_json(path: Path, value: object) -> None:
    """Writes deterministic UTF-8 JSON after creating its parent directory."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f"{path.name}.tmp")
    temporary_path.write_text(
        f"{json.dumps(value, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )
    temporary_path.replace(path)


def calculate_sha256(path: Path) -> str:
    """Calculates a file digest without loading large artifacts into memory."""

    digest = hashlib.sha256()
    try:
        with path.open("rb") as source_file:
            while True:
                block = source_file.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
    except OSError as error:
        raise HarnessError(f"Unable to hash {path}: {error}") from error
    return digest.hexdigest()
