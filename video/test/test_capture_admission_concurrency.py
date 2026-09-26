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
    ("minimax-official-01", "grok-video"),
    ("xai-official-01", "grok-video"),
)
POSTER_SOURCE = "media/minimax-official-01--minimax-h3.poster.webp"
SERVED_MODEL = {
    "kind": "provider-reported",
    "id": "grok-imagine-video-1.5",
    "receipt_field": "model",
}

# ffprobe substitute: exiting 1 makes commandAvailable() report ffprobe as
# unavailable, so admission falls back to operator-provided metadata.
FFPROBE_STUB = "#!/bin/sh\nexit 1\n"


def fake_mp4(tag: bytes) -> bytes:
    return b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2mp41" + b"\x00\x00\x00\x08free" + tag


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
        self.repo = self.workdir / "video"
        ignore = shutil.ignore_patterns(".work", ".git", "__pycache__", "*.pyc")
        shutil.copytree(ROOT, self.repo, ignore=ignore)
        self._inject_admission_delay()
        self.stub_bin = self.workdir / "bin"
        self.stub_bin.mkdir()
        stub = self.stub_bin / "ffprobe"
        stub.write_text(FFPROBE_STUB)
        stub.chmod(0o755)
        self.sources = self.workdir / "sources"
        self.sources.mkdir()
        for index, (case_id, _) in enumerate(PLANNED_CELLS):
            (self.sources / f"{case_id}.mp4").write_bytes(fake_mp4(f"cell-{index}".encode()))
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
        anchor = re.compile(
            r'^(\s*)const manifest = parseManifest\(await readFile\(manifestPath, "utf8"\)\);$',
            re.M,
        )
        assert anchor.search(text), "admitOperation ledger-read anchor not found"
        delay = "\n\\1await new Promise((resolveDelay) => setTimeout(resolveDelay, Number(process.env.CAPTURE_ADMISSION_DELAY_MS || 0)));"
        capture.write_text(anchor.sub(lambda m: m.group(0) + delay.replace("\\1", m.group(1)), text, count=1), encoding="utf-8")

    def _prepare_operation(self, case_id: str, served_model: dict | None = None) -> Path:
        result = self._run("reserve", "--case", case_id, "--route", "grok-video")
        self.assertEqual(result.returncode, 0, result.stderr)
        key = re.search(r"operations/([0-9a-f]{64})", result.stdout).group(1)
        operation = self.repo / ".work" / "operations" / key
        result = self._run(
            "import",
            "--operation",
            str(operation),
            "--file",
            str(self.sources / f"{case_id}.mp4"),
            "--poster",
            str(self.repo / POSTER_SOURCE),
            "--reviewed-on",
            REVIEWED_ON,
            "--width",
            "640",
            "--height",
            "360",
            "--duration-milliseconds",
            "5000",
            "--frame-rate-millihertz",
            "24000",
            "--codec",
            "h264",
            "--audio",
            "absent",
            "--poster-width",
            "672",
            "--poster-height",
            "384",
            "--alt-text",
            f"grok-imagine-video-1.5 admitted output for the {case_id} prompt.",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        evidence = {
            "served_model": served_model if served_model is not None else SERVED_MODEL,
            "cost": {"kind": "paid-route-amount-not-exposed"},
            "completed_at": "2026-09-27T00:00:00.000Z",
        }
        (operation / "provider-evidence.json").write_text(
            f"{json.dumps(evidence, indent=2)}\n", encoding="utf-8"
        )
        return operation

    def _admit(self, operation: Path, env_extra: dict | None = None) -> subprocess.CompletedProcess[str]:
        return self._run("admit", "--operation", str(operation), env_extra=env_extra)

    def _manifest(self) -> dict:
        return json.loads((self.repo / "data" / "comparison.json").read_text(encoding="utf-8"))

    def _assert_cell_projected(self, case_id: str, route_id: str, operation: Path) -> None:
        manifest = self._manifest()
        cell = manifest["samples"][case_id][route_id]["state"]
        self.assertEqual(cell["kind"], "generated", f"{case_id}/{route_id} cell was lost")
        media = self.repo / "media" / f"{case_id}--{route_id}.mp4"
        poster = self.repo / "media" / f"{case_id}--{route_id}.poster.webp"
        receipt = self.repo / "receipts" / f"{case_id}--{route_id}.json"
        for path in (media, poster, receipt):
            self.assertTrue(path.is_file(), f"missing {path}")
        self.assertEqual(sha256_of(media), cell["asset"]["sha256"])
        self.assertEqual(sha256_of(media), sha256_of(self.sources / f"{case_id}.mp4"))
        self.assertEqual(sha256_of(poster), cell["media_facts"]["poster"]["sha256"])
        self.assertEqual(sha256_of(receipt), cell["receipt_sha256"])
        key = operation.name
        receipt_data = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(receipt_data["operation_key"], key)
        self.assertEqual(receipt_data["served_model"]["id"], SERVED_MODEL["id"])
        html = (self.repo / "index.html").read_text(encoding="utf-8")
        block = figure_block(html, case_id, route_id)
        self.assertIn('data-state="generated"', block)
        self.assertIn("ADMITTED", block)
        self.assertIn(f'src="media/{case_id}--{route_id}.mp4"', block)
        state = json.loads((operation / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["phase"], "admitted")

    def test_concurrent_admissions_retain_both_cells(self) -> None:
        publication_lock = self.repo / ".work" / "publication.lock"
        publication_lock.mkdir()
        env_extra = {"CAPTURE_ADMISSION_DELAY_MS": DELAY_MS}
        processes = [
            subprocess.Popen(
                [
                    "node",
                    str(self.repo / "scripts" / "capture.mjs"),
                    "admit",
                    "--operation",
                    str(self.operations[case_id]),
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
        shutil.rmtree(publication_lock)
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
        publication_lock.mkdir()
        busy = self._admit(operations[0], env_extra={"CAPTURE_PUBLICATION_WAIT_MS": "50"})
        self.assertEqual(busy.returncode, 1)
        self.assertIn("gallery publication is already in progress", busy.stderr)
        shutil.rmtree(publication_lock)
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
        operation_lock.mkdir()
        locked = self._admit(operation)
        self.assertEqual(locked.returncode, 1)
        self.assertIn("already being handled by another process", locked.stderr)
        operation_lock.rmdir()
        admitted = self._admit(operation)
        self.assertEqual(admitted.returncode, 0, admitted.stderr or admitted.stdout)
        self.assertFalse(operation_lock.exists())

    def test_failure_inside_publish_releases_locks(self) -> None:
        case_id, route_id = PLANNED_CELLS[0]
        operation = self.operations[case_id]
        evidence_path = operation / "provider-evidence.json"
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        evidence["served_model"] = {
            "kind": "provider-reported",
            "id": "grok-imagine-video-0.0",
            "receipt_field": "model",
        }
        evidence_path.write_text(f"{json.dumps(evidence, indent=2)}\n", encoding="utf-8")
        failed = self._admit(operation)
        self.assertEqual(failed.returncode, 1)
        self.assertIn("exact-model admission", failed.stderr)
        self.assertFalse((self.repo / ".work" / "publication.lock").exists())
        self.assertFalse((operation / ".lock").exists())
        evidence["served_model"] = SERVED_MODEL
        evidence_path.write_text(f"{json.dumps(evidence, indent=2)}\n", encoding="utf-8")
        admitted = self._admit(operation)
        self.assertEqual(admitted.returncode, 0, admitted.stderr or admitted.stdout)
        self._assert_cell_projected(case_id, route_id, operation)


if __name__ == "__main__":
    unittest.main()
