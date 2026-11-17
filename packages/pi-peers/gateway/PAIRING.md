# Native provisioning interface v1

All invocations are shell-free argv arrays. Run `pi-gateway pair OP --input ABS_JSON`.
Input is one strict JSON object (32,764 bytes maximum); unknown/duplicate fields
are rejected. Paths are absolute, explicit local arguments, not read from exchanges.
Every success emits one public-only JSON line with `version: 1`, `operation: OP`
and the fields below. Failure exits nonzero, never emits success JSON. No command
prints private key bytes. Callers must not log the input file contents.

## Operations

| OP | Exact input fields | Output fields in addition to version/operation |
| --- | --- | --- |
| create | issuerDir, runtimeDir, machineId, peerMachineId | offerPath, rootSha256, pairId, runtimeDir, bundlePath, credentials |
| join | runtimeDir, offerPath, confirmedRootSha256 | requestPath, requestSha256, rootSha256, pairId |
| issue | issuerDir, requestPath, confirmedRequestSha256 | bundlePath, rootSha256, pairId |
| renew | issuerDir, requestPath, confirmedRequestSha256 | bundlePath, rootSha256, pairId |
| import | runtimeDir, bundlePath, confirmedRootSha256, floorMode | credential fields below, activationRequired |
| import-existing | runtimeDir, machineId, peerMachineId, rootCertificate, certificate, privateKey, crl, revocationState, confirmedRootSha256, floorMode | credential fields, activationRequired |
| revoke | issuerDir, machineId | bundlePath, rootSha256, pairId |
| export | issuerDir | bundlePath, rootSha256, pairId |
| inspect | runtimeDir | credential fields, installed, rootSha256, requestPath, requestSha256; when pending: pendingBundlePath; when installed: rootExpiresAt, leafExpiresAt, crlExpiresAt, expiryWarning |

All fields except floorMode are strings (paths or identities). floorMode is exactly
`new` or `existing`. Credentials is an object containing the credential fields:
`pairId`, `machineId`, `peerMachineId`, `rootCertificates: string[]`,
`certificateChain: string[]`, `issuerCertificates: []`, `privateKey: string`,
`crls: string[]`, `revocationState: string`. These are paths, never key bytes.
The remote gateway config uses peerMachineId as its remote.machineId, plus an
explicit endpoint chosen by the wizard; only the credential path fields are copied.
Inspect with installed=false is pending, not usable configuration.

Fingerprints are full lowercase 64-hex SHA256. pairId is the root DER SHA256.
rootSha256 hashes DER bytes, requestSha256 hashes the complete request file bytes.
Request confirmation must come from the joiner's independently authenticated
out-of-band channel; root confirmation must come independently from the creator.
Showing a fingerprint read from the same transferred file is not confirmation.

Machine names are 1–32 lowercase ASCII letters, digits or hyphen, first character
a letter. Initiator and peer must differ. One root binds exactly those two names.
No unrelated third leaf is accepted. Each host generates its own leaf key locally.
Exchange documents contain only public root/certificates/CRL/CSR and pair binding.
They contain no executable commands, path directives or private material.

## Wizard sequencing

1. Creator creates two nonexisting sibling (not nested) directories under an
   existing private parent. create provisions its own credentials and an offer.
   Use the returned credentials, never infer a generation directory name.
2. Transfer offer.json as public data to the joiner. Joiner independently confirms
   rootSha256, then join creates its nonexisting runtimeDir, local key and CSR.
3. Transfer request.json to creator. Independently confirm its full requestSha256.
   issue signs only the bound peer CSR and publishes a new public bundle.
4. Creator **imports that bundle with floorMode=existing**, because issue also
   refreshes its leaf and the numbered CRL. The issuer action never mutates
   the creator's active runtime files. Joiner imports with floorMode=new.
5. Both hosts install returned gateway credential paths. Import returns
   activationRequired=true: existing imports **stage**, not activate. They check
   the read-only live floor AND the latest already-staged generation, without
   acquiring the runtime's lifetime floor lock or advancing the durable floor.
   A second import cannot roll back an unactivated staged revocation.
6. After writing the gateway config under the setup lock, invoke
   `--request-restart ABS_CONFIG` against the managed gateway. Existing participating
   Pi sessions perform bounded recovery/re-registration. Normal startup commits the
   CRL floor before binding the remote endpoint; changed config is not hot-reloaded.
   No acknowledgement is evidence of a live remote link. Explicitly reconnect/verify.

New floors are create-only and only accepted for pending runtime metadata.
Existing imports validate a read-only snapshot of the existing floor; missing/corrupt floors are never
recreated. Before recording any pending import, the validated canonical public bundle is
retained as `public-bundle-<full-canonical-SHA256>.json` inside runtimeDir. The file
and parent directory are synced before the pending hash/generation record. Retained
public copies are not overwritten or removed by later imports. New imports durably
reserve that exact bundle hash and generation before initializing any floor. A retry with that exact bundle opens the owned existing floor and resumes
known generation writes; it never resets the floor. Different bundles are refused
until the owned transaction finishes. inspect exposes pendingBundlePath only while
pending, after verifying the retained file hash. To resume after a source transfer
file is lost or overwritten, explicitly supply that path as import.bundlePath, with
the independently confirmed root fingerprint and original floorMode. Both the
requested canonical bundle and retained bytes must match the pending hash; no
cached bundle is silently substituted for a different requested bundle. If a pending enrollment floor is absent,
resume refuses to recreate it (including an interruption before bootstrap); use a
new-root re-pair with fresh directories, never reset protected state.
Partial initial create/join directories are
retained fail-closed for explicit ownership-reviewed cleanup; never remove an
existing floor or unrecognized files/directories.

## Lifecycle

Pair roots last 365 days (matching the existing manual setup recipe). Leaves last
90 days; complete numbered CRLs last 30 days. inspect warns at seven
days to the earliest expiry and includes Unix-second expiry timestamps. renew
requires an existing bound machine's locally signed request and independently
confirmed full request fingerprint. The signed CSR/key is pinned per machine;
replacement CSR/key requires new-root re-pair, not generic renewal. It authorizes a fresh offline issuance action,
not an expired TLS connection or a bypass of credential verification. Every issued
bundle is validated against current time and the existing floor at import.
Renew refreshes both bound leaves and the CRL; transfer/import on both hosts.
Export returns the latest bundle without changing validity or issuing anything.

Revoke revokes every recorded serial for the selected bound machine, increments
the CRL number and prevents issuing to that machine again under this root.
Transfer/import the result on the remaining host, then restart/reconnect to withdraw
active routes. The revoked host cannot import a replacement own leaf. Revocation
is not instant until the new bundle is installed; current CRL expiry bounds stale
trust. Issuer serial/CRL mutation is flock-serialized and counters reserved before
signing; interrupted operations can consume numbers, never reuse them.

Issuer keys live only in issuerDir, outside runtimeDir and gateway configuration.
Directories are 0700, files 0600, owner-only/no leaf symlinks/single hard link.
This is **not same-UID privilege isolation**. Code running as the same account can
read issuer keys. Optional offline offload means moving the entire issuer directory
to protected storage outside the gateway account, not exporting keys through UI.
Account/root-key compromise requires a new root and explicit re-pair on both hosts;
never roll back floors. Keep old floors until an ownership-reviewed retirement.

## Read-only diagnostics

`pi-gateway --diagnose ABS_CONFIG` emits
`{version:1,machineId:string,remote:{state:"disabled"|"configured"|"degraded",reason?:string,credentialExpiresAt?:number,expiryWarning?:boolean}}`.
It reads a bounded credential/floor **snapshot**, does not create/lock/commit floor
files, bind sockets or connect. An active gateway's floor lock does not block it.
Configured means credentials validate now, **not** gateway readiness or a live link.
Malformed structural config exits nonzero. Known operational credential failures
report degraded; unexpected defects propagate nonzero instead of being suppressed.

Reason codes: credential-file, private-key, trust-or-crl, identity,
leaf-or-crl-invalid, key-or-chain, issuer-file, crl-invalid,
revocation-floor-unavailable, revocation-floor-rejected.
No raw paths/credential contents are included in diagnostic reason values.
Startup likewise disables remote service on these failures while retaining local
service. Additionally, known TCP listen bind failures (address in use, address no
longer available, permission denied) disable remote only with the startup reason
`remote-listen-unavailable`. The floor is committed before attempting the bind.
There is no background rebind; fix the endpoint and explicitly restart. Actual
startup degradation is emitted on stderr as `remote degraded: <reason>`; it does
not change ready JSON. Diagnose never binds, so it cannot report that runtime
reason: it can say configured even while the port is occupied. Structural config
errors and unexpected listener defects remain hard failures. Existing strict wire-v1 and ready JSON shapes are unchanged.

## Existing material

import-existing creates a nonexisting runtimeDir from explicitly named local DER
files (one direct root/leaf/CRL, no intermediate chain). Source key stays local and
is copied only to its private runtime leaf-key file; it is never in an exchange.
confirmedRootSha256 independently confirms the root DER fingerprint. floorMode=new
is an explicit first-enrollment action requiring a nonexistent revocationState;
floorMode=existing validates a read-only snapshot against the supplied trust
before creating any runtime files, even while a gateway holds the lifetime lock.
It requires the supplied existing floor in place, never copies or resets it. The returned revocationState remains that explicit path. Existing
imported roots are not accepted as fresh pair offers; only locally recorded import
metadata enables this distinct path. Fresh offers must match their names to the
signed root subject exactly. Inspect supports both runtime kinds.

## Native local maintenance and setup lock

`--version --json` advertises pairing-v1, gateway-control-v1 and setup-lock-v1 in
addition to managed-on-demand-v1; wireVersions remains [1].

`--setup-lock ABS_LOCK` creates/opens a permanent owner-only 0600 regular single-link
file in a private directory, takes a nonblocking exclusive flock, emits
`{version:1,state:"locked"}`, and keeps the flock while stdin is open. EOF or process
exit releases it. Never unlink this file. Acquire the binary before this lock;
once acquired, hold it across setup journal/config writes and explicit activation.
Contention fails promptly without any mutation to config or journal.

`--request-restart ABS_CONFIG` sends exactly one native local control request:
`{v:1,op:"gateway.restart",rid:32hex,expectedMachineId:machine}`. Only a same-UID
local connection to a managed gateway with that machine ID can succeed. Remote,
manual and nonmatching requests are refused without stopping the gateway. Success
is an exact empty-value result forOp gateway.restart, then EOF; managed shutdown
flushes the acknowledgement before closing participant connections and unlinking
only its owned socket inode. The CLI emits `{version:1,state:"restart-requested"}`
and exits zero after ACK plus EOF, with a three-second bound. Failure/timeout can
be an **unknown outcome**: never blindly retry; reconnect/inspect to establish the
new state. No PID signalling, path-only unlink or sidecar readiness proof exists.
Restart deliberately loses volatile gateway state; adapters re-register existing
identity/state under their bounded recovery semantics and never replay uncertain
sends. This is explicit maintenance, not transparent hot renewal.
