#!/usr/bin/env python3
"""Generate all checked validation fixture-registry fragments without transcoding."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Callable

from generate_dts_capability_fixtures import (
    create_registry_fragment as create_dts_fragment,
)
from generate_jpeg2000_capability_fixture import (
    DEFAULT_OUTPUT as JPEG2000_OUTPUT,
    create_registry_fragment as create_jpeg2000_fragment,
)
from generate_legacy_video_capability_fixture import (
    create_registry_fragment as create_legacy_video_fragment,
)
from generate_truehd_capability_fixtures import (
    create_registry_fragment as create_truehd_fragment,
)
from validation_fixture_registry import (
    DEFAULT_FRAGMENT_DIRECTORY,
    REPOSITORY_ROOT,
    write_or_check_fragment,
)


FragmentFactory = Callable[[], dict[str, object]]


def parse_arguments() -> argparse.Namespace:
    """Parses the registry-only generation mode."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if any checked-in registry fragment is stale",
    )
    return parser.parse_args()


def fragment_factories() -> tuple[tuple[str, FragmentFactory], ...]:
    """Returns every canonical registry fragment in stable load order."""

    dts_fixture_directory = REPOSITORY_ROOT / "scripts" / "webgpu" / "fixtures" / "dts"
    factories: list[tuple[str, FragmentFactory]] = []
    factories.append(
        ("jpeg2000.json", lambda: create_jpeg2000_fragment(JPEG2000_OUTPUT))
    )
    factories.append(("legacy-video.json", create_legacy_video_fragment))
    factories.append(("dts.json", lambda: create_dts_fragment(dts_fixture_directory)))
    factories.append(("truehd.json", lambda: create_truehd_fragment(REPOSITORY_ROOT)))
    return tuple(factories)


def main() -> int:
    """Writes or checks all registry fragments without invoking a codec tool."""

    arguments = parse_arguments()
    for file_name, factory in fragment_factories():
        output_path: Path = DEFAULT_FRAGMENT_DIRECTORY / file_name
        write_or_check_fragment(
            output_path,
            factory(),
            check=arguments.check,
        )
        action = "Verified" if arguments.check else "Generated"
        print(f"{action} {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
