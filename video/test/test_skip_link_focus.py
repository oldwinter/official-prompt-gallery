#!/usr/bin/env python3
"""Lock the evidence-sheet skip-link to its comparison target."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "index.html"
CSS = ROOT / "assets/site.css"


class SkipLinkFocusTests(unittest.TestCase):
    def test_skip_link_is_first_focusable_and_targets_existing_anchor(self) -> None:
        html = HTML.read_text(encoding="utf-8")
        css = CSS.read_text(encoding="utf-8")
        body = html[html.find("<body>") :]
        first = re.search(r"<(?:a|button|input|select|textarea)\b[^>]*>", body)
        self.assertIsNotNone(first)
        self.assertIn('class="skip-link"', first.group(0))
        self.assertIn('href="#comparison"', first.group(0))
        self.assertIn('id="comparison"', html)
        self.assertRegex(css, r"\.skip-link:focus\s*\{[^}]*translateY\(0\)")
        self.assertIn("a:focus-visible", css)


if __name__ == "__main__":
    unittest.main()
