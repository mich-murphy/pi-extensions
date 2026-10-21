# Auto-resume feature map

Source of truth: `packages/pi-auto-resume/README.md`, `auto-resume.ts`, and the
public Pi extension lifecycle. Run `scripts/verify.py all` from this skill.

| Feature | Executed journey | Required evidence |
| --- | --- | --- |
| Default-on scheduling | `resume` receives a matching usage-limit event and failed assistant turn | Warning and waiting widget before reset |
| Wall-clock continuation | `resume`, real 60-second production interval | Second request timestamp after reset, rendered marker and canned reply |
| Context hygiene | `resume` request 2 | Original task present; failed-attempt sentinel and auto-resume marker absent |
| Commands on/off | `off`: off → on → limit → off | Notifications; wait removed; no request after the interval |
| New prompt cancels | `prompt` sends replacement text while waiting | Cancellation notification, replacement reply, exactly two requests |
| New extension work cancels | `extensionwork`, `extensionuser` use public send APIs via fixture slash commands | Replacement reply, no stale third request |
| Session replacement | `new` while waiting | New-session screen; no stale request or widget after interval |
| Runtime replacement | `reload` while waiting | Reloaded notification; no stale request or widget after interval |
| No limit event | `plain` success, `error` failed assistant | No widget or extra request after interval |
| Limit event without failure | `success` | No widget or extra request after interval |
| Missing/invalid/nonfinite reset | `missing`, `invalid`, `nan` | No widget or extra request after interval |
| Past or more than five hours | `past`, `far` | No widget or extra request after interval |
| Notice provider mismatch | `mismatch` | Unrelated provider notice does not schedule |
| Invalid JavaScript Date range | `date` | No extension exception, widget, or extra request |
| One-shot print | `print` | ISO reset report on stderr, failure exit, exactly one request, timely exit |
| One-shot JSON | `json` | Parseable JSONL, `entry_appended` custom reset entry matching fixture timestamp, exactly one request |
| Cleanup | Every run including assertion failures | Dedicated server stopped, owned pane PIDs and descendants exited, scratch removed |

## Deliberate exclusions

This fixture tests the consumer of `usage-limit`, not its upstream producer.
It does not establish that a real Claude SDK response emits the right event,
parses the right reset timestamp, or performs subscription authentication.
Those require separate provider tests or explicitly authorized live evidence.
No live evidence is implied by a passing result here.

The automated journeys do not cover actual machine suspend, clock discontinuity,
RPC behavior, exact maximum-delay boundaries, repeated rescheduling, every
malformed payload, tree/fork/resume switching, or busy-at-reset. Unit tests remain
appropriate for these combinatorial branches; real terminal verification should
supplement them rather than patching private timers to replace them.
