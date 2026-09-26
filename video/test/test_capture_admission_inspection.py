#!/usr/bin/env python3
"""Admission must inspect media before changing the public gallery."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
CASE = "minimax-official-01"
ROUTE = "grok-video"
PROBE = {
    "streams": [
        {
            "codec_type": "video",
            "codec_name": "h264",
            "width": 640,
            "height": 360,
            "duration": "2.5",
            "avg_frame_rate": "30000/1001",
        }
    ],
    "format": {"duration": "2.5"},
}


class CaptureAdmissionInspectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.make_gallery()

    def make_gallery(self) -> None:
        work = ROOT / ".work"
        work.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="admission-test-", dir=work)
        self.addCleanup(temporary.cleanup)
        self.gallery = Path(temporary.name)
        for name in ("scripts", "assets", "data", "media", "receipts"):
            shutil.copytree(ROOT / name, self.gallery / name)
        shutil.copyfile(ROOT / "index.html", self.gallery / "index.html")
        self.bin = self.gallery / "bin"
        self.bin.mkdir()
        self.env = {**os.environ, "PATH": str(self.bin)}
        reserved = self.capture("reserve", "--case", CASE, "--route", ROUTE)
        self.assertEqual(reserved.returncode, 0, reserved.stderr)
        self.operation = next((self.gallery / ".work" / "operations").iterdir())
        (self.operation / "provider-evidence.json").write_text(
            json.dumps({
                "served_model": {
                    "kind": "provider-reported",
                    "id": "grok-imagine-video-1.5",
                    "receipt_field": "model",
                }
            }),
            encoding="utf-8",
        )
        # Signatures alone are deliberately insufficient media evidence.
        (self.gallery / "input.mp4").write_bytes(b"\x00\x00\x00\x0cftypisom")
        (self.gallery / "input.webp").write_bytes(b"RIFF\x04\x00\x00\x00WEBP")
        self.import_media()
        self.before = self.public_snapshot()
        self.state_before = (self.operation / "state.json").read_bytes()

    def capture(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [NODE, "scripts/capture.mjs", *args],
            cwd=self.gallery, env=self.env, text=True, capture_output=True,
            check=False, timeout=30,
        )

    def import_media(self, *flags: str) -> None:
        result = self.capture(
            "import", "--operation", self.operation.name,
            "--file", str(self.gallery / "input.mp4"),
            "--poster", str(self.gallery / "input.webp"),
            "--reviewed-on", "2026-08-30", *flags,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def install_probe(
        self, output: str | None = None, *, version_status: int = 0,
        inspection_status: int = 0, version: str = "ffprobe version fixture-1",
    ) -> None:
        if output is None:
            output = json.dumps(PROBE)
        executable = self.bin / "ffprobe"
        executable.write_text(
            f"#!{NODE}\n"
            "if (process.argv.includes('-version')) {\n"
            f"  console.log({json.dumps(version)});\n"
            f"  process.exit({version_status});\n"
            "}\n"
            f"console.log({json.dumps(output)});\n"
            f"process.exit({inspection_status});\n",
            encoding="utf-8",
        )
        executable.chmod(0o755)

    def public_snapshot(self) -> dict[str, str]:
        paths = [self.gallery / "index.html"]
        for name in ("data", "media", "receipts"):
            paths.extend(path for path in (self.gallery / name).rglob("*") if path.is_file())
        return {
            str(path.relative_to(self.gallery)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in paths
        }

    def assert_rejected(self, message: str) -> None:
        result = self.capture("admit", "--operation", self.operation.name)
        self.assertEqual(self.public_snapshot(), self.before, "rejection changed public files")
        self.assertEqual((self.operation / "state.json").read_bytes(), self.state_before)
        self.assertNotIn("admitted", result.stdout)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(message, result.stderr)
        self.assertFalse((self.operation / ".lock").exists())

    def test_missing_ffprobe_rejects_signature_only_media(self) -> None:
        self.assert_rejected("ffprobe")

    def test_metadata_cannot_replace_missing_inspection(self) -> None:
        self.import_media(
            "--width", "1280", "--height", "720",
            "--duration-milliseconds", "5000", "--frame-rate-millihertz", "24000",
            "--codec", "h264", "--decode-tool", "operator-provided decode",
            "--decode-version", "claimed-version",
        )
        self.assert_rejected("ffprobe")

    def test_failed_version_check_rejects_admission(self) -> None:
        self.install_probe(version_status=1)
        self.assert_rejected("ffprobe")

    def test_missing_version_rejects_admission(self) -> None:
        self.install_probe(version="")
        self.assert_rejected("ffprobe")

    def test_failed_inspection_rejects_admission(self) -> None:
        self.install_probe(inspection_status=1)
        self.assert_rejected("ffprobe")

    def test_malformed_probe_output_rejects_admission(self) -> None:
        for output in ("not JSON", "null", "{}", '{"streams": {}}', '{"streams": [null]}', '{"streams": []}'):
            with self.subTest(output=output):
                self.make_gallery()
                self.install_probe(output)
                self.assert_rejected("ffprobe")

    def test_invalid_numeric_facts_reject_before_public_writes(self) -> None:
        for field, values in {
            "width": (None, "NaN", "Infinity", 0, -1, 1.5),
            "height": (None, "NaN", "Infinity", 0, -1, 1.5),
            "duration": ("NaN", "Infinity", "0", "-1"),
            "avg_frame_rate": ("NaN/1", "Infinity/1", "24/0", "0/1", "-24/1", "24/1/2"),
        }.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    self.make_gallery()
                    probe = copy.deepcopy(PROBE)
                    probe["streams"][0][field] = value
                    self.install_probe(json.dumps(probe))
                    self.assert_rejected("ffprobe")

    def test_missing_duration_and_frame_rate_rejects_admission(self) -> None:
        for field in ("duration", "avg_frame_rate"):
            with self.subTest(field=field):
                self.make_gallery()
                probe = copy.deepcopy(PROBE)
                del probe["streams"][0][field]
                probe["format"] = {}
                self.install_probe(json.dumps(probe))
                self.assert_rejected("ffprobe")

    def test_missing_codec_rejects_admission(self) -> None:
        probe = copy.deepcopy(PROBE)
        del probe["streams"][0]["codec_name"]
        self.install_probe(json.dumps(probe))
        self.assert_rejected("ffprobe")

    def test_missing_audio_codec_rejects_admission(self) -> None:
        probe = copy.deepcopy(PROBE)
        probe["streams"].append({"codec_type": "audio"})
        self.install_probe(json.dumps(probe))
        self.assert_rejected("ffprobe")

    def test_container_duration_stream_rate_and_audio_are_inspected(self) -> None:
        probe = copy.deepcopy(PROBE)
        video = probe["streams"][0]
        del video["duration"]
        video["r_frame_rate"] = video.pop("avg_frame_rate")
        probe["streams"].append({"codec_type": "audio", "codec_name": "aac"})
        self.install_probe(json.dumps(probe))
        result = self.capture("admit", "--operation", self.operation.name)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.gallery / "data/comparison.json").read_text())
        facts = manifest["samples"][CASE][ROUTE]["state"]["media_facts"]
        self.assertEqual(facts["audio"], {"kind": "present", "codec": "aac"})
        self.assertEqual(facts["duration_milliseconds"], 2500)
        self.assertEqual(facts["frame_rate_millihertz"], 29970)

    def test_valid_inspection_admits_observed_facts(self) -> None:
        self.install_probe()
        self.import_media(
            "--width", "1", "--height", "1", "--codec", "unverified",
            "--decode-tool", "operator-provided decode", "--decode-version", "claimed-version",
        )
        result = self.capture("admit", "--operation", self.operation.name)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.gallery / "data/comparison.json").read_text())
        generated = manifest["samples"][CASE][ROUTE]["state"]
        facts = generated["media_facts"]
        self.assertEqual(generated["kind"], "generated")
        self.assertEqual(
            {key: facts[key] for key in ("codec", "width", "height", "duration_milliseconds", "frame_rate_millihertz")},
            {"codec": "h264", "width": 640, "height": 360, "duration_milliseconds": 2500, "frame_rate_millihertz": 29970},
        )
        self.assertEqual(facts["audio"], {"kind": "absent"})
        self.assertEqual(generated["admission"]["full_decode"], {"tool": "ffprobe", "version": "fixture-1"})
        self.assertEqual(json.loads((self.operation / "state.json").read_text())["phase"], "admitted")
        media = self.gallery / f"media/{CASE}--{ROUTE}.mp4"
        receipt = self.gallery / f"receipts/{CASE}--{ROUTE}.json"
        self.assertEqual(media.read_bytes(), (self.gallery / "input.mp4").read_bytes())
        self.assertEqual(generated["receipt_sha256"], hashlib.sha256(receipt.read_bytes()).hexdigest())
        self.assertIn(f'<source src="media/{CASE}--{ROUTE}.mp4"', (self.gallery / "index.html").read_text())


if __name__ == "__main__":
    unittest.main()
