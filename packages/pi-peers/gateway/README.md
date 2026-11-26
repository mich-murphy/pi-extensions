# pi-gateway

A foreground routing process that connects Pi sessions on one machine, and optionally to one gateway on another machine over mutual TLS with pinned Ed25519 keys. It keeps no messages. It never installs a service or starts itself.

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
| `--diagnose` | Absolute config path | Read-only key and configuration snapshot; never evidence of a running gateway or live link. |
| `key generate\|show --input` | Absolute strict JSON input path `{"version":1,"privateKey":"/abs/key.der"}` | `generate` creates a new owner-only Ed25519 key (refusing an existing file); `show` reads one. Both print `{"version":1,"operation":…,"publicKey":"<64 hex>"}`. See [pinned keys](#pinned-keys). |
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
| `policies` | 64 or fewer | Grants. Each machine, scope and direction pair appears once. |
| `policies[].machineId` | Machine pattern | Machine the grant applies to. |
| `policies[].scopeId` | Listed in `scopeIds` | Scope of the grant. |
| `policies[].permissions` | 1–4 unique of `discover`, `push`, `read`, `interest` | Allowed actions. `read` and `interest` are retired: they still parse so older files start, but grant nothing. |
| `policies[].direction` | `outgoing` (default) or `incoming` | `outgoing`: your local sessions acting on that machine. `incoming`: that machine acting on your sessions. |
| `remote` | Optional object | One peer gateway. |
| `remote.machineId` | Machine pattern, not your own | Peer name. It must have a policy. |
| `remote.endpoint` | `{"mode":"listen"\|"connect","address":"IP:port"}` | One side listens, the other connects. A listener may use port `0`: the OS picks a free port and `ready` reports it. A connector must name a real port. |
| `remote.privateKey` | Absolute path | Your Ed25519 key file from `key generate`. |
| `remote.peerPublicKey` | 64 lowercase hex characters | The peer's public key, from its `key show`. It must not be your own. |

## Pinned keys

Each gateway has one Ed25519 key, and each pins the other's public key, like SSH
`known_hosts` (capability `pinned-keys-v1`). There is no CA, certificate, CRL,
revocation floor or expiry.

The handshake is TLS 1.3 with RFC 7250 raw public keys in both directions and Ed25519
signatures only; TLS 1.2 is refused. A peer is accepted only when it presents exactly the
pinned key; a certificate-presenting peer, any other key and a connection reflected back
to its own gateway are refused. Nothing expires: the link lasts until ping/close liveness
or loss ends it. Reachability is separate: run the link inside Tailscale or an SSH forward
(see [remote setup](../docs/remote-setup.md)).

| Requirement | Detail |
| --- | --- |
| Format | PKCS#8 v2 Ed25519 DER, as written by `key generate`. |
| Paths | Absolute, with no symlinks in any directory. |
| Permissions | Parent directory owned by you with mode `0700`. File owned by you with no group or other access and a single hard link. |

`--diagnose` reports `{"state":"configured","trust":"pinned","publicKey":"<own 64 hex>"}`
for a usable key. An unusable key file (`private-key`) or a pin equal to the own key
(`identity`) closes the remote side, **not** the local Unix gateway, and `--diagnose`
reports `{"state":"degraded","reason":…}`. Structural configuration errors remain hard
startup errors. Known remote TCP bind failures (address in use/unavailable or permission
denied) also leave local service running, with startup stderr reason
`remote degraded: remote-listen-unavailable`; there is no background rebind. Other
listener defects remain fatal. `--diagnose` does not bind or know actual startup bind
status: a configured key is not listener or live-link readiness.

A config whose `remote` still has the retired certificate fields (`rootCertificates`,
`certificateChain`, `issuerCertificates`, `crls`, `revocationState`) from gateway 0.3
never starts. `--diagnose` reports it as `{"state":"retired-certificates"}` so setup can
guide re-linking with keys.

## Timers and limits

| Item | Value |
| --- | --- |
| TLS handshake | 5 s |
| Ping after silence | 30 s |
| Close after silence | 90 s |
| Reconnect | 6 attempts per 60 s, with backoff from 250 ms, then the breaker opens |
| Breaker probe | 30 s doubling to 240 s, plus up to 25% jitter (always 30 s–5 min), forever |
| Pending inbound handshakes | 4 |
| Forwarded operation timeout | min(`budgetMs`, 15 s) less 250 ms per hop |
| Read assembly and queued write deadline | 5 s |
| Local connections | 30 |
| Operations per connection, total | 8, 256 |
| Remote sessions imported | 30 |
| Buffers | 8 MiB total, 256 KiB per local connection, 1 MiB for the remote link |

Local Unix connections have no heartbeat.

## Signals and restart

`SIGTERM` and `SIGINT` stop the gateway and remove its own socket. Changes to the config, keys or policies take effect only after a restart.
Update the config under the setup lock, then request a managed restart. Surviving
sessions must recover/re-register without replaying uncertain sends. A restart
acknowledgement does not claim remote connectivity.

## Output

Stdout has one line, `{"event":"ready","socketPath":"…","machineId":"…"}`. A gateway whose remote endpoint listens adds `"remoteListenAddress":"IP:port"`, the socket address it actually bound. With a configured port of `0` this is the only way to learn the port. Gateways without a remote, and connectors, omit the field. Stderr has coalesced JSON events, at most one per kind every 30 s, with `suppressed` counting the ones folded in: `{"event":"link_state","machineId":"…","state":"up|down|probing"}`, `{"event":"forward_timeout","remote":true|false}` and `{"event":"overloaded","resource":"…","op":"…"}`. They never contain payloads, paths or credentials. After 6 failed attempts in 60 s the link circuit breaker opens: sends to that machine fail at once with `link_down` for sessions that opted in, and the gateway keeps probing every 30 s to 5 min until a handshake succeeds. A local registration in a remote scope brings the next probe forward. It never stays down for good. Structural/bind startup failures print `Error:` and exit non-zero. Operational remote key failures leave local service available; `--diagnose` reports their sanitized degraded reason.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `invalid gateway configuration` | Unknown field, bad identifier, duplicate entry or an over-limit array. A `remote` without a matching policy fails too. |
| `private path ancestry rejected` | A directory on the path is a symlink, or is writable by others without the sticky bit. The socket's parent is not owned by you or is not `0700`. |
| `socket path too long` | Shorten `socketPath` to 100 bytes or fewer. |
| `remote credentials rejected` | Wrong key format or permissions, or a pinned key that is not the peer's. |
| `ready` but no link | Check the address, the open port and the roles. Exactly one side must listen. |
| `link_state` `down` repeating | Handshakes keep failing. Check the address, port and both pinned keys with `--diagnose`; the gateway keeps probing on its own. |

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

This proves only which configuration bytes were loaded, not key-file freshness
or live remote-link readiness. A pinned peer key lives in the configuration itself,
so changing the pin changes configuration bytes. The guard
does not retire old links serving surviving participants: the old daemon must exit.
An uncertain restart can leave an old pin serving existing sessions. Passive clients
must never automatically restart it or retry registration without the guard.
Managed restart remains a separate, single machine-bound request with unchanged
acknowledgement/uncertainty semantics; no hash is added to control requests.
