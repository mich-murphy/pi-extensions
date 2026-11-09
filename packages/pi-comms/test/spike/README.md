# Pi lifecycle and interoperability tests

Runs the pi-comms adapter and gateway through the real pinned Pi CLI with an offline recorder model, so no provider or credential is used.

## Run

From the repository root, after installing dependencies:

```sh
RAYON_NUM_THREADS=2 UV_THREADPOOL_SIZE=2 GOMAXPROCS=2 \
  node_modules/.bin/vitest run \
  packages/pi-comms/test/spike/lifecycle.test.ts --maxWorkers=2
```

The test runs the Python journeys against the CLI. Python needs Unix PTY support. To regenerate the derived trace:

```sh
PI_SPIKE_EVIDENCE=packages/pi-comms/test/spike/evidence.json \
  python3 packages/pi-comms/test/spike/offline.py
```

For a local two-gateway loopback run, build the release gateway first:

```sh
CARGO_BUILD_JOBS=2 cargo build --release --locked \
  --manifest-path packages/pi-comms/gateway/Cargo.toml
python3 -I packages/pi-comms/test/spike/interop.py --evidence interop-local.json
```

## Journeys

| Journey | Covers |
| --- | --- |
| RPC admission and lifecycle | Idle and busy push, duplicates, conflicts, no wake on reads, compaction, reload nonce replacement |
| Direct-body native Escape | Payloads around Escape and abort, no replay, bounded unobserved notices |
| Coalesced inbox and explicit take | Inbox saturation, no busy notices, take frees slots, new admission wakes |
| Inbox native Escape and busy boundary | Arrivals around abort, no replacement notice, busy pushes coalesce |
| Eight abort and take cycles | One unobserved notice at most, no busy notices, slots freed only by take |
| Arrivals during settled handlers | Several admissions share one deferred notice |
| Manual-compaction arrivals | One deferred idle check after compaction success or failure |
| Production adapter | Config opt-in, real tools, take provenance, reload, three TUI abort cycles |
| Two gateways (`interop.py`) | Discovery, sends, publications, interests, reports, gateway restart, reload |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PI_SPIKE_PACKAGE` | Another installation of the pinned Pi version. Default: this checkout's `node_modules`. |
| `PI_SPIKE_EXTENSION` | Fixture extension entry path. The Vitest wrapper sets it. |
| `PI_SPIKE_EVIDENCE` | Output path for the derived trace. |
| `PI_SPIKE_LOG` | Event log path. |
| `PI_SPIKE_SOCKET` | Control socket path. |
| `PI_SESSION_GATEWAY_BINARY` | Existing gateway binary for the native adapter test. |

## Isolation

- Each child gets a new temporary HOME, agent directory, working directory and session directory.
- The child environment is an allowlist, not yours. Telemetry and network activity are off, and only the in-process `spike/recorder` model is selected.
- TUI journeys use a real PTY and send native Escape.
- Shutdown must exit with status zero. A forced kill fails the test, and temporary directories, sockets and timers are cleaned up on failure.
