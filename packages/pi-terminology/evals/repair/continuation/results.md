# Recognition repair continuation: development gates pass

**196/196 newly authorized native calls succeeded**, with no failures, missing
observations, retries or unsettled reservations. The combined 416-preserved plus
196-new development matrix is complete and its fitted candidate meets the
approved numerical development gates. This is **not independent acceptance**,
production readiness, or authorization to activate reminders.

## Collection and preservation

- The user approved only the 196 never-attempted requests. They were collected in
  unchanged dataset order, from `cal-0489` through `cal-extra-0006`, under new
  `repair/develop-continue/<id>/0` attempt IDs. All 51 questions were asked in every
  native call with the original `jev-1.13.0` wire pin, threshold zero, five-second
  deadline and zero automatic retries. Serving identity is not independently attested.
- The original 1,428 ledger objects, 416 observation lines, burned receipt,
  manifest, authorizations, `STOPPED.json` and 26 frozen source bindings were
  preserved. The original interrupted phase remains interrupted; its missing
  completion was not manufactured. The separate 359-attempt experiment is untouched.
- Four new continuation source/authorization files were separately bound and
  archived before registry construction. A new combined completion seals both
  source generations and the full ordered matrix **before fitting**.
- An owned supervisor (PID 16266) monitored child PID 16267 without a foreground
  timeout. The child exited 0 after approximately **78.43 seconds**. Durable PID,
  progress, observation and exit records were retained, and the ledger lock was
  released. No process or automatic resume remains running.
- No consumed replay, repeat, fresh acceptance or private request was dispatched.
  No preview policy, measured policy, installation or activation was produced.

## Combined consumed-development fit

The unchanged bounded aggregate optimizer scores the actual first three visible
names. All 51 concepts remain enabled, with unchanged reference labels and
canonical meanings. Labels are agent-reviewed judgements, not human ground truth.

| Measure | Result | Development gate |
| --- | ---: | ---: |
| TP / FP / FN | 575 / 60 / 22 | — |
| Scored displayed precision | **90.55%** | At least 90% |
| Displayed micro recall | **96.31%** | At least 85% |
| Lowest concept recall | **71.43%** (fuzzing) | At least 70% for every concept |
| Macro recall | 97.64% | Reported separately |
| Ambiguous displayed hits | 18 | Reported separately |
| Conservative precision | **88.06%** | Not the approved scored-precision gate |
| Redundant named reminders / over-suppressed positives | 0 / 0 | Reported separately |

All positive-support checks pass. The optimizer is a bounded heuristic, not a
proof of globally optimal thresholds. Thresholds were fitted to these same
consumed development observations; this does not establish future precision,
recall, private-request usefulness, stability or natural-base-rate performance.

### Important per-concept trade-offs

Aggregate success does **not** mean every recognizer is accurate enough on its own.
The three repaired concepts have the following displayed results:

| Concept | Cutoff | TP / FP / FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: |
| Refactoring | 0.80 | 24 / 28 / 8 | **46.15%** | 75.00% |
| Low coupling | 0.84 | 19 / 11 / 0 | **63.33%** | 100.00% |
| Separation of concerns | 0.86 | 25 / 3 / 0 | 89.29% | 100.00% |

The approved objective requires aggregate 90% scored precision, not 90% precision
per concept. These numbers therefore do not invalidate the declared development
pass, but they are substantial practical weaknesses—especially refactoring, whose
false reminders outnumber its correct reminders here. Do not describe the recognizers
as fully dialled in, silently suppress these categories, or claim that the 90.55%
aggregate score makes them individually reliable. Eighteen ambiguous hits also
mean conservative precision remains below 90%.

No causal attribution is claimed from comparing this fitted candidate with the
older calibration report: both recognition wording and the optimization objective
differ. The result is sufficient to identify a development candidate, not to
promote it or choose further wording against untouched acceptance answers.

## Spend, reservations and latency

| Measure | This continuation | Shared recall + repair |
| --- | ---: | ---: |
| Successful attempts | 196 | 1,624 |
| Conservative reservations | $0.539492352 | $4.470079488 |
| Published-tariff usage estimate | $0.100139088 | $0.821852976 |
| Input / output tokens | 2,384,264 / 216,188 | — |

Usage estimates are **not invoices**. Shared limits remain $5 / 1,800 attempts.
The later planned 174 consumed replay/repeat calls remain **not authorized and
not executed**, even though development now passes and they would fit the old
maximum of 1,798 attempts. Unused allowance is not another authorization.

New-call median recorded latency was **297 ms**, maximum **673 ms**. These timings
include the matcher plus durable successful settlement, and exclude pre-attempt
source validation. They are not an independent inference-only latency measurement.

## Evidence and next decision

[Machine-readable result](result.json) hashes the public-safe native artifacts.
The byte-preserved [report](report.json.txt), [combined completion](combined-completion.json.txt),
[receipt](receipt.json.txt), [source manifest](source-manifest.json.txt),
[observations](observations.jsonl), [ledger snapshot](development-ledger.json.txt)
and [fit seal](fit-seal.json.txt) reproduce the result. JSON-text snapshots retain
native bytes without formatter rewrites. Original evidence remains in the parent
repair directory, unchanged.

The offline continuation tests passed before dispatch, including mutation,
receipt, archive, isolation, missing-credential, single-failure, cumulative-budget
and full injected lifecycle cases. Pre-dispatch full coverage passed **2,103 tests
with two existing skips across 104 files**, plus formatting, lint, TypeScript,
Fallow and Markdown, without weakening gates. Public evidence tests independently
reconstruct the complete native matrix, shared ledger and fitted result without
credentials or providers. Final verification is recorded in the continuation README.

Paid work is stopped. The subsequent zero-call publisher has now prepared a
clearly marked, finite-allowance **manual experimental preview**, with explicit
user opt-in and these per-concept limitations visible. See
[preview readiness and offline TUI proof](../preview/README.md). It is off by
default and not production activation; the native result and its original
`previewArtifactAvailable: false` field are preserved unchanged. Any replay or
fresh validation needs separately recorded scope/authorization; no acceptance
data should be opened to tune this candidate.
