#!/usr/bin/env python3
"""Bind receipt media digests to direct assets or derivative sources."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASE_ID = "minimax-official-01"
ROUTE_ID = "minimax-h3"
STEM = f"{CASE_ID}--{ROUTE_ID}"
SOURCE_SHA256 = "b" * 64


class ReceiptMediaBindingTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix=".receipt-binding-", dir=ROOT)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for directory in ("data", "media", "receipts", "assets", "scripts"):
            shutil.copytree(ROOT / directory, self.root / directory)
        shutil.copy2(ROOT / "index.html", self.root / "index.html")
        self.manifest_path = self.root / "data" / "comparison.json"
        self.receipt_path = self.root / "receipts" / f"{STEM}.json"
        self.manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        self.state = self.manifest["samples"][CASE_ID][ROUTE_ID]["state"]
        self.receipt = json.loads(self.receipt_path.read_text(encoding="utf-8"))

    def write_receipt(self, media_sha256: str) -> None:
        self.receipt["response_media_sha256"] = media_sha256
        receipt_bytes = (json.dumps(self.receipt, indent=2) + "\n").encode("utf-8")
        self.receipt_path.write_bytes(receipt_bytes)
        # Keep the outer digest valid so failures expose the inner media binding.
        self.state["receipt_sha256"] = hashlib.sha256(receipt_bytes).hexdigest()
        self.manifest_path.write_text(
            json.dumps(self.manifest, indent=2) + "\n", encoding="utf-8"
        )

    def use_derivative(self) -> None:
        self.assertNotEqual(SOURCE_SHA256, self.state["asset"]["sha256"])
        self.state["asset"]["provenance"] = {
            "kind": "web-derivative",
            "source_sha256": SOURCE_SHA256,
            "transform": {
                "tool": "fixture-transform",
                "version": "1",
                "arguments": [],
            },
        }

    def validate(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["node", "scripts/validate.mjs", "--mode", "authoring"],
            cwd=self.root,
            text=True,
            capture_output=True,
            check=False,
        )

    def assert_valid(self) -> None:
        result = self.validate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS mode=authoring", result.stdout)

    def assert_media_mismatch(self, message: str) -> None:
        result = self.validate()
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 1, combined)
        self.assertIn(f"{STEM}.json.response_media_sha256", combined)
        self.assertIn(message, combined)
        self.assertNotIn("receipt-hash", combined)

    def test_valid_direct_receipt_matches_public_asset(self) -> None:
        self.write_receipt(self.state["asset"]["sha256"])
        self.assert_valid()

    def test_direct_receipt_rejects_rehashed_media_mismatch(self) -> None:
        self.write_receipt("a" * 64)
        self.assert_media_mismatch("does not match public asset hash")

    def test_valid_derivative_receipt_matches_source(self) -> None:
        self.use_derivative()
        self.write_receipt(SOURCE_SHA256)
        self.assert_valid()

    def test_derivative_receipt_rejects_rehashed_media_mismatch(self) -> None:
        self.use_derivative()
        for digest in ("a" * 64, self.state["asset"]["sha256"]):
            with self.subTest(media_sha256=digest):
                self.write_receipt(digest)
                self.assert_media_mismatch("does not match derivative source hash")

    def test_admission_receipt_tracks_asset_provenance(self) -> None:
        for derivative in (False, True):
            with self.subTest(derivative=derivative):
                operation = self.root / ".work" / str(derivative)
                operation.mkdir(parents=True)
                shutil.copy2(self.root / "media" / f"{STEM}.mp4", operation / "raw.mp4")
                shutil.copy2(
                    self.root / "media" / f"{STEM}.poster.webp", operation / "poster.webp"
                )
                request = {
                    "repository": self.manifest["repository"],
                    "media_kind": self.manifest["media_kind"],
                    "case_id": CASE_ID,
                    "route_id": ROUTE_ID,
                    "prompt_sha256": self.manifest["cases"][CASE_ID]["prompt"]["sha256"],
                    "prompt": self.manifest["cases"][CASE_ID]["prompt"]["text"],
                    "requested_model": self.manifest["routes"][ROUTE_ID]["requested_model"]["id"],
                    "parameters": self.manifest["samples"][CASE_ID][ROUTE_ID]["parameters"],
                }
                state = {
                    "phase": "downloaded",
                    "operation_key": self.receipt["operation_key"],
                    "request_sha256": self.receipt["request_sha256"],
                    "created_at": self.receipt["started_at"],
                    "raw_sha256": self.state["asset"]["sha256"],
                    "file": "raw.mp4",
                    "content_type": "video/mp4",
                }
                metadata = {
                    "reviewed_on": self.state["admission"]["nonblank_review"]["reviewed_on"],
                }
                if derivative:
                    metadata.update({
                        "source_sha256": SOURCE_SHA256,
                        "transform_tool": "fixture-transform",
                        "transform_version": "1",
                        "transform_arguments": [],
                    })
                for name, data in (
                    ("request.json", request),
                    ("state.json", state),
                    ("admission.json", metadata),
                ):
                    (operation / name).write_text(json.dumps(data), encoding="utf-8")
                result = subprocess.run(
                    [
                        "node", "--input-type=module", "-e",
                        'import { admitOperation } from "./scripts/capture.mjs"; '
                        'await admitOperation(process.argv[1], process.cwd());',
                        str(operation),
                    ],
                    cwd=self.root,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
                generated = manifest["samples"][CASE_ID][ROUTE_ID]["state"]
                receipt_bytes = self.receipt_path.read_bytes()
                receipt = json.loads(receipt_bytes)
                expected = SOURCE_SHA256 if derivative else generated["asset"]["sha256"]
                self.assertEqual(receipt["response_media_sha256"], expected)
                if derivative:
                    self.assertNotEqual(expected, generated["asset"]["sha256"])
                    self.assertEqual(generated["asset"]["provenance"]["source_sha256"], expected)
                self.assertEqual(
                    generated["receipt_sha256"], hashlib.sha256(receipt_bytes).hexdigest()
                )
                self.assert_valid()


if __name__ == "__main__":
    unittest.main()
