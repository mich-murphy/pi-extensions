# Recall calibration — approved follow-up

## Status and authority

On 22 October 2026 the user approved the [proposed targets and new bounded
experiment](../../../../docs/research/terminology-calibration-followup.md).
[Authorization](authorization.json) records a **$5 conservative cap, at most
1,800 attempts, pinned `jev-1.13.0`, and zero automatic retries**. This allowance
is separate from the completed 359-attempt expansion experiment. Its ledgers,
receipts, reference labels, source bindings and reports are not reset or rewritten.

**Stopped at development: 1,012/1,012 native calls succeeded, but calibration
failed three per-concept recall gates.** No acceptance calls, freeze, verification
receipt or policy promotion followed. See the [development result](results.md)
and [machine-readable evidence](result.json).

The runtime catalogue and unmeasured policy remain unchanged. Global activation,
installation, root autoload changes, commits and pushes are not authorized here.
Unused allowance is not being spent on another wording experiment or on known-bad
acceptance testing.

## Frozen acceptance requirements

Before testing, the following requirements apply together:

- At least **90% scored displayed precision**, overall, on synthetic requests,
  and on natural private requests separately. Empty precision does not pass.
- At least **85% overall recall** and **85% private-request recall**.
- At least **70% synthetic recall for every one of the 51 concepts**, with at
  least **ten distinct agreed unnamed positive scenarios per concept**.
- At least **20 distinct natural private requests with agreed unnamed positive
  opportunities**. Insufficient support blocks acceptance; it is not a pass.
- **Positive gain in private requests receiving a correct unnamed reminder**
  versus the original-ten probability subset at its archived cutoffs.
- Complete, error-free native collection with unchanged frozen inputs.

These are empirical gates, not statistical guarantees. Independently authored and
reviewed agent judgements are not human-adjudicated ground truth. Report per-
concept precision and recall, micro and macro recall, ambiguous hits and
conservative precision, name redundancy, opportunities involving the 41 additions,
latency including failures, selected-set stability and display suppression.

Scored precision excludes ambiguous hits; conservative precision penalizes them.
The authorized threshold is the former. Do not claim the latter passed when it
did not, or quietly change the ambiguity policy after observing answers.

The old-ten subset is an observational comparator on the same 51-question request,
not a causal separate ten-question treatment or proof that teaching a term improves
coding outcomes. If the selected profile repairs an original recognizer, the
subset uses that repaired probability too; it is not an exact reproduction of the
archived recognition wording.

**Display semantics:** the compact widget names only the first three selected
concepts in runtime catalogue order. A hidden name behind `+N more` does not count
as displayed. Primary precision, recall, per-concept performance and private
usefulness must replay those three slots; every unshown positive opportunity
remains in the recall denominator. The old-ten comparator gets its own independently
selected three slots. Report uncapped candidate-selection metrics separately.
Threshold selection initially proposes raw-score operating points; display capacity
couples concepts, so it is not an optimizer of joint visible recall. The whole-
profile visible development and acceptance gates still have to pass.

Empty-state replay measures potential reminders. Real cooldowns, dismissals and
user familiarity can reduce actual exposure; those limits remain separate from
classifier recall.

## Bounded allocation

| Stage | Maximum native calls | Purpose |
| --- | ---: | --- |
| Pilot | 400 | Two predeclared complete question profiles over the same 200 consumed public development requests. |
| Calibration | 612 | Selected profile; ten single coherent primary positive requests and two boundary controls per concept. |
| Fresh synthetic acceptance | 550 | Ten new primary positive scenarios per concept plus 40 independent hard controls. |
| Fresh natural private acceptance | 200 | Unenriched deterministic sample for precision, recall and useful-opportunity gain. |
| Repeat probes | 24 | Precommitted acceptance IDs; excluded from primary score denominators. |
| **Planned maximum** | **1,786** | Full conservative reservation **$4.915986432**. |

The hard ceiling of 1,800 attempts reserves at most **$4.954521600**, using the
existing 65,536-input-token reservation and documented $0.042/million input tariff.
Observed usage is reported separately, not substituted for reservations or called
an invoice. Unused allowance does not authorize unplanned reruns or acceptance
adaptation. Failures retain reservations and stop collection.

The new private run is `~/.pi/agent/pi-terminology/recall-2026-10-22/`. It owns an
exclusive durable cumulative ledger, immutable phase receipts and completion
seals. No new directory or process restart grants another attempt at a consumed
phase. Old ledgers and receipts stay untouched.

## Profiles, calibration and freeze

Two complete profiles are preregistered: a byte-preserved baseline and a minimal
semantic repair, both with the same 51 definitions and concept identities. The
repair addresses recognition of legitimate substeps/properties; it does not
redefine concepts, turn related terms into aliases, or remove difficult concepts.

The 200 [pilot requests](pilot.json) comprise all 148 consumed public synthetic
requests and the first 52 original development records, selected deterministically
before any new native calls. [Provenance](pilot-provenance.json) preserves original
file hashes and record IDs. They are development material, **never fresh
verification**. Repeated pilot inference is separately authorized new work recorded
in this new ledger, not replay of an old receipt.

Whole-profile selection and threshold tie-breaking must be fixed before dispatch.
Pilot comparison uses five-fold sorted-ID round-robin validation within these
consumed development requests, pooling out-of-fold displayed precision and recall.
Among eligible whole profiles, rank recall, then fewer false positives, then the
baseline on an exact tie; do not choose recognizers per record. Fold-level tuning
gaps remain reported; a full-pilot candidate must meet its minimum coverage and
precision constraints.

Calibration uses the selected exact 51-question profile and fresh diverse
single-task development requests. The candidate threshold grid remains
0.80–0.99 in steps of 0.01. The historical implementation maximized development
recall at at least 90% **per-concept** scored precision, then precision, using a
development score-plateau midpoint rather than automatically the highest tied
cutoff. That additional per-concept precision restriction is **stronger than the
approved aggregate requirement**, not an approved acceptance gate. It is retained
in the immutable source/report history rather than silently corrected after the
failed phase. Calibration requires ten distinct unnamed positive requests per
concept. Any tuning gap blocks freeze; no selective concept exclusion is permitted.

A separate [offline aggregate-objective diagnostic](../../scripts/diagnose-recall-calibration.ts)
now optimizes actual three-name displayed recall against aggregate precision and
per-class recall requirements. It cannot advance the failed native phase, access
acceptance data, authenticate, infer, promote policy or reactivate reminders. Its
bounded search result is development evidence only, not a proof of a global optimum.

Question wording is not changed from calibration answers. If neither predeclared
profile or the selected calibration policy can satisfy development constraints,
stop without opening acceptance content. Further wording iteration needs a
separately recorded development plan, not appropriation of acceptance data.

Freeze binds the selected catalogue and actual compiled wire questions, model,
extraction/name-suppression/selector source, all evaluation code, manifests,
prevalidation attestations, observations, thresholds, reports and cumulative ledger.
Only after this binding is durable may the tuning operator open acceptance text.
Any changed frozen input fails closed.

## Blinding, reference labels and prevalidation

Fixture authors read definitions and boundaries, not recognizers or model answers.
Independent reviewers first receive opaque IDs and request text with author labels,
named arrays, intended-primary metadata and concept-bearing groups removed.
Agreement is required for a positive label; disagreement or either ambiguous vote
is retained as ambiguous. Original author/reviewer files remain immutable;
consensus is a separate derivative. No human-review claim is made.

Authors may prepare twelve positive candidates per concept. Before inference,
independent preparation selects the first ten agreed unnamed **fresh-eligible**
positives by stable ID for each intended primary concept, plus the preregistered
controls. Extra or rejected author cases are retained as provenance, not silently
relabelled.

The pre-inference family audit identified 28 calibration-side setup collisions
against pilot/acceptance. The fixed acceptance selection remains unchanged.
Versioned curation excludes ineligible training cases before stable-ID selection,
uses the original spare candidates where possible, and requires six newly authored
and independently blind-reviewed training cases to restore the 612-case design.
The original selection, failed attestation and full author/reviewer pools remain
preserved. No classifier answers guided this preparation revision.

The tuning operator received calibration IDs and abstract forbidden-family
summaries to coordinate this repair, but not raw acceptance prompts, labels or
answers. This is not a claim of blinding to all scenario metadata. Question
formulations and the deterministic tuning algorithm were already drafted; this
feedback is used for split curation, not recognition-wording adaptation.
Scenarios must differ in actual task structure, not just names or substituted
entities. Genuine cross-concept positives remain fully labelled.

Before **any paid dispatch**, independent prevalidation checks normalized
uniqueness, cross-split and consumed-corpus overlap, source/session/scenario-family
leakage, all 51 labels on every row, named-label consistency, privacy, supported
annotation envelopes, agreed-positive denominators, planned attempts and hashes.
The tuning operator receives an aggregate hash-bound seal, not acceptance text.
Known near-dependence is reported; string normalization alone cannot certify
semantic independence. Insufficient denominators or leakage block collection.

Natural private requests are deterministically sampled from eligible direct user
turns dated 1 July–21 October 2026, with seed `2026102202`, before the present
terminology experiment. Selection precedes semantic labelling and does not enrich
for positives. Exclude skills/tool/system/task injections, current terminology
work, secrets, unsuitable lengths, normalized duplicates and substantial-prefix
overlap with consumed corpora. Preserve local sampling/source provenance. Missing
context is not repaired by treating unseen assistant material as the user's work.

Private text, labels, source provenance and per-private-request observations stay
outside Git with private file permissions. Eligible private requests **would be sent
to TypeSafe if acceptance were reached**; this round stopped before that dispatch.
Local storage is not local inference, and preparation-agent annotation is not
claimed to be local-only inference.
Only public invented fixtures/observations and privacy-safe aggregates may be
published. No private request is used to inspire a public synthetic example.

## Independent pre-dispatch safety audit

A read-only independent audit identified a selected-versus-displayed measurement
mismatch, a non-native-pilot transition into paid calibration, insufficient JSON
boolean validation for attestation checks, and missing observation-file fsync
before completion seals. All four were corrected and independently rechecked
**before any paid dispatch**. A follow-up also caught a test-only directory override
that could initialize native collection; non-dry overridden runs now require both
injected registry and matcher boundaries and cannot create portable native evidence.
No historical evidence is rewritten to hide these findings.

Full pre-dispatch `npm run check` passed: **95 test files, 2,002 passing tests and
two existing skips**; statement coverage 93.02%, branch coverage 88.89%, line
coverage 93.00%. Formatting, type-aware lint, TypeScript, coverage, Fallow and
Markdown gates were not relaxed. The retained check log is
`/tmp/pi-terminology-recall-preflight-check.log`.

The display issue matters even in offline candidate replay: the consumed synthetic
midpoint candidate has 118 selected true positives, but only 117 names visible in
the compact widget. Existing frozen diagnostic selections never exceeded three;
that does not justify ignoring the display cap for a more permissive candidate.

## Publication and activation

After collection, report failures and insufficient evidence as such. Development
or post-hoc improvements do not establish optimal generalization. If any gate
fails, the runtime policy remains unmeasured and no promotion is performed.

Passing fresh evidence permits considering a measured-policy update only after
preserving the preceding catalogue/policy/source snapshot and validating runtime
binding. Global activation remains a separate user decision even if acceptance
passes. The complete source-backed glossary remains browsable regardless of the
reminder-policy outcome.
