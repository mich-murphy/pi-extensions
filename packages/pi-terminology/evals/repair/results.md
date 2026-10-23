# Recognition repair: interrupted development collection

**Stopped; no candidate preview artifact is available.** The operator's
300-second foreground terminal timeout killed the collection process after 416
successful calls, between completed attempts. This was an execution mistake, not
a recorded provider failure or an observed precision/recall failure.

## What completed

- Only refactoring, low coupling and separation of concerns recognizers changed.
  All 51 canonical concept records, definitions, aliases and references remain.
- Formatting, lint, TypeScript, coverage, Fallow and Markdown gates passed before
  dispatch: **101 files, 2,059 passed, two existing skips**. The final full suite
  used one worker; earlier concurrent runs had timeout failures and are not
  represented as passes. Coverage: statements 92.77%, branches 88.82%, lines 92.75%.
- Read-only review found no remaining critical/medium dispatch blocker.
- Real pinned Pi 1.3.0 passed an isolated **synthetic offline UI** journey at
  180×50 and 60×28: confirmation, finite allowance, first-three ordering,
  ephemeral cooldowns, exhaustion, unchanged primary input, off/restart and
  artifact mutation. It used three offline primary inputs and two intercepted
  fake classifier calls, **zero native inference/fetch calls**, and network
  denial. Evidence: `/tmp/pi-preview-evidence-lz2xuytf`. This proves neither
  candidate compatibility nor classifier quality.
- Source bytes were frozen before native collection. All 26 archived source
  hashes agree with the actual burned receipt.
- **416/612** planned development requests produced complete 51-probability
  native observations, durably settled as successes. There are no failed or
  unsettled reservations. They are exactly the first 416 requests in the fixed
  consumed-public development dataset, in unchanged order.

## What did not complete

The process was killed before a collection completion seal existed. Consequently:

- **196 development requests were never attempted.**
- No fitter was run and no precision/recall or feasibility result is claimed.
- No consumed replay, repeat, independent acceptance or private request was sent.
- No development completion, fit seal, frozen replay or preview artifact exists.
- Production policy remains **`measured: false`**. `/terms` browsing works;
  `/terms-preview on` fails closed because its candidate artifact is missing.
- No global installation/activation was performed.

The original process was confirmed absent. Its stale owned ledger lock was
archived privately and removed; the burned receipt, observations and ledger were
not reset, replaced or replayed. A private `repair/STOPPED.json` records the stop.
The original 1,012-record ledger prefix and prior stopped experiment remain
intact. Public evidence contains only invented/previously public development
records and metadata, not private acceptance requests or provenance.

## Budget

| Measure | This repair | Shared recall + repair |
| --- | ---: | ---: |
| Successful attempts | 416 | 1,428 |
| Conservative reservations | $1.145044992 | $3.930587136 |
| Published-tariff usage estimate | $0.212476152 | $0.721713888 |
| Input tokens | 5,058,956 | — |
| Output tokens | 458,848 | — |

Usage estimates are **not invoices**. Shared limits remain $5 and 1,800 attempts.
Reported latency includes the native matcher **and durable success settlement**,
not pre-attempt source validation: median 381 ms, maximum 8,584 ms. Therefore
that maximum is not presented as an inference-only five-second deadline result.

## Continuation requires approval

No continuation is implemented or authorized. Do not invoke the consumed
`develop` phase again or alter its receipt to make it pass.

A separately approved recovery could collect **only the 196 never-attempted
requests**, preserving all 416 successes, fixed source/profile/questions/data
and order. It would need a separate append-only receipt and an honest combined
collection proof, not a retroactive completion of this failed phase. The
previously planned 174 consumed replay/repeat calls could follow only if a
complete development fit passes. That would still total **1,798 attempts** and
**$4.949016576** in reservations, without increasing the existing cap. The
original receipt and interruption would remain historical evidence.

Future authorized long-running collections should use an owned persistent
process with durable PID/status monitoring rather than a short foreground
terminal timeout. No current process is running and no automatic retry or resume
is scheduled.

See `result.json` for exact accounting and artifact hashes.
