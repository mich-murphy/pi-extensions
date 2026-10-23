# Offline optimizer source compatibility, version 1

This is a separate attestation of the current offline fitter, not a new native
result, publication, acceptance or activation. No inference was performed. The
native receipts, archives, completion, report, fit seal, historical command-rename
publication and bundled preview-policy bytes remain unchanged.

## Narrow source compatibility

The offline publisher accepts the original fitter or exactly one reviewed
optimized fitter. Its compatibility rule requires the original SHA-256 from the
receipt, the same hash for the preserved archive, and the hard-pinned current
fitter hash. It does not load an allowlist from this attestation. Other source
changes remain forbidden except the existing exact command-name transformation
for `index.ts` and `ui.ts`.

The publisher itself is unchanged and still verifies all native artifacts,
source archives, observations, ledger and the complete reproduced fit against the
sealed report. Its historical `policy.evidence.compatibility` text describes the
original command-rename publication; it has not been rewritten to imply that the
optimized source performed native inference.

The [attestation](attestation.json) binds the current fitter, compatibility rule
and publisher separately from the unchanged historical publication. It also
binds the original fitter archive, native result, completion, report, dataset,
observation files and seals, fit seal, complete serialized-fit digest and preview
policy. Tests verify these bindings and reject mutations.

Paid-native contracts are unchanged. Both the recovery diagnostic and paid
continuation still reject the current fitter as source drift. Historical recovery
unit tests use the hash-verified archived fitter through the existing filesystem
seam, alongside the archived pre-rename UI files. A separate test isolates current
fitter drift and proves rejection before credentials, calls or receipt writes.

## Semantic and performance evidence

The optimizer retains the same eligibility comparisons, first-three canonical
concept cap, integer confusion counts, rank reduction order, starts, sweeps,
candidate count and ascending-grid tie-breaking. Sparse eligible-concept indices
avoid scanning impossible candidates. Per-coordinate last-eligible-grid buckets
replace twenty full row scans with one scan and an integer suffix accumulation.

Small deterministic differential corpora execute the preserved original fitter
and compare the entire serialized result. They cover every grid boundary and its
adjacent floating-point values, named suppression, ambiguous displacement,
repeats, empty classes and score plateaus. The actual 612-row, 51-concept fixture
retains all **21,420** candidates and the complete serialized-fit SHA-256
`81154dd0738a4020a5a3c7db1445369821e278dfe7409c744e64798f660d2e17`.
Existing sealed-report and bundled-policy byte comparisons remain authoritative.

Three alternating same-host runs of the real combined-fit test with Node
24.21.0, `CI=true` and V8 coverage measured old times of 2337/2316/2287 ms and
optimized times of 656/495/489 ms: a 4.68-fold median improvement. These are local
measurements, not a timing assertion or a guarantee about a shared CI host. The
repeated row/class scans are demonstrated avoidable work; the cause of the
separate historical CI host slowdown is not established. No timeout, search
budget, coverage threshold or gate was changed.
