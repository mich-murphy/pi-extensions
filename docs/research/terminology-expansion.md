# Terminology expansion proposal

Research proposal, 22 October 2026. No glossary, recognition criteria, policy, installation, or activation changes are included. No classifier evaluations were run.

## Recommendation

Curate **30 additional concepts**, taking the potential glossary from 10 to 40 entries. Start with the 16 higher-priority candidates below; the remaining 14 broaden coverage. These are recommendations for admission and recognition evaluation, not measured recognizers. The batch size is a practical proposal, not an acceptance requirement.

Matt Pocock and Lauren Tan (Poteto) are valid first-party practitioner references. Use their writing to identify useful vocabulary and concrete applications. Where they draw on an earlier author, retain that provenance. Distinguish an established concept, an explicitly attributed practitioner principle, and a skill's invocation name; those are not interchangeable.

## Selection principles retained

- Prefer established software-development concepts with precise, useful meanings. Book authors, substantive publisher excerpts, standards, original research, maintainers, and credible first-party practitioners can establish meaning.
- Target concepts that name behavior the developer describes, including concepts whose names are absent from past prompts. Existing familiarity can lower reminder priority, but rarity of a name is not a reason to exclude a useful concept.
- Explain each term in ordinary language. A term names an aspect of a request, not its complete requirements, authority, review independence, context freshness, or completion conditions.
- Keep definitions and provenance separate from recognition rules. The matching descriptions below are illustrative paraphrases, not private-session quotations or evaluated criteria.
- Separate true alternative labels from related concepts and implementation techniques. Do not turn every nearby term into an alias.
- Favor useful, accurate reminders over coverage. Research requests, fictional examples, negated approaches, historical quotations, and already-used names need appropriate suppression or abstention.
- Do not claim that a concept is a special keyword in a model's weights, or that using its name improves outcomes without evidence.
- A source's contents page proves placement, not a detailed definition. Do not invent book locators or imply full-book access.

The historical handoff establishes the original selection direction. The package README and production evidence supersede its older evaluation target: the current accepted target is **90% empirically scored displayed precision**, not a classifier probability cutoff or statistical lower bound. This proposal does not authorize new paid evaluation runs.

## Why these priorities fit the observed work

The shortlist is oriented toward themes visible in the reviewed sessions and existing skills: simplifying architecture without adding layers, encoding invariants in types, testing observable behavior rather than implementation details, isolated verification against real artifacts, comparing designs, and evaluating whether skills help. This is a qualitative fit assessment, not a frequency ranking or a claim that every candidate has appeared unnamed in a prompt.

YAGNI and DRY are already explicitly used in earlier requests, so their glossary value is completeness and disambiguation rather than assumed novelty. Terms such as characterization testing and value object remain useful candidates even when their exact names are rare. Do not infer the developer's knowledge solely from absence of a word.

### Completed session-history cross-check

A supplementary local pass checked main-session user messages, separating annotation replies from quoted assistant text and excluding injected skills, benchmark instructions, tool-output echoes, and this investigation. Selected examples were checked against their original messages. This was a qualitative review, not a prevalence estimate. The descriptions below are anonymized paraphrases, not raw private prompt quotations.

| Observed request | Date | Candidate and qualification |
| --- | --- | --- |
| Decouple a modern web domain model from a legacy system's representation. | 1 September | **Anticorruption layer** is a strong additional candidate. Translation between semantic models is the key distinction; bidirectional synchronization is an additional requirement, not implied by the name. |
| Clarify which responsibilities belong to infrastructure provisioning and which belong to deployment automation. | 3 September | **Separation of concerns** has a concrete opportunity and deserves higher priority than the initial broadness caveat alone suggests. |
| Replace implementation-focused tests with checks of behavior. | 19 August | Supports **behavior-focused testing** as a principle. It does not establish that a particular test is a **change detector** without examining its assertions. |
| Keep pasted content collapsed until an explicit action expands it for editing. | 18 August | A concrete **progressive disclosure** opportunity. |
| Assess whether a rollout preserves existing connections, worktrees, and sessions. | 15 October | A concrete **change-impact / blast-radius** question. The scope of disruption and the analysis activity remain distinct. |
| Retry an action without creating another logical action. | 1 September | Supports **idempotency / request deduplication**, but idempotency was explicitly named elsewhere in that message. Treat this as a possible clarification opportunity, not proof of unfamiliarity. |

The pass did **not** establish clean direct-user matches for branded types, make-illegal-states-unrepresentable, parse-don't-validate, or functional-core/imperative-shell. General requests for better data structures are insufficient to identify those specific concepts. Ordinary comparative experiments likewise do not establish **ablation** unless a component is deliberately removed to isolate its contribution. These remain source-backed proposals, not claimed historical matches.

**Priority refinement:** consider moving anticorruption layer and separation of concerns into the first admission batch before candidates supported only by conceptual relevance. The 30-entry list below remains a source-backed proposal, not a historically measured ranking.

## Priority 1: curate and evaluate first

### 1. Deep module

- **Meaning:** A module provides substantial useful functionality through an interface that requires comparatively little knowledge to use.
- **Illustrative match:** Hide coordination of several operations behind an interface that callers can understand without learning the internal machinery.
- **Boundary:** A large implementation is not automatically deep. A wrapper adds little if callers still need to understand everything behind it.
- **Sources:** John Ousterhout's [author discussion of method depth](https://github.com/johnousterhout/aposd-vs-clean-code/blob/main/README.md#method-length); Matt Pocock's [codebase-design skill](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/engineering/codebase-design/SKILL.md), especially its depth and leverage discussion.
- **Provenance:** Pocock's interface-leverage formulation is his elaboration; do not attribute all of it verbatim to Ousterhout. The original book chapter was not independently read for this research.

### 2. Information hiding

- **Meaning:** Organize a module around design decisions it conceals, especially decisions likely to change, exposing only what other modules need.
- **Illustrative match:** Keep the storage representation behind domain operations so callers do not need edits when that representation changes.
- **Boundary:** Private fields alone are insufficient if callers still depend on the representation. This is not confidentiality or secret management.
- **Source:** David Parnas, [On the Criteria To Be Used in Decomposing Systems into Modules](https://www.cs.tufts.edu/~nr/cs257/archive/david-parnas/criteria.pdf), original paper, particularly “The Criteria” and “Conclusion.”
- **Related, not automatic aliases:** Encapsulation, deep modules, low coupling.

### 3. Make illegal states unrepresentable

- **Meaning:** Choose types or data representations that exclude invalid combinations instead of merely checking for them after construction.
- **Illustrative match:** Replace independent status flags and optional payloads with variants that represent only permitted states.
- **Boundary:** Adding runtime checks or type assertions to an otherwise permissive representation is not the same design property. The guarantee is limited by the language, constructors, and escape hatches.
- **Sources:** Scott Wlaschin's [worked explanation](https://fsharpforfunandprofit.com/posts/designing-with-types-making-illegal-states-unrepresentable/); Poteto's [type-system-discipline principle](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-type-system-discipline/SKILL.md).
- **Related, not aliases:** Discriminated unions, state machines, smart constructors, branded types.

### 4. Parse, don't validate

- **Meaning:** Convert less-structured input into a stronger representation that preserves what has been established, rather than checking it and discarding the result of that check.
- **Illustrative match:** Parse configuration once into a domain type so downstream code does not repeat checks for the same invariant.
- **Boundary:** This does not mean skipping validation. A Boolean validator followed by an unchecked cast does not preserve the guarantee in the same way.
- **Sources:** Alexis King's [original essay](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/), especially “The power of parsing”; Poteto's [boundary-discipline principle](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-boundary-discipline/SKILL.md).
- **Related, not aliases:** Boundary validation, type-driven design, make illegal states unrepresentable.

### 5. Branded types

- **Meaning:** Distinguish values that share an underlying representation but have different semantic roles, so typed code does not freely interchange them.
- **Illustrative match:** Prevent a user identifier being passed where an order identifier is required, although both are strings.
- **Boundary:** A different variable name does not establish a type distinction. Branding alone does not validate external data or create runtime security isolation.
- **Sources:** Matt Pocock's [branded identifier exercise](https://www.totaltypescript.com/workshops/advanced-typescript-patterns/branded-types/using-index-signatures-with-branded-types); Poteto's [TypeScript patterns](https://github.com/cursor/plugins/blob/main/pstack/skills/typescript-best-practices/references/patterns.md), “Branded types.”
- **Related, not unrestricted aliases:** Nominal types, newtypes, opaque types.

### 6. Functional core, imperative shell

- **Meaning:** Put decisions and transformations in pure functions, with input/output and other side effects in an outer coordination layer.
- **Illustrative match:** Separate the decision about what to update from database access and network calls so the decision can be tested with values.
- **Boundary:** Splitting files into controller and service folders is not sufficient. A function remains effectful if it reads hidden global state or performs I/O.
- **Sources:** Gary Bernhardt's [Boundaries talk page](https://www.destroyallsoftware.com/talks/boundaries), which identifies the associated named screencast; Poteto's substantive [boundary-discipline explanation](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-boundary-discipline/SKILL.md).
- **Verification limit:** The talk description establishes provenance; Poteto's fetched explanation supplies the operational detail here. The full screencast was not independently watched.

### 7. Design it twice

- **Meaning:** Explore substantially different designs before committing rather than assuming the first plausible design is best.
- **Illustrative match:** Compare alternative public interfaces using realistic caller examples and trade-offs before choosing one.
- **Boundary:** Two reviewers of the same design, two execution attempts, or an implement-review-fix loop do not establish alternative design exploration.
- **Source:** Matt Pocock's [Design It Twice guidance](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/engineering/codebase-design/DESIGN-IT-TWICE.md), explicitly attributed there to Ousterhout.
- **Provenance:** A named design principle, not a universal subagent workflow. Pocock's orchestration instructions are an application, not part of the definition. Original book chapter verification remains outstanding.

### 8. Characterization testing

- **Meaning:** Write tests that document what existing software actually does, rather than what its behavior ought to be.
- **Illustrative match:** Capture the current behavior of an unfamiliar parser before changing its implementation.
- **Boundary:** Recording current behavior does not certify that it is correct. A test derived from a new requirement is not a characterization test merely because code already exists.
- **Source:** Michael Feathers's [Characterization Testing](https://michaelfeathers.silvrback.com/characterization-testing), substantive author article.
- **Related, not aliases:** Regression testing, snapshot testing, golden-master testing, approval testing.

### 9. Differential testing

- **Meaning:** Give the same inputs to implementations or versions expected to agree and investigate differences in their results.
- **Illustrative match:** Run old and replacement decoders over the same corpus and report disagreements.
- **Boundary:** Comparing systems with intentionally different specifications is insufficient. A disagreement does not establish which implementation is wrong.
- **Source:** The [Csmith project](https://embed.cs.utah.edu/csmith/), its explanation and compiler-comparison example.
- **Related, not aliases:** Mutation testing, fuzzing, equivalence checking. Csmith's avoidance of undefined behavior is an important limitation of its comparison.

### 10. Change-detector test

- **Meaning:** A test reproduces implementation information and reacts to implementation changes without independently checking the required behavior.
- **Illustrative match:** Replace a test that mirrors internal call order with an independently justified check of the observable result.
- **Boundary:** Mocks, snapshots, and interaction assertions are not automatically change detectors. An interaction sequence can itself be required behavior.
- **Sources:** Alex Eagle's Google Testing Blog article, [Change-Detector Tests Considered Harmful](https://testing.googleblog.com/2015/01/testing-on-toilet-change-detector-tests.html); Matt Pocock's [TDD test guidance](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/tests.md).
- **Related, not an exact alias:** Tautological test. The two ideas overlap, but mirroring structure and recomputing the expected answer are not identical.

### 11. Test isolation

- **Meaning:** Keep tests independent so one test's state or effects do not determine another test's outcome.
- **Illustrative match:** Give tests fresh storage and globals so they pass individually and in different orders.
- **Boundary:** Serial execution is not isolation. Mocking collaborators is a different use of the word “isolation.” Browser contexts do not automatically isolate external databases.
- **Sources:** Playwright's [Isolation documentation](https://playwright.dev/docs/browser-contexts); Fowler's [Unit Test discussion](https://martinfowler.com/bliki/UnitTest.html), including its terminology caveat.
- **Related, not aliases:** Hermeticity, sandboxing, collaborator isolation.

### 12. Hermetic testing

- **Meaning:** Run tests in a self-contained, controlled environment without assumptions about uncontrolled outside state or resources.
- **Illustrative match:** Supply fixtures and disposable dependencies rather than relying on a developer's database, normal profile, or shared remote service.
- **Boundary:** A container or a single mocked network call does not establish hermeticity. A hermetic test need not be a unit test or be restricted to one process.
- **Sources:** [Software Engineering at Google, Chapter 11](https://abseil.io/resources/swe-book/html/ch11.html), test-size properties; Google Testing Blog, [Hermetic Servers](https://testing.googleblog.com/2012/10/hermetic-servers.html).
- **Related, not aliases:** Test isolation, deterministic testing, offline testing.

### 13. Idempotency

- **Meaning:** Repeating an operation has the same intended effect as performing it once.
- **Illustrative match:** Retrying a timed-out create request must not create a second logical resource.
- **Boundary:** Responses or logs may differ. Idempotency is not exactly-once execution, and deduplication is a possible mechanism rather than the universal definition.
- **Sources:** [RFC 9110, section 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2); AWS Builders' Library, [Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).
- **Equivalent label:** Idempotence.

### 14. Blast radius

- **Meaning:** Investigate the scope of effects a change can have beyond the edited code, including indirect consumers and operational behavior.
- **Illustrative match:** Before changing a small shared helper, establish which consumers, persisted formats, or downstream behavior could break.
- **Boundary:** A caller list alone does not establish impact or safety. A risk assessment is not proof that a failure occurs, nor permission to expand the change.
- **Source:** Poteto's [Blast radius skill](https://github.com/cursor/plugins/blob/main/pstack/skills/blast-radius/SKILL.md).
- **Terminology:** Use “blast radius” as the practitioner label. “Change-impact analysis” describes the analysis activity; they are related, not unrestricted synonyms in every operational context.

### 15. Ablation study

- **Meaning:** Assess a component's contribution by removing it and comparing system performance under otherwise comparable conditions.
- **Illustrative match:** Compare an agent with and without one skill while holding tasks, model configuration, and other instructions fixed.
- **Boundary:** Changing several components at once does not isolate one component's contribution. A comparison does not automatically establish statistical significance or broad generalization.
- **Source:** Google's [Machine Learning Glossary, ablation](https://developers.google.com/machine-learning/glossary#ablation), including its explicit extension to subsystems and processes.
- **Related, not aliases:** Controlled experiment, A/B testing, benchmarking, feature selection. Inference-system ablations need not retrain model weights.

### 16. Progressive disclosure

- **Meaning:** Present essential options or information first and reveal secondary detail when needed.
- **Illustrative match:** Keep a short skill index in initial context and load specialized instructions only for the relevant task.
- **Boundary:** Hiding essential prerequisites is not successful disclosure. Mandatory sequential steps are staged disclosure, not necessarily progressive disclosure.
- **Source:** Jakob Nielsen's [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/), substantive definition and distinction from staged disclosure.
- **Scope:** The agent-context example is an application of the established interaction-design concept, not a claim that this source measured token savings or agent reliability.

## Priority 2: broaden the glossary after the first batch

| Candidate | Meaning and illustrative use | Essential boundary | Verified reference |
| --- | --- | --- | --- |
| **DRY / Don't Repeat Yourself** | Give a piece of system knowledge one authoritative representation. Generate related artifacts from its owning schema instead of maintaining parallel rules. | Similar-looking code can express different knowledge; textual duplication alone is insufficient. | Hunt and Thomas, [publisher-hosted DRY excerpt](https://media.pragprog.com/titles/tpp20/dry.pdf), “DRY is More Than Code” and “Not All Code Duplication is Knowledge Duplication.” Use headings rather than assuming final book topic numbering. |
| **YAGNI** | Do not implement capabilities now solely for anticipated future needs. Defer speculative extension points until a concrete need exists. | Not a reason to neglect testing, refactoring, or the health of the current solution. Distinct from accidental complexity and dead code. | Fowler, [Yagni](https://martinfowler.com/bliki/Yagni.html). Already familiar to the developer; include for completeness, but it offers less novelty than an unfamiliar term. |
| **Orthogonality** | Independent aspects can vary independently. A change to one concern should not require unrelated changes elsewhere. | Separate files alone do not establish independence. | Hunt and Thomas's [author interview](https://www.artima.com/articles/orthogonality-and-the-dry-principle), “Be Orthogonal.” |
| **High cohesion** | A module contains a coherent set of responsibilities or concepts that belong together. | Small size or one public method does not establish cohesion. | Evans's [DDD Reference](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf), “Modules.” |
| **Low coupling** | Limit dependencies so modules can be understood and changed with relatively little knowledge of each other. | Zero dependencies is not the goal; splitting files can increase relationships. “Loose coupling” is an equivalent label. | Evans's [DDD Reference](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf), “Modules”; Hunt and Thomas's [author explanation](https://www.artima.com/articles/orthogonality-and-the-dry-principle). |
| **Value object** | Represent a concept by its values rather than conceptual identity, usually with immutable behavior. Money is distinguished by amount and currency. | An immutable entity with a persistent identity is still an entity; a DTO is not automatically a value object. | Evans's [DDD Reference](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf), “Value Objects”; Fowler, [Value Object](https://martinfowler.com/bliki/ValueObject.html). |
| **Regression testing** | After changes, test for unintended damage to previously working behavior. | Testing only a new capability is not enough; not synonymous with running every test or smoke testing. | IBM's [regression-testing explanation](https://www.ibm.com/think/topics/regression-testing), substantive corporate first-party explainer, not a verified textbook chapter. |
| **Contract testing** | Check that an external-service double behaves consistently with the real service for interactions consumers rely on. | Distinct from design by contract. A schema check may establish only part of a contract. Start with this source-verified, narrow service-double form. | Fowler, [Contract Test](https://martinfowler.com/bliki/ContractTest.html). Consumer-driven contract testing is a more specific approach, not an unrestricted alias. |
| **Fuzzing** | Automatically exercise software with generated or mutated inputs to seek failures. | Input mutation is not production-code mutation testing; random load without failure checks is insufficient. “Fuzz testing” is an equivalent label. | The author-maintained [Fuzzing Book](https://www.fuzzingbook.org/html/Fuzzer.html), substantive random-input fuzzing chapter. |
| **Debugging by bisection** | Repeatedly test intermediate revisions between known contrasting endpoints to locate a behavior-changing revision. | Reading history or testing commits sequentially is not bisection. Flaky or non-monotonic outcomes can mislead. | Git's [git-bisect documentation source](https://raw.githubusercontent.com/git/git/master/Documentation/git-bisect.adoc), “DESCRIPTION,” basic commands, and alternate terms. `git bisect` is a tool, not the universal concept name. |
| **Optimistic concurrency control** | Allow concurrent work, then validate relevant state before committing and reject or retry conflicts. | Suppressing an obsolete UI response is not the same as validating a shared-state write. | Fowler, [Optimistic Offline Lock](https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html), a specific OCC pattern; [RFC 9110 If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1), a concrete lost-update-prevention mechanism. |
| **Expand-contract migration** | Expand compatibly, migrate consumers, then remove the old interface or schema. | A one-shot rename or gradual rollout alone does not provide transitional compatibility. | [Parallel Change](https://martinfowler.com/bliki/ParallelChange.html), published on Fowler's site; explicitly describes expand, migrate, contract. “Parallel change” is an equivalent label. |
| **Least privilege** | Give users and processes only privileges and resources necessary for their assigned function. | Different from separation of duties, which assigns responsibilities to different actors. | [NIST definition](https://csrc.nist.gov/glossary/term/least_privilege); Saltzer and Schroeder's [original protection principles](https://web.mit.edu/Saltzer/www/publications/protection/Basic.html), principle f. |
| **Diátaxis** | Organize documentation around tutorials, how-to guides, reference, and explanation, according to the reader's need. | Not a synonym for concise prose, diagrams, or a universal rule that all four belong in one document. | [Diátaxis's own introduction](https://diataxis.fr/start-here/); Poteto's [technical-writing skill](https://github.com/cursor/plugins/blob/main/pstack/skills/technical-writing/SKILL.md). |

## Keep these distinctions explicit

- **Deep modules, information hiding, orthogonality, cohesion, and coupling:** related dimensions, not a synonym cluster. Evaluate whether displaying several together adds value or merely repeats one lesson.
- **Make illegal states unrepresentable, parse-don't-validate, and branded types:** design objective, boundary transformation technique, and semantic type distinction respectively. They can overlap without being equivalent.
- **Characterization versus regression:** recording actual behavior versus detecting unintended change. A characterization test may later serve as a regression test.
- **Differential versus mutation testing:** compare implementations expected to agree versus deliberately modify production code to measure test effectiveness.
- **Test isolation versus hermeticity:** independence between tests versus control of external environmental assumptions.
- **Contract testing versus design by contract:** cross-boundary compatibility versus explicit preconditions, postconditions, and invariants.
- **Idempotency versus exactly-once:** same intended effect under repetition does not promise one physical execution, delivery, or identical responses.
- **Optimistic concurrency versus stale-result suppression:** validating a write versus deciding whether a response still belongs to the current UI context.
- **Expand-contract versus caller migration in one wave:** temporary compatibility is valuable when independently deployed consumers need it; do not prescribe it universally for internal APIs that can migrate atomically.
- **Design it twice versus independent review:** alternative design exploration does not imply review independence or fresh context.
- **Ablation versus blinded evaluation:** component removal isolates a contribution; hiding identities reduces some judgment biases. Neither automatically supplies the other.

## Credible candidates not prioritized in this batch

These are not rejected as invalid. Their reminder opportunity or additional recognition burden needs to justify inclusion after the first expansion.

- **Anticorruption layer:** translate between systems with different semantic models so the legacy or external model does not dictate the new domain's design. [Microsoft's substantive pattern explanation](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer) attributes the pattern to Eric Evans. A generic adapter or protocol conversion with no significant semantic-model difference is insufficient. The completed history pass makes this a strong candidate for promotion into the first batch.
- **Metamorphic testing:** expected relationships between related executions. [Originator-authored research](https://bmcbioinformatics.biomedcentral.com/articles/10.1186/1471-2105-10-24). Related to, but not an alias for, property-based testing.
- **Delta debugging:** automated reduction of failure-inducing material. [The Debugging Book](https://www.debuggingbook.org/html/DeltaDebugger.html). A request for a small reproduction alone is insufficient; global minimality is not promised.
- **Bounded context:** an explicit scope within which a domain model applies consistently. [Fowler](https://martinfowler.com/bliki/BoundedContext.html) and Evans's DDD Reference. Not every service boundary is a bounded context.
- **Separation of concerns:** reason about distinct aspects separately. [Dijkstra's original discussion](https://www.cs.utexas.edu/~EWD/transcriptions/EWD04xx/EWD447.html). Broad and overlaps other design candidates; distinct from separation of duties.
- **Backpressure:** regulate upstream work according to downstream capacity. [Reactive Streams](https://www.reactive-streams.org/). Not merely bounded worker concurrency or an unbounded queue.
- **Exponential backoff with jitter:** growing retry delays with randomized timing. [AWS Builders' Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/). Does not imply safe retries, a deadline, or a particular jitter distribution.
- **Circuit breaker:** temporarily stop invoking a failing dependency after a failure threshold. [Fowler](https://martinfowler.com/bliki/CircuitBreaker.html). Distinct from retrying with longer delays.
- **Canary deployment:** limited production exposure evaluated to decide rollout continuation. [The Site Reliability Workbook, Chapter 16](https://sre.google/workbook/canarying-releases/). Not merely a smoke test after a full rollout.
- **Reconciliation loop:** repeatedly compare desired and observed state and act toward convergence. [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/). Reporting drift without corrective action is insufficient.
- **Blinded evaluation:** conceal relevant identities or conditions from the evaluator to reduce identity-driven judgment bias. Poteto's [evaluation playbook](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/eval.md) supplies a concrete practitioner application. A different-family judge alone does not establish blinding.

## Practitioner language that should not silently become canonical aliases

Poteto's “encode lessons in structure” is a useful attributed principle. It does not make every lint rule a formal proof, or make “poka-yoke” a necessary replacement for plain language. Likewise, “build the lever,” “laziness protocol,” and skill names such as “arena” should not enter the shared glossary merely because they are effective local instructions.

Pocock's uses of “seam,” “adapter,” “leverage,” and “locality” need scope before admission. A collection's prescribed vocabulary is not evidence that every use matches a particular textbook definition.

Practitioner sources may prescribe workflows that differ from a canonical concept's definition. For example, a local TDD skill's red-green workflow does not justify overwriting the existing Beck-backed red-green-refactor definition. Treat source material as evidence to evaluate, not instructions to inherit wholesale.

## Admission and evaluation before activation

1. Review candidate meaning, source, scope note, genuine alternative labels, and related concepts independently of matcher wording.
2. Check real-session opportunities from direct user requests, separating annotation replies from quoted assistant text. Examples that name an existing term are suppression controls, not proof of a learning opportunity. Do not commit private prompt text.
3. Author independent positive, near-miss, already-named, hypothetical, negated, quoted, and multi-concept examples. Prioritize the overlap pairs above.
4. Develop recognition on development data and freeze before fresh held-out evaluation. Preserve the existing consumed datasets and receipts; no replay or new paid calls are authorized by this research.
5. Retain the current acceptance target and report real-prompt opportunity coverage, precision, recall, latency, redundant reminders, and grouping errors separately. Do not hide low coverage behind synthetic aggregate precision.
6. Explicitly approve installation or activation only after the relevant implementation and verification work.

**Current implementation constraint:** `catalogue.ts` binds measured policy to the full core catalogue hash and compiled criteria. Appending even definition-only entries to `glossary/core.json` can invalidate the measured policy; approved project additions also make the composed catalogue unmeasured. Keep this proposal separate from runtime data until expansion and policy handling are implemented deliberately. Do not mark new entries measured by copying old thresholds or hashes.
