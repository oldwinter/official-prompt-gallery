#!/usr/bin/env python3
"""Admission retries reuse published evidence after interrupted HTML projection."""

from __future__ import annotations

import base64
import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASE = "openai-official-01"
ROUTE = "grok-image"

# Inject failures at atomic publication boundaries; provider calls and decodes
# during recovery are forbidden. Initial decoding is stubbed for offline CI.
RUNNER = r"""
import { promises as fs } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
const [operation, fault, retry, dryRun] = process.argv.slice(2);
globalThis.fetch = async () => {
  await fs.writeFile('unexpected-provider-call', 'called');
  throw new Error('provider calls are forbidden');
};
childProcess.execFile = () => { throw new Error('unexpected unpromisified decode'); };
childProcess.execFile[promisify.custom] = async (command, args) => {
  if (retry === 'retry') {
    await fs.writeFile('unexpected-decode', command);
    throw new Error('unexpected decode');
  }
  if (args.at(-1)?.startsWith('webp:')) {
    await fs.copyFile('media/openai-official-01--codex-image.webp', args.at(-1).slice(5));
  }
  return { stdout: args.includes('-version') ? 'ImageMagick fixture-1.0' : 'WEBP 1313 1198', stderr: '' };
};
syncBuiltinESMExports();
const rename = fs.rename;
fs.rename = async (source, destination) => {
  const manifest = destination.endsWith('/data/comparison.json');
  const html = destination.endsWith('/index.html');
  if (html && fault === 'before-html') throw new Error('injected before-html');
  await rename(source, destination);
  if ((manifest && fault === 'after-manifest') || (html && fault === 'after-html')) {
    throw new Error(`injected ${fault}`);
  }
};
const { admitOperation } = await import('./scripts/capture.mjs');
try {
  const state = await admitOperation(operation, process.cwd(), { reviewedOn: '2026-08-30', dryRun: dryRun === 'dry-run' });
  console.log(JSON.stringify(state));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
"""


class CaptureAdmissionRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory(prefix="image-admission-recovery-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name).resolve() / "image"
        shutil.copytree(ROOT, self.root, ignore=shutil.ignore_patterns(".work", "__pycache__"))
        (self.root / "admit-test.mjs").write_text(RUNNER, encoding="utf-8")
        reserved = self.run_node("scripts/capture.mjs", "reserve", "--case", CASE, "--route", ROUTE)
        self.assert_success(reserved)
        key = json.loads(reserved.stdout)["operation_key"]
        self.operation = self.root / ".work" / "operations" / key
        self.state_path = self.operation / "state.json"
        imported = self.run_node(
            "scripts/capture.mjs", "import", "--operation", str(self.operation),
            "--file", f"media/{CASE}--codex-image.webp",
        )
        self.assert_success(imported)
        state = self.read_json(self.state_path)
        state["served_model"] = {
            "kind": "provider-reported", "id": "grok-imagine-image-2.0", "receipt_field": "model",
        }
        self.write_json(self.state_path, state)
        self.manifest_path = self.root / "data" / "comparison.json"
        self.media_path = self.root / "media" / f"{CASE}--{ROUTE}.webp"
        self.receipt_path = self.root / "receipts" / f"{CASE}--{ROUTE}.json"

    @staticmethod
    def read_json(path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def write_json(path: Path, value: dict) -> None:
        path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

    def run_node(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["node", *args], cwd=self.root, text=True, capture_output=True, check=False, timeout=20,
        )

    def assert_success(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def admit(self, fault: str = "none", retry: bool = False, dry_run: bool = False) -> subprocess.CompletedProcess[str]:
        return self.run_node(
            "admit-test.mjs", str(self.operation), fault, "retry" if retry else "initial",
            "dry-run" if dry_run else "write",
        )

    def public_evidence(self) -> dict:
        return {
            path.name: (path.read_bytes(), path.stat().st_mtime_ns) if path.exists() else None
            for path in (self.manifest_path, self.media_path, self.receipt_path)
        }

    def interrupt(self, fault: str = "after-manifest") -> None:
        failed = self.admit(fault)
        self.assertEqual(failed.returncode, 1)
        self.assertIn(f"injected {fault}", failed.stderr)
        self.assertEqual(self.read_json(self.state_path)["phase"], "downloaded")

    def check_recovery(self, fault: str) -> None:
        self.interrupt(fault)
        self.finish_recovery()

    def finish_recovery(self) -> None:
        evidence = self.public_evidence()
        original_html = self.root / "index.html"
        html_before = (original_html.read_bytes(), original_html.stat().st_mtime_ns)
        # Recovery must depend on verified public evidence, not on regeneration
        # or the continued availability of private raw files.
        shutil.rmtree(self.operation / "raw")
        self.assert_success(self.admit(retry=True))
        self.assertEqual(self.public_evidence(), evidence)
        if html_before[0] == original_html.read_bytes():
            self.assertEqual(original_html.stat().st_mtime_ns, html_before[1])
        self.assertEqual(self.read_json(self.state_path)["phase"], "admitted")
        self.assertEqual(self.read_json(self.state_path)["completed_at"], self.read_json(self.receipt_path)["completed_at"])
        html = (self.root / "index.html").read_bytes()
        state = self.state_path.read_bytes()
        self.assert_success(self.admit(retry=True))
        self.assertEqual(self.public_evidence(), evidence)
        self.assertEqual((self.root / "index.html").read_bytes(), html)
        self.assertEqual(self.state_path.read_bytes(), state)
        self.assertFalse((self.root / "unexpected-provider-call").exists())
        self.assertFalse((self.root / "unexpected-decode").exists())
        self.assert_success(self.run_node("scripts/validate.mjs", "--mode", "authoring"))

    def test_retry_after_manifest_publication(self) -> None:
        self.check_recovery("after-manifest")

    def test_retry_before_html_publication(self) -> None:
        self.check_recovery("before-html")

    def test_retry_after_html_publication(self) -> None:
        self.check_recovery("after-html")

    def test_normal_admission_is_idempotent(self) -> None:
        self.assert_success(self.admit())
        self.finish_recovery()

    def test_legacy_admitted_state_with_planned_html(self) -> None:
        self.interrupt("before-html")
        state = self.read_json(self.state_path)
        state["phase"] = "admitted"
        state["completed_at"] = self.read_json(self.receipt_path)["completed_at"]
        del state["public_receipt_sha256"]
        self.write_json(self.state_path, state)
        self.finish_recovery()

    def test_legacy_downloaded_state_without_promotion_hashes(self) -> None:
        self.interrupt()
        state = self.read_json(self.state_path)
        state = {key: value for key, value in state.items() if not key.startswith("public_")}
        self.write_json(self.state_path, state)
        self.finish_recovery()

    def test_derivative_recovery_keeps_source_provenance(self) -> None:
        source = self.root / "source.png"
        source.write_bytes(base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII="
        ))
        self.assert_success(self.run_node(
            "scripts/capture.mjs", "import", "--operation", str(self.operation), "--file", str(source),
        ))
        self.interrupt()
        cell = self.read_json(self.manifest_path)["samples"][CASE][ROUTE]
        self.assertEqual(cell["asset"]["provenance"]["source_sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertNotEqual(cell["asset"]["sha256"], cell["asset"]["provenance"]["source_sha256"])
        self.finish_recovery()

    def test_dry_run_and_repeated_failure_preserve_evidence(self) -> None:
        self.interrupt()
        evidence = self.public_evidence()
        state = self.state_path.read_bytes()
        html = (self.root / "index.html").read_bytes()
        self.assert_success(self.admit(retry=True, dry_run=True))
        failed = self.admit("before-html", retry=True)
        self.assertEqual(failed.returncode, 1)
        self.assertIn("injected before-html", failed.stderr)
        self.assertEqual(self.public_evidence(), evidence)
        self.assertEqual(self.state_path.read_bytes(), state)
        self.assertEqual((self.root / "index.html").read_bytes(), html)
        self.finish_recovery()

    def assert_conflict_preserved(self) -> None:
        evidence = self.public_evidence()
        state = self.state_path.read_bytes()
        html = (self.root / "index.html").read_bytes()
        failed = self.admit(retry=True)
        self.assertEqual(failed.returncode, 1, failed.stdout)
        self.assertEqual(self.public_evidence(), evidence)
        self.assertEqual(self.state_path.read_bytes(), state)
        self.assertEqual((self.root / "index.html").read_bytes(), html)
        self.assertFalse((self.root / "unexpected-provider-call").exists())
        self.assertFalse((self.root / "unexpected-decode").exists())

    def test_conflicting_or_missing_public_bytes_are_not_overwritten(self) -> None:
        self.interrupt()
        for path in (self.media_path, self.receipt_path):
            original = path.read_bytes()
            for missing in (False, True):
                with self.subTest(file=path.name, missing=missing):
                    if missing:
                        path.unlink()
                    else:
                        path.write_bytes(original + b"changed")
                    self.assert_conflict_preserved()
                    path.write_bytes(original)

    def test_conflicting_private_identity_and_hashes_are_not_overwritten(self) -> None:
        self.interrupt()
        original = self.state_path.read_bytes()
        for field in ("operation_key", "request_sha256", "raw_sha256", "public_sha256", "public_receipt_sha256"):
            with self.subTest(field=field):
                state = self.read_json(self.state_path)
                state[field] = "0" * 64
                self.write_json(self.state_path, state)
                self.assert_conflict_preserved()
                self.state_path.write_bytes(original)

    def test_legacy_receipt_identity_is_checked_even_if_public_hash_matches(self) -> None:
        self.interrupt()
        state = self.read_json(self.state_path)
        del state["public_receipt_sha256"]
        self.write_json(self.state_path, state)
        receipt = self.read_json(self.receipt_path)
        receipt["operation_key"] = "0" * 64
        self.write_json(self.receipt_path, receipt)
        manifest = self.read_json(self.manifest_path)
        manifest["samples"][CASE][ROUTE]["receipt_sha256"] = hashlib.sha256(self.receipt_path.read_bytes()).hexdigest()
        self.write_json(self.manifest_path, manifest)
        self.assert_conflict_preserved()

    def test_changed_canonical_request_is_rejected(self) -> None:
        self.interrupt()
        manifest = self.read_json(self.manifest_path)
        manifest["samples"][CASE][ROUTE]["parameters"]["quality"]["value"] = "high"
        self.write_json(self.manifest_path, manifest)
        self.assert_conflict_preserved()

    def test_generated_html_marker_alone_does_not_complete_admission(self) -> None:
        self.interrupt()
        html_path = self.root / "index.html"
        html_path.write_text(html_path.read_text(encoding="utf-8").replace(
            f'data-case-id="{CASE}" data-route-id="{ROUTE}" data-state="planned"',
            f'data-case-id="{CASE}" data-route-id="{ROUTE}" data-state="generated"',
        ), encoding="utf-8")
        self.assert_conflict_preserved()


if __name__ == "__main__":
    unittest.main()
