# Recognition repair candidate — development only

## Status and predeclaration

One whole 51-concept candidate is frozen in `recognition-core.json` for manual
review and a separately implemented development runner. No candidate inference,
authentication, provider setup or network call was performed in this preparation.
This is not a runtime policy, threshold freeze, acceptance result or activation.

The user authorized continuing the paid recognition iteration. The intended next
calibration uses the **same 612 already-consumed DEVELOPMENT requests**, not fresh
validation. Dispatch remains manual and belongs to the separate runner, using the
shared existing **$5 / 1,800 total-attempt ledger**, including prior consumption;
this candidate does not create an allowance or authorize resets or retries.
No acceptance sources, private history, private labels, review metadata or scenario
audits were opened. Existing sources, references, labels and bindings are untouched.

Use this complete profile for every request; do not select recognizers per case.
All 51 questions remain in the native-v2 payload. Only the following recognition
records change, each in exactly `matches`, `doesNotMatch` and `questionStyle`:

| Concept | Previous style | Candidate style |
| --- | --- | --- |
| `core:refactoring` | `with-criteria` | `instructions-focused` |
| `core:low-coupling` | `named` | `instructions-focused` |
| `core:separation-of-concerns` | `named` | `instructions-focused` |

All 51 concept records, definitions, labels, canonical aliases, references,
provenance, scope notes and relationships are identical to the baseline. All tips
and the other 48 recognition records are identical. No aliases are added.
No standalone source configuration, extraction logic or policy is changed.

## Review order and consumed evidence

First, without reading per-case probabilities, reviewed all positive/ambiguous
public calibration prompts for these three concepts and a lexical selection of
neighboring implementation/design prompts. Recorded the semantic boundaries before
joining observations. Then calculated aggregates and inspected development FP/FN
prompts with probabilities. This is a sequential score-blind first pass, not an
independent blinded reviewer: the task already supplied historical aggregates, and
a few additional error prompts were first inspected after scores were available.
No claim of fully score-blind authorship is made.

Programmatic checks found 612 references and 612 observations, with 51 labels per
request: 598 positive, 30,554 negative and 60 ambiguous assignments. One positive
is already named (`cal-extra-0002`, change-detector test), leaving the historical
597 unnamed opportunities. The retained displayed report is TP524/FP7/FN73 with
19 ambiguous hits, 98.68% scored precision and 87.77% recall.

The following are **uncapped, per-question baseline diagnostics**, before any new
candidate calls. They do not substitute for three-name widget evaluation:

| Concept | Cutoff | TP | FP | FN | Ambiguous hits |
| --- | ---: | ---: | ---: | ---: | ---: |
| Refactoring | 0.98 | 2 | 0 | 30 | 1 |
| Refactoring | 0.95 | 16 | 10 | 16 | 1 |
| Refactoring | 0.90 | 23 | 48 | 9 | 1 |
| Refactoring | 0.80 | 27 | 83 | 5 | 1 |
| Low coupling | 0.98 | 9 | 1 | 10 | 0 |
| Low coupling | 0.96 | 14 | 11 | 5 | 0 |
| Low coupling | 0.90 | 19 | 29 | 0 | 1 |
| Separation of concerns | 0.93 | 17 | 1 | 8 | 4 |
| Separation of concerns | 0.90 | 20 | 7 | 5 | 6 |
| Separation of concerns | 0.80 | 23 | 25 | 2 | 7 |

At 0.90, refactoring recovers only 2/10 explicit fail-first/implementation/cleanup
requests (`cal-0001`–`cal-0010`), versus 10/10 direct restructuring requests
(`cal-0015`–`cal-0024`) and 9/10 unused-code/configuration removals
(`cal-0099`–`cal-0108`). Eight of its nine misses are explicit mixed-task cleanup
steps; the ninth removes retired configuration (`cal-0104`). Its 48 false positives
include requests labelled accidental complexity (8), information hiding (6), low
coupling (17), functional core/imperative shell (3), separation of concerns (10),
DRY (5), orthogonality (3), high cohesion (4), and branded types (1); three have no
positive concept label. These overlap counts are not mutually exclusive.

Low coupling's 11 false positives at 0.96 concentrate on independent variation
and concern separation: eight carry orthogonality and eight carry separation of
concerns. Its five misses constrain consumer knowledge through hidden decisions
or representations (`cal-0157`, `0161`, `0162`, `0164`, `0166`). Separation of
concerns misses five pure-decision/outer-executor requests and three explicit
responsibility splits at 0.93; its one false positive there (`cal-0425`) narrows a
formatter's persistence dependencies. At 0.80 its 25 false positives spread across
information hiding, coupling, semantic translation, model scope and other nearby
practices. Immutability is a useful semantic guard, not a demonstrated dominant
error family in these reviewed scores.

## Boundary rationale

**Refactoring:** require an actual requested transformation of existing software
internals plus retained observable behavior, explicitly stated or clear in context.
Do not require the entire task to preserve behavior: after implementing a feature,
its now-working code can undergo an explicitly requested behavior-preserving step.
Merely implementing a feature, adding tests, introducing types, editing settings or
writing documentation does not establish that step. Removing unreachable/unused
software internals, including associated retired configuration, can qualify when
needed behavior is retained. Do not infer restructuring from a general design goal.

**Low coupling:** identify components and the actual dependency or knowledge being
limited, including prevention in new designs and consumer dependence on another
module's representation. Do not demand zero dependencies or a numerical import
reduction. Cohesion, immutable values, pure functions, compact interfaces and
independent settings do not establish the property by themselves. They may coexist
with genuine dependency limitation; neighboring practice names are not exclusions.

**Separation of concerns:** identify distinct responsibilities and their separate
handling/reasoning. Pure planning with effects in an outer executor qualifies, as
do independently variable responsibilities when they are distinct concerns.
Small helpers, grouping related operations, or hiding a detail alone do not establish
two separately understandable concerns. Neither a particular folder structure nor
complete independence is required. Actor approval separation remains different.

These are recognition boundaries, not revised canonical meanings. Some baseline
false positives are plausible semantic overlaps: for example internal complexity
removal and private-field renaming may be behavior-preserving restructuring, while
limiting dependencies may also separate concerns. Retain the gold labels and report
residual disagreement; do not categorically prohibit those overlaps to improve a
score. In particular, `cal-0531` is a plausible refactoring overlap despite its
negative label, and `cal-0069` remains ambiguous rather than being relabelled.
The candidate does not promise to eliminate all 48 scored refactoring false positives.

## Actual wire choice and next measurement

`classifier-request.ts` compiles `instructions-focused` into instructions containing
both the matching rule and `Non-matching boundary`, with generic true/false criteria.
This puts the necessary exclusions in the instruction instead of only negative
criteria and avoids relying on the broad named-practice prior for these three
questions. It is one predeclared formulation, not a per-concept style tournament.
The unchanged named questions keep `hasClassifierProfiles` true, so the shared
annotation extraction and both state keys remain unchanged. The transport still
adds current-real-work instructions and emits `type: "noul"` for all 51 questions.

Freeze this whole wording/style profile before any new calls. Do not adapt wording
partway through calibration. Re-measure all 51 questions together, including any
interactions, under the unchanged labels and suppression/display semantics. Report
aggregate scored displayed precision, micro/macro and per-concept recall,
per-concept precision, ambiguous hits/conservative precision and widget truncation
separately. The approved precision constraint is aggregate, not 90% per concept;
the existing recall floors still apply. Threshold selection on these 612 requests
is development fitting. No fresh performance claim follows, and acceptance remains
unopened pending a separate freeze/gate decision.

## Integrity and focused checks

SHA-256 hashes below bind exact file bytes, not new versions of old evidence:

| Artifact | SHA-256 |
| --- | --- |
| Baseline `recall/semantic-repair-core.json` | `934e6b6a8f0bb8dac0a74f27fae10da66042cde4d355cabe431947a29f01247a` |
| Candidate `repair/recognition-core.json` | `bdc30977310ec5861d5ba53f36f7c89d6a00bab026e0b598b7da56a5a7e63a65` |
| `recall/calibration-consensus.json.txt` | `a476109e901b90f9f1aa8904f09072ed173170884a521a3a494211d893ebb8f6` |
| `recall/calibration-observations.jsonl` | `b71bb5e0a8ccd216baeb216a70e739c86f73acf76479738f6cbad4a0494f8649` |
| `recall/calibration-report.json.txt` | `5cf2a4e75a63beb0b6d0abca86d5a54a0821386480a12cbd098a4d1934327f01` |
| `classifier-request.ts` | `bae99cd734c0709346bb83da5b92ba5f92a0618cc65c6082d9551d04143ec4d4` |

Existing production `parseGlossary`/`composeGlossaries` validation passed offline
for both profiles. JSON comparison verified exactly the three record/field diffs
listed above and all 51 concept records unchanged. Native wire comparison verified
exactly the same three changed questions; all 51 use `noul` and profile version 2.
Reverting just the three recognition blocks reproduces the baseline byte for byte.
The repository's `oxfmt --check` passed for the candidate JSON. Repository formatting
and Markdown commands exclude this notes file, so their skipped Markdown output is
not claimed as a notes lint pass.

| Semantic binding | Baseline | Candidate |
| --- | --- | --- |
| Catalogue hash | `7176929533415122100cf44ea33e51b12de23060e58d4f192c2771fd9f190cb6` | `467dab27351db24e2537d019818c1e0c9e84bc045795ba4e7ca7f4dc4db7c200` |
| Criteria hash (includes wire profile) | `e65a3ae7d95a148dcb6975958da09bb2cd03c6c1795412555ea89264d9c53cc6` | `89e754394587352999b44eb008d238309dfae7aa94c6399af423930526f07633` |

No candidate scores exist yet. No runtime activation or policy promotion is implied.
