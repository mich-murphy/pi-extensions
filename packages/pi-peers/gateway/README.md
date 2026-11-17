# pi-gateway

A foreground routing process that connects Pi sessions on one machine, and optionally to one gateway on another machine over mutual TLS. It keeps no messages. It never installs a service or starts itself.

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
| `--diagnose` | Absolute config path | Read-only credential/floor snapshot; never evidence of a running gateway or live link. |
| `pair OP --input` | Absolute strict JSON input path | Explicit create/join/issue/import/renew/revoke/export/inspect or import-existing; public-only JSON output. See [native provisioning](PAIRING.md). |
| `--setup-lock` | Absolute permanent private lock path | Holds the exclusive setup flock while stdin stays open; emits a locked acknowledgement. Never unlink this lock. |
| `--request-restart` | Absolute config path | One machine-bound local managed restart request. Requires exact acknowledgement and disconnect; unknown outcomes are not retried. |
| `--initialize-revocation-floor` | Absolute path for the new floor file | Creates the floor file and exits. It refuses to overwrite existing state. |

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
| `policies[].permissions` | 1–4 unique of `discover`, `read`, `push`, `interest` | Allowed actions. |
| `policies[].direction` | `outgoing` (default) or `incoming` | `outgoing`: your local sessions acting on that machine. `incoming`: that machine acting on your sessions. |
| `remote` | Optional object | One peer gateway. |
| `remote.machineId` | Machine pattern, not your own | Peer name. It must have a policy. |
| `remote.endpoint` | `{"mode":"listen"\|"connect","address":"IP:port"}` | One side listens, the other connects. A listener may use port `0`: the OS picks a free port and `ready` reports it. A connector must name a real port. |
| `remote.rootCertificates` | 1–4 paths | Trusted roots. |
| `remote.certificateChain` | 1–8 paths | Your chain, leaf first, without the root. |
| `remote.issuerCertificates` | 0–8 paths | Extra issuers used only to verify a CRL. They add no trust. |
| `remote.privateKey` | Path | Your leaf's private key. |
| `remote.crls` | 1–16 paths | One complete CRL per issuer. |
| `remote.revocationState` | Path | Floor file from `--initialize-revocation-floor`. |

## Credential files

| Requirement | Detail |
| --- | --- |
| Format | DER, not PEM. |
| Size | 1–65,536 bytes each. Roots and CRLs together 512 KiB or less. |
| Paths | Absolute, with no symlinks in any directory. |
| Permissions | Parent directory owned by you with mode `0700`. File owned by you with no group or other access and a single hard link. |
| Chain | Leaf first. |
| SAN | Exactly one DNS name, `gateway.<machineId>.pi.internal`. |
| CRLs | Current, complete, signed by a known issuer, with a CRL number and `nextUpdate`. |

Remote credential problems (expired/missing/invalid leaf or CRL, missing/corrupt or
rolled-back floor) close the remote side, **not** the local Unix gateway. Structural
configuration errors remain hard startup errors. Known remote TCP bind failures
(address in use/unavailable or permission denied) also leave local service running,
with startup stderr reason `remote degraded: remote-listen-unavailable`; there is
no background rebind. Other listener defects remain fatal. Run
`--diagnose ABS_CONFIG` for sanitized reason codes and earliest credential expiry
warnings. It reads a snapshot without floor locks or writes, including while a
running gateway owns its floor. It does not bind or know actual startup bind
status: configured credentials are not listener or live-link readiness.

Pairing keeps the pair-specific issuer key in a separate private directory, never in
runtime config or the long-running gateway. Same-account directory separation is
not privilege isolation; root/account compromise requires new-root re-pairing on
both hosts, not floor rollback. Leaves last 90 days, CRLs 30 days, roots 365 days.
See [provisioning and maintenance](PAIRING.md) for confirmation and custody details.

## Timers and limits

| Item | Value |
| --- | --- |
| TLS handshake and floor commit | 5 s |
| Ping after silence | 30 s |
| Close after silence | 90 s |
| Link age cap | 24 h, or the earliest certificate or CRL expiry |
| Reconnect | 6 attempts per 60 s, with backoff from 250 ms |
| Pending inbound handshakes | 4 |
| Forwarded operation timeout | 15 s |
| Read assembly and queued write deadline | 5 s |
| Local connections | 30 |
| Operations per connection, total | 8, 256 |
| Remote sessions imported | 30 |
| Buffers | 8 MiB total, 256 KiB per local connection, 1 MiB for the remote link |
| Revocation floors | 64 issuers, 1 MiB |

Local Unix connections have no heartbeat.

## Signals and restart

`SIGTERM` and `SIGINT` stop the gateway and remove its own socket. Changes to the config, roots, CRLs or policies take effect only after a restart. Restart needs the existing floor file. Existing pair imports stage validated immutable
credentials without advancing the live floor, returning activationRequired=true.
Update the config under the setup lock, then request a managed restart. Surviving
sessions must recover/re-register without replaying uncertain sends. Startup commits
the staged CRL floor before enabling remote service. Neither staging nor a restart
acknowledgement claims remote connectivity.

## Output

Stdout has one line, `{"event":"ready","socketPath":"…","machineId":"…"}`. A gateway whose remote endpoint listens adds `"remoteListenAddress":"IP:port"`, the socket address it actually bound. With a configured port of `0` this is the only way to learn the port. Gateways without a remote, and connectors, omit the field. Stderr has `{"event":"remote_unavailable","reason":"reconnect_exhausted"}` when the connector gives up. It then stays down until you restart it or a local session registers again. Structural/bind startup failures print `Error:` and exit non-zero. Operational remote credential failures leave local service available; `--diagnose` reports their sanitized degraded reason.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `invalid gateway configuration` | Unknown field, bad identifier, duplicate entry or an over-limit array. A `remote` without a matching policy fails too. |
| `private path ancestry rejected` | A directory on the path is a symlink, or is writable by others without the sticky bit. The socket's parent is not owned by you or is not `0700`. |
| `socket path too long` | Shorten `socketPath` to 100 bytes or fewer. |
| `remote credentials rejected` | Wrong format or permissions, wrong SAN, expired certificate or CRL, a revoked leaf, or a CRL older than the floor. |
| `revocation commit busy` | Another gateway holds the floor file. Use one file per gateway. |
| `ready` but no link | Check the address, the open port and the roles. Exactly one side must listen. |
| `remote_unavailable` | The connector gave up. Fix the cause and restart. |

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

This proves only which configuration bytes were loaded, not PKI-content freshness
or live remote-link readiness. Supported onboarding writes immutable credential
paths for each generation, so trust updates change configuration bytes. The guard
does not retire old links serving surviving participants: the old daemon must exit.
An uncertain restart can leave old trust serving existing sessions. Passive clients
must never automatically restart it or retry registration without the guard.
Managed restart remains a separate, single machine-bound request with unchanged
acknowledgement/uncertainty semantics; no hash is added to control requests.
