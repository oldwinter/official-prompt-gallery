#!/usr/bin/env python3
"""Lock README naming comparison.json as the evidence source of truth."""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"
MANIFEST = ROOT / "data" / "comparison.json"


class ComparisonJsonSourceTests(unittest.TestCase):
    def test_manifest_exists(self) -> None:
        self.assertTrue(MANIFEST.is_file())

    def test_readme_names_json_as_source(self) -> None:
        section = README.read_text(encoding="utf-8").split("## View and validate", 1)[1].split(
            "## Private capture flow", 1
        )[0]
        self.assertIn("data/comparison.json", section)
        self.assertIn("source of truth", section)
        self.assertIn("projection", section)
        self.assertIn("[`data/comparison.json`](data/comparison.json)", section)
        self.assertIn("Edit the JSON first", section)
        self.assertIn("node scripts/validate.mjs --mode authoring", section)


if __name__ == "__main__":
    unittest.main()
