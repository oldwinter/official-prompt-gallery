#!/usr/bin/env python3
"""Lock capture.mjs --help and usage-error next-step."""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CAPTURE = ROOT / "scripts" / "capture.mjs"
README = ROOT / "README.md"


def run_capture(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(CAPTURE), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


class CaptureHelpTests(unittest.TestCase):
    def test_help_flag_prints_command_list(self) -> None:
        for flag in ("--help", "-h"):
            with self.subTest(flag=flag):
                result = run_capture(flag)
                self.assertEqual(result.returncode, 0, result.stderr)
                combined = f"{result.stdout}\n{result.stderr}"
                self.assertIn("reserve", combined)
                self.assertIn("run", combined)
                self.assertIn("import", combined)
                self.assertIn("admit", combined)
                self.assertIn("reconcile", combined)

    def test_usage_error_points_at_help(self) -> None:
        for args in (("nope",), ("reserve", "--wat")):
            with self.subTest(args=args):
                result = run_capture(*args)
                self.assertEqual(result.returncode, 1)
                combined = f"{result.stdout}\n{result.stderr}"
                self.assertIn("See: node scripts/capture.mjs --help", combined)

    def test_readme_names_help(self) -> None:
        readme = README.read_text(encoding="utf-8")
        capture = readme.split("## Private capture flow", 1)[1].split("## Provenance and licensing", 1)[0]
        self.assertIn("node scripts/capture.mjs --help", capture)


if __name__ == "__main__":
    unittest.main()
