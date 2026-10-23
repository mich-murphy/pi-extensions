# Interrupted Jev repair: recovery preparation

23 October 2026. **Outcome update:** the user subsequently explicitly approved
only the 196 never-attempted development requests. A separate append-only runner
completed all 196 successfully, preserved the interrupted phase and produced a
new combined native completion and feasible development fit. See the
[continuation report](../../packages/pi-terminology/evals/repair/continuation/results.md).
Scored displayed precision is 90.55%, recall 96.31%, with all concept recall
floors met; refactoring precision is still only 46.15% and low coupling 63.33%.
No fresh acceptance, consumed replay or activation followed. A later zero-call
publisher has now bundled the explicitly unvalidated manual preview; see
[preview readiness](../../packages/pi-terminology/evals/repair/preview/README.md).
Paid work is stopped at 1,624 attempts / $4.470079488 reserved. Both receipts are
consumed; do not rerun either phase.

The proposal below records the **earlier offline preparation**, not a current
unfinished-work inventory or reusable paid authorization. Its snapshot diagnostic
intentionally examines the original interrupted public evidence, not the newer
continuation or private live ledger. The user requested a medium-effort codebase review
and continuation of the terminology work. The immediate blocker is incomplete
collection, not a demonstrated failure of the latest recognition wording.

## Current evidence and decision

The [interruption report](../../packages/pi-terminology/evals/repair/results.md)
and [machine-readable result](../../packages/pi-terminology/evals/repair/result.json)
record 416 successful native observations from a fixed 612-request development
matrix. The operator's foreground command timed out between completed attempts.
There are no recorded failed or unsettled repair attempts in the published ledger.
No fit, completion seal, consumed replay, acceptance or preview artifact exists.

Do not infer whether the candidate recognizers improved from the first 416 rows.
The fixed development order is not a balanced new evaluation split. Finish the
precommitted matrix before fitting; do not use the interruption to change wording,
labels, concepts or sampling. The three changed recognizers are refactoring, low
coupling and separation of concerns; all canonical meanings remain unchanged.
The current `glossary/core.json` is byte-identical to the frozen repair candidate
(`bdc30977310ec5861d5ba53f36f7c89d6a00bab026e0b598b7da56a5a7e63a65`),
not a newly measured production recognizer.

The 51-concept browser works without inference. Automatic reminders remain
unmeasured and disabled. Experimental preview infrastructure exists but has no
candidate policy to load. No installation or global activation is part of recovery.

## Budget boundary

Every new attempt reserves $0.002752512 before dispatch, independently of actual
returned usage. Published-tariff usage estimates are not provider invoices.

| Point | Total attempts | Total conservative reservations |
| --- | ---: | ---: |
| Stopped recall + interrupted repair | 1,428 | $3.930587136 |
| After the 196 never-attempted development requests | 1,624 | $4.470079488 |
| After a conditional 150 consumed replay + 24 repeat requests | 1,798 | $4.949016576 |
| Existing shared ceiling | 1,800 | $5.000000000 |

The 196 development requests reserve an additional **$0.539492352**. The later
174 replay/repeat requests reserve **$0.478937088** and must not be dispatched
unless the complete development fit passes and dispatch is explicitly authorized.
Do not reset or replace the shared ledger, reuse a burned receipt, count the old
359-attempt experiment as available headroom, or authorize another wording search
from these arithmetic totals.

## Implemented offline diagnostic

Run from the repository root:

```sh
node --import jiti/register \
  packages/pi-terminology/scripts/diagnose-repair-recovery.ts
```

This command takes no arguments and has no dispatch, authentication, fitting,
locking or artifact-writing path. It reads only the checkout's public repair
snapshot and frozen sources, with a pinned stopped-result hash as its trust root.
It verifies the published artifact and archive hashes, all 26 receipt bindings,
the full 416-by-51 probability prefix, the original ledger prefix and reservation
arithmetic. It reports current source drift and the exact 196 pending IDs.
Private/acceptance paths and symlink escapes from the package are rejected.

The current output is **`public-evidence-consistent`**, with **zero source drift**,
416 preserved observations and 196 pending IDs. It explicitly reports
`authorized: false`, `privateLedgerChecked: false` and
`continuationImplemented: false`. Exit zero means only that the public snapshot
is internally consistent and current frozen source bytes match; it does not
prove the private live ledger or locks are unchanged or permit a paid call.
Mutation and CLI tests cover the diagnostic without credentials or inference.

## Proposed implementation contract

### Preserve the interrupted phase

- Preserve the original receipt, all 416 observation lines, stopped-run result,
  ledger prefix, archived sources and interruption record byte for byte.
- Do not rerun `--phase develop`, invent its missing completion, append new rows
  to its original observation file, or silently treat it as a resumable phase.
- Select the pending rows as the exact suffix of the fixed development dataset
  after the verified 416-row prefix. Do not infer row order from numeric IDs;
  the selected dataset contains gaps in its IDs.
- Before collection, cross-check every prior observation with its successful
  ledger attempt, all 51 finite probabilities, source bindings and dataset hash.
  Any discrepancy, unknown attempt, failure or unsettled reservation is a stop.

### Add explicit continuation provenance

A future recovery runner needs a separate exclusive, durable receipt, observation
file, failure file and completion record. Use a distinct attempt namespace such
as `repair/develop-continue/<fixture-id>/0`; previously completed requests must
never be reserved again under any namespace.

The original runner and contract are among the 26 frozen source files. Changing
them and claiming the old binding still matches is invalid. Prefer keeping the
frozen files intact and implementing a separate recovery orchestrator. If changes
are required, bind and archive them separately, with a narrowly reviewed delta.
In either design:

1. Verify the old receipt against its immutable published archive and preserve
   its original source hashes as historical provenance.
2. Bind the continuation orchestration to a new source manifest and receipt.
3. Require byte-identical candidate glossary, compiled questions, native matcher,
   extraction/suppression, display/scoring semantics, dataset/order and protocol.
   Preserve the original authorizations; any new approval is an additional record,
   not a replacement that changes their hashes.
4. Report honestly which sources collected each segment. The new source manifest
   must not be represented as the source of the earlier 416 calls.

### Complete and fit a combined matrix

A combined completion must seal the old receipt and 416-row observation hash,
the new receipt and 196-row observation hash, the complete ordered 612-row matrix,
both source bindings and the final shared ledger. It must explicitly identify an
interrupted original collection plus a separately authorized continuation.

Only then fit all 51 concept thresholds against the approved aggregate displayed
objective: precision at least 90%, recall at least 85%, and recall at least 70%
for every concept. Retain minimum positive-support checks. Score the actual first
three visible names, rather than uncapped selection. Report ambiguous exposure,
conservative precision, macro recall and per-concept precision separately.

A failed development fit stops paid replay. A feasible development fit is still
consumed development, not independent validation. Any downstream preview artifact
must remain `developmentOnly: true`, `measured: false`, `promotable: false` and
explicitly unvalidated. Do not open the unused acceptance set for this recovery.

### Own the process lifetime

After independent review and explicit dispatch approval, run collection in an
owned persistent process. Record PID, start time, phase, durable log and status
paths. Monitor liveness and settled-count progress without a short foreground
terminal timeout. Keep the existing exclusive ledger lock; never steal a lock
just because its owner seems old. A second interruption is another stop, not
permission for automatic resume or retry.

## Required offline tests before dispatch

- Exact 196-row selection, unchanged order, disjoint from all 416 successes.
- Mutation rejection for the old receipt, archives, observations, full probability
  matrices, dataset, original ledger prefix and fixed measurement sources.
- Rejection of duplicates, missing rows, unexpected attempts, failed or reserved
  attempts, stale locks, and insufficient cumulative call/dollar headroom.
- Dry-run performs no provider/credential setup, writes, locks or acceptance reads.
- Receipt is burned before registry construction; reservations precede dispatch;
  observations and settlements are durable per request; no automatic retries.
- Mid-run failure leaves honest incomplete evidence and no completion or fit.
- Combined completion cannot manufacture the original phase's missing completion.
- Injected test evidence is permanently non-native and cannot export a portable
  candidate or authorize downstream native calls.
- Downstream replay/preview verify both bindings and complete observations, with
  no acceptance or measured-policy publication path.

## Review findings not to mix into collection recovery

The runtime review raised possible browser row-budget and detail-scroll issues,
plus inconsistent cooldown treatment for unnamed overflow concepts. These are
follow-up leads, not confirmed classifier defects. Editing `index.ts`, `ui.ts` or
`selection.ts` now would invalidate frozen measurement and preview bindings.
Investigate them separately; do not silently change the experiment while finishing
its precommitted matrix. Broad runtime refactors and deleting difficult concepts
are not prerequisites for recovery.

The old [handoff](../handoffs/pi-terminology.md) now begins with a current snapshot;
its earlier measured-policy and Pi 1.1 statements remain explicitly historical.
The ordinary default parallel package test run hit two load-sensitive timeouts.
The same 562 tests passed with one worker. The baseline repository-wide coverage
run passed **2,063 tests with two existing skips across 102 files**, also with one
worker. After adding the diagnostic's 13 tests, the full coverage run passed
**2,076 tests with two existing skips across 103 files**. The final run after
review/refactoring reproduced that pass: statements 92.70%, branches 88.82%,
lines 92.66%. Formatting, lint, TypeScript, Fallow and Markdown passed without
relaxing thresholds. An intermediate full rerun under heavy host load had existing
test timeouts and exceeded its 240-second command limit; it was not a pass. The
final run used a longer command lifetime, not weaker test assertions or gates.
These are offline verification results, not evidence of improved Jev recognition.
The final coverage log is `/tmp/pi-terminology-recovery-final-coverage.log`.

## Approval checkpoint

The next paid decision is specifically whether to collect **only the 196
never-attempted development requests**, under the existing $5 / 1,800-attempt cap,
with the preservation and process-ownership requirements above. No paid work,
private acceptance evaluation, runtime activation or successful recognition result
is implied by the codebase review or by this proposed plan.
