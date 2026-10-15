# Initial synthetic screen

## Verdict

**Failed the 95% displayed-term precision target.** Development selected threshold
0.83; the single-use held-out screen retained that threshold and produced 33 correct
terms out of 37 selected terms (89.19%). The runtime policy remains unmeasured, so
automatic reminders remain disabled. No activation, merge, or further evaluation
is authorized by this result.

The developer approved independently agent-reviewed synthetic labels. The labels
are not human-reviewed or representative private-prompt validation. Both fixture
hashes were frozen before classifier calls. No held-out threshold sweep, retuning,
rerun, failed-attempt deletion, or dropped observation occurred.

## Results

Counts include two repetitions of each prompt. Repetitions are not independent
prompts. Selected terms include overflow available in matched details.

| Metric | Development | Held-out |
| --- | --- | --- |
| Unique prompts / completed attempts | 24 / 48 | 30 / 60 |
| Displayed-term precision | 19/19, 100% | 33/37, 89.19% |
| Displayed-term recall | 19/28, 67.86% | 33/44, 75% |
| False displayed terms / missed expected terms | 0 / 9 | 4 / 11 |
| Expected-nonempty attempt coverage | 16/18, 88.89% | 25/26, 96.15% |
| Abstentions | 32/48, 66.67% | 31/60, 51.67% |
| Attempts containing any false term | 0/48, 0% | 4/60, 6.67% |
| Nonempty groups containing any false term | 0/16, 0% | 4/29, 13.79% |
| Applicability precision / recall | 31/31, 100% / 31/40, 77.5% | 45/47, 95.74% / 45/56, 80.36% |
| Prompts with a selected-set flip | 1/24 | 1/30 |
| Latency mean / median / maximum | 212 / 204 / 312 ms | 207.47 / 202 / 314 ms |
| Input / output tokens | 40,326 / 6,192 | 50,724 / 7,740 |
| Errors / missing attempts / transport retries | 0 / 0 / 0 | 0 / 0 / 0 |

The pooled descriptive Wilson precision interval is 83.18% to 100% for development
and 75.29% to 95.71% for held-out. Repeated prompts, a small synthetic set, shared
conceptual patterns, and agent-reviewed labels prevent treating these as independent
real-world guarantees. Applicability accuracy is not displayed-term acceptance.

### Per-concept displayed counts

| Concept | Development TP / FP / FN | Held-out TP / FP / FN |
| --- | --- | --- |
| Design by contract | 4 / 0 / 0 | 6 / 0 / 0 |
| Mutation testing | 4 / 0 / 0 | 6 / 0 / 0 |
| Property-based testing | 0 / 0 / 6 | 1 / 2 / 9 |
| Refactoring | 3 / 0 / 3 | 10 / 2 / 2 |
| Test-driven development | 4 / 0 / 0 | 6 / 0 / 0 |
| Ubiquitous language | 4 / 0 / 0 | 4 / 0 / 0 |

The four false terms are property-based testing and refactoring, two each. This is
post-evaluation diagnosis only, not authorization to tune on these held-out cases.

## Cost and provenance

There were 108 native classifier calls, each with zero transport retries. Returned
usage totals 91,050 input and 13,932 output tokens. At the verified TypeSafe tariff
of $0.042 per million input tokens and free output, the usage-based estimate is
$0.00382410. The cumulative ledger retains $0.297271296 of conservative
reservations, below the $1 Jev and $5 overall caps. These are application accounting
figures, not a verified provider invoice. Earlier credential refusals dispatched
nothing and reserved nothing.

The requested model is `jev-1.13.0`. Pi reports the requested model ID, not an
independently attested serving identity. Catalogue, criteria, fixture hashes, run
IDs, timestamps, full metrics, development sweep, and budget totals are in the
archived `run.json` files. The held-out `freeze-receipt.json` records the policy hash
before held-out fixture loading. `development/policy.json` is the unchanged frozen
policy, including `measured: false`.

The JSONL observations contain public/synthetic fixture IDs, probabilities, latency,
and usage only, not credential data or private prompts. Original run artifacts
remain at `/tmp/pi-terminology-eval-20261014T100638Z-development` and
`/tmp/pi-terminology-eval-20261014T100638Z-heldout`. The readable `run.json` copies
are normalized only for repository formatting; `run.raw.json.gz` preserves each
original report byte-for-byte when decompressed. Observations, policy, and the
freeze receipt retain their original bytes. The native agent-directory budget
ledger and single-use receipt are not reset.

Further criterion changes and evaluation require an approved plan with a new,
independently labelled held-out set. Do not reuse this screen as a fresh acceptance
set or change the frozen threshold to manufacture a passing result.
