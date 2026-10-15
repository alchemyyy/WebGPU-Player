#!/usr/bin/env python3
"""Generate the AV1 decoder project's self-test media: one small Matroska stream per output format.

FFmpeg's libaom-av1 encoder, in one thread, encodes a synthetic lavfi canvas that rotates, zooms, and pans as a whole, for global and
local warped motion: two-colour cell patterns for palette, one of them repeated where IntraBC may copy it, testsrc2's moving pictures
for OBMC and compound prediction, and a drifting gradient for 64-point transforms. The encoder settings add screen content tools,
segmentation, delta quantizer and loop filter levels, quantization matrices, non-uniform tiles or 128x128 superblocks, and film grain,
from libaom's test tables or from a table of phases this script writes. Thirteen frames behind a 19-frame lookahead give hidden
alternate references that show_existing_frame shows, and a second key frame. Odd frame sizes leave partial blocks at the edges.
Another FFmpeg or libaom build encodes different bytes, so regenerated media never replaces a committed file; --check fails unless
they are identical.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Sequence

from engine_layout import DECODERS_DIRECTORY
from generated_output import GeneratedOutputError, install_or_check_output


PROJECT_NAME: Final = "av1"
VECTOR_DIRECTORY: Final = DECODERS_DIRECTORY / PROJECT_NAME / "vectors"
FRAME_COUNT: Final = 13
KEYFRAME_INTERVAL: Final = 12
LOOKAHEAD_FRAMES: Final = 19
FRAME_RATE: Final = 24
CONSTANT_RATE_FACTOR: Final = 50
ENCODER_SPEED: Final = 0
CONTAINER: Final = "matroska"
REFERENCE_DECODER_OPTIONS: Final = ("-c:v", "libdav1d")
# libaom's internal timestamps, which its film grain table entries use
TICKS_PER_SECOND: Final = 10_000_000
GRAIN_TABLE_FILE_NAME: Final = "grain.tbl"
GRAIN_TABLE_MAGIC: Final = "filmgrn1"

# The canvas, its margin for the motion, and the motion per frame, which is the identity at the first frame
CANVAS_WIDTH: Final = 256
CANVAS_HEIGHT: Final = 192
CANVAS_MARGIN: Final = 32
ROTATION_PER_FRAME: Final = 0.006
ZOOM_PER_FRAME: Final = 0.003
PAN_PER_FRAME: Final = 0.4
# The canvas is drawn in 4:4:4, which each vector's pixel format then subsamples
CANVAS_PIXEL_FORMAT: Final = "yuv444p"
OVERLAY_FORMAT: Final = "yuv444"
# A 64x64 pattern of 4x4 cells: one is placed where an IntraBC block may copy it from the top-left superblock, which libaom allows
# for a 64x64-superblock block more than four superblocks behind in its tile and for a 128x128-superblock block one row down
PATTERN_SIZE: Final = 64
PATTERN_CELLS: Final = 16
PATTERN_LIVE_RATIO: Final = 0.35
REPEATED_PATTERN_POSITIONS: Final = ((0, 0), (128, 64), (128, 128))
SECOND_PATTERN_POSITION: Final = (64, 0)
NATURAL_PICTURES: Final = (((0, 64), (128, 128)), ((128, 0), (128, 64)))
GRADIENT_POSITION: Final = (192, 64)
GRADIENT_SIZE: Final = (64, 128)
# Smooth planes that drift with the frame number N; lavfi's gradients source draws random points whatever its seed
GRADIENT_EXPRESSIONS: Final = (
    ("lum", "128+70*sin((X+2*Y+3*N)/90)"),
    ("cb", "128+50*cos((2*X-Y)/110+N/25)"),
    ("cr", "128+50*sin((X+Y)/130-N/30)"),
)
BACKGROUND_COLOUR: Final = "gray"

# Superblock and tile layouts of the canvas's 4x3 superblocks of 64: non-uniform 3+1 columns and 2+1 rows, or one tile of 128x128
SUPERBLOCK_64_TILES: Final = "sb-size=64:tile-width=3,1:tile-height=2,1"
SUPERBLOCK_128_ONE_TILE: Final = "sb-size=128"
# libaom's adaptive quantization by variance, which codes a segmentation map with a quantizer per segment
VARIANCE_SEGMENTATION: Final = "1"
ENCODER_TOOL_PARAMETERS: Final = (
    "enable-qm=1",
    "deltaq-mode=1",
    "delta-lf-mode=1",
    "tune-content=screen",
    # Key-frame temporal filtering would blur the repeated pattern IntraBC copies
    "enable-keyframe-filtering=0",
)


class VectorGenerationError(RuntimeError):
    """Reports a medium the script cannot encode."""


@dataclass(frozen=True)
class CellPattern:
    """A two-colour Game of Life pattern: its seed and colours."""

    dead_colour: str
    live_colour: str
    seed: int


REPEATED_PATTERN: Final = CellPattern(dead_colour="#203080", live_colour="#F0E020", seed=7)
SECOND_PATTERN: Final = CellPattern(dead_colour="#102010", live_colour="#E04020", seed=11)


@dataclass(frozen=True)
class GrainParameters:
    """One set of film grain parameters, as libaom's film grain table states them."""

    ar_coefficient_lag: int
    ar_coefficient_shift: int
    grain_scale_shift: int
    scaling_shift: int
    chroma_scaling_from_luma: bool
    overlap: bool
    cb_multiplier: int
    cb_luma_multiplier: int
    cb_offset: int
    cr_multiplier: int
    cr_luma_multiplier: int
    cr_offset: int
    luma_points: tuple[tuple[int, int], ...]
    cb_points: tuple[tuple[int, int], ...]
    cr_points: tuple[tuple[int, int], ...]
    luma_coefficients: tuple[int, ...]
    cb_coefficients: tuple[int, ...]
    cr_coefficients: tuple[int, ...]


@dataclass(frozen=True)
class GrainPhase:
    """Film grain for a range of frames, or none when the parameters are absent."""

    first_frame: int
    last_frame: int
    parameters: GrainParameters | None
    random_seed: int = 0


LAG_0_FROM_LUMA: Final = GrainParameters(
    ar_coefficient_lag=0, ar_coefficient_shift=7, grain_scale_shift=0, scaling_shift=10, chroma_scaling_from_luma=True, overlap=True,
    cb_multiplier=128, cb_luma_multiplier=192, cb_offset=256, cr_multiplier=128, cr_luma_multiplier=192, cr_offset=256,
    luma_points=((0, 40), (128, 60), (255, 30)), cb_points=(), cr_points=(),
    luma_coefficients=(), cb_coefficients=(12,), cr_coefficients=(-9,),
)
LAG_1_CHROMA_WITHOUT_OVERLAP: Final = GrainParameters(
    ar_coefficient_lag=1, ar_coefficient_shift=8, grain_scale_shift=1, scaling_shift=11, chroma_scaling_from_luma=False, overlap=False,
    cb_multiplier=160, cb_luma_multiplier=100, cb_offset=300, cr_multiplier=96, cr_luma_multiplier=140, cr_offset=220,
    luma_points=((32, 50), (224, 50)), cb_points=((0, 30), (255, 40)), cr_points=((0, 20), (128, 50), (255, 20)),
    luma_coefficients=(10, -5, 20, 3), cb_coefficients=(-3, 7, 2, -8, 30), cr_coefficients=(4, -6, 9, 1, -20),
)
LAG_2_FROM_LUMA_WITHOUT_OVERLAP: Final = GrainParameters(
    ar_coefficient_lag=2, ar_coefficient_shift=6, grain_scale_shift=2, scaling_shift=8, chroma_scaling_from_luma=True, overlap=False,
    cb_multiplier=128, cb_luma_multiplier=192, cb_offset=256, cr_multiplier=128, cr_luma_multiplier=192, cr_offset=256,
    luma_points=((16, 70), (96, 110), (200, 60), (240, 20)), cb_points=(), cr_points=(),
    luma_coefficients=(3, -2, 5, 1, -4, 6, -1, 8, 2, -3, 9, 18),
    cb_coefficients=(1, 0, 2, -1, 3, -2, 1, 4, 0, 2, 5, 10, 24), cr_coefficients=(-1, 2, 0, 1, -3, 2, -1, -4, 1, -2, -5, -10, -24),
)
LAG_3_CHROMA_OVERLAP: Final = GrainParameters(
    ar_coefficient_lag=3, ar_coefficient_shift=9, grain_scale_shift=0, scaling_shift=9, chroma_scaling_from_luma=False, overlap=True,
    cb_multiplier=200, cb_luma_multiplier=64, cb_offset=280, cr_multiplier=180, cr_luma_multiplier=80, cr_offset=240,
    luma_points=((0, 20), (64, 90), (160, 70), (255, 40)), cb_points=((0, 60), (255, 60)), cr_points=((16, 40), (235, 70)),
    luma_coefficients=(4, -3, 6, -2, 8, 1, -4, 5, 12, -6, 3, 2, 7, -1, 9, 14, -5, 6, 11, 20, -7, 3, 25, 40),
    cb_coefficients=(2, -1, 3, 0, 4, 1, -2, 2, 5, -3, 1, 1, 3, 0, 4, 6, -2, 3, 5, 9, -3, 1, 11, 18, 22),
    cr_coefficients=(-2, 1, -3, 0, -4, 2, 2, -2, -5, 3, -1, 1, -3, 1, -4, -6, 2, -3, -5, -9, 3, -1, -11, -18, 15),
)
# Two schedules over the 13 frames, in which the grain changes twice and pauses once
GRAIN_PHASES_A: Final = (
    GrainPhase(0, 3, LAG_0_FROM_LUMA, random_seed=1234),
    GrainPhase(4, 5, None),
    GrainPhase(6, 8, LAG_1_CHROMA_WITHOUT_OVERLAP, random_seed=4321),
    GrainPhase(9, 12, LAG_3_CHROMA_OVERLAP, random_seed=777),
)
GRAIN_PHASES_B: Final = (
    GrainPhase(0, 3, LAG_2_FROM_LUMA_WITHOUT_OVERLAP, random_seed=2024),
    GrainPhase(4, 7, LAG_3_CHROMA_OVERLAP, random_seed=99),
    GrainPhase(8, 9, None),
    GrainPhase(10, 12, LAG_1_CHROMA_WITHOUT_OVERLAP, random_seed=31337),
)


@dataclass(frozen=True)
class DecoderVector:
    """One medium: its file, output format, picture size and pixel format, superblock and tile layout, and film grain.

    Film grain comes from libaom's test table grain_test_table, which also clips to the restricted range, or from grain_phases.
    """

    file_name: str
    grain_phases: tuple[GrainPhase, ...]
    grain_test_table: int
    height: int
    layout_parameters: str
    output_format: str
    pixel_format: str
    width: int


VECTORS: Final = (
    DecoderVector(file_name="av1-420-250x186.mkv", grain_phases=GRAIN_PHASES_A, grain_test_table=0, height=186,
                  layout_parameters=SUPERBLOCK_64_TILES, output_format="I420", pixel_format="yuv420p", width=250),
    DecoderVector(file_name="av1-420p10-253x187.mkv", grain_phases=(), grain_test_table=3, height=187,
                  layout_parameters=SUPERBLOCK_64_TILES, output_format="I420P10", pixel_format="yuv420p10le", width=253),
    DecoderVector(file_name="av1-420p12-256x192-sb128.mkv", grain_phases=GRAIN_PHASES_B, grain_test_table=0, height=192,
                  layout_parameters=SUPERBLOCK_128_ONE_TILE, output_format="I420P12", pixel_format="yuv420p12le", width=256),
    DecoderVector(file_name="av1-422-254x190.mkv", grain_phases=(), grain_test_table=1, height=190,
                  layout_parameters=SUPERBLOCK_64_TILES, output_format="I422", pixel_format="yuv422p", width=254),
    DecoderVector(file_name="av1-422p10-249x183-sb128.mkv", grain_phases=GRAIN_PHASES_A, grain_test_table=0, height=183,
                  layout_parameters=SUPERBLOCK_128_ONE_TILE, output_format="I422P10", pixel_format="yuv422p10le", width=249),
    DecoderVector(file_name="av1-422p12-256x192.mkv", grain_phases=(), grain_test_table=6, height=192,
                  layout_parameters=SUPERBLOCK_64_TILES, output_format="I422P12", pixel_format="yuv422p12le", width=256),
    DecoderVector(file_name="av1-444-251x189-sb128.mkv", grain_phases=GRAIN_PHASES_B, grain_test_table=0, height=189,
                  layout_parameters=SUPERBLOCK_128_ONE_TILE, output_format="I444", pixel_format="yuv444p", width=251),
    DecoderVector(file_name="av1-444p10-256x188.mkv", grain_phases=(), grain_test_table=14, height=188,
                  layout_parameters=SUPERBLOCK_64_TILES, output_format="I444P10", pixel_format="yuv444p10le", width=256),
    DecoderVector(file_name="av1-444p12-247x191.mkv", grain_phases=GRAIN_PHASES_A, grain_test_table=0, height=191,
                  layout_parameters=SUPERBLOCK_64_TILES, output_format="I444P12", pixel_format="yuv444p12le", width=247),
)


def resolve_tool_path(tool_name: str, explicit_path: Path | None) -> Path:
    """Resolves a tool from its explicit flag, otherwise from PATH."""

    if explicit_path is not None:
        resolved_path = explicit_path.expanduser().resolve()
        if not resolved_path.is_file():
            raise FileNotFoundError(f"{tool_name} was not found: {resolved_path}")
        return resolved_path
    path_resolution = shutil.which(tool_name)
    if path_resolution is None:
        raise FileNotFoundError(f"{tool_name} was not found on PATH; pass --{tool_name}")
    return Path(path_resolution).resolve()


def get_half_frame_ticks(half_frames: int) -> int:
    """libaom's timestamp, in ticks, of a time counted in half frames, so a phase can end between two frames."""

    return max(0, half_frames * TICKS_PER_SECOND // (2 * FRAME_RATE))


def format_points(points: Sequence[tuple[int, int]]) -> str:
    return f"{len(points)}" + "".join(f" {position} {value}" for position, value in points)


def format_coefficients(header: str, coefficients: Sequence[int]) -> str:
    return f"\t{header}" + "".join(f" {coefficient}" for coefficient in coefficients)


def build_grain_table(phases: Sequence[GrainPhase]) -> str:
    """libaom's film grain table for a vector's phases: one entry per phase over its frames' timestamps, half a frame either side."""

    lines = [GRAIN_TABLE_MAGIC]
    for phase in phases:
        start_ticks = get_half_frame_ticks(2 * phase.first_frame - 1)
        end_ticks = get_half_frame_ticks(2 * phase.last_frame + 1)
        parameters = phase.parameters
        if parameters is None:
            lines.append(f"E {start_ticks} {end_ticks} 0 0 0")
            continue
        lines.append(f"E {start_ticks} {end_ticks} 1 {phase.random_seed} 1")
        lines.append("\tp " + " ".join(str(value) for value in (
            parameters.ar_coefficient_lag, parameters.ar_coefficient_shift, parameters.grain_scale_shift, parameters.scaling_shift,
            int(parameters.chroma_scaling_from_luma), int(parameters.overlap), parameters.cb_multiplier, parameters.cb_luma_multiplier,
            parameters.cb_offset, parameters.cr_multiplier, parameters.cr_luma_multiplier, parameters.cr_offset,
        )))
        lines.append(f"\tsY {format_points(parameters.luma_points)}")
        lines.append(f"\tsCb {format_points(parameters.cb_points)}")
        lines.append(f"\tsCr {format_points(parameters.cr_points)}")
        lines.append(format_coefficients("cY", parameters.luma_coefficients))
        lines.append(format_coefficients("cCb", parameters.cb_coefficients))
        lines.append(format_coefficients("cCr", parameters.cr_coefficients))
    return "\n".join(lines) + "\n"


def get_film_grain_parameter(vector: DecoderVector) -> str:
    """The aom-params entry that gives a vector its film grain."""

    if vector.grain_test_table:
        return f"film-grain-test={vector.grain_test_table}"
    # A relative name, because the parameter list separates its entries with colons
    return f"film-grain-table={GRAIN_TABLE_FILE_NAME}"


def get_motion_expressions() -> dict[str, str]:
    """The perspective filter's source corners: the padded canvas rotated, zoomed, and panned about its centre, by the frame number."""

    angle = f"({ROTATION_PER_FRAME}*in)"
    zoom = f"(1+{ZOOM_PER_FRAME}*in)"
    pan = f"({PAN_PER_FRAME}*in)"
    expressions: dict[str, str] = {}
    corners = (("-W/2", "-H/2"), ("W/2", "-H/2"), ("-W/2", "H/2"), ("W/2", "H/2"))
    for corner_index, (corner_x, corner_y) in enumerate(corners):
        expressions[f"x{corner_index}"] = f"W/2+{pan}+(({corner_x})*cos({angle})-({corner_y})*sin({angle}))/{zoom}"
        expressions[f"y{corner_index}"] = f"H/2+(({corner_x})*sin({angle})+({corner_y})*cos({angle}))/{zoom}"
    return expressions


def get_pattern_source(pattern: CellPattern) -> str:
    """One frozen frame of the Game of Life, scaled from its cells to the pattern's size."""

    return (f"life=size={PATTERN_CELLS}x{PATTERN_CELLS}:rate={FRAME_RATE}:seed={pattern.seed}:ratio={PATTERN_LIVE_RATIO}:"
            f"life_color={pattern.live_colour}:death_color={pattern.dead_colour},trim=end_frame=1,loop=loop=-1:size=1,"
            f"setpts=N/{FRAME_RATE}/TB,scale={PATTERN_SIZE}:{PATTERN_SIZE}:flags=neighbor,format={CANVAS_PIXEL_FORMAT}")


def get_gradient_source() -> str:
    """The drifting smooth planes, from expressions of the sample position and the frame number."""

    gradient_width, gradient_height = GRADIENT_SIZE
    expressions = ":".join(f"{plane}='{expression}'" for plane, expression in GRADIENT_EXPRESSIONS)
    return f"nullsrc=size={gradient_width}x{gradient_height}:rate={FRAME_RATE},format={CANVAS_PIXEL_FORMAT},geq={expressions}"


def get_source_graph(vector: DecoderVector) -> str:
    """The lavfi graph of a vector's frames: the canvas, its motion, and the crop to the vector's size."""

    repeated_count = len(REPEATED_PATTERN_POSITIONS)
    chains = [
        f"color=c={BACKGROUND_COLOUR}:size={CANVAS_WIDTH}x{CANVAS_HEIGHT}:rate={FRAME_RATE},format={CANVAS_PIXEL_FORMAT}[base]",
        get_pattern_source(REPEATED_PATTERN) + f",split={repeated_count}" + "".join(f"[repeated{index}]" for index in range(repeated_count)),
        get_pattern_source(SECOND_PATTERN) + "[second]",
    ]
    for picture_index, (_, (picture_width, picture_height)) in enumerate(NATURAL_PICTURES):
        chains.append(f"testsrc2=size={picture_width}x{picture_height}:rate={FRAME_RATE},format={CANVAS_PIXEL_FORMAT}[natural{picture_index}]")
    chains.append(get_gradient_source() + "[smooth]")
    layers = [(f"repeated{index}", position) for index, position in enumerate(REPEATED_PATTERN_POSITIONS)]
    layers.append(("second", SECOND_PATTERN_POSITION))
    layers.extend((f"natural{index}", position) for index, (position, _) in enumerate(NATURAL_PICTURES))
    layers.append(("smooth", GRADIENT_POSITION))
    current = "base"
    for layer_index, (label, (layer_x, layer_y)) in enumerate(layers):
        output = f"layer{layer_index}"
        chains.append(f"[{current}][{label}]overlay=x={layer_x}:y={layer_y}:format={OVERLAY_FORMAT}[{output}]")
        current = output
    motion = ":".join(f"{name}='{expression}'" for name, expression in get_motion_expressions().items())
    chains.append(
        f"[{current}]pad={CANVAS_WIDTH + 2 * CANVAS_MARGIN}:{CANVAS_HEIGHT + 2 * CANVAS_MARGIN}:{CANVAS_MARGIN}:{CANVAS_MARGIN}:"
        f"color={BACKGROUND_COLOUR},perspective={motion}:interpolation=cubic:eval=frame,"
        f"crop={CANVAS_WIDTH}:{CANVAS_HEIGHT}:{CANVAS_MARGIN}:{CANVAS_MARGIN},crop={vector.width}:{vector.height}:0:0"
    )
    return ";".join(chains)


def get_encode_arguments(vector: DecoderVector, output_path: Path) -> list[str]:
    """Returns FFmpeg's arguments that encode a vector into Matroska in one thread, without metadata that would vary between runs."""

    aom_parameters = ":".join((vector.layout_parameters, *ENCODER_TOOL_PARAMETERS, get_film_grain_parameter(vector)))
    return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        get_source_graph(vector),
        "-frames:v",
        str(FRAME_COUNT),
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-pix_fmt",
        vector.pixel_format,
        "-c:v",
        "libaom-av1",
        "-threads",
        "1",
        "-row-mt",
        "0",
        "-cpu-used",
        str(ENCODER_SPEED),
        "-crf",
        str(CONSTANT_RATE_FACTOR),
        "-b:v",
        "0",
        "-lag-in-frames",
        str(LOOKAHEAD_FRAMES),
        "-g",
        str(KEYFRAME_INTERVAL),
        "-aq-mode",
        VARIANCE_SEGMENTATION,
        "-aom-params",
        aom_parameters,
        "-f",
        CONTAINER,
        "-y",
        str(output_path),
    ]


def generate_vector(vector: DecoderVector, ffmpeg_path: Path, *, check: bool) -> bool:
    """Encodes one vector and installs it when it is missing, or compares it with the committed file; returns whether it was written."""

    with tempfile.TemporaryDirectory(prefix="webgpu-av1-vector-") as temporary_directory:
        working_directory = Path(temporary_directory)
        if vector.grain_phases:
            # libaom's table reader stops at a carriage return without an error, so the table is written with bare line feeds
            (working_directory / GRAIN_TABLE_FILE_NAME).write_bytes(build_grain_table(vector.grain_phases).encode("ascii"))
        # A failed encode never touches the committed vector
        encoded_path = working_directory / "encoded.mkv"
        result = subprocess.run([str(ffmpeg_path), *get_encode_arguments(vector, encoded_path)], capture_output=True, check=False,
                                stdin=subprocess.DEVNULL, cwd=working_directory)
        if result.returncode != 0:
            raise VectorGenerationError(f"FFmpeg failed on {vector.file_name}:\n{result.stderr.decode('utf-8', errors='replace')}")
        return install_or_check_output(VECTOR_DIRECTORY / vector.file_name, encoded_path.read_bytes(), check=check)


def generate_vectors(ffmpeg_path: Path, *, check: bool) -> list[str]:
    """Encodes every vector at once, each encode in one thread, and returns the names of those it wrote."""

    with ThreadPoolExecutor(max_workers=len(VECTORS)) as executor:
        results = list(executor.map(lambda vector: generate_vector(vector, ffmpeg_path, check=check), VECTORS))
    return [vector.file_name for vector, written in zip(VECTORS, results) if written]


def get_decoder_declarations() -> list[dict[str, object]]:
    """Returns the vector declarations of decoders/av1/decoder.json that match these media, for --print-declarations."""

    return [
        {"format": vector.output_format, "root": "decodersDirectory", "path": f"{PROJECT_NAME}/vectors/{vector.file_name}",
         "decoderOptions": list(REFERENCE_DECODER_OPTIONS)}
        for vector in VECTORS
    ]


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", type=Path, help="FFmpeg executable; defaults to ffmpeg on PATH. The committed media was encoded by FFmpeg 2026-03-01-git-862338fe31")
    parser.add_argument("--check", action="store_true", help="Fail unless every committed medium matches its regeneration; nothing is written")
    parser.add_argument("--print-declarations", action="store_true", help="Print the vectors list of decoder.json for these media and exit")
    return parser.parse_args(command_arguments)


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Generates or checks every medium and returns the process exit status."""

    arguments = parse_arguments(command_arguments)
    if arguments.print_declarations:
        print(json.dumps(get_decoder_declarations(), indent=4))
        return 0
    try:
        ffmpeg_path = resolve_tool_path("ffmpeg", arguments.ffmpeg)
        written = generate_vectors(ffmpeg_path, check=arguments.check)
    except (VectorGenerationError, GeneratedOutputError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    action = "Verified" if arguments.check else "Generated"
    print(f"{action} {len(VECTORS)} AV1 decoder vectors in {VECTOR_DIRECTORY}" + (f"; wrote {', '.join(written)}" if written else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
