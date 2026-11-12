#!/usr/bin/env python3
"""Stage and verify gateway release artifacts without executing downloaded code."""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import platform
import re
import struct
import tarfile
import tomllib

ROOT = Path(__file__).resolve().parent
TARGETS = json.loads((ROOT / "targets.json").read_text())
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_BINARY = 128 * 1024 * 1024


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
    return {"schema": 1, "sourceRevision": source_revision(revision),
            "version": version(), "target": target, **TARGETS[target]}


def stage(binary, output, revision, target):
    data = binary.read_bytes()
    if not 0 < len(data) <= MAX_BINARY:
        raise ValueError("invalid binary size")
    check_binary(data, target)
    info = metadata(revision, target)
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
              "sha256": digest(archive.read_bytes()), "binarySize": len(data),
              "binarySha256": digest(data)}
    (output / f"{target}.json").write_bytes(canonical(record))
    return record


def validate_record(record, manifest):
    target = record["target"]
    if target not in TARGETS:
        raise ValueError("unknown target")
    expected = {"schema": 1, "sourceRevision": manifest["sourceRevision"],
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
    return expected


def verify_archive(archive, record, manifest):
    expected = validate_record(record, manifest)
    if archive.stat().st_size != record["size"]:
        raise ValueError("archive size mismatch")
    data = archive.read_bytes()
    if digest(data) != record["sha256"]:
        raise ValueError("archive SHA-256 mismatch")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as bundle:
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
    data = path.read_bytes()
    if len(data) > 65536 or digest(data) != expected_digest:
        raise ValueError("manifest differs from trusted pinned SHA-256")
    manifest = json.loads(data)
    source_revision(manifest["sourceRevision"])
    if manifest["schema"] != 1 or manifest["releaseTag"] != f"gateway-{manifest['sourceRevision']}":
        raise ValueError("unsupported manifest or release tag")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?", manifest["version"]):
        raise ValueError("invalid version")
    targets = [record["target"] for record in manifest["artifacts"]]
    if sorted(targets) != sorted(TARGETS):
        raise ValueError("release must contain each candidate target exactly once")
    for record in manifest["artifacts"]:
        validate_record(record, manifest)
    return manifest


def assemble(directory, revision):
    manifest = {"schema": 1, "sourceRevision": source_revision(revision),
                "version": version(), "releaseTag": f"gateway-{revision}",
                "artifacts": [json.loads((directory / f"{target}.json").read_text())
                              for target in sorted(TARGETS)]}
    for record in manifest["artifacts"]:
        verify_archive(directory / record["file"], record, manifest)
    path = directory / "manifest.json"
    path.write_bytes(canonical(manifest))
    checksum = digest(path.read_bytes())
    verify_manifest(path, checksum)
    (directory / "manifest.sha256").write_text(f"{checksum}  manifest.json\n")
    return checksum


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
    args = parser.parse_args()
    if args.command == "native-target":
        print(native_target())
    elif args.command == "stage":
        if args.target != native_target():
            raise ValueError("staging requires a matching native runner")
        print(json.dumps(stage(args.binary, args.output, args.revision, args.target)))
    elif args.command == "assemble":
        print(assemble(args.directory, args.revision))
    else:
        manifest = verify_manifest(args.manifest, args.manifest_sha256)
        record = next(item for item in manifest["artifacts"] if item["target"] == args.target)
        verify_archive(args.directory / record["file"], record, manifest)
        print(f"verified {record['file']}; no executable was run or installed")


if __name__ == "__main__":
    main()
