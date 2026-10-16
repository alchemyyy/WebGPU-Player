"""Tests the AV1 decoder vector generator's vector table, film grain tables, source graph, and encode arguments without running FFmpeg."""

from __future__ import annotations

import json
import math
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Sequence
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))

import generate_av1_decoder_vectors as generator  # noqa: E402
from vector_test_support import run_main  # noqa: E402


# Saved before any test replaces generator.VECTOR_DIRECTORY
COMMITTED_VECTOR_DIRECTORY = generator.VECTOR_DIRECTORY
PROJECT_DECLARATION_PATH = COMMITTED_VECTOR_DIRECTORY.parent / "decoder.json"
# The engine's output formats in its order, each with the FFmpeg pixel format its vector's stream must have
PIXEL_FORMATS = {
    "I420": "yuv420p",
    "I420P10": "yuv420p10le",
    "I420P12": "yuv420p12le",
    "I422": "yuv422p",
    "I422P10": "yuv422p10le",
    "I422P12": "yuv422p12le",
    "I444": "yuv444p",
    "I444P10": "yuv444p10le",
    "I444P12": "yuv444p12le",
}
SUPERBLOCK_64 = 64
SUPERBLOCK_128 = 128
SUPERBLOCK_128_NAME_MARK = "-sb128"
# The 64x64-superblock layout splits the columns 3+1 and the rows 2+1, so a vector keeps four columns and three rows of superblocks
SUPERBLOCK_64_COLUMNS = 4
SUPERBLOCK_64_ROWS = 3
TEST_TABLE_COUNT = 16
# Film grain value ranges of the AV1 syntax
AR_COEFFICIENT_LAGS = {0, 1, 2, 3}
AR_COEFFICIENT_SHIFTS = range(6, 10)
SCALING_SHIFTS = range(8, 12)
GRAIN_SCALE_SHIFTS = range(0, 4)
MAXIMUM_LUMA_POINTS = 14
MAXIMUM_CHROMA_POINTS = 10
MAXIMUM_POINT_VALUE = 255
MAXIMUM_MULTIPLIER = 255
MAXIMUM_OFFSET = 511
COEFFICIENT_RANGE = range(-128, 128)
PARAMETER_FIELD_COUNT = 12
CARRIAGE_RETURN = "\r"
OUTPUT_PATH = Path("encoded.mkv")
OTHER_BYTES = b"other bytes"
FAILED_ENCODE_MESSAGE = b"Unknown encoder"
# The perspective filter's variables when the canvas is padded, and the frames where the motion is checked
PADDED_WIDTH = generator.CANVAS_WIDTH + 2 * generator.CANVAS_MARGIN
PADDED_HEIGHT = generator.CANVAS_HEIGHT + 2 * generator.CANVAS_MARGIN
LAST_FRAME = generator.FRAME_COUNT - 1
CORNER_TOLERANCE = 1e-9
FRAME_VARIABLE_PATTERN = re.compile(r"\bin\b")
FRAME_VARIABLE_REPLACEMENT = "frame_number"
MINIMUM_CORNER_MOTION = 1


def get_superblock_size(vector: generator.DecoderVector) -> int:
    return SUPERBLOCK_128 if vector.layout_parameters == generator.SUPERBLOCK_128_ONE_TILE else SUPERBLOCK_64


def get_frame_ticks(frame: int) -> int:
    """A frame's timestamp as libaom computes it from FFmpeg's 1/24 time base."""

    return frame * generator.TICKS_PER_SECOND // generator.FRAME_RATE


def read_grain_entries(table: str) -> list[dict[str, object]]:
    """A film grain table's entries: their times, whether they apply grain, and their parameter and coefficient lines."""

    entries: list[dict[str, object]] = []
    for line in table.split("\n")[1:]:
        if line.startswith("E "):
            start, end, apply_grain, _seed, update = (int(value) for value in line.split()[1:])
            entries.append({"start": start, "end": end, "apply": apply_grain, "update": update, "lines": {}})
        elif line.startswith("\t"):
            header, *values = line[1:].split()
            entries[-1]["lines"][header] = [int(value) for value in values]
    return entries


def evaluate_motion(expression: str, frame: int) -> float:
    """Evaluates a perspective corner expression for the padded canvas at a frame; FFmpeg's frame variable is a Python keyword."""

    python_expression = FRAME_VARIABLE_PATTERN.sub(FRAME_VARIABLE_REPLACEMENT, expression)
    variables = {"W": PADDED_WIDTH, "H": PADDED_HEIGHT, FRAME_VARIABLE_REPLACEMENT: frame, "cos": math.cos, "sin": math.sin}
    return eval(python_expression, {"__builtins__": {}}, variables)


class FakeFFmpeg:
    """Stands in for FFmpeg: an encode writes the committed vector of its pixel format, and records the grain table beside it."""

    def __init__(self, exit_status: int = 0) -> None:
        self.exit_status = exit_status
        self.vectors_by_pixel_format = {vector.pixel_format: vector for vector in generator.VECTORS}
        self.grain_tables: dict[str, bytes] = {}

    def run(self, command: Sequence[str], **options: object) -> subprocess.CompletedProcess[bytes]:
        if self.exit_status != 0:
            return subprocess.CompletedProcess(command, self.exit_status, b"", FAILED_ENCODE_MESSAGE)
        vector = self.vectors_by_pixel_format[command[command.index("-pix_fmt") + 1]]
        table_path = Path(str(options["cwd"])) / generator.GRAIN_TABLE_FILE_NAME
        if table_path.is_file():
            self.grain_tables[vector.file_name] = table_path.read_bytes()
        Path(command[-1]).write_bytes((COMMITTED_VECTOR_DIRECTORY / vector.file_name).read_bytes())
        return subprocess.CompletedProcess(command, 0, b"", b"")


class VectorTableTests(unittest.TestCase):
    def test_lists_one_vector_per_output_format_in_the_engine_order_with_its_pixel_format(self) -> None:
        self.assertEqual([vector.output_format for vector in generator.VECTORS], list(PIXEL_FORMATS))
        for vector in generator.VECTORS:
            with self.subTest(file_name=vector.file_name):
                self.assertEqual(vector.pixel_format, PIXEL_FORMATS[vector.output_format])

    def test_keeps_each_size_inside_the_canvas_and_its_superblock_layout(self) -> None:
        for vector in generator.VECTORS:
            with self.subTest(file_name=vector.file_name):
                self.assertLessEqual(vector.width, generator.CANVAS_WIDTH)
                self.assertLessEqual(vector.height, generator.CANVAS_HEIGHT)
                if get_superblock_size(vector) == SUPERBLOCK_64:
                    self.assertEqual(math.ceil(vector.width / SUPERBLOCK_64), SUPERBLOCK_64_COLUMNS)
                    self.assertEqual(math.ceil(vector.height / SUPERBLOCK_64), SUPERBLOCK_64_ROWS)

    def test_keeps_a_copy_of_the_repeated_pattern_inside_the_frame_where_IntraBC_may_reach_it(self) -> None:
        source_x, source_y = generator.REPEATED_PATTERN_POSITIONS[0]
        for vector in generator.VECTORS:
            # One superblock row down for 128x128 superblocks, more than four superblocks back in the tile for 64x64 ones
            reachable_y = SUPERBLOCK_128 if get_superblock_size(vector) == SUPERBLOCK_128 else SUPERBLOCK_64
            copies = [(x, y) for x, y in generator.REPEATED_PATTERN_POSITIONS[1:] if y == source_y + reachable_y]
            with self.subTest(file_name=vector.file_name):
                self.assertEqual(len(copies), 1)
                copy_x, copy_y = copies[0]
                self.assertGreater(copy_x, source_x)
                self.assertLess(copy_x, vector.width)
                self.assertLess(copy_y, vector.height)

    def test_covers_odd_sizes_both_superblock_sizes_and_names_the_128x128_ones(self) -> None:
        self.assertTrue(any(vector.width % 2 for vector in generator.VECTORS))
        self.assertTrue(any(vector.height % 2 for vector in generator.VECTORS))
        self.assertEqual({get_superblock_size(vector) for vector in generator.VECTORS}, {SUPERBLOCK_64, SUPERBLOCK_128})
        for vector in generator.VECTORS:
            with self.subTest(file_name=vector.file_name):
                self.assertEqual(SUPERBLOCK_128_NAME_MARK in vector.file_name, get_superblock_size(vector) == SUPERBLOCK_128)
                self.assertIn(f"-{vector.width}x{vector.height}", vector.file_name)

    def test_gives_each_vector_film_grain_from_one_test_table_or_one_schedule(self) -> None:
        for vector in generator.VECTORS:
            with self.subTest(file_name=vector.file_name):
                self.assertNotEqual(bool(vector.grain_test_table), bool(vector.grain_phases))
                if vector.grain_test_table:
                    self.assertIn(vector.grain_test_table, range(1, TEST_TABLE_COUNT + 1))

    def test_schedules_cover_every_frame_once(self) -> None:
        for phases in {vector.grain_phases for vector in generator.VECTORS if vector.grain_phases}:
            covered = [frame for phase in phases for frame in range(phase.first_frame, phase.last_frame + 1)]
            self.assertEqual(covered, list(range(generator.FRAME_COUNT)))

    def test_schedules_vary_the_lag_chroma_scaling_and_overlap_and_pause(self) -> None:
        phases = [phase for vector in generator.VECTORS for phase in vector.grain_phases]
        parameters = [phase.parameters for phase in phases if phase.parameters is not None]

        self.assertEqual({parameter.ar_coefficient_lag for parameter in parameters}, AR_COEFFICIENT_LAGS)
        self.assertEqual({parameter.chroma_scaling_from_luma for parameter in parameters}, {False, True})
        self.assertEqual({parameter.overlap for parameter in parameters}, {False, True})
        self.assertTrue(any(phase.parameters is None for phase in phases))

    def test_declares_what_decoder_json_lists(self) -> None:
        if not PROJECT_DECLARATION_PATH.is_file():
            self.skipTest("wgpud/av1/decoder.json does not exist yet")
        project = json.loads(PROJECT_DECLARATION_PATH.read_text(encoding="utf-8"))
        if "vectors" not in project:
            self.skipTest("wgpud/av1/decoder.json lists no vectors yet")

        self.assertEqual(generator.get_decoder_declarations(), project["vectors"])

    def test_declares_the_libdav1d_reference_decode(self) -> None:
        for declaration in generator.get_decoder_declarations():
            with self.subTest(path=declaration["path"]):
                self.assertEqual(declaration["decoderOptions"], ["-c:v", "libdav1d"])
                self.assertEqual(declaration["root"], "decodersDirectory")

    def test_prints_the_declarations(self) -> None:
        status, output, _ = run_main(generator.main, ["--print-declarations"])

        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output), generator.get_decoder_declarations())


class GrainParameterTests(unittest.TestCase):
    def test_keeps_every_parameter_set_inside_the_syntax_ranges(self) -> None:
        parameters = {phase.parameters for vector in generator.VECTORS for phase in vector.grain_phases if phase.parameters is not None}
        for parameter in parameters:
            with self.subTest(lag=parameter.ar_coefficient_lag):
                self.assertIn(parameter.ar_coefficient_lag, AR_COEFFICIENT_LAGS)
                self.assertIn(parameter.ar_coefficient_shift, AR_COEFFICIENT_SHIFTS)
                self.assertIn(parameter.scaling_shift, SCALING_SHIFTS)
                self.assertIn(parameter.grain_scale_shift, GRAIN_SCALE_SHIFTS)
                for value in (parameter.cb_multiplier, parameter.cb_luma_multiplier, parameter.cr_multiplier, parameter.cr_luma_multiplier):
                    self.assertIn(value, range(MAXIMUM_MULTIPLIER + 1))
                self.assertIn(parameter.cb_offset, range(MAXIMUM_OFFSET + 1))
                self.assertIn(parameter.cr_offset, range(MAXIMUM_OFFSET + 1))
                self.assertLessEqual(len(parameter.luma_points), MAXIMUM_LUMA_POINTS)
                self.assertLessEqual(len(parameter.cb_points), MAXIMUM_CHROMA_POINTS)
                self.assertLessEqual(len(parameter.cr_points), MAXIMUM_CHROMA_POINTS)
                for points in (parameter.luma_points, parameter.cb_points, parameter.cr_points):
                    positions = [position for position, _ in points]
                    self.assertEqual(positions, sorted(set(positions)))
                    self.assertTrue(all(0 <= position <= MAXIMUM_POINT_VALUE and 0 <= value <= MAXIMUM_POINT_VALUE for position, value in points))
                coefficients = parameter.luma_coefficients + parameter.cb_coefficients + parameter.cr_coefficients
                self.assertTrue(all(coefficient in COEFFICIENT_RANGE for coefficient in coefficients))

    def test_gives_each_lag_its_coefficient_counts_and_chroma_from_luma_no_chroma_points(self) -> None:
        parameters = {phase.parameters for vector in generator.VECTORS for phase in vector.grain_phases if phase.parameters is not None}
        for parameter in parameters:
            luma_count = 2 * parameter.ar_coefficient_lag * (parameter.ar_coefficient_lag + 1)
            with self.subTest(lag=parameter.ar_coefficient_lag):
                self.assertEqual(len(parameter.luma_coefficients), luma_count)
                self.assertEqual(len(parameter.cb_coefficients), luma_count + 1)
                self.assertEqual(len(parameter.cr_coefficients), luma_count + 1)
                self.assertTrue(parameter.luma_points)
                if parameter.chroma_scaling_from_luma:
                    self.assertEqual((parameter.cb_points, parameter.cr_points), ((), ()))


class GrainTableTests(unittest.TestCase):
    def test_writes_the_magic_then_one_entry_per_phase_with_line_feeds_only(self) -> None:
        table = generator.build_grain_table(generator.GRAIN_PHASES_A)

        self.assertTrue(table.startswith(generator.GRAIN_TABLE_MAGIC + "\n"))
        self.assertNotIn(CARRIAGE_RETURN, table)
        self.assertEqual(len(read_grain_entries(table)), len(generator.GRAIN_PHASES_A))

    def test_spans_exactly_each_phase_s_frames(self) -> None:
        for phases in (generator.GRAIN_PHASES_A, generator.GRAIN_PHASES_B):
            entries = read_grain_entries(generator.build_grain_table(phases))
            for phase, entry in zip(phases, entries, strict=True):
                with self.subTest(first_frame=phase.first_frame):
                    for frame in range(generator.FRAME_COUNT):
                        inside = entry["start"] <= get_frame_ticks(frame) < entry["end"]
                        self.assertEqual(inside, phase.first_frame <= frame <= phase.last_frame)

    def test_writes_parameters_only_for_phases_with_grain(self) -> None:
        for phases in (generator.GRAIN_PHASES_A, generator.GRAIN_PHASES_B):
            entries = read_grain_entries(generator.build_grain_table(phases))
            for phase, entry in zip(phases, entries, strict=True):
                with self.subTest(first_frame=phase.first_frame):
                    if phase.parameters is None:
                        self.assertEqual((entry["apply"], entry["update"], entry["lines"]), (0, 0, {}))
                        continue
                    lines = entry["lines"]
                    self.assertEqual((entry["apply"], entry["update"]), (1, 1))
                    self.assertEqual(len(lines["p"]), PARAMETER_FIELD_COUNT)
                    self.assertEqual(lines["sY"], [len(phase.parameters.luma_points)] + [value for point in phase.parameters.luma_points for value in point])
                    self.assertEqual(lines["cY"], list(phase.parameters.luma_coefficients))
                    self.assertEqual(lines["cCr"], list(phase.parameters.cr_coefficients))

    def test_names_the_table_by_a_relative_path_and_a_test_table_by_its_number(self) -> None:
        table_vector = next(vector for vector in generator.VECTORS if vector.grain_phases)
        test_table_vector = next(vector for vector in generator.VECTORS if vector.grain_test_table)

        self.assertEqual(generator.get_film_grain_parameter(table_vector), f"film-grain-table={generator.GRAIN_TABLE_FILE_NAME}")
        self.assertEqual(generator.get_film_grain_parameter(test_table_vector), f"film-grain-test={test_table_vector.grain_test_table}")


class SourceGraphTests(unittest.TestCase):
    def test_moves_the_canvas_from_the_identity_at_the_first_frame(self) -> None:
        expressions = generator.get_motion_expressions()
        corners = [(0, 0), (PADDED_WIDTH, 0), (0, PADDED_HEIGHT), (PADDED_WIDTH, PADDED_HEIGHT)]
        for corner_index, (corner_x, corner_y) in enumerate(corners):
            with self.subTest(corner=corner_index):
                self.assertAlmostEqual(evaluate_motion(expressions[f"x{corner_index}"], 0), corner_x, delta=CORNER_TOLERANCE)
                self.assertAlmostEqual(evaluate_motion(expressions[f"y{corner_index}"], 0), corner_y, delta=CORNER_TOLERANCE)
                self.assertNotAlmostEqual(evaluate_motion(expressions[f"x{corner_index}"], LAST_FRAME), corner_x, delta=MINIMUM_CORNER_MOTION)

    def test_crops_the_moved_canvas_to_the_vector_size(self) -> None:
        for vector in generator.VECTORS:
            graph = generator.get_source_graph(vector)
            with self.subTest(file_name=vector.file_name):
                self.assertTrue(graph.endswith(f",crop={vector.width}:{vector.height}:0:0"))
                self.assertIn(f"pad={PADDED_WIDTH}:{PADDED_HEIGHT}:{generator.CANVAS_MARGIN}:{generator.CANVAS_MARGIN}", graph)

    def test_places_every_layer_once_and_draws_the_gradient_without_random_sources(self) -> None:
        graph = generator.get_source_graph(generator.VECTORS[0])
        positions = re.findall(r"overlay=x=(\d+):y=(\d+)", graph)
        expected = [*generator.REPEATED_PATTERN_POSITIONS, generator.SECOND_PATTERN_POSITION,
                    *(position for position, _ in generator.NATURAL_PICTURES), generator.GRADIENT_POSITION]

        self.assertEqual([(int(x), int(y)) for x, y in positions], expected)
        self.assertIn("geq=", graph)
        self.assertNotIn("gradients=", graph)
        self.assertEqual(graph.count(f"seed={generator.REPEATED_PATTERN.seed}:"), 1)


class EncodeArgumentTests(unittest.TestCase):
    def test_encodes_in_one_thread_with_the_lookahead_and_drops_varying_metadata(self) -> None:
        vector = generator.VECTORS[0]
        arguments = generator.get_encode_arguments(vector, OUTPUT_PATH)

        self.assertEqual(arguments[arguments.index("-c:v") + 1], "libaom-av1")
        self.assertEqual(arguments[arguments.index("-threads") + 1], "1")
        self.assertEqual(arguments[arguments.index("-row-mt") + 1], "0")
        self.assertEqual(arguments[arguments.index("-cpu-used") + 1], str(generator.ENCODER_SPEED))
        self.assertEqual(arguments[arguments.index("-lag-in-frames") + 1], str(generator.LOOKAHEAD_FRAMES))
        self.assertEqual(arguments[arguments.index("-g") + 1], str(generator.KEYFRAME_INTERVAL))
        self.assertEqual(arguments[arguments.index("-frames:v") + 1], str(generator.FRAME_COUNT))
        self.assertEqual(arguments[arguments.index("-pix_fmt") + 1], vector.pixel_format)
        self.assertEqual(arguments[arguments.index("-map_metadata") + 1], "-1")
        self.assertEqual(arguments[arguments.index("-fflags") + 1], "+bitexact")
        self.assertEqual(arguments[arguments.index("-i") + 1], generator.get_source_graph(vector))
        self.assertEqual(arguments[-4:], ["-f", generator.CONTAINER, "-y", str(OUTPUT_PATH)])

    def test_passes_the_layout_tools_and_film_grain_as_libaom_parameters(self) -> None:
        for vector in generator.VECTORS:
            arguments = generator.get_encode_arguments(vector, OUTPUT_PATH)
            parameters = arguments[arguments.index("-aom-params") + 1]
            with self.subTest(file_name=vector.file_name):
                self.assertTrue(parameters.startswith(vector.layout_parameters + ":"))
                for tool_parameter in generator.ENCODER_TOOL_PARAMETERS:
                    self.assertIn(tool_parameter, parameters.split(":"))
                self.assertTrue(parameters.endswith(generator.get_film_grain_parameter(vector)))


class GenerationTests(unittest.TestCase):
    def run_generator(self, directory: Path, fake: FakeFFmpeg, command_arguments: Sequence[str]) -> tuple[int, str, str]:
        ffmpeg_path = directory / "ffmpeg"
        ffmpeg_path.write_bytes(b"")
        with patch.object(generator, "VECTOR_DIRECTORY", directory / "vectors"), patch.object(generator.subprocess, "run", side_effect=fake.run):
            return run_main(generator.main, ["--ffmpeg", str(ffmpeg_path), *command_arguments])

    def test_installs_missing_vectors_as_the_committed_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            status, output, error = self.run_generator(directory, FakeFFmpeg(), [])

            self.assertEqual((status, error), (0, ""))
            self.assertIn(f"Generated {len(generator.VECTORS)} AV1 decoder vectors", output)
            for vector in generator.VECTORS:
                self.assertEqual((directory / "vectors" / vector.file_name).read_bytes(), (COMMITTED_VECTOR_DIRECTORY / vector.file_name).read_bytes())

    def test_writes_each_schedule_s_grain_table_into_the_encoder_s_working_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            fake = FakeFFmpeg()
            self.run_generator(Path(temporary_directory), fake, [])

            for vector in generator.VECTORS:
                with self.subTest(file_name=vector.file_name):
                    if vector.grain_phases:
                        self.assertEqual(fake.grain_tables[vector.file_name], generator.build_grain_table(vector.grain_phases).encode("ascii"))
                    else:
                        self.assertNotIn(vector.file_name, fake.grain_tables)

    def test_check_passes_on_identical_vectors(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            (directory / "vectors").mkdir()
            for vector in generator.VECTORS:
                (directory / "vectors" / vector.file_name).write_bytes((COMMITTED_VECTOR_DIRECTORY / vector.file_name).read_bytes())
            status, output, _ = self.run_generator(directory, FakeFFmpeg(), ["--check"])

            self.assertEqual(status, 0)
            self.assertIn(f"Verified {len(generator.VECTORS)} AV1 decoder vectors", output)

    def test_check_fails_on_a_changed_vector_and_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            (directory / "vectors").mkdir()
            changed_path = directory / "vectors" / generator.VECTORS[0].file_name
            changed_path.write_bytes(OTHER_BYTES)
            status, _, error = self.run_generator(directory, FakeFFmpeg(), ["--check"])

            self.assertEqual(status, 1)
            self.assertIn("differs from the committed bytes", error)
            self.assertEqual(changed_path.read_bytes(), OTHER_BYTES)

    def test_never_replaces_an_existing_vector(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            (directory / "vectors").mkdir()
            existing_path = directory / "vectors" / generator.VECTORS[0].file_name
            existing_path.write_bytes(OTHER_BYTES)
            status, _, error = self.run_generator(directory, FakeFFmpeg(), [])

            self.assertEqual(status, 1)
            self.assertIn("differs from the committed bytes", error)
            self.assertEqual(existing_path.read_bytes(), OTHER_BYTES)

    def test_reports_a_failed_encode_with_FFmpeg_s_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            status, _, error = self.run_generator(directory, FakeFFmpeg(exit_status=1), [])

            self.assertEqual(status, 1)
            self.assertIn("FFmpeg failed on", error)
            self.assertIn(FAILED_ENCODE_MESSAGE.decode("ascii"), error)
            self.assertFalse((directory / "vectors").exists())

    def test_refuses_a_missing_explicit_tool(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            missing_path = Path(temporary_directory) / "ffmpeg"
            status, _, error = run_main(generator.main, ["--ffmpeg", str(missing_path)])

            self.assertEqual(status, 1)
            self.assertIn("ffmpeg was not found", error)

    def test_names_the_flag_when_a_tool_is_not_on_PATH(self) -> None:
        with patch.object(generator.shutil, "which", return_value=None):
            with self.assertRaisesRegex(FileNotFoundError, "pass --ffmpeg"):
                generator.resolve_tool_path("ffmpeg", None)


if __name__ == "__main__":
    unittest.main()
