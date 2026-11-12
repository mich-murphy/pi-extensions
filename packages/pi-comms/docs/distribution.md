# Gateway distribution

Setup prefers the Nix package when Nix is usable, including an ordinary build on
cache miss. It does not require a clone, Cargo, a project-specific binary cache,
or changes to Nix trust settings. Acquisition and native service support are
separate checks. No release assets are published by the staging workflow.

## Immutable acquisition contract

The extension must ship a reviewed release pin containing a full 40-character
source revision and the SHA-256 of that revision's `manifest.json`. Do not derive
trust from a checksum downloaded alongside the executable. A manifest checksum
is an authentication anchor only when obtained through the trusted extension
release, not through the same mutable download location.

| Item | Contract |
| --- | --- |
| Nix reference | Full source revision, `#pi-gateway` (see below) |
| Package and app | `packages.<system>.pi-gateway`, `apps.<system>.pi-gateway` |
| Version | Read from gateway `Cargo.toml`; never separately maintained |
| Release tag | `gateway-<sourceRevision>` |
| Asset origin | GitHub Releases, exact revision tag (see below) |
| Manifest | `manifest.json`, schema 1, pinned SHA-256 in extension metadata |
| Archive | `pi-gateway-<version>-<Rust target>.tar.gz` |
| Members | `pi-gateway` 0755, `release.json` 0644; regular files only |

The Nix reference is
`github:mich-murphy/pi-extensions/<sourceRevision>#pi-gateway`. Asset origin is
`https://github.com/mich-murphy/pi-extensions/releases/download/<releaseTag>/`.
Every native job asserts its architecture before building.

Nix resolves the revision's committed lock file and pinned Rust toolchain. Install
into an explicitly owned profile/root, not the default user profile. A store path
alone is not a GC root. Retain roots for the active and rollback versions. Never
auto-adopt an executable from PATH or an unreviewed local checkout.

The manifest records `sourceRevision`, `version`, `releaseTag`, and `artifacts`.
Each artifact records its target, Nix system, OS, architecture, runner, ABI,
minimum OS/libc, filename, archive size/SHA-256 and binary size/SHA-256. Embedded
`release.json` contains schema, source, version and target metadata. The manifest
must contain every target in `gateway/release/targets.json` exactly once.

The downloader must bound network size/time, constrain origin and redirects,
verify the pinned manifest digest before parsing artifact claims, and verify the
archive and contained binary before execution. Reject extra members, links,
traversal, special files, incorrect modes and wrong object headers. Install
atomically into a private version directory; never extract over an existing
installation. The release helper verifies without extracting or executing code;
it is a release/test reference, not a requirement for users to install Python.

## Candidate platforms

| Target | Native staging runner | Conservative fallback baseline |
| --- | --- | --- |
| `aarch64-apple-darwin` | `macos-15` | macOS 15, arm64 |
| `aarch64-unknown-linux-gnu` | `ubuntu-24.04-arm` | glibc 2.39, arm64 |
| `x86_64-unknown-linux-gnu` | `ubuntu-24.04` | glibc 2.39, x86-64 |

These are candidate build targets, not a claim of completed native service or
clean-machine testing. Nix closures and standalone archives are different
products: do not distribute a Nix executable without its runtime closure as a
standalone archive. The fallback workflow builds with the runner's native linker
and the Rust version from `rust-toolchain.toml`. Intel macOS is untested and has
no initial catalog entry; it is not intrinsically unsupported. No musl/static,
older glibc or older macOS compatibility is promised. Do not bypass Gatekeeper,
clear quarantine, or weaken platform security to make acquisition succeed.

## Staging and publication gate

**Stage gateway release** runs on pull requests changing gateway sources,
release helpers, the workflow or flake inputs. A maintainer can also dispatch it
on the intended source revision. Pull-request candidates identify the tested
merge revision, not a published release. The workflow only uploads expiring
Actions artifacts, never
creates or modifies a public GitHub Release. Its token has read-only repository
permissions. Each native job records compiler identity, object linkage, version
JSON, source/run/runner metadata, the archive and its artifact record. The
aggregation job verifies the complete catalog and archives and emits
`gateway-release-candidate-<revision>`, containing `manifest.json`,
`manifest.sha256`, archives, records and per-target build evidence. This provenance
is auditable CI metadata, not a cryptographic signature or attestation.

Before enabling a downloadable fallback in a shipped extension:

1. Review the successful staging run, source revision, compiler, binary identity,
   dependency linkage and candidate baselines. If a runner changes architecture,
   fail and update the catalog deliberately rather than cross-building silently.
2. Test real consumer acquisition on each advertised native target, including
   loader/libc compatibility and macOS platform-security behavior. Record native
   service evidence separately; mocks do not establish it.
3. With explicit publication authorization, create tag `gateway-<revision>` at
   that exact source and upload the verified manifest and archives without
   rebuilding. Preserve workflow evidence. Do not overwrite existing assets.
4. Review and pin the exact published manifest SHA-256 and full revision in the
   extension's trusted release metadata, then verify a real consumer download.
   Adjacent `manifest.sha256` is useful for review, not self-authentication.

Until these gates pass, report fallback unavailable; do not ship fabricated
hashes, treat nonexistent URLs as working acquisition, or send users to Cargo.
A usable pinned Nix build remains an independent acquisition path.

## Contributor verification

Python 3.11 or newer is needed only for release helpers. Offline format tests
use synthetic object headers and are not native executable evidence:

```sh
python3 -m unittest discover -s packages/pi-comms/gateway/release -p 'test_*.py'
nix eval --no-write-lock-file .#packages.aarch64-darwin.pi-gateway.name
nix build --no-write-lock-file --max-jobs 2 --cores 2 .#pi-gateway
```

Assemble a directory containing all native archives and target record JSON files:

```sh
python3 packages/pi-comms/gateway/release/artifacts.py assemble \
  --directory release --revision <full-source-revision>
python3 packages/pi-comms/gateway/release/artifacts.py verify \
  --manifest release/manifest.json --manifest-sha256 <trusted-pin> \
  --directory release --target aarch64-apple-darwin
```
