"""Offline release-format tests; synthetic object headers are not native builds."""

import copy
import errno
import io
import os
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


class CatalogFixture:
    """Synthetic staged catalog shared by test classes without inheriting their tests."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        patcher = patch("artifacts.measured_requirements", side_effect=lambda binary, target: (
            {"minimumMacos": "15.0"} if target.endswith("apple-darwin") else
            {"requiredGlibc": "2.34", "requiredLibgcc": "3.0", "loader": "/lib/ld-linux.so", "neededLibraries": ["libc.so.6"]}))
        patcher.start()
        self.addCleanup(patcher.stop)
        for target in artifacts.TARGETS:
            binary = self.directory / "binary"
            binary.write_bytes(object_bytes(target))
            artifacts.stage(binary, self.directory, REVISION, target)
        self.pin = artifacts.assemble(self.directory, REVISION)
        self.path = self.directory / "manifest.json"
        self.manifest = artifacts.verify_manifest(self.path, self.pin)
        self.record = self.manifest["artifacts"][0]


class ArtifactTests(CatalogFixture, unittest.TestCase):
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

    def test_release_tag_is_semantic_version_not_revision(self):
        self.assertEqual(self.manifest["releaseTag"], f"pi-gateway-v{self.manifest['version']}")
        self.assertEqual(artifacts.release_tag("0.1.0"), "pi-gateway-v0.1.0")
        self.assertNotIn(REVISION, self.manifest["releaseTag"])
        for value in ("v0.1.0", "0.1", "../0.1.0", REVISION):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "invalid version"):
                artifacts.release_tag(value)

    def test_manifest_rejects_tag_not_bound_to_version(self):
        for tag in (f"gateway-{REVISION}", "v0.1.0", f"pi-gateway-v{REVISION}",
                    "pi-gateway-v0.1.1", "pi-gateway-0.1.0"):
            with self.subTest(tag=tag):
                manifest = {**self.manifest, "releaseTag": tag}
                self.path.write_bytes(artifacts.canonical(manifest))
                with self.assertRaisesRegex(ValueError, "release tag"):
                    artifacts.verify_manifest(self.path, artifacts.digest(self.path.read_bytes()))

    def test_manifest_rejects_version_or_source_not_bound_to_records(self):
        for change in ({"version": "0.2.0", "releaseTag": "pi-gateway-v0.2.0"},
                       {"sourceRevision": "b" * 40}):
            with self.subTest(change=change):
                self.path.write_bytes(artifacts.canonical({**self.manifest, **change}))
                with self.assertRaisesRegex(ValueError, "differs from release/catalog"):
                    artifacts.verify_manifest(self.path, artifacts.digest(self.path.read_bytes()))

    def test_manifest_rejects_invalid_version_before_tag_use(self):
        self.path.write_bytes(artifacts.canonical({**self.manifest, "version": "main",
                                                   "releaseTag": "pi-gateway-vmain"}))
        with self.assertRaisesRegex(ValueError, "invalid version"):
            artifacts.verify_manifest(self.path, artifacts.digest(self.path.read_bytes()))

    def test_catalog_rejects_duplicate_or_missing_target(self):
        self.manifest["artifacts"][1] = self.record
        self.path.write_bytes(artifacts.canonical(self.manifest))
        with self.assertRaisesRegex(ValueError, "each candidate"):
            artifacts.verify_manifest(self.path, artifacts.digest(self.path.read_bytes()))

    def test_metadata_must_match_catalog(self):
        self.record["testedBaseline"] = "invented"
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


def open_descriptors():
    return len(os.listdir("/dev/fd"))


class ExtractTests(CatalogFixture, unittest.TestCase):
    """Exclusive extraction of an authenticated binary into a real temporary filesystem."""

    def setUp(self):
        super().setUp()
        self.out_dir = self.directory / "out"
        self.out_dir.mkdir(mode=0o700)
        self.output = self.out_dir / "pi-gateway"

    def extract(self, pin=None, target="aarch64-apple-darwin"):
        return artifacts.extract(self.path, pin or self.pin, self.directory, target, self.output)

    def test_writes_exact_authenticated_bytes_private_mode(self):
        for target in artifacts.TARGETS:
            with self.subTest(target=target):
                result = self.extract(target=target)
                self.assertEqual(self.output.read_bytes(), object_bytes(target))
                self.assertEqual(self.output.stat().st_mode & 0o777, 0o500)
                self.assertEqual(result["manifestSha256"], self.pin)
                self.assertEqual(result["sourceRevision"], REVISION)
                self.assertEqual(result["binarySha256"], artifacts.digest(object_bytes(target)))
                self.output.unlink()

    def test_never_overwrites_existing_output(self):
        self.output.write_bytes(b"keep")
        before = open_descriptors()
        with self.assertRaises(FileExistsError):
            self.extract()
        self.assertEqual(open_descriptors(), before)
        self.assertEqual(self.output.read_bytes(), b"keep")

    def test_refuses_symlink_output_and_symlink_parent(self):
        victim = self.directory / "victim"
        self.output.symlink_to(victim)
        with self.assertRaises(OSError):
            self.extract()
        self.assertFalse(victim.exists())
        self.assertTrue(self.output.is_symlink())
        self.output.unlink()
        linked = self.directory / "linked"
        linked.symlink_to(self.out_dir)
        self.output = linked / "pi-gateway"
        with self.assertRaisesRegex(ValueError, "real directory"):
            self.extract()
        self.assertEqual(list(self.out_dir.iterdir()), [])

    def test_refuses_missing_parent(self):
        self.output = self.out_dir / "absent" / "pi-gateway"
        with self.assertRaisesRegex(ValueError, "real directory"):
            self.extract()
        self.assertFalse((self.out_dir / "absent").exists())

    def test_refuses_shared_writable_parent(self):
        self.out_dir.chmod(0o777)
        with self.assertRaisesRegex(ValueError, "not group/other writable"):
            self.extract()
        self.assertEqual(list(self.out_dir.iterdir()), [])

    def test_untrusted_pin_or_tampered_archive_writes_nothing(self):
        with self.assertRaisesRegex(ValueError, "trusted pinned"):
            self.extract(pin="0" * 64)
        record = next(item for item in self.manifest["artifacts"] if item["target"] == "aarch64-apple-darwin")
        archive = self.directory / record["file"]
        original = archive.read_bytes()
        archive.write_bytes(b"X" + original[1:])
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            self.extract()
        self.assertEqual(list(self.out_dir.iterdir()), [])

    def assert_removed(self, raised):
        self.assertIn("removed created output", raised.exception.__notes__)
        self.assertEqual(list(self.out_dir.iterdir()), [])

    def test_write_failure_removes_only_created_file(self):
        before = open_descriptors()
        with patch("artifacts.os.write", side_effect=OSError(errno.ENOSPC, "full")):
            with self.assertRaises(OSError) as raised:
                self.extract()
        self.assertEqual(raised.exception.errno, errno.ENOSPC)
        self.assertEqual(open_descriptors(), before)
        self.assert_removed(raised)

    def test_fsync_failure_removes_only_created_file(self):
        with patch("artifacts.os.fsync", side_effect=OSError(errno.EIO, "fsync")):
            with self.assertRaises(OSError) as raised:
                self.extract()
        self.assertEqual(raised.exception.errno, errno.EIO)
        self.assert_removed(raised)

    def test_readback_mismatch_removes_created_file(self):
        real_pread = os.pread

        def corrupt(descriptor, size, offset):
            data = real_pread(descriptor, size, offset)
            return (bytes([data[0] ^ 1]) + data[1:]) if offset == 0 and data else data

        with patch("artifacts.os.pread", side_effect=corrupt):
            with self.assertRaisesRegex(ValueError, "differs from authenticated record") as raised:
                self.extract()
        self.assert_removed(raised)

    def test_foreign_replacement_is_preserved_and_own_file_not_unlinked_by_path(self):
        moved = self.directory / "moved-own"
        real_fsync = os.fsync

        def swap_then_fail(descriptor):
            self.output.rename(moved)
            self.output.write_bytes(b"foreign")
            raise OSError(errno.EIO, "fsync")

        with patch("artifacts.os.fsync", side_effect=swap_then_fail):
            with self.assertRaises(OSError) as raised:
                self.extract()
        self.assertIn("output name refers to a different file; retained", raised.exception.__notes__)
        self.assertEqual(self.output.read_bytes(), b"foreign")
        self.assertTrue(moved.exists())
        self.assertIs(os.fsync, real_fsync)

    def test_replacement_after_readback_is_refused_and_foreign_file_preserved(self):
        calls = []
        real_fsync = os.fsync

        def swap_on_parent_fsync(descriptor):
            calls.append(descriptor)
            real_fsync(descriptor)
            if len(calls) == 2:
                self.output.rename(self.out_dir / "moved-own")
                self.output.write_bytes(b"foreign")

        with patch("artifacts.os.fsync", side_effect=swap_on_parent_fsync):
            with self.assertRaisesRegex(ValueError, "no longer refers") as raised:
                self.extract()
        self.assertIn("output name refers to a different file; retained", raised.exception.__notes__)
        self.assertEqual(self.output.read_bytes(), b"foreign")
        self.assertEqual(sorted(item.name for item in self.out_dir.iterdir()), ["moved-own", "pi-gateway"])

    def test_parent_replaced_before_handoff_is_error_and_foreign_parent_preserved(self):
        calls = []
        real_fsync = os.fsync
        moved = self.directory / "moved-out"

        def replace_parent(descriptor):
            calls.append(descriptor)
            real_fsync(descriptor)
            if len(calls) == 2:
                self.out_dir.rename(moved)
                self.out_dir.mkdir(mode=0o700)
                (self.out_dir / "pi-gateway").write_bytes(b"foreign")

        with patch("artifacts.os.fsync", side_effect=replace_parent):
            with self.assertRaisesRegex(ValueError, "parent was replaced") as raised:
                self.extract()
        # Cleanup is anchored to the original parent descriptor: only our inode there is removed.
        self.assertIn("removed created output", raised.exception.__notes__)
        self.assertEqual(list(moved.iterdir()), [])
        self.assertEqual((self.out_dir / "pi-gateway").read_bytes(), b"foreign")

    def test_cleanup_inspection_error_retains_output(self):
        real_stat = os.stat

        def deny_anchored(path, *args, dir_fd=None, **kwargs):
            # Only the dir_fd-anchored cleanup inspection fails; Path.stat() elsewhere is real.
            if dir_fd is not None:
                raise PermissionError(errno.EACCES, "denied")
            return real_stat(path, *args, **kwargs)

        with patch("artifacts.os.fsync", side_effect=OSError(errno.EIO, "fsync")), \
                patch("artifacts.os.stat", side_effect=deny_anchored):
            with self.assertRaises(OSError) as raised:
                self.extract()
        self.assertTrue(any(note.startswith("could not inspect created output; retained")
                            for note in raised.exception.__notes__))
        self.assertTrue(self.output.exists())


class MeasurementTests(unittest.TestCase):
    def test_linux_symbols_do_not_lower_tested_baseline(self):
        with patch("artifacts.command_output", side_effect=[
            "Name: GLIBC_2.17 Name: GLIBC_2.34 Name: GCC_3.0",
            "[Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]",
            "Shared library: [libc.so.6]"]):
            result = artifacts.measured_requirements(Path("fixture"), "x86_64-unknown-linux-gnu")
        self.assertEqual(result["requiredGlibc"], "2.34")
        self.assertEqual(artifacts.TARGETS["x86_64-unknown-linux-gnu"]["testedBaseline"], "glibc-2.39")

    def test_above_baseline_fails(self):
        with patch("artifacts.command_output", return_value="Name: GLIBC_2.40"):
            with self.assertRaisesRegex(ValueError, "exceeds"):
                artifacts.measured_requirements(Path("fixture"), "x86_64-unknown-linux-gnu")

    def test_macos_minimum_is_from_load_command(self):
        with patch("artifacts.command_output", return_value="Load command 1\n cmd LC_BUILD_VERSION\n platform 1\n minos 15.0\n sdk 15.4\nLoad command 2\ncmd LC_LOAD_DYLIB\n current version 1351.0.0"):
            self.assertEqual(artifacts.measured_requirements(Path("fixture"), "aarch64-apple-darwin"), {"minimumMacos": "15.0"})

    def test_equivalent_version_components_do_not_raise_requirement(self):
        self.assertEqual(artifacts.numeric_version("15.0.0"), artifacts.numeric_version("15.0"))
        self.assertGreater(artifacts.numeric_version("15.1"), artifacts.numeric_version("15.0.0"))
        with self.assertRaises(ValueError):
            artifacts.numeric_version("2.-1")


if __name__ == "__main__":
    unittest.main()
