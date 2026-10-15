# Second synthetic screen plan

## Authorization and boundaries

The developer authorized coordinated implementation, fresh review/fix, evaluation,
and final verification after reviewing the proposed next steps. Use
`openai-codex/gpt-6.1-sol` with high effort for subagents. No merge, activation,
installation, private-prompt evaluation, or new credential framework is authorized.

Preserve the initial fixtures, reports, raw archives, and consumed-set receipt.
The initial held-out score remains 33/37 (89.19%). Reuse its cases only as
explicitly identified development/regression material, never fresh acceptance data.

## Frozen acceptance rules

Declare these rules before any second-round classifier calls:

- Displayed-term precision must be at least 95%, with a nonzero denominator.
- Displayed-term recall must be at least 50% for each of the six concepts. This
  additional usefulness gate prevents an apparently successful policy from ignoring
  property-based testing or another concept entirely.
- Every concept must have at least four distinct eligible positive prompts in the
  held-out set. Already-named cases do not count as eligible positives.
- Errors, missing attempts, invalid probabilities/usage, or incomplete artifacts
  cannot pass. Zero transport retries; stop at the first error.
- Report per-concept counts, applicability and selected-term metrics, group errors,
  coverage, abstention, flips, latency, usage, and both estimated and reserved costs.
- Labels are independently agent-reviewed, not human-reviewed. Results remain a
  small synthetic screen, not representative real-world or statistically guaranteed
  precision. Do not relabel after inference to manufacture acceptance.

## Question comparison and selection

Prepare two fixed candidate catalogues before paid evaluation:

1. `instructions-focused`: direct behavior statements with explicit boundaries in
   the instructions and minimal aligned yes/no criteria.
2. `with-criteria`: direct behavior statements with detailed aligned positive and
   negative criteria. Mixed requests may satisfy more than one concept.

Platform constraint discovered before calls: Pi 1.1's public classifier contract
requires boolean criteria, although the TypeSafe HTTP API permits omission. Do not
bypass the native SDK, cast away its contract, or claim a criteria-free comparison.
Both candidates retain the required criteria. The comparison tests where the
semantic detail lives, not actual criteria omission.

Both candidates share the same sourced concept meanings, tips, aliases, and
recognition boundaries. Remove the unnecessary explicit counterexample-request
requirement from property-based testing, and ensure mutation testing alone is not
mistaken for a rule excluding requests containing both practices. Fix the
`property-based tests` already-named alias in code/data, not via a new model question.

Use 30 development prompts, two repetitions, for each candidate: 120 attempts.
Collect probabilities once, then sweep the existing 0.50 to 0.99 common-threshold
grid offline. A candidate must meet both precision and per-concept recall gates.
Select the highest displayed recall, then highest precision, then highest threshold;
use candidate ID as the deterministic final tie-breaker. No extra candidates or
paid development reruns. If neither qualifies, stop without opening held-out data.

Install only the selected candidate as the bundled glossary data and freeze its
catalogue, compiled criteria, model, fixture, threshold, and selection provenance
before any held-out prompt access by the tuning/evaluation owner. This is data
preparation, not extension activation. Keep the runtime policy unmeasured until
held-out acceptance passes.

## Independent fixtures and single use

A separate author uses the sourced definitions and agreed rubric, not question
variants, probabilities, or prior results, to prepare 40 new held-out prompts. A
separate reviewer adjudicates semantics before calls. Keep content out of tuning
agent and coordinator context until policy freeze. Freeze hashes after formatting.
Development may contain transparently identified old regression cases.

Run the new held-out set exactly once at the frozen policy, two repetitions:
80 attempts. No held-out sweeps, retuning, restarts, dropped failures, or silent
receipt resets. Version the approved dataset/experiment explicitly while retaining
the cumulative native-agent ledger and initial single-use protection. Reject
reuse through a different variant, labels, or formatting.

## Budget and delivery

At most 200 additional dispatched classifier attempts, including failures. Keep a
persistent round allowance so new process/run IDs cannot reset it. Continue using
the same native agent directory and cumulative $1 Jev / $5 overall caps. No public
ledger/profile override. At the current conservative per-call reservation, the
maximum cumulative reservation is $0.847773696 including the first 108 attempts.
Usage-based estimates are not verified provider invoices.

Every implementation, review, fix, and final verification stage runs unchanged full
quality gates. No new skips, broad suppressions, excluded artifacts, or lowered
thresholds. Independently reproduce the final metrics and provenance. Only after
acceptance passes, create and babysit the feature PR to merge-ready. Do not merge
or activate it. If the second screen fails, preserve it and stop for a new decision.
