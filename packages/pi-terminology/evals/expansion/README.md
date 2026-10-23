# Complete glossary expansion: verification

## Current status

Implementation contains **51 concepts and 51 recognizers**: ten unchanged
original entries and all **41 additions** from the research proposal, including
its eleven lower-priority candidates. The expanded runtime policy starts
**unmeasured**. Structural tests are not recognition evidence.

Live development completed **120/120** calls with zero errors and no tuning
gaps. Frozen per-concept cutoffs scored **172 TP / 0 FP / 17 FN** (100% scored
precision, 91.01% recall) on development data. Three ambiguous hits give 98.29%
conservative precision. All calls completed within five seconds; the maximum
was 422 ms. These are tuned development results, **not held-out acceptance**.

The original held-out preflight rejected one normalized duplicate in the private
dataset **before dispatching any held-out calls**. Its receipt remains consumed
and the policy remains unmeasured. See the [dataset erratum](dataset-errata.md)
for the separately recorded, non-promoting diagnostic follow-up.

**The diagnostic also fails to demonstrate sufficient value.** It completed all
239 calls, but seven concepts missed the synthetic recall floor, correct private
reminder opportunities fell from six to four against the observational old-ten
subset, and none of the 41 additions produced a correct reminder on this sparse
79-request private sample. Automatic reminders remain **disabled**. No more
classifier calls are authorized by this completed experiment.

## Diagnostic results — not an acceptance pass

| Dataset | Unique prompts | TP | FP | FN | Scored precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Private, deduplicated | 79 | 4 | 0 | 6 | 100% | 40.00% |
| Public-safe synthetic | 148 | 91 | 4 | 42 | 95.79% | 68.42% |
| Combined | 227 | 95 | 4 | 48 | **95.96%** | **66.43%** |

Five ambiguous hits occurred, all synthetic; conservative precision is **91.35%**
overall and 91% on synthetics. There were no redundant already-named reminders,
transport errors or retries. Counts are concept assignments, not unique prompts.
No selected group exceeded the three-label compact-widget limit in this sample.

Precision alone would conceal the failures:

| Concept | Frozen cutoff | Synthetic TP / FN | Synthetic recall |
| --- | ---: | ---: | ---: |
| Ablation study | 0.98 | 1 / 2 | 33.33% |
| Debugging by bisection | 0.98 | 0 / 2 | 0% |
| Low coupling | 0.98 | 1 / 5 | 16.67% |
| Make illegal states unrepresentable | 0.96 | 0 / 4 | 0% |
| Refactoring | 0.90 | 3 / 6 | 33.33% |
| Test isolation | 0.99 | 0 / 3 | 0% |
| Value object | 0.98 | 0 / 2 | 0% |

Only separation of duties produced scored private true positives: four correct
reminders across four requests. The original-ten subset at its archived cutoffs
produced correct reminders on six private requests. This is **negative gain of
two**, not evidence that expanding the vocabulary improved real-prompt coverage.
The reference labels contain only one agreed unnamed new-concept opportunity
(blast radius); it was missed. Sparse recent opportunity is not grounds for
removing unfamiliar, source-backed concepts from the browsable glossary.

The 12 precommitted repeat probes agreed on selected reminders in **11/12** cases
(91.67%); maximum probability movement was 0.08. All 239 diagnostic calls completed
within five seconds: median **279 ms**, maximum **443 ms**. This establishes a
working native path, not perfect stability or optimal calibration.

Development plus diagnostic consumed **359 attempts** with zero retries. The
shared ledger retains **$0.988151808** in conservative reservations. Native usage
totalled 4,252,549 input and 395,977 output tokens; the tariff-based estimate is
**$0.178607058**, not a provider invoice. Original verification used zero calls
before its preflight failure. Receipts and ledgers are preserved, not reset.

## Published and withheld evidence

- [Result and artifact hashes](result.json), exact [operator manifest](manifest.json)
  and [frozen cutoffs](frozen-cutoffs.json). The manifest includes original local
  paths and withheld-file commitments; it is not portable replay authorization.
- [Development reference labels](development-consensus.json),
  [native development observations](development-observations.json.txt) and
  [development report](development-report.json.txt).
- [Synthetic diagnostic reference labels](heldout-synthetic-consensus.json.txt),
  [public-only native observations](synthetic-observations.jsonl),
  [aggregate diagnostic report](diagnostic-report.json.txt) and its
  [single-use receipt](diagnostic-receipt.json.txt).
- [Consensus metadata](consensus-metadata.json) and [author rubric](rubric.md).
  Formatting-only provenance preserves the author's original development bytes;
  no labels were adapted from classifier answers.
- [Real terminal UI report](ui-report.json). The retained local captures and
  keyboard actions are at `/tmp/pi-terminology-evidence-y3kgydwi`.

The `.json.txt` files retain exact immutable JSON evidence bytes without formatter
rewrites. Offline regression tests validate hashes and replay every published
synthetic aggregate. Private prompts, private reference labels, per-private-prompt
probabilities, sampling provenance, original receipts and the shared ledger remain
outside the repository. No raw private request is published. Eligible private
request text **was sent to TypeSafe** during the approved native diagnostic;
keeping the files out of Git is not a claim that inference was local.

**Next development direction:** review the seven failure classes against their
definitions and examples, increase development diversity, and assess opportunity
coverage on less context-light requests. These diagnostic answers are now
consumed development material, not fresh verification data. Any later acceptance
needs corrected prevalidation, fresh held-out data and an explicitly approved new
budget. Keep the complete glossary; do not call the reminder policy well tuned or
activate it on the strength of in-sample precision.

Public definitions are in [concepts.json](concepts.json); matcher data is in
[core.json](../../glossary/core.json). Blind fixture authors use the former, not
the latter. Existing ten-concept production receipts and private data remain
untouched.

## Precommitted experiment

One fresh local run, `~/.pi/agent/pi-terminology/expansion-2026-10-22/`, has a
separate durable ledger. It permits **at most 360 attempts**, with **zero retries**
and **$1 of conservative Jev reservations**. The maximum full reservation is
$0.990904320. No failure, new output directory or process restart authorizes a
replay. The historical consumed ledgers are not reused or reset.

| Phase | Maximum unique prompts | Purpose |
| --- | ---: | --- |
| Development | 120 | Tune per-concept probability cutoffs using independently authored examples and boundaries. |
| Held-out synthetic | 148 | Fresh unnamed positives, near misses, named/negated/hypothetical/annotation and overlap controls. |
| Held-out private | 80 | Deterministic fresh direct-user requests, kept outside the repository. |
| Precommitted repeat probes | 12 calls | Stability checks, excluded from primary precision/recall denominators. |

On the same development probabilities, a fixed 0.90 cutoff scored 173 TP / 13 FP /
16 FN (93.01% precision, 91.53% recall); fixed 0.95 scored 150 TP / 3 FP / 39 FN
(98.04% precision, 79.37% recall). Per-concept tuning reduced false positives
without the large recall loss of a uniform stricter cutoff. This is an
in-sample comparison and can overfit; it does not establish optimal tuning.

All 51 native questions are sent per attempt. Development should provide at least
three distinct unnamed positives per concept; held-out synthetics should provide
at least two. Honest label disagreements can reduce those denominators and must
not be repaired using model answers.

### Labels and freshness

The fixture author and an independent reviewer work from definitions and
boundaries, blind to recognition wording and Jev answers. Review views omit the
author's labels. Consensus is positive only when both call it positive;
disagreement or either ambiguous judgement becomes ambiguous. Named labels are
the union restricted to agreed positives. These are **agent judgements, not
human-reviewed ground truth**.

Current real work is eligible. Educational or hypothetical examples, negated
approaches and quoted assistant material do not establish positive work requests.
A prompt may genuinely request several distinct concepts; related concepts are
not automatically interchangeable. Explicitly named positives do not count as
opportunities to teach a name.

Private sampling uses eligible main-session user prompts before this experiment,
excludes injected skills, tool-output echoes, current terminology work and
consumed-corpus normalized equality/prefix overlap, and separates annotation
replies from quoted context. Sampling provenance and raw prompts stay local.
Public examples must be independently invented, not redacted private requests.

The manifest commits development and held-out file hashes before tuning. Tuning
and freeze do not open held-out content. Verification burns its single-use
receipt **before** opening held-out files and checks development overlap. Neither
held-out answers nor held-out labels can guide a later cutoff sweep.

### Tuning and freeze

Use the actual native matcher at threshold zero to retain every concept's
probability, then replay extraction, current-request named suppression and the
empty-state runtime selector. No hidden, dismissed or cooldown preferences are
seeded into primary recognition metrics.

The fixed cutoff grid is **0.80–0.99 in steps of 0.01**, plus each original
concept's archived cutoff. Each concept needs three distinct unnamed development
positives and a nonempty result reaching at least 90% scored precision. Rank by
recall, precision, then higher threshold. A tuning gap prevents freezing the
complete catalogue; there is no selective exclusion to disguise it as a pass.

Freeze recomputes development selection, binds source/catalogue/wire questions,
manifest, observations and ledger, and records all 51 cutoffs before held-out
content is opened. Changed inputs or missing native evidence fail closed.

### Held-out acceptance and usefulness

Promotion requires a complete error-free run with unchanged frozen inputs:

- At least **90% scored displayed precision** overall, on private requests and on
  public-safe synthetics separately. An empty precision denominator does not pass.
- Nonempty unnamed synthetic positive coverage and at least **50% synthetic
  recall for every concept**.
- A positive gain in private prompts receiving a correct unnamed reminder,
  compared with the original ten-concept subset and its archived thresholds.

The old-ten comparison uses a subset of the **same 51-question probabilities**.
It is observational, **not a causal comparison with a separate ten-question
request** and not proof that naming a term improves coding outcomes. The no-call
baseline emits zero reminders, including zero false positives.

Report per-concept and grouped false positives, recall, ambiguous hits and
conservative precision separately. Also report already-named redundancy,
private opportunity coverage, latency including failures, and any repeat
instability. Small, related samples do not prove optimal tuning, a statistical
precision guarantee or long-term value. User acceptance of the reminders remains
an important missing measure.

## Operator interface

The implementation is
[`scripts/evaluate-expansion.ts`](../../scripts/evaluate-expansion.ts). Bun runs
operator TypeScript; Pi loads the extension normally without Bun.

The CLI takes `--phase tune|freeze|verify`, `--manifest`, `--output` and optional
`--dry-run`. Only live verify accepts `--write-policy`. Outputs must remain below
the fixed private run directory; there is no CLI auth, model, ledger, cutoff or
catalogue override. Dry runs construct no registry, resolve no credentials and
write nothing. Held-out dry runs do not open held-out prompt content.

The one-off [preflight diagnostic](../../scripts/diagnose-expansion-preflight.ts)
has fixed original commitments, shares the same ledger, and has no policy-writing
path. Its receipt is now consumed too; it is not a general replay escape hatch.

Do not run a consumed phase again or delete its receipt. Errors retain full
reservations and stop collection. A policy can be published only after accepted
held-out evidence is durably written and every frozen input is rechecked.

## Independent UI verification

[`scripts/verify-tui.py`](../../scripts/verify-tui.py) exercises the checkout's
pinned Pi in an owned, disposable terminal with isolated HOME and agent directory,
no real credentials and no provider inference. It is distinct from the live Jev
recognition experiment. Evidence must identify actual keyboard actions, terminal
captures, state side effects, restart behavior and owned-process cleanup, rather
than treating mocked browser rendering as an end-to-end pass.

The real terminal journey passed for all 41 new canonical labels and all eight
published new aliases, at 180×50 and 60×28, including source scrolling,
hide/restore across fresh processes and corrupt-state preservation. It used no
model prompts or real credentials; HTTP traffic was not independently captured.

Final `npm run check` passed: **92 test files, 1,950 passing tests, two existing
skips**; statement coverage 93.88%, branch coverage 89.47%, line coverage 93.78%.
Formatting, type-aware lint, strict TypeScript, all three Fallow gates and Markdown
lint passed without changing their thresholds or exclusions. Public evidence
hashes and every synthetic diagnostic aggregate replay offline.

Neither experiment installs the package, edits global settings nor enables
root-manifest autoloading. Use `/terms-status` in an explicitly loaded instance to
check whether automatic reminders can run.
