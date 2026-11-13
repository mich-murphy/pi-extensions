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
| Nix reference | Full revision, trusted `narHash`, `#pi-gateway` |
| Package and app | `packages.<system>.pi-gateway`, `apps.<system>.pi-gateway` |
| Version | Read from gateway `Cargo.toml`; never separately maintained |
| Release tag | `gateway-<sourceRevision>` |
| Asset origin | GitHub Releases, exact revision tag (see below) |
| Manifest | `manifest.json`, schema 2, pinned SHA-256 in extension metadata |
| Archive | `pi-gateway-<version>-<Rust target>.tar.gz` |
| Members | `pi-gateway` 0755, `release.json` 0644; regular files only |

The Nix reference is
`github:mich-murphy/pi-extensions/<sourceRevision>?narHash=<encodedSRI>#pi-gateway`.
The trusted Nix catalog must ship the reviewed source tree's canonical SHA-256
SRI (`sha256-` plus padded base64 of 32 bytes). Derive it independently from a
trusted local `git archive <sourceRevision>` extraction using `nix hash path --sri`,
not solely from a downloaded source's self-reported hash. URL-encode the SRI as
one query value **before** the package fragment. Acquisition binds both the full
revision and exact trusted NAR hash before filesystem, network or command effects;
Nix then verifies fetched source content against that hash. The committed lock
file alone does not authenticate the top-level source. Keep the Nix catalog null
until the actual setup-capable source and its content pin are reviewed; historical
source-fetch verification is not new-source installation evidence.

Asset origin is
`https://github.com/mich-murphy/pi-extensions/releases/download/<releaseTag>/`.
Every native job asserts its architecture before building.

Nix resolves the revision's committed lock file and pinned Rust toolchain. Install
into an explicitly owned profile/root, not the default user profile. A store path
alone is not a GC root. Retain roots for the active and rollback versions. Never
auto-adopt an executable from PATH or an unreviewed local checkout.

The manifest records `sourceRevision`, `version`, `releaseTag`, and `artifacts`.
Each artifact records its target, Nix system, OS, architecture, runner, ABI,
conservative tested baseline, measured runtime requirements, filename, archive
size/SHA-256 and binary size/SHA-256. Embedded
`release.json` contains schema, source, version and target metadata. The manifest
must contain every target in `gateway/release/targets.json` exactly once.

Schema 2 replaces the unreleased schema 1 `minimumOs` field with `testedBaseline`
and `requirements`. Linux staging measures `requiredGlibc` and `requiredLibgcc`
from `readelf -V`, plus the ELF interpreter and needed libraries from `readelf`
program/dynamic headers. macOS staging reads `minimumMacos` from the executable's
`LC_BUILD_VERSION` or `LC_VERSION_MIN_MACOSX` load command, not from its CPU type
or SDK version. Staging fails if measured glibc/macOS requirements exceed the
conservative baseline. Lower symbol requirements do **not** lower the support
claim: loader, kernel, libgcc and platform-security behavior still need consumer
tests. Schema 1 was never publicly released; the updater deliberately requires
schema 2 rather than silently reinterpreting old metadata.

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
Linux jobs also run the native executable's loader/version smoke in a pinned
Debian bookworm image with runtime networking disabled, read-only filesystem,
no capabilities and an unprivileged UID. This narrow older-glibc smoke does not
expand the declared baseline or establish full gateway behavior. The
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
A usable pinned Nix build remains an independent acquisition path. The shipped
`onboarding/catalog.ts` currently has **no reviewed source pin and no native
manifest pin**. Discovery reports this as unavailable; this state is not a
production-ready installer. Do not fill it with the earlier foundation source
if the reviewed setup requires newer pairing capabilities.

## Acquisition implementation and recovery

`discoverGateway` only inspects technical facts and trusted extension metadata;
`discoverNixExecutable` probes `--version` at fixed absolute system paths with
a three-second limit, accepting upstream, Determinate and Lix version banners.
It does not download, build, edit trust settings or change profiles. A successful
version probe is not a promise that a daemon, network or build will work. If the
reviewed plan authorizes both paths, the setup coordinator may try pinned Nix
first and then the pinned native fallback after failure. Acquisition itself never
silently switches methods: each `AcquisitionPlan` names one exact method and pin.
Never authorize a fallback implicitly after Apply.

`acquireGateway(approvedPlan, options)` requires `approved: true`, exact catalog
source/version/manifest pins, a matching automatically detected host target, an
absolute private `installRoot`, and a bounded absolute `deadlineMs` (at most one
hour). The plan is copied/frozen before effects; an already-cancelled operation
has zero filesystem/network effects. `requiredCapabilities` adds flow-specific
capabilities to mandatory wire 1 and `managed-on-demand-v1` checks. New pairing
flows must require their helper capability; the old managed binary is insufficient.
The optional progress callback emits fixed technical stages, not downloaded data.
Fetch, exec and filesystem seams permit isolated integration tests; production
uses bounded Node fetch, filesystem operations and absolute `execFile` commands.

Native acquisition authenticates the manifest **before** using any artifact
claims, restricts HTTPS release/CDN redirects, bounds redirects, downloads and
gzip output, parses only two regular USTAR members in memory, verifies binary
hash/size and object architecture, then runs bounded `--version --json` with a
sanitized environment. There is no system tar, shell extraction or PATH lookup.
Each native attempt writes into a private per-attempt directory
`.gateway-<version>-<rev>-native-XXXXXX` that is never renamed. After
verification, the compatibility probe, a create-only completion marker and
fsync, publication is one exclusive `symlink(2)` of that bare basename at
`<version>-<rev>-native`. On Darwin and Linux this fails with `EEXIST` for any
existing entry, so it never replaces or merges into an empty directory, file,
symlink or other state. Once the link exists the attempt counts as committed:
later cancellation or a root fsync failure never removes it. If the symlink call
reports an error but this attempt's own link exists, the payload is retained.
On a collision, a concurrent winner is adopted only after the same bounded
reauthentication as reuse; any other entry is preserved untouched and the
attempt fails. A failed unpublished attempt removes only its own directory.
Unreferenced older attempts are neither adopted nor swept. Retention only keeps
state safe: production setup and repair pass a fresh `install-<random>` or
`repair-install-<random>` root on every call, so a retained committed or
uncertain payload is neither reused nor swept by a normal retry and stays as
unreferenced owned state. Only a caller that passes the same `installRoot` again
gets verified reuse of it. Reuse accepts only a
link whose target is exactly this pin's attempt-name pattern (no `/`, no
traversal), pointing at a private, account-owned, non-symlink directory, or a
legacy private directory at the versioned name; old installs are read without
migration. Reuse requires the pinned manifest, binary hash and a new capability
probe. The returned executable is the regular file inside the payload. Older
pi-comms builds fail closed on the new link layout rather than reinstalling.

Nix uses `build --out-link` at a dedicated private **per-attempt versioned** path,
never the default profile; experimental features are enabled for that command,
not by editing user settings. The out-link is a retained GC root for the returned
store executable. Because moving that link would invalidate its automatic GC
root, Nix roots are not renamed. A completion marker is written only after ABI
verification. A process crash can leave an incomplete uniquely named attempt;
a later Apply creates a different attempt, never adopts it, and is not blocked by
a fixed incomplete directory. Normal failure/abort removes only the current
attempt. Old incomplete roots and completed rollback roots are preserved for
explicit ownership-reviewed cleanup, never swept by name alone. Results report
absolute executable, owned paths, source/version and recovery effects. Nix store
objects/cache may remain after an aborted build; no user profile is modified.

A configured project binary is never discovered through PATH. Existing custom
installations are outside this ownership model. No quarantine clearing, trust
mutation, cache configuration, service registration or public release occurs.

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
