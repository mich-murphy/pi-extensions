# Manual experimental preview: ready for personal testing

The actual 51-cutoff candidate is now bundled at
`glossary/preview-policy.json`. It is **off by default**, session-only, explicitly
unvalidated and requires confirmation plus a finite call allowance. Publication
made **zero provider calls**, changed no global configuration and did not activate
reminders. The production policy is still `measured: false`.

This completes preview packaging after the
[196-call native continuation](../continuation/results.md). Its native result's
`previewArtifactAvailable: false` records what existed when that phase finished;
this separate, later zero-call publication does not rewrite that sealed evidence.

## What the user needs to do

From this checkout, launch the pinned Pi version with the extension explicitly:

```sh
./node_modules/.bin/pi -e ./packages/pi-terminology/index.ts
```

Then, inside Pi:

```text
/terminology-status
/terminology-preview on 5
```

Confirm the warning to enable five attempts for that session. The published-tariff
conservative estimate for five attempts is at most **$0.0138**, not an invoice;
normal main-model usage is additional. Current request text is sent to TypeSafe.
If readiness is stale after changing credentials, use `/terminology-auth-refresh`.
`/terminology` remains the no-inference glossary browser.

The command family was renamed from `/terms*` to `/terminology*` with no legacy
aliases; see [command-rename scope](command-rename/README.md). New UI verification
results are pending; the UI evidence below predates the rename and is historical.

Use `/terminology-preview status` for all cutoffs, gaps and remaining calls, and
`/terminology-preview off` to stop immediately. Restart or reload leaves preview off;
allowance exhaustion does not replenish it automatically. No evaluation script
or consumed receipt needs to be run again.

No further user approval is needed for implementation or offline verification.
Further paid evaluation batches or persistent/global activation would need their
own explicit approval. The user's interactive preview confirmation controls these
personal-test calls; publication itself sends no prompts.

## Known limitations, visible in the confirmation

The first two gap messages are deliberately short enough to fit the confirmation:
**Refactoring P46%** and **Low coupling P63%**. These are per-concept development
precision warnings, not classifier confidence. Overall consumed-development scored
precision is 90.55%, recall 96.31%, but conservative precision is 88.06%. There is
no fresh acceptance, natural/private-request usefulness result or production claim.

Do not treat a suggested term as a replacement for the whole request. A misleading
suggestion is useful feedback during this trial; it is not permission to silently
relabel development data or tune against untouched acceptance content.

## Publisher and integrity

`scripts/publish-repair-preview.ts` is zero-call and defaults to dry-run. Its
`--publish` mode creates only the preview filename, preserves different existing
artifacts, and is idempotent for an identical candidate. Before publication it:

- Pins the completed native result, verifies its artifacts and fit seal, and
  requires literal native provenance for the combined 612-request matrix.
- Verifies all 26 original and four continuation source hashes, archives, ordered
  observations and the 1,428-preserved plus 196-new ledger prefix.
- Reproduces the complete fitted result from the sealed observations and unchanged
  labels, retaining all 51 concepts.
- Requires the runtime glossary to equal the native development candidate, computes bindings
  through `previewBinding`, and validates through `validatePreviewPolicy`.
- Retains `developmentOnly: true`, `measured: false`, `promotable: false`,
  `acceptanceStatus: "not-validated"` and the practical accuracy gaps.

The artifact includes provenance for inspection, and
`publication.json` independently records the artifact and publisher hashes.
Runtime intentionally consumes only its known preview fields, not extra provenance
metadata. It checks binding, thresholds and gaps across confirmation and in-flight
work; changes invalidate the active preview instead of silently replacing it.

## Actual-artifact offline TUI verification

`python3 packages/pi-terminology/scripts/verify-preview-tui.py` passed against the
**actual bundled candidate**, without `--synthetic-ui-fixture`, in the checkout's
pinned Pi 1.3.0. The journey verified:

- Initial off state; cancellation; explicit finite-allowance confirmation; full
  warnings and cost at 180×50 and 60×28.
- Browser/status/idle preserve allowance; off clears pending work; restart remains
  off; deliberate artifact mutation fails closed.
- Three actual interactive inputs reach an offline primary recorder unchanged.
  Two intercepted fake classifier answers produce the expected three-name widget
  and ephemeral cooldowns; the third input receives its main answer without a
  third classifier call after exhaustion. No reminder/context injection occurs.
- Fake credentials only, empty isolated auth store, first-loaded throwing network
  guard and OS `sandbox-exec` network denial; zero real provider requests or fetch
  calls. The disposable profile and owned tmux server were removed.

This is **UI/integration evidence, not new native inference or precision evidence**.
There were two fabricated local classifier responses and three offline inputs.
The full evidence is retained at `/tmp/pi-preview-evidence-jctbcvi3`; selected
public-safe summaries accompany `publication.json` here. Actual confirmation
captures also show both short weak-concept warnings in full at narrow width.
