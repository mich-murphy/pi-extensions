# Production-path verification

**Passed the approved 90% scored-precision target.** The policy now measures all ten bundled concepts, including the four additions: accidental complexity, dead code, smoke test and separation of duties. Manual extension loading is still required; neither autoloading nor merging is authorized by this result.

## Frozen result

| Dataset | Prompts / calls | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Fresh private prompts | 280 | 6 | 0 | 12 | 100% | 33.33% |
| Public synthetics | 80 | 41 | 1 | 3 | 97.62% | 93.18% |
| Overall | 360 | 47 | 1 | 15 | **97.92%** | 75.81% |

There were no errors, missing calls, retries or ambiguous hits. Twenty private concept assignments remain explicitly ambiguous; they were not relabelled from model answers. Conservative precision consequently equals ordinary precision in this run. True positives, false positives and false negatives count concept assignments, not distinct prompts.

The cutoffs and gates were fixed before production answers: at least 90% precision overall and separately for each dataset, plus at least 50% public synthetic recall and unnamed positive coverage per concept. All gates passed. No probability cutoff, question or label was tuned after viewing these answers. This is a numerical pass, **not** a 90% statistical lower confidence bound.

### Per-concept results

| Concept | Probability cutoff | Overall TP / FP / FN | Overall precision | Synthetic recall |
| --- | ---: | --- | ---: | ---: |
| Accidental complexity | 0.91 | 6 / 1 / 5 | 85.71% | 100% |
| Dead code | 0.90 | 6 / 0 / 1 | 100% | 100% |
| Design by contract | 0.85 | 4 / 0 / 0 | 100% | 100% |
| Mutation testing | 0.85 | 4 / 0 / 0 | 100% | 100% |
| Property-based testing | 0.85 | 4 / 0 / 0 | 100% | 100% |
| Refactoring | 0.85 | 5 / 0 / 3 | 100% | 62.50% |
| Separation of duties | 0.91 | 6 / 0 / 5 | 100% | 100% |
| Smoke test | 0.90 | 4 / 0 / 1 | 100% | 100% |
| Test-driven development | 0.85 | 4 / 0 / 0 | 100% | 100% |
| Ubiquitous language | 0.85 | 4 / 0 / 0 | 100% | 100% |

**Known limitation:** public case `S079` already correctly says “Avoid accidental complexity.” The inherited negation heuristic removes that span before named suppression, producing the single redundant reminder. It is counted as a false positive, not excused as ambiguity. Accidental complexity therefore does not independently reach 90% in this small fresh sample; the precommitted precision gates apply to the overall/private/synthetic datasets, not each concept separately. No post-test suppression patch or selective exclusion is included in this measured policy.

The private set produced only six scored reminders, all within three new concepts. It contains eighteen unambiguous eligible concept assignments, no named positives and limited coverage of the original six seeds. Its 100% precision is sparse evidence, not proof of broad real-world quality. Private recall is deliberately reported rather than hidden. The public set provides four unnamed positives per concept, named controls, near misses, hypothetical/research negatives and annotation-envelope cases, but is synthetic and comparatively easy.

## Inputs and labelling

- A deterministic sample selected 300 fresh private prompts from an eligible pool of 932; the bounded dispatch used its first 280. Selection excluded normalized annotation-extracted equality and prefix/truncation overlap with 750 historical tuning and 600 historical third-split prompts. Sampling seed: `2026101522`.
- Two independent agents labelled the private prompts blind to production Jev answers. The synthetic author supplied labels and a separate blind agent reviewed all 80 prompts. These are agent judgements, not human-reviewed ground truth.
- A concept is positive only when both judgements agree. A disagreement or either borderline judgement becomes ambiguous. Named labels are the union restricted to agreed positives. All other labels are explicitly negative. Labelled examples concern current real work, not educational requests or quoted assistant material.
- The final private dataset has 18 positive, 20 ambiguous and 2,762 negative concept assignments. The synthetic dataset has 59 positive and 741 negative assignments, including 15 named assignments across 14 prompts. Named positives are excluded from the desired-reminder denominator, not from false-positive scoring.
- Sampling, labelling and the source freeze preceded production answers. This fresh run does not reuse the historical held-out sets for tuning or claim the old six-concept experiments measured the expanded wire path.

## Exact production path

The verifier used `matchWithNativeClassifier`, the native Pi TypeSafe SDK transport, the fixed `jev-1.13.0` model, complete per-concept cutoffs, versioned annotation extraction, `suppressAlreadyNamed` and the empty-state `selectMatches` path. It refuses unmodelled selector drops. User-specific hidden, dismissed and cooldown state is intentionally empty; it can only reduce reminders.

Named, omitted and structured wire criteria are supplied through a fail-closed native `onPayload` adapter, not approximated with placeholder SDK criteria. All questions in the mixed production catalogue are scoped to current real work. Legacy-only archive questions retain their historical compilation/hash behavior. Classification and suppression consume identical extracted text; literal headings in prose/fenced examples and quotes outside genuine annotation sections cannot replace the request.

The policy was written only after complete valid results, all gates passing, durable evidence writes and a final check that frozen inputs remained unchanged. The [manifest](manifest.json) commits dataset hashes, cutoffs, gates and eleven source-file hashes. Its exact bytes match the policy's `fixtureHash`. The aggregate [report](report.json) records the corresponding receipt, catalogue hash, actual wire criteria hash and frozen unmeasured-policy hash. Runtime changes require honest new verification, not rewriting this receipt.

## Published and withheld evidence

- [Synthetic fixtures](synthetic-fixtures.json): public-safe prompts and complete gold labels.
- [Synthetic observations](synthetic-observations.jsonl): public-only native probabilities and actual named-suppression decisions; no private records or raw provider envelopes.
- [Manifest](manifest.json) and [aggregate report](report.json): integrity commitments and complete dataset/per-concept metrics.
- Private prompts, private labels, raw native responses, original receipts and the separate verification ledger stay outside the repository. The manifest's `private-fixtures.json` is deliberately withheld; the public manifest alone cannot authorize a replay of private data.

Offline regression tests replay public probabilities through the reusable scorer, validate the published aggregates, and bind the measured policy to the manifest, wire questions and frozen source hashes. The ordinary local quality gate performs no live classifier calls.

## Budget and stop condition

Exactly 360 calls ran once with zero retries. The persistent receipt is consumed; do not rerun, delete it or reset the ledger. The separate $1 budget retained **$0.990904320** in conservative reservations (360 × 65,536 × 42 nanodollars). Historical production/exploratory ledgers and receipts were not changed.

Native usage reported 774,834 input tokens and 77,400 output tokens. At the documented $0.042 per million input tokens and free output, the usage-based estimate is **$0.032543028**, not a verified invoice. The SDK's native cost field was zero and is not treated as evidence of free service. Classifier calls are now stopped. Future tuning requires fresh data and explicit new approval, not reuse of this held-out set as untouched evidence.
