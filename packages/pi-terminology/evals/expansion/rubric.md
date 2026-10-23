# Independent expansion fixture rubric — author C

## Authority and independence

These are agent-authored semantic labels for the 51 definitions in `concepts.json`, not predicted matcher results. Author C read the definition/source research proposal and the definitions-only metadata. The old catalogue was accessed only by selecting its `.concepts` field before metadata arrived. No recognition rules, compiler implementation, matcher criteria, model probabilities or evaluation outputs were consulted. No provider or classifier calls were made.

Development text is public-safe invented work. Synthetic heldout text was independently invented, not copied from old fixtures, real prompts, or development tasks with entity substitutions. Heldout files remain outside the checkout until criteria freeze. Public metadata reports counts, coverage and hashes, not heldout text. Preserve author fixtures unchanged; a separate blind reviewer may create explicitly named consensus derivatives.

## Record contract

Every fixture file is a JSON array. Each element has exactly:

- `id`: stable unique string within the file.
- `prompt`: the text under assessment.
- `labels`: an object with **every one of the 51 exact concept IDs** as keys, each mapped to `positive`, `negative`, or `ambiguous`.
- `named`: an array containing only IDs labelled positive that the requester already uses affirmatively by canonical label or genuine alternative label.

A positive named concept is still semantically present but is not an unnamed reminder opportunity. `named` is not a fourth truth label. A concept merely quoted in assistant material, negated, or discussed hypothetically does not enter `named` as an affirmative current-work concept.

## Semantic decisions

1. **Positive**: the user's current actual work affirmatively calls for, describes, or asks to correct the defining behavior/design property. An unwanted existing problem can be positive when the user asks to address it. Supporting evidence must be in the supplied request, not inferred from unseen project history.
2. **Negative**: the request lacks the defining behavior, merely mentions an adjacent technique, explicitly rejects it, quotes someone else's suggestion without adopting it, or asks only for hypothetical/research/teaching discussion. A generic instruction to test, review, clean up, optimize, migrate, or continue does not establish a specialized concept.
3. **Ambiguous**: supplied wording admits materially different readings at the definition boundary; neither confidently positive nor confidently negative. Do not use ambiguity to conceal a missing review. Report it separately and let an independent reviewer adjudicate it.
4. **Multiple labels are allowed.** Label all supported concepts even when one is the intended primary example. Do not make a positive imply all related concepts automatically. Independent design dimensions can coincide without being synonyms.
5. **Current work and scope matter.** A direct request to implement a named technique is positive and named; a request merely to explain its name is not an unnamed coding opportunity. Negation of a harmful property does not automatically suppress a request to remove that property. Inspect what work the user actually wants.
6. **Annotations**: identify the user's reply. Quoted assistant text is context, not an independent user instruction. A reply that affirmatively adopts the quoted proposal can establish the concept; a rejection cannot.
7. **No confidence threshold or runtime behavior is part of this rubric.** Labels are authored independently of the classifier and its scoring rules.

## Important boundaries reviewed

- Failed automated test, passing implementation, then behavior-preserving cleanup establishes the complete development cycle; tests written only afterward do not.
- Internal restructuring must preserve observable behavior to establish refactoring. Removing genuinely unreachable obsolete code can also preserve behavior and improve internal structure.
- Preconditions, postconditions and invariants establish responsibility specifications; checking an external-service double against the real service is a different testing concept.
- Modifying production code to assess tests differs from modifying inputs to find failures.
- Generated-domain laws and counterexample search can also seek failures through generated inputs. Relationships between related executions require an actual expected relationship, not simply multiple test runs.
- Observing current behavior differs from detecting unintended damage after changes. Comparing implementations expected to agree does not identify which is correct.
- Implementation-copy assertions need an independent behavior requirement to escape the structural-echo problem; externally required interaction ordering is meaningful behavior.
- Independence between tests differs from controlling ambient services, profiles and dependencies. Serial ordering alone provides neither guarantee.
- A small interface delivering substantial functionality differs from a thin wrapper. Concealing a changeable design decision differs from generic privacy or confidentiality. Fewer dependencies, independent variation, and coherent responsibility grouping are reviewed separately.
- A stronger parsed representation retains established facts. Boolean validation followed by an unchecked cast does not. State variants excluding invalid combinations differ from warnings on a permissive model. Semantic role distinctions over one primitive representation can have an ambiguous overlap with the broader invalid-state objective; this is flagged explicitly rather than silently equated.
- Pure decision code plus effectful outer orchestration establishes both the specified architecture and a concrete separation of concerns. Different actor responsibilities establish a different kind of separation.
- Future-only product capabilities differ from current maintenance and required verification. Repeated textual shape alone does not establish duplicated authoritative knowledge.
- Idempotency concerns intended effects under repetition, not identical responses or physical exactly-once execution. Growing randomized retry delays, failure-threshold call suspension with recovery checks, downstream-driven production regulation, and continuous corrective convergence are distinct mechanisms.
- Shared-state write validation is not obsolete UI-response suppression. Transitional compatibility is not an atomic rename. Evaluated limited production exposure is not a scheduled rollout or a post-deployment availability check.
- Distinct semantic-model scopes differ from arbitrary service boundaries; semantic translation between systems differs from protocol conversion. Agreement on shared expert/developer vocabulary requires more than clearer variable names.
- Component removal under otherwise matching conditions and concealed evaluation identities address different evaluation questions. Reviewer independence alone establishes neither.
- Documentation's four reader needs differ from merely concise prose. Optional secondary details differ from mandatory sequential steps.

## Fixture composition and coverage

`development.json` contains 120 records: 51 three-ticket work requests (153 primary concept assignments), one boundary request for each concept (51), and 18 additional named/annotation/negation/hypothetical/multi-concept controls. There are 66 positive records, within the requested maximum of 69. Each concept has at least three distinct unnamed positive tasks; broad cross-concept overlaps are explicitly labelled.

The synthetic heldout has 148 records: 102 independently authored work requests (two primary unnamed tasks per concept), 26 independently authored boundary requests, and 20 additional controls. Its tasks do not reuse development task text or task/entity templates. Its exact paths, hashes and aggregate coverage are in `fixture-metadata.json`; the text is deliberately private before freeze.

The real heldout has 80 records sampled from eligible local main-session user messages dated 16–21 October 2026, with seed `20261022`. Sampling and provenance remain private. The window excludes the current expansion day's messages entirely. Extraction uses only direct `message.role == user` text; skill/system/tool/task injections, terminology investigations, very short or oversized text, secret-like strings, duplicates and equality/prefix matches with consumed corpora are excluded. Annotation wrappers are replaced by reply text only. No private prompt was used to inspire public synthetic examples, sent to a provider, searched on the web, or copied into this repository.

The local sampler found 160 eligible distinct messages after exclusions. It sorted by timestamp/file/message ID, shuffled with the fixed seed and selected the first 80, rather than selecting for desired concept prevalence. All selected text was agent-reviewed for relevance boundaries and privacy. No selected prompt required secret redaction. Local provenance holds session/message IDs, timestamps and source paths; none are published here.

## Limitations and review requests

- Real prompts are a recent-user-request sample, not a balanced concept corpus. Many short approvals, continuation instructions and routine administration requests genuinely supply no evidence for a specialized concept. Do not fill missing context by retrieving assistant answers and treating them as user intent.
- Some real messages are different turns of the same conversation, and repeated rollout requests can differ only in whitespace. Exact duplicate text is removed; near-duplicate conversational requests are retained if independently present in the source. The sample is not statistically independent by session.
- All recent messages from the selected date range were considered, including messages in sessions created earlier. This avoids restricting selection to newly created sessions. Main-session provenance is the normal `sessions/*/*.jsonl` store; no separate subagent artifact directories are sampled. Agent text review rejects task/injection artifacts in addition to automated filtering.
- Consumed-corpus exclusion compares extracted prompt text, with exact and substantial-prefix matching (minimum 80 characters for prefix matching). It cannot prove semantic non-overlap with all previously viewed conversation material or arbitrary redacted versions of old prompts.
- Recent sparse context produces legitimate ambiguity for broad design properties and generic assurances that an upgrade still works. These cells are explicitly flagged. A future blind reviewer should examine them, role-type/invalid-state overlaps, generated-law/failure-search overlaps, and broad architecture cross-labels.
- Three-ticket development requests are practical batch requests used to satisfy the 120-record cap without dropping per-concept primary coverage. They are intentionally more multi-concept than the single-primary-task synthetic heldout. Measure grouping errors separately rather than assuming single-label truth.
- These labels were authored by an AI agent, not a human, and are not independently adjudicated ground truth. Independent agent review is pending; no human review has been performed. Preserve author evidence and record review changes in consensus files. Do not adapt heldout labels to classifier outputs.

## Formatting provenance before experiment freeze

The data and labels are frozen. Before experiment-manifest freeze, `development.json` received formatting-only preprocessing with the checkout’s oxfmt. The original author bytes are preserved in `author-development.json.txt`; their SHA-256 is `e1621c83be772caf081ae30aa9bb5ea7fbf02129fe42fe9ef98fa897dc5eea8d`. Parsed records, prompts, labels and named arrays remain identical. Current formatted-file hashes are recorded in `fixture-metadata.json` and `fixture-manifest.json`, with original-byte provenance retained in the metadata. This changes byte formatting only, not labels; heldout author files are untouched.
