#!/usr/bin/env python3
"""Lock publish-mode next step when planned cells remain."""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VALIDATE = ROOT / "scripts" / "validate.mjs"
README = ROOT / "README.md"
NEXT = "next: this checkout still has planned cells; run `node scripts/validate.mjs --mode authoring`"


def run_validate(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(VALIDATE), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


class ValidateAuthoringNextTests(unittest.TestCase):
    def test_publish_failure_names_authoring(self) -> None:
        result = run_validate()
        self.assertEqual(result.returncode, 1)
        combined = f"{result.stdout}\n{result.stderr}"
        self.assertIn("planned-cell", combined)
        self.assertIn("FAIL mode=publish", combined)
        self.assertIn(NEXT, combined)

    def test_authoring_pass_has_no_publish_next(self) -> None:
        result = run_validate("--mode", "authoring")
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        combined = f"{result.stdout}\n{result.stderr}"
        self.assertIn("PASS mode=authoring", combined)
        self.assertNotIn(NEXT, combined)

    def test_planned_html_cells_have_no_native_controls(self) -> None:
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        planned = 0
        for block in html.split("<figure"):
            if 'data-state="planned"' not in block:
                continue
            planned += 1
            self.assertNotRegex(block.split("</figure>", 1)[0], r"<video\b[^>]*\bcontrols\b")
            self.assertNotIn("data-video-player", block.split("</figure>", 1)[0])
        self.assertEqual(planned, 2)

    def test_readme_says_current_checkout_needs_authoring(self) -> None:
        readme = README.read_text(encoding="utf-8")
        section = readme.split("## View and validate", 1)[1].split("## Private capture flow", 1)[0]
        self.assertIn("node scripts/validate.mjs --mode authoring", section)
        self.assertIn("planned Grok cells", section)
        self.assertIn("--mode authoring", section)
        self.assertIn("data/comparison.json", section)
        self.assertIn("python3 -m http.server", section)


if __name__ == "__main__":
    unittest.main()
