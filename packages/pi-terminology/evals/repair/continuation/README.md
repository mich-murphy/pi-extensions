# Append-only 196-request development continuation

The user explicitly approved completing **only the 196 never-attempted requests**
from the interrupted repair collection. This is not permission for the later
174 consumed replay/repeat calls, acceptance evaluation, another wording search,
installation or runtime activation. See [authorization.json](authorization.json).

## Completed development continuation

**All 196 authorized calls succeeded.** The combined development fit meets the
approved aggregate precision/recall and all per-concept recall gates: TP575 /
FP60 / FN22, **90.55% scored displayed precision and 96.31% recall**. This is not
fresh acceptance. Refactoring precision is only **46.15%**, low coupling **63.33%**,
and conservative aggregate precision **88.06%**; do not hide those limitations.
See the [full result and evidence](results.md). Paid work is stopped; no replay,
preview policy, installation or activation occurred in this native phase.
A subsequent **zero-call preview publisher** has now packaged the candidate for
explicit session-only testing; see [preview readiness](../preview/README.md).
The native phase's sealed `previewArtifactAvailable: false` remains historical,
not a claim that the later artifact is missing.

The standalone runner is `scripts/evaluate-repair-continuation.ts`; the
original 26 frozen sources and the interrupted phase's artifacts are unchanged.
The new contract separately binds those original sources and the continuation's
four additional source/authorization files. It archives the new files before
native registry construction and checks their hashes before each reservation.

Only public/invented consumed development requests are classified. The fixed
612-request dataset's first 416 successful rows are preserved. The pending suffix
contains exactly 196 rows in the original order, not a range inferred from numeric
IDs. New ledger IDs are `repair/develop-continue/<fixture-id>/0`.

The existing shared ledger is never initialized or copied to a fresh budget.
The preflight requires exactly 1,428 settled successful existing attempts and
exact byte matches with the public stopped ledger, old receipt, manifest,
authorizations and 416 observations. Any unexpected completion, failure, prior
continuation receipt or source drift stops preparation.

## Bounded allocation

- New native calls: **196 maximum**, serial, `jev-1.13.0`, all 51 questions,
  threshold zero, five-second advisory deadline and zero retries.
- Additional conservative reservations: **$0.539492352**.
- Maximum resulting shared totals: **1,624 attempts / $4.470079488 reserved**.
- Existing ceiling unchanged: **$5 / 1,800 attempts**. Usage estimates are not
  provider invoices. A failed attempt keeps its reservation and stops collection.
- No automatic resume or second continuation is authorized. Missing native
  observations prohibit a combined completion or fit.

## Private setup and commands

Use the original fixed `ROOT=~/.pi/agent/pi-terminology/recall-2026-10-22`.
Create only `ROOT/repair/continuation/` (0700) and copy the exact new public
`authorization.json` to that directory (0600). Do not replace the original
`ROOT/authorization.json` or `ROOT/repair/authorization.json`, ledger or manifest.

```sh
node --import jiti/register \
  packages/pi-terminology/scripts/evaluate-repair-continuation.ts \
  --manifest "$ROOT/repair/manifest.json" \
  --authorization "$ROOT/repair/continuation/authorization.json" \
  --dry-run
```

**The continuation receipt is now consumed. Do not rerun this command.** The
command above describes the historical preflight, not a reusable authorization.

Dry-run performs no writes, locks, registry construction, credential resolution or
provider calls. It validates the live stopped evidence and prints the exact pending
IDs, source bindings and cumulative reservation preview. It does not read private
or unused acceptance datasets. Omit `--dry-run` only after full offline gates and
independent review, under the user's recorded 196-call approval.

Use an owned persistent process rather than a foreground tool timeout. Preserve
supervisor/child PIDs, command, start time, stdout/stderr and exit status. Monitor
the durable `progress.jsonl`, observations and actual ledger settlements. Do not
steal a lock or automatically rerun the command after interruption.

## New evidence only

The runner writes exclusively into `ROOT/repair/continuation/`, except for
append-only transactions in the existing shared ledger:

- `receipt.json`: exclusive, durable authorization/source binding before registry
  construction; records PID, prior ledger hash and exactly 196 permitted calls.
- `source-manifest.json` and inert `source/*.txt` snapshots: exact new source bytes,
  with the original 26-source binding preserved separately.
- `observations.jsonl`, `progress.jsonl`, optional `failures.jsonl`: fsynced serial
  evidence. Failures retain reservations and cannot be retried.
- `combined.complete.json`: new proof over 416 preserved plus 196 new observations,
  both source bindings, ordered IDs, receipt, observation and final ledger hashes.
  It explicitly retains the original interruption and never creates the original
  phase's missing completion. It is durable before fitting.
- `report.json` and `fit-seal.json`: development-only fitting and immutable hashes.
  Injected test journeys are permanently `native: false`.

The complete matrix is fitted with the unchanged aggregate optimizer and actual
three-visible-name widget semantics: at least 90% scored displayed precision,
85% displayed recall and 70% recall for each concept, with positive-support checks.
Per-concept precision, ambiguous exposure and conservative precision are reported
separately. This bounded search does not prove global threshold infeasibility.

No result is independent acceptance or a production policy. `measured`, `accepted`
and `promotable` remain false; `replayAuthorized` remains false even if development
passes. No preview artifact is exported by this runner. The original interruption
report and all older receipts remain immutable historical evidence.

## Final offline verification

The final repository-wide coverage run passed **2,108 tests with two existing skips
across 105 files**, using one worker. Statements: 92.73%; branches: 88.70%; lines:
92.70%. Formatting, lint, TypeScript, Fallow, Markdown and `git diff --check` passed
without relaxing thresholds. The ordinary parallel script's known load-sensitive
timeouts were not represented as a passing run.

A fresh medium-effort read-only reviewer independently ran all five new public
evidence tests and found no integrity defect. The tests reproduce the 612-row
native matrix, shared ledger, both source generations and fitted report without
credentials or provider calls. All 26 original and four continuation source hashes
still match the actual native receipt after final checks. No process or ledger
lock remains. Logs:

- `/tmp/pi-terminology-continuation-final-check.log`
- `/tmp/pi-terminology-continuation-final-fallow.log`

The public native report is stored as `report.json.txt` to preserve exact sealed
bytes rather than subjecting it to JSON formatter changes.
