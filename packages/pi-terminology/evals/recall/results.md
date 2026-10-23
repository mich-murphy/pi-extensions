# Recall follow-up — development stopped

## Decision

**Do not enable automatic reminders.** All 1,012 new native attempts succeeded,
but the selected recognition profile failed the development recall requirements
for three concepts. Freeze and acceptance were not attempted. The runtime glossary,
policy (`measured: false`), global configuration and root autoload list are unchanged.
The 51-entry browser remains available.

This is a development result, **not failed or passed fresh acceptance**. The fixed
550 synthetic and 200 natural private acceptance requests, and their 24 synthetic
repeat probes, were not dispatched. Private recall and expansion-usefulness gain
remain unmeasured in this round. Independent preparation agents did inspect and
label acceptance material; the tuning operator did not open raw acceptance text,
labels or classifier answers. Abstract calibration-family exclusion metadata was
exposed during preparation, so complete blinding to scenario metadata is not claimed.

## Preparation and collection

- All 51 meanings were retained. Source-blind authors and independent reviewers
  supplied complete label matrices; agreement was required for a positive.
  **These are agent judgements, not human-reviewed ground truth.**
- Independent split validation passed before dispatch: no normalized/full-prefix
  duplicates or overlap with 2,276 extracted consumed texts, required coverage,
  and source/session/scenario-family checks.
- The fixed acceptance selection stayed unchanged. Twenty-eight old calibration
  candidates and two new spare candidates were excluded for family collisions.
  Six independently authored/reviewed replacements restored the 612-case design.
  Every original pool, selection, blocked attestation and review remains private
  and unchanged.
- Every concept has at least ten distinct agreed unnamed calibration positives
  and ten synthetic acceptance positives. The private sample has 26 positive
  requests across a 200-request sample, 116 session clusters and 43 multi-request
  clusters. These are fixture-support counts, not model true positives.
- **400 pilot + 612 calibration = 1,012 calls**, pinned `jev-1.13.0`, zero failures,
  missing observations or retries. Median latency **278 ms**, maximum **898 ms**;
  all successful observations were below five seconds.

All calls in this round classified public/invented development requests. A
secret-like historical request appeared in a preparation-agent tool context before
filtering caught it; the entire request was excluded and was not sent to Jev or
published. The user was informed, private incident references were saved, and
identified transcript/log files were restricted. This does not mean that the
preparation-agent exposure was local-only inference.

## Whole-profile pilot

The two profiles used the same 200 consumed public development requests. The
following are pooled five-fold out-of-fold **three-name widget** scores, not fresh
acceptance:

| Profile | TP / FP / FN | Scored precision | Recall |
| --- | --- | ---: | ---: |
| Baseline | 248 / 8 / 59 | 96.88% | 80.78% |
| Semantic repair, selected | 255 / 9 / 52 | 96.59% | 83.06% |

The complete semantic-repair profile was selected by the preregistered ranking.
No recognizers were selected per request, and no concept was removed.

## Calibration: high aggregate precision did not rescue dead categories

The 612 newly prepared development requests produced:

- **TP524 / FP7 / FN73**; scored displayed precision **98.68%**;
- displayed micro recall **87.77%**, macro recall **92.89%**;
- 19 ambiguous displayed hits; conservative precision **95.27%**;
- no redundant named reminders, over-suppressed positives or widget-truncated
  positive assignments at these cutoffs.

Three concepts failed the 70% per-concept recall floor:

| Concept | Cutoff | TP / FP / FN | Scored precision | Recall |
| --- | ---: | --- | ---: | ---: |
| Low coupling | 0.98 | 9 / 1 / 10 | 90.00% | 47.37% |
| Refactoring | 0.98 | 2 / 0 / 30 | 100.00% | 6.25% |
| Separation of concerns | 0.93 | 17 / 1 / 8 | 94.44% | 68.00% |

The original calibration receipt, raw observations, failed report and consumed
reservations are preserved. No calibration completion seal, freeze receipt or
verification receipt was manufactured.

## Correct the optimization objective, not the acceptance requirements

The historical tuner imposed **90% precision per concept**. The user-approved
constraint is 90% scored displayed precision **in aggregate**, separately for
private and synthetic acceptance; per-concept precision is to be reported, not
required to exceed 90%. The extra development restriction needlessly favors
precision over recall. Its original implementation is preserved in the source
archive, not disguised as the correct objective.

Development-only replay used the already collected probabilities. The actual
first-three-name widget was replayed; unshown positives remain false negatives.
No new model calls, acceptance reads or reference-label changes were involved.

| Bounded replay candidate | TP / FP / FN | Scored precision | Recall | Remaining failure |
| --- | --- | ---: | ---: | --- |
| Aggregate-only target | 565 / 58 / 32 | 90.69% | 94.64% | Refactoring recall 43.75% (14/32). |
| All 51 concept recall floors | 547 / 64 / 50 | 89.53% | 91.62% | Aggregate precision below 90%. |

The aggregate-only row demonstrates that **94.64% development recall is possible
at over 90% aggregate scored precision**, but it is not an acceptable policy:
dropping refactoring's recall requirement would violate the approved experiment.
Neither row is fresh validation or a promoted policy.

The independent new aggregate-objective tool also found TP547/FP64/FN50. It
explicitly reports `search-no-feasible-candidate`, `developmentOnly: true` and
`promotable: false`. Its bounded coordinate search is fast but **not an exhaustive
proof of joint visible infeasibility**. Tie choices can change ambiguous exposure;
its report includes 20 ambiguous hits and 86.69% conservative precision, versus
13 and 87.66% for the separate twelve-start replay. Scored precision is the approved
constraint; neither conservative result passes 90%.

An exact multiple-choice dynamic program over the **uncapped** 0.80–0.99 grid found
no solution meeting all per-concept recall floors and aggregate precision. The
minimum raw FP count is 65; the best raw scores at FP65 and FP66 are TP548 and
TP549, below the 585 and 594 TPs respectively required for 90% precision. FP67 or
more cannot pass even with all 597 positives recovered. This is an uncapped result:
widget truncation can remove false positives, so it is **not** a proof about all
possible displayed threshold configurations.

At least 70% refactoring recall requires 23/32 positives. On these development
scores, a 0.90 cutoff reaches TP23 with FP48; a 0.80 cutoff reaches TP27 with FP83.
Low coupling needs at least 14/19; its highest qualifying cutoff, 0.96, incurs
FP11. These overlap/discrimination problems deserve another recognition-wording
iteration, not claims of success based on aggregate recall alone. Definitions and
labels must not be changed to fit the classifier answers.

## Budget and evidence

The new allowance was **$5 / 1,800 attempts**, separately from the closed expansion
experiment. Collection stopped at 1,012 attempts:

- conservative reservations: **$2.785542144**;
- input tokens: **12,124,708**; output tokens: **1,116,236**;
- published-tariff usage estimate: **$0.509237736**, **not an invoice**.

Unused allowance does not authorize an unplanned wording experiment, replay of a
burned receipt, or premature acceptance. Any further paid development needs a
separately recorded plan and explicit authorization. The unopened acceptance set
can remain reserved; no resampling or holdout appropriation is needed here.

[Machine-readable result](result.json) binds the public-safe artifacts. Public
fixtures and observations contain only invented/previously public development
requests. Private fixtures, labels, request-level observations and sampling
provenance are withheld.

The [source manifest](source-manifest.json.txt) binds 28 inert `.txt` snapshots of
the exact native-run sources, including the historical tuner. The exact
[pilot ledger snapshot](pilot-ledger.json.txt) reproduces the completion hash;
the [final development ledger](development-ledger.json.txt) preserves all 1,012
attempts. [Replay tests](../../test/recall-evidence.test.ts) verify hashes, budgets,
full matrices and the actual widget counts without credentials or provider calls.

The separate [aggregate-objective diagnostic](aggregate-objective-diagnostic.json.txt)
is bound to its own [two-source archive](offline-source-manifest.json.txt), not
misrepresented as the code used for native collection. Full final `npm run check`
passed: **98 test files, 2,021 passing tests and two existing skips**; statement
coverage 93.13%, branch coverage 88.93%, line coverage 93.11%. Formatting, type-aware
lint, TypeScript, coverage, Fallow and Markdown gates were not relaxed. The retained
log is `/tmp/pi-terminology-recall-final-check.log`.

The separate offline tool can be run only against the fixed consumed calibration:

```bash
bun packages/pi-terminology/scripts/diagnose-recall-calibration.ts \
  --manifest "$HOME/.pi/agent/pi-terminology/recall-2026-10-22/manifest.json" \
  --output /tmp/offline-recall-new-diagnostic.json
```

It never opens acceptance files or sets up a provider, and writes a new diagnostic
exclusively. Repeating offline computation does not grant another native attempt
or make consumed development evidence fresh.
