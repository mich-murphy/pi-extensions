"""Offline release-format tests; synthetic object headers are not native builds."""

import copy
import io
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import artifacts

REVISION = "a" * 40


def object_bytes(target):
    data = bytearray(128)
    if target.endswith("apple-darwin"):
        data[:4] = b"\xcf\xfa\xed\xfe"
        struct.pack_into("<I", data, 4, 0x0100000C)
        struct.pack_into("<I", data, 12, 2)
    else:
        data[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", data, 16, 3)
        struct.pack_into("<H", data, 18, 183 if target.startswith("aarch64") else 62)
    return bytes(data)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        for target in artifacts.TARGETS:
            binary = self.directory / "binary"
            binary.write_bytes(object_bytes(target))
            artifacts.stage(binary, self.directory, REVISION, target)
        self.pin = artifacts.assemble(self.directory, REVISION)
        self.path = self.directory / "manifest.json"
        self.manifest = artifacts.verify_manifest(self.path, self.pin)
        self.record = self.manifest["artifacts"][0]

    def test_round_trip_all_targets(self):
        for record in self.manifest["artifacts"]:
            binary = artifacts.verify_archive(self.directory / record["file"], record, self.manifest)
            self.assertEqual(binary, object_bytes(record["target"]))

    def test_archive_metadata_has_no_wall_clock_or_path(self):
        target = self.record["target"]
        binary = self.directory / "binary"
        binary.write_bytes(object_bytes(target))
        first = (self.directory / self.record["file"]).read_bytes()
        other = self.directory / "other"
        record = artifacts.stage(binary, other, REVISION, target)
        self.assertEqual(first, (other / record["file"]).read_bytes())
        self.assertEqual(first[4:8], b"\x00" * 4)  # gzip mtime
        self.assertEqual(first[3] & 8, 0)  # no gzip filename field

    def test_manifest_requires_trusted_pin(self):
        with self.assertRaisesRegex(ValueError, "trusted pinned"):
            artifacts.verify_manifest(self.path, "0" * 64)

    def test_catalog_rejects_duplicate_or_missing_target(self):
        self.manifest["artifacts"][1] = self.record
        self.path.write_bytes(artifacts.canonical(self.manifest))
        with self.assertRaisesRegex(ValueError, "each candidate"):
            artifacts.verify_manifest(self.path, artifacts.digest(self.path.read_bytes()))

    def test_metadata_must_match_catalog(self):
        self.record["minimumOs"] = "invented"
        with self.assertRaisesRegex(ValueError, "differs from release/catalog"):
            artifacts.verify_archive(self.directory / self.record["file"], self.record, self.manifest)

    def test_digest_and_size_fail_closed(self):
        archive = self.directory / self.record["file"]
        original = archive.read_bytes()
        archive.write_bytes(original[:-1])
        with self.assertRaisesRegex(ValueError, "size mismatch"):
            artifacts.verify_archive(archive, self.record, self.manifest)
        archive.write_bytes(b"X" + original[1:])
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            artifacts.verify_archive(archive, self.record, self.manifest)

    def rewrite_archive(self, members):
        archive = self.directory / self.record["file"]
        with tarfile.open(archive, "w:gz") as bundle:
            for member, content in members:
                member.size = len(content)
                bundle.addfile(member, io.BytesIO(content))
        self.record["size"] = archive.stat().st_size
        self.record["sha256"] = artifacts.digest(archive.read_bytes())
        return archive

    def test_rejects_traversal_links_duplicates_and_extra_members(self):
        for name, kind in [("../pi-gateway", tarfile.REGTYPE),
                           ("pi-gateway", tarfile.SYMTYPE),
                           ("pi-gateway", tarfile.LNKTYPE),
                           ("unexpected", tarfile.REGTYPE)]:
            with self.subTest(name=name, kind=kind):
                member = tarfile.TarInfo(name)
                member.type, member.mode = kind, 0o755
                metadata = tarfile.TarInfo("release.json")
                metadata.mode = 0o644
                archive = self.rewrite_archive([(member, b""), (metadata, b"{}")])
                with self.assertRaises(ValueError):
                    artifacts.verify_archive(archive, self.record, self.manifest)
        member = tarfile.TarInfo("pi-gateway")
        member.mode = 0o755
        archive = self.rewrite_archive([(member, b""), (member, b"")])
        with self.assertRaisesRegex(ValueError, "exactly"):
            artifacts.verify_archive(archive, self.record, self.manifest)

    def test_binary_digest_and_header_checked(self):
        self.record["binarySha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "binary integrity"):
            artifacts.verify_archive(self.directory / self.record["file"], self.record, self.manifest)
        with self.assertRaises(ValueError):
            artifacts.check_binary(object_bytes("x86_64-unknown-linux-gnu"), "aarch64-apple-darwin")
        with self.assertRaises(ValueError):
            artifacts.check_binary(object_bytes("x86_64-unknown-linux-gnu"), "aarch64-unknown-linux-gnu")

    def test_revision_and_filename_are_not_mutable_or_paths(self):
        with self.assertRaises(ValueError):
            artifacts.source_revision("main")
        self.record["file"] = "../../elsewhere"
        with self.assertRaises(ValueError):
            artifacts.validate_record(self.record, self.manifest)

    def test_declared_size_is_bounded(self):
        for key in ("size", "binarySize"):
            record = copy.deepcopy(self.record)
            record[key] = 2 ** 40
            with self.assertRaisesRegex(ValueError, "outside bounds"):
                artifacts.validate_record(record, self.manifest)

    def test_platform_detection_does_not_assume_intel_macos(self):
        with patch("platform.system", return_value="Darwin"), patch("platform.machine", return_value="x86_64"):
            with self.assertRaisesRegex(ValueError, "no candidate"):
                artifacts.native_target()
        with patch("platform.system", return_value="Linux"), patch("platform.machine", return_value="aarch64"):
            self.assertEqual(artifacts.native_target(), "aarch64-unknown-linux-gnu")


if __name__ == "__main__":
    unittest.main()
