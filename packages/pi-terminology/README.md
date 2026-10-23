# Pi terminology

A Pi **1.3.0** extension that offers source-backed software terminology reminders
outside the coding model's context. The complete extended glossary has **51
concepts**: the original ten plus all 41 researched additions, including the
previously lower-priority candidates.

It does not rewrite prompts, inject instructions, invoke skills, or teach the
coding model automatically. A term names an aspect of a request; it does not
replace the request's requirements or prescribe an entire workflow.

## Loading and readiness

The root package manifest now **autoloads** this extension alongside the other
workspace extensions. `/terminology` and `/terminology-status` are available after
the package loads or reloads. Loading alone makes no classifier calls and never
enables the experimental preview. For isolated local development:

```sh
pi -e ./packages/pi-terminology/index.ts
```

Then use `/terminology` to browse and `/terminology-status` to inspect readiness. Merely having
this workspace on disk does not load it unless Pi loads the root package or this
entry point. The user authorized root-manifest inclusion; no global settings were
changed. Evaluation commands never install or activate the extension.

Browsing requires neither TypeSafe credentials nor a measured policy. Production
automatic reminders require **all** of: loading the extension, interactive TUI input, ready
native TypeSafe authentication, and an accepted policy bound to the exact
catalogue and wire questions. A fresh, unverified expansion is deliberately
unmeasured; do not copy old evidence or thresholds to activate it.

See [expansion verification](evals/expansion/README.md) for the current experiment
status and limitations. The [older production result](evals/production/README.md)
measured ten concepts, **not** the expanded glossary.

## Commands and UI

- `/terminology [query]` opens the searchable editor-area browser. Search covers IDs,
  labels, genuine aliases, domain, definition, scope, related IDs and sources.
- `/terminology-status` reports concept and recognizer counts, policy status, mode and
  credential readiness. It does not run a classifier or resolve secret commands.
- `/terminology-hide <concept-id>` persistently hides a reminder.
- `/terminology-restore <concept-id>` restores a persistently hidden reminder.
- `/terminology-dismiss <concept-id>` dismisses a reminder for this session.
- `/terminology-auth-refresh` refreshes native authentication for the TUI session.
- `/terminology-approve` requests consent to read this repository's project glossary.
- `/terminology-preview` controls the session-only experimental preview (below).

The command family was renamed from `/terms*` to `/terminology*` (eight commands
in total); there are no legacy aliases.

`Ctrl+Shift+T` opens the browser. Use arrow keys to move between terms,
`PageUp/PageDown` to move through the list, and `Enter/Right` to visit the first
related entry. Escape goes back, clears a query, or closes the browser. Typing `q`
searches; it does not quit.

Long details are scrollable: `Ctrl+Up/Down` scrolls definition, scope and sources;
`Ctrl+Home/End` jumps to their start/end. Source references remain accessible at
narrow widths instead of being silently discarded after ten lines. The browser
never fetches or opens source URLs.

The compact above-editor reminder displays up to three labels plus an overflow
count. All selected terms remain available in the browser. Already-named current
requests, hidden or session-dismissed concepts, and a **24-hour per-concept
cooldown** reduce repetition. Naming a term in an unquoted current negative
request also suppresses a redundant reminder—for example, “Avoid accidental
complexity.” Historical and quoted context is treated separately.

Malformed or unreadable preference state no longer blocks bundled browsing.
The extension warns, avoids reading project glossaries, disables automatic
reminders, and preserves the original state bytes. Repair
`<Pi agent directory>/pi-terminology.json` rather than resetting preferences or
approvals silently. Preference writes still fail rather than overwriting corrupt
state.

## Glossary principles and coverage

The [research proposal](../../docs/research/terminology-expansion.md) explains
selection, definitions, provenance and important distinctions. The glossary
includes design and types; testing and debugging; reliability and security;
documentation and interaction design; and experimental methods.

Each concept has an ordinary-language definition and source references. New
entries include explicit scope boundaries and related concepts. Practitioner
references such as Matt Pocock and Lauren Tan (Poteto) are accepted with honest
attribution to earlier authors. A skill's invocation name does not automatically
become a canonical concept or alias.

Definitions/provenance and recognition are separate records. Recognition-only
cues are not automatically glossary synonyms: KISS, for example, remains a cue
for accidental complexity, not an assertion that the terms mean the same thing.
The public [definitions-only catalogue](evals/expansion/concepts.json) permits
fixture authors to work independently of matcher wording.

## Classifier, privacy and limits

Reminders use Pi's native TypeSafe registry with the pinned **`jev-1.13.0`** model,
zero automatic retries and a **five-second total advisory deadline**. Only
eligible, text-only interactive TUI prompts are classified; RPC, extension,
slash-command, image and oversized inputs do not trigger reminders. A later
model-bound input invalidates an earlier pending reminder.

The current request is sent to TypeSafe with terminology questions. It is not
sent as a glossary injection to the coding model. Annotation replies are
extracted consistently for both classification and already-named suppression;
quoted annotation context does not supply the current request.

Credential resolution is preflighted at session start or explicit auth refresh,
not on every input. Native synchronous secret-manager commands can still delay
startup or refresh before JavaScript can enforce its timeout. There is no auth
profile override or credential printing in the evaluators.

The policy binds the full catalogue hash and actual compiled wire questions,
including versioned extraction/state/transport semantics. Adding even a
definition-only entry changes the catalogue hash. Project additions remain
browsable but unmeasured for automatic reminders.

## Project glossary consent

Put project additions in `.pi/terminology.json` at the nearest Git repository
root, or the current non-Git directory. Approve that single canonical file with
`/terminology-approve`. Pi project trust and glossary consent are independent; neither
grants the other or permission to load executable project resources.

An ordinary edit or atomic replacement at the approved path retains approval.
Symlink escapes or retargets resolve to another canonical file and need consent.
Declining approval means no project glossary bytes are read.

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

`core` is reserved for the bundled glossary.

## Verification and immutable historical evidence

The original expansion used a separate development/freeze/held-out protocol,
independent blind labels, real private requests and public-safe synthetic
controls. It closed at **359 attempts** within its **360-attempt / $1 conservative
reservation cap**, without acceptance. Its [protocol and evidence](evals/expansion/README.md)
remain unchanged.

The separately approved [recall follow-up](evals/recall/results.md), capped at
**1,800 attempts / $5**, stopped after **1,012 successful development calls** because
three concepts failed their recall floors. No acceptance calls or promotion
followed. A corrected offline aggregate-precision optimizer does not bypass that
failed phase. Runtime reminders remain unmeasured and disabled; the 51-concept
browser is unaffected.

The acceptance target is **90% empirically scored displayed precision**. It is
not a 0.90 classifier cutoff or statistical lower confidence bound. Real-prompt
coverage, recall, ambiguous hits, latency, redundant reminders, overlap and
usefulness versus the old vocabulary must be reported separately. A passing
synthetic score alone does not establish real value or optimal tuning.

The documented TypeSafe tariff is $0.042 per million input tokens, output free.
Each attempt reserves 65,536 input tokens at that tariff before dispatch; usage
estimates are not provider invoices. Failed attempts retain their reservations.
Receipts, ledgers and consumed datasets must never be reset to permit a replay.

Historical evidence remains unchanged:

- [Initial six-concept screen](evals/results/2026-10-14/README.md): failed.
- [Second six-concept screen](evals/results/2026-10-15-round-2/README.md): passed its
  historical gates, now consumed.
- [Ten-concept production verification](evals/production/README.md): passed its
  precommitted gates, but private recall was 33.33% with only six true-positive
  assignments. Its archived [core](evals/production/core.json),
  [policy](evals/production/policy.json) and inert
  [source snapshots](evals/production/source/README.md) bind that evidence to what
  actually ran, not the new glossary.

The historical evaluators and commands are not authorization for another paid
run. New tuning needs a deliberately bounded new plan and fresh held-out data.
The ordinary offline tests make no live provider calls.

## Session-only experimental preview

**Ready for personal testing:** the 51-cutoff experimental candidate is bundled,
validated and verified in the actual Pi TUI. It is **off by default**; nothing was
activated or globally installed. Load the extension as above, then use
`/terminology-preview on 5` and confirm to try five session-only attempts (conservative
published-tariff estimate at most $0.0138, main-model usage additional).
See [preview instructions and verification](evals/repair/preview/README.md).

The completed development fit passes its numerical gates (90.55% scored displayed
precision, 96.31% recall), **not fresh acceptance**. Refactoring precision is only
46.15%, low coupling 63.33%, and conservative aggregate precision 88.06%. Those
weak-concept warnings appear in the confirmation. The
[continuation evidence](evals/repair/continuation/results.md) remains unchanged;
the later zero-call publisher does not mark it accepted or measured. The 196-call
approval is consumed, and no later evaluation replay is authorized.

Preview is **off by default** and never persisted or enabled by loading the
extension. Production policy remains unmeasured; preview is not evidence that
acceptance gates passed. A missing or incompatible `glossary/preview-policy.json`
makes preview unavailable (there are no fallback cutoffs).

- `/terminology-preview status` reports availability, model, profile hash, all candidate
  cutoffs, validation gaps, readiness and calls remaining without resolving secrets
  or running inference. `/terminology-status` also includes this snapshot.
- `/terminology-preview on [max-calls]` requires interactive TUI, configured native
  TypeSafe authentication and an explicit confirmation. The default allowance is
  20 attempts; choose 1–100 per enable. Each eligible current request is sent to
  TypeSafe **jev-1.13.0**, with no retries and a five-second total deadline.
  The conservative published-tariff per-attempt estimate (not an invoice) is
  `$0.002752512`
  (`65536 * $0.042 / 1,000,000`); failures consume allowance too. The default
  20-attempt total estimate is rounded up to `$0.0551`; main Pi model usage is
  additional. The complete serialized classifier request must fit 63 KiB,
  leaving 1024 tokens for special-token overhead. Oversized requests are skipped
  without a classifier call, allowance debit, or change to your normal prompt.
- `/terminology-preview off` immediately clears the reminder and cancels pending work.
  Session replacement/reload/restart disables preview. No event replenishes it.
  Only another explicit confirmation grants a fresh allowance.

Preview shows at most three clearly experimental names, respects hidden,
dismissed, already-named and 24-hour cooldown guards, and adds nothing to model
context. `/terminology` remains the non-inference browser for the complete catalogue.
Use `/terminology-auth-refresh` explicitly after changing credentials if readiness is
not ready. Enabling and status commands do not themselves perform inference.

Candidate publishers use `previewBinding(catalogue)` from `preview-policy.ts`
after finalizing runtime sources, then supply `schemaVersion: 1`,
`developmentOnly: true`, `measured: false`, `promotable: false`,
`acceptanceStatus: "not-validated"`, nonempty `gaps`, and `conceptThresholds` for
**every** recognizer. `validatePreviewPolicy(value, catalogue, binding)` is pure.
Bindings cover the full catalogue, actual wire criteria, request profile, and
runtime display/guard, selection, preview validator, native matcher and extraction
source fingerprints. Any change after confirmation
invalidates the active preview instead of silently substituting a candidate.
