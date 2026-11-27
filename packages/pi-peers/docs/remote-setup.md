# Connect two machines

Remote links require [Tailscale](https://tailscale.com). Sessions on one machine
work without it.

## How it works

- The two gateways talk plain TCP inside the tailnet. WireGuard encrypts and
  authenticates the path, so there are no keys, certificates or TLS to manage.
- One gateway listens on its own tailnet IP and the other connects to it.
- Each gateway asks its local `tailscaled` who is on the other end, with
  `tailscale whois --json <ip>`. The remote's machine name, and what it may do
  here, come from that answer.
- What a remote may do lives in your tailnet policy file, as the app capability
  `github.com/mich-murphy/cap/pi-peers`. The destination enforces it: a grant
  from X to Y says what X's sessions may do to Y's sessions.

- `discover`: the remote may see this machine's sessions in those scopes (their labels and scopes).
- `push`: the remote may send requests, updates and replies to this machine's sessions in those scopes; implies `reply`.
- `reply`: the remote may answer only messages a session here sent to it: one reply plus up to 8 updates, within 600 seconds.

The capability value is a list of entries. Each entry grants every listed action
on every listed scope, and nothing across entries:

```json
[
  { "scopes": ["work"], "allow": ["discover", "push"] },
  { "scopes": ["review"], "allow": ["discover"] }
]
```

This grants `push` on `work` only, never on `review`. Actions are exact and
case-sensitive; unknown actions are ignored. Scopes use the scope grammar, so
`"*"` grants nothing. A malformed entry is ignored and the others still apply.
More than 64 entries, more than 64 scopes in one entry, or more than 16 KiB of
capability JSON grants nothing and closes the link.

## Guided setup

On each machine, type `/peers` and choose Setup › **Link a remote computer**.

- **Listen**: this computer listens on its own tailnet IP. The default port is
  7443.
- **Connect**: enter the other computer's MagicDNS name or tailnet IP and its
  port. Setup resolves a name to an IP once, when you link.

Setup then shows the grant to add to your tailnet policy, built from the two
machine names. `/peers doctor` shows the Tailscale state, this machine's tailnet
name and the endpoint. In connect mode it also shows the peer and what that peer
may do here.

## Tailnet policy grants

In these examples `laptop` and `tag:dev` are placeholders for your own machine
names and tags.

A trusted pair, where the laptop opens the link and may use the dev machines'
sessions fully:

```json
{
  "src": ["laptop"],
  "dst": ["tag:dev"],
  "ip": ["tcp:7443"],
  "app": {
    "github.com/mich-murphy/cap/pi-peers": [
      { "scopes": ["work"], "allow": ["discover", "push"] }
    ]
  }
}
```

An untrusted machine that may see and answer laptop sessions but never push to
them or open connections:

```json
{
  "src": ["tag:dev"],
  "dst": ["laptop"],
  "app": {
    "github.com/mich-murphy/cap/pi-peers": [
      { "scopes": ["work"], "allow": ["discover", "reply"] }
    ]
  }
}
```

A grant with only `app` opens no network path. The dev machine cannot connect to
the laptop; it answers over the connection the laptop opened. Both grants are
needed: each gateway enforces only what arrives from the other side.

Use a dedicated scope that only the sessions you mean to share join. Avoid
granting the default `local` scope, which every session joins.

## Limits

- Policy `tests` cannot check app capabilities. Review pi-peers grants by hand,
  or lint them in the CI of your policy repository.
- Tailscale in userspace-networking mode is not supported: the gateway cannot
  identify the peer, so the link is refused.
- Capabilities belong to a node's IP. On a multi-user machine, every local user
  shares that machine's capabilities.
- `discover` discloses session labels: the configured label, the session name,
  the working directory's base name and, if shared, the git branch.
- Capabilities are re-read every 15 seconds. A revoked grant stops working after
  about 15-30 seconds plus the time Tailscale takes to distribute the policy.
  While the coordination server is unreachable, a node keeps the last policy it
  received.
- Whoever controls the tailnet's coordination server or policy file decides both
  identity and permissions. Tailnet Lock signs node keys only, not policy.

## Manual setup

### 1. Build the gateway

```sh
cd packages/pi-peers/gateway
nix develop
cargo build --locked --release
```

The binary is `target/release/pi-gateway`.

### 2. Write the gateway config

This is `alpha`, the listener. Keep the socket path under 100 bytes.

```json
{
  "machineId": "alpha",
  "socketPath": "/home/me/pi-peers/run/alpha.sock",
  "scopeIds": ["work"],
  "policies": [
    { "machineId": "alpha", "scopeId": "work", "permissions": ["discover", "push"] }
  ],
  "remote": {
    "endpoint": { "mode": "listen", "address": "100.64.0.1:7443" }
  }
}
```

For `beta`, the connector, set `machineId` to `beta` and `endpoint` to
`{ "mode": "connect", "address": "100.64.0.1:7443" }`. The address is always an
IP and port: a listener must use one of its own tailnet IPs, and a connector must
dial an IP that `tailscale whois` resolves.

`policies` cover sessions on this machine only and may name only this
machine's `machineId`. Remote permissions come from the tailnet policy.

The gateway runs `tailscale` from the absolute path in `remote.tailscale` if set.
Otherwise it tries these paths in order and never searches `PATH`:

- `/usr/local/bin/tailscale`
- `/opt/homebrew/bin/tailscale`
- `/Applications/Tailscale.app/Contents/MacOS/Tailscale`
- `/usr/bin/tailscale`
- `/run/current-system/sw/bin/tailscale`
- `/nix/var/nix/profiles/default/bin/tailscale`

### 3. Check the configuration

```sh
./target/release/pi-gateway --diagnose /home/me/pi-peers/alpha.json
```

A usable setup reports `"state":"configured"`, `"trust":"tailscale"`, the
endpoint and this node's tailnet name. A connector also reports the peer and the
actions it may take here. Otherwise the remote side is `"state":"degraded"` and
local sessions keep working:

- `tailscale-missing`: No `tailscale` command found. Install Tailscale, or set `remote.tailscale` to its absolute path.
- `tailscale-not-running`: `tailscaled` is not running or not logged in. Start Tailscale and log in.
- `tailscale-error`: `tailscale` failed or gave an unexpected answer. Run `tailscale status` and fix what it reports.
- `not-tailnet-address`: The listen or connect address is not a usable tailnet node. Use this node's tailnet IP to listen, or a peer's to connect.

### 4. Start both gateways and point each Pi at its socket

```sh
./target/release/pi-gateway --config /home/me/pi-peers/alpha.json
```

In each machine's `pi-peers.json`, set `socketPath` to the local gateway's socket
and `machineId` to match. Reload Pi, then run `/peers status`. Each change in the
link writes a `link_state` event, and `/peers status` shows a `Link to <machine>`
row.

## Upgrading from certificates or keys

Gateway 0.4.0 no longer supports certificates, CRLs, revocation floors or pinned
keys. A config whose `remote` still has those fields, a remote `machineId`, or
policies for other machines or with a `direction` does not start. `--diagnose`
reports `{"state":"retired-certificates"}` for it. Link again as above. The old
certificate and key files are no longer used and can be deleted.
