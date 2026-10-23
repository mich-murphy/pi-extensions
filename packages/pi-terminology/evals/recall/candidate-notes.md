# Recall recognition candidates

These are offline development candidates, not runtime-loaded policy or measured
improvements. The expanded reminder policy remains unmeasured. No provider,
authentication or native calls were used to prepare these files. Preparation used
only the follow-up research and frozen/current catalogue, compiler and metric
contracts; no fresh calibration or heldout content or answers were inspected.

## Frozen scope

`baseline-core.json` is a byte copy of `../../glossary/core.json` at preparation.
`semantic-repair-core.json` preserves all 51 canonical concept records, including
the original ten, definitions, aliases and provenance. Only recognition criteria
for the five concepts below differ. All questionStyle choices, tips, extraction
and compiler behavior remain pinned. Test isolation and debugging by bisection
have clear meanings and unchanged criteria: their observed near-threshold misses
motivate robust cutoffs, not rewriting their meanings to fit scores.

## Criteria alignment, not definition rewrites

- **Refactoring:** explicitly recognize a distinct behavior-preserving internal
  restructuring/cleanup step within broader feature or behavior-fix work. Feature
  work alone still does not qualify. Removing established unused/unreachable code
  can qualify as behavior-preserving cleanup; removing reachable needed behavior
  does not. The old whole-task exclusion was too broad.
- **Low coupling:** include limiting/preventing unnecessary dependencies in a new
  design, not just reducing existing dependencies. More files alone is insufficient.
- **Make illegal states unrepresentable:** include new models and constrained
  construction, not only replacement of an existing permissive representation.
  Actual exclusion of specified invalid combinations remains necessary.
- **Value object:** value-based equality rather than persistent identity is the
  criterion; immutability supports that design but is not mandatory.
- **Ablation study:** a compatible additional practice such as blinded evaluation
  does not negate an otherwise supported component-removal comparison. Blinding
  alone is still not ablation.

There is no gold relabelling from model answers. The existing synthetic
refactoring frontier cannot meet both 90% aggregate scored precision and 50%
refactoring recall: reaching five of nine positives entails at least 25 false
positives, an optimistic aggregate ceiling of 133/(133+25) = 84.18%. Semantic
recognition repair is necessary; hiding the concept or changing reference labels
would not solve that failure.

## Robust cutoff contract

`../../recall-calibration.ts` exports `tuneRecall`, `compareRecallProfiles`,
`RecallOptions` and `RecallResult`. Inputs use the original `RealPromptDataset`
contract and complete-matrix validation through `computeRealPromptMetrics`.
Exactly one pinned question variant is required per concept. Heldout fitting is
rejected. No calls, text IO, mutation, runtime policy or accepted-policy output.

Defaults: ten distinct unnamed positive scenarios per concept, 0.90 empirical
scored precision, 0.70 per-concept recall. A preregistered whole-profile pilot may
explicitly request minimum three and recallFloor zero; these do not change final
acceptance requirements. Repeats never multiply distinct-positive support.

The candidate grid is 0.80 through 0.99 inclusive, at 0.01 steps; all archived
expansion cutoffs are included. This lowers the earlier real-prompt tuner's 0.90
search floor, not the empirical 90% precision constraint. Never search zero or
disable a concept. Each concept maximizes attempt recall subject to scored
precision, then precision. For the winning TP/FP plateau, choose the eligible
grid point nearest the midpoint between the highest excluded scored observation
and lowest selected unnamed positive, respecting the 0.80 floor. Choose the higher
grid point only on an exact equal-distance tie (decimal arithmetic tolerance
1e-12). With no excluded scores above the floor, the floor bounds the midpoint.
Ambiguous hits do not constrain this scored-precision plateau; report their
conservative precision separately.

Gold `named` remains independent of runtime `alreadyNamed`. Runtime suppression
is retained in original metrics, including over-suppressed false negatives; those
false negatives are not removed from recall. Named reminders remain false
positives even when their underlying concept label is positive.

Every concept has an enabled in-grid diagnostic threshold even when infeasible.
Insufficient support, precision or recall produces a named gap; any gap blocks
the entire profile. Infeasible diagnostics maximize recall then precision and
must not be mistaken for a valid precision-constrained solution. Profile
comparison tunes entire matrices independently with identical gold, never picks
recognizers per record. Development fit does not establish accepted precision,
recall, usefulness gain or a future guarantee. Freeze wire questions and cutoffs
before untouched acceptance; wording changes must return to development.
