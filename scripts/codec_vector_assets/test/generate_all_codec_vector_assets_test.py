"""Tests the generator list and failure handling of scripts/generate_all_codec_vector_assets.py."""

from __future__ import annotations

import io
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch


SCRIPTS_DIRECTORY = Path(__file__).resolve().parents[1]
# The master script sits in scripts/, above the generators it runs
MASTER_SCRIPT_DIRECTORY = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SCRIPTS_DIRECTORY))
sys.path.insert(0, str(MASTER_SCRIPT_DIRECTORY))

import generate_all_codec_vector_assets as master  # noqa: E402
from engine_layout import CODEC_VECTOR_SCRIPTS_DIRECTORY, ENGINE_ROOT  # noqa: E402


def create_completed_process(return_code: int) -> subprocess.CompletedProcess[bytes]:
    """Creates the result of a generator run with the given exit status."""

    return subprocess.CompletedProcess(args=[], returncode=return_code)


class GeneratorListTests(unittest.TestCase):
    """Keeps the generator list in step with the scripts on disk."""

    def test_every_listed_generator_exists(self) -> None:
        for step in master.GENERATOR_STEPS:
            with self.subTest(script_name=step.script_name):
                self.assertTrue((CODEC_VECTOR_SCRIPTS_DIRECTORY / step.script_name).is_file())

    def test_lists_each_generator_once(self) -> None:
        script_names = [step.script_name for step in master.GENERATOR_STEPS]

        self.assertEqual(len(script_names), len(set(script_names)))


class RunTests(unittest.TestCase):
    """Covers argument forwarding, continuing past failures, and the exit status."""

    def run_master(self, command_arguments: list[str], return_codes: list[int]) -> tuple[int, list[list[str]]]:
        """Runs main with mocked generators and returns its status and the commands it ran."""

        results = [create_completed_process(return_code) for return_code in return_codes]
        with (
            patch.object(subprocess, "run", side_effect=results) as mocked_run,
            redirect_stdout(io.StringIO()),
            redirect_stderr(io.StringIO()),
        ):
            status = master.main(command_arguments)
        commands = [generator_call.args[0] for generator_call in mocked_run.call_args_list]
        return status, commands

    def test_runs_every_generator_from_the_engine_root(self) -> None:
        generator_count = len(master.GENERATOR_STEPS)

        with patch.object(
            subprocess,
            "run",
            side_effect=[create_completed_process(0)] * generator_count,
        ) as mocked_run, redirect_stdout(io.StringIO()):
            status = master.main([])

        self.assertEqual(status, 0)
        self.assertEqual(mocked_run.call_count, generator_count)
        for generator_call in mocked_run.call_args_list:
            self.assertEqual(generator_call.kwargs["cwd"], ENGINE_ROOT)
            self.assertEqual(generator_call.args[0][0], sys.executable)

    def test_forwards_check_to_every_generator(self) -> None:
        generator_count = len(master.GENERATOR_STEPS)

        status, commands = self.run_master(["--check"], [0] * generator_count)

        self.assertEqual(status, 0)
        for command in commands:
            self.assertEqual(command[-1], "--check")

    def test_passes_each_generator_its_own_arguments(self) -> None:
        generator_count = len(master.GENERATOR_STEPS)

        _status, commands = self.run_master([], [0] * generator_count)

        for step, command in zip(master.GENERATOR_STEPS, commands, strict=True):
            self.assertEqual(Path(command[1]).name, step.script_name)
            self.assertEqual(tuple(command[2:]), step.arguments)

    def test_continues_past_a_failure_and_fails(self) -> None:
        generator_count = len(master.GENERATOR_STEPS)
        return_codes = [0] * generator_count
        return_codes[0] = 1

        status, commands = self.run_master([], return_codes)

        self.assertEqual(status, 1)
        self.assertEqual(len(commands), generator_count)


if __name__ == "__main__":
    unittest.main()
