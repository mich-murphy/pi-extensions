# Pi terminology extension handoff

## Status and ownership

Implementation is authorized in `/Users/mm/dev/pi-extensions/packages/pi-terminology`,
on `feat/pi-terminology`, based on `origin/main` at `ebd9ebd`. Unrelated untracked
web-tools documentation is preserved. The developer approved the fresh-context
implement/review/fix loop, full gates at each stage, final acceptance verification,
and PR babysitting. Use `openai-codex/gpt-6.1-sol` with high effort for subagents.
No merge, installation, or live activation is authorized.

The approved second synthetic screen completed exactly 200 additional calls:
60 per development variant and 80 new held-out attempts, without errors, missing
attempts, or retries. Offline selection chose `with-criteria` at threshold 0.85
before new held-out access. Held-out passed the frozen rules: 56/56 displayed
precision (100%), 56/60 recall (93.3333%), and per-concept recall of at least 80%
against the 50% gate. Property-based testing achieved 10/10, or 100% recall.
The runtime policy is now `measured: true`; it permits automatic reminders if
explicitly loaded, but the extension is not activated, globally installed, or
included in the root extension list. Results and byte-preserved archives are in
`packages/pi-terminology/evals/results/2026-10-15-round-2/README.md`.

The initial screen remains failed and unchanged: 108 calls, development threshold
0.83, held-out 33/37 precision (89.19%), 75% recall and four false groups among
60 attempts. No held-out retuning, rerun, or post hoc relabeling occurred. Its
original report remains in `packages/pi-terminology/evals/results/2026-10-14/README.md`.
Lifetime totals are 308 calls, $0.011561256 usage-based estimated cost and
$0.847773696 retained reservations, below the $1 Jev and $5 overall caps. These
are not verified provider invoices. All paid calls are stopped. Preserve the
native ledger, legacy and round-two receipts, frozen plan, fixtures, and archives.

The new corpus was independently agent-authored and separately blinded-reviewed:
70 labels, not human-reviewed. Six held-out construction revisions preceded all
calls; final overlap review found no canonical duplicates or remaining genuine
near-template blockers against new development and both consumed legacy splits.
After independent authoring, authorized legacy-overlap QA informed two of those
rewrites through limited excerpts. Small synthetic screens and repeated attempts
do not establish a real-world or 95% lower-bound precision guarantee. Both
question styles require Pi 1.1 boolean criteria, so this is not a true
with/without-criteria comparison or model-weight fine-tuning. The SDK reports the
requested `jev-1.13.0`, not an attested serving identity.

Fresh pre-evaluation code review and coordinator preflight passed the full gate:
1219 tests, one existing skip, across 68 files, plus coverage, lint, types,
formatting, Fallow and Markdown checks. Review fixes closed premature policy
publication before native artifact sealing and the singular naming alias gap;
failure tests verify incomplete artifacts cannot publish a measured policy.
Fresh independent final verification passed the synthetic acceptance contract and
full unchanged gate: 1220 tests passed, zero failed, one existing skip, across
68 files. It independently reconstructed every new observation, sealed archive,
frozen selection and cumulative settlement. A stale pre-acceptance test was fixed
to assert the accepted policy and provenance while retaining explicit unmeasured
coverage. PR delivery and CI are tracked separately from this frozen screen;
passing it does not authorize merge or activation.

The six seeds use two publisher-hosted book excerpts and four substantive
first-party sources; independent primary-source review verified definitions and
locators. Native TypeSafe auth preflight is implemented. The user selected
prototype A, a compact above-editor widget. The detailed design and any remaining
implementation checklist below are historical design material, not a current
unfinished-work inventory. This document remains the continuation entry point.
Work only in the owning repository, without exposing the package through existing
global installs; the user separately controls installation and activation.

The separate `pi-web-tools` authentication improvement is out of scope and is not
a prerequisite. Do not expand this feature into a shared credential framework.
This is not the old `mm-mode` router, which the harness separately plans to remove.
Do not revive or depend on that router or its Jev integration.

## Goal

Help the developer learn concise, established software-development terminology
while working. The inspiration is `zsh-you-should-use`: recognise something that
has a known name and display a reminder, rather than invent a new shortcut.

Example behavior:

- The user describes deliberately changing production code to see whether tests
  detect those changes.
- Jev classifies that activity against an existing mutation-testing recogniser.
- Code retrieves a fixed, source-backed terminology tip and displays it in Pi's UI.
- The original prompt goes to the coding model unchanged.

A tip identifies a concept in part of the request. It does not claim that a short
term is equivalent to the entire prompt or that it carries every requested gate,
permission, context boundary, or completion condition.

Success means useful, accurate reminders with few misleading suggestions. It does
not mean categorising every prompt or maximising reminder coverage.

## Approved boundaries

- Build a Pi extension explicitly, with UI outside the coding model's context.
- Jev is a System One classifier only. It selects among existing concepts; it does
  not generate definitions, tips, explanations, strategic prompts, or rewrites.
- Focus on established concepts and terminology, not workflow aliases.
- Do not rewrite or block prompts, automatically invoke skills, or inject glossary
  instructions into the coding model's context.
- Use curated fixed tip text. Do not add new terms automatically from observations.
- Support a shared glossary across projects and project-specific additions.
- Keep concept definitions separate from recognition criteria.
- Include optional equivalent labels and related-concept links, with different
  semantics.
- Defer embeddings until catalogue size, latency, or cost justifies evaluating them.
- Use abstention thresholds. Keep them in matcher policy, not concept definitions.
  Start by evaluating a common threshold; use measured per-concept overrides when
  justified.
- Require targeted evaluations of Jev criteria before relying on reminders.
- Authenticate through Pi's native TypeSafe provider and credential resolution.

An available skill could eventually be a separate related resource in the UI.
Skill recommendation, discovery, activation, and workflow aliases are not v1 work.

## Storage and distribution

Proposed layout:

```text
pi-extensions/
└── packages/pi-terminology/
    ├── index.ts
    ├── glossary/
    │   └── core.json
    └── test/

project/
└── .pi/
    └── terminology.json
```

- Bundle the shared, reviewed glossary with the versioned extension package.
- Install the extension at Pi's user level to make it available across repositories.
- Project additions live in `.pi/terminology.json`, checked into that project.
  This is our proposed extension-owned convention, not native Pi glossary support.
- Use the same JSON contract for shared and project documents.
- Keep dismissals, cooldowns, and personal preferences in separate runtime state
  under Pi's configured agent directory. Do not hardcode `~/.pi/agent` or modify
  glossary files when a user dismisses a tip.
- JSON is data; TypeScript implements loading, validation, matching, and UI.
- Use separate glossary consent. The developer approved permission to read the
  file, not approval of exact content hashes. Ordinary edits do not require renewed
  consent; every loaded revision still passes schema and semantic validation.
- A custom glossary filename does not trigger native project trust. Separate file
  consent authorizes this read-only data even when native executable resources are
  untrusted. Glossary approval must not grant permission to execute project extensions
  or load other native protected resources. Do not read unapproved glossary contents.
- One glossary per repository is sufficient. Subdirectories use the repository-root
  `.pi/terminology.json`; do not compose nested glossaries in v1. Avoid unrelated
  parent projects and the user's home directory. Non-Git discovery and permission
  handling for replaced files or changed symlink targets remain implementation work.

The root Pi package manifest currently discovers `./packages/*/index.ts`. Adding
an extension entry point can therefore affect existing global installs. Develop
in isolation and agree on activation before exposing a new entry point through
that manifest.

## Data contract

The developer approved this concept/recognition separation and illustrative shape:

```json
{
  "schemaVersion": 1,
  "namespace": "core",
  "concepts": [
    {
      "id": "core:mutation-testing",
      "label": "mutation testing",
      "domain": "software testing",
      "definition": "Assessing tests by deliberately changing production code and checking whether the tests detect those changes.",
      "references": [
        {
          "title": "Stryker: mutation testing",
          "url": "https://stryker-mutator.io/docs/"
        }
      ]
    }
  ],
  "recognition": [
    {
      "conceptId": "core:mutation-testing",
      "matches": "Deliberately changing production code to assess whether tests detect those changes.",
      "doesNotMatch": "Ordinary implementation changes or changes to test inputs.",
      "tip": "A term for this activity is mutation testing."
    }
  ]
}
```

This example is illustrative, not an approved initial active glossary entry. Its
definition is an editorial paraphrase supported by Stryker's documentation. The
recognition criteria and tip are application-authored, not attributed quotations.
The developer subsequently requested textbook-first sourcing for the initial set.

### Records

| Record | Required direction | Optional direction |
| --- | --- | --- |
| Document | Schema version, namespace, concepts, recognition | No additional metadata required initially |
| Concept | Stable ID, label, domain, definition, supporting references | Alternative labels, scope note, related concept IDs |
| Recognition | Concept ID, matching criteria, exclusions, fixed tip | Concept-specific caution |
| Book reference | Title, authors, edition, verified chapter/topic locator | URL, ISBN |
| Web reference | Title, URL | Section locator, source version |

A concept can exist without a recogniser and remain available in a glossary
browser. Recognition criteria must not become part of an industry definition.
Model IDs, probability thresholds, cooldowns, and credentials do not belong here.

Settle the precise book/web reference discriminator and validation schema in the
next session. Do not invent page numbers or imply chapter verification from a
contents listing. Prefer maintainer-authored paraphrases with supporting sources;
verify attribution and permission before packaging copied definitions.

The developer approved these optional fields:

```json
{
  "alternativeLabels": ["TDD"],
  "relatedConceptIds": ["core:regression-testing"]
}
```

In a test-driven-development entry, `TDD` is an equivalent label. Regression
testing is a distinct related concept, not an alias. Related links can support UI
navigation and disambiguation. Do not send every relationship to Jev without
measured benefit.

### Identity, composition, and validation

- IDs identify meanings, not spellings. A label rename retains its concept ID.
- A materially different meaning requires a new ID.
- Reserve `core` for the bundled glossary; project additions use another namespace.
- Append documents by disjoint IDs, not by label or last-writer-wins replacement.
- Project additions cannot silently replace shared definitions or recognisers.
- The same label can denote different meanings; ambiguity should not force a tip.
- Storage location is not provenance. A sourced industry concept added in a project
  remains an established concept.
- Validate unique concept IDs, namespace membership, nonempty required strings,
  recogniser references, and at most one recogniser per concept in v1.
- Validate related-concept references after composing the available documents.
- Normalise labels using a documented rule and reject redundant labels within one
  concept. Do not merge meanings merely because labels match.
- Restrict reference URL schemes and reject unsupported schema versions visibly.
- Use a closed structural schema plus semantic checks. JSON Schema `$ref` points
  to schemas, not concept records; `uniqueItems` does not enforce unique IDs.
- Package/Git versions plus a computed catalogue hash can identify content revisions.
  Avoid manually duplicating per-entry revision numbers unless needed.

SKOS is a design reference, not a requirement to implement RDF, a taxonomy, or full
SKOS conformance. JSON Schema Draft 2020-12 was the research recommendation; the
validator implementation is still to be chosen against repository conventions.

## Textbook-first glossary

Use authoritative author and publisher material to seed a small initial collection.
These candidates were verified in official contents or publisher materials, not
against all complete chapters:

| Book | Candidate concepts and available locators |
| --- | --- |
| David Thomas and Andrew Hunt, The Pragmatic Programmer, 20th Anniversary edition (second edition) | DRY, orthogonality, reversibility, tracer bullets in A Pragmatic Approach; design by contract in Pragmatic Paranoia; property-based testing in While You Are Coding |
| Martin Fowler, Refactoring, second edition | Refactoring in chapter 2; feature envy, shotgun surgery, primitive obsession in chapter 3 |
| Kent Beck, Test Driven Development: By Example, first edition | TDD and red-green-refactor in the publisher-hosted Preface; xUnit in Part II and chapter 29 |
| Eric Evans, Domain-Driven Design, first edition | Ubiquitous language in chapter 2; entity/value object in chapter 5; aggregate/repository in chapter 6; bounded context/context map/anticorruption layer in chapter 14 |

Start with a few verified definitions and grow toward roughly 10 to 20 concepts.
Do not fill the catalogue with advice headings, team slang, or phrases claimed to
be special keywords in model weights. A textbook contents entry proves placement,
not the meaning of a detailed definition. Keep unverified candidates out of the
active recognition set. Practitioner documentation can supplement the books.

## Jev integration

### Matching design

- For a small catalogue, evaluate one applicability Noul per enabled concept in one
  batched request. Pi exposes this as a `bool` question and maps it to wire `noul`.
- Several concepts can apply to one prompt. A single catalogue-wide Choice forces
  concepts to compete and is not the default design.
- Ask whether the current requested behavior describes the concept. Do not ask
  whether its name can replace the entire prompt or whether it is a better strategy.
- Keep questions atomic, positive, and literal. Add separate questions only for
  demonstrated needs; do not conflate applicability, prior naming, and usefulness.
- A question ID is not model-visible. Include the meaning and needed boundaries in
  the actual instructions and criteria, not only in `conceptId`.
- Send the submitted prompt with only necessary context. Keep each concept's compact
  criteria in its own question, not an unrelated full glossary in shared state.
- Questions do not see sibling answers. This does not establish statistically
  independent errors; do not multiply probabilities as independent evidence.
- Render stored tips and references deterministically. Code owns suppression,
  selection, cooldowns, dismissal, and abstention.
- Conservatively suppress already-used terminology where code can do it reliably.
  Mere occurrence, especially in quotes or negation, is not affirmative instruction.
- Keep recognition examples primarily in evaluation fixtures. Add a small number
  to runtime criteria only if targeted tests demonstrate an improvement.

Example applicability question: Is the user asking to assess test effectiveness by
deliberately changing production code?

### Probability policy and evaluation provenance

Noul returns the probability of yes, not a degree of applicability and not a
separate confidence score. High confidence is not a correctness guarantee.

Evaluate a common threshold first. Per-concept thresholds are allowed when measured
results justify them. Store policy separately from glossary definitions, tied to
model version, compiled criteria, catalogue hash, and evaluated fixture revision.
Do not transplant thresholds from old routing code or vendor cookbooks.

Embeddings are deferred. If later introduced, use them for candidate retrieval,
not as proof of applicability. Compare candidate recall, final reminder accuracy,
latency, and total cost. A concept omitted by retrieval cannot be recovered by Jev.

### Authentication and operational safeguards

Use Pi's native TypeSafe provider and `ctx.modelRegistry.classify()` rather than
creating another Jev HTTP/auth client. Support `TYPESAFE_API_KEY` and Pi's stored
API-key/secret-manager-command setup. Do not put credentials in glossary files,
project files, criteria, or telemetry.

Follow `pi-web-tools`' secret-handling and transport safety principles, but do not
copy its credential client or make this work depend on changing that extension.
Missing authentication should disable automatic tips with a non-repeating notice;
local glossary browsing should still work.

Verified by reading the installed Pi 1.1.0 implementation:

- Classifier instructions and criteria are string-only through Pi's public API.
  Compile our data to that interface instead of bypassing it for richer wire JSON.
- The bundled direct-TypeSafe catalogue exposes `jev-latest`. TypeSafe's docs listed
  `jev-1.13.0` during research and recommend pinning after threshold tuning. Verify
  the current model and an explicit pin through the actual request path.
- Installed `classifySystemOne()` reports the requested model ID and ignores the
  API body's serving `model`. Its result alone cannot establish alias resolution.
- The native transport defaults to two retries and per-attempt timeouts. Bound the
  whole advisory operation, including backoff, and cancel stale work.
- Native classification can return `error` or `aborted` instead of throwing. Check
  those outcomes and validate expected answer types and probability ranges.
- Direct-TypeSafe catalogue pricing is zero in Pi's metadata. This is not evidence
  that calls are free. Record returned usage and use verified provider pricing for
  estimates; do not claim total token savings without measuring the full path.

Use a total budget, bounded concurrency, and session/request identity so late tips
cannot appear against another prompt, session, or project. Failure must leave the
coding task unaffected. Exact budgets and cancellation mechanics are open.

The developer approved synthetic/public prompts only for initial live evaluations,
with at most $5 overall evaluation spend and at most $1 of Jev usage. Account for
retries within both caps. Verify provider pricing and enforceable accounting before
spending; zero prices in Pi metadata are not a reliable budget mechanism.

Private prompts are not approved for these evaluations. Confirm privacy and
retention before any later private-data authorization. Do not commit raw
transcripts, log keys, or retain raw prompts by default. Historical retention
claims are not a guarantee for every setup.

## UI direction

Use the selected compact above-editor widget, prototype A. Group qualifying terms
in one reminder, with an explicit details view showing label, definition, source,
scope, and related concepts. Provide browsing/search and dismissal without mutating
the glossary. Exact command names and detailed layout behavior remain open.

The developer endorsed precision over coverage and explicitly requires support for
multiple terms within a prompt, collated into one UI response. A single grouped
notification may contain several qualifying concepts; it is not a one-term cap.
Evaluate applicability and suppression independently for each concept. Do not force
concepts to compete for a single winning match. Define wrapping/overflow and
per-concept dismissal without inventing a classifier-generated summary.

The developer chose A after reviewing the Pi-style placement prototypes. Use an
above-editor widget, not a below-editor widget, transcript notification, or footer
status as the primary reminder surface. Keep automatic reminders non-interrupting;
the developer explicitly opens the details/browser view.

The local comparison prototype is `../prototypes/you-should-use.html`. It compares
above-editor and below-editor widgets, a dim transcript notification, and footer
status, using identical illustrative matches. It includes light/dark palettes,
regular/narrow widths, grouped terms, overflow, dismissal, and an editor-area
details preview. These are HTML mockups, not a loaded Pi extension or live Jev
results. Placement A is approved; UI command names and live activation are not.

Use Pi's UI APIs rather than a second terminal renderer. Test interactive behavior,
regular/fullscreen layouts, narrow widths, Unicode, theme changes, and reload.
Define non-interactive/RPC behavior explicitly. Do not add model-visible messages
merely to persist a UI tip or usage record.

## Required evaluations and tests

The developer explicitly requested targeted evaluations of Jev criteria.

### Classification fixtures

For the initial synthetic screen, the developer approved independently agent-reviewed
labels rather than human review. This does not establish human-reviewed or
representative real-world precision. Include cases for:

- Clear descriptions of each concept.
- Closely related concepts that must not match.
- Several concepts in one prompt.
- No applicable concept.
- Negated or rejected approaches.
- Quoted and historical mentions.
- Already-correct terminology, including equivalent labels.
- Requests with important qualifiers.
- Ambiguous follow-ups such as "do that".

Keep development and final held-out sets separate. Use representative prompts, not
only synthetic easy examples. Obtain approval before sending private prompts.
Repeat selected inputs to measure variability. Re-evaluate when criteria, concept
meaning, or model versions change.

Measure per-concept precision/recall, false reminders, abstention/coverage,
run-to-run instability, latency, and token usage. Evaluate displayed tips separately
from applicability scores, since suppression and selection affect user experience.
The developer confirmed a 95% measured displayed-term precision acceptance target.
This is not a Jev probability threshold. Freeze the held-out set before tuning,
report the actual displayed-term denominator and abstention/coverage, and evaluate
whether each grouped response contains any misleading term. Empty output cannot
establish precision acceptance. The initial development threshold was 0.83, but the
held-out screen failed; it is not an accepted production policy.

### Deterministic and integration tests

- Schema errors, unknown fields/versions, duplicate IDs, and dangling references.
- Project addition composition, collisions, trust, and subdirectory discovery.
- Already-named suppression, per-concept dismissals/cooldowns, and stale-result
  cancellation, including multiple independent matches grouped into one response.
- Root-only project discovery and file-reading consent that persists across ordinary
  content edits without granting broad native project trust.
- Malformed/missing answers, out-of-range probabilities, HTTP/auth errors, abort,
  timeout, retry budget, and bounded concurrency.
- Original prompt and coding model context remain unchanged.
- Native environment, stored-key, and secret-manager authentication paths; no
  credential leaks in UI/errors/telemetry.
- No-auth browsing works and notices do not repeat on every prompt.
- Above-editor grouped reminders, explicit detail-view navigation, editor-draft
  preservation and focus restoration, UI reload/session switching, and
  non-interactive behavior.

Run the owning repository's full `npm run check`, including coverage and Fallow.
Do not lower thresholds, suppress findings broadly, or introduce unreviewed runtime
dependencies to bypass failures. Live classifier evals are distinct from offline
unit tests; agree on spend and acceptance targets before running them.

## Suggested development sequence

1. Read this handoff and the current `pi-extensions` README/configuration. Inspect
   the working tree and preserve unrelated work. Re-read installed Pi docs and
   types; the host implementation may have changed since research.
2. Finalise the minimal schema, book/web reference shape, discovery/trust rules,
   and glossary admission process. Choose a few chapter/excerpt-verified entries.
3. Build structural/semantic validation and labelled recognition fixtures before
   implementing the automatic UI path.
4. Verify the native classifier/auth path with synthetic data, explicit model
   pinning, usage reporting, total deadlines, and response checks.
5. Run bounded targeted Jev criteria evaluations after agreeing on dataset privacy,
   budget, and precision-oriented acceptance targets. Freeze a held-out set.
6. Add the advisory UI, local browser, suppression, preferences, and cancellation.
   Verify that neither the original prompt nor model context changes.
7. Pass full repository gates and independent review. Agree on activation before
   enabling the package in ordinary sessions.

Do not begin by building an embedding index, importing an entire external glossary,
reviving `mm-mode`, or implementing the separate web-tools authentication change.

## References and local starting points

### Primary sources

- [you-should-use](https://github.com/MichaelAquilina/zsh-you-should-use): reminder
  behavior for existing aliases, not generated shortcuts.
- [SKOS Primer](https://www.w3.org/TR/skos-primer/) and
  [Reference](https://www.w3.org/TR/skos-reference/): concepts, preferred/alternative
  labels, scope notes, and related concepts.
- [JSON Schema structuring](https://json-schema.org/understanding-json-schema/structuring)
  and [objects](https://json-schema.org/understanding-json-schema/reference/object).
- [The Pragmatic Programmer](https://www.pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/).
- [Refactoring](https://www.informit.com/store/refactoring-improving-the-design-of-existing-code-9780134757711).
- [Test Driven Development: By Example](https://www.informit.com/store/test-driven-development-by-example-9780321146533).
- [Domain-Driven Design](https://www.informit.com/store/domain-driven-design-tackling-complexity-in-the-heart-9780321125217).
- [Stryker](https://stryker-mutator.io/docs/): support for the illustrative example.
- TypeSafe: [System One](https://docs.typesafe.ai/concepts/system-one),
  [Noul](https://docs.typesafe.ai/primitives/noul),
  [Choice](https://docs.typesafe.ai/primitives/choice),
  [confidence](https://docs.typesafe.ai/confidence),
  [models](https://docs.typesafe.ai/models),
  [API](https://docs.typesafe.ai/api),
  [jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13), and
  [parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions).
- [Skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion):
  advisory precedent, not validation of this task. Its earlier-model, single-skill
  experiment and thresholds must not be transplanted into multi-concept matching.

### Local files

- `/Users/mm/dev/pi-extensions/README.md` and `package.json`: workspace conventions,
  full gates, peer dependencies, and automatic extension discovery.
- `packages/pi-web-tools/settings.ts`, `provider-http.ts`, `tool-output.ts`, and tests:
  secret validation/redaction and bounded transport patterns. The approved auth
  migration for that package remains a separate feature.
- `packages/pi-skill-toggle/index.ts`, `state.ts`, README, and tests: local examples
  of Pi UI integration, configured agent-directory state, and project trust.
- Installed Pi docs root:
  `/opt/homebrew/Cellar/pi-coding-agent/1.1.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs`.
  Read `extensions.md`, `models.md`, `providers.md`, `configuration.md`, `packages.md`,
  `security.md`, and `tui.md`, plus relevant linked examples and declarations.
- Installed classifier source under the same package's
  `node_modules/@earendil-works/pi-ai/dist/api/`: `typesafe-system-one.js`,
  `system-one-shared.js`, and `classifier-shared.js`.
- `/Users/mm/dev/harness/docs/research/typesafe-jev.md`: earlier detailed research
  notes, not a reason to copy or retain the old router implementation.
