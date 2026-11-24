# Design

pi-peers keeps message delivery small and explicit. A gateway only routes. Each Pi session's adapter owns the inbox and receipts, all in memory.

## Receipts and idempotency

`message.id` is the idempotency key. Its namespace is the exact sender, recipient and scope. The adapter creates one id per `peers_send` call and keeps every authored field unchanged across at most three attempts within 15 seconds. Only the attempt id, `rid`, changes.

```mermaid
sequenceDiagram
  participant S as Sender adapter
  participant G as Gateway
  participant R as Receiver adapter
  S->>G: send (message.id)
  G->>R: deliver (message.id)
  R-->>G: admitted
  G-->>S: admitted
  Note over S,R: On loss or timeout the result is unknown. The sender retries with the same message.id.
```

| Receipt | Meaning |
| --- | --- |
| `admitted` | The receiver's volatile inbox holds the message. Not read, accepted or completed. |
| `not_admitted` | The attempt is known not to have admitted it. |
| `unknown` | It may already be admitted. A later rejection does not erase that doubt. |

A repeat with the same id and content returns the original receipt without a second enqueue or wake, even when the inbox is full. The same id with different content returns `id_conflict`. A receipt is kept for at least 10 minutes from first admission, and for as long as its payload is still in the inbox. After it expires, a late duplicate can be admitted again, so this is not permanent exactly-once delivery.

## PeerRef

A `PeerRef` is `machineId`, Pi's `sessionId` and a random `runtimeNonce`. The nonce changes whenever Pi reloads, starts a new session, forks or resumes. A send to an old nonce fails instead of reaching the replacement. A gateway reconnect keeps the identity and the in-memory state.

## Handles

Models address peers by handle, not by `PeerRef`. A handle names a session: `s-` and the first four hex digits of sha256 of `machineId` and `sessionId`, lengthened when another session in this runtime already holds that prefix. A handle is never reused for a different session, and it is local to the runtime that assigned it. A second live runtime of one session gets `/2`.

Each handle binds the exact runtime `peers_list` last saw. A send always goes to that `PeerRef`; the adapter never redirects a send to a newer runtime. A runtime that is still listed keeps its handle, whatever order the gateway lists it in. A new runtime takes the first handle of its session whose runtime is no longer listed, and that handle is marked restarted because the old runtime's unread inbox and receipts are gone; otherwise it gets the next free `/n`. `replyTo` takes a message id (or its `m-xxxx` alias) and resolves its sender from the last 256 taken messages; a reply to a restarted sender is refused rather than redirected.

Labels are what each session says about itself. `self` is decided by comparing `PeerRef`s, and no routing or permission depends on label text.

## Inbox, wake and take

Pi has no public way to know when a custom message it queued was actually consumed. Retiring it on `agent_settled` or `hasPendingMessages()` is unsafe: after Escape clears Pi's queue, a message that arrives during the abort stays queued even though both signals say idle. Releasing its charge would undercount. Keeping every unsure message charged would eventually fill the adapter. So message bodies never enter Pi's queue.

- The adapter keeps authored messages in its own bounded inbox.
- A new admission asks for a wake: one notice that counts the waiting messages and names their senders by handle, never the message itself. No notice is sent when the inbox is already empty.
- `peers_take` moves a batch of up to 8 messages into the conversation. It frees their inbox slots but keeps their receipts. A take that empties the inbox clears any pending wake.
- `peers_take` with `waitSeconds` waits for the first admission instead of polling. One waiter at a time; it ends on a message, its timeout, Escape, a disconnect or shutdown.

Wake rules:

- **Idle:** one notice goes out at once through `sendMessage` with `triggerTurn`. At most one notice is outstanding. Only its own `message_end` clears it, not a take, a timeout or settling. A notice that never shows up stays at one and the status reports it as `degraded_unobserved`.
- **Busy:** the adapter never sends. It records one pending wake. At the next `agent_before_settle` the pending wake becomes one notice and the run continues. Several arrivals share one notice.
- **Settled:** pending wake intent is cleared.
- **Compaction:** after a manual compaction succeeds or fails, one deferred check wakes the model if Pi is idle and a wake is pending. There is no polling.

Escape is Pi's own cancel. An aborted run skips `agent_before_settle`, so old messages are not announced again. Abort does not replay anything, restore text, mute peers or cancel remote work. Messages stay in the inbox until a take. Only a new authorized push can wake a later turn. Discovery, control traffic and duplicates never wake anyone.

Admission is not consumption. Replacing the runtime discards the inbox and receipts, and there is no offline mailbox.

Local tools do not wait on gateway recovery. While the gateway is unreachable, `peers_take` still returns already-admitted messages. Local tools never start recovery. After the bounded automatic reconnect episode gives up, the runtime stays disconnected until a remote tool runs its recovery preflight or `/peers reconnect` succeeds, and until then it receives no new deliveries. Discovery and sends keep the guarded recovery preflight and fail closed.

## Trust model

- Gateways talk over TLS 1.3 only, with mutual authentication. Session resumption and early data are off.
- Trust is one private CA you create. There are no system roots and no pinned leaves.
- A leaf must have exactly one DNS SAN, `gateway.<machineId>.pi.internal`. The address you dial is not an identity.
- Each issuer needs one complete CRL with a future `nextUpdate`. Delta, partitioned and indirect CRLs are rejected.
- Each gateway stores the highest CRL number it has seen per issuer in a revocation floor file. It refuses older or conflicting CRLs, even after a restart.
- Links need a correct clock. A link ends at the earliest certificate or CRL expiry, or after 24 hours. Every configured root must be currently valid, used or not.
- The local socket trusts the same user account, not individual processes.
