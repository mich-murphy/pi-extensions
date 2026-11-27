# pi-gateway

A foreground routing process that connects Pi sessions on one machine, and optionally to one gateway on another machine over plain TCP inside a tailnet, identified and authorized by the local Tailscale daemon. It keeps no messages. It never installs a service or starts itself.

## Build

```sh
cargo build --locked --release
```

The binary is `target/release/pi-gateway`. For a two-machine setup, see [remote setup](../docs/remote-setup.md).

## Command line

| Flag | Argument | Effect |
| --- | --- | --- |
| `--config` | Absolute path to the JSON config | Runs the gateway until stopped. Prints one `ready` line on stdout once bound. |
| `--managed --config` | Absolute path to the JSON config | Runs while registered local sessions participate, with bounded startup and disconnect grace periods. |
| `--version [--json]` | None | Prints the version and exits without reading configuration or starting a gateway. JSON also reports supported wire versions and capabilities. |
| `--diagnose` | Absolute config path | Read-only configuration and Tailscale identity snapshot; never evidence of a running gateway or live link. |
| `--setup-lock` | Absolute permanent private lock path | Holds the exclusive setup flock while stdin stays open; emits a locked acknowledgement. Never unlink this lock. |
| `--request-restart` | Absolute config path | One machine-bound local managed restart request. Requires exact acknowledgement and disconnect; unknown outcomes are not retried. |

Choose one command form. `--managed` is valid only before `--config`.

### On-demand lifetime

Managed mode allows 10 seconds for the first local registration. After a local session has registered,
closing the last registered local connection starts a 750 ms grace period for reload/reconnect handoff.
A new registration cancels that deadline; otherwise the gateway exits cleanly and removes its socket.
Remote links and unregistered connections do not keep it running. Manual `--config` mode is unchanged.

Managed mode holds a private, permanent `<socketPath>.managed.lock` file for its lifetime. The file
records the socket incarnation so a later managed start can recover an exact recorded stale socket
following a crash. Unknown or replaced sockets, corrupt records and lock contention fail closed.
Never remove the lock file to bypass an active owner. The lock and record trust the same Unix account,
like the socket directory; connection refusal alone is not evidence that a listener is dead.
An interrupted bind/record write reports managed-ownership-ambiguous and preserves the
unproven socket. Stop participating sessions and select a new private socket path,
or obtain explicit ownership proof before manual recovery. Never unlink an unverified
socket or remove the permanent lock to make startup succeed.

This mode does not install a service or start another process. A launcher must start it on local session
demand, tolerate shutdown/registration races with bounded retries, and avoid restarting it after a clean
idle exit. Connection recovery must not replay application messages whose admission is unknown.

## Configuration

The config is strict JSON, 32 KiB or smaller, with no unknown fields.

| Field | Constraint | Purpose |
| --- | --- | --- |
| `machineId` | `^[a-z][a-z0-9-]{0,31}$` | This machine's name. |
| `socketPath` | Absolute, 100 bytes or fewer | Unix socket. Its parent is yours with mode `0700`. The socket is `0600`. |
| `scopeIds` | 1–64 unique, `^[A-Za-z0-9_-]{1,64}$` | Scopes this gateway serves. |
| `policies` | 64 or fewer | Grants for local sessions. Each scope appears once. |
| `policies[].machineId` | Your own `machineId` | Local grants only. What a remote may do comes from the tailnet policy file. |
| `policies[].scopeId` | Listed in `scopeIds` | Scope of the grant. |
| `policies[].permissions` | 1–4 unique of `discover`, `push`, `read`, `interest` | Allowed actions. `read` and `interest` are retired: they still parse so older files start, but grant nothing. |
| `policies[].direction` | Optional, only `outgoing` | Written by 0.3.0 setup; accepted and ignored. `incoming` is refused. |
| `remote` | Optional object | One peer gateway. |
| `remote.endpoint` | `{"mode":"listen"\|"connect","address":"IP:port"}` | One side listens on one of its own tailnet IPs, the other connects to the peer's tailnet IP. A listener may use port `0`: the OS picks a free port and `ready` reports it. A connector must name a real port. |
| `remote.tailscale` | Optional absolute path | The Tailscale CLI. Without it the gateway tries, in order, `/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale`, `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, `/usr/bin/tailscale`, `/run/current-system/sw/bin/tailscale` and `/nix/var/nix/profiles/default/bin/tailscale`. `PATH` is never searched. |

## Tailscale identity

Capability `tailscale-identity-v1`. The remote link is the plain frame protocol over TCP;
there are no keys, certificates or TLS. The peer's identity and permissions come only from
the local tailscaled, through `tailscale whois --json <ip>` and
`tailscale status --json --peers=false`.

The CLI must resolve to a file, and every symlink to it, owned by root or you and not
group- or world-writable; a `#!` wrapper's interpreter and the absolute files it names are
checked the same way. Each call has a fixed argument list, an environment with only a system
`PATH`, no stdin, a 2 s kill of its whole process group and a 64 KiB output cap. Any failure
refuses the link.

Before any byte is read or sent, both sides check that:

- the socket's local address is one of this node's tailnet IPs and the peer's is not;
- whois names a node whose `Addresses` contain the peer IP, which is not expired and is not
  this node (`StableID`);
- its MagicDNS name ends in this tailnet's suffix and its first label is a valid
  `machineId` other than your own; that label is the peer's `machineId`;
- on the listening side only, it holds at least one `github.com/mich-murphy/cap/pi-peers`
  grant toward this node. A connector keeps a link to a listener that holds no grant toward
  it: that listener may do nothing here, and every frame it sends is refused `forbidden`.
  This keeps one-way setups working.

The grant value is a list of `{"scopes":[…],"allow":["discover"|"push"|"reply"…]}` entries.
Each entry grants exactly its scopes × its verbs; entries never combine. `push` implies
`reply`; `*`, invalid scopes and unknown verbs grant nothing. More than 64 entries, 64 scopes
in an entry or 16 KiB of JSON grants nothing and refuses the link.

- `discover`: the peer receives roster entries for your sessions in those scopes.
- `push`: the peer delivers `request`, `update` and `reply` to your sessions in those scopes.
- `reply`: the peer delivers a `reply`, or an `update` with `replyTo`, only for a message one
  of your sessions sent it on this link: at most one reply and 8 updates within 600 s of the
  first send. The gateway keeps up to 4096 such entries per link; when they are full, new
  sends to that peer fail with `overloaded`/`receipts`. `reply` works without `discover`:
  the peer never sees your sessions in a roster, but it may still answer the sessions that
  sent it a message.

Your gateway asks the peer to export every one of your scopes and the peer filters by what
it grants you; local sessions see the exported entries without a local policy. Sends to
another machine are not checked against local policy: the destination decides. The peer's
whois is asked again every 15 s; a vanished, expired, renamed or re-keyed node or two failed
refreshes in a row close the link on either side, empty grants close it on the listening
side, and losing `discover` ends its watch.
Only one remote link is active at a time.

`--diagnose` reports `{"state":"configured","trust":"tailscale","endpoint":…,"self":{"name":…,"stableId":…,"addresses":[…]}}`,
and in connect mode also `"peer":{"name":…,"stableId":…,"tags":[…],"allow":[{"scope":…,"actions":[…]}]}`,
the grants that peer holds toward this node. Otherwise it reports `{"state":"degraded","reason":…}`
with `tailscale-missing`, `tailscale-not-running`, `tailscale-error` or `not-tailnet-address`
(the listen address is not one of your tailnet IPs, or whois does not know the connect target).
An untrusted or missing CLI closes the remote side, **not** the local Unix gateway. Known remote
TCP bind failures (address in use/unavailable or permission denied) also leave local service
running, with startup stderr reason `remote degraded: remote-listen-unavailable`; there is no
background rebind. `--diagnose` does not bind and is not evidence of a live link.

A config from before 0.4.0 never starts: a `remote` with certificate fields (`rootCertificates`,
`certificateChain`, `issuerCertificates`, `crls`, `revocationState`) or key fields (`machineId`,
`privateKey`, `peerPublicKey`), an `incoming` grant or a policy naming another machine.
`--diagnose` reports it as `{"state":"retired-certificates"}` so setup can guide re-linking.

## Timers and limits

| Item | Value |
| --- | --- |
| Link setup (status, whois, connect) | 5 s; each CLI call 2 s |
| Identity refresh | 15 s; 2 failures close |
| Ping after silence | 30 s |
| Close after silence | 90 s |
| Reconnect | 6 attempts per 60 s, with backoff from 250 ms, then the breaker opens |
| Breaker probe | 30 s doubling to 240 s, plus up to 25% jitter (always 30 s–5 min), forever |
| Pending inbound setups | 4 |
| Reply entries per link | 4096, 600 s each |
| Forwarded operation timeout | min(`budgetMs`, 15 s) less 250 ms per hop |
| Read assembly and queued write deadline | 5 s |
| Local connections | 30 |
| Operations per connection, total | 8, 256 |
| Remote sessions imported | 30 |
| Buffers | 8 MiB total, 256 KiB per local connection, 1 MiB for the remote link |

Local Unix connections have no heartbeat.

## Signals and restart

`SIGTERM` and `SIGINT` stop the gateway and remove its own socket. Changes to the config or local policies take effect only after a restart.
Update the config under the setup lock, then request a managed restart. Surviving
sessions must recover/re-register without replaying uncertain sends. A restart
acknowledgement does not claim remote connectivity.

## Output

Stdout has one line, `{"event":"ready","socketPath":"…","machineId":"…"}`. A gateway whose remote endpoint listens adds `"remoteListenAddress":"IP:port"`, the socket address it actually bound. With a configured port of `0` this is the only way to learn the port. Gateways without a remote, and connectors, omit the field. Stderr has coalesced JSON events, at most one per kind every 30 s, with `suppressed` counting the ones folded in: `{"event":"link_state","machineId":"…","state":"up|down|probing"}`, `{"event":"forward_timeout","remote":true|false}` and `{"event":"overloaded","resource":"…","op":"…"}`, and audit events `link_up` (StableID, name, login name, tags, addresses, cap digest), `link_down` (StableID, name, tags, addresses, cap digest), `link_refused`, `link_revoked`, `whois_failed`, `caps_changed` (digests), `refused` (StableID, verb, scope, rid, messageId, reason) and `reply_table_full`. They never contain payloads, labels, paths or credentials. After 6 failed attempts in 60 s the link circuit breaker opens: sends to that machine fail at once with `link_down` for sessions that opted in, and the gateway keeps probing every 30 s to 5 min until a link setup succeeds. A local registration in a remote scope brings the next probe forward. It never stays down for good. Structural/bind startup failures print `Error:` and exit non-zero. Operational remote Tailscale failures leave local service available; `--diagnose` reports their sanitized degraded reason.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `invalid gateway configuration` | Unknown field, bad identifier, duplicate entry or an over-limit array. A policy naming another machine, an `incoming` grant or a pre-0.4.0 `remote` fails too. |
| `private path ancestry rejected` | A directory on the path is a symlink, or is writable by others without the sticky bit. The socket's parent is not owned by you or is not `0700`. |
| `socket path too long` | Shorten `socketPath` to 100 bytes or fewer. |
| `remote degraded: tailscale-missing` | No trusted Tailscale CLI: set `remote.tailscale`, or fix ownership/permissions. |
| `link_refused` on stderr | The peer is unknown to whois, expired, outside your tailnet, has no `pi-peers` grant, or the route bypassed Tailscale. Run `--diagnose`. |
| `ready` but no link | Check the address, the open port and the roles. Exactly one side must listen. |
| `link_state` `down` repeating | Link setups keep failing. Check the address, the port and both sides' `pi-peers` grants with `--diagnose`; the gateway keeps probing on its own. |

## Link state events

Under wire v2 every registered session gets
`{"v":2,"op":"link.state","rid":<register rid>,"machineId":…,"state":"up"|"down"|"probing","since":<unix ms>,"nextProbe"?:<unix ms>}`
right after the register result and again on every change. `nextProbe` appears only while `down`. Sends to that machine are
refused with `not_admitted` code `link_down` whenever no link is up. `link.state` is valid only at the adapter-delivery boundary,
and `link_down` only in send results to local clients.

## Wire v2

Every frame has `"v":2`; v1 frames close the connection, except the upgrade path: a local `gateway.restart` request may be
`"v":1` and is acknowledged in the same version. `--request-restart` sends v1, so it can stop a running 0.2.0 gateway. `send` and `deliver` require `budgetMs` (0–60000), and a hop that
cannot forward a positive budget answers code `expired`. Send and deliver results carry `messageId` instead of `binding`, and
`admitted` adds `durable`. On the remote link, `send` `from`/`to` may be per-link peer numbers (see docs/design.md).

## Loaded configuration generation guard

Capability `config-generation-v1` adds optional local-only register field
`expectedConfigSha256` (exactly 64 lowercase hexadecimal characters). If present,
admission requires a managed daemon with an identical loaded configuration digest.
Mismatch, manual mode, or an unknown loaded digest returns register-only error
`config_mismatch` before any registration, roster, or local-participant lifetime effect.
The request field is local-client only. The error result is accepted on local-client
response validation and adapter-delivery ingress, but rejected on remote-link and
gateway-forward boundaries and for other operations. Omitting the field
preserves legacy/manual registration semantics. Wire version 1 and ready JSON are unchanged.

`Config::read` hashes the exact bounded bytes from the same read it successfully
parses, and retains that fingerprint for the daemon lifetime. Registration never
re-reads disk or reserializes JSON; even semantically identical differently formatted
configuration bytes have different fingerprints. The fingerprint is internal and
cannot be supplied through configuration JSON. In-memory `Config::parse` alone has
no loaded-file fingerprint and cannot satisfy guarded registration.

This proves only which configuration bytes were loaded, not tailnet grants
or live remote-link readiness; grant changes reach a live link through the 15 s
refresh, not through the configuration. The guard
does not retire old links serving surviving participants: the old daemon must exit.
An uncertain restart can leave an old configuration serving existing sessions. Passive clients
must never automatically restart it or retry registration without the guard.
Managed restart remains a separate, single machine-bound request with unchanged
acknowledgement/uncertainty semantics; no hash is added to control requests.
