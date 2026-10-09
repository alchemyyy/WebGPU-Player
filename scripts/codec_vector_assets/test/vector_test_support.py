"""Helpers shared by the codec vector script tests: running a script's main() with its output captured, and building ISO base media boxes."""

from __future__ import annotations

import io
from contextlib import redirect_stderr, redirect_stdout
from typing import Callable, Sequence


def run_main(main: Callable[[Sequence[str]], int], command_arguments: Sequence[str]) -> tuple[int, str, str]:
    """Runs a script's main() and returns its exit status, standard output, and standard error."""

    standard_output = io.StringIO()
    standard_error = io.StringIO()
    with redirect_stdout(standard_output), redirect_stderr(standard_error):
        status = main(command_arguments)
    return status, standard_output.getvalue(), standard_error.getvalue()


def box(box_type: str, payload: bytes = b"") -> bytes:
    """Creates one compact box around a payload."""

    return (len(payload) + 8).to_bytes(4, "big") + box_type.encode("ascii") + payload
