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
| Format | `npm run format:check` | Unformatted indexed TypeScript, JSON or config |
| Lint | `npm run lint` | Any finding, including warnings |
| Types | `npm run typecheck` | Any TypeScript error |
| Rust | `npm run check:rust` | Gateway fmt, clippy, test or rustdoc failure |
| Tests | `npm run test:coverage` | A failing test, or coverage below 80% |
| Fallow | `npm run fallow` | Dead code, duplication or a function over the complexity limit, anywhere in the repo |
| Markdown | `npm run markdownlint` | Any Markdown lint finding |

### Repository file scope

Formatting, JavaScript/TypeScript lint and Markdown lint use `scripts/repository-quality.ts` to select existing regular files from the **Git index** (`git ls-files --cached -z`). This includes every tracked file of the relevant type, including dotfiles, agent skills/config and newly staged additions. They check the current working-copy content, not the staged blob. Unstaged edits are checked; files deleted from disk or staged for deletion are not. Indexed symlinks of these types fail with an actionable error rather than following a target outside the checkout.

**Stage new source/config/documentation files before checking them:**

```sh
git add -- path/to/new-file.ts
npm run format:check
npm run lint
npm run markdownlint
```

Untracked files are not part of these three checks, even if they are production additions. Review `git status --short` before opening a pull request so intended additions are staged. Untracked `.agents/tasks` evidence, `.direnv` caches, dependency directories and generated output therefore cannot contaminate these checks. There is no directory-wide exclusion for tracked agent files or production sources. A fresh clone and a linked Git worktree use the same index policy. These commands require Git and installed local tools (`npm ci`); query or tool failures stop the gate, not fall back to whole-tree discovery. An empty relevant file list succeeds without invoking a tool.

`npm run format` writes the same indexed formatter files; `npm run format:check` checks without writing. Pre-commit uses the same formatter, linter and Markdown commands as `npm run check`. The formatter selects its supported source/config extensions (Markdown remains governed by Markdown lint); the linter selects JavaScript/TypeScript and Vue, and Markdown lint selects `.md`. Git NUL-delimited paths and shell-free tool arguments preserve spaces, newlines and literal glob characters. When adding a new language supported by a pinned tool, update the selector and its fixture tests together.

`npm test` and `npm run test:coverage` first run the offline tooling fixtures (`npm run test:tooling`), then the existing Vitest suite. The tooling fixtures create temporary Git repositories and exercise real local tools; they do not call providers or change your checkout's index. Type checking, Rust, Vitest coverage and Fallow retain their own scope and thresholds; this index policy does not change them. Do not hide gate failures behind `tail` or `tee`: run commands directly, or use `set -o pipefail` when a pipeline is necessary and preserve its failure status.

The native adapter test needs the built gateway, which `npm run check:rust` builds. In a fresh clone, run it or `cd packages/pi-comms/gateway && cargo build --locked` before `npx vitest run`, or that test fails and names the missing binary.

Fix findings rather than silencing them:

- Suppress a lint rule only on the offending line, with a reason: `// oxlint-disable-next-line <rule> -- <reason>`.
- Do not add `fallow-ignore` comments, raise thresholds or exclude files.

While working on a branch, `npm run fallow:audit` lists only the Fallow findings your branch introduces.

## Why these gates

The numbers are project conventions. They keep review tractable; no source gives them as the right values.

**Coverage.** The 80% threshold on branches, lines and statements is a floor, not a target, and not evidence that the tests are good. Coverage shows which code no test runs. It does not show that a test would fail when the code is wrong. Google publishes a [60% acceptable, 75% commendable, 90% exemplary](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html) guideline and avoids broad top-down mandates. [Inozemtseva and Holmes (ICSE 2014)](https://www.cs.ubc.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf) found a low to moderate correlation between coverage and suite effectiveness once suite size is controlled for, and advise against using coverage as a quality target. Current coverage is about 96.5% of lines and 93.3% of branches. Judge a test by whether it fails when behaviour is broken: check it by mutating the code under test, and use [property tests](#property-tests) where inputs are open-ended.

**Complexity.** Fallow flags a function above cyclomatic complexity 20, cognitive complexity 15 or a CRAP score of 30, and above 60 lines. These are Fallow's defaults, and `.fallowrc.json` does not override them. They are looser than McCabe's original limit of 10. [NIST SP 500-235](http://www.mccabe.com/pdf/mccabe-nist235r.pdf) allows limits up to 15 when the project has operational advantages such as experienced staff. SonarSource's [cognitive complexity paper](https://www.sonarsource.com/docs/CognitiveComplexity.pdf) defines the metric and gives no threshold. The limits here are not claimed to be evidence-based.

## Property tests

Property tests use `@hegeldev/hegel`. Every property takes its settings from `propertySettings()` in `test-support/hegel-settings.ts`. The pull request gate replays seed 12345 with each property's own case count, so it is deterministic. A nightly workflow runs only the property tests with a random seed and 2,000 cases, to find inputs the fixed seed never reaches. It runs the TypeScript properties and the Rust gateway properties in `packages/pi-comms/gateway/tests` with the same seed and case count.

Both runs exist because a fixed seed makes the gate reproducible but explores the same inputs every time. Running other seeds locally during an evidence review found a genuine defect that seed 12345 never reached.

Two environment variables change every property, in both languages. The Rust ones read them in `packages/pi-comms/gateway/tests/support/mod.rs`, because the `hegeltest` crate ignores them for a property that pins its own seed. An invalid value fails the run:

| Variable | Effect |
| --- | --- |
| `HEGEL_SEED` | Replaces the seed. An integer from 0 to 2^64 - 1 |
| `HEGEL_TEST_CASES` | Replaces the case count |

Run the nightly set locally. It picks a random seed and prints it, with the case count, before the run:

```sh
npm run test:properties
npm run test:properties:rust
HEGEL_SEED=42 HEGEL_TEST_CASES=500 npm run test:properties
```

To reproduce a nightly failure, copy the seed and case count from the log and run the same command. The same seed and case count give the same inputs, so the shrunk counterexample is identical. Narrow it with a file path, for example `npm run test:properties -- packages/pi-vim`. A failing Rust property prints its seed and case count before the shrunk counterexample, so replay it with `npm run test:properties:rust` and those two values.

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
