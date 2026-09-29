#!/usr/bin/env python3
"""Exercise reconciliation through the offline capture CLI."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OFFLINE_STUB = """
import fs from 'node:fs/promises';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const { readFile, copyFile, rm, writeFile, access } = fs;
globalThis.fetch = async (url, options = {}) => {
  console.error(`MOCK_FETCH ${options.method || 'GET'} ${url}`);
  throw new Error('network disabled by reconciliation test');
};
async function pause(stage) {
  if (process.env.CAPTURE_TEST_PAUSE !== stage) return;
  await writeFile(process.env.CAPTURE_TEST_READY, 'ready');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await access(process.env.CAPTURE_TEST_CONTINUE);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('test did not release paused reconciliation');
}
fs.readFile = async (file, ...args) => {
  if (String(file) === process.env.CAPTURE_TEST_SOURCE) await pause('import');
  return readFile(file, ...args);
};
fs.copyFile = async (source, ...args) => {
  if (String(source) === process.env.CAPTURE_TEST_SOURCE) await pause('import');
  return copyFile(source, ...args);
};
fs.rm = async (file, ...args) => {
  const result = await rm(file, ...args);
  if (basename(String(file)) === '.lock') await pause('unlock');
  return result;
};
syncBuiltinESMExports();
"""


class CaptureReconcileTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix=".capture-test-", dir=ROOT)
        self.addCleanup(temporary.cleanup)
        self.gallery = Path(temporary.name)
        for name in ("scripts", "data"):
            shutil.copytree(ROOT / name, self.gallery / name)
        self.stub = self.gallery / "offline.mjs"
        self.stub.write_text(OFFLINE_STUB, encoding="utf-8")
        self.env = {
            **os.environ,
            "NODE_OPTIONS": "",
            "GROK_BASE_URL": "https://capture.invalid",
            "GROK_API_KEY": "synthetic-test-key",
            "CAPTURE_LOCK_STALE_MS": "21600000",
            "CAPTURE_POLL_LIMIT": "1",
            "CAPTURE_POLL_DELAY_MS": "0",
        }
        self.case = "minimax-official-01"
        self.route = "grok-video"
        reserved = self.capture("reserve", "--case", self.case, "--route", self.route)
        self.assertEqual(reserved.returncode, 0, reserved.stderr)
        self.operation = next((self.gallery / ".work/operations").iterdir())
        self.state_path = self.operation / "state.json"
        self.reserved_state = json.loads(self.state_path.read_text(encoding="utf-8"))
        evidence = self.operation / "provider-evidence.json"
        evidence.write_text('{"recovered_response": "keep for reconciliation"}\n', encoding="utf-8")
        self.recovery_evidence = {
            file: file.read_bytes() for file in self.operation.glob("*.json")
            if file != self.state_path
        }
        self.source = self.gallery / "source.mp4"
        shutil.copyfile(ROOT / "media/minimax-official-01--minimax-h3.mp4", self.source)
        self.poster = self.gallery / "source.webp"
        shutil.copyfile(ROOT / "assets/planned-video.webp", self.poster)

    def seed(self, phase: str) -> None:
        state = {**self.reserved_state, "phase": phase, "reason": "response lost after submission"}
        self.state_path.write_text(json.dumps(state), encoding="utf-8")
        self.original_state = self.state_path.read_bytes()

    def command(self, *args: str) -> list[str]:
        return ["node", "--import", str(self.stub), "scripts/capture.mjs", *args]

    def capture(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            self.command(*args),
            cwd=self.gallery, env=self.env, text=True, capture_output=True,
            check=False, timeout=15,
        )

    def reconcile(self, *args: str) -> subprocess.CompletedProcess[str]:
        return self.capture("reconcile", "--operation", str(self.operation), *args)

    def rerun(self) -> subprocess.CompletedProcess[str]:
        return self.capture("run", "--case", self.case, "--route", self.route)

    def assert_held(self, result: subprocess.CompletedProcess[str], error: str) -> None:
        self.assertEqual(result.returncode, 1)
        self.assertIn(error, result.stderr)
        self.assertNotIn("MOCK_FETCH", result.stderr)
        self.assertFalse((self.operation / ".lock").exists())
        with self.subTest("preserve recovery state"):
            self.assertEqual(self.state_path.read_bytes(), self.original_state)
        for file, contents in self.recovery_evidence.items():
            self.assertEqual(file.read_bytes(), contents)
        rerun = self.rerun()
        self.assertNotIn("MOCK_FETCH", rerun.stderr)
        self.assertEqual(rerun.returncode, 1)
        self.assertIn("ambiguous", rerun.stderr)
        self.assertEqual(self.state_path.read_bytes(), self.original_state)

    @contextmanager
    def paused_reconcile(self, stage: str):
        ready = self.gallery / "ready"
        resume = self.gallery / "continue"
        ready.unlink(missing_ok=True)
        resume.unlink(missing_ok=True)
        process = subprocess.Popen(
            self.command("reconcile", "--operation", str(self.operation), "--file", str(self.source)),
            cwd=self.gallery, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={
                **self.env, "CAPTURE_TEST_PAUSE": stage,
                "CAPTURE_TEST_SOURCE": str(self.source),
                "CAPTURE_TEST_READY": str(ready),
                "CAPTURE_TEST_CONTINUE": str(resume),
            },
        )
        try:
            deadline = time.monotonic() + 5
            while not ready.exists():
                if process.poll() is not None:
                    stdout, stderr = process.communicate()
                    self.fail(f"reconciliation exited before {stage}: {stdout} {stderr}")
                if time.monotonic() >= deadline:
                    self.fail(f"reconciliation did not reach {stage}")
                time.sleep(0.01)
            yield
        finally:
            resume.touch()
            try:
                stdout, stderr = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise
        self.assertEqual(process.returncode, 0, stderr)
        self.assertNotIn("MOCK_FETCH", stderr)

    def test_missing_file_preserves_uncertain_state_and_blocks_submit(self) -> None:
        for phase in ("ambiguous", "submitting"):
            with self.subTest(phase=phase):
                self.seed(phase)
                result = self.reconcile("--file", str(self.gallery / "does-not-exist"))
                self.assert_held(result, "ENOENT")

    def test_invalid_file_preserves_uncertain_state_and_blocks_submit(self) -> None:
        directory = self.gallery / "directory.mp4"
        directory.mkdir()
        symlink = self.gallery / "symlink.mp4"
        symlink.symlink_to(self.source)
        for phase in ("ambiguous", "submitting"):
            for invalid in (directory, symlink):
                with self.subTest(phase=phase, source=invalid.name):
                    self.seed(phase)
                    result = self.reconcile("--file", str(invalid))
                    self.assert_held(result, "regular non-symlink file")

    def test_oversized_source_preserves_uncertain_state(self) -> None:
        oversized = self.gallery / "oversized.mp4"
        with oversized.open("wb") as stream:
            stream.write(b"\x00\x00\x00\x0cftypisom")
            stream.truncate(25 * 1024 * 1024 + 1)
        for phase in ("ambiguous", "submitting"):
            with self.subTest(phase=phase):
                self.seed(phase)
                self.assert_held(self.reconcile("--file", str(oversized)), "strictly smaller than 25 MiB")

    def test_webm_source_preserves_uncertain_state(self) -> None:
        webm = self.gallery / "input.webm"
        webm.write_bytes(b"\x1aE\xdf\xa3webm-fixture")
        for phase in ("ambiguous", "submitting"):
            with self.subTest(phase=phase):
                self.seed(phase)
                self.assert_held(self.reconcile("--file", str(webm)), "MP4")

    def test_poster_failure_preserves_uncertain_state_and_blocks_submit(self) -> None:
        directory = self.gallery / "directory.webp"
        directory.mkdir()
        for phase in ("ambiguous", "submitting"):
            for poster, error in (
                (self.gallery / "missing.webp", "ENOENT"),
                (directory, "regular non-symlink file"),
            ):
                with self.subTest(phase=phase, poster=poster.name):
                    self.seed(phase)
                    result = self.reconcile("--file", str(self.source), "--poster", str(poster))
                    self.assert_held(result, error)

    def test_poster_copy_failure_preserves_uncertain_state(self) -> None:
        (self.operation / "poster.webp").mkdir()
        for phase in ("ambiguous", "submitting"):
            with self.subTest(phase=phase):
                self.seed(phase)
                result = self.reconcile("--file", str(self.source), "--poster", str(self.poster))
                self.assert_held(result, "EISDIR")

    def test_metadata_failure_preserves_uncertain_state(self) -> None:
        (self.operation / "admission.json").mkdir()
        for phase in ("ambiguous", "submitting"):
            with self.subTest(phase=phase):
                self.seed(phase)
                result = self.reconcile("--file", str(self.source), "--poster", str(self.poster))
                self.assert_held(result, "admission.json")

    def test_successful_import_commits_downloaded_and_blocks_submit(self) -> None:
        for phase in ("ambiguous", "submitting"):
            with self.subTest(phase=phase):
                self.seed(phase)
                result = self.reconcile("--file", str(self.source), "--poster", str(self.poster))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("MOCK_FETCH", result.stderr)
                state = json.loads(self.state_path.read_text(encoding="utf-8"))
                self.assertEqual(state["phase"], "downloaded")
                self.assertEqual(state["operation_key"], self.reserved_state["operation_key"])
                self.assertEqual(state["request_sha256"], self.reserved_state["request_sha256"])
                source = self.source.read_bytes()
                self.assertEqual((self.operation / state["file"]).read_bytes(), source)
                self.assertEqual(state["raw_sha256"], hashlib.sha256(source).hexdigest())
                self.assertEqual((self.operation / "poster.webp").read_bytes(), self.poster.read_bytes())
                self.assertEqual(json.loads((self.operation / "admission.json").read_text()), {})
                self.assertFalse((self.operation / ".lock").exists())
                rerun = self.rerun()
                self.assertEqual(rerun.returncode, 0, rerun.stderr)
                self.assertNotIn("MOCK_FETCH", rerun.stderr)

    def test_remote_reference_resumes_polling_without_submit(self) -> None:
        for phase in ("ambiguous", "submitting"):
            with self.subTest(phase=phase):
                self.seed(phase)
                result = self.reconcile("--remote-job-ref", "recovered-job")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("MOCK_FETCH", result.stderr)
                state = json.loads(self.state_path.read_text(encoding="utf-8"))
                self.assertEqual(state["phase"], "submitted")
                self.assertEqual(state["remote_job_ref"], "recovered-job")
                rerun = self.rerun()
                self.assertEqual(rerun.returncode, 1)
                self.assertIn("MOCK_FETCH GET https://capture.invalid/v1/videos/recovered-job", rerun.stderr)
                self.assertNotIn("MOCK_FETCH POST", rerun.stderr)
                self.assertEqual(json.loads(self.state_path.read_text(encoding="utf-8")), state)

    def test_concurrent_run_is_locked_during_import(self) -> None:
        for phase in ("ambiguous", "submitting"):
            with self.subTest(phase=phase):
                self.seed(phase)
                with self.paused_reconcile("import"):
                    with self.subTest("no temporary reserved state"):
                        self.assertEqual(self.state_path.read_bytes(), self.original_state)
                    self.assertTrue((self.operation / ".lock").exists())
                    rerun = self.rerun()
                    self.assertEqual(rerun.returncode, 1)
                    self.assertIn("already being handled", rerun.stderr)
                    self.assertNotIn("MOCK_FETCH", rerun.stderr)

    def test_lock_release_never_exposes_a_resubmittable_state(self) -> None:
        for phase in ("ambiguous", "submitting"):
            with self.subTest(phase=phase):
                self.seed(phase)
                with self.paused_reconcile("unlock"):
                    with self.subTest("commit before unlocking"):
                        state = json.loads(self.state_path.read_text(encoding="utf-8"))
                        self.assertEqual(state["phase"], "downloaded")
                    rerun = self.rerun()
                    self.assertNotIn("MOCK_FETCH", rerun.stderr)
                    self.assertEqual(rerun.returncode, 0, rerun.stderr)


if __name__ == "__main__":
    unittest.main()
