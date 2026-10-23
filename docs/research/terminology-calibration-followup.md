# Jev recall calibration follow-up

Initially an offline investigation, 22 October 2026. The user subsequently approved
a separate $5 / 1,800-attempt follow-up, which **stopped after 1,012 successful
development calls and before acceptance**. The findings below first describe the
original retrospective analysis; the later run is summarized separately. All
original evidence, source bindings, private files, consumed receipts and ledgers
are preserved. Runtime code/policy and activation are unchanged; reminders remain
unmeasured.

## Objective

Maximize useful recall subject to the accepted **90% empirically scored displayed
precision** constraint. A classifier probability of 0.90 is not a requirement for
90% measured precision. Nor does meeting a small development sample establish a
future precision or recall guarantee.

The existing acceptance protocol required 90% scored precision overall/private/
synthetic, at least 50% synthetic recall per concept, and positive private-prompt
usefulness gain. It did **not** establish an accepted aggregate recall target.
The stronger targets below were subsequently approved for a separate follow-up,
not retroactively applied to the original protocol.

Two medium-effort agents independently investigated score frontiers and semantic
failure causes. Both used consumed evidence only, without provider calls. The
parent independently checked the refactoring threshold-infeasibility counts.

## Finding 1: the tie-break favors brittle cutoffs

The expansion tuner ranks candidates by development recall, then precision, then
**higher threshold**. When several thresholds have identical development TP/FP,
this can choose a cutoff very close to the few observed positive scores.

Development support was thin: 36 of 51 concepts had exactly three unnamed
positives; 12 had identical scores across all their development positives.
Test isolation illustrates the resulting fragility: development scores supported
0.99, while all three diagnostic positives scored 0.98.

A candidate alternative chooses the center of the development TP/FP plateau,
between the highest excluded scored example and lowest selected positive,
respecting the 0.80 floor. The discrete version picks the nearest eligible
0.01-grid threshold, preferring the higher only on equal midpoint distance.
Ambiguous examples do not constrain a scored-precision plateau; this distinction
matters below.

### Retrospective replay, not new acceptance

These strategies use original development labels/probabilities to derive
thresholds. Comparing and choosing among them using the already-consumed
diagnostic is still retrospective model selection—not untouched verification.
The table retains the historical **uncapped selected-concept** metric. A later
independent pre-dispatch audit found that the compact widget names only three
selected concepts. In synthetic midpoint replay, that means 117 visibly named
true positives versus 118 selected true positives. The new experiment must score
actual widget exposure as primary and preserve uncapped selection as a separate
diagnostic; these retrospective numbers are not proof of displayed acceptance.

| Tie-break on original development grid | Development TP / FP / FN | Diagnostic TP / FP / FN | Scored precision | Recall | Conservative precision |
| --- | ---: | ---: | ---: | ---: | ---: |
| Frozen highest threshold | 172 / 0 / 17 | 95 / 4 / 48 | 95.96% | 66.43% | 91.35% |
| Lowest tied threshold | 172 / 0 / 17 | 127 / 19 / 16 | 86.99% | 88.81% | 79.38% |
| **Grid midpoint candidate** | **172 / 0 / 17** | **124 / 9 / 19** | **93.23%** | **86.71%** | **86.11%** |
| Continuous midpoint candidate | 172 / 0 / 17 | 124 / 8 / 19 | 93.94% | 86.71% | 86.71% |

The grid-midpoint candidate raises synthetic recall from 68.42% to **88.72%** at
92.91% scored precision and clears six of seven concept-level recall failures.
Only refactoring remains below the existing 50% floor. Synthetic macro recall
rises from 73.63% to 94.61%; micro and macro recall must not be conflated.

Private results improve from four to **six** true positives, with zero scored
false positives and four remaining false negatives: **60% recall**, not 85%.
There are also two ambiguous private hits; conservative private precision is
only **75%**. Six correctly reminded private requests merely matches the old-ten
observational subset—it does not establish a positive expansion-value gain.

Across the diagnostic, ambiguous hits rise from five to eleven. Thus the midpoint
candidate passes the numerical **scored** precision threshold in replay, but not
a hypothetical 90% **conservative** threshold. These are different objectives;
do not silently switch between them or ignore this uncertainty.

Removing the 0.80 search floor alone is not the remedy. With the original
highest-threshold tie-break, widening to 0.01–0.99 changes only smoke test to 0.73,
gains one synthetic TP and adds three FP. All seven recall failures remain.

## Finding 2: refactoring is not threshold-solvable on these observations

The nine synthetic refactoring-positive scores are:

`0.09, 0.15, 0.17, 0.25, 0.26, 0.47, 0.91, 0.95, 0.96`.

| Refactoring threshold | TP | FP | FN | Ambiguous hits |
| --- | ---: | ---: | ---: | ---: |
| Frozen 0.90 | 3 | 3 | 6 | 4 |
| 0.26 | 5 | 25 | 4 | 7 |
| 0.15 | 8 | 34 | 1 | 7 |

Meeting 50% recall requires at least five of nine positives, hence a cutoff no
higher than 0.26 and at least 25 refactoring false positives. Even granting **all
133** unnamed synthetic positive assignments as true positives and no other
errors, aggregate scored precision is at most `133 / (133 + 25) = 84.18%`.

Therefore **no threshold-only solution can meet the original simultaneous
synthetic precision and per-concept recall gates on these observations**.
Deleting refactoring, weakening reference labels to match answers, or relaxing
the acceptance gates would not fix the recognizer.

The most important semantic repair is to recognize a distinct behavior-preserving
restructuring **step**, even within a larger task that also adds a feature or fixes
behavior. Current wording can be interpreted as excluding the whole mixed task.
Make that distinction explicit without treating feature work alone as refactoring.

## Finding 3: preserve meanings while repairing recognition

| Concept/family | Diagnosis | Candidate repair to evaluate |
| --- | --- | --- |
| Test isolation, bisection, value object | Clear positives narrowly below high cutoffs. | First test robust operating points; do not rewrite canonical meanings to fit scores. |
| Low coupling | Definition covers limiting dependencies; recognition emphasizes reducing existing dependencies. | Include preventing unnecessary dependencies in a new design, not only removing existing ones. |
| Illegal states unrepresentable | Recognition unnecessarily requires replacing an existing permissive representation. | Include new representations and constrained construction, while requiring actual invalid-state exclusion. |
| Ablation | A component-removal case combined with blinded evaluation is missed. | Compatible additional practices should not negate a supported concept; test this independently. |
| Refactoring | Cleanup substeps and unreachable-code removal produce very low scores. | Explicit substep semantics; separately review the dead-code/refactoring boundary. |
| Parse-don't-validate overlaps | Some cross-labels have genuine interpretation uncertainty. | New score-blind definition review, preserving original results rather than relabelling a pass. |

None of the 24 misses across the seven original failure classes was blocked by
runtime already-named suppression. This does not prove extraction/suppression
perfect: some annotation controls use headings that do not exercise the actual
supported `## Annotation` envelope. Add valid-envelope and prose-lookalike cases.

Recognition rules, reference labels and runtime display suppression are separate
contracts. Report their errors separately, including explicit-name avoidance
requests, quoted suggestions, adoption/rejection and embedded substeps.

## Proposed next experiment — subsequently approved

**Status update:** the user subsequently approved these targets and the new
$5 / 1,800-attempt allowance. Implementation and run status are tracked in the
[recall experiment protocol](../../packages/pi-terminology/evals/recall/README.md).
The proposal below records the pre-approval design; approval does not activate
reminders or authorize replay of any prior experiment.

### Proposed acceptance targets

Keep the existing 90% scored precision gates overall and separately on natural
private requests and synthetic controls. Propose **85% overall recall** and
**70% minimum recall per concept**, rather than accepting an aggregate score that
hides dead categories. Also target **85% recall on adequately supported real
positive opportunities** and retain the requirement for positive private-prompt
usefulness gain. These are proposed empirical targets, not guarantees or already
approved policy.

Report per-concept precision, macro recall, ambiguous-hit/conservative precision,
novel-term opportunities, latency, selected-set stability and cooldown-adjusted
exposure separately. An aggregate optimizer must not quietly purchase recall by
making a few concepts consistently wrong.

Use at least **ten distinct fresh positive scenarios per concept** in acceptance;
two or three cannot distinguish 80%, 85% and 90% targets meaningfully. Prevalidate
the real-positive denominator before inference; if fewer than 20 distinct private
requests supply unambiguous unnamed opportunities, report insufficient evidence
rather than declaring real recall accepted or silently changing sampling.

### Candidate bounded allocation

| Stage | Maximum calls | Purpose |
| --- | ---: | --- |
| Question-formulation pilot | 400 | Two preregistered profiles over the same 200 diverse development requests. |
| Selected-profile calibration | 612 | Ten standalone primary positives and two targeted near misses per concept; label genuine overlaps honestly. |
| Fresh balanced positives | 510 | Ten independently authored positive scenarios per concept, disjoint by scenario family. |
| Fresh natural private requests | 200 | Base-rate-aware precision, opportunity coverage and real-request recall. |
| Additional fresh hard negatives | 40 | Annotation, negation, mixed-task and neighboring-concept boundaries. |
| Precommitted repeat probes | 24 | Stability, excluded from primary recall/precision denominators. |
| **Planned maximum** | **1,786** | Zero automatic retries; stop on failures or insufficient evidence. |

A proposed **$5 conservative cap / 1,800-attempt hard ceiling** would reserve at
most $4.954521600 at the existing 65,536-input-token reservation and tariff. The
listed allocation reserves $4.915986432. Actual usage can be lower, but is not
promised or treated as a provider invoice. This is a request for a new bounded
allowance, **not permission to reset or reuse old ledgers or receipts**.

If the two profiles cannot satisfy development constraints, stop before opening
fresh acceptance content. Calibration chooses thresholds only; wording changes
require returning to development, not adapting from acceptance answers. Freeze
all selected wire questions, extraction/suppression semantics and cutoffs before
verification. Compare to a frozen baseline without conflating same-request
probability subsets with a causal old-ten request comparison.

Before any paid dispatch, independent preparation must validate normalized
uniqueness, split/session/scenario-family overlap, complete labels, annotation
envelopes, denominator coverage, source hashes and total reservations. A blind
validator can do this without exposing acceptance text to the tuning operator.
No new runtime policy is published unless the approved fresh gates pass.

## Approved follow-up outcome

The [new development result](../../packages/pi-terminology/evals/recall/results.md)
records 400 pilot and 612 calibration calls, all successful, with zero retries.
The semantic-repair whole profile won the pilot's out-of-fold comparison, but
calibration exposed three per-concept failures despite **98.68% displayed scored
precision and 87.77% recall**: low coupling 47.37%, refactoring 6.25%, separation of
concerns 68.00%. No freeze, acceptance calls or policy promotion followed.

The implementation also exposed an objective mismatch: requiring 90% precision
for each concept is stronger than the approved aggregate constraint. Corrected
consumed-development replay reaches **94.64% recall at 90.69% scored precision**
when only aggregate targets are enforced, but refactoring recall is just 43.75%.
The best bounded search meeting all 51 concept recall floors found **91.62%
recall at 89.53% precision**, which fails. A new offline aggregate-objective tool
independently reproduces that latter TP547/FP64/FN50 result. Its heuristic is not
an exhaustive proof of joint displayed infeasibility and cannot advance the failed
native phase.

This identifies a real discrimination problem, not just a need to lower cutoffs:
refactoring needs a 0.90 cutoff to recover 23/32 positives, with 48 false positives.
Further recognition iteration requires a separately recorded development plan;
reference labels, definitions, receipts and the unopened acceptance selection must
not be rewritten to manufacture success.

The new run reserved **$2.785542144**, with a published-tariff usage estimate of
**$0.509237736**, not an invoice. The remaining planned 774 acceptance/repeat calls
were not made. Independent preparation found 26 real positive-opportunity prompts,
but no private performance or usefulness gain is measured in this round.

## Evidence used

- [Original protocol and result](../../packages/pi-terminology/evals/expansion/README.md)
- [Development references](../../packages/pi-terminology/evals/expansion/development-consensus.json)
- [Development observations](../../packages/pi-terminology/evals/expansion/development-observations.json.txt)
- [Consumed synthetic references](../../packages/pi-terminology/evals/expansion/heldout-synthetic-consensus.json.txt)
- [Consumed synthetic observations](../../packages/pi-terminology/evals/expansion/synthetic-observations.jsonl)
- [Original frozen cutoffs](../../packages/pi-terminology/evals/expansion/frozen-cutoffs.json)

Private reference labels and per-request observations were inspected locally for
aggregate calculations only; no private prompt text is reproduced here. All
replay variants and optimistic frontier calculations are development candidates,
not validated improvements or approval to activate reminders.
