# Round 2 semantic rubric

## Scope and provenance

These fixtures cover only the six supplied core meanings below. Agent C
independently authored 30 development and 40 new held-out prompts, using public
fictional software tasks. During original authoring, no private prompts, old
fixtures, classifier questions, candidate catalogues, classifier outputs, or
tuning observations were consulted. The required package README was read for
conventions, not used to construct labels.

Agent D separately reviewed the initial 70-record snapshot against the cited
primary sources without access to candidate questions or model results. No
semantic label corrections were needed, but four cross-split prompt-construction
pairs blocked fixture independence. Agent C rewrote four held-out requests, and
Agent D separately re-reviewed all 70 records and that exact revision. Those
construction blockers were resolved before a semantic fixture freeze.

Only after that independently authored and reviewed snapshot did Agent D compare
the held-out set with consumed legacy fixtures under separate authorization.
Canonical duplicates were absent, but two requests had near-template overlap.
Agent C then read only the authorized legacy excerpts in private reviewer
feedback and rewrote those two requests; the author did not open legacy fixture
files. Development bytes, all labels, and unaffected held-out requests remain
unchanged. Agent D has now separately re-reviewed all 70 current records and
the exact two-request revision, and compared the full held-out set with new
development and both consumed legacy splits. The two additional construction
blockers are resolved. Canonical duplicates and remaining near-template blockers
are zero. This fixture snapshot is frozen before inference. No authoring or
revision pass used classifier wording, model scores, or inference results.

Independent agent authoring and separate semantic review before inference are
not human review. A fixture freeze is not a policy freeze, completed inference,
or activation approval. The selecting parent remains blind to held-out content
until questions and threshold are frozen. Any subsequent fixture edit requires
reformatting, recomputing hashes and counts, and recording the reviewer and
disposition before final freeze. Canonical uniqueness alone does not establish
construction independence, and synthetic success would not guarantee
generalization to real prompts.

## Label rules

- Each record has exactly `id`, `prompt`, `applicable`, and `displayed`. Labels
  are concept IDs, not feature flags. `displayed` is a subset of `applicable`.
- Judge the current software task expressed by this prompt alone. Do not infer
  missing context for a follow-up, turn a historical quotation into current
  work, or rewrite the user's request to make a concept fit.
- `applicable` records the meaning requested, including concepts already named
  correctly. A bare, affirmative request to use a defined practice can establish
  applicability without restating its definition. Naming detection is separate
  from semantic applicability.
- `displayed` excludes a concept when the user affirmatively uses its accepted
  label or alias correctly for current work. Knowledge of one concept does not
  suppress a different applicable concept.
- Negation, rejected proposals, or historical quotations alone neither request a
  practice nor establish a correctly named current practice. A different present
  request must be judged on its own.
- Judge compound requests per concept. A benchmark, example test, or validation
  check alongside a genuine positive does not erase that positive. Conversely,
  one genuine positive does not make its neighboring practice positive.
- The ordinary cleanup phase in a requested test-first workflow does not by
  itself identify an additional concrete existing-code restructuring task. Also
  label refactoring when an explicit behavior-preserving structural change is
  requested. Do not require that structural change to involve domain vocabulary.
- Missing semantic prerequisites mean abstain for that concept, not invent
  prerequisites. This is not a confidence-threshold rubric.

Accepted naming forms are: test-driven development, TDD, red-green-refactor;
refactoring, refactor; design by contract, DBC; mutation testing; ubiquitous
language; property-based testing, property-based tests, property-based test. Do
not introduce additional aliases.

## Sourced boundaries

These boundaries use the primary meanings supplied in the assignment. The
independent reviewer fetched all seven linked primary pages and verified their
definitions, including Beck's first-edition preface on the linked product page.
No classifier wording or inference results informed this review.

| Concept ID | Positive meaning | Not sufficient | Primary source |
| --- | --- | --- | --- |
| `core:test-driven-development` | Build through an automated failing test first, make it pass, then complete the cleanup phase before further cases. | Tests written only after implementation, a regression test alone, or saying tests should exist without this workflow. | Kent Beck, *Test Driven Development: By Example*, first-edition preface, [InformIT](https://www.informit.com/store/test-driven-development-by-example-9780321146533). |
| `core:refactoring` | Change existing internal code structure to improve understandability or future modification while preserving observable behavior. An actual internal variable or function rename with updated references can qualify. | Documentation-only future conventions, changes only to test examples, historical restructuring with no current code task, or a behavior change with no separate preserving restructure. | Martin Fowler, [Definition of refactoring](https://martinfowler.com/bliki/DefinitionOfRefactoring.html) and [Rename variable](https://refactoring.com/catalog/renameVariable.html). |
| `core:design-by-contract` | Explicitly divide caller/routine responsibilities through preconditions, postconditions, and persistent state invariants. | Ordinary boundary validation or isolated assertions without a caller/callee obligation scheme. | *The Pragmatic Programmer*, second edition, Topic 23, [InformIT](https://www.informit.com/articles/article.aspx?p=2982114). |
| `core:mutation-testing` | Deliberately change production code and observe which introduced faults a test suite detects or lets survive, to assess the suite. | Product data mutation, changing test inputs, disabling test assertions, or ordinary production bug fixes. | Stryker, [Introduction and documentation](https://stryker-mutator.io/docs/). |
| `core:ubiquitous-language` | Developers and domain experts agree on precise domain-model vocabulary used across discussions, requirements, and code. New-model vocabulary work can qualify without changing existing implementation. | Technical abbreviation lists, variable prefixes, documentation-only style conventions, or developer-only naming without a shared domain meaning. | Martin Fowler, [Ubiquitous language](https://martinfowler.com/bliki/UbiquitousLanguage.html). |
| `core:property-based-testing` | Test a general correctness law over generated supported inputs. Failure can supply a counterexample; requesting the word “counterexample” or shrinking is not required. | Random performance workloads, a handful of handpicked examples, or production fault injection alone. | Hypothesis, [Introduction](https://hypothesis.readthedocs.io/en/latest/tutorial/introduction.html). |

## Development-only adjudication anchors

These examples refer exclusively to `development.json`. No held-out examples
belong in this rubric.

- `v2-dev-01`: the concrete extraction in existing formatter code supplies the
  refactoring label independently of the requested test-first loop.
- `v2-dev-07` versus `v2-dev-24`: a future style document changes no code; an
  existing internal variable rename preserving behavior is refactoring even
  without introducing new domain vocabulary.
- `v2-dev-08` versus `v2-dev-03`: two local checks are not a full responsibility
  scheme; caller obligations, return guarantees, and lifetime relationships are.
- `v2-dev-09` versus `v2-dev-06`: random timing inputs lack a correctness law;
  generated intervals tested against general rules have one.
- `v2-dev-10` versus `v2-dev-04`: intended record mutation is product behavior;
  deliberate implementation faults assessed against tests are mutation testing.
- `v2-dev-19` and `v2-dev-20`: a correctly named practice remains applicable but
  is not displayed; the other described practice is independently eligible.
- `v2-dev-25` and `v2-dev-28`: a quotation about past work is not a current
  request. The latter's separate present obligation scheme still qualifies.
- `v2-dev-27`: an unsupported follow-up supplies no meaning to label.
- `v2-dev-29` and `v2-dev-30`: shared domain vocabulary, preserving structural
  changes, generated-law checks, and test-first development can coexist when
  their respective prerequisites are present. An explicitly rejected practice
  stays negative.

## Freeze checks

Before author snapshot: format only the owned JSON files and lint this rubric.
Offline checks must verify exact fields, valid IDs and labels, label uniqueness,
displayed subsets, 30/40 split sizes, cross-split prompt uniqueness, byte
hashes, and at least four distinct eligible held-out prompts per concept.
Eligibility is presence in `displayed`, not merely in `applicable`; repetitions
do not add distinct prompts.

The predeclared round uses two repetitions and at most 200 total calls.
Acceptance requires displayed point precision of at least 95 percent and recall
of at least 50 percent for every one of the six concepts, with the distinct
eligible-positive support requirement met. These are synthetic-screen point
statistics, not population estimates or generalization guarantees. Agent semantic
review and synthetic-screen success must never be reported as human review,
representative private-prompt validation, or automatic-reminder activation
approval. Separate blinded legacy-overlap verification is complete for this
snapshot; the parent's full stage gates remain required before inference.
