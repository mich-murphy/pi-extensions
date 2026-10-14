# Claude error privacy and instrumentation verification

## Scope and acceptance

This change addresses the independently reproduced CLAUDE-002 (raw terminal SDK
error text) and CLAUDE-005 (ignored request/event instrumentation) findings.
It does not upgrade the SDK, rewrite live attestation, or claim subscription,
live usage, current remote aliases, or authenticated deferred-tool acceptance.

| Requirement | Implementation and proof |
| --- | --- |
| Never echo terminal `errors`/`result` prose | Parser discards both fields; errors use allowlisted structured categories. Large synthetic sentinels are absent from parsed failures, bridge error messages, diagnostics and actual Pi UI. |
| Keep useful bounded failures | Authentication, refusal, defer, subscription/context/turn/budget/output limits and request/overload/cancellation produce synthetic summaries. Unknown reason/stop/signal and invalid-tool-limit paths do not reflect arbitrary text. |
| Preserve recovery specificity | Explicit terminal categories outrank earlier generic API classifications; typed authentication still wins. Combined-field regressions assert real Pi `isContextOverflow()` recognition. |
| Inspect/replace request data | Awaited `onPayload` exposes only copied prompt blocks/images and cache breakpoint, validates replacements/in-place edits, then uses applied data for SDK streaming and cache diagnostics. |
| Preserve control-plane ownership | Replacement cannot alter model, environment, persistence, system bridge instructions, Pi tool allowlist, MCP gateway, permissions, hooks or AbortController. Invalid replacements fail before query startup. |
| Observe events before normalization | Awaited `onProviderStreamEvent` sees each SDK-yielded object, including ignored/malformed/terminal objects, in order. Consumption ends at the first terminal result. |
| Safe failure and cleanup | Callback rejection is value-free; cancellation/abandonment interrupts waits and observes late rejection; opened iterators close and owned SDK controllers abort. Captured calls never escape a failed turn. |
| Accurate response boundary | `onResponse` is explicitly unsupported: SDK exposes no actual HTTP status/headers. No synthetic response facts are manufactured. |

Raw provider-event hooks are privileged trusted-extension access, not a sanitized
logging feed. Their objects may contain private SDK data; automatic failure UI
and diagnostics are a different, bounded boundary. Arbitrary callback-owned work
cannot be forcibly stopped by this provider.

## Fresh verification

Environment: Darwin, Pi **1.1.0**, Node **26.11.1**, Python **3.14.7**.
New branch/worktree starts at main `84095b1`; unrelated local verification-suite
work is preserved in its original checkout and is not included in this PR.

- **Whole repository `npm run check`: passed**, including format, lint, typecheck,
  coverage, complete Fallow dead-code/duplication/health and Markdown lint.
  **53 files, 1014 tests passed, one existing platform skip**. Added **69**
  public-boundary cases; focused Claude scope is **18 files / 285 tests**.
  Coverage: 95.32% statements, 90.52% branches, 96.19% functions, 95.29% lines.
  No thresholds, exclusions, suppressions, gate configuration or dependencies changed.
- Shared isolated verification command `verify-pi-extensions/scripts/verify.py
  bundle`: **5/5 passed** (repository gate, 13 helper checks, all-six SDK skill
  parsing, root manifest loading/reload, combined zero-network work).
  Final evidence: `/tmp/pi-extensions-suite-evidence-cu01efqj/summary.json`.
  Prior identical successful run: `/tmp/pi-extensions-suite-evidence-o2lgurci`.
- Claude maintained `verify.py all`: actual five-model picker/select/cancel/no-match/
  reload and version-status match/newer/missing passed; its selected deterministic
  boundary suites report **11 files / 126 tests**. Evidence:
  `/tmp/claude-sdk-provider-evidence-71n4axvl`.
- Additional **parent-driven real Pi** proof uses the production runner and bridge
  with an explicitly injected in-memory SDK query, not live `query()` or fake Pi
  lifecycle events. Three actual typed user turns prove payload replacement,
  awaited unknown/text/terminal event handling, safe `errors` and `result` failure
  display with 100,000-character synthetic payloads, no invented HTTP callbacks,
  SDK controller abort on iterator close, and actual Pi settlement.
  Evidence: `/tmp/claude-sdk-provider-evidence-x3e8df18`; complete owned fixture and
  driver are retained there as `owned-proof.ts` and `independent-runner.py`.
- Independent source/security review found and required correction of generic
  API category precedence erasing explicit context-overflow recovery. The fix
  and combination regressions received explicit scoped approval after the reviewer
  reran the corrected public-boundary repros. Parent also reviewed implementation,
  validation, ownership, diagnostics, ordering and retained CLI evidence.

The shared/Claude verification helpers are pending separately maintained local
verification work, copied unchanged for this run only; they are not added by this
scoped fix PR. Committed regression tests and `npm run check` are reproducible
without those helpers:

```sh
npm ci
npm test -- packages/claude-sdk-provider/test
npm run check
```

## Failed attempts and boundaries

Two initial whole-repository attempts hit the unchanged web-tools deeply nested
HTML test's five-second timeout under host load. The unchanged main checkout
passed a fresh comparator gate; the final fix checkout passed the exact same
unmodified gate. No test timeout or exclusion was changed. Retained initial
failures: `/tmp/pi-extensions-suite-evidence-otnjz78z` and
`/tmp/pi-extensions-suite-evidence-ea07pz14`.

The parent proof's first fixture incorrectly wrapped Pi's replacement return in
`{ payload: ... }`; strict validation correctly refused it before query startup.
The fixture was corrected to return the payload directly. Its failed evidence
and successful cleanup remain at `/tmp/claude-sdk-provider-evidence-gnwa_jfj`;
this was not an extension defect. Earlier successful parent proof remains at
`/tmp/claude-sdk-provider-evidence-df4o787g`; the fresh final run above supersedes it.

Successful CLI results retain launch/environment/actions/screens/state, report
all owned-server/process/scratch cleanup checks true and no cleanup errors.
No personal profile, real credentials, Keychain access, real SDK query/usage/auth,
paid provider calls, physical power test or live alias attestation was performed.
Scratch HOME and `--offline` alone do not establish those safety boundaries;
allowlisted environment/PATH and avoiding all live entry points do.
