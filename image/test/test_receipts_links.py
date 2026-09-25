#!/usr/bin/env python3
"""Lock methodology and data-notice links into receipts/."""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
METHODOLOGY = ROOT / "METHODOLOGY.md"
DATA_NOTICE = ROOT / "DATA_NOTICE.md"
RECEIPTS = (
    "receipts/openai-official-01--codex-image.json",
    "receipts/xai-official-01--codex-image.json",
)


class ReceiptsLinkTests(unittest.TestCase):
    def test_receipt_files_exist(self) -> None:
        for relative in RECEIPTS:
            with self.subTest(relative=relative):
                self.assertTrue((ROOT / relative).is_file(), relative)

    def test_methodology_has_receipts_section(self) -> None:
        text = METHODOLOGY.read_text(encoding="utf-8")
        self.assertIn("## receipts/", text)
        self.assertIn("[`receipts/`](receipts/)", text)
        for relative in RECEIPTS:
            with self.subTest(relative=relative):
                self.assertIn(f"[`{relative}`]({relative})", text)

    def test_data_notice_links_receipts(self) -> None:
        text = DATA_NOTICE.read_text(encoding="utf-8")
        for relative in RECEIPTS:
            with self.subTest(relative=relative):
                self.assertIn(f"[`{relative}`]({relative})", text)


if __name__ == "__main__":
    unittest.main()
