# Paid recognition repair: development and consumed replay only

**Current status: interrupted after 416/612 successful development calls by the
operator's foreground terminal timeout.** No completion seal, fit or preview
artifact exists. Paid work is stopped; collecting the 196 never-attempted
requests requires an explicitly approved, separately logged continuation. The
original receipt must not be reset or replayed. See [the interruption report](results.md).

This is a **new authorization namespace, not a new budget**. The original recall
experiment stopped after 1,012 successful attempts with three class recall floor
failures. Its pilot/calibration receipts, missing calibration completion, source
archive and failure remain unchanged. The separate 359-attempt experiment is not
part of this repair and must not be touched.

The user approved: “Continue with this paid iteration. Ensure that everything's
ready for actual use so I can start to test it myself.” This permits an explicitly
experimental manual preview, not a production acceptance claim or global activation.

## Budget and data precommitment

- Append only to `~/.pi/agent/pi-terminology/recall-2026-10-22/ledger.json` using
  the existing recall lock/reservation helper. Never reset or copy a fresh budget.
- Shared cap: $5 (`5000000000` nanos), 1,800 total attempts. Repair uses at most
  786 additional attempts: 612 development + 150 consumed replay + 24 repeats.
  Total maximum is 1,798, leaving two attempts of unused headroom.
- Every attempt reserves `65536 * 42` nanos before dispatch. No retries or resume.
- Develop uses the exact 612 consumed invented calibration rows in
  `evals/recall/calibration-consensus.json.txt`, SHA-256
  `a476109e901b90f9f1aa8904f09072ed173170884a521a3a494211d893ebb8f6`.
- `public-replay.json` is exactly the first 150 rows of the consumed public
  `evals/recall/pilot.json`: 148 original consumed synthetic rows and two old
  development rows. It is **not fresh, independent or acceptance data**.
- Twenty-four distinct replay IDs are precommitted in `manifest-template.json` by
  seeded Fisher–Yates permutation (LCG seed `2026102205`; implementation in
  `scripts/repair-contract.ts`). No heldout/private split is read by this runner.

The original ledger archive hash is
`272d9e60ad7d15ad540522f4ba0bb47b4411d71bcc26f579ff3787eb0f1067db`.
Before initial dispatch the actual shared ledger must match these bytes; later
phases preserve all 1,012 prefix objects, original ancillary costs and original
receipts. Only `repair/` attempt IDs may be appended.

## Private setup and CLI

After all runtime and evaluator code is frozen, the parent operator may create
`ROOT/repair/` (mode 0700), where `ROOT` is the original fixed recall run directory.
Copy the exact public `authorization.json` bytes to
`ROOT/repair/authorization.json` (mode 0600). Keep the original
`ROOT/authorization.json` unchanged; it must match the original public approval.
Materialize `manifest-template.json` as `ROOT/repair/manifest.json`, replacing the
placeholder paths with absolute paths to this checkout's two public data files.
Do not copy, replace or initialize the shared ledger.

Run through the checkout's TypeScript runner:

```sh
node --import jiti/register packages/pi-terminology/scripts/evaluate-repair.ts \
  --phase develop --manifest "$ROOT/repair/manifest.json" --dry-run
```

Supported phases are `develop`, `replay`, and `freeze-preview`. Omit `--dry-run`
only after the parent has explicitly authorized dispatch following source freeze.
Dry-run validates public datasets, authorizations, source bindings and cumulative
budget without registry construction, credential/network calls, writes or heldout
reads. No live calls are required by the tests.

### Develop

Exactly 612 serial native calls use Jev 1.13.0, five-second timeout, zero retries,
threshold zero and all 51 compiled wire questions. The complete native probability
matrix is required. Prompt extraction, already-named suppression and the actual
three-visible-name widget order are reused from runtime/pure scoring helpers.
Prompts are capped at 32,000 characters; full label matrices and named true-positive
source annotations are validated before registry construction.

Raw observations are fsynced per attempt. `repair.develop.complete.json` seals
**collection completeness/native provenance before fitting**, separately from the
fit result. `fitAggregateRecall` retains all concepts and fits aggregate displayed
precision >= .90, recall >= .85, each class recall >= .70 and at least ten distinct
unnamed positives per class. The report and its immutable fit hash seal survive
failed gates. Missing/failed native observations mean STOP, no candidate. Complete
native observations but infeasible fit mean STOP ALL FURTHER PAID REPLAY.

### Replay

Requires complete native development and a feasible, sealed development fit.
Questions and cutoffs are frozen in `repair.replay.frozen.json` before the 150
consumed public calls plus 24 preregistered repeats. Replay reports are diagnostic,
never acceptance. No accepted/measured/production policy can be written by this CLI.

### Freeze preview

This zero-call phase requires complete native development. Injected test evidence
cannot freeze any portable policy. A partially failed replay also prevents preview.
A completed native but failed-gate fit may produce only a clearly marked
`UNVALIDATED-FAILED-GATES-manual-opt-in-only` artifact. Even a feasible development
fit remains `UNVALIDATED-development-fit-only`; neither case passed independent
acceptance. The policy has all 51 cutoffs, candidate catalogue/wire/profile/source
bindings, `developmentOnly: true`, `measured: false`, `promotable: false`, and
`acceptanceStatus: "not-validated"` with explicit gaps.

The runner writes only `ROOT/repair/repair.*` artifacts plus appended transactions
to the original shared ledger. It never writes `glossary/core.json`,
`glossary/policy.json`, or `glossary/preview-policy.json`. The parent may later
materialize the exact candidate glossary and this preview policy for explicit user
opt-in; measured production policy remains false and must be rebound separately.

## Evidence contract

Each non-dry phase burns an exclusive, fsynced `repair.PHASE.receipt.json` before
registry construction. Each reservation and settlement is durable in the original
shared ledger. Observation and failure JSONL files are fsynced per attempt.
Completion markers seal observation bytes, native provenance, count, full source
binding and ledger hash. Thirty-two-K prompt validation, 51-question extraction,
suppression and widget scoring are shared with the original contracts, not copied
or relaxed. Twenty-six relevant source files are bound explicitly in
`REPAIR_SOURCES`, including the new optimizer, runner, contract, candidate profile
and runtime preview helper; dataset bytes and manifest are additionally pinned.
The old native source archive is bound and never rewritten.

Tests inject both matcher and registry into an isolated test root before any
file/registry/network access. Such evidence is permanently `native: false`, and
cannot be replayed or frozen into a portable artifact. No tests need credentials,
providers, subscriptions, or network access.
