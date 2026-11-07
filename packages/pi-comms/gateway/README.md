# Pi Gateway (`pi-gateway`)

A standalone, explicitly started volatile Unix routing daemon with an optional
single private-CA mTLS gateway peer. Local-only configuration remains supported.
The two-host path has actual macOS arm64 ↔ Linux x86_64/glibc2.39 verification
with two Pi1.5.0 runtimes, production adapters and native release gateways.
It uses generated test PKI and offline recorder models, with gateway mTLS inside
a temporary localhost-only SSH tunnel. Direct TCP probes timed out; no direct
reachability, production deployment approval, service installation, provider
evidence or measured SLA is claimed. See the
[interoperability journey](../test/spike/README.md#actual-two-host-interoperability).

## Explicit foreground CLI

Build from this directory with `cargo build --locked`. Start only when the user
requests it:

```sh
./target/debug/pi-gateway --config /absolute/path/config.json
```

Configuration is strict JSON with no unknown fields or implicit grants:

```json
{
  "machineId": "alpha",
  "socketPath": "/absolute/private-directory/gateway.sock",
  "scopeIds": ["team"],
  "policies": [
    {
      "machineId": "alpha",
      "scopeId": "team",
      "permissions": ["discover", "read", "push", "interest"]
    }
  ]
}
```

The existing socket parent must belong to the current effective user and have
owner-only permissions (0700). All ancestor directories must be owned by root or
the current user and not group/other writable, except trusted-owner sticky
directories whose next child also has protected root/current-user ownership.
This supports canonical macOS temporary roots and Linux `/tmp` without allowing
another UID to rename/swap a private child. The same ancestry rule protects
credential files and durable floor/lock discovery on startup and persistence. Symlink ancestry and existing socket paths are
rejected rather than followed or unlinked. The bound socket is chmod 0600.
Readiness is exactly one stdout JSON line after binding:
`{"event":"ready","socketPath":"...","machineId":"alpha"}`.
Signal handlers are installed before readiness. SIGTERM/SIGINT exit the foreground daemon and remove only its own socket inode.
No installation, autostart, service manager, credential discovery or deployment.

The framing API is `wire::decode_frame`; JSON-only fixtures exercise
`wire::decode_json`, while `wire::decode_body` validates assembled bodies. Raw
encoded descriptor spans, not just compact reserialization, obey the 512-byte cap.
The exact shared fixture corpus lives in `../fixtures/manifest.json`; tests read
raw byte files without regenerating lexical evidence. Domain publications,
relations and admission idempotency remain adapter-owned.

## Local behavior and bounds

One routing owner, at most 30 local connection tasks and one active remote stream
run on one current-thread Tokio executor. Each connection uses standard async read/write futures, a bounded
256-entry output channel and nonblocking queue offers. The aggregate event channel
has 68 entries. Byte reservations cover buffers retained in tasks and channels;
RAII releases charges on cancellation, failed offers and socket errors. Parser
admission conservatively reserves two body lengths for decoded strings and the
JSON decoder's temporary escape scratch copy, in addition to the input bytes. Retiring a
connection forbids new reservations without prematurely releasing still-owned bytes.

There is no fixed polling interval. Idle reads wait for the first byte without a
timer; assembly and queued writes then have absolute five-second deadlines. The
routing owner sleeps only until the earliest live forwarding deadline, or waits
without a timer when none exists. A deterministic paused-time test advances an
idle connection by one hour and asserts zero timer wake notifications. This is a
regression check, not a claim of measured process-level wakeups or CPU usage.

The local slice implements exact connection-owned registration (30 registrations,
30 total socket/task slots including unregistered clients), projected atomic discovery
and ordered watches, local send/read/interest forwarding, at most eight originated
operations per connection and 256 aggregate mappings, and exact response binding.
Forwarding expires after 15 seconds without retrying application work. Only a
receiver-originated bound receipt can produce admitted; possible admission followed
by loss, expiry or invalid receipt remains unknown. Retired well-formed results
are discarded without creating new operation state. Authorization precedes route
lookup, so denials do not disclose hidden runtime existence.

`budget::Buffers` charges retained serialized input, parser copies, forwarding
requests and output allocations against local/global C7 ceilings and control
headroom. Metadata/native allocations are additional, not claimed as covered by
serialized-byte accounting. Watch budgets use an internal monotonic generation, independent of wire rid reuse;
late write completions cannot release a replacement watch's counters. Forwarded
frames carry a private source-authorization epoch independent of wire identities.
Withdrawal drops an entirely unwritten frame; withdrawal during a partial write
closes the destination connection rather than emitting a truncated/reinterpreted
frame tail. The same source and target authorization guard and original enqueue +
five-second deadline cover both `write_all` and `flush`: accepting TLS plaintext
into a buffered writer is not completion. The single write timer is additionally
bounded by any source/target credential lease expiry, without a polling timer.
Watch quota/byte reservations are released
only after flush succeeds. Deterministic buffered-stream tests prove blocked-flush
deadlines, withdrawal, no premature write notification and charge cleanup.
This stops unforwarded data from escaping a withdrawn source lifetime; it does not
retract already-forwarded/admitted work. Watches
invalidate explicitly at bounded count/byte or
buffer saturation; exhausted control space closes the connection. Adapter inbox,
receipt, publication, relation and interest budgets are not gateway stores.

## Explicit optional remote configuration

Add one `remote` object to the existing configuration; no credential paths are
inferred. Exactly one gateway uses `connect`, the other `listen`, with matching
explicit IP address/port. The peer machine identity is independent of that address.
For example, alpha may add:

```json
{
  "machineId": "beta",
  "endpoint": { "mode": "connect", "address": "127.0.0.1:7443" },
  "rootCertificates": ["/absolute/private-directory/root.der"],
  "certificateChain": ["/absolute/private-directory/alpha.der"],
  "privateKey": "/absolute/private-directory/alpha-key.der",
  "crls": ["/absolute/private-directory/issuer.crl"],
  "revocationState": "/absolute/private-directory/revocation-floors.json"
}
```

Files are DER, not PEM; directories and files must be owner-only. The certificate
chain is leaf first and omits the trust anchor. Optional `issuerCertificates`
(maximum eight explicit DER paths) supplies non-trust issuer material when a CRL's
issuer is absent from the own chain and configured roots, such as a different peer
intermediate. Every configured CRL must have a known, unambiguous current CA issuer,
valid signature/AKI and current time interval before its floor can be committed.
These extra certificates never add anchors, authorize identities or bypass normal
TLS path verification. Roots, chain, CRLs and key retain their existing bounded
array/file limits; remote must name a different machine and have a relevant grant.

Policies gain optional `direction`: omitted/`outgoing` permits local callers acting
on the named machine; `incoming` separately permits that authenticated remote
machine acting on this gateway's local runtimes. There is no implicit `both`.
For a bidirectional pair, each gateway needs explicit appropriate grants, for example:

```json
[
  { "machineId": "beta", "scopeId": "team", "permissions": ["push"] },
  {
    "machineId": "beta",
    "scopeId": "team",
    "direction": "incoming",
    "permissions": ["read", "push", "interest"]
  }
]
```

The gateway ceiling is independent of—and cannot be widened by—the adapter's
counterpart capability policy. Discover/read/push/interest remain independent.
In particular, the example permits outgoing push without outgoing discovery.

Initialize a **new** durable floor explicitly through authenticated operator action:

```sh
./target/debug/pi-gateway --initialize-revocation-floor /absolute/private-directory/revocation-floors.json
```

The directory must already be private; existing state is never overwritten. Normal
startup rejects missing state, never invokes initialization and never resets floors.
It validates and durably installs the current bundle before binding/readiness, even
if that bundle revokes every peer and no subsequent handshake can succeed. Startup
rollback therefore fails before any application socket/listener is advertised.

## Remote roster, lifecycle and bounded acquisition

Each authenticated link exchanges exactly one own-machine scoped discover/watch
snapshot, followed by ordered ordinary roster events. This is trusted gateway
routing/source-binding metadata, **not model-facing discovery**. The internal
selection/export ceiling is the union of scopes having any configured capability
in either direction for that exact peer. No third-machine entries or unapproved
memberships can be imported/exported. Model-facing snapshots/events independently
require outgoing Discover and project only the caller's requested approved scopes.
Thus a push-only sender can be source-bound and routed without receiving a model
Discover grant; hidden scope memberships never reach its tools.

Incoming forwarded `from` must match an exact currently advertised remote runtime
and scope; targets must belong to the receiving machine. No local register/close on
TLS, third-machine transit, automatic retargeting, offline mailbox or replay exists.
Forwarding maps check operation, exact identity/scope/message bindings and retire
well-formed stale controls without allocating new work. Imported descriptors are
charged while retained; at most 30 per remote machine and 60 combined descriptors.
Own snapshots are queued before watch commit; overflow invalidates explicitly or
closes when even bounded control cannot be queued. A failed/invalidated remote
watch closes that link and withdraws all its routes; reconnect takes a fresh snapshot.

One current-thread router owns at most 30 local stream tasks plus one active remote
stream, with at most four pending accepted handshakes and a five-second absolute
TCP/TLS/floor-commit attempt deadline. Excess accepted sockets are dropped before
spawning TLS tasks. The one configured initiator makes at most six attempts in a
60-second episode with bounded exponential backoff/jitter. Exhaustion emits a
payload/path-free stderr `remote_unavailable` event and remains unavailable without
polling until explicit controlled restart or a fresh relevant local registration.
Neither link acquisition nor reconnect retries application sends.

Only complete authenticated structurally valid inbound frames reset progress;
partial TLS/header/body bytes do not. After 30 seconds, one bounded pending ping
is sent; any valid inbound progress may retire it. No second ping stacks, and 90
seconds without valid inbound progress closes the link. Local Unix clients have no
heartbeat. Credential/CRL expiry and the 24-hour link-age cap run under the same
mandatory lease as the actual TLS transport. Withdrawal invalidates per-runtime
source/target epochs, removes routes and drops unforwarded frames. A partly flushed
frame closes its destination rather than sending its remaining tail. Already
forwarded/admitted work is not retracted: outstanding sends retain unknown.

Root/CRL/identity/policy changes use authenticated provisioning plus controlled
SIGTERM/restart, not live network administration or a reload daemon. A stop removes
only the owned Unix socket inode; restart requires the same validated durable floor.
Emergency recovery is complete only when every affected verifier has applied the
update and closed its links. No production operator ownership/SLA is established.

Control headroom is an **outbound** allocation guarantee subject to global and
per-connection ceilings, not an inbound control-classification guarantee: all
unclassified input frames conservatively reserve Data before structural decoding.
Under Data saturation even an incoming control can close the affected connection;
there is no uncharged speculative parser, unbounded queue or preclassification
reactor. Metadata, TLS-internal buffers and native allocations are additional to
serialized-byte reservations, not falsely claimed as covered by those counters.

## Remote credential and revocation enforcement

`tls::Policy` provides TLS-1.3-only mandatory private-CA mutual-authentication
configurations. Normal rustls path/EKU and handshake-signature verification is
retained. Each machine's leaf must contain exactly one DNS SAN:
`gateway.<machineId>.pi.internal` (for example, `gateway.alpha.pi.internal` for
machine `alpha`). The configured remote machine ID selects the expected peer SAN;
the dial/listen address is not an identity, and CN/wildcard fallback is forbidden.
Supplemental checks require that exact SAN for both roles, complete
linear issuer coverage, direct complete signed CRLs, issuer AKI matching, current
thisUpdate/nextUpdate, and path expiry. Every configured root must be currently
valid, including unused roots, and every configured root expiry bounds every link.
This conservative policy prevents a normal verifier's alternate path choice from
evading trust-anchor validity checks: an expired or not-yet-valid unused root blocks
new links and credential checks until explicitly removed from active trust. Resumption,
tickets and early data are disabled. Partitioned, delta, indirect and unknown CRL
forms are rejected, not treated as complete coverage. No leaf pins or system roots.

Generated private-PKI tests use memory-stream tokio-rustls handshakes and ephemeral
keys, including wrong trusted client/server SAN/EKU, missing client certificate,
missing/stale/future/incorrect-signature/revoked CRLs, intermediate coverage,
expired roots, unsupported partitioned CRLs and a correctly signed CRL lacking
nextUpdate. `credential_expiry` returns the earliest applicable certificate/CRL
expiry, including all configured roots; `Trust::check_replacement` compares CRL
numbers/issue times and rejects rollback/equivocation against supplied prior state.
Full memory-stream regressions cover both verifier roles with an expired A anchor,
a valid B anchor and B-cross-signed A whose name constraints exclude the leaf.
The ordinary verifier previously chose expired A while supplemental checks followed
B; the conservative all-root validity rule now rejects the combined policy.

The supported CRL profile has exactly one complete CRL per issuer distinguished
name. Same-DN CA key rollover is unsupported and fails closed; use distinct issuer
DNs for staged rollover. Update comparison requires retaining every prior issuer's
revocation state, even after its root leaves active trust. Removing a root must not
silently erase its rollback floor. Explicit authenticated issuer retirement/migration remains pending; no reset or
retirement API silently discards protected floors.

`revocation::FloorStore` adds explicitly initialized, owner-only persistent floors.
Normal open rejects missing/corrupt state rather than resetting it. An exclusive
nonblocking file lock fences concurrent owners. Updates preserve retired issuers,
reject CRL rollback/equivocation, fsync a private temporary file, atomically rename
it and fsync its directory before reporting success. Storage is capped at 64 issuer
floors and 1 MiB; permission/symlink errors and persistence failures fail closed.
The caller must authenticate provisioning and validate CRL signatures/coverage/time
before applying floors. Restart/rollback, unchanged-on-refusal, retained-issuer,
concurrent-owner and unsafe-file tests use only isolated temporary paths.

`lease::LinkLease` owns an active stream future until the earliest verified own/peer
expiry, a 24-hour monotonic age cap, or explicit withdrawal. Expiry/withdrawal drops
the stream and pending buffers; fractional wall-clock seconds are not added as
expiry grace. Paused-time tests exercise precise deadlines and real memory-TLS
stream termination. Maintained host time is required; clock discontinuities require
withdrawal/revalidation, not extension of an existing lease.

`remote::Settings` prepares only explicitly named private DER credentials and
required existing floor state. It validates every configured issuer CRL, commits
its installation floor before startup readiness, and commits/rechecks before an
authenticated stream is activated. One nonblocking persistence permit stays inside
its blocking fsync job even if the handshake awaiter times out, preventing an
unbounded filesystem-job waitlist. The daemon always runs the returned mandatory
lease around the actual TLS connection task.

Generated-PKI verification includes actual loopback TCP and foreground two-daemon
journeys, not only memory-stream primitives: scoped snapshot/events, exact send
receipts, read/interest forwarding, independent directional grants, push without
Discover, authenticated source rejection, private-scope/third-machine/pre-snapshot
roster refusal, wrong trusted client identity, no transit, pending-handshake caps,
active credential expiry, unknown preservation, route withdrawal, explicit floor
CLI, and controlled restart/revocation-floor rollback refusal. Deterministic
paused-time tests separately cover ping/close timing, no stacked ping, reconnect
exhaustion, 24-hour age, and buffered-write cutoff. These are local isolated test
evidence, not remote Pi/provider compatibility, production deployment or benchmarks.
No real credentials have been accessed.

## Validation

Run from this directory for the pinned Rust 1.98.0 toolchain:

```sh
export CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 RAYON_NUM_THREADS=2
cargo fmt --check
cargo check --locked --all-targets --all-features
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-targets --all-features
RUSTDOCFLAGS="-D warnings" cargo doc --locked --no-deps --all-features
```

Tests include the shared corpus, isolated real-process Unix journeys, strict
configuration, aggregate/control budgets and real Hegel 0.52.0 properties. Hegel's
static engine avoids an unlocked nested Cargo build. Seeded property runs disable
the example database; they do not substitute proptest.

## Lint provenance

The complete Cargo lint settings and `clippy.toml` are from
[BeautifulRust](https://github.com/morganlinton/BeautifulRust), commit
`edd3e86087eda07983251056508fe3b8856d85d7`, under its MIT license (retained in
`lints/LICENSE`). This attribution licenses those upstream lint files, not the
application. Hegel is exactly pinned for replay; other Rust dependencies use Cargo
ranges with a committed lockfile and locked validation gates.
