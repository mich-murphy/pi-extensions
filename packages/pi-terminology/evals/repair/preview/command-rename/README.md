# Command rename: scope and source compatibility

The eight-command family was renamed from `/terms*` to `/terminology*`
(`/terminology`, `-status`, `-hide`, `-restore`, `-dismiss`, `-auth-refresh`,
`-approve`, `-preview`). There are no legacy aliases.

## Scope

- Only user-facing command names changed. Native evidence, model, catalogue,
  criteria, thresholds and allowances are unchanged, as are the other 28
  native-bound files.
- The evidence under `evals/repair/continuation` and the original native
  JSON/archives remain immutable.

## Source compatibility

Current `index.ts` and `ui.ts` are an exact UI command-name-only transform of the
original archived sources. `scripts/command-rename-compatibility.ts` verifies this
byte for byte before the zero-call publication binds the current hashes.

The original contract/diagnostic intentionally still reports two source drifts and
refuses paid continuation with the current code. Historical tests run the real,
unmodified runner with two filesystem reads redirected to the hash-verified
native archives. The filesystem seam is restored after each test; a final test
proves the current runtime remains blocked before provider setup or receipt writes.
No module mock, alternate runner, guard relaxation or dependency change is used.

## Preview policy

The new preview policy was published with zero calls at SHA
`6a5e4890a6fd5eaf37ca686f8b533ff1685bb1b405067042837fc2dd9aa000ca`. The previous
policy is retained as `previous-preview-policy.json.txt`; the earlier publication
and UI evidence stay historical. `publication.json` records the new artifact,
publisher and compatibility-rule hashes, the two changed source hashes and
selected public-safe verification evidence.

## Verification skill: passed

Ran the new `verify-pi-terminology` skill after reading its instructions:

```sh
python3 .agents/skills/verify-pi-terminology/scripts/verify.py doctor
python3 .agents/skills/verify-pi-terminology/scripts/verify.py drive --feature all
```

Both journeys passed in the real, checkout-pinned Pi 1.3.0 TUI:

- The public SDK registry contains exactly the eight `/terminology*` commands and
  no legacy aliases. Real completion also exposes the renamed controls.
- Browser/navigation, all 41 added concepts at normal/narrow sizes, source
  scrolling, hide/restore persistence and corrupt-state preservation passed.
- The actual bundled preview passed confirmation/cancel, invalid allowances,
  allowance exhaustion, off/restart, deliberate mutation and unchanged primary
  prompts/context. Both weak-concept warnings remain visible at 60×28.
- Throwing network/model guards were installed before the terminology extension;
  preview additionally used OS network denial, fake credentials and an offline
  primary recorder. Zero real provider/fetch calls occurred. Two fabricated
  classifier answers and three synthetic inputs are UI proof only, not new native
  recognition or acceptance evidence. Scratch profiles were removed.

Full retained evidence: `/tmp/pi-terminology-evidence-p1wqe3ts` (commands) and
`/tmp/pi-preview-evidence-q7a77puu` (preview). Selected results, counters, command
catalogues and confirmation captures are copied here and hash-bound in the
publication manifest. The public command-discovery capture omits empty terminal
rows at EOF; its original full-height capture remains in the retained evidence. The preview remains off by default; this verification did
not activate anything in the user's profile.

Final serialized offline coverage passes **2,131 tests** across 107 files, with
two existing skips (92.73% statements, 88.70% branches, 92.69% lines). Lint,
TypeScript and Fallow also pass without weakened gates. Retained final logs:
`/tmp/pi-terminology-command-rename-final-check.log` and
`/tmp/pi-terminology-command-rename-final-fallow.log`.
