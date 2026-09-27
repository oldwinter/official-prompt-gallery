#!/usr/bin/env python3
"""Admission must serialize shared manifest/HTML updates across operations."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REVIEWED_ON = "2026-09-27"
DELAY_MS = "600"
PLANNED_CELLS = (
    ("openai-official-01", "grok-image"),
    ("xai-official-01", "grok-image"),
)
SOURCE_MEDIA = {
    "openai-official-01": "media/openai-official-01--codex-image.webp",
    "xai-official-01": "media/xai-official-01--codex-image.webp",
}
SERVED_MODEL = {
    "kind": "provider-reported",
    "id": "grok-imagine-image-2.0",
    "receipt_field": "model",
}

# ImageMagick substitute: admits need `magick|identify -format "%m %w %h" FILE`
# and `-version`. Parse the WebP header directly so results stay honest.
IDENTIFY_STUB = """#!/usr/bin/env python3
import sys

args = sys.argv[1:]
if args[:1] == ["identify"]:
    args = args[1:]
if args[:1] == ["-version"]:
    sys.stdout.write("Version: ImageMagick 7.1.2-0 stub\\n")
    sys.exit(0)
if args[:2] == ["-format", "%m %w %h"]:
    data = open(args[-1], "rb").read(64)
    width = height = 0
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        chunk = data[12:16]
        if chunk == b"VP8X":
            width = 1 + int.from_bytes(data[24:27], "little")
            height = 1 + int.from_bytes(data[27:30], "little")
        elif chunk == b"VP8L":
            bits = int.from_bytes(data[21:25], "little")
            width = 1 + (bits & 0x3FFF)
            height = 1 + ((bits >> 14) & 0x3FFF)
        elif chunk == b"VP8 ":
            width = int.from_bytes(data[26:28], "little") & 0x3FFF
            height = int.from_bytes(data[28:30], "little") & 0x3FFF
    if width and height:
        sys.stdout.write(f"WEBP {width} {height}\\n")
        sys.exit(0)
sys.exit(1)
"""


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def figure_block(html: str, case_id: str, route_id: str) -> str:
    match = re.search(
        rf'<figure\b[^>]*data-case-id="{case_id}"[^>]*data-route-id="{route_id}"[^>]*>[\s\S]*?</figure>',
        html,
        re.I,
    )
    assert match is not None, f"missing figure {case_id}/{route_id}"
    return match.group(0)


class AdmissionConcurrencyTests(unittest.TestCase):
    def setUp(self) -> None:
        # resolve(): node compares import.meta.url (realpath) to argv paths.
        self.workdir = Path(tempfile.mkdtemp(prefix="admission-concurrency-")).resolve()
        self.repo = self.workdir / "image"
        ignore = shutil.ignore_patterns(".work", ".git", "__pycache__", "*.pyc")
        shutil.copytree(ROOT, self.repo, ignore=ignore)
        self._inject_admission_delay()
        self.stub_bin = self.workdir / "bin"
        self.stub_bin.mkdir()
        for name in ("magick", "identify"):
            stub = self.stub_bin / name
            stub.write_text(IDENTIFY_STUB)
            stub.chmod(0o755)
        self.operations = {
            case_id: self._prepare_operation(case_id)
            for case_id, _ in PLANNED_CELLS
        }

    def tearDown(self) -> None:
        shutil.rmtree(self.workdir, ignore_errors=True)

    def _env(self, **extra: str) -> dict:
        env = dict(os.environ)
        env["PATH"] = f"{self.stub_bin}{os.pathsep}{env['PATH']}"
        env.update(extra)
        return env

    def _run(self, *args: str, env_extra: dict | None = None, timeout: int = 60) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["node", str(self.repo / "scripts" / "capture.mjs"), *args],
            cwd=self.repo,
            env=self._env(**(env_extra or {})),
            text=True,
            capture_output=True,
            timeout=timeout,
        )

    def _validate(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["node", str(self.repo / "scripts" / "validate.mjs"), "--mode", "authoring"],
            cwd=self.repo,
            env=self._env(),
            text=True,
            capture_output=True,
            timeout=60,
        )

    def _inject_admission_delay(self) -> None:
        capture = self.repo / "scripts" / "capture.mjs"
        text = capture.read_text(encoding="utf-8")
        anchor = "const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));"
        assert anchor in text, "updateManifest ledger-read anchor not found"
        delay = (
            "\n  await new Promise((resolveDelay) => "
            "setTimeout(resolveDelay, Number(process.env.CAPTURE_ADMISSION_DELAY_MS || 0)));"
        )
        capture.write_text(text.replace(anchor, f"{anchor}{delay}", 1), encoding="utf-8")

    def _prepare_operation(self, case_id: str, served_model: dict | None = None) -> Path:
        result = self._run("reserve", "--case", case_id, "--route", "grok-image")
        self.assertEqual(result.returncode, 0, result.stderr)
        key = json.loads(result.stdout)["operation_key"]
        operation = self.repo / ".work" / "operations" / key
        result = self._run(
            "import",
            "--operation",
            str(operation),
            "--file",
            str(self.repo / SOURCE_MEDIA[case_id]),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        state_path = operation / "state.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["served_model"] = served_model if served_model is not None else SERVED_MODEL
        state_path.write_text(f"{json.dumps(state, indent=2)}\n", encoding="utf-8")
        return operation

    def _admit(self, operation: Path, env_extra: dict | None = None) -> subprocess.CompletedProcess[str]:
        return self._run(
            "admit",
            "--operation",
            str(operation),
            "--reviewed-on",
            REVIEWED_ON,
            env_extra=env_extra,
        )

    def _manifest(self) -> dict:
        return json.loads((self.repo / "data" / "comparison.json").read_text(encoding="utf-8"))

    def _assert_cell_projected(self, case_id: str, route_id: str, operation: Path) -> None:
        manifest = self._manifest()
        cell = manifest["samples"][case_id][route_id]
        self.assertEqual(cell["state"]["kind"], "generated", f"{case_id}/{route_id} cell was lost")
        media = self.repo / "media" / f"{case_id}--{route_id}.webp"
        receipt = self.repo / "receipts" / f"{case_id}--{route_id}.json"
        self.assertTrue(media.is_file(), f"missing {media}")
        self.assertTrue(receipt.is_file(), f"missing {receipt}")
        self.assertEqual(sha256_of(media), cell["asset"]["sha256"])
        self.assertEqual(sha256_of(media), sha256_of(self.repo / SOURCE_MEDIA[case_id]))
        self.assertEqual(sha256_of(receipt), cell["receipt_sha256"])
        key = operation.name
        receipt_data = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(receipt_data["operation_key"], key)
        self.assertEqual(receipt_data["request_sha256"], cell["state"]["request_sha256"])
        html = (self.repo / "index.html").read_text(encoding="utf-8")
        block = figure_block(html, case_id, route_id)
        self.assertIn('data-state="generated"', block)
        self.assertIn("ADMITTED", block)
        self.assertIn(f'href="media/{case_id}--{route_id}.webp"', block)
        state = json.loads((operation / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["phase"], "admitted")

    def test_concurrent_admissions_retain_both_cells(self) -> None:
        publication_lock = self.repo / ".work" / "publication.lock"
        publication_lock.write_text(f"{os.getpid()}\n", encoding="utf-8")
        env_extra = {"CAPTURE_ADMISSION_DELAY_MS": DELAY_MS}
        processes = [
            subprocess.Popen(
                [
                    "node",
                    str(self.repo / "scripts" / "capture.mjs"),
                    "admit",
                    "--operation",
                    str(self.operations[case_id]),
                    "--reviewed-on",
                    REVIEWED_ON,
                ],
                cwd=self.repo,
                env=self._env(**env_extra),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            for case_id, _ in PLANNED_CELLS
        ]
        time.sleep(1.5)
        publication_lock.unlink()
        results = [process.communicate(timeout=120) for process in processes]
        for (case_id, _), process, (stdout, stderr) in zip(PLANNED_CELLS, processes, results):
            self.assertEqual(process.returncode, 0, f"{case_id}: {stderr or stdout}")
        for case_id, route_id in PLANNED_CELLS:
            self._assert_cell_projected(case_id, route_id, self.operations[case_id])
        validated = self._validate()
        self.assertEqual(validated.returncode, 0, validated.stderr or validated.stdout)
        self.assertFalse(publication_lock.exists())
        for operation in self.operations.values():
            self.assertFalse((operation / ".lock").exists())

    def test_busy_publication_retry_keeps_both_cells(self) -> None:
        operations = list(self.operations.values())
        publication_lock = self.repo / ".work" / "publication.lock"
        publication_lock.write_text(f"{os.getpid()}\n", encoding="utf-8")
        busy = self._admit(operations[0], env_extra={"CAPTURE_PUBLICATION_WAIT_MS": "50"})
        self.assertEqual(busy.returncode, 1)
        self.assertIn("gallery publication is already in progress", busy.stderr)
        publication_lock.unlink()
        for operation in operations:
            admitted = self._admit(operation)
            self.assertEqual(admitted.returncode, 0, admitted.stderr or admitted.stdout)
        for case_id, route_id in PLANNED_CELLS:
            self._assert_cell_projected(case_id, route_id, self.operations[case_id])
        validated = self._validate()
        self.assertEqual(validated.returncode, 0, validated.stderr or validated.stdout)

    def test_operation_lock_excludes_same_operation(self) -> None:
        operation = next(iter(self.operations.values()))
        operation_lock = operation / ".lock"
        operation_lock.write_text(f"{os.getpid()}\n", encoding="utf-8")
        locked = self._admit(operation)
        self.assertEqual(locked.returncode, 1)
        self.assertIn("already being handled by another process", locked.stderr)
        operation_lock.unlink()
        admitted = self._admit(operation)
        self.assertEqual(admitted.returncode, 0, admitted.stderr or admitted.stdout)
        self.assertFalse(operation_lock.exists())

    def test_failure_inside_publish_releases_locks(self) -> None:
        case_id, route_id = PLANNED_CELLS[0]
        operation = self.operations[case_id]
        state_path = operation / "state.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["served_model"] = {
            "kind": "provider-reported",
            "id": "grok-imagine-image-0.0",
            "receipt_field": "model",
        }
        state_path.write_text(f"{json.dumps(state, indent=2)}\n", encoding="utf-8")
        failed = self._admit(operation)
        self.assertEqual(failed.returncode, 1)
        self.assertIn("exact-model admission", failed.stderr)
        self.assertFalse((self.repo / ".work" / "publication.lock").exists())
        self.assertFalse((operation / ".lock").exists())
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["served_model"] = SERVED_MODEL
        state_path.write_text(f"{json.dumps(state, indent=2)}\n", encoding="utf-8")
        admitted = self._admit(operation)
        self.assertEqual(admitted.returncode, 0, admitted.stderr or admitted.stdout)
        self._assert_cell_projected(case_id, route_id, operation)


if __name__ == "__main__":
    unittest.main()
