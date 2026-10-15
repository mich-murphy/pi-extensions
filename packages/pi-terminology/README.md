# Pi terminology

Pi terminology is an inactive-by-default Pi 1.1 extension that shows source-backed software terminology reminders outside the model context.

It does not rewrite prompts, inject instructions, invoke skills, or send glossary text to the coding model. The bundled policy gates automatic reminders independently of manual extension loading. This extension is not autoloaded. Browse the bundled glossary with `/terms` or `Ctrl+Shift+T` after manual loading.

Manual activation for local development:

```sh
pi -e ./packages/pi-terminology/index.ts
```

The root package manifest intentionally does not autoload this package.

## Project glossary consent

Project additions may live at the nearest Git repository root, or in the current non-Git directory only, at `.pi/terminology.json`. Approve that single canonical file with `/terms-approve`. Pi project trust is separate and does not grant glossary consent; glossary consent does not grant project trust or permission to load executable project resources.

A same-path ordinary edit or atomic replacement keeps approval. A symlink escape or retarget resolves to a different canonical file and is not read until approved. Declining approval means no project glossary bytes are read.

Minimal schema:

```json
{
  "schemaVersion": 1,
  "namespace": "my-project",
  "concepts": [
    {
      "id": "my-project:example",
      "label": "example term",
      "domain": "software design",
      "definition": "A concise sourced definition.",
      "references": [{ "kind": "web", "title": "Source", "url": "https://example.com" }]
    }
  ],
  "recognition": []
}
```

`core` is reserved for the bundled glossary. Project additions are browsable but unmeasured, so they do not activate automatic reminders.

## Commands and UI

- `/terms [query]` opens the searchable editor-area browser. Search covers IDs, labels, aliases, domain, definition, scope, related IDs and source fields.
- `/terms-hide <concept-id>` persistently hides one reminder.
- `/terms-restore <concept-id>` restores a hidden reminder.
- `/terms-dismiss <concept-id>` dismisses one reminder for the current session.
- `/terms-auth-refresh` rechecks native TypeSafe credentials for the current TUI session.

The compact above-editor widget shows up to three labels plus an overflow count. All selected terms remain available in the browser details. The browser does not fetch or open URLs.

## Classifier, auth and limits

Automatic reminders use Pi's native TypeSafe classifier registry, request `jev-1.13.0`, set `maxRetries: 0`, and use a five-second total advisory deadline. Credential resolution is preflighted at TUI session start or `/terms-auth-refresh`; input handling does not run secret-manager commands. The evaluation CLI also warms Pi's native TypeSafe auth snapshot before checking configured credentials, using the default agent `auth.json` and no profile override. Pi's native credential lookup can block synchronously before JavaScript can enforce the timeout, so slow credential commands can still delay startup, refresh or evaluation preflight.

The ten bundled concepts include the original six seeds plus **accidental complexity, dead code, smoke test, and separation of duties**. They are useful coverage, not a complete textbook vocabulary. The approved acceptance target is **90% empirically scored displayed precision**, distinct from a classifier probability cutoff or statistical confidence bound. Ambiguous reminders are reported separately; conservative precision is not substituted as a hidden acceptance gate.

| Concepts | Wire criteria | Probability cutoff |
| --- | --- | --- |
| Original six seeds | Legacy string criteria, scoped to current real work | 0.85 |
| Accidental complexity | Named string criteria | 0.91 |
| Dead code | Structured criteria | 0.90 |
| Smoke test | No criteria | 0.90 |
| Separation of duties | No criteria | 0.91 |

The native boolean API retains its required string placeholders; a validated `onPayload` adapter supplies the exact measured `noul` questions, including truly omitted or structured criteria. The policy hash covers the actual wire questions and versioned state/extraction/transport semantics. Mixed profiles use the same extracted annotation reply for classification and already-named suppression. Literal annotation headings in prose or fenced examples do not replace the request. Recognition-only aliases are separate from glossary synonyms: KISS is an accidental-complexity classifier/suppression cue, not a claim that the terms are synonyms.

See the [production verification evidence](evals/production/README.md) for fresh private-prompt aggregates, public synthetic fixtures, frozen cutoffs, provenance and limitations. Labels are independently agent-reviewed, not human-reviewed, and small samples do not establish a real-world guarantee. Manual extension loading remains separate from policy verification.

Historical evidence is preserved unchanged: the [initial synthetic screen](evals/results/2026-10-14/README.md) failed at 0.83 with 33/37 precision (89.19%); the [second synthetic screen](evals/results/2026-10-15-round-2/README.md) passed at 0.85 with 56/56 precision and 56/60 recall. Its six-concept policy is archived alongside that report, not overwritten.

Evaluation budget comments and reports use the official TypeSafe `jev-1.13.0` tariff: $0.042 per million input tokens and output free. TypeSafe documents a 64k-token total input limit for state plus questions and a 32k-token state plus longest-question sublimit. The ledger reserves 65,536 input tokens per call before dispatch, which is conservative for the tiny public fixtures.

## Production verification

The local-only verifier exercises the actual matcher, per-concept cutoffs, reply extraction, named suppression and empty-state selector. Its manifest commits complete ten-concept labels and SHA-256 dataset hashes. Private prompts and raw provider responses stay outside the repository; only public synthetic fixtures, commitments and aggregate evidence are published.

```sh
bun packages/pi-terminology/scripts/verify-production.ts --manifest /path/to/local/manifest.json --output /tmp/new-terms-run --dry-run
```

Dry runs read and validate inputs and preview budget only: no registry, credentials, calls or writes. With separate approval, omit `--dry-run` and optionally add `--write-policy`. The CLI has no auth, ledger, threshold or model override. A persistent single-use receipt prevents reruns. Failures burn the receipt, stop immediately and cannot activate a policy. Do not delete receipts or reset ledgers.

The fixed plan permits at most 280 fresh private prompts and 80 public synthetic prompts, once each, with zero retries. A separate $1 verification ledger reserves the full 360-call ceiling ($0.99090432) before proceeding; historical production and exploratory ledgers remain untouched. Acceptance requires complete valid results, at least 90% scored precision overall and separately on the private and synthetic sets, and at least 50% synthetic recall with unnamed positive coverage per concept. Only success with unchanged frozen inputs may write a measured policy. No cutoff tuning follows held-out answers.

`real-prompt-metrics.ts` provides reusable scoring and development-only policy tuning. Its default precision target is 0.90; an explicit target can reproduce historical 0.95 experiments. Score thresholds, minimum tuning evidence and held-out tuning safeguards are independent settings.

## Historical evaluation workflow

These commands document consumed, immutable six-concept experiments. The historical runner deliberately refuses the expanded production profiles; use the production verifier for the current catalogue. Archived catalogues are injected only by offline regression tests, never by CLI overrides.

Do not run live Jev calls without explicit approval and a fresh implementation review. The CLI requires Bun only for running operator TypeScript, not for loading the extension. No command activates the extension.

The default CLI retains the initial v1 workflow and its single-use receipt. Both v1 and v2 held-out sets and both v2 development variants are now consumed. All 200 additional approved calls completed, bringing the lifetime total to 308. Do not execute the live commands below again, delete receipts, or reset the ledger. The commands document the completed workflow. Round two is explicitly selected with `--dataset v2`; there is no dataset path, ledger, profile, or candidate override.

### Round-two development

The frozen [round-two plan](evals/round-2-plan.md) compares two immutable question catalogues. Pi 1.1 requires boolean criteria, so `instructions-focused` puts the full positive rules and boundaries in instructions with minimal yes/no criteria; `with-criteria` uses detailed aligned criteria. This is a question-structure comparison, not model training or a true no-criteria comparison.

After implementation review and budget approval, preview each development run:

```sh
bun packages/pi-terminology/scripts/evaluate.ts --dataset v2 --split development --variant instructions-focused --dry-run
bun packages/pi-terminology/scripts/evaluate.ts --dataset v2 --split development --variant with-criteria --dry-run
```

Dry runs never construct a registry, read credentials or held-out prompts, or write files. Approved real runs each collect exactly 30 prompts twice, serially, with zero retries:

```sh
bun packages/pi-terminology/scripts/evaluate.ts --dataset v2 --split development --variant instructions-focused --output /tmp/terms-instructions
bun packages/pi-terminology/scripts/evaluate.ts --dataset v2 --split development --variant with-criteria --output /tmp/terms-criteria
```

Each variant has a persistent, single-use receipt before fixture loading and dispatch. New output paths, run IDs, and processes cannot authorize another run. Failure burns that variant's receipt. Errors retain their full reservation and stop collection immediately. Artifacts include raw probabilities, a catalogue snapshot, metrics, estimated usage cost, conservative reserved cost, and native-bound integrity hashes. Do not edit them.

### Offline selection and explicit freeze

Selection requires both complete, clean, integrity-checked development runs. It constructs no registry and opens no held-out prompts:

```sh
bun packages/pi-terminology/scripts/evaluate.ts --dataset v2 --operation select --instructions-run /tmp/terms-instructions --criteria-run /tmp/terms-criteria --output /tmp/terms-selection
```

The offline 0.50 to 0.99 grid requires nonempty displayed precision of at least 95% and displayed recall of at least 50% for every one of the six concepts, each with a nonzero expected denominator. Rank eligible results by displayed recall, precision, threshold, then ascending candidate ID. If none qualifies, stop without opening held-out prompts. No automatic reruns or third variant are allowed.

Selection writes evidence, immutable candidate snapshots, and an unmeasured policy to the new directory. It does not change the runtime catalogue or policy. Review the evidence, explicitly copy only the selected candidate snapshot to `packages/pi-terminology/glossary/core.json`, then freeze:

```sh
bun packages/pi-terminology/scripts/evaluate.ts --dataset v2 --operation freeze --selection /tmp/terms-selection
```

Freeze recomputes development evidence, verifies the exact selected runtime catalogue and compiled questions, writes an unmeasured runtime policy, and records native provenance under the cumulative ledger lock. It never loads held-out prompts. A changed candidate, manifest, archive, runtime catalogue, or policy fails closed.

### Single-use acceptance

Only after policy freeze and separate approval:

```sh
bun packages/pi-terminology/scripts/evaluate.ts --dataset v2 --split heldout --dry-run
bun packages/pi-terminology/scripts/evaluate.ts --dataset v2 --split heldout --output /tmp/terms-heldout --write-policy
```

The new held-out receipt is persisted before loading its 40 prompts. Run exactly two repetitions, 80 attempts, at the frozen catalogue and threshold, without a threshold sweep. Acceptance additionally requires four distinct eligible positive prompts per concept. Canonical prompt hashes reject consumed legacy held-out or development prompts regardless of labels and formatting. Errors, invalid probabilities or usage, incomplete attempts, or failed usefulness gates cannot pass. Failure leaves the runtime policy unmeasured; only held-out acceptance can write `measured: true`.

All calls use the same native agent directory and cumulative `pi-terminology/eval-ledger.json`. The separate persistent round allowance is at most 200 additional attempts, including failures, while preserving the $1 Jev and $5 overall lifetime caps. The conservative reservation is 65,536 × 42 nanodollars per attempt. The original 108 plus 200 additional attempts reserve $0.847773696, not a verified provider invoice. Locks are exclusive and are never automatically stolen. Preserve both legacy and round-two receipts.

The second screen wrote its archived `measured: true` policy and consumed its allowance. That historical ledger retains $0.847773696 in reservations and a $0.011561256 usage-based estimate, not a provider invoice. These figures do not include the separate exploratory or fresh production-verification ledgers. Neither evaluation nor opening a PR authorizes merging or autoloading the extension.
