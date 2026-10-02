"""Regenerate the deterministic JPEG 2000 software-decoder probe picture."""

from __future__ import annotations

import argparse
import pathlib
import subprocess
import tempfile

from generated_output import write_or_check_output


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = (
    REPOSITORY_ROOT
    / "fixtures"
    / "capability"
    / "jpeg2000"
    / "srgb-960x540.jp2"
)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", default="ffmpeg", help="FFmpeg executable")
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if the committed fixture differs from the regenerated picture",
    )
    return parser.parse_args()


def encode_fixture(ffmpeg: str, output_path: pathlib.Path) -> None:
    """Encodes one testsrc2 frame with the reversible JPEG 2000 encoder."""

    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=960x540:rate=24",
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuv444p",
        "-c:v",
        "jpeg2000",
        "-pred",
        "1",
        "-format",
        "jp2",
        "-y",
        str(output_path),
    ]
    subprocess.run(command, check=True)


def main() -> int:
    arguments = parse_arguments()
    output_path = arguments.output.resolve()
    with tempfile.TemporaryDirectory(
        prefix="webgpu-jpeg2000-fixture-"
    ) as temporary_directory:
        # A failed encode never touches the committed fixture
        generated_path = pathlib.Path(temporary_directory) / output_path.name
        encode_fixture(arguments.ffmpeg, generated_path)
        write_or_check_output(
            output_path,
            generated_path.read_bytes(),
            check=arguments.check,
        )
    action = "Verified" if arguments.check else "Generated"
    print(f"{action} {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
