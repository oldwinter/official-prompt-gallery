#!/usr/bin/env python3
"""Lock planned placeholder alts away from admitted-output wording."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
MANIFEST = json.loads((ROOT / "data" / "comparison.json").read_text(encoding="utf-8"))

PLANNED = {
    "openai-official-01": "Placeholder for the planned veterinarian and baby otter Grok cell; no admitted public bytes yet.",
    "xai-official-01": "Placeholder for the planned London landmarks Grok cell; no admitted public bytes yet.",
}


class PlannedPlaceholderAltTests(unittest.TestCase):
    def test_manifest_planned_alts_are_placeholders(self) -> None:
        for case_id, expected in PLANNED.items():
            with self.subTest(case_id=case_id):
                sample = MANIFEST["samples"][case_id]["grok-image"]
                self.assertEqual(sample["state"]["kind"], "planned")
                self.assertEqual(sample["alt_text"], expected)
                self.assertNotIn("AI-generated", sample["alt_text"])

    def test_html_planned_imgs_match_manifest(self) -> None:
        for case_id, expected in PLANNED.items():
            with self.subTest(case_id=case_id):
                match = re.search(
                    rf'<figure\b[^>]*data-case-id="{case_id}"[^>]*data-route-id="grok-image"[^>]*>[\s\S]*?</figure>',
                    HTML,
                    re.I,
                )
                self.assertIsNotNone(match)
                body = match.group(0)
                self.assertIn('src="assets/planned-image.webp"', body)
                self.assertIn(f'alt="{expected}"', body)
                self.assertNotIn("AI-generated", body.split("<img", 1)[1].split(">", 1)[0])

    def test_admitted_alts_unchanged(self) -> None:
        self.assertIn(
            "AI-generated children's book scene of a veterinarian listening to a baby otter's heartbeat with a stethoscope.",
            MANIFEST["samples"]["openai-official-01"]["codex-image"]["alt_text"],
        )
        self.assertIn(
            "AI-generated collage of London landmarks rendered in a stenciled street-art style.",
            MANIFEST["samples"]["xai-official-01"]["codex-image"]["alt_text"],
        )


if __name__ == "__main__":
    unittest.main()
