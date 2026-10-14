# Native authentication verification

## Result

The final implementation passed the whole-repository gate and all three isolated real Pi 1.1.0 CLI journeys before PR creation. All checks were repeated after rebasing onto upstream `main` (`a59fe0e`) and reinstalling its updated dependencies with `npm ci`. An independent implementation review found no remaining concrete blocker after corrective changes.

No developer credentials were inspected, no extension was installed into the developer's live profile, and no paid/live provider calls were made. Native login uses synthetic keys; transport behavior is proved through real Pi authentication, actual tool execution, and existing injected HTTP/MCP boundaries.

## Commands and evidence

| Command | Result | Retained local evidence |
| --- | --- | --- |
| `npm run check` | Pass: 52 test files, 945 tests passed, 1 existing test skipped; formatting, lint, TypeScript, coverage, all three Fallow gates, and Markdown lint passed. | `/tmp/pi-web-tools-native-auth-check.log` |
| `.agents/skills/verify-pi-web-tools/scripts/verify.py startup` | Pass: empty profile, tools, model picker/catalog, reload. | `/tmp/pi-web-tools-evidence-y951nq1x/` |
| `.agents/skills/verify-pi-web-tools/scripts/verify.py invalid-config` | Pass: visible safe configuration failure, unavailable tools, native login remains registered. | `/tmp/pi-web-tools-evidence-niq5fqr7/` |
| `.agents/skills/verify-pi-web-tools/scripts/verify.py native-auth` | Pass: cancelled login, synthetic login for all three services, two reloads, logout, environment fallback, no dummy models. | `/tmp/pi-web-tools-evidence-4abn847h/` |

Whole-repository coverage: 95.26% statements, 90.37% branches, 96.08% functions, and 95.23% lines. No thresholds, exclusions, or suppression rules were changed.

Each CLI evidence directory contains action records, terminal captures, catalog metadata, safe synthetic credential-presence summaries, and `result.json`. All three final results report `status: passed`, `serverStopped: true`, `ownedProcessesStopped: true`, `scratchRemoved: true`, and no cleanup errors. Evidence remained after teardown. Paths are local proof artifacts, not dependencies; rerun the maintained [verification skill](../../../.agents/skills/verify-pi-web-tools/SKILL.md) to reproduce them in a fresh profile.

## Behavioral coverage

- Native authentication-only registration and login UI, with no contributed chat/image/classifier models.
- Environment-only credentials, stored precedence, literal rotation, login/logout transport changes, and surviving environment fallback.
- Native command success, empty/nonzero/timeout failure, and process-lifetime command caching.
- Authoritative absence versus failed/incompatible credentials, including an externally added unsupported OAuth entry with stale registry metadata.
- Pi-composed configured-key precedence and safe header-resolution failure after configuration refresh.
- Dynamic default Brave inclusion, explicit Brave prevalidation, ordered fallback, and per-call override isolation.
- Endpoint overrides never receive keys or invoke web-tools credential lookup; original official endpoint and redirect restrictions remain enforced.
- Keyed Exa contents rescue, intentional Parallel MCP rescue, and shared Parallel session/client state across credential changes.
- Concurrent old/new key snapshots with reversed completion, sibling cancellation, cancellation/shutdown during credential waits and provider I/O, and closed-session late-call rejection.
- Reflected credentials scrubbed from result text, details, updates, errors, spill files, image metadata, and actual captured telemetry. Telemetry success exits exclude raw payloads; failure/defect exits contain safe summaries.
- Early URL/domain-policy errors do not echo sensitive input or resolve unrelated credentials.
- Existing public-web SSRF, DNS binding, domain policy, redirect, timeout, and response-size regressions remain green.

## Corrections discovered during verification

Real CLI verification exposed Pi's retention of session-start provider registrations across reload; ownership-checked shutdown unregister fixes it without deleting credentials or unrelated replacements. Deterministic integration tests exposed missing Brave validation hidden by a healthy earlier provider. Independent review exposed stale-status authentication downgrade and direct/success-payload telemetry leaks; the absence marker and safe-span boundaries close those gaps.

## Remaining runtime limitations

Pi 1.1.0's native secret commands are synchronous with a nominal ten-second timeout, not a guaranteed hard wall-clock bound. Tool cancellation cannot interrupt that executor. Pi caches command successes and failures until restart, including across `/reload`; its independent availability checks can resolve commands even when web-tools does not need them. No second command runner or credential store was introduced.

Redaction covers credentials resolved for the execution, not unrelated unused credentials or user/model-supplied tool arguments Pi can display/store before resolution. Pi's auth store can serve its last valid snapshot after a storage-read failure. Strictly stronger guarantees require upstream runtime changes.

Provider-side acceptance of real keys, live quotas, and paid REST requests were deliberately not tested without separate approval. The real native UI and storage lifecycle are verified; external transport behavior is covered at the existing production injection boundaries.
