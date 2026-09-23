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

## Dependency updates

Renovate runs from `.github/workflows/renovate.yaml` on a schedule and on demand, scoped to this repository by `.github/renovate-config.json`, and needs a `RENOVATE_TOKEN` repository secret. `renovate.json` holds the update policy: digests, pins and patches automerge, and everything else waits for review.

Two dependencies never automerge, whatever the update type. Pi's own `@earendil-works/*` packages define the provider and extension contracts and are resolved from the running Pi at runtime, so a contract change type-checks clean against the pinned version and only fails in a live session; they are raised as one grouped PR. `@anthropic-ai/claude-agent-sdk` is gated on the live attestation in `sdk-release-contract.json`, which CI cannot produce, so its PR carries the upgrade procedure.

Keep dependency ranges exact. A `latest` range is never out of date, so Renovate cannot raise a PR for it and the installed version drifts silently on every install.

The Fallow audit uses `new-only` gating. Existing findings remain visible, but CI fails only when a change introduces a new error-level finding. Use `npm run fallow:review` for a non-blocking changed-code review and `npm run fallow:audit:all` when an explicit all-findings gate is wanted.
