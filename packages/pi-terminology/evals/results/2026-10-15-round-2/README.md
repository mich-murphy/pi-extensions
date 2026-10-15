# Second synthetic screen

## Verdict

**Passed the frozen synthetic-screen acceptance rules.** Offline development
selection chose `with-criteria` at threshold 0.85 before new held-out access.
The single-use held-out run produced 56 correct displayed terms, zero false terms,
and four missed expected terms: 100% precision and 93.3333% recall. Every concept
passed the 50% recall gate, with a minimum of 80%.

The runtime policy is now `measured: true`, bound to the accepted catalogue and
criteria. It permits automatic reminders if the extension is explicitly loaded;
the extension is not activated, globally installed, or included in the root
extension list. Fresh independent final verification reconstructed every new
observation, sealed archive, frozen selection and cumulative settlement. Its full
unchanged gate passed: 1220 tests, zero failures, one existing skip, across 68 files.
PR delivery and CI are tracked separately. No merge or activation is authorized.
All 200 approved additional calls are complete; stop paid evaluation.

The [initial screen](../2026-10-14/README.md) remains a failed historical result:
33/37 precision (89.19%) at its frozen 0.83 threshold. Its labels, results, artifacts,
and consumed receipt are unchanged. Round two does not relabel or replace it.

## Results

Counts include two repetitions per prompt, not independent observations. Displayed
terms include overflow available in browser details.

| Metric | Development: instructions-focused | Development: with-criteria | New held-out: selected policy |
| --- | --- | --- | --- |
| Unique prompts / completed attempts | 30 / 60 | 30 / 60 | 40 / 80 |
| Outcome / threshold | No qualifying policy / 0.99 fallback | Selected / 0.85 | Passed / frozen 0.85 |
| Displayed TP / FP / FN | 0 / 0 / 38 | 34 / 0 / 4 | 56 / 0 / 4 |
| Displayed precision | Undefined, no selections | 34/34, 100% | 56/56, 100% |
| Displayed recall | 0/38, 0% | 34/38, 89.4737% | 56/60, 93.3333% |
| Expected-nonempty attempt coverage | 0/30, 0% | 30/30, 100% | 38/40, 95% |
| Abstentions | 60/60, 100% | 30/60, 50% | 42/80, 52.5% |
| Attempts containing any false term | 0/60 | 0/60 | 0/80 |
| Nonempty groups containing any false term | Undefined, no selections | 0/30 | 0/38 |
| Applicability precision / recall | Undefined / 0/62, 0% | 48/48, 100% / 48/62, 77.4194% | 72/72, 100% / 72/84, 85.7143% |
| Prompts with a selected-set flip | 0/30 | 0/30 | 0/40 |
| Latency mean / median / maximum, ms | 202.8667 / 198 / 290 | 203.85 / 199 / 278 | 204.1125 / 198 / 335 |
| Input / output tokens | 53,088 / 7,740 | 55,848 / 7,740 | 75,282 / 10,320 |
| Errors / missing attempts / transport retries | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

The instructions-focused column is the report's all-abstaining 0.99 fallback,
not an eligible policy or evidence that the model never recognizes these concepts.
For example, its offline sweep at 0.60 has 100% displayed precision and 68.4211%
aggregate recall, but does not satisfy every concept's usefulness gate.

### Per-concept displayed counts

| Concept | Selected development TP / FP / FN | Development recall | Held-out TP / FP / FN | Held-out recall |
| --- | --- | --- | --- | --- |
| Design by contract | 6 / 0 / 0 | 100% | 10 / 0 / 0 | 100% |
| Mutation testing | 4 / 0 / 0 | 100% | 10 / 0 / 0 | 100% |
| Property-based testing | 4 / 0 / 4 | 50% | 10 / 0 / 0 | 100% |
| Refactoring | 8 / 0 / 0 | 100% | 8 / 0 / 2 | 80% |
| Test-driven development | 6 / 0 / 0 | 100% | 8 / 0 / 2 | 80% |
| Ubiquitous language | 6 / 0 / 0 | 100% | 10 / 0 / 0 | 100% |

Every held-out concept has five distinct eligible positive prompts, exceeding the
four-prompt minimum. Counts repeat those prompts twice. Applicability metrics are
reported separately and do not determine displayed-term acceptance.

## What the comparison shows and does not show

Both fixed variants use Pi 1.1's required boolean criteria. Instructions-focused
puts semantic detail in instructions with minimal yes/no criteria; with-criteria
uses detailed aligned criteria. On this development set, only with-criteria met
the declared precision and per-concept recall gates. Its selected policy then
passed a new held-out screen. This is manually refined question design and a
data-driven two-variant comparison, not model-weight fine-tuning, a true
with/without-criteria comparison, or a general causal claim about criteria.

An independent agent authored 30 development and 40 new held-out records; a
separate blinded agent reviewed all 70 labels before inference. These are not
human-reviewed labels. Six held-out requests were revised for construction
diversity before any calls, with no ground-truth changes. After independent
authoring and semantic freeze, authorized legacy-overlap QA informed two of those
rewrites through limited legacy excerpts. Final review found zero canonical
held-out duplicates or remaining genuine near-template blockers against new
development and both consumed legacy splits. The same reviewer performed the
re-reviews, not an independent third reviewer. See `evals/v2/manifest.json` for
provenance and limitations.

This is a small public synthetic screen, not representative private-prompt
validation. Five positive prompts per concept and repeated attempts do not
establish real-world precision. The pooled descriptive Wilson interval is 93.58%
to 100% for held-out precision, not a 95% lower-bound guarantee. The acceptance
target is a 95% precision point estimate, distinct from the 0.85 classifier
probability threshold. No held-out sweep, retuning, relabeling, or rerun occurred.

## Cost and preservation

The round completed exactly 200 calls: 60 per development variant and 80 held-out,
with zero retries. Returned usage totals 184,218 input and 25,800 output tokens.
At $0.042 per million input tokens with free output, the round's usage-based
estimate is $0.007737156; conservative retained reservations are $0.550502400.
Including the original 108 calls, lifetime totals are 308 calls, $0.011561256
estimated usage cost and $0.847773696 retained reservations, below the $1 Jev and
$5 overall caps. These are application accounting estimates, not provider invoices.

Pi requested `jev-1.13.0`; its SDK reports the requested ID, not an independently
attested serving identity. The accepted hashes are:

- Catalogue: `08b7d26717845639e6b7954c5112cbbd2ea1235656a0ea7f61ba1526ec1c7a36`
- Compiled criteria: `132fddc7c3400dfbab3c27944f254126d2f89838581bc0d2c42921743fba818d`
- Held-out fixture: `40f256589cc568d0e5ba0037a9cb272137a8f542898d8ba0659f168abc140727`

Original sealed artifacts remain under
`/tmp/pi-terminology-v2-20261015T000035Z-{instructions,criteria,selection,heldout}`.
The four sibling `*.raw.tar.gz` archives preserve those files byte-for-byte,
including raw observations, candidate/question snapshots, policies, integrity
records, selection and freeze evidence. Readable `run.json`, `selection.json` and
`freeze.json` copies are normalized only for Oxfmt. Public synthetic observations
contain IDs, probabilities, latency and usage, not credentials or private prompts.
The native cumulative ledger, original receipts and round-two single-use receipts
are retained without resets. Preserve the frozen plan and all raw artifacts.
