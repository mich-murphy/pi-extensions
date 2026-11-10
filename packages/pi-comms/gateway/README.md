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
| `--config` | Absolute path to the JSON config | Runs the gateway. Prints one `ready` line on stdout once bound. |
| `--initialize-revocation-floor` | Absolute path for the new floor file | Creates the floor file and exits. It refuses to overwrite existing state. |

Pass exactly one flag with one argument.

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

`SIGTERM` and `SIGINT` stop the gateway and remove its own socket. Changes to the config, roots, CRLs or policies take effect only after a restart. Restart needs the existing floor file.

## Output

Stdout has one line, `{"event":"ready","socketPath":"…","machineId":"…"}`. A gateway whose remote endpoint listens adds `"remoteListenAddress":"IP:port"`, the socket address it actually bound. With a configured port of `0` this is the only way to learn the port. Gateways without a remote, and connectors, omit the field. Stderr has `{"event":"remote_unavailable","reason":"reconnect_exhausted"}` when the connector gives up. It then stays down until you restart it or a local session registers again. Startup failures print `Error:` and exit non-zero.

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
