# Pi extensions

Personal extensions for the [Pi coding agent](https://pi.dev/), maintained as an npm workspace.

## Packages

- `claude-sdk-provider` routes Claude model turns through the official Claude Agent SDK.
- `no-sleep` keeps macOS awake while Pi is working.
- `pi-skill-toggle` toggles discovered skills and context files without removing them from disk.
- `pi-vim` adds Vim-style editing to Pi's prompt editor.

Pi loads all four extensions from the root package manifest. Install the repository with:

```sh
pi install git:github.com/mich-murphy/pi-extensions
```

For local development:

```sh
npm install
npm run check
pi -e ./packages/no-sleep/index.ts
```

Pi supplies its core packages to extensions at runtime. Keep those packages in `peerDependencies`; third-party runtime packages belong in the owning workspace's `dependencies`.

## Checks

- Vitest runs the behavioral tests, enforces at least 80% statement, branch, and line coverage, and writes V8 coverage in Istanbul format.
- TypeScript checks every workspace with strict compiler options and Node 22 types.
- Biome formats and lints TypeScript, JSON, and configuration files.
- Fallow audits changed code for dead code, duplication, complexity, and dependency problems.
- markdownlint-cli2 checks package documentation.

The Fallow audit uses `new-only` gating. Existing findings remain visible, but CI fails only when a change introduces a new error-level finding. Use `npm run fallow:review` for a non-blocking changed-code review and `npm run fallow:audit:all` when an explicit all-findings gate is wanted.
