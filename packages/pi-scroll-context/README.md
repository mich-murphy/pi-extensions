# pi-scroll-context

A single muted, full-width `❯ prompt…` row above Pi's fullscreen transcript while
browsing history. It shows the nearest preceding user prompt, not the newest
prompt, and is suppressed while that prompt's original text is still visible.
Returning to the live end reclaims the row, including during long streamed output.

Load for one invocation without changing your profile:

```sh
pi -e ./packages/pi-scroll-context/index.ts
```

There are no settings, commands, shortcuts, timestamps, navigation buttons, or
model-context changes. Regular, print, JSON, and RPC modes have no sticky row.
The active theme supplies `muted` text and `userMessageBg` across the entire row.

## Compatibility and implementation

Verified against Pi 1.3.0 and 1.4.0 with isolated native CLI and tmux terminal
journeys. Automated tests use the repository's exact pinned Pi dependency.

Pi has no public fixed transcript-header slot. `host.ts` isolates these contracts:

- The factory's stable forwarding TUI reference exposes the private `layoutRoot`.
- The native root is a two-entry VStack: primary ScrollView, then the input dock.
- `Symbol.for("@earendil-works/pi-tui/layout-node")` supplies its layout description.
- Native user messages prefix rendered rows with OSC 133 prompt boundaries and
  retain their original prompt in a private `text` field. Boundaries determine
  geometry; the optional text read avoids inserting spaces into soft-wrapped words.

The adapter recognizes the native root's exact allocation shape. It measures
native document/dock render caches before inserting zero or one row; it never
probes by mutating scroll state. Native ScrollView remains responsible for scroll
anchors, following the end, selection, search, and input routing. No renderer,
terminal writes, keybindings, session entries, or provider requests are intercepted.
The invisible discovery widget consumes zero rows. The patched root survives
regular/fullscreen renderer replacement; shutdown/reload restores its original
method only if another extension has not replaced it in the meantime.

Unknown layout shapes are left untouched. These private contracts can change in
future Pi releases, so this is not a guarantee of compatibility with arbitrary
hosts or other extensions that replace the fullscreen root. Native render-cache
measurement is repeated as output, tools, width, and session branches change.
Width changes retain Pi's native numeric scroll-offset behavior; the header follows
the turn actually visible after reflow rather than overriding Pi's scroll anchoring.

## Verification

Run the extension tests and the repository quality gates:

```sh
npx vitest run packages/pi-scroll-context/test
CI=true npm run check
```

The native journey needs `tmux`. It replays a synthetic session in an isolated
profile without submitting model prompts. Plain and ANSI terminal captures, the
terminal write log, actions, and results remain in the printed temporary directory.
The CLI load smoke test still runs when tmux is unavailable; only the native
terminal journey is skipped in that environment.

Run it directly, optionally choosing another installed Pi package directory:

```sh
node packages/pi-scroll-context/test/fixtures/native-journey.ts
node packages/pi-scroll-context/test/fixtures/native-journey.ts /path/to/pi-coding-agent
```

Native checks cover live-bottom baseline parity, keyboard and mouse-wheel history
scrolling, historical prompt ownership, duplicate suppression, themed colors,
editor focus, row reclamation, Unicode/narrow reflow, reload, and mode switches.
Deterministic native-layout tests additionally cover streamed content changes,
first-frame resize settlement, branch/compaction document rebuilds, partial and
identical prompts, incompatible hosts, and disposal beneath another extension's
wrapper. These layout checks do not require a live model response.

Reference: [BlockLune/pi-sticky-header](https://github.com/BlockLune/pi-sticky-header)
informed the private-host compatibility research. This implementation is original;
it does not copy that extension's source or its follow-end header behavior.
