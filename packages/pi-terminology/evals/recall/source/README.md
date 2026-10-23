# Inert recall-development source snapshots

These `.txt` files preserve the exact bytes of the 28 files bound by the native
pilot/calibration run. [The manifest](../source-manifest.json.txt) records their
original package-relative paths and hashes. They are not loaded by Pi, TypeScript
or the evaluator.

The historical tuner includes the overly strict per-concept precision requirement
identified in the [result](../results.md). Preserve that source rather than
pretending the native run used the later aggregate-objective diagnostic. New
offline tooling is separate; it cannot create a missing calibration completion
seal or advance this failed native experiment.

Original receipts, append-only ledger history, references and observations remain
unchanged. These snapshots and their public approval record are historical
evidence, not portable authorization to replay paid calls.
