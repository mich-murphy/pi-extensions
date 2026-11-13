#!/usr/bin/env python3
"""Stage and verify gateway release artifacts without executing downloaded code."""

import argparse
import errno
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import platform
import re
import struct
import subprocess
import tempfile
import resource
import tarfile
import tomllib

ROOT = Path(__file__).resolve().parent
TARGETS = json.loads((ROOT / "targets.json").read_text())
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_BINARY = 128 * 1024 * 1024


def read_bounded(path, maximum):
    with path.open("rb") as source:
        data = source.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("file exceeds size bound")
    return data


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def source_revision(value):
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("source revision must be a full lowercase Git SHA")
    return value


def version():
    return tomllib.loads((ROOT.parent / "Cargo.toml").read_text())["package"]["version"]


def release_tag(value):
    """Immutable semantic GitHub release tag; a changed release requires a version bump."""
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?", value):
        raise ValueError("invalid version")
    return f"pi-gateway-v{value}"


def native_target():
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64"}.get(platform.machine())
    matches = [target for target, spec in TARGETS.items()
               if spec["os"] == platform.system().lower() and spec["arch"] == arch]
    if len(matches) != 1:
        raise ValueError("no candidate artifact for this native OS/architecture")
    return matches[0]


def check_binary(data, target):
    """Reject target confusion using object headers, not a filename claim."""
    if target.endswith("apple-darwin"):
        if len(data) < 32 or data[:4] != b"\xcf\xfa\xed\xfe":
            raise ValueError("expected thin little-endian Mach-O executable")
        if struct.unpack_from("<I", data, 4)[0] != 0x0100000C:
            raise ValueError("expected arm64 Mach-O")
        if struct.unpack_from("<I", data, 12)[0] != 2:
            raise ValueError("expected Mach-O executable file type")
    else:
        if len(data) < 64 or data[:6] != b"\x7fELF\x02\x01":
            raise ValueError("expected 64-bit little-endian ELF")
        machine = 183 if target.startswith("aarch64") else 62
        if struct.unpack_from("<H", data, 18)[0] != machine:
            raise ValueError("ELF architecture differs from target")
        if struct.unpack_from("<H", data, 16)[0] not in (2, 3):
            raise ValueError("expected ELF executable or PIE")


def metadata(revision, target):
    return {"schema": 2, "sourceRevision": source_revision(revision),
            "version": version(), "target": target, **TARGETS[target]}


def command_output(args):
    maximum = 4 * 1024 * 1024

    def limit_output():
        resource.setrlimit(resource.RLIMIT_FSIZE, (maximum, maximum))

    with tempfile.TemporaryFile() as output:
        subprocess.run(args, check=True, stdout=output, stderr=subprocess.STDOUT,
                       timeout=30, preexec_fn=limit_output)
        output.seek(0)
        data = output.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("linkage inspection exceeds bound")
    return data.decode("utf-8")


def numeric_version(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", value):
        raise ValueError("invalid runtime requirement version")
    parts = tuple(int(part) for part in value.split("."))
    return parts + (0,) * (4 - len(parts))


def measured_requirements(binary, target):
    """Measure loader requirements, not a claim of consumer OS support."""
    if target.endswith("apple-darwin"):
        commands = command_output(["otool", "-l", str(binary)])
        versions = []
        for block in re.split(r"Load command \d+", commands):
            if re.search(r"cmd LC_BUILD_VERSION\b", block):
                if not re.search(r"platform (?:1|macos)\b", block):
                    raise ValueError("Mach-O is not a macOS deployment target")
                match = re.search(r"\bminos\s+(\d+\.\d+(?:\.\d+)?)", block)
            elif re.search(r"cmd LC_VERSION_MIN_MACOSX\b", block):
                match = re.search(r"\bversion\s+(\d+\.\d+(?:\.\d+)?)", block)
            else:
                continue
            if match:
                versions.append(match[1])
        if not versions:
            raise ValueError("missing Mach-O deployment target")
        minimum = max(versions, key=numeric_version)
        if numeric_version(minimum) > numeric_version(TARGETS[target]["testedBaseline"]):
            raise ValueError("Mach-O requirement exceeds tested baseline")
        return {"minimumMacos": minimum}
    versions = command_output(["readelf", "-V", str(binary)])
    glibc = re.findall(r"Name: GLIBC_(\d+(?:\.\d+)+)", versions)
    gcc = re.findall(r"Name: GCC_(\d+(?:\.\d+)+)", versions)
    if not glibc:
        raise ValueError("missing measured GLIBC requirements")
    required = max(glibc, key=numeric_version)
    baseline = TARGETS[target]["testedBaseline"].removeprefix("glibc-")
    if numeric_version(required) > numeric_version(baseline):
        raise ValueError("GLIBC requirement exceeds tested baseline")
    program = command_output(["readelf", "-l", str(binary)])
    dynamic = command_output(["readelf", "-d", str(binary)])
    loader = re.search(r"Requesting program interpreter: ([^\]]+)\]", program)
    if not loader or "/nix/store/" in loader[1] or "/nix/store/" in dynamic:
        raise ValueError("missing or Nix-only native loader")
    return {"requiredGlibc": required, "requiredLibgcc": max(gcc, key=numeric_version) if gcc else None,
            "loader": loader[1], "neededLibraries": sorted(re.findall(r"Shared library: \[([^\]]+)\]", dynamic))}


def stage(binary, output, revision, target):
    if not 0 < binary.stat().st_size <= MAX_BINARY:
        raise ValueError("invalid binary size")
    data = read_bounded(binary, MAX_BINARY)
    if not 0 < len(data) <= MAX_BINARY:
        raise ValueError("invalid binary size")
    check_binary(data, target)
    info = {**metadata(revision, target), "requirements": measured_requirements(binary, target)}
    output.mkdir(parents=True, exist_ok=True)
    name = f"pi-gateway-{info['version']}-{target}.tar.gz"
    archive = output / name
    with archive.open("wb") as destination:
        with gzip.GzipFile(filename="", mode="wb", fileobj=destination, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as bundle:
                for filename, content, mode in [("pi-gateway", data, 0o755),
                                                ("release.json", canonical(info), 0o644)]:
                    entry = tarfile.TarInfo(filename)
                    entry.size, entry.mode, entry.mtime = len(content), mode, 0
                    bundle.addfile(entry, io.BytesIO(content))
    record = {**info, "file": name, "size": archive.stat().st_size,
              "sha256": digest(read_bounded(archive, MAX_ARCHIVE)), "binarySize": len(data),
              "binarySha256": digest(data)}
    (output / f"{target}.json").write_bytes(canonical(record))
    return record


def validate_record(record, manifest):
    target = record["target"]
    if target not in TARGETS:
        raise ValueError("unknown target")
    expected = {"schema": 2, "sourceRevision": manifest["sourceRevision"],
                "version": manifest["version"], "target": target, **TARGETS[target]}
    if any(record.get(key) != value for key, value in expected.items()):
        raise ValueError("artifact metadata differs from release/catalog")
    name = f"pi-gateway-{manifest['version']}-{target}.tar.gz"
    if record["file"] != name or Path(name).name != name:
        raise ValueError("unsafe or mismatched archive filename")
    for key in ("sha256", "binarySha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", record[key]):
            raise ValueError("invalid SHA-256")
    for key, maximum in (("size", MAX_ARCHIVE), ("binarySize", MAX_BINARY)):
        if type(record[key]) is not int or not 0 < record[key] <= maximum:
            raise ValueError("artifact size outside bounds")
    requirements = record.get("requirements")
    if not isinstance(requirements, dict):
        raise ValueError("missing measured runtime requirements")
    baseline = TARGETS[target]["testedBaseline"]
    if target.endswith("apple-darwin"):
        if set(requirements) != {"minimumMacos"} or numeric_version(requirements["minimumMacos"]) > numeric_version(baseline):
            raise ValueError("MacOS requirement exceeds baseline")
    else:
        if set(requirements) != {"requiredGlibc", "requiredLibgcc", "loader", "neededLibraries"} or numeric_version(requirements["requiredGlibc"]) > numeric_version(baseline.removeprefix("glibc-")):
            raise ValueError("GLIBC requirement exceeds baseline")
        if not requirements["loader"].startswith("/lib") or not isinstance(requirements["neededLibraries"], list):
            raise ValueError("invalid loader/library requirements")
    return {**expected, "requirements": requirements}


def verify_archive(archive, record, manifest):
    expected = validate_record(record, manifest)
    if archive.stat().st_size != record["size"]:
        raise ValueError("archive size mismatch")
    data = read_bounded(archive, MAX_ARCHIVE)
    if digest(data) != record["sha256"]:
        raise ValueError("archive SHA-256 mismatch")
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
        unpacked = compressed.read(MAX_BINARY + 32769)
    if len(unpacked) > MAX_BINARY + 32768:
        raise ValueError("decompressed archive exceeds bound")
    with tarfile.open(fileobj=io.BytesIO(unpacked), mode="r:") as bundle:
        members = []
        for member in bundle:
            members.append(member)
            if len(members) > 2 or member.size > MAX_BINARY:
                raise ValueError("archive exceeds member or size bound")
        if sorted(item.name for item in members) != ["pi-gateway", "release.json"]:
            raise ValueError("archive must contain exactly pi-gateway and release.json")
        for item in members:
            limit = MAX_BINARY if item.name == "pi-gateway" else 16384
            mode = 0o755 if item.name == "pi-gateway" else 0o644
            if not item.isfile() or item.size > limit or item.mode != mode:
                raise ValueError("unsafe archive member type, size or mode")
        binary = bundle.extractfile("pi-gateway").read()
        embedded = json.loads(bundle.extractfile("release.json").read())
    if embedded != expected:
        raise ValueError("embedded metadata mismatch")
    if len(binary) != record["binarySize"] or digest(binary) != record["binarySha256"]:
        raise ValueError("binary integrity mismatch")
    check_binary(binary, record["target"])
    return binary


def verify_manifest(path, expected_digest):
    if path.stat().st_size > 65536:
        raise ValueError("manifest exceeds size bound")
    data = read_bounded(path, 65536)
    if len(data) > 65536 or digest(data) != expected_digest:
        raise ValueError("manifest differs from trusted pinned SHA-256")
    manifest = json.loads(data)
    source_revision(manifest["sourceRevision"])
    if manifest["schema"] != 2 or manifest["releaseTag"] != release_tag(manifest["version"]):
        raise ValueError("unsupported manifest or release tag")
    targets = [record["target"] for record in manifest["artifacts"]]
    if sorted(targets) != sorted(TARGETS):
        raise ValueError("release must contain each candidate target exactly once")
    for record in manifest["artifacts"]:
        validate_record(record, manifest)
    return manifest


def assemble(directory, revision):
    release_version = version()
    manifest = {"schema": 2, "sourceRevision": source_revision(revision),
                "version": release_version, "releaseTag": release_tag(release_version),
                "artifacts": [json.loads((directory / f"{target}.json").read_text())
                              for target in sorted(TARGETS)]}
    for record in manifest["artifacts"]:
        verify_archive(directory / record["file"], record, manifest)
    path = directory / "manifest.json"
    path.write_bytes(canonical(manifest))
    checksum = digest(read_bounded(path, 65536))
    verify_manifest(path, checksum)
    (directory / "manifest.sha256").write_text(f"{checksum}  manifest.json\n")
    return checksum


def _same_file(first, second):
    return (first.st_dev, first.st_ino) == (second.st_dev, second.st_ino)


def _discard_created(parent_fd, name, created):
    """Remove `name` only while it still is the inode this process created; otherwise retain.

    Same-UID processes are not isolated from this one, and stat-then-unlink is not an atomic
    conditional unlink: a replacement in that window can still be lost. Never unlinks by path.
    """
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return "created output is already absent; nothing removed"
    except OSError as error:
        return f"could not inspect created output; retained: {error}"
    if not _same_file(current, created):
        return "output name refers to a different file; retained"
    try:
        os.unlink(name, dir_fd=parent_fd)
    except OSError as error:
        return f"could not remove created output; retained: {error}"
    return "removed created output"


def _read_descriptor(descriptor, maximum):
    chunks, offset = [], 0
    while offset <= maximum:
        chunk = os.pread(descriptor, min(1 << 20, maximum + 1 - offset), offset)
        if not chunk:
            break
        chunks.append(chunk)
        offset += len(chunk)
    return b"".join(chunks)


def extract(manifest_path, manifest_sha256, directory, target, output):
    """Write one authenticated binary to a new private file; never overwrite or follow links.

    Authentication order: trusted manifest pin, record claims, archive, embedded metadata,
    binary digest and object header. Nothing is written until all of them pass. The write is
    anchored to a verified parent directory descriptor, read back through the creating
    descriptor, and the visible parent and file identity are rechecked before the path is
    returned. O_NOFOLLOW covers the parent's last component only; earlier components are
    trusted to the caller and covered by the final visible-identity recheck. This is not
    isolation from other processes running as the same user.
    """
    manifest = verify_manifest(manifest_path, manifest_sha256)
    records = [item for item in manifest["artifacts"] if item["target"] == target]
    if len(records) != 1:
        raise ValueError("manifest has no single record for target")
    record = records[0]
    binary = verify_archive(directory / record["file"], record, manifest)
    output = Path(output)
    name = output.name
    if name in ("", ".", "..") or "/" in name:
        raise ValueError("output must name a file")
    try:
        parent_fd = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                            | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.ENOENT):
            raise ValueError("output parent must be an existing real directory") from error
        raise
    try:
        parent = os.fstat(parent_fd)
        if not stat.S_ISDIR(parent.st_mode):
            raise ValueError("output parent must be an existing real directory")
        if parent.st_uid != os.getuid() or parent.st_mode & 0o022:
            raise ValueError("output parent must be owned and not group/other writable")
        # An existing name (file, link or anything else) fails here; it is never removed.
        descriptor = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                             | os.O_CLOEXEC, 0o500, dir_fd=parent_fd)
        try:
            created = os.fstat(descriptor)
        except BaseException as error:
            os.close(descriptor)
            error.add_note("could not identify created output; retained")
            raise
        try:
            os.fchmod(descriptor, 0o500)
            view = memoryview(binary)
            while view:
                count = os.write(descriptor, view)
                if count <= 0:
                    raise OSError(errno.EIO, "write made no progress")
                view = view[count:]
            os.fsync(descriptor)
            data = _read_descriptor(descriptor, MAX_BINARY)
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o500
                    or not _same_file(info, created) or len(data) != record["binarySize"]
                    or digest(data) != record["binarySha256"]):
                raise ValueError("written binary differs from authenticated record")
            os.fsync(parent_fd)
            closing, descriptor = descriptor, None
            os.close(closing)
            visible = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if (not _same_file(visible, created) or not stat.S_ISREG(visible.st_mode)
                    or stat.S_IMODE(visible.st_mode) != 0o500):
                raise ValueError("output name no longer refers to the authenticated file")
            if not _same_file(os.lstat(output.parent), parent):
                raise ValueError("output parent was replaced before handoff")
        except BaseException as error:
            error.add_note(_discard_created(parent_fd, name, created))
            raise
        finally:
            if descriptor is not None:
                os.close(descriptor)
    finally:
        os.close(parent_fd)
    return {"manifestSha256": manifest_sha256, "sourceRevision": manifest["sourceRevision"],
            "version": manifest["version"], "target": target, "file": record["file"],
            "archiveSha256": record["sha256"], "binarySha256": record["binarySha256"],
            "binarySize": record["binarySize"], "output": str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("native-target")
    build = commands.add_parser("stage")
    build.add_argument("--binary", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--revision", required=True)
    build.add_argument("--target", choices=TARGETS, required=True)
    combine = commands.add_parser("assemble")
    combine.add_argument("--directory", type=Path, required=True)
    combine.add_argument("--revision", required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("--manifest", type=Path, required=True)
    verify.add_argument("--manifest-sha256", required=True)
    verify.add_argument("--target", choices=TARGETS, required=True)
    verify.add_argument("--directory", type=Path, required=True)
    unpack = commands.add_parser("extract")
    unpack.add_argument("--manifest", type=Path, required=True)
    unpack.add_argument("--manifest-sha256", required=True)
    unpack.add_argument("--target", choices=TARGETS, required=True)
    unpack.add_argument("--directory", type=Path, required=True)
    unpack.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "native-target":
        print(native_target())
    elif args.command == "stage":
        if args.target != native_target():
            raise ValueError("staging requires a matching native runner")
        print(json.dumps(stage(args.binary, args.output, args.revision, args.target)))
    elif args.command == "assemble":
        print(assemble(args.directory, args.revision))
    elif args.command == "extract":
        print(json.dumps(extract(args.manifest, args.manifest_sha256, args.directory,
                                 args.target, args.output)))
    else:
        manifest = verify_manifest(args.manifest, args.manifest_sha256)
        record = next(item for item in manifest["artifacts"] if item["target"] == args.target)
        verify_archive(args.directory / record["file"], record, manifest)
        print(f"verified {record['file']}; no executable was run or installed")


if __name__ == "__main__":
    main()
