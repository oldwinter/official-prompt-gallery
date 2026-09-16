#!/usr/bin/env python3
"""Lock copyable Grok reserve --dry-run examples in README."""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"
CAPTURE = ROOT / "scripts" / "capture.mjs"
OPENAI = "node scripts/capture.mjs reserve --case openai-official-01 --route grok-image --dry-run"
XAI = "node scripts/capture.mjs reserve --case xai-official-01 --route grok-image --dry-run"


class GrokReserveExampleTests(unittest.TestCase):
    def test_readme_has_copyable_grok_reserves(self) -> None:
        section = README.read_text(encoding="utf-8").split("## Private capture flow", 1)[1].split(
            "## Provenance and licensing", 1
        )[0]
        self.assertIn(OPENAI, section)
        self.assertIn(XAI, section)
        self.assertIn("--route grok-image", section)
        self.assertIn("--dry-run", section)

    def test_openai_grok_dry_run_does_not_call_provider(self) -> None:
        result = subprocess.run(
            [
                "node",
                str(CAPTURE),
                "reserve",
                "--case",
                "openai-official-01",
                "--route",
                "grok-image",
                "--dry-run",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        combined = f"{result.stdout}\n{result.stderr}"
        self.assertNotRegex(combined, r"(?i)api[_ ]?key")


if __name__ == "__main__":
    unittest.main()
