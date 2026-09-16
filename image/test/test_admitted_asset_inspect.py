#!/usr/bin/env python3
"""Lock admitted image links to Inspect without leaving the evidence page."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
INSPECTOR = (ROOT / "assets" / "image-inspector.js").read_text(encoding="utf-8")


class AdmittedAssetInspectTests(unittest.TestCase):
    def test_admitted_cells_keep_href(self) -> None:
        for case_id, route_id in (
            ("openai-official-01", "codex-image"),
            ("xai-official-01", "codex-image"),
        ):
            with self.subTest(case_id=case_id):
                match = re.search(
                    rf'<figure\b[^>]*data-case-id="{case_id}"[^>]*data-route-id="{route_id}"[^>]*>[\s\S]*?</figure>',
                    HTML,
                    re.I,
                )
                self.assertIsNotNone(match)
                body = match.group(0)
                self.assertIn('data-state="generated"', body)
                self.assertRegex(body, r'<a class="asset-link" href="media/[^"]+\.webp"')

    def test_planned_cells_are_not_file_links(self) -> None:
        for case_id in ("openai-official-01", "xai-official-01"):
            with self.subTest(case_id=case_id):
                match = re.search(
                    rf'<figure\b[^>]*data-case-id="{case_id}"[^>]*data-route-id="grok-image"[^>]*>[\s\S]*?</figure>',
                    HTML,
                    re.I,
                )
                self.assertIsNotNone(match)
                body = match.group(0)
                self.assertIn('data-state="planned"', body)
                self.assertNotRegex(body, r'<a class="asset-link"')
                self.assertIn('class="asset-link"', body)

    def test_inspector_binds_plain_left_click_on_admitted_links(self) -> None:
        self.assertIn("a.asset-link[href]", INSPECTOR)
        self.assertIn("entry.record.state === 'generated'", INSPECTOR)
        self.assertIn("event.metaKey", INSPECTOR)
        self.assertIn("event.ctrlKey", INSPECTOR)
        self.assertIn("event.shiftKey", INSPECTOR)
        self.assertIn("event.altKey", INSPECTOR)
        self.assertIn("open(entry.record, assetLink)", INSPECTOR)


if __name__ == "__main__":
    unittest.main()
