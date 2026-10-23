# Root-package enablement verification

The user authorized enabling the extension in the PR. The root `package.json`
now lists `./packages/pi-terminology/index.ts` alongside the other six extensions.
This enables command/browser registration, **not paid preview calls**. Production
policy remains `measured: false`; preview remains off until session consent and a
finite allowance. TUI startup still performs local authentication preflight.

## Real Pi skill: passed

After rebasing the terminology-only branch onto current `main`, ran:

```sh
python3 .agents/skills/verify-pi-terminology/scripts/verify.py doctor
python3 .agents/skills/verify-pi-terminology/scripts/verify.py drive --feature all
```

Both journeys passed against pinned Pi 1.3.0. The commands journey additionally
launched the **whole root package** from a disposable, unrelated cwd: all seven
extensions loaded, `/terminology-status` and the 51-entry browser worked, the SDK
registry exposed exactly the eight terminology commands, and classifier/model
input/network guard counters remained zero. The driver uses real Vim keys to
clear completion text when the bundled Vim editor enters Normal mode.

The preview journey used the actual bundled candidate and passed the existing
normal/narrow confirmation, cancellation, allowance/exhaustion, restart/off,
mutation and unchanged primary-context checks. Its two fabricated classifier
answers and three offline inputs are UI proof only, not new native inference,
precision, acceptance or billing evidence. Real provider/fetch calls were zero.
Both disposable profiles were removed; no global settings or user-session preview
was changed.

Full retained evidence:

- Commands/root bundle: `/tmp/pi-terminology-evidence-tdjqzyfd`
- Actual preview: `/tmp/pi-preview-evidence-lxp6grel`

`result.json` binds the selected public summaries and captures here, including the
root manifest and source fingerprints. Public terminal copies omit empty rows at
EOF; full-height originals remain in the retained evidence. Original native
archives, receipts and the earlier preview publications remain unchanged.

A medium-effort independent subagent approved the runtime/command compatibility
scope at commit `3081895`, with Linux CI green and explicit preview consent as
merge conditions. No paid evaluation replay or acceptance collection is authorized
by this enablement.
