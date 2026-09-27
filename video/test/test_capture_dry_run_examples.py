#!/usr/bin/env python3
"""Lock copyable --dry-run examples in README to sanitized output."""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"
CAPTURE = ROOT / "scripts" / "capture.mjs"
RESERVE_H3 = "node scripts/capture.mjs reserve --case minimax-official-01 --route minimax-h3 --dry-run"
RUN_GROK = "node scripts/capture.mjs run --case minimax-official-01 --route grok-video --dry-run"


class CaptureDryRunExampleTests(unittest.TestCase):
    def test_readme_has_copyable_dry_runs(self) -> None:
        section = README.read_text(encoding="utf-8").split("## Private capture flow", 1)[1].split(
            "## Model and rights boundary", 1
        )[0]
        self.assertIn(RESERVE_H3, section)
        self.assertIn(RUN_GROK, section)
        self.assertIn("--route grok-video", section)
        self.assertIn("--dry-run", section)

    def test_copyable_dry_runs_execute_without_provider(self) -> None:
        for argv in (
            ("reserve", "--case", "minimax-official-01", "--route", "minimax-h3", "--dry-run"),
            ("run", "--case", "minimax-official-01", "--route", "grok-video", "--dry-run"),
        ):
            with self.subTest(argv=argv):
                result = subprocess.run(
                    ["node", str(CAPTURE), *argv],
                    cwd=ROOT,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
                combined = f"{result.stdout}\n{result.stderr}"
                self.assertNotRegex(combined, r"(?i)api[_ ]?key")

    def test_grok_run_dry_run_prints_sanitized_request(self) -> None:
        result = subprocess.run(
            [
                "node",
                str(CAPTURE),
                "run",
                "--case",
                "minimax-official-01",
                "--route",
                "grok-video",
                "--dry-run",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        payload = json.loads(result.stdout[result.stdout.index("{") :])
        self.assertEqual(
            set(payload),
            {"route", "requested_model", "prompt_sha256", "parameters"},
        )
        self.assertEqual(payload["route"], "grok-video")
        self.assertEqual(payload["requested_model"], "grok-imagine-video-1.5")


if __name__ == "__main__":
    unittest.main()
