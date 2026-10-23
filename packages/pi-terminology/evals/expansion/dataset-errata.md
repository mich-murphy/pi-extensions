# Held-out preflight defect and diagnostic-only follow-up

The original acceptance attempt **did not dispatch any held-out Jev calls**. Its
single-use verification receipt was burned, then the fixture validator rejected
a normalized duplicate in the private dataset. The shared ledger still contained
only the 120 successful development attempts. There was no acceptance report and
no policy promotion.

Two private records had identical text after Unicode normalization, whitespace
normalization and case folding. Unique record IDs and the author's earlier
exclusion checks did not establish unique normalized prompts. The independent
label review also did not detect this duplicate. The runtime evaluator's stricter
check correctly stopped the acceptance path.

All original author and consensus datasets, commitments, freeze records and the
failed verification receipt are retained unchanged. Private record IDs and text
are not published here. This is a dataset-preparation defect, not a classifier
transport failure or evidence that the expanded reminders passed acceptance.

## Separately recorded diagnostic

A diagnostic-only follow-up uses the **same frozen 51 cutoffs**, model, questions
and source bindings. It neither retrains nor retunes from held-out answers. It
shares the original durable ledger and 360-attempt/$1 conservative cap; no
historical ledger or receipt is reset.

Before any new classifier call, the diagnostic records its own single-use
receipt and validates that the failed verification dispatched no calls. It
collapses normalized duplicate held-out prompts deterministically. Label
disagreements within a collapsed group become ambiguous; named labels are the
union restricted to positive consensus labels. There is no selection based on
classifier results.

The planned diagnostic is 148 unique synthetic requests, **79 unique private
requests**, and the original 12 precommitted repeat probes: at most 239 calls,
bringing total experiment attempts to **359**, not exceeding 360. All classifier
calls still have zero retries. Errors retain reservations and stop collection.

The diagnostic can quantify recognition, apparent usefulness, latency and
stability, but **cannot write a measured policy or be presented as a clean
acceptance pass**. A future production approval requires a corrected,
prevalidated protocol and fresh verification evidence, not silently replaying
the consumed receipt or rebranding diagnostic answers as untouched data.
