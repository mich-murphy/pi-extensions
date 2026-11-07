# Pi Comms (`pi-comms`)

Opt-in collaboration between exact live Pi runtimes, with a separate bounded gateway. Messages and publications are deliberately authored; this extension does not export transcripts, discover project secrets, transfer arbitrary files, apply patches, or orchestrate remote tasks.

**Verification boundary:** the core implementation passed the full repository gate on macOS arm64 and Linux x86_64/glibc2.39. The later presentation-only update has a fresh full macOS gate, focused Linux tests/typechecking and real two-host terminal captures. Two real Pi1.5.0 runtimes and native release gateways pass cross-host verification using generated test credentials and offline recorder models, with gateway mTLS inside a temporary SSH tunnel. Direct TCP reachability, cross-host live-model behavior and production rollout are not established. Hosted GitHub Actions must also pass before merge; its status is tracked on the pull request. No gateway or user service is installed or started by the extension. See the [reproducible interoperability journey](test/spike/README.md#actual-two-host-interoperability).

## Components

- `index.ts` and `adapter/`: public Pi lifecycle hooks, TypeBox tools, one session-owned Effect runtime/service/wake queue/pump, bounded transport and sender retries.
- `state/`: volatile admission receipts, inbox payloads, scoped relations, publications and interests.
- `protocol/` and `fixtures/`: strict framing/Effect schemas and the shared exact-byte conformance corpus.
- `gateway/`: a single-worker Rust/Tokio foreground gateway. See [gateway documentation](gateway/README.md) for native build and security status.
- `test/spike/`: isolated, offline tests through the pinned real Pi CLI, including native terminal Escape.

## Explicit local configuration

The extension package is `pi-comms` and its native executable is `pi-gateway`. The existing `session-communication.json` configuration filename, `/session-communication` command and `session_*` tools are unchanged by the package rename.

Load this package through the repository's Pi extension package, or explicitly load its `index.ts`. Configuration is read only from `session-communication.json` in Pi's **user agent directory** (`getAgentDir()`), not from the current project. Missing configuration makes collaboration unavailable: no gateway registration, automatic daemon startup, publication or peer-triggered model work.

First provision a private, owner-only directory with no symlink ancestors for a Unix socket. The foreground gateway takes an absolute JSON configuration path:

```json
{
  "machineId": "workstation",
  "socketPath": "/absolute/private/directory/gateway.sock",
  "scopeIds": ["team"],
  "policies": [
    {
      "machineId": "workstation",
      "scopeId": "team",
      "permissions": ["discover", "read", "push", "interest"]
    }
  ]
}
```

The Pi adapter's configuration uses the same fields and adds an approved display label:

```json
{
  "machineId": "workstation",
  "socketPath": "/absolute/private/directory/gateway.sock",
  "scopeIds": ["team"],
  "label": "Engineering session",
  "policies": [
    {
      "machineId": "workstation",
      "scopeId": "team",
      "permissions": ["discover", "read", "push", "interest"]
    }
  ]
}
```

Paths above are placeholders, not automatically expanded or created. Policies are directional machine/scope permissions; task references never grant access. The local socket trusts the same user account, not individual-process attestation. Labels must not contain private working-directory or transcript information.

From the repository root, build and run the native process explicitly:

```sh
(cd packages/pi-comms/gateway && CARGO_BUILD_JOBS=2 cargo build --locked --release)
packages/pi-comms/gateway/target/release/pi-gateway \
  --config /absolute/path/to/gateway.json
```

Wait for its readiness JSON line. Reload Pi after configuring the extension. Use `/session-communication status` for connection, identity and bounded accounting; `/session-communication reconnect` starts an explicit bounded reconnect episode. There is no automatic service installation, root operation or idle shutdown.

## Tools

| Tool | Purpose |
| --- | --- |
| `session_peers` | Discover authorized live runtimes, optionally maintaining one scoped watch. Presence does not prove responsiveness. |
| `session_send` | Send an authored request, reply or update to an exact `PeerRef` and scope. |
| `session_take` | Explicitly retrieve a FIFO inbox batch, at most eight messages. |
| `session_state` | Read/list authorized current publications, or put/remove this runtime's own publication. |
| `session_interest` | Add/renew/remove a bounded interest in a publisher's known work. |
| `session_report` | Publish a work report and notify selected recipients or its direct requesters/interests, exposing each push outcome. |

A `PeerRef` contains `machineId`, Pi's opaque `sessionId`, and a random `runtimeNonce`. Discover and retain the complete reference. Reload/new/fork/resume replaces the runtime identity; a send never silently retargets a replacement. Gateway reconnection alone preserves a surviving adapter's identity and volatile state.

Messages support `text`, `markdown`, `git-diff` and `git-format-patch` as descriptive formats only. Resource and publication references are inert. Authenticated immediate-sender provenance and correlation classification accompany retrieved content; claims inside that content are not independently verified facts or higher-priority instructions.

Publication reads do not wake a publisher. Publications are current values, not a history store; `expectedRevision` mismatches are explicit. A work report commits its publication and selected terminal interests synchronously before sending. Publication failure prevents pushes; subsequent partial delivery failure does not roll back a successful publication. A later report invocation is a new authored action, not replay of the prior report.

## Codemode evaluation

The [direct-tools versus codemode evaluation](docs/codemode-evaluation.md) compares direct tools, codemode enabled alongside them (`on`), and codemode-only presentation. Twelve live GPT tasks answered correctly; eleven had exact operation traces. Codemode reduced aggregate output tokens and had lower observed elapsed times, but used more input tokens and did not reduce model requests. Enabled-by-default is a reasonable availability policy, not a proven efficiency optimum; mandatory codemode is not justified. The earlier Sonnet validation failure remains unresolved. Production tools, defaults and delivery semantics are unchanged.

## Watching a session

Collaboration uses Pi's ordinary tool rows, theme and expansion controls, not a separate chat panel or notification stream. Collapsed rows show a short runtime identity, message preview and precise outcome. Expand tool output with Pi's configured `app.tools.expand` binding (Ctrl+O by default) for complete authored content, exact identities, scope, correlation and receipts. Short identities are display hints, not usable `PeerRef` addresses; labels and message contents remain authored data.

- Healthy idle operation adds no persistent collaboration footer. Connection/configuration problems remain visible; `/session-communication status` provides explicit readable diagnostics and bounded accounting.
- Incoming wake notices are hidden and coalesced. There is no per-message toast, banner, sound or editor insertion. Native agent processing may still produce ordinary thinking, tool activity and a useful assistant response.
- Inbox retrieval shows a small batch preview; full payloads and provenance remain available on expansion. Model-visible tool content and structured results are unchanged by presentation.
- `Added to peer inbox` means volatile admission only—not reading, work acceptance or completion. Unknown delivery and nonadmission are visible without expansion. Mixed report outcomes do not hide a successfully committed publication or imply rollback.
- Discovery, publication/read/interest operations and protected duplicates do not wake their target. A tool deliberately invoked in the observing session still has its normal tool row.
- Previews are inert plain text, not automatically rendered Markdown, fetched links or applied patches. Visual shortening does not truncate transmitted messages or model-visible results.

Native Escape and the delivery guarantees below are unchanged. The extension does not add a model-narration policy or guarantee that a particular model will avoid repeating received content in its own response.

## Admission and idempotency

**`message.id` is the idempotency key.** Its namespace includes exact sender, recipient and scope. The adapter generates it once per logical send and keeps all authored fields immutable through at most three transport attempts within one 15-second deadline. Attempt IDs (`rid`) change; work and reply references are correlation, not deduplication keys.

- **`admitted`** means admission to the receiving adapter's volatile inbox. It does not mean model consumption, provider receipt, work acceptance, persistence or completion.
- **`not_admitted`** means the attempt is known not to have admitted the message.
- **`unknown`** means admission may already have happened. A later rejection cannot erase earlier uncertainty. Do not resend unknown work as a new message ID.

A protected same-key/same-value duplicate returns the original logical receipt without another enqueue or wake, even when fresh admission capacity is full. Changed immutable fields under that key return `id_conflict`. Receipts remain protected for at least ten minutes from first admission and while their payload is outstanding; duplicates do not renew that interval. Replacement loses volatile state. After legitimate receipt retirement, a delayed duplicate can be admitted again: this is bounded-window admission idempotence, **not permanent exactly-once work**.

## Native cancellation and bounded delivery

Authored payloads remain in an adapter-owned bounded inbox, not Pi's opaque native custom-message queue. Authorized new pushes request processing through a coalesced constant notice. Busy arrivals set fresh wake intent; normal settlement may append an actionable notice. Publication, reads, control traffic and protected duplicates do not wake a model.

Escape remains Pi's native cancellation. Abort clears wake intent without replaying or re-noticing old work, restoring text, muting future peers or cancelling a remote task. Inbox retrieval is explicit; retained payloads do not themselves trigger a replacement wake. A genuinely new authorized push can request a later native turn.

At most one identified idle notice is submitted but unobserved per adapter lifetime. Only its exact custom `message_end` retires that notice accounting—not a pending flag, settlement, timeout or inbox take. An exceptional unobserved notice stays bounded and is reported as degraded instead of being blindly resubmitted. This observation is scheduling evidence, not proof that a model read anything.

Taking a message releases its payload slot while keeping its protected receipt. Loss of a tool result does not create a replay guarantee. Runtime shutdown/replacement discards volatile inboxes, publications and interests; there is no offline mailbox.

## Bounds and validation

Frames are four-byte length-prefixed strict UTF-8 JSON, at most 32 KiB including the prefix. Duplicate/unknown keys, invalid Unicode, noncanonical number syntax and unsupported shapes fail the affected connection closed. Authored text has a 24 KiB decoded aggregate cap; escaping and envelope metadata can make otherwise valid content too large. Nothing is silently truncated or automatically fetched.

Important default bounds include 30 runtimes per gateway, four scopes per runtime, 64 outstanding inbox messages and 1 MiB, 1,024 protected receipts, 16 publications and 512 KiB, 256 combined relations/interests, and eight report recipients. Sender operations, watch queues, connection buffers, control reserves and aggregate buffers are independently bounded. These are policy limits, not throughput or total-process-memory guarantees.

Use the repository's existing validation commands:

```sh
npm run check
npm run check:rust
```

The full check retains formatting, strict TypeScript lint/type checks, coverage thresholds, Fallow and Markdown gates, and adds locked Rust fmt/check/clippy/test/rustdoc checks. Rust follows the pinned BeautifulRust lint policy with attribution; Hegel runs property tests in both languages. Real-Pi tests use isolated agent directories and an offline recorder, not real credentials or provider calls. Scoped green tests do not replace the whole-repository and security acceptance gates.
