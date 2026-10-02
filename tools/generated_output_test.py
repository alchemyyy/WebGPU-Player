"""Tests the write-or-check handling shared by the committed-output generators."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from generated_output import (
    GeneratedOutputError,
    install_or_check_output,
    write_or_check_output,
)


class WriteOrCheckOutputTests(unittest.TestCase):
    """Covers writing, and checking identical, different, and missing output."""

    def test_writes_output_and_creates_its_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_path = Path(temporary_directory) / "nested" / "output.bin"

            write_or_check_output(output_path, b"generated", check=False)

            self.assertEqual(output_path.read_bytes(), b"generated")
            self.assertEqual(list(output_path.parent.iterdir()), [output_path])

    def test_check_accepts_identical_committed_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_path = Path(temporary_directory) / "output.bin"
            output_path.write_bytes(b"committed")

            write_or_check_output(output_path, b"committed", check=True)

            self.assertEqual(output_path.read_bytes(), b"committed")

    def test_check_rejects_different_bytes_without_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_path = Path(temporary_directory) / "output.bin"
            output_path.write_bytes(b"committed")

            with self.assertRaisesRegex(GeneratedOutputError, "differs"):
                write_or_check_output(output_path, b"regenerated", check=True)

            self.assertEqual(output_path.read_bytes(), b"committed")

    def test_check_rejects_missing_output_without_creating_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_path = Path(temporary_directory) / "output.bin"

            with self.assertRaisesRegex(GeneratedOutputError, "missing"):
                write_or_check_output(output_path, b"regenerated", check=True)

            self.assertFalse(output_path.exists())


class InstallOrCheckOutputTests(unittest.TestCase):
    """Covers installing missing output without ever replacing different committed bytes."""

    def test_installs_missing_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_path = Path(temporary_directory) / "output.bin"

            self.assertTrue(install_or_check_output(output_path, b"generated", check=False))

            self.assertEqual(output_path.read_bytes(), b"generated")

    def test_never_replaces_different_committed_bytes(self) -> None:
        for check in (True, False):
            with self.subTest(check=check), tempfile.TemporaryDirectory() as temporary_directory:
                output_path = Path(temporary_directory) / "output.bin"
                output_path.write_bytes(b"committed")

                with self.assertRaisesRegex(GeneratedOutputError, "differs"):
                    install_or_check_output(output_path, b"regenerated", check=check)

                self.assertEqual(output_path.read_bytes(), b"committed")

    def test_accepts_identical_committed_bytes_without_writing(self) -> None:
        for check in (True, False):
            with self.subTest(check=check), tempfile.TemporaryDirectory() as temporary_directory:
                output_path = Path(temporary_directory) / "output.bin"
                output_path.write_bytes(b"committed")

                self.assertFalse(install_or_check_output(output_path, b"committed", check=check))

    def test_check_rejects_missing_output_without_creating_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_path = Path(temporary_directory) / "output.bin"

            with self.assertRaisesRegex(GeneratedOutputError, "missing"):
                install_or_check_output(output_path, b"regenerated", check=True)

            self.assertFalse(output_path.exists())


if __name__ == "__main__":
    unittest.main()
