#!/usr/bin/env python3
"""Lock planned cells to pending wording, distinct from admitted wording."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
MANIFEST = json.loads((ROOT / "data" / "comparison.json").read_text(encoding="utf-8"))

PLANNED = {
    "minimax-official-01": "grok-imagine-video-1.5 output for the drone dancer prompt is pending admission",
    "xai-official-01": "grok-imagine-video-1.5 output for the Mars launch prompt is pending admission",
}
ADMITTED_ALT = {
    "minimax-official-01": "MiniMax-H3 output for the drone dancer prompt.",
    "xai-official-01": "MiniMax-H3 output for the Mars launch prompt.",
}
ADMITTED_ONLY = (
    "admission",
    "alt_text",
    "asset",
    "cost",
    "generated_at",
    "media_facts",
    "receipt_sha256",
    "served_model",
)


def figure_html(case_id: str, route_id: str) -> str:
    match = re.search(
        rf'<figure\b[^>]*data-case-id="{case_id}"[^>]*data-route-id="{route_id}"[^>]*>[\s\S]*?</figure>',
        HTML,
        re.I,
    )
    assert match is not None
    return match.group(0)


class PlannedPendingWordingTests(unittest.TestCase):
    def test_manifest_planned_cells_carry_no_admitted_fields(self) -> None:
        for case_id in PLANNED:
            with self.subTest(case_id=case_id):
                sample = MANIFEST["samples"][case_id]["grok-video"]
                self.assertEqual(sample["state"]["kind"], "planned")
                self.assertEqual(
                    sample["state"]["reason"], "awaiting-private-generation-and-review"
                )
                for key in ADMITTED_ONLY:
                    self.assertNotIn(key, sample)
                    self.assertNotIn(key, sample["state"])

    def test_html_planned_figures_carry_pending_wording(self) -> None:
        for case_id, label in PLANNED.items():
            with self.subTest(case_id=case_id):
                body = figure_html(case_id, "grok-video")
                self.assertIn('data-state="planned"', body)
                self.assertIn("Asset pending admission", body)
                self.assertIn(f'aria-label="{label}"', body)
                self.assertIn('<span class="state-tag">PLANNED</span>', body)
                self.assertNotIn("<video", body)
                self.assertNotIn("Admitted output", body)
                self.assertNotIn(">ADMITTED<", body)

    def test_admitted_wording_unchanged(self) -> None:
        for case_id, expected in ADMITTED_ALT.items():
            with self.subTest(case_id=case_id):
                self.assertEqual(
                    MANIFEST["samples"][case_id]["minimax-h3"]["state"]["alt_text"],
                    expected,
                )
                body = figure_html(case_id, "minimax-h3")
                self.assertIn('data-state="generated"', body)
                self.assertIn('<span class="state-tag">ADMITTED</span>', body)
                self.assertIn("<video", body)
                self.assertNotIn("pending admission", body)


if __name__ == "__main__":
    unittest.main()
