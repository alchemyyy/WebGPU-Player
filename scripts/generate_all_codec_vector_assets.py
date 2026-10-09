#!/usr/bin/env python3
"""Generate every committed codec vector asset into bin/codec_vector_assets/, or verify them all with --check."""

from __future__ import annotations

import argparse
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Sequence

# tools/constants.py names the engine's folders, as tools/constants.mjs does for the Node build scripts
sys.path.append(str(Path(__file__).resolve().parents[1] / "tools"))

from constants import CODEC_VECTOR_ASSETS_DIRECTORY, CODEC_VECTOR_SCRIPTS_DIRECTORY, ENGINE_ROOT  # noqa: E402


@dataclass(frozen=True)
class GeneratorStep:
    """One generator script and the arguments it always receives."""

    script_name: str
    arguments: tuple[str, ...] = ()


# Every generator whose output is committed.
# The local playback media generators are run by hand
GENERATOR_STEPS: Final = (
    GeneratorStep("generate_dts_capability_vectors.py"),
    # Re-encodes the source streams and compares them with the committed ones before building the module from them
    GeneratorStep("generate_truehd_capability_vectors.py", ("--regenerate-sources",)),
    GeneratorStep("generate_seven_point_one_downmix_reference.py"),
    GeneratorStep("generate_jpeg2000_capability_vector.py"),
    GeneratorStep("generate_mpeg2_capability_vector.py"),
    GeneratorStep("generate_HEVC_range_extension_vectors.py"),
    GeneratorStep("generate_dolby_vision_AV1_vectors.py"),
)


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail unless every committed asset matches a fresh run of its generator; nothing is written",
    )
    return parser.parse_args(command_arguments)


def run_generator(step: GeneratorStep, *, check: bool) -> bool:
    """Runs one generator from the engine root and returns whether it succeeded."""

    command = [sys.executable, str(CODEC_VECTOR_SCRIPTS_DIRECTORY / step.script_name), *step.arguments]
    if check:
        command.append("--check")
    print(f"==> {step.script_name}", flush=True)
    return subprocess.run(command, cwd=ENGINE_ROOT).returncode == 0


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs every generator, continuing past failures, and returns 1 if any failed."""

    arguments = parse_arguments(command_arguments)
    failed_script_names: list[str] = []
    for step in GENERATOR_STEPS:
        if not run_generator(step, check=arguments.check):
            failed_script_names.append(step.script_name)
    if failed_script_names:
        print(
            f"{len(failed_script_names)} of {len(GENERATOR_STEPS)} generators failed: "
            + ", ".join(failed_script_names),
            file=sys.stderr,
        )
        return 1
    action = "Verified" if arguments.check else "Generated"
    print(f"{action} every codec vector asset in {CODEC_VECTOR_ASSETS_DIRECTORY}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
