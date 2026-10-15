# Pi terminology

Pi terminology is an inactive-by-default Pi 1.1 extension that shows source-backed software terminology reminders outside the model context.

It does not rewrite prompts, inject instructions, invoke skills, or send glossary text to the coding model. The approved second synthetic screen passed and wrote a measured classifier policy. Automatic reminders are permitted if explicitly loaded, but this extension is not activated. Browse the bundled glossary with `/terms` or `Ctrl+Shift+T` after manual loading.

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

The bundled six core concepts are verified seed entries, not full textbook chapter coverage. Fixtures are independently agent-authored and separately agent-reviewed synthetic screens, not human-reviewed representative private prompts. The [initial synthetic screen](evals/results/2026-10-14/README.md) failed at its frozen 0.83 threshold: 33/37 precision (89.19%). The [second synthetic screen](evals/results/2026-10-15-round-2/README.md) selected `with-criteria` at 0.85 before new held-out access and passed: 56/56 precision (100%), 56/60 recall (93.3333%), and at least 80% recall per concept. The runtime policy is now measured, but extension activation is separate and has not occurred. These small repeated synthetic screens do not establish a real-world guarantee or an independent 95% precision lower bound. Fresh final acceptance verification and PR delivery remain pending.

Evaluation budget comments and reports use the official TypeSafe `jev-1.13.0` tariff: $0.042 per million input tokens and output free. TypeSafe documents a 64k-token total input limit for state plus questions and a 32k-token state plus longest-question sublimit. The ledger reserves 65,536 input tokens per call before dispatch, which is conservative for the tiny public fixtures.

## Evaluation workflow

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

The second screen wrote `measured: true`; paid evaluation is stopped. Lifetime retained reservations are $0.847773696 and the usage-based estimate is $0.011561256, not a provider invoice. Fresh final acceptance verification and unchanged full quality gates after coordinated edits stabilize remain pending before PR delivery. There is no authorization to merge or activate automatic reminders.
