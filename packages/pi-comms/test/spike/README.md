# Public-Pi lifecycle/admission spike

## Result and scope

**Feasible bounded choice: adapter-owned inbox + coalesced wake + explicit take.**
Do not use direct custom-body submission with retirement based on
`agent_settled` or `hasPendingMessages()`: the live counterexample below disproves
that accounting rule. Retaining ambiguous direct submissions until runtime
replacement is fail-safe saturation, **not** the selected inbox fallback.

This is test-only evidence, not the production adapter or protocol implementation.
All authored fixtures, runners, tests and evidence are in this directory.
The parent owns the design contract, package configuration and acceptance of the
next implementation phase. The fixture does not implement authorization, framing,
C6a's complete identity-scoped receipt ledger, expiry, transport retries or TLS.
Its local control socket is a test controller, not a proposed wire protocol.

The executed target is **Pi 1.5.0**, with an offline synthetic model. Success proves
Pi scheduling and public-hook behavior, **not** model reading, provider submission,
persistence, work acceptance or completion. Session context is not an acknowledgment.

## Reproduce

From the repository root, after the parent's pinned dependencies are installed:

```sh
RAYON_NUM_THREADS=2 UV_THREADPOOL_SIZE=2 GOMAXPROCS=2 \
  node_modules/.bin/vitest run \
  packages/pi-comms/test/spike/lifecycle.test.ts --maxWorkers=2
```

The Vitest test invokes seven Python standard-library journeys against the actual
pinned CLI. Python must have Unix PTY support. Each child gets a new temporary
HOME, agent directory, cwd and session directory. The child environment is an
allowlist, not the caller's provider/auth environment. Automatic network activity
and telemetry are disabled; only the in-process synthetic `spike/recorder` model is
selected. No network provider, private profile, remote service or credential is
used. No shell startup/profile is sourced. No SDK/private host methods implement
the behavior under test.

To regenerate the derived evidence trace:

```sh
RAYON_NUM_THREADS=2 UV_THREADPOOL_SIZE=2 GOMAXPROCS=2 \
  PI_SPIKE_EVIDENCE=packages/pi-comms/test/spike/evidence.json \
  python3 packages/pi-comms/test/spike/offline.py
```

`PI_SPIKE_PACKAGE` can explicitly select another installation of the same pinned
version, for example the installed Homebrew Pi. The runner asserts package version
1.5.0 before starting. By default it uses this checkout's pinned node_modules Pi.
`PI_SPIKE_EXTENSION` is the fixture entry path; the Vitest wrapper resolves it.

Every child is drained continuously. RPC framing splits on LF only. TUI journeys
use a real PTY and send native Escape, not an extension-specific abort mode.
Shutdown checks exit status zero, the public quit hook and reader termination;
children, sockets, timers, pipes and temporary directories are cleaned in failure
paths as well. A forced-kill fallback fails the test rather than claiming cleanup
success. The independent control socket allows precisely timed pushes during a
held model request, abort unwinding, compaction, and settled handlers.

## Executed evidence

`evidence.json` contains the seven successful journey traces, version assertion,
fixture hashes, shutdown exits and test totals. It is a **derived** trace: repeated
system prompts/control traffic are omitted and recorder requests retain roles and
peer markers instead of full transcripts. The tests assert against the full
isolated raw event log while running. No saved trace is replayed as a test result.

| Journey | Assertions exercised |
| --- | --- |
| RPC admission/lifecycle | Idle and busy push; public void return; duplicate/conflict; state reads do not wake; custom context filtering; transient retry; terminal error; overflow compact/retry; manual compaction and failure; settled deferral; reload/new nonce replacement |
| Direct-body native Escape | Before-clear payload disappears without editor restoration; during-abort payload survives past settled; future fresh push wakes; no replay of cleared body; bounded submitted-unobserved count/bytes and duplicate under saturation |
| Coalesced inbox + explicit take | Four-entry inbox saturation; no busy native notices; clear-queue + abort leaves inbox owned by adapter; no automatic replay; deliberate later take frees slots; new admission wakes |
| Inbox native Escape + busy boundary | Before/during-abort inbox arrivals remain bounded; abort produces no replacement notice; duplicate does not wake; future new push wakes and tool takes; normal busy pushes coalesce through an actionable boundary |
| Eight abort/take cycles | 32 fresh payload admissions; exactly 16 idle notices submitted and observed; maximum one unobserved native notice; zero busy native notices or post-abort boundary reissues; all payload slots freed only by explicit take |
| Arrivals during settled handlers | Three admissions share one deferred native notice; no notice observation until all settled handlers finish; one take transfers all three |
| Manual-compaction arrivals | Success hook is still busy; one deferred idle check wakes the inbox afterward; compaction failure surfaces truthfully, notice observation releases only the notice, later new admission can wake/take remaining payloads |

Latest focused validation passed: **two Vitest tests wrapping seven spike and
two production-adapter offline journeys**, scoped Oxfmt and Oxlint, and root
`tsc --noEmit`. This is not a claim that the parent's whole-repository
coverage/Fallow/CI gates have passed.

Compaction needs an eligible cut. An early experiment compacted a very short
transcript immediately before injecting overflow, leaving no eligible cut and
therefore no compaction hook. The final assertions create sufficient spans and
verify actual manual/overflow hooks and retry ordering, not a fabricated hook.

## Why direct-body settled retirement is unsafe

The real TUI trace establishes this order:

1. A human request holds the offline model busy.
2. A peer custom body is admitted and submitted before Escape.
3. Native Escape clears queues and aborts. The pre-Escape custom body is not
   restored into the editor and never reaches the recorder.
4. Another peer body arrives **after native clearing, during abort unwinding**.
5. `agent_settled(aborted: true)` occurs with public `pending: false`, yet the
   during-abort body remains submitted-unobserved.
6. A later genuinely new push wakes Pi. The during-abort body is then observed
   through custom `message_end` and appears in the offline request. The cleared
   pre-Escape body does not reappear.

Thus settled plus a false public pending flag does not identify native-cleared
custom bodies. Releasing all payload charges there would undercount live payloads
still held in Pi. A timeout is not better evidence. Keeping every ambiguity charged
forever instead eventually saturates the direct-body adapter. Neither is the
selected delivery strategy.

An exact custom `message_end` is useful **host scheduling observation**, but does
not prove model consumption: the context-transform test filters an observed custom
message before the recorder receives its request. Retry, compaction and terminal
error likewise do not turn admission into execution or persistence.

## Selected pump and accounting policy

The supported fallback keeps authored bodies out of Pi's opaque native queue.
The reduced fixture has four payload slots, 4096 decoded content bytes and 32
receipt records; these are small test limits, not C7's production capacities or a
serialized-wire-byte implementation. Protected duplicate receipts do not enqueue,
notify or consume another payload slot. The production adapter must implement the
full contract's independent count, encoded-byte, fingerprint and receipt bounds.

### Idle and settled-handler admission

A new admission synchronously commits its inbox body and capacity reservation.
If public `ctx.isIdle()` is true, the pump may send one **constant notice**, never
the authored body, using documented `sendMessage(..., { triggerTurn: true,
deliverAs: "steer" })`. It reserves an identified notice latch before the void call.
Only one unobserved native notice is allowed, including while settled handlers
are still running and Pi defers requested work.

The native notice latch retires **only on its exact identified custom
`message_end`**. Neither `hasPendingMessages()`, `agent_settled`, timeout, inbox take,
nor a send return value retires it. Model errors after this observation do not
recreate the notice or body. An exceptional unobserved/async-failed submission
stays bounded at one notice; the spike does not manufacture delivery certainty or
blindly resubmit it. Runtime replacement discards the volatile adapter instance.

### Busy admission

A busy admission stores its body in the bounded inbox and sets one fresh wake
intent. **It never calls `sendMessage` while busy.** This prevents native payload
migration and accumulation of opaque busy notices, including arrivals after native
queue clearing but before abort settlement.

On a normal `agent_before_settle`, one fresh wake intent becomes one constant
`custom_message` boundary entry plus `continue: true`. This is Pi's documented
public actionable boundary, not a private queue API or a new receive mode. It
creates no native pending-message submission. Multiple busy arrivals coalesce.
If the model does not take the inbox, that old notice does not cause an unbounded
continuation loop; another genuinely new admission can request another wake.

On `agent_settled`, outstanding wake **intent** is cleared; this is not retirement
of a native notice latch or any payload. Aborted runs skip `agent_before_settle`,
so they do not automatically re-notice old work. A subsequent fresh authorized
push may request a new wake. A duplicate or state read may not.

### Compaction

Manual compaction is distinct from an agent run: successful `session_compact`
still sees busy, and no agent-settled boundary is guaranteed afterward. Its handler
schedules **one** `setImmediate` check; a non-aborted `session_compact_failed` also
schedules one. The callback only pumps if public `isIdle()` is then true and fresh
wake intent exists. It never polls or submits while busy. For an automatic
compaction still inside an active run, the ordinary actionable boundary handles
remaining intent. Deferred checks are canceled on runtime shutdown.

This timing was exercised through the real CLI for manual success and failure.
A future Pi change where that one check remains busy without a later agent
boundary needs fresh lifecycle evidence; do not replace it with unbounded polling.

### Explicit take and replacement

`spike_take` is a real registered tool called by the offline model. It synchronously
removes a bounded inbox batch and releases those payload reservations exactly
once. It does **not** release a native notice latch, retract admission receipts,
claim the model read its result, or restore a taken body after abort/error.
Unretrieved inbox bodies remain bounded and can explicitly overload; that is real
inbox occupancy, not permanently ambiguous native-submission accounting.

Previously admitted but never submitted bodies may be included in a later explicit
take. This is inbox retrieval, not automatic replay of a native-cleared body.
Receipts remain independent so duplicate sends still return admitted without
recreating work. The synthetic model is scripted to take; a real model is not
required or proven to do so. Reload/new emits shutdown, creates a fresh nonce and
empty volatile state, and does not retarget/replay old work. No durable history or
resumed-session guarantee is inferred from context.

## Public references and source corroboration

Before implementation, the installed 1.5.0 `extensions.md`, `rpc.md` and `sdk.md`
were read in full, together with relevant custom-provider/environment/compaction
and RPC command/event sections. Relevant examples included `file-trigger.ts`,
`reload-runtime.ts`, `trigger-compact.ts`, `custom-compaction.ts`, `rpc-client.ts`
and the minimal/custom-model/extensions/full-control/session-runtime SDK examples.
Repository README, lint/dead-code rules and skill-toggle lifecycle/recorder tests
provided project conventions.

The pinned `dist/core/agent-session.js` was inspected **as evidence only**:
`sendCustomMessage` busy custom submissions go directly to the agent queue;
`pendingMessageCount` counts the separate human-text steering/follow-up arrays;
`clearQueue` clears native queues; `_emitAgentSettled` defers handler-requested
work; manual `compact` clears its busy state after the success extension hook.
The fixture calls none of these private methods or fields.

RPC `abort` alone is not native Escape. The pinned public RPC reference explicitly
uses `clear_queue` then `abort`; native TUI Escape is tested separately. Public
`sendMessage` returns void, `agent_end` is not final idle, and notification-only
`agent_settled` is not an acknowledgment of queued custom-message delivery.

## Production-adapter follow-up checkpoint

`production.py` and `production-extension.ts` exercise the actual `index.ts` and
adapter modules through real pinned offline Pi, with a temporary simulated Unix
gateway. The Vitest wrapper now runs these two additional journeys alongside the
seven bounded-spike journeys. They establish config opt-in, real public tools,
provenance-bearing take, duplicate/read no-wake, reload nonce replacement and three
real TUI abort/fresh-push/take cycles (six identified idle notices, no busy native
submissions). This is not a native-gateway or TLS attestation.

The separate mandatory `../adapter-native.test.ts` now launches the configured
foreground native gateway and two real adapter runtimes. It verifies discovery,
bound admitted receipts, same-ID deduplication/conflict, explicit take, read/list,
interest registration, terminal report fanout, route withdrawal and uncertainty.
A local Unix proxy drops an actual admitted receipt and withdraws the destination;
the sender's same-ID retry sees `no_route` without erasing possible admission.
Build the locked gateway first (the root check does so), or select an existing
binary with `PI_SESSION_GATEWAY_BINARY`. The native test never silently skips or
installs a service. This is local transport evidence, not a TLS attestation.

In-process tests exercise public extension registration, tools, scoped watch
updates, cancellation/deadline isolation, parser failures, operation bounds and
precommit report reservations. Blocked-write tests use real Node Writable
completion callbacks and a fake monotonic clock: queued writes retain their
original five-second deadlines, control bytes have an independent 32 KiB ceiling,
and caller cancellation cannot release still-blocked writes. The focused
adapter/index coverage gate passed **93.69% statements, 87.71% branches and 93.74%
lines**, with 46 Vitest tests across five files including the native slice and two
CLI wrappers. CLI subprocess tests
do not themselves contribute parent Vitest coverage. The native Hegel policy and
rendering property uses 200 deterministic cases. Owned adapter, entry point and
spike scopes pass Fallow complexity health with the existing thresholds; fixture
helpers are not excluded or assigned artificial coverage.

## Actual two-host interoperability

`interop.py` and `interop_endpoint.py` compose **two actual pinned Pi processes,
two production adapters and two real native gateways**. Unlike the earlier
production-adapter fixture, gateway traffic and receipts are not simulated.
The recorder models remain offline: observed tool results are separate evidence
from admission, not proof of a real model understanding or accepting work.

The executed pair is macOS arm64/Node26 and Linux x86_64/glibc2.39/Node24, both
Pi1.5.0 and Rust1.98-built release gateways. The harness asserts both-direction
discovery, requests/verified replies and provenance-bearing takes; both-direction
publications/reads without peer wakes; interests and progress/terminal reports;
gateway restart with retained adapter identity/publication; and Pi reload with
stale-runtime rejection and successful fresh targeting. It requires identical
production-source, fixture and endpoint-controller hashes on both machines.
`interop-evidence.json` records the parent's successful cross-host run, platform
and binary/source identities, assertions and cleanup—not a replayed transcript.
It predates the `pi-comms`/`pi-gateway` rename: its original names and hashes are
preserved as historical evidence, not rewritten or claimed to attest the renamed
source. Reproduction commands below use the current names.

Each run creates a private test CA, exact `gateway.alpha.pi.internal` and
`gateway.beta.pi.internal` DNS SAN leaves, current full numbered issuer CRLs,
private DER credentials and explicitly initialized floors. Native TLS verification
is never bypassed. CLI children have private HOME/agent/session directories,
allowlisted environments and no discovered context/project extensions. Only
synthetic results and hashes go into optional evidence; temporary raw logs,
credentials and runtime directories are removed before success is reported.

For a two-gateway local loopback reproduction, first build the release binary:

```sh
CARGO_BUILD_JOBS=2 cargo build --release --locked \
  --manifest-path packages/pi-comms/gateway/Cargo.toml
python3 -I packages/pi-comms/test/spike/interop.py \
  --evidence /tmp/pi-session-interop-local.json
```

Cross-host verification is **manual and opt-in**, not an automatic CI SSH job.
Prepare an authorized private scratch directory on the remote host containing
`source/` with matching source/dependencies/release binary, `node/bin/` with the
selected Node runtime, and `interop/interop_endpoint.py` copied from this checkout.
Do not copy real profiles or credentials. Then use an existing strictly verified
SSH alias:

```sh
python3 -I packages/pi-comms/test/spike/interop.py \
  --ssh-host YOUR_VERIFIED_TEST_HOST \
  --remote-root /absolute/private-scratch/source \
  --ssh-tunnel \
  --evidence /tmp/pi-session-interop-cross-host.json
```

The verified cross-host path is **gateway TLS1.3 mTLS inside one temporary,
localhost-only SSH forward**. The harness rejects inherited additional forwards,
does not forward the SSH agent, and owns/terminates the tunnel. Direct TCP probes
to the real Linux host timed out; this run does not establish direct reachability
or diagnose its network policy. For a separately reachable direct path, omit
`--ssh-tunnel` and explicitly supply `--connect-address`, `--listen-address` and
an accurate `--transport-label`. No firewall changes or service installation are
performed. Production credential ownership, rollout and any direct-network
configuration remain separate operational decisions.
