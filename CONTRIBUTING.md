# Contributing

## Set up

The [Nix](https://nixos.org/) flake provides Node.js, the pinned Rust toolchain and a C compiler. Enter it, then install dependencies:

```sh
nix develop        # or: direnv allow
npm ci
```

Some end-to-end tests also need Python 3.

To try your working copy of one extension in Pi:

```sh
pi -e ./packages/pi-vim/index.ts
```

## Check your change

Run the full gate before opening a pull request. CI runs the same command:

```sh
npm run check
```

It runs these steps in order and stops at the first failure:

| Step | Command | Fails on |
| --- | --- | --- |
| Format | `oxfmt --check` | Unformatted TypeScript, JSON or config |
| Lint | `oxlint` | Any finding, including warnings |
| Types | `npm run typecheck` | Any TypeScript error |
| Rust | `npm run check:rust` | Gateway fmt, clippy, test or rustdoc failure |
| Tests | `npm run test:coverage` | A failing test, or coverage below 80% |
| Fallow | `npm run fallow` | Dead code, duplication or a function over the complexity limit, anywhere in the repo |
| Markdown | `npm run markdownlint` | Any Markdown lint finding |

Fix findings rather than silencing them:

- Suppress a lint rule only on the offending line, with a reason: `// oxlint-disable-next-line <rule> -- <reason>`.
- Do not add `fallow-ignore` comments, raise thresholds or exclude files.

While working on a branch, `npm run fallow:audit` lists only the Fallow findings your branch introduces.

## Property tests

Property tests use `@hegeldev/hegel`. Every property takes its settings from `propertySettings()` in `test-support/hegel-settings.ts`. The pull request gate replays seed 12345 with each property's own case count, so it is deterministic. A nightly workflow runs only the property tests with a random seed and 2,000 cases, to find inputs the fixed seed never reaches.

Two environment variables change every property:

| Variable | Effect |
| --- | --- |
| `HEGEL_SEED` | Replaces the seed. An integer from 0 to 2^64 - 1 |
| `HEGEL_TEST_CASES` | Replaces the case count |

Run the nightly set locally. It picks a random seed and prints it, with the case count, before the run:

```sh
npm run test:properties
HEGEL_SEED=42 HEGEL_TEST_CASES=500 npm run test:properties
```

To reproduce a nightly failure, copy the seed and case count from the log and run the same command. The same seed and case count give the same inputs, so the shrunk counterexample is identical. Narrow it with a file path, for example `npm run test:properties -- packages/pi-vim`.

Turn every counterexample into a regression test with an explicit example before you fix the code. Hegel's failure database is off, so nothing else replays it. A failing property is either a defect in the code or a wrong property or generator. Fix the property when its oracle or generator allows a state that cannot occur.

Do not raise a timeout to fix a slow property. Make the property cheaper. A property that is inherently long wraps its timeout in `propertyTimeout()` so it grows with `HEGEL_TEST_CASES`.

## Verify behaviour in real Pi

Some packages have an agent skill that drives a real, isolated Pi session. Run the matching skill after changing that package's behaviour:

| Skill | Use after changing |
| --- | --- |
| [verify-pi-claude-sdk](.agents/skills/verify-pi-claude-sdk/SKILL.md) | The Claude provider or the pinned Agent SDK. Needs a Claude subscription |
| [verify-pi-auto-resume](.agents/skills/verify-pi-auto-resume/SKILL.md) | Resume or retry behaviour |
| [verify-pi-skill-toggle](.agents/skills/verify-pi-skill-toggle/SKILL.md) | The toggle menu, saved state, prompt filtering or the read guard |
| [verify-pi-web-tools](.agents/skills/verify-pi-web-tools/SKILL.md) | Login, logout or web-tools configuration |

## Dependencies

- Pin npm dependencies to exact versions.
- Put Pi's own packages (`@earendil-works/*`) in `peerDependencies` with a `*` range. Pi supplies them at runtime.
- Put other runtime packages in the owning package's `dependencies`.
- The Rust gateway uses Cargo version ranges with a committed `Cargo.lock`. Every Cargo command runs with `--locked`.

Renovate opens update pull requests on a schedule. Digest, pin and patch updates merge automatically. Two groups always wait for review:

- **Pi packages** (`@earendil-works/*`). A contract change type-checks against the pinned version and fails only in a live session.
- **The Claude Agent SDK.** Upgrading it needs a live check that CI cannot run. Follow the [SDK upgrade steps](packages/pi-claude-sdk/docs/sdk-upgrade.md).

## Pull requests

- Write commit messages as `type(scope): summary`, for example `fix(web-tools): handle empty results`.
- Keep each pull request to one change.
- Update the package README when you change what a user sees or configures.

## Writing documentation

- A package README is for people using the extension: what it does, install, usage, commands, configuration and limitations, in that order.
- Put design explanation in the package's `docs/` folder, and contributor steps in this file.
- Use tables for settings and commands. Write in the present tense, without release history, test counts or dates.
- Add a Mermaid diagram only when it explains something a paragraph cannot.
